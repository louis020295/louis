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
import { ExchangeId, Kline, SmcScanResultRecord } from '../src/types/market.ts';

const TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

function createTempDb() {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'radar-phase12-paper-quality-')
  );
  const dbPath = path.join(tmpDir, 'test-phase12.sqlite');
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
      high: close + 0.5,
      low: open - 0.5,
      close,
      volume: 50000,
      quoteVolume: 50000 * close,
      isClosed: true,
    });
  }
  return bars;
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
    windowKey: 'win_test_phase12',
    freshnessSeconds: 5,
    stale: false,
    fallback: false,
    missingData: [],
    source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
    isDemo: false,
    ruleVersion: SMC_RULE_VERSION,
    waitReasons: ['未偵測到明確的流動性掃蕩 (Liquidity Sweep)'],
    ...overrides,
  };
}

test('Phase 12 (1 & 2): 30d / 60d / 90d 時間窗口正確過濾 (windowStartAt <= eventTime < windowEndAt)，且窗口外歷史訊號不得混入窗口統計', () => {
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

  const anchorIso = '2026-10-30T00:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', 'smc_cycle_cold_p12_w1', {
      evaluatedAt: anchorIso,
      dataFetchedAt: anchorIso,
      fetchedAt: anchorIso,
    })
  );

  const seedSignalAt = (symbol: string, detectedIso: string) => {
    const detMs = Date.parse(detectedIso);
    const sigBarOpenMs = detMs - 15 * 60 * 1000;
    const baseMs = sigBarOpenMs - 35 * 15 * 60 * 1000;
    const bars36 = buildConfirmedKlines(36, baseMs, 100);
    return tracker.evaluateAndTrackSignal({
      monitorRunId: 'pmon_p12_windows',
      scanRunId: 'scan_p12_windows',
      scanCycleId: `smc_cycle_cold_${symbol}`,
      symbol,
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: SMC_RULE_VERSION,
      snapshotAt: detectedIso,
      evaluatedAt: detectedIso,
      signalDetectedAt: detectedIso,
      klines: bars36,
      signalBarIndex: 35,
      atr14: 0.8,
      openInterest: 15_000_000,
      fundingRate: 0.0001,
      waitReasons: [],
      evidences: ['15m Bullish Sweep & BOS'],
      provenance: {
        source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: detectedIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      isBacktest: false,
    });
  };

  // 1) Signal 10 days ago (inside 30d, 60d, 90d)
  seedSignalAt('SOLUSDT', '2026-10-20T12:00:00.000Z');
  // 2) Signal 45 days ago (outside 30d, inside 60d & 90d)
  seedSignalAt('AVAXUSDT', '2026-09-15T12:00:00.000Z');
  // 3) Signal 75 days ago (outside 30d & 60d, inside 90d)
  seedSignalAt('LINKUSDT', '2026-08-16T12:00:00.000Z');
  // 4) Signal 366 days ago (ATOMUSDT 2025-10-29 — outside 30d, 60d, 90d)
  seedSignalAt('ATOMUSDT', '2025-10-29T03:14:46.639Z');

  const rep30d = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  const rep60d = monitor.getPaperQualityReport(
    '60d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  const rep90d = monitor.getPaperQualityReport(
    '90d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );

  // Verify exact half-open intervals
  assert.equal(rep30d.windowStartAt, '2026-09-30T00:00:00.000Z');
  assert.equal(rep30d.windowEndAt, '2026-10-30T00:00:00.000Z');
  assert.equal(rep30d.totalSignals, 1);
  assert.equal(rep30d.signals[0].symbol, 'SOLUSDT');
  assert.equal(rep30d.historicalSignalsOutsideWindowCount, 3);

  assert.equal(rep60d.windowStartAt, '2026-08-31T00:00:00.000Z');
  assert.equal(rep60d.windowEndAt, '2026-10-30T00:00:00.000Z');
  assert.equal(rep60d.totalSignals, 2);
  assert.equal(rep60d.historicalSignalsOutsideWindowCount, 2);

  assert.equal(rep90d.windowStartAt, '2026-08-01T00:00:00.000Z');
  assert.equal(rep90d.windowEndAt, '2026-10-30T00:00:00.000Z');
  assert.equal(rep90d.totalSignals, 3);
  // ATOMUSDT (2025-10-29) is strictly excluded even from 90d
  assert.equal(
    rep90d.signals.some((s) => s.symbol === 'ATOMUSDT'),
    false
  );
  assert.equal(rep90d.historicalSignalsOutsideWindowCount, 1);
  assert.equal(rep90d.historicalSignalsOutsideWindow[0].symbol, 'ATOMUSDT');
});

test('Phase 12 (3, 4 & 5): ENTRY_WINDOW_MISSED 不得建立回溯開倉、未結算交易不得計入勝率、樣本不足三階層門檻 (<30 INSUFFICIENT, 30..99 LIMITED, >=100 SUFFICIENT) 與 null 績效欄位', () => {
  // Verify 3-tier sample sufficiency thresholds
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(0), 'INSUFFICIENT');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(1), 'INSUFFICIENT');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(29), 'INSUFFICIENT');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(30), 'LIMITED');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(99), 'LIMITED');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(100), 'SUFFICIENT');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(250), 'SUFFICIENT');

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

  const anchorIso = '2026-10-30T00:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', 'smc_cycle_cold_p12_t3', {
      evaluatedAt: anchorIso,
      dataFetchedAt: anchorIso,
      fetchedAt: anchorIso,
    })
  );

  // Test 3: ENTRY_WINDOW_MISSED when signalDetectedAt >= entryWindowOpenTime
  const sigBarOpenMs = Date.parse('2026-10-29T10:00:00.000Z');
  const nextBarOpenMs = Date.parse('2026-10-29T10:15:00.000Z');
  const lateDetectedIso = '2026-10-29T10:16:30.000Z'; // > 10:15:00.000Z
  const baseMs = sigBarOpenMs - 35 * 15 * 60 * 1000;
  const bars36 = buildConfirmedKlines(36, baseMs, 50);
  const nextBar: Kline = {
    openTime: nextBarOpenMs,
    closeTime: nextBarOpenMs + 15 * 60 * 1000 - 1,
    open: 55.5,
    high: 56.2,
    low: 55.1,
    close: 55.8,
    volume: 80000,
    quoteVolume: 80000 * 55.8,
    isClosed: true,
  };

  const missedRes = tracker.evaluateAndTrackSignal({
    monitorRunId: 'pmon_p12_t3',
    scanRunId: 'scan_p12_t3',
    scanCycleId: 'smc_cycle_cold_p12_t3',
    symbol: 'SUIUSDT',
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
    klines: [...bars36, nextBar],
    signalBarIndex: 35,
    atr14: 0.4,
    openInterest: 12_000_000,
    fundingRate: 0.0001,
    waitReasons: [],
    evidences: ['15m Bullish Sweep & BOS'],
    provenance: {
      source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: lateDetectedIso,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
    isBacktest: false,
  });

  assert.ok(missedRes.signal);
  assert.equal(missedRes.signal.status, 'ENTRY_WINDOW_MISSED');
  assert.equal(missedRes.signal.entryStatus, 'ENTRY_WINDOW_MISSED');
  assert.equal(missedRes.signal.entryReferencePrice, null);
  assert.equal(missedRes.signal.paperOpenedAt, null);
  assert.equal(missedRes.signal.paperClosedAt, null);
  assert.equal(missedRes.signal.closeReason, null);
  assert.equal(missedRes.signal.resultR, null);

  const repMissed = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(repMissed.totalSignals, 1);
  assert.equal(repMissed.entryWindowMissed, 1);
  assert.equal(repMissed.paperOpened, 0);
  assert.equal(repMissed.paperClosed, 0);
  assert.equal(repMissed.metricStatus, 'ENTRY_WINDOW_MISSED');
  assert.equal(repMissed.winRate, null);
  assert.equal(repMissed.averageR, null);
  assert.equal(repMissed.profitFactor, null);
  assert.equal(repMissed.maxDrawdownR, null);
  assert.equal(repMissed.expectancyR, null);
  assert.equal(repMissed.averageHoldingTime, null);
  assert.equal(repMissed.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(repMissed.sampleSufficiencyNotice, '樣本不足，僅供觀察');

  // Test 4: Open trade without closed result -> metricStatus = OPEN_TRADES_NO_CLOSED_RESULTS, winRate = null
  const timelyDetectedIso = '2026-10-29T10:14:59.999Z'; // < 10:15:00.000Z
  const openedRes = tracker.evaluateAndTrackSignal({
    monitorRunId: 'pmon_p12_t4',
    scanRunId: 'scan_p12_t4',
    scanCycleId: 'smc_cycle_cold_p12_t3',
    symbol: 'APTUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    marketRadarCategory: '雷達多頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'LONG CANDIDATE',
    finalTradeSignal: '多頭交易候選',
    ruleVersion: SMC_RULE_VERSION,
    snapshotAt: timelyDetectedIso,
    evaluatedAt: timelyDetectedIso,
    signalDetectedAt: timelyDetectedIso,
    klines: [...bars36, nextBar], // nextBar neither hits SL nor TP
    signalBarIndex: 35,
    atr14: 2.5, // wide ATR so SL and TP are not touched on nextBar
    openInterest: 12_000_000,
    fundingRate: 0.0001,
    waitReasons: [],
    evidences: ['15m Bullish Sweep & BOS'],
    provenance: {
      source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: timelyDetectedIso,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
    isBacktest: false,
  });

  assert.ok(openedRes.signal);
  assert.equal(openedRes.signal.status, 'PAPER_OPENED');
  assert.equal(openedRes.signal.entryStatus, 'PAPER_OPENED');
  assert.equal(openedRes.signal.entryWindowStatus, '已於原始進場窗口開盤進場');
  assert.equal(openedRes.signal.entryReferencePrice, 55.5);
  assert.ok(openedRes.signal.paperOpenedAt);
  assert.equal(openedRes.signal.paperClosedAt, null);
  assert.equal(openedRes.signal.closeReason, null);
  assert.equal(openedRes.signal.resultR, null);

  const repOpened = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(repOpened.paperOpened, 1);
  assert.equal(repOpened.paperClosed, 0);
  assert.equal(repOpened.metricStatus, 'OPEN_TRADES_NO_CLOSED_RESULTS');
  assert.equal(repOpened.winRate, null);
  assert.equal(repOpened.averageR, null);
  assert.equal(repOpened.profitFactor, null);
  assert.equal(repOpened.maxDrawdownR, null);
  assert.equal(repOpened.expectancyR, null);
  assert.equal(repOpened.averageHoldingTime, null);
});

test('Phase 12 (6, 7 & 8): WAIT/WATCH/HIGH RISK、stale/fallback/missingData 與 Demo 資料均不得建立 Live Paper 訊號', () => {
  const { db } = createTempDb();
  const monitorDb = new PaperMonitorDatabase(db);
  const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

  const nowIso = '2026-10-30T00:00:00.000Z';
  const baseMs = Date.parse('2026-10-29T00:00:00.000Z');
  const bars36 = buildConfirmedKlines(36, baseMs, 100);

  // Test 6: WAIT / WATCH / HIGH RISK blocked
  for (const state of ['WAIT', 'WATCH', 'HIGH RISK'] as const) {
    const res = tracker.evaluateAndTrackSignal({
      monitorRunId: 'pmon_p12_block',
      scanRunId: 'scan_p12_block',
      symbol: `SYM_${state.replace(' ', '_')}`,
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '準備觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: state,
      finalTradeSignal: 'NONE',
      ruleVersion: SMC_RULE_VERSION,
      snapshotAt: nowIso,
      evaluatedAt: nowIso,
      klines: bars36,
      atr14: 1.0,
      openInterest: 10_000_000,
      fundingRate: 0.0001,
      waitReasons: ['結構未確認'],
      evidences: [],
      provenance: {
        source: 'Binance USD-M Futures Public REST API',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
      recordBlockedInDb: true,
    });
    assert.equal(res.signal?.status, 'BLOCKED');
    assert.ok(res.outboxRecords.every((o) => o.blockedReason !== null));
  }

  // Test 7: stale / fallback / missingData blocked even if LONG CANDIDATE
  const badProvenances = [
    { stale: true, fallback: false, missingData: [], isDemo: false },
    { stale: false, fallback: true, missingData: [], isDemo: false },
    { stale: false, fallback: false, missingData: ['openInterest'], isDemo: false },
    // Test 8: Demo data blocked
    { stale: false, fallback: false, missingData: [], isDemo: true },
  ];

  for (let i = 0; i < badProvenances.length; i++) {
    const p = badProvenances[i];
    const res = tracker.evaluateAndTrackSignal({
      monitorRunId: 'pmon_p12_block',
      scanRunId: 'scan_p12_block',
      symbol: `BAD_PROV_${i}`,
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      ruleVersion: SMC_RULE_VERSION,
      snapshotAt: nowIso,
      evaluatedAt: nowIso,
      klines: bars36,
      atr14: 1.0,
      openInterest: 10_000_000,
      fundingRate: 0.0001,
      waitReasons: [],
      evidences: ['15m Bullish Sweep & BOS'],
      provenance: {
        source: 'Binance USD-M Futures Public REST API',
        fetchedAt: nowIso,
        ...p,
      },
      recordBlockedInDb: true,
    });
    if (p.isDemo) {
      // Demo data is completely rejected from Live DB even when recordBlockedInDb=true
      assert.equal(res.signal, null);
    } else {
      assert.equal(res.signal?.status, 'BLOCKED');
    }
    assert.ok(res.outboxRecords.every((o) => o.blockedReason !== null));
  }

  const eligibleSignals = monitorDb
    .listTrackedSignals({ exchange: 'binance_usdm' })
    .filter((s) => s.status !== 'BLOCKED');
  assert.equal(eligibleSignals.length, 0);
});

test('Phase 12 (9): Gate 漂移異常時標記 QUALITY_DRIFT_SUSPECTED 且不自動放寬條件 (thresholdAutoAdjusted = false, gatesRelaxed = false)', () => {
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

  const anchorIso = '2026-10-30T00:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);

  // Older cycle (20 days ago, inside 30d but outside 7d): 80% pass rate on BOS/MSS & Sweep
  const oldCycleId = 'smc_cycle_cold_20261010_baseline';
  const oldCycleTime = '2026-10-10T00:00:00.000Z';
  db.recordCompletedSmcScanCycle({
    scanCycleId: oldCycleId,
    exchange: 'binance_usdm',
    cycleStartedAt: '2026-10-09T23:55:00.000Z',
    cycleCompletedAt: oldCycleTime,
    statsVersion: 1,
    totalContracts: 100,
    evaluatedCount: 100,
    pendingCount: 0,
    queuedCount: 0,
    runningJobCount: 0,
    failedCount: 0,
    rateLimitedCount: 0,
    waitCount: 20,
    watchCount: 75,
    highRiskCount: 3,
    longCandidateCount: 1,
    shortCandidateCount: 1,
    candidateStatus: 'HAS_CANDIDATES',
    gatePassSummary: {
      bosMss: { passCount: 80, failCount: 20, passRatePercent: 80 },
      liquiditySweep: { passCount: 75, failCount: 25, passRatePercent: 75 },
      displacement: { passCount: 70, failCount: 30, passRatePercent: 70 },
      fvgOrderBlock: { passCount: 68, failCount: 32, passRatePercent: 68 },
      mtfAlignment: { passCount: 55, failCount: 45, passRatePercent: 55 },
      oiAvailable: { passCount: 100, failCount: 0, passRatePercent: 100 },
      fundingAvailable: { passCount: 100, failCount: 0, passRatePercent: 100 },
    },
  });

  // Recent cycle (2 days ago, inside 7d): sudden drop to 10% pass rate on BOS/MSS & 95% WAIT
  const recentCycleId = 'smc_cycle_cold_20261028_recent';
  const recentCycleTime = '2026-10-28T00:00:00.000Z';
  db.recordCompletedSmcScanCycle({
    scanCycleId: recentCycleId,
    exchange: 'binance_usdm',
    cycleStartedAt: '2026-10-27T23:55:00.000Z',
    cycleCompletedAt: recentCycleTime,
    statsVersion: 2,
    totalContracts: 100,
    evaluatedCount: 100,
    pendingCount: 0,
    queuedCount: 0,
    runningJobCount: 0,
    failedCount: 0,
    rateLimitedCount: 0,
    waitCount: 95,
    watchCount: 5,
    highRiskCount: 0,
    longCandidateCount: 0,
    shortCandidateCount: 0,
    candidateStatus: 'NO_CANDIDATE_VALID',
    gatePassSummary: {
      bosMss: { passCount: 10, failCount: 90, passRatePercent: 10 },
      liquiditySweep: { passCount: 8, failCount: 92, passRatePercent: 8 },
      displacement: { passCount: 12, failCount: 88, passRatePercent: 12 },
      fvgOrderBlock: { passCount: 10, failCount: 90, passRatePercent: 10 },
      mtfAlignment: { passCount: 5, failCount: 95, passRatePercent: 5 },
      oiAvailable: { passCount: 100, failCount: 0, passRatePercent: 100 },
      fundingAvailable: { passCount: 100, failCount: 0, passRatePercent: 100 },
    },
  });

  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', recentCycleId, {
      evaluatedAt: recentCycleTime,
      dataFetchedAt: recentCycleTime,
      fetchedAt: recentCycleTime,
    })
  );

  const driftRes = monitor.getPaperQualityGateDrift('binance_usdm', anchorMs, {
    reportAnchorAt: anchorIso,
    driftThresholdPercent: 15,
  });

  assert.equal(driftRes.driftStatus, 'QUALITY_DRIFT_SUSPECTED');
  assert.equal(driftRes.thresholdAutoAdjusted, false);
  assert.equal(driftRes.gatesRelaxed, false);
  assert.equal(
    driftRes.comparisons['7d_vs_30d'].driftStatus,
    'QUALITY_DRIFT_SUSPECTED'
  );
  assert.equal(driftRes.comparisons['7d_vs_30d'].thresholdAutoAdjusted, false);
  assert.equal(driftRes.comparisons['7d_vs_30d'].gatesRelaxed, false);
  assert.ok(
    driftRes.comparisons['7d_vs_30d'].suspectedMetrics.includes('BOS/MSS')
  );
});

test('Phase 12 (10): 市場狀態分層統計等式成立 (各維度 bucket evaluatedCount 總和 = totalEvaluated，且樣本不足時 comparisonAllowed = false)', () => {
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

  const cycleId = 'smc_cycle_cold_p12_regimes';
  const nowIso = '2026-10-30T00:00:00.000Z';
  const nowMs = Date.parse(nowIso);

  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', cycleId, {
      smcActionState: 'WATCH',
      evaluatedAt: nowIso,
      waitReasons: ['跨週期趨勢衝突 (4H 與 1H/15m 結構未同向對齊)'],
    })
  );
  db.saveSmcScanResult(
    makeSmcResultRecord('ETHUSDT', cycleId, {
      smcActionState: 'WAIT',
      evaluatedAt: nowIso,
      waitReasons: ['未偵測到明確的流動性掃蕩 (Liquidity Sweep)'],
    })
  );
  db.saveSmcScanResult(
    makeSmcResultRecord('SOLUSDT', cycleId, {
      smcActionState: 'HIGH RISK',
      evaluatedAt: nowIso,
      waitReasons: ['極端資金費率擁擠風險 (Funding Safety 攔截)'],
    })
  );
  db.saveSmcScanResult(
    makeSmcResultRecord('BNBUSDT', cycleId, {
      smcActionState: 'HIGH RISK',
      evaluatedAt: nowIso,
      waitReasons: ['低流動性且高波動 (TIER_3)'],
    })
  );

  const regimes = monitor.getPaperQualityMarketRegimes(
    '30d',
    'binance_usdm',
    nowMs,
    nowIso
  );

  assert.equal(regimes.dimensionList.length, 7);
  assert.equal(regimes.comparisonAllowed, false);
  for (const dim of regimes.dimensionList) {
    const sumEvaluated = dim.buckets.reduce(
      (acc, b) => acc + b.evaluatedCount,
      0
    );
    assert.equal(
      sumEvaluated,
      regimes.evaluatedCount,
      `Dimension ${dim.dimension} bucket evaluatedCount sum (${sumEvaluated}) must equal total evaluatedCount (${regimes.evaluatedCount})`
    );
    const sumSignals = dim.buckets.reduce((acc, b) => acc + b.signalCount, 0);
    assert.equal(
      sumSignals,
      0,
      `Dimension ${dim.dimension} bucket signalCount sum must equal in-window signals`
    );
    assert.equal(dim.comparisonAllowed, false);
    for (const b of dim.buckets) {
      assert.equal(b.comparisonAllowed, false);
      assert.equal(b.sampleSufficiency, 'INSUFFICIENT');
      assert.equal(b.sampleSufficiencyNotice, '樣本不足，僅供觀察');
    }
  }
});

test('Phase 12 (11 & 12): 服務重啟後 Paper 訊號與監控週期不消失，且同根 K 線同時觸及 SL 與 TP 時保守記為 -1R (STOP_LOSS)', () => {
  const { dbPath, db } = createTempDb();
  const monitorDb = new PaperMonitorDatabase(db);
  const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

  const sigBarOpenMs = Date.parse('2026-10-29T12:00:00.000Z');
  const nextBarOpenMs = Date.parse('2026-10-29T12:15:00.000Z');
  const timelyDetectedIso = '2026-10-29T12:14:59.999Z';
  const baseMs = sigBarOpenMs - 35 * 15 * 60 * 1000;
  const bars36 = buildConfirmedKlines(36, baseMs, 100);

  // Entry bar opens at 105.0, followed by a volatile bar that touches BOTH stopLoss and takeProfit
  const entryBar: Kline = {
    openTime: nextBarOpenMs,
    closeTime: nextBarOpenMs + 15 * 60 * 1000 - 1,
    open: 105.0,
    high: 125.0, // touches TP
    low: 85.0, // touches SL on same bar
    close: 110.0,
    volume: 100000,
    quoteVolume: 100000 * 110.0,
    isClosed: true,
  };

  monitorDb.recordMonitoringWindowCycle({
    monitoringWindowId: 'pwin_persist_test',
    scanCycleId: 'smc_cycle_cold_persist_1',
    scanRunId: 'scan_persist_test',
    snapshotAt: timelyDetectedIso,
    statsVersion: 1,
    totalContracts: 522,
    evaluatedCount: 522,
    pendingCount: 0,
    waitCount: 510,
    watchCount: 10,
    highRiskCount: 1,
    longCandidateCount: 1,
    shortCandidateCount: 0,
    failedCount: 0,
    rateLimitedCount: 0,
    staleCount: 0,
    fallbackCount: 0,
    missingDataCount: 0,
    finalCategorySmcMismatchCount: 0,
    ruleVersionValidCount: 522,
    evaluatedAtValidCount: 522,
    sourceValidCount: 522,
    cycleValid: true,
    dataQualityWarning: null,
    recordedAt: timelyDetectedIso,
  });

  const tracked = tracker.evaluateAndTrackSignal({
    monitorRunId: 'pmon_persist_test',
    scanRunId: 'scan_persist_test',
    scanCycleId: 'smc_cycle_cold_persist_1',
    symbol: 'DOGEUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    marketRadarCategory: '雷達多頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'LONG CANDIDATE',
    finalTradeSignal: '多頭交易候選',
    ruleVersion: SMC_RULE_VERSION,
    snapshotAt: timelyDetectedIso,
    evaluatedAt: timelyDetectedIso,
    signalDetectedAt: timelyDetectedIso,
    klines: [...bars36, entryBar],
    signalBarIndex: 35,
    atr14: 1.0,
    openInterest: 25_000_000,
    fundingRate: 0.0001,
    waitReasons: [],
    evidences: ['15m Bullish Sweep & BOS'],
    provenance: {
      source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: timelyDetectedIso,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
    isBacktest: false,
  });

  // Test 12: Same bar touching both SL and TP conservatively records -1R (PAPER_CLOSED_LOSS, closeReason = STOP_LOSS)
  assert.ok(tracked.signal);
  assert.equal(tracked.signal.status, 'PAPER_CLOSED_LOSS');
  assert.equal(tracked.signal.closeReason, 'STOP_LOSS');
  assert.equal(tracked.signal.riskMultiple, -1);
  assert.equal(tracked.signal.resultR, -1);
  assert.ok(tracked.signal.paperOpenedAt);
  assert.ok(tracked.signal.paperClosedAt);

  // Test 11: Simulate service restart by opening a new RadarDatabase + PaperMonitorDatabase on the same SQLite path
  const restartedRadarDb = new RadarDatabase(dbPath);
  const restartedMonitorDb = new PaperMonitorDatabase(restartedRadarDb);
  const persistedSignals = restartedMonitorDb.listTrackedSignals({
    exchange: 'binance_usdm',
  });
  const persistedCycles = restartedMonitorDb.listMonitoringWindowCycles(
    'pwin_persist_test'
  );

  assert.equal(persistedSignals.length, 1);
  assert.equal(persistedSignals[0].symbol, 'DOGEUSDT');
  assert.equal(persistedSignals[0].status, 'PAPER_CLOSED_LOSS');
  assert.equal(persistedSignals[0].closeReason, 'STOP_LOSS');
  assert.equal(persistedSignals[0].resultR, -1);
  assert.equal(persistedCycles.length, 1);
  assert.equal(persistedCycles[0].scanCycleId, 'smc_cycle_cold_persist_1');
});

test('Phase 12 (13 & 14 + 全新 8 個 API 整合驗證): /api/paper-quality/* 端點回應完整、Demo 遭拒、外部 Telegram/TradingView 請求數維持 0、所有下單 API 維持 404', async () => {
  await fetch(`${TEST_BASE_URL}/api/smc-scan/pause?exchange=binance_usdm`, {
    method: 'POST',
  });
  await new Promise((r) => setTimeout(r, 150));

  const [
    statusRes,
    rep30dRes,
    rep60dRes,
    rep90dRes,
    driftRes,
    regimesRes,
    signalsRes,
    exportRes,
  ] = await Promise.all([
    fetch(`${TEST_BASE_URL}/api/paper-quality/status?exchange=binance_usdm`),
    fetch(
      `${TEST_BASE_URL}/api/paper-quality/report?window=30d&exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/paper-quality/report?window=60d&exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/paper-quality/report?window=90d&exchange=binance_usdm`
    ),
    fetch(`${TEST_BASE_URL}/api/paper-quality/gate-drift?exchange=binance_usdm`),
    fetch(
      `${TEST_BASE_URL}/api/paper-quality/market-regimes?window=30d&exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/paper-quality/signals?window=30d&exchange=binance_usdm`
    ),
    fetch(`${TEST_BASE_URL}/api/paper-quality/export?exchange=binance_usdm`),
  ]);

  assert.equal(statusRes.status, 200);
  assert.equal(rep30dRes.status, 200);
  assert.equal(rep60dRes.status, 200);
  assert.equal(rep90dRes.status, 200);
  assert.equal(driftRes.status, 200);
  assert.equal(regimesRes.status, 200);
  assert.equal(signalsRes.status, 200);
  assert.equal(exportRes.status, 200);

  const status = await statusRes.json();
  const rep30d = await rep30dRes.json();
  const rep60d = await rep60dRes.json();
  const rep90d = await rep90dRes.json();
  const drift = await driftRes.json();
  const regimes = await regimesRes.json();
  const signals = await signalsRes.json();
  const exp = await exportRes.json();

  // Verify shared cycleId and statsVersion across all endpoints
  assert.equal(rep30d.cycleId, status.cycleId);
  assert.equal(rep60d.cycleId, status.cycleId);
  assert.equal(rep90d.cycleId, status.cycleId);
  assert.equal(drift.cycleId, status.cycleId);
  assert.equal(regimes.cycleId, status.cycleId);
  assert.equal(signals.cycleId, status.cycleId);
  assert.equal(exp.cycleId, status.cycleId);

  assert.equal(rep30d.statsVersion, status.statsVersion);
  assert.equal(rep60d.statsVersion, status.statsVersion);
  assert.equal(rep90d.statsVersion, status.statsVersion);

  // Verify 30d/60d/90d windows in status and export
  assert.ok(status.windows['30d']);
  assert.ok(status.windows['60d']);
  assert.ok(status.windows['90d']);
  assert.ok(exp.reports['30d']);
  assert.ok(exp.reports['60d']);
  assert.ok(exp.reports['90d']);

  // Verify strategyValidityNotice and sampleSufficiencyNotice when paperClosed === 0
  if (rep30d.paperClosed === 0) {
    assert.equal(rep30d.winRate, null);
    assert.equal(rep30d.averageR, null);
    assert.equal(rep30d.profitFactor, null);
    assert.equal(rep30d.maxDrawdownR, null);
    assert.equal(rep30d.expectancyR, null);
    assert.equal(rep30d.averageHoldingTime, null);
    assert.equal(rep30d.sampleSufficiency, 'INSUFFICIENT');
    assert.equal(rep30d.sampleSufficiencyNotice, '樣本不足，僅供觀察');
    assert.equal(
      rep30d.strategyValidityNotice,
      '目前樣本不足，不代表策略有效或無效'
    );
  }

  // Verify Gate drift safety flags
  assert.equal(drift.thresholdAutoAdjusted, false);
  assert.equal(drift.gatesRelaxed, false);

  // Verify Demo mode is rejected on /api/paper-quality/* endpoints
  const demoStatusRes = await fetch(
    `${TEST_BASE_URL}/api/paper-quality/status?mode=demo`
  );
  assert.equal(demoStatusRes.status, 400);
  const demoReportRes = await fetch(
    `${TEST_BASE_URL}/api/paper-quality/report?window=30d&exchange=demo_synthetic`
  );
  assert.equal(demoReportRes.status, 400);

  // Test 13: External Telegram / TradingView requests remain 0
  for (const payload of [
    status,
    rep30d,
    rep60d,
    rep90d,
    drift,
    regimes,
    signals,
    exp,
  ]) {
    assert.equal(payload.externalTelegramRequestsCount, 0);
    assert.equal(payload.externalTradingViewRequestsCount, 0);
    assert.equal(payload.mode, 'PAPER ONLY');
    assert.equal(payload.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(payload.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
  }

  // Test 14: All order placement endpoints remain HTTP 404
  const orderPaths = [
    '/api/order',
    '/api/orders',
    '/api/trade',
    '/api/trades',
    '/api/execute',
    '/api/binance/order',
    '/api/bybit/order',
    '/api/bingx/order',
  ];
  for (const p of orderPaths) {
    const res = await fetch(`${TEST_BASE_URL}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 }),
    });
    assert.equal(res.status, 404, `Order endpoint ${p} must return 404`);
  }
});
