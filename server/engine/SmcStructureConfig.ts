/**
 * Tunable SMC/ICT structure definitions.
 * `standard` matches the thresholds that were previously hard-coded.
 * Select with `SMC_STRUCTURE_PRESET=conservative|standard|aggressive`.
 */

export type SmcStructurePresetName = 'conservative' | 'standard' | 'aggressive';

export interface SmcStructureConfig {
  preset: SmcStructurePresetName;
  /** Confirmed bars required on each side of a swing pivot. */
  swingConfirmationBars: number;
  /** Minimum FVG height as a multiple of ATR. 0 accepts any positive gap. */
  minFvgAtrMultiple: number;
  /**
   * Order-block body is rejected only when BOTH body/ATR and body/range
   * are below these floors (the previous AND-rejection).
   */
  obMinBodyToAtr: number;
  obMinBodyToRange: number;
  /** Minimum wick penetration beyond a liquidity pool, in ATR. 0 = any pierce. */
  sweepMinPenetrationAtr: number;
  /** Single-candle displacement body / ATR. */
  displacementAtrMultiple: number;
  /** Single-candle displacement body / full range. */
  displacementBodyRatio: number;
  /** Max bars from the liquidity sweep to the FVG/OB that completes the sequence. */
  sequenceWindowBars: number;
}

export const SMC_STRUCTURE_PRESETS: Record<SmcStructurePresetName, SmcStructureConfig> = {
  standard: {
    preset: 'standard',
    swingConfirmationBars: 2,
    minFvgAtrMultiple: 0,
    obMinBodyToAtr: 0.25,
    obMinBodyToRange: 0.4,
    sweepMinPenetrationAtr: 0,
    displacementAtrMultiple: 1.3,
    displacementBodyRatio: 0.6,
    sequenceWindowBars: 24,
  },
  conservative: {
    preset: 'conservative',
    swingConfirmationBars: 3,
    minFvgAtrMultiple: 0.2,
    obMinBodyToAtr: 0.4,
    obMinBodyToRange: 0.55,
    sweepMinPenetrationAtr: 0.08,
    displacementAtrMultiple: 1.6,
    displacementBodyRatio: 0.7,
    sequenceWindowBars: 16,
  },
  aggressive: {
    preset: 'aggressive',
    swingConfirmationBars: 1,
    minFvgAtrMultiple: 0,
    obMinBodyToAtr: 0.12,
    obMinBodyToRange: 0.25,
    sweepMinPenetrationAtr: 0,
    displacementAtrMultiple: 0.9,
    displacementBodyRatio: 0.45,
    sequenceWindowBars: 40,
  },
};

const PRESET_NAMES = new Set<SmcStructurePresetName>([
  'conservative',
  'standard',
  'aggressive',
]);

export function normalizeSmcStructurePreset(value: unknown): SmcStructurePresetName {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase() as SmcStructurePresetName;
    if (PRESET_NAMES.has(key)) return key;
  }
  return 'standard';
}

function finiteOverride(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function resolveSmcStructureConfig(input?: {
  preset?: unknown;
  overrides?: Partial<Omit<SmcStructureConfig, 'preset'>> | null;
} | null): SmcStructureConfig {
  const fromEnv = process.env.SMC_STRUCTURE_PRESET;
  const preset = normalizeSmcStructurePreset(input?.preset ?? fromEnv);
  const base = SMC_STRUCTURE_PRESETS[preset];
  const o = input?.overrides ?? {};
  return {
    preset,
    swingConfirmationBars: Math.round(
      finiteOverride(o.swingConfirmationBars, base.swingConfirmationBars, 1, 6)
    ),
    minFvgAtrMultiple: finiteOverride(o.minFvgAtrMultiple, base.minFvgAtrMultiple, 0, 2),
    obMinBodyToAtr: finiteOverride(o.obMinBodyToAtr, base.obMinBodyToAtr, 0, 2),
    obMinBodyToRange: finiteOverride(o.obMinBodyToRange, base.obMinBodyToRange, 0, 1),
    sweepMinPenetrationAtr: finiteOverride(
      o.sweepMinPenetrationAtr,
      base.sweepMinPenetrationAtr,
      0,
      2
    ),
    displacementAtrMultiple: finiteOverride(
      o.displacementAtrMultiple,
      base.displacementAtrMultiple,
      0.2,
      4
    ),
    displacementBodyRatio: finiteOverride(
      o.displacementBodyRatio,
      base.displacementBodyRatio,
      0.1,
      1
    ),
    sequenceWindowBars: Math.round(
      finiteOverride(o.sequenceWindowBars, base.sequenceWindowBars, 4, 120)
    ),
  };
}

/**
 * Displacement thresholds used by the structure engine.
 * On the standard preset, relaxed profiles keep the previous 1.1 / 0.55 floors.
 */
export function resolveDisplacementThresholds(
  config: SmcStructureConfig,
  relaxed: boolean
): { atrMultiple: number; bodyRatio: number } {
  if (relaxed && config.preset === 'standard') {
    return { atrMultiple: 1.1, bodyRatio: 0.55 };
  }
  if (relaxed) {
    return {
      atrMultiple: Math.min(config.displacementAtrMultiple, 1.1),
      bodyRatio: Math.min(config.displacementBodyRatio, 0.55),
    };
  }
  return {
    atrMultiple: config.displacementAtrMultiple,
    bodyRatio: config.displacementBodyRatio,
  };
}
