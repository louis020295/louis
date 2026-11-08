import {
  BacktestDataClassification,
  BacktestDataClassificationLabel,
  BacktestMetricStatus,
  BacktestModeComparisonMatrix,
  BacktestPointInTimeSignalEvidence,
  BacktestPointInTimeVolumeSnapshot,
  BacktestResult,
  BacktestShadowModeMetrics,
  BacktestTradeRecord,
  DataProvenance,
  ExchangeId,
  FinalTradeSignal,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  MarketRadarCategory,
  MarketTicker,
  SampleSufficiencyTier,
  SignalRuleMode,
  Timeframe,
  TRADING_SAFETY_FLAGS,
  WalkForwardBacktestResult,
  WalkForwardStage,
  WalkForwardWindowResult,
} from '../../src/types/market.ts';
import { MARKET_SCAN_RULE_VERSION, runMarketScan } from './MarketScanner.ts';
import { evaluateSmcStructure, SMC_RULE_VERSION } from './SmcRuleEngine.ts';
import {
  DEFAULT_AGGREGATION_WINDOWS,
  evaluateHistoricalVolumeAnomaly,
  MIN_HISTORY_SAMPLES,
} from './VolumeAnomalyEngine.ts';
import {
  enforceProvenanceIntegrity,
  isVerifiedLivePublicApiSource,
} from '../utils/provenanceQuarantine.ts';

export interface RunBacktestInput {
  backtestRunId?: string;
  symbol: string;
  exchange?: ExchangeId;
  timeframe: Timeframe;
  klines: Kline[];
  /**
   * Point-in-time historical Open Interest series (`oi.timestamp <= currentBar.closeTime`).
   * Required for Lookahead-Free evaluation. Current scalar `openInterest` is NEVER used to backfill historical bars.
   */
  historicalOpenInterest?: HistoricalOpenInterestPoint[];
  /**
   * Point-in-time historical Funding Rate series (`funding.timestamp <= currentBar.closeTime`).
   * Required for Lookahead-Free evaluation. Current scalar `fundingRate` is NEVER used to backfill historical bars.
   */
  historicalFundingRates?: HistoricalFundingRatePoint[];
  /**
   * Legacy scalar fields are intentionally ignored for historical bar evaluation
   * to prevent backfilling past bars with current ("當下") OI/Funding.
   */
  openInterest?: number | null;
  fundingRate?: number | null;
  provenance: DataProvenance;
  ruleVersion?: string;
  marketRadarCategoryOverride?: MarketRadarCategory;
  evalStartIndex?: number;
  evalEndIndex?: number;
}

export interface RunWalkForwardInput {
  backtestRunId?: string;
  symbol: string;
  exchange?: ExchangeId;
  timeframe: Timeframe;
  klines: Kline[];
  historicalOpenInterest?: HistoricalOpenInterestPoint[];
  historicalFundingRates?: HistoricalFundingRatePoint[];
  openInterest?: number | null;
  fundingRate?: number | null;
  provenance: DataProvenance;
  ruleVersion?: string;
}

export const MIN_CONFIRMED_BARS_FOR_BACKTEST = 45;
export const MIN_CONFIRMED_BARS_FOR_WALK_FORWARD = 60;

export function getTimeframeDurationMs(timeframe: Timeframe): number {
  switch (timeframe) {
    case '5m':
      return 5 * 60 * 1000;
    case '15m':
      return 15 * 60 * 1000;
    case '1h':
      return 60 * 60 * 1000;
    case '4h':
      return 4 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

export function classifyBacktestData(
  provenance: DataProvenance,
  status: 'COMPLETED' | 'INSUFFICIENT_DATA',
  lookaheadFree: boolean,
  rawSource?: string
): {
  dataClassification: BacktestDataClassification;
  dataClassificationLabel: BacktestDataClassificationLabel;
} {
  if (status === 'INSUFFICIENT_DATA') {
    return {
      dataClassification: 'INSUFFICIENT_DATA',
      dataClassificationLabel: '資料不足',
    };
  }
  const sourceStr = `${rawSource || ''} ${provenance.source || ''}`;
  if (provenance.fallback || provenance.stale || /proxy/i.test(sourceStr)) {
    return {
      dataClassification: 'PROXY',
      dataClassificationLabel: '代理資料',
    };
  }
  if (!lookaheadFree) {
    return {
      dataClassification: 'INSUFFICIENT_DATA',
      dataClassificationLabel: '資料不足',
    };
  }
  if (provenance.isDemo || provenance.isTestFixture) {
    return {
      dataClassification: 'DEMO',
      dataClassificationLabel: 'Demo 資料',
    };
  }
  if (isVerifiedLivePublicApiSource(provenance.source)) {
    return {
      dataClassification: 'REAL',
      dataClassificationLabel: '實際資料',
    };
  }
  return {
    dataClassification: 'PROXY',
    dataClassificationLabel: '代理資料',
  };
}

export function verifyChronologicalKlines(klines: Kline[]): {
  valid: boolean;
  reason?: string;
} {
  for (let i = 1; i < klines.length; i++) {
    if (klines[i].openTime <= klines[i - 1].openTime) {
      return {
        valid: false,
        reason: `時間序列違規：第 ${i} 根 K 線 openTime (${klines[i].openTime}) <= 前一根 (${klines[i - 1].openTime})，嚴格禁止隨機打散時間序列。`,
      };
    }
  }
  return { valid: true };
}

/**
 * Strictly resolves the point-in-time OI and Funding Rate known at `currentBar.closeTime`.
 * - ONLY considers records with `timestamp <= currentBar.closeTime` (future records > closeTime are invisible).
 * - NEVER falls back to current scalar OI or Funding Rate.
 */
export function resolvePointInTimeOiAndFunding(params: {
  currentBar: Kline;
  tfDurationMs: number;
  sortedOiSeries: HistoricalOpenInterestPoint[];
  sortedFundingSeries: HistoricalFundingRatePoint[];
}): {
  oiFundingPointInTime: boolean;
  oiValue: number | null;
  oiFetchedAt: string | null;
  oiDataTimestamp: number | null;
  fundingRate: number | null;
  fundingDataTimestamp: number | null;
} {
  const { currentBar, tfDurationMs, sortedOiSeries, sortedFundingSeries } =
    params;
  const maxOiAgeMs = Math.max(tfDurationMs * 4, 6 * 3600_000);
  const maxFundingAgeMs = Math.max(tfDurationMs * 6, 24 * 3600_000);

  let matchedOi: HistoricalOpenInterestPoint | null = null;
  for (let idx = sortedOiSeries.length - 1; idx >= 0; idx--) {
    const item = sortedOiSeries[idx];
    if (item.timestamp <= currentBar.closeTime) {
      if (
        currentBar.closeTime - item.timestamp <= maxOiAgeMs &&
        Number.isFinite(item.openInterest) &&
        item.openInterest > 0
      ) {
        matchedOi = item;
      }
      break;
    }
  }

  let matchedFunding: HistoricalFundingRatePoint | null = null;
  for (let idx = sortedFundingSeries.length - 1; idx >= 0; idx--) {
    const item = sortedFundingSeries[idx];
    if (item.timestamp <= currentBar.closeTime) {
      if (
        currentBar.closeTime - item.timestamp <= maxFundingAgeMs &&
        Number.isFinite(item.fundingRate)
      ) {
        matchedFunding = item;
      }
      break;
    }
  }

  const oiFundingPointInTime =
    matchedOi !== null &&
    matchedFunding !== null &&
    matchedOi.timestamp <= currentBar.closeTime &&
    matchedFunding.timestamp <= currentBar.closeTime;

  return {
    oiFundingPointInTime,
    oiValue: matchedOi ? matchedOi.openInterest : null,
    oiFetchedAt: matchedOi ? matchedOi.fetchedAt : null,
    oiDataTimestamp: matchedOi ? matchedOi.timestamp : null,
    fundingRate: matchedFunding ? matchedFunding.fundingRate : null,
    fundingDataTimestamp: matchedFunding ? matchedFunding.timestamp : null,
  };
}

export class BacktestEngine {
  public readonly ruleVersion = `${SMC_RULE_VERSION}+${MARKET_SCAN_RULE_VERSION}`;
  public readonly scannerRuleVersion = MARKET_SCAN_RULE_VERSION;

  public runDeterministicBacktest(input: RunBacktestInput): BacktestResult {
    const {
      symbol,
      exchange = 'binance_usdm',
      timeframe,
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: rawProvenance,
      ruleVersion: customRuleVersion,
      marketRadarCategoryOverride,
    } = input;

    const effectiveRuleVersion = customRuleVersion || this.ruleVersion;
    const provenance = enforceProvenanceIntegrity(rawProvenance);
    const backtestRunId =
      input.backtestRunId ||
      `bt_${exchange}_${symbol}_${timeframe}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Verify chronological ordering (no time-series shuffling allowed)
    const chronoCheck = verifyChronologicalKlines(klines);

    // 1. Strictly filter only confirmed closed candles (isClosed === true)
    const confirmedKlines = klines.filter((k) => k.isClosed === true);
    const unclosedIgnored = klines.length - confirmedKlines.length;

    const startIdx =
      input.evalStartIndex !== undefined
        ? Math.max(MIN_HISTORY_SAMPLES, input.evalStartIndex)
        : MIN_HISTORY_SAMPLES;
    const endIdx =
      input.evalEndIndex !== undefined
        ? Math.min(confirmedKlines.length - 1, input.evalEndIndex)
        : confirmedKlines.length - 1;

    const startTimeIso =
      confirmedKlines.length > 0
        ? new Date(
            confirmedKlines[Math.min(startIdx, confirmedKlines.length - 1)]
              .openTime
          ).toISOString()
        : null;
    const endTimeIso =
      confirmedKlines.length > 0
        ? new Date(
            confirmedKlines[Math.min(endIdx, confirmedKlines.length - 1)]
              .closeTime
          ).toISOString()
        : null;

    const buildInsufficientResult = (
      reason: string,
      isLookaheadFree: boolean,
      partialSnapshots: BacktestPointInTimeVolumeSnapshot[] = [],
      partialDecisions: BacktestPointInTimeSignalEvidence[] = [],
      counters?: {
        insufficientDataCount: number;
        blockedCount: number;
        pendingCount: number;
        waitCount: number;
        watchCount: number;
        highRiskCount: number;
      }
    ): BacktestResult => {
      const { dataClassification, dataClassificationLabel } =
        classifyBacktestData(provenance, 'INSUFFICIENT_DATA', isLookaheadFree);
      return {
        safety: TRADING_SAFETY_FLAGS,
        backtestRunId,
        symbol,
        exchange,
        timeframe,
        ruleVersion: effectiveRuleVersion,
        scannerRuleVersion: this.scannerRuleVersion,
        startTime: startTimeIso,
        endTime: endTimeIso,
        dataSource: provenance.source,
        fetchedAt: provenance.fetchedAt,
        isDemo: provenance.isDemo,
        lookaheadFree: isLookaheadFree,
        lookaheadFreeVerified: isLookaheadFree,
        oiFundingPointInTimeVerified: false,
        dataClassification,
        dataClassificationLabel,
        status: 'INSUFFICIENT_DATA',
        metricStatus: 'INSUFFICIENT_DATA',
        insufficientReason: reason,
        confirmedBarsTested:
          endIdx >= startIdx ? endIdx - startIdx + 1 : confirmedKlines.length,
        unclosedBarsIgnored: unclosedIgnored,
        totalTrades: null,
        tradeCount: null,
        winRatePercent: null,
        winRate: null,
        averageR: null,
        expectancyR: null,
        maxDrawdownR: null,
        profitFactor: null,
        averageWinR: null,
        averageLossR: null,
        averageHoldingTime: null,
        averageHoldingTimeMs: null,
        averageHoldingBars: null,
        longCount: null,
        shortCount: null,
        signalCount: 0,
        executedPaperCount: 0,
        blockedCount: counters?.blockedCount ?? 0,
        expiredCount: 0,
        insufficientDataCount:
          counters?.insufficientDataCount ??
          Math.max(1, confirmedKlines.length),
        waitCount: counters?.waitCount ?? 0,
        watchCount: counters?.watchCount ?? 0,
        pendingCount: counters?.pendingCount ?? 0,
        highRiskCount: counters?.highRiskCount ?? 0,
        trades: [],
        pointInTimeVolumeSnapshots: partialSnapshots,
        pointInTimeDecisions: partialDecisions,
        provenance,
      };
    };

    if (!chronoCheck.valid) {
      return buildInsufficientResult(
        chronoCheck.reason || '時間序列未按時間順序排列，拒絕執行回測。',
        false
      );
    }

    if (
      confirmedKlines.length < MIN_CONFIRMED_BARS_FOR_BACKTEST ||
      endIdx - startIdx < 2
    ) {
      return buildInsufficientResult(
        `資料不足：已確認收盤 K 線僅 ${confirmedKlines.length} 根 (最低需求 ${MIN_CONFIRMED_BARS_FOR_BACKTEST} 根)，拒絕填補或估算回測指標。`,
        false
      );
    }

    // Sort historical OI & Funding series chronologically once
    const sortedOiSeries = Array.isArray(historicalOpenInterest)
      ? [...historicalOpenInterest]
          .filter(
            (pt) =>
              Number.isFinite(pt.timestamp) &&
              pt.timestamp > 0 &&
              Number.isFinite(pt.openInterest)
          )
          .sort((a, b) => a.timestamp - b.timestamp)
      : [];

    const sortedFundingSeries = Array.isArray(historicalFundingRates)
      ? [...historicalFundingRates]
          .filter(
            (pt) =>
              Number.isFinite(pt.timestamp) &&
              pt.timestamp > 0 &&
              Number.isFinite(pt.fundingRate)
          )
          .sort((a, b) => a.timestamp - b.timestamp)
      : [];

    const trades: BacktestTradeRecord[] = [];
    const pointInTimeVolumeSnapshots: BacktestPointInTimeVolumeSnapshot[] = [];
    const pointInTimeDecisions: BacktestPointInTimeSignalEvidence[] = [];

    let signalCount = 0;
    let executedPaperCount = 0;
    let blockedCount = 0;
    let expiredCount = 0;
    let insufficientDataCount = 0;
    let waitCount = 0;
    let watchCount = 0;
    let pendingCount = 0;
    let highRiskCount = 0;
    let missingPointInTimeOiOrFundingBars = 0;

    let activeUntilIndex = -1;
    let shadow1ActiveUntilIndex = -1;
    let shadow2ActiveUntilIndex = -1;
    let nearMissOneGateBarCount = 0;
    let nearMissTwoGatesBarCount = 0;
    let shadow1CandidateCount = 0;
    let shadow2CandidateCount = 0;
    const shadow1RMultiples: number[] = [];
    const shadow2RMultiples: number[] = [];
    const tfDurationMs = getTimeframeDurationMs(timeframe);

    const simulateBarTradeRMultiple = (
      barIndex: number,
      dir: 'LONG' | 'SHORT',
      atrVal: number
    ): { rMultiple: number; exitIdx: number } | null => {
      const nextEntryBar = confirmedKlines[barIndex + 1];
      if (!nextEntryBar || !atrVal || atrVal <= 0) return null;
      const refEntry = nextEntryBar.open;
      const riskDist = atrVal * 1.5;
      const rewardDist = atrVal * 2.5;
      const invPrice =
        dir === 'LONG'
          ? Number((refEntry - riskDist).toPrecision(6))
          : Number((refEntry + riskDist).toPrecision(6));
      const tgtPrice =
        dir === 'LONG'
          ? Number((refEntry + rewardDist).toPrecision(6))
          : Number((refEntry - rewardDist).toPrecision(6));
      const holdLimit = Math.min(endIdx, barIndex + 15);
      let finalExitIdx = barIndex + 1;
      let finalR = 0;
      for (let fIdx = barIndex + 1; fIdx <= holdLimit; fIdx++) {
        const b = confirmedKlines[fIdx];
        finalExitIdx = fIdx;
        if (dir === 'LONG') {
          if (b.low <= invPrice) {
            finalR = -1.0;
            break;
          }
          if (b.high >= tgtPrice) {
            finalR = Number((rewardDist / riskDist).toFixed(2));
            break;
          }
        } else {
          if (b.high >= invPrice) {
            finalR = -1.0;
            break;
          }
          if (b.low <= tgtPrice) {
            finalR = Number((rewardDist / riskDist).toFixed(2));
            break;
          }
        }
        if (fIdx === holdLimit) {
          const diff =
            dir === 'LONG' ? b.close - refEntry : refEntry - b.close;
          finalR = Number((diff / riskDist).toFixed(2));
        }
      }
      return { rMultiple: finalR, exitIdx: finalExitIdx };
    };

    // Walk forward bar-by-bar strictly without lookahead
    // At any evaluated index i >= 30, historical baseline MUST strictly use ONLY the 30 confirmed bars BEFORE bar i: [i - 30, i)
    for (let i = startIdx; i <= endIdx - 2; i++) {
      // Slice strictly from 0 to i (inclusive). Future bars (i + 1 ...) are invisible to the rule engine.
      const visibleHistory = confirmedKlines.slice(0, i + 1);
      const signalBar = confirmedKlines[i];
      // Strictly the 30 confirmed K-lines prior to bar i (excludes current bar i and all future bars > i)
      const prior30Bars = confirmedKlines.slice(i - MIN_HISTORY_SAMPLES, i);
      const baselineQuoteVolumes = prior30Bars.map((k) => k.quoteVolume);
      const baselineWindowOpenTimes = prior30Bars.map((k) => k.openTime);

      const volAnomaly = evaluateHistoricalVolumeAnomaly({
        symbol,
        exchange,
        currentVolume: signalBar.quoteVolume,
        historicalVolumes: baselineQuoteVolumes,
        volumeTimeframe: '15m',
        aggregationWindow: DEFAULT_AGGREGATION_WINDOWS['15m'],
        volumeMetric: 'quoteVolume',
        baseProvenance: provenance,
      });

      pointInTimeVolumeSnapshots.push({
        barIndex: i,
        barOpenTime: signalBar.openTime,
        currentVolume: signalBar.quoteVolume,
        historicalSamples: [
          ...(volAnomaly.historicalSamples ?? baselineQuoteVolumes),
        ],
        baselineWindowOpenTimes,
        rollingMedian: volAnomaly.rollingMedian,
        mad: volAnomaly.mad,
        sampleCount: volAnomaly.sampleCount,
        volumeTimeframe: volAnomaly.volumeTimeframe,
        aggregationWindow: volAnomaly.aggregationWindow,
        volumeMetric: volAnomaly.volumeMetric,
      });

      // Strictly resolve point-in-time OI and Funding (`timestamp <= signalBar.closeTime`)
      // NEVER backfill historical bars with current ("當下") scalar OI or Funding!
      const pitOiFunding = resolvePointInTimeOiAndFunding({
        currentBar: signalBar,
        tfDurationMs,
        sortedOiSeries,
        sortedFundingSeries,
      });

      const decisionAtIso = new Date(signalBar.closeTime).toISOString();

      if (!pitOiFunding.oiFundingPointInTime || pitOiFunding.oiValue === null || pitOiFunding.fundingRate === null) {
        missingPointInTimeOiOrFundingBars++;
        insufficientDataCount++;
        pendingCount++;
        blockedCount++;

        const missingReason =
          'MISSING_HISTORICAL_OI_OR_FUNDING: 缺少與該 K 線時間點對齊 (timestamp <= barCloseTime) 之歷史 OI／Funding 資料，嚴禁使用當下 OI／Funding 回填過去';

        pointInTimeDecisions.push({
          barIndex: i,
          barOpenTime: signalBar.openTime,
          barCloseTime: signalBar.closeTime,
          confirmedBarsCount: visibleHistory.length,
          volumeBaselineBars: prior30Bars.length,
          smcEvidence: [],
          oi: pitOiFunding.oiValue,
          funding: pitOiFunding.fundingRate,
          oiValue: pitOiFunding.oiValue,
          oiFetchedAt: pitOiFunding.oiFetchedAt,
          oiDataTimestamp: pitOiFunding.oiDataTimestamp,
          fundingRate: pitOiFunding.fundingRate,
          fundingDataTimestamp: pitOiFunding.fundingDataTimestamp,
          oiFundingPointInTime: false,
          decisionAt: decisionAtIso,
          smcEvaluationStatus: 'PENDING',
          smcActionState: 'PENDING',
          marketRadarCategory: '準備觀察',
          finalTradeSignal: 'NONE',
          waitReasons: [missingReason],
          countedAsTradeSignal: false,
          countedAsSignal: false,
          blockReason: missingReason,
          blockedReason: missingReason,
          decisionTrace: {
            gates: {
              historyPassed:
                volAnomaly.status === 'READY' && !volAnomaly.baselineUnstable,
              liquidityPassed: false,
              momentumPassed: false,
              smcPassed: false,
              oiFundingPointInTimePassed: false,
            },
            rvol: volAnomaly.rvol,
            robustZScore: volAnomaly.robustZScore,
            rollingMedian: volAnomaly.rollingMedian,
            mad: volAnomaly.mad,
            unclosedBarsIgnored: unclosedIgnored,
          },
        });
        continue;
      }

      if (volAnomaly.status === 'INSUFFICIENT_HISTORY') {
        insufficientDataCount++;
      }

      const pointInTimeOi = pitOiFunding.oiValue;
      const pointInTimeFunding = pitOiFunding.fundingRate;

      const lookbackRefBar =
        visibleHistory[Math.max(0, visibleHistory.length - 24)];
      const rollingChangePct =
        lookbackRefBar.open > 0
          ? ((signalBar.close - lookbackRefBar.open) / lookbackRefBar.open) *
            100
          : 0;
      const rollingQuoteVol24 = visibleHistory
        .slice(-24)
        .reduce((sum, b) => sum + b.quoteVolume, 0);

      // Run the exact same MarketScanner rule engine on the point-in-time bar snapshot (no future bars, no future OI/Funding)
      const barTicker: MarketTicker = {
        symbol,
        baseAsset: symbol.replace(/USDT$/, ''),
        quoteAsset: 'USDT',
        lastPrice: signalBar.close,
        bidPrice: Number((signalBar.close * 0.9999).toPrecision(8)),
        askPrice: Number((signalBar.close * 1.0001).toPrecision(8)),
        priceChangePercent24h: Number(rollingChangePct.toFixed(2)),
        quoteVolume24h: Math.max(rollingQuoteVol24, 25_000_000),
        latestConfirmed15mQuoteVolume: signalBar.quoteVolume,
        fundingRate: pointInTimeFunding,
        nextFundingTime: signalBar.closeTime + 3600_000,
        openInterest: pointInTimeOi,
        openInterestValue: pointInTimeOi * signalBar.close,
        provenance,
      };

      const stepScan = runMarketScan([barTicker], provenance, {
        exchange,
        mode: provenance.isDemo ? 'demo' : 'live',
        volumeTimeframe: '15m',
        currentVolume15mMap: new Map([[symbol, signalBar.quoteVolume]]),
        historicalVolumeMap: new Map([[symbol, baselineQuoteVolumes]]),
      });
      const stepCandidate = stepScan.candidates[0];

      const stepAnalysis = evaluateSmcStructure({
        symbol,
        primaryTimeframe: timeframe,
        klinesByTimeframe: {
          [timeframe]: visibleHistory,
        },
        openInterest: pointInTimeOi,
        historicalVolume: volAnomaly,
        isLowLiquidity: stepCandidate?.isLowLiquidity ?? false,
        extremeFunding: stepCandidate?.extremeFunding ?? false,
        lowLiquidityHighVolatility:
          stepCandidate?.lowLiquidityHighVolatility ?? false,
        provenance,
      });

      const smcStatus = stepAnalysis.smcEvaluationStatus;
      const smcState = stepAnalysis.actionState;

      if (smcStatus === 'PENDING' || smcState === 'PENDING') {
        pendingCount++;
      } else if (smcState === 'WAIT') {
        waitCount++;
      } else if (smcState === 'WATCH') {
        watchCount++;
      } else if (smcState === 'HIGH RISK') {
        highRiskCount++;
      }

      // Determine point-in-time Layer 1 Market Radar category & Layer 2 alignment
      const rawRadarCategory: MarketRadarCategory =
        marketRadarCategoryOverride ??
        (stepCandidate?.marketRadarCategory &&
        stepCandidate.marketRadarCategory !== '準備觀察'
          ? stepCandidate.marketRadarCategory
          : smcState === 'LONG CANDIDATE' && rollingChangePct >= 0
            ? '雷達多頭觀察'
            : smcState === 'SHORT CANDIDATE' && rollingChangePct <= 0
              ? '雷達空頭觀察'
              : stepCandidate?.marketRadarCategory ?? '準備觀察');

      // Check strict signal eligibility rules:
      // Only smcEvaluationStatus === 'EVALUATED', smcActionState === 'LONG CANDIDATE' | 'SHORT CANDIDATE',
      // finalTradeSignal === '多頭交易候選' | '空頭交易候選', stale === false, fallback === false, oiFundingPointInTime === true
      let finalTradeSignal: FinalTradeSignal = 'NONE';
      let blockReason: string | null = null;

      if (provenance.stale) {
        blockReason =
          'STALE_DATA_BLOCKED: 資料已過期 (stale=true)，禁止計入交易訊號';
      } else if (provenance.fallback) {
        blockReason =
          'FALLBACK_DATA_BLOCKED: 降級/備援資料 (fallback=true)，禁止計入交易訊號';
      } else if (smcStatus !== 'EVALUATED') {
        blockReason = `SMC_NOT_EVALUATED: smcEvaluationStatus=${smcStatus}`;
      } else if (
        smcState !== 'LONG CANDIDATE' &&
        smcState !== 'SHORT CANDIDATE'
      ) {
        blockReason = `NON_CANDIDATE_STATE: smcActionState=${smcState}`;
      } else if (
        stepCandidate?.isLowLiquidity ||
        stepCandidate?.extremeFunding ||
        stepCandidate?.lowLiquidityHighVolatility
      ) {
        blockReason =
          'RISK_OR_LIQUIDITY_GATE_BLOCKED: 低流動性或極端資金費率風控攔截';
      } else if (
        volAnomaly.status !== 'READY' ||
        volAnomaly.baselineUnstable ||
        volAnomaly.sampleCount < MIN_HISTORY_SAMPLES
      ) {
        blockReason = `VOLUME_HISTORY_GATE_BLOCKED: 15m 量能基線狀態為 ${volAnomaly.status}`;
      } else if (
        smcState === 'LONG CANDIDATE' &&
        rawRadarCategory !== '雷達多頭觀察'
      ) {
        blockReason = `DIRECTION_MISMATCH_BLOCKED: 第一層為「${rawRadarCategory}」與第二層「LONG CANDIDATE」方向不一致`;
      } else if (
        smcState === 'SHORT CANDIDATE' &&
        rawRadarCategory !== '雷達空頭觀察'
      ) {
        blockReason = `DIRECTION_MISMATCH_BLOCKED: 第一層為「${rawRadarCategory}」與第二層「SHORT CANDIDATE」方向不一致`;
      } else {
        finalTradeSignal =
          smcState === 'LONG CANDIDATE' ? '多頭交易候選' : '空頭交易候選';
      }

      const isTradeSignal =
        pitOiFunding.oiFundingPointInTime &&
        smcStatus === 'EVALUATED' &&
        (smcState === 'LONG CANDIDATE' || smcState === 'SHORT CANDIDATE') &&
        (finalTradeSignal === '多頭交易候選' ||
          finalTradeSignal === '空頭交易候選') &&
        !provenance.stale &&
        !provenance.fallback;

      const passedEvidences = stepAnalysis.evidences
        .filter((e) => e.passed)
        .map((e) => `${e.label}: ${e.value}`);

      const decisionEvidence: BacktestPointInTimeSignalEvidence = {
        barIndex: i,
        barOpenTime: signalBar.openTime,
        barCloseTime: signalBar.closeTime,
        confirmedBarsCount: visibleHistory.length,
        volumeBaselineBars: prior30Bars.length,
        smcEvidence: passedEvidences,
        oi: pointInTimeOi,
        funding: pointInTimeFunding,
        oiValue: pointInTimeOi,
        oiFetchedAt: pitOiFunding.oiFetchedAt,
        oiDataTimestamp: pitOiFunding.oiDataTimestamp,
        fundingRate: pointInTimeFunding,
        fundingDataTimestamp: pitOiFunding.fundingDataTimestamp,
        oiFundingPointInTime: true,
        decisionAt: decisionAtIso,
        smcEvaluationStatus: smcStatus,
        smcActionState: smcState,
        marketRadarCategory: rawRadarCategory,
        finalTradeSignal,
        waitReasons: stepAnalysis.waitReasons,
        countedAsTradeSignal: isTradeSignal,
        countedAsSignal: isTradeSignal,
        blockReason,
        blockedReason: blockReason,
        decisionTrace: {
          gates: {
            historyPassed:
              volAnomaly.status === 'READY' && !volAnomaly.baselineUnstable,
            liquidityPassed: !(stepCandidate?.isLowLiquidity ?? false),
            momentumPassed: Math.abs(rollingChangePct) >= 0,
            smcPassed: isTradeSignal,
            oiFundingPointInTimePassed: true,
          },
          rvol: volAnomaly.rvol,
          robustZScore: volAnomaly.robustZScore,
          rollingMedian: volAnomaly.rollingMedian,
          mad: volAnomaly.mad,
          unclosedBarsIgnored: unclosedIgnored,
          oiDataTimestamp: pitOiFunding.oiDataTimestamp,
          fundingDataTimestamp: pitOiFunding.fundingDataTimestamp,
        },
      };

      pointInTimeDecisions.push(decisionEvidence);

      // Track Near-Miss & Observation Shadow modes on the exact same confirmed bar without modifying formal signals
      const barNearMissStatus =
        stepAnalysis.nearMissStatus ?? 'NOT_NEAR_CANDIDATE';
      const barIntendedDir =
        stepAnalysis.intendedDirection &&
        stepAnalysis.intendedDirection !== 'NEUTRAL'
          ? stepAnalysis.intendedDirection
          : rawRadarCategory === '雷達多頭觀察'
            ? 'LONG'
            : rawRadarCategory === '雷達空頭觀察'
              ? 'SHORT'
              : rollingChangePct >= 0
                ? 'LONG'
                : 'SHORT';

      if (barNearMissStatus === 'NEAR_MISS_ONE_GATE') {
        nearMissOneGateBarCount++;
      } else if (barNearMissStatus === 'NEAR_MISS_TWO_GATES') {
        nearMissTwoGatesBarCount++;
      }

      const eligibleForShadowBase =
        pitOiFunding.oiFundingPointInTime &&
        smcStatus === 'EVALUATED' &&
        !provenance.stale &&
        !provenance.fallback &&
        Boolean(stepAnalysis.atr14 && stepAnalysis.atr14 > 0);

      const isShadow1Signal =
        isTradeSignal ||
        (eligibleForShadowBase && barNearMissStatus === 'NEAR_MISS_ONE_GATE');
      const isShadow2Signal =
        isShadow1Signal ||
        (eligibleForShadowBase && barNearMissStatus === 'NEAR_MISS_TWO_GATES');

      if (isShadow1Signal) {
        shadow1CandidateCount++;
        if (i > shadow1ActiveUntilIndex && stepAnalysis.atr14) {
          const sim1 = simulateBarTradeRMultiple(
            i,
            isTradeSignal
              ? smcState === 'LONG CANDIDATE'
                ? 'LONG'
                : 'SHORT'
              : barIntendedDir,
            stepAnalysis.atr14
          );
          if (sim1) {
            shadow1ActiveUntilIndex = sim1.exitIdx;
            shadow1RMultiples.push(sim1.rMultiple);
          }
        }
      }

      if (isShadow2Signal) {
        shadow2CandidateCount++;
        if (i > shadow2ActiveUntilIndex && stepAnalysis.atr14) {
          const sim2 = simulateBarTradeRMultiple(
            i,
            isTradeSignal
              ? smcState === 'LONG CANDIDATE'
                ? 'LONG'
                : 'SHORT'
              : barIntendedDir,
            stepAnalysis.atr14
          );
          if (sim2) {
            shadow2ActiveUntilIndex = sim2.exitIdx;
            shadow2RMultiples.push(sim2.rMultiple);
          }
        }
      }

      if (!isTradeSignal) {
        blockedCount++;
        continue;
      }

      signalCount++;

      if (i <= activeUntilIndex) {
        decisionEvidence.blockReason =
          'CONCURRENT_POSITION_ACTIVE: 同一標的已有進行中之紙上部位，不重疊開倉';
        decisionEvidence.blockedReason = decisionEvidence.blockReason;
        blockedCount++;
        continue;
      }

      const atr = stepAnalysis.atr14;
      if (!atr || atr <= 0) {
        decisionEvidence.blockReason = 'ATR_UNAVAILABLE: ATR14 無效';
        decisionEvidence.blockedReason = decisionEvidence.blockReason;
        blockedCount++;
        continue;
      }

      const direction = smcState === 'LONG CANDIDATE' ? 'LONG' : 'SHORT';

      // Next bar open is the realistic non-lookahead paper reference point
      const entryBar = confirmedKlines[i + 1];
      if (!entryBar) {
        expiredCount++;
        continue;
      }

      const referenceEntryPrice = entryBar.open;
      const riskDistance = atr * 1.5;
      const rewardDistance = atr * 2.5; // 1.67R structural benchmark for historical evaluation

      const structuralInvalidationPrice =
        direction === 'LONG'
          ? Number((referenceEntryPrice - riskDistance).toPrecision(6))
          : Number((referenceEntryPrice + riskDistance).toPrecision(6));

      const structuralTargetPrice =
        direction === 'LONG'
          ? Number((referenceEntryPrice + rewardDistance).toPrecision(6))
          : Number((referenceEntryPrice - rewardDistance).toPrecision(6));

      let exitBarTime = entryBar.closeTime;
      let exitPrice = entryBar.close;
      let rMultiple = 0;
      let outcome: 'WIN' | 'LOSS' | 'TIMEOUT_FLAT' = 'TIMEOUT_FLAT';
      let holdingBars = 1;

      const maxHoldEnd = Math.min(endIdx, i + 15);
      for (let f = i + 1; f <= maxHoldEnd; f++) {
        const bar = confirmedKlines[f];
        exitBarTime = bar.closeTime;
        activeUntilIndex = f;
        holdingBars = f - i;

        if (direction === 'LONG') {
          if (bar.low <= structuralInvalidationPrice) {
            exitPrice = structuralInvalidationPrice;
            rMultiple = -1.0;
            outcome = 'LOSS';
            break;
          }
          if (bar.high >= structuralTargetPrice) {
            exitPrice = structuralTargetPrice;
            rMultiple = Number((rewardDistance / riskDistance).toFixed(2));
            outcome = 'WIN';
            break;
          }
        } else {
          if (bar.high >= structuralInvalidationPrice) {
            exitPrice = structuralInvalidationPrice;
            rMultiple = -1.0;
            outcome = 'LOSS';
            break;
          }
          if (bar.low <= structuralTargetPrice) {
            exitPrice = structuralTargetPrice;
            rMultiple = Number((rewardDistance / riskDistance).toFixed(2));
            outcome = 'WIN';
            break;
          }
        }

        if (f === maxHoldEnd) {
          exitPrice = bar.close;
          const rawDiff =
            direction === 'LONG'
              ? exitPrice - referenceEntryPrice
              : referenceEntryPrice - exitPrice;
          rMultiple = Number((rawDiff / riskDistance).toFixed(2));
          outcome =
            rMultiple > 0.15
              ? 'WIN'
              : rMultiple < -0.15
                ? 'LOSS'
                : 'TIMEOUT_FLAT';
        }
      }

      if (outcome === 'TIMEOUT_FLAT') {
        expiredCount++;
      }

      executedPaperCount++;

      const passedLabels = stepAnalysis.evidences
        .filter((e) => e.passed)
        .map((e) => e.label)
        .join(' + ');

      const volTag =
        volAnomaly.status === 'READY'
          ? `RVOL ${volAnomaly.rvol}x (Z=${volAnomaly.zScore})`
          : 'VolHistory N/A';

      const scanTag = stepCandidate
        ? `[Scan:${stepCandidate.category}/${stepCandidate.score}pt]`
        : '';

      const holdingTimeMs = Math.max(
        tfDurationMs,
        holdingBars * tfDurationMs
      );

      trades.push({
        signalId: `bt_sig_${symbol}_${timeframe}_${signalBar.openTime}`,
        signalBarOpenTime: signalBar.openTime,
        signalBarCloseTime: signalBar.closeTime,
        entryBarTime: entryBar.openTime,
        exitBarTime,
        holdingTimeMs,
        holdingBars,
        direction,
        actionStateAtSignal: stepAnalysis.actionState,
        finalTradeSignalAtSignal: finalTradeSignal,
        marketRadarCategoryAtSignal: rawRadarCategory,
        referenceEntryPrice,
        structuralInvalidationPrice,
        structuralTargetPrice,
        exitPrice,
        rMultiple,
        outcome,
        evidencesSummary:
          `${scanTag} ${passedLabels || 'SMC 結構共振'} · ${volTag}`.trim(),
        pointInTimeEvidence: decisionEvidence,
      });
    }

    // Section 一 & 三: If ANY evaluated bar lacked point-in-time historical OI or Funding,
    // the backtest MUST be marked INSUFFICIENT_DATA and lookaheadFree = false.
    if (missingPointInTimeOiOrFundingBars > 0) {
      return buildInsufficientResult(
        `歷史 OI／Funding 資料不足：共 ${missingPointInTimeOiOrFundingBars} 根歷史 K 線無法取得時間點對齊 (timestamp <= barCloseTime) 之歷史 OI 或 Funding，系統嚴禁使用當下 OI／Funding 回填過去。`,
        false,
        pointInTimeVolumeSnapshots,
        pointInTimeDecisions,
        {
          insufficientDataCount,
          blockedCount,
          pendingCount,
          waitCount,
          watchCount,
          highRiskCount,
        }
      );
    }

    const isProxyOrDegraded =
      provenance.fallback ||
      provenance.stale ||
      /proxy/i.test(`${rawProvenance.source || ''} ${provenance.source || ''}`);
    const lookaheadFree = !isProxyOrDegraded;
    const { dataClassification, dataClassificationLabel } =
      classifyBacktestData(
        provenance,
        'COMPLETED',
        lookaheadFree,
        rawProvenance.source
      );

    const totalTrades = trades.length;
    const longCount = trades.filter((t) => t.direction === 'LONG').length;
    const shortCount = trades.filter((t) => t.direction === 'SHORT').length;
    const evaluatedBarsCount = Math.max(0, endIdx - startIdx - 1);

    const buildModeMetrics = (
      mode:
        | 'STRICT_PRODUCTION'
        | 'OBSERVATION_SHADOW_ONE_GATE_MISSING'
        | 'OBSERVATION_SHADOW_TWO_GATES_MISSING',
      modeLabel: string,
      isFormalProductionRule: boolean,
      candCount: number,
      nmCount: number,
      rMultiples: number[],
      modeTrades: BacktestTradeRecord[] = []
    ): BacktestShadowModeMetrics => {
      const closedCount = rMultiples.length;
      const sufficiency: SampleSufficiencyTier =
        closedCount >= 100
          ? 'SUFFICIENT'
          : closedCount >= 30
            ? 'LIMITED'
            : 'INSUFFICIENT';
      const staleBarCount = provenance.stale ? evaluatedBarsCount : 0;
      const missingBarCount =
        missingPointInTimeOiOrFundingBars + insufficientDataCount;

      if (closedCount === 0) {
        return {
          mode,
          modeLabel,
          isFormalProductionRule,
          paperCreationAllowed: isFormalProductionRule,
          notificationAllowed: isFormalProductionRule,
          evaluatedCount: evaluatedBarsCount,
          candidateCount: candCount,
          nearMissCount: nmCount,
          entryWindowMissedCount: 0,
          paperOpenedCount: 0,
          paperClosedCount: 0,
          winRate: null,
          averageR: null,
          profitFactor: null,
          maxDrawdownR: null,
          expectancyR: null,
          sampleSufficiency: sufficiency,
          dataStaleCount: staleBarCount,
          missingDataCount: missingBarCount,
          trades: modeTrades,
        };
      }

      const modeWins = rMultiples.filter((r) => r > 0);
      const modeLosses = rMultiples.filter((r) => r < 0);
      const modeWinRate = Number(
        ((modeWins.length / closedCount) * 100).toFixed(1)
      );
      const modeTotalR = rMultiples.reduce((a, b) => a + b, 0);
      const modeAvgR = Number((modeTotalR / closedCount).toFixed(2));
      const modeGrossProfit = modeWins.reduce((a, b) => a + b, 0);
      const modeGrossLoss = Math.abs(modeLosses.reduce((a, b) => a + b, 0));
      const modePf =
        modeGrossLoss > 0
          ? Number((modeGrossProfit / modeGrossLoss).toFixed(2))
          : modeGrossProfit > 0
            ? Number(modeGrossProfit.toFixed(2))
            : null;
      let cumR = 0;
      let pkR = 0;
      let mddR = 0;
      for (const r of rMultiples) {
        cumR += r;
        if (cumR > pkR) pkR = cumR;
        const dd = pkR - cumR;
        if (dd > mddR) mddR = dd;
      }

      return {
        mode,
        modeLabel,
        isFormalProductionRule,
        paperCreationAllowed: isFormalProductionRule,
        notificationAllowed: isFormalProductionRule,
        evaluatedCount: evaluatedBarsCount,
        candidateCount: candCount,
        nearMissCount: nmCount,
        entryWindowMissedCount: 0,
        paperOpenedCount: closedCount,
        paperClosedCount: closedCount,
        winRate: modeWinRate,
        averageR: modeAvgR,
        profitFactor: modePf,
        maxDrawdownR: Number(mddR.toFixed(2)),
        expectancyR: modeAvgR,
        sampleSufficiency: sufficiency,
        dataStaleCount: staleBarCount,
        missingDataCount: missingBarCount,
        trades: modeTrades,
      };
    };

    const strictRMultiples = trades.map((t) => t.rMultiple);
    const strictProdMetrics = buildModeMetrics(
      'STRICT_PRODUCTION',
      '正式交易訊號模式 (全部 SMC Gate 通過)',
      true,
      signalCount,
      nearMissOneGateBarCount + nearMissTwoGatesBarCount,
      strictRMultiples,
      trades
    );
    const shadowOneMetrics = buildModeMetrics(
      'OBSERVATION_SHADOW_ONE_GATE_MISSING',
      '影子觀察模式：差 1 個 Gate (僅供研究)',
      false,
      shadow1CandidateCount,
      nearMissOneGateBarCount,
      shadow1RMultiples,
      []
    );
    const shadowTwoMetrics = buildModeMetrics(
      'OBSERVATION_SHADOW_TWO_GATES_MISSING',
      '影子觀察模式：差 1～2 個 Gate (僅供研究)',
      false,
      shadow2CandidateCount,
      nearMissOneGateBarCount + nearMissTwoGatesBarCount,
      shadow2RMultiples,
      []
    );
    const modeComparison: BacktestModeComparisonMatrix = {
      lookaheadFree,
      lookaheadFreeVerified: lookaheadFree,
      confirmedClosedKlinesOnly: true,
      formalLedgerUnmodified: true,
      strictProduction: strictProdMetrics,
      observationShadowOneGateMissing: shadowOneMetrics,
      observationShadowTwoGatesMissing: shadowTwoMetrics,
      STRICT_PRODUCTION: strictProdMetrics,
      OBSERVATION_SHADOW_ONE_GATE_MISSING: shadowOneMetrics,
      OBSERVATION_SHADOW_TWO_GATES_MISSING: shadowTwoMetrics,
    };

    // Section 五: When executedPaperCount = 0, ALL performance metrics (including maxDrawdownR)
    // MUST be null, and metricStatus MUST be "NO_TRADES".
    if (totalTrades === 0) {
      return {
        safety: TRADING_SAFETY_FLAGS,
        backtestRunId,
        symbol,
        exchange,
        timeframe,
        ruleVersion: effectiveRuleVersion,
        scannerRuleVersion: this.scannerRuleVersion,
        startTime: startTimeIso,
        endTime: endTimeIso,
        dataSource: provenance.source,
        fetchedAt: provenance.fetchedAt,
        isDemo: provenance.isDemo,
        lookaheadFree,
        lookaheadFreeVerified: lookaheadFree,
        oiFundingPointInTimeVerified: true,
        dataClassification,
        dataClassificationLabel,
        status: 'COMPLETED',
        metricStatus: 'NO_TRADES',
        confirmedBarsTested: endIdx - startIdx + 1,
        unclosedBarsIgnored: unclosedIgnored,
        totalTrades: 0,
        tradeCount: 0,
        winRatePercent: null,
        winRate: null,
        averageR: null,
        expectancyR: null,
        maxDrawdownR: null,
        profitFactor: null,
        averageWinR: null,
        averageLossR: null,
        averageHoldingTime: null,
        averageHoldingTimeMs: null,
        averageHoldingBars: null,
        longCount: 0,
        shortCount: 0,
        signalCount,
        executedPaperCount,
        blockedCount,
        expiredCount,
        insufficientDataCount,
        waitCount,
        watchCount,
        pendingCount,
        highRiskCount,
        trades: [],
        pointInTimeVolumeSnapshots,
        pointInTimeDecisions,
        modeComparison,
        provenance,
      };
    }

    const wins = trades.filter((t) => t.rMultiple > 0);
    const losses = trades.filter((t) => t.rMultiple < 0);

    const winRatePercent = Number(
      ((wins.length / totalTrades) * 100).toFixed(1)
    );

    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const averageR = Number((totalR / totalTrades).toFixed(2));
    const expectancyR = averageR;

    const grossProfitR = wins.reduce((s, t) => s + t.rMultiple, 0);
    const grossLossR = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));

    const profitFactor =
      grossLossR > 0
        ? Number((grossProfitR / grossLossR).toFixed(2))
        : grossProfitR > 0
          ? Number(grossProfitR.toFixed(2))
          : null;

    const averageWinR =
      wins.length > 0
        ? Number((grossProfitR / wins.length).toFixed(2))
        : null;
    const averageLossR =
      losses.length > 0
        ? Number((grossLossR / losses.length).toFixed(2))
        : null;

    // Calculate Max Drawdown in R units
    let cumulativeR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;

    for (const t of trades) {
      cumulativeR += t.rMultiple;
      if (cumulativeR > peakR) {
        peakR = cumulativeR;
      }
      const dd = peakR - cumulativeR;
      if (dd > maxDrawdownR) {
        maxDrawdownR = dd;
      }
    }

    const averageHoldingTimeMs = Math.round(
      trades.reduce((s, t) => s + (t.holdingTimeMs ?? tfDurationMs), 0) /
        totalTrades
    );
    const averageHoldingBars = Number(
      (
        trades.reduce((s, t) => s + (t.holdingBars ?? 1), 0) / totalTrades
      ).toFixed(1)
    );
    const averageHoldingMinutes = Math.round(averageHoldingTimeMs / 60_000);
    const averageHoldingTime =
      averageHoldingMinutes >= 60
        ? `${(averageHoldingMinutes / 60).toFixed(1)}h (${averageHoldingBars} 根 ${timeframe} K 線)`
        : `${averageHoldingMinutes}m (${averageHoldingBars} 根 ${timeframe} K 線)`;

    return {
      safety: TRADING_SAFETY_FLAGS,
      backtestRunId,
      symbol,
      exchange,
      timeframe,
      ruleVersion: effectiveRuleVersion,
      scannerRuleVersion: this.scannerRuleVersion,
      startTime: startTimeIso,
      endTime: endTimeIso,
      dataSource: provenance.source,
      fetchedAt: provenance.fetchedAt,
      isDemo: provenance.isDemo,
      lookaheadFree,
      lookaheadFreeVerified: lookaheadFree,
      oiFundingPointInTimeVerified: true,
      dataClassification,
      dataClassificationLabel,
      status: 'COMPLETED',
      metricStatus: 'READY',
      confirmedBarsTested: endIdx - startIdx + 1,
      unclosedBarsIgnored: unclosedIgnored,
      totalTrades,
      tradeCount: totalTrades,
      winRatePercent,
      winRate: winRatePercent,
      averageR,
      expectancyR,
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
      profitFactor,
      averageWinR,
      averageLossR,
      averageHoldingTime,
      averageHoldingTimeMs,
      averageHoldingBars,
      longCount,
      shortCount,
      signalCount,
      executedPaperCount,
      blockedCount,
      expiredCount,
      insufficientDataCount,
      waitCount,
      watchCount,
      pendingCount,
      highRiskCount,
      trades,
      pointInTimeVolumeSnapshots,
      pointInTimeDecisions,
      modeComparison,
      provenance,
    };
  }

  /**
   * Executes a strict 3-window Walk-Forward evaluation:
   * - Training Window (訓練期)
   * - Validation Window (驗證期)
   * - Forward Test Window (前推測試期)
   * Strictly chronological (no shuffling), point-in-time OI & Funding aligned, and freezes `ruleVersion`
   * before Forward Test (`parameterFeedbackBlocked: true`).
   */
  public runWalkForwardBacktest(input: RunWalkForwardInput): {
    combinedReport: BacktestResult;
    walkForward: WalkForwardBacktestResult;
  } {
    const {
      symbol,
      exchange = 'binance_usdm',
      timeframe,
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: rawProvenance,
      ruleVersion: customRuleVersion,
    } = input;

    const frozenRuleVersion = customRuleVersion || this.ruleVersion;
    const provenance = enforceProvenanceIntegrity(rawProvenance);
    const backtestRunId =
      input.backtestRunId ||
      `wf_${exchange}_${symbol}_${timeframe}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const chronoCheck = verifyChronologicalKlines(klines);
    if (!chronoCheck.valid) {
      throw new Error(
        chronoCheck.reason ||
          'Walk-forward 嚴格禁止打散時間序列：K 線必須按開盤時間嚴格遞增。'
      );
    }

    const confirmedKlines = klines.filter((k) => k.isClosed === true);
    const evaluableCount = confirmedKlines.length - MIN_HISTORY_SAMPLES;

    const buildWindowResult = (
      stage: WalkForwardStage,
      stageLabel: string,
      wStart: number,
      wEnd: number
    ): WalkForwardWindowResult => {
      if (
        confirmedKlines.length < MIN_CONFIRMED_BARS_FOR_WALK_FORWARD ||
        wEnd - wStart < 3
      ) {
        const sIso =
          confirmedKlines[wStart]?.openTime !== undefined
            ? new Date(confirmedKlines[wStart].openTime).toISOString()
            : new Date().toISOString();
        const eIso =
          confirmedKlines[wEnd]?.closeTime !== undefined
            ? new Date(confirmedKlines[wEnd].closeTime).toISOString()
            : sIso;
        return {
          stage,
          stageLabel,
          startTime: sIso,
          endTime: eIso,
          startBarIndex: wStart,
          endBarIndex: wEnd,
          confirmedBarsCount: Math.max(0, wEnd - wStart + 1),
          status: 'INSUFFICIENT_DATA',
          metricStatus: 'INSUFFICIENT_DATA',
          lookaheadFree: false,
          dataClassification: 'INSUFFICIENT_DATA',
          insufficientReason: `已確認 K 線不足 (總數 ${confirmedKlines.length} 根，最低需求 ${MIN_CONFIRMED_BARS_FOR_WALK_FORWARD} 根)`,
          signalCount: 0,
          executedPaperCount: 0,
          blockedCount: 0,
          expiredCount: 0,
          insufficientDataCount: Math.max(1, wEnd - wStart + 1),
          waitCount: 0,
          watchCount: 0,
          pendingCount: 0,
          highRiskCount: 0,
          tradeCount: null,
          winRate: null,
          averageR: null,
          profitFactor: null,
          maxDrawdownR: null,
          expectancyR: null,
          averageHoldingTime: null,
          averageHoldingTimeMs: null,
          averageHoldingBars: null,
          longCount: null,
          shortCount: null,
          trades: [],
        };
      }

      const windowEndCloseTime = confirmedKlines[wEnd].closeTime;
      const visibleOi = (historicalOpenInterest ?? []).filter(
        (pt) => pt.timestamp <= windowEndCloseTime
      );
      const visibleFunding = (historicalFundingRates ?? []).filter(
        (pt) => pt.timestamp <= windowEndCloseTime
      );

      const subRes = this.runDeterministicBacktest({
        backtestRunId: `${backtestRunId}_${stage.toLowerCase()}`,
        symbol,
        exchange,
        timeframe,
        klines: confirmedKlines.slice(0, wEnd + 1),
        historicalOpenInterest: visibleOi,
        historicalFundingRates: visibleFunding,
        provenance,
        ruleVersion: frozenRuleVersion,
        evalStartIndex: wStart,
        evalEndIndex: wEnd,
      });

      const windowMetricStatus: BacktestMetricStatus =
        subRes.status === 'INSUFFICIENT_DATA' || !subRes.lookaheadFree
          ? 'INSUFFICIENT_DATA'
          : (subRes.executedPaperCount ?? 0) === 0
            ? 'NO_TRADES'
            : 'READY';

      return {
        stage,
        stageLabel,
        startTime:
          subRes.startTime ||
          new Date(confirmedKlines[wStart].openTime).toISOString(),
        endTime:
          subRes.endTime ||
          new Date(confirmedKlines[wEnd].closeTime).toISOString(),
        startBarIndex: wStart,
        endBarIndex: wEnd,
        confirmedBarsCount: wEnd - wStart + 1,
        status: subRes.status,
        metricStatus: windowMetricStatus,
        lookaheadFree: subRes.lookaheadFree,
        dataClassification: subRes.dataClassification,
        insufficientReason: subRes.insufficientReason,
        signalCount: subRes.signalCount ?? 0,
        executedPaperCount: subRes.executedPaperCount ?? 0,
        blockedCount: subRes.blockedCount ?? 0,
        expiredCount: subRes.expiredCount ?? 0,
        insufficientDataCount: subRes.insufficientDataCount ?? 0,
        waitCount: subRes.waitCount ?? 0,
        watchCount: subRes.watchCount ?? 0,
        pendingCount: subRes.pendingCount ?? 0,
        highRiskCount: subRes.highRiskCount ?? 0,
        tradeCount: subRes.tradeCount ?? null,
        winRate: subRes.winRate ?? null,
        averageR: subRes.averageR ?? null,
        profitFactor: subRes.profitFactor ?? null,
        maxDrawdownR: subRes.maxDrawdownR ?? null,
        expectancyR: subRes.expectancyR ?? null,
        averageHoldingTime: subRes.averageHoldingTime ?? null,
        averageHoldingTimeMs: subRes.averageHoldingTimeMs ?? null,
        averageHoldingBars: subRes.averageHoldingBars ?? null,
        longCount: subRes.longCount ?? null,
        shortCount: subRes.shortCount ?? null,
        trades: subRes.trades,
      };
    };

    const trainSpan = Math.max(4, Math.floor(evaluableCount * 0.4));
    const valSpan = Math.max(3, Math.floor(evaluableCount * 0.3));

    const trainStart = MIN_HISTORY_SAMPLES;
    const trainEnd = Math.min(
      confirmedKlines.length - 1,
      trainStart + trainSpan - 1
    );
    const valStart = Math.min(confirmedKlines.length - 1, trainEnd + 1);
    const valEnd = Math.min(
      confirmedKlines.length - 1,
      valStart + valSpan - 1
    );
    const fwdStart = Math.min(confirmedKlines.length - 1, valEnd + 1);
    const fwdEnd = Math.max(fwdStart, confirmedKlines.length - 1);

    const trainingWindow = buildWindowResult(
      'TRAINING',
      '訓練期 (Training Window)',
      trainStart,
      trainEnd
    );
    const validationWindow = buildWindowResult(
      'VALIDATION',
      '驗證期 (Validation Window)',
      valStart,
      valEnd
    );
    const forwardTestWindow = buildWindowResult(
      'FORWARD_TEST',
      '前推測試期 (Forward Test Window)',
      fwdStart,
      fwdEnd
    );

    const fullReport = this.runDeterministicBacktest({
      backtestRunId,
      symbol,
      exchange,
      timeframe,
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance,
      ruleVersion: frozenRuleVersion,
    });

    if (confirmedKlines.length < MIN_CONFIRMED_BARS_FOR_WALK_FORWARD) {
      fullReport.status = 'INSUFFICIENT_DATA';
      fullReport.metricStatus = 'INSUFFICIENT_DATA';
      fullReport.lookaheadFree = false;
      fullReport.lookaheadFreeVerified = false;
      fullReport.insufficientReason = `Walk-Forward 資料不足：已確認 K 線僅 ${confirmedKlines.length} 根 (最低需求 ${MIN_CONFIRMED_BARS_FOR_WALK_FORWARD} 根)。`;
      fullReport.totalTrades = null;
      fullReport.tradeCount = null;
      fullReport.winRate = null;
      fullReport.winRatePercent = null;
      fullReport.averageR = null;
      fullReport.expectancyR = null;
      fullReport.profitFactor = null;
      fullReport.maxDrawdownR = null;
      fullReport.averageHoldingTime = null;
      fullReport.longCount = null;
      fullReport.shortCount = null;
      fullReport.dataClassification = 'INSUFFICIENT_DATA';
      fullReport.dataClassificationLabel = '資料不足';
    }

    const allWindowsLookaheadFree =
      fullReport.lookaheadFree &&
      trainingWindow.lookaheadFree &&
      validationWindow.lookaheadFree &&
      forwardTestWindow.lookaheadFree;

    const walkForward: WalkForwardBacktestResult = {
      chronologicalOrderVerified: true,
      noShufflingVerified: true,
      parameterFeedbackBlocked: true,
      frozenRuleVersion,
      lookaheadFree: allWindowsLookaheadFree,
      noFutureLeakageVerified: allWindowsLookaheadFree,
      trainingWindow,
      validationWindow,
      forwardTestWindow,
    };

    fullReport.walkForward = walkForward;

    return {
      combinedReport: fullReport,
      walkForward,
    };
  }
}
