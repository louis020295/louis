import {
  DataProvenance,
  ExchangeId,
  ExchangeStatus,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  MarketTicker,
  Timeframe,
} from '../../src/types/market.ts';

export interface ExchangeErrorMetadata {
  statusCode?: number;
  retryAttempts?: number;
  isTimeout?: boolean;
  isRateLimited?: boolean;
}

export class ExchangeApiUnavailableError extends Error {
  public readonly source: string;
  public readonly statusCode?: number;
  public readonly retryAttempts: number;
  public readonly isTimeout: boolean;
  public readonly isRateLimited: boolean;

  constructor(
    message: string,
    source: string,
    statusCode?: number,
    meta: ExchangeErrorMetadata = {}
  ) {
    super(message);
    this.name = 'ExchangeApiUnavailableError';
    this.source = source;
    this.statusCode = statusCode ?? meta.statusCode;
    this.retryAttempts = meta.retryAttempts ?? 0;
    this.isTimeout = meta.isTimeout ?? false;
    this.isRateLimited = meta.isRateLimited ?? statusCode === 429;
  }
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 40, windowMs = 10_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public checkAndRecord(sourceName: string, now = Date.now()): void {
    while (
      this.timestamps.length > 0 &&
      now - this.timestamps[0] >= this.windowMs
    ) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) {
      throw new ExchangeApiUnavailableError(
        `Client rate limit exceeded for ${sourceName} (${this.maxRequests} req / ${this.windowMs}ms)`,
        sourceName,
        429,
        { isRateLimited: true, retryAttempts: 0 }
      );
    }
    this.timestamps.push(now);
  }
}

export interface ResilientRequestOptions {
  endpoints: string[];
  path: string;
  sourceLabel: string;
  timeoutMs?: number;
  maxRetriesPerEndpoint?: number;
  retryBaseDelayMs?: number;
  rateLimiter?: SlidingWindowRateLimiter;
  customFetch?: typeof fetch;
}

export async function fetchWithResilience<T>(
  options: ResilientRequestOptions
): Promise<{
  data: T;
  endpointUsed: string;
  usedFallbackEndpoint: boolean;
  retryAttempts: number;
}> {
  const {
    endpoints,
    path,
    sourceLabel,
    timeoutMs = 7000,
    maxRetriesPerEndpoint = 2,
    retryBaseDelayMs = 80,
    rateLimiter,
    customFetch = globalThis.fetch,
  } = options;

  let lastError: Error | null = null;
  let lastStatusCode: number | undefined;
  let totalRetries = 0;
  let sawTimeout = false;
  let sawRateLimit = false;

  for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
    const base = endpoints[epIdx].replace(/\/$/, '');
    const url = `${base}${path}`;

    for (let attempt = 0; attempt <= maxRetriesPerEndpoint; attempt++) {
      if (attempt > 0) {
        totalRetries++;
        const delay = retryBaseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      if (rateLimiter) {
        rateLimiter.checkAndRecord(`${sourceLabel} (${base})`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await customFetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'CryptoMarketRadar/2.0',
          },
        });
        clearTimeout(timer);

        if (res.status === 429) {
          sawRateLimit = true;
          lastStatusCode = 429;
          const text = await res.text().catch(() => '');
          lastError = new ExchangeApiUnavailableError(
            `${sourceLabel} HTTP 429 Rate Limited: ${text.slice(0, 120) || 'Too Many Requests'}`,
            base,
            429,
            {
              retryAttempts: totalRetries,
              isRateLimited: true,
              isTimeout: false,
            }
          );
          // Retry on 429 if attempts remain
          continue;
        }

        if (!res.ok) {
          lastStatusCode = res.status;
          const text = await res.text().catch(() => '');
          lastError = new ExchangeApiUnavailableError(
            `${sourceLabel} HTTP ${res.status}: ${text.slice(0, 140) || res.statusText}`,
            base,
            res.status,
            {
              retryAttempts: totalRetries,
              isRateLimited: false,
              isTimeout: false,
            }
          );
          // Retry on transient 5xx errors
          if (res.status >= 500 && attempt < maxRetriesPerEndpoint) {
            continue;
          }
          break;
        }

        const data = (await res.json()) as T;
        return {
          data,
          endpointUsed: base,
          usedFallbackEndpoint: epIdx > 0,
          retryAttempts: totalRetries,
        };
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ExchangeApiUnavailableError && err.isRateLimited) {
          throw err;
        }
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.message.toLowerCase().includes('abort') ||
            err.message.toLowerCase().includes('timeout'));
        if (isAbort) {
          sawTimeout = true;
        }
        lastError =
          err instanceof Error
            ? err
            : new Error(`Unknown network error connecting to ${sourceLabel}`);
      }
    }
  }

  throw new ExchangeApiUnavailableError(
    lastError?.message || `${sourceLabel} 無法連線`,
    `${sourceLabel} (${endpoints[0]})`,
    lastStatusCode,
    {
      retryAttempts: totalRetries,
      isTimeout: sawTimeout,
      isRateLimited: sawRateLimit,
    }
  );
}

export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDemo: boolean;
  readonly status: ExchangeStatus;

  fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }>;

  fetchOpenInterest(
    symbol: string,
    referencePrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }>;

  fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit?: number
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
  }>;

  fetchHistoricalOpenInterest?(
    symbol: string,
    timeframe: Timeframe,
    limit?: number
  ): Promise<{
    series: HistoricalOpenInterestPoint[];
    provenance: DataProvenance;
  }>;

  fetchHistoricalFundingRates?(
    symbol: string,
    limit?: number,
    startTime?: number
  ): Promise<{
    series: HistoricalFundingRatePoint[];
    provenance: DataProvenance;
  }>;
}

export interface AdapterClientConfig {
  endpoints?: string[];
  timeoutMs?: number;
  maxRetriesPerEndpoint?: number;
  retryBaseDelayMs?: number;
  rateLimiter?: SlidingWindowRateLimiter;
  customFetch?: typeof fetch;
}

const INTERVAL_MS_MAP: Record<Timeframe, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

// ============================================================================
// 1. Binance USDⓈ-M Futures Public REST Adapter
// ============================================================================

const DEFAULT_BINANCE_ENDPOINTS = [
  process.env.BINANCE_FAPI_BASE_URL || 'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
];

interface BinanceExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    pair: string;
    contractType: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
  }>;
}

interface Binance24hrTickerRaw {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  closeTime: number;
}

interface BinancePremiumIndexRaw {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface BinanceBookTickerRaw {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  time?: number;
}

interface BinanceOpenInterestRaw {
  symbol: string;
  openInterest: string;
  time: number;
}

type BinanceKlineTuple = [
  number, // 0: Open time
  string, // 1: Open
  string, // 2: High
  string, // 3: Low
  string, // 4: Close
  string, // 5: Volume
  number, // 6: Close time
  string, // 7: Quote asset volume
  number, // 8: Number of trades
  string, // 9: Taker buy base asset volume
  string, // 10: Taker buy quote asset volume
  string  // 11: Ignore
];

export class BinanceFuturesAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly displayName = 'Binance USDⓈ-M Futures (Public REST)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status: ExchangeStatus = 'LIVE';

  private readonly config: AdapterClientConfig;
  private cachedSymbols: Map<string, { baseAsset: string; quoteAsset: string }> | null = null;
  private cachedSymbolsTimestamp = 0;

  constructor(config: AdapterClientConfig = {}) {
    this.config = config;
  }

  private request<T>(path: string) {
    return fetchWithResilience<T>({
      endpoints: this.config.endpoints ?? DEFAULT_BINANCE_ENDPOINTS,
      path,
      sourceLabel: 'Binance USDⓈ-M Futures REST',
      timeoutMs: this.config.timeoutMs ?? 7000,
      maxRetriesPerEndpoint: this.config.maxRetriesPerEndpoint ?? 2,
      retryBaseDelayMs: this.config.retryBaseDelayMs ?? 60,
      rateLimiter: this.config.rateLimiter,
      customFetch: this.config.customFetch,
    });
  }

  private async getTradingUsdtPerpetualMap(): Promise<{
    map: Map<string, { baseAsset: string; quoteAsset: string }>;
    endpointUsed: string;
    usedFallback: boolean;
  }> {
    const now = Date.now();
    const endpoints = this.config.endpoints ?? DEFAULT_BINANCE_ENDPOINTS;
    if (this.cachedSymbols && now - this.cachedSymbolsTimestamp < 10 * 60 * 1000) {
      return {
        map: this.cachedSymbols,
        endpointUsed: endpoints[0],
        usedFallback: false,
      };
    }

    const { data, endpointUsed, usedFallbackEndpoint } =
      await this.request<BinanceExchangeInfoResponse>('/fapi/v1/exchangeInfo');

    const map = new Map<string, { baseAsset: string; quoteAsset: string }>();
    for (const s of data.symbols || []) {
      if (
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING'
      ) {
        map.set(s.symbol, {
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
        });
      }
    }

    this.cachedSymbols = map;
    this.cachedSymbolsTimestamp = now;

    return { map, endpointUsed, usedFallback: usedFallbackEndpoint };
  }

  public async fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();

    const [symbolsResult, tickersResult, fundingResult, bookTickerResult] =
      await Promise.all([
        this.getTradingUsdtPerpetualMap(),
        this.request<Binance24hrTickerRaw[]>('/fapi/v1/ticker/24hr'),
        this.request<BinancePremiumIndexRaw[]>('/fapi/v1/premiumIndex'),
        this.request<BinanceBookTickerRaw[]>('/fapi/v1/ticker/bookTicker').catch(
          () => null
        ),
      ]);

    const fundingMap = new Map<string, { rate: number | null; nextTime: number | null }>();
    for (const item of fundingResult.data || []) {
      const parsed = Number.parseFloat(item.lastFundingRate);
      fundingMap.set(item.symbol, {
        rate: Number.isFinite(parsed) ? parsed : null,
        nextTime: item.nextFundingTime || null,
      });
    }

    const bookMap = new Map<
      string,
      {
        bidPrice: number | null;
        askPrice: number | null;
        spread: number | null;
        spreadPercent: number | null;
        stale: boolean;
      }
    >();

    if (bookTickerResult && Array.isArray(bookTickerResult.data)) {
      for (const b of bookTickerResult.data) {
        const bid = Number.parseFloat(b.bidPrice);
        const ask = Number.parseFloat(b.askPrice);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
          const spread = Number((ask - bid).toPrecision(6));
          const mid = (ask + bid) / 2;
          const spreadPercent = Number((((ask - bid) / mid) * 100).toFixed(5));
          const isBookStale =
            typeof b.time === 'number' && b.time > 0
              ? nowMs - b.time > 5 * 60 * 1000
              : false;
          bookMap.set(b.symbol, {
            bidPrice: bid,
            askPrice: ask,
            spread,
            spreadPercent,
            stale: isBookStale,
          });
        }
      }
    }

    const tickers: MarketTicker[] = [];
    const usedFallback =
      symbolsResult.usedFallback ||
      tickersResult.usedFallbackEndpoint ||
      fundingResult.usedFallbackEndpoint ||
      Boolean(bookTickerResult?.usedFallbackEndpoint);

    const sourceLabel = bookTickerResult
      ? `Binance USDⓈ-M Futures REST (${tickersResult.endpointUsed}: /fapi/v1/ticker/24hr, /fapi/v1/premiumIndex, /fapi/v1/ticker/bookTicker)`
      : `Binance USDⓈ-M Futures REST (${tickersResult.endpointUsed}: /fapi/v1/ticker/24hr, /fapi/v1/premiumIndex)`;

    for (const raw of tickersResult.data || []) {
      const meta = symbolsResult.map.get(raw.symbol);
      if (!meta) continue;

      const lastPrice = Number.parseFloat(raw.lastPrice);
      const priceChangePercent24h = Number.parseFloat(raw.priceChangePercent);
      const quoteVolume24h = Number.parseFloat(raw.quoteVolume);
      const funding = fundingMap.get(raw.symbol);
      const book = bookMap.get(raw.symbol);

      const missingData: string[] = [];
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) missingData.push('lastPrice');
      if (!Number.isFinite(priceChangePercent24h)) missingData.push('priceChangePercent24h');
      if (!Number.isFinite(quoteVolume24h)) missingData.push('quoteVolume24h');
      if (!funding || funding.rate === null) missingData.push('fundingRate');
      if (!book || book.spreadPercent === null) missingData.push('BID_ASK_SPREAD');

      const isTickerStale =
        (typeof raw.closeTime === 'number' && raw.closeTime > 0
          ? nowMs - raw.closeTime > 5 * 60 * 1000
          : false) || Boolean(book?.stale);

      tickers.push({
        symbol: raw.symbol,
        baseAsset: meta.baseAsset,
        quoteAsset: meta.quoteAsset,
        lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
        priceChangePercent24h: Number.isFinite(priceChangePercent24h)
          ? priceChangePercent24h
          : 0,
        quoteVolume24h: Number.isFinite(quoteVolume24h) ? quoteVolume24h : 0,
        bidPrice: book?.bidPrice ?? null,
        askPrice: book?.askPrice ?? null,
        spread: book?.spread ?? null,
        spreadPercent: book?.spreadPercent ?? null,
        fundingRate: funding?.rate ?? null,
        nextFundingTime: funding?.nextTime ?? null,
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: isTickerStale,
          fallback: usedFallback,
          missingData,
          isDemo: false,
        },
      });
    }

    return {
      tickers,
      provenance: {
        source: sourceLabel,
        fetchedAt,
        stale: false,
        fallback: usedFallback,
        missingData: bookTickerResult ? [] : ['BID_ASK_SPREAD'],
        isDemo: false,
      },
    };
  }

  public async fetchOpenInterest(
    symbol: string,
    referencePrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    try {
      const { data, endpointUsed, usedFallbackEndpoint } =
        await this.request<BinanceOpenInterestRaw>(
          `/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`
        );

      const oi = Number.parseFloat(data.openInterest);
      const validOi = Number.isFinite(oi) && oi >= 0 ? oi : null;
      const oiValue =
        validOi !== null && referencePrice && referencePrice > 0
          ? validOi * referencePrice
          : null;

      const missingData: string[] = [];
      if (validOi === null) missingData.push('openInterest');

      const isStale =
        typeof data.time === 'number' && data.time > 0
          ? Date.now() - data.time > 10 * 60 * 1000
          : false;

      return {
        openInterest: validOi,
        openInterestValue: oiValue,
        provenance: {
          source: `Binance USDⓈ-M Futures REST (${endpointUsed}/fapi/v1/openInterest)`,
          fetchedAt,
          stale: isStale,
          fallback: usedFallbackEndpoint,
          missingData,
          isDemo: false,
        },
      };
    } catch {
      return {
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/openInterest)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['openInterest'],
          isDemo: false,
        },
      };
    }
  }

  public async fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit = 120
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();

    const { data, endpointUsed, usedFallbackEndpoint } =
      await this.request<BinanceKlineTuple[]>(
        `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(
          timeframe
        )}&limit=${limit}`
      );

    const klines: Kline[] = (data || []).map((tuple) => {
      const openTime = Number(tuple[0]);
      const closeTime = Number(tuple[6]);
      return {
        openTime,
        open: Number.parseFloat(tuple[1]),
        high: Number.parseFloat(tuple[2]),
        low: Number.parseFloat(tuple[3]),
        close: Number.parseFloat(tuple[4]),
        volume: Number.parseFloat(tuple[5]),
        closeTime,
        quoteVolume: Number.parseFloat(tuple[7]),
        isClosed: closeTime <= nowMs,
      };
    });

    const missingData: string[] = [];
    if (klines.length === 0) missingData.push(`klines_${timeframe}`);

    return {
      klines,
      provenance: {
        source: `Binance USDⓈ-M Futures REST (${endpointUsed}/fapi/v1/klines)`,
        fetchedAt,
        stale: false,
        fallback: usedFallbackEndpoint,
        missingData,
        isDemo: false,
      },
    };
  }

  public async fetchHistoricalOpenInterest(
    symbol: string,
    timeframe: Timeframe,
    limit = 200
  ): Promise<{
    series: HistoricalOpenInterestPoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const safeLimit = Math.min(500, Math.max(30, limit));
    try {
      const { data, endpointUsed, usedFallbackEndpoint } = await this.request<
        Array<{
          symbol: string;
          sumOpenInterest: string;
          sumOpenInterestValue: string;
          timestamp: number;
        }>
      >(
        `/futures/data/openInterestHist?symbol=${encodeURIComponent(
          symbol
        )}&period=${encodeURIComponent(timeframe)}&limit=${safeLimit}`
      );

      const sourceLabel = `Binance USDⓈ-M Futures REST (${endpointUsed}/futures/data/openInterestHist)`;
      const series: HistoricalOpenInterestPoint[] = (Array.isArray(data) ? data : [])
        .map((row) => {
          const oi = Number.parseFloat(row.sumOpenInterest);
          const oiVal = Number.parseFloat(row.sumOpenInterestValue);
          const ts = Number(row.timestamp);
          return {
            symbol,
            timestamp: ts,
            openInterest: oi,
            openInterestValue: Number.isFinite(oiVal) ? oiVal : null,
            fetchedAt,
            source: sourceLabel,
            isDemo: false,
          };
        })
        .filter(
          (pt) =>
            Number.isFinite(pt.timestamp) &&
            pt.timestamp > 0 &&
            Number.isFinite(pt.openInterest) &&
            pt.openInterest > 0
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      return {
        series,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData: series.length === 0 ? ['historicalOpenInterest'] : [],
          isDemo: false,
        },
      };
    } catch {
      return {
        series: [],
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/futures/data/openInterestHist)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalOpenInterest'],
          isDemo: false,
        },
      };
    }
  }

  public async fetchHistoricalFundingRates(
    symbol: string,
    limit = 500,
    startTime?: number
  ): Promise<{
    series: HistoricalFundingRatePoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const safeLimit = Math.min(1000, Math.max(50, limit));
    const startParam =
      typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0
        ? `&startTime=${Math.floor(startTime)}`
        : '';
    try {
      const { data, endpointUsed, usedFallbackEndpoint } = await this.request<
        Array<{
          symbol: string;
          fundingRate: string;
          fundingTime: number;
        }>
      >(
        `/fapi/v1/fundingRate?symbol=${encodeURIComponent(
          symbol
        )}&limit=${safeLimit}${startParam}`
      );

      const sourceLabel = `Binance USDⓈ-M Futures REST (${endpointUsed}/fapi/v1/fundingRate)`;
      const series: HistoricalFundingRatePoint[] = (Array.isArray(data) ? data : [])
        .map((row) => ({
          symbol,
          timestamp: Number(row.fundingTime),
          fundingRate: Number.parseFloat(row.fundingRate),
          fetchedAt,
          source: sourceLabel,
          isDemo: false,
        }))
        .filter(
          (pt) =>
            Number.isFinite(pt.timestamp) &&
            pt.timestamp > 0 &&
            Number.isFinite(pt.fundingRate)
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      return {
        series,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData: series.length === 0 ? ['historicalFundingRate'] : [],
          isDemo: false,
        },
      };
    } catch {
      return {
        series: [],
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/fundingRate)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalFundingRate'],
          isDemo: false,
        },
      };
    }
  }
}

// ============================================================================
// 2. Bybit USDT Perpetual Public REST Adapter (Phase 2 LIVE)
// ============================================================================

const DEFAULT_BYBIT_ENDPOINTS = [
  process.env.BYBIT_API_BASE_URL || 'https://api.bybit.com',
  'https://api.bytick.com',
];

interface BybitV5Response<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

interface BybitLinearTickerRaw {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
  volume24h: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterest: string;
  openInterestValue: string;
  bid1Price: string;
  ask1Price: string;
  deliveryTime: string;
}

type BybitKlineTuple = [
  string, // 0: startTime (ms)
  string, // 1: openPrice
  string, // 2: highPrice
  string, // 3: lowPrice
  string, // 4: closePrice
  string, // 5: volume
  string  // 6: turnover (quoteVolume)
];

const BYBIT_INTERVAL_MAP: Record<Timeframe, string> = {
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
};

export class BybitFuturesAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'bybit_linear';
  public readonly displayName = 'Bybit USDT Perpetual (Public REST V5)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status: ExchangeStatus = 'LIVE';

  private readonly config: AdapterClientConfig;

  constructor(config: AdapterClientConfig = {}) {
    this.config = config;
  }

  private request<T>(path: string) {
    return fetchWithResilience<BybitV5Response<T>>({
      endpoints: this.config.endpoints ?? DEFAULT_BYBIT_ENDPOINTS,
      path,
      sourceLabel: 'Bybit V5 Linear REST',
      timeoutMs: this.config.timeoutMs ?? 7000,
      maxRetriesPerEndpoint: this.config.maxRetriesPerEndpoint ?? 2,
      retryBaseDelayMs: this.config.retryBaseDelayMs ?? 60,
      rateLimiter: this.config.rateLimiter,
      customFetch: this.config.customFetch,
    });
  }

  public async fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const { data, endpointUsed, usedFallbackEndpoint } = await this.request<{
      category: string;
      list: BybitLinearTickerRaw[];
    }>('/v5/market/tickers?category=linear');

    if (data.retCode !== 0 || !data.result?.list) {
      throw new ExchangeApiUnavailableError(
        `Bybit V5 API retCode ${data.retCode}: ${data.retMsg}`,
        endpointUsed
      );
    }

    const sourceLabel = `Bybit V5 Linear REST (${endpointUsed}/v5/market/tickers?category=linear)`;
    const isStale =
      typeof data.time === 'number' && data.time > 0
        ? Date.now() - data.time > 5 * 60 * 1000
        : false;

    const tickers: MarketTicker[] = [];

    for (const raw of data.result.list) {
      if (!raw.symbol.endsWith('USDT')) continue;
      if (raw.deliveryTime && raw.deliveryTime !== '0') continue;

      const baseAsset = raw.symbol.slice(0, -4);
      const lastPrice = Number.parseFloat(raw.lastPrice);
      const priceChangePercent24h = Number(
        (Number.parseFloat(raw.price24hPcnt) * 100).toFixed(3)
      );
      const quoteVolume24h = Number.parseFloat(raw.turnover24h);
      const fundingRateRaw = Number.parseFloat(raw.fundingRate);
      const fundingRate = Number.isFinite(fundingRateRaw)
        ? fundingRateRaw
        : null;
      const nextFundingTime = raw.nextFundingTime
        ? Number(raw.nextFundingTime)
        : null;
      const oiRaw = Number.parseFloat(raw.openInterest);
      const oiValRaw = Number.parseFloat(raw.openInterestValue);
      const openInterest = Number.isFinite(oiRaw) && oiRaw >= 0 ? oiRaw : null;
      const openInterestValue =
        Number.isFinite(oiValRaw) && oiValRaw >= 0 ? oiValRaw : null;

      const bid = Number.parseFloat(raw.bid1Price);
      const ask = Number.parseFloat(raw.ask1Price);
      const hasBidAsk =
        Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;

      const bidPrice = hasBidAsk ? bid : null;
      const askPrice = hasBidAsk ? ask : null;
      const spread = hasBidAsk ? Number((ask - bid).toPrecision(6)) : null;
      const spreadPercent = hasBidAsk
        ? Number((((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(5))
        : null;

      const missingData: string[] = [];
      if (!Number.isFinite(lastPrice) || lastPrice <= 0)
        missingData.push('lastPrice');
      if (!Number.isFinite(priceChangePercent24h))
        missingData.push('priceChangePercent24h');
      if (!Number.isFinite(quoteVolume24h)) missingData.push('quoteVolume24h');
      if (fundingRate === null) missingData.push('fundingRate');
      if (spreadPercent === null) missingData.push('BID_ASK_SPREAD');

      tickers.push({
        symbol: raw.symbol,
        baseAsset,
        quoteAsset: 'USDT',
        lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
        priceChangePercent24h: Number.isFinite(priceChangePercent24h)
          ? priceChangePercent24h
          : 0,
        quoteVolume24h: Number.isFinite(quoteVolume24h) ? quoteVolume24h : 0,
        bidPrice,
        askPrice,
        spread,
        spreadPercent,
        fundingRate,
        nextFundingTime,
        openInterest,
        openInterestValue,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: isStale,
          fallback: usedFallbackEndpoint,
          missingData,
          isDemo: false,
        },
      });
    }

    return {
      tickers,
      provenance: {
        source: sourceLabel,
        fetchedAt,
        stale: isStale,
        fallback: usedFallbackEndpoint,
        missingData: [],
        isDemo: false,
      },
    };
  }

  public async fetchOpenInterest(
    symbol: string,
    referencePrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    try {
      const { data, endpointUsed, usedFallbackEndpoint } = await this.request<{
        category: string;
        list: BybitLinearTickerRaw[];
      }>(
        `/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`
      );

      const item = data.result?.list?.[0];
      const oiRaw = item ? Number.parseFloat(item.openInterest) : NaN;
      const oiValRaw = item ? Number.parseFloat(item.openInterestValue) : NaN;
      const validOi = Number.isFinite(oiRaw) && oiRaw >= 0 ? oiRaw : null;
      const validOiValue =
        Number.isFinite(oiValRaw) && oiValRaw >= 0
          ? oiValRaw
          : validOi !== null && referencePrice && referencePrice > 0
            ? validOi * referencePrice
            : null;

      const missingData: string[] = [];
      if (validOi === null) missingData.push('openInterest');

      return {
        openInterest: validOi,
        openInterestValue: validOiValue,
        provenance: {
          source: `Bybit V5 Linear REST (${endpointUsed}/v5/market/tickers?category=linear)`,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData,
          isDemo: false,
        },
      };
    } catch {
      return {
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: 'Bybit V5 Linear REST (/v5/market/tickers)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['openInterest'],
          isDemo: false,
        },
      };
    }
  }

  public async fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit = 120
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();
    const bybitInterval = BYBIT_INTERVAL_MAP[timeframe];
    const intervalMs = INTERVAL_MS_MAP[timeframe];

    const { data, endpointUsed, usedFallbackEndpoint } = await this.request<{
      category: string;
      symbol: string;
      list: BybitKlineTuple[];
    }>(
      `/v5/market/kline?category=linear&symbol=${encodeURIComponent(
        symbol
      )}&interval=${bybitInterval}&limit=${limit}`
    );

    if (data.retCode !== 0 || !data.result?.list) {
      throw new ExchangeApiUnavailableError(
        `Bybit V5 Kline error (${data.retCode}): ${data.retMsg}`,
        endpointUsed
      );
    }

    // Bybit returns newest first -> reverse to chronological order
    const rawList = [...data.result.list].sort(
      (a, b) => Number(a[0]) - Number(b[0])
    );

    const klines: Kline[] = rawList.map((tuple) => {
      const openTime = Number(tuple[0]);
      const closeTime = openTime + intervalMs - 1;
      return {
        openTime,
        open: Number.parseFloat(tuple[1]),
        high: Number.parseFloat(tuple[2]),
        low: Number.parseFloat(tuple[3]),
        close: Number.parseFloat(tuple[4]),
        volume: Number.parseFloat(tuple[5]),
        closeTime,
        quoteVolume: Number.parseFloat(tuple[6]),
        isClosed: closeTime <= nowMs,
      };
    });

    const missingData: string[] = [];
    if (klines.length === 0) missingData.push(`klines_${timeframe}`);

    return {
      klines,
      provenance: {
        source: `Bybit V5 Linear REST (${endpointUsed}/v5/market/kline)`,
        fetchedAt,
        stale: false,
        fallback: usedFallbackEndpoint,
        missingData,
        isDemo: false,
      },
    };
  }

  public async fetchHistoricalOpenInterest(
    symbol: string,
    timeframe: Timeframe,
    limit = 200
  ): Promise<{
    series: HistoricalOpenInterestPoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const bybitOiIntervalMap: Record<Timeframe, string> = {
      '5m': '5min',
      '15m': '15min',
      '1h': '1h',
      '4h': '4h',
    };
    const intervalTime = bybitOiIntervalMap[timeframe] || '15min';
    const safeLimit = Math.min(200, Math.max(30, limit));
    try {
      const { data, endpointUsed, usedFallbackEndpoint } = await this.request<{
        category: string;
        symbol: string;
        list: Array<{ openInterest: string; timestamp: string }>;
      }>(
        `/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(
          symbol
        )}&intervalTime=${intervalTime}&limit=${safeLimit}`
      );
      const sourceLabel = `Bybit V5 Linear REST (${endpointUsed}/v5/market/open-interest)`;
      const rawList = data.result?.list ?? [];
      const series: HistoricalOpenInterestPoint[] = rawList
        .map((row) => ({
          symbol,
          timestamp: Number(row.timestamp),
          openInterest: Number.parseFloat(row.openInterest),
          openInterestValue: null,
          fetchedAt,
          source: sourceLabel,
          isDemo: false,
        }))
        .filter(
          (pt) =>
            Number.isFinite(pt.timestamp) &&
            pt.timestamp > 0 &&
            Number.isFinite(pt.openInterest) &&
            pt.openInterest > 0
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      return {
        series,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData: series.length === 0 ? ['historicalOpenInterest'] : [],
          isDemo: false,
        },
      };
    } catch {
      return {
        series: [],
        provenance: {
          source: 'Bybit V5 Linear REST (/v5/market/open-interest)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalOpenInterest'],
          isDemo: false,
        },
      };
    }
  }

  public async fetchHistoricalFundingRates(
    symbol: string,
    limit = 200
  ): Promise<{
    series: HistoricalFundingRatePoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const safeLimit = Math.min(200, Math.max(30, limit));
    try {
      const { data, endpointUsed, usedFallbackEndpoint } = await this.request<{
        category: string;
        list: Array<{
          symbol: string;
          fundingRate: string;
          fundingRateTimestamp: string;
        }>;
      }>(
        `/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(
          symbol
        )}&limit=${safeLimit}`
      );
      const sourceLabel = `Bybit V5 Linear REST (${endpointUsed}/v5/market/funding/history)`;
      const rawList = data.result?.list ?? [];
      const series: HistoricalFundingRatePoint[] = rawList
        .map((row) => ({
          symbol,
          timestamp: Number(row.fundingRateTimestamp),
          fundingRate: Number.parseFloat(row.fundingRate),
          fetchedAt,
          source: sourceLabel,
          isDemo: false,
        }))
        .filter(
          (pt) =>
            Number.isFinite(pt.timestamp) &&
            pt.timestamp > 0 &&
            Number.isFinite(pt.fundingRate)
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      return {
        series,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData: series.length === 0 ? ['historicalFundingRate'] : [],
          isDemo: false,
        },
      };
    } catch {
      return {
        series: [],
        provenance: {
          source: 'Bybit V5 Linear REST (/v5/market/funding/history)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalFundingRate'],
          isDemo: false,
        },
      };
    }
  }
}

// ============================================================================
// 3. BingX Perpetual Swap Public REST Adapter (Phase 2 LIVE)
// ============================================================================

const DEFAULT_BINGX_ENDPOINTS = [
  process.env.BINGX_API_BASE_URL || 'https://open-api.bingx.com',
];

interface BingXResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface BingXTickerRaw {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  bidPrice: string;
  askPrice: string;
  closeTime?: number;
}

interface BingXPremiumRaw {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  updateTime?: number;
}

interface BingXOpenInterestRaw {
  symbol: string;
  openInterest: string;
  time: number;
}

interface BingXKlineRaw {
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  time: number;
}

export function toBingXSymbol(standardSymbol: string): string {
  if (standardSymbol.includes('-')) return standardSymbol.toUpperCase();
  if (standardSymbol.toUpperCase().endsWith('USDT')) {
    return `${standardSymbol.slice(0, -4).toUpperCase()}-USDT`;
  }
  return standardSymbol.toUpperCase();
}

export function fromBingXSymbol(bingxSymbol: string): string {
  return bingxSymbol.replace('-', '').toUpperCase();
}

export class BingXFuturesAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'bingx_swap';
  public readonly displayName = 'BingX Perpetual Swap (Public REST V2/V3)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status: ExchangeStatus = 'LIVE';

  private readonly config: AdapterClientConfig;

  constructor(config: AdapterClientConfig = {}) {
    this.config = config;
  }

  private request<T>(path: string) {
    return fetchWithResilience<BingXResponse<T>>({
      endpoints: this.config.endpoints ?? DEFAULT_BINGX_ENDPOINTS,
      path,
      sourceLabel: 'BingX Swap V2 REST',
      timeoutMs: this.config.timeoutMs ?? 7000,
      maxRetriesPerEndpoint: this.config.maxRetriesPerEndpoint ?? 2,
      retryBaseDelayMs: this.config.retryBaseDelayMs ?? 60,
      rateLimiter: this.config.rateLimiter,
      customFetch: this.config.customFetch,
    });
  }

  public async fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();

    const [tickerRes, premiumRes] = await Promise.all([
      this.request<BingXTickerRaw[]>('/openApi/swap/v2/quote/ticker'),
      this.request<BingXPremiumRaw[]>(
        '/openApi/swap/v2/quote/premiumIndex'
      ).catch(() => null),
    ]);

    if (tickerRes.data.code !== 0 || !Array.isArray(tickerRes.data.data)) {
      throw new ExchangeApiUnavailableError(
        `BingX API error (${tickerRes.data.code}): ${tickerRes.data.msg || 'Invalid ticker response'}`,
        tickerRes.endpointUsed
      );
    }

    const fundingMap = new Map<
      string,
      { rate: number | null; nextTime: number | null }
    >();
    if (premiumRes && Array.isArray(premiumRes.data.data)) {
      for (const p of premiumRes.data.data) {
        const stdSym = fromBingXSymbol(p.symbol);
        const rate = Number.parseFloat(p.lastFundingRate);
        fundingMap.set(stdSym, {
          rate: Number.isFinite(rate) ? rate : null,
          nextTime: p.nextFundingTime || null,
        });
      }
    }

    const usedFallback =
      tickerRes.usedFallbackEndpoint ||
      Boolean(premiumRes?.usedFallbackEndpoint);

    const sourceLabel = `BingX Swap V2 REST (${tickerRes.endpointUsed}: /openApi/swap/v2/quote/ticker, /openApi/swap/v2/quote/premiumIndex)`;
    const tickers: MarketTicker[] = [];

    for (const raw of tickerRes.data.data) {
      if (!raw.symbol.endsWith('-USDT') && !raw.symbol.endsWith('USDT'))
        continue;
      const symbol = fromBingXSymbol(raw.symbol);
      const baseAsset = symbol.slice(0, -4);

      const lastPrice = Number.parseFloat(raw.lastPrice);
      const priceChangePercent24h = Number.parseFloat(raw.priceChangePercent);
      const quoteVolume24h = Number.parseFloat(raw.quoteVolume);
      const funding = fundingMap.get(symbol);

      const bid = Number.parseFloat(raw.bidPrice);
      const ask = Number.parseFloat(raw.askPrice);
      const hasBidAsk =
        Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;

      const bidPrice = hasBidAsk ? bid : null;
      const askPrice = hasBidAsk ? ask : null;
      const spread = hasBidAsk ? Number((ask - bid).toPrecision(6)) : null;
      const spreadPercent = hasBidAsk
        ? Number((((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(5))
        : null;

      const missingData: string[] = [];
      if (!Number.isFinite(lastPrice) || lastPrice <= 0)
        missingData.push('lastPrice');
      if (!Number.isFinite(priceChangePercent24h))
        missingData.push('priceChangePercent24h');
      if (!Number.isFinite(quoteVolume24h)) missingData.push('quoteVolume24h');
      if (!funding || funding.rate === null) missingData.push('fundingRate');
      if (spreadPercent === null) missingData.push('BID_ASK_SPREAD');

      const isStale =
        typeof raw.closeTime === 'number' && raw.closeTime > 0
          ? nowMs - raw.closeTime > 5 * 60 * 1000
          : false;

      tickers.push({
        symbol,
        baseAsset,
        quoteAsset: 'USDT',
        lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
        priceChangePercent24h: Number.isFinite(priceChangePercent24h)
          ? priceChangePercent24h
          : 0,
        quoteVolume24h: Number.isFinite(quoteVolume24h) ? quoteVolume24h : 0,
        bidPrice,
        askPrice,
        spread,
        spreadPercent,
        fundingRate: funding?.rate ?? null,
        nextFundingTime: funding?.nextTime ?? null,
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: sourceLabel,
          fetchedAt,
          stale: isStale,
          fallback: usedFallback,
          missingData,
          isDemo: false,
        },
      });
    }

    return {
      tickers,
      provenance: {
        source: sourceLabel,
        fetchedAt,
        stale: false,
        fallback: usedFallback,
        missingData: premiumRes ? [] : ['fundingRate'],
        isDemo: false,
      },
    };
  }

  public async fetchOpenInterest(
    symbol: string,
    referencePrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const bingxSymbol = toBingXSymbol(symbol);
    try {
      const { data, endpointUsed, usedFallbackEndpoint } =
        await this.request<BingXOpenInterestRaw>(
          `/openApi/swap/v2/quote/openInterest?symbol=${encodeURIComponent(
            bingxSymbol
          )}`
        );

      const rawVal = data?.data?.openInterest
        ? Number.parseFloat(data.data.openInterest)
        : NaN;
      const validVal = Number.isFinite(rawVal) && rawVal >= 0 ? rawVal : null;

      // BingX openInterest endpoint returns notional USD value; compute base contract equivalent if referencePrice > 0
      const openInterestValue = validVal;
      const openInterest =
        validVal !== null && referencePrice && referencePrice > 0
          ? Number((validVal / referencePrice).toFixed(4))
          : validVal;

      const missingData: string[] = [];
      if (openInterest === null) missingData.push('openInterest');

      return {
        openInterest,
        openInterestValue,
        provenance: {
          source: `BingX Swap V2 REST (${endpointUsed}/openApi/swap/v2/quote/openInterest)`,
          fetchedAt,
          stale: false,
          fallback: usedFallbackEndpoint,
          missingData,
          isDemo: false,
        },
      };
    } catch {
      return {
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: 'BingX Swap V2 REST (/openApi/swap/v2/quote/openInterest)',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['openInterest'],
          isDemo: false,
        },
      };
    }
  }

  public async fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit = 120
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();
    const bingxSymbol = toBingXSymbol(symbol);
    const intervalMs = INTERVAL_MS_MAP[timeframe];

    const { data, endpointUsed, usedFallbackEndpoint } = await this.request<
      BingXKlineRaw[]
    >(
      `/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(
        bingxSymbol
      )}&interval=${encodeURIComponent(timeframe)}&limit=${limit}`
    );

    if (data.code !== 0 || !Array.isArray(data.data)) {
      throw new ExchangeApiUnavailableError(
        `BingX Kline error (${data.code}): ${data.msg || 'Invalid klines'}`,
        endpointUsed
      );
    }

    const sorted = [...data.data].sort(
      (a, b) => Number(a.time) - Number(b.time)
    );

    const klines: Kline[] = sorted.map((item) => {
      const openTime = Number(item.time);
      const closeTime = openTime + intervalMs - 1;
      const close = Number.parseFloat(item.close);
      const volume = Number.parseFloat(item.volume);
      return {
        openTime,
        open: Number.parseFloat(item.open),
        high: Number.parseFloat(item.high),
        low: Number.parseFloat(item.low),
        close,
        volume,
        closeTime,
        quoteVolume: Number((volume * close).toFixed(2)),
        isClosed: closeTime <= nowMs,
      };
    });

    const missingData: string[] = [];
    if (klines.length === 0) missingData.push(`klines_${timeframe}`);

    return {
      klines,
      provenance: {
        source: `BingX Swap V3 REST (${endpointUsed}/openApi/swap/v3/quote/klines)`,
        fetchedAt,
        stale: false,
        fallback: usedFallbackEndpoint,
        missingData,
        isDemo: false,
      },
    };
  }
}

// ============================================================================
// 4. Explicit Demo Exchange Adapter (isDemo: true, fallback: false)
// ============================================================================

interface DemoSeedSymbol {
  symbol: string;
  baseAsset: string;
  lastPrice: number;
  bidPrice: number | null;
  askPrice: number | null;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  historicalBaseVolume: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  pattern:
    | 'BULL_SMC'
    | 'BEAR_SMC'
    | 'WATCH_BULL'
    | 'WATCH_BEAR'
    | 'CONFLICT_WAIT'
    | 'MISSING_OI_WAIT'
    | 'HIGH_RISK_SQUEEZE'
    | 'RANGE_WATCH';
}

export const DEMO_SYMBOLS: DemoSeedSymbol[] = [
  {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    lastPrice: 91420.5,
    bidPrice: 91420.0,
    askPrice: 91421.0,
    priceChangePercent24h: 2.45,
    quoteVolume24h: 14850000000,
    historicalBaseVolume: 11200000000,
    fundingRate: 0.00012,
    openInterest: 84200,
    pattern: 'RANGE_WATCH',
  },
  {
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    lastPrice: 3185.2,
    bidPrice: 3185.0,
    askPrice: 3185.4,
    priceChangePercent24h: 4.18,
    quoteVolume24h: 8240000000,
    historicalBaseVolume: 4800000000,
    fundingRate: 0.00014,
    openInterest: 1420000,
    pattern: 'WATCH_BULL',
  },
  {
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    lastPrice: 214.65,
    bidPrice: 214.62,
    askPrice: 214.68,
    priceChangePercent24h: 8.72,
    quoteVolume24h: 4920000000,
    historicalBaseVolume: 2150000000, // RVOL ~ 2.29x, Z-Score > 2.5 -> Historical Volume Anomaly
    fundingRate: 0.00021,
    openInterest: 16800000,
    pattern: 'BULL_SMC',
  },
  {
    symbol: 'SUIUSDT',
    baseAsset: 'SUI',
    lastPrice: 3.482,
    bidPrice: 3.4815,
    askPrice: 3.4825,
    priceChangePercent24h: 11.4,
    quoteVolume24h: 1680000000,
    historicalBaseVolume: 740000000,
    fundingRate: 0.00018,
    openInterest: 245000000,
    pattern: 'BULL_SMC',
  },
  {
    symbol: 'AAVEUSDT',
    baseAsset: 'AAVE',
    lastPrice: 294.8,
    bidPrice: 294.75,
    askPrice: 294.85,
    priceChangePercent24h: 6.95,
    quoteVolume24h: 640000000,
    historicalBaseVolume: 330000000,
    fundingRate: 0.0001,
    openInterest: 620000,
    pattern: 'WATCH_BULL',
  },
  {
    symbol: 'LINKUSDT',
    baseAsset: 'LINK',
    lastPrice: 22.84,
    bidPrice: 22.835,
    askPrice: 22.845,
    priceChangePercent24h: 5.62,
    quoteVolume24h: 790000000,
    historicalBaseVolume: 410000000,
    fundingRate: 0.00011,
    openInterest: 28500000,
    pattern: 'CONFLICT_WAIT',
  },
  {
    symbol: 'APTUSDT',
    baseAsset: 'APT',
    lastPrice: 10.92,
    bidPrice: 10.917,
    askPrice: 10.923,
    priceChangePercent24h: -5.48,
    quoteVolume24h: 540000000,
    historicalBaseVolume: 260000000,
    fundingRate: -0.00016,
    openInterest: 31200000,
    pattern: 'BEAR_SMC',
  },
  {
    symbol: 'ARBUSDT',
    baseAsset: 'ARB',
    lastPrice: 0.842,
    bidPrice: 0.8418,
    askPrice: 0.8422,
    priceChangePercent24h: -6.85,
    quoteVolume24h: 610000000,
    historicalBaseVolume: 310000000,
    fundingRate: -0.00019,
    openInterest: 410000000,
    pattern: 'BEAR_SMC',
  },
  {
    symbol: 'OPUSDT',
    baseAsset: 'OP',
    lastPrice: 1.564,
    bidPrice: 1.5635,
    askPrice: 1.5645,
    priceChangePercent24h: -4.92,
    quoteVolume24h: 430000000,
    historicalBaseVolume: 230000000,
    fundingRate: -0.00014,
    openInterest: 145000000,
    pattern: 'WATCH_BEAR',
  },
  {
    symbol: 'TIAUSDT',
    baseAsset: 'TIA',
    lastPrice: 4.78,
    bidPrice: 4.778,
    askPrice: 4.782,
    priceChangePercent24h: -7.6,
    quoteVolume24h: 380000000,
    historicalBaseVolume: 185000000,
    fundingRate: -0.00024,
    openInterest: 46000000,
    pattern: 'CONFLICT_WAIT',
  },
  {
    symbol: 'BNBUSDT',
    baseAsset: 'BNB',
    lastPrice: 648.5,
    bidPrice: 648.4,
    askPrice: 648.6,
    priceChangePercent24h: 1.85,
    quoteVolume24h: 980000000,
    historicalBaseVolume: 920000000,
    fundingRate: 0.00006,
    openInterest: 910000,
    pattern: 'RANGE_WATCH',
  },
  {
    symbol: 'XRPUSDT',
    baseAsset: 'XRP',
    lastPrice: 2.384,
    bidPrice: 2.3836,
    askPrice: 2.3844,
    priceChangePercent24h: 1.92,
    quoteVolume24h: 3150000000,
    historicalBaseVolume: 2950000000,
    fundingRate: 0.0001,
    openInterest: 920000000,
    pattern: 'CONFLICT_WAIT',
  },
  {
    symbol: 'DOGEUSDT',
    baseAsset: 'DOGE',
    lastPrice: 0.3425,
    bidPrice: 0.3424,
    askPrice: 0.3426,
    priceChangePercent24h: 3.12,
    quoteVolume24h: 2740000000,
    historicalBaseVolume: 2500000000,
    fundingRate: 0.00015,
    openInterest: 4120000000,
    pattern: 'RANGE_WATCH',
  },
  {
    symbol: 'AVAXUSDT',
    baseAsset: 'AVAX',
    lastPrice: 36.4,
    bidPrice: null, // Intentionally missing bid/ask to demonstrate missingData: ["BID_ASK_SPREAD"] & Spread 資料不可用
    askPrice: null,
    priceChangePercent24h: 2.1,
    quoteVolume24h: 720000000,
    historicalBaseVolume: null, // Intentionally missing historical baseline to test INSUFFICIENT_HISTORY
    fundingRate: 0.00009,
    openInterest: null, // Intentionally missing OI to demonstrate WAIT gate
    pattern: 'MISSING_OI_WAIT',
  },
  {
    symbol: 'TAOUSDT',
    baseAsset: 'TAO',
    lastPrice: 542.0,
    bidPrice: 541.8,
    askPrice: 542.2,
    priceChangePercent24h: 9.45,
    quoteVolume24h: 490000000,
    historicalBaseVolume: 220000000,
    fundingRate: 0.00019,
    openInterest: 310000,
    pattern: 'BULL_SMC',
  },
  {
    symbol: 'TRUMPUSDT',
    baseAsset: 'TRUMP',
    lastPrice: 18.45,
    bidPrice: 18.38,
    askPrice: 18.52,
    priceChangePercent24h: 24.8,
    quoteVolume24h: 11500000, // Low liquidity + high volatility + extreme funding -> 高風險
    historicalBaseVolume: 8200000,
    fundingRate: 0.00145,
    openInterest: 640000,
    pattern: 'HIGH_RISK_SQUEEZE',
  },
  {
    symbol: 'ORDIUSDT',
    baseAsset: 'ORDI',
    lastPrice: 27.6,
    bidPrice: 27.5,
    askPrice: 27.7,
    priceChangePercent24h: -16.4,
    quoteVolume24h: 9800000, // Low liquidity + high volatility -> 高風險
    historicalBaseVolume: 7500000,
    fundingRate: -0.00095,
    openInterest: 420000,
    pattern: 'HIGH_RISK_SQUEEZE',
  },
  {
    symbol: 'PEPEUSDT',
    baseAsset: '1000PEPE',
    lastPrice: 0.0189,
    bidPrice: 0.01889,
    askPrice: 0.01891,
    priceChangePercent24h: 14.2,
    quoteVolume24h: 1890000000,
    historicalBaseVolume: 980000000,
    fundingRate: 0.00082, // Extreme funding -> 高風險
    openInterest: 15200000000,
    pattern: 'HIGH_RISK_SQUEEZE',
  },
];

export function buildDemoHistoricalVolumeMap(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const seed of DEMO_SYMBOLS) {
    if (seed.historicalBaseVolume === null) {
      // 29 prior confirmed 15m bars + 1 latest confirmed 15m bar (30 bars total) -> prior baseline excluding current bar has 29 samples (< 30 MIN_HISTORY_SAMPLES) -> INSUFFICIENT_HISTORY
      const base15m = Math.round(seed.quoteVolume24h / 96);
      const shortSeries: number[] = [];
      for (let i = 0; i < 29; i++) {
        shortSeries.push(Math.round(base15m * (0.85 + (i % 5) * 0.04)));
      }
      shortSeries.push(base15m);
      map.set(seed.symbol, shortSeries);
      continue;
    }
    // 30 prior confirmed 15m candle quoteVolume samples + 1 latest confirmed 15m candle quoteVolume (31 chronological 15m bars)
    const base15m = Math.round(seed.historicalBaseVolume / 96);
    const latestConfirmed15m = Math.round(seed.quoteVolume24h / 96);
    const series: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Realistic +-24% 15m volume dispersion so MAD / Median is ~14% (stable baseline, realistic 15m Robust Z-Score ~2.0 to 4.2)
      const wave =
        1 + Math.sin(i * 0.85) * 0.22 + ((i % 5) - 2) * 0.06;
      series.push(Math.round(base15m * wave));
    }
    series.push(latestConfirmed15m);
    map.set(seed.symbol, series);
  }
  return map;
}

export class DemoExchangeAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'demo_synthetic';
  public readonly displayName = 'DEMO 模擬資料集 (非即時行情・僅供系統驗證)';
  public readonly enabled = true;
  public readonly isDemo = true;
  public readonly status: ExchangeStatus = 'DEMO_ONLY';

  public async fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const tickers: MarketTicker[] = DEMO_SYMBOLS.map((seed) => {
      const missingData: string[] = [];
      if (seed.fundingRate === null) missingData.push('fundingRate');

      let spread: number | null = null;
      let spreadPercent: number | null = null;
      if (
        seed.bidPrice !== null &&
        seed.askPrice !== null &&
        seed.bidPrice > 0 &&
        seed.askPrice >= seed.bidPrice
      ) {
        spread = Number((seed.askPrice - seed.bidPrice).toPrecision(6));
        const mid = (seed.askPrice + seed.bidPrice) / 2;
        spreadPercent = Number(
          (((seed.askPrice - seed.bidPrice) / mid) * 100).toFixed(5)
        );
      } else {
        missingData.push('BID_ASK_SPREAD');
      }

      return {
        symbol: seed.symbol,
        baseAsset: seed.baseAsset,
        quoteAsset: 'USDT',
        lastPrice: seed.lastPrice,
        priceChangePercent24h: seed.priceChangePercent24h,
        quoteVolume24h: seed.quoteVolume24h,
        latestConfirmed15mQuoteVolume: Math.round(seed.quoteVolume24h / 96),
        bidPrice: seed.bidPrice,
        askPrice: seed.askPrice,
        spread,
        spreadPercent,
        fundingRate: seed.fundingRate,
        nextFundingTime: Date.now() + 3600 * 1000 * 4,
        openInterest: seed.openInterest,
        openInterestValue:
          seed.openInterest !== null ? seed.openInterest * seed.lastPrice : null,
        provenance: {
          source: 'DEMO_SYNTHETIC_DATASET',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData,
          isDemo: true,
          volumeTimeframe: '15m',
          aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
          volumeMetric: 'quoteVolume',
        },
      };
    });

    return {
      tickers,
      provenance: {
        source: 'DEMO_SYNTHETIC_DATASET',
        fetchedAt,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: true,
      },
    };
  }

  public async fetchOpenInterest(
    symbol: string,
    referencePrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const found = DEMO_SYMBOLS.find((s) => s.symbol === symbol);
    const oi = found?.openInterest ?? null;
    const price = referencePrice ?? found?.lastPrice ?? 0;

    return {
      openInterest: oi,
      openInterestValue: oi !== null && price > 0 ? oi * price : null,
      provenance: {
        source: 'DEMO_SYNTHETIC_DATASET',
        fetchedAt,
        stale: false,
        fallback: false,
        missingData: oi === null ? ['openInterest'] : [],
        isDemo: true,
      },
    };
  }

  public async fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit = 100
  ): Promise<{
    klines: Kline[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const seed =
      DEMO_SYMBOLS.find((s) => s.symbol === symbol) || DEMO_SYMBOLS[0];

    const intervalMs = INTERVAL_MS_MAP[timeframe];
    const nowAligned = Math.floor(Date.now() / intervalMs) * intervalMs;

    let mode: 'BULL' | 'BEAR' | 'WATCH_BULL' | 'WATCH_BEAR' | 'RANGE' = 'BULL';
    if (seed.pattern === 'BEAR_SMC') {
      mode = 'BEAR';
    } else if (seed.pattern === 'WATCH_BULL') {
      mode = 'WATCH_BULL';
    } else if (seed.pattern === 'WATCH_BEAR') {
      mode = 'WATCH_BEAR';
    } else if (seed.pattern === 'CONFLICT_WAIT') {
      mode = timeframe === '4h' || timeframe === '1h' ? 'BEAR' : 'BULL';
    } else if (seed.pattern === 'RANGE_WATCH') {
      mode = 'RANGE';
    }

    const klines = generateDeterministicSmcKlines({
      basePrice: seed.lastPrice,
      count: limit,
      intervalMs,
      endOpenTime: nowAligned,
      mode,
    });

    return {
      klines,
      provenance: {
        source: 'DEMO_SYNTHETIC_DATASET',
        fetchedAt,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: true,
      },
    };
  }

  public async fetchHistoricalOpenInterest(
    symbol: string,
    timeframe: Timeframe,
    limit = 150
  ): Promise<{
    series: HistoricalOpenInterestPoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const seed =
      DEMO_SYMBOLS.find((s) => s.symbol === symbol) || DEMO_SYMBOLS[0];
    if (seed.openInterest === null) {
      return {
        series: [],
        provenance: {
          source: 'DEMO_SYNTHETIC_DATASET',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalOpenInterest'],
          isDemo: true,
        },
      };
    }
    const { klines } = await this.fetchKlines(symbol, timeframe, limit);
    const { oiSeries } = generateDeterministicHistoricalOiAndFunding({
      symbol,
      klines,
      baseOpenInterest: seed.openInterest,
      baseFundingRate: seed.fundingRate ?? 0.0001,
      source: 'DEMO_SYNTHETIC_DATASET',
      isDemo: true,
      fetchedAt,
    });
    return {
      series: oiSeries,
      provenance: {
        source: 'DEMO_SYNTHETIC_DATASET',
        fetchedAt,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: true,
      },
    };
  }

  public async fetchHistoricalFundingRates(
    symbol: string,
    limit = 150,
    startTime?: number
  ): Promise<{
    series: HistoricalFundingRatePoint[];
    provenance: DataProvenance;
  }> {
    const fetchedAt = new Date().toISOString();
    const seed =
      DEMO_SYMBOLS.find((s) => s.symbol === symbol) || DEMO_SYMBOLS[0];
    if (seed.fundingRate === null) {
      return {
        series: [],
        provenance: {
          source: 'DEMO_SYNTHETIC_DATASET',
          fetchedAt,
          stale: false,
          fallback: false,
          missingData: ['historicalFundingRate'],
          isDemo: true,
        },
      };
    }
    const intervalMs = 15 * 60 * 1000;
    const nowAligned = Math.floor(Date.now() / intervalMs) * intervalMs;
    const earliestNeeded =
      typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0
        ? startTime - 8 * 3600_000
        : nowAligned - Math.max(limit, 200) * 4 * 3600_000;
    const stepMs = 4 * 3600_000; // 4h funding settlement points
    const count = Math.min(
      1000,
      Math.max(limit, Math.ceil((nowAligned - earliestNeeded) / stepMs) + 4)
    );
    const baseFunding = seed.fundingRate;
    const fundingSeries: HistoricalFundingRatePoint[] = [];
    for (let i = 0; i < count; i++) {
      const ts = nowAligned - (count - 1 - i) * stepMs;
      const frDelta = Math.cos(i * 0.25) * 0.00004;
      fundingSeries.push({
        symbol,
        timestamp: ts,
        fundingRate: Number((baseFunding + frDelta).toFixed(6)),
        fetchedAt,
        source: 'DEMO_SYNTHETIC_DATASET',
        isDemo: true,
      });
    }
    return {
      series: fundingSeries,
      provenance: {
        source: 'DEMO_SYNTHETIC_DATASET',
        fetchedAt,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: true,
      },
    };
  }
}

export function generateDeterministicHistoricalOiAndFunding(params: {
  symbol: string;
  klines: Kline[];
  baseOpenInterest?: number;
  baseOi?: number;
  baseFundingRate?: number;
  source?: string;
  isDemo?: boolean;
  fetchedAt?: string;
}): {
  oiSeries: HistoricalOpenInterestPoint[];
  fundingSeries: HistoricalFundingRatePoint[];
  historicalOpenInterest: HistoricalOpenInterestPoint[];
  historicalFundingRates: HistoricalFundingRatePoint[];
} {
  const {
    symbol,
    klines,
    baseOpenInterest,
    baseOi,
    baseFundingRate = 0.0001,
    source = 'DEMO_SYNTHETIC_DATASET',
    isDemo = true,
    fetchedAt = new Date().toISOString(),
  } = params;
  const resolvedBaseOi = baseOpenInterest ?? baseOi ?? 85_000;

  const oiSeries: HistoricalOpenInterestPoint[] = [];
  const fundingSeries: HistoricalFundingRatePoint[] = [];

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const oiFactor = 1 + Math.sin(i * 0.35) * 0.04;
    const oiVal = Number((resolvedBaseOi * oiFactor).toFixed(3));
    oiSeries.push({
      symbol,
      timestamp: k.openTime,
      openInterest: oiVal,
      openInterestValue: Number((oiVal * k.close).toFixed(2)),
      fetchedAt,
      source,
      isDemo,
    });

    const frDelta = Math.cos(i * 0.25) * 0.00004;
    fundingSeries.push({
      symbol,
      timestamp: k.openTime,
      fundingRate: Number((baseFundingRate + frDelta).toFixed(6)),
      fetchedAt,
      source,
      isDemo,
    });
  }

  return {
    oiSeries,
    fundingSeries,
    historicalOpenInterest: oiSeries,
    historicalFundingRates: fundingSeries,
  };
}

export function generateDeterministicSmcKlines(params: {
  basePrice: number;
  count: number;
  intervalMs: number;
  endOpenTime: number;
  mode: 'BULL' | 'BEAR' | 'WATCH_BULL' | 'WATCH_BEAR' | 'RANGE';
}): Kline[] {
  const { basePrice, count, intervalMs, endOpenTime, mode } = params;
  const klines: Kline[] = [];
  const step = basePrice * 0.004;

  let price =
    mode === 'BULL' || mode === 'WATCH_BULL'
      ? basePrice * 0.92
      : mode === 'BEAR' || mode === 'WATCH_BEAR'
        ? basePrice * 1.08
        : basePrice;

  for (let i = 0; i < count; i++) {
    const openTime = endOpenTime - (count - 1 - i) * intervalMs;
    const isLastUnclosed = i === count - 1;
    const closeTime = isLastUnclosed
      ? openTime + intervalMs + 60_000
      : openTime + intervalMs - 1;

    const relFromEnd = count - 1 - i;

    if (mode === 'RANGE') {
      // Tight consolidation range inside earlier swing bounds -> 0 SMC signals -> deterministic WAIT even when all prior candles are isClosed: true
      const earlyMultiplier = relFromEnd > 14 ? 1.3 : 0.35;
      const offset = Math.sin(i * 0.6) * step * 0.25 * earlyMultiplier;
      const open = basePrice + offset;
      const close = basePrice + Math.sin((i + 1) * 0.6) * step * 0.25 * earlyMultiplier;
      const high = basePrice + step * (relFromEnd > 14 ? 1.4 : 0.45);
      const low = basePrice - step * (relFromEnd > 14 ? 1.4 : 0.45);
      const volume = 12000 + (i % 7) * 2500;
      klines.push({
        openTime,
        open: Number(open.toPrecision(6)),
        high: Number(Math.max(open, close, high).toPrecision(6)),
        low: Number(Math.min(open, close, low).toPrecision(6)),
        close: Number(close.toPrecision(6)),
        volume,
        closeTime,
        quoteVolume: Number((volume * close).toFixed(2)),
        isClosed: !isLastUnclosed,
      });
      continue;
    }

    if (mode === 'WATCH_BULL' || mode === 'WATCH_BEAR') {
      // Gradual trend with 5-bar fractal swing point at relFromEnd=9, 2-bar pullback at relFromEnd=8..7, and BOS breakout at relFromEnd=3..1,
      // with small wicks (step * 0.12 < delta) so advancing bars never trigger false opposing wick-sweeps and bodyToAtrRatio (~0.65) stays < 1.3 -> deterministic WATCH
      const dirSign = mode === 'WATCH_BULL' ? 1 : -1;
      const open = price;
      let delta = dirSign * step * 0.42;
      if (relFromEnd === 9) {
        delta = dirSign * step * 0.65;
      } else if (relFromEnd === 8 || relFromEnd === 7) {
        delta = -dirSign * step * 0.55;
      } else if (relFromEnd <= 6 && relFromEnd >= 1) {
        delta = dirSign * step * 0.48;
      }
      const close = open + delta;
      const high = Math.max(open, close) + step * 0.12;
      const low = Math.min(open, close) - step * 0.12;
      price = close;
      const volume = 12000 + (i % 7) * 2500;
      klines.push({
        openTime,
        open: Number(open.toPrecision(6)),
        high: Number(high.toPrecision(6)),
        low: Number(low.toPrecision(6)),
        close: Number(close.toPrecision(6)),
        volume,
        closeTime,
        quoteVolume: Number((volume * close).toFixed(2)),
        isClosed: !isLastUnclosed,
      });
      continue;
    }

    const wave = Math.sin(i * 0.45) * step * 1.1;
    const trendDrift = mode === 'BULL' ? step * 0.14 : -step * 0.14;

    let open = price;
    let close = open + trendDrift + wave * 0.35;
    let high = Math.max(open, close) + step * 0.6;
    let low = Math.min(open, close) - step * 0.6;

    if (mode === 'BULL') {
      if (relFromEnd === 9) {
        open = price;
        close = price - step * 1.2;
        low = close - step * 0.9;
        high = open + step * 0.3;
      } else if (relFromEnd === 6) {
        open = price;
        close = price + step * 1.4;
        high = close + step * 0.8;
        low = open - step * 0.3;
      } else if (relFromEnd === 4) {
        // Guaranteed Sell-Side Liquidity Sweep: wick pierces prior 12-bar low while body closes above it, and acts as opposing bearish Order Block candle
        const prior12Low =
          klines.length > 0
            ? Math.min(...klines.slice(-12).map((k) => k.low))
            : price - step * 2.4;
        open = Math.max(price, prior12Low + step * 0.6);
        close = Math.max(open - step * 0.25, prior12Low + step * 0.25);
        low = prior12Low - step * 0.65;
        high = open + step * 0.25;
      } else if (relFromEnd === 3) {
        open = price;
        close = open + step * 2.8;
        low = open - step * 0.1;
        high = close + step * 0.15;
      } else if (relFromEnd === 2) {
        open = price;
        close = open + step * 3.4;
        low = open + step * 0.25;
        high = close + step * 0.3;
      } else if (relFromEnd === 1) {
        open = price;
        close = open + step * 0.5;
        low = open - step * 0.2;
        high = close + step * 0.4;
      }
    } else if (mode === 'BEAR') {
      if (relFromEnd === 9) {
        open = price;
        close = price + step * 1.2;
        high = close + step * 0.9;
        low = open - step * 0.3;
      } else if (relFromEnd === 6) {
        open = price;
        close = price - step * 1.4;
        low = close - step * 0.8;
        high = open + step * 0.3;
      } else if (relFromEnd === 4) {
        // Guaranteed Buy-Side Liquidity Sweep: wick pierces prior 12-bar high while body closes below it, and acts as opposing bullish Order Block candle
        const prior12High =
          klines.length > 0
            ? Math.max(...klines.slice(-12).map((k) => k.high))
            : price + step * 2.4;
        open = Math.min(price, prior12High - step * 0.6);
        close = Math.min(open + step * 0.25, prior12High - step * 0.25);
        high = prior12High + step * 0.65;
        low = open - step * 0.25;
      } else if (relFromEnd === 3) {
        open = price;
        close = open - step * 2.8;
        high = open + step * 0.1;
        low = close - step * 0.15;
      } else if (relFromEnd === 2) {
        open = price;
        close = open - step * 3.4;
        high = open - step * 0.25;
        low = close - step * 0.3;
      } else if (relFromEnd === 1) {
        open = price;
        close = open - step * 0.5;
        high = open + step * 0.2;
        low = close - step * 0.4;
      }
    }

    price = close;
    const volume = 12000 + (i % 7) * 2500 + (relFromEnd <= 4 ? 18000 : 0);

    klines.push({
      openTime,
      open: Number(open.toPrecision(6)),
      high: Number(Math.max(open, close, high).toPrecision(6)),
      low: Number(Math.min(open, close, low).toPrecision(6)),
      close: Number(close.toPrecision(6)),
      volume,
      closeTime,
      quoteVolume: Number((volume * close).toFixed(2)),
      isClosed: !isLastUnclosed,
    });
  }

  return klines;
}
