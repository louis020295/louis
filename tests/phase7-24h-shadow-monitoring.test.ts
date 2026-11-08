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
import {
  evaluateSmcStructure,
  SMC_RULE_VERSION,
} from '../server/engine/SmcRuleEngine.ts';
import { evaluateHistoricalVolumeAnomaly } from '../server/engine/VolumeAnomalyEngine.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  SmcAnalysisResult,
} from '../src/types/market.ts';

function createTempDbPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sqlite`
  );
}

function cleanupTempDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '.window-checkpoint.json']) {
    try {
      if (fs.existsSync(dbPath + suffix)) {
        fs.unlinkSync(dbPath + suffix);
      }
    } catch {
      // ignore
    }
  }
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

function buildSampleSmcAnalysis(
  symbol: string,
  actionState: SmcAnalysisResult['actionState'] = 'WAIT',
  waitReasons: string[] = ['未偵測到 Confirmed Liquidity Sweep (流動性掃蕩)']
): SmcAnalysisResult {
  const baseTime = 1_710_000_000_000;
  const klines = buildConfirmedKlines(90, baseTime, 100);
  const histVol = evaluateHistoricalVolumeAnomaly({
    symbol,
    exchange: 'binance_usdm',
    currentVolume: 1_500_000,
    historicalVolumes: Array.from({ length: 35 }, (_, i) => 1_000_000 + i * 1000),
    volumeTimeframe: '15m',
    baseProvenance: LIVE_PROVENANCE,
  });
  const smc = evaluateSmcStructure({
    symbol,
    primaryTimeframe: '15m',
    klinesByTimeframe: {
      '5m': klines,
      '15m': klines,
      '1h': klines,
      '4h': klines,
    },
    openInterest: 5_000_000,
    historicalVolume: histVol,
    isLowLiquidity: false,
    extremeFunding: false,
    lowLiquidityHighVolatility: false,
    requireFullMultiTimeframe: true,
    provenance: LIVE_PROVENANCE,
  });
  return {
    ...smc,
    actionState,
    waitReasons,
  };
}

function seedEvaluatedSymbols(
  radarDb: RadarDatabase,
  symbols: string[],
  windowKey: string,
  options?: {
    stale?: boolean;
    fallback?: boolean;
    leaveLastPending?: boolean;
    failLastSymbol?: boolean;
    rateLimitLastSymbol?: boolean;
  }
): void {
  const nowIso = new Date().toISOString();
  radarDb.enqueueSmcScanJobs(
    symbols.map((sym, idx) => ({
      symbol: sym,
      exchange: 'binance_usdm',
      priority: 1000 - idx,
      priorityTier: 2,
      priorityLabel: '2_RADAR_LONG',
      status: 'QUEUED',
      ruleVersion: SMC_RULE_VERSION,
      windowKey,
      requestedAt: nowIso,
      startedAt: null,
      completedAt: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
    })),
    true,
    true
  );

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const isLast = i === symbols.length - 1;
    if (isLast && options?.leaveLastPending) {
      continue;
    }
    if (isLast && (options?.failLastSymbol || options?.rateLimitLastSymbol)) {
      const jobs = radarDb.listSmcScanJobs('binance_usdm', 100);
      const targetJob = jobs.find((j) => j.symbol === sym);
      if (targetJob && targetJob.id !== undefined) {
        if (options.failLastSymbol) {
          radarDb.markSmcJobFailed(targetJob.id, 'Simulated HTTP 500 failure', 3, nowIso);
        } else if (options.rateLimitLastSymbol) {
          radarDb.markSmcJobRateLimited(
            targetJob.id,
            'Simulated HTTP 429 rate limit',
            1,
            new Date(Date.now() + 60_000).toISOString()
          );
        }
      }
      continue;
    }

    const smcAnalysis = buildSampleSmcAnalysis(
      sym,
      i % 2 === 0 ? 'WAIT' : 'WATCH'
    );
    radarDb.saveSmcScanResult({
      symbol: sym,
      exchange: 'binance_usdm',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: smcAnalysis.actionState,
      finalTradeSignal: 'NONE',
      marketRadarCategory: '準備觀察',
      evaluatedAt: nowIso,
      dataFetchedAt: nowIso,
      stale: Boolean(isLast && options?.stale),
      fallback: Boolean(isLast && options?.fallback),
      missingData: [],
      source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com/fapi/v1/klines)',
      isDemo: false,
      ruleVersion: SMC_RULE_VERSION,
      waitReasons: smcAnalysis.waitReasons,
      smcAnalysis,
    });
  }
}

describe('Phase 7: 24 小時 Paper 影子運行、候選訊號出現追蹤與品質觀察 (14 Required Verification Tests)', () => {
  it('1. 單次掃描不得標記 24 小時監控 COMPLETED', () => {
    const dbPath = createTempDbPath('phase7_t1');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 'win_t1');

      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const cycleSnap = monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_single_1',
      });

      assert.equal(cycleSnap.cycleValid, true);
      assert.equal(cycleSnap.totalContracts, 3);
      assert.equal(cycleSnap.evaluatedCount, 3);
      assert.equal(cycleSnap.pendingCount, 0);

      const report = monitor.get24hWindowReport();
      assert.ok(report.completedScanCycles >= 1);
      assert.notEqual(
        report.windowStatus,
        'COMPLETED',
        '單次掃描完成後絕不可偽造 24 小時監控 COMPLETED'
      );
      assert.equal(report.windowStatus, 'RUNNING');
      assert.ok(
        report.full24hVerificationNotice.includes('24 小時監控：未完成／未驗證')
      );
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('2. 未滿 24 小時時 windowStatus 維持 RUNNING，滿 24 小時（或可驗證時間序列回放）才可轉為 COMPLETED', () => {
    const dbPath = createTempDbPath('phase7_t2');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_t2');

      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      // Set windowStartedAt to 12 hours ago (< 24h)
      const nowMs = Date.now();
      const twelveHoursAgoIso = new Date(nowMs - 12 * 3600_000).toISOString();
      const expectedEndIso = new Date(nowMs + 12 * 3600_000).toISOString();
      monitor.configureMonitoringWindowForTest({
        windowStartedAt: twelveHoursAgoIso,
        windowExpectedEndAt: expectedEndIso,
        windowStatus: 'RUNNING',
      });

      monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_12h',
      });

      const reportAt12h = monitor.get24hWindowReport();
      assert.equal(
        reportAt12h.windowStatus,
        'RUNNING',
        '運行 12 小時 (< 24h) 時 windowStatus 必須維持 RUNNING'
      );
      assert.equal(reportAt12h.windowCompletedAt, null);

      // Now simulate full 24 hours elapsed
      const twentyFiveHoursAgoIso = new Date(nowMs - 25 * 3600_000).toISOString();
      const oneHourAgoEndIso = new Date(nowMs - 1 * 3600_000).toISOString();
      monitor.configureMonitoringWindowForTest({
        windowStartedAt: twentyFiveHoursAgoIso,
        windowExpectedEndAt: oneHourAgoEndIso,
        windowStatus: 'RUNNING',
      });

      const reportAfter24h = monitor.get24hWindowReport();
      assert.equal(
        reportAfter24h.windowStatus,
        'COMPLETED',
        '滿 24 小時且有完整掃描週期時 windowStatus 應轉為 COMPLETED'
      );
      assert.ok(reportAfter24h.windowCompletedAt !== null);
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('3. PENDING > 0 的週期不得標記為有效完成週期 (cycleValid = false)', () => {
    const dbPath = createTempDbPath('phase7_t3');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 'win_t3', {
        leaveLastPending: true,
      });

      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const invalidCycle = monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_pending_1',
      });

      assert.equal(invalidCycle.pendingCount, 1);
      assert.equal(
        invalidCycle.cycleValid,
        false,
        'PENDING > 0 的週期不得標記為有效完成週期'
      );
      assert.ok(invalidCycle.dataQualityWarning?.includes('pendingCount=1'));

      const report = monitor.get24hWindowReport();
      assert.equal(
        report.completedScanCycles,
        0,
        '無效週期不得計入 completedScanCycles'
      );
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('4. FAILED > 0 或 RATE_LIMITED > 0 的週期不得標記為有效完成週期 (cycleValid = false)', () => {
    const dbPath = createTempDbPath('phase7_t4');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_t4_fail', {
        failLastSymbol: true,
      });

      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const failedCycle = monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_failed_1',
      });
      assert.equal(failedCycle.failedCount, 1);
      assert.equal(failedCycle.cycleValid, false);
      assert.ok(failedCycle.dataQualityWarning?.includes('failedCount=1'));

      // Now test RATE_LIMITED > 0
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_t4_rl', {
        rateLimitLastSymbol: true,
      });
      const rateLimitedCycle = monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_rl_1',
      });
      assert.equal(rateLimitedCycle.rateLimitedCount, 1);
      assert.equal(rateLimitedCycle.cycleValid, false);
      assert.ok(
        rateLimitedCycle.dataQualityWarning?.includes('rateLimitedCount=1')
      );

      const report = monitor.get24hWindowReport();
      assert.equal(report.completedScanCycles, 0);
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('5. 出現 LONG CANDIDATE 時建立 Paper 訊號、寫入 paper ledger 與寫入本地 notification_outbox', () => {
    const dbPath = createTempDbPath('phase7_t5');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);
      const signalBarIndex = 35;

      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_long_1',
        scanRunId: 'scan_long_1',
        scanCycleId: 'cycle_long_1',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 36 * 900_000 - 10).toISOString(),
        evaluatedAt: new Date(baseTime + 36 * 900_000 - 1).toISOString(),
        klines: bars,
        signalBarIndex,
        atr14: 1.5,
        openInterest: 95000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認', '15m Bullish Liquidity Sweep 確認'],
        provenance: LIVE_PROVENANCE,
        decisionTrace: {
          symbol: 'BTCUSDT',
          smcActionState: 'LONG CANDIDATE',
          finalTradeSignal: '多頭交易候選',
        },
      });

      assert.ok(evalRes.signal !== null);
      const sig = evalRes.signal;
      assert.equal(sig.direction, 'LONG');
      assert.equal(sig.scanCycleId, 'cycle_long_1');
      assert.ok(sig.decisionTrace !== null);
      assert.ok(
        sig.status === 'PAPER_OPENED' ||
          sig.status === 'PAPER_CLOSED_WIN' ||
          sig.status === 'PAPER_CLOSED_LOSS'
      );

      // Verify corresponding paper ledger record was automatically written at i+1 open
      assert.ok(sig.paperLedgerId !== null && sig.paperLedgerId > 0);
      const ledgerEntries = radarDb.listPaperLedgerEntries(10);
      assert.equal(ledgerEntries.length, 1);
      assert.equal(ledgerEntries[0].symbol, 'BTCUSDT');
      assert.equal(ledgerEntries[0].side, 'LONG');
      assert.equal(ledgerEntries[0].entryPrice, bars[signalBarIndex + 1].open);

      // Verify local notification_outbox
      const outbox = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      assert.equal(outbox.length, 2, '應寫入 Telegram 與 TradingView 本地沙盒佇列');
      assert.ok(outbox.every((o) => o.status === 'SANDBOX_QUEUED'));
      assert.ok(outbox.every((o) => o.signalId === sig.signalId));
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('6. 出現 SHORT CANDIDATE 時建立 Paper 訊號、寫入 paper ledger 與寫入本地 notification_outbox', () => {
    const dbPath = createTempDbPath('phase7_t6');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 200);
      const signalBarIndex = 35;

      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_short_1',
        scanRunId: 'scan_short_1',
        scanCycleId: 'cycle_short_1',
        symbol: 'ETHUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 36 * 900_000 - 10).toISOString(),
        evaluatedAt: new Date(baseTime + 36 * 900_000 - 1).toISOString(),
        klines: bars,
        signalBarIndex,
        atr14: 2.0,
        openInterest: 75000,
        fundingRate: -0.0001,
        waitReasons: [],
        evidences: ['15m Bearish BOS 確認', '15m Bearish Liquidity Sweep 確認'],
        provenance: LIVE_PROVENANCE,
        decisionTrace: {
          symbol: 'ETHUSDT',
          smcActionState: 'SHORT CANDIDATE',
          finalTradeSignal: '空頭交易候選',
        },
      });

      assert.ok(evalRes.signal !== null);
      const sig = evalRes.signal;
      assert.equal(sig.direction, 'SHORT');
      assert.equal(sig.scanCycleId, 'cycle_short_1');
      assert.ok(sig.decisionTrace !== null);

      assert.ok(sig.paperLedgerId !== null && sig.paperLedgerId > 0);
      const ledgerEntries = radarDb.listPaperLedgerEntries(10);
      assert.equal(ledgerEntries.length, 1);
      assert.equal(ledgerEntries[0].symbol, 'ETHUSDT');
      assert.equal(ledgerEntries[0].side, 'SHORT');
      assert.equal(ledgerEntries[0].entryPrice, bars[signalBarIndex + 1].open);

      const outbox = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      assert.equal(outbox.length, 2);
      assert.ok(outbox.every((o) => o.status === 'SANDBOX_QUEUED'));
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('7. 同幣種同方向於冷卻時間內不會重複觸發 (COOLDOWN_BLOCKED)', () => {
    const dbPath = createTempDbPath('phase7_t7');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({
        paperMonitorDb: monitorDb,
        cooldownMs: 60 * 60 * 1000, // 1h cooldown
      });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(42, baseTime, 100);

      // First trigger at bar 34 -> allowed
      const firstRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_cd',
        scanRunId: 'scan_cd_1',
        scanCycleId: 'cycle_cd_1',
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 35 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 35 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 34,
        atr14: 1.2,
        openInterest: 45000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });
      assert.ok(firstRes.signal !== null);
      assert.notEqual(firstRes.signal.status, 'COOLDOWN_BLOCKED');

      // Second trigger on SAME symbol & SAME direction on next bar (within 1h cooldown) -> COOLDOWN_BLOCKED
      const secondRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_cd',
        scanRunId: 'scan_cd_2',
        scanCycleId: 'cycle_cd_2',
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 36 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 36 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 35,
        atr14: 1.2,
        openInterest: 45000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });
      assert.ok(secondRes.signal !== null);
      assert.equal(secondRes.signal.status, 'BLOCKED');
      assert.ok(
        secondRes.signal.statusReason?.includes('COOLDOWN_BLOCKED'),
        '同幣種同方向於冷卻時間內再次觸發必須被標記為 COOLDOWN_BLOCKED'
      );

      const outbox = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      const cooldownOutbox = outbox.filter(
        (o) => o.signalId === secondRes.signal!.signalId
      );
      assert.equal(cooldownOutbox.length, 2);
      assert.ok(cooldownOutbox.every((o) => o.status === 'COOLDOWN_BLOCKED'));
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('8. 0 候選但全部完整評估時標記 NO_CANDIDATE_VALID', () => {
    const dbPath = createTempDbPath('phase7_t8');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_t8');

      const diag = radarDb.computePhase6Diagnostics('binance_usdm');
      assert.equal(diag.totalContracts, 2);
      assert.equal(diag.evaluatedCount, 2);
      assert.equal(diag.pendingCount, 0);
      assert.equal(diag.longCandidateCount, 0);
      assert.equal(diag.shortCandidateCount, 0);
      assert.equal(diag.candidateStatus, 'NO_CANDIDATE_VALID');
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('9. 0 候選但存在 PENDING、stale、fallback 或錯誤時標記 NO_CANDIDATE_SUSPECTED', () => {
    const dbPath = createTempDbPath('phase7_t9');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_t9', {
        stale: true,
      });

      const diag = radarDb.computePhase6Diagnostics('binance_usdm');
      assert.equal(
        diag.candidateStatus,
        'NO_CANDIDATE_SUSPECTED',
        '存在 PENDING 或 stale 時必須標記為 NO_CANDIDATE_SUSPECTED'
      );
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('10. 進場價嚴格使用訊號確認後下一根已收線 K 棒開盤價 (i+1 open)', () => {
    const dbPath = createTempDbPath('phase7_t10');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);
      const signalBarIdx = 30;
      const expectedNextBarOpen = 108.77;
      bars[signalBarIdx + 1].open = expectedNextBarOpen;
      bars[signalBarIdx + 1].high = expectedNextBarOpen + 0.5;
      bars[signalBarIdx + 1].low = expectedNextBarOpen - 0.5;
      bars[signalBarIdx + 1].close = expectedNextBarOpen + 0.2;

      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_i1',
        scanRunId: 'scan_i1',
        scanCycleId: 'cycle_i1',
        symbol: 'ADAUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 31 * 900_000 - 10).toISOString(),
        evaluatedAt: new Date(baseTime + 31 * 900_000 - 1).toISOString(),
        klines: bars,
        signalBarIndex: signalBarIdx,
        atr14: 1.0,
        openInterest: 50000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });

      assert.ok(evalRes.signal !== null);
      assert.equal(
        evalRes.signal.entryReferencePrice,
        expectedNextBarOpen,
        '進場價必須嚴格鎖定為 i+1 K 棒開盤價'
      );
      assert.equal(
        evalRes.signal.entryReferenceTime,
        new Date(bars[signalBarIdx + 1].openTime).toISOString()
      );
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('11. 同根 K 棒同時觸及 SL 與 TP 時保守判定為 PAPER_CLOSED_LOSS (-1.0R)', () => {
    const dbPath = createTempDbPath('phase7_t11');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);
      const signalBarIdx = 30;
      bars[signalBarIdx + 1].open = 100;
      // Same bar touches BOTH stopLoss (98.5) and takeProfit (102.5)
      bars[signalBarIdx + 1].low = 80.0;
      bars[signalBarIdx + 1].high = 130.0;

      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_sltp',
        scanRunId: 'scan_sltp',
        scanCycleId: 'cycle_sltp',
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 31 * 900_000 - 10).toISOString(),
        evaluatedAt: new Date(baseTime + 31 * 900_000 - 1).toISOString(),
        klines: bars,
        signalBarIndex: signalBarIdx,
        atr14: 1.0,
        openInterest: 50000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });

      assert.ok(evalRes.signal !== null);
      assert.equal(
        evalRes.signal.status,
        'PAPER_CLOSED_LOSS',
        '同根 K 棒同時觸及 SL 與 TP 必須保守判定為 PAPER_CLOSED_LOSS'
      );
      assert.equal(evalRes.signal.riskMultiple, -1);
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('12. 無成交 (paperClosed = 0) 時回傳 metricStatus = "NO_TRADES" 且 winRate = null', () => {
    const dbPath = createTempDbPath('phase7_t12');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const report = monitor.get24hWindowReport();
      assert.equal(report.totalSignals, 0);
      assert.equal(report.paperOpened, 0);
      assert.equal(report.paperClosed, 0);
      assert.equal(report.metricStatus, 'NO_TRADES');
      assert.equal(report.winRate, null);
      assert.equal(report.averageR, null);
      assert.equal(report.profitFactor, null);
      assert.equal(report.maxDrawdownR, null);
      assert.equal(report.expectancyR, null);
      assert.equal(report.averageHoldingTime, null);
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('13. 外部 Telegram 與 TradingView 請求數維持 0 (externalTelegramRequestsCount = 0, externalTradingViewRequestsCount = 0)', () => {
    const dbPath = createTempDbPath('phase7_t13');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const windowReport = monitor.get24hWindowReport();
      assert.equal(windowReport.mode, 'PAPER ONLY');
      assert.equal(windowReport.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(windowReport.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
      assert.equal(windowReport.externalTelegramRequestsCount, 0);
      assert.equal(windowReport.externalTradingViewRequestsCount, 0);
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('14. 服務重啟後可恢復 24 小時監控視窗狀態與既有訊號紀錄，且不會重複建立視窗或訊號', () => {
    const dbPath = createTempDbPath('phase7_t14');
    try {
      const radarDb1 = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb1, ['BTCUSDT', 'ETHUSDT'], 'win_t14');

      const monitorDb1 = new PaperMonitorDatabase(radarDb1);
      const tracker1 = new SignalOutcomeTracker({ paperMonitorDb: monitorDb1 });
      const adapters1 = createTestAdapters();
      const smcBatchScanner1 = new SmcBatchScanService({
        db: radarDb1,
        adapters: adapters1,
      });
      const monitor1 = new PaperShadowMonitor({
        radarDb: radarDb1,
        paperMonitorDb: monitorDb1,
        outcomeTracker: tracker1,
        adapters: adapters1,
        smcBatchScanner: smcBatchScanner1,
      });

      const initialWindowId = monitor1.getStatus().monitoringWindowId;
      monitor1.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_restart_1',
      });

      const baseTime = 1_710_000_000_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);
      const sig1Res = tracker1.evaluateAndTrackSignal({
        monitorRunId: monitor1.getStatus().monitorRunId,
        scanRunId: 'run_restart_1',
        scanCycleId: 'cycle_restart_1',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 36 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 36 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 35,
        atr14: 1.5,
        openInterest: 95000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });
      assert.ok(sig1Res.signal !== null);

      radarDb1.close();

      // Simulate service restart on the same SQLite database file
      const radarDb2 = new RadarDatabase(dbPath);
      const monitorDb2 = new PaperMonitorDatabase(radarDb2);
      const tracker2 = new SignalOutcomeTracker({ paperMonitorDb: monitorDb2 });
      const adapters2 = createTestAdapters();
      const smcBatchScanner2 = new SmcBatchScanService({
        db: radarDb2,
        adapters: adapters2,
      });
      const monitor2 = new PaperShadowMonitor({
        radarDb: radarDb2,
        paperMonitorDb: monitorDb2,
        outcomeTracker: tracker2,
        adapters: adapters2,
        smcBatchScanner: smcBatchScanner2,
      });

      const recoveredStatus = monitor2.getStatus();
      assert.equal(
        recoveredStatus.monitoringWindowId,
        initialWindowId,
        '重啟後必須恢復既有 monitoringWindowId'
      );

      const recoveredReport = monitor2.get24hWindowReport();
      assert.ok(recoveredReport.completedScanCycles >= 1);
      assert.equal(recoveredReport.totalSignals, 1);
      assert.equal(
        recoveredReport.candidateTimeline[0].signalId,
        sig1Res.signal.signalId
      );

      // Re-evaluating the exact same signal bar after restart must remain idempotent
      const sigAfterRestart = tracker2.evaluateAndTrackSignal({
        monitorRunId: recoveredStatus.monitorRunId,
        scanRunId: 'run_restart_1',
        scanCycleId: 'cycle_restart_1',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(baseTime + 36 * 900_000).toISOString(),
        evaluatedAt: new Date(baseTime + 36 * 900_000).toISOString(),
        klines: bars,
        signalBarIndex: 35,
        atr14: 1.5,
        openInterest: 95000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bullish BOS 確認'],
        provenance: LIVE_PROVENANCE,
      });
      assert.equal(sigAfterRestart.insertedNew, false);
      assert.equal(sigAfterRestart.signal?.signalId, sig1Res.signal.signalId);
      assert.equal(
        monitorDb2.listTrackedSignals({ exchange: 'binance_usdm' }).length,
        1
      );
      radarDb2.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });
});

describe('Phase 7 實機候選訊號診斷與修正驗收測試 (Section 七 12 項必備測試)', () => {
  it('1~3. SHORT CANDIDATE 建立唯一 signalId；若第 i+1 根 K 線尚未出現保持 CREATED (entryReferencePrice = null)；第 i+1 根出現後嚴格以 nextBar.open 轉為 PAPER_OPENED', () => {
    const dbPath = createTempDbPath('phase7_sec7_123');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const baseTime = 1_792_896_300_000 - 35 * 900_000;
      // 36 confirmed bars: signal occurs on the last bar (index 35), so bar i+1 (index 36) does NOT exist yet
      const barsWithoutNext = buildConfirmedKlines(36, baseTime, 1.6);
      const signalBarIndex = 35;

      const evalCreated = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_atom_1',
        scanRunId: 'scan_atom_1',
        scanCycleId: 'cycle_binance_usdm_win_1792897200000_v1.0.0-smc-ict-deterministic_3f4ag8',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: '2026-10-25T02:59:59.950Z',
        evaluatedAt: '2026-10-25T02:59:59.990Z',
        klines: barsWithoutNext,
        signalBarIndex,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: [
          '15m 掃蕩 1.631 高點流動性並收回下方 (Confirmed Bearish Sweep)',
          '15m 實體收破 1.624 低點完成結構轉折 (Bearish CHoCH)',
        ],
        provenance: LIVE_PROVENANCE,
      });

      // Test 1: Unique signalId created for SHORT CANDIDATE
      assert.ok(evalCreated.signal !== null);
      const createdSig = evalCreated.signal;
      assert.ok(createdSig.signalId.includes('ATOMUSDT_15m_SHORT'));
      assert.equal(createdSig.direction, 'SHORT');

      // Test 2: When bar i+1 does not exist yet, status MUST remain CREATED with entryReferencePrice = null
      assert.equal(createdSig.status, 'CREATED');
      assert.equal(createdSig.entryReferencePrice, null);
      assert.equal(createdSig.entryReferenceTime, null);

      // Outbox must record PENDING_ENTRY (not blocked as general trade rejection)
      const outboxBeforeNextBar = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      assert.equal(outboxBeforeNextBar.length, 2);
      assert.ok(outboxBeforeNextBar.every((o) => o.status === 'PENDING_ENTRY'));
      assert.equal(
        monitorDb.countBlockedNotifications('binance_usdm'),
        0,
        'PENDING_ENTRY 不得計入 notificationBlocked'
      );
      assert.equal(
        monitorDb.countPendingEntryNotifications('binance_usdm'),
        2
      );

      // Test 3: When bar i+1 arrives, it must open at nextBar.open (and ignore high/low/close for entry price)
      const nextBarOpenTime = barsWithoutNext[signalBarIndex].openTime + 900_000;
      const nextBar: Kline = {
        openTime: nextBarOpenTime,
        closeTime: nextBarOpenTime + 900_000 - 1,
        open: 1.622,
        high: 1.625, // Below stopLoss so it stays open on bar i+1
        low: 1.618,  // Above takeProfit so it stays open on bar i+1
        close: 1.620,
        volume: 125_000,
        quoteVolume: 202_500,
        isClosed: true,
      };
      const barsWithNext = [...barsWithoutNext, nextBar];

      const settledSig = tracker.settleSignalWithKlines({
        signalId: createdSig.signalId,
        klines: barsWithNext,
        atr14: 0.0052143,
      });
      assert.ok(settledSig !== null);
      assert.equal(settledSig.status, 'PAPER_OPENED');
      assert.equal(settledSig.entryReferencePrice, 1.622);
      assert.equal(
        settledSig.entryReferenceTime,
        new Date(nextBarOpenTime).toISOString()
      );
      assert.ok(settledSig.stopLoss !== null && settledSig.stopLoss > 1.622);
      assert.ok(settledSig.takeProfit !== null && settledSig.takeProfit < 1.622);

      // Outbox PENDING_ENTRY must be promoted to SANDBOX_QUEUED
      const outboxAfterOpen = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      assert.ok(outboxAfterOpen.every((o) => o.status === 'SANDBOX_QUEUED'));

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
      cleanupTempDb(`${dbPath}.window-checkpoint.json`);
    }
  });

  it('4~6. 候選不會因掃描週期結束消失；已完成 24 小時視窗不得被新掃描週期覆寫；windowFinalSnapshot 與 currentLiveCycleSnapshot 分離', () => {
    const dbPath = createTempDbPath('phase7_sec7_456');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const symbols = ['BTCUSDT', 'ETHUSDT', 'ATOMUSDT'];
      seedEvaluatedSymbols(radarDb, symbols, 'win_cycle_2');

      // Mark ATOMUSDT as SHORT CANDIDATE in Cycle 2
      const atomAnalysis = buildSampleSmcAnalysis('ATOMUSDT', 'SHORT CANDIDATE', []);
      const cycle2Iso = '2026-10-25T03:14:46.603Z';
      radarDb.saveSmcScanResult({
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        marketRadarCategory: '雷達空頭觀察',
        evaluatedAt: cycle2Iso,
        dataFetchedAt: cycle2Iso,
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com/fapi/v1/klines)',
        isDemo: false,
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: [],
        smcAnalysis: atomAnalysis,
      });

      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      // Create the candidate signal during Cycle 2
      const baseTime = 1_792_896_300_000 - 35 * 900_000;
      const bars = buildConfirmedKlines(36, baseTime, 1.6);
      tracker.evaluateAndTrackSignal({
        monitorRunId: monitor.getStatus().monitorRunId,
        scanRunId: 'scan_c2',
        scanCycleId: 'cycle_2_completed',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: cycle2Iso,
        evaluatedAt: cycle2Iso,
        klines: bars,
        signalBarIndex: 35,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: ['15m Bearish Sweep & CHoCH'],
        provenance: LIVE_PROVENANCE,
      });

      monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_2_completed',
      });

      // Complete the 24h window
      const nowMs = Date.now();
      monitor.configureMonitoringWindowForTest({
        windowStartedAt: new Date(nowMs - 25 * 3600_000).toISOString(),
        windowExpectedEndAt: new Date(nowMs - 1 * 3600_000).toISOString(),
        windowStatus: 'RUNNING',
      });

      const completedReport = monitor.get24hWindowReport();
      assert.equal(completedReport.windowStatus, 'COMPLETED');
      assert.equal(completedReport.shortCandidateCount, 1);
      assert.equal(completedReport.totalSignals, 1);

      // Now start a new post-window Cycle 3 where 1 symbol is PENDING and ATOMUSDT is not yet evaluated in Cycle 3
      seedEvaluatedSymbols(radarDb, symbols, 'win_cycle_3', {
        leaveLastPending: true,
      });

      // Attempt to record a new cycle after window completion -> must NOT overwrite completed 24h window
      monitor.recordScanCycleSnapshot({
        overrideScanCycleId: 'cycle_3_running',
      });

      const reportAfterNewCycle = monitor.get24hWindowReport();
      // Test 4: Candidate signal did not disappear
      assert.equal(reportAfterNewCycle.totalSignals, 1);
      assert.equal(reportAfterNewCycle.candidateTimeline.length, 1);
      assert.equal(reportAfterNewCycle.candidateTimeline[0].symbol, 'ATOMUSDT');

      // Test 5: Completed 24h window summary (windowFinalSnapshot & totalShortCandidates) is NOT overwritten by the new cycle, while top-level cycle counters stay consistent with current smcSnapshot
      assert.equal(reportAfterNewCycle.windowStatus, 'COMPLETED');
      assert.equal(reportAfterNewCycle.totalShortCandidates, 1);
      assert.equal(reportAfterNewCycle.evaluatedCount, 2);
      assert.equal(reportAfterNewCycle.pendingCount, 1);
      assert.equal(reportAfterNewCycle.fullUniverseStatus, 'RUNNING');

      // Test 6: windowFinalSnapshot and currentLiveCycleSnapshot are separated
      assert.ok(reportAfterNewCycle.windowFinalSnapshot !== null);
      assert.equal(
        reportAfterNewCycle.windowFinalSnapshot.finalEvaluatedCount,
        3
      );
      assert.equal(
        reportAfterNewCycle.windowFinalSnapshot.finalCandidateCount,
        1
      );
      assert.equal(
        reportAfterNewCycle.windowFinalSnapshot.finalPaperSignalCount,
        1
      );
      assert.equal(
        reportAfterNewCycle.currentLiveCycleSnapshot.currentCycleStatus,
        'RUNNING'
      );
      assert.equal(
        reportAfterNewCycle.currentLiveCycleSnapshot.currentEvaluatedCount,
        2
      );
      assert.equal(
        reportAfterNewCycle.currentLiveCycleSnapshot.currentPendingCount,
        1
      );

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
      cleanupTempDb(`${dbPath}.window-checkpoint.json`);
    }
  });

  it('7~9. 報表語義：有候選未開倉為 SIGNALS_PENDING_ENTRY；有開倉未平倉為 OPEN_TRADES_NO_CLOSED_RESULTS；完全無候選才為 NO_TRADES，且未結算績效欄位保持 null', () => {
    const dbPath = createTempDbPath('phase7_sec7_789');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      // Test 9: 0 candidates -> NO_TRADES
      const emptyReport = tracker.buildWindowReport({
        window: '24h',
        exchange: 'binance_usdm',
        monitorRunId: 'mon_m1',
        scanRunId: 'scan_m1',
      });
      assert.equal(emptyReport.totalSignals, 0);
      assert.equal(emptyReport.paperOpened, 0);
      assert.equal(emptyReport.paperClosed, 0);
      assert.equal(emptyReport.openSignals, 0);
      assert.equal(emptyReport.openTrades, 0);
      assert.equal(emptyReport.metricStatus, 'NO_TRADES');
      assert.equal(emptyReport.winRate, null);
      assert.equal(emptyReport.averageR, null);
      assert.equal(emptyReport.profitFactor, null);
      assert.equal(emptyReport.maxDrawdownR, null);
      assert.equal(emptyReport.expectancyR, null);
      assert.equal(emptyReport.averageHoldingTime, null);

      // Test 7: 1 candidate in CREATED (waiting for bar i+1) -> SIGNALS_PENDING_ENTRY
      const nowMs = Date.now();
      const baseTime = nowMs - 36 * 900_000;
      const bars36 = buildConfirmedKlines(36, baseTime, 1.6);
      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_m1',
        scanRunId: 'scan_m1',
        scanCycleId: 'cycle_m1',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date(nowMs - 60_000).toISOString(),
        evaluatedAt: new Date(nowMs - 60_000).toISOString(),
        klines: bars36,
        signalBarIndex: 35,
        atr14: 0.05,
        openInterest: 10_000_000,
        fundingRate: -0.0001,
        waitReasons: [],
        evidences: ['15m Bearish Sweep & CHoCH'],
        provenance: LIVE_PROVENANCE,
      });
      assert.ok(evalRes.signal !== null);
      assert.equal(evalRes.signal.status, 'CREATED');

      const pendingEntryReport = tracker.buildWindowReport({
        window: '24h',
        exchange: 'binance_usdm',
        monitorRunId: 'mon_m1',
        scanRunId: 'scan_m1',
      });
      assert.equal(pendingEntryReport.totalSignals, 1);
      assert.equal(pendingEntryReport.paperOpened, 0);
      assert.equal(pendingEntryReport.paperClosed, 0);
      assert.equal(pendingEntryReport.openSignals, 1);
      assert.equal(pendingEntryReport.openTrades, 0);
      assert.equal(pendingEntryReport.metricStatus, 'SIGNALS_PENDING_ENTRY');
      assert.equal(pendingEntryReport.winRate, null);
      assert.equal(pendingEntryReport.averageR, null);
      assert.equal(pendingEntryReport.profitFactor, null);
      assert.equal(pendingEntryReport.maxDrawdownR, null);
      assert.equal(pendingEntryReport.expectancyR, null);
      assert.equal(pendingEntryReport.averageHoldingTime, null);

      // Test 8: Settle with bar i+1 that opens the trade but does not hit SL/TP -> OPEN_TRADES_NO_CLOSED_RESULTS
      const lastClose = bars36[35].close;
      const nextBarOpenTime = bars36[35].openTime + 900_000;
      const bars37: Kline[] = [
        ...bars36,
        {
          openTime: nextBarOpenTime,
          closeTime: nextBarOpenTime + 900_000 - 1,
          open: lastClose,
          high: lastClose + 0.01, // does not hit SL (lastClose + 0.075)
          low: lastClose - 0.01,  // does not hit TP (lastClose - 0.125)
          close: lastClose,
          volume: 50_000,
          quoteVolume: 100_000,
          isClosed: true,
        },
      ];
      tracker.settleSignalWithKlines({
        signalId: evalRes.signal.signalId,
        klines: bars37,
        atr14: 0.05,
      });

      const openTradeReport = tracker.buildWindowReport({
        window: '24h',
        exchange: 'binance_usdm',
        monitorRunId: 'mon_m1',
        scanRunId: 'scan_m1',
      });
      assert.equal(openTradeReport.totalSignals, 1);
      assert.equal(openTradeReport.paperOpened, 1);
      assert.equal(openTradeReport.paperClosed, 0);
      assert.equal(openTradeReport.openSignals, 0);
      assert.equal(openTradeReport.openTrades, 1);
      assert.equal(
        openTradeReport.metricStatus,
        'OPEN_TRADES_NO_CLOSED_RESULTS'
      );
      assert.equal(openTradeReport.winRate, null);
      assert.equal(openTradeReport.averageR, null);
      assert.equal(openTradeReport.profitFactor, null);
      assert.equal(openTradeReport.maxDrawdownR, null);
      assert.equal(openTradeReport.expectancyR, null);
      assert.equal(openTradeReport.averageHoldingTime, null);

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
      cleanupTempDb(`${dbPath}.window-checkpoint.json`);
    }
  });

  it('10~12. notificationBlocked 具備可追蹤原因 (區分 STALE_BLOCKED / FALLBACK_BLOCKED / MISSING_DATA_BLOCKED / NON_CANDIDATE_BLOCKED / PENDING_ENTRY)，finalCategorySmcMismatchCount = 0，且維持安全限制', () => {
    const dbPath = createTempDbPath('phase7_sec7_101112');
    try {
      const radarDb = new RadarDatabase(dbPath);
      seedEvaluatedSymbols(radarDb, ['BTCUSDT', 'ETHUSDT'], 'win_sec7_10');
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });
      const adapters = createTestAdapters();
      const smcBatchScanner = new SmcBatchScanService({ db: radarDb, adapters });
      const monitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb: monitorDb,
        outcomeTracker: tracker,
        adapters,
        smcBatchScanner,
      });

      const baseTime = Date.now() - 40 * 900_000;
      const bars = buildConfirmedKlines(40, baseTime, 100);

      // Stale candidate -> STALE_BLOCKED
      const staleEval = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_blk',
        scanRunId: 'scan_blk',
        scanCycleId: 'cycle_blk_1',
        symbol: 'XRPUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: new Date().toISOString(),
        evaluatedAt: new Date().toISOString(),
        klines: bars,
        signalBarIndex: 35,
        atr14: 0.5,
        openInterest: 100_000,
        fundingRate: 0.0001,
        waitReasons: [],
        evidences: ['15m Bearish Sweep'],
        provenance: {
          ...LIVE_PROVENANCE,
          stale: true,
        },
        recordBlockedInDb: true,
      });
      assert.ok(staleEval.signal !== null);
      assert.equal(staleEval.signal.status, 'BLOCKED');

      const outbox = monitorDb.listNotificationOutbox({
        exchange: 'binance_usdm',
      });
      assert.ok(outbox.length >= 1);
      assert.ok(outbox.every((o) => o.status === 'STALE_BLOCKED'));
      assert.ok(outbox.every((o) => o.scanCycleId === 'cycle_blk_1'));
      assert.ok(outbox.every((o) => o.snapshotAt !== null));
      assert.ok(outbox.every((o) => Boolean(o.blockedReason)));

      const status = monitor.getStatus();
      const health = monitor.getHealth();
      // Test 11: finalCategorySmcMismatchCount remains 0
      assert.equal(health.finalCategorySmcMismatchCount, 0);

      // Test 12: Safety constraints strictly preserved
      assert.equal(status.mode, 'PAPER ONLY');
      assert.equal(status.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(status.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
      cleanupTempDb(`${dbPath}.window-checkpoint.json`);
    }
  });
});

describe('Phase 7 Live Paper 進場時序與防止回溯開盤價驗收測試 (Section 六 必備測試)', () => {
  it('1. 訊號在下一根 K 線開盤前被發現 (signalDetectedAt < nextBar.openTime)，可以使用 nextBar.open 作為進場參考價', () => {
    const dbPath = createTempDbPath('phase7_live_timing_ontime');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      // Signal bar i: 02:45:00.000Z ~ 02:59:59.999Z, nextBar i+1 openTime: 03:00:00.000Z
      const signalBarOpenTime = Date.parse('2026-10-25T02:45:00.000Z');
      const baseTime = signalBarOpenTime - 35 * 900_000;
      const barsWithoutNext = buildConfirmedKlines(36, baseTime, 1.6);
      const signalBarIndex = 35;

      // Detected at 02:59:59.995Z (< 03:00:00.000Z)
      const evalRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_ontime',
        scanRunId: 'scan_ontime',
        scanCycleId: 'cycle_ontime',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: '2026-10-25T02:59:59.990Z',
        evaluatedAt: '2026-10-25T02:59:59.995Z',
        signalDetectedAt: '2026-10-25T02:59:59.995Z',
        klines: barsWithoutNext,
        signalBarIndex,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: ['15m Bearish Sweep & CHoCH'],
        provenance: LIVE_PROVENANCE,
        isBacktest: false,
      });

      assert.ok(evalRes.signal !== null);
      assert.equal(evalRes.signal.status, 'CREATED');
      assert.equal(evalRes.signal.entryStatus, 'PENDING_NEXT_ENTRY');
      assert.equal(evalRes.signal.entryWindowStatus, '等待下一根 K 線開盤');
      assert.equal(evalRes.signal.entryReferencePrice, null);
      assert.equal(
        evalRes.signal.originalEntryWindowOpenTime,
        Date.parse('2026-10-25T03:00:00.000Z')
      );

      // Next bar i+1 opens at 03:00:00.000Z with open = 1.622
      const nextBar: Kline = {
        openTime: Date.parse('2026-10-25T03:00:00.000Z'),
        closeTime: Date.parse('2026-10-25T03:14:59.999Z'),
        open: 1.622,
        high: 1.624,
        low: 1.619,
        close: 1.621,
        volume: 120_000,
        quoteVolume: 194_520,
        isClosed: true,
      };
      const settled = tracker.settleSignalWithKlines({
        signalId: evalRes.signal.signalId,
        klines: [...barsWithoutNext, nextBar],
        atr14: 0.0052143,
        isBacktest: false,
      });

      assert.ok(settled !== null);
      assert.equal(settled.status, 'PAPER_OPENED');
      assert.equal(settled.entryStatus, 'PAPER_OPENED');
      assert.equal(settled.entryReferencePrice, 1.622);
      assert.equal(settled.entryReferenceTime, '2026-10-25T03:00:00.000Z');
      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('2 & 4. ATOMUSDT 實機案例：訊號在下一根 K 線開盤後才被發現 (signalDetectedAt >= nextBar.openTime)，不得回溯使用 nextBar.open，標記 ENTRY_WINDOW_MISSED 且報表回傳 metricStatus = "ENTRY_WINDOW_MISSED"', () => {
    const dbPath = createTempDbPath('phase7_live_timing_atom_missed');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      // ATOMUSDT exact timestamps from user case:
      // Signal bar i close: 02:59:59.999Z (open: 02:45:00.000Z)
      // Bar i+1 open: 03:00:00.000Z, open price = 1.622
      // System detected signal: 03:14:46.638Z (>= 03:00:00.000Z!)
      const signalBarOpenTime = Date.parse('2026-10-25T02:45:00.000Z');
      const baseTime = signalBarOpenTime - 35 * 900_000;
      const bars36 = buildConfirmedKlines(36, baseTime, 1.625);
      const nextBar: Kline = {
        openTime: Date.parse('2026-10-25T03:00:00.000Z'),
        closeTime: Date.parse('2026-10-25T03:14:59.999Z'),
        open: 1.622,
        high: 1.630,
        low: 1.610,
        close: 1.615,
        volume: 150_000,
        quoteVolume: 243_000,
        isClosed: true,
      };
      const barsWithNext = [...bars36, nextBar];

      const evalLate = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_atom_late',
        scanRunId: 'scan_atom_late',
        scanCycleId:
          'cycle_binance_usdm_win_1792897200000_v1.0.0-smc-ict-deterministic_3f4ag8',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: '2026-10-25T03:14:46.603Z',
        evaluatedAt: '2026-10-25T03:14:46.638Z',
        signalDetectedAt: '2026-10-25T03:14:46.638Z',
        klines: barsWithNext,
        signalBarIndex: 35,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: [
          '15m 掃蕩 1.631 高點流動性並收回下方 (Confirmed Bearish Sweep)',
          '15m 實體收破 1.624 低點完成結構轉折 (Bearish CHoCH)',
        ],
        provenance: LIVE_PROVENANCE,
        isBacktest: false,
      });

      assert.ok(evalLate.signal !== null);
      const sig = evalLate.signal;

      // Strictly forbidden from retroactively using nextBar.open (1.622)
      assert.equal(sig.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(sig.entryStatus, 'ENTRY_WINDOW_MISSED');
      assert.equal(sig.entryWindowStatus, '原始進場窗口已錯過');
      assert.equal(
        sig.entryReferencePrice,
        null,
        '嚴禁回溯使用已經錯過的 03:00:00 開盤價 1.622'
      );
      assert.equal(sig.entryReferenceTime, null);
      assert.equal(sig.signalBarOpenTime, Date.parse('2026-10-25T02:45:00.000Z'));
      assert.equal(sig.signalBarCloseTime, Date.parse('2026-10-25T02:59:59.999Z'));
      assert.equal(sig.signalDetectedAt, '2026-10-25T03:14:46.638Z');
      assert.equal(
        sig.originalEntryWindowOpenTime,
        Date.parse('2026-10-25T03:00:00.000Z')
      );
      assert.equal(
        sig.originalEntryWindowCloseTime,
        Date.parse('2026-10-25T03:14:59.999Z')
      );
      assert.equal(
        sig.detectionLatencyMs,
        Date.parse('2026-10-25T03:14:46.638Z') -
          Date.parse('2026-10-25T02:59:59.999Z')
      );

      // No retroactive paper ledger trade may be created
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);

      // Check report semantics (Section 四):
      // totalSignals = 1, paperOpened = 0, paperClosed = 0, entryWindowMissed = 1, metricStatus = "ENTRY_WINDOW_MISSED"
      const report = tracker.buildWindowReport({
        window: '24h',
        exchange: 'binance_usdm',
        monitorRunId: 'mon_atom_late',
        scanRunId: 'scan_atom_late',
        sinceIso: '2026-10-24T03:15:00.000Z',
        nowMs: Date.parse('2026-10-25T03:15:00.000Z'),
      });
      assert.equal(report.totalSignals, 1);
      assert.equal(report.paperOpened, 0);
      assert.equal(report.paperClosed, 0);
      assert.equal(report.entryWindowMissed, 1);
      assert.equal(report.metricStatus, 'ENTRY_WINDOW_MISSED');
      assert.equal(report.winRate, null);
      assert.equal(report.averageR, null);
      assert.equal(report.profitFactor, null);
      assert.equal(report.maxDrawdownR, null);
      assert.equal(report.expectancyR, null);
      assert.equal(report.averageHoldingTime, null);

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });

  it('3 & 4. 遲到訊號等待下一個尚未開盤的未來 K 線窗口 (allowDeferredFutureBarEntry = true) 時，不使用已錯過的 i+1 開盤價，僅在真正到達未來 i+2 開盤時間後才設定 entryReferencePrice；回測模式 (isBacktest = true) 則使用 confirmedKlines[i+1].open', () => {
    const dbPath = createTempDbPath('phase7_live_deferred_vs_backtest');
    try {
      const radarDb = new RadarDatabase(dbPath);
      const monitorDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: monitorDb });

      const signalBarOpenTime = Date.parse('2026-10-25T02:45:00.000Z');
      const baseTime = signalBarOpenTime - 35 * 900_000;
      const bars36 = buildConfirmedKlines(36, baseTime, 1.625);
      const missedBarIPlus1: Kline = {
        openTime: Date.parse('2026-10-25T03:00:00.000Z'),
        closeTime: Date.parse('2026-10-25T03:14:59.999Z'),
        open: 1.622, // already missed at 03:14:46.638Z
        high: 1.625,
        low: 1.618,
        close: 1.620,
        volume: 100_000,
        quoteVolume: 162_000,
        isClosed: true,
      };

      // (A) Live Paper with allowDeferredFutureBarEntry: when bar i+2 (03:15:00Z) has NOT arrived yet, stays ENTRY_WINDOW_MISSED with entryReferencePrice = null
      const evalDeferred = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_def',
        scanRunId: 'scan_def',
        scanCycleId: 'cycle_def',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: '2026-10-25T03:14:46.603Z',
        evaluatedAt: '2026-10-25T03:14:46.638Z',
        signalDetectedAt: '2026-10-25T03:14:46.638Z',
        klines: [...bars36, missedBarIPlus1],
        signalBarIndex: 35,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: ['15m Bearish Sweep & CHoCH'],
        provenance: LIVE_PROVENANCE,
        isBacktest: false,
        allowDeferredFutureBarEntry: true,
      });

      assert.ok(evalDeferred.signal !== null);
      assert.equal(evalDeferred.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(
        evalDeferred.signal.entryReferencePrice,
        null,
        '未來窗口 (03:15:00Z) 尚未開盤前，不得回溯使用 03:00:00Z 的 1.622'
      );

      // Now future bar i+2 (openTime = 03:15:00.000Z > signalDetectedAt 03:14:46.638Z) arrives with open = 1.614
      const futureBarIPlus2: Kline = {
        openTime: Date.parse('2026-10-25T03:15:00.000Z'),
        closeTime: Date.parse('2026-10-25T03:29:59.999Z'),
        open: 1.614,
        high: 1.616,
        low: 1.611,
        close: 1.613,
        volume: 110_000,
        quoteVolume: 177_430,
        isClosed: true,
      };
      const settledFuture = tracker.settleSignalWithKlines({
        signalId: evalDeferred.signal.signalId,
        klines: [...bars36, missedBarIPlus1, futureBarIPlus2],
        atr14: 0.0052143,
        isBacktest: false,
        allowDeferredFutureBarEntry: true,
      });
      assert.ok(settledFuture !== null);
      assert.equal(settledFuture.status, 'PAPER_OPENED');
      assert.equal(
        settledFuture.entryReferencePrice,
        1.614,
        '應使用下一個尚未開盤的未來 K 線 (03:15:00Z) 開盤價 1.614，而非已錯過的 1.622'
      );
      assert.equal(
        settledFuture.entryReferenceTime,
        '2026-10-25T03:15:00.000Z'
      );

      // (B) Backtest mode (isBacktest = true): uses confirmedKlines[i + 1].open (1.622)
      const evalBacktest = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_bt',
        scanRunId: 'scan_bt',
        scanCycleId: 'cycle_bt',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: '2026-10-25T03:14:46.603Z',
        evaluatedAt: '2026-10-25T03:14:46.638Z',
        klines: [...bars36, missedBarIPlus1],
        signalBarIndex: 35,
        atr14: 0.0052143,
        openInterest: 18_500_000,
        fundingRate: -0.00008,
        waitReasons: [],
        evidences: ['15m Bearish Sweep & CHoCH'],
        provenance: LIVE_PROVENANCE,
        isBacktest: true,
        allowBacktestTracking: true,
      });
      assert.ok(evalBacktest.signal !== null);
      assert.equal(
        evalBacktest.signal.entryReferencePrice,
        1.622,
        '回測模式 (isBacktest = true) 於第 i 根收盤產生訊號並使用 confirmedKlines[i+1].open'
      );

      radarDb.close();
    } finally {
      cleanupTempDb(dbPath);
    }
  });
});


