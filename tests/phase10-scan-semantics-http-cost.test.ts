import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import {
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import { createApp } from '../server.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  Timeframe,
} from '../src/types/market.ts';

function buildConfirmedKlines(
  timeframe: Timeframe,
  count = 60,
  nowMs = Date.now()
): Kline[] {
  const intervalMsMap: Record<Timeframe, number> = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  };
  const step = intervalMsMap[timeframe];
  const latestClosedEnd = Math.floor(nowMs / step) * step - 1;
  const klines: Kline[] = [];
  let price = 100;
  for (let i = count - 1; i >= 0; i--) {
    const closeTime = latestClosedEnd - i * step;
    const openTime = closeTime - step + 1;
    const open = price;
    const close = price * 1.002;
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    price = close;
    klines.push({
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 10,
      quoteVolume: 100_000 + i * 2500,
      isClosed: true,
    });
  }
  return klines;
}

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

function buildTicker(
  symbol: string,
  nowMs = Date.now(),
  includeOi = false
): MarketTicker {
  const prov = buildLiveProvenance(nowMs);
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    lastPrice: 105,
    priceChangePercent24h: 4.5,
    quoteVolume24h: 65_000_000,
    bidPrice: 104.99,
    askPrice: 105.01,
    spreadPercent: 0.02,
    openInterest: includeOi ? 420_000 : null,
    openInterestValue: includeOi ? 44_100_000 : null,
    fundingRate: 0.0001,
    nextFundingTime: nowMs + 4 * 3600_000,
    provenance: prov,
  };
}

test('Phase 10 Verification Suite: Scan Completion Semantics, HTTP Cost Transparency, Cycle Separation & 524-Symbol Invariants', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'data', 'test_p10_'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1, 2, 3. Scan completion semantics & cycle history separation
  await t.test(
    '1, 2 & 3. pendingCount > 0 sets fullUniverseCompletionDuration=null & RUNNING; pendingCount=0 sets COMPLETED & duration; next cycle preserves lastCompletedCycleDuration separately',
    async () => {
      const dbPath = path.join(tmpDir, 'p10_semantics.sqlite');
      const db = new RadarDatabase(dbPath);
      const nowMs = Date.now();
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
      const tickers = symbols.map((s) => buildTicker(s, nowMs, false));

      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 2.0,
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
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        db,
        config: {
          maxConcurrency: 2,
          maxJobConcurrency: 2,
          maxHttpConcurrency: 4,
          maxRequestsPerMinute: 600,
          batchSize: 2,
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
        windowKey: 'win_cycle_1',
        pruneUniverse: true,
      });

      // Item 1: While pendingCount > 0, fullUniverseStatus = RUNNING, fullUniverseCompletionDuration = null, cycleCompletedAt = null
      const statusPending = scanner.getStatus('binance_usdm', 'live');
      assert.equal(statusPending.pendingCount, 4);
      assert.equal(statusPending.fullUniverseStatus, 'RUNNING');
      assert.equal(statusPending.cycleStatus, 'RUNNING');
      assert.equal(statusPending.fullUniverseCompletionDuration, null);
      assert.equal(statusPending.cycleCompletedAt, null);
      assert.equal(statusPending.lastCompletedCycleId, null);
      assert.equal(statusPending.lastCompletedCycleDuration, null);

      // Process only 1 batch (2 symbols) -> still 2 pending
      await scanner.processNextBatch('binance_usdm', 'live', 2);
      const statusPartial = scanner.getStatus('binance_usdm', 'live');
      assert.equal(statusPartial.evaluatedCount, 2);
      assert.equal(statusPartial.pendingCount, 2);
      assert.equal(statusPartial.fullUniverseStatus, 'RUNNING');
      assert.equal(statusPartial.fullUniverseCompletionDuration, null);
      assert.equal(statusPartial.cycleCompletedAt, null);

      // Process remaining 2 symbols -> all 4 succeeded
      await scanner.processNextBatch('binance_usdm', 'live', 2);
      const statusCompleted = scanner.getStatus('binance_usdm', 'live');
      assert.equal(statusCompleted.pendingCount, 0);
      assert.equal(statusCompleted.queuedCount, 0);
      assert.equal(statusCompleted.runningJobCount, 0);
      assert.equal(statusCompleted.failedCount, 0);
      assert.equal(statusCompleted.rateLimitedCount, 0);
      assert.equal(statusCompleted.evaluatedCount, statusCompleted.totalSymbols);
      assert.equal(statusCompleted.fullUniverseStatus, 'COMPLETED');
      assert.equal(statusCompleted.cycleStatus, 'COMPLETED');
      assert.equal(typeof statusCompleted.fullUniverseCompletionDuration, 'number');
      assert.ok((statusCompleted.fullUniverseCompletionDuration ?? -1) >= 0);
      assert.equal(typeof statusCompleted.cycleCompletedAt, 'string');

      const cycle1Id = statusCompleted.cycleId;
      const cycle1Duration = statusCompleted.fullUniverseCompletionDuration!;

      // Item 3: Start Cycle 2 in a new window -> current cycle must have fullUniverseCompletionDuration = null, while lastCompletedCycleDuration holds Cycle 1's duration
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: 'win_cycle_2',
        forceRefresh: true,
        pruneUniverse: true,
      });

      const statusCycle2Running = scanner.getStatus('binance_usdm', 'live');
      assert.notEqual(statusCycle2Running.cycleId, cycle1Id);
      assert.equal(statusCycle2Running.pendingCount, 4);
      assert.equal(statusCycle2Running.fullUniverseStatus, 'RUNNING');
      assert.equal(statusCycle2Running.cycleStatus, 'RUNNING');
      assert.equal(statusCycle2Running.fullUniverseCompletionDuration, null);
      assert.equal(statusCycle2Running.cycleCompletedAt, null);
      assert.equal(statusCycle2Running.lastCompletedCycleId, cycle1Id);
      assert.equal(statusCycle2Running.lastCompletedCycleDuration, cycle1Duration);

      scanner.stop();
      db.close();
    }
  );

  // 4 & 5. HTTP Request Cost Transparency & Warm Cache Deduction (0 HTTP calls)
  await t.test(
    '4 & 5. totalExpectedHttpRequests matches actual HTTP calls (5 endpoints/symbol when OI not in ticker) and warm cache deducts 100% of cached endpoints with 0 HTTP calls',
    async () => {
      const dbPath = path.join(tmpDir, 'p10_http_cost.sqlite');
      const db = new RadarDatabase(dbPath);
      const nowMs = Date.now();
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      // Tickers do NOT include openInterest -> requires 4 kline endpoints + 1 OI endpoint = 5 HTTP requests/symbol
      const tickers = symbols.map((s) => buildTicker(s, nowMs, false));

      let actualHttpCalls = 0;
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 2.0,
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchOpenInterest: async (_sym, lastPrice) => {
          actualHttpCalls++;
          return {
            openInterest: 450_000,
            openInterestValue: 450_000 * (lastPrice || 100),
            provenance: buildLiveProvenance(nowMs),
          };
        },
        fetchKlines: async (_sym, tf) => {
          actualHttpCalls++;
          return {
            klines: buildConfirmedKlines(tf, 60, nowMs),
            provenance: buildLiveProvenance(nowMs),
          };
        },
      };

      const scanner = new SmcBatchScanService({
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        db,
        config: {
          maxConcurrency: 3,
          maxJobConcurrency: 3,
          maxHttpConcurrency: 4,
          maxRequestsPerMinute: 240,
          batchSize: 3,
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
        windowKey: 'win_http_cold',
        pruneUniverse: true,
      });

      const statusColdStart = scanner.getStatus('binance_usdm', 'live');
      assert.equal(statusColdStart.httpRequestsPerSymbol, 5);
      assert.deepEqual(statusColdStart.httpEndpointsBreakdown, {
        '5m': 1,
        '15m': 1,
        '1h': 1,
        '4h': 1,
        openInterest: 1,
        fundingRate: 0,
      });
      assert.equal(statusColdStart.completedHttpRequests, 0);
      assert.equal(statusColdStart.remainingHttpRequests, 15);
      assert.equal(statusColdStart.totalExpectedHttpRequests, 15);
      assert.equal(statusColdStart.maxHttpConcurrency, 4);
      assert.equal(statusColdStart.maxRequestsPerMinute, 240);
      assert.ok((statusColdStart.estimatedRemainingDuration ?? 0) > 0);
      assert.equal(
        statusColdStart.estimateStatus,
        'ESTIMATING_WITH_CACHE_DEDUCTION'
      );

      // Run all 3 jobs
      await scanner.processNextBatch('binance_usdm', 'live', 3);
      const statusColdDone = scanner.getStatus('binance_usdm', 'live');
      assert.equal(actualHttpCalls, 15);
      assert.equal(statusColdDone.completedHttpRequests, 15);
      assert.equal(statusColdDone.remainingHttpRequests, 0);
      assert.equal(statusColdDone.totalExpectedHttpRequests, 15);
      assert.equal(statusColdDone.cacheMode, 'COLD');
      assert.equal(statusColdDone.cacheHitCount, 0);
      assert.equal(statusColdDone.cacheMissCount, 3);
      assert.equal(statusColdDone.estimatedRemainingDuration, 0);
      assert.equal(statusColdDone.estimateStatus, 'COMPLETED');

      // Item 5: Enqueue a new window while all 3 symbols are warm in SQLite cache (without forceRefresh)
      actualHttpCalls = 0;
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: 'win_http_warm',
        forceRefresh: false,
        pruneUniverse: true,
      });

      const statusWarmStart = scanner.getStatus('binance_usdm', 'live');
      assert.equal(statusWarmStart.pendingCount, 3);
      // Warm cache deducts 100% of cached endpoints -> remainingHttpRequests = 0!
      assert.equal(statusWarmStart.remainingHttpRequests, 0);
      assert.equal(statusWarmStart.completedHttpRequests, 0);
      assert.equal(statusWarmStart.totalExpectedHttpRequests, 0);
      assert.equal(statusWarmStart.cacheMode, 'WARM');

      await scanner.processNextBatch('binance_usdm', 'live', 3);
      const statusWarmDone = scanner.getStatus('binance_usdm', 'live');
      assert.equal(actualHttpCalls, 0, 'Warm cache scan must issue 0 HTTP calls');
      assert.equal(statusWarmDone.completedHttpRequests, 0);
      assert.equal(statusWarmDone.remainingHttpRequests, 0);
      assert.equal(statusWarmDone.totalExpectedHttpRequests, 0);
      assert.equal(statusWarmDone.cacheMode, 'WARM');
      assert.equal(statusWarmDone.cacheHitCount, 3);
      assert.equal(statusWarmDone.cacheMissCount, 0);
      assert.equal(statusWarmDone.fullUniverseStatus, 'COMPLETED');

      scanner.stop();
      db.close();
    }
  );

  // 6, 7 & 9. Fast Lane isolation from Bulk, 429 Exponential Backoff consistency, and Layered SLA separation
  await t.test(
    '6, 7 & 9. Fast Lane is never starved by Bulk, 429 backoff preserves statistical identities, and Cold-Start vs Warm-Cache vs Fast Lane SLAs are separated',
    async () => {
      const dbPath = path.join(tmpDir, 'p10_fastlane_429_sla.sqlite');
      const db = new RadarDatabase(dbPath);
      const nowMs = Date.now();
      const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i + 1}USDT`);
      const tickers = symbols.map((s) => buildTicker(s, nowMs, true));

      let inject429OnceForSym8 = true;
      const adapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 2.0,
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchOpenInterest: async (_sym, lastPrice) => ({
          openInterest: 420_000,
          openInterestValue: 420_000 * (lastPrice || 100),
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchKlines: async (sym, tf) => {
          if (sym === 'SYM8USDT' && tf === '5m' && inject429OnceForSym8) {
            inject429OnceForSym8 = false;
            throw new ExchangeApiUnavailableError(
              'HTTP 429 Too Many Requests',
              'Binance USD-M Futures Public REST API (fapi.binance.com)',
              429,
              { isRateLimited: true }
            );
          }
          return {
            klines: buildConfirmedKlines(tf, 60, nowMs),
            provenance: buildLiveProvenance(nowMs),
          };
        },
      };

      const scanner = new SmcBatchScanService({
        adapters: {
          binance_usdm: adapter,
          bybit_linear: adapter,
          bingx_swap: adapter,
          demo_synthetic: adapter,
        },
        db,
        config: {
          maxConcurrency: 3,
          maxJobConcurrency: 3,
          maxHttpConcurrency: 4,
          maxRequestsPerMinute: 600,
          batchSize: 4,
          maxRetries: 3,
          baseBackoffMs: 20,
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
        watchlistSymbols: ['SYM1USDT', 'SYM2USDT'],
        windowKey: 'win_fl_429',
        pruneUniverse: true,
      });

      // Process batches until SYM8USDT hits 429 and retries
      for (let i = 0; i < 6; i++) {
        await scanner.processNextBatch('binance_usdm', 'live', 4);
        const st = scanner.getStatus('binance_usdm', 'live');
        // Item 7: Statistical identities hold at every step (even during 429 backoff)
        assert.equal(st.statsConsistency, 'VALID');
        assert.equal(
          st.queuedCount +
            st.runningJobCount +
            st.succeededCount +
            st.failedCount +
            st.rateLimitedCount,
          st.totalJobs
        );
        assert.equal(
          st.evaluatedCount,
          st.waitCount +
            st.watchCount +
            st.longCandidateCount +
            st.shortCandidateCount +
            st.highRiskCount
        );
        assert.equal(st.evaluatedCount, st.succeededCount);
        await new Promise((r) => setTimeout(r, 30));
      }

      const finalSt = scanner.getStatus('binance_usdm', 'live');
      assert.equal(finalSt.fullUniverseStatus, 'COMPLETED');
      assert.equal(finalSt.statsConsistency, 'VALID');
      assert.ok((finalSt.rateLimitCount ?? 0) >= 1);

      // Item 6: Verify Tier 6 Bulk tasks were never misclassified as Fast Lane
      assert.equal(
        finalSt.priorityExecutionBreakdown?.tier6MisclassifiedAsFastLaneCount,
        0
      );
      assert.ok(
        (finalSt.priorityExecutionBreakdown?.fastLaneClassCount ?? 0) >= 2
      );

      // Item 9: Cold-Start Priority SLA = MET, while Cold-Start Full Universe SLA = NOT_MET (when <500 contracts or >120s)
      assert.equal(finalSt.coldStartPrioritySLA, 'MET');
      assert.equal(finalSt.coldStartFullUniverseSLA, 'NOT_MET');

      scanner.stop();
      db.close();
    }
  );

  // 10. 524-Symbol Full Universe Statistical Identities & Corruption Detection
  await t.test(
    '10. 524-symbol full-universe statistical identities hold (statsConsistency=VALID), and corrupting a state triggers statsConsistency=INVALID & fullUniverseStatus=FAILED',
    async () => {
      const dbPath = path.join(tmpDir, 'p10_524_identities.sqlite');
      const db = new RadarDatabase(dbPath);
      const nowIso = new Date().toISOString();

      // Enqueue 524 symbols
      const jobs = Array.from({ length: 524 }, (_, idx) => {
        const isFast = idx < 25;
        return {
          symbol: `COIN${idx + 1}USDT`,
          exchange: 'binance_usdm' as ExchangeId,
          priority: isFast ? 60000 - idx : 10000 - idx,
          priorityTier: (isFast ? 1 : 6) as 1 | 6,
          priorityLabel: isFast ? '1_WATCHLIST' : '6_REMAINING_USDT_PERP',
          priorityClass: (isFast ? 'FAST_LANE' : 'BULK') as 'FAST_LANE' | 'BULK',
          status: 'QUEUED' as const,
          ruleVersion: 'v1.0.0-smc-ict-deterministic',
          windowKey: 'win_524_test',
          requestedAt: nowIso,
          queueEnteredAt: nowIso,
          startedAt: null,
          jobClaimedAt: null,
          smcEvaluationStartedAt: null,
          completedAt: null,
          smcEvaluationCompletedAt: null,
          queueWaitMs: null,
          prewarmWaitMs: 0,
          httpRequestLatencyMs: null,
          smcCalculationLatencyMs: null,
          dbWriteLatencyMs: null,
          smcEvaluationLatencyMs: null,
          rateLimitWaitMs: null,
          detectionLatencyMs: null,
          cacheHit: false,
          cacheMiss: false,
          reusedCache: false,
          workerRole: (isFast ? 'FAST_LANE' : 'BULK') as 'FAST_LANE' | 'BULK',
          executionWorker: null,
          isFastLane: isFast,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        };
      });

      db.enqueueSmcScanJobs(jobs, true, true);
      const snapInitial = db.getAtomicSmcSnapshot('binance_usdm');
      assert.equal(snapInitial.totalSymbols, 524);
      assert.equal(snapInitial.totalJobs, 524);
      assert.equal(snapInitial.pendingCount, 524);
      assert.equal(snapInitial.evaluatedCount, 0);
      assert.equal(snapInitial.statsConsistency, 'VALID');
      assert.equal(snapInitial.fullUniverseStatus, 'RUNNING');
      assert.equal(snapInitial.fullUniverseCompletionDuration, null);

      // Corrupt one evaluated result's smc_action_state to an invalid value and verify statsConsistency becomes INVALID
      const claimed = db.claimNextSmcScanJobs('binance_usdm', 1, nowIso, {
        maxConcurrency: 4,
        workerId: 'w1',
        workerRole: 'FAST_LANE',
      });
      assert.equal(claimed.length, 1);
      db.saveSmcScanResult(
        {
          symbol: claimed[0].symbol,
          exchange: 'binance_usdm',
          smcEvaluationStatus: 'EVALUATED',
          smcActionState: 'WAIT',
          finalTradeSignal: 'NONE',
          marketRadarCategory: '準備觀察',
          evaluatedAt: nowIso,
          dataFetchedAt: nowIso,
          fetchedAt: nowIso,
          windowKey: 'win_524_test',
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          priorityClass: 'FAST_LANE',
          workerRole: 'FAST_LANE',
          executionWorker: 'FAST_LANE_WORKER',
          freshnessSeconds: 0,
          stale: false,
          fallback: false,
          missingData: [],
          source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
          isDemo: false,
          ruleVersion: 'v1.0.0-smc-ict-deterministic',
          waitReasons: ['測試等待原因'],
          smcAnalysis: undefined,
        },
        claimed[0].id
      );

      // Corrupt the action state in SQLite directly
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_results SET smc_action_state = 'CORRUPTED_ACTION_STATE' WHERE symbol = ?`
        )
        .run(claimed[0].symbol);

      const snapCorrupted = db.getAtomicSmcSnapshot('binance_usdm');
      assert.equal(snapCorrupted.statsConsistency, 'INVALID');
      assert.equal(snapCorrupted.fullUniverseStatus, 'FAILED');
      assert.equal(snapCorrupted.fullUniverseCompletionDuration, null);
      assert.equal(snapCorrupted.cycleCompletedAt, null);

      db.close();
    }
  );

  // 8, 11, 12, 13. 503 failure isolation, Live Paper no-lookahead entry, 0 external notifications, and 404 on all order routes
  await t.test(
    '8, 11, 12 & 13. 503 never falls back to Demo; Live Paper entry never uses retroactive open price; 0 external notifications; all order paths return 404',
    async () => {
      const dbPath = path.join(tmpDir, 'p10_safety_paper.sqlite');
      const radarDb = new RadarDatabase(dbPath);
      const paperDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

      // Item 11: Signal detected AFTER nextBar.openTime must be marked ENTRY_WINDOW_MISSED and never retroactively open at nextBar.open
      const signalBarCloseMs = Date.parse('2026-10-26T02:59:59.999Z');
      const klinesWithNextOpen = buildConfirmedKlines(
        '15m',
        60,
        signalBarCloseMs + 1
      );
      klinesWithNextOpen.push({
        openTime: signalBarCloseMs + 1,
        closeTime: signalBarCloseMs + 900_000,
        open: 105.5,
        high: 106.2,
        low: 105.1,
        close: 105.9,
        volume: 15_000,
        quoteVolume: 1_500_000,
        isClosed: false,
      });
      const lateDetectedIso = '2026-10-26T03:05:00.000Z';

      const lateRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mrun_p10',
        scanRunId: 'srun_p10',
        scanCycleId: 'scyc_p10_late',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: lateDetectedIso,
        evaluatedAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        klines: klinesWithNextOpen,
        atr14: 0.5,
        openInterest: 500_000,
        fundingRate: 0.0001,
        provenance: buildLiveProvenance(Date.parse(lateDetectedIso)),
        waitReasons: [],
        evidences: ['CHoCH:Confirmed', 'FVG:Confirmed', 'Sweep:Confirmed'],
        score: 88,
        isBacktest: false,
      });

      assert.ok(lateRes.signal);
      assert.equal(lateRes.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(lateRes.signal.entryWindowStatus, '原始進場窗口已錯過');
      assert.equal(lateRes.signal.entryReferencePrice, null);

      // Item 8, 12 & 13: Verify HTTP 503 on live failure, 0 external requests, and 404 on all order placement routes
      const failingAdapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => {
          throw new ExchangeApiUnavailableError(
            'Simulated upstream 503 failure',
            'Binance USD-M Futures Public REST API (fapi.binance.com)',
            503
          );
        },
        fetchOpenInterest: async () => {
          throw new ExchangeApiUnavailableError(
            'Simulated upstream 503 failure',
            'Binance USD-M Futures Public REST API (fapi.binance.com)',
            503
          );
        },
        fetchKlines: async () => {
          throw new ExchangeApiUnavailableError(
            'Simulated upstream 503 failure',
            'Binance USD-M Futures Public REST API (fapi.binance.com)',
            503
          );
        },
      };

      const app = await createApp({
        customDbPath: path.join(tmpDir, 'p10_app_503.sqlite'),
        skipViteMiddleware: true,
        customAdapters: {
          binance_usdm: failingAdapter,
        },
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res503 = await fetch(
          `${baseUrl}/api/scan?mode=live&exchange=binance_usdm`
        );
        assert.equal(res503.status, 503);
        const body503 = (await res503.json()) as Record<string, unknown>;
        assert.equal(body503.mode, 'live');
        assert.equal(body503.isDemo, false);
        assert.equal(body503.fallback, false);
        assert.equal(body503.apiError, '即時資料不可用');
        assert.deepEqual(body503.candidates, []);

        const outboxRes = await fetch(
          `${baseUrl}/api/notification-sandbox/outbox`
        );
        assert.equal(outboxRes.status, 200);
        const outboxBody = (await outboxRes.json()) as Record<string, unknown>;
        assert.equal(outboxBody.externalTelegramRequestsCount, 0);
        assert.equal(outboxBody.externalTradingViewRequestsCount, 0);

        const forbiddenOrderRoutes = [
          '/api/order',
          '/api/orders',
          '/api/trade',
          '/api/binance/order',
          '/api/bybit/order',
          '/api/bingx/order',
        ];
        for (const route of forbiddenOrderRoutes) {
          const orderRes = await fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY' }),
          });
          assert.equal(
            orderRes.status,
            404,
            `Order route ${route} must return 404`
          );
        }
      } finally {
        const sc = app.locals.smcBatchScanner as
          | SmcBatchScanService
          | undefined;
        sc?.stop();
        const appDb = app.locals.radarDb as RadarDatabase | undefined;
        appDb?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      radarDb.close();
    }
  );

  // 14. 5-API Atomic Unification (/api/scan, /api/smc-scan/status, /api/paper-monitor/status, /api/paper-monitor/report, /api/validation/phase7-report)
  await t.test(
    '14. All 5 APIs share identical snapshotAt, statsVersion, cycleId, evaluatedCount, pendingCount, failedCount, rateLimitedCount, statsConsistency, fullUniverseStatus, and cacheMode',
    async () => {
      const nowMs = Date.now();
      const tickers = [
        buildTicker('BTCUSDT', nowMs, false),
        buildTicker('ETHUSDT', nowMs, false),
        buildTicker('SOLUSDT', nowMs, false),
      ];
      const liveMockAdapter: ExchangeAdapter = {
        id: 'binance_usdm',
        displayName: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        enabled: true,
        isDemo: false,
        status: 'LIVE',
        fetchMarketSnapshot: async () => ({
          exchange: 'binance_usdm',
          tickers,
          btcChange24h: 1.5,
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchOpenInterest: async (_sym, lastPrice) => ({
          openInterest: 500_000,
          openInterestValue: 500_000 * (lastPrice || 100),
          provenance: buildLiveProvenance(nowMs),
        }),
        fetchKlines: async (_sym, tf) => ({
          klines: buildConfirmedKlines(tf, 60, nowMs),
          provenance: buildLiveProvenance(nowMs),
        }),
      };

      const app = await createApp({
        customDbPath: path.join(tmpDir, 'p10_5api_unified.sqlite'),
        skipViteMiddleware: true,
        customAdapters: {
          binance_usdm: liveMockAdapter,
        },
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        // Trigger cold-start scan and process all 3 jobs synchronously
        const startRes = await fetch(`${baseUrl}/api/smc-scan/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: 'binance_usdm',
            mode: 'live',
            processBatchNow: true,
            batchLimit: 10,
          }),
        });
        assert.equal(startRes.status, 200);

        // Fetch all 5 APIs
        const [scanRes, smcRes, pmStatusRes, pmReportRes, phase7Res] =
          await Promise.all([
            fetch(`${baseUrl}/api/scan?mode=live&exchange=binance_usdm`).then(
              (r) => r.json()
            ),
            fetch(
              `${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`
            ).then((r) => r.json()),
            fetch(`${baseUrl}/api/paper-monitor/status`).then((r) => r.json()),
            fetch(`${baseUrl}/api/paper-monitor/report?window=24h`).then((r) =>
              r.json()
            ),
            fetch(`${baseUrl}/api/validation/phase7-report`).then((r) =>
              r.json()
            ),
          ]);

        const apis = [
          { name: '/api/scan', data: scanRes },
          { name: '/api/smc-scan/status', data: smcRes },
          { name: '/api/paper-monitor/status', data: pmStatusRes },
          { name: '/api/paper-monitor/report', data: pmReportRes },
          { name: '/api/validation/phase7-report', data: phase7Res },
        ];

        const ref = smcRes;
        assert.equal(ref.fullUniverseStatus, 'COMPLETED');
        assert.equal(ref.statsConsistency, 'VALID');
        assert.equal(ref.totalSymbols, 3);
        assert.equal(ref.evaluatedCount, 3);
        assert.equal(ref.pendingCount, 0);
        assert.equal(ref.failedCount, 0);
        assert.equal(ref.rateLimitedCount, 0);
        assert.equal(ref.cacheMode, 'COLD');
        assert.equal(ref.completedHttpRequests, 15);
        assert.equal(ref.totalExpectedHttpRequests, 15);
        assert.equal(ref.remainingHttpRequests, 0);

        for (const api of apis) {
          const d = api.data;
          assert.equal(d.snapshotAt, ref.snapshotAt, `${api.name} snapshotAt`);
          assert.equal(
            d.statsVersion,
            ref.statsVersion,
            `${api.name} statsVersion`
          );
          assert.equal(d.cycleId, ref.cycleId, `${api.name} cycleId`);
          assert.equal(
            d.evaluatedCount,
            ref.evaluatedCount,
            `${api.name} evaluatedCount`
          );
          assert.equal(
            d.pendingCount,
            ref.pendingCount,
            `${api.name} pendingCount`
          );
          assert.equal(
            d.failedCount,
            ref.failedCount,
            `${api.name} failedCount`
          );
          assert.equal(
            d.rateLimitedCount,
            ref.rateLimitedCount,
            `${api.name} rateLimitedCount`
          );
          assert.equal(
            d.statsConsistency,
            ref.statsConsistency,
            `${api.name} statsConsistency`
          );
          assert.equal(
            d.fullUniverseStatus,
            ref.fullUniverseStatus,
            `${api.name} fullUniverseStatus`
          );
          assert.equal(d.cacheMode, 'COLD', `${api.name} cacheMode`);
          assert.equal(
            String(d.cycleId).includes('_warm_'),
            false,
            `${api.name} cold cycleId must not contain _warm_`
          );
          assert.equal(
            d.coldStartFullUniverseSLA,
            'NOT_MET',
            `${api.name} coldStartFullUniverseSLA`
          );
          // Identity 1
          assert.equal(
            d.evaluatedCount +
              d.pendingCount +
              d.failedCount +
              d.rateLimitedCount,
            d.totalSymbols,
            `${api.name} identity 1`
          );
          // Identity 2
          assert.equal(
            d.waitCount +
              d.watchCount +
              d.highRiskCount +
              d.longCandidateCount +
              d.shortCandidateCount,
            d.evaluatedCount,
            `${api.name} identity 2`
          );
        }

        // Now trigger a warm-cache scan without forceRefresh
        const warmStartRes = await fetch(`${baseUrl}/api/smc-scan/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: 'binance_usdm',
            mode: 'live',
            forceRefresh: false,
            processBatchNow: true,
            batchLimit: 10,
          }),
        });
        assert.equal(warmStartRes.status, 200);
        const warmStatus = await warmStartRes.json();
        assert.equal(warmStatus.cacheMode, 'WARM');
        assert.equal(
          String(warmStatus.cycleId).includes('_warm_'),
          true,
          'warm cycleId must contain _warm_'
        );
        assert.equal(warmStatus.totalExpectedHttpRequests, 0);
        assert.equal(warmStatus.completedHttpRequests, 0);
        assert.equal(warmStatus.remainingHttpRequests, 0);
        assert.equal(warmStatus.cacheHitCount, 3);
        assert.equal(warmStatus.cacheMissCount, 0);
      } finally {
        const sc = app.locals.smcBatchScanner as
          | SmcBatchScanService
          | undefined;
        sc?.stop();
        const appDb = app.locals.radarDb as RadarDatabase | undefined;
        appDb?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
