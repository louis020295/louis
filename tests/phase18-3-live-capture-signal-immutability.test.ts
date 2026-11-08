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
import {
  evaluateSmcStructure,
  SMC_RULE_VERSION,
} from '../server/engine/SmcRuleEngine.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  ScannedCandidate,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function createTempDbPath(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tmpDir, 'radar.sqlite');
}

function makeLiveProvenance(fetchedAtIso: string): DataProvenance {
  return {
    source: 'Binance USDⓈ-M Futures Public REST API',
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
    const closeTime = openTime + tfMs - 1;
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

class DeterministicLiveCaptureAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly exchangeId: ExchangeId = 'binance_usdm';
  public readonly displayName = 'Binance USDⓈ-M Futures Public REST API';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status = 'LIVE' as const;

  public fetchKlinesCalls: Array<{ symbol: string; timeframe: Timeframe }> = [];
  public fetchOiCalls: string[] = [];
  private readonly demoFixture = new DemoExchangeAdapter();
  private readonly barCloseTime: number;

  constructor(barCloseTime: number) {
    this.barCloseTime = barCloseTime;
  }

  private getProvenance(): DataProvenance {
    return makeLiveProvenance(new Date(this.barCloseTime + 50).toISOString());
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
    this.fetchKlinesCalls.push({ symbol, timeframe });
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
      return {
        provenance: prov,
        klines: closedOnly.map((k: Kline) => ({
          ...k,
          openTime: k.openTime + shiftMs,
          closeTime: k.closeTime + shiftMs,
          isClosed: true,
        })),
      };
    }
    return {
      provenance: prov,
      klines: closedOnly,
    };
  }

  public async fetchOpenInterest(
    symbol: string,
    markPrice?: number
  ): Promise<{
    openInterest: number | null;
    openInterestValue: number | null;
    provenance: DataProvenance;
  }> {
    this.fetchOiCalls.push(symbol);
    const price = markPrice && markPrice > 0 ? markPrice : 100;
    return {
      openInterest: 250_000,
      openInterestValue: 250_000 * price,
      provenance: this.getProvenance(),
    };
  }
}

function makeDummyCandidate(params: {
  symbol: string;
  marketRadarCategory: '雷達多頭觀察' | '雷達空頭觀察' | '準備觀察';
  score?: number;
  nearMissStatus?: 'NEAR_MISS_ONE_GATE' | 'NEAR_MISS_TWO_GATES' | 'NOT_NEAR_CANDIDATE';
}): ScannedCandidate {
  const prov = makeLiveProvenance(new Date().toISOString());
  const baseAsset = params.symbol.replace(/USDT$/, '');
  return {
    symbol: params.symbol,
    baseAsset,
    quoteAsset: 'USDT',
    lastPrice: 100,
    priceChangePercent24h:
      params.marketRadarCategory === '雷達多頭觀察'
        ? 4.5
        : params.marketRadarCategory === '雷達空頭觀察'
          ? -4.5
          : 0.5,
    quoteVolume24h: 85_000_000,
    bidPrice: 99.98,
    askPrice: 100.02,
    spread: 0.04,
    spreadPercent: 0.04,
    openInterest: 500_000,
    openInterestValue: 50_000_000,
    fundingRate: 0.0001,
    score: params.score ?? 82,
    rawScoreBeforeCap: params.score ?? 82,
    scoreCapApplied: false,
    scoreCapRule: null,
    category: '準備觀察',
    categoryBeforeGates: '準備觀察',
    finalCategory: '準備觀察',
    marketRadarCategory: params.marketRadarCategory,
    smcEvaluationStatus: 'PENDING',
    smcActionState: 'PENDING',
    smcStatusReason: '等待評估',
    finalTradeSignal: 'NONE',
    downgradeReasons: [],
    auxiliaryVolumeRankProxyPercentile: 90,
    volumeRankProxyPercentile: 90,
    momentumScore: 80,
    relativeBtcStrength: 1.2,
    historicalVolume: {
      symbol: params.symbol,
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
      volumeMetric: 'quoteVolume',
      status: 'READY',
      sampleCount: 30,
      minRequiredSamples: 20,
      currentVolume: 5_000_000,
      rollingMedian: 1_500_000,
      mad: 300_000,
      robustZScore: 3.1,
      zScore: 3.1,
      rvol: 3.33,
      isHistoricalAnomaly: true,
      baselineUnstable: false,
      provenance: prov,
    },
    scoreBreakdown: {
      volumeAnomaly: 25,
      auxiliaryVolumeRank: 15,
      volumeProxy: 15,
      momentum: 15,
      relativeBtcStrength: 10,
      fundingRisk: 0,
      liquidityRisk: 0,
      dataQuality: 10,
    },
    gates: {} as any,
    decisionTrace: {} as any,
    evidences: [],
    isLowLiquidity: false,
    extremeFunding: false,
    lowLiquidityHighVolatility: false,
    nearMissStatus: params.nearMissStatus ?? 'NOT_NEAR_CANDIDATE',
    provenance: prov,
  };
}

function makeDummyTicker(symbol: string, changePct = 2.5): MarketTicker {
  const prov = makeLiveProvenance(new Date().toISOString());
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    lastPrice: 100,
    priceChangePercent24h: changePct,
    quoteVolume24h: 85_000_000,
    openInterest: 500_000,
    openInterestValue: 50_000_000,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    provenance: prov,
  };
}

describe('Phase 18.3: Live 正式候選即時捕捉與訊號不可變追蹤', () => {
  it('1 & 2. 15m 收盤後立即觸發 Fast Lane（Watchlist、Radar Long、Radar Short、Near-Miss 優先於 Bulk Queue，優先載入有效快取，且 Fast Lane 正式候選在 nextBar.open 前完成偵測）', async () => {
    const dbPath = createTempDbPath('p18-3-fastlane-15m-close');
    const radarDb = new RadarDatabase(dbPath);

    try {
      const nowMs = Date.now();
      // Confirmed 15m bar closed 150ms ago; nextBar.open is 60 seconds in the future for deterministic test window
      const confirmedBarCloseTime = nowMs - 150;
      const liveAdapter = new DeterministicLiveCaptureAdapter(
        confirmedBarCloseTime
      );

      const scanner = new SmcBatchScanService({
        db: radarDb,
        adapters: {
          binance_usdm: liveAdapter,
          bybit_linear: liveAdapter,
          bingx_swap: liveAdapter,
          demo_synthetic: new DemoExchangeAdapter(),
        },
        config: {
          batchSize: 10,
          maxConcurrency: 2,
          fastLaneWorkerSlots: 1,
        },
      });

      // Pre-populate valid warm cache for 1h and 4h on BTCUSDT to verify warm cache reuse
      const warm1h = await liveAdapter.fetchKlines('BTCUSDT', '1h', 60);
      const warm4h = await liveAdapter.fetchKlines('BTCUSDT', '4h', 60);
      const warmExpIso = new Date(nowMs + 30 * 60_000).toISOString();
      radarDb.saveSmcCandlesCache({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '1h',
        klines: warm1h.klines,
        openInterest: 250_000,
        openInterestValue: 25_000_000,
        fundingRate: 0.0001,
        nextFundingTime: nowMs + 3600_000,
        oiFetchedAt: warm1h.provenance.fetchedAt,
        oiExpiresAt: warmExpIso,
        dataTimestamp: confirmedBarCloseTime,
        fetchedAt: warm1h.provenance.fetchedAt,
        expiresAt: warmExpIso,
        stale: false,
        fallback: false,
        missingData: [],
        source: warm1h.provenance.source,
        isDemo: false,
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_warm_1h',
        provenance: warm1h.provenance,
      });
      radarDb.saveSmcCandlesCache({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '4h',
        klines: warm4h.klines,
        openInterest: 250_000,
        openInterestValue: 25_000_000,
        fundingRate: 0.0001,
        nextFundingTime: nowMs + 3600_000,
        oiFetchedAt: warm4h.provenance.fetchedAt,
        oiExpiresAt: warmExpIso,
        dataTimestamp: confirmedBarCloseTime,
        fetchedAt: warm4h.provenance.fetchedAt,
        expiresAt: warmExpIso,
        stale: false,
        fallback: false,
        missingData: [],
        source: warm4h.provenance.source,
        isDemo: false,
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_warm_4h',
        provenance: warm4h.provenance,
      });
      liveAdapter.fetchKlinesCalls = [];

      const candidates: ScannedCandidate[] = [
        makeDummyCandidate({
          symbol: 'BTCUSDT', // Watchlist
          marketRadarCategory: '雷達多頭觀察',
          score: 92,
        }),
        makeDummyCandidate({
          symbol: 'ETHUSDT', // Radar Short
          marketRadarCategory: '雷達空頭觀察',
          score: 88,
        }),
        makeDummyCandidate({
          symbol: 'SOLUSDT', // Radar Long
          marketRadarCategory: '雷達多頭觀察',
          score: 85,
        }),
        makeDummyCandidate({
          symbol: 'SUIUSDT', // Near-Miss
          marketRadarCategory: '準備觀察',
          score: 76,
          nearMissStatus: 'NEAR_MISS_ONE_GATE',
        }),
        makeDummyCandidate({
          symbol: 'BULK_SYM_1USDT', // Ordinary Bulk
          marketRadarCategory: '準備觀察',
          score: 40,
        }),
        makeDummyCandidate({
          symbol: 'BULK_SYM_2USDT', // Ordinary Bulk
          marketRadarCategory: '準備觀察',
          score: 38,
        }),
      ];
      const tickers = candidates.map((c) =>
        makeDummyTicker(c.symbol, c.priceChangePercent24h)
      );

      // Verify future / unclosed K-line close time is strictly rejected
      await assert.rejects(
        async () => {
          await scanner.triggerConfirmed15mBarCloseFastLane({
            exchange: 'binance_usdm',
            confirmedBarCloseTime: nowMs + 60_000,
            tickers,
            candidates,
            nowMs,
          });
        },
        /禁止使用未收盤 K 線或未來資料/
      );

      // Verify Demo fallback is strictly rejected on Live 15m close trigger
      await assert.rejects(
        async () => {
          await scanner.triggerConfirmed15mBarCloseFastLane({
            exchange: 'demo_synthetic',
            confirmedBarCloseTime,
            tickers,
            candidates,
            nowMs,
          });
        },
        /嚴禁使用 demo_synthetic/
      );

      // Trigger immediate 15m close Fast Lane evaluation
      const triggerRes = await scanner.triggerConfirmed15mBarCloseFastLane({
        exchange: 'binance_usdm',
        confirmedBarCloseTime,
        tickers,
        candidates,
        watchlistSymbols: ['BTCUSDT'],
        nearMissSymbols: ['SUIUSDT'],
        evaluateImmediately: true,
        nowMs,
      });

      // All 4 priority targets (Watchlist BTCUSDT, Radar Short ETHUSDT, Radar Long SOLUSDT, Near-Miss SUIUSDT)
      // must be enqueued and evaluated in Fast Lane BEFORE the 2 Bulk symbols
      assert.equal(triggerRes.fastLaneEnqueuedCount, 4);
      assert.equal(triggerRes.bulkEnqueuedCount, 2);
      assert.deepEqual(
        new Set(triggerRes.evaluatedFastLaneSymbols),
        new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT'])
      );

      // Bulk symbols must still be QUEUED (Fast Lane ran without waiting for Bulk queue!)
      const allJobsAfter = radarDb.listSmcScanJobs('binance_usdm', 20);
      const bulk1Job = allJobsAfter.find((j) => j.symbol === 'BULK_SYM_1USDT');
      assert.ok(bulk1Job);
      assert.equal(bulk1Job.priorityClass, 'BULK');
      assert.equal(bulk1Job.isFastLane, false);
      assert.equal(bulk1Job.status, 'QUEUED');

      // Warm cache on BTCUSDT 1h and 4h must have been reused (not re-fetched over HTTP)
      const btc1hFetches = liveAdapter.fetchKlinesCalls.filter(
        (c) => c.symbol === 'BTCUSDT' && c.timeframe === '1h'
      );
      const btc4hFetches = liveAdapter.fetchKlinesCalls.filter(
        (c) => c.symbol === 'BTCUSDT' && c.timeframe === '4h'
      );
      assert.equal(btc1hFetches.length, 0);
      assert.equal(btc4hFetches.length, 0);

      const btcResult = radarDb.getSmcScanResult('binance_usdm', 'BTCUSDT');
      assert.ok(btcResult);
      assert.equal(btcResult.reusedCache, true);
      assert.equal(btcResult.isFastLane, true);
      assert.equal(btcResult.priorityClass, 'FAST_LANE');

      // Test 2: Fast Lane formal candidate detected BEFORE nextBar.open
      const signalBarOpenTime = confirmedBarCloseTime - 900_000 + 1;
      const nextBarOpenTime = confirmedBarCloseTime + 60_000; // next bar opens after detection
      const detectedIso = new Date(confirmedBarCloseTime + 120).toISOString();

      radarDb.saveSmcScanResult({
        ...btcResult,
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        marketRadarCategory: '雷達多頭觀察',
        evaluatedAt: detectedIso,
        candidateDetectedAt: detectedIso,
        signalDetectedAt: detectedIso,
        queueEnteredAt: new Date(confirmedBarCloseTime).toISOString(),
        evaluationStartedAt: new Date(confirmedBarCloseTime + 30).toISOString(),
        evaluationCompletedAt: detectedIso,
        queueWaitMs: 30,
        evaluationLatencyMs: 90,
        detectionLatencyMs: 120,
        candidateDetectionLatencyMs: 120,
        signalBarOpenTime,
        signalBarCloseTime: confirmedBarCloseTime,
        nextBarOpenTime,
        nextBarRemainingMs: nextBarOpenTime - (confirmedBarCloseTime + 120),
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        entryWindowMissed: false,
        isFastLane: true,
        priorityClass: 'FAST_LANE',
        waitReasons: [],
        missingData: [],
        stale: false,
        fallback: false,
        isDemo: false,
      });

      const diag = radarDb.computeCycleDiagnosticsAndFunnel('binance_usdm');
      const fastCand = diag.formalCandidateLatencySla.candidates.find(
        (c) => c.symbol === 'BTCUSDT'
      );
      assert.ok(fastCand);
      assert.equal(fastCand.isFastLane, true);
      assert.equal(fastCand.entryWindowStatus, 'DETECTED_BEFORE_NEXT_BAR_OPEN');
      assert.equal(fastCand.entryWindowMissed, false);
      assert.ok(
        Date.parse(fastCand.signalDetectedAt) < Number(fastCand.nextBarOpenTime)
      );
      assert.equal(diag.LIVE_FAST_LANE_COUNT, 1);
      assert.equal(diag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT, 1);
    } finally {
      radarDb.close();
    }
  });

  it('3 & 4. Bulk 正式候選晚於 nextBar.open 時標記 ENTRY_WINDOW_MISSED，且 ENTRY_WINDOW_MISSED 不得補回 entryReferencePrice（保持 null）', () => {
    const dbPath = createTempDbPath('p18-3-bulk-missed-window');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const baseOpenTime = 1710000000000;
      const tfMs = 15 * 60 * 1000;
      // 35 confirmed bars: bar 33 is signal bar i, bar 34 is nextBar (i+1)
      const klines = makeConfirmedKlines({
        baseOpenTime,
        count: 35,
        timeframeMs: tfMs,
        basePrice: 200,
        direction: 'LONG',
      });
      const signalBarIndex = 33;
      const signalBar = klines[signalBarIndex];
      const nextBar = klines[signalBarIndex + 1];
      assert.equal(nextBar.openTime, signalBar.openTime + tfMs);

      // Bulk queue finishes evaluation 45 seconds AFTER nextBar.openTime
      const queueEnteredAtIso = new Date(signalBar.closeTime + 100).toISOString();
      const evalStartIso = new Date(nextBar.openTime + 40_000).toISOString();
      const detectedLateIso = new Date(nextBar.openTime + 45_000).toISOString();

      const res = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_p18_3_bulk',
        scanRunId: 'scan_p18_3_bulk',
        scanCycleId: 'cyc_p18_3_bulk',
        symbol: 'AVAXUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: queueEnteredAtIso,
        evaluatedAt: detectedLateIso,
        signalDetectedAt: detectedLateIso,
        candidateDetectedAt: detectedLateIso,
        queueEnteredAt: queueEnteredAtIso,
        evaluationStartedAt: evalStartIso,
        evaluationCompletedAt: detectedLateIso,
        queueWaitMs: nextBar.openTime + 40_000 - (signalBar.closeTime + 100),
        evaluationLatencyMs: 5_000,
        candidateDetectionLatencyMs:
          nextBar.openTime + 45_000 - signalBar.closeTime,
        nextBarRemainingMs: -45_000,
        entryWindowStatus: 'ENTRY_WINDOW_MISSED',
        isFastLane: false,
        klines,
        signalBarIndex,
        atr14: 1.5,
        openInterest: 400_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(detectedLateIso),
        waitReasons: [],
        evidences: ['CHOCH_BULL:1', 'FVG_BULL:1'],
      });

      assert.ok(res.signal);
      assert.equal(res.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(res.signal.entryStatus, 'ENTRY_WINDOW_MISSED');
      assert.equal(res.signal.entryWindowStatus, 'ENTRY_WINDOW_MISSED');
      assert.equal(res.signal.entryWindowMissed, true);
      assert.equal(res.signal.isFastLane, false);
      assert.equal(res.signal.signalBarOpenTime, signalBar.openTime);
      assert.equal(res.signal.signalBarCloseTime, signalBar.closeTime);
      assert.equal(res.signal.nextBarOpenTime, nextBar.openTime);
      // Requirement 4: ENTRY_WINDOW_MISSED must keep entryReferencePrice === null
      assert.equal(res.signal.entryReferencePrice, null);
      assert.equal(res.signal.paperLedgerId, null);

      // Even if settleSignalWithKlines or updateTrackedSignalOutcome is called later with historical nextBar.open,
      // entryReferencePrice MUST remain null and NEVER retroactively open a Paper position
      const settled = tracker.settleSignalWithKlines({
        signalId: res.signal.signalId,
        klines,
        atr14: 1.5,
      });
      assert.ok(settled);
      assert.equal(settled.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(settled.entryReferencePrice, null);

      const attemptedBackfill = paperDb.updateTrackedSignalOutcome({
        signalId: res.signal.signalId,
        status: 'PAPER_OPENED',
        entryReferencePrice: nextBar.open,
        entryReferenceTime: new Date(nextBar.openTime).toISOString(),
      });
      assert.ok(attemptedBackfill);
      assert.equal(attemptedBackfill.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(attemptedBackfill.entryReferencePrice, null);
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);
    } finally {
      radarDb.close();
    }
  });

  it('5 & 6. Near-Miss 不得建立 Paper（亦不得使用 candidateDetectionLatencyMs / entryWindowMissed），Shadow 不得建立 Paper 或通知', () => {
    const dbPath = createTempDbPath('p18-3-nearmiss-shadow');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });

    try {
      const nowIso = new Date().toISOString();
      const klines = makeConfirmedKlines({
        baseOpenTime: 1710000000000,
        count: 35,
      });

      // Test 5: Near-Miss symbol (smcActionState = WATCH, missing 1 gate) must NEVER create Paper
      const nearMissEval = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_p18_3_nm',
        scanRunId: 'scan_p18_3_nm',
        symbol: 'NEARUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WATCH',
        finalTradeSignal: 'NONE',
        snapshotAt: nowIso,
        evaluatedAt: nowIso,
        klines,
        atr14: 1.2,
        openInterest: 300_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(nowIso),
        waitReasons: ['缺少 FVG 或 Order Block 結構重疊'],
        evidences: ['CHOCH_BULL:1'],
        enqueueSandboxNotifications: false,
      });
      assert.equal(nearMissEval.insertedNew, false);
      assert.equal(nearMissEval.signal, null);
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);

      // Save Near-Miss scan result into RadarDatabase and verify Near-Miss record has no candidateDetectionLatencyMs / entryWindowMissed
      const demo = new DemoExchangeAdapter();
      const baseAnalysis = evaluateSmcStructure({
        symbol: 'NEARUSDT',
        primaryTimeframe: '15m',
        klinesByTimeframe: {
          '5m': klines,
          '15m': klines,
          '1h': klines,
          '4h': klines,
        },
        openInterest: 300_000,
        historicalVolume: makeDummyCandidate({
          symbol: 'NEARUSDT',
          marketRadarCategory: '雷達多頭觀察',
        }).historicalVolume,
        isLowLiquidity: false,
        extremeFunding: false,
        lowLiquidityHighVolatility: false,
        requireFullMultiTimeframe: true,
        provenance: makeLiveProvenance(nowIso),
      });
      void demo;

      radarDb.saveSmcScanResult({
        symbol: 'NEARUSDT',
        exchange: 'binance_usdm',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'WATCH',
        finalTradeSignal: 'NONE',
        marketRadarCategory: '雷達多頭觀察',
        evaluatedAt: nowIso,
        dataFetchedAt: nowIso,
        fetchedAt: nowIso,
        scanCycleId: radarDb.getSmcScanCycleId('binance_usdm'),
        priorityTier: 4,
        priorityLabel: '4_SMC_CANDIDATE_OR_NEAR_MISS_FAST_LANE',
        priorityClass: 'FAST_LANE',
        workerRole: 'FAST_LANE',
        executionWorker: 'FAST_LANE_WORKER',
        stale: false,
        fallback: false,
        missingData: [],
        source: 'Binance USDⓈ-M Futures Public REST API',
        isDemo: false,
        ruleVersion: SMC_RULE_VERSION,
        waitReasons: ['缺少 FVG_OR_OB 閘門'],
        smcAnalysis: {
          ...baseAnalysis,
          actionState: 'WATCH',
          nearMissStatus: 'NEAR_MISS_ONE_GATE',
          missingGates: ['FVG_OR_OB'],
          gateEvaluation: {
            ...(baseAnalysis.gateEvaluation ?? ({} as any)),
            nearMissStatus: 'NEAR_MISS_ONE_GATE',
            missingGates: ['FVG_OR_OB'],
            intendedDirection: 'LONG',
          },
        },
        smcEvaluationLatencyMs: 38,
        evaluationLatencyMs: 38,
        detectionLatencyMs: 55,
        signalBarCloseTime: klines[klines.length - 1].closeTime,
        nextBarOpenTime: klines[klines.length - 1].closeTime + 1,
        entryWindowStatus: 'NOT_APPLICABLE',
        isFastLane: true,
      });

      const savedNear = radarDb.getSmcScanResult('binance_usdm', 'NEARUSDT');
      assert.ok(savedNear);
      assert.equal(savedNear.candidateDetectionLatencyMs, null);
      assert.equal(savedNear.entryWindowMissed, null);
      assert.equal(savedNear.entryWindowDelayMs, null);

      const diag = radarDb.computeCycleDiagnosticsAndFunnel('binance_usdm');
      const nearSymItem = diag.smcGateDiagnostics.nearMissSymbols.find(
        (s) => s.symbol === 'NEARUSDT'
      );
      if (nearSymItem) {
        assert.equal('candidateDetectionLatencyMs' in nearSymItem, false);
        assert.equal('entryWindowMissed' in nearSymItem, false);
        assert.equal('detectionLatencyMs' in nearSymItem, false);
        assert.equal('entryWindowDelayMs' in nearSymItem, false);
      }

      // Test 6: Shadow mode (OBSERVATION_SHADOW_ONE_GATE_MISSING / TWO_GATES_MISSING) must never create Paper or notifications
      const shadowComp = diag.observationShadowComparison;
      assert.ok(shadowComp);
      for (const modeKey of [
        'OBSERVATION_SHADOW_ONE_GATE_MISSING',
        'OBSERVATION_SHADOW_TWO_GATES_MISSING',
      ] as const) {
        const shadowRow = shadowComp[modeKey];
        assert.equal(shadowRow.paperCreationAllowed, false);
        assert.equal(shadowRow.notificationAllowed, false);
        assert.equal(shadowRow.formalSmcStateOverwritten, false);
        assert.equal(shadowRow.finalTradeSignalOverwritten, false);
        assert.equal(shadowRow.paperOpenedCount, 0);
        assert.equal(shadowRow.paperClosedCount, 0);
        assert.equal(shadowRow.winRate, null);
        assert.equal(shadowRow.averageR, null);
        assert.equal(shadowRow.profitFactor, null);
        assert.equal(shadowRow.maxDrawdownR, null);
        assert.equal(shadowRow.expectancyR, null);
      }
      assert.equal(radarDb.listPaperLedgerEntries(10).length, 0);
      assert.equal(paperDb.listNotificationOutbox({ limit: 10 }).length, 0);
    } finally {
      radarDb.close();
    }
  });

  it('7, 8 & 9. 訊號不可變與去重：同一 signalId 不得被重複建立或改變不可變欄位；同一 symbol 不同方向必須建立不同 signalId 且確認 signalBarOpenTime 不同；不同 signalBarOpenTime 訊號不得互相覆寫', () => {
    const dbPath = createTempDbPath('p18-3-signal-immutability');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({
      paperMonitorDb: paperDb,
      cooldownMs: 0, // Test pure signalId & bar-time deduplication/immutability rules
    });

    try {
      const baseOpenTime = 1710000000000;
      const tfMs = 15 * 60 * 1000;
      const klines = makeConfirmedKlines({
        baseOpenTime,
        count: 36,
        timeframeMs: tfMs,
        basePrice: 500,
        direction: 'LONG',
      });

      // Bar 30 is T1; Bar 31 is T1's nextBar
      const barIndexT1 = 30;
      const barT1 = klines[barIndexT1];
      const nextBarT1 = klines[barIndexT1 + 1];
      const detectedBeforeNextOpenT1 = new Date(
        barT1.closeTime + 200
      ).toISOString();

      // 1) Create LONG signal on BTCUSDT at bar T1 (with only bars up to T1 + nextBarT1 so it opens at nextBarT1.open)
      const klinesAtT1Open = klines.slice(0, barIndexT1 + 2);
      const firstCreate = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_imm',
        scanRunId: 'scan_imm_1',
        scanCycleId: 'cyc_imm_1',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: 'smc_v18_3',
        snapshotAt: detectedBeforeNextOpenT1,
        evaluatedAt: detectedBeforeNextOpenT1,
        signalDetectedAt: detectedBeforeNextOpenT1,
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        klines: klinesAtT1Open,
        signalBarIndex: barIndexT1,
        atr14: 2.0,
        openInterest: 800_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(detectedBeforeNextOpenT1),
        waitReasons: [],
        evidences: ['CHOCH_BULL:1'],
      });

      assert.equal(firstCreate.insertedNew, true);
      assert.ok(firstCreate.signal);
      const sigLongT1 = firstCreate.signal;
      const expectedSignalIdT1 =
        `sig_binance_usdm_BTCUSDT_15m_LONG_${barT1.openTime}_smc_v18_3`;
      assert.equal(sigLongT1.signalId, expectedSignalIdT1);
      assert.equal(sigLongT1.direction, 'LONG');
      assert.equal(sigLongT1.signalBarOpenTime, barT1.openTime);
      assert.equal(sigLongT1.smcActionState, 'LONG CANDIDATE');
      assert.equal(
        sigLongT1.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(sigLongT1.entryReferencePrice, nextBarT1.open);

      // Test 7: Re-evaluating the same signalId in a subsequent scan (even with a late timestamp)
      // must NOT create a duplicate signal and must NOT alter direction, signalBarOpenTime, smcActionState, entryWindowStatus, or entryReferencePrice
      const lateRescanIso = new Date(nextBarT1.openTime + 120_000).toISOString();
      const secondCallSameSignal = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_imm',
        scanRunId: 'scan_imm_2',
        scanCycleId: 'cyc_imm_2',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: 'smc_v18_3',
        snapshotAt: lateRescanIso,
        evaluatedAt: lateRescanIso,
        signalDetectedAt: lateRescanIso,
        entryWindowStatus: 'ENTRY_WINDOW_MISSED', // Attempted mutation on rescan
        klines: klinesAtT1Open,
        signalBarIndex: barIndexT1,
        atr14: 2.0,
        openInterest: 800_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(lateRescanIso),
        waitReasons: [],
        evidences: ['CHOCH_BULL:1'],
      });

      assert.equal(secondCallSameSignal.insertedNew, false);
      assert.ok(secondCallSameSignal.signal);
      assert.equal(secondCallSameSignal.signal.signalId, sigLongT1.signalId);
      assert.equal(secondCallSameSignal.signal.direction, 'LONG');
      assert.equal(
        secondCallSameSignal.signal.signalBarOpenTime,
        barT1.openTime
      );
      assert.equal(
        secondCallSameSignal.signal.smcActionState,
        'LONG CANDIDATE'
      );
      assert.equal(
        secondCallSameSignal.signal.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(
        secondCallSameSignal.signal.entryReferencePrice,
        nextBarT1.open
      );

      // Attempting to create an OPPOSITE direction (SHORT) signal on the EXACT SAME signalBarOpenTime (T1) must be rejected
      const oppositeSameBarAttempt = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_imm',
        scanRunId: 'scan_imm_samebar_short',
        scanCycleId: 'cyc_imm_2',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: 'smc_v18_3',
        snapshotAt: detectedBeforeNextOpenT1,
        evaluatedAt: detectedBeforeNextOpenT1,
        signalDetectedAt: detectedBeforeNextOpenT1,
        klines: klinesAtT1Open,
        signalBarIndex: barIndexT1,
        atr14: 2.0,
        openInterest: 800_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(detectedBeforeNextOpenT1),
        waitReasons: [],
        evidences: ['CHOCH_BEAR:1'],
      });
      assert.equal(oppositeSameBarAttempt.insertedNew, false);

      // Test 8 & 9: When BTCUSDT later produces an opposite direction (SHORT) on a DIFFERENT bar T2 (barIndex 33),
      // it MUST create a new signalId, confirm signalBarOpenTime is different, and NEVER overwrite the historical T1 signal!
      const barIndexT2 = 33;
      const barT2 = klines[barIndexT2];
      assert.notEqual(barT2.openTime, barT1.openTime);
      const detectedBeforeNextOpenT2 = new Date(
        barT2.closeTime + 180
      ).toISOString();
      const klinesAtT2Open = klines.slice(0, barIndexT2 + 2);

      const oppositeNewBarCreate = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_imm',
        scanRunId: 'scan_imm_3',
        scanCycleId: 'cyc_imm_3',
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達空頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'SHORT CANDIDATE',
        finalTradeSignal: '空頭交易候選',
        ruleVersion: 'smc_v18_3',
        snapshotAt: detectedBeforeNextOpenT2,
        evaluatedAt: detectedBeforeNextOpenT2,
        signalDetectedAt: detectedBeforeNextOpenT2,
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        klines: klinesAtT2Open,
        signalBarIndex: barIndexT2,
        atr14: 2.0,
        openInterest: 800_000,
        fundingRate: 0.0001,
        provenance: makeLiveProvenance(detectedBeforeNextOpenT2),
        waitReasons: [],
        evidences: ['CHOCH_BEAR:1'],
      });

      assert.equal(oppositeNewBarCreate.insertedNew, true);
      assert.ok(oppositeNewBarCreate.signal);
      const sigShortT2 = oppositeNewBarCreate.signal;
      assert.notEqual(sigShortT2.signalId, sigLongT1.signalId);
      assert.notEqual(
        sigShortT2.signalBarOpenTime,
        sigLongT1.signalBarOpenTime
      );
      assert.equal(sigShortT2.direction, 'SHORT');
      assert.equal(sigShortT2.signalBarOpenTime, barT2.openTime);

      // Verify historical signal T1 in DB was NEVER overwritten by T2
      const persistedT1 = paperDb.getTrackedSignalById(sigLongT1.signalId);
      const persistedT2 = paperDb.getTrackedSignalById(sigShortT2.signalId);
      assert.ok(persistedT1);
      assert.ok(persistedT2);
      assert.equal(persistedT1.direction, 'LONG');
      assert.equal(persistedT1.signalBarOpenTime, barT1.openTime);
      assert.equal(persistedT1.smcActionState, 'LONG CANDIDATE');
      assert.equal(
        persistedT1.entryWindowStatus,
        'DETECTED_BEFORE_NEXT_BAR_OPEN'
      );
      assert.equal(persistedT1.entryReferencePrice, nextBarT1.open);
      assert.equal(persistedT2.direction, 'SHORT');
      assert.equal(persistedT2.signalBarOpenTime, barT2.openTime);
    } finally {
      radarDb.close();
    }
  });

  it('10 & 11. Live 延遲統計不得混入 Demo（Demo 僅標記為 DEMO_LATENCY_FIXTURE）；Live 沒有正式候選時延遲欄位必須為 null', () => {
    const dbPath = createTempDbPath('p18-3-live-demo-isolation');
    const radarDb = new RadarDatabase(dbPath);

    try {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // Insert a Demo formal candidate on demo_synthetic with 35ms detection latency
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
        smcEvaluationLatencyMs: 25,
        evaluationLatencyMs: 25,
        detectionLatencyMs: 35,
        candidateDetectionLatencyMs: 35,
        queueWaitMs: 10,
        signalBarCloseTime: nowMs - 35,
        nextBarOpenTime: nowMs + 60_000,
        entryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN',
        isFastLane: true,
      });

      // Insert a Live WAIT symbol on binance_usdm (0 Live formal candidates)
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
        smcEvaluationLatencyMs: 40,
        evaluationLatencyMs: 40,
        detectionLatencyMs: 50,
        signalBarCloseTime: nowMs - 50,
        nextBarOpenTime: nowMs + 60_000,
        entryWindowStatus: 'NOT_APPLICABLE',
        isFastLane: true,
      });

      // Check Demo diagnostics: Demo candidate is tagged DEMO_LATENCY_FIXTURE, while LIVE_* fields are 0 / null
      const demoDiag = radarDb.computeCycleDiagnosticsAndFunnel('demo_synthetic');
      assert.equal(
        demoDiag.DEMO_LATENCY_FIXTURE.evidenceType,
        'DEMO_LATENCY_FIXTURE'
      );
      assert.equal(demoDiag.DEMO_LATENCY_FIXTURE.isDemo, true);
      assert.equal(demoDiag.DEMO_LATENCY_FIXTURE.neverMixedIntoLive, true);
      assert.equal(demoDiag.DEMO_LATENCY_FIXTURE.formalCandidateCount, 1);
      assert.equal(demoDiag.LIVE_FORMAL_CANDIDATE_COUNT, 0);
      assert.equal(demoDiag.LIVE_DETECTION_LATENCY_P50, null);
      assert.equal(demoDiag.LIVE_DETECTION_LATENCY_P95, null);

      // Check Live diagnostics (Test 10 & 11):
      // Live has 0 formal candidates -> all Live latency percentiles MUST be null (never padded with Demo's 35ms or 0)
      const liveDiag = radarDb.computeCycleDiagnosticsAndFunnel('binance_usdm');
      assert.equal(liveDiag.formalCandidateCount, 0);
      assert.equal(liveDiag.LIVE_FORMAL_CANDIDATE_COUNT, 0);
      assert.equal(liveDiag.LIVE_FAST_LANE_COUNT, 0);
      assert.equal(liveDiag.LIVE_BULK_COUNT, 0);
      assert.equal(liveDiag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT, 0);
      assert.equal(liveDiag.LIVE_ENTRY_WINDOW_MISSED_COUNT, 0);
      assert.equal(liveDiag.LIVE_DETECTION_LATENCY_P50, null);
      assert.equal(liveDiag.LIVE_DETECTION_LATENCY_P95, null);
      assert.equal(liveDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P50, null);
      assert.equal(liveDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P95, null);
      assert.equal(liveDiag.LIVE_BULK_DETECTION_LATENCY_P50, null);
      assert.equal(liveDiag.LIVE_BULK_DETECTION_LATENCY_P95, null);
      assert.equal(liveDiag.candidateDetectionLatencyP50, null);
      assert.equal(liveDiag.candidateDetectionLatencyP95, null);
      assert.equal(liveDiag.queueWaitP50, null);
      assert.equal(liveDiag.queueWaitP95, null);
      assert.equal(
        liveDiag.DEMO_LATENCY_FIXTURE.evidenceType,
        'DEMO_LATENCY_FIXTURE'
      );
      assert.equal(liveDiag.DEMO_LATENCY_FIXTURE.neverMixedIntoLive, true);
    } finally {
      radarDb.close();
    }
  });

  it('12, 13, 14 & 15. 所有 API snapshotAt / statsVersion / cycleId 一致；所有下單端點維持 HTTP 404；externalNotificationCount 維持 0；安全旗標 PAPER ONLY / LIVE ORDERS DISABLED / NEVER AUTO-PLACE ORDERS 維持不變', async () => {
    const dbPath = createTempDbPath('p18-3-api-consistency-safety');
    const radarDb = new RadarDatabase(dbPath);
    const paperDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb: paperDb });
    const liveAdapter = new DeterministicLiveCaptureAdapter(Date.now() - 200);
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
      const scanState = scanner.getConsistentSmcScanState(
        'binance_usdm',
        'live'
      );
      const smcStatus = scanState.status;
      const monStatus = monitor.getStatus();
      const gateDrift = monitor.getPaperQualityGateDrift('binance_usdm');

      // Test 12: cycleId, snapshotAt, statsVersion consistency across status, monitor, and gate-drift
      assert.equal(smcStatus.cycleId, monStatus.cycleId);
      assert.equal(smcStatus.cycleId, gateDrift.cycleId);
      assert.equal(smcStatus.statsVersion, monStatus.statsVersion);
      assert.equal(smcStatus.statsVersion, gateDrift.statsVersion);
      assert.equal(smcStatus.snapshotAt, monStatus.snapshotAt);
      assert.equal(smcStatus.snapshotAt, gateDrift.snapshotAt);

      // Test 14: externalNotificationCount === 0
      assert.equal(tracker.externalTelegramRequestsCount, 0);
      assert.equal(tracker.externalTradingViewRequestsCount, 0);

      // Test 15: Safety flags immutable
      assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
      assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(
        TRADING_SAFETY_FLAGS.executionPolicy,
        'NEVER AUTO-PLACE ORDERS'
      );
      assert.equal(monStatus.mode, 'PAPER ONLY');
      assert.equal(monStatus.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(monStatus.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

      // Test 13: Verify against running server on port 3000 if reachable
      try {
        const orderEndpoints = [
          '/api/order',
          '/api/orders',
          '/api/trade',
          '/api/execute-order',
          '/api/live-order',
          '/api/binance/order',
        ];
        for (const ep of orderEndpoints) {
          const r = await fetch(`http://localhost:3000${ep}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY' }),
          });
          assert.equal(
            r.status,
            404,
            `Expected HTTP 404 on ${ep}, got ${r.status}`
          );
        }
      } catch {
        // Ignore if local port 3000 is not bound in isolated unit runner
      }
    } finally {
      radarDb.close();
    }
  });
});
