import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computePremiumDiscount } from '../server/engine/PremiumDiscount.ts';
import type { Kline } from '../src/types/market.ts';

function candle(index: number, open: number, high: number, low: number, close: number): Kline {
  const openTime = 1_700_000_000_000 + index * 60_000;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 1,
    closeTime: openTime + 59_000,
    quoteVolume: 100,
    isClosed: true,
  };
}

/**
 * Confirmation of 2: swing low at index 4 (low 100), swing high at index 10 (high 200).
 * Neighbors stay inside (110, 190) so only those two pivots print.
 */
function dealingRange(): Kline[] {
  const bars: Kline[] = [];
  for (let i = 0; i < 16; i++) {
    bars.push(candle(i, 150, 160, 140, 150));
  }
  bars[4] = candle(4, 130, 135, 100, 120);
  bars[10] = candle(10, 170, 200, 165, 180);
  return bars;
}

describe('premium / discount / OTE', () => {
  it('places a bullish retracement in discount and inside the 0.62–0.79 OTE', () => {
    const candles = dealingRange();
    // Later swing is the high → bullish OTE.
    // OTE = 200 - 0.79*(100) .. 200 - 0.62*(100) = 121 .. 138
    const price = 130;
    const zone = computePremiumDiscount({
      candles,
      price,
      swingConfirmationBars: 2,
      timeframe: '15m',
    });
    assert.equal(zone.rangeLow, 100);
    assert.equal(zone.rangeHigh, 200);
    assert.equal(zone.equilibrium, 150);
    assert.equal(zone.pricePositionPct, 30);
    assert.equal(zone.zone, 'DISCOUNT');
    assert.equal(zone.oteDirection, 'BULL');
    assert.ok(Math.abs((zone.oteLow ?? 0) - 121) < 1e-6);
    assert.ok(Math.abs((zone.oteHigh ?? 0) - 138) < 1e-6);
    assert.ok(Math.abs((zone.oteSweetSpot ?? 0) - (200 - 0.705 * 100)) < 1e-6);
    assert.equal(zone.inOte, true);
    assert.deepEqual(zone.labels, ['IN_DISCOUNT', 'IN_OTE']);
  });

  it('mirrors a bearish retracement into premium OTE', () => {
    const candles = dealingRange();
    // Move the swing low to after the swing high so the later extreme is the low.
    const bearish = candles.map((bar, index) => ({ ...bar }));
    bearish[4] = candle(4, 170, 200, 165, 180);
    bearish[10] = candle(10, 130, 135, 100, 120);
    const price = 170;
    const zone = computePremiumDiscount({
      candles: bearish,
      price,
      swingConfirmationBars: 2,
      timeframe: '5m',
    });
    assert.equal(zone.rangeLow, 100);
    assert.equal(zone.rangeHigh, 200);
    assert.equal(zone.zone, 'PREMIUM');
    assert.equal(zone.oteDirection, 'BEAR');
    assert.equal(zone.pricePositionPct, 70);
    assert.ok(Math.abs((zone.oteLow ?? 0) - 162) < 1e-6);
    assert.ok(Math.abs((zone.oteHigh ?? 0) - 179) < 1e-6);
    assert.ok(Math.abs((zone.oteSweetSpot ?? 0) - 170.5) < 1e-6);
    assert.equal(zone.inOte, true);
    assert.ok(zone.labels.includes('IN_PREMIUM'));
    assert.ok(zone.labels.includes('IN_OTE'));
  });

  it('marks equilibrium at 50% and leaves a breakout without a bounding range', () => {
    const candles = dealingRange();
    const mid = computePremiumDiscount({
      candles,
      price: 150,
      swingConfirmationBars: 2,
    });
    assert.equal(mid.zone, 'EQUILIBRIUM');
    assert.deepEqual(mid.labels, ['AT_EQUILIBRIUM']);
    assert.equal(mid.inOte, false);

    const outside = computePremiumDiscount({
      candles,
      price: 250,
      swingConfirmationBars: 2,
    });
    assert.equal(outside.zone, 'UNAVAILABLE');
    assert.equal(outside.rangeHigh, null);
    assert.deepEqual(outside.labels, []);
  });
});
