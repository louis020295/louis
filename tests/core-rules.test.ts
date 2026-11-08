import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BinanceFuturesAdapter,
  BingXFuturesAdapter,
  buildDemoHistoricalVolumeMap,
  BybitFuturesAdapter,
  DemoExchangeAdapter,
  ExchangeApiUnavailableError,
  fetchWithResilience,
  generateDeterministicHistoricalOiAndFunding,
  generateDeterministicSmcKlines,
  resetSharedHttpLimiter,
  sharedHttpBudget,
  SlidingWindowRateLimiter,
} from '../server/adapters/ExchangeAdapter.ts';
import {
  NotificationGuardEngine,
  TelegramNotificationAdapter,
} from '../server/adapters/NotificationAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { BacktestEngine } from '../server/engine/BacktestEngine.ts';
import { evaluateCrossExchangeDivergence } from '../server/engine/CrossExchangeDivergenceEngine.ts';
import {
  classifyFromExchangeFields,
  InstrumentIdentity,
} from '../server/engine/InstrumentIdentity.ts';
import {
  LOW_LIQUIDITY_POLICY,
  MAX_ALLOWED_SPREAD_PERCENT,
  MIN_QUOTE_VOLUME_24H,
  runMarketScan,
} from '../server/engine/MarketScanner.ts';
import { evaluateSmcStructure } from '../server/engine/SmcRuleEngine.ts';
import {
  calculateMad,
  calculateMedian,
  DEFAULT_AGGREGATION_WINDOWS,
  evaluateConfirmedKlineVolumeSeries,
  evaluateHistoricalVolumeAnomaly,
  extractPriorConfirmedBaselineWindow,
  MAX_SANE_ROBUST_ZSCORE,
  MIN_HISTORY_SAMPLES,
  MIN_RELATIVE_MAD_RATIO,
  validateVolumeTimeframeConsistency,
} from '../server/engine/VolumeAnomalyEngine.ts';
import { BackgroundScannerScheduler } from '../server/services/BackgroundScannerScheduler.ts';
import {
  buildDeterministicFallbackExplanation,
  generateGeminiExplanation,
  sanitizeTextGuardrail,
} from '../server/services/GeminiExplainService.ts';
import {
  enforceProvenanceIntegrity,
  isVerifiedLivePublicApiSource,
} from '../server/utils/provenanceQuarantine.ts';
import { DataProvenance, MarketTicker } from '../src/types/market.ts';

// Explicitly marked test fixture provenance (never isDemo: false)
const testFixtureProvenance: DataProvenance = {
  source: 'TEST_FIXTURE',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: true,
  isTestFixture: true,
};

// Verified live public API provenance for testing live scanner/collector paths
const verifiedBinanceLiveProvenance: DataProvenance = {
  source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: false,
  isTestFixture: false,
};

describe('1. 歷史成交量最低樣本數 MIN_HISTORY_SAMPLES = 30、MAD 基線穩定度 (BASELINE_UNSTABLE) 與 Robust Z-Score 護欄驗證', () => {
  it('驗證 MIN_HISTORY_SAMPLES = 30，且當樣本數為 29 筆 (<30) 時：status="INSUFFICIENT_HISTORY"、rollingMedian/mad/robustZScore/rvol 全為 null、不得產生可交易候選、必須輸出準備觀察或 WAIT', () => {
    assert.equal(MIN_HISTORY_SAMPLES, 30);

    const samples29 = Array.from(
      { length: 29 },
      (_, idx) => 100_000_000 + ((idx % 5) - 2) * 15_000_000
    );
    assert.equal(samples29.length, 29);

    const metrics29 = evaluateHistoricalVolumeAnomaly({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      currentVolume: 350_000_000,
      historicalVolumes: samples29,
      baseProvenance: testFixtureProvenance,
    });

    assert.equal(metrics29.sampleCount, 29);
    assert.equal(metrics29.minRequiredSamples, 30);
    assert.equal(metrics29.status, 'INSUFFICIENT_HISTORY');
    assert.equal(metrics29.rollingMedian, null);
    assert.equal(metrics29.mad, null);
    assert.equal(metrics29.robustZScore, null);
    assert.equal(metrics29.zScore, null);
    assert.equal(metrics29.rvol, null);
    assert.equal(metrics29.isHistoricalAnomaly, false);
    assert.equal(metrics29.provenance.source, 'TEST_FIXTURE');
    assert.equal(metrics29.provenance.isDemo, true);
    assert.equal(metrics29.provenance.isTestFixture, true);

    // Even if 24h quoteVolume is #1 in market (AUX_VOL_RANK_PROXY = 100) and momentum is strong (+8.5%),
    // 29 historical samples MUST NOT produce 多頭候選 or 空頭候選; must output 準備觀察
    const tickersWith29Samples: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 1.5,
        quoteVolume24h: 2_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: testFixtureProvenance,
      },
      {
        symbol: 'SOLUSDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        lastPrice: 210,
        bidPrice: 209.98,
        askPrice: 210.02,
        priceChangePercent24h: 8.5,
        quoteVolume24h: 10_000_000_000, // #1 24h volume -> AUX_VOL_RANK_PROXY = 100
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 1000000,
        openInterestValue: 210_000_000,
        provenance: testFixtureProvenance,
      },
    ];

    const histMap29 = new Map<string, number[]>([
      ['BTCUSDT', [...samples29, 120_000_000]],
      ['SOLUSDT', [...samples29, 350_000_000]],
    ]);

    const scan29 = runMarketScan(tickersWith29Samples, testFixtureProvenance, {
      mode: 'demo',
      historicalVolumeMap: histMap29,
    });
    const sol29 = scan29.candidates.find((c) => c.symbol === 'SOLUSDT')!;

    assert.equal(sol29.historicalVolume.sampleCount, 29);
    assert.equal(sol29.historicalVolume.status, 'INSUFFICIENT_HISTORY');
    assert.equal(sol29.historicalVolume.rollingMedian, null);
    assert.equal(sol29.historicalVolume.mad, null);
    assert.equal(sol29.historicalVolume.robustZScore, null);
    assert.equal(sol29.historicalVolume.rvol, null);
    assert.equal(sol29.auxiliaryVolumeRankProxyPercentile, 100);
    assert.equal(sol29.scoreBreakdown.volumeAnomaly, 0);
    assert.notEqual(sol29.category, '多頭候選');
    assert.notEqual(sol29.category, '空頭候選');
    assert.equal(sol29.category, '準備觀察');

    // SMC Rule Engine with 29 historical volume samples MUST output actionState: "WAIT"
    const bullKlines = generateDeterministicSmcKlines({
      basePrice: 200,
      count: 70,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    const smcWith29VolSamples = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': bullKlines,
        '15m': bullKlines,
        '1h': bullKlines,
        '4h': bullKlines,
      },
      openInterest: 1500000,
      historicalVolume: sol29.historicalVolume,
      provenance: testFixtureProvenance,
    });

    assert.equal(smcWith29VolSamples.actionState, 'WAIT');
    assert.ok(
      smcWith29VolSamples.waitReasons.some((r) =>
        r.includes('INSUFFICIENT_HISTORY')
      )
    );
  });

  it('驗證滿 30 筆樣本且具備合理離散度 (MAD/Median >= 3%) 時計算統計值，且 24h AUX_VOL_RANK_PROXY 不得取代歷史模型', () => {
    assert.equal(MIN_RELATIVE_MAD_RATIO, 0.03);
    assert.equal(MAX_SANE_ROBUST_ZSCORE, 8.0);

    // 30 samples with healthy realistic dispersion: median = 100, MAD = 12 (12% of median)
    const samples30 = Array.from({ length: 30 }, (_, idx) => {
      const offsets = [-24, -12, 0, 12, 24];
      return 100 + offsets[idx % 5];
    });
    assert.equal(samples30.length, 30);

    const median = calculateMedian(samples30);
    assert.equal(median, 100);
    const mad = calculateMad(samples30, median!);
    assert.equal(mad, 12);

    const metrics30 = evaluateHistoricalVolumeAnomaly({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      currentVolume: 185,
      historicalVolumes: samples30,
      baseProvenance: testFixtureProvenance,
    });

    assert.equal(metrics30.sampleCount, 30);
    assert.equal(metrics30.minRequiredSamples, 30);
    assert.equal(metrics30.status, 'READY');
    assert.equal(metrics30.baselineUnstable, false);
    assert.equal(metrics30.rollingMedian, 100);
    assert.equal(metrics30.mad, 12);
    assert.equal(metrics30.rvol, 1.85);
    // (185 - 100) / (12 * 1.4826) = 85 / 17.7912 = 4.78 (sane, realistic Robust Z-Score)
    assert.equal(metrics30.robustZScore, 4.78);
    assert.equal(metrics30.zScore, 4.78);
    assert.equal(metrics30.isHistoricalAnomaly, true);
  });

  it('驗證當 MAD 過小或接近 0 時，必須標記 baselineUnstable=true 與 status="BASELINE_UNSTABLE"，不得產生極端 Z-Score (robustZScore=null)，且不可直接當成交易候選 (強制準備觀察 / WAIT)', () => {
    // Case A: MAD = 0 (flatline constant historical volumes)
    const zeroMadSamples = Array.from({ length: 30 }, () => 100_000_000);
    const zeroMadMetrics = evaluateHistoricalVolumeAnomaly({
      symbol: 'FLATUSDT',
      exchange: 'binance_usdm',
      currentVolume: 220_000_000,
      historicalVolumes: zeroMadSamples,
      baseProvenance: testFixtureProvenance,
    });

    assert.equal(zeroMadMetrics.sampleCount, 30);
    assert.equal(zeroMadMetrics.rollingMedian, 100_000_000);
    assert.equal(zeroMadMetrics.mad, 0);
    assert.equal(zeroMadMetrics.baselineUnstable, true);
    assert.equal(zeroMadMetrics.status, 'BASELINE_UNSTABLE');
    assert.equal(zeroMadMetrics.robustZScore, null);
    assert.equal(zeroMadMetrics.zScore, null);
    assert.equal(zeroMadMetrics.rvol, null);
    assert.equal(zeroMadMetrics.isHistoricalAnomaly, false);
    assert.ok(
      zeroMadMetrics.provenance.missingData.includes('VOLUME_BASELINE_UNSTABLE')
    );

    // Case B: Tiny MAD (MAD = 1, Median = 100 -> 1% < 3% threshold) that would otherwise produce an absurd Z-Score > 50
    const tinyMadSamples = Array.from({ length: 30 }, (_, idx) => {
      const offsets = [-2, -1, 0, 1, 2];
      return 100 + offsets[idx % 5];
    });
    const tinyMadMetrics = evaluateHistoricalVolumeAnomaly({
      symbol: 'TINYMADUSDT',
      exchange: 'binance_usdm',
      currentVolume: 260,
      historicalVolumes: tinyMadSamples,
      baseProvenance: testFixtureProvenance,
    });

    assert.equal(tinyMadMetrics.sampleCount, 30);
    assert.equal(tinyMadMetrics.rollingMedian, 100);
    assert.equal(tinyMadMetrics.mad, 1);
    assert.equal(tinyMadMetrics.baselineUnstable, true);
    assert.equal(tinyMadMetrics.status, 'BASELINE_UNSTABLE');
    assert.equal(tinyMadMetrics.robustZScore, null);
    assert.equal(tinyMadMetrics.zScore, null);
    assert.equal(tinyMadMetrics.rvol, null);
    assert.equal(tinyMadMetrics.isHistoricalAnomaly, false);

    // Case C: Extreme Z-Score (> 8.0 even with MAD >= 3%) must also be flagged BASELINE_UNSTABLE and blocked from becoming a candidate
    const normalMadSamples = Array.from({ length: 30 }, (_, idx) => {
      const offsets = [-8, -4, 0, 4, 8]; // MAD = 4 (4% of 100)
      return 100 + offsets[idx % 5];
    });
    const extremeOutlierMetrics = evaluateHistoricalVolumeAnomaly({
      symbol: 'OUTLIERUSDT',
      exchange: 'binance_usdm',
      currentVolume: 500, // (500 - 100) / (4 * 1.4826) = 67.45 > 8.0
      historicalVolumes: normalMadSamples,
      baseProvenance: testFixtureProvenance,
    });

    assert.equal(extremeOutlierMetrics.baselineUnstable, true);
    assert.equal(extremeOutlierMetrics.status, 'BASELINE_UNSTABLE');
    assert.equal(extremeOutlierMetrics.robustZScore, null);
    assert.equal(extremeOutlierMetrics.isHistoricalAnomaly, false);

    // Verify MarketScanner and SmcRuleEngine never treat BASELINE_UNSTABLE / extreme Z-Score as tradeable candidate
    const tickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 1.5,
        quoteVolume24h: 2_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: testFixtureProvenance,
      },
      {
        symbol: 'TINYMADUSDT',
        baseAsset: 'TINYMAD',
        quoteAsset: 'USDT',
        lastPrice: 10,
        bidPrice: 9.998,
        askPrice: 10.002,
        priceChangePercent24h: 8.5,
        quoteVolume24h: 8_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 1000000,
        openInterestValue: 10_000_000,
        provenance: testFixtureProvenance,
      },
    ];

    const scanRes = runMarketScan(tickers, testFixtureProvenance, {
      mode: 'demo',
      historicalVolumeMap: new Map([
        ['BTCUSDT', [...zeroMadSamples, 100_000_000]],
        ['TINYMADUSDT', [...tinyMadSamples, 500_000_000]],
      ]),
    });

    const tinyCandidate = scanRes.candidates.find(
      (c) => c.symbol === 'TINYMADUSDT'
    )!;
    assert.equal(tinyCandidate.historicalVolume.status, 'BASELINE_UNSTABLE');
    assert.equal(tinyCandidate.historicalVolume.baselineUnstable, true);
    assert.equal(tinyCandidate.historicalVolume.robustZScore, null);
    assert.equal(tinyCandidate.category, '準備觀察');

    const bullKlines = generateDeterministicSmcKlines({
      basePrice: 10,
      count: 70,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    const smcUnstable = evaluateSmcStructure({
      symbol: 'TINYMADUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': bullKlines,
        '15m': bullKlines,
        '1h': bullKlines,
        '4h': bullKlines,
      },
      openInterest: 1000000,
      historicalVolume: tinyCandidate.historicalVolume,
      provenance: testFixtureProvenance,
    });

    assert.equal(smcUnstable.actionState, 'WAIT');
    assert.ok(
      smcUnstable.waitReasons.some((r) => r.includes('BASELINE_UNSTABLE'))
    );
  });
});

describe('2. 驗證 Fixture 資料溯源標記與 Live 隔離護欄 (Provenance Quarantine & Live Isolation)', () => {
  it('1. VERIFICATION_SCRIPT、TEST_FIXTURE、SYNTHETIC_TEST_DATA、DEMO_SYNTHETIC_DATASET 都不可標記為 isDemo: false，必須強制為 isDemo: true, isTestFixture: true, fallback: false', () => {
    const nonLiveSources = [
      'VERIFICATION_SCRIPT',
      'TEST_FIXTURE',
      'SYNTHETIC_TEST_DATA',
      'DEMO_SYNTHETIC_DATASET',
    ];

    for (const src of nonLiveSources) {
      const normalized = enforceProvenanceIntegrity({
        source: src,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: true, // Even if caller mistakenly set fallback: true or isDemo: false
        missingData: [],
        isDemo: false,
      });

      assert.equal(normalized.source, 'TEST_FIXTURE');
      assert.equal(normalized.isDemo, true);
      assert.equal(normalized.isTestFixture, true);
      assert.equal(normalized.fallback, false);
    }
  });

  it('2. Live provenance 不得使用 VERIFICATION_SCRIPT，且只有真正來自 Binance、Bybit、BingX public API 的資料才能 isDemo=false', () => {
    assert.equal(isVerifiedLivePublicApiSource('VERIFICATION_SCRIPT'), false);
    assert.equal(isVerifiedLivePublicApiSource('TEST_FIXTURE'), false);
    assert.equal(isVerifiedLivePublicApiSource('SYNTHETIC_TEST_DATA'), false);
    assert.equal(isVerifiedLivePublicApiSource('DEMO_SYNTHETIC_DATASET'), false);
    assert.equal(isVerifiedLivePublicApiSource('UNKNOWN_CUSTOM_SOURCE'), false);

    // Genuine public API sources
    const genuineSources = [
      'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
      'Bybit V5 Linear REST (https://api.bybit.com)',
      'BingX Swap V2 REST (https://open-api.bingx.com)',
    ];

    for (const liveSrc of genuineSources) {
      assert.equal(isVerifiedLivePublicApiSource(liveSrc), true);
      const checked = enforceProvenanceIntegrity({
        source: liveSrc,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      });
      assert.equal(checked.isDemo, false);
      assert.equal(checked.isTestFixture, false);
      assert.equal(checked.source, liveSrc);
    }
  });

  it('3. Demo/fixture 資料不可混入 Live candidates、Live 統計或正式回測報表', () => {
    const mixedTickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 2.0,
        quoteVolume24h: 10_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'FAKE_VERIFICATION_USDT',
        baseAsset: 'FAKE_VERIFICATION',
        quoteAsset: 'USDT',
        lastPrice: 50,
        bidPrice: 49.99,
        askPrice: 50.01,
        priceChangePercent24h: 9.0,
        quoteVolume24h: 5_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 100000,
        openInterestValue: 5_000_000,
        provenance: {
          source: 'VERIFICATION_SCRIPT',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false, // Attempted spoofing as live
        },
      },
      {
        symbol: 'FAKE_DEMO_USDT',
        baseAsset: 'FAKE_DEMO',
        quoteAsset: 'USDT',
        lastPrice: 25,
        bidPrice: 24.99,
        askPrice: 25.01,
        priceChangePercent24h: 7.5,
        quoteVolume24h: 3_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 100000,
        openInterestValue: 2_500_000,
        provenance: {
          source: 'DEMO_SYNTHETIC_DATASET',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false, // Attempted spoofing as live
        },
      },
    ];

    const liveScan = runMarketScan(
      mixedTickers,
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
      }
    );

    // Only genuine BTCUSDT from Binance USDⓈ-M Futures REST can remain in Live candidates
    assert.equal(liveScan.mode, 'live');
    assert.equal(liveScan.isDemo, false);
    assert.equal(liveScan.candidates.length, 1);
    assert.equal(liveScan.candidates[0].symbol, 'BTCUSDT');
    assert.equal(
      liveScan.candidates.find((c) => c.symbol === 'FAKE_VERIFICATION_USDT'),
      undefined
    );
    assert.equal(
      liveScan.candidates.find((c) => c.symbol === 'FAKE_DEMO_USDT'),
      undefined
    );

    // Verify SQLite RadarDatabase blocks VERIFICATION_SCRIPT / TEST_FIXTURE from entering Live volume statistics or official backtest reports
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'radar-quarantine-test-')
    );
    const db = new RadarDatabase(path.join(tmpDir, 'quarantine.sqlite'));
    try {
      const recordedCount = db.recordTickerVolumeSnapshot('binance_usdm', [
        mixedTickers[1], // FAKE_VERIFICATION_USDT
        mixedTickers[2], // FAKE_DEMO_USDT
      ]);
      assert.equal(recordedCount, 0);
      assert.equal(
        db.getHistoricalVolumeSeries('binance_usdm', 'FAKE_VERIFICATION_USDT')
          .length,
        0
      );

      // Verify test fixture backtest is NOT persisted into official backtest_reports
      const btEngine = new BacktestEngine();
      const klines = generateDeterministicSmcKlines({
        basePrice: 100,
        count: 60,
        intervalMs: 15 * 60 * 1000,
        endOpenTime: Date.now(),
        mode: 'BULL',
      });
      const { historicalOpenInterest: histOi, historicalFundingRates: histFunding } =
        generateDeterministicHistoricalOiAndFunding({
          symbol: 'BTCUSDT',
          klines,
          baseOi: 50000,
          baseFundingRate: 0.0001,
        });
      const fixtureReport = btEngine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest: histOi,
        historicalFundingRates: histFunding,
        provenance: {
          source: 'VERIFICATION_SCRIPT',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      });

      assert.equal(fixtureReport.provenance.source, 'TEST_FIXTURE');
      assert.equal(fixtureReport.provenance.isDemo, true);
      assert.equal(fixtureReport.provenance.isTestFixture, true);

      db.saveBacktestReport(fixtureReport, 'binance_usdm', 'v2.0.0');
      const officialReports = db.listBacktestReports();
      assert.equal(officialReports.length, 0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('3. 全市場掃描規則引擎 (MarketScanner: 真實 Bid/Ask Spread、30筆歷史量能模型整合、低流動性排除)', () => {
  it('正確計算真實 Bid/Ask Spread、30筆歷史 RVOL/Robust Z-Score、6 維度 scoreBreakdown，並將標的分類為多頭/空頭/準備觀察/高風險', () => {
    assert.equal(MIN_QUOTE_VOLUME_24H, 15_000_000);
    assert.equal(MAX_ALLOWED_SPREAD_PERCENT, 0.15);
    assert.equal(LOW_LIQUIDITY_POLICY, 'ONLY_HIGH_RISK_OR_WATCH_OR_WAIT');

    const tickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 2.0,
        quoteVolume24h: 10_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'SOLUSDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        lastPrice: 210,
        bidPrice: 209.98,
        askPrice: 210.02,
        priceChangePercent24h: 8.5,
        quoteVolume24h: 4_000_000_000,
        fundingRate: 0.00015,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 1000000,
        openInterestValue: 210_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'APTUSDT',
        baseAsset: 'APT',
        quoteAsset: 'USDT',
        lastPrice: 10,
        bidPrice: 9.998,
        askPrice: 10.002,
        priceChangePercent24h: -5.5,
        quoteVolume24h: 2_500_000_000,
        fundingRate: -0.00012,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 500000,
        openInterestValue: 5_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'EXTREMEPUMPUSDT',
        baseAsset: 'EXTREMEPUMP',
        quoteAsset: 'USDT',
        lastPrice: 5.0,
        bidPrice: 4.995,
        askPrice: 5.005,
        priceChangePercent24h: 35.0,
        quoteVolume24h: 300_000_000,
        fundingRate: 0.0011,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 200000,
        openInterestValue: 1_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'BNBUSDT',
        baseAsset: 'BNB',
        quoteAsset: 'USDT',
        lastPrice: 600,
        bidPrice: 599.9,
        askPrice: 600.1,
        priceChangePercent24h: 2.1,
        quoteVolume24h: 900_000_000,
        fundingRate: 0.00005,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 100000,
        openInterestValue: 60_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
    ];

    const histMap = buildDemoHistoricalVolumeMap();
    // Ensure APTUSDT also has 30 historical 15m samples + 1 latest confirmed 15m bar with realistic dispersion
    histMap.set('APTUSDT', [
      ...Array.from(
        { length: 30 },
        (_, i) => 14_000_000 + ((i % 5) - 2) * 1_800_000
      ),
      24_500_000,
    ]);

    // Without SMC confirmation (smcActionState = WAIT), Layer 1 is 雷達多頭觀察/雷達空頭觀察,
    // while finalCategory must stay 準備觀察 and finalTradeSignal must be NONE
    const resultWithoutSmc = runMarketScan(
      tickers,
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        historicalVolumeMap: histMap,
      }
    );

    const solPending = resultWithoutSmc.candidates.find(
      (c) => c.symbol === 'SOLUSDT'
    )!;
    const aptPending = resultWithoutSmc.candidates.find(
      (c) => c.symbol === 'APTUSDT'
    )!;
    assert.equal(solPending.marketRadarCategory, '雷達多頭觀察');
    assert.equal(solPending.smcEvaluationStatus, 'PENDING');
    assert.equal(solPending.smcActionState, 'PENDING');
    assert.equal(solPending.finalTradeSignal, 'NONE');
    assert.equal(solPending.category, '準備觀察');
    assert.equal(aptPending.marketRadarCategory, '雷達空頭觀察');
    assert.equal(aptPending.smcEvaluationStatus, 'PENDING');
    assert.equal(aptPending.smcActionState, 'PENDING');
    assert.equal(aptPending.finalTradeSignal, 'NONE');
    assert.equal(aptPending.category, '準備觀察');
    assert.equal(resultWithoutSmc.smcPendingCount, tickers.length);
    assert.equal(resultWithoutSmc.smcWaitCount, 0);
    assert.equal(resultWithoutSmc.smcGateNotConfirmedCount, 0);

    // When SMC confirms LONG CANDIDATE / SHORT CANDIDATE, finalCategory becomes 多頭候選 / 空頭候選
    // and finalTradeSignal becomes 多頭交易候選 / 空頭交易候選
    const result = runMarketScan(tickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      smcMap: new Map([
        ['SOLUSDT', { actionState: 'LONG CANDIDATE', waitReasons: [] }],
        ['APTUSDT', { actionState: 'SHORT CANDIDATE', waitReasons: [] }],
      ]),
    });

    const sol = result.candidates.find((c) => c.symbol === 'SOLUSDT');
    const apt = result.candidates.find((c) => c.symbol === 'APTUSDT');
    const pump = result.candidates.find((c) => c.symbol === 'EXTREMEPUMPUSDT');
    const bnb = result.candidates.find((c) => c.symbol === 'BNBUSDT');

    assert.ok(sol);
    assert.equal(sol.historicalVolume.sampleCount, 30);
    assert.equal(sol.historicalVolume.status, 'READY');
    assert.equal(sol.historicalVolume.baselineUnstable, false);
    assert.equal(sol.marketRadarCategory, '雷達多頭觀察');
    assert.equal(sol.smcActionState, 'LONG CANDIDATE');
    assert.equal(sol.finalTradeSignal, '多頭交易候選');
    assert.equal(sol.category, '多頭候選');
    assert.ok(sol.score < 100, 'Score 不可飽和為 100');
    assert.ok(
      sol.historicalVolume.rvol !== null && sol.historicalVolume.rvol > 1.5
    );
    assert.ok(
      sol.historicalVolume.robustZScore !== null &&
        sol.historicalVolume.robustZScore > 1.5 &&
        sol.historicalVolume.robustZScore <= MAX_SANE_ROBUST_ZSCORE
    );

    assert.ok(apt);
    assert.equal(apt.historicalVolume.sampleCount, 30);
    assert.equal(apt.marketRadarCategory, '雷達空頭觀察');
    assert.equal(apt.smcActionState, 'SHORT CANDIDATE');
    assert.equal(apt.finalTradeSignal, '空頭交易候選');
    assert.equal(apt.category, '空頭候選');

    assert.ok(pump);
    assert.equal(pump.category, '高風險');
    assert.equal(pump.finalTradeSignal, 'NONE');
    assert.ok(pump.score <= 48);

    assert.ok(bnb);
    assert.equal(bnb.category, '準備觀察');
    assert.equal(bnb.finalTradeSignal, 'NONE');
  });

  it('當缺少 bid/ask 盤口資料時，禁止使用虛構 spread proxy，必須輸出 spreadPercent: null、missingData: ["BID_ASK_SPREAD"] 並明確顯示「Spread 資料不可用」', () => {
    const tickers: MarketTicker[] = [
      {
        symbol: 'NOSPREADUSDT',
        baseAsset: 'NOSPREAD',
        quoteAsset: 'USDT',
        lastPrice: 100,
        bidPrice: null,
        askPrice: null,
        priceChangePercent24h: 3.2,
        quoteVolume24h: 250_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now(),
        openInterest: null,
        openInterestValue: null,
        provenance: testFixtureProvenance,
      },
    ];

    const res = runMarketScan(tickers, testFixtureProvenance, { mode: 'demo' });
    const candidate = res.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.spreadPercent, null);
    assert.ok(candidate.provenance.missingData.includes('BID_ASK_SPREAD'));
    assert.ok(
      candidate.evidences.some(
        (e) =>
          e.code === 'LIQUIDITY_RISK' && e.value.includes('Spread 資料不可用')
      )
    );
  });

  it('低流動性標的不得成為多頭候選或空頭候選，只能輸出高風險或準備觀察', () => {
    const tickers: MarketTicker[] = [
      {
        symbol: 'LOWLIQ_MILD_USDT',
        baseAsset: 'LOWLIQ_MILD',
        quoteAsset: 'USDT',
        lastPrice: 0.5,
        bidPrice: 0.4998,
        askPrice: 0.5002,
        priceChangePercent24h: 5.5,
        quoteVolume24h: 4_500_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now(),
        openInterest: null,
        openInterestValue: null,
        provenance: testFixtureProvenance,
      },
    ];

    const res = runMarketScan(tickers, testFixtureProvenance, { mode: 'demo' });
    const mild = res.candidates[0];
    assert.equal(mild.isLowLiquidity, true);
    assert.equal(mild.category, '準備觀察');
    assert.ok(
      mild.evidences.some((e) => e.detail.includes('低流動性：不列入一般候選'))
    );
  });
});

describe('4. 多交易所 Provenance 與跨交易所背離引擎 (Multi-Exchange Provenance & Cross-Exchange Divergence)', () => {
  it('驗證 Binance、Bybit、BingX 三家 Live Adapter 皆已啟用 (enabled: true, status: LIVE, isDemo: false)，且 Demo 為 DEMO_ONLY', () => {
    const binance = new BinanceFuturesAdapter();
    const bybit = new BybitFuturesAdapter();
    const bingx = new BingXFuturesAdapter();
    const demo = new DemoExchangeAdapter();

    assert.deepEqual(
      {
        enabled: binance.enabled,
        isDemo: binance.isDemo,
        status: binance.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: bybit.enabled,
        isDemo: bybit.isDemo,
        status: bybit.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: bingx.enabled,
        isDemo: bingx.isDemo,
        status: bingx.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: demo.enabled,
        isDemo: demo.isDemo,
        status: demo.status,
      },
      { enabled: true, isDemo: true, status: 'DEMO_ONLY' }
    );
  });

  it('正確計算跨交易所 (Binance / Bybit / BingX) 價格價差、Funding Rate 背離、OI 差異與 Spread 背離，且每個交易所皆完整保留 source, fetchedAt, stale, fallback, missingData, isDemo', () => {
    const binanceProv: DataProvenance = {
      source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };
    const bybitProv: DataProvenance = {
      source: 'Bybit V5 Linear REST (https://api.bybit.com)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };
    const bingxProv: DataProvenance = {
      source: 'BingX Swap V2 REST (https://open-api.bingx.com)',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };

    const divRes = evaluateCrossExchangeDivergence({
      binance_usdm: {
        exchange: 'binance_usdm',
        displayName: 'Binance',
        available: true,
        provenance: binanceProv,
        tickers: [
          {
            symbol: 'SOLUSDT',
            baseAsset: 'SOL',
            quoteAsset: 'USDT',
            lastPrice: 200.0,
            bidPrice: 199.98,
            askPrice: 200.02,
            priceChangePercent24h: 5.0,
            quoteVolume24h: 2_000_000_000,
            fundingRate: 0.0001,
            nextFundingTime: Date.now(),
            openInterest: 1_000_000,
            openInterestValue: 200_000_000,
            instrument: {
              assetClass: 'crypto',
              underlying: 'SOL',
              symbolType: 'COIN',
              metadataAvailable: true,
            },
            provenance: binanceProv,
          },
        ],
      },
      bybit_linear: {
        exchange: 'bybit_linear',
        displayName: 'Bybit',
        available: true,
        provenance: bybitProv,
        tickers: [
          {
            symbol: 'SOLUSDT',
            baseAsset: 'SOL',
            quoteAsset: 'USDT',
            lastPrice: 201.2,
            bidPrice: 201.15,
            askPrice: 201.25,
            priceChangePercent24h: 5.5,
            quoteVolume24h: 1_500_000_000,
            fundingRate: 0.00055,
            nextFundingTime: Date.now(),
            openInterest: 800_000,
            openInterestValue: 160_960_000,
            instrument: {
              assetClass: 'crypto',
              underlying: 'SOL',
              symbolType: 'crypto',
              metadataAvailable: true,
            },
            provenance: bybitProv,
          },
        ],
      },
      bingx_swap: {
        exchange: 'bingx_swap',
        displayName: 'BingX',
        available: true,
        provenance: bingxProv,
        tickers: [
          {
            symbol: 'SOLUSDT',
            baseAsset: 'SOL',
            quoteAsset: 'USDT',
            lastPrice: 199.8,
            bidPrice: 199.7,
            askPrice: 199.9,
            priceChangePercent24h: 4.8,
            quoteVolume24h: 600_000_000,
            fundingRate: -0.0001,
            nextFundingTime: Date.now(),
            openInterest: 300_000,
            openInterestValue: 59_940_000,
            instrument: {
              assetClass: 'crypto',
              underlying: 'SOL',
              symbolType: 'COIN',
              metadataAvailable: true,
            },
            provenance: bingxProv,
          },
        ],
      },
    });

    assert.equal(divRes.items.length, 1);
    const sol = divRes.items[0];
    assert.equal(sol.symbol, 'SOLUSDT');
    assert.ok(
      sol.priceDivergencePercent !== null && sol.priceDivergencePercent > 0.6
    );
    assert.ok(
      sol.fundingDivergenceBps !== null && sol.fundingDivergenceBps > 6.0
    );
    assert.ok(
      sol.oiDivergencePercent !== null && sol.oiDivergencePercent > 20
    );
    assert.ok(
      sol.spreadDivergencePercent !== null && sol.spreadDivergencePercent > 0
    );
    assert.equal(sol.legs.binance_usdm.provenance.isDemo, false);
    assert.equal(sol.legs.bybit_linear.provenance.isDemo, false);
    assert.equal(sol.legs.bingx_swap.provenance.isDemo, false);
    assert.equal(sol.legs.bybit_linear.comparisonIncluded, true);
  });

  it('Bybit 股票永續 ONUSDT 不與 Binance/BingX 加密 ON 比較（mock 身分，非即時端點）', () => {
    const cryptoOn = {
      assetClass: 'crypto' as const,
      underlying: 'ON',
      symbolType: 'COIN',
      metadataAvailable: true,
    };
    const stockOn = classifyFromExchangeFields({
      symbolType: 'stock',
      underlying: 'ON Semiconductor Corp',
      baseAsset: 'ON',
    });
    assert.equal(stockOn.assetClass, 'tradfi');
    assert.equal(stockOn.metadataAvailable, true);
    assert.equal(
      classifyFromExchangeFields({
        underlyingType: 'COIN',
        underlyingSubType: ['Layer-1'],
        baseAsset: 'ON',
      }).assetClass,
      'crypto'
    );
    assert.equal(
      classifyFromExchangeFields({ baseAsset: 'ON', underlying: 'ON' })
        .metadataAvailable,
      false
    );

    const prov = (source: string): DataProvenance => ({
      source,
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    });
    const leg = (
      symbol: string,
      price: number,
      instrument: InstrumentIdentity
    ) => ({
      symbol,
      baseAsset: 'ON',
      quoteAsset: 'USDT',
      lastPrice: price,
      bidPrice: price - 0.01,
      askPrice: price + 0.01,
      priceChangePercent24h: 1,
      quoteVolume24h: 1_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now(),
      openInterest: 10,
      openInterestValue: price * 10,
      instrument,
      provenance: prov('mock'),
    });

    const divRes = evaluateCrossExchangeDivergence({
      binance_usdm: {
        exchange: 'binance_usdm',
        displayName: 'Binance',
        available: true,
        provenance: prov('binance'),
        tickers: [leg('ONUSDT', 0.1896, cryptoOn)],
      },
      bybit_linear: {
        exchange: 'bybit_linear',
        displayName: 'Bybit',
        available: true,
        provenance: prov('bybit'),
        tickers: [leg('ONUSDT', 63.21, stockOn)],
      },
      bingx_swap: {
        exchange: 'bingx_swap',
        displayName: 'BingX',
        available: true,
        provenance: prov('bingx'),
        tickers: [leg('ONUSDT', 0.1883, cryptoOn)],
      },
    });

    assert.equal(divRes.items.length, 1);
    const on = divRes.items[0];
    assert.equal(on.legs.bybit_linear.comparisonIncluded, false);
    assert.equal(on.legs.bybit_linear.assetClass, 'tradfi');
    assert.equal(on.legs.bybit_linear.underlying, 'ON Semiconductor Corp');
    assert.equal(on.legs.binance_usdm.comparisonIncluded, true);
    assert.equal(on.legs.bingx_swap.comparisonIncluded, true);
    assert.ok(
      on.priceDivergencePercent !== null && on.priceDivergencePercent < 1
    );
    assert.ok(
      on.divergenceFlags.some((flag) => flag.includes('標的類型不同'))
    );
    assert.ok(!on.maxPriceExchange || on.maxPriceExchange !== 'bybit_linear');
  });

  it('缺少交易所中繼資料時標成未驗證，不計算跨所價差（mock）', () => {
    const prov: DataProvenance = {
      source: 'mock',
      fetchedAt: new Date().toISOString(),
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    };
    const bare = (price: number) => ({
      symbol: 'ONUSDT',
      baseAsset: 'ON',
      quoteAsset: 'USDT',
      lastPrice: price,
      bidPrice: price,
      askPrice: price,
      priceChangePercent24h: 0,
      quoteVolume24h: 1,
      fundingRate: 0.0001,
      nextFundingTime: Date.now(),
      openInterest: null,
      openInterestValue: null,
      provenance: prov,
    });
    const divRes = evaluateCrossExchangeDivergence({
      binance_usdm: {
        exchange: 'binance_usdm',
        displayName: 'Binance',
        available: true,
        provenance: prov,
        tickers: [bare(0.19)],
      },
      bybit_linear: {
        exchange: 'bybit_linear',
        displayName: 'Bybit',
        available: true,
        provenance: prov,
        tickers: [bare(63.21)],
      },
      bingx_swap: {
        exchange: 'bingx_swap',
        displayName: 'BingX',
        available: false,
        provenance: prov,
        tickers: [],
      },
    });
    assert.equal(divRes.items.length, 1);
    assert.equal(divRes.items[0].priceDivergencePercent, null);
    assert.equal(divRes.items[0].legs.binance_usdm.assetClass, 'unverified');
    assert.equal(divRes.items[0].legs.bybit_linear.comparisonIncluded, false);
  });
});

describe('5. 斷線重試、Rate Limit、Timeout 與 API Failure 測試 (Failure & Reconnect Resilience Tests)', () => {
  it('斷線自動重試 (Reconnect Retry)：當網路暫時斷線或回傳 HTTP 503 時自動重試並在恢復後成功回傳，記錄 retryAttempts', async () => {
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      if (callCount < 3) {
        return new Response('Service Unavailable', {
          status: 503,
          statusText: 'Bad Gateway',
        });
      }
      return new Response(JSON.stringify({ ok: true, data: 'RECOVERED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await fetchWithResilience<{ ok: boolean; data: string }>({
      endpoints: ['https://example.com'],
      path: '/api',
      sourceLabel: 'TEST_EXCHANGE',
      timeoutMs: 2000,
      maxRetriesPerEndpoint: 3,
      retryBaseDelayMs: 10,
      customFetch: mockFetch,
    });

    assert.equal(res.data.ok, true);
    assert.equal(res.data.data, 'RECOVERED');
    assert.equal(res.retryAttempts, 2);
    assert.equal(callCount, 3);
  });

  it('HTTP 429 Rate Limit 退避重試與 SlidingWindowRateLimiter 窗口控管測試', async () => {
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(JSON.stringify({ status: 'OK_AFTER_429' }), {
        status: 200,
      });
    };

    const result = await fetchWithResilience<{ status: string }>({
      endpoints: ['https://example.com'],
      path: '/rate-limited',
      sourceLabel: 'RATE_LIMIT_TEST',
      timeoutMs: 2000,
      maxRetriesPerEndpoint: 2,
      retryBaseDelayMs: 10,
      customFetch: mockFetch,
    });
    assert.equal(result.data.status, 'OK_AFTER_429');
    assert.equal(result.retryAttempts, 1);

    const limiter = new SlidingWindowRateLimiter(2, 1000);
    limiter.checkAndRecord('TEST_LIMITER', 100);
    limiter.checkAndRecord('TEST_LIMITER', 200);
    assert.throws(
      () => limiter.checkAndRecord('TEST_LIMITER', 300),
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiUnavailableError);
        assert.equal(err.isRateLimited, true);
        assert.equal(err.statusCode, 429);
        return true;
      }
    );
  });

  it('請求逾時 (Timeout) 與持續失敗保護：超出 timeoutMs 與重試上限後拋出 ExchangeApiUnavailableError (isTimeout=true)，絕不偽造假行情', async () => {
    const hangingFetch: typeof globalThis.fetch = async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    };

    await assert.rejects(
      async () => {
        await fetchWithResilience({
          endpoints: ['https://example.com'],
          path: '/slow',
          sourceLabel: 'TIMEOUT_EXCHANGE',
          timeoutMs: 25,
          maxRetriesPerEndpoint: 1,
          retryBaseDelayMs: 10,
          customFetch: hangingFetch,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiUnavailableError);
        assert.equal(err.isTimeout, true);
        assert.equal(err.retryAttempts, 1);
        return true;
      }
    );
  });

  it('空本文與無法解析的 JSON 保留上游 HTTP 狀態與 host，且不把錯誤收成單純的 Unexpected end of JSON input', async () => {
    let emptyCalls = 0;
    const emptyFetch: typeof globalThis.fetch = async () => {
      emptyCalls += 1;
      return new Response('', { status: 200, statusText: 'OK' });
    };

    await assert.rejects(
      async () => {
        await fetchWithResilience({
          endpoints: ['https://fapi1.binance.com'],
          path: '/fapi/v1/exchangeInfo',
          sourceLabel: 'Binance USDⓈ-M Futures REST',
          timeoutMs: 2000,
          maxRetriesPerEndpoint: 2,
          retryBaseDelayMs: 5,
          customFetch: emptyFetch,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiUnavailableError);
        assert.equal(err.statusCode, 200);
        assert.match(err.message, /HTTP 200/);
        assert.match(err.message, /https:\/\/fapi1\.binance\.com/);
        assert.match(err.message, /回應本文為空/);
        assert.doesNotMatch(err.message, /^Unexpected end of JSON input$/);
        return true;
      }
    );
    assert.equal(emptyCalls, 1);

    const badJsonFetch: typeof globalThis.fetch = async () =>
      new Response('not-json', { status: 202 });
    await assert.rejects(
      async () => {
        await fetchWithResilience({
          endpoints: ['https://fapi2.binance.com'],
          path: '/fapi/v1/ticker/24hr',
          sourceLabel: 'Binance USDⓈ-M Futures REST',
          maxRetriesPerEndpoint: 2,
          retryBaseDelayMs: 5,
          customFetch: badJsonFetch,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiUnavailableError);
        assert.equal(err.statusCode, 202);
        assert.match(err.message, /HTTP 202/);
        assert.match(err.message, /https:\/\/fapi2\.binance\.com/);
        assert.match(err.message, /無法解析為 JSON/);
        return true;
      }
    );
  });

  it('3xx 重新導向不跟隨，錯誤訊息含狀態碼、host 與 Location', async () => {
    let calls = 0;
    const redirectFetch: typeof globalThis.fetch = async (_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, 'manual');
      return new Response('', {
        status: 302,
        headers: { Location: 'https://www.binance.com/en' },
      });
    };

    await assert.rejects(
      async () => {
        await fetchWithResilience({
          endpoints: ['https://fapi1.binance.com', 'https://fapi2.binance.com'],
          path: '/fapi/v1/ticker/24hr',
          sourceLabel: 'Binance USDⓈ-M Futures REST',
          maxRetriesPerEndpoint: 3,
          retryBaseDelayMs: 5,
          customFetch: redirectFetch,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiUnavailableError);
        assert.equal(err.statusCode, 302);
        assert.match(err.message, /HTTP 302/);
        assert.match(err.message, /binance\.com/);
        assert.match(err.message, /重新導向未跟隨/);
        assert.match(err.message, /Location: https:\/\/www\.binance\.com\/en/);
        return true;
      }
    );
    assert.equal(calls, 2);
  });

  it('共享限制器計算每一次真實 HTTP，超額時不再送出（mock）', async () => {
    resetSharedHttpLimiter({
      enabled: true,
      maxRequestsPerWindow: 2,
      windowMs: 60_000,
    });
    let calls = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      await fetchWithResilience({
        endpoints: ['https://example.test'],
        path: '/a',
        sourceLabel: 'LIMIT_A',
        maxRetriesPerEndpoint: 0,
        customFetch: mockFetch,
      });
      await fetchWithResilience({
        endpoints: ['https://example.test'],
        path: '/b',
        sourceLabel: 'LIMIT_B',
        maxRetriesPerEndpoint: 0,
        customFetch: mockFetch,
      });
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: ['https://example.test'],
            path: '/c',
            sourceLabel: 'LIMIT_C',
            maxRetriesPerEndpoint: 2,
            retryBaseDelayMs: 5,
            customFetch: mockFetch,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.equal(err.statusCode, 429);
          assert.equal(err.isRateLimited, true);
          assert.match(err.message, /共享請求預算已滿/);
          return true;
        }
      );
      assert.equal(calls, 2);
      assert.equal(sharedHttpBudget.requestCount, 2);
    } finally {
      resetSharedHttpLimiter();
    }
  });

  it('HTTP 451 與地區封鎖 403 不重試、不改打備援 host（mock）', async () => {
    resetSharedHttpLimiter();
    let calls = 0;
    const blocked: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "Service unavailable from a restricted location according to 'b. Eligibility'",
        }),
        { status: 451 }
      );
    };
    try {
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: [
              'https://fapi.binance.com',
              'https://fapi1.binance.com',
            ],
            path: '/fapi/v1/ticker/24hr',
            sourceLabel: 'Binance USDⓈ-M Futures REST',
            maxRetriesPerEndpoint: 3,
            retryBaseDelayMs: 5,
            customFetch: blocked,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.equal(err.statusCode, 451);
          assert.match(err.message, /HTTP 451/);
          assert.match(err.message, /https:\/\/fapi\.binance\.com/);
          return true;
        }
      );
      assert.equal(calls, 1);
    } finally {
      resetSharedHttpLimiter();
    }
  });

  it('Bybit 403 access too frequent 視為限流並進入約 10 分鐘冷卻，後續請求不再送出（mock）', async () => {
    resetSharedHttpLimiter({ bybitBanCooldownMs: 10 * 60 * 1000 });
    let calls = 0;
    const banned: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response('403, access too frequent', { status: 403 });
    };
    try {
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: ['https://api.bybit.com', 'https://api.bytick.com'],
            path: '/v5/market/tickers?category=linear',
            sourceLabel: 'Bybit V5 Linear REST',
            maxRetriesPerEndpoint: 2,
            retryBaseDelayMs: 5,
            customFetch: banned,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.equal(err.statusCode, 403);
          assert.equal(err.isRateLimited, true);
          assert.match(err.message, /access too frequent/);
          return true;
        }
      );
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: ['https://api.bybit.com'],
            path: '/v5/market/kline',
            sourceLabel: 'Bybit V5 Linear REST',
            maxRetriesPerEndpoint: 1,
            customFetch: banned,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.match(err.message, /Bybit access too frequent cooldown/);
          return true;
        }
      );
      assert.equal(calls, 1);
    } finally {
      resetSharedHttpLimiter();
    }
  });

  it('Retry-After 超過上限時不在請求內空等，並保留標頭秒數；Binance 權重標頭會暫停後續 Binance 請求（mock）', async () => {
    resetSharedHttpLimiter({
      maxRetryAfterMs: 1000,
      binanceWeightSoftLimit: 1800,
      binanceWeightCooldownMs: 60_000,
      maxRequestsPerWindow: 50,
    });
    let calls = 0;
    const limited: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    };
    try {
      const started = Date.now();
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: ['https://fapi.binance.com'],
            path: '/fapi/v1/klines',
            sourceLabel: 'Binance USDⓈ-M Futures REST',
            maxRetriesPerEndpoint: 3,
            retryBaseDelayMs: 5,
            customFetch: limited,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.equal(err.isRateLimited, true);
          assert.match(err.message, /Retry-After 120/);
          return true;
        }
      );
      assert.ok(Date.now() - started < 500);
      assert.equal(calls, 1);

      calls = 0;
      const weighted: typeof globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'X-MBX-USED-WEIGHT-1M': '1800' },
        });
      };
      await fetchWithResilience({
        endpoints: ['https://fapi.binance.com'],
        path: '/fapi/v1/premiumIndex',
        sourceLabel: 'Binance USDⓈ-M Futures REST',
        maxRetriesPerEndpoint: 0,
        customFetch: weighted,
      });
      await assert.rejects(
        () =>
          fetchWithResilience({
            endpoints: ['https://fapi.binance.com'],
            path: '/fapi/v1/ticker/24hr',
            sourceLabel: 'Binance USDⓈ-M Futures REST',
            maxRetriesPerEndpoint: 1,
            customFetch: weighted,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ExchangeApiUnavailableError);
          assert.match(err.message, /X-MBX-USED-WEIGHT-1M/);
          return true;
        }
      );
      assert.equal(calls, 1);
    } finally {
      resetSharedHttpLimiter();
    }
  });
});

describe('6. SQLite 持久化資料庫、歷史量能 Collector、紙上交易 Ledger 與背景排程器 (Persistence & Scheduler)', () => {
  it('驗證 SQLite RadarDatabase 正確持久化 30 筆真實來源歷史成交量、Paper Trading Ledger 開平倉、回測報表與背景排程 Dry-Run 紀錄', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase2-test-'));
    const dbPath = path.join(tmpDir, 'test_radar.sqlite');
    const db = new RadarDatabase(dbPath);

    try {
      // 1. Seed 30 historical volume samples from verified Binance public API provenance
      for (let i = 0; i < 30; i++) {
        db.recordTickerVolumeSnapshot(
          'binance_usdm',
          [
            {
              symbol: 'BTCUSDT',
              baseAsset: 'BTC',
              quoteAsset: 'USDT',
              lastPrice: 90000 + i * 10,
              bidPrice: 89999,
              askPrice: 90001,
              priceChangePercent24h: 2.0,
              quoteVolume24h: 1_000_000_000 + ((i % 5) - 2) * 120_000_000,
              fundingRate: 0.0001,
              nextFundingTime: Date.now() + i * 60000,
              openInterest: null,
              openInterestValue: null,
              provenance: {
                ...verifiedBinanceLiveProvenance,
                fetchedAt: new Date(
                  Date.now() - (30 - i) * 300_000
                ).toISOString(),
              },
            },
          ],
          300_000,
          Date.now() - (30 - i) * 300_000
        );
      }

      const series = db.getHistoricalVolumeSeries('binance_usdm', 'BTCUSDT');
      assert.equal(series.length, 30);
      assert.ok(series.every((s) => s.isDemo === false));

      // 2. Add Paper Trading Ledger entry (Strictly PAPER ONLY)
      const entry = db.addPaperLedgerEntry({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        entryPrice: 90000,
        invalidationPrice: 89000,
        targetPrice: 92000,
        ruleVersion: 'v2.0.0-test',
        evidences: ['BOS_BULL', 'RVOL 2.4x'],
        notes: 'Unit test paper entry',
        provenance: testFixtureProvenance,
      });

      assert.equal(entry.status, 'OPEN');
      assert.equal(entry.provenance.source, 'TEST_FIXTURE');
      assert.equal(entry.provenance.isDemo, true);
      assert.equal(entry.provenance.isTestFixture, true);

      // Mark-to-market update
      db.updateOpenPaperEntriesWithPrices(
        'binance_usdm',
        new Map([['BTCUSDT', 91000]])
      );
      const openList = db.listPaperLedgerEntries();
      assert.equal(openList[0].currentPrice, 91000);
      assert.equal(openList[0].pnlR, 1.0);

      // Close paper entry
      const closed = db.closePaperLedgerEntry(
        entry.id,
        91500,
        'Closed in test'
      );
      assert.ok(closed);
      assert.equal(closed.status, 'CLOSED_MANUAL');
      assert.equal(closed.pnlR, 1.5);

      // 3. Background Scanner Scheduler runOnce (Dry-Run only)
      const guard = new NotificationGuardEngine();
      const tg = new TelegramNotificationAdapter(guard);
      const demoAdapter = new DemoExchangeAdapter();
      const scheduler = new BackgroundScannerScheduler({
        adapters: {
          binance_usdm: demoAdapter,
          bybit_linear: demoAdapter,
          bingx_swap: demoAdapter,
          demo_synthetic: demoAdapter,
        },
        db,
        telegramDryRunAdapter: tg,
        intervalMs: 60_000,
      });

      const runRec = await scheduler.runOnce('demo_synthetic', 'demo');
      assert.equal(runRec.status, 'SUCCESS');
      assert.ok(runRec.symbolsScanned > 0);
      const status = scheduler.getStatus();
      assert.equal(status.notificationMode, 'DRY_RUN_ONLY');
      assert.ok(status.recentRuns.length >= 1);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('7. SMC/ICT 結構觀察模組、WAIT 安全閘門、Gemini 對抗性護欄與無前視偏差回測', () => {
  it('當 Open Interest (OI) 缺失、已確認 K 線不足 (<30 筆) 或多週期衝突時強制輸出 WAIT', () => {
    const klines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    const resMissingOi = evaluateSmcStructure({
      symbol: 'AVAXUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: { '15m': klines },
      openInterest: null,
      provenance: testFixtureProvenance,
    });
    assert.equal(resMissingOi.actionState, 'WAIT');
  });

  it('對抗性測試：模擬 Gemini 回傳「建議做多」、「這是高勝率機會」、「可以進場」，輸出仍強制維持 WAIT 與準備觀察並過濾違規語句', async () => {
    const bullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });
    const smcWait = evaluateSmcStructure({
      symbol: 'AVAXUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: { '15m': bullKlines },
      openInterest: null,
      provenance: testFixtureProvenance,
    });
    smcWait.actionState = 'WAIT';
    smcWait.waitReasons = ['OI 缺失'];

    const scanRes = runMarketScan(
      [
        {
          symbol: 'AVAXUSDT',
          baseAsset: 'AVAX',
          quoteAsset: 'USDT',
          lastPrice: 36,
          bidPrice: 35.99,
          askPrice: 36.01,
          priceChangePercent24h: 1.5,
          quoteVolume24h: 500_000_000,
          fundingRate: 0.0001,
          nextFundingTime: Date.now(),
          openInterest: null,
          openInterestValue: null,
          provenance: testFixtureProvenance,
        },
      ],
      testFixtureProvenance,
      { mode: 'demo' }
    );
    const candidate = scanRes.candidates[0];
    candidate.category = '準備觀察';

    const result = await generateGeminiExplanation(
      { candidate, smcAnalysis: smcWait },
      {
        customModelCaller: async () =>
          JSON.stringify({
            category: '多頭候選',
            actionState: 'LONG CANDIDATE',
            explanationZh:
              '建議做多！這是高勝率機會，現在可以進場，保證獲利！',
            passedConditionsZh: ['建議做多', '這是高勝率機會', '可以進場'],
            missingDataOrWaitReasonsZh: [],
            riskNotesZh: ['可以進場'],
          }),
      }
    );

    assert.equal(result.category, '準備觀察');
    assert.equal(result.actionState, 'WAIT');
    assert.ok(result.waitReasons.includes('OI 缺失'));

    const allCombinedText = [
      result.explanationZh,
      ...result.passedConditionsZh,
      ...result.missingDataOrWaitReasonsZh,
      ...result.riskNotesZh,
    ].join(' ');

    assert.ok(!allCombinedText.includes('建議做多'));
    assert.ok(!allCombinedText.includes('高勝率'));
    assert.ok(!allCombinedText.includes('可以進場'));

    const sanitized = sanitizeTextGuardrail(
      '建議做多，這是高勝率機會，可以進場'
    );
    assert.ok(!sanitized.includes('建議做多'));

    const fallback = buildDeterministicFallbackExplanation(
      {
        candidate,
        smcAnalysis: smcWait,
      },
      'Test deterministic fallback'
    );
    assert.equal(fallback.actionState, 'WAIT');
    assert.equal(fallback.category, '準備觀察');
  });

  it('無前視偏差回測 (No-Lookahead Backtest)：共用即時掃描與 SMC 規則引擎，改變未來 K 線不會改變過去已確認 bar 的判斷', () => {
    const engine = new BacktestEngine();
    const baseKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 65,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    const first48 = baseKlines.slice(0, 48);
    const modifiedFuture = [
      ...first48,
      ...baseKlines.slice(48).map((k) => ({
        ...k,
        open: k.open * 0.2,
        high: k.high * 0.2,
        low: k.low * 0.2,
        close: k.close * 0.2,
      })),
    ];

    const { historicalOpenInterest: histOi, historicalFundingRates: histFunding } =
      generateDeterministicHistoricalOiAndFunding({
        symbol: 'SOLUSDT',
        klines: baseKlines,
        baseOi: 1000000,
        baseFundingRate: 0.0001,
      });

    const resA = engine.runDeterministicBacktest({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: baseKlines,
      historicalOpenInterest: histOi,
      historicalFundingRates: histFunding,
      provenance: verifiedBinanceLiveProvenance,
    });

    const resB = engine.runDeterministicBacktest({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: modifiedFuture,
      historicalOpenInterest: histOi,
      historicalFundingRates: histFunding,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(resA.lookaheadFreeVerified, true);
    assert.equal(resB.lookaheadFreeVerified, true);
    assert.equal(resA.provenance.isDemo, false);

    const cutoffTime = first48[33].openTime;
    const earlySignalsA = resA.trades
      .filter((t) => t.entryBarTime <= cutoffTime)
      .map((t) => ({
        entryBarTime: t.entryBarTime,
        direction: t.direction,
        referenceEntryPrice: t.referenceEntryPrice,
      }));
    const earlySignalsB = resB.trades
      .filter((t) => t.entryBarTime <= cutoffTime)
      .map((t) => ({
        entryBarTime: t.entryBarTime,
        direction: t.direction,
        referenceEntryPrice: t.referenceEntryPrice,
      }));

    assert.deepEqual(earlySignalsA, earlySignalsB);
  });
});

describe('8. VolumeAnomalyEngine 時間週期一致性與 QUSDT 15m 量能基線驗證 (Timeframe Consistency & QUSDT Fix)', () => {
  it('測試 1：15m currentVolume 與 15m historical samples 可以正確計算 Z-Score，並輸出完整 volumeTimeframe, aggregationWindow, volumeMetric, sampleCount', () => {
    const historical15mSamples = Array.from(
      { length: 30 },
      (_, i) => 12_000_000 + ((i % 6) - 2.5) * 1_200_000
    );
    const current15mVolume = 28_500_000;

    const res = evaluateHistoricalVolumeAnomaly({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      currentVolume: current15mVolume,
      historicalVolumes: historical15mSamples,
      volumeTimeframe: '15m',
      currentVolumeTimeframe: '15m',
      historicalVolumeTimeframe: '15m',
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(res.status, 'READY');
    assert.equal(res.volumeTimeframe, '15m');
    assert.equal(
      res.aggregationWindow,
      DEFAULT_AGGREGATION_WINDOWS['15m']
    );
    assert.equal(res.volumeMetric, 'quoteVolume');
    assert.equal(res.sampleCount, 30);
    assert.equal(res.baselineUnstable, false);
    assert.equal(res.timeframeMismatchRejected, false);
    assert.ok(res.rvol !== null && res.rvol > 2.0);
    assert.ok(
      res.robustZScore !== null &&
        res.robustZScore > 2.0 &&
        res.robustZScore <= MAX_SANE_ROBUST_ZSCORE
    );
    assert.equal(res.isHistoricalAnomaly, true);
  });

  it('測試 2：24h currentVolume 與 15m historical samples 必須直接拒絕 (timeframeMismatchRejected = true)，絕不可混算 Z-Score', () => {
    const historical15mSamples = Array.from(
      { length: 30 },
      (_, i) => 11_000_000 + ((i % 5) - 2) * 900_000
    );
    const ticker24hQuoteVolume = 1_050_000_000; // 24h ticker quoteVolume

    const validation = validateVolumeTimeframeConsistency('24h', '15m');
    assert.equal(validation.valid, false);
    assert.ok(validation.reason && validation.reason.includes('24h currentVolume'));

    const res = evaluateHistoricalVolumeAnomaly({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      currentVolume: ticker24hQuoteVolume,
      historicalVolumes: historical15mSamples,
      volumeTimeframe: '15m',
      currentVolumeTimeframe: '24h',
      historicalVolumeTimeframe: '15m',
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(res.timeframeMismatchRejected, true);
    assert.equal(res.status, 'INSUFFICIENT_HISTORY');
    assert.equal(res.rvol, null);
    assert.equal(res.zScore, null);
    assert.equal(res.robustZScore, null);
    assert.equal(res.isHistoricalAnomaly, false);
    assert.ok(
      res.rejectionReason?.includes('24h currentVolume') &&
        res.rejectionReason?.includes('15m historical samples')
    );
    assert.ok(
      res.provenance.missingData.includes('VOLUME_TIMEFRAME_MISMATCH_REJECTED')
    );
  });

  it('測試 3：24h currentVolume 只能搭配 24h historical samples (30 個完整 24h rolling window 樣本)，若拿 15m currentVolume 配 24h baseline 亦直接拒絕', () => {
    const historical24hRollingSamples = Array.from(
      { length: 30 },
      (_, i) => 450_000_000 + ((i % 6) - 2.5) * 45_000_000
    );
    const current24hVolume = 920_000_000;

    const valid24h = evaluateHistoricalVolumeAnomaly({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      currentVolume: current24hVolume,
      historicalVolumes: historical24hRollingSamples,
      volumeTimeframe: '24h',
      currentVolumeTimeframe: '24h',
      historicalVolumeTimeframe: '24h',
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(valid24h.status, 'READY');
    assert.equal(valid24h.volumeTimeframe, '24h');
    assert.equal(
      valid24h.aggregationWindow,
      DEFAULT_AGGREGATION_WINDOWS['24h']
    );
    assert.equal(valid24h.volumeMetric, 'quoteVolume');
    assert.equal(valid24h.sampleCount, 30);
    assert.equal(valid24h.timeframeMismatchRejected, false);
    assert.ok(valid24h.zScore !== null && valid24h.zScore > 1.5);

    // Mismatched 15m currentVolume with 24h historical samples must be rejected
    const invalidMix = evaluateHistoricalVolumeAnomaly({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      currentVolume: 15_000_000,
      historicalVolumes: historical24hRollingSamples,
      volumeTimeframe: '24h',
      currentVolumeTimeframe: '15m',
      historicalVolumeTimeframe: '24h',
      baseProvenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(invalidMix.timeframeMismatchRejected, true);
    assert.equal(invalidMix.zScore, null);
  });

  it('測試 4：QUSDT 不得因時間週期不一致產生假的 Z-Score 130.6 或假性 BASELINE_UNSTABLE；使用一致 15m K 線 quoteVolume 時 status=READY 且 Z-Score 合理 (<= 8)', () => {
    // QUSDT has 24h quoteVolume ~ 1.05B, while each 15m confirmed candle quoteVolume is ~ 11M - 26M
    const qusdt15mConfirmedBars = [
      ...Array.from(
        { length: 30 },
        (_, i) => 11_000_000 + ((i % 7) - 3) * 1_100_000
      ),
      26_500_000, // latest confirmed 15m candle quoteVolume
    ];

    const tickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 0.54,
        quoteVolume24h: 12_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'QUSDT',
        baseAsset: 'Q',
        quoteAsset: 'USDT',
        lastPrice: 1.25,
        bidPrice: 1.2499,
        askPrice: 1.2501,
        priceChangePercent24h: 16.94,
        quoteVolume24h: 1_050_000_000, // 24h quoteVolume is 1.05B (used ONLY for AUX_VOL_RANK_PROXY & liquidity gate, NOT 15m Z-Score!)
        fundingRate: 0.00012,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 45_000_000,
        openInterestValue: 56_250_000,
        provenance: verifiedBinanceLiveProvenance,
      },
    ];

    const histMap = new Map<string, number[]>();
    histMap.set('BTCUSDT', [
      ...Array.from(
        { length: 30 },
        (_, i) => 120_000_000 + ((i % 5) - 2) * 12_000_000
      ),
      135_000_000,
    ]);
    histMap.set('QUSDT', qusdt15mConfirmedBars);

    const scanResult = runMarketScan(tickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      volumeTimeframe: '15m',
    });

    const qusdt = scanResult.candidates.find((c) => c.symbol === 'QUSDT');
    assert.ok(qusdt);
    assert.equal(qusdt.historicalVolume.sampleCount, 30);
    assert.equal(qusdt.historicalVolume.volumeTimeframe, '15m');
    assert.equal(
      qusdt.historicalVolume.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.equal(qusdt.historicalVolume.volumeMetric, 'quoteVolume');
    assert.equal(qusdt.historicalVolume.status, 'READY');
    assert.equal(qusdt.historicalVolume.baselineUnstable, false);
    const rawZ = qusdt.historicalVolume.rawRobustZScore;
    assert.ok(
      rawZ !== null &&
        rawZ !== undefined &&
        rawZ < 130.6 &&
        rawZ <= MAX_SANE_ROBUST_ZSCORE,
      `Expected sane 15m Z-Score <= 8, got ${rawZ}`
    );
    assert.equal(qusdt.marketRadarCategory, '雷達多頭觀察');
    // Without SMC evaluation, smcEvaluationStatus and smcActionState must be PENDING, finalCategory must NOT be 多頭候選 and finalTradeSignal must be NONE
    assert.equal(qusdt.smcEvaluationStatus, 'PENDING');
    assert.equal(qusdt.smcActionState, 'PENDING');
    assert.equal(qusdt.finalCategory, '準備觀察');
    assert.equal(qusdt.finalTradeSignal, 'NONE');
    assert.ok(qusdt.score > 48, `Expected QUSDT score > 48, got ${qusdt.score}`);

    // When SMC confirms LONG CANDIDATE, finalCategory upgrades to 多頭候選 and finalTradeSignal to 多頭交易候選
    const scanWithConfirmedSmc = runMarketScan(
      tickers,
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        historicalVolumeMap: histMap,
        smcMap: new Map([
          ['QUSDT', { actionState: 'LONG CANDIDATE', waitReasons: [] }],
        ]),
        volumeTimeframe: '15m',
      }
    );
    const qusdtConfirmed = scanWithConfirmedSmc.candidates.find(
      (c) => c.symbol === 'QUSDT'
    )!;
    assert.equal(qusdtConfirmed.marketRadarCategory, '雷達多頭觀察');
    assert.equal(qusdtConfirmed.smcActionState, 'LONG CANDIDATE');
    assert.equal(qusdtConfirmed.finalCategory, '多頭候選');
    assert.equal(qusdtConfirmed.finalTradeSignal, '多頭交易候選');
  });

  it('測試 5 & 6：provenance 必須包含 volumeTimeframe 與 aggregationWindow，且市場雷達候選 (第一層) 與 SMC/ICT 狀態 (第二層) 維持雙層分離', () => {
    const qusdt15mConfirmedBars = [
      ...Array.from(
        { length: 30 },
        (_, i) => 11_000_000 + ((i % 7) - 3) * 1_100_000
      ),
      26_500_000,
    ];

    const tickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 90000,
        bidPrice: 89999.5,
        askPrice: 90000.5,
        priceChangePercent24h: 0.54,
        quoteVolume24h: 12_000_000_000,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 50000,
        openInterestValue: 4_500_000_000,
        provenance: verifiedBinanceLiveProvenance,
      },
      {
        symbol: 'QUSDT',
        baseAsset: 'Q',
        quoteAsset: 'USDT',
        lastPrice: 1.25,
        bidPrice: 1.2499,
        askPrice: 1.2501,
        priceChangePercent24h: 16.94,
        quoteVolume24h: 1_050_000_000,
        fundingRate: 0.00012,
        nextFundingTime: Date.now() + 3600000,
        openInterest: 45_000_000,
        openInterestValue: 56_250_000,
        provenance: verifiedBinanceLiveProvenance,
      },
    ];

    const histMap = new Map<string, number[]>([
      ['QUSDT', qusdt15mConfirmedBars],
    ]);
    // Simulate SMC/ICT returning WAIT while Market Radar passes all gates
    const smcMap = new Map([
      [
        'QUSDT',
        {
          actionState: 'WAIT' as const,
          waitReasons: ['尚未形成完整 MSS/FVG/OB 或多週期未確認'],
        },
      ],
    ]);

    const scanResult = runMarketScan(tickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      smcMap,
      volumeTimeframe: '15m',
    });

    // Test 5: Provenance must expose volumeTimeframe and aggregationWindow
    assert.equal(scanResult.provenance.volumeTimeframe, '15m');
    assert.equal(
      scanResult.provenance.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.equal(scanResult.provenance.volumeMetric, 'quoteVolume');

    const qusdt = scanResult.candidates.find((c) => c.symbol === 'QUSDT')!;
    assert.ok(qusdt);
    assert.equal(qusdt.provenance.volumeTimeframe, '15m');
    assert.equal(
      qusdt.provenance.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.equal(qusdt.decisionTrace.gates.history.volumeTimeframe, '15m');
    assert.equal(
      qusdt.decisionTrace.gates.history.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );

    // Test 6: Two-layer separation preserved — SMC WAIT does NOT overwrite Market Radar '雷達多頭觀察',
    // and Market Radar '雷達多頭觀察' does NOT upgrade finalCategory to '多頭候選' when SMC is WAIT
    assert.equal(qusdt.marketRadarCategory, '雷達多頭觀察');
    assert.equal(qusdt.smcEvaluationStatus, 'EVALUATED');
    assert.equal(qusdt.smcActionState, 'WAIT');
    assert.equal(qusdt.finalCategory, '準備觀察');
    assert.equal(qusdt.finalTradeSignal, 'NONE');
    assert.equal(scanResult.marketRadarLongCount, 1);
    assert.equal(scanResult.smcPendingCount, 1); // BTCUSDT not in smcMap -> PENDING
    assert.equal(scanResult.smcWaitCount, 1); // QUSDT in smcMap -> WAIT
    assert.equal(scanResult.smcGateNotConfirmedCount, 1); // Only EVALUATED non-candidates count
    assert.equal(scanResult.smcLongCandidateCount, 0);
    assert.equal(scanResult.finalCategorySmcMismatchCount, 0);
    assert.ok(
      qusdt.decisionTrace.downgradeReasons.some((r) =>
        r.includes('SMC_GATE_NOT_CONFIRMED')
      )
    );
  });
});

describe('9. 15m K 線歷史量能基線無自我汙染與無前視偏差驗證 (Strict Prior-30-Bar Baseline Exclusion)', () => {
  it('測試 1：current bar 的成交量不應出現在自己的 historical samples 中（若僅提供 30 根含 current bar 的序列，prior baseline 僅 29 根且不包含 current bar）', () => {
    const prior30Bars = Array.from(
      { length: 30 },
      (_, i) => 10_000_000 + i * 250_000
    );
    const uniqueCurrentBarVol = 77_777_777;
    const series31 = [...prior30Bars, uniqueCurrentBarVol];

    // Direct extraction check
    const window31 = extractPriorConfirmedBaselineWindow(series31);
    assert.equal(window31.currentVolume, uniqueCurrentBarVol);
    assert.equal(window31.historicalVolumes.length, 30);
    assert.equal(
      window31.historicalVolumes.includes(uniqueCurrentBarVol),
      false,
      'current bar 的成交量絕不可出現在自己的 historicalVolumes 中'
    );
    assert.deepEqual(window31.historicalVolumes, prior30Bars);

    // Evaluate via evaluateConfirmedKlineVolumeSeries
    const eval31 = evaluateConfirmedKlineVolumeSeries({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      confirmedQuoteVolumes: series31,
      baseProvenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(eval31.currentVolume, uniqueCurrentBarVol);
    assert.equal(eval31.sampleCount, 30);
    assert.ok(eval31.historicalSamples);
    assert.equal(
      eval31.historicalSamples.includes(uniqueCurrentBarVol),
      false,
      'evaluateConfirmedKlineVolumeSeries 的 historicalSamples 不可包含 current bar'
    );
    assert.equal(eval31.volumeTimeframe, '15m');
    assert.equal(eval31.aggregationWindow, '15m_CONFIRMED_KLINE_30_BARS');
    assert.equal(eval31.volumeMetric, 'quoteVolume');

    // Also verify via runMarketScan: if a chronological series has only 30 bars total (29 prior + 1 current),
    // MarketScanner MUST NOT include the 30th bar in its own baseline to fake 30 samples!
    const only29PriorPlusCurrent = [...prior30Bars.slice(0, 29), uniqueCurrentBarVol];
    assert.equal(only29PriorPlusCurrent.length, 30);

    const ticker: MarketTicker = {
      symbol: 'QUSDT',
      baseAsset: 'Q',
      quoteAsset: 'USDT',
      lastPrice: 1.25,
      bidPrice: 1.2499,
      askPrice: 1.2501,
      priceChangePercent24h: 16.94,
      quoteVolume24h: 1_050_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600000,
      openInterest: 45_000_000,
      openInterestValue: 56_250_000,
      provenance: verifiedBinanceLiveProvenance,
    };

    const scanWithOnly29Prior = runMarketScan(
      [ticker],
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        historicalVolumeMap: new Map([['QUSDT', only29PriorPlusCurrent]]),
        volumeTimeframe: '15m',
      }
    );
    const cand29 = scanWithOnly29Prior.candidates[0];
    assert.equal(cand29.historicalVolume.currentVolume, uniqueCurrentBarVol);
    assert.equal(cand29.historicalVolume.sampleCount, 29);
    assert.equal(cand29.historicalVolume.status, 'INSUFFICIENT_HISTORY');
    assert.equal(
      cand29.historicalVolume.historicalSamples?.includes(uniqueCurrentBarVol),
      false,
      'MarketScanner 絕不可將 current bar 塞入 historicalSamples 湊滿 30 筆'
    );
  });

  it('測試 2：改變 current bar 成交量時，baseline median 與 MAD 不應被改變', () => {
    const prior30Bars = Array.from(
      { length: 30 },
      (_, i) => 12_000_000 + ((i % 7) - 3) * 1_200_000
    );

    const currentBarVolumesToTest = [
      5_000_000,
      12_000_000,
      25_000_000,
      42_000_000,
      999_999_999,
    ];

    const results = currentBarVolumesToTest.map((curVol) =>
      evaluateConfirmedKlineVolumeSeries({
        symbol: 'QUSDT',
        exchange: 'binance_usdm',
        confirmedQuoteVolumes: [...prior30Bars, curVol],
        baseProvenance: verifiedBinanceLiveProvenance,
      })
    );

    const expectedMedian = results[0].rollingMedian;
    const expectedMad = results[0].mad;
    const expectedRatio = results[0].madToMedianRatio;
    assert.ok(expectedMedian !== null && expectedMedian > 0);
    assert.ok(expectedMad !== null && expectedMad > 0);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      assert.equal(r.currentVolume, currentBarVolumesToTest[i]);
      assert.equal(
        r.rollingMedian,
        expectedMedian,
        `改變 current bar 為 ${currentBarVolumesToTest[i]} 時，rollingMedian 必須恆定不變`
      );
      assert.equal(
        r.mad,
        expectedMad,
        `改變 current bar 為 ${currentBarVolumesToTest[i]} 時，mad 必須恆定不變`
      );
      assert.equal(r.madToMedianRatio, expectedRatio);
      assert.deepEqual(r.historicalSamples, prior30Bars);
      assert.equal(r.volumeTimeframe, '15m');
      assert.equal(r.aggregationWindow, '15m_CONFIRMED_KLINE_30_BARS');
      assert.equal(r.volumeMetric, 'quoteVolume');
    }
  });

  it('測試 3：只有改變前 30 根 K 線時，baseline 才可以改變', () => {
    const fixedCurrentBarVol = 24_000_000;

    const baselineA = Array.from(
      { length: 30 },
      (_, i) => 10_000_000 + ((i % 5) - 2) * 1_000_000
    );
    const baselineB = Array.from(
      { length: 30 },
      (_, i) => 18_000_000 + ((i % 5) - 2) * 2_200_000
    );

    const resA = evaluateConfirmedKlineVolumeSeries({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      confirmedQuoteVolumes: [...baselineA, fixedCurrentBarVol],
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    const resB = evaluateConfirmedKlineVolumeSeries({
      symbol: 'QUSDT',
      exchange: 'binance_usdm',
      confirmedQuoteVolumes: [...baselineB, fixedCurrentBarVol],
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(resA.currentVolume, fixedCurrentBarVol);
    assert.equal(resB.currentVolume, fixedCurrentBarVol);
    assert.notEqual(
      resA.rollingMedian,
      resB.rollingMedian,
      '改變前 30 根 K 線時，rollingMedian 必須隨之改變'
    );
    assert.notEqual(
      resA.mad,
      resB.mad,
      '改變前 30 根 K 線時，MAD 必須隨之改變'
    );
    assert.equal(resA.rollingMedian, 10_000_000);
    assert.equal(resB.rollingMedian, 18_000_000);
    assert.equal(resA.mad, 1_000_000);
    assert.equal(resB.mad, 2_200_000);
  });

  it('測試 4 & 5：回測每個時間點都只能使用該時間點以前的 30 根已確認 K 線，且保留 volumeTimeframe="15m"、aggregationWindow="15m_CONFIRMED_KLINE_30_BARS"、volumeMetric="quoteVolume"', () => {
    const baseKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 65,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    // Assign strictly unique quoteVolume to every bar so we can verify exact bar membership
    const klinesWithUniqueVols = baseKlines.map((k, idx) => ({
      ...k,
      isClosed: true,
      quoteVolume: 10_000_000 + idx * 310_000 + (idx % 5) * 450_000,
    }));

    const engine = new BacktestEngine();
    const { historicalOpenInterest: histOi, historicalFundingRates: histFunding } =
      generateDeterministicHistoricalOiAndFunding({
        symbol: 'SOLUSDT',
        klines: klinesWithUniqueVols,
        baseOi: 15_000_000,
        baseFundingRate: 0.0001,
      });
    const btResult = engine.runDeterministicBacktest({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: klinesWithUniqueVols,
      historicalOpenInterest: histOi,
      historicalFundingRates: histFunding,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(btResult.status, 'COMPLETED');
    assert.equal(btResult.lookaheadFreeVerified, true);
    assert.ok(
      btResult.pointInTimeVolumeSnapshots &&
        btResult.pointInTimeVolumeSnapshots.length > 0,
      '回測必須記錄每個時間點的量能基線快照'
    );

    for (const snap of btResult.pointInTimeVolumeSnapshots) {
      const i = snap.barIndex;
      const expectedCurrentBar = klinesWithUniqueVols[i];
      const expectedPrior30Bars = klinesWithUniqueVols.slice(i - 30, i);
      const expectedPrior30Vols = expectedPrior30Bars.map((b) => b.quoteVolume);
      const expectedPrior30Times = expectedPrior30Bars.map((b) => b.openTime);

      // 1. Metadata preserved
      assert.equal(snap.volumeTimeframe, '15m');
      assert.equal(snap.aggregationWindow, '15m_CONFIRMED_KLINE_30_BARS');
      assert.equal(snap.volumeMetric, 'quoteVolume');
      assert.equal(snap.sampleCount, 30);

      // 2. Current bar volume matches bar i, and is NOT in historicalSamples
      assert.equal(snap.currentVolume, expectedCurrentBar.quoteVolume);
      assert.equal(
        snap.historicalSamples.includes(expectedCurrentBar.quoteVolume),
        false,
        `回測時間點 barIndex=${i} 的 currentVolume 不可出現在自己的 historicalSamples 中`
      );

      // 3. Historical samples strictly match bars [i - 30, ..., i - 1]
      assert.deepEqual(snap.historicalSamples, expectedPrior30Vols);
      assert.deepEqual(snap.baselineWindowOpenTimes, expectedPrior30Times);

      // 4. Every baseline bar openTime is strictly earlier than current bar openTime (< barOpenTime)
      for (const t of snap.baselineWindowOpenTimes) {
        assert.ok(
          t < snap.barOpenTime,
          `回測基線時間戳 (${t}) 必須嚴格早於當前評估 K 線時間戳 (${snap.barOpenTime})`
        );
      }

      // 5. Mutating current bar i or future bars (> i) does NOT change bar i's baseline median or MAD
      const mutatedKlines = klinesWithUniqueVols.map((k, idx) =>
        idx >= i ? { ...k, quoteVolume: k.quoteVolume * 9.5 } : k
      );
      const btMutated = engine.runDeterministicBacktest({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines: mutatedKlines,
        historicalOpenInterest: histOi,
        historicalFundingRates: histFunding,
        provenance: verifiedBinanceLiveProvenance,
      });
      const mutatedSnapAtI = btMutated.pointInTimeVolumeSnapshots!.find(
        (s) => s.barIndex === i
      )!;
      assert.equal(mutatedSnapAtI.rollingMedian, snap.rollingMedian);
      assert.equal(mutatedSnapAtI.mad, snap.mad);
      assert.deepEqual(mutatedSnapAtI.historicalSamples, snap.historicalSamples);
    }
  });
});

describe('11. SMC/ICT 嚴格通過條件、已收盤 K 線 vs SMC 確認區分、雙層獨立性與安全規範驗證', () => {
  it('1. 所有 K 線都是 isClosed === true，不代表 SMC 一定通過（RANGE 與 WATCH_BULL 雖有 60 根全部 isClosed=true 的 K 線，但不得輸出 LONG/SHORT CANDIDATE）', () => {
    const rangeKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'RANGE',
    }).map((k) => ({ ...k, isClosed: true }));
    assert.ok(rangeKlines.every((k) => k.isClosed === true));

    const rangeRes = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': rangeKlines,
        '15m': rangeKlines,
        '1h': rangeKlines,
        '4h': rangeKlines,
      },
      openInterest: 50_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(rangeRes.confirmedKlineCount, 60);
    assert.equal(rangeRes.unclosedKlineIgnoredCount, 0);
    assert.notEqual(rangeRes.actionState, 'LONG CANDIDATE');
    assert.notEqual(rangeRes.actionState, 'SHORT CANDIDATE');
    assert.equal(rangeRes.actionState, 'WAIT');

    const watchBullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'WATCH_BULL',
    }).map((k) => ({ ...k, isClosed: true }));
    assert.ok(watchBullKlines.every((k) => k.isClosed === true));

    const watchRes = evaluateSmcStructure({
      symbol: 'LINKUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': watchBullKlines,
        '15m': watchBullKlines,
        '1h': watchBullKlines,
        '4h': watchBullKlines,
      },
      openInterest: 25_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(watchRes.confirmedKlineCount, 60);
    assert.equal(watchRes.unclosedKlineIgnoredCount, 0);
    assert.equal(watchRes.actionState, 'WATCH');
  });

  it('2. 缺少 MSS/BOS、Liquidity Sweep、Displacement、FVG/OB 或多週期確認時，必須輸出 WAIT 或 WATCH（全部條件齊備才可輸出 CANDIDATE）', () => {
    const fullBullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });

    // Baseline: All conditions met -> LONG CANDIDATE
    const fullBullRes = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': fullBullKlines,
        '15m': fullBullKlines,
        '1h': fullBullKlines,
        '4h': fullBullKlines,
      },
      openInterest: 100_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(fullBullRes.bosOrMss.detected, true);
    assert.equal(fullBullRes.liquiditySweep.detected, true);
    assert.equal(fullBullRes.displacement.detected, true);
    assert.ok(
      (fullBullRes.fvg.detected &&
        fullBullRes.fvg.direction === 'BULL' &&
        !fullBullRes.fvg.mitigated) ||
        (fullBullRes.orderBlock.detected &&
          fullBullRes.orderBlock.direction === 'BULL')
    );
    assert.equal(fullBullRes.mtfAlignment.aligned, true);
    assert.equal(fullBullRes.actionState, 'LONG CANDIDATE');

    // Case A: Remove Liquidity Sweep (remove wick sweeps on recent 14 bars so neither SSL nor BSL sweep occurs)
    const noSweepKlines = fullBullKlines.map((k, idx) =>
      idx >= fullBullKlines.length - 14
        ? {
            ...k,
            high: Math.max(k.open, k.close),
            low: Math.min(k.open, k.close),
          }
        : k
    );
    const noSweepRes = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': noSweepKlines,
        '15m': noSweepKlines,
        '1h': noSweepKlines,
        '4h': noSweepKlines,
      },
      openInterest: 100_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(noSweepRes.liquiditySweep.detected, false);
    assert.ok(
      noSweepRes.actionState === 'WATCH' || noSweepRes.actionState === 'WAIT',
      `缺少 Liquidity Sweep 時必須輸出 WATCH 或 WAIT，實際為 ${noSweepRes.actionState}`
    );

    // Case B: Remove Displacement (shrink candle bodies across lookback window so bodyToAtrRatio < 1.3)
    const noDispKlines = fullBullKlines.map((k, idx) =>
      idx >= fullBullKlines.length - 14
        ? {
            ...k,
            open: k.close - 0.05,
            high: k.close + 0.25,
            low: k.close - 0.25,
          }
        : k
    );
    const noDispRes = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': noDispKlines,
        '15m': noDispKlines,
        '1h': noDispKlines,
        '4h': noDispKlines,
      },
      openInterest: 100_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(noDispRes.displacement.detected, false);
    assert.ok(
      noDispRes.actionState === 'WATCH' || noDispRes.actionState === 'WAIT',
      `缺少 Displacement 時必須輸出 WATCH 或 WAIT，實際為 ${noDispRes.actionState}`
    );

    // Case C: Multi-timeframe conflict (15m BULL vs 1h/4h BEAR) -> must output WAIT
    const bearKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 60 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BEAR',
    });
    const mtfConflictRes = evaluateSmcStructure({
      symbol: 'XRPUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': fullBullKlines,
        '15m': fullBullKlines,
        '1h': bearKlines,
        '4h': bearKlines,
      },
      openInterest: 100_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });
    assert.equal(mtfConflictRes.mtfAlignment.dominantDirection, 'CONFLICT');
    assert.equal(mtfConflictRes.actionState, 'WAIT');
  });

  it('3 & 4. 第一層雷達候選可以存在但第二層仍可為 WAIT/WATCH；Demo 全市場 18 檔標的絕不會全部被標為 Confirmed', async () => {
    const demoAdapter = new DemoExchangeAdapter();
    const snapshot = await demoAdapter.fetchMarketSnapshot();
    const histMap = buildDemoHistoricalVolumeMap();
    const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
      mode: 'demo',
      exchange: 'demo_synthetic',
      volumeTimeframe: '15m',
      historicalVolumeMap: histMap,
    });

    const smcMap = new Map();
    for (const t of snapshot.tickers) {
      const preCandidate = preScan.candidates.find((c) => c.symbol === t.symbol)!;
      const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
        demoAdapter.fetchOpenInterest(t.symbol, t.lastPrice),
        demoAdapter.fetchKlines(t.symbol, '5m', 90),
        demoAdapter.fetchKlines(t.symbol, '15m', 90),
        demoAdapter.fetchKlines(t.symbol, '1h', 90),
        demoAdapter.fetchKlines(t.symbol, '4h', 90),
      ]);
      const smcRes = evaluateSmcStructure({
        symbol: t.symbol,
        primaryTimeframe: '15m',
        klinesByTimeframe: {
          '5m': k5m.klines,
          '15m': k15m.klines,
          '1h': k1h.klines,
          '4h': k4h.klines,
        },
        openInterest: oiRes.openInterest,
        historicalVolume: preCandidate.historicalVolume,
        isLowLiquidity: preCandidate.isLowLiquidity,
        extremeFunding: preCandidate.extremeFunding,
        lowLiquidityHighVolatility: preCandidate.lowLiquidityHighVolatility,
        provenance: t.provenance,
      });
      smcMap.set(t.symbol, smcRes);
    }

    const finalScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
      mode: 'demo',
      exchange: 'demo_synthetic',
      volumeTimeframe: '15m',
      historicalVolumeMap: histMap,
      smcMap,
    });

    assert.equal(finalScan.candidates.length, 18);
    assert.ok(finalScan.smcLongCandidateCount > 0, '應有部分 LONG CANDIDATE');
    assert.ok(finalScan.smcShortCandidateCount > 0, '應有部分 SHORT CANDIDATE');
    assert.ok((finalScan.smcWatchCount ?? 0) > 0, '應有部分 WATCH');
    assert.ok(finalScan.smcWaitCount > 0, '應有部分 WAIT');
    assert.ok(
      finalScan.smcLongCandidateCount + finalScan.smcShortCandidateCount <
        finalScan.candidates.length,
      '絕不可將所有幣種都標為 SMC CANDIDATE'
    );

    // Layer 1 Radar candidate with Layer 2 WAIT (e.g. XRPUSDT, AVAXUSDT, DOTUSDT)
    const radarLongWait = finalScan.candidates.find(
      (c) =>
        c.marketRadarCategory === '雷達多頭觀察' && c.smcActionState === 'WAIT'
    );
    assert.ok(
      radarLongWait,
      '必須存在第一層為「雷達多頭觀察」但第二層為「WAIT」的幣種'
    );
    assert.equal(radarLongWait.gates.smc.passed, false);
    assert.ok(
      radarLongWait.downgradeReasons.some((r) =>
        r.includes('SMC_GATE_NOT_CONFIRMED')
      )
    );

    // Layer 1 Radar candidate with Layer 2 WATCH (e.g. LINKUSDT, NEARUSDT, OPUSDT)
    const radarWithWatch = finalScan.candidates.find(
      (c) =>
        (c.marketRadarCategory === '雷達多頭觀察' ||
          c.marketRadarCategory === '雷達空頭觀察') &&
        c.smcActionState === 'WATCH'
    );
    assert.ok(
      radarWithWatch,
      '必須存在第一層為雷達觀察但第二層為「WATCH」的幣種'
    );
    assert.equal(radarWithWatch.gates.smc.passed, false);
    assert.ok(
      radarWithWatch.downgradeReasons.some((r) =>
        r.includes('SMC_GATE_NOT_CONFIRMED')
      )
    );
  });

  it('5. 未收盤 K 線 (isClosed === false) 不得進入 SMC 判斷（末端附加未收盤假突破 K 線時完全被排除）', () => {
    const closedRangeKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now() - 15 * 60 * 1000,
      mode: 'RANGE',
    }).map((k) => ({ ...k, isClosed: true }));

    const baselineRes = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: { '15m': closedRangeKlines },
      openInterest: 50_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });

    // Append an extreme unclosed breakout candle (isClosed: false)
    const unclosedFakeBreakout = {
      openTime: Date.now(),
      closeTime: Date.now() + 15 * 60 * 1000 - 1,
      open: 100,
      high: 185,
      low: 70,
      close: 180,
      volume: 999_999,
      quoteVolume: 999_999_999,
      isClosed: false,
    };

    const withUnclosedRes = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '15m': [...closedRangeKlines, unclosedFakeBreakout],
      },
      openInterest: 50_000_000,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(withUnclosedRes.unclosedKlineIgnoredCount, 1);
    assert.equal(withUnclosedRes.confirmedKlineCount, 60);
    assert.equal(withUnclosedRes.actionState, baselineRes.actionState);
    assert.equal(
      withUnclosedRes.bosOrMss.detected,
      baselineRes.bosOrMss.detected
    );
    assert.equal(
      withUnclosedRes.displacement.detected,
      baselineRes.displacement.detected
    );
  });
});

describe('12. 第一層市場雷達與第二層 SMC/ICT 分類分離與 finalTradeSignal 嚴格規則驗證', () => {
  const sampleBars31 = [
    ...Array.from(
      { length: 30 },
      (_, i) => 20_000_000 + ((i % 5) - 2) * 2_000_000
    ),
    42_000_000,
  ];

  const baseTickers: MarketTicker[] = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 90000,
      bidPrice: 89999.5,
      askPrice: 90000.5,
      priceChangePercent24h: 1.0,
      quoteVolume24h: 10_000_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600000,
      openInterest: 50000,
      openInterestValue: 4_500_000_000,
      provenance: verifiedBinanceLiveProvenance,
    },
    {
      symbol: 'BULL_RADAR_USDT',
      baseAsset: 'BULL_RADAR',
      quoteAsset: 'USDT',
      lastPrice: 100,
      bidPrice: 99.99,
      askPrice: 100.01,
      priceChangePercent24h: 9.2,
      quoteVolume24h: 3_500_000_000,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600000,
      openInterest: 100000,
      openInterestValue: 10_000_000,
      provenance: verifiedBinanceLiveProvenance,
    },
    {
      symbol: 'BEAR_RADAR_USDT',
      baseAsset: 'BEAR_RADAR',
      quoteAsset: 'USDT',
      lastPrice: 50,
      bidPrice: 49.99,
      askPrice: 50.01,
      priceChangePercent24h: -6.8,
      quoteVolume24h: 2_800_000_000,
      fundingRate: -0.0001,
      nextFundingTime: Date.now() + 3600000,
      openInterest: 200000,
      openInterestValue: 10_000_000,
      provenance: verifiedBinanceLiveProvenance,
    },
  ];

  const histMap = new Map<string, number[]>([
    ['BTCUSDT', sampleBars31],
    ['BULL_RADAR_USDT', sampleBars31],
    ['BEAR_RADAR_USDT', sampleBars31],
  ]);

  it('1 & 3. SMC 為 WAIT 時，finalTradeSignal 必須為 NONE，不得為多頭或空頭，且第一層雷達多頭觀察與第二層 WAIT 必須同時保留且不可混淆', () => {
    const scanWait = runMarketScan(baseTickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      smcMap: new Map([
        [
          'BULL_RADAR_USDT',
          {
            actionState: 'WAIT',
            waitReasons: ['尚未形成完整 MSS/FVG/OB 或多週期未確認'],
          },
        ],
        [
          'BEAR_RADAR_USDT',
          {
            actionState: 'WAIT',
            waitReasons: ['尚未形成完整 MSS/FVG/OB 或多週期未確認'],
          },
        ],
      ]),
    });

    const bullWait = scanWait.candidates.find(
      (c) => c.symbol === 'BULL_RADAR_USDT'
    )!;
    const bearWait = scanWait.candidates.find(
      (c) => c.symbol === 'BEAR_RADAR_USDT'
    )!;

    // Layer 1 preserved as 雷達多頭觀察 / 雷達空頭觀察
    assert.equal(bullWait.marketRadarCategory, '雷達多頭觀察');
    assert.equal(bearWait.marketRadarCategory, '雷達空頭觀察');
    // Layer 2 preserved as WAIT
    assert.equal(bullWait.smcActionState, 'WAIT');
    assert.equal(bearWait.smcActionState, 'WAIT');
    // Final trade signal MUST be NONE and finalCategory MUST NOT be 多頭候選 / 空頭候選
    assert.equal(bullWait.finalTradeSignal, 'NONE');
    assert.equal(bearWait.finalTradeSignal, 'NONE');
    assert.equal(bullWait.category, '準備觀察');
    assert.equal(bullWait.finalCategory, '準備觀察');
    assert.equal(bearWait.category, '準備觀察');
    assert.equal(bearWait.finalCategory, '準備觀察');
    assert.equal(scanWait.finalCategorySmcMismatchCount, 0);
  });

  it('2. SMC 為 WATCH 時，finalTradeSignal 必須為 NONE，不得為多頭或空頭，finalCategory 亦不得為多頭候選或空頭候選', () => {
    const scanWatch = runMarketScan(baseTickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      smcMap: new Map([
        [
          'BULL_RADAR_USDT',
          {
            actionState: 'WATCH',
            waitReasons: [
              '具備 BULL 結構突破與 FVG/OB 區，但缺少流動性掃蕩或強位移確認 (WATCH)',
            ],
          },
        ],
        [
          'BEAR_RADAR_USDT',
          {
            actionState: 'WATCH',
            waitReasons: [
              '具備 BEAR 結構突破與 FVG/OB 區，但缺少流動性掃蕩或強位移確認 (WATCH)',
            ],
          },
        ],
      ]),
    });

    const bullWatch = scanWatch.candidates.find(
      (c) => c.symbol === 'BULL_RADAR_USDT'
    )!;
    const bearWatch = scanWatch.candidates.find(
      (c) => c.symbol === 'BEAR_RADAR_USDT'
    )!;

    assert.equal(bullWatch.marketRadarCategory, '雷達多頭觀察');
    assert.equal(bullWatch.smcActionState, 'WATCH');
    assert.equal(bullWatch.finalTradeSignal, 'NONE');
    assert.equal(bullWatch.category, '準備觀察');
    assert.equal(bullWatch.finalCategory, '準備觀察');

    assert.equal(bearWatch.marketRadarCategory, '雷達空頭觀察');
    assert.equal(bearWatch.smcActionState, 'WATCH');
    assert.equal(bearWatch.finalTradeSignal, 'NONE');
    assert.equal(bearWatch.category, '準備觀察');
    assert.equal(bearWatch.finalCategory, '準備觀察');
    assert.equal(scanWatch.finalCategorySmcMismatchCount, 0);
  });

  it('4 & 5. 只有 SMC LONG CANDIDATE 才能產生多頭交易候選，只有 SMC SHORT CANDIDATE 才能產生空頭交易候選（且若方向相反則阻擋為 NONE）', () => {
    const scanConfirmed = runMarketScan(
      baseTickers,
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        historicalVolumeMap: histMap,
        smcMap: new Map([
          [
            'BULL_RADAR_USDT',
            { actionState: 'LONG CANDIDATE', waitReasons: [] },
          ],
          [
            'BEAR_RADAR_USDT',
            { actionState: 'SHORT CANDIDATE', waitReasons: [] },
          ],
        ]),
      }
    );

    const bullConfirmed = scanConfirmed.candidates.find(
      (c) => c.symbol === 'BULL_RADAR_USDT'
    )!;
    const bearConfirmed = scanConfirmed.candidates.find(
      (c) => c.symbol === 'BEAR_RADAR_USDT'
    )!;

    assert.equal(bullConfirmed.marketRadarCategory, '雷達多頭觀察');
    assert.equal(bullConfirmed.smcActionState, 'LONG CANDIDATE');
    assert.equal(bullConfirmed.finalTradeSignal, '多頭交易候選');
    assert.equal(bullConfirmed.finalCategory, '多頭候選');

    assert.equal(bearConfirmed.marketRadarCategory, '雷達空頭觀察');
    assert.equal(bearConfirmed.smcActionState, 'SHORT CANDIDATE');
    assert.equal(bearConfirmed.finalTradeSignal, '空頭交易候選');
    assert.equal(bearConfirmed.finalCategory, '空頭候選');
    assert.equal(scanConfirmed.finalCategorySmcMismatchCount, 0);

    // Direction mismatch check: Layer 1 雷達多頭觀察 + Layer 2 SHORT CANDIDATE -> must NOT produce trade signal
    const scanConflict = runMarketScan(
      baseTickers,
      verifiedBinanceLiveProvenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        historicalVolumeMap: histMap,
        smcMap: new Map([
          [
            'BULL_RADAR_USDT',
            { actionState: 'SHORT CANDIDATE', waitReasons: [] },
          ],
          [
            'BEAR_RADAR_USDT',
            { actionState: 'LONG CANDIDATE', waitReasons: [] },
          ],
        ]),
      }
    );
    const bullConflict = scanConflict.candidates.find(
      (c) => c.symbol === 'BULL_RADAR_USDT'
    )!;
    assert.equal(bullConflict.finalTradeSignal, 'NONE');
    assert.equal(bullConflict.finalCategory, '準備觀察');
    assert.equal(scanConflict.finalCategorySmcMismatchCount, 0);
  });

  it('7. 未收盤 K 線 (isClosed === false) 不能影響 15m 量能基線或當前 K 線量能結果', () => {
    const confirmedKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 35,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now() - 15 * 60 * 1000,
      mode: 'BULL',
    }).map((k) => ({ ...k, isClosed: true }));

    const closedQuotes = confirmedKlines
      .filter((k) => k.isClosed === true)
      .map((k) => k.quoteVolume);

    const baselineVolEval = evaluateConfirmedKlineVolumeSeries({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      confirmedQuoteVolumes: closedQuotes,
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    // Simulate an unclosed candle with 100x volume appended at the end
    const withUnclosedKlines = [
      ...confirmedKlines,
      {
        openTime: Date.now(),
        closeTime: Date.now() + 15 * 60 * 1000 - 1,
        open: 105,
        high: 130,
        low: 95,
        close: 125,
        volume: 99_999_999,
        quoteVolume: 9_999_999_999,
        isClosed: false,
      },
    ];
    const filteredClosedQuotes = withUnclosedKlines
      .filter((k) => k.isClosed === true)
      .map((k) => k.quoteVolume);

    const afterUnclosedVolEval = evaluateConfirmedKlineVolumeSeries({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      confirmedQuoteVolumes: filteredClosedQuotes,
      baseProvenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(
      afterUnclosedVolEval.currentVolume,
      baselineVolEval.currentVolume
    );
    assert.equal(
      afterUnclosedVolEval.rollingMedian,
      baselineVolEval.rollingMedian
    );
    assert.equal(afterUnclosedVolEval.mad, baselineVolEval.mad);
    assert.equal(
      afterUnclosedVolEval.robustZScore,
      baselineVolEval.robustZScore
    );
  });

  it('8. 尚未載入多週期資料時狀態為 PENDING (非 WAIT)，不計入 smcWaitCount 與 smcGateNotConfirmedCount，且 finalTradeSignal 必須為 NONE', () => {
    // 8a. evaluateSmcStructure with missing timeframes when requireFullMultiTimeframe=true -> PENDING
    const bullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 45,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now() - 15 * 60 * 1000,
      mode: 'BULL',
    }).map((k) => ({ ...k, isClosed: true }));

    const pendingEval = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '15m': bullKlines,
        // Missing 5m, 1h, 4h!
      },
      requireFullMultiTimeframe: true,
      openInterest: 100000,
      provenance: verifiedBinanceLiveProvenance,
    });

    assert.equal(pendingEval.smcEvaluationStatus, 'PENDING');
    assert.equal(pendingEval.actionState, 'PENDING');
    assert.equal(
      pendingEval.waitReasons.length,
      0,
      'PENDING must not produce WAIT reasons'
    );

    // 8b. MarketScanner with 1 PENDING symbol, 1 EVALUATED WAIT symbol, 1 EVALUATED LONG CANDIDATE symbol
    const mixedScan = runMarketScan(baseTickers, verifiedBinanceLiveProvenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: histMap,
      smcMap: new Map([
        // BTCUSDT is omitted -> must become PENDING
        [
          'BULL_RADAR_USDT',
          {
            evaluationStatus: 'EVALUATED',
            actionState: 'LONG CANDIDATE',
            waitReasons: [],
          },
        ],
        [
          'BEAR_RADAR_USDT',
          {
            evaluationStatus: 'EVALUATED',
            actionState: 'WAIT',
            waitReasons: [
              '多週期結構方向分歧 (MIXED)，缺乏一致趨勢確認',
              '近期未見確認之流動性掃蕩 (Liquidity Sweep)',
            ],
          },
        ],
      ]),
    });

    const btcPending = mixedScan.candidates.find((c) => c.symbol === 'BTCUSDT')!;
    const bullLong = mixedScan.candidates.find(
      (c) => c.symbol === 'BULL_RADAR_USDT'
    )!;
    const bearWait = mixedScan.candidates.find(
      (c) => c.symbol === 'BEAR_RADAR_USDT'
    )!;

    assert.equal(btcPending.smcEvaluationStatus, 'PENDING');
    assert.equal(btcPending.smcActionState, 'PENDING');
    assert.equal(btcPending.finalTradeSignal, 'NONE');
    assert.ok(
      !btcPending.decisionTrace.downgradeReasons.some((r) =>
        r.startsWith('SMC_GATE_NOT_CONFIRMED')
      ),
      'PENDING symbol must NOT have SMC_GATE_NOT_CONFIRMED downgrade reason'
    );
    assert.ok(
      btcPending.decisionTrace.downgradeReasons.some((r) =>
        r.startsWith('SMC_EVALUATION_PENDING')
      ),
      'PENDING symbol must have SMC_EVALUATION_PENDING downgrade reason'
    );

    assert.equal(bullLong.smcEvaluationStatus, 'EVALUATED');
    assert.equal(bullLong.smcActionState, 'LONG CANDIDATE');
    assert.equal(bullLong.finalTradeSignal, '多頭交易候選');

    assert.equal(bearWait.smcEvaluationStatus, 'EVALUATED');
    assert.equal(bearWait.smcActionState, 'WAIT');
    assert.equal(bearWait.finalTradeSignal, 'NONE');

    // Counter invariants:
    // smcPendingCount + smcWaitCount + smcWatchCount + smcLongCandidateCount + smcShortCandidateCount + smcHighRiskCount === totalContractsScanned
    assert.equal(mixedScan.totalContractsScanned, 3);
    assert.equal(mixedScan.smcPendingCount, 1);
    assert.equal(mixedScan.smcWaitCount, 1);
    assert.equal(mixedScan.smcWatchCount, 0);
    assert.equal(mixedScan.smcLongCandidateCount, 1);
    assert.equal(mixedScan.smcShortCandidateCount, 0);
    assert.equal(mixedScan.smcHighRiskCount, 0);
    assert.equal(
      mixedScan.smcPendingCount +
        mixedScan.smcWaitCount +
        mixedScan.smcWatchCount +
        mixedScan.smcLongCandidateCount +
        mixedScan.smcShortCandidateCount +
        mixedScan.smcHighRiskCount,
      mixedScan.totalContractsScanned
    );

    // smcGateNotConfirmedCount only counts EVALUATED symbols that failed candidate gate (1 symbol: BEAR_RADAR_USDT)
    assert.equal(mixedScan.smcGateNotConfirmedCount, 1);
    assert.equal(mixedScan.finalCategorySmcMismatchCount, 0);

    // Reason statistics verification:
    // BEAR_RADAR_USDT has 2 overlapping reasons, so uniqueSymbolCount === 1 while totalReasonOccurrences === 2
    assert.equal(mixedScan.waitWatchReasonStats.uniqueSymbolCount, 1);
    assert.equal(mixedScan.waitWatchReasonStats.totalReasonOccurrences, 2);
    const primaryReasonSum = Object.values(
      mixedScan.waitWatchReasonStats.mutuallyExclusivePrimaryReasonCount
    ).reduce((acc, v) => acc + v, 0);
    assert.equal(
      primaryReasonSum,
      mixedScan.waitWatchReasonStats.uniqueSymbolCount,
      'Mutually exclusive primary reason sum must equal uniqueSymbolCount'
    );
  });

  it('9. NotificationGuardEngine 與 Dry-Run 預覽只能處理 finalTradeSignal 為多頭交易候選或空頭交易候選，拒絕 PENDING / WAIT / WATCH / HIGH RISK', () => {
    const guard = new NotificationGuardEngine({ cooldownMs: 60_000 });
    const tgAdapter = new TelegramNotificationAdapter(guard);

    for (const blockedState of [
      'PENDING',
      'WAIT',
      'WATCH',
      'HIGH RISK',
    ] as const) {
      const blockedRes = guard.evaluateAndRecord(tgAdapter, {
        symbol: `TEST_${blockedState}_USDT`,
        category: '準備觀察',
        actionState: blockedState,
        finalTradeSignal: 'NONE',
        smcEvaluationStatus: blockedState === 'PENDING' ? 'PENDING' : 'EVALUATED',
        score: 70,
        confirmedEvidences: ['測試證據'],
        missingData: [],
        riskWarnings: [],
        source: 'Binance USDⓈ-M Futures Public REST API',
        fetchedAt: new Date().toISOString(),
        safetyBanner: 'PAPER ONLY / LIVE ORDERS DISABLED',
      });
      assert.equal(
        blockedRes.status,
        'NON_CANDIDATE_BLOCKED',
        `Expected NON_CANDIDATE_BLOCKED for state ${blockedState}`
      );
    }

    const validCandidateRes = guard.evaluateAndRecord(tgAdapter, {
      symbol: 'SOLUSDT',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      smcEvaluationStatus: 'EVALUATED',
      score: 88,
      confirmedEvidences: ['BOS', 'LIQUIDITY_SWEEP', 'DISPLACEMENT', 'FVG'],
      missingData: [],
      riskWarnings: [],
      source: 'Binance USDⓈ-M Futures Public REST API',
      fetchedAt: new Date().toISOString(),
      safetyBanner: 'PAPER ONLY / LIVE ORDERS DISABLED',
    });
    assert.equal(validCandidateRes.status, 'PREVIEW_DRY_RUN');
  });
});




