import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import {
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import {
  DataProvenance,
  Kline,
  MarketTicker,
  Timeframe,
} from '../src/types/market.ts';

function buildLiveProvenance(nowMs = Date.now()): DataProvenance {
  return {
    source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
    fetchedAt: new Date(nowMs).toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
}

function buildConfirmedKlines(
  timeframe: Timeframe,
  count = 60,
  nowMs = Date.now()
): Kline[] {
  const stepMap: Record<Timeframe, number> = {
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
  };
  const step = stepMap[timeframe];
  const latestClosedEnd = Math.floor(nowMs / step) * step - 1;
  const klines: Kline[] = [];
  let price = 100;
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = latestClosedEnd - i * step;
    const openTime = closeTime - step + 1;
    const open = price;
    const close = price * 1.001;
    klines.push({
      openTime,
      closeTime,
      open,
      high: close * 1.002,
      low: open * 0.998,
      close,
      volume: 1000,
      quoteVolume: 100_000,
      isClosed: true,
    });
    price = close;
  }
  return klines;
}

function buildTicker(symbol: string, nowMs = Date.now()): MarketTicker {
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    lastPrice: 100,
    priceChangePercent24h: 3.2,
    quoteVolume24h: 45_000_000,
    bidPrice: 99.99,
    askPrice: 100.01,
    spreadPercent: 0.02,
    openInterest: 300_000,
    openInterestValue: 30_000_000,
    fundingRate: 0.0001,
    nextFundingTime: nowMs + 4 * 3600_000,
    provenance: buildLiveProvenance(nowMs),
  };
}

test('Phase 19 Stability Suite: Same-15m-Window Stability, Startup Grace & Local Rate-Limit Pacing', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'data', 'test_p19_'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test(
    '1. Expired 5m candle cache within the same 15m window never wipes SUCCEEDED results or resets runSingleCycle back to 0/N',
    async () => {
      const db = new RadarDatabase(path.join(tmpDir, 'p19_same_win.sqlite'));
      const nowMs = Date.now();
      const tickers = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((s) =>
        buildTicker(s, nowMs)
      );
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 1.2,
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchOpenInterest: async (_sym, lastPrice) => ({
          openInterest: 300_000,
          openInterestValue: 300_000 * (lastPrice || 100),
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchKlines: async (_sym, tf) => ({
          klines: buildConfirmedKlines(tf, 60, nowMs),
          provenance: buildLiveProvenance(nowMs),
        }),
      };

      const scanner = new SmcBatchScanService({
        db,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        config: {
          maxConcurrency: 2,
          maxJobConcurrency: 2,
          maxHttpConcurrency: 4,
          maxRequestsPerMinute: 600,
          batchSize: 10,
        },
      });
      const monitor = new PaperShadowMonitor({
        radarDb: db,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        smcBatchScanner: scanner,
        exchange: 'binance_usdm',
      });

      const currentWin = scanner.computeWindowKey();
      const preScan = runMarketScan(tickers, buildLiveProvenance(nowMs), {
        minQuoteVolume24h: 0,
        mode: 'live',
        exchange: 'binance_usdm',
        volumeTimeframe: '15m',
      });

      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: currentWin,
        pruneUniverse: true,
      });
      await scanner.processNextBatch('binance_usdm', 'live', 10);

      const completed = scanner.getStatus('binance_usdm', 'live');
      assert.equal(completed.evaluatedCount, 3);
      assert.equal(completed.pendingCount, 0);

      // Simulate 5m TTL expiration 6 minutes into the same 15m bar
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_candles_cache SET expires_at = ? WHERE exchange = 'binance_usdm' AND timeframe = '5m'`
        )
        .run(new Date(Date.now() - 60_000).toISOString());

      // Explicit enqueueMarketUniverse with forceRefresh=false in same window must preserve SUCCEEDED results
      const reEnq = scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: currentWin,
        forceRefresh: false,
        pruneUniverse: true,
      });
      assert.equal(reEnq.enqueuedCount, 0);
      assert.equal(reEnq.skippedDuplicateCount, 3);

      // PaperShadowMonitor.runSingleCycle must also preserve 3/3 completed in same 15m bucket
      await monitor.runSingleCycle({ maxSymbolsToEvaluate: 1 });
      const afterCycle = scanner.getStatus('binance_usdm', 'live');
      assert.equal(afterCycle.evaluatedCount, 3);
      assert.equal(afterCycle.pendingCount, 0);

      monitor.stop();
      scanner.stop();
      db.close();
    }
  );

  await t.test(
    '2. Boot/resume with stale pre-restart QUEUED timestamps suppresses false WORKER_NO_PROGRESS during resume grace window',
    async () => {
      const db = new RadarDatabase(path.join(tmpDir, 'p19_resume_grace.sqlite'));
      const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers: [],
          btcChange24h: 0,
          provenance: buildLiveProvenance(),
        }),
        fetchOpenInterest: async () => ({
          openInterest: 100_000,
          openInterestValue: 100_000,
          provenance: buildLiveProvenance(),
        }),
        fetchKlines: async () => ({
          klines: buildConfirmedKlines('15m', 60),
          provenance: buildLiveProvenance(),
        }),
      };

      const scanner = new SmcBatchScanService({
        db,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        config: {
          stalledThresholdMs: 45_000,
        },
      });

      db.enqueueSmcScanJobs(
        [
          {
            symbol: 'BTCUSDT',
            exchange: 'binance_usdm',
            priority: 60000,
            priorityTier: 1,
            priorityLabel: '1_WATCHLIST',
            priorityClass: 'FAST_LANE',
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey: scanner.computeWindowKey(),
            requestedAt: oldIso,
            queueEnteredAt: oldIso,
            startedAt: null,
            completedAt: null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        ],
        false,
        true
      );
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_jobs SET queue_entered_at = ?, last_progress_at = ? WHERE symbol = 'BTCUSDT'`
        )
        .run(oldIso, oldIso);

      // Resume without autoProcessLoop so job stays QUEUED while we check immediate startup health
      scanner.resumeScan('binance_usdm', 'live', false);
      const immediateHealth = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        immediateHealth.stalledReasons.includes('WORKER_NO_PROGRESS'),
        false,
        'Resume grace window must prevent immediate false WORKER_NO_PROGRESS on boot'
      );

      // Explicitly calling setSimulatedHealthState clears real resume grace so stall diagnostics still work
      scanner.setSimulatedHealthState('binance_usdm', {
        workerState: 'RUNNING',
        lastProgressAt: oldIso,
        lastJobCompletedAt: oldIso,
      });
      const simHealth = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        simHealth.stalledReasons.includes('WORKER_NO_PROGRESS'),
        true
      );

      scanner.stop();
      db.close();
    }
  );

  await t.test(
    '3. Local maxRequestsPerMinute guard keeps jobs RATE_LIMITED instead of permanently FAILED or inflating consecutiveExchangeErrors',
    async () => {
      const db = new RadarDatabase(path.join(tmpDir, 'p19_local_rl.sqlite'));
      const nowMs = Date.now();
      const tickers = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((s) =>
        buildTicker(s, nowMs)
      );
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 1.0,
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchOpenInterest: async (_sym, lastPrice) => ({
          openInterest: 200_000,
          openInterestValue: 200_000 * (lastPrice || 100),
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchKlines: async (_sym, tf) => ({
          klines: buildConfirmedKlines(tf, 60, nowMs),
          provenance: buildLiveProvenance(nowMs),
        }),
      };

      // Budget allows at most 1 job (4-5 HTTP calls), 2nd job hits local guard if claimed
      const scanner = new SmcBatchScanService({
        db,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        config: {
          maxConcurrency: 1,
          maxJobConcurrency: 1,
          maxHttpConcurrency: 2,
          maxRequestsPerMinute: 6,
          batchSize: 3,
          maxRetries: 1,
          baseBackoffMs: 100,
        },
      });

      const preScan = runMarketScan(tickers, buildLiveProvenance(nowMs), {
        minQuoteVolume24h: 0,
        mode: 'live',
        exchange: 'binance_usdm',
        volumeTimeframe: '15m',
      });
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: scanner.computeWindowKey(),
        pruneUniverse: true,
      });

      // Run multiple ticks back-to-back while 1-min window is full
      for (let i = 0; i < 4; i++) {
        await scanner.processNextBatch('binance_usdm', 'live', 3);
      }

      const status = scanner.getStatus('binance_usdm', 'live');
      const health = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(status.failedCount, 0, 'Local pacing guard must never mark jobs FAILED');
      assert.equal(
        health.stalledReasons.includes('EXCHANGE_API_UNAVAILABLE'),
        false,
        'Local pacing guard must never trigger EXCHANGE_API_UNAVAILABLE'
      );

      scanner.stop();
      db.close();
    }
  );

  await t.test(
    '4. 60s sliding local rate-limit cooldown suppresses false WORKER_NO_PROGRESS at 48s while genuine stalls still trigger',
    async () => {
      const db = new RadarDatabase(path.join(tmpDir, 'p19_rl_stall_grace.sqlite'));
      const baseMs = Date.now() - 48_000;
      const baseIso = new Date(baseMs).toISOString();
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers: [],
          btcChange24h: 0,
          provenance: buildLiveProvenance(baseMs),
        }),
        fetchOpenInterest: async () => ({
          openInterest: 100_000,
          openInterestValue: 100_000,
          provenance: buildLiveProvenance(baseMs),
        }),
        fetchKlines: async () => ({
          klines: buildConfirmedKlines('15m', 60, baseMs),
          provenance: buildLiveProvenance(baseMs),
        }),
      };

      const scanner = new SmcBatchScanService({
        db,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        config: {
          maxRequestsPerMinute: 10,
          stalledThresholdMs: 45_000,
        },
      });

      db.enqueueSmcScanJobs(
        [
          {
            symbol: 'ETHUSDT',
            exchange: 'binance_usdm',
            priority: 50000,
            priorityTier: 2,
            priorityLabel: '2_HIGH_PRIORITY',
            priorityClass: 'FAST_LANE',
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey: scanner.computeWindowKey(),
            requestedAt: baseIso,
            queueEnteredAt: baseIso,
            startedAt: null,
            completedAt: null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        ],
        false,
        true
      );
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_jobs SET queue_entered_at = ?, last_progress_at = ? WHERE symbol = 'ETHUSDT'`
        )
        .run(baseIso, baseIso);

      // Start worker (sets resume grace, then advance check time to +48s past resume grace)
      scanner.resumeScan('binance_usdm', 'live', false);
      // Force resume anchor older than 48s so only the local rate-limit cooldown guard protects against WORKER_NO_PROGRESS
      (
        scanner as unknown as {
          lastRealResumeAtMsByExchange: Map<string, number>;
          recordRequestIssued: (nowMs?: number, exchange?: 'binance_usdm') => void;
        }
      ).lastRealResumeAtMsByExchange.set('binance_usdm', baseMs);
      for (let i = 0; i < 8; i++) {
        (
          scanner as unknown as {
            recordRequestIssued: (nowMs?: number, exchange?: 'binance_usdm') => void;
          }
        ).recordRequestIssued(baseMs + i * 100, 'binance_usdm');
      }

      const duringCooldown = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        duringCooldown.stalledReasons.includes('WORKER_NO_PROGRESS'),
        false,
        'Active 60s local rate-limit cooldown at +48s must not trigger false WORKER_NO_PROGRESS'
      );
      assert.equal(duringCooldown.stalledSuspected, false);

      // Without simulated/real timestamps (empty requestTimestamps), genuine 48s stall must still trigger WORKER_NO_PROGRESS
      const dbEmpty = new RadarDatabase(path.join(tmpDir, 'p19_rl_stall_empty.sqlite'));
      const scannerEmpty = new SmcBatchScanService({
        db: dbEmpty,
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        config: {
          maxRequestsPerMinute: 10,
          stalledThresholdMs: 45_000,
        },
      });
      dbEmpty.enqueueSmcScanJobs(
        [
          {
            symbol: 'ETHUSDT',
            exchange: 'binance_usdm',
            priority: 50000,
            priorityTier: 2,
            priorityLabel: '2_HIGH_PRIORITY',
            priorityClass: 'FAST_LANE',
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey: scannerEmpty.computeWindowKey(),
            requestedAt: baseIso,
            queueEnteredAt: baseIso,
            startedAt: null,
            completedAt: null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        ],
        false,
        true
      );
      dbEmpty
        .getRawDb()
        .prepare(
          `UPDATE smc_scan_jobs SET queue_entered_at = ?, last_progress_at = ? WHERE symbol = 'ETHUSDT'`
        )
        .run(baseIso, baseIso);
      scannerEmpty.resumeScan('binance_usdm', 'live', false);
      (
        scannerEmpty as unknown as {
          lastRealResumeAtMsByExchange: Map<string, number>;
        }
      ).lastRealResumeAtMsByExchange.set('binance_usdm', baseMs);

      const genuineStall = scannerEmpty.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        genuineStall.stalledReasons.includes('WORKER_NO_PROGRESS'),
        true,
        'Genuine 48s no-progress without local rate-limit cooldown must still trigger WORKER_NO_PROGRESS'
      );

      scanner.stop();
      scannerEmpty.stop();
      db.close();
      dbEmpty.close();
    }
  );
});
