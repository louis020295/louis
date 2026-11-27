import {
  KeyLevelAnchor,
  KeyLevelsAndSessionAnalysis,
  Kline,
  Timeframe,
  TradingSessionKey,
} from '../../src/types/market.ts';

function roundTo(val: number, decimals = 6): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function classifyUtcTradingSession(utcHour: number): {
  activeSession: TradingSessionKey;
  sessionLabelZh: string;
  volatilityNoteZh: string;
} {
  if (utcHour >= 0 && utcHour < 7) {
    return {
      activeSession: 'ASIA',
      sessionLabelZh: '亞洲盤時段 (UTC 00–07)',
      volatilityNoteZh:
        '波動通常相對溫和，易形成亞洲高低點區間，常成為歐美盤流動性掃蕩目標。',
    };
  }
  if (utcHour >= 7 && utcHour < 10) {
    return {
      activeSession: 'LONDON_KILLZONE',
      sessionLabelZh: '倫敦開盤 Killzone (UTC 07–10)',
      volatilityNoteZh:
        '歐洲資金進場窗口，常見先掃亞洲高/低點假突破後再走出當日主方向。',
    };
  }
  if (utcHour >= 12 && utcHour < 14) {
    return {
      activeSession: 'NY_AM_KILLZONE',
      sessionLabelZh: '紐約早盤 Killzone (UTC 12–14)',
      volatilityNoteZh:
        '歐美盤交接與美盤宏觀數據高峰，插針與反轉機率顯著升高。',
    };
  }
  if (utcHour >= 14 && utcHour < 16) {
    return {
      activeSession: 'US_EQUITY_OPEN',
      sessionLabelZh: '美股開盤波動窗口 (UTC 14–16)',
      volatilityNoteZh:
        '美股現貨開盤與加密連動高峰，山寨幣與 BTC 容易出現雙向掃損插針。',
    };
  }
  if (utcHour >= 16 && utcHour < 21) {
    return {
      activeSession: 'NY_PM',
      sessionLabelZh: '紐約午後時段 (UTC 16–21)',
      volatilityNoteZh:
        '美盤延續與尾盤再平衡階段，趨勢延續性或獲利了結反應較明確。',
    };
  }
  return {
    activeSession: 'OFF_HOURS',
    sessionLabelZh: '盤間過渡時段',
    volatilityNoteZh:
      '非主要機構開盤窗口，盤面量能常較分散，追高突破須嚴防假訊號。',
  };
}

export function computeKeyLevelsAndSession(params: {
  symbol: string;
  primaryTimeframe: Timeframe;
  lastPrice: number;
  primaryKlines: Kline[];
  klines1h: Kline[];
  klines4h: Kline[];
  nextFundingTime?: number | null;
  nowMs?: number;
  evaluatedAt: string;
}): KeyLevelsAndSessionAnalysis {
  const {
    symbol,
    primaryTimeframe,
    lastPrice,
    primaryKlines,
    klines1h,
    klines4h,
    nextFundingTime = null,
    nowMs = Date.now(),
    evaluatedAt,
  } = params;

  const nowDate = new Date(nowMs);
  const utcHour = nowDate.getUTCHours();
  const todayStartUtc = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate()
  );
  const yesterdayStartUtc = todayStartUtc - 86_400_000;
  const utcDay = nowDate.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (utcDay + 6) % 7;
  const weekStartUtc = todayStartUtc - daysSinceMonday * 86_400_000;

  // Prefer 1h bars for PDH/PDL and Daily Open; fallback to 4h then primaryKlines
  const dailySourceBars =
    klines1h.length >= 24
      ? klines1h
      : klines4h.length >= 8
        ? klines4h
        : primaryKlines;

  const prevDayBars = dailySourceBars.filter(
    (k) => k.openTime >= yesterdayStartUtc && k.openTime < todayStartUtc
  );

  let pdh: number | null = null;
  let pdl: number | null = null;
  if (prevDayBars.length >= 2) {
    pdh = roundTo(Math.max(...prevDayBars.map((k) => k.high)), 6);
    pdl = roundTo(Math.min(...prevDayBars.map((k) => k.low)), 6);
  }

  // Daily Open: first bar at or after today 00:00 UTC
  const todayBarsForOpen = [...dailySourceBars]
    .filter((k) => k.openTime >= todayStartUtc)
    .sort((a, b) => a.openTime - b.openTime);
  const dailyOpen =
    todayBarsForOpen.length > 0 ? roundTo(todayBarsForOpen[0].open, 6) : null;

  // Weekly Open: first bar at or right after Monday 00:00 UTC (search 4h then 1h)
  const weeklyCandidateBars = [...(klines4h.length > 0 ? klines4h : klines1h)]
    .filter(
      (k) =>
        k.openTime >= weekStartUtc && k.openTime <= weekStartUtc + 4 * 3600_000
    )
    .sort((a, b) => a.openTime - b.openTime);
  const weeklyOpen =
    weeklyCandidateBars.length > 0
      ? roundTo(weeklyCandidateBars[0].open, 6)
      : null;

  // Intraday Anchored VWAP ±1σ (anchor at today 00:00 UTC; if < 2 bars exist, rolling 24h fallback)
  const vwapSource =
    primaryTimeframe === '4h' && klines1h.length >= 6
      ? klines1h
      : primaryKlines.length >= 6
        ? primaryKlines
        : klines1h;

  let vwapBars = vwapSource.filter((k) => k.openTime >= todayStartUtc);
  if (vwapBars.length < 2) {
    vwapBars = vwapSource.filter((k) => k.openTime >= nowMs - 86_400_000);
  }

  let vwap: number | null = null;
  let vwapUpper1: number | null = null;
  let vwapLower1: number | null = null;
  let priceVsVwapPct: number | null = null;
  let vwapPositionLabelZh = 'VWAP 資料不足';

  if (vwapBars.length >= 2) {
    let sumTpWeight = 0;
    let sumWeight = 0;
    const weightedPoints: Array<{ tp: number; weight: number }> = [];

    for (const k of vwapBars) {
      const tp = (k.high + k.low + k.close) / 3;
      const weight =
        Number.isFinite(k.quoteVolume) && k.quoteVolume > 0
          ? k.quoteVolume
          : Number.isFinite(k.volume) && k.volume > 0
            ? k.volume * tp
            : 0;
      if (weight > 0 && Number.isFinite(tp) && tp > 0) {
        sumTpWeight += tp * weight;
        sumWeight += weight;
        weightedPoints.push({ tp, weight });
      }
    }

    if (sumWeight > 0 && weightedPoints.length >= 2) {
      const rawVwap = sumTpWeight / sumWeight;
      const variance =
        weightedPoints.reduce(
          (acc, p) => acc + p.weight * Math.pow(p.tp - rawVwap, 2),
          0
        ) / sumWeight;
      const stdDev = Math.sqrt(Math.max(0, variance));

      vwap = roundTo(rawVwap, 6);
      vwapUpper1 = roundTo(rawVwap + stdDev, 6);
      vwapLower1 = roundTo(Math.max(0, rawVwap - stdDev), 6);

      if (lastPrice > 0) {
        priceVsVwapPct = roundTo(((lastPrice - rawVwap) / rawVwap) * 100, 3);
        if (lastPrice > rawVwap + stdDev) {
          vwapPositionLabelZh = '高於 VWAP +1σ（短線偏超買溢價）';
        } else if (lastPrice < rawVwap - stdDev) {
          vwapPositionLabelZh = '低於 VWAP -1σ（短線偏超賣折價）';
        } else if (priceVsVwapPct >= 0.15) {
          vwapPositionLabelZh = '站穩日內 VWAP 上方（買方均價優勢）';
        } else if (priceVsVwapPct <= -0.15) {
          vwapPositionLabelZh = '位於日內 VWAP 下方（賣方均價壓制）';
        } else {
          vwapPositionLabelZh = '緊貼日內 VWAP 成本中軸';
        }
      }
    }
  }

  // Build ordered key level anchors
  const anchors: KeyLevelAnchor[] = [];
  const pushAnchor = (
    key: KeyLevelAnchor['key'],
    labelZh: string,
    shortLabel: string,
    price: number | null
  ) => {
    if (price !== null && Number.isFinite(price) && price > 0 && lastPrice > 0) {
      anchors.push({
        key,
        labelZh,
        shortLabel,
        price,
        distancePct: roundTo(((price - lastPrice) / lastPrice) * 100, 3),
      });
    }
  };

  pushAnchor('PDH', '前日高點 (PDH)', 'PDH', pdh);
  pushAnchor('PDL', '前日低點 (PDL)', 'PDL', pdl);
  pushAnchor('DAILY_OPEN', '日線開盤價 (DO)', 'DO', dailyOpen);
  pushAnchor('WEEKLY_OPEN', '週線開盤價 (WO)', 'WO', weeklyOpen);
  pushAnchor('VWAP', '日內錨定 VWAP', 'VWAP', vwap);

  const structuralAnchors = anchors.filter((a) => a.key !== 'VWAP');
  const sortedByProximity = [...structuralAnchors].sort(
    (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)
  );
  const nearestKeyLevel = sortedByProximity[0] ?? anchors[0] ?? null;

  let proximityWarningZh: string | null = null;
  if (
    nearestKeyLevel &&
    nearestKeyLevel.key !== 'VWAP' &&
    Math.abs(nearestKeyLevel.distancePct) <= 0.65
  ) {
    const dirLabel = nearestKeyLevel.distancePct >= 0 ? '上方' : '下方';
    const sign = nearestKeyLevel.distancePct >= 0 ? '+' : '';
    proximityWarningZh = `現價距離${dirLabel} ${nearestKeyLevel.labelZh} 僅 ${sign}${nearestKeyLevel.distancePct.toFixed(2)}%，開單前留意關鍵位反壓或掃流動性插針。`;
  }

  const sessionMeta = classifyUtcTradingSession(utcHour);
  const validNextFunding =
    typeof nextFundingTime === 'number' &&
    Number.isFinite(nextFundingTime) &&
    nextFundingTime > nowMs
      ? nextFundingTime
      : null;
  const fundingCountdownMs =
    validNextFunding !== null ? Math.max(0, validNextFunding - nowMs) : null;
  const fundingWarningSoon =
    fundingCountdownMs !== null && fundingCountdownMs <= 15 * 60 * 1000;

  return {
    symbol,
    primaryTimeframe,
    evaluatedAt,
    lastPrice,
    pdh,
    pdl,
    dailyOpen,
    weeklyOpen,
    vwap,
    vwapUpper1,
    vwapLower1,
    priceVsVwapPct,
    vwapPositionLabelZh,
    anchors,
    nearestKeyLevel,
    proximityWarningZh,
    session: {
      utcHour,
      activeSession: sessionMeta.activeSession,
      sessionLabelZh: sessionMeta.sessionLabelZh,
      volatilityNoteZh: sessionMeta.volatilityNoteZh,
      nextFundingTime: validNextFunding,
      fundingCountdownMs,
      fundingWarningSoon,
    },
  };
}
