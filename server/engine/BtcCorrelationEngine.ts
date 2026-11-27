import {
  BtcCorrelationOverlayPoint,
  BtcCorrelationTier,
  BtcKlineCorrelationAnalysis,
  BtcKlineCorrelationSummary,
  BtcMarketRegime,
  BtcRegimeState,
  BtcTimeframeCorrelationMetric,
  Kline,
  Timeframe,
} from '../../src/types/market.ts';

export const BTC_BENCHMARK_SYMBOL = 'BTCUSDT';
export const BTC_CORRELATION_MIN_ALIGNED_BARS = 15;
export const BTC_CORRELATION_MAX_BARS = 48;

interface AlignedPair {
  openTime: number;
  sym: Kline;
  btc: Kline;
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatOverlayTimeLabel(openTimeMs: number): string {
  const d = new Date(openTimeMs);
  if (!Number.isFinite(d.getTime())) return String(openTimeMs);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

export function alignConfirmedKlinesByOpenTime(
  symbolKlines: Kline[],
  btcKlines: Kline[],
  maxBars = BTC_CORRELATION_MAX_BARS
): AlignedPair[] {
  if (!symbolKlines.length || !btcKlines.length) return [];

  const btcByOpenTime = new Map<number, Kline>();
  for (const k of btcKlines) {
    if (
      k &&
      k.isClosed &&
      Number.isFinite(k.openTime) &&
      Number.isFinite(k.close) &&
      k.close > 0
    ) {
      btcByOpenTime.set(k.openTime, k);
    }
  }

  const aligned: AlignedPair[] = [];
  const seenOpenTimes = new Set<number>();
  const sortedSymbol = [...symbolKlines]
    .filter(
      (k) =>
        k &&
        k.isClosed &&
        Number.isFinite(k.openTime) &&
        Number.isFinite(k.close) &&
        k.close > 0
    )
    .sort((a, b) => a.openTime - b.openTime);

  for (const sym of sortedSymbol) {
    if (seenOpenTimes.has(sym.openTime)) continue;
    const btc = btcByOpenTime.get(sym.openTime);
    if (!btc) continue;
    seenOpenTimes.add(sym.openTime);
    aligned.push({ openTime: sym.openTime, sym, btc });
  }

  if (aligned.length > maxBars) {
    return aligned.slice(aligned.length - maxBars);
  }
  return aligned;
}

export function computeTimeframeBtcCorrelation(
  timeframe: Timeframe,
  symbolKlines: Kline[],
  btcKlines: Kline[],
  options: {
    includeSeries?: boolean;
    minRequiredBars?: number;
    maxBars?: number;
  } = {}
): BtcTimeframeCorrelationMetric {
  const minRequiredBars =
    options.minRequiredBars ?? BTC_CORRELATION_MIN_ALIGNED_BARS;
  const maxBars = options.maxBars ?? BTC_CORRELATION_MAX_BARS;
  const includeSeries = options.includeSeries ?? false;

  const aligned = alignConfirmedKlinesByOpenTime(symbolKlines, btcKlines, maxBars);
  if (aligned.length < minRequiredBars) {
    return {
      timeframe,
      status: 'INSUFFICIENT_DATA',
      alignedBarCount: aligned.length,
      minRequiredBars,
      pearsonCorrelation: null,
      directionalOverlapRate: null,
      downsideOverlapRate: null,
      upsideOverlapRate: null,
      beta: null,
      avgAbsSpreadPct: null,
      btcPeriodChangePct: null,
      symbolPeriodChangePct: null,
      ...(includeSeries ? { series: [] } : {}),
    };
  }

  const btcReturns: number[] = [];
  const symReturns: number[] = [];
  let sameDirCount = 0;
  let btcDownCount = 0;
  let btcDownSameCount = 0;
  let btcUpCount = 0;
  let btcUpSameCount = 0;
  let absSpreadSum = 0;

  const anchorBtc = aligned[0].btc.close;
  const anchorSym = aligned[0].sym.close;
  const series: BtcCorrelationOverlayPoint[] = includeSeries
    ? [
        {
          openTime: aligned[0].openTime,
          label: formatOverlayTimeLabel(aligned[0].openTime),
          btcClose: aligned[0].btc.close,
          symbolClose: aligned[0].sym.close,
          btcReturnPct: 0,
          symbolReturnPct: 0,
          btcBarReturnPct: 0,
          symbolBarReturnPct: 0,
          sameDirection: true,
        },
      ]
    : [];

  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1];
    const curr = aligned[i];
    const rBtc = (curr.btc.close - prev.btc.close) / prev.btc.close;
    const rSym = (curr.sym.close - prev.sym.close) / prev.sym.close;

    btcReturns.push(rBtc);
    symReturns.push(rSym);

    const sameDirection =
      (rBtc > 0 && rSym > 0) ||
      (rBtc < 0 && rSym < 0) ||
      (rBtc === 0 && rSym === 0);
    if (sameDirection) {
      sameDirCount++;
    }
    if (rBtc < 0) {
      btcDownCount++;
      if (rSym < 0) btcDownSameCount++;
    } else if (rBtc > 0) {
      btcUpCount++;
      if (rSym > 0) btcUpSameCount++;
    }

    absSpreadSum += Math.abs(rSym - rBtc) * 100;

    if (includeSeries) {
      series.push({
        openTime: curr.openTime,
        label: formatOverlayTimeLabel(curr.openTime),
        btcClose: curr.btc.close,
        symbolClose: curr.sym.close,
        btcReturnPct: roundTo(((curr.btc.close - anchorBtc) / anchorBtc) * 100, 3),
        symbolReturnPct: roundTo(((curr.sym.close - anchorSym) / anchorSym) * 100, 3),
        btcBarReturnPct: roundTo(rBtc * 100, 3),
        symbolBarReturnPct: roundTo(rSym * 100, 3),
        sameDirection,
      });
    }
  }

  const n = btcReturns.length;
  const meanBtc = btcReturns.reduce((acc, v) => acc + v, 0) / n;
  const meanSym = symReturns.reduce((acc, v) => acc + v, 0) / n;

  let cov = 0;
  let varBtc = 0;
  let varSym = 0;
  for (let i = 0; i < n; i++) {
    const dx = btcReturns[i] - meanBtc;
    const dy = symReturns[i] - meanSym;
    cov += dx * dy;
    varBtc += dx * dx;
    varSym += dy * dy;
  }

  const denom = Math.sqrt(varBtc * varSym);
  const pearsonCorrelation =
    denom > 1e-16 ? roundTo(Math.max(-1, Math.min(1, cov / denom)), 3) : null;
  const beta = varBtc > 1e-16 ? roundTo(cov / varBtc, 2) : null;
  const directionalOverlapRate =
    n > 0 ? roundTo((sameDirCount / n) * 100, 1) : null;
  const downsideOverlapRate =
    btcDownCount >= 3
      ? roundTo((btcDownSameCount / btcDownCount) * 100, 1)
      : null;
  const upsideOverlapRate =
    btcUpCount >= 3 ? roundTo((btcUpSameCount / btcUpCount) * 100, 1) : null;
  const avgAbsSpreadPct = n > 0 ? roundTo(absSpreadSum / n, 3) : null;

  const last = aligned[aligned.length - 1];
  const btcPeriodChangePct = roundTo(
    ((last.btc.close - anchorBtc) / anchorBtc) * 100,
    2
  );
  const symbolPeriodChangePct = roundTo(
    ((last.sym.close - anchorSym) / anchorSym) * 100,
    2
  );

  return {
    timeframe,
    status: 'READY',
    alignedBarCount: aligned.length,
    minRequiredBars,
    pearsonCorrelation,
    directionalOverlapRate,
    downsideOverlapRate,
    upsideOverlapRate,
    beta,
    avgAbsSpreadPct,
    btcPeriodChangePct,
    symbolPeriodChangePct,
    ...(includeSeries ? { series } : {}),
  };
}

function classifyCorrelationTier(params: {
  symbol: string;
  m15: BtcTimeframeCorrelationMetric | null;
  m1h: BtcTimeframeCorrelationMetric | null;
  fallbackMetric?: BtcTimeframeCorrelationMetric | null;
}): {
  tier: BtcCorrelationTier;
  tierLabelZh: string;
  riskLevel: 'HIGH' | 'MODERATE' | 'LOW' | 'BENCHMARK' | 'UNKNOWN';
  status: 'READY' | 'CACHE_PENDING' | 'INSUFFICIENT_DATA';
} {
  if (params.symbol.toUpperCase() === BTC_BENCHMARK_SYMBOL) {
    return {
      tier: 'BENCHMARK_BTC',
      tierLabelZh: 'BTC 大盤基準',
      riskLevel: 'BENCHMARK',
      status: 'READY',
    };
  }

  const r15 =
    params.m15?.status === 'READY' ? params.m15.pearsonCorrelation : null;
  const r1h =
    params.m1h?.status === 'READY' ? params.m1h.pearsonCorrelation : null;
  const ov15 =
    params.m15?.status === 'READY' ? params.m15.directionalOverlapRate : null;
  const rFallback =
    params.fallbackMetric?.status === 'READY'
      ? params.fallbackMetric.pearsonCorrelation
      : null;

  const compositeR =
    r15 !== null && r1h !== null
      ? r15 * 0.6 + r1h * 0.4
      : r15 ?? r1h ?? rFallback;

  if (compositeR === null) {
    return {
      tier: 'INSUFFICIENT_DATA',
      tierLabelZh: 'K 線樣本不足',
      riskLevel: 'UNKNOWN',
      status: 'INSUFFICIENT_DATA',
    };
  }

  if (compositeR <= -0.35) {
    return {
      tier: 'INVERSE',
      tierLabelZh: '偏逆勢反向連動',
      riskLevel: 'LOW',
      status: 'READY',
    };
  }

  if (
    compositeR >= 0.72 ||
    (r15 !== null && r15 >= 0.75) ||
    (r15 !== null && r15 >= 0.65 && ov15 !== null && ov15 >= 72)
  ) {
    return {
      tier: 'HIGH_COUPLED',
      tierLabelZh: '高度綁定 BTC 大盤',
      riskLevel: 'HIGH',
      status: 'READY',
    };
  }

  if (compositeR >= 0.42) {
    return {
      tier: 'MODERATE_COUPLED',
      tierLabelZh: '中度連動 BTC',
      riskLevel: 'MODERATE',
      status: 'READY',
    };
  }

  return {
    tier: 'LOW_INDEPENDENT',
    tierLabelZh: '走勢相對獨立',
    riskLevel: 'LOW',
    status: 'READY',
  };
}

export function computeBtcCorrelationSummary(params: {
  symbol: string;
  symbolKlines15m?: Kline[];
  symbolKlines1h?: Kline[];
  btcKlines15m?: Kline[];
  btcKlines1h?: Kline[];
  hasCachedData?: boolean;
}): BtcKlineCorrelationSummary {
  const upperSymbol = params.symbol.toUpperCase();
  if (upperSymbol === BTC_BENCHMARK_SYMBOL) {
    return {
      isBenchmark: true,
      status: 'READY',
      tier: 'BENCHMARK_BTC',
      tierLabelZh: 'BTC 大盤基準',
      primaryTimeframe: '15m',
      pearson15m: 1,
      directionalOverlap15m: 100,
      downsideOverlap15m: 100,
      beta15m: 1,
      alignedBars15m: params.btcKlines15m?.filter((k) => k.isClosed).length ?? 0,
      pearson1h: 1,
      directionalOverlap1h: 100,
      downsideOverlap1h: 100,
      beta1h: 1,
      alignedBars1h: params.btcKlines1h?.filter((k) => k.isClosed).length ?? 0,
    };
  }

  const m15 =
    params.symbolKlines15m && params.btcKlines15m
      ? computeTimeframeBtcCorrelation(
          '15m',
          params.symbolKlines15m,
          params.btcKlines15m,
          { includeSeries: false }
        )
      : null;
  const m1h =
    params.symbolKlines1h && params.btcKlines1h
      ? computeTimeframeBtcCorrelation(
          '1h',
          params.symbolKlines1h,
          params.btcKlines1h,
          { includeSeries: false }
        )
      : null;

  const classified = classifyCorrelationTier({
    symbol: upperSymbol,
    m15,
    m1h,
  });

  const finalStatus =
    classified.status === 'READY'
      ? 'READY'
      : params.hasCachedData === false
        ? 'CACHE_PENDING'
        : 'INSUFFICIENT_DATA';

  return {
    isBenchmark: false,
    status: finalStatus,
    tier: classified.tier,
    tierLabelZh:
      finalStatus === 'CACHE_PENDING' ? '快取累積中' : classified.tierLabelZh,
    primaryTimeframe: m15?.status === 'READY' ? '15m' : '1h',
    pearson15m: m15?.pearsonCorrelation ?? null,
    directionalOverlap15m: m15?.directionalOverlapRate ?? null,
    downsideOverlap15m: m15?.downsideOverlapRate ?? null,
    beta15m: m15?.beta ?? null,
    alignedBars15m: m15?.alignedBarCount ?? 0,
    pearson1h: m1h?.pearsonCorrelation ?? null,
    directionalOverlap1h: m1h?.directionalOverlapRate ?? null,
    downsideOverlap1h: m1h?.downsideOverlapRate ?? null,
    beta1h: m1h?.beta ?? null,
    alignedBars1h: m1h?.alignedBarCount ?? 0,
  };
}

export function computeBtcCorrelationAnalysis(params: {
  symbol: string;
  primaryTimeframe: Timeframe;
  symbolKlinesByTimeframe: Partial<Record<Timeframe, Kline[]>>;
  btcKlinesByTimeframe: Partial<Record<Timeframe, Kline[]>>;
  evaluatedAt?: string;
}): BtcKlineCorrelationAnalysis {
  const upperSymbol = params.symbol.toUpperCase();
  const evaluatedAt = params.evaluatedAt ?? new Date().toISOString();

  if (upperSymbol === BTC_BENCHMARK_SYMBOL) {
    const btc15 = params.btcKlinesByTimeframe['15m'] ?? [];
    const btc1h = params.btcKlinesByTimeframe['1h'] ?? [];
    const selfMetric = (tf: Timeframe): BtcTimeframeCorrelationMetric => {
      const kl = (params.btcKlinesByTimeframe[tf] ?? [])
        .filter((k) => k.isClosed)
        .slice(-BTC_CORRELATION_MAX_BARS);
      const anchor = kl[0]?.close ?? 1;
      const last = kl[kl.length - 1]?.close ?? anchor;
      const changePct = kl.length >= 2 ? roundTo(((last - anchor) / anchor) * 100, 2) : null;
      return {
        timeframe: tf,
        status: kl.length >= BTC_CORRELATION_MIN_ALIGNED_BARS ? 'READY' : 'INSUFFICIENT_DATA',
        alignedBarCount: kl.length,
        minRequiredBars: BTC_CORRELATION_MIN_ALIGNED_BARS,
        pearsonCorrelation: 1,
        directionalOverlapRate: 100,
        downsideOverlapRate: 100,
        upsideOverlapRate: 100,
        beta: 1,
        avgAbsSpreadPct: 0,
        btcPeriodChangePct: changePct,
        symbolPeriodChangePct: changePct,
        series: kl.map((k, idx) => {
          const prev = idx > 0 ? kl[idx - 1] : k;
          const barRet = prev.close > 0 ? ((k.close - prev.close) / prev.close) * 100 : 0;
          const cumRet = anchor > 0 ? ((k.close - anchor) / anchor) * 100 : 0;
          return {
            openTime: k.openTime,
            label: formatOverlayTimeLabel(k.openTime),
            btcClose: k.close,
            symbolClose: k.close,
            btcReturnPct: roundTo(cumRet, 3),
            symbolReturnPct: roundTo(cumRet, 3),
            btcBarReturnPct: roundTo(barRet, 3),
            symbolBarReturnPct: roundTo(barRet, 3),
            sameDirection: true,
          };
        }),
      };
    };

    const byTimeframe: Partial<Record<Timeframe, BtcTimeframeCorrelationMetric>> = {
      '5m': selfMetric('5m'),
      '15m': selfMetric('15m'),
      '1h': selfMetric('1h'),
      '4h': selfMetric('4h'),
    };

    return {
      isBenchmark: true,
      status: 'READY',
      tier: 'BENCHMARK_BTC',
      tierLabelZh: 'BTC 大盤基準',
      riskLevel: 'BENCHMARK',
      primaryTimeframe: params.primaryTimeframe,
      evaluatedAt,
      pearson15m: 1,
      directionalOverlap15m: 100,
      downsideOverlap15m: 100,
      beta15m: 1,
      alignedBars15m: btc15.filter((k) => k.isClosed).length,
      pearson1h: 1,
      directionalOverlap1h: 100,
      downsideOverlap1h: 100,
      beta1h: 1,
      alignedBars1h: btc1h.filter((k) => k.isClosed).length,
      summaryZh: 'BTCUSDT 為全市場基準標的，所有山寨幣之 K 線重合性皆以 BTCUSDT 已確認收盤 K 線為對照基準。',
      tradingHintZh: '檢視山寨幣單幣種詳情時，可觀察過去 15m / 1h 與比特幣的同步率與 Beta 放大倍數，避免在 BTC 劇烈洗盤時誤判山寨幣獨立突破。',
      byTimeframe,
    };
  }

  const timeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
  const byTimeframe: Partial<Record<Timeframe, BtcTimeframeCorrelationMetric>> = {};

  for (const tf of timeframes) {
    const symK = params.symbolKlinesByTimeframe[tf] ?? [];
    const btcK = params.btcKlinesByTimeframe[tf] ?? [];
    if (symK.length > 0 && btcK.length > 0) {
      byTimeframe[tf] = computeTimeframeBtcCorrelation(tf, symK, btcK, {
        includeSeries: true,
      });
    } else {
      byTimeframe[tf] = {
        timeframe: tf,
        status: 'INSUFFICIENT_DATA',
        alignedBarCount: 0,
        minRequiredBars: BTC_CORRELATION_MIN_ALIGNED_BARS,
        pearsonCorrelation: null,
        directionalOverlapRate: null,
        downsideOverlapRate: null,
        upsideOverlapRate: null,
        beta: null,
        avgAbsSpreadPct: null,
        btcPeriodChangePct: null,
        symbolPeriodChangePct: null,
        series: [],
      };
    }
  }

  const m15 = byTimeframe['15m'] ?? null;
  const m1h = byTimeframe['1h'] ?? null;
  const mPrimary = byTimeframe[params.primaryTimeframe] ?? m15 ?? m1h;
  const classified = classifyCorrelationTier({
    symbol: upperSymbol,
    m15,
    m1h,
    fallbackMetric: mPrimary,
  });

  const activeMetric =
    m15?.status === 'READY'
      ? m15
      : m1h?.status === 'READY'
        ? m1h
        : mPrimary;

  let summaryZh = '目前對齊的已確認 K 線樣本不足 15 根，尚無法評估與 BTCUSDT 的穩定重合性。';
  let tradingHintZh = '待累積足夠 15m / 1h 已收盤對齊 K 線後，系統將自動顯示相關係數、同向重疊率與 Beta 彈性提醒。';

  if (classified.status === 'READY' && activeMetric) {
    const rText =
      activeMetric.pearsonCorrelation !== null
        ? `r = ${activeMetric.pearsonCorrelation.toFixed(2)}`
        : 'r = N/A';
    const overlapText =
      activeMetric.directionalOverlapRate !== null
        ? `${activeMetric.directionalOverlapRate.toFixed(1)}%`
        : 'N/A';
    const downText =
      activeMetric.downsideOverlapRate !== null
        ? `${activeMetric.downsideOverlapRate.toFixed(1)}%`
        : 'N/A';
    const betaText =
      activeMetric.beta !== null ? `${activeMetric.beta.toFixed(2)}x` : 'N/A';

    if (classified.tier === 'HIGH_COUPLED') {
      summaryZh = `${upperSymbol} 過去 ${activeMetric.timeframe} (${activeMetric.alignedBarCount} 根) 與 BTC 高度同步（${rText} · 方向重疊 ${overlapText} · 下跌同步 ${downText} · Beta ${betaText}）。`;
      tradingHintZh =
        '開單前風險提醒：此幣種極易被比特幣大盤帶動，尤其是 BTC 急跌或掃流動性時容易同步回撤。建議進場前先確認 BTC 15m/1h 關鍵支撐壓力，盡量避免逆 BTC 主流方向開單。';
    } else if (classified.tier === 'MODERATE_COUPLED') {
      summaryZh = `${upperSymbol} 過去 ${activeMetric.timeframe} (${activeMetric.alignedBarCount} 根) 與 BTC 呈中度連動（${rText} · 方向重疊 ${overlapText} · Beta ${betaText}）。`;
      tradingHintZh =
        '開單前風險提醒：此幣種會受 BTC 大盤方向牽引，但仍保留部分個幣結構動能。若 BTC 處於盤整區間可依本幣 SMC 結構觀察；若 BTC 波動放大需留意 Beta 連動放大效應。';
    } else if (classified.tier === 'INVERSE') {
      summaryZh = `${upperSymbol} 過去 ${activeMetric.timeframe} (${activeMetric.alignedBarCount} 根) 與 BTC 呈現偏逆勢走勢（${rText} · 方向重疊 ${overlapText}）。`;
      tradingHintZh =
        '開單前風險提醒：近期與比特幣呈負相關（反向連動），可能受特定題材或資金輪動驅動；需防範 BTC 快速反轉時引發反向補跌或急軋。';
    } else {
      summaryZh = `${upperSymbol} 過去 ${activeMetric.timeframe} (${activeMetric.alignedBarCount} 根) 相對獨立於 BTC（${rText} · 方向重疊 ${overlapText} · Beta ${betaText}）。`;
      tradingHintZh =
        '開單前風險提醒：此幣種近期走勢相對獨立，受 BTC 短線洗盤幹擾較低，本幣自身的 SMC/ICT 結構與量能表現更具參考價值；但若 BTC 發生極端單邊行情仍需防範系統性流動性抽離。';
    }
  }

  return {
    isBenchmark: false,
    status: classified.status,
    tier: classified.tier,
    tierLabelZh: classified.tierLabelZh,
    riskLevel: classified.riskLevel,
    primaryTimeframe: params.primaryTimeframe,
    evaluatedAt,
    pearson15m: m15?.pearsonCorrelation ?? null,
    directionalOverlap15m: m15?.directionalOverlapRate ?? null,
    downsideOverlap15m: m15?.downsideOverlapRate ?? null,
    beta15m: m15?.beta ?? null,
    alignedBars15m: m15?.alignedBarCount ?? 0,
    pearson1h: m1h?.pearsonCorrelation ?? null,
    directionalOverlap1h: m1h?.directionalOverlapRate ?? null,
    downsideOverlap1h: m1h?.downsideOverlapRate ?? null,
    beta1h: m1h?.beta ?? null,
    alignedBars1h: m1h?.alignedBarCount ?? 0,
    summaryZh,
    tradingHintZh,
    byTimeframe,
  };
}

function inferBtcSeriesTrend(klines?: Kline[]): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (!klines || klines.length === 0) return 'NEUTRAL';
  const confirmed = klines
    .filter((k) => k && k.isClosed && Number.isFinite(k.close) && k.close > 0)
    .sort((a, b) => a.openTime - b.openTime);
  if (confirmed.length < 12) return 'NEUTRAL';
  const recent = confirmed.slice(-20);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  const sma = recent.reduce((acc, k) => acc + k.close, 0) / recent.length;
  const pctMove = ((lastClose - firstClose) / Math.max(1e-9, firstClose)) * 100;
  if (lastClose > sma * 1.002 && pctMove >= 0.35) return 'BULL';
  if (lastClose < sma * 0.998 && pctMove <= -0.35) return 'BEAR';
  return 'NEUTRAL';
}

export function evaluateBtcMarketRegime(params: {
  btcChange24h: number | null;
  btcKlines15m?: Kline[];
  btcKlines1h?: Kline[];
}): BtcMarketRegime {
  const btcChange24h =
    params.btcChange24h !== null && Number.isFinite(params.btcChange24h)
      ? Number(params.btcChange24h.toFixed(2))
      : null;
  const btcTrend15m = inferBtcSeriesTrend(params.btcKlines15m);
  const btcTrend1h = inferBtcSeriesTrend(params.btcKlines1h);

  let btcAtrPercent15m: number | null = null;
  let hasBarVolatilitySpike = false;

  const confirmed15m = (params.btcKlines15m ?? [])
    .filter((k) => k && k.isClosed && Number.isFinite(k.close) && k.close > 0)
    .sort((a, b) => a.openTime - b.openTime);

  if (confirmed15m.length >= 15) {
    const trList: number[] = [];
    for (let i = Math.max(1, confirmed15m.length - 15); i < confirmed15m.length; i++) {
      const cur = confirmed15m[i];
      const prev = confirmed15m[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trList.push(tr);
    }
    const atr14 =
      trList.slice(0, -1).reduce((a, b) => a + b, 0) /
      Math.max(1, trList.length - 1);
    const lastBar = confirmed15m[confirmed15m.length - 1];
    const lastRange = Math.max(0, lastBar.high - lastBar.low);
    if (atr14 > 0 && lastBar.close > 0) {
      btcAtrPercent15m = Number(((atr14 / lastBar.close) * 100).toFixed(3));
      if (lastRange >= atr14 * 2.8 && (lastRange / lastBar.close) * 100 >= 1.2) {
        hasBarVolatilitySpike = true;
      }
    }
  }

  let state: BtcRegimeState = 'CHOP_RANGE';
  let blocksLongAlts = false;
  let blocksShortAlts = false;
  let warningZh =
    'BTC 區間震盪中：建議優先採 FVG/OB 回踩限價掛單，避免現價追高殺低。';

  if (
    hasBarVolatilitySpike ||
    (btcChange24h !== null && Math.abs(btcChange24h) >= 6.5)
  ) {
    state = 'VOLATILITY_SPIKE';
    blocksLongAlts = true;
    blocksShortAlts = true;
    warningZh =
      'BTC 大盤出現極端插針／劇烈單邊波動：濾網已暫時攔截山寨幣雙向自動追單，以防同步掃損。';
  } else if (
    (btcChange24h !== null && btcChange24h <= -2.5) ||
    (btcTrend1h === 'BEAR' &&
      btcTrend15m === 'BEAR' &&
      (btcChange24h === null || btcChange24h <= -1.2))
  ) {
    state = 'BEAR_TREND';
    blocksLongAlts = true;
    blocksShortAlts = false;
    warningZh =
      'BTC 大盤處於明確空頭壓制：濾網已攔截逆勢山寨幣多單（保留順勢空頭與 BTC 本身結構）。';
  } else if (
    (btcChange24h !== null && btcChange24h >= 2.5) ||
    (btcTrend1h === 'BULL' &&
      btcTrend15m === 'BULL' &&
      (btcChange24h === null || btcChange24h >= 1.2))
  ) {
    state = 'BULL_TREND';
    blocksLongAlts = false;
    blocksShortAlts = true;
    warningZh =
      'BTC 大盤處於強勢多頭推升：濾網已攔截逆勢山寨幣空單（嚴防軋空掃損）。';
  } else if (
    btcChange24h === null &&
    btcTrend15m === 'NEUTRAL' &&
    btcTrend1h === 'NEUTRAL'
  ) {
    state = 'UNKNOWN';
    warningZh = 'BTC 大盤 K 線與基準漲跌幅尚待同步。';
  }

  return {
    state,
    change24hPct: btcChange24h,
    btcTrend15m,
    btcTrend1h,
    btcAtrPercent15m,
    blocksLongAlts,
    blocksShortAlts,
    warningZh,
  };
}
