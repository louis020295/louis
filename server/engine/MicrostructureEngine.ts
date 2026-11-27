import {
  MarketMicrostructureAnalysis,
  OrderBookLevel,
  OrderBookSnapshot,
  OrderBookWall,
  SlippageTierEstimate,
  SpotPerpBasisRegime,
  SpotTickerSnapshot,
} from '../../src/types/market.ts';

function roundTo(val: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function simulateOrderBookSlippage(
  levels: OrderBookLevel[],
  notionalUsd: number,
  midPrice: number
): {
  slippageBps: number | null;
  avgFillPrice: number | null;
  depthCovered: boolean;
} {
  if (
    !Number.isFinite(notionalUsd) ||
    notionalUsd <= 0 ||
    !Number.isFinite(midPrice) ||
    midPrice <= 0 ||
    levels.length === 0
  ) {
    return { slippageBps: null, avgFillPrice: null, depthCovered: false };
  }

  let remainingUsd = notionalUsd;
  let totalQty = 0;
  let totalSpentUsd = 0;

  for (const level of levels) {
    if (remainingUsd <= 1e-6) break;
    if (
      !Number.isFinite(level.price) ||
      level.price <= 0 ||
      !Number.isFinite(level.quantity) ||
      level.quantity <= 0
    ) {
      continue;
    }
    const levelNotional = level.price * level.quantity;
    if (levelNotional >= remainingUsd) {
      const qtyToTake = remainingUsd / level.price;
      totalQty += qtyToTake;
      totalSpentUsd += remainingUsd;
      remainingUsd = 0;
      break;
    } else {
      totalQty += level.quantity;
      totalSpentUsd += levelNotional;
      remainingUsd -= levelNotional;
    }
  }

  if (totalQty <= 0 || totalSpentUsd <= 0) {
    return { slippageBps: null, avgFillPrice: null, depthCovered: false };
  }

  const avgFillPrice = totalSpentUsd / totalQty;
  const slippageBps = Math.abs((avgFillPrice - midPrice) / midPrice) * 10_000;
  const depthCovered = remainingUsd <= 1e-4;

  return {
    slippageBps: roundTo(slippageBps, 2),
    avgFillPrice: roundTo(avgFillPrice, 6),
    depthCovered,
  };
}

export function computeMarketMicrostructure(params: {
  symbol: string;
  perpPrice: number;
  perpQuoteVolume24h: number;
  spotTicker: SpotTickerSnapshot | null;
  orderbook: OrderBookSnapshot | null;
  evaluatedAt: string;
}): MarketMicrostructureAnalysis {
  const {
    symbol,
    perpPrice,
    perpQuoteVolume24h,
    spotTicker,
    orderbook,
    evaluatedAt,
  } = params;

  // --------------------------------------------------------------------------
  // 1. Spot vs Perpetual Basis & Volume Ratio
  // --------------------------------------------------------------------------
  const hasValidSpot =
    spotTicker !== null &&
    spotTicker.spotPrice !== null &&
    Number.isFinite(spotTicker.spotPrice) &&
    spotTicker.spotPrice > 0 &&
    Number.isFinite(perpPrice) &&
    perpPrice > 0;

  let spotPerpBasis: MarketMicrostructureAnalysis['spotPerpBasis'];

  if (hasValidSpot && spotTicker && spotTicker.spotPrice !== null) {
    const spotPrice = spotTicker.spotPrice;
    const basisPct = ((perpPrice - spotPrice) / spotPrice) * 100;
    const basisBps = basisPct * 100;
    const spotQuoteVolume24h =
      spotTicker.spotQuoteVolume24h !== null &&
      Number.isFinite(spotTicker.spotQuoteVolume24h) &&
      spotTicker.spotQuoteVolume24h > 0
        ? spotTicker.spotQuoteVolume24h
        : null;
    const perpToSpotVolumeRatio =
      spotQuoteVolume24h !== null && perpQuoteVolume24h > 0
        ? perpQuoteVolume24h / spotQuoteVolume24h
        : null;

    let regime: SpotPerpBasisRegime = 'BALANCED';
    let regimeLabelZh = '期現結構均衡';
    let interpretationZh =
      '合約與現貨基差接近平水，期現量能比例正常，無明顯槓桿失衡。';

    if (
      basisPct >= 0.12 ||
      (basisPct >= 0.08 &&
        perpToSpotVolumeRatio !== null &&
        perpToSpotVolumeRatio >= 6)
    ) {
      regime = 'PERP_OVERHEATED_PREMIUM';
      regimeLabelZh = '合約溢價過熱';
      interpretationZh =
        perpToSpotVolumeRatio !== null && perpToSpotVolumeRatio >= 5
          ? `合約較現貨溢價 +${basisPct.toFixed(3)}% 且合約量能為現貨 ${perpToSpotVolumeRatio.toFixed(1)}x，屬純槓桿追多驅動，慎防插針殺多。`
          : `合約較現貨正溢價 +${basisPct.toFixed(3)}%，多方槓桿情緒偏熱，追高勝率通常偏低。`;
    } else if (basisPct <= -0.1) {
      regime = 'PERP_DISCOUNT_FEAR';
      regimeLabelZh = '合約貼水/恐慌折價';
      interpretationZh = `合約較現貨折價 ${basisPct.toFixed(3)}%，空單避險或恐慌情緒較重；若現貨守穩則容易觸發軋空反彈。`;
    } else if (
      perpToSpotVolumeRatio !== null &&
      perpToSpotVolumeRatio <= 2.2 &&
      Math.abs(basisPct) <= 0.08
    ) {
      regime = 'SPOT_LED_HEALTHY';
      regimeLabelZh = '現貨主導健康';
      interpretationZh = `合約/現貨量比僅 ${perpToSpotVolumeRatio.toFixed(2)}x 且基差溫和 (${basisPct >= 0 ? '+' : ''}${basisPct.toFixed(3)}%)，真實現貨買賣盤參與度高，趨勢可信度較佳。`;
    } else if (
      perpToSpotVolumeRatio !== null &&
      perpToSpotVolumeRatio >= 6.5
    ) {
      interpretationZh = `基差暫時平穩 (${basisPct >= 0 ? '+' : ''}${basisPct.toFixed(3)}%)，但合約成交量達現貨 ${perpToSpotVolumeRatio.toFixed(1)}x，短線仍以衍生品資金主導。`;
    }

    spotPerpBasis = {
      status: 'READY',
      spotSymbol: spotTicker.spotSymbol,
      spotPrice: roundTo(spotPrice, 6),
      perpPrice: roundTo(perpPrice, 6),
      basisPct: roundTo(basisPct, 4),
      basisBps: roundTo(basisBps, 2),
      spotQuoteVolume24h:
        spotQuoteVolume24h !== null ? roundTo(spotQuoteVolume24h, 2) : null,
      perpQuoteVolume24h: roundTo(perpQuoteVolume24h, 2),
      perpToSpotVolumeRatio:
        perpToSpotVolumeRatio !== null
          ? roundTo(perpToSpotVolumeRatio, 2)
          : null,
      regime,
      regimeLabelZh,
      interpretationZh,
    };
  } else {
    spotPerpBasis = {
      status: 'UNAVAILABLE',
      spotSymbol: spotTicker?.spotSymbol ?? null,
      spotPrice: null,
      perpPrice: roundTo(perpPrice, 6),
      basisPct: null,
      basisBps: null,
      spotQuoteVolume24h: null,
      perpQuoteVolume24h: roundTo(perpQuoteVolume24h, 2),
      perpToSpotVolumeRatio: null,
      regime: 'UNAVAILABLE',
      regimeLabelZh: '無對應現貨/資料缺失',
      interpretationZh:
        '目前交易所查無對應現貨交易對或現貨行情暫不可用，無法計算期現基差與現貨量比。',
    };
  }

  // --------------------------------------------------------------------------
  // 2. Orderbook Depth, OBI, Whale Bid/Ask Walls & Slippage Simulator
  // --------------------------------------------------------------------------
  const cleanBids = (orderbook?.bids ?? [])
    .filter(
      (lvl) =>
        Number.isFinite(lvl.price) &&
        lvl.price > 0 &&
        Number.isFinite(lvl.quantity) &&
        lvl.quantity > 0
    )
    .sort((a, b) => b.price - a.price);

  const cleanAsks = (orderbook?.asks ?? [])
    .filter(
      (lvl) =>
        Number.isFinite(lvl.price) &&
        lvl.price > 0 &&
        Number.isFinite(lvl.quantity) &&
        lvl.quantity > 0
    )
    .sort((a, b) => a.price - b.price);

  let orderbookResult: MarketMicrostructureAnalysis['orderbook'];

  if (cleanBids.length > 0 && cleanAsks.length > 0) {
    const bestBid = cleanBids[0].price;
    const bestAsk = cleanAsks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps =
      midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10_000 : null;

    const sumWithinPct = (levels: OrderBookLevel[], pct: number) =>
      levels.reduce((acc, lvl) => {
        const dist = Math.abs(lvl.price - midPrice) / midPrice;
        return dist <= pct ? acc + lvl.price * lvl.quantity : acc;
      }, 0);

    const bidDepth50 = sumWithinPct(cleanBids, 0.005);
    const askDepth50 = sumWithinPct(cleanAsks, 0.005);
    const obi50 =
      bidDepth50 + askDepth50 > 0
        ? ((bidDepth50 - askDepth50) / (bidDepth50 + askDepth50)) * 100
        : 0;

    const bidDepth100 = sumWithinPct(cleanBids, 0.01);
    const askDepth100 = sumWithinPct(cleanAsks, 0.01);
    const obi100 =
      bidDepth100 + askDepth100 > 0
        ? ((bidDepth100 - askDepth100) / (bidDepth100 + askDepth100)) * 100
        : 0;

    const primaryObi =
      bidDepth50 + askDepth50 > 0 ? obi50 : obi100;

    let imbalanceLabelZh = '多空盤口均衡';
    if (primaryObi >= 25) imbalanceLabelZh = '買盤深度明顯佔優';
    else if (primaryObi >= 10) imbalanceLabelZh = '買盤略佔優勢';
    else if (primaryObi <= -25) imbalanceLabelZh = '賣壓掛單明顯佔優';
    else if (primaryObi <= -10) imbalanceLabelZh = '賣盤略佔優勢';

    // Whale walls detection (>= 2.5x median level notional within ±2% of mid)
    const sampleNotionals = [
      ...cleanBids.slice(0, 25),
      ...cleanAsks.slice(0, 25),
    ].map((l) => l.price * l.quantity);
    const medNotional = Math.max(median(sampleNotionals), 1);
    const wallMinNotional = Math.max(medNotional * 2.5, 10_000);

    const extractWalls = (
      levels: OrderBookLevel[],
      side: 'BID' | 'ASK'
    ): OrderBookWall[] =>
      levels
        .map((lvl) => {
          const notionalUsd = lvl.price * lvl.quantity;
          const distancePct = ((lvl.price - midPrice) / midPrice) * 100;
          return {
            side,
            price: roundTo(lvl.price, 6),
            quantity: roundTo(lvl.quantity, 4),
            notionalUsd: roundTo(notionalUsd, 2),
            distancePct: roundTo(distancePct, 3),
            multipleOfMedian: roundTo(notionalUsd / medNotional, 2),
          };
        })
        .filter(
          (w) =>
            Math.abs(w.distancePct) <= 2.5 &&
            w.notionalUsd >= wallMinNotional
        )
        .sort((a, b) => b.notionalUsd - a.notionalUsd)
        .slice(0, 3);

    const bidWalls = extractWalls(cleanBids, 'BID');
    const askWalls = extractWalls(cleanAsks, 'ASK');

    const tierNotionals = [10_000, 50_000, 100_000];
    const slippageTiers: SlippageTierEstimate[] = tierNotionals.map(
      (notionalUsd) => {
        const buySim = simulateOrderBookSlippage(
          cleanAsks,
          notionalUsd,
          midPrice
        );
        const sellSim = simulateOrderBookSlippage(
          cleanBids,
          notionalUsd,
          midPrice
        );
        return {
          notionalUsd,
          buySlippageBps: buySim.slippageBps,
          sellSlippageBps: sellSim.slippageBps,
          buyAvgFillPrice: buySim.avgFillPrice,
          sellAvgFillPrice: sellSim.avgFillPrice,
          buyDepthCovered: buySim.depthCovered,
          sellDepthCovered: sellSim.depthCovered,
        };
      }
    );

    const tier50k = slippageTiers[1];
    const slip50kMax = Math.max(
      tier50k.buySlippageBps ?? 0,
      tier50k.sellSlippageBps ?? 0
    );
    const interpretationParts: string[] = [];
    interpretationParts.push(
      `±0.5% 盤口失衡 (OBI) 為 ${obi50 >= 0 ? '+' : ''}${obi50.toFixed(1)}%（${imbalanceLabelZh}）`
    );
    if (bidWalls.length > 0) {
      interpretationParts.push(
        `下方最強買牆位於 ${bidWalls[0].price}（約 $${Math.round(bidWalls[0].notionalUsd).toLocaleString()}）`
      );
    }
    if (askWalls.length > 0) {
      interpretationParts.push(
        `上方最強賣牆位於 ${askWalls[0].price}（約 $${Math.round(askWalls[0].notionalUsd).toLocaleString()}）`
      );
    }
    if (tier50k.buySlippageBps !== null && slip50kMax >= 15) {
      interpretationParts.push(
        `$50k 市價單預估滑點達 ${slip50kMax.toFixed(1)} bps，建議改用限價掛單或分批進場`
      );
    }

    orderbookResult = {
      status: 'READY',
      bestBid: roundTo(bestBid, 6),
      bestAsk: roundTo(bestAsk, 6),
      midPrice: roundTo(midPrice, 6),
      spreadBps: spreadBps !== null ? roundTo(spreadBps, 2) : null,
      bidDepth50bpsUsd: roundTo(bidDepth50, 2),
      askDepth50bpsUsd: roundTo(askDepth50, 2),
      obi50bpsPct: roundTo(obi50, 2),
      bidDepth100bpsUsd: roundTo(bidDepth100, 2),
      askDepth100bpsUsd: roundTo(askDepth100, 2),
      obi100bpsPct: roundTo(obi100, 2),
      imbalanceLabelZh,
      bidWalls,
      askWalls,
      slippageTiers,
      compactBids: cleanBids.slice(0, 25),
      compactAsks: cleanAsks.slice(0, 25),
      interpretationZh: `${interpretationParts.join('；')}。`,
    };
  } else {
    orderbookResult = {
      status: 'UNAVAILABLE',
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      spreadBps: null,
      bidDepth50bpsUsd: null,
      askDepth50bpsUsd: null,
      obi50bpsPct: null,
      bidDepth100bpsUsd: null,
      askDepth100bpsUsd: null,
      obi100bpsPct: null,
      imbalanceLabelZh: '盤口深度缺失',
      bidWalls: [],
      askWalls: [],
      slippageTiers: [],
      compactBids: [],
      compactAsks: [],
      interpretationZh: '目前無法取得合約即時訂單簿深度，無法計算 OBI 與市價滑點預估。',
    };
  }

  return {
    symbol,
    evaluatedAt,
    spotPerpBasis,
    orderbook: orderbookResult,
  };
}
