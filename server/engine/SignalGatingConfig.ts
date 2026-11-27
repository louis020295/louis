/**
 * Step 2 signal gating and confidence weights.
 * One typed config, selected with the same `SMC_STRUCTURE_PRESET` as structure detection.
 *
 * Required gates (all must pass for LONG / SHORT CANDIDATE):
 *  (a) HTF/LTF direction agreement on the trigger timeframe
 *  (b) event sequence complete OR the documented lighter path
 *  (c) location: long in discount or OTE, short in premium or OTE
 *  (d) minimum tradable liquidity
 * Everything else is a weighted confidence component.
 *
 * Lighter path id `TRIGGER_BOS_MSS_AND_POI` (standard and aggressive only):
 * trigger-timeframe BOS or MSS in the trade direction, plus an unmitigated FVG
 * or a valid order block in that same direction. Sweep and displacement stay
 * score components. Conservative disables this path and requires the full
 * sweep → MSS/CHoCH → displacement → FVG/OB sequence.
 */

import {
  normalizeSmcStructurePreset,
  type SmcStructurePresetName,
} from './SmcStructureConfig.ts';

export interface SignalGatingConfig {
  preset: SmcStructurePresetName;
  /** (b) Allow TRIGGER_BOS_MSS_AND_POI when the ordered four-step sequence is incomplete. */
  lighterPathEnabled: boolean;
  /** Aggressive only: 3 of 4 sequence steps also satisfies gate (b). */
  partialSequenceSatisfiesGate: boolean;
  /**
   * Formal minimum. Standard is 60: the four required gates alone are about
   * 46–54 points (HTF 16 + lighter/full sequence 12–20 + location 10 + liquidity 8).
   * 60 demands those gates plus a real displacement, sweep, or derivatives confirm,
   * so a bare chase like ZEC at 36 cannot print LONG/SHORT CANDIDATE.
   */
  formalMinConfidence: number;
  /** WATCH requires at most one failed required gate and at least this confidence. */
  watchMinConfidence: number;
  watchMaxMissingGates: number;
  htf: {
    /** Single-timeframe backtests may self-agree when the trigger bias matches. */
    allowSingleTimeframeSelfAgreement: boolean;
  };
  liquidity: {
    /** Comfortable 24h quote-volume floor in USDT. Volume at or above this passes gate (d) if spread is acceptable. */
    minQuoteVolume24h: number;
    /** Hard dust floor. Below this, relative rank and depth cannot rescue the symbol. */
    hardDustQuoteVolume24h: number;
    /**
     * Rescue path for alt perps: volume may sit under `minQuoteVolume24h` when it is
     * still at least this multiple of the cross-sectional 24h quote-volume median.
     */
    minMedianMultiple: number;
    /** Bid+ask notional within ±1% of mid. When the book is present, this can rescue a name above the dust floor. */
    minDepthUsdWithin1Pct: number;
    maxSpreadPercent: number;
  };
  conflict: {
    /** WAIT when both sides are meaningful and |longScore − shortScore| is below this. */
    minScoreMargin: number;
    /** Both sides must reach this confidence before the margin rule applies. */
    minMeaningfulScore: number;
  };
  momentum: {
    /** |24h change| at or above this is an extreme context move. Not a blanket veto. */
    extremeAbsChangePct: number;
    /** Discount position (0 = range low) at or below this counts as a long extreme. */
    discountExtremePct: number;
    /** Premium position at or above this counts as a short extreme. */
    premiumExtremePct: number;
    continuationPenalty: number;
    reversalBonus: number;
    /** Penalty when the 24h move is a reversal but the sequence is not complete at the extreme. */
    incompleteReversalPenalty: number;
    /**
     * Continuation (or incomplete reversal) soft-vetoes a formal candidate only when
     * confidence after the penalty falls below this floor.
     */
    softVetoBelow: number;
  };
  derivatives: {
    /** |funding| at or above this crowds the trade and can soft-veto the crowded side. */
    fundingCrowdAbs: number;
    /** |funding| at or above this is a hard HIGH RISK when the caller sets extremeFunding, else still a soft veto. */
    fundingHardAbs: number;
    oiConfirmAbsPricePct: number;
    oiConfirmAbsOiPct: number;
  };
  /** Headline radar score caps so the displayed score cannot silently contradict the SMC state. */
  scoreCaps: {
    wait: number;
    watch: number;
    formalFloor: number;
  };
  weights: {
    htfAgreement: number;
    sequenceComplete: number;
    sequenceLighter: number;
    sequencePartial: number;
    locationOte: number;
    locationZone: number;
    locationWrong: number;
    liquidityPass: number;
    liquidityFail: number;
    displacement: number;
    sweep: number;
    oiConfirm: number;
    oiFalling: number;
    cvdSupport: number;
    cvdOppose: number;
    obiStrong: number;
    fundingHealthy: number;
    fundingCrowded: number;
  };
}

const STANDARD_WEIGHTS: SignalGatingConfig['weights'] = {
  htfAgreement: 16,
  sequenceComplete: 20,
  sequenceLighter: 12,
  sequencePartial: 5,
  locationOte: 14,
  locationZone: 10,
  locationWrong: -6,
  liquidityPass: 8,
  liquidityFail: -10,
  displacement: 7,
  sweep: 6,
  oiConfirm: 8,
  oiFalling: -6,
  cvdSupport: 6,
  cvdOppose: -4,
  obiStrong: 6,
  fundingHealthy: 4,
  fundingCrowded: -8,
};

export const SIGNAL_GATING_PRESETS: Record<SmcStructurePresetName, SignalGatingConfig> = {
  standard: {
    preset: 'standard',
    lighterPathEnabled: true,
    partialSequenceSatisfiesGate: false,
    formalMinConfidence: 60,
    watchMinConfidence: 40,
    watchMaxMissingGates: 1,
    htf: { allowSingleTimeframeSelfAgreement: true },
    liquidity: {
      minQuoteVolume24h: 3_000_000,
      hardDustQuoteVolume24h: 1_200_000,
      minMedianMultiple: 0.35,
      minDepthUsdWithin1Pct: 80_000,
      maxSpreadPercent: 0.15,
    },
    conflict: { minScoreMargin: 8, minMeaningfulScore: 22 },
    momentum: {
      extremeAbsChangePct: 8,
      discountExtremePct: 38,
      premiumExtremePct: 62,
      continuationPenalty: 12,
      reversalBonus: 5,
      incompleteReversalPenalty: 6,
      softVetoBelow: 50,
    },
    derivatives: {
      fundingCrowdAbs: 0.0005,
      fundingHardAbs: 0.001,
      oiConfirmAbsPricePct: 0.25,
      oiConfirmAbsOiPct: 0.5,
    },
    scoreCaps: { wait: 52, watch: 70, formalFloor: 68 },
    weights: STANDARD_WEIGHTS,
  },
  conservative: {
    preset: 'conservative',
    lighterPathEnabled: false,
    partialSequenceSatisfiesGate: false,
    formalMinConfidence: 72,
    watchMinConfidence: 50,
    watchMaxMissingGates: 1,
    htf: { allowSingleTimeframeSelfAgreement: false },
    liquidity: {
      minQuoteVolume24h: 8_000_000,
      hardDustQuoteVolume24h: 3_000_000,
      minMedianMultiple: 0.6,
      minDepthUsdWithin1Pct: 150_000,
      maxSpreadPercent: 0.12,
    },
    conflict: { minScoreMargin: 12, minMeaningfulScore: 28 },
    momentum: {
      extremeAbsChangePct: 6,
      discountExtremePct: 32,
      premiumExtremePct: 68,
      continuationPenalty: 16,
      reversalBonus: 4,
      incompleteReversalPenalty: 8,
      softVetoBelow: 58,
    },
    derivatives: {
      fundingCrowdAbs: 0.0004,
      fundingHardAbs: 0.0008,
      oiConfirmAbsPricePct: 0.35,
      oiConfirmAbsOiPct: 0.8,
    },
    scoreCaps: { wait: 48, watch: 64, formalFloor: 74 },
    weights: {
      ...STANDARD_WEIGHTS,
      sequenceLighter: 0,
      locationWrong: -10,
      fundingCrowded: -10,
    },
  },
  aggressive: {
    preset: 'aggressive',
    lighterPathEnabled: true,
    partialSequenceSatisfiesGate: true,
    formalMinConfidence: 48,
    watchMinConfidence: 32,
    watchMaxMissingGates: 1,
    htf: { allowSingleTimeframeSelfAgreement: true },
    liquidity: {
      minQuoteVolume24h: 1_500_000,
      hardDustQuoteVolume24h: 600_000,
      minMedianMultiple: 0.2,
      minDepthUsdWithin1Pct: 40_000,
      maxSpreadPercent: 0.2,
    },
    conflict: { minScoreMargin: 5, minMeaningfulScore: 18 },
    momentum: {
      extremeAbsChangePct: 12,
      discountExtremePct: 45,
      premiumExtremePct: 55,
      continuationPenalty: 8,
      reversalBonus: 6,
      incompleteReversalPenalty: 3,
      softVetoBelow: 40,
    },
    derivatives: {
      fundingCrowdAbs: 0.0007,
      fundingHardAbs: 0.0015,
      oiConfirmAbsPricePct: 0.2,
      oiConfirmAbsOiPct: 0.4,
    },
    scoreCaps: { wait: 58, watch: 76, formalFloor: 60 },
    weights: {
      ...STANDARD_WEIGHTS,
      sequencePartial: 8,
      locationWrong: -3,
    },
  },
};

export const STANDARD_MIN_QUOTE_VOLUME_24H =
  SIGNAL_GATING_PRESETS.standard.liquidity.minQuoteVolume24h;

export function resolveSignalGatingConfig(input?: {
  preset?: unknown;
} | null): SignalGatingConfig {
  const preset = normalizeSmcStructurePreset(
    input?.preset ?? process.env.SMC_STRUCTURE_PRESET
  );
  return SIGNAL_GATING_PRESETS[preset];
}
