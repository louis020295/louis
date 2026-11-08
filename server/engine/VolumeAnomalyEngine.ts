import {
  DataProvenance,
  ExchangeId,
  HistoricalVolumeMetrics,
  VolumeTimeframe,
} from '../../src/types/market.ts';
import { enforceProvenanceIntegrity } from '../utils/provenanceQuarantine.ts';

export const MIN_HISTORY_SAMPLES = 30;
export const DEFAULT_MIN_HISTORICAL_SAMPLES = MIN_HISTORY_SAMPLES;
export const DEFAULT_ROLLING_WINDOW = 30;

export const DEFAULT_VOLUME_TIMEFRAME: VolumeTimeframe = '15m';
export const DEFAULT_AGGREGATION_WINDOWS: Record<VolumeTimeframe, string> = {
  '15m': '15m_CONFIRMED_KLINE_30_BARS',
  '24h': '24h_ROLLING_WINDOW_30_SAMPLES',
};

// Minimum acceptable MAD-to-Median ratio (3%). Below this, historical volume dispersion is near-zero / flatline.
export const MIN_RELATIVE_MAD_RATIO = 0.03;
// Maximum sane Robust Z-Score threshold before flagging baseline instability / extreme outlier.
export const MAX_SANE_ROBUST_ZSCORE = 8.0;

export function calculateMedian(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function calculateMad(
  values: number[],
  medianValue?: number
): number | null {
  const med = medianValue ?? calculateMedian(values);
  if (med === null) return null;
  const absDeviations = values
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.abs(v - med));
  return calculateMedian(absDeviations);
}

export function calculateStdDev(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return null;
  const mean = valid.reduce((acc, v) => acc + v, 0) / valid.length;
  const variance =
    valid.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

export function validateVolumeTimeframeConsistency(
  currentVolumeTimeframe: VolumeTimeframe,
  historicalVolumeTimeframe: VolumeTimeframe
): { valid: boolean; reason: string | null } {
  if (currentVolumeTimeframe !== historicalVolumeTimeframe) {
    return {
      valid: false,
      reason: `TIMEFRAME_MISMATCH_REJECTED: 禁止將 ${currentVolumeTimeframe} currentVolume 與 ${historicalVolumeTimeframe} historical samples 混算 Z-Score（24h currentVolume 只能搭配 24h historical samples，15m currentVolume 只能搭配 15m historical samples）`,
    };
  }
  return { valid: true, reason: null };
}

/**
 * Strictly extracts the current confirmed bar's quoteVolume at `targetBarIndex` (defaults to the last confirmed bar)
 * and the prior `windowSize` (30) confirmed bars strictly BEFORE `targetBarIndex`: `[max(0, idx - windowSize), idx)`.
 * The current bar at `targetBarIndex` is NEVER included in its own historical baseline.
 */
export function extractPriorConfirmedBaselineWindow(
  confirmedQuoteVolumes: number[],
  targetBarIndex?: number,
  windowSize = DEFAULT_ROLLING_WINDOW
): {
  currentVolume: number | null;
  historicalVolumes: number[];
  evaluatedBarIndex: number;
} {
  const validBars = confirmedQuoteVolumes.filter(
    (v) => Number.isFinite(v) && v >= 0
  );
  if (validBars.length === 0) {
    return {
      currentVolume: null,
      historicalVolumes: [],
      evaluatedBarIndex: -1,
    };
  }
  const idx =
    targetBarIndex !== undefined
      ? Math.min(Math.max(0, targetBarIndex), validBars.length - 1)
      : validBars.length - 1;
  const currentVolume = validBars[idx];
  const startIdx = Math.max(0, idx - windowSize);
  // Strictly slice [startIdx, idx) — excludes validBars[idx] (current bar) and all future bars (> idx)
  const historicalVolumes = validBars.slice(startIdx, idx);
  return {
    currentVolume,
    historicalVolumes,
    evaluatedBarIndex: idx,
  };
}

export interface EvaluateVolumeAnomalyInput {
  symbol: string;
  exchange: ExchangeId;
  currentVolume: number | null;
  historicalVolumes: number[];
  volumeTimeframe?: VolumeTimeframe;
  currentVolumeTimeframe?: VolumeTimeframe;
  historicalVolumeTimeframe?: VolumeTimeframe;
  aggregationWindow?: string;
  volumeMetric?: 'quoteVolume';
  minRequiredSamples?: number;
  rollingWindow?: number;
  throwOnTimeframeMismatch?: boolean;
  baseProvenance: DataProvenance;
}

export function evaluateConfirmedKlineVolumeSeries(params: {
  symbol: string;
  exchange: ExchangeId;
  confirmedQuoteVolumes: number[];
  targetBarIndex?: number;
  volumeTimeframe?: VolumeTimeframe;
  aggregationWindow?: string;
  volumeMetric?: 'quoteVolume';
  minRequiredSamples?: number;
  rollingWindow?: number;
  baseProvenance: DataProvenance;
}): HistoricalVolumeMetrics {
  const rollingWindow = params.rollingWindow ?? DEFAULT_ROLLING_WINDOW;
  const { currentVolume, historicalVolumes } =
    extractPriorConfirmedBaselineWindow(
      params.confirmedQuoteVolumes,
      params.targetBarIndex,
      rollingWindow
    );
  return evaluateHistoricalVolumeAnomaly({
    symbol: params.symbol,
    exchange: params.exchange,
    currentVolume,
    historicalVolumes,
    volumeTimeframe: params.volumeTimeframe ?? '15m',
    aggregationWindow: params.aggregationWindow,
    volumeMetric: params.volumeMetric ?? 'quoteVolume',
    minRequiredSamples: params.minRequiredSamples,
    rollingWindow,
    baseProvenance: params.baseProvenance,
  });
}

export function evaluateHistoricalVolumeAnomaly(
  input: EvaluateVolumeAnomalyInput
): HistoricalVolumeMetrics {
  const {
    symbol,
    exchange,
    currentVolume,
    historicalVolumes,
    minRequiredSamples = MIN_HISTORY_SAMPLES,
    rollingWindow = DEFAULT_ROLLING_WINDOW,
    throwOnTimeframeMismatch = false,
    baseProvenance,
  } = input;

  const currentTf: VolumeTimeframe =
    input.currentVolumeTimeframe ??
    input.volumeTimeframe ??
    DEFAULT_VOLUME_TIMEFRAME;
  const historyTf: VolumeTimeframe =
    input.historicalVolumeTimeframe ??
    input.volumeTimeframe ??
    DEFAULT_VOLUME_TIMEFRAME;
  const resolvedTimeframe: VolumeTimeframe = historyTf;
  const aggregationWindow =
    input.aggregationWindow ?? DEFAULT_AGGREGATION_WINDOWS[resolvedTimeframe];
  const volumeMetric = input.volumeMetric ?? 'quoteVolume';

  const safeProvenance = enforceProvenanceIntegrity({
    ...baseProvenance,
    volumeTimeframe: resolvedTimeframe,
    aggregationWindow,
    volumeMetric,
  });

  const cleanHistory = historicalVolumes
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(-rollingWindow);

  const sampleCount = cleanHistory.length;
  const safeCurrentVolume =
    currentVolume !== null &&
    currentVolume !== undefined &&
    Number.isFinite(currentVolume) &&
    currentVolume >= 0
      ? currentVolume
      : 0;

  // 1. Strict Timeframe Consistency Gate:
  //    - 24h currentVolume with 15m historical samples MUST be directly rejected.
  //    - 15m currentVolume with 24h historical samples MUST be directly rejected.
  //    - Timeframe mismatch is NEVER marked as BASELINE_UNSTABLE and NEVER computes a fake Z-Score (e.g. 130.6).
  const tfCheck = validateVolumeTimeframeConsistency(currentTf, historyTf);
  if (
    !tfCheck.valid ||
    (input.volumeTimeframe &&
      (input.volumeTimeframe !== currentTf ||
        input.volumeTimeframe !== historyTf))
  ) {
    const rejectionReason =
      tfCheck.reason ??
      `TIMEFRAME_MISMATCH_REJECTED: volumeTimeframe=${input.volumeTimeframe} 與 currentVolumeTimeframe=${currentTf} / historicalVolumeTimeframe=${historyTf} 不一致`;

    if (throwOnTimeframeMismatch) {
      throw new Error(rejectionReason);
    }

    const missingData = [...safeProvenance.missingData];
    if (!missingData.includes('VOLUME_TIMEFRAME_MISMATCH_REJECTED')) {
      missingData.push('VOLUME_TIMEFRAME_MISMATCH_REJECTED');
    }

    return {
      symbol,
      exchange,
      volumeTimeframe: resolvedTimeframe,
      aggregationWindow,
      volumeMetric,
      sampleCount,
      minRequiredSamples,
      currentVolume: safeCurrentVolume,
      historicalSamples: [...cleanHistory],
      rollingMedian: null,
      mad: null,
      madToMedianRatio: null,
      rawRobustZScore: null,
      unstableReason: null,
      timeframeMismatchRejected: true,
      rejectionReason,
      robustZScore: null,
      zScore: null,
      rvol: null,
      isHistoricalAnomaly: false,
      baselineUnstable: false,
      status: 'INSUFFICIENT_HISTORY',
      provenance: {
        ...safeProvenance,
        missingData,
      },
    };
  }

  // 2. Check minimum required samples (30) and valid currentVolume on the same timeframe
  if (
    sampleCount < minRequiredSamples ||
    currentVolume === null ||
    currentVolume === undefined ||
    !Number.isFinite(currentVolume) ||
    currentVolume < 0
  ) {
    const missingData = [...safeProvenance.missingData];
    if (!missingData.includes('HISTORICAL_VOLUME_BASELINE')) {
      missingData.push('HISTORICAL_VOLUME_BASELINE');
    }

    return {
      symbol,
      exchange,
      volumeTimeframe: resolvedTimeframe,
      aggregationWindow,
      volumeMetric,
      sampleCount,
      minRequiredSamples,
      currentVolume: safeCurrentVolume,
      historicalSamples: [...cleanHistory],
      rollingMedian: null,
      mad: null,
      madToMedianRatio: null,
      rawRobustZScore: null,
      unstableReason: null,
      timeframeMismatchRejected: false,
      rejectionReason: null,
      robustZScore: null,
      zScore: null,
      rvol: null,
      isHistoricalAnomaly: false,
      baselineUnstable: false,
      status: 'INSUFFICIENT_HISTORY',
      provenance: {
        ...safeProvenance,
        missingData,
      },
    };
  }

  const medianRaw = calculateMedian(cleanHistory)!;
  const madRaw = calculateMad(cleanHistory, medianRaw)!;

  const rollingMedian = Number(medianRaw.toFixed(2));
  const mad = Number(madRaw.toFixed(2));

  // Check if MAD is near zero or too small relative to median (< 3% of rollingMedian)
  const relativeMadRatio = medianRaw > 0 ? madRaw / medianRaw : 0;
  const madToMedianRatio = Number(relativeMadRatio.toFixed(4));
  const scaledMad = madRaw * 1.4826;
  const rawZ =
    scaledMad > 0 ? (currentVolume - medianRaw) / scaledMad : Number.NaN;
  const rawRobustZScore = Number.isFinite(rawZ)
    ? Number(rawZ.toFixed(2))
    : null;

  if (
    medianRaw <= 0 ||
    madRaw <= 0 ||
    relativeMadRatio < MIN_RELATIVE_MAD_RATIO
  ) {
    const missingData = [...safeProvenance.missingData];
    if (!missingData.includes('VOLUME_BASELINE_UNSTABLE')) {
      missingData.push('VOLUME_BASELINE_UNSTABLE');
    }

    return {
      symbol,
      exchange,
      volumeTimeframe: resolvedTimeframe,
      aggregationWindow,
      volumeMetric,
      sampleCount,
      minRequiredSamples,
      currentVolume,
      historicalSamples: [...cleanHistory],
      rollingMedian,
      mad,
      madToMedianRatio,
      rawRobustZScore,
      unstableReason:
        medianRaw <= 0 || madRaw <= 0
          ? 'NON_POSITIVE_BASELINE'
          : 'MAD_RATIO_TOO_SMALL',
      timeframeMismatchRejected: false,
      rejectionReason: null,
      robustZScore: null,
      zScore: null,
      rvol: null,
      isHistoricalAnomaly: false,
      baselineUnstable: true,
      status: 'BASELINE_UNSTABLE',
      provenance: {
        ...safeProvenance,
        missingData,
      },
    };
  }

  if (!Number.isFinite(rawZ) || Math.abs(rawZ) > MAX_SANE_ROBUST_ZSCORE) {
    const missingData = [...safeProvenance.missingData];
    if (!missingData.includes('VOLUME_BASELINE_UNSTABLE')) {
      missingData.push('VOLUME_BASELINE_UNSTABLE');
    }

    return {
      symbol,
      exchange,
      volumeTimeframe: resolvedTimeframe,
      aggregationWindow,
      volumeMetric,
      sampleCount,
      minRequiredSamples,
      currentVolume,
      historicalSamples: [...cleanHistory],
      rollingMedian,
      mad,
      madToMedianRatio,
      rawRobustZScore,
      unstableReason: 'EXTREME_ROBUST_ZSCORE_OUTLIER',
      timeframeMismatchRejected: false,
      rejectionReason: null,
      robustZScore: null,
      zScore: null,
      rvol: null,
      isHistoricalAnomaly: false,
      baselineUnstable: true,
      status: 'BASELINE_UNSTABLE',
      provenance: {
        ...safeProvenance,
        missingData,
      },
    };
  }

  const robustZScore = Number(rawZ.toFixed(2));
  const rvol = Number((currentVolume / medianRaw).toFixed(2));

  const isHistoricalAnomaly =
    (rvol >= 1.6 && robustZScore >= 1.8) ||
    rvol >= 1.85 ||
    (robustZScore >= 2.0 && robustZScore <= 5.5);

  return {
    symbol,
    exchange,
    volumeTimeframe: resolvedTimeframe,
    aggregationWindow,
    volumeMetric,
    sampleCount,
    minRequiredSamples,
    currentVolume,
    historicalSamples: [...cleanHistory],
    rollingMedian,
    mad,
    madToMedianRatio,
    rawRobustZScore,
    unstableReason: null,
    timeframeMismatchRejected: false,
    rejectionReason: null,
    robustZScore,
    zScore: robustZScore,
    rvol,
    isHistoricalAnomaly,
    baselineUnstable: false,
    status: 'READY',
    provenance: {
      ...safeProvenance,
    },
  };
}
