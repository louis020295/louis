import {
  buildDemoHistoricalVolumeMap,
  ExchangeAdapter,
} from '../adapters/ExchangeAdapter.ts';
import { TelegramNotificationAdapter } from '../adapters/NotificationAdapter.ts';
import { RadarDatabase } from '../db/RadarDatabase.ts';
import { runMarketScan } from '../engine/MarketScanner.ts';
import { evaluateSmcStructure } from '../engine/SmcRuleEngine.ts';
import {
  BackgroundScanRunRecord,
  BackgroundSchedulerSmcCoverage,
  BackgroundSchedulerStatus,
  ExchangeId,
  MarketTicker,
  ScannedCandidate,
  SmcAnalysisResult,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';
import type { SmcBatchScanService } from './SmcBatchScanService.ts';

/**
 * Per-symbol SMC deep evaluation cost on Binance USD-M public REST:
 * 4 kline calls (5m / 15m / 1h / 4h, weight typically 1 at limit<=100)
 * + 1 openInterest (weight 1) ≈ 5 request-weight units.
 * Snapshot (exchangeInfo / tickers / premium / book) is paid once per tick
 * on top of this and is not included in estimatedRequestsPerCycle.
 *
 * SmcBatchScanService already enforces maxRequestsPerMinute = 1200 and
 * maxHttpConcurrency = 8 (eval concurrency 2). A 522-symbol universe is
 * ~2610 weight ≈ 2.2 minutes theoretical, ~3.5–4 minutes observed.
 * The default 5-minute scheduler interval can finish one full cycle if we
 * never start a second overlapping cycle while the worker is RUNNING
 * (rate-limited rotation / continuation).
 */
export const SCHEDULER_SMC_REQUESTS_PER_SYMBOL = 5;
export const SCHEDULER_MAX_REQUESTS_PER_MINUTE = 1200;
export const SCHEDULER_INLINE_CONCURRENCY = 2;

/**
 * Parse SCHEDULER_SMC_TOP_N.
 * Empty / "all" / "0" / invalid → ALL eligible symbols (the radar universe).
 * A positive integer caps the set (radar long/short first, then by score).
 */
export function parseSchedulerSmcTopN(
  raw?: string | null
): number | 'ALL' {
  const v = (raw ?? process.env.SCHEDULER_SMC_TOP_N ?? '').trim();
  if (v === '' || v.toLowerCase() === 'all' || v === '0') return 'ALL';
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 'ALL';
}

export function selectSchedulerSmcUniverse(
  candidates: ScannedCandidate[],
  topN: number | 'ALL'
): ScannedCandidate[] {
  const ranked = [...candidates].sort((a, b) => {
    const rank = (c: ScannedCandidate) =>
      c.marketRadarCategory === '雷達多頭觀察' ||
      c.marketRadarCategory === '雷達空頭觀察'
        ? 0
        : 1;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.score - a.score || a.symbol.localeCompare(b.symbol);
  });
  if (topN === 'ALL') return ranked;
  return ranked.slice(0, topN);
}

export function buildSchedulerSmcCoverage(params: {
  topN: number | 'ALL';
  selectedSymbolCount: number;
  evaluatedInLatestMap: number;
  batchWorkerState: string | null;
}): BackgroundSchedulerSmcCoverage {
  const estimatedRequestsPerCycle =
    params.selectedSymbolCount * SCHEDULER_SMC_REQUESTS_PER_SYMBOL;
  const estimatedMinCycleMinutes = Number(
    (estimatedRequestsPerCycle / SCHEDULER_MAX_REQUESTS_PER_MINUTE).toFixed(2)
  );
  return {
    ...params,
    estimatedRequestsPerCycle,
    estimatedMinCycleMinutes,
    rateLimitNoteZh: `每檔約 ${SCHEDULER_SMC_REQUESTS_PER_SYMBOL} 權重（4 檔 K 線 + OI）。全市場 ${params.selectedSymbolCount} 檔約 ${estimatedRequestsPerCycle} 權重，在 ${SCHEDULER_MAX_REQUESTS_PER_MINUTE} 次/分鐘上限下理論最短 ${estimatedMinCycleMinutes} 分鐘；實際約 3.5–4 分鐘（concurrency 2）。進行中的週期不會重疊啟動，採輪轉續跑。`,
  };
}

export class BackgroundScannerScheduler {
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly db: RadarDatabase;
  private readonly telegramDryRunAdapter: TelegramNotificationAdapter;
  private readonly smcBatchScanner: SmcBatchScanService | null;
  private readonly smcTopN: number | 'ALL';
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private lastRunAt: string | null = null;
  private lastCoverage: BackgroundSchedulerSmcCoverage | null = null;

  constructor(params: {
    adapters: Record<ExchangeId, ExchangeAdapter>;
    db: RadarDatabase;
    telegramDryRunAdapter: TelegramNotificationAdapter;
    intervalMs?: number;
    smcBatchScanner?: SmcBatchScanService | null;
    smcTopN?: number | 'ALL';
  }) {
    this.adapters = params.adapters;
    this.db = params.db;
    this.telegramDryRunAdapter = params.telegramDryRunAdapter;
    this.intervalMs = params.intervalMs ?? 300_000; // default 5 minutes
    this.smcBatchScanner = params.smcBatchScanner ?? null;
    this.smcTopN = params.smcTopN ?? parseSchedulerSmcTopN();
  }

  public start(
    exchange: ExchangeId = 'binance_usdm',
    mode: 'live' | 'demo' = 'live',
    customIntervalMs?: number
  ): BackgroundSchedulerStatus {
    if (customIntervalMs && customIntervalMs >= 5_000) {
      this.intervalMs = customIntervalMs;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.runOnce(exchange, mode);
      }, this.intervalMs);
    }
    return this.getStatus();
  }

  public stop(): BackgroundSchedulerStatus {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getStatus();
  }

  public async runOnce(
    exchange: ExchangeId = 'binance_usdm',
    mode: 'live' | 'demo' = 'live'
  ): Promise<BackgroundScanRunRecord> {
    const startMs = Date.now();
    const runAt = new Date().toISOString();
    const targetExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    const adapter = this.adapters[targetExchange] ?? this.adapters.binance_usdm;

    try {
      const snapshot = await adapter.fetchMarketSnapshot();
      const volumeSamplesRecorded = this.db.recordTickerVolumeSnapshot(
        targetExchange,
        snapshot.tickers
      );

      const histMap =
        targetExchange === 'demo_synthetic'
          ? buildDemoHistoricalVolumeMap()
          : this.db.getBulkHistoricalVolumeMap(targetExchange, 40, '15m');

      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        mode,
        exchange: targetExchange,
        historicalVolumeMap: histMap,
        volumeTimeframe: '15m',
      });

      const selected = selectSchedulerSmcUniverse(
        preScan.candidates,
        this.smcTopN
      );
      const smcMap = await this.evaluateSelectedUniverse({
        targetExchange,
        mode,
        snapshotTickers: snapshot.tickers,
        preScanCandidates: preScan.candidates,
        selected,
      });

      this.lastCoverage = buildSchedulerSmcCoverage({
        topN: this.smcTopN,
        selectedSymbolCount: selected.length,
        evaluatedInLatestMap: smcMap.size,
        batchWorkerState: this.smcBatchScanner
          ? this.smcBatchScanner.getWorkerState(targetExchange)
          : 'INLINE',
      });

      const scanResult = runMarketScan(snapshot.tickers, snapshot.provenance, {
        mode,
        exchange: targetExchange,
        historicalVolumeMap: histMap,
        smcMap,
        volumeTimeframe: '15m',
      });

      // Mark open paper trading ledger positions to market (PAPER ONLY)
      const priceMap = new Map<string, number>();
      for (const t of snapshot.tickers) {
        priceMap.set(t.symbol, t.lastPrice);
      }
      this.db.updateOpenPaperEntriesWithPrices(targetExchange, priceMap);

      // Dispatch ONLY genuine SMC-confirmed trade candidates to Dry-Run Notification Queue (NEVER sends live external messages or orders)
      const alertCandidates = scanResult.candidates
        .filter(
          (c) =>
            c.smcEvaluationStatus === 'EVALUATED' &&
            !c.provenance.stale &&
            !c.provenance.fallback &&
            (!c.gates.smc.waitReasons ||
              c.gates.smc.waitReasons.length === 0) &&
            ((c.finalTradeSignal === '多頭交易候選' &&
              c.smcActionState === 'LONG CANDIDATE') ||
              (c.finalTradeSignal === '空頭交易候選' &&
                c.smcActionState === 'SHORT CANDIDATE'))
        )
        .slice(0, 2);

      let dryRunCount = 0;
      for (const c of alertCandidates) {
        const rec = await this.telegramDryRunAdapter.dispatchPreview({
          symbol: c.symbol,
          category: c.finalCategory,
          actionState: c.smcActionState,
          finalTradeSignal: c.finalTradeSignal,
          smcEvaluationStatus: c.smcEvaluationStatus,
          stale: c.provenance.stale,
          fallback: c.provenance.fallback,
          waitReasons: c.gates.smc.waitReasons ?? [],
          score: c.score,
          confirmedEvidences: c.evidences
            .filter((e) => e.passed)
            .map((e) => `${e.label}: ${e.value}`),
          missingData: c.provenance.missingData,
          riskWarnings: [
            '[BACKGROUND_DRY_RUN_SCHEDULE] 僅供預覽，未對外發送',
          ],
          source: c.provenance.source,
          fetchedAt: c.provenance.fetchedAt,
          safetyBanner: `${TRADING_SAFETY_FLAGS.mode} / ${TRADING_SAFETY_FLAGS.liveOrders}`,
        });
        if (rec.status === 'PREVIEW_DRY_RUN') {
          dryRunCount++;
        }
      }

      this.lastRunAt = runAt;
      const durationMs = Date.now() - startMs;

      return this.db.recordBackgroundScanRun({
        runAt,
        exchange: targetExchange,
        mode,
        symbolsScanned: scanResult.dataQuality.totalSymbolsScanned,
        volumeSamplesRecorded,
        longCandidates: scanResult.summaryCounts['多頭候選'],
        shortCandidates: scanResult.summaryCounts['空頭候選'],
        highRiskCount: scanResult.summaryCounts['高風險'],
        dryRunAlertsDispatched: dryRunCount,
        status: 'SUCCESS',
        source: snapshot.provenance.source,
        durationMs,
      });
    } catch (err) {
      this.lastRunAt = runAt;
      const durationMs = Date.now() - startMs;
      const errorMsg =
        err instanceof Error ? err.message : 'Background scan failed';

      return this.db.recordBackgroundScanRun({
        runAt,
        exchange: targetExchange,
        mode,
        symbolsScanned: 0,
        volumeSamplesRecorded: 0,
        longCandidates: 0,
        shortCandidates: 0,
        highRiskCount: 0,
        dryRunAlertsDispatched: 0,
        status: 'API_ERROR',
        source: adapter.displayName,
        errorMessage: errorMsg,
        durationMs,
      });
    }
  }

  /**
   * Prefer SmcBatchScanService (rate-limited, non-overlapping). Fall back to a
   * local concurrency-2 loop when the batch scanner was not injected (unit tests).
   */
  private async evaluateSelectedUniverse(params: {
    targetExchange: ExchangeId;
    mode: 'live' | 'demo';
    snapshotTickers: MarketTicker[];
    preScanCandidates: ScannedCandidate[];
    selected: ScannedCandidate[];
  }): Promise<Map<string, SmcAnalysisResult>> {
    const { targetExchange, mode, selected, preScanCandidates, snapshotTickers } =
      params;

    if (this.smcBatchScanner) {
      const worker = this.smcBatchScanner.getWorkerState(targetExchange);
      if (worker !== 'RUNNING') {
        this.smcBatchScanner.enqueueMarketUniverse({
          exchange: targetExchange,
          tickers: snapshotTickers,
          candidates: selected.length > 0 ? selected : preScanCandidates,
          watchlistSymbols: selected.map((c) => c.symbol),
          pruneUniverse: true,
        });
        await this.smcBatchScanner.startScan({
          exchange: targetExchange,
          mode,
          autoProcessLoop: true,
        });
      }
      const { smcMap } = this.smcBatchScanner.getConsistentSmcScanState(
        targetExchange,
        mode
      );
      const asEngineMap = new Map<string, SmcAnalysisResult>();
      for (const [sym, entry] of smcMap) {
        if (entry.smcAnalysis) {
          asEngineMap.set(sym, entry.smcAnalysis);
        } else {
          asEngineMap.set(sym, {
            actionState: entry.actionState as SmcAnalysisResult['actionState'],
            waitReasons: entry.waitReasons ?? [],
            smcEvaluationStatus: entry.smcEvaluationStatus,
          } as SmcAnalysisResult);
        }
      }
      return asEngineMap;
    }

    return this.evaluateInlineRateLimited(selected, targetExchange);
  }

  private async evaluateInlineRateLimited(
    selected: ScannedCandidate[],
    targetExchange: ExchangeId
  ): Promise<Map<string, SmcAnalysisResult>> {
    const adapter = this.adapters[targetExchange] ?? this.adapters.binance_usdm;
    const smcMap = new Map<string, SmcAnalysisResult>();
    const concurrency = SCHEDULER_INLINE_CONCURRENCY;
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= selected.length) return;
        const c = selected[idx];
        try {
          const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
            adapter.fetchOpenInterest(c.symbol, c.lastPrice),
            adapter.fetchKlines(c.symbol, '5m', 60),
            adapter.fetchKlines(c.symbol, '15m', 60),
            adapter.fetchKlines(c.symbol, '1h', 60),
            adapter.fetchKlines(c.symbol, '4h', 60),
          ]);
          const smcRes = evaluateSmcStructure({
            symbol: c.symbol,
            primaryTimeframe: '15m',
            klinesByTimeframe: {
              '5m': k5m.klines,
              '15m': k15m.klines,
              '1h': k1h.klines,
              '4h': k4h.klines,
            },
            openInterest: oiRes.openInterest,
            historicalVolume: c.historicalVolume,
            isLowLiquidity: c.isLowLiquidity,
            extremeFunding: c.extremeFunding,
            lowLiquidityHighVolatility: c.lowLiquidityHighVolatility,
            requireFullMultiTimeframe: true,
            provenance: c.provenance,
          });
          smcMap.set(c.symbol, smcRes);
        } catch {
          // ignore individual kline error in background scheduler
        }
      }
    });
    await Promise.all(workers);
    return smcMap;
  }

  public getStatus(): BackgroundSchedulerStatus {
    const recentRuns = this.db.listBackgroundScanRuns(20);
    return {
      safety: TRADING_SAFETY_FLAGS,
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      notificationMode: 'DRY_RUN_ONLY',
      lastRunAt: this.lastRunAt ?? (recentRuns[0]?.runAt || null),
      totalRuns: recentRuns.length,
      recentRuns,
      smcCoverage:
        this.lastCoverage ??
        buildSchedulerSmcCoverage({
          topN: this.smcTopN,
          selectedSymbolCount: 0,
          evaluatedInLatestMap: 0,
          batchWorkerState: this.smcBatchScanner ? 'UNKNOWN' : 'INLINE',
        }),
    };
  }
}
