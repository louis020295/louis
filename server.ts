import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  BinanceFuturesAdapter,
  BingXFuturesAdapter,
  buildDemoHistoricalVolumeMap,
  BybitFuturesAdapter,
  DemoExchangeAdapter,
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from './server/adapters/ExchangeAdapter.ts';
import {
  NotificationGuardEngine,
  TelegramNotificationAdapter,
  TradingViewWebhookAdapter,
} from './server/adapters/NotificationAdapter.ts';
import { BacktestDatabase } from './server/db/BacktestDatabase.ts';
import { PaperMonitorDatabase } from './server/db/PaperMonitorDatabase.ts';
import { RadarDatabase } from './server/db/RadarDatabase.ts';
import { BacktestEngine } from './server/engine/BacktestEngine.ts';
import {
  evaluateCrossExchangeDivergence,
  VenueSnapshotInput,
} from './server/engine/CrossExchangeDivergenceEngine.ts';
import {
  BTC_BENCHMARK_SYMBOL,
  computeBtcCorrelationAnalysis,
  computeBtcCorrelationSummary,
  evaluateBtcMarketRegime,
} from './server/engine/BtcCorrelationEngine.ts';
import { computeDerivativesStructure } from './server/engine/DerivativesStructureEngine.ts';
import { computeKeyLevelsAndSession } from './server/engine/KeyLevelsSessionEngine.ts';
import { computeMarketMicrostructure } from './server/engine/MicrostructureEngine.ts';
import {
  classifySymbolSector,
  computeMarketBreadthAndSectors,
} from './server/engine/SectorBreadthEngine.ts';
import {
  DEFAULT_SCANNER_CONFIG,
  MARKET_SCAN_RULE_VERSION,
  runMarketScan,
} from './server/engine/MarketScanner.ts';
import {
  computeEntryZoneAnalysis,
  evaluateSmcStructure,
  normalizeSmcRuleProfile,
} from './server/engine/SmcRuleEngine.ts';
import { classifyTradeHorizon } from './server/engine/TradeHorizonClassifier.ts';
import {
  evaluateHistoricalVolumeAnomaly,
  MAX_SANE_ROBUST_ZSCORE,
} from './server/engine/VolumeAnomalyEngine.ts';
import { AutoBacktestScheduler } from './server/services/AutoBacktestScheduler.ts';
import { BackgroundScannerScheduler } from './server/services/BackgroundScannerScheduler.ts';
import { BacktestService } from './server/services/BacktestService.ts';
import {
  ExternalEnvCredentials,
  ExternalNotificationService,
  FetchLike,
} from './server/services/ExternalNotificationService.ts';
import { generateGeminiExplanation } from './server/services/GeminiExplainService.ts';
import { PaperShadowMonitor } from './server/services/PaperShadowMonitor.ts';
import { PositionSentinelService } from './server/services/PositionSentinelService.ts';
import { SignalOutcomeTracker } from './server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from './server/services/SmcBatchScanService.ts';
import { SystemWatchdogService } from './server/services/SystemWatchdogService.ts';
import {
  DecisionTraceApiResponse,
  EvaluationAggregationMode,
  ExchangeId,
  ExternalNotificationChannel,
  FullMarketGateStatistics,
  GeminiExplainRequest,
  HistoricalVolumeMetrics,
  Kline,
  NotificationOutboxChannel,
  NotificationPayload,
  PaperFillStatus,
  PaperMonitorReportWindow,
  PaperQualityWindow,
  PaperStrategyTrack,
  PortfolioBacktestResult,
  PortfolioRiskConfig,
  ScanCategory,
  ScannedCandidate,
  SmcActionState,
  SmcAnalysisResult,
  SmcEvaluationStatus,
  SmcRuleProfile,
  SmcScanQueueConfig,
  SymbolDetailResponse,
  Timeframe,
  TradingCostConfig,
  TRADING_SAFETY_FLAGS,
  ValidationReadinessCriterion,
  ValidationReadinessResponse,
  WatchdogConfig,
} from './src/types/market.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CreateAppOptions {
  customAdapters?: Partial<Record<ExchangeId, ExchangeAdapter>>;
  customGeminiCaller?: (prompt: string) => Promise<string>;
  customDbPath?: string;
  skipViteMiddleware?: boolean;
  smcQueueConfig?: Partial<SmcScanQueueConfig>;
  customExternalFetch?: FetchLike;
  customExternalEnv?: () => ExternalEnvCredentials;
}

export interface RegisteredRouteInfo {
  method: string;
  path: string;
}

export function getRegisteredRoutes(
  app: express.Application
): RegisteredRouteInfo[] {
  const routes: RegisteredRouteInfo[] = [];
  const stack = (app as unknown as {
    _router?: {
      stack?: Array<{
        route?: { path?: string; methods?: Record<string, boolean> };
      }>;
    };
  })._router?.stack || [];

  for (const layer of stack) {
    if (layer.route && layer.route.path && layer.route.methods) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route!.methods![m])
        .map((m) => m.toUpperCase());
      for (const method of methods) {
        routes.push({ method, path: layer.route.path });
      }
    }
  }
  return routes;
}

export async function createApp(options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const db = new RadarDatabase(options.customDbPath);

  const adapters: Record<ExchangeId, ExchangeAdapter> = {
    binance_usdm:
      options.customAdapters?.binance_usdm ?? new BinanceFuturesAdapter(),
    bybit_linear:
      options.customAdapters?.bybit_linear ?? new BybitFuturesAdapter(),
    bingx_swap: options.customAdapters?.bingx_swap ?? new BingXFuturesAdapter(),
    demo_synthetic:
      options.customAdapters?.demo_synthetic ?? new DemoExchangeAdapter(),
  };

  type CachedSmcMapEntry = Pick<
    SmcAnalysisResult,
    'actionState' | 'waitReasons'
  > &
    Partial<Pick<SmcAnalysisResult, 'smcEvaluationStatus'>> & {
      evaluationStatus?: SmcEvaluationStatus;
      evaluatedAt?: string | null;
      dataFetchedAt?: string | null;
    };

  const smcCacheByExchange = new Map<
    ExchangeId,
    Map<string, CachedSmcMapEntry>
  >();
  function getExchangeSmcMap(exchangeId: ExchangeId) {
    let map = smcCacheByExchange.get(exchangeId);
    if (!map) {
      map = new Map<string, CachedSmcMapEntry>();
      smcCacheByExchange.set(exchangeId, map);
    }
    // Sync from SQLite persisted smc_scan_results
    const persisted = db.getSmcScanResultsMap(exchangeId);
    for (const [sym, rec] of persisted.entries()) {
      map.set(sym, {
        smcEvaluationStatus: rec.smcEvaluationStatus,
        evaluationStatus: rec.smcEvaluationStatus,
        actionState: rec.smcActionState,
        waitReasons: rec.waitReasons,
        evaluatedAt: rec.evaluatedAt,
        dataFetchedAt: rec.dataFetchedAt,
      });
    }
    return map;
  }

  const notificationGuard = new NotificationGuardEngine();
  const telegramAdapter = new TelegramNotificationAdapter(notificationGuard);
  const tradingViewAdapter = new TradingViewWebhookAdapter(notificationGuard);
  const backtestEngine = new BacktestEngine();
  const backtestDb = new BacktestDatabase(db);
  const backtestService = new BacktestService({
    adapters,
    backtestDb,
    engine: backtestEngine,
  });

  let paperShadowMonitor: PaperShadowMonitor;

  const smcBatchScanner = new SmcBatchScanService({
    adapters,
    db,
    telegramDryRunAdapter: telegramAdapter,
    config: options.smcQueueConfig,
    onResultCallback: (exId, sym, analysis, rec) => {
      let map = smcCacheByExchange.get(exId);
      if (!map) {
        map = new Map<string, CachedSmcMapEntry>();
        smcCacheByExchange.set(exId, map);
      }
      map.set(sym, {
        smcEvaluationStatus: rec.smcEvaluationStatus,
        evaluationStatus: rec.smcEvaluationStatus,
        actionState: analysis.actionState,
        waitReasons: analysis.waitReasons,
        evaluatedAt: rec.evaluatedAt,
        dataFetchedAt: rec.dataFetchedAt,
      });
      if (paperShadowMonitor) {
        paperShadowMonitor.onSmcBatchResultEvaluated(exId, sym, analysis, rec);
      }
    },
  });

  const scheduler = new BackgroundScannerScheduler({
    adapters,
    db,
    telegramDryRunAdapter: telegramAdapter,
    intervalMs: 300_000,
  });

  const paperMonitorDb = new PaperMonitorDatabase(db);
  const signalOutcomeTracker = new SignalOutcomeTracker({
    paperMonitorDb,
  });
  paperShadowMonitor = new PaperShadowMonitor({
    radarDb: db,
    paperMonitorDb,
    outcomeTracker: signalOutcomeTracker,
    adapters,
    smcBatchScanner,
  });

  let latestLiveCandidates: ScannedCandidate[] = [];
  const externalNotificationService = new ExternalNotificationService({
    db,
    fetchImpl: options.customExternalFetch,
    envProvider: options.customExternalEnv,
  });
  const positionSentinel = new PositionSentinelService({
    db,
    adapters,
    externalNotificationService,
    disableWebSockets: Boolean(options.skipViteMiddleware || process.env.NODE_ENV === 'test'),
  });
  const autoBacktestScheduler = new AutoBacktestScheduler({
    db,
    backtestService,
    getLatestCandidatesFn: () => latestLiveCandidates,
    isExchangeBusyFn: (ex) => {
      const st = smcBatchScanner.getStatus(ex);
      return Boolean(st.runningCount > 0 && st.rateLimitedCount > 0);
    },
  });
  const systemWatchdog = new SystemWatchdogService({
    radarDb: db,
    smcScanner: smcBatchScanner,
    externalNotifications: externalNotificationService,
  });
  let latestPortfolioBacktestResult: PortfolioBacktestResult | null = null;

  function resolveAdapter(
    modeParam?: string,
    exchangeParam?: string
  ): {
    adapter: ExchangeAdapter;
    resolvedMode: 'live' | 'demo';
    exchangeId: ExchangeId;
  } {
    // Only return DemoExchangeAdapter if explicitly requested via mode=demo or exchange=demo_synthetic
    if (modeParam === 'demo' || exchangeParam === 'demo_synthetic') {
      return {
        adapter: adapters.demo_synthetic,
        resolvedMode: 'demo',
        exchangeId: 'demo_synthetic',
      };
    }
    if (exchangeParam && exchangeParam in adapters) {
      const exId = exchangeParam as ExchangeId;
      return {
        adapter: adapters[exId],
        resolvedMode: 'live',
        exchangeId: exId,
      };
    }
    return {
      adapter: adapters.binance_usdm,
      resolvedMode: 'live',
      exchangeId: 'binance_usdm',
    };
  }

  const recentLiveSnapshotCache = new Map<
    ExchangeId,
    {
      fetchedAtMs: number;
      snapshot: Awaited<ReturnType<ExchangeAdapter['fetchMarketSnapshot']>>;
    }
  >();
  const inFlightLiveSnapshotRequests = new Map<
    ExchangeId,
    Promise<Awaited<ReturnType<ExchangeAdapter['fetchMarketSnapshot']>>>
  >();
  const lastRecordedVolumeSnapshotKey = new Map<ExchangeId, string>();

  async function getOrFetchLiveSnapshot(
    adapter: ExchangeAdapter,
    exchangeId: ExchangeId,
    resolvedMode: 'live' | 'demo',
    maxAgeMs = 5000
  ) {
    if (resolvedMode === 'live' && maxAgeMs > 0) {
      const cached = recentLiveSnapshotCache.get(exchangeId);
      if (cached && Date.now() - cached.fetchedAtMs <= maxAgeMs) {
        return cached.snapshot;
      }
      const inFlight = inFlightLiveSnapshotRequests.get(exchangeId);
      if (inFlight) {
        return inFlight;
      }
    }
    const fetchPromise = adapter.fetchMarketSnapshot().then((snapshot) => {
      if (resolvedMode === 'live') {
        recentLiveSnapshotCache.set(exchangeId, {
          fetchedAtMs: Date.now(),
          snapshot,
        });
      }
      return snapshot;
    });
    if (resolvedMode === 'live') {
      inFlightLiveSnapshotRequests.set(exchangeId, fetchPromise);
    }
    try {
      return await fetchPromise;
    } finally {
      if (resolvedMode === 'live') {
        inFlightLiveSnapshotRequests.delete(exchangeId);
      }
    }
  }

  // Health & Safety Policy Endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      safety: TRADING_SAFETY_FLAGS,
      ruleVersion: MARKET_SCAN_RULE_VERSION,
      scannerConfig: DEFAULT_SCANNER_CONFIG,
      databasePath: db.dbPath,
      scheduler: scheduler.getStatus(),
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY &&
          process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
      supportedExchanges: Object.values(adapters).map((a) => ({
        id: a.id,
        displayName: a.displayName,
        enabled: a.enabled,
        isDemo: a.isDemo,
        status: a.status,
      })),
    });
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      safety: TRADING_SAFETY_FLAGS,
      databasePath: db.dbPath,
      watchdogRunning: systemWatchdog.getStatus().running,
    });
  });

  // 1. Full Market Scan Endpoint
  app.get('/api/scan', async (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchange =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const minVolumeRaw = Number(req.query.minQuoteVolume24h ?? 0);
    const minQuoteVolume24h = Number.isFinite(minVolumeRaw) ? minVolumeRaw : 0;

    const { adapter, resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchange
    );

    try {
      if (
        resolvedMode === 'live' &&
        req.headers['x-simulate-exchange-failure'] === '1'
      ) {
        throw new ExchangeApiUnavailableError(
          'Binance Futures REST API HTTP 503 Service Unavailable (Upstream Connection Failure)',
          adapter.displayName,
          503
        );
      }
      const radarStartMs = Date.now();
      const snapshot = await getOrFetchLiveSnapshot(
        adapter,
        exchangeId,
        resolvedMode,
        5000
      );

      // Record snapshot into SQLite historical_volume_samples collector (skip duplicate writes for the exact same cached snapshot)
      const snapshotKey = `${exchangeId}:${snapshot.provenance.fetchedAt}:${snapshot.tickers.length}`;
      if (
        resolvedMode === 'demo' ||
        lastRecordedVolumeSnapshotKey.get(exchangeId) !== snapshotKey
      ) {
        db.recordTickerVolumeSnapshot(exchangeId, snapshot.tickers);

        // Update any open paper trading ledger positions with latest prices
        const priceMap = new Map<string, number>();
        for (const t of snapshot.tickers) {
          priceMap.set(t.symbol, t.lastPrice);
        }
        db.updateOpenPaperEntriesWithPrices(exchangeId, priceMap);
        if (resolvedMode === 'live') {
          lastRecordedVolumeSnapshotKey.set(exchangeId, snapshotKey);
          smcBatchScanner.updateLatestMarketSnapshot(exchangeId, snapshot.tickers);
        }
      } else if (resolvedMode === 'live') {
        smcBatchScanner.updateLatestMarketSnapshot(exchangeId, snapshot.tickers);
      }

      let historicalVolumeMap =
        resolvedMode === 'demo'
          ? buildDemoHistoricalVolumeMap()
          : db.getBulkHistoricalVolumeMap(exchangeId, 40, '15m');

      const currentQueueStats = db.getSmcScanQueueStats(exchangeId);
      const monitorWindowCompleted =
        paperShadowMonitor.getWindowStatusLight() === 'COMPLETED' &&
        currentQueueStats.evaluatedCount >= 400;
      const shouldPreserveLiveCycleSnapshot =
        resolvedMode === 'live' &&
        !options.skipViteMiddleware &&
        process.env.NODE_ENV !== 'test' &&
        currentQueueStats.totalJobs > 0 &&
        req.query.forceRefreshSmc !== 'true';

      const needPreScan =
        resolvedMode === 'demo' ||
        (!monitorWindowCompleted && !shouldPreserveLiveCycleSnapshot) ||
        req.query.forceRefreshSmc === 'true';

      const preScan = needPreScan
        ? runMarketScan(snapshot.tickers, snapshot.provenance, {
            minQuoteVolume24h,
            mode: resolvedMode,
            exchange: exchangeId,
            volumeTimeframe: '15m',
            historicalVolumeMap,
          })
        : null;
      const radarScanDurationMs = Math.max(0, Date.now() - radarStartMs);
      const lastFullRadarScanAt = new Date().toISOString();

      if (resolvedMode === 'live') {
        smcBatchScanner.setActiveForegroundExchange(exchangeId, resolvedMode);
        smcBatchScanner.ensurePeriodicSyncForExchange(exchangeId);
      } else {
        smcBatchScanner.setActiveForegroundExchange('demo_synthetic', 'demo');
      }

      if (
        preScan &&
        ((!monitorWindowCompleted && !shouldPreserveLiveCycleSnapshot) ||
          req.query.forceRefreshSmc === 'true')
      ) {
        smcBatchScanner.enqueueMarketUniverse({
          exchange: exchangeId,
          tickers: snapshot.tickers,
          candidates: preScan.candidates,
          pruneUniverse: minQuoteVolume24h <= 0,
          radarScanDurationMs,
          lastFullRadarScanAt,
        });
      }

      if (
        resolvedMode === 'live' &&
        !options.skipViteMiddleware &&
        process.env.NODE_ENV !== 'test' &&
        req.query.autoStartSmc !== 'false'
      ) {
        const postEnqueueQueueStats = preScan
          ? db.getSmcScanQueueStats(exchangeId)
          : currentQueueStats;
        const currentExWorkerState = smcBatchScanner.getWorkerState(exchangeId);
        const hasPendingWork =
          postEnqueueQueueStats.queuedCount > 0 ||
          postEnqueueQueueStats.rateLimitedCount > 0 ||
          (postEnqueueQueueStats.pendingCount > 0 &&
            postEnqueueQueueStats.runningJobCount === 0);
        if (
          currentExWorkerState !== 'PAUSED' &&
          hasPendingWork &&
          (currentExWorkerState === 'IDLE' ||
            !smcBatchScanner.isExchangeLoopActive(exchangeId))
        ) {
          smcBatchScanner.resumeScanLoopOnly(exchangeId, resolvedMode, {
            delayMs: 250,
          });
        }
      }

      const demoKlinesMap = new Map<string, Partial<Record<Timeframe, Kline[]>>>();

      if (resolvedMode === 'demo' && preScan) {
        for (const t of snapshot.tickers) {
          const preCandidate = preScan.candidates.find(
            (c) => c.symbol === t.symbol
          );
          const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
            adapter.fetchOpenInterest(t.symbol, t.lastPrice),
            adapter.fetchKlines(t.symbol, '5m', 90),
            adapter.fetchKlines(t.symbol, '15m', 90),
            adapter.fetchKlines(t.symbol, '1h', 90),
            adapter.fetchKlines(t.symbol, '4h', 90),
          ]);
          demoKlinesMap.set(t.symbol, {
            '15m': k15m.klines,
            '1h': k1h.klines,
          });
          const series15m = historicalVolumeMap.get(t.symbol) ?? [];
          const current15mVol =
            t.latestConfirmed15mQuoteVolume ??
            (series15m.length >= 31
              ? series15m[series15m.length - 1]
              : null);
          const baseline15mVols =
            series15m.length >= 31 ? series15m.slice(0, -1) : series15m;

          const histVol =
            preCandidate?.historicalVolume ??
            evaluateHistoricalVolumeAnomaly({
              symbol: t.symbol,
              exchange: exchangeId,
              currentVolume: current15mVol,
              historicalVolumes: baseline15mVols,
              volumeTimeframe: '15m',
              baseProvenance: t.provenance,
            });
          const smcRes = evaluateSmcStructure({
            symbol: t.symbol,
            primaryTimeframe: '15m',
            klinesByTimeframe: {
              '5m': k5m.klines,
              '15m': k15m.klines,
              '1h': k1h.klines,
              '4h': k4h.klines,
            },
            openInterest: oiRes.openInterest,
            historicalVolume: histVol,
            isLowLiquidity:
              preCandidate?.isLowLiquidity ?? t.quoteVolume24h < 15_000_000,
            extremeFunding:
              preCandidate?.extremeFunding ??
              (t.fundingRate !== null && Math.abs(t.fundingRate) >= 0.0005),
            lowLiquidityHighVolatility:
              preCandidate?.lowLiquidityHighVolatility ?? false,
            requireFullMultiTimeframe: true,
            provenance: t.provenance,
          });
          const evaluatedAt = new Date().toISOString();
          const finalSignal =
            smcRes.actionState === 'LONG CANDIDATE' &&
            preCandidate?.marketRadarCategory === '雷達多頭觀察' &&
            !preCandidate.isLowLiquidity &&
            !preCandidate.extremeFunding &&
            histVol.status === 'READY'
              ? '多頭交易候選'
              : smcRes.actionState === 'SHORT CANDIDATE' &&
                  preCandidate?.marketRadarCategory === '雷達空頭觀察' &&
                  !preCandidate.isLowLiquidity &&
                  !preCandidate.extremeFunding &&
                  histVol.status === 'READY'
                ? '空頭交易候選'
                : 'NONE';
          db.saveSmcScanResult({
            symbol: t.symbol,
            exchange: exchangeId,
            smcEvaluationStatus: smcRes.smcEvaluationStatus,
            smcActionState: smcRes.actionState,
            finalTradeSignal: finalSignal,
            marketRadarCategory: preCandidate?.marketRadarCategory ?? '準備觀察',
            evaluatedAt,
            dataFetchedAt: t.provenance.fetchedAt,
            stale: t.provenance.stale,
            fallback: t.provenance.fallback,
            missingData: t.provenance.missingData,
            source: t.provenance.source,
            isDemo: true,
            ruleVersion: smcRes.ruleVersion,
            waitReasons: smcRes.waitReasons,
            smcAnalysis: smcRes,
          });
        }
      }

      // Take ONE atomic SQLite snapshot for both runMarketScan and smcScanStatus
      const { smcMap: atomicSmcMap, status: atomicSmcStatus } =
        smcBatchScanner.getConsistentSmcScanState(exchangeId, resolvedMode);

      if (
        resolvedMode === 'live' &&
        req.query.autoStartSmc !== 'false' &&
        atomicSmcStatus.workerState !== 'PAUSED' &&
        (req.query.refreshExpiredCache === 'true' ||
          (!options.skipViteMiddleware &&
            process.env.NODE_ENV !== 'test' &&
            ((atomicSmcStatus.expiredCacheCount ?? 0) > 0 ||
              (atomicSmcStatus.staleCacheCount ?? 0) > 0 ||
              (atomicSmcStatus.prewarmRequiredCount ?? 0) > 0)))
      ) {
        const forceCacheRefresh = req.query.refreshExpiredCache === 'true';
        setTimeout(() => {
          void smcBatchScanner
            .refreshExpiredCachesIfNeeded(exchangeId, {
              maxSymbolsPerRun: 40,
              force: forceCacheRefresh,
            })
            .catch(() => {});
        }, 250);
      }

      const cachedKlinesMap =
        resolvedMode === 'demo'
          ? demoKlinesMap
          : db.getBulkCachedClosedKlinesMap(exchangeId, ['15m', '1h'], 55);
      const btcK15 = cachedKlinesMap.get(BTC_BENCHMARK_SYMBOL)?.['15m'] ?? [];
      const btcK1h = cachedKlinesMap.get(BTC_BENCHMARK_SYMBOL)?.['1h'] ?? [];

      const scanResult = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap,
        smcMap: atomicSmcMap,
        btcKlines15m: btcK15,
        btcKlines1h: btcK1h,
      });

      if (minQuoteVolume24h <= 0) {
        scanResult.smcPendingCount = atomicSmcStatus.pendingCount;
        scanResult.marketStats.smcPendingCount = atomicSmcStatus.pendingCount;
        scanResult.dataQuality.smcPendingCount = atomicSmcStatus.pendingCount;
        scanResult.smcStateCounts.PENDING = atomicSmcStatus.pendingCount;
      }

      scanResult.scanRunId = atomicSmcStatus.scanRunId;
      scanResult.scanCycleId = atomicSmcStatus.scanCycleId;
      scanResult.cycleId = atomicSmcStatus.cycleId;
      scanResult.cycleStatus = atomicSmcStatus.cycleStatus;
      scanResult.fullUniverseStatus = atomicSmcStatus.fullUniverseStatus;
      scanResult.cycleStartedAt = atomicSmcStatus.cycleStartedAt;
      scanResult.cycleCompletedAt = atomicSmcStatus.cycleCompletedAt;
      scanResult.lastCompletedCycleId = atomicSmcStatus.lastCompletedCycleId;
      scanResult.lastCompletedCycleDuration =
        atomicSmcStatus.lastCompletedCycleDuration;
      scanResult.statsConsistency = atomicSmcStatus.statsConsistency;
      scanResult.snapshotConsistency = 'INDEPENDENT_ENDPOINT_SNAPSHOT';
      scanResult.databaseInstanceId = atomicSmcStatus.databaseInstanceId;
      scanResult.snapshotAt = atomicSmcStatus.snapshotAt;
      scanResult.statsVersion = atomicSmcStatus.statsVersion;
      scanResult.totalSymbols = atomicSmcStatus.totalSymbols;
      scanResult.totalJobs = atomicSmcStatus.totalJobs;
      scanResult.evaluatedCount = atomicSmcStatus.evaluatedCount;
      scanResult.pendingCount = atomicSmcStatus.pendingCount;
      scanResult.queuedCount = atomicSmcStatus.queuedCount;
      scanResult.runningJobCount = atomicSmcStatus.runningJobCount;
      scanResult.failedCount = atomicSmcStatus.failedCount;
      scanResult.rateLimitedCount = atomicSmcStatus.rateLimitedCount;
      scanResult.waitCount = atomicSmcStatus.waitCount;
      scanResult.watchCount = atomicSmcStatus.watchCount;
      scanResult.highRiskCount = atomicSmcStatus.highRiskCount;
      scanResult.longCandidateCount = atomicSmcStatus.longCandidateCount;
      scanResult.shortCandidateCount = atomicSmcStatus.shortCandidateCount;
      scanResult.inFlightRequestCount = atomicSmcStatus.inFlightRequestCount;
      scanResult.totalExpectedHttpRequests =
        atomicSmcStatus.totalExpectedHttpRequests;
      scanResult.completedHttpRequests = atomicSmcStatus.completedHttpRequests;
      scanResult.remainingHttpRequests = atomicSmcStatus.remainingHttpRequests;
      scanResult.httpRequestsPerSymbol = atomicSmcStatus.httpRequestsPerSymbol;
      scanResult.httpEndpointsBreakdown =
        atomicSmcStatus.httpEndpointsBreakdown;
      scanResult.maxHttpConcurrency = atomicSmcStatus.maxHttpConcurrency;
      scanResult.maxRequestsPerMinute = atomicSmcStatus.maxRequestsPerMinute;
      scanResult.currentRequestsInWindow =
        atomicSmcStatus.currentRequestsInWindow;
      scanResult.rateLimitCount = atomicSmcStatus.rateLimitCount;
      scanResult.estimatedRemainingDuration =
        atomicSmcStatus.estimatedRemainingDuration;
      scanResult.estimateStatus = atomicSmcStatus.estimateStatus;
      scanResult.cacheCoverage = atomicSmcStatus.cacheCoverage;
      scanResult.cacheCoverageRate = atomicSmcStatus.cacheCoverageRate;
      scanResult.freshCacheCount = atomicSmcStatus.freshCacheCount;
      scanResult.expiredCacheCount = atomicSmcStatus.expiredCacheCount;
      scanResult.staleCacheCount = atomicSmcStatus.staleCacheCount;
      scanResult.cacheHitCount = atomicSmcStatus.cacheHitCount;
      scanResult.cacheMissCount = atomicSmcStatus.cacheMissCount;
      scanResult.prewarmRequiredCount = atomicSmcStatus.prewarmRequiredCount;
      scanResult['5mCoverage'] = atomicSmcStatus['5mCoverage'];
      scanResult['15mCoverage'] = atomicSmcStatus['15mCoverage'];
      scanResult['1hCoverage'] = atomicSmcStatus['1hCoverage'];
      scanResult['4hCoverage'] = atomicSmcStatus['4hCoverage'];
      scanResult['5mCacheCoverage'] = atomicSmcStatus['5mCacheCoverage'];
      scanResult['15mCacheCoverage'] = atomicSmcStatus['15mCacheCoverage'];
      scanResult['1hCacheCoverage'] = atomicSmcStatus['1hCacheCoverage'];
      scanResult['4hCacheCoverage'] = atomicSmcStatus['4hCacheCoverage'];
      scanResult.oiCacheCoverage = atomicSmcStatus.oiCacheCoverage;
      scanResult.fundingCacheCoverage = atomicSmcStatus.fundingCacheCoverage;
      scanResult.cacheStatus = atomicSmcStatus.cacheStatus;
      scanResult.cacheStatusLabel = atomicSmcStatus.cacheStatusLabel;
      scanResult.cacheMode = atomicSmcStatus.cacheMode;
      scanResult.cacheModeLabel = atomicSmcStatus.cacheModeLabel;
      scanResult.latestPrewarmSnapshot = atomicSmcStatus.latestPrewarmSnapshot;
      scanResult.prewarmTasks = atomicSmcStatus.prewarmTasks;
      scanResult.priorityDetectionSLA = atomicSmcStatus.priorityDetectionSLA;
      scanResult.warmCachePrioritySLA = atomicSmcStatus.warmCachePrioritySLA;
      scanResult.coldStartPrioritySLA = atomicSmcStatus.coldStartPrioritySLA;
      scanResult.fullUniverseCompletionDuration =
        atomicSmcStatus.fullUniverseCompletionDuration;
      scanResult.coldStartFullUniverseDuration =
        atomicSmcStatus.coldStartFullUniverseDuration;
      scanResult.warmFullUniverseDuration =
        atomicSmcStatus.warmFullUniverseDuration;
      scanResult.coldStartFullUniverseSLA =
        atomicSmcStatus.coldStartFullUniverseSLA;
      scanResult.smcScanStatus = atomicSmcStatus;

      if (resolvedMode === 'live') {
        scanResult.aggregationScope =
          atomicSmcStatus.aggregationScope ?? 'CURRENT_CYCLE';
        scanResult.evaluationUniverseSize =
          atomicSmcStatus.evaluationUniverseSize ?? atomicSmcStatus.totalSymbols;
        scanResult.evaluatedDenominator =
          atomicSmcStatus.evaluatedDenominator ?? atomicSmcStatus.evaluatedCount;
        scanResult.excludedCount =
          atomicSmcStatus.excludedCount ??
          Math.max(
            0,
            (atomicSmcStatus.totalSymbols ?? 0) -
              (atomicSmcStatus.evaluatedCount ?? 0)
          );
        scanResult.excludedSymbols = atomicSmcStatus.excludedSymbols ?? [];
        scanResult.excludedReasons = atomicSmcStatus.excludedReasons ?? {};
        scanResult.consistencyErrors = atomicSmcStatus.consistencyErrors ?? [];
        scanResult.candidateFunnel = atomicSmcStatus.candidateFunnel;
        scanResult.currentCycleFunnel = atomicSmcStatus.currentCycleFunnel;
        scanResult.latestSnapshotFunnel = atomicSmcStatus.latestSnapshotFunnel;
        scanResult.monitoringWindowFunnel =
          atomicSmcStatus.monitoringWindowFunnel;
        scanResult.cumulativeFunnel = atomicSmcStatus.cumulativeFunnel;
        scanResult.historicalSignalsOutsideCurrentCycle =
          atomicSmcStatus.historicalSignalsOutsideCurrentCycle;
        scanResult.historicalSignalsOutsideWindow =
          atomicSmcStatus.historicalSignalsOutsideWindow;
        scanResult.formalCandidateLatencySla =
          atomicSmcStatus.formalCandidateLatencySla;
        scanResult.DEMO_LATENCY_FIXTURE = atomicSmcStatus.DEMO_LATENCY_FIXTURE;
        scanResult.CONTROLLED_LIVE_FIXTURE =
          atomicSmcStatus.CONTROLLED_LIVE_FIXTURE;
        scanResult.LIVE_FORMAL_CANDIDATE_COUNT =
          atomicSmcStatus.LIVE_FORMAL_CANDIDATE_COUNT ?? 0;
        scanResult.LIVE_FAST_LANE_COUNT =
          atomicSmcStatus.LIVE_FAST_LANE_COUNT ?? 0;
        scanResult.LIVE_BULK_COUNT = atomicSmcStatus.LIVE_BULK_COUNT ?? 0;
        scanResult.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT =
          atomicSmcStatus.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT ?? 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_COUNT =
          atomicSmcStatus.LIVE_ENTRY_WINDOW_MISSED_COUNT ?? 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_RATE =
          atomicSmcStatus.LIVE_ENTRY_WINDOW_MISSED_RATE ?? null;
        scanResult.LIVE_DETECTION_LATENCY_P50 =
          atomicSmcStatus.LIVE_DETECTION_LATENCY_P50 ?? null;
        scanResult.LIVE_DETECTION_LATENCY_P95 =
          atomicSmcStatus.LIVE_DETECTION_LATENCY_P95 ?? null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P50 =
          atomicSmcStatus.LIVE_FAST_LANE_DETECTION_LATENCY_P50 ?? null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P95 =
          atomicSmcStatus.LIVE_FAST_LANE_DETECTION_LATENCY_P95 ?? null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P50 =
          atomicSmcStatus.LIVE_BULK_DETECTION_LATENCY_P50 ?? null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P95 =
          atomicSmcStatus.LIVE_BULK_DETECTION_LATENCY_P95 ?? null;
        scanResult.liveValidationStatus =
          atomicSmcStatus.liveValidationStatus ?? 'NO_LIVE_FORMAL_CANDIDATE';
        scanResult.liveSampleValidationStatus =
          atomicSmcStatus.liveSampleValidationStatus ??
          'LIVE_VALIDATION_INSUFFICIENT_SAMPLE';
        scanResult.liveValidationStates =
          atomicSmcStatus.liveValidationStates ?? [
            'NO_LIVE_FORMAL_CANDIDATE',
            'LIVE_VALIDATION_INSUFFICIENT_SAMPLE',
          ];
        scanResult.liveValidationMessage =
          atomicSmcStatus.liveValidationMessage ??
          '尚無真實 Live 候選，無法評估實盤捕捉延遲';
        scanResult.isLiveValidated = atomicSmcStatus.isLiveValidated ?? false;
        scanResult.signalQualityCalibration =
          atomicSmcStatus.signalQualityCalibration;
        scanResult.smcGateDiagnostics =
          atomicSmcStatus.smcGateDiagnostics ?? scanResult.smcGateDiagnostics;
        scanResult.scopedGateStatistics =
          atomicSmcStatus.scopedGateStatistics ??
          atomicSmcStatus.smcGateDiagnostics?.scopedGateStatistics ??
          scanResult.scopedGateStatistics;
        scanResult.observationShadowComparison =
          atomicSmcStatus.observationShadowComparison ??
          atomicSmcStatus.smcGateDiagnostics?.observationShadowComparison ??
          scanResult.observationShadowComparison;
        scanResult.paperEligibilityAudit =
          atomicSmcStatus.paperEligibilityAudit;
        scanResult.nearMissCount =
          atomicSmcStatus.nearMissCount ?? scanResult.nearMissCount;
        scanResult.nearMissMissing1Count =
          atomicSmcStatus.nearMissMissing1Count ??
          scanResult.nearMissMissing1Count;
        scanResult.nearMissMissing2Count =
          atomicSmcStatus.nearMissMissing2Count ??
          scanResult.nearMissMissing2Count;
        scanResult.nearMissMissingGates =
          atomicSmcStatus.nearMissMissingGates ??
          scanResult.nearMissMissingGates;
        scanResult.lastBlockingGate =
          atomicSmcStatus.lastBlockingGate ?? scanResult.lastBlockingGate;
        scanResult.blockedAfterSmcCandidateCount =
          atomicSmcStatus.blockedAfterSmcCandidateCount ??
          scanResult.blockedAfterSmcCandidateCount;
        scanResult.blockedAfterSmcCandidateReasons =
          atomicSmcStatus.blockedAfterSmcCandidateReasons ??
          scanResult.blockedAfterSmcCandidateReasons;
        scanResult.blockedByPaperEligibilityCount =
          atomicSmcStatus.blockedByPaperEligibilityCount;
        scanResult.blockedByPaperEligibilityReasons =
          atomicSmcStatus.blockedByPaperEligibilityReasons;
        scanResult.formalCandidateCount =
          atomicSmcStatus.formalCandidateCount ??
          atomicSmcStatus.candidateDetectedCount ??
          0;
        scanResult.fastLaneFormalCandidateCount =
          atomicSmcStatus.fastLaneFormalCandidateCount ?? 0;
        scanResult.bulkFormalCandidateCount =
          atomicSmcStatus.bulkFormalCandidateCount ?? 0;
        scanResult.candidateDetectedBeforeEntryWindowCount =
          atomicSmcStatus.candidateDetectedBeforeEntryWindowCount ?? 0;
        scanResult.entryWindowMissedRate =
          atomicSmcStatus.entryWindowMissedRate ?? null;
        scanResult.candidateDetectionLatencyP50 =
          atomicSmcStatus.candidateDetectionLatencyP50 ?? null;
        scanResult.candidateDetectionLatencyP95 =
          atomicSmcStatus.candidateDetectionLatencyP95 ?? null;
        scanResult.queueWaitP50 = atomicSmcStatus.queueWaitP50 ?? null;
        scanResult.queueWaitP95 = atomicSmcStatus.queueWaitP95 ?? null;
        scanResult.eligiblePaperSignalCount =
          atomicSmcStatus.eligiblePaperSignalCount;
        scanResult.currentCyclePaperEligibleCount =
          atomicSmcStatus.currentCyclePaperEligibleCount ??
          atomicSmcStatus.eligiblePaperSignalCount ??
          0;
        scanResult.monitoringWindowPaperEligibleCount =
          atomicSmcStatus.monitoringWindowPaperEligibleCount ?? 0;
        scanResult.cumulativePaperEligibleCount =
          atomicSmcStatus.cumulativePaperEligibleCount ?? 0;
        scanResult.historicalPaperEligibleCount =
          atomicSmcStatus.historicalPaperEligibleCount ?? 0;
        scanResult.entryWindowMissedCount =
          atomicSmcStatus.currentCycleEntryWindowMissedCount ??
          atomicSmcStatus.entryWindowMissedCount ??
          0;
        scanResult.currentCycleEntryWindowMissedCount =
          atomicSmcStatus.currentCycleEntryWindowMissedCount ??
          atomicSmcStatus.entryWindowMissedCount ??
          0;
        scanResult.monitoringWindowEntryWindowMissedCount =
          atomicSmcStatus.monitoringWindowEntryWindowMissedCount ?? 0;
        scanResult.cumulativeEntryWindowMissedCount =
          atomicSmcStatus.cumulativeEntryWindowMissedCount ?? 0;
        scanResult.historicalSignalsOutsideWindowCount =
          atomicSmcStatus.historicalSignalsOutsideWindowCount ?? 0;
        scanResult.historicalSignalsOutsideCurrentCycleCount =
          atomicSmcStatus.historicalSignalsOutsideCurrentCycleCount ?? 0;
        scanResult.paperOpenedCount = atomicSmcStatus.paperOpenedCount;
        scanResult.paperClosedCount = atomicSmcStatus.paperClosedCount ?? 0;
        scanResult.candidateDetectedCount =
          atomicSmcStatus.candidateDetectedCount;
        scanResult.rootCauseVerdict = atomicSmcStatus.rootCauseVerdict;
        scanResult.rootCauseExplanation = atomicSmcStatus.rootCauseExplanation;
      } else {
        const demoCandCount =
          scanResult.smcLongCandidateCount + scanResult.smcShortCandidateCount;
        scanResult.aggregationScope = 'CURRENT_CYCLE';
        scanResult.evaluationUniverseSize = scanResult.totalContractsScanned;
        scanResult.evaluatedDenominator =
          scanResult.totalContractsScanned - scanResult.smcPendingCount;
        scanResult.excludedCount = scanResult.smcPendingCount;
        scanResult.excludedSymbols = [];
        scanResult.excludedReasons = {};
        scanResult.consistencyErrors = [];
        scanResult.formalCandidateCount = demoCandCount;
        scanResult.fastLaneFormalCandidateCount =
          atomicSmcStatus.fastLaneFormalCandidateCount ?? demoCandCount;
        scanResult.bulkFormalCandidateCount =
          atomicSmcStatus.bulkFormalCandidateCount ?? 0;
        scanResult.candidateDetectedBeforeEntryWindowCount =
          atomicSmcStatus.candidateDetectedBeforeEntryWindowCount ??
          demoCandCount;
        scanResult.entryWindowMissedRate =
          atomicSmcStatus.entryWindowMissedRate ??
          (demoCandCount > 0 ? 0 : null);
        scanResult.candidateDetectionLatencyP50 =
          atomicSmcStatus.candidateDetectionLatencyP50 ?? null;
        scanResult.candidateDetectionLatencyP95 =
          atomicSmcStatus.candidateDetectionLatencyP95 ?? null;
        scanResult.queueWaitP50 = atomicSmcStatus.queueWaitP50 ?? null;
        scanResult.queueWaitP95 = atomicSmcStatus.queueWaitP95 ?? null;
        scanResult.DEMO_LATENCY_FIXTURE = atomicSmcStatus.DEMO_LATENCY_FIXTURE;
        scanResult.CONTROLLED_LIVE_FIXTURE =
          atomicSmcStatus.CONTROLLED_LIVE_FIXTURE;
        scanResult.LIVE_FORMAL_CANDIDATE_COUNT = 0;
        scanResult.LIVE_FAST_LANE_COUNT = 0;
        scanResult.LIVE_BULK_COUNT = 0;
        scanResult.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT = 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_COUNT = 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_RATE = null;
        scanResult.LIVE_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_DETECTION_LATENCY_P95 = null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P95 = null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P95 = null;
        scanResult.liveValidationStatus = 'NO_LIVE_FORMAL_CANDIDATE';
        scanResult.liveSampleValidationStatus =
          'LIVE_VALIDATION_INSUFFICIENT_SAMPLE';
        scanResult.liveValidationStates = [
          'NO_LIVE_FORMAL_CANDIDATE',
          'LIVE_VALIDATION_INSUFFICIENT_SAMPLE',
        ];
        scanResult.liveValidationMessage =
          '尚無真實 Live 候選，無法評估實盤捕捉延遲';
        scanResult.isLiveValidated = false;
        scanResult.candidateDetectedCount = demoCandCount;
        scanResult.eligiblePaperSignalCount = 0;
        scanResult.currentCyclePaperEligibleCount = 0;
        scanResult.monitoringWindowPaperEligibleCount = 0;
        scanResult.cumulativePaperEligibleCount = 0;
        scanResult.historicalPaperEligibleCount = 0;
        scanResult.entryWindowMissedCount = 0;
        scanResult.currentCycleEntryWindowMissedCount = 0;
        scanResult.monitoringWindowEntryWindowMissedCount = 0;
        scanResult.cumulativeEntryWindowMissedCount = 0;
        scanResult.historicalSignalsOutsideWindowCount = 0;
        scanResult.historicalSignalsOutsideCurrentCycleCount = 0;
        scanResult.paperOpenedCount = 0;
        scanResult.paperClosedCount = 0;
        scanResult.blockedByPaperEligibilityCount = demoCandCount;
        scanResult.blockedByPaperEligibilityReasons = {
          DEMO_MODE_ISOLATED_FROM_LIVE_PAPER: demoCandCount,
        };
        scanResult.currentCycleFunnel = atomicSmcStatus.currentCycleFunnel;
        scanResult.latestSnapshotFunnel = atomicSmcStatus.latestSnapshotFunnel;
        scanResult.monitoringWindowFunnel =
          atomicSmcStatus.monitoringWindowFunnel;
        scanResult.cumulativeFunnel = atomicSmcStatus.cumulativeFunnel;
        scanResult.historicalSignalsOutsideCurrentCycle =
          atomicSmcStatus.historicalSignalsOutsideCurrentCycle;
        scanResult.historicalSignalsOutsideWindow =
          atomicSmcStatus.historicalSignalsOutsideWindow;
        scanResult.formalCandidateLatencySla =
          atomicSmcStatus.formalCandidateLatencySla;
        scanResult.candidateFunnel = {
          cycleId: scanResult.cycleId ?? 'demo_cycle',
          snapshotAt: scanResult.snapshotAt ?? scanResult.fetchedAt,
          statsVersion: scanResult.statsVersion ?? 1,
          aggregationScope: 'CURRENT_CYCLE',
          evaluationUniverseSize: scanResult.totalContractsScanned,
          evaluatedDenominator:
            scanResult.totalContractsScanned - scanResult.smcPendingCount,
          excludedCount: scanResult.smcPendingCount,
          excludedSymbols: [],
          excludedReasons: {},
          statsConsistency: 'VALID',
          consistencyErrors: [],
          totalSymbols: scanResult.totalContractsScanned,
          radarLongCount: scanResult.marketRadarLongCount,
          radarShortCount: scanResult.marketRadarShortCount,
          smcEvaluatedCount:
            scanResult.totalContractsScanned - scanResult.smcPendingCount,
          smcPendingCount: scanResult.smcPendingCount,
          smcWaitCount: scanResult.smcWaitCount,
          smcWatchCount: scanResult.smcWatchCount,
          smcHighRiskCount: scanResult.smcHighRiskCount,
          smcLongCandidateCount: scanResult.smcLongCandidateCount,
          smcShortCandidateCount: scanResult.smcShortCandidateCount,
          formalCandidateCount: demoCandCount,
          blockedAfterSmcCandidateCount:
            scanResult.blockedAfterSmcCandidateCount ?? 0,
          blockedAfterSmcCandidateReasons:
            scanResult.blockedAfterSmcCandidateReasons ?? {},
          eligiblePaperSignalCount: 0,
          currentCyclePaperEligibleCount: 0,
          monitoringWindowPaperEligibleCount: 0,
          cumulativePaperEligibleCount: 0,
          historicalPaperEligibleCount: 0,
          blockedByPaperEligibilityCount: demoCandCount,
          blockedByPaperEligibilityReasons: {
            DEMO_MODE_ISOLATED_FROM_LIVE_PAPER: demoCandCount,
          },
          entryWindowMissedCount: 0,
          currentCycleEntryWindowMissedCount: 0,
          monitoringWindowEntryWindowMissedCount: 0,
          cumulativeEntryWindowMissedCount: 0,
          historicalSignalsOutsideWindowCount: 0,
          historicalSignalsOutsideCurrentCycleCount: 0,
          paperOpenedCount: 0,
          paperClosedCount: 0,
          stages: [
            {
              stage: 'marketRadarCategory -> smcActionState',
              inputCount: scanResult.totalContractsScanned,
              outputCount: demoCandCount,
              blockedCount: scanResult.totalContractsScanned - demoCandCount,
              blockedReasons: {
                WAIT: scanResult.smcWaitCount,
                WATCH: scanResult.smcWatchCount,
                HIGH_RISK: scanResult.smcHighRiskCount,
              },
            },
            {
              stage: 'smcActionState -> finalTradeSignal',
              inputCount: demoCandCount,
              outputCount: demoCandCount,
              blockedCount: scanResult.blockedAfterSmcCandidateCount ?? 0,
              blockedReasons: scanResult.blockedAfterSmcCandidateReasons ?? {},
            },
            {
              stage: 'finalTradeSignal -> Paper eligibility',
              inputCount: demoCandCount,
              outputCount: 0,
              blockedCount: demoCandCount,
              blockedReasons: {
                DEMO_MODE_ISOLATED_FROM_LIVE_PAPER: demoCandCount,
              },
            },
          ],
        };
      }

      // Attach informational BTC K-line overlap summary using preloaded cached/demo K-lines — zero extra HTTP calls
      for (const candidateItem of scanResult.candidates) {
        const symKlines = cachedKlinesMap.get(candidateItem.symbol);
        const hasCached =
          Boolean(symKlines?.['15m']?.length || symKlines?.['1h']?.length) &&
          Boolean(btcK15.length || btcK1h.length);
        candidateItem.btcCorrelation = computeBtcCorrelationSummary({
          symbol: candidateItem.symbol,
          symbolKlines15m: symKlines?.['15m'],
          symbolKlines1h: symKlines?.['1h'],
          btcKlines15m: btcK15,
          btcKlines1h: btcK1h,
          hasCachedData: hasCached,
        });
      }

      const { marketBreadth, sectorRotation } = computeMarketBreadthAndSectors(
        scanResult.candidates
      );
      scanResult.marketBreadth = marketBreadth;
      scanResult.sectorRotation = sectorRotation;

      if (resolvedMode === 'live' && !scanResult.isDemo) {
        latestLiveCandidates = scanResult.candidates;
        void externalNotificationService
          .dispatchCandidates({
            candidates: scanResult.candidates,
            mode: 'live',
            isDemo: false,
          })
          .catch(() => {
            // isolated external notification dispatch error
          });
      }

      const isCompact =
        req.query.compact === '1' || req.query.compact === 'true';
      if (isCompact) {
        const compactCandidates = scanResult.candidates.map((c) => ({
          symbol: c.symbol,
          baseAsset: c.baseAsset,
          quoteAsset: c.quoteAsset,
          lastPrice: c.lastPrice,
          priceChangePercent24h: c.priceChangePercent24h,
          quoteVolume24h: c.quoteVolume24h,
          fundingRate: c.fundingRate,
          relativeBtcStrength: c.relativeBtcStrength,
          score: c.score,
          scoreCapApplied: c.scoreCapApplied,
          marketRadarCategory: c.marketRadarCategory,
          category: c.category,
          finalTradeSignal: c.finalTradeSignal,
          smcEvaluationStatus: c.smcEvaluationStatus,
          smcActionState: c.smcActionState,
          smcStatusReason: c.smcStatusReason,
          nearMissStatus: c.nearMissStatus,
          isLowLiquidity: c.isLowLiquidity,
          extremeFunding: c.extremeFunding,
          isFastLane: c.isFastLane,
          intendedDirection: c.intendedDirection,
          blockedReason: c.blockedReason,
          provenance: c.provenance,
          sector: c.sector,
          historicalVolume: c.historicalVolume,
          btcCorrelation: c.btcCorrelation,
          earlyIgnition: c.earlyIgnition,
          entryZoneSummary: c.entryZoneSummary,
          tradeHorizon: c.tradeHorizon,
          missingGates: c.missingGates,
        }));
        const compactSmcStatus = scanResult.smcScanStatus
          ? {
              ...scanResult.smcScanStatus,
              pendingSymbols: [],
              stuckJobs: [],
              recentJobs: [],
              slowestSymbolsTop20: [],
              smcGateDiagnostics: undefined,
              scopedGateStatistics: undefined,
              observationShadowComparison: undefined,
              candidateFunnel: undefined,
              currentCycleFunnel: undefined,
              latestSnapshotFunnel: undefined,
              monitoringWindowFunnel: undefined,
              cumulativeFunnel: undefined,
              excludedSymbols: [],
            }
          : undefined;
        res.json({
          ...scanResult,
          symbolFunnelDiagnostics: undefined,
          candidates: compactCandidates,
          smcScanStatus: compactSmcStatus,
        });
        return;
      }

      res.json(scanResult);
    } catch (err) {
      const isUnavailable = err instanceof ExchangeApiUnavailableError;
      const errorMsg =
        err instanceof Error ? err.message : '外部交易所 API 連線失敗';
      const fetchedAt = new Date().toISOString();
      const sourceName = isUnavailable ? err.source : adapter.displayName;
      const missingData = ['ALL_MARKET_TICKERS'];

      const emptyStats: FullMarketGateStatistics = {
        totalContractsScanned: 0,
        insufficientHistoryCount: 0,
        baselineUnstableCount: 0,
        liquidityRejectedCount: 0,
        momentumPassedCount: 0,
        relativeBtcPassedCount: 0,
        marketRadarLongCount: 0,
        marketRadarShortCount: 0,
        smcPendingCount: 0,
        smcWaitCount: 0,
        smcWatchCount: 0,
        smcLongCandidateCount: 0,
        smcShortCandidateCount: 0,
        smcHighRiskCount: 0,
        smcGateNotConfirmedCount: 0,
        finalCategorySmcMismatchCount: 0,
      };

      db.recordPhase17ErrorEvent(exchangeId, {
        is503: true,
        errorMessage: errorMsg,
      });

      // Strictly return HTTP 503 with mode: "live", isDemo: false, fallback: false, candidates: [], apiError: "即時資料不可用"
      res.status(503).json({
        safety: TRADING_SAFETY_FLAGS,
        mode: 'live',
        exchange: exchangeId,
        isDemo: false,
        fallback: false,
        source: sourceName,
        fetchedAt,
        stale: false,
        missingData,
        ruleVersion: MARKET_SCAN_RULE_VERSION,
        btcBenchmarkChange24h: null,
        candidates: [],
        summaryCounts: {
          多頭候選: 0,
          空頭候選: 0,
          準備觀察: 0,
          高風險: 0,
        },
        marketRadarCounts: {
          雷達多頭觀察: 0,
          雷達空頭觀察: 0,
          準備觀察: 0,
          高風險: 0,
        },
        smcStateCounts: {
          PENDING: 0,
          WAIT: 0,
          WATCH: 0,
          'LONG CANDIDATE': 0,
          'SHORT CANDIDATE': 0,
          'HIGH RISK': 0,
        },
        waitWatchReasonBreakdown: {},
        waitWatchReasonStats: {
          scope: 'EVALUATED_WAIT_WATCH_ONLY',
          uniqueSymbolCount: 0,
          totalReasonOccurrences: 0,
          reasonOccurrenceCount: {},
          mutuallyExclusivePrimaryReasonCount: {},
        },
        highRiskReasonStats: {
          scope: 'EVALUATED_HIGH_RISK_ONLY',
          uniqueSymbolCount: 0,
          totalReasonOccurrences: 0,
          reasonOccurrenceCount: {},
          mutuallyExclusivePrimaryReasonCount: {},
        },
        nonCandidateReasonStats: {
          scope: 'EVALUATED_NON_CANDIDATE_ALL',
          uniqueSymbolCount: 0,
          totalReasonOccurrences: 0,
          reasonOccurrenceCount: {},
          mutuallyExclusivePrimaryReasonCount: {},
        },
        radarGateReasonStats: {
          scope: 'RADAR_GATE_REJECTED',
          uniqueSymbolCount: 0,
          totalReasonOccurrences: 0,
          reasonOccurrenceCount: {},
          mutuallyExclusivePrimaryReasonCount: {},
        },
        marketStats: emptyStats,
        ...emptyStats,
        dataQuality: {
          ...emptyStats,
          totalSymbolsScanned: 0,
          validSymbolsCount: 0,
          missingFundingCount: 0,
          missingSpreadCount: 0,
          staleRecordCount: 0,
          lowLiquidityCount: 0,
          extremeFundingCount: 0,
          historicalVolumeReadyCount: 0,
          scannerConfig: DEFAULT_SCANNER_CONFIG,
          volumeProxyNotice:
            '即時資料不可用：外部 API 失敗，禁止使用假資料冒充即時行情。',
          generatedAt: fetchedAt,
          source: sourceName,
          isDemo: false,
        },
        provenance: {
          source: sourceName,
          fetchedAt,
          stale: false,
          fallback: false,
          missingData,
          isDemo: false,
          volumeTimeframe: '15m',
          aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
          volumeMetric: 'quoteVolume',
        },
        apiError: '即時資料不可用',
        apiErrorDetail: errorMsg,
      });
    }
  });

  // 2A. Single Symbol Full Decision Trace Endpoint (GET /api/symbol/:symbol/decision-trace)
  app.get(
    '/api/symbol/:symbol/decision-trace',
    async (req: Request, res: Response) => {
      const symbol = (req.params.symbol || 'BTCUSDT').toUpperCase();
      const modeParam =
        typeof req.query.mode === 'string' ? req.query.mode : 'live';
      const exchange =
        typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
      const tfParam = (req.query.timeframe as Timeframe) || '15m';
      const validTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
      const primaryTimeframe: Timeframe = validTimeframes.includes(tfParam)
        ? tfParam
        : '15m';

      const { adapter, resolvedMode, exchangeId } = resolveAdapter(
        modeParam,
        exchange
      );

      try {
        const snapshot = await getOrFetchLiveSnapshot(
          adapter,
          exchangeId,
          resolvedMode,
          5000
        );
        const ticker = snapshot.tickers.find((t) => t.symbol === symbol);
        if (!ticker) {
          res.status(404).json({
            error: `找不到合約標的 ${symbol}`,
            safety: TRADING_SAFETY_FLAGS,
          });
          return;
        }

        const getCachedOrFetchTf = async (tf: Timeframe) => {
          if (resolvedMode === 'live' && req.query.refresh !== 'true') {
            const cached = db.getSmcCandlesCache(exchangeId, symbol, tf);
            if (
              cached &&
              !cached.isExpired &&
              !cached.stale &&
              !cached.fallback &&
              cached.klines.length >= 30
            ) {
              return {
                klines: cached.klines,
                provenance: {
                  source: cached.source ?? snapshot.provenance.source,
                  fetchedAt: cached.fetchedAt ?? snapshot.provenance.fetchedAt,
                  stale: false,
                  fallback: false,
                  missingData: [] as string[],
                  isDemo: Boolean(cached.isDemo),
                },
              };
            }
          }
          return adapter.fetchKlines(symbol, tf, 90);
        };
        const getCachedOrFetchOi = async () => {
          if (resolvedMode === 'live' && req.query.refresh !== 'true') {
            const cached15m = db.getSmcCandlesCache(exchangeId, symbol, '15m');
            if (
              cached15m &&
              !cached15m.isExpired &&
              !cached15m.stale &&
              cached15m.openInterest !== null &&
              cached15m.openInterest !== undefined
            ) {
              return {
                symbol,
                openInterest: cached15m.openInterest,
                openInterestValue:
                  cached15m.openInterestValue ??
                  cached15m.openInterest * ticker.lastPrice,
                provenance: {
                  source: cached15m.source ?? snapshot.provenance.source,
                  fetchedAt:
                    cached15m.oiFetchedAt ??
                    cached15m.fetchedAt ??
                    snapshot.provenance.fetchedAt,
                  stale: false,
                  fallback: false,
                  missingData: [] as string[],
                  isDemo: Boolean(cached15m.isDemo),
                },
              };
            }
          }
          return adapter.fetchOpenInterest(symbol, ticker.lastPrice);
        };

        const [oiResult, k5m, k15m, k1h, k4h] = await Promise.all([
          getCachedOrFetchOi(),
          getCachedOrFetchTf('5m'),
          getCachedOrFetchTf('15m'),
          getCachedOrFetchTf('1h'),
          getCachedOrFetchTf('4h'),
        ]);

        const baseHistMap =
          resolvedMode === 'demo'
            ? buildDemoHistoricalVolumeMap()
            : db.getBulkHistoricalVolumeMap(exchangeId, 40, '15m');

        let kline15mVolumeDiagnostic: HistoricalVolumeMetrics | null = null;
        if (resolvedMode === 'live' && k15m.klines.length > 0) {
          db.recordConfirmedKlineVolumes(
            exchangeId,
            symbol,
            k15m.klines,
            k15m.provenance,
            '15m'
          );
          const confirmedPrimary = k15m.klines.filter((k) => k.isClosed);
          if (confirmedPrimary.length >= 2) {
            const allConfirmedVols = confirmedPrimary.map((k) => k.quoteVolume);
            baseHistMap.set(symbol, allConfirmedVols);
            const priorClosedVols = allConfirmedVols.slice(0, -1);
            const latestClosedVol =
              allConfirmedVols[allConfirmedVols.length - 1];
            kline15mVolumeDiagnostic = evaluateHistoricalVolumeAnomaly({
              symbol,
              exchange: exchangeId,
              currentVolume: latestClosedVol,
              historicalVolumes: priorClosedVols,
              volumeTimeframe: '15m',
              baseProvenance: k15m.provenance,
            });
          }
        }

        // Pre-scan to get scanner-level historicalVolume & flags for SMC evaluation
        const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
          minQuoteVolume24h: 0,
          mode: resolvedMode,
          exchange: exchangeId,
          volumeTimeframe: '15m',
          historicalVolumeMap: baseHistMap,
        });
        const preCandidate = preScan.candidates.find(
          (c) => c.symbol === symbol
        )!;

        const detailProvenance = {
          source: snapshot.provenance.source,
          fetchedAt: new Date().toISOString(),
          stale:
            preCandidate.provenance.stale ||
            oiResult.provenance.stale ||
            k15m.provenance.stale,
          fallback:
            preCandidate.provenance.fallback ||
            oiResult.provenance.fallback ||
            k15m.provenance.fallback,
          missingData: [
            ...new Set([
              ...preCandidate.provenance.missingData,
              ...oiResult.provenance.missingData,
              ...k5m.provenance.missingData,
              ...k15m.provenance.missingData,
              ...k1h.provenance.missingData,
              ...k4h.provenance.missingData,
            ]),
          ],
          isDemo: adapter.isDemo,
          volumeTimeframe: '15m' as const,
          aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
          volumeMetric: 'quoteVolume' as const,
        };

        const smcAnalysis = evaluateSmcStructure({
          symbol,
          primaryTimeframe,
          klinesByTimeframe: {
            '5m': k5m.klines,
            '15m': k15m.klines,
            '1h': k1h.klines,
            '4h': k4h.klines,
          },
          openInterest: oiResult.openInterest,
          historicalVolume: preCandidate.historicalVolume,
          isLowLiquidity: preCandidate.isLowLiquidity,
          extremeFunding: preCandidate.extremeFunding,
          lowLiquidityHighVolatility: preCandidate.lowLiquidityHighVolatility,
          requireFullMultiTimeframe: true,
          provenance: detailProvenance,
        });

        const existingStoredRec = db.getSmcScanResult(exchangeId, symbol);
        const preserveCompletedWindowCandidate =
          req.query.refresh !== 'true' &&
          existingStoredRec !== null &&
          existingStoredRec.smcEvaluationStatus === 'EVALUATED' &&
          existingStoredRec.smcAnalysis !== null &&
          !existingStoredRec.stale &&
          !existingStoredRec.fallback &&
          existingStoredRec.isDemo === detailProvenance.isDemo;

        const effectiveSmcAnalysis =
          preserveCompletedWindowCandidate && existingStoredRec?.smcAnalysis
            ? existingStoredRec.smcAnalysis
            : smcAnalysis;
        const evaluatedAt =
          preserveCompletedWindowCandidate && existingStoredRec?.evaluatedAt
            ? existingStoredRec.evaluatedAt
            : new Date().toISOString();
        const smcMap = getExchangeSmcMap(exchangeId);
        smcMap.set(symbol, {
          ...effectiveSmcAnalysis,
          evaluatedAt,
          dataFetchedAt:
            preserveCompletedWindowCandidate && existingStoredRec?.dataFetchedAt
              ? existingStoredRec.dataFetchedAt
              : detailProvenance.fetchedAt,
        });

        const finalScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
          minQuoteVolume24h: 0,
          mode: resolvedMode,
          exchange: exchangeId,
          volumeTimeframe: '15m',
          historicalVolumeMap: baseHistMap,
          smcMap,
        });
        const candidate = finalScan.candidates.find(
          (c) => c.symbol === symbol
        )!;
        if (preserveCompletedWindowCandidate && existingStoredRec) {
          candidate.smcEvaluationStatus = existingStoredRec.smcEvaluationStatus;
          candidate.smcActionState = existingStoredRec.smcActionState;
          candidate.finalTradeSignal = existingStoredRec.finalTradeSignal;
          candidate.marketRadarCategory =
            existingStoredRec.marketRadarCategory ?? candidate.marketRadarCategory;
          candidate.category =
            existingStoredRec.finalTradeSignal === '空頭交易候選'
              ? '空頭候選'
              : existingStoredRec.finalTradeSignal === '多頭交易候選'
                ? '多頭候選'
                : candidate.category;
          if (candidate.decisionTrace) {
            candidate.decisionTrace.marketRadarCategory =
              candidate.marketRadarCategory;
            candidate.decisionTrace.smcEvaluationStatus =
              existingStoredRec.smcEvaluationStatus;
            candidate.decisionTrace.smcActionState =
              existingStoredRec.smcActionState;
            candidate.decisionTrace.finalTradeSignal =
              existingStoredRec.finalTradeSignal;
            candidate.decisionTrace.finalCategory = candidate.category;
          }
        } else {
          db.saveSmcScanResult({
            symbol,
            exchange: exchangeId,
            smcEvaluationStatus: candidate.smcEvaluationStatus,
            smcActionState: candidate.smcActionState,
            finalTradeSignal: candidate.finalTradeSignal,
            marketRadarCategory: candidate.marketRadarCategory,
            evaluatedAt,
            dataFetchedAt: detailProvenance.fetchedAt,
            stale: detailProvenance.stale,
            fallback: detailProvenance.fallback,
            missingData: detailProvenance.missingData,
            source: detailProvenance.source,
            isDemo: detailProvenance.isDemo,
            ruleVersion: smcAnalysis.ruleVersion,
            waitReasons: smcAnalysis.waitReasons,
            smcAnalysis,
          });
        }
        const trace = candidate.decisionTrace;
        const histGate = trace.gates.history;
        const madRatio = histGate.madToMedianRatio ?? null;
        const madRatioPct =
          madRatio !== null ? `${(madRatio * 100).toFixed(2)}%` : 'N/A';

        const why30Of30NotReady =
          histGate.status === 'READY'
            ? `已採用方案 A 一致 15m 量能模型 (volumeTimeframe="15m", aggregationWindow="${histGate.aggregationWindow}")：currentVolume 使用最新已確認 15m K 線 quoteVolume ($${(
                histGate.currentVolume ?? 0
              ).toLocaleString()})，對比過去 ${histGate.sampleCount}/${
                histGate.minRequiredSamples
              } 根已確認 15m K 線基線 (rollingMedian=$${(
                histGate.rollingMedian ?? 0
              ).toLocaleString()}, MAD=$${(
                histGate.mad ?? 0
              ).toLocaleString()}, MAD/Median=${madRatioPct} >= 3%)，算出合理 15m Robust Z-Score=${
                histGate.rawRobustZScore
              } (|Z| <= ${MAX_SANE_ROBUST_ZSCORE})，status="READY"，不再因 24h vs 15m 週期混用產生假異常。`
            : histGate.status === 'BASELINE_UNSTABLE'
              ? histGate.unstableReason === 'EXTREME_ROBUST_ZSCORE_OUTLIER'
                ? `15m 歷史樣本數達 ${histGate.sampleCount}/${histGate.minRequiredSamples} 且 MAD/rollingMedian=${madRatioPct}，但 15m currentVolume 算出極端 rawRobustZScore=${histGate.rawRobustZScore} (> ${MAX_SANE_ROBUST_ZSCORE})，觸發 status="BASELINE_UNSTABLE"。`
                : `15m 歷史樣本數雖達 ${histGate.sampleCount}/${histGate.minRequiredSamples}，但 MAD/rollingMedian 比例過小 (${madRatioPct} < 3%) 或接近 0，觸發 status="BASELINE_UNSTABLE"。`
              : `15m 歷史成交量樣本數僅 ${histGate.sampleCount}/${histGate.minRequiredSamples} (< MIN_HISTORY_SAMPLES=30)，因此判定為 status="INSUFFICIENT_HISTORY"。`;

        const marketRadarShortLabel =
          candidate.marketRadarCategory === '雷達多頭觀察'
            ? '多頭觀察'
            : candidate.marketRadarCategory === '雷達空頭觀察'
              ? '空頭觀察'
              : candidate.marketRadarCategory;

        const atomicStatus = smcBatchScanner.getStatus(
          exchangeId,
          resolvedMode
        );

        const responsePayload: DecisionTraceApiResponse = {
          ...trace,
          cycleId: atomicStatus.cycleId ?? atomicStatus.scanCycleId ?? '',
          scanCycleId: atomicStatus.scanCycleId ?? atomicStatus.cycleId ?? '',
          snapshotAt: atomicStatus.snapshotAt,
          statsVersion: atomicStatus.statsVersion,
          safety: TRADING_SAFETY_FLAGS,
          mode: resolvedMode,
          exchange: exchangeId,
          isDemo: detailProvenance.isDemo,
          fallback: detailProvenance.fallback,
          twoLayerResult: {
            marketRadar: marketRadarShortLabel,
            marketRadarCategory: candidate.marketRadarCategory,
            smcEvaluationStatus: trace.smcEvaluationStatus,
            smcIctState: trace.gates.smc.actionState,
            finalTradeSignal: trace.finalTradeSignal,
            finalCategory: trace.finalCategory,
            reason:
              trace.gates.smc.reason ||
              '尚未形成完整 MSS/FVG/OB 或多週期未確認',
          },
          diagnostics: {
            why30Of30NotReady,
            isBaselineUnstable: histGate.status === 'BASELINE_UNSTABLE',
            madToRollingMedianRatio: madRatio,
            madToRollingMedianPercent: madRatioPct,
            blockedByLowLiquidityGate: !trace.gates.liquidity.passed,
            downgradedOnlyBySmcWait:
              trace.gates.history.passed &&
              trace.gates.liquidity.passed &&
              trace.gates.momentum.passed &&
              trace.gates.relativeBtc.passed &&
              trace.gates.funding.passed &&
              !trace.gates.smc.passed,
            score48Rule:
              trace.scoreCapRule ||
              '未觸發 48 分上限規則 (historicalVolume.status === READY 且無高風險/低流動性)',
            categoryBeforeGates: trace.categoryBeforeGates,
            marketRadarCategory: candidate.marketRadarCategory,
            smcEvaluationStatus: trace.smcEvaluationStatus,
            smcActionState: trace.smcActionState,
            finalTradeSignal: trace.finalTradeSignal,
            finalCategory: trace.finalCategory,
            kline15mVolumeDiagnostic:
              kline15mVolumeDiagnostic ?? candidate.historicalVolume,
          },
          provenance: detailProvenance,
          gateEvaluation:
            candidate.gateEvaluation ?? trace.gateEvaluation ?? undefined,
        };

        res.json(responsePayload);
      } catch (err) {
        const isUnavailable = err instanceof ExchangeApiUnavailableError;
        const errorMsg =
          err instanceof Error ? err.message : 'Decision Trace 載入失敗';
        const fetchedAt = new Date().toISOString();
        const sourceName = isUnavailable ? err.source : adapter.displayName;
        res.status(503).json({
          mode: 'live',
          exchange: exchangeId,
          isDemo: false,
          fallback: false,
          source: sourceName,
          fetchedAt,
          apiError: '即時資料不可用',
          apiErrorDetail: errorMsg,
          safety: TRADING_SAFETY_FLAGS,
        });
      }
    }
  );

  // 2B. Single Symbol Detail + Multi-Timeframe Klines + OI + Historical Volume Collector + SMC/ICT Rule Engine
  app.get('/api/symbol/:symbol', async (req: Request, res: Response) => {
    const symbol = (req.params.symbol || 'BTCUSDT').toUpperCase();
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchange =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const tfParam = (req.query.timeframe as Timeframe) || '15m';
    const validTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const primaryTimeframe: Timeframe = validTimeframes.includes(tfParam)
      ? tfParam
      : '15m';

    const { adapter, resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchange
    );

    try {
      const snapshot = await getOrFetchLiveSnapshot(
        adapter,
        exchangeId,
        resolvedMode,
        5000
      );
      const baseHistMap =
        resolvedMode === 'demo'
          ? buildDemoHistoricalVolumeMap()
          : db.getBulkHistoricalVolumeMap(exchangeId, 40, '15m');

      const smcMap = getExchangeSmcMap(exchangeId);
      const ticker = snapshot.tickers.find((t) => t.symbol === symbol);
      if (!ticker) {
        res.status(404).json({
          error: `找不到合約標的 ${symbol}`,
          safety: TRADING_SAFETY_FLAGS,
        });
        return;
      }

      const getCachedOrFetchSymbolTf = async (
        targetSymbol: string,
        tf: Timeframe
      ) => {
        if (resolvedMode === 'live' && req.query.refresh !== 'true') {
          const cached = db.getSmcCandlesCache(exchangeId, targetSymbol, tf);
          if (
            cached &&
            !cached.isExpired &&
            !cached.stale &&
            !cached.fallback &&
            cached.klines.length >= 30
          ) {
            return {
              klines: cached.klines,
              provenance: {
                source: cached.source ?? snapshot.provenance.source,
                fetchedAt: cached.fetchedAt ?? snapshot.provenance.fetchedAt,
                stale: false,
                fallback: false,
                missingData: [] as string[],
                isDemo: Boolean(cached.isDemo),
              },
            };
          }
        }
        return adapter.fetchKlines(targetSymbol, tf, 90);
      };
      const getCachedOrFetchTf = (tf: Timeframe) =>
        getCachedOrFetchSymbolTf(symbol, tf);
      const getCachedOrFetchOi = async () => {
        if (resolvedMode === 'live' && req.query.refresh !== 'true') {
          const cached15m = db.getSmcCandlesCache(exchangeId, symbol, '15m');
          if (
            cached15m &&
            !cached15m.isExpired &&
            !cached15m.stale &&
            cached15m.openInterest !== null &&
            cached15m.openInterest !== undefined
          ) {
            return {
              symbol,
              openInterest: cached15m.openInterest,
              openInterestValue:
                cached15m.openInterestValue ??
                cached15m.openInterest * ticker.lastPrice,
              provenance: {
                source: cached15m.source ?? snapshot.provenance.source,
                fetchedAt:
                  cached15m.oiFetchedAt ??
                  cached15m.fetchedAt ??
                  snapshot.provenance.fetchedAt,
                stale: false,
                fallback: false,
                missingData: [] as string[],
                isDemo: Boolean(cached15m.isDemo),
              },
            };
          }
        }
        return adapter.fetchOpenInterest(symbol, ticker.lastPrice);
      };

      const shouldFetchBtcOverlay =
        symbol !== BTC_BENCHMARK_SYMBOL &&
        snapshot.tickers.some((t) => t.symbol === BTC_BENCHMARK_SYMBOL);

      // Fetch Open Interest, 5m/15m/1h/4h Klines, Historical OI/Funding, Spot Ticker, Orderbook Depth, and BTCUSDT overlay in parallel
      const [
        oiResult,
        k5m,
        k15m,
        k1h,
        k4h,
        oiHistResult,
        fundingHistResult,
        spotTickerResult,
        orderbookResult,
        btcK15m,
        btcK1h,
        btcKPrimaryExtra,
      ] = await Promise.all([
        getCachedOrFetchOi(),
        getCachedOrFetchTf('5m'),
        getCachedOrFetchTf('15m'),
        getCachedOrFetchTf('1h'),
        getCachedOrFetchTf('4h'),
        adapter.fetchHistoricalOpenInterest
          ? adapter
              .fetchHistoricalOpenInterest(symbol, primaryTimeframe, 48)
              .catch(() => null)
          : Promise.resolve(null),
        adapter.fetchHistoricalFundingRates
          ? adapter.fetchHistoricalFundingRates(symbol, 32).catch(() => null)
          : Promise.resolve(null),
        adapter.fetchSpotTicker
          ? adapter.fetchSpotTicker(symbol).catch(() => null)
          : Promise.resolve(null),
        adapter.fetchOrderBookDepth
          ? adapter.fetchOrderBookDepth(symbol, 50).catch(() => null)
          : Promise.resolve(null),
        shouldFetchBtcOverlay
          ? getCachedOrFetchSymbolTf(BTC_BENCHMARK_SYMBOL, '15m').catch(
              () => null
            )
          : Promise.resolve(null),
        shouldFetchBtcOverlay
          ? getCachedOrFetchSymbolTf(BTC_BENCHMARK_SYMBOL, '1h').catch(
              () => null
            )
          : Promise.resolve(null),
        shouldFetchBtcOverlay &&
        primaryTimeframe !== '15m' &&
        primaryTimeframe !== '1h'
          ? getCachedOrFetchSymbolTf(
              BTC_BENCHMARK_SYMBOL,
              primaryTimeframe
            ).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Persist confirmed 15m kline volumes into historical_volume_samples collector (strictly volumeTimeframe='15m')
      if (resolvedMode === 'live' && k15m.klines.length > 0) {
        db.recordConfirmedKlineVolumes(
          exchangeId,
          symbol,
          k15m.klines,
          k15m.provenance,
          '15m'
        );
        const confirmedPrimary = k15m.klines.filter((k) => k.isClosed);
        if (confirmedPrimary.length >= 2) {
          baseHistMap.set(
            symbol,
            confirmedPrimary.map((k) => k.quoteVolume)
          );
        }
      }

      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h: 0,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap: baseHistMap,
        smcMap,
      });

      const preCandidate = preScan.candidates.find((c) => c.symbol === symbol);
      if (!preCandidate) {
        res.status(404).json({
          error: `找不到合約標的 ${symbol}`,
          safety: TRADING_SAFETY_FLAGS,
        });
        return;
      }

      const combinedMissingData = [
        ...new Set([
          ...preCandidate.provenance.missingData,
          ...oiResult.provenance.missingData,
          ...k5m.provenance.missingData,
          ...k15m.provenance.missingData,
          ...k1h.provenance.missingData,
          ...k4h.provenance.missingData,
        ]),
      ];

      const detailProvenance = {
        source: snapshot.provenance.source,
        fetchedAt: new Date().toISOString(),
        stale:
          preCandidate.provenance.stale ||
          oiResult.provenance.stale ||
          k15m.provenance.stale,
        fallback:
          preCandidate.provenance.fallback ||
          oiResult.provenance.fallback ||
          k15m.provenance.fallback,
        missingData: combinedMissingData,
        isDemo: adapter.isDemo,
        volumeTimeframe: '15m' as const,
        aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
        volumeMetric: 'quoteVolume' as const,
      };

      const smcAnalysis = evaluateSmcStructure({
        symbol,
        primaryTimeframe,
        klinesByTimeframe: {
          '5m': k5m.klines,
          '15m': k15m.klines,
          '1h': k1h.klines,
          '4h': k4h.klines,
        },
        openInterest: oiResult.openInterest,
        historicalVolume: preCandidate.historicalVolume,
        isLowLiquidity: preCandidate.isLowLiquidity,
        extremeFunding: preCandidate.extremeFunding,
        lowLiquidityHighVolatility: preCandidate.lowLiquidityHighVolatility,
        requireFullMultiTimeframe: true,
        provenance: detailProvenance,
      });

      const evaluatedAt = new Date().toISOString();
      smcMap.set(symbol, {
        ...smcAnalysis,
        evaluatedAt,
        dataFetchedAt: detailProvenance.fetchedAt,
      });

      const btcDetailTicker = snapshot.tickers.find(
        (t) => t.symbol === BTC_BENCHMARK_SYMBOL
      );
      const symbolBtcK15 =
        symbol === BTC_BENCHMARK_SYMBOL ? k15m.klines : (btcK15m?.klines ?? []);
      const symbolBtcK1h =
        symbol === BTC_BENCHMARK_SYMBOL ? k1h.klines : (btcK1h?.klines ?? []);
      const btcMarketRegime = evaluateBtcMarketRegime({
        btcChange24h: btcDetailTicker?.priceChangePercent24h ?? null,
        btcKlines15m: symbolBtcK15,
        btcKlines1h: symbolBtcK1h,
      });

      const finalScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h: 0,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap: baseHistMap,
        smcMap,
        btcMarketRegime,
      });

      const candidate = finalScan.candidates.find((c) => c.symbol === symbol)!;
      const existingStoredResult = db.getSmcScanResult(exchangeId, symbol);
      const shouldPreserveExistingResult =
        existingStoredResult &&
        existingStoredResult.smcEvaluationStatus === 'EVALUATED' &&
        existingStoredResult.ruleVersion === smcAnalysis.ruleVersion &&
        !existingStoredResult.stale &&
        !existingStoredResult.fallback &&
        existingStoredResult.isDemo === detailProvenance.isDemo;

      if (!shouldPreserveExistingResult) {
        db.saveSmcScanResult({
          symbol,
          exchange: exchangeId,
          smcEvaluationStatus: candidate.smcEvaluationStatus,
          smcActionState: candidate.smcActionState,
          finalTradeSignal: candidate.finalTradeSignal,
          marketRadarCategory: candidate.marketRadarCategory,
          evaluatedAt,
          dataFetchedAt: detailProvenance.fetchedAt,
          stale: detailProvenance.stale,
          fallback: detailProvenance.fallback,
          missingData: detailProvenance.missingData,
          source: detailProvenance.source,
          isDemo: detailProvenance.isDemo,
          ruleVersion: smcAnalysis.ruleVersion,
          waitReasons: smcAnalysis.waitReasons,
          smcAnalysis,
        });
      }
      candidate.openInterest = oiResult.openInterest;
      candidate.openInterestValue = oiResult.openInterestValue;
      if (oiResult.openInterest === null) {
        if (!candidate.provenance.missingData.includes('openInterest')) {
          candidate.provenance.missingData.push('openInterest');
        }
      }

      const btcKlinesByTimeframe: Partial<Record<Timeframe, Kline[]>> =
        symbol === BTC_BENCHMARK_SYMBOL
          ? {
              '5m': k5m.klines,
              '15m': k15m.klines,
              '1h': k1h.klines,
              '4h': k4h.klines,
            }
          : {
              '15m': btcK15m?.klines ?? [],
              '1h': btcK1h?.klines ?? [],
              ...(primaryTimeframe !== '15m' &&
              primaryTimeframe !== '1h' &&
              btcKPrimaryExtra?.klines
                ? { [primaryTimeframe]: btcKPrimaryExtra.klines }
                : {}),
              ...(resolvedMode === 'live'
                ? (() => {
                    const extraCached: Partial<Record<Timeframe, Kline[]>> = {};
                    if (primaryTimeframe !== '5m') {
                      const c5 = db.getSmcCandlesCache(
                        exchangeId,
                        BTC_BENCHMARK_SYMBOL,
                        '5m'
                      );
                      if (c5 && !c5.stale && !c5.fallback) {
                        extraCached['5m'] = c5.klines;
                      }
                    }
                    if (primaryTimeframe !== '4h') {
                      const c4 = db.getSmcCandlesCache(
                        exchangeId,
                        BTC_BENCHMARK_SYMBOL,
                        '4h'
                      );
                      if (c4 && !c4.stale && !c4.fallback) {
                        extraCached['4h'] = c4.klines;
                      }
                    }
                    return extraCached;
                  })()
                : {}),
            };

      const btcCorrelation = computeBtcCorrelationAnalysis({
        symbol,
        primaryTimeframe,
        symbolKlinesByTimeframe: {
          '5m': k5m.klines,
          '15m': k15m.klines,
          '1h': k1h.klines,
          '4h': k4h.klines,
        },
        btcKlinesByTimeframe,
        evaluatedAt,
      });

      candidate.btcCorrelation = {
        isBenchmark: btcCorrelation.isBenchmark,
        status: btcCorrelation.status,
        tier: btcCorrelation.tier,
        tierLabelZh: btcCorrelation.tierLabelZh,
        primaryTimeframe: btcCorrelation.primaryTimeframe,
        pearson15m: btcCorrelation.pearson15m,
        directionalOverlap15m: btcCorrelation.directionalOverlap15m,
        downsideOverlap15m: btcCorrelation.downsideOverlap15m,
        beta15m: btcCorrelation.beta15m,
        alignedBars15m: btcCorrelation.alignedBars15m,
        pearson1h: btcCorrelation.pearson1h,
        directionalOverlap1h: btcCorrelation.directionalOverlap1h,
        downsideOverlap1h: btcCorrelation.downsideOverlap1h,
        beta1h: btcCorrelation.beta1h,
        alignedBars1h: btcCorrelation.alignedBars1h,
      };

      candidate.sector = classifySymbolSector(
        candidate.baseAsset,
        candidate.symbol
      );

      const primaryKlines =
        primaryTimeframe === '5m'
          ? k5m.klines
          : primaryTimeframe === '1h'
            ? k1h.klines
            : primaryTimeframe === '4h'
              ? k4h.klines
              : k15m.klines;

      const derivativesStructure = computeDerivativesStructure({
        symbol,
        timeframe: primaryTimeframe,
        lastPrice: candidate.lastPrice,
        atr14: smcAnalysis.atr14,
        klines: primaryKlines,
        oiSeries: oiHistResult?.series ?? [],
        fundingSeries: fundingHistResult?.series ?? [],
        currentOiValue: oiResult.openInterestValue,
        currentFundingRate: candidate.fundingRate,
        evaluatedAt,
      });

      const microstructure = computeMarketMicrostructure({
        symbol,
        perpPrice: candidate.lastPrice,
        perpQuoteVolume24h: candidate.quoteVolume24h,
        spotTicker: spotTickerResult,
        orderbook: orderbookResult,
        evaluatedAt,
      });

      const keyLevelsSession = computeKeyLevelsAndSession({
        symbol,
        primaryTimeframe,
        lastPrice: candidate.lastPrice,
        primaryKlines,
        klines1h: k1h.klines,
        klines4h: k4h.klines,
        nextFundingTime: ticker.nextFundingTime,
        evaluatedAt,
      });

      const entryZoneDir: 'LONG' | 'SHORT' | 'NEUTRAL' =
        candidate.intendedDirection && candidate.intendedDirection !== 'NEUTRAL'
          ? candidate.intendedDirection
          : smcAnalysis.intendedDirection &&
              smcAnalysis.intendedDirection !== 'NEUTRAL'
            ? smcAnalysis.intendedDirection
            : smcAnalysis.earlyInflection?.direction ?? 'NEUTRAL';

      const entryZoneAnalysis = computeEntryZoneAnalysis({
        direction: entryZoneDir,
        currentPrice: candidate.lastPrice,
        atr14: smcAnalysis.atr14,
        fvg: smcAnalysis.fvg,
        orderBlock: smcAnalysis.orderBlock,
        liquiditySweep: smcAnalysis.liquiditySweep,
        intradayVwap: keyLevelsSession.vwap,
        pdh: keyLevelsSession.pdh,
        pdl: keyLevelsSession.pdl,
      });

      const tradeHorizon = classifyTradeHorizon({
        smcActionState: smcAnalysis.actionState,
        intendedDirection: entryZoneDir,
        mtfAlignment: smcAnalysis.mtfAlignment,
        atrPercent: smcAnalysis.atrPercent,
        priceChangePercent24h: candidate.priceChangePercent24h,
        quoteVolume24h: candidate.quoteVolume24h,
        fundingRate: candidate.fundingRate,
        entryZoneAnalysis,
        earlyIgnition: candidate.earlyIgnition ?? null,
        bosOrMssDetected: smcAnalysis.bosOrMss.detected,
        displacementDetected: smcAnalysis.displacement.detected,
        rvol:
          candidate.historicalVolume.status === 'READY'
            ? candidate.historicalVolume.rvol
            : null,
      });

      smcAnalysis.entryZoneAnalysis = entryZoneAnalysis;
      smcAnalysis.tradeHorizon = tradeHorizon;
      candidate.entryZoneSummary = entryZoneAnalysis;
      candidate.tradeHorizon = tradeHorizon;

      const trimmedBtcKlinesByTimeframe: Partial<Record<Timeframe, Kline[]>> =
        {};
      (['5m', '15m', '1h', '4h'] as Timeframe[]).forEach((tfKey) => {
        const arr = btcKlinesByTimeframe[tfKey];
        if (arr && arr.length > 0) {
          trimmedBtcKlinesByTimeframe[tfKey] = arr.slice(-60);
        }
      });

      const responsePayload: SymbolDetailResponse = {
        safety: TRADING_SAFETY_FLAGS,
        mode: resolvedMode,
        exchange: exchangeId,
        isDemo: detailProvenance.isDemo,
        fallback: detailProvenance.fallback,
        source: detailProvenance.source,
        fetchedAt: detailProvenance.fetchedAt,
        stale: detailProvenance.stale,
        missingData: detailProvenance.missingData,
        symbol,
        primaryTimeframe,
        candidate,
        decisionTrace: candidate.decisionTrace,
        openInterest: oiResult,
        klinesByTimeframe: {
          '5m': {
            kllinesCount: k5m.klines.length,
            confirmedCount: k5m.klines.filter((k) => k.isClosed).length,
            klines: k5m.klines,
            provenance: k5m.provenance,
          },
          '15m': {
            kllinesCount: k15m.klines.length,
            confirmedCount: k15m.klines.filter((k) => k.isClosed).length,
            klines: k15m.klines,
            provenance: k15m.provenance,
          },
          '1h': {
            kllinesCount: k1h.klines.length,
            confirmedCount: k1h.klines.filter((k) => k.isClosed).length,
            klines: k1h.klines,
            provenance: k1h.provenance,
          },
          '4h': {
            kllinesCount: k4h.klines.length,
            confirmedCount: k4h.klines.filter((k) => k.isClosed).length,
            klines: k4h.klines,
            provenance: k4h.provenance,
          },
        },
        smcAnalysis,
        entryZoneAnalysis,
        tradeHorizon,
        btcCorrelation,
        derivativesStructure,
        microstructure,
        keyLevelsSession,
        btcKlinesByTimeframe: trimmedBtcKlinesByTimeframe,
        btcMarketRegime,
        provenance: detailProvenance,
      };

      res.json(responsePayload);
    } catch (err) {
      const isUnavailable = err instanceof ExchangeApiUnavailableError;
      const errorMsg =
        err instanceof Error ? err.message : '單一幣種詳情載入失敗';
      const fetchedAt = new Date().toISOString();
      const sourceName = isUnavailable ? err.source : adapter.displayName;
      const missingData = ['SYMBOL_DETAIL'];
      db.recordPhase17ErrorEvent(exchangeId, {
        is503: true,
        errorMessage: errorMsg,
      });
      res.status(503).json({
        mode: 'live',
        exchange: exchangeId,
        isDemo: false,
        fallback: false,
        source: sourceName,
        fetchedAt,
        stale: false,
        missingData,
        candidates: [],
        error: '即時資料不可用',
        apiError: '即時資料不可用',
        apiErrorDetail: errorMsg,
        provenance: {
          source: sourceName,
          fetchedAt,
          stale: false,
          fallback: false,
          missingData,
          isDemo: false,
        },
        safety: TRADING_SAFETY_FLAGS,
      });
    }
  });

  // 3. Cross-Exchange Price, Funding, OI & Spread Divergence Endpoint (/api/divergence)
  app.get('/api/divergence', async (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const symbolsParam =
      typeof req.query.symbols === 'string' ? req.query.symbols : '';
    const targetSymbols = symbolsParam
      ? symbolsParam
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : undefined;
    const limitRaw = Number(req.query.limit ?? 35);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 35;

    if (modeParam === 'demo') {
      const demoSnap = await adapters.demo_synthetic.fetchMarketSnapshot();
      const bybitDemoTickers = demoSnap.tickers.map((t) => ({
        ...t,
        lastPrice: Number((t.lastPrice * 1.0018).toPrecision(6)),
        fundingRate:
          t.fundingRate !== null ? t.fundingRate + 0.00025 : null,
        openInterestValue:
          t.openInterestValue !== null ? t.openInterestValue * 0.65 : null,
        provenance: {
          ...t.provenance,
          source: 'DEMO_SYNTHETIC_DATASET (Bybit Leg)',
        },
      }));
      const bingxDemoTickers = demoSnap.tickers.map((t) => ({
        ...t,
        lastPrice: Number((t.lastPrice * 0.9985).toPrecision(6)),
        fundingRate:
          t.fundingRate !== null ? t.fundingRate - 0.00018 : null,
        openInterestValue:
          t.openInterestValue !== null ? t.openInterestValue * 0.35 : null,
        provenance: {
          ...t.provenance,
          source: 'DEMO_SYNTHETIC_DATASET (BingX Leg)',
        },
      }));

      const result = evaluateCrossExchangeDivergence(
        {
          binance_usdm: {
            exchange: 'binance_usdm',
            displayName: 'Binance (DEMO)',
            available: true,
            tickers: demoSnap.tickers,
            provenance: demoSnap.provenance,
          },
          bybit_linear: {
            exchange: 'bybit_linear',
            displayName: 'Bybit (DEMO)',
            available: true,
            tickers: bybitDemoTickers,
            provenance: {
              ...demoSnap.provenance,
              source: 'DEMO_SYNTHETIC_DATASET (Bybit Leg)',
            },
          },
          bingx_swap: {
            exchange: 'bingx_swap',
            displayName: 'BingX (DEMO)',
            available: true,
            tickers: bingxDemoTickers,
            provenance: {
              ...demoSnap.provenance,
              source: 'DEMO_SYNTHETIC_DATASET (BingX Leg)',
            },
          },
        },
        { mode: 'demo', targetSymbols, limit }
      );
      res.json(result);
      return;
    }

    const fetchVenue = async (
      exId: 'binance_usdm' | 'bybit_linear' | 'bingx_swap'
    ): Promise<VenueSnapshotInput> => {
      const adapter = adapters[exId];
      try {
        const snap = await adapter.fetchMarketSnapshot();
        return {
          exchange: exId,
          displayName: adapter.displayName,
          available: true,
          tickers: snap.tickers,
          provenance: snap.provenance,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : '連線失敗';
        return {
          exchange: exId,
          displayName: adapter.displayName,
          available: false,
          error: msg,
          tickers: [],
          provenance: {
            source: adapter.displayName,
            fetchedAt: new Date().toISOString(),
            stale: false,
            fallback: false,
            missingData: [`VENUE_UNAVAILABLE_${exId.toUpperCase()}`],
            isDemo: false,
          },
        };
      }
    };

    const [binanceVenue, bybitVenue, bingxVenue] = await Promise.all([
      fetchVenue('binance_usdm'),
      fetchVenue('bybit_linear'),
      fetchVenue('bingx_swap'),
    ]);

    if (
      !binanceVenue.available &&
      !bybitVenue.available &&
      !bingxVenue.available
    ) {
      res.status(503).json({
        safety: TRADING_SAFETY_FLAGS,
        mode: 'live',
        isDemo: false,
        fallback: false,
        apiError: '即時資料不可用',
        venueStatuses: {
          binance_usdm: binanceVenue,
          bybit_linear: bybitVenue,
          bingx_swap: bingxVenue,
        },
        items: [],
      });
      return;
    }

    // Enrich top symbols with Binance & BingX Open Interest in parallel so OI divergence has live multi-venue data
    const focusSymbols =
      targetSymbols && targetSymbols.length > 0
        ? targetSymbols.slice(0, 8)
        : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'BNBUSDT', 'XRPUSDT'];

    await Promise.all(
      focusSymbols.flatMap((sym) => {
        const tasks: Array<Promise<void>> = [];
        const bTicker = binanceVenue.tickers.find((t) => t.symbol === sym);
        if (binanceVenue.available && bTicker && bTicker.openInterest === null) {
          tasks.push(
            adapters.binance_usdm
              .fetchOpenInterest(sym, bTicker.lastPrice)
              .then((oi) => {
                bTicker.openInterest = oi.openInterest;
                bTicker.openInterestValue = oi.openInterestValue;
              })
              .catch(() => {})
          );
        }
        const xTicker = bingxVenue.tickers.find((t) => t.symbol === sym);
        if (bingxVenue.available && xTicker && xTicker.openInterest === null) {
          tasks.push(
            adapters.bingx_swap
              .fetchOpenInterest(sym, xTicker.lastPrice)
              .then((oi) => {
                xTicker.openInterest = oi.openInterest;
                xTicker.openInterestValue = oi.openInterestValue;
              })
              .catch(() => {})
          );
        }
        return tasks;
      })
    );

    const divergenceResult = evaluateCrossExchangeDivergence(
      {
        binance_usdm: binanceVenue,
        bybit_linear: bybitVenue,
        bingx_swap: bingxVenue,
      },
      { mode: 'live', targetSymbols, limit }
    );

    res.json(divergenceResult);
  });

  // 4. Server-Side Gemini AI Explanation Endpoint (/api/explain)
  app.post('/api/explain', async (req: Request, res: Response) => {
    const body = req.body as GeminiExplainRequest;
    if (!body || !body.candidate || !body.smcAnalysis) {
      res.status(400).json({
        error: '必須提供規則引擎已產生的 candidate 與 smcAnalysis JSON evidence',
      });
      return;
    }

    const explanation = await generateGeminiExplanation(body, {
      customModelCaller: options.customGeminiCaller,
    });
    res.json(explanation);
  });

  // 5. Notification Dry-Run Preview & Rate-Limit/Dedupe/Cooldown Endpoint
  app.post('/api/notify/preview', async (req: Request, res: Response) => {
    const { channel, payload } = req.body as {
      channel: 'TELEGRAM' | 'TRADINGVIEW_WEBHOOK';
      payload: NotificationPayload;
    };

    if (!payload || !payload.symbol) {
      res.status(400).json({ error: '缺少有效通知 payload' });
      return;
    }

    const adapter =
      channel === 'TRADINGVIEW_WEBHOOK' ? tradingViewAdapter : telegramAdapter;
    const record = await adapter.dispatchPreview(payload);

    res.json({
      safety: TRADING_SAFETY_FLAGS,
      record,
      history: notificationGuard.getHistory(),
    });
  });

  app.get('/api/notify/history', (_req: Request, res: Response) => {
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      history: notificationGuard.getHistory(),
    });
  });

  // 5B. External Notification Channels (Telegram Bot & Discord Webhook, Strictly PAPER ONLY)
  app.get('/api/notify/external/status', (_req: Request, res: Response) => {
    res.json(externalNotificationService.getStatus(40));
  });

  app.post('/api/notify/external/config', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: {
      telegramEnabled?: boolean;
      discordEnabled?: boolean;
      notifyFormalSmc?: boolean;
      notifyEarlyIgnition?: boolean;
    } = {};
    if (typeof body.telegramEnabled === 'boolean') {
      patch.telegramEnabled = body.telegramEnabled;
    }
    if (typeof body.discordEnabled === 'boolean') {
      patch.discordEnabled = body.discordEnabled;
    }
    if (typeof body.notifyFormalSmc === 'boolean') {
      patch.notifyFormalSmc = body.notifyFormalSmc;
    }
    if (typeof body.notifyEarlyIgnition === 'boolean') {
      patch.notifyEarlyIgnition = body.notifyEarlyIgnition;
    }
    res.json(externalNotificationService.updateConfig(patch));
  });

  app.post(
    '/api/notify/external/test',
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        channel?: string;
        symbol?: string;
      };
      const rawChannel = String(body.channel || '').toUpperCase();
      if (rawChannel !== 'TELEGRAM' && rawChannel !== 'DISCORD') {
        res.status(400).json({
          error: '不支援的外部通知通道，請選擇 TELEGRAM 或 DISCORD',
        });
        return;
      }
      const channel = rawChannel as ExternalNotificationChannel;
      const result = await externalNotificationService.sendTestNotification(
        channel,
        typeof body.symbol === 'string' ? body.symbol : 'BTCUSDT'
      );
      res.json(result);
    }
  );

  // 5C. Auto-Backtest Scheduler Endpoints
  app.get('/api/auto-backtest/status', (_req: Request, res: Response) => {
    res.json(autoBacktestScheduler.getStatus());
  });

  app.post('/api/auto-backtest/config', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') {
      patch.enabled = body.enabled;
    }
    if (
      typeof body.intervalMs === 'number' &&
      Number.isFinite(body.intervalMs)
    ) {
      patch.intervalMs = body.intervalMs;
    }
    if (
      typeof body.timeframe === 'string' &&
      ['5m', '15m', '1h', '4h'].includes(body.timeframe)
    ) {
      patch.timeframe = body.timeframe;
    }
    if (
      typeof body.maxSymbolsPerRun === 'number' &&
      Number.isFinite(body.maxSymbolsPerRun)
    ) {
      patch.maxSymbolsPerRun = body.maxSymbolsPerRun;
    }
    if (typeof body.includeWatchlist === 'boolean') {
      patch.includeWatchlist = body.includeWatchlist;
    }
    if (Array.isArray(body.watchlistSymbols)) {
      patch.watchlistSymbols = body.watchlistSymbols.map((s) => String(s));
    }
    if (
      typeof body.exchange === 'string' &&
      body.exchange in adapters &&
      body.exchange !== 'demo_synthetic'
    ) {
      patch.exchange = body.exchange;
    }
    res.json(autoBacktestScheduler.updateConfig(patch));
  });

  app.post(
    '/api/auto-backtest/run-now',
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        mode?: 'live' | 'demo';
        exchange?: ExchangeId;
        symbols?: string[];
      };
      const batch = await autoBacktestScheduler.runBatchOnce({
        force: true,
        mode: body.mode === 'demo' ? 'demo' : 'live',
        exchange: body.exchange,
        overrideSymbols: Array.isArray(body.symbols)
          ? body.symbols.map((s) => String(s))
          : undefined,
      });
      res.json({
        safety: TRADING_SAFETY_FLAGS,
        batch,
        status: autoBacktestScheduler.getStatus(),
      });
    }
  );

  // 5d. Position Sentinel: Active Trade Live Trend & Reversal Guardian Endpoints
  app.get('/api/position-sentinel/status', (_req: Request, res: Response) => {
    res.json(positionSentinel.getStatus());
  });

  app.get('/api/position-sentinel/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendSnapshot = (status: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(status)}\n\n`);
      } catch {
        // ignore closed stream write
      }
    };

    sendSnapshot(positionSentinel.getStatus());
    const unsub = positionSentinel.subscribe(sendSnapshot);
    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        // ignore
      }
    }, 20_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  app.post(
    '/api/position-sentinel/positions',
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        symbol?: string;
        exchange?: string;
        side?: string;
        timeframe?: string;
        entryPrice?: number;
        invalidationPrice?: number;
        targetPrice?: number | null;
        leverage?: number;
        notes?: string;
        evaluateNow?: boolean;
      };
      const rawSymbol = String(body.symbol ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{2,24}$/.test(rawSymbol)) {
        res.status(400).json({
          safety: TRADING_SAFETY_FLAGS,
          error: '標的代號格式無效 (例：BTCUSDT)',
        });
        return;
      }
      const rawEx = String(body.exchange ?? 'binance_usdm');
      if (!(rawEx in adapters)) {
        res.status(400).json({
          safety: TRADING_SAFETY_FLAGS,
          error: '不支援的交易所參數',
        });
        return;
      }
      const entryPrice = Number(body.entryPrice);
      const invalidationPrice = Number(body.invalidationPrice);
      if (
        !Number.isFinite(entryPrice) ||
        entryPrice <= 0 ||
        !Number.isFinite(invalidationPrice) ||
        invalidationPrice <= 0
      ) {
        res.status(400).json({
          safety: TRADING_SAFETY_FLAGS,
          error: '進場價與失效防線價 (SL) 必須為大於 0 的有效數值',
        });
        return;
      }
      const side = body.side === 'SHORT' ? 'SHORT' : 'LONG';
      const tf =
        typeof body.timeframe === 'string' &&
        ['5m', '15m', '1h', '4h'].includes(body.timeframe)
          ? (body.timeframe as '5m' | '15m' | '1h' | '4h')
          : '15m';
      const targetPrice =
        body.targetPrice !== null &&
        body.targetPrice !== undefined &&
        Number.isFinite(Number(body.targetPrice)) &&
        Number(body.targetPrice) > 0
          ? Number(body.targetPrice)
          : null;
      const leverage =
        body.leverage !== undefined && Number.isFinite(Number(body.leverage))
          ? Math.max(1, Math.min(125, Number(body.leverage)))
          : 1;

      const created = positionSentinel.addPosition({
        symbol: rawSymbol,
        exchange: rawEx as ExchangeId,
        side,
        timeframe: tf,
        entryPrice,
        invalidationPrice,
        targetPrice,
        leverage,
        notes: typeof body.notes === 'string' ? body.notes : '',
      });
      if (body.evaluateNow !== false) {
        await positionSentinel.runEvaluationCycle();
      }
      res.json({
        safety: TRADING_SAFETY_FLAGS,
        position: created,
        status: positionSentinel.getStatus(),
      });
    }
  );

  app.patch(
    '/api/position-sentinel/positions/:id',
    async (req: Request, res: Response) => {
      const id = String(req.params.id || '').trim();
      const body = (req.body ?? {}) as {
        invalidationPrice?: number;
        targetPrice?: number | null;
        leverage?: number;
        paused?: boolean;
        active?: boolean;
        notes?: string;
        syncPaperLedger?: boolean;
      };
      const updated = positionSentinel.updatePosition(id, {
        invalidationPrice:
          body.invalidationPrice !== undefined
            ? Number(body.invalidationPrice)
            : undefined,
        targetPrice:
          body.targetPrice === null
            ? null
            : body.targetPrice !== undefined
              ? Number(body.targetPrice)
              : undefined,
        leverage:
          body.leverage !== undefined ? Number(body.leverage) : undefined,
        paused: typeof body.paused === 'boolean' ? body.paused : undefined,
        active: typeof body.active === 'boolean' ? body.active : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      if (!updated) {
        res.status(404).json({
          safety: TRADING_SAFETY_FLAGS,
          error: `找不到追蹤持倉 ${id}`,
        });
        return;
      }
      if (
        body.syncPaperLedger &&
        updated.sourceType === 'PAPER_LEDGER' &&
        updated.paperLedgerId !== null &&
        body.invalidationPrice !== undefined &&
        Number.isFinite(Number(body.invalidationPrice)) &&
        Number(body.invalidationPrice) > 0
      ) {
        db.updatePaperLedgerInvalidation(
          updated.paperLedgerId,
          Number(body.invalidationPrice)
        );
      }
      await positionSentinel.runEvaluationCycle();
      res.json({
        safety: TRADING_SAFETY_FLAGS,
        position: updated,
        status: positionSentinel.getStatus(),
      });
    }
  );

  app.delete(
    '/api/position-sentinel/positions/:id',
    (req: Request, res: Response) => {
      const id = String(req.params.id || '').trim();
      const deleted = positionSentinel.deletePosition(id);
      if (!deleted) {
        res.status(404).json({
          safety: TRADING_SAFETY_FLAGS,
          error: `找不到追蹤持倉 ${id}`,
        });
        return;
      }
      res.json({
        safety: TRADING_SAFETY_FLAGS,
        deleted: true,
        status: positionSentinel.getStatus(),
      });
    }
  );

  app.post(
    '/api/position-sentinel/import-paper',
    async (_req: Request, res: Response) => {
      const syncRes = positionSentinel.syncPaperLedgerNow();
      await positionSentinel.runEvaluationCycle();
      res.json({
        safety: TRADING_SAFETY_FLAGS,
        ...syncRes,
        status: positionSentinel.getStatus(),
      });
    }
  );

  app.post(
    '/api/position-sentinel/check-now',
    async (_req: Request, res: Response) => {
      const status = await positionSentinel.runEvaluationCycle();
      res.json(status);
    }
  );

  app.post('/api/position-sentinel/config', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of [
      'enabled',
      'autoSyncPaperLedger',
      'wsStreamEnabled',
      'notifyDiscord',
      'notifyTelegram',
    ]) {
      if (typeof body[key] === 'boolean') {
        patch[key] = body[key];
      }
    }
    for (const key of [
      'pollIntervalMs',
      'atrShockMultiplier',
      'rvolSpikeThreshold',
      'stopProximityPct',
      'alertCooldownMs',
    ]) {
      if (typeof body[key] === 'number' && Number.isFinite(body[key])) {
        patch[key] = body[key];
      }
    }
    if (body.notifyMinSeverity === 'CRITICAL' || body.notifyMinSeverity === 'WARNING') {
      patch.notifyMinSeverity = body.notifyMinSeverity;
    }
    const config = positionSentinel.updateConfig(patch);
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      config,
      status: positionSentinel.getStatus(),
    });
  });

  // 6. Lookahead-Free Deterministic & Walk-Forward Backtest Endpoints + SQLite Persistence
  app.get('/api/backtest/reports', (_req: Request, res: Response) => {
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      reports: backtestDb.listBacktestRuns(30),
    });
  });

  app.get('/api/backtest/run/:backtestRunId', (req: Request, res: Response) => {
    const runId = String(req.params.backtestRunId || '').trim();
    const report = backtestDb.getBacktestRunById(runId);
    if (!report) {
      res.status(404).json({
        safety: TRADING_SAFETY_FLAGS,
        error: `找不到回測紀錄 ${runId}`,
      });
      return;
    }
    const signalEvidences = backtestDb.listSignalEvidencesByRunId(runId);
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      report,
      signalEvidences,
    });
  });

  app.post('/api/backtest', async (req: Request, res: Response) => {
    const {
      symbol = 'BTCUSDT',
      timeframe = '15m',
      mode = 'live',
      exchange,
      barLimit = 120,
      includeWalkForward = true,
      writeToPaperLedger = false,
      costConfig,
      ruleVersion,
      smcRuleProfile,
      omitHistoricalOiAndFunding = false,
    } = (req.body ?? {}) as {
      symbol?: string;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      includeWalkForward?: boolean;
      writeToPaperLedger?: boolean;
      costConfig?: Partial<TradingCostConfig>;
      ruleVersion?: string;
      smcRuleProfile?: SmcRuleProfile;
      omitHistoricalOiAndFunding?: boolean;
    };

    try {
      const { report } = await backtestService.executeBacktest({
        symbol,
        timeframe,
        mode,
        exchange,
        barLimit,
        includeWalkForward,
        writeToPaperLedger: Boolean(writeToPaperLedger),
        costConfig,
        ruleVersion,
        smcRuleProfile: normalizeSmcRuleProfile(smcRuleProfile),
        omitHistoricalOiAndFunding: Boolean(omitHistoricalOiAndFunding),
      });

      res.json(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回測資料載入失敗';
      res.status(503).json({
        mode: 'live',
        isDemo: false,
        fallback: false,
        error: '即時資料不可用',
        apiError: '即時資料不可用',
        apiErrorDetail: msg,
        safety: TRADING_SAFETY_FLAGS,
      });
    }
  });

  app.post('/api/backtest/walk-forward', async (req: Request, res: Response) => {
    const {
      symbol = 'BTCUSDT',
      timeframe = '15m',
      mode = 'live',
      exchange,
      barLimit = 120,
      writeToPaperLedger = false,
      costConfig,
      ruleVersion,
      smcRuleProfile,
      omitHistoricalOiAndFunding = false,
    } = (req.body ?? {}) as {
      symbol?: string;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      writeToPaperLedger?: boolean;
      costConfig?: Partial<TradingCostConfig>;
      ruleVersion?: string;
      smcRuleProfile?: SmcRuleProfile;
      omitHistoricalOiAndFunding?: boolean;
    };

    try {
      const { report, walkForward, paperEntriesCreated } =
        await backtestService.executeBacktest({
          symbol,
          timeframe,
          mode,
          exchange,
          barLimit,
          includeWalkForward: true,
          writeToPaperLedger: Boolean(writeToPaperLedger),
          costConfig,
          ruleVersion,
          smcRuleProfile: normalizeSmcRuleProfile(smcRuleProfile),
          omitHistoricalOiAndFunding: Boolean(omitHistoricalOiAndFunding),
        });

      res.json({
        safety: TRADING_SAFETY_FLAGS,
        report,
        walkForward,
        paperEntriesCreatedCount: paperEntriesCreated.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Walk-Forward 回測執行失敗';
      res.status(503).json({
        mode: 'live',
        isDemo: false,
        fallback: false,
        error: '即時資料不可用',
        apiError: '即時資料不可用',
        apiErrorDetail: msg,
        safety: TRADING_SAFETY_FLAGS,
      });
    }
  });

  app.post('/api/backtest/portfolio', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      symbols?: unknown;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      smcRuleProfile?: SmcRuleProfile;
      costConfig?: Partial<TradingCostConfig>;
      riskConfig?: Partial<PortfolioRiskConfig>;
    };

    const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [];
    const symbols = rawSymbols
      .map((s) => String(s ?? '').trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      .slice(0, 15);

    try {
      const resolvedProfile = normalizeSmcRuleProfile(body.smcRuleProfile);
      const result = await backtestService.runPortfolioBenchmarkBacktest({
        symbols: symbols.length > 0 ? symbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        timeframe: body.timeframe,
        mode: body.mode,
        exchange: body.exchange,
        barLimit: body.barLimit,
        smcRuleProfile: resolvedProfile,
        costConfig: body.costConfig,
        riskConfig: body.riskConfig,
      });
      if (!result.isDemo && resolvedProfile === 'STRICT_PRODUCTION') {
        latestPortfolioBacktestResult = result;
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '組合回測執行失敗';
      res.status(503).json({
        mode: 'live',
        isDemo: false,
        fallback: false,
        error: '即時資料不可用',
        apiError: '即時資料不可用',
        apiErrorDetail: msg,
        safety: TRADING_SAFETY_FLAGS,
      });
    }
  });

  app.post('/api/backtest/ab-compare', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      symbols?: unknown;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      costConfig?: Partial<TradingCostConfig>;
      riskConfig?: Partial<PortfolioRiskConfig>;
    };

    const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [];
    const symbols = rawSymbols
      .map((s) => String(s ?? '').trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      .slice(0, 15);

    try {
      const comparison = await backtestService.runSmcAbComparison({
        symbols:
          symbols.length > 0
            ? symbols
            : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
        timeframe: body.timeframe,
        mode: body.mode,
        exchange: body.exchange,
        barLimit: body.barLimit,
        costConfig: body.costConfig,
        riskConfig: body.riskConfig,
      });
      res.json(comparison);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'A/B 規則對比回測執行失敗';
      res.status(503).json({
        mode: 'live',
        isDemo: false,
        fallback: false,
        error: '即時資料不可用',
        apiError: '即時資料不可用',
        apiErrorDetail: msg,
        safety: TRADING_SAFETY_FLAGS,
      });
    }
  });

  // 7. Paper Trading Ledger Endpoints (Strictly PAPER ONLY / LIVE ORDERS DISABLED)
  app.get('/api/paper-ledger', (_req: Request, res: Response) => {
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entries: db.listPaperLedgerEntries(100),
      trackComparisonLive: db.getPaperTrackComparisonStats(false),
      trackComparisonAll: db.getPaperTrackComparisonStats(true),
    });
  });

  app.post('/api/paper-ledger', (req: Request, res: Response) => {
    const body = req.body as {
      symbol?: string;
      exchange?: ExchangeId;
      timeframe?: Timeframe;
      side?: 'LONG' | 'SHORT';
      category?: ScanCategory;
      actionState?: SmcActionState;
      strategyTrack?: PaperStrategyTrack;
      fillStatus?: PaperFillStatus;
      entryAnchorLabel?: string | null;
      ttlMinutes?: number | null;
      entryPrice?: number;
      invalidationPrice?: number;
      targetPrice?: number;
      ruleVersion?: string;
      evidences?: string[];
      notes?: string;
      provenance?: SymbolDetailResponse['provenance'];
      entryZoneStatus?: string;
      allowOverextendedMarketEntry?: boolean;
    };

    if (
      !body.symbol ||
      !body.entryPrice ||
      !body.invalidationPrice ||
      !body.targetPrice ||
      !body.provenance
    ) {
      res.status(400).json({
        error: '缺少紙上觀察紀錄必要欄位 (symbol, entryPrice, invalidationPrice, targetPrice, provenance)',
        safety: TRADING_SAFETY_FLAGS,
      });
      return;
    }

    const allowedTracks: PaperStrategyTrack[] = [
      'EARLY_IGNITION',
      'FORMAL_SMC_MARKET',
      'SMC_PULLBACK_LIMIT',
      'MANUAL_OBSERVATION',
    ];
    const safeTrack =
      body.strategyTrack && allowedTracks.includes(body.strategyTrack)
        ? body.strategyTrack
        : undefined;
    const safeFillStatus: PaperFillStatus | undefined =
      body.fillStatus === 'WAITING_LIMIT' || body.fillStatus === 'FILLED'
        ? body.fillStatus
        : undefined;

    if (
      body.entryZoneStatus === 'OVEREXTENDED' &&
      safeFillStatus !== 'WAITING_LIMIT' &&
      !body.allowOverextendedMarketEntry
    ) {
      res.status(400).json({
        error:
          '反追價保護攔截：目前價格已過度延伸 (OVEREXTENDED)，請改用 FVG/OB 回踩限價掛單 (WAITING_LIMIT)，或明確確認承受追高風險。',
        code: 'OVEREXTENDED_MARKET_ENTRY_BLOCKED',
        safety: TRADING_SAFETY_FLAGS,
      });
      return;
    }

    const safeTtlMinutes =
      typeof body.ttlMinutes === 'number' &&
      Number.isFinite(body.ttlMinutes) &&
      body.ttlMinutes > 0
        ? Math.min(10080, Math.max(15, Math.round(body.ttlMinutes)))
        : undefined;

    const entry = db.addPaperLedgerEntry({
      symbol: body.symbol.toUpperCase(),
      exchange: body.exchange ?? 'binance_usdm',
      timeframe: body.timeframe ?? '15m',
      side: body.side ?? 'LONG',
      category: body.category ?? '多頭候選',
      actionState: body.actionState ?? 'LONG CANDIDATE',
      strategyTrack: safeTrack,
      fillStatus: safeFillStatus,
      entryAnchorLabel:
        typeof body.entryAnchorLabel === 'string'
          ? body.entryAnchorLabel.slice(0, 120)
          : null,
      ttlMinutes: safeTtlMinutes,
      entryPrice: Number(body.entryPrice),
      invalidationPrice: Number(body.invalidationPrice),
      targetPrice: Number(body.targetPrice),
      ruleVersion: body.ruleVersion ?? MARKET_SCAN_RULE_VERSION,
      evidences: body.evidences ?? [],
      notes: body.notes,
      provenance: body.provenance,
    });

    if (db.getPositionSentinelConfig().autoSyncPaperLedger) {
      positionSentinel.syncPaperLedgerNow();
    }

    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entry,
      entries: db.listPaperLedgerEntries(100),
      trackComparisonLive: db.getPaperTrackComparisonStats(false),
      trackComparisonAll: db.getPaperTrackComparisonStats(true),
    });
  });

  app.post('/api/paper-ledger/:id/extend-ttl', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { extraMinutes } = (req.body || {}) as { extraMinutes?: number };
    const safeExtra =
      typeof extraMinutes === 'number' &&
      Number.isFinite(extraMinutes) &&
      extraMinutes > 0
        ? Math.min(1440, Math.max(15, Math.round(extraMinutes)))
        : 120;
    const updated = db.extendPaperLimitTtl(id, safeExtra);
    if (!updated) {
      res.status(404).json({ error: `找不到紙上紀錄 #${id}` });
      return;
    }
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entry: updated,
      entries: db.listPaperLedgerEntries(100),
      trackComparisonLive: db.getPaperTrackComparisonStats(false),
      trackComparisonAll: db.getPaperTrackComparisonStats(true),
    });
  });

  app.post('/api/paper-ledger/:id/close', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { exitPrice, notes } = req.body as {
      exitPrice?: number;
      notes?: string;
    };
    const updated = db.closePaperLedgerEntry(id, exitPrice, notes);
    if (!updated) {
      res.status(404).json({ error: `找不到紙上紀錄 #${id}` });
      return;
    }
    if (db.getPositionSentinelConfig().autoSyncPaperLedger) {
      positionSentinel.syncPaperLedgerNow();
    }
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entry: updated,
      entries: db.listPaperLedgerEntries(100),
      trackComparisonLive: db.getPaperTrackComparisonStats(false),
      trackComparisonAll: db.getPaperTrackComparisonStats(true),
    });
  });

  // 8. Background Scanner Scheduler Endpoints (Dry-Run Notifications Only)
  app.get('/api/scheduler/status', (_req: Request, res: Response) => {
    res.json(scheduler.getStatus());
  });

  app.post('/api/scheduler/control', async (req: Request, res: Response) => {
    const {
      action = 'run_once',
      exchange = 'binance_usdm',
      mode = 'live',
      intervalMs,
    } = req.body as {
      action?: 'start' | 'stop' | 'run_once';
      exchange?: ExchangeId;
      mode?: 'live' | 'demo';
      intervalMs?: number;
    };

    if (action === 'start') {
      const status = scheduler.start(exchange, mode, intervalMs);
      res.json(status);
      return;
    }
    if (action === 'stop') {
      const status = scheduler.stop();
      res.json(status);
      return;
    }

    const runRecord = await scheduler.runOnce(exchange, mode);
    res.json({
      ...scheduler.getStatus(),
      lastTriggeredRun: runRecord,
    });
  });

  // 9. Phase 3: Full-Market SMC/ICT Background Batch Queue & Cache Endpoints
  app.get('/api/smc-scan/status', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    const status = smcBatchScanner.getStatus(exchangeId, resolvedMode);
    if (
      resolvedMode === 'live' &&
      !options.skipViteMiddleware &&
      process.env.NODE_ENV !== 'test' &&
      status.workerState !== 'PAUSED' &&
      ((status.expiredCacheCount ?? 0) > 0 ||
        (status.staleCacheCount ?? 0) > 0 ||
        (status.prewarmRequiredCount ?? 0) > 0)
    ) {
      void smcBatchScanner
        .refreshExpiredCachesIfNeeded(exchangeId, { maxSymbolsPerRun: 40 })
        .catch(() => {});
    }
    const isCompactStatus =
      req.query.compact === '1' || req.query.compact === 'true';
    if (isCompactStatus) {
      res.json({
        ...status,
        pendingSymbols: [],
        stuckJobs: [],
        recentJobs: [],
        slowestSymbolsTop20: [],
        excludedSymbols: [],
        snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
      });
      return;
    }
    res.json({
      ...status,
      snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
    });
  });

  app.post('/api/smc-scan/start', async (req: Request, res: Response) => {
    const {
      exchange: rawExchange,
      mode: rawMode,
      watchlistSymbols,
      windowKey,
      forceRefresh = false,
      processBatchNow = false,
      batchLimit,
      config,
    } = (req.body ?? {}) as {
      exchange?: string;
      mode?: string;
      watchlistSymbols?: string[];
      windowKey?: string;
      forceRefresh?: boolean;
      processBatchNow?: boolean;
      batchLimit?: number;
      config?: Record<string, unknown>;
    };

    const { adapter, resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );

    if (config && typeof config === 'object') {
      smcBatchScanner.updateConfig(config);
    }

    try {
      if (
        resolvedMode === 'live' &&
        req.headers['x-simulate-exchange-failure'] === '1'
      ) {
        throw new ExchangeApiUnavailableError(
          'Binance Futures REST API HTTP 503 Service Unavailable',
          adapter.displayName,
          503
        );
      }

      const radarStartMs = Date.now();
      const snapshot = await adapter.fetchMarketSnapshot();
      const baseHistMap =
        resolvedMode === 'demo'
          ? buildDemoHistoricalVolumeMap()
          : db.getBulkHistoricalVolumeMap(exchangeId, 40, '15m');

      const smcMap = getExchangeSmcMap(exchangeId);
      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h: 0,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap: baseHistMap,
        smcMap,
      });
      const radarScanDurationMs = Math.max(0, Date.now() - radarStartMs);

      const existingSnap = db.getAtomicSmcSnapshot(exchangeId);
      const isWarmEligible =
        !forceRefresh &&
        existingSnap.fullUniverseStatus === 'COMPLETED' &&
        existingSnap.freshCacheCount >= snapshot.tickers.length &&
        snapshot.tickers.length > 0;
      const modeTag = isWarmEligible ? 'warm' : 'cold';
      const resolvedWindowKey =
        typeof windowKey === 'string' && windowKey
          ? windowKey
          : !forceRefresh && existingSnap.fullUniverseStatus === 'COMPLETED'
            ? `win_15m_${Math.floor(Date.now() / 900_000)}_${modeTag}_${Date.now()}`
            : undefined;

      smcBatchScanner.enqueueMarketUniverse({
        exchange: exchangeId,
        tickers: snapshot.tickers,
        candidates: preScan.candidates,
        watchlistSymbols,
        windowKey: resolvedWindowKey,
        forceRefresh: Boolean(forceRefresh),
        radarScanDurationMs,
        lastFullRadarScanAt: new Date().toISOString(),
      });

      if (processBatchNow) {
        await smcBatchScanner.processNextBatch(
          exchangeId,
          resolvedMode,
          typeof batchLimit === 'number' && batchLimit > 0
            ? batchLimit
            : undefined
        );
      }

      const status = await smcBatchScanner.startScan({
        exchange: exchangeId,
        mode: resolvedMode,
        watchlistSymbols,
        autoProcessLoop: !processBatchNow,
      });

      res.json(status);
    } catch (err) {
      if (err instanceof ExchangeApiUnavailableError) {
        res.status(503).json({
          safety: TRADING_SAFETY_FLAGS,
          error: err.message,
          provenance: {
            source: adapter.displayName,
            fetchedAt: new Date().toISOString(),
            stale: true,
            fallback: false,
            missingData: ['smc_batch_scan_start_unavailable'],
            isDemo: false,
          },
        });
        return;
      }
      res.status(500).json({
        safety: TRADING_SAFETY_FLAGS,
        error: err instanceof Error ? err.message : 'SMC 背景掃描啟動失敗',
      });
    }
  });

  app.post('/api/smc-scan/pause', async (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    smcBatchScanner.pauseScan(exchangeId, resolvedMode);
    await Promise.all([
      smcBatchScanner.waitForIdleTick(5000, exchangeId),
      paperShadowMonitor.waitForIdleCycle(5000),
    ]);
    res.json(smcBatchScanner.getStatus(exchangeId, resolvedMode));
  });

  app.post('/api/smc-scan/resume', async (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    const processBatchNow = Boolean(req.body?.processBatchNow);
    const batchLimit =
      typeof req.body?.batchLimit === 'number' && req.body.batchLimit > 0
        ? req.body.batchLimit
        : undefined;

    if (processBatchNow) {
      await smcBatchScanner.processNextBatch(
        exchangeId,
        resolvedMode,
        batchLimit
      );
    }
    const status = smcBatchScanner.resumeScan(
      exchangeId,
      resolvedMode,
      !processBatchNow
    );
    res.json(status);
  });

  app.post(
    '/api/smc-scan/refresh/:symbol',
    async (req: Request, res: Response) => {
      const symbol = String(req.params.symbol || '')
        .trim()
        .toUpperCase();
      const rawMode = req.body?.mode ?? req.query.mode;
      const rawExchange = req.body?.exchange ?? req.query.exchange;
      const { resolvedMode, exchangeId } = resolveAdapter(
        typeof rawMode === 'string' ? rawMode : 'live',
        typeof rawExchange === 'string' ? rawExchange : undefined
      );
      const executeImmediately = req.body?.executeImmediately !== false;

      if (!symbol) {
        res.status(400).json({ error: '缺少 symbol 參數' });
        return;
      }

      const refreshed = await smcBatchScanner.refreshSingleSymbol({
        symbol,
        exchange: exchangeId,
        mode: resolvedMode,
        executeImmediately,
      });

      res.json({
        safety: TRADING_SAFETY_FLAGS,
        symbol,
        exchange: exchangeId,
        mode: resolvedMode,
        ...refreshed,
      });
    }
  );

  // Phase 8 Fast Lane Endpoint: POST /api/smc-scan/priority-refresh/:symbol
  app.post(
    '/api/smc-scan/priority-refresh/:symbol',
    async (req: Request, res: Response) => {
      const symbol = String(req.params.symbol || '')
        .trim()
        .toUpperCase();
      const rawMode = req.body?.mode ?? req.query.mode;
      const rawExchange = req.body?.exchange ?? req.query.exchange;
      const { resolvedMode, exchangeId } = resolveAdapter(
        typeof rawMode === 'string' ? rawMode : 'live',
        typeof rawExchange === 'string' ? rawExchange : undefined
      );
      const executeImmediately = req.body?.executeImmediately !== false;
      const forceRefresh = Boolean(req.body?.forceRefresh);

      if (!symbol) {
        res.status(400).json({ error: '缺少 symbol 參數' });
        return;
      }

      const priorityRes = await smcBatchScanner.priorityRefreshSymbol({
        symbol,
        exchange: exchangeId,
        mode: resolvedMode,
        executeImmediately,
        forceRefresh,
      });

      res.json({
        safety: TRADING_SAFETY_FLAGS,
        symbol,
        exchange: exchangeId,
        mode: resolvedMode,
        deduplicated: priorityRes.deduplicated,
        queueEnteredAt:
          priorityRes.result?.queueEnteredAt ??
          priorityRes.job?.queueEnteredAt ??
          priorityRes.job?.requestedAt ??
          null,
        smcEvaluationStartedAt:
          priorityRes.result?.smcEvaluationStartedAt ??
          priorityRes.job?.smcEvaluationStartedAt ??
          priorityRes.job?.startedAt ??
          null,
        smcEvaluationCompletedAt:
          priorityRes.result?.smcEvaluationCompletedAt ??
          priorityRes.job?.smcEvaluationCompletedAt ??
          priorityRes.job?.completedAt ??
          null,
        queueWaitMs:
          priorityRes.result?.queueWaitMs ??
          priorityRes.job?.queueWaitMs ??
          null,
        httpRequestLatencyMs:
          priorityRes.result?.httpRequestLatencyMs ??
          priorityRes.job?.httpRequestLatencyMs ??
          null,
        smcEvaluationLatencyMs:
          priorityRes.result?.smcEvaluationLatencyMs ??
          priorityRes.job?.smcEvaluationLatencyMs ??
          null,
        detectionLatencyMs:
          priorityRes.result?.detectionLatencyMs ??
          priorityRes.job?.detectionLatencyMs ??
          null,
        job: priorityRes.job,
        result: priorityRes.result,
        status: priorityRes.status,
      });
    }
  );

  app.get('/api/smc-scan/result/:symbol', (req: Request, res: Response) => {
    const symbol = String(req.params.symbol || '')
      .trim()
      .toUpperCase();
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );

    const response = smcBatchScanner.getSymbolResult(
      exchangeId,
      symbol,
      resolvedMode
    );
    res.json(response);
  });

  app.get('/api/smc-scan/diagnostics', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { exchangeId } = resolveAdapter(modeParam, exchangeParam);
    res.json(db.computePhase6Diagnostics(exchangeId));
  });

  // Phase 16: Background SMC Scan Progress, Worker Health, Pending Reasons, Stuck Jobs & Safe Retry Endpoints
  app.get('/api/smc-scan/progress', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    const prog = smcBatchScanner.getProgressAndHealth(exchangeId, resolvedMode);
    res.json({
      ...prog,
      cycleId: prog.scanCycleId,
      statsConsistency: prog.statsConsistency ?? ('VALID' as const),
      consistencyErrors: prog.consistencyErrors ?? ([] as string[]),
      snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
    });
  });

  app.get('/api/smc-scan/health', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    const health = smcBatchScanner.getProgressAndHealth(
      exchangeId,
      resolvedMode
    );
    res.json({
      ...health,
      cycleId: health.scanCycleId,
      statsConsistency: health.statsConsistency ?? ('VALID' as const),
      consistencyErrors: health.consistencyErrors ?? ([] as string[]),
      snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
    });
  });

  app.get('/api/smc-scan/pending-reasons', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    res.json(smcBatchScanner.getPendingReasons(exchangeId, resolvedMode));
  });

  app.get('/api/smc-scan/stuck-jobs', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    res.json(smcBatchScanner.getStuckJobs(exchangeId, resolvedMode));
  });

  app.post('/api/smc-scan/retry-stuck', (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    const stalledThresholdMs =
      typeof req.body?.stalledThresholdMs === 'number' &&
      req.body.stalledThresholdMs >= 1000
        ? req.body.stalledThresholdMs
        : undefined;
    const retryResponse = smcBatchScanner.retryStuckJobs({
      exchange: exchangeId,
      mode: resolvedMode,
      stalledThresholdMs,
    });
    res.json(retryResponse);
  });

  // Phase 17: SQLite Consistency, Database Health & Safe Backup Endpoints
  app.get('/api/system/database-health', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    res.json(smcBatchScanner.getDatabaseHealth(exchangeId, resolvedMode));
  });

  app.post('/api/system/database-check', (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    const createBackup = req.body?.createBackup !== false;
    const simulateBusyRetries =
      typeof req.body?.simulateBusyRetries === 'number' &&
      req.body.simulateBusyRetries > 0
        ? req.body.simulateBusyRetries
        : 0;
    res.json(
      smcBatchScanner.runDatabaseCheck({
        exchange: exchangeId,
        mode: resolvedMode,
        createBackup,
        simulateBusyRetries,
      })
    );
  });

  app.get('/api/system/watchdog/status', (_req: Request, res: Response) => {
    res.json(systemWatchdog.getStatus());
  });

  app.post('/api/system/watchdog/config', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Omit<WatchdogConfig, 'updatedAt'>> = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.heartbeatIntervalMs === 'number') {
      patch.heartbeatIntervalMs = body.heartbeatIntervalMs;
    }
    if (typeof body.autoBackupIntervalMs === 'number') {
      patch.autoBackupIntervalMs = body.autoBackupIntervalMs;
    }
    if (typeof body.alertOnStall === 'boolean') {
      patch.alertOnStall = body.alertOnStall;
    }
    if (typeof body.alertOnDbRecovery === 'boolean') {
      patch.alertOnDbRecovery = body.alertOnDbRecovery;
    }
    if (typeof body.alertOnApiErrorSpike === 'boolean') {
      patch.alertOnApiErrorSpike = body.alertOnApiErrorSpike;
    }
    if (typeof body.apiErrorSpikeThreshold === 'number') {
      patch.apiErrorSpikeThreshold = body.apiErrorSpikeThreshold;
    }
    res.json(systemWatchdog.updateConfig(patch));
  });

  app.post('/api/system/watchdog/run-check', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await systemWatchdog.runWatchdogTick({
      forceHeartbeat: body.forceHeartbeat === true,
      forceBackup: body.forceBackup === true,
    });
    res.json(result);
  });

  app.get('/api/validation/readiness', (req: Request, res: Response) => {
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : 'binance_usdm';
    const exchangeId: ExchangeId =
      exchangeParam === 'bybit_linear' || exchangeParam === 'bingx_swap'
        ? exchangeParam
        : 'binance_usdm';

    const allReports = backtestDb.listBacktestRuns(60);
    const realReports = allReports.filter(
      (r) =>
        !r.provenance?.isDemo &&
        r.dataClassification === 'REAL' &&
        r.status === 'COMPLETED' &&
        (r.totalTrades ?? 0) > 0
    );
    const latestRealTotalTrades = realReports.reduce(
      (acc, r) => acc + (r.totalTrades ?? 0),
      0
    );
    const weightedRealNetR = realReports.reduce(
      (acc, r) =>
        acc +
        (r.netExpectancyR ?? r.expectancyR ?? 0) * (r.totalTrades ?? 0),
      0
    );
    const latestRealNetExp =
      latestRealTotalTrades > 0
        ? Number((weightedRealNetR / latestRealTotalTrades).toFixed(2))
        : null;
    const weightedRealPf = realReports.reduce(
      (acc, r) =>
        acc + (r.netProfitFactor ?? r.profitFactor ?? 0) * (r.totalTrades ?? 0),
      0
    );
    const latestRealNetPf =
      latestRealTotalTrades > 0
        ? Number((weightedRealPf / latestRealTotalTrades).toFixed(2))
        : null;

    const liveTrackStats = db.getPaperTrackComparisonStats(false);
    const liveLedgerEntries = db
      .listPaperLedgerEntries(500)
      .filter((e) => !e.isDemo);
    const waitingLimitCount = liveLedgerEntries.filter(
      (e) => e.status === 'OPEN' && e.fillStatus === 'WAITING_LIMIT'
    ).length;
    const settledLedger = liveLedgerEntries.filter(
      (e) =>
        (e.fillStatus ?? 'FILLED') === 'FILLED' && e.status !== 'OPEN'
    );
    const settledPaperTradesCount = settledLedger.length;
    const liveTotalNetR = settledLedger.reduce(
      (acc, e) => acc + (e.netPnlR ?? e.pnlR),
      0
    );
    const liveNetExp =
      settledPaperTradesCount > 0
        ? Number((liveTotalNetR / settledPaperTradesCount).toFixed(2))
        : null;
    const liveNetWinSum = settledLedger
      .filter((e) => (e.netPnlR ?? e.pnlR) > 0)
      .reduce((acc, e) => acc + (e.netPnlR ?? e.pnlR), 0);
    const liveNetLossSum = Math.abs(
      settledLedger
        .filter((e) => (e.netPnlR ?? e.pnlR) <= 0)
        .reduce((acc, e) => acc + (e.netPnlR ?? e.pnlR), 0)
    );
    const liveNetPf =
      settledPaperTradesCount > 0
        ? liveNetLossSum > 0
          ? Number((liveNetWinSum / liveNetLossSum).toFixed(2))
          : liveNetWinSum > 0
            ? 99.9
            : 0
        : null;

    const trackedLiveSignals = paperMonitorDb.listTrackedSignals({
      exchange: exchangeId,
      includeBlocked: false,
      limit: 500,
    });
    const totalTrackedSignals = trackedLiveSignals.length;
    const missedWindowCount = trackedLiveSignals.filter(
      (s) => s.status === 'ENTRY_WINDOW_MISSED'
    ).length;
    const captureRatePercent =
      totalTrackedSignals > 0
        ? Number(
            (
              ((totalTrackedSignals - missedWindowCount) /
                totalTrackedSignals) *
              100
            ).toFixed(1)
          )
        : null;

    const dbHealth = smcBatchScanner.getDatabaseHealth(exchangeId, 'live');
    const watchdogStatus = systemWatchdog.getStatus();

    const effectiveNetExp = liveNetExp ?? latestRealNetExp;
    const effectiveNetPf = liveNetPf ?? latestRealNetPf;

    const crit1: ValidationReadinessCriterion = {
      id: 'NET_EXPECTANCY_POSITIVE',
      titleZh: '1. 扣成本淨期望值 > 0 且淨 Profit Factor >= 1.2',
      status:
        effectiveNetExp === null || effectiveNetPf === null
          ? 'PENDING'
          : effectiveNetExp > 0 && effectiveNetPf >= 1.2
            ? 'PASSED'
            : effectiveNetExp > 0 || effectiveNetPf >= 1.0
              ? 'PARTIAL'
              : 'FAILED',
      currentValueLabel:
        effectiveNetExp !== null && effectiveNetPf !== null
          ? `淨期望值 ${effectiveNetExp > 0 ? '+' : ''}${effectiveNetExp}R · 淨PF ${effectiveNetPf}`
          : '尚無已結算淨報酬資料',
      targetThresholdLabel: 'Net Expectancy > 0R 且 Net PF >= 1.2',
      detailZh:
        liveNetExp !== null
          ? `優先依據 Live Paper 實盤淨報酬統計（並結合實盤回測加權驗證）。`
          : `目前依據真實歷史回測 (REAL) 扣除手續費、滑點與資金費率之淨績效計算。`,
    };

    const totalCombinedSamples =
      settledPaperTradesCount + latestRealTotalTrades;
    const crit2: ValidationReadinessCriterion = {
      id: 'STATISTICAL_SAMPLE_SIZE',
      titleZh: '2. 實盤與歷史樣本數達統計可信規模',
      status:
        settledPaperTradesCount >= 30 || totalCombinedSamples >= 100
          ? 'PASSED'
          : totalCombinedSamples >= 30 || settledPaperTradesCount >= 10
            ? 'PARTIAL'
            : 'PENDING',
      currentValueLabel: `Live已平倉 ${settledPaperTradesCount} 筆 · 真實回測 ${latestRealTotalTrades} 筆`,
      targetThresholdLabel: 'Live >= 30 筆 或 真實樣本合計 >= 100 筆',
      detailZh:
        '樣本過少易受短期行情變異誤導，需累積足夠交易筆數跨越不同盤整與趨勢週期。',
    };

    const crit3: ValidationReadinessCriterion = {
      id: 'LIVE_EXECUTION_CAPTURE',
      titleZh: '3. 實盤訊號進場捕捉率 >= 85%（消除窗口錯過瓶頸）',
      status:
        totalTrackedSignals === 0 && waitingLimitCount === 0
          ? 'PENDING'
          : captureRatePercent !== null && captureRatePercent >= 85
            ? 'PASSED'
            : captureRatePercent !== null && captureRatePercent >= 60
              ? 'PARTIAL'
              : 'FAILED',
      currentValueLabel:
        captureRatePercent !== null
          ? `捕捉率 ${captureRatePercent}% (錯過 ${missedWindowCount}/${totalTrackedSignals} · 待回踩掛單 ${waitingLimitCount})`
          : `待回踩自動掛單 ${waitingLimitCount} 筆`,
      targetThresholdLabel: '進場捕捉率 >= 85%',
      detailZh:
        '已啟用 3 秒 15m 收線邊界偵測、未來未開盤 Bar 延後進場及 FVG/OB 自動回踩限價掛單。',
    };

    const pfNetExp = latestPortfolioBacktestResult?.netExpectancyR ?? null;
    const pfTrades = latestPortfolioBacktestResult?.acceptedTradesCount ?? 0;
    const crit4: ValidationReadinessCriterion = {
      id: 'PORTFOLIO_RISK_DISCIPLINE',
      titleZh: '4. 多幣種組合風控回測 (並發/同向/日回撤熔斷)',
      status: !latestPortfolioBacktestResult
        ? 'PENDING'
        : pfTrades > 0 &&
            (pfNetExp ?? 0) > 0 &&
            (latestPortfolioBacktestResult.netMaxDrawdownR ?? 99) <= 6
          ? 'PASSED'
          : pfTrades > 0
            ? 'PARTIAL'
            : 'PENDING',
      currentValueLabel: latestPortfolioBacktestResult
        ? `接受 ${pfTrades} 筆 / 攔截 ${latestPortfolioBacktestResult.blockedByRiskCapCount} 筆 · Net MDD ${latestPortfolioBacktestResult.netMaxDrawdownR ?? '-'}R`
        : '尚未執行多幣種組合回測',
      targetThresholdLabel: '組合 Net Expectancy > 0R 且 Net MDD <= 6R',
      detailZh: latestPortfolioBacktestResult
        ? `最近組合涵蓋 ${latestPortfolioBacktestResult.symbolsRequested.length} 幣種 (${latestPortfolioBacktestResult.mtfHistoricalAlignedCount} 檔通過 1h/4h 歷史對齊)。`
        : '請至回測驗證分頁執行「多幣種組合回測」以驗證跨幣種同方向與日回撤熔斷表現。',
    };

    const crit5: ValidationReadinessCriterion = {
      id: 'OPERATIONAL_STABILITY',
      titleZh: '5. 7×24 資料庫完整性、自動備份與 Watchdog 巡檢',
      status:
        dbHealth.integrityCheck === 'ok' &&
        !dbHealth.stalledSuspected &&
        watchdogStatus.config.enabled &&
        watchdogStatus.lastAutoBackupAt !== null
          ? 'PASSED'
          : dbHealth.integrityCheck === 'ok' && !dbHealth.stalledSuspected
            ? 'PARTIAL'
            : 'FAILED',
      currentValueLabel: `DB ${dbHealth.integrityCheck.toUpperCase()} · 恢復 ${dbHealth.lifetimeDatabaseRecoveryCount} 次 · 備份 ${watchdogStatus.autoBackupsCount} 次`,
      targetThresholdLabel: 'integrity=ok · 無卡死 · Watchdog 與自動備份啟用',
      detailZh:
        watchdogStatus.lastAutoBackupAt !== null
          ? `Watchdog 運作中，最近熱備份時間 ${watchdogStatus.lastAutoBackupAt}。`
          : 'Watchdog 已啟用，建議於系統健康分頁執行一次「Watchdog 檢查與備份」完成首次備份確認。',
    };

    const criteria = [crit1, crit2, crit3, crit4, crit5];
    const passedCount = criteria.filter((c) => c.status === 'PASSED').length;
    const scorePoints = criteria.reduce(
      (acc, c) => acc + (c.status === 'PASSED' ? 1 : c.status === 'PARTIAL' ? 0.5 : 0),
      0
    );
    const readinessScorePercent = Math.round((scorePoints / criteria.length) * 100);
    const overallStatus: ValidationReadinessResponse['overallStatus'] =
      passedCount === criteria.length
        ? 'VALIDATED'
        : passedCount >= 2 || scorePoints >= 2.0
          ? 'IN_PROGRESS'
          : 'NOT_READY';

    const payload: ValidationReadinessResponse = {
      safety: TRADING_SAFETY_FLAGS,
      evaluatedAt: new Date().toISOString(),
      overallStatus,
      passedCount,
      totalCount: criteria.length,
      readinessScorePercent,
      livePaperStats: {
        totalTrackedSignals,
        missedWindowCount,
        captureRatePercent,
        settledPaperTradesCount,
        waitingLimitCount,
        netExpectancyR: liveTrackStats.tracks
          .filter((t) => t.track !== 'MANUAL_OBSERVATION' && t.closedCount > 0)
          .length > 0
          ? liveNetExp
          : null,
        netProfitFactor: liveNetPf,
      },
      backtestStats: {
        latestRealBacktestCount: realReports.length,
        latestRealNetExpectancyR: latestRealNetExp,
        latestRealNetProfitFactor: latestRealNetPf,
        latestRealTradeCount: latestRealTotalTrades,
      },
      criteria,
    };
    res.json(payload);
  });

  app.get('/api/system/monitoring-windows', (req: Request, res: Response) => {
    const modeParam =
      typeof req.query.mode === 'string' ? req.query.mode : 'live';
    const exchangeParam =
      typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
    const { resolvedMode, exchangeId } = resolveAdapter(
      modeParam,
      exchangeParam
    );
    if (resolvedMode === 'demo' || exchangeId === 'demo_synthetic') {
      res.status(400).json({
        safety: TRADING_SAFETY_FLAGS,
        error: '安全攔截：Live Paper 24h/72h 監控窗口嚴禁使用 Demo 模擬資料',
      });
      return;
    }
    res.json(smcBatchScanner.getMonitoringWindowsList(exchangeId, Date.now()));
  });

  app.get(
    '/api/system/monitoring-windows/:monitoringWindowId',
    (req: Request, res: Response) => {
      const monitoringWindowId = String(
        req.params.monitoringWindowId || ''
      ).trim();
      if (!monitoringWindowId) {
        res.status(400).json({
          safety: TRADING_SAFETY_FLAGS,
          error: '缺少 monitoringWindowId 參數',
        });
        return;
      }
      const detail = smcBatchScanner.getMonitoringWindowDetail(
        monitoringWindowId,
        Date.now()
      );
      if (!detail) {
        res.status(404).json({
          safety: TRADING_SAFETY_FLAGS,
          error: `找不到監控窗口 ${monitoringWindowId}`,
        });
        return;
      }
      res.json(detail);
    }
  );

  app.post(
    '/api/system/monitoring-windows/start',
    (req: Request, res: Response) => {
      const rawMode = req.body?.mode ?? req.query.mode;
      const rawExchange = req.body?.exchange ?? req.query.exchange;
      const { resolvedMode, exchangeId } = resolveAdapter(
        typeof rawMode === 'string' ? rawMode : 'live',
        typeof rawExchange === 'string' ? rawExchange : undefined
      );
      if (resolvedMode === 'demo' || exchangeId === 'demo_synthetic') {
        res.status(400).json({
          safety: TRADING_SAFETY_FLAGS,
          error: '安全攔截：Live Paper 24h/72h 監控窗口嚴禁使用 Demo 模擬資料',
        });
        return;
      }
      const existingList = smcBatchScanner.getMonitoringWindowsList(
        exchangeId,
        Date.now()
      );
      const current24h = existingList.currentWindows['24h'];
      const current72h = existingList.currentWindows['72h'];
      const force = Boolean(req.body?.force);
      // Do not overwrite or interrupt an active RUNNING window unless force=true or current window is terminal (FAILED/INTERRUPTED)
      if (
        force ||
        current24h.windowStatus !== 'RUNNING' ||
        current72h.windowStatus !== 'RUNNING'
      ) {
        smcBatchScanner.startNewMonitoringWindows(exchangeId, Date.now());
      }
      smcBatchScanner.captureProgressEvidenceSample(
        exchangeId,
        'live',
        Date.now()
      );
      res.json(smcBatchScanner.getDatabaseHealth(exchangeId, 'live'));
    }
  );

  app.post('/api/system/graceful-restart', (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    const planned = req.body?.planned !== false;
    const triggerReason =
      req.body?.triggerReason === 'UNEXPECTED_CRASH_RECOVERY' ||
      req.body?.triggerReason === 'STUCK_LEASE_RECOVERY' ||
      req.body?.triggerReason === 'MANUAL_RETRY_STUCK' ||
      req.body?.triggerReason === 'STARTUP_RECOVERY'
        ? req.body.triggerReason
        : 'GRACEFUL_SHUTDOWN_RESTART';

    if (planned && triggerReason === 'GRACEFUL_SHUTDOWN_RESTART') {
      smcBatchScanner.gracefulShutdown(exchangeId, 'planned_graceful_restart');
    } else {
      smcBatchScanner.stop();
    }

    const recovery = smcBatchScanner.restartAndRecover({
      exchange: exchangeId,
      mode: resolvedMode,
      triggerReason,
      planned,
      serviceStoppedNormally: planned,
      resumeWorker: true,
    });
    const health = smcBatchScanner.runDatabaseCheck({
      exchange: exchangeId,
      mode: resolvedMode,
      createBackup: true,
    });
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      recovery,
      databaseHealth: health,
    });
  });

  // 10. Phase 5 & Phase 6: Paper Shadow Monitor, Signal Outcome Tracker & Notification Sandbox Endpoints
  app.get('/api/paper-monitor/status', (_req: Request, res: Response) => {
    const st = paperShadowMonitor.getStatus();
    res.json({
      ...st,
      consistencyErrors:
        (st as { consistencyErrors?: string[] }).consistencyErrors ?? [],
      snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
    });
  });

  app.get('/api/paper-monitor/diagnostics', (_req: Request, res: Response) => {
    res.json(paperShadowMonitor.getDiagnostics());
  });

  app.post('/api/paper-monitor/start', async (req: Request, res: Response) => {
    const {
      exchange,
      runImmediateCycle = true,
      maxSymbolsPerCycle = 6,
      simulateHttpStatus,
    } = (req.body ?? {}) as {
      exchange?: ExchangeId;
      runImmediateCycle?: boolean;
      maxSymbolsPerCycle?: number;
      simulateHttpStatus?: 429 | 503;
    };

    try {
      if (exchange === 'demo_synthetic' || req.body?.mode === 'demo') {
        res.status(400).json({
          ...paperShadowMonitor.getStatus(),
          error:
            '安全攔截：Paper Shadow Monitor 嚴禁將 Demo 模擬資料混入 Live 影子運行',
        });
        return;
      }

      if (simulateHttpStatus === 429 || simulateHttpStatus === 503) {
        await paperShadowMonitor.start({
          exchange,
          runImmediateCycle: false,
        });
        const statusAfterSim = await paperShadowMonitor.runSingleCycle({
          maxSymbolsToEvaluate: maxSymbolsPerCycle,
          simulateHttpStatus,
        });
        res.status(simulateHttpStatus === 503 ? 503 : 200).json(statusAfterSim);
        return;
      }

      const status = await paperShadowMonitor.start({
        exchange,
        runImmediateCycle: Boolean(runImmediateCycle),
        maxSymbolsPerCycle: Number(maxSymbolsPerCycle) || 6,
      });
      res.json(status);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Paper Shadow Monitor 啟動失敗';
      res.status(503).json({
        ...paperShadowMonitor.getStatus(),
        error: msg,
      });
    }
  });

  app.post('/api/paper-monitor/pause', (_req: Request, res: Response) => {
    res.json(paperShadowMonitor.pause());
  });

  app.post('/api/paper-monitor/resume', async (req: Request, res: Response) => {
    const {
      runImmediateCycle = false,
      maxSymbolsPerCycle = 6,
    } = (req.body ?? {}) as {
      runImmediateCycle?: boolean;
      maxSymbolsPerCycle?: number;
    };
    const status = await paperShadowMonitor.resume({
      runImmediateCycle: Boolean(runImmediateCycle),
      maxSymbolsPerCycle: Number(maxSymbolsPerCycle) || 6,
    });
    res.json(status);
  });

  app.get('/api/paper-monitor/signals', (req: Request, res: Response) => {
    const statusEnv = paperShadowMonitor.getStatus();
    const includeBlocked = req.query.includeBlocked !== 'false';
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;

    const signals = paperMonitorDb.listTrackedSignals({
      exchange: statusEnv.exchange,
      includeBlocked,
      limit,
    });

    res.json({
      databaseInstanceId: statusEnv.databaseInstanceId,
      monitorRunId: statusEnv.monitorRunId,
      scanRunId: statusEnv.scanRunId,
      snapshotAt: new Date().toISOString(),
      statsVersion: statusEnv.statsVersion,
      mode: 'PAPER ONLY' as const,
      liveOrders: 'LIVE ORDERS DISABLED' as const,
      executionPolicy: 'NEVER AUTO-PLACE ORDERS' as const,
      safety: TRADING_SAFETY_FLAGS,
      signals,
    });
  });

  const resolveOptionalReportAnchorAt = (
    req: Request,
    res: Response
  ): { valid: boolean; reportAnchorAt?: string } => {
    const raw = req.query.reportAnchorAt;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return { valid: true, reportAnchorAt: undefined };
    }
    const parsedMs = Date.parse(String(raw));
    if (!Number.isFinite(parsedMs)) {
      res.status(400).json({
        safety: TRADING_SAFETY_FLAGS,
        mode: 'PAPER ONLY',
        liveOrders: 'LIVE ORDERS DISABLED',
        executionPolicy: 'NEVER AUTO-PLACE ORDERS',
        error: '無效的 reportAnchorAt 時間格式，必須為有效 ISO 8601 時間字串',
      });
      return { valid: false };
    }
    return { valid: true, reportAnchorAt: new Date(parsedMs).toISOString() };
  };

  app.get('/api/paper-monitor/report', (req: Request, res: Response) => {
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const rawWindow = String(req.query.window || '24h').toLowerCase();
    const window: PaperMonitorReportWindow =
      rawWindow === '90d'
        ? '90d'
        : rawWindow === '60d'
          ? '60d'
          : rawWindow === '30d'
            ? '30d'
            : rawWindow === '7d'
              ? '7d'
              : '24h';
    res.json(
      paperShadowMonitor.getReport(window, Date.now(), anchor.reportAnchorAt)
    );
  });

  app.get('/api/paper-monitor/window-report', (_req: Request, res: Response) => {
    res.json(paperShadowMonitor.get24hWindowReport());
  });

  app.get('/api/validation/phase7-report', (_req: Request, res: Response) => {
    res.json(paperShadowMonitor.get24hWindowReport());
  });

  app.get('/api/paper-monitor/health', (_req: Request, res: Response) => {
    res.json(paperShadowMonitor.getHealth());
  });

  // 11. Phase 11: SMC Candidate Scarcity Reason Analysis, Gate Pass Rate & Long-Term Paper Quality Monitoring Endpoints
  const resolveLiveQualityExchange = (
    req: Request,
    res: Response
  ): ExchangeId | null => {
    const rawMode = String(req.query.mode || 'live').toLowerCase();
    const rawExchange = String(req.query.exchange || '').toLowerCase();
    if (rawMode === 'demo' || rawExchange === 'demo_synthetic') {
      res.status(400).json({
        safety: TRADING_SAFETY_FLAGS,
        mode: 'PAPER ONLY',
        liveOrders: 'LIVE ORDERS DISABLED',
        executionPolicy: 'NEVER AUTO-PLACE ORDERS',
        error:
          '安全攔截：Live SMC 品質與 Gate 統計嚴禁混入 Demo / demo_synthetic 模擬資料',
      });
      return null;
    }
    if (rawExchange === 'bybit_linear' || rawExchange === 'bingx_swap') {
      return rawExchange as ExchangeId;
    }
    return 'binance_usdm';
  };

  app.get('/api/smc-quality/gate-stats', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const rawWindow = String(req.query.window || '7d').toLowerCase();
    const window: PaperMonitorReportWindow =
      rawWindow === '30d' ? '30d' : rawWindow === '24h' ? '24h' : '7d';
    res.json(
      paperShadowMonitor.getSmcQualityGateStats(ex, Date.now(), {
        window,
        reportAnchorAt: anchor.reportAnchorAt,
      })
    );
  });

  app.get('/api/smc-quality/reason-stats', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const rawWindow = String(req.query.window || '7d').toLowerCase();
    const window: PaperMonitorReportWindow =
      rawWindow === '30d' ? '30d' : rawWindow === '24h' ? '24h' : '7d';
    res.json(
      paperShadowMonitor.getSmcQualityReasonStats(ex, Date.now(), {
        window,
        reportAnchorAt: anchor.reportAnchorAt,
      })
    );
  });

  app.get('/api/smc-quality/cycle-history', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const rawWindow = String(req.query.window || '7d').toLowerCase();
    const window: PaperMonitorReportWindow =
      rawWindow === '30d' ? '30d' : rawWindow === '24h' ? '24h' : '7d';
    res.json(
      paperShadowMonitor.getSmcQualityCycleHistory(ex, Date.now(), {
        window,
        reportAnchorAt: anchor.reportAnchorAt,
      })
    );
  });

  const parseQualityWindow = (
    raw: unknown,
    defaultWin: PaperMonitorReportWindow = '7d'
  ): PaperMonitorReportWindow => {
    const s = String(raw || defaultWin).toLowerCase();
    if (s === '90d') return '90d';
    if (s === '60d') return '60d';
    if (s === '30d') return '30d';
    if (s === '24h') return '24h';
    if (s === '7d') return '7d';
    return defaultWin;
  };

  app.get('/api/smc-quality/signal-latency', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const window = parseQualityWindow(req.query.window, '7d');
    res.json(
      paperShadowMonitor.getSmcQualitySignalLatency(ex, Date.now(), {
        window,
        reportAnchorAt: anchor.reportAnchorAt,
      })
    );
  });

  app.get('/api/smc-quality/report', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const window = parseQualityWindow(req.query.window, '7d');
    res.json(
      paperShadowMonitor.getSmcQualityWindowReport(
        window,
        ex,
        Date.now(),
        anchor.reportAnchorAt
      )
    );
  });

  // 12. Phase 12–14: Long-Term Paper Signal Quality, Aggregation Semantics, Cycles, Gate Drift & Lifecycle History Endpoints
  const parseAggregationMode = (
    raw: unknown
  ): EvaluationAggregationMode | undefined => {
    const val = String(raw ?? '').trim().toUpperCase();
    if (
      val === 'LATEST_CYCLE' ||
      val === 'DEDUPED_SYMBOLS' ||
      val === 'CUMULATIVE_EVENTS'
    ) {
      return val as EvaluationAggregationMode;
    }
    return undefined;
  };

  app.get('/api/paper-quality/status', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const aggregationMode = parseAggregationMode(req.query.aggregationMode);
    res.json(
      paperShadowMonitor.getPaperQualityStatus(
        ex,
        Date.now(),
        anchor.reportAnchorAt,
        { aggregationMode }
      )
    );
  });

  app.get('/api/paper-quality/report', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const window = parseQualityWindow(
      req.query.window,
      '30d'
    ) as PaperQualityWindow;
    const aggregationMode = parseAggregationMode(req.query.aggregationMode);
    res.json(
      paperShadowMonitor.getPaperQualityReport(
        window,
        ex,
        Date.now(),
        anchor.reportAnchorAt,
        { aggregationMode }
      )
    );
  });

  app.get('/api/paper-quality/cycles', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const window = parseQualityWindow(
      req.query.window,
      '30d'
    ) as PaperQualityWindow;
    res.json(
      paperShadowMonitor.getPaperQualityCycles(ex, Date.now(), {
        window,
        reportAnchorAt: anchor.reportAnchorAt,
      })
    );
  });

  app.get(
    '/api/paper-quality/cycles/:cycleId',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      const anchor = resolveOptionalReportAnchorAt(req, res);
      if (!anchor.valid) return;
      const cycleId = String(req.params.cycleId ?? '').trim();
      const cycleResp = paperShadowMonitor.getPaperQualityCycleById(
        cycleId,
        ex,
        Date.now(),
        {
          reportAnchorAt: anchor.reportAnchorAt,
        }
      );
      if (!cycleResp) {
        return res.status(404).json({
          error: 'CYCLE_NOT_FOUND',
          message: `找不到指定的掃描週期明細 (${cycleId})`,
          mode: 'PAPER ONLY',
          liveOrders: 'LIVE ORDERS DISABLED',
          executionPolicy: 'NEVER AUTO-PLACE ORDERS',
        });
      }
      res.json(cycleResp);
    }
  );

  app.get('/api/paper-quality/gate-drift', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const rawThreshold = Number(req.query.driftThresholdPercent);
    const driftThresholdPercent =
      Number.isFinite(rawThreshold) && rawThreshold > 0
        ? rawThreshold
        : undefined;
    const gd = paperShadowMonitor.getPaperQualityGateDrift(ex, Date.now(), {
      reportAnchorAt: anchor.reportAnchorAt,
      driftThresholdPercent,
    });
    res.json({
      ...gd,
      consistencyErrors:
        (gd as { consistencyErrors?: string[] }).consistencyErrors ?? [],
      snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT' as const,
    });
  });

  app.get(
    '/api/paper-quality/market-regimes',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      const anchor = resolveOptionalReportAnchorAt(req, res);
      if (!anchor.valid) return;
      const window = parseQualityWindow(
        req.query.window,
        '30d'
      ) as PaperQualityWindow;
      res.json(
        paperShadowMonitor.getPaperQualityMarketRegimes(
          window,
          ex,
          Date.now(),
          anchor.reportAnchorAt
        )
      );
    }
  );

  app.get('/api/paper-quality/signals', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    const window = parseQualityWindow(
      req.query.window,
      '30d'
    ) as PaperQualityWindow;
    res.json(
      paperShadowMonitor.getPaperQualitySignals(
        window,
        ex,
        Date.now(),
        anchor.reportAnchorAt
      )
    );
  });

  app.get(
    '/api/paper-quality/signal-history',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      const anchor = resolveOptionalReportAnchorAt(req, res);
      if (!anchor.valid) return;
      const window = parseQualityWindow(req.query.window, '30d');
      res.json(
        paperShadowMonitor.getPaperQualitySignalHistory(
          window,
          ex,
          Date.now(),
          anchor.reportAnchorAt
        )
      );
    }
  );

  app.get('/api/paper-quality/export', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    const anchor = resolveOptionalReportAnchorAt(req, res);
    if (!anchor.valid) return;
    res.json(
      paperShadowMonitor.getPaperQualityExport(
        ex,
        Date.now(),
        anchor.reportAnchorAt
      )
    );
  });

  // Phase 18.4 & Phase 18.5: Real Live Candidate Observation, Capture SLA Verification & Signal Quality Decision Endpoints
  app.get('/api/paper-quality/live-capture', (req: Request, res: Response) => {
    const ex = resolveLiveQualityExchange(req, res);
    if (!ex) return;
    res.json(
      paperShadowMonitor.getLiveCaptureObservation(ex, {
        snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT',
      })
    );
  });

  app.get(
    '/api/paper-quality/live-capture/events',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      res.json(
        paperShadowMonitor.getLiveCaptureEvents(ex, {
          snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT',
        })
      );
    }
  );

  app.get(
    '/api/paper-quality/live-capture/summary',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      res.json(
        paperShadowMonitor.getLiveCaptureSummary(ex, {
          snapshotConsistency: 'INDEPENDENT_ENDPOINT_SNAPSHOT',
        })
      );
    }
  );

  app.get(
    '/api/paper-quality/live-capture/atomic',
    (req: Request, res: Response) => {
      const ex = resolveLiveQualityExchange(req, res);
      if (!ex) return;
      res.json(paperShadowMonitor.getSharedAtomicLiveCaptureBundle(ex));
    }
  );

  app.get('/api/notification-sandbox/outbox', (req: Request, res: Response) => {
    const statusEnv = paperShadowMonitor.getStatus();
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
    const outbox = paperMonitorDb.listNotificationOutbox({
      exchange: statusEnv.exchange,
      limit,
    });

    res.json({
      databaseInstanceId: statusEnv.databaseInstanceId,
      monitorRunId: statusEnv.monitorRunId,
      scanRunId: statusEnv.scanRunId,
      snapshotAt: new Date().toISOString(),
      statsVersion: statusEnv.statsVersion,
      mode: 'PAPER ONLY' as const,
      liveOrders: 'LIVE ORDERS DISABLED' as const,
      executionPolicy: 'NEVER AUTO-PLACE ORDERS' as const,
      safety: TRADING_SAFETY_FLAGS,
      externalTelegramRequestsCount: 0 as const,
      externalTradingViewRequestsCount: 0 as const,
      outbox,
    });
  });

  app.post(
    '/api/notification-sandbox/preview/:signalId',
    (req: Request, res: Response) => {
      const statusEnv = paperShadowMonitor.getStatus();
      const signalId = String(req.params.signalId || '').trim();
      const rawChannel = String(req.body?.channel || 'TELEGRAM_SANDBOX');
      const channel: NotificationOutboxChannel =
        rawChannel === 'TRADINGVIEW_SANDBOX'
          ? 'TRADINGVIEW_SANDBOX'
          : 'TELEGRAM_SANDBOX';

      const previewRecord = signalOutcomeTracker.generatePreviewForSignalId(
        signalId,
        channel
      );

      if (!previewRecord) {
        res.status(404).json({
          databaseInstanceId: statusEnv.databaseInstanceId,
          monitorRunId: statusEnv.monitorRunId,
          scanRunId: statusEnv.scanRunId,
          snapshotAt: new Date().toISOString(),
          statsVersion: statusEnv.statsVersion,
          mode: 'PAPER ONLY' as const,
          liveOrders: 'LIVE ORDERS DISABLED' as const,
          executionPolicy: 'NEVER AUTO-PLACE ORDERS' as const,
          safety: TRADING_SAFETY_FLAGS,
          error: `找不到訊號 ${signalId}`,
        });
        return;
      }

      const updatedStatus = paperShadowMonitor.getStatus();
      res.json({
        databaseInstanceId: updatedStatus.databaseInstanceId,
        monitorRunId: updatedStatus.monitorRunId,
        scanRunId: updatedStatus.scanRunId,
        snapshotAt: new Date().toISOString(),
        statsVersion: updatedStatus.statsVersion,
        mode: 'PAPER ONLY' as const,
        liveOrders: 'LIVE ORDERS DISABLED' as const,
        executionPolicy: 'NEVER AUTO-PLACE ORDERS' as const,
        safety: TRADING_SAFETY_FLAGS,
        externalTelegramRequestsCount: 0 as const,
        externalTradingViewRequestsCount: 0 as const,
        preview: previewRecord,
      });
    }
  );

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction
    ) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (RadarDatabase.isSqliteCorruptionError(err)) {
        const activeEx = smcBatchScanner.getActiveForegroundExchange();
        db.recoverFromRuntimeSqliteError(err, activeEx);
        if (!res.headersSent) {
          res.status(503).json({
            error: '資料庫執行期異常並已觸發自動修復，請重試一次請求。',
            recovering: true,
            safety: TRADING_SAFETY_FLAGS,
          });
        }
        return;
      }
      if (!res.headersSent) {
        res.status(500).json({
          error: msg || 'Internal server error',
          safety: TRADING_SAFETY_FLAGS,
        });
      }
    }
  );

  if (!options.skipViteMiddleware) {
    if (process.env.NODE_ENV !== 'production') {
      process.env.DISABLE_HMR = 'true';
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
          ws: false,
          watch: null,
        },
        plugins: [
          {
            name: 'disable-vite-hmr-ws',
            transform(code, id) {
              if (id.includes('client/client.mjs')) {
                return code
                  .replace(
                    'transport.connect(createHMRHandler(handleMessage));',
                    '/* HMR WebSocket disabled in preview environment */'
                  )
                  .replace(
                    'setupForwardConsoleHandler(transport, forwardConsole);',
                    '/* Forward console over HMR WS disabled */'
                  );
              }
              return null;
            },
          },
        ],
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(__dirname, 'dist');
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.locals.paperShadowMonitor = paperShadowMonitor;
  app.locals.smcBatchScanner = smcBatchScanner;
  app.locals.autoBacktestScheduler = autoBacktestScheduler;
  app.locals.externalNotificationService = externalNotificationService;
  app.locals.positionSentinel = positionSentinel;
  app.locals.systemWatchdog = systemWatchdog;
  app.locals.backtestService = backtestService;
  app.locals.radarDb = db;
  return app;
}

const PORT =
  process.env.NODE_ENV === 'production'
    ? Number(process.env.PORT || 3000)
    : process.env.PORT && process.env.PORT !== '8080'
      ? Number(process.env.PORT)
      : 3000;

if (
  process.env.NODE_ENV !== 'test' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename
) {
  createApp().then((app) => {
    const startupScanner = app.locals.smcBatchScanner as
      | SmcBatchScanService
      | undefined;
    if (startupScanner) {
      startupScanner.resume('binance_usdm', 'live', true);
    }
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `[CryptoMarketRadar Phase 2] Server listening on http://0.0.0.0:${PORT} (${TRADING_SAFETY_FLAGS.mode} / ${TRADING_SAFETY_FLAGS.liveOrders})`
      );
      setTimeout(() => {
        const scanner = app.locals.smcBatchScanner as
          | SmcBatchScanService
          | undefined;
        if (scanner) {
          scanner.runDatabaseCheck({
            exchange: 'binance_usdm',
            mode: 'live',
            createBackup: false,
          });
          scanner.startProgressSamplingLoop('binance_usdm', 60_000);
          void scanner
            .refreshExpiredCachesIfNeeded('binance_usdm')
            .catch(() => {});
        }
        const monitor = app.locals.paperShadowMonitor as
          | PaperShadowMonitor
          | undefined;
        if (monitor) {
          void monitor
            .start({
              exchange: 'binance_usdm',
              runImmediateCycle: true,
              maxSymbolsPerCycle: 6,
            })
            .catch((err) => {
              console.error('[PaperShadowMonitor] Auto-start warning:', err);
            });
        }
        const autoBt = app.locals.autoBacktestScheduler as
          | AutoBacktestScheduler
          | undefined;
        if (autoBt) {
          if (
            process.env.AUTO_BACKTEST_ENABLED === 'true' &&
            !autoBt.getStatus().config.enabled
          ) {
            autoBt.updateConfig({ enabled: true });
          } else {
            autoBt.initFromPersistedConfig();
          }
        }
        const sentinel = app.locals.positionSentinel as
          | PositionSentinelService
          | undefined;
        if (sentinel) {
          sentinel.start();
        }
        const watchdog = app.locals.systemWatchdog as
          | SystemWatchdogService
          | undefined;
        if (watchdog) {
          watchdog.start();
        }
      }, 1000);
    });

    let shuttingDown = false;
    const handleGracefulProcessShutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const watchdog = app.locals.systemWatchdog as
        | SystemWatchdogService
        | undefined;
      if (watchdog) {
        watchdog.stop();
      }
      const sentinel = app.locals.positionSentinel as
        | PositionSentinelService
        | undefined;
      if (sentinel) {
        sentinel.stop();
      }
      const autoBt = app.locals.autoBacktestScheduler as
        | AutoBacktestScheduler
        | undefined;
      if (autoBt) {
        autoBt.stop();
      }
      const monitor = app.locals.paperShadowMonitor as
        | PaperShadowMonitor
        | undefined;
      if (monitor) {
        monitor.stop();
      }
      const scanner = app.locals.smcBatchScanner as
        | SmcBatchScanService
        | undefined;
      if (scanner) {
        scanner.gracefulShutdown('binance_usdm', `process_${signal}`);
      }
      const closeDbAndExit = () => {
        const radarDb = app.locals.radarDb as RadarDatabase | undefined;
        if (radarDb) {
          try {
            radarDb.close();
          } catch {
            // ignore shutdown close error
          }
        }
        process.exit(0);
      };
      const forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
        closeDbAndExit();
      }, 2500);
      forceTimer.unref?.();
      server.closeIdleConnections?.();
      server.close(() => {
        clearTimeout(forceTimer);
        closeDbAndExit();
      });
    };

    process.once('SIGTERM', () => handleGracefulProcessShutdown('SIGTERM'));
    process.once('SIGINT', () => handleGracefulProcessShutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      console.error('[CryptoMarketRadar Phase 2] Unhandled Rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[CryptoMarketRadar Phase 2] Uncaught Exception:', err);
    });
  });
}
