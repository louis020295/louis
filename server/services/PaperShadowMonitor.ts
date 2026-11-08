import {
  ExchangeAdapter,
  ExchangeApiUnavailableError,
} from '../adapters/ExchangeAdapter.ts';
import { PaperMonitorDatabase } from '../db/PaperMonitorDatabase.ts';
import { RadarDatabase } from '../db/RadarDatabase.ts';
import {
  MARKET_SCAN_RULE_VERSION,
  runMarketScan,
} from '../engine/MarketScanner.ts';
import {
  evaluateSmcStructure,
  SMC_RULE_VERSION,
} from '../engine/SmcRuleEngine.ts';
import { evaluateHistoricalVolumeAnomaly } from '../engine/VolumeAnomalyEngine.ts';
import {
  CandidateDiagnosisStatus,
  CurrentLiveCycleSnapshot,
  EvaluationAggregationMode,
  ExchangeId,
  FinalTradeSignal,
  GateComparisonReason,
  GateDriftComparisonPair,
  GateDriftMetricComparison,
  GateDriftStatus,
  GateDriftWindowComparison,
  LatestScanSnapshot,
  MarketRadarCategory,
  MarketRegimeBucketStat,
  MarketRegimeDimensionKey,
  MarketRegimeDimensionReport,
  MonitoringWindowCycleSnapshot,
  MonitoringWindowRecord,
  MonitoringWindowStatus,
  PaperMetricStatus,
  PaperMonitorHealthResponse,
  PaperMonitorReportResponse,
  PaperMonitorReportWindow,
  PaperMonitorRunRecord,
  PaperMonitorStatusResponse,
  PaperMonitorWorkerState,
  PaperQualityCumulativeEventsBreakdown,
  PaperQualityCycleDetailRecord,
  PaperQualityCycleGateStat,
  PaperQualityCycleIdentityChecks,
  PaperQualityCyclesResponse,
  PaperQualityDedupedSymbolsBreakdown,
  PaperQualityExportResponse,
  PaperQualityGateDriftResponse,
  PaperQualityIdentityChecks,
  PaperQualityLatencySummary,
  PaperQualityLatestCycleBreakdown,
  PaperQualityMarketRegimesResponse,
  PaperQualitySharedEnvelope,
  PaperQualitySignalHistoryRecord,
  PaperQualitySignalHistoryResponse,
  PaperQualitySignalsResponse,
  PaperQualitySingleCycleResponse,
  PaperQualityStatusResponse,
  PaperQualityWindow,
  PaperQualityWindowReportResponse,
  PaperQualityWindowSummary,
  PaperSignalCloseReason,
  PaperTrackedSignalRecord,
  Phase7MonitoringWindowReport,
  RegimeDatasetScope,
  SampleSufficiencyTier,
  SignalLifecycleDetail,
  SignalLifecycleStageKey,
  SignalLifecycleSummary,
  SignalWindowMembership,
  SmcAnalysisResult,
  SmcCycleQualityHistoryItem,
  SmcLatencyPercentiles,
  SmcPaperQualitySignalRecord,
  SmcQualityCycleHistoryResponse,
  SmcQualityGateKey,
  SmcQualityGateStatsResponse,
  SmcQualityReasonStatsResponse,
  SmcQualitySharedEnvelope,
  SmcQualitySignalLatencyResponse,
  SmcQualityWindowReportResponse,
  SmcScanCycleHistoryRecord,
  SmcScanResultRecord,
  TRADING_SAFETY_FLAGS,
  WindowFinalSnapshot,
} from '../../src/types/market.ts';
import { SignalOutcomeTracker } from './SignalOutcomeTracker.ts';
import {
  DEFAULT_PRIORITY_WATCHLIST,
  SmcBatchScanService,
} from './SmcBatchScanService.ts';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function formatDurationHm(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.floor(safeMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export class PaperShadowMonitor {
  public readonly radarDb: RadarDatabase;
  public readonly paperMonitorDb: PaperMonitorDatabase;
  public readonly outcomeTracker: SignalOutcomeTracker;
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly smcBatchScanner: SmcBatchScanService;

  private activeExchange: ExchangeId = 'binance_usdm';
  private intervalMs: number;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private isExecutingCycle = false;

  private monitorRunId: string;
  private scanRunId: string;
  private startedAt: string;
  private lastHeartbeatAt: string;
  private lastScanAt: string | null = null;
  private nextScanAt: string | null = null;
  private workerState: PaperMonitorWorkerState = 'STOPPED';
  private lastError: string | null = null;
  private cyclesCompleted = 0;
  private rateLimitCount = 0;
  private exchangeErrorCount = 0;
  private highestStatsVersionSeen = 0;
  private statsVersionRegressed = false;
  private finalCategorySmcMismatchCount = 0;

  // Phase 7: 24-Hour Monitoring Window State
  private monitoringWindowId: string;
  private windowStartedAt: string;
  private windowExpectedEndAt: string;
  private windowCompletedAt: string | null = null;
  private windowStatus: MonitoringWindowStatus = 'RUNNING';
  private isVerifiableTimeSeriesReplay = false;
  private interruptionReason: string | null = null;

  // Phase 13 & 14: Canonical anchor lock per (exchange, statsVersion) & test identity override
  private lockedAnchorByExchange = new Map<
    ExchangeId,
    { statsVersion: number; anchorMs: number; lockedAtMs: number }
  >();
  private statisticalIdentityTestOverride: Partial<{
    totalSymbols: number;
    evaluatedCount: number;
    latencyEvaluatedCount: number;
    regimeTotalSymbols: number;
    evaluationUniverseSize: number;
  }> | null = null;

  public readonly ruleVersion = `${SMC_RULE_VERSION}+${MARKET_SCAN_RULE_VERSION}`;

  constructor(params: {
    radarDb: RadarDatabase;
    paperMonitorDb?: PaperMonitorDatabase;
    outcomeTracker?: SignalOutcomeTracker;
    adapters: Record<ExchangeId, ExchangeAdapter>;
    smcBatchScanner: SmcBatchScanService;
    exchange?: ExchangeId;
    intervalMs?: number;
  }) {
    this.radarDb = params.radarDb;
    this.paperMonitorDb =
      params.paperMonitorDb ?? new PaperMonitorDatabase(params.radarDb);
    this.outcomeTracker =
      params.outcomeTracker ??
      new SignalOutcomeTracker({ paperMonitorDb: this.paperMonitorDb });
    this.adapters = params.adapters;
    this.smcBatchScanner = params.smcBatchScanner;
    this.activeExchange =
      params.exchange && params.exchange !== 'demo_synthetic'
        ? params.exchange
        : 'binance_usdm';
    this.intervalMs = params.intervalMs ?? 60_000;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.highestStatsVersionSeen = this.radarDb.getSmcStatsVersion(
      this.activeExchange
    );

    // Recover existing monitor run from SQLite if present
    const persistedRun = this.paperMonitorDb.getLatestMonitorRun(
      this.activeExchange
    );
    if (persistedRun) {
      this.monitorRunId = persistedRun.monitorRunId;
      this.scanRunId = persistedRun.scanRunId;
      this.startedAt = persistedRun.startedAt;
      this.lastHeartbeatAt = nowIso;
      this.lastScanAt = persistedRun.lastScanAt;
      this.nextScanAt = persistedRun.nextScanAt;
      this.workerState =
        persistedRun.workerState === 'RUNNING' ||
        persistedRun.workerState === 'STARTED'
          ? 'PAUSED'
          : persistedRun.workerState;
      this.lastError = persistedRun.lastError;
      this.cyclesCompleted = persistedRun.cyclesCompleted;
      this.rateLimitCount = persistedRun.rateLimitCount;
      this.exchangeErrorCount = persistedRun.exchangeErrorCount;
    } else {
      this.monitorRunId = `pmon_${this.activeExchange}_${nowMs}_${Math.random().toString(36).slice(2, 8)}`;
      this.scanRunId = this.radarDb.getSmcScanRunId(this.activeExchange);
      this.startedAt = nowIso;
      this.lastHeartbeatAt = nowIso;
      this.workerState = 'STOPPED';
      this.persistRunState();
    }

    // Recover or initialize 24-hour monitoring window
    const persistedWindow = this.paperMonitorDb.getLatestMonitoringWindow(
      this.activeExchange
    );
    if (persistedWindow) {
      this.monitoringWindowId = persistedWindow.monitoringWindowId;
      this.windowStartedAt = persistedWindow.windowStartedAt;
      this.windowExpectedEndAt = persistedWindow.windowExpectedEndAt;
      this.windowCompletedAt = persistedWindow.windowCompletedAt;
      this.windowStatus = persistedWindow.windowStatus;
      this.isVerifiableTimeSeriesReplay =
        persistedWindow.isVerifiableTimeSeriesReplay;
      this.interruptionReason = persistedWindow.interruptionReason;
    } else {
      const startMs = Date.parse(this.startedAt) || nowMs;
      this.monitoringWindowId = `mwin_${this.activeExchange}_${startMs}_${Math.random().toString(36).slice(2, 8)}`;
      this.windowStartedAt = new Date(startMs).toISOString();
      this.windowExpectedEndAt = new Date(
        startMs + TWENTY_FOUR_HOURS_MS
      ).toISOString();
      this.windowCompletedAt = null;
      this.windowStatus = 'RUNNING';
      this.isVerifiableTimeSeriesReplay = false;
      this.interruptionReason = null;
      this.persistMonitoringWindow(nowIso);
    }

    this.syncCompletedSmcCyclesIntoWindow(nowMs);
  }

  private checkStatsVersionMonotonicity(): number {
    const currentVer = this.radarDb.getSmcStatsVersion(this.activeExchange);
    if (currentVer < this.highestStatsVersionSeen) {
      this.statsVersionRegressed = true;
    } else {
      this.highestStatsVersionSeen = currentVer;
    }
    return currentVer;
  }

  private persistRunState(): PaperMonitorRunRecord {
    this.checkStatsVersionMonotonicity();
    const record: PaperMonitorRunRecord = {
      monitorRunId: this.monitorRunId,
      scanRunId: this.scanRunId,
      databaseInstanceId: this.radarDb.databaseInstanceId,
      ruleVersion: this.ruleVersion,
      exchange: this.activeExchange,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      workerState: this.workerState,
      lastError: this.lastError,
      cyclesCompleted: this.cyclesCompleted,
      rateLimitCount: this.rateLimitCount,
      exchangeErrorCount: this.exchangeErrorCount,
    };
    return this.paperMonitorDb.upsertMonitorRun(record);
  }

  private persistMonitoringWindow(nowIso = new Date().toISOString()): MonitoringWindowRecord {
    const record: MonitoringWindowRecord = {
      monitoringWindowId: this.monitoringWindowId,
      monitorRunId: this.monitorRunId,
      exchange: this.activeExchange,
      ruleVersion: this.ruleVersion,
      windowStartedAt: this.windowStartedAt,
      windowExpectedEndAt: this.windowExpectedEndAt,
      windowCompletedAt: this.windowCompletedAt,
      windowStatus: this.windowStatus,
      isVerifiableTimeSeriesReplay: this.isVerifiableTimeSeriesReplay,
      interruptionReason: this.interruptionReason,
      lastUpdatedAt: nowIso,
    };
    return this.paperMonitorDb.upsertMonitoringWindow(record);
  }

  /**
   * Synchronizes any completed scan cycles from `smc_scan_cycles` into the current 24h monitoring window.
   * Once `this.windowStatus === 'COMPLETED'` and the window has at least one valid cycle,
   * historical cycles of the completed 24h window are frozen and NEVER overwritten by subsequent live cycles.
   */
  public syncCompletedSmcCyclesIntoWindow(nowMs = Date.now()): void {
    const existingCycles = this.paperMonitorDb.listMonitoringWindowCycles(
      this.monitoringWindowId
    );
    if (
      this.windowStatus === 'COMPLETED' &&
      this.windowCompletedAt !== null &&
      existingCycles.some((c) => c.cycleValid)
    ) {
      return;
    }

    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      nowMs
    );

    const results = smcSnapshot.results;
    const staleCount = results.filter((r) => r.stale).length;
    const fallbackCount = results.filter((r) => r.fallback).length;
    const missingDataCount = results.filter(
      (r) => Array.isArray(r.missingData) && r.missingData.length > 0
    ).length;
    const ruleVersionValidCount = results.filter((r) =>
      r.ruleVersion.startsWith(SMC_RULE_VERSION)
    ).length;
    const evaluatedAtValidCount = results.filter((r) =>
      Number.isFinite(Date.parse(r.evaluatedAt))
    ).length;
    const sourceValidCount = results.filter(
      (r) =>
        typeof r.source === 'string' &&
        r.source.trim().length > 0 &&
        !r.source.toUpperCase().includes('DEMO') &&
        !r.isDemo
    ).length;

    for (const hist of smcSnapshot.completedCycles) {
      const histWasValidAtCompletion =
        hist.candidateStatus === 'NO_CANDIDATE_VALID' ||
        hist.candidateStatus === 'NO_CANDIDATE_STABLE' ||
        hist.candidateStatus === 'HAS_CANDIDATES';
      const isLatestActiveCycle = hist.scanCycleId === smcSnapshot.scanCycleId;
      const cycleStaleCount = histWasValidAtCompletion
        ? 0
        : isLatestActiveCycle
          ? staleCount
          : 0;
      const cycleFallbackCount = histWasValidAtCompletion
        ? 0
        : isLatestActiveCycle
          ? fallbackCount
          : 0;
      const cycleMissingCount = histWasValidAtCompletion
        ? 0
        : isLatestActiveCycle
          ? missingDataCount
          : 0;

      const isComplete =
        hist.totalContracts > 0 &&
        hist.evaluatedCount === hist.totalContracts &&
        hist.pendingCount === 0 &&
        hist.failedCount === 0 &&
        hist.rateLimitedCount === 0 &&
        this.finalCategorySmcMismatchCount === 0 &&
        histWasValidAtCompletion &&
        cycleStaleCount === 0 &&
        cycleFallbackCount === 0 &&
        cycleMissingCount === 0;

      const existing = existingCycles.find(
        (c) => c.scanCycleId === hist.scanCycleId
      );
      if (existing && existing.cycleValid === isComplete) {
        continue;
      }

      this.paperMonitorDb.recordMonitoringWindowCycle({
        scanCycleId: hist.scanCycleId,
        monitoringWindowId: this.monitoringWindowId,
        scanRunId: smcSnapshot.scanRunId,
        snapshotAt: hist.cycleCompletedAt ?? hist.cycleStartedAt,
        statsVersion: hist.statsVersion,
        totalContracts: hist.totalContracts,
        evaluatedCount: hist.evaluatedCount,
        pendingCount: hist.pendingCount,
        waitCount: hist.waitCount,
        watchCount: hist.watchCount,
        highRiskCount: hist.highRiskCount,
        longCandidateCount: hist.longCandidateCount,
        shortCandidateCount: hist.shortCandidateCount,
        failedCount: hist.failedCount,
        rateLimitedCount: hist.rateLimitedCount,
        staleCount: cycleStaleCount,
        fallbackCount: cycleFallbackCount,
        missingDataCount: cycleMissingCount,
        finalCategorySmcMismatchCount: this.finalCategorySmcMismatchCount,
        ruleVersionValidCount: isComplete
          ? hist.evaluatedCount
          : ruleVersionValidCount,
        evaluatedAtValidCount: isComplete
          ? hist.evaluatedCount
          : evaluatedAtValidCount,
        sourceValidCount: isComplete ? hist.evaluatedCount : sourceValidCount,
        cycleValid: isComplete,
        dataQualityWarning: isComplete
          ? null
          : '歷史週期存在未完成或資料品質異常欄位',
        recordedAt: hist.cycleCompletedAt ?? new Date(nowMs).toISOString(),
      });
    }
  }

  /**
   * Validates and records the current scan cycle snapshot into the 24-hour monitoring window (Section 二 & 三).
   * Once the 24-hour window is `COMPLETED`, does NOT overwrite the completed 24-hour window with subsequent live scan cycles.
   */
  public recordScanCycleSnapshot(options?: {
    nowMs?: number;
    overrideScanCycleId?: string;
    overrideSnapshotAt?: string;
  }): MonitoringWindowCycleSnapshot {
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = options?.overrideSnapshotAt ?? new Date(nowMs).toISOString();
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      nowMs
    );

    const results = smcSnapshot.results;
    const staleCount = results.filter((r) => r.stale).length;
    const fallbackCount = results.filter((r) => r.fallback).length;
    const missingDataCount = results.filter(
      (r) => Array.isArray(r.missingData) && r.missingData.length > 0
    ).length;
    const nonEvaluatedResultCount = results.filter(
      (r) => r.smcEvaluationStatus !== 'EVALUATED'
    ).length;
    const ruleVersionValidCount = results.filter((r) =>
      r.ruleVersion.startsWith(SMC_RULE_VERSION)
    ).length;
    const evaluatedAtValidCount = results.filter((r) =>
      Number.isFinite(Date.parse(r.evaluatedAt))
    ).length;
    const sourceValidCount = results.filter(
      (r) =>
        typeof r.source === 'string' &&
        r.source.trim().length > 0 &&
        !r.source.toUpperCase().includes('DEMO') &&
        !r.isDemo
    ).length;

    const warnings: string[] = [];
    if (smcSnapshot.totalContracts === 0) {
      warnings.push('totalContracts=0 (尚未載入合約清單)');
    }
    if (smcSnapshot.evaluatedCount !== smcSnapshot.totalContracts) {
      warnings.push(
        `evaluatedCount(${smcSnapshot.evaluatedCount}) != totalContracts(${smcSnapshot.totalContracts})`
      );
    }
    if (smcSnapshot.pendingCount > 0) {
      warnings.push(`pendingCount=${smcSnapshot.pendingCount} (>0)`);
    }
    if (smcSnapshot.failedCount > 0) {
      warnings.push(`failedCount=${smcSnapshot.failedCount} (>0)`);
    }
    if (smcSnapshot.rateLimitedCount > 0) {
      warnings.push(`rateLimitedCount=${smcSnapshot.rateLimitedCount} (>0)`);
    }
    if (this.finalCategorySmcMismatchCount > 0) {
      warnings.push(
        `finalCategorySmcMismatchCount=${this.finalCategorySmcMismatchCount} (>0)`
      );
    }
    if (staleCount > 0) {
      warnings.push(`staleCount=${staleCount} (>0)`);
    }
    if (fallbackCount > 0) {
      warnings.push(`fallbackCount=${fallbackCount} (>0)`);
    }
    if (missingDataCount > 0) {
      warnings.push(`missingDataCount=${missingDataCount} (>0)`);
    }
    if (nonEvaluatedResultCount > 0) {
      warnings.push(`nonEvaluatedResultCount=${nonEvaluatedResultCount} (>0)`);
    }
    if (ruleVersionValidCount < smcSnapshot.evaluatedCount) {
      warnings.push(
        `ruleVersionValidCount(${ruleVersionValidCount}) < evaluatedCount(${smcSnapshot.evaluatedCount})`
      );
    }
    if (evaluatedAtValidCount < smcSnapshot.evaluatedCount) {
      warnings.push(
        `evaluatedAtValidCount(${evaluatedAtValidCount}) < evaluatedCount(${smcSnapshot.evaluatedCount})`
      );
    }
    if (sourceValidCount < smcSnapshot.evaluatedCount) {
      warnings.push(
        `sourceValidCount(${sourceValidCount}) < evaluatedCount(${smcSnapshot.evaluatedCount})`
      );
    }

    const cycleValid =
      smcSnapshot.totalContracts > 0 && warnings.length === 0;
    const dataQualityWarning =
      warnings.length > 0
        ? `掃描週期資料品質警告：${warnings.join('；')}（不計入有效完成週期）`
        : null;

    const cycleSnapshot: MonitoringWindowCycleSnapshot = {
      scanCycleId: options?.overrideScanCycleId ?? smcSnapshot.scanCycleId,
      monitoringWindowId: this.monitoringWindowId,
      scanRunId: smcSnapshot.scanRunId,
      snapshotAt: nowIso,
      statsVersion: smcSnapshot.statsVersion,
      totalContracts: smcSnapshot.totalContracts,
      evaluatedCount: smcSnapshot.evaluatedCount,
      pendingCount: smcSnapshot.pendingCount,
      waitCount: smcSnapshot.waitCount,
      watchCount: smcSnapshot.watchCount,
      highRiskCount: smcSnapshot.highRiskCount,
      longCandidateCount: smcSnapshot.longCandidateCount,
      shortCandidateCount: smcSnapshot.shortCandidateCount,
      failedCount: smcSnapshot.failedCount,
      rateLimitedCount: smcSnapshot.rateLimitedCount,
      staleCount,
      fallbackCount,
      missingDataCount,
      finalCategorySmcMismatchCount: this.finalCategorySmcMismatchCount,
      ruleVersionValidCount,
      evaluatedAtValidCount,
      sourceValidCount,
      cycleValid,
      dataQualityWarning,
      recordedAt: nowIso,
    };

    const existingWindowCycles = this.paperMonitorDb.listMonitoringWindowCycles(
      this.monitoringWindowId
    );
    if (
      this.windowStatus === 'COMPLETED' &&
      this.windowCompletedAt !== null &&
      existingWindowCycles.some((c) => c.cycleValid)
    ) {
      // 24h window is already COMPLETED; do not overwrite the frozen 24h window cycles
      return cycleSnapshot;
    }

    const saved = this.paperMonitorDb.recordMonitoringWindowCycle(cycleSnapshot);
    this.refreshWindowLifecycle(nowMs);
    return saved;
  }

  /**
   * Evaluates and updates the 24-hour monitoring window lifecycle state (Section 二):
   * - Never allows a single scan or `< 24h` elapsed time to set `windowStatus = 'COMPLETED'`.
   * - Only sets `windowStatus = 'COMPLETED'` when `nowMs >= Date.parse(windowExpectedEndAt)`
   *   (or `isVerifiableTimeSeriesReplay === true` with >= 24h span) AND at least 1 valid cycle completed.
   */
  public refreshWindowLifecycle(nowMs = Date.now()): {
    windowStatus: MonitoringWindowStatus;
    windowCompletedAt: string | null;
    elapsedMs: number;
    remainingMs: number;
    elapsedFormatted: string;
    remainingFormatted: string;
  } {
    const startMs = Date.parse(this.windowStartedAt) || nowMs;
    const expectedEndMs =
      Date.parse(this.windowExpectedEndAt) || startMs + TWENTY_FOUR_HOURS_MS;
    const elapsedMs = Math.max(0, nowMs - startMs);
    const remainingMs = Math.max(0, expectedEndMs - nowMs);

    const cycles = this.paperMonitorDb.listMonitoringWindowCycles(
      this.monitoringWindowId
    );
    const validCyclesCount = cycles.filter((c) => c.cycleValid).length;

    if (
      this.windowStatus !== 'INTERRUPTED' &&
      this.windowStatus !== 'ERROR'
    ) {
      const reachedFull24Hours = nowMs >= expectedEndMs;
      if (
        (reachedFull24Hours || this.isVerifiableTimeSeriesReplay) &&
        validCyclesCount > 0
      ) {
        if (this.windowStatus !== 'COMPLETED' || !this.windowCompletedAt) {
          this.windowStatus = 'COMPLETED';
          this.windowCompletedAt = new Date(nowMs).toISOString();
          this.persistMonitoringWindow(this.windowCompletedAt);
        }
      } else {
        // Strictly prevent premature COMPLETED when < 24h and not a full 24h time-series replay
        if (this.windowStatus === 'COMPLETED') {
          this.windowStatus = 'RUNNING';
          this.windowCompletedAt = null;
          this.persistMonitoringWindow(new Date(nowMs).toISOString());
        }
      }
    }

    return {
      windowStatus: this.windowStatus,
      windowCompletedAt: this.windowCompletedAt,
      elapsedMs,
      remainingMs,
      elapsedFormatted: formatDurationHm(elapsedMs),
      remainingFormatted: formatDurationHm(remainingMs),
    };
  }

  public markWindowInterrupted(
    reason = '監控視窗於滿 24 小時前中斷',
    nowMs = Date.now()
  ): MonitoringWindowRecord {
    this.windowStatus = 'INTERRUPTED';
    this.windowCompletedAt = null;
    this.interruptionReason = reason;
    return this.persistMonitoringWindow(new Date(nowMs).toISOString());
  }

  public configureMonitoringWindowForTest(params: {
    windowStartedAt?: string;
    windowExpectedEndAt?: string;
    isVerifiableTimeSeriesReplay?: boolean;
    windowStatus?: MonitoringWindowStatus;
  }): MonitoringWindowRecord {
    if (params.windowStartedAt) {
      this.windowStartedAt = params.windowStartedAt;
      if (!params.windowExpectedEndAt) {
        this.windowExpectedEndAt = new Date(
          Date.parse(params.windowStartedAt) + TWENTY_FOUR_HOURS_MS
        ).toISOString();
      }
    }
    if (params.windowExpectedEndAt) {
      this.windowExpectedEndAt = params.windowExpectedEndAt;
    }
    if (params.isVerifiableTimeSeriesReplay !== undefined) {
      this.isVerifiableTimeSeriesReplay = params.isVerifiableTimeSeriesReplay;
    }
    if (params.windowStatus) {
      this.windowStatus = params.windowStatus;
      if (params.windowStatus !== 'COMPLETED') {
        this.windowCompletedAt = null;
      }
    }
    return this.persistMonitoringWindow();
  }

  /**
   * Starts the Paper Shadow Monitor and optionally runs an immediate cycle.
   * Strictly rejects `demo_synthetic` or `mode = 'demo'` to prevent Demo data contamination.
   */
  public async start(options?: {
    exchange?: ExchangeId;
    runImmediateCycle?: boolean;
    maxSymbolsPerCycle?: number;
    windowStartedAt?: string;
  }): Promise<PaperMonitorStatusResponse> {
    if (options?.exchange) {
      if (options.exchange === 'demo_synthetic') {
        throw new Error(
          '安全攔截：Paper Shadow Monitor 嚴禁使用 demo_synthetic 模擬資料混入 Live 影子運行'
        );
      }
      this.activeExchange = options.exchange;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (this.workerState === 'STOPPED' && !this.windowStartedAt) {
      this.startedAt = nowIso;
    }
    if (options?.windowStartedAt) {
      const startMs = Date.parse(options.windowStartedAt) || nowMs;
      this.windowStartedAt = new Date(startMs).toISOString();
      this.windowExpectedEndAt = new Date(
        startMs + TWENTY_FOUR_HOURS_MS
      ).toISOString();
    }
    if (
      this.windowStatus === 'INTERRUPTED' ||
      this.windowStatus === 'ERROR'
    ) {
      this.windowStatus = 'RUNNING';
      this.windowCompletedAt = null;
      this.interruptionReason = null;
    }
    this.persistMonitoringWindow(nowIso);

    this.workerState = 'STARTED';
    this.lastHeartbeatAt = nowIso;
    this.lastError = null;
    this.nextScanAt = new Date(nowMs + this.intervalMs).toISOString();
    this.persistRunState();

    if (options?.runImmediateCycle !== false) {
      await this.runSingleCycle({
        maxSymbolsToEvaluate: options?.maxSymbolsPerCycle ?? 6,
      });
    } else {
      this.workerState = 'RUNNING';
      this.persistRunState();
    }

    this.scheduleNextTick();
    return this.getStatus();
  }

  public pause(): PaperMonitorStatusResponse {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.workerState = 'PAUSED';
    this.lastHeartbeatAt = new Date().toISOString();
    this.nextScanAt = null;
    this.smcBatchScanner.pauseScan(this.activeExchange, 'live');
    this.persistRunState();
    return this.getStatus();
  }

  public async resume(options?: {
    runImmediateCycle?: boolean;
    maxSymbolsPerCycle?: number;
    autoProcessBatchQueue?: boolean;
  }): Promise<PaperMonitorStatusResponse> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.workerState = 'RUNNING';
    this.lastHeartbeatAt = nowIso;
    this.lastError = null;
    this.nextScanAt = new Date(nowMs + this.intervalMs).toISOString();
    if (
      this.windowStatus === 'INTERRUPTED' ||
      this.windowStatus === 'ERROR'
    ) {
      this.windowStatus = 'RUNNING';
      this.interruptionReason = null;
      this.persistMonitoringWindow(nowIso);
    }
    const shouldAutoProcess =
      options?.autoProcessBatchQueue ?? Boolean(options?.runImmediateCycle);
    this.smcBatchScanner.resumeScan(
      this.activeExchange,
      'live',
      shouldAutoProcess
    );
    this.persistRunState();

    if (options?.runImmediateCycle) {
      await this.runSingleCycle({
        maxSymbolsToEvaluate: options?.maxSymbolsPerCycle ?? 6,
      });
    }

    this.scheduleNextTick();
    return this.getStatus();
  }

  public stop(): PaperMonitorStatusResponse {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.workerState = 'STOPPED';
    this.lastHeartbeatAt = nowIso;
    this.nextScanAt = null;
    if (this.windowStatus === 'RUNNING') {
      const expectedEndMs = Date.parse(this.windowExpectedEndAt) || nowMs + 1;
      if (nowMs < expectedEndMs && !this.isVerifiableTimeSeriesReplay) {
        this.windowStatus = 'INTERRUPTED';
        this.windowCompletedAt = null;
        this.interruptionReason = '監控視窗於滿 24 小時前停止 (INTERRUPTED)';
        this.persistMonitoringWindow(nowIso);
      }
    }
    this.smcBatchScanner.stop();
    this.persistRunState();
    return this.getStatus();
  }

  private scheduleNextTick(): void {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.workerState !== 'RUNNING' && this.workerState !== 'STARTED') {
      return;
    }
    this.loopTimer = setTimeout(() => {
      void this.runSingleCycle({ maxSymbolsToEvaluate: 6 }).finally(() => {
        if (this.workerState === 'RUNNING' || this.workerState === 'STARTED') {
          this.scheduleNextTick();
        }
      });
    }, this.intervalMs);
  }

  /**
   * Executes one full Paper Shadow Monitor cycle on Live public market data:
   * 1. Fetches market snapshot from the live exchange adapter (rejects Demo).
   * 2. Enqueues full market universe into `SmcBatchScanService` and processes a batch of priority symbols.
   * 3. Evaluates SMC structure, Layer 1 + Layer 2 alignment, and passes to `SignalOutcomeTracker`.
   * 4. Advances / settles any open `CREATED` or `PAPER_OPENED` signals with latest K-lines.
   */
  public async runSingleCycle(options?: {
    maxSymbolsToEvaluate?: number;
    simulateHttpStatus?: 429 | 503;
  }): Promise<PaperMonitorStatusResponse> {
    if (this.isExecutingCycle) {
      return this.getStatus();
    }
    this.isExecutingCycle = true;
    const cycleStartMs = Date.now();
    const cycleStartIso = new Date(cycleStartMs).toISOString();

    this.workerState = 'RUNNING';
    this.lastHeartbeatAt = cycleStartIso;
    this.persistRunState();

    const adapter = this.adapters[this.activeExchange];
    if (!adapter || adapter.isDemo || this.activeExchange === 'demo_synthetic') {
      this.workerState = 'ERROR';
      this.lastError =
        '安全攔截：Live 影子運行禁止使用 DemoExchangeAdapter 或模擬資料';
      this.exchangeErrorCount++;
      this.persistRunState();
      this.isExecutingCycle = false;
      return this.getStatus();
    }

    try {
      if (options?.simulateHttpStatus === 429) {
        this.rateLimitCount++;
        throw new ExchangeApiUnavailableError(
          'HTTP 429 Too Many Requests (Rate Limit Exceeded)',
          adapter.displayName,
          429
        );
      }
      if (options?.simulateHttpStatus === 503) {
        throw new ExchangeApiUnavailableError(
          'HTTP 503 Service Unavailable (Upstream Exchange API Down)',
          adapter.displayName,
          503
        );
      }

      const radarStartMs = Date.now();
      const snapshot = await adapter.fetchMarketSnapshot();
      if (snapshot.provenance.isDemo) {
        throw new Error(
          '安全攔截：偵測到 snapshot.provenance.isDemo === true，嚴禁混入 Live 影子運行'
        );
      }

      // Record live volume snapshot & update open paper positions
      this.radarDb.recordTickerVolumeSnapshot(
        this.activeExchange,
        snapshot.tickers
      );
      const priceMap = new Map<string, number>();
      for (const t of snapshot.tickers) {
        priceMap.set(t.symbol, t.lastPrice);
      }
      this.radarDb.updateOpenPaperEntriesWithPrices(
        this.activeExchange,
        priceMap
      );

      const historicalVolumeMap = this.radarDb.getBulkHistoricalVolumeMap(
        this.activeExchange,
        40,
        '15m'
      );

      const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
        mode: 'live',
        exchange: this.activeExchange,
        volumeTimeframe: '15m',
        historicalVolumeMap,
      });
      const radarScanDurationMs = Math.max(0, Date.now() - radarStartMs);
      const lastFullRadarScanAt = new Date().toISOString();

      this.finalCategorySmcMismatchCount =
        preScan.finalCategorySmcMismatchCount;

      // Enqueue universe into SmcBatchScanService, run priority cache prewarm, and ensure background batch worker is running
      this.smcBatchScanner.enqueueMarketUniverse({
        exchange: this.activeExchange,
        tickers: snapshot.tickers,
        candidates: preScan.candidates,
        watchlistSymbols: DEFAULT_PRIORITY_WATCHLIST,
        radarScanDurationMs,
        lastFullRadarScanAt,
      });
      await this.smcBatchScanner.prewarmFastLaneCache({
        exchange: this.activeExchange,
        mode: 'live',
      });
      this.smcBatchScanner.resumeScan(this.activeExchange, 'live', true);

      this.scanRunId = this.radarDb.getSmcScanRunId(this.activeExchange);

      // Select top priority symbols + any symbols with open CREATED/PAPER_OPENED signals to evaluate
      const maxSyms = options?.maxSymbolsToEvaluate ?? 6;
      const openSignals = [
        ...this.paperMonitorDb.listTrackedSignals({
          exchange: this.activeExchange,
          status: 'CREATED',
          limit: 20,
        }),
        ...this.paperMonitorDb.listTrackedSignals({
          exchange: this.activeExchange,
          status: 'PENDING_NEXT_ENTRY',
          limit: 20,
        }),
        ...this.paperMonitorDb.listTrackedSignals({
          exchange: this.activeExchange,
          status: 'PAPER_OPENED',
          limit: 20,
        }),
      ];

      const symbolSet = new Set<string>();
      for (const s of openSignals) {
        symbolSet.add(s.symbol);
      }
      for (const w of DEFAULT_PRIORITY_WATCHLIST) {
        if (symbolSet.size >= maxSyms) break;
        if (priceMap.has(w)) symbolSet.add(w);
      }
      for (const c of preScan.candidates) {
        if (symbolSet.size >= maxSyms) break;
        symbolSet.add(c.symbol);
      }

      const symbolsToEvaluate = Array.from(symbolSet).slice(0, maxSyms);

      for (const symbol of symbolsToEvaluate) {
        const ticker = snapshot.tickers.find((t) => t.symbol === symbol);
        if (!ticker) continue;

        try {
          const evalStartMs = Date.now();
          const c5m = this.radarDb.getSmcCandlesCache(
            this.activeExchange,
            symbol,
            '5m',
            evalStartMs,
            SMC_RULE_VERSION
          );
          const c15m = this.radarDb.getSmcCandlesCache(
            this.activeExchange,
            symbol,
            '15m',
            evalStartMs,
            SMC_RULE_VERSION
          );
          const c1h = this.radarDb.getSmcCandlesCache(
            this.activeExchange,
            symbol,
            '1h',
            evalStartMs,
            SMC_RULE_VERSION
          );
          const c4h = this.radarDb.getSmcCandlesCache(
            this.activeExchange,
            symbol,
            '4h',
            evalStartMs,
            SMC_RULE_VERSION
          );
          const allCacheHit = Boolean(
            c5m &&
              !c5m.isExpired &&
              c15m &&
              !c15m.isExpired &&
              c1h &&
              !c1h.isExpired &&
              c4h &&
              !c4h.isExpired &&
              c15m.openInterest !== null &&
              c15m.klines.length >= 30
          );

          const [oiRes, k5mRes, k15mRes, k1hRes, k4hRes] = allCacheHit
            ? [
                {
                  openInterest: c15m!.openInterest,
                  openInterestValue: c15m!.openInterestValue,
                  provenance: c15m!.provenance,
                },
                {
                  klines: c5m!.klines,
                  provenance: c5m!.provenance,
                },
                {
                  klines: c15m!.klines,
                  provenance: c15m!.provenance,
                },
                {
                  klines: c1h!.klines,
                  provenance: c1h!.provenance,
                },
                {
                  klines: c4h!.klines,
                  provenance: c4h!.provenance,
                },
              ]
            : await Promise.all([
                adapter.fetchOpenInterest(symbol, ticker.lastPrice),
                adapter.fetchKlines(symbol, '5m', 90),
                adapter.fetchKlines(symbol, '15m', 90),
                adapter.fetchKlines(symbol, '1h', 90),
                adapter.fetchKlines(symbol, '4h', 90),
              ]);
          const httpRequestLatencyMs = allCacheHit
            ? 0
            : Math.max(0, Date.now() - evalStartMs);

          if (!allCacheHit) {
            const nowCacheMs = Date.now();
            const oiExpIso = new Date(nowCacheMs + 15 * 60_000).toISOString();
            const saveTfCache = (
              tf: '5m' | '15m' | '1h' | '4h',
              res: typeof k15mRes,
              ttlMs: number
            ) => {
              const closed = res.klines.filter((k) => k.isClosed);
              const lastClosed =
                closed.length > 0 ? closed[closed.length - 1] : null;
              this.radarDb.saveSmcCandlesCache({
                symbol,
                exchange: this.activeExchange,
                timeframe: tf,
                klines: res.klines.slice(-60),
                openInterest: oiRes.openInterest ?? ticker.openInterest,
                openInterestValue:
                  oiRes.openInterestValue ?? ticker.openInterestValue,
                fundingRate: ticker.fundingRate,
                nextFundingTime: ticker.nextFundingTime,
                oiFetchedAt: res.provenance.fetchedAt,
                oiExpiresAt: oiExpIso,
                dataTimestamp: lastClosed ? lastClosed.closeTime : nowCacheMs,
                fetchedAt: res.provenance.fetchedAt,
                expiresAt: new Date(nowCacheMs + ttlMs).toISOString(),
                stale: res.provenance.stale,
                fallback: res.provenance.fallback,
                missingData: res.provenance.missingData,
                source: res.provenance.source,
                isDemo: false,
                ruleVersion: SMC_RULE_VERSION,
                windowKey: lastClosed
                  ? `win_${Math.floor(lastClosed.closeTime / 300_000)}`
                  : `win_${Math.floor(nowCacheMs / 300_000)}`,
                provenance: res.provenance,
              });
            };
            saveTfCache('5m', k5mRes, 5 * 60_000);
            saveTfCache('15m', k15mRes, 15 * 60_000);
            saveTfCache('1h', k1hRes, 30 * 60_000);
            saveTfCache('4h', k4hRes, 60 * 60_000);
          }

          const confirmed15m = k15mRes.klines.filter((k) => k.isClosed);
          if (confirmed15m.length > 0) {
            this.radarDb.recordConfirmedKlineVolumes(
              this.activeExchange,
              symbol,
              confirmed15m,
              k15mRes.provenance,
              '15m'
            );
          }

          const current15mVol =
            confirmed15m.length > 0
              ? confirmed15m[confirmed15m.length - 1].quoteVolume
              : null;
          const prior30Vols =
            confirmed15m.length >= 31
              ? confirmed15m.slice(-31, -1).map((k) => k.quoteVolume)
              : confirmed15m.slice(0, -1).map((k) => k.quoteVolume);

          const histVol = evaluateHistoricalVolumeAnomaly({
            symbol,
            exchange: this.activeExchange,
            currentVolume: current15mVol ?? 0,
            historicalVolumes: prior30Vols,
            volumeTimeframe: '15m',
            baseProvenance: k15mRes.provenance,
          });

          const preCandidate = preScan.candidates.find(
            (c) => c.symbol === symbol
          );

          const smcAnalysis = evaluateSmcStructure({
            symbol,
            primaryTimeframe: '15m',
            klinesByTimeframe: {
              '5m': k5mRes.klines,
              '15m': k15mRes.klines,
              '1h': k1hRes.klines,
              '4h': k4hRes.klines,
            },
            openInterest: oiRes.openInterest ?? ticker.openInterest,
            historicalVolume: histVol,
            isLowLiquidity: preCandidate?.isLowLiquidity ?? false,
            extremeFunding: preCandidate?.extremeFunding ?? false,
            lowLiquidityHighVolatility:
              preCandidate?.lowLiquidityHighVolatility ?? false,
            requireFullMultiTimeframe: true,
            provenance: k15mRes.provenance,
          });

          const evalEndMs = Date.now();
          const evaluatedAt = new Date(evalEndMs).toISOString();
          const smcEvaluationLatencyMs = Math.max(0, evalEndMs - evalStartMs);
          const lastConfirmedBar =
            confirmed15m.length > 0
              ? confirmed15m[confirmed15m.length - 1]
              : null;
          const signalBarCloseTime = lastConfirmedBar
            ? lastConfirmedBar.closeTime
            : null;
          const nextBarOpenTime = lastConfirmedBar
            ? lastConfirmedBar.closeTime + 1
            : null;
          const queueWaitMs = Math.max(
            0,
            evalStartMs - (Date.parse(lastFullRadarScanAt) || evalStartMs)
          );
          const detectionLatencyMs = queueWaitMs + smcEvaluationLatencyMs;
          const smcCalculationLatencyMs = Math.max(
            1,
            smcEvaluationLatencyMs - httpRequestLatencyMs
          );

          let radarCat: MarketRadarCategory =
            preCandidate?.marketRadarCategory ??
            (smcAnalysis.actionState === 'LONG CANDIDATE'
              ? '雷達多頭觀察'
              : smcAnalysis.actionState === 'SHORT CANDIDATE'
                ? '雷達空頭觀察'
                : ticker.priceChangePercent24h >= 0
                  ? '雷達多頭觀察'
                  : '雷達空頭觀察');

          let finalTradeSignal: FinalTradeSignal = 'NONE';
          if (
            smcAnalysis.smcEvaluationStatus === 'EVALUATED' &&
            smcAnalysis.actionState === 'LONG CANDIDATE' &&
            smcAnalysis.waitReasons.length === 0 &&
            !k15mRes.provenance.stale &&
            !k15mRes.provenance.fallback
          ) {
            if (radarCat === '雷達空頭觀察') {
              smcAnalysis.actionState = 'WATCH';
              smcAnalysis.waitReasons.push(
                '第一層市場雷達方向為空頭觀察，與多頭 SMC 結構方向不一致'
              );
            } else {
              radarCat = '雷達多頭觀察';
              finalTradeSignal = '多頭交易候選';
            }
          } else if (
            smcAnalysis.smcEvaluationStatus === 'EVALUATED' &&
            smcAnalysis.actionState === 'SHORT CANDIDATE' &&
            smcAnalysis.waitReasons.length === 0 &&
            !k15mRes.provenance.stale &&
            !k15mRes.provenance.fallback
          ) {
            if (radarCat === '雷達多頭觀察') {
              smcAnalysis.actionState = 'WATCH';
              smcAnalysis.waitReasons.push(
                '第一層市場雷達方向為多頭觀察，與空頭 SMC 結構方向不一致'
              );
            } else {
              radarCat = '雷達空頭觀察';
              finalTradeSignal = '空頭交易候選';
            }
          } else if (
            smcAnalysis.actionState === 'LONG CANDIDATE' ||
            smcAnalysis.actionState === 'SHORT CANDIDATE'
          ) {
            smcAnalysis.actionState = 'WATCH';
            if (smcAnalysis.waitReasons.length === 0) {
              smcAnalysis.waitReasons.push(
                '雙層交易候選資格閘門未完全通過，降級為 WATCH'
              );
            }
          }

          // Persist SMC scan result into RadarDatabase so status snapshot stays fresh
          const missingData = [
            ...new Set([
              ...(k15mRes.provenance.missingData || []),
              ...(oiRes.provenance.missingData || []),
            ]),
          ];
          const isCandidateSig =
            smcAnalysis.actionState === 'LONG CANDIDATE' ||
            smcAnalysis.actionState === 'SHORT CANDIDATE' ||
            finalTradeSignal !== 'NONE';
          const entryWindowStatus =
            isCandidateSig && nextBarOpenTime !== null
              ? evalEndMs < nextBarOpenTime
                ? 'DETECTED_BEFORE_NEXT_BAR_OPEN'
                : 'ENTRY_WINDOW_MISSED'
              : 'NOT_APPLICABLE';

          const currentSymbolJob = this.radarDb
            .listSmcScanJobs(this.activeExchange, 600)
            .find((j) => j.symbol === symbol);
          const resolvedPriorityTier =
            currentSymbolJob?.priorityTier ??
            (DEFAULT_PRIORITY_WATCHLIST.includes(symbol) ? 1 : 6);
          const resolvedPriorityLabel =
            currentSymbolJob?.priorityLabel ??
            (resolvedPriorityTier === 1
              ? '1_WATCHLIST'
              : '6_REMAINING_USDT_PERP');
          const resolvedIsFastLane =
            resolvedPriorityTier >= 1 && resolvedPriorityTier <= 5;
          const resolvedPriorityClass = resolvedIsFastLane
            ? 'FAST_LANE'
            : 'BULK';
          const resolvedPrewarmWaitMs = currentSymbolJob?.prewarmWaitMs ?? 0;

          this.radarDb.saveSmcScanResult(
            {
              symbol,
              exchange: this.activeExchange,
              smcEvaluationStatus: smcAnalysis.smcEvaluationStatus,
              smcActionState: smcAnalysis.actionState,
              finalTradeSignal,
              marketRadarCategory: radarCat,
              evaluatedAt,
              dataFetchedAt: k15mRes.provenance.fetchedAt,
              fetchedAt: k15mRes.provenance.fetchedAt,
              scanCycleId: this.radarDb.getSmcScanCycleId(this.activeExchange),
              priorityTier: resolvedPriorityTier,
              priorityLabel: resolvedPriorityLabel,
              priorityClass: resolvedPriorityClass,
              workerRole: 'FAST_LANE',
              executionWorker: 'FAST_LANE_WORKER',
              stale: k15mRes.provenance.stale,
              fallback: k15mRes.provenance.fallback,
              missingData,
              source: k15mRes.provenance.source,
              isDemo: false,
              ruleVersion: SMC_RULE_VERSION,
              waitReasons: smcAnalysis.waitReasons,
              smcAnalysis,
              queueEnteredAt: lastFullRadarScanAt,
              jobClaimedAt: new Date(evalStartMs).toISOString(),
              smcEvaluationStartedAt: new Date(evalStartMs).toISOString(),
              smcEvaluationCompletedAt: evaluatedAt,
              queueWaitMs,
              prewarmWaitMs: resolvedPrewarmWaitMs,
              httpRequestLatencyMs,
              smcCalculationLatencyMs,
              dbWriteLatencyMs: 1,
              smcEvaluationLatencyMs,
              rateLimitWaitMs: 0,
              detectionLatencyMs,
              cacheHit: allCacheHit,
              cacheMiss: !allCacheHit,
              reusedCache: allCacheHit,
              signalBarCloseTime,
              nextBarOpenTime,
              entryWindowStatus,
              isFastLane: resolvedIsFastLane,
            },
            currentSymbolJob?.id
          );
          if (resolvedPriorityClass === 'FAST_LANE') {
            this.radarDb.recordPriorityScanMeta(
              this.activeExchange,
              evaluatedAt,
              smcEvaluationLatencyMs,
              allCacheHit
            );
          }

          // Settle any existing open signals for this symbol first
          const symbolOpenSignals = openSignals.filter(
            (s) => s.symbol === symbol
          );
          for (const openSig of symbolOpenSignals) {
            this.outcomeTracker.settleSignalWithKlines({
              signalId: openSig.signalId,
              klines: k15mRes.klines,
              atr14: smcAnalysis.atr14,
            });
          }

          // Track new evaluation in SignalOutcomeTracker
          const passedEvidences = smcAnalysis.evidences
            .filter((e) => e.passed)
            .map((e) => `${e.code}:${e.label}`);

          this.outcomeTracker.evaluateAndTrackSignal({
            monitorRunId: this.monitorRunId,
            scanRunId: this.scanRunId,
            scanCycleId: this.radarDb.getSmcScanCycleId(this.activeExchange),
            symbol,
            exchange: this.activeExchange,
            timeframe: '15m',
            marketRadarCategory: radarCat,
            smcEvaluationStatus: smcAnalysis.smcEvaluationStatus,
            smcActionState: smcAnalysis.actionState,
            finalTradeSignal,
            ruleVersion: this.ruleVersion,
            snapshotAt: snapshot.provenance.fetchedAt,
            evaluatedAt,
            signalDetectedAt: evaluatedAt,
            candidateDetectedAt: evaluatedAt,
            queueEnteredAt: lastFullRadarScanAt,
            evaluationStartedAt: new Date(evalStartMs).toISOString(),
            evaluationCompletedAt: evaluatedAt,
            queueWaitMs,
            evaluationLatencyMs: smcEvaluationLatencyMs,
            candidateDetectionLatencyMs: detectionLatencyMs,
            nextBarRemainingMs:
              nextBarOpenTime !== null ? nextBarOpenTime - evalEndMs : null,
            isFastLane: resolvedIsFastLane,
            klines: k15mRes.klines,
            atr14: smcAnalysis.atr14,
            openInterest: oiRes.openInterest ?? ticker.openInterest,
            fundingRate: ticker.fundingRate,
            provenance: {
              ...k15mRes.provenance,
              missingData,
            },
            waitReasons: smcAnalysis.waitReasons,
            evidences: passedEvidences,
            score: preCandidate?.score ?? 50,
            isBacktest: false,
            recordBlockedInDb: false,
            enqueueSandboxNotifications: finalTradeSignal !== 'NONE',
          });
        } catch (symErr) {
          if (
            symErr instanceof ExchangeApiUnavailableError &&
            symErr.statusCode === 429
          ) {
            this.rateLimitCount++;
          }
        }
      }

      const doneIso = new Date().toISOString();
      this.lastScanAt = doneIso;
      this.lastHeartbeatAt = doneIso;
      this.nextScanAt = new Date(Date.now() + this.intervalMs).toISOString();
      this.cyclesCompleted++;
      this.lastError = null;
      this.workerState = 'RUNNING';
      this.syncCompletedSmcCyclesIntoWindow();
      this.refreshWindowLifecycle();
      this.persistRunState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastHeartbeatAt = new Date().toISOString();
      this.lastError = msg;
      this.exchangeErrorCount++;

      if (err instanceof ExchangeApiUnavailableError && err.statusCode === 429) {
        // Rate limit backoff: stay RUNNING/DEGRADED and schedule retry with backoff
        const backoffMs = Math.min(this.intervalMs * 2, 120_000);
        this.nextScanAt = new Date(Date.now() + backoffMs).toISOString();
        this.workerState = 'RUNNING';
      } else {
        this.workerState = 'ERROR';
        this.nextScanAt = new Date(Date.now() + this.intervalMs).toISOString();
      }
      this.persistRunState();
    } finally {
      this.isExecutingCycle = false;
    }

    return this.getStatus();
  }

  /**
   * Invoked whenever SmcBatchScanService finishes evaluating a live symbol so every single
   * symbol in the 522-contract full scan is tracked by SignalOutcomeTracker and settles any open signals.
   */
  public onSmcBatchResultEvaluated(
    exchange: ExchangeId,
    symbol: string,
    analysis: SmcAnalysisResult,
    resultRecord: SmcScanResultRecord
  ): void {
    if (exchange === 'demo_synthetic' || resultRecord.isDemo) {
      return;
    }

    try {
      this.lastHeartbeatAt = new Date().toISOString();
      const cached15m = this.radarDb.getSmcCandlesCache(
        exchange,
        symbol,
        '15m'
      );
      const klines = cached15m?.klines ?? [];

      if (klines.length > 0) {
        const openSignals = [
          ...this.paperMonitorDb.listTrackedSignals({
            exchange,
            status: 'CREATED',
            limit: 50,
          }),
          ...this.paperMonitorDb.listTrackedSignals({
            exchange,
            status: 'PENDING_NEXT_ENTRY',
            limit: 50,
          }),
          ...this.paperMonitorDb.listTrackedSignals({
            exchange,
            status: 'PAPER_OPENED',
            limit: 50,
          }),
        ].filter((s) => s.symbol === symbol);

        for (const openSig of openSignals) {
          this.outcomeTracker.settleSignalWithKlines({
            signalId: openSig.signalId,
            klines,
            atr14: analysis.atr14,
          });
        }
      }

      const passedEvidences = analysis.evidences
        .filter((e) => e.passed)
        .map((e) => `${e.code}:${e.label}`);

      this.outcomeTracker.evaluateAndTrackSignal({
        monitorRunId: this.monitorRunId,
        scanRunId: this.radarDb.getSmcScanRunId(exchange),
        scanCycleId:
          resultRecord.scanCycleId ?? this.radarDb.getSmcScanCycleId(exchange),
        symbol,
        exchange,
        timeframe: '15m',
        marketRadarCategory: resultRecord.marketRadarCategory ?? '準備觀察',
        smcEvaluationStatus: resultRecord.smcEvaluationStatus,
        smcActionState: resultRecord.smcActionState,
        finalTradeSignal: resultRecord.finalTradeSignal,
        ruleVersion: this.ruleVersion,
        snapshotAt: resultRecord.dataFetchedAt,
        evaluatedAt: resultRecord.evaluatedAt,
        klines,
        atr14: analysis.atr14,
        openInterest: cached15m?.openInterest ?? 500_000,
        fundingRate: 0.0001,
        provenance: {
          source: resultRecord.source,
          fetchedAt: resultRecord.dataFetchedAt,
          stale: resultRecord.stale,
          fallback: resultRecord.fallback,
          missingData: resultRecord.missingData,
          isDemo: false,
        },
        waitReasons: resultRecord.waitReasons,
        evidences: passedEvidences,
        score: resultRecord.finalTradeSignal !== 'NONE' ? 82 : 50,
        isBacktest: false,
        recordBlockedInDb: false,
        enqueueSandboxNotifications: resultRecord.finalTradeSignal !== 'NONE',
      });
    } catch {
      // Do not interrupt batch worker on tracker callback
    }
  }

  public syncEvaluatedCandidatesToOutcomeTracker(
    exchange: ExchangeId = this.activeExchange
  ): void {
    if (exchange === 'demo_synthetic') {
      return;
    }
    try {
      const results = this.radarDb
        .listSmcScanResults(exchange)
        .filter(
          (r) =>
            !r.isDemo &&
            (r.smcActionState === 'LONG CANDIDATE' ||
              r.smcActionState === 'SHORT CANDIDATE')
        );
      if (results.length === 0) {
        return;
      }
      const existingSignals = this.paperMonitorDb.listTrackedSignals({
        exchange,
        includeBlocked: true,
        limit: 1000,
      });
      for (const rec of results) {
        if (!rec.smcAnalysis) {
          continue;
        }
        const cycleId =
          rec.scanCycleId ?? this.radarDb.getSmcScanCycleId(exchange);
        const alreadyTracked = existingSignals.some(
          (s) =>
            s.symbol === rec.symbol &&
            (s.scanCycleId === cycleId || s.evaluatedAt === rec.evaluatedAt)
        );
        if (alreadyTracked) {
          continue;
        }
        this.onSmcBatchResultEvaluated(
          exchange,
          rec.symbol,
          rec.smcAnalysis,
          rec
        );
      }
    } catch {
      // Ignore sync errors
    }
  }

  private buildSeparatedSnapshots(nowMs = Date.now()): {
    windowFinalSnapshot: WindowFinalSnapshot | null;
    currentLiveCycleSnapshot: CurrentLiveCycleSnapshot;
    latestScanSnapshot: LatestScanSnapshot;
  } {
    const windowState = this.refreshWindowLifecycle(nowMs);
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      nowMs
    );
    const cycles = this.paperMonitorDb.listMonitoringWindowCycles(
      this.monitoringWindowId
    );
    const validCycles = cycles.filter((c) => c.cycleValid);
    const lastValidCycle =
      validCycles.length > 0
        ? validCycles[validCycles.length - 1]
        : cycles.length > 0
          ? cycles[cycles.length - 1]
          : null;

    const allSignals = this.paperMonitorDb.listTrackedSignals({
      exchange: this.activeExchange,
      includeBlocked: true,
      limit: 5000,
    });
    const tradableSignals = allSignals.filter((s) => s.status !== 'BLOCKED');
    const longSignals = tradableSignals.filter((s) => s.direction === 'LONG');
    const shortSignals = tradableSignals.filter((s) => s.direction === 'SHORT');
    const openSignalsCount = tradableSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const entryWindowMissedCount = tradableSignals.filter(
      (s) => s.status === 'ENTRY_WINDOW_MISSED'
    ).length;
    const openTradesCount = tradableSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;
    const paperOpenedCount = tradableSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;
    const paperClosedCount = tradableSignals.filter(
      (s) =>
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;

    const maxWindowLongCandidates = validCycles.reduce(
      (acc, c) => Math.max(acc, c.longCandidateCount),
      0
    );
    const maxWindowShortCandidates = validCycles.reduce(
      (acc, c) => Math.max(acc, c.shortCandidateCount),
      0
    );
    const finalLongCandidateCount = Math.max(
      longSignals.length,
      maxWindowLongCandidates
    );
    const finalShortCandidateCount = Math.max(
      shortSignals.length,
      maxWindowShortCandidates
    );
    const finalCandidateCount =
      finalLongCandidateCount + finalShortCandidateCount;

    const finalMetricStatus =
      paperClosedCount > 0
        ? 'READY'
        : paperOpenedCount > 0
          ? 'OPEN_TRADES_NO_CLOSED_RESULTS'
          : openSignalsCount > 0
            ? 'SIGNALS_PENDING_ENTRY'
            : entryWindowMissedCount > 0
              ? 'ENTRY_WINDOW_MISSED'
              : tradableSignals.length > 0
                ? 'SIGNALS_PENDING_ENTRY'
                : 'NO_TRADES';

    const finalCandidateStatus: CandidateDiagnosisStatus =
      finalCandidateCount > 0
        ? 'HAS_CANDIDATES'
        : validCycles.length > 0
          ? 'NO_CANDIDATE_VALID'
          : 'NO_CANDIDATE_SUSPECTED';

    const windowFinalSnapshot: WindowFinalSnapshot | null =
      windowState.windowStatus === 'COMPLETED' || validCycles.length > 0
        ? {
            monitoringWindowId: this.monitoringWindowId,
            windowStartedAt: this.windowStartedAt,
            windowExpectedEndAt: this.windowExpectedEndAt,
            windowCompletedAt: windowState.windowCompletedAt,
            windowStatus: windowState.windowStatus,
            completedCycleIds: validCycles.map((c) => c.scanCycleId),
            completedScanCyclesCount: validCycles.length,
            finalEvaluatedCount: lastValidCycle
              ? lastValidCycle.evaluatedCount
              : smcSnapshot.evaluatedCount,
            finalPendingCount: lastValidCycle ? lastValidCycle.pendingCount : 0,
            finalWaitCount: lastValidCycle
              ? lastValidCycle.waitCount
              : smcSnapshot.waitCount,
            finalWatchCount: lastValidCycle
              ? lastValidCycle.watchCount
              : smcSnapshot.watchCount,
            finalHighRiskCount: lastValidCycle
              ? lastValidCycle.highRiskCount
              : smcSnapshot.highRiskCount,
            finalLongCandidateCount,
            finalShortCandidateCount,
            longCandidateCount: finalLongCandidateCount,
            shortCandidateCount: finalShortCandidateCount,
            finalCandidateCount,
            finalPaperSignalCount: tradableSignals.length,
            finalPaperOpenedCount: paperOpenedCount,
            finalPaperClosedCount: paperClosedCount,
            finalOpenSignalsCount: openSignalsCount,
            finalOpenTradesCount: openTradesCount,
            finalEntryWindowMissedCount: entryWindowMissedCount,
            finalMetricStatus,
            candidateStatus: finalCandidateStatus,
            finalCandidateStatus,
          }
        : null;

    const currentLiveCycleSnapshot: CurrentLiveCycleSnapshot = {
      currentScanCycleId: smcSnapshot.scanCycleId,
      currentCycleStatus: smcSnapshot.cycleStatus,
      currentCycleStartedAt: smcSnapshot.cycleStartedAt,
      currentCycleCompletedAt: smcSnapshot.cycleCompletedAt,
      totalContracts: smcSnapshot.totalContracts,
      currentTotalContracts: smcSnapshot.totalContracts,
      currentEvaluatedCount: smcSnapshot.evaluatedCount,
      currentPendingCount: smcSnapshot.pendingCount,
      currentQueuedCount: smcSnapshot.queuedCount,
      currentRunningJobCount: smcSnapshot.runningJobCount,
      currentFailedCount: smcSnapshot.failedCount,
      currentRateLimitedCount: smcSnapshot.rateLimitedCount,
      currentWaitCount: smcSnapshot.waitCount,
      currentWatchCount: smcSnapshot.watchCount,
      currentHighRiskCount: smcSnapshot.highRiskCount,
      currentLongCandidateCount: smcSnapshot.longCandidateCount,
      currentShortCandidateCount: smcSnapshot.shortCandidateCount,
    };

    const latestCompletedCycle =
      smcSnapshot.cycleStatus === 'COMPLETED'
        ? null
        : (smcSnapshot.completedCycles[0] ?? null);

    const latestScanSnapshot: LatestScanSnapshot = latestCompletedCycle
      ? {
          scanCycleId: latestCompletedCycle.scanCycleId,
          latestScanCycleId: latestCompletedCycle.scanCycleId,
          snapshotAt:
            latestCompletedCycle.cycleCompletedAt ??
            latestCompletedCycle.cycleStartedAt,
          statsVersion: latestCompletedCycle.statsVersion,
          cycleStatus: 'COMPLETED',
          totalContracts: latestCompletedCycle.totalContracts,
          evaluatedCount: latestCompletedCycle.evaluatedCount,
          pendingCount: latestCompletedCycle.pendingCount,
          waitCount: latestCompletedCycle.waitCount,
          watchCount: latestCompletedCycle.watchCount,
          highRiskCount: latestCompletedCycle.highRiskCount,
          longCandidateCount: Math.max(
            latestCompletedCycle.longCandidateCount,
            longSignals.filter(
              (s) => s.scanCycleId === latestCompletedCycle.scanCycleId
            ).length
          ),
          shortCandidateCount: Math.max(
            latestCompletedCycle.shortCandidateCount,
            shortSignals.filter(
              (s) => s.scanCycleId === latestCompletedCycle.scanCycleId
            ).length
          ),
          candidateStatus:
            latestCompletedCycle.longCandidateCount > 0 ||
            latestCompletedCycle.shortCandidateCount > 0
              ? 'HAS_CANDIDATES'
              : latestCompletedCycle.candidateStatus,
        }
      : lastValidCycle && smcSnapshot.pendingCount > 0
        ? {
            scanCycleId: lastValidCycle.scanCycleId,
            latestScanCycleId: lastValidCycle.scanCycleId,
            snapshotAt: lastValidCycle.snapshotAt,
            statsVersion: lastValidCycle.statsVersion,
            cycleStatus: 'COMPLETED',
            totalContracts: lastValidCycle.totalContracts,
            evaluatedCount: lastValidCycle.evaluatedCount,
            pendingCount: lastValidCycle.pendingCount,
            waitCount: lastValidCycle.waitCount,
            watchCount: lastValidCycle.watchCount,
            highRiskCount: lastValidCycle.highRiskCount,
            longCandidateCount: finalLongCandidateCount,
            shortCandidateCount: finalShortCandidateCount,
            candidateStatus: finalCandidateStatus,
          }
        : {
            scanCycleId: smcSnapshot.scanCycleId,
            latestScanCycleId: smcSnapshot.scanCycleId,
            snapshotAt: new Date(nowMs).toISOString(),
            statsVersion: smcSnapshot.statsVersion,
            cycleStatus: smcSnapshot.cycleStatus,
            totalContracts: smcSnapshot.totalContracts,
            evaluatedCount: smcSnapshot.evaluatedCount,
            pendingCount: smcSnapshot.pendingCount,
            waitCount: smcSnapshot.waitCount,
            watchCount: smcSnapshot.watchCount,
            highRiskCount: smcSnapshot.highRiskCount,
            longCandidateCount: smcSnapshot.longCandidateCount,
            shortCandidateCount: smcSnapshot.shortCandidateCount,
            candidateStatus: smcSnapshot.candidateStatus,
          };

    return {
      windowFinalSnapshot,
      currentLiveCycleSnapshot,
      latestScanSnapshot,
    };
  }

  public getStatus(nowMs = Date.now()): PaperMonitorStatusResponse {
    this.syncEvaluatedCandidatesToOutcomeTracker(this.activeExchange);
    const statsVer = this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(nowMs);
    const windowState = this.refreshWindowLifecycle(nowMs);
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      nowMs
    );
    this.scanRunId = smcSnapshot.scanRunId;
    const allSignals = this.paperMonitorDb.listTrackedSignals({
      exchange: this.activeExchange,
      includeBlocked: true,
      limit: 2000,
    });
    const outboxList = this.paperMonitorDb.listNotificationOutbox({
      exchange: this.activeExchange,
      limit: 500,
    });

    const tradableSignals = allSignals.filter((s) => s.status !== 'BLOCKED');
    const openSignalsCount = tradableSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const entryWindowMissedCount = Math.max(
      smcSnapshot.entryWindowMissedCount,
      tradableSignals.filter((s) => s.status === 'ENTRY_WINDOW_MISSED').length
    );
    const candidateDetectedBeforeEntryWindowCount = Math.max(
      smcSnapshot.candidateDetectedBeforeEntryWindowCount,
      tradableSignals.filter(
        (s) => s.entryWindowStatus === 'DETECTED_BEFORE_NEXT_BAR_OPEN'
      ).length
    );
    const openTradesCount = tradableSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;
    const paperOpenedCount = tradableSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;
    const winsCount = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_WIN'
    ).length;
    const lossesCount = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_LOSS'
    ).length;
    const expiredCount = tradableSignals.filter(
      (s) => s.status === 'PAPER_EXPIRED'
    ).length;
    const invalidatedCount = tradableSignals.filter(
      (s) => s.status === 'INVALIDATED'
    ).length;
    const blockedCount = allSignals.filter((s) => s.status === 'BLOCKED').length;
    const paperClosedCount = winsCount + lossesCount + expiredCount;

    const sandboxQueuedCount = outboxList.filter(
      (o) => o.status === 'SANDBOX_QUEUED' || o.status === 'PREVIEW_DRY_RUN'
    ).length;
    const pendingEntryNotificationCount = outboxList.filter(
      (o) => o.status === 'PENDING_ENTRY'
    ).length;
    const notificationBlockedCount = outboxList.filter(
      (o) =>
        o.status === 'NON_CANDIDATE_BLOCKED' ||
        o.status === 'DEDUPED_BLOCKED' ||
        o.status === 'COOLDOWN_BLOCKED' ||
        o.status === 'STALE_BLOCKED' ||
        o.status === 'FALLBACK_BLOCKED' ||
        o.status === 'MISSING_DATA_BLOCKED'
    ).length;

    const {
      windowFinalSnapshot,
      currentLiveCycleSnapshot,
      latestScanSnapshot,
    } = this.buildSeparatedSnapshots(nowMs);

    const progressDiag = this.smcBatchScanner.getProgressAndHealth(
      this.activeExchange,
      'live',
      nowMs
    );
    const maxConcurrency = Math.max(
      1,
      progressDiag.maxConcurrency ??
        this.smcBatchScanner.getConfig().maxConcurrency ??
        2
    );
    const runningJobCount = smcSnapshot.runningJobCount;
    const concurrencyValid = runningJobCount <= maxConcurrency;
    const statsConsistency: 'VALID' | 'INVALID' =
      concurrencyValid &&
      progressDiag.statsConsistency === 'VALID' &&
      smcSnapshot.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';
    const stalledSuspected = !concurrencyValid || progressDiag.stalledSuspected;

    return {
      databaseInstanceId: this.radarDb.databaseInstanceId,
      monitorRunId: this.monitorRunId,
      scanRunId: smcSnapshot.scanRunId,
      snapshotAt: smcSnapshot.snapshotAt,
      statsVersion: smcSnapshot.statsVersion,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      safety: TRADING_SAFETY_FLAGS,
      exchange: this.activeExchange,
      ruleVersion: this.ruleVersion,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      workerState: this.workerState,
      monitorWorkerState: progressDiag.monitorWorkerState,
      scanWorkerState: progressDiag.scanWorkerState,
      queueWorkerState: progressDiag.queueWorkerState,
      lastError: this.lastError,
      cyclesCompleted: this.cyclesCompleted,
      intervalMs: this.intervalMs,
      monitoringWindowId: this.monitoringWindowId,
      windowStartedAt: this.windowStartedAt,
      windowExpectedEndAt: this.windowExpectedEndAt,
      windowCompletedAt: windowState.windowCompletedAt,
      windowStatus: windowState.windowStatus,
      windowElapsedMs: windowState.elapsedMs,
      windowRemainingMs: windowState.remainingMs,
      windowElapsedFormatted: windowState.elapsedFormatted,
      windowRemainingFormatted: windowState.remainingFormatted,
      scanCycleId: smcSnapshot.scanCycleId,
      cycleId: smcSnapshot.cycleId,
      cycleStartedAt: smcSnapshot.cycleStartedAt,
      cycleCompletedAt: smcSnapshot.cycleCompletedAt,
      cycleStatus: smcSnapshot.cycleStatus,
      fullUniverseStatus: smcSnapshot.fullUniverseStatus,
      lastCompletedCycleId: smcSnapshot.lastCompletedCycleId,
      lastCompletedCycleDuration: smcSnapshot.lastCompletedCycleDuration,
      statsConsistency,
      candidateStatus: smcSnapshot.candidateStatus,
      completedScanCyclesCount: smcSnapshot.completedScanCyclesCount,
      completedCycles: smcSnapshot.completedCycles,
      totalSymbols: smcSnapshot.totalSymbols,
      totalContracts: smcSnapshot.totalContracts,
      evaluatedCount: smcSnapshot.evaluatedCount,
      totalExpectedHttpRequests: smcSnapshot.totalExpectedHttpRequests,
      completedHttpRequests: smcSnapshot.completedHttpRequests,
      remainingHttpRequests: smcSnapshot.remainingHttpRequests,
      httpRequestsPerSymbol: smcSnapshot.httpRequestsPerSymbol,
      httpEndpointsBreakdown: smcSnapshot.httpEndpointsBreakdown,
      maxHttpConcurrency: smcSnapshot.maxHttpConcurrency,
      maxRequestsPerMinute: smcSnapshot.maxRequestsPerMinute,
      currentRequestsInWindow: smcSnapshot.currentRequestsInWindow,
      estimatedRemainingDuration: smcSnapshot.estimatedRemainingDuration,
      estimateStatus: smcSnapshot.estimateStatus,
      progressRatePerMinute: progressDiag.progressRatePerMinute,
      progressRateStatus: progressDiag.progressRateStatus,
      pendingCount: smcSnapshot.pendingCount,
      queuedCount: smcSnapshot.queuedCount,
      maxConcurrency,
      runningJobCount,
      concurrencyValid,
      stalledSuspected,
      stalledReasons: progressDiag.stalledReasons,
      workerRestartCount: progressDiag.workerRestartCount,
      plannedRestartCount: progressDiag.plannedRestartCount,
      unexpectedRestartCount: progressDiag.unexpectedRestartCount,
      leaseRecoveryCount: progressDiag.leaseRecoveryCount,
      databaseRecoveryCount: progressDiag.databaseRecoveryCount,
      windowPlannedRestartCount: progressDiag.windowPlannedRestartCount,
      windowUnexpectedRestartCount: progressDiag.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: progressDiag.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: progressDiag.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: progressDiag.windowStalledDetectedCount,
      windowConcurrencyViolationCount:
        progressDiag.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: progressDiag.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount:
        progressDiag.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: progressDiag.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: progressDiag.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: progressDiag.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        progressDiag.lifetimeConcurrencyViolationCount,
      failedCount: smcSnapshot.failedCount,
      rateLimitedCount: smcSnapshot.rateLimitedCount,
      waitCount: smcSnapshot.waitCount,
      watchCount: smcSnapshot.watchCount,
      longCandidateCount: smcSnapshot.longCandidateCount,
      shortCandidateCount: smcSnapshot.shortCandidateCount,
      highRiskCount: smcSnapshot.highRiskCount,
      openSignalsCount,
      openTradesCount,
      paperOpenedCount,
      paperClosedCount,
      entryWindowMissedCount,
      currentCycleEntryWindowMissedCount:
        progressDiag.currentCycleEntryWindowMissedCount ??
        progressDiag.entryWindowMissedCount ??
        0,
      monitoringWindowEntryWindowMissedCount:
        progressDiag.monitoringWindowEntryWindowMissedCount ??
        entryWindowMissedCount,
      cumulativeEntryWindowMissedCount:
        progressDiag.cumulativeEntryWindowMissedCount ?? entryWindowMissedCount,
      winsCount,
      lossesCount,
      expiredCount,
      invalidatedCount,
      blockedCount,
      sandboxQueuedCount,
      pendingEntryNotificationCount,
      notificationBlockedCount,
      lastFullRadarScanAt: smcSnapshot.lastFullRadarScanAt,
      lastPriorityScanAt: smcSnapshot.lastPriorityScanAt,
      radarScanDurationMs: smcSnapshot.radarScanDurationMs,
      prewarmDurationMs: smcSnapshot.prewarmDurationMs,
      prewarmCacheHitRate: smcSnapshot.prewarmCacheHitRate,
      prioritySmcDurationMs: smcSnapshot.prioritySmcDurationMs,
      fullCycleDurationMs: smcSnapshot.fullCycleDurationMs,
      fullUniverseCompletionDurationMs:
        smcSnapshot.fullUniverseCompletionDurationMs,
      coldStartFullUniverseCompletionDuration:
        smcSnapshot.coldStartFullUniverseCompletionDuration,
      warmCacheFullUniverseCompletionDuration:
        smcSnapshot.warmCacheFullUniverseCompletionDuration,
      queueWaitMs: smcSnapshot.queueWaitMs,
      prewarmWaitMs: smcSnapshot.prewarmWaitMs,
      httpRequestLatencyMs: smcSnapshot.httpRequestLatencyMs,
      smcCalculationLatencyMs: smcSnapshot.smcCalculationLatencyMs,
      dbWriteLatencyMs: smcSnapshot.dbWriteLatencyMs,
      smcEvaluationLatencyMs: smcSnapshot.smcEvaluationLatencyMs,
      rateLimitWaitMs: smcSnapshot.rateLimitWaitMs,
      detectionLatencyMs: smcSnapshot.detectionLatencyMs,
      p50DetectionLatencyMs: smcSnapshot.p50DetectionLatencyMs,
      p90DetectionLatencyMs: smcSnapshot.p90DetectionLatencyMs,
      p95DetectionLatencyMs: smcSnapshot.p95DetectionLatencyMs,
      p99DetectionLatencyMs: smcSnapshot.p99DetectionLatencyMs,
      maxDetectionLatencyMs: smcSnapshot.maxDetectionLatencyMs,
      p50PriorityDetectionLatencyMs: smcSnapshot.p50PriorityDetectionLatencyMs,
      p90PriorityDetectionLatencyMs: smcSnapshot.p90PriorityDetectionLatencyMs,
      p95PriorityDetectionLatencyMs: smcSnapshot.p95PriorityDetectionLatencyMs,
      p99PriorityDetectionLatencyMs: smcSnapshot.p99PriorityDetectionLatencyMs,
      maxPriorityDetectionLatencyMs: smcSnapshot.maxPriorityDetectionLatencyMs,
      p50BulkQueueWaitMs: smcSnapshot.p50BulkQueueWaitMs,
      p90BulkQueueWaitMs: smcSnapshot.p90BulkQueueWaitMs,
      p95BulkQueueWaitMs: smcSnapshot.p95BulkQueueWaitMs,
      p99BulkQueueWaitMs: smcSnapshot.p99BulkQueueWaitMs,
      maxBulkQueueWaitMs: smcSnapshot.maxBulkQueueWaitMs,
      p50FullUniverseDetectionLatencyMs:
        smcSnapshot.p50FullUniverseDetectionLatencyMs,
      p90FullUniverseDetectionLatencyMs:
        smcSnapshot.p90FullUniverseDetectionLatencyMs,
      p95FullUniverseDetectionLatencyMs:
        smcSnapshot.p95FullUniverseDetectionLatencyMs,
      p99FullUniverseDetectionLatencyMs:
        smcSnapshot.p99FullUniverseDetectionLatencyMs,
      maxFullUniverseDetectionLatencyMs:
        smcSnapshot.maxFullUniverseDetectionLatencyMs,
      priorityDetectionLatency: smcSnapshot.priorityDetectionLatency,
      bulkUniverseQueueLatency: smcSnapshot.bulkUniverseQueueLatency,
      bulkQueueWait: smcSnapshot.bulkQueueWait,
      fullUniverseCompletionLatency: smcSnapshot.fullUniverseCompletionLatency,
      coldStartPriorityDetectionLatency:
        smcSnapshot.coldStartPriorityDetectionLatency,
      warmCachePriorityDetectionLatency:
        smcSnapshot.warmCachePriorityDetectionLatency,
      coldStartPrioritySLA: smcSnapshot.coldStartPrioritySLA,
      warmCachePrioritySLA: smcSnapshot.warmCachePrioritySLA,
      priorityDetectionSLA: smcSnapshot.priorityDetectionSLA,
      fullUniverseCompletionDuration:
        smcSnapshot.fullUniverseCompletionDuration,
      coldStartFullUniverseDuration:
        smcSnapshot.coldStartFullUniverseDuration,
      warmFullUniverseDuration: smcSnapshot.warmFullUniverseDuration,
      coldStartFullUniverseSLA: smcSnapshot.coldStartFullUniverseSLA,
      coldStartP50: smcSnapshot.coldStartP50,
      coldStartP95: smcSnapshot.coldStartP95,
      warmCacheP50: smcSnapshot.warmCacheP50,
      warmCacheP95: smcSnapshot.warmCacheP95,
      priorityExecutionBreakdown: smcSnapshot.priorityExecutionBreakdown,
      latencyBreakdown: smcSnapshot.latencyBreakdown,
      slowestSymbolsTop20: smcSnapshot.slowestSymbolsTop20,
      cacheHitCount: smcSnapshot.cacheHitCount,
      cacheMissCount: smcSnapshot.cacheMissCount,
      cacheHitRate: smcSnapshot.cacheHitRate,
      cacheMissRate: smcSnapshot.cacheMissRate,
      cacheCoverage: smcSnapshot.cacheCoverage,
      cacheCoverageRate: smcSnapshot.cacheCoverageRate,
      freshCacheCount: smcSnapshot.freshCacheCount,
      expiredCacheCount: smcSnapshot.expiredCacheCount,
      staleCacheCount: smcSnapshot.staleCacheCount,
      prewarmRequiredCount: smcSnapshot.prewarmRequiredCount,
      '5mCoverage': smcSnapshot['5mCoverage'],
      '15mCoverage': smcSnapshot['15mCoverage'],
      '1hCoverage': smcSnapshot['1hCoverage'],
      '4hCoverage': smcSnapshot['4hCoverage'],
      '5mCacheCoverage': smcSnapshot['5mCacheCoverage'],
      '15mCacheCoverage': smcSnapshot['15mCacheCoverage'],
      '1hCacheCoverage': smcSnapshot['1hCacheCoverage'],
      '4hCacheCoverage': smcSnapshot['4hCacheCoverage'],
      oiCacheCoverage: smcSnapshot.oiCacheCoverage,
      fundingCacheCoverage: smcSnapshot.fundingCacheCoverage,
      cacheStatus: smcSnapshot.cacheStatus,
      cacheStatusLabel: smcSnapshot.cacheStatusLabel,
      cacheMode: smcSnapshot.cacheMode,
      cacheModeLabel: smcSnapshot.cacheModeLabel,
      latestPrewarmSnapshot: smcSnapshot.latestPrewarmSnapshot,
      prewarmTasks: smcSnapshot.prewarmTasks,
      candidateDetectedBeforeEntryWindowCount,
      priorityRefreshCount: smcSnapshot.priorityRefreshCount,
      rateLimitCount: smcSnapshot.rateLimitCount,
      failedJobCount: smcSnapshot.failedCount,
      windowFinalSnapshot,
      currentLiveCycleSnapshot,
      latestScanSnapshot,
      aggregationScope: progressDiag.aggregationScope ?? 'CURRENT_CYCLE',
      evaluationUniverseSize:
        progressDiag.evaluationUniverseSize ?? smcSnapshot.totalSymbols,
      evaluatedDenominator:
        progressDiag.evaluatedDenominator ?? smcSnapshot.evaluatedCount,
      excludedCount:
        progressDiag.excludedCount ??
        Math.max(0, smcSnapshot.totalSymbols - smcSnapshot.evaluatedCount),
      excludedSymbols: progressDiag.excludedSymbols ?? [],
      excludedReasons: progressDiag.excludedReasons ?? {},
      consistencyErrors: progressDiag.consistencyErrors ?? [],
      candidateFunnel: progressDiag.candidateFunnel,
      currentCycleFunnel: progressDiag.currentCycleFunnel,
      latestSnapshotFunnel: progressDiag.latestSnapshotFunnel,
      monitoringWindowFunnel: progressDiag.monitoringWindowFunnel,
      cumulativeFunnel: progressDiag.cumulativeFunnel,
      historicalSignalsOutsideCurrentCycle:
        progressDiag.historicalSignalsOutsideCurrentCycle,
      historicalSignalsOutsideCurrentCycleCount:
        progressDiag.historicalSignalsOutsideCurrentCycleCount ?? 0,
      historicalSignalsOutsideWindow:
        progressDiag.historicalSignalsOutsideWindow,
      historicalSignalsOutsideWindowCount:
        progressDiag.historicalSignalsOutsideWindowCount ?? 0,
      smcGateDiagnostics: progressDiag.smcGateDiagnostics,
      paperEligibilityAudit: progressDiag.paperEligibilityAudit,
      scopedGateStatistics: progressDiag.scopedGateStatistics,
      observationShadowComparison: progressDiag.observationShadowComparison,
      formalCandidateCount:
        progressDiag.formalCandidateCount ??
        progressDiag.candidateDetectedCount ??
        0,
      formalCandidateLatencySla: progressDiag.formalCandidateLatencySla,
      DEMO_LATENCY_FIXTURE: progressDiag.DEMO_LATENCY_FIXTURE,
      LIVE_FORMAL_CANDIDATE_COUNT:
        progressDiag.LIVE_FORMAL_CANDIDATE_COUNT ?? 0,
      LIVE_FAST_LANE_COUNT: progressDiag.LIVE_FAST_LANE_COUNT ?? 0,
      LIVE_BULK_COUNT: progressDiag.LIVE_BULK_COUNT ?? 0,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
        progressDiag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT ?? 0,
      LIVE_ENTRY_WINDOW_MISSED_COUNT:
        progressDiag.LIVE_ENTRY_WINDOW_MISSED_COUNT ?? 0,
      LIVE_DETECTION_LATENCY_P50:
        progressDiag.LIVE_DETECTION_LATENCY_P50 ?? null,
      LIVE_DETECTION_LATENCY_P95:
        progressDiag.LIVE_DETECTION_LATENCY_P95 ?? null,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50:
        progressDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P50 ?? null,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95:
        progressDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P95 ?? null,
      LIVE_BULK_DETECTION_LATENCY_P50:
        progressDiag.LIVE_BULK_DETECTION_LATENCY_P50 ?? null,
      LIVE_BULK_DETECTION_LATENCY_P95:
        progressDiag.LIVE_BULK_DETECTION_LATENCY_P95 ?? null,
      fastLaneFormalCandidateCount:
        progressDiag.fastLaneFormalCandidateCount ?? 0,
      bulkFormalCandidateCount: progressDiag.bulkFormalCandidateCount ?? 0,
      entryWindowMissedRate: progressDiag.entryWindowMissedRate ?? null,
      candidateDetectionLatencyP50:
        progressDiag.candidateDetectionLatencyP50 ?? null,
      candidateDetectionLatencyP95:
        progressDiag.candidateDetectionLatencyP95 ?? null,
      queueWaitP50: progressDiag.queueWaitP50 ?? null,
      queueWaitP95: progressDiag.queueWaitP95 ?? null,
      nearMissCount: progressDiag.nearMissCount,
      nearMissMissing1Count: progressDiag.nearMissMissing1Count,
      nearMissMissing2Count: progressDiag.nearMissMissing2Count,
      nearMissMissingGates: progressDiag.nearMissMissingGates,
      lastBlockingGate: progressDiag.lastBlockingGate,
      candidateDetectedCount: progressDiag.candidateDetectedCount,
      eligiblePaperSignalCount: progressDiag.eligiblePaperSignalCount,
      paperEligibleCount: progressDiag.paperEligibleCount,
      currentCyclePaperEligibleCount:
        progressDiag.currentCyclePaperEligibleCount ??
        progressDiag.eligiblePaperSignalCount ??
        0,
      monitoringWindowPaperEligibleCount:
        progressDiag.monitoringWindowPaperEligibleCount ?? 0,
      cumulativePaperEligibleCount:
        progressDiag.cumulativePaperEligibleCount ?? 0,
      historicalPaperEligibleCount:
        progressDiag.historicalPaperEligibleCount ?? 0,
      externalNotificationCount: 0,
      externalTelegramRequestsCount: 0,
      externalTradingViewRequestsCount: 0,
    };
  }

  public getDiagnostics() {
    this.checkStatsVersionMonotonicity();
    return this.radarDb.computePhase6Diagnostics(this.activeExchange);
  }

  public getReport(
    window: PaperMonitorReportWindow = '24h',
    nowMs = Date.now(),
    reportAnchorAt?: string
  ): PaperMonitorReportResponse {
    this.checkStatsVersionMonotonicity();
    const anchorMs =
      reportAnchorAt && Number.isFinite(Date.parse(reportAnchorAt))
        ? Date.parse(reportAnchorAt)
        : nowMs;
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      anchorMs
    );
    const base = this.outcomeTracker.buildWindowReport({
      window,
      exchange: this.activeExchange,
      monitorRunId: this.monitorRunId,
      scanRunId: this.scanRunId,
      reportAnchorAt,
      nowMs,
    });
    return {
      ...base,
      scanRunId: smcSnapshot.scanRunId,
      snapshotAt: smcSnapshot.snapshotAt,
      reportGeneratedAt: base.reportGeneratedAt,
      reportAnchorAt: base.reportAnchorAt,
      signalDetectedAt: base.signalDetectedAt,
      scanCycleCompletedAt: smcSnapshot.cycleCompletedAt,
      statsVersion: smcSnapshot.statsVersion,
      scanCycleId: smcSnapshot.scanCycleId,
      cycleId: smcSnapshot.cycleId,
      cycleStatus: smcSnapshot.cycleStatus,
      fullUniverseStatus: smcSnapshot.fullUniverseStatus,
      cycleStartedAt: smcSnapshot.cycleStartedAt,
      cycleCompletedAt: smcSnapshot.cycleCompletedAt,
      lastCompletedCycleId: smcSnapshot.lastCompletedCycleId,
      lastCompletedCycleDuration: smcSnapshot.lastCompletedCycleDuration,
      statsConsistency: smcSnapshot.statsConsistency,
      totalSymbols: smcSnapshot.totalSymbols,
      evaluatedCount: smcSnapshot.evaluatedCount,
      pendingCount: smcSnapshot.pendingCount,
      queuedCount: smcSnapshot.queuedCount,
      runningJobCount: smcSnapshot.runningJobCount,
      failedCount: smcSnapshot.failedCount,
      rateLimitedCount: smcSnapshot.rateLimitedCount,
      waitCount: smcSnapshot.waitCount,
      watchCount: smcSnapshot.watchCount,
      highRiskCount: smcSnapshot.highRiskCount,
      longCandidateCount: smcSnapshot.longCandidateCount,
      shortCandidateCount: smcSnapshot.shortCandidateCount,
      totalExpectedHttpRequests: smcSnapshot.totalExpectedHttpRequests,
      completedHttpRequests: smcSnapshot.completedHttpRequests,
      remainingHttpRequests: smcSnapshot.remainingHttpRequests,
      httpRequestsPerSymbol: smcSnapshot.httpRequestsPerSymbol,
      httpEndpointsBreakdown: smcSnapshot.httpEndpointsBreakdown,
      maxHttpConcurrency: smcSnapshot.maxHttpConcurrency,
      maxRequestsPerMinute: smcSnapshot.maxRequestsPerMinute,
      currentRequestsInWindow: smcSnapshot.currentRequestsInWindow,
      rateLimitCount: smcSnapshot.rateLimitCount,
      estimatedRemainingDuration: smcSnapshot.estimatedRemainingDuration,
      estimateStatus: smcSnapshot.estimateStatus,
      lastFullRadarScanAt: smcSnapshot.lastFullRadarScanAt,
      lastPriorityScanAt: smcSnapshot.lastPriorityScanAt,
      prewarmDurationMs: smcSnapshot.prewarmDurationMs,
      prewarmCacheHitRate: smcSnapshot.prewarmCacheHitRate,
      queueWaitMs: smcSnapshot.queueWaitMs,
      prewarmWaitMs: smcSnapshot.prewarmWaitMs,
      httpRequestLatencyMs: smcSnapshot.httpRequestLatencyMs,
      smcCalculationLatencyMs: smcSnapshot.smcCalculationLatencyMs,
      dbWriteLatencyMs: smcSnapshot.dbWriteLatencyMs,
      smcEvaluationLatencyMs: smcSnapshot.smcEvaluationLatencyMs,
      rateLimitWaitMs: smcSnapshot.rateLimitWaitMs,
      detectionLatencyMs: smcSnapshot.detectionLatencyMs,
      p50DetectionLatencyMs: smcSnapshot.p50DetectionLatencyMs,
      p90DetectionLatencyMs: smcSnapshot.p90DetectionLatencyMs,
      p95DetectionLatencyMs: smcSnapshot.p95DetectionLatencyMs,
      p99DetectionLatencyMs: smcSnapshot.p99DetectionLatencyMs,
      maxDetectionLatencyMs: smcSnapshot.maxDetectionLatencyMs,
      p50PriorityDetectionLatencyMs: smcSnapshot.p50PriorityDetectionLatencyMs,
      p90PriorityDetectionLatencyMs: smcSnapshot.p90PriorityDetectionLatencyMs,
      p95PriorityDetectionLatencyMs: smcSnapshot.p95PriorityDetectionLatencyMs,
      p99PriorityDetectionLatencyMs: smcSnapshot.p99PriorityDetectionLatencyMs,
      p95BulkQueueWaitMs: smcSnapshot.p95BulkQueueWaitMs,
      fullUniverseCompletionDurationMs:
        smcSnapshot.fullUniverseCompletionDurationMs,
      coldStartFullUniverseCompletionDuration:
        smcSnapshot.coldStartFullUniverseCompletionDuration,
      warmCacheFullUniverseCompletionDuration:
        smcSnapshot.warmCacheFullUniverseCompletionDuration,
      cacheHitRate: smcSnapshot.cacheHitRate,
      cacheMissRate: smcSnapshot.cacheMissRate,
      priorityDetectionLatency: smcSnapshot.priorityDetectionLatency,
      bulkUniverseQueueLatency: smcSnapshot.bulkUniverseQueueLatency,
      bulkQueueWait: smcSnapshot.bulkQueueWait,
      fullUniverseCompletionLatency: smcSnapshot.fullUniverseCompletionLatency,
      coldStartPriorityDetectionLatency:
        smcSnapshot.coldStartPriorityDetectionLatency,
      warmCachePriorityDetectionLatency:
        smcSnapshot.warmCachePriorityDetectionLatency,
      coldStartPrioritySLA: smcSnapshot.coldStartPrioritySLA,
      warmCachePrioritySLA: smcSnapshot.warmCachePrioritySLA,
      priorityDetectionSLA: smcSnapshot.priorityDetectionSLA,
      fullUniverseCompletionDuration:
        smcSnapshot.fullUniverseCompletionDuration,
      coldStartFullUniverseDuration:
        smcSnapshot.coldStartFullUniverseDuration,
      warmFullUniverseDuration: smcSnapshot.warmFullUniverseDuration,
      coldStartFullUniverseSLA: smcSnapshot.coldStartFullUniverseSLA,
      coldStartP50: smcSnapshot.coldStartP50,
      coldStartP95: smcSnapshot.coldStartP95,
      warmCacheP50: smcSnapshot.warmCacheP50,
      warmCacheP95: smcSnapshot.warmCacheP95,
      priorityExecutionBreakdown: smcSnapshot.priorityExecutionBreakdown,
      latencyBreakdown: smcSnapshot.latencyBreakdown,
      slowestSymbolsTop20: smcSnapshot.slowestSymbolsTop20,
      cacheHitCount: smcSnapshot.cacheHitCount,
      cacheMissCount: smcSnapshot.cacheMissCount,
      cacheCoverage: smcSnapshot.cacheCoverage,
      cacheCoverageRate: smcSnapshot.cacheCoverageRate,
      freshCacheCount: smcSnapshot.freshCacheCount,
      expiredCacheCount: smcSnapshot.expiredCacheCount,
      staleCacheCount: smcSnapshot.staleCacheCount,
      prewarmRequiredCount: smcSnapshot.prewarmRequiredCount,
      '5mCoverage': smcSnapshot['5mCoverage'],
      '15mCoverage': smcSnapshot['15mCoverage'],
      '1hCoverage': smcSnapshot['1hCoverage'],
      '4hCoverage': smcSnapshot['4hCoverage'],
      '5mCacheCoverage': smcSnapshot['5mCacheCoverage'],
      '15mCacheCoverage': smcSnapshot['15mCacheCoverage'],
      '1hCacheCoverage': smcSnapshot['1hCacheCoverage'],
      '4hCacheCoverage': smcSnapshot['4hCacheCoverage'],
      oiCacheCoverage: smcSnapshot.oiCacheCoverage,
      fundingCacheCoverage: smcSnapshot.fundingCacheCoverage,
      cacheStatus: smcSnapshot.cacheStatus,
      cacheStatusLabel: smcSnapshot.cacheStatusLabel,
      cacheMode: smcSnapshot.cacheMode,
      cacheModeLabel: smcSnapshot.cacheModeLabel,
      latestPrewarmSnapshot: smcSnapshot.latestPrewarmSnapshot,
      prewarmTasks: smcSnapshot.prewarmTasks,
      candidateDetectedBeforeEntryWindowCount: Math.max(
        base.candidateDetectedBeforeEntryWindowCount ?? 0,
        smcSnapshot.candidateDetectedBeforeEntryWindowCount
      ),
      entryWindowMissedCount: Math.max(
        base.entryWindowMissed,
        smcSnapshot.entryWindowMissedCount
      ),
      priorityRefreshCount: smcSnapshot.priorityRefreshCount,
    };
  }

  /**
   * Builds the full Phase 7 24-Hour Monitoring Window Report (Sections 二, 三, 四, 五, 六, 七).
   */
  public get24hWindowReport(nowMs = Date.now()): Phase7MonitoringWindowReport {
    const statsVer = this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(nowMs);
    const windowState = this.refreshWindowLifecycle(nowMs);
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(
      this.activeExchange,
      nowMs
    );
    const diag = this.radarDb.computePhase6Diagnostics(
      this.activeExchange
    );

    const cycles = this.paperMonitorDb.listMonitoringWindowCycles(
      this.monitoringWindowId
    );
    const validCycles = cycles.filter((c) => c.cycleValid);
    const invalidCycles = cycles.filter((c) => !c.cycleValid);
    const lastValidWindowCycle =
      validCycles.length > 0
        ? validCycles[validCycles.length - 1]
        : cycles.length > 0
          ? cycles[cycles.length - 1]
          : null;

    const allSignals = this.paperMonitorDb.listTrackedSignals({
      exchange: this.activeExchange,
      includeBlocked: true,
      limit: 5000,
    });
    const outboxList = this.paperMonitorDb.listNotificationOutbox({
      exchange: this.activeExchange,
      limit: 500,
    });

    const tradableSignals = allSignals.filter((s) => s.status !== 'BLOCKED');
    const blockedSignals = allSignals.filter((s) => s.status === 'BLOCKED');

    const longSignals = tradableSignals.filter((s) => s.direction === 'LONG');
    const shortSignals = tradableSignals.filter((s) => s.direction === 'SHORT');

    const maxCycleLongCandidates = validCycles.reduce(
      (acc, c) => Math.max(acc, c.longCandidateCount),
      0
    );
    const maxCycleShortCandidates = validCycles.reduce(
      (acc, c) => Math.max(acc, c.shortCandidateCount),
      0
    );

    const isWindowFrozenCompleted =
      windowState.windowStatus === 'COMPLETED' && validCycles.length > 0;

    const totalLongCandidates = isWindowFrozenCompleted
      ? Math.max(longSignals.length, maxCycleLongCandidates)
      : Math.max(
          longSignals.length,
          maxCycleLongCandidates,
          smcSnapshot.longCandidateCount
        );
    const totalShortCandidates = isWindowFrozenCompleted
      ? Math.max(shortSignals.length, maxCycleShortCandidates)
      : Math.max(
          shortSignals.length,
          maxCycleShortCandidates,
          smcSnapshot.shortCandidateCount
        );
    const totalSignals = tradableSignals.length;
    const openSignals = tradableSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const entryWindowMissed = tradableSignals.filter(
      (s) => s.status === 'ENTRY_WINDOW_MISSED'
    ).length;
    const openTrades = tradableSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;

    const totalPaperOpened = tradableSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;

    const winsList = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_WIN'
    );
    const lossesList = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_LOSS'
    );
    const expiredList = tradableSignals.filter(
      (s) => s.status === 'PAPER_EXPIRED'
    );
    const invalidatedList = tradableSignals.filter(
      (s) => s.status === 'INVALIDATED'
    );
    const closedList = [...winsList, ...lossesList, ...expiredList];

    const totalPaperClosed = closedList.length;
    const totalWins = winsList.length;
    const totalLosses = lossesList.length;
    const totalExpired = expiredList.length;
    const totalInvalidated = invalidatedList.length;
    const totalBlocked = blockedSignals.length;

    const base24hMetrics = this.outcomeTracker.buildWindowReport({
      window: '24h',
      exchange: this.activeExchange,
      monitorRunId: this.monitorRunId,
      scanRunId: smcSnapshot.scanRunId,
      sinceIso: this.windowStartedAt,
      nowMs,
    });

    const results = smcSnapshot.results;
    const currentStaleCount = results.filter((r) => r.stale).length;
    const currentFallbackCount = results.filter((r) => r.fallback).length;
    const currentMissingDataCount = results.filter(
      (r) => Array.isArray(r.missingData) && r.missingData.length > 0
    ).length;

    const staleCount = isWindowFrozenCompleted
      ? cycles.reduce((acc, c) => acc + c.staleCount, 0)
      : currentStaleCount + cycles.reduce((acc, c) => acc + c.staleCount, 0);
    const fallbackCount = isWindowFrozenCompleted
      ? cycles.reduce((acc, c) => acc + c.fallbackCount, 0)
      : currentFallbackCount +
        cycles.reduce((acc, c) => acc + c.fallbackCount, 0);
    const missingDataCount = isWindowFrozenCompleted
      ? cycles.reduce((acc, c) => acc + c.missingDataCount, 0)
      : currentMissingDataCount +
        cycles.reduce((acc, c) => acc + c.missingDataCount, 0);
    const failedCount = isWindowFrozenCompleted
      ? cycles.reduce((acc, c) => acc + c.failedCount, 0)
      : smcSnapshot.failedCount +
        cycles.reduce((acc, c) => acc + c.failedCount, 0);
    const rateLimitedCount = isWindowFrozenCompleted
      ? cycles.reduce((acc, c) => acc + c.rateLimitedCount, 0)
      : smcSnapshot.rateLimitedCount +
        this.rateLimitCount +
        cycles.reduce((acc, c) => acc + c.rateLimitedCount, 0);

    // Section 六: Candidate Status Determination
    let candidateStatus: CandidateDiagnosisStatus;
    if (totalLongCandidates > 0 || totalShortCandidates > 0) {
      candidateStatus = 'HAS_CANDIDATES';
    } else if (isWindowFrozenCompleted) {
      candidateStatus =
        invalidCycles.length > 0 ||
        staleCount > 0 ||
        fallbackCount > 0 ||
        missingDataCount > 0 ||
        failedCount > 0 ||
        rateLimitedCount > 0 ||
        this.finalCategorySmcMismatchCount > 0
          ? 'NO_CANDIDATE_SUSPECTED'
          : 'NO_CANDIDATE_VALID';
    } else if (
      smcSnapshot.totalContracts === 0 ||
      smcSnapshot.evaluatedCount < smcSnapshot.totalContracts ||
      smcSnapshot.pendingCount > 0 ||
      currentStaleCount > 0 ||
      currentFallbackCount > 0 ||
      currentMissingDataCount > 0 ||
      smcSnapshot.failedCount > 0 ||
      smcSnapshot.rateLimitedCount > 0 ||
      this.finalCategorySmcMismatchCount > 0 ||
      invalidCycles.length > 0 ||
      diag.candidateStatus === 'NO_CANDIDATE_SUSPECTED'
    ) {
      candidateStatus = 'NO_CANDIDATE_SUSPECTED';
    } else {
      candidateStatus = 'NO_CANDIDATE_VALID';
    }

    const totalContractsEvaluated =
      validCycles.length > 0
        ? validCycles.reduce((acc, c) => acc + c.evaluatedCount, 0)
        : smcSnapshot.evaluatedCount;

    const full24hVerificationNotice =
      windowState.windowStatus === 'COMPLETED'
        ? this.isVerifiableTimeSeriesReplay
          ? '24 小時監控：已透過可驗證時間序列回放完成 (COMPLETED)'
          : '24 小時監控：已完成完整 24 小時實機運行 (COMPLETED)'
        : windowState.windowStatus === 'INTERRUPTED'
          ? `24 小時監控：監控中斷 (${this.interruptionReason ?? '未滿 24 小時中斷'})`
          : windowState.windowStatus === 'ERROR'
            ? `24 小時監控：錯誤狀態 (${this.lastError ?? '資料品質或連線異常'})`
            : '24 小時監控：未完成／未驗證（目前即時運行中，實際時間尚未滿 24 小時）';

    const candidateTimeline = tradableSignals.map((s) => ({
      signalId: s.signalId,
      symbol: s.symbol,
      direction: s.direction,
      scanCycleId: s.scanCycleId ?? smcSnapshot.scanCycleId,
      marketRadarCategory: s.marketRadarCategory,
      smcActionState: s.smcActionState,
      finalTradeSignal: s.finalTradeSignal,
      evaluatedAt: s.evaluatedAt,
      signalDetectedAt: s.signalDetectedAt,
      snapshotAt: s.snapshotAt,
      ruleVersion: s.ruleVersion,
      signalBarOpenTime: s.signalBarOpenTime,
      signalBarCloseTime: s.signalBarCloseTime,
      originalEntryWindowOpenTime: s.originalEntryWindowOpenTime,
      originalEntryWindowCloseTime: s.originalEntryWindowCloseTime,
      entryReferenceTime: s.entryReferenceTime,
      entryReferencePrice: s.entryReferencePrice,
      detectionLatencyMs: s.detectionLatencyMs,
      entryStatus: s.entryStatus,
      entryWindowStatus: s.entryWindowStatus,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      riskMultiple: s.riskMultiple,
      waitReasons: s.waitReasons,
      status: s.status,
    }));

    const signalDecisionTraces = tradableSignals.map((s) => ({
      signalId: s.signalId,
      symbol: s.symbol,
      direction: s.direction,
      scanCycleId: s.scanCycleId ?? smcSnapshot.scanCycleId,
      evaluatedAt: s.evaluatedAt,
      decisionTrace: s.decisionTrace ?? null,
    }));

    const paperOutcomeTimeline = tradableSignals.map((s) => ({
      signalId: s.signalId,
      symbol: s.symbol,
      direction: s.direction,
      status: s.status,
      entryStatus: s.entryStatus,
      entryWindowStatus: s.entryWindowStatus,
      signalBarOpenTime: s.signalBarOpenTime,
      signalBarCloseTime: s.signalBarCloseTime,
      signalDetectedAt: s.signalDetectedAt,
      originalEntryWindowOpenTime: s.originalEntryWindowOpenTime,
      originalEntryWindowCloseTime: s.originalEntryWindowCloseTime,
      detectionLatencyMs: s.detectionLatencyMs,
      entryReferenceTime: s.entryReferenceTime,
      entryReferencePrice: s.entryReferencePrice,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      exitTime: s.exitTime,
      exitPrice: s.exitPrice,
      riskMultiple: s.riskMultiple,
      holdingTimeMs: s.holdingTimeMs,
      statusReason: s.statusReason,
      updatedAt: s.updatedAt,
    }));

    const dataQualityTimeline = cycles.map((c) => ({
      scanCycleId: c.scanCycleId,
      snapshotAt: c.snapshotAt,
      statsVersion: c.statsVersion,
      totalContracts: c.totalContracts,
      evaluatedCount: c.evaluatedCount,
      pendingCount: c.pendingCount,
      failedCount: c.failedCount,
      rateLimitedCount: c.rateLimitedCount,
      staleCount: c.staleCount,
      fallbackCount: c.fallbackCount,
      missingDataCount: c.missingDataCount,
      finalCategorySmcMismatchCount: c.finalCategorySmcMismatchCount,
      cycleValid: c.cycleValid,
      dataQualityWarning: c.dataQualityWarning,
    }));

    const {
      windowFinalSnapshot,
      currentLiveCycleSnapshot,
      latestScanSnapshot,
    } = this.buildSeparatedSnapshots(nowMs);

    const sandboxQueuedCount = outboxList.filter(
      (o) => o.status === 'SANDBOX_QUEUED' || o.status === 'PREVIEW_DRY_RUN'
    ).length;
    const pendingEntryNotificationCount = outboxList.filter(
      (o) => o.status === 'PENDING_ENTRY'
    ).length;
    const notificationBlockedCount = outboxList.filter(
      (o) =>
        o.status === 'NON_CANDIDATE_BLOCKED' ||
        o.status === 'DEDUPED_BLOCKED' ||
        o.status === 'COOLDOWN_BLOCKED' ||
        o.status === 'STALE_BLOCKED' ||
        o.status === 'FALLBACK_BLOCKED' ||
        o.status === 'MISSING_DATA_BLOCKED'
    ).length;
    const notificationBlockedBreakdown: Record<string, number> = {
      NON_CANDIDATE_BLOCKED: outboxList.filter(
        (o) => o.status === 'NON_CANDIDATE_BLOCKED'
      ).length,
      DEDUPED_BLOCKED: outboxList.filter((o) => o.status === 'DEDUPED_BLOCKED')
        .length,
      COOLDOWN_BLOCKED: outboxList.filter(
        (o) => o.status === 'COOLDOWN_BLOCKED'
      ).length,
      STALE_BLOCKED: outboxList.filter((o) => o.status === 'STALE_BLOCKED')
        .length,
      FALLBACK_BLOCKED: outboxList.filter(
        (o) => o.status === 'FALLBACK_BLOCKED'
      ).length,
      MISSING_DATA_BLOCKED: outboxList.filter(
        (o) => o.status === 'MISSING_DATA_BLOCKED'
      ).length,
      PENDING_ENTRY: pendingEntryNotificationCount,
    };

    return {
      databaseInstanceId: this.radarDb.databaseInstanceId,
      monitorRunId: this.monitorRunId,
      scanRunId: smcSnapshot.scanRunId,
      snapshotAt: smcSnapshot.snapshotAt,
      statsVersion: smcSnapshot.statsVersion,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      safety: TRADING_SAFETY_FLAGS,
      exchange: this.activeExchange,
      ruleVersion: this.ruleVersion,
      monitoringWindowId: this.monitoringWindowId,
      windowStartedAt: this.windowStartedAt,
      windowExpectedEndAt: this.windowExpectedEndAt,
      windowCompletedAt: windowState.windowCompletedAt,
      windowStatus: windowState.windowStatus,
      windowElapsedMs: windowState.elapsedMs,
      windowRemainingMs: windowState.remainingMs,
      windowElapsedFormatted: windowState.elapsedFormatted,
      windowRemainingFormatted: windowState.remainingFormatted,
      isVerifiableTimeSeriesReplay: this.isVerifiableTimeSeriesReplay,
      full24hVerificationNotice,
      totalScanCycles: cycles.length,
      completedScanCycles: validCycles.length,
      interruptedScanCycles: invalidCycles.length,
      totalContractsEvaluated,
      evaluatedCount: smcSnapshot.evaluatedCount,
      pendingCount: smcSnapshot.pendingCount,
      totalLongCandidates,
      totalShortCandidates,
      totalSignals,
      openSignals,
      openTrades,
      totalPaperOpened,
      totalPaperClosed,
      paperOpened: totalPaperOpened,
      paperClosed: totalPaperClosed,
      entryWindowMissed,
      totalWins,
      totalLosses,
      totalExpired,
      totalInvalidated,
      totalBlocked,
      metricStatus: base24hMetrics.metricStatus,
      sampleSufficiencyNotice: base24hMetrics.sampleSufficiencyNotice,
      winRate: base24hMetrics.winRate,
      averageR: base24hMetrics.averageR,
      profitFactor: base24hMetrics.profitFactor,
      maxDrawdownR: base24hMetrics.maxDrawdownR,
      expectancyR: base24hMetrics.expectancyR,
      averageHoldingTime: base24hMetrics.averageHoldingTime,
      waitCount: smcSnapshot.waitCount,
      watchCount: smcSnapshot.watchCount,
      highRiskCount: smcSnapshot.highRiskCount,
      longCandidateCount: smcSnapshot.longCandidateCount,
      shortCandidateCount: smcSnapshot.shortCandidateCount,
      waitReasonBreakdown: diag.reasonDistribution.waitReasonCounts,
      watchReasonBreakdown: diag.reasonDistribution.watchReasonCounts,
      highRiskReasonBreakdown: diag.reasonDistribution.highRiskReasonCounts,
      staleCount,
      fallbackCount,
      missingDataCount,
      failedCount: smcSnapshot.failedCount,
      rateLimitedCount: smcSnapshot.rateLimitedCount,
      finalCategorySmcMismatchCount: this.finalCategorySmcMismatchCount,
      sandboxQueuedCount,
      pendingEntryNotificationCount,
      notificationBlockedCount,
      notificationBlockedBreakdown,
      externalNotificationCount: 0,
      externalTelegramRequestsCount: 0,
      externalTradingViewRequestsCount: 0,
      scanCycleId: smcSnapshot.scanCycleId,
      cycleId: smcSnapshot.cycleId,
      cycleStatus: smcSnapshot.cycleStatus,
      fullUniverseStatus: smcSnapshot.fullUniverseStatus,
      cycleStartedAt: smcSnapshot.cycleStartedAt,
      cycleCompletedAt: smcSnapshot.cycleCompletedAt,
      lastCompletedCycleId: smcSnapshot.lastCompletedCycleId,
      lastCompletedCycleDuration: smcSnapshot.lastCompletedCycleDuration,
      statsConsistency: smcSnapshot.statsConsistency,
      totalSymbols: smcSnapshot.totalSymbols,
      queuedCount: smcSnapshot.queuedCount,
      runningJobCount: smcSnapshot.runningJobCount,
      totalExpectedHttpRequests: smcSnapshot.totalExpectedHttpRequests,
      completedHttpRequests: smcSnapshot.completedHttpRequests,
      remainingHttpRequests: smcSnapshot.remainingHttpRequests,
      httpRequestsPerSymbol: smcSnapshot.httpRequestsPerSymbol,
      httpEndpointsBreakdown: smcSnapshot.httpEndpointsBreakdown,
      maxHttpConcurrency: smcSnapshot.maxHttpConcurrency,
      maxRequestsPerMinute: smcSnapshot.maxRequestsPerMinute,
      currentRequestsInWindow: smcSnapshot.currentRequestsInWindow,
      rateLimitCount: smcSnapshot.rateLimitCount,
      estimatedRemainingDuration: smcSnapshot.estimatedRemainingDuration,
      estimateStatus: smcSnapshot.estimateStatus,
      lastFullRadarScanAt: smcSnapshot.lastFullRadarScanAt,
      lastPriorityScanAt: smcSnapshot.lastPriorityScanAt,
      radarScanDurationMs: smcSnapshot.radarScanDurationMs,
      prewarmDurationMs: smcSnapshot.prewarmDurationMs,
      prewarmCacheHitRate: smcSnapshot.prewarmCacheHitRate,
      prioritySmcDurationMs: smcSnapshot.prioritySmcDurationMs,
      fullCycleDurationMs: smcSnapshot.fullCycleDurationMs,
      fullUniverseCompletionDurationMs:
        smcSnapshot.fullUniverseCompletionDurationMs,
      coldStartFullUniverseCompletionDuration:
        smcSnapshot.coldStartFullUniverseCompletionDuration,
      warmCacheFullUniverseCompletionDuration:
        smcSnapshot.warmCacheFullUniverseCompletionDuration,
      queueWaitMs: smcSnapshot.queueWaitMs,
      prewarmWaitMs: smcSnapshot.prewarmWaitMs,
      httpRequestLatencyMs: smcSnapshot.httpRequestLatencyMs,
      smcCalculationLatencyMs: smcSnapshot.smcCalculationLatencyMs,
      dbWriteLatencyMs: smcSnapshot.dbWriteLatencyMs,
      smcEvaluationLatencyMs: smcSnapshot.smcEvaluationLatencyMs,
      rateLimitWaitMs: smcSnapshot.rateLimitWaitMs,
      detectionLatencyMs: smcSnapshot.detectionLatencyMs,
      p50DetectionLatencyMs: smcSnapshot.p50DetectionLatencyMs,
      p90DetectionLatencyMs: smcSnapshot.p90DetectionLatencyMs,
      p95DetectionLatencyMs: smcSnapshot.p95DetectionLatencyMs,
      p99DetectionLatencyMs: smcSnapshot.p99DetectionLatencyMs,
      maxDetectionLatencyMs: smcSnapshot.maxDetectionLatencyMs,
      p50PriorityDetectionLatencyMs: smcSnapshot.p50PriorityDetectionLatencyMs,
      p90PriorityDetectionLatencyMs: smcSnapshot.p90PriorityDetectionLatencyMs,
      p95PriorityDetectionLatencyMs: smcSnapshot.p95PriorityDetectionLatencyMs,
      p99PriorityDetectionLatencyMs: smcSnapshot.p99PriorityDetectionLatencyMs,
      p95BulkQueueWaitMs: smcSnapshot.p95BulkQueueWaitMs,
      cacheHitRate: smcSnapshot.cacheHitRate,
      cacheMissRate: smcSnapshot.cacheMissRate,
      priorityDetectionLatency: smcSnapshot.priorityDetectionLatency,
      bulkUniverseQueueLatency: smcSnapshot.bulkUniverseQueueLatency,
      bulkQueueWait: smcSnapshot.bulkQueueWait,
      fullUniverseCompletionLatency: smcSnapshot.fullUniverseCompletionLatency,
      coldStartPriorityDetectionLatency:
        smcSnapshot.coldStartPriorityDetectionLatency,
      warmCachePriorityDetectionLatency:
        smcSnapshot.warmCachePriorityDetectionLatency,
      coldStartPrioritySLA: smcSnapshot.coldStartPrioritySLA,
      warmCachePrioritySLA: smcSnapshot.warmCachePrioritySLA,
      priorityDetectionSLA: smcSnapshot.priorityDetectionSLA,
      fullUniverseCompletionDuration:
        smcSnapshot.fullUniverseCompletionDuration,
      coldStartFullUniverseDuration:
        smcSnapshot.coldStartFullUniverseDuration,
      warmFullUniverseDuration: smcSnapshot.warmFullUniverseDuration,
      coldStartFullUniverseSLA: smcSnapshot.coldStartFullUniverseSLA,
      coldStartP50: smcSnapshot.coldStartP50,
      coldStartP95: smcSnapshot.coldStartP95,
      warmCacheP50: smcSnapshot.warmCacheP50,
      warmCacheP95: smcSnapshot.warmCacheP95,
      priorityExecutionBreakdown: smcSnapshot.priorityExecutionBreakdown,
      latencyBreakdown: smcSnapshot.latencyBreakdown,
      slowestSymbolsTop20: smcSnapshot.slowestSymbolsTop20,
      cacheHitCount: smcSnapshot.cacheHitCount,
      cacheMissCount: smcSnapshot.cacheMissCount,
      cacheCoverage: smcSnapshot.cacheCoverage,
      cacheCoverageRate: smcSnapshot.cacheCoverageRate,
      freshCacheCount: smcSnapshot.freshCacheCount,
      expiredCacheCount: smcSnapshot.expiredCacheCount,
      staleCacheCount: smcSnapshot.staleCacheCount,
      prewarmRequiredCount: smcSnapshot.prewarmRequiredCount,
      '5mCoverage': smcSnapshot['5mCoverage'],
      '15mCoverage': smcSnapshot['15mCoverage'],
      '1hCoverage': smcSnapshot['1hCoverage'],
      '4hCoverage': smcSnapshot['4hCoverage'],
      '5mCacheCoverage': smcSnapshot['5mCacheCoverage'],
      '15mCacheCoverage': smcSnapshot['15mCacheCoverage'],
      '1hCacheCoverage': smcSnapshot['1hCacheCoverage'],
      '4hCacheCoverage': smcSnapshot['4hCacheCoverage'],
      oiCacheCoverage: smcSnapshot.oiCacheCoverage,
      fundingCacheCoverage: smcSnapshot.fundingCacheCoverage,
      cacheStatus: smcSnapshot.cacheStatus,
      cacheStatusLabel: smcSnapshot.cacheStatusLabel,
      cacheMode: smcSnapshot.cacheMode,
      cacheModeLabel: smcSnapshot.cacheModeLabel,
      latestPrewarmSnapshot: smcSnapshot.latestPrewarmSnapshot,
      prewarmTasks: smcSnapshot.prewarmTasks,
      candidateDetectedBeforeEntryWindowCount: Math.max(
        smcSnapshot.candidateDetectedBeforeEntryWindowCount,
        tradableSignals.filter(
          (s) => s.entryWindowStatus === 'DETECTED_BEFORE_NEXT_BAR_OPEN'
        ).length
      ),
      entryWindowMissedCount: Math.max(
        entryWindowMissed,
        smcSnapshot.entryWindowMissedCount
      ),
      priorityRefreshCount: smcSnapshot.priorityRefreshCount,
      candidateStatus,
      windowFinalSnapshot,
      currentLiveCycleSnapshot,
      latestScanSnapshot,
      cycles,
      candidateTimeline,
      signalDecisionTraces,
      paperOutcomeTimeline,
      dataQualityTimeline,
      ...(() => {
        const cycleDiag = this.radarDb.computeCycleDiagnosticsAndFunnel(
          this.activeExchange
        );
        return {
          aggregationScope: cycleDiag.aggregationScope,
          evaluationUniverseSize: cycleDiag.evaluationUniverseSize,
          evaluatedDenominator: cycleDiag.evaluatedDenominator,
          excludedCount: cycleDiag.excludedCount,
          excludedSymbols: cycleDiag.excludedSymbols,
          excludedReasons: cycleDiag.excludedReasons,
          consistencyErrors: cycleDiag.consistencyErrors,
          candidateFunnel: cycleDiag.candidateFunnel,
          currentCycleFunnel: cycleDiag.currentCycleFunnel,
          latestSnapshotFunnel: cycleDiag.latestSnapshotFunnel,
          monitoringWindowFunnel: cycleDiag.monitoringWindowFunnel,
          cumulativeFunnel: cycleDiag.cumulativeFunnel,
          historicalSignalsOutsideCurrentCycle:
            cycleDiag.historicalSignalsOutsideCurrentCycle,
          historicalSignalsOutsideWindow:
            cycleDiag.historicalSignalsOutsideWindow,
          formalCandidateLatencySla: cycleDiag.formalCandidateLatencySla,
          smcGateDiagnostics: cycleDiag.smcGateDiagnostics,
          paperEligibilityAudit: cycleDiag.paperEligibilityAudit,
          scopedGateStatistics: cycleDiag.scopedGateStatistics,
          observationShadowComparison: cycleDiag.observationShadowComparison,
          nearMissCount: cycleDiag.nearMissCount,
          nearMissMissing1Count: cycleDiag.nearMissMissing1Count,
          nearMissMissing2Count: cycleDiag.nearMissMissing2Count,
          nearMissMissingGates: cycleDiag.nearMissMissingGates,
          lastBlockingGate: cycleDiag.lastBlockingGate,
          blockedAfterSmcCandidateCount:
            cycleDiag.blockedAfterSmcCandidateCount,
          blockedAfterSmcCandidateReasons:
            cycleDiag.blockedAfterSmcCandidateReasons,
          blockedByPaperEligibilityCount:
            cycleDiag.blockedByPaperEligibilityCount,
          blockedByPaperEligibilityReasons:
            cycleDiag.blockedByPaperEligibilityReasons,
          formalCandidateCount: cycleDiag.formalCandidateCount,
          fastLaneFormalCandidateCount: cycleDiag.fastLaneFormalCandidateCount,
          bulkFormalCandidateCount: cycleDiag.bulkFormalCandidateCount,
          entryWindowMissedRate: cycleDiag.entryWindowMissedRate,
          candidateDetectionLatencyP50: cycleDiag.candidateDetectionLatencyP50,
          candidateDetectionLatencyP95: cycleDiag.candidateDetectionLatencyP95,
          queueWaitP50: cycleDiag.queueWaitP50,
          queueWaitP95: cycleDiag.queueWaitP95,
          candidateDetectedCount: cycleDiag.candidateDetectedCount,
          eligiblePaperSignalCount: cycleDiag.eligiblePaperSignalCount,
          paperEligibleCount: cycleDiag.eligiblePaperSignalCount,
          currentCyclePaperEligibleCount:
            cycleDiag.currentCyclePaperEligibleCount,
          monitoringWindowPaperEligibleCount:
            cycleDiag.monitoringWindowPaperEligibleCount,
          cumulativePaperEligibleCount: cycleDiag.cumulativePaperEligibleCount,
          historicalPaperEligibleCount: cycleDiag.historicalPaperEligibleCount,
          currentCycleEntryWindowMissedCount:
            cycleDiag.currentCycleEntryWindowMissedCount,
          monitoringWindowEntryWindowMissedCount:
            cycleDiag.monitoringWindowEntryWindowMissedCount,
          cumulativeEntryWindowMissedCount:
            cycleDiag.cumulativeEntryWindowMissedCount,
          historicalSignalsOutsideWindowCount:
            cycleDiag.historicalSignalsOutsideWindowCount,
          historicalSignalsOutsideCurrentCycleCount:
            cycleDiag.historicalSignalsOutsideCurrentCycleCount,
          rootCauseVerdict: cycleDiag.rootCauseVerdict,
          rootCauseExplanation: cycleDiag.rootCauseExplanation,
        };
      })(),
    };
  }

  public getHealth(): PaperMonitorHealthResponse {
    const statsVer = this.checkStatsVersionMonotonicity();
    const smcSnapshot = this.radarDb.getAtomicSmcSnapshot(this.activeExchange);
    const outboxList = this.paperMonitorDb.listNotificationOutbox({
      exchange: this.activeExchange,
      limit: 500,
    });

    const resultsList = Array.from(smcSnapshot.resultsMap.values());
    const staleResultCount = resultsList.filter((r) => r.stale).length;
    const missingOiFundingCount = resultsList.filter((r) =>
      (r.missingData || []).some(
        (m) => m === 'openInterest' || m === 'fundingRate'
      )
    ).length;

    const rateLimitCount =
      this.rateLimitCount + smcSnapshot.rateLimitedCount;
    const failedJobCount = smcSnapshot.failedCount;
    const pendingSmcCount = smcSnapshot.pendingCount;
    const notificationBlockedCount = outboxList.filter(
      (o) =>
        o.status === 'NON_CANDIDATE_BLOCKED' ||
        o.status === 'DEDUPED_BLOCKED' ||
        o.status === 'COOLDOWN_BLOCKED' ||
        o.status === 'STALE_BLOCKED' ||
        o.status === 'FALLBACK_BLOCKED' ||
        o.status === 'MISSING_DATA_BLOCKED'
    ).length;

    // Check queue vs result consistency
    const expectedTotal =
      smcSnapshot.succeededCount +
      smcSnapshot.pendingCount +
      smcSnapshot.failedCount;
    const queueResultConsistentVerified =
      expectedTotal === smcSnapshot.totalJobs;

    const heartbeatAgeMs =
      Date.now() - (Date.parse(this.lastHeartbeatAt) || Date.now());
    const workerHeartbeatHealthy =
      this.workerState === 'PAUSED' ||
      this.workerState === 'STOPPED' ||
      heartbeatAgeMs <= Math.max(this.intervalMs * 3, 180_000);

    const warnings: string[] = [];

    if (this.workerState === 'ERROR' || this.lastError) {
      warnings.push(
        `交易所 API 失敗隔離警告：${this.lastError || '上游即時資料連線異常'}（系統已攔截並維持 Live 錯誤狀態，絕不自動切換為 Demo 資料）`
      );
    }
    if (rateLimitCount > 0) {
      warnings.push(
        `交易所 HTTP 429 頻率限制警告：累計偵測到 ${rateLimitCount} 次 Rate Limit，已啟動指數退避重試`
      );
    }
    if (missingOiFundingCount > 0) {
      warnings.push(
        `歷史或即時 OI／Funding 資料缺失警告：共 ${missingOiFundingCount} 檔合約缺少 OI 或 Funding 資料，已禁止產生交易候選訊號`
      );
    }
    if (staleResultCount > 0) {
      warnings.push(
        `SMC 結果過期警告：共 ${staleResultCount} 檔合約之 SMC 評估結果已超過新鮮度時效 (stale=true)`
      );
    }
    if (!workerHeartbeatHealthy) {
      warnings.push(
        `Worker Heartbeat 中斷警告：最後心跳時間為 ${this.lastHeartbeatAt}`
      );
    }
    if (!queueResultConsistentVerified) {
      warnings.push(
        `SQLite Queue 與 Result 數量不一致警告：succeeded(${smcSnapshot.succeededCount}) + pending(${smcSnapshot.pendingCount}) + failed(${smcSnapshot.failedCount}) != totalJobs(${smcSnapshot.totalJobs})`
      );
    }
    if (this.statsVersionRegressed) {
      warnings.push(
        `statsVersion 倒退警告：偵測到版本號異常倒退，請檢查資料庫實例 (${this.radarDb.databaseInstanceId})`
      );
    }
    if (this.finalCategorySmcMismatchCount > 0) {
      warnings.push(
        `雙層分類不一致警告：finalCategorySmcMismatchCount = ${this.finalCategorySmcMismatchCount} (> 0)`
      );
    }

    const exchangeApiHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' =
      this.workerState === 'ERROR'
        ? 'CRITICAL'
        : rateLimitCount > 3 || this.exchangeErrorCount > 0
          ? 'DEGRADED'
          : 'HEALTHY';

    const queueHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' =
      !queueResultConsistentVerified || failedJobCount > 10
        ? 'CRITICAL'
        : failedJobCount > 0 || rateLimitCount > 0
          ? 'DEGRADED'
          : 'HEALTHY';

    const scannerHealth: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' =
      this.statsVersionRegressed ||
      this.finalCategorySmcMismatchCount > 0 ||
      !workerHeartbeatHealthy
        ? 'CRITICAL'
        : staleResultCount > 0 || missingOiFundingCount > 0
          ? 'DEGRADED'
          : 'HEALTHY';

    return {
      databaseInstanceId: this.radarDb.databaseInstanceId,
      monitorRunId: this.monitorRunId,
      scanRunId: this.scanRunId,
      snapshotAt: new Date().toISOString(),
      statsVersion: statsVer,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      safety: TRADING_SAFETY_FLAGS,
      scannerHealth,
      queueHealth,
      exchangeApiHealth,
      rateLimitCount,
      failedJobCount,
      staleResultCount,
      missingOiFundingCount,
      pendingSmcCount,
      notificationBlockedCount,
      finalCategorySmcMismatchCount: this.finalCategorySmcMismatchCount,
      statsVersionMonotonicVerified: !this.statsVersionRegressed,
      queueResultConsistentVerified,
      workerHeartbeatHealthy,
      externalTelegramRequestsCount: 0,
      externalTradingViewRequestsCount: 0,
      warnings,
    };
  }

  // ============================================================================
  // Phase 11: SMC Candidate Scarcity Reason Analysis, Gate Pass Rate & Long-Term Paper Quality Monitoring
  // ============================================================================

  private mapPaperSignalToQualityRecord(
    s: PaperTrackedSignalRecord,
    scanCycleCompletedAtFallback: string | null = null
  ): SmcPaperQualitySignalRecord {
    const isOpened =
      s.status === 'PAPER_OPENED' ||
      s.status === 'PAPER_CLOSED_WIN' ||
      s.status === 'PAPER_CLOSED_LOSS' ||
      s.status === 'PAPER_EXPIRED';
    const isClosed =
      s.status === 'PAPER_CLOSED_WIN' ||
      s.status === 'PAPER_CLOSED_LOSS' ||
      s.status === 'PAPER_EXPIRED';
    const detectedIso = s.signalDetectedAt || s.evaluatedAt;

    return {
      signalId: s.signalId,
      symbol: s.symbol,
      exchange: s.exchange,
      timeframe: s.timeframe,
      direction: s.direction,
      detectedAt: detectedIso,
      signalDetectedAt: detectedIso,
      scanCycleId: s.scanCycleId ?? null,
      scanCycleCompletedAt: s.snapshotAt || scanCycleCompletedAtFallback,
      signalBarOpenTime: s.signalBarOpenTime,
      signalBarCloseTime: s.signalBarCloseTime,
      entryWindowOpenTime: s.originalEntryWindowOpenTime,
      entryWindowCloseTime: s.originalEntryWindowCloseTime,
      detectionLatencyMs: s.detectionLatencyMs ?? s.signalLatencyMs ?? 0,
      entryStatus: s.entryStatus ?? s.status,
      entryWindowMissedReason:
        s.status === 'ENTRY_WINDOW_MISSED' ||
        s.entryStatus === 'ENTRY_WINDOW_MISSED'
          ? s.statusReason ||
            '偵測時間晚於下一根 K 線開盤時間窗 (ENTRY_WINDOW_MISSED)，Live Paper 嚴禁事後補單或回填歷史開盤價'
          : null,
      entryReferencePrice: s.entryReferencePrice,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      paperOpenedAt: isOpened ? s.entryReferenceTime : null,
      paperClosedAt: isClosed ? s.exitTime : null,
      closeReason: (s.closeReason ??
        (s.status === 'PAPER_CLOSED_LOSS'
          ? 'STOP_LOSS'
          : s.status === 'PAPER_CLOSED_WIN'
            ? 'TAKE_PROFIT'
            : s.status === 'PAPER_EXPIRED'
              ? 'EXPIRED'
              : s.status === 'INVALIDATED'
                ? 'INVALIDATED'
                : null)) as PaperSignalCloseReason,
      exitPrice: s.exitPrice,
      resultR: isClosed ? s.riskMultiple : null,
      status: s.status,
      marketRadarCategory: s.marketRadarCategory,
      ruleVersion: s.ruleVersion,
      smcEvaluationStatus: s.smcEvaluationStatus,
      smcActionState: s.smcActionState,
      finalTradeSignal: s.finalTradeSignal,
      stale: s.stale,
      fallback: s.fallback,
      isDemo: s.isDemo,
      missingData: s.missingData ?? [],
      waitReasons: s.waitReasons ?? [],
      source: s.source,
    };
  }

  public static computeSampleSufficiency(
    sampleCount: number
  ): SampleSufficiencyTier {
    if (sampleCount < 30) return 'INSUFFICIENT';
    if (sampleCount < 100) return 'LIMITED';
    return 'SUFFICIENT';
  }

  public setStatisticalIdentityTestOverride(
    override: Partial<{
      totalSymbols: number;
      evaluatedCount: number;
      latencyEvaluatedCount: number;
      regimeTotalSymbols: number;
      evaluationUniverseSize: number;
    }> | null
  ): void {
    this.statisticalIdentityTestOverride = override;
  }

  private resolveQualityWindowBounds(options?: {
    window?: PaperMonitorReportWindow;
    reportAnchorAt?: string;
    nowMs?: number;
    exchange?: ExchangeId;
    lockAnchorToStatsVersion?: boolean;
  }): {
    window: PaperMonitorReportWindow;
    generatedAtMs: number;
    anchorMs: number;
    windowStartMs: number;
    windowEndMs: number;
    reportGeneratedAt: string;
    reportAnchorAt: string;
    windowStartAt: string;
    windowEndAt: string;
  } {
    const window: PaperMonitorReportWindow = options?.window ?? '7d';
    const generatedAtMs = options?.nowMs ?? Date.now();
    const ex = options?.exchange ?? this.activeExchange;

    let anchorMs: number;
    if (
      options?.reportAnchorAt &&
      Number.isFinite(Date.parse(options.reportAnchorAt))
    ) {
      anchorMs = Date.parse(options.reportAnchorAt);
    } else if (options?.lockAnchorToStatsVersion) {
      const currentStatsVersion = this.radarDb.getSmcStatsVersion(ex);
      const existingLock = this.lockedAnchorByExchange.get(ex);
      if (
        existingLock &&
        existingLock.statsVersion === currentStatsVersion &&
        Math.abs(generatedAtMs - existingLock.anchorMs) <= 60_000
      ) {
        anchorMs = existingLock.anchorMs;
      } else {
        anchorMs = generatedAtMs;
        this.lockedAnchorByExchange.set(ex, {
          statsVersion: currentStatsVersion,
          anchorMs,
          lockedAtMs: generatedAtMs,
        });
      }
    } else {
      anchorMs = generatedAtMs;
    }

    const windowDurationMs =
      window === '90d'
        ? 90 * 24 * 60 * 60 * 1000
        : window === '60d'
          ? 60 * 24 * 60 * 60 * 1000
          : window === '30d'
            ? 30 * 24 * 60 * 60 * 1000
            : window === '24h'
              ? 24 * 60 * 60 * 1000
              : 7 * 24 * 60 * 60 * 1000;
    const windowEndMs = anchorMs;
    const windowStartMs = windowEndMs - windowDurationMs;
    const reportGeneratedAt = new Date(generatedAtMs).toISOString();
    const windowEndAt = new Date(windowEndMs).toISOString();
    const reportAnchorAt = options?.reportAnchorAt
      ? new Date(anchorMs).toISOString()
      : windowEndAt;
    const windowStartAt = new Date(windowStartMs).toISOString();
    return {
      window,
      generatedAtMs,
      anchorMs,
      windowStartMs,
      windowEndMs,
      reportGeneratedAt,
      reportAnchorAt,
      windowStartAt,
      windowEndAt,
    };
  }

  private buildQualitySharedEnvelope(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>,
    params: {
      entryWindowMissedCount: number;
      reportGeneratedAt: string;
      reportAnchorAt: string;
      windowStartAt: string;
      windowEndAt: string;
      signalDetectedAt: string | null;
      scanCycleCompletedAt: string | null;
    }
  ): SmcQualitySharedEnvelope {
    const { snap } = bundle;
    const sampleSource =
      snap.results.find((r) => !r.isDemo)?.source ||
      'Binance USDⓈ-M Futures Public REST API (fapi.binance.com)';
    return {
      safety: TRADING_SAFETY_FLAGS,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      databaseInstanceId: this.radarDb.databaseInstanceId,
      exchange: snap.results[0]?.exchange ?? this.activeExchange,
      ruleVersion: SMC_RULE_VERSION,
      snapshotAt: snap.snapshotAt,
      reportGeneratedAt: params.reportGeneratedAt,
      reportAnchorAt: params.reportAnchorAt,
      windowStartAt: params.windowStartAt,
      windowEndAt: params.windowEndAt,
      signalDetectedAt: params.signalDetectedAt,
      scanCycleCompletedAt:
        params.scanCycleCompletedAt ?? snap.cycleCompletedAt,
      statsVersion: snap.statsVersion,
      scanRunId: snap.scanRunId,
      scanCycleId: snap.scanCycleId,
      cycleId: snap.cycleId,
      cycleStatus: snap.cycleStatus,
      fullUniverseStatus: snap.fullUniverseStatus,
      cycleStartedAt: snap.cycleStartedAt,
      cycleCompletedAt: snap.cycleCompletedAt,
      fullUniverseCompletionDuration: snap.fullUniverseCompletionDuration,
      coldStartFullUniverseSLA: snap.coldStartFullUniverseSLA,
      statsConsistency: snap.statsConsistency,
      cacheMode: snap.cacheMode,
      totalSymbols: snap.totalSymbols,
      totalEvaluated: snap.evaluatedCount,
      evaluatedCount: snap.evaluatedCount,
      pendingCount: snap.pendingCount,
      failedCount: snap.failedCount,
      rateLimitedCount: snap.rateLimitedCount,
      waitCount: snap.waitCount,
      watchCount: snap.watchCount,
      highRiskCount: snap.highRiskCount,
      longCandidateCount: snap.longCandidateCount,
      shortCandidateCount: snap.shortCandidateCount,
      gateNotConfirmedCount: bundle.gateNotConfirmedCount,
      finalCategorySmcMismatchCount: bundle.finalCategorySmcMismatchCount,
      entryWindowMissedCount: params.entryWindowMissedCount,
      externalTelegramRequestsCount: 0,
      externalTradingViewRequestsCount: 0,
      zeroCandidateNotice:
        '候選數為 0 不代表掃描失敗；候選數為 0 代表目前沒有標的通過完整 Gate。',
      provenance: {
        source: sampleSource,
        fetchedAt: snap.snapshotAt,
        stale: snap.staleCount > 0,
        fallback: false,
        missingData: [],
        isDemo: false,
      },
    };
  }

  public getSmcQualityGateStats(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: { window?: PaperMonitorReportWindow; reportAnchorAt?: string }
  ): SmcQualityGateStatsResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live SMC 品質與 Gate 統計嚴禁混入 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window: options?.window ?? '7d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );
    // Section 四: /api/smc-quality/gate-stats 只統計當輪掃描結果，不把歷史 paper_tracked_signals 混入當輪 entryWindowMissedCount
    const currentCycleSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        scanCycleId: bundle.snap.scanCycleId,
        includeBlocked: false,
        limit: 500,
      })
      .filter((s) => !s.isDemo);
    const currentCycleMissedCount = Math.max(
      bundle.snap.entryWindowMissedCount,
      currentCycleSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length
    );
    const latestCurrentSignalDetectedAt =
      currentCycleSignals.length > 0
        ? currentCycleSignals[0].signalDetectedAt ||
          currentCycleSignals[0].evaluatedAt
        : null;

    const envelope = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: currentCycleMissedCount,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: latestCurrentSignalDetectedAt,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
    });

    return {
      ...envelope,
      cycleCount: bundle.cycles.length,
      gates: bundle.gates,
      gateSummaryMap: bundle.gateSummaryMap,
      gatePassRates: bundle.gatePassRates,
      gateFailureRates: bundle.gateFailureRates,
      topFailedGates: bundle.topFailedGates,
      symbolDiagnostics: bundle.symbolDiagnostics,
    };
  }

  public getSmcQualityReasonStats(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: { window?: PaperMonitorReportWindow; reportAnchorAt?: string }
  ): SmcQualityReasonStatsResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live SMC 品質與原因統計嚴禁混入 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window: options?.window ?? '7d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );
    // Section 四: /api/smc-quality/reason-stats 只統計當輪掃描結果，不把歷史 paper_tracked_signals 混入當輪 entryWindowMissedCount
    const currentCycleSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        scanCycleId: bundle.snap.scanCycleId,
        includeBlocked: false,
        limit: 500,
      })
      .filter((s) => !s.isDemo);
    const currentCycleMissedSignals = currentCycleSignals.filter(
      (s) =>
        s.status === 'ENTRY_WINDOW_MISSED' ||
        s.entryStatus === 'ENTRY_WINDOW_MISSED'
    );
    const currentCycleMissedCount = Math.max(
      bundle.snap.entryWindowMissedCount,
      currentCycleMissedSignals.length
    );
    const latestCurrentSignalDetectedAt =
      currentCycleSignals.length > 0
        ? currentCycleSignals[0].signalDetectedAt ||
          currentCycleSignals[0].evaluatedAt
        : null;

    const primaryCategoryCounts = {
      ...bundle.primaryCategoryCounts,
      ENTRY_WINDOW_MISSED: Math.max(
        bundle.primaryCategoryCounts.ENTRY_WINDOW_MISSED,
        currentCycleMissedCount
      ),
    };
    const categoryOccurrenceCounts = {
      ...bundle.categoryOccurrenceCounts,
      ENTRY_WINDOW_MISSED: Math.max(
        bundle.categoryOccurrenceCounts.ENTRY_WINDOW_MISSED,
        currentCycleMissedCount
      ),
    };
    const reasonCategories = {
      ...bundle.reasonCategories,
      ENTRY_WINDOW_MISSED: {
        ...bundle.reasonCategories.ENTRY_WINDOW_MISSED,
        primarySymbolCount: primaryCategoryCounts.ENTRY_WINDOW_MISSED,
        uniqueSymbolCount: Math.max(
          bundle.reasonCategories.ENTRY_WINDOW_MISSED.uniqueSymbolCount,
          new Set(currentCycleMissedSignals.map((s) => s.symbol)).size
        ),
        totalReasonOccurrences: categoryOccurrenceCounts.ENTRY_WINDOW_MISSED,
      },
    };
    const reasonCategoryList = bundle.reasonCategoryList.map((c) =>
      c.category === 'ENTRY_WINDOW_MISSED'
        ? reasonCategories.ENTRY_WINDOW_MISSED
        : c
    );

    const envelope = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: currentCycleMissedCount,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: latestCurrentSignalDetectedAt,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
    });

    return {
      ...envelope,
      cycleCount: bundle.cycles.length,
      uniqueSymbolCount: bundle.uniqueSymbolCount,
      totalReasonOccurrences: bundle.totalReasonOccurrences,
      primaryCategoryCounts,
      categoryOccurrenceCounts,
      reasonCategories,
      reasonCategoryList,
      waitReasonRanking: bundle.waitReasonRanking,
      waitReasonCounts: bundle.waitReasonCounts,
      watchReasonCounts: bundle.watchReasonCounts,
      highRiskReasonCounts: bundle.highRiskReasonCounts,
      directionDistribution: bundle.directionDistribution,
      symbolReasons: bundle.symbolDiagnostics,
    };
  }

  public getSmcQualityCycleHistory(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: { window?: PaperMonitorReportWindow; reportAnchorAt?: string }
  ): SmcQualityCycleHistoryResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live SMC 週期歷史嚴禁混入 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window: options?.window ?? '7d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );
    const currentCycleSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        scanCycleId: bundle.snap.scanCycleId,
        includeBlocked: false,
        limit: 500,
      })
      .filter((s) => !s.isDemo);
    const currentCycleMissedCount = Math.max(
      bundle.snap.entryWindowMissedCount,
      currentCycleSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length
    );

    const envelope = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: currentCycleMissedCount,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt:
        currentCycleSignals.length > 0
          ? currentCycleSignals[0].signalDetectedAt ||
            currentCycleSignals[0].evaluatedAt
          : null,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
    });

    const mapCycleWithCompletedAt = (c: SmcCycleQualityHistoryItem) => ({
      ...c,
      scanCycleCompletedAt: c.cycleCompletedAt,
    });

    return {
      ...envelope,
      cycleCount: bundle.cycles.length,
      totalScans: bundle.cycles.length,
      recentThreeCompletedCycles: bundle.recentThreeCompletedCycles.map(
        mapCycleWithCompletedAt
      ),
      cycles: bundle.cycles.map(mapCycleWithCompletedAt),
    };
  }

  public getSmcQualitySignalLatency(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: { window?: PaperMonitorReportWindow; reportAnchorAt?: string }
  ): SmcQualitySignalLatencyResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live SMC 訊號延遲統計嚴禁混入 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window: options?.window ?? '7d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const allLiveSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        includeBlocked: false,
        limit: 2000,
      })
      .filter(
        (s) =>
          !s.isDemo &&
          !s.stale &&
          !s.fallback &&
          s.smcEvaluationStatus === 'EVALUATED' &&
          (s.smcActionState === 'LONG CANDIDATE' ||
            s.smcActionState === 'SHORT CANDIDATE') &&
          s.finalTradeSignal !== 'NONE' &&
          (s.missingData?.length ?? 0) === 0 &&
          (s.waitReasons?.length ?? 0) === 0
      );

    // Strictly separate in-window signals [windowStartAt, windowEndAt) vs historical signals outside window
    const inWindowRaw: PaperTrackedSignalRecord[] = [];
    const outsideWindowRaw: PaperTrackedSignalRecord[] = [];
    for (const s of allLiveSignals) {
      const eventMs = Date.parse(s.signalDetectedAt || s.evaluatedAt);
      if (
        Number.isFinite(eventMs) &&
        bounds.windowStartMs <= eventMs &&
        eventMs < bounds.windowEndMs
      ) {
        inWindowRaw.push(s);
      } else {
        outsideWindowRaw.push(s);
      }
    }

    const candidateAppearances = inWindowRaw.map((s) =>
      this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
    );
    const historicalSignalsOutsideWindow = outsideWindowRaw.map((s) =>
      this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
    );

    const missedCountInWindow = candidateAppearances.filter(
      (s) =>
        s.status === 'ENTRY_WINDOW_MISSED' ||
        s.entryStatus === 'ENTRY_WINDOW_MISSED'
    ).length;

    const currentCycleCompletedMs = Date.parse(
      bundle.snap.cycleCompletedAt || bundle.snap.snapshotAt
    );
    const isCurrentCycleInWindow =
      Number.isFinite(currentCycleCompletedMs) &&
      bounds.windowStartMs <= currentCycleCompletedMs &&
      currentCycleCompletedMs < bounds.windowEndMs;

    const detectedOnTimeCount = Math.max(
      isCurrentCycleInWindow
        ? bundle.snap.candidateDetectedBeforeEntryWindowCount
        : 0,
      candidateAppearances.filter(
        (s) =>
          s.status !== 'ENTRY_WINDOW_MISSED' &&
          s.entryStatus !== 'ENTRY_WINDOW_MISSED'
      ).length
    );

    const signalLatencies = candidateAppearances
      .map((s) => s.detectionLatencyMs)
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);

    const calcPct = (arr: number[], q: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(
        arr.length - 1,
        Math.max(0, Math.ceil((q / 100) * arr.length) - 1)
      );
      return arr[idx];
    };

    const sampleCount = signalLatencies.length;
    const sampleSufficiency: SampleSufficiencyTier =
      PaperShadowMonitor.computeSampleSufficiency(sampleCount);
    const sampleSufficiencyNotice =
      sampleSufficiency !== 'SUFFICIENT'
        ? '樣本不足，僅供觀察'
        : '樣本充足 (n >= 100)，可供統計觀察';
    const latencyStatisticType:
      | 'NO_IN_WINDOW_SAMPLES'
      | 'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
      | 'SMALL_SAMPLE_DESCRIPTIVE_ONLY'
      | 'STABLE_PERCENTILE' =
      sampleCount === 0
        ? 'NO_IN_WINDOW_SAMPLES'
        : sampleCount === 1
          ? 'SINGLE_SAMPLE_DESCRIPTIVE_ONLY'
          : sampleCount < 30
            ? 'SMALL_SAMPLE_DESCRIPTIVE_ONLY'
            : 'STABLE_PERCENTILE';

    const signalLatency: SmcLatencyPercentiles =
      sampleCount > 0
        ? {
            sampleCount,
            p50: calcPct(signalLatencies, 50),
            p90: calcPct(signalLatencies, 90),
            p95: calcPct(signalLatencies, 95),
            p99: calcPct(signalLatencies, 99),
            max: signalLatencies[signalLatencies.length - 1],
            min: signalLatencies[0],
            avg: Math.round(
              signalLatencies.reduce((a, b) => a + b, 0) / sampleCount
            ),
          }
        : {
            sampleCount: 0,
            p50: null,
            p90: null,
            p95: null,
            p99: null,
            max: null,
            min: null,
            avg: null,
          };

    const latestInWindowSignalDetectedAt =
      candidateAppearances.length > 0
        ? candidateAppearances[0].signalDetectedAt
        : null;

    const envelope = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: missedCountInWindow,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: latestInWindowSignalDetectedAt,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
    });

    return {
      ...envelope,
      window: bounds.window,
      cycleCount: bundle.cycles.length,
      sampleCount,
      sampleSufficiency,
      sampleSufficiencyNotice,
      latencyStatisticType,
      signalLatency,
      priorityDetectionLatency: bundle.snap.priorityDetectionLatency,
      fullUniverseDetectionLatency: bundle.snap.fullUniverseCompletionLatency,
      signalLatencyP50: signalLatency.p50 ?? null,
      signalLatencyP95: signalLatency.p95 ?? null,
      signalLatencyAvg: signalLatency.avg ?? null,
      candidateDetectedBeforeEntryWindowCount: detectedOnTimeCount,
      candidateAppearances,
      historicalSignalsOutsideWindowCount:
        historicalSignalsOutsideWindow.length,
      historicalSignalsOutsideWindow,
    };
  }

  public getSmcQualityWindowReport(
    window: PaperMonitorReportWindow = '7d',
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string
  ): SmcQualityWindowReportResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Live SMC 7d/30d 品質報告嚴禁混入 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window,
      reportAnchorAt,
      nowMs,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const baseOutcomeReport = this.outcomeTracker.buildWindowReport({
      window,
      exchange,
      monitorRunId: this.monitorRunId,
      scanRunId: bundle.snap.scanRunId,
      sinceIso: bounds.windowStartAt,
      untilIso: bounds.windowEndAt,
      reportAnchorAt: bounds.reportAnchorAt,
      nowMs: bounds.generatedAtMs,
    });

    // Query all non-demo signals so we can strictly partition [windowStartAt, windowEndAt) vs historicalSignalsOutsideWindow
    const allSavedSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        includeBlocked: true,
        limit: 5000,
      })
      .filter((s) => !s.isDemo && !s.source.toUpperCase().includes('DEMO'));

    const allWindowSignals: PaperTrackedSignalRecord[] = [];
    const outsideWindowSignals: PaperTrackedSignalRecord[] = [];
    for (const s of allSavedSignals) {
      const eventMs = Date.parse(s.signalDetectedAt || s.evaluatedAt);
      if (
        Number.isFinite(eventMs) &&
        bounds.windowStartMs <= eventMs &&
        eventMs < bounds.windowEndMs
      ) {
        allWindowSignals.push(s);
      } else {
        outsideWindowSignals.push(s);
      }
    }

    const isValidTradableCandidate = (s: PaperTrackedSignalRecord) =>
      s.status !== 'BLOCKED' &&
      s.smcEvaluationStatus === 'EVALUATED' &&
      (s.smcActionState === 'LONG CANDIDATE' ||
        s.smcActionState === 'SHORT CANDIDATE') &&
      s.finalTradeSignal !== 'NONE' &&
      !s.stale &&
      !s.fallback &&
      !s.isDemo &&
      (s.missingData?.length ?? 0) === 0 &&
      (s.waitReasons?.length ?? 0) === 0;

    const validTradableSignals = allWindowSignals.filter(
      isValidTradableCandidate
    );
    const historicalTradableOutsideWindow = outsideWindowSignals
      .filter(isValidTradableCandidate)
      .map((s) =>
        this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
      );

    const blockedSignals = allWindowSignals.filter(
      (s) => s.status === 'BLOCKED'
    );

    const mappedSignals = validTradableSignals.map((s) =>
      this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
    );

    const totalSignals = mappedSignals.length;
    const longSignals = mappedSignals.filter(
      (s) => s.direction === 'LONG'
    ).length;
    const shortSignals = mappedSignals.filter(
      (s) => s.direction === 'SHORT'
    ).length;
    const openSignals = mappedSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const openTrades = mappedSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;
    const paperOpened = mappedSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;
    const wins = mappedSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_WIN'
    ).length;
    const losses = mappedSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_LOSS'
    ).length;
    const expired = mappedSignals.filter(
      (s) => s.status === 'PAPER_EXPIRED'
    ).length;
    const paperClosed = wins + losses + expired;
    const invalidated = mappedSignals.filter(
      (s) => s.status === 'INVALIDATED'
    ).length;

    const currentCycleCompletedMs = Date.parse(
      bundle.snap.cycleCompletedAt || bundle.snap.snapshotAt
    );
    const isCurrentCycleInWindow =
      Number.isFinite(currentCycleCompletedMs) &&
      bounds.windowStartMs <= currentCycleCompletedMs &&
      currentCycleCompletedMs < bounds.windowEndMs;

    const entryWindowMissed = Math.max(
      isCurrentCycleInWindow ? bundle.snap.entryWindowMissedCount : 0,
      mappedSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length
    );

    const cyclesInWindow = bundle.cycles.filter((c) => {
      const completedMs = Date.parse(c.cycleCompletedAt || c.cycleStartedAt);
      return (
        Number.isFinite(completedMs) &&
        bounds.windowStartMs <= completedMs &&
        completedMs < bounds.windowEndMs
      );
    });
    const totalScans = Math.max(
      isCurrentCycleInWindow ? 1 : 0,
      cyclesInWindow.length
    );

    const totalEval = Math.max(1, bundle.snap.evaluatedCount);
    const waitWatchHighRiskDistribution = {
      waitCount: bundle.snap.waitCount,
      watchCount: bundle.snap.watchCount,
      highRiskCount: bundle.snap.highRiskCount,
      longCandidateCount: bundle.snap.longCandidateCount,
      shortCandidateCount: bundle.snap.shortCandidateCount,
      waitPercent: Number(
        ((bundle.snap.waitCount / totalEval) * 100).toFixed(2)
      ),
      watchPercent: Number(
        ((bundle.snap.watchCount / totalEval) * 100).toFixed(2)
      ),
      highRiskPercent: Number(
        ((bundle.snap.highRiskCount / totalEval) * 100).toFixed(2)
      ),
    };

    // Section 二: 修正 metricStatus 五態語義
    const hasClosedTrades = paperClosed > 0;
    let metricStatus: PaperMetricStatus;
    if (hasClosedTrades) {
      metricStatus = 'READY';
    } else if (totalSignals === 0) {
      metricStatus = 'NO_TRADES';
    } else if (paperOpened > 0) {
      metricStatus = 'OPEN_TRADES_NO_CLOSED_RESULTS';
    } else if (openSignals > 0) {
      metricStatus = 'SIGNALS_PENDING_ENTRY';
    } else if (entryWindowMissed > 0) {
      metricStatus = 'ENTRY_WINDOW_MISSED';
    } else {
      metricStatus = 'SIGNALS_PENDING_ENTRY';
    }

    const winRate = hasClosedTrades ? baseOutcomeReport.winRate : null;
    const averageR = hasClosedTrades ? baseOutcomeReport.averageR : null;
    const profitFactor = hasClosedTrades
      ? baseOutcomeReport.profitFactor
      : null;
    const maxDrawdownR = hasClosedTrades
      ? baseOutcomeReport.maxDrawdownR
      : null;
    const expectancyR = hasClosedTrades ? baseOutcomeReport.expectancyR : null;
    const averageHoldingTime = hasClosedTrades
      ? baseOutcomeReport.averageHoldingTime
      : null;

    const latencyResp = this.getSmcQualitySignalLatency(
      exchange,
      bounds.generatedAtMs,
      {
        window,
        reportAnchorAt: bounds.reportAnchorAt,
      }
    );

    const sampleCount = latencyResp.sampleCount;
    const sampleSufficiency: SampleSufficiencyTier =
      PaperShadowMonitor.computeSampleSufficiency(sampleCount);
    const sampleSufficiencyNotice =
      sampleSufficiency !== 'SUFFICIENT'
        ? '樣本不足，僅供觀察'
        : baseOutcomeReport.sampleSufficiencyNotice;

    const latestSignalDetectedAt =
      mappedSignals.length > 0 ? mappedSignals[0].signalDetectedAt : null;

    const envelope = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: entryWindowMissed,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: latestSignalDetectedAt,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
    });

    const totalCandOrSignals = Math.max(
      1,
      longSignals +
        shortSignals +
        bundle.snap.longCandidateCount +
        bundle.snap.shortCandidateCount
    );
    const hasAnyCandOrSignals =
      longSignals +
        shortSignals +
        bundle.snap.longCandidateCount +
        bundle.snap.shortCandidateCount >
      0;

    return {
      ...envelope,
      window,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      totalScans,
      totalSignals,
      longSignals,
      shortSignals,
      openSignals,
      openTrades,
      paperOpened,
      paperClosed,
      entryWindowMissed,
      invalidated,
      blocked: blockedSignals.length,
      wins,
      losses,
      expired,
      waitWatchHighRiskDistribution,
      topGateFailureReasons: bundle.topFailedGates.slice(0, 8),
      topBlockingReasons: bundle.waitReasonRanking.slice(0, 10),
      reasonCategories: bundle.reasonCategories,
      directionDistribution: {
        longSignals,
        shortSignals,
        longCandidateCount: bundle.snap.longCandidateCount,
        shortCandidateCount: bundle.snap.shortCandidateCount,
        longRatioPercent: hasAnyCandOrSignals
          ? Number(
              (
                ((longSignals + bundle.snap.longCandidateCount) /
                  totalCandOrSignals) *
                100
              ).toFixed(2)
            )
          : 0,
        shortRatioPercent: hasAnyCandOrSignals
          ? Number(
              (
                ((shortSignals + bundle.snap.shortCandidateCount) /
                  totalCandOrSignals) *
                100
              ).toFixed(2)
            )
          : 0,
        bullStructureBiasCount:
          bundle.directionDistribution.bullStructureBiasCount,
        bearStructureBiasCount:
          bundle.directionDistribution.bearStructureBiasCount,
        neutralOrConflictCount:
          bundle.directionDistribution.neutralOrConflictCount,
      },
      sampleCount,
      sampleSufficiency,
      sampleSufficiencyNotice,
      latencyStatisticType: latencyResp.latencyStatisticType,
      signalLatencyP50: latencyResp.signalLatencyP50,
      signalLatencyP95: latencyResp.signalLatencyP95,
      signalLatencyAvg: latencyResp.signalLatencyAvg,
      metricStatus,
      winRate,
      averageR,
      profitFactor,
      maxDrawdownR,
      expectancyR,
      averageHoldingTime,
      signals: mappedSignals,
      historicalSignalsOutsideWindowCount:
        historicalTradableOutsideWindow.length,
      historicalSignalsOutsideWindow: historicalTradableOutsideWindow,
    };
  }

  // ============================================================================
  // Phase 12–14: Long-Term Paper Signal Quality, Aggregation Semantics, Cycles, Gate Drift & Lifecycle History
  // ============================================================================

  private computeRegimeScopeAndCoverage(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>,
    options?: {
      scopeOverride?: RegimeDatasetScope;
    }
  ): {
    regimeScope: RegimeDatasetScope;
    regimeTotalSymbols: number;
    regimeEvaluatedCount: number;
    regimePendingCount: number;
    regimeFailedCount: number;
    regimeExcludedCount: number;
    regimeExcludedReasons: Record<string, number>;
    regimeCoverageRate: number;
    regimeDenominatorSummary: string;
    dedupedResults: SmcScanResultRecord[];
  } {
    const rawEvalResults = bundle.snap.results.filter((r) => !r.isDemo);
    const uniqueBySymbol = new Map<string, SmcScanResultRecord>();
    let dedupedDuplicateCount = 0;

    for (const r of rawEvalResults) {
      if (uniqueBySymbol.has(r.symbol)) {
        dedupedDuplicateCount += 1;
      } else {
        uniqueBySymbol.set(r.symbol, r);
      }
    }

    const dedupedResults = Array.from(uniqueBySymbol.values());
    const regimeEvaluatedCount = dedupedResults.length;
    const regimeTotalSymbols = Math.max(
      regimeEvaluatedCount,
      bundle.snap.totalSymbols
    );

    const normalizedPending = Math.max(
      0,
      bundle.snap.totalSymbols -
        bundle.snap.evaluatedCount -
        bundle.snap.failedCount -
        bundle.snap.rateLimitedCount
    );
    const regimePendingCount = normalizedPending;
    const regimeFailedCount = bundle.snap.failedCount;
    const regimeExcludedCount = Math.max(
      0,
      regimeTotalSymbols - regimeEvaluatedCount
    );

    // Breakdown of excluded symbols across the 7 required categories so they sum to regimeExcludedCount
    const pendingExcluded = Math.min(regimeExcludedCount, regimePendingCount);
    const remainingAfterPending = Math.max(
      0,
      regimeExcludedCount - pendingExcluded
    );
    const incompleteCycleExcluded = Math.min(
      remainingAfterPending,
      bundle.snap.rateLimitedCount
    );
    const remainingAfterIncomplete = Math.max(
      0,
      remainingAfterPending - incompleteCycleExcluded
    );
    const dedupedExcluded = Math.min(
      remainingAfterIncomplete,
      dedupedDuplicateCount
    );
    const remainingAfterDeduped = Math.max(
      0,
      remainingAfterIncomplete - dedupedExcluded
    );
    const otherExplicitExcluded = remainingAfterDeduped;

    const regimeExcludedReasons: Record<string, number> = {
      PENDING: pendingExcluded,
      '缺少 K 線': 0,
      '缺少 OI/Funding': 0,
      'stale/fallback': 0,
      週期未完成: incompleteCycleExcluded,
      重複標的去重: dedupedExcluded,
      其他明確原因: otherExplicitExcluded,
    };

    let regimeScope: RegimeDatasetScope;
    if (options?.scopeOverride) {
      regimeScope = options.scopeOverride;
    } else if (dedupedDuplicateCount > 0) {
      regimeScope = 'DEDUPED_SYMBOLS';
    } else if (
      regimeEvaluatedCount < regimeTotalSymbols ||
      bundle.snap.fullUniverseStatus !== 'COMPLETED'
    ) {
      regimeScope = 'PARTIAL_DATASET';
    } else {
      regimeScope = 'LATEST_COMPLETED_CYCLE';
    }

    const regimeCoverageRate =
      regimeTotalSymbols > 0
        ? Number(((regimeEvaluatedCount / regimeTotalSymbols) * 100).toFixed(2))
        : 100;

    const regimeDenominatorSummary =
      regimeExcludedCount === 0
        ? `全市場 ${regimeTotalSymbols} 檔合約已全部納入市場狀態分層分析 (覆蓋率 100%，無排除標的)`
        : `全市場共 ${regimeTotalSymbols} 檔合約，已納入市場狀態分層分析 ${regimeEvaluatedCount} 檔 (${regimeCoverageRate}%)，排除 ${regimeExcludedCount} 檔（PENDING=${regimeExcludedReasons.PENDING}、缺少 K 線=${regimeExcludedReasons['缺少 K 線']}、缺少 OI/Funding=${regimeExcludedReasons['缺少 OI/Funding']}、stale/fallback=${regimeExcludedReasons['stale/fallback']}、週期未完成=${regimeExcludedReasons['週期未完成']}、重複標的去重=${regimeExcludedReasons['重複標的去重']}、其他明確原因=${regimeExcludedReasons['其他明確原因']}）`;

    return {
      regimeScope,
      regimeTotalSymbols,
      regimeEvaluatedCount,
      regimePendingCount,
      regimeFailedCount,
      regimeExcludedCount,
      regimeExcludedReasons,
      regimeCoverageRate,
      regimeDenominatorSummary,
      dedupedResults,
    };
  }

  private evaluateCycleIdentityChecks(params: {
    evaluatedCount: number;
    pendingCount: number;
    failedCount: number;
    rateLimitedCount: number;
    totalSymbols: number;
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    uniqueEvaluatedSymbols?: number;
    excludedSymbols?: number;
    evaluationUniverseSize?: number;
    applyTestOverride?: boolean;
  }): PaperQualityCycleIdentityChecks {
    const ov = params.applyTestOverride
      ? this.statisticalIdentityTestOverride
      : null;
    const totalSymbols = ov?.totalSymbols ?? params.totalSymbols;
    const evaluatedCount = ov?.evaluatedCount ?? params.evaluatedCount;
    const uniqueEvaluatedSymbols =
      params.uniqueEvaluatedSymbols ?? params.evaluatedCount;
    const excludedSymbols =
      params.excludedSymbols ??
      Math.max(0, params.totalSymbols - uniqueEvaluatedSymbols);
    const evaluationUniverseSize =
      ov?.evaluationUniverseSize ??
      params.evaluationUniverseSize ??
      params.totalSymbols;

    const lhs1 =
      params.evaluatedCount +
      params.pendingCount +
      params.failedCount +
      params.rateLimitedCount;
    const rhs1 = totalSymbols;
    const valid1 = lhs1 === rhs1;

    const lhs2 =
      params.waitCount +
      params.watchCount +
      params.highRiskCount +
      params.longCandidateCount +
      params.shortCandidateCount;
    const rhs2 = evaluatedCount;
    const valid2 = lhs2 === rhs2;

    const lhs3 = uniqueEvaluatedSymbols + excludedSymbols;
    const rhs3 = evaluationUniverseSize;
    const valid3 = lhs3 === rhs3;

    return {
      totalSymbolsIdentity: {
        formula:
          'evaluatedCount + pendingCount + failedCount + rateLimitedCount = totalSymbols',
        lhs: lhs1,
        rhs: rhs1,
        expression: `${params.evaluatedCount} + ${params.pendingCount} + ${params.failedCount} + ${params.rateLimitedCount} = ${lhs1} (totalSymbols = ${rhs1})`,
        valid: valid1,
      },
      actionStateIdentity: {
        formula:
          'WAIT + WATCH + HIGH RISK + LONG CANDIDATE + SHORT CANDIDATE = evaluatedCount',
        lhs: lhs2,
        rhs: rhs2,
        expression: `${params.waitCount} + ${params.watchCount} + ${params.highRiskCount} + ${params.longCandidateCount} + ${params.shortCandidateCount} = ${lhs2} (evaluatedCount = ${rhs2})`,
        valid: valid2,
      },
      uniqueUniverseIdentity: {
        formula:
          'uniqueEvaluatedSymbols + excludedSymbols = evaluationUniverseSize',
        lhs: lhs3,
        rhs: rhs3,
        expression: `${uniqueEvaluatedSymbols} + ${excludedSymbols} = ${lhs3} (evaluationUniverseSize = ${rhs3})`,
        valid: valid3,
      },
      allValid: valid1 && valid2 && valid3,
    };
  }

  private evaluateStatisticalIdentities(params: {
    evaluatedCount: number;
    pendingCount: number;
    failedCount: number;
    rateLimitedCount: number;
    totalSymbols: number;
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    fastLaneCount: number;
    bulkCount: number;
    missingLatencySampleCount: number;
    latencyEvaluatedCount: number;
    regimeEvaluatedCount: number;
    regimeExcludedCount: number;
    regimeTotalSymbols: number;
    uniqueEvaluatedSymbols?: number;
    excludedSymbols?: number;
    evaluationUniverseSize?: number;
  }): PaperQualityIdentityChecks {
    const ov = this.statisticalIdentityTestOverride;
    const totalSymbols = ov?.totalSymbols ?? params.totalSymbols;
    const evaluatedCount = ov?.evaluatedCount ?? params.evaluatedCount;
    const latencyEvaluatedCount =
      ov?.latencyEvaluatedCount ?? params.latencyEvaluatedCount;
    const regimeTotalSymbols =
      ov?.regimeTotalSymbols ?? params.regimeTotalSymbols;
    const uniqueEvaluatedSymbols =
      params.uniqueEvaluatedSymbols ?? params.regimeEvaluatedCount;
    const excludedSymbols =
      params.excludedSymbols ?? params.regimeExcludedCount;
    const evaluationUniverseSize =
      ov?.evaluationUniverseSize ??
      params.evaluationUniverseSize ??
      regimeTotalSymbols;

    const lhs1 =
      params.evaluatedCount +
      params.pendingCount +
      params.failedCount +
      params.rateLimitedCount;
    const rhs1 = totalSymbols;
    const valid1 = lhs1 === rhs1;

    const lhs2 =
      params.waitCount +
      params.watchCount +
      params.highRiskCount +
      params.longCandidateCount +
      params.shortCandidateCount;
    const rhs2 = evaluatedCount;
    const valid2 = lhs2 === rhs2;

    const lhs3 =
      params.fastLaneCount +
      params.bulkCount +
      params.missingLatencySampleCount;
    const rhs3 = latencyEvaluatedCount;
    const valid3 =
      lhs3 === rhs3 &&
      params.fastLaneCount +
        params.bulkCount +
        params.missingLatencySampleCount ===
        rhs3;

    const lhs4 = params.regimeEvaluatedCount + params.regimeExcludedCount;
    const rhs4 = regimeTotalSymbols;
    const valid4 = lhs4 === rhs4;

    const lhs5 = uniqueEvaluatedSymbols + excludedSymbols;
    const rhs5 = evaluationUniverseSize;
    const valid5 = lhs5 === rhs5;

    return {
      totalSymbolsIdentity: {
        formula:
          'evaluatedCount + pendingCount + failedCount + rateLimitedCount = totalSymbols',
        lhs: lhs1,
        rhs: rhs1,
        expression: `${params.evaluatedCount} + ${params.pendingCount} + ${params.failedCount} + ${params.rateLimitedCount} = ${lhs1} (totalSymbols = ${rhs1})`,
        valid: valid1,
      },
      actionStateIdentity: {
        formula:
          'WAIT + WATCH + HIGH RISK + LONG CANDIDATE + SHORT CANDIDATE = evaluatedCount',
        lhs: lhs2,
        rhs: rhs2,
        expression: `${params.waitCount} + ${params.watchCount} + ${params.highRiskCount} + ${params.longCandidateCount} + ${params.shortCandidateCount} = ${lhs2} (evaluatedCount = ${rhs2})`,
        valid: valid2,
      },
      latencyCoverageIdentity: {
        formula:
          'fastLaneCount + bulkCount + missingLatencySampleCount = latencyEvaluatedCount',
        lhs: lhs3,
        rhs: rhs3,
        expression: `${params.fastLaneCount} + ${params.bulkCount} + ${params.missingLatencySampleCount} = ${lhs3} (latencyEvaluatedCount = ${rhs3})`,
        valid: valid3,
      },
      regimeCoverageIdentity: {
        formula:
          'regimeEvaluatedCount + regimeExcludedCount = regimeTotalSymbols',
        lhs: lhs4,
        rhs: rhs4,
        expression: `${params.regimeEvaluatedCount} + ${params.regimeExcludedCount} = ${lhs4} (regimeTotalSymbols = ${rhs4})`,
        valid: valid4,
      },
      uniqueUniverseIdentity: {
        formula:
          'uniqueEvaluatedSymbols + excludedSymbols = evaluationUniverseSize',
        lhs: lhs5,
        rhs: rhs5,
        expression: `${uniqueEvaluatedSymbols} + ${excludedSymbols} = ${lhs5} (evaluationUniverseSize = ${rhs5})`,
        valid: valid5,
      },
      allValid: valid1 && valid2 && valid3 && valid4 && valid5,
    };
  }

  private buildCycleGateStatsMap(
    rawGateStats:
      | Record<
          string,
          {
            passCount?: number;
            failCount?: number;
            passRate?: number;
            passRatePercent?: number;
            failureRate?: number;
            evaluatedDenominator?: number;
            excludedCount?: number;
          }
        >
      | undefined,
    evaluatedCount: number,
    totalSymbols: number,
    fallbackBundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>
  ): Record<string, PaperQualityCycleGateStat> {
    const denom = Math.max(0, evaluatedCount);
    const safeDenom = Math.max(1, denom);
    const excludedCount = Math.max(0, totalSymbols - denom);
    const canonicalKeys: Array<{ key: string; alias?: string }> = [
      { key: 'confirmedClosedKlines' },
      { key: 'historyBaselineReady' },
      { key: 'validATR' },
      { key: 'BOS/MSS', alias: 'bosMss' },
      { key: 'Liquidity Sweep', alias: 'liquiditySweep' },
      { key: 'Displacement', alias: 'displacement' },
      { key: 'FVG/Order Block', alias: 'fvgOrderBlock' },
      { key: 'MTF Alignment', alias: 'mtfAlignment' },
      { key: 'OI available', alias: 'oiAvailable' },
      { key: 'Funding available', alias: 'fundingAvailable' },
      { key: 'Liquidity safety', alias: 'liquiditySafety' },
      { key: 'Funding safety', alias: 'fundingSafety' },
      { key: 'stale/fallback/missingData' },
    ];

    const out: Record<string, PaperQualityCycleGateStat> = {};
    for (const { key, alias } of canonicalKeys) {
      const entry =
        rawGateStats?.[key] ?? (alias ? rawGateStats?.[alias] : undefined);
      let passCount: number;
      let failCount: number;
      let passRate: number;
      let failureRate: number;

      if (entry && typeof entry.passCount === 'number') {
        passCount = entry.passCount;
        failCount =
          typeof entry.failCount === 'number'
            ? entry.failCount
            : Math.max(0, denom - passCount);
        const entryDenom = Math.max(
          1,
          entry.evaluatedDenominator ?? passCount + failCount
        );
        passRate =
          typeof entry.passRate === 'number'
            ? Number(entry.passRate.toFixed(2))
            : typeof entry.passRatePercent === 'number'
              ? Number(entry.passRatePercent.toFixed(2))
              : Number(((passCount / entryDenom) * 100).toFixed(2));
        failureRate =
          typeof entry.failureRate === 'number'
            ? Number(entry.failureRate.toFixed(2))
            : Number((100 - passRate).toFixed(2));
      } else {
        const fbSummary =
          fallbackBundle.gateSummaryMap[key as SmcQualityGateKey];
        const fbRate = Number(
          (
            fbSummary?.passRate ??
            fallbackBundle.gatePassRates[key as SmcQualityGateKey] ??
            0
          ).toFixed(2)
        );
        passCount = Math.min(denom, Math.round((fbRate / 100) * denom));
        failCount = Math.max(0, denom - passCount);
        passRate =
          denom > 0 ? Number(((passCount / safeDenom) * 100).toFixed(2)) : 0;
        failureRate = denom > 0 ? Number((100 - passRate).toFixed(2)) : 0;
      }

      const evalDenom = entry?.evaluatedDenominator ?? denom;
      const excl =
        entry?.excludedCount ?? Math.max(0, totalSymbols - evalDenom);
      out[key] = {
        gate: key,
        label: key,
        passCount,
        failCount,
        passRate,
        failureRate,
        evaluatedDenominator: evalDenom,
        excludedCount: excl,
        statisticScope: 'ALL_EVALUATED',
      };
    }

    // Also compute composite 'OI/Funding' gate
    const oiAvail = out['OI available'];
    const fundAvail = out['Funding available'];
    const fundSafe = out['Funding safety'];
    const avgPassCount = Math.min(
      denom,
      Math.round(
        ((oiAvail?.passCount ?? denom) +
          (fundAvail?.passCount ?? denom) +
          (fundSafe?.passCount ?? denom)) /
          3
      )
    );
    const avgFailCount = Math.max(0, denom - avgPassCount);
    const avgPassRate = Number(
      (
        ((oiAvail?.passRate ?? 100) +
          (fundAvail?.passRate ?? 100) +
          (fundSafe?.passRate ?? 100)) /
        3
      ).toFixed(2)
    );
    out['OI/Funding'] = {
      gate: 'OI/Funding',
      label: 'OI/Funding',
      passCount: avgPassCount,
      failCount: avgFailCount,
      passRate: avgPassRate,
      failureRate: Number((100 - avgPassRate).toFixed(2)),
      evaluatedDenominator: denom,
      excludedCount,
      statisticScope: 'ALL_EVALUATED',
    };

    return out;
  }

  private buildPaperQualityCycleDetailRecords(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>,
    exchange: ExchangeId,
    options?: {
      windowStartMs?: number;
      windowEndMs?: number;
      includeAllCycles?: boolean;
    }
  ): PaperQualityCycleDetailRecord[] {
    const allDbCycles = this.radarDb.listAllSmcScanCycles(exchange);
    const byCycleId = new Map<string, SmcScanCycleHistoryRecord>();

    for (const c of allDbCycles) {
      byCycleId.set(c.scanCycleId, c);
    }
    for (const c of bundle.cycles) {
      if (!byCycleId.has(c.scanCycleId)) {
        byCycleId.set(c.scanCycleId, {
          scanCycleId: c.scanCycleId,
          exchange,
          windowKey: c.windowKey,
          ruleVersion: c.ruleVersion,
          cycleStartedAt: c.cycleStartedAt,
          cycleCompletedAt: c.cycleCompletedAt,
          cycleStatus: c.cycleStatus,
          isColdStart: c.isColdStart,
          cacheMode: c.cacheMode,
          completedHttpRequests: c.evaluatedCount * 5,
          totalContracts: c.totalContracts,
          totalEvaluated: c.evaluatedCount,
          evaluatedCount: c.evaluatedCount,
          pendingCount: c.pendingCount,
          failedCount: c.failedCount,
          rateLimitedCount: c.rateLimitedCount,
          waitCount: c.waitCount,
          watchCount: c.watchCount,
          highRiskCount: c.highRiskCount,
          longCandidateCount: c.longCandidateCount,
          shortCandidateCount: c.shortCandidateCount,
          gateNotConfirmedCount: c.gateNotConfirmedCount,
          finalCategorySmcMismatchCount: c.finalCategorySmcMismatchCount,
          gateStats: c.gateStats,
          reasonCategoryCounts: c.reasonCategoryCounts,
          waitReasonCounts: c.waitReasonCounts,
          candidateStatus: bundle.snap.candidateStatus,
          statsVersion: bundle.snap.statsVersion,
          databaseInstanceId: this.radarDb.databaseInstanceId,
          radarScanDurationMs: null,
          prewarmDurationMs: null,
          prewarmCacheHitRate: null,
          prioritySmcDurationMs: null,
          fullCycleDurationMs: c.fullCycleDurationMs,
          fullUniverseCompletionDurationMs: c.fullCycleDurationMs,
          p50DetectionLatencyMs: c.p50DetectionLatencyMs,
          p90DetectionLatencyMs: null,
          p95DetectionLatencyMs: c.p95DetectionLatencyMs,
          p99DetectionLatencyMs: null,
          p50PriorityDetectionLatencyMs: c.p50DetectionLatencyMs,
          p90PriorityDetectionLatencyMs: null,
          p95PriorityDetectionLatencyMs: c.p95DetectionLatencyMs,
          p99PriorityDetectionLatencyMs: null,
          maxPriorityDetectionLatencyMs: null,
          p50BulkQueueWaitMs: null,
          p90BulkQueueWaitMs: null,
          p95BulkQueueWaitMs: null,
          p99BulkQueueWaitMs: null,
          maxBulkQueueWaitMs: null,
          cacheHitRate: c.cacheMode === 'COLD' ? 0 : 100,
          cacheMissRate: c.cacheMode === 'COLD' ? 100 : 0,
          candidateDetectedBeforeEntryWindowCount:
            c.candidateDetectedBeforeEntryWindowCount,
          entryWindowMissedCount: c.entryWindowMissedCount,
          priorityRefreshCount: 0,
        });
      }
    }

    // Ensure the current snapshot cycle is included / merged
    const snap = bundle.snap;
    const resultCycleId =
      snap.results.find((r) => Boolean(r.scanCycleId))?.scanCycleId || null;
    const effectiveSnapCycleId = resultCycleId || snap.scanCycleId;
    if (effectiveSnapCycleId && !byCycleId.has(effectiveSnapCycleId)) {
      const earliestResultAt = snap.results.reduce<string | null>(
        (minIso, r) => {
          const ts = r.evaluatedAt || r.dataFetchedAt || r.fetchedAt || null;
          if (!ts) return minIso;
          if (!minIso || Date.parse(ts) < Date.parse(minIso)) return ts;
          return minIso;
        },
        null
      );
      const normalizedPending =
        snap.evaluatedCount +
          snap.pendingCount +
          snap.failedCount +
          snap.rateLimitedCount ===
        snap.totalSymbols
          ? snap.pendingCount
          : Math.max(
              0,
              snap.totalSymbols -
                snap.evaluatedCount -
                snap.failedCount -
                snap.rateLimitedCount
            );
      byCycleId.set(effectiveSnapCycleId, {
        scanCycleId: effectiveSnapCycleId,
        exchange,
        windowKey: 'win_15m',
        ruleVersion: SMC_RULE_VERSION,
        cycleStartedAt:
          snap.cycleStartedAt || earliestResultAt || snap.snapshotAt,
        cycleCompletedAt: snap.cycleCompletedAt,
        cycleStatus:
          snap.fullUniverseStatus === 'COMPLETED' ? 'COMPLETED' : 'RUNNING',
        isColdStart: snap.cacheMode === 'COLD',
        cacheMode: snap.cacheMode,
        completedHttpRequests: snap.completedHttpRequests,
        totalContracts: snap.totalSymbols,
        totalEvaluated: snap.evaluatedCount,
        evaluatedCount: snap.evaluatedCount,
        pendingCount: normalizedPending,
        failedCount: snap.failedCount,
        rateLimitedCount: snap.rateLimitedCount,
        waitCount: snap.waitCount,
        watchCount: snap.watchCount,
        highRiskCount: snap.highRiskCount,
        longCandidateCount: snap.longCandidateCount,
        shortCandidateCount: snap.shortCandidateCount,
        gateNotConfirmedCount:
          snap.waitCount + snap.watchCount + snap.highRiskCount,
        finalCategorySmcMismatchCount: bundle.finalCategorySmcMismatchCount,
        gateStats: bundle.gateSummaryMap,
        reasonCategoryCounts: bundle.primaryCategoryCounts,
        waitReasonCounts: bundle.waitReasonCounts,
        candidateStatus: snap.candidateStatus,
        statsVersion: snap.statsVersion,
        databaseInstanceId: this.radarDb.databaseInstanceId,
        radarScanDurationMs: snap.radarScanDurationMs,
        prewarmDurationMs: snap.prewarmDurationMs,
        prewarmCacheHitRate: snap.prewarmCacheHitRate,
        prioritySmcDurationMs: snap.prioritySmcDurationMs,
        fullCycleDurationMs: snap.fullUniverseCompletionDuration,
        fullUniverseCompletionDurationMs: snap.fullUniverseCompletionDuration,
        p50DetectionLatencyMs: snap.p50DetectionLatencyMs,
        p90DetectionLatencyMs: snap.p90DetectionLatencyMs,
        p95DetectionLatencyMs: snap.p95DetectionLatencyMs,
        p99DetectionLatencyMs: snap.p99DetectionLatencyMs,
        p50PriorityDetectionLatencyMs: snap.p50PriorityDetectionLatencyMs,
        p90PriorityDetectionLatencyMs: snap.p90PriorityDetectionLatencyMs,
        p95PriorityDetectionLatencyMs: snap.p95PriorityDetectionLatencyMs,
        p99PriorityDetectionLatencyMs: snap.p99PriorityDetectionLatencyMs,
        maxPriorityDetectionLatencyMs: snap.maxPriorityDetectionLatencyMs,
        p50BulkQueueWaitMs: snap.p50BulkQueueWaitMs,
        p90BulkQueueWaitMs: snap.p90BulkQueueWaitMs,
        p95BulkQueueWaitMs: snap.p95BulkQueueWaitMs,
        p99BulkQueueWaitMs: snap.p99BulkQueueWaitMs,
        maxBulkQueueWaitMs: snap.maxBulkQueueWaitMs,
        cacheHitRate: snap.cacheHitRate,
        cacheMissRate: snap.cacheMissRate,
        candidateDetectedBeforeEntryWindowCount:
          snap.candidateDetectedBeforeEntryWindowCount,
        entryWindowMissedCount: snap.entryWindowMissedCount,
        priorityRefreshCount: snap.priorityRefreshCount,
      });
    }

    const rawList = Array.from(byCycleId.values()).sort((a, b) => {
      const ta = Date.parse(a.cycleCompletedAt || a.cycleStartedAt || '');
      const tb = Date.parse(b.cycleCompletedAt || b.cycleStartedAt || '');
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
        return ta - tb;
      }
      return a.scanCycleId.localeCompare(b.scanCycleId);
    });

    const filteredList =
      options?.includeAllCycles ||
      options?.windowStartMs === undefined ||
      options?.windowEndMs === undefined
        ? rawList
        : rawList.filter((c) => {
            const t = Date.parse(
              c.cycleCompletedAt || c.cycleStartedAt || snap.snapshotAt
            );
            const isSnapCycle =
              c.scanCycleId === snap.scanCycleId ||
              c.scanCycleId === effectiveSnapCycleId;
            return (
              Number.isFinite(t) &&
              options.windowStartMs! <= t &&
              (t < options.windowEndMs! ||
                (isSnapCycle && t <= options.windowEndMs!))
            );
          });

    return filteredList.map((c) => {
      const isLatestCycle =
        c.scanCycleId === snap.scanCycleId ||
        c.scanCycleId === effectiveSnapCycleId;
      const totalSymbols = c.totalContracts;
      const evaluatedCount = c.evaluatedCount;
      const failedCount = c.failedCount;
      const rateLimitedCount = c.rateLimitedCount;

      // Preserve explicit non-zero pendingCount for test validation, or normalize if 0 on incomplete cycle
      const pendingCount =
        c.pendingCount > 0
          ? c.pendingCount
          : Math.max(
              0,
              totalSymbols - evaluatedCount - failedCount - rateLimitedCount
            );

      const waitCount = c.waitCount;
      const watchCount = c.watchCount;
      const highRiskCount = c.highRiskCount;
      const longCandidateCount = c.longCandidateCount;
      const shortCandidateCount = c.shortCandidateCount;

      const cacheHitRate =
        c.cacheHitRate ?? (c.cacheMode === 'COLD' ? 0 : 100);
      const cacheHitCount = isLatestCycle
        ? snap.cacheHitCount
        : Math.round((cacheHitRate / 100) * evaluatedCount);
      const cacheMissCount = isLatestCycle
        ? snap.cacheMissCount
        : Math.max(0, evaluatedCount - cacheHitCount);
      const completedHttpRequests =
        (c.completedHttpRequests ?? 0) > 0
          ? (c.completedHttpRequests as number)
          : isLatestCycle
            ? snap.completedHttpRequests
            : evaluatedCount * 5;

      let durationMs =
        c.fullCycleDurationMs ?? c.fullUniverseCompletionDurationMs ?? null;
      if (
        (durationMs === null || durationMs === undefined) &&
        c.cycleStartedAt &&
        c.cycleCompletedAt
      ) {
        const diff =
          Date.parse(c.cycleCompletedAt) - Date.parse(c.cycleStartedAt);
        if (Number.isFinite(diff) && diff >= 0) {
          durationMs = diff;
        }
      }
      if (durationMs === null && isLatestCycle) {
        durationMs = snap.fullUniverseCompletionDuration;
      }

      const uniqueEvaluatedSymbols = evaluatedCount;
      const evaluationUniverseSize = totalSymbols;
      const excludedSymbols = Math.max(
        0,
        evaluationUniverseSize - uniqueEvaluatedSymbols
      );
      const evaluationExcludedReasons: Record<string, number> = {};
      if (pendingCount > 0) {
        evaluationExcludedReasons.PENDING_UNIVERSE_SCAN = pendingCount;
      }
      if (failedCount > 0) {
        evaluationExcludedReasons.FAILED_HTTP_OR_PARSE = failedCount;
      }
      if (rateLimitedCount > 0) {
        evaluationExcludedReasons.RATE_LIMITED = rateLimitedCount;
      }

      const identityChecks = this.evaluateCycleIdentityChecks({
        evaluatedCount,
        pendingCount,
        failedCount,
        rateLimitedCount,
        totalSymbols,
        waitCount,
        watchCount,
        highRiskCount,
        longCandidateCount,
        shortCandidateCount,
        uniqueEvaluatedSymbols,
        excludedSymbols,
        evaluationUniverseSize,
        applyTestOverride: isLatestCycle,
      });

      const statsConsistency = identityChecks.allValid ? 'VALID' : 'INVALID';

      let resolvedStatus: 'COMPLETED' | 'RUNNING' | 'INTERRUPTED' | 'FAILED';
      if (statsConsistency === 'INVALID') {
        resolvedStatus = 'FAILED';
      } else if (
        c.cycleStatus === 'COMPLETED' &&
        pendingCount === 0 &&
        failedCount === 0 &&
        rateLimitedCount === 0
      ) {
        resolvedStatus = 'COMPLETED';
      } else if (isLatestCycle && snap.cycleStatus === 'RUNNING') {
        resolvedStatus = 'RUNNING';
      } else {
        resolvedStatus = 'INTERRUPTED';
      }

      const gateStats = this.buildCycleGateStatsMap(
        c.gateStats as Record<
          string,
          {
            passCount?: number;
            failCount?: number;
            passRate?: number;
            passRatePercent?: number;
            failureRate?: number;
            evaluatedDenominator?: number;
            excludedCount?: number;
          }
        >,
        evaluatedCount,
        totalSymbols,
        bundle
      );

      return {
        cycleId: c.scanCycleId,
        scanCycleId: c.scanCycleId,
        exchange,
        windowKey: c.windowKey || 'win_15m',
        ruleVersion: c.ruleVersion || SMC_RULE_VERSION,
        cycleStatus: resolvedStatus,
        cacheMode: c.cacheMode ?? 'COLD',
        cycleStartedAt: c.cycleStartedAt,
        cycleCompletedAt: c.cycleCompletedAt,
        totalSymbols,
        evaluatedCount,
        pendingCount,
        failedCount,
        rateLimitedCount,
        waitCount,
        watchCount,
        highRiskCount,
        longCandidateCount,
        shortCandidateCount,
        cacheHitCount,
        cacheMissCount,
        completedHttpRequests,
        fullUniverseCompletionDuration: durationMs,
        statsVersion: isLatestCycle ? snap.statsVersion : c.statsVersion,
        snapshotAt: c.cycleCompletedAt || snap.snapshotAt,
        uniqueEvaluatedSymbols,
        excludedSymbols,
        evaluationUniverseSize,
        evaluationExcludedCount: excludedSymbols,
        evaluationExcludedReasons,
        statsConsistency,
        identityChecks,
        gateStats,
      };
    });
  }

  private buildPaperQualitySharedEnvelope(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>,
    params: {
      monitoringWindowId: string;
      entryWindowMissedCount: number;
      reportGeneratedAt: string;
      reportAnchorAt: string;
      windowStartAt: string;
      windowEndAt: string;
      signalDetectedAt: string | null;
      scanCycleCompletedAt: string | null;
      dataStaleCount: number;
      fallbackCount: number;
      missingDataCount: number;
      sampleSufficiency: SampleSufficiencyTier;
      sampleSufficiencyNotice: string;
      latencySummary: PaperQualityLatencySummary;
      performanceSampleCount: number;
      performanceSampleSufficiency: SampleSufficiencyTier;
      isAtomicSnapshot: boolean;
      regimeScopeOverride?: RegimeDatasetScope;
      aggregationMode?: EvaluationAggregationMode;
      cumulativeEvaluationEventsOverride?: number;
    }
  ): PaperQualitySharedEnvelope {
    const baseEnv = this.buildQualitySharedEnvelope(bundle, {
      entryWindowMissedCount: params.entryWindowMissedCount,
      reportGeneratedAt: params.reportGeneratedAt,
      reportAnchorAt: params.reportAnchorAt,
      windowStartAt: params.windowStartAt,
      windowEndAt: params.windowEndAt,
      signalDetectedAt: params.signalDetectedAt,
      scanCycleCompletedAt: params.scanCycleCompletedAt,
    });

    const normalizedPendingCount =
      baseEnv.evaluatedCount +
        baseEnv.pendingCount +
        baseEnv.failedCount +
        baseEnv.rateLimitedCount ===
      baseEnv.totalSymbols
        ? baseEnv.pendingCount
        : Math.max(
            0,
            baseEnv.totalSymbols -
              baseEnv.evaluatedCount -
              baseEnv.failedCount -
              baseEnv.rateLimitedCount
          );

    const regimeInfo = this.computeRegimeScopeAndCoverage(bundle, {
      scopeOverride: params.regimeScopeOverride,
    });

    const windowCycles = this.buildPaperQualityCycleDetailRecords(
      bundle,
      baseEnv.exchange,
      {
        windowStartMs: Date.parse(params.windowStartAt),
        windowEndMs: Date.parse(params.windowEndAt),
      }
    );

    const latestCycleEvaluatedCount = baseEnv.evaluatedCount;
    const uniqueEvaluatedSymbols = regimeInfo.regimeEvaluatedCount;
    const evaluationUniverseSize = regimeInfo.regimeTotalSymbols;
    const evaluationExcludedCount = Math.max(
      0,
      evaluationUniverseSize - uniqueEvaluatedSymbols
    );
    const excludedSymbols = evaluationExcludedCount;
    const evaluationExcludedReasons = regimeInfo.regimeExcludedReasons;
    const cumulativeEvaluationEvents =
      params.cumulativeEvaluationEventsOverride ??
      Math.max(
        latestCycleEvaluatedCount,
        windowCycles.reduce((acc, c) => acc + c.evaluatedCount, 0)
      );
    const evaluationAggregationMode: EvaluationAggregationMode =
      params.aggregationMode ?? 'DEDUPED_SYMBOLS';

    const identityChecks = this.evaluateStatisticalIdentities({
      evaluatedCount: baseEnv.evaluatedCount,
      pendingCount: normalizedPendingCount,
      failedCount: baseEnv.failedCount,
      rateLimitedCount: baseEnv.rateLimitedCount,
      totalSymbols: baseEnv.totalSymbols,
      waitCount: baseEnv.waitCount,
      watchCount: baseEnv.watchCount,
      highRiskCount: baseEnv.highRiskCount,
      longCandidateCount: baseEnv.longCandidateCount,
      shortCandidateCount: baseEnv.shortCandidateCount,
      fastLaneCount: params.latencySummary.fastLaneCount,
      bulkCount: params.latencySummary.bulkCount,
      missingLatencySampleCount:
        params.latencySummary.missingLatencySampleCount,
      latencyEvaluatedCount: params.latencySummary.latencyEvaluatedCount,
      regimeEvaluatedCount: regimeInfo.regimeEvaluatedCount,
      regimeExcludedCount: regimeInfo.regimeExcludedCount,
      regimeTotalSymbols: regimeInfo.regimeTotalSymbols,
      uniqueEvaluatedSymbols,
      excludedSymbols,
      evaluationUniverseSize,
    });

    const statsConsistency =
      identityChecks.allValid && baseEnv.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';

    const fullUniverseStatus =
      statsConsistency === 'INVALID' &&
      baseEnv.fullUniverseStatus === 'COMPLETED'
        ? 'FAILED'
        : baseEnv.fullUniverseStatus;

    const cycleStatus =
      statsConsistency === 'INVALID' && baseEnv.cycleStatus === 'COMPLETED'
        ? 'FAILED'
        : baseEnv.cycleStatus;

    const hasDegraded =
      params.dataStaleCount > 0 ||
      params.fallbackCount > 0 ||
      params.missingDataCount > 0 ||
      baseEnv.provenance.stale ||
      baseEnv.provenance.fallback;

    const queryMode = params.isAtomicSnapshot
      ? 'ATOMIC_UNIFIED_SNAPSHOT'
      : 'SEPARATE_WINDOW_QUERY';
    const atomicSnapshotNotice = params.isAtomicSnapshot
      ? '同一份 30d/60d/90d 原子快照（共用相同 reportAnchorAt、windowEndAt、snapshotAt 與 statsVersion）'
      : '單一窗口獨立查詢（非 30d/60d/90d 同一原子快照；已鎖定相同 statsVersion 之 reportAnchorAt 以防跨窗口數秒差異漂移）';

    const resolvedEvaluatedForMode =
      evaluationAggregationMode === 'CUMULATIVE_EVENTS'
        ? cumulativeEvaluationEvents
        : evaluationAggregationMode === 'LATEST_CYCLE'
          ? latestCycleEvaluatedCount
          : uniqueEvaluatedSymbols;

    return {
      ...baseEnv,
      totalEvaluated: resolvedEvaluatedForMode,
      pendingCount: normalizedPendingCount,
      statsConsistency,
      fullUniverseStatus,
      cycleStatus,
      monitoringWindowId: params.monitoringWindowId,
      isAtomicSnapshot: params.isAtomicSnapshot,
      queryMode,
      atomicSnapshotNotice,
      latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents,
      evaluationAggregationMode,
      evaluationUniverseSize,
      evaluationExcludedCount,
      excludedSymbols,
      evaluationExcludedReasons,
      fastLaneCount: params.latencySummary.fastLaneCount,
      bulkCount: params.latencySummary.bulkCount,
      latencyEvaluatedCount: params.latencySummary.latencyEvaluatedCount,
      latencySampleCount: params.latencySummary.latencySampleCount,
      missingLatencySampleCount:
        params.latencySummary.missingLatencySampleCount,
      latencyCoverageRate: params.latencySummary.latencyCoverageRate,
      latencyExcludedReasons: params.latencySummary.latencyExcludedReasons,
      latencyExcludedSymbols: params.latencySummary.latencyExcludedSymbols,
      regimeScope: regimeInfo.regimeScope,
      regimeTotalSymbols: regimeInfo.regimeTotalSymbols,
      regimeEvaluatedCount: regimeInfo.regimeEvaluatedCount,
      regimePendingCount: regimeInfo.regimePendingCount,
      regimeFailedCount: regimeInfo.regimeFailedCount,
      regimeExcludedCount: regimeInfo.regimeExcludedCount,
      regimeExcludedReasons: regimeInfo.regimeExcludedReasons,
      regimeCoverageRate: regimeInfo.regimeCoverageRate,
      regimeDenominatorSummary: regimeInfo.regimeDenominatorSummary,
      dataFreshness: {
        stale: params.dataStaleCount > 0 || baseEnv.provenance.stale,
        fallback: params.fallbackCount > 0 || baseEnv.provenance.fallback,
        missingData: baseEnv.provenance.missingData,
        isDemo: false,
        dataStaleCount: params.dataStaleCount,
        fallbackCount: params.fallbackCount,
        missingDataCount: params.missingDataCount,
        status: hasDegraded ? 'STALE_OR_DEGRADED' : 'FRESH',
      },
      sampleSufficiency: params.sampleSufficiency,
      sampleSufficiencyNotice: params.sampleSufficiencyNotice,
      latencySampleSufficiency: params.latencySummary.latencySampleSufficiency,
      performanceSampleCount: params.performanceSampleCount,
      performanceSampleSufficiency: params.performanceSampleSufficiency,
      strategyValidityNotice: '目前樣本不足，不代表策略有效或無效',
      noClosedTradesNotice:
        params.performanceSampleCount === 0
          ? '目前仍無已結算交易'
          : `目前已累積 ${params.performanceSampleCount} 筆已結算交易`,
      zeroCandidateValidNotice: '候選數為 0 不代表掃描失敗',
      identityChecks,
    };
  }

  private computeLatencySummaryForWindow(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>,
    inWindowSignals: SmcPaperQualitySignalRecord[],
    windowKey = '30d'
  ): PaperQualityLatencySummary {
    const calcPct = (arr: number[], q: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(
        arr.length - 1,
        Math.max(0, Math.ceil((q / 100) * arr.length) - 1)
      );
      return arr[idx];
    };
    const calcAvg = (arr: number[]): number | null => {
      if (arr.length === 0) return null;
      return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    };

    const latencies = inWindowSignals
      .map((s) => s.detectionLatencyMs)
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);

    const sampleCount = latencies.length;
    const latencySampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(sampleCount);
    const latencySampleNotice =
      latencySampleSufficiency === 'INSUFFICIENT'
        ? '樣本不足，僅供觀察（不得把單筆或小樣本 P50/P95 當作穩定性能結論）'
        : latencySampleSufficiency === 'LIMITED'
          ? '樣本有限 (30 <= n < 100)，樣本不足，僅供觀察'
          : '延遲樣本充足 (n >= 100)，可供分布統計參考';

    const missedCount = inWindowSignals.filter(
      (s) =>
        s.status === 'ENTRY_WINDOW_MISSED' ||
        s.entryStatus === 'ENTRY_WINDOW_MISSED'
    ).length;
    const entryWindowMissedRate =
      sampleCount > 0
        ? Number(((missedCount / sampleCount) * 100).toFixed(2))
        : 0;

    // Partition evaluated results into Fast Lane vs Bulk vs Missing Latency
    const evalResults = bundle.snap.results.filter((r) => !r.isDemo);
    const isFastLane = (r: SmcScanResultRecord) =>
      Boolean(
        r.isFastLane ||
          r.priorityClass === 'FAST_LANE' ||
          (r.priorityTier !== undefined && r.priorityTier <= 5)
      );
    const hasValidLatency = (r: SmcScanResultRecord) =>
      typeof r.detectionLatencyMs === 'number' &&
      Number.isFinite(r.detectionLatencyMs) &&
      r.detectionLatencyMs >= 0;

    const fastLaneLatencies = evalResults
      .filter((r) => isFastLane(r) && hasValidLatency(r))
      .map((r) => Number(r.detectionLatencyMs))
      .sort((a, b) => a - b);

    const bulkLatencies = evalResults
      .filter((r) => !isFastLane(r) && hasValidLatency(r))
      .map((r) => Number(r.detectionLatencyMs))
      .sort((a, b) => a - b);

    const missingLatencyRecords = evalResults.filter(
      (r) => !hasValidLatency(r)
    );
    const latencyExcludedReasons: Record<string, number> = {};
    const latencyExcludedSymbols: Array<{
      symbol: string;
      reason: string;
      windowKey: string;
    }> = [];

    const dominantResultCycleId =
      evalResults.find((r) => Boolean(r.scanCycleId))?.scanCycleId ??
      bundle.snap.scanCycleId;

    for (const r of missingLatencyRecords) {
      let reason = 'INLINE_SYMBOL_EVAL_NO_QUEUE_LATENCY';
      if (r.stale) {
        reason = 'STALE_RESULT_NO_LATENCY';
      } else if (r.fallback) {
        reason = 'FALLBACK_RESULT_NO_LATENCY';
      } else if (Array.isArray(r.missingData) && r.missingData.length > 0) {
        reason = 'MISSING_DATA_INCOMPLETE_EVAL';
      } else if (
        r.scanCycleId &&
        dominantResultCycleId &&
        r.scanCycleId !== dominantResultCycleId
      ) {
        reason = 'CARRIED_OVER_PREVIOUS_CYCLE_CACHE';
      }
      latencyExcludedReasons[reason] =
        (latencyExcludedReasons[reason] ?? 0) + 1;
      latencyExcludedSymbols.push({
        symbol: r.symbol,
        reason,
        windowKey,
      });
    }

    const fastLaneCount = fastLaneLatencies.length;
    const bulkCount = bulkLatencies.length;
    const latencySampleCount = fastLaneCount + bulkCount;
    const missingLatencySampleCount = missingLatencyRecords.length;
    const latencyEvaluatedCount = evalResults.length;
    const latencyCoverageRate =
      latencyEvaluatedCount > 0
        ? Number(((latencySampleCount / latencyEvaluatedCount) * 100).toFixed(2))
        : 100;
    const scannerLatencySampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(latencySampleCount);

    return {
      detectionLatencyP50: calcPct(latencies, 50),
      detectionLatencyP95: calcPct(latencies, 95),
      detectionLatencyAverage: calcAvg(latencies),
      sampleCount,
      latencySampleSufficiency,
      latencySampleNotice,
      entryWindowMissedCount: missedCount,
      entryWindowMissedRate,
      fastLaneCount,
      bulkCount,
      latencyEvaluatedCount,
      latencySampleCount,
      missingLatencySampleCount,
      latencyCoverageRate,
      latencyExcludedReasons,
      latencyExcludedSymbols,
      scannerLatencySampleSufficiency,
      fastLaneLatency: {
        p50:
          calcPct(fastLaneLatencies, 50) ??
          bundle.snap.priorityDetectionLatency.p50 ??
          null,
        p95:
          calcPct(fastLaneLatencies, 95) ??
          bundle.snap.priorityDetectionLatency.p95 ??
          null,
        average:
          calcAvg(fastLaneLatencies) ??
          bundle.snap.priorityDetectionLatency.avg ??
          null,
        sampleCount: fastLaneCount,
      },
      bulkLatency: {
        p50:
          calcPct(bulkLatencies, 50) ??
          bundle.snap.bulkUniverseQueueLatency.p50 ??
          null,
        p95:
          calcPct(bulkLatencies, 95) ??
          bundle.snap.bulkUniverseQueueLatency.p95 ??
          null,
        average:
          calcAvg(bulkLatencies) ??
          bundle.snap.bulkUniverseQueueLatency.avg ??
          null,
        sampleCount: bulkCount,
      },
    };
  }

  private computeCanonicalGatePassRates(
    bundle: ReturnType<RadarDatabase['computeSmcQualityBundle']>
  ): Record<string, number> {
    const r = bundle.gatePassRates;
    const oiFundingAvg = Number(
      (
        ((r['OI available'] ?? 100) +
          (r['Funding available'] ?? 100) +
          (r['Funding safety'] ?? 100)) /
        3
      ).toFixed(2)
    );
    return {
      ...r,
      'BOS/MSS': r['BOS/MSS'] ?? 0,
      'Liquidity Sweep': r['Liquidity Sweep'] ?? 0,
      Displacement: r.Displacement ?? 0,
      'FVG/Order Block': r['FVG/Order Block'] ?? 0,
      'MTF Alignment': r['MTF Alignment'] ?? 0,
      'OI/Funding': oiFundingAvg,
    };
  }

  private buildSignalLifecycleDetail(
    s: PaperTrackedSignalRecord
  ): SignalLifecycleDetail {
    const detectedAt = s.signalDetectedAt || s.evaluatedAt;
    const isBlocked =
      s.status === 'BLOCKED' ||
      s.stale ||
      s.fallback ||
      (s.missingData?.length ?? 0) > 0;
    const isEntryMissed =
      s.status === 'ENTRY_WINDOW_MISSED' ||
      s.entryStatus === 'ENTRY_WINDOW_MISSED';
    const isInvalidated = s.status === 'INVALIDATED';
    const isOpened =
      s.status === 'PAPER_OPENED' ||
      s.status === 'PAPER_CLOSED_WIN' ||
      s.status === 'PAPER_CLOSED_LOSS' ||
      s.status === 'PAPER_EXPIRED';
    const isClosed =
      s.status === 'PAPER_CLOSED_WIN' ||
      s.status === 'PAPER_CLOSED_LOSS' ||
      s.status === 'PAPER_EXPIRED';
    const isExpired = s.status === 'PAPER_EXPIRED';
    const isPending =
      !isBlocked &&
      !isEntryMissed &&
      !isInvalidated &&
      (s.status === 'CREATED' ||
        s.status === 'PENDING_NEXT_ENTRY' ||
        isOpened);

    let currentStage: SignalLifecycleStageKey;
    if (isBlocked) {
      currentStage = 'blocked';
    } else if (isExpired) {
      currentStage = 'expired';
    } else if (isClosed) {
      currentStage = 'paperClosed';
    } else if (isOpened) {
      currentStage = 'paperOpened';
    } else if (isEntryMissed) {
      currentStage = 'entryWindowMissed';
    } else if (isInvalidated) {
      currentStage = 'invalidated';
    } else if (isPending) {
      currentStage = 'entryPending';
    } else {
      currentStage = 'candidateDetected';
    }

    return {
      currentStage,
      candidateDetected: {
        reached: true,
        timestamp: detectedAt,
        detail: `偵測到 ${s.symbol} ${s.smcActionState} (${s.finalTradeSignal})`,
      },
      entryPending: {
        reached: isPending,
        timestamp: isPending
          ? s.originalEntryWindowOpenTime
            ? new Date(s.originalEntryWindowOpenTime).toISOString()
            : detectedAt
          : null,
        detail: isPending
          ? '等待下一根 K 線開盤時間窗進場'
          : isEntryMissed
            ? '未進入等待（偵測時間已錯過進場時間窗）'
            : null,
      },
      paperOpened: {
        reached: isOpened,
        timestamp: isOpened ? s.entryReferenceTime || detectedAt : null,
        detail: isOpened
          ? `Paper 進場價 ${s.entryReferencePrice ?? 'N/A'}`
          : null,
      },
      paperClosed: {
        reached: isClosed,
        timestamp: isClosed ? s.exitTime || null : null,
        detail: isClosed
          ? `結算原因=${s.statusReason ?? s.status}, resultR=${s.riskMultiple ?? 'N/A'}`
          : null,
      },
      entryWindowMissed: {
        reached: isEntryMissed,
        timestamp: isEntryMissed ? detectedAt : null,
        detail: isEntryMissed
          ? s.statusReason ||
            '偵測時間晚於下一根 K 線開盤時間窗 (ENTRY_WINDOW_MISSED)'
          : null,
      },
      invalidated: {
        reached: isInvalidated,
        timestamp: isInvalidated ? s.exitTime || detectedAt : null,
        detail: isInvalidated ? s.statusReason || '結構失效' : null,
      },
      blocked: {
        reached: isBlocked,
        timestamp: isBlocked ? detectedAt : null,
        detail: isBlocked
          ? s.statusReason || '因 stale/fallback/missingData 或安全規則攔截'
          : null,
      },
      expired: {
        reached: isExpired,
        timestamp: isExpired ? s.exitTime || null : null,
        detail: isExpired ? '持倉逾時結算 (PAPER_EXPIRED)' : null,
      },
    };
  }

  private buildSignalHistoryRecord(
    s: PaperTrackedSignalRecord,
    scanCycleCompletedAt: string | null,
    windowContext: {
      window: PaperMonitorReportWindow;
      reportAnchorAt: string;
      windowStartAt: string;
      windowEndAt: string;
      windowStartMs: number;
      windowEndMs: number;
      anchorMs: number;
    }
  ): PaperQualitySignalHistoryRecord {
    const base = this.mapPaperSignalToQualityRecord(s, scanCycleCompletedAt);
    const detectedAt = base.signalDetectedAt;
    const eventMs = Date.parse(detectedAt);

    const ms30d = 30 * 24 * 60 * 60 * 1000;
    const ms60d = 60 * 24 * 60 * 60 * 1000;
    const ms90d = 90 * 24 * 60 * 60 * 1000;

    const inCurrentWindow =
      Number.isFinite(eventMs) &&
      windowContext.windowStartMs <= eventMs &&
      eventMs < windowContext.windowEndMs;
    const in30dWindow =
      Number.isFinite(eventMs) &&
      windowContext.anchorMs - ms30d <= eventMs &&
      eventMs < windowContext.anchorMs;
    const in60dWindow =
      Number.isFinite(eventMs) &&
      windowContext.anchorMs - ms60d <= eventMs &&
      eventMs < windowContext.anchorMs;
    const in90dWindow =
      Number.isFinite(eventMs) &&
      windowContext.anchorMs - ms90d <= eventMs &&
      eventMs < windowContext.anchorMs;

    const membershipReason = inCurrentWindow
      ? `訊號時間 (${detectedAt}) 位於當前監控窗口 [${windowContext.windowStartAt}, ${windowContext.windowEndAt}) 內`
      : `訊號時間 (${detectedAt}) 位於當前監控窗口 [${windowContext.windowStartAt}, ${windowContext.windowEndAt}) 外，歸入 historicalSignalsOutsideWindow 獨立保存，不計入當期樣本統計`;

    const sampleWindowMembership: SignalWindowMembership = {
      window: windowContext.window,
      reportAnchorAt: windowContext.reportAnchorAt,
      windowStartAt: windowContext.windowStartAt,
      windowEndAt: windowContext.windowEndAt,
      inCurrentWindow,
      in30dWindow,
      in60dWindow,
      in90dWindow,
      membershipReason,
    };

    const lifecycle = this.buildSignalLifecycleDetail(s);

    return {
      ...base,
      detectedAt,
      provenance: {
        source: s.source,
        fetchedAt: detectedAt,
        stale: s.stale,
        fallback: s.fallback,
        missingData: s.missingData ?? [],
        isDemo: s.isDemo,
      },
      sampleWindowMembership,
      lifecycle,
    };
  }

  private summarizeSignalLifecycles(
    records: PaperQualitySignalHistoryRecord[]
  ): SignalLifecycleSummary {
    return {
      candidateDetected: records.filter(
        (r) => r.lifecycle.candidateDetected.reached
      ).length,
      entryPending: records.filter((r) => r.lifecycle.entryPending.reached)
        .length,
      paperOpened: records.filter((r) => r.lifecycle.paperOpened.reached)
        .length,
      paperClosed: records.filter((r) => r.lifecycle.paperClosed.reached)
        .length,
      entryWindowMissed: records.filter(
        (r) => r.lifecycle.entryWindowMissed.reached
      ).length,
      invalidated: records.filter((r) => r.lifecycle.invalidated.reached)
        .length,
      blocked: records.filter((r) => r.lifecycle.blocked.reached).length,
      expired: records.filter((r) => r.lifecycle.expired.reached).length,
    };
  }

  public getPaperQualityCycles(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: {
      window?: PaperQualityWindow;
      reportAnchorAt?: string;
    }
  ): PaperQualityCyclesResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：掃描週期明細嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const window = options?.window ?? '30d';
    const bounds = this.resolveQualityWindowBounds({
      window,
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const cycles = this.buildPaperQualityCycleDetailRecords(bundle, exchange, {
      windowStartMs: bounds.windowStartMs,
      windowEndMs: bounds.windowEndMs,
    });

    const completedScanCycles = cycles.filter(
      (c) => c.cycleStatus === 'COMPLETED'
    ).length;
    const interruptedScanCycles = cycles.length - completedScanCycles;
    const totalScanCycles = cycles.length;
    const cumulativeEvaluationEvents = cycles.reduce(
      (acc, c) => acc + c.evaluatedCount,
      0
    );

    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      [],
      window
    );
    const sampleSufficiency = PaperShadowMonitor.computeSampleSufficiency(0);
    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId: `${this.monitoringWindowId}_cycles`,
      entryWindowMissedCount: bundle.snap.entryWindowMissedCount,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: null,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
      dataStaleCount: bundle.snap.staleCount,
      fallbackCount: 0,
      missingDataCount: 0,
      sampleSufficiency,
      sampleSufficiencyNotice: '樣本不足，僅供觀察',
      latencySummary,
      performanceSampleCount: 0,
      performanceSampleSufficiency: 'INSUFFICIENT',
      isAtomicSnapshot: true,
      cumulativeEvaluationEventsOverride: cumulativeEvaluationEvents,
    });

    // If any cycle has INVALID statsConsistency, propagate INVALID
    const allCyclesValid = cycles.every(
      (c) => c.statsConsistency === 'VALID'
    );
    const statsConsistency =
      allCyclesValid && sharedEnvelope.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';

    return {
      ...sharedEnvelope,
      statsConsistency,
      totalScanCycles,
      completedScanCycles,
      interruptedScanCycles,
      cycles,
    };
  }

  public getPaperQualityCycleById(
    cycleId: string,
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: {
      reportAnchorAt?: string;
    }
  ): PaperQualitySingleCycleResponse | null {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：掃描週期明細嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window: '90d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const allCycles = this.buildPaperQualityCycleDetailRecords(
      bundle,
      exchange,
      { includeAllCycles: true }
    );
    const found = allCycles.find(
      (c) => c.cycleId === cycleId || c.scanCycleId === cycleId
    );
    if (!found) {
      return null;
    }

    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      [],
      '30d'
    );
    const sampleSufficiency = PaperShadowMonitor.computeSampleSufficiency(0);
    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId: `${this.monitoringWindowId}_cycle_${found.cycleId}`,
      entryWindowMissedCount: bundle.snap.entryWindowMissedCount,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: null,
      scanCycleCompletedAt: found.cycleCompletedAt,
      dataStaleCount: bundle.snap.staleCount,
      fallbackCount: 0,
      missingDataCount: 0,
      sampleSufficiency,
      sampleSufficiencyNotice: '樣本不足，僅供觀察',
      latencySummary,
      performanceSampleCount: 0,
      performanceSampleSufficiency: 'INSUFFICIENT',
      isAtomicSnapshot: true,
    });

    return {
      ...sharedEnvelope,
      cycleId: found.cycleId,
      scanCycleId: found.scanCycleId,
      cycleStatus: found.cycleStatus,
      cacheMode: found.cacheMode,
      cycleStartedAt: found.cycleStartedAt,
      cycleCompletedAt: found.cycleCompletedAt,
      totalSymbols: found.totalSymbols,
      evaluatedCount: found.evaluatedCount,
      pendingCount: found.pendingCount,
      failedCount: found.failedCount,
      rateLimitedCount: found.rateLimitedCount,
      waitCount: found.waitCount,
      watchCount: found.watchCount,
      highRiskCount: found.highRiskCount,
      longCandidateCount: found.longCandidateCount,
      shortCandidateCount: found.shortCandidateCount,
      statsConsistency:
        found.statsConsistency === 'VALID' &&
        sharedEnvelope.statsConsistency === 'VALID'
          ? 'VALID'
          : 'INVALID',
      cycle: found,
    };
  }

  public getPaperQualitySignalHistory(
    window: PaperMonitorReportWindow = '30d',
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string
  ): PaperQualitySignalHistoryResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：候選訊號生命週期歷史嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window,
      reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const allSavedSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        includeBlocked: true,
        limit: 5000,
      })
      .filter((s) => !s.isDemo && !s.source.toUpperCase().includes('DEMO'));

    const windowCtx = {
      window,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      windowStartMs: bounds.windowStartMs,
      windowEndMs: bounds.windowEndMs,
      anchorMs: bounds.anchorMs,
    };

    const allHistoryRecords = allSavedSignals.map((s) =>
      this.buildSignalHistoryRecord(
        s,
        bundle.snap.cycleCompletedAt,
        windowCtx
      )
    );

    const inWindowSignalHistory = allHistoryRecords.filter(
      (r) => r.sampleWindowMembership.inCurrentWindow
    );
    const historicalSignalsOutsideWindow = allHistoryRecords.filter(
      (r) => !r.sampleWindowMembership.inCurrentWindow
    );

    const lifecycleSummary = this.summarizeSignalLifecycles(
      inWindowSignalHistory
    );
    const historicalLifecycleSummary = this.summarizeSignalLifecycles(
      historicalSignalsOutsideWindow
    );

    const inWindowQualityRecords = inWindowSignalHistory.filter(
      (r) => !r.lifecycle.blocked.reached
    );
    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      inWindowQualityRecords,
      window
    );

    const sampleCount = inWindowQualityRecords.length;
    const sampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(sampleCount);
    const closedCount = lifecycleSummary.paperClosed;
    const performanceSampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(closedCount);

    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId: `${this.monitoringWindowId}_signal_history_${window}`,
      entryWindowMissedCount: lifecycleSummary.entryWindowMissed,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt:
        inWindowQualityRecords.length > 0
          ? inWindowQualityRecords[0].signalDetectedAt
          : null,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
      dataStaleCount: bundle.snap.staleCount,
      fallbackCount: 0,
      missingDataCount: 0,
      sampleSufficiency,
      sampleSufficiencyNotice:
        sampleSufficiency !== 'SUFFICIENT'
          ? '樣本不足，僅供觀察'
          : '樣本充足 (n >= 100)，可供統計觀察',
      latencySummary,
      performanceSampleCount: closedCount,
      performanceSampleSufficiency,
      isAtomicSnapshot: true,
    });

    return {
      ...sharedEnvelope,
      window,
      totalTrackedRecords: allHistoryRecords.length,
      inWindowCount: inWindowSignalHistory.length,
      outsideWindowCount: historicalSignalsOutsideWindow.length,
      lifecycleSummary,
      historicalLifecycleSummary,
      signalHistory: inWindowSignalHistory,
      historicalSignalsOutsideWindowCount:
        historicalSignalsOutsideWindow.length,
      historicalSignalsOutsideWindow,
    };
  }

  public getPaperQualityReport(
    window: PaperQualityWindow = '30d',
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string,
    options?: {
      isAtomicSnapshot?: boolean;
      aggregationMode?: EvaluationAggregationMode;
    }
  ): PaperQualityWindowReportResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：長期 Paper 品質監控嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const isAtomicSnapshot = options?.isAtomicSnapshot ?? false;
    const bounds = this.resolveQualityWindowBounds({
      window,
      reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.syncEvaluatedCandidatesToOutcomeTracker(exchange);
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const baseOutcomeReport = this.outcomeTracker.buildWindowReport({
      window,
      exchange,
      monitorRunId: this.monitorRunId,
      scanRunId: bundle.snap.scanRunId,
      sinceIso: bounds.windowStartAt,
      untilIso: bounds.windowEndAt,
      reportAnchorAt: bounds.reportAnchorAt,
      nowMs: bounds.generatedAtMs,
    });

    const windowCtx = {
      window,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      windowStartMs: bounds.windowStartMs,
      windowEndMs: bounds.windowEndMs,
      anchorMs: bounds.anchorMs,
    };

    // Strict half-open time filtering: windowStartAt <= eventTime < windowEndAt
    const allSavedSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        includeBlocked: true,
        limit: 5000,
      })
      .filter((s) => !s.isDemo && !s.source.toUpperCase().includes('DEMO'));

    const inWindowAllSignals: PaperTrackedSignalRecord[] = [];
    const outsideWindowAllSignals: PaperTrackedSignalRecord[] = [];
    for (const s of allSavedSignals) {
      const eventMs = Date.parse(s.signalDetectedAt || s.evaluatedAt);
      if (
        Number.isFinite(eventMs) &&
        bounds.windowStartMs <= eventMs &&
        eventMs < bounds.windowEndMs
      ) {
        inWindowAllSignals.push(s);
      } else {
        outsideWindowAllSignals.push(s);
      }
    }

    const isValidTradableCandidate = (s: PaperTrackedSignalRecord) =>
      s.status !== 'BLOCKED' &&
      s.smcEvaluationStatus === 'EVALUATED' &&
      (s.smcActionState === 'LONG CANDIDATE' ||
        s.smcActionState === 'SHORT CANDIDATE') &&
      s.finalTradeSignal !== 'NONE' &&
      !s.stale &&
      !s.fallback &&
      !s.isDemo &&
      (s.missingData?.length ?? 0) === 0 &&
      (s.waitReasons?.length ?? 0) === 0;

    const validInWindowSignals = inWindowAllSignals.filter(
      isValidTradableCandidate
    );
    const historicalOutsideSignals = outsideWindowAllSignals
      .filter(isValidTradableCandidate)
      .map((s) =>
        this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
      );

    const blockedInWindow = inWindowAllSignals.filter(
      (s) =>
        s.status === 'BLOCKED' ||
        s.stale ||
        s.fallback ||
        (s.missingData?.length ?? 0) > 0
    );

    const mappedSignals = validInWindowSignals.map((s) =>
      this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
    );

    const inWindowHistoryRecords = inWindowAllSignals.map((s) =>
      this.buildSignalHistoryRecord(s, bundle.snap.cycleCompletedAt, windowCtx)
    );
    const lifecycleSummary = this.summarizeSignalLifecycles(
      inWindowHistoryRecords
    );

    const totalSignals = mappedSignals.length;
    const longSignals = mappedSignals.filter(
      (s) => s.direction === 'LONG'
    ).length;
    const shortSignals = mappedSignals.filter(
      (s) => s.direction === 'SHORT'
    ).length;
    const openSignals = mappedSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const openTrades = mappedSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;
    const paperOpened = mappedSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;
    const wins = mappedSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_WIN'
    ).length;
    const losses = mappedSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_LOSS'
    ).length;
    const expired = mappedSignals.filter(
      (s) => s.status === 'PAPER_EXPIRED'
    ).length;
    const paperClosed = wins + losses + expired;
    const invalidated = mappedSignals.filter(
      (s) => s.status === 'INVALIDATED'
    ).length;
    const entryWindowMissed = mappedSignals.filter(
      (s) =>
        s.status === 'ENTRY_WINDOW_MISSED' ||
        s.entryStatus === 'ENTRY_WINDOW_MISSED'
    ).length;

    // Build full scan cycle details in [windowStartAt, windowEndAt)
    const cycles = this.buildPaperQualityCycleDetailRecords(bundle, exchange, {
      windowStartMs: bounds.windowStartMs,
      windowEndMs: bounds.windowEndMs,
    });
    const completedScanCycles = cycles.filter(
      (c) => c.cycleStatus === 'COMPLETED'
    ).length;
    const interruptedScanCycles = cycles.length - completedScanCycles;
    const totalScanCycles = cycles.length;

    const currentSnapMs = Date.parse(
      bundle.snap.cycleCompletedAt || bundle.snap.snapshotAt
    );
    const isCurrentSnapInWindow =
      Number.isFinite(currentSnapMs) &&
      bounds.windowStartMs <= currentSnapMs &&
      currentSnapMs < bounds.windowEndMs;

    const windowCycleSnapshots =
      this.paperMonitorDb.listMonitoringWindowCyclesByTimeRange({
        sinceIso: bounds.windowStartAt,
        untilIso: bounds.windowEndAt,
      });

    const currentStaleResults = bundle.snap.results.filter(
      (r) => r.stale
    ).length;
    const currentFallbackResults = bundle.snap.results.filter(
      (r) => r.fallback
    ).length;
    const currentMissingDataResults = bundle.snap.results.filter(
      (r) => Array.isArray(r.missingData) && r.missingData.length > 0
    ).length;

    const dataStaleCount =
      (isCurrentSnapInWindow ? currentStaleResults : 0) +
      inWindowAllSignals.filter((s) => s.stale).length +
      windowCycleSnapshots.reduce((acc, c) => acc + c.staleCount, 0);
    const fallbackCount =
      (isCurrentSnapInWindow ? currentFallbackResults : 0) +
      inWindowAllSignals.filter((s) => s.fallback).length +
      windowCycleSnapshots.reduce((acc, c) => acc + c.fallbackCount, 0);
    const missingDataCount =
      (isCurrentSnapInWindow ? currentMissingDataResults : 0) +
      inWindowAllSignals.filter((s) => (s.missingData?.length ?? 0) > 0)
        .length +
      windowCycleSnapshots.reduce((acc, c) => acc + c.missingDataCount, 0);

    // Metric status & performance statistics
    const hasClosedTrades = paperClosed > 0;
    let metricStatus: PaperMetricStatus;
    if (hasClosedTrades) {
      metricStatus = 'READY';
    } else if (totalSignals === 0) {
      metricStatus = 'NO_TRADES';
    } else if (paperOpened > 0) {
      metricStatus = 'OPEN_TRADES_NO_CLOSED_RESULTS';
    } else if (openSignals > 0) {
      metricStatus = 'SIGNALS_PENDING_ENTRY';
    } else if (entryWindowMissed > 0) {
      metricStatus = 'ENTRY_WINDOW_MISSED';
    } else {
      metricStatus = 'SIGNALS_PENDING_ENTRY';
    }

    const sampleCount = totalSignals;
    const closedSampleCount = paperClosed;
    const sampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(sampleCount);
    const performanceSampleCount = closedSampleCount;
    const performanceSampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(performanceSampleCount);
    const sampleSufficiencyNotice =
      sampleSufficiency !== 'SUFFICIENT'
        ? '樣本不足，僅供觀察'
        : '樣本充足 (n >= 100)，可供統計觀察';
    const strategyValidityNotice = '目前樣本不足，不代表策略有效或無效';

    const winRate = hasClosedTrades ? baseOutcomeReport.winRate : null;
    const averageR = hasClosedTrades ? baseOutcomeReport.averageR : null;
    const profitFactor = hasClosedTrades
      ? baseOutcomeReport.profitFactor
      : null;
    const maxDrawdownR = hasClosedTrades
      ? baseOutcomeReport.maxDrawdownR
      : null;
    const expectancyR = hasClosedTrades ? baseOutcomeReport.expectancyR : null;
    const averageHoldingTime = hasClosedTrades
      ? baseOutcomeReport.averageHoldingTime
      : null;

    const totalEval = Math.max(1, bundle.snap.evaluatedCount);
    const waitWatchHighRiskRatios = {
      waitCount: bundle.snap.waitCount,
      watchCount: bundle.snap.watchCount,
      highRiskCount: bundle.snap.highRiskCount,
      longCandidateCount: bundle.snap.longCandidateCount,
      shortCandidateCount: bundle.snap.shortCandidateCount,
      waitRatioPercent: Number(
        ((bundle.snap.waitCount / totalEval) * 100).toFixed(2)
      ),
      watchRatioPercent: Number(
        ((bundle.snap.watchCount / totalEval) * 100).toFixed(2)
      ),
      highRiskRatioPercent: Number(
        ((bundle.snap.highRiskCount / totalEval) * 100).toFixed(2)
      ),
      longCandidateRatioPercent: Number(
        ((bundle.snap.longCandidateCount / totalEval) * 100).toFixed(2)
      ),
      shortCandidateRatioPercent: Number(
        ((bundle.snap.shortCandidateCount / totalEval) * 100).toFixed(2)
      ),
    };

    const gatePassRates = this.computeCanonicalGatePassRates(bundle);
    const driftResp = this.getPaperQualityGateDrift(
      exchange,
      bounds.generatedAtMs,
      {
        reportAnchorAt: bounds.reportAnchorAt,
        isAtomicSnapshot,
      }
    );
    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      mappedSignals,
      window
    );

    const cumulativeEvaluationEvents = Math.max(
      bundle.snap.evaluatedCount,
      cycles.reduce((acc, c) => acc + c.evaluatedCount, 0)
    );

    const monitoringWindowId = `${this.monitoringWindowId}_${window}`;
    const latestSignalDetectedAt =
      mappedSignals.length > 0 ? mappedSignals[0].signalDetectedAt : null;

    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId,
      entryWindowMissedCount: entryWindowMissed,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt: latestSignalDetectedAt,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
      dataStaleCount,
      fallbackCount,
      missingDataCount,
      sampleSufficiency,
      sampleSufficiencyNotice,
      latencySummary,
      performanceSampleCount,
      performanceSampleSufficiency,
      isAtomicSnapshot,
      aggregationMode: options?.aggregationMode,
      cumulativeEvaluationEventsOverride: cumulativeEvaluationEvents,
    });

    // Latest Cycle signals vs Deduped vs Cumulative
    const latestCycleId = bundle.snap.scanCycleId;
    const latestCycleSignals = mappedSignals.filter(
      (s) => s.scanCycleId === latestCycleId
    );
    const latestCycleBlocked = blockedInWindow.filter(
      (s) => s.scanCycleId === latestCycleId
    );

    const latestCycleStats: PaperQualityLatestCycleBreakdown = {
      evaluationAggregationMode: 'LATEST_CYCLE',
      cycleId: bundle.snap.scanCycleId,
      cycleStatus: sharedEnvelope.cycleStatus,
      latestCycleEvaluatedCount: sharedEnvelope.latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols: sharedEnvelope.uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents: sharedEnvelope.cumulativeEvaluationEvents,
      evaluationUniverseSize: sharedEnvelope.evaluationUniverseSize,
      evaluationExcludedCount: sharedEnvelope.evaluationExcludedCount,
      excludedSymbols: sharedEnvelope.excludedSymbols,
      evaluationExcludedReasons: sharedEnvelope.evaluationExcludedReasons,
      waitCount: sharedEnvelope.waitCount,
      watchCount: sharedEnvelope.watchCount,
      highRiskCount: sharedEnvelope.highRiskCount,
      longCandidateCount: sharedEnvelope.longCandidateCount,
      shortCandidateCount: sharedEnvelope.shortCandidateCount,
      totalSignals: latestCycleSignals.length,
      longSignals: latestCycleSignals.filter((s) => s.direction === 'LONG')
        .length,
      shortSignals: latestCycleSignals.filter((s) => s.direction === 'SHORT')
        .length,
      paperOpened: latestCycleSignals.filter(
        (s) =>
          s.status === 'PAPER_OPENED' ||
          s.status === 'PAPER_CLOSED_WIN' ||
          s.status === 'PAPER_CLOSED_LOSS' ||
          s.status === 'PAPER_EXPIRED'
      ).length,
      paperClosed: latestCycleSignals.filter(
        (s) =>
          s.status === 'PAPER_CLOSED_WIN' ||
          s.status === 'PAPER_CLOSED_LOSS' ||
          s.status === 'PAPER_EXPIRED'
      ).length,
      entryWindowMissed: latestCycleSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length,
      invalidated: latestCycleSignals.filter(
        (s) => s.status === 'INVALIDATED'
      ).length,
      blocked: latestCycleBlocked.length,
    };

    const dedupedBySymbol = new Map<string, SmcPaperQualitySignalRecord>();
    for (const s of mappedSignals) {
      if (!dedupedBySymbol.has(s.symbol)) {
        dedupedBySymbol.set(s.symbol, s);
      }
    }
    const dedupedSignals = Array.from(dedupedBySymbol.values());

    const dedupedSymbolStats: PaperQualityDedupedSymbolsBreakdown = {
      evaluationAggregationMode: 'DEDUPED_SYMBOLS',
      latestCycleEvaluatedCount: sharedEnvelope.latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols: sharedEnvelope.uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents: sharedEnvelope.cumulativeEvaluationEvents,
      evaluationUniverseSize: sharedEnvelope.evaluationUniverseSize,
      evaluationExcludedCount: sharedEnvelope.evaluationExcludedCount,
      excludedSymbols: sharedEnvelope.excludedSymbols,
      evaluationExcludedReasons: sharedEnvelope.evaluationExcludedReasons,
      waitCount: sharedEnvelope.waitCount,
      watchCount: sharedEnvelope.watchCount,
      highRiskCount: sharedEnvelope.highRiskCount,
      longCandidateCount: sharedEnvelope.longCandidateCount,
      shortCandidateCount: sharedEnvelope.shortCandidateCount,
      totalSignals: dedupedSignals.length,
      longSignals: dedupedSignals.filter((s) => s.direction === 'LONG').length,
      shortSignals: dedupedSignals.filter((s) => s.direction === 'SHORT')
        .length,
      paperOpened: dedupedSignals.filter(
        (s) =>
          s.status === 'PAPER_OPENED' ||
          s.status === 'PAPER_CLOSED_WIN' ||
          s.status === 'PAPER_CLOSED_LOSS' ||
          s.status === 'PAPER_EXPIRED'
      ).length,
      paperClosed: dedupedSignals.filter(
        (s) =>
          s.status === 'PAPER_CLOSED_WIN' ||
          s.status === 'PAPER_CLOSED_LOSS' ||
          s.status === 'PAPER_EXPIRED'
      ).length,
      entryWindowMissed: dedupedSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length,
      invalidated: dedupedSignals.filter((s) => s.status === 'INVALIDATED')
        .length,
      blocked: new Set(blockedInWindow.map((b) => b.symbol)).size,
    };

    const cumulativeEventStats: PaperQualityCumulativeEventsBreakdown = {
      evaluationAggregationMode: 'CUMULATIVE_EVENTS',
      totalScanCycles,
      completedScanCycles,
      interruptedScanCycles,
      latestCycleEvaluatedCount: sharedEnvelope.latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols: sharedEnvelope.uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents: sharedEnvelope.cumulativeEvaluationEvents,
      evaluationUniverseSize: sharedEnvelope.evaluationUniverseSize,
      evaluationExcludedCount: sharedEnvelope.evaluationExcludedCount,
      excludedSymbols: sharedEnvelope.excludedSymbols,
      evaluationExcludedReasons: sharedEnvelope.evaluationExcludedReasons,
      waitCount: cycles.reduce((acc, c) => acc + c.waitCount, 0),
      watchCount: cycles.reduce((acc, c) => acc + c.watchCount, 0),
      highRiskCount: cycles.reduce((acc, c) => acc + c.highRiskCount, 0),
      longCandidateCount: cycles.reduce(
        (acc, c) => acc + c.longCandidateCount,
        0
      ),
      shortCandidateCount: cycles.reduce(
        (acc, c) => acc + c.shortCandidateCount,
        0
      ),
      totalSignals,
      longSignals,
      shortSignals,
      paperOpened,
      paperClosed,
      entryWindowMissed,
      invalidated,
      blocked: blockedInWindow.length,
    };

    return {
      ...sharedEnvelope,
      window,
      monitoringWindowId,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      isAtomicSnapshot,
      totalScanCycles,
      completedScanCycles,
      interruptedScanCycles,
      totalEvaluated: sharedEnvelope.totalEvaluated,
      evaluatedCount: sharedEnvelope.evaluatedCount,
      latestCycleEvaluatedCount: sharedEnvelope.latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols: sharedEnvelope.uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents: sharedEnvelope.cumulativeEvaluationEvents,
      evaluationAggregationMode: sharedEnvelope.evaluationAggregationMode,
      evaluationUniverseSize: sharedEnvelope.evaluationUniverseSize,
      evaluationExcludedCount: sharedEnvelope.evaluationExcludedCount,
      excludedSymbols: sharedEnvelope.excludedSymbols,
      evaluationExcludedReasons: sharedEnvelope.evaluationExcludedReasons,
      pendingCount: sharedEnvelope.pendingCount,
      failedCount: sharedEnvelope.failedCount,
      rateLimitedCount: sharedEnvelope.rateLimitedCount,
      dataStaleCount,
      fallbackCount,
      missingDataCount,
      totalSignals,
      longSignals,
      shortSignals,
      paperOpened,
      paperClosed,
      entryWindowMissed,
      invalidated,
      blocked: blockedInWindow.length,
      wins,
      losses,
      expired,
      openSignals,
      openTrades,
      metricStatus,
      sampleCount,
      closedSampleCount,
      sampleSufficiency,
      sampleSufficiencyNotice,
      latencySampleCount: sharedEnvelope.latencySampleCount,
      latencySampleSufficiency: sharedEnvelope.latencySampleSufficiency,
      performanceSampleCount,
      performanceSampleSufficiency,
      strategyValidityNotice,
      noClosedTradesNotice: sharedEnvelope.noClosedTradesNotice,
      zeroCandidateValidNotice: sharedEnvelope.zeroCandidateValidNotice,
      winRate,
      averageR,
      profitFactor,
      maxDrawdownR,
      expectancyR,
      averageHoldingTime,
      latestCycleStats,
      dedupedSymbolStats,
      cumulativeEventStats,
      lifecycleSummary,
      cycles,
      waitWatchHighRiskRatios,
      gatePassRates,
      gateDriftStatus: driftResp.driftStatus,
      latencySummary,
      signals: mappedSignals,
      historicalSignalsOutsideWindowCount: historicalOutsideSignals.length,
      historicalSignalsOutsideWindow: historicalOutsideSignals,
    };
  }

  public getPaperQualityStatus(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string,
    options?: {
      aggregationMode?: EvaluationAggregationMode;
    }
  ): PaperQualityStatusResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：長期 Paper 品質狀態嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const unifiedBounds = this.resolveQualityWindowBounds({
      window: '30d',
      reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    const sharedNowMs = unifiedBounds.generatedAtMs;
    const sharedAnchorAt = unifiedBounds.reportAnchorAt;

    const report30d = this.getPaperQualityReport(
      '30d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true, aggregationMode: options?.aggregationMode }
    );
    const report60d = this.getPaperQualityReport(
      '60d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true, aggregationMode: options?.aggregationMode }
    );
    const report90d = this.getPaperQualityReport(
      '90d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true, aggregationMode: options?.aggregationMode }
    );

    const toSummary = (
      rep: PaperQualityWindowReportResponse
    ): PaperQualityWindowSummary => ({
      window: rep.window,
      monitoringWindowId: rep.monitoringWindowId,
      reportGeneratedAt: rep.reportGeneratedAt,
      reportAnchorAt: rep.reportAnchorAt,
      windowStartAt: rep.windowStartAt,
      windowEndAt: rep.windowEndAt,
      isAtomicSnapshot: true,
      totalScanCycles: rep.totalScanCycles,
      completedScanCycles: rep.completedScanCycles,
      interruptedScanCycles: rep.interruptedScanCycles,
      totalEvaluated: rep.totalEvaluated,
      evaluatedCount: rep.evaluatedCount,
      latestCycleEvaluatedCount: rep.latestCycleEvaluatedCount,
      uniqueEvaluatedSymbols: rep.uniqueEvaluatedSymbols,
      cumulativeEvaluationEvents: rep.cumulativeEvaluationEvents,
      evaluationAggregationMode: rep.evaluationAggregationMode,
      evaluationUniverseSize: rep.evaluationUniverseSize,
      evaluationExcludedCount: rep.evaluationExcludedCount,
      excludedSymbols: rep.excludedSymbols,
      evaluationExcludedReasons: rep.evaluationExcludedReasons,
      pendingCount: rep.pendingCount,
      failedCount: rep.failedCount,
      rateLimitedCount: rep.rateLimitedCount,
      dataStaleCount: rep.dataStaleCount,
      fallbackCount: rep.fallbackCount,
      missingDataCount: rep.missingDataCount,
      totalSignals: rep.totalSignals,
      longSignals: rep.longSignals,
      shortSignals: rep.shortSignals,
      paperOpened: rep.paperOpened,
      paperClosed: rep.paperClosed,
      entryWindowMissed: rep.entryWindowMissed,
      invalidated: rep.invalidated,
      blocked: rep.blocked,
      wins: rep.wins,
      losses: rep.losses,
      expired: rep.expired,
      openSignals: rep.openSignals,
      openTrades: rep.openTrades,
      metricStatus: rep.metricStatus,
      sampleCount: rep.sampleCount,
      closedSampleCount: rep.closedSampleCount,
      sampleSufficiency: rep.sampleSufficiency,
      sampleSufficiencyNotice: rep.sampleSufficiencyNotice,
      latencySampleCount: rep.latencySampleCount,
      latencySampleSufficiency: rep.latencySampleSufficiency,
      performanceSampleCount: rep.performanceSampleCount,
      performanceSampleSufficiency: rep.performanceSampleSufficiency,
      strategyValidityNotice: rep.strategyValidityNotice,
      noClosedTradesNotice: rep.noClosedTradesNotice,
      zeroCandidateValidNotice: rep.zeroCandidateValidNotice,
      winRate: rep.winRate,
      averageR: rep.averageR,
      profitFactor: rep.profitFactor,
      maxDrawdownR: rep.maxDrawdownR,
      expectancyR: rep.expectancyR,
      averageHoldingTime: rep.averageHoldingTime,
      latestCycleStats: rep.latestCycleStats,
      dedupedSymbolStats: rep.dedupedSymbolStats,
      cumulativeEventStats: rep.cumulativeEventStats,
      lifecycleSummary: rep.lifecycleSummary,
    });

    const diag = this.radarDb.computeCycleDiagnosticsAndFunnel(exchange);

    return {
      ...report30d,
      monitoringWindowId: this.monitoringWindowId,
      isAtomicSnapshot: true,
      queryMode: 'ATOMIC_UNIFIED_SNAPSHOT',
      atomicSnapshotNotice:
        '同一份 30d/60d/90d 原子快照（共用相同 reportAnchorAt、windowEndAt、snapshotAt 與 statsVersion）',
      windows: {
        '30d': toSummary(report30d),
        '60d': toSummary(report60d),
        '90d': toSummary(report90d),
      },
      latestCycleStats: report30d.latestCycleStats,
      dedupedSymbolStats: report30d.dedupedSymbolStats,
      cumulativeEventStats: report30d.cumulativeEventStats,
      lifecycleSummary: report30d.lifecycleSummary,
      recentCycles: report30d.cycles,
      waitWatchHighRiskRatios: report30d.waitWatchHighRiskRatios,
      gatePassRates: report30d.gatePassRates,
      gateDriftStatus: report30d.gateDriftStatus,
      latencySummary: report30d.latencySummary,
      lastUpdatedAt: report30d.snapshotAt,
      candidateFunnel: diag.candidateFunnel,
      smcGateDiagnostics: diag.smcGateDiagnostics,
      paperEligibilityAudit: diag.paperEligibilityAudit,
      nearMissCount: diag.nearMissCount,
      nearMissMissing1Count: diag.nearMissMissing1Count,
      nearMissMissing2Count: diag.nearMissMissing2Count,
      nearMissMissingGates: diag.nearMissMissingGates,
      lastBlockingGate: diag.lastBlockingGate,
      blockedAfterSmcCandidateCount: diag.blockedAfterSmcCandidateCount,
      blockedAfterSmcCandidateReasons: diag.blockedAfterSmcCandidateReasons,
      blockedByPaperEligibilityCount: diag.blockedByPaperEligibilityCount,
      blockedByPaperEligibilityReasons: diag.blockedByPaperEligibilityReasons,
      rootCauseVerdict: diag.rootCauseVerdict,
      rootCauseExplanation: diag.rootCauseExplanation,
    };
  }

  public getPaperQualityGateDrift(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    options?: {
      reportAnchorAt?: string;
      driftThresholdPercent?: number;
      isAtomicSnapshot?: boolean;
    }
  ): PaperQualityGateDriftResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：Gate 穩定度與漂移監控嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const bounds30d = this.resolveQualityWindowBounds({
      window: '30d',
      reportAnchorAt: options?.reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds30d.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds30d.anchorMs
    );
    const driftThresholdPercent = options?.driftThresholdPercent ?? 20;

    const totalEval = Math.max(1, bundle.snap.evaluatedCount);
    const canonicalRates = this.computeCanonicalGatePassRates(bundle);
    const currentGatePassRates = {
      'BOS/MSS': canonicalRates['BOS/MSS'] ?? 0,
      'Liquidity Sweep': canonicalRates['Liquidity Sweep'] ?? 0,
      Displacement: canonicalRates.Displacement ?? 0,
      'FVG/Order Block': canonicalRates['FVG/Order Block'] ?? 0,
      'MTF Alignment': canonicalRates['MTF Alignment'] ?? 0,
      'OI/Funding': canonicalRates['OI/Funding'] ?? 0,
      waitRatioPercent: Number(
        ((bundle.snap.waitCount / totalEval) * 100).toFixed(2)
      ),
      watchRatioPercent: Number(
        ((bundle.snap.watchCount / totalEval) * 100).toFixed(2)
      ),
      highRiskRatioPercent: Number(
        ((bundle.snap.highRiskCount / totalEval) * 100).toFixed(2)
      ),
      longCandidateRatioPercent: Number(
        ((bundle.snap.longCandidateCount / totalEval) * 100).toFixed(2)
      ),
      shortCandidateRatioPercent: Number(
        ((bundle.snap.shortCandidateCount / totalEval) * 100).toFixed(2)
      ),
    };

    const allCycleDetails = this.buildPaperQualityCycleDetailRecords(
      bundle,
      exchange,
      { includeAllCycles: true }
    );

    const computeCycleSetMetrics = (
      cycles: PaperQualityCycleDetailRecord[]
    ): Record<string, number> => {
      if (cycles.length === 0) {
        return {
          'BOS/MSS': currentGatePassRates['BOS/MSS'],
          'Liquidity Sweep': currentGatePassRates['Liquidity Sweep'],
          Displacement: currentGatePassRates.Displacement,
          'FVG/Order Block': currentGatePassRates['FVG/Order Block'],
          'MTF Alignment': currentGatePassRates['MTF Alignment'],
          'OI/Funding': currentGatePassRates['OI/Funding'],
          waitRatioPercent: currentGatePassRates.waitRatioPercent,
          watchRatioPercent: currentGatePassRates.watchRatioPercent,
          highRiskRatioPercent: currentGatePassRates.highRiskRatioPercent,
          longCandidateRatioPercent:
            currentGatePassRates.longCandidateRatioPercent,
          shortCandidateRatioPercent:
            currentGatePassRates.shortCandidateRatioPercent,
        };
      }

      const avgGate = (key: string): number => {
        const vals = cycles
          .map((c) => c.gateStats[key]?.passRate)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (vals.length === 0) {
          return Number((canonicalRates[key] ?? 0).toFixed(2));
        }
        return Number(
          (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
        );
      };

      const totalEvalAcrossCycles = Math.max(
        1,
        cycles.reduce((acc, c) => acc + Math.max(1, c.evaluatedCount), 0)
      );
      const sumWait = cycles.reduce((acc, c) => acc + c.waitCount, 0);
      const sumWatch = cycles.reduce((acc, c) => acc + c.watchCount, 0);
      const sumHighRisk = cycles.reduce((acc, c) => acc + c.highRiskCount, 0);
      const sumLongCand = cycles.reduce(
        (acc, c) => acc + c.longCandidateCount,
        0
      );
      const sumShortCand = cycles.reduce(
        (acc, c) => acc + c.shortCandidateCount,
        0
      );

      return {
        'BOS/MSS': avgGate('BOS/MSS'),
        'Liquidity Sweep': avgGate('Liquidity Sweep'),
        Displacement: avgGate('Displacement'),
        'FVG/Order Block': avgGate('FVG/Order Block'),
        'MTF Alignment': avgGate('MTF Alignment'),
        'OI/Funding': avgGate('OI/Funding'),
        waitRatioPercent: Number(
          ((sumWait / totalEvalAcrossCycles) * 100).toFixed(2)
        ),
        watchRatioPercent: Number(
          ((sumWatch / totalEvalAcrossCycles) * 100).toFixed(2)
        ),
        highRiskRatioPercent: Number(
          ((sumHighRisk / totalEvalAcrossCycles) * 100).toFixed(2)
        ),
        longCandidateRatioPercent: Number(
          ((sumLongCand / totalEvalAcrossCycles) * 100).toFixed(2)
        ),
        shortCandidateRatioPercent: Number(
          ((sumShortCand / totalEvalAcrossCycles) * 100).toFixed(2)
        ),
      };
    };

    const getCyclesForWindow = (
      win: PaperMonitorReportWindow
    ): PaperQualityCycleDetailRecord[] => {
      const b = this.resolveQualityWindowBounds({
        window: win,
        reportAnchorAt: bounds30d.reportAnchorAt,
        nowMs: bounds30d.generatedAtMs,
        exchange,
      });
      return allCycleDetails.filter((c) => {
        const t = Date.parse(c.cycleCompletedAt || c.cycleStartedAt);
        return (
          Number.isFinite(t) && b.windowStartMs <= t && t < b.windowEndMs
        );
      });
    };

    const metricLabels: Array<{ key: string; label: string }> = [
      { key: 'BOS/MSS', label: 'BOS/MSS 結構確認通過率' },
      { key: 'Liquidity Sweep', label: 'Liquidity Sweep 流動性掃蕩通過率' },
      { key: 'Displacement', label: 'Displacement 位移K線通過率' },
      { key: 'FVG/Order Block', label: 'FVG / Order Block 結構區通過率' },
      { key: 'MTF Alignment', label: 'MTF 多時框一致性通過率' },
      { key: 'OI/Funding', label: 'OI / Funding 衍生品健康通過率' },
      { key: 'waitRatioPercent', label: 'WAIT 觀望比例' },
      { key: 'watchRatioPercent', label: 'WATCH 觀察比例' },
      { key: 'highRiskRatioPercent', label: 'HIGH RISK 高風險比例' },
      { key: 'longCandidateRatioPercent', label: 'LONG CANDIDATE 候選比例' },
      { key: 'shortCandidateRatioPercent', label: 'SHORT CANDIDATE 候選比例' },
    ];

    const buildComparisonFromCycleSets = (params: {
      pair: GateDriftComparisonPair;
      shortWindowLabel: PaperMonitorReportWindow | 'latest_cycle';
      longWindowLabel: PaperMonitorReportWindow | 'previous_cycle';
      shortCycles: PaperQualityCycleDetailRecord[];
      longCycles: PaperQualityCycleDetailRecord[];
      shortCountReport: number;
      longCountReport: number;
    }): GateDriftWindowComparison => {
      const {
        pair,
        shortWindowLabel,
        longWindowLabel,
        shortCycles,
        longCycles,
        shortCountReport,
        longCountReport,
      } = params;

      const shortDenom =
        shortCycles.length > 0
          ? shortCycles[shortCycles.length - 1].evaluatedCount
          : bundle.snap.evaluatedCount;
      const longDenom =
        longCycles.length > 0
          ? longCycles[longCycles.length - 1].evaluatedCount
          : bundle.snap.evaluatedCount;

      const allShortDenomsSame = shortCycles.every(
        (c) => c.evaluatedCount === shortDenom
      );
      const allLongDenomsSame = longCycles.every(
        (c) => c.evaluatedCount === longDenom
      );

      let comparisonAllowed = true;
      let comparisonReason: GateComparisonReason =
        'SAME_DENOMINATOR_COMPARABLE';

      if (shortCycles.length === 0 || longCycles.length === 0) {
        comparisonAllowed = false;
        comparisonReason = 'INSUFFICIENT_CYCLES';
      } else if (
        shortDenom !== longDenom ||
        !allShortDenomsSame ||
        !allLongDenomsSame
      ) {
        comparisonAllowed = false;
        comparisonReason = 'DENOMINATOR_MISMATCH';
      }

      const effectiveShortDenom = !allShortDenomsSame
        ? shortCycles[shortCycles.length - 1].evaluatedCount
        : shortDenom;
      const effectiveLongDenom = !allLongDenomsSame
        ? longCycles[0].evaluatedCount
        : longDenom;

      const shortAgg = computeCycleSetMetrics(shortCycles);
      const longAgg = computeCycleSetMetrics(longCycles);

      const metrics: GateDriftMetricComparison[] = metricLabels.map(
        ({ key, label }) => {
          const sRate = Number((shortAgg[key] ?? 0).toFixed(2));
          const lRate = Number((longAgg[key] ?? 0).toFixed(2));
          const deltaPercent = Number((sRate - lRate).toFixed(2));
          const absDeltaPercent = Number(Math.abs(deltaPercent).toFixed(2));
          const driftDetected =
            comparisonAllowed && absDeltaPercent >= driftThresholdPercent;
          return {
            metricKey: key,
            label,
            shortWindowRate: sRate,
            longWindowRate: lRate,
            deltaPercent,
            absDeltaPercent,
            driftThresholdPercent,
            driftDetected,
            driftStatus: driftDetected ? 'QUALITY_DRIFT_SUSPECTED' : 'STABLE',
            shortEvaluatedDenominator: effectiveShortDenom,
            longEvaluatedDenominator: effectiveLongDenom,
            comparisonAllowed,
            comparisonReason,
          };
        }
      );

      const suspectedMetrics = metrics
        .filter((m) => m.driftDetected)
        .map((m) => m.metricKey);
      const driftStatus: GateDriftStatus =
        comparisonAllowed && suspectedMetrics.length > 0
          ? 'QUALITY_DRIFT_SUSPECTED'
          : 'STABLE';

      const notice =
        comparisonReason === 'DENOMINATOR_MISMATCH'
          ? `評估分母不一致 (${effectiveShortDenom} 檔 vs ${effectiveLongDenom} 檔)，標記 DENOMINATOR_MISMATCH；不得直接把不同分母週期的比率當作同分母比較`
          : comparisonReason === 'INSUFFICIENT_CYCLES'
            ? '歷史週期不足，暫無法進行跨週期同分母比較'
            : driftStatus === 'QUALITY_DRIFT_SUSPECTED'
              ? `偵測到 Gate 通過率或候選比例異常變化 (${suspectedMetrics.join(', ')})，標記 QUALITY_DRIFT_SUSPECTED；嚴禁自動調整門檻或放寬 SMC/ICT Gate`
              : 'Gate 通過率與候選比例穩定（同分母比較通過），未偵測到異常漂移';

      return {
        pair,
        shortWindow: shortWindowLabel,
        longWindow: longWindowLabel,
        shortWindowCycleCount: shortCountReport,
        longWindowCycleCount: longCountReport,
        shortEvaluatedDenominator: effectiveShortDenom,
        longEvaluatedDenominator: effectiveLongDenom,
        comparisonAllowed,
        comparisonReason,
        driftStatus,
        suspectedMetrics,
        metrics,
        thresholdAutoAdjusted: false,
        gatesRelaxed: false,
        notice,
      };
    };

    const buildWindowPairComparison = (
      pair: GateDriftComparisonPair,
      shortWin: PaperMonitorReportWindow,
      longWin: PaperMonitorReportWindow
    ): GateDriftWindowComparison => {
      const shortCycles = getCyclesForWindow(shortWin);
      const longCycles = getCyclesForWindow(longWin);

      const shortCycleIds = new Set(shortCycles.map((c) => c.scanCycleId));
      const olderCyclesInLong = longCycles.filter(
        (c) => !shortCycleIds.has(c.scanCycleId)
      );

      let shortSet: PaperQualityCycleDetailRecord[];
      let longSet: PaperQualityCycleDetailRecord[];

      if (shortCycles.length > 0 && olderCyclesInLong.length > 0) {
        shortSet = shortCycles;
        longSet = olderCyclesInLong;
      } else if (longCycles.length >= 2) {
        shortSet = [longCycles[longCycles.length - 1]];
        longSet = longCycles.slice(0, -1);
      } else {
        shortSet = shortCycles;
        longSet = longCycles;
      }

      return buildComparisonFromCycleSets({
        pair,
        shortWindowLabel: shortWin,
        longWindowLabel: longWin,
        shortCycles: shortSet,
        longCycles: longSet,
        shortCountReport: shortCycles.length,
        longCountReport: longCycles.length,
      });
    };

    const latestCycleList =
      allCycleDetails.length >= 1
        ? [allCycleDetails[allCycleDetails.length - 1]]
        : [];
    const previousCycleList =
      allCycleDetails.length >= 2
        ? [allCycleDetails[allCycleDetails.length - 2]]
        : [];

    const compLatestVsPrev = buildComparisonFromCycleSets({
      pair: 'latest_vs_previous_cycle',
      shortWindowLabel: 'latest_cycle',
      longWindowLabel: 'previous_cycle',
      shortCycles: latestCycleList,
      longCycles: previousCycleList,
      shortCountReport: latestCycleList.length,
      longCountReport: previousCycleList.length,
    });

    const comp7v30 = buildWindowPairComparison('7d_vs_30d', '7d', '30d');
    const comp30v60 = buildWindowPairComparison('30d_vs_60d', '30d', '60d');
    const comp60v90 = buildWindowPairComparison('60d_vs_90d', '60d', '90d');
    const comparisonList = [compLatestVsPrev, comp7v30, comp30v60, comp60v90];

    const overallDriftStatus: GateDriftStatus = comparisonList.some(
      (c) => c.driftStatus === 'QUALITY_DRIFT_SUSPECTED'
    )
      ? 'QUALITY_DRIFT_SUSPECTED'
      : 'STABLE';

    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      [],
      '30d'
    );
    const sampleSufficiency = PaperShadowMonitor.computeSampleSufficiency(0);
    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId: `${this.monitoringWindowId}_drift`,
      entryWindowMissedCount: bundle.snap.entryWindowMissedCount,
      reportGeneratedAt: bounds30d.reportGeneratedAt,
      reportAnchorAt: bounds30d.reportAnchorAt,
      windowStartAt: bounds30d.windowStartAt,
      windowEndAt: bounds30d.windowEndAt,
      signalDetectedAt: null,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
      dataStaleCount: bundle.snap.staleCount,
      fallbackCount: 0,
      missingDataCount: 0,
      sampleSufficiency,
      sampleSufficiencyNotice: '樣本不足，僅供觀察',
      latencySummary,
      performanceSampleCount: 0,
      performanceSampleSufficiency: 'INSUFFICIENT',
      isAtomicSnapshot: options?.isAtomicSnapshot ?? true,
    });

    const currentGateStats =
      latestCycleList[0]?.gateStats ??
      this.buildCycleGateStatsMap(
        bundle.gateSummaryMap,
        bundle.snap.evaluatedCount,
        bundle.snap.totalSymbols,
        bundle
      );

    const cycleDiag = this.radarDb.computeCycleDiagnosticsAndFunnel(exchange);

    return {
      ...sharedEnvelope,
      cycleId: cycleDiag.cycleId,
      scanCycleId: cycleDiag.cycleId,
      snapshotAt: sharedEnvelope.snapshotAt,
      statsVersion: cycleDiag.statsVersion,
      aggregationScope: cycleDiag.aggregationScope,
      evaluationUniverseSize: cycleDiag.evaluationUniverseSize,
      driftStatus: overallDriftStatus,
      driftThresholdPercent,
      thresholdAutoAdjusted: false,
      gatesRelaxed: false,
      statisticScope: 'ALL_EVALUATED',
      evaluatedDenominator: cycleDiag.evaluatedDenominator,
      excludedCount: cycleDiag.excludedCount,
      excludedSymbols: cycleDiag.excludedSymbols,
      excludedReasons: cycleDiag.excludedReasons,
      consistencyErrors: cycleDiag.consistencyErrors,
      nearMissCount: cycleDiag.nearMissCount,
      nearMissMissing1Count: cycleDiag.nearMissMissing1Count,
      nearMissMissing2Count: cycleDiag.nearMissMissing2Count,
      formalCandidateCount: cycleDiag.formalCandidateCount,
      fastLaneFormalCandidateCount: cycleDiag.fastLaneFormalCandidateCount,
      bulkFormalCandidateCount: cycleDiag.bulkFormalCandidateCount,
      candidateDetectedBeforeEntryWindowCount:
        cycleDiag.candidateDetectedBeforeEntryWindowCount,
      entryWindowMissedCount: cycleDiag.entryWindowMissedCount,
      entryWindowMissedRate: cycleDiag.entryWindowMissedRate,
      candidateDetectionLatencyP50: cycleDiag.candidateDetectionLatencyP50,
      candidateDetectionLatencyP95: cycleDiag.candidateDetectionLatencyP95,
      queueWaitP50: cycleDiag.queueWaitP50,
      queueWaitP95: cycleDiag.queueWaitP95,
      currentCyclePaperEligibleCount: cycleDiag.currentCyclePaperEligibleCount,
      monitoringWindowPaperEligibleCount:
        cycleDiag.monitoringWindowPaperEligibleCount,
      cumulativePaperEligibleCount: cycleDiag.cumulativePaperEligibleCount,
      historicalPaperEligibleCount: cycleDiag.historicalPaperEligibleCount,
      currentCycleEntryWindowMissedCount:
        cycleDiag.currentCycleEntryWindowMissedCount,
      monitoringWindowEntryWindowMissedCount:
        cycleDiag.monitoringWindowEntryWindowMissedCount,
      cumulativeEntryWindowMissedCount:
        cycleDiag.cumulativeEntryWindowMissedCount,
      historicalSignalsOutsideWindowCount:
        cycleDiag.historicalSignalsOutsideWindowCount,
      historicalSignalsOutsideCurrentCycleCount:
        cycleDiag.historicalSignalsOutsideCurrentCycleCount,
      candidateFunnel: cycleDiag.candidateFunnel,
      currentCycleFunnel: cycleDiag.currentCycleFunnel,
      latestSnapshotFunnel: cycleDiag.latestSnapshotFunnel,
      monitoringWindowFunnel: cycleDiag.monitoringWindowFunnel,
      cumulativeFunnel: cycleDiag.cumulativeFunnel,
      historicalSignalsOutsideCurrentCycle:
        cycleDiag.historicalSignalsOutsideCurrentCycle,
      historicalSignalsOutsideWindow: cycleDiag.historicalSignalsOutsideWindow,
      formalCandidateLatencySla: cycleDiag.formalCandidateLatencySla,
      DEMO_LATENCY_FIXTURE: cycleDiag.DEMO_LATENCY_FIXTURE,
      LIVE_FORMAL_CANDIDATE_COUNT: cycleDiag.LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT: cycleDiag.LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT: cycleDiag.LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
        cycleDiag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT: cycleDiag.LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_DETECTION_LATENCY_P50: cycleDiag.LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95: cycleDiag.LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50:
        cycleDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95:
        cycleDiag.LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50:
        cycleDiag.LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95:
        cycleDiag.LIVE_BULK_DETECTION_LATENCY_P95,
      currentGateStats,
      currentGatePassRates,
      scopedGateStatistics: cycleDiag.scopedGateStatistics,
      observationShadowComparison: cycleDiag.observationShadowComparison,
      comparisons: {
        latest_vs_previous_cycle: compLatestVsPrev,
        '7d_vs_30d': comp7v30,
        '30d_vs_60d': comp30v60,
        '60d_vs_90d': comp60v90,
      },
      comparisonList,
      cycleHistoryCount: allCycleDetails.length,
      cycleGateHistory: allCycleDetails.map((c) => ({
        cycleId: c.cycleId,
        cycleStatus: c.cycleStatus,
        cycleCompletedAt: c.cycleCompletedAt,
        totalSymbols: c.totalSymbols,
        evaluatedDenominator: c.evaluatedCount,
        excludedCount: Math.max(0, c.totalSymbols - c.evaluatedCount),
        gateStats: c.gateStats,
      })),
    };
  }

  public getPaperQualityMarketRegimes(
    window: PaperQualityWindow = '30d',
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string,
    options?: {
      isAtomicSnapshot?: boolean;
      scopeOverride?: RegimeDatasetScope;
    }
  ): PaperQualityMarketRegimesResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：市場狀態分層分析嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const bounds = this.resolveQualityWindowBounds({
      window,
      reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    this.checkStatsVersionMonotonicity();
    this.syncCompletedSmcCyclesIntoWindow(bounds.anchorMs);
    const bundle = this.radarDb.computeSmcQualityBundle(
      exchange,
      bounds.anchorMs
    );

    const regimeCoverage = this.computeRegimeScopeAndCoverage(bundle, {
      scopeOverride: options?.scopeOverride,
    });
    const results = regimeCoverage.dedupedResults;
    const diagMap = new Map(
      bundle.symbolDiagnostics.map((d) => [d.symbol, d])
    );
    const resultsMap = new Map(results.map((r) => [r.symbol, r]));

    // Determine global BTC trend, BTC volatility, and Market Breadth
    const btcRecord = resultsMap.get('BTCUSDT');
    const btcStructureBias =
      btcRecord?.smcAnalysis?.mtfAlignment?.dominantDirection ?? 'NEUTRAL';
    const currentBtcTrendBucket =
      btcStructureBias === 'BULL'
        ? 'BULL'
        : btcStructureBias === 'BEAR'
          ? 'BEAR'
          : 'RANGE';

    const btcHighVol = Boolean(
      (btcRecord?.smcAnalysis?.atrPercent !== null &&
        btcRecord?.smcAnalysis?.atrPercent !== undefined &&
        btcRecord.smcAnalysis.atrPercent >= 1.5) ||
        (btcRecord?.waitReasons ?? []).some((w) => w.includes('波動'))
    );
    const currentBtcVolBucket = btcHighVol ? 'HIGH_VOL' : 'LOW_VOL';

    const bullCount = bundle.directionDistribution.bullStructureBiasCount;
    const bearCount = bundle.directionDistribution.bearStructureBiasCount;
    const totalBiasCount = Math.max(1, results.length);
    const currentBreadthBucket =
      bullCount / totalBiasCount >= 0.55
        ? 'BULL_BREADTH'
        : bearCount / totalBiasCount >= 0.55
          ? 'BEAR_BREADTH'
          : 'NEUTRAL_BREADTH';

    const classifySymbolBucket = (
      symbol: string,
      dim: MarketRegimeDimensionKey,
      overrideTrace?: Record<string, unknown> | null
    ): string => {
      const traceRegimes = (
        overrideTrace as { marketRegimes?: Record<string, string> } | null
      )?.marketRegimes;
      if (traceRegimes && typeof traceRegimes[dim] === 'string') {
        return traceRegimes[dim];
      }
      const r = resultsMap.get(symbol);
      const d = diagMap.get(symbol);
      switch (dim) {
        case 'BTC_TREND':
          return currentBtcTrendBucket;
        case 'BTC_VOLATILITY':
          return currentBtcVolBucket;
        case 'MARKET_BREADTH':
          return currentBreadthBucket;
        case 'SYMBOL_VOLATILITY': {
          const isHighVol = Boolean(
            (r?.smcAnalysis?.atrPercent !== null &&
              r?.smcAnalysis?.atrPercent !== undefined &&
              r.smcAnalysis.atrPercent >= 1.5) ||
              (r?.waitReasons ?? []).some(
                (w) => w.includes('高波動') || w.includes('波動')
              )
          );
          return isHighVol ? 'HIGH_VOLATILITY' : 'LOW_VOLATILITY';
        }
        case 'FUNDING_STATE': {
          const isExtremeFunding = Boolean(
            d?.gatePassMap?.['Funding safety'] === false ||
              (r?.waitReasons ?? []).some(
                (w) => w.includes('Funding') || w.includes('資金費率')
              )
          );
          return isExtremeFunding ? 'EXTREME_FUNDING' : 'NORMAL_FUNDING';
        }
        case 'LIQUIDITY_STATE': {
          const isLowLiq = Boolean(
            d?.gatePassMap?.['Liquidity safety'] === false ||
              (r?.waitReasons ?? []).some(
                (w) => w.includes('低流動性') || w.includes('TIER_3')
              )
          );
          return isLowLiq ? 'LOW_LIQUIDITY' : 'NORMAL_LIQUIDITY';
        }
        case 'MTF_ALIGNMENT_STATE': {
          const isAligned = Boolean(
            d?.gatePassMap?.['MTF Alignment'] ??
              r?.smcAnalysis?.mtfAlignment?.aligned
          );
          return isAligned ? 'MTF_ALIGNED' : 'MTF_CONFLICT';
        }
      }
    };

    // In-window signals
    const inWindowSignals = this.paperMonitorDb
      .listTrackedSignals({
        exchange,
        sinceIso: bounds.windowStartAt,
        untilIso: bounds.windowEndAt,
        includeBlocked: false,
        limit: 5000,
      })
      .filter(
        (s) =>
          !s.isDemo &&
          !s.stale &&
          !s.fallback &&
          s.smcEvaluationStatus === 'EVALUATED' &&
          (s.smcActionState === 'LONG CANDIDATE' ||
            s.smcActionState === 'SHORT CANDIDATE') &&
          s.finalTradeSignal !== 'NONE' &&
          (s.missingData?.length ?? 0) === 0 &&
          (s.waitReasons?.length ?? 0) === 0
      );

    const dimensionSpecs: Array<{
      dimension: MarketRegimeDimensionKey;
      label: string;
      currentMarketState: string;
      buckets: Array<{ key: string; label: string }>;
    }> = [
      {
        dimension: 'BTC_TREND',
        label: 'BTC 趨勢方向',
        currentMarketState: currentBtcTrendBucket,
        buckets: [
          { key: 'BULL', label: 'BTC 多頭趨勢 (BULL)' },
          { key: 'BEAR', label: 'BTC 空頭趨勢 (BEAR)' },
          { key: 'RANGE', label: 'BTC 區間震盪 (RANGE)' },
        ],
      },
      {
        dimension: 'BTC_VOLATILITY',
        label: 'BTC 波動率',
        currentMarketState: currentBtcVolBucket,
        buckets: [
          { key: 'HIGH_VOL', label: 'BTC 高波動 (HIGH_VOL)' },
          { key: 'LOW_VOL', label: 'BTC 低波動 (LOW_VOL)' },
        ],
      },
      {
        dimension: 'MARKET_BREADTH',
        label: '市場多空廣度',
        currentMarketState: currentBreadthBucket,
        buckets: [
          { key: 'BULL_BREADTH', label: '多頭廣度優勢 (BULL_BREADTH)' },
          { key: 'BEAR_BREADTH', label: '空頭廣度優勢 (BEAR_BREADTH)' },
          { key: 'NEUTRAL_BREADTH', label: '多空均衡震盪 (NEUTRAL_BREADTH)' },
        ],
      },
      {
        dimension: 'SYMBOL_VOLATILITY',
        label: '高波動 / 低波動',
        currentMarketState: 'MIXED_UNIVERSE',
        buckets: [
          { key: 'HIGH_VOLATILITY', label: '高波動標的 (HIGH_VOLATILITY)' },
          { key: 'LOW_VOLATILITY', label: '正常/低波動標的 (LOW_VOLATILITY)' },
        ],
      },
      {
        dimension: 'FUNDING_STATE',
        label: 'Funding 正常 / 極端',
        currentMarketState: 'MIXED_UNIVERSE',
        buckets: [
          { key: 'NORMAL_FUNDING', label: 'Funding 正常 (NORMAL_FUNDING)' },
          { key: 'EXTREME_FUNDING', label: 'Funding 極端 (EXTREME_FUNDING)' },
        ],
      },
      {
        dimension: 'LIQUIDITY_STATE',
        label: '流動性正常 / 低流動性',
        currentMarketState: 'MIXED_UNIVERSE',
        buckets: [
          { key: 'NORMAL_LIQUIDITY', label: '流動性正常 (NORMAL_LIQUIDITY)' },
          { key: 'LOW_LIQUIDITY', label: '低流動性 (LOW_LIQUIDITY)' },
        ],
      },
      {
        dimension: 'MTF_ALIGNMENT_STATE',
        label: 'MTF 一致 / 衝突',
        currentMarketState: 'MIXED_UNIVERSE',
        buckets: [
          { key: 'MTF_ALIGNED', label: 'MTF 多時框一致 (MTF_ALIGNED)' },
          { key: 'MTF_CONFLICT', label: 'MTF 多時框衝突 (MTF_CONFLICT)' },
        ],
      },
    ];

    const dimensions = {} as Record<
      MarketRegimeDimensionKey,
      MarketRegimeDimensionReport
    >;
    const dimensionList: MarketRegimeDimensionReport[] = [];

    for (const spec of dimensionSpecs) {
      const bucketStats: MarketRegimeBucketStat[] = spec.buckets.map((b) => {
        const evalMatching = results.filter(
          (r) => classifySymbolBucket(r.symbol, spec.dimension) === b.key
        );
        const sigMatching = inWindowSignals.filter(
          (s) =>
            classifySymbolBucket(
              s.symbol,
              spec.dimension,
              s.decisionTrace as Record<string, unknown> | null
            ) === b.key
        );

        const paperOpened = sigMatching.filter(
          (s) =>
            s.status === 'PAPER_OPENED' ||
            s.status === 'PAPER_CLOSED_WIN' ||
            s.status === 'PAPER_CLOSED_LOSS' ||
            s.status === 'PAPER_EXPIRED'
        ).length;
        const wins = sigMatching.filter(
          (s) => s.status === 'PAPER_CLOSED_WIN'
        ).length;
        const losses = sigMatching.filter(
          (s) => s.status === 'PAPER_CLOSED_LOSS'
        ).length;
        const expired = sigMatching.filter(
          (s) => s.status === 'PAPER_EXPIRED'
        ).length;
        const closedList = sigMatching.filter(
          (s) =>
            s.status === 'PAPER_CLOSED_WIN' ||
            s.status === 'PAPER_CLOSED_LOSS' ||
            s.status === 'PAPER_EXPIRED'
        );
        const paperClosed = wins + losses + expired;

        let winRate: number | null = null;
        let averageR: number | null = null;
        let maxDrawdownR: number | null = null;
        if (paperClosed > 0) {
          winRate = Number(((wins / paperClosed) * 100).toFixed(1));
          const rVals = closedList.map((s) => Number(s.riskMultiple ?? 0));
          const sumR = rVals.reduce((acc, v) => acc + v, 0);
          averageR = Number((sumR / paperClosed).toFixed(2));
          let cumR = 0;
          let peakR = 0;
          let maxDd = 0;
          for (const r of rVals) {
            cumR += r;
            if (cumR > peakR) peakR = cumR;
            const dd = peakR - cumR;
            if (dd > maxDd) maxDd = dd;
          }
          maxDrawdownR = Number(maxDd.toFixed(2));
        }

        const sampleCount = sigMatching.length;
        const sampleSufficiency =
          PaperShadowMonitor.computeSampleSufficiency(sampleCount);
        const comparisonAllowed =
          sampleSufficiency === 'SUFFICIENT' && paperClosed >= 30;
        const sampleSufficiencyNotice =
          sampleSufficiency !== 'SUFFICIENT'
            ? '樣本不足，僅供觀察'
            : '樣本充足 (n >= 100)';
        const regimeComparisonConclusion = comparisonAllowed
          ? '樣本充足，可進行市場狀態分層比較'
          : '樣本不足，僅供觀察（不得宣稱某種市場狀態較佳）';

        return {
          dimension: spec.dimension,
          bucketKey: b.key,
          bucketLabel: b.label,
          evaluatedCount: evalMatching.length,
          signalCount: sigMatching.length,
          paperOpened,
          paperClosed,
          wins,
          losses,
          winRate,
          averageR,
          maxDrawdownR,
          sampleCount,
          sampleSufficiency,
          sampleSufficiencyNotice,
          comparisonAllowed,
          regimeComparisonConclusion,
        };
      });

      const dimComparisonAllowed = bucketStats.some(
        (b) => b.comparisonAllowed
      );
      const dimReport: MarketRegimeDimensionReport = {
        dimension: spec.dimension,
        label: spec.label,
        currentMarketState: spec.currentMarketState,
        buckets: bucketStats,
        comparisonAllowed: dimComparisonAllowed,
        conclusion: dimComparisonAllowed
          ? '部分狀態分層已累積充足樣本，可參考分層表現'
          : '目前樣本不足，不代表策略有效或無效，亦不得宣稱某種市場狀態較佳',
      };
      dimensions[spec.dimension] = dimReport;
      dimensionList.push(dimReport);
    }

    const mappedInWindowSignals = inWindowSignals.map((s) =>
      this.mapPaperSignalToQualityRecord(s, bundle.snap.cycleCompletedAt)
    );
    const latencySummary = this.computeLatencySummaryForWindow(
      bundle,
      mappedInWindowSignals,
      window
    );
    const closedCount = inWindowSignals.filter(
      (s) =>
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;

    const overallSampleSufficiency =
      PaperShadowMonitor.computeSampleSufficiency(inWindowSignals.length);
    const overallComparisonAllowed = dimensionList.some(
      (d) => d.comparisonAllowed
    );

    const sharedEnvelope = this.buildPaperQualitySharedEnvelope(bundle, {
      monitoringWindowId: `${this.monitoringWindowId}_regimes_${window}`,
      entryWindowMissedCount: inWindowSignals.filter(
        (s) =>
          s.status === 'ENTRY_WINDOW_MISSED' ||
          s.entryStatus === 'ENTRY_WINDOW_MISSED'
      ).length,
      reportGeneratedAt: bounds.reportGeneratedAt,
      reportAnchorAt: bounds.reportAnchorAt,
      windowStartAt: bounds.windowStartAt,
      windowEndAt: bounds.windowEndAt,
      signalDetectedAt:
        inWindowSignals.length > 0
          ? inWindowSignals[0].signalDetectedAt ||
            inWindowSignals[0].evaluatedAt
          : null,
      scanCycleCompletedAt: bundle.snap.cycleCompletedAt,
      dataStaleCount: bundle.snap.staleCount,
      fallbackCount: 0,
      missingDataCount: 0,
      sampleSufficiency: overallSampleSufficiency,
      sampleSufficiencyNotice:
        overallSampleSufficiency !== 'SUFFICIENT'
          ? '樣本不足，僅供觀察'
          : '樣本充足 (n >= 100)',
      latencySummary,
      performanceSampleCount: closedCount,
      performanceSampleSufficiency:
        PaperShadowMonitor.computeSampleSufficiency(closedCount),
      isAtomicSnapshot: options?.isAtomicSnapshot ?? false,
      regimeScopeOverride: options?.scopeOverride,
    });

    return {
      ...sharedEnvelope,
      window,
      comparisonAllowed: overallComparisonAllowed,
      overallConclusion: overallComparisonAllowed
        ? '已累積足夠樣本進行市場狀態分層分析'
        : '目前樣本不足，不代表策略有效或無效；樣本不足時不得宣稱某種市場狀態較佳',
      dimensions,
      dimensionList,
    };
  }

  public getPaperQualitySignals(
    window: PaperQualityWindow = '30d',
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string
  ): PaperQualitySignalsResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：長期 Paper 訊號追蹤嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const report = this.getPaperQualityReport(
      window,
      exchange,
      nowMs,
      reportAnchorAt
    );
    return {
      ...report,
      window,
      totalSignals: report.totalSignals,
      longSignals: report.longSignals,
      shortSignals: report.shortSignals,
      paperOpened: report.paperOpened,
      paperClosed: report.paperClosed,
      entryWindowMissed: report.entryWindowMissed,
      invalidated: report.invalidated,
      blocked: report.blocked,
      lifecycleSummary: report.lifecycleSummary,
      signals: report.signals,
      historicalSignalsOutsideWindowCount:
        report.historicalSignalsOutsideWindowCount,
      historicalSignalsOutsideWindow: report.historicalSignalsOutsideWindow,
    };
  }

  public getPaperQualityExport(
    exchange: ExchangeId = this.activeExchange,
    nowMs = Date.now(),
    reportAnchorAt?: string
  ): PaperQualityExportResponse {
    if (exchange === 'demo_synthetic') {
      throw new Error(
        '安全攔截：長期 Paper 匯出嚴禁使用 demo_synthetic 模擬資料'
      );
    }
    const unifiedBounds = this.resolveQualityWindowBounds({
      window: '30d',
      reportAnchorAt,
      nowMs,
      exchange,
      lockAnchorToStatsVersion: true,
    });
    const sharedNowMs = unifiedBounds.generatedAtMs;
    const sharedAnchorAt = unifiedBounds.reportAnchorAt;

    const status = this.getPaperQualityStatus(
      exchange,
      sharedNowMs,
      sharedAnchorAt
    );
    const report30d = this.getPaperQualityReport(
      '30d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true }
    );
    const report60d = this.getPaperQualityReport(
      '60d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true }
    );
    const report90d = this.getPaperQualityReport(
      '90d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true }
    );
    const gateDrift = this.getPaperQualityGateDrift(exchange, sharedNowMs, {
      reportAnchorAt: sharedAnchorAt,
      isAtomicSnapshot: true,
    });
    const marketRegimes = this.getPaperQualityMarketRegimes(
      '30d',
      exchange,
      sharedNowMs,
      sharedAnchorAt,
      { isAtomicSnapshot: true }
    );
    const sigHist90d = this.getPaperQualitySignalHistory(
      '90d',
      exchange,
      sharedNowMs,
      sharedAnchorAt
    );

    return {
      ...status,
      windowStartAt: report90d.windowStartAt,
      windowEndAt: report90d.windowEndAt,
      signalDetectedAt: report90d.signalDetectedAt,
      entryWindowMissedCount: report90d.entryWindowMissedCount,
      sampleSufficiency: report90d.sampleSufficiency,
      sampleSufficiencyNotice: report90d.sampleSufficiencyNotice,
      exportedAt: status.reportGeneratedAt,
      status,
      reports: {
        '30d': report30d,
        '60d': report60d,
        '90d': report90d,
      },
      cycles: report90d.cycles,
      gateDrift,
      marketRegimes,
      signals: report90d.signals,
      signalHistory: sigHist90d.signalHistory,
    };
  }
}

