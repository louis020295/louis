export type Timeframe = '5m' | '15m' | '1h' | '4h';

export type ExchangeId =
  | 'binance_usdm'
  | 'bybit_linear'
  | 'bingx_swap'
  | 'demo_synthetic';

export type ExchangeStatus = 'LIVE' | 'TODO_PHASE_2' | 'DEMO_ONLY';

export interface SupportedExchangeInfo {
  id: ExchangeId;
  displayName: string;
  enabled: boolean;
  isDemo: boolean;
  status: ExchangeStatus;
}

export type ScanCategory = '準備觀察' | '多頭候選' | '空頭候選' | '高風險';

export type MarketRadarCategory =
  | '雷達多頭觀察'
  | '雷達空頭觀察'
  | '準備觀察'
  | '高風險';

export type SmcEvaluationStatus = 'PENDING' | 'EVALUATED';

export type SmcActionState =
  | 'PENDING'
  | 'WAIT'
  | 'WATCH'
  | 'LONG CANDIDATE'
  | 'SHORT CANDIDATE'
  | 'HIGH RISK';

export const TRADING_SAFETY_FLAGS = {
  mode: 'PAPER ONLY',
  liveOrders: 'LIVE ORDERS DISABLED',
  executionPolicy: 'NEVER AUTO-PLACE ORDERS',
} as const;

export type VolumeTimeframe = '15m' | '24h';

export interface DataProvenance {
  source: string;
  fetchedAt: string;
  stale: boolean;
  fallback: boolean;
  missingData: string[];
  isDemo: boolean;
  isTestFixture?: boolean;
  volumeTimeframe?: VolumeTimeframe;
  aggregationWindow?: string;
  volumeMetric?: 'quoteVolume';
}

export interface MarketTicker {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Present when the adapter attached venue instrument metadata. */
  instrument?: {
    assetClass: 'crypto' | 'tradfi' | 'unverified';
    underlying: string | null;
    symbolType: string | null;
    metadataAvailable: boolean;
  };
  lastPrice: number;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  latestConfirmed15mQuoteVolume?: number | null;
  bidPrice?: number | null;
  askPrice?: number | null;
  spread?: number | null;
  spreadPercent?: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  provenance: DataProvenance;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  isClosed: boolean;
}

export interface HistoricalVolumeMetrics {
  symbol: string;
  exchange: ExchangeId;
  volumeTimeframe: VolumeTimeframe;
  aggregationWindow: string;
  volumeMetric: 'quoteVolume';
  sampleCount: number;
  minRequiredSamples: number;
  currentVolume: number;
  historicalSamples?: number[];
  rollingMedian: number | null;
  mad: number | null;
  madToMedianRatio?: number | null;
  rawRobustZScore?: number | null;
  unstableReason?:
    | 'NON_POSITIVE_BASELINE'
    | 'MAD_RATIO_TOO_SMALL'
    | 'EXTREME_ROBUST_ZSCORE_OUTLIER'
    | null;
  timeframeMismatchRejected?: boolean;
  rejectionReason?: string | null;
  robustZScore: number | null;
  zScore: number | null;
  rvol: number | null;
  isHistoricalAnomaly: boolean;
  baselineUnstable: boolean;
  status: 'READY' | 'INSUFFICIENT_HISTORY' | 'BASELINE_UNSTABLE';
  provenance: DataProvenance;
}

export interface EvidenceItem {
  code:
    | 'HIST_VOL_ANOMALY'
    | 'AUX_VOL_RANK_PROXY'
    | 'VOL_RANK_PROXY'
    | 'PRICE_MOMENTUM_24H'
    | 'REL_BTC_STRENGTH'
    | 'FUNDING_RISK'
    | 'LIQUIDITY_RISK'
    | 'DATA_QUALITY'
    | string;
  label: string;
  passed: boolean;
  value: string;
  weight: number;
  detail: string;
}

export interface ScoreBreakdown {
  volumeAnomaly: number;
  auxiliaryVolumeRank: number;
  volumeProxy: number;
  momentum: number;
  relativeBtcStrength: number;
  fundingRisk: number;
  liquidityRisk: number;
  dataQuality: number;
}

export interface SymbolDecisionGates {
  history: {
    volumeTimeframe?: VolumeTimeframe;
    aggregationWindow?: string;
    volumeMetric?: 'quoteVolume';
    sampleCount: number;
    minRequiredSamples: number;
    status: 'READY' | 'INSUFFICIENT_HISTORY' | 'BASELINE_UNSTABLE';
    passed: boolean;
    currentVolume?: number | null;
    rollingMedian?: number | null;
    mad?: number | null;
    madToMedianRatio?: number | null;
    rawRobustZScore?: number | null;
    unstableReason?: string | null;
    timeframeMismatchRejected?: boolean;
    rejectionReason?: string | null;
  };
  liquidity: {
    quoteVolume24h: number;
    spreadPercent: number | null;
    passed: boolean;
  };
  momentum: {
    change24h: number;
    passed: boolean;
  };
  relativeBtc: {
    value: number;
    passed: boolean;
  };
  funding: {
    value: number | null;
    passed: boolean;
  };
  smc: {
    evaluationStatus: SmcEvaluationStatus;
    actionState: SmcActionState;
    passed: boolean;
    reason?: string;
    waitReasons?: string[];
  };
}

export type FinalTradeSignal = 'NONE' | '多頭交易候選' | '空頭交易候選';

export type NearMissStatus =
  | 'NEAR_MISS_ONE_GATE'
  | 'NEAR_MISS_TWO_GATES'
  | 'NOT_NEAR_CANDIDATE';

export type PaperEligibilityStatus =
  | 'ELIGIBLE'
  | 'BLOCKED'
  | 'NOT_CANDIDATE';

export type GateStatisticScope =
  | 'ALL_EVALUATED'
  | 'NEAR_MISS_ONLY'
  | 'CANDIDATE_ELIGIBLE_ONLY';

export type SignalRuleMode =
  | 'STRICT_PRODUCTION'
  | 'OBSERVATION_SHADOW'
  | 'OBSERVATION_SHADOW_ONE_GATE_MISSING'
  | 'OBSERVATION_SHADOW_TWO_GATES_MISSING';

export interface SymbolFunnelDiagnosticRecord {
  symbol: string;
  marketRadarCategory: MarketRadarCategory;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  paperEligibilityStatus: PaperEligibilityStatus;
  candidateDetectedAt: string | null;
  signalDetectedAt: string | null;
  paperOpenedAt: string | null;
  entryWindowMissed: boolean | null;
  blockedReason: string | null;
  missingGates: string[];
  detectionLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  evaluationLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  queueWaitMs: number | null;
  smcEvaluationLatencyMs: number | null;
  nearMissStatus: NearMissStatus;
  queueEnteredAt?: string | null;
  evaluationStartedAt?: string | null;
  evaluationCompletedAt?: string | null;
  nextBarOpenTime?: number | null;
  entryWindowDelayMs?: number | null;
  entryWindowStatus?: string | null;
  isFastLane?: boolean;
  ruleMode?: 'STRICT_PRODUCTION';
}

export interface SymbolDecisionTrace {
  symbol: string;
  categoryBeforeGates: ScanCategory;
  marketRadarCategory: MarketRadarCategory;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  finalCategory: ScanCategory;
  smcEvaluatedAt?: string | null;
  smcDataFetchedAt?: string | null;
  smcDataFreshnessSeconds?: number | null;
  score: number;
  rawScoreBeforeCap: number;
  scoreCapApplied: boolean;
  scoreCapRule: string | null;
  scoreBreakdown: ScoreBreakdown;
  gates: SymbolDecisionGates;
  downgradeReasons: string[];
  gateEvaluation?: SymbolSmcGateEvaluation;
  nearMissStatus?: NearMissStatus;
  paperEligibilityStatus?: PaperEligibilityStatus;
  candidateDetectedAt?: string | null;
  signalDetectedAt?: string | null;
  paperOpenedAt?: string | null;
  entryWindowMissed?: boolean | null;
  blockedReason?: string | null;
  missingGates?: string[];
  detectionLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  evaluationLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  queueWaitMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  queueEnteredAt?: string | null;
  evaluationStartedAt?: string | null;
  evaluationCompletedAt?: string | null;
  nextBarOpenTime?: number | null;
  entryWindowDelayMs?: number | null;
  entryWindowStatus?: string | null;
}

export interface DecisionTraceApiResponse extends SymbolDecisionTrace {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'live' | 'demo';
  exchange: ExchangeId;
  isDemo: boolean;
  fallback: boolean;
  cycleId: string;
  scanCycleId: string;
  snapshotAt: string;
  statsVersion: number;
  gateEvaluation?: SymbolSmcGateEvaluation;
  twoLayerResult: {
    marketRadar: string;
    marketRadarCategory: MarketRadarCategory;
    smcEvaluationStatus: SmcEvaluationStatus;
    smcIctState: SmcActionState;
    finalTradeSignal: FinalTradeSignal;
    finalCategory: ScanCategory;
    reason: string;
  };
  diagnostics: {
    why30Of30NotReady: string;
    isBaselineUnstable: boolean;
    madToRollingMedianRatio: number | null;
    madToRollingMedianPercent: string;
    blockedByLowLiquidityGate: boolean;
    downgradedOnlyBySmcWait: boolean;
    score48Rule: string;
    categoryBeforeGates: ScanCategory;
    marketRadarCategory: MarketRadarCategory;
    smcEvaluationStatus: SmcEvaluationStatus;
    smcActionState: SmcActionState;
    finalTradeSignal: FinalTradeSignal;
    finalCategory: ScanCategory;
    kline15mVolumeDiagnostic?: HistoricalVolumeMetrics | null;
  };
  provenance: DataProvenance;
}

export interface ScannedCandidate {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  bidPrice: number | null;
  askPrice: number | null;
  spread: number | null;
  spreadPercent: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  historicalVolume: HistoricalVolumeMetrics;
  auxiliaryVolumeRankProxyPercentile: number;
  volumeRankProxyPercentile: number;
  momentumScore: number;
  relativeBtcStrength: number;
  isLowLiquidity: boolean;
  extremeFunding: boolean;
  lowLiquidityHighVolatility: boolean;
  category: ScanCategory;
  categoryBeforeGates: ScanCategory;
  finalCategory: ScanCategory;
  finalTradeSignal: FinalTradeSignal;
  marketRadarCategory: MarketRadarCategory;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  smcStatusReason: string;
  smcEvaluatedAt?: string | null;
  smcDataFetchedAt?: string | null;
  smcDataFreshnessSeconds?: number | null;
  score: number;
  rawScoreBeforeCap: number;
  scoreCapApplied: boolean;
  scoreCapRule: string | null;
  scoreBreakdown: ScoreBreakdown;
  gates: SymbolDecisionGates;
  downgradeReasons: string[];
  decisionTrace: SymbolDecisionTrace;
  gateEvaluation?: SymbolSmcGateEvaluation;
  nearMissStatus?: NearMissStatus;
  paperEligibilityStatus?: PaperEligibilityStatus;
  candidateDetectedAt?: string | null;
  signalDetectedAt?: string | null;
  paperOpenedAt?: string | null;
  entryWindowMissed?: boolean | null;
  blockedReason?: string | null;
  missingGates?: string[];
  detectionLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  evaluationLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  queueWaitMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  queueEnteredAt?: string | null;
  evaluationStartedAt?: string | null;
  evaluationCompletedAt?: string | null;
  nextBarOpenTime?: number | null;
  entryWindowDelayMs?: number | null;
  entryWindowStatus?: string | null;
  isFastLane?: boolean;
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
  evidences: EvidenceItem[];
  provenance: DataProvenance;
}

export interface MarketScannerConfig {
  MIN_QUOTE_VOLUME_24H: number;
  MAX_ALLOWED_SPREAD_PERCENT: number;
  LOW_LIQUIDITY_POLICY: 'ONLY_HIGH_RISK_OR_WATCH_OR_WAIT';
}

export interface WaitWatchReasonStatistics {
  /** 統計範圍說明 (例如 "EVALUATED_WAIT_WATCH_ONLY", "EVALUATED_HIGH_RISK_ONLY", "EVALUATED_NON_CANDIDATE_ALL") */
  scope?: string;
  /** 已實際完成 SMC 評估且屬於該統計範圍之不重複幣種數 */
  uniqueSymbolCount: number;
  /** 原因出現總次數 (單一幣種可同時觸發多個原因) */
  totalReasonOccurrences: number;
  /** 各原因出現次數 (可重疊，可能總和 >= uniqueSymbolCount) */
  reasonOccurrenceCount: Record<string, number>;
  /** 互斥主原因統計 (每個幣種僅計入 1 項主原因，總和嚴格等於 uniqueSymbolCount) */
  mutuallyExclusivePrimaryReasonCount: Record<string, number>;
}

export interface RadarGateReasonStatistics {
  /** 全部掃描之不重複幣種數 (等於 totalContractsScanned) */
  uniqueSymbolCount: number;
  /** 第一層雷達降級原因出現總次數 (單一幣種可同時觸發多項降級原因) */
  totalReasonOccurrences: number;
  /** 各第一層降級原因出現次數 (可重疊) */
  reasonOccurrenceCount: Record<string, number>;
  /** 第一層互斥主狀態統計 (每個幣種僅歸入 1 個互斥主分類，總和嚴格等於 uniqueSymbolCount) */
  mutuallyExclusivePrimaryReasonCount: Record<string, number>;
}

export interface FullMarketGateStatistics {
  totalContractsScanned: number;
  insufficientHistoryCount: number;
  baselineUnstableCount: number;
  liquidityRejectedCount: number;
  momentumPassedCount: number;
  relativeBtcPassedCount: number;
  marketRadarLongCount: number;
  marketRadarShortCount: number;
  smcPendingCount: number;
  smcWaitCount: number;
  smcWatchCount: number;
  smcHighRiskCount: number;
  smcGateNotConfirmedCount: number;
  finalCategorySmcMismatchCount: number;
  smcLongCandidateCount: number;
  smcShortCandidateCount: number;
}

export interface DataQualityReport extends FullMarketGateStatistics {
  totalSymbolsScanned: number;
  validSymbolsCount: number;
  missingFundingCount: number;
  missingSpreadCount: number;
  staleRecordCount: number;
  lowLiquidityCount: number;
  extremeFundingCount: number;
  historicalVolumeReadyCount?: number;
  scannerConfig: MarketScannerConfig;
  volumeProxyNotice: string;
  generatedAt: string;
  source: string;
  isDemo: boolean;
}

export interface MarketScanResponse extends FullMarketGateStatistics {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'live' | 'demo';
  exchange: ExchangeId;
  isDemo: boolean;
  fallback: boolean;
  source: string;
  fetchedAt: string;
  stale: boolean;
  missingData: string[];
  ruleVersion: string;
  btcBenchmarkChange24h: number | null;
  candidates: ScannedCandidate[];
  summaryCounts: Record<ScanCategory, number>;
  marketRadarCounts: Record<MarketRadarCategory, number>;
  smcStateCounts: Record<SmcActionState, number>;
  waitWatchReasonBreakdown: Record<string, number>;
  /** 僅統計已評估 WAIT + WATCH (不含 HIGH RISK 與 PENDING) */
  waitWatchReasonStats: WaitWatchReasonStatistics;
  /** 僅統計已評估 HIGH RISK (不含 WAIT、WATCH 與 PENDING) */
  highRiskReasonStats: WaitWatchReasonStatistics;
  /** 統計所有已評估未通過 SMC Gate 標的 (WAIT + WATCH + HIGH RISK) */
  nonCandidateReasonStats: WaitWatchReasonStatistics;
  radarGateReasonStats: RadarGateReasonStatistics;
  marketStats: FullMarketGateStatistics;
  dataQuality: DataQualityReport;
  provenance: DataProvenance;
  scanRunId?: string;
  databaseInstanceId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  totalJobs?: number;
  runningJobCount?: number;
  inFlightRequestCount?: number;
  smcScanStatus?: SmcScanStatusResponse;
  cacheCoverage?: number;
  cacheCoverageRate?: number;
  freshCacheCount?: number;
  expiredCacheCount?: number;
  staleCacheCount?: number;
  cacheHitCount?: number;
  cacheMissCount?: number;
  prewarmRequiredCount?: number;
  '5mCoverage'?: number;
  '15mCoverage'?: number;
  '1hCoverage'?: number;
  '4hCoverage'?: number;
  '5mCacheCoverage'?: number;
  '15mCacheCoverage'?: number;
  '1hCacheCoverage'?: number;
  '4hCacheCoverage'?: number;
  oiCacheCoverage?: number;
  fundingCacheCoverage?: number;
  cacheStatus?: SmcCacheUiStatus;
  cacheStatusLabel?: SmcCacheUiStatus;
  latestPrewarmSnapshot?: SmcPrewarmSnapshotRecord | null;
  prewarmTasks?: SmcPrewarmTaskRecord[];
  priorityDetectionSLA?: SmcSlaStatus;
  warmCachePrioritySLA?: SmcSlaStatus;
  coldStartPrioritySLA?: SmcSlaStatus;
  fullUniverseStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED';
  fullUniverseCompletionDuration?: number | null;
  coldStartFullUniverseDuration?: number | null;
  warmFullUniverseDuration?: number | null;
  coldStartFullUniverseSLA?: SmcSlaStatus;
  cycleId?: string;
  scanCycleId?: string;
  cycleStatus?: 'RUNNING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'INCONSISTENT';
  cycleStartedAt?: string | null;
  cycleCompletedAt?: string | null;
  lastCompletedCycleId?: string | null;
  lastCompletedCycleDuration?: number | null;
  evaluatedCount?: number;
  pendingCount?: number;
  queuedCount?: number;
  succeededCount?: number;
  failedCount?: number;
  rateLimitedCount?: number;
  waitCount?: number;
  watchCount?: number;
  highRiskCount?: number;
  longCandidateCount?: number;
  shortCandidateCount?: number;
  totalSymbols?: number;
  statsConsistency?: 'VALID' | 'INVALID';
  totalExpectedHttpRequests?: number;
  completedHttpRequests?: number;
  remainingHttpRequests?: number;
  httpRequestsPerSymbol?: number;
  httpEndpointsBreakdown?: {
    '5m': number;
    '15m': number;
    '1h': number;
    '4h': number;
    openInterest: number;
    fundingRate: number;
  };
  maxHttpConcurrency?: number;
  maxRequestsPerMinute?: number;
  currentRequestsInWindow?: number;
  rateLimitCount?: number;
  estimatedRemainingDuration?: number;
  estimateStatus?:
    | 'COMPLETED'
    | 'ESTIMATING_WITH_CACHE_DEDUCTION'
    | 'RATE_LIMIT_BACKOFF'
    | 'FAILED'
    | 'IDLE';
  cacheMode?: SmcCacheMode;
  cacheModeLabel?: string;
  candidateFunnel?: CycleCandidateFunnel;
  smcGateDiagnostics?: SmcGateDiagnosticsSummary;
  paperEligibilityAudit?: PaperEligibilityAuditSummary;
  scopedGateStatistics?: ScopedGateStatisticsSummary;
  observationShadowComparison?: ObservationShadowComparisonSummary;
  symbolFunnelDiagnostics?: SymbolFunnelDiagnosticRecord[];
  nearMissCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  nearMissMissingGates?: Record<string, number>;
  lastBlockingGate?: string | null;
  blockedAfterSmcCandidateCount?: number;
  blockedAfterSmcCandidateReasons?: Record<string, number>;
  blockedByPaperEligibilityCount?: number;
  blockedByPaperEligibilityReasons?: Record<string, number>;
  eligiblePaperSignalCount?: number;
  paperEligibleCount?: number;
  entryWindowMissedCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  formalCandidateCount?: number;
  fastLaneFormalCandidateCount?: number;
  bulkFormalCandidateCount?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  entryWindowMissedRate?: number | null;
  candidateDetectionLatencyP50?: number | null;
  candidateDetectionLatencyP95?: number | null;
  queueWaitP50?: number | null;
  queueWaitP95?: number | null;
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  paperOpenedCount?: number;
  paperClosedCount?: number;
  blockedCount?: number;
  candidateDetectedCount?: number;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  consistencyErrors?: string[];
  rootCauseVerdict?: CandidateScarcityRootCauseVerdict;
  rootCauseExplanation?: string;
  apiError?: string;
  apiErrorDetail?: string;
}

export interface CrossExchangeVenueLeg {
  exchange: ExchangeId;
  displayName: string;
  available: boolean;
  assetClass?: 'crypto' | 'tradfi' | 'unverified';
  underlying?: string | null;
  symbolType?: string | null;
  /** False when this leg is shown but excluded from price/funding/OI math. */
  comparisonIncluded?: boolean;
  lastPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  spread: number | null;
  spreadPercent: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  quoteVolume24h: number | null;
  provenance: DataProvenance;
}

export interface CrossExchangeDivergenceItem {
  symbol: string;
  venuesPresent: ExchangeId[];
  legs: Record<'binance_usdm' | 'bybit_linear' | 'bingx_swap', CrossExchangeVenueLeg>;
  maxPriceExchange: ExchangeId | null;
  minPriceExchange: ExchangeId | null;
  priceDivergencePercent: number | null;
  maxFundingExchange: ExchangeId | null;
  minFundingExchange: ExchangeId | null;
  fundingDivergenceBps: number | null;
  spreadDivergencePercent: number | null;
  totalOpenInterestUsd: number | null;
  oiShareByExchange: Partial<Record<ExchangeId, number | null>>;
  oiDivergencePercent: number | null;
  divergenceFlags: string[];
  provenance: DataProvenance;
}

export interface CrossExchangeDivergenceResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'live' | 'demo';
  isDemo: boolean;
  fallback: boolean;
  generatedAt: string;
  venueStatuses: Record<
    'binance_usdm' | 'bybit_linear' | 'bingx_swap',
    {
      available: boolean;
      error?: string;
      provenance: DataProvenance;
    }
  >;
  items: CrossExchangeDivergenceItem[];
  provenance: DataProvenance;
}

export interface SmcBosMssEvidence {
  detected: boolean;
  type: 'BOS_BULL' | 'BOS_BEAR' | 'MSS_BULL' | 'MSS_BEAR' | 'NONE';
  brokenLevel: number | null;
  candleTime: number | null;
  description: string;
}

export interface SmcLiquiditySweepEvidence {
  detected: boolean;
  side: 'BUY_SIDE_SWEPT' | 'SELL_SIDE_SWEPT' | 'NONE';
  sweptLevel: number | null;
  candleTime: number | null;
  description: string;
}

export interface SmcDisplacementEvidence {
  detected: boolean;
  direction: 'BULL' | 'BEAR' | 'NONE';
  bodyToAtrRatio: number | null;
  candleTime: number | null;
  description: string;
}

export interface SmcFvgEvidence {
  detected: boolean;
  direction: 'BULL' | 'BEAR' | 'NONE';
  top: number | null;
  bottom: number | null;
  mitigated: boolean;
  candleTime: number | null;
  description: string;
}

export interface SmcOrderBlockEvidence {
  detected: boolean;
  direction: 'BULL' | 'BEAR' | 'NONE';
  high: number | null;
  low: number | null;
  candleTime: number | null;
  description: string;
}

export interface SmcMtfAlignment {
  aligned: boolean;
  dominantDirection: 'BULL' | 'BEAR' | 'CONFLICT' | 'INSUFFICIENT';
  byTimeframe: Record<Timeframe, 'BULL' | 'BEAR' | 'NEUTRAL' | 'MISSING'>;
  description: string;
}

export interface SmcAnalysisResult {
  symbol: string;
  primaryTimeframe: Timeframe;
  ruleVersion: string;
  smcEvaluationStatus: SmcEvaluationStatus;
  actionState: SmcActionState;
  confirmedKlineCount: number;
  unclosedKlineIgnoredCount: number;
  atr14: number | null;
  atrPercent: number | null;
  bosOrMss: SmcBosMssEvidence;
  liquiditySweep: SmcLiquiditySweepEvidence;
  displacement: SmcDisplacementEvidence;
  fvg: SmcFvgEvidence;
  orderBlock: SmcOrderBlockEvidence;
  mtfAlignment: SmcMtfAlignment;
  waitReasons: string[];
  evidences: EvidenceItem[];
  provenance: DataProvenance;
  evaluatedAt?: string;
  dataFetchedAt?: string;
  gateEvaluation?: SymbolSmcGateEvaluation;
  nearMissStatus?: NearMissStatus;
  missingGates?: string[];
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export interface SymbolDetailResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'live' | 'demo';
  exchange: ExchangeId;
  isDemo: boolean;
  fallback: boolean;
  source: string;
  fetchedAt: string;
  stale: boolean;
  missingData: string[];
  symbol: string;
  primaryTimeframe: Timeframe;
  candidate: ScannedCandidate;
  decisionTrace?: SymbolDecisionTrace;
  openInterest: {
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  };
  klinesByTimeframe: Record<
    Timeframe,
    {
      kllinesCount: number;
      confirmedCount: number;
      klines: Kline[];
      provenance: DataProvenance;
    }
  >;
  smcAnalysis: SmcAnalysisResult;
  crossExchange?: CrossExchangeDivergenceItem | null;
  provenance: DataProvenance;
}

export interface GeminiExplainRequest {
  candidate: ScannedCandidate;
  smcAnalysis: SmcAnalysisResult;
}

export interface GeminiExplainResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  symbol: string;
  category: ScanCategory;
  actionState: SmcActionState;
  waitReasons: string[];
  lockedCategory: ScanCategory;
  lockedActionState: SmcActionState;
  explanationZh: string;
  passedConditionsZh: string[];
  missingDataOrWaitReasonsZh: string[];
  riskNotesZh: string[];
  guardrails: {
    ruleEngineOverridden: false;
    containsGuaranteeLanguage: false;
    waitGateEnforced: boolean;
    sourceEvidenceTimestamp: string;
  };
  provenance: DataProvenance;
}

export interface NotificationPayload {
  symbol: string;
  category: ScanCategory;
  actionState: SmcActionState;
  finalTradeSignal?: FinalTradeSignal;
  smcEvaluationStatus?: SmcEvaluationStatus;
  stale?: boolean;
  fallback?: boolean;
  waitReasons?: string[];
  score: number;
  confirmedEvidences: string[];
  missingData: string[];
  riskWarnings: string[];
  source: string;
  fetchedAt: string;
  safetyBanner: string;
  scanRunId?: string;
  scanCycleId?: string | null;
  signalId?: string;
  ruleVersion?: string;
  snapshotAt?: string;
  evaluatedAt?: string;
  dedupeKey?: string;
  cooldownUntil?: string;
  isBacktest?: boolean;
}

export interface NotificationDispatchRecord {
  id: string;
  channel: 'TELEGRAM' | 'TRADINGVIEW_WEBHOOK';
  symbol: string;
  actionState: SmcActionState;
  finalTradeSignal?: FinalTradeSignal;
  category: ScanCategory;
  score: number;
  status:
    | 'PREVIEW_DRY_RUN'
    | 'NON_CANDIDATE_BLOCKED'
    | 'DEDUPED_BLOCKED'
    | 'COOLDOWN_BLOCKED'
    | 'RATE_LIMITED_BLOCKED';
  reason: string;
  formattedMessage: string;
  createdAt: string;
  sourceTimestamp: string;
  scanRunId: string;
  signalId: string;
  ruleVersion: string;
  snapshotAt: string;
  evaluatedAt: string;
  dedupeKey: string;
  cooldownUntil: string | null;
}

export type BacktestDataClassification =
  | 'REAL'
  | 'DEMO'
  | 'PROXY'
  | 'PENDING'
  | 'INSUFFICIENT_DATA';

export type BacktestDataClassificationLabel =
  | '實際資料'
  | 'Demo 資料'
  | '代理資料'
  | '等待評估'
  | '資料不足';

export type BacktestMetricStatus = 'READY' | 'NO_TRADES' | 'INSUFFICIENT_DATA';

export type WalkForwardStage = 'TRAINING' | 'VALIDATION' | 'FORWARD_TEST';

export interface HistoricalOpenInterestPoint {
  symbol: string;
  timestamp: number;
  openInterest: number;
  openInterestValue: number | null;
  fetchedAt: string;
  source: string;
  isDemo: boolean;
}

export interface HistoricalFundingRatePoint {
  symbol: string;
  timestamp: number;
  fundingRate: number;
  fetchedAt: string;
  source: string;
  isDemo: boolean;
}

export interface BacktestPointInTimeSignalEvidence {
  barIndex: number;
  barOpenTime: number;
  barCloseTime: number;
  confirmedBarsCount: number;
  volumeBaselineBars: number;
  smcEvidence: string[] | EvidenceItem[];
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  marketRadarCategory: MarketRadarCategory;
  finalTradeSignal: FinalTradeSignal;
  waitReasons?: string[];
  oi: number | null;
  funding: number | null;
  oiValue: number | null;
  oiFetchedAt: string | null;
  oiDataTimestamp: number | null;
  fundingRate: number | null;
  fundingDataTimestamp: number | null;
  oiFundingPointInTime: boolean;
  decisionAt: string;
  countedAsTradeSignal?: boolean;
  countedAsSignal?: boolean;
  blockReason: string | null;
  blockedReason?: string | null;
  decisionTrace: Record<string, unknown> | SymbolDecisionTrace;
}

export interface BacktestTradeRecord {
  signalId?: string;
  signalBarOpenTime?: number;
  signalBarCloseTime?: number;
  entryBarTime: number;
  exitBarTime: number;
  holdingBars?: number;
  holdingTimeMs?: number;
  direction: 'LONG' | 'SHORT';
  actionStateAtSignal: SmcActionState;
  finalTradeSignalAtSignal?: FinalTradeSignal;
  marketRadarCategoryAtSignal?: MarketRadarCategory;
  referenceEntryPrice: number;
  structuralInvalidationPrice: number;
  structuralTargetPrice: number;
  exitPrice: number;
  rMultiple: number;
  outcome: 'WIN' | 'LOSS' | 'TIMEOUT_FLAT';
  evidencesSummary: string;
  pointInTimeEvidence?: BacktestPointInTimeSignalEvidence;
}

export interface BacktestPointInTimeVolumeSnapshot {
  barIndex: number;
  barOpenTime: number;
  currentVolume: number;
  historicalSamples: number[];
  baselineWindowOpenTimes: number[];
  rollingMedian: number | null;
  mad: number | null;
  sampleCount: number;
  volumeTimeframe: VolumeTimeframe;
  aggregationWindow: string;
  volumeMetric: 'quoteVolume';
}

export interface WalkForwardWindowResult {
  stage: WalkForwardStage;
  stageLabel: string;
  windowName?: string;
  windowKey?: WalkForwardStage;
  startBarIndex: number;
  endBarIndex: number;
  confirmedBarsCount: number;
  barsCount?: number;
  startTime: string;
  endTime: string;
  status: 'COMPLETED' | 'INSUFFICIENT_DATA';
  metricStatus: BacktestMetricStatus;
  lookaheadFree: boolean;
  dataClassification: BacktestDataClassification;
  insufficientReason?: string;
  signalCount: number;
  executedPaperCount: number;
  blockedCount: number;
  expiredCount: number;
  insufficientDataCount: number;
  waitCount: number;
  watchCount: number;
  pendingCount: number;
  highRiskCount: number;
  longCount: number | null;
  shortCount: number | null;
  tradeCount: number | null;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
  averageHoldingTimeMs?: number | null;
  averageHoldingBars?: number | null;
  trades: BacktestTradeRecord[];
}

export interface WalkForwardBacktestResult {
  chronologicalOrderVerified: boolean;
  noShufflingVerified: boolean;
  parameterFeedbackBlocked: true;
  frozenRuleVersion: string;
  lookaheadFree: boolean;
  noFutureLeakageVerified?: boolean;
  parameterFrozenBeforeForwardTest?: true;
  totalConfirmedBars?: number;
  trainingWindow: WalkForwardWindowResult;
  validationWindow: WalkForwardWindowResult;
  forwardTestWindow: WalkForwardWindowResult;
}

export interface BacktestResult {
  id?: number;
  backtestRunId: string;
  safety: typeof TRADING_SAFETY_FLAGS;
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  ruleVersion: string;
  scannerRuleVersion: string;
  startTime: string | null;
  endTime: string | null;
  dataSource: string;
  fetchedAt: string;
  isDemo: boolean;
  lookaheadFree: boolean;
  lookaheadFreeVerified: boolean;
  oiFundingPointInTimeVerified?: boolean;
  dataClassification: BacktestDataClassification;
  dataClassificationLabel: BacktestDataClassificationLabel;
  status: 'COMPLETED' | 'INSUFFICIENT_DATA';
  metricStatus: BacktestMetricStatus;
  insufficientReason?: string;
  confirmedBarsTested: number;
  unclosedBarsIgnored?: number;
  signalCount: number;
  executedPaperCount: number;
  blockedCount: number;
  expiredCount: number;
  insufficientDataCount: number;
  waitCount: number;
  watchCount: number;
  pendingCount: number;
  highRiskCount: number;
  longSignalCount?: number;
  shortSignalCount?: number;
  tradeCount: number | null;
  totalTrades: number | null;
  winRate: number | null;
  winRatePercent: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
  averageHoldingTimeMs?: number | null;
  averageHoldingBars: number | null;
  longCount: number | null;
  shortCount: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  trades: BacktestTradeRecord[];
  pointInTimeVolumeSnapshots?: BacktestPointInTimeVolumeSnapshot[];
  pointInTimeDecisions?: BacktestPointInTimeSignalEvidence[];
  walkForward?: WalkForwardBacktestResult;
  modeComparison?: BacktestModeComparisonMatrix;
  paperLedgerEntryIds?: number[];
  createdAt?: string;
  provenance: DataProvenance;
}

export interface BacktestShadowModeMetrics {
  mode:
    | 'STRICT_PRODUCTION'
    | 'OBSERVATION_SHADOW_ONE_GATE_MISSING'
    | 'OBSERVATION_SHADOW_TWO_GATES_MISSING';
  modeLabel: string;
  isFormalProductionRule: boolean;
  paperCreationAllowed: boolean;
  notificationAllowed: boolean;
  evaluatedCount: number;
  candidateCount: number;
  nearMissCount: number;
  entryWindowMissedCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  sampleSufficiency: SampleSufficiencyTier;
  dataStaleCount: number;
  missingDataCount: number;
  trades: BacktestTradeRecord[];
}

export interface BacktestModeComparisonMatrix {
  lookaheadFree: boolean;
  lookaheadFreeVerified?: boolean;
  confirmedClosedKlinesOnly: boolean;
  formalLedgerUnmodified?: boolean;
  strictProduction: BacktestShadowModeMetrics;
  observationShadowOneGateMissing: BacktestShadowModeMetrics;
  observationShadowTwoGatesMissing: BacktestShadowModeMetrics;
  STRICT_PRODUCTION?: BacktestShadowModeMetrics;
  OBSERVATION_SHADOW_ONE_GATE_MISSING?: BacktestShadowModeMetrics;
  OBSERVATION_SHADOW_TWO_GATES_MISSING?: BacktestShadowModeMetrics;
  walkForwardByMode?: {
    STRICT_PRODUCTION: {
      TRAINING: BacktestShadowModeMetrics;
      VALIDATION: BacktestShadowModeMetrics;
      FORWARD_TEST: BacktestShadowModeMetrics;
    };
    OBSERVATION_SHADOW_ONE_GATE_MISSING: {
      TRAINING: BacktestShadowModeMetrics;
      VALIDATION: BacktestShadowModeMetrics;
      FORWARD_TEST: BacktestShadowModeMetrics;
    };
    OBSERVATION_SHADOW_TWO_GATES_MISSING: {
      TRAINING: BacktestShadowModeMetrics;
      VALIDATION: BacktestShadowModeMetrics;
      FORWARD_TEST: BacktestShadowModeMetrics;
    };
  };
}

export interface PaperLedgerEntry {
  id: number;
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  side: 'LONG' | 'SHORT';
  category: ScanCategory;
  actionState: SmcActionState;
  entryPrice: number;
  invalidationPrice: number;
  targetPrice: number;
  currentPrice: number;
  exitPrice: number | null;
  status: 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_MANUAL';
  pnlR: number;
  pnlPercent: number;
  ruleVersion: string;
  evidences: string[];
  notes: string;
  openedAt: string;
  closedAt: string | null;
  isDemo?: boolean;
  demoIsolationLabel?: string | null;
  provenance: DataProvenance;
}

export interface BackgroundScanRunRecord {
  id: number;
  runAt: string;
  exchange: ExchangeId;
  mode: 'live' | 'demo';
  symbolsScanned: number;
  volumeSamplesRecorded: number;
  longCandidates: number;
  shortCandidates: number;
  highRiskCount: number;
  dryRunAlertsDispatched: number;
  status: 'SUCCESS' | 'API_ERROR';
  source: string;
  errorMessage?: string;
  durationMs: number;
}

export interface BackgroundSchedulerStatus {
  safety: typeof TRADING_SAFETY_FLAGS;
  running: boolean;
  intervalMs: number;
  notificationMode: 'DRY_RUN_ONLY';
  lastRunAt: string | null;
  totalRuns: number;
  recentRuns: BackgroundScanRunRecord[];
}

// ============================================================================
// Phase 3: Full-Market SMC/ICT Background Batch Queue & Cache Types
// ============================================================================

export type SmcScanJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RATE_LIMITED';

export type SmcScanPriorityTier = 1 | 2 | 3 | 4 | 5 | 6;

export type SmcPriorityClass = 'FAST_LANE' | 'BULK';

export type SmcExecutionWorker = 'FAST_LANE_WORKER' | 'BULK_WORKER';

export type SmcWorkerRole = 'FAST_LANE' | 'BULK';

export type SmcSlaStatus = 'MET' | 'NOT_MET' | 'PENDING';

export interface SmcLatencyPercentiles {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  min?: number | null;
  avg?: number | null;
  sampleCount: number;
}

export interface SmcLatencyBreakdown {
  queueWait: SmcLatencyPercentiles;
  prewarmWait?: SmcLatencyPercentiles;
  httpFetch: SmcLatencyPercentiles;
  smcCalculation: SmcLatencyPercentiles;
  databaseWrite: SmcLatencyPercentiles;
  rateLimitBackoff: SmcLatencyPercentiles;
  totalDetection: SmcLatencyPercentiles;
}

export interface SmcSlowSymbolDiagnostic {
  symbol: string;
  priorityTier: SmcScanPriorityTier;
  priorityLabel: string;
  priorityClass: SmcPriorityClass;
  executionWorker: SmcExecutionWorker;
  isFastLane: boolean;
  workerRole?: SmcWorkerRole | null;
  queueEnteredAt: string | null;
  jobClaimedAt: string | null;
  smcEvaluationStartedAt: string | null;
  smcEvaluationCompletedAt: string | null;
  queueWaitMs: number;
  prewarmWaitMs: number;
  httpRequestLatencyMs: number;
  smcCalculationLatencyMs: number;
  dbWriteLatencyMs: number;
  smcEvaluationLatencyMs?: number;
  rateLimitWaitMs: number;
  detectionLatencyMs: number;
  cacheHit: boolean;
  cacheMiss: boolean;
  reusedCache: boolean;
  primaryBottleneckStage?: string;
  bottleneckStage?: string;
  blockingReason: string;
}

export interface SmcScanJobRecord {
  id?: number;
  symbol: string;
  exchange: ExchangeId;
  priority: number;
  priorityTier: SmcScanPriorityTier;
  priorityLabel: string;
  priorityClass?: SmcPriorityClass;
  executionWorker?: SmcExecutionWorker | null;
  status: SmcScanJobStatus;
  ruleVersion: string;
  windowKey: string;
  requestedAt: string;
  startedAt: string | null;
  jobClaimedAt?: string | null;
  completedAt: string | null;
  queueEnteredAt?: string;
  smcEvaluationStartedAt?: string | null;
  smcEvaluationCompletedAt?: string | null;
  queueWaitMs?: number | null;
  prewarmWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  cacheHit?: boolean;
  cacheMiss?: boolean;
  reusedCache?: boolean;
  isFastLane?: boolean;
  workerRole?: SmcWorkerRole | null;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  workerId?: string | null;
  leaseUntil?: string | null;
  heartbeatAt?: string | null;
  lastProgressAt?: string | null;
  pendingReason?: SmcPendingReason | null;
  cycleId?: string | null;
}

export interface SmcScanResultRecord {
  symbol: string;
  exchange: ExchangeId;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  marketRadarCategory?: MarketRadarCategory;
  evaluatedAt: string;
  dataFetchedAt: string;
  fetchedAt?: string;
  scanCycleId?: string;
  windowKey?: string;
  freshnessSeconds?: number;
  stale: boolean;
  fallback: boolean;
  missingData: string[];
  source: string;
  isDemo: boolean;
  ruleVersion: string;
  waitReasons: string[];
  smcAnalysis?: SmcAnalysisResult;
  priorityTier?: SmcScanPriorityTier;
  priorityLabel?: string;
  priorityClass?: SmcPriorityClass;
  executionWorker?: SmcExecutionWorker | null;
  workerRole?: SmcWorkerRole | null;
  queueEnteredAt?: string;
  jobClaimedAt?: string | null;
  smcEvaluationStartedAt?: string | null;
  smcEvaluationCompletedAt?: string | null;
  queueWaitMs?: number | null;
  prewarmWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  cacheHit?: boolean;
  cacheMiss?: boolean;
  reusedCache?: boolean;
  signalBarOpenTime?: number | null;
  signalBarCloseTime?: number | null;
  nextBarOpenTime?: number | null;
  entryWindowStatus?: string | null;
  isFastLane?: boolean;
  primaryBlockingReason?: string | null;
  primaryReasonCategory?: SmcReasonCategory | 'CANDIDATE_PASSED';
  allBlockingReasons?: string[];
  gatePassMap?: Record<SmcQualityGateKey, boolean>;
  nearMissStatus?: NearMissStatus;
  missingGates?: string[];
  paperEligibilityStatus?: PaperEligibilityStatus;
  candidateDetectedAt?: string | null;
  signalDetectedAt?: string | null;
  paperOpenedAt?: string | null;
  entryWindowMissed?: boolean | null;
  blockedReason?: string | null;
  evaluationStartedAt?: string | null;
  evaluationCompletedAt?: string | null;
  evaluationLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  entryWindowDelayMs?: number | null;
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export interface SmcCandlesCacheRecord {
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  klines: Kline[];
  openInterest: number | null;
  openInterestValue: number | null;
  fundingRate?: number | null;
  nextFundingTime?: number | null;
  oiFetchedAt?: string | null;
  oiExpiresAt?: string | null;
  dataTimestamp?: number | null;
  ruleVersion?: string | null;
  windowKey?: string | null;
  source?: string;
  fetchedAt?: string;
  stale?: boolean;
  fallback?: boolean;
  missingData?: string[];
  isDemo?: boolean;
  cacheHit?: boolean;
  reusedCache?: boolean;
  expiresAt: string;
  provenance: DataProvenance;
}

export interface SmcScanQueueConfig {
  maxConcurrency: number;
  maxJobConcurrency: number;
  maxHttpConcurrency: number;
  maxRequestsPerMinute: number;
  batchSize: number;
  maxRetries: number;
  baseBackoffMs: number;
  priorityAgeMs?: number;
  maxFastLaneBurst?: number;
  bulkReservation?: number;
  fastLaneWorkerSlots?: number;
  oiCacheTtlMs?: number;
  fundingCacheTtlMs?: number;
  stalledThresholdMs?: number;
  cacheTtlMsByTimeframe: Record<Timeframe, number>;
}

export type CandidateDiagnosisStatus =
  | 'NO_CANDIDATE_VALID'
  | 'NO_CANDIDATE_SUSPECTED'
  | 'NO_CANDIDATE_STABLE'
  | 'HAS_CANDIDATES'
  | 'SCAN_INCOMPLETE';

export interface SmcScanCycleHistoryRecord {
  scanCycleId: string;
  exchange: ExchangeId;
  windowKey: string;
  ruleVersion: string;
  cycleStartedAt: string;
  cycleCompletedAt: string | null;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  isColdStart?: boolean;
  cacheMode?: SmcCacheMode;
  completedHttpRequests?: number;
  totalContracts: number;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  candidateStatus: CandidateDiagnosisStatus;
  statsVersion: number;
  databaseInstanceId: string;
  radarScanDurationMs?: number | null;
  prewarmDurationMs?: number | null;
  prewarmCacheHitRate?: number | null;
  prioritySmcDurationMs?: number | null;
  fullCycleDurationMs?: number | null;
  fullUniverseCompletionDurationMs?: number | null;
  p50DetectionLatencyMs?: number | null;
  p90DetectionLatencyMs?: number | null;
  p95DetectionLatencyMs?: number | null;
  p99DetectionLatencyMs?: number | null;
  p50PriorityDetectionLatencyMs?: number | null;
  p90PriorityDetectionLatencyMs?: number | null;
  p95PriorityDetectionLatencyMs?: number | null;
  p99PriorityDetectionLatencyMs?: number | null;
  maxPriorityDetectionLatencyMs?: number | null;
  p50BulkQueueWaitMs?: number | null;
  p90BulkQueueWaitMs?: number | null;
  p95BulkQueueWaitMs?: number | null;
  p99BulkQueueWaitMs?: number | null;
  maxBulkQueueWaitMs?: number | null;
  cacheHitRate?: number | null;
  cacheMissRate?: number | null;
  candidateDetectedBeforeEntryWindowCount?: number;
  entryWindowMissedCount?: number;
  priorityRefreshCount?: number;
  totalEvaluated?: number;
  gateNotConfirmedCount?: number;
  finalCategorySmcMismatchCount?: number;
  gateStats?: Record<
    SmcQualityGateKey,
    {
      passCount: number;
      failCount: number;
      passRate: number;
      failureRate: number;
    }
  >;
  reasonCategoryCounts?: Record<SmcReasonCategory, number>;
  waitReasonCounts?: Record<string, number>;
}

export interface SmcPriorityExecutionBreakdown {
  fastLaneClassCount: number;
  bulkClassCount: number;
  fastLaneWorkerExecutedCount: number;
  bulkWorkerExecutedCount: number;
  fastLaneWorkerBulkAssistCount: number;
  bulkWorkerFastLaneAssistCount: number;
  tier6MisclassifiedAsFastLaneCount: number;
}

export type SmcCacheUiStatus = '快取可用' | '快取過期' | '正在預熱' | '資料不可用';

export type SmcPrewarmStatus = 'PREWARMING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface SmcPrewarmTaskRecord {
  symbol: string;
  exchange: ExchangeId;
  prewarmStartedAt: string;
  prewarmCompletedAt: string | null;
  prewarmDurationMs: number;
  prewarmPriority: SmcPriorityClass;
  prewarmStatus: SmcPrewarmStatus;
}

export interface SmcPrewarmSnapshotRecord {
  snapshotId: string;
  databaseInstanceId: string;
  exchange: ExchangeId;
  ruleVersion: string;
  windowKey: string;
  createdAt: string;
  symbolCount: number;
  timeframeCoverage: Record<Timeframe, number>;
  oiFundingCoverage: {
    oiCoverage: number;
    fundingCoverage: number;
  };
  freshUntil: string;
}

export interface SmcCacheCoverageMetrics {
  cacheCoverage: number;
  cacheCoverageRate: number;
  freshCacheCount: number;
  expiredCacheCount: number;
  staleCacheCount: number;
  cacheMissCount: number;
  prewarmRequiredCount: number;
  '5mCoverage': number;
  '15mCoverage': number;
  '1hCoverage': number;
  '4hCoverage': number;
  '5mCacheCoverage': number;
  '15mCacheCoverage': number;
  '1hCacheCoverage': number;
  '4hCacheCoverage': number;
  oiCacheCoverage: number;
  fundingCacheCoverage: number;
  cacheStatus: SmcCacheUiStatus;
  cacheStatusLabel: SmcCacheUiStatus;
}

export interface SmcScanStatusResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  exchange: ExchangeId;
  mode: 'live' | 'demo';
  scanRunId?: string;
  cycleId?: string;
  scanCycleId?: string;
  cycleStartedAt?: string | null;
  cycleCompletedAt?: string | null;
  cycleStatus?: 'RUNNING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'INCONSISTENT';
  fullUniverseStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED';
  lastCompletedCycleId?: string | null;
  lastCompletedCycleDuration?: number | null;
  statsConsistency?: 'VALID' | 'INVALID';
  isColdStartCycle?: boolean;
  cacheMode?: SmcCacheMode;
  cacheModeLabel?: string;
  candidateStatus?: CandidateDiagnosisStatus;
  completedScanCyclesCount?: number;
  completedCycles?: SmcScanCycleHistoryRecord[];
  databaseInstanceId?: string;
  snapshotAt: string;
  statsVersion: number;
  workerId?: string;
  workerState: 'RUNNING' | 'PAUSED' | 'IDLE';
  config: SmcScanQueueConfig;
  totalSymbols?: number;
  totalContracts?: number;
  totalContractsCount: number;
  totalJobs: number;
  evaluatedCount?: number;
  queuedCount: number;
  runningJobCount: number;
  runningCount: number;
  inFlightRequestCount: number;
  succeededCount: number;
  failedCount: number;
  failedJobCount?: number;
  rateLimitedCount: number;
  rateLimitCount?: number;
  pendingCount: number;
  smcPendingCount: number;
  waitCount: number;
  watchCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  highRiskCount: number;
  smcWaitCount: number;
  smcWatchCount: number;
  smcLongCandidateCount: number;
  smcShortCandidateCount: number;
  smcHighRiskCount: number;
  smcGateNotConfirmedCount: number;
  lastCompletedAt: string | null;
  lastFullRadarScanAt?: string | null;
  lastPriorityScanAt?: string | null;
  radarScanDurationMs?: number | null;
  prewarmDurationMs?: number | null;
  prewarmCacheHitRate?: number | null;
  prioritySmcDurationMs?: number | null;
  fullCycleDurationMs?: number | null;
  fullUniverseCompletionDuration?: number | null;
  fullUniverseCompletionDurationMs?: number | null;
  coldStartFullUniverseCompletionDuration?: number | null;
  warmCacheFullUniverseCompletionDuration?: number | null;
  queueWaitMs?: number | null;
  prewarmWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  p50DetectionLatencyMs?: number | null;
  p90DetectionLatencyMs?: number | null;
  p95DetectionLatencyMs?: number | null;
  p99DetectionLatencyMs?: number | null;
  maxDetectionLatencyMs?: number | null;
  p50PriorityDetectionLatencyMs?: number | null;
  p90PriorityDetectionLatencyMs?: number | null;
  p95PriorityDetectionLatencyMs?: number | null;
  p99PriorityDetectionLatencyMs?: number | null;
  maxPriorityDetectionLatencyMs?: number | null;
  p50BulkQueueWaitMs?: number | null;
  p90BulkQueueWaitMs?: number | null;
  p95BulkQueueWaitMs?: number | null;
  p99BulkQueueWaitMs?: number | null;
  maxBulkQueueWaitMs?: number | null;
  p50FullUniverseDetectionLatencyMs?: number | null;
  p90FullUniverseDetectionLatencyMs?: number | null;
  p95FullUniverseDetectionLatencyMs?: number | null;
  p99FullUniverseDetectionLatencyMs?: number | null;
  maxFullUniverseDetectionLatencyMs?: number | null;
  coldStartP50?: number | null;
  coldStartP95?: number | null;
  warmCacheP50?: number | null;
  warmCacheP95?: number | null;
  priorityDetectionSLA?: SmcSlaStatus;
  coldStartPrioritySLA?: SmcSlaStatus;
  warmCachePrioritySLA?: SmcSlaStatus;
  coldStartFullUniverseDuration?: number | null;
  warmFullUniverseDuration?: number | null;
  coldStartFullUniverseSLA?: SmcSlaStatus;
  priorityDetectionLatency?: SmcLatencyPercentiles;
  coldStartPriorityDetectionLatency?: SmcLatencyPercentiles;
  warmCachePriorityDetectionLatency?: SmcLatencyPercentiles;
  bulkQueueWait?: SmcLatencyPercentiles;
  bulkUniverseQueueLatency?: SmcLatencyPercentiles;
  fullUniverseCompletionLatency?: SmcLatencyPercentiles;
  priorityExecutionBreakdown?: SmcPriorityExecutionBreakdown;
  latencyBreakdown?: SmcLatencyBreakdown;
  slowestSymbolsTop20?: SmcSlowSymbolDiagnostic[];
  cacheHitCount?: number;
  cacheMissCount?: number;
  cacheHitRate?: number;
  cacheMissRate?: number;
  cacheCoverage?: number;
  cacheCoverageRate?: number;
  freshCacheCount?: number;
  expiredCacheCount?: number;
  staleCacheCount?: number;
  prewarmRequiredCount?: number;
  '5mCoverage'?: number;
  '15mCoverage'?: number;
  '1hCoverage'?: number;
  '4hCoverage'?: number;
  '5mCacheCoverage'?: number;
  '15mCacheCoverage'?: number;
  '1hCacheCoverage'?: number;
  '4hCacheCoverage'?: number;
  oiCacheCoverage?: number;
  fundingCacheCoverage?: number;
  cacheStatus?: SmcCacheUiStatus;
  cacheStatusLabel?: SmcCacheUiStatus;
  latestPrewarmSnapshot?: SmcPrewarmSnapshotRecord | null;
  prewarmTasks?: SmcPrewarmTaskRecord[];
  candidateDetectedBeforeEntryWindowCount?: number;
  entryWindowMissedCount?: number;
  priorityRefreshCount?: number;
  latencyTargetStatus?: {
    targetP50Ms: number;
    targetP95Ms: number;
    actualP50Ms: number | null;
    actualP95Ms: number | null;
    p50TargetMet: boolean | null;
    p95TargetMet: boolean | null;
    priorityP95TargetMet?: boolean | null;
    fullUniverseTailP95TargetMet?: boolean | null;
    priorityDetectionSLA?: SmcSlaStatus;
    coldStartPrioritySLA?: SmcSlaStatus;
    warmCachePrioritySLA?: SmcSlaStatus;
    coldStartFullUniverseSLA?: SmcSlaStatus;
    summary: string;
  };
  totalExpectedHttpRequests?: number;
  completedHttpRequests?: number;
  remainingHttpRequests?: number;
  httpRequestsPerSymbol?: number;
  httpEndpointsBreakdown?: {
    '5m': number;
    '15m': number;
    '1h': number;
    '4h': number;
    openInterest: number;
    fundingRate: number;
  };
  maxHttpConcurrency?: number;
  maxRequestsPerMinute?: number;
  currentRequestsInWindow?: number;
  estimatedRemainingDuration?: number;
  estimateStatus?:
    | 'COMPLETED'
    | 'ESTIMATING_WITH_CACHE_DEDUCTION'
    | 'RATE_LIMIT_BACKOFF'
    | 'FAILED'
    | 'IDLE';
  estimatedRemainingSeconds: number;
  estimatedRemaining: string;
  freshnessSummary: {
    freshCount: number;
    staleCount: number;
    newestEvaluatedAt: string | null;
    oldestEvaluatedAt: string | null;
  };
  recentJobs: SmcScanJobRecord[];
  scannerHealth?: SmcScannerHealthStatus;
  queueHealth?: SmcQueueHealthStatus;
  exchangeApiHealth?: SmcExchangeApiHealthStatus;
  waitingForCacheCount?: number;
  waitingForRateLimitCount?: number;
  waitingForNextBatchCount?: number;
  retryScheduledCount?: number;
  failedRetryableCount?: number;
  pendingReasonCounts?: Record<SmcPendingReason, number>;
  fastLanePendingCount?: number;
  bulkPendingCount?: number;
  pendingBreakdownConsistency?: SmcPendingBreakdownConsistency;
  lastJobCompletedAt?: string | null;
  lastProgressAt?: string | null;
  progressRatePerMinute?: number;
  progressRateStatus?: SmcProgressRateStatus;
  oldestPendingAgeMs?: number;
  stalledJobCount?: number;
  stalledThresholdMs?: number;
  stalledSuspected?: boolean;
  stalledReasons?: SmcStalledReason[];
  diagnosisLabel?: '正常背景評估中' | '背景掃描疑似卡住' | '掃描已完成' | '統計分類不一致';
  pendingNotices?: string[];
  maxConcurrency?: number;
  concurrencyValid?: boolean;
  monitorWorkerState?: SmcMonitorWorkerState;
  scanWorkerState?: SmcScanWorkerState;
  queueWorkerState?: SmcQueueWorkerState;
  workerRestartCount?: number;
  plannedRestartCount?: number;
  unexpectedRestartCount?: number;
  leaseRecoveryCount?: number;
  databaseRecoveryCount?: number;
  monitoringWindowId?: string;
  windowStatus?: MonitoringWindowStatus;
  windowPlannedRestartCount?: number;
  windowUnexpectedRestartCount?: number;
  windowLeaseRecoveryCount?: number;
  windowDatabaseRecoveryCount?: number;
  windowStalledDetectedCount?: number;
  windowConcurrencyViolationCount?: number;
  lifetimePlannedRestartCount?: number;
  lifetimeUnexpectedRestartCount?: number;
  lifetimeLeaseRecoveryCount?: number;
  lifetimeDatabaseRecoveryCount?: number;
  lifetimeStalledDetectedCount?: number;
  lifetimeConcurrencyViolationCount?: number;
  candidateFunnel?: CycleCandidateFunnel;
  smcGateDiagnostics?: SmcGateDiagnosticsSummary;
  paperEligibilityAudit?: PaperEligibilityAuditSummary;
  scopedGateStatistics?: ScopedGateStatisticsSummary;
  observationShadowComparison?: ObservationShadowComparisonSummary;
  nearMissCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  nearMissMissingGates?: Record<string, number>;
  lastBlockingGate?: string | null;
  blockedAfterSmcCandidateCount?: number;
  blockedAfterSmcCandidateReasons?: Record<string, number>;
  blockedByPaperEligibilityCount?: number;
  blockedByPaperEligibilityReasons?: Record<string, number>;
  eligiblePaperSignalCount?: number;
  paperEligibleCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  formalCandidateCount?: number;
  fastLaneFormalCandidateCount?: number;
  bulkFormalCandidateCount?: number;
  entryWindowMissedRate?: number | null;
  candidateDetectionLatencyP50?: number | null;
  candidateDetectionLatencyP95?: number | null;
  queueWaitP50?: number | null;
  queueWaitP95?: number | null;
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  paperOpenedCount?: number;
  paperClosedCount?: number;
  blockedCount?: number;
  candidateDetectedCount?: number;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  consistencyErrors?: string[];
  rootCauseVerdict?: CandidateScarcityRootCauseVerdict;
  rootCauseExplanation?: string;
}

// ============================================================================
// Phase 5: Paper Trading Shadow Monitor, Signal Outcome Tracker & Notification Sandbox Types
// ============================================================================

export type PaperMonitorWorkerState =
  | 'STARTED'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';

export type PaperSignalLifecycleStatus =
  | 'CREATED'
  | 'PENDING_NEXT_ENTRY'
  | 'PAPER_OPENED'
  | 'ENTRY_WINDOW_MISSED'
  | 'PAPER_CLOSED_WIN'
  | 'PAPER_CLOSED_LOSS'
  | 'PAPER_EXPIRED'
  | 'INVALIDATED'
  | 'BLOCKED';

export type NotificationOutboxChannel =
  | 'TELEGRAM_SANDBOX'
  | 'TRADINGVIEW_SANDBOX';

export type NotificationOutboxStatus =
  | 'PREVIEW_DRY_RUN'
  | 'SANDBOX_QUEUED'
  | 'PENDING_ENTRY'
  | 'NON_CANDIDATE_BLOCKED'
  | 'DEDUPED_BLOCKED'
  | 'COOLDOWN_BLOCKED'
  | 'STALE_BLOCKED'
  | 'FALLBACK_BLOCKED'
  | 'MISSING_DATA_BLOCKED';

export type PaperMetricStatus =
  | 'READY'
  | 'NO_TRADES'
  | 'SIGNALS_PENDING_ENTRY'
  | 'ENTRY_WINDOW_MISSED'
  | 'OPEN_TRADES_NO_CLOSED_RESULTS'
  | 'INSUFFICIENT_DATA';

export type PaperMonitorReportWindow = '24h' | '7d' | '30d' | '60d' | '90d';

export type PaperQualityWindow = '30d' | '60d' | '90d' | '7d' | '24h';

export type SampleSufficiencyTier = 'INSUFFICIENT' | 'LIMITED' | 'SUFFICIENT';

export type PaperSignalCloseReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'EXPIRED'
  | 'INVALIDATED'
  | null;

export interface PaperMonitorRunRecord {
  monitorRunId: string;
  scanRunId: string;
  databaseInstanceId: string;
  ruleVersion: string;
  exchange: ExchangeId;
  startedAt: string;
  lastHeartbeatAt: string;
  lastScanAt: string | null;
  nextScanAt: string | null;
  workerState: PaperMonitorWorkerState;
  lastError: string | null;
  cyclesCompleted: number;
  rateLimitCount: number;
  exchangeErrorCount: number;
}

export type MonitoringWindowStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'INTERRUPTED'
  | 'FAILED'
  | 'ERROR';

export interface MonitoringWindowRecord {
  monitoringWindowId: string;
  monitorRunId: string;
  exchange: ExchangeId;
  ruleVersion: string;
  windowStartedAt: string;
  windowExpectedEndAt: string;
  windowCompletedAt: string | null;
  windowStatus: MonitoringWindowStatus;
  isVerifiableTimeSeriesReplay: boolean;
  interruptionReason: string | null;
  lastUpdatedAt: string;
}

export interface MonitoringWindowCycleSnapshot {
  scanCycleId: string;
  monitoringWindowId: string;
  scanRunId: string;
  snapshotAt: string;
  statsVersion: number;
  totalContracts: number;
  evaluatedCount: number;
  pendingCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  failedCount: number;
  rateLimitedCount: number;
  staleCount: number;
  fallbackCount: number;
  missingDataCount: number;
  finalCategorySmcMismatchCount: number;
  ruleVersionValidCount: number;
  evaluatedAtValidCount: number;
  sourceValidCount: number;
  cycleValid: boolean;
  dataQualityWarning: string | null;
  recordedAt: string;
}

export interface WindowFinalSnapshot {
  monitoringWindowId: string;
  windowStatus: MonitoringWindowStatus;
  windowStartedAt: string;
  windowExpectedEndAt: string;
  windowCompletedAt: string | null;
  completedCycleIds: string[];
  completedScanCyclesCount: number;
  finalEvaluatedCount: number;
  finalPendingCount: number;
  finalWaitCount: number;
  finalWatchCount: number;
  finalHighRiskCount: number;
  finalLongCandidateCount: number;
  finalShortCandidateCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  finalCandidateCount: number;
  finalPaperSignalCount: number;
  finalOpenSignalsCount: number;
  finalOpenTradesCount: number;
  finalEntryWindowMissedCount?: number;
  finalPaperOpenedCount: number;
  finalPaperClosedCount: number;
  finalMetricStatus: PaperMetricStatus;
  candidateStatus: CandidateDiagnosisStatus;
  finalCandidateStatus?: CandidateDiagnosisStatus;
}

export type SmcFullUniverseStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type SmcStatsConsistency = 'VALID' | 'INVALID';
export type SmcCacheMode = 'COLD' | 'WARM' | 'PARTIAL';
export type SmcEstimateStatus =
  | 'COMPLETED'
  | 'ESTIMATING_WITH_CACHE_DEDUCTION'
  | 'RATE_LIMIT_BACKOFF'
  | 'FAILED'
  | 'IDLE';

export interface SmcHttpEndpointBreakdown {
  '5m': number;
  '15m': number;
  '1h': number;
  '4h': number;
  openInterest: number;
  fundingRate: number;
}

export interface CurrentLiveCycleSnapshot {
  currentScanCycleId: string;
  currentCycleStartedAt: string;
  currentCycleCompletedAt: string | null;
  currentCycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  totalContracts: number;
  currentTotalContracts: number;
  currentEvaluatedCount: number;
  currentPendingCount: number;
  currentQueuedCount: number;
  currentRunningJobCount: number;
  currentFailedCount: number;
  currentRateLimitedCount: number;
  currentWaitCount: number;
  currentWatchCount: number;
  currentHighRiskCount: number;
  currentLongCandidateCount: number;
  currentShortCandidateCount: number;
}

export interface LatestScanSnapshot {
  scanCycleId: string;
  latestScanCycleId: string;
  scanRunId?: string;
  snapshotAt: string;
  statsVersion: number;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  totalContracts: number;
  evaluatedCount: number;
  pendingCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  candidateStatus: CandidateDiagnosisStatus;
  staleCount?: number;
  fallbackCount?: number;
  missingDataCount?: number;
  finalCategorySmcMismatchCount?: number;
}

export interface PaperTrackedSignalRecord {
  signalId: string;
  monitorRunId: string;
  scanRunId: string;
  scanCycleId?: string;
  databaseInstanceId: string;
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  direction: 'LONG' | 'SHORT' | 'NONE';
  marketRadarCategory: MarketRadarCategory;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  ruleVersion: string;
  snapshotAt: string;
  evaluatedAt: string;
  signalDetectedAt: string;
  signalBarOpenTime: number | null;
  signalBarCloseTime: number | null;
  originalEntryWindowOpenTime: number | null;
  originalEntryWindowCloseTime: number | null;
  entryReferenceTime: string | null;
  entryReferencePrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskMultiple: number | null;
  resultR?: number | null;
  exitTime: string | null;
  paperOpenedAt?: string | null;
  paperClosedAt?: string | null;
  closeReason?: PaperSignalCloseReason;
  entryWindowOpenTime?: number | null;
  exitPrice: number | null;
  holdingTimeMs: number | null;
  status: PaperSignalLifecycleStatus;
  entryStatus: PaperSignalLifecycleStatus;
  entryWindowStatus: string;
  statusReason: string | null;
  paperLedgerId: number | null;
  signalLatencyMs: number;
  detectionLatencyMs: number;
  nextBarOpenTime?: number | null;
  candidateDetectedAt?: string | null;
  queueEnteredAt?: string | null;
  evaluationStartedAt?: string | null;
  evaluationCompletedAt?: string | null;
  queueWaitMs?: number | null;
  evaluationLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  entryWindowMissed?: boolean | null;
  isFastLane?: boolean;
  source: string;
  stale: boolean;
  fallback: boolean;
  missingData: string[];
  waitReasons: string[];
  evidences: string[];
  decisionTrace?: Record<string, unknown> | SymbolDecisionTrace | null;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationOutboxRecord {
  notificationId: string;
  signalId: string;
  monitorRunId: string;
  scanRunId: string;
  scanCycleId?: string | null;
  snapshotAt?: string | null;
  symbol: string;
  exchange: ExchangeId;
  channel: NotificationOutboxChannel;
  payload: NotificationPayload;
  formattedMessage: string;
  createdAt: string;
  status: NotificationOutboxStatus;
  dedupeKey: string;
  cooldownUntil: string | null;
  blockedReason: string | null;
}

export interface PaperMonitorEnvelope {
  databaseInstanceId: string;
  monitorRunId: string;
  scanRunId: string;
  snapshotAt: string;
  statsVersion: number;
  mode: 'PAPER ONLY';
  liveOrders: 'LIVE ORDERS DISABLED';
  executionPolicy: 'NEVER AUTO-PLACE ORDERS';
  safety: typeof TRADING_SAFETY_FLAGS;
}

export interface PaperMonitorStatusResponse extends PaperMonitorEnvelope {
  exchange: ExchangeId;
  ruleVersion: string;
  startedAt: string;
  lastHeartbeatAt: string;
  lastScanAt: string | null;
  nextScanAt: string | null;
  workerState: PaperMonitorWorkerState;
  monitorWorkerState: SmcMonitorWorkerState;
  scanWorkerState: SmcScanWorkerState;
  queueWorkerState: SmcQueueWorkerState;
  workerRestartCount: number;
  plannedRestartCount: number;
  unexpectedRestartCount: number;
  leaseRecoveryCount: number;
  databaseRecoveryCount: number;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  progressRatePerMinute: number;
  progressRateStatus: SmcProgressRateStatus;
  lastError: string | null;
  cyclesCompleted: number;
  intervalMs: number;
  monitoringWindowId: string;
  windowStartedAt: string;
  windowExpectedEndAt: string;
  windowCompletedAt: string | null;
  windowStatus: MonitoringWindowStatus;
  windowElapsedMs: number;
  windowRemainingMs: number;
  windowElapsedFormatted: string;
  windowRemainingFormatted: string;
  scanCycleId: string;
  cycleId?: string;
  cycleStartedAt: string;
  cycleCompletedAt: string | null;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  fullUniverseStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED';
  lastCompletedCycleId?: string | null;
  lastCompletedCycleDuration?: number | null;
  statsConsistency?: 'VALID' | 'INVALID';
  maxConcurrency: number;
  concurrencyValid: boolean;
  stalledSuspected?: boolean;
  stalledReasons?: SmcStalledReason[];
  cacheMode?: SmcCacheMode;
  cacheModeLabel?: string;
  candidateStatus: CandidateDiagnosisStatus;
  completedScanCyclesCount: number;
  completedCycles: SmcScanCycleHistoryRecord[];
  totalSymbols?: number;
  totalContracts: number;
  totalJobs?: number;
  evaluatedCount: number;
  pendingCount: number;
  queuedCount: number;
  runningJobCount: number;
  succeededCount?: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  highRiskCount: number;
  totalSignals?: number;
  openSignalsCount: number;
  openTradesCount?: number;
  entryWindowMissedCount?: number;
  entryWindowMissed?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  lastFullRadarScanAt?: string | null;
  lastPriorityScanAt?: string | null;
  radarScanDurationMs?: number | null;
  prewarmDurationMs?: number | null;
  prewarmCacheHitRate?: number | null;
  prioritySmcDurationMs?: number | null;
  fullCycleDurationMs?: number | null;
  fullUniverseCompletionDuration?: number | null;
  fullUniverseCompletionDurationMs?: number | null;
  coldStartFullUniverseCompletionDuration?: number | null;
  warmCacheFullUniverseCompletionDuration?: number | null;
  queueWaitMs?: number | null;
  prewarmWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  p50DetectionLatencyMs?: number | null;
  p90DetectionLatencyMs?: number | null;
  p95DetectionLatencyMs?: number | null;
  p99DetectionLatencyMs?: number | null;
  maxDetectionLatencyMs?: number | null;
  p50PriorityDetectionLatencyMs?: number | null;
  p90PriorityDetectionLatencyMs?: number | null;
  p95PriorityDetectionLatencyMs?: number | null;
  p99PriorityDetectionLatencyMs?: number | null;
  maxPriorityDetectionLatencyMs?: number | null;
  p50BulkQueueWaitMs?: number | null;
  p90BulkQueueWaitMs?: number | null;
  p95BulkQueueWaitMs?: number | null;
  p99BulkQueueWaitMs?: number | null;
  maxBulkQueueWaitMs?: number | null;
  p50FullUniverseDetectionLatencyMs?: number | null;
  p90FullUniverseDetectionLatencyMs?: number | null;
  p95FullUniverseDetectionLatencyMs?: number | null;
  p99FullUniverseDetectionLatencyMs?: number | null;
  maxFullUniverseDetectionLatencyMs?: number | null;
  coldStartP50?: number | null;
  coldStartP95?: number | null;
  warmCacheP50?: number | null;
  warmCacheP95?: number | null;
  priorityDetectionSLA?: SmcSlaStatus;
  coldStartPrioritySLA?: SmcSlaStatus;
  warmCachePrioritySLA?: SmcSlaStatus;
  coldStartFullUniverseDuration?: number | null;
  warmFullUniverseDuration?: number | null;
  coldStartFullUniverseSLA?: SmcSlaStatus;
  cacheHitCount?: number;
  cacheMissCount?: number;
  cacheHitRate?: number;
  cacheMissRate?: number;
  cacheCoverage?: number;
  cacheCoverageRate?: number;
  freshCacheCount?: number;
  expiredCacheCount?: number;
  staleCacheCount?: number;
  prewarmRequiredCount?: number;
  '5mCoverage'?: number;
  '15mCoverage'?: number;
  '1hCoverage'?: number;
  '4hCoverage'?: number;
  '5mCacheCoverage'?: number;
  '15mCacheCoverage'?: number;
  '1hCacheCoverage'?: number;
  '4hCacheCoverage'?: number;
  oiCacheCoverage?: number;
  fundingCacheCoverage?: number;
  cacheStatus?: SmcCacheUiStatus;
  cacheStatusLabel?: SmcCacheUiStatus;
  latestPrewarmSnapshot?: SmcPrewarmSnapshotRecord | null;
  prewarmTasks?: SmcPrewarmTaskRecord[];
  priorityDetectionLatency?: SmcLatencyPercentiles;
  coldStartPriorityDetectionLatency?: SmcLatencyPercentiles;
  warmCachePriorityDetectionLatency?: SmcLatencyPercentiles;
  bulkQueueWait?: SmcLatencyPercentiles;
  bulkUniverseQueueLatency?: SmcLatencyPercentiles;
  fullUniverseCompletionLatency?: SmcLatencyPercentiles;
  priorityExecutionBreakdown?: SmcPriorityExecutionBreakdown;
  latencyBreakdown?: SmcLatencyBreakdown;
  slowestSymbolsTop20?: SmcSlowSymbolDiagnostic[];
  priorityRefreshCount?: number;
  totalExpectedHttpRequests?: number;
  completedHttpRequests?: number;
  remainingHttpRequests?: number;
  httpRequestsPerSymbol?: number;
  httpEndpointsBreakdown?: {
    '5m': number;
    '15m': number;
    '1h': number;
    '4h': number;
    openInterest: number;
    fundingRate: number;
  };
  maxHttpConcurrency?: number;
  maxRequestsPerMinute?: number;
  currentRequestsInWindow?: number;
  estimatedRemainingDuration?: number;
  estimateStatus?:
    | 'COMPLETED'
    | 'ESTIMATING_WITH_CACHE_DEDUCTION'
    | 'RATE_LIMIT_BACKOFF'
    | 'FAILED'
    | 'IDLE';
  rateLimitCount?: number;
  failedJobCount?: number;
  openSignals?: number;
  openTrades?: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  metricStatus?: PaperMetricStatus;
  winsCount: number;
  lossesCount: number;
  expiredCount: number;
  invalidatedCount: number;
  blockedCount: number;
  sandboxQueuedCount: number;
  pendingEntryNotificationCount?: number;
  notificationBlockedCount: number;
  notificationBlockedBreakdown?: Record<string, number>;
  windowFinalSnapshot?: WindowFinalSnapshot | null;
  currentLiveCycleSnapshot?: CurrentLiveCycleSnapshot;
  latestScanSnapshot?: LatestScanSnapshot;
  candidateFunnel?: CycleCandidateFunnel;
  smcGateDiagnostics?: SmcGateDiagnosticsSummary;
  paperEligibilityAudit?: PaperEligibilityAuditSummary;
  scopedGateStatistics?: ScopedGateStatisticsSummary;
  observationShadowComparison?: ObservationShadowComparisonSummary;
  nearMissCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  nearMissMissingGates?: Record<string, number>;
  lastBlockingGate?: string | null;
  candidateDetectedCount?: number;
  eligiblePaperSignalCount?: number;
  paperEligibleCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  formalCandidateCount?: number;
  fastLaneFormalCandidateCount?: number;
  bulkFormalCandidateCount?: number;
  entryWindowMissedRate?: number | null;
  candidateDetectionLatencyP50?: number | null;
  candidateDetectionLatencyP95?: number | null;
  queueWaitP50?: number | null;
  queueWaitP95?: number | null;
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  consistencyErrors?: string[];
  externalNotificationCount: 0;
  externalTelegramRequestsCount: 0;
  externalTradingViewRequestsCount: 0;
}

export interface PaperMonitorReportResponse extends PaperMonitorEnvelope {
  window: PaperMonitorReportWindow;
  reportGeneratedAt?: string;
  reportAnchorAt?: string;
  windowStartAt: string;
  windowEndAt: string;
  signalDetectedAt?: string | null;
  scanCycleCompletedAt?: string | null;
  sampleCount?: number;
  sampleSufficiency?: SampleSufficiencyTier;
  metricStatus: PaperMetricStatus;
  sampleSufficiencyNotice: string;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  openSignals: number;
  openTrades: number;
  entryWindowMissed: number;
  entryWindowMissedCount?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  lastFullRadarScanAt?: string | null;
  lastPriorityScanAt?: string | null;
  queueWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  p50DetectionLatencyMs?: number | null;
  p90DetectionLatencyMs?: number | null;
  p95DetectionLatencyMs?: number | null;
  p99DetectionLatencyMs?: number | null;
  maxDetectionLatencyMs?: number | null;
  p50PriorityDetectionLatencyMs?: number | null;
  p90PriorityDetectionLatencyMs?: number | null;
  p95PriorityDetectionLatencyMs?: number | null;
  p99PriorityDetectionLatencyMs?: number | null;
  maxPriorityDetectionLatencyMs?: number | null;
  p50BulkQueueWaitMs?: number | null;
  p90BulkQueueWaitMs?: number | null;
  p95BulkQueueWaitMs?: number | null;
  p99BulkQueueWaitMs?: number | null;
  maxBulkQueueWaitMs?: number | null;
  p50FullUniverseDetectionLatencyMs?: number | null;
  p90FullUniverseDetectionLatencyMs?: number | null;
  p95FullUniverseDetectionLatencyMs?: number | null;
  p99FullUniverseDetectionLatencyMs?: number | null;
  maxFullUniverseDetectionLatencyMs?: number | null;
  fullUniverseStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED';
  fullUniverseCompletionDuration?: number | null;
  fullUniverseCompletionDurationMs?: number | null;
  coldStartFullUniverseCompletionDuration?: number | null;
  warmCacheFullUniverseCompletionDuration?: number | null;
  cycleId?: string;
  scanCycleId?: string;
  cycleStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  cycleStartedAt?: string | null;
  cycleCompletedAt?: string | null;
  lastCompletedCycleId?: string | null;
  lastCompletedCycleDuration?: number | null;
  statsConsistency?: 'VALID' | 'INVALID';
  cacheMode?: SmcCacheMode;
  cacheModeLabel?: string;
  totalSymbols?: number;
  totalJobs?: number;
  evaluatedCount?: number;
  queuedCount?: number;
  runningJobCount?: number;
  succeededCount?: number;
  failedCount?: number;
  rateLimitedCount?: number;
  rateLimitCount?: number;
  waitCount?: number;
  watchCount?: number;
  highRiskCount?: number;
  longCandidateCount?: number;
  shortCandidateCount?: number;
  totalExpectedHttpRequests?: number;
  completedHttpRequests?: number;
  remainingHttpRequests?: number;
  httpRequestsPerSymbol?: number;
  httpEndpointsBreakdown?: {
    '5m': number;
    '15m': number;
    '1h': number;
    '4h': number;
    openInterest: number;
    fundingRate: number;
  };
  maxHttpConcurrency?: number;
  maxRequestsPerMinute?: number;
  currentRequestsInWindow?: number;
  estimatedRemainingDuration?: number;
  estimateStatus?:
    | 'COMPLETED'
    | 'ESTIMATING_WITH_CACHE_DEDUCTION'
    | 'RATE_LIMIT_BACKOFF'
    | 'FAILED'
    | 'IDLE';
  prewarmDurationMs?: number | null;
  prewarmCacheHitRate?: number | null;
  coldStartP50?: number | null;
  coldStartP95?: number | null;
  warmCacheP50?: number | null;
  warmCacheP95?: number | null;
  priorityDetectionSLA?: SmcSlaStatus;
  coldStartPrioritySLA?: SmcSlaStatus;
  warmCachePrioritySLA?: SmcSlaStatus;
  coldStartFullUniverseDuration?: number | null;
  warmFullUniverseDuration?: number | null;
  coldStartFullUniverseSLA?: SmcSlaStatus;
  prewarmWaitMs?: number | null;
  cacheHitCount?: number;
  cacheMissCount?: number;
  cacheHitRate?: number;
  cacheMissRate?: number;
  cacheCoverage?: number;
  cacheCoverageRate?: number;
  freshCacheCount?: number;
  expiredCacheCount?: number;
  staleCacheCount?: number;
  prewarmRequiredCount?: number;
  '5mCoverage'?: number;
  '15mCoverage'?: number;
  '1hCoverage'?: number;
  '4hCoverage'?: number;
  '5mCacheCoverage'?: number;
  '15mCacheCoverage'?: number;
  '1hCacheCoverage'?: number;
  '4hCacheCoverage'?: number;
  oiCacheCoverage?: number;
  fundingCacheCoverage?: number;
  cacheStatus?: SmcCacheUiStatus;
  cacheStatusLabel?: SmcCacheUiStatus;
  latestPrewarmSnapshot?: SmcPrewarmSnapshotRecord | null;
  prewarmTasks?: SmcPrewarmTaskRecord[];
  priorityDetectionLatency?: SmcLatencyPercentiles;
  coldStartPriorityDetectionLatency?: SmcLatencyPercentiles;
  warmCachePriorityDetectionLatency?: SmcLatencyPercentiles;
  bulkQueueWait?: SmcLatencyPercentiles;
  bulkUniverseQueueLatency?: SmcLatencyPercentiles;
  fullUniverseCompletionLatency?: SmcLatencyPercentiles;
  priorityExecutionBreakdown?: SmcPriorityExecutionBreakdown;
  latencyBreakdown?: SmcLatencyBreakdown;
  slowestSymbolsTop20?: SmcSlowSymbolDiagnostic[];
  priorityRefreshCount?: number;
  paperOpened: number;
  paperClosed: number;
  wins: number;
  losses: number;
  expired: number;
  invalidated: number;
  blocked: number;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
  signalLatency: number | null;
  dataStaleCount: number;
  fallbackCount: number;
  pendingCount: number;
  trades?: Array<{
    signalId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT' | 'NONE';
    entryReferencePrice: number | null;
    entryReferenceTime: string | null;
    stopLoss: number | null;
    takeProfit: number | null;
    exitPrice: number | null;
    exitTime: string | null;
    rMultiple: number | null;
    status: PaperSignalLifecycleStatus;
  }>;
}

export interface PaperMonitorHealthResponse extends PaperMonitorEnvelope {
  scannerHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  queueHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  exchangeApiHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  rateLimitCount: number;
  failedJobCount: number;
  staleResultCount: number;
  missingOiFundingCount: number;
  pendingSmcCount: number;
  notificationBlockedCount: number;
  finalCategorySmcMismatchCount: number;
  statsVersionMonotonicVerified: boolean;
  queueResultConsistentVerified: boolean;
  workerHeartbeatHealthy: boolean;
  externalTelegramRequestsCount: 0;
  externalTradingViewRequestsCount: 0;
  warnings: string[];
}

// ============================================================================
// Phase 6: Zero-Candidate Full Diagnostics & 3-Cycle Stability Audit Types
// ============================================================================

export type SmcDiagnosticConditionKey =
  | 'BOS / MSS'
  | 'Liquidity Sweep'
  | 'Displacement'
  | 'FVG / Order Block'
  | 'MTF Alignment'
  | 'ATR(14)'
  | 'OI'
  | 'Funding'
  | '15m Volume Baseline'
  | 'Confirmed Kline Count'
  | 'WAIT Gate';

export interface SmcDiagnosticConditionStat {
  condition: SmcDiagnosticConditionKey;
  bullishConditionPassCount: number;
  bullishConditionFailCount: number;
  bearishConditionPassCount: number;
  bearishConditionFailCount: number;
}

export interface Phase6DiagnosticsReport {
  safety: typeof TRADING_SAFETY_FLAGS;
  databaseInstanceId: string;
  exchange: ExchangeId;
  scanRunId: string;
  scanCycleId: string;
  snapshotAt: string;
  statsVersion: number;
  candidateStatus: CandidateDiagnosisStatus;
  totalContracts: number;
  evaluatedCount: number;
  pendingCount: number;
  runningJobCount: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  zeroCandidateVerification: {
    allEvaluated: boolean;
    allHaveValidEvaluatedAt: boolean;
    staleFalseCount: number;
    staleTrueCount: number;
    allStaleFalse: boolean;
    fallbackFalseCount: number;
    fallbackTrueCount: number;
    allFallbackFalse: boolean;
    emptyMissingDataCount: number;
    nonEmptyMissingDataCount: number;
    allMissingDataEmpty: boolean;
    currentRuleVersion: string;
    matchingRuleVersionCount: number;
    mismatchedRuleVersionCount: number;
    allCurrentRuleVersion: boolean;
    exceptionOrDefaultWaitCount: number;
    expiredCacheReadCount: number;
    allHaveConcreteBlockingReason: boolean;
  };
  smcGateStatistics: {
    bullishConditionPassCount: Record<SmcDiagnosticConditionKey, number>;
    bearishConditionPassCount: Record<SmcDiagnosticConditionKey, number>;
    bullishConditionFailCount: Record<SmcDiagnosticConditionKey, number>;
    bearishConditionFailCount: Record<SmcDiagnosticConditionKey, number>;
    conditions: SmcDiagnosticConditionStat[];
  };
  reasonDistribution: {
    canonicalReasonCounts: Record<string, number>;
    waitReasonCounts: Record<string, number>;
    watchReasonCounts: Record<string, number>;
    highRiskReasonCounts: Record<string, number>;
    singleConditionFailureSuspected: boolean;
  };
  engineOverblockAudit: {
    hasBullBosAndBearBosComputedNormally: boolean;
    liquiditySweepFieldMappingValid: boolean;
    displacementAtrUnitConsistent: boolean;
    fvgAndObCheckedOnPrimary15m: boolean;
    allFourTimeframesLoaded: boolean;
    mtfAlignmentNotDefaultFalse: boolean;
    atr14UsesConfirmedKlinesOnly: boolean;
    oiAndFundingNotMisclassifiedMissing: boolean;
    waitReasonsClearedWhenCandidatePasses: boolean;
    noCatchFallbackReturningWait: boolean;
    allChecksPassed: boolean;
  };
  candidateMappingAudit: {
    waitMapsToNoneVerified: boolean;
    watchMapsToNoneVerified: boolean;
    highRiskMapsToNoneVerified: boolean;
    longCandidateRadarAlignmentVerified: boolean;
    shortCandidateRadarAlignmentVerified: boolean;
    finalCategorySmcMismatchCount: number;
  };
  demoFixtureVerification: {
    totalDemoContracts: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateSymbols: string[];
    shortCandidateSymbols: string[];
    conclusion: string;
  };
  completedCycles: SmcScanCycleHistoryRecord[];
}

// ============================================================================
// Phase 7: 24-Hour Paper Shadow Monitoring Window & Candidate Appearance Report
// ============================================================================

export interface Phase7MonitoringWindowReport extends PaperMonitorEnvelope {
  exchange: ExchangeId;
  ruleVersion: string;
  monitoringWindowId: string;
  windowStartedAt: string;
  windowExpectedEndAt: string;
  windowCompletedAt: string | null;
  windowStatus: MonitoringWindowStatus;
  windowElapsedMs: number;
  windowRemainingMs: number;
  windowElapsedFormatted: string;
  windowRemainingFormatted: string;
  isVerifiableTimeSeriesReplay: boolean;
  full24hVerificationNotice: string;
  totalScanCycles: number;
  completedScanCycles: number;
  interruptedScanCycles: number;
  totalContractsEvaluated: number;
  evaluatedCount: number;
  pendingCount: number;
  totalLongCandidates: number;
  totalShortCandidates: number;
  totalSignals: number;
  openSignals: number;
  openTrades: number;
  entryWindowMissed: number;
  entryWindowMissedCount?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  lastFullRadarScanAt?: string | null;
  lastPriorityScanAt?: string | null;
  radarScanDurationMs?: number | null;
  prewarmDurationMs?: number | null;
  prewarmCacheHitRate?: number | null;
  prioritySmcDurationMs?: number | null;
  fullCycleDurationMs?: number | null;
  fullUniverseStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED';
  fullUniverseCompletionDuration?: number | null;
  fullUniverseCompletionDurationMs?: number | null;
  coldStartFullUniverseCompletionDuration?: number | null;
  warmCacheFullUniverseCompletionDuration?: number | null;
  cycleId?: string;
  scanCycleId?: string;
  cycleStatus?: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  cycleStartedAt?: string | null;
  cycleCompletedAt?: string | null;
  lastCompletedCycleId?: string | null;
  lastCompletedCycleDuration?: number | null;
  statsConsistency?: 'VALID' | 'INVALID';
  cacheMode?: SmcCacheMode;
  cacheModeLabel?: string;
  totalSymbols?: number;
  totalJobs?: number;
  queuedCount?: number;
  runningJobCount?: number;
  succeededCount?: number;
  rateLimitCount?: number;
  totalExpectedHttpRequests?: number;
  completedHttpRequests?: number;
  remainingHttpRequests?: number;
  httpRequestsPerSymbol?: number;
  httpEndpointsBreakdown?: {
    '5m': number;
    '15m': number;
    '1h': number;
    '4h': number;
    openInterest: number;
    fundingRate: number;
  };
  maxHttpConcurrency?: number;
  maxRequestsPerMinute?: number;
  currentRequestsInWindow?: number;
  estimatedRemainingDuration?: number;
  estimateStatus?:
    | 'COMPLETED'
    | 'ESTIMATING_WITH_CACHE_DEDUCTION'
    | 'RATE_LIMIT_BACKOFF'
    | 'FAILED'
    | 'IDLE';
  queueWaitMs?: number | null;
  prewarmWaitMs?: number | null;
  httpRequestLatencyMs?: number | null;
  smcCalculationLatencyMs?: number | null;
  dbWriteLatencyMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  rateLimitWaitMs?: number | null;
  detectionLatencyMs?: number | null;
  p50DetectionLatencyMs?: number | null;
  p90DetectionLatencyMs?: number | null;
  p95DetectionLatencyMs?: number | null;
  p99DetectionLatencyMs?: number | null;
  maxDetectionLatencyMs?: number | null;
  p50PriorityDetectionLatencyMs?: number | null;
  p90PriorityDetectionLatencyMs?: number | null;
  p95PriorityDetectionLatencyMs?: number | null;
  p99PriorityDetectionLatencyMs?: number | null;
  maxPriorityDetectionLatencyMs?: number | null;
  p50BulkQueueWaitMs?: number | null;
  p90BulkQueueWaitMs?: number | null;
  p95BulkQueueWaitMs?: number | null;
  p99BulkQueueWaitMs?: number | null;
  maxBulkQueueWaitMs?: number | null;
  p50FullUniverseDetectionLatencyMs?: number | null;
  p90FullUniverseDetectionLatencyMs?: number | null;
  p95FullUniverseDetectionLatencyMs?: number | null;
  p99FullUniverseDetectionLatencyMs?: number | null;
  maxFullUniverseDetectionLatencyMs?: number | null;
  coldStartP50?: number | null;
  coldStartP95?: number | null;
  warmCacheP50?: number | null;
  warmCacheP95?: number | null;
  priorityDetectionSLA?: SmcSlaStatus;
  coldStartPrioritySLA?: SmcSlaStatus;
  warmCachePrioritySLA?: SmcSlaStatus;
  coldStartFullUniverseDuration?: number | null;
  warmFullUniverseDuration?: number | null;
  coldStartFullUniverseSLA?: SmcSlaStatus;
  cacheHitCount?: number;
  cacheMissCount?: number;
  cacheHitRate?: number;
  cacheMissRate?: number;
  cacheCoverage?: number;
  cacheCoverageRate?: number;
  freshCacheCount?: number;
  expiredCacheCount?: number;
  staleCacheCount?: number;
  prewarmRequiredCount?: number;
  '5mCoverage'?: number;
  '15mCoverage'?: number;
  '1hCoverage'?: number;
  '4hCoverage'?: number;
  '5mCacheCoverage'?: number;
  '15mCacheCoverage'?: number;
  '1hCacheCoverage'?: number;
  '4hCacheCoverage'?: number;
  oiCacheCoverage?: number;
  fundingCacheCoverage?: number;
  cacheStatus?: SmcCacheUiStatus;
  cacheStatusLabel?: SmcCacheUiStatus;
  latestPrewarmSnapshot?: SmcPrewarmSnapshotRecord | null;
  prewarmTasks?: SmcPrewarmTaskRecord[];
  priorityDetectionLatency?: SmcLatencyPercentiles;
  coldStartPriorityDetectionLatency?: SmcLatencyPercentiles;
  warmCachePriorityDetectionLatency?: SmcLatencyPercentiles;
  bulkQueueWait?: SmcLatencyPercentiles;
  bulkUniverseQueueLatency?: SmcLatencyPercentiles;
  fullUniverseCompletionLatency?: SmcLatencyPercentiles;
  priorityExecutionBreakdown?: SmcPriorityExecutionBreakdown;
  latencyBreakdown?: SmcLatencyBreakdown;
  slowestSymbolsTop20?: SmcSlowSymbolDiagnostic[];
  priorityRefreshCount?: number;
  totalPaperOpened: number;
  totalPaperClosed: number;
  paperOpened: number;
  paperClosed: number;
  totalWins: number;
  totalLosses: number;
  totalExpired: number;
  totalInvalidated: number;
  totalBlocked: number;
  metricStatus: PaperMetricStatus;
  sampleSufficiencyNotice: string;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  waitReasonBreakdown: Record<string, number>;
  watchReasonBreakdown: Record<string, number>;
  highRiskReasonBreakdown: Record<string, number>;
  staleCount: number;
  fallbackCount: number;
  missingDataCount: number;
  failedCount: number;
  rateLimitedCount: number;
  finalCategorySmcMismatchCount: number;
  sandboxQueuedCount: number;
  pendingEntryNotificationCount: number;
  notificationBlockedCount: number;
  notificationBlockedBreakdown: Record<string, number>;
  externalNotificationCount: 0;
  externalTelegramRequestsCount: 0;
  externalTradingViewRequestsCount: 0;
  candidateStatus: CandidateDiagnosisStatus;
  windowFinalSnapshot: WindowFinalSnapshot | null;
  currentLiveCycleSnapshot: CurrentLiveCycleSnapshot;
  latestScanSnapshot: LatestScanSnapshot;
  cycles: MonitoringWindowCycleSnapshot[];
  candidateTimeline: Array<{
    signalId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT' | 'NONE';
    scanCycleId: string;
    marketRadarCategory: MarketRadarCategory;
    smcActionState: SmcActionState;
    finalTradeSignal: FinalTradeSignal;
    evaluatedAt: string;
    signalDetectedAt: string;
    snapshotAt: string;
    ruleVersion: string;
    signalBarOpenTime: number | null;
    signalBarCloseTime: number | null;
    originalEntryWindowOpenTime: number | null;
    originalEntryWindowCloseTime: number | null;
    detectionLatencyMs: number;
    entryStatus: PaperSignalLifecycleStatus;
    entryWindowStatus: string;
    entryReferenceTime: string | null;
    entryReferencePrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    riskMultiple: number | null;
    waitReasons: string[];
    status: PaperSignalLifecycleStatus;
  }>;
  signalDecisionTraces: Array<{
    signalId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT' | 'NONE';
    scanCycleId: string;
    evaluatedAt: string;
    decisionTrace: Record<string, unknown> | SymbolDecisionTrace | null;
  }>;
  paperOutcomeTimeline: Array<{
    signalId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT' | 'NONE';
    status: PaperSignalLifecycleStatus;
    entryStatus: PaperSignalLifecycleStatus;
    entryWindowStatus: string;
    signalDetectedAt: string;
    signalBarCloseTime: number | null;
    originalEntryWindowOpenTime: number | null;
    originalEntryWindowCloseTime: number | null;
    detectionLatencyMs: number;
    entryReferenceTime: string | null;
    entryReferencePrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    exitTime: string | null;
    exitPrice: number | null;
    riskMultiple: number | null;
    holdingTimeMs: number | null;
    statusReason: string | null;
    updatedAt: string;
  }>;
  dataQualityTimeline: Array<{
    scanCycleId: string;
    snapshotAt: string;
    statsVersion: number;
    totalContracts: number;
    evaluatedCount: number;
    pendingCount: number;
    failedCount: number;
    rateLimitedCount: number;
    staleCount: number;
    fallbackCount: number;
    missingDataCount: number;
    finalCategorySmcMismatchCount: number;
    cycleValid: boolean;
    dataQualityWarning: string | null;
  }>;
}

// ============================================================================
// Phase 11: SMC Candidate Scarcity Reason Analysis, Gate Pass Rate & Long-Term Paper Quality Monitoring
// ============================================================================

export type SmcReasonCategory =
  | 'DATA_BLOCKED'
  | 'STRUCTURE_INCOMPLETE'
  | 'MTF_CONFLICT'
  | 'LIQUIDITY_BLOCKED'
  | 'RISK_BLOCKED'
  | 'ENTRY_WINDOW_MISSED'
  | 'PENDING';

export type SmcQualityGateKey =
  | 'confirmedClosedKlines'
  | 'historyBaselineReady'
  | 'validATR'
  | 'BOS/MSS'
  | 'Liquidity Sweep'
  | 'Displacement'
  | 'FVG/Order Block'
  | 'MTF Alignment'
  | 'OI available'
  | 'Funding available'
  | 'Liquidity safety'
  | 'Funding safety'
  | 'stale/fallback/missingData'
  | 'WAIT reasons';

export interface SmcQualityGateItemStat {
  gate: SmcQualityGateKey;
  label: string;
  category: SmcReasonCategory;
  evaluatedCount: number;
  passCount: number;
  failCount: number;
  passRate: number;
  failureRate: number;
  bullishPassCount: number;
  bullishFailCount: number;
  bearishPassCount: number;
  bearishFailCount: number;
}

export interface SmcSymbolGateReasonRecord {
  symbol: string;
  exchange: ExchangeId;
  scanCycleId: string;
  evaluatedAt: string | null;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  marketRadarCategory: MarketRadarCategory;
  primaryBlockingReason: string | null;
  primaryReasonCategory: SmcReasonCategory | 'CANDIDATE_PASSED';
  allReasons: string[];
  reasonCategories: SmcReasonCategory[];
  gatePassMap: Record<SmcQualityGateKey, boolean>;
  failedGates: SmcQualityGateKey[];
  entryWindowStatus: string;
  detectionLatencyMs: number | null;
}

export interface SmcReasonCategoryStat {
  category: SmcReasonCategory;
  label: string;
  primarySymbolCount: number;
  uniqueSymbolCount: number;
  totalReasonOccurrences: number;
  shareOfEvaluatedPercent: number;
  reasons: Record<string, number>;
  sampleSymbols: string[];
}

export interface SmcReasonRankEntry {
  rank: number;
  reason: string;
  category: SmcReasonCategory;
  occurrenceCount: number;
  primarySymbolCount: number;
  uniqueSymbolCount: number;
  failureRatePercent: number;
  sampleSymbols: string[];
}

export interface SmcCycleQualityHistoryItem {
  scanCycleId: string;
  exchange: ExchangeId;
  windowKey: string;
  ruleVersion: string;
  cycleStartedAt: string;
  cycleCompletedAt: string | null;
  scanCycleCompletedAt?: string | null;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  isColdStart: boolean;
  cacheMode: SmcCacheMode;
  totalContracts: number;
  totalEvaluated: number;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  gateNotConfirmedCount: number;
  finalCategorySmcMismatchCount: number;
  entryWindowMissedCount: number;
  candidateDetectedBeforeEntryWindowCount: number;
  p50DetectionLatencyMs: number | null;
  p95DetectionLatencyMs: number | null;
  fullCycleDurationMs: number | null;
  gateStats: Record<
    SmcQualityGateKey,
    {
      passCount: number;
      failCount: number;
      passRate: number;
      failureRate: number;
    }
  >;
  reasonCategoryCounts: Record<SmcReasonCategory, number>;
  waitReasonCounts: Record<string, number>;
}

export interface SmcPaperQualitySignalRecord {
  signalId: string;
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  direction: 'LONG' | 'SHORT' | 'NONE';
  detectedAt: string;
  signalDetectedAt: string;
  scanCycleId: string | null;
  scanCycleCompletedAt: string | null;
  signalBarOpenTime: number | null;
  signalBarCloseTime: number | null;
  entryWindowOpenTime: number | null;
  entryWindowCloseTime: number | null;
  detectionLatencyMs: number;
  entryStatus: PaperSignalLifecycleStatus;
  entryWindowMissedReason: string | null;
  entryReferencePrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  paperOpenedAt: string | null;
  paperClosedAt: string | null;
  closeReason?: PaperSignalCloseReason;
  exitPrice: number | null;
  resultR: number | null;
  status: PaperSignalLifecycleStatus;
  marketRadarCategory?: MarketRadarCategory;
  ruleVersion?: string;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  stale: boolean;
  fallback: boolean;
  isDemo: boolean;
  missingData: string[];
  waitReasons: string[];
  source: string;
  provenance?: DataProvenance;
  sampleWindowMembership?: SignalWindowMembership;
  lifecycle?: SignalLifecycleDetail;
}

export interface SmcQualitySharedEnvelope {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'PAPER ONLY';
  liveOrders: 'LIVE ORDERS DISABLED';
  executionPolicy: 'NEVER AUTO-PLACE ORDERS';
  databaseInstanceId: string;
  exchange: ExchangeId;
  ruleVersion: string;
  snapshotAt: string;
  reportGeneratedAt: string;
  reportAnchorAt: string;
  windowStartAt: string;
  windowEndAt: string;
  signalDetectedAt: string | null;
  scanCycleCompletedAt: string | null;
  statsVersion: number;
  scanRunId: string;
  scanCycleId: string;
  cycleId: string;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  fullUniverseStatus: SmcFullUniverseStatus;
  cycleStartedAt: string | null;
  cycleCompletedAt: string | null;
  fullUniverseCompletionDuration: number | null;
  coldStartFullUniverseSLA: SmcSlaStatus;
  statsConsistency: SmcStatsConsistency;
  cacheMode: SmcCacheMode;
  totalSymbols: number;
  totalEvaluated: number;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  gateNotConfirmedCount: number;
  finalCategorySmcMismatchCount: number;
  entryWindowMissedCount: number;
  externalTelegramRequestsCount: 0;
  externalTradingViewRequestsCount: 0;
  zeroCandidateNotice: string;
  provenance: DataProvenance;
}

export interface SmcQualityGateStatsResponse extends SmcQualitySharedEnvelope {
  cycleCount: number;
  gates: SmcQualityGateItemStat[];
  gateSummaryMap: Record<SmcQualityGateKey, SmcQualityGateItemStat>;
  gatePassRates: Record<SmcQualityGateKey, number>;
  gateFailureRates: Record<SmcQualityGateKey, number>;
  topFailedGates: SmcQualityGateItemStat[];
  symbolDiagnostics: SmcSymbolGateReasonRecord[];
}

export interface SmcQualityReasonStatsResponse extends SmcQualitySharedEnvelope {
  cycleCount: number;
  uniqueSymbolCount: number;
  totalReasonOccurrences: number;
  primaryCategoryCounts: Record<SmcReasonCategory, number>;
  categoryOccurrenceCounts: Record<SmcReasonCategory, number>;
  reasonCategories: Record<SmcReasonCategory, SmcReasonCategoryStat>;
  reasonCategoryList: SmcReasonCategoryStat[];
  waitReasonRanking: SmcReasonRankEntry[];
  waitReasonCounts: Record<string, number>;
  watchReasonCounts: Record<string, number>;
  highRiskReasonCounts: Record<string, number>;
  directionDistribution: {
    longCandidateCount: number;
    shortCandidateCount: number;
    longRatioPercent: number;
    shortRatioPercent: number;
    bullStructureBiasCount: number;
    bearStructureBiasCount: number;
    neutralOrConflictCount: number;
    radarLongObservationCount: number;
    radarShortObservationCount: number;
  };
  symbolReasons: SmcSymbolGateReasonRecord[];
}

export interface SmcQualityCycleHistoryResponse extends SmcQualitySharedEnvelope {
  cycleCount: number;
  totalScans: number;
  recentThreeCompletedCycles: SmcCycleQualityHistoryItem[];
  cycles: SmcCycleQualityHistoryItem[];
}

export interface SmcQualitySignalLatencyResponse extends SmcQualitySharedEnvelope {
  window: PaperMonitorReportWindow;
  cycleCount: number;
  sampleCount: number;
  sampleSufficiency: SampleSufficiencyTier;
  sampleSufficiencyNotice: string;
  latencyStatisticType:
    | 'NO_SAMPLES'
    | 'NO_IN_WINDOW_SAMPLES'
    | 'SINGLE_SAMPLE_DESCRIPTIVE'
    | 'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
    | 'SMALL_SAMPLE_DESCRIPTIVE'
    | 'SMALL_SAMPLE_DESCRIPTIVE_ONLY'
    | 'STABLE_DISTRIBUTION'
    | 'STABLE_PERCENTILE';
  signalLatency: SmcLatencyPercentiles & {
    sampleSufficiency?: SampleSufficiencyTier;
    sampleSufficiencyNotice?: string;
    statisticType?: string;
  };
  priorityDetectionLatency: SmcLatencyPercentiles;
  fullUniverseDetectionLatency: SmcLatencyPercentiles;
  signalLatencyP50: number | null;
  signalLatencyP95: number | null;
  signalLatencyAvg: number | null;
  candidateDetectedBeforeEntryWindowCount: number;
  candidateAppearances: SmcPaperQualitySignalRecord[];
  historicalSignalsOutsideWindowCount: number;
  historicalSignalsOutsideWindow: SmcPaperQualitySignalRecord[];
}

export interface SmcQualityWindowReportResponse extends SmcQualitySharedEnvelope {
  window: PaperMonitorReportWindow;
  windowStartAt: string;
  windowEndAt: string;
  totalScans: number;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  openSignals: number;
  openTrades: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
  wins: number;
  losses: number;
  expired: number;
  waitWatchHighRiskDistribution: {
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    waitPercent: number;
    watchPercent: number;
    highRiskPercent: number;
  };
  topGateFailureReasons: SmcQualityGateItemStat[];
  topBlockingReasons: SmcReasonRankEntry[];
  reasonCategories: Record<SmcReasonCategory, SmcReasonCategoryStat>;
  directionDistribution: {
    longSignals: number;
    shortSignals: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    longRatioPercent: number;
    shortRatioPercent: number;
    bullStructureBiasCount: number;
    bearStructureBiasCount: number;
    neutralOrConflictCount: number;
  };
  sampleCount: number;
  sampleSufficiency: SampleSufficiencyTier;
  latencyStatisticType:
    | 'NO_SAMPLES'
    | 'NO_IN_WINDOW_SAMPLES'
    | 'SINGLE_SAMPLE_DESCRIPTIVE'
    | 'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
    | 'SMALL_SAMPLE_DESCRIPTIVE'
    | 'SMALL_SAMPLE_DESCRIPTIVE_ONLY'
    | 'STABLE_DISTRIBUTION'
    | 'STABLE_PERCENTILE';
  signalLatencyP50: number | null;
  signalLatencyP95: number | null;
  signalLatencyAvg: number | null;
  metricStatus: PaperMetricStatus;
  sampleSufficiencyNotice: string;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
  signals: SmcPaperQualitySignalRecord[];
  historicalSignalsOutsideWindowCount: number;
  historicalSignalsOutsideWindow: SmcPaperQualitySignalRecord[];
}

// ============================================================================
// Phase 12 / 13 / 14: Long-Term Paper Signal Quality, Sample Accumulation,
// Aggregation Semantics, Cycle Details, Gate Drift & Signal Lifecycle History
// ============================================================================

export type EvaluationAggregationMode =
  | 'LATEST_CYCLE'
  | 'DEDUPED_SYMBOLS'
  | 'CUMULATIVE_EVENTS';

export interface PaperQualityLatestCycleBreakdown {
  evaluationAggregationMode: 'LATEST_CYCLE';
  cycleId: string;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  latestCycleEvaluatedCount: number;
  uniqueEvaluatedSymbols: number;
  cumulativeEvaluationEvents: number;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  excludedSymbols: number;
  evaluationExcludedReasons: Record<string, number>;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
}

export interface PaperQualityDedupedSymbolsBreakdown {
  evaluationAggregationMode: 'DEDUPED_SYMBOLS';
  latestCycleEvaluatedCount: number;
  uniqueEvaluatedSymbols: number;
  cumulativeEvaluationEvents: number;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  excludedSymbols: number;
  evaluationExcludedReasons: Record<string, number>;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
}

export interface PaperQualityCumulativeEventsBreakdown {
  evaluationAggregationMode: 'CUMULATIVE_EVENTS';
  totalScanCycles: number;
  completedScanCycles: number;
  interruptedScanCycles: number;
  latestCycleEvaluatedCount: number;
  uniqueEvaluatedSymbols: number;
  cumulativeEvaluationEvents: number;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  excludedSymbols: number;
  evaluationExcludedReasons: Record<string, number>;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
}

export interface PaperQualityCycleGateStat {
  gate: string;
  label?: string;
  passCount: number;
  failCount: number;
  passRate: number;
  failureRate: number;
  evaluatedDenominator: number;
  excludedCount: number;
  statisticScope?: GateStatisticScope;
}

export interface PaperQualityCycleIdentityChecks {
  totalSymbolsIdentity: PaperQualityIdentityCheckItem;
  actionStateIdentity: PaperQualityIdentityCheckItem;
  uniqueUniverseIdentity: PaperQualityIdentityCheckItem;
  allValid: boolean;
}

export interface PaperQualityCycleDetailRecord {
  cycleId: string;
  scanCycleId: string;
  exchange: ExchangeId;
  windowKey: string;
  ruleVersion: string;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  cacheMode: SmcCacheMode;
  cycleStartedAt: string;
  cycleCompletedAt: string | null;
  totalSymbols: number;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  completedHttpRequests: number;
  fullUniverseCompletionDuration: number | null;
  statsVersion: number;
  snapshotAt: string;
  uniqueEvaluatedSymbols: number;
  excludedSymbols: number;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  evaluationExcludedReasons: Record<string, number>;
  statsConsistency: SmcStatsConsistency;
  identityChecks: PaperQualityCycleIdentityChecks;
  gateStats: Record<string, PaperQualityCycleGateStat>;
}

export type SignalLifecycleStageKey =
  | 'candidateDetected'
  | 'entryPending'
  | 'paperOpened'
  | 'paperClosed'
  | 'entryWindowMissed'
  | 'invalidated'
  | 'blocked'
  | 'expired';

export interface SignalLifecycleSummary {
  candidateDetected: number;
  entryPending: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
  expired: number;
}

export interface SignalLifecycleStageDetail {
  reached: boolean;
  timestamp: string | null;
  detail: string | null;
}

export interface SignalLifecycleDetail {
  currentStage: SignalLifecycleStageKey;
  candidateDetected: SignalLifecycleStageDetail;
  entryPending: SignalLifecycleStageDetail;
  paperOpened: SignalLifecycleStageDetail;
  paperClosed: SignalLifecycleStageDetail;
  entryWindowMissed: SignalLifecycleStageDetail;
  invalidated: SignalLifecycleStageDetail;
  blocked: SignalLifecycleStageDetail;
  expired: SignalLifecycleStageDetail;
}

export interface SignalWindowMembership {
  window: PaperMonitorReportWindow;
  reportAnchorAt: string;
  windowStartAt: string;
  windowEndAt: string;
  inCurrentWindow: boolean;
  in30dWindow: boolean;
  in60dWindow: boolean;
  in90dWindow: boolean;
  membershipReason: string;
}

export interface PaperQualitySignalHistoryRecord
  extends SmcPaperQualitySignalRecord {
  detectedAt: string;
  provenance: DataProvenance;
  sampleWindowMembership: SignalWindowMembership;
  lifecycle: SignalLifecycleDetail;
}

export type MarketRegimeDimensionKey =
  | 'BTC_TREND'
  | 'BTC_VOLATILITY'
  | 'MARKET_BREADTH'
  | 'SYMBOL_VOLATILITY'
  | 'FUNDING_STATE'
  | 'LIQUIDITY_STATE'
  | 'MTF_ALIGNMENT_STATE';

export interface MarketRegimeBucketStat {
  dimension: MarketRegimeDimensionKey;
  bucketKey: string;
  bucketLabel: string;
  evaluatedCount: number;
  signalCount: number;
  paperOpened: number;
  paperClosed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageR: number | null;
  maxDrawdownR: number | null;
  sampleCount: number;
  sampleSufficiency: SampleSufficiencyTier;
  sampleSufficiencyNotice: string;
  comparisonAllowed: boolean;
  regimeComparisonConclusion: string;
}

export interface MarketRegimeDimensionReport {
  dimension: MarketRegimeDimensionKey;
  label: string;
  currentMarketState: string;
  buckets: MarketRegimeBucketStat[];
  comparisonAllowed: boolean;
  conclusion: string;
}

export type GateDriftStatus =
  | 'STABLE'
  | 'QUALITY_DRIFT_SUSPECTED'
  | 'INSUFFICIENT_HISTORY';

export type GateDriftComparisonPair =
  | 'latest_vs_previous_cycle'
  | '7d_vs_30d'
  | '30d_vs_60d'
  | '60d_vs_90d';

export type GateComparisonReason =
  | 'SAME_DENOMINATOR_COMPARABLE'
  | 'DENOMINATOR_MATCHED'
  | 'DENOMINATOR_MISMATCH'
  | 'INSUFFICIENT_CYCLES'
  | 'INSUFFICIENT_CYCLE_HISTORY';

export interface GateDriftMetricComparison {
  metricKey: string;
  label: string;
  shortWindowRate: number;
  longWindowRate: number;
  shortPassCount?: number;
  shortFailCount?: number;
  longPassCount?: number;
  longFailCount?: number;
  shortEvaluatedDenominator: number;
  longEvaluatedDenominator: number;
  shortExcludedCount?: number;
  longExcludedCount?: number;
  comparisonAllowed: boolean;
  comparisonReason: GateComparisonReason;
  deltaPercent: number | null;
  absDeltaPercent: number | null;
  driftThresholdPercent: number;
  driftDetected: boolean;
  driftStatus: GateDriftStatus;
}

export interface GateDriftWindowComparison {
  pair: GateDriftComparisonPair;
  shortWindow: string;
  longWindow: string;
  shortWindowCycleCount: number;
  longWindowCycleCount: number;
  shortEvaluatedDenominator: number;
  longEvaluatedDenominator: number;
  shortExcludedCount?: number;
  longExcludedCount?: number;
  comparisonAllowed: boolean;
  comparisonReason: GateComparisonReason;
  driftStatus: GateDriftStatus;
  suspectedMetrics: string[];
  metrics: GateDriftMetricComparison[];
  thresholdAutoAdjusted: false;
  gatesRelaxed: false;
  notice: string;
}

export type RegimeDatasetScope =
  | 'LATEST_COMPLETED_CYCLE'
  | 'WINDOW_AGGREGATE'
  | 'DEDUPED_SYMBOLS'
  | 'PARTIAL_DATASET';

export interface PaperQualityIdentityCheckItem {
  formula: string;
  lhs: number;
  rhs: number;
  expression: string;
  valid: boolean;
}

export interface PaperQualityIdentityChecks {
  totalSymbolsIdentity: PaperQualityIdentityCheckItem;
  actionStateIdentity: PaperQualityIdentityCheckItem;
  uniqueUniverseIdentity: PaperQualityIdentityCheckItem;
  latencyCoverageIdentity: PaperQualityIdentityCheckItem;
  regimeCoverageIdentity: PaperQualityIdentityCheckItem;
  allValid: boolean;
}

export interface PaperQualityLatencySummary {
  detectionLatencyP50: number | null;
  detectionLatencyP95: number | null;
  detectionLatencyAverage: number | null;
  sampleCount: number;
  latencySampleSufficiency: SampleSufficiencyTier;
  latencySampleNotice: string;
  entryWindowMissedCount: number;
  entryWindowMissedRate: number;
  fastLaneCount: number;
  bulkCount: number;
  latencyEvaluatedCount: number;
  latencySampleCount: number;
  missingLatencySampleCount: number;
  latencyCoverageRate: number;
  latencyExcludedReasons: Record<string, number>;
  latencyExcludedSymbols: Array<{
    symbol: string;
    reason: string;
    windowKey: string;
  }>;
  scannerLatencySampleSufficiency: SampleSufficiencyTier;
  fastLaneLatency: {
    p50: number | null;
    p95: number | null;
    average: number | null;
    sampleCount: number;
  };
  bulkLatency: {
    p50: number | null;
    p95: number | null;
    average: number | null;
    sampleCount: number;
  };
}

export interface PaperQualitySharedEnvelope extends SmcQualitySharedEnvelope {
  monitoringWindowId: string;
  isAtomicSnapshot: boolean;
  queryMode: 'ATOMIC_UNIFIED_SNAPSHOT' | 'SEPARATE_WINDOW_QUERY';
  atomicSnapshotNotice: string;
  latestCycleEvaluatedCount: number;
  uniqueEvaluatedSymbols: number;
  cumulativeEvaluationEvents: number;
  evaluationAggregationMode: EvaluationAggregationMode;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  excludedSymbols: number;
  evaluationExcludedReasons: Record<string, number>;
  fastLaneCount: number;
  bulkCount: number;
  latencyEvaluatedCount: number;
  latencySampleCount: number;
  missingLatencySampleCount: number;
  latencyCoverageRate: number;
  latencyExcludedReasons: Record<string, number>;
  latencyExcludedSymbols: Array<{
    symbol: string;
    reason: string;
    windowKey: string;
  }>;
  regimeScope: RegimeDatasetScope;
  regimeTotalSymbols: number;
  regimeEvaluatedCount: number;
  regimePendingCount: number;
  regimeFailedCount: number;
  regimeExcludedCount: number;
  regimeExcludedReasons: Record<string, number>;
  regimeCoverageRate: number;
  regimeDenominatorSummary: string;
  dataFreshness: {
    stale: boolean;
    fallback: boolean;
    missingData: string[];
    isDemo: boolean;
    dataStaleCount: number;
    fallbackCount: number;
    missingDataCount: number;
    status: 'FRESH' | 'STALE_OR_DEGRADED';
  };
  sampleSufficiency: SampleSufficiencyTier;
  sampleSufficiencyNotice: string;
  latencySampleSufficiency: SampleSufficiencyTier;
  performanceSampleCount: number;
  performanceSampleSufficiency: SampleSufficiencyTier;
  strategyValidityNotice: string;
  noClosedTradesNotice: string;
  zeroCandidateValidNotice: string;
  identityChecks: PaperQualityIdentityChecks;
}

export interface PaperQualityWindowSummary {
  window: '30d' | '60d' | '90d' | '7d' | '24h';
  monitoringWindowId: string;
  reportGeneratedAt: string;
  reportAnchorAt: string;
  windowStartAt: string;
  windowEndAt: string;
  isAtomicSnapshot: boolean;
  totalScanCycles: number;
  completedScanCycles: number;
  interruptedScanCycles: number;
  totalEvaluated: number;
  latestCycleEvaluatedCount: number;
  uniqueEvaluatedSymbols: number;
  cumulativeEvaluationEvents: number;
  evaluationAggregationMode: EvaluationAggregationMode;
  evaluationUniverseSize: number;
  evaluationExcludedCount: number;
  excludedSymbols: number;
  evaluationExcludedReasons: Record<string, number>;
  latestCycleStats: PaperQualityLatestCycleBreakdown;
  dedupedSymbolStats: PaperQualityDedupedSymbolsBreakdown;
  cumulativeEventStats: PaperQualityCumulativeEventsBreakdown;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  dataStaleCount: number;
  fallbackCount: number;
  missingDataCount: number;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
  wins: number;
  losses: number;
  expired: number;
  openSignals: number;
  openTrades: number;
  lifecycleSummary: SignalLifecycleSummary;
  metricStatus: PaperMetricStatus;
  sampleCount: number;
  closedSampleCount: number;
  sampleSufficiency: SampleSufficiencyTier;
  sampleSufficiencyNotice: string;
  latencySampleCount: number;
  latencySampleSufficiency: SampleSufficiencyTier;
  performanceSampleCount: number;
  performanceSampleSufficiency: SampleSufficiencyTier;
  strategyValidityNotice: string;
  noClosedTradesNotice: string;
  zeroCandidateValidNotice: string;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  averageHoldingTime: string | null;
}

export interface PaperQualityStatusResponse
  extends PaperQualitySharedEnvelope,
    PaperQualityWindowSummary {
  latestCycleStats: PaperQualityLatestCycleBreakdown;
  dedupedSymbolStats: PaperQualityDedupedSymbolsBreakdown;
  cumulativeEventStats: PaperQualityCumulativeEventsBreakdown;
  lifecycleSummary: SignalLifecycleSummary;
  recentCycles: PaperQualityCycleDetailRecord[];
  windows: {
    '30d': PaperQualityWindowSummary;
    '60d': PaperQualityWindowSummary;
    '90d': PaperQualityWindowSummary;
  };
  waitWatchHighRiskRatios: {
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    waitRatioPercent: number;
    watchRatioPercent: number;
    highRiskRatioPercent: number;
    longCandidateRatioPercent: number;
    shortCandidateRatioPercent: number;
  };
  gatePassRates: Record<string, number>;
  gateDriftStatus: GateDriftStatus;
  latencySummary: PaperQualityLatencySummary;
  lastUpdatedAt: string;
  candidateFunnel?: CycleCandidateFunnel;
  smcGateDiagnostics?: SmcGateDiagnosticsSummary;
  paperEligibilityAudit?: PaperEligibilityAuditSummary;
  nearMissCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  nearMissMissingGates?: Record<string, number>;
  lastBlockingGate?: string | null;
  blockedAfterSmcCandidateCount?: number;
  blockedAfterSmcCandidateReasons?: Record<string, number>;
  blockedByPaperEligibilityCount?: number;
  blockedByPaperEligibilityReasons?: Record<string, number>;
  eligiblePaperSignalCount?: number;
  paperOpenedCount?: number;
  candidateDetectedCount?: number;
  rootCauseVerdict?: CandidateScarcityRootCauseVerdict;
  rootCauseExplanation?: string;
}

export interface PaperQualityWindowReportResponse
  extends PaperQualitySharedEnvelope,
    PaperQualityWindowSummary {
  waitWatchHighRiskRatios: {
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    waitRatioPercent: number;
    watchRatioPercent: number;
    highRiskRatioPercent: number;
    longCandidateRatioPercent: number;
    shortCandidateRatioPercent: number;
  };
  gatePassRates: Record<string, number>;
  gateDriftStatus: GateDriftStatus;
  latencySummary: PaperQualityLatencySummary;
  cycles: PaperQualityCycleDetailRecord[];
  signals: SmcPaperQualitySignalRecord[];
  historicalSignalsOutsideWindowCount: number;
  historicalSignalsOutsideWindow: SmcPaperQualitySignalRecord[];
}

export interface PaperQualityGateDriftResponse
  extends Omit<PaperQualitySharedEnvelope, 'excludedSymbols'> {
  driftStatus: GateDriftStatus;
  driftThresholdPercent: number;
  thresholdAutoAdjusted: false;
  gatesRelaxed: false;
  evaluatedDenominator: number;
  excludedCount: number;
  currentGateStats: Record<string, PaperQualityCycleGateStat>;
  currentGatePassRates: {
    'BOS/MSS': number;
    'Liquidity Sweep': number;
    Displacement: number;
    'FVG/Order Block': number;
    'MTF Alignment': number;
    'OI/Funding': number;
    waitRatioPercent: number;
    watchRatioPercent: number;
    highRiskRatioPercent: number;
    longCandidateRatioPercent: number;
    shortCandidateRatioPercent: number;
  };
  comparisons: {
    latest_vs_previous_cycle: GateDriftWindowComparison;
    '7d_vs_30d': GateDriftWindowComparison;
    '30d_vs_60d': GateDriftWindowComparison;
    '60d_vs_90d': GateDriftWindowComparison;
  };
  comparisonList: GateDriftWindowComparison[];
  cycleGateHistory: Array<{
    cycleId: string;
    cycleStatus: string;
    cycleStartedAt?: string;
    cycleCompletedAt: string | null;
    totalSymbols: number;
    evaluatedDenominator: number;
    excludedCount: number;
    gateStats: Record<string, PaperQualityCycleGateStat>;
  }>;
  cycleHistoryCount: number;
  aggregationScope?: FunnelAggregationScope;
  statisticScope?: GateStatisticScope;
  evaluationUniverseSize: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  nearMissCount?: number;
  nearMissOneGateCount?: number;
  nearMissTwoGatesCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  formalCandidateCount?: number;
  fastLaneFormalCandidateCount?: number;
  bulkFormalCandidateCount?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  entryWindowMissedRate?: number | null;
  candidateDetectionLatencyP50?: number | null;
  candidateDetectionLatencyP95?: number | null;
  queueWaitP50?: number | null;
  queueWaitP95?: number | null;
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  scopedGateStatistics?: ScopedGateStatisticsSummary;
  observationShadowComparison?: ObservationShadowComparisonSummary;
  candidateFunnel?: CycleCandidateFunnel;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  consistencyErrors?: string[];
}

export interface PaperQualityMarketRegimesResponse
  extends PaperQualitySharedEnvelope {
  window: PaperQualityWindow;
  comparisonAllowed: boolean;
  overallConclusion: string;
  dimensions: Record<MarketRegimeDimensionKey, MarketRegimeDimensionReport>;
  dimensionList: MarketRegimeDimensionReport[];
}

export interface PaperQualitySignalsResponse extends PaperQualitySharedEnvelope {
  window: PaperQualityWindow;
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  paperOpened: number;
  paperClosed: number;
  entryWindowMissed: number;
  invalidated: number;
  blocked: number;
  lifecycleSummary: SignalLifecycleSummary;
  signals: SmcPaperQualitySignalRecord[];
  historicalSignalsOutsideWindowCount: number;
  historicalSignalsOutsideWindow: SmcPaperQualitySignalRecord[];
}

export interface PaperQualitySignalHistoryResponse
  extends PaperQualitySharedEnvelope {
  window: PaperMonitorReportWindow;
  totalTrackedRecords: number;
  inWindowCount: number;
  outsideWindowCount: number;
  lifecycleSummary: SignalLifecycleSummary;
  historicalLifecycleSummary: SignalLifecycleSummary;
  signalHistory: PaperQualitySignalHistoryRecord[];
  historicalSignalsOutsideWindowCount: number;
  historicalSignalsOutsideWindow: PaperQualitySignalHistoryRecord[];
}

export interface PaperQualityCyclesResponse extends PaperQualitySharedEnvelope {
  totalScanCycles: number;
  completedScanCycles: number;
  interruptedScanCycles: number;
  cycles: PaperQualityCycleDetailRecord[];
}

export interface PaperQualitySingleCycleResponse
  extends PaperQualitySharedEnvelope {
  cycle: PaperQualityCycleDetailRecord;
}

export interface PaperQualityExportResponse extends PaperQualitySharedEnvelope {
  exportedAt: string;
  status: PaperQualityStatusResponse;
  cycles: PaperQualityCycleDetailRecord[];
  reports: {
    '30d': PaperQualityWindowReportResponse;
    '60d': PaperQualityWindowReportResponse;
    '90d': PaperQualityWindowReportResponse;
  };
  gateDrift: PaperQualityGateDriftResponse;
  marketRegimes: PaperQualityMarketRegimesResponse;
  signalHistory: PaperQualitySignalHistoryRecord[];
  signals: SmcPaperQualitySignalRecord[];
}

// ============================================================================
// Phase 16: SMC PENDING Progress Tracking, Background Worker Health & Stuck Diagnostics Types
// ============================================================================

export type SmcPendingReason =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_CACHE'
  | 'WAITING_FOR_RATE_LIMIT'
  | 'WAITING_FOR_NEXT_BATCH'
  | 'RETRY_SCHEDULED'
  | 'FAILED_RETRYABLE';

export type SmcStalledReason =
  | 'WORKER_NO_PROGRESS'
  | 'LEASE_EXPIRED'
  | 'CACHE_PREWARM_STALLED'
  | 'RATE_LIMIT_BACKOFF'
  | 'EXCHANGE_API_UNAVAILABLE'
  | 'QUEUE_NOT_STARTED';

export type SmcScannerHealthStatus = 'HEALTHY' | 'DEGRADED' | 'STALLED' | 'IDLE';

export type SmcQueueHealthStatus =
  | 'HEALTHY'
  | 'BACKLOGGED'
  | 'BACKPRESSURE'
  | 'DRAINING'
  | 'STALLED'
  | 'INVALID';

export type SmcExchangeApiHealthStatus =
  | 'HEALTHY'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'DEGRADED';

export type SmcPendingBreakdownConsistency = 'VALID' | 'INVALID';

export type SmcMonitorWorkerState = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR';
export type SmcScanWorkerState =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';
export type SmcQueueWorkerState =
  | 'HEALTHY'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';
export type SmcProgressRateStatus = 'ACTIVE' | 'NO_ACTIVE_PROGRESS';

export interface SmcPendingSymbolRecord {
  symbol: string;
  exchange: ExchangeId;
  cycleId: string;
  queuedAt: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastProgressAt: string | null;
  pendingReason: SmcPendingReason;
  retryCount: number;
  nextRetryAt: string | null;
  priorityClass: SmcPriorityClass;
  executionWorker: SmcExecutionWorker;
  missingTimeframes: Timeframe[];
  missingData: string[];
  cacheMode: SmcCacheMode;
  priorityTier?: SmcScanPriorityTier;
  priorityLabel?: string;
  status?: SmcScanJobStatus;
  workerId?: string | null;
  leaseUntil?: string | null;
  leaseExpired?: boolean;
  stalled?: boolean;
  stalledReasons?: SmcStalledReason[];
  lastError?: string | null;
  ageMs?: number;
}

export interface SmcScanProgressHealthResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'PAPER ONLY' | 'live' | 'demo';
  liveOrders?: 'LIVE ORDERS DISABLED';
  executionPolicy?: 'NEVER AUTO-PLACE ORDERS';
  exchange: ExchangeId;
  scanMode?: 'live' | 'demo';
  databaseInstanceId?: string;
  cycleId: string;
  scanCycleId?: string;
  cycleStatus:
    | 'RUNNING'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'FAILED'
    | 'INTERRUPTED'
    | 'INCONSISTENT';
  workerState: 'RUNNING' | 'PAUSED' | 'IDLE';
  monitorWorkerState: SmcMonitorWorkerState;
  scanWorkerState: SmcScanWorkerState;
  queueWorkerState: SmcQueueWorkerState;
  monitoringWindowId?: string;
  windowStatus?: MonitoringWindowStatus;
  workerRestartCount: number;
  plannedRestartCount: number;
  unexpectedRestartCount: number;
  leaseRecoveryCount: number;
  databaseRecoveryCount: number;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  scannerHealth: SmcScannerHealthStatus;
  queueHealth: SmcQueueHealthStatus;
  exchangeApiHealth: SmcExchangeApiHealthStatus;
  totalSymbols: number;
  evaluatedCount: number;
  pendingCount: number;
  queuedCount: number;
  pureQueuedCount?: number;
  dbQueuedJobCount?: number;
  maxConcurrency: number;
  runningJobCount: number;
  concurrencyValid: boolean;
  statsConsistency: 'VALID' | 'INVALID';
  waitingForCacheCount: number;
  waitingForRateLimitCount: number;
  waitingForNextBatchCount: number;
  retryScheduledCount: number;
  failedRetryableCount: number;
  failedCount: number;
  rateLimitedCount: number;
  lastJobCompletedAt: string | null;
  lastProgressAt: string | null;
  progressRatePerMinute: number;
  progressRateStatus: SmcProgressRateStatus;
  estimatedRemainingDuration: number;
  oldestPendingAgeMs: number;
  stalledJobCount: number;
  stalledThresholdMs: number;
  stalledSuspected: boolean;
  stalledReasons: SmcStalledReason[];
  diagnosisLabel:
    | '正常背景評估中'
    | '背景掃描疑似卡住'
    | '掃描已完成'
    | '統計分類不一致';
  pendingBreakdownConsistency: SmcPendingBreakdownConsistency;
  pendingReasonCounts: Record<SmcPendingReason, number>;
  fastLanePendingCount: number;
  bulkPendingCount: number;
  pendingNotices: string[];
  pendingSymbols: SmcPendingSymbolRecord[];
  stuckJobs: SmcPendingSymbolRecord[];
  statsVersion: number;
  snapshotAt: string;
  candidateFunnel?: CycleCandidateFunnel;
  smcGateDiagnostics?: SmcGateDiagnosticsSummary;
  paperEligibilityAudit?: PaperEligibilityAuditSummary;
  scopedGateStatistics?: ScopedGateStatisticsSummary;
  observationShadowComparison?: ObservationShadowComparisonSummary;
  nearMissCount?: number;
  nearMissMissing1Count?: number;
  nearMissMissing2Count?: number;
  nearMissMissingGates?: Record<string, number>;
  lastBlockingGate?: string | null;
  blockedAfterSmcCandidateCount?: number;
  blockedAfterSmcCandidateReasons?: Record<string, number>;
  blockedByPaperEligibilityCount?: number;
  blockedByPaperEligibilityReasons?: Record<string, number>;
  eligiblePaperSignalCount?: number;
  paperEligibleCount?: number;
  entryWindowMissedCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  formalCandidateCount?: number;
  fastLaneFormalCandidateCount?: number;
  bulkFormalCandidateCount?: number;
  candidateDetectedBeforeEntryWindowCount?: number;
  entryWindowMissedRate?: number | null;
  candidateDetectionLatencyP50?: number | null;
  candidateDetectionLatencyP95?: number | null;
  queueWaitP50?: number | null;
  queueWaitP95?: number | null;
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  paperOpenedCount?: number;
  paperClosedCount?: number;
  blockedCount?: number;
  candidateDetectedCount?: number;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  consistencyErrors?: string[];
  rootCauseVerdict?: CandidateScarcityRootCauseVerdict;
  rootCauseExplanation?: string;
}

export interface SmcRetryStuckResponse extends SmcScanProgressHealthResponse {
  retriedCount: number;
  retriedSymbols: string[];
  skippedActiveRunningSymbols: string[];
  skippedRateLimitBackoffSymbols: string[];
  skippedActiveBackoffSymbols: string[];
  preservedCycleId: string;
  progress: SmcScanProgressHealthResponse;
}

// ============================================================================
// Phase 17: Long-Running Live Paper Scan Stability, Worker Recovery,
// SQLite Consistency & Real-Machine Operation Verification Types
// ============================================================================

export type Phase17WindowDuration = '24h' | '72h';

export type Phase17ErrorScenarioType =
  | 'HTTP_429_BACKOFF'
  | 'HTTP_503_HONEST_ERROR'
  | 'NETWORK_TIMEOUT_RETRY'
  | 'CACHE_EXPIRED_REFRESH'
  | 'SQLITE_BUSY_RETRY'
  | 'LEASE_EXPIRED_RECLAIMED'
  | 'SERVICE_RESTART_RECOVERY'
  | 'PARTIAL_CYCLE_INTERRUPTED';

export interface Phase17ErrorEventRecord {
  eventId: string;
  exchange: ExchangeId;
  scenarioType: Phase17ErrorScenarioType;
  occurredAt: string;
  symbol: string | null;
  cycleId: string | null;
  message: string;
  statsVersion: number;
}

export interface Phase17WindowCompletionCriteria {
  timeReached: boolean;
  zeroFailedCycles: boolean;
  zeroInterruptedCycles: boolean;
  zeroStalledDetected: boolean;
  integrityCheckPassed: boolean;
  dataIntegrityCheckPass: boolean;
  statsVersionMonotonic: boolean;
  zeroExternalNotifications: boolean;
  allStatisticalIdentitiesValid: boolean;
  allIdentitiesValid: boolean;
  concurrencyViolations: number;
  zeroConcurrencyViolations: boolean;
  zeroUnexpectedRestarts: boolean;
  canMarkCompleted: boolean;
}

export interface Phase17LongRunningWindowRecord {
  monitoringWindowId: string;
  duration: Phase17WindowDuration;
  windowDurationHours: 24 | 72;
  exchange: ExchangeId;
  startedAt: string;
  windowStartedAt: string;
  currentTime: string;
  expectedEndAt: string;
  windowExpectedEndAt: string;
  completedAt: string | null;
  elapsedDurationMs: number;
  elapsedDuration: string;
  remainingDurationMs: number;
  remainingDuration: string;
  windowStatus: MonitoringWindowStatus;
  canMarkCompleted: boolean;
  terminalReason: string | null;
  totalScanCycles: number;
  completedScanCycles: number;
  interruptedScanCycles: number;
  failedCycles: number;
  totalEvaluated: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  staleCount: number;
  fallbackCount: number;
  missingDataCount: number;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  stalledDetectedCount: number;
  workerRestartCount: number;
  plannedRestartCount: number;
  unexpectedRestartCount: number;
  leaseRecoveryCount: number;
  databaseRecoveryCount: number;
  concurrencyViolations: number;
  externalNotificationCount: 0;
  finalSnapshotAt: string | null;
  finalStatsVersion: number | null;
  finalCycleId: string | null;
  finalDatabaseHealth: string | null;
  finalBackupVerification: boolean | null;
  completionCriteria: Phase17WindowCompletionCriteria;
  statsVersion: number;
  snapshotAt: string;
}

export interface Phase17CycleIdentityChecks {
  universeTotalIdentityValid: boolean;
  evaluatedStateIdentityValid: boolean;
  pendingBreakdownIdentityValid: boolean;
  concurrencyCapIdentityValid: boolean;
  allFourIdentitiesValid: boolean;
}

export interface Phase17CycleLiveSnapshotRecord {
  cycleId: string;
  cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  cacheMode: SmcCacheMode;
  cycleStartedAt: string;
  cycleCompletedAt: string | null;
  totalSymbols: number;
  evaluatedCount: number;
  pendingCount: number;
  queuedCount: number;
  maxConcurrency?: number;
  runningJobCount: number;
  concurrencyValid?: boolean;
  failedCount: number;
  rateLimitedCount: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  lastProgressAt: string | null;
  progressRatePerMinute: number;
  progressRateStatus?: SmcProgressRateStatus;
  estimatedRemainingDuration: number;
  statsVersion: number;
  snapshotAt: string;
  identityChecks: Phase17CycleIdentityChecks;
}

export interface Phase17ProgressEvidenceSampleRecord {
  sampleId: string;
  sampledAt: string;
  monitoringWindowId: string;
  exchange: ExchangeId;
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  workerState: 'RUNNING' | 'PAUSED' | 'IDLE';
  monitorWorkerState?: SmcMonitorWorkerState;
  scanWorkerState?: SmcScanWorkerState;
  queueWorkerState?: SmcQueueWorkerState;
  maxConcurrency: number;
  runningJobCount: number;
  concurrencyValid: boolean;
  scannerHealth: SmcScannerHealthStatus;
  queueHealth: SmcQueueHealthStatus;
  exchangeApiHealth: SmcExchangeApiHealthStatus;
  evaluatedCount: number;
  pendingCount: number;
  queuedCount: number;
  failedCount: number;
  rateLimitedCount: number;
  lastProgressAt: string | null;
  progressRatePerMinute: number;
  progressRateStatus?: SmcProgressRateStatus;
  oldestPendingAgeMs: number;
  stalledSuspected: boolean;
  stalledReasons: SmcStalledReason[];
  integrityCheck: string;
  externalNotificationCount: 0;
  cacheHealth: 'HEALTHY' | 'PREWARMING' | 'DEGRADED' | 'COLD';
  pendingReasonCounts: Record<SmcPendingReason, number>;
  lastJobCompletedAt: string | null;
  estimatedRemainingDuration: number;
}

export type Phase17RecoveryTriggerReason =
  | 'GRACEFUL_SHUTDOWN_RESTART'
  | 'FORCED_WORKER_INTERRUPT_RESTART'
  | 'SQLITE_RECONNECT'
  | 'LEASE_RECOVERY'
  | 'STARTUP_RECOVERY'
  | 'PLANNED_RESTART'
  | 'UNEXPECTED_CRASH';

export interface Phase17ServiceRecoveryRecord {
  recoveryId: string;
  monitoringWindowId: string;
  monitoringWindow72hId?: string;
  exchange: ExchangeId;
  occurredAt: string;
  recoveredAt: string;
  restartedAt: string;
  triggerReason: Phase17RecoveryTriggerReason;
  planned: boolean;
  unexpected: boolean;
  leaseRecovery: boolean;
  databaseRecovery: boolean;
  serviceStoppedNormally: boolean;
  sqliteReconnected: boolean;
  reclaimedRunningJobsCount: number;
  recoveredRunningJobsCount: number;
  resumedQueuedJobsCount: number;
  preservedCompletedCount: number;
  duplicateRunningSymbolsCount: 0;
  maxConcurrency: number;
  runningJobCountAfter: number;
  concurrencyValidAfter: boolean;
  statsVersionBefore: number;
  statsVersionAfter: number;
  monotonicStatsVersionVerified: boolean;
  sqliteReconnectedVerified: boolean;
  expiredLeaseReclaimedVerified: boolean;
  queuedJobsResumedVerified: boolean;
  succeededNotRepeatedVerified: boolean;
  paperSignalsCountAfter: number;
  paperLedgerCountAfter: number;
  cacheRowCountAfter: number;
  historicalCyclesCountAfter: number;
  persistentDataPreservedVerified: boolean;
  plannedRestartCountAfter: number;
  unexpectedRestartCountAfter: number;
  leaseRecoveryCountAfter: number;
  databaseRecoveryCountAfter: number;
  workerRestartCountAfter: number;
  cycleId: string;
  databaseInstanceId: string;
  status: 'RECOVERED' | 'NO_ACTION_NEEDED';
}

export interface MonitoringWindowsListResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'PAPER ONLY';
  liveOrders: 'LIVE ORDERS DISABLED';
  executionPolicy: 'NEVER AUTO-PLACE ORDERS';
  exchange: ExchangeId;
  monitoringWindowId: string;
  windowStatus: MonitoringWindowStatus;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  currentWindows: {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  };
  previousWindows: {
    '24h': Phase17LongRunningWindowRecord | null;
    '72h': Phase17LongRunningWindowRecord | null;
  };
  monitoringWindows: {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  };
  windows: Phase17LongRunningWindowRecord[];
  recoveryEvents: Phase17ServiceRecoveryRecord[];
  statsVersion: number;
  snapshotAt: string;
}

export interface MonitoringWindowDetailResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'PAPER ONLY';
  liveOrders: 'LIVE ORDERS DISABLED';
  executionPolicy: 'NEVER AUTO-PLACE ORDERS';
  exchange: ExchangeId;
  window: Phase17LongRunningWindowRecord;
  monitoringWindowId: string;
  windowStatus: MonitoringWindowStatus;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  recoveryEvents: Phase17ServiceRecoveryRecord[];
  statsVersion: number;
  snapshotAt: string;
}

export interface SystemDatabaseHealthResponse {
  safety: typeof TRADING_SAFETY_FLAGS;
  mode: 'PAPER ONLY';
  liveOrders: 'LIVE ORDERS DISABLED';
  executionPolicy: 'NEVER AUTO-PLACE ORDERS';
  exchange: ExchangeId;
  monitoringWindowId: string;
  windowStatus: MonitoringWindowStatus;
  integrityCheck: string;
  integrityCheckPassed: boolean;
  journalMode: string;
  walStatus: 'ACTIVE' | 'MEMORY' | 'JOURNAL';
  activeDatabasePath: string;
  databaseInstanceId: string;
  latestStatsVersion: number;
  statsVersion: number;
  statsVersionMonotonic: boolean;
  lastWriteAt: string | null;
  lastBackupAt: string | null;
  backupFilePath: string | null;
  backupFileVerified: boolean;
  backupFileExists: boolean;
  backupFileReadable: boolean;
  backupFileSizeBytes: number;
  backupSqliteHeaderValid: boolean;
  databaseFileSizeBytes: number;
  cacheRowCount: number;
  paperSignalCount: number;
  paperLedgerCount: number;
  notificationOutboxCount: number;
  workerState: 'RUNNING' | 'PAUSED' | 'IDLE';
  monitorWorkerState: SmcMonitorWorkerState;
  scanWorkerState: SmcScanWorkerState;
  queueWorkerState: SmcQueueWorkerState;
  maxConcurrency: number;
  runningJobCount: number;
  concurrencyValid: boolean;
  statsConsistency: 'VALID' | 'INVALID';
  scannerHealth: SmcScannerHealthStatus;
  queueHealth: SmcQueueHealthStatus;
  exchangeApiHealth: SmcExchangeApiHealthStatus;
  cacheHealth: 'HEALTHY' | 'PREWARMING' | 'DEGRADED' | 'COLD';
  cacheMode: SmcCacheMode;
  lastProgressAt: string | null;
  lastJobCompletedAt: string | null;
  progressRatePerMinute: number;
  progressRateStatus: SmcProgressRateStatus;
  oldestPendingAgeMs: number;
  stalledSuspected: boolean;
  stalledReasons: SmcStalledReason[];
  lastError: string | null;
  rateLimit429Count: number;
  http503Count: number;
  networkTimeoutCount: number;
  workerRestartCount: number;
  plannedRestartCount: number;
  unexpectedRestartCount: number;
  leaseRecoveryCount: number;
  databaseRecoveryCount: number;
  stalledDetectedCount: number;
  concurrencyViolations: number;
  windowPlannedRestartCount: number;
  windowUnexpectedRestartCount: number;
  windowLeaseRecoveryCount: number;
  windowDatabaseRecoveryCount: number;
  windowStalledDetectedCount: number;
  windowConcurrencyViolationCount: number;
  lifetimePlannedRestartCount: number;
  lifetimeUnexpectedRestartCount: number;
  lifetimeLeaseRecoveryCount: number;
  lifetimeDatabaseRecoveryCount: number;
  lifetimeStalledDetectedCount: number;
  lifetimeConcurrencyViolationCount: number;
  externalNotificationCount: 0;
  errorEventCounts: Record<Phase17ErrorScenarioType, number>;
  errorEvents: Phase17ErrorEventRecord[];
  monitoringWindows: {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  };
  currentWindows: {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  };
  previousWindows: {
    '24h': Phase17LongRunningWindowRecord | null;
    '72h': Phase17LongRunningWindowRecord | null;
  };
  allWindows: Phase17LongRunningWindowRecord[];
  recoveryEvents: Phase17ServiceRecoveryRecord[];
  recentCycleSnapshots: Phase17CycleLiveSnapshotRecord[];
  progressEvidenceSamples: Phase17ProgressEvidenceSampleRecord[];
  lastRecoveryResult: Phase17ServiceRecoveryRecord | null;
  identityChecks: Phase17CycleIdentityChecks;
  stabilityNotices: string[];
  snapshotAt: string;
}

// ============================================================================
// Live Candidate Scarcity Root-Cause Diagnostics, Funnel & Near-Miss Types
// ============================================================================

export type CandidateScarcityRootCauseVerdict =
  | 'STRICT_GATE_NO_CURRENT_SIGNAL'
  | 'ENTRY_LATENCY_MISSED'
  | 'SNAPSHOT_MIXING_BUG'
  | 'PAPER_ELIGIBILITY_BUG'
  | 'SIGNAL_ENGINE_BUG';

export interface SymbolSmcGateEvaluation {
  bosMssPassed: boolean;
  liquiditySweepPassed: boolean;
  displacementPassed: boolean;
  fvgOrObPassed: boolean;
  mtfAlignmentPassed: boolean;
  atrPassed: boolean;
  historyPassed: boolean;
  oiPassed: boolean;
  fundingPassed: boolean;
  oiFundingPassed?: boolean;
  dataFreshnessPassed?: boolean;
  liquiditySafetyPassed: boolean;
  riskSafetyPassed: boolean;
  waitReasons: string[];
  missingGates: string[];
  lastBlockingGate: string | null;
  nearMissStatus?: NearMissStatus;
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export interface SmcNearMissSymbolRecord {
  symbol: string;
  smcActionState: SmcActionState;
  marketRadarCategory: MarketRadarCategory;
  nearMissStatus?: NearMissStatus;
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
  score?: number;
  missingGateCount: 1 | 2;
  missingGates: string[];
  lastBlockingGate: string;
  waitReasons: string[];
  evaluationLatencyMs: number | null;
  nextBarRemainingMs: number | null;
  queueWaitMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  dataFreshnessSeconds?: number | null;
  stale?: boolean;
  isDemo?: boolean;
  isFastLane?: boolean;
  candidateDetectionLatencyMs?: undefined;
  detectionLatencyMs?: undefined;
  entryWindowDelayMs?: undefined;
  entryWindowMissed?: undefined;
}

export interface DemoLatencyFixtureSummary {
  evidenceType: 'DEMO_LATENCY_FIXTURE';
  isDemo: true;
  neverMixedIntoLive: true;
  formalCandidateCount: number;
  fastLaneCount: number;
  bulkCount: number;
  detectedBeforeEntryWindowCount: number;
  entryWindowMissedCount: number;
  detectionLatencyP50: number | null;
  detectionLatencyP95: number | null;
  fastLaneDetectionLatencyP50?: number | null;
  fastLaneDetectionLatencyP95?: number | null;
  bulkDetectionLatencyP50?: number | null;
  bulkDetectionLatencyP95?: number | null;
  queueWaitP50: number | null;
  queueWaitP95: number | null;
  note?: string;
  notice?: string;
}

export interface FormalCandidateSlaRecord {
  symbol: string;
  exchange: ExchangeId;
  smcActionState: 'LONG CANDIDATE' | 'SHORT CANDIDATE';
  finalTradeSignal: '多頭交易候選' | '空頭交易候選';
  signalBarOpenTime?: number | null;
  signalBarCloseTime?: number | null;
  nextBarOpenTime: number | null;
  candidateDetectedAt: string;
  signalDetectedAt: string;
  queueEnteredAt: string | null;
  evaluationStartedAt: string;
  evaluationCompletedAt: string;
  queueWaitMs: number | null;
  evaluationLatencyMs: number | null;
  candidateDetectionLatencyMs: number | null;
  nextBarRemainingMs: number | null;
  entryWindowDelayMs: number | null;
  entryWindowMissed: boolean;
  entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN' | 'ENTRY_WINDOW_MISSED';
  isFastLane: boolean;
  priorityClass: SmcPriorityClass;
  paperEligibilityStatus: PaperEligibilityStatus;
  isDemo?: boolean;
  evidenceScope?: 'LIVE_PRODUCTION' | 'LIVE' | 'DEMO_LATENCY_FIXTURE';
}

export interface FormalCandidateLatencySlaSummary {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  formalCandidateCount: number;
  fastLaneFormalCandidateCount: number;
  bulkFormalCandidateCount: number;
  fastLaneCandidateCount: number;
  bulkCandidateCount: number;
  candidateDetectedBeforeEntryWindowCount: number;
  entryWindowMissedCount: number;
  entryWindowMissedRate: number | null;
  candidateDetectionLatencyP50: number | null;
  candidateDetectionLatencyP95: number | null;
  queueWaitP50: number | null;
  queueWaitP95: number | null;
  evaluationLatencyP50: number | null;
  evaluationLatencyP95: number | null;
  fastLaneCandidateDetectionLatencyP50: number | null;
  fastLaneCandidateDetectionLatencyP95: number | null;
  bulkCandidateDetectionLatencyP50: number | null;
  bulkCandidateDetectionLatencyP95: number | null;
  fastLaneQueueWaitP50: number | null;
  fastLaneQueueWaitP95: number | null;
  bulkQueueWaitP50: number | null;
  bulkQueueWaitP95: number | null;
  fastLaneLatency: {
    count: number;
    candidateDetectionLatencyP50: number | null;
    candidateDetectionLatencyP95: number | null;
    queueWaitP50: number | null;
    queueWaitP95: number | null;
    evaluationLatencyP50: number | null;
    evaluationLatencyP95: number | null;
  };
  bulkLatency: {
    count: number;
    candidateDetectionLatencyP50: number | null;
    candidateDetectionLatencyP95: number | null;
    queueWaitP50: number | null;
    queueWaitP95: number | null;
    evaluationLatencyP50: number | null;
    evaluationLatencyP95: number | null;
  };
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  candidates: FormalCandidateSlaRecord[];
  statusNotice?: string;
}

export type FunnelAggregationScope =
  | 'CURRENT_CYCLE'
  | 'LATEST_SNAPSHOT'
  | 'MONITORING_WINDOW'
  | 'CUMULATIVE'
  | 'OUTSIDE_CURRENT_CYCLE'
  | 'OUTSIDE_MONITORING_WINDOW'
  | 'HISTORICAL_OUTSIDE_WINDOW';

export type HistoricalSignalScope =
  | 'OUTSIDE_CURRENT_CYCLE'
  | 'OUTSIDE_MONITORING_WINDOW';

export interface HistoricalSignalOutsideWindowItem {
  signalId: string;
  symbol: string;
  exchange?: ExchangeId;
  direction: 'LONG' | 'SHORT';
  smcActionState?: SmcActionState;
  scanCycleId: string;
  signalDetectedAt: string;
  signalBarOpenTime?: number | null;
  nextBarOpenTime?: number | null;
  status: string;
  entryStatus: string;
  historicalScope: HistoricalSignalScope;
  historicalCategory?: HistoricalSignalScope;
  outsideCurrentCycle: boolean;
  outsideMonitoringWindow: boolean;
  exclusionReason: string;
}

export interface HistoricalSignalsOutsideCurrentCycleBlock {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  scope: 'OUTSIDE_CURRENT_CYCLE';
  aggregationScope: 'OUTSIDE_CURRENT_CYCLE';
  evaluationUniverseSize: number;
  evaluatedDenominator: number;
  excludedCount: number;
  excludedSymbols: string[];
  excludedReasons: Record<string, number>;
  count: number;
  signals: HistoricalSignalOutsideWindowItem[];
  candidateDetectedCount: number;
  paperEligibleCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  entryWindowMissedCount: number;
  statsConsistency: 'VALID' | 'INVALID';
  consistencyErrors: string[];
}

export interface HistoricalSignalsOutsideWindowBlock {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  scope?: 'OUTSIDE_MONITORING_WINDOW';
  aggregationScope: 'HISTORICAL_OUTSIDE_WINDOW' | 'OUTSIDE_MONITORING_WINDOW';
  evaluationUniverseSize: number;
  evaluatedDenominator: number;
  excludedCount: number;
  excludedSymbols: string[];
  excludedReasons: Record<string, number>;
  count: number;
  signals: HistoricalSignalOutsideWindowItem[];
  outsideCurrentCycleCount?: number;
  outsideCurrentCycleSignals?: HistoricalSignalOutsideWindowItem[];
  outsideMonitoringWindowCount?: number;
  outsideMonitoringWindowSignals?: HistoricalSignalOutsideWindowItem[];
  candidateDetectedCount: number;
  paperEligibleCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  entryWindowMissedCount: number;
  outside90dMissedCount?: number;
  within90dMissedCount?: number;
  statsConsistency: 'VALID' | 'INVALID';
  consistencyErrors: string[];
}

export interface ScopedFunnelBlock {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  aggregationScope: FunnelAggregationScope;
  evaluationUniverseSize: number;
  evaluatedDenominator: number;
  excludedCount: number;
  excludedSymbols: string[];
  excludedReasons: Record<string, number>;
  excludedSymbolDetails?: Array<{ symbol: string; reason: string }>;
  totalSymbols: number;
  evaluatedCount: number;
  pendingCount: number;
  failedCount: number;
  rateLimitedCount: number;
  radarLongCount?: number;
  radarShortCount?: number;
  waitCount: number;
  watchCount: number;
  highRiskCount: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  formalCandidateCount?: number;
  nearMissCount: number;
  nearMissOneGateCount: number;
  nearMissTwoGatesCount: number;
  candidateDetectedCount: number;
  paperEligibleCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  entryWindowMissedCount: number;
  blockedCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  statsConsistency: 'VALID' | 'INVALID';
  consistencyErrors: string[];
}

export interface ScopedGateStatisticItem {
  cycleId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  aggregationScope?: FunnelAggregationScope;
  gate: string;
  label: string;
  passCount: number;
  failCount: number;
  evaluationUniverseSize?: number;
  evaluatedDenominator: number;
  excludedCount: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  passRate: number;
  failureRate: number;
  statisticScope: GateStatisticScope;
}

export interface ScopedGateStatisticsSummary {
  cycleId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  totalUniverseCount: number;
  allEvaluatedDenominator: number;
  allEvaluatedExcludedCount: number;
  allEvaluatedExcludedSymbols?: string[];
  allEvaluatedExcludedReasons?: Record<string, number>;
  nearMissDenominator: number;
  nearMissExcludedCount: number;
  nearMissExcludedSymbols?: string[];
  nearMissExcludedReasons?: Record<string, number>;
  candidateEligibleDenominator: number;
  candidateEligibleExcludedCount: number;
  candidateEligibleExcludedSymbols?: string[];
  candidateEligibleExcludedReasons?: Record<string, number>;
  allEvaluated: Record<string, ScopedGateStatisticItem>;
  nearMissOnly: Record<string, ScopedGateStatisticItem>;
  candidateEligibleOnly: Record<string, ScopedGateStatisticItem>;
  scopeClarificationNotice: string;
}

export interface ObservationShadowModeBreakdown {
  mode:
    | 'STRICT_PRODUCTION'
    | 'OBSERVATION_SHADOW_ONE_GATE_MISSING'
    | 'OBSERVATION_SHADOW_TWO_GATES_MISSING';
  modeLabel: string;
  isFormalProduction: boolean;
  paperTradingAllowed: boolean;
  paperCreationAllowed: boolean;
  paperLedgerWriteAllowed: boolean;
  notificationAllowed: boolean;
  formalSmcStateOverwritten: false;
  finalTradeSignalOverwritten: false;
  evaluatedCount: number;
  candidateCount: number;
  additionalObservationCount?: number;
  longCandidateCount: number;
  shortCandidateCount: number;
  nearMissCount: number;
  nearMissOneGateCount: number;
  nearMissTwoGatesCount: number;
  entryWindowMissedCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  expectancyR: number | null;
  sampleSufficiency: SampleSufficiencyTier;
  candidateSymbols: string[];
}

export interface ObservationShadowComparisonSummary {
  cycleId?: string;
  evaluatedCount: number;
  strictProduction: ObservationShadowModeBreakdown;
  observationShadowOneGateMissing: ObservationShadowModeBreakdown;
  observationShadowTwoGatesMissing: ObservationShadowModeBreakdown;
  STRICT_PRODUCTION: ObservationShadowModeBreakdown;
  OBSERVATION_SHADOW_ONE_GATE_MISSING: ObservationShadowModeBreakdown;
  OBSERVATION_SHADOW_TWO_GATES_MISSING: ObservationShadowModeBreakdown;
  singleGateRelaxationImpact: Record<
    string,
    {
      gate: string;
      label: string;
      additionalCandidatesIfRelaxed: number;
      symbolsUnlocked: string[];
    }
  >;
  twoGateCombinationImpact: Array<{
    combination: string;
    gates: string[];
    additionalCandidatesIfRelaxed: number;
    symbolsUnlocked: string[];
  }>;
  topBottleneckGatesInAllEvaluated: Array<{
    gate: string;
    label: string;
    failCount: number;
    evaluatedDenominator: number;
    failureRate: number;
    statisticScope: 'ALL_EVALUATED';
  }>;
  topBottleneckGatesInNearMiss: Array<{
    gate: string;
    label: string;
    failCount: number;
    evaluatedDenominator: number;
    failureRate: number;
    statisticScope: 'NEAR_MISS_ONLY';
  }>;
  zeroCandidatePrimaryExplanation: string;
}

export interface SmcGateDiagnosticsSummary {
  cycleId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize: number;
  evaluatedDenominator: number;
  totalUniverseSymbols?: number;
  totalEvaluatedSymbols: number;
  excludedCount: number;
  excludedSymbols: string[];
  excludedReasons: Record<string, number>;
  excludedSymbolDetails?: Array<{ symbol: string; reason: string }>;
  fullGatePassCount: number;
  fullGatePassRatePercent: number;
  gatePassCounts: {
    bosMssPassed: number;
    liquiditySweepPassed: number;
    displacementPassed: number;
    fvgOrObPassed: number;
    mtfAlignmentPassed: number;
    atrPassed: number;
    historyPassed: number;
    oiPassed: number;
    fundingPassed: number;
    oiFundingPassed?: number;
    dataFreshnessPassed?: number;
    liquiditySafetyPassed: number;
    riskSafetyPassed: number;
    allGatesPassed: number;
  };
  gatePassRatesPercent: {
    bosMssPassed: number;
    liquiditySweepPassed: number;
    displacementPassed: number;
    fvgOrObPassed: number;
    mtfAlignmentPassed: number;
    atrPassed: number;
    historyPassed: number;
    oiPassed: number;
    fundingPassed: number;
    oiFundingPassed?: number;
    dataFreshnessPassed?: number;
    liquiditySafetyPassed: number;
    riskSafetyPassed: number;
    allGatesPassed: number;
  };
  scopedGateStatistics: ScopedGateStatisticsSummary;
  observationShadowComparison: ObservationShadowComparisonSummary;
  nearMissCount: number;
  nearMissMissing1Count: number;
  nearMissMissing2Count: number;
  nearMissMissingGates: Record<string, number>;
  lastBlockingGate: string | null;
  lastBlockingGateBreakdown: Record<string, number>;
  nearMissSymbols: SmcNearMissSymbolRecord[];
}

export interface CandidateFunnelStage {
  stage: string;
  stageKey?: string;
  stageLabel?: string;
  inputCount: number;
  outputCount: number;
  blockedCount: number;
  blockedReasons: Record<string, number>;
}

export interface CycleCandidateFunnel {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  excludedSymbolDetails?: Array<{ symbol: string; reason: string }>;
  totalSymbols?: number;
  radarLongCount: number;
  radarShortCount: number;
  radarObservationCount?: number;
  smcEvaluatedCount: number;
  smcPendingCount: number;
  smcFailedCount?: number;
  smcRateLimitedCount?: number;
  smcWaitCount: number;
  smcWatchCount: number;
  smcHighRiskCount: number;
  nearMissCount?: number;
  nearMissOneGateCount?: number;
  nearMissTwoGatesCount?: number;
  smcLongCandidateCount: number;
  smcShortCandidateCount: number;
  formalCandidateCount?: number;
  formalSmcCandidateCount?: number;
  candidateDetectedCount?: number;
  blockedAfterSmcCandidateCount?: number;
  blockedAfterSmcCandidateReasons?: Record<string, number>;
  eligiblePaperSignalCount: number;
  paperEligibleCount?: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  blockedByPaperEligibilityCount?: number;
  blockedByPaperEligibilityReasons?: Record<string, number>;
  blockedCount?: number;
  entryWindowMissedCount: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  paperOpenedCount: number;
  paperClosedCount?: number;
  statsConsistency?: 'VALID' | 'INVALID';
  consistencyErrors?: string[];
  formalCandidateLatencySla?: FormalCandidateLatencySlaSummary;
  DEMO_LATENCY_FIXTURE?: DemoLatencyFixtureSummary;
  LIVE_FORMAL_CANDIDATE_COUNT?: number;
  LIVE_FAST_LANE_COUNT?: number;
  LIVE_BULK_COUNT?: number;
  LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT?: number;
  LIVE_ENTRY_WINDOW_MISSED_COUNT?: number;
  LIVE_DETECTION_LATENCY_P50?: number | null;
  LIVE_DETECTION_LATENCY_P95?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P50?: number | null;
  LIVE_FAST_LANE_DETECTION_LATENCY_P95?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P50?: number | null;
  LIVE_BULK_DETECTION_LATENCY_P95?: number | null;
  currentCycleFunnel?: ScopedFunnelBlock;
  latestSnapshotFunnel?: ScopedFunnelBlock;
  monitoringWindowFunnel?: ScopedFunnelBlock;
  cumulativeFunnel?: ScopedFunnelBlock;
  historicalSignalsOutsideCurrentCycle?: HistoricalSignalsOutsideCurrentCycleBlock;
  historicalSignalsOutsideWindow?: HistoricalSignalsOutsideWindowBlock;
  fullMarketSeparatedCounts?: {
    radarLong: number;
    radarShort: number;
    smcWait: number;
    smcWatch: number;
    smcHighRisk: number;
    smcLongCandidate: number;
    smcShortCandidate: number;
    formalCandidateCount?: number;
    nearMissOneGate: number;
    nearMissTwoGates: number;
    candidateDetected: number;
    paperEligible: number;
    paperOpened: number;
    paperClosed: number;
    entryWindowMissed: number;
    blocked: number;
    currentCyclePaperEligibleCount?: number;
    historicalPaperEligibleCount?: number;
    monitoringWindowPaperEligibleCount?: number;
    cumulativePaperEligibleCount?: number;
    currentCycleEntryWindowMissedCount?: number;
    monitoringWindowEntryWindowMissedCount?: number;
    cumulativeEntryWindowMissedCount?: number;
    historicalSignalsOutsideWindowCount?: number;
    historicalSignalsOutsideCurrentCycleCount?: number;
  };
  stages: CandidateFunnelStage[];
}

export interface PaperEligibilityAuditSummary {
  cycleId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  aggregationScope?: FunnelAggregationScope;
  evaluationUniverseSize?: number;
  evaluatedDenominator?: number;
  excludedCount?: number;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  candidateCount: number;
  formalCandidateCount?: number;
  eligiblePaperSignalCount: number;
  currentCyclePaperEligibleCount?: number;
  historicalPaperEligibleCount?: number;
  monitoringWindowPaperEligibleCount?: number;
  cumulativePaperEligibleCount?: number;
  blockedByPaperEligibilityCount: number;
  blockedByPaperEligibilityReasons: Record<string, number>;
  blockedByPaperEligibilityNotice?: string | null;
  statusNotice?: string;
  candidateDetectedCount?: number;
  entryWindowMissedCount: number;
  currentCycleEntryWindowMissedCount?: number;
  monitoringWindowEntryWindowMissedCount?: number;
  cumulativeEntryWindowMissedCount?: number;
  historicalSignalsOutsideWindowCount?: number;
  historicalSignalsOutsideCurrentCycleCount?: number;
  paperOpenedCount: number;
  paperClosedCount?: number;
  finalTradeSignalOverwrittenCount?: number;
}
