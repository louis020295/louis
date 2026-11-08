export class ExchangeApiUnavailableError extends Error {
  public readonly source: string;
  public readonly statusCode?: number;
  public readonly attempts: number;
  public readonly isTimeout: boolean;
  public readonly isRateLimited: boolean;

  constructor(
    message: string,
    source: string,
    options: {
      statusCode?: number;
      attempts?: number;
      isTimeout?: boolean;
      isRateLimited?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'ExchangeApiUnavailableError';
    this.source = source;
    this.statusCode = options.statusCode;
    this.attempts = options.attempts ?? 1;
    this.isTimeout = options.isTimeout ?? false;
    this.isRateLimited = options.isRateLimited ?? false;
  }
}

export class OutboundRateLimiter {
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(options: { maxRequestsPerWindow?: number; windowMs?: number } = {}) {
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 60;
    this.windowMs = options.windowMs ?? 10_000;
  }

  public tryAcquire(nowMs = Date.now()): {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
  } {
    this.timestamps = this.timestamps.filter((t) => nowMs - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequestsPerWindow) {
      const oldest = this.timestamps[0];
      const retryAfterMs = Math.max(10, this.windowMs - (nowMs - oldest));
      return {
        allowed: false,
        retryAfterMs,
        remaining: 0,
      };
    }

    this.timestamps.push(nowMs);
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: this.maxRequestsPerWindow - this.timestamps.length,
    };
  }

  public reset(): void {
    this.timestamps = [];
  }
}

export interface ResilientFetchOptions {
  endpoints: string[];
  path: string;
  timeoutMs?: number;
  maxRetriesPerEndpoint?: number;
  baseRetryDelayMs?: number;
  rateLimiter?: OutboundRateLimiter;
  customFetch?: typeof fetch;
  exchangeLabel?: string;
}

export interface ResilientFetchResult<T> {
  data: T;
  endpointUsed: string;
  usedFallbackEndpoint: boolean;
  attemptsMade: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithResilience<T>(
  options: ResilientFetchOptions
): Promise<ResilientFetchResult<T>> {
  const {
    endpoints,
    path,
    timeoutMs = 7000,
    maxRetriesPerEndpoint = 2,
    baseRetryDelayMs = 120,
    rateLimiter,
    customFetch = globalThis.fetch,
    exchangeLabel = 'Exchange REST API',
  } = options;

  if (rateLimiter) {
    const check = rateLimiter.tryAcquire();
    if (!check.allowed) {
      throw new ExchangeApiUnavailableError(
        `${exchangeLabel} 觸發本地端 Rate Limit 保護 (請於 ${check.retryAfterMs}ms 後重試)`,
        `${exchangeLabel} (${endpoints[0] || ''})`,
        {
          statusCode: 429,
          attempts: 0,
          isRateLimited: true,
        }
      );
    }
  }

  let totalAttempts = 0;
  let lastError: Error | null = null;
  let lastStatusCode: number | undefined;
  let sawTimeout = false;
  let sawRateLimit = false;

  for (let endpointIdx = 0; endpointIdx < endpoints.length; endpointIdx++) {
    const base = endpoints[endpointIdx].replace(/\/$/, '');
    const url = `${base}${path}`;

    for (let retry = 0; retry <= maxRetriesPerEndpoint; retry++) {
      totalAttempts++;
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

        if (res.status === 429 || res.status === 418) {
          sawRateLimit = true;
          lastStatusCode = res.status;
          const retryAfterHeader = Number(res.headers?.get?.('retry-after'));
          const waitMs =
            Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
              ? Math.min(retryAfterHeader * 1000, 1000)
              : baseRetryDelayMs * Math.pow(2, retry);

          if (retry < maxRetriesPerEndpoint) {
            await sleep(waitMs);
            continue;
          }

          throw new ExchangeApiUnavailableError(
            `${exchangeLabel} HTTP ${res.status} Rate Limit Exceeded`,
            base,
            {
              statusCode: res.status,
              attempts: totalAttempts,
              isRateLimited: true,
            }
          );
        }

        if (!res.ok) {
          lastStatusCode = res.status;
          const text = await res.text().catch(() => '');
          const isTransientServerError = res.status >= 500;

          if (isTransientServerError && retry < maxRetriesPerEndpoint) {
            await sleep(baseRetryDelayMs * Math.pow(2, retry));
            continue;
          }

          throw new ExchangeApiUnavailableError(
            `${exchangeLabel} HTTP ${res.status}: ${text.slice(0, 140) || res.statusText}`,
            base,
            {
              statusCode: res.status,
              attempts: totalAttempts,
            }
          );
        }

        const data = (await res.json()) as T;
        return {
          data,
          endpointUsed: base,
          usedFallbackEndpoint: endpointIdx > 0,
          attemptsMade: totalAttempts,
        };
      } catch (err) {
        clearTimeout(timer);

        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.message.toLowerCase().includes('abort') ||
            err.message.toLowerCase().includes('timeout'));

        if (isAbort) {
          sawTimeout = true;
          lastError = new ExchangeApiUnavailableError(
            `${exchangeLabel} 連線逾時 (Timeout > ${timeoutMs}ms)`,
            base,
            {
              attempts: totalAttempts,
              isTimeout: true,
            }
          );
        } else if (err instanceof ExchangeApiUnavailableError) {
          lastError = err;
        } else {
          lastError = new Error(
            err instanceof Error
              ? err.message
              : `Network disconnect connecting to ${exchangeLabel}`
          );
        }

        if (retry < maxRetriesPerEndpoint) {
          await sleep(baseRetryDelayMs * Math.pow(2, retry));
          continue;
        }
      }
    }
  }

  throw new ExchangeApiUnavailableError(
    lastError?.message || `${exchangeLabel} 無法連線`,
    `${exchangeLabel} (${endpoints[0] || ''})`,
    {
      statusCode: lastStatusCode,
      attempts: totalAttempts,
      isTimeout: sawTimeout,
      isRateLimited: sawRateLimit,
    }
  );
}
