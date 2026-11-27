import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createApp } from '../server.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { AutoBacktestScheduler } from '../server/services/AutoBacktestScheduler.ts';
import { BacktestService } from '../server/services/BacktestService.ts';
import { DemoExchangeAdapter } from '../server/adapters/ExchangeAdapter.ts';
import { BacktestDatabase } from '../server/db/BacktestDatabase.ts';
import {
  ExternalNotificationService,
  isValidDiscordWebhookUrl,
  isValidTelegramToken,
} from '../server/services/ExternalNotificationService.ts';
import {
  AutoBacktestStatusResponse,
  BacktestResult,
  ExternalNotificationStatusResponse,
  ScannedCandidate,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function buildMockLiveCandidate(
  overrides: Partial<ScannedCandidate> = {}
): ScannedCandidate {
  const nowIso = new Date().toISOString();
  const base: ScannedCandidate = {
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    lastPrice: 182.5,
    priceChangePercent24h: 4.8,
    quoteVolume24h: 250_000_000,
    bidPrice: 182.45,
    askPrice: 182.55,
    spread: 0.1,
    spreadPercent: 0.05,
    fundingRate: 0.0001,
    openInterest: 1_500_000,
    openInterestValue: 273_750_000,
    historicalVolume: {
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      currentVolume: 250_000_000,
      rollingMedian: 95_000_000,
      mad: 12_000_000,
      sampleCount: 30,
      minRequiredSamples: 20,
      rvol: 2.6,
      robustZScore: 3.1,
      zScore: 3.1,
      isHistoricalAnomaly: true,
      baselineUnstable: false,
      status: 'READY',
      volumeTimeframe: '15m',
      aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
      volumeMetric: 'quoteVolume',
      provenance: {
        source: 'Binance USDⓈ-M Futures REST',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    },
    auxiliaryVolumeRankProxyPercentile: 92,
    volumeRankProxyPercentile: 90,
    momentumScore: 80,
    relativeBtcStrength: 3.7,
    isLowLiquidity: false,
    extremeFunding: false,
    lowLiquidityHighVolatility: false,
    category: '多頭候選',
    categoryBeforeGates: '多頭候選',
    finalCategory: '多頭候選',
    finalTradeSignal: '多頭交易候選',
    marketRadarCategory: '雷達多頭觀察',
    smcEvaluationStatus: 'EVALUATED',
    smcActionState: 'LONG CANDIDATE',
    smcStatusReason: 'SMC 結構共振確認',
    smcEvaluatedAt: nowIso,
    smcDataFetchedAt: nowIso,
    score: 84,
    rawScoreBeforeCap: 84,
    scoreCapApplied: false,
    scoreCapRule: null,
    scoreBreakdown: {
      volumeAnomaly: 25,
      auxiliaryVolumeRank: 10,
      volumeProxy: 10,
      momentum: 15,
      relativeBtcStrength: 10,
      fundingRisk: 5,
      liquidityRisk: 5,
      dataQuality: 4,
    },
    gates: {
      history: {
        sampleCount: 30,
        minRequiredSamples: 20,
        status: 'READY',
        passed: true,
      },
      liquidity: {
        quoteVolume24h: 250_000_000,
        spreadPercent: 0.05,
        passed: true,
      },
      momentum: { change24h: 4.8, passed: true },
      relativeBtc: { value: 3.7, passed: true },
      funding: { value: 0.0001, passed: true },
      smc: {
        evaluationStatus: 'EVALUATED',
        actionState: 'LONG CANDIDATE',
        passed: true,
        waitReasons: [],
      },
    },
    downgradeReasons: [],
    decisionTrace: {
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      evaluatedAt: nowIso,
      ruleVersion: 'test',
      primaryTimeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      gatesPassed: ['history', 'liquidity', 'momentum', 'smc'],
      gatesFailed: [],
      waitReasons: [],
      evidencesSummary: [],
      notes: '',
    } as unknown as ScannedCandidate['decisionTrace'],
    evidences: [
      {
        code: 'HIST_VOL_ANOMALY',
        label: '15m Bullish BOS',
        passed: true,
        value: '突破 181.2',
        weight: 25,
        detail: '結構突破確認',
      },
    ],
    earlyIgnition: {
      status: 'IGNITION_LONG',
      tier: 'STRUCTURAL_IGNITION',
      direction: 'LONG',
      ignitionScore: 82,
      change24hPct: 4.8,
      rvol15m: 2.6,
      zScore15m: 3.1,
      triggerTimeframe: '5m',
      sweepDetected: true,
      mssOrBreakDetected: true,
      displacementDetected: true,
      invalidationPrice: 179.4,
      invalidationLabel: '5m 掃低止損',
      headlineZh: '5m 掃底吸籌 + 放量位移啟動',
      riskWarningZh: '早鳥軌道尚未等 1h/4h 共振，請嚴格執行結構止損',
    },
    provenance: {
      source: 'Binance USDⓈ-M Futures REST',
      fetchedAt: nowIso,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: false,
    },
  };
  return { ...base, ...overrides };
}

describe('Phase 20: 自動回測排程紀錄與 Telegram / Discord 外部通知串接驗收測試', () => {
  it('1. URL/Token 安全校驗與 SSRF 防護：拒絕非官方 Discord 網域、HTTP 明文及私網 IP', () => {
    assert.equal(
      isValidTelegramToken('123456789:AAH_valid_bot_token_string_123456'),
      true
    );
    assert.equal(isValidTelegramToken('invalid-token'), false);

    assert.equal(
      isValidDiscordWebhookUrl(
        'https://discord.com/api/webhooks/123456789012345678/valid_webhook_token_abcdef12345'
      ),
      true
    );
    assert.equal(
      isValidDiscordWebhookUrl(
        'http://discord.com/api/webhooks/123456789012345678/valid_webhook_token_abcdef12345'
      ),
      false
    );
    assert.equal(
      isValidDiscordWebhookUrl('http://127.0.0.1:8080/api/webhooks/123/abc'),
      false
    );
    assert.equal(
      isValidDiscordWebhookUrl(
        'https://evil.example.com/api/webhooks/123456789012345678/valid_webhook_token_abcdef12345'
      ),
      false
    );
  });

  it('2. ExternalNotificationService：預設關閉零請求、Demo/Stale 嚴格隔離、FORMAL_SMC 與 EARLY_IGNITION 獨立簽章互不抑制', async () => {
    const db = new RadarDatabase(':memory:');
    const outboundCalls: Array<{ url: string; body: string }> = [];

    const svc = new ExternalNotificationService({
      db,
      envProvider: () => ({
        telegramBotToken: '123456789:AAH_valid_bot_token_string_123456',
        telegramChatId: '-100999888777',
        discordWebhookUrl:
          'https://discord.com/api/webhooks/123456789012345678/valid_webhook_token_abcdef12345',
      }),
      fetchImpl: async (url, init) => {
        outboundCalls.push({ url, body: init?.body ?? '' });
        return {
          ok: true,
          status: 200,
          text: async () => '{"ok":true}',
        };
      },
    });

    const candidate = buildMockLiveCandidate();

    // Default OFF -> 0 outbound calls
    const defaultLogs = await svc.dispatchCandidates({
      candidates: [candidate],
      mode: 'live',
      isDemo: false,
    });
    assert.equal(defaultLogs.length, 0);
    assert.equal(outboundCalls.length, 0);

    // Enable both channels & both event tracks
    svc.updateConfig({
      telegramEnabled: true,
      discordEnabled: true,
      notifyFormalSmc: true,
      notifyEarlyIgnition: true,
    });

    // Demo mode must still emit 0 external calls
    const demoLogs = await svc.dispatchCandidates({
      candidates: [candidate],
      mode: 'demo',
      isDemo: true,
    });
    assert.equal(demoLogs.length, 0);
    assert.equal(outboundCalls.length, 0);

    // Stale candidate must emit 0 external calls
    const staleLogs = await svc.dispatchCandidates({
      candidates: [
        buildMockLiveCandidate({
          provenance: {
            ...candidate.provenance,
            stale: true,
          },
        }),
      ],
      mode: 'live',
      isDemo: false,
    });
    assert.equal(staleLogs.length, 0);
    assert.equal(outboundCalls.length, 0);

    // First send early ignition only (WAIT on SMC) -> delivers TELEGRAM + DISCORD for EARLY_IGNITION
    const earlyOnlyCandidate = buildMockLiveCandidate({
      smcActionState: 'WAIT',
      finalTradeSignal: 'NONE',
      gates: {
        ...candidate.gates,
        smc: {
          evaluationStatus: 'EVALUATED',
          actionState: 'WAIT',
          passed: false,
          waitReasons: ['1h 未共振'],
        },
      },
    });
    const t0 = Date.now();
    const earlyLogs = await svc.dispatchCandidates({
      candidates: [earlyOnlyCandidate],
      mode: 'live',
      isDemo: false,
      nowMs: t0,
    });
    assert.equal(earlyLogs.length, 2);
    assert.ok(earlyLogs.every((l) => l.status === 'DELIVERED'));
    assert.ok(earlyLogs.every((l) => l.track === 'EARLY_IGNITION'));
    assert.equal(outboundCalls.length, 2);

    // Next bar: Formal SMC confirms on SAME symbol -> FORMAL_SMC track must NOT be suppressed by EARLY_IGNITION cooldown
    const formalLogs = await svc.dispatchCandidates({
      candidates: [candidate],
      mode: 'live',
      isDemo: false,
      nowMs: t0 + 10_000,
    });
    const deliveredFormal = formalLogs.filter(
      (l) => l.track === 'FORMAL_SMC' && l.status === 'DELIVERED'
    );
    const blockedEarlyRepeat = formalLogs.filter(
      (l) => l.track === 'EARLY_IGNITION' && l.status === 'DEDUPED_BLOCKED'
    );
    assert.equal(deliveredFormal.length, 2);
    assert.equal(blockedEarlyRepeat.length, 2);
    assert.equal(outboundCalls.length, 4);

    // Every outbound payload includes PAPER ONLY safety boundary
    for (const call of outboundCalls) {
      assert.ok(call.body.includes(TRADING_SAFETY_FLAGS.mode));
      assert.ok(call.body.includes(TRADING_SAFETY_FLAGS.liveOrders));
    }

    db.close();
  });

  it('3. AutoBacktestScheduler：優先選取自選與活躍候選、寫入 AUTO_SCHEDULED 標記並具備同週期快取去重', async () => {
    const db = new RadarDatabase(':memory:');
    const demoAdapter = new DemoExchangeAdapter();
    const backtestDb = new BacktestDatabase(db);
    const backtestService = new BacktestService({
      adapters: {
        binance_usdm: demoAdapter,
        bybit_linear: demoAdapter,
        bingx_swap: demoAdapter,
        demo_synthetic: demoAdapter,
      },
      backtestDb,
    });

    const scheduler = new AutoBacktestScheduler({
      db,
      backtestService,
      getLatestCandidatesFn: () => [
        buildMockLiveCandidate({ symbol: 'SUIUSDT', score: 92 }),
        buildMockLiveCandidate({ symbol: 'ARBUSDT', score: 85 }),
      ],
    });

    scheduler.updateConfig({
      enabled: false,
      timeframe: '15m',
      maxSymbolsPerRun: 3,
      includeWatchlist: true,
      watchlistSymbols: ['BTCUSDT'],
    });

    const batch1 = await scheduler.runBatchOnce({
      force: true,
      mode: 'demo',
    });
    assert.equal(batch1.status, 'SUCCESS');
    assert.deepEqual(batch1.targetSymbols, ['BTCUSDT', 'SUIUSDT', 'ARBUSDT']);
    assert.equal(batch1.completedCount, 3);
    assert.equal(batch1.skippedCachedCount, 0);

    const reports = backtestDb.listBacktestRuns(10);
    assert.equal(reports.length, 3);
    for (const r of reports) {
      assert.equal(r.triggerSource, 'AUTO_SCHEDULED');
      assert.equal(r.autoBatchId, batch1.batchId);
    }

    // Non-forced second run shortly after -> skips cached symbols
    const batch2 = await scheduler.runBatchOnce({
      force: false,
      mode: 'demo',
    });
    assert.equal(batch2.status, 'SUCCESS');
    assert.equal(batch2.completedCount, 0);
    assert.equal(batch2.skippedCachedCount, 3);

    scheduler.stop();
    db.close();
  });

  describe('4. Express API 端點整合測試 (/api/notify/external/* & /api/auto-backtest/*)', () => {
    let appInstance: express.Application;
    let server: http.Server;
    let baseUrl = '';
    let tmpDir = '';
    const mockOutbound: Array<{ url: string; body: string }> = [];

    before(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-p20-test-'));
      appInstance = await createApp({
        skipViteMiddleware: true,
        customDbPath: path.join(tmpDir, 'p20.sqlite'),
        customExternalEnv: () => ({
          telegramBotToken: '987654321:AAH_valid_test_token_1234567890',
          telegramChatId: '-10011223344',
          discordWebhookUrl:
            'https://discord.com/api/webhooks/998877665544332211/test_webhook_secret_token_xyz',
        }),
        customExternalFetch: async (url, init) => {
          mockOutbound.push({ url, body: init?.body ?? '' });
          return {
            ok: true,
            status: 204,
            text: async () => '',
          };
        },
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

    it('外部通知狀態端點不洩漏環境變數明文，且支援開關儲存與手動測試推播', async () => {
      const stRes = await fetch(`${baseUrl}/api/notify/external/status`);
      assert.equal(stRes.status, 200);
      const stRaw = await stRes.text();
      assert.equal(stRaw.includes('AAH_valid_test_token'), false);
      assert.equal(stRaw.includes('test_webhook_secret_token'), false);
      const stJson = JSON.parse(stRaw) as ExternalNotificationStatusResponse;
      assert.equal(stJson.envReadiness.telegramConfigured, true);
      assert.equal(stJson.envReadiness.discordConfigured, true);
      assert.equal(stJson.config.telegramEnabled, false);
      assert.equal(stJson.config.discordEnabled, false);

      // Update toggles
      const cfgRes = await fetch(`${baseUrl}/api/notify/external/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramEnabled: true,
          discordEnabled: true,
          notifyFormalSmc: true,
          notifyEarlyIgnition: true,
        }),
      });
      assert.equal(cfgRes.status, 200);
      const cfgJson = (await cfgRes.json()) as ExternalNotificationStatusResponse;
      assert.equal(cfgJson.config.telegramEnabled, true);
      assert.equal(cfgJson.config.discordEnabled, true);

      // Test dispatch for Telegram & Discord
      const tgTestRes = await fetch(`${baseUrl}/api/notify/external/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'TELEGRAM', symbol: 'BTCUSDT' }),
      });
      const tgTestJson = (await tgTestRes.json()) as {
        ok: boolean;
        record: { status: string; channel: string };
      };
      assert.equal(tgTestJson.ok, true);
      assert.equal(tgTestJson.record.status, 'DELIVERED');
      assert.equal(tgTestJson.record.channel, 'TELEGRAM');

      const dcTestRes = await fetch(`${baseUrl}/api/notify/external/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'DISCORD', symbol: 'ETHUSDT' }),
      });
      const dcTestJson = (await dcTestRes.json()) as {
        ok: boolean;
        record: { status: string; channel: string };
      };
      assert.equal(dcTestJson.ok, true);
      assert.equal(dcTestJson.record.status, 'DELIVERED');
      assert.equal(dcTestJson.record.channel, 'DISCORD');

      assert.equal(mockOutbound.length, 2);
      assert.ok(mockOutbound[0].url.startsWith('https://api.telegram.org/bot'));
      assert.ok(
        mockOutbound[1].url.startsWith('https://discord.com/api/webhooks/')
      );
    });

    it('自動回測 API 支援設定更新、立即執行批次並將 AUTO_SCHEDULED 報表寫入 SQLite', async () => {
      const cfgRes = await fetch(`${baseUrl}/api/auto-backtest/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          intervalMs: 3_600_000,
          maxSymbolsPerRun: 2,
          watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
        }),
      });
      assert.equal(cfgRes.status, 200);
      const cfgJson = (await cfgRes.json()) as AutoBacktestStatusResponse;
      assert.equal(cfgJson.config.maxSymbolsPerRun, 2);
      assert.deepEqual(cfgJson.config.watchlistSymbols, ['BTCUSDT', 'ETHUSDT']);

      const runRes = await fetch(`${baseUrl}/api/auto-backtest/run-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'demo',
          symbols: ['BTCUSDT', 'SOLUSDT'],
        }),
      });
      assert.equal(runRes.status, 200);
      const runJson = (await runRes.json()) as {
        batch: { status: string; completedCount: number };
        status: AutoBacktestStatusResponse;
      };
      assert.equal(runJson.batch.status, 'SUCCESS');
      assert.equal(runJson.batch.completedCount, 2);
      assert.equal(runJson.status.recentBatches.length >= 1, true);

      const reportsRes = await fetch(`${baseUrl}/api/backtest/reports`);
      const reportsJson = (await reportsRes.json()) as {
        reports: BacktestResult[];
      };
      const autoReports = reportsJson.reports.filter(
        (r) => r.triggerSource === 'AUTO_SCHEDULED'
      );
      assert.equal(autoReports.length >= 2, true);
    });
  });
});
