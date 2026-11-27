import { RadarDatabase } from '../db/RadarDatabase.ts';
import { MARKET_SCAN_RULE_VERSION } from '../engine/MarketScanner.ts';
import {
  AutoBacktestBatchRunRecord,
  AutoBacktestConfig,
  AutoBacktestStatusResponse,
  ExchangeId,
  ScannedCandidate,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';
import { BacktestService } from './BacktestService.ts';

export class AutoBacktestScheduler {
  private readonly db: RadarDatabase;
  private readonly backtestService: BacktestService;
  private readonly getLatestCandidatesFn: () => ScannedCandidate[];
  private readonly isExchangeBusyFn: (exchange: ExchangeId) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private executingBatch = false;
  private lastBatchAt: string | null = null;
  private nextRunAt: string | null = null;

  constructor(params: {
    db: RadarDatabase;
    backtestService: BacktestService;
    getLatestCandidatesFn?: () => ScannedCandidate[];
    isExchangeBusyFn?: (exchange: ExchangeId) => boolean;
  }) {
    this.db = params.db;
    this.backtestService = params.backtestService;
    this.getLatestCandidatesFn = params.getLatestCandidatesFn ?? (() => []);
    this.isExchangeBusyFn = params.isExchangeBusyFn ?? (() => false);
  }

  public initFromPersistedConfig(): void {
    const config = this.db.getAutoBacktestConfig();
    if (config.enabled) {
      this.startTimer(config.intervalMs);
    } else {
      this.stopTimer();
    }
  }

  public updateConfig(
    patch: Partial<Omit<AutoBacktestConfig, 'updatedAt'>>
  ): AutoBacktestStatusResponse {
    const saved = this.db.saveAutoBacktestConfig(patch);
    if (saved.enabled) {
      this.startTimer(saved.intervalMs);
    } else {
      this.stopTimer();
    }
    return this.getStatus();
  }

  public stop(): AutoBacktestStatusResponse {
    this.stopTimer();
    return this.getStatus();
  }

  private startTimer(intervalMs: number): void {
    this.stopTimer();
    const safeInterval = Math.max(60_000, intervalMs);
    this.nextRunAt = new Date(Date.now() + safeInterval).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(Date.now() + safeInterval).toISOString();
      void this.runBatchOnce({ force: false });
    }, safeInterval);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  public resolveTargetSymbols(params?: {
    overrideSymbols?: string[];
    config?: AutoBacktestConfig;
  }): string[] {
    const cfg = params?.config ?? this.db.getAutoBacktestConfig();
    if (params?.overrideSymbols && params.overrideSymbols.length > 0) {
      return [
        ...new Set(
          params.overrideSymbols
            .map((s) => String(s).trim().toUpperCase())
            .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
        ),
      ].slice(0, cfg.maxSymbolsPerRun);
    }

    const ordered: string[] = [];
    const seen = new Set<string>();
    const pushSym = (sym: string) => {
      const clean = sym.trim().toUpperCase();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      ordered.push(clean);
    };

    if (cfg.includeWatchlist) {
      for (const w of cfg.watchlistSymbols) {
        pushSym(w);
      }
    }

    const latestCandidates = this.getLatestCandidatesFn();
    const ranked = [...latestCandidates]
      .filter((c) => !c.isLowLiquidity && !c.provenance?.isDemo)
      .sort((a, b) => {
        const aFormal =
          a.smcActionState === 'LONG CANDIDATE' ||
          a.smcActionState === 'SHORT CANDIDATE'
            ? 3
            : a.earlyIgnition?.status === 'IGNITION_LONG' ||
                a.earlyIgnition?.status === 'IGNITION_SHORT'
              ? 2
              : a.smcActionState === 'WATCH'
                ? 1
                : 0;
        const bFormal =
          b.smcActionState === 'LONG CANDIDATE' ||
          b.smcActionState === 'SHORT CANDIDATE'
            ? 3
            : b.earlyIgnition?.status === 'IGNITION_LONG' ||
                b.earlyIgnition?.status === 'IGNITION_SHORT'
              ? 2
              : b.smcActionState === 'WATCH'
                ? 1
                : 0;
        if (bFormal !== aFormal) return bFormal - aFormal;
        return (b.score ?? 0) - (a.score ?? 0);
      });

    for (const c of ranked) {
      if (ordered.length >= cfg.maxSymbolsPerRun) break;
      pushSym(c.symbol);
    }

    if (ordered.length === 0) {
      for (const fallback of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
        pushSym(fallback);
      }
    }

    return ordered.slice(0, cfg.maxSymbolsPerRun);
  }

  public async runBatchOnce(options?: {
    force?: boolean;
    mode?: 'live' | 'demo';
    exchange?: ExchangeId;
    overrideSymbols?: string[];
    barLimit?: number;
  }): Promise<AutoBacktestBatchRunRecord> {
    const startMs = Date.now();
    const startedAt = new Date(startMs).toISOString();
    const cfg = this.db.getAutoBacktestConfig();
    const mode: 'live' | 'demo' = options?.mode === 'demo' ? 'demo' : 'live';
    const exchange: ExchangeId =
      mode === 'demo'
        ? 'demo_synthetic'
        : options?.exchange ?? cfg.exchange ?? 'binance_usdm';
    const batchId = `ab_${startMs}_${Math.random().toString(36).slice(2, 7)}`;
    const targetSymbols = this.resolveTargetSymbols({
      overrideSymbols: options?.overrideSymbols,
      config: cfg,
    });

    if (this.executingBatch) {
      const skipped: AutoBacktestBatchRunRecord = {
        batchId,
        exchange,
        timeframe: cfg.timeframe,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'SKIPPED_BUSY',
        targetSymbols,
        completedCount: 0,
        skippedCachedCount: targetSymbols.length,
        failedCount: 0,
        savedRunIds: [],
        note: '上一輪自動回測仍在執行中，本次排程已略過避免重疊。',
        durationMs: Date.now() - startMs,
      };
      return this.db.recordAutoBacktestBatch(skipped);
    }

    if (!options?.force && mode === 'live' && this.isExchangeBusyFn(exchange)) {
      const skipped: AutoBacktestBatchRunRecord = {
        batchId,
        exchange,
        timeframe: cfg.timeframe,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'SKIPPED_BUSY',
        targetSymbols,
        completedCount: 0,
        skippedCachedCount: targetSymbols.length,
        failedCount: 0,
        savedRunIds: [],
        note: '全市場 SMC 批次掃描或限流退避進行中，本輪自動回測延後以優先保護即時行情掃描。',
        durationMs: Date.now() - startMs,
      };
      return this.db.recordAutoBacktestBatch(skipped);
    }

    this.executingBatch = true;
    let completedCount = 0;
    let skippedCachedCount = 0;
    let failedCount = 0;
    const savedRunIds: string[] = [];

    try {
      const dedupeWindowMs = options?.force
        ? 0
        : Math.max(15 * 60_000, Math.round(cfg.intervalMs * 0.75));
      const minCreatedAfterIso = new Date(startMs - dedupeWindowMs).toISOString();

      for (const sym of targetSymbols) {
        if (
          !options?.force &&
          this.db.hasRecentBacktestForSymbol({
            symbol: sym,
            exchange,
            timeframe: cfg.timeframe,
            ruleVersion: MARKET_SCAN_RULE_VERSION,
            minCreatedAfterIso,
          })
        ) {
          skippedCachedCount += 1;
          continue;
        }

        try {
          const { report } = await this.backtestService.executeBacktest({
            symbol: sym,
            timeframe: cfg.timeframe,
            mode,
            exchange,
            barLimit: Math.min(1000, Math.max(120, options?.barLimit ?? 240)),
            includeWalkForward: true,
            writeToPaperLedger: false,
            triggerSource: 'AUTO_SCHEDULED',
            autoBatchId: batchId,
          });
          completedCount += 1;
          if (report.backtestRunId) {
            savedRunIds.push(report.backtestRunId);
          }
        } catch {
          failedCount += 1;
        }

        if (mode === 'live' && targetSymbols.length > 1) {
          await new Promise((r) => setTimeout(r, 80));
        }
      }

      const completedAt = new Date().toISOString();
      this.lastBatchAt = completedAt;
      const status: AutoBacktestBatchRunRecord['status'] =
        failedCount > 0 && completedCount === 0 && skippedCachedCount === 0
          ? 'API_ERROR'
          : failedCount > 0
            ? 'PARTIAL_ERROR'
            : 'SUCCESS';

      const batch: AutoBacktestBatchRunRecord = {
        batchId,
        exchange,
        timeframe: cfg.timeframe,
        startedAt,
        completedAt,
        status,
        targetSymbols,
        completedCount,
        skippedCachedCount,
        failedCount,
        savedRunIds,
        note: `共評估 ${targetSymbols.length} 檔（新增存檔 ${completedCount}、快取略過 ${skippedCachedCount}、失敗 ${failedCount}）`,
        durationMs: Date.now() - startMs,
      };
      return this.db.recordAutoBacktestBatch(batch);
    } finally {
      this.executingBatch = false;
    }
  }

  public getStatus(): AutoBacktestStatusResponse {
    const config = this.db.getAutoBacktestConfig();
    const recentBatches = this.db.listAutoBacktestBatches(15);
    return {
      safety: TRADING_SAFETY_FLAGS,
      running: this.timer !== null,
      executingBatch: this.executingBatch,
      config,
      lastBatchAt: this.lastBatchAt ?? recentBatches[0]?.startedAt ?? null,
      nextRunAt: this.nextRunAt,
      totalBatches: recentBatches.length,
      recentBatches,
    };
  }
}
