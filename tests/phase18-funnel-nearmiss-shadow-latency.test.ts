import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExchangeAdapter } from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { BacktestEngine } from '../server/engine/BacktestEngine.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import {
  buildObservationShadowComparisonSummary,
  buildScopedGateStatisticsSummary,
  deriveSymbolSmcGateEvaluationFromAnalysis,
} from '../server/engine/SmcRuleEngine.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DataProvenance,
  ExchangeId,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  MarketTicker,
  SmcAnalysisResult,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function makeTempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radar_p18_${prefix}_`));
  return path.join(dir, 'test_p18.sqlite');
}

function buildLiveProvenance(nowIso = new Date().toISOString()): DataProvenance {
  return {
    source: 'Binance USDⓈ-M Futures REST',
    fetchedAt: nowIso,
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
}

function generateConfirmedKlines(
  count: number,
  startMs: number,
  stepMs: number,
  options?: {
    bullishBreakout?: boolean;
    unclosedTailCount?: number;
  }
): Kline[] {
  const klines: Kline[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const openTime = startMs + i * stepMs;
    const closeTime = openTime + stepMs - 1;
    let open = price;
    let close = price * (1 + (i % 2 === 0 ? 0.002 : -0.001));
    let high = Math.max(open, close) * 1.003;
    let low = Math.min(open, close) * 0.997;
    let quoteVolume = 5_000_000 + (i % 5) * 400_000;

    if (options?.bullishBreakout) {
      if (i === count - 4) {
        low = price * 0.965;
        close = price * 1.005;
        high = close * 1.003;
      } else if (i === count - 3) {
        open = price * 1.005;
        close = price * 1.038;
        high = close * 1.002;
        low = open * 0.999;
        quoteVolume = 28_000_000;
      } else if (i >= count - 2) {
        open = price * 1.038;
        close = price * 1.045;
        high = close * 1.004;
        low = open * 0.998;
        quoteVolume = 22_000_000;
      }
    }

    price = close;
    klines.push({
      openTime,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Number((quoteVolume / close).toFixed(2)),
      closeTime,
      quoteVolume,
      isClosed: true,
    });
  }

  const unclosedCount = options?.unclosedTailCount ?? 0;
  for (let u = 0; u < unclosedCount; u++) {
    const openTime = startMs + (count + u) * stepMs;
    klines.push({
      openTime,
      open: price,
      high: price * 1.25,
      low: price * 0.75,
      close: price * 1.2,
      volume: 100_000,
      closeTime: openTime + stepMs - 1,
      quoteVolume: 99_000_000,
      isClosed: false,
    });
  }

  return klines;
}

function buildSyntheticSmcAnalysis(
  overrides: Partial<SmcAnalysisResult> & {
    symbol: string;
    actionState: SmcAnalysisResult['actionState'];
    bosDetected: boolean;
    sweepDetected: boolean;
    displacementDetected: boolean;
    fvgOrObDetected: boolean;
    mtfAligned: boolean;
    waitReasons?: string[];
  }
): SmcAnalysisResult {
  const prov = buildLiveProvenance();
  return {
    symbol: overrides.symbol,
    primaryTimeframe: '15m',
    ruleVersion: 'v1.0.0-smc-ict-deterministic',
    smcEvaluationStatus: 'EVALUATED',
    actionState: overrides.actionState,
    confirmedKlineCount: 35,
    unclosedKlineIgnoredCount: 1,
    atr14: 12.5,
    atrPercent: 0.45,
    bosOrMss: {
      detected: overrides.bosDetected,
      type: overrides.bosDetected ? 'BOS_BULL' : 'NONE',
      brokenLevel: overrides.bosDetected ? 3000 : null,
      candleTime: overrides.bosDetected ? Date.now() - 900_000 : null,
      description: 'BOS check',
    },
    liquiditySweep: {
      detected: overrides.sweepDetected,
      side: overrides.sweepDetected ? 'SELL_SIDE_SWEPT' : 'NONE',
      sweptLevel: overrides.sweepDetected ? 2950 : null,
      candleTime: overrides.sweepDetected ? Date.now() - 1800_000 : null,
      description: 'Sweep check',
    },
    displacement: {
      detected: overrides.displacementDetected,
      direction: overrides.displacementDetected ? 'BULL' : 'NONE',
      bodyToAtrRatio: overrides.displacementDetected ? 1.85 : 0.4,
      candleTime: overrides.displacementDetected ? Date.now() - 900_000 : null,
      description: 'Displacement check',
    },
    fvg: {
      detected: overrides.fvgOrObDetected,
      direction: overrides.fvgOrObDetected ? 'BULL' : 'NONE',
      top: overrides.fvgOrObDetected ? 3050 : null,
      bottom: overrides.fvgOrObDetected ? 3020 : null,
      mitigated: false,
      candleTime: overrides.fvgOrObDetected ? Date.now() - 900_000 : null,
      description: 'FVG check',
    },
    orderBlock: {
      detected: overrides.fvgOrObDetected,
      direction: overrides.fvgOrObDetected ? 'BULL' : 'NONE',
      high: overrides.fvgOrObDetected ? 3020 : null,
      low: overrides.fvgOrObDetected ? 3000 : null,
      candleTime: overrides.fvgOrObDetected ? Date.now() - 1800_000 : null,
      description: 'OB check',
    },
    mtfAlignment: {
      byTimeframe: {
        '4h': overrides.mtfAligned ? 'BULL' : 'BEAR',
        '1h': 'BULL',
        '15m': 'BULL',
        '5m': 'BULL',
      },
      dominantDirection: overrides.mtfAligned ? 'BULL' : 'CONFLICT',
      aligned: overrides.mtfAligned,
      description: 'MTF check',
    },
    waitReasons: overrides.waitReasons ?? [],
    evidences: [],
    provenance: prov,
  };
}

test('Phase 18 Test 1–3: marketRadarCategory != smcActionState, PENDING != WAIT, WAIT/WATCH never create Paper signals', () => {
  const prov = buildLiveProvenance();
  const tickers: MarketTicker[] = [
    {
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
      quoteAsset: 'USDT',
      lastPrice: 185,
      bidPrice: 184.98,
      askPrice: 185.02,
      priceChangePercent24h: 8.4,
      quoteVolume24h: 450_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      openInterest: 2_500_000,
      openInterestValue: 462_500_000,
      provenance: prov,
    },
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 92000,
      bidPrice: 91999,
      askPrice: 92001,
      priceChangePercent24h: 1.5,
      quoteVolume24h: 2_500_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      openInterest: 50_000,
      openInterestValue: 4_600_000_000,
      provenance: prov,
    },
  ];

  const histMap = new Map<string, number[]>([
    ['SOLUSDT', Array.from({ length: 35 }, (_, i) => 10_000_000 + i * 100_000)],
    ['BTCUSDT', Array.from({ length: 35 }, (_, i) => 50_000_000 + i * 200_000)],
  ]);
  const curVolMap = new Map<string, number>([
    ['SOLUSDT', 35_000_000],
    ['BTCUSDT', 90_000_000],
  ]);

  // Scan WITHOUT smcMap -> symbols must remain PENDING (never converted to WAIT)
  const pendingScan = runMarketScan(tickers, prov, {
    mode: 'live',
    exchange: 'binance_usdm',
    historicalVolumeMap: histMap,
    currentVolume15mMap: curVolMap,
  });

  const solPending = pendingScan.candidates.find((c) => c.symbol === 'SOLUSDT')!;
  assert.ok(solPending);
  assert.equal(solPending.marketRadarCategory, '雷達多頭觀察');
  assert.equal(solPending.smcEvaluationStatus, 'PENDING');
  assert.equal(solPending.smcActionState, 'PENDING');
  assert.notEqual(solPending.smcActionState, 'WAIT');
  assert.equal(solPending.finalTradeSignal, 'NONE');
  assert.equal(solPending.paperEligibilityStatus, 'NOT_CANDIDATE');
  assert.equal(pendingScan.smcPendingCount, 2);
  assert.equal(pendingScan.smcWaitCount, 0);
  assert.equal(pendingScan.smcLongCandidateCount, 0);

  // Verify symbolFunnelDiagnostics has all 14 required fields
  assert.ok(Array.isArray(pendingScan.symbolFunnelDiagnostics));
  const diagRec = pendingScan.symbolFunnelDiagnostics?.find(
    (d) => d.symbol === 'SOLUSDT'
  )!;
  assert.equal(diagRec.marketRadarCategory, '雷達多頭觀察');
  assert.equal(diagRec.smcEvaluationStatus, 'PENDING');
  assert.equal(diagRec.smcActionState, 'PENDING');
  assert.equal(diagRec.finalTradeSignal, 'NONE');
  assert.equal(diagRec.paperEligibilityStatus, 'NOT_CANDIDATE');
  assert.equal(diagRec.candidateDetectedAt, null);
  assert.equal(diagRec.signalDetectedAt, null);
  assert.equal(diagRec.paperOpenedAt, null);
  assert.equal(diagRec.entryWindowMissed, null);
});

test('Phase 18 Test 4–8: NEAR_MISS_ONE_GATE, NEAR_MISS_TWO_GATES, Near-Miss never creates Paper/Notifications, only full pass outputs LONG/SHORT CANDIDATE', () => {
  // Construct synthetic SmcAnalysisResult with exactly 1 missing gate (MTF_ALIGNMENT)
  const oneGateMissingAnalysis = buildSyntheticSmcAnalysis({
    symbol: 'ETHUSDT',
    actionState: 'WATCH',
    bosDetected: true,
    sweepDetected: true,
    displacementDetected: true,
    fvgOrObDetected: true,
    mtfAligned: false,
    waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'],
  });
  const oneGateMissingEval = deriveSymbolSmcGateEvaluationFromAnalysis(
    oneGateMissingAnalysis,
    { actionState: 'WATCH', waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'] }
  )!;

  assert.equal(oneGateMissingEval.nearMissStatus, 'NEAR_MISS_ONE_GATE');
  assert.deepEqual(oneGateMissingEval.missingGates, ['MTF_ALIGNMENT']);

  // Construct synthetic SmcAnalysisResult with 2 missing gates (DISPLACEMENT + MTF_ALIGNMENT)
  const twoGatesMissingAnalysis = buildSyntheticSmcAnalysis({
    symbol: 'AVAXUSDT',
    actionState: 'WAIT',
    bosDetected: true,
    sweepDetected: true,
    displacementDetected: false,
    fvgOrObDetected: true,
    mtfAligned: false,
    waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED', 'DISPLACEMENT_MISSING'],
  });
  const twoGatesMissingEval = deriveSymbolSmcGateEvaluationFromAnalysis(
    twoGatesMissingAnalysis,
    {
      actionState: 'WAIT',
      waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED', 'DISPLACEMENT_MISSING'],
    }
  )!;

  assert.equal(twoGatesMissingEval.nearMissStatus, 'NEAR_MISS_TWO_GATES');
  assert.deepEqual(twoGatesMissingEval.missingGates, [
    'DISPLACEMENT',
    'MTF_ALIGNMENT',
  ]);

  // Full pass of all gates -> NOT_NEAR_CANDIDATE (because it IS a full candidate!)
  const fullPassAnalysis = buildSyntheticSmcAnalysis({
    symbol: 'BTCUSDT',
    actionState: 'LONG CANDIDATE',
    bosDetected: true,
    sweepDetected: true,
    displacementDetected: true,
    fvgOrObDetected: true,
    mtfAligned: true,
    waitReasons: [],
  });
  const fullPassEval = deriveSymbolSmcGateEvaluationFromAnalysis(
    fullPassAnalysis,
    { actionState: 'LONG CANDIDATE', waitReasons: [] }
  )!;

  assert.equal(fullPassEval.missingGates.length, 0);
  assert.equal(fullPassEval.nearMissStatus, 'NOT_NEAR_CANDIDATE');
});

test('Phase 18 Test 9, 10, 13: Scoped Gate Statistics (ALL_EVALUATED, NEAR_MISS_ONLY, CANDIDATE_ELIGIBLE_ONLY) and STRICT_PRODUCTION vs OBSERVATION_SHADOW isolation', () => {
  const ethEval = deriveSymbolSmcGateEvaluationFromAnalysis(
    buildSyntheticSmcAnalysis({
      symbol: 'ETHUSDT',
      actionState: 'WATCH',
      bosDetected: true,
      sweepDetected: true,
      displacementDetected: true,
      fvgOrObDetected: true,
      mtfAligned: false,
      waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'],
    }),
    { actionState: 'WATCH', waitReasons: ['MTF_ALIGNMENT_NOT_CONFIRMED'] }
  )!;

  const solEval = deriveSymbolSmcGateEvaluationFromAnalysis(
    buildSyntheticSmcAnalysis({
      symbol: 'SOLUSDT',
      actionState: 'WAIT',
      bosDetected: true,
      sweepDetected: true,
      displacementDetected: false,
      fvgOrObDetected: true,
      mtfAligned: false,
      waitReasons: ['DISPLACEMENT_MISSING', 'MTF_ALIGNMENT_NOT_CONFIRMED'],
    }),
    {
      actionState: 'WAIT',
      waitReasons: ['DISPLACEMENT_MISSING', 'MTF_ALIGNMENT_NOT_CONFIRMED'],
    }
  )!;

  const items = [
    {
      symbol: 'ETHUSDT',
      smcActionState: 'WATCH' as const,
      marketRadarCategory: '雷達多頭觀察' as const,
      gateEvaluation: ethEval,
    },
    {
      symbol: 'SOLUSDT',
      smcActionState: 'WAIT' as const,
      marketRadarCategory: '雷達空頭觀察' as const,
      gateEvaluation: solEval,
    },
  ];

  const scoped = buildScopedGateStatisticsSummary(items, 10);
  assert.equal(scoped.allEvaluatedDenominator, 2);
  assert.equal(scoped.allEvaluatedExcludedCount, 8);
  for (const g of Object.values(scoped.allEvaluated)) {
    assert.equal(g.passCount + g.failCount, g.evaluatedDenominator);
    assert.equal(g.statisticScope, 'ALL_EVALUATED');
  }

  assert.equal(scoped.nearMissDenominator, 2);
  assert.equal(scoped.nearMissOnly.MTF_ALIGNMENT.statisticScope, 'NEAR_MISS_ONLY');
  assert.equal(scoped.nearMissOnly.MTF_ALIGNMENT.failCount, 2);
  assert.equal(scoped.nearMissOnly.DISPLACEMENT.failCount, 1);

  assert.equal(
    scoped.candidateEligibleOnly.MTF_ALIGNMENT.statisticScope,
    'CANDIDATE_ELIGIBLE_ONLY'
  );
  assert.equal(scoped.candidateEligibleDenominator, 2);

  const shadowComp = buildObservationShadowComparisonSummary(
    items,
    scoped,
    'cycle_p18'
  );
  assert.equal(shadowComp.strictProduction.candidateCount, 0);
  assert.equal(shadowComp.observationShadowOneGateMissing.candidateCount, 1);
  assert.equal(
    shadowComp.observationShadowOneGateMissing.paperTradingAllowed,
    false
  );
  assert.equal(
    shadowComp.observationShadowOneGateMissing.notificationAllowed,
    false
  );
  assert.equal(shadowComp.observationShadowTwoGatesMissing.candidateCount, 2);
  assert.equal(
    shadowComp.observationShadowTwoGatesMissing.paperTradingAllowed,
    false
  );
  assert.equal(
    shadowComp.observationShadowTwoGatesMissing.notificationAllowed,
    false
  );
});

test('Phase 18 Test 11 & 12: Fast Lane priority for Watchlist/Near-Miss/Approaching Next Bar Open and ENTRY_WINDOW_MISSED enforcement', async () => {
  const dbPath = makeTempDbPath('fastlane_latency');
  const radarDb = new RadarDatabase(dbPath);
  const prov = buildLiveProvenance();

  const mockAdapter: ExchangeAdapter = {
    id: 'binance_usdm',
    displayName: 'Binance USDⓈ-M',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      return {
        tickers: [
          {
            symbol: 'BTCUSDT',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            lastPrice: 105,
            bidPrice: 104.99,
            askPrice: 105.01,
            priceChangePercent24h: 4.5,
            quoteVolume24h: 850_000_000,
            fundingRate: 0.0001,
            nextFundingTime: Date.now() + 3600_000,
            openInterest: 50_000,
            openInterestValue: 5_250_000,
            provenance: prov,
          },
        ],
        provenance: prov,
      };
    },
    async fetchOpenInterest() {
      return {
        openInterest: 50_000,
        openInterestValue: 5_250_000,
        provenance: prov,
      };
    },
    async fetchKlines(_sym: string, tf: Timeframe) {
      const step =
        tf === '5m'
          ? 300_000
          : tf === '15m'
            ? 900_000
            : tf === '1h'
              ? 3600_000
              : 14400_000;
      return {
        klines: generateConfirmedKlines(45, Date.now() - 50 * step, step, {
          bullishBreakout: true,
        }),
        provenance: prov,
      };
    },
  };

  const adapters: Record<ExchangeId, ExchangeAdapter> = {
    binance_usdm: mockAdapter,
    bybit_linear: mockAdapter,
    bingx_swap: mockAdapter,
    demo_synthetic: mockAdapter,
  };

  const batchService = new SmcBatchScanService({
    db: radarDb,
    adapters,
    recoverOnStart: false,
  });

  const ticker: MarketTicker = {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    lastPrice: 105,
    bidPrice: 104.99,
    askPrice: 105.01,
    priceChangePercent24h: 4.5,
    quoteVolume24h: 850_000_000,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    openInterest: 50_000,
    openInterestValue: 5_250_000,
    provenance: prov,
  };

  const preScan = runMarketScan([ticker], prov, {
    mode: 'live',
    exchange: 'binance_usdm',
    historicalVolumeMap: new Map([
      ['BTCUSDT', Array.from({ length: 35 }, () => 25_000_000)],
    ]),
    currentVolume15mMap: new Map([['BTCUSDT', 32_000_000]]),
  });

  const enqueueInfo = batchService.enqueueMarketUniverse({
    exchange: 'binance_usdm',
    tickers: [ticker],
    candidates: preScan.candidates,
    watchlistSymbols: ['BTCUSDT'],
  });
  assert.equal(enqueueInfo.enqueuedCount, 1);

  batchService.resumeScan('binance_usdm', 'live', false);
  await batchService.processNextBatch('binance_usdm', 'live', 4);
  const rec = radarDb.getSmcScanResult('binance_usdm', 'BTCUSDT')!;
  assert.ok(rec);
  assert.equal(rec.priorityClass, 'FAST_LANE');
  assert.equal(rec.isFastLane, true);
  assert.ok(typeof rec.queueEnteredAt === 'string');
  assert.ok(typeof rec.evaluationStartedAt === 'string');
  assert.ok(typeof rec.evaluationCompletedAt === 'string');
  assert.ok(typeof rec.queueWaitMs === 'number' && rec.queueWaitMs >= 0);
  assert.ok(
    typeof rec.evaluationLatencyMs === 'number' && rec.evaluationLatencyMs >= 0
  );
  assert.equal(rec.candidateDetectionLatencyMs, null);
  assert.equal(rec.entryWindowMissed, null);
  assert.equal(rec.entryWindowDelayMs, null);

  // Verify ENTRY_WINDOW_MISSED rule when signalDetectedAt >= nextBar.openTime
  const oldCloseTime = Date.now() - 25 * 60_000;
  const oldNextBarOpenTime = oldCloseTime + 1;
  radarDb.saveSmcScanResult({
    ...rec,
    smcActionState: 'LONG CANDIDATE',
    finalTradeSignal: '多頭交易候選',
    evaluatedAt: new Date().toISOString(),
    signalBarCloseTime: oldCloseTime,
    nextBarOpenTime: oldNextBarOpenTime,
    entryWindowStatus: 'ENTRY_WINDOW_MISSED',
  });

  const missedRec = radarDb.getSmcScanResult('binance_usdm', 'BTCUSDT')!;
  assert.equal(missedRec.entryWindowStatus, 'ENTRY_WINDOW_MISSED');
  assert.equal(missedRec.entryWindowMissed, true);
  assert.equal(missedRec.paperOpenedAt, null);
  assert.ok(
    typeof missedRec.entryWindowDelayMs === 'number' &&
      missedRec.entryWindowDelayMs >= 0
  );

  batchService.pauseScan('binance_usdm', 'live');
  radarDb.close();
});

test('Phase 18 Test 14 & 15: Backtest 3-mode comparison (STRICT_PRODUCTION vs SHADOW_1 vs SHADOW_2), lookahead-free baseline, and null metrics when paperClosedCount = 0', () => {
  const engine = new BacktestEngine();
  const prov = buildLiveProvenance();
  const stepMs = 15 * 60 * 1000;
  const startMs = Date.now() - 80 * stepMs;
  const klines = generateConfirmedKlines(65, startMs, stepMs, {
    bullishBreakout: false,
    unclosedTailCount: 2,
  });

  const oiSeries: HistoricalOpenInterestPoint[] = klines.map((k) => ({
    symbol: 'BTCUSDT',
    timestamp: k.closeTime - 1000,
    openInterest: 45_000,
    openInterestValue: 45_000 * k.close,
    fetchedAt: prov.fetchedAt,
    source: prov.source,
    isDemo: false,
  }));

  const fundingSeries: HistoricalFundingRatePoint[] = klines.map((k) => ({
    symbol: 'BTCUSDT',
    timestamp: k.closeTime - 1000,
    fundingRate: 0.0001,
    fetchedAt: prov.fetchedAt,
    source: prov.source,
    isDemo: false,
  }));

  const res = engine.runDeterministicBacktest({
    symbol: 'BTCUSDT',
    exchange: 'binance_usdm',
    timeframe: '15m',
    klines,
    historicalOpenInterest: oiSeries,
    historicalFundingRates: fundingSeries,
    provenance: prov,
  });

  // Unclosed bars must be ignored
  assert.equal(res.unclosedBarsIgnored, 2);
  assert.equal(res.lookaheadFree, true);
  assert.ok(res.modeComparison);
  assert.equal(res.modeComparison.confirmedClosedKlinesOnly, true);
  assert.equal(res.modeComparison.lookaheadFreeVerified, true);
  assert.equal(res.modeComparison.formalLedgerUnmodified, true);

  // Verify lookahead-free 30-bar baseline on every point-in-time volume snapshot
  for (const snap of res.pointInTimeVolumeSnapshots ?? []) {
    assert.equal(snap.sampleCount, 30);
    for (const openTime of snap.baselineWindowOpenTimes ?? []) {
      assert.ok(
        openTime < snap.barOpenTime,
        `Volume baseline openTime (${openTime}) must be strictly before signal barOpenTime (${snap.barOpenTime})`
      );
    }
  }

  // Test 15: When paperClosedCount === 0, all performance fields must be null (never 0)
  const strictMetrics = res.modeComparison.STRICT_PRODUCTION!;
  assert.ok(strictMetrics);
  if (strictMetrics.paperClosedCount === 0) {
    assert.equal(strictMetrics.winRate, null);
    assert.equal(strictMetrics.averageR, null);
    assert.equal(strictMetrics.profitFactor, null);
    assert.equal(strictMetrics.maxDrawdownR, null);
    assert.equal(strictMetrics.expectancyR, null);
    assert.equal(res.winRate, null);
    assert.equal(res.averageR, null);
    assert.equal(res.profitFactor, null);
    assert.equal(res.maxDrawdownR, null);
    assert.equal(res.expectancyR, null);
  }
});

test('Phase 18 Test 16 & 17: Safety invariants (PAPER ONLY, LIVE ORDERS DISABLED, NEVER AUTO-PLACE ORDERS, externalNotificationCount = 0) across PaperShadowMonitor and Gate Drift', () => {
  const dbPath = makeTempDbPath('safety_drift');
  const radarDb = new RadarDatabase(dbPath);
  const prov = buildLiveProvenance();
  const dummyAdapter: ExchangeAdapter = {
    id: 'binance_usdm',
    displayName: 'Binance USDⓈ-M',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      return { tickers: [], provenance: prov };
    },
    async fetchOpenInterest() {
      return { openInterest: 1000, openInterestValue: 1000, provenance: prov };
    },
    async fetchKlines() {
      return { klines: [], provenance: prov };
    },
  };
  const adapters: Record<ExchangeId, ExchangeAdapter> = {
    binance_usdm: dummyAdapter,
    bybit_linear: dummyAdapter,
    bingx_swap: dummyAdapter,
    demo_synthetic: dummyAdapter,
  };
  const smcBatchScanner = new SmcBatchScanService({
    db: radarDb,
    adapters,
    recoverOnStart: false,
  });
  const monitor = new PaperShadowMonitor({
    radarDb,
    adapters,
    smcBatchScanner,
    exchange: 'binance_usdm',
  });

  const status = monitor.getStatus();
  assert.equal(status.mode, 'PAPER ONLY');
  assert.equal(status.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(status.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
  assert.equal(status.externalNotificationCount, 0);
  assert.ok(status.candidateFunnel);
  assert.ok(status.scopedGateStatistics);
  assert.ok(status.observationShadowComparison);

  const drift = monitor.getPaperQualityGateDrift('binance_usdm');
  assert.equal(drift.mode, 'PAPER ONLY');
  assert.equal(drift.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(drift.executionPolicy, 'NEVER AUTO-PLACE ORDERS');
  assert.equal(drift.statisticScope, 'ALL_EVALUATED');
  assert.ok(drift.scopedGateStatistics);
  assert.ok(drift.observationShadowComparison);
  for (const stat of Object.values(drift.currentGateStats)) {
    assert.equal(stat.statisticScope, 'ALL_EVALUATED');
    assert.equal(typeof stat.passCount, 'number');
    assert.equal(typeof stat.failCount, 'number');
    assert.equal(typeof stat.evaluatedDenominator, 'number');
    assert.equal(typeof stat.excludedCount, 'number');
    assert.equal(typeof stat.passRate, 'number');
    assert.equal(typeof stat.failureRate, 'number');
  }

  assert.equal(TRADING_SAFETY_FLAGS.mode, 'PAPER ONLY');
  assert.equal(TRADING_SAFETY_FLAGS.liveOrders, 'LIVE ORDERS DISABLED');
  assert.equal(TRADING_SAFETY_FLAGS.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

  monitor.stop();
  radarDb.close();
});
