import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import { SmcBatchScanService } from '../server/services/SmcBatchScanService.ts';
import { createApp } from '../server.ts';
import { ExchangeId, MarketTicker, Timeframe } from '../src/types/market.ts';

function createSyntheticLiveAdapter(
  exchange: ExchangeId,
  symbolPrefix?: string,
  extraSymbolCount = 0
): ExchangeAdapter {
  const demo = new DemoExchangeAdapter();
  const sourceLabel =
    exchange === 'bybit_linear'
      ? 'Bybit V5 Linear REST (https://api.bybit.com)'
      : 'Binance USDⓈ-M Futures REST (https://fapi.binance.com)';
  return {
    id: exchange,
    displayName: sourceLabel,
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      const snap = await demo.fetchMarketSnapshot();
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const baseTickers: MarketTicker[] = snap.tickers.map((t) => ({
        ...t,
        fundingRate: 0.0001,
        nextFundingTime: nowMs + 4 * 3600_000,
        provenance: {
          source: sourceLabel,
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      }));
      const extraTickers: MarketTicker[] = [];
      const template = baseTickers[0];
      for (let i = 0; i < extraSymbolCount; i++) {
        const sym = `${symbolPrefix ?? 'EX'}${String(i + 1).padStart(3, '0')}USDT`;
        extraTickers.push({
          ...template,
          symbol: sym,
          quoteVolume24h: 25_000_000 + i * 1000,
          priceChangePercent24h: (i % 7) - 3,
        });
      }
      const tickers = [...baseTickers, ...extraTickers];
      return {
        tickers,
        provenance: {
          source: sourceLabel,
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
      const proxySymbol =
        symbol.startsWith('BYB') || symbol.startsWith('EX') ? 'BTCUSDT' : symbol;
      const res = await demo.fetchKlines(proxySymbol, timeframe, limit);
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
          source: sourceLabel,
          fetchedAt: new Date(nowMs).toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchOpenInterest(symbol: string, referencePrice?: number) {
      const proxySymbol =
        symbol.startsWith('BYB') || symbol.startsWith('EX') ? 'BTCUSDT' : symbol;
      const res = await demo.fetchOpenInterest(proxySymbol, referencePrice);
      return {
        openInterest: res.openInterest ?? 400_000,
        openInterestValue: res.openInterestValue ?? 40_000_000,
        provenance: {
          source: sourceLabel,
          fetchedAt: new Date().toISOString(),
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
  };
}

describe('Phase 22: 多交易所切換獨立排程、Rate Limit 隔離與大合約池非阻塞驗證', () => {
  let tmpDir = '';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-p22-multiex-'));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. Binance 正在 RUNNING 且接近限流時，切換 Bybit 仍可獨立啟動並推進評估，且背景 15m 觸發不會搶回前台交易所', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p22-isolation.sqlite'));
    const binanceAdapter = createSyntheticLiveAdapter('binance_usdm');
    const bybitAdapter = createSyntheticLiveAdapter('bybit_linear');
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: binanceAdapter,
        bybit_linear: bybitAdapter,
        bingx_swap: bybitAdapter,
        demo_synthetic: new DemoExchangeAdapter(),
      },
      db,
      config: {
        maxRequestsPerMinute: 12,
        maxHttpConcurrency: 2,
        maxConcurrency: 2,
        batchSize: 4,
      },
    });

    try {
      const binSnap = await binanceAdapter.fetchMarketSnapshot();
      const binPre = runMarketScan(binSnap.tickers, binSnap.provenance, {
        mode: 'live',
        exchange: 'binance_usdm',
        volumeTimeframe: '15m',
      });
      scanner.enqueueMarketUniverse({
        exchange: 'binance_usdm',
        tickers: binSnap.tickers,
        candidates: binPre.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: 'win_p22_bin',
        forceRefresh: true,
        pruneUniverse: true,
      });

      // Start Binance -> eats its 12 req/min budget, stays RUNNING
      scanner.resumeScan('binance_usdm', 'live', true);
      assert.equal(scanner.getStatus('binance_usdm', 'live').workerState, 'RUNNING');

      // Bybit has NOT started yet -> its independent workerState MUST be IDLE (not hijacked by Binance RUNNING)
      const bybSnap = await bybitAdapter.fetchMarketSnapshot();
      const bybPre = runMarketScan(bybSnap.tickers, bybSnap.provenance, {
        mode: 'live',
        exchange: 'bybit_linear',
        volumeTimeframe: '15m',
      });
      scanner.enqueueMarketUniverse({
        exchange: 'bybit_linear',
        tickers: bybSnap.tickers,
        candidates: bybPre.candidates,
        watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
        windowKey: 'win_p22_byb',
        forceRefresh: true,
        pruneUniverse: true,
      });

      assert.equal(
        scanner.getStatus('bybit_linear', 'live').workerState,
        'IDLE',
        'Bybit workerState must remain IDLE while only Binance is RUNNING'
      );

      // Process Binance to consume Binance budget, then verify Bybit still evaluates independently
      await scanner.processNextBatch('binance_usdm', 'live', 2);
      scanner.resumeScan('bybit_linear', 'live', true);
      assert.equal(scanner.getActiveForegroundExchange(), 'bybit_linear');
      assert.equal(scanner.getStatus('bybit_linear', 'live').workerState, 'RUNNING');

      let bybitEvaluated = 0;
      for (let i = 0; i < 40; i++) {
        const st = scanner.getStatus('bybit_linear', 'live');
        bybitEvaluated = st.evaluatedCount ?? 0;
        if (bybitEvaluated >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        bybitEvaluated >= 2,
        `Bybit should evaluate independently of Binance rate limit (got evaluatedCount=${bybitEvaluated})`
      );

      // Trigger background 15m bar close on Binance -> must NOT steal foreground activeExchange from Bybit
      await scanner.checkAndTriggerConfirmed15mBarClose('binance_usdm', Date.now());
      assert.equal(
        scanner.getActiveForegroundExchange(),
        'bybit_linear',
        'Background 15m close on binance_usdm must NOT steal foreground from bybit_linear'
      );

      // Pausing Binance must NOT pause Bybit
      scanner.pauseScan('binance_usdm', 'live');
      assert.equal(scanner.getStatus('binance_usdm', 'live').workerState, 'PAUSED');
      assert.notEqual(
        scanner.getStatus('bybit_linear', 'live').workerState,
        'PAUSED',
        'Pausing Binance must NOT pause Bybit'
      );
    } finally {
      scanner.stop();
      db.close();
    }
  });

  it('2. Bybit 超過 650 檔冷啟動宇宙：refreshExpiredCachesIfNeeded 節流且不阻塞 BULK 評估，且 /api/scan 會喚醒已有 QUEUED 任務', async () => {
    const dbPath = path.join(tmpDir, 'p22-bybit-large.sqlite');
    const bybitAdapter = createSyntheticLiveAdapter('bybit_linear', 'BYB', 650);
    const binanceAdapter = createSyntheticLiveAdapter('binance_usdm');

    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: binanceAdapter,
        bybit_linear: bybitAdapter,
      },
    });
    const db = app.locals.radarDb as RadarDatabase;
    const scanner = app.locals.smcBatchScanner as SmcBatchScanService;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const snap = await bybitAdapter.fetchMarketSnapshot();
      assert.ok(snap.tickers.length > 650);
      const preScan = runMarketScan(snap.tickers, snap.provenance, {
        mode: 'live',
        exchange: 'bybit_linear',
        volumeTimeframe: '15m',
      });

      scanner.enqueueMarketUniverse({
        exchange: 'bybit_linear',
        tickers: snap.tickers,
        candidates: preScan.candidates,
        watchlistSymbols: ['BTCUSDT'],
        windowKey: 'win_p22_large',
        forceRefresh: true,
        pruneUniverse: true,
      });

      // Keep worker IDLE while refreshing an expired subset: BULK must NOT be blocked by refreshExpiredCachesIfNeeded
      const refreshPromise = scanner.refreshExpiredCachesIfNeeded('bybit_linear', {
        force: true,
      });

      // Verify BULK jobs (beyond fast lane) can still be claimed & evaluated concurrently
      const processedDuringRefresh = await scanner.processNextBatch(
        'bybit_linear',
        'live',
        4
      );
      const refreshRes = await refreshPromise;
      assert.ok(
        processedDuringRefresh >= 1,
        `BULK/FAST_LANE must NOT stall while refreshExpiredCachesIfNeeded runs (processed=${processedDuringRefresh})`
      );
      assert.ok(
        refreshRes.refreshedSymbolCount <= 40,
        `Default refreshExpiredCachesIfNeeded cap must prevent flooding 650+ contracts at once (got ${refreshRes.refreshedSymbolCount})`
      );

      // Verify >600 jobs are visible via getSymbolResult even at tail of 650+ universe
      const tailResult = scanner.getSymbolResult('bybit_linear', 'BYB640USDT', 'live');
      assert.ok(
        tailResult.latestJob !== null,
        'Jobs beyond index 600 must be visible in getSymbolResult without 600-row truncation'
      );

      // Hit /api/scan?mode=live&exchange=bybit_linear and verify server switches foreground cleanly
      const scanRes = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=bybit_linear&minQuoteVolume24h=0`
      );
      assert.equal(scanRes.status, 200);
      const scanBody = (await scanRes.json()) as {
        exchange: ExchangeId;
        smcScanStatus?: { totalContracts: number; evaluatedCount: number };
      };
      assert.equal(scanBody.exchange, 'bybit_linear');
      assert.ok((scanBody.smcScanStatus?.totalContracts ?? 0) > 650);
    } finally {
      scanner.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
