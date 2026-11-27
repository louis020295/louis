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
  extraSymbolCount = 0,
  klineDelayMs = 0
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
        extraTickers.push({
          ...template,
          symbol: `P23X${String(i + 1).padStart(3, '0')}USDT`,
          quoteVolume24h: 25_000_000 + i * 1000,
          priceChangePercent24h: (i % 7) - 3,
        });
      }
      return {
        tickers: [...baseTickers, ...extraTickers],
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
      if (klineDelayMs > 0) {
        await new Promise((r) => setTimeout(r, klineDelayMs));
      }
      const proxySymbol = symbol.startsWith('P23X') ? 'BTCUSDT' : symbol;
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
      const proxySymbol = symbol.startsWith('P23X') ? 'BTCUSDT' : symbol;
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

describe('Phase 23: Compact Payloads、DB 健康檢查節流與 15m 非阻塞防假卡頓驗證', () => {
  let tmpDir = '';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-p23-perf-'));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. /api/scan?compact=1 與 /api/smc-scan/status?compact=1 精簡重欄位且預設端點保持完整契約', async () => {
    const dbPath = path.join(tmpDir, 'p23-compact.sqlite');
    const bybitAdapter = createSyntheticLiveAdapter('bybit_linear', 120);
    const binanceAdapter = createSyntheticLiveAdapter('binance_usdm');

    const app = await createApp({
      customDbPath: dbPath,
      skipViteMiddleware: true,
      customAdapters: {
        binance_usdm: binanceAdapter,
        bybit_linear: bybitAdapter,
      },
    });
    const scanner = app.locals.smcBatchScanner as SmcBatchScanService;
    const db = app.locals.radarDb as RadarDatabase;

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const fullRes = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=bybit_linear&minQuoteVolume24h=0`
      );
      assert.equal(fullRes.status, 200);
      const fullText = await fullRes.text();
      const fullJson = JSON.parse(fullText) as any;

      const compactRes = await fetch(
        `${baseUrl}/api/scan?mode=live&exchange=bybit_linear&minQuoteVolume24h=0&compact=1`
      );
      assert.equal(compactRes.status, 200);
      const compactText = await compactRes.text();
      const compactJson = JSON.parse(compactText) as any;

      assert.ok(
        compactJson.candidates.length === fullJson.candidates.length &&
          compactJson.candidates.length > 100,
        'compact=1 必須保留完整候選標的列數'
      );
      assert.ok(
        compactText.length < fullText.length,
        `compact=1 回應體積 (${compactText.length}) 必須明顯小於完整版 (${fullText.length})`
      );

      // Default full endpoint preserves decisionTrace & evidences & scoreBreakdown
      assert.ok(fullJson.candidates[0].decisionTrace, 'Full /api/scan keeps decisionTrace');
      assert.ok(Array.isArray(fullJson.candidates[0].evidences), 'Full /api/scan keeps evidences');
      assert.ok(fullJson.candidates[0].scoreBreakdown, 'Full /api/scan keeps scoreBreakdown');

      // Compact endpoint omits per-row heavy diagnostics & duplicate smcScanStatus funnels while preserving top-level diagnostics
      assert.equal(compactJson.candidates[0].decisionTrace, undefined);
      assert.equal(compactJson.candidates[0].evidences, undefined);
      assert.equal(compactJson.candidates[0].scoreBreakdown, undefined);
      assert.equal(compactJson.symbolFunnelDiagnostics, undefined);
      assert.ok(compactJson.smcGateDiagnostics, 'Top-level smcGateDiagnostics must stay intact');
      assert.ok(compactJson.scopedGateStatistics, 'Top-level scopedGateStatistics must stay intact');
      if (compactJson.smcScanStatus) {
        assert.deepEqual(compactJson.smcScanStatus.pendingSymbols, []);
        assert.deepEqual(compactJson.smcScanStatus.stuckJobs, []);
        assert.deepEqual(compactJson.smcScanStatus.recentJobs, []);
        assert.deepEqual(compactJson.smcScanStatus.slowestSymbolsTop20, []);
        assert.equal(compactJson.smcScanStatus.smcGateDiagnostics, undefined);
      }

      // Per-gate objects no longer duplicate excludedSymbols/excludedReasons 33x
      const allEvalGates = Object.values(
        compactJson.scopedGateStatistics?.allEvaluated ?? {}
      ) as any[];
      assert.ok(allEvalGates.length > 0, 'scopedGateStatistics.allEvaluated gates should exist');
      assert.equal(allEvalGates[0].excludedSymbols, undefined);
      assert.equal(allEvalGates[0].excludedReasons, undefined);

      // /api/smc-scan/status?compact=1 trims pendingSymbols/stuckJobs/recentJobs/slowestSymbolsTop20
      const compactStatusRes = await fetch(
        `${baseUrl}/api/smc-scan/status?mode=live&exchange=bybit_linear&compact=1`
      );
      assert.equal(compactStatusRes.status, 200);
      const compactStatusJson = (await compactStatusRes.json()) as any;
      assert.deepEqual(compactStatusJson.pendingSymbols, []);
      assert.deepEqual(compactStatusJson.stuckJobs, []);
      assert.deepEqual(compactStatusJson.recentJobs, []);
      assert.deepEqual(compactStatusJson.slowestSymbolsTop20, []);
      assert.deepEqual(compactStatusJson.excludedSymbols, []);
      assert.ok(typeof compactStatusJson.workerState === 'string');
      assert.ok(typeof compactStatusJson.totalContracts === 'number');
    } finally {
      scanner.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('2. performDatabaseHealthCheck 對唯讀輪詢快取 PRAGMA integrity_check 10 分鐘，runBackup: true 強制完整檢查並建立安全備份', () => {
    const dbPath = path.join(tmpDir, 'p23-health.sqlite');
    const db = new RadarDatabase(dbPath);
    let integrityCalls = 0;

    try {
      const origPrepare = (db as any).db.prepare.bind((db as any).db);
      (db as any).db.prepare = (sql: string) => {
        if (typeof sql === 'string' && sql.toUpperCase().includes('PRAGMA INTEGRITY_CHECK')) {
          integrityCalls += 1;
        }
        return origPrepare(sql);
      };

      const t0 = 1_700_000_000_000;
      const first = db.performDatabaseHealthCheck('binance_usdm', { nowMs: t0 });
      assert.equal(first.integrityCheck, 'ok');
      assert.equal(first.integrityCheckPassed, true);
      assert.equal(integrityCalls, 1, 'Initial health check must run PRAGMA integrity_check');

      // 20 seconds later (typical poll) -> MUST reuse cached 'ok' without hitting PRAGMA integrity_check
      const second = db.performDatabaseHealthCheck('binance_usdm', { nowMs: t0 + 20_000 });
      assert.equal(second.integrityCheck, 'ok');
      assert.equal(
        integrityCalls,
        1,
        'Read-only health poll within 10 minutes must NOT re-run synchronous PRAGMA integrity_check'
      );

      // Explicit manual check + backup -> MUST run full PRAGMA integrity_check and write backup
      const manual = db.performDatabaseHealthCheck('binance_usdm', {
        nowMs: t0 + 25_000,
        runBackup: true,
      });
      assert.equal(manual.integrityCheck, 'ok');
      assert.equal(integrityCalls, 2, 'Manual check with runBackup=true must run PRAGMA integrity_check');
      assert.ok(manual.backupFilePath, 'Backup path must be populated');
      assert.equal(manual.backupFileVerified, true, 'Backup file must be verified');
      assert.ok(fs.existsSync(manual.backupFilePath!), 'Backup file must exist on disk');

      // >10 minutes later -> read-only health check refreshes PRAGMA integrity_check
      const afterTtl = db.performDatabaseHealthCheck('binance_usdm', {
        nowMs: t0 + 25_000 + 601_000,
      });
      assert.equal(afterTtl.integrityCheck, 'ok');
      assert.equal(integrityCalls, 3, 'Health check after 10m TTL must run PRAGMA integrity_check');
    } finally {
      db.close();
    }
  });

  it('3. checkAndTriggerConfirmed15mBarClose 非阻塞快速回傳並喚醒 worker，進行中時不誤判 QUEUE_NOT_STARTED', async () => {
    const db = new RadarDatabase(path.join(tmpDir, 'p23-15m.sqlite'));
    // Deliberately inject 80ms kline latency so synchronous evaluation would take seconds if not deferred
    const binanceAdapter = createSyntheticLiveAdapter('binance_usdm', 40, 80);
    const scanner = new SmcBatchScanService({
      adapters: {
        binance_usdm: binanceAdapter,
        bybit_linear: binanceAdapter,
        bingx_swap: binanceAdapter,
        demo_synthetic: new DemoExchangeAdapter(),
      },
      db,
      config: {
        maxRequestsPerMinute: 120,
        maxHttpConcurrency: 2,
        maxConcurrency: 2,
        batchSize: 4,
      },
    });

    try {
      const bar15mMs = 15 * 60 * 1000;
      const currentBarOpenMs = Math.floor(Date.now() / bar15mMs) * bar15mMs;
      const triggerNowMs = currentBarOpenMs + 10_000;

      const tStart = Date.now();
      const triggered = await scanner.checkAndTriggerConfirmed15mBarClose(
        'binance_usdm',
        triggerNowMs
      );
      const elapsedMs = Date.now() - tStart;

      assert.equal(triggered, true);
      assert.ok(
        elapsedMs < 1500,
        `checkAndTriggerConfirmed15mBarClose must return non-blockingly (<1500ms), took ${elapsedMs}ms`
      );

      // Immediately after triggering, loop is scheduled/active -> must NOT emit QUEUE_NOT_STARTED
      const status = scanner.getStatus('binance_usdm', 'live');
      assert.equal(status.workerState, 'RUNNING');
      assert.equal(
        status.stalledReasons?.includes('QUEUE_NOT_STARTED'),
        false,
        'Active loop/trigger must NOT emit false QUEUE_NOT_STARTED'
      );

      // Backdate pending job timestamps past stalledThresholdMs while 15m close trigger is in-flight
      // and workerState is temporarily IDLE -> public getProgressAndHealth MUST NOT emit QUEUE_NOT_STARTED
      const oldIso = new Date(Date.now() - 120_000).toISOString();
      (db as any).db
        .prepare(`UPDATE smc_scan_jobs SET requested_at = ?, queue_entered_at = ?, last_progress_at = ? WHERE exchange = ? AND status = 'QUEUED'`)
        .run(oldIso, oldIso, oldIso, 'binance_usdm');
      scanner.pauseScan('binance_usdm', 'live');
      (scanner as any).workerStateByExchange.set('binance_usdm', 'IDLE');
      (scanner as any).inFlight15mCloseTriggerByExchange.set('binance_usdm', true);

      const healthDuringTrigger = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        healthDuringTrigger.stalledReasons.includes('QUEUE_NOT_STARTED'),
        false,
        'inFlight15mCloseTriggerByExchange=true must suppress false QUEUE_NOT_STARTED during brief IDLE transition'
      );

      // Once trigger flag clears while worker remains IDLE with aged pending jobs, QUEUE_NOT_STARTED IS genuinely reported
      (scanner as any).inFlight15mCloseTriggerByExchange.set('binance_usdm', false);
      const healthWhenTrulyIdle = scanner.getProgressAndHealth('binance_usdm', 'live');
      assert.equal(
        healthWhenTrulyIdle.stalledReasons.includes('QUEUE_NOT_STARTED'),
        true,
        'Genuinely idle queue with aged pending jobs and no active trigger/loop should report QUEUE_NOT_STARTED'
      );
    } finally {
      scanner.stop();
      db.close();
    }
  });
});
