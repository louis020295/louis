import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server.ts';
import {
  generateDeterministicHistoricalOiAndFunding,
  generateDeterministicSmcKlines,
} from '../server/adapters/ExchangeAdapter.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { BacktestEngine } from '../server/engine/BacktestEngine.ts';
import { evaluateSmcStructure } from '../server/engine/SmcRuleEngine.ts';
import { calculateTradeTradingCosts } from '../server/engine/TradingCostModel.ts';
import { BacktestService } from '../server/services/BacktestService.ts';
import { ExternalNotificationService } from '../server/services/ExternalNotificationService.ts';
import { PaperShadowMonitor } from '../server/services/PaperShadowMonitor.ts';
import { PositionSentinelService } from '../server/services/PositionSentinelService.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { SystemWatchdogService } from '../server/services/SystemWatchdogService.ts';
import {
  BacktestPointInTimeSignalEvidence,
  DataProvenance,
  Kline,
  PortfolioBacktestResult,
  SmcAbComparisonResponse,
  SystemWatchdogStatusResponse,
  ValidationReadinessResponse,
} from '../src/types/market.ts';

function buildProvenance(isDemo = false): DataProvenance {
  return {
    source: isDemo
      ? 'DEMO_SYNTHETIC_DATASET (DEMO)'
      : 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
    fetchedAt: new Date().toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo,
    isTestFixture: false,
    volumeTimeframe: '15m',
    aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
    volumeMetric: 'quoteVolume',
  };
}

describe('Phase 25: Net Cost Model, Lookahead-Free MTF, Deferred Entry/Auto Limit, Portfolio Risk & Watchdog', () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase25-'));
    dbPath = path.join(tmpDir, 'radar.sqlite');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it('1. TradingCostModel 與 BacktestEngine 正確扣除手續費、滑價與資金費率，且資料不足或無交易時維持 null', () => {
    // Market entry + Stop exit pays 2x taker + 2x slippage + positive funding for LONG
    const longMarketLoss = calculateTradeTradingCosts({
      direction: 'LONG',
      entryPrice: 100,
      invalidationPrice: 98, // 2% stop distance
      exitPrice: 98,
      entryTimeMs: 0,
      exitTimeMs: 8 * 3_600_000, // 8h = 1 full funding period
      entryOrderType: 'MARKET',
      exitIsLimitFill: false,
      fundingRatePer8h: 0.0005, // 5 bps
      costConfig: {
        makerFeeBps: 2,
        takerFeeBps: 5,
        slippageBps: 3,
      },
    });
    assert.equal(longMarketLoss.grossRMultiple, -1);
    assert.equal(longMarketLoss.feeCostR, 0.05);
    assert.equal(longMarketLoss.slippageCostR, 0.03);
    assert.equal(longMarketLoss.fundingCostR, 0.025);
    assert.equal(longMarketLoss.totalCostR, 0.105);
    assert.equal(longMarketLoss.netRMultiple, -1.1);

    // Limit entry + TP Limit exit pays maker + 0 slippage, and SHORT receives positive funding (16h = 2 funding periods)
    const shortLimitWin = calculateTradeTradingCosts({
      direction: 'SHORT',
      entryPrice: 100,
      invalidationPrice: 102,
      exitPrice: 96, // +2R
      entryTimeMs: 0,
      exitTimeMs: 16 * 3_600_000,
      entryOrderType: 'LIMIT',
      exitIsLimitFill: true,
      fundingRatePer8h: 0.0005,
      costConfig: {
        makerFeeBps: 2,
        takerFeeBps: 5,
        slippageBps: 3,
      },
    });
    assert.equal(shortLimitWin.grossRMultiple, 2);
    assert.equal(shortLimitWin.feeCostR, 0.02);
    assert.equal(shortLimitWin.slippageCostR, 0);
    assert.equal(shortLimitWin.fundingCostR, -0.05);
    assert.equal(shortLimitWin.totalCostR, -0.03);
    assert.equal(shortLimitWin.netRMultiple, 2.03);

    // Full BacktestEngine run with deterministic SMC klines
    const klines = generateDeterministicSmcKlines({
      basePrice: 65000,
      count: 140,
      intervalMs: 15 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'BULL',
    });
    const { oiSeries, fundingSeries } =
      generateDeterministicHistoricalOiAndFunding({
        symbol: 'BTCUSDT',
        klines,
        baseOi: 85000,
        baseFundingRate: 0.0002,
      });

    const engine = new BacktestEngine();
    const res = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines,
      historicalOpenInterest: oiSeries,
      historicalFundingRates: fundingSeries,
      provenance: buildProvenance(false),
      costConfig: {
        makerFeeBps: 2,
        takerFeeBps: 5,
        slippageBps: 3,
        entryOrderType: 'MARKET',
      },
    });

    assert.equal(res.status, 'COMPLETED');
    assert.ok((res.tradeCount ?? 0) > 0, 'Expected deterministic trades > 0');
    assert.ok(typeof res.netExpectancyR === 'number');
    assert.ok(typeof res.totalCostDragR === 'number' && res.totalCostDragR > 0);
    assert.ok(
      res.netExpectancyR! < res.expectancyR!,
      `Expected netExpectancyR (${res.netExpectancyR}) < gross expectancyR (${res.expectancyR})`
    );
    for (const tr of res.trades) {
      assert.ok(typeof tr.netRMultiple === 'number');
      assert.ok(typeof tr.totalCostR === 'number');
    }

    // Insufficient data -> Net metrics MUST stay null (zero fabrication)
    const insufficient = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: klines.slice(0, 20),
      historicalOpenInterest: oiSeries,
      historicalFundingRates: fundingSeries,
      provenance: buildProvenance(false),
    });
    assert.equal(insufficient.status, 'INSUFFICIENT_DATA');
    assert.equal(insufficient.netWinRate, null);
    assert.equal(insufficient.netExpectancyR, null);
    assert.equal(insufficient.netProfitFactor, null);
    assert.equal(insufficient.netMaxDrawdownR, null);
  });

  it('2. Lookahead-Free MTF 歷史對齊嚴格只使用 signalBar.closeTime 以前已收盤的 1h/4h K 線', () => {
    const klines15m = generateDeterministicSmcKlines({
      basePrice: 65000,
      count: 140,
      intervalMs: 15 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'BULL',
    });
    const last15mClose = klines15m[klines15m.length - 1].closeTime;
    const mid15mClose = klines15m[90].closeTime;
    const k1hHistorical = generateDeterministicSmcKlines({
      basePrice: 64000,
      count: 60,
      intervalMs: 3600_000,
      endOpenTime: klines15m[klines15m.length - 1].openTime,
      mode: 'BULL',
    });
    const k4hHistorical = generateDeterministicSmcKlines({
      basePrice: 63000,
      count: 40,
      intervalMs: 4 * 3600_000,
      endOpenTime: klines15m[klines15m.length - 1].openTime,
      mode: 'BULL',
    });

    const { oiSeries, fundingSeries } =
      generateDeterministicHistoricalOiAndFunding({
        symbol: 'ETHUSDT',
        klines: klines15m,
        baseOi: 60000,
        baseFundingRate: 0.0001,
      });

    const engine = new BacktestEngine();
    const baseline = engine.runDeterministicBacktest({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: klines15m,
      higherTimeframeKlines: { '1h': k1hHistorical, '4h': k4hHistorical },
      historicalOpenInterest: oiSeries,
      historicalFundingRates: fundingSeries,
      provenance: buildProvenance(false),
    });

    // Inject hostile FUTURE 1h crashing bars strictly AFTER last15mClose
    const futureCrash1h: Kline[] = Array.from({ length: 10 }, (_, idx) => {
      const openTime = last15mClose + (idx + 1) * 3600_000;
      return {
        openTime,
        closeTime: openTime + 3600_000 - 1,
        open: 65000 - idx * 3000,
        high: 65100 - idx * 3000,
        low: 60000 - idx * 3000,
        close: 60500 - idx * 3000,
        volume: 999_999,
        quoteVolume: 5_000_000_000,
        isClosed: true,
      };
    });

    const withFutureInjected = engine.runDeterministicBacktest({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: klines15m,
      higherTimeframeKlines: {
        '1h': [...k1hHistorical, ...futureCrash1h],
        '4h': k4hHistorical,
      },
      historicalOpenInterest: oiSeries,
      historicalFundingRates: fundingSeries,
      provenance: buildProvenance(false),
    });

    assert.equal(baseline.mtfHistoricalAligned, true);
    assert.equal(withFutureInjected.mtfHistoricalAligned, true);

    const baselineDecisionsUpToMid = (baseline.pointInTimeDecisions ?? []).filter(
      (d: BacktestPointInTimeSignalEvidence) => d.barCloseTime <= mid15mClose
    );
    const futureDecisionsUpToMid = (
      withFutureInjected.pointInTimeDecisions ?? []
    ).filter(
      (d: BacktestPointInTimeSignalEvidence) => d.barCloseTime <= mid15mClose
    );

    assert.equal(baselineDecisionsUpToMid.length, futureDecisionsUpToMid.length);
    for (let idx = 0; idx < baselineDecisionsUpToMid.length; idx++) {
      assert.equal(
        futureDecisionsUpToMid[idx].smcActionState,
        baselineDecisionsUpToMid[idx].smcActionState
      );
      assert.equal(
        futureDecisionsUpToMid[idx].finalTradeSignal,
        baselineDecisionsUpToMid[idx].finalTradeSignal
      );
    }
  });

  it('3. SignalOutcomeTracker 預設嚴格標記 ENTRY_WINDOW_MISSED，啟用 allowDeferredFutureBarEntry 時可因果等待下一根未來 K 線並寫入淨 R 帳本', () => {
    const localDbPath = path.join(tmpDir, 'deferred_entry.sqlite');
    const radarDb = new RadarDatabase(localDbPath);
    const paperMonitorDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({ paperMonitorDb });

    try {
      const klines = generateDeterministicSmcKlines({
        basePrice: 180,
        count: 60,
        intervalMs: 15 * 60_000,
        endOpenTime: 1711929600000,
        mode: 'BULL',
      });
      const sigIdx = 58;
      const signalBar = klines[sigIdx];
      const nextBar = klines[sigIdx + 1]; // i+1 already opened when detected late
      const lateDetectedIso = new Date(nextBar.openTime + 120_000).toISOString();

      // Default strict behavior -> ENTRY_WINDOW_MISSED with null entryReferencePrice
      const strictRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_strict',
        scanRunId: 'scan_strict',
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: lateDetectedIso,
        evaluatedAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        klines: klines.slice(0, 59),
        signalBarIndex: sigIdx,
        atr14: 1.5,
        openInterest: 500_000,
        fundingRate: 0.0001,
        provenance: buildProvenance(false),
        waitReasons: [],
        evidences: ['15m Bullish BOS'],
        allowDeferredFutureBarEntry: false,
      });
      assert.ok(strictRes.signal);
      assert.equal(strictRes.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(strictRes.signal.entryReferencePrice, null);

      // Deferred entry behavior on separate symbol -> enters strictly at FUTURE bar i+2 (> detectedMs)
      const deferredRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mon_def',
        scanRunId: 'scan_def',
        symbol: 'SUIUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        snapshotAt: lateDetectedIso,
        evaluatedAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        klines: klines.slice(0, 60),
        signalBarIndex: sigIdx,
        atr14: 1.5,
        openInterest: 500_000,
        fundingRate: 0.0001,
        provenance: buildProvenance(false),
        waitReasons: [],
        evidences: ['15m Bullish BOS'],
        allowDeferredFutureBarEntry: true,
        currentTimeMs: nextBar.openTime + 130_000,
      });
      assert.ok(deferredRes.signal);
      // Before future bar i+2 arrives, original bar i+1 openTime is already past -> cleanly marked ENTRY_WINDOW_MISSED (never retroactive)
      assert.equal(deferredRes.signal.status, 'ENTRY_WINDOW_MISSED');
      assert.equal(deferredRes.signal.entryReferencePrice, null);

      // Append a brand new future bar (i+2) after detection timestamp and settle causally
      const futureBarOpen = nextBar.openTime + 15 * 60_000;
      const futureBar: Kline = {
        openTime: futureBarOpen,
        closeTime: futureBarOpen + 15 * 60_000 - 1,
        open: nextBar.close,
        high: nextBar.close + 8,
        low: nextBar.close - 0.1,
        close: nextBar.close + 7,
        volume: 50000,
        quoteVolume: 9_000_000,
        isClosed: true,
      };
      const settled = tracker.settleSignalWithKlines({
        signalId: deferredRes.signal.signalId,
        klines: [...klines.slice(0, 60), futureBar],
        atr14: 1.5,
        allowDeferredFutureBarEntry: true,
        currentTimeMs: futureBar.closeTime + 1000,
        fundingRatePer8h: 0.0001,
      });
      assert.ok(settled);
      assert.equal(settled.entryReferencePrice, futureBar.open);
      assert.notEqual(settled.status, 'ENTRY_WINDOW_MISSED');

      // Verify maybeCreatePullbackLimitPaperOrder creates SMC_PULLBACK_LIMIT once without duplicates
      const dummyMonitor = new PaperShadowMonitor({
        radarDb,
        paperMonitorDb,
        outcomeTracker: tracker,
        smcBatchScanner: {} as never,
        adapters: {} as never,
      });
      const maybeCreate = (
        dummyMonitor as unknown as {
          maybeCreatePullbackLimitPaperOrder: (p: unknown) => void;
        }
      ).maybeCreatePullbackLimitPaperOrder.bind(dummyMonitor);

      const mockAnalysis = {
        symbol: 'BTCUSDT',
        primaryTimeframe: '15m',
        ruleVersion: 'v1',
        smcEvaluationStatus: 'EVALUATED',
        actionState: 'LONG CANDIDATE',
        confirmedKlineCount: 60,
        unclosedKlineIgnoredCount: 0,
        atr14: 400,
        atrPercent: 0.6,
        bosOrMss: { detected: true, type: 'BOS_BULL', brokenLevel: 65000, candleTime: signalBar.openTime, description: 'ok' },
        liquiditySweep: { detected: true, side: 'SELL_SIDE_SWEPT', sweptLevel: 64500, candleTime: signalBar.openTime, description: 'ok' },
        displacement: { detected: true, direction: 'BULL', bodyToAtrRatio: 1.6, candleTime: signalBar.openTime, description: 'ok' },
        fvg: { detected: true, direction: 'BULL', top: 65100, bottom: 64800, mitigated: false, candleTime: signalBar.openTime, description: 'ok' },
        orderBlock: { detected: true, direction: 'BULL', high: 65000, low: 64700, candleTime: signalBar.openTime, description: 'ok' },
        mtfAlignment: { aligned: true, dominantDirection: 'BULL', byTimeframe: { '5m': 'BULL', '15m': 'BULL', '1h': 'BULL', '4h': 'BULL' }, description: 'ok' },
        waitReasons: [],
        evidences: [],
        provenance: buildProvenance(false),
        entryZoneAnalysis: {
          status: 'NEAR_PULLBACK_ZONE',
          direction: 'LONG',
          anchorType: 'FVG',
          anchorLabel: '15m Bullish FVG 回踩點',
          zoneLow: 64800,
          zoneHigh: 65100,
          idealPullbackEntry: 64950,
          stopLossPrice: 64450,
          targetPrice: 66200,
          currentPrice: 65300,
          distanceToZonePct: 0.5,
          distanceToZoneAtr: 0.8,
          chaseRR: 1.1,
          pullbackRR: 2.5,
          headlineZh: '回踩等待中',
          actionAdviceZh: '掛限價回踩',
        },
      };

      maybeCreate({
        exchange: 'binance_usdm',
        symbol: 'BTCUSDT',
        category: '雷達多頭觀察',
        actionState: 'LONG CANDIDATE',
        analysis: mockAnalysis,
        evidences: ['15m FVG'],
        provenance: buildProvenance(false),
      });
      // Duplicate call must be blocked
      maybeCreate({
        exchange: 'binance_usdm',
        symbol: 'BTCUSDT',
        category: '雷達多頭觀察',
        actionState: 'LONG CANDIDATE',
        analysis: mockAnalysis,
        evidences: ['15m FVG'],
        provenance: buildProvenance(false),
      });

      const limitOrders = radarDb
        .listPaperLedgerEntries(50)
        .filter((e) => e.strategyTrack === 'SMC_PULLBACK_LIMIT');
      assert.equal(limitOrders.length, 1);
      assert.equal(limitOrders[0].fillStatus, 'WAITING_LIMIT');
      assert.equal(limitOrders[0].entryPrice, 64950);

      // Verify closing a filled entry persists Net R and Cost Drag
      const filled = radarDb.addPaperLedgerEntry({
        symbol: 'ETHUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        strategyTrack: 'FORMAL_SMC_MARKET',
        fillStatus: 'FILLED',
        entryPrice: 3000,
        invalidationPrice: 2940, // 2% stop
        targetPrice: 3120,
        ruleVersion: 'v1',
        evidences: ['15m BOS'],
        notes: 'Net R DB test',
        provenance: buildProvenance(false),
      });
      const closed = radarDb.closePaperLedgerEntry(filled.id, 3120, 'TP hit', {
        exitIsLimitFill: true,
        fundingRatePer8h: 0.0001,
      });
      assert.ok(closed);
      assert.equal(closed.grossPnlR, 2);
      assert.ok(typeof closed.netPnlR === 'number' && closed.netPnlR < 2);
      assert.ok(typeof closed.totalCostR === 'number' && closed.totalCostR > 0);
    } finally {
      radarDb.close();
    }
  });

  it('4. Express API: 多幣種組合風控回測 (/api/backtest/portfolio)、Watchdog (/api/system/watchdog/*) 與 5 項實戰計分卡 (/api/validation/readiness)', async () => {
    const mockTelegramCalls: string[] = [];
    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
    });
    const radarDb = app.locals.radarDb as RadarDatabase;
    const extNotify = app.locals
      .externalNotificationService as ExternalNotificationService;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Trigger Watchdog run-check (heartbeat + verified SQLite auto-backup)
      const wdRes = await fetch(`${baseUrl}/api/system/watchdog/run-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceHeartbeat: true, forceBackup: true }),
      });
      assert.equal(wdRes.status, 200);
      const wdData = (await wdRes.json()) as {
        status: SystemWatchdogStatusResponse;
        emittedEvents: Array<{ eventType: string }>;
      };
      assert.ok(wdData.status.autoBackupsCount >= 1);
      assert.ok(wdData.status.lastAutoBackupAt !== null);
      assert.ok(wdData.status.lastHeartbeatAt !== null);
      assert.equal(
        wdData.status.alertsDispatchedCount,
        0,
        'No external HTTP alerts should be sent when channels are not enabled/configured'
      );

      // Update Watchdog config via POST /api/system/watchdog/config
      const cfgRes = await fetch(`${baseUrl}/api/system/watchdog/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiErrorSpikeThreshold: 3, enabled: true }),
      });
      assert.equal(cfgRes.status, 200);
      const cfgData = (await cfgRes.json()) as SystemWatchdogStatusResponse;
      assert.equal(cfgData.config.apiErrorSpikeThreshold, 3);

      // Verify ExternalNotificationService.dispatchSystemWatchdogAlert delivers via mock fetch when configured
      const prevTok = process.env.TELEGRAM_BOT_TOKEN;
      const prevChat = process.env.TELEGRAM_CHAT_ID;
      process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEF_MOCK_TOKEN_1234567890';
      process.env.TELEGRAM_CHAT_ID = '999888777';
      extNotify.updateConfig({ telegramEnabled: true });
      const isolatedNotify = new ExternalNotificationService({
        db: radarDb,
        fetchImpl: async (url) => {
          mockTelegramCalls.push(String(url));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const deliveredLogs = await isolatedNotify.dispatchSystemWatchdogAlert({
        eventType: 'WORKER_STALL',
        severity: 'CRITICAL',
        titleZh: '測試卡死告警',
        messageZh: '測試訊息',
      });
      assert.equal(mockTelegramCalls.length, 1);
      assert.equal(deliveredLogs[0].status, 'DELIVERED');
      if (prevTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevTok;
      if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = prevChat;
      extNotify.updateConfig({ telegramEnabled: false });

      // Portfolio Benchmark Backtest via BacktestService customDatasets + HTTP route
      const k1 = generateDeterministicSmcKlines({
        basePrice: 65000,
        count: 140,
        intervalMs: 15 * 60_000,
        endOpenTime: 1711929600000,
        mode: 'BULL',
      });
      const k2 = generateDeterministicSmcKlines({
        basePrice: 3200,
        count: 140,
        intervalMs: 15 * 60_000,
        endOpenTime: 1711929600000,
        mode: 'BULL',
      });
      const oi1 = generateDeterministicHistoricalOiAndFunding({
        symbol: 'BTCUSDT',
        klines: k1,
        baseOi: 85000,
        baseFundingRate: 0.0001,
      });
      const oi2 = generateDeterministicHistoricalOiAndFunding({
        symbol: 'ETHUSDT',
        klines: k2,
        baseOi: 65000,
        baseFundingRate: 0.0001,
      });

      const backtestService = app.locals.backtestService as BacktestService;
      const pfServiceRes = await backtestService.runPortfolioBenchmarkBacktest({
        symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        timeframe: '15m',
        mode: 'live',
        exchange: 'binance_usdm',
        barLimit: 240,
        riskConfig: {
          maxOpenPositions: 1,
          maxSameDirectionPositions: 1,
          dailyMaxDrawdownR: 2,
          consecutiveLossCooldownLimit: 2,
          cooldownBars: 4,
        },
        customDatasetsBySymbol: {
          BTCUSDT: {
            klines: k1,
            historicalOpenInterest: oi1.oiSeries,
            historicalFundingRates: oi1.fundingSeries,
            provenance: buildProvenance(false),
          },
          ETHUSDT: {
            klines: k2,
            historicalOpenInterest: oi2.oiSeries,
            historicalFundingRates: oi2.fundingSeries,
            provenance: buildProvenance(false),
          },
          SOLUSDT: {
            klines: k2.map((bar) => ({
              ...bar,
              open: bar.open * 0.05,
              high: bar.high * 0.05,
              low: bar.low * 0.05,
              close: bar.close * 0.05,
            })),
            historicalOpenInterest: oi2.oiSeries,
            historicalFundingRates: oi2.fundingSeries,
            provenance: buildProvenance(false),
          },
        },
      });
      assert.equal(pfServiceRes.symbolsSucceeded, 3);
      assert.ok(pfServiceRes.rawTotalTrades > 0);
      assert.ok(
        pfServiceRes.blockedByRiskCapCount > 0,
        `Expected maxOpenPositions=1 to block overlapping concurrent trades, got blocked=${pfServiceRes.blockedByRiskCapCount}`
      );
      assert.ok(
        pfServiceRes.acceptedTradesCount < pfServiceRes.rawTotalTrades
      );

      // Test POST /api/backtest/portfolio HTTP endpoint in Demo mode (offline-safe)
      const pfHttpRes = await fetch(`${baseUrl}/api/backtest/portfolio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: ['BTCUSDT', 'ETHUSDT'],
          timeframe: '15m',
          mode: 'demo',
          exchange: 'demo_synthetic',
          barLimit: 240,
          riskConfig: {
            maxOpenPositions: 3,
            maxSameDirectionPositions: 2,
            dailyMaxDrawdownR: 3,
          },
        }),
      });
      assert.equal(pfHttpRes.status, 200);
      const pfHttpData = (await pfHttpRes.json()) as PortfolioBacktestResult;
      assert.equal(pfHttpData.isDemo, true);
      assert.equal(pfHttpData.symbolsRequested.length, 2);

      // Check Validation Readiness Scorecard endpoint
      const valRes = await fetch(
        `${baseUrl}/api/validation/readiness?exchange=binance_usdm`
      );
      assert.equal(valRes.status, 200);
      const valData = (await valRes.json()) as ValidationReadinessResponse;
      assert.equal(valData.totalCount, 5);
      assert.equal(valData.criteria.length, 5);
      assert.ok(
        valData.criteria.some((c) => c.id === 'OPERATIONAL_STABILITY' && c.status === 'PASSED'),
        'Watchdog heartbeat + verified backup should mark OPERATIONAL_STABILITY as PASSED'
      );

      // Test POST /api/backtest/ab-compare HTTP endpoint in Demo mode
      const abHttpRes = await fetch(`${baseUrl}/api/backtest/ab-compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: ['BTCUSDT', 'ETHUSDT'],
          timeframe: '15m',
          mode: 'demo',
          exchange: 'demo_synthetic',
          barLimit: 200,
          riskConfig: {
            maxOpenPositions: 3,
            maxSameDirectionPositions: 2,
            dailyMaxDrawdownR: 3,
          },
        }),
      });
      assert.equal(abHttpRes.status, 200);
      const abData = (await abHttpRes.json()) as SmcAbComparisonResponse;
      assert.equal(abData.profiles.length, 3);
      assert.deepEqual(
        abData.profiles.map((p) => p.profile),
        ['STRICT_PRODUCTION', 'RELAXED_MTF_DISP', 'TREND_NO_SWEEP']
      );
      assert.equal(abData.lookaheadFree, true);
    } finally {
      (app.locals.systemWatchdog as SystemWatchdogService | undefined)?.stop();
      (app.locals.positionSentinel as PositionSentinelService | undefined)?.stop();
      (app.locals.smcBatchScanner as SmcBatchScanService | undefined)?.stop();
      radarDb.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('5. SmcRuleProfile (RELAXED_MTF_DISP / TREND_NO_SWEEP) 保留低流動性/極端費率風控且與 STRICT_PRODUCTION 維持隔離', () => {
    const k15 = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'BULL',
    });
    const k5mBearNoise = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 40,
      intervalMs: 5 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'BEAR',
    });
    const k1hBull = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 35,
      intervalMs: 60 * 60_000,
      endOpenTime: 1711929600000,
      mode: 'BULL',
    });

    const prov = buildProvenance(false);

    // With 5m conflicting against 15m+1h BULL, STRICT_PRODUCTION detects CONFLICT while RELAXED_MTF_DISP aligns BULL
    const strictRes = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': k5mBearNoise,
        '15m': k15,
        '1h': k1hBull,
      },
      openInterest: 100_000,
      provenance: prov,
    });
    assert.equal(strictRes.mtfAlignment.dominantDirection, 'CONFLICT');
    assert.ok(
      strictRes.actionState === 'LONG CANDIDATE' ||
        strictRes.actionState === 'WATCH' ||
        strictRes.actionState === 'WAIT'
    );
    if (strictRes.actionState !== 'LONG CANDIDATE') {
      assert.ok((strictRes.missingGates?.length ?? 0) > 0);
    }

    const relaxedRes = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': k5mBearNoise,
        '15m': k15,
        '1h': k1hBull,
      },
      openInterest: 100_000,
      ruleProfile: 'RELAXED_MTF_DISP',
      provenance: prov,
    });
    assert.equal(relaxedRes.mtfAlignment.aligned, true);
    assert.equal(relaxedRes.mtfAlignment.dominantDirection, 'BULL');
    assert.equal(relaxedRes.ruleProfile, 'RELAXED_MTF_DISP');

    // Safety gates (extremeFunding & isLowLiquidity) MUST still block CANDIDATE under relaxed profiles
    const blockedBySafety = evaluateSmcStructure({
      symbol: 'BTCUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': k5mBearNoise,
        '15m': k15,
        '1h': k1hBull,
      },
      openInterest: 100_000,
      extremeFunding: true,
      ruleProfile: 'TREND_NO_SWEEP',
      provenance: prov,
    });
    assert.equal(blockedBySafety.actionState, 'HIGH RISK');
  });
});

