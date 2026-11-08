import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createApp, getRegisteredRoutes } from '../server.ts';
import {
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import {
  BacktestResult,
  CrossExchangeDivergenceResponse,
  GeminiExplainResponse,
  MarketScanResponse,
  PaperLedgerEntry,
  SymbolDetailResponse,
} from '../src/types/market.ts';

describe('API 整合測試 (Phase 2 Full API Integration Tests)', () => {
  let appInstance: express.Application;
  let server: http.Server;
  let baseUrl = '';
  let tmpDir = '';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-api-test-'));
    appInstance = await createApp({
      skipViteMiddleware: true,
      customDbPath: path.join(tmpDir, 'api_test.sqlite'),
    });
    server = http.createServer(appInstance);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. 驗證 Express Router 完整 API Route Inventory：確認不存在任何實盤下單或交易執行 Route (POST /order, /trade, /position, /execute 等)', async () => {
    const routes = getRegisteredRoutes(appInstance);
    const routeKeys = routes.map((r) => `${r.method} ${r.path}`);

    const forbiddenRoutes = [
      'POST /order',
      'POST /trade',
      'POST /position',
      'POST /execute',
      'POST /api/orders',
      'POST /api/trades',
      'POST /api/execute',
      'POST /api/order',
      'POST /api/trade',
      'POST /api/position',
    ];

    for (const forbidden of forbiddenRoutes) {
      assert.ok(
        !routeKeys.includes(forbidden),
        `禁止存在實盤下單端點: ${forbidden}`
      );
    }

    // Verify expected read/paper routes exist
    assert.ok(routeKeys.includes('GET /api/health'));
    assert.ok(routeKeys.includes('GET /api/scan'));
    assert.ok(routeKeys.includes('GET /api/symbol/:symbol'));
    assert.ok(routeKeys.includes('GET /api/divergence'));
    assert.ok(routeKeys.includes('POST /api/explain'));
    assert.ok(routeKeys.includes('POST /api/notify/preview'));
    assert.ok(routeKeys.includes('GET /api/notify/history'));
    assert.ok(routeKeys.includes('GET /api/backtest/reports'));
    assert.ok(routeKeys.includes('POST /api/backtest'));
    assert.ok(routeKeys.includes('GET /api/paper-ledger'));
    assert.ok(routeKeys.includes('POST /api/paper-ledger'));
    assert.ok(routeKeys.includes('POST /api/paper-ledger/:id/close'));
    assert.ok(routeKeys.includes('GET /api/scheduler/status'));
    assert.ok(routeKeys.includes('POST /api/scheduler/control'));
  });

  it('2. GET /api/health 驗證 Binance(LIVE), Bybit(LIVE), BingX(LIVE), Demo(DEMO_ONLY) 狀態與 PAPER ONLY 政策', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.status, 'ok');
    assert.equal(body.safety.mode, 'PAPER ONLY');
    assert.equal(body.safety.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(body.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

    const exchanges = body.supportedExchanges as Array<{
      id: string;
      enabled: boolean;
      isDemo: boolean;
      status: string;
    }>;

    const binance = exchanges.find((e) => e.id === 'binance_usdm');
    const bybit = exchanges.find((e) => e.id === 'bybit_linear');
    const bingx = exchanges.find((e) => e.id === 'bingx_swap');
    const demo = exchanges.find((e) => e.id === 'demo_synthetic');

    assert.deepEqual(
      {
        enabled: binance?.enabled,
        isDemo: binance?.isDemo,
        status: binance?.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: bybit?.enabled,
        isDemo: bybit?.isDemo,
        status: bybit?.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: bingx?.enabled,
        isDemo: bingx?.isDemo,
        status: bingx?.status,
      },
      { enabled: true, isDemo: false, status: 'LIVE' }
    );
    assert.deepEqual(
      {
        enabled: demo?.enabled,
        isDemo: demo?.isDemo,
        status: demo?.status,
      },
      { enabled: true, isDemo: true, status: 'DEMO_ONLY' }
    );
  });

  it('3. 多交易所即時掃描驗證：GET /api/scan 測試 Binance、Bybit、BingX 三家公開 REST adapter 與 provenance', async () => {
    for (const ex of ['binance_usdm', 'bybit_linear', 'bingx_swap'] as const) {
      const res = await fetch(`${baseUrl}/api/scan?mode=live&exchange=${ex}`);
      const body = (await res.json()) as MarketScanResponse;

      if (res.status === 200) {
        assert.equal(body.mode, 'live');
        assert.equal(body.exchange, ex);
        assert.equal(body.isDemo, false);
        assert.equal(body.fallback, false);
        assert.equal(body.provenance.isDemo, false);
        assert.ok(body.candidates.length > 0);
        assert.ok(body.dataQuality.volumeProxyNotice.includes('輔助'));
        assert.ok(
          body.dataQuality.volumeProxyNotice.includes('不冒充歷史異常成交量')
        );

        const sample =
          body.candidates.find((c) => c.symbol === 'BTCUSDT') ||
          body.candidates[0];
        assert.ok(sample);
        assert.equal(sample.historicalVolume.exchange, ex);
        assert.equal(sample.provenance.isDemo, false);
        assert.equal(typeof sample.provenance.source, 'string');
        assert.equal(typeof sample.provenance.fetchedAt, 'string');
        assert.equal(typeof sample.provenance.stale, 'boolean');
        assert.equal(typeof sample.provenance.fallback, 'boolean');
        assert.ok(Array.isArray(sample.provenance.missingData));
      } else {
        assert.equal(res.status, 503);
        assert.equal(body.mode, 'live');
        assert.equal(body.isDemo, false);
        assert.equal(body.fallback, false);
        assert.equal(body.candidates.length, 0);
        assert.equal(body.apiError, '即時資料不可用');
      }
    }
  });

  it('4. 單一幣種 K 線、OI 與 30 筆歷史量能 Collector：GET /api/symbol/BTCUSDT 驗證後端收集已收盤 15m K 線並計算 rollingMedian, MAD, robustZScore, RVOL', async () => {
    const res = await fetch(
      `${baseUrl}/api/symbol/BTCUSDT?mode=live&exchange=binance_usdm&timeframe=15m`
    );
    if (res.status === 200) {
      const body = (await res.json()) as SymbolDetailResponse;
      assert.equal(body.mode, 'live');
      assert.equal(body.isDemo, false);
      assert.equal(body.symbol, 'BTCUSDT');
      assert.equal(body.candidate.historicalVolume.sampleCount, 30);
      assert.equal(body.candidate.historicalVolume.minRequiredSamples, 30);
      assert.equal(body.candidate.historicalVolume.status, 'READY');
      assert.ok(
        body.candidate.historicalVolume.rollingMedian !== null &&
          body.candidate.historicalVolume.rollingMedian > 0
      );
      assert.ok(body.candidate.historicalVolume.mad !== null);
      assert.ok(body.candidate.historicalVolume.robustZScore !== null);
      assert.ok(body.candidate.historicalVolume.rvol !== null);
      assert.ok(body.smcAnalysis.confirmedKlineCount >= 30);
    } else {
      assert.equal(res.status, 503);
    }
  });

  it('5. 手動 Demo 模式 (GET /api/scan?mode=demo) 驗證 isDemo=true, fallback=false, 29筆樣本 (AVAXUSDT) INSUFFICIENT_HISTORY 輸出準備觀察，30筆樣本 (SOLUSDT) READY 輸出多頭候選', async () => {
    const res = await fetch(`${baseUrl}/api/scan?mode=demo`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as MarketScanResponse;

    assert.equal(body.mode, 'demo');
    assert.equal(body.isDemo, true);
    assert.equal(body.fallback, false);
    assert.equal(body.source, 'DEMO_SYNTHETIC_DATASET');
    assert.equal(body.provenance.isDemo, true);
    assert.equal(body.provenance.fallback, false);

    // AVAXUSDT has 29 samples -> INSUFFICIENT_HISTORY -> 準備觀察
    const avax = body.candidates.find((c) => c.symbol === 'AVAXUSDT')!;
    assert.ok(avax);
    assert.equal(avax.historicalVolume.sampleCount, 29);
    assert.equal(avax.historicalVolume.status, 'INSUFFICIENT_HISTORY');
    assert.equal(avax.historicalVolume.rollingMedian, null);
    assert.equal(avax.historicalVolume.mad, null);
    assert.equal(avax.historicalVolume.robustZScore, null);
    assert.equal(avax.historicalVolume.rvol, null);
    assert.equal(avax.category, '準備觀察');

    // SOLUSDT has 30 samples -> READY -> 多頭候選
    const sol = body.candidates.find((c) => c.symbol === 'SOLUSDT')!;
    assert.ok(sol);
    assert.equal(sol.historicalVolume.sampleCount, 30);
    assert.equal(sol.historicalVolume.status, 'READY');
    assert.ok(sol.historicalVolume.rollingMedian !== null);
    assert.ok(sol.historicalVolume.mad !== null);
    assert.ok(sol.historicalVolume.robustZScore !== null);
    assert.ok(sol.historicalVolume.rvol !== null);
    assert.equal(sol.category, '多頭候選');
  });

  it('6. 跨交易所背離 API (GET /api/divergence) 與紙上交易 Ledger / 回測報表 SQLite 持久化 API', async () => {
    const demoDivRes = await fetch(
      `${baseUrl}/api/divergence?mode=demo&limit=10`
    );
    assert.equal(demoDivRes.status, 200);
    const demoDiv =
      (await demoDivRes.json()) as CrossExchangeDivergenceResponse;
    assert.equal(demoDiv.mode, 'demo');
    assert.equal(demoDiv.isDemo, true);
    assert.equal(demoDiv.fallback, false);
    assert.ok(demoDiv.items.length > 0);
    const first = demoDiv.items[0];
    assert.ok(first.priceDivergencePercent !== null);
    assert.ok(first.fundingDivergenceBps !== null);
    assert.ok(first.oiDivergencePercent !== null);

    // Create paper ledger entry
    const createRes = await fetch(`${baseUrl}/api/paper-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        entryPrice: 210,
        invalidationPrice: 204,
        targetPrice: 222,
        evidences: ['BOS_BULL', 'RVOL 2.5x'],
        provenance: {
          source: 'VERIFICATION_SCRIPT',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      }),
    });
    assert.equal(createRes.status, 200);
    const createBody = (await createRes.json()) as {
      safety: { mode: string };
      entry: PaperLedgerEntry;
    };
    assert.equal(createBody.safety.mode, 'PAPER ONLY');
    assert.equal(createBody.entry.status, 'OPEN');
    assert.equal(createBody.entry.provenance.source, 'TEST_FIXTURE');
    assert.equal(createBody.entry.provenance.isDemo, true);
    assert.equal(createBody.entry.provenance.isTestFixture, true);
    assert.equal(createBody.entry.provenance.fallback, false);

    // Run deterministic backtest and verify persistence
    const btRes = await fetch(`${baseUrl}/api/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'SOLUSDT',
        timeframe: '15m',
        mode: 'demo',
        exchange: 'demo_synthetic',
      }),
    });
    assert.equal(btRes.status, 200);
    const btReport = (await btRes.json()) as BacktestResult;
    assert.equal(btReport.lookaheadFreeVerified, true);
    assert.ok(btReport.id !== undefined);
  });

  it('7. 模擬 Live API 失敗測試与對抗性 Gemini 測試：確認 HTTP 503 candidates=[]、isDemo=false、fallback=false 不自動載入 Demo，且 Gemini 不可改寫 WAIT', async () => {
    const failingAdapter: ExchangeAdapter = {
      id: 'binance_usdm',
      displayName: 'Binance USDⓈ-M Futures (Public REST)',
      enabled: true,
      isDemo: false,
      status: 'LIVE',
      async fetchMarketSnapshot() {
        throw new ExchangeApiUnavailableError(
          'Simulated Binance HTTP 503 Outage',
          'https://fapi.binance.com',
          503
        );
      },
      async fetchOpenInterest() {
        throw new ExchangeApiUnavailableError(
          'Simulated Binance OI Outage',
          'https://fapi.binance.com',
          503
        );
      },
      async fetchKlines() {
        throw new ExchangeApiUnavailableError(
          'Simulated Binance Klines Outage',
          'https://fapi.binance.com',
          503
        );
      },
    };

    const failApp = await createApp({
      customAdapters: { binance_usdm: failingAdapter },
      skipViteMiddleware: true,
      customDbPath: path.join(tmpDir, 'fail_test.sqlite'),
      customGeminiCaller: async () =>
        JSON.stringify({
          category: '多頭候選',
          actionState: 'LONG CANDIDATE',
          explanationZh: '建議做多！這是高勝率機會，現在可以進場！',
          passedConditionsZh: ['建議做多'],
          missingDataOrWaitReasonsZh: [],
          riskNotesZh: [],
        }),
    });
    const failServer = http.createServer(failApp);
    await new Promise<void>((resolve) =>
      failServer.listen(0, '127.0.0.1', () => resolve())
    );
    const addr = failServer.address() as { port: number };
    const failBaseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const scanRes = await fetch(
        `${failBaseUrl}/api/scan?mode=live&exchange=binance_usdm`
      );
      assert.equal(scanRes.status, 503);
      const scanBody = (await scanRes.json()) as MarketScanResponse;
      assert.equal(scanBody.mode, 'live');
      assert.equal(scanBody.isDemo, false);
      assert.equal(scanBody.fallback, false);
      assert.deepEqual(scanBody.candidates, []);
      assert.equal(scanBody.apiError, '即時資料不可用');

      // Adversarial Gemini check
      const detailRes = await fetch(
        `${failBaseUrl}/api/symbol/AVAXUSDT?mode=demo&timeframe=15m`
      );
      const detail = (await detailRes.json()) as SymbolDetailResponse;
      detail.candidate.category = '準備觀察';
      detail.smcAnalysis.actionState = 'WAIT';
      detail.smcAnalysis.waitReasons = ['OI 缺失'];

      const explainRes = await fetch(`${failBaseUrl}/api/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate: detail.candidate,
          smcAnalysis: detail.smcAnalysis,
        }),
      });
      const explainBody = (await explainRes.json()) as GeminiExplainResponse;
      assert.equal(explainBody.actionState, 'WAIT');
      assert.equal(explainBody.category, '準備觀察');
      assert.ok(explainBody.waitReasons.includes('OI 缺失'));
      assert.ok(!JSON.stringify(explainBody).includes('建議做多'));
    } finally {
      await new Promise<void>((resolve) => failServer.close(() => resolve()));
    }
  });

  it('8. GET /api/symbol/:symbol/decision-trace、全市場 10 項 Gate 統計與雙層 (市場雷達 + SMC/ICT) 分離驗證', async () => {
    const scanRes = await fetch(`${baseUrl}/api/scan?mode=demo`);
    assert.equal(scanRes.status, 200);
    const scanBody = (await scanRes.json()) as MarketScanResponse;

    // Verify all full-market statistics exist and are numbers
    assert.equal(typeof scanBody.totalContractsScanned, 'number');
    assert.equal(typeof scanBody.insufficientHistoryCount, 'number');
    assert.equal(typeof scanBody.baselineUnstableCount, 'number');
    assert.equal(typeof scanBody.liquidityRejectedCount, 'number');
    assert.equal(typeof scanBody.momentumPassedCount, 'number');
    assert.equal(typeof scanBody.relativeBtcPassedCount, 'number');
    assert.equal(typeof scanBody.marketRadarLongCount, 'number');
    assert.equal(typeof scanBody.marketRadarShortCount, 'number');
    assert.equal(typeof scanBody.smcPendingCount, 'number');
    assert.equal(typeof scanBody.smcWaitCount, 'number');
    assert.equal(typeof scanBody.smcLongCandidateCount, 'number');
    assert.equal(typeof scanBody.smcShortCandidateCount, 'number');
    assert.equal(
      scanBody.smcPendingCount +
        scanBody.smcWaitCount +
        scanBody.smcWatchCount +
        scanBody.smcLongCandidateCount +
        scanBody.smcShortCandidateCount +
        scanBody.smcHighRiskCount,
      scanBody.totalContractsScanned
    );

    assert.equal(scanBody.provenance.volumeTimeframe, '15m');
    assert.equal(
      scanBody.provenance.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.equal(scanBody.provenance.volumeMetric, 'quoteVolume');

    // Verify every candidate has complete decisionTrace and two-layer fields
    for (const c of scanBody.candidates) {
      assert.ok(c.decisionTrace, `${c.symbol} must have decisionTrace`);
      assert.equal(c.decisionTrace.symbol, c.symbol);
      assert.ok(c.decisionTrace.categoryBeforeGates);
      assert.ok(c.decisionTrace.finalCategory);
      assert.equal(typeof c.decisionTrace.score, 'number');
      assert.ok(c.decisionTrace.scoreBreakdown);
      assert.ok(c.decisionTrace.gates.history);
      assert.equal(c.decisionTrace.gates.history.volumeTimeframe, '15m');
      assert.equal(
        c.decisionTrace.gates.history.aggregationWindow,
        '15m_CONFIRMED_KLINE_30_BARS'
      );
      assert.equal(c.decisionTrace.gates.history.volumeMetric, 'quoteVolume');
      assert.equal(c.historicalVolume.volumeTimeframe, '15m');
      assert.equal(
        c.historicalVolume.aggregationWindow,
        '15m_CONFIRMED_KLINE_30_BARS'
      );
      assert.equal(c.historicalVolume.volumeMetric, 'quoteVolume');
      assert.equal(c.provenance.volumeTimeframe, '15m');
      assert.equal(
        c.provenance.aggregationWindow,
        '15m_CONFIRMED_KLINE_30_BARS'
      );
      assert.ok(c.decisionTrace.gates.liquidity);
      assert.ok(c.decisionTrace.gates.momentum);
      assert.ok(c.decisionTrace.gates.relativeBtc);
      assert.ok(c.decisionTrace.gates.funding);
      assert.ok(c.decisionTrace.gates.smc);
      assert.ok(Array.isArray(c.decisionTrace.downgradeReasons));
      assert.ok(c.marketRadarCategory);
      assert.ok(['PENDING', 'EVALUATED'].includes(c.smcEvaluationStatus));
      assert.ok(c.smcActionState);
      assert.ok(c.finalTradeSignal);
      assert.equal(c.decisionTrace.finalTradeSignal, c.finalTradeSignal);
      assert.equal(c.decisionTrace.smcActionState, c.smcActionState);
      assert.equal(
        c.decisionTrace.smcEvaluationStatus,
        c.smcEvaluationStatus
      );

      // Strict two-layer rule check on every API candidate:
      if (
        c.smcActionState === 'PENDING' ||
        c.smcActionState === 'WAIT' ||
        c.smcActionState === 'WATCH' ||
        c.smcActionState === 'HIGH RISK'
      ) {
        assert.equal(
          c.finalTradeSignal,
          'NONE',
          `${c.symbol} with SMC=${c.smcActionState} must have finalTradeSignal=NONE`
        );
        assert.notEqual(
          c.finalCategory,
          '多頭候選',
          `${c.symbol} with SMC=${c.smcActionState} must NOT have finalCategory=多頭候選`
        );
        assert.notEqual(
          c.finalCategory,
          '空頭候選',
          `${c.symbol} with SMC=${c.smcActionState} must NOT have finalCategory=空頭候選`
        );
      } else if (c.smcActionState === 'LONG CANDIDATE') {
        assert.equal(c.finalTradeSignal, '多頭交易候選');
        assert.equal(c.finalCategory, '多頭候選');
      } else if (c.smcActionState === 'SHORT CANDIDATE') {
        assert.equal(c.finalTradeSignal, '空頭交易候選');
        assert.equal(c.finalCategory, '空頭候選');
      }
    }

    assert.equal(scanBody.finalCategorySmcMismatchCount, 0);
    assert.ok(scanBody.waitWatchReasonBreakdown);
    assert.ok(scanBody.waitWatchReasonStats);
    assert.ok(scanBody.radarGateReasonStats);
    const primaryWaitSum = Object.values(
      scanBody.waitWatchReasonStats.mutuallyExclusivePrimaryReasonCount
    ).reduce((acc, v) => acc + v, 0);
    assert.equal(
      primaryWaitSum,
      scanBody.waitWatchReasonStats.uniqueSymbolCount
    );
    const primaryRadarSum = Object.values(
      scanBody.radarGateReasonStats.mutuallyExclusivePrimaryReasonCount
    ).reduce((acc, v) => acc + v, 0);
    assert.equal(
      primaryRadarSum,
      scanBody.radarGateReasonStats.uniqueSymbolCount
    );

    // Verify GET /api/symbol/:symbol/decision-trace endpoint (SOLUSDT: LONG CANDIDATE, XRPUSDT: Radar Long + SMC WAIT)
    const traceRes = await fetch(
      `${baseUrl}/api/symbol/SOLUSDT/decision-trace?mode=demo&timeframe=15m`
    );
    assert.equal(traceRes.status, 200);
    const traceBody = await traceRes.json();
    assert.equal(traceBody.symbol, 'SOLUSDT');
    assert.equal(traceBody.marketRadarCategory, '雷達多頭觀察');
    assert.equal(traceBody.smcEvaluationStatus, 'EVALUATED');
    assert.equal(traceBody.smcActionState, 'LONG CANDIDATE');
    assert.equal(traceBody.finalTradeSignal, '多頭交易候選');
    assert.equal(traceBody.finalCategory, '多頭候選');
    assert.ok(traceBody.categoryBeforeGates);
    assert.equal(typeof traceBody.score, 'number');
    assert.ok(traceBody.scoreBreakdown);
    assert.equal(traceBody.gates.history.minRequiredSamples, 30);
    assert.equal(traceBody.gates.history.volumeTimeframe, '15m');
    assert.equal(
      traceBody.gates.history.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.equal(traceBody.gates.history.volumeMetric, 'quoteVolume');
    assert.equal(traceBody.provenance.volumeTimeframe, '15m');
    assert.equal(
      traceBody.provenance.aggregationWindow,
      '15m_CONFIRMED_KLINE_30_BARS'
    );
    assert.ok(
      ['READY', 'INSUFFICIENT_HISTORY', 'BASELINE_UNSTABLE'].includes(
        traceBody.gates.history.status
      )
    );
    assert.equal(typeof traceBody.gates.liquidity.passed, 'boolean');
    assert.equal(typeof traceBody.gates.momentum.passed, 'boolean');
    assert.equal(typeof traceBody.gates.relativeBtc.passed, 'boolean');
    assert.equal(typeof traceBody.gates.funding.passed, 'boolean');
    assert.equal(typeof traceBody.gates.smc.passed, 'boolean');
    assert.ok(Array.isArray(traceBody.downgradeReasons));
    assert.ok(traceBody.diagnostics);

    // Verify LINKUSDT decision-trace: Layer 1 雷達多頭觀察 + Layer 2 WAIT -> finalTradeSignal NONE, finalCategory 準備觀察
    const linkTraceRes = await fetch(
      `${baseUrl}/api/symbol/LINKUSDT/decision-trace?mode=demo&timeframe=15m`
    );
    assert.equal(linkTraceRes.status, 200);
    const linkTrace = await linkTraceRes.json();
    assert.equal(linkTrace.symbol, 'LINKUSDT');
    assert.equal(linkTrace.marketRadarCategory, '雷達多頭觀察');
    assert.equal(linkTrace.smcEvaluationStatus, 'EVALUATED');
    assert.equal(linkTrace.smcActionState, 'WAIT');
    assert.equal(linkTrace.finalTradeSignal, 'NONE');
    assert.equal(linkTrace.finalCategory, '準備觀察');

    // Verify ETHUSDT decision-trace: Layer 1 雷達多頭觀察 + Layer 2 WATCH -> finalTradeSignal NONE, finalCategory 準備觀察
    const ethTraceRes = await fetch(
      `${baseUrl}/api/symbol/ETHUSDT/decision-trace?mode=demo&timeframe=15m`
    );
    assert.equal(ethTraceRes.status, 200);
    const ethTrace = await ethTraceRes.json();
    assert.equal(ethTrace.symbol, 'ETHUSDT');
    assert.equal(ethTrace.marketRadarCategory, '雷達多頭觀察');
    assert.equal(ethTrace.smcEvaluationStatus, 'EVALUATED');
    assert.equal(ethTrace.smcActionState, 'WATCH');
    assert.equal(ethTrace.finalTradeSignal, 'NONE');
    assert.equal(ethTrace.finalCategory, '準備觀察');

    // Verify SMC state statistics and non-uniform distribution across Demo 18 symbols
    assert.equal(typeof scanBody.smcWatchCount, 'number');
    assert.equal(typeof scanBody.smcHighRiskCount, 'number');
    assert.equal(typeof scanBody.smcGateNotConfirmedCount, 'number');
    assert.ok(scanBody.smcStateCounts);
    assert.ok(scanBody.smcLongCandidateCount > 0);
    assert.ok(scanBody.smcShortCandidateCount > 0);
    assert.ok((scanBody.smcWatchCount ?? 0) > 0);
    assert.ok(scanBody.smcWaitCount > 0);
    assert.ok(
      scanBody.smcLongCandidateCount + scanBody.smcShortCandidateCount <
        scanBody.candidates.length,
      'Demo 全市場掃描不得將所有幣種皆標為 SMC CANDIDATE'
    );
  });

  it('9. 安全鐵律驗證：維持 PAPER ONLY / LIVE ORDERS DISABLED / NEVER AUTO-PLACE ORDERS，且不存在任何私密下單或自動下單端點', async () => {
    const scanRes = await fetch(`${baseUrl}/api/scan?mode=demo`);
    const scanBody = (await scanRes.json()) as MarketScanResponse;
    assert.equal(scanBody.safety.mode, 'PAPER ONLY');
    assert.equal(scanBody.safety.liveOrders, 'LIVE ORDERS DISABLED');
    assert.equal(scanBody.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

    const forbiddenOrderPaths = [
      '/api/order',
      '/api/orders',
      '/api/trade',
      '/api/live-order',
      '/api/auto-order',
      '/api/exchange/order',
    ];
    for (const p of forbiddenOrderPaths) {
      const res = await fetch(`${baseUrl}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 }),
      });
      assert.equal(
        res.status,
        404,
        `不得存在任何交易所私密下單或自動下單端點 (${p})`
      );
    }
  });
});


