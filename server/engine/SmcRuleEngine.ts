import {
  DataProvenance,
  EntryPullbackStatus,
  EntryZoneAnalysis,
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
  SmcFvgZone,
  SmcGateDiagnosticsSummary,
  SmcLiquiditySweepEvidence,
  SmcMtfAlignment,
  SmcNearMissSymbolRecord,
  SmcOrderBlockEvidence,
  SmcRuleProfile,
  SmcStatsConsistency,
  SymbolSmcGateEvaluation,
  Timeframe,
} from '../../src/types/market.ts';
import {
  evaluateHistoricalVolumeAnomaly,
  extractPriorConfirmedBaselineWindow,
  MIN_HISTORY_SAMPLES,
} from './VolumeAnomalyEngine.ts';
import { enforceProvenanceIntegrity } from '../utils/provenanceQuarantine.ts';
import { classifyTradeHorizon } from './TradeHorizonClassifier.ts';

export const SMC_RULE_VERSION = 'v1.0.0-smc-ict-deterministic';

/** Provenance gaps that must not by themselves block WAIT / formal SMC candidates. */
export const OPTIONAL_PROVENANCE_GAPS = new Set([
  'BID_ASK_SPREAD',
  'HISTORICAL_VOLUME_BASELINE',
]);

export function coreMissingData(missing: string[] | undefined | null): string[] {
  return (missing ?? []).filter((item) => !OPTIONAL_PROVENANCE_GAPS.has(item));
}

/** Confirmed bars required on each side of a pivot (classic 5-bar / 2-2 fractal). */
export const SWING_CONFIRMATION_BARS = 2;


export function normalizeSmcRuleProfile(profile?: unknown): SmcRuleProfile {
  if (profile === 'RELAXED_MTF_DISP' || profile === 'TREND_NO_SWEEP') {
    return profile;
  }
  return 'STRICT_PRODUCTION';
}

export function getSmcRuleVersionForProfile(profile: SmcRuleProfile): string {
  return profile === 'STRICT_PRODUCTION'
    ? SMC_RULE_VERSION
    : `${SMC_RULE_VERSION}:${profile}`;
}

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
  ruleProfile?: SmcRuleProfile;
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

export function findConfirmedSwingPoints(confirmed: Kline[]): SwingPoints {
  const swingHighs: Array<{ index: number; price: number; time: number }> = [];
  const swingLows: Array<{ index: number; price: number; time: number }> = [];
  const n = SWING_CONFIRMATION_BARS;

  // Classic 5-bar fractal: 2 confirmed bars on the left AND 2 on the right.
  // The last `n` confirmed bars are excluded so a forming high/low cannot be a pivot.
  for (let i = n; i < confirmed.length - n; i++) {
    const c = confirmed[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let offset = 1; offset <= n; offset++) {
      if (c.high < confirmed[i - offset].high || c.high <= confirmed[i + offset].high) {
        isSwingHigh = false;
      }
      if (c.low > confirmed[i - offset].low || c.low >= confirmed[i + offset].low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      swingHighs.push({ index: i, price: c.high, time: c.openTime });
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: c.low, time: c.openTime });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Share of an FVG that later confirmed bars have retraced.
 * 0 = untouched, 1 = price has reached the far side of the gap (fully filled).
 */
export function computeFvgFillRatio(
  direction: 'BULL' | 'BEAR',
  gapTop: number,
  gapBottom: number,
  subsequent: Kline[]
): number {
  const size = Math.max(gapTop - gapBottom, 1e-12);
  if (subsequent.length === 0) return 0;
  if (direction === 'BULL') {
    const extreme = subsequent.reduce((min, k) => Math.min(min, k.low), Infinity);
    if (!Number.isFinite(extreme) || extreme >= gapTop) return 0;
    if (extreme <= gapBottom) return 1;
    return Number(((gapTop - extreme) / size).toFixed(4));
  }
  const extreme = subsequent.reduce((max, k) => Math.max(max, k.high), -Infinity);
  if (!Number.isFinite(extreme) || extreme <= gapBottom) return 0;
  if (extreme >= gapTop) return 1;
  return Number(((extreme - gapBottom) / size).toFixed(4));
}

export function collectUnfilledFvgZones(
  confirmed: Kline[],
  lookbackBars = 24
): SmcFvgZone[] {
  const start = Math.max(2, confirmed.length - lookbackBars);
  const zones: SmcFvgZone[] = [];
  for (let i = confirmed.length - 1; i >= start; i--) {
    const c0 = confirmed[i - 2];
    const c2 = confirmed[i];
    const subsequent = confirmed.slice(i + 1);

    if (c2.low > c0.high) {
      const fillRatio = computeFvgFillRatio('BULL', c2.low, c0.high, subsequent);
      zones.push({
        direction: 'BULL',
        top: c2.low,
        bottom: c0.high,
        candleTime: confirmed[i - 1].openTime,
        fillRatio,
        mitigated: fillRatio >= 1,
      });
    }
    if (c2.high < c0.low) {
      const fillRatio = computeFvgFillRatio('BEAR', c0.low, c2.high, subsequent);
      zones.push({
        direction: 'BEAR',
        top: c0.low,
        bottom: c2.high,
        candleTime: confirmed[i - 1].openTime,
        fillRatio,
        mitigated: fillRatio >= 1,
      });
    }
  }
  return zones;
}

function selectPrimaryFvg(
  zones: SmcFvgZone[],
  preferredDirection: 'BULL' | 'BEAR' | 'NONE'
): SmcFvgZone | null {
  const live = zones.filter((z) => !z.mitigated);
  if (live.length === 0) return null;
  const preferred =
    preferredDirection === 'BULL' || preferredDirection === 'BEAR'
      ? live.filter((z) => z.direction === preferredDirection)
      : live;
  const pool = preferred.length > 0 ? preferred : live;
  // Most recent first (collectUnfilledFvgZones already walks newest-to-oldest)
  return pool[0];
}

/**
 * Strict order block: last meaningful opposing candle immediately before displacement,
 * displacement must leave the block, and a later confirmed close must not have invalidated it.
 */
export function detectStrictOrderBlock(params: {
  confirmed: Kline[];
  displacementIndex: number;
  direction: 'BULL' | 'BEAR';
  atr14: number;
}): { evidence: SmcOrderBlockEvidence; found: boolean } {
  const { confirmed, displacementIndex: i, direction, atr14 } = params;
  const empty: SmcOrderBlockEvidence = {
    detected: false,
    direction: 'NONE',
    high: null,
    low: null,
    candleTime: null,
    description: '未確認有效機構訂單塊 (Order Block)',
    mitigated: false,
    bodyToAtrRatio: null,
  };
  const disp = confirmed[i];
  // Search up to 4 bars before the displacement for the nearest meaningful opposing candle.
  // Consecutive displacement bars are common; the first opposing candle may sit 2–4 bars back.
  for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
    const prev = confirmed[j];
    const isOpposing =
      (direction === 'BULL' && prev.close < prev.open) ||
      (direction === 'BEAR' && prev.close > prev.open);
    if (!isOpposing) continue;

    const body = Math.abs(prev.close - prev.open);
    const range = Math.max(prev.high - prev.low, 1e-9);
    const bodyToAtr = atr14 > 0 ? body / atr14 : 0;
    const bodyToRange = body / range;
    // Reject dojis / tiny indecision bars that are not a real supply/demand candle.
    if (bodyToAtr < 0.25 && bodyToRange < 0.4) continue;

    const leftTheBlock =
      direction === 'BULL' ? disp.close > prev.high : disp.close < prev.low;
    if (!leftTheBlock) continue;

    const subsequent = confirmed.slice(i + 1);
    const mitigated =
      direction === 'BULL'
        ? subsequent.some((k) => k.close < prev.low)
        : subsequent.some((k) => k.close > prev.high);
    if (mitigated) {
      return {
        found: false,
        evidence: {
          detected: false,
          direction: 'NONE',
          high: prev.high,
          low: prev.low,
          candleTime: prev.openTime,
          description: `位移前 Order Block 已被後續已收盤 K 線收盤穿越而失效`,
          mitigated: true,
          bodyToAtrRatio: Number(bodyToAtr.toFixed(2)),
        },
      };
    }

    return {
      found: true,
      evidence: {
        detected: true,
        direction,
        high: prev.high,
        low: prev.low,
        candleTime: prev.openTime,
        description: `於位移前確認具實體的${direction === 'BULL' ? '多頭需求' : '空頭供給'} Order Block 區間 [${prev.low} – ${prev.high}]（未被後續收盤穿越）`,
        mitigated: false,
        bodyToAtrRatio: Number(bodyToAtr.toFixed(2)),
      },
    };
  }
  return { found: false, evidence: empty };
}

function deriveHistoricalVolumeFromKlines(
  symbol: string,
  klines: Kline[] | undefined,
  baseProvenance: import('../../src/types/market.ts').DataProvenance
): import('../../src/types/market.ts').HistoricalVolumeMetrics | null {
  if (!klines || klines.length === 0) return null;
  const confirmed = klines.filter((k) => k.isClosed && Number.isFinite(k.quoteVolume));
  if (confirmed.length < MIN_HISTORY_SAMPLES + 1) return null;
  const vols = confirmed.map((k) => k.quoteVolume);
  const extracted = extractPriorConfirmedBaselineWindow(
    vols,
    vols.length - 1,
    MIN_HISTORY_SAMPLES
  );
  return evaluateHistoricalVolumeAnomaly({
    symbol,
    exchange: 'binance_usdm',
    currentVolume: extracted.currentVolume,
    historicalVolumes: extracted.historicalVolumes,
    volumeTimeframe: '15m',
    baseProvenance,
  });
}

/** Equal-high / equal-low cluster tolerance: 0.15 ATR or 5 bps of price, whichever is larger. */
export const SWING_EQUALITY_ATR_RATIO = 0.15;
export const SWING_EQUALITY_PRICE_RATIO = 0.0005;

export function swingEqualityTolerance(
  price: number,
  atr14: number | null | undefined
): number {
  const fromPrice = Math.abs(price) * SWING_EQUALITY_PRICE_RATIO;
  const fromAtr = Math.max(0, atr14 ?? 0) * SWING_EQUALITY_ATR_RATIO;
  return Math.max(fromPrice, fromAtr, Math.abs(price) * 1e-8);
}

export interface SwingLiquidityPool {
  side: 'HIGH' | 'LOW';
  /** Extreme of the equal-high / equal-low cluster (buy-side = max, sell-side = min). */
  price: number;
  /** Confirmed-bar index of the first swing that established the pool. */
  formedAtIndex: number;
  memberCount: number;
}

/**
 * Cluster confirmed swing highs/lows that sit within the equality tolerance
 * into liquidity pools (including a single isolated swing as a 1-member pool).
 */
export function collectSwingLiquidityPools(
  swings: Array<{ index: number; price: number }>,
  side: 'HIGH' | 'LOW',
  tolerance: number
): SwingLiquidityPool[] {
  if (swings.length === 0) return [];
  const sorted = [...swings].sort((a, b) => a.index - b.index);
  const used = new Set<number>();
  const pools: SwingLiquidityPool[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i]];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].price - sorted[i].price) <= tolerance) {
        cluster.push(sorted[j]);
        used.add(j);
      }
    }
    const prices = cluster.map((s) => s.price);
    const price = side === 'HIGH' ? Math.max(...prices) : Math.min(...prices);
    pools.push({
      side,
      price,
      formedAtIndex: Math.min(...cluster.map((s) => s.index)),
      memberCount: cluster.length,
    });
  }
  return pools;
}

/**
 * Most recent confirmed close that broke a prior confirmed swing high (BULL)
 * or swing low (BEAR). Returns null when no such break exists in the window.
 */
export function detectLastStructureBreak(
  confirmed: Kline[]
): 'BULL' | 'BEAR' | null {
  if (confirmed.length < 7) return null;
  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed);
  if (swingHighs.length === 0 && swingLows.length === 0) return null;
  const lookbackStart = Math.max(SWING_CONFIRMATION_BARS + 1, confirmed.length - 36);
  let last: { dir: 'BULL' | 'BEAR'; index: number } | null = null;
  for (let i = lookbackStart; i < confirmed.length; i++) {
    const c = confirmed[i];
    const priorHigh = [...swingHighs].reverse().find((s) => s.index < i);
    const priorLow = [...swingLows].reverse().find((s) => s.index < i);
    if (priorHigh && c.close > priorHigh.price) {
      last = { dir: 'BULL', index: i };
    }
    if (priorLow && c.close < priorLow.price) {
      last = { dir: 'BEAR', index: i };
    }
  }
  return last?.dir ?? null;
}

/**
 * Timeframe bias from confirmed swing structure only (no open/forming bars).
 * HH+HL = bullish, LH+LL = bearish; a more recent BOS/CHoCH close-through
 * overrides older swing structure. Returns NEUTRAL when structure is mixed
 * or insufficient, and MISSING when there is not enough closed history.
 */
export function detectTimeframeBias(
  klines: Kline[] | undefined
): 'BULL' | 'BEAR' | 'NEUTRAL' | 'MISSING' {
  if (!klines || klines.length === 0) return 'MISSING';
  const confirmed = klines.filter((k) => k.isClosed);
  if (confirmed.length < 20) return 'MISSING';

  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed);
  const lastHighs = swingHighs.slice(-2);
  const lastLows = swingLows.slice(-2);
  const hh =
    lastHighs.length === 2 && lastHighs[1].price > lastHighs[0].price;
  const hl = lastLows.length === 2 && lastLows[1].price > lastLows[0].price;
  const lh =
    lastHighs.length === 2 && lastHighs[1].price < lastHighs[0].price;
  const ll = lastLows.length === 2 && lastLows[1].price < lastLows[0].price;
  const bullishStructure = hh && hl;
  const bearishStructure = lh && ll;
  const lastBreak = detectLastStructureBreak(confirmed);

  // A later BOS / CHoCH close is the most timely structure event (CHoCH flips bias).
  if (lastBreak) return lastBreak;
  if (bullishStructure) return 'BULL';
  if (bearishStructure) return 'BEAR';

  // Monotonic move with no pullback often has no 5-bar fractals. Treat a last
  // confirmed close beyond the established (excluding the last two bars) range
  // as a nascent structure bias; a range stays NEUTRAL.
  const established = confirmed.slice(0, Math.max(0, confirmed.length - 2));
  if (established.length >= 10) {
    const rangeHigh = Math.max(...established.map((k) => k.high));
    const rangeLow = Math.min(...established.map((k) => k.low));
    const lastClose = confirmed[confirmed.length - 1].close;
    if (lastClose > rangeHigh) return 'BULL';
    if (lastClose < rangeLow) return 'BEAR';
  }
  return 'NEUTRAL';
}

/**
 * Liquidity Sweep on confirmed candles only: wick through a confirmed swing
 * high/low pool (or an equal-high / equal-low cluster) and close back inside.
 */
export function detectConfirmedLiquiditySweep(
  confirmed: Kline[],
  atr14: number | null | undefined,
  lookbackBars = 16
): SmcLiquiditySweepEvidence {
  const empty: SmcLiquiditySweepEvidence = {
    detected: false,
    side: 'NONE',
    sweptLevel: null,
    candleTime: null,
    description: '近期已確認 K 線未偵測到高低點流動性掃單 (Liquidity Sweep)',
  };
  confirmed = confirmed.filter((k) => k.isClosed);
  if (confirmed.length < 7) return empty;
  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed);
  if (swingHighs.length === 0 && swingLows.length === 0) return empty;

  const refPrice = confirmed[confirmed.length - 1].close;
  const tolerance = swingEqualityTolerance(refPrice, atr14 ?? null);
  const buySidePools = collectSwingLiquidityPools(swingHighs, 'HIGH', tolerance);
  const sellSidePools = collectSwingLiquidityPools(swingLows, 'LOW', tolerance);

  const start = Math.max(SWING_CONFIRMATION_BARS + 1, confirmed.length - lookbackBars);
  // Walk newest -> oldest so the most recent valid sweep wins.
  for (let i = confirmed.length - 1; i >= start; i--) {
    const c = confirmed[i];
    const sellPool = sellSidePools
      .filter((p) => p.formedAtIndex < i)
      .sort((a, b) => b.formedAtIndex - a.formedAtIndex)[0];
    // Prefer the pool the wick actually pierced; if several, the nearest below.
    const piercedSell = sellSidePools
      .filter(
        (p) =>
          p.formedAtIndex < i &&
          c.low < p.price &&
          Math.min(c.open, c.close) >= p.price
      )
      .sort((a, b) => b.price - a.price)[0];
    if (piercedSell) {
      return {
        detected: true,
        side: 'SELL_SIDE_SWEPT',
        sweptLevel: piercedSell.price,
        candleTime: c.openTime,
        description: `下影線刺穿已確認擺動低點／同等低點流動性池 (${piercedSell.price}) 後實體收回其上方 (Sell-Side Liquidity Sweep)`,
      };
    }
    const piercedBuy = buySidePools
      .filter(
        (p) =>
          p.formedAtIndex < i &&
          c.high > p.price &&
          Math.max(c.open, c.close) <= p.price
      )
      .sort((a, b) => a.price - b.price)[0];
    if (piercedBuy) {
      return {
        detected: true,
        side: 'BUY_SIDE_SWEPT',
        sweptLevel: piercedBuy.price,
        candleTime: c.openTime,
        description: `上影線刺穿已確認擺動高點／同等高點流動性池 (${piercedBuy.price}) 後實體收回其下方 (Buy-Side Liquidity Sweep)`,
      };
    }
  }
  return empty;
}

function detectEarlyInflection(
  klines5m: Kline[] | undefined,
  klines15m: Kline[] | undefined
): NonNullable<SmcAnalysisResult['earlyInflection']> {
  const candidates: Array<{ tf: '5m' | '15m'; klines: Kline[] }> = [
    { tf: '5m', klines: (klines5m ?? []).filter((k) => k.isClosed) },
    { tf: '15m', klines: (klines15m ?? []).filter((k) => k.isClosed) },
  ];

  for (const { tf, klines } of candidates) {
    if (klines.length < 22) continue;
    const atr = calculateConfirmedAtr14(klines);
    if (atr === null || atr <= 0) continue;

    const { swingHighs, swingLows } = findConfirmedSwingPoints(klines);
    const lookbackStart = Math.max(6, klines.length - 8);
    const recent = klines.slice(lookbackStart);

    // Check recent sweep on 5m / 15m
    let bullSweepLow: number | null = null;
    let bearSweepHigh: number | null = null;
    for (let i = klines.length - 1; i >= lookbackStart; i--) {
      const c = klines[i];
      const priorSlice = klines.slice(Math.max(0, i - 10), i);
      if (priorSlice.length < 5) continue;
      const pLow = Math.min(...priorSlice.map((k) => k.low));
      const pHigh = Math.max(...priorSlice.map((k) => k.high));
      if (bullSweepLow === null && c.low < pLow && Math.min(c.open, c.close) >= pLow) {
        bullSweepLow = c.low;
      }
      if (bearSweepHigh === null && c.high > pHigh && Math.max(c.open, c.close) <= pHigh) {
        bearSweepHigh = c.high;
      }
    }

    // Check early displacement / ignition bar
    let bullDisp = false;
    let bearDisp = false;
    for (const c of recent) {
      const body = Math.abs(c.close - c.open);
      const range = Math.max(c.high - c.low, 1e-9);
      if (body / atr >= 1.15 && body / range >= 0.55) {
        if (c.close > c.open) bullDisp = true;
        else bearDisp = true;
      }
    }

    // Check micro-swing break
    const priorHigh = swingHighs.filter((s) => s.index < klines.length - 2).slice(-1)[0];
    const priorLow = swingLows.filter((s) => s.index < klines.length - 2).slice(-1)[0];
    const lastClose = klines[klines.length - 1].close;
    const bullBreak = priorHigh ? lastClose > priorHigh.price : false;
    const bearBreak = priorLow ? lastClose < priorLow.price : false;

    const bullScore =
      (bullSweepLow !== null ? 2 : 0) + (bullBreak ? 2 : 0) + (bullDisp ? 1 : 0);
    const bearScore =
      (bearSweepHigh !== null ? 2 : 0) + (bearBreak ? 2 : 0) + (bearDisp ? 1 : 0);

    if (bullScore >= 3 && bullScore > bearScore) {
      const invPrice =
        bullSweepLow ?? priorLow?.price ?? Math.min(...recent.map((k) => k.low));
      const invLabel =
        bullSweepLow !== null
          ? `${tf} Sweep 低點`
          : `${tf} 起漲擺動低點`;
      const tags: string[] = [];
      if (bullSweepLow !== null) tags.push('掃底吸籌');
      if (bullBreak) tags.push('MSS突破');
      if (bullDisp) tags.push('放量位移');
      return {
        direction: 'LONG',
        timeframe: tf,
        sweepDetected: bullSweepLow !== null,
        mssOrBreakDetected: bullBreak,
        displacementDetected: bullDisp,
        invalidationPrice: Number(invPrice.toPrecision(6)),
        invalidationLabel: invLabel,
        descriptionZh: `${tf} 早鳥多頭轉折（${tags.join(' + ')}）`,
      };
    }

    if (bearScore >= 3 && bearScore > bullScore) {
      const invPrice =
        bearSweepHigh ?? priorHigh?.price ?? Math.max(...recent.map((k) => k.high));
      const invLabel =
        bearSweepHigh !== null
          ? `${tf} Sweep 高點`
          : `${tf} 起跌擺動高點`;
      const tags: string[] = [];
      if (bearSweepHigh !== null) tags.push('掃頂派發');
      if (bearBreak) tags.push('MSS跌破');
      if (bearDisp) tags.push('放量位移');
      return {
        direction: 'SHORT',
        timeframe: tf,
        sweepDetected: bearSweepHigh !== null,
        mssOrBreakDetected: bearBreak,
        displacementDetected: bearDisp,
        invalidationPrice: Number(invPrice.toPrecision(6)),
        invalidationLabel: invLabel,
        descriptionZh: `${tf} 早鳥空頭轉折（${tags.join(' + ')}）`,
      };
    }
  }

  return {
    direction: 'NEUTRAL',
    timeframe: null,
    sweepDetected: false,
    mssOrBreakDetected: false,
    displacementDetected: false,
    invalidationPrice: null,
    invalidationLabel: null,
    descriptionZh: null,
  };
}

export function computeEntryZoneAnalysis(params: {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  currentPrice: number;
  atr14: number | null;
  fvg: SmcFvgEvidence;
  orderBlock: SmcOrderBlockEvidence;
  liquiditySweep: SmcLiquiditySweepEvidence;
  intradayVwap?: number | null;
  pdh?: number | null;
  pdl?: number | null;
}): EntryZoneAnalysis {
  const {
    direction,
    currentPrice,
    atr14,
    fvg,
    orderBlock,
    liquiditySweep,
    intradayVwap = null,
    pdh = null,
    pdl = null,
  } = params;

  if (
    direction === 'NEUTRAL' ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return {
      status: 'NO_CLEAR_ZONE',
      direction,
      anchorType: 'NONE',
      anchorLabel: '無明確方向或價格',
      zoneLow: null,
      zoneHigh: null,
      idealPullbackEntry: null,
      stopLossPrice: null,
      targetPrice: null,
      currentPrice,
      distanceToZonePct: null,
      distanceToZoneAtr: null,
      chaseRR: null,
      pullbackRR: null,
      headlineZh: '多空方向尚未表態，暫無回踩區間參考',
      actionAdviceZh: '等待結構形成明確方向後再評估回踩折價區。',
    };
  }

  const effectiveAtr =
    atr14 !== null && Number.isFinite(atr14) && atr14 > 0
      ? atr14
      : currentPrice * 0.012;

  let anchorType: EntryZoneAnalysis['anchorType'] = 'NONE';
  let anchorLabel = '無明確回踩錨點';
  let zoneLow: number | null = null;
  let zoneHigh: number | null = null;

  const liveFvgZones = (fvg.zones ?? []).filter((z) => !z.mitigated);
  const pickNearestFvg = (dir: 'BULL' | 'BEAR') => {
    const pool = liveFvgZones.filter((z) => z.direction === dir);
    if (pool.length === 0) {
      if (
        fvg.detected &&
        !fvg.mitigated &&
        fvg.direction === dir &&
        fvg.bottom !== null &&
        fvg.top !== null
      ) {
        return { bottom: fvg.bottom, top: fvg.top };
      }
      return null;
    }
    return pool
      .map((z) => ({
        bottom: z.bottom,
        top: z.top,
        mid: (z.bottom + z.top) / 2,
      }))
      .sort((a, b) => Math.abs(a.mid - currentPrice) - Math.abs(b.mid - currentPrice))[0];
  };

  if (direction === 'LONG') {
    const bullFvg = pickNearestFvg('BULL');
    if (bullFvg && bullFvg.bottom <= currentPrice * 1.02) {
      anchorType = 'FVG';
      anchorLabel = '未回補多頭 FVG 折價區';
      zoneLow = bullFvg.bottom;
      zoneHigh = bullFvg.top;
    } else if (
      orderBlock.detected &&
      orderBlock.mitigated !== true &&
      orderBlock.direction === 'BULL' &&
      orderBlock.low !== null &&
      orderBlock.high !== null &&
      orderBlock.low <= currentPrice * 1.02
    ) {
      anchorType = 'ORDER_BLOCK';
      anchorLabel = '多頭 Order Block 需求區';
      zoneLow = orderBlock.low;
      zoneHigh = orderBlock.high;
    } else if (
      intradayVwap !== null &&
      Number.isFinite(intradayVwap) &&
      intradayVwap > 0 &&
      intradayVwap <= currentPrice * 1.02
    ) {
      anchorType = 'VWAP';
      anchorLabel = '盤中 VWAP 均價支撐帶';
      zoneLow = intradayVwap - effectiveAtr * 0.25;
      zoneHigh = intradayVwap + effectiveAtr * 0.25;
    }
  } else {
    const bearFvg = pickNearestFvg('BEAR');
    if (bearFvg && bearFvg.top >= currentPrice * 0.98) {
      anchorType = 'FVG';
      anchorLabel = '未回補空頭 FVG 溢價區';
      zoneLow = bearFvg.bottom;
      zoneHigh = bearFvg.top;
    } else if (
      orderBlock.detected &&
      orderBlock.mitigated !== true &&
      orderBlock.direction === 'BEAR' &&
      orderBlock.low !== null &&
      orderBlock.high !== null &&
      orderBlock.high >= currentPrice * 0.98
    ) {
      anchorType = 'ORDER_BLOCK';
      anchorLabel = '空頭 Order Block 供給區';
      zoneLow = orderBlock.low;
      zoneHigh = orderBlock.high;
    } else if (
      intradayVwap !== null &&
      Number.isFinite(intradayVwap) &&
      intradayVwap > 0 &&
      intradayVwap >= currentPrice * 0.98
    ) {
      anchorType = 'VWAP';
      anchorLabel = '盤中 VWAP 均價壓力帶';
      zoneLow = intradayVwap - effectiveAtr * 0.25;
      zoneHigh = intradayVwap + effectiveAtr * 0.25;
    }
  }

  if (zoneLow === null || zoneHigh === null) {
    return {
      status: 'NO_CLEAR_ZONE',
      direction,
      anchorType: 'NONE',
      anchorLabel: '尚無未回補 FVG / OB 回踩錨點',
      zoneLow: null,
      zoneHigh: null,
      idealPullbackEntry: null,
      stopLossPrice: null,
      targetPrice: null,
      currentPrice,
      distanceToZonePct: null,
      distanceToZoneAtr: null,
      chaseRR: null,
      pullbackRR: null,
      headlineZh: '近期未偵測到未回補 FVG 或有效機構訂單塊',
      actionAdviceZh: '可切換至較低週期觀察是否留下新的失衡缺口或回踩 VWAP。',
    };
  }

  const idealPullbackEntry = Number(((zoneLow + zoneHigh) / 2).toPrecision(6));

  let stopLossPrice: number;
  if (direction === 'LONG') {
    const obLow =
      orderBlock.detected && orderBlock.direction === 'BULL' && orderBlock.low
        ? Math.min(orderBlock.low * 0.9965, orderBlock.low - effectiveAtr * 0.25)
        : null;
    const sweepLow =
      liquiditySweep.detected &&
      liquiditySweep.side === 'SELL_SIDE_SWEPT' &&
      liquiditySweep.sweptLevel
        ? Math.min(
            liquiditySweep.sweptLevel * 0.9965,
            liquiditySweep.sweptLevel - effectiveAtr * 0.25
          )
        : null;
    const rawStop =
      obLow ?? sweepLow ?? zoneLow - effectiveAtr * 0.85;
    const minStopDist = Math.max(
      effectiveAtr * 0.85,
      idealPullbackEntry * 0.006
    );
    stopLossPrice = Math.min(rawStop, idealPullbackEntry - minStopDist);
  } else {
    const obHigh =
      orderBlock.detected && orderBlock.direction === 'BEAR' && orderBlock.high
        ? Math.max(orderBlock.high * 1.0035, orderBlock.high + effectiveAtr * 0.25)
        : null;
    const sweepHigh =
      liquiditySweep.detected &&
      liquiditySweep.side === 'BUY_SIDE_SWEPT' &&
      liquiditySweep.sweptLevel
        ? Math.max(
            liquiditySweep.sweptLevel * 1.0035,
            liquiditySweep.sweptLevel + effectiveAtr * 0.25
          )
        : null;
    const rawStop =
      obHigh ?? sweepHigh ?? zoneHigh + effectiveAtr * 0.85;
    const minStopDist = Math.max(
      effectiveAtr * 0.85,
      idealPullbackEntry * 0.006
    );
    stopLossPrice = Math.max(rawStop, idealPullbackEntry + minStopDist);
  }
  stopLossPrice = Number(Math.max(1e-8, stopLossPrice).toPrecision(6));

  const pullbackRisk = Math.max(
    Math.abs(idealPullbackEntry - stopLossPrice),
    currentPrice * 0.006
  );
  const chaseRisk = Math.max(
    Math.abs(currentPrice - stopLossPrice),
    currentPrice * 0.006
  );

  // Target: realistic structural 2.0R from pullback OR PDH/PDL if >= 1.8R from pullback
  let targetPrice =
    direction === 'LONG'
      ? Math.max(
          currentPrice + effectiveAtr * 1.5,
          idealPullbackEntry + pullbackRisk * 2.0
        )
      : Math.min(
          currentPrice - effectiveAtr * 1.5,
          idealPullbackEntry - pullbackRisk * 2.0
        );

  if (
    direction === 'LONG' &&
    pdh !== null &&
    Number.isFinite(pdh) &&
    pdh > currentPrice + effectiveAtr * 0.4
  ) {
    targetPrice = Math.max(pdh, idealPullbackEntry + pullbackRisk * 1.8);
  } else if (
    direction === 'SHORT' &&
    pdl !== null &&
    Number.isFinite(pdl) &&
    pdl < currentPrice - effectiveAtr * 0.4
  ) {
    targetPrice = Math.min(pdl, idealPullbackEntry - pullbackRisk * 1.8);
  }
  targetPrice = Number(Math.max(1e-8, targetPrice).toPrecision(6));

  const distanceToEdge =
    direction === 'LONG'
      ? Math.max(0, currentPrice - zoneHigh)
      : Math.max(0, zoneLow - currentPrice);
  const distanceToZonePct = Number(
    ((distanceToEdge / currentPrice) * 100).toFixed(2)
  );
  const distanceToZoneAtr = Number((distanceToEdge / effectiveAtr).toFixed(2));

  const chaseReward =
    direction === 'LONG'
      ? Math.max(0, targetPrice - currentPrice)
      : Math.max(0, currentPrice - targetPrice);
  const pullbackReward =
    direction === 'LONG'
      ? Math.max(0, targetPrice - idealPullbackEntry)
      : Math.max(0, idealPullbackEntry - targetPrice);

  const chaseRR = Number((chaseReward / chaseRisk).toFixed(2));
  const pullbackRR = Number((pullbackReward / pullbackRisk).toFixed(2));

  let status: EntryPullbackStatus;
  let headlineZh: string;
  let actionAdviceZh: string;

  const isInsideZone =
    currentPrice >= zoneLow * 0.999 && currentPrice <= zoneHigh * 1.001;

  if (isInsideZone || distanceToZoneAtr <= 0.35) {
    status = 'IN_DISCOUNT_ZONE';
    headlineZh = `正處於「${anchorLabel}」折價區（偏離 ${distanceToZoneAtr}x ATR）· 盈虧比佳`;
    actionAdviceZh = `現價已貼近結構回踩區 [${Number(zoneLow.toPrecision(6))} – ${Number(zoneHigh.toPrecision(6))}]，無須追高，可評估結構確認後進場（淨 R:R 約 1:${pullbackRR}）。`;
  } else if (distanceToZoneAtr <= 1.65) {
    status = 'NEAR_PULLBACK_ZONE';
    headlineZh = `距離「${anchorLabel}」約 ${distanceToZoneAtr}x ATR (${distanceToZonePct}%) · 接近回踩區`;
    actionAdviceZh = `建議優先設定回踩告警於 ${idealPullbackEntry}（回踩 R:R 1:${pullbackRR} vs 現價追單 1:${chaseRR}），耐心等待價格回測。`;
  } else {
    status = 'OVEREXTENDED';
    headlineZh = `已延伸過度！現價偏離「${anchorLabel}」達 ${distanceToZoneAtr}x ATR (${distanceToZonePct}%)`;
    actionAdviceZh = `追高警戒：此刻市價追單僅剩 1:${chaseRR} 盈虧比，建議改掛回踩告警於 ${idealPullbackEntry}（回踩可提升至 1:${pullbackRR}），切勿買在趨勢末班車。`;
  }

  return {
    status,
    direction,
    anchorType,
    anchorLabel,
    zoneLow: Number(zoneLow.toPrecision(6)),
    zoneHigh: Number(zoneHigh.toPrecision(6)),
    idealPullbackEntry,
    stopLossPrice,
    targetPrice,
    currentPrice: Number(currentPrice.toPrecision(6)),
    distanceToZonePct,
    distanceToZoneAtr,
    chaseRR,
    pullbackRR,
    headlineZh,
    actionAdviceZh,
  };
}

export function evaluateSmcStructure(input: EvaluateSmcInput): SmcAnalysisResult {
  const {
    symbol,
    primaryTimeframe,
    klinesByTimeframe,
    openInterest,
    isLowLiquidity = false,
    extremeFunding = false,
    lowLiquidityHighVolatility = false,
    provenance: rawProvenance,
  } = input;

  const ruleProfile = normalizeSmcRuleProfile(input.ruleProfile);
  const isRelaxedMtfDisp =
    ruleProfile === 'RELAXED_MTF_DISP' || ruleProfile === 'TREND_NO_SWEEP';
  const requireSweep = ruleProfile !== 'TREND_NO_SWEEP';
  const provenance = enforceProvenanceIntegrity(rawProvenance);

  const rawPrimaryKlines = klinesByTimeframe[primaryTimeframe] || [];
  const confirmedKlines = rawPrimaryKlines.filter((k) => k.isClosed);
  const unclosedKlineIgnoredCount = rawPrimaryKlines.length - confirmedKlines.length;

  // Cold-start: if the caller passed an insufficient 15m baseline but we already have
  // enough confirmed 15m (or primary) klines, derive the baseline from those closed bars.
  let historicalVolume = input.historicalVolume;
  const volumeSourceKlines = klinesByTimeframe['15m'] ?? rawPrimaryKlines;
  if (
    !historicalVolume ||
    historicalVolume.status === 'INSUFFICIENT_HISTORY' ||
    (historicalVolume.sampleCount ?? 0) < MIN_HISTORY_SAMPLES
  ) {
    const derived = deriveHistoricalVolumeFromKlines(
      symbol,
      volumeSourceKlines,
      provenance
    );
    if (derived && derived.status === 'READY') {
      historicalVolume = derived;
    }
  }

  const waitReasons: string[] = [];
  const blockingMissingData = coreMissingData(provenance.missingData);

  if (provenance.stale) {
    waitReasons.push('資料已過期 (Stale Data)：行情或 K 線時間戳超出有效範圍');
  }
  if (blockingMissingData.length > 0) {
    waitReasons.push(`基礎欄位缺失：${blockingMissingData.join(', ')}`);
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
    const dispAtrMin = isRelaxedMtfDisp ? 1.1 : 1.3;
    const dispBodyRatioMin = isRelaxedMtfDisp ? 0.55 : 0.6;
    for (let i = confirmedKlines.length - 1; i >= lookbackStart; i--) {
      const c = confirmedKlines[i];
      const body = Math.abs(c.close - c.open);
      const range = Math.max(c.high - c.low, 1e-9);
      const bodyToAtr = body / atr14;
      const bodyToRange = body / range;

      let matchedDir: 'BULL' | 'BEAR' | null = null;
      let matchedAtrRatio = bodyToAtr;
      let matchedDesc = '';

      if (bodyToAtr >= dispAtrMin && bodyToRange >= dispBodyRatioMin) {
        matchedDir = c.close > c.open ? 'BULL' : 'BEAR';
        matchedAtrRatio = bodyToAtr;
        matchedDesc = `已確認 ${matchedDir === 'BULL' ? '多頭' : '空頭'}位移 K 線 (實體為 ${bodyToAtr.toFixed(2)}x ATR，實體佔比 ${(bodyToRange * 100).toFixed(0)}%)`;
      } else if (isRelaxedMtfDisp && i >= lookbackStart + 1) {
        const prev = confirmedKlines[i - 1];
        const bothBull = c.close > c.open && prev.close > prev.open;
        const bothBear = c.close < c.open && prev.close < prev.open;
        if (bothBull || bothBear) {
          const twoBarMove = Math.abs(c.close - prev.open);
          const twoBarBody =
            Math.abs(c.close - c.open) + Math.abs(prev.close - prev.open);
          const twoBarRange = Math.max(
            Math.max(c.high, prev.high) - Math.min(c.low, prev.low),
            1e-9
          );
          const twoBarAtr = twoBarMove / atr14;
          const twoBarBodyRatio = twoBarBody / twoBarRange;
          if (twoBarAtr >= 1.5 && twoBarBodyRatio >= 0.55) {
            matchedDir = bothBull ? 'BULL' : 'BEAR';
            matchedAtrRatio = twoBarAtr;
            matchedDesc = `已確認 ${matchedDir === 'BULL' ? '多頭' : '空頭'}連續雙K位移推進 (累積為 ${twoBarAtr.toFixed(2)}x ATR，實體佔比 ${(twoBarBodyRatio * 100).toFixed(0)}%)`;
          }
        }
      }

      if (matchedDir) {
        displacement = {
          detected: true,
          direction: matchedDir,
          bodyToAtrRatio: Number(matchedAtrRatio.toFixed(2)),
          candleTime: c.openTime,
          description: matchedDesc,
        };

        const ob = detectStrictOrderBlock({
          confirmed: confirmedKlines,
          displacementIndex: i,
          direction: matchedDir,
          atr14,
        });
        orderBlock = ob.evidence;
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
        // CHoCH / MSS: the broken high is itself a lower high, or the last two swing lows are descending.
        const prevSwingHigh = priorHighs.length >= 2 ? priorHighs[priorHighs.length - 2] : null;
        const lastTwoLows = priorLows.slice(-2);
        const wasDowntrend =
          (prevSwingHigh !== null && refSwingHigh.price < prevSwingHigh.price) ||
          (lastTwoLows.length === 2 && lastTwoLows[1].price < lastTwoLows[0].price);
        const isMss = wasDowntrend;
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
        const prevSwingLow = priorLows.length >= 2 ? priorLows[priorLows.length - 2] : null;
        const lastTwoHighs = priorHighs.slice(-2);
        const wasUptrend =
          (prevSwingLow !== null && refSwingLow.price > prevSwingLow.price) ||
          (lastTwoHighs.length === 2 && lastTwoHighs[1].price > lastTwoHighs[0].price);
        const isMss = wasUptrend;
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

    // 4. Liquidity Sweep: wick through a confirmed swing / equal-high-low pool, close back inside.
    liquiditySweep = detectConfirmedLiquiditySweep(confirmedKlines, atr14);

    // 5. Fair Value Gap (FVG): keep every recent unfilled / partially filled 3-candle gap.
    const fvgZones = collectUnfilledFvgZones(confirmedKlines, 24);
    const liveFvgZones = fvgZones.filter((z) => !z.mitigated);
    const preferredFvgDir: 'BULL' | 'BEAR' | 'NONE' =
      displacement.detected && (displacement.direction === 'BULL' || displacement.direction === 'BEAR')
        ? displacement.direction
        : 'NONE';
    const primaryFvg = selectPrimaryFvg(liveFvgZones, preferredFvgDir);
    if (primaryFvg) {
      const fillPct = Math.round(primaryFvg.fillRatio * 100);
      fvg = {
        detected: true,
        direction: primaryFvg.direction,
        top: primaryFvg.top,
        bottom: primaryFvg.bottom,
        mitigated: false,
        candleTime: primaryFvg.candleTime,
        fillRatio: primaryFvg.fillRatio,
        zones: fvgZones,
        description: `${primaryFvg.direction === 'BULL' ? '多頭' : '空頭'} FVG 失衡區 [${primaryFvg.bottom} – ${primaryFvg.top}]（回補 ${fillPct}%，尚有 ${liveFvgZones.length} 個未完全回補缺口）`,
      };
    } else if (fvgZones.length > 0) {
      const latest = fvgZones[0];
      fvg = {
        detected: true,
        direction: latest.direction,
        top: latest.top,
        bottom: latest.bottom,
        mitigated: true,
        candleTime: latest.candleTime,
        fillRatio: latest.fillRatio,
        zones: fvgZones,
        description: `近期 FVG 均已完全回補（共 ${fvgZones.length} 個）`,
      };
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
  } else if (isRelaxedMtfDisp) {
    const coreTfs = (['15m', '1h', '4h'] as Timeframe[]).filter(
      (tf) => byTimeframe[tf] !== 'MISSING'
    );
    const evalBiases =
      coreTfs.length > 0 ? coreTfs.map((tf) => byTimeframe[tf]) : availableBiases;
    const coreBull = evalBiases.filter((b) => b === 'BULL').length;
    const coreBear = evalBiases.filter((b) => b === 'BEAR').length;
    const htfBull =
      (byTimeframe['1h'] === 'BULL' ? 1 : 0) +
      (byTimeframe['4h'] === 'BULL' ? 1 : 0);
    const htfBear =
      (byTimeframe['1h'] === 'BEAR' ? 1 : 0) +
      (byTimeframe['4h'] === 'BEAR' ? 1 : 0);
    const primaryBias = byTimeframe[primaryTimeframe];
    const htfConflict =
      (byTimeframe['1h'] === 'BULL' && byTimeframe['4h'] === 'BEAR') ||
      (byTimeframe['1h'] === 'BEAR' && byTimeframe['4h'] === 'BULL');

    if (htfConflict) {
      mtfAlignment = {
        aligned: false,
        dominantDirection: 'CONFLICT',
        byTimeframe,
        description: `高週期 1h (${byTimeframe['1h']}) 與 4h (${byTimeframe['4h']}) 方向直接衝突`,
      };
    } else if (
      coreBull > coreBear &&
      (primaryBias === 'BULL' || primaryBias === 'NEUTRAL' || htfBull === 2) &&
      !(byTimeframe['1h'] === 'BEAR' && byTimeframe['4h'] === 'BEAR')
    ) {
      mtfAlignment = {
        aligned: true,
        dominantDirection: 'BULL',
        byTimeframe,
        description: `多週期核心偏多共識 (15m/1h/4h 多:${coreBull} 空:${coreBear})`,
      };
    } else if (
      coreBear > coreBull &&
      (primaryBias === 'BEAR' || primaryBias === 'NEUTRAL' || htfBear === 2) &&
      !(byTimeframe['1h'] === 'BULL' && byTimeframe['4h'] === 'BULL')
    ) {
      mtfAlignment = {
        aligned: true,
        dominantDirection: 'BEAR',
        byTimeframe,
        description: `多週期核心偏空共識 (15m/1h/4h 空:${coreBear} 多:${coreBull})`,
      };
    } else if (coreBull > 0 && coreBear > 0) {
      mtfAlignment = {
        aligned: false,
        dominantDirection: 'CONFLICT',
        byTimeframe,
        description: `多週期結構方向分歧 (多頭週期: ${coreBull}, 空頭週期: ${coreBear})`,
      };
    } else {
      mtfAlignment = {
        aligned: false,
        dominantDirection: 'INSUFFICIENT',
        byTimeframe,
        description: '多週期處於盤整中性，尚未形成單邊共振',
      };
    }
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

  const hasInternalConflict = bullSignalCount > 0 && bearSignalCount > 0;
  const resolvedBullByStructure =
    hasBullBos && bullSignalCount > bearSignalCount;
  const resolvedBearByStructure =
    hasBearBos && bearSignalCount > bullSignalCount;
  const blockingInternalConflict = isRelaxedMtfDisp
    ? hasInternalConflict &&
      !resolvedBullByStructure &&
      !resolvedBearByStructure
    : hasInternalConflict;

  if (blockingInternalConflict) {
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
    blockingMissingData.length === 0 &&
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

  const bullSweepGate = requireSweep ? hasBullSweep : true;
  const bearSweepGate = requireSweep ? hasBearSweep : true;

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
    bullSweepGate &&
    hasBullDisplacement &&
    hasBullFvgOrOb &&
    hasBullMtf
  ) {
    actionState = 'LONG CANDIDATE';
  } else if (
    hasAllRequiredData &&
    hasValidAtrAndRisk &&
    hasBearBos &&
    bearSweepGate &&
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
      if (requireSweep && !hasBullSweep) missingBull.push('Sell-Side Liquidity Sweep');
      if (!hasBullDisplacement) missingBull.push('多頭 Displacement 位移 K 線');
      if (!hasBullFvgOrOb) missingBull.push('多頭未回補 FVG 或 Order Block');
      if (!hasBullMtf) missingBull.push('多週期多頭一致性 (MTF Alignment)');
      waitReasons.push(
        `已偵測部分多頭結構證據，但尚未完成全部 SMC 必要確認條件（缺少：${missingBull.join('、')}），維持 WATCH`
      );
    } else {
      const missingBear: string[] = [];
      if (!hasBearBos) missingBear.push('BOS/MSS 空頭結構突破');
      if (requireSweep && !hasBearSweep) missingBear.push('Buy-Side Liquidity Sweep');
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
    if (blockingInternalConflict) {
      missingGates.push('INTERNAL_DIRECTION_CONFLICT');
    }
    if (!dirBosPassed) missingGates.push('BOS_MSS');
    if (requireSweep && !dirSweepPassed) missingGates.push('LIQUIDITY_SWEEP');
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

  const earlyInflection = detectEarlyInflection(
    klinesByTimeframe['5m'],
    klinesByTimeframe['15m']
  );

  const entryZoneDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
    intendedDirection !== 'NEUTRAL'
      ? intendedDirection
      : earlyInflection.direction;

  const entryZoneAnalysis =
    lastConfirmed && lastConfirmed.close > 0
      ? computeEntryZoneAnalysis({
          direction: entryZoneDirection,
          currentPrice: lastConfirmed.close,
          atr14,
          fvg,
          orderBlock,
          liquiditySweep,
        })
      : null;

  const tradeHorizon = classifyTradeHorizon({
    smcActionState: actionState,
    intendedDirection,
    mtfAlignment,
    atrPercent,
    priceChangePercent24h: 0,
    quoteVolume24h: 50_000_000,
    fundingRate: null,
    entryZoneAnalysis,
    earlyIgnition: null,
    bosOrMssDetected: bosOrMss.detected,
    displacementDetected: displacement.detected,
    rvol: null,
  });

  return {
    symbol,
    primaryTimeframe,
    ruleVersion: getSmcRuleVersionForProfile(ruleProfile),
    ruleProfile,
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
    earlyInflection,
    entryZoneAnalysis,
    tradeHorizon,
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
  marketRegime?: string;
  fundingState?: string;
  liquidityState?: string;
  mtfAlignmentState?: string;
  dataFreshnessSeconds?: number | null;
  stale?: boolean;
  isDemo?: boolean;
  isTestFixture?: boolean;
  evidenceType?: 'LIVE_PRODUCTION' | 'CONTROLLED_LIVE_FIXTURE' | 'DEMO_LATENCY_FIXTURE';
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
  const strictStrategyValidity =
    strictPaperClosed >= 30 ? ('VALIDATED' as const) : ('INSUFFICIENT_SAMPLE' as const);

  // Phase 18.5 Requirement 四: paperClosedCount < 30 -> winRate/averageR/profitFactor/maxDrawdownR/expectancyR MUST be null and strategyValidity = "INSUFFICIENT_SAMPLE"
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
    winRate: strictPaperClosed >= 30 ? (strictOutcome?.winRate ?? null) : null,
    averageR: strictPaperClosed >= 30 ? (strictOutcome?.averageR ?? null) : null,
    profitFactor:
      strictPaperClosed >= 30 ? (strictOutcome?.profitFactor ?? null) : null,
    maxDrawdownR:
      strictPaperClosed >= 30 ? (strictOutcome?.maxDrawdownR ?? null) : null,
    expectancyR:
      strictPaperClosed >= 30 ? (strictOutcome?.expectancyR ?? null) : null,
    sampleSufficiency: strictSufficiency as 'INSUFFICIENT' | 'LIMITED' | 'SUFFICIENT',
    strategyValidity: strictStrategyValidity,
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
    strategyValidity: 'INSUFFICIENT_SAMPLE' as const,
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
    strategyValidity: 'INSUFFICIENT_SAMPLE' as const,
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
        const resolvedMarketRegime =
          item.marketRegime ??
          (item.marketRadarCategory === '雷達多頭觀察'
            ? 'BULLISH_TREND'
            : item.marketRadarCategory === '雷達空頭觀察'
              ? 'BEARISH_TREND'
              : !g.atrPassed || !g.riskSafetyPassed
                ? 'HIGH_VOLATILITY'
                : 'RANGING_CONSOLIDATION');
        const resolvedFundingState =
          item.fundingState ??
          (!g.fundingPassed
            ? 'FUNDING_MISSING_OR_EXTREME'
            : !g.riskSafetyPassed
              ? 'EXTREME_FUNDING_RISK'
              : 'NORMAL_FUNDING');
        const resolvedLiquidityState =
          item.liquidityState ??
          (!g.liquiditySafetyPassed
            ? 'LOW_LIQUIDITY_OR_WIDE_SPREAD'
            : g.liquiditySweepPassed
              ? 'LIQUIDITY_SWEEP_CONFIRMED'
              : 'ADEQUATE_LIQUIDITY_NO_SWEEP');
        const resolvedMtfAlignmentState =
          item.mtfAlignmentState ??
          (g.mtfAlignmentPassed
            ? g.intendedDirection === 'LONG'
              ? 'ALIGNED_BULL'
              : g.intendedDirection === 'SHORT'
                ? 'ALIGNED_BEAR'
                : 'MTF_ALIGNED'
            : 'MTF_CONFLICT_OR_UNALIGNED');
        const resolvedIsDemo = Boolean(item.isDemo);
        const resolvedEvidenceType =
          item.evidenceType ??
          (resolvedIsDemo ? 'DEMO_LATENCY_FIXTURE' : 'LIVE_PRODUCTION');
        const resolvedIsTestFixture =
          item.isTestFixture ?? resolvedEvidenceType !== 'LIVE_PRODUCTION';

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
          marketRegime: resolvedMarketRegime,
          fundingState: resolvedFundingState,
          liquidityState: resolvedLiquidityState,
          mtfAlignmentState: resolvedMtfAlignmentState,
          dataFreshnessSeconds: item.dataFreshnessSeconds ?? null,
          stale: item.stale ?? false,
          isDemo: resolvedIsDemo,
          isTestFixture: resolvedIsTestFixture,
          evidenceType: resolvedEvidenceType,
          isFastLane: item.isFastLane ?? false,
          cycleId: options?.cycleId,
          observedAt: options?.snapshotAt,
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





