import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { ExchangeId, Timeframe } from '../src/types/market.ts';

function createMockLiveAdapter(
  exchange: ExchangeId = 'binance_usdm'
): ExchangeAdapter {
  const demo = new DemoExchangeAdapter();
  return {
    id: exchange,
    displayName: 'Mock Binance Live USD-M',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      const snap = await demo.fetchMarketSnapshot();
      const nowIso = new Date().toISOString();
      return {
        tickers: snap.tickers.map((t) => ({
          ...t,
          exchange,
          provenance: {
            source: 'Mock Binance Live REST',
            fetchedAt: nowIso,
            stale: false,
            fallback: false,
            missingData: [],
            isDemo: false,
          },
        })),
        provenance: {
          source: 'Mock Binance Live REST',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
      const res = await demo.fetchKlines(symbol, timeframe, limit);
      const nowIso = new Date().toISOString();
      return {
        klines: res.klines,
        provenance: {
          source: 'Mock Binance Live Klines REST',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchOpenInterest(symbol: string, referencePrice?: number) {
      const res = await demo.fetchOpenInterest(symbol, referencePrice);
      const nowIso = new Date().toISOString();
      return {
        openInterest: res.openInterest,
        openInterestValue: res.openInterestValue,
        provenance: {
          source: 'Mock Binance Live OI REST',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
  };
}

describe('Phase 16: SMC PENDING 進度追蹤、背景 Worker 健康度與卡住診斷 (14 Required Scenarios)', () => {
  let tmpDir: string;
  const serverUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase16-test-'));
  });

  after(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1 & 2. PENDING 原因分類正確 & PENDING 統計恆等式成立 (含不一致時標記 pendingBreakdownConsistency = INVALID)', () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p16-breakdown.sqlite'));
    const adapter = createMockLiveAdapter('binance_usdm');
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
        batchSize: 3,
        stalledThresholdMs: 30_000,
      },
    });

    const nowMs = Date.parse('2026-06-15T12:00:00.000Z');
    const nowIso = new Date(nowMs).toISOString();

    const symbols = [
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
      'SUIUSDT',
      'AAVEUSDT',
      'LINKUSDT',
      'DOGEUSDT',
      'XRPUSDT',
    ];
    db.enqueueSmcScanJobs(
      symbols.map((sym, idx) => ({
        symbol: sym,
        exchange: 'binance_usdm' as ExchangeId,
        priority: 100 - idx,
        priorityTier: (idx < 3 ? 1 : 6) as 1 | 6,
        priorityLabel: idx < 3 ? '1_WATCHLIST' : '6_REMAINING_UNIVERSE',
        priorityClass: idx < 3 ? ('FAST_LANE' as const) : ('BULK' as const),
        status: 'QUEUED' as const,
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_p16_1',
        cycleId: 'cyc_phase16_test1',
        requestedAt: nowIso,
        queueEnteredAt: nowIso,
        startedAt: null,
        completedAt: null,
        lastError: null,
        retryCount: 0,
        nextRetryAt: null,
      })),
      true
    );

    const jobs = db.listSmcScanJobs('binance_usdm', 50);
    assert.equal(jobs.length, 8);

    const bySym = new Map(jobs.map((j) => [j.symbol, j]));

    // 1. BTCUSDT -> RUNNING
    db.claimNextSmcScanJobs('binance_usdm', 1, nowIso, {
      maxConcurrency: 2,
      workerId: 'w-test',
      preferredSymbol: 'BTCUSDT',
    });

    // 2. ETHUSDT -> WAITING_FOR_CACHE
    db.setSmcJobPendingReason('binance_usdm', 'ETHUSDT', 'WAITING_FOR_CACHE', {
      lastProgressAt: nowIso,
    });

    // 3. SOLUSDT -> WAITING_FOR_RATE_LIMIT (retryCount = 1)
    db.markSmcJobRateLimited(
      bySym.get('SOLUSDT')!.id!,
      'HTTP 429 Too Many Requests',
      1,
      new Date(nowMs + 10_000).toISOString()
    );

    // 4. SUIUSDT -> RETRY_SCHEDULED (retryCount = 2)
    db.markSmcJobRateLimited(
      bySym.get('SUIUSDT')!.id!,
      'Retry scheduled after transient timeout',
      2,
      new Date(nowMs + 5_000).toISOString()
    );

    // 5. AAVEUSDT -> FAILED_RETRYABLE
    db.markSmcJobFailedRetryable(
      bySym.get('AAVEUSDT')!.id!,
      'Transient 502 Bad Gateway',
      1,
      new Date(nowMs + 8_000).toISOString(),
      nowIso
    );

    // 6. LINKUSDT -> WAITING_FOR_NEXT_BATCH
    db.setSmcJobPendingReason(
      'binance_usdm',
      'LINKUSDT',
      'WAITING_FOR_NEXT_BATCH',
      {
        lastProgressAt: nowIso,
      }
    );

    // 7 & 8. DOGEUSDT, XRPUSDT remain QUEUED

    const progress = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      nowMs + 1000
    );

    // Verify all 7 pending reasons are classified accurately
    assert.equal(progress.runningJobCount, 1);
    assert.equal(progress.waitingForCacheCount, 1);
    assert.equal(progress.waitingForRateLimitCount, 1);
    assert.equal(progress.retryScheduledCount, 1);
    assert.equal(progress.failedRetryableCount, 1);
    assert.equal(progress.waitingForNextBatchCount, 1);
    assert.equal(progress.pendingReasonCounts.QUEUED, 2);
    assert.equal(progress.pendingReasonCounts.WAITING_FOR_NEXT_BATCH, 1);
    assert.equal(progress.queuedCount, 3); // QUEUED (2) + WAITING_FOR_NEXT_BATCH (1)

    // Verify Section 四 identity:
    // pendingCount = queuedCount + runningJobCount + waitingForCacheCount + waitingForRateLimitCount + retryScheduledCount + failedRetryableCount
    const rhsSum =
      progress.queuedCount +
      progress.runningJobCount +
      progress.waitingForCacheCount +
      progress.waitingForRateLimitCount +
      progress.retryScheduledCount +
      progress.failedRetryableCount;
    assert.equal(progress.pendingCount, 8);
    assert.equal(progress.pendingCount, rhsSum);
    assert.equal(progress.pendingBreakdownConsistency, 'VALID');

    // Verify every PENDING symbol record contains all required Section 一 fields
    for (const pRec of progress.pendingSymbols) {
      assert.ok(pRec.symbol);
      assert.equal(pRec.exchange, 'binance_usdm');
      assert.ok(pRec.cycleId);
      assert.ok(pRec.queuedAt);
      assert.ok('startedAt' in pRec);
      assert.ok('lastHeartbeatAt' in pRec);
      assert.ok('lastProgressAt' in pRec);
      assert.ok(pRec.pendingReason);
      assert.equal(typeof pRec.retryCount, 'number');
      assert.ok('nextRetryAt' in pRec);
      assert.ok(
        pRec.priorityClass === 'FAST_LANE' || pRec.priorityClass === 'BULK'
      );
      assert.ok(
        pRec.executionWorker === 'FAST_LANE_WORKER' ||
          pRec.executionWorker === 'BULK_WORKER'
      );
      assert.ok(Array.isArray(pRec.missingTimeframes));
      assert.ok(Array.isArray(pRec.missingData));
      assert.ok(pRec.cacheMode);
    }

    // Corrupt a pending_reason in SQLite and verify pendingBreakdownConsistency = 'INVALID'
    db.setSmcJobPendingReason(
      'binance_usdm',
      'DOGEUSDT',
      'CORRUPTED_REASON' as any,
      { lastProgressAt: nowIso }
    );
    const corruptedProgress = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      nowMs + 2000
    );
    assert.equal(corruptedProgress.pendingBreakdownConsistency, 'INVALID');
    assert.notEqual(corruptedProgress.cycleStatus, 'COMPLETED');

    scanner.stop();
    db.close();
  });

  it('3, 4, 5, 6, 7 & 8. 卡住診斷規則 (WORKER_NO_PROGRESS, LEASE_EXPIRED, CACHE_PREWARM_STALLED, RATE_LIMIT_BACKOFF, EXCHANGE_API_UNAVAILABLE) 與正常慢速評估不誤判', () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p16-stalled.sqlite'));
    const adapter = createMockLiveAdapter('binance_usdm');
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
        stalledThresholdMs: 30_000,
      },
    });

    const baseMs = Date.parse('2026-06-15T14:00:00.000Z');
    const baseIso = new Date(baseMs).toISOString();

    db.enqueueSmcScanJobs(
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT'].map((sym, idx) => ({
        symbol: sym,
        exchange: 'binance_usdm' as ExchangeId,
        priority: 100 - idx,
        priorityTier: 1 as const,
        priorityLabel: '1_WATCHLIST',
        priorityClass: 'FAST_LANE' as const,
        status: 'QUEUED' as const,
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_p16_stalled',
        cycleId: 'cyc_phase16_stalled',
        requestedAt: baseIso,
        queueEnteredAt: baseIso,
        startedAt: null,
        completedAt: null,
        lastError: null,
        retryCount: 0,
        nextRetryAt: null,
      })),
      true
    );

    // Scenario 8: 正常慢速評估不會誤判為卡住 (workerState = RUNNING, elapsed 10s < stalledThresholdMs 30s)
    scanner.setSimulatedHealthState('binance_usdm', {
      workerState: 'RUNNING',
      isPrewarming: false,
      consecutiveExchangeErrors: 0,
      stalledThresholdMs: 30_000,
    });
    const normalProgress = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 10_000
    );
    assert.equal(normalProgress.stalledSuspected, false);
    assert.deepEqual(normalProgress.stalledReasons, []);
    assert.equal(normalProgress.diagnosisLabel, '正常背景評估中');

    // Scenario 3: WORKER_NO_PROGRESS (workerState = RUNNING, 45s elapsed with no job completion)
    const noProgressCheck = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 45_000
    );
    assert.equal(noProgressCheck.stalledSuspected, true);
    assert.ok(noProgressCheck.stalledReasons.includes('WORKER_NO_PROGRESS'));
    assert.equal(noProgressCheck.diagnosisLabel, '背景掃描疑似卡住');

    // Scenario 4: LEASE_EXPIRED (claim BTCUSDT with 15s lease, check at +25s)
    db.claimNextSmcScanJobs('binance_usdm', 1, baseIso, {
      maxConcurrency: 2,
      workerId: 'w-lease',
      leaseDurationMs: 15_000,
      preferredSymbol: 'BTCUSDT',
    });
    const leaseExpiredCheck = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 20_000
    );
    assert.equal(leaseExpiredCheck.stalledSuspected, true);
    assert.ok(leaseExpiredCheck.stalledReasons.includes('LEASE_EXPIRED'));

    // Scenario 5: CACHE_PREWARM_STALLED (isPrewarming = true, waitingForCacheCount > 0, no prewarm progress for 40s)
    scanner.setSimulatedHealthState('binance_usdm', {
      isPrewarming: true,
      lastPrewarmProgressAt: baseIso,
    });
    const prewarmStalledCheck = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 40_000
    );
    assert.equal(prewarmStalledCheck.stalledSuspected, true);
    assert.ok(
      prewarmStalledCheck.stalledReasons.includes('CACHE_PREWARM_STALLED')
    );
    scanner.setSimulatedHealthState('binance_usdm', {
      isPrewarming: false,
      lastPrewarmProgressAt: null,
    });

    // Scenario 6: RATE_LIMIT_BACKOFF (abnormal backoff duration > stalledThresholdMs)
    const jobs = db.listSmcScanJobs('binance_usdm', 20);
    const ethJob = jobs.find((j) => j.symbol === 'ETHUSDT')!;
    db.markSmcJobRateLimited(
      ethJob.id!,
      'HTTP 429 rate limit exceeded',
      2,
      new Date(baseMs + 120_000).toISOString() // 120s backoff > 30s threshold
    );
    const rateLimitCheck = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 10_000
    );
    assert.equal(rateLimitCheck.stalledSuspected, true);
    assert.ok(rateLimitCheck.stalledReasons.includes('RATE_LIMIT_BACKOFF'));

    // Scenario 7: EXCHANGE_API_UNAVAILABLE (exchange API continuously returning 503 errors)
    const solJob = jobs.find((j) => j.symbol === 'SOLUSDT')!;
    db.markSmcJobFailedRetryable(
      solJob.id!,
      'Binance Futures REST API HTTP 503 Service Unavailable',
      2,
      new Date(baseMs + 20_000).toISOString()
    );
    scanner.setSimulatedHealthState('binance_usdm', {
      consecutiveExchangeErrors: 3,
    });
    const apiUnavailableCheck = scanner.getProgressAndHealth(
      'binance_usdm',
      'live',
      baseMs + 10_000
    );
    assert.equal(apiUnavailableCheck.stalledSuspected, true);
    assert.ok(
      apiUnavailableCheck.stalledReasons.includes('EXCHANGE_API_UNAVAILABLE')
    );
    assert.equal(apiUnavailableCheck.exchangeApiHealth, 'UNAVAILABLE');

    scanner.stop();
    db.close();
  });

  it('9, 10, 11 & 12. PENDING 不會轉為 WAIT/WATCH/候選，且 retry-stuck 不產生重複 RUNNING、不使用 Demo fallback、不繞過限流', () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p16-retry.sqlite'));
    const adapter = createMockLiveAdapter('binance_usdm');
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
        stalledThresholdMs: 20_000,
      },
    });

    const t0 = Date.parse('2026-06-15T16:00:00.000Z');
    const t0Iso = new Date(t0).toISOString();

    db.enqueueSmcScanJobs(
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT'].map((sym, idx) => ({
        symbol: sym,
        exchange: 'binance_usdm' as ExchangeId,
        priority: 100 - idx,
        priorityTier: 1 as const,
        priorityLabel: '1_WATCHLIST',
        priorityClass: 'FAST_LANE' as const,
        status: 'QUEUED' as const,
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_p16_retry',
        cycleId: 'cyc_phase16_retry_1',
        requestedAt: t0Iso,
        queueEnteredAt: t0Iso,
        startedAt: null,
        completedAt: null,
        lastError: null,
        retryCount: 0,
        nextRetryAt: null,
      })),
      true
    );

    const jobsBefore = db.listSmcScanJobs('binance_usdm', 20);
    const bySym = new Map(jobsBefore.map((j) => [j.symbol, j]));

    // BTCUSDT: Active RUNNING lease (expires at t0 + 60s -> NOT expired at t0 + 25s)
    db.claimNextSmcScanJobs('binance_usdm', 1, t0Iso, {
      maxConcurrency: 2,
      workerId: 'w-active',
      leaseDurationMs: 60_000,
      preferredSymbol: 'BTCUSDT',
    });

    // ETHUSDT: Expired RUNNING lease (expires at t0 + 10s -> EXPIRED at t0 + 25s)
    db.claimNextSmcScanJobs('binance_usdm', 1, t0Iso, {
      maxConcurrency: 2,
      workerId: 'w-expired',
      leaseDurationMs: 10_000,
      preferredSymbol: 'ETHUSDT',
    });

    // SOLUSDT: Rate-limited with ACTIVE backoff (nextRetryAt = t0 + 60s -> NOT ready at t0 + 25s, must NOT bypass rate limit)
    db.markSmcJobRateLimited(
      bySym.get('SOLUSDT')!.id!,
      'HTTP 429 active backoff',
      1,
      new Date(t0 + 60_000).toISOString()
    );

    // SUIUSDT: Rate-limited with EXPIRED backoff (nextRetryAt = t0 + 15s -> ready at t0 + 25s)
    db.markSmcJobRateLimited(
      bySym.get('SUIUSDT')!.id!,
      'HTTP 429 backoff elapsed',
      1,
      new Date(t0 + 15_000).toISOString()
    );

    // Scenario 9: Verify PENDING is never converted into WAIT, WATCH, or candidate signals even when stuck
    const statusAtStuck = scanner.getStatus('binance_usdm', 'live');
    assert.equal(statusAtStuck.pendingCount, 4);
    assert.equal(statusAtStuck.waitCount, 0);
    assert.equal(statusAtStuck.watchCount, 0);
    assert.equal(statusAtStuck.longCandidateCount, 0);
    assert.equal(statusAtStuck.shortCandidateCount, 0);
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT']) {
      const symRes = scanner.getSymbolResult('binance_usdm', sym, 'live');
      assert.equal(symRes.smcEvaluationStatus, 'PENDING');
      assert.equal(symRes.smcActionState, 'PENDING');
      assert.equal(symRes.finalTradeSignal, 'NONE');
    }

    // Execute retry-stuck at t0 + 25s
    const retryRes = scanner.retryStuckJobs({
      exchange: 'binance_usdm',
      mode: 'live',
      nowMs: t0 + 25_000,
      stalledThresholdMs: 20_000,
    });

    // Scenario 11: Never uses Demo fallback
    assert.equal(retryRes.exchange, 'binance_usdm');
    assert.equal(retryRes.mode, 'live');
    assert.ok(retryRes.cycleId);
    const expectedCycleId = retryRes.cycleId;

    // Scenario 10: Active RUNNING BTCUSDT was skipped (no duplicate RUNNING task created)
    assert.ok(retryRes.skippedActiveRunningSymbols.includes('BTCUSDT'));
    assert.ok(!retryRes.retriedSymbols.includes('BTCUSDT'));

    // Scenario 12: Active backoff SOLUSDT was skipped (rate limit backoff never bypassed)
    assert.ok(retryRes.skippedActiveBackoffSymbols.includes('SOLUSDT'));
    assert.ok(!retryRes.retriedSymbols.includes('SOLUSDT'));

    // ETHUSDT (expired lease) and SUIUSDT (elapsed rate-limit backoff) were safely retried
    assert.ok(retryRes.retriedSymbols.includes('ETHUSDT'));
    assert.ok(retryRes.retriedSymbols.includes('SUIUSDT'));
    assert.equal(retryRes.retriedCount, 2);

    // Verify original cycleId preserved and retryCount incremented
    const jobsAfter = db.listSmcScanJobs('binance_usdm', 20);
    assert.equal(jobsAfter.length, 4); // No duplicate rows created
    const ethAfter = jobsAfter.find((j) => j.symbol === 'ETHUSDT')!;
    const suiAfter = jobsAfter.find((j) => j.symbol === 'SUIUSDT')!;
    const btcAfter = jobsAfter.find((j) => j.symbol === 'BTCUSDT')!;
    assert.equal(ethAfter.status, 'QUEUED');
    assert.equal(ethAfter.cycleId, expectedCycleId);
    assert.equal(ethAfter.retryCount, 1);
    assert.equal(suiAfter.status, 'QUEUED');
    assert.equal(suiAfter.cycleId, expectedCycleId);
    assert.equal(suiAfter.retryCount, 2);
    assert.equal(btcAfter.status, 'RUNNING');

    scanner.stop();
    db.close();
  });

  it('13 & 14. HTTP API 驗證 (/api/smc-scan/progress, /health, /pending-reasons, /stuck-jobs, /retry-stuck) 且外部通知 = 0、下單 API 全數 HTTP 404', async () => {
    const [progressRes, healthRes, reasonsRes, stuckRes, retryRes, pqStatusRes] =
      await Promise.all([
        fetch(`${serverUrl}/api/smc-scan/progress`),
        fetch(`${serverUrl}/api/smc-scan/health`),
        fetch(`${serverUrl}/api/smc-scan/pending-reasons`),
        fetch(`${serverUrl}/api/smc-scan/stuck-jobs`),
        fetch(`${serverUrl}/api/smc-scan/retry-stuck`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exchange: 'binance_usdm', mode: 'live' }),
        }),
        fetch(`${serverUrl}/api/paper-quality/status`),
      ]);

    assert.equal(progressRes.status, 200);
    assert.equal(healthRes.status, 200);
    assert.equal(reasonsRes.status, 200);
    assert.equal(stuckRes.status, 200);
    assert.equal(retryRes.status, 200);
    assert.equal(pqStatusRes.status, 200);

    const progressJson = await progressRes.json();
    const healthJson = await healthRes.json();
    const reasonsJson = await reasonsRes.json();
    const stuckJson = await stuckRes.json();
    const retryJson = await retryRes.json();
    const pqStatusJson = await pqStatusRes.json();

    // Verify safety flags
    assert.equal(progressJson.safety.mode, 'PAPER ONLY');
    assert.equal(progressJson.safety.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(
      progressJson.safety.executionPolicy,
      'NEVER AUTO-PLACE ORDERS'
    );

    // Verify required Section 二 fields on /api/smc-scan/progress and /api/smc-scan/health
    for (const payload of [progressJson, healthJson, reasonsJson, stuckJson]) {
      assert.ok('cycleId' in payload);
      assert.ok('cycleStatus' in payload);
      assert.ok('workerState' in payload);
      assert.ok('scannerHealth' in payload);
      assert.ok('queueHealth' in payload);
      assert.ok('exchangeApiHealth' in payload);
      assert.equal(typeof payload.totalSymbols, 'number');
      assert.equal(typeof payload.evaluatedCount, 'number');
      assert.equal(typeof payload.pendingCount, 'number');
      assert.equal(typeof payload.queuedCount, 'number');
      assert.equal(typeof payload.runningJobCount, 'number');
      assert.equal(typeof payload.failedCount, 'number');
      assert.equal(typeof payload.rateLimitedCount, 'number');
      assert.ok('lastJobCompletedAt' in payload);
      assert.ok('lastProgressAt' in payload);
      assert.equal(typeof payload.progressRatePerMinute, 'number');
      assert.equal(typeof payload.estimatedRemainingDuration, 'number');
      assert.ok('oldestPendingAgeMs' in payload);
      assert.equal(typeof payload.stalledJobCount, 'number');
      assert.equal(typeof payload.stalledThresholdMs, 'number');
      assert.ok(payload.pendingReasonCounts);
      assert.equal(typeof payload.fastLanePendingCount, 'number');
      assert.equal(typeof payload.bulkPendingCount, 'number');
      assert.equal(typeof payload.statsVersion, 'number');
      assert.ok(payload.snapshotAt);
      assert.equal(payload.pendingBreakdownConsistency, 'VALID');
      assert.deepEqual(payload.pendingNotices, [
        'PENDING 不等於 WAIT',
        'PENDING 不代表 SMC 通過',
        'PENDING 不代表 SMC 被拒絕',
      ]);
    }

    assert.equal(typeof retryJson.retriedCount, 'number');
    assert.ok(Array.isArray(retryJson.retriedSymbols));

    // Scenario 13: External Telegram/TradingView requests strictly 0
    assert.equal(pqStatusJson.externalTelegramRequestsCount, 0);
    assert.equal(pqStatusJson.externalTradingViewRequestsCount, 0);

    // Scenario 14: All order APIs strictly return HTTP 404
    const orderEndpoints = [
      '/api/order',
      '/api/orders',
      '/api/trade',
      '/api/binance/order',
      '/api/bybit/order',
      '/api/bingx/order',
    ];
    for (const ep of orderEndpoints) {
      const res = await fetch(`${serverUrl}${ep}`, { method: 'POST' });
      assert.equal(res.status, 404, `Expected ${ep} to return HTTP 404`);
    }
  });
});
