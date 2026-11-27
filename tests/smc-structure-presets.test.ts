import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  collectUnfilledFvgZones,
  detectConfirmedLiquiditySweep,
  findConfirmedSwingPoints,
  SWING_CONFIRMATION_BARS,
} from '../server/engine/SmcRuleEngine.ts';
import {
  resolveSmcStructureConfig,
  SMC_STRUCTURE_PRESETS,
} from '../server/engine/SmcStructureConfig.ts';
import type { Kline } from '../src/types/market.ts';

const originalPreset = process.env.SMC_STRUCTURE_PRESET;

after(() => {
  if (originalPreset === undefined) delete process.env.SMC_STRUCTURE_PRESET;
  else process.env.SMC_STRUCTURE_PRESET = originalPreset;
});

function candle(index: number, open: number, high: number, low: number, close: number): Kline {
  const openTime = index * 60_000;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 1,
    closeTime: openTime + 59_000,
    quoteVolume: 10,
    isClosed: true,
  };
}

describe('SMC structure presets', () => {
  it('keeps standard equal to the previous hard-coded thresholds', () => {
    const standard = resolveSmcStructureConfig();
    assert.equal(standard.preset, 'standard');
    assert.equal(standard.swingConfirmationBars, SWING_CONFIRMATION_BARS);
    assert.equal(standard.swingConfirmationBars, 2);
    assert.equal(standard.minFvgAtrMultiple, 0);
    assert.equal(standard.obMinBodyToAtr, 0.25);
    assert.equal(standard.obMinBodyToRange, 0.4);
    assert.equal(standard.sweepMinPenetrationAtr, 0);
    assert.equal(standard.displacementAtrMultiple, 1.3);
    assert.equal(standard.displacementBodyRatio, 0.6);
    assert.equal(SMC_STRUCTURE_PRESETS.conservative.swingConfirmationBars, 3);
    assert.ok(
      SMC_STRUCTURE_PRESETS.conservative.displacementAtrMultiple >
        SMC_STRUCTURE_PRESETS.standard.displacementAtrMultiple
    );
    assert.ok(
      SMC_STRUCTURE_PRESETS.aggressive.displacementAtrMultiple <
        SMC_STRUCTURE_PRESETS.standard.displacementAtrMultiple
    );
    assert.ok(
      SMC_STRUCTURE_PRESETS.conservative.sequenceWindowBars <
        SMC_STRUCTURE_PRESETS.standard.sequenceWindowBars
    );
    assert.ok(
      SMC_STRUCTURE_PRESETS.aggressive.sequenceWindowBars >
        SMC_STRUCTURE_PRESETS.standard.sequenceWindowBars
    );
  });

  it('selects a preset from the environment and from an explicit argument', () => {
    process.env.SMC_STRUCTURE_PRESET = 'conservative';
    assert.equal(resolveSmcStructureConfig().preset, 'conservative');
    assert.equal(resolveSmcStructureConfig({ preset: 'aggressive' }).preset, 'aggressive');
    delete process.env.SMC_STRUCTURE_PRESET;
  });

  it('changes swing, FVG and sweep sensitivity with the preset numbers', () => {
    const bars: Kline[] = [];
    for (let i = 0; i < 20; i++) bars.push(candle(i, 100, 101, 99, 100));
    bars[6] = candle(6, 100, 101, 90, 95);
    bars[8] = candle(8, 100, 130, 99, 120);
    const strict = findConfirmedSwingPoints(bars, SMC_STRUCTURE_PRESETS.conservative.swingConfirmationBars);
    const loose = findConfirmedSwingPoints(bars, SMC_STRUCTURE_PRESETS.aggressive.swingConfirmationBars);
    assert.ok(loose.swingLows.length >= strict.swingLows.length);

    const fvgBars: Kline[] = [];
    for (let i = 0; i < 8; i++) fvgBars.push(candle(i, 100, 101, 99, 100));
    fvgBars[2] = candle(2, 100, 100.2, 99.8, 100);
    fvgBars[3] = candle(3, 100.3, 100.6, 100.2, 100.5);
    fvgBars[4] = candle(4, 100.5, 100.8, 100.4, 100.7);
    const anyGap = collectUnfilledFvgZones(fvgBars, 8, { atr14: 2, minFvgAtrMultiple: 0 });
    const largeOnly = collectUnfilledFvgZones(fvgBars, 8, {
      atr14: 2,
      minFvgAtrMultiple: SMC_STRUCTURE_PRESETS.conservative.minFvgAtrMultiple,
    });
    assert.ok(anyGap.length >= 1);
    assert.equal(largeOnly.length, 0);

    const sweepBars: Kline[] = [];
    for (let i = 0; i < 24; i++) sweepBars.push(candle(i, 100, 102, 98, 100));
    sweepBars[8] = candle(8, 100, 101, 90, 96);
    // Pierce only 0.5 under the pool. A later, separated low keeps this wick
    // from becoming its own confirmed swing.
    sweepBars[16] = candle(16, 95, 97, 89.5, 94);
    sweepBars[18] = candle(18, 88, 89, 85, 86);
    const shallow = detectConfirmedLiquiditySweep(sweepBars, 10, 20, {
      swingConfirmationBars: 2,
      sweepMinPenetrationAtr: 0,
    });
    const deep = detectConfirmedLiquiditySweep(sweepBars, 10, 20, {
      swingConfirmationBars: 2,
      sweepMinPenetrationAtr: 0.08,
    });
    assert.equal(shallow.detected, true);
    assert.equal(deep.detected, false);
  });
});
