import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../server/engine/SmcRuleEngine.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { createApp } from '../server.ts';
import { ExchangeId, Timeframe } from '../src/types/market.ts';

function createLiveCacheTestAdapter(
  exchange: ExchangeId = 'binance_usdm',
  options?: {
    nextFundingOffsetMs?: number;
    onFetchKlines?: (symbol: string, timeframe: Timeframe, limit: number) => void;
    onFetchOi?: (symbol: string) => void;
    onFetchSnapshot?: () => void;
  }
): ExchangeAdapter {
  const demo = new DemoExchangeAdapter();
  return {
    id: exchange,
    displayName: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      options?.onFetchSnapshot?.();
      const snap = await demo.fetchMarketSnapshot();
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const nextFundingTime =
        nowMs + (options?.nextFundingOffsetMs ?? 4 * 3600_000);
      return {
        tickers: snap.tickers.map((t) => ({
          ...t,
          exchange,
          fundingRate: 0.00012,
          nextFundingTime,
          provenance: {
            source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
            fetchedAt: nowIso,
            stale: false,
            fallback: false,
            missingData: [],
            isDemo: false,
          },
        })),
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
      options?.onFetchKlines?.(symbol, timeframe, limit);
      const res = await demo.fetchKlines(symbol, timeframe, limit);
      const nowMs = Date.now();
      const barMs =
        timeframe === '5m'
          ? 300_000
          : timeframe === '15m'
            ? 900_000
            : timeframe === '1h'
              ? 3_600_000
              : 14_400_000;
      const latestClosedEnd = Math.floor(nowMs / barMs) * barMs - 1;
      const closedBars = res.klines.filter((k) => k.isClosed);
      const aligned = closedBars.map((k, idx) => {
        const offsetFromEnd = closedBars.length - 1 - idx;
        const closeTime = latestClosedEnd - offsetFromEnd * barMs;
        return {
          ...k,
          openTime: closeTime - barMs + 1,
          closeTime,
          isClosed: true,
        };
      });
      return {
        klines: aligned,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
          fetchedAt: new Date(nowMs).toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchOpenInterest(symbol: string, referencePrice?: number) {
      options?.onFetchOi?.(symbol);
      const res = await demo.fetchOpenInterest(symbol, referencePrice);
      const nowIso = new Date().toISOString();
      return {
        openInterest: res.openInterest ?? 500_000,
        openInterestValue: res.openInterestValue ?? 50_000_000,
        provenance: {
          source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
  };
}

describe('Phase 21: 快取過期自動刷新與自我污染修復驗證', () => {
  let tmpDir = '';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-p21-cache-'));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. 修正 15m 快取因舊 OI 過期造成 stale=1 自我污染與未清除錯誤', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p21-self-poison.sqlite'));
    const adapter = createLiveCacheTestAdapter('binance_usdm');
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
    });

    const snap = await adapter.fetchMarketSnapshot();
    const btcOnly = snap.tickers.filter((t) => t.symbol === 'BTCUSDT');
    const preScan = runMarketScan(btcOnly, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: btcOnly,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      windowKey: 'win_p21_1',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 1);

    const initial15m = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '15m');
    assert.ok(initial15m);
    assert.equal(initial15m.provenance.stale, false);

    // Simulate an expired 15m row AND expired oiExpiresAt while ticker OI is temporarily null
    db.saveSmcCandlesCache({
      ...initial15m,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      oiExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const noOiTickers = btcOnly.map((t) => ({
      ...t,
      openInterest: null,
      openInterestValue: null,
    }));
    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: noOiTickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT'],
      windowKey: 'win_p21_2',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 1);

    const refreshed15m = db.getSmcCandlesCache(
      'binance_usdm',
      'BTCUSDT',
      '15m',
      Date.now()
    );
    assert.ok(refreshed15m);
    assert.equal(
      refreshed15m.provenance.stale,
      false,
      '15m cache must NOT be self-poisoned with stale=1 after fresh fetch'
    );
    assert.equal(refreshed15m.isExpired, false);
    assert.ok(
      refreshed15m.oiExpiresAt &&
        Date.parse(refreshed15m.oiExpiresAt) > Date.now(),
      '15m oiExpiresAt must be refreshed into the future'
    );

    const cov = db.getCacheCoverageMetrics('binance_usdm', 1);
    assert.equal(cov.staleCacheCount, 0);
    assert.equal(cov.expiredCacheCount, 0);
    assert.equal(cov.cacheStatusLabel, '快取可用');
    db.close();
  });

  it('2. 非 15m 週期隔離 OI 期限且啟動時自動清理舊資料庫非 15m 殘留 oi_expires_at', async () => {
    const dbPath = path.join(tmpDir, 'p21-non15m-oi.sqlite');
    const db1 = new RadarDatabase(dbPath);
    const adapter = createLiveCacheTestAdapter('binance_usdm');
    const nowMs = Date.now();
    const k1h = await adapter.fetchKlines('BTCUSDT', '1h', 60);
    const k4h = await adapter.fetchKlines('BTCUSDT', '4h', 60);
    const k5m = await adapter.fetchKlines('BTCUSDT', '5m', 60);
    const k15m = await adapter.fetchKlines('BTCUSDT', '15m', 60);

    const pastOiIso = new Date(nowMs - 10 * 60_000).toISOString();
    const futureOiIso = new Date(nowMs + 15 * 60_000).toISOString();

    for (const [tf, res, ttl] of [
      ['5m', k5m, 300_000],
      ['15m', k15m, 900_000],
      ['1h', k1h, 1_800_000],
      ['4h', k4h, 3_600_000],
    ] as const) {
      db1.saveSmcCandlesCache({
        symbol: 'BTCUSDT',
        exchange: 'binance_usdm',
        timeframe: tf,
        klines: res.klines,
        openInterest: 100_000,
        openInterestValue: 10_000_000,
        fundingRate: 0.0001,
        nextFundingTime: nowMs + 3_600_000,
        oiFetchedAt: res.provenance.fetchedAt,
        oiExpiresAt: tf === '15m' ? futureOiIso : pastOiIso,
        dataTimestamp: res.klines[res.klines.length - 1].closeTime,
        expiresAt: new Date(nowMs + ttl).toISOString(),
        ruleVersion: SMC_RULE_VERSION,
        windowKey: 'win_non15m',
        provenance: res.provenance,
      });
    }

    // saveSmcCandlesCache must strip oi_expires_at on non-15m rows immediately
    const c4h = db1.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '4h', nowMs);
    assert.equal(c4h?.oiExpiresAt, null);
    assert.equal(c4h?.isExpired, false);

    // Also verify legacy polluted rows in SQLite are cleaned automatically on reopen
    db1.close();
    const rawSql = new DatabaseSync(dbPath);
    rawSql
      .prepare(
        `UPDATE smc_scan_candles_cache SET oi_expires_at = ?, oi_fetched_at = ? WHERE timeframe = '4h'`
      )
      .run(pastOiIso, pastOiIso);
    rawSql.close();

    const db2 = new RadarDatabase(dbPath);
    const covAfterReopen = db2.getCacheCoverageMetrics('binance_usdm', 1, false, SMC_RULE_VERSION, nowMs);
    assert.equal(covAfterReopen.expiredCacheCount, 0);
    assert.equal(covAfterReopen['4hCacheCoverage'], 100);
    assert.equal(covAfterReopen.cacheStatusLabel, '快取可用');
    db2.close();
  });

  it('3. 快取過期後 refreshExpiredCachesIfNeeded 自動增量補齊並保留既有 SMC 評估結果', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p21-auto-refresh.sqlite'));
    const fetchCalls: Array<{ symbol: string; tf: Timeframe; limit: number }> = [];
    let oiFetchCalls = 0;
    let fundingExpired = false;

    const baseAdapter = createLiveCacheTestAdapter('binance_usdm', {
      onFetchKlines: (symbol, tf, limit) => {
        fetchCalls.push({ symbol, tf, limit });
      },
      onFetchOi: () => {
        oiFetchCalls++;
      },
    });
    const adapter: ExchangeAdapter = {
      ...baseAdapter,
      async fetchMarketSnapshot() {
        const snap = await baseAdapter.fetchMarketSnapshot();
        const nextFundingTime = fundingExpired
          ? Date.now() - 60_000
          : Date.now() + 4 * 3_600_000;
        return {
          ...snap,
          tickers: snap.tickers.map((t) => ({
            ...t,
            nextFundingTime,
          })),
        };
      },
    };

    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: adapter,
        bybit_linear: adapter,
        bingx_swap: adapter,
        demo_synthetic: adapter,
      },
      db,
    });

    const snap = await adapter.fetchMarketSnapshot();
    const twoTickers = snap.tickers.filter(
      (t) => t.symbol === 'BTCUSDT' || t.symbol === 'ETHUSDT'
    );
    const preScan = runMarketScan(twoTickers, snap.provenance, {
      mode: 'live',
      exchange: 'binance_usdm',
      volumeTimeframe: '15m',
    });

    scanner.enqueueMarketUniverse({
      exchange: 'binance_usdm',
      tickers: twoTickers,
      candidates: preScan.candidates,
      watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
      windowKey: 'win_auto_refresh',
      forceRefresh: true,
      pruneUniverse: true,
    });
    await scanner.processNextBatch('binance_usdm', 'live', 2);

    const beforeStatus = scanner.getStatus('binance_usdm', 'live');
    assert.equal(beforeStatus.cacheStatusLabel, '快取可用');
    assert.equal(beforeStatus.evaluatedCount, 2);

    // Case A: Expire ONLY 5m cache (simulating 5-minute TTL passage while 15m/1h/4h/OI remain fresh)
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      const c5 = db.getSmcCandlesCache('binance_usdm', sym, '5m')!;
      db.saveSmcCandlesCache({
        ...c5,
        expiresAt: new Date(Date.now() - 15_000).toISOString(),
      });
    }

    const expiredStatus = scanner.getStatus('binance_usdm', 'live');
    assert.equal(expiredStatus.cacheStatusLabel, '快取過期');
    assert.equal(expiredStatus.expiredCacheCount, 2);

    fetchCalls.length = 0;
    oiFetchCalls = 0;

    const refreshRes1 = await scanner.refreshExpiredCachesIfNeeded(
      'binance_usdm',
      { force: true }
    );
    assert.equal(refreshRes1.refreshedSymbolCount, 2);
    assert.equal(refreshRes1.remainingExpiredCount, 0);
    // Must only refresh 5m incrementally (limit=20) without re-fetching 15m/1h/4h or OI
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every((c) => c.tf === '5m' && c.limit === 20));
    assert.equal(oiFetchCalls, 0);

    const after5mRefreshStatus = scanner.getStatus('binance_usdm', 'live');
    assert.equal(after5mRefreshStatus.cacheStatusLabel, '快取可用');
    assert.equal(after5mRefreshStatus.expiredCacheCount, 0);
    assert.equal(after5mRefreshStatus.staleCacheCount, 0);
    assert.equal(
      after5mRefreshStatus.evaluatedCount,
      2,
      'Routine cache refresh must NOT wipe valid evaluated SMC results back to PENDING'
    );

    // Case B: Simulate expired funding timestamp on all rows + poisoned stale=1 on ETHUSDT 15m
    const rawSql = new DatabaseSync(path.join(tmpDir, 'p21-auto-refresh.sqlite'));
    rawSql
      .prepare(`UPDATE smc_scan_candles_cache SET next_funding_time = ?`)
      .run(Date.now() - 30_000);
    rawSql
      .prepare(
        `UPDATE smc_scan_candles_cache SET stale = 1 WHERE symbol = 'ETHUSDT' AND timeframe = '15m'`
      )
      .run();
    rawSql.close();
    // Touch DB state via getStatus after clearing in-memory cache by advancing time slightly
    const expiredFundingStatus = db.getCacheCoverageMetrics(
      'binance_usdm',
      2,
      false,
      SMC_RULE_VERSION,
      Date.now() + 2_000
    );
    assert.equal(expiredFundingStatus.cacheStatusLabel, '快取過期');
    assert.equal(expiredFundingStatus.staleCacheCount, 1);

    fundingExpired = false;
    fetchCalls.length = 0;

    const refreshRes2 = await scanner.refreshExpiredCachesIfNeeded(
      'binance_usdm',
      { force: true, nowMs: Date.now() + 2_000 }
    );
    assert.ok(refreshRes2.fundingMetadataUpdatedCount > 0);
    assert.equal(refreshRes2.refreshedSymbolCount, 1);
    // Only ETHUSDT 15m had stale=1; BTCUSDT only needed funding metadata from snapshot!
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].symbol, 'ETHUSDT');
    assert.equal(fetchCalls[0].tf, '15m');

    const healedStatus = scanner.getStatus('binance_usdm', 'live');
    assert.equal(healedStatus.cacheStatusLabel, '快取可用');
    assert.equal(healedStatus.staleCacheCount, 0);
    assert.equal(healedStatus.expiredCacheCount, 0);
    db.close();
  });

  it('4. atomicSnapshotCache 跨越快取過期邊界不回傳過期前舊快照，且 /api/scan 可觸發過期補刷', async () => {
    const dbPath = path.join(tmpDir, 'p21-atomic-and-api.sqlite');
    const adapter = createLiveCacheTestAdapter('binance_usdm');
    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: adapter,
      },
    });
    const db = app.locals.radarDb as RadarDatabase;
    const scanner = app.locals.smcBatchScanner as SmcBatchScanService;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const snap = await adapter.fetchMarketSnapshot();
      const btcOnly = snap.tickers.filter((t) => t.symbol === 'BTCUSDT');
      const preScan = runMarketScan(btcOnly, snap.provenance, {
        mode: 'live',
        exchange: 'binance_usdm',
        volumeTimeframe: '15m',
      });
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers: btcOnly,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: 'win_p21_api',
        forceRefresh: true,
        pruneUniverse: true,
      });
      await scanner.processNextBatch('binance_usdm', 'live', 1);

      const nowMs = Date.now();
      const c5 = db.getSmcCandlesCache('binance_usdm', 'BTCUSDT', '5m')!;
      // Set 5m expiresAt to nowMs + 400ms (within the 1500ms atomicSnapshotCache window)
      db.saveSmcCandlesCache({
        ...c5,
        expiresAt: new Date(nowMs + 400).toISOString(),
      });

      const snapBeforeExpiry = db.getAtomicSmcSnapshot('binance_usdm', nowMs + 100);
      assert.equal(snapBeforeExpiry.cacheStatusLabel, '快取可用');

      const snapAfterExpiry = db.getAtomicSmcSnapshot('binance_usdm', nowMs + 600);
      assert.equal(
        snapAfterExpiry.cacheStatusLabel,
        '快取過期',
        'atomicSnapshotCache must invalidate immediately when nowMs crosses cache expiresAt'
      );

      // Now expire in real wall-clock and trigger /api/scan?mode=live&refreshExpiredCache=true
      db.saveSmcCandlesCache({
        ...c5,
        expiresAt: new Date(Date.now() - 5_000).toISOString(),
      });
      const scanRes = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=binance_usdm&refreshExpiredCache=true`
      );
      assert.equal(scanRes.status, 200);

      // Poll briefly for async background refreshExpiredCachesIfNeeded to complete
      let finalLabel = '';
      for (let i = 0; i < 30; i++) {
        const statusRes = await fetch(
          `${baseUrl}/api/smc-scan/status?mode=live&exchange=binance_usdm`
        );
        const statusJson = (await statusRes.json()) as { cacheStatusLabel: string };
        finalLabel = statusJson.cacheStatusLabel;
        if (finalLabel === '快取可用') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(finalLabel, '快取可用');
    } finally {
      scanner.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
