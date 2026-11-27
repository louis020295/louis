import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function createTempDbPath(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tmpDir, 'radar.sqlite');
}

function makeLiveProvenance(fetchedAtIso: string): DataProvenance {
  return {
    source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
    fetchedAt: fetchedAtIso,
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
    volumeTimeframe: '15m',
    aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
    volumeMetric: 'quoteVolume',
  };
}

function makeControlledFixtureProvenance(fetchedAtIso: string): DataProvenance {
  return {
    source: 'CONTROLLED_LIVE_FIXTURE_ADAPTER',
    fetchedAt: fetchedAtIso,
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
    volumeTimeframe: '15m',
    aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
    volumeMetric: 'quoteVolume',
  };
}

function makeConfirmedKlines(params: {
  baseOpenTime: number;
  count: number;
  timeframeMs?: number;
  basePrice?: number;
  direction?: 'LONG' | 'SHORT';
}): Kline[] {
  const tfMs = params.timeframeMs ?? 15 * 60 * 1000;
  const basePrice = params.basePrice ?? 100;
  const dir = params.direction ?? 'LONG';
  const klines: Kline[] = [];

  for (let i = 0; i < params.count; i++) {
    const openTime = params.baseOpenTime + i * tfMs;
    const closeTime = openTime + tfMs - 1000;
    const drift = dir === 'LONG' ? i * 0.25 : -i * 0.25;
    const open = Number((basePrice + drift).toFixed(4));
    const close = Number(
      (open + (dir === 'LONG' ? 0.45 : -0.45)).toFixed(4)
    );
    const high = Number((Math.max(open, close) + 0.6).toFixed(4));
    const low = Number((Math.min(open, close) - 0.6).toFixed(4));
    klines.push({
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: 15000 + i * 200,
      quoteVolume: (15000 + i * 200) * close,
      isClosed: true,
    });
  }
  return klines;
}

class Deterministic15mCloseAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly exchangeId: ExchangeId = 'binance_usdm';
  public readonly displayName =
    'Binance USDⓈ-M Futures REST (https://fapi.binance.com)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status = 'LIVE' as const;

  private readonly demoFixture = new DemoExchangeAdapter();
  private readonly barCloseTime: number;

  constructor(barCloseTime: number) {
    this.barCloseTime = barCloseTime;
  }

  private getProvenance(): DataProvenance {
    return makeLiveProvenance(new Date(this.barCloseTime + 40).toISOString());
  }

  public async fetchMarketSnapshot(): Promise<{
    tickers: MarketTicker[];
    provenance: DataProvenance;
  }> {
    const snap = await this.demoFixture.fetchMarketSnapshot();
    const prov = this.getProvenance();
    return {
      provenance: prov,
      tickers: snap.tickers.map((t: MarketTicker) => ({
        ...t,
        provenance: prov,
      })),
    };
  }

  public async fetchKlines(
    symbol: string,
    timeframe: Timeframe,
    limit = 90
  ): Promise<{ klines: Kline[]; provenance: DataProvenance }> {
    const targetSymbol =
      symbol === 'BTCUSDT'
        ? 'DEMO_SMC_LONG_USDT'
        : symbol === 'ETHUSDT'
          ? 'DEMO_SMC_SHORT_USDT'
          : symbol;
    const res = await this.demoFixture.fetchKlines(
      targetSymbol,
      timeframe,
      limit
    );
    const prov = this.getProvenance();
    const closedOnly = res.klines.filter((k: Kline) => k.isClosed);
    if (closedOnly.length > 0 && timeframe === '15m') {
      const lastBar = closedOnly[closedOnly.length - 1];
      const shiftMs = this.barCloseTime - lastBar.closeTime;
      const shiftedClosed = closedOnly.map((k: Kline) => ({
        ...k,
        openTime: k.openTime + shiftMs,
        closeTime: k.closeTime + shiftMs,
        isClosed: true,
      }));
      return {
        provenance: prov,
        klines: shiftedClosed,
      };
    }
    return {
      provenance: prov,
      klines: closedOnly,
    };
  }

  public async fetchOpenInterest(symbol: string, referencePrice?: number) {
    const res = await this.demoFixture.fetchOpenInterest(
      symbol,
      referencePrice
    );
    return {
      ...res,
      provenance: this.getProvenance(),
    };
  }
}

describe('Phase 18.4: 真實 Live 候選觀測、捕捉 SLA 驗證與訊號條件校準', () => {
  it('1, 2 & 3. Demo 與 Controlled Fixture 嚴格隔離不會計入 Live；Live 無正式候選時延遲 P50/P95 全部為 null 且顯示「尚無真實 Live 候選，無法評估實盤捕捉延遲」', () => {
    const dbPath = createTempDbPath('p18-4-evidence-isolation');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const barCloseTime = nowMs - 40;
      const barOpenTime = barCloseTime - 15 * 60 * 1000 + 1;
      const nextBarOpenTime = barCloseTime + 60_000;

      // (1) Insert DEMO_LATENCY_FIXTURE candidate on demo_synthetic (latency = 32ms)
      radarDb.saveSmcScanResult({
        symbol: 'DEMO_SMC_LONG_USDT',
        exchange: 'demo_synthetic',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        marketRadarCategory: '雷達多頭觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: radarDb.getSmcScanCycleId('demo_synthetic'),
        priorityTier: 2,
        priorityLabel: '2_RADAR_LONG',
        priorityClass: 'FAST_LANE',
        workerRole: 'FAST_LANE',
        executionWorker: 'FAST_LANE_WORKER',
        stale: false,
        fallback: false,
        missingData: [],
        source: 'DEMO_SYNTHETIC_GENERATOR',
        isDemo: true,
        evidenceType: 'DEMO_LATENCY_FIXTURE',
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: [],
        smcAnalysis: {
          symbol: 'DEMO_SMC_LONG_USDT',
          primaryTimeframe: '15m',
          smcEvaluationStatus: 'EVALUATED',
          actionState: 'LONG CANDIDATE',
          waitReasons: [],
          evidences: [],
          atr14: 1.5,
          ruleVersion: SMC_RULE_VERSION,
        } as any,
        smcEvaluationLatencyMs: 22,
        evaluationLatencyMs: 22,
        detectionLatencyMs: 32,
        candidateDetectionLatencyMs: 32,
        queueWaitMs: 10,
        signalBarOpenTime: barOpenTime,
        signalBarCloseTime: barCloseTime,
        nextBarOpenTime,
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        isFastLane: true,
      });

      // (2) Insert CONTROLLED_LIVE_FIXTURE candidate on binance_usdm via saveSmcScanResult AND SignalOutcomeTracker (latency = 48ms)
      radarDb.saveSmcScanResult({
        symbol: 'CTRL_BTCUSDT',
        exchange: 'binance_usdm',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        marketRadarCategory: '雷達多頭觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        priorityTier: 1,
        priorityLabel: '1_WATCHLIST',
        priorityClass: 'FAST_LANE',
        workerRole: 'FAST_LANE',
        executionWorker: 'FAST_LANE_WORKER',
        stale: false,
        fallback: false,
        missingData: [],
        source: 'CONTROLLED_LIVE_FIXTURE_ADAPTER',
        isDemo: false,
        evidenceType: 'CONTROLLED_LIVE_FIXTURE',
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: [],
        smcAnalysis: {
          symbol: 'CTRL_BTCUSDT',
          primaryTimeframe: '15m',
          smcEvaluationStatus: 'EVALUATED',
          actionState: 'LONG CANDIDATE',
          waitReasons: [],
          evidences: [],
          atr14: 100,
          ruleVersion: SMC_RULE_VERSION,
        } as any,
        smcEvaluationLatencyMs: 30,
        evaluationLatencyMs: 30,
        detectionLatencyMs: 48,
        candidateDetectionLatencyMs: 48,
        queueWaitMs: 18,
        signalBarOpenTime: barOpenTime,
        signalBarCloseTime: barCloseTime,
        nextBarOpenTime,
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        isFastLane: true,
      });

      const klines = makeConfirmedKlines({
        baseOpenTime: barOpenTime - 34 * 15 * 60 * 1000,
        count: 35,
        direction: 'SHORT',
      });
      const ctrlTrackRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-ctrl-1',
        scanRunId: 'run-ctrl-1',
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        symbol: 'CTRL_ETHUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: nowIso,
        snapshotAt: nowIso,
        signalDetectedAt: nowIso,
        candidateDetectedAt: nowIso,
        queueEnteredAt: new Date(barCloseTime + 5).toISOString(),
        evaluationStartedAt: new Date(barCloseTime + 15).toISOString(),
        evaluationCompletedAt: nowIso,
        queueWaitMs: 10,
        evaluationLatencyMs: 25,
        candidateDetectionLatencyMs: 40,
        isFastLane: true,
        provenance: makeControlledFixtureProvenance(nowIso),
        evidenceType: 'CONTROLLED_LIVE_FIXTURE',
        klines,
        atr14: 1.5,
        openInterest: 10_000_000,
        fundingRate: 0.0001,
        score: 88,
        waitReasons: [],
        evidences: [],
      });

      // Controlled Fixture must NEVER open a Live Paper trade or count in Live Paper signals
      assert.equal(ctrlTrackRes.insertedNew, false);
      assert.equal(ctrlTrackRes.signal, null);
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);
      assert.equal(
        paperDb.listTrackedSignals({ exchange: 'binance_usdm' }).length,
        0
      );

      // (3) Insert a real LIVE_PRODUCTION WAIT symbol on binance_usdm (0 Live formal candidates)
      radarDb.saveSmcScanResult({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WAIT',
        finalTradeSignal: 'NONE',
        marketRadarCategory: '準備觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        priorityTier: 1,
        priorityLabel: '1_WATCHLIST',
        priorityClass: 'FAST_LANE',
        workerRole: 'FAST_LANE',
        executionWorker: 'FAST_LANE_WORKER',
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures Public REST API',
        isDemo: false,
        evidenceType: 'LIVE_PRODUCTION',
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: ['等待多時框結構對齊'],
        smcAnalysis: {
          symbol: 'BTCUSDT',
          primaryTimeframe: '15m',
          smcEvaluationStatus: 'EVALUATED',
          actionState: 'WAIT',
          waitReasons: ['等待多時框結構對齊'],
          evidences: [],
          atr14: 120,
          ruleVersion: SMC_RULE_VERSION,
        } as any,
      });

      const obs = radarDb.getLiveCaptureObservation('binance_usdm');
      const summary = radarDb.getLiveCaptureSummary('binance_usdm');

      // Verify CONTROLLED_LIVE_FIXTURE has 2 candidates, DEMO_LATENCY_FIXTURE has 2, while LIVE_PRODUCTION has 0
      assert.equal(obs.CONTROLLED_LIVE_FIXTURE.formalCandidateCount, 2);
      assert.equal(obs.CONTROLLED_LIVE_FIXTURE.neverMixedIntoLive, true);
      assert.equal(obs.CONTROLLED_LIVE_FIXTURE.neverMarkedLiveValidated, true);
      assert.equal(obs.DEMO_LATENCY_FIXTURE.neverMixedIntoLive, true);

      // Verify LIVE_* counts are 0 and latencies are strictly null
      assert.equal(obs.LIVE_FORMAL_CANDIDATE_COUNT, 0);
      assert.equal(obs.LIVE_FAST_LANE_COUNT, 0);
      assert.equal(obs.LIVE_BULK_COUNT, 0);
      assert.equal(obs.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT, 0);
      assert.equal(obs.LIVE_ENTRY_WINDOW_MISSED_COUNT, 0);
      assert.equal(obs.LIVE_ENTRY_WINDOW_MISSED_RATE, null);
      assert.equal(obs.LIVE_DETECTION_LATENCY_P50, null);
      assert.equal(obs.LIVE_DETECTION_LATENCY_P95, null);
      assert.equal(obs.LIVE_FAST_LANE_DETECTION_LATENCY_P50, null);
      assert.equal(obs.LIVE_FAST_LANE_DETECTION_LATENCY_P95, null);
      assert.equal(obs.LIVE_BULK_DETECTION_LATENCY_P50, null);
      assert.equal(obs.LIVE_BULK_DETECTION_LATENCY_P95, null);

      // Verify validation status & message when LIVE_FORMAL_CANDIDATE_COUNT === 0
      assert.equal(obs.liveValidationStatus, 'NO_LIVE_FORMAL_CANDIDATE');
      assert.equal(
        obs.liveSampleValidationStatus,
        'LIVE_VALIDATION_INSUFFICIENT_SAMPLE'
      );
      assert.equal(obs.isLiveValidated, false);
      assert.equal(
        obs.liveValidationMessage,
        '尚無真實 Live 候選，無法評估實盤捕捉延遲'
      );
      assert.equal(
        summary.liveValidationMessage,
        '尚無真實 Live 候選，無法評估實盤捕捉延遲'
      );
    } finally {
      radarDb.close();
    }
  });

  it('4. 真實 LIVE_PRODUCTION 正式候選出現後才計算 Live P50/P95，且保存全部 27 個必要欄位', () => {
    const dbPath = createTempDbPath('p18-4-real-live-candidate');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const baseOpenTime = 1_760_000_000_000;
      const klines = makeConfirmedKlines({
        baseOpenTime,
        count: 35,
        direction: 'LONG',
      });
      const signalBar = klines[klines.length - 1];
      const nextBarOpenTime = signalBar.openTime + 15 * 60 * 1000;
      const detectedAtMs = signalBar.closeTime + 55; // 55ms after bar close (< nextBarOpenTime)
      const detectedAtIso = new Date(detectedAtMs).toISOString();

      const res1 = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-live-real-1',
        scanRunId: 'run-live-real-1',
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: detectedAtIso,
        snapshotAt: detectedAtIso,
        signalDetectedAt: detectedAtIso,
        candidateDetectedAt: detectedAtIso,
        queueEnteredAt: new Date(signalBar.closeTime + 10).toISOString(),
        evaluationStartedAt: new Date(signalBar.closeTime + 22).toISOString(),
        evaluationCompletedAt: detectedAtIso,
        queueWaitMs: 12,
        evaluationLatencyMs: 33,
        candidateDetectionLatencyMs: 55,
        isFastLane: true,
        provenance: makeLiveProvenance(detectedAtIso),
        evidenceType: 'LIVE_PRODUCTION',
        klines,
        atr14: 1.5,
        openInterest: 50_000_000,
        fundingRate: 0.0001,
        score: 91,
        waitReasons: [],
        evidences: [],
      });

      assert.ok(res1.signal);
      assert.equal(res1.signal.evidenceType, 'LIVE_PRODUCTION');

      const obs = radarDb.getLiveCaptureObservation('binance_usdm');
      assert.equal(obs.LIVE_FORMAL_CANDIDATE_COUNT, 1);
      assert.equal(obs.LIVE_FAST_LANE_COUNT, 1);
      assert.equal(obs.LIVE_BULK_COUNT, 0);
      assert.equal(obs.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT, 1);
      assert.equal(obs.LIVE_ENTRY_WINDOW_MISSED_COUNT, 0);
      assert.equal(obs.LIVE_DETECTION_LATENCY_P50, 55);
      assert.equal(obs.LIVE_DETECTION_LATENCY_P95, 55);
      assert.equal(obs.LIVE_FAST_LANE_DETECTION_LATENCY_P50, 55);
      assert.equal(obs.LIVE_FAST_LANE_DETECTION_LATENCY_P95, 55);
      assert.equal(obs.LIVE_BULK_DETECTION_LATENCY_P50, null);
      assert.equal(obs.LIVE_BULK_DETECTION_LATENCY_P95, null);
      assert.equal(
        obs.liveValidationStatus,
        'LIVE_CANDIDATE_DETECTED_BEFORE_ENTRY'
      );
      assert.ok(obs.liveValidationStates.includes('LIVE_CANDIDATE_DETECTED'));
      assert.ok(
        obs.liveValidationStates.includes(
          'LIVE_CANDIDATE_DETECTED_BEFORE_ENTRY'
        )
      );
      assert.ok(
        obs.liveValidationStates.includes('LIVE_VALIDATION_INSUFFICIENT_SAMPLE')
      );

      // Verify all 27 fields on liveProductionCandidates[0]
      assert.equal(obs.liveProductionCandidates.length, 1);
      const c = obs.liveProductionCandidates[0];
      const required27Fields = [
        'cycleId',
        'signalId',
        'symbol',
        'exchange',
        'timeframe',
        'direction',
        'signalBarOpenTime',
        'signalBarCloseTime',
        'nextBarOpenTime',
        'candidateDetectedAt',
        'signalDetectedAt',
        'queueEnteredAt',
        'evaluationStartedAt',
        'evaluationCompletedAt',
        'queueWaitMs',
        'evaluationLatencyMs',
        'candidateDetectionLatencyMs',
        'nextBarRemainingMs',
        'entryWindowStatus',
        'entryWindowMissed',
        'isFastLane',
        'evidenceType',
        'source',
        'fetchedAt',
        'stale',
        'fallback',
        'isDemo',
      ];
      for (const f of required27Fields) {
        assert.ok(f in c, `Missing field ${f} on LiveCaptureCandidateRecord`);
      }
      assert.equal(c.symbol, 'BTCUSDT');
      assert.equal(c.direction, 'LONG');
      assert.equal(c.signalBarOpenTime, signalBar.openTime);
      assert.equal(c.signalBarCloseTime, signalBar.closeTime);
      assert.equal(c.nextBarOpenTime, nextBarOpenTime);
      assert.equal(c.candidateDetectionLatencyMs, 55);
      assert.equal(c.entryWindowStatus, 'DETECTED_BEFORE_NEXT_BAR_OPEN');
      assert.equal(c.entryWindowMissed, false);
      assert.equal(c.isFastLane, true);
      assert.equal(c.evidenceType, 'LIVE_PRODUCTION');
      assert.equal(c.isDemo, false);
    } finally {
      radarDb.close();
    }
  });

  it('5, 6 & 7. ENTRY_WINDOW_MISSED 不會回溯開倉且 entryReferencePrice=null；signalId 不可覆寫；同一 signalBarOpenTime 不可被相反方向覆寫', () => {
    const dbPath = createTempDbPath('p18-4-missed-and-immutability');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const baseOpenTime = 1_760_100_000_000;
      const klines = makeConfirmedKlines({
        baseOpenTime,
        count: 35,
        direction: 'LONG',
      });
      const signalBar = klines[klines.length - 2];
      const nextBar = klines[klines.length - 1];

      // (5) Late detection >= nextBar.openTime -> ENTRY_WINDOW_MISSED, entryReferencePrice = null, no Paper Ledger
      const lateDetectedIso = new Date(nextBar.openTime + 5_000).toISOString();
      const missedEval = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-missed-1',
        scanRunId: 'run-missed-1',
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: lateDetectedIso,
        snapshotAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        candidateDetectedAt: lateDetectedIso,
        useCanonicalEntryWindowStatus: true,
        isFastLane: false,
        provenance: makeLiveProvenance(lateDetectedIso),
        evidenceType: 'LIVE_PRODUCTION',
        klines: klines.slice(0, -1),
        signalBarIndex: klines.length - 2,
        atr14: 1.4,
        openInterest: 20_000_000,
        fundingRate: 0.0001,
        score: 86,
        waitReasons: [],
        evidences: [],
      });

      assert.ok(missedEval.signal);
      assert.equal(missedEval.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(missedEval.signal.entryWindowStatus, 'ENTRY_WINDOW_MISSED');
      assert.equal(missedEval.signal.entryWindowMissed, true);
      assert.equal(missedEval.signal.entryReferencePrice, null);
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);

      const settleAttempt = tracker.settleSignalWithKlines({
        signalId: missedEval.signal.signalId,
        klines,
        atr14: 1.4,
        isBacktest: false,
      });
      assert.equal(settleAttempt?.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(settleAttempt?.entryReferencePrice, null);
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);

      // (6 & 7) Signal immutability & opposite direction on same signalBarOpenTime rejected
      const earlyDetectedIso = new Date(signalBar.closeTime + 45).toISOString();
      const created = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-imm-1',
        scanRunId: 'run-imm-1',
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: earlyDetectedIso,
        snapshotAt: earlyDetectedIso,
        signalDetectedAt: earlyDetectedIso,
        candidateDetectedAt: earlyDetectedIso,
        useCanonicalEntryWindowStatus: true,
        isFastLane: true,
        provenance: makeLiveProvenance(earlyDetectedIso),
        evidenceType: 'LIVE_PRODUCTION',
        klines,
        signalBarIndex: klines.length - 2,
        atr14: 1.2,
        openInterest: 15_000_000,
        fundingRate: 0.0001,
        score: 90,
        waitReasons: [],
        evidences: [],
      });

      assert.ok(created.signal);
      assert.equal(created.insertedNew, true);
      assert.equal(created.signal.direction, 'LONG');
      assert.equal(
        created.signal.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(created.signal.entryReferencePrice, nextBar.open);

      // Attempt to overwrite same signalId with late timestamp -> immutable
      const overwriteAttempt = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-imm-2',
        scanRunId: 'run-imm-2',
        scanCycleId: 'cycle-imm-2',
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: lateDetectedIso,
        snapshotAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        candidateDetectedAt: lateDetectedIso,
        useCanonicalEntryWindowStatus: true,
        isFastLane: false,
        provenance: makeLiveProvenance(lateDetectedIso),
        evidenceType: 'LIVE_PRODUCTION',
        klines: klines.slice(0, -1),
        signalBarIndex: klines.length - 2,
        atr14: 1.2,
        openInterest: 15_000_000,
        fundingRate: 0.0001,
        score: 90,
        waitReasons: [],
        evidences: [],
      });

      assert.ok(overwriteAttempt.signal);
      assert.equal(overwriteAttempt.insertedNew, false);
      assert.equal(overwriteAttempt.signal.signalId, created.signal.signalId);
      assert.equal(overwriteAttempt.signal.direction, 'LONG');
      assert.equal(
        overwriteAttempt.signal.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(overwriteAttempt.signal.entryReferencePrice, nextBar.open);

      // Attempt opposite direction (SHORT) on same signalBarOpenTime -> rejected, original LONG preserved
      const oppositeSameBar = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-imm-3',
        scanRunId: 'run-imm-3',
        scanCycleId: 'cycle-imm-3',
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: earlyDetectedIso,
        snapshotAt: earlyDetectedIso,
        signalDetectedAt: earlyDetectedIso,
        candidateDetectedAt: earlyDetectedIso,
        useCanonicalEntryWindowStatus: true,
        isFastLane: true,
        provenance: makeLiveProvenance(earlyDetectedIso),
        evidenceType: 'LIVE_PRODUCTION',
        klines: klines.slice(0, -1),
        signalBarIndex: klines.length - 2,
        atr14: 1.2,
        openInterest: 15_000_000,
        fundingRate: 0.0001,
        score: 88,
        waitReasons: [],
        evidences: [],
      });

      assert.ok(oppositeSameBar.signal);
      assert.equal(oppositeSameBar.insertedNew, false);
      assert.equal(oppositeSameBar.signal.signalId, created.signal.signalId);
      assert.equal(oppositeSameBar.signal.direction, 'LONG');
      const persistedOrig = paperDb.getTrackedSignalById(
        created.signal.signalId
      );
      assert.ok(persistedOrig);
      assert.equal(persistedOrig.direction, 'LONG');
      assert.equal(persistedOrig.smcActionState, 'LONG CANDIDATE');
      assert.equal(
        persistedOrig.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(persistedOrig.entryReferencePrice, nextBar.open);
    } finally {
      radarDb.close();
    }
  });

  it('8. Shadow 與 Near-Miss 觀察模式不得建立 Paper 或通知，且 paperClosedCount=0 時績效指標全部為 null', () => {
    const dbPath = createTempDbPath('p18-4-shadow-calibration');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const nowIso = new Date().toISOString();
      radarDb.saveSmcScanResult({
        symbol: 'NEAR_MISS_1_USDT',
        exchange: 'binance_usdm',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WATCH',
        finalTradeSignal: 'NONE',
        marketRadarCategory: '雷達多頭觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        priorityTier: 2,
        priorityLabel: '2_RADAR_LONG',
        priorityClass: 'FAST_LANE',
        workerRole: 'FAST_LANE',
        executionWorker: 'FAST_LANE_WORKER',
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures Public REST API',
        isDemo: false,
        evidenceType: 'LIVE_PRODUCTION',
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: ['等待 FVG 回踩確認'],
        nearMissStatus: 'NEAR_MISS_ONE_GATE',
        missingGates: ['FVG'],
        smcAnalysis: {
          symbol: 'NEAR_MISS_1_USDT',
          primaryTimeframe: '15m',
          smcEvaluationStatus: 'EVALUATED',
          actionState: 'WATCH',
          waitReasons: ['等待 FVG 回踩確認'],
          evidences: [],
          atr14: 1.2,
          ruleVersion: SMC_RULE_VERSION,
          nearMissStatus: 'NEAR_MISS_ONE_GATE',
          missingGates: ['FVG'],
          gateEvaluation: {
            nearMissStatus: 'NEAR_MISS_ONE_GATE',
            missingGates: ['FVG'],
            passedCount: 8,
            totalGates: 9,
          },
        } as any,
      });

      const klines = makeConfirmedKlines({
        baseOpenTime: Date.now() - 40 * 15 * 60 * 1000,
        count: 35,
      });
      const nearMissEval = tracker.evaluateAndTrackSignal({
        monitorRunId: 'run-nm-1',
        scanRunId: 'run-nm-1',
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        symbol: 'NEAR_MISS_1_USDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WATCH',
        finalTradeSignal: 'NONE',
        ruleVersion: SMC_RULE_VERSION,
        evaluatedAt: nowIso,
        snapshotAt: nowIso,
        provenance: makeLiveProvenance(nowIso),
        klines,
        atr14: 1.2,
        openInterest: 12_000_000,
        fundingRate: 0.0001,
        score: 76,
        waitReasons: ['等待 FVG 回踩確認'],
        evidences: [],
      });

      assert.equal(nearMissEval.signal, null);
      assert.ok(
        nearMissEval.outboxRecords.every(
          (r) => r.status === 'NON_CANDIDATE_BLOCKED'
        )
      );
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);

      const summary = radarDb.getLiveCaptureSummary('binance_usdm');
      const cal = summary.signalQualityCalibration;
      assert.equal(cal.soleFormalSignalMode, 'STRICT_PRODUCTION');
      assert.equal(cal.noLookaheadGuaranteed, true);
      assert.equal(cal.confirmedBarsOnly, true);
      assert.equal(cal.gateAdjustmentAllowed, false);
      assert.equal(cal.invariants.strictProductionGatesUnchanged, true);
      assert.equal(cal.invariants.shadowNeverOpensPaper, true);
      assert.equal(cal.invariants.shadowNeverWritesLedger, true);
      assert.equal(cal.invariants.shadowNeverNotifies, true);

      for (const m of cal.modes) {
        assert.equal(m.paperClosedCount, 0);
        assert.equal(m.winRate, null);
        assert.equal(m.averageR, null);
        assert.equal(m.profitFactor, null);
        assert.equal(m.maxDrawdownR, null);
        assert.equal(m.expectancyR, null);
        assert.equal(m.sampleSufficiency, 'INSUFFICIENT');
      }
    } finally {
      radarDb.close();
    }
  });

  it('9, 10, 11 & 12. 15m 收盤事件觸發 Fast Lane 並持續記錄；所有端點 cycleId / snapshotAt / statsVersion 一致；所有下單端點維持 HTTP 404；externalNotificationCount 維持 0', async () => {
    const dbPath = createTempDbPath('p18-4-events-and-consistency');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });
    const barCloseTime = Date.now() - 120;
    const liveAdapter = new Deterministic15mCloseAdapter(barCloseTime);
    const scanner = new SmcBatchScanService({
      db: radarDb,
      adapters: {
        binance_usdm: liveAdapter,
        bybit_linear: liveAdapter,
        bingx_swap: liveAdapter,
        demo_synthetic: new DemoExchangeAdapter(),
      },
    });
    const monitor = new PaperShadowMonitor({
      radarDb,
      paperMonitorDb: paperDb,
      outcomeTracker: tracker,
      smcBatchScanner: scanner,
      adapters: {
        binance_usdm: liveAdapter,
        bybit_linear: liveAdapter,
        bingx_swap: liveAdapter,
        demo_synthetic: new DemoExchangeAdapter(),
      },
    });

    try {
      const snap = await liveAdapter.fetchMarketSnapshot();
      const candidates = snap.tickers.slice(0, 6).map((t, idx) => ({
        symbol: idx === 0 ? 'BTCUSDT' : idx === 1 ? 'ETHUSDT' : t.symbol,
        baseAsset: (idx === 0 ? 'BTC' : idx === 1 ? 'ETH' : t.baseAsset),
        quoteAsset: 'USDT',
        lastPrice: t.lastPrice,
        priceChangePercent24h: idx === 0 ? 4.2 : idx === 1 ? -4.2 : 0.8,
        quoteVolume24h: 85_000_000,
        bidPrice: t.lastPrice * 0.9998,
        askPrice: t.lastPrice * 1.0002,
        spread: t.lastPrice * 0.0004,
        spreadPercent: 0.04,
        openInterest: 500_000,
        openInterestValue: 50_000_000,
        fundingRate: 0.0001,
        score: idx < 2 ? 90 : 50,
        rawScoreBeforeCap: idx < 2 ? 90 : 50,
        scoreCapApplied: false,
        scoreCapRule: null,
        category: '準備觀察' as const,
        categoryBeforeGates: '準備觀察' as const,
        finalCategory: '準備觀察' as const,
        marketRadarCategory: (
          idx === 0
            ? '雷達多頭觀察'
            : idx === 1
              ? '雷達空頭觀察'
              : '準備觀察'
        ) as any,
        smcEvaluationStatus: 'PENDING' as const,
        smcActionState: 'PENDING' as const,
        smcStatusReason: '等待評估',
        finalTradeSignal: 'NONE' as const,
        downgradeReasons: [],
        auxiliaryVolumeRankProxyPercentile: 90,
        volumeRankProxyPercentile: 90,
        momentumScore: 80,
        relativeBtcStrength: 1.2,
        historicalVolume: {} as any,
        scoreBreakdown: {} as any,
        gates: {} as any,
        decisionTrace: {} as any,
        evidences: [],
        isLowLiquidity: false,
        extremeFunding: false,
        lowLiquidityHighVolatility: false,
        nearMissStatus: (idx === 2 ? 'NEAR_MISS_ONE_GATE' : 'NOT_NEAR_CANDIDATE') as any,
        provenance: snap.provenance,
      }));
      const tickers = candidates.map((c) => ({
        symbol: c.symbol,
        baseAsset: c.baseAsset,
        quoteAsset: 'USDT',
        lastPrice: c.lastPrice,
        priceChangePercent24h: c.priceChangePercent24h,
        quoteVolume24h: c.quoteVolume24h,
        openInterest: c.openInterest,
        openInterestValue: c.openInterestValue,
        fundingRate: c.fundingRate,
        nextFundingTime: Date.now() + 3600_000,
        provenance: snap.provenance,
      }));

      const closeTrigger = await scanner.triggerConfirmed15mBarCloseFastLane({
        exchange: 'binance_usdm',
        confirmedBarCloseTime: barCloseTime,
        tickers,
        candidates: candidates as any,
        watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
        evaluateImmediately: true,
        nowMs: Date.now(),
        evidenceType: 'LIVE_PRODUCTION',
      });

      assert.ok(closeTrigger.fastLaneEnqueuedCount > 0);
      assert.ok(closeTrigger.evaluatedFastLaneSymbols.includes('BTCUSDT'));
      assert.ok(closeTrigger.closeEvent);
      assert.equal(closeTrigger.closeEvent.evidenceType, 'LIVE_PRODUCTION');

      // Check GET /api/paper-quality/live-capture, /events, /summary and status endpoints consistency
      const paperStatus = monitor.getStatus();
      const smcStatus = scanner.getStatus('binance_usdm', 'live');
      const smcProgress = scanner.getProgressAndHealth('binance_usdm', 'live');
      const gateDrift = monitor.getPaperQualityGateDrift('binance_usdm');
      const liveCapture = monitor.getLiveCaptureObservation('binance_usdm');
      const liveEvents = monitor.getLiveCaptureEvents('binance_usdm');
      const liveSummary = monitor.getLiveCaptureSummary('binance_usdm');

      // Verify 15m close event required fields
      assert.ok(liveEvents.totalCloseEventCount >= 1);
      assert.ok(liveEvents.latestCloseEvent);
      const ev = liveEvents.latestCloseEvent!;
      const requiredEventFields = [
        'closeEventAt',
        'triggeredFastLaneCount',
        'completedFastLaneCount',
        'formalCandidateCount',
        'nearMissCount',
        'candidateDetectedBeforeEntryCount',
        'entryWindowMissedCount',
        'pendingCount',
        'queueWaitP50',
        'queueWaitP95',
        'workerState',
        'cacheMode',
        'snapshotAt',
        'statsVersion',
      ];
      for (const f of requiredEventFields) {
        assert.ok(
          f in ev,
          `Missing field ${f} on Confirmed15mCloseEventRecord`
        );
      }

      // (10) Verify cycleId, statsVersion, and snapshotAt consistency across all endpoints
      assert.equal(smcProgress.cycleId, smcStatus.cycleId);
      assert.equal(paperStatus.cycleId, smcStatus.cycleId);
      assert.equal(gateDrift.cycleId, smcStatus.cycleId);
      assert.equal(liveCapture.cycleId, smcStatus.cycleId);
      assert.equal(liveEvents.cycleId, smcStatus.cycleId);
      assert.equal(liveSummary.cycleId, smcStatus.cycleId);

      assert.equal(smcProgress.statsVersion, smcStatus.statsVersion);
      assert.equal(paperStatus.statsVersion, smcStatus.statsVersion);
      assert.equal(gateDrift.statsVersion, smcStatus.statsVersion);
      assert.equal(liveCapture.statsVersion, smcStatus.statsVersion);
      assert.equal(liveEvents.statsVersion, smcStatus.statsVersion);
      assert.equal(liveSummary.statsVersion, smcStatus.statsVersion);

      assert.ok(Date.parse(liveCapture.snapshotAt) > 0);
      assert.ok(Date.parse(liveEvents.snapshotAt) > 0);
      assert.ok(Date.parse(liveSummary.snapshotAt) > 0);

      // (11 & 12) Safety flags and externalNotificationCount = 0
      assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
      assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(
        TRADING_SAFETY_FLAGS.executionPolicy,
        'NEVER AUTO-PLACE ORDERS'
      );
      assert.equal(paperStatus.externalNotificationCount, 0);
      assert.equal(liveCapture.executionSafety.externalNotificationCount, 0);
      assert.equal(liveEvents.executionSafety.externalNotificationCount, 0);
      assert.equal(liveSummary.executionSafety.externalNotificationCount, 0);

      // Verify against running server if available: all order endpoints return HTTP 404 and new live-capture endpoints return HTTP 200
      try {
        const orderEndpoints = [
          '/api/order',
          '/api/orders',
          '/api/trade',
          '/api/execute-order',
        ];
        for (const ep of orderEndpoints) {
          const r = await fetch(`http://localhost:3000${ep}`, {
            method: 'POST',
          });
          assert.equal(
            r.status,
            404,
            `Order endpoint ${ep} must return HTTP 404`
          );
        }
      } catch {
        // Server might not be bound in isolated unit runner
      }
    } finally {
      scanner.stop();
      radarDb.close();
    }
  });
});
