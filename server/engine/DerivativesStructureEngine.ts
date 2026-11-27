import {
  CvdDivergenceType,
  DerivativesStructureAnalysis,
  DerivativesStructurePoint,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  LiquidityPoolLevel,
  OiPriceRegime,
  Timeframe,
} from '../../src/types/market.ts';
import { calculateConfirmedAtr14 } from './SmcRuleEngine.ts';
import {
  annualizedFundingPercent,
  DEFAULT_FUNDING_INTERVAL_HOURS,
  type FundingIntervalSource,
} from '../market/FundingInterval.ts';

interface ConfirmedSwingPoint {
  type: 'HIGH' | 'LOW';
  price: number;
  openTime: number;
}

function detectConfirmedSwings(
  closedKlines: Kline[],
  span = 2
): ConfirmedSwingPoint[] {
  const swings: ConfirmedSwingPoint[] = [];
  if (closedKlines.length < span * 2 + 1) return swings;
  for (let i = span; i < closedKlines.length - span; i++) {
    const curr = closedKlines[i];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= span; offset++) {
      if (
        curr.high < closedKlines[i - offset].high ||
        curr.high <= closedKlines[i + offset].high
      ) {
        isHigh = false;
      }
      if (
        curr.low > closedKlines[i - offset].low ||
        curr.low >= closedKlines[i + offset].low
      ) {
        isLow = false;
      }
    }
    if (isHigh) {
      swings.push({ type: 'HIGH', price: curr.high, openTime: curr.openTime });
    }
    if (isLow) {
      swings.push({ type: 'LOW', price: curr.low, openTime: curr.openTime });
    }
  }
  return swings;
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatLabel(openTimeMs: number): string {
  const d = new Date(openTimeMs);
  if (!Number.isFinite(d.getTime())) return String(openTimeMs);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function getNearestOiAtOrBefore(
  oiSorted: HistoricalOpenInterestPoint[],
  targetOpenTime: number,
  toleranceMs: number
): HistoricalOpenInterestPoint | null {
  if (oiSorted.length === 0) return null;
  let best: HistoricalOpenInterestPoint | null = null;
  let bestDiff = Infinity;
  for (const pt of oiSorted) {
    const diff = Math.abs(pt.timestamp - targetOpenTime);
    if (diff <= toleranceMs && diff < bestDiff) {
      best = pt;
      bestDiff = diff;
    }
  }
  return best;
}

function getCloseNearTimestamp(
  closedKlines: Kline[],
  targetTs: number
): number | null {
  if (closedKlines.length === 0) return null;
  let best = closedKlines[0];
  let bestDiff = Math.abs(closedKlines[0].openTime - targetTs);
  for (const k of closedKlines) {
    const diff = Math.abs(k.openTime - targetTs);
    if (diff < bestDiff) {
      best = k;
      bestDiff = diff;
    }
  }
  return best.close > 0 ? best.close : null;
}

export function computeDerivativesStructure(params: {
  symbol: string;
  timeframe: Timeframe;
  lastPrice: number;
  atr14?: number | null;
  klines: Kline[];
  oiSeries: HistoricalOpenInterestPoint[];
  fundingSeries: HistoricalFundingRatePoint[];
  currentOiValue?: number | null;
  currentFundingRate?: number | null;
  fundingIntervalHours?: number | null;
  fundingIntervalFallback?: boolean;
  fundingIntervalSource?: FundingIntervalSource;
  fundingIntervalNoteZh?: string | null;
  evaluatedAt?: string;
}): DerivativesStructureAnalysis {
  const evaluatedAt = params.evaluatedAt ?? new Date().toISOString();
  const closedKlines = [...params.klines]
    .filter(
      (k) =>
        k &&
        k.isClosed &&
        Number.isFinite(k.openTime) &&
        Number.isFinite(k.close) &&
        k.close > 0
    )
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-48);

  const oiSorted = [...params.oiSeries]
    .filter(
      (pt) =>
        pt &&
        Number.isFinite(pt.timestamp) &&
        Number.isFinite(pt.openInterest) &&
        pt.openInterest > 0
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-48);

  const fundingSorted = [...params.fundingSeries]
    .filter(
      (pt) =>
        pt &&
        Number.isFinite(pt.timestamp) &&
        Number.isFinite(pt.fundingRate)
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-48);

  const atr14 =
    params.atr14 ?? calculateConfirmedAtr14(closedKlines) ?? null;

  // ========================================================================
  // 1. OI x Price 4-Quadrant Regime
  // ========================================================================
  let oiRegimeStatus: 'READY' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let regime: OiPriceRegime = 'UNAVAILABLE';
  let regimeLabelZh = 'OI 歷史資料不可用';
  let oiPriceChangePct: number | null = null;
  let oiChangePct: number | null = null;
  let oiInterpretationZh =
    '目前交易所或此標的不支援歷史 OI 時序查詢，無法判定 4 象限增減倉結構。';

  const oiWindow = oiSorted.slice(-16);
  const latestOiVal =
    oiWindow.length > 0
      ? (oiWindow[oiWindow.length - 1].openInterestValue ??
          oiWindow[oiWindow.length - 1].openInterest * params.lastPrice)
      : (params.currentOiValue ?? null);

  if (oiWindow.length >= 4 && closedKlines.length >= 4) {
    const firstOi = oiWindow[0];
    const lastOi = oiWindow[oiWindow.length - 1];
    const oiStart = firstOi.openInterest;
    const oiEnd = lastOi.openInterest;
    const closeStart = getCloseNearTimestamp(closedKlines, firstOi.timestamp);
    const closeEnd =
      getCloseNearTimestamp(closedKlines, lastOi.timestamp) ??
      closedKlines[closedKlines.length - 1].close;

    if (oiStart > 0 && closeStart && closeStart > 0 && closeEnd > 0) {
      oiRegimeStatus = 'READY';
      oiChangePct = roundTo(((oiEnd - oiStart) / oiStart) * 100, 2);
      oiPriceChangePct = roundTo(((closeEnd - closeStart) / closeStart) * 100, 2);

      if (oiPriceChangePct >= 0.25 && oiChangePct >= 0.5) {
        regime = 'LONG_BUILDUP';
        regimeLabelZh = '多頭主動增倉 (Price↑ OI↑)';
        oiInterpretationZh = `近 ${oiWindow.length} 筆取樣價格上漲 ${oiPriceChangePct}% 且 OI 增加 ${oiChangePct}%，顯示新多頭資金積極進場建倉。`;
      } else if (oiPriceChangePct >= 0.25 && oiChangePct <= -0.5) {
        regime = 'SHORT_COVERING';
        regimeLabelZh = '空頭回補軋空 (Price↑ OI↓)';
        oiInterpretationZh = `近 ${oiWindow.length} 筆取樣價格上漲 ${oiPriceChangePct}% 但 OI 下降 ${Math.abs(oiChangePct)}%，偏向空單停損回補推升，須留意動能延續性。`;
      } else if (oiPriceChangePct <= -0.25 && oiChangePct >= 0.5) {
        regime = 'SHORT_BUILDUP';
        regimeLabelZh = '空頭主動增倉 (Price↓ OI↑)';
        oiInterpretationZh = `近 ${oiWindow.length} 筆取樣價格下跌 ${Math.abs(oiPriceChangePct)}% 且 OI 增加 ${oiChangePct}%，顯示空頭合約持續加倉施壓。`;
      } else if (oiPriceChangePct <= -0.25 && oiChangePct <= -0.5) {
        regime = 'LONG_LIQUIDATION';
        regimeLabelZh = '多頭平倉殺多 (Price↓ OI↓)';
        oiInterpretationZh = `近 ${oiWindow.length} 筆取樣價格下跌 ${Math.abs(oiPriceChangePct)}% 且 OI 萎縮 ${Math.abs(oiChangePct)}%，顯示槓桿多單正在被迫去槓桿與停損洗盤。`;
      } else {
        regime = 'NEUTRAL';
        regimeLabelZh = '量倉盤整換手 (Price/OI 均衡)';
        oiInterpretationZh = `價格變動 (${oiPriceChangePct}%) 與未平倉變化 (${oiChangePct}%) 皆屬溫和換手區間，尚未出現單邊槓桿失衡。`;
      }
    }
  }

  // ========================================================================
  // 2. CVD (Cumulative Volume Delta) from Real Taker Buy Quote Volume
  // ========================================================================
  const cvdValidKlines = closedKlines.filter(
    (k) =>
      typeof k.takerBuyQuoteVolume === 'number' &&
      Number.isFinite(k.takerBuyQuoteVolume) &&
      Number.isFinite(k.quoteVolume) &&
      k.quoteVolume > 0
  );

  let cvdStatus: 'READY' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let netDeltaUsd: number | null = null;
  let latestBarDeltaUsd: number | null = null;
  let takerBuyRatioPct: number | null = null;
  let divergence: CvdDivergenceType = 'UNAVAILABLE';
  let divergenceLabelZh = '主動買賣量 (Taker Buy) 資料不可用';
  let cvdInterpretationZh =
    '目前交易所 K 線未提供 takerBuyQuoteVolume 或快取尚未更新，不推估虛構主動買賣盤。';

  const barIntervalMs =
    closedKlines.length >= 2
      ? Math.max(60_000, closedKlines[1].openTime - closedKlines[0].openTime)
      : 15 * 60_000;

  let runningCvd = 0;
  let totalTakerBuy = 0;
  let totalQuoteVol = 0;
  const barDeltas: Array<{ close: number; barDelta: number; cumCvd: number }> =
    [];

  const series: DerivativesStructurePoint[] = closedKlines.map((k) => {
    const matchedOi = getNearestOiAtOrBefore(
      oiSorted,
      k.openTime,
      barIntervalMs * 1.5
    );
    const hasTaker =
      typeof k.takerBuyQuoteVolume === 'number' &&
      Number.isFinite(k.takerBuyQuoteVolume) &&
      k.quoteVolume > 0;

    let buyQuote: number | null = null;
    let sellQuote: number | null = null;
    let barDelta: number | null = null;
    let cumCvdSnapshot: number | null = null;

    if (hasTaker) {
      buyQuote = Math.max(0, Math.min(k.quoteVolume, k.takerBuyQuoteVolume!));
      sellQuote = Math.max(0, k.quoteVolume - buyQuote);
      barDelta = roundTo(buyQuote - sellQuote, 2);
      runningCvd = roundTo(runningCvd + barDelta, 2);
      totalTakerBuy += buyQuote;
      totalQuoteVol += k.quoteVolume;
      cumCvdSnapshot = runningCvd;
      barDeltas.push({ close: k.close, barDelta, cumCvd: runningCvd });
    }

    return {
      openTime: k.openTime,
      label: formatLabel(k.openTime),
      close: k.close,
      takerBuyQuoteVolume: buyQuote !== null ? roundTo(buyQuote, 2) : null,
      takerSellQuoteVolume: sellQuote !== null ? roundTo(sellQuote, 2) : null,
      barDeltaUsd: barDelta,
      cumulativeCvdUsd: cumCvdSnapshot,
      openInterest: matchedOi?.openInterest ?? null,
      openInterestValue: matchedOi?.openInterestValue ?? null,
    };
  });

  if (cvdValidKlines.length >= 8 && barDeltas.length >= 8 && totalQuoteVol > 0) {
    cvdStatus = 'READY';
    netDeltaUsd = roundTo(runningCvd, 2);
    latestBarDeltaUsd = barDeltas[barDeltas.length - 1].barDelta;
    takerBuyRatioPct = roundTo((totalTakerBuy / totalQuoteVol) * 100, 1);

    const split = Math.floor(barDeltas.length / 2);
    const firstClose = barDeltas[0].close;
    const midClose = barDeltas[split - 1].close;
    const lastClose = barDeltas[barDeltas.length - 1].close;
    const periodPricePct = ((lastClose - firstClose) / firstClose) * 100;
    const secondHalfPricePct = ((lastClose - midClose) / midClose) * 100;
    const secondHalfDelta = barDeltas
      .slice(split)
      .reduce((acc, x) => acc + x.barDelta, 0);

    if (
      (periodPricePct <= -0.35 || secondHalfPricePct <= -0.35) &&
      secondHalfDelta > 0
    ) {
      divergence = 'BULLISH_ABSORPTION';
      divergenceLabelZh = '看漲吸收背離 (Bullish Absorption)';
      cvdInterpretationZh = `價格區間回落但後半段主動買盤淨流入 +$${Math.abs(Math.round(secondHalfDelta)).toLocaleString()}，顯示低檔有主動買單承接。`;
    } else if (
      (periodPricePct >= 0.35 || secondHalfPricePct >= 0.35) &&
      secondHalfDelta < 0
    ) {
      divergence = 'BEARISH_EXHAUSTION';
      divergenceLabelZh = '看跌派發背離 (Bearish Exhaustion)';
      cvdInterpretationZh = `價格區間墊高但後半段主動賣盤淨流出 -$${Math.abs(Math.round(secondHalfDelta)).toLocaleString()}，追高買盤動能減弱。`;
    } else if (
      (periodPricePct >= 0.35 && netDeltaUsd > 0) ||
      (periodPricePct <= -0.35 && netDeltaUsd < 0)
    ) {
      divergence = 'CONFIRMED_TREND';
      divergenceLabelZh = '主動流量順勢確認 (Confirmed Trend)';
      cvdInterpretationZh = `近 ${barDeltas.length} 根主動買盤佔比 ${takerBuyRatioPct}%，CVD 與價格趨勢同向共振。`;
    } else {
      divergence = 'NONE';
      divergenceLabelZh = '買賣盤大致均衡 (無背離)';
      cvdInterpretationZh = `近 ${barDeltas.length} 根 Taker 主動買盤佔比 ${takerBuyRatioPct}%，多空主動單力道接近平衡。`;
    }
  }

  // ========================================================================
  // 3. Historical Funding Rate Trend & Squeeze Risk
  // ========================================================================
  let fundingStatus: 'READY' | 'UNAVAILABLE' = 'UNAVAILABLE';
  const latestHistoryFunding =
    fundingSorted.length > 0
      ? fundingSorted[fundingSorted.length - 1].fundingRate
      : null;
  const resolvedCurrentFunding =
    params.currentFundingRate ?? latestHistoryFunding ?? null;
  let avgFundingRate: number | null = null;
  let deltaBps: number | null = null;
  let annualizedPct: number | null = null;
  const intervalHours =
    typeof params.fundingIntervalHours === 'number' &&
    Number.isFinite(params.fundingIntervalHours) &&
    params.fundingIntervalHours > 0
      ? params.fundingIntervalHours
      : DEFAULT_FUNDING_INTERVAL_HOURS;
  const fundingIntervalFallback =
    params.fundingIntervalFallback ??
    !(
      typeof params.fundingIntervalHours === 'number' &&
      Number.isFinite(params.fundingIntervalHours) &&
      params.fundingIntervalHours > 0
    );
  const fundingIntervalSource: FundingIntervalSource =
    params.fundingIntervalSource ??
    (fundingIntervalFallback ? 'fallback' : 'exchange');
  let squeezeBias:
    | 'SHORT_SQUEEZE_RISK'
    | 'LONG_SQUEEZE_RISK'
    | 'BALANCED'
    | 'UNAVAILABLE' = 'UNAVAILABLE';
  let squeezeLabelZh = '資金費率資料不可用';

  if (resolvedCurrentFunding !== null && Number.isFinite(resolvedCurrentFunding)) {
    fundingStatus = 'READY';
    const recentRates =
      fundingSorted.length > 0
        ? fundingSorted.slice(-24).map((f) => f.fundingRate)
        : [resolvedCurrentFunding];
    avgFundingRate =
      recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
    deltaBps = roundTo((resolvedCurrentFunding - avgFundingRate) * 10_000, 2);
    annualizedPct = roundTo(
      annualizedFundingPercent(resolvedCurrentFunding, intervalHours),
      2
    );

    if (resolvedCurrentFunding <= -0.0002) {
      squeezeBias = 'SHORT_SQUEEZE_RISK';
      squeezeLabelZh = '負費率空單擁擠 (具軋空上衝風險)';
    } else if (resolvedCurrentFunding >= 0.0004) {
      squeezeBias = 'LONG_SQUEEZE_RISK';
      squeezeLabelZh = '正費率偏高多單擁擠 (防多殺多回調)';
    } else {
      squeezeBias = 'BALANCED';
      squeezeLabelZh = '資金費率處於健康均衡區間';
    }
  }

  // ========================================================================
  // 4. Liquidity / Liquidation Pool Clusters (Derived Strictly from Confirmed Swing Highs/Lows)
  // ========================================================================
  const liquidityClusters: LiquidityPoolLevel[] = [];
  if (closedKlines.length >= 12 && params.lastPrice > 0) {
    const swings = detectConfirmedSwings(closedKlines, 2);
    const atrPad = atr14 && atr14 > 0 ? atr14 * 0.12 : params.lastPrice * 0.0015;

    // Deduplicate levels within 0.35% of each other
    const dedupLevels = (
      candidates: Array<{
        price: number;
        side: 'BUY_SIDE_LIQ' | 'SELL_SIDE_LIQ';
        strengthScore: number;
        basisLabel: string;
      }>
    ) => {
      const accepted: typeof candidates = [];
      for (const c of candidates) {
        const tooClose = accepted.some(
          (a) => Math.abs(a.price - c.price) / c.price < 0.0035
        );
        if (!tooClose) accepted.push(c);
      }
      return accepted;
    };

    const buySideRaw = swings
      .filter((s) => s.type === 'HIGH' && s.price > params.lastPrice * 1.001)
      .sort((a, b) => a.price - b.price)
      .slice(0, 6)
      .map((s, idx) => {
        const clusterPrice = Number((s.price + atrPad).toPrecision(6));
        const touches = closedKlines.filter(
          (k) => Math.abs(k.high - s.price) / s.price <= 0.004
        ).length;
        const strengthScore = Math.min(95, 55 + touches * 10 + (idx === 0 ? 12 : 0));
        return {
          price: clusterPrice,
          side: 'BUY_SIDE_LIQ' as const,
          strengthScore,
          basisLabel: `Wave High $${s.price.toPrecision(5)} 上方止損/空單清算池`,
        };
      });

    const sellSideRaw = swings
      .filter((s) => s.type === 'LOW' && s.price < params.lastPrice * 0.999)
      .sort((a, b) => b.price - a.price)
      .slice(0, 6)
      .map((s, idx) => {
        const clusterPrice = Number(
          Math.max(s.price - atrPad, s.price * 0.98).toPrecision(6)
        );
        const touches = closedKlines.filter(
          (k) => Math.abs(k.low - s.price) / s.price <= 0.004
        ).length;
        const strengthScore = Math.min(95, 55 + touches * 10 + (idx === 0 ? 12 : 0));
        return {
          price: clusterPrice,
          side: 'SELL_SIDE_LIQ' as const,
          strengthScore,
          basisLabel: `Wave Low $${s.price.toPrecision(5)} 下方止損/多單清算池`,
        };
      });

    const buySideTop = dedupLevels(buySideRaw).slice(0, 2);
    const sellSideTop = dedupLevels(sellSideRaw).slice(0, 2);

    const allTop = [...buySideTop.reverse(), ...sellSideTop];
    allTop.forEach((lvl, i) => {
      const distPct = roundTo(
        ((lvl.price - params.lastPrice) / params.lastPrice) * 100,
        2
      );
      const estimatedClusterUsd =
        latestOiVal && latestOiVal > 0
          ? Math.round(latestOiVal * (0.04 + (lvl.strengthScore / 100) * 0.06))
          : null;
      liquidityClusters.push({
        id: `${lvl.side}_${i}`,
        side: lvl.side,
        price: lvl.price,
        distancePercent: distPct,
        strengthScore: lvl.strengthScore,
        basisLabel: lvl.basisLabel,
        estimatedClusterUsd,
      });
    });
  }

  // Overall concise summary
  const summaryParts: string[] = [];
  if (oiRegimeStatus === 'READY') summaryParts.push(regimeLabelZh);
  if (cvdStatus === 'READY') {
    summaryParts.push(
      `Taker 買盤佔比 ${takerBuyRatioPct}% (${divergenceLabelZh})`
    );
  }
  if (fundingStatus === 'READY') {
    summaryParts.push(squeezeLabelZh);
  }
  const summaryZh =
    summaryParts.length > 0
      ? summaryParts.join(' · ')
      : '衍生品時序資料載入不足，僅提供現有快照欄位。';

  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    evaluatedAt,
    oiRegime: {
      status: oiRegimeStatus,
      regime,
      regimeLabelZh,
      priceChangePct: oiPriceChangePct,
      oiChangePct,
      currentOiValue: latestOiVal ? Math.round(latestOiVal) : null,
      sampleCount: oiWindow.length,
      interpretationZh: oiInterpretationZh,
    },
    cvd: {
      status: cvdStatus,
      barCount: cvdValidKlines.length,
      netDeltaUsd,
      latestBarDeltaUsd,
      takerBuyRatioPct,
      divergence,
      divergenceLabelZh,
      interpretationZh: cvdInterpretationZh,
    },
    funding: {
      status: fundingStatus,
      currentRate: resolvedCurrentFunding,
      avgRate: avgFundingRate,
      deltaBps,
      annualizedPct,
      fundingIntervalHours: intervalHours,
      fundingIntervalSource,
      fundingIntervalFallback,
      fundingIntervalNoteZh:
        params.fundingIntervalNoteZh ??
        (fundingIntervalFallback
          ? '無法取得該交易對結算週期，年化暫以 8 小時結算估算（已標記 fallback）'
          : `每 ${intervalHours} 小時結算`),
      squeezeBias,
      squeezeLabelZh,
      sampleCount: fundingSorted.length,
    },
    liquidityClusters,
    series,
    summaryZh,
  };
}
