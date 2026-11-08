import {
  buildDemoHistoricalVolumeMap,
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../adapters/ExchangeAdapter.ts';
import { TelegramNotificationAdapter } from '../adapters/NotificationAdapter.ts';
import { RadarDatabase } from '../db/RadarDatabase.ts';
import {
  MARKET_SCAN_RULE_VERSION,
  runMarketScan,
} from '../engine/MarketScanner.ts';
import {
  evaluateSmcStructure,
  SMC_RULE_VERSION,
} from '../engine/SmcRuleEngine.ts';
import {
  evaluateHistoricalVolumeAnomaly,
  extractPriorConfirmedBaselineWindow,
  MIN_HISTORY_SAMPLES,
} from '../engine/VolumeAnomalyEngine.ts';
import {
  DataProvenance,
  ExchangeId,
  FinalTradeSignal,
  Kline,
  MarketRadarCategory,
  MarketTicker,
  Phase17CycleLiveSnapshotRecord,
  Phase17LongRunningWindowRecord,
  Phase17ProgressEvidenceSampleRecord,
  Phase17RecoveryTriggerReason,
  Phase17ServiceRecoveryRecord,
  Phase17WindowDuration,
  ScannedCandidate,
  SmcActionState,
  SmcAnalysisResult,
  SmcEvaluationStatus,
  SmcExchangeApiHealthStatus,
  SmcExecutionWorker,
  SmcMonitorWorkerState,
  SmcPendingBreakdownConsistency,
  SmcPendingReason,
  SmcPendingSymbolRecord,
  SmcPriorityClass,
  SmcProgressRateStatus,
  SmcQueueHealthStatus,
  SmcQueueWorkerState,
  SmcRetryStuckResponse,
  SmcScanJobRecord,
  SmcScannerHealthStatus,
  SmcScanPriorityTier,
  SmcScanProgressHealthResponse,
  SmcScanQueueConfig,
  SmcScanResultRecord,
  SmcScanStatusResponse,
  SmcScanWorkerState,
  SmcStalledReason,
  SmcWorkerRole,
  SystemDatabaseHealthResponse,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export const DEFAULT_SMC_QUEUE_CONFIG: SmcScanQueueConfig = {
  maxConcurrency: 2,
  maxJobConcurrency: 2,
  maxHttpConcurrency: 8,
  maxRequestsPerMinute: 1200,
  batchSize: 60,
  maxRetries: 3,
  baseBackoffMs: 1000,
  priorityAgeMs: 15_000,
  maxFastLaneBurst: 8,
  bulkReservation: 1,
  fastLaneWorkerSlots: 1,
  stalledThresholdMs: 45_000,
  cacheTtlMsByTimeframe: {
    '5m': 5 * 60 * 1000, // 5 minutes (also gated by new 5m bar formation)
    '15m': 15 * 60 * 1000, // 15 minutes (also gated by new 15m bar formation)
    '1h': 30 * 60 * 1000, // 30 minutes TTL reuse
    '4h': 60 * 60 * 1000, // 60 minutes TTL reuse
  },
  oiCacheTtlMs: 15 * 60 * 1000,
  fundingCacheTtlMs: 15 * 60 * 1000,
};

export const DEFAULT_PRIORITY_WATCHLIST = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'SUIUSDT',
  'QUSDT',
];

export type ConsistentSmcMapEntry = Pick<
  SmcAnalysisResult,
  'actionState' | 'waitReasons'
> &
  Partial<Pick<SmcAnalysisResult, 'smcEvaluationStatus'>> & {
    evaluationStatus?: SmcEvaluationStatus;
    evaluatedAt?: string | null;
    dataFetchedAt?: string | null;
    marketRadarCategory?: MarketRadarCategory;
    finalTradeSignal?: FinalTradeSignal;
    smcAnalysis?: SmcAnalysisResult;
    gateEvaluation?: SmcAnalysisResult['gateEvaluation'];
    entryWindowStatus?:
      | 'DETECTED_BEFORE_NEXT_BAR_OPEN'
      | 'ENTRY_WINDOW_MISSED'
      | 'NOT_APPLICABLE';
    signalBarCloseTime?: number | null;
    nextBarOpenTime?: number | null;
    detectionLatencyMs?: number | null;
    candidateDetectionLatencyMs?: number | null;
    evaluationLatencyMs?: number | null;
    nextBarRemainingMs?: number | null;
    queueWaitMs?: number | null;
    smcEvaluationLatencyMs?: number | null;
    queueEnteredAt?: string | null;
    smcEvaluationStartedAt?: string | null;
    smcEvaluationCompletedAt?: string | null;
    entryWindowDelayMs?: number | null;
    isFastLane?: boolean;
    paperEligibilityStatus?: 'ELIGIBLE' | 'BLOCKED' | 'NOT_CANDIDATE';
    candidateDetectedAt?: string | null;
    signalDetectedAt?: string | null;
    paperOpenedAt?: string | null;
    entryWindowMissed?: boolean | null;
    blockedReason?: string | null;
  };

export class SmcBatchScanService {
  public readonly workerId: string;
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly db: RadarDatabase;
  private readonly telegramDryRunAdapter?: TelegramNotificationAdapter;
  private readonly onResultCallback?: (
    exchange: ExchangeId,
    symbol: string,
    analysis: SmcAnalysisResult,
    resultRecord: SmcScanResultRecord
  ) => void;

  private config: SmcScanQueueConfig;
  private workerState: 'RUNNING' | 'PAUSED' | 'IDLE' = 'IDLE';
  private activeExchange: ExchangeId = 'binance_usdm';
  private activeMode: 'live' | 'demo' = 'live';
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private progressSampleTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessingTick = false;
  private activeConcurrency = 0;
  public maxActiveConcurrencyObserved = 0;
  public maxRunningJobCountObserved = 0;
  private inFlightRequestCount = 0;
  public maxInFlightRequestCountObserved = 0;
  private readonly httpWaitQueue: Array<() => void> = [];
  private readonly requestTimestamps: number[] = [];
  private consecutiveFastLaneJobs = 0;
  private remainingBulkReservationJobs = 0;
  private runtimeCacheHitsByExchange = new Map<ExchangeId, number>();
  private runtimeCacheMissesByExchange = new Map<ExchangeId, number>();
  private latestTickerMapByExchange = new Map<
    ExchangeId,
    Map<string, MarketTicker>
  >();
  private latestCandidateMapByExchange = new Map<
    ExchangeId,
    Map<string, ScannedCandidate>
  >();
  private totalContractsByExchange = new Map<ExchangeId, number>();
  private activeWindowKeyByExchange = new Map<ExchangeId, string>();
  private activeRuleVersionByExchange = new Map<ExchangeId, string>();
  private inFlightPrewarmSymbolsByExchange = new Map<ExchangeId, Set<string>>();
  private isPrewarmingByExchange = new Map<ExchangeId, boolean>();
  private activePrewarmWorkerCount = 0;
  private inFlightTimeframePromises = new Map<
    string,
    Promise<{
      klines: Kline[];
      provenance: DataProvenance;
      fromCache: boolean;
      httpLatencyMs: number;
      slotWaitMs: number;
    }>
  >();
  private prewarmMetricsByExchangeSymbol = new Map<
    ExchangeId,
    Map<
      string,
      {
        prewarmWaitMs: number;
        httpLatencyMs: number;
        rateLimitWaitMs: number;
        cacheHit: boolean;
        cacheMiss: boolean;
      }
    >
  >();
  private lastProgressAtByExchange = new Map<ExchangeId, string>();
  private lastJobCompletedAtByExchange = new Map<ExchangeId, string>();
  private lastPrewarmProgressAtByExchange = new Map<ExchangeId, string>();
  private consecutiveExchangeErrorsByExchange = new Map<ExchangeId, number>();
  private completionTimestampsByExchange = new Map<ExchangeId, number[]>();
  private lastStalledSuspectedByExchange = new Map<ExchangeId, boolean>();
  private lastProgressEvidenceSampleMsByExchange = new Map<ExchangeId, number>();

  constructor(params: {
    adapters: Record<ExchangeId, ExchangeAdapter>;
    db: RadarDatabase;
    telegramDryRunAdapter?: TelegramNotificationAdapter;
    config?: Partial<SmcScanQueueConfig>;
    workerId?: string;
    recoverOnStart?: boolean;
    onResultCallback?: (
      exchange: ExchangeId,
      symbol: string,
      analysis: SmcAnalysisResult,
      resultRecord: SmcScanResultRecord
    ) => void;
  }) {
    this.workerId =
      params.workerId ??
      `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.adapters = params.adapters;
    this.db = params.db;
    this.telegramDryRunAdapter = params.telegramDryRunAdapter;
    this.onResultCallback = params.onResultCallback;
    const resolvedJobConcurrency =
      params.config?.maxJobConcurrency ??
      params.config?.maxConcurrency ??
      DEFAULT_SMC_QUEUE_CONFIG.maxJobConcurrency;
    this.config = {
      ...DEFAULT_SMC_QUEUE_CONFIG,
      ...params.config,
      maxConcurrency: resolvedJobConcurrency,
      maxJobConcurrency: resolvedJobConcurrency,
      maxHttpConcurrency:
        params.config?.maxHttpConcurrency ??
        DEFAULT_SMC_QUEUE_CONFIG.maxHttpConcurrency,
      priorityAgeMs:
        params.config?.priorityAgeMs ?? DEFAULT_SMC_QUEUE_CONFIG.priorityAgeMs,
      maxFastLaneBurst:
        params.config?.maxFastLaneBurst ??
        DEFAULT_SMC_QUEUE_CONFIG.maxFastLaneBurst,
      bulkReservation:
        params.config?.bulkReservation ??
        DEFAULT_SMC_QUEUE_CONFIG.bulkReservation,
      fastLaneWorkerSlots:
        params.config?.fastLaneWorkerSlots ??
        DEFAULT_SMC_QUEUE_CONFIG.fastLaneWorkerSlots,
      stalledThresholdMs:
        params.config?.stalledThresholdMs ??
        DEFAULT_SMC_QUEUE_CONFIG.stalledThresholdMs ??
        45_000,
      cacheTtlMsByTimeframe: {
        ...DEFAULT_SMC_QUEUE_CONFIG.cacheTtlMsByTimeframe,
        ...(params.config?.cacheTtlMsByTimeframe ?? {}),
      },
    };

    // Recover any interrupted RUNNING jobs from a prior server run back to QUEUED
    if (params.recoverOnStart !== false) {
      this.db.recoverInterruptedSmcJobs();
    }
    this.syncHttpConfigToDb();
  }

  private syncHttpConfigToDb(): void {
    const exchanges: ExchangeId[] = [
      'binance_usdm',
      'bybit_linear',
      'bingx_swap',
      'demo_synthetic',
    ];
    for (const ex of exchanges) {
      this.db.updateRuntimeHttpMetrics(ex, {
        maxHttpConcurrency: this.config.maxHttpConcurrency,
        maxRequestsPerMinute: this.config.maxRequestsPerMinute,
      });
      this.db.setMaxConcurrencyMeta(ex, this.config.maxConcurrency);
    }
  }

  public getConfig(): SmcScanQueueConfig {
    return {
      ...this.config,
      cacheTtlMsByTimeframe: { ...this.config.cacheTtlMsByTimeframe },
    };
  }

  public getInFlightRequestCount(): number {
    return this.inFlightRequestCount;
  }

  public updateConfig(partial: Partial<SmcScanQueueConfig>): SmcScanQueueConfig {
    const requestedJobConcurrency =
      partial.maxJobConcurrency ?? partial.maxConcurrency;
    if (
      requestedJobConcurrency !== undefined &&
      Number.isFinite(requestedJobConcurrency) &&
      requestedJobConcurrency >= 1
    ) {
      const clamped = Math.min(10, Math.floor(requestedJobConcurrency));
      this.config.maxConcurrency = clamped;
      this.config.maxJobConcurrency = clamped;
    }
    if (
      partial.maxHttpConcurrency !== undefined &&
      Number.isFinite(partial.maxHttpConcurrency) &&
      partial.maxHttpConcurrency >= 1
    ) {
      this.config.maxHttpConcurrency = Math.min(
        32,
        Math.floor(partial.maxHttpConcurrency)
      );
    }
    if (
      partial.maxRequestsPerMinute !== undefined &&
      Number.isFinite(partial.maxRequestsPerMinute) &&
      partial.maxRequestsPerMinute >= 4
    ) {
      this.config.maxRequestsPerMinute = Math.floor(
        partial.maxRequestsPerMinute
      );
    }
    if (
      partial.batchSize !== undefined &&
      Number.isFinite(partial.batchSize) &&
      partial.batchSize >= 1
    ) {
      this.config.batchSize = Math.floor(partial.batchSize);
    }
    if (
      partial.maxRetries !== undefined &&
      Number.isFinite(partial.maxRetries) &&
      partial.maxRetries >= 0
    ) {
      this.config.maxRetries = Math.floor(partial.maxRetries);
    }
    if (
      partial.baseBackoffMs !== undefined &&
      Number.isFinite(partial.baseBackoffMs) &&
      partial.baseBackoffMs >= 10
    ) {
      this.config.baseBackoffMs = Math.floor(partial.baseBackoffMs);
    }
    if (
      partial.priorityAgeMs !== undefined &&
      Number.isFinite(partial.priorityAgeMs) &&
      partial.priorityAgeMs >= 500
    ) {
      this.config.priorityAgeMs = Math.floor(partial.priorityAgeMs);
    }
    if (
      partial.maxFastLaneBurst !== undefined &&
      Number.isFinite(partial.maxFastLaneBurst) &&
      partial.maxFastLaneBurst >= 1
    ) {
      this.config.maxFastLaneBurst = Math.floor(partial.maxFastLaneBurst);
    }
    if (
      partial.bulkReservation !== undefined &&
      Number.isFinite(partial.bulkReservation) &&
      partial.bulkReservation >= 1
    ) {
      this.config.bulkReservation = Math.floor(partial.bulkReservation);
    }
    if (
      partial.fastLaneWorkerSlots !== undefined &&
      Number.isFinite(partial.fastLaneWorkerSlots) &&
      partial.fastLaneWorkerSlots >= 1
    ) {
      this.config.fastLaneWorkerSlots = Math.floor(partial.fastLaneWorkerSlots);
    }
    if (
      partial.stalledThresholdMs !== undefined &&
      Number.isFinite(partial.stalledThresholdMs) &&
      partial.stalledThresholdMs >= 1000
    ) {
      this.config.stalledThresholdMs = Math.floor(partial.stalledThresholdMs);
    }
    if (partial.cacheTtlMsByTimeframe) {
      this.config.cacheTtlMsByTimeframe = {
        ...this.config.cacheTtlMsByTimeframe,
        ...partial.cacheTtlMsByTimeframe,
      };
    }
    if (
      partial.oiCacheTtlMs !== undefined &&
      Number.isFinite(partial.oiCacheTtlMs) &&
      partial.oiCacheTtlMs >= 1000
    ) {
      this.config.oiCacheTtlMs = Math.floor(partial.oiCacheTtlMs);
    }
    if (
      partial.fundingCacheTtlMs !== undefined &&
      Number.isFinite(partial.fundingCacheTtlMs) &&
      partial.fundingCacheTtlMs >= 1000
    ) {
      this.config.fundingCacheTtlMs = Math.floor(partial.fundingCacheTtlMs);
    }
    this.syncHttpConfigToDb();
    return this.getConfig();
  }

  public computeWindowKey(
    nowMs = Date.now(),
    bucketMs = 15 * 60 * 1000
  ): string {
    const bucket = Math.floor(nowMs / bucketMs) * bucketMs;
    return `win_${bucket}`;
  }

  public resolveActiveWindowKey(
    exchange: ExchangeId,
    explicitWindowKey?: string
  ): string {
    if (explicitWindowKey) {
      this.activeWindowKeyByExchange.set(exchange, explicitWindowKey);
      return explicitWindowKey;
    }
    const inMemory = this.activeWindowKeyByExchange.get(exchange);
    if (inMemory) {
      return inMemory;
    }
    const fromDb = this.db.getLatestActiveWindowKey(exchange);
    if (fromDb) {
      this.activeWindowKeyByExchange.set(exchange, fromDb);
      return fromDb;
    }
    const computed = this.computeWindowKey();
    this.activeWindowKeyByExchange.set(exchange, computed);
    return computed;
  }

  /**
   * Builds and enqueues prioritized SMC scan jobs for all scanned USDT perpetual contracts
   * Phase 8 Two-Stage Priority Order:
   * 1. User Watchlist (1_WATCHLIST)
   * 2. Layer 1 Radar Long Observation front tier (2_RADAR_LONG)
   * 3. Layer 1 Radar Short Observation front tier (3_RADAR_SHORT)
   * 4. Top 24h Momentum & Volume Anomaly front tier (4_MOMENTUM_VOLUME_TOP)
   * 5. Symbols approaching next Kline open time (5_APPROACHING_NEXT_BAR_OPEN)
   * 6. Remaining USDT Perpetual Contracts (6_REMAINING_USDT_PERP)
   */
  public enqueueMarketUniverse(params: {
    exchange: ExchangeId;
    tickers: MarketTicker[];
    candidates: ScannedCandidate[];
    watchlistSymbols?: string[];
    approachingNextBarSymbols?: string[];
    windowKey?: string;
    ruleVersion?: string;
    forceRefresh?: boolean;
    pruneUniverse?: boolean;
    radarScanDurationMs?: number;
    lastFullRadarScanAt?: string;
    nearMissSymbols?: string[];
    prioritizeAllRadarAndNearMissOn15mClose?: boolean;
  }): {
    enqueuedCount: number;
    skippedDuplicateCount: number;
    fastLaneEnqueuedCount: number;
  } {
    const {
      exchange,
      tickers,
      candidates,
      watchlistSymbols = DEFAULT_PRIORITY_WATCHLIST,
      approachingNextBarSymbols = [],
      nearMissSymbols = [],
      prioritizeAllRadarAndNearMissOn15mClose = false,
      forceRefresh = false,
      pruneUniverse = false,
      radarScanDurationMs = 0,
    } = params;

    const windowKey = this.resolveActiveWindowKey(exchange, params.windowKey);
    const ruleVersion =
      params.ruleVersion ??
      this.activeRuleVersionByExchange.get(exchange) ??
      SMC_RULE_VERSION;
    if (params.ruleVersion) {
      this.activeRuleVersionByExchange.set(exchange, params.ruleVersion);
    }

    const watchlistSet = new Set(
      watchlistSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
    );
    const approachingSet = new Set(
      approachingNextBarSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
    );
    const explicitNearMissSet = new Set(
      nearMissSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
    );

    const tMap = new Map<string, MarketTicker>();
    const symbolsWithTickerOi = new Set<string>();
    for (const t of tickers) {
      tMap.set(t.symbol, t);
      if (t.openInterest !== null && t.openInterest !== undefined) {
        symbolsWithTickerOi.add(t.symbol);
      }
    }
    this.latestTickerMapByExchange.set(exchange, tMap);

    const cMap = new Map<string, ScannedCandidate>();
    for (const c of candidates) {
      cMap.set(c.symbol, c);
      if (c.openInterest !== null && c.openInterest !== undefined) {
        symbolsWithTickerOi.add(c.symbol);
      }
    }
    this.latestCandidateMapByExchange.set(exchange, cMap);
    const universeCount = candidates.length || tickers.length;
    this.totalContractsByExchange.set(exchange, universeCount);

    const requiresPerSymbolOiHttp =
      universeCount === 0
        ? exchange !== 'demo_synthetic'
        : symbolsWithTickerOi.size < universeCount;
    this.db.updateRuntimeHttpMetrics(exchange, {
      maxHttpConcurrency: this.config.maxHttpConcurrency,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
      requiresPerSymbolOiHttp,
      symbolsWithTickerOi,
      resetCompletedHttpRequests: forceRefresh,
    });

    const nowMs = Date.now();
    this.db.getOrSyncLongRunningWindows(
      exchange,
      nowMs,
      this.config.maxConcurrency
    );
    const requestedAt = params.lastFullRadarScanAt ?? new Date(nowMs).toISOString();
    this.db.recordStage1RadarScanMeta(
      exchange,
      requestedAt,
      Math.max(0, Math.round(radarScanDurationMs))
    );

    // Check if current time is within 3 minutes of the next 15m bar open
    const bar15mMs = 15 * 60 * 1000;
    const next15mOpenMs = (Math.floor(nowMs / bar15mMs) + 1) * bar15mMs;
    const msUntilNext15mOpen = next15mOpenMs - nowMs;
    const isNearBarOpenWindow = msUntilNext15mOpen <= 3 * 60 * 1000;

    // Identify front-tier ("前段") sets for Tier 2, Tier 3, Tier 4, Tier 5 so Fast Lane stays focused on true front-tier candidates
    const radarLongTopSet = new Set(
      [...candidates]
        .filter(
          (c) =>
            !watchlistSet.has(c.symbol) &&
            c.marketRadarCategory === '雷達多頭觀察'
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((c) => c.symbol)
    );

    const radarShortTopSet = new Set(
      [...candidates]
        .filter(
          (c) =>
            !watchlistSet.has(c.symbol) &&
            c.marketRadarCategory === '雷達空頭觀察'
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((c) => c.symbol)
    );

    const momentumVolumeTopSet = new Set(
      [...candidates]
        .filter(
          (c) =>
            !watchlistSet.has(c.symbol) &&
            !radarLongTopSet.has(c.symbol) &&
            !radarShortTopSet.has(c.symbol) &&
            (c.historicalVolume.isHistoricalAnomaly ||
              (Math.abs(c.priceChangePercent24h) >= 6.0 &&
                c.auxiliaryVolumeRankProxyPercentile >= 85) ||
              c.auxiliaryVolumeRankProxyPercentile >= 95)
        )
        .sort(
          (a, b) =>
            b.auxiliaryVolumeRankProxyPercentile +
            Math.abs(b.priceChangePercent24h) -
            (a.auxiliaryVolumeRankProxyPercentile +
              Math.abs(a.priceChangePercent24h))
        )
        .slice(0, 8)
        .map((c) => c.symbol)
    );

    const nearBarTopSet = new Set(
      isNearBarOpenWindow
        ? [...candidates]
            .filter(
              (c) =>
                !watchlistSet.has(c.symbol) &&
                !radarLongTopSet.has(c.symbol) &&
                !radarShortTopSet.has(c.symbol) &&
                !momentumVolumeTopSet.has(c.symbol) &&
                !c.isLowLiquidity &&
                c.auxiliaryVolumeRankProxyPercentile >= 85
            )
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((c) => c.symbol)
        : []
    );

    // Phase 18 Section 四: Prioritize previously detected SMC formal candidates and Near-Miss symbols into Fast Lane
    const priorResults = this.db.listSmcScanResults(exchange);
    const priorCandidateOrNearMissSet = new Set<string>();
    for (const r of priorResults) {
      const mgLen =
        r.missingGates?.length ??
        r.smcAnalysis?.gateEvaluation?.missingGates?.length ??
        99;
      if (
        r.smcActionState === 'LONG CANDIDATE' ||
        r.smcActionState === 'SHORT CANDIDATE' ||
        r.nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
        r.nearMissStatus === 'NEAR_MISS_TWO_GATES' ||
        mgLen === 1 ||
        mgLen === 2
      ) {
        priorCandidateOrNearMissSet.add(r.symbol);
      }
    }

    const jobsToEnqueue: Array<Omit<SmcScanJobRecord, 'id'>> = [];
    let fastLaneEnqueuedCount = 0;

    for (const c of candidates) {
      let priorityTier: SmcScanPriorityTier = 6;
      let priorityLabel = '6_REMAINING_USDT_PERP';
      let isFastLane = false;

      const isCurrentOrPriorCandidateOrNearMiss =
        explicitNearMissSet.has(c.symbol) ||
        priorCandidateOrNearMissSet.has(c.symbol) ||
        c.smcActionState === 'LONG CANDIDATE' ||
        c.smcActionState === 'SHORT CANDIDATE' ||
        c.nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
        c.nearMissStatus === 'NEAR_MISS_TWO_GATES' ||
        (c.gateEvaluation?.missingGates &&
          (c.gateEvaluation.missingGates.length === 1 ||
            c.gateEvaluation.missingGates.length === 2));

      if (watchlistSet.has(c.symbol)) {
        priorityTier = 1;
        priorityLabel = '1_WATCHLIST';
        isFastLane = true;
      } else if (
        c.smcActionState === 'LONG CANDIDATE' ||
        radarLongTopSet.has(c.symbol) ||
        (prioritizeAllRadarAndNearMissOn15mClose &&
          c.marketRadarCategory === '雷達多頭觀察')
      ) {
        priorityTier = 2;
        priorityLabel = '2_RADAR_LONG';
        isFastLane = true;
      } else if (
        c.smcActionState === 'SHORT CANDIDATE' ||
        radarShortTopSet.has(c.symbol) ||
        (prioritizeAllRadarAndNearMissOn15mClose &&
          c.marketRadarCategory === '雷達空頭觀察')
      ) {
        priorityTier = 3;
        priorityLabel = '3_RADAR_SHORT';
        isFastLane = true;
      } else if (
        isCurrentOrPriorCandidateOrNearMiss ||
        momentumVolumeTopSet.has(c.symbol)
      ) {
        priorityTier = 4;
        priorityLabel = isCurrentOrPriorCandidateOrNearMiss
          ? '4_SMC_CANDIDATE_OR_NEAR_MISS_FAST_LANE'
          : '4_MOMENTUM_VOLUME_TOP';
        isFastLane = true;
      } else if (approachingSet.has(c.symbol) || nearBarTopSet.has(c.symbol)) {
        priorityTier = 5;
        priorityLabel = '5_APPROACHING_NEXT_BAR_OPEN';
        isFastLane = true;
      }

      if (isFastLane) {
        fastLaneEnqueuedCount++;
      }

      const priorityScore = Number(
        (
          (7 - priorityTier) * 10000 +
          (isCurrentOrPriorCandidateOrNearMiss ? 5000 : 0) +
          c.auxiliaryVolumeRankProxyPercentile * 10 +
          Math.min(99, Math.abs(c.priceChangePercent24h))
        ).toFixed(2)
      );

      const priorityClass: SmcPriorityClass = isFastLane
        ? 'FAST_LANE'
        : 'BULK';

      jobsToEnqueue.push({
        symbol: c.symbol,
        exchange,
        priority: priorityScore,
        priorityTier,
        priorityLabel,
        priorityClass,
        status: 'QUEUED',
        ruleVersion,
        windowKey,
        requestedAt,
        queueEnteredAt: requestedAt,
        startedAt: null,
        jobClaimedAt: null,
        smcEvaluationStartedAt: null,
        completedAt: null,
        smcEvaluationCompletedAt: null,
        queueWaitMs: null,
        prewarmWaitMs: 0,
        httpRequestLatencyMs: null,
        smcCalculationLatencyMs: null,
        dbWriteLatencyMs: null,
        smcEvaluationLatencyMs: null,
        rateLimitWaitMs: null,
        detectionLatencyMs: null,
        cacheHit: false,
        cacheMiss: false,
        reusedCache: false,
        workerRole: isFastLane ? 'FAST_LANE' : 'BULK',
        executionWorker: null,
        isFastLane,
        lastError: null,
        retryCount: 0,
        nextRetryAt: null,
      });
    }

    // Sort jobs by isFastLane DESC, priorityTier ASC, priority DESC before inserting
    jobsToEnqueue.sort((a, b) => {
      const fastA = a.isFastLane ? 1 : 0;
      const fastB = b.isFastLane ? 1 : 0;
      if (fastA !== fastB) {
        return fastB - fastA;
      }
      if (a.priorityTier !== b.priorityTier) {
        return a.priorityTier - b.priorityTier;
      }
      return b.priority - a.priority;
    });

    const res = this.db.enqueueSmcScanJobs(
      jobsToEnqueue,
      forceRefresh,
      pruneUniverse
    );
    return {
      ...res,
      fastLaneEnqueuedCount,
    };
  }

  /**
   * Phase 18.3 Requirement 一:
   * Immediately triggers Fast Lane formal candidate evaluation upon a confirmed 15m K-line close event,
   * without waiting for the 522-symbol Bulk queue to complete:
   * - Radar Long, Radar Short, Near-Miss, and Watchlist targets enter Fast Lane (`isFastLane = true`, `priorityClass = 'FAST_LANE'`).
   * - Fast Lane is evaluated strictly ahead of Bulk Queue.
   * - Reuses valid warm caches (`5m`/`15m`/`1h`/`4h`) to avoid redundant HTTP fetches.
   * - Rejects unclosed K-lines, future data, Demo fallback, and retroactive `nextBar.open`.
   */
  public async triggerConfirmed15mBarCloseFastLane(params: {
    exchange: ExchangeId;
    confirmedBarCloseTime: number;
    tickers?: MarketTicker[];
    candidates?: ScannedCandidate[];
    watchlistSymbols?: string[];
    nearMissSymbols?: string[];
    evaluateImmediately?: boolean;
    nowMs?: number;
  }): Promise<{
    triggeredAt: string;
    confirmedBarCloseTime: number;
    fastLaneEnqueuedCount: number;
    bulkEnqueuedCount: number;
    fastLaneSymbols: string[];
    evaluatedFastLaneSymbols: string[];
    results: SmcScanResultRecord[];
  }> {
    const {
      exchange,
      confirmedBarCloseTime,
      watchlistSymbols = DEFAULT_PRIORITY_WATCHLIST,
      nearMissSymbols = [],
      evaluateImmediately = true,
    } = params;
    const nowMs = params.nowMs ?? Date.now();

    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live 15m 收盤事件觸發嚴禁使用 demo_synthetic 或 Demo fallback'
      );
    }
    const adapter = this.adapters[exchange];
    if (!adapter || adapter.isDemo) {
      throw new Error(
        '安全攔截：Live 15m 收盤事件觸發嚴禁使用 DemoExchangeAdapter'
      );
    }
    if (!Number.isFinite(confirmedBarCloseTime) || confirmedBarCloseTime <= 0) {
      throw new Error('無效的 15m K 線收盤時間 (confirmedBarCloseTime)');
    }
    if (confirmedBarCloseTime > nowMs) {
      throw new Error(
        `安全攔截：禁止使用未收盤 K 線或未來資料 (confirmedBarCloseTime=${confirmedBarCloseTime} > nowMs=${nowMs})`
      );
    }

    const tickers =
      params.tickers ??
      Array.from(this.latestTickerMapByExchange.get(exchange)?.values() ?? []);
    const candidates =
      params.candidates ??
      Array.from(
        this.latestCandidateMapByExchange.get(exchange)?.values() ?? []
      );

    const triggeredAt = new Date(confirmedBarCloseTime).toISOString();
    const windowKey = `win15m_${Math.floor(confirmedBarCloseTime / 900_000)}`;

    const enqRes = this.enqueueMarketUniverse({
      exchange,
      tickers,
      candidates,
      watchlistSymbols,
      nearMissSymbols,
      prioritizeAllRadarAndNearMissOn15mClose: true,
      windowKey,
      forceRefresh: true,
      pruneUniverse: true,
      lastFullRadarScanAt: triggeredAt,
    });

    const allJobs = this.db.listSmcScanJobs(exchange, 600);
    const fastLaneJobs = allJobs
      .filter((j) => j.isFastLane || j.priorityClass === 'FAST_LANE')
      .sort((a, b) => {
        if (a.priorityTier !== b.priorityTier) {
          return a.priorityTier - b.priorityTier;
        }
        return b.priority - a.priority;
      });
    const bulkJobs = allJobs.filter(
      (j) => !j.isFastLane && j.priorityClass === 'BULK'
    );

    const evaluatedFastLaneSymbols: string[] = [];
    const results: SmcScanResultRecord[] = [];

    if (evaluateImmediately) {
      for (const fJob of fastLaneJobs) {
        const claimIso = new Date(Date.now()).toISOString();
        const claimed = this.db.claimNextSmcScanJobs(exchange, 1, claimIso, {
          maxConcurrency: Math.max(1, this.config.maxConcurrency),
          workerId: `${this.workerId}-15m-close-fast-lane`,
          workerRole: 'FAST_LANE',
          leaseDurationMs: 60_000,
          priorityAgeMs: this.config.priorityAgeMs,
          forceBulkAntiStarvation: false,
        });
        const jobToRun = claimed[0] ?? fJob;
        if (jobToRun.priorityClass !== 'FAST_LANE' && !jobToRun.isFastLane) {
          break;
        }
        await this.executeJob(jobToRun, 'live', false);
        evaluatedFastLaneSymbols.push(jobToRun.symbol);
        const saved = this.db.getSmcScanResult(exchange, jobToRun.symbol);
        if (saved) {
          results.push(saved);
        }
      }
    }

    return {
      triggeredAt,
      confirmedBarCloseTime,
      fastLaneEnqueuedCount: enqRes.fastLaneEnqueuedCount,
      bulkEnqueuedCount: bulkJobs.length,
      fastLaneSymbols: fastLaneJobs.map((j) => j.symbol),
      evaluatedFastLaneSymbols,
      results,
    };
  }

  public async startScan(params: {
    exchange?: ExchangeId;
    mode?: 'live' | 'demo';
    watchlistSymbols?: string[];
    config?: Partial<SmcScanQueueConfig>;
    autoProcessLoop?: boolean;
  } = {}): Promise<SmcScanStatusResponse> {
    if (params.config) {
      this.updateConfig(params.config);
    }
    const mode = params.mode ?? this.activeMode;
    const exchange: ExchangeId =
      mode === 'demo'
        ? 'demo_synthetic'
        : params.exchange ?? this.activeExchange;

    this.activeExchange = exchange;
    this.activeMode = mode;

    // Recover any interrupted jobs on start
    this.db.recoverInterruptedSmcJobs(exchange);

    // If we don't have candidates cached for this exchange yet, fetch snapshot once to populate the universe
    if (!this.latestCandidateMapByExchange.has(exchange)) {
      const radarStartMs = Date.now();
      const adapter = this.adapters[exchange] ?? this.adapters.binance_usdm;
      const snapshot = await adapter.fetchMarketSnapshot();
      const histMap =
        mode === 'demo'
          ? buildDemoHistoricalVolumeMap()
          : this.db.getBulkHistoricalVolumeMap(exchange, 40, '15m');
      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        mode,
        exchange,
        volumeTimeframe: '15m',
        historicalVolumeMap: histMap,
      });
      const radarScanDurationMs = Date.now() - radarStartMs;
      this.enqueueMarketUniverse({
        exchange,
        tickers: snapshot.tickers,
        candidates: preScan.candidates,
        watchlistSymbols: params.watchlistSymbols,
        pruneUniverse: true,
        radarScanDurationMs,
        lastFullRadarScanAt: new Date().toISOString(),
      });
    } else if (params.watchlistSymbols) {
      const tickers = Array.from(
        this.latestTickerMapByExchange.get(exchange)?.values() ?? []
      );
      const candidates = Array.from(
        this.latestCandidateMapByExchange.get(exchange)?.values() ?? []
      );
      this.enqueueMarketUniverse({
        exchange,
        tickers,
        candidates,
        watchlistSymbols: params.watchlistSymbols,
        pruneUniverse: true,
      });
    }

    // Phase 8 Section 二: Complete cold-start priority cache prewarm for Fast Lane targets BEFORE Fast Lane SMC deep evaluation
    await this.prewarmFastLaneCache({
      exchange,
      mode,
    });

    this.workerState = 'RUNNING';
    if (params.autoProcessLoop !== false) {
      this.scheduleNextTick(15);
    }

    return this.getStatus(exchange, mode);
  }

  /**
   * Phase 8 Section 二: Cold-Start Priority Cache Prewarm
   * 1. Selects Fast Lane targets (WATCHLIST, RADAR_LONG, RADAR_SHORT, MOMENTUM_VOLUME_TOP, APPROACHING_NEXT_BAR_OPEN — priorityTier 1..5).
   * 2. Prewarms 5m, 15m, 1h, 4h, OI, and Funding before Fast Lane SMC deep evaluation.
   * 3. Strictly obeys maxHttpConcurrency, maxRequestsPerMinute, rate-limit backoff, worker lease (never occupying all Fast Lane slots), and per-symbol deduplication.
   */
  public async prewarmFastLaneCache(
    params: {
      exchange?: ExchangeId;
      mode?: 'live' | 'demo';
      forceRefresh?: boolean;
      symbols?: string[];
    } = {}
  ): Promise<{
    prewarmedSymbolCount: number;
    prewarmDurationMs: number;
    prewarmCacheHitRate: number;
    isColdStart: boolean;
  }> {
    const mode = params.mode ?? this.activeMode;
    const exchange: ExchangeId =
      mode === 'demo'
        ? 'demo_synthetic'
        : params.exchange ?? this.activeExchange;
    const forceRefresh = params.forceRefresh ?? false;
    const adapter = this.adapters[exchange] ?? this.adapters.binance_usdm;

    if (!this.inFlightPrewarmSymbolsByExchange.has(exchange)) {
      this.inFlightPrewarmSymbolsByExchange.set(exchange, new Set());
    }
    const inFlightSet = this.inFlightPrewarmSymbolsByExchange.get(exchange)!;

    if (!this.prewarmMetricsByExchangeSymbol.has(exchange)) {
      this.prewarmMetricsByExchangeSymbol.set(exchange, new Map());
    }
    const symbolMetricsMap = this.prewarmMetricsByExchangeSymbol.get(exchange)!;

    // 1. Select Fast Lane targets (Tier 1..5: WATCHLIST, RADAR_LONG, RADAR_SHORT, MOMENTUM_VOLUME_TOP, APPROACHING_NEXT_BAR_OPEN)
    const allJobs = this.db.listSmcScanJobs(exchange, 600);
    const fastLaneJobs = allJobs
      .filter(
        (j) =>
          j.priorityTier >= 1 &&
          j.priorityTier <= 5 &&
          (j.priorityClass === 'FAST_LANE' || j.priorityTier <= 5)
      )
      .sort((a, b) => {
        if (a.priorityTier !== b.priorityTier) {
          return a.priorityTier - b.priorityTier;
        }
        return b.priority - a.priority;
      });

    const candidateSymbols =
      params.symbols && params.symbols.length > 0
        ? params.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
        : fastLaneJobs.map((j) => j.symbol);

    const uniqueTargetSymbols: string[] = [];
    const seen = new Set<string>();
    for (const sym of candidateSymbols) {
      if (!seen.has(sym) && !inFlightSet.has(sym)) {
        seen.add(sym);
        uniqueTargetSymbols.push(sym);
      }
    }

    const prewarmStartMs = Date.now();
    const nowCheckMs = prewarmStartMs;

    // Check how many target symbols already have warm caches before prewarm begins
    const expectedRuleVersion =
      this.activeRuleVersionByExchange.get(exchange) ?? SMC_RULE_VERSION;
    const activeWindowKey = this.resolveActiveWindowKey(exchange);
    let alreadyWarmSymbolCount = 0;
    const timeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const symbolsNeedingNetworkPrewarm: string[] = [];

    for (const sym of uniqueTargetSymbols) {
      const cached15m = this.db.getSmcCandlesCache(
        exchange,
        sym,
        '15m',
        nowCheckMs,
        { expectedRuleVersion }
      );
      const isOiWarm =
        !forceRefresh &&
        cached15m?.openInterest !== null &&
        cached15m?.openInterest !== undefined &&
        (!cached15m.oiExpiresAt ||
          Date.parse(cached15m.oiExpiresAt) > nowCheckMs);
      const allTfWarm = timeframes.every((tf) => {
        const c = this.db.getSmcCandlesCache(exchange, sym, tf, nowCheckMs, {
          expectedRuleVersion,
        });
        return Boolean(
          c &&
            !c.isExpired &&
            c.klines.length > 0 &&
            !c.provenance.stale &&
            !c.provenance.fallback &&
            c.provenance.missingData.length === 0
        );
      });
      if (allTfWarm && isOiWarm && !forceRefresh) {
        alreadyWarmSymbolCount++;
        const warmIso = new Date(nowCheckMs).toISOString();
        this.db.recordPrewarmTask({
          symbol: sym,
          exchange,
          prewarmStartedAt: warmIso,
          prewarmCompletedAt: warmIso,
          prewarmDurationMs: 0,
          prewarmPriority: 'FAST_LANE',
          prewarmStatus: 'COMPLETED',
        });
        symbolMetricsMap.set(sym, {
          prewarmWaitMs: 0,
          httpLatencyMs: 0,
          rateLimitWaitMs: 0,
          cacheHit: true,
          cacheMiss: false,
        });
        this.runtimeCacheHitsByExchange.set(
          exchange,
          (this.runtimeCacheHitsByExchange.get(exchange) ?? 0) + 4
        );
      } else {
        symbolsNeedingNetworkPrewarm.push(sym);
      }
    }

    const completedScanCyclesCount =
      this.db.getAtomicSmcSnapshot(exchange).completedScanCyclesCount;
    const isColdStart =
      forceRefresh ||
      uniqueTargetSymbols.length === 0
        ? forceRefresh || completedScanCyclesCount === 0
        : alreadyWarmSymbolCount < Math.ceil(uniqueTargetSymbols.length * 0.5);

    if (uniqueTargetSymbols.length === 0 || symbolsNeedingNetworkPrewarm.length === 0) {
      const completedIso = new Date().toISOString();
      this.db.recordPrewarmScanMeta(exchange, completedIso, 0, 100, isColdStart);
      const totalUniv =
        this.totalContractsByExchange.get(exchange) || allJobs.length;
      const cov = this.db.getCacheCoverageMetrics(
        exchange,
        totalUniv,
        false,
        expectedRuleVersion
      );
      this.db.savePrewarmSnapshot({
        snapshotId: `snap_${exchange}_${activeWindowKey}`,
        databaseInstanceId: this.db.databaseInstanceId,
        exchange,
        ruleVersion: expectedRuleVersion,
        windowKey: activeWindowKey,
        createdAt: completedIso,
        symbolCount: totalUniv,
        timeframeCoverage: {
          '5m': cov['5mCacheCoverage'],
          '15m': cov['15mCacheCoverage'],
          '1h': cov['1hCacheCoverage'],
          '4h': cov['4hCacheCoverage'],
        },
        oiFundingCoverage: {
          oiCoverage: cov.oiCacheCoverage,
          fundingCoverage: cov.fundingCacheCoverage,
        },
        freshUntil: new Date(
          Date.now() + (this.config.cacheTtlMsByTimeframe['5m'] ?? 300_000)
        ).toISOString(),
      });
      return {
        prewarmedSymbolCount: uniqueTargetSymbols.length,
        prewarmDurationMs: 0,
        prewarmCacheHitRate: 100,
        isColdStart,
      };
    }

    this.isPrewarmingByExchange.set(exchange, true);
    let totalChecks = alreadyWarmSymbolCount * 5;
    let totalCacheHits = alreadyWarmSymbolCount * 5;

    try {
      // Reserve at least 1 Fast Lane worker slot so prewarm NEVER occupies all Fast Lane slots
      const maxJobConc = Math.max(1, this.config.maxJobConcurrency);
      const maxPrewarmWorkers =
        maxJobConc >= 2 ? Math.max(1, maxJobConc - 1) : 1;

      let cursor = 0;
      const prewarmWorker = async () => {
        while (cursor < symbolsNeedingNetworkPrewarm.length) {
          const idx = cursor++;
          const symbol = symbolsNeedingNetworkPrewarm[idx];
          if (!symbol || inFlightSet.has(symbol)) continue;

          // Respect worker lease & runningJobCount <= maxJobConcurrency, and deduplicate against RUNNING jobs
          for (let waitAttempt = 0; waitAttempt < 20; waitAttempt++) {
            const qStats = this.db.getSmcScanQueueStats(exchange);
            if (
              qStats.runningJobCount + this.activePrewarmWorkerCount <
              maxJobConc
            ) {
              break;
            }
            if (maxJobConc === 1 && qStats.runningJobCount === 0) {
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }

          const runningForSymbol = this.db
            .listSmcScanJobs(exchange, 600)
            .some((j) => j.symbol === symbol && j.status === 'RUNNING');
          if (runningForSymbol) {
            continue;
          }

          inFlightSet.add(symbol);
          this.activePrewarmWorkerCount++;
          const symStartMs = Date.now();
          const symStartedIso = new Date(symStartMs).toISOString();
          this.db.recordPrewarmTask({
            symbol,
            exchange,
            prewarmStartedAt: symStartedIso,
            prewarmCompletedAt: null,
            prewarmDurationMs: 0,
            prewarmPriority: 'FAST_LANE',
            prewarmStatus: 'PREWARMING',
          });

          try {
            const ticker = this.latestTickerMapByExchange
              .get(exchange)
              ?.get(symbol);

            const fetchTfWithRetry = async (tf: Timeframe) => {
              let lastErr: unknown;
              for (
                let attempt = 0;
                attempt <= this.config.maxRetries;
                attempt++
              ) {
                try {
                  return await this.fetchOrGetCachedTimeframe(
                    adapter,
                    exchange,
                    symbol,
                    tf,
                    forceRefresh
                  );
                } catch (err) {
                  lastErr = err;
                  const msg = err instanceof Error ? err.message : String(err);
                  const isRl =
                    (err instanceof ExchangeApiUnavailableError &&
                      (err.statusCode === 429 || err.isRateLimited)) ||
                    /429|rate limit|too many requests/i.test(msg);
                  if (isRl && attempt < this.config.maxRetries) {
                    this.db.updateRuntimeHttpMetrics(exchange, {
                      incrementRateLimitEvents: 1,
                    });
                    const backoffMs = Math.min(
                      2000,
                      this.config.baseBackoffMs * Math.pow(2, attempt)
                    );
                    await new Promise((r) => setTimeout(r, backoffMs));
                    continue;
                  }
                  throw err;
                }
              }
              throw lastErr;
            };

            const cached15mBefore = this.db.getSmcCandlesCache(
              exchange,
              symbol,
              '15m'
            );
            const nowMsForOi = Date.now();
            const isCachedOiFresh =
              !forceRefresh &&
              cached15mBefore?.openInterest !== null &&
              cached15mBefore?.openInterest !== undefined &&
              (!cached15mBefore.oiExpiresAt ||
                Date.parse(cached15mBefore.oiExpiresAt) > nowMsForOi);

            let openInterest: number | null = isCachedOiFresh
              ? cached15mBefore!.openInterest
              : ticker?.openInterest ?? cached15mBefore?.openInterest ?? null;
            let openInterestValue: number | null =
              cached15mBefore?.openInterestValue ??
              ticker?.openInterestValue ??
              (openInterest !== null && ticker?.lastPrice
                ? openInterest * ticker.lastPrice
                : null);
            let oiFromCache = isCachedOiFresh;
            let oiSlotWaitMs = 0;
            let oiHttpLatencyMs = 0;

            const shouldFetchOi =
              forceRefresh ||
              openInterest === null ||
              (Boolean(cached15mBefore?.oiExpiresAt) &&
                Date.parse(cached15mBefore!.oiExpiresAt!) <= nowMsForOi);

            const prewarmOiAndFunding = async () => {
              totalChecks++;
              if (!shouldFetchOi) {
                totalCacheHits++;
                return;
              }
              if (!this.canIssueRequest(1)) {
                return;
              }
              try {
                oiSlotWaitMs = await this.acquireHttpSlot();
                const oiStart = Date.now();
                this.recordRequestIssued(oiStart, exchange);
                try {
                  const oiRes = await adapter.fetchOpenInterest(
                    symbol,
                    ticker?.lastPrice
                  );
                  oiHttpLatencyMs = Math.max(0, Date.now() - oiStart);
                  openInterest = oiRes.openInterest;
                  openInterestValue = oiRes.openInterestValue;
                  oiFromCache = false;
                  if (openInterest !== null && ticker) {
                    ticker.openInterest = openInterest;
                  }
                } finally {
                  this.releaseHttpSlot();
                }
              } catch {
                // OI optional on prewarm failure
              }
            };

            const [k5m, k15m, k1h, k4h] = await Promise.all([
              fetchTfWithRetry('5m'),
              fetchTfWithRetry('15m'),
              fetchTfWithRetry('1h'),
              fetchTfWithRetry('4h'),
              prewarmOiAndFunding(),
            ]);

            totalChecks += 4;
            if (k5m.fromCache) totalCacheHits++;
            if (k15m.fromCache) totalCacheHits++;
            if (k1h.fromCache) totalCacheHits++;
            if (k4h.fromCache) totalCacheHits++;

            // Persist OI + Funding into 15m cache row
            const latest15m = this.db.getSmcCandlesCache(
              exchange,
              symbol,
              '15m'
            );
            if (latest15m) {
              const oiRefNowMs = Math.max(
                Date.now(),
                Date.parse(latest15m.provenance.fetchedAt) || Date.now()
              );
              const oiFetchedAt = new Date(oiRefNowMs).toISOString();
              const oiExpiresAt = new Date(
                oiRefNowMs + (this.config.oiCacheTtlMs ?? 900_000)
              ).toISOString();
              this.db.saveSmcCandlesCache({
                symbol,
                exchange,
                timeframe: '15m',
                klines: latest15m.klines,
                openInterest: openInterest ?? latest15m.openInterest ?? null,
                openInterestValue:
                  openInterestValue ?? latest15m.openInterestValue ?? null,
                fundingRate:
                  ticker?.fundingRate ?? latest15m.fundingRate ?? null,
                nextFundingTime:
                  ticker?.nextFundingTime ?? latest15m.nextFundingTime ?? null,
                oiFetchedAt: !oiFromCache
                  ? oiFetchedAt
                  : latest15m.oiFetchedAt ?? oiFetchedAt,
                oiExpiresAt: !oiFromCache
                  ? oiExpiresAt
                  : latest15m.oiExpiresAt ?? oiExpiresAt,
                dataTimestamp: latest15m.dataTimestamp,
                ruleVersion: latest15m.ruleVersion ?? expectedRuleVersion,
                windowKey: latest15m.windowKey ?? activeWindowKey,
                expiresAt: latest15m.expiresAt,
                provenance: latest15m.provenance,
              });
            }

            const symPrewarmWaitMs = Math.max(0, Date.now() - symStartMs);
            const allWarm =
              k5m.fromCache &&
              k15m.fromCache &&
              k1h.fromCache &&
              k4h.fromCache &&
              oiFromCache;
            const rlWait = Math.max(
              k5m.slotWaitMs,
              k15m.slotWaitMs,
              k1h.slotWaitMs,
              k4h.slotWaitMs,
              oiSlotWaitMs
            );
            const httpLat = Math.max(
              k5m.httpLatencyMs,
              k15m.httpLatencyMs,
              k1h.httpLatencyMs,
              k4h.httpLatencyMs,
              oiHttpLatencyMs
            );

            symbolMetricsMap.set(symbol, {
              prewarmWaitMs: symPrewarmWaitMs,
              httpLatencyMs: httpLat,
              rateLimitWaitMs: rlWait,
              cacheHit: allWarm,
              cacheMiss: !allWarm,
            });
            this.db.updateSmcJobPrewarmWait(
              exchange,
              symbol,
              symPrewarmWaitMs
            );
            this.db.recordPrewarmTask({
              symbol,
              exchange,
              prewarmStartedAt: symStartedIso,
              prewarmCompletedAt: new Date().toISOString(),
              prewarmDurationMs: symPrewarmWaitMs,
              prewarmPriority: 'FAST_LANE',
              prewarmStatus: 'COMPLETED',
            });
          } catch {
            // Individual symbol prewarm failure will be handled when executeJob runs
            this.db.recordPrewarmTask({
              symbol,
              exchange,
              prewarmStartedAt: symStartedIso,
              prewarmCompletedAt: new Date().toISOString(),
              prewarmDurationMs: Math.max(0, Date.now() - symStartMs),
              prewarmPriority: 'FAST_LANE',
              prewarmStatus: 'PARTIAL',
            });
          } finally {
            inFlightSet.delete(symbol);
            this.activePrewarmWorkerCount = Math.max(
              0,
              this.activePrewarmWorkerCount - 1
            );
          }
        }
      };

      const workerCount = Math.min(
        maxPrewarmWorkers,
        symbolsNeedingNetworkPrewarm.length
      );
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(prewarmWorker());
      }
      await Promise.all(workers);

      const prewarmDurationMs = Math.max(0, Date.now() - prewarmStartMs);
      const prewarmCacheHitRate =
        totalChecks > 0
          ? Number(((totalCacheHits / totalChecks) * 100).toFixed(2))
          : 100;
      const completedAtIso = new Date().toISOString();
      this.db.recordPrewarmScanMeta(
        exchange,
        completedAtIso,
        prewarmDurationMs,
        prewarmCacheHitRate,
        isColdStart
      );

      const totalUniv =
        this.totalContractsByExchange.get(exchange) || allJobs.length;
      const cov = this.db.getCacheCoverageMetrics(
        exchange,
        totalUniv,
        false,
        expectedRuleVersion
      );
      this.db.savePrewarmSnapshot({
        snapshotId: `snap_${exchange}_${activeWindowKey}`,
        databaseInstanceId: this.db.databaseInstanceId,
        exchange,
        ruleVersion: expectedRuleVersion,
        windowKey: activeWindowKey,
        createdAt: completedAtIso,
        symbolCount: totalUniv,
        timeframeCoverage: {
          '5m': cov['5mCacheCoverage'],
          '15m': cov['15mCacheCoverage'],
          '1h': cov['1hCacheCoverage'],
          '4h': cov['4hCacheCoverage'],
        },
        oiFundingCoverage: {
          oiCoverage: cov.oiCacheCoverage,
          fundingCoverage: cov.fundingCacheCoverage,
        },
        freshUntil: new Date(
          Date.now() + (this.config.cacheTtlMsByTimeframe['5m'] ?? 300_000)
        ).toISOString(),
      });

      return {
        prewarmedSymbolCount: uniqueTargetSymbols.length,
        prewarmDurationMs,
        prewarmCacheHitRate,
        isColdStart,
      };
    } finally {
      this.isPrewarmingByExchange.set(exchange, false);
    }
  }

  public pauseScan(
    exchange = this.activeExchange,
    mode = this.activeMode
  ): SmcScanStatusResponse {
    this.workerState = 'PAUSED';
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    return this.getStatus(exchange, mode);
  }

  public resumeScan(
    exchange = this.activeExchange,
    mode = this.activeMode,
    autoProcessLoop = true
  ): SmcScanStatusResponse {
    this.activeExchange = exchange;
    this.activeMode = mode;
    this.workerState = 'RUNNING';
    if (autoProcessLoop) {
      this.scheduleNextTick(15);
    }
    return this.getStatus(exchange, mode);
  }

  public resume(
    exchange = this.activeExchange,
    mode = this.activeMode,
    autoProcessLoop = true
  ): SmcScanStatusResponse {
    return this.resumeScan(exchange, mode, autoProcessLoop);
  }

  /**
   * Phase 8 Fast Lane: Immediately enqueues (with deduplication) and optionally executes
   * a high-priority SMC deep evaluation for a single symbol without waiting for the 522-symbol queue,
   * while strictly enforcing `runningJobCount <= maxJobConcurrency` via reserved Fast Lane Worker slot.
   */
  public async priorityRefreshSymbol(params: {
    symbol: string;
    exchange: ExchangeId;
    mode: 'live' | 'demo';
    executeImmediately?: boolean;
    forceRefresh?: boolean;
    priorityTier?: SmcScanPriorityTier;
    priorityLabel?: string;
  }): Promise<{
    deduplicated: boolean;
    job: SmcScanJobRecord | null;
    result: SmcScanResultRecord | null;
    status: SmcScanStatusResponse;
  }> {
    const symbol = params.symbol.trim().toUpperCase();
    const exchange =
      params.mode === 'demo' ? 'demo_synthetic' : params.exchange;
    const activeWindowKey = this.resolveActiveWindowKey(exchange);
    const forceRefresh = params.forceRefresh ?? false;

    // Check if the symbol is already in the priority fast lane (RUNNING or QUEUED with fast-lane priority >= 999999)
    const existingJobs = this.db.listSmcScanJobs(exchange, 600);
    const activeFastLaneJob = existingJobs.find(
      (j) =>
        j.symbol === symbol &&
        (j.status === 'RUNNING' ||
          (j.status === 'QUEUED' && j.isFastLane === true && j.priority >= 999999))
    );

    let deduplicated = false;
    const nowIso = new Date().toISOString();

    if (activeFastLaneJob && !forceRefresh) {
      deduplicated = true;
    } else {
      // Check if there is a regular QUEUED job in the current window to upgrade to Fast Lane, or enqueue a fast-lane job
      const existingRegularQueued = existingJobs.find(
        (j) => j.symbol === symbol && j.status === 'QUEUED'
      );
      const targetWindowKey = forceRefresh
        ? `priority_${Date.now()}`
        : existingRegularQueued?.windowKey ?? activeWindowKey;

      const resolvedTier: SmcScanPriorityTier = params.priorityTier ?? 1;
      const resolvedFastLane = resolvedTier >= 1 && resolvedTier <= 5;
      const resolvedPriorityClass: SmcPriorityClass = resolvedFastLane
        ? 'FAST_LANE'
        : 'BULK';

      const enqRes = this.db.enqueueSmcScanJobs(
        [
          {
            symbol,
            exchange,
            priority: 999999,
            priorityTier: resolvedTier,
            priorityLabel: params.priorityLabel ?? '1_WATCHLIST',
            priorityClass: resolvedPriorityClass,
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey: targetWindowKey,
            requestedAt: nowIso,
            queueEnteredAt:
              existingRegularQueued?.queueEnteredAt ??
              existingRegularQueued?.requestedAt ??
              nowIso,
            startedAt: null,
            jobClaimedAt: null,
            smcEvaluationStartedAt: null,
            completedAt: null,
            smcEvaluationCompletedAt: null,
            queueWaitMs: null,
            prewarmWaitMs: 0,
            httpRequestLatencyMs: null,
            smcCalculationLatencyMs: null,
            dbWriteLatencyMs: null,
            smcEvaluationLatencyMs: null,
            rateLimitWaitMs: null,
            detectionLatencyMs: null,
            cacheHit: false,
            cacheMiss: false,
            reusedCache: false,
            workerRole: 'FAST_LANE',
            executionWorker: 'FAST_LANE_WORKER',
            isFastLane: resolvedFastLane,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        ],
        true,
        false
      );
      if (enqRes.enqueuedCount === 0 && enqRes.skippedDuplicateCount > 0) {
        deduplicated = true;
      }
    }

    if (params.executeImmediately !== false) {
      const strictMaxConcurrency = Math.max(1, this.config.maxJobConcurrency);
      let claimed: SmcScanJobRecord[] = [];
      for (let attempt = 0; attempt < 25; attempt++) {
        claimed = this.db.claimNextSmcScanJobs(
          exchange,
          1,
          new Date().toISOString(),
          {
            maxConcurrency: strictMaxConcurrency,
            workerId: `${this.workerId}-fastlane`,
            workerRole: 'FAST_LANE',
            leaseDurationMs: 60_000,
            priorityAgeMs: this.config.priorityAgeMs,
            preferredSymbol: symbol,
          }
        );
        if (claimed.length > 0) break;
        // If all worker slots are momentarily busy, wait briefly for a slot to free up without exceeding maxJobConcurrency
        const currentSymbolJob = this.db
          .listSmcScanJobs(exchange, 600)
          .find((j) => j.symbol === symbol);
        if (currentSymbolJob?.status === 'SUCCEEDED') break;
        await new Promise((r) => setTimeout(r, 15));
      }

      const targetJob =
        claimed.find((j) => j.symbol === symbol) ?? claimed[0] ?? null;
      if (targetJob) {
        this.activeConcurrency++;
        if (this.activeConcurrency > this.maxActiveConcurrencyObserved) {
          this.maxActiveConcurrencyObserved = this.activeConcurrency;
        }
        const currentDbRunning =
          this.db.getSmcScanQueueStats(exchange).runningJobCount;
        if (currentDbRunning > this.maxRunningJobCountObserved) {
          this.maxRunningJobCountObserved = currentDbRunning;
        }
        try {
          await this.executeJob(targetJob, params.mode, forceRefresh);
          this.db.recordPriorityScanMeta(
            exchange,
            new Date().toISOString(),
            targetJob.smcEvaluationLatencyMs ?? 0,
            true
          );
        } finally {
          this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
        }
      }
    } else if (this.workerState === 'RUNNING') {
      this.scheduleNextTick(5);
    }

    const updatedJobs = this.db.listSmcScanJobs(exchange, 600);
    const job = updatedJobs.find((j) => j.symbol === symbol) ?? null;
    const result = this.db.getSmcScanResult(exchange, symbol);
    return {
      deduplicated,
      job,
      result,
      status: this.getStatus(exchange, params.mode),
    };
  }

  /**
   * Enqueues and immediately processes (or prioritizes) a single symbol refresh
   */
  public async refreshSingleSymbol(params: {
    symbol: string;
    exchange: ExchangeId;
    mode: 'live' | 'demo';
    executeImmediately?: boolean;
  }): Promise<{
    job: SmcScanJobRecord | null;
    result: SmcScanResultRecord | null;
    status: SmcScanStatusResponse;
  }> {
    const res = await this.priorityRefreshSymbol({
      ...params,
      forceRefresh: true,
    });
    return {
      job: res.job,
      result: res.result,
      status: res.status,
    };
  }

  /**
   * Processes one batch (up to batchSize jobs, strictly respecting maxConcurrency).
   * Phase 8 Section 三 & 四:
   * - Splits workers into `Fast Lane Worker` (`FAST_LANE`) and `Bulk Worker` (`BULK`), reserving at least 1 slot for Fast Lane.
   * - Enforces anti-starvation (`maxFastLaneBurst`, `bulkReservation`, `priorityAgeMs`) so Fast Lane never starves Bulk indefinitely.
   * - Strictly enforces `runningJobCount <= maxConcurrency` in SQLite.
   */
  public async processNextBatch(
    exchange = this.activeExchange,
    mode = this.activeMode,
    maxJobsToClaim?: number
  ): Promise<number> {
    if (this.isProcessingTick) return 0;
    this.isProcessingTick = true;

    try {
      const availableRequests = this.getAvailableRequests();
      const maxJobsByRateLimit = Math.floor(availableRequests / 4);
      if (maxJobsByRateLimit <= 0) {
        return 0;
      }

      const maxBatchJobs = Math.min(
        maxJobsToClaim ?? this.config.batchSize,
        this.config.batchSize,
        maxJobsByRateLimit
      );
      if (maxBatchJobs <= 0) {
        return 0;
      }

      const concurrency = Math.max(1, this.config.maxConcurrency);
      const fastLaneSlots = Math.min(
        concurrency,
        Math.max(1, this.config.fastLaneWorkerSlots ?? 1)
      );
      let claimedInBatch = 0;
      let processedCount = 0;

      const workerTask = async (role: SmcWorkerRole, slotIndex: number) => {
        while (claimedInBatch < maxBatchJobs) {
          if (this.workerState === 'PAUSED') break;

          // Never allow Tier 6 Bulk worker to claim Bulk tasks while Fast Lane priority cache prewarm is running
          if (
            role === 'BULK' &&
            this.isPrewarmingByExchange.get(exchange) === true
          ) {
            break;
          }

          // Anti-starvation check: after maxFastLaneBurst consecutive Fast Lane jobs, reserve bulkReservation slots for Bulk
          const maxBurst = this.config.maxFastLaneBurst ?? 8;
          if (this.consecutiveFastLaneJobs >= maxBurst) {
            this.remainingBulkReservationJobs = Math.max(
              1,
              this.config.bulkReservation ?? 1
            );
            this.consecutiveFastLaneJobs = 0;
          }
          const forceBulkAntiStarvation =
            this.remainingBulkReservationJobs > 0;

          const nowIso = new Date().toISOString();
          const claimed = this.db.claimNextSmcScanJobs(exchange, 1, nowIso, {
            maxConcurrency: concurrency,
            workerId: `${this.workerId}-${role.toLowerCase()}-${slotIndex}`,
            workerRole: role,
            leaseDurationMs: 60_000,
            priorityAgeMs: this.config.priorityAgeMs,
            forceBulkAntiStarvation,
          });

          if (claimed.length === 0) {
            break;
          }
          claimedInBatch += claimed.length;

          const job = claimed[0];
          const isFastJob =
            job.priorityTier >= 1 &&
            job.priorityTier <= 5 &&
            job.priorityClass === 'FAST_LANE';
          if (isFastJob) {
            this.consecutiveFastLaneJobs++;
          } else {
            this.consecutiveFastLaneJobs = 0;
            if (this.remainingBulkReservationJobs > 0) {
              this.remainingBulkReservationJobs--;
            }
          }

          this.activeConcurrency++;
          if (this.activeConcurrency > this.maxActiveConcurrencyObserved) {
            this.maxActiveConcurrencyObserved = this.activeConcurrency;
          }

          const currentDbRunning =
            this.db.getSmcScanQueueStats(exchange).runningJobCount;
          if (currentDbRunning > this.maxRunningJobCountObserved) {
            this.maxRunningJobCountObserved = currentDbRunning;
          }

          try {
            await this.executeJob(job, mode, false);
            processedCount++;
          } finally {
            this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
          }
        }
      };

      const workerCount = Math.min(concurrency, maxBatchJobs);
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < workerCount; i++) {
        const assignedRole: SmcWorkerRole =
          i < fastLaneSlots ? 'FAST_LANE' : 'BULK';
        workers.push(workerTask(assignedRole, i));
      }
      await Promise.all(workers);

      if (processedCount === 0) {
        const postStats = this.db.getSmcScanQueueStats(exchange);
        if (
          postStats.queuedCount === 0 &&
          postStats.runningJobCount === 0 &&
          postStats.rateLimitedCount === 0 &&
          this.workerState === 'RUNNING'
        ) {
          this.workerState = 'IDLE';
        }
      }

      return processedCount;
    } finally {
      this.isProcessingTick = false;
    }
  }

  private scheduleNextTick(delayMs = 250): void {
    if (this.workerState !== 'RUNNING') return;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
    }
    this.loopTimer = setTimeout(async () => {
      this.loopTimer = null;
      if (this.workerState !== 'RUNNING') return;
      let targetExchange = this.activeExchange;
      let targetMode = this.activeMode;
      const currentStats = this.db.getSmcScanQueueStats(targetExchange);
      if (
        targetExchange === 'demo_synthetic' &&
        currentStats.queuedCount === 0 &&
        currentStats.rateLimitedCount === 0
      ) {
        const liveStats = this.db.getSmcScanQueueStats('binance_usdm');
        if (liveStats.queuedCount > 0 || liveStats.rateLimitedCount > 0) {
          targetExchange = 'binance_usdm';
          targetMode = 'live';
          this.activeExchange = 'binance_usdm';
          this.activeMode = 'live';
        }
      }
      const processed = await this.processNextBatch(targetExchange, targetMode);
      const stats = this.db.getSmcScanQueueStats(targetExchange);
      if (
        this.workerState === 'RUNNING' &&
        (stats.queuedCount > 0 || stats.rateLimitedCount > 0 || processed > 0)
      ) {
        const available = this.getAvailableRequests();
        const nextDelay =
          available < 4 ? 1000 : stats.queuedCount > 0 ? 10 : 250;
        this.scheduleNextTick(nextDelay);
      } else if (
        stats.queuedCount === 0 &&
        stats.runningJobCount === 0 &&
        stats.rateLimitedCount === 0
      ) {
        this.workerState = 'IDLE';
      }
    }, delayMs);
  }

  private getAvailableRequests(nowMs = Date.now()): number {
    while (
      this.requestTimestamps.length > 0 &&
      nowMs - this.requestTimestamps[0] >= 60_000
    ) {
      this.requestTimestamps.shift();
    }
    return Math.max(
      0,
      this.config.maxRequestsPerMinute - this.requestTimestamps.length
    );
  }

  private canIssueRequest(requiredRequests = 1, nowMs = Date.now()): boolean {
    return this.getAvailableRequests(nowMs) >= requiredRequests;
  }

  private recordRequestIssued(
    nowMs = Date.now(),
    exchange = this.activeExchange
  ): void {
    this.requestTimestamps.push(nowMs);
    this.getAvailableRequests(nowMs);
    this.db.updateRuntimeHttpMetrics(exchange, {
      incrementCompletedHttpRequests: 1,
      currentRequestsInWindow: this.requestTimestamps.length,
      maxHttpConcurrency: this.config.maxHttpConcurrency,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
    });
  }

  private async acquireHttpSlot(): Promise<number> {
    const maxHttp = Math.max(1, this.config.maxHttpConcurrency);
    if (this.inFlightRequestCount < maxHttp) {
      this.inFlightRequestCount++;
      if (this.inFlightRequestCount > this.maxInFlightRequestCountObserved) {
        this.maxInFlightRequestCountObserved = this.inFlightRequestCount;
      }
      return 0;
    }
    const waitStart = Date.now();
    await new Promise<void>((resolve) => {
      this.httpWaitQueue.push(resolve);
    });
    const waitedMs = Math.max(0, Date.now() - waitStart);
    this.inFlightRequestCount++;
    if (this.inFlightRequestCount > this.maxInFlightRequestCountObserved) {
      this.maxInFlightRequestCountObserved = this.inFlightRequestCount;
    }
    return waitedMs;
  }

  private releaseHttpSlot(): void {
    this.inFlightRequestCount = Math.max(0, this.inFlightRequestCount - 1);
    const next = this.httpWaitQueue.shift();
    if (next) {
      next();
    }
  }

  private async fetchOrGetCachedTimeframe(
    adapter: ExchangeAdapter,
    exchange: ExchangeId,
    symbol: string,
    timeframe: Timeframe,
    forceRefresh: boolean
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
    fromCache: boolean;
    httpLatencyMs: number;
    slotWaitMs: number;
  }> {
    const nowMs = Date.now();
    const expectedRuleVersion =
      this.activeRuleVersionByExchange.get(exchange) ?? SMC_RULE_VERSION;
    const cached = this.db.getSmcCandlesCache(
      exchange,
      symbol,
      timeframe,
      nowMs,
      { expectedRuleVersion }
    );

    if (
      !forceRefresh &&
      cached &&
      !cached.isExpired &&
      cached.klines.length > 0 &&
      !cached.provenance.stale &&
      !cached.provenance.fallback &&
      cached.provenance.missingData.length === 0
    ) {
      this.runtimeCacheHitsByExchange.set(
        exchange,
        (this.runtimeCacheHitsByExchange.get(exchange) ?? 0) + 1
      );
      return {
        klines: cached.klines,
        provenance: cached.provenance,
        fromCache: true,
        httpLatencyMs: 0,
        slotWaitMs: 0,
      };
    }

    // Deduplicate concurrent multi-timeframe requests for the exact same (exchange, symbol, timeframe)
    const inflightKey = `${exchange}:${symbol}:${timeframe}`;
    const existingPromise = this.inFlightTimeframePromises.get(inflightKey);
    if (existingPromise && !forceRefresh) {
      return existingPromise;
    }

    const fetchPromise = (async () => {
      this.runtimeCacheMissesByExchange.set(
        exchange,
        (this.runtimeCacheMissesByExchange.get(exchange) ?? 0) + 1
      );

      if (!this.canIssueRequest(1, Date.now())) {
        throw new ExchangeApiUnavailableError(
          `SMC Queue rate limit guard (${this.config.maxRequestsPerMinute} req/min) reached while fetching ${symbol} ${timeframe}`,
          adapter.displayName,
          429,
          { isRateLimited: true }
        );
      }

      // Phase 9 Section 六: Incremental Kline Append when valid prior confirmed klines already exist in SQLite cache
      const priorConfirmedKlines =
        !forceRefresh &&
        cached &&
        !cached.provenance.fallback &&
        cached.provenance.missingData.length === 0 &&
        (!cached.ruleVersion || cached.ruleVersion === expectedRuleVersion)
          ? cached.klines.filter((k) => k.isClosed)
          : [];
      const canUseIncrementalFetch = priorConfirmedKlines.length >= 45;
      const fetchLimit = canUseIncrementalFetch ? 20 : 60;

      const slotWaitMs = await this.acquireHttpSlot();
      const httpStartMs = Date.now();
      this.recordRequestIssued(httpStartMs, exchange);

      let res: { klines: Kline[]; provenance: DataProvenance };
      let httpLatencyMs = 0;
      try {
        res = await adapter.fetchKlines(symbol, timeframe, fetchLimit);
        httpLatencyMs = Math.max(0, Date.now() - httpStartMs);
      } finally {
        this.releaseHttpSlot();
      }

      // Merge prior confirmed klines with newly fetched confirmed klines by openTime when incremental append is active
      const closedFetched = res.klines.filter((k) => k.isClosed);
      let mergedKlines = closedFetched.slice(-60);
      if (priorConfirmedKlines.length > 0 && closedFetched.length > 0) {
        const byOpenTime = new Map<number, Kline>();
        for (const k of priorConfirmedKlines) {
          if (k.isClosed) {
            byOpenTime.set(k.openTime, k);
          }
        }
        for (const k of closedFetched) {
          byOpenTime.set(k.openTime, k);
        }
        mergedKlines = Array.from(byOpenTime.values())
          .sort((a, b) => a.openTime - b.openTime)
          .slice(-60);
      }

      const ttlMs =
        this.config.cacheTtlMsByTimeframe[timeframe] ?? 10 * 60 * 1000;
      const refNowMs = Math.max(
        Date.now(),
        Date.parse(res.provenance.fetchedAt) || Date.now()
      );
      const expiresAt = new Date(refNowMs + ttlMs).toISOString();
      const existingCache =
        cached ?? this.db.getSmcCandlesCache(exchange, symbol, timeframe);
      const ticker = this.latestTickerMapByExchange.get(exchange)?.get(symbol);
      const closedKlines = mergedKlines.filter((k) => k.isClosed);
      const latestClosed =
        closedKlines.length > 0
          ? closedKlines[closedKlines.length - 1]
          : mergedKlines[mergedKlines.length - 1];
      const dataTimestamp = latestClosed ? latestClosed.closeTime : refNowMs;
      const activeWindowKey = this.resolveActiveWindowKey(exchange);

      const oiFetchedIso =
        existingCache?.oiFetchedAt ??
        (ticker?.openInterest !== null && ticker?.openInterest !== undefined
          ? res.provenance.fetchedAt
          : null);
      const oiExpiresIso =
        existingCache?.oiExpiresAt ??
        (ticker?.openInterest !== null && ticker?.openInterest !== undefined
          ? new Date(
              refNowMs + (this.config.oiCacheTtlMs ?? 900_000)
            ).toISOString()
          : null);
      const resolvedOi =
        existingCache?.openInterest ?? ticker?.openInterest ?? null;
      const resolvedOiVal =
        existingCache?.openInterestValue ??
        ticker?.openInterestValue ??
        (resolvedOi !== null && ticker?.lastPrice
          ? resolvedOi * ticker.lastPrice
          : null);

      this.db.saveSmcCandlesCache({
        symbol,
        exchange,
        timeframe,
        klines: mergedKlines,
        openInterest: resolvedOi,
        openInterestValue: resolvedOiVal,
        fundingRate: ticker?.fundingRate ?? existingCache?.fundingRate ?? null,
        nextFundingTime:
          ticker?.nextFundingTime ?? existingCache?.nextFundingTime ?? null,
        oiFetchedAt: oiFetchedIso,
        oiExpiresAt: oiExpiresIso,
        dataTimestamp,
        ruleVersion: expectedRuleVersion,
        windowKey: activeWindowKey,
        expiresAt,
        provenance: res.provenance,
      });

      return {
        klines: mergedKlines,
        provenance: res.provenance,
        fromCache: false,
        httpLatencyMs,
        slotWaitMs,
      };
    })();

    this.inFlightTimeframePromises.set(inflightKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.inFlightTimeframePromises.delete(inflightKey);
    }
  }

  private async executeJob(
    job: SmcScanJobRecord,
    mode: 'live' | 'demo',
    forceRefresh: boolean
  ): Promise<void> {
    const { symbol, exchange } = job;
    const adapter = this.adapters[exchange] ?? this.adapters.binance_usdm;
    const ticker = this.latestTickerMapByExchange.get(exchange)?.get(symbol);
    const preCandidate = this.latestCandidateMapByExchange
      .get(exchange)
      ?.get(symbol);

    const evalStartMs = Date.now();
    const smcEvaluationStartedAt =
      job.smcEvaluationStartedAt ?? new Date(evalStartMs).toISOString();
    const jobClaimedAt = job.jobClaimedAt ?? smcEvaluationStartedAt;
    const queueEnteredAt =
      job.queueEnteredAt ?? job.requestedAt ?? smcEvaluationStartedAt;
    const queueEnteredAtMs = Date.parse(queueEnteredAt);
    const queueWaitMs =
      job.queueWaitMs ??
      (Number.isFinite(queueEnteredAtMs)
        ? Math.max(0, evalStartMs - queueEnteredAtMs)
        : 0);

    try {
      if (job.id !== undefined) {
        this.db.heartbeatSmcJob(job.id, this.workerId);
      }

      // Check cached OI before parallelizing 4-TF + OI fetch
      const cached15mBefore = this.db.getSmcCandlesCache(exchange, symbol, '15m');
      const nowMsForOi = Date.now();
      const isCachedOiFresh =
        !forceRefresh &&
        cached15mBefore?.openInterest !== null &&
        cached15mBefore?.openInterest !== undefined &&
        (!cached15mBefore.oiExpiresAt ||
          Date.parse(cached15mBefore.oiExpiresAt) > nowMsForOi);

      let openInterest: number | null = isCachedOiFresh
        ? cached15mBefore!.openInterest
        : ticker?.openInterest ??
          preCandidate?.openInterest ??
          cached15mBefore?.openInterest ??
          null;
      let openInterestValue: number | null =
        cached15mBefore?.openInterestValue ??
        ticker?.openInterestValue ??
        preCandidate?.openInterestValue ??
        (openInterest !== null && ticker?.lastPrice
          ? openInterest * ticker.lastPrice
          : null);
      let oiProvenance: DataProvenance | undefined = undefined;
      let oiHttpLatencyMs = 0;
      let oiSlotWaitMs = 0;
      let oiFromCache = isCachedOiFresh;

      const isOiExpired =
        Boolean(cached15mBefore?.oiExpiresAt) &&
        Date.parse(cached15mBefore!.oiExpiresAt!) <= nowMsForOi;
      const shouldFetchOi =
        forceRefresh || openInterest === null || isOiExpired;

      const fetchOiParallel = async () => {
        if (!shouldFetchOi) {
          return;
        }
        if (!this.canIssueRequest(1)) {
          return;
        }
        try {
          oiSlotWaitMs = await this.acquireHttpSlot();
          const oiStartMs = Date.now();
          this.recordRequestIssued(oiStartMs, exchange);
          try {
            const oiRes = await adapter.fetchOpenInterest(
              symbol,
              ticker?.lastPrice
            );
            oiHttpLatencyMs = Math.max(0, Date.now() - oiStartMs);
            openInterest = oiRes.openInterest;
            openInterestValue = oiRes.openInterestValue;
            oiProvenance = oiRes.provenance;
            oiFromCache = false;
            if (openInterest !== null && ticker) {
              ticker.openInterest = openInterest;
            }
          } finally {
            this.releaseHttpSlot();
          }
        } catch {
          // OI is optional if endpoint fails; missingData will record it
        }
      };

      const httpPhaseStartMs = Date.now();
      // Parallelize 5m, 15m, 1h, 4h kline fetches AND Open Interest fetch concurrently
      const settledTf = await Promise.allSettled([
        this.fetchOrGetCachedTimeframe(
          adapter,
          exchange,
          symbol,
          '5m',
          forceRefresh
        ),
        this.fetchOrGetCachedTimeframe(
          adapter,
          exchange,
          symbol,
          '15m',
          forceRefresh
        ),
        this.fetchOrGetCachedTimeframe(
          adapter,
          exchange,
          symbol,
          '1h',
          forceRefresh
        ),
        this.fetchOrGetCachedTimeframe(
          adapter,
          exchange,
          symbol,
          '4h',
          forceRefresh
        ),
        fetchOiParallel(),
      ]);
      for (const item of settledTf) {
        if (item.status === 'rejected') {
          throw item.reason;
        }
      }
      const k5m = (
        settledTf[0] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof this.fetchOrGetCachedTimeframe>>
        >
      ).value;
      const k15m = (
        settledTf[1] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof this.fetchOrGetCachedTimeframe>>
        >
      ).value;
      const k1h = (
        settledTf[2] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof this.fetchOrGetCachedTimeframe>>
        >
      ).value;
      const k4h = (
        settledTf[3] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof this.fetchOrGetCachedTimeframe>>
        >
      ).value;
      const httpWallMs = Math.max(0, Date.now() - httpPhaseStartMs);

      // Persist updated OI into 15m cache row if newly fetched or resolved from ticker
      if (openInterest !== null) {
        const latest15mCache = this.db.getSmcCandlesCache(
          exchange,
          symbol,
          '15m'
        );
        if (latest15mCache) {
          const oiRefNowMs = Math.max(
            Date.now(),
            Date.parse(latest15mCache.provenance.fetchedAt) || Date.now()
          );
          const oiFetchedAt =
            !oiFromCache || !latest15mCache.oiFetchedAt
              ? new Date(oiRefNowMs).toISOString()
              : latest15mCache.oiFetchedAt;
          const oiExpiresAt =
            !oiFromCache || !latest15mCache.oiExpiresAt
              ? new Date(
                  oiRefNowMs + (this.config.oiCacheTtlMs ?? 900_000)
                ).toISOString()
              : latest15mCache.oiExpiresAt;
          this.db.saveSmcCandlesCache({
            symbol,
            exchange,
            timeframe: '15m',
            klines: latest15mCache.klines,
            openInterest,
            openInterestValue:
              openInterestValue ?? latest15mCache.openInterestValue ?? null,
            fundingRate:
              ticker?.fundingRate ?? latest15mCache.fundingRate ?? null,
            nextFundingTime:
              ticker?.nextFundingTime ?? latest15mCache.nextFundingTime ?? null,
            oiFetchedAt,
            oiExpiresAt,
            dataTimestamp: latest15mCache.dataTimestamp,
            ruleVersion: latest15mCache.ruleVersion,
            windowKey: latest15mCache.windowKey,
            expiresAt: latest15mCache.expiresAt,
            provenance: latest15mCache.provenance,
          });
        }
      }

      const anyHttpFetched =
        !k5m.fromCache ||
        !k15m.fromCache ||
        !k1h.fromCache ||
        !k4h.fromCache ||
        !oiFromCache;
      const anyFromCache =
        k5m.fromCache ||
        k15m.fromCache ||
        k1h.fromCache ||
        k4h.fromCache ||
        oiFromCache;
      const allKlinesFromCache =
        k5m.fromCache && k15m.fromCache && k1h.fromCache && k4h.fromCache;

      const cacheHit = allKlinesFromCache || anyFromCache;
      const cacheMiss = !allKlinesFromCache;
      const reusedCache = anyFromCache;

      const rateLimitWaitMs = Math.max(
        k5m.slotWaitMs,
        k15m.slotWaitMs,
        k1h.slotWaitMs,
        k4h.slotWaitMs,
        oiSlotWaitMs
      );
      const httpRequestLatencyMs = anyHttpFetched
        ? Math.max(0, httpWallMs - rateLimitWaitMs)
        : 0;

      const smcCalcStartMs = Date.now();

      // Record confirmed 15m klines into historical_volume_samples collector (only isClosed === true)
      if (mode === 'live' && k15m.klines.length > 0) {
        this.db.recordConfirmedKlineVolumes(
          exchange,
          symbol,
          k15m.klines,
          k15m.provenance,
          '15m'
        );
      }

      // Strictly use ONLY the 30 confirmed 15m K-lines prior to the current confirmed 15m K-line
      const confirmed15mKlines = k15m.klines.filter((k) => k.isClosed);
      const confirmed15mVols = confirmed15mKlines.map((k) => k.quoteVolume);

      const extractedWindow =
        confirmed15mVols.length > 0
          ? extractPriorConfirmedBaselineWindow(
              confirmed15mVols,
              confirmed15mVols.length - 1,
              MIN_HISTORY_SAMPLES
            )
          : { currentVolume: null, historicalVolumes: [] };

      const histVol = evaluateHistoricalVolumeAnomaly({
        symbol,
        exchange,
        currentVolume: extractedWindow.currentVolume,
        historicalVolumes: extractedWindow.historicalVolumes,
        volumeTimeframe: '15m',
        baseProvenance: k15m.provenance,
      });

      const isCachedFundingFresh =
        !forceRefresh &&
        cached15mBefore?.fundingRate !== null &&
        cached15mBefore?.fundingRate !== undefined &&
        (!cached15mBefore.nextFundingTime ||
          nowMsForOi < Number(cached15mBefore.nextFundingTime));
      const resolvedFundingRate =
        ticker?.fundingRate !== null && ticker?.fundingRate !== undefined
          ? ticker.fundingRate
          : isCachedFundingFresh
            ? cached15mBefore!.fundingRate
            : null;

      const combinedMissingData = [
        ...new Set([
          ...(ticker?.provenance.missingData ?? []),
          ...k5m.provenance.missingData,
          ...k15m.provenance.missingData,
          ...k1h.provenance.missingData,
          ...k4h.provenance.missingData,
          ...((oiProvenance as DataProvenance | undefined)?.missingData ?? []),
          ...(openInterest === null ? ['openInterest'] : []),
          ...(resolvedFundingRate === null ? ['fundingRate'] : []),
        ]),
      ];

      const dataFetchedAt =
        k15m.provenance.fetchedAt || new Date().toISOString();
      const stale =
        k5m.provenance.stale ||
        k15m.provenance.stale ||
        k1h.provenance.stale ||
        k4h.provenance.stale;
      const fallback =
        k5m.provenance.fallback ||
        k15m.provenance.fallback ||
        k1h.provenance.fallback ||
        k4h.provenance.fallback;

      const combinedProvenance: DataProvenance = {
        source: k15m.provenance.source,
        fetchedAt: dataFetchedAt,
        stale,
        fallback,
        missingData: combinedMissingData,
        isDemo: adapter.isDemo,
        volumeTimeframe: '15m',
        aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
        volumeMetric: 'quoteVolume',
      };

      const isLowLiquidity =
        preCandidate?.isLowLiquidity ??
        (ticker ? ticker.quoteVolume24h < 15_000_000 : false);
      const extremeFunding =
        preCandidate?.extremeFunding ??
        (ticker && ticker.fundingRate !== null
          ? Math.abs(ticker.fundingRate) >= 0.0005
          : false);
      const lowLiquidityHighVolatility =
        preCandidate?.lowLiquidityHighVolatility ??
        (isLowLiquidity &&
          ticker !== undefined &&
          Math.abs(ticker.priceChangePercent24h) >= 12.0);

      const smcAnalysis = evaluateSmcStructure({
        symbol,
        primaryTimeframe: '15m',
        klinesByTimeframe: {
          '5m': k5m.klines,
          '15m': k15m.klines,
          '1h': k1h.klines,
          '4h': k4h.klines,
        },
        openInterest,
        historicalVolume: histVol,
        isLowLiquidity,
        extremeFunding,
        lowLiquidityHighVolatility,
        requireFullMultiTimeframe: true,
        provenance: combinedProvenance,
      });

      let marketRadarCategory =
        preCandidate?.marketRadarCategory ??
        (smcAnalysis.actionState === 'LONG CANDIDATE'
          ? '雷達多頭觀察'
          : smcAnalysis.actionState === 'SHORT CANDIDATE'
            ? '雷達空頭觀察'
            : ticker
              ? ticker.priceChangePercent24h >= 0
                ? '雷達多頭觀察'
                : '雷達空頭觀察'
              : '準備觀察');

      const historyGatePassed =
        histVol.status === 'READY' &&
        !histVol.baselineUnstable &&
        histVol.sampleCount >= MIN_HISTORY_SAMPLES;

      let finalTradeSignal: FinalTradeSignal = 'NONE';
      if (
        smcAnalysis.smcEvaluationStatus === 'EVALUATED' &&
        smcAnalysis.actionState === 'LONG CANDIDATE' &&
        !isLowLiquidity &&
        !extremeFunding &&
        !lowLiquidityHighVolatility &&
        historyGatePassed &&
        !stale &&
        !fallback &&
        combinedMissingData.length === 0 &&
        smcAnalysis.waitReasons.length === 0
      ) {
        if (marketRadarCategory === '雷達空頭觀察') {
          smcAnalysis.actionState = 'WATCH';
          smcAnalysis.waitReasons.push(
            '第一層市場雷達方向為空頭觀察，與多頭 SMC 結構方向不一致'
          );
        } else {
          marketRadarCategory = '雷達多頭觀察';
          finalTradeSignal = '多頭交易候選';
        }
      } else if (
        smcAnalysis.smcEvaluationStatus === 'EVALUATED' &&
        smcAnalysis.actionState === 'SHORT CANDIDATE' &&
        !isLowLiquidity &&
        !extremeFunding &&
        !lowLiquidityHighVolatility &&
        historyGatePassed &&
        !stale &&
        !fallback &&
        combinedMissingData.length === 0 &&
        smcAnalysis.waitReasons.length === 0
      ) {
        if (marketRadarCategory === '雷達多頭觀察') {
          smcAnalysis.actionState = 'WATCH';
          smcAnalysis.waitReasons.push(
            '第一層市場雷達方向為多頭觀察，與空頭 SMC 結構方向不一致'
          );
        } else {
          marketRadarCategory = '雷達空頭觀察';
          finalTradeSignal = '空頭交易候選';
        }
      } else if (
        smcAnalysis.actionState === 'LONG CANDIDATE' ||
        smcAnalysis.actionState === 'SHORT CANDIDATE'
      ) {
        // Ensure smcActionState is never saved as CANDIDATE if finalTradeSignal is NONE
        smcAnalysis.actionState = 'WATCH';
        if (smcAnalysis.waitReasons.length === 0) {
          smcAnalysis.waitReasons.push(
            '雙層交易候選資格閘門未完全通過，降級為 WATCH'
          );
        }
      }

      const smcCalculationLatencyMs = Math.max(0, Date.now() - smcCalcStartMs);
      const dbWriteStartMs = Date.now();

      const evalEndMs = Date.now();
      const evaluatedAt = new Date(evalEndMs).toISOString();
      const smcEvaluationCompletedAt = evaluatedAt;
      const smcEvaluationLatencyMs = Math.max(0, evalEndMs - evalStartMs);

      const lastConfirmed15m =
        confirmed15mKlines.length > 0
          ? confirmed15mKlines[confirmed15mKlines.length - 1]
          : null;
      const signalBarOpenTime = lastConfirmed15m
        ? lastConfirmed15m.openTime
        : null;
      const signalBarCloseTime = lastConfirmed15m
        ? lastConfirmed15m.closeTime
        : null;
      const explicitNext15mBar = lastConfirmed15m
        ? k15m.klines.find((k) => k.openTime > lastConfirmed15m.openTime)
        : null;
      const nextBarOpenTime = lastConfirmed15m
        ? explicitNext15mBar
          ? explicitNext15mBar.openTime
          : Math.max(
              lastConfirmed15m.closeTime + 1,
              lastConfirmed15m.openTime + 15 * 60 * 1000
            )
        : null;

      const isCandidateSignal =
        smcAnalysis.actionState === 'LONG CANDIDATE' ||
        smcAnalysis.actionState === 'SHORT CANDIDATE' ||
        finalTradeSignal !== 'NONE';
      let rawDetectionLatencyMs = Math.max(
        0,
        Number.isFinite(queueEnteredAtMs)
          ? evalEndMs - queueEnteredAtMs
          : smcEvaluationLatencyMs
      );
      if (
        lastConfirmed15m &&
        evalEndMs >= lastConfirmed15m.closeTime &&
        Number.isFinite(queueEnteredAtMs) &&
        Math.abs(queueEnteredAtMs - lastConfirmed15m.closeTime) <= 60_000
      ) {
        rawDetectionLatencyMs = Math.max(
          0,
          evalEndMs - lastConfirmed15m.closeTime
        );
      }

      let entryWindowStatus:
        | 'DETECTED_BEFORE_NEXT_BAR_OPEN'
        | 'ENTRY_WINDOW_MISSED'
        | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
      if (isCandidateSignal && nextBarOpenTime !== null) {
        if (evalEndMs < nextBarOpenTime) {
          entryWindowStatus = 'DETECTED_BEFORE_NEXT_BAR_OPEN';
        } else {
          entryWindowStatus = 'ENTRY_WINDOW_MISSED';
        }
      }

      const evaluationLatencyMs = smcEvaluationLatencyMs;
      const nextBarRemainingMs =
        nextBarOpenTime !== null
          ? Math.max(0, Math.round(nextBarOpenTime - evalEndMs))
          : null;
      const candidateDetectionLatencyMs = isCandidateSignal
        ? rawDetectionLatencyMs
        : null;
      const detectionLatencyMs = rawDetectionLatencyMs;
      const entryWindowDelayMs =
        isCandidateSignal && nextBarOpenTime !== null
          ? Math.round(evalEndMs - nextBarOpenTime)
          : null;
      const isEntryMissed = entryWindowStatus === 'ENTRY_WINDOW_MISSED';
      const entryWindowMissed: boolean | null = isCandidateSignal
        ? isEntryMissed
        : null;
      const missingGates =
        smcAnalysis.missingGates ??
        smcAnalysis.gateEvaluation?.missingGates ??
        [];
      const nearMissStatus =
        smcAnalysis.actionState === 'LONG CANDIDATE' ||
        smcAnalysis.actionState === 'SHORT CANDIDATE'
          ? 'NOT_NEAR_CANDIDATE'
          : smcAnalysis.nearMissStatus ??
            smcAnalysis.gateEvaluation?.nearMissStatus ??
            (missingGates.length === 1
              ? 'NEAR_MISS_ONE_GATE'
              : missingGates.length === 2
                ? 'NEAR_MISS_TWO_GATES'
                : 'NOT_NEAR_CANDIDATE');

      const isNearMissOrCandidate =
        isCandidateSignal ||
        nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
        nearMissStatus === 'NEAR_MISS_TWO_GATES';

      // Phase 8 Section 一 & Phase 18 Section 四: Strictly separate priorityClass (Tier 1..5 or Candidate/Near-Miss => FAST_LANE)
      const effectivePriorityTier: SmcScanPriorityTier =
        job.priorityTier >= 1 && job.priorityTier <= 5
          ? job.priorityTier
          : isNearMissOrCandidate
            ? 4
            : 6;
      const isFastLane =
        effectivePriorityTier >= 1 && effectivePriorityTier <= 5;
      const priorityClass: SmcPriorityClass = isFastLane
        ? 'FAST_LANE'
        : 'BULK';
      const workerRole: SmcWorkerRole =
        job.workerRole ?? (isFastLane ? 'FAST_LANE' : 'BULK');
      const executionWorker: SmcExecutionWorker =
        job.executionWorker ??
        (workerRole === 'FAST_LANE' ? 'FAST_LANE_WORKER' : 'BULK_WORKER');

      const prewarmSymbolMetric = this.prewarmMetricsByExchangeSymbol
        .get(exchange)
        ?.get(symbol);
      const prewarmWaitMs = Math.max(
        0,
        Math.round(job.prewarmWaitMs ?? prewarmSymbolMetric?.prewarmWaitMs ?? 0)
      );

      const paperEligibilityStatus: 'ELIGIBLE' | 'BLOCKED' | 'NOT_CANDIDATE' =
        !isCandidateSignal
          ? 'NOT_CANDIDATE'
          : isEntryMissed ||
              stale ||
              fallback ||
              combinedMissingData.length > 0 ||
              smcAnalysis.waitReasons.length > 0
            ? 'BLOCKED'
            : 'ELIGIBLE';

      const blockedReason: string | null = !isCandidateSignal
        ? smcAnalysis.waitReasons[0] ?? 'SMC_GATE_NOT_CONFIRMED'
        : isEntryMissed
          ? 'ENTRY_WINDOW_MISSED: signalDetectedAt >= nextBar.openTime，嚴格禁止回填已錯過的開盤價'
          : stale
            ? 'STALE_DATA_BLOCKED'
            : fallback
              ? 'FALLBACK_DATA_BLOCKED'
              : combinedMissingData.length > 0
                ? `MISSING_DATA_BLOCKED: ${combinedMissingData.join(',')}`
                : null;

      const scanCycleId = this.db.getSmcScanCycleId(exchange);
      const resultRecord: SmcScanResultRecord = {
        symbol,
        exchange,
        smcEvaluationStatus: smcAnalysis.smcEvaluationStatus,
        smcActionState: smcAnalysis.actionState,
        finalTradeSignal,
        marketRadarCategory,
        evaluatedAt,
        dataFetchedAt,
        fetchedAt: dataFetchedAt,
        scanCycleId,
        windowKey: job.windowKey,
        priorityTier: effectivePriorityTier,
        priorityLabel:
          isNearMissOrCandidate && job.priorityTier === 6
            ? '4_SMC_CANDIDATE_OR_NEAR_MISS_FAST_LANE'
            : job.priorityLabel,
        priorityClass,
        workerRole,
        executionWorker,
        freshnessSeconds: 0,
        stale,
        fallback,
        missingData: combinedMissingData,
        source: combinedProvenance.source,
        isDemo: combinedProvenance.isDemo,
        ruleVersion:
          job.ruleVersion || smcAnalysis.ruleVersion || SMC_RULE_VERSION,
        waitReasons: smcAnalysis.waitReasons,
        smcAnalysis,
        queueEnteredAt,
        jobClaimedAt,
        smcEvaluationStartedAt,
        smcEvaluationCompletedAt,
        evaluationStartedAt: smcEvaluationStartedAt,
        evaluationCompletedAt: smcEvaluationCompletedAt,
        queueWaitMs,
        prewarmWaitMs,
        httpRequestLatencyMs,
        smcCalculationLatencyMs,
        dbWriteLatencyMs: 1,
        smcEvaluationLatencyMs,
        evaluationLatencyMs,
        rateLimitWaitMs,
        detectionLatencyMs,
        candidateDetectionLatencyMs,
        nextBarRemainingMs,
        cacheHit,
        cacheMiss,
        reusedCache,
        signalBarOpenTime,
        signalBarCloseTime,
        nextBarOpenTime,
        entryWindowStatus,
        isFastLane,
        nearMissStatus,
        missingGates,
        paperEligibilityStatus,
        candidateDetectedAt: isCandidateSignal ? evaluatedAt : null,
        signalDetectedAt: isCandidateSignal ? evaluatedAt : null,
        paperOpenedAt: null,
        entryWindowMissed,
        blockedReason,
        entryWindowDelayMs,
        intendedDirection:
          smcAnalysis.intendedDirection ??
          smcAnalysis.gateEvaluation?.intendedDirection ??
          'NEUTRAL',
      };

      // Atomically persist result AND transition job to SUCCEEDED in a single SQLite transaction
      this.db.saveSmcScanResult(resultRecord, job.id);
      const dbWriteLatencyMs = Math.max(1, Date.now() - dbWriteStartMs);
      resultRecord.dbWriteLatencyMs = dbWriteLatencyMs;

      this.lastJobCompletedAtByExchange.set(exchange, smcEvaluationCompletedAt);
      this.lastProgressAtByExchange.set(exchange, smcEvaluationCompletedAt);
      this.consecutiveExchangeErrorsByExchange.set(exchange, 0);
      const compArr = this.completionTimestampsByExchange.get(exchange) ?? [];
      compArr.push(evalEndMs);
      while (compArr.length > 0 && evalEndMs - compArr[0] > 60_000) {
        compArr.shift();
      }
      this.completionTimestampsByExchange.set(exchange, compArr);

      job.queueEnteredAt = queueEnteredAt;
      job.jobClaimedAt = jobClaimedAt;
      job.smcEvaluationStartedAt = smcEvaluationStartedAt;
      job.smcEvaluationCompletedAt = smcEvaluationCompletedAt;
      job.queueWaitMs = queueWaitMs;
      job.prewarmWaitMs = prewarmWaitMs;
      job.httpRequestLatencyMs = httpRequestLatencyMs;
      job.smcCalculationLatencyMs = smcCalculationLatencyMs;
      job.dbWriteLatencyMs = dbWriteLatencyMs;
      job.smcEvaluationLatencyMs = smcEvaluationLatencyMs;
      job.rateLimitWaitMs = rateLimitWaitMs;
      job.detectionLatencyMs = detectionLatencyMs;
      job.cacheHit = cacheHit;
      job.cacheMiss = cacheMiss;
      job.reusedCache = reusedCache;
      job.priorityClass = priorityClass;
      job.workerRole = workerRole;
      job.executionWorker = executionWorker;
      job.isFastLane = isFastLane;

      if (priorityClass === 'FAST_LANE') {
        this.db.recordPriorityScanMeta(
          exchange,
          smcEvaluationCompletedAt,
          smcEvaluationLatencyMs,
          false
        );
      } else {
        this.db.recordPrewarmTask({
          symbol,
          exchange,
          prewarmStartedAt: smcEvaluationStartedAt,
          prewarmCompletedAt: smcEvaluationCompletedAt,
          prewarmDurationMs: httpRequestLatencyMs,
          prewarmPriority: 'BULK',
          prewarmStatus: 'COMPLETED',
        });
      }

      if (this.onResultCallback) {
        this.onResultCallback(exchange, symbol, smcAnalysis, resultRecord);
      }

      // Strictly dispatch Dry-Run notification ONLY if ALL candidate & data integrity conditions hold
      if (
        this.telegramDryRunAdapter &&
        resultRecord.smcEvaluationStatus === 'EVALUATED' &&
        (resultRecord.smcActionState === 'LONG CANDIDATE' ||
          resultRecord.smcActionState === 'SHORT CANDIDATE') &&
        resultRecord.finalTradeSignal !== 'NONE' &&
        !resultRecord.stale &&
        !resultRecord.fallback &&
        resultRecord.waitReasons.length === 0
      ) {
        const finalCategory =
          resultRecord.finalTradeSignal === '多頭交易候選'
            ? '多頭候選'
            : '空頭候選';
        const signalDirection =
          resultRecord.finalTradeSignal === '多頭交易候選' ||
          resultRecord.smcActionState === 'LONG CANDIDATE'
            ? 'LONG'
            : 'SHORT';
        const safeRule = resultRecord.ruleVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
        const barTag = signalBarOpenTime ?? 'nobar';
        const scanRunId = this.db.getSmcScanRunId(exchange);
        const signalId = `sig_${exchange}_${symbol}_15m_${signalDirection}_${barTag}_${safeRule}`;
        await this.telegramDryRunAdapter.dispatchPreview({
          symbol,
          category: finalCategory,
          actionState: resultRecord.smcActionState,
          finalTradeSignal: resultRecord.finalTradeSignal,
          smcEvaluationStatus: resultRecord.smcEvaluationStatus,
          stale: resultRecord.stale,
          fallback: resultRecord.fallback,
          waitReasons: resultRecord.waitReasons,
          score: preCandidate?.score ?? 75,
          confirmedEvidences: smcAnalysis.evidences
            .filter((e) => e.passed)
            .map((e) => `${e.label}: ${e.value}`),
          missingData: resultRecord.missingData,
          riskWarnings: [
            `[SMC_BATCH_QUEUE_DRY_RUN] 規則版本 ${MARKET_SCAN_RULE_VERSION}`,
          ],
          source: resultRecord.source,
          fetchedAt: resultRecord.dataFetchedAt,
          safetyBanner: `${TRADING_SAFETY_FLAGS.mode} / ${TRADING_SAFETY_FLAGS.liveOrders}`,
          scanRunId,
          signalId,
          ruleVersion: resultRecord.ruleVersion,
          snapshotAt: resultRecord.evaluatedAt,
          evaluatedAt: resultRecord.evaluatedAt,
          isBacktest: false,
        });
      }
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'SMC background evaluation failed';
      const isRateLimit =
        (err instanceof ExchangeApiUnavailableError &&
          (err.statusCode === 429 || err.isRateLimited)) ||
        /429|rate limit|too many requests/i.test(errorMsg);
      const isHttp503 =
        (err instanceof ExchangeApiUnavailableError &&
          err.statusCode === 503) ||
        /503|service unavailable|bad gateway|gateway timeout/i.test(errorMsg);

      this.db.recordPhase17ErrorEvent(exchange, {
        is429: isRateLimit,
        is503: isHttp503,
        errorMessage: errorMsg,
      });

      this.consecutiveExchangeErrorsByExchange.set(
        exchange,
        (this.consecutiveExchangeErrorsByExchange.get(exchange) ?? 0) + 1
      );

      const nextRetryCount = job.retryCount + 1;
      if (job.id !== undefined) {
        if (isRateLimit && nextRetryCount <= this.config.maxRetries) {
          this.db.updateRuntimeHttpMetrics(exchange, {
            incrementRateLimitEvents: 1,
          });
          const backoffMs =
            this.config.baseBackoffMs * Math.pow(2, nextRetryCount - 1);
          const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
          this.db.markSmcJobRateLimited(
            job.id,
            errorMsg,
            nextRetryCount,
            nextRetryAt
          );
        } else {
          this.db.markSmcJobFailed(job.id, errorMsg, nextRetryCount);
        }
      }
    }
  }

  public setSimulatedHealthState(
    exchange: ExchangeId,
    state: {
      workerState?: 'RUNNING' | 'PAUSED' | 'IDLE';
      isPrewarming?: boolean;
      lastPrewarmProgressAt?: string | null;
      consecutiveExchangeErrors?: number;
      lastProgressAt?: string | null;
      lastJobCompletedAt?: string | null;
      stalledThresholdMs?: number;
    }
  ): void {
    if (state.workerState !== undefined) {
      this.workerState = state.workerState;
    }
    if (state.isPrewarming !== undefined) {
      this.isPrewarmingByExchange.set(exchange, state.isPrewarming);
    }
    if (state.lastPrewarmProgressAt !== undefined) {
      if (state.lastPrewarmProgressAt === null) {
        this.lastPrewarmProgressAtByExchange.delete(exchange);
      } else {
        this.lastPrewarmProgressAtByExchange.set(
          exchange,
          state.lastPrewarmProgressAt
        );
      }
    }
    if (state.consecutiveExchangeErrors !== undefined) {
      this.consecutiveExchangeErrorsByExchange.set(
        exchange,
        state.consecutiveExchangeErrors
      );
    }
    if (state.lastProgressAt !== undefined) {
      if (state.lastProgressAt === null) {
        this.lastProgressAtByExchange.delete(exchange);
      } else {
        this.lastProgressAtByExchange.set(exchange, state.lastProgressAt);
      }
    }
    if (state.lastJobCompletedAt !== undefined) {
      if (state.lastJobCompletedAt === null) {
        this.lastJobCompletedAtByExchange.delete(exchange);
      } else {
        this.lastJobCompletedAtByExchange.set(
          exchange,
          state.lastJobCompletedAt
        );
      }
    }
    if (state.stalledThresholdMs !== undefined) {
      this.config.stalledThresholdMs = state.stalledThresholdMs;
    }
  }

  private computePhase16DiagnosticsFromAtomic(
    atomic: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>,
    resolvedExchange: ExchangeId,
    mode: 'live' | 'demo',
    nowMs = Date.now()
  ): SmcScanProgressHealthResponse {
    const stalledThresholdMs = this.config.stalledThresholdMs ?? 45_000;
    const isPrewarming =
      this.isPrewarmingByExchange.get(resolvedExchange) === true;

    const breakdown = this.db.getPhase16PendingBreakdown(
      resolvedExchange,
      nowMs,
      {
        isPrewarming,
        stalledThresholdMs,
      }
    );

    const pendingCount = breakdown.pendingCount;
    const queuedCount = breakdown.queuedCount;
    const runningJobCount = breakdown.runningJobCount;
    const maxConcurrency = Math.max(1, this.config.maxConcurrency ?? 2);
    const concurrencyValid = runningJobCount <= maxConcurrency;
    if (!concurrencyValid) {
      this.db.recordConcurrencyViolation(resolvedExchange);
    }
    const waitingForCacheCount = breakdown.waitingForCacheCount;
    const waitingForRateLimitCount = breakdown.waitingForRateLimitCount;
    const waitingForNextBatchCount = breakdown.waitingForNextBatchCount;
    const retryScheduledCount = breakdown.retryScheduledCount;
    const failedRetryableCount = breakdown.failedRetryableCount;

    // Last completed & progress timestamps (prefer DB breakdown timestamps so manipulated DB test states are accurately reflected)
    const lastJobCompletedAt =
      breakdown.lastJobCompletedAt ??
      atomic.lastCompletedAt ??
      this.lastJobCompletedAtByExchange.get(resolvedExchange) ??
      null;
    const lastProgressAt =
      breakdown.lastJobProgressAt ??
      lastJobCompletedAt ??
      this.lastProgressAtByExchange.get(resolvedExchange) ??
      null;

    const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
    const lastCompletedMs = lastJobCompletedAt
      ? Date.parse(lastJobCompletedAt)
      : NaN;
    const oldestPendingAgeMs = breakdown.oldestPendingAgeMs;

    // Evaluate Section 三: Stuck Diagnostics Rules
    const stalledReasonsSet = new Set<SmcStalledReason>();

    if (pendingCount > 0) {
      // 1. LEASE_EXPIRED: runningJob heartbeat / lease expired
      const hasLeaseExpired =
        breakdown.leaseExpiredCount > 0 ||
        breakdown.pendingSymbols.some(
          (p) =>
            p.pendingReason === 'RUNNING' &&
            (p.leaseExpired === true ||
              (p.leaseUntil !== null &&
              p.leaseUntil !== undefined &&
              Number.isFinite(Date.parse(p.leaseUntil))
                ? Date.parse(p.leaseUntil) <= nowMs
                : p.lastHeartbeatAt !== null &&
                  Number.isFinite(Date.parse(p.lastHeartbeatAt)) &&
                  nowMs - Date.parse(p.lastHeartbeatAt) >= stalledThresholdMs))
        );
      if (hasLeaseExpired) {
        stalledReasonsSet.add('LEASE_EXPIRED');
      }

      // 2. QUEUE_NOT_STARTED: pending tasks exist, worker is not RUNNING (IDLE or PAUSED), and pending tasks have aged beyond threshold
      if (
        this.workerState !== 'RUNNING' &&
        oldestPendingAgeMs !== null &&
        oldestPendingAgeMs >= stalledThresholdMs
      ) {
        stalledReasonsSet.add('QUEUE_NOT_STARTED');
      }

      // 3. CACHE_PREWARM_STALLED: tasks are waiting for cache while prewarm has no progress beyond threshold
      const lastPrewarmProgressIso =
        this.lastPrewarmProgressAtByExchange.get(resolvedExchange) ??
        breakdown.lastJobProgressAt;
      const lastPrewarmMs = lastPrewarmProgressIso
        ? Date.parse(lastPrewarmProgressIso)
        : NaN;
      const prewarmAgeMs = Number.isFinite(lastPrewarmMs)
        ? Math.max(0, nowMs - lastPrewarmMs)
        : oldestPendingAgeMs ?? 0;

      if (
        waitingForCacheCount > 0 &&
        prewarmAgeMs >= stalledThresholdMs &&
        (isPrewarming || waitingForCacheCount === pendingCount)
      ) {
        stalledReasonsSet.add('CACHE_PREWARM_STALLED');
      }

      // 4. RATE_LIMIT_BACKOFF: rate limit backoff time abnormally long or stuck past retry window without queue progress
      const progressAgeForRateLimitMs = Number.isFinite(lastProgressMs)
        ? Math.max(0, nowMs - lastProgressMs)
        : oldestPendingAgeMs ?? 0;
      const hasAbnormalRateLimitBackoff = breakdown.pendingSymbols.some((p) => {
        if (
          p.pendingReason !== 'WAITING_FOR_RATE_LIMIT' &&
          p.pendingReason !== 'RETRY_SCHEDULED'
        ) {
          return false;
        }
        const retryMs = p.nextRetryAt ? Date.parse(p.nextRetryAt) : NaN;
        if (Number.isFinite(retryMs)) {
          // Backoff remaining exceeds threshold OR (retry window already expired long ago AND queue has had no progress beyond threshold)
          return (
            retryMs - nowMs >= stalledThresholdMs ||
            (nowMs - retryMs >= stalledThresholdMs &&
              progressAgeForRateLimitMs >= stalledThresholdMs)
          );
        }
        return progressAgeForRateLimitMs >= stalledThresholdMs;
      });
      if (hasAbnormalRateLimitBackoff) {
        stalledReasonsSet.add('RATE_LIMIT_BACKOFF');
      }

      // 5. EXCHANGE_API_UNAVAILABLE: exchange API continuously returning errors
      const consecutiveErrors =
        this.consecutiveExchangeErrorsByExchange.get(resolvedExchange) ?? 0;
      const hasExchangeErrorJobs = breakdown.pendingSymbols.some(
        (p) =>
          p.pendingReason === 'FAILED_RETRYABLE' &&
          Boolean(
            p.lastError &&
              /503|502|504|Service Unavailable|ExchangeApiUnavailable|ECONNREFUSED|ETIMEDOUT/i.test(
                p.lastError
              )
          )
      );
      if (
        consecutiveErrors >= 3 ||
        failedRetryableCount >= 3 ||
        hasExchangeErrorJobs ||
        (atomic.failedCount >= 3 &&
          (!Number.isFinite(lastProgressMs) ||
            nowMs - lastProgressMs >= stalledThresholdMs))
      ) {
        stalledReasonsSet.add('EXCHANGE_API_UNAVAILABLE');
      }

      // 6. WORKER_NO_PROGRESS: workerState === RUNNING (or queue exists) and no job completed / no progress beyond stalledThresholdMs
      const progressAgeMs = Number.isFinite(lastProgressMs)
        ? Math.max(0, nowMs - lastProgressMs)
        : oldestPendingAgeMs ?? 0;
      const completedAgeMs = Number.isFinite(lastCompletedMs)
        ? Math.max(0, nowMs - lastCompletedMs)
        : oldestPendingAgeMs ?? 0;

      const effectiveNoProgressThresholdMs = Math.min(
        stalledThresholdMs,
        10 * 60 * 1000
      );
      if (
        this.workerState === 'RUNNING' &&
        (oldestPendingAgeMs ?? 0) >= effectiveNoProgressThresholdMs &&
        progressAgeMs >= effectiveNoProgressThresholdMs &&
        completedAgeMs >= effectiveNoProgressThresholdMs
      ) {
        stalledReasonsSet.add('WORKER_NO_PROGRESS');
      } else if (
        this.workerState !== 'RUNNING' &&
        (oldestPendingAgeMs ?? 0) >= 10 * 60 * 1000 &&
        progressAgeMs >= 10 * 60 * 1000 &&
        completedAgeMs >= 10 * 60 * 1000
      ) {
        stalledReasonsSet.add('QUEUE_NOT_STARTED');
      }
    }

    const stalledReasons = Array.from(stalledReasonsSet);
    const stalledSuspected = !concurrencyValid || stalledReasons.length > 0;

    const wasStalled =
      this.lastStalledSuspectedByExchange.get(resolvedExchange) === true;
    if (stalledSuspected && !wasStalled) {
      this.lastStalledSuspectedByExchange.set(resolvedExchange, true);
      this.db.recordPhase17ErrorEvent(resolvedExchange, {
        stalledDetected: true,
        errorMessage: !concurrencyValid
          ? `Concurrency cap exceeded: runningJobCount=${runningJobCount} > maxConcurrency=${maxConcurrency}`
          : `Stalled detected: ${stalledReasons.join(', ')}`,
      });
    } else if (!stalledSuspected && wasStalled) {
      this.lastStalledSuspectedByExchange.set(resolvedExchange, false);
    }

    // Recompute stuckJobs so any job contributing to stalledSuspected is included
    const stuckJobsMap = new Map<string, SmcPendingSymbolRecord>();
    for (const sj of breakdown.stuckJobs) {
      stuckJobsMap.set(sj.symbol, sj);
    }
    if (stalledSuspected) {
      for (const p of breakdown.pendingSymbols) {
        const qMs = Date.parse(p.queuedAt);
        const age = Number.isFinite(qMs) ? Math.max(0, nowMs - qMs) : 0;
        if (
          !concurrencyValid ||
          age >= stalledThresholdMs ||
          p.pendingReason === 'FAILED_RETRYABLE' ||
          p.pendingReason === 'WAITING_FOR_RATE_LIMIT' ||
          p.pendingReason === 'WAITING_FOR_CACHE'
        ) {
          stuckJobsMap.set(p.symbol, p);
        }
      }
    }
    const stuckJobs = Array.from(stuckJobsMap.values());
    const stalledJobCount = stuckJobs.length;

    const statsConsistency: 'VALID' | 'INVALID' =
      concurrencyValid &&
      breakdown.pendingBreakdownConsistency === 'VALID' &&
      atomic.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';

    const pendingBreakdownConsistency: SmcPendingBreakdownConsistency =
      statsConsistency;

    // Completion rate per minute & estimated remaining duration
    let recentCompletionsIn60s = 0;
    for (const rec of atomic.resultsMap.values()) {
      const evMs = Date.parse(rec.evaluatedAt);
      if (Number.isFinite(evMs) && nowMs >= evMs && nowMs - evMs <= 60_000) {
        recentCompletionsIn60s++;
      }
    }
    const runtimeCompArr = (
      this.completionTimestampsByExchange.get(resolvedExchange) ?? []
    ).filter((ts) => nowMs >= ts && nowMs - ts <= 60_000);
    const effectiveRecent60s = Math.max(
      recentCompletionsIn60s,
      runtimeCompArr.length
    );

    const resolvedCycleStatus =
      pendingBreakdownConsistency === 'INVALID'
        ? 'INCONSISTENT'
        : atomic.cycleStatus;

    const isCompletedIdle =
      pendingCount === 0 &&
      (resolvedCycleStatus === 'COMPLETED' ||
        atomic.cycleStatus === 'COMPLETED' ||
        runningJobCount === 0);

    let progressRatePerMinute = 0;
    if (isCompletedIdle) {
      progressRatePerMinute = 0;
    } else if (effectiveRecent60s > 0) {
      progressRatePerMinute = effectiveRecent60s;
    } else if (
      atomic.evaluatedCount > 0 &&
      atomic.cycleStartedAt &&
      !stalledSuspected
    ) {
      const startMs = Date.parse(atomic.cycleStartedAt);
      const elapsedMin = Number.isFinite(startMs)
        ? Math.max(0.25, (nowMs - startMs) / 60_000)
        : 1;
      progressRatePerMinute = Number(
        (atomic.evaluatedCount / elapsedMin).toFixed(2)
      );
    }

    const progressRateStatus: SmcProgressRateStatus =
      isCompletedIdle || progressRatePerMinute === 0
        ? 'NO_ACTIVE_PROGRESS'
        : 'ACTIVE';

    const estimatedRemainingDuration =
      pendingCount === 0
        ? 0
        : progressRatePerMinute > 0
          ? Math.round((pendingCount / progressRatePerMinute) * 60_000)
          : atomic.estimatedRemainingDuration;

    const scannerHealth: SmcScannerHealthStatus =
      stalledSuspected || pendingBreakdownConsistency === 'INVALID'
        ? 'STALLED'
        : atomic.failedCount > 0 ||
            atomic.rateLimitedCount > 0 ||
            failedRetryableCount > 0
          ? 'DEGRADED'
          : this.workerState !== 'RUNNING' && pendingCount === 0
            ? 'IDLE'
            : 'HEALTHY';

    const queueHealth: SmcQueueHealthStatus =
      stalledReasons.includes('QUEUE_NOT_STARTED') ||
      stalledReasons.includes('WORKER_NO_PROGRESS') ||
      stalledReasons.includes('LEASE_EXPIRED') ||
      stalledReasons.includes('CACHE_PREWARM_STALLED') ||
      pendingBreakdownConsistency === 'INVALID'
        ? 'STALLED'
        : waitingForRateLimitCount > 0 ||
            retryScheduledCount > 0 ||
            failedRetryableCount > 0
          ? 'BACKPRESSURE'
          : pendingCount > 0
            ? 'DRAINING'
            : 'HEALTHY';

    const exchangeApiHealth: SmcExchangeApiHealthStatus =
      stalledReasons.includes('EXCHANGE_API_UNAVAILABLE')
        ? 'UNAVAILABLE'
        : stalledReasons.includes('RATE_LIMIT_BACKOFF') ||
            waitingForRateLimitCount > 0 ||
            atomic.rateLimitedCount > 0
          ? 'RATE_LIMITED'
          : atomic.failedCount > 0 || failedRetryableCount > 0
            ? 'DEGRADED'
            : 'HEALTHY';

    const monitorWorkerState: SmcMonitorWorkerState =
      this.progressSampleTimer !== null || this.workerState === 'RUNNING'
        ? 'RUNNING'
        : this.workerState === 'PAUSED'
          ? 'PAUSED'
          : 'RUNNING';

    const scanWorkerState: SmcScanWorkerState =
      pendingCount === 0 && runningJobCount === 0
        ? 'IDLE'
        : runningJobCount > 0
          ? 'RUNNING'
          : this.workerState === 'PAUSED'
            ? 'PAUSED'
            : 'IDLE';

    const queueWorkerState: SmcQueueWorkerState =
      !concurrencyValid ||
      pendingBreakdownConsistency === 'INVALID' ||
      stalledSuspected
        ? 'ERROR'
        : this.workerState === 'PAUSED'
          ? 'PAUSED'
          : this.workerState === 'IDLE' &&
              pendingCount > 0 &&
              runningJobCount === 0 &&
              atomic.evaluatedCount === 0
            ? 'STOPPED'
            : 'HEALTHY';

    const windows = this.db.getOrSyncLongRunningWindows(
      resolvedExchange,
      nowMs,
      maxConcurrency
    );
    const activeWin24h = windows['24h'];
    const counters = this.db.getRestartAndRecoveryCounters(
      resolvedExchange,
      activeWin24h.monitoringWindowId
    );

    const diagnosisLabel:
      | '正常背景評估中'
      | '背景掃描疑似卡住'
      | '掃描已完成'
      | '統計分類不一致' =
      pendingBreakdownConsistency === 'INVALID'
        ? '統計分類不一致'
        : stalledSuspected
          ? '背景掃描疑似卡住'
          : pendingCount === 0 &&
              atomic.totalSymbols > 0 &&
              atomic.evaluatedCount === atomic.totalSymbols
            ? '掃描已完成'
            : '正常背景評估中';

    return {
      safety: TRADING_SAFETY_FLAGS,
      liveOrders: TRADING_SAFETY_FLAGS.liveOrders,
      executionPolicy: TRADING_SAFETY_FLAGS.executionPolicy,
      exchange: resolvedExchange,
      mode,
      scanMode: mode,
      databaseInstanceId: atomic.databaseInstanceId,
      monitoringWindowId: activeWin24h.monitoringWindowId,
      windowStatus: activeWin24h.windowStatus,
      cycleId: atomic.cycleId,
      scanCycleId: atomic.scanCycleId,
      cycleStatus: resolvedCycleStatus,
      workerState: this.workerState,
      monitorWorkerState,
      scanWorkerState,
      queueWorkerState,
      scannerHealth,
      queueHealth,
      exchangeApiHealth,
      totalSymbols: atomic.totalSymbols,
      evaluatedCount: atomic.evaluatedCount,
      pendingCount,
      queuedCount,
      pureQueuedCount: breakdown.pureQueuedCount,
      dbQueuedJobCount: breakdown.dbQueuedJobCount,
      maxConcurrency,
      runningJobCount,
      concurrencyValid,
      statsConsistency,
      waitingForCacheCount,
      waitingForRateLimitCount,
      waitingForNextBatchCount,
      retryScheduledCount,
      failedRetryableCount,
      failedCount: atomic.failedCount,
      rateLimitedCount: atomic.rateLimitedCount,
      lastJobCompletedAt,
      lastProgressAt,
      progressRatePerMinute,
      progressRateStatus,
      estimatedRemainingDuration,
      oldestPendingAgeMs,
      stalledJobCount,
      stalledThresholdMs,
      stalledSuspected,
      stalledReasons,
      workerRestartCount: counters.workerRestartCount,
      plannedRestartCount: counters.plannedRestartCount,
      unexpectedRestartCount: counters.unexpectedRestartCount,
      leaseRecoveryCount: counters.leaseRecoveryCount,
      databaseRecoveryCount: counters.databaseRecoveryCount,
      windowPlannedRestartCount: activeWin24h.windowPlannedRestartCount,
      windowUnexpectedRestartCount: activeWin24h.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: activeWin24h.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: activeWin24h.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: activeWin24h.windowStalledDetectedCount,
      windowConcurrencyViolationCount:
        activeWin24h.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: counters.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: counters.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: counters.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: counters.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: counters.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        counters.lifetimeConcurrencyViolationCount,
      pendingBreakdownConsistency,
      pendingReasonCounts: breakdown.pendingReasonCounts,
      fastLanePendingCount: breakdown.fastLanePendingCount,
      bulkPendingCount: breakdown.bulkPendingCount,
      diagnosisLabel,
      pendingNotices: [
        'PENDING 不等於 WAIT',
        'PENDING 不代表 SMC 通過',
        'PENDING 不代表 SMC 被拒絕',
      ],
      pendingSymbols: breakdown.pendingSymbols,
      stuckJobs,
      statsVersion: atomic.statsVersion,
      snapshotAt: atomic.snapshotAt,
      ...(() => {
        const diag = this.db.computeCycleDiagnosticsAndFunnel(resolvedExchange);
        return {
          aggregationScope: diag.aggregationScope,
          evaluationUniverseSize: diag.evaluationUniverseSize,
          evaluatedDenominator: diag.evaluatedDenominator,
          excludedCount: diag.excludedCount,
          excludedSymbols: diag.excludedSymbols,
          excludedReasons: diag.excludedReasons,
          consistencyErrors: diag.consistencyErrors,
          candidateFunnel: diag.candidateFunnel,
          currentCycleFunnel: diag.currentCycleFunnel,
          latestSnapshotFunnel: diag.latestSnapshotFunnel,
          monitoringWindowFunnel: diag.monitoringWindowFunnel,
          cumulativeFunnel: diag.cumulativeFunnel,
          historicalSignalsOutsideCurrentCycle:
            diag.historicalSignalsOutsideCurrentCycle,
          historicalSignalsOutsideWindow: diag.historicalSignalsOutsideWindow,
          formalCandidateLatencySla: diag.formalCandidateLatencySla,
          DEMO_LATENCY_FIXTURE: diag.DEMO_LATENCY_FIXTURE,
          LIVE_FORMAL_CANDIDATE_COUNT: diag.LIVE_FORMAL_CANDIDATE_COUNT,
          LIVE_FAST_LANE_COUNT: diag.LIVE_FAST_LANE_COUNT,
          LIVE_BULK_COUNT: diag.LIVE_BULK_COUNT,
          LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
            diag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
          LIVE_ENTRY_WINDOW_MISSED_COUNT: diag.LIVE_ENTRY_WINDOW_MISSED_COUNT,
          LIVE_DETECTION_LATENCY_P50: diag.LIVE_DETECTION_LATENCY_P50,
          LIVE_DETECTION_LATENCY_P95: diag.LIVE_DETECTION_LATENCY_P95,
          LIVE_FAST_LANE_DETECTION_LATENCY_P50:
            diag.LIVE_FAST_LANE_DETECTION_LATENCY_P50,
          LIVE_FAST_LANE_DETECTION_LATENCY_P95:
            diag.LIVE_FAST_LANE_DETECTION_LATENCY_P95,
          LIVE_BULK_DETECTION_LATENCY_P50: diag.LIVE_BULK_DETECTION_LATENCY_P50,
          LIVE_BULK_DETECTION_LATENCY_P95: diag.LIVE_BULK_DETECTION_LATENCY_P95,
          smcGateDiagnostics: diag.smcGateDiagnostics,
          paperEligibilityAudit: diag.paperEligibilityAudit,
          scopedGateStatistics: diag.scopedGateStatistics,
          observationShadowComparison: diag.observationShadowComparison,
          nearMissCount: diag.nearMissCount,
          nearMissMissing1Count: diag.nearMissMissing1Count,
          nearMissMissing2Count: diag.nearMissMissing2Count,
          nearMissMissingGates: diag.nearMissMissingGates,
          lastBlockingGate: diag.lastBlockingGate,
          blockedAfterSmcCandidateCount: diag.blockedAfterSmcCandidateCount,
          blockedAfterSmcCandidateReasons: diag.blockedAfterSmcCandidateReasons,
          blockedByPaperEligibilityCount: diag.blockedByPaperEligibilityCount,
          blockedByPaperEligibilityReasons:
            diag.blockedByPaperEligibilityReasons,
          formalCandidateCount: diag.formalCandidateCount,
          fastLaneFormalCandidateCount: diag.fastLaneFormalCandidateCount,
          bulkFormalCandidateCount: diag.bulkFormalCandidateCount,
          candidateDetectedBeforeEntryWindowCount:
            diag.candidateDetectedBeforeEntryWindowCount,
          entryWindowMissedRate: diag.entryWindowMissedRate,
          candidateDetectionLatencyP50: diag.candidateDetectionLatencyP50,
          candidateDetectionLatencyP95: diag.candidateDetectionLatencyP95,
          queueWaitP50: diag.queueWaitP50,
          queueWaitP95: diag.queueWaitP95,
          eligiblePaperSignalCount: diag.eligiblePaperSignalCount,
          paperEligibleCount: diag.eligiblePaperSignalCount,
          currentCyclePaperEligibleCount: diag.currentCyclePaperEligibleCount,
          monitoringWindowPaperEligibleCount:
            diag.monitoringWindowPaperEligibleCount,
          cumulativePaperEligibleCount: diag.cumulativePaperEligibleCount,
          historicalPaperEligibleCount: diag.historicalPaperEligibleCount,
          entryWindowMissedCount: diag.entryWindowMissedCount,
          currentCycleEntryWindowMissedCount:
            diag.currentCycleEntryWindowMissedCount,
          monitoringWindowEntryWindowMissedCount:
            diag.monitoringWindowEntryWindowMissedCount,
          cumulativeEntryWindowMissedCount:
            diag.cumulativeEntryWindowMissedCount,
          historicalSignalsOutsideWindowCount:
            diag.historicalSignalsOutsideWindowCount,
          historicalSignalsOutsideCurrentCycleCount:
            diag.historicalSignalsOutsideCurrentCycleCount,
          paperOpenedCount: diag.paperOpenedCount,
          paperClosedCount: diag.paperClosedCount,
          blockedCount: diag.blockedByPaperEligibilityCount,
          candidateDetectedCount: diag.candidateDetectedCount,
          rootCauseVerdict: diag.rootCauseVerdict,
          rootCauseExplanation: diag.rootCauseExplanation,
        };
      })(),
    };
  }

  private toProgressEvidenceSample(
    diag: SmcScanProgressHealthResponse,
    nowMs = Date.now()
  ): Phase17ProgressEvidenceSampleRecord {
    const atomic = this.db.getAtomicSmcSnapshot(diag.exchange, nowMs);
    const windows = this.db.getOrSyncLongRunningWindows(
      diag.exchange,
      nowMs,
      diag.maxConcurrency
    );
    const monitoringWindowId = windows['24h'].monitoringWindowId;
    const cacheHealth: 'HEALTHY' | 'PREWARMING' | 'DEGRADED' | 'COLD' =
      this.isPrewarmingByExchange.get(diag.exchange) === true ||
      atomic.cacheStatus === '正在預熱'
        ? 'PREWARMING'
        : atomic.staleCacheCount > 0 ||
            atomic.expiredCacheCount > atomic.freshCacheCount
          ? 'DEGRADED'
          : atomic.freshCacheCount === 0
            ? 'COLD'
            : 'HEALTHY';
    const sampledAt = new Date(nowMs).toISOString();
    return {
      sampleId: `smp_${diag.exchange}_${diag.cycleId}_${nowMs}`,
      sampledAt,
      monitoringWindowId,
      exchange: diag.exchange,
      cycleId: diag.cycleId,
      snapshotAt: diag.snapshotAt,
      statsVersion: diag.statsVersion,
      workerState: diag.workerState,
      monitorWorkerState: diag.monitorWorkerState,
      scanWorkerState: diag.scanWorkerState,
      queueWorkerState: diag.queueWorkerState,
      maxConcurrency: diag.maxConcurrency,
      runningJobCount: diag.runningJobCount,
      concurrencyValid: diag.concurrencyValid,
      scannerHealth: diag.scannerHealth,
      queueHealth: diag.queueHealth,
      exchangeApiHealth: diag.exchangeApiHealth,
      evaluatedCount: diag.evaluatedCount,
      pendingCount: diag.pendingCount,
      queuedCount: diag.queuedCount,
      failedCount: diag.failedCount,
      rateLimitedCount: diag.rateLimitedCount,
      lastProgressAt: diag.lastProgressAt,
      progressRatePerMinute: diag.progressRatePerMinute,
      progressRateStatus: diag.progressRateStatus,
      oldestPendingAgeMs: diag.oldestPendingAgeMs ?? 0,
      stalledSuspected: diag.stalledSuspected,
      stalledReasons: diag.stalledReasons,
      integrityCheck: 'ok',
      externalNotificationCount: 0,
      cacheHealth,
      pendingReasonCounts: diag.pendingReasonCounts,
      lastJobCompletedAt: diag.lastJobCompletedAt,
      estimatedRemainingDuration: diag.estimatedRemainingDuration,
    };
  }

  public startProgressSamplingLoop(
    exchange: ExchangeId = 'binance_usdm',
    intervalMs = 60_000
  ): void {
    this.stopProgressSamplingLoop();
    this.db.getOrSyncLongRunningWindows(
      exchange,
      Date.now(),
      this.config.maxConcurrency
    );
    this.captureProgressEvidenceSample(exchange, 'live', Date.now());
    this.progressSampleTimer = setInterval(() => {
      try {
        const now = Date.now();
        this.db.getOrSyncLongRunningWindows(
          exchange,
          now,
          this.config.maxConcurrency
        );
        this.captureProgressEvidenceSample(exchange, 'live', now);
      } catch {
        // ignore transient sampling error
      }
    }, Math.max(10_000, intervalMs));
  }

  public stopProgressSamplingLoop(): void {
    if (this.progressSampleTimer) {
      clearInterval(this.progressSampleTimer);
      this.progressSampleTimer = null;
    }
  }

  public startNewMonitoringWindows(
    exchange: ExchangeId = 'binance_usdm',
    nowMs = Date.now()
  ) {
    return this.db.startNewMonitoringWindows(exchange, nowMs);
  }

  public getProgressAndHealth(
    exchange = this.activeExchange,
    mode = this.activeMode,
    nowMs = Date.now()
  ): SmcScanProgressHealthResponse {
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    this.getAvailableRequests(nowMs);
    this.db.updateRuntimeHttpMetrics(resolvedExchange, {
      currentRequestsInWindow: this.requestTimestamps.length,
      maxHttpConcurrency: this.config.maxHttpConcurrency,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
    });
    const atomic = this.db.getAtomicSmcSnapshot(resolvedExchange);
    const diag = this.computePhase16DiagnosticsFromAtomic(
      atomic,
      resolvedExchange,
      mode,
      nowMs
    );
    const lastSampleMs =
      this.lastProgressEvidenceSampleMsByExchange.get(resolvedExchange) ?? 0;
    if (lastSampleMs === 0 || Math.abs(nowMs - lastSampleMs) >= 60_000) {
      this.lastProgressEvidenceSampleMsByExchange.set(resolvedExchange, nowMs);
      const sample = this.toProgressEvidenceSample(diag, nowMs);
      this.db.recordProgressEvidenceSample(sample);
    }
    return diag;
  }

  public captureProgressEvidenceSample(
    exchange = this.activeExchange,
    mode = this.activeMode,
    nowMs = Date.now()
  ): Phase17ProgressEvidenceSampleRecord {
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    const diag = this.getProgressAndHealth(resolvedExchange, mode, nowMs);
    this.lastProgressEvidenceSampleMsByExchange.set(resolvedExchange, nowMs);
    const sample = this.toProgressEvidenceSample(diag, nowMs);
    this.db.recordProgressEvidenceSample(sample);
    return sample;
  }

  public listProgressEvidenceSamples(
    exchange = this.activeExchange,
    limit = 60
  ): Phase17ProgressEvidenceSampleRecord[] {
    return this.db.listProgressEvidenceSamples(exchange, limit);
  }

  public gracefulShutdown(
    exchange = this.activeExchange,
    _reason?: string
  ): Phase17ServiceRecoveryRecord {
    this.stop();
    const statsBefore = this.db.getAtomicSmcSnapshot(exchange).statsVersion;
    const recoveredCount = this.db.recoverInterruptedSmcJobs(
      exchange,
      'GRACEFUL_SHUTDOWN_RESTART',
      { planned: true, serviceStoppedNormally: true }
    );
    const existing = this.db.getLastServiceRecoveryResult(exchange);
    if (recoveredCount > 0 && existing) {
      return existing;
    }
    const statsAfter = this.db.getAtomicSmcSnapshot(exchange).statsVersion;
    return this.db.recordServiceRecoveryEvent({
      exchange,
      triggerReason: 'GRACEFUL_SHUTDOWN_RESTART',
      recoveredRunningJobsCount: recoveredCount,
      statsVersionBefore: statsBefore,
      statsVersionAfter: statsAfter,
      planned: true,
      serviceStoppedNormally: true,
    });
  }

  public forceInterruptWorker(
    exchange = this.activeExchange
  ): {
    interruptedRunningCount: number;
    workerState: 'PAUSED';
  } {
    this.stop();
    const runningCount =
      this.db.getSmcScanQueueStats(exchange).runningJobCount;
    this.db.recordPhase17ErrorEvent(exchange, {
      errorMessage: `Worker forcibly interrupted while ${runningCount} job(s) RUNNING`,
    });
    return {
      interruptedRunningCount: runningCount,
      workerState: 'PAUSED',
    };
  }

  public restartAndRecover(params?: {
    exchange?: ExchangeId;
    mode?: 'live' | 'demo';
    triggerReason?: Phase17RecoveryTriggerReason;
    resumeWorker?: boolean;
    planned?: boolean;
    serviceStoppedNormally?: boolean;
  }): Phase17ServiceRecoveryRecord {
    const mode = params?.mode ?? this.activeMode;
    const rawExchange = params?.exchange ?? this.activeExchange;
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : rawExchange;
    const triggerReason: Phase17RecoveryTriggerReason =
      params?.triggerReason ?? 'FORCED_WORKER_INTERRUPT_RESTART';
    const planned =
      params?.planned !== undefined
        ? params.planned
        : triggerReason !== 'UNEXPECTED_CRASH';
    const serviceStoppedNormally =
      params?.serviceStoppedNormally !== undefined
        ? params.serviceStoppedNormally
        : planned && triggerReason !== 'FORCED_WORKER_INTERRUPT_RESTART';

    const statsBefore =
      this.db.getAtomicSmcSnapshot(resolvedExchange).statsVersion;
    const recoveredCount = this.db.recoverInterruptedSmcJobs(
      resolvedExchange,
      triggerReason,
      { planned, serviceStoppedNormally }
    );
    const lastRec = this.db.getLastServiceRecoveryResult(resolvedExchange);
    let record: Phase17ServiceRecoveryRecord;
    if (recoveredCount > 0 && lastRec) {
      record = lastRec;
    } else {
      const statsAfter =
        this.db.getAtomicSmcSnapshot(resolvedExchange).statsVersion;
      record = this.db.recordServiceRecoveryEvent({
        exchange: resolvedExchange,
        triggerReason,
        recoveredRunningJobsCount: recoveredCount,
        statsVersionBefore: statsBefore,
        statsVersionAfter: statsAfter,
        planned,
        serviceStoppedNormally,
      });
    }

    const nowIso = new Date().toISOString();
    this.lastProgressAtByExchange.set(resolvedExchange, nowIso);

    if (params?.resumeWorker !== false) {
      this.workerState = 'RUNNING';
      this.scheduleNextTick(10);
    }

    return record;
  }

  public getDatabaseHealth(
    exchange = this.activeExchange,
    mode = this.activeMode
  ): SystemDatabaseHealthResponse {
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    const progress = this.getProgressAndHealth(resolvedExchange, mode);
    return this.db.performDatabaseHealthCheck(resolvedExchange, {
      runBackup: false,
      workerState: progress.workerState,
      monitorWorkerState: progress.monitorWorkerState,
      scanWorkerState: progress.scanWorkerState,
      queueWorkerState: progress.queueWorkerState,
      scannerHealth: progress.scannerHealth,
      queueHealth: progress.queueHealth,
      exchangeApiHealth: progress.exchangeApiHealth,
      stalledSuspected: progress.stalledSuspected,
      stalledReasons: progress.stalledReasons,
      maxConcurrency: this.config.maxConcurrency,
      progressRatePerMinute: progress.progressRatePerMinute,
      progressRateStatus: progress.progressRateStatus,
    });
  }

  public runDatabaseCheck(params?: {
    exchange?: ExchangeId;
    mode?: 'live' | 'demo';
    createBackup?: boolean;
    simulateBusyRetries?: number;
  }): SystemDatabaseHealthResponse {
    const mode = params?.mode ?? this.activeMode;
    const rawExchange = params?.exchange ?? this.activeExchange;
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : rawExchange;
    if (params?.simulateBusyRetries && params.simulateBusyRetries > 0) {
      const statsBefore =
        this.db.getAtomicSmcSnapshot(resolvedExchange).statsVersion;
      this.db.recordServiceRecoveryEvent({
        exchange: resolvedExchange,
        triggerReason: 'SQLITE_RECONNECT',
        recoveredRunningJobsCount: 0,
        statsVersionBefore: statsBefore,
        statsVersionAfter: statsBefore,
        planned: true,
        serviceStoppedNormally: true,
        sqliteReconnected: true,
      });
    }
    const progress = this.getProgressAndHealth(resolvedExchange, mode);
    return this.db.performDatabaseHealthCheck(resolvedExchange, {
      runBackup: params?.createBackup ?? true,
      workerState: progress.workerState,
      monitorWorkerState: progress.monitorWorkerState,
      scanWorkerState: progress.scanWorkerState,
      queueWorkerState: progress.queueWorkerState,
      scannerHealth: progress.scannerHealth,
      queueHealth: progress.queueHealth,
      exchangeApiHealth: progress.exchangeApiHealth,
      stalledSuspected: progress.stalledSuspected,
      stalledReasons: progress.stalledReasons,
      maxConcurrency: this.config.maxConcurrency,
      progressRatePerMinute: progress.progressRatePerMinute,
      progressRateStatus: progress.progressRateStatus,
    });
  }

  public setLongRunningWindowState(
    exchange: ExchangeId,
    durationLabel: Phase17WindowDuration,
    updates: Partial<Phase17LongRunningWindowRecord>,
    nowMs = Date.now(),
    targetMonitoringWindowId?: string
  ): Phase17LongRunningWindowRecord {
    return this.db.setLongRunningWindowState(
      exchange,
      durationLabel,
      updates,
      nowMs,
      targetMonitoringWindowId
    );
  }

  public getMonitoringWindowsList(
    exchange = this.activeExchange,
    nowMs = Date.now()
  ) {
    return this.db.getMonitoringWindowsList(
      exchange,
      nowMs,
      this.config.maxConcurrency
    );
  }

  public getMonitoringWindowDetail(
    monitoringWindowId: string,
    nowMs = Date.now()
  ) {
    return this.db.getMonitoringWindowDetail(
      monitoringWindowId,
      nowMs,
      this.config.maxConcurrency
    );
  }

  public listPhase17CycleSnapshots(
    exchange = this.activeExchange,
    nowMs = Date.now()
  ): Phase17CycleLiveSnapshotRecord[] {
    return this.db.listPhase17CycleSnapshots(
      exchange,
      nowMs,
      this.config.maxConcurrency
    );
  }

  public getPendingReasons(
    exchange = this.activeExchange,
    mode = this.activeMode,
    nowMs = Date.now()
  ) {
    const progress = this.getProgressAndHealth(exchange, mode, nowMs);
    return {
      safety: TRADING_SAFETY_FLAGS,
      exchange: progress.exchange,
      mode: progress.mode,
      monitoringWindowId: progress.monitoringWindowId,
      windowStatus: progress.windowStatus,
      cycleId: progress.cycleId,
      cycleStatus: progress.cycleStatus,
      workerState: progress.workerState,
      monitorWorkerState: progress.monitorWorkerState,
      scanWorkerState: progress.scanWorkerState,
      queueWorkerState: progress.queueWorkerState,
      scannerHealth: progress.scannerHealth,
      queueHealth: progress.queueHealth,
      exchangeApiHealth: progress.exchangeApiHealth,
      totalSymbols: progress.totalSymbols,
      evaluatedCount: progress.evaluatedCount,
      pendingCount: progress.pendingCount,
      queuedCount: progress.queuedCount,
      maxConcurrency: progress.maxConcurrency,
      runningJobCount: progress.runningJobCount,
      concurrencyValid: progress.concurrencyValid,
      statsConsistency: progress.statsConsistency,
      waitingForCacheCount: progress.waitingForCacheCount,
      waitingForRateLimitCount: progress.waitingForRateLimitCount,
      waitingForNextBatchCount: progress.waitingForNextBatchCount,
      retryScheduledCount: progress.retryScheduledCount,
      failedRetryableCount: progress.failedRetryableCount,
      failedCount: progress.failedCount,
      rateLimitedCount: progress.rateLimitedCount,
      lastJobCompletedAt: progress.lastJobCompletedAt,
      lastProgressAt: progress.lastProgressAt,
      progressRatePerMinute: progress.progressRatePerMinute,
      progressRateStatus: progress.progressRateStatus,
      estimatedRemainingDuration: progress.estimatedRemainingDuration,
      oldestPendingAgeMs: progress.oldestPendingAgeMs,
      stalledJobCount: progress.stalledJobCount,
      stalledThresholdMs: progress.stalledThresholdMs,
      stalledSuspected: progress.stalledSuspected,
      stalledReasons: progress.stalledReasons,
      workerRestartCount: progress.workerRestartCount,
      plannedRestartCount: progress.plannedRestartCount,
      unexpectedRestartCount: progress.unexpectedRestartCount,
      leaseRecoveryCount: progress.leaseRecoveryCount,
      databaseRecoveryCount: progress.databaseRecoveryCount,
      windowPlannedRestartCount: progress.windowPlannedRestartCount,
      windowUnexpectedRestartCount: progress.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: progress.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: progress.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: progress.windowStalledDetectedCount,
      windowConcurrencyViolationCount: progress.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: progress.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: progress.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: progress.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: progress.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: progress.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        progress.lifetimeConcurrencyViolationCount,
      pendingBreakdownConsistency: progress.pendingBreakdownConsistency,
      pendingReasonCounts: progress.pendingReasonCounts,
      fastLanePendingCount: progress.fastLanePendingCount,
      bulkPendingCount: progress.bulkPendingCount,
      diagnosisLabel: progress.diagnosisLabel,
      pendingNotices: progress.pendingNotices,
      pendingSymbols: progress.pendingSymbols,
      statsVersion: progress.statsVersion,
      snapshotAt: progress.snapshotAt,
    };
  }

  public getStuckJobs(
    exchange = this.activeExchange,
    mode = this.activeMode,
    nowMs = Date.now()
  ) {
    const progress = this.getProgressAndHealth(exchange, mode, nowMs);
    return {
      safety: TRADING_SAFETY_FLAGS,
      exchange: progress.exchange,
      mode: progress.mode,
      monitoringWindowId: progress.monitoringWindowId,
      windowStatus: progress.windowStatus,
      cycleId: progress.cycleId,
      cycleStatus: progress.cycleStatus,
      workerState: progress.workerState,
      monitorWorkerState: progress.monitorWorkerState,
      scanWorkerState: progress.scanWorkerState,
      queueWorkerState: progress.queueWorkerState,
      scannerHealth: progress.scannerHealth,
      queueHealth: progress.queueHealth,
      exchangeApiHealth: progress.exchangeApiHealth,
      totalSymbols: progress.totalSymbols,
      evaluatedCount: progress.evaluatedCount,
      pendingCount: progress.pendingCount,
      queuedCount: progress.queuedCount,
      maxConcurrency: progress.maxConcurrency,
      runningJobCount: progress.runningJobCount,
      concurrencyValid: progress.concurrencyValid,
      statsConsistency: progress.statsConsistency,
      waitingForCacheCount: progress.waitingForCacheCount,
      waitingForRateLimitCount: progress.waitingForRateLimitCount,
      waitingForNextBatchCount: progress.waitingForNextBatchCount,
      retryScheduledCount: progress.retryScheduledCount,
      failedRetryableCount: progress.failedRetryableCount,
      failedCount: progress.failedCount,
      rateLimitedCount: progress.rateLimitedCount,
      lastJobCompletedAt: progress.lastJobCompletedAt,
      lastProgressAt: progress.lastProgressAt,
      progressRatePerMinute: progress.progressRatePerMinute,
      progressRateStatus: progress.progressRateStatus,
      estimatedRemainingDuration: progress.estimatedRemainingDuration,
      oldestPendingAgeMs: progress.oldestPendingAgeMs,
      stalledJobCount: progress.stalledJobCount,
      stalledThresholdMs: progress.stalledThresholdMs,
      stalledSuspected: progress.stalledSuspected,
      stalledReasons: progress.stalledReasons,
      workerRestartCount: progress.workerRestartCount,
      plannedRestartCount: progress.plannedRestartCount,
      unexpectedRestartCount: progress.unexpectedRestartCount,
      leaseRecoveryCount: progress.leaseRecoveryCount,
      databaseRecoveryCount: progress.databaseRecoveryCount,
      windowPlannedRestartCount: progress.windowPlannedRestartCount,
      windowUnexpectedRestartCount: progress.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: progress.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: progress.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: progress.windowStalledDetectedCount,
      windowConcurrencyViolationCount: progress.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: progress.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: progress.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: progress.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: progress.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: progress.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        progress.lifetimeConcurrencyViolationCount,
      pendingBreakdownConsistency: progress.pendingBreakdownConsistency,
      pendingReasonCounts: progress.pendingReasonCounts,
      fastLanePendingCount: progress.fastLanePendingCount,
      bulkPendingCount: progress.bulkPendingCount,
      diagnosisLabel: progress.diagnosisLabel,
      pendingNotices: progress.pendingNotices,
      stuckJobs: progress.stuckJobs,
      statsVersion: progress.statsVersion,
      snapshotAt: progress.snapshotAt,
    };
  }

  public retryStuckJobs(params?: {
    exchange?: ExchangeId;
    mode?: 'live' | 'demo';
    nowMs?: number;
    stalledThresholdMs?: number;
  }): SmcRetryStuckResponse {
    const mode = params?.mode ?? this.activeMode;
    const rawExchange = params?.exchange ?? this.activeExchange;
    // Never fall back to demo_synthetic when running in live mode
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : rawExchange;
    const nowMs = params?.nowMs ?? Date.now();
    const stalledThresholdMs =
      params?.stalledThresholdMs ?? this.config.stalledThresholdMs ?? 45_000;

    const retryResult = this.db.retryStuckSmcJobs(resolvedExchange, nowMs, {
      stalledThresholdMs,
    });

    if (retryResult.retriedCount > 0) {
      const nowIso = new Date(nowMs).toISOString();
      this.lastProgressAtByExchange.set(resolvedExchange, nowIso);
      if (this.workerState === 'RUNNING') {
        this.scheduleNextTick(10);
      }
    }

    const progress = this.getProgressAndHealth(resolvedExchange, mode, nowMs);

    return {
      ...progress,
      safety: TRADING_SAFETY_FLAGS,
      exchange: resolvedExchange,
      mode,
      cycleId: retryResult.preservedCycleId,
      preservedCycleId: retryResult.preservedCycleId,
      retriedCount: retryResult.retriedCount,
      retriedSymbols: retryResult.retriedSymbols,
      skippedActiveRunningSymbols: retryResult.skippedActiveRunningSymbols,
      skippedRateLimitBackoffSymbols: retryResult.skippedRateLimitBackoffSymbols,
      skippedActiveBackoffSymbols: retryResult.skippedRateLimitBackoffSymbols,
      statsVersion: progress.statsVersion,
      snapshotAt: progress.snapshotAt,
      progress,
    };
  }

  private buildStatusFromAtomicSnapshot(
    atomic: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>,
    resolvedExchange: ExchangeId,
    mode: 'live' | 'demo'
  ): SmcScanStatusResponse {
    const p16 = this.computePhase16DiagnosticsFromAtomic(
      atomic,
      resolvedExchange,
      mode,
      Date.now()
    );
    const estimatedRemainingDuration = p16.estimatedRemainingDuration;
    const estimatedRemainingSeconds =
      estimatedRemainingDuration > 0
        ? Math.ceil(estimatedRemainingDuration / 1000)
        : 0;

    const estimatedRemaining =
      estimatedRemainingSeconds === 0
        ? '0s (已完成或待命)'
        : estimatedRemainingSeconds < 60
          ? `約 ${estimatedRemainingSeconds} 秒`
          : `約 ${Math.ceil(estimatedRemainingSeconds / 60)} 分鐘 (${estimatedRemainingSeconds}s)`;

    return {
      safety: TRADING_SAFETY_FLAGS,
      exchange: resolvedExchange,
      mode,
      monitoringWindowId: p16.monitoringWindowId,
      windowStatus: p16.windowStatus,
      workerState: this.workerState,
      monitorWorkerState: p16.monitorWorkerState,
      scanWorkerState: p16.scanWorkerState,
      queueWorkerState: p16.queueWorkerState,
      workerId: this.workerId,
      scanRunId: atomic.scanRunId,
      scanCycleId: atomic.scanCycleId,
      cycleId: atomic.cycleId,
      cycleStartedAt: atomic.cycleStartedAt,
      cycleCompletedAt: atomic.cycleCompletedAt,
      cycleStatus: p16.cycleStatus,
      fullUniverseStatus:
        p16.pendingBreakdownConsistency === 'INVALID'
          ? 'RUNNING'
          : atomic.fullUniverseStatus,
      lastCompletedCycleId: atomic.lastCompletedCycleId,
      lastCompletedCycleDuration: atomic.lastCompletedCycleDuration,
      statsConsistency:
        p16.pendingBreakdownConsistency === 'INVALID'
          ? 'INVALID'
          : atomic.statsConsistency,
      isColdStartCycle: atomic.isColdStartCycle,
      cacheMode: atomic.cacheMode,
      cacheModeLabel: atomic.cacheModeLabel,
      candidateStatus: atomic.candidateStatus,
      completedScanCyclesCount: atomic.completedScanCyclesCount,
      completedCycles: atomic.completedCycles,
      databaseInstanceId: atomic.databaseInstanceId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      config: this.getConfig(),
      totalSymbols: atomic.totalSymbols,
      totalContracts: atomic.totalContracts,
      totalJobs: atomic.totalJobs,
      totalContractsCount: atomic.totalJobs,
      evaluatedCount: atomic.evaluatedCount,
      totalExpectedHttpRequests: atomic.totalExpectedHttpRequests,
      completedHttpRequests: atomic.completedHttpRequests,
      remainingHttpRequests: atomic.remainingHttpRequests,
      httpRequestsPerSymbol: atomic.httpRequestsPerSymbol,
      httpEndpointsBreakdown: atomic.httpEndpointsBreakdown,
      maxHttpConcurrency: atomic.maxHttpConcurrency,
      maxRequestsPerMinute: atomic.maxRequestsPerMinute,
      currentRequestsInWindow: atomic.currentRequestsInWindow,
      estimatedRemainingDuration,
      estimateStatus: atomic.estimateStatus,
      queuedCount: p16.queuedCount,
      maxConcurrency: p16.maxConcurrency,
      runningJobCount: p16.runningJobCount,
      concurrencyValid: p16.concurrencyValid,
      runningCount: p16.runningJobCount,
      inFlightRequestCount: this.inFlightRequestCount,
      succeededCount: atomic.succeededCount,
      failedCount: atomic.failedCount,
      rateLimitedCount: atomic.rateLimitedCount,
      pendingCount: p16.pendingCount,
      smcPendingCount: p16.pendingCount,
      waitingForCacheCount: p16.waitingForCacheCount,
      waitingForRateLimitCount: p16.waitingForRateLimitCount,
      waitingForNextBatchCount: p16.waitingForNextBatchCount,
      retryScheduledCount: p16.retryScheduledCount,
      failedRetryableCount: p16.failedRetryableCount,
      pendingReasonCounts: p16.pendingReasonCounts,
      fastLanePendingCount: p16.fastLanePendingCount,
      bulkPendingCount: p16.bulkPendingCount,
      lastJobCompletedAt: p16.lastJobCompletedAt,
      lastProgressAt: p16.lastProgressAt,
      progressRatePerMinute: p16.progressRatePerMinute,
      progressRateStatus: p16.progressRateStatus,
      oldestPendingAgeMs: p16.oldestPendingAgeMs,
      stalledJobCount: p16.stalledJobCount,
      stalledThresholdMs: p16.stalledThresholdMs,
      stalledSuspected: p16.stalledSuspected,
      stalledReasons: p16.stalledReasons,
      workerRestartCount: p16.workerRestartCount,
      plannedRestartCount: p16.plannedRestartCount,
      unexpectedRestartCount: p16.unexpectedRestartCount,
      leaseRecoveryCount: p16.leaseRecoveryCount,
      databaseRecoveryCount: p16.databaseRecoveryCount,
      windowPlannedRestartCount: p16.windowPlannedRestartCount,
      windowUnexpectedRestartCount: p16.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: p16.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: p16.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: p16.windowStalledDetectedCount,
      windowConcurrencyViolationCount: p16.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: p16.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: p16.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: p16.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: p16.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: p16.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount: p16.lifetimeConcurrencyViolationCount,
      scannerHealth: p16.scannerHealth,
      queueHealth: p16.queueHealth,
      exchangeApiHealth: p16.exchangeApiHealth,
      pendingBreakdownConsistency: p16.pendingBreakdownConsistency,
      diagnosisLabel: p16.diagnosisLabel,
      pendingNotices: p16.pendingNotices,
      waitCount: atomic.waitCount,
      smcWaitCount: atomic.waitCount,
      watchCount: atomic.watchCount,
      smcWatchCount: atomic.watchCount,
      longCandidateCount: atomic.longCandidateCount,
      smcLongCandidateCount: atomic.longCandidateCount,
      shortCandidateCount: atomic.shortCandidateCount,
      smcShortCandidateCount: atomic.shortCandidateCount,
      highRiskCount: atomic.highRiskCount,
      smcHighRiskCount: atomic.highRiskCount,
      smcGateNotConfirmedCount: atomic.smcGateNotConfirmedCount,
      lastCompletedAt: atomic.lastCompletedAt,
      lastFullRadarScanAt: atomic.lastFullRadarScanAt,
      lastPriorityScanAt: atomic.lastPriorityScanAt,
      radarScanDurationMs: atomic.radarScanDurationMs,
      prewarmDurationMs: atomic.prewarmDurationMs,
      prewarmCacheHitRate: atomic.prewarmCacheHitRate,
      prioritySmcDurationMs: atomic.prioritySmcDurationMs,
      fullCycleDurationMs: atomic.fullCycleDurationMs,
      fullUniverseCompletionDuration: atomic.fullUniverseCompletionDuration,
      fullUniverseCompletionDurationMs: atomic.fullUniverseCompletionDurationMs,
      coldStartFullUniverseCompletionDuration:
        atomic.coldStartFullUniverseCompletionDuration,
      coldStartFullUniverseDuration: atomic.coldStartFullUniverseDuration,
      warmCacheFullUniverseCompletionDuration:
        atomic.warmCacheFullUniverseCompletionDuration,
      warmFullUniverseDuration: atomic.warmFullUniverseDuration,
      queueWaitMs: atomic.queueWaitMs,
      prewarmWaitMs: atomic.prewarmWaitMs,
      httpRequestLatencyMs: atomic.httpRequestLatencyMs,
      smcCalculationLatencyMs: atomic.smcCalculationLatencyMs,
      dbWriteLatencyMs: atomic.dbWriteLatencyMs,
      smcEvaluationLatencyMs: atomic.smcEvaluationLatencyMs,
      rateLimitWaitMs: atomic.rateLimitWaitMs,
      detectionLatencyMs: atomic.detectionLatencyMs,
      p50DetectionLatencyMs: atomic.p50DetectionLatencyMs,
      p90DetectionLatencyMs: atomic.p90DetectionLatencyMs,
      p95DetectionLatencyMs: atomic.p95DetectionLatencyMs,
      p99DetectionLatencyMs: atomic.p99DetectionLatencyMs,
      maxDetectionLatencyMs: atomic.maxDetectionLatencyMs,
      p50PriorityDetectionLatencyMs: atomic.p50PriorityDetectionLatencyMs,
      p90PriorityDetectionLatencyMs: atomic.p90PriorityDetectionLatencyMs,
      p95PriorityDetectionLatencyMs: atomic.p95PriorityDetectionLatencyMs,
      p99PriorityDetectionLatencyMs: atomic.p99PriorityDetectionLatencyMs,
      maxPriorityDetectionLatencyMs: atomic.maxPriorityDetectionLatencyMs,
      p50BulkQueueWaitMs: atomic.p50BulkQueueWaitMs,
      p90BulkQueueWaitMs: atomic.p90BulkQueueWaitMs,
      p95BulkQueueWaitMs: atomic.p95BulkQueueWaitMs,
      p99BulkQueueWaitMs: atomic.p99BulkQueueWaitMs,
      maxBulkQueueWaitMs: atomic.maxBulkQueueWaitMs,
      p50FullUniverseDetectionLatencyMs:
        atomic.p50FullUniverseDetectionLatencyMs,
      p90FullUniverseDetectionLatencyMs:
        atomic.p90FullUniverseDetectionLatencyMs,
      p95FullUniverseDetectionLatencyMs:
        atomic.p95FullUniverseDetectionLatencyMs,
      p99FullUniverseDetectionLatencyMs:
        atomic.p99FullUniverseDetectionLatencyMs,
      maxFullUniverseDetectionLatencyMs:
        atomic.maxFullUniverseDetectionLatencyMs,
      priorityDetectionLatency: atomic.priorityDetectionLatency,
      bulkUniverseQueueLatency: atomic.bulkUniverseQueueLatency,
      bulkQueueWait: atomic.bulkQueueWait,
      fullUniverseCompletionLatency: atomic.fullUniverseCompletionLatency,
      coldStartPriorityDetectionLatency:
        atomic.coldStartPriorityDetectionLatency,
      warmCachePriorityDetectionLatency:
        atomic.warmCachePriorityDetectionLatency,
      priorityDetectionSLA: atomic.priorityDetectionSLA,
      coldStartPrioritySLA: atomic.coldStartPrioritySLA,
      warmCachePrioritySLA: atomic.warmCachePrioritySLA,
      coldStartFullUniverseSLA: atomic.coldStartFullUniverseSLA,
      coldStartP50: atomic.coldStartP50,
      coldStartP95: atomic.coldStartP95,
      warmCacheP50: atomic.warmCacheP50,
      warmCacheP95: atomic.warmCacheP95,
      priorityExecutionBreakdown: atomic.priorityExecutionBreakdown,
      latencyBreakdown: atomic.latencyBreakdown,
      slowestSymbolsTop20: atomic.slowestSymbolsTop20,
      cacheHitCount: atomic.cacheHitCount,
      cacheMissCount: atomic.cacheMissCount,
      cacheHitRate: atomic.cacheHitRate,
      cacheMissRate: atomic.cacheMissRate,
      cacheCoverage: atomic.cacheCoverage,
      cacheCoverageRate: atomic.cacheCoverageRate,
      freshCacheCount: atomic.freshCacheCount,
      expiredCacheCount: atomic.expiredCacheCount,
      staleCacheCount: atomic.staleCacheCount,
      prewarmRequiredCount: atomic.prewarmRequiredCount,
      '5mCoverage': atomic['5mCoverage'],
      '15mCoverage': atomic['15mCoverage'],
      '1hCoverage': atomic['1hCoverage'],
      '4hCoverage': atomic['4hCoverage'],
      '5mCacheCoverage': atomic['5mCacheCoverage'],
      '15mCacheCoverage': atomic['15mCacheCoverage'],
      '1hCacheCoverage': atomic['1hCacheCoverage'],
      '4hCacheCoverage': atomic['4hCacheCoverage'],
      oiCacheCoverage: atomic.oiCacheCoverage,
      fundingCacheCoverage: atomic.fundingCacheCoverage,
      cacheStatus:
        this.isPrewarmingByExchange.get(resolvedExchange) === true
          ? '正在預熱'
          : atomic.cacheStatus,
      cacheStatusLabel:
        this.isPrewarmingByExchange.get(resolvedExchange) === true
          ? '正在預熱'
          : atomic.cacheStatusLabel,
      latestPrewarmSnapshot: atomic.latestPrewarmSnapshot,
      prewarmTasks: atomic.prewarmTasks,
      priorityRefreshCount: atomic.priorityRefreshCount,
      rateLimitCount: atomic.rateLimitCount,
      failedJobCount: atomic.failedCount,
      estimatedRemainingSeconds,
      estimatedRemaining,
      freshnessSummary: {
        freshCount: atomic.freshCount,
        staleCount: atomic.staleCount,
        newestEvaluatedAt: atomic.newestEvaluatedAt,
        oldestEvaluatedAt: atomic.oldestEvaluatedAt,
      },
      recentJobs: atomic.recentJobs,
      ...(() => {
        const diag = this.db.computeCycleDiagnosticsAndFunnel(resolvedExchange);
        return {
          aggregationScope: diag.aggregationScope,
          evaluationUniverseSize: diag.evaluationUniverseSize,
          evaluatedDenominator: diag.evaluatedDenominator,
          excludedCount: diag.excludedCount,
          excludedSymbols: diag.excludedSymbols,
          excludedReasons: diag.excludedReasons,
          consistencyErrors: diag.consistencyErrors,
          candidateFunnel: diag.candidateFunnel,
          currentCycleFunnel: diag.currentCycleFunnel,
          latestSnapshotFunnel: diag.latestSnapshotFunnel,
          monitoringWindowFunnel: diag.monitoringWindowFunnel,
          cumulativeFunnel: diag.cumulativeFunnel,
          historicalSignalsOutsideCurrentCycle:
            diag.historicalSignalsOutsideCurrentCycle,
          historicalSignalsOutsideWindow: diag.historicalSignalsOutsideWindow,
          formalCandidateLatencySla: diag.formalCandidateLatencySla,
          DEMO_LATENCY_FIXTURE: diag.DEMO_LATENCY_FIXTURE,
          LIVE_FORMAL_CANDIDATE_COUNT: diag.LIVE_FORMAL_CANDIDATE_COUNT,
          LIVE_FAST_LANE_COUNT: diag.LIVE_FAST_LANE_COUNT,
          LIVE_BULK_COUNT: diag.LIVE_BULK_COUNT,
          LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
            diag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
          LIVE_ENTRY_WINDOW_MISSED_COUNT: diag.LIVE_ENTRY_WINDOW_MISSED_COUNT,
          LIVE_DETECTION_LATENCY_P50: diag.LIVE_DETECTION_LATENCY_P50,
          LIVE_DETECTION_LATENCY_P95: diag.LIVE_DETECTION_LATENCY_P95,
          LIVE_FAST_LANE_DETECTION_LATENCY_P50:
            diag.LIVE_FAST_LANE_DETECTION_LATENCY_P50,
          LIVE_FAST_LANE_DETECTION_LATENCY_P95:
            diag.LIVE_FAST_LANE_DETECTION_LATENCY_P95,
          LIVE_BULK_DETECTION_LATENCY_P50: diag.LIVE_BULK_DETECTION_LATENCY_P50,
          LIVE_BULK_DETECTION_LATENCY_P95: diag.LIVE_BULK_DETECTION_LATENCY_P95,
          smcGateDiagnostics: diag.smcGateDiagnostics,
          paperEligibilityAudit: diag.paperEligibilityAudit,
          scopedGateStatistics: diag.smcGateDiagnostics.scopedGateStatistics,
          observationShadowComparison:
            diag.smcGateDiagnostics.observationShadowComparison,
          nearMissCount: diag.nearMissCount,
          nearMissMissing1Count: diag.nearMissMissing1Count,
          nearMissMissing2Count: diag.nearMissMissing2Count,
          nearMissMissingGates: diag.nearMissMissingGates,
          lastBlockingGate: diag.lastBlockingGate,
          blockedAfterSmcCandidateCount: diag.blockedAfterSmcCandidateCount,
          blockedAfterSmcCandidateReasons: diag.blockedAfterSmcCandidateReasons,
          blockedByPaperEligibilityCount: diag.blockedByPaperEligibilityCount,
          blockedByPaperEligibilityReasons:
            diag.blockedByPaperEligibilityReasons,
          formalCandidateCount: diag.formalCandidateCount,
          fastLaneFormalCandidateCount: diag.fastLaneFormalCandidateCount,
          bulkFormalCandidateCount: diag.bulkFormalCandidateCount,
          candidateDetectedBeforeEntryWindowCount:
            diag.candidateDetectedBeforeEntryWindowCount,
          entryWindowMissedRate: diag.entryWindowMissedRate,
          candidateDetectionLatencyP50: diag.candidateDetectionLatencyP50,
          candidateDetectionLatencyP95: diag.candidateDetectionLatencyP95,
          queueWaitP50: diag.queueWaitP50,
          queueWaitP95: diag.queueWaitP95,
          eligiblePaperSignalCount: diag.eligiblePaperSignalCount,
          paperEligibleCount: diag.eligiblePaperSignalCount,
          currentCyclePaperEligibleCount: diag.currentCyclePaperEligibleCount,
          monitoringWindowPaperEligibleCount:
            diag.monitoringWindowPaperEligibleCount,
          cumulativePaperEligibleCount: diag.cumulativePaperEligibleCount,
          historicalPaperEligibleCount: diag.historicalPaperEligibleCount,
          entryWindowMissedCount: diag.entryWindowMissedCount,
          currentCycleEntryWindowMissedCount:
            diag.currentCycleEntryWindowMissedCount,
          monitoringWindowEntryWindowMissedCount:
            diag.monitoringWindowEntryWindowMissedCount,
          cumulativeEntryWindowMissedCount:
            diag.cumulativeEntryWindowMissedCount,
          historicalSignalsOutsideWindowCount:
            diag.historicalSignalsOutsideWindowCount,
          historicalSignalsOutsideCurrentCycleCount:
            diag.historicalSignalsOutsideCurrentCycleCount,
          paperOpenedCount: diag.paperOpenedCount,
          paperClosedCount: diag.paperClosedCount,
          blockedCount: diag.blockedByPaperEligibilityCount,
          candidateDetectedCount: diag.candidateDetectedCount,
          rootCauseVerdict: diag.rootCauseVerdict,
          rootCauseExplanation: diag.rootCauseExplanation,
        };
      })(),
    };
  }

  /**
   * Returns a single atomic SQLite snapshot containing BOTH the SMC evaluation map
   * for `runMarketScan` AND the `SmcScanStatusResponse` so `/api/scan` never suffers
   * from time-skew between candidate counts and queue status counts.
   */
  public getConsistentSmcScanState(
    exchange = this.activeExchange,
    mode = this.activeMode
  ): {
    smcMap: Map<string, ConsistentSmcMapEntry>;
    status: SmcScanStatusResponse;
  } {
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    this.getAvailableRequests(Date.now());
    this.db.updateRuntimeHttpMetrics(resolvedExchange, {
      currentRequestsInWindow: this.requestTimestamps.length,
      maxHttpConcurrency: this.config.maxHttpConcurrency,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
    });
    const atomic = this.db.getAtomicSmcSnapshot(resolvedExchange);
    const smcMap = new Map<string, ConsistentSmcMapEntry>();

    for (const [sym, rec] of atomic.resultsMap.entries()) {
      smcMap.set(sym, {
        smcEvaluationStatus: rec.smcEvaluationStatus,
        evaluationStatus: rec.smcEvaluationStatus,
        actionState: rec.smcActionState,
        waitReasons: rec.waitReasons,
        evaluatedAt: rec.evaluatedAt,
        dataFetchedAt: rec.dataFetchedAt,
        marketRadarCategory: rec.marketRadarCategory,
        finalTradeSignal: rec.finalTradeSignal,
        smcAnalysis: rec.smcAnalysis,
        gateEvaluation: rec.smcAnalysis?.gateEvaluation,
        entryWindowStatus:
          rec.entryWindowStatus === 'DETECTED_BEFORE_NEXT_BAR_OPEN' ||
          rec.entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
          rec.entryWindowStatus === 'NOT_APPLICABLE'
            ? rec.entryWindowStatus
            : undefined,
        signalBarCloseTime: rec.signalBarCloseTime ?? null,
        nextBarOpenTime: rec.nextBarOpenTime ?? null,
        detectionLatencyMs: rec.candidateDetectionLatencyMs ?? rec.detectionLatencyMs ?? null,
        candidateDetectionLatencyMs: rec.candidateDetectionLatencyMs ?? rec.detectionLatencyMs ?? null,
        evaluationLatencyMs: rec.evaluationLatencyMs ?? rec.smcEvaluationLatencyMs ?? null,
        nextBarRemainingMs: rec.nextBarRemainingMs ?? null,
        queueWaitMs: rec.queueWaitMs ?? null,
        smcEvaluationLatencyMs: rec.smcEvaluationLatencyMs ?? null,
        queueEnteredAt: rec.queueEnteredAt ?? null,
        smcEvaluationStartedAt:
          rec.smcEvaluationStartedAt ?? rec.evaluationStartedAt ?? null,
        smcEvaluationCompletedAt:
          rec.smcEvaluationCompletedAt ??
          rec.evaluationCompletedAt ??
          rec.evaluatedAt ??
          null,
        entryWindowDelayMs: rec.entryWindowDelayMs ?? null,
        isFastLane: rec.isFastLane ?? false,
        paperEligibilityStatus: rec.paperEligibilityStatus,
        candidateDetectedAt: rec.candidateDetectedAt ?? null,
        signalDetectedAt: rec.signalDetectedAt ?? null,
        paperOpenedAt: rec.paperOpenedAt ?? null,
        entryWindowMissed: rec.entryWindowMissed ?? null,
        blockedReason: rec.blockedReason ?? null,
      });
    }

    const status = this.buildStatusFromAtomicSnapshot(
      atomic,
      resolvedExchange,
      mode
    );

    return { smcMap, status };
  }

  public getStatus(
    exchange = this.activeExchange,
    mode = this.activeMode
  ): SmcScanStatusResponse {
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    this.getAvailableRequests(Date.now());
    this.db.updateRuntimeHttpMetrics(resolvedExchange, {
      currentRequestsInWindow: this.requestTimestamps.length,
      maxHttpConcurrency: this.config.maxHttpConcurrency,
      maxRequestsPerMinute: this.config.maxRequestsPerMinute,
    });
    const atomic = this.db.getAtomicSmcSnapshot(resolvedExchange);
    return this.buildStatusFromAtomicSnapshot(atomic, resolvedExchange, mode);
  }

  public getSymbolResult(
    exchange: ExchangeId,
    symbol: string,
    mode: 'live' | 'demo' = 'live'
  ) {
    const cleanSymbol = symbol.trim().toUpperCase();
    const resolvedExchange: ExchangeId =
      mode === 'demo' ? 'demo_synthetic' : exchange;
    const atomic = this.db.getAtomicSmcSnapshot(resolvedExchange);
    const result = atomic.resultsMap.get(cleanSymbol) ?? null;
    const jobs = this.db.listSmcScanJobs(resolvedExchange, 600);
    const latestJob = jobs.find((j) => j.symbol === cleanSymbol) ?? null;

    return {
      safety: TRADING_SAFETY_FLAGS,
      symbol: cleanSymbol,
      exchange: resolvedExchange,
      mode,
      scanRunId: atomic.scanRunId,
      scanCycleId: result?.scanCycleId ?? atomic.scanCycleId,
      databaseInstanceId: atomic.databaseInstanceId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      totalJobs: atomic.totalJobs,
      runningJobCount: atomic.runningJobCount,
      inFlightRequestCount: this.inFlightRequestCount,
      smcEvaluationStatus: result?.smcEvaluationStatus ?? 'PENDING',
      smcActionState: result?.smcActionState ?? 'PENDING',
      marketRadarCategory: result?.marketRadarCategory ?? null,
      finalTradeSignal: result?.finalTradeSignal ?? 'NONE',
      evaluatedAt: result?.evaluatedAt ?? null,
      dataFetchedAt: result?.dataFetchedAt ?? null,
      fetchedAt: result?.fetchedAt ?? result?.dataFetchedAt ?? null,
      freshnessSeconds: result?.freshnessSeconds ?? null,
      stale: result?.stale ?? false,
      fallback: result?.fallback ?? false,
      missingData: result?.missingData ?? [],
      source: result?.source ?? null,
      isDemo: result?.isDemo ?? (mode === 'demo'),
      ruleVersion: result?.ruleVersion ?? SMC_RULE_VERSION,
      result,
      latestJob,
    };
  }

  public stop(): void {
    this.workerState = 'PAUSED';
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }
}
