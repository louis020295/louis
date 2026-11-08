import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server.ts';
import {
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import {
  NotificationGuardEngine,
  TelegramNotificationAdapter,
} from '../server/adapters/NotificationAdapter.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function buildLiveTickers(count = 60, anchorMs = Date.now()): MarketTicker[] {
  const tickers: MarketTicker[] = [];
  const prov: DataProvenance = {
    source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
    fetchedAt: new Date(anchorMs).toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
  const named = [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'ATOMUSDT',
    'SUIUSDT',
    'QUSDT',
  ];
  for (let i = 0; i < count; i++) {
    const symbol =
      i < named.length
        ? named[i]
        : `SYM${String(i).padStart(3, '0')}USDT`;
    const price = symbol === 'ATOMUSDT' ? 1.622 : 100 + i;
    tickers.push({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      lastPrice: price,
      bidPrice: Number((price * 0.9999).toFixed(4)),
      askPrice: Number((price * 1.0001).toFixed(4)),
      spreadPercent: 0.02,
      priceChangePercent24h:
        symbol === 'BTCUSDT'
          ? 1.5
          : symbol === 'ATOMUSDT'
            ? 9.2
            : i < 10
              ? 8.4
              : i < 20
                ? -7.1
                : 0.6,
      quoteVolume24h: i < 25 ? 160_000_000 : 28_000_000,
      fundingRate: 0.0001,
      nextFundingTime: anchorMs + 3600_000,
      openInterest: 500_000,
      openInterestValue: 50_000_000,
      provenance: prov,
    });
  }
  return tickers;
}

function buildAnchoredKlines(
  timeframe: Timeframe,
  anchorBarCloseMs: number,
  options?: {
    bullishCandidate?: boolean;
    includeOpenNextBar?: boolean;
    nextBarOpenPrice?: number;
  }
): Kline[] {
  const stepMs =
    timeframe === '5m'
      ? 300_000
      : timeframe === '15m'
        ? 900_000
        : timeframe === '1h'
          ? 3_600_000
          : 14_400_000;
  const bars: Kline[] = [];
  let price = 100;

  for (let i = 60; i >= 1; i--) {
    const closeTime = anchorBarCloseMs - (i - 1) * stepMs;
    const openTime = closeTime - stepMs + 1;
    let open = price;
    let close = price + (i % 2 === 0 ? 0.35 : -0.3);
    let high = Math.max(open, close) + 0.25;
    let low = Math.min(open, close) - 0.25;
    let quoteVolume = 1_500_000;

    if (options?.bullishCandidate) {
      if (i === 5) {
        open = price;
        low = price - 4.8;
        close = price + 0.9;
        high = close + 0.4;
        quoteVolume = 4_800_000;
      } else if (i === 4) {
        open = price;
        close = price + 3.4;
        high = close + 0.3;
        low = open - 0.1;
        quoteVolume = 6_800_000;
      } else if (i === 3) {
        open = price;
        close = price + 6.8;
        high = close + 0.5;
        low = open + 1.4;
        quoteVolume = 9_800_000;
      } else if (i <= 2) {
        open = price;
        close = price - 2.6;
        high = open + 0.2;
        low = close - 0.3;
        quoteVolume = 5_400_000;
      }
    }

    bars.push({
      openTime,
      closeTime,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Number((quoteVolume / price).toFixed(2)),
      quoteVolume,
      isClosed: true,
    });
    price = close;
  }

  if (options?.includeOpenNextBar) {
    const nextOpenTime = anchorBarCloseMs + 1;
    const nextOpen = options.nextBarOpenPrice ?? Number((price + 0.05).toFixed(4));
    bars.push({
      openTime: nextOpenTime,
      closeTime: nextOpenTime + stepMs - 1,
      open: nextOpen,
      high: Number((nextOpen + 0.6).toFixed(4)),
      low: Number((nextOpen - 0.2).toFixed(4)),
      close: Number((nextOpen + 0.3).toFixed(4)),
      volume: 15_000,
      quoteVolume: 1_500_000,
      isClosed: false,
    });
  }

  return bars;
}

class Phase8MockExchangeAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly displayName = 'Binance USDⓈ-M Futures (Phase 8 Test)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status = 'LIVE' as const;

  public klineFetchCountsByTf: Record<Timeframe, number> = {
    '5m': 0,
    '15m': 0,
    '1h': 0,
    '4h': 0,
  };
  public oiFetchCount = 0;
  public anchorBarCloseMs = Date.now() - 10_000;
  public fail429Symbol: string | null = null;
  public fail429Remaining = 0;
  public fail503All = false;
  public forceStaleProvenance = false;
  public bullishSymbols = new Set<string>(['ATOMUSDT', 'SOLUSDT']);

  async fetchMarketSnapshot() {
    if (this.fail503All) {
      throw new ExchangeApiUnavailableError(
        'Binance Futures REST API HTTP 503 Service Unavailable',
        this.displayName,
        503
      );
    }
    const tickers = buildLiveTickers(60, Date.now());
    return {
      tickers,
      provenance: {
        source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
        fetchedAt: new Date().toISOString(),
        stale: this.forceStaleProvenance,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchKlines(symbol: string, timeframe: Timeframe, _limit = 60) {
    if (this.fail503All) {
      throw new ExchangeApiUnavailableError(
        `HTTP 503 Service Unavailable on ${symbol} ${timeframe}`,
        this.displayName,
        503
      );
    }
    if (this.fail429Symbol === symbol && this.fail429Remaining > 0) {
      this.fail429Remaining--;
      throw new ExchangeApiUnavailableError(
        `HTTP 429 Too Many Requests on ${symbol} ${timeframe}`,
        this.displayName,
        429,
        { isRateLimited: true }
      );
    }
    this.klineFetchCountsByTf[timeframe]++;
    const isBullish = this.bullishSymbols.has(symbol);
    return {
      klines: buildAnchoredKlines(timeframe, this.anchorBarCloseMs, {
        bullishCandidate: isBullish,
      }),
      provenance: {
        source: `Binance USDⓈ-M Futures REST (/fapi/v1/klines ${symbol} ${timeframe})`,
        fetchedAt: new Date().toISOString(),
        stale: this.forceStaleProvenance,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchOpenInterest(symbol: string, referencePrice = 100) {
    if (this.fail503All) {
      throw new ExchangeApiUnavailableError(
        `HTTP 503 Service Unavailable on OI ${symbol}`,
        this.displayName,
        503
      );
    }
    this.oiFetchCount++;
    return {
      openInterest: 550_000,
      openInterestValue: 550_000 * referencePrice,
      provenance: {
        source: `Binance USDⓈ-M Futures REST (/fapi/v1/openInterest ${symbol})`,
        fetchedAt: new Date().toISOString(),
        stale: this.forceStaleProvenance,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }
}

describe('Phase 8: SMC Candidate Detection Latency Optimization & Fast Lane Verification', () => {
  it('Tests 1, 2 & 3: Priority symbol completes SMC ahead of full market radar queue, is not delayed by general queue, and deduplicates priority queue entries', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-t123-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new RadarDatabase(dbPath);
    const mockAdapter = new Phase8MockExchangeAdapter();
    const adapters: Record<ExchangeId, ExchangeAdapter> = {
      binance_usdm: mockAdapter,
      bybit_linear: mockAdapter,
      bingx_swap: mockAdapter,
      demo_synthetic: mockAdapter,
    };

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: {
        maxJobConcurrency: 2,
        maxHttpConcurrency: 8,
        maxRequestsPerMinute: 1200,
        batchSize: 10,
      },
    });

    const snap = await mockAdapter.fetchMarketSnapshot();
    const preScan = runMarketScan(snap.tickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      historicalVolumeMap: new Map(),
    });

    // Enqueue 60 contracts; general symbols are in Tier 4/5/6
    const enqRes = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap.tickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      radarScanDurationMs: 185,
    });
    assert.equal(enqRes.enqueuedCount, 60);
    assert.ok(enqRes.fastLaneEnqueuedCount > 0);

    // Trigger Fast Lane for ATOMUSDT while 60 contracts are still in queue
    const fastRes = await service.priorityRefreshSymbol({
      symbol: 'ATOMUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
    });

    // 1. Before full market queue finishes, ATOMUSDT has already completed SMC
    assert.ok(fastRes.result, 'ATOMUSDT must complete SMC immediately via Fast Lane');
    assert.equal(fastRes.result.smcEvaluationStatus, 'EVALUATED');
    assert.ok(fastRes.status.queuedCount > 50, 'Most of the general queue is still queued');

    // 2. Verify ATOMUSDT was not delayed by general queue (queueWaitMs is tiny & latency telemetry is recorded)
    assert.ok(
      typeof fastRes.result.queueEnteredAt === 'string' &&
        fastRes.result.queueEnteredAt.length > 0
    );
    assert.ok(
      typeof fastRes.result.smcEvaluationStartedAt === 'string' &&
        fastRes.result.smcEvaluationStartedAt.length > 0
    );
    assert.ok(
      typeof fastRes.result.smcEvaluationCompletedAt === 'string' &&
        fastRes.result.smcEvaluationCompletedAt.length > 0
    );
    assert.ok(
      typeof fastRes.result.detectionLatencyMs === 'number' &&
        fastRes.result.detectionLatencyMs >= 0 &&
        fastRes.result.detectionLatencyMs < 60_000,
      `Expected detectionLatencyMs < 60000ms, got ${fastRes.result.detectionLatencyMs}`
    );

    // 3. Test deduplication: Enqueueing a symbol into Fast Lane twice without execution does not create duplicate priority queue jobs
    const symDedupe = 'SYM045USDT';
    const firstQueueOnly = await service.priorityRefreshSymbol({
      symbol: symDedupe,
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: false,
    });
    assert.equal(firstQueueOnly.deduplicated, false);

    const secondQueueOnly = await service.priorityRefreshSymbol({
      symbol: symDedupe,
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: false,
    });
    assert.equal(
      secondQueueOnly.deduplicated,
      true,
      'Duplicate priority-refresh for already fast-lane queued symbol must be deduplicated'
    );

    const jobsForSym = db
      .listSmcScanJobs('binance_usdm', 200)
      .filter((j) => j.symbol === symDedupe);
    assert.equal(jobsForSym.length, 1, 'Must only have 1 job row in smc_scan_jobs');

    db.close();
  });

  it('Tests 4, 5 & 8: Timeframe cache reuses within TTL, refreshes 15m only when new 15m bar forms, and never treats stale cache as fresh live data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-t458-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new RadarDatabase(dbPath);
    const mockAdapter = new Phase8MockExchangeAdapter();
    const nowMs = Date.now();
    // Anchor last closed 15m bar closeTime to 2 minutes ago (next 15m bar closes in 13 minutes)
    mockAdapter.anchorBarCloseMs = nowMs - 2 * 60_000;

    const adapters: Record<ExchangeId, ExchangeAdapter> = {
      binance_usdm: mockAdapter,
      bybit_linear: mockAdapter,
      bingx_swap: mockAdapter,
      demo_synthetic: mockAdapter,
    };

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: {
        maxJobConcurrency: 2,
        maxHttpConcurrency: 8,
        cacheTtlMsByTimeframe: {
          '5m': 3 * 60 * 1000,
          '15m': 10 * 60 * 1000,
          '1h': 30 * 60 * 1000,
          '4h': 60 * 60 * 1000,
        },
        oiCacheTtlMs: 5 * 60 * 1000,
      },
    });

    // First evaluation of BTCUSDT fetches 5m, 15m, 1h, 4h, and OI
    await service.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });

    assert.equal(mockAdapter.klineFetchCountsByTf['5m'], 1);
    assert.equal(mockAdapter.klineFetchCountsByTf['15m'], 1);
    assert.equal(mockAdapter.klineFetchCountsByTf['1h'], 1);
    assert.equal(mockAdapter.klineFetchCountsByTf['4h'], 1);
    assert.equal(mockAdapter.oiFetchCount, 1);

    // 5. Evaluate BTCUSDT again within TTL & before new 5m/15m bar forms -> 0 new HTTP requests!
    await service.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });

    assert.equal(
      mockAdapter.klineFetchCountsByTf['5m'],
      1,
      '5m cache within bar window must not re-fetch'
    );
    assert.equal(
      mockAdapter.klineFetchCountsByTf['15m'],
      1,
      '15m cache within bar window must not re-fetch'
    );
    assert.equal(
      mockAdapter.klineFetchCountsByTf['1h'],
      1,
      '1h cache within TTL must not re-fetch'
    );
    assert.equal(
      mockAdapter.klineFetchCountsByTf['4h'],
      1,
      '4h cache within TTL must not re-fetch'
    );
    assert.equal(mockAdapter.oiFetchCount, 1, 'OI within TTL must not re-fetch');

    // Verify every cache entry stores source, fetchedAt, dataTimestamp, stale, fallback, missingData, isDemo
    const cached15m = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '15m', nowMs);
    assert.ok(cached15m);
    assert.ok(cached15m.provenance.source.includes('Binance'));
    assert.ok(typeof cached15m.provenance.fetchedAt === 'string');
    assert.ok(typeof cached15m.dataTimestamp === 'number' && cached15m.dataTimestamp > 0);
    assert.equal(cached15m.provenance.stale, false);
    assert.equal(cached15m.provenance.fallback, false);
    assert.ok(Array.isArray(cached15m.provenance.missingData));
    assert.equal(cached15m.provenance.isDemo, false);

    // 4. Simulate that a new 15m bar has formed (dataTimestamp of 15m and 5m is now > 15m in the past, while 1h & 4h TTL are still valid)
    const oldBarCloseMs = nowMs - 16 * 60_000;
    db.saveSmcCandlesCache({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: cached15m.klines,
      openInterest: cached15m.openInterest,
      openInterestValue: cached15m.openInterestValue,
      oiFetchedAt: cached15m.oiFetchedAt,
      oiExpiresAt: cached15m.oiExpiresAt,
      dataTimestamp: oldBarCloseMs,
      expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
      provenance: {
        ...cached15m.provenance,
        fetchedAt: new Date(oldBarCloseMs + 1000).toISOString(),
      },
    });

    await service.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });

    assert.equal(
      mockAdapter.klineFetchCountsByTf['15m'],
      2,
      '15m must refresh when a new 15m bar has formed'
    );
    assert.equal(
      mockAdapter.klineFetchCountsByTf['1h'],
      1,
      '1h must still be reused from TTL cache without re-fetching'
    );
    assert.equal(
      mockAdapter.klineFetchCountsByTf['4h'],
      1,
      '4h must still be reused from TTL cache without re-fetching'
    );

    // 8. Stale cache must NEVER be treated as fresh live data
    const cached1h = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '1h', nowMs)!;
    db.saveSmcCandlesCache({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '1h',
      klines: cached1h.klines,
      openInterest: cached1h.openInterest,
      openInterestValue: cached1h.openInterestValue,
      dataTimestamp: cached1h.dataTimestamp,
      expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
      provenance: {
        ...cached1h.provenance,
        stale: true,
      },
    });

    await service.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });
    assert.equal(
      mockAdapter.klineFetchCountsByTf['1h'],
      2,
      'Stale cache entry must be rejected and re-fetched from live adapter'
    );

    db.close();
  });

  it('Tests 6 & 7: HTTP 429 triggers exponential backoff retry, and HTTP 503 marks FAILED while preserving honest Live error state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-t67-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new RadarDatabase(dbPath);
    const mockAdapter = new Phase8MockExchangeAdapter();
    const adapters: Record<ExchangeId, ExchangeAdapter> = {
      binance_usdm: mockAdapter,
      bybit_linear: mockAdapter,
      bingx_swap: mockAdapter,
      demo_synthetic: mockAdapter,
    };

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: {
        maxJobConcurrency: 2,
        maxHttpConcurrency: 4,
        maxRetries: 3,
        baseBackoffMs: 20,
      },
    });

    // 6. Simulate HTTP 429 on ETHUSDT -> marks RATE_LIMITED with backoff, then succeeds on retry
    mockAdapter.fail429Symbol = 'ETHUSDT';
    mockAdapter.fail429Remaining = 1;

    await service.priorityRefreshSymbol({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
    });

    let ethJob = db
      .listSmcScanJobs('binance_usdm', 20)
      .find((j) => j.symbol === 'ETHUSDT');
    assert.ok(ethJob);
    assert.equal(ethJob.status, 'RATE_LIMITED');
    assert.equal(ethJob.retryCount, 1);
    assert.ok(ethJob.nextRetryAt);

    // Wait for backoff window (25ms) and process batch -> ETHUSDT succeeds
    await new Promise((r) => setTimeout(r, 35));
    await service.processNextBatch('binance_usdm', 'live', 5);
    ethJob = db
      .listSmcScanJobs('binance_usdm', 20)
      .find((j) => j.symbol === 'ETHUSDT');
    assert.equal(ethJob?.status, 'SUCCEEDED');

    // 7. Simulate HTTP 503 failure -> marks job FAILED and never uses Demo fallback
    mockAdapter.fail503All = true;
    await service.priorityRefreshSymbol({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: true,
    });

    const solJob = db
      .listSmcScanJobs('binance_usdm', 20)
      .find((j) => j.symbol === 'SOLUSDT');
    assert.equal(solJob?.status, 'FAILED');
    assert.ok(solJob?.lastError?.includes('503'));

    const statusAfter503 = service.getStatus('binance_usdm', 'live');
    assert.equal(statusAfter503.mode, 'live');
    assert.ok((statusAfter503.failedJobCount ?? statusAfter503.failedCount) >= 1);

    db.close();
  });

  it('Tests 9, 10, 11 & 12: Strict Live Paper vs Backtest entry timing (ATOMUSDT 02:59:59 close / 03:00:00 nextBar.open vs 03:14:46 late detection vs early detection)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-t912-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const radarDb = new RadarDatabase(dbPath);
    const paperMonitorDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb });

    // ATOMUSDT timeline:
    // Signal bar: 02:45:00 -> 02:59:59.999
    // Next bar (i+1): 03:00:00.000 -> 03:14:59.999, open = 1.622
    const signalBarCloseMs = Date.parse('2026-10-26T02:59:59.999Z');
    const nextBarOpenMs = Date.parse('2026-10-26T03:00:00.000Z');
    const klinesWithOpenNextBar = buildAnchoredKlines('15m', signalBarCloseMs, {
      bullishCandidate: true,
      includeOpenNextBar: true,
      nextBarOpenPrice: 1.622,
    });

    // 9. Signal detected BEFORE nextBar.openTime (e.g. at 02:59:59.999, latency = 0ms < nextBar.openTime)
    // First pass klines before next bar opens, then settle when next bar opens
    const klinesBeforeNextBarOpen = klinesWithOpenNextBar.filter((k) => k.isClosed);
    const earlyDetectedIso = '2026-10-26T02:59:59.999Z';
    const earlyRes = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_phase8',
      scanRunId: 'srun_phase8',
      scanCycleId: 'scyc_early',
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: earlyDetectedIso,
      evaluatedAt: earlyDetectedIso,
      signalDetectedAt: earlyDetectedIso,
      klines: klinesBeforeNextBarOpen,
      atr14: 0.04,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: earlyDetectedIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Confirmed', 'FVG:Confirmed', 'Sweep:Confirmed'],
      score: 88,
      isBacktest: false,
    });

    assert.ok(earlyRes.signal);
    assert.equal(earlyRes.signal.status, 'CREATED');
    assert.equal(earlyRes.signal.entryStatus, 'PENDING_NEXT_ENTRY');
    assert.equal(earlyRes.signal.entryReferencePrice, null);
    assert.equal(earlyRes.signal.entryWindowStatus, '等待下一根 K 線開盤');

    // Now next bar (03:00:00) opens at 1.622 -> settleSignalWithKlines opens PAPER_OPENED at 1.622
    const settledEarly = tracker.settleSignalWithKlines({
      signalId: earlyRes.signal.signalId,
      klines: klinesWithOpenNextBar,
      atr14: 0.04,
    });
    assert.ok(settledEarly);
    assert.equal(settledEarly.status, 'PAPER_OPENED');
    assert.equal(settledEarly.entryStatus, 'PAPER_OPENED');
    assert.equal(settledEarly.entryReferencePrice, 1.622);
    assert.equal(
      settledEarly.entryReferenceTime,
      new Date(nextBarOpenMs).toISOString()
    );

    // 10. ATOMUSDT case: Signal detected AFTER nextBar.openTime (at 03:14:46.000 >= 03:00:00.000)
    // Must NEVER retroactively use nextBar.open (1.622); must mark ENTRY_WINDOW_MISSED with entryReferencePrice = null
    const lateDetectedIso = '2026-10-26T03:14:46.000Z';
    const lateRes = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_phase8',
      scanRunId: 'srun_phase8',
      scanCycleId: 'scyc_late',
      symbol: 'ATOMUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: lateDetectedIso,
      evaluatedAt: lateDetectedIso,
      signalDetectedAt: lateDetectedIso,
      klines: klinesWithOpenNextBar,
      atr14: 0.04,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: lateDetectedIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Confirmed', 'FVG:Confirmed', 'Sweep:Confirmed'],
      score: 88,
      isBacktest: false,
    });

    assert.ok(lateRes.signal);
    assert.equal(lateRes.signal.status, 'ENTRY_WINDOW_MISSED');
    assert.equal(lateRes.signal.entryStatus, 'ENTRY_WINDOW_MISSED');
    assert.equal(lateRes.signal.entryWindowStatus, '原始進場窗口已錯過');
    assert.equal(
      lateRes.signal.entryReferencePrice,
      null,
      'Late signal must NEVER retroactively use missed nextBar.open (1.622)'
    );
    assert.equal(lateRes.signal.detectionLatencyMs, 886_001);

    // 11 & 12. Backtest mode (isBacktest: true) on the exact same K-lines uses confirmedKlines[i+1].open and does not mix with Live Paper
    const klinesWithConfirmedNextBar = klinesWithOpenNextBar.map((k) => ({
      ...k,
      isClosed: true,
    }));
    const backtestRes = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_backtest',
      scanRunId: 'srun_backtest',
      scanCycleId: 'scyc_bt',
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: lateDetectedIso,
      evaluatedAt: lateDetectedIso,
      signalDetectedAt: lateDetectedIso,
      klines: klinesWithConfirmedNextBar,
      signalBarIndex: klinesWithConfirmedNextBar.length - 2,
      atr14: 0.04,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: lateDetectedIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Confirmed', 'FVG:Confirmed', 'Sweep:Confirmed'],
      score: 88,
      isBacktest: true,
      allowBacktestTracking: true,
    });

    assert.ok(backtestRes.signal);
    assert.equal(backtestRes.signal.entryReferencePrice, 1.622);
    assert.notEqual(backtestRes.signal.status, 'ENTRY_WINDOW_MISSED');

    radarDb.close();
  });

  it('Tests 13, 14, 15 & Section 九: Non-passing SMC symbols stay WAIT/WATCH/HIGH RISK, safety flags & 0 external requests hold, and 3 complete Live scan cycles record all Phase 8 latency metrics', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-cycles-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const mockAdapter = new Phase8MockExchangeAdapter();
    mockAdapter.anchorBarCloseMs = Date.now() - 8_000;

    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: mockAdapter,
      },
      smcQueueConfig: {
        maxJobConcurrency: 4,
        maxHttpConcurrency: 8,
        maxRequestsPerMinute: 1200,
        batchSize: 60,
      },
    });

    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Test Fast Lane endpoint POST /api/smc-scan/priority-refresh/:symbol
      const prioRes = await fetch(
        `${baseUrl}/api/smc-scan/priority-refresh/ATOMUSDT`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: 'binance_usdm',
            mode: 'live',
            executeImmediately: true,
          }),
        }
      );
      assert.equal(prioRes.status, 200);
      const prioJson = await prioRes.json();
      assert.equal(prioJson.symbol, 'ATOMUSDT');
      assert.equal(prioJson.safety.mode, 'PAPER ONLY');
      assert.equal(prioJson.safety.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(prioJson.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
      assert.ok(typeof prioJson.queueEnteredAt === 'string');
      assert.ok(typeof prioJson.smcEvaluationStartedAt === 'string');
      assert.ok(typeof prioJson.smcEvaluationCompletedAt === 'string');
      assert.ok(typeof prioJson.detectionLatencyMs === 'number');

      // Run 3 complete Live scan cycles and record metrics
      const smcBatchScanner = app.locals.smcBatchScanner as SmcBatchScanService;
      const paperShadowMonitor = app.locals
        .paperShadowMonitor as PaperShadowMonitor;

      for (let cycleIdx = 1; cycleIdx <= 3; cycleIdx++) {
        mockAdapter.anchorBarCloseMs = Date.now() - 5_000;
        const startRes = await fetch(`${baseUrl}/api/smc-scan/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: 'binance_usdm',
            mode: 'live',
            windowKey: `win_phase8_cycle_${cycleIdx}`,
            forceRefresh: true,
            processBatchNow: true,
            batchLimit: 60,
          }),
        });
        assert.equal(startRes.status, 200);
        // Drain any remaining queued jobs for this cycle
        while (
          smcBatchScanner.getStatus('binance_usdm', 'live').queuedCount > 0
        ) {
          await smcBatchScanner.processNextBatch('binance_usdm', 'live', 60);
        }
        // Trigger snapshot reconciliation so the completed cycle is recorded in smc_scan_cycles
        smcBatchScanner.getStatus('binance_usdm', 'live');
        paperShadowMonitor.recordScanCycleSnapshot();
      }

      const smcStatusRes = await fetch(
        `${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`
      );
      const smcStatus = await smcStatusRes.json();

      // 13. Non-passing SMC symbols remain WAIT / WATCH / HIGH RISK
      assert.ok(
        smcStatus.waitCount + smcStatus.watchCount + smcStatus.highRiskCount > 0,
        'Symbols not passing SMC gates must remain in WAIT / WATCH / HIGH RISK'
      );
      assert.equal(smcStatus.evaluatedCount, smcStatus.totalJobs);
      assert.ok(smcStatus.completedScanCyclesCount >= 3);

      // Verify Phase 8 real-time latency telemetry fields exist & meet target on fast mock
      assert.ok(typeof smcStatus.lastFullRadarScanAt === 'string');
      assert.ok(typeof smcStatus.lastPriorityScanAt === 'string');
      assert.ok(typeof smcStatus.queueWaitMs === 'number');
      assert.ok(typeof smcStatus.detectionLatencyMs === 'number');
      assert.ok(
        typeof smcStatus.p50DetectionLatencyMs === 'number' &&
          smcStatus.p50DetectionLatencyMs < 60_000
      );
      assert.ok(
        typeof smcStatus.p95DetectionLatencyMs === 'number' &&
          smcStatus.p95DetectionLatencyMs < 120_000
      );

      // 14 & 15. Verify Paper Monitor Status & Window Report safety flags & 0 external requests
      const pmStatusRes = await fetch(`${baseUrl}/api/paper-monitor/status`);
      const pmStatus = await pmStatusRes.json();
      assert.equal(pmStatus.mode, 'PAPER ONLY');
      assert.equal(pmStatus.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(pmStatus.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
      assert.equal(pmStatus.externalTelegramRequestsCount, 0);
      assert.equal(pmStatus.externalTradingViewRequestsCount, 0);
      assert.ok(typeof pmStatus.p50DetectionLatencyMs === 'number');
      assert.ok(typeof pmStatus.p95DetectionLatencyMs === 'number');
      assert.ok(typeof pmStatus.p50PriorityDetectionLatencyMs === 'number');
      assert.ok(typeof pmStatus.p95PriorityDetectionLatencyMs === 'number');
      assert.ok(typeof pmStatus.p95BulkQueueWaitMs === 'number');
      assert.ok(typeof pmStatus.fullUniverseCompletionDurationMs === 'number');
      assert.ok(pmStatus.latencyBreakdown);
      assert.ok(Array.isArray(pmStatus.slowestSymbolsTop20));
    } finally {
      (app.locals.smcBatchScanner as SmcBatchScanService)?.pauseScan();
      (app.locals.paperShadowMonitor as PaperShadowMonitor)?.stop();
      (app.locals.backgroundScheduler as { stop?: () => void })?.stop?.();
      server.close();
      (app.locals.radarDb as RadarDatabase).close();
    }
  });

  it('Phase 8 Tail Latency Fix: Fast Lane Worker slot reservation, Bulk anti-starvation priority aging, single RUNNING job invariant, and controlled LONG + SHORT + MISSED fixtures', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase8-tail-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new RadarDatabase(dbPath);
    const paperMonitorDb = new PaperMonitorDatabase(db);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb });
    const mockAdapter = new Phase8MockExchangeAdapter();
    const adapters: Record<ExchangeId, ExchangeAdapter> = {
      binance_usdm: mockAdapter,
      bybit_linear: mockAdapter,
      bingx_swap: mockAdapter,
      demo_synthetic: mockAdapter,
    };

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: {
        maxJobConcurrency: 2,
        maxHttpConcurrency: 8,
        maxRequestsPerMinute: 1200,
        batchSize: 6,
        priorityAgeMs: 1_000,
        maxFastLaneBurst: 3,
        bulkReservation: 1,
        fastLaneWorkerSlots: 1,
      },
    });

    // Enqueue 40 contracts where 35 are Bulk Tier 6 and 5 are Fast Lane
    const snap = await mockAdapter.fetchMarketSnapshot();
    const preScan = runMarketScan(snap.tickers.slice(0, 40), snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      historicalVolumeMap: new Map(),
    });

    service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap.tickers.slice(0, 40),
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      radarScanDurationMs: 120,
    });

    // Test 2 (Tail Fix): Bulk Worker must NOT occupy all worker slots when Fast Lane jobs are queued
    const nowIso = new Date().toISOString();
    const bulkClaimedWhenFastLaneQueued = db.claimNextSmcScanJobs(
      'binance_usdm',
      2,
      nowIso,
      {
        maxConcurrency: 2,
        workerId: 'worker_bulk_test',
        workerRole: 'BULK',
        leaseDurationMs: 60_000,
        priorityAgeMs: 15_000,
        forceBulkAntiStarvation: false,
      }
    );
    assert.ok(
      bulkClaimedWhenFastLaneQueued.length <= 1,
      `Bulk Worker must leave at least 1 reserved slot for Fast Lane when maxConcurrency=2, claimed=${bulkClaimedWhenFastLaneQueued.length}`
    );

    // Fast Lane Worker can immediately claim the reserved slot even while 1 Bulk job is RUNNING
    const fastLaneClaimed = db.claimNextSmcScanJobs(
      'binance_usdm',
      1,
      nowIso,
      {
        maxConcurrency: 2,
        workerId: 'worker_fast_lane_test',
        workerRole: 'FAST_LANE',
        leaseDurationMs: 60_000,
        priorityAgeMs: 15_000,
      }
    );
    assert.equal(
      fastLaneClaimed.length,
      1,
      'Fast Lane Worker must claim its reserved slot while Bulk job is running'
    );
    assert.equal(fastLaneClaimed[0].isFastLane, true);

    // Test 4 (Tail Fix): Same symbol never has two RUNNING jobs simultaneously, and runningJobCount <= maxJobConcurrency
    const duplicateClaimSameSymbol = db.claimNextSmcScanJobs(
      'binance_usdm',
      2,
      nowIso,
      {
        maxConcurrency: 2,
        workerId: 'worker_fast_lane_dup',
        workerRole: 'FAST_LANE',
        preferredSymbol: fastLaneClaimed[0].symbol,
      }
    );
    assert.equal(
      duplicateClaimSameSymbol.length,
      0,
      'Must never exceed maxConcurrency or claim a second RUNNING job for the same symbol'
    );

    // Complete those 2 claimed jobs so we can test anti-starvation
    for (const j of [...bulkClaimedWhenFastLaneQueued, ...fastLaneClaimed]) {
      db.saveSmcScanResult(
        {
          symbol: j.symbol,
          exchange: 'binance_usdm',
          smcEvaluationStatus: 'EVALUATED',
          smcActionState: 'WAIT',
          finalTradeSignal: 'NONE',
          marketRadarCategory: '準備觀察',
          evaluatedAt: nowIso,
          dataFetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines)',
          isDemo: false,
          ruleVersion: j.ruleVersion,
          waitReasons: ['15M 尚未出現 BOS/CHoCH 結構確認'],
          priorityTier: j.priorityTier,
          priorityLabel: j.priorityLabel,
          workerRole: j.workerRole ?? 'FAST_LANE',
          queueEnteredAt: j.queueEnteredAt ?? nowIso,
          jobClaimedAt: j.jobClaimedAt ?? nowIso,
          smcEvaluationStartedAt: nowIso,
          smcEvaluationCompletedAt: nowIso,
          queueWaitMs: 10,
          httpRequestLatencyMs: 20,
          smcCalculationLatencyMs: 12,
          dbWriteLatencyMs: 3,
          smcEvaluationLatencyMs: 35,
          rateLimitWaitMs: 0,
          detectionLatencyMs: 45,
          cacheHit: false,
          cacheMiss: true,
          reusedCache: false,
          isFastLane: Boolean(j.isFastLane),
        },
        j.id
      );
    }

    // Test 3 (Tail Fix): Anti-starvation — when forceBulkAntiStarvation=true or priorityAgeMs has aged bulk jobs, Bulk jobs get claimed and are never permanently starved
    const agedNowIso = new Date(Date.now() + 120_000).toISOString();
    const antiStarvationBulkClaim = db.claimNextSmcScanJobs(
      'binance_usdm',
      1,
      agedNowIso,
      {
        maxConcurrency: 2,
        workerId: 'worker_bulk_antistarve',
        workerRole: 'BULK',
        leaseDurationMs: 60_000,
        priorityAgeMs: 5_000,
        forceBulkAntiStarvation: true,
      }
    );
    assert.equal(
      antiStarvationBulkClaim.length,
      1,
      'Bulk anti-starvation must guarantee Bulk tasks are claimed and not starved forever'
    );
    assert.equal(antiStarvationBulkClaim[0].isFastLane, false);

    // Section 七: Controlled fixtures verifying:
    // 1. 1 LONG candidate detected BEFORE nextBarOpenTime -> enters PAPER_OPENED
    // 2. 1 SHORT candidate detected BEFORE nextBarOpenTime -> enters PAPER_OPENED
    // 3. 1 candidate detected AFTER nextBarOpenTime -> marked ENTRY_WINDOW_MISSED
    const signalBarCloseMs = Date.parse('2026-10-26T05:59:59.999Z');
    const earlyDetectIso = '2026-10-26T05:59:59.999Z';
    const lateDetectIso = '2026-10-26T06:04:12.000Z';
    const klinesWithNextOpen = buildAnchoredKlines('15m', signalBarCloseMs, {
      bullishCandidate: true,
      includeOpenNextBar: true,
      nextBarOpenPrice: 142.5,
    });
    const closedOnlyKlines = klinesWithNextOpen.filter((k) => k.isClosed);

    // 1. Controlled LONG candidate before nextBarOpenTime -> PAPER_OPENED
    const longPre = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_sec7',
      scanRunId: 'srun_sec7',
      scanCycleId: 'scyc_sec7',
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: earlyDetectIso,
      evaluatedAt: earlyDetectIso,
      signalDetectedAt: earlyDetectIso,
      klines: closedOnlyKlines,
      atr14: 1.2,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: earlyDetectIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Bullish', 'FVG:Bullish', 'Sweep:SellSide'],
      score: 89,
      isBacktest: false,
    });
    assert.ok(longPre.signal);
    const longOpened = tracker.settleSignalWithKlines({
      signalId: longPre.signal.signalId,
      klines: klinesWithNextOpen,
      atr14: 1.2,
    });
    assert.equal(longOpened?.direction, 'LONG');
    assert.equal(longOpened?.status, 'PAPER_OPENED');
    assert.equal(longOpened?.entryReferencePrice, 142.5);

    // 2. Controlled SHORT candidate before nextBarOpenTime -> PAPER_OPENED
    const shortPre = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_sec7',
      scanRunId: 'srun_sec7',
      scanCycleId: 'scyc_sec7',
      symbol: 'SUIUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達空頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'SHORT CANDIDATE',
      finalTradeSignal: '空頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: earlyDetectIso,
      evaluatedAt: earlyDetectIso,
      signalDetectedAt: earlyDetectIso,
      klines: closedOnlyKlines,
      atr14: 1.2,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: earlyDetectIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Bearish', 'FVG:Bearish', 'Sweep:BuySide'],
      score: 87,
      isBacktest: false,
    });
    assert.ok(shortPre.signal);
    const shortOpened = tracker.settleSignalWithKlines({
      signalId: shortPre.signal.signalId,
      klines: klinesWithNextOpen,
      atr14: 1.2,
    });
    assert.equal(shortOpened?.direction, 'SHORT');
    assert.equal(shortOpened?.status, 'PAPER_OPENED');
    assert.equal(shortOpened?.entryReferencePrice, 142.5);

    // 3. Controlled candidate delayed past nextBarOpenTime -> ENTRY_WINDOW_MISSED
    const lateMissed = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mrun_sec7',
      scanRunId: 'srun_sec7',
      scanCycleId: 'scyc_sec7',
      symbol: 'ATOMUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: 'phase8-v1',
      snapshotAt: lateDetectIso,
      evaluatedAt: lateDetectIso,
      signalDetectedAt: lateDetectIso,
      klines: klinesWithNextOpen,
      atr14: 1.2,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: {
        source: 'Binance USDⓈ-M Futures',
        fetchedAt: lateDetectIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      waitReasons: [],
      evidences: ['CHoCH:Bullish', 'FVG:Bullish', 'Sweep:SellSide'],
      score: 86,
      isBacktest: false,
    });
    assert.ok(lateMissed.signal);
    assert.equal(lateMissed.signal.status, 'ENTRY_WINDOW_MISSED');
    assert.equal(lateMissed.signal.entryReferencePrice, null);

    db.close();
  });

  it('Phase 8 Final Wrap-up (Section 七 1~12 & Section 四/八): Isolated 523-symbol Cold-Start Prewarm Cycle 1 + Warm-Cache Cycles 2 & 3, priorityClass vs executionWorker separation, and Cold/Warm SLA verification', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'radar-phase8-523-cold-warm-')
    );
    const dbPath = path.join(tmpDir, 'isolated_phase8_test.sqlite');
    const db = new RadarDatabase(dbPath);
    const mockAdapter = new Phase8MockExchangeAdapter();
    mockAdapter.anchorBarCloseMs = Date.now() - 10_000;

    // Override fetchMarketSnapshot to return 523 symbols matching full Binance USDM universe
    mockAdapter.fetchMarketSnapshot = async () => {
      const tickers = buildLiveTickers(523, Date.now());
      return {
        tickers,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    };

    const adapters: Record<ExchangeId, ExchangeAdapter> = {
      binance_usdm: mockAdapter,
      bybit_linear: mockAdapter,
      bingx_swap: mockAdapter,
      demo_synthetic: mockAdapter,
    };

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: {
        maxJobConcurrency: 2,
        maxHttpConcurrency: 8,
        maxRequestsPerMinute: 4000,
        batchSize: 60,
        baseBackoffMs: 15,
        priorityAgeMs: 10_000,
        maxFastLaneBurst: 8,
        bulkReservation: 1,
        fastLaneWorkerSlots: 1,
      },
    });

    // Verify isolated test databaseInstanceId (never touches live data/radar_phase2.sqlite)
    assert.ok(db.databaseInstanceId.startsWith('db_'));

    const snap = await mockAdapter.fetchMarketSnapshot();
    assert.equal(snap.tickers.length, 523);
    const preScan = runMarketScan(snap.tickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      historicalVolumeMap: new Map(),
    });

    // =========================================================================
    // CYCLE 1: Empty Cache Cold Start + Priority Prewarm + Full 523 Evaluation
    // =========================================================================
    const cycle1Enq = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap.tickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'QUSDT'],
      windowKey: 'win_isolated_cold_cycle_1',
      forceRefresh: true,
      pruneUniverse: true,
      radarScanDurationMs: 150,
    });
    assert.equal(cycle1Enq.enqueuedCount, 523);
    assert.ok(cycle1Enq.fastLaneEnqueuedCount > 0);

    // 1 & 2. Cold-start prewarm completes on empty cache and never occupies all Fast Lane slots
    const prewarm1 = await service.prewarmFastLaneCache({
      exchange: 'binance_usdm',
      mode: 'live',
      forceRefresh: false,
    });
    assert.equal(prewarm1.isColdStart, true, 'Cycle 1 on empty cache must be identified as Cold Start');
    assert.equal(prewarm1.prewarmedSymbolCount, cycle1Enq.fastLaneEnqueuedCount);
    assert.ok(prewarm1.prewarmDurationMs >= 0);

    // Drain all 523 jobs in Cycle 1 with maxJobConcurrency = 2
    while (service.getStatus('binance_usdm', 'live').queuedCount > 0) {
      await service.processNextBatch('binance_usdm', 'live', 60);
    }

    // 9. Verify maxJobConcurrency <= 2 was strictly respected across all 523 jobs
    assert.ok(
      service.maxRunningJobCountObserved <= 2,
      `Expected maxRunningJobCountObserved <= 2, got ${service.maxRunningJobCountObserved}`
    );

    const statusCycle1 = service.getStatus('binance_usdm', 'live');
    assert.equal(statusCycle1.totalContracts, 523);
    assert.equal(statusCycle1.evaluatedCount, 523);
    assert.equal(statusCycle1.queuedCount, 0);
    assert.equal(statusCycle1.cycleStatus, 'COMPLETED');
    assert.equal(statusCycle1.coldStartPrioritySLA, 'MET');
    assert.ok(
      typeof statusCycle1.coldStartP95 === 'number' &&
        statusCycle1.coldStartP95 < 120_000,
      `Expected coldStartP95 < 120000ms, got ${statusCycle1.coldStartP95}`
    );

    // 3, 4 & 5. Verify priorityClass vs executionWorker separation:
    // - Tier 1..5 => priorityClass = FAST_LANE
    // - Tier 6 => priorityClass = BULK
    // - When Fast Lane Worker assists with Bulk (Tier 6), priorityClass = BULK and executionWorker = FAST_LANE_WORKER
    // - 0 Tier 6 symbols misclassified as Fast Lane
    const breakdown1 = statusCycle1.priorityExecutionBreakdown!;
    assert.ok(breakdown1);
    assert.equal(
      breakdown1.tier6MisclassifiedAsFastLaneCount,
      0,
      'Tier 6 must NEVER be misclassified as FAST_LANE'
    );
    assert.equal(
      breakdown1.fastLaneClassCount,
      cycle1Enq.fastLaneEnqueuedCount,
      'priorityDetectionLatency sample count must strictly equal Tier 1..5 Fast Lane count'
    );
    assert.equal(
      breakdown1.bulkClassCount,
      523 - cycle1Enq.fastLaneEnqueuedCount,
      'bulkQueueWait sample count must strictly equal Tier 6 Bulk count'
    );
    assert.equal(
      statusCycle1.priorityDetectionLatency?.sampleCount,
      cycle1Enq.fastLaneEnqueuedCount
    );
    assert.equal(
      statusCycle1.bulkQueueWait?.sampleCount,
      523 - cycle1Enq.fastLaneEnqueuedCount
    );
    // 7. All 523 jobs are included in fullUniverseCompletionLatency p95 without dropping any slow task
    assert.equal(
      statusCycle1.fullUniverseCompletionLatency?.sampleCount,
      523
    );
    assert.ok(
      breakdown1.fastLaneWorkerBulkAssistCount > 0,
      'Fast Lane Worker assisting on Bulk tasks must record priorityClass=BULK and executionWorker=FAST_LANE_WORKER'
    );

    // =========================================================================
    // CYCLE 2: Warm Cache Scan across all 523 symbols
    // =========================================================================
    service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap.tickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'QUSDT'],
      windowKey: 'win_isolated_warm_cycle_2',
      forceRefresh: true,
      pruneUniverse: true,
      radarScanDurationMs: 110,
    });

    const prewarm2 = await service.prewarmFastLaneCache({
      exchange: 'binance_usdm',
      mode: 'live',
      forceRefresh: false,
    });
    assert.equal(prewarm2.isColdStart, false, 'Cycle 2 with populated cache must be Warm Cache');
    assert.equal(prewarm2.prewarmCacheHitRate, 100);

    while (service.getStatus('binance_usdm', 'live').queuedCount > 0) {
      await service.processNextBatch('binance_usdm', 'live', 60);
    }
    const statusCycle2 = service.getStatus('binance_usdm', 'live');
    assert.equal(statusCycle2.evaluatedCount, 523);
    assert.equal(statusCycle2.cycleStatus, 'COMPLETED');
    assert.equal(statusCycle2.warmCachePrioritySLA, 'MET');

    // =========================================================================
    // CYCLE 3: Second Warm Cache Scan across all 523 symbols
    // =========================================================================
    service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap.tickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'QUSDT'],
      windowKey: 'win_isolated_warm_cycle_3',
      forceRefresh: true,
      pruneUniverse: true,
      radarScanDurationMs: 95,
    });

    const prewarm3 = await service.prewarmFastLaneCache({
      exchange: 'binance_usdm',
      mode: 'live',
      forceRefresh: false,
    });
    assert.equal(prewarm3.isColdStart, false, 'Cycle 3 must be Warm Cache');
    assert.equal(prewarm3.prewarmCacheHitRate, 100);

    while (service.getStatus('binance_usdm', 'live').queuedCount > 0) {
      await service.processNextBatch('binance_usdm', 'live', 60);
    }
    const statusCycle3 = service.getStatus('binance_usdm', 'live');
    assert.equal(statusCycle3.evaluatedCount, 523);
    assert.equal(statusCycle3.cycleStatus, 'COMPLETED');
    assert.ok((statusCycle3.completedScanCyclesCount ?? 0) >= 3);
    assert.equal(statusCycle3.coldStartPrioritySLA, 'MET');
    assert.equal(statusCycle3.warmCachePrioritySLA, 'MET');
    assert.ok(
      typeof statusCycle3.warmCacheP95 === 'number' &&
        statusCycle3.warmCacheP95 < 120_000
    );
    assert.equal(statusCycle3.safety.mode, 'PAPER ONLY');
    assert.equal(statusCycle3.safety.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(
      statusCycle3.safety.executionPolicy,
      'NEVER AUTO-PLACE ORDERS'
    );

    db.close();
  });
});

