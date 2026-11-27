import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  PremiumDiscountRange,
  SmcEventSequenceState,
  SmcMtfAlignment,
} from '../src/types/market.ts';
import {
  evaluateTradableLiquidity,
  resolveSignalDecision,
  type ResolveSignalInput,
  type SideStructureFlags,
} from '../server/engine/SignalConfidence.ts';
import {
  resolveSignalGatingConfig,
  SIGNAL_GATING_PRESETS,
} from '../server/engine/SignalGatingConfig.ts';

const noneFlags: SideStructureFlags = {
  bosOrMss: false,
  sweep: false,
  displacement: false,
  fvgOrOb: false,
};
const fullFlags: SideStructureFlags = {
  bosOrMss: true,
  sweep: true,
  displacement: true,
  fvgOrOb: true,
};

function mtf(direction: 'BULL' | 'BEAR' | 'CONFLICT'): SmcMtfAlignment {
  if (direction === 'CONFLICT') {
    return {
      aligned: false,
      dominantDirection: 'CONFLICT',
      byTimeframe: { '5m': 'BULL', '15m': 'BULL', '1h': 'BULL', '4h': 'BEAR' },
      description: '1h 與 4h 衝突',
    };
  }
  const bias = direction;
  return {
    aligned: true,
    dominantDirection: bias,
    byTimeframe: { '5m': bias, '15m': bias, '1h': bias, '4h': bias },
    description: bias,
  };
}

function sequence(direction: 'LONG' | 'SHORT', complete: boolean): SmcEventSequenceState {
  const step = (key: SmcEventSequenceState['steps'][number]['key'], done: boolean) => ({
    key,
    complete: done,
    barIndex: done ? 1 : null,
    timestamp: done ? 1 : null,
    detail: key,
  });
  return {
    direction: complete ? direction : 'NONE',
    isComplete: complete,
    windowBars: 24,
    completedStepCount: complete ? 4 : 0,
    informational: true,
    steps: [
      step('LIQUIDITY_SWEEP', complete),
      step('MSS_CHOCH', complete),
      step('DISPLACEMENT', complete),
      step('FVG_OR_OB', complete),
    ],
  };
}

function range(zone: 'DISCOUNT' | 'PREMIUM' | 'EQUILIBRIUM'): PremiumDiscountRange {
  const inOte = zone !== 'EQUILIBRIUM';
  return {
    zone,
    labels: zone === 'DISCOUNT' ? ['IN_DISCOUNT', 'IN_OTE'] : zone === 'PREMIUM' ? ['IN_PREMIUM', 'IN_OTE'] : ['AT_EQUILIBRIUM'],
    inOte,
    pricePositionPct: zone === 'DISCOUNT' ? 30 : zone === 'PREMIUM' ? 72 : 50,
    oteDirection: zone === 'PREMIUM' ? 'BEAR' : 'BULL',
    rangeHigh: 120,
    rangeLow: 80,
    equilibrium: 100,
    oteLow: 90,
    oteHigh: 100,
    oteSweetSpot: 95,
  };
}

function baseInput(overrides: Partial<ResolveSignalInput> = {}): ResolveSignalInput {
  return {
    preset: 'standard',
    primaryTimeframe: '15m',
    mtfAlignment: mtf('BULL'),
    eventSequence: sequence('LONG', true),
    premiumDiscount: range('DISCOUNT'),
    longFlags: fullFlags,
    shortFlags: noneFlags,
    quoteVolume24h: 20_000_000,
    medianQuoteVolume24h: 8_000_000,
    spreadPercent: 0.02,
    fundingRate: 0.0001,
    priceChangePercent24h: 1.2,
    openInterestPresent: true,
    ...overrides,
  };
}

describe('signal gating required gates', () => {
  it('passes a long when HTF agreement, complete sequence, discount/OTE and liquidity all hold', () => {
    const decision = resolveSignalDecision(baseInput());
    assert.equal(decision.actionState, 'LONG CANDIDATE');
    assert.equal(decision.missingGates.length, 0);
    assert.ok(decision.confidence > 0 && decision.confidence <= 100);
    assert.ok(decision.requiredGates.every((gate) => gate.passed));
    assert.ok(decision.stateReasonZh.includes('正式多頭候選'));
    assert.ok(decision.plusPoints.length > 0);
  });

  it('blocks HTF/LTF disagreement and names the gate', () => {
    const decision = resolveSignalDecision(
      baseInput({ mtfAlignment: mtf('CONFLICT') })
    );
    assert.notEqual(decision.actionState, 'LONG CANDIDATE');
    assert.ok(decision.missingGates.includes('HTF_LTF_AGREEMENT'));
    assert.ok(decision.stateReasonZh.length > 0);
    assert.ok(
      decision.requiredGates.some(
        (gate) => gate.key === 'HTF_LTF_AGREEMENT' && !gate.passed && gate.reasonZh.includes('衝突')
      )
    );
  });

  it('blocks a missing sequence when the lighter path is also absent', () => {
    const decision = resolveSignalDecision(
      baseInput({
        eventSequence: sequence('LONG', false),
        longFlags: { ...fullFlags, bosOrMss: false, fvgOrOb: false },
      })
    );
    assert.notEqual(decision.actionState, 'LONG CANDIDATE');
    assert.ok(decision.missingGates.includes('EVENT_SEQUENCE_OR_LIGHTER_PATH'));
    assert.equal(decision.lighterPath.used, false);
  });

  it('accepts the documented lighter path on the standard preset', () => {
    const decision = resolveSignalDecision(
      baseInput({
        eventSequence: sequence('LONG', false),
        longFlags: { ...fullFlags, sweep: false, displacement: false },
      })
    );
    assert.equal(decision.actionState, 'LONG CANDIDATE');
    assert.equal(decision.lighterPath.used, true);
    assert.equal(decision.lighterPath.id, 'TRIGGER_BOS_MSS_AND_POI');
    assert.ok(decision.lighterPath.documentedZh.includes('BOS'));
    const sequenceRow = decision.components.find((row) => row.key === 'sequence');
    assert.ok(sequenceRow && sequenceRow.points === SIGNAL_GATING_PRESETS.standard.weights.sequenceLighter);
  });

  it('does not invent a dealing range when swings cannot bracket price', () => {
    const decision = resolveSignalDecision(
      baseInput({
        premiumDiscount: {
          ...range('DISCOUNT'),
          zone: 'UNAVAILABLE',
          labels: [],
          inOte: false,
          pricePositionPct: null,
        },
      })
    );
    assert.notEqual(decision.actionState, 'LONG CANDIDATE');
    assert.ok(decision.missingGates.includes('LOCATION_DISCOUNT_OR_OTE'));
    assert.ok(
      decision.requiredGates.some((gate) => gate.reasonZh.includes('location unavailable'))
    );
  });

  it('rejects a long outside discount and OTE', () => {
    const decision = resolveSignalDecision(
      baseInput({ premiumDiscount: range('PREMIUM') })
    );
    assert.notEqual(decision.actionState, 'LONG CANDIDATE');
    assert.ok(
      decision.missingGates.includes('LOCATION_DISCOUNT_OR_OTE') ||
        decision.missingGates.includes('LOCATION_PREMIUM_OR_OTE') ||
        decision.actionState === 'SHORT CANDIDATE'
    );
    if (decision.actionState !== 'SHORT CANDIDATE') {
      assert.ok(decision.missingGates.includes('LOCATION_DISCOUNT_OR_OTE'));
      assert.ok(decision.stateReasonZh.length > 0);
    }
  });

  it('rejects dust liquidity and allows a relative-to-median alt', () => {
    const config = resolveSignalGatingConfig({ preset: 'standard' });
    const dust = evaluateTradableLiquidity({
      quoteVolume24h: 800_000,
      spreadPercent: 0.02,
      medianQuoteVolume24h: 10_000_000,
      config,
    });
    assert.equal(dust.passed, false);
    assert.equal(dust.path, 'DUST');

    const relative = evaluateTradableLiquidity({
      quoteVolume24h: 2_000_000,
      spreadPercent: 0.04,
      medianQuoteVolume24h: 5_000_000,
      config,
    });
    assert.equal(relative.passed, true);
    assert.equal(relative.path, 'RELATIVE_TO_MEDIAN');

    const blocked = resolveSignalDecision(
      baseInput({ quoteVolume24h: 800_000, medianQuoteVolume24h: 10_000_000 })
    );
    assert.notEqual(blocked.actionState, 'LONG CANDIDATE');
    assert.ok(blocked.missingGates.includes('TRADABLE_LIQUIDITY'));
    assert.ok(blocked.minusPoints.some((row) => row.includes('流動性') || row.includes('灰塵')));
  });
});

describe('signal confidence composition', () => {
  it('clamps the side score to 0-100 and matches the rounded component sum', () => {
    const decision = resolveSignalDecision(baseInput());
    const raw = decision.components.reduce((sum, row) => sum + row.points, 0);
    const dropped = decision.components
      .filter((row) => row.unavailable)
      .reduce((sum, row) => sum + Math.max(0, row.maxPoints), 0);
    const expected = Math.max(0, Math.min(100, Math.round((raw / Math.max(1, 100 - dropped)) * 100)));
    assert.equal(decision.confidence, expected);
    assert.ok(decision.components.some((row) => row.key === 'oi' && row.unavailable));
    assert.ok(decision.components.some((row) => row.key === 'obi' && row.unavailable));
    assert.ok(decision.components.every((row) => row.reasonZh.length > 0));
  });

  it('keeps an extreme continuation as a visible penalty and soft-vetoes only below the floor', () => {
    const chased = resolveSignalDecision(
      baseInput({
        eventSequence: sequence('LONG', false),
        longFlags: { ...fullFlags, sweep: false, displacement: false },
        priceChangePercent24h: 11.22,
      })
    );
    assert.equal(chased.actionState, 'WATCH');
    assert.ok(chased.missingGates.includes('MOMENTUM_CONTINUATION_CHASE'));
    assert.ok(chased.minusPoints.some((row) => row.includes('追價') || row.includes('極端')));

    const strong = resolveSignalDecision(
      baseInput({ priceChangePercent24h: 11.22 })
    );
    assert.equal(strong.actionState, 'LONG CANDIDATE');
    assert.equal(strong.missingGates.includes('MOMENTUM_CONTINUATION_CHASE'), false);
    assert.ok(strong.minusPoints.some((row) => row.includes('追價')));
  });

  it('allows a reversal when the sequence is complete at a premium or discount extreme', () => {
    const decision = resolveSignalDecision(
      baseInput({
        mtfAlignment: mtf('BEAR'),
        eventSequence: sequence('SHORT', true),
        premiumDiscount: range('PREMIUM'),
        longFlags: noneFlags,
        shortFlags: fullFlags,
        priceChangePercent24h: 11.22,
      })
    );
    assert.equal(decision.actionState, 'SHORT CANDIDATE');
    assert.equal(decision.missingGates.length, 0);
    assert.ok(decision.plusPoints.some((row) => row.includes('反轉') || row.includes('極端')));
  });
});

describe('long short conflict margin', () => {
  it('WAITS and reports both sides when the score gap is inside the preset margin', () => {
    const config = SIGNAL_GATING_PRESETS.standard;
    const decision = resolveSignalDecision(
      baseInput({
        mtfAlignment: {
          aligned: false,
          dominantDirection: 'CONFLICT',
          byTimeframe: { '5m': 'BULL', '15m': 'BULL', '1h': 'BEAR', '4h': 'BULL' },
          description: '高週期衝突',
        },
        eventSequence: sequence('LONG', false),
        premiumDiscount: range('EQUILIBRIUM'),
        longFlags: { ...fullFlags, sweep: true, displacement: true },
        shortFlags: { ...fullFlags, sweep: true, displacement: true },
        displacementBodyToAtrLong: 2.2,
        displacementBodyToAtrShort: 2.2,
        fvgAtrMultipleLong: 0.8,
        fvgAtrMultipleShort: 0.8,
        fundingRate: 0.0001,
        priceChangePercent24h: 0.4,
      })
    );
    assert.equal(decision.conflictBlocked, true);
    assert.equal(decision.actionState, 'WAIT');
    assert.ok(decision.missingGates.includes('DIRECTION_CONFLICT_WITHIN_MARGIN'));
    assert.ok(Math.abs(decision.longScore - decision.shortScore) < config.conflict.minScoreMargin);
    assert.ok(decision.stateReasonZh.includes(String(decision.longScore)));
    assert.ok(decision.stateReasonZh.includes(String(decision.shortScore)));
    assert.ok(decision.minusPoints.some((row) => row.includes('衝突')));
  });

  it('lets the stronger side through when the gap exceeds the margin', () => {
    const decision = resolveSignalDecision(baseInput());
    assert.equal(decision.conflictBlocked, false);
    assert.ok(decision.margin >= decision.conflictMargin || decision.shortScore < 22);
    assert.equal(decision.actionState, 'LONG CANDIDATE');
  });
});

describe('derivatives score adjustments', () => {
  it('confirms rising OI with price and weakens falling OI', () => {
    const confirmed = resolveSignalDecision(
      baseInput({ oiPriceChangePct: 1.2, oiChangePct: 1.4 })
    );
    const faded = resolveSignalDecision(
      baseInput({ oiPriceChangePct: 1.2, oiChangePct: -1.1 })
    );
    const oiUp = confirmed.components.find((row) => row.key === 'oi');
    const oiDown = faded.components.find((row) => row.key === 'oi');
    assert.ok(oiUp && oiUp.points > 0);
    assert.ok(oiDown && oiDown.points < 0);
    assert.ok(oiUp.reasonZh.includes('增倉'));
    assert.ok(oiDown.reasonZh.includes('下降'));
    assert.ok(confirmed.confidence > faded.confidence);
  });

  it('scores CVD divergence and OBI bands in the trade direction', () => {
    const supported = resolveSignalDecision(
      baseInput({
        cvdDivergence: 'BULLISH_ABSORPTION',
        obi50bpsPct: 12,
        obi100bpsPct: 28,
        obi200bpsPct: 18,
      })
    );
    const opposed = resolveSignalDecision(
      baseInput({
        cvdDivergence: 'BEARISH_EXHAUSTION',
        obi50bpsPct: -20,
        obi100bpsPct: -32,
        obi200bpsPct: -16,
      })
    );
    assert.ok((supported.components.find((row) => row.key === 'cvd')?.points ?? 0) > 0);
    assert.ok((opposed.components.find((row) => row.key === 'cvd')?.points ?? 0) < 0);
    assert.ok((supported.components.find((row) => row.key === 'obi')?.points ?? 0) > 0);
    assert.ok((opposed.components.find((row) => row.key === 'obi')?.points ?? 0) < 0);
    assert.ok(supported.components.some((row) => row.reasonZh.includes('0.5') || row.reasonZh.includes('±')));
  });

  it('soft-vetoes crowded funding and keeps the reason on the blocked list', () => {
    const decision = resolveSignalDecision(baseInput({ fundingRate: 0.00062 }));
    assert.equal(decision.actionState, 'WATCH');
    assert.ok(decision.missingGates.includes('FUNDING_CROWDING'));
    assert.ok(decision.minusPoints.some((row) => row.includes('擁擠') || row.includes('資金費率')));
    assert.ok(decision.stateReasonZh.length > 0);
  });
});

describe('live-scan gating corrections', () => {
  it('refuses a formal when confidence is under the preset minimum', () => {
    const decision = resolveSignalDecision(
      baseInput({
        eventSequence: sequence('LONG', false),
        longFlags: { ...fullFlags, sweep: false, displacement: false },
        fundingRate: null,
      })
    );
    assert.ok(decision.confidence < SIGNAL_GATING_PRESETS.standard.formalMinConfidence);
    assert.notEqual(decision.actionState, 'LONG CANDIDATE');
    assert.ok(decision.missingGates.includes('CONFIDENCE_BELOW_FORMAL'));
  });

  it('takes the lower-scoring side when that side is the one that passes the gates', () => {
    const decision = resolveSignalDecision(
      baseInput({
        mtfAlignment: mtf('BEAR'),
        eventSequence: sequence('SHORT', true),
        premiumDiscount: range('PREMIUM'),
        longFlags: { ...fullFlags, sweep: true },
        shortFlags: fullFlags,
        priceChangePercent24h: 1,
      })
    );
    assert.equal(decision.actionState, 'SHORT CANDIDATE');
    assert.ok(decision.longScore <= decision.shortScore || decision.missingGates.length === 0);
  });

  it('keeps WATCH only for one missing gate and enough confidence', () => {
    const oneGate = resolveSignalDecision(
      baseInput({ quoteVolume24h: 800_000, medianQuoteVolume24h: 10_000_000 })
    );
    assert.equal(oneGate.actionState, 'WATCH');
    assert.ok(oneGate.confidence >= SIGNAL_GATING_PRESETS.standard.watchMinConfidence);

    const empty = resolveSignalDecision(
      baseInput({
        mtfAlignment: mtf('CONFLICT'),
        eventSequence: sequence('LONG', false),
        premiumDiscount: range('EQUILIBRIUM'),
        longFlags: noneFlags,
        shortFlags: noneFlags,
        quoteVolume24h: 800_000,
      })
    );
    assert.equal(empty.actionState, 'WAIT');
  });

  it('scores the sweep that belongs to the sequence, not the latest opposite sweep', () => {
    const decision = resolveSignalDecision(
      baseInput({
        longFlags: { ...fullFlags, sweep: false },
        eventSequence: sequence('LONG', true),
      })
    );
    const sweep = decision.components.find((row) => row.key === 'sweep');
    assert.ok(sweep && sweep.points > 0);
  });

  it('does not let the lighter path qualify the opposite of the sequence', () => {
    const decision = resolveSignalDecision(
      baseInput({
        eventSequence: { ...sequence('LONG', false), direction: 'LONG' },
        longFlags: noneFlags,
        shortFlags: fullFlags,
        mtfAlignment: mtf('BEAR'),
        premiumDiscount: range('PREMIUM'),
      })
    );
    assert.equal(decision.lighterPath.used, false);
    assert.notEqual(decision.actionState, 'SHORT CANDIDATE');
  });

  it('separates confidence when displacement magnitude differs', () => {
    const small = resolveSignalDecision(baseInput({ displacementBodyToAtrLong: 1.1 }));
    const large = resolveSignalDecision(baseInput({ displacementBodyToAtrLong: 3.4 }));
    assert.ok(large.confidence > small.confidence);
  });
});
