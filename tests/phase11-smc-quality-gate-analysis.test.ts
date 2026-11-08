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
    path.join(os.tmpdir(), 'radar-phase11-smc-quality-')
  );
  const dbPath = path.join(tmpDir, 'test-phase11.sqlite');
  const db = new RadarDatabase(dbPath);
  return { tmpDir, db };
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
  basePrice = 1.62
): Kline[] {
  const stepMs = 15 * 60 * 1000;
  const bars: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = startOpenTimeMs + i * stepMs;
    const closeTime = openTime + stepMs - 1;
    const open = basePrice + i * 0.002;
    const close = open - 0.001;
    bars.push({
      openTime,
      closeTime,
      open,
      high: open + 0.005,
      low: close - 0.005,
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
    windowKey: 'win_test_phase11',
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

test('Phase 11 (1 & 2): Gate 逐項通過/失敗統計正確，且每個標的均保存 primaryBlockingReason 與 allBlockingReasons', () => {
  const { db } = createTempDb();
  const cycleId = 'smc_cycle_cold_phase11_test1';

  // 1. BTCUSDT: STRUCTURE_INCOMPLETE (missing Liquidity Sweep)
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', cycleId, {
      smcActionState: 'WAIT',
      waitReasons: ['未偵測到明確的流動性掃蕩 (Liquidity Sweep)'],
    })
  );

  // 2. ETHUSDT: MTF_CONFLICT (WATCH)
  db.saveSmcScanResult(
    makeSmcResultRecord('ETHUSDT', cycleId, {
      smcActionState: 'WATCH',
      waitReasons: ['跨週期趨勢衝突 (4H 與 1H/15m 結構未同向對齊)'],
    })
  );

  // 3. SOLUSDT: DATA_BLOCKED (OI missing)
  db.saveSmcScanResult(
    makeSmcResultRecord('SOLUSDT', cycleId, {
      smcActionState: 'WAIT',
      missingData: ['openInterest'],
      waitReasons: ['缺少真實未平倉量 (Open Interest) 數據'],
    })
  );

  // 4. BNBUSDT: LIQUIDITY_BLOCKED (HIGH RISK)
  db.saveSmcScanResult(
    makeSmcResultRecord('BNBUSDT', cycleId, {
      smcActionState: 'HIGH RISK',
      waitReasons: ['流動性不足或盤口點差過大 (TIER_3 / Spread 超標)'],
    })
  );

  // 5. XRPUSDT: RISK_BLOCKED (Funding extreme)
  db.saveSmcScanResult(
    makeSmcResultRecord('XRPUSDT', cycleId, {
      smcActionState: 'HIGH RISK',
      waitReasons: ['極端資金費率擁擠風險 (Funding Safety 攔截)'],
    })
  );

  const bundle = db.computeSmcQualityBundle('binance_usdm');
  assert.equal(bundle.snap.evaluatedCount, 5);
  assert.equal(bundle.symbolDiagnostics.length, 5);

  for (const diag of bundle.symbolDiagnostics) {
    assert.ok(
      typeof diag.primaryBlockingReason === 'string' &&
        diag.primaryBlockingReason.length > 0,
      `Symbol ${diag.symbol} must persist primaryBlockingReason`
    );
    assert.ok(
      Array.isArray(diag.allReasons) && diag.allReasons.length > 0,
      `Symbol ${diag.symbol} must persist allReasons`
    );
    assert.ok(
      diag.gatePassMap && typeof diag.gatePassMap === 'object',
      `Symbol ${diag.symbol} must persist gatePassMap`
    );
  }

  assert.equal(bundle.gates.length, 14);
  for (const g of bundle.gates) {
    assert.equal(
      g.passCount + g.failCount,
      bundle.snap.evaluatedCount,
      `Gate ${g.gate} passCount + failCount must equal totalEvaluated`
    );
  }
});

test('Phase 11 (3, 4, 5 & 6): 嚴格區分 WAIT/WATCH/HIGH RISK/PENDING 以及 DATA_BLOCKED、STRUCTURE_INCOMPLETE、MTF_CONFLICT、LIQUIDITY_BLOCKED、RISK_BLOCKED、ENTRY_WINDOW_MISSED，且不回填過期開盤價', () => {
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '尚未完成評估 (佇列排隊中)',
      'WAIT',
      'PENDING'
    ),
    'PENDING'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '缺少真實未平倉量 (Open Interest) 數據',
      'WAIT',
      'EVALUATED'
    ),
    'DATA_BLOCKED'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '歷史成交量基準未就緒 (Baseline Warmup)',
      'WAIT',
      'EVALUATED'
    ),
    'DATA_BLOCKED'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '未偵測到明確的流動性掃蕩 (Liquidity Sweep)',
      'WAIT',
      'EVALUATED'
    ),
    'STRUCTURE_INCOMPLETE'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '跨週期趨勢衝突 (4H 與 1H/15m 結構未同向對齊)',
      'WATCH',
      'EVALUATED'
    ),
    'MTF_CONFLICT'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '流動性不足或盤口點差過大 (TIER_3)',
      'HIGH RISK',
      'EVALUATED'
    ),
    'LIQUIDITY_BLOCKED'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '極端資金費率擁擠風險 (Funding Safety 攔截)',
      'HIGH RISK',
      'EVALUATED'
    ),
    'RISK_BLOCKED'
  );
  assert.equal(
    RadarDatabase.classifySmcBlockingReason(
      '偵測延遲導致價格已偏離進場區間 (ENTRY_WINDOW_MISSED)',
      'WAIT',
      'EVALUATED',
      'ENTRY_WINDOW_MISSED'
    ),
    'ENTRY_WINDOW_MISSED'
  );

  // Verify ENTRY_WINDOW_MISSED in bundle stats
  const { db } = createTempDb();
  const cycleId = 'smc_cycle_cold_entry_missed';
  db.saveSmcScanResult(
    makeSmcResultRecord('SOLUSDT', cycleId, {
      smcActionState: 'WAIT',
      finalTradeSignal: 'NONE',
      entryWindowStatus: 'ENTRY_WINDOW_MISSED',
      waitReasons: ['偵測延遲導致價格已偏離進場區間 (ENTRY_WINDOW_MISSED)'],
    })
  );

  const bundle = db.computeSmcQualityBundle('binance_usdm');
  assert.equal(bundle.primaryCategoryCounts.ENTRY_WINDOW_MISSED, 1);
});

test('Phase 11 (7, 8, 9, 10, 11 & 12): 當 paperClosed = 0 時回傳 metricStatus = NO_TRADES 與 null 指標、7d/30d 數學恆等式成立、多 API snapshotAt/statsVersion/cycleId 一致、Demo 遭拒、下單端點 404、外部通知請求數為 0', async () => {
  const scanRes = await fetch(
    `${TEST_BASE_URL}/api/scan?exchange=binance_usdm&mode=live`
  );
  assert.equal(scanRes.status, 200);
  await fetch(`${TEST_BASE_URL}/api/smc-scan/pause?exchange=binance_usdm`, {
    method: 'POST',
  });
  await new Promise((r) => setTimeout(r, 200));

  const [
    smcStatusRes,
    paperStatusRes,
    paperReportRes,
    phase7Res,
    gateStatsRes,
    reasonStatsRes,
    cycleHistRes,
    latencyRes,
    report7dRes,
    report30dRes,
  ] = await Promise.all([
    fetch(`${TEST_BASE_URL}/api/smc-scan/status?exchange=binance_usdm`),
    fetch(`${TEST_BASE_URL}/api/paper-monitor/status?exchange=binance_usdm`),
    fetch(
      `${TEST_BASE_URL}/api/paper-monitor/report?window=24h&exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/validation/phase7-report?exchange=binance_usdm`
    ),
    fetch(`${TEST_BASE_URL}/api/smc-quality/gate-stats?exchange=binance_usdm`),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/reason-stats?exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/cycle-history?exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/signal-latency?exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/report?window=7d&exchange=binance_usdm`
    ),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/report?window=30d&exchange=binance_usdm`
    ),
  ]);

  assert.equal(smcStatusRes.status, 200);
  assert.equal(paperStatusRes.status, 200);
  assert.equal(paperReportRes.status, 200);
  assert.equal(phase7Res.status, 200);
  assert.equal(gateStatsRes.status, 200);
  assert.equal(reasonStatsRes.status, 200);
  assert.equal(cycleHistRes.status, 200);
  assert.equal(latencyRes.status, 200);
  assert.equal(report7dRes.status, 200);
  assert.equal(report30dRes.status, 200);

  const smcStatus = await smcStatusRes.json();
  const gateStats = await gateStatsRes.json();
  const reasonStats = await reasonStatsRes.json();
  const cycleHist = await cycleHistRes.json();
  const latency = await latencyRes.json();
  const report7d = await report7dRes.json();
  const report30d = await report30dRes.json();

  // 7. When paperClosed === 0, metricStatus is NO_TRADES (or ENTRY_WINDOW_MISSED when live signals missed entry window) and performance fields are null (never 0%)
  if (report7d.paperClosed === 0) {
    assert.equal(
      report7d.metricStatus,
      report7d.entryWindowMissed > 0 ? 'ENTRY_WINDOW_MISSED' : 'NO_TRADES'
    );
    assert.equal(report7d.winRate, null);
    assert.equal(report7d.averageR, null);
    assert.equal(report7d.profitFactor, null);
    assert.equal(report7d.maxDrawdownR, null);
    assert.equal(report7d.expectancyR, null);
    assert.equal(report7d.averageHoldingTime, null);
  }
  if (report30d.paperClosed === 0) {
    assert.equal(
      report30d.metricStatus,
      report30d.entryWindowMissed > 0 ? 'ENTRY_WINDOW_MISSED' : 'NO_TRADES'
    );
    assert.equal(report30d.winRate, null);
    assert.equal(report30d.averageR, null);
    assert.equal(report30d.profitFactor, null);
    assert.equal(report30d.maxDrawdownR, null);
    assert.equal(report30d.expectancyR, null);
    assert.equal(report30d.averageHoldingTime, null);
  }

  // 8. Mathematical identities
  assert.equal(
    report7d.evaluatedCount +
      report7d.pendingCount +
      report7d.failedCount +
      report7d.rateLimitedCount,
    report7d.totalSymbols
  );
  assert.equal(
    report7d.waitCount +
      report7d.watchCount +
      report7d.highRiskCount +
      report7d.longCandidateCount +
      report7d.shortCandidateCount,
    report7d.evaluatedCount
  );

  // 9. Multi-API consistency
  assert.equal(gateStats.cycleId, smcStatus.cycleId);
  assert.equal(reasonStats.cycleId, smcStatus.cycleId);
  assert.equal(cycleHist.cycleId, smcStatus.cycleId);
  assert.equal(latency.cycleId, smcStatus.cycleId);
  assert.equal(report7d.cycleId, smcStatus.cycleId);
  assert.equal(report30d.cycleId, smcStatus.cycleId);

  assert.equal(gateStats.statsVersion, smcStatus.statsVersion);
  assert.equal(reasonStats.statsVersion, smcStatus.statsVersion);
  assert.equal(report7d.statsVersion, smcStatus.statsVersion);
  assert.equal(report30d.statsVersion, smcStatus.statsVersion);

  // 10. Demo data rejected from Live quality reports
  const demoGateRes = await fetch(
    `${TEST_BASE_URL}/api/smc-quality/gate-stats?mode=demo`
  );
  assert.equal(demoGateRes.status, 400);
  const demoReportRes = await fetch(
    `${TEST_BASE_URL}/api/smc-quality/report?window=7d&exchange=demo_synthetic`
  );
  assert.equal(demoReportRes.status, 400);

  // 11. Order placement endpoints return HTTP 404
  const orderPaths = [
    '/api/order',
    '/api/trade',
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

  // 12. External Telegram / TradingView requests remain 0
  assert.equal(report7d.externalTelegramRequestsCount, 0);
  assert.equal(report7d.externalTradingViewRequestsCount, 0);
  assert.equal(report30d.externalTelegramRequestsCount, 0);
  assert.equal(report30d.externalTradingViewRequestsCount, 0);
  assert.equal(report7d.mode, 'PAPER ONLY');
  assert.equal(report7d.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(report7d.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
  assert.equal(report7d.safety.mode, 'PAPER ONLY');
  assert.equal(report7d.safety.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(report7d.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
});

test('Phase 11 時間窗口與報表語義修正驗收 (1~5): 1 年前訊號排除於目前 7d/30d、ENTRY_WINDOW_MISSED 狀態語義、未平倉績效欄位維持 null、sampleCount=1 標記 INSUFFICIENT、reportAnchorAt 與真實時間不混用', async () => {
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

  // Seed current scan cycle (2026-10-30) with 0 candidates
  const currentCycleId = 'smc_cycle_warm_20261030_current';
  const currentSystemNowIso = '2026-10-30T00:00:00.000Z';
  const currentSystemNowMs = Date.parse(currentSystemNowIso);
  db.saveSmcScanResult(
    makeSmcResultRecord('BTCUSDT', currentCycleId, {
      smcActionState: 'WAIT',
      evaluatedAt: currentSystemNowIso,
      dataFetchedAt: currentSystemNowIso,
      fetchedAt: currentSystemNowIso,
      waitReasons: ['未偵測到明確的流動性掃蕩 (Liquidity Sweep)'],
    })
  );

  // Seed historical ATOMUSDT signal from 1 year ago: detectedAt = 2025-10-29T03:14:46.639Z
  const historicalDetectedIso = '2025-10-29T03:14:46.639Z';
  const signalBarOpenMs = Date.parse('2025-10-29T02:45:00.000Z');
  const baseTimeMs = signalBarOpenMs - 35 * 900_000;
  const bars36 = buildConfirmedKlines(36, baseTimeMs, 1.625);
  const nextBar: Kline = {
    openTime: Date.parse('2025-10-29T03:00:00.000Z'),
    closeTime: Date.parse('2025-10-29T03:14:59.999Z'),
    open: 1.622,
    high: 1.628,
    low: 1.615,
    close: 1.618,
    volume: 120000,
    quoteVolume: 120000 * 1.618,
    isClosed: true,
  };

  const trackedAtom = tracker.evaluateAndTrackSignal({
    monitorRunId: 'pmon_hist_atom',
    scanRunId: 'scan_hist_atom',
    scanCycleId: 'smc_cycle_cold_20251029_hist',
    symbol: 'ATOMUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    marketRadarCategory: '雷達空頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'SHORT CANDIDATE',
    finalTradeSignal: '空頭交易候選',
    ruleVersion: SMC_RULE_VERSION,
    snapshotAt: historicalDetectedIso,
    evaluatedAt: historicalDetectedIso,
    signalDetectedAt: historicalDetectedIso,
    klines: [...bars36, nextBar],
    signalBarIndex: 35,
    atr14: 0.0052,
    openInterest: 18500000,
    fundingRate: -0.00008,
    waitReasons: [],
    evidences: ['15m Bearish Sweep & CHoCH'],
    provenance: {
      source: 'Binance USD-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: historicalDetectedIso,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
    isBacktest: false,
  });

  assert.ok(trackedAtom.signal);
  assert.equal(trackedAtom.signal.status, 'ENTRY_WINDOW_MISSED');
  assert.equal(trackedAtom.signal.entryReferencePrice, null);

  // Test 1: 1 年前的訊號 (2025-10-29T03:14:46.639Z) 不會計入目前 (2026-10-30) 7d / 30d 報表或當輪 gate-stats / reason-stats
  const report7dCurrent = monitor.getSmcQualityWindowReport(
    '7d',
    'binance_usdm',
    currentSystemNowMs
  );
  const report30dCurrent = monitor.getSmcQualityWindowReport(
    '30d',
    'binance_usdm',
    currentSystemNowMs
  );
  const gateStatsCurrent = monitor.getSmcQualityGateStats(
    'binance_usdm',
    currentSystemNowMs
  );
  const reasonStatsCurrent = monitor.getSmcQualityReasonStats(
    'binance_usdm',
    currentSystemNowMs
  );
  const latencyCurrent = monitor.getSmcQualitySignalLatency(
    'binance_usdm',
    currentSystemNowMs
  );

  assert.equal(report7dCurrent.windowStartAt, '2026-10-23T00:00:00.000Z');
  assert.equal(report7dCurrent.windowEndAt, '2026-10-30T00:00:00.000Z');
  assert.equal(report7dCurrent.totalSignals, 0);
  assert.equal(report7dCurrent.longSignals, 0);
  assert.equal(report7dCurrent.shortSignals, 0);
  assert.equal(report7dCurrent.entryWindowMissed, 0);
  assert.equal(report7dCurrent.metricStatus, 'NO_TRADES');
  assert.equal(report7dCurrent.sampleCount, 0);
  assert.equal(report7dCurrent.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(report7dCurrent.sampleSufficiencyNotice, '樣本不足，僅供觀察');
  assert.equal(report7dCurrent.signalLatencyP50, null);
  assert.equal(report7dCurrent.signalLatencyP95, null);
  assert.equal(report7dCurrent.historicalSignalsOutsideWindowCount, 1);
  assert.equal(
    report7dCurrent.historicalSignalsOutsideWindow[0].symbol,
    'ATOMUSDT'
  );
  assert.equal(
    report7dCurrent.historicalSignalsOutsideWindow[0].signalDetectedAt,
    historicalDetectedIso
  );

  assert.equal(report30dCurrent.windowStartAt, '2026-09-30T00:00:00.000Z');
  assert.equal(report30dCurrent.windowEndAt, '2026-10-30T00:00:00.000Z');
  assert.equal(report30dCurrent.totalSignals, 0);
  assert.equal(report30dCurrent.entryWindowMissed, 0);
  assert.equal(report30dCurrent.metricStatus, 'NO_TRADES');
  assert.equal(report30dCurrent.historicalSignalsOutsideWindowCount, 1);

  // Current cycle gate-stats and reason-stats must NOT mix historical signals into current entryWindowMissedCount
  assert.equal(gateStatsCurrent.entryWindowMissedCount, 0);
  assert.equal(reasonStatsCurrent.entryWindowMissedCount, 0);
  assert.equal(
    reasonStatsCurrent.reasonCategories.ENTRY_WINDOW_MISSED.primarySymbolCount,
    0
  );
  assert.equal(latencyCurrent.sampleCount, 0);
  assert.equal(latencyCurrent.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(latencyCurrent.sampleSufficiencyNotice, '樣本不足，僅供觀察');

  // Test 2, 3, 4 & 5: 使用歷史錨點 reportAnchorAt = 2025-10-30T00:00:00.000Z 查詢時：
  // - windowStartAt <= eventTime < windowEndAt 成立
  // - totalSignals = 1, entryWindowMissed = 1, paperOpened = 0, paperClosed = 0 -> metricStatus = "ENTRY_WINDOW_MISSED" (絕非 NO_TRADES)
  // - 未平倉時所有績效欄位 (winRate, averageR, profitFactor, maxDrawdownR, expectancyR, averageHoldingTime) 嚴格維持 null
  // - sampleCount = 1 -> sampleSufficiency = "INSUFFICIENT", sampleSufficiencyNotice = "樣本不足，僅供觀察"
  // - reportAnchorAt 與真實現在時間 (currentSystemNowMs) 絕不混用
  const fixtureAnchorIso = '2025-10-30T00:00:00.000Z';
  const report7dAnchored = monitor.getSmcQualityWindowReport(
    '7d',
    'binance_usdm',
    currentSystemNowMs,
    fixtureAnchorIso
  );
  const latencyAnchored = monitor.getSmcQualitySignalLatency(
    'binance_usdm',
    currentSystemNowMs,
    {
      window: '7d',
      reportAnchorAt: fixtureAnchorIso,
    }
  );

  // Test 5: reportAnchorAt and real current time are never mixed
  assert.equal(report7dAnchored.reportGeneratedAt, currentSystemNowIso);
  assert.equal(report7dAnchored.reportAnchorAt, fixtureAnchorIso);
  assert.equal(report7dAnchored.windowStartAt, '2025-10-23T00:00:00.000Z');
  assert.equal(report7dAnchored.windowEndAt, '2025-10-30T00:00:00.000Z');
  assert.equal(report7dAnchored.signalDetectedAt, historicalDetectedIso);

  // Test 2: totalSignals > 0 & entryWindowMissed > 0 -> metricStatus = ENTRY_WINDOW_MISSED (not NO_TRADES)
  assert.equal(report7dAnchored.totalSignals, 1);
  assert.equal(report7dAnchored.shortSignals, 1);
  assert.equal(report7dAnchored.entryWindowMissed, 1);
  assert.equal(report7dAnchored.paperOpened, 0);
  assert.equal(report7dAnchored.paperClosed, 0);
  assert.equal(report7dAnchored.metricStatus, 'ENTRY_WINDOW_MISSED');
  assert.notEqual(report7dAnchored.metricStatus, 'NO_TRADES');

  // Test 3: Performance fields remain null when paperClosed = 0
  assert.equal(report7dAnchored.winRate, null);
  assert.equal(report7dAnchored.averageR, null);
  assert.equal(report7dAnchored.profitFactor, null);
  assert.equal(report7dAnchored.maxDrawdownR, null);
  assert.equal(report7dAnchored.expectancyR, null);
  assert.equal(report7dAnchored.averageHoldingTime, null);

  // Test 4: sampleCount = 1 -> sampleSufficiency = INSUFFICIENT & sampleSufficiencyNotice = "樣本不足，僅供觀察"
  assert.equal(report7dAnchored.sampleCount, 1);
  assert.equal(report7dAnchored.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(report7dAnchored.sampleSufficiencyNotice, '樣本不足，僅供觀察');
  assert.equal(
    report7dAnchored.latencyStatisticType,
    'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
  );
  assert.equal(latencyAnchored.sampleCount, 1);
  assert.equal(latencyAnchored.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(latencyAnchored.sampleSufficiencyNotice, '樣本不足，僅供觀察');
  assert.equal(
    latencyAnchored.latencyStatisticType,
    'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
  );
  assert.equal(latencyAnchored.signalLatencyP50, 886640);
  assert.equal(latencyAnchored.signalLatencyP95, 886640);

  // Also verify live HTTP endpoints for current window vs anchored historical window
  const [live7dHttp, live30dHttp, anchored7dHttp] = await Promise.all([
    fetch(`${TEST_BASE_URL}/api/smc-quality/report?window=7d&exchange=binance_usdm`).then(
      (r) => r.json()
    ),
    fetch(`${TEST_BASE_URL}/api/smc-quality/report?window=30d&exchange=binance_usdm`).then(
      (r) => r.json()
    ),
    fetch(
      `${TEST_BASE_URL}/api/smc-quality/report?window=7d&exchange=binance_usdm&reportAnchorAt=${encodeURIComponent(fixtureAnchorIso)}`
    ).then((r) => r.json()),
  ]);

  // Live 7d & 30d must exclude 2025-10-29 ATOMUSDT signal into historicalSignalsOutsideWindow
  assert.ok(
    live7dHttp.historicalSignalsOutsideWindow.some(
      (s: { symbol: string; signalDetectedAt: string }) =>
        s.symbol === 'ATOMUSDT' &&
        s.signalDetectedAt.startsWith('2025-10-29')
    )
  );
  assert.equal(
    live7dHttp.metricStatus,
    live7dHttp.entryWindowMissed > 0 ? 'ENTRY_WINDOW_MISSED' : 'NO_TRADES'
  );
  assert.equal(
    live30dHttp.metricStatus,
    live30dHttp.entryWindowMissed > 0 ? 'ENTRY_WINDOW_MISSED' : 'NO_TRADES'
  );

  // Historical anchored 7d on 2025-10-30 includes the 2025-10-29 ATOMUSDT signal with ENTRY_WINDOW_MISSED
  assert.equal(anchored7dHttp.reportAnchorAt, fixtureAnchorIso);
  assert.equal(anchored7dHttp.windowStartAt, '2025-10-23T00:00:00.000Z');
  assert.equal(anchored7dHttp.windowEndAt, '2025-10-30T00:00:00.000Z');
  assert.equal(anchored7dHttp.totalSignals, 1);
  assert.equal(anchored7dHttp.entryWindowMissed, 1);
  assert.equal(anchored7dHttp.metricStatus, 'ENTRY_WINDOW_MISSED');
  assert.equal(anchored7dHttp.sampleCount, 1);
  assert.equal(anchored7dHttp.sampleSufficiency, 'INSUFFICIENT');
  assert.equal(anchored7dHttp.sampleSufficiencyNotice, '樣本不足，僅供觀察');
});

