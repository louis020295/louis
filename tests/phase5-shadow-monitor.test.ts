import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BinanceFuturesAdapter,
  BingXFuturesAdapter,
  BybitFuturesAdapter,
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { DataProvenance, ExchangeId, Kline } from '../src/types/market.ts';

function createTempDbPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sqlite`
  );
}

function buildConfirmedKlines(
  count: number,
  startOpenTimeMs: number,
  basePrice = 100
): Kline[] {
  const stepMs = 15 * 60 * 1000;
  const bars: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = startOpenTimeMs + i * stepMs;
    const closeTime = openTime + stepMs - 1;
    const open = basePrice + i * 0.2;
    const close = open + 0.1;
    bars.push({
      openTime,
      closeTime,
      open,
      high: close + 0.3,
      low: open - 0.3,
      close,
      volume: 1000 + i * 10,
      quoteVolume: (1000 + i * 10) * close,
      isClosed: true,
    });
  }
  return bars;
}

const LIVE_PROVENANCE: DataProvenance = {
  source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com/fapi/v1/klines)',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: false,
};

function createTestAdapters(): Record<ExchangeId, ExchangeAdapter> {
  return {
    binance_usdm: new BinanceFuturesAdapter(),
    bybit_linear: new BybitFuturesAdapter(),
    bingx_swap: new BingXFuturesAdapter(),
    demo_synthetic: new DemoExchangeAdapter(),
  };
}

describe('Phase 5: Long-Running Paper Shadow Monitor, Signal Outcome Tracker & Notification Sandbox', () => {
  it('1 & 6. Paper Shadow Monitor supports start, pause, resume, and service restart recovery without duplicating signalId', async () => {
    const dbPath = createTempDbPath('phase5_restart');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({
        db: radarDb,
        adapters,
      });

      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const started = await monitor.start({
        exchange: 'binance_usdm',
        runImmediateCycle: false,
      });
      assert.equal(started.workerState, 'RUNNING');
      assert.ok(started.monitorRunId.length > 0);
      assert.equal(started.mode, 'PAPER ONLY');
      assert.equal(started.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(started.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

      const paused = monitor.pause();
      assert.equal(paused.workerState, 'PAUSED');

      const resumed = await monitor.resume({ runImmediateCycle: false });
      assert.equal(resumed.workerState, 'RUNNING');

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);
      const sig1 = tracker.evaluateAndTrackSignal({
        monitorRunId: started.monitorRunId,
        scanRunId: started.scanRunId,
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: new Date(baseTime + 39 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 39 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 38,
        openInterest: 95000,
        fundingRate: 0.0001,
        provenance: LIVE_PROVENANCE,
        waitReasons: [],
        evidences: ['CHoCH:多頭結構轉換', 'FVG:公允價值缺口'],
      });

      assert.equal(sig1.insertedNew, true);
      assert.ok(sig1.signal !== null);

      monitor.stop();
      radarDb.close();

      // Simulate service restart on the exact same SQLite file
      const radarDb2 = new RadarDatabase(dbPath);
      const monitorDb2 = new PaperMonitorDatabase(radarDb2);
      const tracker2 = new SignalOutcomeTracker({ paperMonitorDb: monitorDb2 });
      const smcBatchScanner2 = new SmcBatchScanService({
        db: radarDb2,
        adapters,
      });
      const monitorAfterRestart = new PaperShadowMonitor({
        radarDb: radarDb2,
        paperMonitorDb: monitorDb2,
        outcomeTracker: tracker2,
        adapters,
        smcBatchScanner: smcBatchScanner2,
      });

      const recoveredStatus = monitorAfterRestart.getStatus();
      assert.equal(recoveredStatus.monitorRunId, started.monitorRunId);

      // Re-evaluating the exact same bar after restart must NOT create a duplicate signalId
      const sigAfterRestart = tracker2.evaluateAndTrackSignal({
        monitorRunId: started.monitorRunId,
        scanRunId: started.scanRunId,
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: new Date(baseTime + 39 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 39 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 38,
        openInterest: 95000,
        fundingRate: 0.0001,
        provenance: LIVE_PROVENANCE,
        waitReasons: [],
        evidences: ['CHoCH:多頭結構轉換', 'FVG:公允價值缺口'],
      });

      assert.equal(sigAfterRestart.insertedNew, false);
      assert.equal(sigAfterRestart.signal?.signalId, sig1.signal?.signalId);

      const allSignals = monitorDb2.listTrackedSignals({
        exchange: 'binance_usdm',
      });
      assert.equal(allSignals.length, 1);
      monitorAfterRestart.stop();
      radarDb2.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('2 & 3. Only EVALUATED signals passing full SMC Gate create tradable paper signals; PENDING / WAIT / WATCH / HIGH RISK are strictly blocked', () => {
    const dbPath = createTempDbPath('phase5_gates');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const baseTime = 1_710_100_000_000;
      const bars = buildConfirmedKlines(35, baseTime, 100);

      const nonCandidates = [
        {
          symbol: 'ETHUSDT',
          smcEvaluationStatus: 'PENDING' as const,
          smcActionState: 'PENDING' as const,
          finalTradeSignal: 'NONE' as const,
          waitReasons: ['SMC_PENDING_EVALUATION'],
        },
        {
          symbol: 'SOLUSDT',
          smcEvaluationStatus: 'EVALUATED' as const,
          smcActionState: 'WAIT' as const,
          finalTradeSignal: 'NONE' as const,
          waitReasons: ['NO_FVG_NOR_OB'],
        },
        {
          symbol: 'BNBUSDT',
          smcEvaluationStatus: 'EVALUATED' as const,
          smcActionState: 'WATCH' as const,
          finalTradeSignal: 'NONE' as const,
          waitReasons: ['OUTSIDE_KILLZONE'],
        },
        {
          symbol: 'DOGEUSDT',
          smcEvaluationStatus: 'EVALUATED' as const,
          smcActionState: 'HIGH RISK' as const,
          finalTradeSignal: 'NONE' as const,
          waitReasons: ['EXTREME_FUNDING_RATE'],
        },
      ];

      for (const item of nonCandidates) {
        const res = tracker.evaluateAndTrackSignal({
          monitorRunId: 'pmon_test_1',
          scanRunId: 'scan_non_cand',
          symbol: item.symbol,
          exchange: 'binance_usdm',
          timeframe: '15m',
          marketRadarCategory: '準備觀察',
          smcEvaluationStatus: item.smcEvaluationStatus,
          smcActionState: item.smcActionState,
          finalTradeSignal: item.finalTradeSignal,
          snapshotAt: new Date(baseTime + 34 * 900_000).toISOString(),
          evaluatedAt: new Date(baseTime + 34 * 900_000).toISOString(),
          klines: bars,
          signalBarIndex: 33,
          openInterest: 50000,
          fundingRate: 0.0001,
          provenance: LIVE_PROVENANCE,
          waitReasons: item.waitReasons,
          evidences: [],
          recordBlockedInDb: true,
          enqueueSandboxNotifications: true,
        });

        assert.equal(res.signal?.status, 'BLOCKED');
        assert.equal(res.outboxRecords[0]?.status, 'NON_CANDIDATE_BLOCKED');
      }

      // Paper trading ledger must have 0 entries for blocked non-candidate signals
      assert.equal(radarDb.listPaperLedgerEntries().length, 0);
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('4 & 5. Entry price strictly uses bar i+1 open price and never changes; same-bar SL + TP touch conservatively settles as PAPER_CLOSED_LOSS (-1R)', () => {
    const dbPath = createTempDbPath('phase5_execution');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const baseTime = 1_710_200_000_000;
      const bars = buildConfirmedKlines(35, baseTime, 100);

      // Signal at last bar (index 34) where bar i+1 (index 35) does not exist yet
      const pendingNextBar = tracker.evaluateAndTrackSignal({
        monitorRunId: 'pmon_exec',
        scanRunId: 'scan_wait_i_plus_1',
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: new Date(baseTime + 34 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 34 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 34,
        atr14: 2.0,
        openInterest: 45000,
        fundingRate: 0.0001,
        provenance: LIVE_PROVENANCE,
        waitReasons: [],
        evidences: ['BOS:結構突破'],
      });

      assert.equal(pendingNextBar.signal?.status, 'CREATED');
      assert.equal(pendingNextBar.signal?.entryReferencePrice, null);

      // Bar i+1 (index 35) arrives with open = 108.5, and bar 36 touches BOTH stopLoss and takeProfit
      const bar35: Kline = {
        openTime: baseTime + 35 * 900_000,
        closeTime: baseTime + 36 * 900_000 - 1,
        open: 108.5,
        high: 109.2,
        low: 108.1,
        close: 109.0,
        volume: 1500,
        quoteVolume: 1500 * 109,
        isClosed: true,
      };
      const bar36SameBarSlTp: Kline = {
        openTime: baseTime + 36 * 900_000,
        closeTime: baseTime + 37 * 900_000 - 1,
        open: 109.0,
        high: 125.0, // touches takeProfit
        low: 90.0, // touches stopLoss
        close: 110.0,
        volume: 2000,
        quoteVolume: 2000 * 110,
        isClosed: true,
      };

      const updated = tracker.settleSignalWithKlines({
        signalId: pendingNextBar.signal!.signalId,
        klines: [...bars, bar35, bar36SameBarSlTp],
        atr14: 2.0,
      });

      assert.ok(updated !== null);
      // Locked strictly to bar 35 open price = 108.5
      assert.equal(updated!.entryReferencePrice, 108.5);
      assert.equal(
        updated!.entryReferenceTime,
        new Date(bar35.openTime).toISOString()
      );
      // Conservatively adjudicated as stop loss on bar 36
      assert.equal(updated!.status, 'PAPER_CLOSED_LOSS');
      assert.equal(updated!.riskMultiple, -1.0);
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('7 & 8. Notification Sandbox only writes to local notification_outbox with 0 external calls, and enforces deduplication and cooldown', () => {
    const dbPath = createTempDbPath('phase5_sandbox');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const baseTime = 1_710_300_000_000;
      const bars = buildConfirmedKlines(37, baseTime, 100);

      const first = tracker.evaluateAndTrackSignal({
        monitorRunId: 'pmon_sbx',
        scanRunId: 'scan_sandbox_1',
        symbol: 'LINKUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: new Date(baseTime + 34 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 34 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 34,
        openInterest: 62000,
        fundingRate: 0.0001,
        provenance: LIVE_PROVENANCE,
        waitReasons: [],
        evidences: ['CHoCH:多頭轉換', 'OB:多頭訂單塊'],
      });

      assert.equal(first.outboxRecords[0]?.status, 'SANDBOX_QUEUED');

      // Duplicate notification with identical dedupeKey must be DEDUPED_BLOCKED
      const dupeOutbox = tracker.dispatchToSandboxOutbox({
        monitorRunId: 'pmon_sbx',
        scanRunId: 'scan_sandbox_1',
        signalId: first.signal!.signalId,
        exchange: 'binance_usdm',
        channel: 'TELEGRAM_SANDBOX',
        payload: first.outboxRecords[0].payload,
      });
      assert.equal(dupeOutbox.status, 'DEDUPED_BLOCKED');

      // Cooldown check: a new signal on the same symbol + direction within cooldown window with different evidences must be COOLDOWN_BLOCKED
      const secondSignalSameSymbol = tracker.evaluateAndTrackSignal({
        monitorRunId: 'pmon_sbx',
        scanRunId: 'scan_sandbox_2',
        symbol: 'LINKUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: new Date(baseTime + 35 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 35 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 35,
        openInterest: 63000,
        fundingRate: 0.0001,
        provenance: LIVE_PROVENANCE,
        waitReasons: [],
        evidences: ['BOS:結構延續', 'FVG:缺口支撐'],
      });

      assert.equal(
        secondSignalSameSymbol.outboxRecords[0]?.status,
        'COOLDOWN_BLOCKED'
      );

      // Explicit preview on signalId writes PREVIEW_DRY_RUN to notification_outbox
      const previewRecord = tracker.generatePreviewForSignalId(
        first.signal!.signalId,
        'TRADINGVIEW_SANDBOX'
      );
      assert.equal(previewRecord?.status, 'PREVIEW_DRY_RUN');

      // Zero external calls
      assert.equal(tracker.externalTelegramRequestsCount, 0);
      assert.equal(tracker.externalTradingViewRequestsCount, 0);
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('9, 10, 11 & 14. 24h / 7d / 30d reports return metricStatus = NO_TRADES with null metrics when paperClosed === 0, statsVersion is strictly monotonic, finalCategorySmcMismatchCount is 0, and safety flags hold', () => {
    const dbPath = createTempDbPath('phase5_reports');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const v0 = radarDb.getSmcStatsVersion('binance_usdm');

      for (const window of ['24h', '7d', '30d'] as const) {
        const report = tracker.buildWindowReport({
          window,
          exchange: 'binance_usdm',
          monitorRunId: 'pmon_rep',
          scanRunId: 'scan_rep',
        });
        assert.equal(report.metricStatus, 'NO_TRADES');
        assert.equal(report.sampleSufficiencyNotice, '樣本不足，僅供觀察');
        assert.equal(report.winRate, null);
        assert.equal(report.averageR, null);
        assert.equal(report.profitFactor, null);
        assert.equal(report.maxDrawdownR, null);
        assert.equal(report.expectancyR, null);
        assert.equal(report.averageHoldingTime, null);
        assert.equal(report.mode, 'PAPER ONLY');
        assert.equal(report.liveOrders, 'LIVE ORDERS DISABLED');
        assert.equal(report.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
      }

      const v1 = radarDb.incrementSmcStatsVersion('binance_usdm');
      const v2 = radarDb.incrementSmcStatsVersion('binance_usdm');
      assert.ok(v1 > v0);
      assert.ok(v2 > v1);
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('12 & 13. Live API failure never falls back to Demo data, and HTTP 429 increments rateLimitCount with backoff warning', async () => {
    const dbPath = createTempDbPath('phase5_resilience');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({
        db: radarDb,
        adapters,
      });

      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      // Simulate HTTP 503 failure
      const statusOn503 = await monitor.runSingleCycle({
        simulateHttpStatus: 503,
      });
      assert.equal(statusOn503.workerState, 'ERROR');
      assert.ok(statusOn503.lastError?.includes('503'));
      // Must never inject Demo signals into paper_tracked_signals
      assert.equal(
        monitorDb.listTrackedSignals({ exchange: 'binance_usdm' }).length,
        0
      );

      // Simulate HTTP 429 rate limit event
      await monitor.runSingleCycle({
        simulateHttpStatus: 429,
      });
      const health = monitor.getHealth();
      assert.ok(health.rateLimitCount >= 1);
      assert.equal(health.finalCategorySmcMismatchCount, 0);
      assert.ok(
        health.warnings.some((w) => w.includes('429') || w.includes('API'))
      );

      monitor.stop();
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('15. Full Scan Cycle identification (scanCycleId, cycleStatus RUNNING -> COMPLETED), FAILED job isolation, and per-result field integrity', async () => {
    const dbPath = createTempDbPath('phase5_cycle');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();

      let failThirdSymbol = true;
      adapters.binance_usdm.fetchKlines = async (symbol: string) => {
        if (symbol === 'SOLUSDT' && failThirdSymbol) {
          throw new Error('Upstream transient 500 failure on SOLUSDT');
        }
        return {
          klines: buildConfirmedKlines(60, 1_710_500_000_000, 100),
          provenance: LIVE_PROVENANCE,
        };
      };
      adapters.binance_usdm.fetchOpenInterest = async () => ({
        openInterest: 500_000,
        openInterestValue: 50_000_000,
        provenance: LIVE_PROVENANCE,
      });

      const smcBatchScanner = new SmcBatchScanService({
        db: radarDb,
        adapters,
        config: {
          maxConcurrency: 2,
          batchSize: 10,
          maxRetries: 1,
          baseBackoffMs: 20,
        },
      });

      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const requestedAt = new Date().toISOString();
      radarDb.enqueueSmcScanJobs([
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 50000,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          status: 'QUEUED',
          ruleVersion: 'smc-v1.0.0',
          windowKey: 'win_cycle_test',
          requestedAt,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
        {
          symbol: 'ETHUSDT',
          exchange: 'binance_usdm',
          priority: 49000,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          status: 'QUEUED',
          ruleVersion: 'smc-v1.0.0',
          windowKey: 'win_cycle_test',
          requestedAt,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
        {
          symbol: 'SOLUSDT',
          exchange: 'binance_usdm',
          priority: 48000,
          priorityTier: 1,
          priorityLabel: '1_WATCHLIST',
          status: 'QUEUED',
          ruleVersion: 'smc-v1.0.0',
          windowKey: 'win_cycle_test',
          requestedAt,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ]);

      // Before processing: pendingCount = 3 -> cycleStatus MUST be RUNNING
      const statusBefore = monitor.getStatus();
      assert.ok(statusBefore.scanCycleId.startsWith('cycle_binance_usdm_'));
      assert.equal(statusBefore.totalContracts, 3);
      assert.equal(statusBefore.evaluatedCount, 0);
      assert.equal(statusBefore.pendingCount, 3);
      assert.equal(statusBefore.cycleStatus, 'RUNNING');
      assert.equal(statusBefore.cycleCompletedAt, null);

      // Process batch where SOLUSDT fails -> evaluatedCount = 2, failedCount = 1, pendingCount = 0 -> cycleStatus MUST stay RUNNING
      await smcBatchScanner.processNextBatch('binance_usdm', 'live', 3);
      const statusWithFailed = monitor.getStatus();
      assert.equal(statusWithFailed.totalContracts, 3);
      assert.equal(statusWithFailed.evaluatedCount, 2);
      assert.equal(statusWithFailed.failedCount, 1);
      assert.equal(statusWithFailed.pendingCount, 0);
      assert.equal(statusWithFailed.cycleStatus, 'RUNNING');
      assert.equal(statusWithFailed.cycleCompletedAt, null);

      // Now allow SOLUSDT to succeed and re-enqueue it
      failThirdSymbol = false;
      await smcBatchScanner.refreshSingleSymbol({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        mode: 'live',
        executeImmediately: true,
      });

      const statusCompleted = monitor.getStatus();
      assert.equal(statusCompleted.totalContracts, 3);
      assert.equal(statusCompleted.evaluatedCount, 3);
      assert.equal(statusCompleted.pendingCount, 0);
      assert.equal(statusCompleted.queuedCount, 0);
      assert.equal(statusCompleted.runningJobCount, 0);
      assert.equal(statusCompleted.failedCount, 0);
      assert.equal(statusCompleted.rateLimitedCount, 0);
      assert.equal(statusCompleted.cycleStatus, 'COMPLETED');
      assert.ok(typeof statusCompleted.cycleCompletedAt === 'string');

      // Verify every single evaluated SMC result record has all 12 required fields
      const allResults = radarDb.listSmcScanResults('binance_usdm');
      assert.equal(allResults.length, 3);
      for (const r of allResults) {
        assert.equal(r.smcEvaluationStatus, 'EVALUATED');
        assert.ok(r.smcActionState !== 'PENDING');
        assert.ok(typeof r.marketRadarCategory === 'string');
        assert.ok(typeof r.finalTradeSignal === 'string');
        assert.ok(typeof r.evaluatedAt === 'string');
        assert.ok(typeof r.source === 'string');
        assert.ok(typeof r.fetchedAt === 'string');
        assert.equal(typeof r.stale, 'boolean');
        assert.equal(typeof r.fallback, 'boolean');
        assert.ok(Array.isArray(r.missingData));
        assert.ok(typeof r.ruleVersion === 'string');
        assert.ok(typeof r.scanCycleId === 'string');
      }

      monitor.stop();
      radarDb.close();
    } finally {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });
});
