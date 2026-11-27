/**
 * Confidence score and required-gate resolution.
 *
 * Formulas (standard preset; conservative / aggressive scale the same expressions
 * with the weights in SignalGatingConfig):
 *
 * Location
 *   position = (price − rangeLow) / (rangeHigh − rangeLow) × 100
 *   long passes when zone is DISCOUNT, or IN_OTE and oteDirection is not BEAR
 *   short passes when zone is PREMIUM, or IN_OTE and oteDirection is not BULL
 *
 * Liquidity gate (d), first failure wins
 *   fail if spread% > maxSpreadPercent (missing spread does not fail)
 *   fail if quoteVolume24h < hardDustQuoteVolume24h
 *   pass if quoteVolume24h >= minQuoteVolume24h
 *   pass if median > 0 and quoteVolume24h >= median × minMedianMultiple
 *   pass if depth within ±1% >= minDepthUsdWithin1Pct and volume >= hard dust
 *
 * OI versus price (same windows as DerivativesStructureEngine)
 *   oiChange% = (oiEnd − oiStart) / oiStart × 100
 *   priceChange% = (closeEnd − closeStart) / closeStart × 100
 *   confirm: price in the trade direction by >= 0.25% AND oiChange >= +0.5% → +oiConfirm
 *   weaker: |price| >= 0.25% AND oiChange <= −0.5% → oiFalling (falling OI is not new positioning)
 *
 * CVD (taker buy quote − taker sell quote, same 0.35% split as DerivativesStructureEngine)
 *   bullish absorption (price down, second-half delta > 0) supports long
 *   bearish exhaustion (price up, second-half delta < 0) supports short
 *   confirmed trend supports the side matching the net price change
 *
 * OBI at ±0.5% / ±1% / ±2% of mid
 *   OBI(band) = (bidNotional − askNotional) / (bidNotional + askNotional) × 100
 *   primary band is ±1%; ±0.5% and ±2% confirm or halve it
 *   |OBI| < 10 → 0; 10–25 → ±3; 25–45 → ±5; > 45 → ±obiStrong
 *   positive OBI supports long, negative OBI supports short
 *
 * Funding crowding
 *   |rate| >= fundingCrowdAbs and the sign crowds this side (positive crowds longs,
 *   negative crowds shorts) → fundingCrowded and a soft veto
 *   the opposite sign is a small tailwind (half of fundingHealthy)
 *
 * 24h momentum is context, not a blanket veto
 *   |change| >= extremeAbsChangePct
 *   continuation (trade side matches the 24h sign) → continuationPenalty
 *   reversal with a complete same-side sequence at a discount/premium extreme or in OTE
 *     → reversalBonus, never a veto
 *   other extreme reversals → incompleteReversalPenalty
 *   a penalty soft-vetoes FORMAL only when confidence after the penalty < softVetoBelow
 *
 * Side confidence = clamp(0, 100, round(sum of that side's components))
 * Headline radar score adds smcQuality and then applies scoreCaps so WAIT / WATCH
 * cannot outrank a formal candidate without an explicit cap reason.
 */

import type {
  CvdDivergenceType,
  Kline,
  PremiumDiscountRange,
  SignalDecision,
  SignalScoreComponent,
  SmcActionState,
  SmcEventSequenceState,
  SmcMtfAlignment,
  Timeframe,
} from '../../src/types/market.ts';
import {
  resolveSignalGatingConfig,
  type SignalGatingConfig,
} from './SignalGatingConfig.ts';

export const LIGHTER_PATH_ID = 'TRIGGER_BOS_MSS_AND_POI' as const;

export const LIGHTER_PATH_DOC_ZH =
  '輕量路徑 TRIGGER_BOS_MSS_AND_POI：觸發週期已有同向 BOS 或 MSS，且同向存在未回補 FVG 或有效 Order Block。掃流動性與位移 K 改列信心分數，不再各算一道硬閘門。完整序列（掃流動性 → MSS/CHoCH → 位移 → FVG/OB，且落在設定窗口內）仍直接滿足序列閘門，並比輕量路徑得分更高。保守預設關閉輕量路徑。';

export interface LiquidityInput {
  quoteVolume24h: number;
  spreadPercent?: number | null;
  medianQuoteVolume24h?: number | null;
  depthUsdWithin1Pct?: number | null;
  config: SignalGatingConfig;
}

export interface LiquidityVerdict {
  passed: boolean;
  reasonZh: string;
  path: 'ABSOLUTE' | 'RELATIVE_TO_MEDIAN' | 'DEPTH' | 'SPREAD' | 'DUST' | 'BELOW_FLOOR';
}

export interface SideStructureFlags {
  bosOrMss: boolean;
  sweep: boolean;
  displacement: boolean;
  fvgOrOb: boolean;
}

export interface ResolveSignalInput {
  preset?: unknown;
  config?: SignalGatingConfig;
  primaryTimeframe: Timeframe;
  mtfAlignment: SmcMtfAlignment;
  eventSequence: SmcEventSequenceState | null | undefined;
  premiumDiscount: PremiumDiscountRange | null | undefined;
  longFlags: SideStructureFlags;
  shortFlags: SideStructureFlags;
  isLowLiquidity?: boolean;
  extremeFunding?: boolean;
  lowLiquidityHighVolatility?: boolean;
  /** Hard data problems. These force WAIT (or stay behind HIGH RISK) and are always listed. */
  dataBlockers?: string[];
  quoteVolume24h?: number | null;
  spreadPercent?: number | null;
  medianQuoteVolume24h?: number | null;
  depthUsdWithin1Pct?: number | null;
  fundingRate?: number | null;
  priceChangePercent24h?: number | null;
  oiChangePct?: number | null;
  oiPriceChangePct?: number | null;
  cvdDivergence?: CvdDivergenceType | null;
  obi50bpsPct?: number | null;
  obi100bpsPct?: number | null;
  obi200bpsPct?: number | null;
  /** Closed candles used only when cvdDivergence was not supplied. */
  klinesForCvd?: Kline[] | null;
  openInterestPresent?: boolean;
  /** Body/ATR of the displacement that belongs to this side. Continuous, not a boolean. */
  displacementBodyToAtrLong?: number | null;
  displacementBodyToAtrShort?: number | null;
  fvgAtrMultipleLong?: number | null;
  fvgAtrMultipleShort?: number | null;
  distanceToPoiAtrLong?: number | null;
  distanceToPoiAtrShort?: number | null;
  /**
   * Omit to skip the entry-zone gate (synthetic gate tests).
   * SmcRuleEngine always supplies both sides.
   */
  entryZoneLong?: { valid: boolean; reasonZh: string } | null;
  entryZoneShort?: { valid: boolean; reasonZh: string } | null;
}

interface SideScore {
  side: 'LONG' | 'SHORT';
  confidence: number;
  components: SignalScoreComponent[];
  requiredFailed: string[];
  requiredPassed: SignalDecision['requiredGates'];
  lighterPathUsed: boolean;
  sequenceComplete: boolean;
  structureEvidence: boolean;
  softVeto: { code: string; reasonZh: string } | null;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function component(
  key: string,
  labelZh: string,
  points: number,
  maxPoints: number,
  reasonZh: string,
  unavailable = false
): SignalScoreComponent {
  return {
    key,
    labelZh,
    points: Math.round(points),
    maxPoints,
    reasonZh,
    unavailable,
  };
}

function confidenceFromComponents(rows: SignalScoreComponent[]): number {
  const raw = rows.reduce((sum, row) => sum + row.points, 0);
  const dropped = rows
    .filter((row) => row.unavailable)
    .reduce((sum, row) => sum + Math.max(0, row.maxPoints), 0);
  const denom = Math.max(1, 100 - dropped);
  return clampScore((raw / denom) * 100);
}

export function evaluateTradableLiquidity(input: LiquidityInput): LiquidityVerdict {
  const { config } = input;
  const volume = Number.isFinite(input.quoteVolume24h) ? input.quoteVolume24h : 0;
  const spread = input.spreadPercent;
  const liq = config.liquidity;
  const absLabel = formatUsd(liq.minQuoteVolume24h);
  const dustLabel = formatUsd(liq.hardDustQuoteVolume24h);

  if (spread != null && Number.isFinite(spread) && spread > liq.maxSpreadPercent) {
    return {
      passed: false,
      path: 'SPREAD',
      reasonZh: `盤口價差 ${spread.toFixed(3)}% 寬於 ${liq.maxSpreadPercent}% ，未達可交易流動性`,
    };
  }
  if (volume < liq.hardDustQuoteVolume24h) {
    return {
      passed: false,
      path: 'DUST',
      reasonZh: `24h 成交額 ${formatUsd(volume)} 低於硬性灰塵門檻 ${dustLabel}，深度與相對排名都不能補過`,
    };
  }
  if (volume >= liq.minQuoteVolume24h) {
    return {
      passed: true,
      path: 'ABSOLUTE',
      reasonZh: `24h 成交額 ${formatUsd(volume)} 達到絕對可交易門檻 ${absLabel}`,
    };
  }
  const median = input.medianQuoteVolume24h;
  if (median != null && Number.isFinite(median) && median > 0) {
    const relativeFloor = median * liq.minMedianMultiple;
    if (volume >= relativeFloor) {
      return {
        passed: true,
        path: 'RELATIVE_TO_MEDIAN',
        reasonZh: `24h 成交額 ${formatUsd(volume)} 低於絕對門檻 ${absLabel}，但仍達全市場中位數 ${formatUsd(median)} 的 ${liq.minMedianMultiple} 倍，以相對流動性放行`,
      };
    }
  }
  const depth = input.depthUsdWithin1Pct;
  if (depth != null && Number.isFinite(depth) && depth >= liq.minDepthUsdWithin1Pct) {
    return {
      passed: true,
      path: 'DEPTH',
      reasonZh: `24h 成交額 ${formatUsd(volume)} 未達絕對門檻，但 ±1% 盤口深度 ${formatUsd(depth)} 達到 ${formatUsd(liq.minDepthUsdWithin1Pct)}`,
    };
  }
  return {
    passed: false,
    path: 'BELOW_FLOOR',
    reasonZh: `24h 成交額 ${formatUsd(volume)} 同時低於絕對門檻 ${absLabel} 與相對中位數門檻，且沒有足夠的 ±1% 深度`,
  };
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

export function htfLtfAgrees(
  side: 'LONG' | 'SHORT',
  mtf: SmcMtfAlignment,
  primary: Timeframe,
  config: SignalGatingConfig
): { passed: boolean; reasonZh: string } {
  const want = side === 'LONG' ? 'BULL' : 'BEAR';
  const oppose = side === 'LONG' ? 'BEAR' : 'BULL';
  const sideZh = side === 'LONG' ? '多' : '空';
  const by = mtf.byTimeframe;
  const trigger = by[primary];
  const htf1 = by['1h'];
  const htf4 = by['4h'];
  if (
    (htf1 === 'BULL' && htf4 === 'BEAR') ||
    (htf1 === 'BEAR' && htf4 === 'BULL')
  ) {
    return {
      passed: false,
      reasonZh: `高週期 1h（${htf1}）與 4h（${htf4}）方向衝突，觸發週期無法達成協議`,
    };
  }
  if (trigger === oppose) {
    return {
      passed: false,
      reasonZh: `觸發週期 ${primary} 結構為 ${trigger}，與${sideZh}單方向相反`,
    };
  }
  const htfs = [htf1, htf4].filter(
    (bias) => bias && bias !== 'MISSING'
  ) as Array<'BULL' | 'BEAR' | 'NEUTRAL'>;
  if (htfs.some((bias) => bias === oppose)) {
    return {
      passed: false,
      reasonZh: `高週期存在與${sideZh}單相反的方向`,
    };
  }
  if (htfs.length === 0) {
    if (config.htf.allowSingleTimeframeSelfAgreement && trigger === want) {
      return {
        passed: true,
        reasonZh: `僅有觸發週期 ${primary}，其結構與${sideZh}單同向（單週期自我協議）`,
      };
    }
    return {
      passed: false,
      reasonZh: `缺少 1h/4h，且觸發週期未明確同向，不視為 HTF/LTF 協議`,
    };
  }
  const htfAgrees = htfs.some((bias) => bias === want);
  if (trigger === want && (htfAgrees || htfs.every((bias) => bias === 'NEUTRAL'))) {
    return {
      passed: true,
      reasonZh: `觸發週期 ${primary} 與高週期同為${want === 'BULL' ? '多頭' : '空頭'}`,
    };
  }
  if (trigger === 'NEUTRAL' && htfAgrees) {
    return {
      passed: true,
      reasonZh: `觸發週期中性，高週期已同向${sideZh}方，視為方向協議`,
    };
  }
  if ((trigger === 'MISSING' || trigger == null) && htfAgrees) {
    return {
      passed: false,
      reasonZh: `高週期偏${sideZh}，但觸發週期本身沒有同向結構`,
    };
  }
  return {
    passed: false,
    reasonZh: `觸發週期 ${primary}（${trigger ?? 'MISSING'}）與高週期尚未形成${sideZh}方協議`,
  };
}

export function locationAllows(
  side: 'LONG' | 'SHORT',
  range: PremiumDiscountRange | null | undefined
): { passed: boolean; inOte: boolean; quality: 'OTE' | 'ZONE' | 'UNAVAILABLE' | 'WRONG'; reasonZh: string } {
  if (!range || range.zone === 'UNAVAILABLE' || range.pricePositionPct == null) {
    return {
      passed: false,
      inOte: false,
      quality: 'UNAVAILABLE',
      reasonZh: 'location unavailable：折價／溢價區間無法測量（價格已離開所有已確認擺動），位置閘門不通過',
    };
  }
  const inOte = Boolean(range.inOte || range.labels?.includes('IN_OTE'));
  const inDiscount = range.zone === 'DISCOUNT' || range.labels?.includes('IN_DISCOUNT');
  const inPremium = range.zone === 'PREMIUM' || range.labels?.includes('IN_PREMIUM');
  if (side === 'LONG') {
    const oteForLong = inOte && range.oteDirection !== 'BEAR' && !inPremium;
    if (inDiscount || oteForLong) {
      const usedOte = inOte && (inDiscount || oteForLong);
      return {
        passed: true,
        inOte: usedOte,
        quality: usedOte ? 'OTE' : 'ZONE',
        reasonZh: usedOte
          ? `價格在折價區的 OTE（位置 ${range.pricePositionPct.toFixed(1)}%）`
          : `價格在折價區（位置 ${range.pricePositionPct.toFixed(1)}%）`,
      };
    }
    return {
      passed: false,
      inOte: false,
      quality: 'WRONG',
      reasonZh: `多單只允許折價或 OTE，目前在${range.zone === 'PREMIUM' ? '溢價' : '均衡'}區（${range.pricePositionPct.toFixed(1)}%）`,
    };
  }
  const oteForShort = inOte && range.oteDirection !== 'BULL' && !inDiscount;
  if (inPremium || oteForShort) {
    const usedOte = inOte && (inPremium || oteForShort);
    return {
      passed: true,
      inOte: usedOte,
      quality: usedOte ? 'OTE' : 'ZONE',
      reasonZh: usedOte
        ? `價格在溢價區的 OTE（位置 ${range.pricePositionPct.toFixed(1)}%）`
        : `價格在溢價區（位置 ${range.pricePositionPct.toFixed(1)}%）`,
    };
  }
  return {
    passed: false,
    inOte: false,
    quality: 'WRONG',
    reasonZh: `空單只允許溢價或 OTE，目前在${range.zone === 'DISCOUNT' ? '折價' : '均衡'}區（${range.pricePositionPct.toFixed(1)}%）`,
  };
}

function sequenceForSide(
  side: 'LONG' | 'SHORT',
  sequence: SmcEventSequenceState | null | undefined,
  flags: SideStructureFlags,
  config: SignalGatingConfig
): { passed: boolean; mode: 'COMPLETE' | 'LIGHTER' | 'PARTIAL' | 'NONE'; reasonZh: string } {
  if (sequence?.invalidated && sequence.direction === side) {
    return {
      passed: false,
      mode: 'NONE',
      reasonZh: sequence.invalidationReasonZh ?? '事件序列已失效',
    };
  }
  const complete =
    Boolean(sequence?.isComplete) && sequence?.direction === side && !sequence?.invalidated;
  if (complete) {
    return {
      passed: true,
      mode: 'COMPLETE',
      reasonZh: '事件序列已完成：掃流動性 → MSS/CHoCH → 位移 → FVG/OB',
    };
  }
  const sequenceOwnsOtherSide =
    sequence?.direction === 'LONG' || sequence?.direction === 'SHORT'
      ? sequence.direction !== side
      : false;
  const lighter =
    config.lighterPathEnabled &&
    flags.bosOrMss &&
    flags.fvgOrOb &&
    !sequenceOwnsOtherSide;
  if (lighter) {
    return {
      passed: true,
      mode: 'LIGHTER',
      reasonZh: LIGHTER_PATH_DOC_ZH,
    };
  }
  const steps = sequence?.direction === side ? sequence.completedStepCount : 0;
  if (config.partialSequenceSatisfiesGate && steps >= 3) {
    return {
      passed: true,
      mode: 'PARTIAL',
      reasonZh: `積極預設：同向序列已完成 ${steps}/4 步，視為序列閘門通過`,
    };
  }
  const missing: string[] = [];
  if (!flags.bosOrMss) missing.push('BOS/MSS');
  if (!flags.fvgOrOb) missing.push('FVG 或 OB');
  if (sequenceOwnsOtherSide) {
    return {
      passed: false,
      mode: 'NONE',
      reasonZh: `事件序列方向是 ${sequence?.direction}，輕量路徑不能拿來做反向`,
    };
  }
  if (!config.lighterPathEnabled) {
    return {
      passed: false,
      mode: 'NONE',
      reasonZh: '保守預設只接受完整四步序列，目前序列未完成',
    };
  }
  return {
    passed: false,
    mode: 'NONE',
    reasonZh:
      missing.length > 0
        ? `序列未完成，輕量路徑也缺少 ${missing.join('、')}`
        : '序列未完成，且輕量路徑條件不足',
  };
}

/**
 * CVD classifier. Thresholds match DerivativesStructureEngine
 * (period or second-half price move of 0.35%, second-half taker delta sign).
 */
export function classifyCvdFromKlines(klines: Kline[] | null | undefined): CvdDivergenceType {
  const closed = (klines ?? []).filter(
    (k) =>
      k &&
      k.isClosed !== false &&
      typeof k.takerBuyQuoteVolume === 'number' &&
      Number.isFinite(k.takerBuyQuoteVolume) &&
      Number.isFinite(k.quoteVolume) &&
      k.quoteVolume > 0
  );
  if (closed.length < 8) return 'UNAVAILABLE';
  const deltas = closed.map((k) => {
    const buy = Math.max(0, Math.min(k.quoteVolume, k.takerBuyQuoteVolume as number));
    return { close: k.close, barDelta: buy - (k.quoteVolume - buy) };
  });
  const split = Math.floor(deltas.length / 2);
  const firstClose = deltas[0].close;
  const midClose = deltas[split - 1].close;
  const lastClose = deltas[deltas.length - 1].close;
  if (!(firstClose > 0) || !(midClose > 0)) return 'UNAVAILABLE';
  const periodPricePct = ((lastClose - firstClose) / firstClose) * 100;
  const secondHalfPricePct = ((lastClose - midClose) / midClose) * 100;
  const secondHalfDelta = deltas.slice(split).reduce((acc, row) => acc + row.barDelta, 0);
  const net = deltas.reduce((acc, row) => acc + row.barDelta, 0);
  if ((periodPricePct <= -0.35 || secondHalfPricePct <= -0.35) && secondHalfDelta > 0) {
    return 'BULLISH_ABSORPTION';
  }
  if ((periodPricePct >= 0.35 || secondHalfPricePct >= 0.35) && secondHalfDelta < 0) {
    return 'BEARISH_EXHAUSTION';
  }
  if ((periodPricePct >= 0.35 && net > 0) || (periodPricePct <= -0.35 && net < 0)) {
    return 'CONFIRMED_TREND';
  }
  return 'NONE';
}

export function computeObiPct(
  bids: Array<{ price: number; quantity: number }> | null | undefined,
  asks: Array<{ price: number; quantity: number }> | null | undefined,
  bandPct: number
): number | null {
  if (!bids?.length || !asks?.length) return null;
  const bestBid = Math.max(...bids.map((level) => level.price));
  const bestAsk = Math.min(...asks.map((level) => level.price));
  if (!(bestBid > 0) || !(bestAsk > 0)) return null;
  const mid = (bestBid + bestAsk) / 2;
  const notional = (levels: Array<{ price: number; quantity: number }>) =>
    levels.reduce((acc, level) => {
      if (!(level.price > 0) || !(level.quantity > 0)) return acc;
      const dist = Math.abs(level.price - mid) / mid;
      return dist <= bandPct ? acc + level.price * level.quantity : acc;
    }, 0);
  const bid = notional(bids);
  const ask = notional(asks);
  if (bid + ask <= 0) return null;
  return ((bid - ask) / (bid + ask)) * 100;
}

function obiPoints(
  side: 'LONG' | 'SHORT',
  obi50: number | null | undefined,
  obi100: number | null | undefined,
  obi200: number | null | undefined,
  maxPoints: number
): SignalScoreComponent {
  const primary = obi100 ?? obi50 ?? obi200 ?? null;
  if (primary == null || !Number.isFinite(primary)) {
    return component(
      'obi',
      '盤口失衡 OBI',
      0,
      maxPoints,
      'unavailable：±0.5%／1%／2% 盤口深度未提供，此項不進分母',
      true
    );
  }
  const abs = Math.abs(primary);
  let magnitude = 0;
  if (abs >= 45) magnitude = maxPoints;
  else if (abs >= 25) magnitude = Math.min(maxPoints, 5);
  else if (abs >= 10) magnitude = 3;
  const supports = side === 'LONG' ? primary > 0 : primary < 0;
  let points = supports ? magnitude : -magnitude;
  const confirmA = obi50;
  const confirmB = obi200;
  const agrees = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value) || value === 0
      ? null
      : side === 'LONG'
        ? value > 0
        : value < 0;
  const a = agrees(confirmA);
  const b = agrees(confirmB);
  if (points !== 0 && a === false && b === false) points = Math.round(points / 2);
  else if (points > 0 && (a === true || b === true)) points = Math.min(maxPoints, points + 1);
  const sign = primary >= 0 ? '+' : '';
  return component(
    'obi',
    '盤口失衡 OBI',
    points,
    maxPoints,
    points === 0
      ? `OBI ±1% 為 ${sign}${primary.toFixed(1)}%，未達加減分門檻（|OBI| < 10）`
      : `OBI（主帶 ±1%）${sign}${primary.toFixed(1)}%${supports ? '順向' : '逆向'}本筆${side === 'LONG' ? '多' : '空'}單；±0.5%／±2% 用來確認或減半`
  );
}

function oiComponent(
  side: 'LONG' | 'SHORT',
  oiChangePct: number | null | undefined,
  oiPriceChangePct: number | null | undefined,
  config: SignalGatingConfig,
  openInterestPresent: boolean
): SignalScoreComponent {
  const max = config.weights.oiConfirm;
  if (oiChangePct == null || oiPriceChangePct == null || !Number.isFinite(oiChangePct) || !Number.isFinite(oiPriceChangePct)) {
    return component(
      'oi',
      'OI 與價格',
      0,
      max,
      openInterestPresent
        ? 'unavailable：只有單點未平倉，沒有 OI 變化，此項不進分母'
        : 'unavailable：未平倉量缺失，此項不進分母',
      true
    );
  }
  const priceMin = config.derivatives.oiConfirmAbsPricePct;
  const oiMin = config.derivatives.oiConfirmAbsOiPct;
  const priceUp = oiPriceChangePct >= priceMin;
  const priceDown = oiPriceChangePct <= -priceMin;
  const oiUp = oiChangePct >= oiMin;
  const oiDown = oiChangePct <= -oiMin;
  const confirm =
    (side === 'LONG' && priceUp && oiUp) || (side === 'SHORT' && priceDown && oiUp);
  const falling =
    (side === 'LONG' && priceUp && oiDown) || (side === 'SHORT' && priceDown && oiDown);
  if (confirm) {
    return component(
      'oi',
      'OI 與價格',
      max,
      max,
      `價格${oiPriceChangePct.toFixed(2)}% 且 OI ${oiChangePct.toFixed(2)}%：同向增倉，確認${side === 'LONG' ? '多' : '空'}方新倉`
    );
  }
  if (falling) {
    return component(
      'oi',
      'OI 與價格',
      config.weights.oiFalling,
      max,
      `價格${oiPriceChangePct.toFixed(2)}% 但 OI ${oiChangePct.toFixed(2)}%：OI 下降，較像回補或平倉，確認度較弱`
    );
  }
  return component(
    'oi',
    'OI 與價格',
    0,
    max,
    `價格 ${oiPriceChangePct.toFixed(2)}% 、OI ${oiChangePct.toFixed(2)}% 未同時跨過確認門檻（價格 ${priceMin}% 、OI ${oiMin}%）`
  );
}

function cvdComponent(
  side: 'LONG' | 'SHORT',
  divergence: CvdDivergenceType,
  priceChangePct: number | null | undefined,
  config: SignalGatingConfig
): SignalScoreComponent {
  const max = config.weights.cvdSupport;
  if (divergence === 'UNAVAILABLE') {
    return component('cvd', 'CVD 背離', 0, max, '未計分：K 線沒有 takerBuyQuoteVolume，不推估主動買賣盤');
  }
  if (divergence === 'NONE') {
    return component('cvd', 'CVD 背離', 0, max, 'CVD 與價格沒有背離，這項不加不減');
  }
  if (divergence === 'BULLISH_ABSORPTION') {
    const points = side === 'LONG' ? max : config.weights.cvdOppose;
    return component('cvd', 'CVD 背離', points, max, '價格回落但後半段主動買盤轉正（看漲吸收）');
  }
  if (divergence === 'BEARISH_EXHAUSTION') {
    const points = side === 'SHORT' ? max : config.weights.cvdOppose;
    return component('cvd', 'CVD 背離', points, max, '價格墊高但後半段主動賣盤轉負（看跌派發）');
  }
  const price = priceChangePct ?? 0;
  const trendSupports = side === 'LONG' ? price >= 0 : price < 0;
  return component(
    'cvd',
    'CVD 背離',
    trendSupports ? Math.min(4, max) : -3,
    max,
    trendSupports ? 'CVD 與價格同向，順勢確認' : 'CVD 順勢方向與本筆相反'
  );
}

function fundingComponent(
  side: 'LONG' | 'SHORT',
  fundingRate: number | null | undefined,
  config: SignalGatingConfig
): { component: SignalScoreComponent; crowdedAgainst: boolean } {
  const max = config.weights.fundingHealthy;
  if (fundingRate == null || !Number.isFinite(fundingRate)) {
    return {
      crowdedAgainst: false,
      component: component('funding', '資金費率擁擠', 0, Math.abs(config.weights.fundingCrowded), '未計分：資金費率缺失'),
    };
  }
  const crowdedLong = fundingRate >= config.derivatives.fundingCrowdAbs;
  const crowdedShort = fundingRate <= -config.derivatives.fundingCrowdAbs;
  const against = (side === 'LONG' && crowdedLong) || (side === 'SHORT' && crowdedShort);
  const tailwind = (side === 'LONG' && crowdedShort) || (side === 'SHORT' && crowdedLong);
  if (against) {
    return {
      crowdedAgainst: true,
      component: component(
        'funding',
        '資金費率擁擠',
        config.weights.fundingCrowded,
        Math.abs(config.weights.fundingCrowded),
        `資金費率 ${(fundingRate * 100).toFixed(4)}% 與${side === 'LONG' ? '多' : '空'}單同向擁擠，列為軟性減分`
      ),
    };
  }
  if (tailwind) {
    return {
      crowdedAgainst: false,
      component: component(
        'funding',
        '資金費率擁擠',
        Math.round(max / 2),
        max,
        `資金費率 ${(fundingRate * 100).toFixed(4)}% 偏向對側擁擠，對本筆是軋倉順風而非追價`
      ),
    };
  }
  return {
    crowdedAgainst: false,
    component: component(
      'funding',
      '資金費率擁擠',
      Math.abs(fundingRate) <= 0.0002 ? max : Math.round(max / 2),
      max,
      `資金費率 ${(fundingRate * 100).toFixed(4)}% 未達擁擠門檻`
    ),
  };
}

function geometryComponent(
  side: 'LONG' | 'SHORT',
  input: ResolveSignalInput,
  displacementDetected: boolean
): SignalScoreComponent {
  const ratio = side === 'LONG' ? input.displacementBodyToAtrLong : input.displacementBodyToAtrShort;
  const fvg = side === 'LONG' ? input.fvgAtrMultipleLong : input.fvgAtrMultipleShort;
  const dist = side === 'LONG' ? input.distanceToPoiAtrLong : input.distanceToPoiAtrShort;
  let points = 0;
  const parts: string[] = [];
  if (ratio != null && Number.isFinite(ratio) && ratio > 0) {
    const earned = Math.max(1, Math.min(5, Math.round(ratio * 1.6)));
    points += earned;
    parts.push(`位移實體 ${ratio.toFixed(2)}×ATR +${earned}`);
  } else if (displacementDetected) {
    points += 2;
    parts.push('有同向位移但沒有幅度，先給 +2');
  }
  if (fvg != null && Number.isFinite(fvg) && fvg > 0) {
    const earned = Math.max(1, Math.min(4, Math.round(fvg * 3)));
    points += earned;
    parts.push(`FVG ${fvg.toFixed(2)}×ATR +${earned}`);
  }
  if (dist != null && Number.isFinite(dist)) {
    const earned = dist <= 0.2 ? 4 : dist <= 0.8 ? 2 : dist <= 1.6 ? 0 : -3;
    points += earned;
    parts.push(`距 POI ${dist.toFixed(2)} ATR ${earned >= 0 ? '+' : ''}${earned}`);
  }
  return component(
    'setupGeometry',
    '結構連續量',
    points,
    13,
    parts.length > 0 ? parts.join('；') : '沒有可區分的位移幅度、FVG 大小或 POI 距離'
  );
}

function atLocationExtreme(
  side: 'LONG' | 'SHORT',
  range: PremiumDiscountRange | null | undefined,
  locationPassed: boolean,
  config: SignalGatingConfig
): boolean {
  if (!locationPassed || !range || range.pricePositionPct == null) return false;
  if (range.inOte || range.labels?.includes('IN_OTE')) return true;
  if (side === 'LONG') return range.pricePositionPct <= config.momentum.discountExtremePct;
  return range.pricePositionPct >= config.momentum.premiumExtremePct;
}

function scoreSide(
  side: 'LONG' | 'SHORT',
  input: ResolveSignalInput,
  config: SignalGatingConfig,
  liquidity: LiquidityVerdict
): SideScore {
  const flags = side === 'LONG' ? input.longFlags : input.shortFlags;
  const weights = config.weights;
  const htf = htfLtfAgrees(side, input.mtfAlignment, input.primaryTimeframe, config);
  const sequence = sequenceForSide(side, input.eventSequence, flags, config);
  const location = locationAllows(side, input.premiumDiscount);
  const liquidityPassed = input.isLowLiquidity ? false : liquidity.passed;
  const liquidityReason = input.isLowLiquidity
    ? '呼叫端標記低流動性，不列入正式候選'
    : liquidity.reasonZh;

  const requiredFailed: string[] = [];
  const requiredPassed: SignalDecision['requiredGates'] = [
    {
      key: 'HTF_LTF_AGREEMENT',
      labelZh: 'HTF/LTF 方向協議',
      passed: htf.passed,
      reasonZh: htf.reasonZh,
    },
    {
      key: 'EVENT_SEQUENCE_OR_LIGHTER_PATH',
      labelZh: '事件序列或輕量路徑',
      passed: sequence.passed,
      reasonZh: sequence.reasonZh,
    },
    {
      key: side === 'LONG' ? 'LOCATION_DISCOUNT_OR_OTE' : 'LOCATION_PREMIUM_OR_OTE',
      labelZh: side === 'LONG' ? '多單位置（折價或 OTE）' : '空單位置（溢價或 OTE）',
      passed: location.passed,
      reasonZh: location.reasonZh,
    },
    {
      key: 'TRADABLE_LIQUIDITY',
      labelZh: '可交易流動性',
      passed: liquidityPassed,
      reasonZh: liquidityReason,
    },
  ];
  const entryZone = side === 'LONG' ? input.entryZoneLong : input.entryZoneShort;
  if (entryZone) {
    requiredPassed.push({
      key: 'ENTRY_ZONE',
      labelZh: '有效進場區間與止損止盈',
      passed: entryZone.valid,
      reasonZh: entryZone.reasonZh,
    });
  }
  for (const gate of requiredPassed) {
    if (!gate.passed) requiredFailed.push(gate.key);
  }

  const sequenceDirection = input.eventSequence?.direction;
  const sequenceSweep =
    sequenceDirection === side &&
    !input.eventSequence?.invalidated &&
    Boolean(
      input.eventSequence?.steps.some((step) => step.key === 'LIQUIDITY_SWEEP' && step.complete)
    );
  const ownSweep =
    sequenceSweep ||
    ((sequenceDirection == null || sequenceDirection === 'NONE') && flags.sweep);

  const htfPoints = htf.passed ? weights.htfAgreement : -8;
  const sequencePoints =
    sequence.mode === 'COMPLETE'
      ? weights.sequenceComplete
      : sequence.mode === 'LIGHTER'
        ? weights.sequenceLighter
        : sequence.mode === 'PARTIAL'
          ? weights.sequencePartial
          : 0;
  const locationPoints =
    location.quality === 'OTE'
      ? weights.locationOte
      : location.quality === 'ZONE'
        ? weights.locationZone
        : weights.locationWrong;
  const liquidityPoints = liquidityPassed ? weights.liquidityPass : weights.liquidityFail;

  const change = input.priceChangePercent24h;
  const extreme =
    change != null &&
    Number.isFinite(change) &&
    Math.abs(change) >= config.momentum.extremeAbsChangePct;
  const continuation =
    extreme && ((side === 'LONG' && (change as number) > 0) || (side === 'SHORT' && (change as number) < 0));
  const reversal =
    extreme && ((side === 'LONG' && (change as number) < 0) || (side === 'SHORT' && (change as number) > 0));
  const reversalQualified =
    reversal &&
    sequence.mode === 'COMPLETE' &&
    atLocationExtreme(side, input.premiumDiscount, location.passed, config);
  let momentumPoints = 0;
  let momentumReason = '24h 漲跌未達極端門檻，不作為否決';
  if (reversalQualified) {
    momentumPoints = config.momentum.reversalBonus;
    momentumReason = `24h ${change?.toFixed(2)}% 與本筆相反，但完整序列位於${side === 'LONG' ? '折價' : '溢價'}極端，允許反轉、不加否決`;
  } else if (continuation) {
    momentumPoints = -config.momentum.continuationPenalty;
    momentumReason = `24h ${change?.toFixed(2)}% 與本筆同向且達極端，視為延續追價並減分，不是無條件否決`;
  } else if (reversal) {
    momentumPoints = -config.momentum.incompleteReversalPenalty;
    momentumReason = `24h ${change?.toFixed(2)}% 是反向極端，但序列未在溢價／折價極端完成，先減分`;
  }

  const cvd =
    input.cvdDivergence && input.cvdDivergence !== 'UNAVAILABLE'
      ? input.cvdDivergence
      : classifyCvdFromKlines(input.klinesForCvd);

  const funding = fundingComponent(side, input.fundingRate, config);
  const components: SignalScoreComponent[] = [
    component('htf', 'HTF/LTF 協議', htfPoints, weights.htfAgreement, htf.reasonZh),
    component(
      'sequence',
      '事件序列',
      sequencePoints,
      weights.sequenceComplete,
      sequence.reasonZh
    ),
    component('location', '折價溢價位置', locationPoints, weights.locationOte, location.reasonZh),
    component('liquidity', '可交易流動性', liquidityPoints, weights.liquidityPass, liquidityReason),
    geometryComponent(side, input, flags.displacement),
    component(
      'sweep',
      '流動性掃單',
      ownSweep ? weights.sweep : 0,
      weights.sweep,
      sequenceSweep
        ? '計入事件序列裡的那次掃單，而不是最新一根反向掃單'
        : ownSweep
          ? '沒有定向事件序列，先計入這側自己的掃單'
          : '未計入：這側的事件序列沒有有效掃單'
    ),
    oiComponent(
      side,
      input.oiChangePct,
      input.oiPriceChangePct,
      config,
      input.openInterestPresent !== false
    ),
    cvdComponent(side, cvd, input.oiPriceChangePct ?? input.priceChangePercent24h, config),
    obiPoints(side, input.obi50bpsPct, input.obi100bpsPct, input.obi200bpsPct, weights.obiStrong),
    funding.component,
    component('momentum24h', '24h 動能背景', momentumPoints, config.momentum.reversalBonus, momentumReason),
  ];

  const confidence = confidenceFromComponents(components);
  let softVeto: SideScore['softVeto'] = null;
  if (funding.crowdedAgainst && Math.abs(input.fundingRate ?? 0) >= config.derivatives.fundingCrowdAbs) {
    softVeto = {
      code: 'FUNDING_CROWDING',
      reasonZh: funding.component.reasonZh,
    };
  }
  if ((continuation || (reversal && !reversalQualified)) && confidence < config.momentum.softVetoBelow) {
    softVeto = {
      code: continuation ? 'MOMENTUM_CONTINUATION_CHASE' : 'MOMENTUM_REVERSAL_INCOMPLETE',
      reasonZh: momentumReason,
    };
  }

  const structureEvidence =
    flags.bosOrMss || flags.sweep || flags.displacement || flags.fvgOrOb || sequence.mode !== 'NONE';

  return {
    side,
    confidence,
    components,
    requiredFailed,
    requiredPassed,
    lighterPathUsed: sequence.mode === 'LIGHTER',
    sequenceComplete: sequence.mode === 'COMPLETE',
    structureEvidence,
    softVeto,
  };
}

function pointsToText(row: SignalScoreComponent, positive: boolean): string | null {
  if (positive && row.points > 0) return `${row.labelZh} +${row.points}：${row.reasonZh}`;
  if (!positive && row.points < 0) return `${row.labelZh} ${row.points}：${row.reasonZh}`;
  if (
    !positive &&
    row.points === 0 &&
    (row.unavailable || row.reasonZh.startsWith('未計分') || row.reasonZh.startsWith('unavailable'))
  ) {
    return `${row.labelZh} 0：${row.reasonZh}`;
  }
  return null;
}

export function resolveSignalDecision(input: ResolveSignalInput): SignalDecision {
  const config = input.config ?? resolveSignalGatingConfig({ preset: input.preset });
  const liquidity =
    input.quoteVolume24h == null
      ? {
          passed: !input.isLowLiquidity,
          path: 'ABSOLUTE' as const,
          reasonZh: input.isLowLiquidity
            ? '呼叫端標記低流動性，不列入正式候選'
            : '未另附 24h 成交額，沿用呼叫端流動性標記（非低流動性）',
        }
      : evaluateTradableLiquidity({
          quoteVolume24h: input.quoteVolume24h,
          spreadPercent: input.spreadPercent,
          medianQuoteVolume24h: input.medianQuoteVolume24h,
          depthUsdWithin1Pct: input.depthUsdWithin1Pct,
          config,
        });
  const longScore = scoreSide('LONG', input, config, liquidity);
  const shortScore = scoreSide('SHORT', input, config, liquidity);
  const formalReady = (side: SideScore) =>
    side.requiredFailed.length === 0 &&
    !side.softVeto &&
    side.confidence >= config.formalMinConfidence;
  const longReady = formalReady(longScore);
  const shortReady = formalReady(shortScore);
  const winner =
    longReady && !shortReady
      ? longScore
      : shortReady && !longReady
        ? shortScore
        : longScore.confidence >= shortScore.confidence
          ? longScore
          : shortScore;
  const loser = winner.side === 'LONG' ? shortScore : longScore;
  const margin = Math.abs(longScore.confidence - shortScore.confidence);
  const bothMeaningful =
    longScore.confidence >= config.conflict.minMeaningfulScore &&
    shortScore.confidence >= config.conflict.minMeaningfulScore;
  const conflictBlocked =
    bothMeaningful && margin < config.conflict.minScoreMargin && longReady === shortReady;

  const dataBlockers = (input.dataBlockers ?? []).filter((row) => row.trim().length > 0);
  const formulasZh = [
    '信心 = clamp(0, 100, round(有效分項 / (100 − 不可用項上限) × 100))。OI／OBI 缺資料標 unavailable，不假裝 0 分。',
    '必要閘門只有四項：HTF/LTF 協議、完整序列或輕量路徑、多單折價/OTE 或空單溢價/OTE、可交易流動性。',
    LIGHTER_PATH_DOC_ZH,
    'OI 確認：價格同向 ≥ 0.25% 且 OI ≥ +0.5% 加分；OI ≤ −0.5% 則減分。',
    'OBI(band) = (bidNotional − askNotional) / (bidNotional + askNotional) × 100，帶寬 ±0.5%／±1%／±2%。',
    '24h 極端動能只改分數：順向追價減分，反向且完整序列位於極端折價／溢價則允許並小加分。',
    `多空分差低於 ${config.conflict.minScoreMargin} 且兩側都 ≥ ${config.conflict.minMeaningfulScore} 時才 WAIT，並同時報告兩邊分數。`,
  ];

  let actionState: SmcActionState = 'WAIT';
  const missingGates: string[] = [];
  const waitReasons: string[] = [];

  if (input.extremeFunding || input.lowLiquidityHighVolatility) {
    actionState = 'HIGH RISK';
    if (input.extremeFunding) {
      missingGates.push('EXTREME_FUNDING_RISK');
      waitReasons.push('高風險攔截：資金費率極端 (Funding 高風險，禁止列入一般候選)');
    }
    if (input.lowLiquidityHighVolatility) {
      missingGates.push('LOW_LIQUIDITY_HIGH_VOLATILITY');
      waitReasons.push('高風險攔截：低流動性高波動異常 (禁止列入一般候選)');
    }
  } else if (dataBlockers.length > 0) {
    actionState = 'WAIT';
    missingGates.push('DATA_INTEGRITY');
    waitReasons.push(...dataBlockers);
  } else if ((longReady || shortReady) && !conflictBlocked) {
    actionState = winner.side === 'LONG' ? 'LONG CANDIDATE' : 'SHORT CANDIDATE';
  } else if (conflictBlocked) {
    actionState = 'WAIT';
    missingGates.push('DIRECTION_CONFLICT_WITHIN_MARGIN');
    waitReasons.push(
      `多空分數落在衝突邊距內（多 ${longScore.confidence} / 空 ${shortScore.confidence}，差 ${margin} < ${config.conflict.minScoreMargin}），兩邊都列出、暫不選邊`
    );
  } else {
    const belowFormal =
      winner.requiredFailed.length === 0 &&
      !winner.softVeto &&
      winner.confidence < config.formalMinConfidence;
    if (winner.softVeto) {
      missingGates.push(winner.softVeto.code);
      waitReasons.push(winner.softVeto.reasonZh);
    }
    if (belowFormal) {
      missingGates.push('CONFIDENCE_BELOW_FORMAL');
      waitReasons.push(
        `信心 ${winner.confidence} 低於正式候選門檻 ${config.formalMinConfidence}`
      );
    }
    if (winner.requiredFailed.length === 0 && !winner.softVeto && !belowFormal && !winner.structureEvidence) {
      missingGates.push('NO_STRUCTURE');
      waitReasons.push('目前沒有足夠的 SMC 結構證據');
    }
    missingGates.push(...winner.requiredFailed);
    waitReasons.push(
      ...winner.requiredPassed.filter((gate) => !gate.passed).map((gate) => gate.reasonZh)
    );
    const blockerCount = new Set(missingGates).size;
    const watch =
      winner.confidence >= config.watchMinConfidence &&
      blockerCount > 0 &&
      blockerCount <= config.watchMaxMissingGates &&
      (winner.structureEvidence || belowFormal || Boolean(winner.softVeto));
    actionState = watch ? 'WATCH' : 'WAIT';
  }

  if (actionState !== 'LONG CANDIDATE' && actionState !== 'SHORT CANDIDATE') {
    for (const gate of winner.requiredFailed) {
      if (!missingGates.includes(gate)) missingGates.push(gate);
    }
  }

  const plusPoints = winner.components
    .map((row) => pointsToText(row, true))
    .filter((row): row is string => Boolean(row));
  const minusPoints = winner.components
    .map((row) => pointsToText(row, false))
    .filter((row): row is string => Boolean(row));
  if (conflictBlocked) {
    minusPoints.unshift(
      `多空衝突：多方 ${longScore.confidence}、空方 ${shortScore.confidence}，分差 ${margin} 低於邊距 ${config.conflict.minScoreMargin}`
    );
  }

  const sideLabel = winner.side === 'LONG' ? '多方' : '空方';
  let stateReasonZh: string;
  if (actionState === 'LONG CANDIDATE' || actionState === 'SHORT CANDIDATE') {
    const via = winner.sequenceComplete ? '完整事件序列' : winner.lighterPathUsed ? '輕量路徑' : '序列閘門';
    stateReasonZh = `正式${winner.side === 'LONG' ? '多頭' : '空頭'}候選：四項必要閘門通過（HTF/LTF 協議、${via}、${winner.side === 'LONG' ? '折價或 OTE' : '溢價或 OTE'}、可交易流動性），${sideLabel}信心 ${winner.confidence}，對側 ${loser.confidence}，分差 ${margin}`;
    plusPoints.unshift(stateReasonZh);
  } else if (actionState === 'WATCH') {
    stateReasonZh = `WATCH：${sideLabel}信心 ${winner.confidence}、對側 ${loser.confidence}。未升正式候選是因為 ${waitReasons[0] ?? missingGates.join('、')}`;
  } else if (actionState === 'HIGH RISK') {
    stateReasonZh = `HIGH RISK：${waitReasons.join('；') || '極端費率或低流動性高波動'}`;
  } else {
    stateReasonZh = `WAIT：${waitReasons.join('；') || missingGates.join('、') || '沒有可交易結構'}（多方 ${longScore.confidence} / 空方 ${shortScore.confidence}）`;
  }
  if (actionState !== 'LONG CANDIDATE' && actionState !== 'SHORT CANDIDATE' && waitReasons.length === 0) {
    waitReasons.push(stateReasonZh);
  }

  const uniqueMissing = [...new Set(missingGates)];
  return {
    version: 'signal-gating-v1',
    preset: config.preset,
    actionState,
    confidence: winner.confidence,
    side: actionState === 'WAIT' && conflictBlocked ? 'NONE' : winner.side,
    longScore: longScore.confidence,
    shortScore: shortScore.confidence,
    margin,
    conflictMargin: config.conflict.minScoreMargin,
    conflictBlocked,
    requiredGates: winner.requiredPassed,
    missingGates: uniqueMissing,
    waitReasons,
    components: winner.components,
    plusPoints,
    minusPoints,
    stateReasonZh,
    lighterPath: {
      id: LIGHTER_PATH_ID,
      documentedZh: LIGHTER_PATH_DOC_ZH,
      enabled: config.lighterPathEnabled,
      used: actionState !== 'HIGH RISK' && winner.lighterPathUsed,
    },
    formulasZh,
    liquidityPath: liquidity.path,
  };
}

export function smcQualityPoints(
  actionState: SmcActionState,
  confidence: number | null | undefined
): number {
  if (actionState === 'PENDING') return 0;
  const conf = confidence == null || !Number.isFinite(confidence) ? defaultConfidence(actionState) : confidence;
  if (actionState === 'LONG CANDIDATE' || actionState === 'SHORT CANDIDATE') {
    return Math.round(12 + (conf / 100) * 12);
  }
  if (actionState === 'WATCH') return Math.round((conf / 100) * 8);
  if (actionState === 'HIGH RISK') return -18;
  return Math.round(-12 + (conf / 100) * 6);
}

function defaultConfidence(actionState: SmcActionState): number {
  if (actionState === 'LONG CANDIDATE' || actionState === 'SHORT CANDIDATE') return 72;
  if (actionState === 'WATCH') return 45;
  if (actionState === 'HIGH RISK') return 8;
  return 18;
}

export function inferDowngradeCodes(reasons: string[]): string[] {
  const codes: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/資金費率極端|極端區間|EXTREME_FUNDING|高風險攔截：資金費率/, 'EXTREME_FUNDING_RISK'],
    [/低流動性高波動|低流動性且高波動/, 'LOW_LIQUIDITY_HIGH_VOLATILITY'],
    [/BTC 大盤/, 'BTC_REGIME_FILTER'],
    [/延續追價|MOMENTUM_CONTINUATION/, 'MOMENTUM_CONTINUATION_CHASE'],
    [/序列未在溢價|MOMENTUM_REVERSAL_INCOMPLETE|反向極端/, 'MOMENTUM_REVERSAL_INCOMPLETE'],
    [/第一層市場雷達方向/, 'RADAR_DIRECTION_CONFLICT'],
    [/雙層交易候選/, 'POST_EVAL_DOWNGRADE'],
    [/INSUFFICIENT_HISTORY|BASELINE_UNSTABLE|歷史成交量|已確認收盤 K 線數量不足/, 'HISTORY_BASELINE'],
    [/低流動性|盤口價差|價差過寬|灰塵門檻/, 'LIQUIDITY_SAFETY'],
    [/擁擠/, 'FUNDING_CROWDING'],
    [/資料已過期|基礎欄位缺失|DATA_INTEGRITY/, 'DATA_INTEGRITY'],
  ];
  for (const reason of reasons) {
    for (const [pattern, code] of rules) {
      if (pattern.test(reason) && !codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

export function ensureBlockedReasonsVisible(
  missingGates: string[],
  waitReasons: string[],
  isFormal: boolean
): string[] {
  if (isFormal) return missingGates;
  const next = [...missingGates];
  for (const code of inferDowngradeCodes(waitReasons)) {
    if (!next.includes(code)) next.push(code);
  }
  if (next.length === 0 && waitReasons.length > 0) next.push('STATE_REASON');
  return next;
}
