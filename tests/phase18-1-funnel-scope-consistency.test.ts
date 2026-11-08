import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExchangeAdapter } from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import {
  buildSmcGateDiagnosticsSummary,
  EvaluatedGateDiagnosticItemInput,
  validateScopedFunnelConsistency,
} from '../server/engine/SmcRuleEngine.ts';
import { createApp } from '../server.ts';
import {
  MarketTicker,
  SymbolSmcGateEvaluation,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function makeTempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radar-${prefix}-`));
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
    intendedDirection: 'LONG',
    nearMissStatus: 'NOT_NEAR_CANDIDATE',
    missingGates: [
      'BOS_MSS',
      'LIQUIDITY_SWEEP',
      'DISPLACEMENT',
      'FVG_OR_ORDER_BLOCK',
      'MTF_ALIGNMENT',
    ],
    lastBlockingGate: 'MTF_ALIGNMENT',
    waitReasons: ['等待多週期結構確認'],
    ...overrides,
  };
}

// 1. 522 vs 480 分母差異與 42 檔排除原因測試
test('Phase 18.1 Test 1: 522 vs 480 denominator difference tracks exact 42 excluded symbols and reasons', () => {
  const rawItems: EvaluatedGateDiagnosticItemInput[] = [];
  const excludedSymbolsList: string[] = [];

  for (let i = 1; i <= 522; i++) {
    const sym = `SYM${String(i).padStart(3, '0')}USDT`;
    if (i <= 480) {
      rawItems.push({
        symbol: sym,
        smcActionState: i <= 30 ? 'WATCH' : 'WAIT',
        marketRadarCategory: i <= 30 ? '雷達多頭觀察' : '準備觀察',
        gateEvaluation: makeGateEval(
          i <= 12
            ? {
                bosMssPassed: true,
                liquiditySweepPassed: true,
                displacementPassed: true,
                fvgOrObPassed: true,
                mtfAlignmentPassed: false,
                nearMissStatus: 'NEAR_MISS_ONE_GATE',
                missingGates: ['MTF_ALIGNMENT'],
                lastBlockingGate: 'MTF_ALIGNMENT',
              }
            : i <= 20
              ? {
                  bosMssPassed: true,
                  liquiditySweepPassed: true,
                  displacementPassed: false,
                  fvgOrObPassed: true,
                  mtfAlignmentPassed: false,
                  nearMissStatus: 'NEAR_MISS_TWO_GATES',
                  missingGates: ['DISPLACEMENT', 'MTF_ALIGNMENT'],
                  lastBlockingGate: 'MTF_ALIGNMENT',
                }
              : {}
        ),
      });
    } else {
      excludedSymbolsList.push(sym);
      rawItems.push({
        symbol: sym,
        smcActionState: 'WAIT',
        marketRadarCategory: '準備觀察',
        gateEvaluation: makeGateEval(),
        excludedFromDenominator: true,
        exclusionReason:
          i <= 500
            ? 'PENDING_WAITING_FOR_NEXT_BATCH'
            : 'PENDING_REQUEUED_PRIORITY_REFRESH',
      });
    }
  }

  const diag = buildSmcGateDiagnosticsSummary(rawItems, {
    totalUniverseSymbols: 522,
    cycleId: 'cycle_522_vs_480_test',
    snapshotAt: '2026-11-05T09:30:00.000Z',
    statsVersion: 500,
    aggregationScope: 'CURRENT_CYCLE',
  });

  assert.equal(diag.evaluationUniverseSize, 522);
  assert.equal(diag.evaluatedDenominator, 480);
  assert.equal(diag.excludedCount, 42);
  assert.equal(diag.excludedSymbols.length, 42);
  assert.deepEqual(diag.excludedSymbols, excludedSymbolsList);
  assert.equal(diag.excludedReasons.PENDING_WAITING_FOR_NEXT_BATCH, 20);
  assert.equal(diag.excludedReasons.PENDING_REQUEUED_PRIORITY_REFRESH, 22);
  const sumExcludedReasons = Object.values(diag.excludedReasons).reduce(
    (a, b) => a + b,
    0
  );
  assert.equal(sumExcludedReasons, 42);
  assert.equal(
    diag.scopedGateStatistics.allEvaluated.MTF_ALIGNMENT.evaluationUniverseSize,
    522
  );
  assert.equal(
    diag.scopedGateStatistics.allEvaluated.MTF_ALIGNMENT.evaluatedDenominator,
    480
  );
  assert.equal(
    diag.scopedGateStatistics.allEvaluated.MTF_ALIGNMENT.excludedCount,
    42
  );
});

// 2, 3, 4. 歷史 Paper 訊號不得混入 currentCycleFunnel / candidateDetected=0 時 currentCyclePaperEligible=0 / ENTRY_WINDOW_MISSED 週期與窗口分離測試
test('Phase 18.1 Tests 2, 3 & 4: Historical Paper signals excluded from currentCycleFunnel; candidateDetected=0 enforces currentCyclePaperEligibleCount=0; ENTRY_WINDOW_MISSED separated across currentCycle (0), monitoringWindow (2), and cumulative/historical (3)', async () => {
  const { PaperMonitorDatabase } = await import(
    '../server/db/PaperMonitorDatabase.ts'
  );
  const dbPath = makeTempDbPath('p18-1-scope');
  const db = new RadarDatabase(dbPath);
  new PaperMonitorDatabase(db);
  try {
    const exchange = 'binance_usdm';
    const cycleId =
      'cycle_binance_usdm_win_1793869200000_warm_v1.0.0-smc-ict-deterministic';
    const nowIso = '2026-11-05T09:20:00.000Z';

    // Seed 10 evaluated symbols with 0 candidates (WAIT / WATCH / HIGH RISK)
    const symbols = [
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
      'BNBUSDT',
      'XRPUSDT',
      'ADAUSDT',
      'DOGEUSDT',
      'AVAXUSDT',
      'LINKUSDT',
      'DOTUSDT',
    ];
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      db.getRawDb()
        .prepare(
          `INSERT INTO smc_scan_jobs (symbol, exchange, priority, priority_tier, priority_label, priority_class, status, rule_version, window_key, requested_at, started_at, completed_at, is_fast_lane, execution_worker)
           VALUES (?, ?, 50000, 1, '1_WATCHLIST', 'FAST_LANE', 'SUCCEEDED', 'v1.0.0-smc-ict-deterministic', 'win_15m', ?, ?, ?, 1, 'FAST_LANE_WORKER')`
        )
        .run(sym, exchange, nowIso, nowIso, nowIso);

      const actionState = i < 3 ? 'WATCH' : i === 9 ? 'HIGH RISK' : 'WAIT';
      const gateEval = makeGateEval(
        i === 0
          ? {
              bosMssPassed: true,
              liquiditySweepPassed: true,
              displacementPassed: true,
              fvgOrObPassed: true,
              mtfAlignmentPassed: false,
              nearMissStatus: 'NEAR_MISS_ONE_GATE',
              missingGates: ['MTF_ALIGNMENT'],
              lastBlockingGate: 'MTF_ALIGNMENT',
            }
          : i === 1
            ? {
                bosMssPassed: true,
                liquiditySweepPassed: true,
                displacementPassed: false,
                fvgOrObPassed: true,
                mtfAlignmentPassed: false,
                nearMissStatus: 'NEAR_MISS_TWO_GATES',
                missingGates: ['DISPLACEMENT', 'MTF_ALIGNMENT'],
                lastBlockingGate: 'MTF_ALIGNMENT',
              }
            : {}
      );

      db.saveSmcScanResult({
        symbol: sym,
        exchange,
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: actionState,
        finalTradeSignal: 'NONE',
        marketRadarCategory: i < 3 ? '雷達多頭觀察' : '準備觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        isDemo: false,
        ruleVersion: 'v1.0.0-smc-ict-deterministic',
        waitReasons: ['等待多週期結構確認'],
        scanCycleId: cycleId,
        smcAnalysis: {
          symbol: sym,
          primaryTimeframe: '15m',
          evaluatedAt: nowIso,
          ruleVersion: 'v1.0.0-smc-ict-deterministic',
          smcEvaluationStatus: 'EVALUATED',
          actionState,
          confirmedKlineCount: 45,
          unclosedKlineIgnoredCount: 1,
          bosOrMss: {
            detected: gateEval.bosMssPassed,
            type: gateEval.bosMssPassed ? 'BOS_BULL' : 'NONE',
            brokenLevel: 100,
            candleTime: 1793869200000,
            description: 'test',
          },
          liquiditySweep: {
            detected: gateEval.liquiditySweepPassed,
            side: gateEval.liquiditySweepPassed ? 'SELL_SIDE_SWEPT' : 'NONE',
            sweptLevel: 98,
            candleTime: 1793869200000,
            description: 'test',
          },
          displacement: {
            detected: gateEval.displacementPassed,
            direction: 'BULL',
            bodyToAtrRatio: 2,
            candleTime: 1793869200000,
            description: 'test',
          },
          fvg: {
            detected: gateEval.fvgOrObPassed,
            direction: 'BULL',
            top: 100,
            bottom: 99,
            mitigated: false,
            candleTime: 1793869200000,
            description: 'test',
          },
          orderBlock: {
            detected: gateEval.fvgOrObPassed,
            direction: 'BULL',
            high: 99.5,
            low: 98.5,
            candleTime: 1793869200000,
            description: 'test',
          },
          mtfAlignment: {
            aligned: gateEval.mtfAlignmentPassed,
            dominantDirection: gateEval.mtfAlignmentPassed ? 'BULL' : 'CONFLICT',
            byTimeframe: {
              '4h': 'NEUTRAL',
              '1h': 'BULL',
              '15m': 'BULL',
              '5m': 'BULL',
            },
            description: 'test',
          },
          atr14: 1.25,
          atrPercent: 1.1,
          evidences: [],
          waitReasons: ['等待多週期結構確認'],
          gateEvaluation: gateEval,
          provenance: {
            source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
            fetchedAt: nowIso,
            stale: false,
            fallback: false,
            missingData: [],
            isDemo: false,
          },
        },
      });
    }

    db.getRawDb()
      .prepare(
        `UPDATE smc_scan_meta SET scan_cycle_id = ?, updated_at = ? WHERE exchange = ?`
      )
      .run(cycleId, nowIso, exchange);

    // Insert 3 historical signals into paper_tracked_signals:
    // 1. ATOMUSDT from 2025-10-29 (>1 year old, outside 30d/60d/90d monitoring window)
    // 2. RAYSOLUSDT from 2026-11-05T09:08:51.746Z (inside 30d/60d/90d monitoring window, prior 15m bar)
    // 3. ALGOUSDT from 2026-11-05T09:08:52.585Z (inside 30d/60d/90d monitoring window, prior 15m bar)
    const insertSignalStmt = db.getRawDb().prepare(`
      INSERT INTO paper_tracked_signals (
        signal_id, monitor_run_id, scan_run_id, scan_cycle_id, database_instance_id, symbol, exchange, timeframe,
        direction, market_radar_category, smc_evaluation_status, smc_action_state, final_trade_signal,
        rule_version, snapshot_at, status, status_reason, entry_status, signal_detected_at, evaluated_at,
        signal_bar_open_time, signal_bar_close_time, original_entry_window_open_time, is_demo, stale, fallback, source,
        missing_data_json, wait_reasons_json, evidences_json, created_at, updated_at
      ) VALUES (?, 'mrun_1', 'srun_1', ?, 'db_inst_1', ?, ?, '15m', ?, '雷達多頭觀察', 'EVALUATED', ?, ?, 'v1.0.0-smc-ict-deterministic', ?, 'ENTRY_WINDOW_MISSED', 'MISSED', 'ENTRY_WINDOW_MISSED', ?, ?, ?, ?, ?, 0, 0, 0, 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)', '[]', '[]', '[]', ?, ?)
    `);

    insertSignalStmt.run(
      'sig_atom_2025',
      'cycle_binance_usdm_win_1792897200000_v1.0.0-smc-ict-deterministic_3f4ag8',
      'ATOMUSDT',
      exchange,
      'SHORT',
      'SHORT CANDIDATE',
      '空頭交易候選',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z',
      1761706800000,
      1761707700000,
      1761707700000,
      '2025-10-29T03:14:46.639Z',
      '2025-10-29T03:14:46.639Z'
    );
    insertSignalStmt.run(
      'sig_raysol_2026',
      cycleId,
      'RAYSOLUSDT',
      exchange,
      'LONG',
      'LONG CANDIDATE',
      '多頭交易候選',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z',
      1793868300000,
      1793869200000,
      1793869200000,
      '2026-11-05T09:08:51.746Z',
      '2026-11-05T09:08:51.746Z'
    );
    insertSignalStmt.run(
      'sig_algo_2026',
      cycleId,
      'ALGOUSDT',
      exchange,
      'SHORT',
      'SHORT CANDIDATE',
      '空頭交易候選',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z',
      1793868300000,
      1793869200000,
      1793869200000,
      '2026-11-05T09:08:52.585Z',
      '2026-11-05T09:08:52.585Z'
    );

    const diag = db.computeCycleDiagnosticsAndFunnel(exchange);

    // Test 2 & 3: Current cycle has 0 candidates -> currentCyclePaperEligibleCount MUST be 0, currentCycleEntryWindowMissedCount MUST be 0
    assert.equal(diag.candidateDetectedCount, 0);
    assert.equal(diag.currentCyclePaperEligibleCount, 0);
    assert.equal(diag.eligiblePaperSignalCount, 0);
    assert.equal(diag.currentCycleEntryWindowMissedCount, 0);
    assert.equal(diag.entryWindowMissedCount, 0);
    assert.equal(diag.currentCycleFunnel.candidateDetectedCount, 0);
    assert.equal(diag.currentCycleFunnel.paperEligibleCount, 0);
    assert.equal(diag.currentCycleFunnel.entryWindowMissedCount, 0);
    assert.equal(diag.currentCycleFunnel.statsConsistency, 'VALID');
    assert.equal(diag.latestSnapshotFunnel.candidateDetectedCount, 0);
    assert.equal(diag.latestSnapshotFunnel.paperEligibleCount, 0);
    assert.equal(diag.latestSnapshotFunnel.entryWindowMissedCount, 0);
    assert.equal(diag.latestSnapshotFunnel.statsConsistency, 'VALID');

    // Test 4: Monitoring window (30d/60d/90d) has 2 missed signals (RAYSOLUSDT, ALGOUSDT), while cumulative/historical has 3 (including ATOMUSDT from 2025-10-29)
    assert.equal(diag.monitoringWindowEntryWindowMissedCount, 2);
    assert.equal(diag.monitoringWindowFunnel.entryWindowMissedCount, 2);
    assert.equal(diag.monitoringWindowFunnel.paperEligibleCount, 2);
    assert.equal(diag.monitoringWindowFunnel.candidateDetectedCount, 2);
    assert.equal(diag.monitoringWindowFunnel.statsConsistency, 'VALID');

    assert.equal(diag.historicalPaperEligibleCount, 3);
    assert.equal(diag.cumulativeEntryWindowMissedCount, 3);
    assert.equal(diag.cumulativeFunnel.entryWindowMissedCount, 3);
    assert.equal(diag.cumulativeFunnel.paperEligibleCount, 3);
    assert.equal(diag.cumulativeFunnel.candidateDetectedCount, 3);
    assert.equal(diag.cumulativeFunnel.statsConsistency, 'VALID');

    assert.equal(diag.historicalSignalsOutsideCurrentCycle.count, 2);
    assert.equal(diag.historicalSignalsOutsideCurrentCycle.entryWindowMissedCount, 2);
    assert.equal(diag.historicalSignalsOutsideCurrentCycle.paperEligibleCount, 2);
    assert.equal(diag.historicalSignalsOutsideCurrentCycle.statsConsistency, 'VALID');

    assert.equal(diag.historicalSignalsOutsideWindow.count, 1);
    assert.equal(diag.historicalSignalsOutsideWindow.entryWindowMissedCount, 1);
    assert.equal(diag.historicalSignalsOutsideWindow.paperEligibleCount, 1);
    assert.equal(diag.historicalSignalsOutsideWindow.statsConsistency, 'VALID');

    // Also verify validateScopedFunnelConsistency rejects paperEligibleCount > candidateDetectedCount
    const invalidCheck = validateScopedFunnelConsistency({
      cycleId,
      snapshotAt: nowIso,
      statsVersion: 1,
      aggregationScope: 'CURRENT_CYCLE',
      evaluationUniverseSize: 10,
      evaluatedDenominator: 10,
      excludedCount: 0,
      excludedSymbols: [],
      excludedReasons: {},
      totalSymbols: 10,
      evaluatedCount: 10,
      pendingCount: 0,
      failedCount: 0,
      rateLimitedCount: 0,
      waitCount: 6,
      watchCount: 3,
      highRiskCount: 1,
      longCandidateCount: 0,
      shortCandidateCount: 0,
      nearMissCount: 2,
      nearMissOneGateCount: 1,
      nearMissTwoGatesCount: 1,
      candidateDetectedCount: 0,
      paperEligibleCount: 3,
      paperOpenedCount: 0,
      paperClosedCount: 0,
      entryWindowMissedCount: 3,
    });
    assert.equal(invalidCheck.statsConsistency, 'INVALID');
    assert.ok(invalidCheck.consistencyErrors.length >= 2);
  } finally {
    db.close();
  }
});

// 5, 6, 7, 8, 9, 10. Multi-endpoint snapshot consistency, Near-Miss denominator match, Live/Demo/Shadow isolation, 404 order endpoints, externalNotificationCount=0, safety flags
test('Phase 18.1 Tests 5, 6, 7, 8, 9 & 10: /api/scan, /api/smc-scan/status, /api/paper-monitor/status, /api/paper-quality/gate-drift share identical snapshotAt/statsVersion/cycleId, Near-Miss matches gate-drift denominator, Live/Demo/Shadow isolation, HTTP 404 order endpoints, externalNotificationCount=0, PAPER ONLY flags', async () => {
  const dbPath = makeTempDbPath('p18-1-api');
  const nowIso = '2026-11-05T09:25:00.000Z';

  const mockTickers: MarketTicker[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 70000,
      priceChangePercent24h: 4.2,
      quoteVolume24h: 1_500_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      bidPrice: 69999.5,
      askPrice: 70000.5,
      spread: 1.0,
      spreadPercent: 0.0014,
      openInterest: 85000,
      openInterestValue: 5_950_000_000,
      provenance: {
        source: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      lastPrice: 3500,
      priceChangePercent24h: 5.8,
      quoteVolume24h: 900_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      bidPrice: 3499.8,
      askPrice: 3500.2,
      spread: 0.4,
      spreadPercent: 0.011,
      openInterest: 400000,
      openInterestValue: 1_400_000_000,
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

  const klineBars = Array.from({ length: 45 }, (_, idx) => {
    const openTime = 1793869200000 - (45 - idx) * 900_000;
    return {
      openTime,
      closeTime: openTime + 899_999,
      open: 100 + idx * 0.2,
      high: 101 + idx * 0.2,
      low: 99 + idx * 0.2,
      close: 100.1 + idx * 0.2,
      volume: 1000,
      quoteVolume: 100_000,
      isClosed: true,
    };
  });

  const mockLiveAdapter: ExchangeAdapter = {
    id: 'binance_usdm',
    displayName: 'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      return {
        tickers: mockTickers,
        provenance: mockTickers[0].provenance,
      };
    },
    async fetchKlines() {
      return {
        klines: klineBars,
        provenance: mockTickers[0].provenance,
      };
    },
    async fetchOpenInterest(symbol: string, refPrice?: number) {
      return {
        openInterest: 50000,
        openInterestValue: 50000 * (refPrice ?? 1000),
        provenance: mockTickers[0].provenance,
      };
    },
  };

  const app = await createApp({
    skipViteMiddleware: true,
    customDbPath: dbPath,
    customAdapters: {
      binance_usdm: mockLiveAdapter,
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Run initial scan + process jobs to completion via API
    await fetch(`${baseUrl}/api/scan?mode=live&exchange=binance_usdm`);
    await fetch(`${baseUrl}/api/smc-scan/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: 'binance_usdm' }),
    });

    // Call /api/scan once with autoStartSmc=false so snapshot is completely frozen
    const scanRes1 = await fetch(
      `${baseUrl}/api/scan?mode=live&exchange=binance_usdm&autoStartSmc=false`
    );
    assert.equal(scanRes1.status, 200);
    const scanJson = await scanRes1.json();

    const [smcStatusRes, paperStatusRes, gateDriftRes] = await Promise.all([
      fetch(`${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`),
      fetch(`${baseUrl}/api/paper-monitor/status`),
      fetch(`${baseUrl}/api/paper-quality/gate-drift?exchange=binance_usdm`),
    ]);

    const smcStatusJson = await smcStatusRes.json();
    const paperStatusJson = await paperStatusRes.json();
    const gateDriftJson = await gateDriftRes.json();

    // Test 5: Identical snapshotAt, statsVersion, cycleId across all 4 endpoints
    assert.equal(scanJson.cycleId, smcStatusJson.cycleId);
    assert.equal(scanJson.cycleId, paperStatusJson.cycleId);
    assert.equal(scanJson.cycleId, gateDriftJson.cycleId);

    assert.equal(scanJson.statsVersion, smcStatusJson.statsVersion);
    assert.equal(scanJson.statsVersion, paperStatusJson.statsVersion);
    assert.equal(scanJson.statsVersion, gateDriftJson.statsVersion);

    assert.equal(scanJson.snapshotAt, smcStatusJson.snapshotAt);
    assert.equal(scanJson.snapshotAt, paperStatusJson.snapshotAt);
    assert.equal(scanJson.snapshotAt, gateDriftJson.snapshotAt);

    // Verify all 5 funnel blocks exist on each endpoint with complete metadata
    for (const payload of [
      scanJson,
      smcStatusJson,
      paperStatusJson,
      gateDriftJson,
    ]) {
      assert.ok(payload.currentCycleFunnel);
      assert.ok(payload.latestSnapshotFunnel);
      assert.ok(payload.monitoringWindowFunnel);
      assert.ok(payload.cumulativeFunnel);
      assert.ok(payload.historicalSignalsOutsideWindow);

      assert.equal(
        payload.currentCycleFunnel.aggregationScope,
        'CURRENT_CYCLE'
      );
      assert.equal(
        payload.latestSnapshotFunnel.aggregationScope,
        'LATEST_SNAPSHOT'
      );
      assert.equal(
        payload.monitoringWindowFunnel.aggregationScope,
        'MONITORING_WINDOW'
      );
      assert.equal(payload.cumulativeFunnel.aggregationScope, 'CUMULATIVE');
      assert.equal(
        payload.historicalSignalsOutsideCurrentCycle.aggregationScope,
        'OUTSIDE_CURRENT_CYCLE'
      );
      assert.equal(
        payload.historicalSignalsOutsideWindow.aggregationScope,
        'OUTSIDE_MONITORING_WINDOW'
      );
      assert.equal(payload.currentCycleFunnel.statsConsistency, 'VALID');
      assert.deepEqual(payload.currentCycleFunnel.consistencyErrors, []);
    }

    // Test 6: Near-Miss count matches gate-drift nearMissOnly denominator
    assert.equal(
      scanJson.nearMissCount,
      scanJson.nearMissMissing1Count + scanJson.nearMissMissing2Count
    );
    assert.equal(scanJson.nearMissCount, gateDriftJson.nearMissCount);
    assert.equal(
      scanJson.nearMissCount,
      gateDriftJson.scopedGateStatistics.nearMissDenominator
    );
    assert.equal(
      scanJson.nearMissCount,
      gateDriftJson.scopedGateStatistics.nearMissOnly.MTF_ALIGNMENT
        .evaluatedDenominator
    );

    // Test 7: Live / Demo / Shadow isolation
    const shadowComp = scanJson.observationShadowComparison;
    assert.ok(shadowComp);
    assert.equal(shadowComp.strictProduction.mode, 'STRICT_PRODUCTION');
    assert.equal(shadowComp.strictProduction.paperTradingAllowed, true);
    assert.equal(
      shadowComp.observationShadowOneGateMissing.mode,
      'OBSERVATION_SHADOW_ONE_GATE_MISSING'
    );
    assert.equal(
      shadowComp.observationShadowOneGateMissing.paperTradingAllowed,
      false
    );
    assert.equal(
      shadowComp.observationShadowOneGateMissing.notificationAllowed,
      false
    );
    assert.equal(
      shadowComp.observationShadowTwoGatesMissing.mode,
      'OBSERVATION_SHADOW_TWO_GATES_MISSING'
    );
    assert.equal(
      shadowComp.observationShadowTwoGatesMissing.paperTradingAllowed,
      false
    );
    assert.equal(
      shadowComp.observationShadowTwoGatesMissing.notificationAllowed,
      false
    );

    const demoScanRes = await fetch(`${baseUrl}/api/scan?mode=demo`);
    const demoScanJson = await demoScanRes.json();
    assert.equal(demoScanJson.mode, 'demo');
    assert.equal(demoScanJson.isDemo, true);
    assert.equal(demoScanJson.currentCyclePaperEligibleCount, 0);
    assert.equal(demoScanJson.eligiblePaperSignalCount, 0);

    // Test 8: Order placement routes return HTTP 404
    for (const orderPath of [
      '/api/order',
      '/api/orders',
      '/api/trade',
      '/api/live-order',
      '/api/binance/order',
    ]) {
      const orderRes = await fetch(`${baseUrl}${orderPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 }),
      });
      assert.equal(
        orderRes.status,
        404,
        `Expected 404 for ${orderPath}, got ${orderRes.status}`
      );
    }

    // Test 9: externalNotificationCount = 0
    assert.equal(paperStatusJson.externalNotificationCount, 0);
    assert.equal(paperStatusJson.externalTelegramRequestsCount, 0);
    assert.equal(paperStatusJson.externalTradingViewRequestsCount, 0);

    // Test 10: PAPER ONLY / LIVE ORDERS DISABLED / NEVER AUTO-PLACE ORDERS
    assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
    assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(
      TRADING_SAFETY_FLAGS.executionPolicy,
      'NEVER AUTO-PLACE ORDERS'
    );
    assert.deepEqual(scanJson.safety, TRADING_SAFETY_FLAGS);
    assert.deepEqual(smcStatusJson.safety, TRADING_SAFETY_FLAGS);
    assert.deepEqual(paperStatusJson.safety, TRADING_SAFETY_FLAGS);
    assert.deepEqual(gateDriftJson.safety, TRADING_SAFETY_FLAGS);
  } finally {
    server.close();
  }
});
