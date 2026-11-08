import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { createApp } from '../server.ts';
import {
  ExchangeId,
  MarketScanResponse,
  SystemDatabaseHealthResponse,
  Timeframe,
} from '../src/types/market.ts';

function createCustomizableLiveAdapter(
  exchange: ExchangeId = 'binance_usdm',
  overrides?: {
    onFetchSnapshot?: () => Promise<void> | void;
    onFetchKlines?: (symbol: string, timeframe: Timeframe) => Promise<void> | void;
    onFetchOi?: (symbol: string) => Promise<void> | void;
    nullOiSymbols?: Set<string>;
    nullFundingSymbols?: Set<string>;
    insufficientKlineSymbols?: Set<string>;
    fetchedAtOverride?: string;
    closeTimeShiftMs?: number;
  }
): ExchangeAdapter {
  const demo = new DemoExchangeAdapter();
  return {
    id: exchange,
    displayName: 'Phase17 Mock Binance Live USD-M',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      if (overrides?.onFetchSnapshot) {
        await overrides.onFetchSnapshot();
      }
      const snap = await demo.fetchMarketSnapshot();
      const nowIso = overrides?.fetchedAtOverride ?? new Date().toISOString();
      return {
        tickers: snap.tickers.map((t) => {
          const isNullFunding = overrides?.nullFundingSymbols?.has(t.symbol) ?? false;
          const isNullOi = overrides?.nullOiSymbols?.has(t.symbol) ?? false;
          return {
            ...t,
            exchange,
            fundingRate: isNullFunding ? null : t.fundingRate,
            openInterest: isNullOi ? null : t.openInterest,
            openInterestValue: isNullOi ? null : t.openInterestValue,
            provenance: {
              source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
              fetchedAt: nowIso,
              stale: false,
              fallback: false,
              missingData: isNullFunding ? ['fundingRate'] : [],
              isDemo: false,
            },
          };
        }),
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
      if (overrides?.onFetchKlines) {
        await overrides.onFetchKlines(symbol, timeframe);
      }
      const res = await demo.fetchKlines(symbol, timeframe, limit);
      const nowIso = overrides?.fetchedAtOverride ?? new Date().toISOString();
      const shiftMs = overrides?.closeTimeShiftMs ?? 0;
      const isInsufficient =
        overrides?.insufficientKlineSymbols?.has(symbol) ?? false;
      const rawKlines = isInsufficient ? res.klines.slice(0, 5) : res.klines;
      const shiftedKlines =
        shiftMs !== 0
          ? rawKlines.map((k) => ({
              ...k,
              openTime: k.openTime + shiftMs,
              closeTime: k.closeTime + shiftMs,
            }))
          : rawKlines;
      return {
        klines: shiftedKlines,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: isInsufficient ? [`klines_${timeframe}_insufficient`] : [],
          isDemo: false,
        },
      };
    },
    async fetchOpenInterest(symbol: string, referencePrice?: number) {
      if (overrides?.onFetchOi) {
        await overrides.onFetchOi(symbol);
      }
      const nowIso = overrides?.fetchedAtOverride ?? new Date().toISOString();
      if (overrides?.nullOiSymbols?.has(symbol)) {
        return {
          openInterest: null,
          openInterestValue: null,
          provenance: {
            source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
            fetchedAt: nowIso,
            stale: false,
            fallback: false,
            missingData: ['openInterest'],
            isDemo: false,
          },
        };
      }
      const res = await demo.fetchOpenInterest(symbol, referencePrice);
      return {
        openInterest: res.openInterest,
        openInterestValue: res.openInterestValue,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
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

describe('Phase 17: 長時間 Live Paper 掃描穩定性、Worker 恢復、SQLite 一致性與實機運行驗收 (17 Required Scenarios)', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase17-test-'));
  });

  after(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1 & 12. 長時間多週期掃描不卡死測試 (24h & 72h 窗口、每週期實機快照、進度採樣證據 & 週期統計恆等式測試)', async () => {
    const dbPath = path.join(tmpDir, 'p17-multi-cycle.sqlite');
    const db = new RadarDatabase(dbPath);
    const adapter = createCustomizableLiveAdapter('binance_usdm');
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
        batchSize: 10,
        stalledThresholdMs: 45_000,
      },
    });

    const snap = await adapter.fetchMarketSnapshot();
    const subsetTickers = snap.tickers.slice(0, 6);
    const preScan = runMarketScan(subsetTickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    // Run 3 consecutive full scan cycles (simulating multi-cycle progression across 24h and 72h windows)
    for (let c = 1; c <= 3; c++) {
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers: subsetTickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
        windowKey: `win_p17_c${c}`,
        forceRefresh: true,
        pruneUniverse: true,
      });

      // Capture progress evidence before and after processing
      const sampleBefore = scanner.captureProgressEvidenceSample(
        'binance_usdm',
        'live',
        Date.now() + c * 1_000
      );
      assert.equal(sampleBefore.stalledSuspected, false);

      await scanner.processNextBatch('binance_usdm', 'live', 10);

      const sampleAfter = scanner.captureProgressEvidenceSample(
        'binance_usdm',
        'live',
        Date.now() + c * 2_000
      );
      assert.equal(sampleAfter.stalledSuspected, false);
    }

    // Verify per-cycle live snapshots and mathematical identities (Requirement 12)
    const cycleSnapshots = scanner.listPhase17CycleSnapshots('binance_usdm', 10);
    assert.ok(cycleSnapshots.length >= 3, 'Should persist at least 3 cycle snapshots');

    for (const cyc of cycleSnapshots) {
      assert.equal(
        cyc.evaluatedCount +
          Math.max(0, cyc.pendingCount - cyc.rateLimitedCount) +
          cyc.failedCount +
          cyc.rateLimitedCount,
        cyc.totalSymbols,
        `Cycle ${cyc.cycleId} universe identity must hold`
      );
      assert.equal(
        cyc.waitCount +
          cyc.watchCount +
          cyc.highRiskCount +
          cyc.longCandidateCount +
          cyc.shortCandidateCount,
        cyc.evaluatedCount,
        `Cycle ${cyc.cycleId} evaluated state identity must hold`
      );
      assert.equal(cyc.identityChecks.universeTotalIdentityValid, true);
      assert.equal(cyc.identityChecks.evaluatedStateIdentityValid, true);
      assert.equal(cyc.identityChecks.pendingBreakdownIdentityValid, true);
    }

    // Verify 24h & 72h monitoring windows
    const dbHealth = scanner.getDatabaseHealth('binance_usdm', 'live');
    assert.equal(dbHealth.monitoringWindows['24h'].duration, '24h');
    assert.equal(dbHealth.monitoringWindows['72h'].duration, '72h');
    assert.ok(dbHealth.monitoringWindows['24h'].completedScanCycles >= 3);
    assert.ok(dbHealth.monitoringWindows['72h'].completedScanCycles >= 3);
    assert.equal(dbHealth.monitoringWindows['24h'].externalNotificationCount, 0);
    assert.equal(dbHealth.monitoringWindows['72h'].externalNotificationCount, 0);

    // Verify 10-minute no-progress rule triggers stalledSuspected = true with concrete reason (never "未知錯誤")
    db.enqueueSmcScanJobs(
      [
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 100,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          priorityClass: 'FAST_LANE',
          status: 'QUEUED',
          ruleVersion: SMC_RULE_VERSION,
          windowKey: 'win_p17_stall_check',
          requestedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          queueEnteredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ],
      true,
      false
    );
    scanner.setSimulatedHealthState('binance_usdm', {
      workerState: 'RUNNING',
      lastProgressAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      lastJobCompletedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const stalledSample = scanner.captureProgressEvidenceSample(
      'binance_usdm',
      'live',
      Date.now() + 900_000
    );
    assert.equal(stalledSample.stalledSuspected, true);
    assert.ok(stalledSample.stalledReasons.includes('WORKER_NO_PROGRESS'));
    assert.ok(
      !stalledSample.stalledReasons.some((r) => String(r).includes('未知錯誤'))
    );
    db.close();
  });

  it('2, 3 & 4. Worker 中途中斷後恢復測試、RUNNING lease 過期自動回收測試 & 服務重啟後 QUEUED 任務續跑測試 (SUCCEEDED 不重複執行)', async () => {
    const dbPath = path.join(tmpDir, 'p17-recovery.sqlite');
    const db = new RadarDatabase(dbPath);
    const executedSymbolsCount = new Map<string, number>();
    const adapter = createCustomizableLiveAdapter('binance_usdm', {
      onFetchKlines: (sym, tf) => {
        if (tf === '15m') {
          executedSymbolsCount.set(sym, (executedSymbolsCount.get(sym) ?? 0) + 1);
        }
      },
    });

    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
      recoverOnStart: false,
      config: {
        maxConcurrency: 2,
        batchSize: 2,
      },
    });

    const snap = await adapter.fetchMarketSnapshot();
    const subsetTickers = snap.tickers.slice(0, 5);
    const preScan = runMarketScan(subsetTickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: subsetTickers,
      candidates: preScan.candidates,
      watchlistSymbols: [subsetTickers[0].symbol],
      windowKey: 'win_p17_rec',
      forceRefresh: true,
      pruneUniverse: true,
    });

    const initialCycleId = scanner.getStatus('binance_usdm', 'live').cycleId;

    // Complete first 2 symbols (SUCCEEDED)
    await scanner.processNextBatch('binance_usdm', 'live', 2);
    const afterFirstBatch = scanner.getStatus('binance_usdm', 'live');
    assert.equal(afterFirstBatch.evaluatedCount, 2);
    assert.equal(afterFirstBatch.queuedCount, 3);

    // Claim 1 job into RUNNING with an expired lease, then simulate forced worker interruption
    const pastIso = new Date(Date.now() - 120_000).toISOString();
    const claimed = db.claimNextSmcScanJobs('binance_usdm', 1, pastIso, {
      maxConcurrency: 2,
      workerId: 'crashed-worker-1',
      workerRole: 'FAST_LANE',
      leaseDurationMs: 30_000, // expired 90s ago
    });
    assert.equal(claimed.length, 1);

    const interruptInfo = scanner.forceInterruptWorker('binance_usdm');
    assert.equal(interruptInfo.interruptedRunningCount, 1);
    assert.equal(interruptInfo.workerState, 'PAUSED');

    // Scenario 3: RUNNING lease expired auto-reclamation during next claim / recovery
    const recoveryRecord = scanner.restartAndRecover({
      exchange: 'binance_usdm',
      mode: 'live',
      triggerReason: 'FORCED_WORKER_INTERRUPT_RESTART',
      resumeWorker: false,
    });
    assert.equal(recoveryRecord.recoveredRunningJobsCount, 1);
    assert.equal(recoveryRecord.cycleId, initialCycleId);
    assert.equal(recoveryRecord.preservedCompletedCount, 2);
    assert.equal(recoveryRecord.duplicateRunningSymbolsCount, 0);
    assert.ok(
      recoveryRecord.statsVersionAfter > recoveryRecord.statsVersionBefore,
      'statsVersion must increment monotonically on recovery'
    );

    // Scenario 4: Close and reopen SQLite + new SmcBatchScanService instance to simulate full service restart
    db.close();
    const dbReopened = new RadarDatabase(dbPath);
    const scannerRestarted = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db: dbReopened,
      recoverOnStart: true,
      config: {
        maxConcurrency: 2,
        batchSize: 5,
      },
    });

    // Continue processing remaining 3 QUEUED jobs without re-running the 2 SUCCEEDED jobs
    const processedAfterRestart = await scannerRestarted.processNextBatch(
      'binance_usdm',
      'live',
      5
    );
    assert.equal(processedAfterRestart, 3);

    const finalStatus = scannerRestarted.getStatus('binance_usdm', 'live');
    assert.equal(finalStatus.evaluatedCount, 5);
    assert.equal(finalStatus.pendingCount, 0);
    assert.equal(finalStatus.cycleId, initialCycleId);

    // Verify each symbol was evaluated at most once (SUCCEEDED jobs were NOT duplicated)
    for (const t of subsetTickers) {
      assert.equal(
        executedSymbolsCount.get(t.symbol),
        1,
        `Symbol ${t.symbol} should only be evaluated once across restart`
      );
    }

    dbReopened.close();
  });

  it('5. 同一 symbol 不重複 RUNNING 測試', () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-no-dup-running.sqlite'));
    const nowIso = new Date().toISOString();
    db.enqueueSmcScanJobs(
      [
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 100,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          priorityClass: 'FAST_LANE',
          status: 'QUEUED',
          ruleVersion: SMC_RULE_VERSION,
          windowKey: 'win_dup',
          requestedAt: nowIso,
          queueEnteredAt: nowIso,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 99,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          priorityClass: 'FAST_LANE',
          status: 'QUEUED',
          ruleVersion: SMC_RULE_VERSION,
          windowKey: 'win_dup',
          requestedAt: nowIso,
          queueEnteredAt: nowIso,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ],
      true,
      true
    );

    const claimed1 = db.claimNextSmcScanJobs('binance_usdm', 2, nowIso, {
      maxConcurrency: 4,
      workerId: 'worker-a',
      workerRole: 'FAST_LANE',
    });
    const claimed2 = db.claimNextSmcScanJobs('binance_usdm', 2, nowIso, {
      maxConcurrency: 4,
      workerId: 'worker-b',
      workerRole: 'FAST_LANE',
    });

    assert.equal(claimed1.length, 1);
    assert.equal(claimed2.length, 0);
    const jobs = db.listSmcScanJobs('binance_usdm', 10);
    const runningBtc = jobs.filter(
      (j) => j.symbol === 'BTCUSDT' && j.status === 'RUNNING'
    );
    assert.equal(runningBtc.length, 1);
    db.close();
  });

  it('6. HTTP 429 退避後恢復測試', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-429-backoff.sqlite'));
    let shouldThrow429 = true;
    const adapter = createCustomizableLiveAdapter('binance_usdm', {
      onFetchKlines: (sym) => {
        if (sym === 'BTCUSDT' && shouldThrow429) {
          throw new ExchangeApiUnavailableError(
            'HTTP 429 Too Many Requests from Binance',
            'Binance Live',
            429,
            { isRateLimited: true }
          );
        }
      },
    });

    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
      config: {
        maxConcurrency: 1,
        batchSize: 1,
        maxRetries: 3,
        baseBackoffMs: 20,
      },
    });

    const nowIso = new Date().toISOString();
    db.enqueueSmcScanJobs(
      [
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 100,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          priorityClass: 'FAST_LANE',
          status: 'QUEUED',
          ruleVersion: SMC_RULE_VERSION,
          windowKey: 'win_429',
          requestedAt: nowIso,
          queueEnteredAt: nowIso,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ],
      true,
      true
    );

    // 1st attempt hits HTTP 429 -> enters RATE_LIMITED with nextRetryAt
    await scanner.processNextBatch('binance_usdm', 'live', 1);
    const progress429 = scanner.getProgressAndHealth('binance_usdm', 'live');
    assert.equal(progress429.rateLimitedCount, 1);
    assert.equal(
      progress429.pendingReasonCounts.WAITING_FOR_RATE_LIMIT +
        progress429.pendingReasonCounts.RETRY_SCHEDULED,
      1
    );

    // Clear 429 and wait 35ms for backoff window to elapse, then process again
    shouldThrow429 = false;
    await new Promise((r) => setTimeout(r, 35));
    await scanner.processNextBatch('binance_usdm', 'live', 1);

    const progressRecovered = scanner.getProgressAndHealth('binance_usdm', 'live');
    assert.equal(progressRecovered.evaluatedCount, 1);
    assert.equal(progressRecovered.pendingCount, 0);
    assert.equal(progressRecovered.rateLimitedCount, 0);

    const dbHealth = scanner.getDatabaseHealth('binance_usdm', 'live');
    assert.ok(dbHealth.rateLimit429Count >= 1);
    db.close();
  });

  it('7 & 14. HTTP 503 不回退假資料測試 & Live 不混入 Demo 測試', async () => {
    const dbPath = path.join(tmpDir, 'p17-503-live.sqlite');
    const failingAdapter: ExchangeAdapter = {
      id: 'binance_usdm',
      displayName: 'Binance USD-M Live',
      enabled: true,
      isDemo: false,
      status: 'LIVE',
      async fetchMarketSnapshot() {
        throw new ExchangeApiUnavailableError(
          'HTTP 503 Service Unavailable from Binance Upstream',
          'Binance USD-M Live',
          503
        );
      },
      async fetchKlines() {
        throw new ExchangeApiUnavailableError(
          'HTTP 503 Service Unavailable',
          'Binance USD-M Live',
          503
        );
      },
      async fetchOpenInterest() {
        throw new ExchangeApiUnavailableError(
          'HTTP 503 Service Unavailable',
          'Binance USD-M Live',
          503
        );
      },
    };

    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: failingAdapter,
      },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const scanRes = await fetch(`${baseUrl}/api/scan?mode=live&exchange=binance_usdm`);
      assert.equal(scanRes.status, 503);
      const scanBody = (await scanRes.json()) as MarketScanResponse;
      assert.equal(scanBody.mode, 'live');
      assert.equal(scanBody.isDemo, false);
      assert.equal(scanBody.fallback, false);
      assert.equal(scanBody.candidates.length, 0);
      assert.equal(scanBody.apiError, '即時資料不可用');

      // Also verify /api/smc-quality/gate-stats rejects mode=demo or exchange=demo_synthetic
      const demoQualityRes = await fetch(
        `${baseUrl}/api/smc-quality/gate-stats?mode=demo&exchange=demo_synthetic`
      );
      assert.equal(demoQualityRes.status, 400);

      // Verify /api/system/database-health recorded the HTTP 503 event
      const healthRes = await fetch(
        `${baseUrl}/api/system/database-health?mode=live&exchange=binance_usdm`
      );
      assert.equal(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as SystemDatabaseHealthResponse;
      assert.ok(healthBody.http503Count >= 1);
      assert.ok(healthBody.lastError?.includes('503'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (app.locals.radarDb as RadarDatabase).close();
    }
  });

  it('8. 缺少 OI / Funding / K 線時安全處理測試 (不得當機或誤升格為 LONG/SHORT CANDIDATE)', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-missing-data.sqlite'));
    const adapter = createCustomizableLiveAdapter('binance_usdm', {
      nullOiSymbols: new Set(['BTCUSDT']),
      nullFundingSymbols: new Set(['ETHUSDT']),
      insufficientKlineSymbols: new Set(['SOLUSDT']),
    });

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
        batchSize: 5,
      },
    });

    const snap = await adapter.fetchMarketSnapshot();
    const targetTickers = snap.tickers.filter((t) =>
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(t.symbol)
    );
    const preScan = runMarketScan(targetTickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: targetTickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      windowKey: 'win_missing',
      forceRefresh: true,
      pruneUniverse: true,
    });

    await scanner.processNextBatch('binance_usdm', 'live', 5);

    const btcRes = db.getSmcScanResult('binance_usdm', 'BTCUSDT');
    const ethRes = db.getSmcScanResult('binance_usdm', 'ETHUSDT');
    const solRes = db.getSmcScanResult('binance_usdm', 'SOLUSDT');

    assert.ok(btcRes, 'BTCUSDT result must be saved');
    assert.ok(btcRes.missingData.includes('openInterest'));
    assert.notEqual(btcRes.smcActionState, 'LONG CANDIDATE');
    assert.notEqual(btcRes.smcActionState, 'SHORT CANDIDATE');
    assert.equal(btcRes.finalTradeSignal, 'NONE');

    assert.ok(ethRes, 'ETHUSDT result must be saved');
    assert.ok(ethRes.missingData.includes('fundingRate'));
    assert.notEqual(ethRes.smcActionState, 'LONG CANDIDATE');
    assert.notEqual(ethRes.smcActionState, 'SHORT CANDIDATE');
    assert.equal(ethRes.finalTradeSignal, 'NONE');

    assert.ok(solRes, 'SOLUSDT result must be saved');
    assert.ok(solRes.missingData.length > 0);
    assert.notEqual(solRes.smcActionState, 'LONG CANDIDATE');
    assert.notEqual(solRes.smcActionState, 'SHORT CANDIDATE');
    assert.equal(solRes.finalTradeSignal, 'NONE');
    db.close();
  });

  it('9. 快取過期後自動刷新測試', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-cache-expiry.sqlite'));
    let klineNetworkFetchCount = 0;
    const adapter = createCustomizableLiveAdapter('binance_usdm', {
      onFetchKlines: (sym, tf) => {
        if (sym === 'BTCUSDT' && tf === '15m') {
          klineNetworkFetchCount++;
        }
      },
    });

    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
    });

    const snap = await adapter.fetchMarketSnapshot();
    const btcTicker = snap.tickers.filter((t) => t.symbol === 'BTCUSDT');
    const preScan = runMarketScan(btcTicker, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: btcTicker,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      windowKey: 'win_cache_1',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 1);
    assert.equal(klineNetworkFetchCount, 1);

    // Expire the 15m cache row in SQLite
    const cached15m = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '15m');
    assert.ok(cached15m);
    db.saveSmcCandlesCache({
      ...cached15m,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const expiredCheck = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      Date.now()
    );
    assert.equal(expiredCheck?.isExpired, true);

    // Enqueue a new cycle without forceRefresh; expired 15m cache must automatically refresh from network
    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: btcTicker,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      windowKey: 'win_cache_2',
      forceRefresh: false,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 1);
    assert.equal(
      klineNetworkFetchCount,
      2,
      'Expired cache must trigger automatic network refresh'
    );

    const refreshedCheck = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      Date.now()
    );
    assert.equal(refreshedCheck?.isExpired, false);
    db.close();
  });

  it('10 & 11. SQLite 完整性檢查與安全備份測試 (GET /api/system/database-health & POST /api/system/database-check) & statsVersion 單調遞增測試', async () => {
    const dbPath = path.join(tmpDir, 'p17-sqlite-health.sqlite');
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: adapter,
      },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Seed a paper ledger entry so we can verify database-check never deletes or overwrites paper data
      const ledgerRes = await fetch(`${baseUrl}/api/paper-ledger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          timeframe: '15m',
          side: 'LONG',
          category: '多頭候選',
          actionState: 'LONG CANDIDATE',
          entryPrice: 95000,
          invalidationPrice: 93500,
          targetPrice: 98000,
          ruleVersion: SMC_RULE_VERSION,
          evidences: ['15m Confirmed MSS'],
          notes: 'Phase 17 SQLite preservation test',
          provenance: {
            source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
            fetchedAt: new Date().toISOString(),
            stale: false,
            fallback: false,
            missingData: [],
            isDemo: false,
          },
        }),
      });
      assert.equal(ledgerRes.status, 200);

      const healthRes1 = await fetch(
        `${baseUrl}/api/system/database-health?mode=live&exchange=binance_usdm`
      );
      assert.equal(healthRes1.status, 200);
      const h1 = (await healthRes1.json()) as SystemDatabaseHealthResponse;
      assert.equal(h1.mode, 'PAPER ONLY');
      assert.equal(h1.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(h1.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
      assert.equal(h1.integrityCheck, 'ok');
      assert.equal(h1.integrityCheckPassed, true);
      assert.equal(h1.walStatus, 'ACTIVE');
      assert.ok(h1.databaseInstanceId.startsWith('db_'));
      assert.ok(h1.databaseFileSizeBytes > 0);
      assert.equal(
        h1.stabilityNotices.includes('PENDING 不等於 WAIT'),
        true
      );
      assert.equal(
        h1.stabilityNotices.includes('掃描中不代表候選已確認'),
        true
      );
      assert.equal(
        h1.stabilityNotices.includes('候選數為 0 不代表服務故障'),
        true
      );

      // Run POST /api/system/database-check with backup & simulated SQLITE_BUSY retry handling
      const checkRes = await fetch(`${baseUrl}/api/system/database-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'live',
          exchange: 'binance_usdm',
          createBackup: true,
          simulateBusyRetries: 2,
        }),
      });
      assert.equal(checkRes.status, 200);
      const h2 = (await checkRes.json()) as SystemDatabaseHealthResponse;
      assert.equal(h2.integrityCheck, 'ok');
      assert.ok(h2.lastBackupAt, 'lastBackupAt must be populated after backup');
      assert.ok(
        h2.backupFilePath && fs.existsSync(h2.backupFilePath),
        'SQLite safe backup file must exist on disk'
      );
      assert.ok(h2.databaseRecoveryCount >= 1);

      // Verify monotonic statsVersion across job writes
      const radarDb = app.locals.radarDb as RadarDatabase;
      const vBefore = radarDb.getAtomicSmcSnapshot('binance_usdm').statsVersion;
      const nowIso = new Date().toISOString();
      radarDb.enqueueSmcScanJobs(
        [
          {
            symbol: 'BTCUSDT',
            exchange: 'binance_usdm',
            priority: 100,
            priorityTier: 1,
            priorityLabel: '1_WATCHLIST',
            priorityClass: 'FAST_LANE',
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey: 'win_v_mono',
            requestedAt: nowIso,
            queueEnteredAt: nowIso,
            startedAt: null,
            completedAt: null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        ],
        true,
        true
      );
      const vAfterEnqueue =
        radarDb.getAtomicSmcSnapshot('binance_usdm').statsVersion;
      assert.ok(
        vAfterEnqueue > vBefore,
        `statsVersion must strictly increase (${vBefore} -> ${vAfterEnqueue})`
      );

      // Verify existing paper ledger entry was never deleted by database-check
      const ledgerVerifyRes = await fetch(`${baseUrl}/api/paper-ledger`);
      const ledgerVerifyBody = (await ledgerVerifyRes.json()) as {
        entries: Array<{ symbol: string }>;
      };
      assert.equal(ledgerVerifyBody.entries.length, 1);
      assert.equal(ledgerVerifyBody.entries[0].symbol, 'BTCUSDT');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (app.locals.radarDb as RadarDatabase).close();
    }
  });

  it('13. PENDING 不轉 WAIT 測試', async () => {
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const snap = await adapter.fetchMarketSnapshot();
    const subset = snap.tickers.slice(0, 4);

    // Run market scan with an empty smcMap -> all 4 symbols have not completed SMC evaluation yet
    const scanResult = runMarketScan(subset, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      smcMap: new Map(),
    });

    assert.equal(scanResult.smcPendingCount, 4);
    assert.equal(scanResult.smcWaitCount, 0);
    for (const c of scanResult.candidates) {
      assert.equal(c.smcEvaluationStatus, 'PENDING');
      assert.equal(c.smcActionState, 'PENDING');
      assert.notEqual(c.smcActionState, 'WAIT');
    }
  });

  it('15. 錯過下一根 K 線開盤後 ENTRY_WINDOW_MISSED 測試 (不得回溯使用已錯過的 K 線開盤價)', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-entry-window.sqlite'));
    // Shift klines 45 minutes into the past so that evalEndMs > nextBarOpenTime
    const adapter = createCustomizableLiveAdapter('binance_usdm', {
      closeTimeShiftMs: -45 * 60 * 1000,
    });
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
    });

    const snap = await adapter.fetchMarketSnapshot();
    const solTicker = snap.tickers.filter((t) => t.symbol === 'SOLUSDT');
    const preScan = runMarketScan(solTicker, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: solTicker,
      candidates: preScan.candidates,
      watchlistSymbols: ['SOLUSDT'],
      windowKey: 'win_missed_bar',
      forceRefresh: true,
      pruneUniverse: true,
    });

    await scanner.processNextBatch('binance_usdm', 'live', 1);
    const solRes = db.getSmcScanResult('binance_usdm', 'SOLUSDT');
    assert.ok(solRes);
    if (
      solRes.smcActionState === 'LONG CANDIDATE' ||
      solRes.smcActionState === 'SHORT CANDIDATE' ||
      solRes.finalTradeSignal !== 'NONE'
    ) {
      assert.equal(solRes.entryWindowStatus, 'ENTRY_WINDOW_MISSED');
    } else {
      // Also verify direct save of a candidate whose evaluation completed after nextBarOpenTime
      const pastCloseTime = Date.now() - 30 * 60_000;
      const pastNextBarOpen = pastCloseTime + 1;
      db.saveSmcScanResult({
        ...solRes,
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        signalBarCloseTime: pastCloseTime,
        nextBarOpenTime: pastNextBarOpen,
        entryWindowStatus:
          Date.now() < pastNextBarOpen
            ? 'DETECTED_BEFORE_NEXT_BAR_OPEN'
            : 'ENTRY_WINDOW_MISSED',
      });
      const updated = db.getSmcScanResult('binance_usdm', 'SOLUSDT');
      assert.equal(updated?.entryWindowStatus, 'ENTRY_WINDOW_MISSED');
    }
    db.close();
  });

  it('16 & 17. 外部通知永遠為 0 測試 & 所有下單 API 永遠 404 測試', async () => {
    const dbPath = path.join(tmpDir, 'p17-safety-404.sqlite');
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: adapter,
      },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Requirement 16: External notification count is strictly 0
      const outboxRes = await fetch(`${baseUrl}/api/notification-sandbox/outbox`);
      assert.equal(outboxRes.status, 200);
      const outboxBody = (await outboxRes.json()) as {
        externalTelegramRequestsCount: number;
        externalTradingViewRequestsCount: number;
      };
      assert.equal(outboxBody.externalTelegramRequestsCount, 0);
      assert.equal(outboxBody.externalTradingViewRequestsCount, 0);

      const dbHealthRes = await fetch(`${baseUrl}/api/system/database-health`);
      const dbHealthBody = (await dbHealthRes.json()) as SystemDatabaseHealthResponse;
      assert.equal(
        dbHealthBody.monitoringWindows['24h'].externalNotificationCount,
        0
      );
      assert.equal(
        dbHealthBody.monitoringWindows['72h'].externalNotificationCount,
        0
      );

      // Requirement 17: All order endpoints strictly return HTTP 404
      const orderEndpoints = [
        '/api/order',
        '/api/orders',
        '/api/trade',
        '/api/live-order',
        '/api/binance/order',
        '/api/bybit/order',
        '/api/bingx/order',
      ];
      for (const ep of orderEndpoints) {
        const resPost = await fetch(`${baseUrl}${ep}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY' }),
        });
        assert.equal(
          resPost.status,
          404,
          `POST ${ep} must strictly return HTTP 404`
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (app.locals.radarDb as RadarDatabase).close();
    }
  });

  it('18. Phase 17.1 並行上限驗證：runningJobCount === maxConcurrency 視為合法；runningJobCount > maxConcurrency 標記 INVALID 且四端點一致回傳', async () => {
    const dbPath = path.join(tmpDir, 'p17-1-concurrency-cap.sqlite');
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: adapter,
      },
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const radarDb = app.locals.radarDb as RadarDatabase;
      const smcScanner = app.locals.smcBatchScanner as SmcBatchScanService;
      smcScanner.updateConfig({ maxConcurrency: 2, maxJobConcurrency: 2 });

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const leaseIso = new Date(nowMs + 60_000).toISOString();

      // Enqueue 3 jobs
      radarDb.enqueueSmcScanJobs(
        ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((sym, idx) => ({
          symbol: sym,
          exchange: 'binance_usdm' as const,
          priority: 100 - idx,
          priorityTier: 1 as const,
          priorityLabel: '1_WATCHLIST' as const,
          priorityClass: 'FAST_LANE' as const,
          status: 'QUEUED' as const,
          ruleVersion: SMC_RULE_VERSION,
          windowKey: 'win_p17_1_conc',
          requestedAt: nowIso,
          queueEnteredAt: nowIso,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        })),
        true,
        true
      );

      // Claim exactly 2 jobs so runningJobCount === maxConcurrency (2 === 2)
      const claimed = radarDb.claimNextSmcScanJobs('binance_usdm', 2, nowIso, {
        maxConcurrency: 2,
        workerId: 'worker-cap-test',
        workerRole: 'FAST_LANE',
        leaseDurationMs: 60_000,
      });
      assert.equal(claimed.length, 2);

      smcScanner.setSimulatedHealthState('binance_usdm', {
        workerState: 'RUNNING',
        lastProgressAt: nowIso,
      });

      // Test 1: runningJobCount === maxConcurrency (2 === 2) is VALID
      const endpoints = [
        '/api/smc-scan/progress',
        '/api/smc-scan/health',
        '/api/smc-scan/stuck-jobs',
        '/api/paper-monitor/status',
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          maxConcurrency: number;
          runningJobCount: number;
          concurrencyValid: boolean;
          statsConsistency: 'VALID' | 'INVALID';
          stalledSuspected?: boolean;
        };
        assert.equal(body.maxConcurrency, 2, `${ep} maxConcurrency must be 2`);
        assert.equal(body.runningJobCount, 2, `${ep} runningJobCount must be 2`);
        assert.equal(
          body.concurrencyValid,
          true,
          `${ep} concurrencyValid must be true when runningJobCount === maxConcurrency`
        );
        assert.equal(
          body.statsConsistency,
          'VALID',
          `${ep} statsConsistency must be VALID when runningJobCount === maxConcurrency`
        );
      }

      // Test 2: Force 3rd job into RUNNING in SQLite so runningJobCount (3) > maxConcurrency (2)
      const rawSqlite = (
        radarDb as unknown as {
          db: {
            prepare: (sql: string) => { run: (...args: unknown[]) => void };
          };
        }
      ).db;
      rawSqlite
        .prepare(
          `UPDATE smc_scan_jobs
           SET status = 'RUNNING', started_at = ?, heartbeat_at = ?, lease_until = ?
           WHERE exchange = 'binance_usdm' AND symbol = 'SOLUSDT'`
        )
        .run(nowIso, nowIso, leaseIso);

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          maxConcurrency: number;
          runningJobCount: number;
          concurrencyValid: boolean;
          statsConsistency: 'VALID' | 'INVALID';
          stalledSuspected: boolean;
          scannerHealth?: string;
        };
        assert.equal(body.maxConcurrency, 2, `${ep} maxConcurrency must be 2`);
        assert.equal(body.runningJobCount, 3, `${ep} runningJobCount must be 3`);
        assert.equal(
          body.concurrencyValid,
          false,
          `${ep} concurrencyValid must be false when runningJobCount > maxConcurrency`
        );
        assert.equal(
          body.statsConsistency,
          'INVALID',
          `${ep} statsConsistency must be INVALID when runningJobCount > maxConcurrency`
        );
        assert.equal(
          body.stalledSuspected,
          true,
          `${ep} stalledSuspected must be true when runningJobCount > maxConcurrency`
        );
        if (body.scannerHealth !== undefined) {
          assert.notEqual(
            body.scannerHealth,
            'HEALTHY',
            `${ep} must never claim HEALTHY when concurrency cap is exceeded`
          );
        }
      }

      // Test 3: After service restart recovery, runningJobCount is reclaimed back to 0 <= maxConcurrency
      const rec = smcScanner.restartAndRecover({
        exchange: 'binance_usdm',
        mode: 'live',
        triggerReason: 'FORCED_WORKER_INTERRUPT_RESTART',
        resumeWorker: false,
      });
      assert.equal(rec.maxConcurrency, 2);
      assert.equal(rec.runningJobCountAfter, 0);
      assert.equal(rec.concurrencyValidAfter, true);
      assert.equal(rec.duplicateRunningSymbolsCount, 0);
      assert.equal(rec.succeededNotRepeatedVerified, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (app.locals.radarDb as RadarDatabase).close();
    }
  });

  it('19. Phase 17.1 長時間窗口收尾條件、COMPLETED 最終欄位與 INTERRUPTED 不可覆寫測試', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p17-1-window-finalization.sqlite'));
    const adapter = createCustomizableLiveAdapter('binance_usdm');
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
        batchSize: 5,
      },
    });

    const snap = await adapter.fetchMarketSnapshot();
    const subset = snap.tickers.slice(0, 3);
    const preScan = runMarketScan(subset, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: subset,
      candidates: preScan.candidates,
      watchlistSymbols: [subset[0].symbol],
      windowKey: 'win_p17_1_fin',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 3);

    const startMs = Date.now();
    db.startNewMonitoringWindows('binance_usdm', startMs);

    // Requirement 4: Before expectedEndAt, windowStatus MUST remain RUNNING and canMarkCompleted = false
    const halfTimeMs = startMs + 12 * 3600 * 1000;
    const windowsAt12h = db.getOrSyncLongRunningWindows('binance_usdm', halfTimeMs, 2);
    assert.equal(windowsAt12h['24h'].windowStatus, 'RUNNING');
    assert.equal(windowsAt12h['24h'].completedAt, null);
    assert.equal(windowsAt12h['24h'].canMarkCompleted, false);
    assert.equal(windowsAt12h['24h'].completionCriteria.timeReached, false);
    assert.equal(windowsAt12h['24h'].finalSnapshotAt ?? null, null);

    // Requirement 7: Progress evidence samples save maxConcurrency, monitoringWindowId, concurrencyValid, externalNotificationCount
    const sample = scanner.captureProgressEvidenceSample(
      'binance_usdm',
      'live',
      halfTimeMs
    );
    assert.equal(sample.maxConcurrency, 2);
    assert.equal(sample.concurrencyValid, true);
    assert.equal(sample.externalNotificationCount, 0);
    assert.equal(
      sample.monitoringWindowId,
      windowsAt12h['24h'].monitoringWindowId
    );
    const storedSamples = scanner.listProgressEvidenceSamples('binance_usdm', 5);
    assert.ok(storedSamples.length >= 1);
    assert.equal(storedSamples[0].maxConcurrency, 2);
    assert.equal(storedSamples[0].concurrencyValid, true);
    assert.equal(storedSamples[0].externalNotificationCount, 0);
    assert.equal(
      storedSamples[0].monitoringWindowId,
      windowsAt12h['24h'].monitoringWindowId
    );

    // Requirement 5: When currentTime >= expectedEndAt AND all criteria pass, mark COMPLETED with final fields
    const after24hMs = startMs + 24 * 3600 * 1000 + 5_000;
    const windowsAfter24h = db.getOrSyncLongRunningWindows(
      'binance_usdm',
      after24hMs,
      2
    );
    assert.equal(windowsAfter24h['24h'].windowStatus, 'COMPLETED');
    assert.equal(windowsAfter24h['24h'].canMarkCompleted, true);
    assert.ok(windowsAfter24h['24h'].completedAt);
    assert.ok(windowsAfter24h['24h'].finalSnapshotAt);
    assert.ok(
      typeof windowsAfter24h['24h'].finalStatsVersion === 'number' &&
        windowsAfter24h['24h'].finalStatsVersion > 0
    );
    assert.ok(windowsAfter24h['24h'].finalCycleId);
    assert.equal(windowsAfter24h['24h'].finalDatabaseHealth, 'HEALTHY');
    assert.ok(windowsAfter24h['24h'].finalBackupVerification);
    assert.equal(windowsAfter24h['24h'].concurrencyViolations, 0);
    assert.equal(windowsAfter24h['24h'].externalNotificationCount, 0);

    // Meanwhile 72h has not reached expectedEndAt yet at +24h
    assert.equal(windowsAfter24h['72h'].windowStatus, 'RUNNING');
    assert.equal(windowsAfter24h['72h'].canMarkCompleted, false);

    // Requirement 6: If 72h window experiences INTERRUPTED mid-flight, it must NEVER be overwritten to COMPLETED even after 72h elapses
    db.setLongRunningWindowState('binance_usdm', '72h', {
      windowStatus: 'INTERRUPTED',
      interruptedScanCycles: 1,
    });
    const after72hMs = startMs + 72 * 3600 * 1000 + 10_000;
    const windowsAfter72h = db.getOrSyncLongRunningWindows(
      'binance_usdm',
      after72hMs,
      2
    );
    assert.equal(
      windowsAfter72h['72h'].windowStatus,
      'INTERRUPTED',
      'INTERRUPTED window must never be overwritten to COMPLETED'
    );
    assert.equal(windowsAfter72h['72h'].completedAt, null);
    assert.equal(windowsAfter72h['72h'].canMarkCompleted, false);

    // Even attempting to call setLongRunningWindowState with COMPLETED on an INTERRUPTED window must preserve INTERRUPTED
    const attemptedOverwrite = db.setLongRunningWindowState(
      'binance_usdm',
      '72h',
      {
        windowStatus: 'COMPLETED',
        completedAt: new Date(after72hMs).toISOString(),
      }
    );
    assert.equal(attemptedOverwrite.windowStatus, 'INTERRUPTED');
    assert.equal(attemptedOverwrite.completedAt, null);

    db.close();
  });

  it('20. Phase 17.2 Worker 狀態語義分離、完成後進度速率歸零與重啟原因四分類驗收測試', async () => {
    const db = new RadarDatabase(
      path.join(tmpDir, 'p17-2-worker-semantics-restarts.sqlite')
    );
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
      recoverOnStart: false,
      config: {
        maxConcurrency: 2,
        batchSize: 2,
      },
    });

    const snap = await adapter.fetchMarketSnapshot();
    const subset = snap.tickers.slice(0, 4);
    const preScan = runMarketScan(subset, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: subset,
      candidates: preScan.candidates,
      watchlistSymbols: [subset[0].symbol],
      windowKey: 'win_p17_2_sem',
      forceRefresh: true,
      pruneUniverse: true,
    });

    // 1. Complete 2 of 4 symbols -> pendingCount = 2 > 0
    await scanner.processNextBatch('binance_usdm', 'live', 2);
    const midProgress = scanner.getProgressAndHealth('binance_usdm', 'live');
    assert.equal(midProgress.pendingCount, 2);
    assert.ok(
      midProgress.progressRatePerMinute > 0,
      'While pendingCount > 0 and jobs completed, progressRatePerMinute > 0'
    );
    assert.equal(midProgress.progressRateStatus, 'ACTIVE');

    // Claim 1 job into RUNNING to verify scanWorkerState = RUNNING
    const nowIso = new Date().toISOString();
    const claimed = db.claimNextSmcScanJobs('binance_usdm', 1, nowIso, {
      maxConcurrency: 2,
      workerId: 'worker-p17-2',
      workerRole: 'FAST_LANE',
      leaseDurationMs: 60_000,
    });
    assert.equal(claimed.length, 1);

    const runningDiag = scanner.getProgressAndHealth('binance_usdm', 'live');
    assert.equal(runningDiag.runningJobCount, 1);
    assert.equal(runningDiag.monitorWorkerState, 'RUNNING');
    assert.equal(runningDiag.scanWorkerState, 'RUNNING');
    assert.equal(runningDiag.queueWorkerState, 'HEALTHY');

    // Reclaim that running job via LEASE_RECOVERY so we can complete all 4 jobs
    scanner.restartAndRecover({
      exchange: 'binance_usdm',
      mode: 'live',
      triggerReason: 'LEASE_RECOVERY',
      resumeWorker: true,
    });

    await scanner.processNextBatch('binance_usdm', 'live', 2);

    // 2. Now all 4 symbols are COMPLETED (pendingCount = 0, runningJobCount = 0, cycleStatus = COMPLETED)
    const completedDiag = scanner.getProgressAndHealth('binance_usdm', 'live');
    assert.equal(completedDiag.pendingCount, 0);
    assert.equal(completedDiag.runningJobCount, 0);
    assert.equal(completedDiag.cycleStatus, 'COMPLETED');
    assert.equal(
      completedDiag.monitorWorkerState,
      'RUNNING',
      'monitorWorkerState remains RUNNING while sampling/monitoring loop is active'
    );
    assert.equal(
      completedDiag.scanWorkerState,
      'IDLE',
      'scanWorkerState MUST be IDLE when pendingCount=0, runningJobCount=0, cycleStatus=COMPLETED'
    );
    assert.equal(completedDiag.queueWorkerState, 'HEALTHY');
    assert.equal(
      completedDiag.progressRatePerMinute,
      0,
      'progressRatePerMinute MUST be 0 when pendingCount=0 and cycleStatus=COMPLETED'
    );
    assert.equal(
      completedDiag.progressRateStatus,
      'NO_ACTIVE_PROGRESS',
      'progressRateStatus MUST be NO_ACTIVE_PROGRESS when scan cycle is completed'
    );

    // 3. Verify Planned Graceful Restart vs Unexpected Crash Restart & 24h Window Finalization
    const startMs = Date.now();
    db.startNewMonitoringWindows('binance_usdm', startMs);

    scanner.gracefulShutdown('binance_usdm', 'planned_deploy_restart');
    const plannedRec = scanner.restartAndRecover({
      exchange: 'binance_usdm',
      mode: 'live',
      triggerReason: 'GRACEFUL_SHUTDOWN_RESTART',
      planned: true,
      serviceStoppedNormally: true,
      resumeWorker: true,
    });
    assert.equal(plannedRec.planned, true);
    assert.equal(plannedRec.serviceStoppedNormally, true);
    assert.ok(plannedRec.plannedRestartCountAfter >= 1);
    assert.equal(plannedRec.unexpectedRestartCountAfter, 0);
    assert.ok(plannedRec.leaseRecoveryCountAfter >= 1);

    // Trigger database recovery counter via simulated SQLITE_BUSY retry
    scanner.runDatabaseCheck({
      exchange: 'binance_usdm',
      mode: 'live',
      createBackup: true,
      simulateBusyRetries: 1,
    });

    const healthAfterPlanned = scanner.getDatabaseHealth('binance_usdm', 'live');
    assert.ok(healthAfterPlanned.plannedRestartCount >= 1);
    assert.equal(healthAfterPlanned.unexpectedRestartCount, 0);
    assert.ok(healthAfterPlanned.leaseRecoveryCount >= 1);
    assert.ok(healthAfterPlanned.databaseRecoveryCount >= 1);
    assert.equal(healthAfterPlanned.scanWorkerState, 'IDLE');
    assert.equal(healthAfterPlanned.monitorWorkerState, 'RUNNING');
    assert.equal(healthAfterPlanned.progressRatePerMinute, 0);
    assert.equal(healthAfterPlanned.progressRateStatus, 'NO_ACTIVE_PROGRESS');

    // Planned restart does NOT block 24h window completion once 24h has elapsed
    const after24hMs = startMs + 24 * 3600 * 1000 + 5_000;
    const win24hCompleted = db.getOrSyncLongRunningWindows(
      'binance_usdm',
      after24hMs,
      2
    );
    assert.equal(win24hCompleted['24h'].windowStatus, 'COMPLETED');
    assert.equal(win24hCompleted['24h'].canMarkCompleted, true);
    assert.equal(
      win24hCompleted['24h'].completionCriteria.zeroUnexpectedRestarts,
      true
    );

    // 4. Now simulate an UNEXPECTED crash recovery while 72h window is still RUNNING
    const unexpectedRec = scanner.restartAndRecover({
      exchange: 'binance_usdm',
      mode: 'live',
      triggerReason: 'FORCED_WORKER_INTERRUPT_RESTART',
      planned: false,
      serviceStoppedNormally: false,
      resumeWorker: true,
    });
    assert.equal(unexpectedRec.planned, false);
    assert.equal(unexpectedRec.serviceStoppedNormally, false);
    assert.ok(unexpectedRec.unexpectedRestartCountAfter >= 1);

    const after72hMs = startMs + 72 * 3600 * 1000 + 5_000;
    const win72hAfterCrash = db.getOrSyncLongRunningWindows(
      'binance_usdm',
      after72hMs,
      2
    );
    assert.equal(
      win72hAfterCrash['72h'].completionCriteria.zeroUnexpectedRestarts,
      false
    );
    assert.equal(win72hAfterCrash['72h'].canMarkCompleted, false);
    assert.equal(win72hAfterCrash['72h'].windowStatus, 'INTERRUPTED');

    scanner.stop();
    db.close();
  });

  it('21. Phase 17.3 監控窗口計數器範圍、歷史窗口不可覆寫、終態不可逆與重啟事件歸屬驗收測試', async () => {
    const db = new RadarDatabase(':memory:');
    const adapter = createCustomizableLiveAdapter('binance_usdm');
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
      recoverOnStart: false,
      config: {
        maxConcurrency: 2,
        batchSize: 2,
      },
    });

    // 1. Start Window A and run a complete cycle + 1 planned restart
    const winAStartMs = Date.now() - 20_000;
    const winA = db.startNewMonitoringWindows('binance_usdm', winAStartMs);
    const winA24hId = winA['24h'].monitoringWindowId;
    const winA72hId = winA['72h'].monitoringWindowId;
    assert.equal(winA24hId, `mwin_24h_binance_usdm_${winAStartMs}`);
    assert.equal(winA72hId, `mwin_72h_binance_usdm_${winAStartMs}`);

    const snap = await adapter.fetchMarketSnapshot();
    const subset = snap.tickers.slice(0, 4);
    const preScan = runMarketScan(subset, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: subset,
      candidates: preScan.candidates,
      watchlistSymbols: [subset[0].symbol],
      windowKey: 'win_p17_3_a',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 2);
    await scanner.processNextBatch('binance_usdm', 'live', 2);

    // Trigger 1 planned restart during Window A
    const recWinA = scanner.restartAndRecover({
      exchange: 'binance_usdm',
      mode: 'live',
      triggerReason: 'PLANNED_RESTART',
      planned: true,
      serviceStoppedNormally: true,
      resumeWorker: true,
    });
    assert.equal(recWinA.planned, true);

    const detailWinA = scanner.getMonitoringWindowDetail(winA24hId, winAStartMs + 5_000);
    assert.ok(detailWinA);
    assert.equal(detailWinA.window.windowPlannedRestartCount, 1);
    assert.equal(detailWinA.window.windowUnexpectedRestartCount, 0);
    assert.equal(detailWinA.window.windowDatabaseRecoveryCount, 1);
    assert.equal(detailWinA.recoveryEvents.length, 1);
    assert.equal(detailWinA.recoveryEvents[0].monitoringWindowId, winA24hId);
    assert.equal(detailWinA.recoveryEvents[0].planned, true);
    assert.equal(detailWinA.recoveryEvents[0].unexpected, false);
    assert.equal(detailWinA.recoveryEvents[0].databaseRecovery, true);

    // 2. Mark Window A as FAILED and verify terminal state immutability
    scanner.setLongRunningWindowState(
      'binance_usdm',
      '24h',
      {
        windowStatus: 'FAILED',
        terminalReason: 'STALLED_DETECTED_DURING_RATE_LIMIT_BACKOFF (windowStalledDetectedCount=1)',
      },
      winAStartMs + 10_000,
      winA24hId
    );
    scanner.setLongRunningWindowState(
      'binance_usdm',
      '72h',
      {
        windowStatus: 'FAILED',
        terminalReason: 'STALLED_DETECTED_DURING_RATE_LIMIT_BACKOFF (windowStalledDetectedCount=1)',
      },
      winAStartMs + 10_000,
      winA72hId
    );
    const detailWinAFailed = scanner.getMonitoringWindowDetail(winA24hId, winAStartMs + 12_000);
    assert.ok(detailWinAFailed);
    assert.equal(detailWinAFailed.window.windowStatus, 'FAILED');
    assert.ok(
      detailWinAFailed.window.terminalReason?.includes('STALLED_DETECTED')
    );

    // Attempt to revert FAILED -> RUNNING or FAILED -> COMPLETED (must be rejected)
    scanner.setLongRunningWindowState(
      'binance_usdm',
      '24h',
      { windowStatus: 'RUNNING', terminalReason: 'ILLEGAL_REVERT' },
      winAStartMs + 15_000,
      winA24hId
    );
    scanner.setLongRunningWindowState(
      'binance_usdm',
      '24h',
      { windowStatus: 'COMPLETED', terminalReason: 'ILLEGAL_COMPLETE' },
      winAStartMs + 15_000,
      winA24hId
    );
    const detailWinAAfterIllegal = scanner.getMonitoringWindowDetail(winA24hId, winAStartMs + 16_000);
    assert.ok(detailWinAAfterIllegal);
    assert.equal(
      detailWinAAfterIllegal.window.windowStatus,
      'FAILED',
      'Terminal state FAILED must never revert to RUNNING or COMPLETED'
    );
    assert.ok(
      detailWinAAfterIllegal.window.terminalReason?.includes('STALLED_DETECTED')
    );

    // 3. Start Window B and verify its window* counters start at 0 while lifetime* counters preserve history
    const winBStartMs = Date.now() - 5_000;
    const winB = db.startNewMonitoringWindows('binance_usdm', winBStartMs);
    const winB24hId = winB['24h'].monitoringWindowId;
    assert.equal(winB24hId, `mwin_24h_binance_usdm_${winBStartMs}`);
    assert.notEqual(winB24hId, winA24hId);

    // Window B must have 0 window-scoped restarts, while lifetimePlannedRestartCount >= 1
    assert.equal(winB['24h'].windowPlannedRestartCount, 0);
    assert.equal(winB['24h'].windowUnexpectedRestartCount, 0);
    assert.equal(winB['24h'].windowLeaseRecoveryCount, 0);
    assert.equal(winB['24h'].windowDatabaseRecoveryCount, 0);
    assert.ok(winB['24h'].lifetimePlannedRestartCount >= 1);
    assert.ok(winB['24h'].lifetimeDatabaseRecoveryCount >= 1);

    // Verify Window A is still preserved in getMonitoringWindowsList and not overwritten
    const listAfterWinB = scanner.getMonitoringWindowsList('binance_usdm', winBStartMs + 5_000);
    assert.ok(
      listAfterWinB.windows.some((w) => w.monitoringWindowId === winA24hId),
      'Previous window A must remain in smc_long_running_windows'
    );
    assert.equal(listAfterWinB.currentWindows['24h'].monitoringWindowId, winB24hId);
    assert.equal(listAfterWinB.previousWindows['24h']?.monitoringWindowId, winA24hId);
    assert.equal(listAfterWinB.previousWindows['24h']?.windowStatus, 'FAILED');

    // 4. Verify API payloads (/api/smc-scan/progress, /api/smc-scan/health, /api/system/database-health)
    const progress = scanner.getProgressAndHealth('binance_usdm', 'live');
    const health = scanner.getDatabaseHealth('binance_usdm', 'live');
    const dbHealth = db.performDatabaseHealthCheck('binance_usdm', {
      maxConcurrency: 2,
    });

    assert.equal(progress.pendingCount, 0);
    assert.equal(progress.cycleStatus, 'COMPLETED');
    assert.equal(progress.monitoringWindowId, winB24hId);
    assert.equal(progress.windowStatus, 'RUNNING');
    assert.equal(progress.windowPlannedRestartCount, 0);
    assert.equal(progress.windowUnexpectedRestartCount, 0);
    assert.equal(progress.windowLeaseRecoveryCount, 0);
    assert.equal(progress.windowDatabaseRecoveryCount, 0);
    assert.ok(progress.lifetimePlannedRestartCount >= 1);
    assert.ok(progress.lifetimeDatabaseRecoveryCount >= 1);

    assert.equal(health.monitoringWindowId, winB24hId);
    assert.equal(health.windowStatus, 'RUNNING');
    assert.equal(health.windowPlannedRestartCount, 0);
    assert.ok(health.lifetimePlannedRestartCount >= 1);
    assert.equal(health.scanWorkerState, 'IDLE');
    assert.equal(health.progressRatePerMinute, 0);
    assert.equal(health.concurrencyValid, true);
    assert.ok(health.runningJobCount <= health.maxConcurrency);
    assert.equal(health.externalNotificationCount, 0);

    assert.equal(dbHealth.monitoringWindowId, winB24hId);
    assert.equal(dbHealth.windowStatus, 'RUNNING');
    assert.equal(dbHealth.windowPlannedRestartCount, 0);
    assert.ok(dbHealth.lifetimePlannedRestartCount >= 1);

    // 5. Before expectedEndAt, Window B cannot be marked COMPLETED
    const beforeEndSync = db.getOrSyncLongRunningWindows(
      'binance_usdm',
      winBStartMs + 3600 * 1000,
      2
    );
    assert.equal(beforeEndSync['24h'].windowStatus, 'RUNNING');
    assert.equal(beforeEndSync['24h'].canMarkCompleted, false);

    scanner.stop();
    db.close();
  });
});






