import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BinanceFuturesAdapter,
  BingXFuturesAdapter,
  BybitFuturesAdapter,
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  ExchangeId,
  PaperQualityCyclesResponse,
  PaperQualityGateDriftResponse,
  PaperQualitySignalHistoryResponse,
  PaperQualitySingleCycleResponse,
  PaperQualityStatusResponse,
  PaperQualityWindowReportResponse,
  SmcScanResultRecord,
} from '../src/types/market.ts';

const TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

function createTempDb() {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'radar-phase14-aggregation-')
  );
  const dbPath = path.join(tmpDir, 'test-phase14.sqlite');
  const db = new RadarDatabase(dbPath);
  return { tmpDir, dbPath, db };
}

function createTestAdapters(): Record<ExchangeId, ExchangeAdapter> {
  return {
    binance_usdm: new BinanceFuturesAdapter(),
    bybit_linear: new BybitFuturesAdapter(),
    bingx_swap: new BingXFuturesAdapter(),
    demo_synthetic: new DemoExchangeAdapter(),
  };
}

function makeSmcResultRecord(
  symbol: string,
  scanCycleId: string,
  overrides: Partial<SmcScanResultRecord> = {}
): SmcScanResultRecord {
  const nowIso = new Date().toISOString();
  return {
    symbol,
    exchange: 'binance_usdm',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'WAIT',
    finalTradeSignal: 'NONE',
    marketRadarCategory: '準備觀察',
    evaluatedAt: nowIso,
    dataFetchedAt: nowIso,
    fetchedAt: nowIso,
    scanCycleId,
    windowKey: 'win_test_phase14',
    freshnessSeconds: 5,
    stale: false,
    fallback: false,
    missingData: [],
    source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
    isDemo: false,
    ruleVersion: SMC_RULE_VERSION,
    waitReasons: ['未偵測到明確的流動性掃蕩 (Liquidity Sweep)'],
    detectionLatencyMs: 25,
    ...overrides,
  };
}

function seedFourScanCyclesWithLatest236() {
  const { db } = createTempDb();
  const monitorDb = new PaperMonitorDatabase(db);
  const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
  const adapters = createTestAdapters();
  const smcBatchScanner = new SmcBatchScanService({ db, adapters });
  const monitor = new PaperShadowMonitor({
    radarDb: db,
    paperMonitorDb: monitorDb,
    outcomeTracker: tracker,
    adapters,
    smcBatchScanner,
  });

  const anchorIso = '2026-10-30T10:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);

  // Record 3 completed full-universe cycles (522 symbols each)
  const completedCycles = [
    {
      id: 'smc_cycle_cold_p14_c1',
      start: '2026-10-28T09:00:00.000Z',
      end: '2026-10-28T09:05:59.054Z',
      cacheMode: 'COLD' as const,
      duration: 359054,
      statsVer: 101,
    },
    {
      id: 'smc_cycle_warm_p14_c2',
      start: '2026-10-29T09:00:00.000Z',
      end: '2026-10-29T09:01:20.000Z',
      cacheMode: 'WARM' as const,
      duration: 80000,
      statsVer: 102,
    },
    {
      id: 'smc_cycle_warm_p14_c3',
      start: '2026-10-30T08:00:00.000Z',
      end: '2026-10-30T08:01:15.000Z',
      cacheMode: 'WARM' as const,
      duration: 75000,
      statsVer: 103,
    },
  ];

  for (const c of completedCycles) {
    db.recordCompletedSmcScanCycle({
      scanCycleId: c.id,
      exchange: 'binance_usdm',
      cycleStartedAt: c.start,
      cycleCompletedAt: c.end,
      cycleStatus: 'COMPLETED',
      cacheMode: c.cacheMode,
      completedHttpRequests: 2610,
      fullCycleDurationMs: c.duration,
      cacheHitRate: c.cacheMode === 'COLD' ? 0 : 100,
      cacheMissRate: c.cacheMode === 'COLD' ? 100 : 0,
      statsVersion: c.statsVer,
      totalContracts: 522,
      evaluatedCount: 522,
      pendingCount: 0,
      failedCount: 0,
      rateLimitedCount: 0,
      waitCount: 510,
      watchCount: 10,
      highRiskCount: 2,
      longCandidateCount: 0,
      shortCandidateCount: 0,
      gatePassSummary: {
        'BOS/MSS': {
          passCount: 60,
          failCount: 462,
          passRate: 11.49,
          evaluatedDenominator: 522,
          excludedCount: 0,
        },
        'Liquidity Sweep': {
          passCount: 30,
          failCount: 492,
          passRate: 5.75,
          evaluatedDenominator: 522,
          excludedCount: 0,
        },
        Displacement: {
          passCount: 120,
          failCount: 402,
          passRate: 22.99,
          evaluatedDenominator: 522,
          excludedCount: 0,
        },
        'FVG/Order Block': {
          passCount: 200,
          failCount: 322,
          passRate: 38.31,
          evaluatedDenominator: 522,
          excludedCount: 0,
        },
        'MTF Alignment': {
          passCount: 95,
          failCount: 427,
          passRate: 18.2,
          evaluatedDenominator: 522,
          excludedCount: 0,
        },
      },
    });
  }

  // Record 4th cycle (interrupted/partial with 236 evaluated out of 522, 286 pending)
  const latestCycleId = 'smc_cycle_warm_p14_c4_partial236';
  const latestCycleEvalIso = '2026-10-30T09:58:00.000Z';
  for (let i = 1; i <= 236; i++) {
    const isWatch = i <= 6;
    const isHighRisk = i === 7 || i === 8;
    db.saveSmcScanResult(
      makeSmcResultRecord(`SYM${i}USDT`, latestCycleId, {
        evaluatedAt: latestCycleEvalIso,
        dataFetchedAt: latestCycleEvalIso,
        fetchedAt: latestCycleEvalIso,
        smcActionState: isWatch ? 'WATCH' : isHighRisk ? 'HIGH RISK' : 'WAIT',
        isFastLane: i <= 29,
        priorityClass: i <= 29 ? 'FAST_LANE' : 'BULK',
        priorityTier: i <= 29 ? 1 : 6,
        detectionLatencyMs: i <= 29 ? 15 + i : 80 + i,
      })
    );
  }

  // Enqueue 286 pending jobs so totalSymbols = 236 + 286 = 522
  const pendingJobs = [];
  for (let i = 237; i <= 522; i++) {
    pendingJobs.push({
      symbol: `SYM${i}USDT`,
      exchange: 'binance_usdm' as const,
      priority: i,
      priorityTier: 6 as const,
      priorityLabel: 'T6_FULL_MARKET_BULK',
      priorityClass: 'BULK' as const,
      status: 'QUEUED' as const,
      ruleVersion: SMC_RULE_VERSION,
      windowKey: 'win_test_phase14',
      requestedAt: anchorIso,
      startedAt: null,
      completedAt: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
    });
  }
  db.enqueueSmcScanJobs(pendingJobs, false, false);

  return {
    db,
    monitorDb,
    monitor,
    anchorIso,
    anchorMs,
    latestCycleId,
  };
}

test('Phase 14 (1, 2, 5 & 6): latestCycleEvaluatedCount、uniqueEvaluatedSymbols、cumulativeEvaluationEvents 三者正確分離；4 個掃描週期時累計事件 = 1802 (絕不誤顯為 236)，且 30d/60d/90d 同時提供三種聚合統計與 uniqueEvaluatedSymbols + excludedSymbols = evaluationUniverseSize', () => {
  const { monitor, anchorIso, anchorMs } = seedFourScanCyclesWithLatest236();

  const status = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );

  // 4 scan cycles in window: 3 completed (522 each) + 1 interrupted (236)
  assert.equal(status.totalScanCycles, 4);
  assert.equal(status.completedScanCycles, 3);
  assert.equal(status.interruptedScanCycles, 1);

  // Explicit separation of the 3 aggregation fields
  assert.equal(status.latestCycleEvaluatedCount, 236);
  assert.equal(status.uniqueEvaluatedSymbols, 236);
  assert.equal(status.evaluationAggregationMode, 'DEDUPED_SYMBOLS');
  assert.equal(status.evaluationUniverseSize, 522);
  assert.equal(status.evaluationExcludedCount, 286);
  assert.equal(status.excludedSymbols, 286);

  // Cumulative evaluation events across the 4 cycles = 522 + 522 + 522 + 236 = 1802 (NOT 236!)
  assert.equal(status.cumulativeEvaluationEvents, 522 + 522 + 522 + 236);
  assert.notEqual(status.cumulativeEvaluationEvents, 236);

  // Identity: uniqueEvaluatedSymbols + excludedSymbols = evaluationUniverseSize
  assert.equal(
    status.uniqueEvaluatedSymbols + status.excludedSymbols,
    status.evaluationUniverseSize
  );
  assert.equal(status.identityChecks.uniqueUniverseIdentity.valid, true);
  assert.equal(status.identityChecks.uniqueUniverseIdentity.lhs, 522);
  assert.equal(status.identityChecks.uniqueUniverseIdentity.rhs, 522);
  assert.equal(status.statsConsistency, 'VALID');

  // Verify 30d, 60d, 90d each provide latestCycleStats, dedupedSymbolStats, cumulativeEventStats simultaneously
  for (const winKey of ['30d', '60d', '90d'] as const) {
    const win = status.windows[winKey];
    assert.equal(
      win.latestCycleStats.evaluationAggregationMode,
      'LATEST_CYCLE'
    );
    assert.equal(win.latestCycleStats.latestCycleEvaluatedCount, 236);

    assert.equal(
      win.dedupedSymbolStats.evaluationAggregationMode,
      'DEDUPED_SYMBOLS'
    );
    assert.equal(win.dedupedSymbolStats.uniqueEvaluatedSymbols, 236);
    assert.equal(win.dedupedSymbolStats.evaluationUniverseSize, 522);
    assert.equal(win.dedupedSymbolStats.excludedSymbols, 286);

    assert.equal(
      win.cumulativeEventStats.evaluationAggregationMode,
      'CUMULATIVE_EVENTS'
    );
    assert.equal(win.cumulativeEventStats.totalScanCycles, 4);
    assert.equal(win.cumulativeEventStats.completedScanCycles, 3);
    assert.equal(win.cumulativeEventStats.interruptedScanCycles, 1);
    assert.equal(win.cumulativeEventStats.cumulativeEvaluationEvents, 1802);
  }
});

test('Phase 14 (3 & 4): GET /api/paper-quality/cycles 與 /cycles/:cycleId 回傳完整週期明細，且每個週期獨立驗證統計恆等式', () => {
  const { monitor, anchorIso, anchorMs, latestCycleId } =
    seedFourScanCyclesWithLatest236();

  const cyclesResp = monitor.getPaperQualityCycles('binance_usdm', anchorMs, {
    window: '30d',
    reportAnchorAt: anchorIso,
  });

  assert.equal(cyclesResp.totalScanCycles, 4);
  assert.equal(cyclesResp.completedScanCycles, 3);
  assert.equal(cyclesResp.interruptedScanCycles, 1);
  assert.equal(cyclesResp.cycles.length, 4);
  assert.equal(cyclesResp.statsConsistency, 'VALID');

  for (const c of cyclesResp.cycles) {
    assert.ok(c.cycleId);
    assert.ok(c.cycleStartedAt);
    assert.equal(
      c.evaluatedCount + c.pendingCount + c.failedCount + c.rateLimitedCount,
      c.totalSymbols,
      `Cycle ${c.cycleId} must satisfy evaluated + pending + failed + rateLimited = totalSymbols`
    );
    assert.equal(
      c.waitCount +
        c.watchCount +
        c.highRiskCount +
        c.longCandidateCount +
        c.shortCandidateCount,
      c.evaluatedCount,
      `Cycle ${c.cycleId} must satisfy WAIT + WATCH + HIGH RISK + LONG + SHORT = evaluatedCount`
    );
    assert.equal(c.identityChecks.totalSymbolsIdentity.valid, true);
    assert.equal(c.identityChecks.actionStateIdentity.valid, true);
    assert.equal(c.identityChecks.uniqueUniverseIdentity.valid, true);
    assert.equal(c.statsConsistency, 'VALID');
    assert.ok(c.gateStats['BOS/MSS']);
    assert.equal(
      c.gateStats['BOS/MSS'].evaluatedDenominator,
      c.evaluatedCount
    );
  }

  // Verify single cycle lookup by ID
  const single1 = monitor.getPaperQualityCycleById(
    'smc_cycle_cold_p14_c1',
    'binance_usdm',
    anchorMs,
    { reportAnchorAt: anchorIso }
  );
  assert.ok(single1);
  assert.equal(single1.cycle.cycleId, 'smc_cycle_cold_p14_c1');
  assert.equal(single1.cycle.cacheMode, 'COLD');
  assert.equal(single1.cycle.evaluatedCount, 522);
  assert.equal(single1.cycle.pendingCount, 0);
  assert.equal(single1.cycle.fullUniverseCompletionDuration, 359054);
  assert.equal(single1.statsConsistency, 'VALID');

  const single4 = monitor.getPaperQualityCycleById(
    latestCycleId,
    'binance_usdm',
    anchorMs,
    { reportAnchorAt: anchorIso }
  );
  assert.ok(single4);
  assert.equal(single4.cycle.cycleId, latestCycleId);
  assert.equal(single4.cycle.evaluatedCount, 236);
  assert.equal(single4.cycle.pendingCount, 286);
  assert.equal(single4.cycle.totalSymbols, 522);
  assert.equal(single4.statsConsistency, 'VALID');

  const notFound = monitor.getPaperQualityCycleById(
    'non_existent_cycle_id',
    'binance_usdm',
    anchorMs,
    { reportAnchorAt: anchorIso }
  );
  assert.equal(notFound, null);
});

test('Phase 14 (7): Gate 穩定度與分母檢查 — 當兩週期 evaluatedCount 分母不同 (236 vs 522) 時，回傳 comparisonAllowed = false 與 comparisonReason = "DENOMINATOR_MISMATCH"', () => {
  const { monitor, anchorIso, anchorMs } = seedFourScanCyclesWithLatest236();

  const drift = monitor.getPaperQualityGateDrift('binance_usdm', anchorMs, {
    reportAnchorAt: anchorIso,
  });

  // Latest cycle has evaluatedCount = 236, previous cycle has evaluatedCount = 522
  const latestVsPrev = drift.comparisons.latest_vs_previous_cycle;
  assert.ok(latestVsPrev);
  assert.equal(latestVsPrev.shortEvaluatedDenominator, 236);
  assert.equal(latestVsPrev.longEvaluatedDenominator, 522);
  assert.equal(latestVsPrev.comparisonAllowed, false);
  assert.equal(latestVsPrev.comparisonReason, 'DENOMINATOR_MISMATCH');
  assert.equal(latestVsPrev.gatesRelaxed, false);
  assert.equal(latestVsPrev.thresholdAutoAdjusted, false);

  // Every metric in latest_vs_previous_cycle also reports DENOMINATOR_MISMATCH and comparisonAllowed=false
  for (const m of latestVsPrev.metrics) {
    assert.equal(m.shortEvaluatedDenominator, 236);
    assert.equal(m.longEvaluatedDenominator, 522);
    assert.equal(m.comparisonAllowed, false);
    assert.equal(m.comparisonReason, 'DENOMINATOR_MISMATCH');
  }
});

test('Phase 14 (8, 9 & 10): signal-history 完整保存候選訊號 8 階段生命週期，嚴格隔離歷史窗口外訊號 (2025-10-29 ATOMUSDT)，且 paperClosed = 0 時績效欄位維持 null', () => {
  const { monitor, monitorDb, anchorIso, anchorMs, latestCycleId } =
    seedFourScanCyclesWithLatest236();

  // 1) Historical out-of-window signal (2025-10-29T03:14:46.639Z)
  monitorDb.insertTrackedSignalIfAbsent({
    signalId: 'sig_hist_atom_2025',
    monitorRunId: 'mon_hist_2025',
    scanRunId: 'scan_hist_2025',
    scanCycleId: 'smc_cycle_hist_2025',
    databaseInstanceId: 'db_test_p14',
    symbol: 'ATOMUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    direction: 'LONG',
    marketRadarCategory: '雷達多頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'LONG CANDIDATE',
    finalTradeSignal: '多頭交易候選',
    snapshotAt: '2025-10-29T03:14:46.639Z',
    evaluatedAt: '2025-10-29T03:14:46.639Z',
    signalDetectedAt: '2025-10-29T03:14:46.639Z',
    signalBarOpenTime: Date.parse('2025-10-29T03:00:00.000Z'),
    signalBarCloseTime: Date.parse('2025-10-29T03:14:59.999Z'),
    originalEntryWindowOpenTime: Date.parse('2025-10-29T03:15:00.000Z'),
    originalEntryWindowCloseTime: Date.parse('2025-10-29T03:29:59.999Z'),
    detectionLatencyMs: 420,
    signalLatencyMs: 420,
    entryStatus: 'ENTRY_WINDOW_MISSED',
    entryWindowStatus: 'ENTRY_WINDOW_MISSED',
    entryReferenceTime: null,
    entryReferencePrice: null,
    stopLoss: 4.5,
    takeProfit: 5.2,
    status: 'ENTRY_WINDOW_MISSED',
    statusReason: '偵測時間晚於下一根 K 線開盤時間窗 (ENTRY_WINDOW_MISSED)',
    paperLedgerId: null,
    exitTime: null,
    exitPrice: null,
    riskMultiple: null,
    holdingTimeMs: null,
    ruleVersion: SMC_RULE_VERSION,
    stale: false,
    fallback: false,
    isDemo: false,
    missingData: [],
    waitReasons: [],
    evidences: ['15m Bullish Sweep & BOS'],
    source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
    decisionTrace: null,
    createdAt: '2025-10-29T03:14:46.639Z',
    updatedAt: '2025-10-29T03:14:46.639Z',
  });

  // 2) In-window candidate signal that missed entry window (2026-10-30T09:56:00.000Z)
  monitorDb.insertTrackedSignalIfAbsent({
    signalId: 'sig_inwin_sol_missed',
    monitorRunId: 'mon_p14',
    scanRunId: 'scan_run_p14_4cycles',
    scanCycleId: latestCycleId,
    databaseInstanceId: 'db_test_p14',
    symbol: 'SOLUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    direction: 'LONG',
    marketRadarCategory: '雷達多頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'LONG CANDIDATE',
    finalTradeSignal: '多頭交易候選',
    snapshotAt: '2026-10-30T09:56:00.000Z',
    evaluatedAt: '2026-10-30T09:56:00.000Z',
    signalDetectedAt: '2026-10-30T09:56:00.000Z',
    signalBarOpenTime: Date.parse('2026-10-30T09:30:00.000Z'),
    signalBarCloseTime: Date.parse('2026-10-30T09:44:59.999Z'),
    originalEntryWindowOpenTime: Date.parse('2026-10-30T09:45:00.000Z'),
    originalEntryWindowCloseTime: Date.parse('2026-10-30T09:59:59.999Z'),
    detectionLatencyMs: 660000,
    signalLatencyMs: 660000,
    entryStatus: 'ENTRY_WINDOW_MISSED',
    entryWindowStatus: 'ENTRY_WINDOW_MISSED',
    entryReferenceTime: null,
    entryReferencePrice: null,
    stopLoss: 175.0,
    takeProfit: 185.0,
    status: 'ENTRY_WINDOW_MISSED',
    statusReason: '偵測時間晚於下一根 K 線開盤時間窗 (ENTRY_WINDOW_MISSED)',
    paperLedgerId: null,
    exitTime: null,
    exitPrice: null,
    riskMultiple: null,
    holdingTimeMs: null,
    ruleVersion: SMC_RULE_VERSION,
    stale: false,
    fallback: false,
    isDemo: false,
    missingData: [],
    waitReasons: [],
    evidences: ['15m Bullish Sweep & BOS'],
    source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
    decisionTrace: null,
    createdAt: '2026-10-30T09:56:00.000Z',
    updatedAt: '2026-10-30T09:56:00.000Z',
  });

  const sigHist = monitor.getPaperQualitySignalHistory(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );

  assert.equal(sigHist.totalTrackedRecords, 2);
  assert.equal(sigHist.inWindowCount, 1);
  assert.equal(sigHist.outsideWindowCount, 1);
  assert.equal(sigHist.signalHistory.length, 1);
  assert.equal(sigHist.historicalSignalsOutsideWindow.length, 1);

  const inWinRec = sigHist.signalHistory[0];
  assert.equal(inWinRec.signalId, 'sig_inwin_sol_missed');
  assert.equal(inWinRec.symbol, 'SOLUSDT');
  assert.equal(inWinRec.sampleWindowMembership.inCurrentWindow, true);
  assert.equal(inWinRec.sampleWindowMembership.in30dWindow, true);
  assert.equal(inWinRec.lifecycle.currentStage, 'entryWindowMissed');
  assert.equal(inWinRec.lifecycle.candidateDetected.reached, true);
  assert.equal(inWinRec.lifecycle.entryWindowMissed.reached, true);
  assert.equal(inWinRec.lifecycle.paperOpened.reached, false);
  assert.equal(inWinRec.lifecycle.paperClosed.reached, false);

  const outWinRec = sigHist.historicalSignalsOutsideWindow[0];
  assert.equal(outWinRec.signalId, 'sig_hist_atom_2025');
  assert.equal(outWinRec.symbol, 'ATOMUSDT');
  assert.equal(outWinRec.sampleWindowMembership.inCurrentWindow, false);
  assert.equal(outWinRec.sampleWindowMembership.in30dWindow, false);
  assert.equal(outWinRec.sampleWindowMembership.in60dWindow, false);
  assert.equal(outWinRec.sampleWindowMembership.in90dWindow, false);

  // Verify report for 30d keeps paperClosed = 0 performance metrics strictly null
  const rep30d = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(rep30d.totalSignals, 1);
  assert.equal(rep30d.entryWindowMissed, 1);
  assert.equal(rep30d.paperClosed, 0);
  assert.equal(rep30d.metricStatus, 'ENTRY_WINDOW_MISSED');
  assert.equal(rep30d.winRate, null);
  assert.equal(rep30d.averageR, null);
  assert.equal(rep30d.profitFactor, null);
  assert.equal(rep30d.maxDrawdownR, null);
  assert.equal(rep30d.expectancyR, null);
  assert.equal(rep30d.averageHoldingTime, null);
  assert.equal(rep30d.noClosedTradesNotice, '目前仍無已結算交易');
  assert.equal(rep30d.zeroCandidateValidNotice, '候選數為 0 不代表掃描失敗');
});

test('Phase 14 (11): 實機 HTTP 整合驗證 — /api/paper-quality/cycles、/cycles/:cycleId、/signal-history、/status、/report、/gate-drift 一致性，下單 API 皆為 404，外部通知請求數為 0', async () => {
  const statusRes = await fetch(`${TEST_BASE_URL}/api/paper-quality/status`);
  assert.equal(statusRes.status, 200);
  const statusBody = (await statusRes.json()) as PaperQualityStatusResponse;

  assert.equal(statusBody.mode, 'PAPER ONLY');
  assert.equal(statusBody.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(statusBody.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
  assert.equal(statusBody.externalTelegramRequestsCount, 0);
  assert.equal(statusBody.externalTradingViewRequestsCount, 0);
  assert.equal(statusBody.statsConsistency, 'VALID');
  assert.equal(
    statusBody.uniqueEvaluatedSymbols + statusBody.excludedSymbols,
    statusBody.evaluationUniverseSize
  );

  const cyclesRes = await fetch(`${TEST_BASE_URL}/api/paper-quality/cycles`);
  assert.equal(cyclesRes.status, 200);
  const cyclesBody = (await cyclesRes.json()) as PaperQualityCyclesResponse;
  assert.equal(cyclesBody.statsConsistency, 'VALID');
  assert.ok(cyclesBody.cycles.length >= 1);

  const firstCycleId = cyclesBody.cycles[0].cycleId;
  const singleCycleRes = await fetch(
    `${TEST_BASE_URL}/api/paper-quality/cycles/${encodeURIComponent(firstCycleId)}`
  );
  assert.equal(singleCycleRes.status, 200);
  const singleCycleBody =
    (await singleCycleRes.json()) as PaperQualitySingleCycleResponse;
  assert.equal(singleCycleBody.cycle.cycleId, firstCycleId);
  assert.equal(singleCycleBody.cycle.statsConsistency, 'VALID');

  const sigHistRes = await fetch(
    `${TEST_BASE_URL}/api/paper-quality/signal-history?window=30d`
  );
  assert.equal(sigHistRes.status, 200);
  const sigHistBody =
    (await sigHistRes.json()) as PaperQualitySignalHistoryResponse;
  assert.equal(sigHistBody.statsConsistency, 'VALID');
  assert.ok(Array.isArray(sigHistBody.signalHistory));
  assert.ok(Array.isArray(sigHistBody.historicalSignalsOutsideWindow));

  const driftRes = await fetch(`${TEST_BASE_URL}/api/paper-quality/gate-drift`);
  assert.equal(driftRes.status, 200);
  const driftBody = (await driftRes.json()) as PaperQualityGateDriftResponse;
  assert.ok(driftBody.comparisons.latest_vs_previous_cycle);
  assert.equal(driftBody.gatesRelaxed, false);

  const rep30Res = await fetch(
    `${TEST_BASE_URL}/api/paper-quality/report?window=30d`
  );
  assert.equal(rep30Res.status, 200);
  const rep30Body =
    (await rep30Res.json()) as PaperQualityWindowReportResponse;
  assert.ok(rep30Body.latestCycleStats);
  assert.ok(rep30Body.dedupedSymbolStats);
  assert.ok(rep30Body.cumulativeEventStats);

  // Verify all order endpoints remain strictly 404
  for (const endpoint of [
    '/api/order',
    '/api/orders',
    '/api/trade',
    '/api/trades',
    '/api/execute',
    '/api/binance/order',
    '/api/bybit/order',
    '/api/bingx/order',
  ]) {
    const orderRes = await fetch(`${TEST_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 }),
    });
    assert.equal(
      orderRes.status,
      404,
      `Order endpoint ${endpoint} must return HTTP 404`
    );
  }
});
