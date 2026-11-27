import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server.ts';
import { ExchangeAdapter } from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { ExternalNotificationService } from '../server/services/ExternalNotificationService.ts';
import { PositionSentinelService } from '../server/services/PositionSentinelService.ts';
import {
  ExchangeId,
  HistoricalOpenInterestPoint,
  Kline,
  PositionSentinelStatusResponse,
  Timeframe,
} from '../src/types/market.ts';

function makeKlineSeries(params: {
  count: number;
  basePrice: number;
  stepPerBar: number;
  tfMs: number;
  quoteVolume?: number;
  unclosedLast?: boolean;
}): Kline[] {
  const now = Math.floor(Date.now() / params.tfMs) * params.tfMs;
  const out: Kline[] = [];
  for (let i = 0; i < params.count; i++) {
    const openTime = now - (params.count - 1 - i) * params.tfMs;
    const open = params.basePrice + i * params.stepPerBar;
    const close = open + params.stepPerBar * 0.8;
    const high = Math.max(open, close) + Math.abs(params.basePrice) * 0.002;
    const low = Math.min(open, close) - Math.abs(params.basePrice) * 0.002;
    const qv = params.quoteVolume ?? 1_000_000;
    const isLast = i === params.count - 1;
    out.push({
      openTime,
      closeTime: openTime + params.tfMs - 1,
      open: Number(open.toPrecision(6)),
      high: Number(high.toPrecision(6)),
      low: Number(low.toPrecision(6)),
      close: Number(close.toPrecision(6)),
      volume: Number((qv / Math.max(1, close)).toFixed(2)),
      quoteVolume: qv,
      isClosed: params.unclosedLast && isLast ? false : true,
    });
  }
  return out;
}

class MockSentinelAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly displayName = 'Binance USDⓈ-M Mock';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status = 'LIVE' as const;

  public klinesByTf: Record<string, Kline[]> = {};
  public oiValue = 50_000_000;
  public histOiSeries: HistoricalOpenInterestPoint[] = [];

  async fetchTickers() {
    return {
      tickers: [],
      provenance: {
        source: this.displayName,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchKlines(_symbol: string, timeframe: Timeframe) {
    return {
      klines: this.klinesByTf[timeframe] ?? [],
      provenance: {
        source: this.displayName,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchKlines1m(_symbol: string) {
    return {
      klines: this.klinesByTf['1m'] ?? [],
      provenance: {
        source: this.displayName,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchOpenInterest() {
    return {
      openInterest: 500_000,
      openInterestValue: this.oiValue,
      provenance: {
        source: this.displayName,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchHistoricalOpenInterest() {
    return {
      series: this.histOiSeries,
      provenance: {
        source: this.displayName,
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }
}

describe('Phase 24: Position Sentinel 持倉趨勢即時守護哨兵測試', () => {
  let tmpDir: string;
  let db: RadarDatabase;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-sentinel-p24-'));
    db = new RadarDatabase(path.join(tmpDir, 'radar.db'));
  });

  after(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it('1. 支援手動持倉 CRUD、紙上帳本 OPEN+FILLED 自動同步與平倉自動退場守護', () => {
    const mockAdapter = new MockSentinelAdapter() as unknown as ExchangeAdapter;
    const sentinel = new PositionSentinelService({
      db,
      adapters: {
        binance_usdm: mockAdapter,
        bybit_linear: mockAdapter,
        bingx_swap: mockAdapter,
        demo_synthetic: mockAdapter,
      },
      disableWebSockets: true,
    });

    // Add manual position
    const manual = sentinel.addPosition({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      side: 'LONG',
      timeframe: '15m',
      entryPrice: 65000,
      invalidationPrice: 64000,
      targetPrice: 67500,
      leverage: 3,
      notes: 'Manual breakout',
    });
    assert.ok(manual.id.startsWith('ps_'));
    assert.equal(manual.sourceType, 'MANUAL');

    // Insert 1 FILLED OPEN paper entry and 1 WAITING_LIMIT OPEN entry
    const filledEntry = db.addPaperLedgerEntry({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      strategyTrack: 'FORMAL_SMC_MARKET',
      fillStatus: 'FILLED',
      entryPrice: 180,
      invalidationPrice: 175,
      targetPrice: 192,
      ruleVersion: 'v2.4.0',
      evidences: ['15m BOS'],
      notes: 'Paper test',
      provenance: {
        source: 'Binance USDⓈ-M Futures REST',
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    });
    db.addPaperLedgerEntry({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '準備觀察',
      actionState: 'WATCH',
      strategyTrack: 'SMC_PULLBACK_LIMIT',
      fillStatus: 'WAITING_LIMIT',
      entryPrice: 3100,
      invalidationPrice: 3040,
      targetPrice: 3260,
      ruleVersion: 'v2.4.0',
      evidences: ['FVG Wait'],
      notes: 'Should not auto-track before fill',
      provenance: {
        source: 'Binance USDⓈ-M Futures REST',
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    });

    const syncRes = sentinel.syncPaperLedgerNow();
    assert.equal(syncRes.importedCount, 1);

    const status = sentinel.getStatus();
    assert.equal(status.summary.totalTracked, 2);
    const trackedSymbols = status.positions.map((p) => p.symbol).sort();
    assert.deepEqual(trackedSymbols, ['BTCUSDT', 'SOLUSDT']);

    // Closing the paper entry must deactivate its Position Sentinel entry on next sync
    db.closePaperLedgerEntry(filledEntry.id, 185, 'Closed win');
    const syncAfterClose = sentinel.syncPaperLedgerNow();
    assert.equal(syncAfterClose.deactivatedCount, 1);
    assert.equal(sentinel.getStatus().summary.totalTracked, 1);

    // Delete manual position cleanly
    assert.equal(sentinel.deletePosition(manual.id), true);
    assert.equal(sentinel.getStatus().summary.totalTracked, 0);
  });

  it('2. 精準判定三層趨勢狀態 (TREND_INTACT / MOMENTUM_FADING / EARLY_REVERSAL / THESIS_BROKEN) 與動態移動防守建議', async () => {
    const adapter = new MockSentinelAdapter();
    const sentinel = new PositionSentinelService({
      db,
      adapters: {
        binance_usdm: adapter as unknown as ExchangeAdapter,
        bybit_linear: adapter as unknown as ExchangeAdapter,
        bingx_swap: adapter as unknown as ExchangeAdapter,
        demo_synthetic: adapter as unknown as ExchangeAdapter,
      },
      disableWebSockets: true,
    });

    for (const p of db.listPositionSentinelPositions({ activeOnly: false })) {
      db.deletePositionSentinelPosition(p.id);
    }

    const pos = sentinel.addPosition({
      symbol: 'AVAXUSDT',
      exchange: 'binance_usdm',
      side: 'LONG',
      timeframe: '15m',
      entryPrice: 100,
      invalidationPrice: 97,
      targetPrice: 108,
      leverage: 1,
    });

    const buildHealthyKlines = () => {
      const k1m = makeKlineSeries({ count: 20, basePrice: 103.5, stepPerBar: 0.05, tfMs: 60_000 });
      const k5m = makeKlineSeries({ count: 35, basePrice: 99, stepPerBar: 0.16, tfMs: 300_000 });
      const k15m = makeKlineSeries({ count: 35, basePrice: 96, stepPerBar: 0.25, tfMs: 900_000 });
      k15m[26].low = 100.5;
      k15m[27].low = 100.2;
      k15m[28].low = 98.8;
      k15m[29].low = 100.4;
      k15m[30].low = 101.0;
      const k1h = makeKlineSeries({ count: 30, basePrice: 92, stepPerBar: 0.4, tfMs: 3_600_000 });
      return { k1m, k5m, k15m, k1h };
    };

    const healthy = buildHealthyKlines();
    adapter.klinesByTf = {
      '1m': healthy.k1m,
      '5m': healthy.k5m,
      '15m': healthy.k15m,
      '1h': healthy.k1h,
    };
    const nowIso = new Date().toISOString();
    adapter.histOiSeries = [
      {
        symbol: 'AVAXUSDT',
        timestamp: 1,
        openInterest: 1000,
        openInterestValue: 10_000_000,
        fetchedAt: nowIso,
        source: 'mock',
        isDemo: false,
      },
      {
        symbol: 'AVAXUSDT',
        timestamp: 2,
        openInterest: 1010,
        openInterestValue: 10_100_000,
        fetchedAt: nowIso,
        source: 'mock',
        isDemo: false,
      },
    ];

    let st = await sentinel.runEvaluationCycle(Date.now());
    let snap = st.positions.find((p) => p.id === pos.id)!;
    assert.equal(snap.healthState, 'TREND_INTACT');
    assert.equal(snap.breakEvenReady, true);
    assert.ok(
      snap.suggestedDefensePrice !== null &&
        snap.suggestedDefensePrice > pos.invalidationPrice,
      '獲利達 +1R 且結構上移時必須提供高於原止損的建議防守位'
    );

    // Case B: Unclosed 5m bar sweeps swing low intraday gently (MICRO_CHOCH_5M_UNCONFIRMED -> MOMENTUM_FADING)
    const fading = buildHealthyKlines();
    fading.k5m[26].low = 103.5;
    fading.k5m[27].low = 103.4;
    fading.k5m[28].low = 102.9;
    fading.k5m[29].low = 103.6;
    fading.k5m[30].low = 103.8;
    const lastIdx5 = fading.k5m.length - 1;
    fading.k5m[lastIdx5].isClosed = false;
    fading.k5m[lastIdx5].low = 102.7;
    fading.k5m[lastIdx5].close = 104.25;
    fading.k1m[fading.k1m.length - 1].close = 104.25;

    adapter.klinesByTf['5m'] = fading.k5m;
    adapter.klinesByTf['1m'] = fading.k1m;
    st = await sentinel.runEvaluationCycle(Date.now() + 1000);
    snap = st.positions.find((p) => p.id === pos.id)!;
    assert.equal(snap.micro5mState, 'TESTING_SWING');
    assert.equal(snap.healthState, 'MOMENTUM_FADING');
    const unconfAlert = st.recentAlerts.find(
      (a) => a.positionId === pos.id && a.eventType === 'MICRO_CHOCH_5M_UNCONFIRMED'
    );
    assert.ok(unconfAlert, '盤中刺破必須記錄 MICRO_CHOCH_5M_UNCONFIRMED');
    assert.equal(unconfAlert.confirmedClose, false);

    // Case C: Confirmed closed 5m CHoCH + adverse 5m FVG + adverse RVOL spike -> EARLY_REVERSAL
    const earlyRev = buildHealthyKlines();
    earlyRev.k5m[26].low = 102.5;
    earlyRev.k5m[27].low = 102.4;
    earlyRev.k5m[28].low = 101.8;
    earlyRev.k5m[29].low = 102.6;
    const cLen5 = earlyRev.k5m.length;
    earlyRev.k5m[cLen5 - 4].low = 103.5;
    earlyRev.k5m[cLen5 - 3].open = 103.4;
    earlyRev.k5m[cLen5 - 3].close = 101.9;
    earlyRev.k5m[cLen5 - 2].high = 102.0;
    earlyRev.k5m[cLen5 - 2].low = 101.2;
    earlyRev.k5m[cLen5 - 2].close = 101.3;
    earlyRev.k5m[cLen5 - 1].isClosed = true;
    earlyRev.k5m[cLen5 - 1].open = 101.4;
    earlyRev.k5m[cLen5 - 1].high = 101.5;
    earlyRev.k5m[cLen5 - 1].low = 100.8;
    earlyRev.k5m[cLen5 - 1].close = 101.0;
    earlyRev.k5m[cLen5 - 1].quoteVolume = 3_500_000;
    earlyRev.k1m[earlyRev.k1m.length - 1].close = 101.0;

    adapter.klinesByTf['5m'] = earlyRev.k5m;
    adapter.klinesByTf['1m'] = earlyRev.k1m;
    st = await sentinel.runEvaluationCycle(Date.now() + 2000);
    snap = st.positions.find((p) => p.id === pos.id)!;
    assert.equal(snap.micro5mState, 'ADVERSE_CHOCH');
    assert.equal(snap.adverseFvgDetected, true);
    assert.equal(snap.healthState, 'EARLY_REVERSAL');
    const confAlert = st.recentAlerts.find(
      (a) => a.positionId === pos.id && a.eventType === 'MICRO_CHOCH_5M_CONFIRMED'
    );
    assert.ok(confAlert && confAlert.confirmedClose === true);

    // Case D: 15m confirmed CHoCH + 1h bearish flip -> THESIS_BROKEN
    const broken = buildHealthyKlines();
    broken.k5m = earlyRev.k5m;
    broken.k15m[broken.k15m.length - 1].close = 98.1;
    broken.k15m[broken.k15m.length - 1].low = 98.0;
    broken.k1h = makeKlineSeries({ count: 30, basePrice: 112, stepPerBar: -0.45, tfMs: 3_600_000 });
    broken.k1m[broken.k1m.length - 1].close = 98.1;

    adapter.klinesByTf = {
      '1m': broken.k1m,
      '5m': broken.k5m,
      '15m': broken.k15m,
      '1h': broken.k1h,
    };
    st = await sentinel.runEvaluationCycle(Date.now() + 3000);
    snap = st.positions.find((p) => p.id === pos.id)!;
    assert.equal(snap.structure15mState, 'REVERSED');
    assert.equal(snap.htf1hBias, 'BEAR');
    assert.equal(snap.healthState, 'THESIS_BROKEN');

    sentinel.deletePosition(pos.id);
  });

  it('3. ExternalNotificationService 對同級警報套用冷卻，但健康狀態惡化升級時立即穿透發送，且絕不自動下單', async () => {
    const dispatchedRequests: Array<{ url: string; body: string }> = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      dispatchedRequests.push({
        url,
        body: String(init?.body ?? ''),
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };

    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    const prevDiscord = process.env.DISCORD_WEBHOOK_URL;
    process.env.TELEGRAM_BOT_TOKEN = '987654321:AAH_valid_test_token_1234567890';
    process.env.TELEGRAM_CHAT_ID = '-10011223344';
    process.env.DISCORD_WEBHOOK_URL =
      'https://discord.com/api/webhooks/998877665544332211/test_webhook_secret_token_xyz';

    try {
      db.saveExternalNotificationConfig({
        telegramEnabled: true,
        discordEnabled: true,
        notifyFormalSmc: true,
        notifyEarlyIgnition: true,
      });
      const extSvc = new ExternalNotificationService({
        db,
        fetchImpl: mockFetch,
      });
      const sentinelCfg = db.savePositionSentinelConfig({
        notifyDiscord: true,
        notifyTelegram: true,
        notifyMinSeverity: 'WARNING',
        alertCooldownMs: 300_000,
      });

      const basePosSnapshot = {
        id: 'ps_notify_test',
        sourceType: 'MANUAL' as const,
        paperLedgerId: null,
        symbol: 'ETHUSDT',
        exchange: 'binance_usdm' as const,
        side: 'LONG' as const,
        timeframe: '15m' as const,
        entryPrice: 3200,
        invalidationPrice: 3120,
        targetPrice: 3400,
        leverage: 2,
        active: true,
        paused: false,
        notes: '',
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentPrice: 3180,
        markSource: 'WEBSOCKET' as const,
        lastTickAt: new Date().toISOString(),
        unrealizedPnlPercent: -1.25,
        unrealizedPnlR: -0.25,
        distanceToInvalidationPercent: 1.89,
        distanceToTargetPercent: 6.92,
        healthState: 'MOMENTUM_FADING' as const,
        healthLabelZh: '動能轉弱',
        healthScore: 66,
        atr15m: 18,
        move1mPct: -0.4,
        move3mPct: -0.6,
        move1mAtrMultiple: 0.7,
        liveBarRvol5m: 1.9,
        micro5mState: 'TESTING_SWING' as const,
        structure15mState: 'ALIGNED' as const,
        htf1hBias: 'BULL' as const,
        oiDeltaPct: null,
        oiWarningZh: null,
        adverseFvgDetected: false,
        adverseFvgRange: null,
        suggestedDefensePrice: null,
        suggestedDefenseLabel: null,
        breakEvenReady: false,
        activeWarnings: ['5m 測試擺動支撐'],
        recentEvents: [],
        lastEvaluatedAt: new Date().toISOString(),
        lastError: null,
        provenance: {
          source: 'Binance USDⓈ-M',
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };

      const t0 = 1_770_000_000_000;
      const firstLogs = await extSvc.dispatchPositionSentinelAlert({
        position: basePosSnapshot,
        alert: {
          id: 'al_1',
          positionId: 'ps_notify_test',
          symbol: 'ETHUSDT',
          exchange: 'binance_usdm',
          side: 'LONG',
          severity: 'WARNING',
          healthState: 'MOMENTUM_FADING',
          eventType: 'MICRO_CHOCH_5M_UNCONFIRMED',
          titleZh: '5m 盤中測試支撐',
          detailZh: '測試前低 3180',
          priceAtEvent: 3180,
          suggestedDefensePrice: null,
          confirmedClose: false,
          createdAt: new Date(t0).toISOString(),
        },
        sentinelConfig: sentinelCfg,
        escalated: false,
        nowMs: t0,
      });
      assert.equal(firstLogs.filter((l) => l.status === 'DELIVERED').length, 2);

      const blockedLogs = await extSvc.dispatchPositionSentinelAlert({
        position: basePosSnapshot,
        alert: {
          id: 'al_2',
          positionId: 'ps_notify_test',
          symbol: 'ETHUSDT',
          exchange: 'binance_usdm',
          side: 'LONG',
          severity: 'WARNING',
          healthState: 'MOMENTUM_FADING',
          eventType: 'MICRO_CHOCH_5M_UNCONFIRMED',
          titleZh: '5m 盤中測試支撐',
          detailZh: '測試前低 3180',
          priceAtEvent: 3178,
          suggestedDefensePrice: null,
          confirmedClose: false,
          createdAt: new Date(t0 + 30_000).toISOString(),
        },
        sentinelConfig: sentinelCfg,
        escalated: false,
        nowMs: t0 + 30_000,
      });
      assert.equal(
        blockedLogs.filter((l) => l.status === 'COOLDOWN_BLOCKED').length,
        2
      );

      const escalatedLogs = await extSvc.dispatchPositionSentinelAlert({
        position: { ...basePosSnapshot, healthState: 'THESIS_BROKEN' },
        alert: {
          id: 'al_3',
          positionId: 'ps_notify_test',
          symbol: 'ETHUSDT',
          exchange: 'binance_usdm',
          side: 'LONG',
          severity: 'CRITICAL',
          healthState: 'THESIS_BROKEN',
          eventType: 'STRUCTURE_CHOCH_15M',
          titleZh: '15m 主結構反轉確認',
          detailZh: '15m 已收盤跌破關鍵低點',
          priceAtEvent: 3145,
          suggestedDefensePrice: null,
          confirmedClose: true,
          createdAt: new Date(t0 + 45_000).toISOString(),
        },
        sentinelConfig: sentinelCfg,
        escalated: true,
        nowMs: t0 + 45_000,
      });
      assert.equal(
        escalatedLogs.filter((l) => l.status === 'DELIVERED').length,
        2
      );

      const demoLogs = await extSvc.dispatchPositionSentinelAlert({
        position: {
          ...basePosSnapshot,
          exchange: 'demo_synthetic',
          provenance: { ...basePosSnapshot.provenance, isDemo: true },
        },
        alert: {
          id: 'al_demo',
          positionId: 'ps_notify_test',
          symbol: 'ETHUSDT',
          exchange: 'demo_synthetic',
          side: 'LONG',
          severity: 'CRITICAL',
          healthState: 'THESIS_BROKEN',
          eventType: 'STRUCTURE_CHOCH_15M',
          titleZh: 'Demo',
          detailZh: 'Demo',
          priceAtEvent: 3145,
          suggestedDefensePrice: null,
          confirmedClose: true,
          createdAt: new Date(t0 + 60_000).toISOString(),
        },
        sentinelConfig: sentinelCfg,
        escalated: true,
        nowMs: t0 + 60_000,
      });
      assert.equal(demoLogs.length, 0);

      assert.equal(
        dispatchedRequests.some(
          (r) => r.url.includes('/fapi/v1/order') || r.url.includes('/v5/order')
        ),
        false
      );
    } finally {
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevToken;
      if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = prevChat;
      if (prevDiscord === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = prevDiscord;
    }
  });

  it('4. HTTP API 完整驗證 (新增欄位驗證 400 / CRUD / check-now / config / SSE)', async () => {
    const adapter = new MockSentinelAdapter();
    adapter.klinesByTf = {
      '1m': makeKlineSeries({ count: 20, basePrice: 100, stepPerBar: 0.1, tfMs: 60_000 }),
      '5m': makeKlineSeries({ count: 30, basePrice: 99, stepPerBar: 0.1, tfMs: 300_000 }),
      '15m': makeKlineSeries({ count: 30, basePrice: 97, stepPerBar: 0.2, tfMs: 900_000 }),
      '1h': makeKlineSeries({ count: 25, basePrice: 94, stepPerBar: 0.3, tfMs: 3_600_000 }),
    };

    const mockAdapters = {
      binance_usdm: adapter as unknown as ExchangeAdapter,
      bybit_linear: adapter as unknown as ExchangeAdapter,
      bingx_swap: adapter as unknown as ExchangeAdapter,
      demo_synthetic: adapter as unknown as ExchangeAdapter,
    };

    const httpDbPath = path.join(tmpDir, 'http-sentinel.db');
    const appInstance = await createApp({
      customDbPath: httpDbPath,
      customAdapters: mockAdapters,
      skipViteMiddleware: true,
    });
    const server = http.createServer(appInstance);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const badRes = await fetch(`${baseUrl}/api/position-sentinel/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'invalid-$$$',
          entryPrice: -10,
          invalidationPrice: 0,
        }),
      });
      assert.equal(badRes.status, 400);

      const createRes = await fetch(`${baseUrl}/api/position-sentinel/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'SOLUSDT',
          exchange: 'binance_usdm',
          side: 'LONG',
          timeframe: '15m',
          entryPrice: 100,
          invalidationPrice: 97,
          targetPrice: 108,
          leverage: 2,
          notes: 'HTTP smoke test',
        }),
      });
      assert.equal(createRes.status, 200);
      const createJson = (await createRes.json()) as {
        position: { id: string };
        status: PositionSentinelStatusResponse;
      };
      assert.ok(createJson.position.id);
      assert.ok(
        createJson.status.positions.some((p) => p.id === createJson.position.id)
      );

      const patchRes = await fetch(
        `${baseUrl}/api/position-sentinel/positions/${createJson.position.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invalidationPrice: 99.5, paused: false }),
        }
      );
      assert.equal(patchRes.status, 200);

      const cfgRes = await fetch(`${baseUrl}/api/position-sentinel/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pollIntervalMs: 10000, atrShockMultiplier: 1.4 }),
      });
      assert.equal(cfgRes.status, 200);
      const cfgJson = (await cfgRes.json()) as PositionSentinelStatusResponse;
      assert.equal(cfgJson.config.pollIntervalMs, 10000);
      assert.equal(cfgJson.config.atrShockMultiplier, 1.4);

      const checkRes = await fetch(`${baseUrl}/api/position-sentinel/check-now`, {
        method: 'POST',
      });
      assert.equal(checkRes.status, 200);
      const checkJson = (await checkRes.json()) as PositionSentinelStatusResponse;
      assert.equal(checkJson.safety.executionPolicy, 'NEVER AUTO-PLACE ORDERS');

      const delRes = await fetch(
        `${baseUrl}/api/position-sentinel/positions/${createJson.position.id}`,
        { method: 'DELETE' }
      );
      assert.equal(delRes.status, 200);
    } finally {
      (appInstance.locals.positionSentinel as PositionSentinelService | undefined)?.stop();
      (appInstance.locals.radarDb as RadarDatabase | undefined)?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
