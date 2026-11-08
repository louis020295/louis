import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DemoExchangeAdapter,
  generateDeterministicHistoricalOiAndFunding,
  generateDeterministicSmcKlines,
} from '../server/adapters/ExchangeAdapter.ts';
import {
  NotificationGuardEngine,
  TelegramNotificationAdapter,
} from '../server/adapters/NotificationAdapter.ts';
import { BacktestDatabase } from '../server/db/BacktestDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { BacktestEngine } from '../server/engine/BacktestEngine.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { BacktestService } from '../server/services/BacktestService.ts';
import {
  DataProvenance,
  Kline,
  MarketTicker,
  NotificationPayload,
  Timeframe,
} from '../src/types/market.ts';

function createTempDbPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sqlite`
  );
}

function buildTestKlines(
  count: number,
  timeframe: Timeframe = '15m',
  basePrice = 65000
): Kline[] {
  const intervalMs =
    timeframe === '4h'
      ? 4 * 3600_000
      : timeframe === '1h'
        ? 3600_000
        : 15 * 60_000;
  return generateDeterministicSmcKlines({
    basePrice,
    count,
    intervalMs,
    endOpenTime: 1711929600000,
    mode: 'BULL',
  });
}

function buildTestOiAndFunding(
  symbol: string,
  klines: Kline[],
  baseOi = 85000,
  baseFundingRate = 0.0001
) {
  return generateDeterministicHistoricalOiAndFunding({
    symbol,
    klines,
    baseOi,
    baseFundingRate,
  });
}

const verifiedLiveProvenance: DataProvenance = {
  source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: false,
  isTestFixture: false,
  volumeTimeframe: '15m',
  aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
  volumeMetric: 'quoteVolume',
};

const demoProvenance: DataProvenance = {
  source: 'DEMO_SYNTHETIC_DATASET (DEMO)',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: true,
  isTestFixture: false,
  volumeTimeframe: '15m',
  aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
  volumeMetric: 'quoteVolume',
};

describe('Phase 4 Backtest, Walk-Forward Verification, Point-in-Time OI/Funding & Notification Readiness', () => {
  it('1. 同一 SQLite 資料庫內 statsVersion 嚴格單調遞增，且具備唯一 databaseInstanceId 與 scanRunId', () => {
    const dbPath = createTempDbPath('phase4_stats_monotonic');
    const db = new RadarDatabase(dbPath);
    try {
      assert.match(db.databaseInstanceId, /^db_/);
      const scanRunId = db.getSmcScanRunId('binance_usdm');
      assert.match(scanRunId, /^scan_binance_usdm_/);

      const v0 = db.getSmcStatsVersion('binance_usdm');
      const nowIso = new Date().toISOString();

      db.enqueueSmcScanJobs([
        {
          symbol: 'BTCUSDT',
          exchange: 'binance_usdm',
          priority: 100,
          priorityTier: 1,
          priorityLabel: 'TIER_1',
          status: 'QUEUED',
          ruleVersion: 'smc_v1',
          windowKey: 'win_001',
          requestedAt: nowIso,
          startedAt: null,
          completedAt: null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ]);

      const v1 = db.getSmcStatsVersion('binance_usdm');
      assert.ok(v1 > v0, `Expected v1 (${v1}) > v0 (${v0})`);

      const claimed = db.claimNextSmcScanJobs('binance_usdm', 1, nowIso, {
        maxConcurrency: 2,
        workerId: 'worker_test_1',
      });
      assert.equal(claimed.length, 1);

      const v2 = db.getSmcStatsVersion('binance_usdm');
      assert.ok(v2 > v1, `Expected v2 (${v2}) > v1 (${v1})`);

      const snap = db.getAtomicSmcSnapshot('binance_usdm');
      assert.equal(snap.databaseInstanceId, db.databaseInstanceId);
      assert.ok(snap.scanRunId.length > 0);
      assert.ok(snap.statsVersion >= v2);
    } finally {
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('2. waitWatchReasonStats、highRiskReasonStats 與 nonCandidateReasonStats 範圍正確分離', () => {
    const tickers: MarketTicker[] = [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: 65000,
        priceChangePercent24h: 2.1,
        quoteVolume24h: 800_000_000,
        bidPrice: 64999,
        askPrice: 65001,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600_000,
        openInterest: 50000,
        openInterestValue: 3_250_000_000,
        provenance: verifiedLiveProvenance,
      },
      {
        symbol: 'WAITCOINUSDT',
        baseAsset: 'WAITCOIN',
        quoteAsset: 'USDT',
        lastPrice: 10,
        priceChangePercent24h: 1.5,
        quoteVolume24h: 45_000_000,
        bidPrice: 9.999,
        askPrice: 10.001,
        fundingRate: 0.0001,
        nextFundingTime: Date.now() + 3600_000,
        openInterest: 100000,
        openInterestValue: 1_000_000,
        provenance: verifiedLiveProvenance,
      },
      {
        symbol: 'RISKCOINUSDT',
        baseAsset: 'RISKCOIN',
        quoteAsset: 'USDT',
        lastPrice: 5,
        priceChangePercent24h: 14.5,
        quoteVolume24h: 35_000_000,
        bidPrice: 4.99,
        askPrice: 5.01,
        fundingRate: 0.0025,
        nextFundingTime: Date.now() + 3600_000,
        openInterest: 100000,
        openInterestValue: 500_000,
        provenance: verifiedLiveProvenance,
      },
    ];

    const nowIso = new Date().toISOString();
    const smcMap = new Map([
      [
        'WAITCOINUSDT',
        {
          smcEvaluationStatus: 'EVALUATED' as const,
          actionState: 'WAIT' as const,
          waitReasons: ['15m 尚未出現明確 BOS/MSS 結構突破'],
          evaluatedAt: nowIso,
        },
      ],
      [
        'RISKCOINUSDT',
        {
          smcEvaluationStatus: 'EVALUATED' as const,
          actionState: 'HIGH RISK' as const,
          waitReasons: ['資金費率極端偏高 (0.25%)，觸發 HIGH RISK 風控攔截'],
          evaluatedAt: nowIso,
        },
      ],
    ]);

    const scanRes = runMarketScan(tickers, verifiedLiveProvenance, {
      exchange: 'binance_usdm',
      mode: 'live',
      smcMap,
    });

    assert.equal(
      scanRes.waitWatchReasonStats.scope,
      'EVALUATED_WAIT_WATCH_ONLY'
    );
    assert.equal(scanRes.waitWatchReasonStats.uniqueSymbolCount, 1);

    assert.equal(
      scanRes.highRiskReasonStats.scope,
      'EVALUATED_HIGH_RISK_ONLY'
    );
    assert.equal(scanRes.highRiskReasonStats.uniqueSymbolCount, 1);

    assert.equal(
      scanRes.nonCandidateReasonStats.scope,
      'EVALUATED_NON_CANDIDATE_ALL'
    );
    assert.equal(scanRes.nonCandidateReasonStats.uniqueSymbolCount, 2);
  });

  it('3 & 4. 回測完全無 lookahead bias，且每個時點 baseline 只使用前 30 根已收盤 K 線（不包含 currentBar）', () => {
    const engine = new BacktestEngine();
    const baseKlines = buildTestKlines(90, '15m', 65000);
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('BTCUSDT', baseKlines, 85000, 0.0001);

    // Mutate bars at index >= 60 drastically
    const mutatedFutureKlines: Kline[] = baseKlines.map((k, idx) =>
      idx >= 60
        ? {
            ...k,
            close: k.close * 4,
            high: k.high * 4.2,
            volume: k.volume * 80,
            quoteVolume: k.quoteVolume * 250,
          }
        : { ...k }
    );

    const runA = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: baseKlines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    const runB = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: mutatedFutureKlines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    assert.equal(runA.lookaheadFree, true);
    assert.equal(runB.lookaheadFree, true);
    assert.equal(runA.dataClassification, 'REAL');

    const decA = (runA.pointInTimeDecisions ?? []).filter(
      (d) => d.barIndex < 60
    );
    const decB = (runB.pointInTimeDecisions ?? []).filter(
      (d) => d.barIndex < 60
    );
    assert.ok(decA.length > 0);
    assert.equal(decA.length, decB.length);

    for (let i = 0; i < decA.length; i++) {
      assert.equal(decA[i].volumeBaselineBars, 30);
      assert.equal(decA[i].confirmedBarsCount, decA[i].barIndex + 1);
      assert.equal(decA[i].smcActionState, decB[i].smcActionState);
      assert.equal(decA[i].finalTradeSignal, decB[i].finalTradeSignal);
    }

    for (const snap of runA.pointInTimeVolumeSnapshots ?? []) {
      assert.equal(snap.sampleCount, 30);
      assert.equal(snap.historicalSamples.length, 30);
      assert.ok(
        !snap.baselineWindowOpenTimes.includes(snap.barOpenTime),
        'Baseline window must NEVER include currentBar openTime'
      );
    }
  });

  it('5. 未收盤 K 線（isClosed === false）不會進入回測計算', () => {
    const engine = new BacktestEngine();
    const closedOnly = buildTestKlines(80, '1h', 3200).filter(
      (k) => k.isClosed
    );
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('ETHUSDT', closedOnly, 60000, 0.0001);

    const withUnclosed: Kline[] = [
      ...closedOnly,
      {
        openTime: closedOnly[closedOnly.length - 1].openTime + 3600_000,
        closeTime: closedOnly[closedOnly.length - 1].closeTime + 3600_000,
        open: 3200,
        high: 9999,
        low: 1000,
        close: 8888,
        volume: 999999,
        quoteVolume: 999_999_999,
        isClosed: false,
      },
    ];

    const resA = engine.runDeterministicBacktest({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '1h',
      klines: closedOnly,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    const resB = engine.runDeterministicBacktest({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '1h',
      klines: withUnclosed,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    assert.equal(resA.confirmedBarsTested, resB.confirmedBarsTested);
    assert.equal(resA.endTime, resB.endTime);
  });

  it('6. Walk-forward 三視窗時間順序正確且無重疊，支援 15m/1h/4h，且拒絕打散時間序列', () => {
    const engine = new BacktestEngine();
    for (const tf of ['15m', '1h', '4h'] as const) {
      const klines = buildTestKlines(120, tf, 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 95000, 0.0001);
      const { walkForward } = engine.runWalkForwardBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: tf,
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      assert.equal(walkForward.chronologicalOrderVerified, true);
      assert.equal(walkForward.noShufflingVerified, true);
      assert.equal(walkForward.parameterFeedbackBlocked, true);

      const { trainingWindow, validationWindow, forwardTestWindow } =
        walkForward;
      assert.ok(trainingWindow.endBarIndex < validationWindow.startBarIndex);
      assert.ok(validationWindow.endBarIndex < forwardTestWindow.startBarIndex);
      assert.ok(
        Date.parse(trainingWindow.endTime) <
          Date.parse(validationWindow.startTime)
      );
      assert.ok(
        Date.parse(validationWindow.endTime) <
          Date.parse(forwardTestWindow.startTime)
      );
    }

    // Shuffled time series must be rejected
    const klines = buildTestKlines(90, '15m', 65000);
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('BTCUSDT', klines, 95000, 0.0001);
    const shuffled = [...klines];
    const temp = shuffled[25];
    shuffled[25] = shuffled[26];
    shuffled[26] = temp;

    assert.throws(() => {
      engine.runWalkForwardBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines: shuffled,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });
    }, /時間序列違規/);
  });

  it('7 & 8. PENDING / WAIT / WATCH / HIGH RISK 與 stale=true / fallback=true 一律不得產生回測交易訊號', () => {
    const engine = new BacktestEngine();
    const klines = buildTestKlines(100, '15m', 65000);
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('BTCUSDT', klines, 90000, 0.0001);

    const staleRes = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: { ...verifiedLiveProvenance, stale: true },
    });
    assert.equal(staleRes.signalCount, 0);
    assert.equal(staleRes.executedPaperCount, 0);
    assert.ok(staleRes.blockedCount > 0);

    const fallbackRes = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: { ...verifiedLiveProvenance, fallback: true },
    });
    assert.equal(fallbackRes.signalCount, 0);
    assert.equal(fallbackRes.executedPaperCount, 0);

    const normalRes = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });
    for (const d of normalRes.pointInTimeDecisions ?? []) {
      if (
        d.smcEvaluationStatus !== 'EVALUATED' ||
        d.smcActionState === 'PENDING' ||
        d.smcActionState === 'WAIT' ||
        d.smcActionState === 'WATCH' ||
        d.smcActionState === 'HIGH RISK'
      ) {
        assert.equal(d.countedAsTradeSignal, false);
      }
    }
  });

  it('9. INSUFFICIENT_DATA 不得偽造勝率或自行補零（winRate / averageR / profitFactor / maxDrawdownR / expectancyR 必須為 null，且 metricStatus = INSUFFICIENT_DATA）', () => {
    const engine = new BacktestEngine();
    const shortKlines = buildTestKlines(25, '15m', 65000);
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('BTCUSDT', shortKlines, 80000, 0.0001);

    const res = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: shortKlines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    assert.equal(res.status, 'INSUFFICIENT_DATA');
    assert.equal(res.metricStatus, 'INSUFFICIENT_DATA');
    assert.equal(res.lookaheadFree, false);
    assert.equal(res.dataClassification, 'INSUFFICIENT_DATA');
    assert.equal(res.dataClassificationLabel, '資料不足');
    assert.equal(res.tradeCount, null);
    assert.equal(res.winRate, null);
    assert.equal(res.averageR, null);
    assert.equal(res.profitFactor, null);
    assert.equal(res.maxDrawdownR, null);
    assert.equal(res.expectancyR, null);
    assert.equal(res.averageHoldingTime, null);
  });

  it('9b. 當 executedPaperCount = 0 時，winRate / averageR / profitFactor / maxDrawdownR / expectancyR / averageHoldingTime 必須全部為 null 且 metricStatus = NO_TRADES（不得輸出 0）', () => {
    const engine = new BacktestEngine();
    const rangeKlines = generateDeterministicSmcKlines({
      basePrice: 65000,
      count: 85,
      intervalMs: 15 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'RANGE',
    });
    const { historicalOpenInterest, historicalFundingRates } =
      buildTestOiAndFunding('BTCUSDT', rangeKlines, 80000, 0.0001);

    const res = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: rangeKlines,
      historicalOpenInterest,
      historicalFundingRates,
      provenance: verifiedLiveProvenance,
    });

    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.executedPaperCount, 0);
    assert.equal(res.metricStatus, 'NO_TRADES');
    assert.equal(res.winRate, null);
    assert.equal(res.winRatePercent, null);
    assert.equal(res.averageR, null);
    assert.equal(res.profitFactor, null);
    assert.equal(res.maxDrawdownR, null);
    assert.equal(res.expectancyR, null);
    assert.equal(res.averageHoldingTime, null);
  });

  it('10 & 11. 紙上交易只接受雙向同向候選訊號，且回測只寫入 paper ledger 與 backtest_runs（維持 PAPER ONLY）', async () => {
    const dbPath = createTempDbPath('phase4_paper_ledger');
    const radarDb = new RadarDatabase(dbPath);
    try {
      const btDb = new BacktestDatabase(radarDb);
      const demoAdapter = new DemoExchangeAdapter();
      const btService = new BacktestService({
        adapters: {
          binance_usdm: demoAdapter,
          bybit_linear: demoAdapter,
          bingx_swap: demoAdapter,
          demo_synthetic: demoAdapter,
        },
        backtestDb: btDb,
      });

      const klines = buildTestKlines(120, '15m', 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 95000, 0.0001);

      const { report, paperEntriesCreated } = await btService.executeBacktest({
        symbol: 'BTCUSDT',
        timeframe: '15m',
        mode: 'demo',
        exchange: 'demo_synthetic',
        includeWalkForward: true,
        writeToPaperLedger: true,
        customKlines: klines,
        customHistoricalOpenInterest: historicalOpenInterest,
        customHistoricalFundingRates: historicalFundingRates,
        customProvenance: demoProvenance,
      });

      assert.equal(report.safety.mode, 'PAPER ONLY');
      assert.equal(report.safety.liveOrders, 'LIVE ORDERS DISABLED');
      assert.equal(
        report.safety.executionPolicy,
        'NEVER AUTO-PLACE ORDERS'
      );
      assert.equal(report.dataClassification, 'DEMO');
      assert.equal(report.dataClassificationLabel, 'Demo 資料');
      assert.equal(report.lookaheadFree, true);

      for (const trade of report.trades) {
        if (trade.direction === 'LONG') {
          assert.equal(trade.actionStateAtSignal, 'LONG CANDIDATE');
          assert.equal(trade.finalTradeSignalAtSignal, '多頭交易候選');
        } else {
          assert.equal(trade.actionStateAtSignal, 'SHORT CANDIDATE');
          assert.equal(trade.finalTradeSignalAtSignal, '空頭交易候選');
        }
      }

      const persistedRun = btDb.getBacktestRunById(report.backtestRunId);
      assert.ok(persistedRun !== null);
      assert.equal(persistedRun?.backtestRunId, report.backtestRunId);
      assert.equal(paperEntriesCreated.length, report.trades.length);
    } finally {
      radarDb.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });

  it('12, 13 & 14. 通知 dedupe / cooldown 正常運作，且 Demo / Stale / Non-candidate / Backtest 訊號不會觸發即時通知', async () => {
    const guard = new NotificationGuardEngine({
      cooldownMs: 300_000,
      dedupeWindowMs: 1_800_000,
      maxPerMinute: 6,
    });
    const tgAdapter = new TelegramNotificationAdapter(guard);
    const nowIso = new Date().toISOString();

    const validCandidatePayload: NotificationPayload = {
      symbol: 'BTCUSDT',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      smcEvaluationStatus: 'EVALUATED',
      stale: false,
      fallback: false,
      waitReasons: [],
      score: 84,
      confirmedEvidences: ['BOS_BULL', 'BULLISH_FVG', 'RVOL 2.3x'],
      missingData: [],
      riskWarnings: [],
      source: verifiedLiveProvenance.source,
      fetchedAt: nowIso,
      safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
      scanRunId: 'scan_binance_usdm_test01',
      signalId: 'sig_BTCUSDT_LONG_01',
      ruleVersion: '2.2.0-smc-BatchQueue',
      snapshotAt: nowIso,
      evaluatedAt: nowIso,
      isBacktest: false,
    };

    // 1. First valid live candidate -> PREVIEW_DRY_RUN
    const rec1 = await tgAdapter.dispatchPreview(validCandidatePayload);
    assert.equal(rec1.status, 'PREVIEW_DRY_RUN');
    assert.equal(rec1.scanRunId, 'scan_binance_usdm_test01');
    assert.equal(rec1.signalId, 'sig_BTCUSDT_LONG_01');
    assert.equal(rec1.ruleVersion, '2.2.0-smc-BatchQueue');
    assert.ok(rec1.dedupeKey.length > 0);
    assert.ok(rec1.cooldownUntil !== null);

    // 2. Identical payload within dedupe window -> DEDUPED_BLOCKED
    const recDedupe = await tgAdapter.dispatchPreview(validCandidatePayload);
    assert.equal(recDedupe.status, 'DEDUPED_BLOCKED');

    // 3. Different evidence on same symbol within 5m cooldown -> COOLDOWN_BLOCKED
    const recCooldown = await tgAdapter.dispatchPreview({
      ...validCandidatePayload,
      signalId: 'sig_BTCUSDT_LONG_02',
      confirmedEvidences: ['MSS_BULL', 'BULLISH_OB'],
    });
    assert.equal(recCooldown.status, 'COOLDOWN_BLOCKED');

    // 4. Stale data -> NON_CANDIDATE_BLOCKED
    const recStale = await tgAdapter.dispatchPreview({
      ...validCandidatePayload,
      symbol: 'ETHUSDT',
      stale: true,
    });
    assert.equal(recStale.status, 'NON_CANDIDATE_BLOCKED');

    // 5. Fallback / Demo degraded -> NON_CANDIDATE_BLOCKED
    const recFallback = await tgAdapter.dispatchPreview({
      ...validCandidatePayload,
      symbol: 'SOLUSDT',
      fallback: true,
    });
    assert.equal(recFallback.status, 'NON_CANDIDATE_BLOCKED');

    // 6. Non-candidate (WAIT / WATCH / HIGH RISK) -> NON_CANDIDATE_BLOCKED
    const recWait = await tgAdapter.dispatchPreview({
      ...validCandidatePayload,
      symbol: 'BNBUSDT',
      actionState: 'WAIT',
      finalTradeSignal: 'NONE',
    });
    assert.equal(recWait.status, 'NON_CANDIDATE_BLOCKED');

    // 7. Backtest signal (isBacktest = true) -> NON_CANDIDATE_BLOCKED
    const recBacktest = await tgAdapter.dispatchPreview({
      ...validCandidatePayload,
      symbol: 'XRPUSDT',
      isBacktest: true,
    });
    assert.equal(recBacktest.status, 'NON_CANDIDATE_BLOCKED');
    assert.match(recBacktest.reason, /回測模式訊號/);
  });

  describe('Phase 4 OI／Funding 時間點對齊與前視偏差專項測試 (6 項必備驗證)', () => {
    it('前視偏差測試 1：將未來 OI 數值放大或修改（含歸零），不得影響更早時間點的回測結果', () => {
      const engine = new BacktestEngine();
      const klines = buildTestKlines(90, '15m', 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 85000, 0.0001);

      const cutoffTimestamp = klines[55].closeTime;
      const mutatedFutureOi = historicalOpenInterest.map((pt) =>
        pt.timestamp > cutoffTimestamp
          ? {
              ...pt,
              openInterest: 0, // Future OI drops to 0 or spikes 100x
              openInterestValue: 0,
            }
          : { ...pt }
      );
      const spikedFutureOi = historicalOpenInterest.map((pt) =>
        pt.timestamp > cutoffTimestamp
          ? {
              ...pt,
              openInterest: pt.openInterest * 100,
              openInterestValue: (pt.openInterestValue ?? 0) * 100,
            }
          : { ...pt }
      );

      const baseRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      const zeroFutureOiRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest: mutatedFutureOi,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      const spikedFutureOiRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest: spikedFutureOi,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      const earlyBase = (baseRun.pointInTimeDecisions ?? []).filter(
        (d) => d.barCloseTime <= cutoffTimestamp
      );
      const earlyZero = (zeroFutureOiRun.pointInTimeDecisions ?? []).filter(
        (d) => d.barCloseTime <= cutoffTimestamp
      );
      const earlySpiked = (spikedFutureOiRun.pointInTimeDecisions ?? []).filter(
        (d) => d.barCloseTime <= cutoffTimestamp
      );

      assert.ok(earlyBase.length > 0);
      assert.equal(earlyBase.length, earlyZero.length);
      assert.equal(earlyBase.length, earlySpiked.length);

      for (let i = 0; i < earlyBase.length; i++) {
        assert.equal(earlyBase[i].oiValue, earlyZero[i].oiValue);
        assert.equal(earlyBase[i].oiValue, earlySpiked[i].oiValue);
        assert.equal(
          earlyBase[i].oiDataTimestamp,
          earlyZero[i].oiDataTimestamp
        );
        assert.equal(
          earlyBase[i].smcActionState,
          earlyZero[i].smcActionState
        );
        assert.equal(
          earlyBase[i].finalTradeSignal,
          earlyZero[i].finalTradeSignal
        );
        assert.equal(
          earlyBase[i].finalTradeSignal,
          earlySpiked[i].finalTradeSignal
        );
      }
    });

    it('前視偏差測試 2：將未來 Funding 數值放大或修改，不得影響更早時間點的回測結果', () => {
      const engine = new BacktestEngine();
      const klines = buildTestKlines(90, '15m', 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 85000, 0.0001);

      const cutoffTimestamp = klines[55].closeTime;
      const mutatedFutureFunding = historicalFundingRates.map((pt) =>
        pt.timestamp > cutoffTimestamp
          ? {
              ...pt,
              fundingRate: 0.05, // Future extreme funding rate (5%)
            }
          : { ...pt }
      );

      const baseRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      const mutatedRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates: mutatedFutureFunding,
        provenance: verifiedLiveProvenance,
      });

      const earlyBase = (baseRun.pointInTimeDecisions ?? []).filter(
        (d) => d.barCloseTime <= cutoffTimestamp
      );
      const earlyMutated = (mutatedRun.pointInTimeDecisions ?? []).filter(
        (d) => d.barCloseTime <= cutoffTimestamp
      );

      assert.ok(earlyBase.length > 0);
      assert.equal(earlyBase.length, earlyMutated.length);

      for (let i = 0; i < earlyBase.length; i++) {
        assert.equal(earlyBase[i].fundingRate, earlyMutated[i].fundingRate);
        assert.equal(
          earlyBase[i].fundingDataTimestamp,
          earlyMutated[i].fundingDataTimestamp
        );
        assert.equal(
          earlyBase[i].smcActionState,
          earlyMutated[i].smcActionState
        );
        assert.equal(
          earlyBase[i].finalTradeSignal,
          earlyMutated[i].finalTradeSignal
        );
      }
    });

    it('前視偏差測試 3 & 4：移除歷史 OI／Funding 時，不得偷偷使用當下值補回，且不得產生任何 LONG 或 SHORT 回測交易訊號', () => {
      const engine = new BacktestEngine();
      const klines = buildTestKlines(90, '15m', 65000);

      // Even if someone passes scalar openInterest / fundingRate (current values),
      // when historicalOpenInterest / historicalFundingRates are empty/missing,
      // the engine MUST NOT backfill with current values and MUST NOT emit LONG/SHORT signals!
      const missingOiFundingRun = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest: [],
        historicalFundingRates: [],
        openInterest: 999_999,
        fundingRate: 0.0001,
        provenance: verifiedLiveProvenance,
      });

      assert.equal(missingOiFundingRun.status, 'INSUFFICIENT_DATA');
      assert.equal(missingOiFundingRun.metricStatus, 'INSUFFICIENT_DATA');
      assert.equal(
        missingOiFundingRun.dataClassification,
        'INSUFFICIENT_DATA'
      );
      assert.equal(missingOiFundingRun.lookaheadFree, false);
      assert.equal(missingOiFundingRun.signalCount, 0);
      assert.equal(missingOiFundingRun.executedPaperCount, 0);
      assert.equal(missingOiFundingRun.trades.length, 0);
      assert.ok(missingOiFundingRun.insufficientDataCount > 0);

      for (const dec of missingOiFundingRun.pointInTimeDecisions ?? []) {
        assert.equal(dec.oiFundingPointInTime, false);
        assert.equal(dec.oiValue, null);
        assert.equal(dec.fundingRate, null);
        assert.equal(dec.smcEvaluationStatus, 'PENDING');
        assert.equal(dec.finalTradeSignal, 'NONE');
        assert.equal(dec.countedAsTradeSignal, false);
      }
    });

    it('前視偏差測試 5：所有歷史訊號都必須能追溯到對應的 oiDataTimestamp 與 fundingDataTimestamp，且 timestamp <= barCloseTime', () => {
      const engine = new BacktestEngine();
      const klines = buildTestKlines(110, '15m', 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 90000, 0.0001);

      const res = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });

      assert.equal(res.lookaheadFree, true);
      assert.equal(res.dataClassification, 'REAL');

      for (const dec of res.pointInTimeDecisions ?? []) {
        assert.equal(dec.oiFundingPointInTime, true);
        assert.ok(dec.oiValue !== null && dec.oiValue > 0);
        assert.ok(dec.oiDataTimestamp !== null);
        assert.ok(
          dec.oiDataTimestamp! <= dec.barCloseTime,
          `oiDataTimestamp (${dec.oiDataTimestamp}) must be <= barCloseTime (${dec.barCloseTime})`
        );
        assert.ok(dec.fundingRate !== null);
        assert.ok(dec.fundingDataTimestamp !== null);
        assert.ok(
          dec.fundingDataTimestamp! <= dec.barCloseTime,
          `fundingDataTimestamp (${dec.fundingDataTimestamp}) must be <= barCloseTime (${dec.barCloseTime})`
        );
      }

      for (const tr of res.trades) {
        assert.ok(tr.pointInTimeEvidence);
        assert.equal(tr.pointInTimeEvidence.oiFundingPointInTime, true);
        assert.ok(
          tr.pointInTimeEvidence.oiDataTimestamp! <=
            tr.pointInTimeEvidence.barCloseTime
        );
        assert.ok(
          tr.pointInTimeEvidence.fundingDataTimestamp! <=
            tr.pointInTimeEvidence.barCloseTime
        );
      }
    });

    it('前視偏差測試 6：回測結果必須清楚區分 REAL、DEMO、PROXY、PENDING、INSUFFICIENT_DATA', () => {
      const engine = new BacktestEngine();
      const klines = buildTestKlines(90, '15m', 65000);
      const { historicalOpenInterest, historicalFundingRates } =
        buildTestOiAndFunding('BTCUSDT', klines, 85000, 0.0001);

      // 1. REAL
      const realRes = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: verifiedLiveProvenance,
      });
      assert.equal(realRes.dataClassification, 'REAL');
      assert.equal(realRes.dataClassificationLabel, '實際資料');
      assert.equal(realRes.lookaheadFree, true);

      // 2. DEMO
      const demoRes = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'demo_synthetic',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: demoProvenance,
      });
      assert.equal(demoRes.dataClassification, 'DEMO');
      assert.equal(demoRes.dataClassificationLabel, 'Demo 資料');
      assert.equal(demoRes.lookaheadFree, true);

      // 3. PROXY
      const proxyRes = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: {
          ...verifiedLiveProvenance,
          source: 'PROXY_HISTORICAL_FEED',
        },
      });
      assert.equal(proxyRes.dataClassification, 'PROXY');
      assert.equal(proxyRes.dataClassificationLabel, '代理資料');
      assert.equal(proxyRes.lookaheadFree, false);

      // 4. INSUFFICIENT_DATA (missing historical OI/Funding -> each bar is PENDING & report is INSUFFICIENT_DATA)
      const insuffRes = engine.runDeterministicBacktest({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        klines,
        historicalOpenInterest: [],
        historicalFundingRates: [],
        provenance: verifiedLiveProvenance,
      });
      assert.equal(insuffRes.dataClassification, 'INSUFFICIENT_DATA');
      assert.equal(insuffRes.dataClassificationLabel, '資料不足');
      assert.equal(insuffRes.lookaheadFree, false);
      assert.ok(insuffRes.pendingCount > 0);
    });
  });
});

