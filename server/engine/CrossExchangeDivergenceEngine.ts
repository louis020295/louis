import {
  CrossExchangeDivergenceItem,
  CrossExchangeDivergenceResponse,
  CrossExchangeVenueLeg,
  DataProvenance,
  ExchangeId,
  MarketTicker,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export interface VenueSnapshotInput {
  exchange: 'binance_usdm' | 'bybit_linear' | 'bingx_swap';
  displayName: string;
  available: boolean;
  error?: string;
  tickers: MarketTicker[];
  provenance: DataProvenance;
}

const VENUE_IDS: Array<'binance_usdm' | 'bybit_linear' | 'bingx_swap'> = [
  'binance_usdm',
  'bybit_linear',
  'bingx_swap',
];

export function evaluateCrossExchangeDivergence(
  venues: Record<'binance_usdm' | 'bybit_linear' | 'bingx_swap', VenueSnapshotInput>,
  options: {
    mode?: 'live' | 'demo';
    targetSymbols?: string[];
    limit?: number;
  } = {}
): CrossExchangeDivergenceResponse {
  const generatedAt = new Date().toISOString();
  const mode = options.mode ?? 'live';
  const isDemo = Object.values(venues).some((v) => v.provenance.isDemo);
  const anyFallback = Object.values(venues).some((v) => v.provenance.fallback);
  const anyStale = Object.values(venues).some((v) => v.provenance.stale);

  const tickerMaps: Record<
    'binance_usdm' | 'bybit_linear' | 'bingx_swap',
    Map<string, MarketTicker>
  > = {
    binance_usdm: new Map(venues.binance_usdm.tickers.map((t) => [t.symbol, t])),
    bybit_linear: new Map(venues.bybit_linear.tickers.map((t) => [t.symbol, t])),
    bingx_swap: new Map(venues.bingx_swap.tickers.map((t) => [t.symbol, t])),
  };

  // Collect candidate symbols present on at least 2 exchanges (or matching targetSymbols)
  const symbolSet = new Set<string>();
  if (options.targetSymbols && options.targetSymbols.length > 0) {
    for (const s of options.targetSymbols) symbolSet.add(s.toUpperCase());
  } else {
    for (const v of VENUE_IDS) {
      for (const t of venues[v].tickers) {
        symbolSet.add(t.symbol);
      }
    }
  }

  const items: CrossExchangeDivergenceItem[] = [];

  for (const symbol of symbolSet) {
    const legs = {} as Record<
      'binance_usdm' | 'bybit_linear' | 'bingx_swap',
      CrossExchangeVenueLeg
    >;
    const venuesPresent: ExchangeId[] = [];

    for (const vId of VENUE_IDS) {
      const venueMeta = venues[vId];
      const ticker = tickerMaps[vId].get(symbol);

      if (venueMeta.available && ticker) {
        venuesPresent.push(vId);
        const legMissing = [...ticker.provenance.missingData];
        if (
          (ticker.openInterestValue === null ||
            ticker.openInterestValue === undefined) &&
          !legMissing.includes('openInterest')
        ) {
          legMissing.push('openInterest');
        }

        const hasValidBook =
          ticker.bidPrice !== null &&
          ticker.bidPrice !== undefined &&
          ticker.askPrice !== null &&
          ticker.askPrice !== undefined &&
          ticker.bidPrice > 0 &&
          ticker.askPrice >= ticker.bidPrice;

        const computedSpread = hasValidBook
          ? (ticker.spread ??
            Number((ticker.askPrice! - ticker.bidPrice!).toPrecision(6)))
          : null;
        const computedSpreadPct = hasValidBook
          ? (ticker.spreadPercent ??
            Number(
              (
                ((ticker.askPrice! - ticker.bidPrice!) /
                  ((ticker.askPrice! + ticker.bidPrice!) / 2)) *
                100
              ).toFixed(5)
            ))
          : null;

        if (computedSpreadPct === null && !legMissing.includes('BID_ASK_SPREAD')) {
          legMissing.push('BID_ASK_SPREAD');
        }

        legs[vId] = {
          exchange: vId,
          displayName: venueMeta.displayName,
          available: true,
          lastPrice: ticker.lastPrice,
          bidPrice: hasValidBook ? ticker.bidPrice! : null,
          askPrice: hasValidBook ? ticker.askPrice! : null,
          spread: computedSpread,
          spreadPercent: computedSpreadPct,
          fundingRate: ticker.fundingRate,
          openInterest: ticker.openInterest,
          openInterestValue: ticker.openInterestValue,
          quoteVolume24h: ticker.quoteVolume24h,
          provenance: {
            ...ticker.provenance,
            missingData: legMissing,
          },
        };
      } else {
        legs[vId] = {
          exchange: vId,
          displayName: venueMeta.displayName,
          available: false,
          lastPrice: null,
          bidPrice: null,
          askPrice: null,
          spread: null,
          spreadPercent: null,
          fundingRate: null,
          openInterest: null,
          openInterestValue: null,
          quoteVolume24h: null,
          provenance: {
            source: venueMeta.provenance.source,
            fetchedAt: venueMeta.provenance.fetchedAt,
            stale: venueMeta.provenance.stale,
            fallback: venueMeta.provenance.fallback,
            missingData: venueMeta.available
              ? [`SYMBOL_NOT_LISTED_${vId.toUpperCase()}`]
              : [`VENUE_UNAVAILABLE_${vId.toUpperCase()}`],
            isDemo: venueMeta.provenance.isDemo,
          },
        };
      }
    }

    if (
      (!options.targetSymbols || options.targetSymbols.length === 0) &&
      venuesPresent.length < 2
    ) {
      continue;
    }

    // 1. Price Divergence
    const validPrices = VENUE_IDS.map((vId) => ({
      exchange: vId,
      price: legs[vId].lastPrice,
    })).filter(
      (p): p is { exchange: 'binance_usdm' | 'bybit_linear' | 'bingx_swap'; price: number } =>
        p.price !== null && Number.isFinite(p.price) && p.price > 0
    );

    let maxPriceExchange: ExchangeId | null = null;
    let minPriceExchange: ExchangeId | null = null;
    let priceDivergencePercent: number | null = null;

    if (validPrices.length >= 2) {
      validPrices.sort((a, b) => a.price - b.price);
      const minP = validPrices[0];
      const maxP = validPrices[validPrices.length - 1];
      minPriceExchange = minP.exchange;
      maxPriceExchange = maxP.exchange;
      priceDivergencePercent = Number(
        (((maxP.price - minP.price) / minP.price) * 100).toFixed(4)
      );
    }

    // 2. Funding Rate Divergence (in bps: 0.01% = 1 bps)
    const validFundings = VENUE_IDS.map((vId) => ({
      exchange: vId,
      funding: legs[vId].fundingRate,
    })).filter(
      (f): f is { exchange: 'binance_usdm' | 'bybit_linear' | 'bingx_swap'; funding: number } =>
        f.funding !== null && Number.isFinite(f.funding)
    );

    let maxFundingExchange: ExchangeId | null = null;
    let minFundingExchange: ExchangeId | null = null;
    let fundingDivergenceBps: number | null = null;

    if (validFundings.length >= 2) {
      validFundings.sort((a, b) => a.funding - b.funding);
      const minF = validFundings[0];
      const maxF = validFundings[validFundings.length - 1];
      minFundingExchange = minF.exchange;
      maxFundingExchange = maxF.exchange;
      fundingDivergenceBps = Number(
        ((maxF.funding - minF.funding) * 10_000).toFixed(2)
      );
    }

    // 3. Spread Divergence
    const validSpreads = VENUE_IDS.map((vId) => legs[vId].spreadPercent).filter(
      (s): s is number => s !== null && Number.isFinite(s)
    );
    let spreadDivergencePercent: number | null = null;
    if (validSpreads.length >= 2) {
      const minS = Math.min(...validSpreads);
      const maxS = Math.max(...validSpreads);
      spreadDivergencePercent = Number((maxS - minS).toFixed(5));
    }

    // 4. Open Interest Comparison & Divergence
    const validOis = VENUE_IDS.map((vId) => ({
      exchange: vId,
      oiUsd: legs[vId].openInterestValue,
    })).filter(
      (o): o is { exchange: 'binance_usdm' | 'bybit_linear' | 'bingx_swap'; oiUsd: number } =>
        o.oiUsd !== null && Number.isFinite(o.oiUsd) && o.oiUsd > 0
    );

    let totalOpenInterestUsd: number | null = null;
    const oiShareByExchange: Partial<Record<ExchangeId, number | null>> = {
      binance_usdm: null,
      bybit_linear: null,
      bingx_swap: null,
    };
    let oiDivergencePercent: number | null = null;

    if (validOis.length >= 1) {
      totalOpenInterestUsd = validOis.reduce((acc, o) => acc + o.oiUsd, 0);
      if (totalOpenInterestUsd > 0) {
        for (const o of validOis) {
          oiShareByExchange[o.exchange] = Number(
            ((o.oiUsd / totalOpenInterestUsd) * 100).toFixed(2)
          );
        }
      }
      if (validOis.length >= 2) {
        const shares = validOis.map(
          (o) => (o.oiUsd / totalOpenInterestUsd!) * 100
        );
        oiDivergencePercent = Number(
          (Math.max(...shares) - Math.min(...shares)).toFixed(2)
        );
      }
    }

    const divergenceFlags: string[] = [];
    if (priceDivergencePercent !== null && priceDivergencePercent >= 0.25) {
      divergenceFlags.push(
        `跨所價差背離 (${priceDivergencePercent.toFixed(3)}%: ${maxPriceExchange} vs ${minPriceExchange})`
      );
    }
    if (fundingDivergenceBps !== null && fundingDivergenceBps >= 3.0) {
      divergenceFlags.push(
        `跨所資金費率背離 (${fundingDivergenceBps.toFixed(2)} bps: ${maxFundingExchange} vs ${minFundingExchange})`
      );
    }
    if (spreadDivergencePercent !== null && spreadDivergencePercent >= 0.06) {
      divergenceFlags.push(
        `跨所盤口價差差異顯著 (${spreadDivergencePercent.toFixed(4)}%)`
      );
    }

    const combinedMissing = [
      ...new Set(
        VENUE_IDS.flatMap((vId) =>
          legs[vId].provenance.missingData.map((m) => `${vId}:${m}`)
        )
      ),
    ];

    items.push({
      symbol,
      venuesPresent,
      legs,
      maxPriceExchange,
      minPriceExchange,
      priceDivergencePercent,
      maxFundingExchange,
      minFundingExchange,
      fundingDivergenceBps,
      spreadDivergencePercent,
      totalOpenInterestUsd,
      oiShareByExchange,
      oiDivergencePercent,
      divergenceFlags,
      provenance: {
        source: VENUE_IDS.map((v) => legs[v].provenance.source).join(' | '),
        fetchedAt: generatedAt,
        stale: VENUE_IDS.some((v) => legs[v].provenance.stale),
        fallback: VENUE_IDS.some((v) => legs[v].provenance.fallback),
        missingData: combinedMissing,
        isDemo,
      },
    });
  }

  // Sort by highest combined volume or price/funding divergence
  items.sort((a, b) => {
    const volA = VENUE_IDS.reduce(
      (s, v) => s + (a.legs[v].quoteVolume24h ?? 0),
      0
    );
    const volB = VENUE_IDS.reduce(
      (s, v) => s + (b.legs[v].quoteVolume24h ?? 0),
      0
    );
    if (a.divergenceFlags.length !== b.divergenceFlags.length) {
      return b.divergenceFlags.length - a.divergenceFlags.length;
    }
    return volB - volA;
  });

  const limitedItems = options.limit ? items.slice(0, options.limit) : items;

  const rootMissing = VENUE_IDS.filter((v) => !venues[v].available).map(
    (v) => `VENUE_UNAVAILABLE_${v.toUpperCase()}`
  );

  return {
    safety: TRADING_SAFETY_FLAGS,
    mode,
    isDemo,
    fallback: anyFallback,
    generatedAt,
    venueStatuses: {
      binance_usdm: {
        available: venues.binance_usdm.available,
        error: venues.binance_usdm.error,
        provenance: venues.binance_usdm.provenance,
      },
      bybit_linear: {
        available: venues.bybit_linear.available,
        error: venues.bybit_linear.error,
        provenance: venues.bybit_linear.provenance,
      },
      bingx_swap: {
        available: venues.bingx_swap.available,
        error: venues.bingx_swap.error,
        provenance: venues.bingx_swap.provenance,
      },
    },
    items: limitedItems,
    provenance: {
      source: `Multi-Exchange Aggregator (${VENUE_IDS.map(
        (v) => venues[v].provenance.source
      ).join(' + ')})`,
      fetchedAt: generatedAt,
      stale: anyStale,
      fallback: anyFallback,
      missingData: rootMissing,
      isDemo,
    },
  };
}
