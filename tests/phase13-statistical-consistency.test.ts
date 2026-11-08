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
    path.join(os.tmpdir(), 'radar-phase13-consistency-')
  );
  const dbPath = path.join(tmpDir, 'test-phase13.sqlite');
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
    windowKey: 'win_test_phase13',
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

test('Phase 13 (1 & 2): fastLaneCount + bulkCount + missingLatencySampleCount = latencyEvaluatedCount 且 latencyExcludedReasons 正確列出缺漏原因（不得讓 393 看起來像完整 394）', () => {
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

  const cycleId = 'smc_cycle_cold_p13_394';
  const anchorIso = '2026-10-30T10:00:00.000Z';

  // Seed 29 Fast Lane symbols with detectionLatencyMs
  for (let i = 1; i <= 29; i++) {
    db.saveSmcScanResult(
      makeSmcResultRecord(`FAST${i}USDT`, cycleId, {
        isFastLane: true,
        priorityClass: 'FAST_LANE',
        priorityTier: 1,
        detectionLatencyMs: 320 + i,
        evaluatedAt: anchorIso,
      })
    );
  }

  // Seed 364 Bulk symbols with detectionLatencyMs
  for (let i = 1; i <= 364; i++) {
    db.saveSmcScanResult(
      makeSmcResultRecord(`BULK${i}USDT`, cycleId, {
        isFastLane: false,
        priorityClass: 'BULK',
        priorityTier: 6,
        detectionLatencyMs: 4500 + i,
        evaluatedAt: anchorIso,
      })
    );
  }

  // Seed 1 inline-evaluated symbol WITHOUT detectionLatencyMs (29 + 364 + 1 = 394)
  db.saveSmcScanResult(
    makeSmcResultRecord('INLINE1USDT', cycleId, {
      isFastLane: false,
      priorityClass: 'BULK',
      detectionLatencyMs: undefined,
      evaluatedAt: anchorIso,
    })
  );

  const status = monitor.getPaperQualityStatus(
    'binance_usdm',
    Date.parse(anchorIso),
    anchorIso
  );

  assert.equal(status.fastLaneCount, 29);
  assert.equal(status.bulkCount, 364);
  assert.equal(status.latencySampleCount, 393);
  assert.equal(status.missingLatencySampleCount, 1);
  assert.equal(status.latencyEvaluatedCount, 394);
  assert.equal(
    status.fastLaneCount + status.bulkCount + status.missingLatencySampleCount,
    status.latencyEvaluatedCount
  );
  assert.equal(
    status.latencySampleCount + status.missingLatencySampleCount,
    status.latencyEvaluatedCount
  );
  assert.equal(status.latencyCoverageRate, Number(((393 / 394) * 100).toFixed(2)));
  assert.equal(
    status.latencyExcludedReasons.INLINE_SYMBOL_EVAL_NO_QUEUE_LATENCY,
    1
  );
  assert.equal(status.latencyExcludedSymbols.length, 1);
  assert.equal(status.latencyExcludedSymbols[0].symbol, 'INLINE1USDT');
  assert.equal(
    status.latencyExcludedSymbols[0].reason,
    'INLINE_SYMBOL_EVAL_NO_QUEUE_LATENCY'
  );
  assert.equal(status.identityChecks.latencyCoverageIdentity.valid, true);
  assert.equal(status.statsConsistency, 'VALID');
});

test('Phase 13 (3 & 4): regimeEvaluatedCount + regimeExcludedCount = regimeTotalSymbols 且 regimeExcludedReasons 正確列出 522 檔中剩餘 128 檔未納入原因', () => {
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

  const cycleId = 'smc_cycle_cold_p13_522';
  const anchorIso = '2026-10-30T10:00:00.000Z';

  // Seed 394 evaluated symbols (saveSmcScanResult automatically registers SUCCEEDED jobs)
  for (let i = 1; i <= 394; i++) {
    const sym = `EVAL${i}USDT`;
    db.saveSmcScanResult(
      makeSmcResultRecord(sym, cycleId, {
        isFastLane: i <= 29,
        priorityClass: i <= 29 ? 'FAST_LANE' : 'BULK',
        detectionLatencyMs: i === 394 ? undefined : 500 + i,
        evaluatedAt: anchorIso,
      })
    );
  }

  // Enqueue 128 pending jobs (total 522 symbols)
  const pendingJobs = [];
  for (let i = 395; i <= 522; i++) {
    const sym = `PEND${i}USDT`;
    pendingJobs.push({
      symbol: sym,
      exchange: 'binance_usdm' as const,
      priority: i,
      priorityTier: 6 as const,
      priorityLabel: 'T6_FULL_MARKET_BULK',
      priorityClass: 'BULK' as const,
      status: 'QUEUED' as const,
      ruleVersion: SMC_RULE_VERSION,
      windowKey: 'win_test_phase13',
      requestedAt: anchorIso,
      startedAt: null,
      completedAt: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
    });
  }
  db.enqueueSmcScanJobs(pendingJobs, false, false);

  const regimes = monitor.getPaperQualityMarketRegimes(
    '30d',
    'binance_usdm',
    Date.parse(anchorIso),
    anchorIso
  );

  assert.equal(regimes.regimeScope, 'PARTIAL_DATASET');
  assert.equal(regimes.regimeTotalSymbols, 522);
  assert.equal(regimes.regimeEvaluatedCount, 394);
  assert.equal(regimes.regimePendingCount, 128);
  assert.equal(regimes.regimeFailedCount, 0);
  assert.equal(regimes.regimeExcludedCount, 128);
  assert.equal(
    regimes.regimeEvaluatedCount + regimes.regimeExcludedCount,
    regimes.regimeTotalSymbols
  );
  assert.equal(regimes.regimeExcludedReasons.PENDING, 128);
  assert.equal(regimes.regimeExcludedReasons['缺少 K 線'], 0);
  assert.equal(regimes.regimeExcludedReasons['缺少 OI/Funding'], 0);
  assert.equal(regimes.regimeExcludedReasons['stale/fallback'], 0);
  assert.equal(regimes.regimeExcludedReasons['週期未完成'], 0);
  assert.equal(regimes.regimeExcludedReasons['重複標的去重'], 0);
  assert.equal(regimes.regimeExcludedReasons['其他明確原因'], 0);
  const sumExcludedReasons = Object.values(
    regimes.regimeExcludedReasons
  ).reduce((a, b) => a + b, 0);
  assert.equal(sumExcludedReasons, regimes.regimeExcludedCount);
  assert.equal(regimes.identityChecks.regimeCoverageIdentity.valid, true);
});

test('Phase 13 (5 & 6): 30d/60d/90d 同一份報表共用相同 reportAnchorAt、windowEndAt、snapshotAt 與 statsVersion；分開查詢時明確標示各別 reportGeneratedAt 與 isAtomicSnapshot=false，且不會因數秒差異造成窗口邊界漂移', () => {
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

  const cycleId = 'smc_cycle_cold_p13_anchor';
  const t0Ms = Date.parse('2026-10-30T12:00:00.000Z');
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', cycleId, {
      detectionLatencyMs: 250,
      evaluatedAt: new Date(t0Ms).toISOString(),
    })
  );

  // Unified status report (atomic snapshot)
  const unifiedStatus = monitor.getPaperQualityStatus('binance_usdm', t0Ms);
  assert.equal(unifiedStatus.isAtomicSnapshot, true);
  assert.equal(unifiedStatus.queryMode, 'ATOMIC_UNIFIED_SNAPSHOT');
  assert.equal(
    unifiedStatus.windows['30d'].reportAnchorAt,
    unifiedStatus.reportAnchorAt
  );
  assert.equal(
    unifiedStatus.windows['60d'].reportAnchorAt,
    unifiedStatus.reportAnchorAt
  );
  assert.equal(
    unifiedStatus.windows['90d'].reportAnchorAt,
    unifiedStatus.reportAnchorAt
  );
  assert.equal(
    unifiedStatus.windows['30d'].windowEndAt,
    unifiedStatus.windowEndAt
  );
  assert.equal(
    unifiedStatus.windows['60d'].windowEndAt,
    unifiedStatus.windowEndAt
  );
  assert.equal(
    unifiedStatus.windows['90d'].windowEndAt,
    unifiedStatus.windowEndAt
  );

  // Separate window queries a few seconds apart (+1.5s, +3.2s, +4.8s)
  const sep30d = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    t0Ms + 1500
  );
  const sep60d = monitor.getPaperQualityReport(
    '60d',
    'binance_usdm',
    t0Ms + 3200
  );
  const sep90d = monitor.getPaperQualityReport(
    '90d',
    'binance_usdm',
    t0Ms + 4800
  );

  assert.equal(sep30d.isAtomicSnapshot, false);
  assert.equal(sep60d.isAtomicSnapshot, false);
  assert.equal(sep90d.isAtomicSnapshot, false);
  assert.equal(sep30d.queryMode, 'SEPARATE_WINDOW_QUERY');
  assert.equal(sep60d.queryMode, 'SEPARATE_WINDOW_QUERY');
  assert.equal(sep90d.queryMode, 'SEPARATE_WINDOW_QUERY');

  // Distinct reportGeneratedAt per separate query
  assert.notEqual(sep30d.reportGeneratedAt, sep60d.reportGeneratedAt);
  assert.notEqual(sep60d.reportGeneratedAt, sep90d.reportGeneratedAt);

  // Locked reportAnchorAt & windowEndAt across same statsVersion (zero few-second boundary drift)
  assert.equal(sep30d.reportAnchorAt, sep60d.reportAnchorAt);
  assert.equal(sep60d.reportAnchorAt, sep90d.reportAnchorAt);
  assert.equal(sep30d.windowEndAt, sep60d.windowEndAt);
  assert.equal(sep60d.windowEndAt, sep90d.windowEndAt);
  assert.equal(sep30d.snapshotAt, sep60d.snapshotAt);
  assert.equal(sep30d.statsVersion, sep60d.statsVersion);
});

test('Phase 13 (7, 8 & 9): windowStartAt <= eventTime < windowEndAt 嚴格過濾、sampleCount < 30 標記 INSUFFICIENT（延遲與績效分開計算）、paperClosed = 0 時所有績效欄位為 null', () => {
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

  const anchorIso = '2026-10-30T12:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', 'smc_cycle_cold_p13_filter', {
      detectionLatencyMs: 310,
      evaluatedAt: anchorIso,
    })
  );

  const seedSignal = (symbol: string, detectedIso: string) => {
    const detMs = Date.parse(detectedIso);
    const sigBarOpenMs = detMs - 15 * 60 * 1000;
    const baseMs = sigBarOpenMs - 35 * 15 * 60 * 1000;
    const bars36 = buildConfirmedKlines(36, baseMs, 100);
    return tracker.evaluateAndTrackSignal({
      monitorRunId: 'pmon_p13_filter',
      scanRunId: 'scan_p13_filter',
      scanCycleId: `smc_cycle_cold_${symbol}`,
      symbol,
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達空頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'SHORT CANDIDATE',
      finalTradeSignal: '空頭交易候選',
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
      evidences: ['15m 結構跌破 (BOS)', 'FVG 回踩'],
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

  // 1 in-window signal (5 days ago) and 1 out-of-window signal (2025)
  seedSignal('SOLUSDT', '2026-10-25T08:00:00.000Z');
  seedSignal('ATOMUSDT', '2025-10-29T03:14:46.639Z');

  const rep30d = monitor.getPaperQualityReport(
    '30d',
    'binance_usdm',
    anchorMs,
    anchorIso
  );

  // Strict half-open filtering: 2025 ATOMUSDT excluded from 30d
  assert.equal(rep30d.totalSignals, 1);
  assert.equal(rep30d.shortSignals, 1);
  assert.equal(rep30d.entryWindowMissed, 1);
  assert.equal(rep30d.historicalSignalsOutsideWindowCount, 1);
  assert.equal(rep30d.metricStatus, 'ENTRY_WINDOW_MISSED');

  // Separate latency vs performance sample sufficiency (< 30 -> INSUFFICIENT)
  assert.equal(rep30d.latencySampleCount, 1);
  assert.equal(rep30d.latencySampleSufficiency, 'INSUFFICIENT');
  assert.equal(rep30d.performanceSampleCount, 0);
  assert.equal(rep30d.performanceSampleSufficiency, 'INSUFFICIENT');
  assert.equal(
    PaperShadowMonitor.computeSampleSufficiency(29),
    'INSUFFICIENT'
  );
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(30), 'LIMITED');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(99), 'LIMITED');
  assert.equal(PaperShadowMonitor.computeSampleSufficiency(100), 'SUFFICIENT');

  // paperClosed = 0 -> all performance fields strictly null
  assert.equal(rep30d.paperClosed, 0);
  assert.equal(rep30d.winRate, null);
  assert.equal(rep30d.averageR, null);
  assert.equal(rep30d.profitFactor, null);
  assert.equal(rep30d.maxDrawdownR, null);
  assert.equal(rep30d.expectancyR, null);
  assert.equal(rep30d.averageHoldingTime, null);
});

test('Phase 13 (10): 四個統計恆等式任一不成立時，強制標記 statsConsistency = INVALID，且不得把該週期顯示為正常 COMPLETED', () => {
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

  const cycleId = 'smc_cycle_cold_p13_identities';
  const anchorIso = '2026-10-30T12:00:00.000Z';
  const anchorMs = Date.parse(anchorIso);

  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', cycleId, {
      isFastLane: true,
      detectionLatencyMs: 210,
      evaluatedAt: anchorIso,
    })
  );

  // Baseline: all 4 identities hold
  const baseline = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(baseline.statsConsistency, 'VALID');
  assert.equal(baseline.identityChecks.allValid, true);
  assert.equal(baseline.fullUniverseStatus, 'COMPLETED');

  // Break Identity 1: totalSymbols mismatch
  monitor.setStatisticalIdentityTestOverride({ totalSymbols: 999 });
  const broken1 = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(broken1.identityChecks.totalSymbolsIdentity.valid, false);
  assert.equal(broken1.statsConsistency, 'INVALID');
  assert.notEqual(broken1.fullUniverseStatus, 'COMPLETED');

  // Break Identity 2: actionState sum != evaluatedCount
  monitor.setStatisticalIdentityTestOverride({ evaluatedCount: 999 });
  const broken2 = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(broken2.identityChecks.actionStateIdentity.valid, false);
  assert.equal(broken2.statsConsistency, 'INVALID');
  assert.notEqual(broken2.fullUniverseStatus, 'COMPLETED');

  // Break Identity 3: fastLaneCount + bulkCount + missingLatencySampleCount != latencyEvaluatedCount
  monitor.setStatisticalIdentityTestOverride({ latencyEvaluatedCount: 999 });
  const broken3 = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(broken3.identityChecks.latencyCoverageIdentity.valid, false);
  assert.equal(broken3.statsConsistency, 'INVALID');
  assert.notEqual(broken3.fullUniverseStatus, 'COMPLETED');

  // Break Identity 4: regimeEvaluatedCount + regimeExcludedCount != regimeTotalSymbols
  monitor.setStatisticalIdentityTestOverride({ regimeTotalSymbols: 999 });
  const broken4 = monitor.getPaperQualityStatus(
    'binance_usdm',
    anchorMs,
    anchorIso
  );
  assert.equal(broken4.identityChecks.regimeCoverageIdentity.valid, false);
  assert.equal(broken4.statsConsistency, 'INVALID');
  assert.notEqual(broken4.fullUniverseStatus, 'COMPLETED');

  // Restore clean state
  monitor.setStatisticalIdentityTestOverride(null);
});

test('Phase 13 (11): Live API /api/paper-quality/* 四大統計恆等式驗證、下單 API 一律回傳 404、外部 Telegram/TradingView 請求數為 0', async () => {
  const [statusRes, rep30Res, rep60Res, rep90Res, regimesRes] =
    await Promise.all([
      fetch(`${TEST_BASE_URL}/api/paper-quality/status`),
      fetch(`${TEST_BASE_URL}/api/paper-quality/report?window=30d`),
      fetch(`${TEST_BASE_URL}/api/paper-quality/report?window=60d`),
      fetch(`${TEST_BASE_URL}/api/paper-quality/report?window=90d`),
      fetch(`${TEST_BASE_URL}/api/paper-quality/market-regimes`),
    ]);

  assert.equal(statusRes.status, 200);
  assert.equal(rep30Res.status, 200);
  assert.equal(rep60Res.status, 200);
  assert.equal(rep90Res.status, 200);
  assert.equal(regimesRes.status, 200);

  const statusJson = await statusRes.json();
  const rep30Json = await rep30Res.json();
  const rep60Json = await rep60Res.json();
  const rep90Json = await rep90Res.json();
  const regimesJson = await regimesRes.json();

  // Safety guardrails
  for (const payload of [
    statusJson,
    rep30Json,
    rep60Json,
    rep90Json,
    regimesJson,
  ]) {
    assert.equal(payload.mode, 'PAPER ONLY');
    assert.equal(payload.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(payload.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
    assert.equal(payload.externalTelegramRequestsCount, 0);
    assert.equal(payload.externalTradingViewRequestsCount, 0);
    assert.equal(payload.statsConsistency, 'VALID');
    assert.equal(payload.identityChecks.allValid, true);
    assert.equal(
      payload.fastLaneCount +
        payload.bulkCount +
        payload.missingLatencySampleCount,
      payload.latencyEvaluatedCount
    );
    assert.equal(
      payload.latencySampleCount + payload.missingLatencySampleCount,
      payload.latencyEvaluatedCount
    );
    assert.equal(
      payload.regimeEvaluatedCount + payload.regimeExcludedCount,
      payload.regimeTotalSymbols
    );
  }

  // Unified status report shares identical reportAnchorAt & windowEndAt across 30d/60d/90d
  assert.equal(statusJson.isAtomicSnapshot, true);
  assert.equal(
    statusJson.windows['30d'].reportAnchorAt,
    statusJson.reportAnchorAt
  );
  assert.equal(
    statusJson.windows['60d'].reportAnchorAt,
    statusJson.reportAnchorAt
  );
  assert.equal(
    statusJson.windows['90d'].reportAnchorAt,
    statusJson.reportAnchorAt
  );

  // Separate window queries mark isAtomicSnapshot=false and share locked reportAnchorAt on same statsVersion
  assert.equal(rep30Json.isAtomicSnapshot, false);
  assert.equal(rep60Json.isAtomicSnapshot, false);
  assert.equal(rep90Json.isAtomicSnapshot, false);
  if (
    rep30Json.statsVersion === rep60Json.statsVersion &&
    rep60Json.statsVersion === rep90Json.statsVersion
  ) {
    assert.equal(rep30Json.reportAnchorAt, rep60Json.reportAnchorAt);
    assert.equal(rep60Json.reportAnchorAt, rep90Json.reportAnchorAt);
  }

  // All order endpoints return 404
  const orderPaths = [
    '/api/order',
    '/api/orders',
    '/api/trade',
    '/api/execute-order',
    '/api/binance/order',
  ];
  for (const p of orderPaths) {
    const res = await fetch(`${TEST_BASE_URL}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 }),
    });
    assert.equal(res.status, 404);
  }
});
