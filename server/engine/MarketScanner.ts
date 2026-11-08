import {
  CandidateScarcityRootCauseVerdict,
  CycleCandidateFunnel,
  DataProvenance,
  DataQualityReport,
  EvidenceItem,
  ExchangeId,
  FinalTradeSignal,
  FullMarketGateStatistics,
  MarketRadarCategory,
  MarketScannerConfig,
  MarketScanResponse,
  MarketTicker,
  NearMissStatus,
  PaperEligibilityStatus,
  RadarGateReasonStatistics,
  ScanCategory,
  ScannedCandidate,
  ScoreBreakdown,
  SmcActionState,
  SmcAnalysisResult,
  SmcEvaluationStatus,
  SmcGateDiagnosticsSummary,
  SmcNearMissSymbolRecord,
  SymbolDecisionGates,
  SymbolDecisionTrace,
  SymbolFunnelDiagnosticRecord,
  SymbolSmcGateEvaluation,
  TRADING_SAFETY_FLAGS,
  VolumeTimeframe,
  WaitWatchReasonStatistics,
} from '../../src/types/market.ts';
import {
  DEFAULT_AGGREGATION_WINDOWS,
  DEFAULT_VOLUME_TIMEFRAME,
  evaluateHistoricalVolumeAnomaly,
  extractPriorConfirmedBaselineWindow,
  MAX_SANE_ROBUST_ZSCORE,
  MIN_HISTORY_SAMPLES,
} from './VolumeAnomalyEngine.ts';
import {
  enforceProvenanceIntegrity,
  isVerifiedLivePublicApiSource,
} from '../utils/provenanceQuarantine.ts';
import {
  buildSmcGateDiagnosticsSummary,
  deriveSymbolSmcGateEvaluationFromAnalysis,
  EvaluatedGateDiagnosticItemInput,
} from './SmcRuleEngine.ts';

export const MARKET_SCAN_RULE_VERSION = 'v2.1.0-phase2-15m-consistent-vol-multiex';

export const MIN_QUOTE_VOLUME_24H = 15_000_000; // $15M USDT 24h minimum liquidity for standard candidates
export const MAX_ALLOWED_SPREAD_PERCENT = 0.15; // 0.15% maximum real order-book bid-ask spread percent
export const LOW_LIQUIDITY_POLICY = 'ONLY_HIGH_RISK_OR_WATCH_OR_WAIT' as const;

export const DEFAULT_SCANNER_CONFIG: MarketScannerConfig = {
  MIN_QUOTE_VOLUME_24H,
  MAX_ALLOWED_SPREAD_PERCENT,
  LOW_LIQUIDITY_POLICY,
};

export interface MarketScanOptions {
  minQuoteVolume24h?: number;
  maxAllowedSpreadPercent?: number;
  mode?: 'live' | 'demo';
  exchange?: ExchangeId;
  volumeTimeframe?: VolumeTimeframe;
  currentVolumeTimeframe?: VolumeTimeframe;
  historicalVolumeTimeframe?: VolumeTimeframe;
  currentVolume15mMap?: Map<string, number>;
  historicalVolumeMap?: Map<string, number[]>;
  smcMap?: Map<
    string,
    Pick<SmcAnalysisResult, 'actionState' | 'waitReasons'> &
      Partial<Pick<SmcAnalysisResult, 'smcEvaluationStatus'>> & {
        evaluationStatus?: SmcEvaluationStatus;
        evaluatedAt?: string | null;
        dataFetchedAt?: string | null;
        marketRadarCategory?: MarketRadarCategory;
        finalTradeSignal?: FinalTradeSignal;
        smcAnalysis?: SmcAnalysisResult;
        gateEvaluation?: SymbolSmcGateEvaluation;
        entryWindowStatus?:
          | 'DETECTED_BEFORE_NEXT_BAR_OPEN'
          | 'ENTRY_WINDOW_MISSED'
          | 'NOT_APPLICABLE'
          | string
          | null;
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
        paperEligibilityStatus?: PaperEligibilityStatus;
        candidateDetectedAt?: string | null;
        signalDetectedAt?: string | null;
        paperOpenedAt?: string | null;
        entryWindowMissed?: boolean | null;
        blockedReason?: string | null;
      }
  >;
}

const EXTREME_FUNDING_THRESHOLD = 0.0005; // 0.05% per 8h interval
const HIGH_VOLATILITY_PCT_THRESHOLD = 12.0; // 12% 24h abs move

export function runMarketScan(
  tickers: MarketTicker[],
  rootProvenance: DataProvenance,
  options: MarketScanOptions = {}
): MarketScanResponse {
  const userMinVolumeFilter = options.minQuoteVolume24h ?? 0;
  const maxSpreadPercent =
    options.maxAllowedSpreadPercent ?? MAX_ALLOWED_SPREAD_PERCENT;
  const volumeTimeframe: VolumeTimeframe =
    options.volumeTimeframe ?? DEFAULT_VOLUME_TIMEFRAME;
  const currentVolumeTimeframe: VolumeTimeframe =
    options.currentVolumeTimeframe ?? volumeTimeframe;
  const historicalVolumeTimeframe: VolumeTimeframe =
    options.historicalVolumeTimeframe ?? volumeTimeframe;
  const aggregationWindow =
    DEFAULT_AGGREGATION_WINDOWS[historicalVolumeTimeframe];

  const safeRootProvenance = enforceProvenanceIntegrity({
    ...rootProvenance,
    volumeTimeframe: historicalVolumeTimeframe,
    aggregationWindow,
    volumeMetric: 'quoteVolume',
  });
  const explicitLiveRequested = options.mode === 'live';
  const scanMode: 'live' | 'demo' = explicitLiveRequested
    ? 'live'
    : options.mode ?? (safeRootProvenance.isDemo ? 'demo' : 'live');
  const exchange: ExchangeId =
    options.exchange ??
    (scanMode === 'demo' ? 'demo_synthetic' : 'binance_usdm');

  // Strictly quarantine Demo / Test Fixture data from entering Live scan results, Live stats, or Live candidates
  const eligibleTickers = tickers
    .map((t) => ({
      ...t,
      provenance: enforceProvenanceIntegrity({
        ...t.provenance,
        volumeTimeframe: historicalVolumeTimeframe,
        aggregationWindow,
        volumeMetric: 'quoteVolume',
      }),
    }))
    .filter((t) => {
      if (scanMode === 'live') {
        return (
          !t.provenance.isDemo &&
          !t.provenance.isTestFixture &&
          isVerifiedLivePublicApiSource(t.provenance.source)
        );
      }
      return true;
    });

  // Find BTCUSDT 24h change as market benchmark
  const btcTicker = eligibleTickers.find((t) => t.symbol === 'BTCUSDT');
  const btcChange24h = btcTicker ? btcTicker.priceChangePercent24h : null;

  // Compute cross-sectional 24h quoteVolume rank strictly as an AUXILIARY metric (never pretending to be historical volume anomaly)
  const sortedByVolume = [...eligibleTickers].sort(
    (a, b) => a.quoteVolume24h - b.quoteVolume24h
  );
  const volumeRankMap = new Map<string, number>();
  const totalCount = sortedByVolume.length;

  sortedByVolume.forEach((ticker, index) => {
    const percentile =
      totalCount > 1 ? Math.round((index / (totalCount - 1)) * 1000) / 10 : 100;
    volumeRankMap.set(ticker.symbol, percentile);
  });

  let missingFundingCount = 0;
  let missingSpreadCount = 0;
  let staleRecordCount = 0;
  let lowLiquidityCount = 0;
  let extremeFundingCount = 0;
  let historicalVolumeReadyCount = 0;

  let insufficientHistoryCount = 0;
  let baselineUnstableCount = 0;
  let liquidityRejectedCount = 0;
  let momentumPassedCount = 0;
  let relativeBtcPassedCount = 0;
  let marketRadarLongCount = 0;
  let marketRadarShortCount = 0;
  let smcPendingCount = 0;
  let smcWaitCount = 0;
  let smcWatchCount = 0;
  let smcLongCandidateCount = 0;
  let smcShortCandidateCount = 0;
  let smcHighRiskCount = 0;
  let smcGateNotConfirmedCount = 0;
  let blockedAfterSmcCandidateCount = 0;
  const blockedAfterSmcCandidateReasons: Record<string, number> = {};
  const evaluatedGateItems: EvaluatedGateDiagnosticItemInput[] = [];
  const symbolFunnelDiagnostics: SymbolFunnelDiagnosticRecord[] = [];

  const allCandidates: ScannedCandidate[] = [];

  for (const ticker of eligibleTickers) {
    // Normalize real bid/ask spread fields; never fabricate spread if missing
    const hasRealBidAsk =
      ticker.bidPrice !== null &&
      ticker.bidPrice !== undefined &&
      ticker.askPrice !== null &&
      ticker.askPrice !== undefined &&
      Number.isFinite(ticker.bidPrice) &&
      Number.isFinite(ticker.askPrice) &&
      ticker.bidPrice > 0 &&
      ticker.askPrice >= ticker.bidPrice;

    const bidPrice = hasRealBidAsk ? (ticker.bidPrice ?? null) : null;
    const askPrice = hasRealBidAsk ? (ticker.askPrice ?? null) : null;
    const spread =
      hasRealBidAsk && bidPrice !== null && askPrice !== null
        ? ticker.spread ?? Number((askPrice - bidPrice).toPrecision(6))
        : null;
    const spreadPercent =
      hasRealBidAsk && bidPrice !== null && askPrice !== null
        ? ticker.spreadPercent ??
          Number(
            (((askPrice - bidPrice) / ((askPrice + bidPrice) / 2)) * 100).toFixed(
              5
            )
          )
        : null;

    const missingData = [...ticker.provenance.missingData];
    if (spreadPercent === null && !missingData.includes('BID_ASK_SPREAD')) {
      missingData.push('BID_ASK_SPREAD');
    }

    const tickerProvenance: DataProvenance = {
      ...ticker.provenance,
      missingData,
      volumeTimeframe: historicalVolumeTimeframe,
      aggregationWindow,
      volumeMetric: 'quoteVolume',
    };

    // Evaluate Historical Volume Anomaly (Option A: 15m confirmed K-line quoteVolume vs 30 prior 15m confirmed K-line quoteVolumes;
    // NEVER use 24h ticker quoteVolume24h to calculate 15m Z-Score)
    const histSeries = options.historicalVolumeMap?.get(ticker.symbol) ?? [];
    let currentVolForAnomaly: number | null = null;
    let histVolsForAnomaly: number[] = histSeries;

    if (currentVolumeTimeframe === '24h') {
      currentVolForAnomaly = ticker.quoteVolume24h;
      histVolsForAnomaly =
        histSeries.length > MIN_HISTORY_SAMPLES
          ? histSeries.slice(0, -1)
          : histSeries;
    } else {
      // Option A ('15m'):
      // Strictly use ONLY the 30 confirmed 15m K-lines BEFORE the current bar as the baseline.
      // Never put the current 15m K-line into its own baseline.
      const explicitMapCurrent =
        options.currentVolume15mMap?.get(ticker.symbol) ?? null;

      if (explicitMapCurrent !== null && explicitMapCurrent !== undefined) {
        currentVolForAnomaly = explicitMapCurrent;
        histVolsForAnomaly =
          histSeries.length > MIN_HISTORY_SAMPLES
            ? histSeries.slice(0, -1).slice(-MIN_HISTORY_SAMPLES)
            : histSeries.slice(0, MIN_HISTORY_SAMPLES);
      } else if (histSeries.length > 0) {
        const extracted = extractPriorConfirmedBaselineWindow(
          histSeries,
          histSeries.length - 1,
          MIN_HISTORY_SAMPLES
        );
        currentVolForAnomaly = extracted.currentVolume;
        histVolsForAnomaly = extracted.historicalVolumes;
      } else {
        // No confirmed 15m bars -> do NOT substitute 24h ticker quoteVolume24h!
        currentVolForAnomaly = ticker.latestConfirmed15mQuoteVolume ?? null;
        histVolsForAnomaly = [];
      }
    }

    const historicalVolume = evaluateHistoricalVolumeAnomaly({
      symbol: ticker.symbol,
      exchange,
      currentVolume: currentVolForAnomaly,
      historicalVolumes: histVolsForAnomaly,
      volumeTimeframe,
      currentVolumeTimeframe,
      historicalVolumeTimeframe,
      aggregationWindow,
      volumeMetric: 'quoteVolume',
      baseProvenance: tickerProvenance,
    });

    if (historicalVolume.status === 'READY') {
      historicalVolumeReadyCount++;
    } else if (historicalVolume.status === 'INSUFFICIENT_HISTORY') {
      insufficientHistoryCount++;
    } else if (historicalVolume.status === 'BASELINE_UNSTABLE') {
      baselineUnstableCount++;
    }

    if (ticker.fundingRate === null) missingFundingCount++;
    if (spreadPercent === null) missingSpreadCount++;
    if (tickerProvenance.stale) staleRecordCount++;

    const auxVolPercentile = volumeRankMap.get(ticker.symbol) ?? 0;
    const absChange = Math.abs(ticker.priceChangePercent24h);
    const relativeBtcStrength =
      btcChange24h !== null
        ? Number((ticker.priceChangePercent24h - btcChange24h).toFixed(2))
        : 0;

    // Liquidity check uses 24h quote volume AND real order-book spreadPercent (ONLY if real bid/ask spread is available)
    const isRealSpreadTooWide =
      spreadPercent !== null && spreadPercent > maxSpreadPercent;

    const isLowLiquidity =
      ticker.quoteVolume24h < MIN_QUOTE_VOLUME_24H || isRealSpreadTooWide;

    if (isLowLiquidity) {
      lowLiquidityCount++;
      liquidityRejectedCount++;
    }

    const extremeFunding =
      ticker.fundingRate !== null &&
      Math.abs(ticker.fundingRate) >= EXTREME_FUNDING_THRESHOLD;
    if (extremeFunding) extremeFundingCount++;

    const lowLiquidityHighVolatility =
      isLowLiquidity && absChange >= HIGH_VOLATILITY_PCT_THRESHOLD;

    // Gate pass evaluations
    const isExtremeZScoreOutlier =
      historicalVolume.baselineUnstable ||
      historicalVolume.status === 'BASELINE_UNSTABLE' ||
      (historicalVolume.robustZScore !== null &&
        Math.abs(historicalVolume.robustZScore) > MAX_SANE_ROBUST_ZSCORE);

    const historyGatePassed =
      historicalVolume.status === 'READY' &&
      !historicalVolume.baselineUnstable &&
      historicalVolume.sampleCount >= MIN_HISTORY_SAMPLES &&
      !isExtremeZScoreOutlier;

    const liquidityGatePassed = !isLowLiquidity && !lowLiquidityHighVolatility;
    const momentumGatePassed = absChange >= 3.0;
    const relativeBtcGatePassed =
      (ticker.priceChangePercent24h > 0 && relativeBtcStrength >= 1.2) ||
      (ticker.priceChangePercent24h < 0 && relativeBtcStrength <= -1.2);
    const fundingGatePassed = ticker.fundingRate !== null && !extremeFunding;

    if (momentumGatePassed) {
      momentumPassedCount++;
    }
    if (relativeBtcGatePassed) {
      relativeBtcPassedCount++;
    }

    const hasCoreMissingOrStale =
      tickerProvenance.stale ||
      tickerProvenance.missingData.some(
        (m) => m !== 'BID_ASK_SPREAD' && m !== 'HISTORICAL_VOLUME_BASELINE'
      );
    const hasAnyMissingOrStale =
      tickerProvenance.stale || tickerProvenance.missingData.length > 0;

    // Pre-gate category & Layer 1 Market Radar Category (Evaluates Market Radar conditions BEFORE history / SMC gates)
    let categoryBeforeGates: ScanCategory = '準備觀察';
    let marketRadarCategory: MarketRadarCategory = '準備觀察';

    const passesAuxiliaryLiquidityRank =
      auxVolPercentile >= 40 ||
      ticker.quoteVolume24h >= MIN_QUOTE_VOLUME_24H * 2;

    if (
      lowLiquidityHighVolatility ||
      extremeFunding ||
      (spreadPercent !== null && spreadPercent > maxSpreadPercent * 2.0) ||
      (tickerProvenance.stale && absChange >= 10)
    ) {
      categoryBeforeGates = '高風險';
      marketRadarCategory = '高風險';
    } else if (isLowLiquidity) {
      categoryBeforeGates = absChange >= 8.0 ? '高風險' : '準備觀察';
      marketRadarCategory = absChange >= 8.0 ? '高風險' : '準備觀察';
    } else if (
      !hasCoreMissingOrStale &&
      passesAuxiliaryLiquidityRank &&
      ticker.priceChangePercent24h >= 3.0 &&
      relativeBtcStrength >= 1.2
    ) {
      categoryBeforeGates = '多頭候選';
      marketRadarCategory = '雷達多頭觀察';
    } else if (
      !hasCoreMissingOrStale &&
      passesAuxiliaryLiquidityRank &&
      ticker.priceChangePercent24h <= -3.0 &&
      relativeBtcStrength <= -1.2
    ) {
      categoryBeforeGates = '空頭候選';
      marketRadarCategory = '雷達空頭觀察';
    } else {
      categoryBeforeGates = '準備觀察';
      marketRadarCategory = '準備觀察';
    }

    if (marketRadarCategory === '雷達多頭觀察') {
      marketRadarLongCount++;
    } else if (marketRadarCategory === '雷達空頭觀察') {
      marketRadarShortCount++;
    }

    // Layer 2: SMC/ICT State evaluation
    // Symbols without full 5m/15m/1h/4h SMC evaluation MUST be marked PENDING (never conflated with evaluated WAIT)
    const cachedSmc = options.smcMap?.get(ticker.symbol);
    let smcEvaluationStatus: SmcEvaluationStatus = 'PENDING';
    let smcActionState: SmcActionState = 'PENDING';
    let smcStatusReason = 'SMC 尚未評估／點擊載入單幣種結構';
    let smcWaitReasons: string[] = [];
    let smcEvaluatedAt: string | null = null;
    let smcDataFetchedAt: string | null = null;
    let smcDataFreshnessSeconds: number | null = null;

    if (
      cachedSmc &&
      cachedSmc.smcEvaluationStatus !== 'PENDING' &&
      cachedSmc.evaluationStatus !== 'PENDING' &&
      cachedSmc.actionState !== 'PENDING'
    ) {
      smcEvaluationStatus = 'EVALUATED';
      smcActionState = cachedSmc.actionState;
      smcWaitReasons = [...cachedSmc.waitReasons];
      smcEvaluatedAt = cachedSmc.evaluatedAt ?? safeRootProvenance.fetchedAt;
      smcDataFetchedAt =
        cachedSmc.dataFetchedAt ??
        cachedSmc.evaluatedAt ??
        safeRootProvenance.fetchedAt;
      const evalMs = Date.parse(smcEvaluatedAt);
      if (Number.isFinite(evalMs)) {
        smcDataFreshnessSeconds = Math.max(
          0,
          Math.round((Date.now() - evalMs) / 1000)
        );
      }

      // Section 五: Enforce strict 1-to-1 invariant between smcActionState and finalTradeSignal:
      // LONG CANDIDATE -> 多頭交易候選
      // SHORT CANDIDATE -> 空頭交易候選
      // WAIT / WATCH / HIGH RISK / PENDING -> NONE
      if (
        smcActionState === 'LONG CANDIDATE' ||
        smcActionState === 'SHORT CANDIDATE'
      ) {
        if (extremeFunding || lowLiquidityHighVolatility) {
          smcActionState = 'HIGH RISK';
          const reason = extremeFunding
            ? '資金費率處於極端區間 (|Funding| >= 0.05%)，降級為 HIGH RISK'
            : '低流動性且高波動異常，降級為 HIGH RISK';
          if (!smcWaitReasons.includes(reason)) {
            smcWaitReasons.push(reason);
          }
          blockedAfterSmcCandidateCount++;
          const key = extremeFunding
            ? 'EXTREME_FUNDING_RISK'
            : 'LOW_LIQUIDITY_HIGH_VOLATILITY';
          blockedAfterSmcCandidateReasons[key] =
            (blockedAfterSmcCandidateReasons[key] ?? 0) + 1;
        } else if (isLowLiquidity) {
          smcActionState = 'WAIT';
          const reason =
            '低流動性保護（24h 成交額 < $15M 或盤口價差過寬），不列入交易候選';
          if (!smcWaitReasons.includes(reason)) {
            smcWaitReasons.push(reason);
          }
          blockedAfterSmcCandidateCount++;
          blockedAfterSmcCandidateReasons.LOW_LIQUIDITY_GATE =
            (blockedAfterSmcCandidateReasons.LOW_LIQUIDITY_GATE ?? 0) + 1;
        } else if (!historyGatePassed) {
          smcActionState = 'WAIT';
          const reason =
            '15m 已確認 K 線歷史成交量基線未就緒或異常 (INSUFFICIENT_HISTORY / BASELINE_UNSTABLE)';
          if (!smcWaitReasons.includes(reason)) {
            smcWaitReasons.push(reason);
          }
          blockedAfterSmcCandidateCount++;
          blockedAfterSmcCandidateReasons.HISTORY_VOLUME_BASELINE_GATE =
            (blockedAfterSmcCandidateReasons.HISTORY_VOLUME_BASELINE_GATE ??
              0) + 1;
        } else if (
          smcActionState === 'LONG CANDIDATE' &&
          marketRadarCategory === '雷達空頭觀察'
        ) {
          smcActionState = 'WATCH';
          const reason =
            '第一層市場雷達方向為空頭觀察，與多頭 SMC 結構方向不一致';
          if (!smcWaitReasons.includes(reason)) {
            smcWaitReasons.push(reason);
          }
          blockedAfterSmcCandidateCount++;
          blockedAfterSmcCandidateReasons.RADAR_DIRECTION_CONFLICT =
            (blockedAfterSmcCandidateReasons.RADAR_DIRECTION_CONFLICT ?? 0) + 1;
        } else if (
          smcActionState === 'SHORT CANDIDATE' &&
          marketRadarCategory === '雷達多頭觀察'
        ) {
          smcActionState = 'WATCH';
          const reason =
            '第一層市場雷達方向為多頭觀察，與空頭 SMC 結構方向不一致';
          if (!smcWaitReasons.includes(reason)) {
            smcWaitReasons.push(reason);
          }
          blockedAfterSmcCandidateCount++;
          blockedAfterSmcCandidateReasons.RADAR_DIRECTION_CONFLICT =
            (blockedAfterSmcCandidateReasons.RADAR_DIRECTION_CONFLICT ?? 0) + 1;
        } else if (
          smcActionState === 'LONG CANDIDATE' &&
          marketRadarCategory !== '雷達多頭觀察'
        ) {
          marketRadarCategory = '雷達多頭觀察';
          marketRadarLongCount++;
        } else if (
          smcActionState === 'SHORT CANDIDATE' &&
          marketRadarCategory !== '雷達空頭觀察'
        ) {
          marketRadarCategory = '雷達空頭觀察';
          marketRadarShortCount++;
        }
      }

      if (smcActionState === 'WAIT') {
        smcStatusReason =
          smcWaitReasons.length > 0
            ? smcWaitReasons.join('；')
            : '尚未形成完整 MSS/FVG/OB 或多週期未確認';
      } else if (smcActionState === 'WATCH') {
        smcStatusReason =
          smcWaitReasons.length > 0
            ? smcWaitReasons.join('；')
            : '已偵測部分結構證據（如 FVG 或多週期方向一致），等待完整 BOS/MSS 與位移確認';
      } else if (
        smcActionState === 'LONG CANDIDATE' ||
        smcActionState === 'SHORT CANDIDATE'
      ) {
        smcWaitReasons = [];
        smcStatusReason = `已確認完整 ${smcActionState} 結構與多週期共振`;
      } else {
        smcStatusReason =
          smcWaitReasons.length > 0
            ? smcWaitReasons.join('；')
            : '高風險擠壓或波動異常';
      }
    } else {
      smcEvaluationStatus = 'PENDING';
      smcActionState = 'PENDING';
      smcStatusReason = 'SMC 尚未評估／點擊載入單幣種結構';
      smcWaitReasons = [];
      smcEvaluatedAt = null;
      smcDataFetchedAt = null;
      smcDataFreshnessSeconds = null;
    }

    const smcGatePassed =
      smcEvaluationStatus === 'EVALUATED' &&
      (smcActionState === 'LONG CANDIDATE' ||
        smcActionState === 'SHORT CANDIDATE');

    // smcGateNotConfirmedCount strictly counts ONLY evaluated symbols that did not pass candidate conditions (excludes PENDING)
    if (smcEvaluationStatus === 'EVALUATED' && !smcGatePassed) {
      smcGateNotConfirmedCount++;
    }

    if (smcActionState === 'PENDING') {
      smcPendingCount++;
    } else if (smcActionState === 'WAIT') {
      smcWaitCount++;
    } else if (smcActionState === 'WATCH') {
      smcWatchCount++;
    } else if (smcActionState === 'LONG CANDIDATE') {
      smcLongCandidateCount++;
    } else if (smcActionState === 'SHORT CANDIDATE') {
      smcShortCandidateCount++;
    } else if (smcActionState === 'HIGH RISK') {
      smcHighRiskCount++;
    }

    let symbolGateEvaluation: SymbolSmcGateEvaluation | undefined = undefined;
    if (smcEvaluationStatus === 'EVALUATED') {
      const derived =
        deriveSymbolSmcGateEvaluationFromAnalysis(cachedSmc?.smcAnalysis, {
          actionState: smcActionState,
          waitReasons: smcWaitReasons,
          historyPassed: historyGatePassed,
          liquiditySafetyPassed: !isLowLiquidity,
          riskSafetyPassed: !extremeFunding && !lowLiquidityHighVolatility,
          fundingPassed: fundingGatePassed,
          dataFreshnessPassed: !hasCoreMissingOrStale && historyGatePassed,
        }) ??
        (cachedSmc?.gateEvaluation
          ? {
              ...cachedSmc.gateEvaluation,
              historyPassed: historyGatePassed,
              liquiditySafetyPassed: !isLowLiquidity,
              riskSafetyPassed: !extremeFunding && !lowLiquidityHighVolatility,
              fundingPassed: fundingGatePassed,
              dataFreshnessPassed: !hasCoreMissingOrStale && historyGatePassed,
              waitReasons: [...smcWaitReasons],
            }
          : undefined);
      if (derived) {
        symbolGateEvaluation = derived;
      }
    }

    if (ticker.quoteVolume24h < userMinVolumeFilter) {
      continue;
    }

    // 1A. Primary Historical Volume Anomaly Score (0 to 16): Strictly based on Rolling Median / MAD / Z-Score / RVOL
    let volumeAnomalyScore = 0;
    if (
      !isLowLiquidity &&
      historicalVolume.status === 'READY' &&
      !historicalVolume.baselineUnstable &&
      !isExtremeZScoreOutlier
    ) {
      const rvol = historicalVolume.rvol ?? 1;
      const z = historicalVolume.zScore ?? 0;
      const rvolPts = Math.min(9, Math.max(0, Math.round((rvol - 0.8) * 5)));
      const zPts = Math.min(7, Math.max(0, Math.round(z * 2.2)));
      volumeAnomalyScore = Math.min(16, rvolPts + zPts);
    }

    // 1B. Auxiliary Cross-Sectional 24h Volume Rank Score (0 to 8): Explicitly auxiliary liquidity breadth only
    const auxiliaryVolumeRankScore = isLowLiquidity
      ? Math.min(2, Math.round((auxVolPercentile / 100) * 3))
      : Math.round((auxVolPercentile / 100) * 8);

    const combinedVolumeScore = volumeAnomalyScore + auxiliaryVolumeRankScore;

    // 2. Momentum Score (0 to 24): sweet spot is 3.5% - 13.5%, extreme parabolic moves (>18%) get penalized
    let momentumScore = 0;
    if (absChange < 1.0) {
      momentumScore = Math.round(absChange * 4);
    } else if (absChange <= 13.5) {
      momentumScore = Math.round(4 + ((absChange - 1.0) / 12.5) * 20);
    } else if (absChange <= 22.0) {
      momentumScore = Math.max(
        10,
        Math.round(24 - ((absChange - 13.5) / 8.5) * 12)
      );
    } else {
      momentumScore = 8;
    }

    // 3. Relative BTC Strength Score (0 to 20)
    const relStrengthAligned =
      (ticker.priceChangePercent24h > 0 && relativeBtcStrength >= 1.5) ||
      (ticker.priceChangePercent24h < 0 && relativeBtcStrength <= -1.5);
    const absRel = Math.abs(relativeBtcStrength);
    let relativeBtcScore = 0;
    if (relStrengthAligned) {
      if (absRel <= 12) {
        relativeBtcScore = Math.min(20, Math.round(6 + (absRel / 12) * 14));
      } else {
        relativeBtcScore = Math.max(8, Math.round(20 - (absRel - 12) * 0.6));
      }
    } else {
      relativeBtcScore = Math.min(5, Math.round(absRel * 2));
    }

    // 4. Funding Risk Component (-20 to +12)
    let fundingRiskScore = 0;
    if (ticker.fundingRate === null) {
      fundingRiskScore = -12;
    } else if (extremeFunding) {
      fundingRiskScore = -20;
    } else if (Math.abs(ticker.fundingRate) <= 0.0002) {
      fundingRiskScore = 12;
    } else {
      fundingRiskScore = 6;
    }

    // 5. Liquidity Risk Component (-25 to +12)
    let liquidityRiskScore = 0;
    if (lowLiquidityHighVolatility) {
      liquidityRiskScore = -25;
    } else if (isLowLiquidity) {
      liquidityRiskScore = -18;
    } else if (spreadPercent === null) {
      liquidityRiskScore = 4;
    } else if (
      ticker.quoteVolume24h >= 100_000_000 &&
      spreadPercent <= maxSpreadPercent * 0.4
    ) {
      liquidityRiskScore = 12;
    } else {
      liquidityRiskScore = 8;
    }

    // 6. Data Quality Component (-20 to +10)
    const dataQualityScore = hasCoreMissingOrStale
      ? -20
      : hasAnyMissingOrStale
        ? -4
        : 10;

    const scoreBreakdown: ScoreBreakdown = {
      volumeAnomaly: volumeAnomalyScore,
      auxiliaryVolumeRank: auxiliaryVolumeRankScore,
      volumeProxy: combinedVolumeScore,
      momentum: momentumScore,
      relativeBtcStrength: relativeBtcScore,
      fundingRisk: fundingRiskScore,
      liquidityRisk: liquidityRiskScore,
      dataQuality: dataQualityScore,
    };

    const rawSum =
      scoreBreakdown.volumeProxy +
      scoreBreakdown.momentum +
      scoreBreakdown.relativeBtcStrength +
      scoreBreakdown.fundingRisk +
      scoreBreakdown.liquidityRisk +
      scoreBreakdown.dataQuality;

    // Final Trade Signal & Final Category with strict 1-to-1 invariant (Section 五):
    // LONG CANDIDATE -> 多頭交易候選
    // SHORT CANDIDATE -> 空頭交易候選
    // WAIT / WATCH / HIGH RISK / PENDING -> NONE
    let finalTradeSignal: FinalTradeSignal = 'NONE';
    if (smcActionState === 'LONG CANDIDATE') {
      finalTradeSignal = '多頭交易候選';
    } else if (smcActionState === 'SHORT CANDIDATE') {
      finalTradeSignal = '空頭交易候選';
    } else {
      finalTradeSignal = 'NONE';
    }

    let category: ScanCategory = '準備觀察';

    if (finalTradeSignal === '多頭交易候選') {
      category = '多頭候選';
    } else if (finalTradeSignal === '空頭交易候選') {
      category = '空頭候選';
    } else if (
      lowLiquidityHighVolatility ||
      extremeFunding ||
      smcActionState === 'HIGH RISK' ||
      (spreadPercent !== null && spreadPercent > maxSpreadPercent * 2.0) ||
      (tickerProvenance.stale && absChange >= 10)
    ) {
      category = '高風險';
    } else if (isLowLiquidity) {
      category = absChange >= 8.0 ? '高風險' : '準備觀察';
    } else {
      category = '準備觀察';
    }

    // Enforce anti-saturation & risk caps on final score
    const rawScoreBeforeCap = Math.max(0, Math.min(96, rawSum));
    let totalScore = rawScoreBeforeCap;
    let scoreCapApplied = false;
    let scoreCapRule: string | null = null;

    if (
      category === '高風險' ||
      isLowLiquidity ||
      extremeFunding ||
      hasCoreMissingOrStale ||
      historicalVolume.status !== 'READY' ||
      historicalVolume.baselineUnstable ||
      isExtremeZScoreOutlier
    ) {
      if (totalScore > 48) {
        scoreCapApplied = true;
      }
      totalScore = Math.min(totalScore, 48);

      const capTriggers: string[] = [];
      if (historicalVolume.status !== 'READY') {
        capTriggers.push(`historicalVolume.status !== 'READY' (${historicalVolume.status})`);
      }
      if (historicalVolume.baselineUnstable) {
        capTriggers.push('historicalVolume.baselineUnstable === true');
      }
      if (isExtremeZScoreOutlier) {
        capTriggers.push('isExtremeZScoreOutlier === true');
      }
      if (isLowLiquidity) {
        capTriggers.push('isLowLiquidity === true');
      }
      if (extremeFunding) {
        capTriggers.push('extremeFunding === true');
      }
      if (hasCoreMissingOrStale) {
        capTriggers.push('hasCoreMissingOrStale === true');
      }
      if (category === '高風險') {
        capTriggers.push(`category === '高風險'`);
      }
      scoreCapRule = `MarketScanner.ts Score Cap 48 Rule: Math.min(${rawScoreBeforeCap}, 48) triggered by [${capTriggers.join(', ')}]`;
    }

    // Build complete downgradeReasons trace
    const downgradeReasons: string[] = [];

    if (!liquidityGatePassed) {
      if (ticker.quoteVolume24h < MIN_QUOTE_VOLUME_24H) {
        downgradeReasons.push(
          `LIQUIDITY_GATE_REJECTED: 24h 成交額 ($${formatCompactUsd(
            ticker.quoteVolume24h
          )}) 低於最低流動性門檻 ($${formatCompactUsd(MIN_QUOTE_VOLUME_24H)})`
        );
      }
      if (isRealSpreadTooWide) {
        downgradeReasons.push(
          `SPREAD_GATE_REJECTED: 真實盤口價差 (${spreadPercent?.toFixed(
            4
          )}%) 高於上限 (${maxSpreadPercent}%)`
        );
      }
    }

    if (!fundingGatePassed) {
      if (ticker.fundingRate === null) {
        downgradeReasons.push('FUNDING_GATE_REJECTED: 缺少資金費率資料');
      } else if (extremeFunding) {
        downgradeReasons.push(
          `FUNDING_GATE_REJECTED: 資金費率處於極端區間 (${(
            ticker.fundingRate * 100
          ).toFixed(4)}% >= 0.05%)，列為高風險`
        );
      }
    }

    if (!momentumGatePassed) {
      downgradeReasons.push(
        `MOMENTUM_GATE_REJECTED: 24h 漲跌幅 (${ticker.priceChangePercent24h.toFixed(
          2
        )}%) 未達 ±3.0% 趨勢動能門檻`
      );
    }

    if (!relativeBtcGatePassed) {
      downgradeReasons.push(
        `RELATIVE_BTC_GATE_REJECTED: 相對 BTC 強弱 (${
          relativeBtcStrength >= 0 ? '+' : ''
        }${relativeBtcStrength.toFixed(2)}%) 未達 ±1.2% 同向超額強弱門檻`
      );
    }

    if (!historyGatePassed) {
      if (historicalVolume.timeframeMismatchRejected) {
        downgradeReasons.push(
          `HISTORY_GATE_TIMEFRAME_MISMATCH_REJECTED: ${
            historicalVolume.rejectionReason ||
            '量能時間週期不一致，直接拒絕計算 Z-Score'
          }，由 ${categoryBeforeGates} 降級為 ${category}`
        );
      } else if (
        historicalVolume.status === 'INSUFFICIENT_HISTORY' ||
        historicalVolume.sampleCount < MIN_HISTORY_SAMPLES
      ) {
        downgradeReasons.push(
          `HISTORY_GATE_INSUFFICIENT_SAMPLES: 歷史成交量樣本數 (${historicalVolume.sampleCount}/${historicalVolume.minRequiredSamples}, timeframe=${historicalVolume.volumeTimeframe}, window=${historicalVolume.aggregationWindow}) 未滿 MIN_HISTORY_SAMPLES=30 或缺少同週期 currentVolume，status=INSUFFICIENT_HISTORY，由 ${categoryBeforeGates} 降級為 ${category}`
        );
      } else if (
        historicalVolume.status === 'BASELINE_UNSTABLE' ||
        historicalVolume.baselineUnstable
      ) {
        const ratioPct =
          historicalVolume.madToMedianRatio !== null &&
          historicalVolume.madToMedianRatio !== undefined
            ? `${(historicalVolume.madToMedianRatio * 100).toFixed(2)}%`
            : 'N/A';
        if (
          historicalVolume.unstableReason === 'EXTREME_ROBUST_ZSCORE_OUTLIER'
        ) {
          downgradeReasons.push(
            `HISTORY_GATE_BASELINE_UNSTABLE (EXTREME_ROBUST_ZSCORE_OUTLIER): 雖然樣本數達 ${
              historicalVolume.sampleCount
            }/${
              historicalVolume.minRequiredSamples
            } 且 MAD/rollingMedian 比例為 ${ratioPct} (>= 3%)，但因 ${
              historicalVolume.volumeTimeframe
            } currentVolume ($${formatCompactUsd(
              historicalVolume.currentVolume
            )}) 對比歷史基線 (rollingMedian=$${formatCompactUsd(
              historicalVolume.rollingMedian ?? 0
            )}, MAD=$${formatCompactUsd(
              historicalVolume.mad ?? 0
            )}) 算出極端 Robust Z-Score (${
              historicalVolume.rawRobustZScore
            } > MAX_SANE_ROBUST_ZSCORE=${MAX_SANE_ROBUST_ZSCORE})，觸發 status=BASELINE_UNSTABLE，由 ${categoryBeforeGates} 降級為 ${category}`
          );
        } else {
          downgradeReasons.push(
            `HISTORY_GATE_BASELINE_UNSTABLE (MAD_RATIO_TOO_SMALL): 歷史量能 MAD/rollingMedian 比例過小 (${ratioPct} < 3%) 或接近 0，觸發 status=BASELINE_UNSTABLE，由 ${categoryBeforeGates} 降級為 ${category}`
          );
        }
      }
    }

    if (scoreCapApplied && scoreCapRule) {
      downgradeReasons.push(
        `SCORE_CAP_48_APPLIED: 原始加總分數 ${rawScoreBeforeCap} 被限制在 48 分 (${scoreCapRule})`
      );
    }

    if (smcEvaluationStatus === 'EVALUATED' && !smcGatePassed) {
      downgradeReasons.push(
        `SMC_GATE_NOT_CONFIRMED: 第二層 SMC/ICT 狀態為 ${smcActionState}（${smcStatusReason}）${
          categoryBeforeGates === '多頭候選' ||
          categoryBeforeGates === '空頭候選'
            ? `，第一層雖為「${marketRadarCategory}」，但因 SMC 未確認不得輸出多空交易候選，finalCategory 降級為「${category}」(finalTradeSignal: NONE)`
            : ''
        }`
      );
    } else if (smcEvaluationStatus === 'PENDING') {
      downgradeReasons.push(
        `SMC_EVALUATION_PENDING: 第二層 SMC 評估狀態為 PENDING（${smcStatusReason}）${
          categoryBeforeGates === '多頭候選' ||
          categoryBeforeGates === '空頭候選'
            ? `，第一層雖為「${marketRadarCategory}」，但尚未載入完整 5m/15m/1h/4h K 線完成 SMC 評估，不得輸出多空交易候選，finalCategory 維持「${category}」(finalTradeSignal: NONE)`
            : ''
        }`
      );
    }

    const gates: SymbolDecisionGates = {
      history: {
        volumeTimeframe: historicalVolume.volumeTimeframe,
        aggregationWindow: historicalVolume.aggregationWindow,
        volumeMetric: historicalVolume.volumeMetric,
        sampleCount: historicalVolume.sampleCount,
        minRequiredSamples: historicalVolume.minRequiredSamples,
        status: historicalVolume.status,
        passed: historyGatePassed,
        currentVolume: historicalVolume.currentVolume,
        rollingMedian: historicalVolume.rollingMedian,
        mad: historicalVolume.mad,
        madToMedianRatio: historicalVolume.madToMedianRatio ?? null,
        rawRobustZScore: historicalVolume.rawRobustZScore ?? null,
        unstableReason: historicalVolume.unstableReason ?? null,
        timeframeMismatchRejected:
          historicalVolume.timeframeMismatchRejected ?? false,
        rejectionReason: historicalVolume.rejectionReason ?? null,
      },
      liquidity: {
        quoteVolume24h: ticker.quoteVolume24h,
        spreadPercent,
        passed: liquidityGatePassed,
      },
      momentum: {
        change24h: ticker.priceChangePercent24h,
        passed: momentumGatePassed,
      },
      relativeBtc: {
        value: relativeBtcStrength,
        passed: relativeBtcGatePassed,
      },
      funding: {
        value: ticker.fundingRate,
        passed: fundingGatePassed,
      },
      smc: {
        evaluationStatus: smcEvaluationStatus,
        actionState: smcActionState,
        passed: smcGatePassed,
        reason: smcStatusReason,
        waitReasons: smcWaitReasons,
      },
    };

    const missingGates: string[] = symbolGateEvaluation?.missingGates ?? [];
    const nearMissStatus: NearMissStatus =
      smcEvaluationStatus !== 'EVALUATED' ||
      smcActionState === 'LONG CANDIDATE' ||
      smcActionState === 'SHORT CANDIDATE'
        ? 'NOT_NEAR_CANDIDATE'
        : symbolGateEvaluation?.nearMissStatus ??
          (missingGates.length === 1
            ? 'NEAR_MISS_ONE_GATE'
            : missingGates.length === 2
              ? 'NEAR_MISS_TWO_GATES'
              : 'NOT_NEAR_CANDIDATE');

    const intendedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
      smcActionState === 'LONG CANDIDATE'
        ? 'LONG'
        : smcActionState === 'SHORT CANDIDATE'
          ? 'SHORT'
          : symbolGateEvaluation?.intendedDirection ??
            (marketRadarCategory === '雷達多頭觀察'
              ? 'LONG'
              : marketRadarCategory === '雷達空頭觀察'
                ? 'SHORT'
                : 'NEUTRAL');

    const queueEnteredAt = cachedSmc?.queueEnteredAt ?? null;
    const evaluationStartedAt = cachedSmc?.smcEvaluationStartedAt ?? null;
    const evaluationCompletedAt =
      cachedSmc?.smcEvaluationCompletedAt ?? smcEvaluatedAt ?? null;
    const nextBarOpenTime = cachedSmc?.nextBarOpenTime ?? null;
    const rawDetectionLatencyMs = cachedSmc?.detectionLatencyMs ?? null;
    const queueWaitMs = cachedSmc?.queueWaitMs ?? null;
    const smcEvaluationLatencyMs = cachedSmc?.smcEvaluationLatencyMs ?? null;
    const evaluationLatencyMs =
      cachedSmc?.evaluationLatencyMs ?? smcEvaluationLatencyMs ?? null;

    const evalCompletedMs = evaluationCompletedAt
      ? Date.parse(evaluationCompletedAt)
      : NaN;
    const nextBarRemainingMs =
      cachedSmc?.nextBarRemainingMs !== undefined &&
      cachedSmc?.nextBarRemainingMs !== null
        ? cachedSmc.nextBarRemainingMs
        : nextBarOpenTime !== null && Number.isFinite(evalCompletedMs)
          ? Math.max(0, Math.round(nextBarOpenTime - evalCompletedMs))
          : null;

    const isFormalCandidate =
      smcActionState === 'LONG CANDIDATE' ||
      smcActionState === 'SHORT CANDIDATE';
    const candidateDetectedAt = isFormalCandidate
      ? cachedSmc?.candidateDetectedAt ?? smcEvaluatedAt
      : null;
    const signalDetectedAt = isFormalCandidate
      ? cachedSmc?.signalDetectedAt ?? smcEvaluatedAt
      : null;

    const signalDetectedMs = signalDetectedAt
      ? Date.parse(signalDetectedAt)
      : evalCompletedMs;

    const candidateDetectionLatencyMs = isFormalCandidate
      ? cachedSmc?.candidateDetectionLatencyMs ?? rawDetectionLatencyMs ?? null
      : null;
    const detectionLatencyMs = candidateDetectionLatencyMs;

    const entryWindowDelayMs = isFormalCandidate
      ? cachedSmc?.entryWindowDelayMs !== undefined &&
        cachedSmc?.entryWindowDelayMs !== null
        ? cachedSmc.entryWindowDelayMs
        : nextBarOpenTime !== null && Number.isFinite(signalDetectedMs)
          ? Math.round(signalDetectedMs - nextBarOpenTime)
          : null
      : null;

    const isFormalCandidateEntryMissed = isFormalCandidate
      ? Boolean(
          cachedSmc?.entryWindowMissed ??
            (cachedSmc?.entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
              (nextBarOpenTime !== null &&
                Number.isFinite(signalDetectedMs) &&
                signalDetectedMs >= nextBarOpenTime))
        )
      : false;
    const entryWindowMissed: boolean | null = isFormalCandidate
      ? isFormalCandidateEntryMissed
      : null;

    const paperEligibilityStatus: PaperEligibilityStatus =
      cachedSmc?.paperEligibilityStatus ??
      (!isFormalCandidate
        ? 'NOT_CANDIDATE'
        : isFormalCandidateEntryMissed || hasCoreMissingOrStale
          ? 'BLOCKED'
          : 'ELIGIBLE');

    const paperOpenedAt = isFormalCandidate
      ? cachedSmc?.paperOpenedAt ?? null
      : null;

    const blockedReason: string | null =
      cachedSmc?.blockedReason ??
      (isFormalCandidate && isFormalCandidateEntryMissed
        ? 'ENTRY_WINDOW_MISSED: signalDetectedAt >= nextBar.openTime，嚴格禁止回填已錯過的開盤價'
        : !isFormalCandidate && smcEvaluationStatus === 'EVALUATED'
          ? smcStatusReason
          : smcEvaluationStatus === 'PENDING'
            ? 'SMC_PENDING: 尚未完成 5m/15m/1h/4h 結構評估'
            : null);

    if (symbolGateEvaluation) {
      evaluatedGateItems.push({
        symbol: ticker.symbol,
        smcActionState,
        marketRadarCategory,
        gateEvaluation: symbolGateEvaluation,
        score: totalScore,
        detectionLatencyMs: candidateDetectionLatencyMs,
        candidateDetectionLatencyMs,
        evaluationLatencyMs,
        nextBarRemainingMs,
        queueWaitMs,
        smcEvaluationLatencyMs,
        entryWindowDelayMs,
        entryWindowMissed,
        dataFreshnessSeconds: smcDataFreshnessSeconds,
        stale: tickerProvenance.stale,
        isDemo: tickerProvenance.isDemo,
        isFastLane: cachedSmc?.isFastLane ?? false,
      });
    }

    symbolFunnelDiagnostics.push({
      symbol: ticker.symbol,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      finalTradeSignal,
      paperEligibilityStatus,
      candidateDetectedAt,
      signalDetectedAt,
      paperOpenedAt,
      entryWindowMissed,
      blockedReason,
      missingGates,
      detectionLatencyMs: candidateDetectionLatencyMs,
      candidateDetectionLatencyMs,
      evaluationLatencyMs,
      nextBarRemainingMs,
      queueWaitMs,
      smcEvaluationLatencyMs,
      nearMissStatus,
      queueEnteredAt,
      evaluationStartedAt,
      evaluationCompletedAt,
      nextBarOpenTime,
      entryWindowDelayMs,
      isFastLane: cachedSmc?.isFastLane ?? false,
      ruleMode: 'STRICT_PRODUCTION',
    });

    const decisionTrace: SymbolDecisionTrace = {
      symbol: ticker.symbol,
      categoryBeforeGates,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      finalTradeSignal,
      finalCategory: category,
      smcEvaluatedAt,
      smcDataFetchedAt,
      smcDataFreshnessSeconds,
      score: totalScore,
      rawScoreBeforeCap,
      scoreCapApplied,
      scoreCapRule,
      scoreBreakdown,
      gates,
      downgradeReasons,
      gateEvaluation: symbolGateEvaluation,
      nearMissStatus,
      paperEligibilityStatus,
      candidateDetectedAt,
      signalDetectedAt,
      paperOpenedAt,
      entryWindowMissed,
      blockedReason,
      missingGates,
      detectionLatencyMs: candidateDetectionLatencyMs,
      candidateDetectionLatencyMs,
      evaluationLatencyMs,
      nextBarRemainingMs,
      queueWaitMs,
      smcEvaluationLatencyMs,
      queueEnteredAt,
      evaluationStartedAt,
      evaluationCompletedAt,
      nextBarOpenTime,
      entryWindowDelayMs,
    };

    const spreadDisplayValue =
      spreadPercent !== null
        ? `Spread: ${spreadPercent.toFixed(4)}% (Bid ${bidPrice} / Ask ${askPrice})`
        : 'Spread 資料不可用';

    const histVolDisplayValue =
      historicalVolume.status === 'READY'
        ? `[${historicalVolume.volumeTimeframe}] RVOL ${historicalVolume.rvol}x · Z=${historicalVolume.robustZScore} (Median $${formatCompactUsd(
            historicalVolume.rollingMedian ?? 0
          )}, MAD $${formatCompactUsd(historicalVolume.mad ?? 0)}, N=${
            historicalVolume.sampleCount
          })`
        : historicalVolume.status === 'BASELINE_UNSTABLE'
          ? `[${historicalVolume.volumeTimeframe}] 基線不穩定 BASELINE_UNSTABLE (${historicalVolume.sampleCount}/${
              historicalVolume.minRequiredSamples
            } · Median $${formatCompactUsd(
              historicalVolume.rollingMedian ?? 0
            )}, MAD $${formatCompactUsd(
              historicalVolume.mad ?? 0
            )}, MAD/Med ${((historicalVolume.madToMedianRatio ?? 0) * 100).toFixed(
              1
            )}%)`
          : `[${historicalVolume.volumeTimeframe}] 歷史基線累積中 (${historicalVolume.sampleCount}/${historicalVolume.minRequiredSamples})`;

    const evidences: EvidenceItem[] = [
      {
        code: 'HIST_VOL_ANOMALY',
        label: `歷史異常成交量模型 (${historicalVolume.volumeTimeframe} Rolling Median / MAD / Z-Score / RVOL)`,
        passed:
          historicalVolume.status === 'READY' &&
          !historicalVolume.baselineUnstable &&
          !isExtremeZScoreOutlier &&
          historicalVolume.isHistoricalAnomaly,
        value: histVolDisplayValue,
        weight: scoreBreakdown.volumeAnomaly,
        detail:
          historicalVolume.status === 'READY'
            ? isExtremeZScoreOutlier
              ? `Robust Z-Score (${historicalVolume.robustZScore}) 屬極端離群值，禁止直接將極端 Z-Score 當成可交易候選`
              : historicalVolume.isHistoricalAnomaly
                ? `歷史量能異常放大 (${historicalVolume.volumeTimeframe} RVOL=${historicalVolume.rvol}x, Robust Z-Score=${historicalVolume.robustZScore}, window=${historicalVolume.aggregationWindow})`
                : `歷史成交量處於常態分佈區間 (${historicalVolume.volumeTimeframe} Rolling Median=$${formatCompactUsd(
                    historicalVolume.rollingMedian ?? 0
                  )}, MAD=$${formatCompactUsd(historicalVolume.mad ?? 0)})`
            : historicalVolume.status === 'BASELINE_UNSTABLE'
              ? historicalVolume.unstableReason ===
                'EXTREME_ROBUST_ZSCORE_OUTLIER'
                ? `歷史樣本 30/30 且 MAD/Median=${(
                    (historicalVolume.madToMedianRatio ?? 0) * 100
                  ).toFixed(2)}%，但因 ${historicalVolume.volumeTimeframe} currentVolume 對比歷史基線算出極端 Z-Score (${
                    historicalVolume.rawRobustZScore
                  } > ${MAX_SANE_ROBUST_ZSCORE}) 觸發 BASELINE_UNSTABLE`
                : '歷史量能 MAD 過小或接近 0 (BASELINE_UNSTABLE)，拒絕因極小 MAD 產生極端 Z-Score，強制列入準備觀察'
              : `歷史成交量樣本不足 (<${MIN_HISTORY_SAMPLES} 筆，status=INSUFFICIENT_HISTORY)，不計算 RVOL/Z-Score 且不得產生可交易候選（禁止以 24h AUX_VOL_RANK_PROXY 取代 15m 歷史模型）`,
      },
      {
        code: 'AUX_VOL_RANK_PROXY',
        label: '輔助指標：全市場 24h 成交額百分位 (Auxiliary Volume Rank)',
        passed: !isLowLiquidity && auxVolPercentile >= 60,
        value: `PR ${auxVolPercentile.toFixed(1)} ($${formatCompactUsd(ticker.quoteVolume24h)})`,
        weight: scoreBreakdown.auxiliaryVolumeRank,
        detail:
          '僅作為全市場截面流動性廣度輔助指標 (Auxiliary Indicator)，不得冒充歷史成交量異常模型',
      },
      {
        code: 'PRICE_MOMENTUM_24H',
        label: '24h 價格動能 (momentum)',
        passed: absChange >= 3.0 && absChange <= 18.0,
        value: `${ticker.priceChangePercent24h >= 0 ? '+' : ''}${ticker.priceChangePercent24h.toFixed(2)}%`,
        weight: scoreBreakdown.momentum,
        detail:
          absChange > 18.0
            ? '日內漲跌幅過度延伸 (>18%)，動能分數啟動防追高/追空衰減機制'
            : absChange >= 3.0
              ? '具備健康日內趨勢動能擴張'
              : '日內價格波動溫和，動能尚未擴張',
      },
      {
        code: 'REL_BTC_STRENGTH',
        label: '相對 BTC 強弱 (relative BTC strength)',
        passed: relStrengthAligned,
        value:
          btcChange24h !== null
            ? `${relativeBtcStrength >= 0 ? '+' : ''}${relativeBtcStrength.toFixed(2)}% vs BTC`
            : '無 BTC 基準',
        weight: scoreBreakdown.relativeBtcStrength,
        detail:
          relativeBtcStrength >= 1.5
            ? '顯著強於 BTC 大盤基準'
            : relativeBtcStrength <= -1.5
              ? '顯著弱於 BTC 大盤基準'
              : '與 BTC 同步或無顯著超額強弱',
      },
      {
        code: 'FUNDING_RISK',
        label: '資金費率風險 (funding risk)',
        passed: !extremeFunding && ticker.fundingRate !== null,
        value:
          ticker.fundingRate !== null
            ? `${(ticker.fundingRate * 100).toFixed(4)}%`
            : '缺失 (Missing)',
        weight: scoreBreakdown.fundingRisk,
        detail: extremeFunding
          ? '資金費率處於極端區間 (|Funding| >= 0.05%)，直接扣分並列入高風險'
          : ticker.fundingRate !== null
            ? '資金費率處於正常範圍，未見極端擁擠'
            : '缺少資金費率資料，執行扣分',
      },
      {
        code: 'LIQUIDITY_RISK',
        label: '流動性與真實盤口價差 (liquidity risk)',
        passed:
          !isLowLiquidity &&
          !lowLiquidityHighVolatility &&
          spreadPercent !== null,
        value: isLowLiquidity
          ? `低流動性：不列入一般候選 (${spreadDisplayValue})`
          : spreadDisplayValue,
        weight: scoreBreakdown.liquidityRisk,
        detail: isLowLiquidity
          ? `低流動性：不列入一般候選（24h 成交額低於 $${formatCompactUsd(MIN_QUOTE_VOLUME_24H)} 或真實 Bid-Ask Spread > ${maxSpreadPercent}%，僅能輸出高風險、準備觀察或 WAIT）`
          : spreadPercent === null
            ? 'Spread 資料不可用（缺少盤口報價，已記錄 missingData: BID_ASK_SPREAD）'
            : `真實盤口價差 ${spreadPercent.toFixed(4)}% (spread=${spread}) 與 24h 成交額符合主流流動性門檻`,
      },
      {
        code: 'DATA_QUALITY',
        label: '資料品質與時效 (data quality)',
        passed: !hasAnyMissingOrStale,
        value: hasAnyMissingOrStale
          ? `異常 (${tickerProvenance.stale ? '過期' : `缺失: ${tickerProvenance.missingData.join(', ')}`})`
          : '完整即時',
        weight: scoreBreakdown.dataQuality,
        detail: hasAnyMissingOrStale
          ? `缺失或過期欄位: ${tickerProvenance.missingData.join(', ') || '時間戳過期'}，執行扣分`
          : '所有基礎行情與真實 Bid/Ask Spread 欄位齊全且於有效時間窗內',
      },
    ];

    allCandidates.push({
      symbol: ticker.symbol,
      baseAsset: ticker.baseAsset,
      quoteAsset: ticker.quoteAsset,
      lastPrice: ticker.lastPrice,
      priceChangePercent24h: ticker.priceChangePercent24h,
      quoteVolume24h: ticker.quoteVolume24h,
      bidPrice,
      askPrice,
      spread,
      spreadPercent,
      fundingRate: ticker.fundingRate,
      openInterest: ticker.openInterest,
      openInterestValue: ticker.openInterestValue,
      historicalVolume,
      auxiliaryVolumeRankProxyPercentile: auxVolPercentile,
      volumeRankProxyPercentile: auxVolPercentile,
      momentumScore,
      relativeBtcStrength,
      isLowLiquidity,
      extremeFunding,
      lowLiquidityHighVolatility,
      category,
      categoryBeforeGates,
      finalCategory: category,
      finalTradeSignal,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      smcStatusReason,
      smcEvaluatedAt,
      smcDataFetchedAt,
      smcDataFreshnessSeconds,
      score: totalScore,
      rawScoreBeforeCap,
      scoreCapApplied,
      scoreCapRule,
      scoreBreakdown,
      gates,
      downgradeReasons,
      decisionTrace,
      evidences,
      provenance: tickerProvenance,
      gateEvaluation: symbolGateEvaluation,
      nearMissStatus,
      paperEligibilityStatus,
      candidateDetectedAt,
      signalDetectedAt,
      paperOpenedAt,
      entryWindowMissed,
      blockedReason,
      missingGates,
      detectionLatencyMs: candidateDetectionLatencyMs,
      candidateDetectionLatencyMs,
      evaluationLatencyMs,
      nextBarRemainingMs,
      queueWaitMs,
      smcEvaluationLatencyMs,
      queueEnteredAt,
      evaluationStartedAt,
      evaluationCompletedAt,
      nextBarOpenTime,
      entryWindowDelayMs,
      intendedDirection,
    });
  }

  // Sort: non-low-liquidity candidates first by score descending, then quoteVolume24h descending
  allCandidates.sort((a, b) => {
    if (a.isLowLiquidity !== b.isLowLiquidity) {
      return a.isLowLiquidity ? 1 : -1;
    }
    if (b.score !== a.score) return b.score - a.score;
    return b.quoteVolume24h - a.quoteVolume24h;
  });

  const summaryCounts: Record<ScanCategory, number> = {
    多頭候選: 0,
    空頭候選: 0,
    準備觀察: 0,
    高風險: 0,
  };

  const marketRadarCounts: Record<MarketRadarCategory, number> = {
    雷達多頭觀察: 0,
    雷達空頭觀察: 0,
    準備觀察: 0,
    高風險: 0,
  };

  const smcStateCounts: Record<SmcActionState, number> = {
    PENDING: 0,
    WAIT: 0,
    WATCH: 0,
    'LONG CANDIDATE': 0,
    'SHORT CANDIDATE': 0,
    'HIGH RISK': 0,
  };

  // 1A. Reason statistics strictly for EVALUATED WAIT / WATCH symbols (excludes HIGH RISK and PENDING)
  const waitWatchReasonBreakdown: Record<string, number> = {};
  const waitWatchPrimaryReasonCount: Record<string, number> = {};
  let waitWatchUniqueSymbolCount = 0;
  let waitWatchTotalReasonOccurrences = 0;

  // 1B. Reason statistics strictly for EVALUATED HIGH RISK symbols (excludes WAIT, WATCH, and PENDING)
  const highRiskReasonBreakdown: Record<string, number> = {};
  const highRiskPrimaryReasonCount: Record<string, number> = {};
  let highRiskUniqueSymbolCount = 0;
  let highRiskTotalReasonOccurrences = 0;

  // 1C. Combined non-candidate reason statistics for all EVALUATED non-confirmed symbols (WAIT + WATCH + HIGH RISK)
  const nonCandidateReasonBreakdown: Record<string, number> = {};
  const nonCandidatePrimaryReasonCount: Record<string, number> = {};
  let nonCandidateUniqueSymbolCount = 0;
  let nonCandidateTotalReasonOccurrences = 0;

  // First-layer Market Radar gate reason statistics across all scanned symbols
  const radarReasonOccurrenceCount: Record<string, number> = {};
  const radarMutuallyExclusivePrimaryCount: Record<string, number> = {};
  let radarTotalReasonOccurrences = 0;

  let finalCategorySmcMismatchCount = 0;

  for (const c of allCandidates) {
    summaryCounts[c.category] += 1;
    marketRadarCounts[c.marketRadarCategory] += 1;
    smcStateCounts[c.smcActionState] =
      (smcStateCounts[c.smcActionState] ?? 0) + 1;

    if (
      (c.finalCategory === '多頭候選' &&
        c.smcActionState !== 'LONG CANDIDATE') ||
      (c.finalCategory === '空頭候選' &&
        c.smcActionState !== 'SHORT CANDIDATE') ||
      (c.finalTradeSignal === '多頭交易候選' &&
        c.smcActionState !== 'LONG CANDIDATE') ||
      (c.finalTradeSignal === '空頭交易候選' &&
        c.smcActionState !== 'SHORT CANDIDATE') ||
      ((c.smcActionState === 'PENDING' ||
        c.smcActionState === 'WAIT' ||
        c.smcActionState === 'WATCH' ||
        c.smcActionState === 'HIGH RISK') &&
        c.finalTradeSignal !== 'NONE')
    ) {
      finalCategorySmcMismatchCount++;
    }

    // 1. Second-Layer SMC Evaluated Reason Stats (strictly split into WAIT/WATCH vs HIGH RISK, plus combined nonCandidate)
    if (
      c.smcEvaluationStatus === 'EVALUATED' &&
      (c.smcActionState === 'WAIT' ||
        c.smcActionState === 'WATCH' ||
        c.smcActionState === 'HIGH RISK')
    ) {
      const reasons =
        c.gates.smc.waitReasons && c.gates.smc.waitReasons.length > 0
          ? c.gates.smc.waitReasons
          : [c.smcStatusReason];
      const primaryReason = reasons[0];

      nonCandidateUniqueSymbolCount++;
      nonCandidatePrimaryReasonCount[primaryReason] =
        (nonCandidatePrimaryReasonCount[primaryReason] ?? 0) + 1;
      for (const r of reasons) {
        nonCandidateReasonBreakdown[r] =
          (nonCandidateReasonBreakdown[r] ?? 0) + 1;
        nonCandidateTotalReasonOccurrences++;
      }

      if (c.smcActionState === 'WAIT' || c.smcActionState === 'WATCH') {
        waitWatchUniqueSymbolCount++;
        waitWatchPrimaryReasonCount[primaryReason] =
          (waitWatchPrimaryReasonCount[primaryReason] ?? 0) + 1;
        for (const r of reasons) {
          waitWatchReasonBreakdown[r] = (waitWatchReasonBreakdown[r] ?? 0) + 1;
          waitWatchTotalReasonOccurrences++;
        }
      } else if (c.smcActionState === 'HIGH RISK') {
        highRiskUniqueSymbolCount++;
        highRiskPrimaryReasonCount[primaryReason] =
          (highRiskPrimaryReasonCount[primaryReason] ?? 0) + 1;
        for (const r of reasons) {
          highRiskReasonBreakdown[r] = (highRiskReasonBreakdown[r] ?? 0) + 1;
          highRiskTotalReasonOccurrences++;
        }
      }
    }

    // 2. First-Layer Market Radar mutually exclusive primary reason & overlapping occurrences
    let primaryRadarBucket = '';
    if (c.marketRadarCategory === '高風險') {
      primaryRadarBucket = '第一層：高風險（極端資金費率或低流動性高波動）';
    } else if (c.isLowLiquidity) {
      primaryRadarBucket =
        '第一層：低流動性保護（24h 成交額 < $15M 或 Spread > 0.15%）';
    } else if (!c.gates.momentum.passed) {
      primaryRadarBucket = '第一層：24h 價格動能未達 ±3.0% 門檻';
    } else if (!c.gates.relativeBtc.passed) {
      primaryRadarBucket = '第一層：相對 BTC 強弱未達 ±1.2% 同向門檻';
    } else if (!c.gates.history.passed) {
      primaryRadarBucket =
        c.historicalVolume.status === 'BASELINE_UNSTABLE'
          ? '第一層：15m 歷史量能基線不穩定 (BASELINE_UNSTABLE)'
          : '第一層：15m 已確認 K 線歷史量能基線累積中 (<30 根)';
    } else {
      primaryRadarBucket = `第一層：通過雷達多空觀察門檻（${c.marketRadarCategory}）`;
    }
    radarMutuallyExclusivePrimaryCount[primaryRadarBucket] =
      (radarMutuallyExclusivePrimaryCount[primaryRadarBucket] ?? 0) + 1;

    // Overlapping occurrences for radar gate rejections
    if (!c.gates.liquidity.passed) {
      const k = 'LIQUIDITY_OR_SPREAD_GATE_REJECTED (24h 成交額 < $15M 或 Spread > 0.15%)';
      radarReasonOccurrenceCount[k] = (radarReasonOccurrenceCount[k] ?? 0) + 1;
      radarTotalReasonOccurrences++;
    }
    if (!c.gates.funding.passed) {
      const k = 'FUNDING_GATE_REJECTED (資金費率極端或缺失)';
      radarReasonOccurrenceCount[k] = (radarReasonOccurrenceCount[k] ?? 1 - 1) + 1;
      radarTotalReasonOccurrences++;
    }
    if (!c.gates.momentum.passed) {
      const k = 'MOMENTUM_GATE_REJECTED (24h 漲跌幅未達 ±3.0%)';
      radarReasonOccurrenceCount[k] = (radarReasonOccurrenceCount[k] ?? 0) + 1;
      radarTotalReasonOccurrences++;
    }
    if (!c.gates.relativeBtc.passed) {
      const k = 'RELATIVE_BTC_GATE_REJECTED (相對 BTC 強弱未達 ±1.2%)';
      radarReasonOccurrenceCount[k] = (radarReasonOccurrenceCount[k] ?? 0) + 1;
      radarTotalReasonOccurrences++;
    }
    if (!c.gates.history.passed) {
      const k =
        c.historicalVolume.status === 'BASELINE_UNSTABLE'
          ? 'HISTORY_GATE_BASELINE_UNSTABLE (15m 量能基線不穩定)'
          : 'HISTORY_GATE_INSUFFICIENT_SAMPLES (15m 量能基線未滿 30 根)';
      radarReasonOccurrenceCount[k] = (radarReasonOccurrenceCount[k] ?? 0) + 1;
      radarTotalReasonOccurrences++;
    }
  }

  const waitWatchReasonStats: WaitWatchReasonStatistics = {
    scope: 'EVALUATED_WAIT_WATCH_ONLY',
    uniqueSymbolCount: waitWatchUniqueSymbolCount,
    totalReasonOccurrences: waitWatchTotalReasonOccurrences,
    reasonOccurrenceCount: waitWatchReasonBreakdown,
    mutuallyExclusivePrimaryReasonCount: waitWatchPrimaryReasonCount,
  };

  const highRiskReasonStats: WaitWatchReasonStatistics = {
    scope: 'EVALUATED_HIGH_RISK_ONLY',
    uniqueSymbolCount: highRiskUniqueSymbolCount,
    totalReasonOccurrences: highRiskTotalReasonOccurrences,
    reasonOccurrenceCount: highRiskReasonBreakdown,
    mutuallyExclusivePrimaryReasonCount: highRiskPrimaryReasonCount,
  };

  const nonCandidateReasonStats: WaitWatchReasonStatistics = {
    scope: 'EVALUATED_NON_CANDIDATE_ALL',
    uniqueSymbolCount: nonCandidateUniqueSymbolCount,
    totalReasonOccurrences: nonCandidateTotalReasonOccurrences,
    reasonOccurrenceCount: nonCandidateReasonBreakdown,
    mutuallyExclusivePrimaryReasonCount: nonCandidatePrimaryReasonCount,
  };

  const radarGateReasonStats: RadarGateReasonStatistics = {
    uniqueSymbolCount: allCandidates.length,
    totalReasonOccurrences: radarTotalReasonOccurrences,
    reasonOccurrenceCount: radarReasonOccurrenceCount,
    mutuallyExclusivePrimaryReasonCount: radarMutuallyExclusivePrimaryCount,
  };

  const finalProvenance: DataProvenance =
    scanMode === 'live' && isVerifiedLivePublicApiSource(rootProvenance.source)
      ? safeRootProvenance
      : scanMode === 'live'
        ? {
            source: rootProvenance.source,
            fetchedAt: rootProvenance.fetchedAt,
            stale: rootProvenance.stale,
            fallback: false,
            missingData: [
              ...new Set([
                ...rootProvenance.missingData,
                'NON_LIVE_FIXTURE_QUARANTINED',
              ]),
            ],
            isDemo: true,
            isTestFixture: true,
            volumeTimeframe: historicalVolumeTimeframe,
            aggregationWindow,
            volumeMetric: 'quoteVolume',
          }
        : safeRootProvenance;

  const totalContractsScanned = eligibleTickers.length;

  const marketStats: FullMarketGateStatistics = {
    totalContractsScanned,
    insufficientHistoryCount,
    baselineUnstableCount,
    liquidityRejectedCount,
    momentumPassedCount,
    relativeBtcPassedCount,
    marketRadarLongCount,
    marketRadarShortCount,
    smcPendingCount,
    smcWaitCount,
    smcWatchCount,
    smcLongCandidateCount,
    smcShortCandidateCount,
    smcHighRiskCount,
    smcGateNotConfirmedCount,
    finalCategorySmcMismatchCount,
  };

  const dataQuality: DataQualityReport = {
    ...marketStats,
    totalSymbolsScanned: totalContractsScanned,
    validSymbolsCount: allCandidates.filter(
      (c) => !c.provenance.stale && c.provenance.missingData.length === 0
    ).length,
    missingFundingCount,
    missingSpreadCount,
    staleRecordCount,
    lowLiquidityCount,
    extremeFundingCount,
    historicalVolumeReadyCount,
    scannerConfig: DEFAULT_SCANNER_CONFIG,
    volumeProxyNotice:
      'Phase 2 已啟用歷史異常成交量模型（Rolling Median、MAD、Robust Z-Score、RVOL，最低樣本 MIN_HISTORY_SAMPLES=30）；全市場 24h 成交額百分位 (PR) 已降級為輔助流動性廣度指標，絕不冒充歷史異常成交量。',
    generatedAt: new Date().toISOString(),
    source: finalProvenance.source,
    isDemo: finalProvenance.isDemo,
  };

  const smcGateDiagnostics = buildSmcGateDiagnosticsSummary(evaluatedGateItems, {
    totalUniverseSymbols: totalContractsScanned,
  });

  return {
    safety: TRADING_SAFETY_FLAGS,
    mode: scanMode,
    exchange,
    isDemo: finalProvenance.isDemo,
    fallback: finalProvenance.fallback,
    source: finalProvenance.source,
    fetchedAt: finalProvenance.fetchedAt,
    stale: finalProvenance.stale,
    missingData: finalProvenance.missingData,
    ruleVersion: MARKET_SCAN_RULE_VERSION,
    btcBenchmarkChange24h: btcChange24h,
    candidates: allCandidates,
    summaryCounts,
    marketRadarCounts,
    smcStateCounts,
    waitWatchReasonBreakdown,
    waitWatchReasonStats,
    highRiskReasonStats,
    nonCandidateReasonStats,
    radarGateReasonStats,
    marketStats,
    ...marketStats,
    dataQuality,
    provenance: finalProvenance,
    smcGateDiagnostics,
    scopedGateStatistics: smcGateDiagnostics.scopedGateStatistics,
    observationShadowComparison: smcGateDiagnostics.observationShadowComparison,
    symbolFunnelDiagnostics,
    nearMissCount: smcGateDiagnostics.nearMissCount,
    nearMissMissing1Count: smcGateDiagnostics.nearMissMissing1Count,
    nearMissMissing2Count: smcGateDiagnostics.nearMissMissing2Count,
    nearMissMissingGates: smcGateDiagnostics.nearMissMissingGates,
    lastBlockingGate: smcGateDiagnostics.lastBlockingGate,
    blockedAfterSmcCandidateCount,
    blockedAfterSmcCandidateReasons,
  };
}

function formatCompactUsd(val: number): string {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toFixed(0);
}
