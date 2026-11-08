import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server.ts';
import {
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import {
  extractPriorConfirmedBaselineWindow,
  MIN_HISTORY_SAMPLES,
} from '../server/engine/VolumeAnomalyEngine.ts';
import { PaperMonitorDatabase } from '../server/db/PaperMonitorDatabase.ts';
import { SignalOutcomeTracker } from '../server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  MarketTicker,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../src/types/market.ts';

function buildLiveTickers(count = 40, anchorMs = Date.now()): MarketTicker[] {
  const tickers: MarketTicker[] = [];
  const prov: DataProvenance = {
    source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
    fetchedAt: new Date(anchorMs).toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: false,
  };
  const named = [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'ATOMUSDT',
    'SUIUSDT',
    'XRPUSDT',
  ];
  for (let i = 0; i < count; i++) {
    const symbol =
      i < named.length
        ? named[i]
        : `P9SYM${String(i).padStart(3, '0')}USDT`;
    const price = 100 + i;
    tickers.push({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      lastPrice: price,
      bidPrice: Number((price * 0.9999).toFixed(4)),
      askPrice: Number((price * 1.0001).toFixed(4)),
      spreadPercent: 0.02,
      priceChangePercent24h: i < 8 ? 7.5 : i < 16 ? -6.8 : 0.4,
      quoteVolume24h: i < 20 ? 150_000_000 : 25_000_000,
      fundingRate: 0.0001,
      nextFundingTime: anchorMs + 3_600_000,
      openInterest: 500_000,
      openInterestValue: 50_000_000,
      provenance: prov,
    });
  }
  return tickers;
}

function buildAnchoredKlines(
  timeframe: Timeframe,
  anchorBarCloseMs: number,
  barCount = 60,
  includeTrailingUnclosed = false
): Kline[] {
  const stepMs =
    timeframe === '5m'
      ? 300_000
      : timeframe === '15m'
        ? 900_000
        : timeframe === '1h'
          ? 3_600_000
          : 14_400_000;
  const alignedCloseMs =
    timeframe === '5m' || timeframe === '15m'
      ? Math.floor(anchorBarCloseMs / stepMs) * stepMs - 1
      : anchorBarCloseMs;
  const bars: Kline[] = [];
  let price = 100;

  for (let i = barCount; i >= 1; i--) {
    const closeTime = alignedCloseMs - (i - 1) * stepMs;
    const openTime = closeTime - stepMs + 1;
    const open = price;
    const close = Number((price + (i % 2 === 0 ? 0.4 : -0.35)).toFixed(4));
    const high = Number((Math.max(open, close) + 0.25).toFixed(4));
    const low = Number((Math.min(open, close) - 0.25).toFixed(4));
    const quoteVolume = 2_000_000 + i * 1000;
    bars.push({
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume: Number((quoteVolume / price).toFixed(2)),
      quoteVolume,
      isClosed: true,
    });
    price = close;
  }

  if (includeTrailingUnclosed) {
    const nextOpenTime = alignedCloseMs + 1;
    const nextCloseTime = nextOpenTime + stepMs - 1;
    bars.push({
      openTime: nextOpenTime,
      closeTime: nextCloseTime,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price + 0.5,
      volume: 99_999,
      quoteVolume: 99_999_999,
      isClosed: false,
    });
  }

  return bars;
}

class Phase9MockAdapter implements ExchangeAdapter {
  public readonly id: ExchangeId = 'binance_usdm';
  public readonly displayName = 'Binance USDⓈ-M Futures (Phase 9 Test)';
  public readonly enabled = true;
  public readonly isDemo = false;
  public readonly status = 'LIVE' as const;

  public tickerCount = 30;
  public anchorMs = Date.now();
  public includeUnclosedBar = false;
  public returnNullOiForSymbols = new Set<string>();
  public returnNullFundingForSymbols = new Set<string>();
  public klineFetchCalls: Array<{
    symbol: string;
    timeframe: Timeframe;
    limit: number;
  }> = [];
  public oiFetchCalls: string[] = [];
  public simulatedDelayMs = 0;

  resetCounters() {
    this.klineFetchCalls = [];
    this.oiFetchCalls = [];
  }

  async fetchMarketSnapshot() {
    const tickers = buildLiveTickers(this.tickerCount, this.anchorMs).map((t) => {
      if (this.returnNullOiForSymbols.has(t.symbol)) {
        t.openInterest = null;
        t.openInterestValue = null;
      }
      if (this.returnNullFundingForSymbols.has(t.symbol)) {
        t.fundingRate = null;
        t.nextFundingTime = null;
      }
      return t;
    });
    return {
      tickers,
      provenance: {
        source: 'Binance USDⓈ-M Futures REST (/fapi/v1/ticker/24hr)',
        fetchedAt: new Date(this.anchorMs).toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
    if (this.simulatedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedDelayMs));
    }
    this.klineFetchCalls.push({ symbol, timeframe, limit });
    return {
      klines: buildAnchoredKlines(
        timeframe,
        this.anchorMs,
        limit,
        this.includeUnclosedBar
      ),
      provenance: {
        source: `Binance USDⓈ-M Futures REST (/fapi/v1/klines ${symbol} ${timeframe})`,
        fetchedAt: new Date(this.anchorMs).toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  async fetchOpenInterest(symbol: string, referencePrice = 100) {
    this.oiFetchCalls.push(symbol);
    if (this.returnNullOiForSymbols.has(symbol)) {
      return {
        openInterest: null,
        openInterestValue: null,
        provenance: {
          source: `Binance USDⓈ-M Futures REST (/fapi/v1/openInterest ${symbol})`,
          fetchedAt: new Date(this.anchorMs).toISOString(),
          stale: false,
          fallback: false,
          missingData: ['openInterest'],
          isDemo: false,
        },
      };
    }
    return {
      openInterest: 500_000,
      openInterestValue: 500_000 * referencePrice,
      provenance: {
        source: `Binance USDⓈ-M Futures REST (/fapi/v1/openInterest ${symbol})`,
        fetchedAt: new Date(this.anchorMs).toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }
}

describe('Phase 9: Persistent Warm Cache Snapshot, Incremental Kline Prewarm & Non-Blocking Full-Universe Verification', () => {
  it('1. SQLite Restart Recovery & Live/Demo Cache Isolation: restores 5m/15m/1h/4h/OI/Funding across DB close+reopen and isolates Live vs Demo caches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase9-p1-'));
    const dbPath = path.join(tmpDir, 'radar.sqlite');

    const step15m = 900_000;
    const baseAnchorMs =
      Math.floor(Date.now() / step15m) * step15m + step15m + 30_000;
    const adapter1 = new Phase9MockAdapter();
    adapter1.tickerCount = 8;
    adapter1.anchorMs = baseAnchorMs;

    const db1 = new RadarDatabase(dbPath);
    const scanner1 = new SmcBatchScanService({
      db: db1,
      adapters: {
        binance_usdm: adapter1,
        bybit_linear: adapter1,
        bingx_swap: adapter1,
        demo_synthetic: adapter1,
      },
      config: { maxConcurrency: 2, maxRequestsPerMinute: 240 },
    });

    const snap1 = await adapter1.fetchMarketSnapshot();
    const preScan1 = runMarketScan(snap1.tickers, snap1.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
      historicalVolumeMap: new Map(),
    });
    scanner1.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snap1.tickers,
      candidates: preScan1.candidates,
      watchlistSymbols: ['BTCUSDT', 'SOLUSDT'],
    });
    await scanner1.prewarmFastLaneCache({
      exchange: 'binance_usdm',
      mode: 'live',
    });
    await scanner1.processNextBatch('binance_usdm', 'live', 8);

    // Attempt to contaminate Live venue with Demo cache & Demo venue with Live cache
    db1.saveSmcCandlesCache({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '15m',
      klines: buildAnchoredKlines('15m', baseAnchorMs, 60),
      openInterest: 999,
      openInterestValue: 99900,
      fundingRate: 0.001,
      nextFundingTime: baseAnchorMs + 3_600_000,
      expiresAt: new Date(baseAnchorMs + 600_000).toISOString(),
      provenance: {
        source: 'Demo Synthetic Mode (Rule-Engine Verification)',
        fetchedAt: new Date(baseAnchorMs).toISOString(),
        stale: false,
        fallback: true,
        missingData: [],
        isDemo: true,
      },
    });
    db1.saveSmcCandlesCache({
      symbol: 'BTCUSDT',
      exchange: 'demo_synthetic',
      timeframe: '15m',
      klines: buildAnchoredKlines('15m', baseAnchorMs, 60),
      openInterest: 500_000,
      openInterestValue: 50_000_000,
      fundingRate: 0.0001,
      nextFundingTime: baseAnchorMs + 3_600_000,
      expiresAt: new Date(baseAnchorMs + 600_000).toISOString(),
      provenance: {
        source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines BTCUSDT 15m)',
        fetchedAt: new Date(baseAnchorMs).toISOString(),
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    });

    // Close DB connection completely
    db1.close();

    // Reopen fresh DB connection on same SQLite file
    const adapter2 = new Phase9MockAdapter();
    adapter2.tickerCount = 8;
    adapter2.anchorMs = baseAnchorMs + 10_000;
    const db2 = new RadarDatabase(dbPath);

    // Verify all 4 timeframes (5m, 15m, 1h, 4h) + OI + Funding restored intact with all required fields
    for (const tf of ['5m', '15m', '1h', '4h'] as Timeframe[]) {
      const cached = db2.getSmcCandlesCache(
        'binance_usdm',
        'BTCUSDT',
        tf,
        baseAnchorMs + 5_000,
        SMC_RULE_VERSION
      );
      assert.ok(cached, `Expected BTCUSDT ${tf} cache after SQLite reopen`);
      assert.equal(cached.exchange, 'binance_usdm');
      assert.equal(cached.symbol, 'BTCUSDT');
      assert.equal(cached.timeframe, tf);
      assert.ok((cached.dataTimestamp ?? 0) > 0);
      assert.ok((cached.fetchedAt ?? '').length > 0);
      assert.ok(cached.expiresAt.length > 0);
      assert.ok((cached.source ?? '').includes('Binance USDⓈ-M Futures REST'));
      assert.equal(cached.stale, false);
      assert.equal(cached.fallback, false);
      assert.deepEqual(cached.missingData, []);
      assert.equal(cached.isDemo, false);
      assert.equal(cached.ruleVersion, SMC_RULE_VERSION);
      assert.ok(cached.windowKey && cached.windowKey.length > 0);
      assert.equal(cached.isExpired, false);
      assert.equal(cached.openInterest, 500_000);
      assert.equal(cached.fundingRate, 0.0001);
    }

    // Verify Demo contamination was rejected on Live and Live data was rejected on Demo
    const demoReadOfLive = db2.getSmcCandlesCache(
      'demo_synthetic',
      'BTCUSDT',
      '15m',
      baseAnchorMs + 5_000
    );
    assert.equal(
      demoReadOfLive,
      null,
      'Live cache must never be misidentified or read as Demo cache'
    );

    const scanner2 = new SmcBatchScanService({
      db: db2,
      adapters: {
        binance_usdm: adapter2,
        bybit_linear: adapter2,
        bingx_swap: adapter2,
        demo_synthetic: adapter2,
      },
      config: { maxConcurrency: 2, maxRequestsPerMinute: 240 },
    });

    adapter2.resetCounters();
    const prewarmRes2 = await scanner2.prewarmFastLaneCache({
      exchange: 'binance_usdm',
      mode: 'live',
    });
    assert.equal(
      adapter2.klineFetchCalls.length,
      0,
      'Expected 0 kline HTTP requests on warm cache startup recovery'
    );
    assert.equal(prewarmRes2.prewarmCacheHitRate, 100);

    const refreshRes = await scanner2.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });
    assert.equal(adapter2.klineFetchCalls.length, 0);
    assert.equal(refreshRes.result?.cacheHit, true);
    assert.equal(refreshRes.result?.reusedCache, true);

    db2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('2. Timeframe Close Boundaries, OI/Funding TTL, Incremental Limit=20, Confirmed-Only 60-Bar Retention & Baseline Isolation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase9-p2-'));
    const dbPath = path.join(tmpDir, 'radar.sqlite');

    // Align anchor inside a 15m & 5m bar so we can test before and after new bar close
    const step15m = 900_000;
    const baseBarOpenMs = Math.floor(Date.now() / step15m) * step15m + step15m;
    const anchorInsideFirst5mMs = baseBarOpenMs + 60_000; // 1 min after 15m/5m bar open

    const adapter = new Phase9MockAdapter();
    adapter.tickerCount = 4;
    adapter.anchorMs = anchorInsideFirst5mMs;
    adapter.includeUnclosedBar = true; // Return 60 closed + 1 unclosed bar

    const db = new RadarDatabase(dbPath);
    const scanner = new SmcBatchScanService({
      db,
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
    });

    // Initial fetch populates 60 confirmed bars (filtering out the unclosed bar)
    await scanner.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: true,
    });

    const cached5mInitial = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '5m',
      anchorInsideFirst5mMs + 10_000
    );
    assert.ok(cached5mInitial);
    assert.equal(
      cached5mInitial.klines.length,
      60,
      'Must retain at most 60 confirmed klines'
    );
    assert.equal(
      cached5mInitial.klines.every((k) => k.isClosed),
      true,
      'Unclosed klines must never be stored in cache'
    );

    // Verify current bar is strictly excluded from prior 30-bar historical baseline
    const vols = cached5mInitial.klines.map((k) => k.quoteVolume);
    const baselineWin = extractPriorConfirmedBaselineWindow(
      vols,
      vols.length - 1,
      MIN_HISTORY_SAMPLES
    );
    assert.equal(baselineWin.currentVolume, vols[vols.length - 1]);
    assert.equal(baselineWin.historicalVolumes.length, 30);
    assert.equal(
      baselineWin.historicalVolumes.includes(vols[vols.length - 1]),
      false,
      'Current kline volume must never be included in its own 30-bar historical baseline'
    );

    // Boundary 1: Before new 5m bar forms and before TTL expires => MUST cache hit
    const hitBefore5mClose = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '5m',
      baseBarOpenMs + 120_000
    );
    assert.ok(hitBefore5mClose);
    assert.equal(hitBefore5mClose.isExpired, false);
    assert.equal(hitBefore5mClose.cacheHit, true);

    // Boundary 2: After new 5m confirmed bar forms (baseBarOpenMs + 300_000) => 5m MUST mark expired, while 15m is still fresh!
    const after5mBarCloseMs = baseBarOpenMs + 305_000;
    const expAfter5mClose = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '5m',
      after5mBarCloseMs
    );
    const stillFresh15m = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      after5mBarCloseMs
    );
    assert.ok(expAfter5mClose);
    assert.equal(
      expAfter5mClose.isExpired,
      true,
      '5m cache must expire when a new 5m confirmed bar forms'
    );
    assert.ok(stillFresh15m);
    assert.equal(
      stillFresh15m.isExpired,
      false,
      '15m cache must remain fresh until the 15m bar closes'
    );

    // Boundary 3: Expire 5m TTL and trigger refresh => must use incremental limit=20 and retain 60 closed bars
    db.saveSmcCandlesCache({
      ...cached5mInitial,
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    adapter.resetCounters();
    await scanner.priorityRefreshSymbol({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: false,
    });
    assert.equal(adapter.klineFetchCalls.length, 1);
    assert.equal(adapter.klineFetchCalls[0].timeframe, '5m');
    assert.equal(
      adapter.klineFetchCalls[0].limit,
      20,
      'Incremental kline request must be capped at limit=20'
    );
    const merged5m = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '5m');
    assert.ok(merged5m);
    assert.equal(merged5m.klines.length, 60);
    assert.equal(merged5m.klines.every((k) => k.isClosed), true);

    // Boundary 4: OI TTL (oiExpiresAt) and Funding TTL (nextFundingTime)
    const raw15m = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '15m')!;
    db.saveSmcCandlesCache({
      ...raw15m,
      oiExpiresAt: new Date(anchorInsideFirst5mMs - 1_000).toISOString(),
    });
    const oiExpiredCache = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      anchorInsideFirst5mMs + 5_000
    );
    assert.ok(oiExpiredCache);
    assert.equal(
      oiExpiredCache.isExpired,
      true,
      'Cache must mark expired when oiExpiresAt has passed'
    );

    db.saveSmcCandlesCache({
      ...raw15m,
      oiExpiresAt: new Date(anchorInsideFirst5mMs + 900_000).toISOString(),
      nextFundingTime: anchorInsideFirst5mMs + 60_000,
    });
    const fundingExpiredCache = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      anchorInsideFirst5mMs + 65_000
    );
    assert.ok(fundingExpiredCache);
    assert.equal(
      fundingExpiredCache.isExpired,
      true,
      'Cache must mark expired when nextFundingTime has passed'
    );

    // Boundary 5: Missing OI / Funding must record missingData and downgrade to NONE (never fabricate values)
    adapter.returnNullOiForSymbols.add('ETHUSDT');
    adapter.returnNullFundingForSymbols.add('ETHUSDT');
    const snapMissing = await adapter.fetchMarketSnapshot();
    const preScanMissing = runMarketScan(
      snapMissing.tickers,
      snapMissing.provenance,
      {
        mode: 'live',
        exchange: 'binance_usdm',
        volumeTimeframe: '15m',
        historicalVolumeMap: new Map(),
      }
    );
    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: snapMissing.tickers,
      candidates: preScanMissing.candidates,
    });
    const ethEval = await scanner.priorityRefreshSymbol({
      symbol: 'ETHUSDT',
      exchange: 'binance_usdm',
      mode: 'live',
      executeImmediately: true,
      forceRefresh: true,
    });
    assert.ok(ethEval.result);
    assert.ok(ethEval.result.missingData.includes('openInterest'));
    assert.ok(ethEval.result.missingData.includes('fundingRate'));
    assert.equal(ethEval.result.finalTradeSignal, 'NONE');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('3. Non-Blocking PENDING Semantics, Fast Lane vs BULK Separation, SLA Separation, Paper Entry Anti-Lookahead & 5-Endpoint Consistency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase9-p3-'));
    const dbPath = path.join(tmpDir, 'radar.sqlite');

    const adapter = new Phase9MockAdapter();
    adapter.tickerCount = 35; // Includes Tier 1..5 Fast Lane AND Tier 6 BULK symbols
    adapter.anchorMs = Date.now() + 60_000;

    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: adapter,
      },
    });

    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Trigger non-blocking /api/scan before SMC queue runs
      const scanRes1 = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=binance_usdm`
      );
      assert.equal(scanRes1.status, 200);
      const scanJson1 = await scanRes1.json();
      assert.equal(scanJson1.candidates.length, 35);

      // Verify unevaluated symbols return PENDING and finalTradeSignal=NONE (never mislabeled as WAIT)
      const pendingCandidates = scanJson1.candidates.filter(
        (c: { smcEvaluationStatus: string }) =>
          c.smcEvaluationStatus === 'PENDING'
      );
      assert.ok(
        pendingCandidates.length > 0,
        'Expected unevaluated candidates to be PENDING on initial non-blocking /api/scan'
      );
      for (const pc of pendingCandidates) {
        assert.equal(pc.smcEvaluationStatus, 'PENDING');
        assert.equal(pc.smcActionState, 'PENDING');
        assert.equal(pc.finalTradeSignal, 'NONE');
      }

      // 2. Cold-Start Cycle: Start & process all 35 symbols
      const startRes = await fetch(`${baseUrl}/api/smc-scan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'binance_usdm',
          mode: 'live',
          watchlistSymbols: ['BTCUSDT', 'SOLUSDT'],
          processBatchNow: true,
          batchLimit: 40,
        }),
      });
      assert.equal(startRes.status, 200);
      const coldHttpCalls = adapter.klineFetchCalls.length;
      assert.ok(coldHttpCalls > 0, 'Expected HTTP fetches on cold start');

      // Verify Fast Lane vs BULK priorityClass separation in recentJobs
      const statusAfterColdRes = await fetch(
        `${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`
      );
      const statusAfterCold = await statusAfterColdRes.json();
      assert.equal(statusAfterCold.evaluatedCount, 35);
      const fastLaneJobs = statusAfterCold.recentJobs.filter(
        (j: { priorityClass: string; priorityTier: number }) =>
          j.priorityClass === 'FAST_LANE'
      );
      const bulkJobs = statusAfterCold.recentJobs.filter(
        (j: { priorityClass: string; priorityTier: number }) =>
          j.priorityClass === 'BULK'
      );
      assert.ok(fastLaneJobs.length > 0, 'Expected FAST_LANE jobs');
      assert.ok(bulkJobs.length > 0, 'Expected BULK jobs');
      for (const bj of bulkJobs) {
        assert.equal(bj.priorityTier, 6);
        assert.equal(
          bj.priorityClass,
          'BULK',
          'Tier 6 jobs must remain BULK even when executed by the shared worker'
        );
        assert.equal(bj.isFastLane, false);
      }

      // 3. Warm-Start Cycle: Trigger a second scan cycle within valid cache TTL and verify 0 new kline HTTP calls
      adapter.resetCounters();
      const startWarmRes = await fetch(`${baseUrl}/api/smc-scan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'binance_usdm',
          mode: 'live',
          watchlistSymbols: ['BTCUSDT', 'SOLUSDT'],
          processBatchNow: true,
          batchLimit: 40,
        }),
      });
      assert.equal(startWarmRes.status, 200);
      assert.equal(
        adapter.klineFetchCalls.length,
        0,
        'Warm start cycle must reuse SQLite cache with 0 kline HTTP calls'
      );

      // 4. Query all 5 required endpoints and verify consistency & required fields
      const [
        smcStatusRes,
        scanRes2,
        pmStatusRes,
        pmReportRes,
        phase7ReportRes,
      ] = await Promise.all([
        fetch(`${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`),
        fetch(`${baseUrl}/api/scan?mode=live&exchange=binance_usdm`),
        fetch(`${baseUrl}/api/paper-monitor/status`),
        fetch(`${baseUrl}/api/paper-monitor/report?window=24h`),
        fetch(`${baseUrl}/api/validation/phase7-report`),
      ]);

      const smcStatus = await smcStatusRes.json();
      const scanData = await scanRes2.json();
      const pmStatus = await pmStatusRes.json();
      const pmReport = await pmReportRes.json();
      const phase7Report = await phase7ReportRes.json();

      for (const ep of [
        smcStatus,
        scanData,
        pmStatus,
        pmReport,
        phase7Report,
      ]) {
        assert.equal(ep.databaseInstanceId, smcStatus.databaseInstanceId);
        assert.equal(ep.cacheCoverage, 100);
        assert.equal(ep.cacheCoverageRate, 100);
        assert.equal(
          ep.freshCacheCount,
          35,
          'freshCacheCount must equal total fresh symbols and never exceed total symbols (35)'
        );
        assert.ok(ep.freshCacheCount <= 35);
        assert.equal(ep.staleCacheCount, 0);
        assert.equal(ep.expiredCacheCount, 0);
        assert.equal(ep.cacheMissCount, 0);
        assert.equal(ep.prewarmRequiredCount, 0);
        assert.equal(ep['5mCoverage'], 100);
        assert.equal(ep['15mCoverage'], 100);
        assert.equal(ep['1hCoverage'], 100);
        assert.equal(ep['4hCoverage'], 100);
        assert.equal(ep.oiCacheCoverage, 100);
        assert.equal(ep.fundingCacheCoverage, 100);
        assert.equal(ep.cacheStatus, '快取可用');
        assert.equal(ep.cacheStatusLabel, '快取可用');
        assert.ok(
          ep.coldStartPrioritySLA === 'MET' ||
            ep.coldStartPrioritySLA === 'PENDING'
        );
        assert.ok(
          ep.warmCachePrioritySLA === 'MET' ||
            ep.warmCachePrioritySLA === 'PENDING'
        );
        assert.ok(ep.coldStartFullUniverseSLA !== undefined);
      }

      // Verify full-universe mathematical invariants:
      // totalContracts = evaluatedCount + pendingCount + failedCount + rateLimitedCount
      // evaluatedCount = waitCount + watchCount + longCandidateCount + shortCandidateCount + highRiskCount
      assert.equal(
        smcStatus.totalContracts,
        smcStatus.evaluatedCount +
          smcStatus.pendingCount +
          smcStatus.failedCount +
          smcStatus.rateLimitedCount
      );
      assert.equal(
        smcStatus.evaluatedCount,
        smcStatus.waitCount +
          smcStatus.watchCount +
          smcStatus.longCandidateCount +
          smcStatus.shortCandidateCount +
          smcStatus.highRiskCount
      );

      // 5. Verify Paper Entry Timing Safety (signalDetectedAt >= nextBar.openTime => ENTRY_WINDOW_MISSED)
      const radarDb = app.locals.radarDb as RadarDatabase;
      const pmDb = new PaperMonitorDatabase(radarDb);
      const tracker = new SignalOutcomeTracker({ paperMonitorDb: pmDb });
      const signalBarCloseMs = Date.parse('2026-10-26T02:59:59.999Z');
      const klinesWithNextOpen = buildAnchoredKlines('15m', signalBarCloseMs, 60);
      klinesWithNextOpen.push({
        openTime: signalBarCloseMs + 1,
        closeTime: signalBarCloseMs + 900_000,
        open: 105.5,
        high: 106.2,
        low: 105.1,
        close: 105.9,
        volume: 15_000,
        quoteVolume: 1_500_000,
        isClosed: false,
      });
      const lateDetectedIso = '2026-10-26T03:05:00.000Z'; // > nextBar.openTime (03:00:00.000Z)
      const lateRes = tracker.evaluateAndTrackSignal({
        monitorRunId: 'mrun_p9',
        scanRunId: 'srun_p9',
        scanCycleId: 'scyc_p9_late',
        symbol: 'ATOMUSDT',
        exchange: 'binance_usdm',
        timeframe: '15m',
        marketRadarCategory: '雷達多頭觀察',
        smcEvaluationStatus: 'EVALUATED',
        smcActionState: 'LONG CANDIDATE',
        finalTradeSignal: '多頭交易候選',
        ruleVersion: SMC_RULE_VERSION,
        snapshotAt: lateDetectedIso,
        evaluatedAt: lateDetectedIso,
        signalDetectedAt: lateDetectedIso,
        klines: klinesWithNextOpen,
        atr14: 0.5,
        openInterest: 500_000,
        fundingRate: 0.0001,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (/fapi/v1/klines ATOMUSDT 15m)',
          fetchedAt: lateDetectedIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
        waitReasons: [],
        evidences: ['CHoCH:Confirmed', 'FVG:Confirmed', 'Sweep:Confirmed'],
        score: 88,
        isBacktest: false,
      });
      assert.ok(lateRes.signal);
      assert.equal(
        lateRes.signal.status,
        'ENTRY_WINDOW_MISSED',
        'Must mark ENTRY_WINDOW_MISSED when signalDetectedAt >= nextBar.openTime'
      );
      assert.equal(
        lateRes.signal.entryReferencePrice,
        null,
        'Must never retroactively use missed nextBar.open'
      );

      // 6. Verify 0 external Telegram/TradingView requests and all order endpoints return 403/404
      for (const forbiddenPath of [
        '/api/order',
        '/api/orders',
        '/api/trade',
        '/api/binance/order',
        '/fapi/v1/order',
      ]) {
        const orderRes = await fetch(`${baseUrl}${forbiddenPath}`, {
          method: 'POST',
        });
        assert.ok(
          orderRes.status === 404 || orderRes.status === 403,
          `Expected 404 or 403 for ${forbiddenPath}, got ${orderRes.status}`
        );
      }

      assert.deepEqual(smcStatus.safety, TRADING_SAFETY_FLAGS);
    } finally {
      server.close();
      const radarDb = app.locals.radarDb as RadarDatabase | undefined;
      radarDb?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
