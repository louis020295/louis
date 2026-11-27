import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import {
  buildObservationShadowComparisonSummary,
  buildScopedGateStatisticsSummary,
  buildSmcGateDiagnosticsSummary,
  EvaluatedGateDiagnosticItemInput,
} from '../server/engine/SmcRuleEngine.ts';
import { createApp } from '../server.ts';

function makeTempDbPath(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phase18_5_${tag}_`));
  return path.join(dir, 'radar.sqlite');
}

test('Phase 18.5 Requirement 一 & 二: Long-running 15m close events with closeEventId & isTestFixture=false, and INDEPENDENT_ENDPOINT_SNAPSHOT vs SHARED_ATOMIC_SNAPSHOT consistency', async () => {
  const dbPath = makeTempDbPath('close_events_and_snapshots');
  const db = new RadarDatabase(dbPath);
  const nowMs = Date.UTC(2026, 3, 2, 12, 0, 5, 0);
  const barOpenTime = Date.UTC(2026, 3, 2, 11, 45, 0, 0);
  const barCloseTime = Date.UTC(2026, 3, 2, 11, 59, 59, 999);

  // Record 2 LIVE_PRODUCTION 15m close events (one within 24h, one at 48h ago within 72h) and 1 CONTROLLED_LIVE_FIXTURE event
  db.save15mCloseEvent({
    closeEventId: 'evt_live_24h_1',
    eventId: 'evt_live_24h_1',
    exchange: 'binance_usdm',
    cycleId: 'cycle_live_18_5_a',
    barOpenTime,
    barCloseTime,
    closeEventAt: new Date(nowMs - 2 * 3600_000).toISOString(),
    triggeredFastLaneCount: 28,
    completedFastLaneCount: 28,
    formalCandidateCount: 0,
    nearMissCount: 3,
    candidateDetectedBeforeEntryCount: 0,
    entryWindowMissedCount: 0,
    pendingCount: 4,
    queueWaitP50: 14,
    queueWaitP95: 31,
    workerState: 'RUNNING',
    cacheMode: 'WARM',
    snapshotAt: new Date(nowMs - 2 * 3600_000).toISOString(),
    statsVersion: 10,
    evidenceType: 'LIVE_PRODUCTION',
    isDemo: false,
    isTestFixture: false,
  });

  db.save15mCloseEvent({
    closeEventId: 'evt_live_72h_2',
    eventId: 'evt_live_72h_2',
    exchange: 'binance_usdm',
    cycleId: 'cycle_live_18_5_b',
    barOpenTime: barOpenTime - 36 * 3600_000,
    barCloseTime: barCloseTime - 36 * 3600_000,
    closeEventAt: new Date(nowMs - 36 * 3600_000).toISOString(),
    triggeredFastLaneCount: 24,
    completedFastLaneCount: 24,
    formalCandidateCount: 0,
    nearMissCount: 2,
    candidateDetectedBeforeEntryCount: 0,
    entryWindowMissedCount: 0,
    pendingCount: 2,
    queueWaitP50: 16,
    queueWaitP95: 35,
    workerState: 'RUNNING',
    cacheMode: 'WARM',
    snapshotAt: new Date(nowMs - 36 * 3600_000).toISOString(),
    statsVersion: 9,
    evidenceType: 'LIVE_PRODUCTION',
    isDemo: false,
    isTestFixture: false,
  });

  // Controlled fixture event MUST be excluded from LIVE_PRODUCTION close event lists and 24h/72h reports
  db.save15mCloseEvent({
    closeEventId: 'evt_controlled_fixture_1',
    eventId: 'evt_controlled_fixture_1',
    exchange: 'binance_usdm',
    cycleId: 'cycle_ctrl_fixture',
    barOpenTime,
    barCloseTime,
    closeEventAt: new Date(nowMs - 1 * 3600_000).toISOString(),
    triggeredFastLaneCount: 10,
    completedFastLaneCount: 10,
    formalCandidateCount: 2,
    nearMissCount: 0,
    candidateDetectedBeforeEntryCount: 2,
    entryWindowMissedCount: 0,
    pendingCount: 0,
    queueWaitP50: 5,
    queueWaitP95: 9,
    workerState: 'RUNNING',
    cacheMode: 'WARM',
    snapshotAt: new Date(nowMs - 1 * 3600_000).toISOString(),
    statsVersion: 11,
    evidenceType: 'CONTROLLED_LIVE_FIXTURE',
    isDemo: false,
    isTestFixture: true,
  });

  // 1. Independent endpoint queries MUST mark snapshotConsistency = "INDEPENDENT_ENDPOINT_SNAPSHOT"
  const indepCapture = db.getLiveCaptureObservation('binance_usdm');
  const indepEvents = db.getLiveCaptureEvents('binance_usdm', {
    sharedContext: undefined,
  });
  const indepSummary = db.getLiveCaptureSummary('binance_usdm');

  assert.equal(
    indepCapture.snapshotConsistency,
    'INDEPENDENT_ENDPOINT_SNAPSHOT'
  );
  assert.equal(
    indepEvents.snapshotConsistency,
    'INDEPENDENT_ENDPOINT_SNAPSHOT'
  );
  assert.equal(
    indepSummary.snapshotConsistency,
    'INDEPENDENT_ENDPOINT_SNAPSHOT'
  );
  assert.ok(indepCapture.snapshotAt);
  assert.ok(indepCapture.capturedAt);
  assert.ok(indepCapture.cycleId);
  assert.equal(typeof indepCapture.statsVersion, 'number');
  assert.equal(indepCapture.aggregationScope, 'CURRENT_CYCLE');
  assert.equal(indepCapture.evidenceType, 'LIVE_PRODUCTION');
  assert.equal(indepCapture.isDemo, false);
  assert.equal(indepCapture.isTestFixture, false);

  // Verify 15m close events fields and fixture exclusion
  assert.equal(indepEvents.totalCloseEventCount, 2);
  assert.equal(indepEvents.totalFastLaneTriggered, 52);
  assert.equal(indepEvents.totalFastLaneCompleted, 52);
  assert.equal(indepEvents.fastLaneCompletionRate, 1);
  for (const ev of indepEvents.events) {
    assert.ok(ev.closeEventId);
    assert.equal(ev.closeEventId, ev.eventId);
    assert.equal(ev.evidenceType, 'LIVE_PRODUCTION');
    assert.equal(ev.isDemo, false);
    assert.equal(ev.isTestFixture, false);
  }

  // Verify 24h vs 72h window reports using nowMs anchor
  const rep24h = db.buildLiveCloseEventWindowReport(
    'binance_usdm',
    24,
    new Date(nowMs).toISOString()
  );
  const rep72h = db.buildLiveCloseEventWindowReport(
    'binance_usdm',
    72,
    new Date(nowMs).toISOString()
  );
  assert.equal(rep24h.totalCloseEventCount, 1);
  assert.equal(rep24h.triggeredFastLaneCount, 28);
  assert.equal(rep24h.completedFastLaneCount, 28);
  assert.equal(rep24h.fastLaneCompletionRate, 1);
  assert.equal(rep72h.totalCloseEventCount, 2);
  assert.equal(rep72h.triggeredFastLaneCount, 52);
  assert.equal(rep72h.completedFastLaneCount, 52);
  assert.equal(rep72h.fastLaneCompletionRate, 1);

  // 2. Shared atomic bundle MUST mark snapshotConsistency = "SHARED_ATOMIC_SNAPSHOT" with identical cycleId, snapshotAt, capturedAt, statsVersion
  const atomicBundle = db.getSharedAtomicLiveCaptureBundle('binance_usdm');
  assert.equal(atomicBundle.snapshotConsistency, 'SHARED_ATOMIC_SNAPSHOT');
  assert.equal(
    atomicBundle.liveCapture.snapshotConsistency,
    'SHARED_ATOMIC_SNAPSHOT'
  );
  assert.equal(
    atomicBundle.events.snapshotConsistency,
    'SHARED_ATOMIC_SNAPSHOT'
  );
  assert.equal(
    atomicBundle.summary.snapshotConsistency,
    'SHARED_ATOMIC_SNAPSHOT'
  );
  assert.equal(atomicBundle.liveCapture.snapshotAt, atomicBundle.snapshotAt);
  assert.equal(atomicBundle.events.snapshotAt, atomicBundle.snapshotAt);
  assert.equal(atomicBundle.summary.snapshotAt, atomicBundle.snapshotAt);
  assert.equal(atomicBundle.liveCapture.capturedAt, atomicBundle.capturedAt);
  assert.equal(atomicBundle.events.capturedAt, atomicBundle.capturedAt);
  assert.equal(atomicBundle.summary.capturedAt, atomicBundle.capturedAt);
  assert.equal(atomicBundle.liveCapture.cycleId, atomicBundle.cycleId);
  assert.equal(atomicBundle.events.cycleId, atomicBundle.cycleId);
  assert.equal(atomicBundle.summary.cycleId, atomicBundle.cycleId);

  db.close();
});

test('Phase 18.5 Requirement 三: Real Live Candidate Status when 0 formal candidates vs when genuine LIVE_PRODUCTION candidates exist (Demo & Controlled Fixture strictly isolated)', async () => {
  const dbPath = makeTempDbPath('live_candidate_status');
  const db = new RadarDatabase(dbPath);

  // Save a CONTROLLED_LIVE_FIXTURE candidate — must NOT affect LIVE_* metrics
  db.saveControlledFixtureCandidate({
    cycleId: 'cycle_ctrl_only',
    signalId: 'sig_ctrl_btc_15m_LONG',
    symbol: 'BTCUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    direction: 'LONG',
    signalBarOpenTime: 1775000700000,
    signalBarCloseTime: 1775001599999,
    nextBarOpenTime: 1775001600000,
    candidateDetectedAt: new Date(1775001599999 + 38).toISOString(),
    signalDetectedAt: new Date(1775001599999 + 38).toISOString(),
    queueEnteredAt: new Date(1775001599999 + 5).toISOString(),
    evaluationStartedAt: new Date(1775001599999 + 14).toISOString(),
    evaluationCompletedAt: new Date(1775001599999 + 38).toISOString(),
    queueWaitMs: 9,
    evaluationLatencyMs: 24,
    candidateDetectionLatencyMs: 38,
    nextBarRemainingMs: 899962,
    entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
    entryWindowMissed: false,
    isFastLane: true,
    evidenceType: 'CONTROLLED_LIVE_FIXTURE',
    source: 'CONTROLLED_LIVE_FIXTURE_HARNESS',
    fetchedAt: new Date(1775001599999 + 38).toISOString(),
    stale: false,
    fallback: false,
    isDemo: false,
    isTestFixture: true,
  });

  // Case A: 0 real LIVE_PRODUCTION candidates
  const obsZero = db.getLiveCaptureObservation('binance_usdm');
  assert.equal(obsZero.LIVE_FORMAL_CANDIDATE_COUNT, 0);
  assert.equal(obsZero.liveValidationStatus, 'NO_LIVE_FORMAL_CANDIDATE');
  assert.equal(
    obsZero.liveSampleValidationStatus,
    'LIVE_VALIDATION_INSUFFICIENT_SAMPLE'
  );
  assert.equal(obsZero.isLiveValidated, false);
  assert.equal(obsZero.candidateDetectionLatencyP50, null);
  assert.equal(obsZero.candidateDetectionLatencyP95, null);
  assert.equal(obsZero.entryWindowMissedRate, null);
  assert.equal(obsZero.LIVE_DETECTION_LATENCY_P50, null);
  assert.equal(obsZero.LIVE_DETECTION_LATENCY_P95, null);
  assert.equal(obsZero.LIVE_ENTRY_WINDOW_MISSED_RATE, null);
  assert.equal(obsZero.CONTROLLED_LIVE_FIXTURE.formalCandidateCount, 1);
  assert.equal(obsZero.CONTROLLED_LIVE_FIXTURE.isTestFixture, true);
  assert.equal(obsZero.DEMO_LATENCY_FIXTURE.isDemo, true);
  assert.equal(obsZero.DEMO_LATENCY_FIXTURE.isTestFixture, true);

  // Case B: Genuine Binance LIVE_PRODUCTION formal candidate arrives
  const activeCycleId = db.getSmcScanCycleId('binance_usdm');
  db.saveLiveCaptureCandidate({
    cycleId: activeCycleId,
    signalId: `sig_binance_usdm_SOLUSDT_15m_LONG_1775000700000_smc_v2`,
    symbol: 'SOLUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    direction: 'LONG',
    signalBarOpenTime: 1775000700000,
    signalBarCloseTime: 1775001599999,
    nextBarOpenTime: 1775001600000,
    candidateDetectedAt: new Date(1775001599999 + 52).toISOString(),
    signalDetectedAt: new Date(1775001599999 + 52).toISOString(),
    queueEnteredAt: new Date(1775001599999 + 8).toISOString(),
    evaluationStartedAt: new Date(1775001599999 + 20).toISOString(),
    evaluationCompletedAt: new Date(1775001599999 + 52).toISOString(),
    queueWaitMs: 12,
    evaluationLatencyMs: 32,
    candidateDetectionLatencyMs: 52,
    nextBarRemainingMs: 899948,
    entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
    entryWindowMissed: false,
    isFastLane: true,
    evidenceType: 'LIVE_PRODUCTION',
    source: 'Binance USDⓈ-M Futures Public REST API',
    fetchedAt: new Date(1775001599999 + 52).toISOString(),
    stale: false,
    fallback: false,
    isDemo: false,
    isTestFixture: false,
  });

  const obsWithLive = db.getLiveCaptureObservation('binance_usdm');
  assert.equal(obsWithLive.LIVE_FORMAL_CANDIDATE_COUNT, 1);
  assert.equal(obsWithLive.LIVE_FAST_LANE_COUNT, 1);
  assert.equal(obsWithLive.LIVE_BULK_COUNT, 0);
  assert.equal(obsWithLive.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT, 1);
  assert.equal(obsWithLive.LIVE_ENTRY_WINDOW_MISSED_COUNT, 0);
  assert.equal(obsWithLive.LIVE_DETECTION_LATENCY_P50, 52);
  assert.equal(obsWithLive.LIVE_DETECTION_LATENCY_P95, 52);
  assert.equal(obsWithLive.candidateDetectionLatencyP50, 52);
  assert.equal(obsWithLive.candidateDetectionLatencyP95, 52);
  assert.equal(obsWithLive.entryWindowMissedRate, 0);
  assert.equal(
    obsWithLive.liveValidationStatus,
    'LIVE_CANDIDATE_DETECTED_BEFORE_ENTRY'
  );
  // Still < 30 samples so isLiveValidated remains false and liveSampleValidationStatus is LIVE_VALIDATION_INSUFFICIENT_SAMPLE
  assert.equal(obsWithLive.isLiveValidated, false);
  assert.equal(
    obsWithLive.liveSampleValidationStatus,
    'LIVE_VALIDATION_INSUFFICIENT_SAMPLE'
  );

  db.close();
});

test('Phase 18.5 Requirement 四 & 五: Signal Quality Sample Threshold (paperClosedCount < 30 -> null metrics & strategyValidity = INSUFFICIENT_SAMPLE) and Near-Miss 12 fields persistence', () => {
  const items: EvaluatedGateDiagnosticItemInput[] = [
    {
      symbol: 'BTCUSDT',
      smcActionState: 'WATCH',
      marketRadarCategory: '雷達多頭觀察',
      score: 76,
      evaluationLatencyMs: 28,
      nextBarRemainingMs: 420000,
      queueWaitMs: 11,
      marketRegime: 'BULLISH_TREND',
      fundingState: 'NORMAL_FUNDING',
      liquidityState: 'LIQUIDITY_SWEEP_CONFIRMED',
      mtfAlignmentState: 'MTF_CONFLICT',
      isDemo: false,
      isTestFixture: false,
      evidenceType: 'LIVE_PRODUCTION',
      isFastLane: true,
      gateEvaluation: {
        bosMssPassed: true,
        liquiditySweepPassed: true,
        displacementPassed: true,
        fvgOrObPassed: true,
        mtfAlignmentPassed: false,
        atrPassed: true,
        historyPassed: true,
        oiPassed: true,
        fundingPassed: true,
        oiFundingPassed: true,
        dataFreshnessPassed: true,
        liquiditySafetyPassed: true,
        riskSafetyPassed: true,
        waitReasons: ['多時間框架 (5m/15m/1h/4h) 尚未完全同向共振'],
        missingGates: ['MTF_ALIGNMENT'],
        lastBlockingGate: 'MTF_ALIGNMENT',
        nearMissStatus: 'NEAR_MISS_ONE_GATE',
        intendedDirection: 'LONG',
      },
    },
    {
      symbol: 'ETHUSDT',
      smcActionState: 'WAIT',
      marketRadarCategory: '雷達空頭觀察',
      score: 68,
      evaluationLatencyMs: 34,
      nextBarRemainingMs: 415000,
      queueWaitMs: 15,
      marketRegime: 'BEARISH_TREND',
      fundingState: 'NORMAL_FUNDING',
      liquidityState: 'ADEQUATE_LIQUIDITY_NO_SWEEP',
      mtfAlignmentState: 'MTF_CONFLICT',
      isDemo: false,
      isTestFixture: false,
      evidenceType: 'LIVE_PRODUCTION',
      isFastLane: true,
      gateEvaluation: {
        bosMssPassed: true,
        liquiditySweepPassed: false,
        displacementPassed: true,
        fvgOrObPassed: true,
        mtfAlignmentPassed: false,
        atrPassed: true,
        historyPassed: true,
        oiPassed: true,
        fundingPassed: true,
        oiFundingPassed: true,
        dataFreshnessPassed: true,
        liquiditySafetyPassed: true,
        riskSafetyPassed: true,
        waitReasons: ['尚未偵測到明確流動性清掃', '多時間框架尚未完全同向共振'],
        missingGates: ['LIQUIDITY_SWEEP', 'MTF_ALIGNMENT'],
        lastBlockingGate: 'MTF_ALIGNMENT',
        nearMissStatus: 'NEAR_MISS_TWO_GATES',
        intendedDirection: 'SHORT',
      },
    },
  ];

  // Subcase 1: paperClosedCount = 12 (< 30) -> all performance metrics MUST be null & strategyValidity = "INSUFFICIENT_SAMPLE"
  const scoped = buildScopedGateStatisticsSummary(items, {
    totalUniverseSymbols: 2,
    cycleId: 'cycle_p18_5_threshold',
  });
  const shadowSub30 = buildObservationShadowComparisonSummary(
    items,
    scoped,
    'cycle_p18_5_threshold',
    {
      entryWindowMissedCount: 0,
      paperOpenedCount: 15,
      paperClosedCount: 12,
      winRate: 58.33,
      averageR: 0.42,
      profitFactor: 1.65,
      maxDrawdownR: 2.1,
      expectancyR: 0.35,
    }
  );

  assert.equal(shadowSub30.strictProduction.paperClosedCount, 12);
  assert.equal(shadowSub30.strictProduction.winRate, null);
  assert.equal(shadowSub30.strictProduction.averageR, null);
  assert.equal(shadowSub30.strictProduction.profitFactor, null);
  assert.equal(shadowSub30.strictProduction.maxDrawdownR, null);
  assert.equal(shadowSub30.strictProduction.expectancyR, null);
  assert.equal(
    shadowSub30.strictProduction.strategyValidity,
    'INSUFFICIENT_SAMPLE'
  );

  // Subcase 2: paperClosedCount = 30 (>= 30) -> strategyValidity = "VALIDATED" and metrics populated
  const shadowAt30 = buildObservationShadowComparisonSummary(
    items,
    scoped,
    'cycle_p18_5_threshold_30',
    {
      entryWindowMissedCount: 1,
      paperOpenedCount: 32,
      paperClosedCount: 30,
      winRate: 56.67,
      averageR: 0.38,
      profitFactor: 1.54,
      maxDrawdownR: 3.2,
      expectancyR: 0.31,
    }
  );
  assert.equal(shadowAt30.strictProduction.paperClosedCount, 30);
  assert.equal(shadowAt30.strictProduction.strategyValidity, 'VALIDATED');
  assert.equal(shadowAt30.strictProduction.winRate, 56.67);
  assert.equal(shadowAt30.strictProduction.averageR, 0.38);
  assert.equal(shadowAt30.strictProduction.profitFactor, 1.54);
  assert.equal(shadowAt30.strictProduction.maxDrawdownR, 3.2);
  assert.equal(shadowAt30.strictProduction.expectancyR, 0.31);

  // Shadow modes ALWAYS have paperClosedCount = 0, null metrics, strategyValidity = "INSUFFICIENT_SAMPLE"
  assert.equal(shadowAt30.observationShadowOneGateMissing.paperClosedCount, 0);
  assert.equal(shadowAt30.observationShadowOneGateMissing.winRate, null);
  assert.equal(
    shadowAt30.observationShadowOneGateMissing.strategyValidity,
    'INSUFFICIENT_SAMPLE'
  );
  assert.equal(shadowAt30.observationShadowTwoGatesMissing.paperClosedCount, 0);
  assert.equal(shadowAt30.observationShadowTwoGatesMissing.winRate, null);
  assert.equal(
    shadowAt30.observationShadowTwoGatesMissing.strategyValidity,
    'INSUFFICIENT_SAMPLE'
  );

  // Verify Near-Miss 12 fields & persistence in SQLite
  const diag = buildSmcGateDiagnosticsSummary(items, {
    totalUniverseSymbols: 2,
    cycleId: 'cycle_p18_5_nm',
    snapshotAt: '2026-04-02T12:00:00.000Z',
  });
  assert.equal(diag.nearMissSymbols.length, 2);
  for (const nm of diag.nearMissSymbols) {
    assert.ok(nm.symbol);
    assert.ok(nm.intendedDirection);
    assert.ok(Array.isArray(nm.missingGates));
    assert.ok(nm.missingGateCount === 1 || nm.missingGateCount === 2);
    assert.equal(typeof nm.evaluationLatencyMs, 'number');
    assert.equal(typeof nm.nextBarRemainingMs, 'number');
    assert.equal(typeof nm.queueWaitMs, 'number');
    assert.ok(nm.marketRadarCategory);
    assert.ok(nm.marketRegime);
    assert.ok(nm.fundingState);
    assert.ok(nm.liquidityState);
    assert.ok(nm.mtfAlignmentState);
    // Forbidden fields on Near-Miss must remain undefined
    assert.equal(nm.candidateDetectionLatencyMs, undefined);
    assert.equal(nm.entryWindowMissed, undefined);
  }
});

test('Phase 18.5 Requirement 六 & 七: HTTP Endpoints, Shared vs Independent Snapshot Consistency, Persisted 24h/72h Reports, and Execution Safety Guardrails', async () => {
  const app = await createApp({
    customDbPath: makeTempDbPath('http_endpoints'),
    skipViteMiddleware: true,
  });
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 3099;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Query the 3 Live Capture endpoints independently -> snapshotConsistency = "INDEPENDENT_ENDPOINT_SNAPSHOT"
    const [capRes, evRes, sumRes, atomicRes] = await Promise.all([
      fetch(`${baseUrl}/api/paper-quality/live-capture?exchange=binance_usdm`),
      fetch(
        `${baseUrl}/api/paper-quality/live-capture/events?exchange=binance_usdm`
      ),
      fetch(
        `${baseUrl}/api/paper-quality/live-capture/summary?exchange=binance_usdm`
      ),
      fetch(
        `${baseUrl}/api/paper-quality/live-capture/atomic?exchange=binance_usdm`
      ),
    ]);

    assert.equal(capRes.status, 200);
    assert.equal(evRes.status, 200);
    assert.equal(sumRes.status, 200);
    assert.equal(atomicRes.status, 200);

    const capJson = await capRes.json();
    const evJson = await evRes.json();
    const sumJson = await sumRes.json();
    const atomicJson = await atomicRes.json();

    assert.equal(
      capJson.snapshotConsistency,
      'INDEPENDENT_ENDPOINT_SNAPSHOT'
    );
    assert.equal(evJson.snapshotConsistency, 'INDEPENDENT_ENDPOINT_SNAPSHOT');
    assert.equal(
      sumJson.snapshotConsistency,
      'INDEPENDENT_ENDPOINT_SNAPSHOT'
    );

    assert.equal(atomicJson.snapshotConsistency, 'SHARED_ATOMIC_SNAPSHOT');
    assert.equal(
      atomicJson.liveCapture.snapshotConsistency,
      'SHARED_ATOMIC_SNAPSHOT'
    );
    assert.equal(
      atomicJson.events.snapshotConsistency,
      'SHARED_ATOMIC_SNAPSHOT'
    );
    assert.equal(
      atomicJson.summary.snapshotConsistency,
      'SHARED_ATOMIC_SNAPSHOT'
    );

    // Verify all 6 required notices are present
    const requiredNotices = [
      '尚無真實 Live 正式候選',
      'Live 捕捉 SLA 尚未驗證',
      'Fast Lane 已運作，但目前沒有正式候選樣本',
      'Near-Miss 不等於正式訊號',
      'Shadow 候選不等於 Paper 訊號',
      '尚無足夠已結算樣本，不能判斷策略有效性',
    ];
    for (const notice of requiredNotices) {
      assert.ok(
        sumJson.permanentNotices.includes(notice),
        `Missing required notice: ${notice}`
      );
    }

    // Verify execution safety & order endpoints HTTP 404
    assert.equal(sumJson.executionSafety.paperOnly, true);
    assert.equal(sumJson.executionSafety.liveOrdersDisabled, true);
    assert.equal(sumJson.executionSafety.neverAutoPlaceOrders, true);
    assert.equal(sumJson.executionSafety.externalNotificationCount, 0);

    for (const orderPath of [
      '/api/order',
      '/api/orders',
      '/api/trade',
      '/api/execute',
    ]) {
      const orderRes = await fetch(`${baseUrl}${orderPath}`, {
        method: 'POST',
      });
      assert.equal(
        orderRes.status,
        404,
        `Order endpoint ${orderPath} must return 404`
      );
    }

    // Save the Phase 18.5 verification report artifact to public/reports/phase18-5-live-observation-report.json
    const reportDir = path.resolve(process.cwd(), 'public', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(
      reportDir,
      'phase18-5-live-observation-report.json'
    );
    const savedReport = {
      phase: 'Phase 18.5',
      title: '真實 Live 長時間候選觀測與訊號品質決策報告',
      generatedAt: new Date().toISOString(),
      cycleId: sumJson.cycleId,
      snapshotAt: sumJson.snapshotAt,
      capturedAt: sumJson.capturedAt,
      statsVersion: sumJson.statsVersion,
      aggregationScope: sumJson.aggregationScope,
      snapshotConsistencyModesVerified: {
        independentEndpointQuery: capJson.snapshotConsistency,
        sharedAtomicSnapshotBundle: atomicJson.snapshotConsistency,
      },
      report24h: sumJson.report24h,
      report72h: sumJson.report72h,
      fastLaneCompletionRate: sumJson.fastLaneCompletionRate,
      nearMissDistribution: sumJson.nearMissDistribution,
      LIVE_FORMAL_CANDIDATE_COUNT: sumJson.LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
        sumJson.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT: sumJson.LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_DETECTION_LATENCY_P50: sumJson.LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95: sumJson.LIVE_DETECTION_LATENCY_P95,
      candidateDetectionLatencyP50: sumJson.candidateDetectionLatencyP50,
      candidateDetectionLatencyP95: sumJson.candidateDetectionLatencyP95,
      entryWindowMissedRate: sumJson.entryWindowMissedRate,
      liveValidationStatus: sumJson.liveValidationStatus,
      liveSampleValidationStatus: sumJson.liveSampleValidationStatus,
      isLiveValidated: sumJson.isLiveValidated,
      strategyValidity: sumJson.strategyValidity,
      evidenceIsolationProof: {
        LIVE_PRODUCTION: {
          evidenceType: 'LIVE_PRODUCTION',
          isDemo: false,
          isTestFixture: false,
          formalCandidateCount: sumJson.LIVE_FORMAL_CANDIDATE_COUNT,
          detectionLatencyP50: sumJson.LIVE_DETECTION_LATENCY_P50,
          detectionLatencyP95: sumJson.LIVE_DETECTION_LATENCY_P95,
        },
        CONTROLLED_LIVE_FIXTURE: sumJson.CONTROLLED_LIVE_FIXTURE,
        DEMO_LATENCY_FIXTURE: sumJson.DEMO_LATENCY_FIXTURE,
        guarantee: capJson.evidenceIsolationGuarantee,
      },
      signalQualityCalibration: sumJson.signalQualityCalibration,
      executionSafety: sumJson.executionSafety,
    };
    fs.writeFileSync(reportPath, JSON.stringify(savedReport, null, 2), 'utf8');
    assert.ok(fs.existsSync(reportPath));
  } finally {
    const scanner = app.locals.smcBatchScanner;
    if (scanner && typeof scanner.gracefulShutdown === 'function') {
      scanner.gracefulShutdown('binance_usdm', 'test_done');
    }
    const monitor = app.locals.paperShadowMonitor;
    if (monitor && typeof monitor.stop === 'function') {
      monitor.stop();
    }
    const radarDb = app.locals.radarDb;
    if (radarDb && typeof radarDb.close === 'function') {
      radarDb.close();
    }
    server.close();
  }
});
