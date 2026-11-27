import {
  FunnelAggregationScope,
  GateStatisticScope,
  Kline,
  MarketRadarCategory,
  NearMissStatus,
  ObservationShadowComparisonSummary,
  ScopedGateStatisticItem,
  ScopedGateStatisticsSummary,
  SmcActionState,
  SmcAnalysisResult,
  SmcGateDiagnosticsSummary,
  SmcNearMissSymbolRecord,
  SmcStatsConsistency,
  SymbolSmcGateEvaluation,
} from '../../src/types/market.ts';

/**
 * SMC gate, funnel, and near-miss diagnostics.
 * Extracted from SmcRuleEngine so structure detection stays separate from reporting.
 * Behavior is unchanged; SmcRuleEngine re-exports these symbols.
 */

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





