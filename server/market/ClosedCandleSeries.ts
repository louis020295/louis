import { DataProvenance, Kline, Timeframe } from '../../src/types/market.ts';

/**
 * Shared kline fetch + closed-candle rule used by the live scanner and backtests.
 *
 * Binance USD-M `/fapi/v1/klines` weight (limit):
 *   <100 → 1, [100,500) → 2, [500,1000] → 5, >1000 → 10.
 * Pages stay at or below 1000 so a request never takes the >1000 weight tier.
 * History beyond one page is walked with `endTime = oldestOpenTime - 1`.
 */

export const KLINE_PAGE_SIZE = 1000;
/** Raised safety ceiling. The previous backtest cap was 1000. */
export const MAX_CLOSED_CANDLE_BARS = 10_000;

export interface KlineFetchWindow {
  startTime?: number;
  endTime?: number;
}

export interface KlinePageQuery {
  symbol: string;
  timeframe: Timeframe;
  limit: number;
  window?: KlineFetchWindow;
}

export interface KlinePageResult {
  klines: Kline[];
  provenance: DataProvenance;
}

export interface ClosedCandleSeries {
  /** Closed candles only, oldest → newest, at most `barCount`. */
  klines: Kline[];
  /** Forming candles that were dropped from `klines` (usually the last bar). */
  forming: Kline[];
  provenance: DataProvenance;
  pages: number;
  weightUsed: number;
  truncated: boolean;
}

export interface KlineWeightPaceOptions {
  maxWeightPerWindow: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ledger?: Array<{ at: number; weight: number }>;
}

const moduleWeightLedger: Array<{ at: number; weight: number }> = [];

export function resetKlineWeightLedger(): void {
  moduleWeightLedger.length = 0;
}

/** Binance USD-M kline request weight for a given limit. */
export function binanceKlineRequestWeight(limit: number): number {
  const n = Math.max(1, Math.floor(limit));
  if (n < 100) return 1;
  if (n < 500) return 2;
  if (n <= 1000) return 5;
  return 10;
}

/**
 * Closed-candle predicate shared by the live scanner and BacktestEngine.
 * A bar counts only when the source marked `isClosed === true`.
 */
export function selectClosedCandles<T extends { isClosed?: boolean }>(
  klines: T[] | null | undefined
): T[] {
  if (!klines || klines.length === 0) return [];
  return klines.filter((k) => k != null && k.isClosed === true);
}

export function clampBacktestBarCount(
  requested: number | undefined,
  fallback = 120,
  min = 45
): number {
  const raw =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.floor(requested)
      : fallback;
  return Math.min(MAX_CLOSED_CANDLE_BARS, Math.max(min, raw));
}

export async function paceKlineRequestWeight(
  weight: number,
  opts: KlineWeightPaceOptions
): Promise<void> {
  const ledger = opts.ledger ?? moduleWeightLedger;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const max = Math.max(1, opts.maxWeightPerWindow);
  const windowMs = Math.max(1, opts.windowMs);
  for (let guard = 0; guard < 8; guard++) {
    const t = now();
    while (ledger.length > 0 && t - ledger[0].at >= windowMs) ledger.shift();
    const used = ledger.reduce((sum, event) => sum + event.weight, 0);
    if (used + weight <= max) {
      ledger.push({ at: t, weight });
      return;
    }
    const wait = Math.max(1, windowMs - (t - ledger[0].at));
    await sleep(wait);
  }
  ledger.push({ at: now(), weight });
}

function emptyProvenance(): DataProvenance {
  return {
    source: 'kline-series',
    fetchedAt: new Date().toISOString(),
    stale: false,
    fallback: false,
    missingData: ['klines'],
    isDemo: false,
  };
}

export async function fetchClosedCandleSeries(params: {
  symbol: string;
  timeframe: Timeframe;
  barCount: number;
  fetchPage: (query: KlinePageQuery) => Promise<KlinePageResult>;
  /**
   * Scanner incremental fetches pass the exact limit they used before,
   * and do not walk history (one request).
   */
  exactRequestLimit?: number;
  pageSize?: number;
  maxPages?: number;
  rateLimit?: KlineWeightPaceOptions & { enforce?: boolean };
}): Promise<ClosedCandleSeries> {
  const target = Math.min(
    MAX_CLOSED_CANDLE_BARS,
    Math.max(1, Math.floor(params.barCount))
  );
  const pageSize = Math.min(
    KLINE_PAGE_SIZE,
    Math.max(1, Math.floor(params.pageSize ?? KLINE_PAGE_SIZE))
  );
  const singleShot =
    typeof params.exactRequestLimit === 'number' &&
    params.exactRequestLimit > 0 &&
    target <= pageSize;
  const maxPages =
    params.maxPages ??
    (singleShot ? 1 : Math.ceil(target / pageSize) + 3);

  const byOpen = new Map<number, Kline>();
  let pages = 0;
  let weightUsed = 0;
  let endTime: number | undefined;
  let provenance: DataProvenance | null = null;

  while (pages < maxPages) {
    const closedSoFar = selectClosedCandles([...byOpen.values()]).length;
    if (!singleShot && closedSoFar >= target) break;

    const remaining = Math.max(1, target - closedSoFar);
    let limit: number;
    if (singleShot && pages === 0) {
      limit = Math.min(pageSize, Math.floor(params.exactRequestLimit!));
    } else if (pages === 0) {
      limit = Math.min(pageSize, remaining + 1);
    } else {
      limit = Math.min(pageSize, Math.max(remaining, 1));
    }
    const weight = binanceKlineRequestWeight(limit);
    if (params.rateLimit?.enforce) {
      await paceKlineRequestWeight(weight, params.rateLimit);
    }
    weightUsed += weight;

    const page = await params.fetchPage({
      symbol: params.symbol,
      timeframe: params.timeframe,
      limit,
      window: endTime !== undefined ? { endTime } : undefined,
    });
    pages += 1;
    provenance = page.provenance ?? provenance;

    const rows = Array.isArray(page.klines) ? page.klines : [];
    if (rows.length === 0) break;

    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;
    for (const row of rows) {
      if (!row || !Number.isFinite(row.openTime)) continue;
      if (row.openTime < oldest) oldest = row.openTime;
      if (!byOpen.has(row.openTime)) {
        byOpen.set(row.openTime, row);
        added += 1;
      }
    }
    if (!Number.isFinite(oldest)) break;

    const pageFull = rows.length >= limit;
    if (singleShot || !pageFull || added === 0) break;

    const nextEnd = oldest - 1;
    if (endTime !== undefined && nextEnd >= endTime) break;
    endTime = nextEnd;
  }

  const all = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  const closed = selectClosedCandles(all);
  const truncated = closed.length > target;
  const sliced = truncated ? closed.slice(closed.length - target) : closed;
  const lastClosedOpen = sliced.length > 0 ? sliced[sliced.length - 1].openTime : Number.NEGATIVE_INFINITY;
  const forming = all.filter((k) => k.isClosed !== true && k.openTime >= lastClosedOpen);

  return {
    klines: sliced,
    forming,
    provenance: provenance ?? emptyProvenance(),
    pages,
    weightUsed,
    truncated,
  };
}
