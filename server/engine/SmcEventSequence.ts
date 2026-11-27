import { Kline, SmcEventSequenceState, SmcEventSequenceStep } from '../../src/types/market.ts';
import { SmcStructureConfig } from './SmcStructureConfig.ts';
import {
  calculateConfirmedAtr14,
  collectSwingLiquidityPools,
  detectStrictOrderBlock,
  findConfirmedSwingPoints,
  swingEqualityTolerance,
} from './SmcRuleEngine.ts';

const STEP_KEYS = ['LIQUIDITY_SWEEP', 'MSS_CHOCH', 'DISPLACEMENT', 'FVG_OR_OB'] as const;

function emptyStep(
  key: (typeof STEP_KEYS)[number],
  detail: string
): SmcEventSequenceStep {
  return {
    key,
    complete: false,
    barIndex: null,
    timestamp: null,
    detail,
  };
}

function step(
  key: (typeof STEP_KEYS)[number],
  barIndex: number | null,
  timestamp: number | null,
  detail: string
): SmcEventSequenceStep {
  return {
    key,
    complete: barIndex !== null,
    barIndex,
    timestamp,
    detail,
  };
}

function rank(state: SmcEventSequenceState): number {
  return (state.isComplete ? 100 : 0) + state.completedStepCount;
}

interface Attempt {
  sweepIndex: number;
  sweepLevel: number;
  steps: SmcEventSequenceStep[];
  fvg: { low: number; high: number } | null;
  ob: { low: number; high: number } | null;
  displacementIndex: number | null;
}

function isDisplacement(
  candle: Kline,
  direction: 'LONG' | 'SHORT',
  atr: number,
  config: SmcStructureConfig
): boolean {
  const body = Math.abs(candle.close - candle.open);
  const range = Math.max(candle.high - candle.low, 1e-9);
  const atrRef = atr > 0 ? atr : range;
  const directional = direction === 'LONG' ? candle.close > candle.open : candle.close < candle.open;
  return (
    directional &&
    body / atrRef >= config.displacementAtrMultiple &&
    body / range >= config.displacementBodyRatio
  );
}

function fvgOrObFromDisplacement(params: {
  confirmed: Kline[];
  displacementIndex: number;
  direction: 'LONG' | 'SHORT';
  atr: number;
  config: SmcStructureConfig;
}): {
  found: boolean;
  detail: string;
  fvg: { low: number; high: number } | null;
  ob: { low: number; high: number } | null;
} {
  const { confirmed, displacementIndex: k, direction, atr, config } = params;
  const minGap = Math.max(0, config.minFvgAtrMultiple) * Math.max(0, atr);
  if (direction === 'LONG') {
    if (k - 1 >= 0 && k + 1 < confirmed.length) {
      const gap = confirmed[k + 1].low - confirmed[k - 1].high;
      if (gap > 0 && gap + 1e-12 >= minGap) {
        return {
          found: true,
          detail: '位移 K 為中間燭，右側已留下多頭 FVG',
          fvg: { low: confirmed[k - 1].high, high: confirmed[k + 1].low },
          ob: null,
        };
      }
    }
    if (k - 2 >= 0) {
      const gap = confirmed[k].low - confirmed[k - 2].high;
      if (gap > 0 && gap + 1e-12 >= minGap) {
        return {
          found: true,
          detail: '位移 K 為右側燭，留下多頭 FVG',
          fvg: { low: confirmed[k - 2].high, high: confirmed[k].low },
          ob: null,
        };
      }
    }
  } else {
    if (k - 1 >= 0 && k + 1 < confirmed.length) {
      const gap = confirmed[k - 1].low - confirmed[k + 1].high;
      if (gap > 0 && gap + 1e-12 >= minGap) {
        return {
          found: true,
          detail: '位移 K 為中間燭，右側已留下空頭 FVG',
          fvg: { low: confirmed[k + 1].high, high: confirmed[k - 1].low },
          ob: null,
        };
      }
    }
    if (k - 2 >= 0) {
      const gap = confirmed[k - 2].low - confirmed[k].high;
      if (gap > 0 && gap + 1e-12 >= minGap) {
        return {
          found: true,
          detail: '位移 K 為右側燭，留下空頭 FVG',
          fvg: { low: confirmed[k].high, high: confirmed[k - 2].low },
          ob: null,
        };
      }
    }
  }

  const ob = detectStrictOrderBlock({
    confirmed,
    displacementIndex: k,
    direction: direction === 'LONG' ? 'BULL' : 'BEAR',
    atr14: atr > 0 ? atr : Math.max(confirmed[k].high - confirmed[k].low, 1e-9),
    minBodyToAtr: config.obMinBodyToAtr,
    minBodyToRange: config.obMinBodyToRange,
  });
  if (ob.found && ob.evidence.low != null && ob.evidence.high != null) {
    return {
      found: true,
      detail: '該位移離開前方反向 Order Block',
      fvg: null,
      ob: { low: ob.evidence.low, high: ob.evidence.high },
    };
  }
  return { found: false, detail: '位移尚未留下 FVG 或有效 Order Block', fvg: null, ob: null };
}

function detectDirectionalSequence(
  confirmed: Kline[],
  direction: 'LONG' | 'SHORT',
  config: SmcStructureConfig
): SmcEventSequenceState {
  const windowBars = config.sequenceWindowBars;
  const unfinished = (steps: SmcEventSequenceStep[]): SmcEventSequenceState => {
    const completedStepCount = steps.filter((s) => s.complete).length;
    return {
      direction,
      isComplete: completedStepCount === steps.length,
      windowBars,
      completedStepCount,
      steps,
      informational: true,
      sweepLevel: null,
      invalidated: false,
      invalidationReasonZh: null,
    };
  };

  if (confirmed.length < 7) {
    return unfinished([
      emptyStep('LIQUIDITY_SWEEP', 'K 線不足，無法確認掃流動性'),
      emptyStep('MSS_CHOCH', '尚未出現'),
      emptyStep('DISPLACEMENT', '尚未出現'),
      emptyStep('FVG_OR_OB', '尚未出現'),
    ]);
  }

  const atr = calculateConfirmedAtr14(confirmed) ?? 0;
  const n = Math.max(1, config.swingConfirmationBars);
  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed, n);
  const ref = confirmed[confirmed.length - 1].close;
  const tolerance = swingEqualityTolerance(ref, atr);
  const pools =
    direction === 'LONG'
      ? collectSwingLiquidityPools(swingLows, 'LOW', tolerance)
      : collectSwingLiquidityPools(swingHighs, 'HIGH', tolerance);
  const brokenSwings = direction === 'LONG' ? swingHighs : swingLows;
  const minPen = Math.max(0, config.sweepMinPenetrationAtr) * Math.max(0, atr);

  let best: Attempt | null = null;

  for (const pool of pools) {
    for (let i = pool.formedAtIndex + 1; i < confirmed.length; i++) {
      const candle = confirmed[i];
      const pierced =
        direction === 'LONG'
          ? candle.low < pool.price - minPen && Math.min(candle.open, candle.close) >= pool.price
          : candle.high > pool.price + minPen && Math.max(candle.open, candle.close) <= pool.price;
      if (!pierced) continue;

      const sweepIndex = i;
      const windowEnd = sweepIndex + windowBars;
      let mssIndex: number | null = null;
      for (let j = sweepIndex + 1; j <= windowEnd && j < confirmed.length; j++) {
        const prior = [...brokenSwings]
          .reverse()
          .find((s) => s.index < sweepIndex && s.index + n <= j);
        if (!prior) continue;
        const broke =
          direction === 'LONG' ? confirmed[j].close > prior.price : confirmed[j].close < prior.price;
        if (broke) {
          mssIndex = j;
          break;
        }
      }

      let dispIndex: number | null = null;
      if (mssIndex !== null) {
        for (let k = mssIndex; k <= windowEnd && k < confirmed.length; k++) {
          if (isDisplacement(confirmed[k], direction, atr, config)) {
            dispIndex = k;
            break;
          }
        }
      }

      let poi: {
        found: boolean;
        detail: string;
        fvg: { low: number; high: number } | null;
        ob: { low: number; high: number } | null;
      } = { found: false, detail: '尚未出現', fvg: null, ob: null };
      if (dispIndex !== null && dispIndex - sweepIndex <= windowBars) {
        poi = fvgOrObFromDisplacement({
          confirmed,
          displacementIndex: dispIndex,
          direction,
          atr,
          config,
        });
      }

      const steps: SmcEventSequenceStep[] = [
        step(
          'LIQUIDITY_SWEEP',
          sweepIndex,
          candle.openTime,
          direction === 'LONG'
            ? `掃過已確認低點／EQL ${pool.price}`
            : `掃過已確認高點／EQH ${pool.price}`
        ),
        step(
          'MSS_CHOCH',
          mssIndex,
          mssIndex !== null ? confirmed[mssIndex].openTime : null,
          mssIndex !== null
            ? direction === 'LONG'
              ? '收盤突破掃單前的擺動高點（MSS/CHoCH）'
              : '收盤跌破掃單前的擺動低點（MSS/CHoCH）'
            : '掃單之後、窗口內尚未收盤突破結構'
        ),
        step(
          'DISPLACEMENT',
          dispIndex,
          dispIndex !== null ? confirmed[dispIndex].openTime : null,
          dispIndex !== null ? '結構突破後出現位移 K' : '窗口內尚未出現位移 K'
        ),
        step(
          'FVG_OR_OB',
          poi.found && dispIndex !== null ? dispIndex : null,
          poi.found && dispIndex !== null ? confirmed[dispIndex].openTime : null,
          poi.detail
        ),
      ];

      const completed = steps.filter((s) => s.complete).length;
      const prev = best ? best.steps.filter((s) => s.complete).length : -1;
      if (
        !best ||
        completed > prev ||
        (completed === prev && sweepIndex > best.sweepIndex)
      ) {
        best = {
          sweepIndex,
          sweepLevel: pool.price,
          steps,
          fvg: poi.fvg,
          ob: poi.ob,
          displacementIndex: dispIndex,
        };
      }
    }
  }

  if (!best) {
    return unfinished([
      emptyStep(
        'LIQUIDITY_SWEEP',
        direction === 'LONG' ? '尚未掃過已確認低點／EQL' : '尚未掃過已確認高點／EQH'
      ),
      emptyStep('MSS_CHOCH', '尚未出現'),
      emptyStep('DISPLACEMENT', '尚未出現'),
      emptyStep('FVG_OR_OB', '尚未出現'),
    ]);
  }

  let invalidationReasonZh: string | null = null;
  const afterSweep = best.sweepIndex + 1;
  for (let i = afterSweep; i < confirmed.length; i++) {
    const candle = confirmed[i];
    if (direction === 'LONG' && candle.low < best.sweepLevel) {
      invalidationReasonZh = `後續 K 線低點跌破掃單低點 ${best.sweepLevel}`;
      break;
    }
    if (direction === 'SHORT' && candle.high > best.sweepLevel) {
      invalidationReasonZh = `後續 K 線高點升破掃單高點 ${best.sweepLevel}`;
      break;
    }
  }
  const poiStart = (best.displacementIndex ?? best.sweepIndex) + 1;
  if (!invalidationReasonZh && best.fvg) {
    for (let i = poiStart; i < confirmed.length; i++) {
      const candle = confirmed[i];
      const filled =
        direction === 'LONG' ? candle.low <= best.fvg.low : candle.high >= best.fvg.high;
      if (filled) {
        invalidationReasonZh = `位移 FVG [${best.fvg.low}–${best.fvg.high}] 已被後續 K 線完全回補`;
        break;
      }
    }
  }
  if (!invalidationReasonZh && best.ob) {
    for (let i = poiStart; i < confirmed.length; i++) {
      const candle = confirmed[i];
      const mitigated =
        direction === 'LONG' ? candle.close < best.ob.low : candle.close > best.ob.high;
      if (mitigated) {
        invalidationReasonZh = `Order Block [${best.ob.low}–${best.ob.high}] 已被收盤貫穿`;
        break;
      }
    }
  }

  const state = unfinished(best.steps);
  state.sweepLevel = best.sweepLevel;
  state.invalidated = invalidationReasonZh !== null;
  state.invalidationReasonZh = invalidationReasonZh;
  if (state.invalidated) state.isComplete = false;
  return state;
}

/**
 * Ordered SMC sequence used by signal gate (b).
 * Long: sell-side sweep → bullish MSS/CHoCH → displacement → FVG/OB from that displacement.
 * Short is the mirror. Events must occur in that order inside `sequenceWindowBars`.
 * A complete sequence satisfies the gate. The lighter path is applied later in SignalConfidence.
 */
export function detectBestEventSequence(
  candles: Kline[] | null | undefined,
  config: SmcStructureConfig
): SmcEventSequenceState {
  const confirmed = (candles ?? []).filter((k) => k && k.isClosed === true);
  const longSeq = detectDirectionalSequence(confirmed, 'LONG', config);
  const shortSeq = detectDirectionalSequence(confirmed, 'SHORT', config);
  if (rank(longSeq) === 0 && rank(shortSeq) === 0) {
    return { ...longSeq, direction: 'NONE', isComplete: false, completedStepCount: 0 };
  }
  return rank(longSeq) >= rank(shortSeq) ? longSeq : shortSeq;
}
