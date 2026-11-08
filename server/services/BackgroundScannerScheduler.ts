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
  BackgroundSchedulerStatus,
  ExchangeId,
  SmcAnalysisResult,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export class BackgroundScannerScheduler {
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly db: RadarDatabase;
  private readonly telegramDryRunAdapter: TelegramNotificationAdapter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private lastRunAt: string | null = null;

  constructor(params: {
    adapters: Record<ExchangeId, ExchangeAdapter>;
    db: RadarDatabase;
    telegramDryRunAdapter: TelegramNotificationAdapter;
    intervalMs?: number;
  }) {
    this.adapters = params.adapters;
    this.db = params.db;
    this.telegramDryRunAdapter = params.telegramDryRunAdapter;
    this.intervalMs = params.intervalMs ?? 300_000; // default 5 minutes
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

      const smcMap = new Map<string, SmcAnalysisResult>();
      const topRadar = preScan.candidates
        .filter(
          (c) =>
            c.marketRadarCategory === '雷達多頭觀察' ||
            c.marketRadarCategory === '雷達空頭觀察'
        )
        .slice(0, 4);

      for (const c of topRadar) {
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
      // Strictly process ONLY when:
      // - smcEvaluationStatus === 'EVALUATED'
      // - smcActionState === 'LONG CANDIDATE' or 'SHORT CANDIDATE'
      // - finalTradeSignal !== 'NONE'
      // - stale === false
      // - fallback === false
      // - no WAIT Gate (waitReasons empty)
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
    };
  }
}
