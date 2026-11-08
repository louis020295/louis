import {
  DataProvenance,
  EvidenceItem,
  FunnelAggregationScope,
  GateStatisticScope,
  HistoricalVolumeMetrics,
  Kline,
  MarketRadarCategory,
  NearMissStatus,
  ObservationShadowComparisonSummary,
  ScopedFunnelBlock,
  ScopedGateStatisticItem,
  ScopedGateStatisticsSummary,
  SmcActionState,
  SmcAnalysisResult,
  SmcBosMssEvidence,
  SmcDisplacementEvidence,
  SmcEvaluationStatus,
  SmcFvgEvidence,
  SmcGateDiagnosticsSummary,
  SmcLiquiditySweepEvidence,
  SmcMtfAlignment,
  SmcNearMissSymbolRecord,
  SmcOrderBlockEvidence,
  SmcStatsConsistency,
  SymbolSmcGateEvaluation,
  Timeframe,
} from '../../src/types/market.ts';
import { MIN_HISTORY_SAMPLES } from './VolumeAnomalyEngine.ts';
import { enforceProvenanceIntegrity } from '../utils/provenanceQuarantine.ts';

export const SMC_RULE_VERSION = 'v1.0.0-smc-ict-deterministic';

export interface EvaluateSmcInput {
  symbol: string;
  primaryTimeframe: Timeframe;
  klinesByTimeframe: Partial<Record<Timeframe, Kline[]>>;
  openInterest: number | null;
  historicalVolume?: HistoricalVolumeMetrics;
  isLowLiquidity?: boolean;
  extremeFunding?: boolean;
  lowLiquidityHighVolatility?: boolean;
  requireFullMultiTimeframe?: boolean;
  provenance: DataProvenance;
}

export function calculateConfirmedAtr14(confirmedKlines: Kline[]): number | null {
  if (confirmedKlines.length < 15) return null;
  const trs: number[] = [];
  for (let i = 1; i < confirmedKlines.length; i++) {
    const curr = confirmedKlines[i];
    const prev = confirmedKlines[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trs.push(tr);
  }
  const recent14 = trs.slice(-14);
  const sum = recent14.reduce((acc, v) => acc + v, 0);
  return sum / recent14.length;
}

interface SwingPoints {
  swingHighs: Array<{ index: number; price: number; time: number }>;
  swingLows: Array<{ index: number; price: number; time: number }>;
}

function findConfirmedSwingPoints(confirmed: Kline[]): SwingPoints {
  const swingHighs: Array<{ index: number; price: number; time: number }> = [];
  const swingLows: Array<{ index: number; price: number; time: number }> = [];

  // 5-bar or 3-bar pivot on confirmed candles (exclude last 2 bars so swing itself is confirmed)
  for (let i = 2; i < confirmed.length - 2; i++) {
    const c = confirmed[i];
    const isSwingHigh =
      c.high >= confirmed[i - 1].high &&
      c.high >= confirmed[i - 2].high &&
      c.high > confirmed[i + 1].high;
    const isSwingLow =
      c.low <= confirmed[i - 1].low &&
      c.low <= confirmed[i - 2].low &&
      c.low < confirmed[i + 1].low;

    if (isSwingHigh) {
      swingHighs.push({ index: i, price: c.high, time: c.openTime });
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: c.low, time: c.openTime });
    }
  }

  return { swingHighs, swingLows };
}

function detectTimeframeBias(klines: Kline[] | undefined): 'BULL' | 'BEAR' | 'NEUTRAL' | 'MISSING' {
  if (!klines || klines.length === 0) return 'MISSING';
  const confirmed = klines.filter((k) => k.isClosed);
  if (confirmed.length < 20) return 'MISSING';

  const recent = confirmed.slice(-20);
  const firstHalfAvg =
    recent.slice(0, 10).reduce((s, k) => s + k.close, 0) / 10;
  const secondHalfAvg =
    recent.slice(10).reduce((s, k) => s + k.close, 0) / 10;
  const lastClose = recent[recent.length - 1].close;
  const high10 = Math.max(...recent.slice(0, 15).map((k) => k.high));
  const low10 = Math.min(...recent.slice(0, 15).map((k) => k.low));

  if (lastClose > high10 || (secondHalfAvg > firstHalfAvg * 1.004 && lastClose > secondHalfAvg)) {
    return 'BULL';
  }
  if (lastClose < low10 || (secondHalfAvg < firstHalfAvg * 0.996 && lastClose < secondHalfAvg)) {
    return 'BEAR';
  }
  return 'NEUTRAL';
}

export function evaluateSmcStructure(input: EvaluateSmcInput): SmcAnalysisResult {
  const {
    symbol,
    primaryTimeframe,
    klinesByTimeframe,
    openInterest,
    historicalVolume,
    isLowLiquidity = false,
    extremeFunding = false,
    lowLiquidityHighVolatility = false,
    provenance: rawProvenance,
  } = input;

  const provenance = enforceProvenanceIntegrity(rawProvenance);

  const rawPrimaryKlines = klinesByTimeframe[primaryTimeframe] || [];
  const confirmedKlines = rawPrimaryKlines.filter((k) => k.isClosed);
  const unclosedKlineIgnoredCount = rawPrimaryKlines.length - confirmedKlines.length;

  const waitReasons: string[] = [];

  if (provenance.stale) {
    waitReasons.push('資料已過期 (Stale Data)：行情或 K 線時間戳超出有效範圍');
  }
  if (provenance.missingData.length > 0) {
    waitReasons.push(`基礎欄位缺失：${provenance.missingData.join(', ')}`);
  }
  if (openInterest === null || !Number.isFinite(openInterest)) {
    waitReasons.push('Open Interest (OI 未平倉量) 資料缺失，觸發 WAIT 安全閘門');
  }
  if (confirmedKlines.length < MIN_HISTORY_SAMPLES) {
    waitReasons.push(
      `已確認收盤 K 線數量不足 (${confirmedKlines.length}/${MIN_HISTORY_SAMPLES})，禁止使用未收盤 K 線推論結構`
    );
  }
  if (
    historicalVolume &&
    (historicalVolume.status === 'INSUFFICIENT_HISTORY' ||
      historicalVolume.sampleCount < MIN_HISTORY_SAMPLES)
  ) {
    waitReasons.push(
      `歷史成交量樣本不足 (${historicalVolume.sampleCount}/${MIN_HISTORY_SAMPLES}，status=INSUFFICIENT_HISTORY)，觸發 WAIT 安全閘門`
    );
  }
  if (
    historicalVolume &&
    (historicalVolume.status === 'BASELINE_UNSTABLE' ||
      historicalVolume.baselineUnstable)
  ) {
    waitReasons.push(
      '歷史成交量基線不穩定 (status=BASELINE_UNSTABLE：MAD 過小或接近 0)，觸發 WAIT 安全閘門'
    );
  }

  const atr14 = calculateConfirmedAtr14(confirmedKlines);
  const lastConfirmed =
    confirmedKlines.length > 0 ? confirmedKlines[confirmedKlines.length - 1] : null;
  const atrPercent =
    atr14 !== null && lastConfirmed && lastConfirmed.close > 0
      ? Number(((atr14 / lastConfirmed.close) * 100).toFixed(3))
      : null;

  // Default empty structure evidences
  let bosOrMss: SmcBosMssEvidence = {
    detected: false,
    type: 'NONE',
    brokenLevel: null,
    candleTime: null,
    description: '近期已確認 K 線未偵測到明確 BOS 或 MSS 結構突破',
  };

  let liquiditySweep: SmcLiquiditySweepEvidence = {
    detected: false,
    side: 'NONE',
    sweptLevel: null,
    candleTime: null,
    description: '近期已確認 K 線未偵測到高低點流動性掃單 (Liquidity Sweep)',
  };

  let displacement: SmcDisplacementEvidence = {
    detected: false,
    direction: 'NONE',
    bodyToAtrRatio: null,
    candleTime: null,
    description: '未出現實體大於 1.3 倍 ATR 之位移 K 線',
  };

  let fvg: SmcFvgEvidence = {
    detected: false,
    direction: 'NONE',
    top: null,
    bottom: null,
    mitigated: false,
    candleTime: null,
    description: '近期未形成未回補之公允價值缺口 (FVG)',
  };

  let orderBlock: SmcOrderBlockEvidence = {
    detected: false,
    direction: 'NONE',
    high: null,
    low: null,
    candleTime: null,
    description: '未確認有效機構訂單塊 (Order Block)',
  };

  if (confirmedKlines.length >= 25 && atr14 !== null && atr14 > 0) {
    const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmedKlines);
    const lookbackStart = Math.max(5, confirmedKlines.length - 12);

    // 1. Displacement detection in recent confirmed bars
    for (let i = confirmedKlines.length - 1; i >= lookbackStart; i--) {
      const c = confirmedKlines[i];
      const body = Math.abs(c.close - c.open);
      const range = Math.max(c.high - c.low, 1e-9);
      const bodyToAtr = body / atr14;
      const bodyToRange = body / range;

      if (bodyToAtr >= 1.3 && bodyToRange >= 0.6) {
        const dir = c.close > c.open ? 'BULL' : 'BEAR';
        displacement = {
          detected: true,
          direction: dir,
          bodyToAtrRatio: Number(bodyToAtr.toFixed(2)),
          candleTime: c.openTime,
          description: `已確認 ${dir === 'BULL' ? '多頭' : '空頭'}位移 K 線 (實體為 ${bodyToAtr.toFixed(2)}x ATR，實體佔比 ${(bodyToRange * 100).toFixed(0)}%)`,
        };

        // 2. Order Block: last opposing candle within 3 bars prior to displacement
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const prev = confirmedKlines[j];
          const isOpposing =
            (dir === 'BULL' && prev.close < prev.open) ||
            (dir === 'BEAR' && prev.close > prev.open);
          if (isOpposing) {
            orderBlock = {
              detected: true,
              direction: dir,
              high: prev.high,
              low: prev.low,
              candleTime: prev.openTime,
              description: `於位移前確認 ${dir === 'BULL' ? '多頭需求' : '空頭供給'} Order Block 區間 [${prev.low} – ${prev.high}]`,
            };
            break;
          }
        }
        break;
      }
    }

    // 3. BOS / MSS detection against recent swing highs/lows
    const priorHighs = swingHighs.filter((sh) => sh.index < confirmedKlines.length - 2);
    const priorLows = swingLows.filter((sl) => sl.index < confirmedKlines.length - 2);
    const refSwingHigh = priorHighs.length > 0 ? priorHighs[priorHighs.length - 1] : null;
    const refSwingLow = priorLows.length > 0 ? priorLows[priorLows.length - 1] : null;

    for (let i = confirmedKlines.length - 1; i >= lookbackStart; i--) {
      const c = confirmedKlines[i];
      if (refSwingHigh && i > refSwingHigh.index && c.close > refSwingHigh.price) {
        const isMss =
          refSwingLow !== null &&
          confirmedKlines[Math.max(0, refSwingHigh.index - 3)].close > refSwingLow.price;
        bosOrMss = {
          detected: true,
          type: isMss ? 'MSS_BULL' : 'BOS_BULL',
          brokenLevel: refSwingHigh.price,
          candleTime: c.openTime,
          description: `已確認收盤突破前波結構高點 ${refSwingHigh.price} (${isMss ? 'MSS 多頭結構轉換' : 'BOS 多頭結構延續'})`,
        };
        break;
      }
      if (refSwingLow && i > refSwingLow.index && c.close < refSwingLow.price) {
        const isMss =
          refSwingHigh !== null &&
          confirmedKlines[Math.max(0, refSwingLow.index - 3)].close < refSwingHigh.price;
        bosOrMss = {
          detected: true,
          type: isMss ? 'MSS_BEAR' : 'BOS_BEAR',
          brokenLevel: refSwingLow.price,
          candleTime: c.openTime,
          description: `已確認收盤跌破前波結構低點 ${refSwingLow.price} (${isMss ? 'MSS 空頭結構轉換' : 'BOS 空頭結構延續'})`,
        };
        break;
      }
    }

    // 4. Liquidity Sweep detection (wick pierces prior swing or 10-bar extreme, body closes inside)
    for (let i = confirmedKlines.length - 1; i >= lookbackStart; i--) {
      const c = confirmedKlines[i];
      const priorSlice = confirmedKlines.slice(Math.max(0, i - 12), i);
      if (priorSlice.length < 5) continue;

      const priorLow = Math.min(...priorSlice.map((k) => k.low));
      const priorHigh = Math.max(...priorSlice.map((k) => k.high));

      if (c.low < priorLow && Math.min(c.open, c.close) >= priorLow) {
        liquiditySweep = {
          detected: true,
          side: 'SELL_SIDE_SWEPT',
          sweptLevel: priorLow,
          candleTime: c.openTime,
          description: `下影線刺穿前波低點流動性池 (${priorLow}) 後實體收回其上方 (Sell-Side Liquidity Sweep)`,
        };
        break;
      }
      if (c.high > priorHigh && Math.max(c.open, c.close) <= priorHigh) {
        liquiditySweep = {
          detected: true,
          side: 'BUY_SIDE_SWEPT',
          sweptLevel: priorHigh,
          candleTime: c.openTime,
          description: `上影線刺穿前波高點流動性池 (${priorHigh}) 後實體收回其下方 (Buy-Side Liquidity Sweep)`,
        };
        break;
      }
    }

    // 5. Fair Value Gap (FVG) detection on confirmed 3-candle sequences
    for (let i = confirmedKlines.length - 1; i >= Math.max(2, lookbackStart); i--) {
      const c0 = confirmedKlines[i - 2];
      const c2 = confirmedKlines[i];

      // Bullish FVG: c0.high < c2.low
      if (c2.low > c0.high && c2.close > c0.close) {
        const gapBottom = c0.high;
        const gapTop = c2.low;
        const subsequent = confirmedKlines.slice(i + 1);
        const mitigated = subsequent.some((k) => k.low <= gapBottom);
        fvg = {
          detected: true,
          direction: 'BULL',
          top: gapTop,
          bottom: gapBottom,
          mitigated,
          candleTime: confirmedKlines[i - 1].openTime,
          description: `多頭 FVG 失衡區 [${gapBottom} – ${gapTop}] (${mitigated ? '已回補 Mitigated' : '尚未完全回補 Unmitigated'})`,
        };
        break;
      }

      // Bearish FVG: c0.low > c2.high
      if (c2.high < c0.low && c2.close < c0.close) {
        const gapTop = c0.low;
        const gapBottom = c2.high;
        const subsequent = confirmedKlines.slice(i + 1);
        const mitigated = subsequent.some((k) => k.high >= gapTop);
        fvg = {
          detected: true,
          direction: 'BEAR',
          top: gapTop,
          bottom: gapBottom,
          mitigated,
          candleTime: confirmedKlines[i - 1].openTime,
          description: `空頭 FVG 失衡區 [${gapBottom} – ${gapTop}] (${mitigated ? '已回補 Mitigated' : '尚未完全回補 Unmitigated'})`,
        };
        break;
      }
    }
  }

  // 6. Multi-Timeframe Alignment across 5m, 15m, 1h, 4h
  const tfList: Timeframe[] = ['5m', '15m', '1h', '4h'];
  const byTimeframe: Record<Timeframe, 'BULL' | 'BEAR' | 'NEUTRAL' | 'MISSING'> = {
    '5m': detectTimeframeBias(klinesByTimeframe['5m']),
    '15m': detectTimeframeBias(klinesByTimeframe['15m']),
    '1h': detectTimeframeBias(klinesByTimeframe['1h']),
    '4h': detectTimeframeBias(klinesByTimeframe['4h']),
  };

  // If only primary timeframe was provided (e.g., during single-timeframe backtest), evaluate alignment on available timeframes
  const availableBiases = tfList
    .map((tf) => byTimeframe[tf])
    .filter((b) => b !== 'MISSING');

  let mtfAlignment: SmcMtfAlignment;
  if (availableBiases.length === 0) {
    mtfAlignment = {
      aligned: false,
      dominantDirection: 'INSUFFICIENT',
      byTimeframe,
      description: '多週期 K 線資料不足，無法確認方向一致性',
    };
  } else {
    const bullCount = availableBiases.filter((b) => b === 'BULL').length;
    const bearCount = availableBiases.filter((b) => b === 'BEAR').length;

    if (bullCount > 0 && bearCount > 0) {
      mtfAlignment = {
        aligned: false,
        dominantDirection: 'CONFLICT',
        byTimeframe,
        description: `多週期結構方向分歧 (多頭週期: ${bullCount}, 空頭週期: ${bearCount})`,
      };
    } else if (bullCount >= Math.ceil(availableBiases.length * 0.6)) {
      mtfAlignment = {
        aligned: true,
        dominantDirection: 'BULL',
        byTimeframe,
        description: `多週期結構偏多一致 (${bullCount}/${availableBiases.length} 週期多頭共振)`,
      };
    } else if (bearCount >= Math.ceil(availableBiases.length * 0.6)) {
      mtfAlignment = {
        aligned: true,
        dominantDirection: 'BEAR',
        byTimeframe,
        description: `多週期結構偏空一致 (${bearCount}/${availableBiases.length} 週期空頭共振)`,
      };
    } else {
      mtfAlignment = {
        aligned: false,
        dominantDirection: 'INSUFFICIENT',
        byTimeframe,
        description: '多週期處於盤整中性，尚未形成單邊共振',
      };
    }
  }

  // Check for internal SMC conflicts and strict pass conditions
  const hasBullBos =
    bosOrMss.detected &&
    (bosOrMss.type === 'BOS_BULL' || bosOrMss.type === 'MSS_BULL');
  const hasBearBos =
    bosOrMss.detected &&
    (bosOrMss.type === 'BOS_BEAR' || bosOrMss.type === 'MSS_BEAR');

  const hasBullSweep =
    liquiditySweep.detected && liquiditySweep.side === 'SELL_SIDE_SWEPT';
  const hasBearSweep =
    liquiditySweep.detected && liquiditySweep.side === 'BUY_SIDE_SWEPT';

  const hasBullDisplacement =
    displacement.detected && displacement.direction === 'BULL';
  const hasBearDisplacement =
    displacement.detected && displacement.direction === 'BEAR';

  const hasBullFvgUnmitigated =
    fvg.detected && !fvg.mitigated && fvg.direction === 'BULL';
  const hasBearFvgUnmitigated =
    fvg.detected && !fvg.mitigated && fvg.direction === 'BEAR';

  const hasBullOb = orderBlock.detected && orderBlock.direction === 'BULL';
  const hasBearOb = orderBlock.detected && orderBlock.direction === 'BEAR';

  const hasBullFvgOrOb = hasBullFvgUnmitigated || hasBullOb;
  const hasBearFvgOrOb = hasBearFvgUnmitigated || hasBearOb;

  const hasBullMtf =
    mtfAlignment.aligned && mtfAlignment.dominantDirection === 'BULL';
  const hasBearMtf =
    mtfAlignment.aligned && mtfAlignment.dominantDirection === 'BEAR';

  const bullSignalCount =
    (hasBullBos ? 1 : 0) +
    (hasBullDisplacement ? 1 : 0) +
    (hasBullFvgUnmitigated ? 1 : 0) +
    (hasBullOb ? 1 : 0) +
    (hasBullSweep ? 1 : 0);

  const bearSignalCount =
    (hasBearBos ? 1 : 0) +
    (hasBearDisplacement ? 1 : 0) +
    (hasBearFvgUnmitigated ? 1 : 0) +
    (hasBearOb ? 1 : 0) +
    (hasBearSweep ? 1 : 0);

  if (
    confirmedKlines.length >= MIN_HISTORY_SAMPLES &&
    (atr14 === null || !Number.isFinite(atr14) || atr14 <= 0 || atrPercent === null)
  ) {
    waitReasons.push('ATR(14) 無法計算或為 0，無法建立有效波動率與風險基準，觸發 WAIT 安全閘門');
  }

  if (bullSignalCount > 0 && bearSignalCount > 0) {
    waitReasons.push(
      `同週期內部多空條件互相衝突 (多頭訊號 ${bullSignalCount} 項 vs 空頭訊號 ${bearSignalCount} 項)`
    );
  }

  if (mtfAlignment.dominantDirection === 'CONFLICT') {
    waitReasons.push(mtfAlignment.description);
  }

  if (
    (bullSignalCount >= 2 && mtfAlignment.dominantDirection === 'BEAR') ||
    (bearSignalCount >= 2 && mtfAlignment.dominantDirection === 'BULL')
  ) {
    waitReasons.push('主週期 SMC 結構與高週期趨勢方向相反，條件衝突觸發 WAIT');
  }

  const evidences: EvidenceItem[] = [
    {
      code: 'SMC_BOS_MSS',
      label: 'BOS / MSS 結構突破',
      passed: bosOrMss.detected,
      value: bosOrMss.detected ? `${bosOrMss.type} @ ${bosOrMss.brokenLevel}` : '未觸發',
      weight: bosOrMss.detected ? 25 : 0,
      detail: bosOrMss.description,
    },
    {
      code: 'SMC_LIQUIDITY_SWEEP',
      label: '流動性掃單 (Liquidity Sweep)',
      passed: liquiditySweep.detected,
      value: liquiditySweep.detected
        ? `${liquiditySweep.side} @ ${liquiditySweep.sweptLevel}`
        : '未觸發',
      weight: liquiditySweep.detected ? 20 : 0,
      detail: liquiditySweep.description,
    },
    {
      code: 'SMC_DISPLACEMENT',
      label: '位移 K 線 (Displacement)',
      passed: displacement.detected,
      value: displacement.detected
        ? `${displacement.direction} (${displacement.bodyToAtrRatio}x ATR)`
        : '未觸發',
      weight: displacement.detected ? 20 : 0,
      detail: displacement.description,
    },
    {
      code: 'SMC_FVG',
      label: '公允價值缺口 (FVG)',
      passed: fvg.detected && !fvg.mitigated,
      value: fvg.detected
        ? `${fvg.direction} [${fvg.bottom}–${fvg.top}]`
        : '未觸發',
      weight: fvg.detected && !fvg.mitigated ? 15 : 0,
      detail: fvg.description,
    },
    {
      code: 'SMC_ORDER_BLOCK',
      label: '機構訂單塊 (Order Block)',
      passed: orderBlock.detected,
      value: orderBlock.detected
        ? `${orderBlock.direction} [${orderBlock.low}–${orderBlock.high}]`
        : '未觸發',
      weight: orderBlock.detected ? 10 : 0,
      detail: orderBlock.description,
    },
    {
      code: 'SMC_MTF_ALIGNMENT',
      label: '多週期方向一致性',
      passed: mtfAlignment.aligned,
      value: mtfAlignment.dominantDirection,
      weight: mtfAlignment.aligned ? 10 : 0,
      detail: mtfAlignment.description,
    },
  ];

  if (isLowLiquidity) {
    evidences.push({
      code: 'SMC_LOW_LIQUIDITY_GATE',
      label: '低流動性限制策略',
      passed: false,
      value: '低流動性：不列入一般候選',
      weight: -18,
      detail: '低流動性：不列入一般候選（僅允許輸出 HIGH RISK、WATCH 或 WAIT）',
    });
  }

  const hasValidAtrAndRisk =
    atr14 !== null &&
    Number.isFinite(atr14) &&
    atr14 > 0 &&
    atrPercent !== null &&
    !isLowLiquidity &&
    !extremeFunding &&
    !lowLiquidityHighVolatility;

  const hasAllRequiredData =
    openInterest !== null &&
    Number.isFinite(openInterest) &&
    !provenance.stale &&
    provenance.missingData.length === 0 &&
    confirmedKlines.length >= MIN_HISTORY_SAMPLES &&
    (!historicalVolume ||
      (historicalVolume.status === 'READY' &&
        !historicalVolume.baselineUnstable &&
        historicalVolume.sampleCount >= MIN_HISTORY_SAMPLES));

  // Final deterministic state resolution:
  // LONG CANDIDATE / SHORT CANDIDATE requires ALL necessary conditions simultaneously:
  // 1. BOS or MSS
  // 2. Liquidity Sweep
  // 3. Displacement
  // 4. Unmitigated FVG or Order Block
  // 5. Multi-Timeframe Alignment
  // 6. Valid ATR & Risk conditions
  // 7. >= 30 Confirmed closed K-lines (isClosed === true)
  // 8. All required data present (OI, provenance, historical volume READY)
  // 9. Zero WAIT Gate blocking reasons
  let actionState: SmcActionState = 'WAIT';

  if (waitReasons.length > 0) {
    actionState = 'WAIT';
  } else if (extremeFunding || lowLiquidityHighVolatility) {
    actionState = 'HIGH RISK';
    if (extremeFunding) {
      waitReasons.push(
        '高風險攔截：資金費率極端 (Funding 高風險，禁止列入一般候選)'
      );
    }
    if (lowLiquidityHighVolatility) {
      waitReasons.push(
        '高風險攔截：低流動性高波動異常 (禁止列入一般候選)'
      );
    }
  } else if (isLowLiquidity) {
    actionState = bullSignalCount >= 1 || bearSignalCount >= 1 ? 'WATCH' : 'WAIT';
    if (actionState === 'WAIT') {
      waitReasons.push('低流動性：不列入一般候選，且結構條件不足以列入觀察');
    } else {
      waitReasons.push('低流動性：不列入一般候選（僅允許列入 WATCH 觀察，不可升級為 CANDIDATE）');
    }
  } else if (
    hasAllRequiredData &&
    hasValidAtrAndRisk &&
    hasBullBos &&
    hasBullSweep &&
    hasBullDisplacement &&
    hasBullFvgOrOb &&
    hasBullMtf
  ) {
    actionState = 'LONG CANDIDATE';
  } else if (
    hasAllRequiredData &&
    hasValidAtrAndRisk &&
    hasBearBos &&
    hasBearSweep &&
    hasBearDisplacement &&
    hasBearFvgOrOb &&
    hasBearMtf
  ) {
    actionState = 'SHORT CANDIDATE';
  } else if (bullSignalCount >= 1 || bearSignalCount >= 1) {
    actionState = 'WATCH';
    if (bullSignalCount >= bearSignalCount) {
      const missingBull: string[] = [];
      if (!hasBullBos) missingBull.push('BOS/MSS 多頭結構突破');
      if (!hasBullSweep) missingBull.push('Sell-Side Liquidity Sweep');
      if (!hasBullDisplacement) missingBull.push('多頭 Displacement 位移 K 線');
      if (!hasBullFvgOrOb) missingBull.push('多頭未回補 FVG 或 Order Block');
      if (!hasBullMtf) missingBull.push('多週期多頭一致性 (MTF Alignment)');
      waitReasons.push(
        `已偵測部分多頭結構證據，但尚未完成全部 SMC 必要確認條件（缺少：${missingBull.join('、')}），維持 WATCH`
      );
    } else {
      const missingBear: string[] = [];
      if (!hasBearBos) missingBear.push('BOS/MSS 空頭結構突破');
      if (!hasBearSweep) missingBear.push('Buy-Side Liquidity Sweep');
      if (!hasBearDisplacement) missingBear.push('空頭 Displacement 位移 K 線');
      if (!hasBearFvgOrOb) missingBear.push('空頭未回補 FVG 或 Order Block');
      if (!hasBearMtf) missingBear.push('多週期空頭一致性 (MTF Alignment)');
      waitReasons.push(
        `已偵測部分空頭結構證據，但尚未完成全部 SMC 必要確認條件（缺少：${missingBear.join('、')}），維持 WATCH`
      );
    }
  } else {
    actionState = 'WAIT';
    waitReasons.push('目前尚無足夠 SMC/ICT 結構證據形成觀察候選（已收盤 K 線 isClosed=true 不代表 SMC 訊號確認）');
  }

  const hasAnyKlinesLoaded = tfList.some(
    (tf) => (klinesByTimeframe[tf]?.length ?? 0) > 0
  );
  const hasAllFourMultiTimeframesLoaded = tfList.every(
    (tf) => (klinesByTimeframe[tf]?.length ?? 0) > 0
  );

  let smcEvaluationStatus: SmcEvaluationStatus = 'EVALUATED';
  if (
    !hasAnyKlinesLoaded ||
    (input.requireFullMultiTimeframe && !hasAllFourMultiTimeframesLoaded)
  ) {
    smcEvaluationStatus = 'PENDING';
    actionState = 'PENDING';
    waitReasons.length = 0;
  }

  const bosMssPassed = bosOrMss.detected;
  const liquiditySweepPassed = liquiditySweep.detected;
  const displacementPassed = displacement.detected;
  const fvgOrObPassed = (fvg.detected && !fvg.mitigated) || orderBlock.detected;
  const mtfAlignmentPassed = mtfAlignment.aligned;
  const atrPassed =
    atr14 !== null &&
    Number.isFinite(atr14) &&
    atr14 > 0 &&
    atrPercent !== null;
  const historyPassed =
    confirmedKlines.length >= MIN_HISTORY_SAMPLES &&
    (!historicalVolume ||
      (historicalVolume.status === 'READY' &&
        !historicalVolume.baselineUnstable &&
        historicalVolume.sampleCount >= MIN_HISTORY_SAMPLES));
  const oiPassed = openInterest !== null && Number.isFinite(openInterest);
  const fundingPassed = !provenance.missingData.some((m) =>
    m.toLowerCase().includes('funding')
  );
  const oiFundingPassed = oiPassed && fundingPassed;
  const dataFreshnessPassed =
    historyPassed &&
    !provenance.stale &&
    !provenance.fallback &&
    provenance.missingData.filter(
      (m) => m !== 'BID_ASK_SPREAD' && m !== 'HISTORICAL_VOLUME_BASELINE'
    ).length === 0;
  const liquiditySafetyPassed = !isLowLiquidity;
  const riskSafetyPassed = !extremeFunding && !lowLiquidityHighVolatility;

  const preferBull = bullSignalCount >= bearSignalCount;
  const intendedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
    actionState === 'LONG CANDIDATE'
      ? 'LONG'
      : actionState === 'SHORT CANDIDATE'
        ? 'SHORT'
        : bullSignalCount > bearSignalCount
          ? 'LONG'
          : bearSignalCount > bullSignalCount
            ? 'SHORT'
            : mtfAlignment.dominantDirection === 'BULL'
              ? 'LONG'
              : mtfAlignment.dominantDirection === 'BEAR'
                ? 'SHORT'
                : 'NEUTRAL';

  const missingGates: string[] = [];
  if (
    smcEvaluationStatus === 'EVALUATED' &&
    actionState !== 'LONG CANDIDATE' &&
    actionState !== 'SHORT CANDIDATE'
  ) {
    const dirBosPassed = preferBull ? hasBullBos : hasBearBos;
    const dirSweepPassed = preferBull ? hasBullSweep : hasBearSweep;
    const dirDispPassed = preferBull ? hasBullDisplacement : hasBearDisplacement;
    const dirFvgObPassed = preferBull ? hasBullFvgOrOb : hasBearFvgOrOb;
    const dirMtfPassed = preferBull ? hasBullMtf : hasBearMtf;

    if (!dataFreshnessPassed) missingGates.push('DATA_FRESHNESS');
    if (!atrPassed) missingGates.push('ATR_VALID');
    if (!oiFundingPassed) missingGates.push('OI_FUNDING');
    if (!liquiditySafetyPassed) missingGates.push('LIQUIDITY_SAFETY');
    if (!riskSafetyPassed) missingGates.push('RISK_SAFETY');
    if (bullSignalCount > 0 && bearSignalCount > 0) {
      missingGates.push('INTERNAL_DIRECTION_CONFLICT');
    }
    if (!dirBosPassed) missingGates.push('BOS_MSS');
    if (!dirSweepPassed) missingGates.push('LIQUIDITY_SWEEP');
    if (!dirDispPassed) missingGates.push('DISPLACEMENT');
    if (!dirFvgObPassed) missingGates.push('FVG_OR_ORDER_BLOCK');
    if (!dirMtfPassed) missingGates.push('MTF_ALIGNMENT');
  }

  const nearMissStatus: NearMissStatus =
    smcEvaluationStatus !== 'EVALUATED' ||
    actionState === 'LONG CANDIDATE' ||
    actionState === 'SHORT CANDIDATE'
      ? 'NOT_NEAR_CANDIDATE'
      : missingGates.length === 1
        ? 'NEAR_MISS_ONE_GATE'
        : missingGates.length === 2
          ? 'NEAR_MISS_TWO_GATES'
          : 'NOT_NEAR_CANDIDATE';

  const gateEvaluation: SymbolSmcGateEvaluation = {
    bosMssPassed,
    liquiditySweepPassed,
    displacementPassed,
    fvgOrObPassed,
    mtfAlignmentPassed,
    atrPassed,
    historyPassed,
    oiPassed,
    fundingPassed,
    oiFundingPassed,
    dataFreshnessPassed,
    liquiditySafetyPassed,
    riskSafetyPassed,
    waitReasons: [...waitReasons],
    missingGates,
    lastBlockingGate:
      missingGates.length > 0 ? missingGates[missingGates.length - 1] : null,
    nearMissStatus,
    intendedDirection,
  };

  return {
    symbol,
    primaryTimeframe,
    ruleVersion: SMC_RULE_VERSION,
    smcEvaluationStatus,
    actionState,
    confirmedKlineCount: confirmedKlines.length,
    unclosedKlineIgnoredCount,
    atr14: atr14 !== null ? Number(atr14.toPrecision(5)) : null,
    atrPercent,
    bosOrMss,
    liquiditySweep,
    displacement,
    fvg,
    orderBlock,
    mtfAlignment,
    waitReasons,
    evidences,
    provenance,
    gateEvaluation,
    nearMissStatus,
    missingGates,
    intendedDirection,
  };
}

export function deriveSymbolSmcGateEvaluationFromAnalysis(
  smc: SmcAnalysisResult | null | undefined,
  overrides?: {
    actionState?: SmcActionState;
    waitReasons?: string[];
    historyPassed?: boolean;
    liquiditySafetyPassed?: boolean;
    riskSafetyPassed?: boolean;
    fundingPassed?: boolean;
    dataFreshnessPassed?: boolean;
  }
): SymbolSmcGateEvaluation | null {
  if (!smc || smc.smcEvaluationStatus === 'PENDING') {
    return null;
  }
  const effectiveActionState = overrides?.actionState ?? smc.actionState;
  const effectiveWaitReasons = overrides?.waitReasons ?? smc.waitReasons ?? [];

  const bosOrMss = smc.bosOrMss;
  const liquiditySweep = smc.liquiditySweep;
  const displacement = smc.displacement;
  const fvg = smc.fvg;
  const orderBlock = smc.orderBlock;
  const mtfAlignment = smc.mtfAlignment;

  const hasBullBos =
    Boolean(bosOrMss?.detected) &&
    (bosOrMss.type === 'BOS_BULL' || bosOrMss.type === 'MSS_BULL');
  const hasBearBos =
    Boolean(bosOrMss?.detected) &&
    (bosOrMss.type === 'BOS_BEAR' || bosOrMss.type === 'MSS_BEAR');
  const hasBullSweep =
    Boolean(liquiditySweep?.detected) &&
    liquiditySweep.side === 'SELL_SIDE_SWEPT';
  const hasBearSweep =
    Boolean(liquiditySweep?.detected) &&
    liquiditySweep.side === 'BUY_SIDE_SWEPT';
  const hasBullDisplacement =
    Boolean(displacement?.detected) && displacement.direction === 'BULL';
  const hasBearDisplacement =
    Boolean(displacement?.detected) && displacement.direction === 'BEAR';
  const hasBullFvgUnmitigated =
    Boolean(fvg?.detected) && !fvg.mitigated && fvg.direction === 'BULL';
  const hasBearFvgUnmitigated =
    Boolean(fvg?.detected) && !fvg.mitigated && fvg.direction === 'BEAR';
  const hasBullOb =
    Boolean(orderBlock?.detected) && orderBlock.direction === 'BULL';
  const hasBearOb =
    Boolean(orderBlock?.detected) && orderBlock.direction === 'BEAR';
  const hasBullFvgOrOb = hasBullFvgUnmitigated || hasBullOb;
  const hasBearFvgOrOb = hasBearFvgUnmitigated || hasBearOb;
  const hasBullMtf =
    Boolean(mtfAlignment?.aligned) &&
    mtfAlignment.dominantDirection === 'BULL';
  const hasBearMtf =
    Boolean(mtfAlignment?.aligned) &&
    mtfAlignment.dominantDirection === 'BEAR';

  const bullSignalCount =
    (hasBullBos ? 1 : 0) +
    (hasBullDisplacement ? 1 : 0) +
    (hasBullFvgUnmitigated ? 1 : 0) +
    (hasBullOb ? 1 : 0) +
    (hasBullSweep ? 1 : 0);
  const bearSignalCount =
    (hasBearBos ? 1 : 0) +
    (hasBearDisplacement ? 1 : 0) +
    (hasBearFvgUnmitigated ? 1 : 0) +
    (hasBearOb ? 1 : 0) +
    (hasBearSweep ? 1 : 0);

  const bosMssPassed =
    smc.gateEvaluation?.bosMssPassed ?? Boolean(bosOrMss?.detected);
  const liquiditySweepPassed =
    smc.gateEvaluation?.liquiditySweepPassed ??
    Boolean(liquiditySweep?.detected);
  const displacementPassed =
    smc.gateEvaluation?.displacementPassed ?? Boolean(displacement?.detected);
  const fvgOrObPassed =
    smc.gateEvaluation?.fvgOrObPassed ??
    Boolean((fvg?.detected && !fvg.mitigated) || orderBlock?.detected);
  const mtfAlignmentPassed =
    smc.gateEvaluation?.mtfAlignmentPassed ?? Boolean(mtfAlignment?.aligned);
  const atrPassed =
    smc.gateEvaluation?.atrPassed ??
    Boolean(
      smc.atr14 !== null &&
        Number.isFinite(smc.atr14) &&
        smc.atr14 > 0 &&
        smc.atrPercent !== null
    );
  const historyPassed =
    overrides?.historyPassed ??
    smc.gateEvaluation?.historyPassed ??
    (smc.confirmedKlineCount >= 30 &&
      !effectiveWaitReasons.some(
        (r) =>
          r.includes('歷史成交量') ||
          r.includes('INSUFFICIENT_HISTORY') ||
          r.includes('BASELINE_UNSTABLE')
      ));
  const oiPassed =
    smc.gateEvaluation?.oiPassed ??
    !effectiveWaitReasons.some((r) => r.includes('Open Interest'));
  const fundingPassed =
    overrides?.fundingPassed ??
    smc.gateEvaluation?.fundingPassed ??
    !effectiveWaitReasons.some((r) => r.includes('資金費率'));
  const oiFundingPassed = oiPassed && fundingPassed;
  const dataFreshnessPassed =
    overrides?.dataFreshnessPassed ??
    smc.gateEvaluation?.dataFreshnessPassed ??
    (historyPassed &&
      !smc.provenance?.stale &&
      !smc.provenance?.fallback &&
      (smc.provenance?.missingData ?? []).filter(
        (m) => m !== 'BID_ASK_SPREAD' && m !== 'HISTORICAL_VOLUME_BASELINE'
      ).length === 0);
  const liquiditySafetyPassed =
    overrides?.liquiditySafetyPassed ??
    smc.gateEvaluation?.liquiditySafetyPassed ??
    (!smc.evidences?.some((e) => e.code === 'SMC_LOW_LIQUIDITY_GATE') &&
      !effectiveWaitReasons.some(
        (r) => r.includes('低流動性') || r.includes('盤口價差')
      ));
  const riskSafetyPassed =
    overrides?.riskSafetyPassed ??
    smc.gateEvaluation?.riskSafetyPassed ??
    (effectiveActionState !== 'HIGH RISK' &&
      !effectiveWaitReasons.some((r) => r.includes('高風險攔截')));

  const preferBull = bullSignalCount >= bearSignalCount;
  const intendedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
    effectiveActionState === 'LONG CANDIDATE'
      ? 'LONG'
      : effectiveActionState === 'SHORT CANDIDATE'
        ? 'SHORT'
        : bullSignalCount > bearSignalCount
          ? 'LONG'
          : bearSignalCount > bullSignalCount
            ? 'SHORT'
            : mtfAlignment?.dominantDirection === 'BULL'
              ? 'LONG'
              : mtfAlignment?.dominantDirection === 'BEAR'
                ? 'SHORT'
                : 'NEUTRAL';

  const missingGates: string[] = [];
  if (
    effectiveActionState !== 'LONG CANDIDATE' &&
    effectiveActionState !== 'SHORT CANDIDATE'
  ) {
    const dirBosPassed = preferBull ? hasBullBos : hasBearBos;
    const dirSweepPassed = preferBull ? hasBullSweep : hasBearSweep;
    const dirDispPassed = preferBull ? hasBullDisplacement : hasBearDisplacement;
    const dirFvgObPassed = preferBull ? hasBullFvgOrOb : hasBearFvgOrOb;
    const dirMtfPassed = preferBull ? hasBullMtf : hasBearMtf;

    if (!dataFreshnessPassed) missingGates.push('DATA_FRESHNESS');
    if (!atrPassed) missingGates.push('ATR_VALID');
    if (!oiFundingPassed) missingGates.push('OI_FUNDING');
    if (!liquiditySafetyPassed) missingGates.push('LIQUIDITY_SAFETY');
    if (!riskSafetyPassed) missingGates.push('RISK_SAFETY');
    if (bullSignalCount > 0 && bearSignalCount > 0) {
      missingGates.push('INTERNAL_DIRECTION_CONFLICT');
    }
    if (!dirBosPassed) missingGates.push('BOS_MSS');
    if (!dirSweepPassed) missingGates.push('LIQUIDITY_SWEEP');
    if (!dirDispPassed) missingGates.push('DISPLACEMENT');
    if (!dirFvgObPassed) missingGates.push('FVG_OR_ORDER_BLOCK');
    if (!dirMtfPassed) missingGates.push('MTF_ALIGNMENT');
  }

  const nearMissStatus: NearMissStatus =
    effectiveActionState === 'LONG CANDIDATE' ||
    effectiveActionState === 'SHORT CANDIDATE'
      ? 'NOT_NEAR_CANDIDATE'
      : missingGates.length === 1
        ? 'NEAR_MISS_ONE_GATE'
        : missingGates.length === 2
          ? 'NEAR_MISS_TWO_GATES'
          : 'NOT_NEAR_CANDIDATE';

  return {
    bosMssPassed,
    liquiditySweepPassed,
    displacementPassed,
    fvgOrObPassed,
    mtfAlignmentPassed,
    atrPassed,
    historyPassed,
    oiPassed,
    fundingPassed,
    oiFundingPassed,
    dataFreshnessPassed,
    liquiditySafetyPassed,
    riskSafetyPassed,
    waitReasons: [...effectiveWaitReasons],
    missingGates,
    lastBlockingGate:
      missingGates.length > 0 ? missingGates[missingGates.length - 1] : null,
    nearMissStatus,
    intendedDirection,
  };
}

export const CANONICAL_GATE_LABELS: Record<string, string> = {
  BOS_MSS: 'BOS / MSS 結構突破',
  LIQUIDITY_SWEEP: 'Liquidity Sweep 流動性清掃',
  DISPLACEMENT: 'Displacement 位移 K 線',
  FVG_OR_ORDER_BLOCK: 'FVG / Order Block 機構區間',
  FVG_OR_OB: 'FVG / Order Block 機構區間',
  MTF_ALIGNMENT: 'MTF Alignment 多週期一致性',
  ATR_VALID: 'ATR(14) 有效性',
  ATR_14: 'ATR(14) 有效性',
  OI_FUNDING: 'OI / Funding 衍生品數據',
  DATA_FRESHNESS: '資料新鮮度與 15m 歷史基線',
  HISTORY_BASELINE: '15m 歷史成交量基線',
  LIQUIDITY_SAFETY: '流動性與盤口價差安全門檻',
  RISK_SAFETY: '資金費率與波動風險安全門檻',
  INTERNAL_DIRECTION_CONFLICT: '同週期多空結構不衝突',
  ALL_GATES: '完整 SMC/ICT 全部門檻',
};

export interface EvaluatedGateDiagnosticItemInput {
  symbol: string;
  smcActionState: SmcActionState;
  marketRadarCategory: MarketRadarCategory;
  gateEvaluation: SymbolSmcGateEvaluation;
  excludedFromDenominator?: boolean;
  exclusionReason?: string;
  score?: number;
  detectionLatencyMs?: number | null;
  candidateDetectionLatencyMs?: number | null;
  evaluationLatencyMs?: number | null;
  nextBarRemainingMs?: number | null;
  nextBarOpenTime?: number | null;
  queueWaitMs?: number | null;
  smcEvaluationLatencyMs?: number | null;
  entryWindowDelayMs?: number | null;
  entryWindowMissed?: boolean | null;
  dataFreshnessSeconds?: number | null;
  stale?: boolean;
  isDemo?: boolean;
  isFastLane?: boolean;
}

export interface GateDiagnosticsBuildOptions {
  totalUniverseSymbols?: number;
  cycleId?: string;
  snapshotAt?: string;
  statsVersion?: number;
  aggregationScope?: FunnelAggregationScope;
  excludedSymbols?: string[];
  excludedReasons?: Record<string, number>;
  excludedSymbolDetails?: Array<{ symbol: string; reason: string }>;
  strictProductionOutcome?: {
    entryWindowMissedCount?: number;
    paperOpenedCount?: number;
    paperClosedCount?: number;
    winRate?: number | null;
    averageR?: number | null;
    profitFactor?: number | null;
    maxDrawdownR?: number | null;
    expectancyR?: number | null;
  };
}

function buildGateStatisticForSubset(
  items: EvaluatedGateDiagnosticItemInput[],
  totalUniverseCount: number,
  statisticScope: GateStatisticScope,
  meta?: {
    cycleId?: string;
    snapshotAt?: string;
    statsVersion?: number;
    aggregationScope?: FunnelAggregationScope;
    excludedSymbols?: string[];
    excludedReasons?: Record<string, number>;
  }
): Record<string, ScopedGateStatisticItem> {
  const evaluatedDenominator = items.length;
  const excludedCount = Math.max(0, totalUniverseCount - evaluatedDenominator);

  const checkDefs: Array<{
    gate: string;
    label: string;
    predicate: (item: EvaluatedGateDiagnosticItemInput) => boolean;
  }> = [
    {
      gate: 'BOS_MSS',
      label: CANONICAL_GATE_LABELS.BOS_MSS,
      predicate: (i) => i.gateEvaluation.bosMssPassed,
    },
    {
      gate: 'LIQUIDITY_SWEEP',
      label: CANONICAL_GATE_LABELS.LIQUIDITY_SWEEP,
      predicate: (i) => i.gateEvaluation.liquiditySweepPassed,
    },
    {
      gate: 'DISPLACEMENT',
      label: CANONICAL_GATE_LABELS.DISPLACEMENT,
      predicate: (i) => i.gateEvaluation.displacementPassed,
    },
    {
      gate: 'FVG_OR_ORDER_BLOCK',
      label: CANONICAL_GATE_LABELS.FVG_OR_ORDER_BLOCK,
      predicate: (i) => i.gateEvaluation.fvgOrObPassed,
    },
    {
      gate: 'MTF_ALIGNMENT',
      label: CANONICAL_GATE_LABELS.MTF_ALIGNMENT,
      predicate: (i) => i.gateEvaluation.mtfAlignmentPassed,
    },
    {
      gate: 'ATR_VALID',
      label: CANONICAL_GATE_LABELS.ATR_VALID,
      predicate: (i) => i.gateEvaluation.atrPassed,
    },
    {
      gate: 'OI_FUNDING',
      label: CANONICAL_GATE_LABELS.OI_FUNDING,
      predicate: (i) =>
        i.gateEvaluation.oiFundingPassed ??
        (i.gateEvaluation.oiPassed && i.gateEvaluation.fundingPassed),
    },
    {
      gate: 'DATA_FRESHNESS',
      label: CANONICAL_GATE_LABELS.DATA_FRESHNESS,
      predicate: (i) =>
        i.gateEvaluation.dataFreshnessPassed ?? i.gateEvaluation.historyPassed,
    },
    {
      gate: 'LIQUIDITY_SAFETY',
      label: CANONICAL_GATE_LABELS.LIQUIDITY_SAFETY,
      predicate: (i) => i.gateEvaluation.liquiditySafetyPassed,
    },
    {
      gate: 'RISK_SAFETY',
      label: CANONICAL_GATE_LABELS.RISK_SAFETY,
      predicate: (i) => i.gateEvaluation.riskSafetyPassed,
    },
    {
      gate: 'ALL_GATES',
      label: CANONICAL_GATE_LABELS.ALL_GATES,
      predicate: (i) =>
        i.smcActionState === 'LONG CANDIDATE' ||
        i.smcActionState === 'SHORT CANDIDATE' ||
        i.gateEvaluation.missingGates.length === 0,
    },
  ];

  const out: Record<string, ScopedGateStatisticItem> = {};
  for (const def of checkDefs) {
    let passCount = 0;
    for (const item of items) {
      if (def.predicate(item)) passCount++;
    }
    const failCount = Math.max(0, evaluatedDenominator - passCount);
    const passRate =
      evaluatedDenominator > 0
        ? Number(((passCount / evaluatedDenominator) * 100).toFixed(2))
        : 0;
    const failureRate =
      evaluatedDenominator > 0
        ? Number(((failCount / evaluatedDenominator) * 100).toFixed(2))
        : 0;
    out[def.gate] = {
      gate: def.gate,
      label: def.label,
      passCount,
      failCount,
      evaluationUniverseSize: totalUniverseCount,
      evaluatedDenominator,
      excludedCount,
      excludedSymbols: meta?.excludedSymbols,
      excludedReasons: meta?.excludedReasons,
      cycleId: meta?.cycleId,
      snapshotAt: meta?.snapshotAt,
      statsVersion: meta?.statsVersion,
      aggregationScope: meta?.aggregationScope ?? 'CURRENT_CYCLE',
      passRate,
      failureRate,
      statisticScope,
    };
  }

  return out;
}

export function buildScopedGateStatisticsSummary(
  rawItems: EvaluatedGateDiagnosticItemInput[],
  totalUniverseSymbolsOrOptions?: number | GateDiagnosticsBuildOptions
): ScopedGateStatisticsSummary {
  const opts: GateDiagnosticsBuildOptions =
    typeof totalUniverseSymbolsOrOptions === 'number'
      ? { totalUniverseSymbols: totalUniverseSymbolsOrOptions }
      : (totalUniverseSymbolsOrOptions ?? {});

  const itemExcludedSymbols: string[] = [];
  const itemExcludedReasons: Record<string, number> = {};
  const evaluatedItems: EvaluatedGateDiagnosticItemInput[] = [];

  for (const item of rawItems) {
    if (item.excludedFromDenominator || !item.gateEvaluation) {
      itemExcludedSymbols.push(item.symbol);
      const reason =
        item.exclusionReason ?? 'MISSING_SMC_ANALYSIS_OR_PENDING_REFRESH';
      itemExcludedReasons[reason] = (itemExcludedReasons[reason] ?? 0) + 1;
    } else {
      evaluatedItems.push(item);
    }
  }

  const mergedExcludedSymbols = Array.from(
    new Set([...(opts.excludedSymbols ?? []), ...itemExcludedSymbols])
  );
  const mergedExcludedReasons: Record<string, number> = {
    ...(opts.excludedReasons ?? {}),
  };
  for (const [r, cnt] of Object.entries(itemExcludedReasons)) {
    if (opts.excludedReasons?.[r] === undefined) {
      mergedExcludedReasons[r] = (mergedExcludedReasons[r] ?? 0) + cnt;
    }
  }

  const totalUniverseCount = Math.max(
    rawItems.length,
    evaluatedItems.length + mergedExcludedSymbols.length,
    opts.totalUniverseSymbols ?? rawItems.length
  );
  const allEvaluatedExcludedCount = Math.max(
    0,
    totalUniverseCount - evaluatedItems.length
  );

  // If totalUniverseCount > evaluatedItems.length and we have unaccounted gap, record explicit reason
  const accountedReasonTotal = Object.values(mergedExcludedReasons).reduce(
    (sum, n) => sum + n,
    0
  );
  if (allEvaluatedExcludedCount > accountedReasonTotal) {
    const diff = allEvaluatedExcludedCount - accountedReasonTotal;
    mergedExcludedReasons.PENDING_OR_REQUEUED_REFRESH_BATCH =
      (mergedExcludedReasons.PENDING_OR_REQUEUED_REFRESH_BATCH ?? 0) + diff;
  }

  const nearMissItems = evaluatedItems.filter((item) => {
    const isFormalCandidate =
      item.smcActionState === 'LONG CANDIDATE' ||
      item.smcActionState === 'SHORT CANDIDATE' ||
      item.gateEvaluation.missingGates.length === 0;
    if (isFormalCandidate) return false;
    return (
      item.gateEvaluation.missingGates.length === 1 ||
      item.gateEvaluation.missingGates.length === 2
    );
  });

  const candidateEligibleItems = evaluatedItems.filter(
    (item) =>
      item.gateEvaluation.liquiditySafetyPassed &&
      item.gateEvaluation.riskSafetyPassed &&
      (item.gateEvaluation.dataFreshnessPassed ??
        item.gateEvaluation.historyPassed) &&
      (item.gateEvaluation.oiFundingPassed ??
        (item.gateEvaluation.oiPassed && item.gateEvaluation.fundingPassed)) &&
      item.gateEvaluation.atrPassed
  );

  const meta = {
    cycleId: opts.cycleId,
    snapshotAt: opts.snapshotAt,
    statsVersion: opts.statsVersion,
    aggregationScope: opts.aggregationScope ?? ('CURRENT_CYCLE' as const),
    excludedSymbols: mergedExcludedSymbols,
    excludedReasons: mergedExcludedReasons,
  };

  const allEvaluated = buildGateStatisticForSubset(
    evaluatedItems,
    totalUniverseCount,
    'ALL_EVALUATED',
    meta
  );
  const nearMissOnly = buildGateStatisticForSubset(
    nearMissItems,
    totalUniverseCount,
    'NEAR_MISS_ONLY',
    {
      ...meta,
      excludedReasons: {
        ...mergedExcludedReasons,
        NOT_NEAR_CANDIDATE_OR_FORMAL_CANDIDATE: Math.max(
          0,
          evaluatedItems.length - nearMissItems.length
        ),
      },
    }
  );
  const candidateEligibleOnly = buildGateStatisticForSubset(
    candidateEligibleItems,
    totalUniverseCount,
    'CANDIDATE_ELIGIBLE_ONLY',
    {
      ...meta,
      excludedReasons: {
        ...mergedExcludedReasons,
        FAILED_PRE_ELIGIBILITY_SAFETY_OR_DATA: Math.max(
          0,
          evaluatedItems.length - candidateEligibleItems.length
        ),
      },
    }
  );

  return {
    cycleId: opts.cycleId,
    snapshotAt: opts.snapshotAt,
    statsVersion: opts.statsVersion,
    aggregationScope: opts.aggregationScope ?? 'CURRENT_CYCLE',
    evaluationUniverseSize: totalUniverseCount,
    totalUniverseCount,
    evaluatedDenominator: evaluatedItems.length,
    allEvaluatedDenominator: evaluatedItems.length,
    excludedCount: allEvaluatedExcludedCount,
    allEvaluatedExcludedCount,
    excludedSymbols: mergedExcludedSymbols,
    excludedReasons: mergedExcludedReasons,
    nearMissDenominator: nearMissItems.length,
    nearMissExcludedCount: Math.max(
      0,
      totalUniverseCount - nearMissItems.length
    ),
    candidateEligibleDenominator: candidateEligibleItems.length,
    candidateEligibleExcludedCount: Math.max(
      0,
      totalUniverseCount - candidateEligibleItems.length
    ),
    allEvaluated,
    nearMissOnly,
    candidateEligibleOnly,
    scopeClarificationNotice:
      'ALL_EVALUATED 為全市場已評估標的分母；NEAR_MISS_ONLY 僅統計差 1～2 個條件之接近候選子集合；CANDIDATE_ELIGIBLE_ONLY 僅統計已通過流動性、風險與資料完整性之合格母體。禁止將子集合阻擋數誤標為全市場 Gate 通過率。',
  };
}

export function buildObservationShadowComparisonSummary(
  evaluatedItems: EvaluatedGateDiagnosticItemInput[],
  scopedStats: ScopedGateStatisticsSummary,
  cycleId?: string,
  strictOutcome?: GateDiagnosticsBuildOptions['strictProductionOutcome']
): ObservationShadowComparisonSummary {
  const evaluatedCount = evaluatedItems.length;
  const strictLongSymbols: string[] = [];
  const strictShortSymbols: string[] = [];
  let strictMissedFromItems = 0;
  const nearMiss1Symbols: EvaluatedGateDiagnosticItemInput[] = [];
  const nearMiss2Symbols: EvaluatedGateDiagnosticItemInput[] = [];

  const singleGateUnlockMap = new Map<string, string[]>();
  const twoGateComboUnlockMap = new Map<
    string,
    { gates: string[]; symbols: string[] }
  >();

  for (const item of evaluatedItems) {
    const g = item.gateEvaluation;
    const isFormalCandidate =
      item.smcActionState === 'LONG CANDIDATE' ||
      item.smcActionState === 'SHORT CANDIDATE' ||
      g.missingGates.length === 0;

    if (isFormalCandidate) {
      if (item.entryWindowMissed === true) {
        strictMissedFromItems++;
      }
      if (
        item.smcActionState === 'SHORT CANDIDATE' ||
        g.intendedDirection === 'SHORT'
      ) {
        strictShortSymbols.push(item.symbol);
      } else {
        strictLongSymbols.push(item.symbol);
      }
      continue;
    }

    if (g.missingGates.length === 1) {
      nearMiss1Symbols.push(item);
      const missingGate = g.missingGates[0];
      const list = singleGateUnlockMap.get(missingGate) ?? [];
      list.push(item.symbol);
      singleGateUnlockMap.set(missingGate, list);
    } else if (g.missingGates.length === 2) {
      nearMiss2Symbols.push(item);
      const sortedGates = [...g.missingGates].sort();
      const comboKey = sortedGates.join(' + ');
      const existing = twoGateComboUnlockMap.get(comboKey) ?? {
        gates: sortedGates,
        symbols: [],
      };
      existing.symbols.push(item.symbol);
      twoGateComboUnlockMap.set(comboKey, existing);
    }
  }

  const shadow1Items = nearMiss1Symbols.filter(
    (i) =>
      i.gateEvaluation.liquiditySafetyPassed &&
      i.gateEvaluation.riskSafetyPassed
  );
  const shadow2Items = nearMiss2Symbols.filter(
    (i) =>
      i.gateEvaluation.liquiditySafetyPassed &&
      i.gateEvaluation.riskSafetyPassed
  );

  const shadow1LongCount =
    strictLongSymbols.length +
    shadow1Items.filter((i) => i.gateEvaluation.intendedDirection !== 'SHORT')
      .length;
  const shadow1ShortCount =
    strictShortSymbols.length +
    shadow1Items.filter((i) => i.gateEvaluation.intendedDirection === 'SHORT')
      .length;

  const shadow2LongCount =
    shadow1LongCount +
    shadow2Items.filter((i) => i.gateEvaluation.intendedDirection !== 'SHORT')
      .length;
  const shadow2ShortCount =
    shadow1ShortCount +
    shadow2Items.filter((i) => i.gateEvaluation.intendedDirection === 'SHORT')
      .length;

  const singleGateRelaxationImpact: ObservationShadowComparisonSummary['singleGateRelaxationImpact'] =
    {};
  for (const [gate, symbols] of singleGateUnlockMap.entries()) {
    singleGateRelaxationImpact[gate] = {
      gate,
      label: CANONICAL_GATE_LABELS[gate] ?? gate,
      additionalCandidatesIfRelaxed: symbols.length,
      symbolsUnlocked: symbols,
    };
  }

  const twoGateCombinationImpact = Array.from(twoGateComboUnlockMap.entries())
    .map(([combination, val]) => ({
      combination,
      gates: val.gates,
      additionalCandidatesIfRelaxed: val.symbols.length,
      symbolsUnlocked: val.symbols,
    }))
    .sort(
      (a, b) =>
        b.additionalCandidatesIfRelaxed - a.additionalCandidatesIfRelaxed
    );

  const topBottleneckGatesInAllEvaluated = Object.values(
    scopedStats.allEvaluated
  )
    .filter((s) => s.gate !== 'ALL_GATES')
    .sort((a, b) => b.failCount - a.failCount)
    .map((s) => ({
      gate: s.gate,
      label: s.label,
      failCount: s.failCount,
      evaluatedDenominator: s.evaluatedDenominator,
      failureRate: s.failureRate,
      statisticScope: 'ALL_EVALUATED' as const,
    }));

  const topBottleneckGatesInNearMiss = Object.values(scopedStats.nearMissOnly)
    .filter((s) => s.gate !== 'ALL_GATES' && s.failCount > 0)
    .sort((a, b) => b.failCount - a.failCount)
    .map((s) => ({
      gate: s.gate,
      label: s.label,
      failCount: s.failCount,
      evaluatedDenominator: s.evaluatedDenominator,
      failureRate: s.failureRate,
      statisticScope: 'NEAR_MISS_ONLY' as const,
    }));

  const strictCandidateTotal =
    strictLongSymbols.length + strictShortSymbols.length;
  const topAllGate = topBottleneckGatesInAllEvaluated[0];
  const topNearMissGate = topBottleneckGatesInNearMiss[0];

  const zeroCandidatePrimaryExplanation =
    strictCandidateTotal > 0
      ? `STRICT_PRODUCTION 目前已有 ${strictCandidateTotal} 檔完整通過所有正式 SMC Gate 之交易候選；另有 ${nearMiss1Symbols.length} 檔 NEAR_MISS_ONE_GATE 與 ${nearMiss2Symbols.length} 檔 NEAR_MISS_TWO_GATES 僅供研究觀察。`
      : `STRICT_PRODUCTION 正式候選為 0，主因是嚴格要求 BOS/MSS、Liquidity Sweep、Displacement、FVG/OB 與 MTF Alignment 同時成立。全市場已評估 (${evaluatedCount} 檔, ALL_EVALUATED) 中最常未通過條件為 ${
          topAllGate
            ? `${topAllGate.gate} (未通過 ${topAllGate.failCount}/${topAllGate.evaluatedDenominator}, ${topAllGate.failureRate}%)`
            : 'N/A'
        }；而在 ${
          nearMiss1Symbols.length + nearMiss2Symbols.length
        } 檔接近候選 (NEAR_MISS_ONLY) 中，最常缺的最後關鍵條件為 ${
          topNearMissGate
            ? `${topNearMissGate.gate} (${topNearMissGate.failCount}/${topNearMissGate.evaluatedDenominator})`
            : '無'
        }。若在 OBSERVATION_SHADOW 下放寬 1 個條件可增加 ${
          shadow1Items.length
        } 檔觀察對照標的，放寬 2 個條件可增加 ${
          shadow1Items.length + shadow2Items.length
        } 檔觀察對照標的（僅供研究，不建立 Paper 部位）。`;

  const nearMissTotalCount = nearMiss1Symbols.length + nearMiss2Symbols.length;
  const strictPaperClosed = strictOutcome?.paperClosedCount ?? 0;
  const strictPaperOpened = strictOutcome?.paperOpenedCount ?? 0;
  const strictEntryMissed =
    strictOutcome?.entryWindowMissedCount ?? strictMissedFromItems;
  const strictSufficiency =
    strictPaperClosed >= 100
      ? 'SUFFICIENT'
      : strictPaperClosed >= 30
        ? 'LIMITED'
        : 'INSUFFICIENT';

  const strictProductionBreakdown = {
    mode: 'STRICT_PRODUCTION' as const,
    modeLabel: '嚴格正式版 (STRICT_PRODUCTION)',
    isFormalProduction: true,
    paperTradingAllowed: true,
    paperCreationAllowed: true,
    paperLedgerWriteAllowed: true,
    notificationAllowed: true,
    formalSmcStateOverwritten: false as const,
    finalTradeSignalOverwritten: false as const,
    evaluatedCount,
    candidateCount: strictCandidateTotal,
    additionalObservationCount: 0,
    longCandidateCount: strictLongSymbols.length,
    shortCandidateCount: strictShortSymbols.length,
    nearMissCount: nearMissTotalCount,
    nearMissOneGateCount: nearMiss1Symbols.length,
    nearMissTwoGatesCount: nearMiss2Symbols.length,
    entryWindowMissedCount: strictEntryMissed,
    paperOpenedCount: strictPaperOpened,
    paperClosedCount: strictPaperClosed,
    winRate: strictPaperClosed > 0 ? (strictOutcome?.winRate ?? null) : null,
    averageR: strictPaperClosed > 0 ? (strictOutcome?.averageR ?? null) : null,
    profitFactor:
      strictPaperClosed > 0 ? (strictOutcome?.profitFactor ?? null) : null,
    maxDrawdownR:
      strictPaperClosed > 0 ? (strictOutcome?.maxDrawdownR ?? null) : null,
    expectancyR:
      strictPaperClosed > 0 ? (strictOutcome?.expectancyR ?? null) : null,
    sampleSufficiency: strictSufficiency as 'INSUFFICIENT' | 'LIMITED' | 'SUFFICIENT',
    candidateSymbols: [...strictLongSymbols, ...strictShortSymbols],
  };

  const shadowOneBreakdown = {
    mode: 'OBSERVATION_SHADOW_ONE_GATE_MISSING' as const,
    modeLabel: '研究對照版：允許差 1 個 Gate (OBSERVATION_SHADOW_ONE_GATE_MISSING)',
    isFormalProduction: false,
    paperTradingAllowed: false,
    paperCreationAllowed: false,
    paperLedgerWriteAllowed: false,
    notificationAllowed: false,
    formalSmcStateOverwritten: false as const,
    finalTradeSignalOverwritten: false as const,
    evaluatedCount,
    candidateCount: strictCandidateTotal + shadow1Items.length,
    additionalObservationCount: shadow1Items.length,
    longCandidateCount: shadow1LongCount,
    shortCandidateCount: shadow1ShortCount,
    nearMissCount: nearMissTotalCount,
    nearMissOneGateCount: nearMiss1Symbols.length,
    nearMissTwoGatesCount: nearMiss2Symbols.length,
    entryWindowMissedCount: 0,
    paperOpenedCount: 0,
    paperClosedCount: 0,
    winRate: null,
    averageR: null,
    profitFactor: null,
    maxDrawdownR: null,
    expectancyR: null,
    sampleSufficiency: 'INSUFFICIENT' as const,
    candidateSymbols: [
      ...strictLongSymbols,
      ...strictShortSymbols,
      ...shadow1Items.map((i) => i.symbol),
    ],
  };

  const shadowTwoBreakdown = {
    mode: 'OBSERVATION_SHADOW_TWO_GATES_MISSING' as const,
    modeLabel:
      '研究對照版：允許差 2 個 Gate (OBSERVATION_SHADOW_TWO_GATES_MISSING)',
    isFormalProduction: false,
    paperTradingAllowed: false,
    paperCreationAllowed: false,
    paperLedgerWriteAllowed: false,
    notificationAllowed: false,
    formalSmcStateOverwritten: false as const,
    finalTradeSignalOverwritten: false as const,
    evaluatedCount,
    candidateCount:
      strictCandidateTotal + shadow1Items.length + shadow2Items.length,
    additionalObservationCount: shadow1Items.length + shadow2Items.length,
    longCandidateCount: shadow2LongCount,
    shortCandidateCount: shadow2ShortCount,
    nearMissCount: nearMissTotalCount,
    nearMissOneGateCount: nearMiss1Symbols.length,
    nearMissTwoGatesCount: nearMiss2Symbols.length,
    entryWindowMissedCount: 0,
    paperOpenedCount: 0,
    paperClosedCount: 0,
    winRate: null,
    averageR: null,
    profitFactor: null,
    maxDrawdownR: null,
    expectancyR: null,
    sampleSufficiency: 'INSUFFICIENT' as const,
    candidateSymbols: [
      ...strictLongSymbols,
      ...strictShortSymbols,
      ...shadow1Items.map((i) => i.symbol),
      ...shadow2Items.map((i) => i.symbol),
    ],
  };

  return {
    cycleId,
    evaluatedCount,
    strictProduction: strictProductionBreakdown,
    observationShadowOneGateMissing: shadowOneBreakdown,
    observationShadowTwoGatesMissing: shadowTwoBreakdown,
    STRICT_PRODUCTION: strictProductionBreakdown,
    OBSERVATION_SHADOW_ONE_GATE_MISSING: shadowOneBreakdown,
    OBSERVATION_SHADOW_TWO_GATES_MISSING: shadowTwoBreakdown,
    singleGateRelaxationImpact,
    twoGateCombinationImpact,
    topBottleneckGatesInAllEvaluated,
    topBottleneckGatesInNearMiss,
    zeroCandidatePrimaryExplanation,
  };
}

export function buildSmcGateDiagnosticsSummary(
  rawItems: EvaluatedGateDiagnosticItemInput[],
  options?: GateDiagnosticsBuildOptions
): SmcGateDiagnosticsSummary {
  const evaluatedItems = rawItems.filter(
    (item) => !item.excludedFromDenominator && Boolean(item.gateEvaluation)
  );
  const scopedGateStatistics = buildScopedGateStatisticsSummary(
    rawItems,
    options
  );
  const totalEvaluatedSymbols = evaluatedItems.length;
  const totalUniverseSymbols = scopedGateStatistics.totalUniverseCount;
  const excludedCount = scopedGateStatistics.allEvaluatedExcludedCount;

  const gatePassCounts = {
    bosMssPassed: 0,
    liquiditySweepPassed: 0,
    displacementPassed: 0,
    fvgOrObPassed: 0,
    mtfAlignmentPassed: 0,
    atrPassed: 0,
    historyPassed: 0,
    oiPassed: 0,
    fundingPassed: 0,
    oiFundingPassed: 0,
    dataFreshnessPassed: 0,
    liquiditySafetyPassed: 0,
    riskSafetyPassed: 0,
    allGatesPassed: 0,
  };

  let fullGatePassCount = 0;
  let nearMissMissing1Count = 0;
  let nearMissMissing2Count = 0;
  const nearMissMissingGates: Record<string, number> = {};
  const lastBlockingGateBreakdown: Record<string, number> = {};
  const nearMissSymbols: SmcNearMissSymbolRecord[] = [];

  for (const item of evaluatedItems) {
    const g = item.gateEvaluation;
    if (g.bosMssPassed) gatePassCounts.bosMssPassed++;
    if (g.liquiditySweepPassed) gatePassCounts.liquiditySweepPassed++;
    if (g.displacementPassed) gatePassCounts.displacementPassed++;
    if (g.fvgOrObPassed) gatePassCounts.fvgOrObPassed++;
    if (g.mtfAlignmentPassed) gatePassCounts.mtfAlignmentPassed++;
    if (g.atrPassed) gatePassCounts.atrPassed++;
    if (g.historyPassed) gatePassCounts.historyPassed++;
    if (g.oiPassed) gatePassCounts.oiPassed++;
    if (g.fundingPassed) gatePassCounts.fundingPassed++;
    if (g.oiFundingPassed ?? (g.oiPassed && g.fundingPassed)) {
      gatePassCounts.oiFundingPassed++;
    }
    if (g.dataFreshnessPassed ?? g.historyPassed) {
      gatePassCounts.dataFreshnessPassed++;
    }
    if (g.liquiditySafetyPassed) gatePassCounts.liquiditySafetyPassed++;
    if (g.riskSafetyPassed) gatePassCounts.riskSafetyPassed++;

    const isFullPass =
      item.smcActionState === 'LONG CANDIDATE' ||
      item.smcActionState === 'SHORT CANDIDATE' ||
      g.missingGates.length === 0;
    if (isFullPass) {
      gatePassCounts.allGatesPassed++;
      fullGatePassCount++;
    } else {
      if (g.lastBlockingGate) {
        lastBlockingGateBreakdown[g.lastBlockingGate] =
          (lastBlockingGateBreakdown[g.lastBlockingGate] ?? 0) + 1;
      }
      if (g.missingGates.length === 1 || g.missingGates.length === 2) {
        const nmStatus: NearMissStatus =
          g.missingGates.length === 1
            ? 'NEAR_MISS_ONE_GATE'
            : 'NEAR_MISS_TWO_GATES';
        if (g.missingGates.length === 1) nearMissMissing1Count++;
        if (g.missingGates.length === 2) nearMissMissing2Count++;
        for (const mg of g.missingGates) {
          nearMissMissingGates[mg] = (nearMissMissingGates[mg] ?? 0) + 1;
        }
        const resolvedEvaluationLatencyMs =
          item.evaluationLatencyMs ?? item.smcEvaluationLatencyMs ?? null;
        const resolvedNextBarRemainingMs =
          item.nextBarRemainingMs !== undefined
            ? item.nextBarRemainingMs
            : item.nextBarOpenTime !== null &&
                item.nextBarOpenTime !== undefined &&
                Number.isFinite(item.nextBarOpenTime)
              ? Math.max(0, Math.round(Number(item.nextBarOpenTime) - Date.now()))
              : null;
        nearMissSymbols.push({
          symbol: item.symbol,
          smcActionState: item.smcActionState,
          marketRadarCategory: item.marketRadarCategory,
          nearMissStatus: nmStatus,
          intendedDirection: g.intendedDirection ?? 'NEUTRAL',
          score: item.score,
          missingGateCount: g.missingGates.length as 1 | 2,
          missingGates: [...g.missingGates],
          lastBlockingGate: g.lastBlockingGate ?? g.missingGates[0],
          waitReasons: [...g.waitReasons],
          evaluationLatencyMs: resolvedEvaluationLatencyMs,
          nextBarRemainingMs: resolvedNextBarRemainingMs,
          queueWaitMs: item.queueWaitMs ?? null,
          smcEvaluationLatencyMs: resolvedEvaluationLatencyMs,
          dataFreshnessSeconds: item.dataFreshnessSeconds ?? null,
          stale: item.stale ?? false,
          isDemo: item.isDemo ?? false,
          isFastLane: item.isFastLane ?? false,
        });
      }
    }
  }

  nearMissSymbols.sort((a, b) => {
    if (a.missingGateCount !== b.missingGateCount) {
      return a.missingGateCount - b.missingGateCount;
    }
    if ((b.score ?? 0) !== (a.score ?? 0)) {
      return (b.score ?? 0) - (a.score ?? 0);
    }
    return a.symbol.localeCompare(b.symbol);
  });

  const pct = (count: number) =>
    totalEvaluatedSymbols > 0
      ? Number(((count / totalEvaluatedSymbols) * 100).toFixed(2))
      : 0;

  let topBlockingGate: string | null = null;
  let topBlockingCount = 0;
  for (const [gate, cnt] of Object.entries(lastBlockingGateBreakdown)) {
    if (cnt > topBlockingCount) {
      topBlockingCount = cnt;
      topBlockingGate = gate;
    }
  }

  const observationShadowComparison = buildObservationShadowComparisonSummary(
    evaluatedItems,
    scopedGateStatistics,
    options?.cycleId,
    options?.strictProductionOutcome
  );

  return {
    cycleId: options?.cycleId,
    snapshotAt: options?.snapshotAt,
    statsVersion: options?.statsVersion,
    aggregationScope: options?.aggregationScope ?? 'CURRENT_CYCLE',
    evaluationUniverseSize: totalUniverseSymbols,
    totalUniverseSymbols,
    evaluatedDenominator: totalEvaluatedSymbols,
    totalEvaluatedSymbols,
    excludedCount,
    excludedSymbols: scopedGateStatistics.excludedSymbols ?? [],
    excludedReasons: scopedGateStatistics.excludedReasons ?? {},
    fullGatePassCount,
    fullGatePassRatePercent: pct(fullGatePassCount),
    gatePassCounts,
    gatePassRatesPercent: {
      bosMssPassed: pct(gatePassCounts.bosMssPassed),
      liquiditySweepPassed: pct(gatePassCounts.liquiditySweepPassed),
      displacementPassed: pct(gatePassCounts.displacementPassed),
      fvgOrObPassed: pct(gatePassCounts.fvgOrObPassed),
      mtfAlignmentPassed: pct(gatePassCounts.mtfAlignmentPassed),
      atrPassed: pct(gatePassCounts.atrPassed),
      historyPassed: pct(gatePassCounts.historyPassed),
      oiPassed: pct(gatePassCounts.oiPassed),
      fundingPassed: pct(gatePassCounts.fundingPassed),
      oiFundingPassed: pct(gatePassCounts.oiFundingPassed),
      dataFreshnessPassed: pct(gatePassCounts.dataFreshnessPassed),
      liquiditySafetyPassed: pct(gatePassCounts.liquiditySafetyPassed),
      riskSafetyPassed: pct(gatePassCounts.riskSafetyPassed),
      allGatesPassed: pct(gatePassCounts.allGatesPassed),
    },
    scopedGateStatistics,
    observationShadowComparison,
    nearMissCount: nearMissMissing1Count + nearMissMissing2Count,
    nearMissMissing1Count,
    nearMissMissing2Count,
    nearMissMissingGates,
    lastBlockingGate: topBlockingGate,
    lastBlockingGateBreakdown,
    nearMissSymbols,
  };
}

export interface FunnelConsistencyValidationInput {
  cycleId: string;
  snapshotAt: string;
  statsVersion: number;
  aggregationScope: FunnelAggregationScope;
  evaluationUniverseSize: number;
  evaluatedDenominator: number;
  excludedCount: number;
  excludedSymbols: string[];
  excludedReasons: Record<string, number>;
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
  nearMissCount: number;
  nearMissOneGateCount: number;
  nearMissTwoGatesCount: number;
  candidateDetectedCount: number;
  paperEligibleCount: number;
  paperOpenedCount: number;
  paperClosedCount: number;
  entryWindowMissedCount: number;
  expectedCycleId?: string;
  expectedSnapshotAt?: string;
  expectedStatsVersion?: number;
  expectedAggregationScope?: FunnelAggregationScope;
  gateDriftNearMissDenominator?: number;
  historicalSignalsMixedIntoCurrentCycle?: boolean;
}

export function validateScopedFunnelConsistency(
  input: FunnelConsistencyValidationInput
): {
  statsConsistency: SmcStatsConsistency;
  consistencyErrors: string[];
} {
  const errors: string[] = [];

  if (input.paperEligibleCount > input.candidateDetectedCount) {
    errors.push(
      `[${input.aggregationScope}] paperEligibleCount (${input.paperEligibleCount}) > candidateDetectedCount (${input.candidateDetectedCount})`
    );
  }
  if (input.paperOpenedCount > input.paperEligibleCount) {
    errors.push(
      `[${input.aggregationScope}] paperOpenedCount (${input.paperOpenedCount}) > paperEligibleCount (${input.paperEligibleCount})`
    );
  }
  if (input.paperClosedCount > input.paperOpenedCount) {
    errors.push(
      `[${input.aggregationScope}] paperClosedCount (${input.paperClosedCount}) > paperOpenedCount (${input.paperOpenedCount})`
    );
  }
  if (input.entryWindowMissedCount > input.candidateDetectedCount) {
    errors.push(
      `[${input.aggregationScope}] entryWindowMissedCount (${input.entryWindowMissedCount}) > candidateDetectedCount (${input.candidateDetectedCount})`
    );
  }
  if (
    input.nearMissOneGateCount + input.nearMissTwoGatesCount !==
    input.nearMissCount
  ) {
    errors.push(
      `[${input.aggregationScope}] nearMissOneGateCount (${input.nearMissOneGateCount}) + nearMissTwoGatesCount (${input.nearMissTwoGatesCount}) !== nearMissCount (${input.nearMissCount})`
    );
  }
  const statusSum =
    input.evaluatedCount +
    input.pendingCount +
    input.failedCount +
    input.rateLimitedCount;
  if (statusSum !== input.totalSymbols) {
    errors.push(
      `[${input.aggregationScope}] evaluatedCount (${input.evaluatedCount}) + pendingCount (${input.pendingCount}) + failedCount (${input.failedCount}) + rateLimitedCount (${input.rateLimitedCount}) = ${statusSum} !== totalSymbols (${input.totalSymbols})`
    );
  }
  const stateSum =
    input.waitCount +
    input.watchCount +
    input.highRiskCount +
    input.longCandidateCount +
    input.shortCandidateCount;
  if (stateSum !== input.evaluatedCount) {
    errors.push(
      `[${input.aggregationScope}] WAIT (${input.waitCount}) + WATCH (${input.watchCount}) + HIGH_RISK (${input.highRiskCount}) + LONG (${input.longCandidateCount}) + SHORT (${input.shortCandidateCount}) = ${stateSum} !== evaluatedCount (${input.evaluatedCount})`
    );
  }
  if (
    input.evaluatedDenominator + input.excludedCount !==
    input.evaluationUniverseSize
  ) {
    errors.push(
      `[${input.aggregationScope}] evaluatedDenominator (${input.evaluatedDenominator}) + excludedCount (${input.excludedCount}) !== evaluationUniverseSize (${input.evaluationUniverseSize})`
    );
  }
  if (
    input.excludedCount > 0 &&
    Object.keys(input.excludedReasons ?? {}).length === 0
  ) {
    errors.push(
      `[${input.aggregationScope}] excludedCount (${input.excludedCount}) > 0 but excludedReasons is empty`
    );
  }
  if (
    input.expectedCycleId !== undefined &&
    input.cycleId !== input.expectedCycleId
  ) {
    errors.push(
      `[${input.aggregationScope}] cycleId mismatch: ${input.cycleId} !== ${input.expectedCycleId}`
    );
  }
  if (
    input.expectedSnapshotAt !== undefined &&
    input.snapshotAt !== input.expectedSnapshotAt
  ) {
    errors.push(
      `[${input.aggregationScope}] snapshotAt mismatch: ${input.snapshotAt} !== ${input.expectedSnapshotAt}`
    );
  }
  if (
    input.expectedStatsVersion !== undefined &&
    input.statsVersion !== input.expectedStatsVersion
  ) {
    errors.push(
      `[${input.aggregationScope}] statsVersion mismatch: ${input.statsVersion} !== ${input.expectedStatsVersion}`
    );
  }
  if (
    input.expectedAggregationScope !== undefined &&
    input.aggregationScope !== input.expectedAggregationScope
  ) {
    errors.push(
      `[${input.aggregationScope}] aggregationScope mismatch: ${input.aggregationScope} !== ${input.expectedAggregationScope}`
    );
  }
  if (
    input.gateDriftNearMissDenominator !== undefined &&
    input.nearMissCount !== input.gateDriftNearMissDenominator
  ) {
    errors.push(
      `[${input.aggregationScope}] nearMissCount (${input.nearMissCount}) !== gateDriftNearMissDenominator (${input.gateDriftNearMissDenominator})`
    );
  }
  if (input.historicalSignalsMixedIntoCurrentCycle) {
    errors.push(
      `[${input.aggregationScope}] historical signals mixed into CURRENT_CYCLE funnel`
    );
  }

  return {
    statsConsistency: errors.length === 0 ? 'VALID' : 'INVALID',
    consistencyErrors: errors,
  };
}





