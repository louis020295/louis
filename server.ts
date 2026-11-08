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
  DEFAULT_SCANNER_CONFIG,
  MARKET_SCAN_RULE_VERSION,
  runMarketScan,
} from './server/engine/MarketScanner.ts';
import { evaluateSmcStructure } from './server/engine/SmcRuleEngine.ts';
import {
  evaluateHistoricalVolumeAnomaly,
  MAX_SANE_ROBUST_ZSCORE,
} from './server/engine/VolumeAnomalyEngine.ts';
import { BackgroundScannerScheduler } from './server/services/BackgroundScannerScheduler.ts';
import { BacktestService } from './server/services/BacktestService.ts';
import { generateGeminiExplanation } from './server/services/GeminiExplainService.ts';
import { PaperShadowMonitor } from './server/services/PaperShadowMonitor.ts';
import { SignalOutcomeTracker } from './server/services/SignalOutcomeTracker.ts';
import { SmcBatchScanService } from './server/services/SmcBatchScanService.ts';
import {
  DecisionTraceApiResponse,
  EvaluationAggregationMode,
  ExchangeId,
  FullMarketGateStatistics,
  GeminiExplainRequest,
  HistoricalVolumeMetrics,
  NotificationOutboxChannel,
  NotificationPayload,
  PaperMonitorReportWindow,
  PaperQualityWindow,
  ScanCategory,
  SmcActionState,
  SmcAnalysisResult,
  SmcEvaluationStatus,
  SmcScanQueueConfig,
  SymbolDetailResponse,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from './src/types/market.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CreateAppOptions {
  customAdapters?: Partial<Record<ExchangeId, ExchangeAdapter>>;
  customGeminiCaller?: (prompt: string) => Promise<string>;
  customDbPath?: string;
  skipViteMiddleware?: boolean;
  smcQueueConfig?: Partial<SmcScanQueueConfig>;
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
    }
    const snapshot = await adapter.fetchMarketSnapshot();
    if (resolvedMode === 'live') {
      recentLiveSnapshotCache.set(exchangeId, {
        fetchedAtMs: Date.now(),
        snapshot,
      });
    }
    return snapshot;
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
        2500
      );

      // Record snapshot into SQLite historical_volume_samples collector
      db.recordTickerVolumeSnapshot(exchangeId, snapshot.tickers);

      // Update any open paper trading ledger positions with latest prices
      const priceMap = new Map<string, number>();
      for (const t of snapshot.tickers) {
        priceMap.set(t.symbol, t.lastPrice);
      }
      db.updateOpenPaperEntriesWithPrices(exchangeId, priceMap);

      let historicalVolumeMap =
        resolvedMode === 'demo'
          ? buildDemoHistoricalVolumeMap()
          : db.getBulkHistoricalVolumeMap(exchangeId, 40, '15m');

      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap,
      });
      const radarScanDurationMs = Math.max(0, Date.now() - radarStartMs);
      const lastFullRadarScanAt = new Date().toISOString();

      const currentQueueStats = db.getSmcScanQueueStats(exchangeId);
      const monitorWindowCompleted =
        paperShadowMonitor.getStatus().windowStatus === 'COMPLETED' &&
        currentQueueStats.evaluatedCount >= 400;
      const shouldPreserveLiveCycleSnapshot =
        resolvedMode === 'live' &&
        !options.skipViteMiddleware &&
        process.env.NODE_ENV !== 'test' &&
        currentQueueStats.totalJobs > 0 &&
        req.query.forceRefreshSmc !== 'true';

      // Page load sends autoStartSmc=false. Omitted (API and existing tests)
      // still enqueues. Explicit true is the manual full-market SMC trigger.
      const autoStartSmc = req.query.autoStartSmc !== 'false';
      if (
        autoStartSmc &&
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

        if (
          resolvedMode === 'live' &&
          !options.skipViteMiddleware &&
          process.env.NODE_ENV !== 'test' &&
          smcBatchScanner.getStatus(exchangeId, resolvedMode).workerState ===
            'IDLE'
        ) {
          smcBatchScanner.resumeScan(exchangeId, resolvedMode, true);
        }
      }

      if (resolvedMode === 'demo') {
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

      const scanResult = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap,
        smcMap: atomicSmcMap,
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
        scanResult.LIVE_FORMAL_CANDIDATE_COUNT =
          atomicSmcStatus.LIVE_FORMAL_CANDIDATE_COUNT ?? 0;
        scanResult.LIVE_FAST_LANE_COUNT =
          atomicSmcStatus.LIVE_FAST_LANE_COUNT ?? 0;
        scanResult.LIVE_BULK_COUNT = atomicSmcStatus.LIVE_BULK_COUNT ?? 0;
        scanResult.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT =
          atomicSmcStatus.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT ?? 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_COUNT =
          atomicSmcStatus.LIVE_ENTRY_WINDOW_MISSED_COUNT ?? 0;
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
        scanResult.LIVE_FORMAL_CANDIDATE_COUNT = 0;
        scanResult.LIVE_FAST_LANE_COUNT = 0;
        scanResult.LIVE_BULK_COUNT = 0;
        scanResult.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT = 0;
        scanResult.LIVE_ENTRY_WINDOW_MISSED_COUNT = 0;
        scanResult.LIVE_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_DETECTION_LATENCY_P95 = null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_FAST_LANE_DETECTION_LATENCY_P95 = null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P50 = null;
        scanResult.LIVE_BULK_DETECTION_LATENCY_P95 = null;
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

      // Fetch Open Interest and 5m, 15m, 1h, 4h Klines in parallel (using fresh SQLite cache when available)
      const [oiResult, k5m, k15m, k1h, k4h] = await Promise.all([
        getCachedOrFetchOi(),
        getCachedOrFetchTf('5m'),
        getCachedOrFetchTf('15m'),
        getCachedOrFetchTf('1h'),
        getCachedOrFetchTf('4h'),
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

      const finalScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        minQuoteVolume24h: 0,
        mode: resolvedMode,
        exchange: exchangeId,
        volumeTimeframe: '15m',
        historicalVolumeMap: baseHistMap,
        smcMap,
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
      ruleVersion,
      omitHistoricalOiAndFunding = false,
    } = (req.body ?? {}) as {
      symbol?: string;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      includeWalkForward?: boolean;
      writeToPaperLedger?: boolean;
      ruleVersion?: string;
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
        ruleVersion,
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
      ruleVersion,
      omitHistoricalOiAndFunding = false,
    } = (req.body ?? {}) as {
      symbol?: string;
      timeframe?: Timeframe;
      mode?: string;
      exchange?: string;
      barLimit?: number;
      writeToPaperLedger?: boolean;
      ruleVersion?: string;
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
          ruleVersion,
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

  // 7. Paper Trading Ledger Endpoints (Strictly PAPER ONLY / LIVE ORDERS DISABLED)
  app.get('/api/paper-ledger', (_req: Request, res: Response) => {
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entries: db.listPaperLedgerEntries(100),
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
      entryPrice?: number;
      invalidationPrice?: number;
      targetPrice?: number;
      ruleVersion?: string;
      evidences?: string[];
      notes?: string;
      provenance?: SymbolDetailResponse['provenance'];
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

    const entry = db.addPaperLedgerEntry({
      symbol: body.symbol.toUpperCase(),
      exchange: body.exchange ?? 'binance_usdm',
      timeframe: body.timeframe ?? '15m',
      side: body.side ?? 'LONG',
      category: body.category ?? '多頭候選',
      actionState: body.actionState ?? 'LONG CANDIDATE',
      entryPrice: Number(body.entryPrice),
      invalidationPrice: Number(body.invalidationPrice),
      targetPrice: Number(body.targetPrice),
      ruleVersion: body.ruleVersion ?? MARKET_SCAN_RULE_VERSION,
      evidences: body.evidences ?? [],
      notes: body.notes,
      provenance: body.provenance,
    });

    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entry,
      entries: db.listPaperLedgerEntries(100),
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
    res.json({
      safety: TRADING_SAFETY_FLAGS,
      entry: updated,
      entries: db.listPaperLedgerEntries(100),
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
    res.json(smcBatchScanner.getStatus(exchangeId, resolvedMode));
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

  app.post('/api/smc-scan/pause', (req: Request, res: Response) => {
    const rawMode = req.body?.mode ?? req.query.mode;
    const rawExchange = req.body?.exchange ?? req.query.exchange;
    const { resolvedMode, exchangeId } = resolveAdapter(
      typeof rawMode === 'string' ? rawMode : 'live',
      typeof rawExchange === 'string' ? rawExchange : undefined
    );
    res.json(smcBatchScanner.pauseScan(exchangeId, resolvedMode));
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
    res.json(smcBatchScanner.getProgressAndHealth(exchangeId, resolvedMode));
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
    res.json(smcBatchScanner.getProgressAndHealth(exchangeId, resolvedMode));
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
    res.json(paperShadowMonitor.getStatus());
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
    res.json(
      paperShadowMonitor.getPaperQualityGateDrift(ex, Date.now(), {
        reportAnchorAt: anchor.reportAnchorAt,
        driftThresholdPercent,
      })
    );
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

  if (!options.skipViteMiddleware) {
    if (process.env.NODE_ENV !== 'production') {
      process.env.DISABLE_HMR = 'true';
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
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
  app.locals.radarDb = db;
  return app;
}

const PORT =
  process.env.PORT && process.env.PORT !== '8080'
    ? Number(process.env.PORT)
    : 3000;

if (
  process.env.NODE_ENV !== 'test' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename
) {
  createApp().then((app) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `[CryptoMarketRadar Phase 2] Server listening on http://0.0.0.0:${PORT} (${TRADING_SAFETY_FLAGS.mode} / ${TRADING_SAFETY_FLAGS.liveOrders})`
      );
      setTimeout(() => {
        const scanner = app.locals.smcBatchScanner as
          | SmcBatchScanService
          | undefined;
        if (scanner) {
          scanner.resume();
          scanner.runDatabaseCheck({
            exchange: 'binance_usdm',
            mode: 'live',
            createBackup: false,
          });
          scanner.startProgressSamplingLoop('binance_usdm', 60_000);
        }
        const monitor = app.locals.paperShadowMonitor as
          | PaperShadowMonitor
          | undefined;
        if (monitor) {
          void monitor
            .start({
              exchange: 'binance_usdm',
              runImmediateCycle: false,
              maxSymbolsPerCycle: 6,
            })
            .catch((err) => {
              console.error('[PaperShadowMonitor] Auto-start warning:', err);
            });
        }
      }, 1000);
    });

    const handleGracefulProcessShutdown = (signal: string) => {
      const scanner = app.locals.smcBatchScanner as
        | SmcBatchScanService
        | undefined;
      if (scanner) {
        scanner.gracefulShutdown('binance_usdm', `process_${signal}`);
      }
      server.close(() => {
        process.exit(0);
      });
    };

    process.once('SIGTERM', () => handleGracefulProcessShutdown('SIGTERM'));
    process.once('SIGINT', () => handleGracefulProcessShutdown('SIGINT'));
  });
}
