import {
  DealingRangeLabel,
  DealingRangeZone,
  Kline,
  PremiumDiscountRange,
  Timeframe,
} from '../../src/types/market.ts';
import { findConfirmedSwingPoints } from './SmcRuleEngine.ts';

const OTE_SHALLOW = 0.62;
const OTE_DEEP = 0.79;
const OTE_SWEET = 0.705;

/** Default closed-bar window. 59 bars missed ZEC's 676–761 range; 69 bars contained it. */
export const DEFAULT_DEALING_RANGE_LOOKBACK = 120;

/**
 * A tiny retrace is ignored when its span is below this fraction of the largest
 * price-bracketing swing pair in the lookback. Keeps the impulse (BTW 0.936→1.199)
 * instead of the last 15m leg (1.199→1.0667).
 */
const DOMINANT_SPAN_FRACTION = 0.55;

export interface DealingRangeImpulse {
  low: number;
  high: number;
  /** LONG impulse prints the high later. SHORT impulse prints the low later. */
  direction?: 'LONG' | 'SHORT';
}

export interface PremiumDiscountInput {
  candles: Kline[];
  price: number;
  swingConfirmationBars?: number;
  timeframe?: Timeframe;
  /** How many of the most recent closed bars may define the dealing range. */
  lookbackBars?: number;
  /**
   * Impulse that printed the event sequence, when one exists.
   * Used when it still brackets price and is not a micro leg.
   */
  impulse?: DealingRangeImpulse | null;
}

interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

interface Bracket {
  high: SwingPoint;
  low: SwingPoint;
  span: number;
  later: number;
}

function bracketsPrice(low: number, high: number, price: number): boolean {
  return high > low && price >= low && price <= high;
}

/**
 * Dominant dealing range inside the lookback.
 * Among swing pairs that still contain price, drop micro retraces and keep the
 * most recent pair whose span is at least 55% of the largest bracket.
 * An explicit sequence impulse wins when it is one of those dominant brackets.
 */
function selectDominantBracket(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
  price: number,
  impulse?: DealingRangeImpulse | null
): {
  highPrice: number;
  lowPrice: number;
  highIndex: number | null;
  lowIndex: number | null;
  highTime: number | null;
  lowTime: number | null;
  laterIsHigh: boolean;
} | null {
  const pairs: Bracket[] = [];
  for (const high of swingHighs) {
    for (const low of swingLows) {
      if (!bracketsPrice(low.price, high.price, price)) continue;
      pairs.push({
        high,
        low,
        span: high.price - low.price,
        later: Math.max(high.index, low.index),
      });
    }
  }
  if (impulse && bracketsPrice(impulse.low, impulse.high, price)) {
    const span = impulse.high - impulse.low;
    const maxSpan = pairs.reduce((max, pair) => Math.max(max, pair.span), span);
    if (span >= maxSpan * DOMINANT_SPAN_FRACTION) {
      return {
        highPrice: impulse.high,
        lowPrice: impulse.low,
        highIndex: null,
        lowIndex: null,
        highTime: null,
        lowTime: null,
        laterIsHigh: impulse.direction !== 'SHORT',
      };
    }
  }
  if (pairs.length === 0) return null;
  const maxSpan = Math.max(...pairs.map((pair) => pair.span));
  const significant = pairs.filter((pair) => pair.span + 1e-12 >= maxSpan * DOMINANT_SPAN_FRACTION);
  significant.sort((a, b) => b.span - a.span || b.later - a.later);
  const chosen = significant[0];
  return {
    highPrice: chosen.high.price,
    lowPrice: chosen.low.price,
    highIndex: chosen.high.index,
    lowIndex: chosen.low.index,
    highTime: chosen.high.time,
    lowTime: chosen.low.time,
    laterIsHigh: chosen.high.index >= chosen.low.index,
  };
}

/**
 * Dealing range = the dominant swing leg that still contains price, not the
 * tightest recent 15m retrace. Position 0 is the range low, 100 is the range high.
 *
 * OTE is the 0.62–0.79 retracement of that impulse:
 * - later swing is the high → bullish retracement (OTE sits in discount)
 * - later swing is the low → bearish retracement (OTE sits in premium)
 *
 * Price outside every confirmed swing in the lookback is UNAVAILABLE.
 * That is a failed location gate, not a free pass.
 */
export function computePremiumDiscount(input: PremiumDiscountInput): PremiumDiscountRange {
  const timeframe = input.timeframe;
  const empty = (zone: DealingRangeZone): PremiumDiscountRange => ({
    timeframe,
    rangeHigh: null,
    rangeLow: null,
    equilibrium: null,
    pricePositionPct: null,
    zone,
    labels: [],
    inOte: false,
    oteLow: null,
    oteHigh: null,
    oteSweetSpot: null,
    oteDirection: 'NONE',
  });

  const price = input.price;
  if (!Number.isFinite(price) || price <= 0) return empty('UNAVAILABLE');

  const confirmedAll = (input.candles ?? []).filter((k) => k && k.isClosed !== false);
  const lookback = Math.max(8, Math.round(input.lookbackBars ?? DEFAULT_DEALING_RANGE_LOOKBACK));
  const confirmed = confirmedAll.slice(-lookback);
  if (confirmed.length < 5) return empty('UNAVAILABLE');

  const bars = input.swingConfirmationBars ?? 2;
  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed, bars);
  const chosen = selectDominantBracket(swingHighs, swingLows, price, input.impulse);
  if (!chosen) return empty('UNAVAILABLE');
  const high = { price: chosen.highPrice, index: chosen.highIndex, time: chosen.highTime };
  const low = { price: chosen.lowPrice, index: chosen.lowIndex, time: chosen.lowTime };

  const span = high.price - low.price;
  const position = ((price - low.price) / span) * 100;
  const pricePositionPct = Number(position.toFixed(4));
  let zone: DealingRangeZone;
  if (Math.abs(pricePositionPct - 50) < 0.0001) zone = 'EQUILIBRIUM';
  else if (pricePositionPct < 50) zone = 'DISCOUNT';
  else zone = 'PREMIUM';

  const bullishRetrace = chosen.laterIsHigh;
  const oteDirection: 'BULL' | 'BEAR' = bullishRetrace ? 'BULL' : 'BEAR';
  const shallow = bullishRetrace
    ? high.price - OTE_SHALLOW * span
    : low.price + OTE_SHALLOW * span;
  const deep = bullishRetrace
    ? high.price - OTE_DEEP * span
    : low.price + OTE_DEEP * span;
  const sweet = bullishRetrace
    ? high.price - OTE_SWEET * span
    : low.price + OTE_SWEET * span;
  const oteLow = Number(Math.min(shallow, deep).toFixed(8));
  const oteHigh = Number(Math.max(shallow, deep).toFixed(8));
  const oteSweetSpot = Number(sweet.toFixed(8));
  const inOte = price >= oteLow && price <= oteHigh;

  const labels: DealingRangeLabel[] = [];
  if (zone === 'DISCOUNT') labels.push('IN_DISCOUNT');
  else if (zone === 'PREMIUM') labels.push('IN_PREMIUM');
  else labels.push('AT_EQUILIBRIUM');
  if (inOte) labels.push('IN_OTE');

  return {
    timeframe,
    rangeHigh: high.price,
    rangeLow: low.price,
    equilibrium: Number(((high.price + low.price) / 2).toFixed(8)),
    pricePositionPct,
    zone,
    labels,
    inOte,
    oteLow,
    oteHigh,
    oteSweetSpot,
    oteDirection,
    swingHighIndex: high.index,
    swingLowIndex: low.index,
    swingHighTime: high.time,
    swingLowTime: low.time,
  };
}
