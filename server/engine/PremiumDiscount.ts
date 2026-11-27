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

export interface PremiumDiscountInput {
  candles: Kline[];
  price: number;
  swingConfirmationBars?: number;
  timeframe?: Timeframe;
}

/**
 * Dealing range = the most recent confirmed swing high at or above price
 * and the most recent confirmed swing low at or below price.
 * Position 0 is the range low, 100 is the range high, equilibrium is 50.
 *
 * OTE is the 0.62–0.79 retracement of the impulse that printed the later swing:
 * - later swing is the high → bullish retracement (OTE sits in discount)
 * - later swing is the low → bearish retracement (OTE sits in premium)
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

  const confirmed = (input.candles ?? []).filter((k) => k && k.isClosed !== false);
  if (confirmed.length < 5) return empty('UNAVAILABLE');

  const bars = input.swingConfirmationBars ?? 2;
  const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed, bars);
  const high = [...swingHighs].reverse().find((s) => s.price >= price) ?? null;
  const low = [...swingLows].reverse().find((s) => s.price <= price) ?? null;
  if (!high || !low || !(high.price > low.price)) return empty('UNAVAILABLE');

  const span = high.price - low.price;
  const position = ((price - low.price) / span) * 100;
  const pricePositionPct = Number(position.toFixed(4));
  let zone: DealingRangeZone;
  if (Math.abs(pricePositionPct - 50) < 0.0001) zone = 'EQUILIBRIUM';
  else if (pricePositionPct < 50) zone = 'DISCOUNT';
  else zone = 'PREMIUM';

  const bullishRetrace = high.index >= low.index;
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
