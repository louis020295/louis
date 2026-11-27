/**
 * Per-symbol perpetual funding interval.
 * Binance publishes this on GET /fapi/v1/fundingInfo (`fundingIntervalHours`).
 * Symbols omitted by that payload, or a failed fetch with no settlement history,
 * fall back to 8h and are flagged.
 */

export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;
export const FUNDING_INFO_TTL_MS = 60 * 60 * 1000;
const FUNDING_INFO_FAILURE_TTL_MS = 60 * 1000;
const OBSERVED_TTL_MS = 15 * 60 * 1000;
const KNOWN_INTERVAL_HOURS = [1, 2, 4, 8];

export type FundingIntervalSource = 'exchange' | 'observed_settlements' | 'fallback';

export interface FundingIntervalResolution {
  symbol: string;
  fundingIntervalHours: number;
  source: FundingIntervalSource;
  /** True only when 8h was assumed because no interval was available. */
  fallback: boolean;
  fetchedAtMs: number | null;
  noteZh: string;
}

interface ExchangeMapCache {
  fetchedAtMs: number;
  bySymbol: Map<string, number>;
  ok: boolean;
}

interface SymbolCacheEntry {
  expiresAtMs: number;
  record: FundingIntervalResolution;
}

let exchangeMapCache: ExchangeMapCache | null = null;
const symbolCache = new Map<string, SymbolCacheEntry>();

export function resetFundingIntervalCache(): void {
  exchangeMapCache = null;
  symbolCache.clear();
}

export function sanitizeFundingIntervalHours(hours: number | null | undefined): number {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_FUNDING_INTERVAL_HOURS;
  }
  return hours;
}

/** Annualized percent. 8h → rate × 3 × 365 × 100. 4h → rate × 6 × 365 × 100. */
export function annualizedFundingPercent(rate: number, intervalHours: number): number {
  const hours = sanitizeFundingIntervalHours(intervalHours);
  const periodsPerDay = 24 / hours;
  return rate * periodsPerDay * 365 * 100;
}

/** How many funding settlements a hold spans. 8h at an 8h interval is 1. */
export function fundingPeriodsForHold(holdingMs: number, intervalHours: number): number {
  const hours = sanitizeFundingIntervalHours(intervalHours);
  return Math.max(0, holdingMs) / (hours * 3_600_000);
}

/**
 * Infer a settlement interval from historical funding timestamps.
 * Accepts a stable 1h / 2h / 4h / 8h cadence only.
 */
export function inferFundingIntervalHours(timestamps: number[] | null | undefined): number | null {
  if (!timestamps || timestamps.length < 3) return null;
  const sorted = [...timestamps].filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const hours = (sorted[i] - sorted[i - 1]) / 3_600_000;
    if (hours >= 0.5 && hours <= 12) gaps.push(hours);
  }
  if (gaps.length < 2) return null;
  const ordered = [...gaps].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  let nearest = KNOWN_INTERVAL_HOURS[0];
  for (const candidate of KNOWN_INTERVAL_HOURS) {
    if (Math.abs(candidate - median) < Math.abs(nearest - median)) nearest = candidate;
  }
  if (Math.abs(nearest - median) > 0.35) return null;
  const close = gaps.filter((gap) => Math.abs(gap - nearest) <= 0.5).length;
  if (close / gaps.length < 0.8) return null;
  return nearest;
}

export function rememberExchangeFundingMap(
  bySymbol: Map<string, number> | Record<string, number> | null | undefined,
  nowMs = Date.now(),
  ok = true
): void {
  const map = new Map<string, number>();
  if (bySymbol instanceof Map) {
    for (const [symbol, hours] of bySymbol) {
      const parsed = Number(hours);
      if (symbol && Number.isFinite(parsed) && parsed > 0) {
        map.set(symbol.toUpperCase(), parsed);
      }
    }
  } else if (bySymbol) {
    for (const [symbol, hours] of Object.entries(bySymbol)) {
      const parsed = Number(hours);
      if (symbol && Number.isFinite(parsed) && parsed > 0) {
        map.set(symbol.toUpperCase(), parsed);
      }
    }
  }
  exchangeMapCache = { fetchedAtMs: nowMs, bySymbol: map, ok };
}

export async function ensureExchangeFundingMap(
  loader: () => Promise<Record<string, number> | Map<string, number> | null>,
  nowMs = Date.now()
): Promise<void> {
  if (exchangeMapCache) {
    const age = nowMs - exchangeMapCache.fetchedAtMs;
    const ttl = exchangeMapCache.ok ? FUNDING_INFO_TTL_MS : FUNDING_INFO_FAILURE_TTL_MS;
    if (age >= 0 && age < ttl) return;
  }
  try {
    const loaded = await loader();
    if (!loaded) {
      exchangeMapCache = {
        fetchedAtMs: nowMs,
        bySymbol: new Map(),
        ok: false,
      };
      return;
    }
    rememberExchangeFundingMap(loaded, nowMs, true);
  } catch {
    exchangeMapCache = {
      fetchedAtMs: nowMs,
      bySymbol: exchangeMapCache?.bySymbol ?? new Map(),
      ok: false,
    };
  }
}

function storeSymbol(
  symbol: string,
  record: FundingIntervalResolution,
  nowMs: number,
  ttlMs: number
): FundingIntervalResolution {
  symbolCache.set(symbol, { expiresAtMs: nowMs + ttlMs, record });
  return record;
}

export function resolveFundingInterval(params: {
  symbol: string;
  seriesTimestamps?: number[] | null;
  nowMs?: number;
}): FundingIntervalResolution {
  const symbol = params.symbol.trim().toUpperCase();
  const nowMs = params.nowMs ?? Date.now();
  const mapFresh =
    exchangeMapCache !== null &&
    exchangeMapCache.ok &&
    nowMs - exchangeMapCache.fetchedAtMs < FUNDING_INFO_TTL_MS &&
    nowMs - exchangeMapCache.fetchedAtMs >= 0;

  if (mapFresh) {
    const hours = exchangeMapCache!.bySymbol.get(symbol);
    if (hours && hours > 0) {
      return storeSymbol(
        symbol,
        {
          symbol,
          fundingIntervalHours: hours,
          source: 'exchange',
          fallback: false,
          fetchedAtMs: exchangeMapCache!.fetchedAtMs,
          noteZh: `交易所 fundingInfo：每 ${hours} 小時結算`,
        },
        nowMs,
        FUNDING_INFO_TTL_MS
      );
    }
  }

  const cached = symbolCache.get(symbol);
  if (cached && cached.expiresAtMs > nowMs && cached.record.source !== 'fallback') {
    return cached.record;
  }

  const inferred = inferFundingIntervalHours(params.seriesTimestamps);
  if (inferred !== null) {
    return storeSymbol(
      symbol,
      {
        symbol,
        fundingIntervalHours: inferred,
        source: 'observed_settlements',
        fallback: false,
        fetchedAtMs: nowMs,
        noteZh: `依歷史資金費結算時間距推得每 ${inferred} 小時結算`,
      },
      nowMs,
      OBSERVED_TTL_MS
    );
  }

  const noteZh = mapFresh
    ? 'fundingInfo 未提供此交易對結算週期，暫以 8 小時結算（已標記 fallback）'
    : '無法取得 fundingInfo，暫以 8 小時結算（已標記 fallback）';
  return storeSymbol(
    symbol,
    {
      symbol,
      fundingIntervalHours: DEFAULT_FUNDING_INTERVAL_HOURS,
      source: 'fallback',
      fallback: true,
      fetchedAtMs: mapFresh ? exchangeMapCache!.fetchedAtMs : null,
      noteZh,
    },
    nowMs,
    FUNDING_INFO_FAILURE_TTL_MS
  );
}

export function getCachedFundingInterval(
  symbol: string,
  nowMs = Date.now()
): FundingIntervalResolution | null {
  const cached = symbolCache.get(symbol.trim().toUpperCase());
  if (!cached || cached.expiresAtMs <= nowMs) return null;
  return cached.record;
}
