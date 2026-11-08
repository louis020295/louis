import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExchangeAdapter } from '../server/adapters/ExchangeAdapter.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import {
  buildSmcGateDiagnosticsSummary,
} from '../server/engine/SmcRuleEngine.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { createApp } from '../server.ts';
import {
  DataProvenance,
  Kline,
  MarketTicker,
  SmcAnalysisResult,
  SymbolSmcGateEvaluation,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function makeTempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radar-p18-2-${prefix}-`));
  return path.join(dir, 'test.sqlite');
}

function makeGateEval(
  overrides: Partial<SymbolSmcGateEvaluation> = {}
): SymbolSmcGateEvaluation {
  return {
    bosMssPassed: false,
    liquiditySweepPassed: false,
    displacementPassed: false,
    fvgOrObPassed: false,
    mtfAlignmentPassed: false,
    atrPassed: true,
    historyPassed: true,
    oiPassed: true,
    fundingPassed: true,
    oiFundingPassed: true,
    dataFreshnessPassed: true,
    liquiditySafetyPassed: true,
    riskSafetyPassed: true,
    missingGates: [
      'BOS_MSS',
      'LIQUIDITY_SWEEP',
      'DISPLACEMENT',
      'FVG_OR_OB',
      'MTF_ALIGNMENT',
    ],
    lastBlockingGate: 'MTF_ALIGNMENT',
    nearMissStatus: 'NOT_NEAR_CANDIDATE',
    intendedDirection: 'NEUTRAL',
    waitReasons: [],
    ...overrides,
  };
}

function makeConfirmedSmcAnalysis(
  symbol: string,
  actionState: 'LONG CANDIDATE' | 'SHORT CANDIDATE' | 'WATCH' | 'WAIT',
  gateOverrides: Partial<SymbolSmcGateEvaluation> = {}
): SmcAnalysisResult {
  const isCandidate =
    actionState === 'LONG CANDIDATE' || actionState === 'SHORT CANDIDATE';
  const dir: 'LONG' | 'SHORT' | 'NEUTRAL' =
    actionState === 'LONG CANDIDATE'
      ? 'LONG'
      : actionState === 'SHORT CANDIDATE'
        ? 'SHORT'
        : gateOverrides.intendedDirection ?? 'LONG';
  const gateEval = makeGateEval({
    bosMssPassed: isCandidate ? true : (gateOverrides.bosMssPassed ?? true),
    liquiditySweepPassed: isCandidate
      ? true
      : (gateOverrides.liquiditySweepPassed ?? true),
    displacementPassed: isCandidate
      ? true
      : (gateOverrides.displacementPassed ?? true),
    fvgOrObPassed: isCandidate
      ? true
      : (gateOverrides.fvgOrObPassed ?? true),
    mtfAlignmentPassed: isCandidate
      ? true
      : (gateOverrides.mtfAlignmentPassed ?? false),
    missingGates: isCandidate
      ? []
      : (gateOverrides.missingGates ?? ['MTF_ALIGNMENT']),
    lastBlockingGate: isCandidate
      ? null
      : (gateOverrides.lastBlockingGate ?? 'MTF_ALIGNMENT'),
    nearMissStatus: isCandidate
      ? 'NOT_NEAR_CANDIDATE'
      : (gateOverrides.nearMissStatus ?? 'NEAR_MISS_ONE_GATE'),
    intendedDirection: dir,
    ...gateOverrides,
  });

  const structDir = dir === 'SHORT' ? 'BEAR' : 'BULL';
  return {
    symbol,
    timeframe: '15m',
    smcEvaluationStatus: 'EVALUATED',
    actionState,
    finalTradeSignal:
      actionState === 'LONG CANDIDATE'
        ? '多頭交易候選'
        : actionState === 'SHORT CANDIDATE'
          ? '空頭交易候選'
          : 'NONE',
    marketStructureBias: dir === 'SHORT' ? 'BEARISH' : 'BULLISH',
    confirmedKlineCount: 35,
    bosOrMss: {
      detected: gateEval.bosMssPassed,
      type: dir === 'SHORT' ? 'MSS_BEAR' : 'MSS_BULL',
      direction: structDir,
      breakPrice: 100,
      candleTime: 1793869200000,
      description: 'test',
    },
    liquiditySweep: {
      detected: gateEval.liquiditySweepPassed,
      side: dir === 'SHORT' ? 'BUY_SIDE_SWEPT' : 'SELL_SIDE_SWEPT',
      type: dir === 'SHORT' ? 'BUY_SIDE' : 'SELL_SIDE',
      sweptLevel: 99,
      candleTime: 1793869200000,
      description: 'test',
    },
    displacement: {
      detected: gateEval.displacementPassed,
      direction: structDir,
      bodyToAtrRatio: 2.1,
      candleTime: 1793869200000,
      description: 'test',
    },
    fvg: {
      detected: gateEval.fvgOrObPassed,
      direction: structDir,
      top: 100,
      bottom: 99,
      mitigated: false,
      candleTime: 1793869200000,
      description: 'test',
    },
    orderBlock: {
      detected: gateEval.fvgOrObPassed,
      direction: structDir,
      high: 99.5,
      low: 98.5,
      candleTime: 1793869200000,
      description: 'test',
    },
    mtfAlignment: {
      aligned: gateEval.mtfAlignmentPassed,
      dominantDirection: gateEval.mtfAlignmentPassed ? structDir : 'CONFLICT',
      byTimeframe: {
        '4h': gateEval.mtfAlignmentPassed ? structDir : 'NEUTRAL',
        '1h': structDir,
        '15m': structDir,
        '5m': structDir,
      },
      description: 'test',
    },
    atr14: 1.5,
    atrPercent: 1.1,
    currentPrice: 100,
    entryZoneLow: 99,
    entryZoneHigh: 100.5,
    invalidationPrice: dir === 'SHORT' ? 103 : 97,
    target1Price: dir === 'SHORT' ? 95 : 105,
    target2Price: dir === 'SHORT' ? 92 : 108,
    riskRewardRatio: 2.5,
    waitReasons: isCandidate ? [] : ['MTF_ALIGNMENT_NOT_CONFIRMED'],
    evidences: [],
    evaluatedAt: '2026-11-08T10:00:05.000Z',
    dataFetchedAt: '2026-11-08T10:00:04.000Z',
    source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
    ruleVersion: 'phase3-smc-v1.0',
    gateEvaluation: gateEval,
    nearMissStatus: gateEval.nearMissStatus,
    missingGates: gateEval.missingGates,
    intendedDirection: dir,
    provenance: {
      source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: '2026-11-08T10:00:05.000Z',
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
  } as unknown as SmcAnalysisResult;
}

test('Phase 18.2 Test 1, 2, 3: Current cycle vs historical signals never mix; RAYSOLUSDT/ALGOUSDT belong to OUTSIDE_CURRENT_CYCLE (within 30D/60D/90D window); ATOMUSDT belongs to OUTSIDE_MONITORING_WINDOW', () => {
  const dbPath = makeTempDbPath('historical-scopes');
  const db = new RadarDatabase(dbPath);
  // Ensure paper_tracked_signals schema exists
  new PaperMonitorDatabase(db);
  try {
    const exchange = 'binance_usdm';
    const cycleId = 'cycle_binance_usdm_p18_2_current';
    const nowIso = '2026-11-08T10:00:00.000Z';

    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      const analysis = makeConfirmedSmcAnalysis(sym, 'WAIT', {
        nearMissStatus: 'NOT_NEAR_CANDIDATE',
        missingGates: ['BOS_MSS', 'LIQUIDITY_SWEEP', 'MTF_ALIGNMENT'],
      });
      db.saveSmcScanResult({
        symbol: sym,
        exchange,
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WAIT',
        finalTradeSignal: 'NONE',
        marketRadarCategory: '準備觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: cycleId,
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        isDemo: false,
        ruleVersion: 'phase3-smc-v1.0',
        waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'],
        smcAnalysis: analysis,
      });
    }

    db.getRawDb()
      .prepare(
        `UPDATE smc_scan_meta SET scan_cycle_id = ?, updated_at = ? WHERE exchange = ?`
      )
      .run(cycleId, nowIso, exchange);

    const insertSignal = db.getRawDb().prepare(
      `INSERT INTO paper_tracked_signals (
        signal_id, monitor_run_id, scan_run_id, scan_cycle_id, database_instance_id,
        symbol, exchange, timeframe, direction, market_radar_category,
        smc_evaluation_status, smc_action_state, final_trade_signal, rule_version,
        snapshot_at, evaluated_at, signal_detected_at, signal_bar_open_time, signal_bar_close_time,
        original_entry_window_open_time, original_entry_window_close_time,
        status, entry_status, entry_window_status, status_reason,
        signal_latency_ms, detection_latency_ms, source, stale, fallback,
        missing_data_json, wait_reasons_json, evidences_json, decision_trace_json,
        is_demo, created_at, updated_at
      ) VALUES (?, 'mon_1', 'run_1', ?, 'db_1', ?, ?, '15m', ?, '雷達多頭觀察', 'EVALUATED', ?, ?, 'v1', ?, ?, ?, 1000, 1900, 2000, 2900, 'ENTRY_WINDOW_MISSED', 'ENTRY_WINDOW_MISSED', '原始進場窗口已錯過', 'MISSED', 1200, 1200, 'binance_usdm', 0, 0, '[]', '[]', '[]', '{}', 0, ?, ?)`
    );

    // 1. RAYSOLUSDT & ALGOUSDT inside 30D/60D/90D window (3 days ago), from previous cycle
    insertSignal.run(
      'sig_raysol_missed',
      'cycle_prev_01',
      'RAYSOLUSDT',
      exchange,
      'LONG',
      'LONG CANDIDATE',
      '多頭交易候選',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z'
    );
    insertSignal.run(
      'sig_algo_missed',
      'cycle_prev_01',
      'ALGOUSDT',
      exchange,
      'LONG',
      'LONG CANDIDATE',
      '多頭交易候選',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z'
    );

    // 2. ATOMUSDT older than 90D monitoring window (2025-10-29)
    insertSignal.run(
      'sig_atom_missed_old',
      'cycle_old_2025',
      'ATOMUSDT',
      exchange,
      'SHORT',
      'SHORT CANDIDATE',
      '空頭交易候選',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z'
    );

    const diag = db.computeCycleDiagnosticsAndFunnel(exchange);

    // Test 1: Current cycle and historical signals never mix
    assert.equal(diag.formalCandidateCount, 0);
    assert.equal(diag.currentCyclePaperEligibleCount, 0);
    assert.equal(diag.currentCycleEntryWindowMissedCount, 0);
    assert.equal(diag.monitoringWindowPaperEligibleCount, 2);
    assert.equal(diag.monitoringWindowEntryWindowMissedCount, 2);
    assert.equal(diag.cumulativePaperEligibleCount, 3);
    assert.equal(diag.cumulativeEntryWindowMissedCount, 3);
    assert.equal(diag.historicalSignalsOutsideWindowCount, 1);
    assert.equal(diag.historicalSignalsOutsideCurrentCycleCount, 2);

    // When formalCandidateCount === 0, all latency SLA metrics MUST be null (never 0)
    assert.equal(diag.formalCandidateLatencySla.formalCandidateCount, 0);
    assert.equal(diag.formalCandidateLatencySla.entryWindowMissedRate, null);
    assert.equal(
      diag.formalCandidateLatencySla.candidateDetectionLatencyP50,
      null
    );
    assert.equal(
      diag.formalCandidateLatencySla.candidateDetectionLatencyP95,
      null
    );
    assert.equal(diag.formalCandidateLatencySla.queueWaitP50, null);
    assert.equal(diag.formalCandidateLatencySla.queueWaitP95, null);

    // Test 2: RAYSOLUSDT and ALGOUSDT belong to OUTSIDE_CURRENT_CYCLE (and NOT outsideMonitoringWindow)
    const outsideCurrentCycleSymbols =
      diag.historicalSignalsOutsideCurrentCycle.signals.map((s) => s.symbol);
    assert.deepEqual(
      outsideCurrentCycleSymbols.sort(),
      ['ALGOUSDT', 'RAYSOLUSDT'].sort()
    );
    for (const sig of diag.historicalSignalsOutsideCurrentCycle.signals) {
      assert.equal(sig.historicalScope, 'OUTSIDE_CURRENT_CYCLE');
      assert.equal(sig.outsideCurrentCycle, true);
      assert.equal(sig.outsideMonitoringWindow, false);
    }

    // Test 3: ATOMUSDT belongs to OUTSIDE_MONITORING_WINDOW
    assert.equal(diag.historicalSignalsOutsideWindow.count, 1);
    const atomSig = diag.historicalSignalsOutsideWindow.signals[0];
    assert.ok(atomSig);
    assert.equal(atomSig.symbol, 'ATOMUSDT');
    assert.equal(atomSig.historicalScope, 'OUTSIDE_MONITORING_WINDOW');
    assert.equal(atomSig.outsideCurrentCycle, true);
    assert.equal(atomSig.outsideMonitoringWindow, true);
  } finally {
    db.close();
  }
});

test('Phase 18.2 Test 4 & 5: Near-Miss NEVER produces candidateDetectionLatencyMs or entryWindowMissed; ONLY formal LONG/SHORT CANDIDATE produces candidateDetectionLatencyMs and entryWindowMissed', () => {
  const nearMissGateEval = makeGateEval({
    bosMssPassed: true,
    liquiditySweepPassed: true,
    displacementPassed: true,
    fvgOrObPassed: true,
    mtfAlignmentPassed: false,
    missingGates: ['MTF_ALIGNMENT'],
    lastBlockingGate: 'MTF_ALIGNMENT',
    nearMissStatus: 'NEAR_MISS_ONE_GATE',
    intendedDirection: 'LONG',
  });

  const formalGateEval = makeGateEval({
    bosMssPassed: true,
    liquiditySweepPassed: true,
    displacementPassed: true,
    fvgOrObPassed: true,
    mtfAlignmentPassed: true,
    missingGates: [],
    lastBlockingGate: null,
    nearMissStatus: 'NOT_NEAR_CANDIDATE',
    intendedDirection: 'LONG',
  });

  const summary = buildSmcGateDiagnosticsSummary([
    {
      symbol: 'NEARMISSUSDT',
      smcActionState: 'WATCH',
      marketRadarCategory: '雷達多頭觀察',
      gateEvaluation: nearMissGateEval,
      evaluationLatencyMs: 42,
      nextBarRemainingMs: 180_000,
      candidateDetectionLatencyMs: null,
      entryWindowDelayMs: null,
      entryWindowMissed: null,
      isFastLane: true,
    },
    {
      symbol: 'FORMALUSDT',
      smcActionState: 'LONG CANDIDATE',
      marketRadarCategory: '雷達多頭觀察',
      gateEvaluation: formalGateEval,
      evaluationLatencyMs: 38,
      nextBarRemainingMs: 240_000,
      candidateDetectionLatencyMs: 320,
      entryWindowDelayMs: -240_000,
      entryWindowMissed: false,
      isFastLane: true,
    },
  ]);

  assert.equal(summary.nearMissSymbols.length, 1);
  const nmRecord = summary.nearMissSymbols[0] as unknown as Record<
    string,
    unknown
  >;
  assert.equal(nmRecord.symbol, 'NEARMISSUSDT');
  assert.equal(nmRecord.evaluationLatencyMs, 42);
  assert.equal(nmRecord.nextBarRemainingMs, 180_000);
  // Near-Miss MUST NOT contain detectionLatencyMs, candidateDetectionLatencyMs, entryWindowDelayMs, or entryWindowMissed
  assert.equal('detectionLatencyMs' in nmRecord, false);
  assert.equal('candidateDetectionLatencyMs' in nmRecord, false);
  assert.equal('entryWindowDelayMs' in nmRecord, false);
  assert.equal('entryWindowMissed' in nmRecord, false);

  // Also verify MarketScanner runMarketScan separates Near-Miss vs Formal Candidate fields
  const nowIso = '2026-11-08T10:02:00.000Z';
  const nextBarOpenMs = Date.parse('2026-11-08T10:15:00.000Z');
  const prov: DataProvenance = {
    source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
    fetchedAt: nowIso,
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
  const tickers: MarketTicker[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 95000,
      priceChangePercent24h: 4.5,
      quoteVolume24h: 500_000_000,
      bidPrice: 94999,
      askPrice: 95001,
      fundingRate: 0.0001,
      nextFundingTime: nextBarOpenMs,
      openInterest: 50000,
      openInterestValue: 4_750_000_000,
      provenance: prov,
    },
    {
      symbol: 'NEARMISSUSDT',
      baseAsset: 'NEARMISS',
      quoteAsset: 'USDT',
      lastPrice: 100,
      priceChangePercent24h: 6.2,
      quoteVolume24h: 80_000_000,
      bidPrice: 99.98,
      askPrice: 100.02,
      fundingRate: 0.0001,
      nextFundingTime: nextBarOpenMs,
      openInterest: 100000,
      openInterestValue: 10_000_000,
      provenance: prov,
    },
    {
      symbol: 'FORMALUSDT',
      baseAsset: 'FORMAL',
      quoteAsset: 'USDT',
      lastPrice: 200,
      priceChangePercent24h: 7.5,
      quoteVolume24h: 120_000_000,
      bidPrice: 199.98,
      askPrice: 200.02,
      fundingRate: 0.0001,
      nextFundingTime: nextBarOpenMs,
      openInterest: 100000,
      openInterestValue: 20_000_000,
      provenance: prov,
    },
  ];
  const histVolMap = new Map<string, number[]>([
    ['BTCUSDT', Array.from({ length: 35 }, (_, idx) => 20_000_000 + (idx % 7) * 500_000)],
    ['NEARMISSUSDT', Array.from({ length: 35 }, (_, idx) => 10_000_000 + (idx % 7) * 400_000)],
    ['FORMALUSDT', Array.from({ length: 35 }, (_, idx) => 15_000_000 + (idx % 7) * 500_000)],
  ]);
  const curVolMap = new Map<string, number>([
    ['BTCUSDT', 24_000_000],
    ['NEARMISSUSDT', 13_000_000],
    ['FORMALUSDT', 19_000_000],
  ]);

  const smcMap = new Map();
  smcMap.set('NEARMISSUSDT', {
    actionState: 'WATCH',
    smcEvaluationStatus: 'EVALUATED',
    waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'],
    evaluatedAt: nowIso,
    smcEvaluationCompletedAt: nowIso,
    nextBarOpenTime: nextBarOpenMs,
    detectionLatencyMs: 500, // Even if passed in raw cache, MarketScanner must null it for non-candidates
    smcEvaluationLatencyMs: 45,
    gateEvaluation: nearMissGateEval,
    smcAnalysis: makeConfirmedSmcAnalysis('NEARMISSUSDT', 'WATCH', nearMissGateEval),
  });
  smcMap.set('FORMALUSDT', {
    actionState: 'LONG CANDIDATE',
    smcEvaluationStatus: 'EVALUATED',
    waitReasons: [],
    evaluatedAt: nowIso,
    smcEvaluationCompletedAt: nowIso,
    nextBarOpenTime: nextBarOpenMs,
    detectionLatencyMs: 310,
    smcEvaluationLatencyMs: 39,
    gateEvaluation: formalGateEval,
    smcAnalysis: makeConfirmedSmcAnalysis(
      'FORMALUSDT',
      'LONG CANDIDATE',
      formalGateEval
    ),
  });

  const scanRes = runMarketScan(tickers, prov, {
    mode: 'live',
    exchange: 'binance_usdm',
    historicalVolumeMap: histVolMap,
    currentVolume15mMap: curVolMap,
    smcMap,
  });

  const nmCand = scanRes.candidates.find((c) => c.symbol === 'NEARMISSUSDT')!;
  assert.equal(nmCand.smcActionState, 'WATCH');
  assert.equal(nmCand.candidateDetectionLatencyMs, null);
  assert.equal(nmCand.detectionLatencyMs, null);
  assert.equal(nmCand.entryWindowDelayMs, null);
  assert.equal(nmCand.entryWindowMissed, null);
  assert.equal(nmCand.evaluationLatencyMs, 45);
  assert.equal(nmCand.nextBarRemainingMs, nextBarOpenMs - Date.parse(nowIso));

  const formalCand = scanRes.candidates.find((c) => c.symbol === 'FORMALUSDT')!;
  assert.equal(formalCand.smcActionState, 'LONG CANDIDATE');
  assert.equal(formalCand.candidateDetectionLatencyMs, 310);
  assert.equal(formalCand.entryWindowMissed, false);
  assert.equal(
    formalCand.entryWindowDelayMs,
    Date.parse(nowIso) - nextBarOpenMs
  );
});

test('Phase 18.2 Test 6 & 7 & Part 3: Reproducible LONG & SHORT CANDIDATE fixtures — detected before nextBar.openTime opens PAPER_OPENED; detected after nextBar.openTime marks ENTRY_WINDOW_MISSED with entryReferencePrice = null', () => {
  const dbPath = makeTempDbPath('entry-window-sla');
  const radarDb = new RadarDatabase(dbPath);
  const paperMonitorDb = new PaperMonitorDatabase(radarDb);
  const tracker = new SignalOutcomeTracker({ paperMonitorDb });

  try {
    const tfMs = 15 * 60 * 1000;
    const signalBarOpenMs = Date.parse('2026-11-08T10:00:00.000Z');
    const signalBarCloseMs = signalBarOpenMs + tfMs - 1;
    const nextBarOpenMs = signalBarOpenMs + tfMs; // 10:15:00.000Z
    const nextBarCloseMs = nextBarOpenMs + tfMs - 1;

    const signalBarKline: Kline = {
      openTime: signalBarOpenMs,
      closeTime: signalBarCloseMs,
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: 100_000,
      quoteVolume: 10_200_000,
      isClosed: true,
    };
    const nextBarKline: Kline = {
      openTime: nextBarOpenMs,
      closeTime: nextBarCloseMs,
      open: 102.5,
      high: 104,
      low: 101.8,
      close: 103.5,
      volume: 95_000,
      quoteVolume: 9_800_000,
      isClosed: true,
    };

    const prov: DataProvenance = {
      source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
      fetchedAt: '2026-11-08T10:14:55.500Z',
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };

    // Case A (Test 6): LONG CANDIDATE detected at 10:14:56.000Z (< nextBarOpenMs 10:15:00.000Z)
    // First register when only signalBar is closed -> CREATED + PENDING_NEXT_ENTRY
    const detectedBeforeIso = '2026-11-08T10:14:56.000Z';
    const createdLong = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mon_p18_2',
      scanRunId: 'scan_p18_2',
      scanCycleId: 'cycle_p18_2',
      symbol: 'LONGTIMELYUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: detectedBeforeIso,
      evaluatedAt: detectedBeforeIso,
      signalDetectedAt: detectedBeforeIso,
      klines: [signalBarKline],
      atr14: 1.5,
      openInterest: 50_000,
      fundingRate: 0.0001,
      provenance: prov,
      waitReasons: [],
      evidences: [],
      score: 88,
    });

    assert.ok(createdLong.signal);
    assert.equal(createdLong.signal.status, 'CREATED');
    assert.equal(createdLong.signal.entryStatus, 'PENDING_NEXT_ENTRY');
    assert.equal(createdLong.signal.entryReferencePrice, null);

    // Now nextBar (10:15) closes -> transitions to PAPER_OPENED with entryReferencePrice = nextBar.open (102.5)
    const settledLong = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mon_p18_2',
      scanRunId: 'scan_p18_2',
      scanCycleId: 'cycle_p18_2',
      symbol: 'LONGTIMELYUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: '2026-11-08T10:30:01.000Z',
      evaluatedAt: detectedBeforeIso,
      signalDetectedAt: detectedBeforeIso,
      klines: [signalBarKline, nextBarKline],
      atr14: 1.5,
      openInterest: 50_000,
      fundingRate: 0.0001,
      provenance: prov,
      waitReasons: [],
      evidences: [],
      score: 88,
      signalBarIndex: 0,
    });

    assert.ok(settledLong.signal);
    assert.equal(settledLong.signal.status, 'PAPER_OPENED');
    assert.equal(settledLong.signal.entryStatus, 'PAPER_OPENED');
    assert.equal(settledLong.signal.entryReferencePrice, 102.5);
    assert.equal(
      settledLong.signal.entryReferenceTime,
      new Date(nextBarOpenMs).toISOString()
    );
    assert.ok(settledLong.signal.paperLedgerId);

    // Case B (Test 7): SHORT CANDIDATE detected at 10:15:02.000Z (>= nextBarOpenMs 10:15:00.000Z)
    // MUST mark ENTRY_WINDOW_MISSED and entryReferencePrice MUST remain null (never retroactively use nextBar.open)
    const detectedLateIso = '2026-11-08T10:15:02.000Z';
    const missedShort = tracker.evaluateAndTrackSignal({
      monitorRunId: 'mon_p18_2',
      scanRunId: 'scan_p18_2',
      scanCycleId: 'cycle_p18_2',
      symbol: 'SHORTLATEUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達空頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'SHORT CANDIDATE',
      finalTradeSignal: '空頭交易候選',
      snapshotAt: detectedLateIso,
      evaluatedAt: detectedLateIso,
      signalDetectedAt: detectedLateIso,
      klines: [signalBarKline, nextBarKline],
      atr14: 1.5,
      openInterest: 50_000,
      fundingRate: 0.0001,
      provenance: prov,
      waitReasons: [],
      evidences: [],
      score: 86,
      signalBarIndex: 0,
    });

    assert.ok(missedShort.signal);
    assert.equal(missedShort.signal.status, 'ENTRY_WINDOW_MISSED');
    assert.equal(missedShort.signal.entryStatus, 'ENTRY_WINDOW_MISSED');
    assert.equal(missedShort.signal.entryReferencePrice, null);
    assert.equal(missedShort.signal.entryReferenceTime, null);
    assert.equal(missedShort.signal.paperLedgerId, null);
  } finally {
    radarDb.close();
  }
});

test('Phase 18.2 Test 8 & Part 2/4: Formal Candidate SLA (Fast Lane vs Bulk P50/P95) and Strict vs Shadow Mode separation (paperClosedCount = 0 -> null performance fields)', () => {
  const dbPath = makeTempDbPath('sla-and-shadow');
  const db = new RadarDatabase(dbPath);
  try {
    const exchange = 'binance_usdm';
    const cycleId = 'cycle_binance_usdm_sla_test';
    const nowIso = '2026-11-08T10:10:00.000Z';
    const nextBarOpenMs = Date.parse('2026-11-08T10:15:00.000Z');

    // 1. Fast Lane formal LONG CANDIDATE (detected before nextBar.openTime)
    db.saveSmcScanResult({
      symbol: 'FASTLONGUSDT',
      exchange,
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      marketRadarCategory: '雷達多頭觀察',
      evaluatedAt: nowIso,
      dataFetchedAt: nowIso,
      fetchedAt: nowIso,
      scanCycleId: cycleId,
      priorityTier: 1,
      priorityClass: 'FAST_LANE',
      isFastLane: true,
      queueEnteredAt: '2026-11-08T10:09:59.500Z',
      smcEvaluationStartedAt: '2026-11-08T10:09:59.700Z',
      smcEvaluationCompletedAt: nowIso,
      queueWaitMs: 200,
      smcEvaluationLatencyMs: 300,
      evaluationLatencyMs: 300,
      detectionLatencyMs: 500,
      candidateDetectionLatencyMs: 500,
      signalBarCloseTime: Date.parse('2026-11-08T10:00:00.000Z') - 1,
      nextBarOpenTime: nextBarOpenMs,
      entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
      stale: false,
      fallback: false,
      missingData: [],
      source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
      isDemo: false,
      ruleVersion: 'phase3-smc-v1.0',
      waitReasons: [],
      smcAnalysis: makeConfirmedSmcAnalysis('FASTLONGUSDT', 'LONG CANDIDATE'),
    });

    // 2. Bulk formal SHORT CANDIDATE (missed entry window)
    db.saveSmcScanResult({
      symbol: 'BULKSHORTUSDT',
      exchange,
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'SHORT CANDIDATE',
      finalTradeSignal: '空頭交易候選',
      marketRadarCategory: '雷達空頭觀察',
      evaluatedAt: '2026-11-08T10:15:05.000Z',
      dataFetchedAt: '2026-11-08T10:15:04.000Z',
      fetchedAt: '2026-11-08T10:15:04.000Z',
      scanCycleId: cycleId,
      priorityTier: 6,
      priorityClass: 'BULK',
      isFastLane: false,
      queueEnteredAt: '2026-11-08T10:14:50.000Z',
      smcEvaluationStartedAt: '2026-11-08T10:15:04.000Z',
      smcEvaluationCompletedAt: '2026-11-08T10:15:05.000Z',
      queueWaitMs: 14_000,
      smcEvaluationLatencyMs: 1000,
      evaluationLatencyMs: 1000,
      detectionLatencyMs: 15_000,
      candidateDetectionLatencyMs: 15_000,
      signalBarCloseTime: Date.parse('2026-11-08T10:00:00.000Z') - 1,
      nextBarOpenTime: nextBarOpenMs,
      entryWindowStatus: 'ENTRY_WINDOW_MISSED',
      stale: false,
      fallback: false,
      missingData: [],
      source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
      isDemo: false,
      ruleVersion: 'phase3-smc-v1.0',
      waitReasons: [],
      smcAnalysis: makeConfirmedSmcAnalysis('BULKSHORTUSDT', 'SHORT CANDIDATE'),
    });

    // 3. Near-Miss WATCH symbol (1 gate missing)
    db.saveSmcScanResult({
      symbol: 'SHADOW1USDT',
      exchange,
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'WATCH',
      finalTradeSignal: 'NONE',
      marketRadarCategory: '雷達多頭觀察',
      evaluatedAt: nowIso,
      dataFetchedAt: nowIso,
      fetchedAt: nowIso,
      scanCycleId: cycleId,
      priorityTier: 2,
      priorityClass: 'FAST_LANE',
      isFastLane: true,
      queueWaitMs: 150,
      smcEvaluationLatencyMs: 250,
      detectionLatencyMs: 400,
      nextBarOpenTime: nextBarOpenMs,
      entryWindowStatus: 'NOT_APPLICABLE',
      stale: false,
      fallback: false,
      missingData: [],
      source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
      isDemo: false,
      ruleVersion: 'phase3-smc-v1.0',
      waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'],
      smcAnalysis: makeConfirmedSmcAnalysis('SHADOW1USDT', 'WATCH'),
    });

    db.getRawDb()
      .prepare(
        `UPDATE smc_scan_meta SET scan_cycle_id = ?, updated_at = ? WHERE exchange = ?`
      )
      .run(cycleId, nowIso, exchange);

    const diag = db.computeCycleDiagnosticsAndFunnel(exchange);
    const sla = diag.formalCandidateLatencySla;

    assert.equal(sla.formalCandidateCount, 2);
    assert.equal(sla.fastLaneFormalCandidateCount, 1);
    assert.equal(sla.bulkFormalCandidateCount, 1);
    assert.equal(sla.candidateDetectedBeforeEntryWindowCount, 1);
    assert.equal(sla.entryWindowMissedCount, 1);
    assert.equal(sla.entryWindowMissedRate, 0.5);
    assert.equal(sla.fastLaneCandidateDetectionLatencyP50, 500);
    assert.equal(sla.bulkCandidateDetectionLatencyP50, 15_000);
    assert.equal(sla.fastLaneQueueWaitP50, 200);
    assert.equal(sla.bulkQueueWaitP50, 14_000);

    // Shadow mode comparison separation (Test 8)
    const shadow = diag.observationShadowComparison;
    assert.equal(shadow.strictProduction.candidateCount, 2);
    assert.equal(shadow.strictProduction.nearMissCount, 1);
    assert.equal(shadow.strictProduction.entryWindowMissedCount, 1);
    assert.equal(shadow.strictProduction.paperOpenedCount, 1);
    assert.equal(shadow.strictProduction.paperClosedCount, 0);
    // When paperClosedCount === 0, all performance metrics MUST be null
    assert.equal(shadow.strictProduction.winRate, null);
    assert.equal(shadow.strictProduction.averageR, null);
    assert.equal(shadow.strictProduction.profitFactor, null);
    assert.equal(shadow.strictProduction.maxDrawdownR, null);
    assert.equal(shadow.strictProduction.expectancyR, null);

    // Shadow 1-gate missing includes SHADOW1USDT in observation only, NEVER opens paper or sends notifications
    assert.equal(shadow.observationShadowOneGateMissing.candidateCount, 3);
    assert.equal(shadow.observationShadowOneGateMissing.nearMissCount, 1);
    assert.equal(shadow.observationShadowOneGateMissing.paperOpenedCount, 0);
    assert.equal(shadow.observationShadowOneGateMissing.paperClosedCount, 0);
    assert.equal(shadow.observationShadowOneGateMissing.winRate, null);
    assert.equal(shadow.observationShadowOneGateMissing.averageR, null);
    assert.equal(shadow.observationShadowOneGateMissing.profitFactor, null);
    assert.equal(shadow.observationShadowOneGateMissing.maxDrawdownR, null);
    assert.equal(shadow.observationShadowOneGateMissing.expectancyR, null);
  } finally {
    db.close();
  }
});

test('Phase 18.2 Test 9, 10, 11, 12: API cycleId/snapshotAt/statsVersion consistency, HTTP 404 on all order endpoints, externalNotificationCount = 0, and PAPER ONLY safety flags', async () => {
  const dbPath = makeTempDbPath('api-consistency');
  const nowIso = '2026-11-08T10:00:00.000Z';
  const tickers: MarketTicker[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 95000,
      priceChangePercent24h: 4.2,
      quoteVolume24h: 500_000_000,
      bidPrice: 94999,
      askPrice: 95001,
      fundingRate: 0.0001,
      nextFundingTime: Date.parse(nowIso) + 900_000,
      openInterest: 10000,
      openInterestValue: 950_000_000,
      provenance: {
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    },
  ];

  const stubAdapter: ExchangeAdapter = {
    id: 'binance_usdm',
    displayName: 'Binance USDⓈ-M Stub',
    isDemo: false,
    enabled: true,
    status: 'LIVE',
    fetchMarketSnapshot: async () => ({
      tickers,
      provenance: {
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    }),
    fetchKlines: async () => ({
      klines: [],
      provenance: {
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    }),
    fetchOpenInterest: async () => ({
      openInterest: 1000,
      openInterestValue: 95_000_000,
      provenance: {
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    }),
  };

  const app = await createApp({
    skipViteMiddleware: true,
    customDbPath: dbPath,
    customAdapters: {
      binance_usdm: stubAdapter,
      bybit_linear: stubAdapter,
      bingx_swap: stubAdapter,
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${baseUrl}/api/scan?mode=live&exchange=binance_usdm`);
    await fetch(`${baseUrl}/api/smc-scan/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: 'binance_usdm' }),
    });

    const scanRes = await fetch(
      `${baseUrl}/api/scan?mode=live&exchange=binance_usdm&autoStartSmc=false`
    ).then((r) => r.json());
    const [smcStatusRes, monitorStatusRes, gateDriftRes] = await Promise.all([
      fetch(
        `${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`
      ).then((r) => r.json()),
      fetch(
        `${baseUrl}/api/paper-monitor/status?exchange=binance_usdm`
      ).then((r) => r.json()),
      fetch(
        `${baseUrl}/api/paper-quality/gate-drift?exchange=binance_usdm`
      ).then((r) => r.json()),
    ]);

    // Test 9: cycleId, snapshotAt, statsVersion consistency across all 4 endpoints
    assert.equal(scanRes.cycleId, smcStatusRes.cycleId);
    assert.equal(scanRes.cycleId, monitorStatusRes.cycleId);
    assert.equal(scanRes.cycleId, gateDriftRes.cycleId);

    assert.equal(scanRes.statsVersion, smcStatusRes.statsVersion);
    assert.equal(scanRes.statsVersion, monitorStatusRes.statsVersion);
    assert.equal(scanRes.statsVersion, gateDriftRes.statsVersion);

    assert.equal(scanRes.snapshotAt, smcStatusRes.snapshotAt);
    assert.equal(scanRes.snapshotAt, monitorStatusRes.snapshotAt);
    assert.equal(scanRes.snapshotAt, gateDriftRes.snapshotAt);

    // Test 10: All order endpoints return HTTP 404
    const orderPaths = [
      '/api/order',
      '/api/orders',
      '/api/trade',
      '/api/execute',
      '/api/binance/order',
    ];
    for (const p of orderPaths) {
      const res = await fetch(`${baseUrl}${p}`, { method: 'POST' });
      assert.equal(res.status, 404, `Expected ${p} to return HTTP 404`);
    }

    // Test 11: externalNotificationCount remains 0
    assert.equal(monitorStatusRes.externalNotificationCount, 0);
    assert.equal(monitorStatusRes.externalTelegramRequestsCount, 0);
    assert.equal(monitorStatusRes.externalTradingViewRequestsCount, 0);

    // Test 12: PAPER ONLY, LIVE ORDERS DISABLED, NEVER AUTO-PLACE ORDERS
    assert.equal(scanRes.safety.mode, 'PAPER ONLY');
    assert.equal(scanRes.safety.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(scanRes.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
    assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
    assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(
      TRADING_SAFETY_FLAGS.executionPolicy,
      'NEVER AUTO-PLACE ORDERS'
    );
  } finally {
    server.close();
  }
});
