import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectBestEventSequence } from '../server/engine/SmcEventSequence.ts';
import { SMC_STRUCTURE_PRESETS, type SmcStructureConfig } from '../server/engine/SmcStructureConfig.ts';
import type { Kline } from '../src/types/market.ts';

const config: SmcStructureConfig = {
  ...SMC_STRUCTURE_PRESETS.standard,
  displacementAtrMultiple: 0.25,
  displacementBodyRatio: 0.45,
  sequenceWindowBars: 12,
  minFvgAtrMultiple: 0,
  sweepMinPenetrationAtr: 0,
  swingConfirmationBars: 2,
};

function candle(index: number, open: number, high: number, low: number, close: number): Kline {
  const openTime = 1_700_000_000_000 + index * 60_000;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 10,
    closeTime: openTime + 59_000,
    quoteVolume: 1000,
    isClosed: true,
  };
}

function baseBars(count: number): Kline[] {
  const bars: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const up = i % 2 === 0;
    bars.push(candle(i, up ? 100 : 101, up ? 102 : 103, up ? 98 : 99, up ? 101 : 100));
  }
  return bars;
}

function orderedLong(): Kline[] {
  const bars = baseBars(30);
  bars[8] = candle(8, 110, 130, 108, 125);
  bars[14] = candle(14, 96, 98, 80, 92);
  bars[18] = candle(18, 90, 94, 70, 88);
  bars[20] = candle(20, 100, 134, 99, 132);
  bars[21] = candle(21, 136, 170, 135, 168);
  bars[22] = candle(22, 150, 158, 140, 155);
  for (let i = 23; i < bars.length; i++) {
    bars[i] = candle(i, 160, 168, 150, 162);
  }
  return bars;
}

describe('SMC event sequence', () => {
  it('completes a long sequence only when the steps are in order', () => {
    const done = detectBestEventSequence(orderedLong(), config);
    assert.equal(done.direction, 'LONG');
    assert.equal(done.isComplete, true);
    assert.equal(done.informational, true);
    assert.equal(done.completedStepCount, 4);
    const [sweep, mss, disp, poi] = done.steps;
    assert.equal(sweep.complete, true);
    assert.equal(mss.complete, true);
    assert.equal(disp.complete, true);
    assert.equal(poi.complete, true);
    assert.ok((sweep.barIndex ?? 0) < (mss.barIndex ?? 0));
    assert.ok((mss.barIndex ?? 0) <= (disp.barIndex ?? 0));
    assert.equal(sweep.timestamp, orderedLong()[sweep.barIndex!].openTime);
  });

  it('does not treat an MSS that printed before the sweep as the sequence break', () => {
    const bars = baseBars(30);
    bars[8] = candle(8, 110, 130, 108, 125);
    bars[14] = candle(14, 96, 98, 80, 92);
    bars[16] = candle(16, 100, 134, 99, 132);
    bars[20] = candle(20, 90, 94, 70, 88);
    bars[22] = candle(22, 96, 104, 94, 102);
    const seq = detectBestEventSequence(bars, config);
    const sweep = seq.steps.find((step) => step.key === 'LIQUIDITY_SWEEP');
    const mss = seq.steps.find((step) => step.key === 'MSS_CHOCH');
    assert.equal(sweep?.complete, true);
    assert.equal(mss?.complete, false);
    assert.equal(seq.isComplete, false);
  });

  it('drops displacement that falls outside the bar window', () => {
    const bars = baseBars(48);
    bars[8] = candle(8, 110, 130, 108, 125);
    bars[10] = candle(10, 96, 98, 80, 92);
    bars[14] = candle(14, 90, 94, 70, 88);
    bars[15] = candle(15, 88, 92, 70, 90);
    bars[16] = candle(16, 128, 133, 127, 131);
    bars[40] = candle(40, 136, 190, 135, 188);
    bars[41] = candle(41, 170, 180, 160, 175);
    const seq = detectBestEventSequence(bars, {
      ...config,
      displacementAtrMultiple: 1.2,
      sequenceWindowBars: 8,
    });
    assert.equal(seq.isComplete, false);
    const sweep = seq.steps.find((step) => step.key === 'LIQUIDITY_SWEEP');
    const mss = seq.steps.find((step) => step.key === 'MSS_CHOCH');
    const disp = seq.steps.find((step) => step.key === 'DISPLACEMENT');
    assert.equal(sweep?.complete, true);
    assert.equal(mss?.complete, true);
    assert.equal(disp?.complete, false);
    assert.ok((mss?.barIndex ?? 0) - (sweep?.barIndex ?? 0) <= 8);
  });

  it('invalidates a long sequence after a later candle breaks the sweep low', () => {
    const bars = orderedLong();
    const live = detectBestEventSequence(bars, config);
    assert.equal(live.isComplete, true);
    assert.equal(live.invalidated, false);
    const sweepLevel = live.sweepLevel ?? 0;
    bars.push(candle(bars.length, sweepLevel, sweepLevel + 1, sweepLevel - 0.5, sweepLevel - 0.2));
    const broken = detectBestEventSequence(bars, config);
    assert.equal(broken.invalidated, true);
    assert.equal(broken.isComplete, false);
    assert.ok((broken.invalidationReasonZh ?? '').includes('掃單'));
  });
});
