import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { evaluateBtcMarketRegime } from '../server/engine/BtcCorrelationEngine.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import {
  computeEntryZoneAnalysis,
  SMC_RULE_VERSION,
} from '../server/engine/SmcRuleEngine.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { createApp } from '../server.ts';
import type {
  DataProvenance,
  Kline,
  MarketTicker,
} from '../src/types/market.ts';

function makeLiveProvenance(): DataProvenance {
  return {
    source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
    fetchedAt: new Date().toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
    volumeTimeframe: '15m',
    aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
    volumeMetric: 'quoteVolume',
  };
}

function makeTicker(
  symbol: string,
  priceChangePercent24h: number,
  lastPrice = 100
): MarketTicker {
  const baseAsset = symbol.replace(/USDT$/, '');
  return {
    symbol,
    baseAsset,
    quoteAsset: 'USDT',
    lastPrice,
    priceChangePercent24h,
    quoteVolume24h: 120_000_000,
    latestConfirmed15mQuoteVolume: 2_800_000,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    openInterest: 100_000,
    openInterestValue: 100_000 * lastPrice,
    provenance: makeLiveProvenance(),
  };
}

function makeHistVolumeSeries(baseVol = 1_000_000, currentVol = 2_800_000): number[] {
  const arr: number[] = [];
  for (let i = 0; i < 30; i++) {
    arr.push(baseVol + (i % 6) * 200_000);
  }
  arr.push(currentVol);
  return arr;
}

function makeKlines(
  count: number,
  basePrice = 100,
  step = 0,
  startOpenTime = 1_750_000_000_000,
  barMs = 15 * 60_000
): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const open = basePrice + i * step;
    const close = open + (step >= 0 ? 0.15 : -0.15);
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const openTime = startOpenTime + i * barMs;
    out.push({
      openTime,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 10,
      closeTime: openTime + barMs - 1,
      quoteVolume: 100_000 + i * 1000,
      isClosed: true,
    });
  }
  return out;
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('BTC market regime filter blocks counter-trend & volatility-spike altcoin candidates and tightens early ignition', () => {
  const bearRegime = evaluateBtcMarketRegime({
    btcChange24h: -3.2,
  });
  assert.equal(bearRegime.state, 'BEAR_TREND');
  assert.equal(bearRegime.blocksLongAlts, true);
  assert.equal(bearRegime.blocksShortAlts, false);

  const tickers = [
    makeTicker('BTCUSDT', -3.2, 82000),
    makeTicker('SOLUSDT', 4.5, 165), // counter-trend LONG altcoin during BTC BEAR_TREND
    makeTicker('APTUSDT', -6.8, 7.5), // trend-aligned SHORT altcoin
  ];
  const histMap = new Map<string, number[]>([
    ['BTCUSDT', makeHistVolumeSeries()],
    ['SOLUSDT', makeHistVolumeSeries()],
    ['APTUSDT', makeHistVolumeSeries()],
  ]);

  const scanRes = runMarketScan(tickers, makeLiveProvenance(), {
    mode: 'live',
    exchange: 'binance_usdm',
    historicalVolumeMap: histMap,
    btcMarketRegime: bearRegime,
    smcMap: new Map([
      ['BTCUSDT', { actionState: 'LONG CANDIDATE', waitReasons: [] }],
      ['SOLUSDT', { actionState: 'LONG CANDIDATE', waitReasons: [] }],
      ['APTUSDT', { actionState: 'SHORT CANDIDATE', waitReasons: [] }],
    ]),
  });

  assert.equal(scanRes.btcMarketRegime?.state, 'BEAR_TREND');
  const btc = scanRes.candidates.find((c) => c.symbol === 'BTCUSDT')!;
  const sol = scanRes.candidates.find((c) => c.symbol === 'SOLUSDT')!;
  const apt = scanRes.candidates.find((c) => c.symbol === 'APTUSDT')!;

  // Counter-trend altcoin LONG must be downgraded to WATCH by BTC_REGIME_FILTER
  assert.equal(sol.smcActionState, 'WATCH');
  assert.equal(sol.finalTradeSignal, 'NONE');
  assert.equal(sol.category, '準備觀察');
  assert.match(sol.smcStatusReason ?? '', /BTC 大盤趨勢濾網攔截/);
  // Early ignition must also be suppressed when opposing BTC regime
  assert.equal(sol.earlyIgnition?.status, 'NONE');

  // Trend-aligned altcoin SHORT & BTC benchmark itself remain allowed
  assert.equal(apt.smcActionState, 'SHORT CANDIDATE');
  assert.equal(apt.finalTradeSignal, '空頭交易候選');
  assert.equal(btc.smcActionState, 'LONG CANDIDATE');

  // Tightened early ignition rejects noisy low-RVOL impulse even in neutral BTC chop
  const chopRegime = evaluateBtcMarketRegime({ btcChange24h: 0.2 });
  assert.equal(chopRegime.state, 'CHOP_RANGE');
  const weakTicker: MarketTicker = {
    ...makeTicker('DOGEUSDT', 1.4, 0.2),
    latestConfirmed15mQuoteVolume: 1_900_000,
  };
  const weakScan = runMarketScan(
    [makeTicker('BTCUSDT', 0.2, 85000), weakTicker],
    makeLiveProvenance(),
    {
      mode: 'live',
      exchange: 'binance_usdm',
      historicalVolumeMap: new Map([
        ['BTCUSDT', makeHistVolumeSeries(1_000_000, 1_600_000)],
        ['DOGEUSDT', makeHistVolumeSeries(1_000_000, 1_900_000)], // RVOL ~ 1.2 < 1.75
      ]),
      btcMarketRegime: chopRegime,
    }
  );
  const doge = weakScan.candidates.find((c) => c.symbol === 'DOGEUSDT')!;
  assert.equal(doge.earlyIgnition?.status, 'NONE');
});

test('computeEntryZoneAnalysis enforces widened anti-wick SL buffer, 0.6% stop floor, and 2.0R realistic target', () => {
  const analysis = computeEntryZoneAnalysis({
    direction: 'LONG',
    currentPrice: 100.5,
    atr14: 0.2, // small 0.2% ATR so 0.6% fee-floor dominates
    fvg: {
      detected: true,
      direction: 'BULL',
      bottom: 99.8,
      top: 100.2,
      mitigated: false,
      candleTime: 1_750_000_000_000,
      description: 'Bull FVG',
    },
    orderBlock: {
      detected: true,
      direction: 'BULL',
      low: 99.7,
      high: 100.2,
      candleTime: 1_750_000_000_000,
      description: 'Bull OB',
    },
    liquiditySweep: {
      detected: false,
      side: 'NONE',
      sweptLevel: null,
      candleTime: null,
      description: '',
    },
    intradayVwap: 100.0,
    pdh: null,
    pdl: null,
  });

  assert.ok(analysis.idealPullbackEntry !== null);
  assert.ok(analysis.stopLossPrice !== null);
  assert.ok(analysis.targetPrice !== null);

  const entry = analysis.idealPullbackEntry!;
  const sl = analysis.stopLossPrice!;
  const tp = analysis.targetPrice!;
  const slDistPct = (entry - sl) / entry;
  // Minimum 0.6% stop floor
  assert.ok(slDistPct >= 0.0059, `Expected SL distance >= 0.6%, got ${(slDistPct * 100).toFixed(3)}%`);
  // Target calibrated near 2.0R (not distant 2.5R)
  const rr = (tp - entry) / Math.max(entry - sl, 1e-8);
  assert.ok(rr >= 1.75 && rr <= 2.25, `Expected realistic ~2.0R target, got ${rr.toFixed(2)}R`);
});

test('SignalOutcomeTracker blocks OVEREXTENDED & BTC-regime signals and applies dynamic horizon maxHoldBars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winrate-tracker-'));
  const dbPath = path.join(dir, 'radar.sqlite');

  try {
    const radarDb = new RadarDatabase(dbPath);
    const monitorDb = new PaperMonitorDatabase(radarDb);
    const tracker = new SignalOutcomeTracker({
      paperMonitorDb: monitorDb,
      cooldownMs: 0,
    });
    const klines = makeKlines(60, 100, 0.05);
    const signalBar = klines[9];

    // 1. OVEREXTENDED block prevents live market chase tracking
    const overRes = tracker.evaluateAndTrackSignal({
      monitorRunId: 'm1',
      scanRunId: 's1',
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: new Date(signalBar.closeTime).toISOString(),
      evaluatedAt: new Date(signalBar.openTime + 1000).toISOString(),
      klines: klines.slice(0, 10),
      signalBarIndex: 9,
      atr14: 0.8,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: makeLiveProvenance(),
      waitReasons: [],
      evidences: ['BOS: Confirmed'],
      overextendedBlocked: true,
      recordBlockedInDb: true,
    });
    assert.equal(overRes.signal?.status, 'BLOCKED');
    assert.match(overRes.signal?.statusReason ?? '', /OVEREXTENDED_ANTI_CHASE_BLOCKED/);

    // 2. BTC regime block prevents counter-trend alt tracking
    const btcBlockedRes = tracker.evaluateAndTrackSignal({
      monitorRunId: 'm1',
      scanRunId: 's1',
      symbol: 'AVAXUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: new Date(signalBar.closeTime).toISOString(),
      evaluatedAt: new Date(signalBar.openTime + 1000).toISOString(),
      klines: klines.slice(0, 10),
      signalBarIndex: 9,
      atr14: 0.8,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: makeLiveProvenance(),
      waitReasons: [],
      evidences: ['BOS: Confirmed'],
      btcRegimeBlockedReason: 'BTC 偏空壓制',
      recordBlockedInDb: true,
    });
    assert.equal(btcBlockedRes.signal?.status, 'BLOCKED');
    assert.match(btcBlockedRes.signal?.statusReason ?? '', /BTC_REGIME_BLOCKED/);

    // 3. Dynamic maxHoldBars: SCALP_FAST expires at 20 bars, SWING_EXTENDED stays open at 25 bars and expires at 48 bars
    const flatKlines = makeKlines(65, 100, 0);
    const bar9 = flatKlines[9];

    const scalpSig = tracker.evaluateAndTrackSignal({
      monitorRunId: 'm1',
      scanRunId: 's1',
      symbol: 'OPUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: new Date(bar9.closeTime).toISOString(),
      evaluatedAt: new Date(bar9.openTime + 60_000).toISOString(),
      signalDetectedAt: new Date(bar9.openTime + 60_000).toISOString(),
      klines: flatKlines.slice(0, 35),
      signalBarIndex: 9,
      atr14: 1.5, // wide SL/TP so flat klines never hit SL or TP
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: makeLiveProvenance(),
      waitReasons: [],
      evidences: ['BOS: Confirmed'],
      tradeHorizonClass: 'SCALP_FAST',
    });
    assert.equal(scalpSig.signal?.status, 'PAPER_EXPIRED');
    assert.match(scalpSig.signal?.statusReason ?? '', /20 根 K 線/);

    const swingSig = tracker.evaluateAndTrackSignal({
      monitorRunId: 'm1',
      scanRunId: 's1',
      symbol: 'LINKUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      marketRadarCategory: '雷達多頭觀察',
      smcEvaluationStatus: 'EVALUATED',
      smcActionState: 'LONG CANDIDATE',
      finalTradeSignal: '多頭交易候選',
      snapshotAt: new Date(bar9.closeTime).toISOString(),
      evaluatedAt: new Date(bar9.openTime + 60_000).toISOString(),
      signalDetectedAt: new Date(bar9.openTime + 60_000).toISOString(),
      klines: flatKlines.slice(0, 35), // 25 bars after entry (< 48)
      signalBarIndex: 9,
      atr14: 1.5,
      openInterest: 500_000,
      fundingRate: 0.0001,
      provenance: makeLiveProvenance(),
      waitReasons: [],
      evidences: ['BOS: Confirmed'],
      tradeHorizonClass: 'SWING_EXTENDED',
    });
    assert.equal(swingSig.signal?.status, 'PAPER_OPENED');

    const swingSettled = tracker.settleSignalWithKlines({
      signalId: swingSig.signal!.signalId,
      klines: flatKlines, // 55 bars after entry (>= 48)
      atr14: 1.5,
      tradeHorizonClass: 'SWING_EXTENDED',
    });
    assert.equal(swingSettled?.status, 'PAPER_EXPIRED');
    assert.match(swingSettled?.statusReason ?? '', /48 根 K 線/);

    radarDb.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('RadarDatabase +1.0R auto-breakeven arms trailingStopPrice, closes pullback pullback in profit as CLOSED_WIN, and survives checkpoint reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winrate-breakeven-'));
  const dbPath = path.join(dir, 'radar.sqlite');

  try {
    const db1 = new RadarDatabase(dbPath);
    const entry = db1.addPaperLedgerEntry({
      symbol: 'SOLUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      side: 'LONG',
      category: '多頭候選',
      actionState: 'LONG CANDIDATE',
      strategyTrack: 'FORMAL_SMC_MARKET',
      entryPrice: 100,
      invalidationPrice: 98, // 1R = 2
      targetPrice: 104, // +2R
      ruleVersion: SMC_RULE_VERSION,
      evidences: ['BOS'],
      provenance: makeLiveProvenance(),
    });
    assert.equal(entry.breakevenArmed, false);
    assert.equal(entry.trailingStopPrice, null);

    // Move price to 102.2 (+1.1R >= +1.0R) -> should arm breakeven
    db1.updateOpenPaperEntriesWithPrices(
      'binance_usdm',
      new Map([['SOLUSDT', 102.2]])
    );
    const armed = db1.getPaperLedgerEntryById(entry.id)!;
    assert.equal(armed.status, 'OPEN');
    assert.equal(armed.breakevenArmed, true);
    assert.ok(
      armed.trailingStopPrice !== null &&
        armed.trailingStopPrice !== undefined &&
        armed.trailingStopPrice > armed.entryPrice
    );
    // Original invalidation_price (1R denominator) must remain untouched
    assert.equal(armed.invalidationPrice, 98);
    assert.match(armed.notes, /\[已啟動 \+1R 自動保本\]/);
    db1.close();

    // Reload from disk and verify breakeven state survived
    const db2 = new RadarDatabase(dbPath);
    const reloaded = db2.getPaperLedgerEntryById(entry.id)!;
    assert.equal(reloaded.breakevenArmed, true);
    assert.equal(reloaded.trailingStopPrice, armed.trailingStopPrice);

    // Price retraces down to hit armed trailingStopPrice (100.25 -> rawGrossR = 0.125R >= 0.05R)
    db2.updateOpenPaperEntriesWithPrices(
      'binance_usdm',
      new Map([['SOLUSDT', reloaded.trailingStopPrice!]])
    );
    const stoppedWin = db2.getPaperLedgerEntryById(entry.id)!;
    assert.equal(stoppedWin.status, 'CLOSED_WIN');
    assert.ok(stoppedWin.pnlR > 0);
    assert.match(stoppedWin.notes, /\+1R 移動保本止盈觸發/);
    db2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('POST /api/paper-ledger blocks OVEREXTENDED market chasing unless explicitly overridden while permitting WAITING_LIMIT pullback orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winrate-api-'));
  const dbPath = path.join(dir, 'radar.sqlite');

  const app = await createApp({
    customDbPath: dbPath,
    skipViteMiddleware: true,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. OVEREXTENDED market order must return HTTP 400
    const blockedRes = await fetch(`${baseUrl}/api/paper-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        strategyTrack: 'FORMAL_SMC_MARKET',
        fillStatus: 'FILLED',
        entryZoneStatus: 'OVEREXTENDED',
        entryPrice: 170,
        invalidationPrice: 165,
        targetPrice: 180,
        provenance: makeLiveProvenance(),
      }),
    });
    assert.equal(blockedRes.status, 400);
    const blockedBody = (await blockedRes.json()) as { code?: string };
    assert.equal(blockedBody.code, 'OVEREXTENDED_MARKET_ENTRY_BLOCKED');

    // 2. OVEREXTENDED WAITING_LIMIT pullback order is permitted
    const limitRes = await fetch(`${baseUrl}/api/paper-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        strategyTrack: 'SMC_PULLBACK_LIMIT',
        fillStatus: 'WAITING_LIMIT',
        entryZoneStatus: 'OVEREXTENDED',
        entryPrice: 164,
        invalidationPrice: 160,
        targetPrice: 172,
        provenance: makeLiveProvenance(),
      }),
    });
    assert.equal(limitRes.status, 200);
    const limitBody = (await limitRes.json()) as {
      entry: { fillStatus: string };
    };
    assert.equal(limitBody.entry.fillStatus, 'WAITING_LIMIT');

    // 3. Explicit allowOverextendedMarketEntry override works
    const overrideRes = await fetch(`${baseUrl}/api/paper-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        side: 'LONG',
        category: '多頭候選',
        actionState: 'LONG CANDIDATE',
        strategyTrack: 'FORMAL_SMC_MARKET',
        fillStatus: 'FILLED',
        entryZoneStatus: 'OVEREXTENDED',
        allowOverextendedMarketEntry: true,
        entryPrice: 170,
        invalidationPrice: 165,
        targetPrice: 180,
        provenance: makeLiveProvenance(),
      }),
    });
    assert.equal(overrideRes.status, 200);
  } finally {
    const watchdog = app.locals.systemWatchdog as { stop: () => void } | undefined;
    const sentinel = app.locals.positionSentinel as { stop: () => void } | undefined;
    const autoBt = app.locals.autoBacktestScheduler as { stop: () => void } | undefined;
    const monitor = app.locals.paperShadowMonitor as { stop: () => void } | undefined;
    const scanner = app.locals.smcBatchScanner as { stopAll?: () => void } | undefined;
    const radarDb = app.locals.radarDb as RadarDatabase | undefined;
    watchdog?.stop();
    sentinel?.stop();
    autoBt?.stop();
    monitor?.stop();
    scanner?.stopAll?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    radarDb?.close();
    cleanupDb(dbPath);
  }
});
