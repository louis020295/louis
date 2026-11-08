import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server.ts';
import {
  BinanceFuturesAdapter,
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import {
  NotificationGuardEngine,
  TelegramNotificationAdapter,
} from '../server/adapters/NotificationAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { evaluateSmcStructure } from '../server/engine/SmcRuleEngine.ts';
import {
  evaluateHistoricalVolumeAnomaly,
  extractPriorConfirmedBaselineWindow,
} from '../server/engine/VolumeAnomalyEngine.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function build524Tickers(): MarketTicker[] {
  const tickers: MarketTicker[] = [];
  const prov: DataProvenance = {
    source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
    fetchedAt: new Date().toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
  for (let i = 0; i < 524; i++) {
    const symbol =
      i === 0
        ? 'BTCUSDT'
        : i === 1
          ? 'ETHUSDT'
          : i === 2
            ? 'SOLUSDT'
            : `SYM${String(i).padStart(3, '0')}USDT`;
    const price = 100 + i;
    tickers.push({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      lastPrice: price,
      bidPrice: Number((price * 0.9999).toFixed(4)),
      askPrice: Number((price * 1.0001).toFixed(4)),
      spreadPercent: 0.02,
      priceChangePercent24h:
        i === 0 ? 1.5 : i < 15 ? 8.5 : i < 30 ? -7.2 : 0.8,
      quoteVolume24h: i < 50 ? 150_000_000 : 25_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      openInterest: 500_000,
      openInterestValue: 50_000_000,
      provenance: prov,
    });
  }
  return tickers;
}

function buildClosedKlines(
  timeframe: Timeframe,
  bullishDisplacement = false,
  includeOneUnclosedBar = false
): Kline[] {
  const stepMs =
    timeframe === '5m'
      ? 300_000
      : timeframe === '15m'
        ? 900_000
        : timeframe === '1h'
          ? 3_600_000
          : 14_400_000;
  const now = 1_760_000_000_000;
  const bars: Kline[] = [];
  let price = 100;

  for (let i = 60; i >= 1; i--) {
    const openTime = now - i * stepMs;
    const closeTime = openTime + stepMs - 1;
    let open = price;
    let close = price + (i % 2 === 0 ? 0.4 : -0.35);
    let high = Math.max(open, close) + 0.3;
    let low = Math.min(open, close) - 0.3;
    let quoteVolume = 1_500_000;

    if (bullishDisplacement) {
      if (i === 5) {
        open = price;
        low = price - 4.5;
        close = price + 0.8;
        high = close + 0.4;
        quoteVolume = 4_500_000;
      } else if (i === 4) {
        open = price;
        close = price + 3.2;
        high = close + 0.3;
        low = open - 0.1;
        quoteVolume = 6_500_000;
      } else if (i === 3) {
        open = price;
        close = price + 6.5;
        high = close + 0.5;
        low = open + 1.2;
        quoteVolume = 9_500_000;
      } else if (i <= 2) {
        open = price;
        close = price + 1.8;
        high = close + 0.4;
        low = open - 0.2;
        quoteVolume = 5_200_000;
      }
    }

    price = close;
    bars.push({
      openTime,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Number((quoteVolume / price).toFixed(2)),
      closeTime,
      quoteVolume,
      isClosed: true,
    });
  }

  if (includeOneUnclosedBar) {
    bars.push({
      openTime: now,
      open: price,
      high: price + 50,
      low: price - 50,
      close: price + 45,
      volume: 999999,
      closeTime: now + stepMs - 1,
      quoteVolume: 999_999_999,
      isClosed: false,
    });
  }

  return bars;
}

function createMockAdapters(): Record<ExchangeId, ExchangeAdapter> {
  const binance = new BinanceFuturesAdapter();
  return {
    binance_usdm: binance,
    bybit_linear: binance,
    bingx_swap: binance,
    demo_synthetic: binance,
  };
}

describe('Phase 3：全市場 SMC/ICT 背景分批掃描與快取系統 (完整並行限制、統計恆等式與生命週期驗收測試)', () => {
  it('1 & 2 & 3 & 8 & 9 & 11: 524 檔分批加入佇列、唯一鍵防重、未完成保持 PENDING 且滿足統計恆等式', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase3-q-'));
    const db = new RadarDatabase(path.join(tmpDir, 'test.sqlite'));
    const adapters = createMockAdapters();
    const guard = new NotificationGuardEngine();
    const notifier = new TelegramNotificationAdapter(guard);
    const service = new SmcBatchScanService({
      adapters,
      db,
      telegramDryRunAdapter: notifier,
      config: {
        maxConcurrency: 2,
        batchSize: 12,
      },
    });

    const tickers = build524Tickers();
    const liveProv: DataProvenance = {
      source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };

    const initialScan = runMarketScan(tickers, liveProv, {
      minQuoteVolume24h: 0,
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    // Before SMC batch jobs run, all 524 symbols are PENDING, WaitCount = 0, GateNotConfirmed = 0
    assert.equal(initialScan.totalContractsScanned, 524);
    assert.equal(initialScan.smcPendingCount, 524);
    assert.equal(initialScan.smcWaitCount, 0);
    assert.equal(initialScan.smcWatchCount, 0);
    assert.equal(initialScan.smcLongCandidateCount, 0);
    assert.equal(initialScan.smcShortCandidateCount, 0);
    assert.equal(initialScan.smcHighRiskCount, 0);
    assert.equal(initialScan.smcGateNotConfirmedCount, 0);
    assert.equal(
      initialScan.smcPendingCount +
        initialScan.smcWaitCount +
        initialScan.smcWatchCount +
        initialScan.smcLongCandidateCount +
        initialScan.smcShortCandidateCount +
        initialScan.smcHighRiskCount,
      initialScan.totalContractsScanned
    );

    for (const c of initialScan.candidates) {
      assert.equal(c.smcEvaluationStatus, 'PENDING');
      assert.equal(c.smcActionState, 'PENDING');
      assert.equal(c.finalTradeSignal, 'NONE');
    }

    // Enqueue all 524 contracts in priority order
    const enq1 = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: initialScan.candidates,
      watchlistSymbols: ['SOLUSDT', 'BTCUSDT'],
      windowKey: 'test-window-1',
      pruneUniverse: true,
    });
    assert.equal(enq1.enqueuedCount, 524);

    const status1 = service.getStatus('binance_usdm', 'live');
    assert.equal(status1.totalJobs, 524);
    assert.equal(status1.queuedCount, 524);
    assert.equal(status1.runningJobCount, 0);
    assert.equal(status1.pendingCount, 524);
    assert.equal(
      status1.queuedCount +
        status1.runningJobCount +
        status1.succeededCount +
        status1.failedCount +
        status1.rateLimitedCount,
      status1.totalJobs
    );

    // Calling enqueueMarketUniverse again within the same window does NOT duplicate queued jobs
    const enq2 = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: initialScan.candidates,
      watchlistSymbols: ['SOLUSDT', 'BTCUSDT'],
      windowKey: 'test-window-1',
      pruneUniverse: true,
    });
    assert.equal(enq2.enqueuedCount, 0);
    assert.equal(enq2.skippedDuplicateCount, 524);
    assert.equal(service.getStatus('binance_usdm', 'live').queuedCount, 524);
    assert.equal(service.getStatus('binance_usdm', 'live').totalJobs, 524);

    // Verify priority ordering and DB-level maxConcurrency = 2 cap
    const claimed = db.claimNextSmcScanJobs(
      'binance_usdm',
      12,
      new Date().toISOString(),
      { maxConcurrency: 2, workerId: 'worker-test-1' }
    );
    assert.equal(
      claimed.length,
      2,
      'DB claimNextSmcScanJobs must cap claimed jobs so runningJobCount never exceeds maxConcurrency=2 even if limit=12 is requested'
    );
    assert.equal(claimed[0].priorityTier, 1);
    assert.equal(claimed[1].priorityTier, 1);
    assert.deepEqual(
      new Set(claimed.map((j) => j.symbol)),
      new Set(['SOLUSDT', 'BTCUSDT'])
    );

    const statusWhileRunning = service.getStatus('binance_usdm', 'live');
    assert.equal(statusWhileRunning.runningJobCount, 2);
    assert.equal(statusWhileRunning.queuedCount, 522);
    assert.equal(statusWhileRunning.pendingCount, 524);
    assert.equal(
      statusWhileRunning.queuedCount +
        statusWhileRunning.runningJobCount +
        statusWhileRunning.succeededCount +
        statusWhileRunning.failedCount +
        statusWhileRunning.rateLimitedCount,
      statusWhileRunning.totalJobs
    );

    db.close();
  });

  it('1 & 2 & 4 & 5 & 6 & 7 & 12: maxConcurrency=2 嚴格遵守 runningJobCount <= 2、多 worker 防重、429 退避、重啟恢復、超限 FAILED、SUCCEEDED 一致性與完整掃描完成狀態', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'radar-phase3-exec-')
    );
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = new RadarDatabase(dbPath);
    const adapters = createMockAdapters();
    const guard = new NotificationGuardEngine();
    const notifier = new TelegramNotificationAdapter(guard);

    let eth429Count = 0;
    let failSymbolAttempts = 0;
    let maxDbRunningObservedDuringKlines = 0;
    const processedSymbolWorkerPairs: Array<{
      symbol: string;
      attempt: number;
    }> = [];

    adapters.binance_usdm.fetchKlines = async (
      symbol: string,
      timeframe: Timeframe
    ) => {
      // Inspect SQLite runningJobCount DURING active in-flight HTTP request
      const liveStats = db.getSmcScanQueueStats('binance_usdm');
      if (liveStats.runningJobCount > maxDbRunningObservedDuringKlines) {
        maxDbRunningObservedDuringKlines = liveStats.runningJobCount;
      }
      assert.ok(
        liveStats.runningJobCount <= 2,
        `runningJobCount (${liveStats.runningJobCount}) exceeded maxConcurrency=2 during fetchKlines(${symbol}, ${timeframe})`
      );

      await new Promise((r) => setTimeout(r, 8));

      if (symbol === 'ETHUSDT' && eth429Count === 0) {
        eth429Count++;
        throw new ExchangeApiUnavailableError(
          'HTTP 429 Too Many Requests from Binance',
          'binance_usdm',
          429,
          { isRateLimited: true }
        );
      }

      if (symbol === 'SYM005USDT') {
        failSymbolAttempts++;
        throw new ExchangeApiUnavailableError(
          'HTTP 429 Persistent Rate Limit on SYM005USDT',
          'binance_usdm',
          429,
          { isRateLimited: true }
        );
      }

      if (timeframe === '5m') {
        processedSymbolWorkerPairs.push({
          symbol,
          attempt: processedSymbolWorkerPairs.length + 1,
        });
      }

      const isBullish = symbol === 'BTCUSDT';
      const klines = buildClosedKlines(timeframe, isBullish, false);
      return {
        klines,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines)',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    };

    // Instantiate TWO concurrent workers against the same SQLite DB to test multi-worker lock/lease safety
    const workerA = new SmcBatchScanService({
      adapters,
      db,
      telegramDryRunAdapter: notifier,
      workerId: 'worker-A',
      config: {
        maxConcurrency: 2,
        maxRequestsPerMinute: 400,
        maxRetries: 2,
        baseBackoffMs: 120,
        batchSize: 12,
      },
    });

    const workerB = new SmcBatchScanService({
      adapters,
      db,
      telegramDryRunAdapter: notifier,
      workerId: 'worker-B',
      recoverOnStart: false,
      config: {
        maxConcurrency: 2,
        maxRequestsPerMinute: 400,
        maxRetries: 2,
        baseBackoffMs: 120,
        batchSize: 12,
      },
    });

    const tickers = build524Tickers().slice(0, 6); // BTCUSDT, ETHUSDT, SOLUSDT, SYM003USDT, SYM004USDT, SYM005USDT
    const liveProv: DataProvenance = {
      source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };
    const preScan = runMarketScan(tickers, liveProv, {
      minQuoteVolume24h: 0,
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    workerA.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SYM003USDT'],
      windowKey: 'test-exec-multiworker',
      pruneUniverse: true,
    });

    // Run workerA and workerB simultaneously
    await Promise.all([
      workerA.processNextBatch('binance_usdm', 'live', 6),
      workerB.processNextBatch('binance_usdm', 'live', 6),
    ]);

    // Item 1: runningJobCount in SQLite NEVER exceeded maxConcurrency = 2 even with 2 workers and batchSize = 12
    assert.ok(
      maxDbRunningObservedDuringKlines <= 2,
      `Expected maxDbRunningObservedDuringKlines <= 2, got ${maxDbRunningObservedDuringKlines}`
    );
    assert.ok(workerA.maxRunningJobCountObserved <= 2);
    assert.ok(workerB.maxRunningJobCountObserved <= 2);

    // Item 5: ETHUSDT and SYM005USDT hit HTTP 429 and entered RATE_LIMITED
    const statusAfterBatch1 = workerA.getStatus('binance_usdm', 'live');
    assert.equal(statusAfterBatch1.totalJobs, 6);
    assert.equal(statusAfterBatch1.succeededCount, 4); // BTC, SOL, SYM003, SYM004
    assert.equal(statusAfterBatch1.rateLimitedCount, 2); // ETH, SYM005
    assert.equal(statusAfterBatch1.runningJobCount, 0);
    assert.equal(statusAfterBatch1.queuedCount, 0);
    assert.equal(statusAfterBatch1.pendingCount, 2);

    // Check statistical identities on statusAfterBatch1
    assert.equal(
      statusAfterBatch1.queuedCount +
        statusAfterBatch1.runningJobCount +
        statusAfterBatch1.succeededCount +
        statusAfterBatch1.failedCount +
        statusAfterBatch1.rateLimitedCount,
      statusAfterBatch1.totalJobs
    );
    assert.equal(
      statusAfterBatch1.succeededCount,
      statusAfterBatch1.waitCount +
        statusAfterBatch1.watchCount +
        statusAfterBatch1.longCandidateCount +
        statusAfterBatch1.shortCandidateCount +
        statusAfterBatch1.highRiskCount
    );

    // Wait for backoff window (120ms) and run retry 1 (ETHUSDT succeeds on retry 1; SYM005USDT hits 429 retry 2 -> RATE_LIMITED)
    await new Promise((r) => setTimeout(r, 150));
    await workerA.processNextBatch('binance_usdm', 'live', 4);

    const statusAfterRetry1 = workerA.getStatus('binance_usdm', 'live');
    assert.equal(statusAfterRetry1.succeededCount, 5);
    assert.equal(statusAfterRetry1.rateLimitedCount, 1); // SYM005USDT at retryCount=2

    // Wait for backoff window (240ms) and run retry 2 (SYM005USDT exceeds maxRetries=2 -> transitions RUNNING => FAILED)
    await new Promise((r) => setTimeout(r, 270));
    await workerA.processNextBatch('binance_usdm', 'live', 4);

    // Item 6: Retries exceeded maxRetries -> FAILED (terminal state, NOT counted in PENDING = QUEUED + RUNNING + RATE_LIMITED)
    const statusAfterFailed = workerA.getStatus('binance_usdm', 'live');
    assert.equal(statusAfterFailed.succeededCount, 5);
    assert.equal(statusAfterFailed.failedCount, 1);
    assert.equal(statusAfterFailed.rateLimitedCount, 0);
    assert.equal(
      statusAfterFailed.pendingCount,
      statusAfterFailed.queuedCount +
        statusAfterFailed.runningJobCount +
        statusAfterFailed.rateLimitedCount
    );
    assert.equal(statusAfterFailed.pendingCount, 0); // FAILED is excluded from PENDING

    const sym005Job = statusAfterFailed.recentJobs.find(
      (j) => j.symbol === 'SYM005USDT'
    );
    assert.ok(sym005Job);
    assert.equal(sym005Job.status, 'FAILED');
    assert.ok(sym005Job.retryCount > 2);

    // Item 7: Verify SUCCEEDED job without a valid smc_scan_results row is automatically repaired to QUEUED
    db.getRawDb()
      .prepare(
        `DELETE FROM smc_scan_results WHERE exchange = 'binance_usdm' AND symbol = 'SOLUSDT'`
      )
      .run();
    const statusAfterOrphanCheck = workerA.getStatus('binance_usdm', 'live');
    assert.equal(
      statusAfterOrphanCheck.succeededCount,
      4,
      'SOLUSDT without smc_scan_results must not remain counted as SUCCEEDED'
    );
    assert.equal(
      statusAfterOrphanCheck.queuedCount,
      1,
      'SOLUSDT without smc_scan_results must be repaired back to QUEUED'
    );

    // Now allow SYM005USDT to succeed too and re-enqueue for full completion (Item 12)
    failSymbolAttempts = -999; // disable error for SYM005USDT on next run
    adapters.binance_usdm.fetchKlines = async (
      symbol: string,
      timeframe: Timeframe
    ) => {
      const klines = buildClosedKlines(
        timeframe,
        symbol === 'BTCUSDT',
        false
      );
      return {
        klines,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines)',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    };

    workerA.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      windowKey: 'test-exec-complete-window',
      pruneUniverse: true,
    });
    await workerA.processNextBatch('binance_usdm', 'live', 6);

    // Item 12: After full background scan completes, all 5 queue/pending counters must be 0
    const completedStatus = workerA.getStatus('binance_usdm', 'live');
    assert.equal(completedStatus.totalJobs, 6);
    assert.equal(completedStatus.succeededCount, 6);
    assert.equal(completedStatus.queuedCount, 0);
    assert.equal(completedStatus.runningJobCount, 0);
    assert.equal(completedStatus.failedCount, 0);
    assert.equal(completedStatus.rateLimitedCount, 0);
    assert.equal(completedStatus.pendingCount, 0);
    assert.equal(completedStatus.smcPendingCount, 0);
    assert.equal(
      completedStatus.waitCount +
        completedStatus.watchCount +
        completedStatus.longCandidateCount +
        completedStatus.shortCandidateCount +
        completedStatus.highRiskCount,
      completedStatus.succeededCount
    );

    // Item 4: Service restart recovery — simulate the latest job left in RUNNING when process crashed
    db.getRawDb()
      .prepare(
        `UPDATE smc_scan_jobs SET status = 'RUNNING', worker_id = 'crashed-worker' WHERE id = (SELECT MAX(id) FROM smc_scan_jobs WHERE exchange = 'binance_usdm' AND symbol = 'BTCUSDT')`
      )
      .run();
    db.close();

    const dbRestarted = new RadarDatabase(dbPath);
    const restartedService = new SmcBatchScanService({
      adapters,
      db: dbRestarted,
      telegramDryRunAdapter: notifier,
    });
    const statusAfterRestart = restartedService.getStatus(
      'binance_usdm',
      'live'
    );
    const recoveredJob = statusAfterRestart.recentJobs.find(
      (j) => j.symbol === 'BTCUSDT'
    );
    assert.ok(recoveredJob);
    assert.equal(
      recoveredJob.status,
      'QUEUED',
      'RUNNING job must be recovered back to QUEUED on service restart'
    );

    dbRestarted.close();
  });

  it('唯一鍵與規則版本重新評估：ruleVersion v1->v2 重新排隊、windowKey 改變重新評估、同版本同視窗防重、同 symbol 單一 RUNNING 鎖定', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'radar-phase3-reval-')
    );
    const db = new RadarDatabase(path.join(tmpDir, 'reval.sqlite'));
    const adapters = createMockAdapters();
    adapters.binance_usdm.fetchKlines = async (
      symbol: string,
      timeframe: Timeframe
    ) => ({
      klines: buildClosedKlines(timeframe, symbol === 'BTCUSDT', false),
      provenance: {
        source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines)',
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    });

    const service = new SmcBatchScanService({
      adapters,
      db,
      config: { maxConcurrency: 2, batchSize: 10 },
    });

    const tickers = build524Tickers().slice(0, 3); // BTCUSDT, ETHUSDT, SOLUSDT
    const liveProv: DataProvenance = {
      source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };
    const preScan = runMarketScan(tickers, liveProv, {
      minQuoteVolume24h: 0,
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    // 1. Enqueue and complete ruleVersion = 'v1', windowKey = 'win_100'
    const enqV1 = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      ruleVersion: 'v1',
      windowKey: 'win_100',
      pruneUniverse: true,
    });
    assert.equal(enqV1.enqueuedCount, 3);
    await service.processNextBatch('binance_usdm', 'live', 3);

    const statusV1Done = service.getStatus('binance_usdm', 'live');
    assert.equal(statusV1Done.succeededCount, 3);
    assert.equal(statusV1Done.pendingCount, 0);

    // 2. 同一 symbol 同一 ruleVersion/windowKey => 不得重複排隊
    const enqV1Dup = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      ruleVersion: 'v1',
      windowKey: 'win_100',
    });
    assert.equal(enqV1Dup.enqueuedCount, 0);
    assert.equal(enqV1Dup.skippedDuplicateCount, 3);

    // 3. ruleVersion v1 已完成 => ruleVersion v2 可以重新排隊 (且保留 v1 歷史紀錄)
    const enqV2 = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      ruleVersion: 'v2',
      windowKey: 'win_100',
    });
    assert.equal(enqV2.enqueuedCount, 3);
    const statusV2Queued = service.getStatus('binance_usdm', 'live');
    assert.equal(statusV2Queued.totalJobs, 3);
    assert.equal(statusV2Queued.queuedCount, 3);
    assert.equal(statusV2Queued.succeededCount, 0);
    assert.equal(statusV2Queued.pendingCount, 3);

    // Check BTCUSDT history has both v1 (SUCCEEDED) and v2 (QUEUED)
    const btcHistoryAfterV2Enqueue = db.listSymbolSmcJobHistory(
      'binance_usdm',
      'BTCUSDT'
    );
    assert.equal(btcHistoryAfterV2Enqueue.length, 2);
    assert.equal(btcHistoryAfterV2Enqueue[0].ruleVersion, 'v2');
    assert.equal(btcHistoryAfterV2Enqueue[0].status, 'QUEUED');
    assert.equal(btcHistoryAfterV2Enqueue[1].ruleVersion, 'v1');
    assert.equal(btcHistoryAfterV2Enqueue[1].status, 'SUCCEEDED');

    await service.processNextBatch('binance_usdm', 'live', 3);
    const statusV2Done = service.getStatus('binance_usdm', 'live');
    assert.equal(statusV2Done.succeededCount, 3);
    assert.equal(statusV2Done.pendingCount, 0);
    assert.equal(
      db.getSmcScanResult('binance_usdm', 'BTCUSDT')?.ruleVersion,
      'v2'
    );

    // 4. windowKey 改變 => 可以建立新的評估任務
    const enqWin200 = service.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers,
      candidates: preScan.candidates,
      ruleVersion: 'v2',
      windowKey: 'win_200',
    });
    assert.equal(enqWin200.enqueuedCount, 3);
    const statusWin200Queued = service.getStatus('binance_usdm', 'live');
    assert.equal(statusWin200Queued.queuedCount, 3);
    assert.equal(statusWin200Queued.pendingCount, 3);

    // 5. 同一 symbol 同時只能有一個 RUNNING job (DB partial unique index + claimNextSmcScanJobs active job lock)
    const claimed = db.claimNextSmcScanJobs(
      'binance_usdm',
      1,
      new Date().toISOString(),
      { maxConcurrency: 2, workerId: 'worker-lock-test' }
    );
    assert.equal(claimed.length, 1);
    const runningSymbol = claimed[0].symbol;

    // Attempting to force a second row of the same symbol to RUNNING in SQLite must throw UNIQUE constraint error
    assert.throws(() => {
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_jobs SET status = 'RUNNING' WHERE exchange = 'binance_usdm' AND symbol = ? AND id != ?`
        )
        .run(runningSymbol, claimed[0].id);
    }, /UNIQUE constraint failed/);

    db.close();
  });

  it('10 & Original 9-15: /api/scan 與 /api/smc-scan/status 與 /api/smc-scan/result/:symbol 的 snapshot 統計完全一致且維持安全規則', async () => {
    const prov: DataProvenance = {
      source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };

    // Unclosed K-lines (isClosed === false) are strictly excluded from SMC analysis
    const klines5mWithUnclosed = buildClosedKlines('5m', false, true);
    const klines15mWithUnclosed = buildClosedKlines('15m', false, true);
    const klines1hWithUnclosed = buildClosedKlines('1h', false, true);
    const klines4hWithUnclosed = buildClosedKlines('4h', false, true);

    const smcWithUnclosed = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': klines5mWithUnclosed,
        '15m': klines15mWithUnclosed,
        '1h': klines1hWithUnclosed,
        '4h': klines4hWithUnclosed,
      },
      openInterest: 500_000,
      isLowLiquidity: false,
      extremeFunding: false,
      lowLiquidityHighVolatility: false,
      requireFullMultiTimeframe: true,
      provenance: prov,
    });
    const smcClosedOnly = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': klines5mWithUnclosed.filter((k) => k.isClosed),
        '15m': klines15mWithUnclosed.filter((k) => k.isClosed),
        '1h': klines1hWithUnclosed.filter((k) => k.isClosed),
        '4h': klines4hWithUnclosed.filter((k) => k.isClosed),
      },
      openInterest: 500_000,
      isLowLiquidity: false,
      extremeFunding: false,
      lowLiquidityHighVolatility: false,
      requireFullMultiTimeframe: true,
      provenance: prov,
    });
    assert.equal(smcWithUnclosed.actionState, smcClosedOnly.actionState);
    assert.equal(smcWithUnclosed.unclosedKlineIgnoredCount, 1);

    // 15m volume baseline uses strictly the 30 confirmed K-lines BEFORE the current bar
    const closed15m = klines15mWithUnclosed.filter((k) => k.isClosed);
    const confirmed15mVols = closed15m.map((k) => k.quoteVolume);
    const { currentVolume, historicalVolumes, evaluatedBarIndex } =
      extractPriorConfirmedBaselineWindow(
        confirmed15mVols,
        confirmed15mVols.length - 1,
        30
      );
    assert.ok(currentVolume !== null);
    assert.equal(historicalVolumes.length, 30);
    assert.equal(evaluatedBarIndex, confirmed15mVols.length - 1);
    const hvMetrics = evaluateHistoricalVolumeAnomaly({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      currentVolume,
      historicalVolumes,
      volumeTimeframe: '15m',
      baseProvenance: prov,
    });
    assert.equal(hvMetrics.sampleCount, 30);
    assert.equal(hvMetrics.aggregationWindow, '15m_CONFIRMED_KLINE_30_BARS');

    // API integration with snapshotAt, statsVersion, totalJobs, runningJobCount, inFlightRequestCount
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase3-api-'));
    const app = await createApp({
      skipViteMiddleware: true,
      customDbPath: path.join(tmpDir, 'api.sqlite'),
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Notification Dry-Run blocks PENDING, WAIT, WATCH, HIGH RISK, stale=true, fallback=true, or waitReasons.length > 0
      const pendingNotifyRes = await fetch(`${baseUrl}/api/notify/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'TELEGRAM',
          payload: {
            symbol: 'BTCUSDT',
            category: '多頭候選',
            actionState: 'PENDING',
            finalTradeSignal: 'NONE',
            smcEvaluationStatus: 'PENDING',
            stale: false,
            fallback: false,
            waitReasons: [],
            score: 80,
            confirmedEvidences: ['Test'],
            missingData: [],
            riskWarnings: [],
            source: 'Binance',
            fetchedAt: new Date().toISOString(),
            safetyBanner: 'PAPER ONLY',
          },
        }),
      });
      const pendingNotifyBody = await pendingNotifyRes.json();
      assert.equal(pendingNotifyBody.record.status, 'NON_CANDIDATE_BLOCKED');

      // Item 10: Verify /api/scan, /api/smc-scan/status, and /api/smc-scan/result/:symbol return consistent snapshot fields
      const scanRes = await fetch(
        `${baseUrl}/api/scan?mode=demo&exchange=demo_synthetic`
      );
      assert.equal(scanRes.status, 200);
      const scanBody = await scanRes.json();
      assert.equal(typeof scanBody.snapshotAt, 'string');
      assert.equal(typeof scanBody.statsVersion, 'number');
      assert.equal(typeof scanBody.totalJobs, 'number');
      assert.equal(typeof scanBody.runningJobCount, 'number');
      assert.equal(typeof scanBody.inFlightRequestCount, 'number');
      assert.ok(scanBody.smcScanStatus);
      assert.equal(scanBody.snapshotAt, scanBody.smcScanStatus.snapshotAt);
      assert.equal(scanBody.statsVersion, scanBody.smcScanStatus.statsVersion);
      assert.equal(
        scanBody.smcPendingCount,
        scanBody.smcScanStatus.pendingCount
      );
      assert.equal(scanBody.smcWaitCount, scanBody.smcScanStatus.waitCount);
      assert.equal(scanBody.smcWatchCount, scanBody.smcScanStatus.watchCount);
      assert.equal(
        scanBody.smcLongCandidateCount,
        scanBody.smcScanStatus.longCandidateCount
      );
      assert.equal(
        scanBody.smcShortCandidateCount,
        scanBody.smcScanStatus.shortCandidateCount
      );
      assert.equal(
        scanBody.smcHighRiskCount,
        scanBody.smcScanStatus.highRiskCount
      );
      assert.equal(
        scanBody.smcScanStatus.succeededCount,
        scanBody.smcWaitCount +
          scanBody.smcWatchCount +
          scanBody.smcLongCandidateCount +
          scanBody.smcShortCandidateCount +
          scanBody.smcHighRiskCount
      );

      const statusRes = await fetch(
        `${baseUrl}/api/smc-scan/status?mode=demo&exchange=demo_synthetic`
      );
      assert.equal(statusRes.status, 200);
      const statusBody = await statusRes.json();
      assert.equal(typeof statusBody.snapshotAt, 'string');
      assert.equal(typeof statusBody.statsVersion, 'number');
      assert.equal(typeof statusBody.totalJobs, 'number');
      assert.equal(typeof statusBody.runningJobCount, 'number');
      assert.equal(typeof statusBody.inFlightRequestCount, 'number');
      assert.ok(
        statusBody.runningJobCount <= statusBody.config.maxConcurrency
      );
      assert.equal(
        statusBody.queuedCount +
          statusBody.runningJobCount +
          statusBody.succeededCount +
          statusBody.failedCount +
          statusBody.rateLimitedCount,
        statusBody.totalJobs
      );

      const resultRes = await fetch(
        `${baseUrl}/api/smc-scan/result/BTCUSDT?mode=demo&exchange=demo_synthetic`
      );
      assert.equal(resultRes.status, 200);
      const resultBody = await resultRes.json();
      assert.equal(typeof resultBody.snapshotAt, 'string');
      assert.equal(typeof resultBody.statsVersion, 'number');
      assert.equal(typeof resultBody.totalJobs, 'number');
      assert.equal(typeof resultBody.runningJobCount, 'number');
      assert.equal(typeof resultBody.inFlightRequestCount, 'number');

      // Live failure returns HTTP 503 and NEVER mixes in Demo data
      const failScanRes = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=binance_usdm`,
        {
          headers: { 'x-simulate-exchange-failure': '1' },
        }
      );
      assert.equal(failScanRes.status, 503);
      const failScanBody = await failScanRes.json();
      assert.equal(failScanBody.provenance.isDemo, false);
      assert.equal(Array.isArray(failScanBody.candidates), true);
      assert.equal(failScanBody.candidates.length, 0);

      // Order placement endpoints strictly return HTTP 404
      for (const orderPath of [
        '/api/order',
        '/api/orders',
        '/api/trade/execute',
        '/fapi/v1/order',
      ]) {
        const orderRes = await fetch(`${baseUrl}${orderPath}`, {
          method: 'POST',
        });
        assert.equal(orderRes.status, 404);
      }

      // Safety constants remain strictly enforced
      assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
      assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(
        TRADING_SAFETY_FLAGS.executionPolicy,
        'NEVER AUTO-PLACE ORDERS'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
