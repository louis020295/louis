/**
 * Self-hosted Express test server so HTTP integration tests do not depend on a
 * pre-started process at 127.0.0.1:3000. Paper-only: skipViteMiddleware leaves
 * background SMC / paper / backtest auto-start off.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DemoExchangeAdapter,
  ExchangeAdapter,
} from '../../server/adapters/ExchangeAdapter.ts';
import { createApp, type CreateAppOptions } from '../../server.ts';
import type { ExchangeId, Timeframe } from '../../src/types/market.ts';

export interface LocalTestServer {
  baseUrl: string;
  dbPath: string;
  close: () => Promise<void>;
}

/** Demo kline/ticker data labeled as a live (non-demo) adapter — no live exchange HTTP. */
export function createMockLiveAdapter(
  exchange: ExchangeId = 'binance_usdm'
): ExchangeAdapter {
  const demo = new DemoExchangeAdapter();
  return {
    id: exchange,
    displayName: `Mock ${exchange} Live USD-M`,
    enabled: true,
    isDemo: false,
    status: 'LIVE',
    async fetchMarketSnapshot() {
      const snap = await demo.fetchMarketSnapshot();
      const nowIso = new Date().toISOString();
      const liveProvenance = {
        source: 'Mock Live REST',
        fetchedAt: nowIso,
        stale: false,
        fallback: false,
        missingData: [] as string[],
        isDemo: false,
      };
      return {
        tickers: snap.tickers.map((t) => ({
          ...t,
          exchange,
          provenance: { ...liveProvenance },
        })),
        provenance: { ...liveProvenance },
      };
    },
    async fetchKlines(symbol: string, timeframe: Timeframe, limit = 60) {
      const res = await demo.fetchKlines(symbol, timeframe, limit);
      const nowIso = new Date().toISOString();
      return {
        klines: res.klines,
        provenance: {
          source: 'Mock Live Klines REST',
          fetchedAt: nowIso,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      };
    },
    async fetchOpenInterest(symbol: string, referencePrice?: number) {
      const res = await demo.fetchOpenInterest(symbol, referencePrice);
      const nowIso = new Date().toISOString();
      return {
        openInterest: res.openInterest,
        openInterestValue: res.openInterestValue,
        provenance: {
          source: 'Mock Live OI REST',
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

export function createMockLiveAdapters(): Partial<
  Record<ExchangeId, ExchangeAdapter>
> {
  return {
    binance_usdm: createMockLiveAdapter('binance_usdm'),
    bybit_linear: createMockLiveAdapter('bybit_linear'),
    bingx_swap: createMockLiveAdapter('bingx_swap'),
    demo_synthetic: new DemoExchangeAdapter(),
  };
}

export async function startLocalTestServer(
  options: CreateAppOptions = {}
): Promise<LocalTestServer> {
  const tmpDir = options.customDbPath
    ? path.dirname(options.customDbPath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'radar-http-test-'));
  const dbPath = options.customDbPath ?? path.join(tmpDir, 'radar.sqlite');

  const app = await createApp({
    customAdapters: options.customAdapters ?? createMockLiveAdapters(),
    ...options,
    customDbPath: dbPath,
    skipViteMiddleware: true,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    dbPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      try {
        app.locals.radarDb?.close?.();
      } catch {
        // already closed
      }
    },
  };
}
