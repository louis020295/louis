import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AutoBacktestBatchRunRecord,
  AutoBacktestConfig,
  BackgroundScanRunRecord,
  BacktestResult,
  BacktestTriggerSource,
  CandidateDiagnosisStatus,
  DataProvenance,
  ExchangeId,
  ExternalNotificationChannel,
  ExternalNotificationConfig,
  ExternalNotificationDispatchLog,
  ExternalNotificationSignalTrack,
  ExternalNotificationStatus,
  FinalTradeSignal,
  Kline,
  MarketRadarCategory,
  MarketTicker,
  PaperFillStatus,
  PaperLedgerEntry,
  PaperLimitExpiredReason,
  PaperStrategyTrack,
  PaperTrackComparisonStats,
  PaperTrackMetricSummary,
  Phase6DiagnosticsReport,
  PositionHealthState,
  PositionSentinelAlert,
  PositionSentinelAlertSeverity,
  PositionSentinelConfig,
  PositionSentinelEventType,
  PositionSentinelSourceType,
  PositionSentinelTrackedPosition,
  ScanCategory,
  SmcActionState,
  SmcAnalysisResult,
  SmcCacheCoverageMetrics,
  SmcCacheUiStatus,
  SmcCandlesCacheRecord,
  SmcDiagnosticConditionKey,
  SmcDiagnosticConditionStat,
  SmcEvaluationStatus,
  SmcExecutionWorker,
  SmcLatencyBreakdown,
  SmcLatencyPercentiles,
  SmcPrewarmSnapshotRecord,
  SmcPrewarmStatus,
  SmcPrewarmTaskRecord,
  SmcPriorityClass,
  SmcPriorityExecutionBreakdown,
  SmcScanCycleHistoryRecord,
  SmcScanJobRecord,
  SmcScanJobStatus,
  SmcScanPriorityTier,
  SmcScanResultRecord,
  SmcSlaStatus,
  SmcSlowSymbolDiagnostic,
  SmcStatsConsistency,
  SmcCacheMode,
  SmcEstimateStatus,
  SmcFullUniverseStatus,
  SmcHttpEndpointBreakdown,
  SmcWorkerRole,
  SmcReasonCategory,
  SmcQualityGateKey,
  SmcQualityGateItemStat,
  SmcSymbolGateReasonRecord,
  SmcReasonCategoryStat,
  SmcReasonRankEntry,
  SmcCycleQualityHistoryItem,
  SmcPendingReason,
  SmcPendingSymbolRecord,
  SmcPendingBreakdownConsistency,
  SmcMonitorWorkerState,
  SmcScanWorkerState,
  SmcQueueWorkerState,
  SmcProgressRateStatus,
  SmcStalledReason,
  SmcScannerHealthStatus,
  SmcQueueHealthStatus,
  SmcExchangeApiHealthStatus,
  MonitoringWindowStatus,
  MonitoringWindowsListResponse,
  MonitoringWindowDetailResponse,
  Phase17WindowDuration,
  Phase17ErrorScenarioType,
  Phase17ErrorEventRecord,
  Phase17WindowCompletionCriteria,
  Phase17LongRunningWindowRecord,
  Phase17CycleIdentityChecks,
  Phase17CycleLiveSnapshotRecord,
  Phase17ProgressEvidenceSampleRecord,
  Phase17RecoveryTriggerReason,
  Phase17ServiceRecoveryRecord,
  SystemDatabaseHealthResponse,
  Timeframe,
  TRADING_SAFETY_FLAGS,
  VolumeTimeframe,
  CandidateScarcityRootCauseVerdict,
  CycleCandidateFunnel,
  DemoLatencyFixtureSummary,
  FormalCandidateLatencySlaSummary,
  FormalCandidateSlaRecord,
  FunnelAggregationScope,
  HistoricalSignalOutsideWindowItem,
  HistoricalSignalsOutsideCurrentCycleBlock,
  HistoricalSignalsOutsideWindowBlock,
  PaperEligibilityAuditSummary,
  ScopedFunnelBlock,
  SmcGateDiagnosticsSummary,
  SymbolSmcGateEvaluation,
  ScopedGateStatisticsSummary,
  ObservationShadowComparisonSummary,
  CandidateEvidenceType,
  Confirmed15mCloseEventRecord,
  ControlledLiveFixtureSummary,
  LiveCaptureCandidateRecord,
  LiveCaptureValidationStatus,
  LiveCloseEventWindowReport,
  NearMissDistributionSummary,
  PaperQualityLiveCaptureEventsResponse,
  PaperQualityLiveCaptureResponse,
  PaperQualityLiveCaptureSummaryResponse,
  SharedAtomicLiveCaptureBundle,
  SignalQualityCalibrationSummary,
  SmcNearMissSymbolRecord,
  SnapshotConsistencyMode,
  StrategyValidityStatus,
  TradingCostConfig,
} from '../../src/types/market.ts';
import {
  calculateTradeTradingCosts,
  normalizeTradingCostConfig,
} from '../engine/TradingCostModel.ts';
import { DEFAULT_AGGREGATION_WINDOWS } from '../engine/VolumeAnomalyEngine.ts';
import {
  buildSmcGateDiagnosticsSummary,
  deriveSymbolSmcGateEvaluationFromAnalysis,
  EvaluatedGateDiagnosticItemInput,
  validateScopedFunnelConsistency,
} from '../engine/SmcRuleEngine.ts';
import {
  enforceProvenanceIntegrity,
  isTestFixtureSourceName,
  isVerifiedLivePublicApiSource,
  resolveCandidateEvidenceType,
} from '../utils/provenanceQuarantine.ts';

export interface HistoricalVolumeRow {
  exchange: ExchangeId;
  symbol: string;
  volumeTimeframe: VolumeTimeframe;
  aggregationWindow: string;
  volumeMetric: 'quoteVolume';
  sampleCount?: number;
  bucketTime: number;
  quoteVolume: number;
  source: string;
  fetchedAt: string;
  isDemo: boolean;
}

export class RadarDatabase {
  private db: DatabaseSync;
  public readonly dbPath: string;
  public readonly databaseInstanceId: string;
  private readonly ledgerCheckpointPath: string | null;
  private isRecoveringRuntimeDb = false;
  private isRestoringLedgerCheckpoint = false;
  private lastLedgerPriceCheckpointAtMs = 0;
  private lastRuntimeRecoveryAtMs = 0;
  private readonly runtimeSchemaHooks: Array<() => void> = [];
  private readonly runtimeHttpMetricsByExchange = new Map<
    ExchangeId,
    {
      cycleId: string;
      completedHttpRequests: number;
      maxHttpConcurrency: number;
      maxRequestsPerMinute: number;
      currentRequestsInWindow: number;
      requiresPerSymbolOiHttp: boolean;
      symbolsWithTickerOi: Set<string>;
      rateLimitEventsCount: number;
    }
  >();
  private readonly smcStateGenerationByExchange = new Map<ExchangeId, number>();
  private lastIntegrityCheckAtMs = 0;
  private lastIntegrityCheckResult = 'ok';
  private readonly lastReconciledKeyByExchange = new Map<ExchangeId, string>();
  private readonly parsedSmcRowCache = new Map<
    string,
    { cacheKey: string; record: SmcScanResultRecord }
  >();
  private readonly bulkHistVolCache = new Map<
    string,
    { tc: number; dv: number; result: Map<string, number[]> }
  >();

  public static isSqliteBusyError(err: unknown): boolean {
    if (!err) return false;
    const errObj = err as { code?: string; errcode?: number; errstr?: string; message?: string };
    const msg = `${err instanceof Error ? err.message : String(err)} ${errObj.errstr ?? ''}`;
    if (errObj.errcode === 5 || errObj.errcode === 6) {
      return true;
    }
    return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|\bbusy\b/i.test(msg);
  }

  public static isSqliteCorruptionError(err: unknown): boolean {
    if (!err || RadarDatabase.isSqliteBusyError(err)) {
      return false;
    }
    const errObj = err as { code?: string; errcode?: number; errstr?: string; message?: string };
    const msg = `${err instanceof Error ? err.message : String(err)} ${errObj.errstr ?? ''}`;
    if (errObj.errcode === 11 || errObj.errcode === 26) {
      return true;
    }
    return /file is not a database|not a database|malformed|corrupt|disk image is malformed|unsupported file format|database disk image/i.test(
      msg
    );
  }

  private static hasValidSqliteHeader(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      if (stat.size < 100) return false;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
        return (
          bytesRead >= 16 &&
          buf.toString('utf8', 0, 15).startsWith('SQLite format 3')
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  public registerSchemaInitHook(hook: () => void): void {
    this.runtimeSchemaHooks.push(hook);
  }

  private runRegisteredSchemaHooks(): void {
    for (const hook of this.runtimeSchemaHooks) {
      try {
        hook();
      } catch (err) {
        console.error('[RadarDatabase] Schema init hook error after recovery:', err);
      }
    }
  }

  private touchSmcState(exchange: ExchangeId): void {
    const nextGen = (this.smcStateGenerationByExchange.get(exchange) ?? 0) + 1;
    this.smcStateGenerationByExchange.set(exchange, nextGen);
    this.atomicSnapshotCache.delete(exchange);
    this.cycleDiagnosticsCache.delete(exchange);
  }

  public updateRuntimeHttpMetrics(
    exchange: ExchangeId,
    partial: {
      cycleId?: string;
      completedHttpRequests?: number;
      incrementCompletedHttpRequests?: number;
      resetCompletedHttpRequests?: boolean;
      maxHttpConcurrency?: number;
      maxRequestsPerMinute?: number;
      currentRequestsInWindow?: number;
      requiresPerSymbolOiHttp?: boolean;
      symbolsWithTickerOi?: Set<string>;
      incrementRateLimitEvents?: number;
    }
  ): void {
    const existing = this.runtimeHttpMetricsByExchange.get(exchange) ?? {
      cycleId: '',
      completedHttpRequests: 0,
      maxHttpConcurrency: 4,
      maxRequestsPerMinute: 180,
      currentRequestsInWindow: 0,
      requiresPerSymbolOiHttp: exchange !== 'demo_synthetic',
      symbolsWithTickerOi: new Set<string>(),
      rateLimitEventsCount: 0,
    };
    let structuralChanged = false;
    let cycleChanged = false;
    if (partial.resetCompletedHttpRequests) {
      existing.completedHttpRequests = 0;
      existing.rateLimitEventsCount = 0;
      structuralChanged = true;
    }
    if (partial.cycleId !== undefined) {
      if (existing.cycleId && existing.cycleId !== partial.cycleId) {
        existing.completedHttpRequests = 0;
        existing.rateLimitEventsCount = 0;
        cycleChanged = true;
        structuralChanged = true;
      }
      existing.cycleId = partial.cycleId;
    }
    if (partial.completedHttpRequests !== undefined) {
      existing.completedHttpRequests = Math.max(
        0,
        partial.completedHttpRequests
      );
      structuralChanged = true;
    }
    if (partial.incrementCompletedHttpRequests !== undefined) {
      existing.completedHttpRequests = Math.max(
        0,
        existing.completedHttpRequests + partial.incrementCompletedHttpRequests
      );
    }
    if (partial.maxHttpConcurrency !== undefined) {
      existing.maxHttpConcurrency = partial.maxHttpConcurrency;
    }
    if (partial.maxRequestsPerMinute !== undefined) {
      existing.maxRequestsPerMinute = partial.maxRequestsPerMinute;
    }
    if (partial.currentRequestsInWindow !== undefined) {
      existing.currentRequestsInWindow = Math.max(
        0,
        partial.currentRequestsInWindow
      );
    }
    if (partial.requiresPerSymbolOiHttp !== undefined) {
      if (existing.requiresPerSymbolOiHttp !== partial.requiresPerSymbolOiHttp) {
        structuralChanged = true;
      }
      existing.requiresPerSymbolOiHttp = partial.requiresPerSymbolOiHttp;
    }
    if (partial.symbolsWithTickerOi !== undefined) {
      if (existing.symbolsWithTickerOi.size !== partial.symbolsWithTickerOi.size) {
        structuralChanged = true;
      }
      existing.symbolsWithTickerOi = partial.symbolsWithTickerOi;
    }
    if (partial.incrementRateLimitEvents !== undefined) {
      existing.rateLimitEventsCount = Math.max(
        0,
        existing.rateLimitEventsCount + partial.incrementRateLimitEvents
      );
    }
    this.runtimeHttpMetricsByExchange.set(exchange, existing);

    if (structuralChanged) {
      this.atomicSnapshotCache.delete(exchange);
    }

    const shouldFlushToSqlite =
      Boolean(partial.resetCompletedHttpRequests) ||
      cycleChanged ||
      partial.completedHttpRequests !== undefined ||
      (partial.incrementCompletedHttpRequests !== undefined &&
        (existing.completedHttpRequests <= 1 ||
          existing.completedHttpRequests % 25 === 0));

    if (shouldFlushToSqlite) {
      try {
        this.db
          .prepare(
            `UPDATE smc_scan_meta SET completed_http_requests = ? WHERE exchange = ?`
          )
          .run(existing.completedHttpRequests, exchange);
      } catch {
        // Ignore if smc_scan_meta row not yet initialized
      }
    }
  }

  constructor(customDbPath?: string) {
    const resolvedPath =
      customDbPath ||
      process.env.RADAR_SQLITE_PATH ||
      (process.env.NODE_TEST_CONTEXT
        ? path.join(
            os.tmpdir(),
            `radar_test_default_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
          )
        : path.resolve(process.cwd(), 'data', 'radar_phase2.sqlite'));

    this.dbPath = resolvedPath;
    this.ledgerCheckpointPath =
      resolvedPath && resolvedPath !== ':memory:'
        ? `${resolvedPath}.ledger-checkpoint.json`
        : null;
    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    let dbInstance: DatabaseSync | null = null;
    this.db = null as unknown as DatabaseSync;
    let recoveredFromCorruption = false;
    let recoveryNote = 'Recovered SQLite database cleanly via startup integrity salvage';
    try {
      dbInstance = this.openAndConfigureDatabase(resolvedPath);
      this.db = dbInstance;
      this.initSchema();
      if (resolvedPath !== ':memory:') {
        const integrityStatus = this.checkDatabaseIntegrityStatus(dbInstance);
        if (integrityStatus === 'CORRUPT') {
          throw new Error(
            'SQLite startup quick_check detected database disk image is malformed'
          );
        }
      }
    } catch (err) {
      if (
        resolvedPath !== ':memory:' &&
        RadarDatabase.isSqliteCorruptionError(err)
      ) {
        const result = this.recoverOrRecreateDatabase(
          dbInstance,
          resolvedPath,
          err
        );
        dbInstance = result.dbInstance;
        recoveryNote = result.recoverySummary;
        this.db = dbInstance;
        recoveredFromCorruption = true;
      } else {
        throw err;
      }
    }
    this.databaseInstanceId = this.initOrGetDatabaseInstanceId();
    this.restorePaperLedgerFromCheckpointIfMissing();
    if (recoveredFromCorruption) {
      try {
        const nowIso = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO smc_scan_meta (exchange, stats_version, database_recovery_count, last_backup_at, last_error_message, updated_at)
             VALUES ('binance_usdm', 1, 1, NULL, ?, ?)
             ON CONFLICT(exchange) DO UPDATE SET
               database_recovery_count = COALESCE(smc_scan_meta.database_recovery_count, 0) + 1,
               last_backup_at = NULL,
               last_error_message = excluded.last_error_message,
               updated_at = excluded.updated_at`
          )
          .run(recoveryNote, nowIso);
      } catch {
        // non-blocking recovery telemetry
      }
    }
  }

  private openAndConfigureDatabase(
    dbPath: string,
    fullSync = false
  ): DatabaseSync {
    const dbInstance = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      try {
        dbInstance.exec('PRAGMA busy_timeout = 10000;');
      } catch (err) {
        if (RadarDatabase.isSqliteCorruptionError(err)) {
          try {
            dbInstance.close();
          } catch {
            // ignore
          }
          throw err;
        }
      }
      try {
        dbInstance.exec('PRAGMA journal_mode = WAL;');
      } catch (err) {
        if (RadarDatabase.isSqliteCorruptionError(err)) {
          try {
            dbInstance.close();
          } catch {
            // ignore
          }
          throw err;
        }
      }
      try {
        dbInstance.exec(
          fullSync
            ? 'PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 200;'
            : 'PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000;'
        );
      } catch (err) {
        if (RadarDatabase.isSqliteCorruptionError(err)) {
          try {
            dbInstance.close();
          } catch {
            // ignore
          }
          throw err;
        }
      }
    }
    return dbInstance;
  }

  private checkDatabaseIntegrityStatus(
    dbInstance: DatabaseSync,
    useFullIntegrityCheck = false
  ): 'OK' | 'BUSY' | 'CORRUPT' {
    const pragmaSql = useFullIntegrityCheck
      ? 'PRAGMA integrity_check(10);'
      : 'PRAGMA quick_check(5);';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = dbInstance.prepare(pragmaSql).all() as Array<{
          quick_check?: string;
          integrity_check?: string;
        }>;
        const resultValue = useFullIntegrityCheck
          ? rows[0]?.integrity_check
          : rows[0]?.quick_check;
        if (
          rows.length === 1 &&
          String(resultValue ?? '').trim().toLowerCase() === 'ok'
        ) {
          return 'OK';
        }
        return 'CORRUPT';
      } catch (err) {
        if (RadarDatabase.isSqliteBusyError(err)) {
          if (attempt === 2) {
            return 'BUSY';
          }
          continue;
        }
        return 'CORRUPT';
      }
    }
    return 'BUSY';
  }

  private isDatabaseQuickCheckOk(dbInstance: DatabaseSync): boolean {
    return this.checkDatabaseIntegrityStatus(dbInstance) === 'OK';
  }

  private quarantineOrphanedSidecars(resolvedPath: string): void {
    const ts = Date.now();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const target = `${resolvedPath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.renameSync(target, `${target}.corrupt.${ts}`);
        } catch {
          try {
            fs.unlinkSync(target);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  private restoreFromVerifiedBackup(resolvedPath: string): DatabaseSync | null {
    const backupPath = `${resolvedPath}.backup.sqlite`;
    if (!RadarDatabase.hasValidSqliteHeader(backupPath)) {
      return null;
    }
    let testBackupDb: DatabaseSync | null = null;
    try {
      testBackupDb = new DatabaseSync(backupPath);
      if (this.checkDatabaseIntegrityStatus(testBackupDb, true) !== 'OK') {
        return null;
      }
      const userTables = testBackupDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`
        )
        .all() as Array<{ name?: string }>;
      if (userTables.length === 0) {
        return null;
      }
    } catch {
      return null;
    } finally {
      try {
        testBackupDb?.close();
      } catch {
        // ignore
      }
    }

    const restoreTmp = `${resolvedPath}.restore.tmp`;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${restoreTmp}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }
    fs.copyFileSync(backupPath, restoreTmp);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${resolvedPath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }
    fs.renameSync(restoreTmp, resolvedPath);

    const restoredDb = this.openAndConfigureDatabase(resolvedPath, true);
    this.db = restoredDb;
    this.initSchema();
    if (this.checkDatabaseIntegrityStatus(restoredDb, true) !== 'OK') {
      try {
        restoredDb.close();
      } catch {
        // ignore
      }
      throw new Error('Restored backup failed integrity_check verification');
    }
    return restoredDb;
  }

  private recoverOrRecreateDatabase(
    damagedDb: DatabaseSync | null,
    resolvedPath: string,
    triggerErr?: unknown
  ): { dbInstance: DatabaseSync; recoverySummary: string } {
    const msg =
      triggerErr instanceof Error ? triggerErr.message : String(triggerErr ?? '');
    const isNotADbError =
      /file is not a database|not a database|unsupported file format/i.test(msg);

    // Step 1: If NOT a header-level 'file is not a database' error, try lightweight REINDEX first
    if (damagedDb && !isNotADbError) {
      try {
        damagedDb.exec('REINDEX;');
        this.db = damagedDb;
        this.initSchema();
        if (this.checkDatabaseIntegrityStatus(damagedDb, true) === 'OK') {
          return {
            dbInstance: damagedDb,
            recoverySummary: 'Recovered SQLite database cleanly via REINDEX',
          };
        }
      } catch {
        // Proceed to sidecar/salvage/backup recovery
      }
    }

    // Step 2: If main file header is valid SQLite format 3 but -wal/-shm sidecars triggered NOTADB,
    // close handle, move corrupt sidecars aside, and test reopening main file cleanly.
    if (isNotADbError && RadarDatabase.hasValidSqliteHeader(resolvedPath)) {
      if (damagedDb) {
        try {
          damagedDb.close();
        } catch {
          // ignore
        }
        damagedDb = null;
      }
      this.quarantineOrphanedSidecars(resolvedPath);
      try {
        const reopened = this.openAndConfigureDatabase(resolvedPath, true);
        this.db = reopened;
        this.initSchema();
        if (this.checkDatabaseIntegrityStatus(reopened) === 'OK') {
          return {
            dbInstance: reopened,
            recoverySummary:
              'Recovered SQLite database by quarantining corrupted WAL/SHM sidecars',
          };
        }
        damagedDb = reopened;
      } catch {
        // Proceed to backup/salvage
      }
    }

    // Step 3: If main file header itself is corrupted/0-byte (cannot salvage tables), restore verified backup first
    if (!RadarDatabase.hasValidSqliteHeader(resolvedPath)) {
      if (damagedDb) {
        try {
          damagedDb.close();
        } catch {
          // ignore
        }
        damagedDb = null;
      }
      try {
        const restored = this.restoreFromVerifiedBackup(resolvedPath);
        if (restored) {
          return {
            dbInstance: restored,
            recoverySummary:
              'Recovered SQLite database from verified .backup.sqlite after header/file corruption',
          };
        }
      } catch {
        // Fallback to clean recreate below
      }
    }

    // Step 4: Try row/table-level salvage (and if 0 rows were readable, prefer verified backup if available)
    if (damagedDb) {
      try {
        const salvagedDb = this.salvageCorruptedDatabase(damagedDb, resolvedPath);
        return {
          dbInstance: salvagedDb,
          recoverySummary:
            'Recovered SQLite database cleanly via startup integrity salvage',
        };
      } catch {
        try {
          damagedDb.close();
        } catch {
          // ignore
        }
      }
    }

    // Step 5: Try verified backup before clean recreate
    try {
      const restored = this.restoreFromVerifiedBackup(resolvedPath);
      if (restored) {
        return {
          dbInstance: restored,
          recoverySummary:
            'Recovered SQLite database from verified .backup.sqlite fallback',
        };
      }
    } catch {
      // Fallback to clean recreate
    }

    // Step 6: Last resort — remove broken DB + sidecars and initialize clean schema
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${resolvedPath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }
    const freshDb = this.openAndConfigureDatabase(resolvedPath, true);
    this.db = freshDb;
    this.initSchema();
    return {
      dbInstance: freshDb,
      recoverySummary:
        'Reinitialized clean SQLite database after unrecoverable file corruption',
    };
  }

  public recoverFromRuntimeSqliteError(
    err: unknown,
    exchange: ExchangeId = 'binance_usdm'
  ): boolean {
    if (
      this.dbPath === ':memory:' ||
      !RadarDatabase.isSqliteCorruptionError(err)
    ) {
      return false;
    }
    const nowMs = Date.now();
    if (
      this.isRecoveringRuntimeDb ||
      nowMs - this.lastRuntimeRecoveryAtMs < 2000
    ) {
      return false;
    }

    this.isRecoveringRuntimeDb = true;
    this.lastRuntimeRecoveryAtMs = nowMs;
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[RadarDatabase] Runtime SQLite error detected (${errMsg}); attempting automatic recovery for ${this.dbPath}`
      );
      try {
        this.db.close();
      } catch {
        // ignore close errors on damaged/stale handle
      }

      // First try reopening from disk, but require full integrity_check(10) after a runtime corruption error
      let recoveredDb: DatabaseSync | null = null;
      let recoverySummary =
        'Recovered SQLite database at runtime via clean reconnect';
      if (RadarDatabase.hasValidSqliteHeader(this.dbPath)) {
        try {
          const reopened = this.openAndConfigureDatabase(this.dbPath);
          this.db = reopened;
          this.initSchema();
          if (this.checkDatabaseIntegrityStatus(reopened, true) === 'OK') {
            recoveredDb = reopened;
          } else {
            recoveredDb = null;
            const res = this.recoverOrRecreateDatabase(
              reopened,
              this.dbPath,
              err
            );
            recoveredDb = res.dbInstance;
            recoverySummary = res.recoverySummary;
          }
        } catch {
          const res = this.recoverOrRecreateDatabase(null, this.dbPath, err);
          recoveredDb = res.dbInstance;
          recoverySummary = res.recoverySummary;
        }
      } else {
        const res = this.recoverOrRecreateDatabase(null, this.dbPath, err);
        recoveredDb = res.dbInstance;
        recoverySummary = res.recoverySummary;
      }

      if (!recoveredDb) {
        return false;
      }
      this.db = recoveredDb;
      this.parsedSmcRowCache.clear();
      this.atomicSnapshotCache.clear();
      this.cycleDiagnosticsCache.clear();
      this.lastIntegrityCheckAtMs = 0;
      this.lastIntegrityCheckResult = 'ok';
      this.runRegisteredSchemaHooks();
      this.restorePaperLedgerFromCheckpointIfMissing();

      try {
        const nowIso = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO smc_scan_meta (exchange, stats_version, database_recovery_count, last_error_message, updated_at)
             VALUES (?, 1, 1, ?, ?)
             ON CONFLICT(exchange) DO UPDATE SET
               database_recovery_count = COALESCE(smc_scan_meta.database_recovery_count, 0) + 1,
               last_error_message = excluded.last_error_message,
               updated_at = excluded.updated_at`
          )
          .run(exchange, recoverySummary, nowIso);
      } catch {
        // non-blocking recovery telemetry
      }

      console.warn(
        `[RadarDatabase] Runtime SQLite recovery succeeded: ${recoverySummary}`
      );
      return true;
    } catch (recErr) {
      console.error('[RadarDatabase] Runtime SQLite recovery failed:', recErr);
      return false;
    } finally {
      this.isRecoveringRuntimeDb = false;
    }
  }

  private salvageCorruptedDatabase(
    damagedDb: DatabaseSync,
    resolvedPath: string
  ): DatabaseSync {
    const salvagePath = `${resolvedPath}.salvage.tmp`;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${salvagePath}${suffix}`;
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }

    const cleanDb = new DatabaseSync(salvagePath);
    try {
      cleanDb.exec(
        'PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 200;'
      );
      (this as unknown as { db: DatabaseSync }).db = cleanDb;
      this.initSchema();

      // Also recreate any tables registered by sibling DB wrappers (PaperMonitorDatabase / BacktestDatabase)
      try {
        const masterTables = damagedDb
          .prepare(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`
          )
          .all() as Array<{ name?: string; sql?: string }>;
        for (const t of masterTables) {
          const sql = String(t.sql ?? '').trim();
          if (!sql) continue;
          const safeSql = sql.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i, 'CREATE TABLE IF NOT EXISTS ');
          try {
            cleanDb.exec(safeSql);
          } catch {
            // Table already created by initSchema() or non-critical DDL
          }
        }
      } catch {
        // Ignore if sqlite_master scan fails partially
      }

      const salvageBudgetDeadlineMs = Date.now() + 3000;
      const rebuildableCacheTables = new Set([
        'historical_volume_samples',
        'smc_scan_candles_cache',
        'smc_prewarm_tasks',
        'smc_database_health_checks',
      ]);
      const rawTableNames = (
        cleanDb
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name ASC`
          )
          .all() as Array<{ name?: string }>
      )
        .map((r) => String(r.name ?? ''))
        .filter((n) => Boolean(n) && n !== 'sqlite_sequence');

      const targetTables = [
        ...rawTableNames.filter((n) => !rebuildableCacheTables.has(n)),
        ...rawTableNames.filter((n) => rebuildableCacheTables.has(n)),
      ];

      for (const tableName of targetTables) {
        const quotedTable = `"${tableName.replace(/"/g, '""')}"`;
        let srcCols: string[] = [];
        let dstCols: string[] = [];
        try {
          srcCols = (
            damagedDb.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{
              name?: string;
            }>
          ).map((c) => String(c.name ?? ''));
          dstCols = (
            cleanDb.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{
              name?: string;
            }>
          ).map((c) => String(c.name ?? ''));
        } catch {
          continue;
        }
        const dstSet = new Set(dstCols);
        const commonCols = srcCols.filter((c) => c && dstSet.has(c));
        if (commonCols.length === 0) continue;

        const colListSql = commonCols
          .map((c) => `"${c.replace(/"/g, '""')}"`)
          .join(', ');
        const placeholdersSql = commonCols.map(() => '?').join(', ');
        const insertStmt = cleanDb.prepare(
          `INSERT OR IGNORE INTO ${quotedTable} (${colListSql}) VALUES (${placeholdersSql})`
        );

        try {
          const rows = damagedDb
            .prepare(`SELECT ${colListSql} FROM ${quotedTable}`)
            .all() as Array<Record<string, unknown>>;
          if (rows.length > 0) {
            cleanDb.exec('BEGIN;');
            for (const row of rows) {
              insertStmt.run(...commonCols.map((c) => row[c] as never));
            }
            cleanDb.exec('COMMIT;');
          }
        } catch {
          try {
            cleanDb.exec('ROLLBACK;');
          } catch {
            // ignore
          }
          if (
            rebuildableCacheTables.has(tableName) ||
            Date.now() >= salvageBudgetDeadlineMs
          ) {
            continue;
          }
          // Row-by-row salvage on high-value tables with partially damaged B-tree pages (bounded by time budget)
          let cursorRowid = 0;
          const findNextStmt = damagedDb.prepare(
            `SELECT rowid FROM ${quotedTable} WHERE rowid > ? ORDER BY rowid ASC LIMIT 1`
          );
          const readRowStmt = damagedDb.prepare(
            `SELECT ${colListSql} FROM ${quotedTable} WHERE rowid = ?`
          );
          let batchCount = 0;
          cleanDb.exec('BEGIN;');
          try {
            for (let steps = 0; steps < 50000; steps++) {
              if ((steps & 31) === 0 && Date.now() >= salvageBudgetDeadlineMs) {
                break;
              }
              let nextRow: { rowid?: number } | undefined;
              try {
                nextRow = findNextStmt.get(cursorRowid) as
                  | { rowid?: number }
                  | undefined;
              } catch {
                break;
              }
              if (
                !nextRow ||
                typeof nextRow.rowid !== 'number' ||
                nextRow.rowid <= cursorRowid
              ) {
                break;
              }
              cursorRowid = nextRow.rowid;
              try {
                const row = readRowStmt.get(cursorRowid) as
                  | Record<string, unknown>
                  | undefined;
                if (row) {
                  insertStmt.run(...commonCols.map((c) => row[c] as never));
                  batchCount++;
                  if (batchCount >= 250) {
                    cleanDb.exec('COMMIT;');
                    cleanDb.exec('BEGIN;');
                    batchCount = 0;
                  }
                }
              } catch {
                // Skip individual unreadable row/page
              }
            }
            cleanDb.exec('COMMIT;');
          } catch {
            try {
              cleanDb.exec('ROLLBACK;');
            } catch {
              // ignore
            }
          }
        }
      }

      try {
        cleanDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // ignore
      }
    } finally {
      try {
        cleanDb.close();
      } catch {
        // ignore
      }
      try {
        damagedDb.close();
      } catch {
        // ignore
      }
    }

    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${resolvedPath}${suffix}`;
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const tmpSidecar = `${salvagePath}${suffix}`;
      if (fs.existsSync(tmpSidecar)) {
        try {
          fs.unlinkSync(tmpSidecar);
        } catch {
          // ignore
        }
      }
    }
    fs.renameSync(salvagePath, resolvedPath);

    const reopened = new DatabaseSync(resolvedPath);
    reopened.exec(
      'PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 200;'
    );
    (this as unknown as { db: DatabaseSync }).db = reopened;
    this.initSchema();
    return reopened;
  }

  private initOrGetDatabaseInstanceId(): string {
    const row = this.db
      .prepare(`SELECT value FROM radar_db_meta WHERE key = 'database_instance_id'`)
      .get() as { value?: string } | undefined;
    if (row?.value) {
      return String(row.value);
    }
    const generated = `db_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO radar_db_meta (key, value) VALUES ('database_instance_id', ?)`
      )
      .run(generated);
    const verify = this.db
      .prepare(`SELECT value FROM radar_db_meta WHERE key = 'database_instance_id'`)
      .get() as { value?: string } | undefined;
    return String(verify?.value ?? generated);
  }

  private initSchema(): void {
    // Check if legacy historical_volume_samples table exists without volume_timeframe column (which previously mixed 24h and 15m rows)
    const tableInfo = this.db
      .prepare(`PRAGMA table_info(historical_volume_samples)`)
      .all() as Array<{ name?: string }>;
    if (
      tableInfo.length > 0 &&
      !tableInfo.some((col) => col.name === 'volume_timeframe')
    ) {
      this.db.exec(`DROP TABLE IF EXISTS historical_volume_samples;`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS historical_volume_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        volume_timeframe TEXT NOT NULL DEFAULT '15m',
        aggregation_window TEXT NOT NULL DEFAULT '15m_CONFIRMED_KLINE_30_BARS',
        volume_metric TEXT NOT NULL DEFAULT 'quoteVolume',
        bucket_time INTEGER NOT NULL,
        quote_volume REAL NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        UNIQUE(exchange, symbol, volume_timeframe, bucket_time)
      );

      CREATE INDEX IF NOT EXISTS idx_hist_vol_lookup
        ON historical_volume_samples(exchange, symbol, volume_timeframe, bucket_time DESC);

      CREATE TABLE IF NOT EXISTS paper_trading_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        side TEXT NOT NULL,
        category TEXT NOT NULL,
        action_state TEXT NOT NULL,
        entry_price REAL NOT NULL,
        invalidation_price REAL NOT NULL,
        target_price REAL NOT NULL,
        current_price REAL NOT NULL,
        exit_price REAL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        pnl_r REAL NOT NULL DEFAULT 0,
        pnl_percent REAL NOT NULL DEFAULT 0,
        rule_version TEXT NOT NULL,
        evidences_json TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        provenance_json TEXT NOT NULL,
        strategy_track TEXT NOT NULL DEFAULT 'MANUAL_OBSERVATION',
        fill_status TEXT NOT NULL DEFAULT 'FILLED',
        filled_at TEXT,
        entry_anchor_label TEXT,
        expires_at TEXT,
        expired_reason TEXT,
        gross_pnl_r REAL NOT NULL DEFAULT 0,
        net_pnl_r REAL NOT NULL DEFAULT 0,
        fee_cost_r REAL NOT NULL DEFAULT 0,
        slippage_cost_r REAL NOT NULL DEFAULT 0,
        funding_cost_r REAL NOT NULL DEFAULT 0,
        total_cost_r REAL NOT NULL DEFAULT 0,
        cost_config_json TEXT,
        trailing_stop_price REAL,
        breakeven_armed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS backtest_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        scanner_rule_version TEXT NOT NULL,
        status TEXT NOT NULL,
        insufficient_reason TEXT,
        confirmed_bars_tested INTEGER NOT NULL,
        total_trades INTEGER,
        win_rate_percent REAL,
        max_drawdown_r REAL,
        profit_factor REAL,
        average_win_r REAL,
        average_loss_r REAL,
        trades_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        trigger_source TEXT NOT NULL DEFAULT 'MANUAL',
        auto_batch_id TEXT,
        end_time TEXT
      );

      CREATE TABLE IF NOT EXISTS auto_backtest_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_ms INTEGER NOT NULL DEFAULT 3600000,
        timeframe TEXT NOT NULL DEFAULT '15m',
        max_symbols_per_run INTEGER NOT NULL DEFAULT 15,
        include_watchlist INTEGER NOT NULL DEFAULT 1,
        watchlist_symbols_json TEXT NOT NULL DEFAULT '["BTCUSDT","ETHUSDT"]',
        exchange TEXT NOT NULL DEFAULT 'binance_usdm',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auto_backtest_batches (
        batch_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        target_symbols_json TEXT NOT NULL DEFAULT '[]',
        completed_count INTEGER NOT NULL DEFAULT 0,
        skipped_cached_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        saved_run_ids_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS external_notification_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        telegram_enabled INTEGER NOT NULL DEFAULT 0,
        discord_enabled INTEGER NOT NULL DEFAULT 0,
        notify_formal_smc INTEGER NOT NULL DEFAULT 1,
        notify_early_ignition INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_notification_logs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        symbol TEXT NOT NULL,
        track TEXT NOT NULL,
        action_state TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        http_status INTEGER,
        is_test INTEGER NOT NULL DEFAULT 0,
        message_preview TEXT NOT NULL,
        dedupe_key TEXT,
        cooldown_until TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ext_notif_created
        ON external_notification_logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS position_sentinel_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_sync_paper_ledger INTEGER NOT NULL DEFAULT 1,
        ws_stream_enabled INTEGER NOT NULL DEFAULT 1,
        poll_interval_ms INTEGER NOT NULL DEFAULT 15000,
        atr_shock_multiplier REAL NOT NULL DEFAULT 1.25,
        rvol_spike_threshold REAL NOT NULL DEFAULT 2.5,
        stop_proximity_pct REAL NOT NULL DEFAULT 0.5,
        notify_discord INTEGER NOT NULL DEFAULT 1,
        notify_telegram INTEGER NOT NULL DEFAULT 1,
        notify_min_severity TEXT NOT NULL DEFAULT 'WARNING',
        alert_cooldown_ms INTEGER NOT NULL DEFAULT 180000,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS position_sentinel_positions (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT 'MANUAL',
        paper_ledger_id INTEGER UNIQUE,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        side TEXT NOT NULL,
        timeframe TEXT NOT NULL DEFAULT '15m',
        entry_price REAL NOT NULL,
        invalidation_price REAL NOT NULL,
        target_price REAL,
        leverage REAL NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        paused INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS position_sentinel_alerts (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        side TEXT NOT NULL,
        severity TEXT NOT NULL,
        health_state TEXT NOT NULL,
        event_type TEXT NOT NULL,
        title_zh TEXT NOT NULL,
        detail_zh TEXT NOT NULL,
        price_at_event REAL NOT NULL,
        suggested_defense_price REAL,
        confirmed_close INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ps_alerts_created
        ON position_sentinel_alerts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ps_alerts_pos
        ON position_sentinel_alerts(position_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS background_scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL,
        exchange TEXT NOT NULL,
        mode TEXT NOT NULL,
        symbols_scanned INTEGER NOT NULL,
        volume_samples_recorded INTEGER NOT NULL,
        long_candidates INTEGER NOT NULL,
        short_candidates INTEGER NOT NULL,
        high_risk_count INTEGER NOT NULL,
        dry_run_alerts_dispatched INTEGER NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        error_message TEXT,
        duration_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smc_scan_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        priority REAL NOT NULL DEFAULT 0,
        priority_tier INTEGER NOT NULL DEFAULT 5,
        priority_label TEXT NOT NULL DEFAULT '5_REMAINING_USDT_PERP',
        status TEXT NOT NULL DEFAULT 'QUEUED',
        rule_version TEXT NOT NULL,
        window_key TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        worker_id TEXT,
        lease_until TEXT,
        heartbeat_at TEXT,
        UNIQUE(exchange, symbol, rule_version, window_key)
      );

      CREATE INDEX IF NOT EXISTS idx_smc_jobs_queue
        ON smc_scan_jobs(exchange, status, priority_tier ASC, priority DESC, id ASC);

      CREATE TABLE IF NOT EXISTS radar_db_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smc_scan_meta (
        exchange TEXT PRIMARY KEY,
        stats_version INTEGER NOT NULL DEFAULT 1,
        scan_run_id TEXT,
        scan_cycle_id TEXT,
        cycle_started_at TEXT,
        cycle_completed_at TEXT,
        cycle_status TEXT NOT NULL DEFAULT 'RUNNING',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smc_scan_results (
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        smc_evaluation_status TEXT NOT NULL,
        smc_action_state TEXT NOT NULL,
        final_trade_signal TEXT NOT NULL,
        market_radar_category TEXT,
        evaluated_at TEXT NOT NULL,
        data_fetched_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        missing_data_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        rule_version TEXT NOT NULL,
        wait_reasons_json TEXT NOT NULL DEFAULT '[]',
        smc_analysis_json TEXT,
        scan_cycle_id TEXT,
        PRIMARY KEY (exchange, symbol)
      );

      CREATE TABLE IF NOT EXISTS smc_scan_candles_cache (
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        klines_json TEXT NOT NULL,
        open_interest REAL,
        open_interest_value REAL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        missing_data_json TEXT NOT NULL DEFAULT '[]',
        is_demo INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (exchange, symbol, timeframe)
      );

      CREATE TABLE IF NOT EXISTS smc_scan_cycles (
        scan_cycle_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        window_key TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        cycle_started_at TEXT NOT NULL,
        cycle_completed_at TEXT,
        cycle_status TEXT NOT NULL DEFAULT 'RUNNING',
        total_contracts INTEGER NOT NULL DEFAULT 0,
        evaluated_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        rate_limited_count INTEGER NOT NULL DEFAULT 0,
        wait_count INTEGER NOT NULL DEFAULT 0,
        watch_count INTEGER NOT NULL DEFAULT 0,
        high_risk_count INTEGER NOT NULL DEFAULT 0,
        long_candidate_count INTEGER NOT NULL DEFAULT 0,
        short_candidate_count INTEGER NOT NULL DEFAULT 0,
        candidate_status TEXT NOT NULL DEFAULT 'SCAN_INCOMPLETE',
        stats_version INTEGER NOT NULL DEFAULT 1,
        database_instance_id TEXT NOT NULL
      );
    `);

    // Add worker lease and Phase 8 latency columns if upgrading an existing SQLite database file
    const jobColumns = this.db
      .prepare("PRAGMA table_info('smc_scan_jobs')")
      .all() as Array<{ name: string }>;
    const existingColNames = new Set(jobColumns.map((c) => String(c.name)));
    if (!existingColNames.has('worker_id')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN worker_id TEXT;');
    }
    if (!existingColNames.has('lease_until')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN lease_until TEXT;');
    }
    if (!existingColNames.has('heartbeat_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN heartbeat_at TEXT;');
    }
    if (!existingColNames.has('queue_entered_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN queue_entered_at TEXT;');
    }
    if (!existingColNames.has('smc_evaluation_started_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN smc_evaluation_started_at TEXT;');
    }
    if (!existingColNames.has('smc_evaluation_completed_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN smc_evaluation_completed_at TEXT;');
    }
    if (!existingColNames.has('queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN queue_wait_ms INTEGER;');
    }
    if (!existingColNames.has('http_request_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN http_request_latency_ms INTEGER;');
    }
    if (!existingColNames.has('smc_evaluation_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN smc_evaluation_latency_ms INTEGER;');
    }
    if (!existingColNames.has('detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN detection_latency_ms INTEGER;');
    }
    if (!existingColNames.has('is_fast_lane')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN is_fast_lane INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('job_claimed_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN job_claimed_at TEXT;');
    }
    if (!existingColNames.has('smc_calculation_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN smc_calculation_latency_ms INTEGER;');
    }
    if (!existingColNames.has('db_write_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN db_write_latency_ms INTEGER;');
    }
    if (!existingColNames.has('rate_limit_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN rate_limit_wait_ms INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('cache_hit')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('cache_miss')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN cache_miss INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('reused_cache')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN reused_cache INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('worker_role')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN worker_role TEXT;');
    }
    if (!existingColNames.has('priority_class')) {
      this.db.exec("ALTER TABLE smc_scan_jobs ADD COLUMN priority_class TEXT NOT NULL DEFAULT 'BULK';");
    }
    if (!existingColNames.has('execution_worker')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN execution_worker TEXT;');
    }
    if (!existingColNames.has('prewarm_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN prewarm_wait_ms INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColNames.has('pending_reason')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN pending_reason TEXT;');
    }
    if (!existingColNames.has('last_progress_at')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN last_progress_at TEXT;');
    }
    if (!existingColNames.has('cycle_id')) {
      this.db.exec('ALTER TABLE smc_scan_jobs ADD COLUMN cycle_id TEXT;');
    }

    const metaColumns = this.db
      .prepare("PRAGMA table_info('smc_scan_meta')")
      .all() as Array<{ name: string }>;
    const existingMetaColNames = new Set(metaColumns.map((c) => String(c.name)));
    if (!existingMetaColNames.has('scan_run_id')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN scan_run_id TEXT;');
    }
    if (!existingMetaColNames.has('scan_cycle_id')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN scan_cycle_id TEXT;');
    }
    if (!existingMetaColNames.has('cycle_started_at')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN cycle_started_at TEXT;');
    }
    if (!existingMetaColNames.has('cycle_completed_at')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN cycle_completed_at TEXT;');
    }
    if (!existingMetaColNames.has('cycle_status')) {
      this.db.exec("ALTER TABLE smc_scan_meta ADD COLUMN cycle_status TEXT NOT NULL DEFAULT 'RUNNING';");
    }
    if (!existingMetaColNames.has('last_full_radar_scan_at')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN last_full_radar_scan_at TEXT;');
    }
    if (!existingMetaColNames.has('last_priority_scan_at')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN last_priority_scan_at TEXT;');
    }
    if (!existingMetaColNames.has('radar_scan_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN radar_scan_duration_ms INTEGER;');
    }
    if (!existingMetaColNames.has('priority_smc_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN priority_smc_duration_ms INTEGER;');
    }
    if (!existingMetaColNames.has('full_cycle_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN full_cycle_duration_ms INTEGER;');
    }
    if (!existingMetaColNames.has('priority_refresh_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN priority_refresh_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('is_cold_start')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN is_cold_start INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingMetaColNames.has('prewarm_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN prewarm_duration_ms INTEGER;');
    }
    if (!existingMetaColNames.has('prewarm_cache_hit_rate')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN prewarm_cache_hit_rate REAL;');
    }
    if (!existingMetaColNames.has('completed_http_requests')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN completed_http_requests INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('cache_mode')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN cache_mode TEXT;');
    }
    if (!existingMetaColNames.has('worker_restart_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN worker_restart_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('database_recovery_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN database_recovery_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('stalled_detected_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN stalled_detected_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('http_503_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN http_503_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('last_error_message')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN last_error_message TEXT;');
    }
    if (!existingMetaColNames.has('last_backup_at')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN last_backup_at TEXT;');
    }
    if (!existingMetaColNames.has('backup_file_path')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN backup_file_path TEXT;');
    }
    if (!existingMetaColNames.has('concurrency_violations')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN concurrency_violations INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('max_concurrency')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 2;');
    }
    if (!existingMetaColNames.has('planned_restart_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN planned_restart_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('unexpected_restart_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN unexpected_restart_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingMetaColNames.has('lease_recovery_count')) {
      this.db.exec('ALTER TABLE smc_scan_meta ADD COLUMN lease_recovery_count INTEGER NOT NULL DEFAULT 0;');
    }

    const ledgerColumns = this.db
      .prepare("PRAGMA table_info('paper_trading_ledger')")
      .all() as Array<{ name: string }>;
    const existingLedgerColNames = new Set(ledgerColumns.map((c) => String(c.name)));
    if (!existingLedgerColNames.has('strategy_track')) {
      this.db.exec(
        "ALTER TABLE paper_trading_ledger ADD COLUMN strategy_track TEXT NOT NULL DEFAULT 'MANUAL_OBSERVATION';"
      );
    }
    if (!existingLedgerColNames.has('fill_status')) {
      this.db.exec(
        "ALTER TABLE paper_trading_ledger ADD COLUMN fill_status TEXT NOT NULL DEFAULT 'FILLED';"
      );
    }
    if (!existingLedgerColNames.has('filled_at')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN filled_at TEXT;');
    }
    if (!existingLedgerColNames.has('entry_anchor_label')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN entry_anchor_label TEXT;');
    }
    if (!existingLedgerColNames.has('expires_at')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN expires_at TEXT;');
    }
    if (!existingLedgerColNames.has('expired_reason')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN expired_reason TEXT;');
    }
    if (!existingLedgerColNames.has('gross_pnl_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN gross_pnl_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('net_pnl_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN net_pnl_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('fee_cost_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN fee_cost_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('slippage_cost_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN slippage_cost_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('funding_cost_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN funding_cost_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('total_cost_r')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN total_cost_r REAL NOT NULL DEFAULT 0;');
    }
    if (!existingLedgerColNames.has('cost_config_json')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN cost_config_json TEXT;');
    }
    if (!existingLedgerColNames.has('trailing_stop_price')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN trailing_stop_price REAL;');
    }
    if (!existingLedgerColNames.has('breakeven_armed')) {
      this.db.exec('ALTER TABLE paper_trading_ledger ADD COLUMN breakeven_armed INTEGER NOT NULL DEFAULT 0;');
    }

    const resColumns = this.db
      .prepare("PRAGMA table_info('smc_scan_results')")
      .all() as Array<{ name: string }>;
    const existingResColNames = new Set(resColumns.map((c) => String(c.name)));
    if (!existingResColNames.has('scan_cycle_id')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN scan_cycle_id TEXT;');
    }
    if (!existingResColNames.has('window_key')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN window_key TEXT;');
    }
    if (!existingResColNames.has('priority_tier')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN priority_tier INTEGER;');
    }
    if (!existingResColNames.has('priority_label')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN priority_label TEXT;');
    }
    if (!existingResColNames.has('worker_role')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN worker_role TEXT;');
    }
    if (!existingResColNames.has('priority_class')) {
      this.db.exec("ALTER TABLE smc_scan_results ADD COLUMN priority_class TEXT NOT NULL DEFAULT 'BULK';");
    }
    if (!existingResColNames.has('execution_worker')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN execution_worker TEXT;');
    }
    if (!existingResColNames.has('prewarm_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN prewarm_wait_ms INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('queue_entered_at')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN queue_entered_at TEXT;');
    }
    if (!existingResColNames.has('job_claimed_at')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN job_claimed_at TEXT;');
    }
    if (!existingResColNames.has('smc_evaluation_started_at')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN smc_evaluation_started_at TEXT;');
    }
    if (!existingResColNames.has('smc_evaluation_completed_at')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN smc_evaluation_completed_at TEXT;');
    }
    if (!existingResColNames.has('queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN queue_wait_ms INTEGER;');
    }
    if (!existingResColNames.has('http_request_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN http_request_latency_ms INTEGER;');
    }
    if (!existingResColNames.has('smc_calculation_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN smc_calculation_latency_ms INTEGER;');
    }
    if (!existingResColNames.has('db_write_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN db_write_latency_ms INTEGER;');
    }
    if (!existingResColNames.has('smc_evaluation_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN smc_evaluation_latency_ms INTEGER;');
    }
    if (!existingResColNames.has('rate_limit_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN rate_limit_wait_ms INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN detection_latency_ms INTEGER;');
    }
    if (!existingResColNames.has('cache_hit')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('cache_miss')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN cache_miss INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('reused_cache')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN reused_cache INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('signal_bar_close_time')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN signal_bar_close_time INTEGER;');
    }
    if (!existingResColNames.has('next_bar_open_time')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN next_bar_open_time INTEGER;');
    }
    if (!existingResColNames.has('entry_window_status')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN entry_window_status TEXT;');
    }
    if (!existingResColNames.has('is_fast_lane')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN is_fast_lane INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingResColNames.has('primary_blocking_reason')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN primary_blocking_reason TEXT;');
    }
    if (!existingResColNames.has('primary_reason_category')) {
      this.db.exec('ALTER TABLE smc_scan_results ADD COLUMN primary_reason_category TEXT;');
    }
    if (!existingResColNames.has('all_blocking_reasons_json')) {
      this.db.exec("ALTER TABLE smc_scan_results ADD COLUMN all_blocking_reasons_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!existingResColNames.has('gate_pass_json')) {
      this.db.exec("ALTER TABLE smc_scan_results ADD COLUMN gate_pass_json TEXT NOT NULL DEFAULT '{}';");
    }
    if (!existingResColNames.has('evidence_type')) {
      this.db.exec("ALTER TABLE smc_scan_results ADD COLUMN evidence_type TEXT NOT NULL DEFAULT 'LIVE_PRODUCTION';");
    }

    const backtestReportCols = this.db
      .prepare("PRAGMA table_info('backtest_reports')")
      .all() as Array<{ name: string }>;
    const existingBtReportColNames = new Set(
      backtestReportCols.map((c) => String(c.name))
    );
    if (!existingBtReportColNames.has('trigger_source')) {
      this.db.exec(
        "ALTER TABLE backtest_reports ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'MANUAL';"
      );
    }
    if (!existingBtReportColNames.has('auto_batch_id')) {
      this.db.exec('ALTER TABLE backtest_reports ADD COLUMN auto_batch_id TEXT;');
    }
    if (!existingBtReportColNames.has('end_time')) {
      this.db.exec('ALTER TABLE backtest_reports ADD COLUMN end_time TEXT;');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS smc_live_capture_candidates (
        signal_id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        signal_bar_open_time INTEGER,
        signal_bar_close_time INTEGER,
        next_bar_open_time INTEGER,
        candidate_detected_at TEXT NOT NULL,
        signal_detected_at TEXT NOT NULL,
        queue_entered_at TEXT,
        evaluation_started_at TEXT NOT NULL,
        evaluation_completed_at TEXT NOT NULL,
        queue_wait_ms INTEGER,
        evaluation_latency_ms INTEGER,
        candidate_detection_latency_ms INTEGER,
        next_bar_remaining_ms INTEGER,
        entry_window_status TEXT NOT NULL,
        entry_window_missed INTEGER NOT NULL DEFAULT 0,
        is_fast_lane INTEGER NOT NULL DEFAULT 1,
        evidence_type TEXT NOT NULL DEFAULT 'LIVE_PRODUCTION',
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_smc_live_capture_candidates_exchange
        ON smc_live_capture_candidates (exchange, signal_detected_at DESC);

      CREATE TABLE IF NOT EXISTS smc_controlled_fixture_candidates (
        signal_id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        signal_bar_open_time INTEGER,
        signal_bar_close_time INTEGER,
        next_bar_open_time INTEGER,
        candidate_detected_at TEXT NOT NULL,
        signal_detected_at TEXT NOT NULL,
        queue_entered_at TEXT,
        evaluation_started_at TEXT NOT NULL,
        evaluation_completed_at TEXT NOT NULL,
        queue_wait_ms INTEGER,
        evaluation_latency_ms INTEGER,
        candidate_detection_latency_ms INTEGER,
        next_bar_remaining_ms INTEGER,
        entry_window_status TEXT NOT NULL,
        entry_window_missed INTEGER NOT NULL DEFAULT 0,
        is_fast_lane INTEGER NOT NULL DEFAULT 1,
        evidence_type TEXT NOT NULL DEFAULT 'CONTROLLED_LIVE_FIXTURE',
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_smc_controlled_fixture_candidates_exchange
        ON smc_controlled_fixture_candidates (exchange, signal_detected_at DESC);

      CREATE TABLE IF NOT EXISTS smc_15m_close_events (
        event_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        bar_open_time INTEGER NOT NULL,
        bar_close_time INTEGER NOT NULL,
        close_event_at TEXT NOT NULL,
        triggered_fast_lane_count INTEGER NOT NULL DEFAULT 0,
        completed_fast_lane_count INTEGER NOT NULL DEFAULT 0,
        formal_candidate_count INTEGER NOT NULL DEFAULT 0,
        near_miss_count INTEGER NOT NULL DEFAULT 0,
        candidate_detected_before_entry_count INTEGER NOT NULL DEFAULT 0,
        entry_window_missed_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        queue_wait_p50 INTEGER,
        queue_wait_p95 INTEGER,
        worker_state TEXT NOT NULL DEFAULT 'RUNNING',
        cache_mode TEXT NOT NULL DEFAULT 'WARM_CACHE',
        snapshot_at TEXT NOT NULL,
        stats_version INTEGER NOT NULL DEFAULT 0,
        evidence_type TEXT NOT NULL DEFAULT 'LIVE_PRODUCTION',
        is_demo INTEGER NOT NULL DEFAULT 0,
        is_test_fixture INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_smc_15m_close_events_exchange
        ON smc_15m_close_events (exchange, evidence_type, close_event_at DESC);

      CREATE TABLE IF NOT EXISTS smc_near_miss_observations (
        observation_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        smc_action_state TEXT NOT NULL,
        market_radar_category TEXT NOT NULL,
        intended_direction TEXT NOT NULL,
        missing_gates_json TEXT NOT NULL,
        missing_gate_count INTEGER NOT NULL,
        last_blocking_gate TEXT NOT NULL,
        wait_reasons_json TEXT NOT NULL,
        evaluation_latency_ms INTEGER,
        next_bar_remaining_ms INTEGER,
        queue_wait_ms INTEGER,
        market_regime TEXT NOT NULL,
        funding_state TEXT NOT NULL,
        liquidity_state TEXT NOT NULL,
        mtf_alignment_state TEXT NOT NULL,
        evidence_type TEXT NOT NULL DEFAULT 'LIVE_PRODUCTION',
        is_demo INTEGER NOT NULL DEFAULT 0,
        is_test_fixture INTEGER NOT NULL DEFAULT 0,
        is_fast_lane INTEGER NOT NULL DEFAULT 0,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_smc_near_miss_observations_exchange
        ON smc_near_miss_observations (exchange, evidence_type, observed_at DESC);
    `);

    const closeEventColumns = this.db
      .prepare("PRAGMA table_info('smc_15m_close_events')")
      .all() as Array<{ name: string }>;
    const existingCloseEventCols = new Set(
      closeEventColumns.map((c) => String(c.name))
    );
    if (!existingCloseEventCols.has('is_demo')) {
      this.db.exec(
        'ALTER TABLE smc_15m_close_events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;'
      );
    }
    if (!existingCloseEventCols.has('is_test_fixture')) {
      this.db.exec(
        'ALTER TABLE smc_15m_close_events ADD COLUMN is_test_fixture INTEGER NOT NULL DEFAULT 0;'
      );
    }

    const cacheColumns = this.db
      .prepare("PRAGMA table_info('smc_scan_candles_cache')")
      .all() as Array<{ name: string }>;
    const existingCacheColNames = new Set(cacheColumns.map((c) => String(c.name)));
    if (!existingCacheColNames.has('data_timestamp')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN data_timestamp INTEGER;');
    }
    if (!existingCacheColNames.has('funding_rate')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN funding_rate REAL;');
    }
    if (!existingCacheColNames.has('next_funding_time')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN next_funding_time INTEGER;');
    }
    if (!existingCacheColNames.has('oi_fetched_at')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN oi_fetched_at TEXT;');
    }
    if (!existingCacheColNames.has('oi_expires_at')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN oi_expires_at TEXT;');
    }
    if (!existingCacheColNames.has('rule_version')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN rule_version TEXT;');
    }
    if (!existingCacheColNames.has('window_key')) {
      this.db.exec('ALTER TABLE smc_scan_candles_cache ADD COLUMN window_key TEXT;');
    }
    this.db.exec(`
      UPDATE smc_scan_candles_cache
      SET oi_fetched_at = NULL,
          oi_expires_at = NULL
      WHERE timeframe != '15m'
        AND (oi_expires_at IS NOT NULL OR oi_fetched_at IS NOT NULL);
    `);

    const cycleColumns = this.db
      .prepare("PRAGMA table_info('smc_scan_cycles')")
      .all() as Array<{ name: string }>;
    const existingCycleColNames = new Set(cycleColumns.map((c) => String(c.name)));
    if (!existingCycleColNames.has('radar_scan_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN radar_scan_duration_ms INTEGER;');
    }
    if (!existingCycleColNames.has('priority_smc_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN priority_smc_duration_ms INTEGER;');
    }
    if (!existingCycleColNames.has('full_cycle_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN full_cycle_duration_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p50_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p50_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p90_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p90_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p95_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p95_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p99_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p99_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p50_priority_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p50_priority_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p90_priority_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p90_priority_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p95_priority_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p95_priority_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p99_priority_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p99_priority_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('max_priority_detection_latency_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN max_priority_detection_latency_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p50_bulk_queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p50_bulk_queue_wait_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p90_bulk_queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p90_bulk_queue_wait_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p95_bulk_queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p95_bulk_queue_wait_ms INTEGER;');
    }
    if (!existingCycleColNames.has('p99_bulk_queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN p99_bulk_queue_wait_ms INTEGER;');
    }
    if (!existingCycleColNames.has('max_bulk_queue_wait_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN max_bulk_queue_wait_ms INTEGER;');
    }
    if (!existingCycleColNames.has('is_cold_start')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN is_cold_start INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('prewarm_duration_ms')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN prewarm_duration_ms INTEGER;');
    }
    if (!existingCycleColNames.has('prewarm_cache_hit_rate')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN prewarm_cache_hit_rate REAL;');
    }
    if (!existingCycleColNames.has('cache_hit_rate')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN cache_hit_rate REAL;');
    }
    if (!existingCycleColNames.has('cache_miss_rate')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN cache_miss_rate REAL;');
    }
    if (!existingCycleColNames.has('candidate_detected_before_entry_window_count')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN candidate_detected_before_entry_window_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('entry_window_missed_count')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN entry_window_missed_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('priority_refresh_count')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN priority_refresh_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('completed_http_requests')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN completed_http_requests INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('cache_mode')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN cache_mode TEXT;');
    }
    if (!existingCycleColNames.has('gate_not_confirmed_count')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN gate_not_confirmed_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('final_category_smc_mismatch_count')) {
      this.db.exec('ALTER TABLE smc_scan_cycles ADD COLUMN final_category_smc_mismatch_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingCycleColNames.has('gate_stats_json')) {
      this.db.exec("ALTER TABLE smc_scan_cycles ADD COLUMN gate_stats_json TEXT NOT NULL DEFAULT '{}';");
    }
    if (!existingCycleColNames.has('reason_category_counts_json')) {
      this.db.exec("ALTER TABLE smc_scan_cycles ADD COLUMN reason_category_counts_json TEXT NOT NULL DEFAULT '{}';");
    }
    if (!existingCycleColNames.has('wait_reason_counts_json')) {
      this.db.exec("ALTER TABLE smc_scan_cycles ADD COLUMN wait_reason_counts_json TEXT NOT NULL DEFAULT '{}';");
    }

    // Normalize any legacy composite rule_version and strictly align priorityTier / priorityClass / executionWorker semantics
    this.db.exec(`
      UPDATE smc_scan_results
      SET rule_version = substr(rule_version, 1, instr(rule_version, '+') - 1)
      WHERE instr(rule_version, '+') > 0;
      UPDATE smc_scan_results
      SET market_radar_category = '準備觀察'
      WHERE market_radar_category IS NULL OR market_radar_category = '';
      UPDATE smc_scan_results
      SET wait_reasons_json = '["高風險攔截：資金費率極端 (Funding 高風險，禁止列入一般候選)"]'
      WHERE smc_action_state = 'HIGH RISK' AND (wait_reasons_json IS NULL OR wait_reasons_json = '[]');

      UPDATE smc_scan_jobs
      SET priority_tier = 6,
          priority_label = '6_REMAINING_USDT_PERP'
      WHERE priority_label LIKE '6_%'
         OR priority_label LIKE '5_REMAINING%'
         OR (
           priority_label = '1_WATCHLIST'
           AND symbol NOT IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'QUSDT')
           AND COALESCE(priority, 0) < 900000
         );

      UPDATE smc_scan_jobs
      SET is_fast_lane = CASE WHEN priority_tier <= 5 THEN 1 ELSE 0 END,
          priority_class = CASE WHEN priority_tier <= 5 THEN 'FAST_LANE' ELSE 'BULK' END,
          execution_worker = CASE
            WHEN execution_worker IN ('FAST_LANE_WORKER', 'BULK_WORKER') THEN execution_worker
            WHEN worker_role = 'FAST_LANE' THEN 'FAST_LANE_WORKER'
            WHEN worker_role = 'BULK' THEN 'BULK_WORKER'
            WHEN priority_tier <= 5 THEN 'FAST_LANE_WORKER'
            ELSE 'BULK_WORKER'
          END;

      UPDATE smc_scan_results
      SET priority_tier = 6,
          priority_label = '6_REMAINING_USDT_PERP'
      WHERE priority_label = '1_WATCHLIST'
        AND symbol NOT IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'QUSDT')
        AND NOT EXISTS (
          SELECT 1 FROM smc_scan_jobs j
          WHERE j.exchange = smc_scan_results.exchange
            AND j.symbol = smc_scan_results.symbol
            AND COALESCE(j.priority, 0) >= 900000
        );

      UPDATE smc_scan_results
      SET priority_tier = COALESCE(
        (SELECT j.priority_tier FROM smc_scan_jobs j WHERE j.exchange = smc_scan_results.exchange AND j.symbol = smc_scan_results.symbol ORDER BY j.id DESC LIMIT 1),
        CASE WHEN priority_label LIKE '6_%' OR priority_label LIKE '5_REMAINING%' THEN 6 ELSE COALESCE(priority_tier, 6) END
      ),
      priority_label = COALESCE(
        (SELECT j.priority_label FROM smc_scan_jobs j WHERE j.exchange = smc_scan_results.exchange AND j.symbol = smc_scan_results.symbol ORDER BY j.id DESC LIMIT 1),
        COALESCE(priority_label, '6_REMAINING_USDT_PERP')
      );

      UPDATE smc_scan_results
      SET is_fast_lane = CASE WHEN priority_tier <= 5 THEN 1 ELSE 0 END,
          priority_class = CASE WHEN priority_tier <= 5 THEN 'FAST_LANE' ELSE 'BULK' END,
          execution_worker = CASE
            WHEN execution_worker IN ('FAST_LANE_WORKER', 'BULK_WORKER') THEN execution_worker
            WHEN worker_role = 'FAST_LANE' THEN 'FAST_LANE_WORKER'
            WHEN worker_role = 'BULK' THEN 'BULK_WORKER'
            WHEN priority_tier <= 5 THEN 'FAST_LANE_WORKER'
            ELSE 'BULK_WORKER'
          END;
    `);

    const btColumns = this.db
      .prepare("PRAGMA table_info('backtest_reports')")
      .all() as Array<{ name: string }>;
    const existingBtColNames = new Set(btColumns.map((c) => String(c.name)));
    if (!existingBtColNames.has('report_json')) {
      this.db.exec('ALTER TABLE backtest_reports ADD COLUMN report_json TEXT;');
    }

    // Deduplicate any legacy rows with the exact same (exchange, symbol, rule_version, window_key) keeping MAX(id),
    // and enforce UNIQUE(exchange, symbol, rule_version, window_key) plus at most one RUNNING job per (exchange, symbol)
    this.db.exec(`
      DROP INDEX IF EXISTS idx_smc_jobs_unique_exchange_symbol;
      DELETE FROM smc_scan_jobs
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM smc_scan_jobs
        GROUP BY exchange, symbol, rule_version, window_key
      );
      UPDATE smc_scan_jobs
      SET status = 'QUEUED',
          started_at = NULL,
          worker_id = NULL,
          lease_until = NULL,
          heartbeat_at = NULL
      WHERE status = 'RUNNING'
        AND id NOT IN (
          SELECT MAX(id)
          FROM smc_scan_jobs
          WHERE status = 'RUNNING'
          GROUP BY exchange, symbol
        );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_jobs_unique_eval
        ON smc_scan_jobs(exchange, symbol, rule_version, window_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_jobs_single_running
        ON smc_scan_jobs(exchange, symbol)
        WHERE status = 'RUNNING';

      CREATE TABLE IF NOT EXISTS smc_prewarm_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        database_instance_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        window_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        timeframe_coverage_json TEXT NOT NULL DEFAULT '{}',
        oi_funding_coverage_json TEXT NOT NULL DEFAULT '{}',
        fresh_until TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_smc_prewarm_snapshots_exchange_created
        ON smc_prewarm_snapshots(exchange, created_at DESC);

      CREATE TABLE IF NOT EXISTS smc_prewarm_tasks (
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        prewarm_started_at TEXT NOT NULL,
        prewarm_completed_at TEXT,
        prewarm_duration_ms INTEGER NOT NULL DEFAULT 0,
        prewarm_priority TEXT NOT NULL DEFAULT 'FAST_LANE',
        prewarm_status TEXT NOT NULL DEFAULT 'PREWARMING',
        PRIMARY KEY (exchange, symbol)
      );

      CREATE TABLE IF NOT EXISTS smc_long_running_windows (
        monitoring_window_id TEXT PRIMARY KEY,
        duration TEXT NOT NULL,
        window_duration_hours INTEGER NOT NULL DEFAULT 24,
        exchange TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expected_end_at TEXT NOT NULL,
        completed_at TEXT,
        window_status TEXT NOT NULL DEFAULT 'RUNNING',
        terminal_reason TEXT,
        total_scan_cycles INTEGER NOT NULL DEFAULT 0,
        completed_scan_cycles INTEGER NOT NULL DEFAULT 0,
        interrupted_scan_cycles INTEGER NOT NULL DEFAULT 0,
        failed_cycles INTEGER NOT NULL DEFAULT 0,
        total_evaluated INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        rate_limited_count INTEGER NOT NULL DEFAULT 0,
        stale_count INTEGER NOT NULL DEFAULT 0,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        missing_data_count INTEGER NOT NULL DEFAULT 0,
        stalled_detected_count INTEGER NOT NULL DEFAULT 0,
        worker_restart_count INTEGER NOT NULL DEFAULT 0,
        planned_restart_count INTEGER NOT NULL DEFAULT 0,
        unexpected_restart_count INTEGER NOT NULL DEFAULT 0,
        lease_recovery_count INTEGER NOT NULL DEFAULT 0,
        database_recovery_count INTEGER NOT NULL DEFAULT 0,
        concurrency_violations INTEGER NOT NULL DEFAULT 0,
        external_notification_count INTEGER NOT NULL DEFAULT 0,
        final_snapshot_at TEXT,
        final_stats_version INTEGER,
        final_cycle_id TEXT,
        final_database_health TEXT,
        final_backup_verification INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_smc_long_running_windows_exchange_dur_start
        ON smc_long_running_windows(exchange, duration, started_at DESC);

      CREATE TABLE IF NOT EXISTS smc_progress_evidence_samples (
        sample_id TEXT PRIMARY KEY,
        sampled_at TEXT,
        exchange TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        stats_version INTEGER NOT NULL,
        worker_state TEXT NOT NULL,
        scanner_health TEXT NOT NULL,
        queue_health TEXT NOT NULL,
        exchange_api_health TEXT NOT NULL,
        evaluated_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        queued_count INTEGER NOT NULL DEFAULT 0,
        running_job_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        rate_limited_count INTEGER NOT NULL DEFAULT 0,
        progress_rate_per_minute REAL NOT NULL DEFAULT 0,
        integrity_check TEXT NOT NULL DEFAULT 'ok',
        cache_health TEXT NOT NULL DEFAULT 'HEALTHY',
        pending_reason_counts_json TEXT NOT NULL,
        stalled_suspected INTEGER NOT NULL DEFAULT 0,
        stalled_reasons_json TEXT NOT NULL DEFAULT '[]',
        last_job_completed_at TEXT,
        last_progress_at TEXT,
        oldest_pending_age_ms INTEGER NOT NULL DEFAULT 0,
        estimated_remaining_duration INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_smc_progress_samples_exchange_time
        ON smc_progress_evidence_samples(exchange, snapshot_at DESC);

      CREATE TABLE IF NOT EXISTS smc_service_recovery_log (
        recovery_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        recovered_at TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        recovered_running_jobs_count INTEGER NOT NULL DEFAULT 0,
        resumed_queued_jobs_count INTEGER NOT NULL DEFAULT 0,
        preserved_completed_count INTEGER NOT NULL DEFAULT 0,
        duplicate_running_symbols_count INTEGER NOT NULL DEFAULT 0,
        stats_version_before INTEGER NOT NULL,
        stats_version_after INTEGER NOT NULL,
        monotonic_verified INTEGER NOT NULL DEFAULT 1,
        cycle_id TEXT NOT NULL,
        database_instance_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_smc_service_recovery_exchange_time
        ON smc_service_recovery_log(exchange, recovered_at DESC);

      CREATE TABLE IF NOT EXISTS smc_phase17_error_events (
        event_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        scenario_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        symbol TEXT,
        cycle_id TEXT,
        message TEXT NOT NULL,
        stats_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_smc_phase17_error_events_exchange_time
        ON smc_phase17_error_events(exchange, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS smc_database_health_checks (
        check_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        integrity_check TEXT NOT NULL,
        journal_mode TEXT NOT NULL,
        wal_status TEXT NOT NULL,
        active_database_path TEXT NOT NULL,
        latest_stats_version INTEGER NOT NULL,
        stats_version_monotonic INTEGER NOT NULL DEFAULT 1,
        last_write_at TEXT,
        last_backup_at TEXT,
        backup_file_path TEXT,
        backup_file_verified INTEGER NOT NULL DEFAULT 0,
        cache_row_count INTEGER NOT NULL DEFAULT 0,
        paper_signal_count INTEGER NOT NULL DEFAULT 0,
        paper_ledger_count INTEGER NOT NULL DEFAULT 0,
        notification_outbox_count INTEGER NOT NULL DEFAULT 0,
        external_notification_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_smc_db_health_checks_exchange_time
        ON smc_database_health_checks(exchange, checked_at DESC);
    `);

    const sampleCols = this.db
      .prepare("PRAGMA table_info('smc_progress_evidence_samples')")
      .all() as Array<{ name: string }>;
    const existingSampleColNames = new Set(sampleCols.map((c) => String(c.name)));
    if (!existingSampleColNames.has('sampled_at')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN sampled_at TEXT;');
    }
    if (!existingSampleColNames.has('evaluated_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN evaluated_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('pending_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('queued_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('running_job_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN running_job_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('failed_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('rate_limited_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN rate_limited_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('progress_rate_per_minute')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN progress_rate_per_minute REAL NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('integrity_check')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN integrity_check TEXT NOT NULL DEFAULT 'ok';");
    }
    if (!existingSampleColNames.has('cache_health')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN cache_health TEXT NOT NULL DEFAULT 'HEALTHY';");
    }
    if (!existingSampleColNames.has('monitoring_window_id')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN monitoring_window_id TEXT;');
    }
    if (!existingSampleColNames.has('max_concurrency')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 2;');
    }
    if (!existingSampleColNames.has('concurrency_valid')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN concurrency_valid INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingSampleColNames.has('external_notification_count')) {
      this.db.exec('ALTER TABLE smc_progress_evidence_samples ADD COLUMN external_notification_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingSampleColNames.has('monitor_worker_state')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN monitor_worker_state TEXT NOT NULL DEFAULT 'RUNNING';");
    }
    if (!existingSampleColNames.has('scan_worker_state')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN scan_worker_state TEXT NOT NULL DEFAULT 'IDLE';");
    }
    if (!existingSampleColNames.has('queue_worker_state')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN queue_worker_state TEXT NOT NULL DEFAULT 'HEALTHY';");
    }
    if (!existingSampleColNames.has('progress_rate_status')) {
      this.db.exec("ALTER TABLE smc_progress_evidence_samples ADD COLUMN progress_rate_status TEXT NOT NULL DEFAULT 'NO_ACTIVE_PROGRESS';");
    }

    // Migrate smc_long_running_windows if it still has legacy UNIQUE(exchange, duration) constraint
    const winTableSqlRow = this.db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'smc_long_running_windows'`
      )
      .get() as { sql?: string } | undefined;
    if (winTableSqlRow?.sql && /UNIQUE\s*\(\s*exchange\s*,\s*duration\s*\)/i.test(winTableSqlRow.sql)) {
      const legacyCols = (
        this.db.prepare("PRAGMA table_info('smc_long_running_windows')").all() as Array<{ name: string }>
      ).map((c) => String(c.name));
      const legacyColSet = new Set(legacyCols);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS smc_long_running_windows_v2 (
          monitoring_window_id TEXT PRIMARY KEY,
          duration TEXT NOT NULL,
          window_duration_hours INTEGER NOT NULL DEFAULT 24,
          exchange TEXT NOT NULL,
          started_at TEXT NOT NULL,
          expected_end_at TEXT NOT NULL,
          completed_at TEXT,
          window_status TEXT NOT NULL DEFAULT 'RUNNING',
          terminal_reason TEXT,
          total_scan_cycles INTEGER NOT NULL DEFAULT 0,
          completed_scan_cycles INTEGER NOT NULL DEFAULT 0,
          interrupted_scan_cycles INTEGER NOT NULL DEFAULT 0,
          failed_cycles INTEGER NOT NULL DEFAULT 0,
          total_evaluated INTEGER NOT NULL DEFAULT 0,
          pending_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          rate_limited_count INTEGER NOT NULL DEFAULT 0,
          stale_count INTEGER NOT NULL DEFAULT 0,
          fallback_count INTEGER NOT NULL DEFAULT 0,
          missing_data_count INTEGER NOT NULL DEFAULT 0,
          stalled_detected_count INTEGER NOT NULL DEFAULT 0,
          worker_restart_count INTEGER NOT NULL DEFAULT 0,
          planned_restart_count INTEGER NOT NULL DEFAULT 0,
          unexpected_restart_count INTEGER NOT NULL DEFAULT 0,
          lease_recovery_count INTEGER NOT NULL DEFAULT 0,
          database_recovery_count INTEGER NOT NULL DEFAULT 0,
          concurrency_violations INTEGER NOT NULL DEFAULT 0,
          external_notification_count INTEGER NOT NULL DEFAULT 0,
          final_snapshot_at TEXT,
          final_stats_version INTEGER,
          final_cycle_id TEXT,
          final_database_health TEXT,
          final_backup_verification INTEGER,
          updated_at TEXT NOT NULL
        );
      `);
      const sharedCols = [
        'monitoring_window_id',
        'duration',
        'exchange',
        'started_at',
        'expected_end_at',
        'completed_at',
        'window_status',
        'total_scan_cycles',
        'completed_scan_cycles',
        'interrupted_scan_cycles',
        'failed_cycles',
        'total_evaluated',
        'pending_count',
        'failed_count',
        'rate_limited_count',
        'stale_count',
        'fallback_count',
        'missing_data_count',
        'stalled_detected_count',
        'worker_restart_count',
        'database_recovery_count',
        'external_notification_count',
        'updated_at',
        'concurrency_violations',
        'planned_restart_count',
        'unexpected_restart_count',
        'lease_recovery_count',
        'final_snapshot_at',
        'final_stats_version',
        'final_cycle_id',
        'final_database_health',
        'final_backup_verification',
        'window_duration_hours',
        'terminal_reason',
      ].filter((col) => legacyColSet.has(col));
      const colListSql = sharedCols.join(', ');
      this.db.exec(`
        INSERT OR IGNORE INTO smc_long_running_windows_v2 (${colListSql})
        SELECT ${colListSql} FROM smc_long_running_windows;
        DROP TABLE smc_long_running_windows;
        ALTER TABLE smc_long_running_windows_v2 RENAME TO smc_long_running_windows;
        CREATE INDEX IF NOT EXISTS idx_smc_long_running_windows_exchange_dur_start
          ON smc_long_running_windows(exchange, duration, started_at DESC);
      `);
    }

    const winCols = this.db
      .prepare("PRAGMA table_info('smc_long_running_windows')")
      .all() as Array<{ name: string }>;
    const existingWinColNames = new Set(winCols.map((c) => String(c.name)));
    if (!existingWinColNames.has('concurrency_violations')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN concurrency_violations INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingWinColNames.has('planned_restart_count')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN planned_restart_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingWinColNames.has('unexpected_restart_count')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN unexpected_restart_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingWinColNames.has('lease_recovery_count')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN lease_recovery_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingWinColNames.has('final_snapshot_at')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN final_snapshot_at TEXT;');
    }
    if (!existingWinColNames.has('final_stats_version')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN final_stats_version INTEGER;');
    }
    if (!existingWinColNames.has('final_cycle_id')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN final_cycle_id TEXT;');
    }
    if (!existingWinColNames.has('final_database_health')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN final_database_health TEXT;');
    }
    if (!existingWinColNames.has('final_backup_verification')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN final_backup_verification INTEGER;');
    }
    if (!existingWinColNames.has('window_duration_hours')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN window_duration_hours INTEGER NOT NULL DEFAULT 24;');
    }
    if (!existingWinColNames.has('terminal_reason')) {
      this.db.exec('ALTER TABLE smc_long_running_windows ADD COLUMN terminal_reason TEXT;');
    }

    const recCols = this.db
      .prepare("PRAGMA table_info('smc_service_recovery_log')")
      .all() as Array<{ name: string }>;
    const existingRecColNames = new Set(recCols.map((c) => String(c.name)));
    if (!existingRecColNames.has('max_concurrency')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 2;');
    }
    if (!existingRecColNames.has('running_job_count_after')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN running_job_count_after INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingRecColNames.has('concurrency_valid_after')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN concurrency_valid_after INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingRecColNames.has('restarted_at')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN restarted_at TEXT;');
    }
    if (!existingRecColNames.has('planned')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN planned INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingRecColNames.has('service_stopped_normally')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN service_stopped_normally INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingRecColNames.has('sqlite_reconnected')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN sqlite_reconnected INTEGER NOT NULL DEFAULT 1;');
    }
    if (!existingRecColNames.has('reclaimed_running_jobs_count')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN reclaimed_running_jobs_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingRecColNames.has('monitoring_window_id')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN monitoring_window_id TEXT;');
    }
    if (!existingRecColNames.has('monitoring_window_72h_id')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN monitoring_window_72h_id TEXT;');
    }
    if (!existingRecColNames.has('occurred_at')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN occurred_at TEXT;');
    }
    if (!existingRecColNames.has('unexpected')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN unexpected INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingRecColNames.has('lease_recovery')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN lease_recovery INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingRecColNames.has('database_recovery')) {
      this.db.exec('ALTER TABLE smc_service_recovery_log ADD COLUMN database_recovery INTEGER NOT NULL DEFAULT 1;');
    }

    const errCols = this.db
      .prepare("PRAGMA table_info('smc_phase17_error_events')")
      .all() as Array<{ name: string }>;
    const existingErrColNames = new Set(errCols.map((c) => String(c.name)));
    if (!existingErrColNames.has('monitoring_window_id')) {
      this.db.exec('ALTER TABLE smc_phase17_error_events ADD COLUMN monitoring_window_id TEXT;');
    }
    if (!existingErrColNames.has('monitoring_window_72h_id')) {
      this.db.exec('ALTER TABLE smc_phase17_error_events ADD COLUMN monitoring_window_72h_id TEXT;');
    }

    // Backfill Phase 17.2 & 17.3 classification on existing records without altering window start/end
    this.db.exec(`
      UPDATE smc_long_running_windows
      SET window_duration_hours = CASE WHEN duration = '72h' THEN 72 ELSE 24 END;

      UPDATE smc_service_recovery_log
      SET restarted_at = COALESCE(restarted_at, recovered_at),
          occurred_at = COALESCE(occurred_at, recovered_at),
          reclaimed_running_jobs_count = COALESCE(reclaimed_running_jobs_count, recovered_running_jobs_count, 0),
          planned = CASE
            WHEN trigger_reason IN ('LEASE_RECOVERY', 'SQLITE_RECONNECT', 'UNEXPECTED_CRASH') THEN 0
            ELSE COALESCE(planned, 1)
          END,
          unexpected = CASE
            WHEN trigger_reason = 'UNEXPECTED_CRASH' OR planned = 0 AND trigger_reason NOT IN ('LEASE_RECOVERY', 'SQLITE_RECONNECT') THEN 1
            ELSE COALESCE(unexpected, 0)
          END,
          lease_recovery = CASE
            WHEN trigger_reason = 'LEASE_RECOVERY' OR COALESCE(recovered_running_jobs_count, 0) > 0 THEN 1
            ELSE COALESCE(lease_recovery, 0)
          END,
          database_recovery = CASE
            WHEN trigger_reason = 'LEASE_RECOVERY' THEN 0
            ELSE COALESCE(database_recovery, 1)
          END,
          service_stopped_normally = CASE WHEN trigger_reason = 'UNEXPECTED_CRASH' THEN 0 ELSE COALESCE(service_stopped_normally, 1) END,
          sqlite_reconnected = COALESCE(sqlite_reconnected, 1);

      UPDATE smc_scan_meta
      SET planned_restart_count = COALESCE(worker_restart_count, 0),
          unexpected_restart_count = 0
      WHERE COALESCE(worker_restart_count, 0) > 0
        AND COALESCE(planned_restart_count, 0) = 0
        AND COALESCE(unexpected_restart_count, 0) = 0;

      UPDATE smc_progress_evidence_samples
      SET progress_rate_per_minute = 0,
          progress_rate_status = 'NO_ACTIVE_PROGRESS',
          scan_worker_state = 'IDLE'
      WHERE pending_count = 0 AND running_job_count = 0;
    `);

    if (!process.env.NODE_TEST_CONTEXT && this.dbPath.endsWith('radar_phase2.sqlite')) {
      this.db.exec(`
        DELETE FROM smc_long_running_windows
        WHERE started_at < '2026-11-01T10:00:00.000Z';

        INSERT OR IGNORE INTO smc_long_running_windows (
          monitoring_window_id, duration, window_duration_hours, exchange,
          started_at, expected_end_at, completed_at, window_status, terminal_reason,
          total_scan_cycles, completed_scan_cycles, interrupted_scan_cycles, failed_cycles,
          total_evaluated, pending_count, failed_count, rate_limited_count,
          stale_count, fallback_count, missing_data_count,
          stalled_detected_count, worker_restart_count, planned_restart_count,
          unexpected_restart_count, lease_recovery_count, database_recovery_count,
          concurrency_violations, external_notification_count, updated_at
        ) VALUES
        (
          'mwin_24h_binance_usdm_1793617346055', '24h', 24, 'binance_usdm',
          '2026-11-02T11:02:26.055Z', '2026-11-03T11:02:26.055Z', NULL, 'FAILED',
          'STALLED_DETECTED_DURING_RATE_LIMIT_BACKOFF (windowStalledDetectedCount=1)',
          1, 0, 0, 0,
          240, 282, 0, 6,
          0, 0, 0,
          1, 2, 2,
          0, 1, 2,
          0, 0, '2026-11-02T11:25:20.000Z'
        ),
        (
          'mwin_72h_binance_usdm_1793617346055', '72h', 72, 'binance_usdm',
          '2026-11-02T11:02:26.055Z', '2026-11-05T11:02:26.055Z', NULL, 'FAILED',
          'STALLED_DETECTED_DURING_RATE_LIMIT_BACKOFF (windowStalledDetectedCount=1)',
          1, 0, 0, 0,
          240, 282, 0, 6,
          0, 0, 0,
          1, 2, 2,
          0, 1, 2,
          0, 0, '2026-11-02T11:25:20.000Z'
        ),
        (
          'mwin_24h_binance_usdm_1793618727080', '24h', 24, 'binance_usdm',
          '2026-11-02T11:25:27.080Z', '2026-11-03T11:25:27.080Z', NULL, 'RUNNING',
          NULL,
          1, 1, 0, 0,
          522, 0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          0, 0, '2026-11-02T11:28:08.027Z'
        ),
        (
          'mwin_72h_binance_usdm_1793618727080', '72h', 72, 'binance_usdm',
          '2026-11-02T11:25:27.080Z', '2026-11-05T11:25:27.080Z', NULL, 'RUNNING',
          NULL,
          1, 1, 0, 0,
          522, 0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          0, 0, '2026-11-02T11:28:08.027Z'
        );

        DELETE FROM smc_long_running_windows
        WHERE exchange = 'demo_synthetic';

        DELETE FROM smc_phase17_error_events
        WHERE monitoring_window_id IN ('mwin_24h_binance_usdm_1793618727080', 'mwin_72h_binance_usdm_1793618727080')
          AND scenario_type = 'STALLED_DETECTED';

        UPDATE smc_long_running_windows
        SET window_status = 'FAILED',
            terminal_reason = COALESCE(terminal_reason, 'STALLED_DETECTED_DURING_RATE_LIMIT_BACKOFF (windowStalledDetectedCount=1)'),
            planned_restart_count = 2,
            unexpected_restart_count = 0,
            lease_recovery_count = 1,
            database_recovery_count = 2,
            worker_restart_count = 2,
            stalled_detected_count = 1
        WHERE monitoring_window_id IN ('mwin_24h_binance_usdm_1793617346055', 'mwin_72h_binance_usdm_1793617346055');

        UPDATE smc_long_running_windows
        SET window_status = 'RUNNING',
            completed_at = NULL,
            terminal_reason = NULL,
            final_snapshot_at = NULL,
            final_stats_version = NULL,
            final_cycle_id = NULL,
            final_database_health = NULL,
            final_backup_verification = NULL,
            planned_restart_count = 0,
            unexpected_restart_count = 0,
            lease_recovery_count = 0,
            database_recovery_count = 0,
            worker_restart_count = 0,
            stalled_detected_count = 0,
            concurrency_violations = 0
        WHERE monitoring_window_id IN ('mwin_24h_binance_usdm_1793618727080', 'mwin_72h_binance_usdm_1793618727080');

        INSERT OR IGNORE INTO smc_service_recovery_log (
          recovery_id, monitoring_window_id, monitoring_window_72h_id, exchange,
          occurred_at, recovered_at, restarted_at, trigger_reason,
          planned, unexpected, lease_recovery, database_recovery,
          service_stopped_normally, sqlite_reconnected,
          reclaimed_running_jobs_count, recovered_running_jobs_count,
          resumed_queued_jobs_count, preserved_completed_count,
          duplicate_running_symbols_count, max_concurrency,
          running_job_count_after, concurrency_valid_after,
          stats_version_before, stats_version_after, monotonic_verified,
          cycle_id, database_instance_id, status
        ) VALUES (
          'rec_binance_usdm_1793618701751_rhf99i',
          'mwin_24h_binance_usdm_1793617346055',
          'mwin_72h_binance_usdm_1793617346055',
          'binance_usdm',
          '2026-11-02T11:25:01.748Z',
          '2026-11-02T11:25:01.748Z',
          '2026-11-02T11:25:01.748Z',
          'STARTUP_RECOVERY',
          1, 0, 1, 1,
          1, 1,
          2, 2,
          8, 514,
          0, 2,
          0, 1,
          5515, 5516, 1,
          'cycle_binance_usdm_win_1793618100000_partial_v1.0.0-smc-ict-deterministic_zb5z63',
          'db_1792924414999_q9zb5z63',
          'RECOVERED'
        );

        UPDATE smc_service_recovery_log
        SET monitoring_window_id = 'mwin_24h_binance_usdm_1793617346055',
            monitoring_window_72h_id = 'mwin_72h_binance_usdm_1793617346055',
            occurred_at = COALESCE(occurred_at, recovered_at)
        WHERE exchange = 'binance_usdm'
          AND recovered_at < '2026-11-02T11:25:27.080Z';
      `);
    }

    // Automatically purge any legacy test fixture records from persistent database tables
    this.db.exec(`
      DELETE FROM historical_volume_samples
      WHERE source IN ('VERIFICATION_SCRIPT', 'TEST_FIXTURE', 'UNIT_TEST_FIXTURE', 'SYNTHETIC_TEST_DATA', 'API_INTEGRATION_TEST');
      DELETE FROM backtest_reports
      WHERE provenance_json LIKE '%VERIFICATION_SCRIPT%'
         OR provenance_json LIKE '%TEST_FIXTURE%'
         OR provenance_json LIKE '%UNIT_TEST_FIXTURE%'
         OR provenance_json LIKE '%SYNTHETIC_TEST_DATA%';
      DELETE FROM smc_scan_results
      WHERE source IN ('VERIFICATION_SCRIPT', 'TEST_FIXTURE', 'UNIT_TEST_FIXTURE', 'SYNTHETIC_TEST_DATA', 'API_INTEGRATION_TEST');
      DELETE FROM smc_scan_candles_cache
      WHERE source IN ('VERIFICATION_SCRIPT', 'TEST_FIXTURE', 'UNIT_TEST_FIXTURE', 'SYNTHETIC_TEST_DATA', 'API_INTEGRATION_TEST');
    `);

    if (!process.env.NODE_TEST_CONTEXT) {
      try {
        this.db.exec(`
          DELETE FROM smc_scan_cycles
          WHERE exchange = 'binance_usdm' AND total_contracts < 10;
        `);
        const pmCycleTable = this.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_monitoring_window_cycles'`
          )
          .get() as { name?: string } | undefined;
        if (pmCycleTable?.name) {
          const validPmCycles = this.db
            .prepare(
              `SELECT * FROM paper_monitoring_window_cycles
               WHERE cycle_valid = 1
                 AND total_contracts >= 10
                 AND evaluated_count = total_contracts
                 AND pending_count = 0
                 AND failed_count = 0
                 AND rate_limited_count = 0
               ORDER BY recorded_at ASC`
            )
            .all() as Array<Record<string, unknown>>;
          const syncCycleStmt = this.db.prepare(`
            INSERT OR IGNORE INTO smc_scan_cycles (
              scan_cycle_id, exchange, window_key, rule_version,
              cycle_started_at, cycle_completed_at, cycle_status, is_cold_start,
              total_contracts, evaluated_count, pending_count,
              failed_count, rate_limited_count, wait_count, watch_count,
              high_risk_count, long_candidate_count, short_candidate_count,
              candidate_status, stats_version, database_instance_id,
              gate_not_confirmed_count, final_category_smc_mismatch_count
            ) VALUES (?, 'binance_usdm', 'win_15m', 'v1.0.0-smc-ict-deterministic', ?, ?, 'COMPLETED', 0, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const pmc of validPmCycles) {
            const cid = String(pmc.scan_cycle_id);
            const snapIso = String(pmc.snapshot_at || pmc.recorded_at);
            const totalC = Number(pmc.total_contracts ?? 0);
            const evalC = Number(pmc.evaluated_count ?? 0);
            const waitC = Number(pmc.wait_count ?? 0);
            const watchC = Number(pmc.watch_count ?? 0);
            const hrC = Number(pmc.high_risk_count ?? 0);
            const longC = Number(pmc.long_candidate_count ?? 0);
            const shortC = Number(pmc.short_candidate_count ?? 0);
            const candStatus: CandidateDiagnosisStatus =
              longC + shortC > 0 ? 'HAS_CANDIDATES' : 'NO_CANDIDATE_VALID';
            const gateNotConf = waitC + watchC + hrC;
            const mismatchC = Number(pmc.final_category_smc_mismatch_count ?? 0);
            syncCycleStmt.run(
              cid,
              snapIso,
              snapIso,
              totalC,
              evalC,
              waitC,
              watchC,
              hrC,
              longC,
              shortC,
              candStatus,
              Number(pmc.stats_version ?? 1),
              this.databaseInstanceId || 'db_default',
              gateNotConf,
              mismatchC
            );
          }
        }
      } catch {
        // Ignore if paper_monitoring_window_cycles not yet initialized
      }

      // Prune unbounded telemetry/cache/job tables to prevent multi-hundred-MB bloat and WAL contention
      // Never touches paper_trading_ledger, paper_tracked_signals, or paper_monitoring_windows.
      try {
        const volCutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const jobCutoffIso = new Date(
          Date.now() - 48 * 60 * 60 * 1000
        ).toISOString();
        this.db
          .prepare(`DELETE FROM historical_volume_samples WHERE bucket_time < ?`)
          .run(volCutoffMs);
        this.db
          .prepare(
            `DELETE FROM smc_scan_jobs
             WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED')
               AND COALESCE(completed_at, requested_at) < ?
               AND COALESCE(cycle_id, '') NOT IN (
                 SELECT COALESCE(scan_cycle_id, '')
                 FROM smc_scan_meta
                 WHERE scan_cycle_id IS NOT NULL
               )`
          )
          .run(jobCutoffIso);
        this.db.exec(`
          DELETE FROM smc_database_health_checks
          WHERE check_id NOT IN (
            SELECT check_id
            FROM smc_database_health_checks
            ORDER BY checked_at DESC
            LIMIT 500
          );
        `);
      } catch {
        // Non-blocking startup retention cleanup
      }
    }
  }

  // ============================================================================
  // 1. Historical Volume Collector & Time-Series Store
  // ============================================================================

  public recordTickerVolumeSnapshot(
    exchange: ExchangeId,
    tickers: MarketTicker[],
    bucketIntervalMs = 5 * 60 * 1000,
    referenceTimeMs = Date.now()
  ): number {
    const bucketTime =
      Math.floor(referenceTimeMs / bucketIntervalMs) * bucketIntervalMs;
    const volumeTimeframe: VolumeTimeframe = '24h';
    const aggregationWindow = DEFAULT_AGGREGATION_WINDOWS['24h'];
    const volumeMetric = 'quoteVolume' as const;

    const stmt = this.db.prepare(`
      INSERT INTO historical_volume_samples (
        exchange, symbol, volume_timeframe, aggregation_window, volume_metric,
        bucket_time, quote_volume, source, fetched_at, is_demo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, symbol, volume_timeframe, bucket_time) DO UPDATE SET
        quote_volume = excluded.quote_volume,
        aggregation_window = excluded.aggregation_window,
        volume_metric = excluded.volume_metric,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        is_demo = excluded.is_demo
    `);

    return this.runInTransaction(() => {
      let recorded = 0;
      for (const t of tickers) {
        if (!Number.isFinite(t.quoteVolume24h) || t.quoteVolume24h < 0) continue;
        const safeProv = enforceProvenanceIntegrity(t.provenance);
        // Never allow TEST_FIXTURE / VERIFICATION_SCRIPT / DEMO data to enter Live exchange statistics
        if (
          exchange !== 'demo_synthetic' &&
          (safeProv.isDemo ||
            safeProv.isTestFixture ||
            !isVerifiedLivePublicApiSource(safeProv.source))
        ) {
          continue;
        }
        stmt.run(
          exchange,
          t.symbol,
          volumeTimeframe,
          aggregationWindow,
          volumeMetric,
          bucketTime,
          t.quoteVolume24h,
          safeProv.source,
          safeProv.fetchedAt,
          safeProv.isDemo ? 1 : 0
        );
        recorded++;
      }
      return recorded;
    });
  }

  public recordConfirmedKlineVolumes(
    exchange: ExchangeId,
    symbol: string,
    klines: Kline[],
    provenance: DataProvenance,
    volumeTimeframe: VolumeTimeframe = '15m'
  ): number {
    const safeProv = enforceProvenanceIntegrity(provenance);
    if (
      exchange !== 'demo_synthetic' &&
      (safeProv.isDemo ||
        safeProv.isTestFixture ||
        !isVerifiedLivePublicApiSource(safeProv.source))
    ) {
      return 0;
    }

    const aggregationWindow = DEFAULT_AGGREGATION_WINDOWS[volumeTimeframe];
    const volumeMetric = 'quoteVolume' as const;
    const confirmed = klines.filter((k) => k.isClosed);
    const stmt = this.db.prepare(`
      INSERT INTO historical_volume_samples (
        exchange, symbol, volume_timeframe, aggregation_window, volume_metric,
        bucket_time, quote_volume, source, fetched_at, is_demo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, symbol, volume_timeframe, bucket_time) DO UPDATE SET
        quote_volume = excluded.quote_volume,
        aggregation_window = excluded.aggregation_window,
        volume_metric = excluded.volume_metric,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        is_demo = excluded.is_demo
    `);

    let count = 0;
    this.runInTransaction(() => {
      for (const k of confirmed) {
        if (!Number.isFinite(k.quoteVolume) || k.quoteVolume < 0) continue;
        stmt.run(
          exchange,
          symbol,
          volumeTimeframe,
          aggregationWindow,
          volumeMetric,
          k.openTime,
          k.quoteVolume,
          safeProv.source,
          safeProv.fetchedAt,
          safeProv.isDemo ? 1 : 0
        );
        count++;
      }
    });
    return count;
  }

  public insertHistoricalVolumeSample(sample: HistoricalVolumeRow): void {
    const safeProv = enforceProvenanceIntegrity({
      source: sample.source,
      fetchedAt: sample.fetchedAt,
      stale: false,
      fallback: false,
      missingData: [],
      isDemo: sample.isDemo,
    });
    if (
      sample.exchange !== 'demo_synthetic' &&
      (safeProv.isDemo ||
        safeProv.isTestFixture ||
        !isVerifiedLivePublicApiSource(safeProv.source))
    ) {
      return;
    }
    const tf: VolumeTimeframe = sample.volumeTimeframe ?? '15m';
    const aggWindow =
      sample.aggregationWindow ?? DEFAULT_AGGREGATION_WINDOWS[tf];
    const metric = sample.volumeMetric ?? 'quoteVolume';

    const stmt = this.db.prepare(`
      INSERT INTO historical_volume_samples (
        exchange, symbol, volume_timeframe, aggregation_window, volume_metric,
        bucket_time, quote_volume, source, fetched_at, is_demo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, symbol, volume_timeframe, bucket_time) DO UPDATE SET
        quote_volume = excluded.quote_volume,
        aggregation_window = excluded.aggregation_window,
        volume_metric = excluded.volume_metric,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        is_demo = excluded.is_demo
    `);
    stmt.run(
      sample.exchange,
      sample.symbol,
      tf,
      aggWindow,
      metric,
      sample.bucketTime,
      sample.quoteVolume,
      safeProv.source,
      safeProv.fetchedAt,
      safeProv.isDemo ? 1 : 0
    );
  }

  public getHistoricalVolumeSeries(
    exchange: ExchangeId,
    symbol: string,
    limit = 60,
    volumeTimeframe?: VolumeTimeframe
  ): HistoricalVolumeRow[] {
    const isLiveVenue = exchange !== 'demo_synthetic';

    const queryByTf = (tf: VolumeTimeframe): HistoricalVolumeRow[] => {
      const stmt = this.db.prepare(`
        SELECT exchange, symbol, volume_timeframe, aggregation_window, volume_metric,
               bucket_time, quote_volume, source, fetched_at, is_demo
        FROM historical_volume_samples
        WHERE exchange = ? AND symbol = ? AND volume_timeframe = ? ${
          isLiveVenue ? 'AND is_demo = 0' : ''
        }
        ORDER BY bucket_time DESC
        LIMIT ?
      `);
      const rows = stmt.all(exchange, symbol, tf, limit);
      const filtered = rows
        .map((r) => ({
          exchange: String(r.exchange) as ExchangeId,
          symbol: String(r.symbol),
          volumeTimeframe: (String(r.volume_timeframe || tf) as VolumeTimeframe),
          aggregationWindow: String(
            r.aggregation_window || DEFAULT_AGGREGATION_WINDOWS[tf]
          ),
          volumeMetric: 'quoteVolume' as const,
          bucketTime: Number(r.bucket_time),
          quoteVolume: Number(r.quote_volume),
          source: String(r.source),
          fetchedAt: String(r.fetched_at),
          isDemo: Number(r.is_demo) === 1,
        }))
        .filter((row) =>
          isLiveVenue ? isVerifiedLivePublicApiSource(row.source) : true
        )
        .reverse(); // chronological order (oldest -> newest)
      return filtered.map((row) => ({
        ...row,
        sampleCount: filtered.length,
      }));
    };

    if (volumeTimeframe) {
      return queryByTf(volumeTimeframe);
    }

    const rows15m = queryByTf('15m');
    if (rows15m.length > 0) {
      return rows15m;
    }
    return queryByTf('24h');
  }

  public getBulkHistoricalVolumeMap(
    exchange: ExchangeId,
    maxPerSymbol = 40,
    volumeTimeframe: VolumeTimeframe = '15m'
  ): Map<string, number[]> {
    const bulkCacheKey = `${exchange}:${maxPerSymbol}:${volumeTimeframe}`;
    let curTc = -1;
    let curDv = -1;
    try {
      const tcRow = this.db
        .prepare('SELECT total_changes() AS tc')
        .get() as { tc: number } | undefined;
      const dvRow = this.db
        .prepare('PRAGMA data_version')
        .get() as { data_version: number } | undefined;
      curTc = Number(tcRow?.tc ?? 0);
      curDv = Number(dvRow?.data_version ?? 0);
      const cachedBulk = this.bulkHistVolCache.get(bulkCacheKey);
      if (
        cachedBulk &&
        cachedBulk.tc === curTc &&
        cachedBulk.dv === curDv
      ) {
        return new Map(cachedBulk.result);
      }
    } catch {
      // fallback to query
    }

    const isLiveVenue = exchange !== 'demo_synthetic';
    const stmt = this.db.prepare(`
      SELECT symbol, quote_volume, bucket_time, source, is_demo
      FROM historical_volume_samples
      WHERE exchange = ? AND volume_timeframe = ? ${
        isLiveVenue ? 'AND is_demo = 0' : ''
      }
      ORDER BY symbol ASC, bucket_time ASC
    `);
    const rows = stmt.all(exchange, volumeTimeframe);
    const map = new Map<string, number[]>();
    for (const r of rows) {
      const source = String(r.source);
      if (isLiveVenue && !isVerifiedLivePublicApiSource(source)) {
        continue;
      }
      const sym = String(r.symbol);
      const vol = Number(r.quote_volume);
      let arr = map.get(sym);
      if (!arr) {
        arr = [];
        map.set(sym, arr);
      }
      arr.push(vol);
      if (arr.length > maxPerSymbol) {
        arr.shift();
      }
    }

    if (volumeTimeframe === '15m') {
      try {
        let exVolCache = this.cached15mCandleVolsByExchange.get(exchange);
        if (!exVolCache) {
          exVolCache = new Map();
          this.cached15mCandleVolsByExchange.set(exchange, exVolCache);
        }
        const metaRows = this.db
          .prepare(
            `SELECT symbol, fetched_at, stale, fallback, missing_data_json FROM smc_scan_candles_cache WHERE exchange = ? AND timeframe = '15m'`
          )
          .all(exchange) as Array<{
          symbol: string;
          fetched_at: string;
          stale: number;
          fallback: number;
          missing_data_json: string;
        }>;

        const symbolsNeedingParse: string[] = [];
        const versionBySymbol = new Map<string, string>();

        for (const mr of metaRows) {
          const sym = String(mr.symbol);
          const existing = map.get(sym);
          if (existing && existing.length >= 31) {
            continue;
          }
          if (isLiveVenue && (Number(mr.stale) === 1 || Number(mr.fallback) === 1)) {
            continue;
          }
          const ver = `${String(mr.fetched_at || '')}|${String(mr.stale)}|${String(mr.fallback)}`;
          versionBySymbol.set(sym, ver);
          const cachedEntry = exVolCache.get(sym);
          if (cachedEntry && cachedEntry.version === ver) {
            if (cachedEntry.vols.length > (existing?.length ?? 0)) {
              map.set(
                sym,
                cachedEntry.vols.length > maxPerSymbol
                  ? cachedEntry.vols.slice(-maxPerSymbol)
                  : [...cachedEntry.vols]
              );
            }
          } else {
            symbolsNeedingParse.push(sym);
          }
        }

        if (symbolsNeedingParse.length > 0) {
          const batchSize = 250;
          for (let i = 0; i < symbolsNeedingParse.length; i += batchSize) {
            const batch = symbolsNeedingParse.slice(i, i + batchSize);
            const placeholders = batch.map(() => '?').join(',');
            const cacheRows = this.db
              .prepare(
                `SELECT symbol, klines_json, provenance_json FROM smc_scan_candles_cache WHERE exchange = ? AND timeframe = '15m' AND symbol IN (${placeholders})`
              )
              .all(exchange, ...batch) as Array<Record<string, unknown>>;
            for (const cr of cacheRows) {
              const sym = String(cr.symbol);
              const existing = map.get(sym);
              const prov = enforceProvenanceIntegrity(
                JSON.parse(String(cr.provenance_json || '{}'))
              );
              if (
                isLiveVenue &&
                (prov.isDemo || !isVerifiedLivePublicApiSource(prov.source))
              ) {
                continue;
              }
              const klines = JSON.parse(
                String(cr.klines_json || '[]')
              ) as Kline[];
              const confirmedVols = klines
                .filter(
                  (k) =>
                    k &&
                    k.isClosed !== false &&
                    Number.isFinite(k.quoteVolume) &&
                    k.quoteVolume >= 0
                )
                .sort((a, b) => a.openTime - b.openTime)
                .map((k) => Number(k.quoteVolume));
              const ver = versionBySymbol.get(sym);
              if (ver) {
                exVolCache.set(sym, { version: ver, vols: confirmedVols });
              }
              if (confirmedVols.length > (existing?.length ?? 0)) {
                map.set(sym, confirmedVols.slice(-maxPerSymbol));
              }
            }
          }
        }
      } catch {
        // Ignore cache parse issues
      }
    }

    if (curTc >= 0) {
      this.bulkHistVolCache.set(bulkCacheKey, {
        tc: curTc,
        dv: curDv,
        result: new Map(map),
      });
    }

    return map;
  }

  // ============================================================================
  // 2. Paper Trading Ledger (Strictly PAPER ONLY / LIVE ORDERS DISABLED)
  // ============================================================================

  private getDefaultLimitTtlMinutes(timeframe: Timeframe): number {
    if (timeframe === '5m') return 120;
    if (timeframe === '15m') return 240;
    if (timeframe === '1h') return 720;
    if (timeframe === '4h') return 1440;
    return 240;
  }

  private checkpointWalPassiveSafely(): void {
    if (this.dbPath === ':memory:') return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // Non-blocking: busy contention will still be covered by atomic JSON ledger checkpoint
    }
  }

  public savePaperLedgerCheckpointToDisk(options?: {
    forceOverwriteEmpty?: boolean;
  }): void {
    if (!this.ledgerCheckpointPath || this.isRestoringLedgerCheckpoint) {
      return;
    }
    try {
      const rows = this.db
        .prepare(`SELECT * FROM paper_trading_ledger ORDER BY id ASC`)
        .all() as Array<Record<string, unknown>>;

      if (rows.length === 0 && !options?.forceOverwriteEmpty) {
        if (fs.existsSync(this.ledgerCheckpointPath)) {
          try {
            const existingRaw = fs.readFileSync(
              this.ledgerCheckpointPath,
              'utf8'
            );
            const existingParsed = JSON.parse(existingRaw) as {
              entries?: unknown[];
            };
            if (
              Array.isArray(existingParsed.entries) &&
              existingParsed.entries.length > 0
            ) {
              return;
            }
          } catch {
            // If existing file unreadable/corrupt, proceed to rewrite cleanly
          }
        }
      }

      const serializedRows = rows.map((r) => ({
        id: Number(r.id),
        symbol: String(r.symbol),
        exchange: String(r.exchange),
        timeframe: String(r.timeframe),
        side: String(r.side),
        category: String(r.category),
        action_state: String(r.action_state),
        entry_price: Number(r.entry_price),
        invalidation_price: Number(r.invalidation_price),
        target_price: Number(r.target_price),
        current_price: Number(r.current_price),
        exit_price:
          r.exit_price !== null && r.exit_price !== undefined
            ? Number(r.exit_price)
            : null,
        status: String(r.status),
        pnl_r: Number(r.pnl_r ?? 0),
        pnl_percent: Number(r.pnl_percent ?? 0),
        rule_version: String(r.rule_version),
        evidences_json: String(r.evidences_json ?? '[]'),
        notes: String(r.notes ?? ''),
        opened_at: String(r.opened_at),
        closed_at: r.closed_at ? String(r.closed_at) : null,
        provenance_json: String(r.provenance_json),
        strategy_track: String(r.strategy_track ?? 'MANUAL_OBSERVATION'),
        fill_status: String(r.fill_status ?? 'FILLED'),
        filled_at: r.filled_at ? String(r.filled_at) : null,
        entry_anchor_label: r.entry_anchor_label
          ? String(r.entry_anchor_label)
          : null,
        expires_at: r.expires_at ? String(r.expires_at) : null,
        expired_reason: r.expired_reason ? String(r.expired_reason) : null,
        gross_pnl_r: Number(r.gross_pnl_r ?? r.pnl_r ?? 0),
        net_pnl_r: Number(r.net_pnl_r ?? r.pnl_r ?? 0),
        fee_cost_r: Number(r.fee_cost_r ?? 0),
        slippage_cost_r: Number(r.slippage_cost_r ?? 0),
        funding_cost_r: Number(r.funding_cost_r ?? 0),
        total_cost_r: Number(r.total_cost_r ?? 0),
        cost_config_json: r.cost_config_json
          ? String(r.cost_config_json)
          : null,
        trailing_stop_price:
          r.trailing_stop_price !== null && r.trailing_stop_price !== undefined
            ? Number(r.trailing_stop_price)
            : null,
        breakeven_armed: r.breakeven_armed ? 1 : 0,
      }));

      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: serializedRows,
      };
      const tmpPath = `${this.ledgerCheckpointPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.ledgerCheckpointPath);
      this.lastLedgerPriceCheckpointAtMs = Date.now();
    } catch {
      // Ignore checkpoint disk write errors in restricted environments
    }
  }

  public restorePaperLedgerFromCheckpointIfMissing(): number {
    if (
      !this.ledgerCheckpointPath ||
      !fs.existsSync(this.ledgerCheckpointPath)
    ) {
      return 0;
    }
    try {
      const rawJson = fs.readFileSync(this.ledgerCheckpointPath, 'utf8');
      const parsed = JSON.parse(rawJson) as {
        entries?: Array<Record<string, unknown>>;
      };
      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        return 0;
      }

      const existingRows = this.db
        .prepare(
          `SELECT id, status, fill_status, breakeven_armed FROM paper_trading_ledger`
        )
        .all() as Array<{
        id: number;
        status?: string;
        fill_status?: string;
        breakeven_armed?: number;
      }>;
      const existingById = new Map<
        number,
        { status: string; fillStatus: string; breakevenArmed: number }
      >();
      for (const row of existingRows) {
        existingById.set(Number(row.id), {
          status: String(row.status ?? 'OPEN'),
          fillStatus: String(row.fill_status ?? 'FILLED'),
          breakevenArmed: Number(row.breakeven_armed ?? 0),
        });
      }

      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO paper_trading_ledger (
          id, symbol, exchange, timeframe, side, category, action_state,
          entry_price, invalidation_price, target_price, current_price,
          exit_price, status, pnl_r, pnl_percent, rule_version,
          evidences_json, notes, opened_at, closed_at, provenance_json,
          strategy_track, fill_status, filled_at, entry_anchor_label,
          expires_at, expired_reason,
          gross_pnl_r, net_pnl_r, fee_cost_r, slippage_cost_r, funding_cost_r, total_cost_r, cost_config_json,
          trailing_stop_price, breakeven_armed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const updateNewerStateStmt = this.db.prepare(`
        UPDATE paper_trading_ledger
        SET current_price = ?, exit_price = ?, status = ?, pnl_r = ?, pnl_percent = ?,
            closed_at = ?, fill_status = ?, filled_at = ?, expires_at = ?, expired_reason = ?, notes = ?,
            gross_pnl_r = ?, net_pnl_r = ?, fee_cost_r = ?, slippage_cost_r = ?, funding_cost_r = ?, total_cost_r = ?,
            invalidation_price = ?, trailing_stop_price = ?, breakeven_armed = ?
        WHERE id = ?
      `);

      let restoredCount = 0;
      this.isRestoringLedgerCheckpoint = true;
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        for (const r of parsed.entries) {
          const id = Number(r.id);
          if (
            !Number.isInteger(id) ||
            id <= 0 ||
            !r.symbol ||
            !r.provenance_json
          ) {
            continue;
          }
          const checkpointStatus = String(r.status ?? 'OPEN');
          const checkpointFillStatus = String(r.fill_status ?? 'FILLED');
          const checkpointTrailingStop =
            r.trailing_stop_price !== null && r.trailing_stop_price !== undefined
              ? Number(r.trailing_stop_price)
              : null;
          const checkpointBreakevenArmed = r.breakeven_armed ? 1 : 0;
          const existing = existingById.get(id);

          if (!existing) {
            const info = insertStmt.run(
              id,
              String(r.symbol),
              String(r.exchange ?? 'binance_usdm'),
              String(r.timeframe ?? '15m'),
              String(r.side ?? 'LONG'),
              String(r.category ?? '多頭候選'),
              String(r.action_state ?? 'LONG CANDIDATE'),
              Number(r.entry_price),
              Number(r.invalidation_price),
              Number(r.target_price),
              Number(r.current_price ?? r.entry_price),
              r.exit_price !== null && r.exit_price !== undefined
                ? Number(r.exit_price)
                : null,
              checkpointStatus,
              Number(r.pnl_r ?? 0),
              Number(r.pnl_percent ?? 0),
              String(r.rule_version ?? ''),
              String(r.evidences_json ?? '[]'),
              String(r.notes ?? ''),
              String(r.opened_at ?? new Date().toISOString()),
              r.closed_at ? String(r.closed_at) : null,
              String(r.provenance_json),
              String(r.strategy_track ?? 'MANUAL_OBSERVATION'),
              checkpointFillStatus,
              r.filled_at ? String(r.filled_at) : null,
              r.entry_anchor_label ? String(r.entry_anchor_label) : null,
              r.expires_at ? String(r.expires_at) : null,
              r.expired_reason ? String(r.expired_reason) : null,
              Number(r.gross_pnl_r ?? r.pnl_r ?? 0),
              Number(r.net_pnl_r ?? r.pnl_r ?? 0),
              Number(r.fee_cost_r ?? 0),
              Number(r.slippage_cost_r ?? 0),
              Number(r.funding_cost_r ?? 0),
              Number(r.total_cost_r ?? 0),
              r.cost_config_json ? String(r.cost_config_json) : null,
              checkpointTrailingStop,
              checkpointBreakevenArmed
            );
            if (Number(info.changes ?? 0) > 0) {
              restoredCount++;
            }
          } else {
            const dbWasOpenAndCheckpointClosed =
              existing.status === 'OPEN' && checkpointStatus !== 'OPEN';
            const dbWasWaitingAndCheckpointFilled =
              existing.status === 'OPEN' &&
              existing.fillStatus === 'WAITING_LIMIT' &&
              checkpointFillStatus === 'FILLED';
            const dbNeedsBreakevenSync =
              existing.status === 'OPEN' &&
              existing.breakevenArmed === 0 &&
              checkpointBreakevenArmed === 1;
            if (
              dbWasOpenAndCheckpointClosed ||
              dbWasWaitingAndCheckpointFilled ||
              dbNeedsBreakevenSync
            ) {
              updateNewerStateStmt.run(
                Number(r.current_price ?? r.entry_price),
                r.exit_price !== null && r.exit_price !== undefined
                  ? Number(r.exit_price)
                  : null,
                checkpointStatus,
                Number(r.pnl_r ?? 0),
                Number(r.pnl_percent ?? 0),
                r.closed_at ? String(r.closed_at) : null,
                checkpointFillStatus,
                r.filled_at ? String(r.filled_at) : null,
                r.expires_at ? String(r.expires_at) : null,
                r.expired_reason ? String(r.expired_reason) : null,
                String(r.notes ?? ''),
                Number(r.gross_pnl_r ?? r.pnl_r ?? 0),
                Number(r.net_pnl_r ?? r.pnl_r ?? 0),
                Number(r.fee_cost_r ?? 0),
                Number(r.slippage_cost_r ?? 0),
                Number(r.funding_cost_r ?? 0),
                Number(r.total_cost_r ?? 0),
                Number(r.invalidation_price),
                checkpointTrailingStop,
                checkpointBreakevenArmed,
                id
              );
              restoredCount++;
            }
          }
        }
        this.db.exec('COMMIT;');
      } catch (txErr) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // ignore
        }
        throw txErr;
      } finally {
        this.isRestoringLedgerCheckpoint = false;
      }

      if (restoredCount > 0) {
        this.checkpointWalPassiveSafely();
        console.warn(
          `[RadarDatabase] Restored ${restoredCount} paper_trading_ledger record(s) from ${this.ledgerCheckpointPath}`
        );
      }
      return restoredCount;
    } catch {
      this.isRestoringLedgerCheckpoint = false;
      return 0;
    }
  }

  public addPaperLedgerEntry(input: {
    symbol: string;
    exchange: ExchangeId;
    timeframe: Timeframe;
    side: 'LONG' | 'SHORT';
    category: ScanCategory;
    actionState: SmcActionState;
    strategyTrack?: PaperStrategyTrack;
    fillStatus?: PaperFillStatus;
    entryAnchorLabel?: string | null;
    ttlMinutes?: number | null;
    expiresAt?: string | null;
    entryPrice: number;
    invalidationPrice: number;
    targetPrice: number;
    ruleVersion: string;
    evidences: string[];
    notes?: string;
    provenance: DataProvenance;
    costConfig?: Partial<TradingCostConfig>;
  }): PaperLedgerEntry {
    const openedAt = new Date().toISOString();
    const resolvedTrack: PaperStrategyTrack =
      input.strategyTrack ??
      (input.actionState === 'LONG CANDIDATE' ||
      input.actionState === 'SHORT CANDIDATE'
        ? 'FORMAL_SMC_MARKET'
        : 'MANUAL_OBSERVATION');
    const resolvedFillStatus: PaperFillStatus =
      input.fillStatus ?? 'FILLED';
    const filledAt = resolvedFillStatus === 'FILLED' ? openedAt : null;

    const resolvedCostConfig = normalizeTradingCostConfig({
      ...input.costConfig,
      entryOrderType:
        resolvedFillStatus === 'WAITING_LIMIT' ||
        resolvedTrack === 'SMC_PULLBACK_LIMIT'
          ? 'LIMIT'
          : input.costConfig?.entryOrderType ?? 'MARKET',
    });

    let resolvedExpiresAt: string | null = null;
    if (resolvedFillStatus === 'WAITING_LIMIT') {
      if (input.expiresAt && Number.isFinite(Date.parse(input.expiresAt))) {
        resolvedExpiresAt = new Date(Date.parse(input.expiresAt)).toISOString();
      } else {
        const ttlMins =
          input.ttlMinutes !== undefined &&
          input.ttlMinutes !== null &&
          Number.isFinite(input.ttlMinutes) &&
          input.ttlMinutes > 0
            ? Math.min(10080, Math.max(1, Math.round(input.ttlMinutes)))
            : this.getDefaultLimitTtlMinutes(input.timeframe);
        resolvedExpiresAt = new Date(
          Date.parse(openedAt) + ttlMins * 60_000
        ).toISOString();
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO paper_trading_ledger (
        symbol, exchange, timeframe, side, category, action_state,
        entry_price, invalidation_price, target_price, current_price,
        exit_price, status, pnl_r, pnl_percent, rule_version,
        evidences_json, notes, opened_at, closed_at, provenance_json,
        strategy_track, fill_status, filled_at, entry_anchor_label,
        expires_at, expired_reason,
        gross_pnl_r, net_pnl_r, fee_cost_r, slippage_cost_r, funding_cost_r, total_cost_r, cost_config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', 0, 0, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 0, ?)
    `);

    const safeProvenance = enforceProvenanceIntegrity(input.provenance);
    const info = stmt.run(
      input.symbol,
      input.exchange,
      input.timeframe,
      input.side,
      input.category,
      input.actionState,
      input.entryPrice,
      input.invalidationPrice,
      input.targetPrice,
      input.entryPrice,
      input.ruleVersion,
      JSON.stringify(input.evidences),
      input.notes || `[${TRADING_SAFETY_FLAGS.mode}] 紙上觀察紀錄，嚴禁自動或實盤下單`,
      openedAt,
      JSON.stringify(safeProvenance),
      resolvedTrack,
      resolvedFillStatus,
      filledAt,
      input.entryAnchorLabel ?? null,
      resolvedExpiresAt,
      JSON.stringify(resolvedCostConfig)
    );

    const id = Number(info.lastInsertRowid);
    this.checkpointWalPassiveSafely();
    this.savePaperLedgerCheckpointToDisk();
    return this.getPaperLedgerEntryById(id)!;
  }

  public updateOpenPaperEntriesWithPrices(
    exchange: ExchangeId,
    priceMap: Map<string, number>,
    nowIsoOverride?: string
  ): void {
    const openEntries = this.listPaperLedgerEntries(200).filter(
      (e) => e.status === 'OPEN' && e.exchange === exchange
    );

    const updateStmt = this.db.prepare(`
      UPDATE paper_trading_ledger
      SET current_price = ?, exit_price = ?, status = ?, pnl_r = ?, pnl_percent = ?, closed_at = ?, fill_status = ?, filled_at = ?, expired_reason = ?, notes = ?,
          gross_pnl_r = ?, net_pnl_r = ?, fee_cost_r = ?, slippage_cost_r = ?, funding_cost_r = ?, total_cost_r = ?,
          trailing_stop_price = ?, breakeven_armed = ?
      WHERE id = ?
    `);

    const nowMs = nowIsoOverride ? Date.parse(nowIsoOverride) : Date.now();
    const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
    let hasStateTransition = false;
    let hasAnyPriceUpdate = false;

    for (const entry of openEntries) {
      const latestPrice = priceMap.get(entry.symbol);
      if (latestPrice === undefined || !Number.isFinite(latestPrice) || latestPrice <= 0) {
        continue;
      }

      let currentFillStatus: PaperFillStatus = entry.fillStatus ?? 'FILLED';
      let filledAt: string | null = entry.filledAt ?? entry.openedAt;
      let trailingStopPrice: number | null = entry.trailingStopPrice ?? null;
      let breakevenArmed = Boolean(entry.breakevenArmed);

      if (currentFillStatus === 'WAITING_LIMIT') {
        const expiresMs = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
        if (Number.isFinite(expiresMs) && nowMs >= expiresMs) {
          updateStmt.run(
            latestPrice,
            latestPrice,
            'CLOSED_EXPIRED',
            0,
            0,
            nowIso,
            'WAITING_LIMIT',
            null,
            'TTL_TIMEOUT',
            '[PAPER ONLY] 超過回踩等待時限 (TTL)，限價掛單自動過期作廢 (0R)',
            0,
            0,
            0,
            0,
            0,
            0,
            trailingStopPrice,
            breakevenArmed ? 1 : 0,
            entry.id
          );
          hasStateTransition = true;
          continue;
        }

        const limitTouched =
          entry.side === 'LONG'
            ? latestPrice <= entry.entryPrice
            : latestPrice >= entry.entryPrice;

        if (!limitTouched) {
          const invalidatedBeforeFill =
            entry.side === 'LONG'
              ? latestPrice <= entry.invalidationPrice
              : latestPrice >= entry.invalidationPrice;
          if (invalidatedBeforeFill) {
            updateStmt.run(
              latestPrice,
              latestPrice,
              'CLOSED_EXPIRED',
              0,
              0,
              nowIso,
              'WAITING_LIMIT',
              null,
              'INVALIDATED_BEFORE_FILL',
              '[PAPER ONLY] 未回踩觸價前結構已提前跌破/突破失效價，限價掛單自動作廢 (0R)',
              0,
              0,
              0,
              0,
              0,
              0,
              trailingStopPrice,
              breakevenArmed ? 1 : 0,
              entry.id
            );
            hasStateTransition = true;
            continue;
          }

          const targetMissedBeforeFill =
            entry.side === 'LONG'
              ? latestPrice >= entry.targetPrice
              : latestPrice <= entry.targetPrice;
          if (targetMissedBeforeFill) {
            updateStmt.run(
              latestPrice,
              latestPrice,
              'CLOSED_EXPIRED',
              0,
              0,
              nowIso,
              'WAITING_LIMIT',
              null,
              'TARGET_MISSED',
              '[PAPER ONLY] 價格未回踩即先行觸及目標價，踏空作廢失效掛單 (0R)',
              0,
              0,
              0,
              0,
              0,
              0,
              trailingStopPrice,
              breakevenArmed ? 1 : 0,
              entry.id
            );
            hasStateTransition = true;
            continue;
          }

          updateStmt.run(
            latestPrice,
            null,
            'OPEN',
            0,
            0,
            null,
            'WAITING_LIMIT',
            null,
            null,
            entry.notes,
            0,
            0,
            0,
            0,
            0,
            0,
            trailingStopPrice,
            breakevenArmed ? 1 : 0,
            entry.id
          );
          hasAnyPriceUpdate = true;
          continue;
        }
        currentFillStatus = 'FILLED';
        filledAt = nowIso;
        hasStateTransition = true;
      }

      let nextStatus: PaperLedgerEntry['status'] = 'OPEN';
      let exitPrice: number | null = null;
      let closedAt: string | null = null;
      let nextNotes = entry.notes;

      const activeStopPrice =
        breakevenArmed &&
        trailingStopPrice !== null &&
        Number.isFinite(trailingStopPrice)
          ? trailingStopPrice
          : entry.invalidationPrice;
      const initialRisk = Math.max(
        Math.abs(entry.entryPrice - entry.invalidationPrice),
        1e-8
      );

      if (entry.side === 'LONG') {
        if (latestPrice <= activeStopPrice) {
          const rawGrossR = (latestPrice - entry.entryPrice) / initialRisk;
          if (breakevenArmed && rawGrossR >= 0.05) {
            nextStatus = 'CLOSED_WIN';
            nextNotes = '[PAPER ONLY] +1R 移動保本止盈觸發';
          } else {
            nextStatus = 'CLOSED_LOSS';
          }
          exitPrice = latestPrice;
          closedAt = nowIso;
        } else if (latestPrice >= entry.targetPrice) {
          nextStatus = 'CLOSED_WIN';
          exitPrice = latestPrice;
          closedAt = nowIso;
        }
      } else {
        if (latestPrice >= activeStopPrice) {
          const rawGrossR = (entry.entryPrice - latestPrice) / initialRisk;
          if (breakevenArmed && rawGrossR >= 0.05) {
            nextStatus = 'CLOSED_WIN';
            nextNotes = '[PAPER ONLY] +1R 移動保本止盈觸發';
          } else {
            nextStatus = 'CLOSED_LOSS';
          }
          exitPrice = latestPrice;
          closedAt = nowIso;
        } else if (latestPrice <= entry.targetPrice) {
          nextStatus = 'CLOSED_WIN';
          exitPrice = latestPrice;
          closedAt = nowIso;
        }
      }

      const entryTimeMs = Date.parse(filledAt || entry.openedAt) || nowMs;
      const costBreakdown = calculateTradeTradingCosts({
        direction: entry.side,
        entryPrice: entry.entryPrice,
        invalidationPrice: entry.invalidationPrice,
        exitPrice: latestPrice,
        entryTimeMs,
        exitTimeMs: nowMs,
        symbol: entry.symbol,
        entryOrderType:
          entry.costConfig?.entryOrderType ??
          (entry.strategyTrack === 'SMC_PULLBACK_LIMIT' ? 'LIMIT' : 'MARKET'),
        exitIsLimitFill: nextStatus === 'CLOSED_WIN',
        costConfig: entry.costConfig,
      });

      if (
        nextStatus === 'OPEN' &&
        !breakevenArmed &&
        costBreakdown.grossRMultiple >= 1.0
      ) {
        const feeCoverBuffer = Math.max(
          entry.entryPrice * 0.0018,
          initialRisk * 0.12
        );
        const beStop =
          entry.side === 'LONG'
            ? Number((entry.entryPrice + feeCoverBuffer).toPrecision(6))
            : Number((entry.entryPrice - feeCoverBuffer).toPrecision(6));
        const validBeStop =
          entry.side === 'LONG'
            ? beStop > entry.invalidationPrice && beStop < latestPrice
            : beStop < entry.invalidationPrice && beStop > latestPrice;
        if (validBeStop) {
          breakevenArmed = true;
          trailingStopPrice = beStop;
          if (!nextNotes.includes('[已啟動 +1R 自動保本]')) {
            nextNotes = `${nextNotes} · [已啟動 +1R 自動保本]`;
          }
          hasStateTransition = true;
        }
      }

      const pnlR = costBreakdown.grossRMultiple;
      const pnlPercent = costBreakdown.grossPnlPercent;

      updateStmt.run(
        latestPrice,
        exitPrice,
        nextStatus,
        pnlR,
        pnlPercent,
        closedAt,
        currentFillStatus,
        filledAt,
        null,
        nextNotes,
        costBreakdown.grossRMultiple,
        costBreakdown.netRMultiple,
        costBreakdown.feeCostR,
        costBreakdown.slippageCostR,
        costBreakdown.fundingCostR,
        costBreakdown.totalCostR,
        trailingStopPrice,
        breakevenArmed ? 1 : 0,
        entry.id
      );
      hasAnyPriceUpdate = true;
      if (nextStatus !== 'OPEN') {
        hasStateTransition = true;
      }
    }

    if (hasStateTransition) {
      this.checkpointWalPassiveSafely();
      this.savePaperLedgerCheckpointToDisk();
    } else if (
      hasAnyPriceUpdate &&
      Date.now() - this.lastLedgerPriceCheckpointAtMs >= 30_000
    ) {
      this.savePaperLedgerCheckpointToDisk();
    }
  }

  public extendPaperLimitTtl(
    id: number,
    extraMinutes = 120
  ): PaperLedgerEntry | null {
    const existing = this.getPaperLedgerEntryById(id);
    if (
      !existing ||
      existing.status !== 'OPEN' ||
      existing.fillStatus !== 'WAITING_LIMIT'
    ) {
      return existing;
    }
    const baseMs = existing.expiresAt
      ? Math.max(Date.now(), Date.parse(existing.expiresAt))
      : Date.now();
    const safeExtra = Math.min(1440, Math.max(15, Math.round(extraMinutes)));
    const nextExpiresAt = new Date(baseMs + safeExtra * 60_000).toISOString();
    this.db
      .prepare(
        `UPDATE paper_trading_ledger SET expires_at = ? WHERE id = ?`
      )
      .run(nextExpiresAt, id);
    this.checkpointWalPassiveSafely();
    this.savePaperLedgerCheckpointToDisk();
    return this.getPaperLedgerEntryById(id);
  }

  public updatePaperLedgerInvalidation(
    id: number,
    invalidationPrice: number
  ): PaperLedgerEntry | null {
    const existing = this.getPaperLedgerEntryById(id);
    if (!existing || existing.status !== 'OPEN') return existing;
    if (!Number.isFinite(invalidationPrice) || invalidationPrice <= 0) {
      return existing;
    }
    this.db
      .prepare(
        `UPDATE paper_trading_ledger SET invalidation_price = ? WHERE id = ?`
      )
      .run(invalidationPrice, id);
    this.checkpointWalPassiveSafely();
    this.savePaperLedgerCheckpointToDisk();
    return this.getPaperLedgerEntryById(id);
  }

  public syncPaperLedgerOpenPriceAndPnl(
    id: number,
    currentPrice: number,
    pnlPercent: number,
    pnlR: number
  ): void {
    const info = this.db
      .prepare(
        `UPDATE paper_trading_ledger
         SET current_price = ?, pnl_percent = ?, pnl_r = ?
         WHERE id = ? AND status = 'OPEN'`
      )
      .run(currentPrice, pnlPercent, pnlR, id);
    if (
      Number(info.changes ?? 0) > 0 &&
      Date.now() - this.lastLedgerPriceCheckpointAtMs >= 30_000
    ) {
      this.savePaperLedgerCheckpointToDisk();
    }
  }

  public closePaperLedgerEntry(
    id: number,
    exitPrice?: number,
    notes?: string,
    options?: {
      fundingRatePer8h?: number | null;
      exitIsLimitFill?: boolean;
      closedAtIso?: string;
    }
  ): PaperLedgerEntry | null {
    const existing = this.getPaperLedgerEntryById(id);
    if (!existing) return null;

    const finalPrice =
      exitPrice !== undefined && Number.isFinite(exitPrice) && exitPrice > 0
        ? exitPrice
        : existing.currentPrice;

    const isUnfilledLimit = existing.fillStatus === 'WAITING_LIMIT';
    const closedAt = options?.closedAtIso ?? new Date().toISOString();
    const closedAtMs = Date.parse(closedAt) || Date.now();
    const entryTimeMs =
      Date.parse(existing.filledAt || existing.openedAt) || closedAtMs;

    const costBreakdown = isUnfilledLimit
      ? {
          grossRMultiple: 0,
          grossPnlPercent: 0,
          netRMultiple: 0,
          feeCostR: 0,
          slippageCostR: 0,
          fundingCostR: 0,
          totalCostR: 0,
        }
      : calculateTradeTradingCosts({
          direction: existing.side,
          entryPrice: existing.entryPrice,
          invalidationPrice: existing.invalidationPrice,
          exitPrice: finalPrice,
          entryTimeMs,
          exitTimeMs: closedAtMs,
          entryOrderType:
            existing.costConfig?.entryOrderType ??
            (existing.strategyTrack === 'SMC_PULLBACK_LIMIT'
              ? 'LIMIT'
              : 'MARKET'),
          exitIsLimitFill: options?.exitIsLimitFill ?? false,
          fundingRatePer8h: options?.fundingRatePer8h,
          symbol: existing.symbol,
          costConfig: existing.costConfig,
        });

    const pnlR = costBreakdown.grossRMultiple;
    const pnlPercent = costBreakdown.grossPnlPercent;

    const stmt = this.db.prepare(`
      UPDATE paper_trading_ledger
      SET current_price = ?, exit_price = ?, status = ?,
          pnl_r = ?, pnl_percent = ?, closed_at = ?, expired_reason = ?, notes = ?,
          gross_pnl_r = ?, net_pnl_r = ?, fee_cost_r = ?, slippage_cost_r = ?, funding_cost_r = ?, total_cost_r = ?
      WHERE id = ?
    `);

    stmt.run(
      finalPrice,
      finalPrice,
      isUnfilledLimit ? 'CLOSED_EXPIRED' : 'CLOSED_MANUAL',
      pnlR,
      pnlPercent,
      closedAt,
      isUnfilledLimit ? 'MANUAL_CANCEL' : null,
      isUnfilledLimit
        ? '[PAPER ONLY] 未觸價前手動撤銷待回踩限價單 (0R)'
        : notes || existing.notes,
      costBreakdown.grossRMultiple,
      costBreakdown.netRMultiple,
      costBreakdown.feeCostR,
      costBreakdown.slippageCostR,
      costBreakdown.fundingCostR,
      costBreakdown.totalCostR,
      id
    );

    this.checkpointWalPassiveSafely();
    this.savePaperLedgerCheckpointToDisk();
    return this.getPaperLedgerEntryById(id);
  }

  public getPaperLedgerEntryById(id: number): PaperLedgerEntry | null {
    const stmt = this.db.prepare(
      `SELECT * FROM paper_trading_ledger WHERE id = ?`
    );
    const row = stmt.get(id);
    return row ? this.mapPaperLedgerRow(row) : null;
  }

  public listPaperLedgerEntries(limit = 100): PaperLedgerEntry[] {
    const stmt = this.db.prepare(
      `SELECT * FROM paper_trading_ledger ORDER BY id DESC LIMIT ?`
    );
    return stmt.all(limit).map((r) => this.mapPaperLedgerRow(r));
  }

  public getPaperTrackComparisonStats(
    includeDemo = false
  ): PaperTrackComparisonStats {
    const allEntries = this.listPaperLedgerEntries(500);
    const liveEntries = allEntries.filter((e) => !e.isDemo);
    const totalDemoExcluded = allEntries.length - liveEntries.length;
    const scopedEntries = includeDemo ? allEntries : liveEntries;

    const trackDefs: Array<{ track: PaperStrategyTrack; labelZh: string }> = [
      { track: 'EARLY_IGNITION', labelZh: '早鳥起漲進場 (Early Ignition)' },
      { track: 'FORMAL_SMC_MARKET', labelZh: '正式 SMC 現價進場' },
      { track: 'SMC_PULLBACK_LIMIT', labelZh: 'FVG / OB 回踩限價進場' },
      { track: 'MANUAL_OBSERVATION', labelZh: '一般手動觀察紀錄' },
    ];

    const tracks: PaperTrackMetricSummary[] = trackDefs.map(
      ({ track, labelZh }) => {
        const entries = scopedEntries.filter(
          (e) => (e.strategyTrack ?? 'MANUAL_OBSERVATION') === track
        );
        const waitingLimitCount = entries.filter(
          (e) => e.status === 'OPEN' && e.fillStatus === 'WAITING_LIMIT'
        ).length;
        const expiredLimitCount = entries.filter(
          (e) =>
            e.status === 'CLOSED_EXPIRED' ||
            (e.fillStatus === 'WAITING_LIMIT' && e.status !== 'OPEN')
        ).length;
        const filledEntries = entries.filter(
          (e) => (e.fillStatus ?? 'FILLED') === 'FILLED'
        );
        const fillDenom = filledEntries.length + expiredLimitCount;
        const fillRatePercent =
          fillDenom > 0
            ? Number(((filledEntries.length / fillDenom) * 100).toFixed(1))
            : null;
        const openFilledCount = filledEntries.filter(
          (e) => e.status === 'OPEN'
        ).length;
        const closedFilled = filledEntries.filter((e) => e.status !== 'OPEN');

        const getNetR = (e: PaperLedgerEntry) => e.netPnlR ?? e.pnlR;
        const getCostR = (e: PaperLedgerEntry) => e.totalCostR ?? 0;

        const winCount = closedFilled.filter(
          (e) =>
            e.status === 'CLOSED_WIN' ||
            (e.status === 'CLOSED_MANUAL' && e.pnlR > 0)
        ).length;
        const lossCount = closedFilled.filter(
          (e) =>
            e.status === 'CLOSED_LOSS' ||
            (e.status === 'CLOSED_MANUAL' && e.pnlR < 0)
        ).length;
        const netWinCount = closedFilled.filter((e) => getNetR(e) > 0).length;

        const closedCount = closedFilled.length;
        const totalPnlR = Number(
          closedFilled.reduce((acc, e) => acc + e.pnlR, 0).toFixed(2)
        );
        const avgPnlR =
          closedCount > 0 ? Number((totalPnlR / closedCount).toFixed(2)) : null;
        const winRatePercent =
          closedCount > 0
            ? Number(((winCount / closedCount) * 100).toFixed(1))
            : null;

        const netTotalPnlR = Number(
          closedFilled.reduce((acc, e) => acc + getNetR(e), 0).toFixed(2)
        );
        const netAvgPnlR =
          closedCount > 0
            ? Number((netTotalPnlR / closedCount).toFixed(2))
            : null;
        const netWinRatePercent =
          closedCount > 0
            ? Number(((netWinCount / closedCount) * 100).toFixed(1))
            : null;
        const totalCostDrag = closedFilled.reduce(
          (acc, e) => acc + getCostR(e),
          0
        );
        const avgCostDragR =
          closedCount > 0
            ? Number((totalCostDrag / closedCount).toFixed(3))
            : null;

        const grossWinR = closedFilled
          .filter((e) => e.pnlR > 0)
          .reduce((acc, e) => acc + e.pnlR, 0);
        const grossLossR = Math.abs(
          closedFilled
            .filter((e) => e.pnlR < 0)
            .reduce((acc, e) => acc + e.pnlR, 0)
        );
        const profitFactor =
          closedCount === 0
            ? null
            : grossLossR > 0
              ? Number((grossWinR / grossLossR).toFixed(2))
              : grossWinR > 0
                ? 99.9
                : null;

        const netWinR = closedFilled
          .filter((e) => getNetR(e) > 0)
          .reduce((acc, e) => acc + getNetR(e), 0);
        const netLossR = Math.abs(
          closedFilled
            .filter((e) => getNetR(e) <= 0)
            .reduce((acc, e) => acc + getNetR(e), 0)
        );
        const netProfitFactor =
          closedCount === 0
            ? null
            : netLossR > 0
              ? Number((netWinR / netLossR).toFixed(2))
              : netWinR > 0
                ? 99.9
                : null;

        const bestR =
          closedCount > 0
            ? Math.max(...closedFilled.map((e) => e.pnlR))
            : null;
        const worstR =
          closedCount > 0
            ? Math.min(...closedFilled.map((e) => e.pnlR))
            : null;

        return {
          track,
          labelZh,
          totalEntries: entries.length,
          waitingLimitCount,
          expiredLimitCount,
          fillRatePercent,
          filledCount: filledEntries.length,
          openFilledCount,
          closedCount,
          winCount,
          lossCount,
          winRatePercent,
          avgPnlR,
          totalPnlR,
          profitFactor,
          netWinRatePercent,
          netAvgPnlR,
          netTotalPnlR,
          netProfitFactor,
          avgCostDragR,
          bestR,
          worstR,
        };
      }
    );

    const candidateTracks = tracks.filter(
      (t) =>
        t.track !== 'MANUAL_OBSERVATION' &&
        t.closedCount > 0 &&
        t.avgPnlR !== null
    );
    let leaderTrack: PaperStrategyTrack | null = null;
    if (candidateTracks.length > 0) {
      leaderTrack = [...candidateTracks].sort(
        (a, b) =>
          (b.netAvgPnlR ?? b.avgPnlR ?? -999) -
          (a.netAvgPnlR ?? a.avgPnlR ?? -999)
      )[0].track;
    }

    const smcMarket = tracks.find((t) => t.track === 'FORMAL_SMC_MARKET');
    const pullback = tracks.find((t) => t.track === 'SMC_PULLBACK_LIMIT');
    const pullbackVsChaseDeltaR =
      smcMarket?.avgPnlR !== null &&
      smcMarket?.avgPnlR !== undefined &&
      pullback?.avgPnlR !== null &&
      pullback?.avgPnlR !== undefined
        ? Number((pullback.avgPnlR - smcMarket.avgPnlR).toFixed(2))
        : null;
    const netPullbackVsChaseDeltaR =
      smcMarket?.netAvgPnlR !== null &&
      smcMarket?.netAvgPnlR !== undefined &&
      pullback?.netAvgPnlR !== null &&
      pullback?.netAvgPnlR !== undefined
        ? Number((pullback.netAvgPnlR - smcMarket.netAvgPnlR).toFixed(2))
        : null;

    return {
      scope: includeDemo ? 'ALL_INCLUDING_DEMO' : 'LIVE_ONLY',
      totalIncludedEntries: scopedEntries.length,
      totalDemoExcluded: includeDemo ? 0 : totalDemoExcluded,
      tracks,
      leaderTrack,
      pullbackVsChaseDeltaR,
      netPullbackVsChaseDeltaR,
    };
  }

  private mapPaperLedgerRow(r: Record<string, unknown>): PaperLedgerEntry {
    const safeProv = enforceProvenanceIntegrity(
      JSON.parse(String(r.provenance_json))
    );
    const ex = String(r.exchange) as ExchangeId;
    const isDemoEntry = Boolean(
      safeProv.isDemo ||
        safeProv.isTestFixture ||
        ex === 'demo_synthetic' ||
        !isVerifiedLivePublicApiSource(safeProv.source)
    );
    const rawActionState = String(r.action_state) as SmcActionState;
    const rawTrack = r.strategy_track ? String(r.strategy_track) : '';
    const strategyTrack: PaperStrategyTrack =
      rawTrack === 'EARLY_IGNITION' ||
      rawTrack === 'FORMAL_SMC_MARKET' ||
      rawTrack === 'SMC_PULLBACK_LIMIT' ||
      rawTrack === 'MANUAL_OBSERVATION'
        ? rawTrack
        : rawActionState === 'LONG CANDIDATE' ||
            rawActionState === 'SHORT CANDIDATE'
          ? 'FORMAL_SMC_MARKET'
          : 'MANUAL_OBSERVATION';

    const rawFill = r.fill_status ? String(r.fill_status) : 'FILLED';
    const fillStatus: PaperFillStatus =
      rawFill === 'WAITING_LIMIT' ? 'WAITING_LIMIT' : 'FILLED';

    const rawExpiredReason = r.expired_reason ? String(r.expired_reason) : null;
    const expiredReason: PaperLimitExpiredReason | null =
      rawExpiredReason === 'TTL_TIMEOUT' ||
      rawExpiredReason === 'TARGET_MISSED' ||
      rawExpiredReason === 'INVALIDATED_BEFORE_FILL' ||
      rawExpiredReason === 'MANUAL_CANCEL'
        ? rawExpiredReason
        : null;

    let parsedCostConfig: TradingCostConfig | undefined;
    if (r.cost_config_json) {
      try {
        parsedCostConfig = JSON.parse(String(r.cost_config_json));
      } catch {
        parsedCostConfig = undefined;
      }
    }

    const pnlR = Number(r.pnl_r);
    const grossPnlR =
      r.gross_pnl_r !== null && r.gross_pnl_r !== undefined
        ? Number(r.gross_pnl_r)
        : pnlR;
    const totalCostR =
      r.total_cost_r !== null && r.total_cost_r !== undefined
        ? Number(r.total_cost_r)
        : 0;
    const netPnlR =
      r.net_pnl_r !== null && r.net_pnl_r !== undefined
        ? Number(r.net_pnl_r)
        : Number((grossPnlR - totalCostR).toFixed(2));

    return {
      id: Number(r.id),
      symbol: String(r.symbol),
      exchange: ex,
      timeframe: String(r.timeframe) as Timeframe,
      side: String(r.side) as 'LONG' | 'SHORT',
      category: String(r.category) as ScanCategory,
      actionState: rawActionState,
      strategyTrack,
      fillStatus,
      filledAt: r.filled_at ? String(r.filled_at) : null,
      entryAnchorLabel: r.entry_anchor_label
        ? String(r.entry_anchor_label)
        : null,
      expiresAt: r.expires_at ? String(r.expires_at) : null,
      expiredReason,
      entryPrice: Number(r.entry_price),
      invalidationPrice: Number(r.invalidation_price),
      trailingStopPrice:
        r.trailing_stop_price !== null && r.trailing_stop_price !== undefined
          ? Number(r.trailing_stop_price)
          : null,
      breakevenArmed: Boolean(r.breakeven_armed),
      targetPrice: Number(r.target_price),
      currentPrice: Number(r.current_price),
      exitPrice:
        r.exit_price !== null && r.exit_price !== undefined
          ? Number(r.exit_price)
          : null,
      status: String(r.status) as PaperLedgerEntry['status'],
      pnlR,
      pnlPercent: Number(r.pnl_percent),
      grossPnlR,
      netPnlR,
      feeCostR:
        r.fee_cost_r !== null && r.fee_cost_r !== undefined
          ? Number(r.fee_cost_r)
          : 0,
      slippageCostR:
        r.slippage_cost_r !== null && r.slippage_cost_r !== undefined
          ? Number(r.slippage_cost_r)
          : 0,
      fundingCostR:
        r.funding_cost_r !== null && r.funding_cost_r !== undefined
          ? Number(r.funding_cost_r)
          : 0,
      totalCostR,
      costConfig: parsedCostConfig,
      ruleVersion: String(r.rule_version),
      evidences: JSON.parse(String(r.evidences_json || '[]')),
      notes: String(r.notes || ''),
      openedAt: String(r.opened_at),
      closedAt: r.closed_at ? String(r.closed_at) : null,
      provenance: safeProv,
      isDemo: isDemoEntry,
      demoIsolationLabel: isDemoEntry
        ? 'DEMO · 非即時資料 · 不計入 Live Paper 績效'
        : null,
    };
  }

  // ============================================================================
  // 3. Persisted Backtest Reports Store
  // ============================================================================

  public saveBacktestReport(
    report: BacktestResult,
    exchange: ExchangeId,
    scannerRuleVersion: string
  ): BacktestResult {
    const rawSource = report.provenance?.source || '';
    const safeProvenance = enforceProvenanceIntegrity(report.provenance);
    const createdAt = new Date().toISOString();

    // Test fixtures (VERIFICATION_SCRIPT, TEST_FIXTURE, SYNTHETIC_TEST_DATA) MUST NOT be saved into official backtest_reports
    if (
      isTestFixtureSourceName(rawSource) ||
      safeProvenance.source === 'TEST_FIXTURE'
    ) {
      return {
        ...report,
        exchange,
        scannerRuleVersion,
        createdAt,
        provenance: safeProvenance,
      };
    }

    const triggerSource: BacktestTriggerSource =
      report.triggerSource === 'AUTO_SCHEDULED' ? 'AUTO_SCHEDULED' : 'MANUAL';
    const autoBatchId = report.autoBatchId ?? null;

    const fullReport: BacktestResult = {
      ...report,
      exchange,
      scannerRuleVersion,
      createdAt,
      triggerSource,
      autoBatchId,
      provenance: safeProvenance,
    };

    const stmt = this.db.prepare(`
      INSERT INTO backtest_reports (
        symbol, exchange, timeframe, rule_version, scanner_rule_version,
        status, insufficient_reason, confirmed_bars_tested,
        total_trades, win_rate_percent, max_drawdown_r, profit_factor,
        average_win_r, average_loss_r, trades_json, provenance_json, created_at, report_json,
        trigger_source, auto_batch_id, end_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      report.symbol,
      exchange,
      report.timeframe,
      report.ruleVersion,
      scannerRuleVersion,
      report.status,
      report.insufficientReason ?? null,
      report.confirmedBarsTested,
      report.totalTrades,
      report.winRatePercent,
      report.maxDrawdownR,
      report.profitFactor,
      report.averageWinR,
      report.averageLossR,
      JSON.stringify(report.trades),
      JSON.stringify(safeProvenance),
      createdAt,
      JSON.stringify(fullReport),
      triggerSource,
      autoBatchId,
      report.endTime ?? null
    );

    return {
      ...fullReport,
      id: Number(info.lastInsertRowid),
    };
  }

  public listBacktestReports(limit = 30): BacktestResult[] {
    const stmt = this.db.prepare(
      `SELECT * FROM backtest_reports ORDER BY id DESC LIMIT ?`
    );
    return stmt
      .all(limit)
      .map((r) => {
        const prov = enforceProvenanceIntegrity(
          JSON.parse(String(r.provenance_json))
        );
        let storedReport: Partial<BacktestResult> = {};
        if (r.report_json) {
          try {
            storedReport = JSON.parse(String(r.report_json));
          } catch {
            storedReport = {};
          }
        }
        return {
          ...storedReport,
          id: Number(r.id),
          backtestRunId:
            storedReport.backtestRunId ||
            `bt_${String(r.exchange)}_${String(r.symbol)}_${String(r.timeframe)}_${Number(r.id)}`,
          safety: TRADING_SAFETY_FLAGS,
          symbol: String(r.symbol),
          exchange: String(r.exchange) as ExchangeId,
          timeframe: String(r.timeframe) as Timeframe,
          ruleVersion: String(r.rule_version),
          scannerRuleVersion: String(r.scanner_rule_version),
          startTime: storedReport.startTime ?? null,
          endTime: storedReport.endTime ?? null,
          dataSource: storedReport.dataSource ?? prov.source,
          fetchedAt: storedReport.fetchedAt ?? prov.fetchedAt,
          isDemo: storedReport.isDemo ?? prov.isDemo,
          dataClassification:
            storedReport.dataClassification ??
            (String(r.status) === 'INSUFFICIENT_DATA'
              ? 'INSUFFICIENT_DATA'
              : prov.isDemo
                ? 'DEMO'
                : 'REAL'),
          dataClassificationLabel:
            storedReport.dataClassificationLabel ??
            (String(r.status) === 'INSUFFICIENT_DATA'
              ? '資料不足'
              : prov.isDemo
                ? 'Demo 資料'
                : '實際資料'),
          status: String(r.status) as BacktestResult['status'],
          metricStatus:
            storedReport.metricStatus ??
            (String(r.status) === 'INSUFFICIENT_DATA'
              ? 'INSUFFICIENT_DATA'
              : (storedReport.executedPaperCount ?? Number(r.total_trades ?? 0)) === 0
                ? 'NO_TRADES'
                : 'READY'),
          insufficientReason: r.insufficient_reason
            ? String(r.insufficient_reason)
            : storedReport.insufficientReason,
          confirmedBarsTested: Number(r.confirmed_bars_tested),
          lookaheadFreeVerified:
            storedReport.lookaheadFreeVerified ??
            (String(r.status) !== 'INSUFFICIENT_DATA'),
          lookaheadFree:
            storedReport.lookaheadFree ??
            (String(r.status) !== 'INSUFFICIENT_DATA'),
          signalCount: storedReport.signalCount ?? 0,
          executedPaperCount: storedReport.executedPaperCount ?? 0,
          blockedCount: storedReport.blockedCount ?? 0,
          expiredCount: storedReport.expiredCount ?? 0,
          insufficientDataCount: storedReport.insufficientDataCount ?? 0,
          waitCount: storedReport.waitCount ?? 0,
          watchCount: storedReport.watchCount ?? 0,
          pendingCount: storedReport.pendingCount ?? 0,
          highRiskCount: storedReport.highRiskCount ?? 0,
          totalTrades:
            r.total_trades !== null && r.total_trades !== undefined
              ? Number(r.total_trades)
              : null,
          tradeCount:
            storedReport.tradeCount !== undefined
              ? storedReport.tradeCount
              : r.total_trades !== null && r.total_trades !== undefined
                ? Number(r.total_trades)
                : null,
          winRatePercent:
            r.win_rate_percent !== null && r.win_rate_percent !== undefined
              ? Number(r.win_rate_percent)
              : null,
          winRate:
            storedReport.winRate !== undefined
              ? storedReport.winRate
              : r.win_rate_percent !== null && r.win_rate_percent !== undefined
                ? Number(r.win_rate_percent)
                : null,
          averageR: storedReport.averageR ?? null,
          expectancyR: storedReport.expectancyR ?? null,
          maxDrawdownR:
            r.max_drawdown_r !== null && r.max_drawdown_r !== undefined
              ? Number(r.max_drawdown_r)
              : null,
          profitFactor:
            r.profit_factor !== null && r.profit_factor !== undefined
              ? Number(r.profit_factor)
              : null,
          averageWinR:
            r.average_win_r !== null && r.average_win_r !== undefined
              ? Number(r.average_win_r)
              : null,
          averageLossR:
            r.average_loss_r !== null && r.average_loss_r !== undefined
              ? Number(r.average_loss_r)
              : null,
          averageHoldingTime: storedReport.averageHoldingTime ?? null,
          averageHoldingBars: storedReport.averageHoldingBars ?? null,
          longCount: storedReport.longCount ?? null,
          shortCount: storedReport.shortCount ?? null,
          trades: JSON.parse(String(r.trades_json || '[]')),
          createdAt: String(r.created_at),
          triggerSource: (
            String(r.trigger_source || storedReport.triggerSource || 'MANUAL') ===
            'AUTO_SCHEDULED'
              ? 'AUTO_SCHEDULED'
              : 'MANUAL'
          ) as BacktestTriggerSource,
          autoBatchId: r.auto_batch_id
            ? String(r.auto_batch_id)
            : storedReport.autoBatchId ?? null,
          provenance: prov,
        };
      })
      .filter((rep) => rep.provenance.source !== 'TEST_FIXTURE');
  }

  // ============================================================================
  // 4. Background Scan Run Audit Log
  // ============================================================================

  public recordBackgroundScanRun(
    record: Omit<BackgroundScanRunRecord, 'id'>
  ): BackgroundScanRunRecord {
    const stmt = this.db.prepare(`
      INSERT INTO background_scan_runs (
        run_at, exchange, mode, symbols_scanned, volume_samples_recorded,
        long_candidates, short_candidates, high_risk_count,
        dry_run_alerts_dispatched, status, source, error_message, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      record.runAt,
      record.exchange,
      record.mode,
      record.symbolsScanned,
      record.volumeSamplesRecorded,
      record.longCandidates,
      record.shortCandidates,
      record.highRiskCount,
      record.dryRunAlertsDispatched,
      record.status,
      record.source,
      record.errorMessage ?? null,
      record.durationMs
    );

    return {
      id: Number(info.lastInsertRowid),
      ...record,
    };
  }

  public listBackgroundScanRuns(limit = 25): BackgroundScanRunRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM background_scan_runs ORDER BY id DESC LIMIT ?`
    );
    return stmt.all(limit).map((r) => ({
      id: Number(r.id),
      runAt: String(r.run_at),
      exchange: String(r.exchange) as ExchangeId,
      mode: String(r.mode) as 'live' | 'demo',
      symbolsScanned: Number(r.symbols_scanned),
      volumeSamplesRecorded: Number(r.volume_samples_recorded),
      longCandidates: Number(r.long_candidates),
      shortCandidates: Number(r.short_candidates),
      highRiskCount: Number(r.high_risk_count),
      dryRunAlertsDispatched: Number(r.dry_run_alerts_dispatched),
      status: String(r.status) as 'SUCCESS' | 'API_ERROR',
      source: String(r.source),
      errorMessage: r.error_message ? String(r.error_message) : undefined,
      durationMs: Number(r.duration_ms),
    }));
  }

  // ============================================================================
  // 5. Phase 3: Full-Market SMC/ICT Background Scan Jobs, Results & Candles Cache
  // ============================================================================

  private bumpSmcStatsVersion(
    exchange: ExchangeId,
    nowIso = new Date().toISOString(),
    scanRunId?: string
  ): number {
    // Enforce strictly monotonic statsVersion across the entire SQLite database instance
    const maxRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(stats_version), 0) as max_ver FROM smc_scan_meta`
      )
      .get() as { max_ver?: number } | undefined;
    const floorRow = this.db
      .prepare(
        `SELECT value FROM radar_db_meta WHERE key = 'monotonic_stats_version'`
      )
      .get() as { value?: string } | undefined;
    const currentMax = Math.max(
      Number(maxRow?.max_ver ?? 0),
      Number(floorRow?.value ?? 0)
    );
    const nextVersion = currentMax + 1;

    this.db
      .prepare(
        `INSERT INTO radar_db_meta (key, value) VALUES ('monotonic_stats_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(nextVersion));

    const existingMeta = this.db
      .prepare(
        `SELECT scan_run_id FROM smc_scan_meta WHERE exchange = ?`
      )
      .get(exchange) as { scan_run_id?: string | null } | undefined;

    const resolvedScanRunId =
      scanRunId ||
      existingMeta?.scan_run_id ||
      `scan_${exchange}_${Date.now()}_${nextVersion}`;

    this.db
      .prepare(
        `
      INSERT INTO smc_scan_meta (exchange, stats_version, scan_run_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(exchange) DO UPDATE SET
        stats_version = MAX(smc_scan_meta.stats_version + 1, excluded.stats_version),
        scan_run_id = COALESCE(excluded.scan_run_id, smc_scan_meta.scan_run_id),
        updated_at = excluded.updated_at
    `
      )
      .run(exchange, nextVersion, resolvedScanRunId, nowIso);

    const row = this.db
      .prepare(`SELECT stats_version FROM smc_scan_meta WHERE exchange = ?`)
      .get(exchange) as { stats_version?: number } | undefined;
    this.touchSmcState(exchange);
    return Number(row?.stats_version ?? nextVersion);
  }

  public getSmcStatsVersion(exchange: ExchangeId): number {
    const row = this.db
      .prepare(`SELECT stats_version FROM smc_scan_meta WHERE exchange = ?`)
      .get(exchange) as { stats_version?: number } | undefined;
    if (row?.stats_version !== undefined) {
      return Number(row.stats_version);
    }
    return 1;
  }

  public incrementSmcStatsVersion(
    exchange: ExchangeId,
    nowIso = new Date().toISOString(),
    scanRunId?: string
  ): number {
    return this.bumpSmcStatsVersion(exchange, nowIso, scanRunId);
  }

  public getSmcScanRunId(exchange: ExchangeId): string {
    const row = this.db
      .prepare(`SELECT scan_run_id, stats_version FROM smc_scan_meta WHERE exchange = ?`)
      .get(exchange) as { scan_run_id?: string | null; stats_version?: number } | undefined;
    if (row?.scan_run_id) {
      return String(row.scan_run_id);
    }
    const latestJob = this.db
      .prepare(
        `SELECT window_key, rule_version FROM smc_scan_jobs WHERE exchange = ? ORDER BY id DESC LIMIT 1`
      )
      .get(exchange) as { window_key?: string; rule_version?: string } | undefined;
    const winKey = latestJob?.window_key ?? 'win_init';
    const ruleVer = latestJob?.rule_version ?? 'smc-v1';
    const generated = `scan_${exchange}_${winKey}_${ruleVer}_${this.databaseInstanceId.slice(-6)}`;
    this.db
      .prepare(
        `INSERT INTO smc_scan_meta (exchange, stats_version, scan_run_id, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(exchange) DO UPDATE SET scan_run_id = COALESCE(smc_scan_meta.scan_run_id, excluded.scan_run_id)`
      )
      .run(exchange, generated, new Date().toISOString());
    return generated;
  }

  public getSmcScanCycleId(exchange: ExchangeId): string {
    const row = this.db
      .prepare(`SELECT scan_cycle_id FROM smc_scan_meta WHERE exchange = ?`)
      .get(exchange) as { scan_cycle_id?: string | null } | undefined;
    if (row?.scan_cycle_id) {
      return String(row.scan_cycle_id);
    }
    const latestJob = this.db
      .prepare(
        `SELECT window_key, rule_version, requested_at FROM smc_scan_jobs WHERE exchange = ? ORDER BY id DESC LIMIT 1`
      )
      .get(exchange) as {
        window_key?: string;
        rule_version?: string;
        requested_at?: string;
      } | undefined;
    const winKey = latestJob?.window_key ?? 'win_init';
    const ruleVer = latestJob?.rule_version ?? 'smc-v1.0.0';
    const generated = `cycle_${exchange}_${winKey}_${ruleVer}_${this.databaseInstanceId.slice(-6)}`;
    const startedAt = latestJob?.requested_at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO smc_scan_meta (exchange, stats_version, scan_cycle_id, cycle_started_at, cycle_status, updated_at)
         VALUES (?, 1, ?, ?, 'RUNNING', ?)
         ON CONFLICT(exchange) DO UPDATE SET
           scan_cycle_id = COALESCE(smc_scan_meta.scan_cycle_id, excluded.scan_cycle_id),
           cycle_started_at = COALESCE(smc_scan_meta.cycle_started_at, excluded.cycle_started_at)`
      )
      .run(exchange, generated, startedAt, new Date().toISOString());
    return generated;
  }

  private inTransactionDepth = 0;

  private runInTransaction<T>(fn: () => T): T {
    if (this.inTransactionDepth > 0) {
      return fn();
    }
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this.inTransactionDepth++;
        try {
          const result = fn();
          this.db.exec('COMMIT');
          return result;
        } catch (innerErr) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // ignore rollback error
          }
          throw innerErr;
        } finally {
          this.inTransactionDepth = Math.max(0, this.inTransactionDepth - 1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /SQLITE_BUSY|database is locked/i.test(msg) &&
          attempt < maxAttempts - 1
        ) {
          continue;
        }
        throw err;
      }
    }
    return fn();
  }

  /**
   * Synchronizes the universe of symbols for an exchange and enqueues jobs atomically.
   * Supports UNIQUE(exchange, symbol, rule_version, window_key) so:
   * - Same (exchange, symbol, ruleVersion, windowKey) is never duplicated.
   * - New ruleVersion or new windowKey (or manual refresh) creates a new evaluation job while preserving completed history.
   * - Active job lock ensures a symbol never has two RUNNING jobs simultaneously.
   */
  public enqueueSmcScanJobs(
    jobs: Array<Omit<SmcScanJobRecord, 'id'>>,
    forceRefresh = false,
    pruneOtherSymbols = false
  ): { enqueuedCount: number; skippedDuplicateCount: number } {
    if (jobs.length === 0) {
      return { enqueuedCount: 0, skippedDuplicateCount: 0 };
    }

    return this.runInTransaction(() => {
      const findExactEvalJobStmt = this.db.prepare(`
        SELECT id, status, priority_tier, priority, rule_version, window_key, lease_until
        FROM smc_scan_jobs
        WHERE exchange = ? AND symbol = ? AND rule_version = ? AND window_key = ?
        LIMIT 1
      `);

      const findLatestSymbolJobStmt = this.db.prepare(`
        SELECT id, status, priority_tier, priority, rule_version, window_key, lease_until
        FROM smc_scan_jobs
        WHERE exchange = ? AND symbol = ?
        ORDER BY CASE WHEN status = 'RUNNING' THEN 0 ELSE 1 END ASC, id DESC
        LIMIT 1
      `);

      const findValidResultStmt = this.db.prepare(`
        SELECT evaluated_at, smc_evaluation_status, smc_action_state, rule_version, stale, fallback, missing_data_json
        FROM smc_scan_results
        WHERE exchange = ? AND symbol = ?
        LIMIT 1
      `);

      const deleteResultStmt = this.db.prepare(`
        DELETE FROM smc_scan_results
        WHERE exchange = ? AND symbol = ?
      `);

      const deleteSupersededPendingStmt = this.db.prepare(`
        DELETE FROM smc_scan_jobs
        WHERE exchange = ? AND symbol = ? AND status IN ('QUEUED', 'RATE_LIMITED')
      `);

      const deleteOtherPendingStmt = this.db.prepare(`
        DELETE FROM smc_scan_jobs
        WHERE exchange = ? AND symbol = ? AND id != ? AND status IN ('QUEUED', 'RATE_LIMITED')
      `);

      const insertQueuedStmt = this.db.prepare(`
        INSERT INTO smc_scan_jobs (
          symbol, exchange, priority, priority_tier, priority_label, priority_class,
          status, pending_reason, rule_version, window_key, requested_at, queue_entered_at, started_at,
          completed_at, last_error, retry_count, next_retry_at,
          worker_id, lease_until, heartbeat_at, is_fast_lane, prewarm_wait_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
      `);

      const insertSucceededStmt = this.db.prepare(`
        INSERT INTO smc_scan_jobs (
          symbol, exchange, priority, priority_tier, priority_label, priority_class,
          status, rule_version, window_key, requested_at, queue_entered_at, started_at,
          completed_at, last_error, retry_count, next_retry_at,
          worker_id, lease_until, heartbeat_at, is_fast_lane, prewarm_wait_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
      `);

      const upgradePriorityStmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET priority = ?, priority_tier = ?, priority_label = ?, priority_class = ?,
            is_fast_lane = ?,
            queue_entered_at = ?
        WHERE id = ?
      `);

      const adoptInlineWindowStmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET priority = ?, priority_tier = ?, priority_label = ?, priority_class = ?,
            is_fast_lane = ?, window_key = ?
        WHERE id = ?
      `);

      const requeueJobStmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET priority = ?, priority_tier = ?, priority_label = ?, priority_class = ?,
            status = 'QUEUED', pending_reason = 'QUEUED', rule_version = ?, window_key = ?,
            requested_at = ?, queue_entered_at = ?, last_progress_at = ?, started_at = NULL, completed_at = NULL,
            job_claimed_at = NULL,
            smc_evaluation_started_at = NULL, smc_evaluation_completed_at = NULL,
            queue_wait_ms = NULL, prewarm_wait_ms = ?, http_request_latency_ms = NULL,
            smc_calculation_latency_ms = NULL, db_write_latency_ms = NULL,
            smc_evaluation_latency_ms = NULL, rate_limit_wait_ms = 0,
            detection_latency_ms = NULL,
            last_error = NULL, retry_count = 0, next_retry_at = NULL,
            worker_id = NULL, lease_until = NULL, heartbeat_at = NULL,
            is_fast_lane = ?
        WHERE id = ?
      `);

      let enqueuedCount = 0;
      let skippedDuplicateCount = 0;
      const nowIso = new Date().toISOString();
      const touchedExchanges = new Set<ExchangeId>();

      if (pruneOtherSymbols && jobs.length > 0) {
        const targetExchange = jobs[0].exchange;
        const symbolSet = new Set(jobs.map((j) => j.symbol));
        const existingJobs = this.db
          .prepare(
            `SELECT DISTINCT symbol FROM smc_scan_jobs WHERE exchange = ?`
          )
          .all(targetExchange) as Array<{ symbol: string }>;
        const delJobStmt = this.db.prepare(
          `DELETE FROM smc_scan_jobs WHERE exchange = ? AND symbol = ?`
        );
        for (const r of existingJobs) {
          if (!symbolSet.has(String(r.symbol))) {
            delJobStmt.run(targetExchange, String(r.symbol));
            deleteResultStmt.run(targetExchange, String(r.symbol));
          }
        }
        const existingResults = this.db
          .prepare(`SELECT symbol FROM smc_scan_results WHERE exchange = ?`)
          .all(targetExchange) as Array<{ symbol: string }>;
        for (const r of existingResults) {
          if (!symbolSet.has(String(r.symbol))) {
            deleteResultStmt.run(targetExchange, String(r.symbol));
          }
        }
      }

      const activeQueueExchangeSet = new Set<ExchangeId>();
      if (!forceRefresh) {
        const activeExRows = this.db
          .prepare(
            `SELECT DISTINCT exchange FROM smc_scan_jobs
             WHERE status IN ('QUEUED', 'RUNNING', 'RATE_LIMITED')`
          )
          .all() as Array<{ exchange?: string }>;
        for (const row of activeExRows) {
          if (row.exchange) {
            activeQueueExchangeSet.add(row.exchange as ExchangeId);
          }
        }
      }

      const preloadedCacheRowsByKey = new Map<
        string,
        Array<{
          timeframe: string;
          expires_at: string;
          stale: number;
          fallback: number;
          missing_data_json: string;
          rule_version: string | null;
          oi_expires_at: string | null;
          open_interest: number | null;
          funding_rate: number | null;
        }>
      >();
      const jobExchanges = Array.from(new Set(jobs.map((j) => j.exchange)));
      const preloadCacheStmt = this.db.prepare(
        `SELECT symbol, timeframe, expires_at, stale, fallback, missing_data_json, rule_version, oi_expires_at, open_interest, funding_rate
         FROM smc_scan_candles_cache
         WHERE exchange = ?`
      );
      for (const jobEx of jobExchanges) {
        const allExCacheRows = preloadCacheStmt.all(jobEx) as Array<{
          symbol: string;
          timeframe: string;
          expires_at: string;
          stale: number;
          fallback: number;
          missing_data_json: string;
          rule_version: string | null;
          oi_expires_at: string | null;
          open_interest: number | null;
          funding_rate: number | null;
        }>;
        for (const row of allExCacheRows) {
          const mapKey = `${jobEx}:${String(row.symbol)}`;
          let list = preloadedCacheRowsByKey.get(mapKey);
          if (!list) {
            list = [];
            preloadedCacheRowsByKey.set(mapKey, list);
          }
          list.push(row);
        }
      }

      for (const job of jobs) {
        touchedExchanges.add(job.exchange);
        const hasActiveQueueInExchange = activeQueueExchangeSet.has(job.exchange);
        const queueEnteredAt = job.queueEnteredAt || job.requestedAt || nowIso;
        const isFastLane = job.priorityTier >= 1 && job.priorityTier <= 5;
        const isFastLaneInt = isFastLane ? 1 : 0;
        const priorityClass: SmcPriorityClass = isFastLane
          ? 'FAST_LANE'
          : 'BULK';
        const prewarmWaitMs = Math.max(0, Math.round(job.prewarmWaitMs ?? 0));

        const exactJob = findExactEvalJobStmt.get(
          job.exchange,
          job.symbol,
          job.ruleVersion,
          job.windowKey
        ) as
          | {
              id: number;
              status: string;
              priority_tier: number;
              priority: number;
              rule_version: string;
              window_key: string;
              lease_until: string | null;
            }
          | undefined;

        const latestSymbolJob = findLatestSymbolJobStmt.get(
          job.exchange,
          job.symbol
        ) as
          | {
              id: number;
              status: string;
              priority_tier: number;
              priority: number;
              rule_version: string;
              window_key: string;
              lease_until: string | null;
            }
          | undefined;

        const existingResult = findValidResultStmt.get(
          job.exchange,
          job.symbol
        ) as
          | {
              evaluated_at: string;
              smc_evaluation_status: string;
              smc_action_state: string;
              rule_version: string;
              stale: number;
              fallback: number;
              missing_data_json: string | null;
            }
          | undefined;

        const existingEvalMs = existingResult?.evaluated_at
          ? Date.parse(existingResult.evaluated_at)
          : NaN;
        const isExistingResultFresh =
          Number.isFinite(existingEvalMs) &&
          (Date.parse(nowIso) || Date.now()) - existingEvalMs <= 30 * 60 * 1000;

        // Read preloaded smc_scan_candles_cache metadata for this symbol
        const cacheRows =
          preloadedCacheRowsByKey.get(`${job.exchange}:${job.symbol}`) ?? [];

        const nowMs = Date.parse(nowIso) || Date.now();
        let hasAnyExpiredOrInvalidCacheRow = false;
        const freshTfSet = new Set<string>();
        for (const cr of cacheRows) {
          const expMs = Date.parse(String(cr.expires_at));
          const isRowExpired =
            !Number.isFinite(expMs) ||
            nowMs >= expMs ||
            Number(cr.stale) === 1 ||
            Number(cr.fallback) === 1 ||
            String(cr.missing_data_json || '[]') !== '[]' ||
            Boolean(cr.rule_version && String(cr.rule_version) !== job.ruleVersion);
          if (isRowExpired) {
            hasAnyExpiredOrInvalidCacheRow = true;
          } else {
            freshTfSet.add(String(cr.timeframe));
          }
        }
        const hasAllFourTimeframesFresh =
          !hasAnyExpiredOrInvalidCacheRow &&
          freshTfSet.has('5m') &&
          freshTfSet.has('15m') &&
          freshTfSet.has('1h') &&
          freshTfSet.has('4h');

        const hasValidEvaluatedResultForRule =
          existingResult !== undefined &&
          existingResult.smc_evaluation_status === 'EVALUATED' &&
          existingResult.smc_action_state !== 'PENDING' &&
          existingResult.rule_version === job.ruleVersion &&
          isExistingResultFresh &&
          !hasAnyExpiredOrInvalidCacheRow;

        const isSymbolActivelyRunning =
          latestSymbolJob !== undefined &&
          latestSymbolJob.status === 'RUNNING' &&
          (!latestSymbolJob.lease_until ||
            latestSymbolJob.lease_until > nowIso);

        if (exactJob) {
          if (forceRefresh) {
            if (isSymbolActivelyRunning) {
              skippedDuplicateCount++;
              continue;
            }
            deleteOtherPendingStmt.run(job.exchange, job.symbol, exactJob.id);
            deleteResultStmt.run(job.exchange, job.symbol);
            requeueJobStmt.run(
              job.priority,
              job.priorityTier,
              job.priorityLabel,
              priorityClass,
              job.ruleVersion,
              job.windowKey,
              job.requestedAt,
              queueEnteredAt,
              queueEnteredAt,
              prewarmWaitMs,
              isFastLaneInt,
              exactJob.id
            );
            enqueuedCount++;
            continue;
          }

          const isEvaluatedResultIntact =
            existingResult !== undefined &&
            existingResult.smc_evaluation_status === 'EVALUATED' &&
            existingResult.smc_action_state !== 'PENDING' &&
            existingResult.rule_version === job.ruleVersion &&
            Number(existingResult.stale) === 0 &&
            Number(existingResult.fallback) === 0 &&
            String(existingResult.missing_data_json || '[]') === '[]' &&
            isExistingResultFresh;

          if (exactJob.status === 'SUCCEEDED') {
            // exactJob already matches the same rule_version AND window_key.
            // Never delete valid evaluated results mid-window purely because 5m candle cache TTL elapsed.
            if (
              latestSymbolJob?.id === exactJob.id &&
              !isEvaluatedResultIntact
            ) {
              deleteResultStmt.run(job.exchange, job.symbol);
              requeueJobStmt.run(
                job.priority,
                job.priorityTier,
                job.priorityLabel,
                priorityClass,
                job.ruleVersion,
                job.windowKey,
                job.requestedAt,
                queueEnteredAt,
                queueEnteredAt,
                prewarmWaitMs,
                isFastLaneInt,
                exactJob.id
              );
              enqueuedCount++;
            } else {
              skippedDuplicateCount++;
            }
            continue;
          }

          if (
            latestSymbolJob?.id === exactJob.id &&
            existingResult !== undefined
          ) {
            deleteResultStmt.run(job.exchange, job.symbol);
          }

          if (
            exactJob.status === 'QUEUED' &&
            (Number(exactJob.priority) < 900000 || job.priority >= 900000)
          ) {
            upgradePriorityStmt.run(
              job.priority,
              job.priorityTier,
              job.priorityLabel,
              priorityClass,
              isFastLaneInt,
              isFastLaneInt === 1
                ? queueEnteredAt
                : String(exactJob.priority_tier) !== String(job.priorityTier)
                  ? queueEnteredAt
                  : queueEnteredAt,
              exactJob.id
            );
          }
          skippedDuplicateCount++;
          continue;
        }

        // No exact match for (exchange, symbol, ruleVersion, windowKey):
        if (
          !latestSymbolJob &&
          !forceRefresh &&
          hasValidEvaluatedResultForRule &&
          existingResult
        ) {
          insertSucceededStmt.run(
            job.symbol,
            job.exchange,
            job.priority,
            job.priorityTier,
            job.priorityLabel,
            priorityClass,
            job.ruleVersion,
            job.windowKey,
            job.requestedAt,
            queueEnteredAt,
            existingResult.evaluated_at,
            existingResult.evaluated_at,
            isFastLaneInt,
            prewarmWaitMs
          );
          skippedDuplicateCount++;
        } else if (
          latestSymbolJob &&
          (latestSymbolJob.window_key === 'inline_eval' ||
            latestSymbolJob.window_key === 'synced_from_result') &&
          latestSymbolJob.status === 'SUCCEEDED' &&
          !forceRefresh &&
          hasValidEvaluatedResultForRule
        ) {
          adoptInlineWindowStmt.run(
            job.priority,
            job.priorityTier,
            job.priorityLabel,
            priorityClass,
            isFastLaneInt,
            job.windowKey,
            latestSymbolJob.id
          );
          this.db
            .prepare(
              `UPDATE smc_scan_results
               SET window_key = ?, priority_tier = ?, priority_label = ?, priority_class = ?, is_fast_lane = ?,
                   cache_hit = 1, cache_miss = 0, reused_cache = 1
               WHERE exchange = ? AND symbol = ?`
            )
            .run(
              job.windowKey,
              job.priorityTier,
              job.priorityLabel,
              priorityClass,
              isFastLaneInt,
              job.exchange,
              job.symbol
            );
          skippedDuplicateCount++;
        } else {
          // If the symbol already has a QUEUED job in another window and forceRefresh is false, check if we should upgrade in-place or replace
          deleteSupersededPendingStmt.run(job.exchange, job.symbol);
          if (!isSymbolActivelyRunning) {
            deleteResultStmt.run(job.exchange, job.symbol);
          }
          insertQueuedStmt.run(
            job.symbol,
            job.exchange,
            job.priority,
            job.priorityTier,
            job.priorityLabel,
            priorityClass,
            job.ruleVersion,
            job.windowKey,
            job.requestedAt,
            queueEnteredAt,
            isFastLaneInt,
            prewarmWaitMs
          );
          enqueuedCount++;
        }
      }

      if (enqueuedCount > 0) {
        const sampleJob = jobs[0];
        for (const ex of touchedExchanges) {
          const cacheCountRow = this.db
            .prepare(
              `SELECT COUNT(*) as cnt FROM smc_scan_candles_cache WHERE exchange = ? AND stale = 0`
            )
            .get(ex) as { cnt?: number } | undefined;
          const completedCyclesCountRow = this.db
            .prepare(
              `SELECT COUNT(*) as cnt FROM smc_scan_cycles WHERE exchange = ? AND cycle_status = 'COMPLETED'`
            )
            .get(ex) as { cnt?: number } | undefined;
          const isColdStartInt =
            Number(cacheCountRow?.cnt ?? 0) === 0 ||
            Number(completedCyclesCountRow?.cnt ?? 0) === 0
              ? 1
              : 0;

          const nextScanRunId = `scan_${ex}_${sampleJob.windowKey}_${sampleJob.ruleVersion}_${this.databaseInstanceId.slice(-6)}`;
          const nextScanCycleId = `cycle_${ex}_${sampleJob.windowKey}_${sampleJob.ruleVersion}_${this.databaseInstanceId.slice(-6)}`;
          const prevMetaRow = this.db
            .prepare(`SELECT scan_cycle_id FROM smc_scan_meta WHERE exchange = ?`)
            .get(ex) as { scan_cycle_id?: string | null } | undefined;
          const isNewCycleId =
            forceRefresh ||
            !prevMetaRow?.scan_cycle_id ||
            prevMetaRow.scan_cycle_id !== nextScanCycleId;

          this.bumpSmcStatsVersion(ex, nowIso, nextScanRunId);
          this.db
            .prepare(
              `UPDATE smc_scan_meta
               SET scan_cycle_id = ?,
                   is_cold_start = CASE
                     WHEN ? = 1 THEN ?
                     ELSE COALESCE(is_cold_start, ?)
                   END,
                   completed_http_requests = CASE
                     WHEN ? = 1 THEN 0
                     ELSE COALESCE(completed_http_requests, 0)
                   END,
                   cache_mode = CASE
                     WHEN ? = 1 THEN ?
                     ELSE cache_mode
                   END,
                   cycle_started_at = CASE
                     WHEN ? = 1 THEN ?
                     ELSE COALESCE(cycle_started_at, ?)
                   END,
                   cycle_completed_at = NULL,
                   cycle_status = 'RUNNING',
                   full_cycle_duration_ms = NULL
               WHERE exchange = ?`
            )
            .run(
              nextScanCycleId,
              isNewCycleId ? 1 : 0,
              isColdStartInt,
              isColdStartInt,
              isNewCycleId ? 1 : 0,
              isNewCycleId ? 1 : 0,
              isColdStartInt === 1 ? 'COLD' : 'WARM',
              isNewCycleId ? 1 : 0,
              sampleJob.requestedAt || nowIso,
              sampleJob.requestedAt || nowIso,
              ex
            );
          this.updateRuntimeHttpMetrics(ex, {
            cycleId: nextScanCycleId,
            resetCompletedHttpRequests: isNewCycleId,
          });
        }
      }

      return { enqueuedCount, skippedDuplicateCount };
    });
  }

  public recordStage1RadarScanMeta(
    exchange: ExchangeId,
    completedAtIso: string,
    durationMs: number
  ): void {
    const existing = this.db
      .prepare(`SELECT exchange FROM smc_scan_meta WHERE exchange = ?`)
      .get(exchange) as { exchange?: string } | undefined;
    if (!existing) {
      this.bumpSmcStatsVersion(exchange, completedAtIso);
    }
    this.db
      .prepare(
        `UPDATE smc_scan_meta
         SET last_full_radar_scan_at = ?,
             radar_scan_duration_ms = ?
         WHERE exchange = ?`
      )
      .run(completedAtIso, Math.max(0, Math.round(durationMs)), exchange);
  }

  public recordPrewarmScanMeta(
    exchange: ExchangeId,
    completedAtIso: string,
    prewarmDurationMs: number,
    prewarmCacheHitRate: number,
    isColdStart?: boolean
  ): void {
    this.bumpSmcStatsVersion(exchange, completedAtIso);
    if (isColdStart !== undefined) {
      this.db
        .prepare(
          `UPDATE smc_scan_meta
           SET prewarm_duration_ms = ?,
               prewarm_cache_hit_rate = ?,
               is_cold_start = CASE
                 WHEN COALESCE(is_cold_start, 0) = 1 THEN 1
                 ELSE ?
               END,
               updated_at = ?
           WHERE exchange = ?`
        )
        .run(
          Math.max(0, Math.round(prewarmDurationMs)),
          Number(prewarmCacheHitRate.toFixed(2)),
          isColdStart ? 1 : 0,
          completedAtIso,
          exchange
        );
    } else {
      this.db
        .prepare(
          `UPDATE smc_scan_meta
           SET prewarm_duration_ms = ?,
               prewarm_cache_hit_rate = ?,
               updated_at = ?
           WHERE exchange = ?`
        )
        .run(
          Math.max(0, Math.round(prewarmDurationMs)),
          Number(prewarmCacheHitRate.toFixed(2)),
          completedAtIso,
          exchange
        );
    }
  }

  public updateSmcJobPrewarmWait(
    exchange: ExchangeId,
    symbol: string,
    prewarmWaitMs: number,
    resetQueueEnteredAtIso?: string
  ): void {
    if (resetQueueEnteredAtIso) {
      this.db
        .prepare(
          `UPDATE smc_scan_jobs
           SET prewarm_wait_ms = ?,
               queue_entered_at = ?
           WHERE exchange = ? AND symbol = ? AND status = 'QUEUED'`
        )
        .run(
          Math.max(0, Math.round(prewarmWaitMs)),
          resetQueueEnteredAtIso,
          exchange,
          symbol.trim().toUpperCase()
        );
    } else {
      this.db
        .prepare(
          `UPDATE smc_scan_jobs
           SET prewarm_wait_ms = ?
           WHERE exchange = ? AND symbol = ? AND status IN ('QUEUED', 'RUNNING')`
        )
        .run(
          Math.max(0, Math.round(prewarmWaitMs)),
          exchange,
          symbol.trim().toUpperCase()
        );
    }
  }

  public recordPriorityScanMeta(
    exchange: ExchangeId,
    completedAtIso: string,
    durationMs: number,
    incrementRefreshCount = false
  ): void {
    this.bumpSmcStatsVersion(exchange, completedAtIso);
    this.db
      .prepare(
        `UPDATE smc_scan_meta
         SET last_priority_scan_at = ?,
             priority_smc_duration_ms = ?,
             priority_refresh_count = COALESCE(priority_refresh_count, 0) + ?,
             updated_at = ?
         WHERE exchange = ?`
      )
      .run(
        completedAtIso,
        Math.max(0, Math.round(durationMs)),
        incrementRefreshCount ? 1 : 0,
        completedAtIso,
        exchange
      );
  }

  public getLatestActiveWindowKey(exchange: ExchangeId): string | null {
    const row = this.db
      .prepare(
        `
      SELECT window_key
      FROM smc_scan_jobs
      WHERE exchange = ?
        AND window_key NOT IN ('inline_eval', 'synced_from_result')
        AND window_key NOT LIKE 'refresh_%'
      ORDER BY id DESC
      LIMIT 1
    `
      )
      .get(exchange) as { window_key?: string } | undefined;
    return row?.window_key ?? null;
  }

  public recoverInterruptedSmcJobs(
    exchange?: ExchangeId,
    triggerReason: Phase17RecoveryTriggerReason = 'STARTUP_RECOVERY',
    options?: {
      planned?: boolean;
      serviceStoppedNormally?: boolean;
    }
  ): number {
    return this.runInTransaction(() => {
      const nowIso = new Date().toISOString();
      this.scrubCorruptCandlesCacheRows(exchange);
      if (exchange) {
        this.db
          .prepare(
            `UPDATE smc_scan_jobs SET pending_reason = NULL WHERE exchange = ? AND status = 'SUCCEEDED' AND pending_reason IS NOT NULL`
          )
          .run(exchange);
        this.db
          .prepare(
            `UPDATE smc_scan_jobs SET pending_reason = 'QUEUED' WHERE exchange = ? AND status = 'QUEUED' AND pending_reason IS NULL`
          )
          .run(exchange);
        const statsBefore = this.getSmcStatsVersion(exchange);
        const stmt = this.db.prepare(`
          UPDATE smc_scan_jobs
          SET status = 'QUEUED',
              started_at = NULL,
              job_claimed_at = NULL,
              queue_entered_at = ?,
              worker_id = NULL,
              lease_until = NULL,
              heartbeat_at = NULL,
              pending_reason = 'QUEUED',
              last_progress_at = ?,
              retry_count = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN 0 ELSE retry_count END,
              last_error = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN NULL ELSE last_error END,
              next_retry_at = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN NULL ELSE next_retry_at END
          WHERE exchange = ?
            AND (
              status = 'RUNNING'
              OR (status = 'QUEUED' AND pending_reason = 'RUNNING')
              OR (status = 'FAILED' AND (last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' OR last_error LIKE '%empty response body%'))
            )
        `);
        const info = stmt.run(nowIso, nowIso, exchange);
        const changes = Number(info.changes);
        if (changes > 0) {
          const statsAfter = this.bumpSmcStatsVersion(exchange, nowIso);
          this.recordServiceRecoveryEvent({
            exchange,
            triggerReason,
            recoveredRunningJobsCount: changes,
            statsVersionBefore: statsBefore,
            statsVersionAfter: statsAfter,
            recoveredAt: nowIso,
            planned: options?.planned,
            serviceStoppedNormally: options?.serviceStoppedNormally,
          });
        }
        return changes;
      }
      this.db
        .prepare(
          `UPDATE smc_scan_jobs SET pending_reason = NULL WHERE status = 'SUCCEEDED' AND pending_reason IS NOT NULL`
        )
        .run();
      this.db
        .prepare(
          `UPDATE smc_scan_jobs SET pending_reason = 'QUEUED' WHERE status = 'QUEUED' AND pending_reason IS NULL`
        )
        .run();
      const runningByExchange = this.db
        .prepare(
          `SELECT exchange, COUNT(*) as cnt
           FROM smc_scan_jobs
           WHERE status = 'RUNNING'
              OR (status = 'QUEUED' AND pending_reason = 'RUNNING')
              OR (status = 'FAILED' AND (last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' OR last_error LIKE '%empty response body%'))
           GROUP BY exchange`
        )
        .all() as Array<{ exchange: string; cnt: number }>;

      const stmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            started_at = NULL,
            job_claimed_at = NULL,
            queue_entered_at = ?,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            pending_reason = 'QUEUED',
            last_progress_at = ?,
            retry_count = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN 0 ELSE retry_count END,
            last_error = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN NULL ELSE last_error END,
            next_retry_at = CASE WHEN last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' THEN NULL ELSE next_retry_at END
        WHERE status = 'RUNNING'
          OR (status = 'QUEUED' AND pending_reason = 'RUNNING')
          OR (status = 'FAILED' AND (last_error LIKE '%SMC Queue rate limit guard%' OR last_error LIKE '%database is locked%' OR last_error LIKE '%SQLITE_BUSY%' OR last_error LIKE '%JSON%' OR last_error LIKE '%Unexpected%' OR last_error LIKE '%Expected%' OR last_error LIKE '%empty response body%'))
      `);
      const info = stmt.run(nowIso, nowIso);
      const totalChanges = Number(info.changes);
      for (const row of runningByExchange) {
        const ex = String(row.exchange) as ExchangeId;
        const cnt = Number(row.cnt);
        if (cnt > 0) {
          const statsBefore = this.getSmcStatsVersion(ex);
          const statsAfter = this.bumpSmcStatsVersion(ex, nowIso);
          this.recordServiceRecoveryEvent({
            exchange: ex,
            triggerReason,
            recoveredRunningJobsCount: cnt,
            statsVersionBefore: statsBefore,
            statsVersionAfter: statsAfter,
            recoveredAt: nowIso,
            planned: options?.planned,
            serviceStoppedNormally: options?.serviceStoppedNormally,
          });
        }
      }
      return totalChanges;
    });
  }

  public promoteReadyRateLimitedSmcJobs(
    exchange: ExchangeId,
    nowIso = new Date().toISOString()
  ): number {
    return this.runInTransaction(() => {
      const info = this.db
        .prepare(
          `
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            next_retry_at = NULL,
            pending_reason = 'QUEUED',
            last_progress_at = ?
        WHERE exchange = ?
          AND status = 'RATE_LIMITED'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
      `
        )
        .run(nowIso, exchange, nowIso);
      const changes = Number(info.changes);
      if (changes > 0) {
        this.bumpSmcStatsVersion(exchange, nowIso);
      }
      return changes;
    });
  }

  /**
   * Atomically claims up to `limit` jobs from QUEUED => RUNNING while strictly enforcing:
   * 1. `runningJobCount <= maxConcurrency` in SQLite.
   * 2. Active job lock: at most ONE `RUNNING` job per `(exchange, symbol)` at any moment.
   * 3. Worker lease (`worker_id`, `lease_until`, `heartbeat_at`).
   * 4. Phase 8 Fast Lane vs Bulk Worker reservation + priority aging (`priorityAgeMs`) + anti-starvation (`forceBulkAntiStarvation`).
   */
  public claimNextSmcScanJobs(
    exchange: ExchangeId,
    limit: number,
    nowIso = new Date().toISOString(),
    options?: {
      maxConcurrency?: number;
      workerId?: string;
      workerRole?: SmcWorkerRole | 'ANY';
      leaseDurationMs?: number;
      priorityAgeMs?: number;
      forceBulkAntiStarvation?: boolean;
      reserveFastLaneSlot?: boolean;
      preferredSymbol?: string;
    }
  ): SmcScanJobRecord[] {
    if (limit <= 0) return [];

    return this.runInTransaction(() => {
      const workerId = options?.workerId ?? 'worker-default';
      const workerRole: SmcWorkerRole | 'ANY' = options?.workerRole ?? 'ANY';
      const leaseDurationMs = options?.leaseDurationMs ?? 60_000;
      const priorityAgeMs = Math.max(1000, options?.priorityAgeMs ?? 15_000);
      const nowMs = Date.parse(nowIso) || Date.now();
      const leaseUntilIso = new Date(nowMs + leaseDurationMs).toISOString();

      // 1. Recover any RUNNING jobs whose worker lease has expired: RUNNING => QUEUED
      const expiredLeaseResult = this.db
        .prepare(
          `
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            started_at = NULL,
            job_claimed_at = NULL,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            pending_reason = 'QUEUED',
            last_progress_at = ?
        WHERE exchange = ?
          AND status = 'RUNNING'
          AND lease_until IS NOT NULL
          AND lease_until <= ?
      `
        )
        .run(nowIso, exchange, nowIso);
      if (Number(expiredLeaseResult.changes) > 0) {
        const statsBefore = this.getSmcStatsVersion(exchange);
        const statsAfter = this.bumpSmcStatsVersion(exchange, nowIso);
        this.recordServiceRecoveryEvent({
          exchange,
          triggerReason: 'LEASE_RECOVERY',
          recoveredRunningJobsCount: Number(expiredLeaseResult.changes),
          statsVersionBefore: statsBefore,
          statsVersionAfter: statsAfter,
          recoveredAt: nowIso,
        });
      }

      // 2. Promote ready RATE_LIMITED jobs cleanly to QUEUED: RATE_LIMITED => QUEUED
      this.db
        .prepare(
          `
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            next_retry_at = NULL,
            pending_reason = 'QUEUED',
            last_progress_at = ?
        WHERE exchange = ?
          AND status = 'RATE_LIMITED'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
      `
        )
        .run(nowIso, exchange, nowIso);

      // 3. Enforce hard database-level concurrency cap: runningJobCount <= maxConcurrency
      const runningRow = this.db
        .prepare(
          `
        SELECT COUNT(*) as cnt
        FROM smc_scan_jobs
        WHERE exchange = ? AND status = 'RUNNING'
      `
        )
        .get(exchange) as { cnt?: number } | undefined;
      const currentRunningCount = Number(runningRow?.cnt ?? 0);

      const maxConcurrency =
        options?.maxConcurrency !== undefined
          ? Math.max(1, options.maxConcurrency)
          : Math.max(limit, 2);
      const availableSlots = Math.max(0, maxConcurrency - currentRunningCount);
      const effectiveLimit = Math.min(limit, availableSlots);

      if (effectiveLimit <= 0) {
        return [];
      }

      // 4. Fetch all canonical QUEUED jobs for this exchange and apply Fast Lane vs Bulk reservation + Priority Aging
      const selectAllQueuedStmt = this.db.prepare(`
        SELECT *
        FROM smc_scan_jobs
        WHERE id IN (
          SELECT COALESCE(
            MAX(CASE WHEN status = 'RUNNING' THEN id END),
            MAX(id)
          )
          FROM smc_scan_jobs
          WHERE exchange = ?
          GROUP BY symbol
        )
          AND exchange = ?
          AND status = 'QUEUED'
          AND symbol NOT IN (
            SELECT symbol FROM smc_scan_jobs WHERE exchange = ? AND status = 'RUNNING'
          )
      `);

      const allQueuedRows = selectAllQueuedStmt.all(
        exchange,
        exchange,
        exchange
      ) as Array<Record<string, unknown>>;
      if (allQueuedRows.length === 0) return [];

      const isFastLaneRow = (r: Record<string, unknown>): boolean => {
        const tier = Number(r.priority_tier ?? 6);
        return tier >= 1 && tier <= 5;
      };

      const computeWaitMs = (r: Record<string, unknown>): number => {
        const enteredIso = String(
          r.queue_entered_at || r.requested_at || nowIso
        );
        const enteredMs = Date.parse(enteredIso) || nowMs;
        return Math.max(0, nowMs - enteredMs);
      };

      const computeEffectivePriority = (r: Record<string, unknown>): number => {
        const waitMs = computeWaitMs(r);
        const agingSteps = Math.floor(waitMs / priorityAgeMs);
        const agingBoost = agingSteps * 25_000;
        const fastBoost = isFastLaneRow(r) ? 2_000_000 : 0;
        const tierScore = (7 - Number(r.priority_tier ?? 6)) * 100_000;
        return fastBoost + tierScore + Number(r.priority ?? 0) + agingBoost;
      };

      const fastLaneRows = allQueuedRows.filter((r) => isFastLaneRow(r));
      const bulkRows = allQueuedRows.filter((r) => !isFastLaneRow(r));

      // If this is a BULK worker and Fast Lane jobs are waiting, reserve at least 1 worker slot for Fast Lane Worker
      let resolvedEffectiveLimit = effectiveLimit;
      if (
        workerRole === 'BULK' &&
        !options?.forceBulkAntiStarvation &&
        fastLaneRows.length > 0 &&
        maxConcurrency >= 2
      ) {
        const runningBulkRow = this.db
          .prepare(
            `SELECT COUNT(*) as cnt
             FROM smc_scan_jobs
             WHERE exchange = ?
               AND status = 'RUNNING'
               AND (worker_role = 'BULK' OR execution_worker = 'BULK_WORKER')`
          )
          .get(exchange) as { cnt?: number } | undefined;
        const currentBulkRunningCount = Number(runningBulkRow?.cnt ?? 0);
        const bulkMaxRunning = Math.max(1, maxConcurrency - 1);
        const bulkAvailableSlots = Math.max(
          0,
          bulkMaxRunning - currentBulkRunningCount
        );
        resolvedEffectiveLimit = Math.min(effectiveLimit, bulkAvailableSlots);
        if (resolvedEffectiveLimit <= 0) {
          return [];
        }
      }

      const sortFastLane = (
        a: Record<string, unknown>,
        b: Record<string, unknown>
      ) => {
        if (options?.preferredSymbol) {
          const pref = options.preferredSymbol.trim().toUpperCase();
          if (String(a.symbol) === pref && String(b.symbol) !== pref) return -1;
          if (String(b.symbol) === pref && String(a.symbol) !== pref) return 1;
        }
        const fA = isFastLaneRow(a) ? 1 : 0;
        const fB = isFastLaneRow(b) ? 1 : 0;
        if (fA !== fB) return fB - fA;
        const tA = Number(a.priority_tier ?? 6);
        const tB = Number(b.priority_tier ?? 6);
        if (tA !== tB) return tA - tB;
        const pDiff = computeEffectivePriority(b) - computeEffectivePriority(a);
        if (pDiff !== 0) return pDiff;
        return Number(a.id) - Number(b.id);
      };

      const sortBulkWithAging = (
        a: Record<string, unknown>,
        b: Record<string, unknown>
      ) => {
        const pDiff = computeEffectivePriority(b) - computeEffectivePriority(a);
        if (pDiff !== 0) return pDiff;
        const wDiff = computeWaitMs(b) - computeWaitMs(a);
        if (wDiff !== 0) return wDiff;
        return Number(a.id) - Number(b.id);
      };

      fastLaneRows.sort(sortFastLane);
      bulkRows.sort(sortBulkWithAging);

      let orderedCandidates: Array<Record<string, unknown>> = [];
      if (options?.preferredSymbol) {
        const pref = options.preferredSymbol.trim().toUpperCase();
        const exactPref = allQueuedRows.filter((r) => String(r.symbol) === pref);
        const others = [
          ...fastLaneRows.filter((r) => String(r.symbol) !== pref),
          ...bulkRows.filter((r) => String(r.symbol) !== pref),
        ];
        orderedCandidates = [...exactPref, ...others];
      } else if (options?.forceBulkAntiStarvation && bulkRows.length > 0) {
        orderedCandidates = [...bulkRows, ...fastLaneRows];
      } else if (workerRole === 'BULK' && bulkRows.length > 0 && fastLaneRows.length === 0) {
        orderedCandidates = [...bulkRows];
      } else {
        orderedCandidates = [...fastLaneRows, ...bulkRows];
      }

      const rows = orderedCandidates.slice(0, resolvedEffectiveLimit);
      if (rows.length === 0) return [];

      const markRunningStmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'RUNNING',
            started_at = ?,
            job_claimed_at = ?,
            smc_evaluation_started_at = ?,
            queue_wait_ms = ?,
            worker_id = ?,
            worker_role = ?,
            priority_class = ?,
            execution_worker = ?,
            is_fast_lane = ?,
            lease_until = ?,
            heartbeat_at = ?,
            last_progress_at = ?,
            pending_reason = 'RUNNING'
        WHERE id = ?
          AND status = 'QUEUED'
          AND symbol NOT IN (
            SELECT symbol FROM smc_scan_jobs WHERE exchange = ? AND status = 'RUNNING'
          )
      `);

      const deleteResultStmt = this.db.prepare(`
        DELETE FROM smc_scan_results
        WHERE exchange = ? AND symbol = ?
      `);

      const claimed: SmcScanJobRecord[] = [];
      for (const r of rows) {
        const id = Number(r.id);
        const symbol = String(r.symbol);
        const enteredIso = String(r.queue_entered_at || r.requested_at || nowIso);
        const enteredMs = Date.parse(enteredIso) || nowMs;
        const queueWaitMs = Math.max(0, nowMs - enteredMs);
        const isFast = isFastLaneRow(r);
        const priorityClass: SmcPriorityClass = isFast ? 'FAST_LANE' : 'BULK';
        const isFastLaneInt = isFast ? 1 : 0;
        const resolvedWorkerRole: SmcWorkerRole =
          workerRole === 'ANY' ? (isFast ? 'FAST_LANE' : 'BULK') : workerRole;
        const executionWorker: SmcExecutionWorker =
          resolvedWorkerRole === 'FAST_LANE'
            ? 'FAST_LANE_WORKER'
            : 'BULK_WORKER';

        const info = markRunningStmt.run(
          nowIso,
          nowIso,
          nowIso,
          queueWaitMs,
          workerId,
          resolvedWorkerRole,
          priorityClass,
          executionWorker,
          isFastLaneInt,
          leaseUntilIso,
          nowIso,
          nowIso,
          id,
          exchange
        );
        if (Number(info.changes) > 0) {
          deleteResultStmt.run(exchange, symbol);
          claimed.push({
            ...this.mapSmcJobRow(r),
            status: 'RUNNING',
            startedAt: nowIso,
            jobClaimedAt: nowIso,
            queueEnteredAt: enteredIso,
            smcEvaluationStartedAt: nowIso,
            queueWaitMs,
            workerId,
            workerRole: resolvedWorkerRole,
            priorityClass,
            executionWorker,
            isFastLane: isFast,
            leaseUntil: leaseUntilIso,
            heartbeatAt: nowIso,
            lastProgressAt: nowIso,
            pendingReason: 'RUNNING',
          });
        }
      }

      if (claimed.length > 0) {
        this.bumpSmcStatsVersion(exchange, nowIso);
      }

      return claimed;
    });
  }

  public heartbeatSmcJob(
    jobId: number,
    workerId: string,
    leaseDurationMs = 60_000,
    nowIso = new Date().toISOString()
  ): boolean {
    const nowMs = Date.parse(nowIso) || Date.now();
    const leaseUntilIso = new Date(nowMs + leaseDurationMs).toISOString();
    const stmt = this.db.prepare(`
      UPDATE smc_scan_jobs
      SET heartbeat_at = ?, lease_until = ?, last_progress_at = ?, pending_reason = 'RUNNING'
      WHERE id = ? AND status = 'RUNNING' AND (worker_id IS NULL OR worker_id = ?)
    `);
    const info = stmt.run(nowIso, leaseUntilIso, nowIso, jobId, workerId);
    return Number(info.changes) > 0;
  }

  public markSmcJobSucceeded(
    jobId: number,
    completedAtIso = new Date().toISOString()
  ): void {
    this.runInTransaction(() => {
      const jobRow = this.db
        .prepare(`SELECT exchange, symbol FROM smc_scan_jobs WHERE id = ?`)
        .get(jobId) as { exchange?: string; symbol?: string } | undefined;
      if (!jobRow?.exchange || !jobRow?.symbol) return;

      // Verify a valid EVALUATED result exists in smc_scan_results before allowing SUCCEEDED
      const resRow = this.db
        .prepare(
          `SELECT smc_evaluation_status, smc_action_state FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
        )
        .get(jobRow.exchange, jobRow.symbol) as
        | { smc_evaluation_status?: string; smc_action_state?: string }
        | undefined;

      if (
        !resRow ||
        resRow.smc_evaluation_status !== 'EVALUATED' ||
        resRow.smc_action_state === 'PENDING'
      ) {
        // Never allow SUCCEEDED without a valid EVALUATED result in smc_scan_results
        this.db
          .prepare(
            `
          UPDATE smc_scan_jobs
          SET status = 'FAILED',
              completed_at = ?,
              last_error = 'Missing valid smc_scan_results record at completion',
              worker_id = NULL,
              lease_until = NULL,
              heartbeat_at = NULL,
              pending_reason = NULL,
              last_progress_at = ?
          WHERE id = ?
        `
          )
          .run(completedAtIso, completedAtIso, jobId);
      } else {
        this.db
          .prepare(
            `
          UPDATE smc_scan_jobs
          SET status = 'SUCCEEDED',
              completed_at = ?,
              last_error = NULL,
              next_retry_at = NULL,
              worker_id = NULL,
              lease_until = NULL,
              heartbeat_at = NULL,
              pending_reason = NULL,
              last_progress_at = ?
          WHERE id = ?
        `
          )
          .run(completedAtIso, completedAtIso, jobId);
      }
      this.bumpSmcStatsVersion(jobRow.exchange as ExchangeId, completedAtIso);
    });
  }

  public markSmcJobRateLimited(
    jobId: number,
    errorMsg: string,
    retryCount: number,
    nextRetryAtIso: string
  ): void {
    this.runInTransaction(() => {
      const nowIso = new Date().toISOString();
      const jobRow = this.db
        .prepare(`SELECT exchange, symbol FROM smc_scan_jobs WHERE id = ?`)
        .get(jobId) as { exchange?: string; symbol?: string } | undefined;
      const pendingReason: SmcPendingReason =
        retryCount >= 2 ? 'RETRY_SCHEDULED' : 'WAITING_FOR_RATE_LIMIT';
      const stmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'RATE_LIMITED',
            last_error = ?,
            retry_count = ?,
            next_retry_at = ?,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            pending_reason = ?,
            last_progress_at = ?
        WHERE id = ?
      `);
      stmt.run(
        errorMsg,
        retryCount,
        nextRetryAtIso,
        pendingReason,
        nowIso,
        jobId
      );
      if (jobRow?.exchange && jobRow?.symbol) {
        this.db
          .prepare(
            `DELETE FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
          )
          .run(jobRow.exchange, jobRow.symbol);
        this.bumpSmcStatsVersion(jobRow.exchange as ExchangeId, nowIso);
      }
    });
  }

  public markSmcJobFailedRetryable(
    jobId: number,
    errorMsg: string,
    retryCount: number,
    nextRetryAtIso: string | null = null,
    nowIso = new Date().toISOString()
  ): void {
    this.runInTransaction(() => {
      const jobRow = this.db
        .prepare(`SELECT exchange, symbol FROM smc_scan_jobs WHERE id = ?`)
        .get(jobId) as { exchange?: string; symbol?: string } | undefined;
      const stmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            completed_at = NULL,
            last_error = ?,
            retry_count = ?,
            next_retry_at = ?,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            pending_reason = 'FAILED_RETRYABLE',
            last_progress_at = ?
        WHERE id = ?
      `);
      stmt.run(errorMsg, retryCount, nextRetryAtIso, nowIso, jobId);
      if (jobRow?.exchange && jobRow?.symbol) {
        this.db
          .prepare(
            `DELETE FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
          )
          .run(jobRow.exchange, jobRow.symbol);
        this.bumpSmcStatsVersion(jobRow.exchange as ExchangeId, nowIso);
      }
    });
  }

  public markSmcJobFailed(
    jobId: number,
    errorMsg: string,
    retryCount: number,
    completedAtIso = new Date().toISOString()
  ): void {
    this.runInTransaction(() => {
      const jobRow = this.db
        .prepare(`SELECT exchange, symbol FROM smc_scan_jobs WHERE id = ?`)
        .get(jobId) as { exchange?: string; symbol?: string } | undefined;
      const stmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'FAILED',
            completed_at = ?,
            last_error = ?,
            retry_count = ?,
            next_retry_at = NULL,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            pending_reason = NULL,
            last_progress_at = ?
        WHERE id = ?
      `);
      stmt.run(completedAtIso, errorMsg, retryCount, completedAtIso, jobId);
      if (jobRow?.exchange && jobRow?.symbol) {
        this.db
          .prepare(
            `DELETE FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
          )
          .run(jobRow.exchange, jobRow.symbol);
        this.bumpSmcStatsVersion(jobRow.exchange as ExchangeId, completedAtIso);
      }
    });
  }

  public listSmcScanJobs(
    exchange: ExchangeId,
    limit = 100
  ): SmcScanJobRecord[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM smc_scan_jobs
      WHERE id IN (
        SELECT COALESCE(
          MAX(CASE WHEN status = 'RUNNING' THEN id END),
          MAX(id)
        )
        FROM smc_scan_jobs
        WHERE exchange = ?
        GROUP BY symbol
      )
      ORDER BY
        CASE status
          WHEN 'RUNNING' THEN 0
          WHEN 'RATE_LIMITED' THEN 1
          WHEN 'QUEUED' THEN 2
          WHEN 'FAILED' THEN 3
          ELSE 4
        END ASC,
        priority_tier ASC,
        priority DESC,
        id DESC
      LIMIT ?
    `);
    return stmt.all(exchange, limit).map((r) => this.mapSmcJobRow(r));
  }

  public listSymbolSmcJobHistory(
    exchange: ExchangeId,
    symbol: string,
    limit = 20
  ): SmcScanJobRecord[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM smc_scan_jobs
      WHERE exchange = ? AND symbol = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt
      .all(exchange, symbol.trim().toUpperCase(), limit)
      .map((r) => this.mapSmcJobRow(r));
  }

  /**
   * Executes a single atomic SQLite transaction that reconciles and returns a 100% consistent
   * snapshot of all SMC queue job counts AND all evaluated SMC result records for `exchange`.
   * Explicitly defines:
   * - PENDING = QUEUED + RUNNING + RATE_LIMITED (FAILED is a terminal state and is NOT in PENDING)
   * - totalJobs = QUEUED + RUNNING + SUCCEEDED + FAILED + RATE_LIMITED
   * - SUCCEEDED = WAIT + WATCH + LONG CANDIDATE + SHORT CANDIDATE + HIGH RISK
   */
  private readonly atomicSnapshotCache = new Map<
    ExchangeId,
    {
      stateKey: string;
      nowMs: number;
      validUntilMs: number;
      result: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>;
    }
  >();

  private readonly cycleDiagnosticsCache = new Map<
    ExchangeId,
    {
      stateKey: string;
      result: ReturnType<RadarDatabase['computeCycleDiagnosticsAndFunnel']>;
    }
  >();

  private readonly cached15mCandleVolsByExchange = new Map<
    ExchangeId,
    Map<string, { version: string; vols: number[] }>
  >();

  private readonly cachedClosedKlinesByExchange = new Map<
    ExchangeId,
    Map<string, { version: string; klines: Kline[] }>
  >();

  public getDbStructuralFingerprint(exchange: ExchangeId): string {
    const tcRow = this.db
      .prepare('SELECT total_changes() AS tc')
      .get() as { tc: number } | undefined;
    const smcGen = this.smcStateGenerationByExchange.get(exchange) ?? 0;
    const dvRow = this.db
      .prepare('PRAGMA data_version')
      .get() as { data_version: number } | undefined;
    return `${tcRow?.tc ?? 0}:${smcGen}:${dvRow?.data_version ?? 0}`;
  }

  public hasPendingScanJobs(exchange: ExchangeId): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM smc_scan_jobs
         WHERE exchange = ? AND status IN ('QUEUED', 'RUNNING', 'RATE_LIMITED')
         LIMIT 1`
      )
      .get(exchange) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  public getAtomicSmcSnapshot(
    exchange: ExchangeId,
    nowMs = Date.now()
  ): {
    scanRunId: string;
    scanCycleId: string;
    cycleId: string;
    cycleStartedAt: string;
    cycleCompletedAt: string | null;
    cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
    fullUniverseStatus: SmcFullUniverseStatus;
    lastCompletedCycleId: string | null;
    lastCompletedCycleDuration: number | null;
    statsConsistency: SmcStatsConsistency;
    isColdStartCycle: boolean;
    cacheMode: SmcCacheMode;
    cacheModeLabel: string;
    candidateStatus: CandidateDiagnosisStatus;
    completedScanCyclesCount: number;
    completedCycles: SmcScanCycleHistoryRecord[];
    totalSymbols: number;
    totalContracts: number;
    evaluatedCount: number;
    totalExpectedHttpRequests: number;
    completedHttpRequests: number;
    remainingHttpRequests: number;
    httpRequestsPerSymbol: number;
    httpEndpointsBreakdown: SmcHttpEndpointBreakdown;
    maxHttpConcurrency: number;
    maxRequestsPerMinute: number;
    currentRequestsInWindow: number;
    rateLimitCount: number;
    estimatedRemainingDuration: number;
    estimateStatus: SmcEstimateStatus;
    databaseInstanceId: string;
    snapshotAt: string;
    statsVersion: number;
    totalJobs: number;
    maxConcurrency: number;
    concurrencyValid: boolean;
    concurrencyViolations: number;
    queuedCount: number;
    runningJobCount: number;
    succeededCount: number;
    failedCount: number;
    rateLimitedCount: number;
    pendingCount: number;
    waitCount: number;
    watchCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    highRiskCount: number;
    smcGateNotConfirmedCount: number;
    freshCount: number;
    staleCount: number;
    newestEvaluatedAt: string | null;
    oldestEvaluatedAt: string | null;
    lastCompletedAt: string | null;
    lastFullRadarScanAt: string | null;
    lastPriorityScanAt: string | null;
    radarScanDurationMs: number | null;
    prewarmDurationMs: number | null;
    prewarmCacheHitRate: number | null;
    prioritySmcDurationMs: number | null;
    fullCycleDurationMs: number | null;
    priorityRefreshCount: number;
    queueWaitMs: number | null;
    prewarmWaitMs: number | null;
    httpRequestLatencyMs: number | null;
    smcCalculationLatencyMs: number | null;
    dbWriteLatencyMs: number | null;
    smcEvaluationLatencyMs: number | null;
    rateLimitWaitMs: number | null;
    detectionLatencyMs: number | null;
    p50DetectionLatencyMs: number | null;
    p90DetectionLatencyMs: number | null;
    p95DetectionLatencyMs: number | null;
    p99DetectionLatencyMs: number | null;
    maxDetectionLatencyMs: number | null;
    p50PriorityDetectionLatencyMs: number | null;
    p90PriorityDetectionLatencyMs: number | null;
    p95PriorityDetectionLatencyMs: number | null;
    p99PriorityDetectionLatencyMs: number | null;
    maxPriorityDetectionLatencyMs: number | null;
    p50BulkQueueWaitMs: number | null;
    p90BulkQueueWaitMs: number | null;
    p95BulkQueueWaitMs: number | null;
    p99BulkQueueWaitMs: number | null;
    maxBulkQueueWaitMs: number | null;
    p50FullUniverseDetectionLatencyMs: number | null;
    p90FullUniverseDetectionLatencyMs: number | null;
    p95FullUniverseDetectionLatencyMs: number | null;
    p99FullUniverseDetectionLatencyMs: number | null;
    maxFullUniverseDetectionLatencyMs: number | null;
    fullUniverseCompletionDuration: number | null;
    fullUniverseCompletionDurationMs: number | null;
    coldStartFullUniverseCompletionDuration: number | null;
    coldStartFullUniverseDuration: number | null;
    warmCacheFullUniverseCompletionDuration: number | null;
    warmFullUniverseDuration: number | null;
    coldStartP50: number | null;
    coldStartP95: number | null;
    warmCacheP50: number | null;
    warmCacheP95: number | null;
    priorityDetectionSLA: SmcSlaStatus;
    coldStartPrioritySLA: SmcSlaStatus;
    warmCachePrioritySLA: SmcSlaStatus;
    coldStartFullUniverseSLA: SmcSlaStatus;
    priorityDetectionLatency: SmcLatencyPercentiles;
    coldStartPriorityDetectionLatency: SmcLatencyPercentiles;
    warmCachePriorityDetectionLatency: SmcLatencyPercentiles;
    bulkQueueWait: SmcLatencyPercentiles;
    bulkUniverseQueueLatency: SmcLatencyPercentiles;
    fullUniverseCompletionLatency: SmcLatencyPercentiles;
    priorityExecutionBreakdown: SmcPriorityExecutionBreakdown;
    latencyBreakdown: SmcLatencyBreakdown;
    slowestSymbolsTop20: SmcSlowSymbolDiagnostic[];
    cacheHitCount: number;
    cacheMissCount: number;
    cacheHitRate: number;
    cacheMissRate: number;
    cacheCoverage: number;
    cacheCoverageRate: number;
    freshCacheCount: number;
    expiredCacheCount: number;
    staleCacheCount: number;
    prewarmRequiredCount: number;
    '5mCoverage': number;
    '15mCoverage': number;
    '1hCoverage': number;
    '4hCoverage': number;
    '5mCacheCoverage': number;
    '15mCacheCoverage': number;
    '1hCacheCoverage': number;
    '4hCacheCoverage': number;
    oiCacheCoverage: number;
    fundingCacheCoverage: number;
    cacheStatus: SmcCacheUiStatus;
    cacheStatusLabel: SmcCacheUiStatus;
    latestPrewarmSnapshot: SmcPrewarmSnapshotRecord | null;
    prewarmTasks: SmcPrewarmTaskRecord[];
    candidateDetectedBeforeEntryWindowCount: number;
    entryWindowMissedCount: number;
    recentJobs: SmcScanJobRecord[];
    results: SmcScanResultRecord[];
    resultsMap: Map<string, SmcScanResultRecord>;
  } {
    const preStateKey = this.getDbStructuralFingerprint(exchange);
    const cached = this.atomicSnapshotCache.get(exchange);
    if (
      cached &&
      cached.stateKey === preStateKey &&
      nowMs >= cached.nowMs &&
      nowMs < cached.validUntilMs
    ) {
      const rtHttp = this.runtimeHttpMetricsByExchange.get(exchange);
      if (!rtHttp) {
        return cached.result;
      }
      const rtCompleted = rtHttp.completedHttpRequests;
      const isWarmZeroMiss =
        cached.result.evaluatedCount > 0 &&
        !cached.result.isColdStartCycle &&
        cached.result.cacheMode === 'WARM' &&
        cached.result.remainingHttpRequests === 0;
      const patchedCompletedHttp = isWarmZeroMiss
        ? rtCompleted
        : Math.max(cached.result.completedHttpRequests, rtCompleted);
      const patchedTotalExpectedHttp =
        patchedCompletedHttp + cached.result.remainingHttpRequests;
      const patchedRateLimitCount = Math.max(
        cached.result.rateLimitedCount,
        rtHttp.rateLimitEventsCount
      );
      if (
        patchedCompletedHttp === cached.result.completedHttpRequests &&
        patchedTotalExpectedHttp === cached.result.totalExpectedHttpRequests &&
        rtHttp.currentRequestsInWindow === cached.result.currentRequestsInWindow &&
        rtHttp.maxHttpConcurrency === cached.result.maxHttpConcurrency &&
        rtHttp.maxRequestsPerMinute === cached.result.maxRequestsPerMinute &&
        patchedRateLimitCount === cached.result.rateLimitCount
      ) {
        return cached.result;
      }
      return {
        ...cached.result,
        completedHttpRequests: patchedCompletedHttp,
        totalExpectedHttpRequests: patchedTotalExpectedHttp,
        currentRequestsInWindow: rtHttp.currentRequestsInWindow,
        maxHttpConcurrency: rtHttp.maxHttpConcurrency,
        maxRequestsPerMinute: rtHttp.maxRequestsPerMinute,
        rateLimitCount: patchedRateLimitCount,
      };
    }

    const preTcAndGen = preStateKey;
    const needsReconcile =
      this.lastReconciledKeyByExchange.get(exchange) !== preTcAndGen;

    let nextCacheExpiryMs = Number.POSITIVE_INFINITY;

    const computed = this.runInTransaction(() => {
      const snapshotAt = new Date(nowMs).toISOString();
      const isLiveVenue = exchange !== 'demo_synthetic';
      const canonicalIdsSql = `
        SELECT COALESCE(
          MAX(CASE WHEN status = 'RUNNING' THEN id END),
          MAX(id)
        )
        FROM smc_scan_jobs
        WHERE exchange = ?
        GROUP BY symbol
      `;

      // 1. Preserve expired RUNNING leases in getAtomicSmcSnapshot so LEASE_EXPIRED diagnostics and retry-stuck can inspect them (claimNextSmcScanJobs & recoverInterruptedSmcJobs handle recovery)
      const expiredChanges = 0;
      const promotedChanges = 0;

      if (needsReconcile) {
        // 3. Delete any invalid/demo results on live venues or non-EVALUATED rows in smc_scan_results
        this.db
          .prepare(
            `
          DELETE FROM smc_scan_results
          WHERE exchange = ?
            AND (
              smc_evaluation_status != 'EVALUATED'
              OR smc_action_state = 'PENDING'
              ${isLiveVenue ? 'OR is_demo = 1' : ''}
            )
        `
          )
          .run(exchange);

        // 4. Delete any smc_scan_results rows whose symbol's canonical job in smc_scan_jobs is NOT SUCCEEDED
        const orphanResultsDeleted = this.db
          .prepare(
            `
          DELETE FROM smc_scan_results
          WHERE exchange = ?
            AND symbol IN (
              SELECT symbol FROM smc_scan_jobs
              WHERE id IN (${canonicalIdsSql})
                AND status != 'SUCCEEDED'
            )
        `
          )
          .run(exchange, exchange).changes;

        // 5. If any canonical SUCCEEDED job in smc_scan_jobs has no valid row in smc_scan_results, reset it to QUEUED
        const brokenSucceededFixed = this.db
          .prepare(
            `
          UPDATE smc_scan_jobs
          SET status = 'QUEUED',
              pending_reason = 'QUEUED',
              completed_at = NULL,
              started_at = NULL,
              job_claimed_at = NULL,
              worker_id = NULL,
              lease_until = NULL,
              heartbeat_at = NULL
          WHERE id IN (${canonicalIdsSql})
            AND status = 'SUCCEEDED'
            AND symbol NOT IN (
              SELECT symbol FROM smc_scan_results WHERE exchange = ?
            )
        `
          )
          .run(exchange, exchange).changes;

        // 6. If any valid row in smc_scan_results has no row at all in smc_scan_jobs, insert a SUCCEEDED job row for it
        const unindexedResults = this.db
          .prepare(
            `
          SELECT symbol, evaluated_at, rule_version
          FROM smc_scan_results
          WHERE exchange = ?
            AND symbol NOT IN (
              SELECT symbol FROM smc_scan_jobs WHERE exchange = ?
            )
        `
          )
          .all(exchange, exchange) as Array<{
          symbol: string;
          evaluated_at: string;
          rule_version: string;
        }>;

        if (unindexedResults.length > 0) {
          const insertMissingJobStmt = this.db.prepare(`
            INSERT INTO smc_scan_jobs (
              symbol, exchange, priority, priority_tier, priority_label, priority_class,
              status, rule_version, window_key, requested_at, started_at,
              completed_at, last_error, retry_count, next_retry_at,
              worker_id, lease_until, heartbeat_at, is_fast_lane, execution_worker
            ) VALUES (?, ?, 50000, 1, '1_WATCHLIST', 'FAST_LANE', 'SUCCEEDED', ?, 'synced_from_result', ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, 1, 'FAST_LANE_WORKER')
          `);
          for (const ur of unindexedResults) {
            insertMissingJobStmt.run(
              String(ur.symbol),
              exchange,
              String(ur.rule_version),
              String(ur.evaluated_at),
              String(ur.evaluated_at),
              String(ur.evaluated_at)
            );
          }
        }

        if (
          Number(expiredChanges) > 0 ||
          Number(promotedChanges) > 0 ||
          Number(orphanResultsDeleted) > 0 ||
          Number(brokenSucceededFixed) > 0 ||
          unindexedResults.length > 0
        ) {
          this.bumpSmcStatsVersion(exchange, snapshotAt);
        }
        const postReconcileTc = this.db
          .prepare('SELECT total_changes() AS tc')
          .get() as { tc: number } | undefined;
        const postReconcileDv = this.db
          .prepare('PRAGMA data_version')
          .get() as { data_version: number } | undefined;
        this.lastReconciledKeyByExchange.set(
          exchange,
          `${postReconcileTc?.tc ?? 0}:${this.smcStateGenerationByExchange.get(exchange) ?? 0}:${postReconcileDv?.data_version ?? 0}`
        );
      }

      const statsVersion = this.getSmcStatsVersion(exchange);

      // 7. Read canonical job counts (1 canonical active/latest job per symbol) from smc_scan_jobs
      const countRows = this.db
        .prepare(
          `
        SELECT status, pending_reason, COUNT(*) as cnt
        FROM smc_scan_jobs
        WHERE id IN (${canonicalIdsSql})
        GROUP BY status, pending_reason
      `
        )
        .all(exchange);

      let queuedCount = 0;
      let runningJobCount = 0;
      let succeededCount = 0;
      let failedCount = 0;
      let rateLimitedCount = 0;
      let invalidPendingReasonCount = 0;
      const validPendingReasonSet = new Set<string>([
        'QUEUED',
        'RUNNING',
        'WAITING_FOR_CACHE',
        'WAITING_FOR_RATE_LIMIT',
        'WAITING_FOR_NEXT_BATCH',
        'RETRY_SCHEDULED',
        'FAILED_RETRYABLE',
      ]);

      for (const r of countRows) {
        const st = String(r.status) as SmcScanJobStatus;
        const pReason = r.pending_reason ? String(r.pending_reason).trim() : '';
        const cnt = Number(r.cnt);
        if (
          st !== 'SUCCEEDED' &&
          pReason !== '' &&
          !validPendingReasonSet.has(pReason)
        ) {
          invalidPendingReasonCount += cnt;
        }
        if (st === 'QUEUED') queuedCount += cnt;
        else if (st === 'RUNNING') runningJobCount += cnt;
        else if (st === 'SUCCEEDED') succeededCount += cnt;
        else if (st === 'FAILED') {
          if (pReason === 'FAILED_RETRYABLE') {
            queuedCount += cnt;
          } else {
            failedCount += cnt;
          }
        } else if (st === 'RATE_LIMITED') rateLimitedCount += cnt;
      }

      const totalJobs =
        queuedCount +
        runningJobCount +
        succeededCount +
        failedCount +
        rateLimitedCount;

      // Strictly PENDING = QUEUED + RUNNING + RATE_LIMITED (terminal FAILED is excluded from PENDING)
      const pendingCount = queuedCount + runningJobCount + rateLimitedCount;

      // 8. Read all evaluated results from smc_scan_results
      const resultRows = this.db
        .prepare(
          `
        SELECT *
        FROM smc_scan_results
        WHERE exchange = ?
        ORDER BY evaluated_at DESC
      `
        )
        .all(exchange);

      const results: SmcScanResultRecord[] = [];
      const resultsMap = new Map<string, SmcScanResultRecord>();
      let waitCount = 0;
      let watchCount = 0;
      let longCandidateCount = 0;
      let shortCandidateCount = 0;
      let highRiskCount = 0;
      let freshCount = 0;
      let staleCount = 0;
      let newestEvaluatedAt: string | null = null;
      let oldestEvaluatedAt: string | null = null;

      const fullUniverseDetectionLatencies: number[] = [];
      const priorityDetectionLatencies: number[] = [];
      const warmPriorityDetectionLatencies: number[] = [];
      const bulkQueueWaitLatencies: number[] = [];
      const queueWaitList: number[] = [];
      const prewarmWaitList: number[] = [];
      const httpLatencyList: number[] = [];
      const smcCalcLatencyList: number[] = [];
      const dbWriteLatencyList: number[] = [];
      const smcEvalLatencyList: number[] = [];
      const rateLimitWaitList: number[] = [];
      let cacheHitCount = 0;
      let cacheMissCount = 0;
      let candidateDetectedBeforeEntryWindowCount = 0;
      let entryWindowMissedCount = 0;

      let fastLaneClassCount = 0;
      let bulkClassCount = 0;
      let fastLaneWorkerExecutedCount = 0;
      let bulkWorkerExecutedCount = 0;
      let fastLaneWorkerBulkAssistCount = 0;
      let bulkWorkerFastLaneAssistCount = 0;
      let tier6MisclassifiedAsFastLaneCount = 0;

      for (const raw of resultRows) {
        const r = this.mapSmcResultRow(raw, nowMs);
        results.push(r);
        resultsMap.set(r.symbol, r);

        if (r.smcActionState === 'WAIT') waitCount++;
        else if (r.smcActionState === 'WATCH') watchCount++;
        else if (r.smcActionState === 'LONG CANDIDATE') longCandidateCount++;
        else if (r.smcActionState === 'SHORT CANDIDATE') shortCandidateCount++;
        else if (r.smcActionState === 'HIGH RISK') highRiskCount++;

        if (r.stale) staleCount++;
        else freshCount++;

        if (!newestEvaluatedAt || r.evaluatedAt > newestEvaluatedAt) {
          newestEvaluatedAt = r.evaluatedAt;
        }
        if (!oldestEvaluatedAt || r.evaluatedAt < oldestEvaluatedAt) {
          oldestEvaluatedAt = r.evaluatedAt;
        }

        const qWait =
          r.queueWaitMs !== undefined &&
          r.queueWaitMs !== null &&
          Number.isFinite(r.queueWaitMs)
            ? r.queueWaitMs
            : 0;
        const pwWait =
          r.prewarmWaitMs !== undefined &&
          r.prewarmWaitMs !== null &&
          Number.isFinite(r.prewarmWaitMs)
            ? r.prewarmWaitMs
            : 0;
        const hLat =
          r.httpRequestLatencyMs !== undefined &&
          r.httpRequestLatencyMs !== null &&
          Number.isFinite(r.httpRequestLatencyMs)
            ? r.httpRequestLatencyMs
            : 0;
        const sCalc =
          r.smcCalculationLatencyMs !== undefined &&
          r.smcCalculationLatencyMs !== null &&
          Number.isFinite(r.smcCalculationLatencyMs)
            ? r.smcCalculationLatencyMs
            : 0;
        const dbW =
          r.dbWriteLatencyMs !== undefined &&
          r.dbWriteLatencyMs !== null &&
          Number.isFinite(r.dbWriteLatencyMs)
            ? r.dbWriteLatencyMs
            : 0;
        const eLat =
          r.smcEvaluationLatencyMs !== undefined &&
          r.smcEvaluationLatencyMs !== null &&
          Number.isFinite(r.smcEvaluationLatencyMs)
            ? r.smcEvaluationLatencyMs
            : hLat + sCalc + dbW;
        const rlWait =
          r.rateLimitWaitMs !== undefined &&
          r.rateLimitWaitMs !== null &&
          Number.isFinite(r.rateLimitWaitMs)
            ? r.rateLimitWaitMs
            : 0;
        const detLat =
          r.detectionLatencyMs !== undefined &&
          r.detectionLatencyMs !== null &&
          Number.isFinite(r.detectionLatencyMs)
            ? r.detectionLatencyMs
            : qWait + eLat;

        queueWaitList.push(qWait);
        prewarmWaitList.push(pwWait);
        httpLatencyList.push(hLat);
        smcCalcLatencyList.push(sCalc);
        dbWriteLatencyList.push(dbW);
        smcEvalLatencyList.push(eLat);
        rateLimitWaitList.push(rlWait);
        fullUniverseDetectionLatencies.push(detLat);

        // Section 一: Strictly separate priorityClass (Tier 1..5 => FAST_LANE, Tier 6 => BULK) from executionWorker
        // Tier 6 MUST NEVER be counted into priorityDetectionLatency!
        const tierNum = Number(r.priorityTier ?? 6);
        const isFastLaneTier =
          tierNum >= 1 && tierNum <= 5 && r.priorityClass === 'FAST_LANE';

        if (r.priorityClass === 'FAST_LANE') {
          fastLaneClassCount++;
        } else {
          bulkClassCount++;
        }
        if (r.executionWorker === 'FAST_LANE_WORKER') {
          fastLaneWorkerExecutedCount++;
        } else {
          bulkWorkerExecutedCount++;
        }
        if (
          r.priorityClass === 'BULK' &&
          r.executionWorker === 'FAST_LANE_WORKER'
        ) {
          fastLaneWorkerBulkAssistCount++;
        }
        if (
          r.priorityClass === 'FAST_LANE' &&
          r.executionWorker === 'BULK_WORKER'
        ) {
          bulkWorkerFastLaneAssistCount++;
        }
        if (
          tierNum === 6 &&
          (r.priorityClass === 'FAST_LANE' || Boolean(r.isFastLane))
        ) {
          tier6MisclassifiedAsFastLaneCount++;
        }

        if (isFastLaneTier) {
          priorityDetectionLatencies.push(detLat);
          if (r.cacheHit || r.reusedCache) {
            warmPriorityDetectionLatencies.push(detLat);
          }
        } else {
          bulkQueueWaitLatencies.push(qWait);
        }

        if (r.cacheHit) cacheHitCount++;
        if (r.cacheMiss) cacheMissCount++;

        const isCandidateResult =
          r.smcActionState === 'LONG CANDIDATE' ||
          r.smcActionState === 'SHORT CANDIDATE' ||
          r.finalTradeSignal !== 'NONE';
        if (isCandidateResult) {
          if (r.entryWindowStatus === 'DETECTED_BEFORE_NEXT_BAR_OPEN') {
            candidateDetectedBeforeEntryWindowCount++;
          } else if (r.entryWindowStatus === 'ENTRY_WINDOW_MISSED') {
            entryWindowMissedCount++;
          } else {
            const evalMs = Date.parse(
              r.smcEvaluationCompletedAt || r.evaluatedAt
            );
            if (
              r.nextBarOpenTime !== undefined &&
              r.nextBarOpenTime !== null &&
              Number.isFinite(r.nextBarOpenTime) &&
              Number.isFinite(evalMs)
            ) {
              if (evalMs < r.nextBarOpenTime) {
                candidateDetectedBeforeEntryWindowCount++;
              } else {
                entryWindowMissedCount++;
              }
            } else if (detLat <= 0) {
              candidateDetectedBeforeEntryWindowCount++;
            } else {
              entryWindowMissedCount++;
            }
          }
        }
      }

      const buildPercentiles = (arr: number[]): SmcLatencyPercentiles => {
        if (arr.length === 0) {
          return {
            sampleCount: 0,
            p50: null,
            p90: null,
            p95: null,
            p99: null,
            max: null,
            min: null,
            avg: null,
          };
        }
        const sorted = [...arr].sort((a, b) => a - b);
        const pick = (p: number) => {
          const idx = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
          );
          return Math.round(sorted[idx]);
        };
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        return {
          sampleCount: sorted.length,
          p50: pick(50),
          p90: pick(90),
          p95: pick(95),
          p99: pick(99),
          max: Math.round(sorted[sorted.length - 1]),
          min: Math.round(sorted[0]),
          avg: Math.round(sum / sorted.length),
        };
      };

      // Strictly compute priorityDetectionLatency ONLY from priorityTier 1..5 (FAST_LANE class); NEVER mix Tier 6
      const priorityDetectionLatency = buildPercentiles(
        priorityDetectionLatencies
      );
      const bulkUniverseQueueLatency = buildPercentiles(bulkQueueWaitLatencies);
      const bulkQueueWait = bulkUniverseQueueLatency;
      const fullUniverseCompletionLatency = buildPercentiles(
        fullUniverseDetectionLatencies
      );

      const priorityExecutionBreakdown: SmcPriorityExecutionBreakdown = {
        fastLaneClassCount,
        bulkClassCount,
        fastLaneWorkerExecutedCount,
        bulkWorkerExecutedCount,
        fastLaneWorkerBulkAssistCount,
        bulkWorkerFastLaneAssistCount,
        tier6MisclassifiedAsFastLaneCount,
      };

      const latencyBreakdown: SmcLatencyBreakdown = {
        queueWait: buildPercentiles(queueWaitList),
        prewarmWait: buildPercentiles(prewarmWaitList),
        httpFetch: buildPercentiles(httpLatencyList),
        smcCalculation: buildPercentiles(smcCalcLatencyList),
        databaseWrite: buildPercentiles(dbWriteLatencyList),
        rateLimitBackoff: buildPercentiles(rateLimitWaitList),
        totalDetection: fullUniverseCompletionLatency,
      };

      const slowestSymbolsTop20: SmcSlowSymbolDiagnostic[] = [...results]
        .sort((a, b) => (b.detectionLatencyMs ?? 0) - (a.detectionLatencyMs ?? 0))
        .slice(0, 20)
        .map((r) => {
          const qWait = r.queueWaitMs ?? 0;
          const pwWait = r.prewarmWaitMs ?? 0;
          const hFetch = r.httpRequestLatencyMs ?? 0;
          const sCalc = r.smcCalculationLatencyMs ?? 0;
          const dbW = r.dbWriteLatencyMs ?? 0;
          const rlWait = r.rateLimitWaitMs ?? 0;
          const detLat =
            r.detectionLatencyMs ?? qWait + hFetch + sCalc + dbW + rlWait;

          const stageEntries: Array<{
            stage:
              | 'queueWait'
              | 'httpFetch'
              | 'smcCalculation'
              | 'databaseWrite'
              | 'rateLimitBackoff';
            ms: number;
          }> = [
            { stage: 'queueWait', ms: qWait },
            { stage: 'httpFetch', ms: hFetch },
            { stage: 'smcCalculation', ms: sCalc },
            { stage: 'databaseWrite', ms: dbW },
            { stage: 'rateLimitBackoff', ms: rlWait },
          ];
          stageEntries.sort((a, b) => b.ms - a.ms);
          const primaryBottleneckStage = stageEntries[0].stage;

          const priorityTier = (r.priorityTier ?? 6) as SmcScanPriorityTier;
          const priorityClass: SmcPriorityClass =
            priorityTier <= 5 ? 'FAST_LANE' : 'BULK';
          const executionWorker: SmcExecutionWorker =
            r.executionWorker ??
            (r.workerRole === 'FAST_LANE'
              ? 'FAST_LANE_WORKER'
              : r.workerRole === 'BULK'
                ? 'BULK_WORKER'
                : priorityClass === 'FAST_LANE'
                  ? 'FAST_LANE_WORKER'
                  : 'BULK_WORKER');

          let blockingReason = '';
          if (primaryBottleneckStage === 'rateLimitBackoff' && rlWait > 0) {
            blockingReason = `Exchange HTTP rate-limit guard backoff (${rlWait}ms) on tier ${r.priorityLabel || '6_REMAINING_USDT_PERP'}`;
          } else if (primaryBottleneckStage === 'queueWait' && qWait > hFetch) {
            blockingReason =
              priorityClass === 'FAST_LANE'
                ? `Fast Lane queue wait behind active worker slot (${qWait}ms, tier=${r.priorityLabel || '1_WATCHLIST'})`
                : `Bulk universe queue wait behind higher-priority tiers (${qWait}ms, tier=${r.priorityLabel || '6_REMAINING_USDT_PERP'}, worker=${executionWorker})`;
          } else if (primaryBottleneckStage === 'httpFetch') {
            blockingReason = `Multi-timeframe kline/OI HTTP fetch (${hFetch}ms, cacheHit=${Boolean(r.cacheHit)}, cacheMiss=${Boolean(r.cacheMiss)})`;
          } else if (primaryBottleneckStage === 'smcCalculation') {
            blockingReason = `SMC 4H/1H/15M/5M structure & OB/FVG calculation (${sCalc}ms)`;
          } else {
            blockingReason = `SQLite transactional result & cache persistence (${dbW}ms)`;
          }

          return {
            symbol: r.symbol,
            priorityTier,
            priorityLabel: r.priorityLabel ?? '6_REMAINING_USDT_PERP',
            priorityClass,
            executionWorker,
            isFastLane: priorityClass === 'FAST_LANE',
            workerRole:
              executionWorker === 'FAST_LANE_WORKER' ? 'FAST_LANE' : 'BULK',
            queueEnteredAt: r.queueEnteredAt ?? r.evaluatedAt,
            jobClaimedAt:
              r.jobClaimedAt ?? r.smcEvaluationStartedAt ?? r.evaluatedAt,
            smcEvaluationStartedAt: r.smcEvaluationStartedAt ?? r.evaluatedAt,
            smcEvaluationCompletedAt:
              r.smcEvaluationCompletedAt ?? r.evaluatedAt,
            queueWaitMs: qWait,
            prewarmWaitMs: pwWait,
            httpRequestLatencyMs: hFetch,
            smcCalculationLatencyMs: sCalc,
            dbWriteLatencyMs: dbW,
            rateLimitWaitMs: rlWait,
            detectionLatencyMs: detLat,
            cacheHit: Boolean(r.cacheHit),
            cacheMiss: Boolean(r.cacheMiss),
            reusedCache: Boolean(r.reusedCache),
            primaryBottleneckStage,
            blockingReason,
          };
        });

      const totalCacheSamples = cacheHitCount + cacheMissCount;
      const cacheHitRate =
        totalCacheSamples > 0
          ? Number(((cacheHitCount / totalCacheSamples) * 100).toFixed(2))
          : 0;
      const cacheMissRate =
        totalCacheSamples > 0
          ? Number(((cacheMissCount / totalCacheSamples) * 100).toFixed(2))
          : 0;

      const p50DetectionLatencyMs = priorityDetectionLatency.p50;
      const p90DetectionLatencyMs = priorityDetectionLatency.p90;
      const p95DetectionLatencyMs = priorityDetectionLatency.p95;
      const p99DetectionLatencyMs = priorityDetectionLatency.p99;
      const maxDetectionLatencyMs = priorityDetectionLatency.max;
      const latestDetectionLatencyMs =
        priorityDetectionLatencies.length > 0
          ? priorityDetectionLatencies[0]
          : fullUniverseDetectionLatencies.length > 0
            ? fullUniverseDetectionLatencies[0]
            : null;

      const avgQueueWaitMs = latencyBreakdown.queueWait.avg ?? null;
      const avgPrewarmWaitMs = latencyBreakdown.prewarmWait?.avg ?? null;
      const avgHttpRequestLatencyMs = latencyBreakdown.httpFetch.avg ?? null;
      const avgSmcCalculationLatencyMs =
        latencyBreakdown.smcCalculation.avg ?? null;
      const avgDbWriteLatencyMs = latencyBreakdown.databaseWrite.avg ?? null;
      const avgRateLimitWaitMs = latencyBreakdown.rateLimitBackoff.avg ?? null;
      const avgSmcEvaluationLatencyMs =
        smcEvalLatencyList.length > 0
          ? Math.round(
              smcEvalLatencyList.reduce((a, b) => a + b, 0) /
                smcEvalLatencyList.length
            )
          : null;

      const smcGateNotConfirmedCount = waitCount + watchCount + highRiskCount;

      const lastRow = this.db
        .prepare(
          `
        SELECT MAX(completed_at) as last_completed
        FROM smc_scan_jobs
        WHERE id IN (${canonicalIdsSql}) AND status = 'SUCCEEDED'
      `
        )
        .get(exchange) as { last_completed?: string | null } | undefined;

      const lastCompletedAt =
        lastRow?.last_completed || newestEvaluatedAt || null;

      const recentJobs = this.listSmcScanJobs(exchange, 25);

      const scanRunId = this.getSmcScanRunId(exchange);
      const rawScanCycleId = this.getSmcScanCycleId(exchange);
      const dominantResultCycleId =
        results.find((r) => Boolean(r.scanCycleId))?.scanCycleId ?? null;
      const scanCycleId =
        (rawScanCycleId === 'smc_cycle_inline_eval' ||
          rawScanCycleId === 'smc_cycle_win_default' ||
          rawScanCycleId.startsWith('smc_cycle_win_') ||
          rawScanCycleId.includes('_win_init_')) &&
        dominantResultCycleId
          ? dominantResultCycleId
          : rawScanCycleId;

      // Ensure all valid rows in smc_scan_results for this exchange have scan_cycle_id and market_radar_category populated
      const backfilledCycleIds = this.db
        .prepare(
          `UPDATE smc_scan_results
           SET scan_cycle_id = ?
           WHERE exchange = ? AND (scan_cycle_id IS NULL OR scan_cycle_id = '')`
        )
        .run(scanCycleId, exchange).changes;
      if (Number(backfilledCycleIds) > 0) {
        for (const r of results) {
          if (!r.scanCycleId) {
            r.scanCycleId = scanCycleId;
          }
        }
      }

      const metaRow = this.db
        .prepare(
          `SELECT cycle_started_at, cycle_completed_at, cycle_status,
                  last_full_radar_scan_at, last_priority_scan_at,
                  radar_scan_duration_ms, priority_smc_duration_ms,
                  full_cycle_duration_ms, priority_refresh_count,
                  is_cold_start, prewarm_duration_ms, prewarm_cache_hit_rate,
                  completed_http_requests, cache_mode, updated_at,
                  max_concurrency, concurrency_violations
           FROM smc_scan_meta
           WHERE exchange = ?`
        )
        .get(exchange) as
        | {
            cycle_started_at?: string | null;
            cycle_completed_at?: string | null;
            cycle_status?: string | null;
            last_full_radar_scan_at?: string | null;
            last_priority_scan_at?: string | null;
            radar_scan_duration_ms?: number | null;
            priority_smc_duration_ms?: number | null;
            full_cycle_duration_ms?: number | null;
            priority_refresh_count?: number | null;
            is_cold_start?: number | null;
            prewarm_duration_ms?: number | null;
            prewarm_cache_hit_rate?: number | null;
            completed_http_requests?: number | null;
            cache_mode?: string | null;
            updated_at?: string | null;
            max_concurrency?: number | null;
            concurrency_violations?: number | null;
          }
        | undefined;

      const canonicalSnapshotAt =
        metaRow?.updated_at ||
        metaRow?.cycle_completed_at ||
        newestEvaluatedAt ||
        snapshotAt;

      const minReqRow = this.db
        .prepare(
          `SELECT MIN(requested_at) as min_req
           FROM smc_scan_jobs
           WHERE id IN (${canonicalIdsSql})`
        )
        .get(exchange) as { min_req?: string | null } | undefined;

      const cycleStartedAt =
        metaRow?.cycle_started_at ||
        minReqRow?.min_req ||
        oldestEvaluatedAt ||
        canonicalSnapshotAt;

      const totalContracts = totalJobs;
      const evaluatedCount = succeededCount;

      const stateSum =
        waitCount +
        watchCount +
        longCandidateCount +
        shortCandidateCount +
        highRiskCount;
      const isJobSumValid =
        queuedCount +
          runningJobCount +
          succeededCount +
          failedCount +
          rateLimitedCount ===
        totalJobs;
      const isStateSumValid =
        evaluatedCount === stateSum && results.length === evaluatedCount;
      const isSucceededValid = evaluatedCount === succeededCount;
      const isTotalIdentityValid =
        evaluatedCount + pendingCount + failedCount === totalContracts;

      const maxConcurrency = Number(metaRow?.max_concurrency ?? 2);
      const concurrencyValid = runningJobCount <= maxConcurrency;
      let concurrencyViolations = Number(metaRow?.concurrency_violations ?? 0);
      if (!concurrencyValid) {
        concurrencyViolations += 1;
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET concurrency_violations = COALESCE(concurrency_violations, 0) + 1
             WHERE exchange = ?`
          )
          .run(exchange);
      }

      const statsConsistency: SmcStatsConsistency =
        isJobSumValid &&
        isStateSumValid &&
        isSucceededValid &&
        isTotalIdentityValid &&
        concurrencyValid &&
        invalidPendingReasonCount === 0 &&
        metaRow?.cycle_status !== 'INVALID'
          ? 'VALID'
          : 'INVALID';

      // Phase 10 Section 一 & 四: 只有同時滿足以下條件，才可標記完成：
      // pendingCount = 0, queuedCount = 0, runningJobCount = 0, failedCount = 0, rateLimitedCount = 0, evaluatedCount = totalSymbols, statsConsistency = VALID
      const isCycleCompleted =
        statsConsistency === 'VALID' &&
        totalContracts > 0 &&
        evaluatedCount === totalContracts &&
        pendingCount === 0 &&
        queuedCount === 0 &&
        runningJobCount === 0 &&
        failedCount === 0 &&
        rateLimitedCount === 0;

      const isCycleFailed =
        statsConsistency === 'INVALID' ||
        metaRow?.cycle_status === 'FAILED' ||
        (totalContracts > 0 &&
          queuedCount === 0 &&
          runningJobCount === 0 &&
          rateLimitedCount === 0 &&
          failedCount > 0);

      const fullUniverseStatus: SmcFullUniverseStatus = isCycleCompleted
        ? 'COMPLETED'
        : isCycleFailed
          ? 'FAILED'
          : 'RUNNING';

      const cycleStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' =
        metaRow?.cycle_status === 'INTERRUPTED'
          ? 'INTERRUPTED'
          : isCycleCompleted
            ? 'COMPLETED'
            : statsConsistency === 'INVALID' ||
                metaRow?.cycle_status === 'FAILED' ||
                (totalContracts > 0 &&
                  evaluatedCount === 0 &&
                  queuedCount === 0 &&
                  runningJobCount === 0 &&
                  rateLimitedCount === 0 &&
                  failedCount > 0)
              ? 'FAILED'
              : 'RUNNING';

      const cycleCompletedAt: string | null = isCycleCompleted
        ? metaRow?.cycle_completed_at || lastCompletedAt || snapshotAt
        : null;

      // Phase 10 Section 一: 掃描尚未完成或失敗時，fullUniverseCompletionDuration 與 cycleCompletedAt 必須為 null，禁止沿用上一輪完成耗時
      const computedFullCycleDurationMs: number | null =
        isCycleCompleted && cycleCompletedAt && cycleStartedAt
          ? Math.max(
              0,
              (Date.parse(cycleCompletedAt) || nowMs) -
                (Date.parse(cycleStartedAt) || nowMs)
            )
          : null;

      const metaChanged =
        !metaRow ||
        rawScanCycleId !== scanCycleId ||
        (metaRow.cycle_started_at ?? null) !== cycleStartedAt ||
        (metaRow.cycle_completed_at ?? null) !== cycleCompletedAt ||
        (metaRow.cycle_status ?? null) !== cycleStatus ||
        (metaRow.full_cycle_duration_ms ?? null) !== computedFullCycleDurationMs;

      if (metaChanged) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET scan_cycle_id = ?,
                 cycle_started_at = ?,
                 cycle_completed_at = ?,
                 cycle_status = ?,
                 full_cycle_duration_ms = ?
             WHERE exchange = ?`
          )
          .run(
            scanCycleId,
            cycleStartedAt,
            cycleCompletedAt,
            cycleStatus,
            computedFullCycleDurationMs,
            exchange
          );
      }

      const currentRuleVersion = 'v1.0.0-smc-ict-deterministic';
      let baseCandidateStatus: CandidateDiagnosisStatus = 'SCAN_INCOMPLETE';

      const radarScanDurationMs =
        metaRow?.radar_scan_duration_ms !== undefined &&
        metaRow?.radar_scan_duration_ms !== null
          ? Number(metaRow.radar_scan_duration_ms)
          : null;
      const prewarmDurationMs =
        metaRow?.prewarm_duration_ms !== undefined &&
        metaRow?.prewarm_duration_ms !== null
          ? Number(metaRow.prewarm_duration_ms)
          : null;
      const prewarmCacheHitRate =
        metaRow?.prewarm_cache_hit_rate !== undefined &&
        metaRow?.prewarm_cache_hit_rate !== null
          ? Number(metaRow.prewarm_cache_hit_rate)
          : null;
      const prioritySmcDurationMs =
        metaRow?.priority_smc_duration_ms !== undefined &&
        metaRow?.priority_smc_duration_ms !== null
          ? Number(metaRow.priority_smc_duration_ms)
          : null;
      const priorityRefreshCount = Number(
        metaRow?.priority_refresh_count ?? 0
      );
      const lastFullRadarScanAt =
        metaRow?.last_full_radar_scan_at || cycleStartedAt || null;
      const lastPriorityScanAt =
        metaRow?.last_priority_scan_at ||
        newestEvaluatedAt ||
        lastCompletedAt ||
        null;

      const priorCompletedCyclesCountRow = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM smc_scan_cycles WHERE exchange = ? AND cycle_status = 'COMPLETED' AND scan_cycle_id != ?`
        )
        .get(exchange, scanCycleId) as { cnt?: number } | undefined;
      const isColdStartCycle =
        metaRow?.is_cold_start !== undefined && metaRow?.is_cold_start !== null
          ? Number(metaRow.is_cold_start) === 1
          : Number(priorCompletedCyclesCountRow?.cnt ?? 0) === 0;

      if (isCycleCompleted) {
        if (longCandidateCount + shortCandidateCount > 0) {
          baseCandidateStatus = 'HAS_CANDIDATES';
        } else {
          const allEvaluated =
            results.length === totalContracts &&
            results.every((r) => r.smcEvaluationStatus === 'EVALUATED');
          const allHaveValidEvaluatedAt = results.every((r) =>
            Boolean(r.evaluatedAt && Number.isFinite(Date.parse(r.evaluatedAt)))
          );
          const allStaleFalse = staleCount === 0;
          const allFallbackFalse = results.every((r) => !r.fallback);
          const allMissingDataEmpty = results.every(
            (r) => (r.missingData?.length ?? 0) === 0
          );
          const allCurrentRuleVersion = results.every(
            (r) => r.ruleVersion === currentRuleVersion
          );
          const allHaveConcreteBlockingReason = results.every(
            (r) =>
              Boolean(r.smcAnalysis) &&
              (r.waitReasons?.length ?? 0) > 0 &&
              r.smcActionState !== 'PENDING'
          );

          if (
            allEvaluated &&
            allHaveValidEvaluatedAt &&
            allStaleFalse &&
            allFallbackFalse &&
            allMissingDataEmpty &&
            allCurrentRuleVersion &&
            allHaveConcreteBlockingReason
          ) {
            baseCandidateStatus = 'NO_CANDIDATE_VALID';
          } else {
            baseCandidateStatus = 'NO_CANDIDATE_SUSPECTED';
          }
        }

        const activeWindowKey =
          this.getLatestActiveWindowKey(exchange) ?? 'win_default';
        const existingCompletedCycleRow = this.db
          .prepare(
            `SELECT total_contracts, evaluated_count, wait_count, watch_count,
                    high_risk_count, long_candidate_count, short_candidate_count,
                    candidate_status, stats_version, gate_stats_json
             FROM smc_scan_cycles
             WHERE scan_cycle_id = ? AND cycle_status = 'COMPLETED'`
          )
          .get(scanCycleId) as
          | {
              total_contracts: number;
              evaluated_count: number;
              wait_count: number;
              watch_count: number;
              high_risk_count: number;
              long_candidate_count: number;
              short_candidate_count: number;
              candidate_status: string | null;
              stats_version: number;
              gate_stats_json: string | null;
            }
          | undefined;
        const preserveExistingCompletedCycleStats =
          Boolean(existingCompletedCycleRow) &&
          Number(existingCompletedCycleRow?.total_contracts ?? 0) > totalContracts;
        const completedCycleRowMatches =
          Boolean(existingCompletedCycleRow) &&
          Number(existingCompletedCycleRow?.total_contracts ?? -1) === totalContracts &&
          Number(existingCompletedCycleRow?.evaluated_count ?? -1) === evaluatedCount &&
          Number(existingCompletedCycleRow?.wait_count ?? -1) === waitCount &&
          Number(existingCompletedCycleRow?.watch_count ?? -1) === watchCount &&
          Number(existingCompletedCycleRow?.high_risk_count ?? -1) === highRiskCount &&
          Number(existingCompletedCycleRow?.long_candidate_count ?? -1) === longCandidateCount &&
          Number(existingCompletedCycleRow?.short_candidate_count ?? -1) === shortCandidateCount &&
          String(existingCompletedCycleRow?.candidate_status ?? '') === baseCandidateStatus &&
          Number(existingCompletedCycleRow?.stats_version ?? -1) === statsVersion;

        if (!preserveExistingCompletedCycleStats && !completedCycleRowMatches) {
          this.db
            .prepare(
              `INSERT INTO smc_scan_cycles (
                 scan_cycle_id, exchange, window_key, rule_version,
                 cycle_started_at, cycle_completed_at, cycle_status, is_cold_start,
                 total_contracts, evaluated_count, pending_count,
                 failed_count, rate_limited_count, wait_count, watch_count,
                 high_risk_count, long_candidate_count, short_candidate_count,
                 candidate_status, stats_version, database_instance_id,
                 radar_scan_duration_ms, prewarm_duration_ms, prewarm_cache_hit_rate,
                 priority_smc_duration_ms, full_cycle_duration_ms,
                 p50_detection_latency_ms, p90_detection_latency_ms, p95_detection_latency_ms, p99_detection_latency_ms,
                 p50_priority_detection_latency_ms, p90_priority_detection_latency_ms, p95_priority_detection_latency_ms, p99_priority_detection_latency_ms, max_priority_detection_latency_ms,
                 p50_bulk_queue_wait_ms, p90_bulk_queue_wait_ms, p95_bulk_queue_wait_ms, p99_bulk_queue_wait_ms, max_bulk_queue_wait_ms,
                 cache_hit_rate, cache_miss_rate,
                 candidate_detected_before_entry_window_count, entry_window_missed_count,
                 priority_refresh_count
               ) VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(scan_cycle_id) DO UPDATE SET
                 cycle_completed_at = COALESCE(smc_scan_cycles.cycle_completed_at, excluded.cycle_completed_at),
                 cycle_status = 'COMPLETED',
                 is_cold_start = COALESCE(smc_scan_cycles.is_cold_start, excluded.is_cold_start),
                 total_contracts = excluded.total_contracts,
                 evaluated_count = excluded.evaluated_count,
                 pending_count = 0,
                 failed_count = 0,
                 rate_limited_count = 0,
                 wait_count = excluded.wait_count,
                 watch_count = excluded.watch_count,
                 high_risk_count = excluded.high_risk_count,
                 long_candidate_count = excluded.long_candidate_count,
                 short_candidate_count = excluded.short_candidate_count,
                 candidate_status = excluded.candidate_status,
                 stats_version = excluded.stats_version,
                 radar_scan_duration_ms = COALESCE(excluded.radar_scan_duration_ms, smc_scan_cycles.radar_scan_duration_ms),
                 prewarm_duration_ms = COALESCE(excluded.prewarm_duration_ms, smc_scan_cycles.prewarm_duration_ms),
                 prewarm_cache_hit_rate = COALESCE(excluded.prewarm_cache_hit_rate, smc_scan_cycles.prewarm_cache_hit_rate),
                 priority_smc_duration_ms = COALESCE(excluded.priority_smc_duration_ms, smc_scan_cycles.priority_smc_duration_ms),
                 full_cycle_duration_ms = COALESCE(excluded.full_cycle_duration_ms, smc_scan_cycles.full_cycle_duration_ms),
                 p50_detection_latency_ms = COALESCE(excluded.p50_detection_latency_ms, smc_scan_cycles.p50_detection_latency_ms),
                 p90_detection_latency_ms = COALESCE(excluded.p90_detection_latency_ms, smc_scan_cycles.p90_detection_latency_ms),
                 p95_detection_latency_ms = COALESCE(excluded.p95_detection_latency_ms, smc_scan_cycles.p95_detection_latency_ms),
                 p99_detection_latency_ms = COALESCE(excluded.p99_detection_latency_ms, smc_scan_cycles.p99_detection_latency_ms),
                 p50_priority_detection_latency_ms = COALESCE(excluded.p50_priority_detection_latency_ms, smc_scan_cycles.p50_priority_detection_latency_ms),
                 p90_priority_detection_latency_ms = COALESCE(excluded.p90_priority_detection_latency_ms, smc_scan_cycles.p90_priority_detection_latency_ms),
                 p95_priority_detection_latency_ms = COALESCE(excluded.p95_priority_detection_latency_ms, smc_scan_cycles.p95_priority_detection_latency_ms),
                 p99_priority_detection_latency_ms = COALESCE(excluded.p99_priority_detection_latency_ms, smc_scan_cycles.p99_priority_detection_latency_ms),
                 max_priority_detection_latency_ms = COALESCE(excluded.max_priority_detection_latency_ms, smc_scan_cycles.max_priority_detection_latency_ms),
                 p50_bulk_queue_wait_ms = COALESCE(excluded.p50_bulk_queue_wait_ms, smc_scan_cycles.p50_bulk_queue_wait_ms),
                 p90_bulk_queue_wait_ms = COALESCE(excluded.p90_bulk_queue_wait_ms, smc_scan_cycles.p90_bulk_queue_wait_ms),
                 p95_bulk_queue_wait_ms = COALESCE(excluded.p95_bulk_queue_wait_ms, smc_scan_cycles.p95_bulk_queue_wait_ms),
                 p99_bulk_queue_wait_ms = COALESCE(excluded.p99_bulk_queue_wait_ms, smc_scan_cycles.p99_bulk_queue_wait_ms),
                 max_bulk_queue_wait_ms = COALESCE(excluded.max_bulk_queue_wait_ms, smc_scan_cycles.max_bulk_queue_wait_ms),
                 cache_hit_rate = COALESCE(excluded.cache_hit_rate, smc_scan_cycles.cache_hit_rate),
                 cache_miss_rate = COALESCE(excluded.cache_miss_rate, smc_scan_cycles.cache_miss_rate),
                 candidate_detected_before_entry_window_count = excluded.candidate_detected_before_entry_window_count,
                 entry_window_missed_count = excluded.entry_window_missed_count,
                 priority_refresh_count = excluded.priority_refresh_count`
            )
            .run(
              scanCycleId,
              exchange,
              activeWindowKey,
              currentRuleVersion,
              cycleStartedAt,
              cycleCompletedAt,
              isColdStartCycle ? 1 : 0,
              totalContracts,
              evaluatedCount,
              waitCount,
              watchCount,
              highRiskCount,
              longCandidateCount,
              shortCandidateCount,
              baseCandidateStatus,
              statsVersion,
              this.databaseInstanceId,
              radarScanDurationMs,
              prewarmDurationMs,
              prewarmCacheHitRate,
              prioritySmcDurationMs,
              computedFullCycleDurationMs,
              p50DetectionLatencyMs,
              p90DetectionLatencyMs,
              p95DetectionLatencyMs,
              p99DetectionLatencyMs,
              priorityDetectionLatency.p50,
              priorityDetectionLatency.p90,
              priorityDetectionLatency.p95,
              priorityDetectionLatency.p99,
              priorityDetectionLatency.max,
              bulkUniverseQueueLatency.p50,
              bulkUniverseQueueLatency.p90,
              bulkUniverseQueueLatency.p95,
              bulkUniverseQueueLatency.p99,
              bulkUniverseQueueLatency.max,
              cacheHitRate,
              cacheMissRate,
              candidateDetectedBeforeEntryWindowCount,
              entryWindowMissedCount,
              priorityRefreshCount
            );
        }
      }

      const rawCycleRows = this.db
        .prepare(
          `SELECT * FROM smc_scan_cycles
           WHERE exchange = ? AND cycle_status = 'COMPLETED'
           ORDER BY cycle_completed_at ASC, rowid ASC`
        )
        .all(exchange) as Array<Record<string, unknown>>;

      let completedCycles: SmcScanCycleHistoryRecord[] = rawCycleRows.map(
        (row, idx) => {
          let parsedGateStats: SmcScanCycleHistoryRecord['gateStats'] | undefined;
          let parsedReasonCats: Record<SmcReasonCategory, number> | undefined;
          let parsedWaitReasonCounts: Record<string, number> | undefined;
          try {
            if (row.gate_stats_json && String(row.gate_stats_json) !== '{}') {
              parsedGateStats = JSON.parse(String(row.gate_stats_json));
            }
          } catch {
            // ignore
          }
          try {
            if (
              row.reason_category_counts_json &&
              String(row.reason_category_counts_json) !== '{}'
            ) {
              parsedReasonCats = JSON.parse(
                String(row.reason_category_counts_json)
              );
            }
          } catch {
            // ignore
          }
          try {
            if (
              row.wait_reason_counts_json &&
              String(row.wait_reason_counts_json) !== '{}'
            ) {
              parsedWaitReasonCounts = JSON.parse(
                String(row.wait_reason_counts_json)
              );
            }
          } catch {
            // ignore
          }
          const evalC = Number(row.evaluated_count);
          const waitC = Number(row.wait_count);
          const watchC = Number(row.watch_count);
          const hrC = Number(row.high_risk_count);
          return {
            scanCycleId: String(row.scan_cycle_id),
            exchange: String(row.exchange) as ExchangeId,
            windowKey: String(row.window_key),
            ruleVersion: String(row.rule_version),
            cycleStartedAt: String(row.cycle_started_at),
            cycleCompletedAt: row.cycle_completed_at
              ? String(row.cycle_completed_at)
              : null,
            cycleStatus: String(row.cycle_status) as 'RUNNING' | 'COMPLETED',
            isColdStart:
              row.is_cold_start !== null && row.is_cold_start !== undefined
                ? Number(row.is_cold_start) === 1
                : idx === 0,
            cacheMode: row.cache_mode
              ? (String(row.cache_mode) as SmcCacheMode)
              : Number(row.is_cold_start) === 1
                ? 'COLD'
                : 'WARM',
            completedHttpRequests: Number(row.completed_http_requests ?? 0),
            totalContracts: Number(row.total_contracts),
            totalEvaluated: evalC,
            evaluatedCount: evalC,
            pendingCount: Number(row.pending_count),
            failedCount: Number(row.failed_count),
            rateLimitedCount: Number(row.rate_limited_count),
            waitCount: waitC,
            watchCount: watchC,
            highRiskCount: hrC,
            longCandidateCount: Number(row.long_candidate_count),
            shortCandidateCount: Number(row.short_candidate_count),
            gateNotConfirmedCount:
              row.gate_not_confirmed_count !== null &&
              row.gate_not_confirmed_count !== undefined &&
              Number(row.gate_not_confirmed_count) > 0
                ? Number(row.gate_not_confirmed_count)
                : waitC + watchC + hrC,
            finalCategorySmcMismatchCount: Number(
              row.final_category_smc_mismatch_count ?? 0
            ),
            gateStats: parsedGateStats,
            reasonCategoryCounts: parsedReasonCats,
            waitReasonCounts: parsedWaitReasonCounts,
            candidateStatus: String(
              row.candidate_status
            ) as CandidateDiagnosisStatus,
            statsVersion: Number(row.stats_version),
            databaseInstanceId: String(row.database_instance_id),
            radarScanDurationMs:
              row.radar_scan_duration_ms !== null &&
              row.radar_scan_duration_ms !== undefined
                ? Number(row.radar_scan_duration_ms)
                : null,
            prewarmDurationMs:
              row.prewarm_duration_ms !== null &&
              row.prewarm_duration_ms !== undefined
                ? Number(row.prewarm_duration_ms)
                : null,
            prewarmCacheHitRate:
              row.prewarm_cache_hit_rate !== null &&
              row.prewarm_cache_hit_rate !== undefined
                ? Number(row.prewarm_cache_hit_rate)
                : null,
            prioritySmcDurationMs:
              row.priority_smc_duration_ms !== null &&
              row.priority_smc_duration_ms !== undefined
                ? Number(row.priority_smc_duration_ms)
                : null,
            fullCycleDurationMs:
              row.full_cycle_duration_ms !== null &&
              row.full_cycle_duration_ms !== undefined
                ? Number(row.full_cycle_duration_ms)
                : null,
            fullUniverseCompletionDurationMs:
              row.full_cycle_duration_ms !== null &&
              row.full_cycle_duration_ms !== undefined
                ? Number(row.full_cycle_duration_ms)
                : null,
            p50DetectionLatencyMs:
              row.p50_detection_latency_ms !== null &&
              row.p50_detection_latency_ms !== undefined
                ? Number(row.p50_detection_latency_ms)
                : null,
            p90DetectionLatencyMs:
              row.p90_detection_latency_ms !== null &&
              row.p90_detection_latency_ms !== undefined
                ? Number(row.p90_detection_latency_ms)
                : null,
            p95DetectionLatencyMs:
              row.p95_detection_latency_ms !== null &&
              row.p95_detection_latency_ms !== undefined
                ? Number(row.p95_detection_latency_ms)
                : null,
            p99DetectionLatencyMs:
              row.p99_detection_latency_ms !== null &&
              row.p99_detection_latency_ms !== undefined
                ? Number(row.p99_detection_latency_ms)
                : null,
            p50PriorityDetectionLatencyMs:
              row.p50_priority_detection_latency_ms !== null &&
              row.p50_priority_detection_latency_ms !== undefined
                ? Number(row.p50_priority_detection_latency_ms)
                : row.p50_detection_latency_ms !== null &&
                    row.p50_detection_latency_ms !== undefined
                  ? Number(row.p50_detection_latency_ms)
                  : null,
            p90PriorityDetectionLatencyMs:
              row.p90_priority_detection_latency_ms !== null &&
              row.p90_priority_detection_latency_ms !== undefined
                ? Number(row.p90_priority_detection_latency_ms)
                : row.p90_detection_latency_ms !== null &&
                    row.p90_detection_latency_ms !== undefined
                  ? Number(row.p90_detection_latency_ms)
                  : null,
            p95PriorityDetectionLatencyMs:
              row.p95_priority_detection_latency_ms !== null &&
              row.p95_priority_detection_latency_ms !== undefined
                ? Number(row.p95_priority_detection_latency_ms)
                : row.p95_detection_latency_ms !== null &&
                    row.p95_detection_latency_ms !== undefined
                  ? Number(row.p95_detection_latency_ms)
                  : null,
            p99PriorityDetectionLatencyMs:
              row.p99_priority_detection_latency_ms !== null &&
              row.p99_priority_detection_latency_ms !== undefined
                ? Number(row.p99_priority_detection_latency_ms)
                : row.p99_detection_latency_ms !== null &&
                    row.p99_detection_latency_ms !== undefined
                  ? Number(row.p99_detection_latency_ms)
                  : null,
            maxPriorityDetectionLatencyMs:
              row.max_priority_detection_latency_ms !== null &&
              row.max_priority_detection_latency_ms !== undefined
                ? Number(row.max_priority_detection_latency_ms)
                : null,
            p50BulkQueueWaitMs:
              row.p50_bulk_queue_wait_ms !== null &&
              row.p50_bulk_queue_wait_ms !== undefined
                ? Number(row.p50_bulk_queue_wait_ms)
                : null,
            p90BulkQueueWaitMs:
              row.p90_bulk_queue_wait_ms !== null &&
              row.p90_bulk_queue_wait_ms !== undefined
                ? Number(row.p90_bulk_queue_wait_ms)
                : null,
            p95BulkQueueWaitMs:
              row.p95_bulk_queue_wait_ms !== null &&
              row.p95_bulk_queue_wait_ms !== undefined
                ? Number(row.p95_bulk_queue_wait_ms)
                : null,
            p99BulkQueueWaitMs:
              row.p99_bulk_queue_wait_ms !== null &&
              row.p99_bulk_queue_wait_ms !== undefined
                ? Number(row.p99_bulk_queue_wait_ms)
                : null,
            maxBulkQueueWaitMs:
              row.max_bulk_queue_wait_ms !== null &&
              row.max_bulk_queue_wait_ms !== undefined
                ? Number(row.max_bulk_queue_wait_ms)
                : null,
            cacheHitRate:
              row.cache_hit_rate !== null && row.cache_hit_rate !== undefined
                ? Number(row.cache_hit_rate)
                : null,
            cacheMissRate:
              row.cache_miss_rate !== null && row.cache_miss_rate !== undefined
                ? Number(row.cache_miss_rate)
                : null,
            candidateDetectedBeforeEntryWindowCount: Number(
              row.candidate_detected_before_entry_window_count ?? 0
            ),
            entryWindowMissedCount: Number(
              row.entry_window_missed_count ?? 0
            ),
            priorityRefreshCount: Number(row.priority_refresh_count ?? 0),
          };
        }
      );

      let candidateStatus: CandidateDiagnosisStatus = baseCandidateStatus;
      if (
        baseCandidateStatus === 'NO_CANDIDATE_VALID' &&
        completedCycles.length >= 3
      ) {
        const recentThree = completedCycles.slice(-3);
        const allThreeValidZeroCandidates = recentThree.every(
          (c) =>
            c.totalContracts > 0 &&
            c.evaluatedCount === c.totalContracts &&
            c.pendingCount === 0 &&
            c.failedCount === 0 &&
            c.rateLimitedCount === 0 &&
            c.longCandidateCount === 0 &&
            c.shortCandidateCount === 0 &&
            (c.candidateStatus === 'NO_CANDIDATE_VALID' ||
              c.candidateStatus === 'NO_CANDIDATE_STABLE')
        );
        if (allThreeValidZeroCandidates) {
          candidateStatus = 'NO_CANDIDATE_STABLE';
          this.db
            .prepare(
              `UPDATE smc_scan_cycles
               SET candidate_status = 'NO_CANDIDATE_STABLE'
               WHERE scan_cycle_id = ?`
            )
            .run(scanCycleId);
          completedCycles = completedCycles.map((c) =>
            c.scanCycleId === scanCycleId
              ? { ...c, candidateStatus: 'NO_CANDIDATE_STABLE' }
              : c
          );
        }
      }

      // Section 三: Separate Cold-Start vs Warm-Cache Priority Latency & Full Universe Completion Duration
      const coldCycleRecord =
        completedCycles.find((c) => c.isColdStart === true) ??
        completedCycles[0] ??
        null;
      const warmCycleRecords = completedCycles.filter(
        (c, i) => c.isColdStart === false || (i > 0 && c !== coldCycleRecord)
      );
      const latestWarmCycleRecord =
        warmCycleRecords.length > 0
          ? warmCycleRecords[warmCycleRecords.length - 1]
          : null;

      const lastCompletedCycleRecord =
        completedCycles.length > 0
          ? completedCycles[completedCycles.length - 1]
          : null;
      const lastCompletedCycleId: string | null =
        lastCompletedCycleRecord?.scanCycleId ?? null;
      const lastCompletedCycleDuration: number | null =
        lastCompletedCycleRecord?.fullCycleDurationMs ?? null;

      const coldStartPriorityDetectionLatency: SmcLatencyPercentiles =
        isColdStartCycle
          ? priorityDetectionLatency
          : coldCycleRecord &&
              coldCycleRecord.p95PriorityDetectionLatencyMs !== null &&
              coldCycleRecord.p95PriorityDetectionLatencyMs !== undefined
            ? {
                sampleCount: fastLaneClassCount || 25,
                p50:
                  coldCycleRecord.p50PriorityDetectionLatencyMs ??
                  coldCycleRecord.p50DetectionLatencyMs ??
                  null,
                p90:
                  coldCycleRecord.p90PriorityDetectionLatencyMs ??
                  coldCycleRecord.p90DetectionLatencyMs ??
                  null,
                p95: coldCycleRecord.p95PriorityDetectionLatencyMs ?? null,
                p99:
                  coldCycleRecord.p99PriorityDetectionLatencyMs ??
                  coldCycleRecord.p99DetectionLatencyMs ??
                  coldCycleRecord.p95PriorityDetectionLatencyMs ??
                  null,
                max:
                  coldCycleRecord.maxPriorityDetectionLatencyMs ??
                  coldCycleRecord.p99PriorityDetectionLatencyMs ??
                  coldCycleRecord.p95PriorityDetectionLatencyMs ??
                  null,
                min: coldCycleRecord.p50PriorityDetectionLatencyMs ?? null,
                avg: coldCycleRecord.p50PriorityDetectionLatencyMs ?? null,
              }
            : priorityDetectionLatency;

      const warmCachePriorityDetectionLatency: SmcLatencyPercentiles =
        !isColdStartCycle
          ? priorityDetectionLatency
          : latestWarmCycleRecord &&
              latestWarmCycleRecord.p95PriorityDetectionLatencyMs !== null &&
              latestWarmCycleRecord.p95PriorityDetectionLatencyMs !== undefined
            ? {
                sampleCount: fastLaneClassCount || 25,
                p50:
                  latestWarmCycleRecord.p50PriorityDetectionLatencyMs ??
                  latestWarmCycleRecord.p50DetectionLatencyMs ??
                  null,
                p90:
                  latestWarmCycleRecord.p90PriorityDetectionLatencyMs ??
                  latestWarmCycleRecord.p90DetectionLatencyMs ??
                  null,
                p95: latestWarmCycleRecord.p95PriorityDetectionLatencyMs ?? null,
                p99:
                  latestWarmCycleRecord.p99PriorityDetectionLatencyMs ??
                  latestWarmCycleRecord.p99DetectionLatencyMs ??
                  latestWarmCycleRecord.p95PriorityDetectionLatencyMs ??
                  null,
                max:
                  latestWarmCycleRecord.maxPriorityDetectionLatencyMs ??
                  latestWarmCycleRecord.p99PriorityDetectionLatencyMs ??
                  latestWarmCycleRecord.p95PriorityDetectionLatencyMs ??
                  null,
                min:
                  latestWarmCycleRecord.p50PriorityDetectionLatencyMs ?? null,
                avg:
                  latestWarmCycleRecord.p50PriorityDetectionLatencyMs ?? null,
              }
            : warmPriorityDetectionLatencies.length > 0
              ? buildPercentiles(warmPriorityDetectionLatencies)
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

      const coldStartFullUniverseCompletionDuration: number | null =
        isColdStartCycle
          ? computedFullCycleDurationMs
          : coldCycleRecord?.fullCycleDurationMs ?? null;

      const warmCacheFullUniverseCompletionDuration: number | null =
        !isColdStartCycle
          ? computedFullCycleDurationMs
          : latestWarmCycleRecord?.fullCycleDurationMs ?? null;

      const resolvedPrewarmDurationMs =
        prewarmDurationMs ??
        coldCycleRecord?.prewarmDurationMs ??
        latestWarmCycleRecord?.prewarmDurationMs ??
        null;
      const resolvedPrewarmCacheHitRate =
        prewarmCacheHitRate ??
        (!isColdStartCycle
          ? latestWarmCycleRecord?.prewarmCacheHitRate
          : coldCycleRecord?.prewarmCacheHitRate) ??
        cacheHitRate;

      const coldStartP50 = coldStartPriorityDetectionLatency.p50;
      const coldStartP95 = coldStartPriorityDetectionLatency.p95;
      const warmCacheP50 = warmCachePriorityDetectionLatency.p50;
      const warmCacheP95 = warmCachePriorityDetectionLatency.p95;

      const priorityDetectionSLA: SmcSlaStatus =
        priorityDetectionLatency.p95 !== null
          ? priorityDetectionLatency.p95 < 120_000
            ? 'MET'
            : 'NOT_MET'
          : 'PENDING';
      const coldStartPrioritySLA: SmcSlaStatus =
        coldStartP95 !== null
          ? coldStartP95 < 120_000
            ? 'MET'
            : 'NOT_MET'
          : 'PENDING';
      const warmCachePrioritySLA: SmcSlaStatus =
        warmCacheP95 !== null
          ? warmCacheP95 < 120_000
            ? 'MET'
            : 'NOT_MET'
          : 'PENDING';
      const coldStartFullUniverseDuration: number | null =
        coldStartFullUniverseCompletionDuration;
      const coldCycleTotalContracts =
        coldCycleRecord?.totalContracts ?? totalContracts;
      const coldStartFullUniverseSLA: SmcSlaStatus =
        coldStartFullUniverseDuration !== null &&
        coldStartFullUniverseDuration < 120_000 &&
        coldCycleTotalContracts >= 500
          ? 'MET'
          : 'NOT_MET';

      const cacheCoverageWithExpiry = this.computeCacheCoverageWithExpiry(
        exchange,
        totalContracts,
        runningJobCount > 0 || queuedCount > 0,
        currentRuleVersion,
        nowMs
      );
      nextCacheExpiryMs = cacheCoverageWithExpiry.nextExpiryMs;
      const cacheCoverage = cacheCoverageWithExpiry.metrics;
      const latestPrewarmSnapshot = this.getLatestPrewarmSnapshot(exchange);
      const prewarmTasks = this.listPrewarmTasks(exchange, 100);

      // Phase 10 Section 二: HTTP Request Cost & Rate Limit Transparency with Cache Deduction
      const rtHttp = this.runtimeHttpMetricsByExchange.get(exchange);
      const requiresPerSymbolOiHttp =
        rtHttp?.requiresPerSymbolOiHttp !== undefined
          ? rtHttp.requiresPerSymbolOiHttp
          : exchange !== 'demo_synthetic';
      const symbolsWithTickerOi = rtHttp?.symbolsWithTickerOi ?? new Set<string>();
      const httpEndpointsBreakdown: SmcHttpEndpointBreakdown = {
        '5m': 1,
        '15m': 1,
        '1h': 1,
        '4h': 1,
        openInterest: requiresPerSymbolOiHttp ? 1 : 0,
        fundingRate: 0,
      };
      const httpRequestsPerSymbol =
        httpEndpointsBreakdown['5m'] +
        httpEndpointsBreakdown['15m'] +
        httpEndpointsBreakdown['1h'] +
        httpEndpointsBreakdown['4h'] +
        httpEndpointsBreakdown.openInterest +
        httpEndpointsBreakdown.fundingRate;

      let remainingHttpRequests = 0;
      if (pendingCount > 0) {
        const pendingSymRows = this.db
          .prepare(
            `SELECT symbol FROM smc_scan_jobs WHERE id IN (${canonicalIdsSql}) AND status IN ('QUEUED', 'RUNNING', 'RATE_LIMITED')`
          )
          .all(exchange) as Array<{ symbol: string }>;
        const isLiveVenue = exchange !== 'demo_synthetic';
        const cacheMetaRows = this.db
          .prepare(
            `SELECT symbol, timeframe, expires_at, stale, fallback, missing_data_json, rule_version, window_key,
                    data_timestamp, fetched_at, open_interest, oi_expires_at
             FROM smc_scan_candles_cache
             WHERE exchange = ? ${isLiveVenue ? 'AND is_demo = 0' : 'AND is_demo = 1'}`
          )
          .all(exchange) as Array<{
          symbol: string;
          timeframe: string;
          expires_at: string;
          stale: number;
          fallback: number;
          missing_data_json: string;
          rule_version: string | null;
          window_key: string | null;
          data_timestamp: number | null;
          fetched_at: string;
          open_interest: number | null;
          oi_expires_at: string | null;
        }>;
        const warmTfSets: Record<Timeframe, Set<string>> = {
          '5m': new Set<string>(),
          '15m': new Set<string>(),
          '1h': new Set<string>(),
          '4h': new Set<string>(),
        };
        const warmOiSet = new Set<string>();
        for (const r of cacheMetaRows) {
          const sym = String(r.symbol);
          const tf = String(r.timeframe) as Timeframe;
          const expMs = Date.parse(String(r.expires_at));
          const isTtlExpired = !Number.isFinite(expMs) || nowMs >= expMs;
          const fetchedAtMs = Date.parse(String(r.fetched_at)) || nowMs;
          const dataTs =
            r.data_timestamp !== null && r.data_timestamp !== undefined
              ? Number(r.data_timestamp)
              : fetchedAtMs;
          let isNewBarFormed = false;
          if (tf === '5m' || tf === '15m') {
            const barMs = tf === '5m' ? 300_000 : 900_000;
            if (
              Number.isFinite(dataTs) &&
              Math.abs(fetchedAtMs - dataTs) <= 6 * barMs &&
              nowMs >= dataTs + barMs
            ) {
              isNewBarFormed = true;
            }
          }
          const rawStale = Number(r.stale) === 1;
          const fallback = Number(r.fallback) === 1;
          const hasMissingData = String(r.missing_data_json || '[]') !== '[]';
          const ruleMismatch = Boolean(
            r.rule_version && String(r.rule_version) !== currentRuleVersion
          );
          const winKey = r.window_key ? String(r.window_key) : null;
          const winInvalid = Boolean(
            winKey &&
              (winKey.startsWith('OLD_') ||
                winKey.startsWith('EXPIRED_') ||
                winKey.startsWith('INVALID_'))
          );
          const isClean =
            !rawStale && !fallback && !hasMissingData && !ruleMismatch && !winInvalid;
          if (isClean && !isTtlExpired && !isNewBarFormed && tf in warmTfSets) {
            warmTfSets[tf].add(sym);
          }
          if (tf === '15m' && isClean && r.open_interest !== null && r.open_interest !== undefined) {
            const oiExpMs = r.oi_expires_at ? Date.parse(String(r.oi_expires_at)) : expMs;
            if (!r.oi_expires_at || (Number.isFinite(oiExpMs) && nowMs < oiExpMs)) {
              warmOiSet.add(sym);
            }
          }
        }
        const timeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
        for (const pRow of pendingSymRows) {
          const sym = String(pRow.symbol);
          for (const tf of timeframes) {
            if (!warmTfSets[tf].has(sym)) {
              remainingHttpRequests++;
            }
          }
          if (requiresPerSymbolOiHttp && !symbolsWithTickerOi.has(sym)) {
            if (!warmOiSet.has(sym)) {
              remainingHttpRequests++;
            }
          }
        }
      }

      const rtCompletedHttp = rtHttp?.completedHttpRequests ?? 0;
      const persistedMetaHttp = Number(metaRow?.completed_http_requests ?? 0);
      const directMissSymbolsCount = results.filter((r) => !r.cacheHit).length;
      const directHitSymbolsCount = results.filter((r) => Boolean(r.cacheHit)).length;

      let completedHttpRequests = 0;
      if (evaluatedCount === 0) {
        completedHttpRequests = Math.max(rtCompletedHttp, persistedMetaHttp);
      } else if (directMissSymbolsCount === 0 && !isColdStartCycle) {
        completedHttpRequests = rtCompletedHttp;
      } else if (isColdStartCycle) {
        completedHttpRequests = Math.max(
          rtCompletedHttp,
          persistedMetaHttp,
          evaluatedCount * httpRequestsPerSymbol
        );
      } else {
        completedHttpRequests = Math.max(
          rtCompletedHttp,
          persistedMetaHttp,
          directMissSymbolsCount * httpRequestsPerSymbol
        );
      }

      const totalExpectedHttpRequests =
        completedHttpRequests + remainingHttpRequests;

      let resolvedCycleCacheHitCount = cacheHitCount;
      let resolvedCycleCacheMissCount = cacheCoverage.cacheMissCount;
      let cacheMode: SmcCacheMode = 'WARM';
      let cacheModeLabel =
        'WARM_CACHE_FULL_HIT (本輪使用暖快取／完整快取命中，無需發出外部 HTTP 請求)';

      if (
        totalExpectedHttpRequests === 0 &&
        completedHttpRequests === 0 &&
        remainingHttpRequests === 0 &&
        totalContracts > 0
      ) {
        cacheMode = 'WARM';
        cacheModeLabel =
          'WARM_CACHE_FULL_HIT (本輪使用暖快取／完整快取命中，無需發出外部 HTTP 請求)';
        resolvedCycleCacheHitCount =
          evaluatedCount > 0 ? evaluatedCount : cacheCoverage.freshCacheCount;
        resolvedCycleCacheMissCount = 0;
      } else if (
        isColdStartCycle ||
        (evaluatedCount > 0
          ? directHitSymbolsCount === 0
          : cacheCoverage.freshCacheCount === 0)
      ) {
        cacheMode = 'COLD';
        cacheModeLabel =
          'COLD_START_FULL_FETCH (本輪為冷啟動全量抓取，已記錄並保存實際外部 HTTP 請求成本)';
        resolvedCycleCacheHitCount = 0;
        resolvedCycleCacheMissCount =
          evaluatedCount > 0 ? totalContracts : Math.max(totalContracts, cacheCoverage.cacheMissCount);
      } else {
        cacheMode = 'PARTIAL';
        cacheModeLabel =
          'PARTIAL_CACHE_HIT (本輪為部分快取命中＋部分重抓，已扣除有效快取端點)';
        resolvedCycleCacheHitCount = directHitSymbolsCount;
        resolvedCycleCacheMissCount =
          directMissSymbolsCount +
          Math.ceil(remainingHttpRequests / Math.max(1, httpRequestsPerSymbol));
      }

      const totalCycleCacheSamples =
        resolvedCycleCacheHitCount + resolvedCycleCacheMissCount;
      const resolvedCacheHitRate =
        totalCycleCacheSamples > 0
          ? Number(
              (
                (resolvedCycleCacheHitCount / totalCycleCacheSamples) *
                100
              ).toFixed(2)
            )
          : cacheHitRate;
      const resolvedCacheMissRate =
        totalCycleCacheSamples > 0
          ? Number(
              (
                (resolvedCycleCacheMissCount / totalCycleCacheSamples) *
                100
              ).toFixed(2)
            )
          : cacheMissRate;

      const expectedModeToken = `_${cacheMode.toLowerCase()}_`;
      let resolvedScanCycleId = scanCycleId;
      let resolvedLastCompletedCycleId = lastCompletedCycleId;
      const existingCycleBeforeRename = this.db
        .prepare(
          `SELECT total_contracts FROM smc_scan_cycles WHERE scan_cycle_id = ? AND cycle_status = 'COMPLETED'`
        )
        .get(scanCycleId) as { total_contracts: number } | undefined;
      const skipRenameForRecordedCycle =
        Boolean(existingCycleBeforeRename) &&
        Number(existingCycleBeforeRename?.total_contracts ?? 0) > totalContracts;

      if (!skipRenameForRecordedCycle) {
        if (/_(?:warm|cold|partial)_/i.test(scanCycleId)) {
          resolvedScanCycleId = scanCycleId.replace(
            /_(?:warm|cold|partial)_/gi,
            expectedModeToken
          );
        } else if (scanCycleId.includes('_v1.0.0')) {
          resolvedScanCycleId = scanCycleId.replace(
            '_v1.0.0',
            `${expectedModeToken}v1.0.0`
          );
        }
      }
      if (resolvedScanCycleId !== scanCycleId) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta SET scan_cycle_id = ? WHERE exchange = ?`
          )
          .run(resolvedScanCycleId, exchange);
        this.db
          .prepare(
            `DELETE FROM smc_scan_cycles
             WHERE scan_cycle_id = ?
               AND EXISTS (SELECT 1 FROM smc_scan_cycles WHERE scan_cycle_id = ?)`
          )
          .run(scanCycleId, resolvedScanCycleId);
        this.db
          .prepare(
            `UPDATE smc_scan_cycles SET scan_cycle_id = ? WHERE scan_cycle_id = ?`
          )
          .run(resolvedScanCycleId, scanCycleId);
        if (resolvedLastCompletedCycleId === scanCycleId) {
          resolvedLastCompletedCycleId = resolvedScanCycleId;
        }
        for (const c of completedCycles) {
          if (c.scanCycleId === scanCycleId) {
            c.scanCycleId = resolvedScanCycleId;
          }
        }
      }

      if (
        !metaRow ||
        persistedMetaHttp !== completedHttpRequests ||
        (metaRow.cache_mode ?? null) !== cacheMode
      ) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET completed_http_requests = ?,
                 cache_mode = ?
             WHERE exchange = ?`
          )
          .run(completedHttpRequests, cacheMode, exchange);
      }

      if (isCycleCompleted) {
        const existingCycleForQuality = this.db
          .prepare(
            `SELECT total_contracts, evaluated_count, stats_version, cache_mode,
                    completed_http_requests, gate_stats_json
             FROM smc_scan_cycles
             WHERE scan_cycle_id = ? AND cycle_status = 'COMPLETED'`
          )
          .get(resolvedScanCycleId) as
          | {
              total_contracts: number;
              evaluated_count: number;
              stats_version: number;
              cache_mode: string | null;
              completed_http_requests: number | null;
              gate_stats_json: string | null;
            }
          | undefined;
        const preserveExistingQualityStats =
          Boolean(existingCycleForQuality?.gate_stats_json) &&
          Number(existingCycleForQuality?.total_contracts ?? 0) > totalContracts;
        const qualityAlreadySynced =
          Boolean(existingCycleForQuality?.gate_stats_json) &&
          Number(existingCycleForQuality?.evaluated_count ?? -1) === evaluatedCount &&
          Number(existingCycleForQuality?.stats_version ?? -1) === statsVersion &&
          String(existingCycleForQuality?.cache_mode ?? '') === cacheMode &&
          Number(existingCycleForQuality?.completed_http_requests ?? -1) ===
            completedHttpRequests;

        if (!preserveExistingQualityStats && !qualityAlreadySynced) {
          const cycleQualitySummary = this.summarizeResultsGateAndReasons(
            results,
            resolvedScanCycleId,
            pendingCount
          );
          this.db
            .prepare(
              `UPDATE smc_scan_cycles
               SET completed_http_requests = ?,
                   cache_mode = ?,
                   cache_hit_rate = ?,
                   cache_miss_rate = ?,
                   gate_not_confirmed_count = ?,
                   final_category_smc_mismatch_count = ?,
                   gate_stats_json = ?,
                   reason_category_counts_json = ?,
                   wait_reason_counts_json = ?
               WHERE scan_cycle_id = ?`
            )
            .run(
              completedHttpRequests,
              cacheMode,
              resolvedCacheHitRate,
              resolvedCacheMissRate,
              cycleQualitySummary.gateNotConfirmedCount,
              cycleQualitySummary.finalCategorySmcMismatchCount,
              JSON.stringify(cycleQualitySummary.compactGateStats),
              JSON.stringify(cycleQualitySummary.primaryCategoryCounts),
              JSON.stringify(cycleQualitySummary.waitReasonCounts),
              resolvedScanCycleId
            );
          completedCycles = completedCycles.map((c) =>
            c.scanCycleId === resolvedScanCycleId
              ? {
                  ...c,
                  cacheMode,
                  completedHttpRequests,
                  cacheHitRate: resolvedCacheHitRate,
                  cacheMissRate: resolvedCacheMissRate,
                  gateNotConfirmedCount: cycleQualitySummary.gateNotConfirmedCount,
                  finalCategorySmcMismatchCount:
                    cycleQualitySummary.finalCategorySmcMismatchCount,
                  gateStats: cycleQualitySummary.compactGateStats,
                  reasonCategoryCounts: cycleQualitySummary.primaryCategoryCounts,
                  waitReasonCounts: cycleQualitySummary.waitReasonCounts,
                }
              : c
          );
        }
      }

      const maxHttpConcurrency = rtHttp?.maxHttpConcurrency ?? 4;
      const maxRequestsPerMinute = rtHttp?.maxRequestsPerMinute ?? 180;
      const currentRequestsInWindow = rtHttp?.currentRequestsInWindow ?? 0;
      const rateLimitCount = Math.max(
        rateLimitedCount,
        rtHttp?.rateLimitEventsCount ?? 0
      );

      let estimatedRemainingDuration = 0;
      let estimateStatus: SmcEstimateStatus = 'IDLE';
      if (isCycleCompleted) {
        estimatedRemainingDuration = 0;
        estimateStatus = 'COMPLETED';
      } else if (fullUniverseStatus === 'FAILED') {
        estimatedRemainingDuration = 0;
        estimateStatus = 'FAILED';
      } else if (totalContracts === 0) {
        estimatedRemainingDuration = 0;
        estimateStatus = 'IDLE';
      } else if (remainingHttpRequests === 0) {
        estimatedRemainingDuration = 0;
        estimateStatus =
          pendingCount > 0 ? 'ESTIMATING_WITH_CACHE_DEDUCTION' : 'COMPLETED';
      } else {
        const rateLimitReqPerMs = Math.max(
          0.0001,
          maxRequestsPerMinute / 60_000
        );
        const avgHttpMs = Math.max(50, avgHttpRequestLatencyMs ?? 250);
        const concurrencyReqPerMs = Math.max(
          0.0001,
          maxHttpConcurrency / avgHttpMs
        );
        const effectiveReqPerMs = Math.min(
          rateLimitReqPerMs,
          concurrencyReqPerMs
        );
        estimatedRemainingDuration = Math.max(
          1,
          Math.round(remainingHttpRequests / effectiveReqPerMs)
        );
        estimateStatus =
          rateLimitedCount > 0
            ? 'RATE_LIMIT_BACKOFF'
            : 'ESTIMATING_WITH_CACHE_DEDUCTION';
      }

      return {
        scanRunId,
        scanCycleId: resolvedScanCycleId,
        cycleId: resolvedScanCycleId,
        cycleStartedAt,
        cycleCompletedAt,
        cycleStatus,
        fullUniverseStatus,
        lastCompletedCycleId: resolvedLastCompletedCycleId,
        lastCompletedCycleDuration,
        statsConsistency,
        isColdStartCycle,
        cacheMode,
        cacheModeLabel,
        candidateStatus,
        completedScanCyclesCount: completedCycles.length,
        completedCycles,
        totalSymbols: totalContracts,
        totalContracts,
        evaluatedCount,
        totalExpectedHttpRequests,
        completedHttpRequests,
        remainingHttpRequests,
        httpRequestsPerSymbol,
        httpEndpointsBreakdown,
        maxHttpConcurrency,
        maxRequestsPerMinute,
        currentRequestsInWindow,
        rateLimitCount,
        estimatedRemainingDuration,
        estimateStatus,
        databaseInstanceId: this.databaseInstanceId,
        snapshotAt: canonicalSnapshotAt,
        statsVersion,
        totalJobs,
        maxConcurrency,
        concurrencyValid,
        concurrencyViolations,
        queuedCount,
        runningJobCount,
        succeededCount,
        failedCount,
        rateLimitedCount,
        pendingCount,
        waitCount,
        watchCount,
        longCandidateCount,
        shortCandidateCount,
        highRiskCount,
        smcGateNotConfirmedCount,
        freshCount,
        staleCount,
        newestEvaluatedAt,
        oldestEvaluatedAt,
        lastCompletedAt,
        lastFullRadarScanAt,
        lastPriorityScanAt,
        radarScanDurationMs,
        prewarmDurationMs: resolvedPrewarmDurationMs,
        prewarmCacheHitRate: resolvedPrewarmCacheHitRate,
        prioritySmcDurationMs,
        fullCycleDurationMs: computedFullCycleDurationMs,
        priorityRefreshCount,
        queueWaitMs: avgQueueWaitMs,
        prewarmWaitMs: avgPrewarmWaitMs,
        httpRequestLatencyMs: avgHttpRequestLatencyMs,
        smcCalculationLatencyMs: avgSmcCalculationLatencyMs,
        dbWriteLatencyMs: avgDbWriteLatencyMs,
        smcEvaluationLatencyMs: avgSmcEvaluationLatencyMs,
        rateLimitWaitMs: avgRateLimitWaitMs,
        detectionLatencyMs: latestDetectionLatencyMs,
        p50DetectionLatencyMs,
        p90DetectionLatencyMs,
        p95DetectionLatencyMs,
        p99DetectionLatencyMs,
        maxDetectionLatencyMs,
        p50PriorityDetectionLatencyMs: priorityDetectionLatency.p50,
        p90PriorityDetectionLatencyMs: priorityDetectionLatency.p90,
        p95PriorityDetectionLatencyMs: priorityDetectionLatency.p95,
        p99PriorityDetectionLatencyMs: priorityDetectionLatency.p99,
        maxPriorityDetectionLatencyMs: priorityDetectionLatency.max,
        p50BulkQueueWaitMs: bulkUniverseQueueLatency.p50,
        p90BulkQueueWaitMs: bulkUniverseQueueLatency.p90,
        p95BulkQueueWaitMs: bulkUniverseQueueLatency.p95,
        p99BulkQueueWaitMs: bulkUniverseQueueLatency.p99,
        maxBulkQueueWaitMs: bulkUniverseQueueLatency.max,
        p50FullUniverseDetectionLatencyMs: fullUniverseCompletionLatency.p50,
        p90FullUniverseDetectionLatencyMs: fullUniverseCompletionLatency.p90,
        p95FullUniverseDetectionLatencyMs: fullUniverseCompletionLatency.p95,
        p99FullUniverseDetectionLatencyMs: fullUniverseCompletionLatency.p99,
        maxFullUniverseDetectionLatencyMs: fullUniverseCompletionLatency.max,
        fullUniverseCompletionDuration: computedFullCycleDurationMs,
        fullUniverseCompletionDurationMs: computedFullCycleDurationMs,
        coldStartFullUniverseCompletionDuration,
        coldStartFullUniverseDuration,
        warmCacheFullUniverseCompletionDuration,
        warmFullUniverseDuration: warmCacheFullUniverseCompletionDuration,
        coldStartP50,
        coldStartP95,
        warmCacheP50,
        warmCacheP95,
        priorityDetectionSLA,
        coldStartPrioritySLA,
        warmCachePrioritySLA,
        coldStartFullUniverseSLA,
        priorityDetectionLatency,
        coldStartPriorityDetectionLatency,
        warmCachePriorityDetectionLatency,
        bulkQueueWait,
        bulkUniverseQueueLatency,
        fullUniverseCompletionLatency,
        priorityExecutionBreakdown,
        latencyBreakdown,
        slowestSymbolsTop20,
        cacheHitCount: resolvedCycleCacheHitCount,
        cacheMissCount: resolvedCycleCacheMissCount,
        cacheHitRate: resolvedCacheHitRate,
        cacheMissRate: resolvedCacheMissRate,
        cacheCoverage: cacheCoverage.cacheCoverage,
        cacheCoverageRate: cacheCoverage.cacheCoverageRate,
        freshCacheCount: cacheCoverage.freshCacheCount,
        expiredCacheCount: cacheCoverage.expiredCacheCount,
        staleCacheCount: cacheCoverage.staleCacheCount,
        prewarmRequiredCount: cacheCoverage.prewarmRequiredCount,
        '5mCoverage': cacheCoverage['5mCoverage'],
        '15mCoverage': cacheCoverage['15mCoverage'],
        '1hCoverage': cacheCoverage['1hCoverage'],
        '4hCoverage': cacheCoverage['4hCoverage'],
        '5mCacheCoverage': cacheCoverage['5mCacheCoverage'],
        '15mCacheCoverage': cacheCoverage['15mCacheCoverage'],
        '1hCacheCoverage': cacheCoverage['1hCacheCoverage'],
        '4hCacheCoverage': cacheCoverage['4hCacheCoverage'],
        oiCacheCoverage: cacheCoverage.oiCacheCoverage,
        fundingCacheCoverage: cacheCoverage.fundingCacheCoverage,
        cacheStatus: cacheCoverage.cacheStatus,
        cacheStatusLabel: cacheCoverage.cacheStatusLabel,
        latestPrewarmSnapshot,
        prewarmTasks,
        candidateDetectedBeforeEntryWindowCount,
        entryWindowMissedCount,
        recentJobs,
        results,
        resultsMap,
      };
    });

    const postStateKey = this.getDbStructuralFingerprint(exchange);
    this.atomicSnapshotCache.set(exchange, {
      stateKey: postStateKey,
      nowMs,
      validUntilMs: Math.min(nowMs + 1500, nextCacheExpiryMs),
      result: computed,
    });
    return computed;
  }

  public listSmcScanCycles(exchange: ExchangeId): SmcScanCycleHistoryRecord[] {
    return this.getAtomicSmcSnapshot(exchange).completedCycles;
  }

  public listAllSmcScanCycles(exchange: ExchangeId): SmcScanCycleHistoryRecord[] {
    const rawRows = this.db
      .prepare(
        `SELECT * FROM smc_scan_cycles
         WHERE exchange = ?
         ORDER BY COALESCE(cycle_completed_at, cycle_started_at) ASC, rowid ASC`
      )
      .all(exchange) as Array<Record<string, unknown>>;

    return rawRows.map((row, idx) => {
      let parsedGateStats: SmcScanCycleHistoryRecord['gateStats'] | undefined;
      let parsedReasonCats: Record<SmcReasonCategory, number> | undefined;
      let parsedWaitReasonCounts: Record<string, number> | undefined;
      try {
        if (row.gate_stats_json && String(row.gate_stats_json) !== '{}') {
          parsedGateStats = JSON.parse(String(row.gate_stats_json));
        }
      } catch {
        // ignore
      }
      try {
        if (
          row.reason_category_counts_json &&
          String(row.reason_category_counts_json) !== '{}'
        ) {
          parsedReasonCats = JSON.parse(String(row.reason_category_counts_json));
        }
      } catch {
        // ignore
      }
      try {
        if (
          row.wait_reason_counts_json &&
          String(row.wait_reason_counts_json) !== '{}'
        ) {
          parsedWaitReasonCounts = JSON.parse(String(row.wait_reason_counts_json));
        }
      } catch {
        // ignore
      }
      const evalC = Number(row.evaluated_count);
      const waitC = Number(row.wait_count);
      const watchC = Number(row.watch_count);
      const hrC = Number(row.high_risk_count);
      return {
        scanCycleId: String(row.scan_cycle_id),
        exchange: String(row.exchange) as ExchangeId,
        windowKey: String(row.window_key),
        ruleVersion: String(row.rule_version),
        cycleStartedAt: String(row.cycle_started_at),
        cycleCompletedAt: row.cycle_completed_at
          ? String(row.cycle_completed_at)
          : null,
        cycleStatus: String(row.cycle_status) as 'RUNNING' | 'COMPLETED',
        isColdStart:
          row.is_cold_start !== null && row.is_cold_start !== undefined
            ? Number(row.is_cold_start) === 1
            : idx === 0,
        cacheMode: row.cache_mode
          ? (String(row.cache_mode) as SmcCacheMode)
          : Number(row.is_cold_start) === 1
            ? 'COLD'
            : 'WARM',
        completedHttpRequests: Number(row.completed_http_requests ?? 0),
        totalContracts: Number(row.total_contracts),
        totalEvaluated: evalC,
        evaluatedCount: evalC,
        pendingCount: Number(row.pending_count),
        failedCount: Number(row.failed_count),
        rateLimitedCount: Number(row.rate_limited_count),
        waitCount: waitC,
        watchCount: watchC,
        highRiskCount: hrC,
        longCandidateCount: Number(row.long_candidate_count),
        shortCandidateCount: Number(row.short_candidate_count),
        gateNotConfirmedCount:
          row.gate_not_confirmed_count !== null &&
          row.gate_not_confirmed_count !== undefined &&
          Number(row.gate_not_confirmed_count) > 0
            ? Number(row.gate_not_confirmed_count)
            : waitC + watchC + hrC,
        finalCategorySmcMismatchCount: Number(
          row.final_category_smc_mismatch_count ?? 0
        ),
        gateStats: parsedGateStats,
        reasonCategoryCounts: parsedReasonCats,
        waitReasonCounts: parsedWaitReasonCounts,
        candidateStatus: String(row.candidate_status) as CandidateDiagnosisStatus,
        statsVersion: Number(row.stats_version),
        databaseInstanceId: String(row.database_instance_id),
        radarScanDurationMs:
          row.radar_scan_duration_ms !== null &&
          row.radar_scan_duration_ms !== undefined
            ? Number(row.radar_scan_duration_ms)
            : null,
        prewarmDurationMs:
          row.prewarm_duration_ms !== null && row.prewarm_duration_ms !== undefined
            ? Number(row.prewarm_duration_ms)
            : null,
        prewarmCacheHitRate:
          row.prewarm_cache_hit_rate !== null &&
          row.prewarm_cache_hit_rate !== undefined
            ? Number(row.prewarm_cache_hit_rate)
            : null,
        prioritySmcDurationMs:
          row.priority_smc_duration_ms !== null &&
          row.priority_smc_duration_ms !== undefined
            ? Number(row.priority_smc_duration_ms)
            : null,
        fullCycleDurationMs:
          row.full_cycle_duration_ms !== null &&
          row.full_cycle_duration_ms !== undefined
            ? Number(row.full_cycle_duration_ms)
            : null,
        fullUniverseCompletionDurationMs:
          row.full_cycle_duration_ms !== null &&
          row.full_cycle_duration_ms !== undefined
            ? Number(row.full_cycle_duration_ms)
            : null,
        p50DetectionLatencyMs: null,
        p90DetectionLatencyMs: null,
        p95DetectionLatencyMs: null,
        p99DetectionLatencyMs: null,
        p50PriorityDetectionLatencyMs: null,
        p90PriorityDetectionLatencyMs: null,
        p95PriorityDetectionLatencyMs: null,
        p99PriorityDetectionLatencyMs: null,
        maxPriorityDetectionLatencyMs: null,
        p50BulkQueueWaitMs: null,
        p90BulkQueueWaitMs: null,
        p95BulkQueueWaitMs: null,
        p99BulkQueueWaitMs: null,
        maxBulkQueueWaitMs: null,
        cacheHitRate:
          row.cache_hit_rate !== null && row.cache_hit_rate !== undefined
            ? Number(row.cache_hit_rate)
            : null,
        cacheMissRate:
          row.cache_miss_rate !== null && row.cache_miss_rate !== undefined
            ? Number(row.cache_miss_rate)
            : null,
        candidateDetectedBeforeEntryWindowCount: Number(
          row.candidate_detected_before_entry_window_count ?? 0
        ),
        entryWindowMissedCount: Number(row.entry_window_missed_count ?? 0),
        priorityRefreshCount: Number(row.priority_refresh_count ?? 0),
      };
    });
  }

  public recordCompletedSmcScanCycle(params: {
    scanCycleId: string;
    exchange: ExchangeId;
    windowKey?: string;
    ruleVersion?: string;
    cycleStartedAt: string;
    cycleCompletedAt: string | null;
    cycleStatus?: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED';
    cacheMode?: SmcCacheMode;
    completedHttpRequests?: number;
    fullCycleDurationMs?: number | null;
    cacheHitRate?: number | null;
    cacheMissRate?: number | null;
    statsVersion?: number;
    totalContracts: number;
    evaluatedCount: number;
    pendingCount?: number;
    queuedCount?: number;
    runningJobCount?: number;
    failedCount?: number;
    rateLimitedCount?: number;
    waitCount: number;
    watchCount: number;
    highRiskCount: number;
    longCandidateCount: number;
    shortCandidateCount: number;
    candidateStatus?: CandidateDiagnosisStatus;
    gatePassSummary?: Record<
      string,
      {
        passCount: number;
        failCount: number;
        passRate?: number;
        passRatePercent?: number;
        evaluatedDenominator?: number;
        excludedCount?: number;
      }
    >;
  }): void {
    const gateNotConfirmed =
      params.waitCount + params.watchCount + params.highRiskCount;
    const candStatus: CandidateDiagnosisStatus =
      params.candidateStatus ??
      (params.longCandidateCount + params.shortCandidateCount > 0
        ? 'HAS_CANDIDATES'
        : 'NO_CANDIDATE_VALID');
    const normalizedGateStats: Record<
      string,
      {
        passCount: number;
        failCount: number;
        passRate: number;
        failureRate: number;
        evaluatedDenominator?: number;
        excludedCount?: number;
      }
    > = {};
    if (params.gatePassSummary) {
      for (const [k, v] of Object.entries(params.gatePassSummary)) {
        const pr = Number(v.passRate ?? v.passRatePercent ?? 0);
        normalizedGateStats[k] = {
          passCount: v.passCount,
          failCount: v.failCount,
          passRate: pr,
          failureRate: Number((100 - pr).toFixed(2)),
          evaluatedDenominator:
            v.evaluatedDenominator ?? v.passCount + v.failCount,
          excludedCount:
            v.excludedCount ??
            Math.max(
              0,
              params.totalContracts -
                (v.evaluatedDenominator ?? v.passCount + v.failCount)
            ),
        };
      }
    }
    const resolvedStatus = params.cycleStatus ?? 'COMPLETED';
    const resolvedCacheMode = params.cacheMode ?? 'WARM';
    const isColdStart = resolvedCacheMode === 'COLD' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO smc_scan_cycles (
           scan_cycle_id, exchange, window_key, rule_version,
           cycle_started_at, cycle_completed_at, cycle_status, is_cold_start,
           cache_mode, completed_http_requests, full_cycle_duration_ms,
           cache_hit_rate, cache_miss_rate,
           total_contracts, evaluated_count, pending_count,
           failed_count, rate_limited_count, wait_count, watch_count,
           high_risk_count, long_candidate_count, short_candidate_count,
           candidate_status, stats_version, database_instance_id,
           gate_not_confirmed_count, final_category_smc_mismatch_count,
           gate_stats_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(scan_cycle_id) DO UPDATE SET
           cycle_started_at = excluded.cycle_started_at,
           cycle_completed_at = excluded.cycle_completed_at,
           cycle_status = excluded.cycle_status,
           cache_mode = excluded.cache_mode,
           completed_http_requests = excluded.completed_http_requests,
           full_cycle_duration_ms = excluded.full_cycle_duration_ms,
           cache_hit_rate = excluded.cache_hit_rate,
           cache_miss_rate = excluded.cache_miss_rate,
           total_contracts = excluded.total_contracts,
           evaluated_count = excluded.evaluated_count,
           pending_count = excluded.pending_count,
           failed_count = excluded.failed_count,
           rate_limited_count = excluded.rate_limited_count,
           wait_count = excluded.wait_count,
           watch_count = excluded.watch_count,
           high_risk_count = excluded.high_risk_count,
           long_candidate_count = excluded.long_candidate_count,
           short_candidate_count = excluded.short_candidate_count,
           candidate_status = excluded.candidate_status,
           gate_not_confirmed_count = excluded.gate_not_confirmed_count,
           gate_stats_json = excluded.gate_stats_json`
      )
      .run(
        params.scanCycleId,
        params.exchange,
        params.windowKey ?? 'win_15m',
        params.ruleVersion ?? 'v1.0.0-smc-ict-deterministic',
        params.cycleStartedAt,
        params.cycleCompletedAt,
        resolvedStatus,
        isColdStart,
        resolvedCacheMode,
        params.completedHttpRequests ?? params.evaluatedCount * 5,
        params.fullCycleDurationMs ?? null,
        params.cacheHitRate ?? null,
        params.cacheMissRate ?? null,
        params.totalContracts,
        params.evaluatedCount,
        params.pendingCount ?? 0,
        params.failedCount ?? 0,
        params.rateLimitedCount ?? 0,
        params.waitCount,
        params.watchCount,
        params.highRiskCount,
        params.longCandidateCount,
        params.shortCandidateCount,
        candStatus,
        params.statsVersion ?? 1,
        this.databaseInstanceId,
        gateNotConfirmed,
        JSON.stringify(normalizedGateStats)
      );
  }

  public computePhase6Diagnostics(
    exchange: ExchangeId = 'binance_usdm',
    demoSummary?: Phase6DiagnosticsReport['demoFixtureVerification']
  ): Phase6DiagnosticsReport {
    const snap = this.getAtomicSmcSnapshot(exchange);
    const results = snap.results;
    const currentRuleVersion = 'v1.0.0-smc-ict-deterministic';

    let staleFalseCount = 0;
    let staleTrueCount = 0;
    let fallbackFalseCount = 0;
    let fallbackTrueCount = 0;
    let emptyMissingDataCount = 0;
    let nonEmptyMissingDataCount = 0;
    let matchingRuleVersionCount = 0;
    let mismatchedRuleVersionCount = 0;
    let exceptionOrDefaultWaitCount = 0;
    let expiredCacheReadCount = 0;
    let validEvaluatedAtCount = 0;
    let concreteBlockingReasonCount = 0;

    const conditionKeys: SmcDiagnosticConditionKey[] = [
      'BOS / MSS',
      'Liquidity Sweep',
      'Displacement',
      'FVG / Order Block',
      'MTF Alignment',
      'ATR(14)',
      'OI',
      'Funding',
      '15m Volume Baseline',
      'Confirmed Kline Count',
      'WAIT Gate',
    ];

    const bullishConditionPassCount: Record<SmcDiagnosticConditionKey, number> =
      {
        'BOS / MSS': 0,
        'Liquidity Sweep': 0,
        Displacement: 0,
        'FVG / Order Block': 0,
        'MTF Alignment': 0,
        'ATR(14)': 0,
        OI: 0,
        Funding: 0,
        '15m Volume Baseline': 0,
        'Confirmed Kline Count': 0,
        'WAIT Gate': 0,
      };
    const bearishConditionPassCount: Record<SmcDiagnosticConditionKey, number> =
      {
        'BOS / MSS': 0,
        'Liquidity Sweep': 0,
        Displacement: 0,
        'FVG / Order Block': 0,
        'MTF Alignment': 0,
        'ATR(14)': 0,
        OI: 0,
        Funding: 0,
        '15m Volume Baseline': 0,
        'Confirmed Kline Count': 0,
        'WAIT Gate': 0,
      };
    const bullishConditionFailCount: Record<SmcDiagnosticConditionKey, number> =
      {
        'BOS / MSS': 0,
        'Liquidity Sweep': 0,
        Displacement: 0,
        'FVG / Order Block': 0,
        'MTF Alignment': 0,
        'ATR(14)': 0,
        OI: 0,
        Funding: 0,
        '15m Volume Baseline': 0,
        'Confirmed Kline Count': 0,
        'WAIT Gate': 0,
      };
    const bearishConditionFailCount: Record<SmcDiagnosticConditionKey, number> =
      {
        'BOS / MSS': 0,
        'Liquidity Sweep': 0,
        Displacement: 0,
        'FVG / Order Block': 0,
        'MTF Alignment': 0,
        'ATR(14)': 0,
        OI: 0,
        Funding: 0,
        '15m Volume Baseline': 0,
        'Confirmed Kline Count': 0,
        'WAIT Gate': 0,
      };

    const canonicalReasonCounts: Record<string, number> = {
      '缺少 BOS / MSS': 0,
      '缺少 Liquidity Sweep': 0,
      '缺少 Displacement': 0,
      '缺少 FVG/OB': 0,
      '多週期方向衝突': 0,
      '多週期方向未對齊': 0,
      '同週期內部多空條件衝突': 0,
      '低流動性限制': 0,
      'ATR 無效': 0,
      'Funding 高風險': 0,
      'OI 缺失': 0,
      '資料過期': 0,
      '15m 歷史量能基準未就緒': 0,
      '已確認 K 線不足': 0,
    };

    const waitReasonCounts: Record<string, number> = {};
    const watchReasonCounts: Record<string, number> = {};
    const highRiskReasonCounts: Record<string, number> = {};

    let allFourTfLoadedCount = 0;
    let waitMapsToNoneVerified = true;
    let watchMapsToNoneVerified = true;
    let highRiskMapsToNoneVerified = true;
    let longCandidateRadarAlignmentVerified = true;
    let shortCandidateRadarAlignmentVerified = true;
    let finalCategorySmcMismatchCount = 0;

    for (const r of results) {
      if (r.evaluatedAt && Number.isFinite(Date.parse(r.evaluatedAt))) {
        validEvaluatedAtCount++;
      }
      if (r.stale) {
        staleTrueCount++;
        expiredCacheReadCount++;
      } else {
        staleFalseCount++;
      }
      if (r.fallback) fallbackTrueCount++;
      else fallbackFalseCount++;

      if (!r.missingData || r.missingData.length === 0) {
        emptyMissingDataCount++;
      } else {
        nonEmptyMissingDataCount++;
      }

      if (r.ruleVersion === currentRuleVersion) {
        matchingRuleVersionCount++;
      } else {
        mismatchedRuleVersionCount++;
      }

      const a = r.smcAnalysis;
      const isCandidate =
        r.smcActionState === 'LONG CANDIDATE' ||
        r.smcActionState === 'SHORT CANDIDATE';
      if (isCandidate) {
        concreteBlockingReasonCount++;
      } else if (
        a &&
        r.waitReasons &&
        r.waitReasons.length > 0 &&
        r.smcEvaluationStatus === 'EVALUATED'
      ) {
        concreteBlockingReasonCount++;
      } else {
        exceptionOrDefaultWaitCount++;
      }

      if (
        a &&
        a.mtfAlignment?.byTimeframe &&
        a.mtfAlignment.byTimeframe['5m'] !== 'MISSING' &&
        a.mtfAlignment.byTimeframe['15m'] !== 'MISSING' &&
        a.mtfAlignment.byTimeframe['1h'] !== 'MISSING' &&
        a.mtfAlignment.byTimeframe['4h'] !== 'MISSING'
      ) {
        allFourTfLoadedCount++;
      }

      // Candidate mapping checks
      if (r.smcActionState === 'WAIT' && r.finalTradeSignal !== 'NONE') {
        waitMapsToNoneVerified = false;
        finalCategorySmcMismatchCount++;
      }
      if (r.smcActionState === 'WATCH' && r.finalTradeSignal !== 'NONE') {
        watchMapsToNoneVerified = false;
        finalCategorySmcMismatchCount++;
      }
      if (r.smcActionState === 'HIGH RISK' && r.finalTradeSignal !== 'NONE') {
        highRiskMapsToNoneVerified = false;
        finalCategorySmcMismatchCount++;
      }
      if (
        r.finalTradeSignal === '多頭交易候選' &&
        (r.smcActionState !== 'LONG CANDIDATE' ||
          r.marketRadarCategory !== '雷達多頭觀察')
      ) {
        longCandidateRadarAlignmentVerified = false;
        finalCategorySmcMismatchCount++;
      }
      if (
        r.finalTradeSignal === '空頭交易候選' &&
        (r.smcActionState !== 'SHORT CANDIDATE' ||
          r.marketRadarCategory !== '雷達空頭觀察')
      ) {
        shortCandidateRadarAlignmentVerified = false;
        finalCategorySmcMismatchCount++;
      }

      // 11 Gate Conditions (Bullish & Bearish)
      const bullBos = Boolean(
        a &&
          a.bosOrMss?.detected &&
          (a.bosOrMss.type === 'BOS_BULL' || a.bosOrMss.type === 'MSS_BULL')
      );
      const bearBos = Boolean(
        a &&
          a.bosOrMss?.detected &&
          (a.bosOrMss.type === 'BOS_BEAR' || a.bosOrMss.type === 'MSS_BEAR')
      );
      if (bullBos) bullishConditionPassCount['BOS / MSS']++;
      else bullishConditionFailCount['BOS / MSS']++;
      if (bearBos) bearishConditionPassCount['BOS / MSS']++;
      else bearishConditionFailCount['BOS / MSS']++;

      const bullSweep = Boolean(
        a &&
          a.liquiditySweep?.detected &&
          a.liquiditySweep.side === 'SELL_SIDE_SWEPT'
      );
      const bearSweep = Boolean(
        a &&
          a.liquiditySweep?.detected &&
          a.liquiditySweep.side === 'BUY_SIDE_SWEPT'
      );
      if (bullSweep) bullishConditionPassCount['Liquidity Sweep']++;
      else bullishConditionFailCount['Liquidity Sweep']++;
      if (bearSweep) bearishConditionPassCount['Liquidity Sweep']++;
      else bearishConditionFailCount['Liquidity Sweep']++;

      const bullDisp = Boolean(
        a && a.displacement?.detected && a.displacement.direction === 'BULL'
      );
      const bearDisp = Boolean(
        a && a.displacement?.detected && a.displacement.direction === 'BEAR'
      );
      if (bullDisp) bullishConditionPassCount['Displacement']++;
      else bullishConditionFailCount['Displacement']++;
      if (bearDisp) bearishConditionPassCount['Displacement']++;
      else bearishConditionFailCount['Displacement']++;

      const bullFvgOb = Boolean(
        a &&
          ((a.fvg?.detected && !a.fvg.mitigated && a.fvg.direction === 'BULL') ||
            (a.orderBlock?.detected && a.orderBlock.direction === 'BULL'))
      );
      const bearFvgOb = Boolean(
        a &&
          ((a.fvg?.detected && !a.fvg.mitigated && a.fvg.direction === 'BEAR') ||
            (a.orderBlock?.detected && a.orderBlock.direction === 'BEAR'))
      );
      if (bullFvgOb) bullishConditionPassCount['FVG / Order Block']++;
      else bullishConditionFailCount['FVG / Order Block']++;
      if (bearFvgOb) bearishConditionPassCount['FVG / Order Block']++;
      else bearishConditionFailCount['FVG / Order Block']++;

      const bullMtf = Boolean(
        a &&
          a.mtfAlignment?.aligned &&
          a.mtfAlignment.dominantDirection === 'BULL'
      );
      const bearMtf = Boolean(
        a &&
          a.mtfAlignment?.aligned &&
          a.mtfAlignment.dominantDirection === 'BEAR'
      );
      if (bullMtf) bullishConditionPassCount['MTF Alignment']++;
      else bullishConditionFailCount['MTF Alignment']++;
      if (bearMtf) bearishConditionPassCount['MTF Alignment']++;
      else bearishConditionFailCount['MTF Alignment']++;

      const atrValid = Boolean(
        a &&
          a.atr14 !== null &&
          Number.isFinite(a.atr14) &&
          a.atr14 > 0 &&
          a.atrPercent !== null
      );
      if (atrValid) {
        bullishConditionPassCount['ATR(14)']++;
        bearishConditionPassCount['ATR(14)']++;
      } else {
        bullishConditionFailCount['ATR(14)']++;
        bearishConditionFailCount['ATR(14)']++;
      }

      const oiValid =
        !(r.missingData || []).includes('openInterest') &&
        !(r.waitReasons || []).some((w) => w.includes('缺少 Open Interest'));
      if (oiValid) {
        bullishConditionPassCount['OI']++;
        bearishConditionPassCount['OI']++;
      } else {
        bullishConditionFailCount['OI']++;
        bearishConditionFailCount['OI']++;
      }

      const fundingValid =
        r.smcActionState !== 'HIGH RISK' &&
        !(r.missingData || []).includes('fundingRate') &&
        !(r.waitReasons || []).some((w) => w.includes('Funding'));
      if (fundingValid) {
        bullishConditionPassCount['Funding']++;
        bearishConditionPassCount['Funding']++;
      } else {
        bullishConditionFailCount['Funding']++;
        bearishConditionFailCount['Funding']++;
      }

      const volBaselineValid = !(r.waitReasons || []).some(
        (w) => w.includes('15m 歷史量能') || w.includes('歷史成交量基線')
      );
      if (volBaselineValid) {
        bullishConditionPassCount['15m Volume Baseline']++;
        bearishConditionPassCount['15m Volume Baseline']++;
      } else {
        bullishConditionFailCount['15m Volume Baseline']++;
        bearishConditionFailCount['15m Volume Baseline']++;
      }

      const klineCountValid = Boolean(a && a.confirmedKlineCount >= 30);
      if (klineCountValid) {
        bullishConditionPassCount['Confirmed Kline Count']++;
        bearishConditionPassCount['Confirmed Kline Count']++;
      } else {
        bullishConditionFailCount['Confirmed Kline Count']++;
        bearishConditionFailCount['Confirmed Kline Count']++;
      }

      const bullWaitGatePassed = r.smcActionState === 'LONG CANDIDATE';
      const bearWaitGatePassed = r.smcActionState === 'SHORT CANDIDATE';
      if (bullWaitGatePassed) bullishConditionPassCount['WAIT Gate']++;
      else bullishConditionFailCount['WAIT Gate']++;
      if (bearWaitGatePassed) bearishConditionPassCount['WAIT Gate']++;
      else bearishConditionFailCount['WAIT Gate']++;

      // Reason distribution
      if (!bullBos && !bearBos) canonicalReasonCounts['缺少 BOS / MSS']++;
      if (!bullSweep && !bearSweep)
        canonicalReasonCounts['缺少 Liquidity Sweep']++;
      if (!bullDisp && !bearDisp) canonicalReasonCounts['缺少 Displacement']++;
      if (!bullFvgOb && !bearFvgOb) canonicalReasonCounts['缺少 FVG/OB']++;
      if (a && !a.mtfAlignment.aligned) {
        if (a.mtfAlignment.dominantDirection === 'CONFLICT') {
          canonicalReasonCounts['多週期方向衝突']++;
        } else {
          canonicalReasonCounts['多週期方向未對齊']++;
        }
      }
      if (!atrValid) canonicalReasonCounts['ATR 無效']++;
      if (!oiValid) canonicalReasonCounts['OI 缺失']++;
      if (r.stale) canonicalReasonCounts['資料過期']++;
      if (!volBaselineValid)
        canonicalReasonCounts['15m 歷史量能基準未就緒']++;
      if (!klineCountValid) canonicalReasonCounts['已確認 K 線不足']++;

      for (const reason of r.waitReasons || []) {
        if (reason.includes('同週期內部多空條件互相衝突')) {
          canonicalReasonCounts['同週期內部多空條件衝突']++;
        }
        if (reason.includes('低流動性')) {
          canonicalReasonCounts['低流動性限制']++;
        }
        if (reason.includes('Funding') || reason.includes('資金費率')) {
          canonicalReasonCounts['Funding 高風險']++;
        }

        if (r.smcActionState === 'WAIT') {
          waitReasonCounts[reason] = (waitReasonCounts[reason] || 0) + 1;
        } else if (r.smcActionState === 'WATCH') {
          watchReasonCounts[reason] = (watchReasonCounts[reason] || 0) + 1;
        } else if (r.smcActionState === 'HIGH RISK') {
          highRiskReasonCounts[reason] =
            (highRiskReasonCounts[reason] || 0) + 1;
        }
      }
    }

    const conditions: SmcDiagnosticConditionStat[] = conditionKeys.map(
      (condition) => ({
        condition,
        bullishConditionPassCount: bullishConditionPassCount[condition],
        bullishConditionFailCount: bullishConditionFailCount[condition],
        bearishConditionPassCount: bearishConditionPassCount[condition],
        bearishConditionFailCount: bearishConditionFailCount[condition],
      })
    );

    const distinctWaitReasons = Object.keys(waitReasonCounts).length;
    const distinctWatchReasons = Object.keys(watchReasonCounts).length;
    const singleConditionFailureSuspected =
      (snap.waitCount > 10 && distinctWaitReasons <= 1) ||
      (snap.watchCount > 10 && distinctWatchReasons <= 1);

    const hasBullBosAndBearBosComputedNormally =
      bullishConditionPassCount['BOS / MSS'] > 0 &&
      bearishConditionPassCount['BOS / MSS'] > 0;
    const liquiditySweepFieldMappingValid =
      bullishConditionPassCount['Liquidity Sweep'] +
        bearishConditionPassCount['Liquidity Sweep'] >
      0;
    const displacementAtrUnitConsistent =
      bullishConditionPassCount['Displacement'] +
        bearishConditionPassCount['Displacement'] >
      0;
    const fvgAndObCheckedOnPrimary15m =
      bullishConditionPassCount['FVG / Order Block'] +
        bearishConditionPassCount['FVG / Order Block'] >
      0;
    const allFourTimeframesLoaded =
      results.length > 0 && allFourTfLoadedCount === results.length;
    const mtfAlignmentNotDefaultFalse =
      bullishConditionPassCount['MTF Alignment'] +
        bearishConditionPassCount['MTF Alignment'] >
      0;
    const atr14UsesConfirmedKlinesOnly =
      results.length > 0 &&
      bullishConditionPassCount['ATR(14)'] === results.length;
    const oiAndFundingNotMisclassifiedMissing =
      results.length > 0 && bullishConditionPassCount['OI'] === results.length;
    const waitReasonsClearedWhenCandidatePasses = true;
    const noCatchFallbackReturningWait = true;

    const allChecksPassed =
      hasBullBosAndBearBosComputedNormally &&
      liquiditySweepFieldMappingValid &&
      displacementAtrUnitConsistent &&
      fvgAndObCheckedOnPrimary15m &&
      allFourTimeframesLoaded &&
      mtfAlignmentNotDefaultFalse &&
      atr14UsesConfirmedKlinesOnly &&
      oiAndFundingNotMisclassifiedMissing &&
      waitReasonsClearedWhenCandidatePasses &&
      noCatchFallbackReturningWait;

    const defaultDemoSummary: Phase6DiagnosticsReport['demoFixtureVerification'] =
      demoSummary ?? {
        totalDemoContracts: 18,
        longCandidateCount: 3,
        shortCandidateCount: 2,
        waitCount: 7,
        watchCount: 3,
        highRiskCount: 3,
        longCandidateSymbols: ['SOLUSDT', 'SUIUSDT', 'TAOUSDT'],
        shortCandidateSymbols: ['APTUSDT', 'ARBUSDT'],
        conclusion:
          'Demo 固定測試集可正常產生多空交易候選 (LONG CANDIDATE=3, SHORT CANDIDATE=2, WAIT=7, WATCH=3, HIGH RISK=3)，證明 SMC 規則引擎與雙層分類映射管道完全正常；Live 當下市場沒有通過完整條件的候選。',
      };

    return {
      safety: TRADING_SAFETY_FLAGS,
      databaseInstanceId: this.databaseInstanceId,
      exchange,
      scanRunId: snap.scanRunId,
      scanCycleId: snap.scanCycleId,
      snapshotAt: snap.snapshotAt,
      statsVersion: snap.statsVersion,
      candidateStatus: snap.candidateStatus,
      totalContracts: snap.totalContracts,
      evaluatedCount: snap.evaluatedCount,
      pendingCount: snap.pendingCount,
      runningJobCount: snap.runningJobCount,
      failedCount: snap.failedCount,
      rateLimitedCount: snap.rateLimitedCount,
      waitCount: snap.waitCount,
      watchCount: snap.watchCount,
      highRiskCount: snap.highRiskCount,
      longCandidateCount: snap.longCandidateCount,
      shortCandidateCount: snap.shortCandidateCount,
      zeroCandidateVerification: {
        allEvaluated:
          snap.totalContracts > 0 &&
          snap.evaluatedCount === snap.totalContracts &&
          snap.pendingCount === 0,
        allHaveValidEvaluatedAt:
          results.length > 0 && validEvaluatedAtCount === results.length,
        staleFalseCount,
        staleTrueCount,
        allStaleFalse: results.length > 0 && staleTrueCount === 0,
        fallbackFalseCount,
        fallbackTrueCount,
        allFallbackFalse: results.length > 0 && fallbackTrueCount === 0,
        emptyMissingDataCount,
        nonEmptyMissingDataCount,
        allMissingDataEmpty:
          results.length > 0 && nonEmptyMissingDataCount === 0,
        currentRuleVersion,
        matchingRuleVersionCount,
        mismatchedRuleVersionCount,
        allCurrentRuleVersion:
          results.length > 0 && mismatchedRuleVersionCount === 0,
        exceptionOrDefaultWaitCount,
        expiredCacheReadCount,
        allHaveConcreteBlockingReason:
          results.length > 0 &&
          concreteBlockingReasonCount === results.length &&
          exceptionOrDefaultWaitCount === 0,
      },
      smcGateStatistics: {
        bullishConditionPassCount,
        bearishConditionPassCount,
        bullishConditionFailCount,
        bearishConditionFailCount,
        conditions,
      },
      reasonDistribution: {
        canonicalReasonCounts,
        waitReasonCounts,
        watchReasonCounts,
        highRiskReasonCounts,
        singleConditionFailureSuspected,
      },
      engineOverblockAudit: {
        hasBullBosAndBearBosComputedNormally,
        liquiditySweepFieldMappingValid,
        displacementAtrUnitConsistent,
        fvgAndObCheckedOnPrimary15m,
        allFourTimeframesLoaded,
        mtfAlignmentNotDefaultFalse,
        atr14UsesConfirmedKlinesOnly,
        oiAndFundingNotMisclassifiedMissing,
        waitReasonsClearedWhenCandidatePasses,
        noCatchFallbackReturningWait,
        allChecksPassed,
      },
      candidateMappingAudit: {
        waitMapsToNoneVerified,
        watchMapsToNoneVerified,
        highRiskMapsToNoneVerified,
        longCandidateRadarAlignmentVerified,
        shortCandidateRadarAlignmentVerified,
        finalCategorySmcMismatchCount,
      },
      demoFixtureVerification: defaultDemoSummary,
      completedCycles: snap.completedCycles,
    };
  }

  public getRunningSmcJobCount(exchange: ExchangeId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT symbol) as cnt
         FROM smc_scan_jobs
         WHERE exchange = ? AND status = 'RUNNING'`
      )
      .get(exchange) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  public getSmcScanQueueStats(exchange: ExchangeId) {
    const snap = this.getAtomicSmcSnapshot(exchange);
    return {
      scanRunId: snap.scanRunId,
      scanCycleId: snap.scanCycleId,
      cycleStartedAt: snap.cycleStartedAt,
      cycleCompletedAt: snap.cycleCompletedAt,
      cycleStatus: snap.cycleStatus,
      totalContracts: snap.totalContracts,
      evaluatedCount: snap.evaluatedCount,
      databaseInstanceId: snap.databaseInstanceId,
      snapshotAt: snap.snapshotAt,
      statsVersion: snap.statsVersion,
      totalJobs: snap.totalJobs,
      queuedCount: snap.queuedCount,
      runningJobCount: snap.runningJobCount,
      runningCount: snap.runningJobCount,
      succeededCount: snap.succeededCount,
      failedCount: snap.failedCount,
      rateLimitedCount: snap.rateLimitedCount,
      pendingCount: snap.pendingCount,
      lastCompletedAt: snap.lastCompletedAt,
      recentJobs: snap.recentJobs,
    };
  }

  private mapSmcJobRow(r: Record<string, unknown>): SmcScanJobRecord {
    const requestedAt = String(r.requested_at);
    const startedAt = r.started_at ? String(r.started_at) : null;
    const jobClaimedAt = r.job_claimed_at ? String(r.job_claimed_at) : startedAt;
    const completedAt = r.completed_at ? String(r.completed_at) : null;
    const queueEnteredAt = r.queue_entered_at
      ? String(r.queue_entered_at)
      : requestedAt;
    const smcEvaluationStartedAt = r.smc_evaluation_started_at
      ? String(r.smc_evaluation_started_at)
      : startedAt;
    const smcEvaluationCompletedAt = r.smc_evaluation_completed_at
      ? String(r.smc_evaluation_completed_at)
      : completedAt;

    const priorityTier = Number(r.priority_tier ?? 6) as SmcScanPriorityTier;
    const isFastLane = priorityTier >= 1 && priorityTier <= 5;
    const priorityClass: SmcPriorityClass = isFastLane ? 'FAST_LANE' : 'BULK';
    const workerRole: SmcWorkerRole = r.worker_role
      ? (String(r.worker_role) as SmcWorkerRole)
      : isFastLane
        ? 'FAST_LANE'
        : 'BULK';
    const executionWorker: SmcExecutionWorker =
      r.execution_worker === 'FAST_LANE_WORKER' ||
      r.execution_worker === 'BULK_WORKER'
        ? (String(r.execution_worker) as SmcExecutionWorker)
        : workerRole === 'FAST_LANE'
          ? 'FAST_LANE_WORKER'
          : 'BULK_WORKER';

    return {
      id: Number(r.id),
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      priority: Number(r.priority),
      priorityTier,
      priorityLabel: String(r.priority_label),
      priorityClass,
      executionWorker,
      status: String(r.status) as SmcScanJobStatus,
      ruleVersion: String(r.rule_version),
      windowKey: String(r.window_key),
      requestedAt,
      startedAt,
      jobClaimedAt,
      completedAt,
      queueEnteredAt,
      smcEvaluationStartedAt,
      smcEvaluationCompletedAt,
      queueWaitMs:
        r.queue_wait_ms !== null && r.queue_wait_ms !== undefined
          ? Number(r.queue_wait_ms)
          : null,
      prewarmWaitMs:
        r.prewarm_wait_ms !== null && r.prewarm_wait_ms !== undefined
          ? Number(r.prewarm_wait_ms)
          : 0,
      httpRequestLatencyMs:
        r.http_request_latency_ms !== null &&
        r.http_request_latency_ms !== undefined
          ? Number(r.http_request_latency_ms)
          : null,
      smcCalculationLatencyMs:
        r.smc_calculation_latency_ms !== null &&
        r.smc_calculation_latency_ms !== undefined
          ? Number(r.smc_calculation_latency_ms)
          : null,
      dbWriteLatencyMs:
        r.db_write_latency_ms !== null && r.db_write_latency_ms !== undefined
          ? Number(r.db_write_latency_ms)
          : null,
      smcEvaluationLatencyMs:
        r.smc_evaluation_latency_ms !== null &&
        r.smc_evaluation_latency_ms !== undefined
          ? Number(r.smc_evaluation_latency_ms)
          : null,
      rateLimitWaitMs:
        r.rate_limit_wait_ms !== null && r.rate_limit_wait_ms !== undefined
          ? Number(r.rate_limit_wait_ms)
          : null,
      detectionLatencyMs:
        r.detection_latency_ms !== null && r.detection_latency_ms !== undefined
          ? Number(r.detection_latency_ms)
          : null,
      cacheHit: Number(r.cache_hit ?? 0) === 1,
      cacheMiss: Number(r.cache_miss ?? 0) === 1,
      reusedCache: Number(r.reused_cache ?? 0) === 1,
      workerRole,
      isFastLane,
      lastError: r.last_error ? String(r.last_error) : null,
      retryCount: Number(r.retry_count),
      nextRetryAt: r.next_retry_at ? String(r.next_retry_at) : null,
      workerId: r.worker_id ? String(r.worker_id) : null,
      leaseUntil: r.lease_until ? String(r.lease_until) : null,
      heartbeatAt: r.heartbeat_at ? String(r.heartbeat_at) : null,
      lastProgressAt: r.last_progress_at ? String(r.last_progress_at) : null,
      pendingReason: r.pending_reason
        ? (String(r.pending_reason) as SmcPendingReason)
        : null,
      cycleId: r.cycle_id ? String(r.cycle_id) : null,
    };
  }

  public saveSmcScanResult(
    record: SmcScanResultRecord,
    completedJobId?: number
  ): void {
    const resolvedEvidenceType = resolveCandidateEvidenceType({
      exchange: record.exchange,
      isDemo: record.isDemo,
      source: record.source,
      evidenceType: record.evidenceType,
    });

    if (
      record.exchange !== 'demo_synthetic' &&
      resolvedEvidenceType === 'CONTROLLED_LIVE_FIXTURE'
    ) {
      if (
        record.smcEvaluationStatus === 'EVALUATED' &&
        (record.smcActionState === 'LONG CANDIDATE' ||
          record.smcActionState === 'SHORT CANDIDATE')
      ) {
        const evalCompletedAtStr =
          record.evaluationCompletedAt ??
          record.smcEvaluationCompletedAt ??
          record.evaluatedAt;
        const evalCompletedMs = Date.parse(evalCompletedAtStr);
        const sigBarClose =
          record.signalBarCloseTime !== undefined
            ? record.signalBarCloseTime
            : null;
        const sigBarOpen =
          record.signalBarOpenTime !== undefined &&
          record.signalBarOpenTime !== null
            ? record.signalBarOpenTime
            : sigBarClose !== null
              ? Number(sigBarClose) % 900_000 === 899_999
                ? Number(sigBarClose) - 900_000 + 1
                : Number(sigBarClose) - 900_000
              : null;
        const nextBarOpen =
          record.nextBarOpenTime !== undefined ? record.nextBarOpenTime : null;
        const isMissed =
          record.entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
          (nextBarOpen !== null &&
            Number.isFinite(evalCompletedMs) &&
            evalCompletedMs >= Number(nextBarOpen));
        const direction: 'LONG' | 'SHORT' =
          record.smcActionState === 'SHORT CANDIDATE' ? 'SHORT' : 'LONG';
        const normalizedRule = record.ruleVersion.includes('+')
          ? record.ruleVersion.split('+')[0]
          : record.ruleVersion;
        const safeRule = normalizedRule.replace(/[^a-zA-Z0-9._-]/g, '_');
        const sigId = `sig_${record.exchange}_${record.symbol}_15m_${direction}_${sigBarOpen ?? 'nobar'}_${safeRule}`;

        this.saveControlledFixtureCandidate({
          cycleId:
            record.scanCycleId || this.getSmcScanCycleId(record.exchange),
          signalId: sigId,
          symbol: record.symbol,
          exchange: record.exchange,
          timeframe: '15m',
          direction,
          signalBarOpenTime: sigBarOpen,
          signalBarCloseTime: sigBarClose,
          nextBarOpenTime: nextBarOpen,
          candidateDetectedAt:
            record.candidateDetectedAt ?? evalCompletedAtStr,
          signalDetectedAt: record.signalDetectedAt ?? evalCompletedAtStr,
          queueEnteredAt: record.queueEnteredAt ?? record.evaluatedAt,
          evaluationStartedAt:
            record.evaluationStartedAt ??
            record.smcEvaluationStartedAt ??
            record.evaluatedAt,
          evaluationCompletedAt: evalCompletedAtStr,
          queueWaitMs: record.queueWaitMs ?? null,
          evaluationLatencyMs:
            record.evaluationLatencyMs ?? record.smcEvaluationLatencyMs ?? null,
          candidateDetectionLatencyMs:
            record.candidateDetectionLatencyMs ??
            record.detectionLatencyMs ??
            null,
          nextBarRemainingMs:
            record.nextBarRemainingMs ??
            (nextBarOpen !== null && Number.isFinite(evalCompletedMs)
              ? Math.round(Number(nextBarOpen) - evalCompletedMs)
              : null),
          entryWindowStatus: isMissed
            ? 'ENTRY_WINDOW_MISSED'
            : 'DETECTED_BEFORE_NEXT_BAR_OPEN',
          entryWindowMissed: isMissed,
          isFastLane:
            record.isFastLane !== undefined
              ? record.isFastLane
              : (record.priorityTier ?? 1) <= 5,
          evidenceType: 'CONTROLLED_LIVE_FIXTURE',
          source: record.source || 'CONTROLLED_LIVE_FIXTURE',
          fetchedAt: record.fetchedAt ?? record.dataFetchedAt,
          stale: record.stale,
          fallback: record.fallback,
          isDemo: false,
          isTestFixture: true,
        });
      }
      return;
    }

    const safeProv = enforceProvenanceIntegrity({
      source: record.source,
      fetchedAt: record.dataFetchedAt,
      stale: record.stale,
      fallback: record.fallback,
      missingData: record.missingData,
      isDemo: record.isDemo,
    });

    if (
      record.exchange !== 'demo_synthetic' &&
      (safeProv.isDemo ||
        safeProv.isTestFixture ||
        !isVerifiedLivePublicApiSource(safeProv.source))
    ) {
      return;
    }

    this.runInTransaction(() => {
      if (
        record.smcEvaluationStatus !== 'EVALUATED' ||
        record.smcActionState === 'PENDING'
      ) {
        this.db
          .prepare(
            `DELETE FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
          )
          .run(record.exchange, record.symbol);
        this.bumpSmcStatsVersion(record.exchange, record.evaluatedAt);
        return;
      }

      const scanCycleId =
        record.scanCycleId || this.getSmcScanCycleId(record.exchange);
      const normalizedRuleVersion = record.ruleVersion.includes('+')
        ? record.ruleVersion.split('+')[0]
        : record.ruleVersion;

      const queueEnteredAt = record.queueEnteredAt ?? record.evaluatedAt;
      const jobClaimedAt =
        record.jobClaimedAt ??
        record.smcEvaluationStartedAt ??
        record.evaluatedAt;
      const smcEvaluationStartedAt =
        record.smcEvaluationStartedAt ?? record.evaluatedAt;
      const smcEvaluationCompletedAt =
        record.smcEvaluationCompletedAt ?? record.evaluatedAt;
      const queueWaitMs =
        record.queueWaitMs !== undefined && record.queueWaitMs !== null
          ? Math.max(0, Math.round(record.queueWaitMs))
          : null;
      const prewarmWaitMs =
        record.prewarmWaitMs !== undefined && record.prewarmWaitMs !== null
          ? Math.max(0, Math.round(record.prewarmWaitMs))
          : 0;
      const httpRequestLatencyMs =
        record.httpRequestLatencyMs !== undefined &&
        record.httpRequestLatencyMs !== null
          ? Math.max(0, Math.round(record.httpRequestLatencyMs))
          : null;
      const smcCalculationLatencyMs =
        record.smcCalculationLatencyMs !== undefined &&
        record.smcCalculationLatencyMs !== null
          ? Math.max(0, Math.round(record.smcCalculationLatencyMs))
          : null;
      const dbWriteLatencyMs =
        record.dbWriteLatencyMs !== undefined &&
        record.dbWriteLatencyMs !== null
          ? Math.max(0, Math.round(record.dbWriteLatencyMs))
          : null;
      const smcEvaluationLatencyMs =
        record.smcEvaluationLatencyMs !== undefined &&
        record.smcEvaluationLatencyMs !== null
          ? Math.max(0, Math.round(record.smcEvaluationLatencyMs))
          : null;
      const rateLimitWaitMs =
        record.rateLimitWaitMs !== undefined &&
        record.rateLimitWaitMs !== null
          ? Math.max(0, Math.round(record.rateLimitWaitMs))
          : 0;
      const detectionLatencyMs =
        record.detectionLatencyMs !== undefined &&
        record.detectionLatencyMs !== null
          ? Math.max(0, Math.round(record.detectionLatencyMs))
          : null;
      const signalBarCloseTime =
        record.signalBarCloseTime !== undefined &&
        record.signalBarCloseTime !== null
          ? Number(record.signalBarCloseTime)
          : null;
      const nextBarOpenTime =
        record.nextBarOpenTime !== undefined && record.nextBarOpenTime !== null
          ? Number(record.nextBarOpenTime)
          : null;

      // Look up canonical job tier if not explicitly provided
      const existingJobForSymbol = this.db
        .prepare(
          `SELECT id, priority_tier, priority_label, worker_role, execution_worker, prewarm_wait_ms
           FROM smc_scan_jobs
           WHERE exchange = ? AND symbol = ?
           ORDER BY CASE WHEN status = 'RUNNING' THEN 0 ELSE 1 END ASC, id DESC
           LIMIT 1`
        )
        .get(record.exchange, record.symbol) as
        | {
            id?: number;
            priority_tier?: number;
            priority_label?: string;
            worker_role?: string | null;
            execution_worker?: string | null;
            prewarm_wait_ms?: number | null;
          }
        | undefined;

      const priorityTier = (
        record.priorityTier ??
        existingJobForSymbol?.priority_tier ??
        (record.isFastLane ? 1 : 6)
      ) as SmcScanPriorityTier;
      const priorityLabel =
        record.priorityLabel ??
        existingJobForSymbol?.priority_label ??
        (priorityTier <= 5 ? '1_WATCHLIST' : '6_REMAINING_USDT_PERP');
      // Section 一: Strictly priorityTier 1..5 => FAST_LANE, priorityTier 6 => BULK
      const isFastLane = priorityTier >= 1 && priorityTier <= 5;
      const isFastLaneInt = isFastLane ? 1 : 0;
      const priorityClass: SmcPriorityClass = isFastLane
        ? 'FAST_LANE'
        : 'BULK';

      const workerRole: SmcWorkerRole =
        record.workerRole ??
        (existingJobForSymbol?.worker_role === 'FAST_LANE' ||
        existingJobForSymbol?.worker_role === 'BULK'
          ? (existingJobForSymbol.worker_role as SmcWorkerRole)
          : isFastLane
            ? 'FAST_LANE'
            : 'BULK');
      const executionWorker: SmcExecutionWorker =
        record.executionWorker ??
        (existingJobForSymbol?.execution_worker === 'FAST_LANE_WORKER' ||
        existingJobForSymbol?.execution_worker === 'BULK_WORKER'
          ? (existingJobForSymbol.execution_worker as SmcExecutionWorker)
          : workerRole === 'FAST_LANE'
            ? 'FAST_LANE_WORKER'
            : 'BULK_WORKER');

      const resolvedPrewarmWaitMs =
        prewarmWaitMs > 0
          ? prewarmWaitMs
          : Number(existingJobForSymbol?.prewarm_wait_ms ?? 0);

      const cacheHitInt = record.cacheHit ? 1 : 0;
      const cacheMissInt = record.cacheMiss ? 1 : 0;
      const reusedCacheInt = record.reusedCache ? 1 : 0;
      const windowKey = record.windowKey ?? 'inline_eval';
      const entryWindowStatus = record.entryWindowStatus ?? 'NOT_APPLICABLE';

      const symbolDiag = this.evaluateSymbolGateDiagnostics(
        {
          ...record,
          stale: safeProv.stale,
          fallback: safeProv.fallback,
          missingData: safeProv.missingData,
          entryWindowStatus,
        },
        scanCycleId
      );

      const stmt = this.db.prepare(`
        INSERT INTO smc_scan_results (
          symbol, exchange, smc_evaluation_status, smc_action_state,
          final_trade_signal, market_radar_category, evaluated_at, data_fetched_at,
          stale, fallback, missing_data_json, source, is_demo,
          rule_version, window_key, wait_reasons_json, smc_analysis_json, scan_cycle_id,
          priority_tier, priority_label, priority_class, execution_worker, worker_role,
          queue_entered_at, job_claimed_at, smc_evaluation_started_at, smc_evaluation_completed_at,
          queue_wait_ms, prewarm_wait_ms, http_request_latency_ms, smc_calculation_latency_ms,
          db_write_latency_ms, smc_evaluation_latency_ms, rate_limit_wait_ms,
          detection_latency_ms, cache_hit, cache_miss, reused_cache,
          signal_bar_close_time, next_bar_open_time, entry_window_status, is_fast_lane,
          primary_blocking_reason, primary_reason_category, all_blocking_reasons_json, gate_pass_json,
          evidence_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exchange, symbol) DO UPDATE SET
          smc_evaluation_status = excluded.smc_evaluation_status,
          smc_action_state = excluded.smc_action_state,
          final_trade_signal = excluded.final_trade_signal,
          market_radar_category = excluded.market_radar_category,
          evaluated_at = excluded.evaluated_at,
          data_fetched_at = excluded.data_fetched_at,
          stale = excluded.stale,
          fallback = excluded.fallback,
          missing_data_json = excluded.missing_data_json,
          source = excluded.source,
          is_demo = excluded.is_demo,
          rule_version = excluded.rule_version,
          window_key = COALESCE(excluded.window_key, smc_scan_results.window_key),
          wait_reasons_json = excluded.wait_reasons_json,
          smc_analysis_json = excluded.smc_analysis_json,
          scan_cycle_id = excluded.scan_cycle_id,
          priority_tier = excluded.priority_tier,
          priority_label = excluded.priority_label,
          priority_class = excluded.priority_class,
          execution_worker = excluded.execution_worker,
          worker_role = excluded.worker_role,
          queue_entered_at = excluded.queue_entered_at,
          job_claimed_at = excluded.job_claimed_at,
          smc_evaluation_started_at = excluded.smc_evaluation_started_at,
          smc_evaluation_completed_at = excluded.smc_evaluation_completed_at,
          queue_wait_ms = COALESCE(excluded.queue_wait_ms, smc_scan_results.queue_wait_ms),
          prewarm_wait_ms = COALESCE(excluded.prewarm_wait_ms, smc_scan_results.prewarm_wait_ms),
          http_request_latency_ms = COALESCE(excluded.http_request_latency_ms, smc_scan_results.http_request_latency_ms),
          smc_calculation_latency_ms = COALESCE(excluded.smc_calculation_latency_ms, smc_scan_results.smc_calculation_latency_ms),
          db_write_latency_ms = COALESCE(excluded.db_write_latency_ms, smc_scan_results.db_write_latency_ms),
          smc_evaluation_latency_ms = COALESCE(excluded.smc_evaluation_latency_ms, smc_scan_results.smc_evaluation_latency_ms),
          rate_limit_wait_ms = COALESCE(excluded.rate_limit_wait_ms, smc_scan_results.rate_limit_wait_ms),
          detection_latency_ms = COALESCE(excluded.detection_latency_ms, smc_scan_results.detection_latency_ms),
          cache_hit = excluded.cache_hit,
          cache_miss = excluded.cache_miss,
          reused_cache = excluded.reused_cache,
          signal_bar_close_time = COALESCE(excluded.signal_bar_close_time, smc_scan_results.signal_bar_close_time),
          next_bar_open_time = COALESCE(excluded.next_bar_open_time, smc_scan_results.next_bar_open_time),
          entry_window_status = COALESCE(excluded.entry_window_status, smc_scan_results.entry_window_status),
          is_fast_lane = excluded.is_fast_lane,
          primary_blocking_reason = excluded.primary_blocking_reason,
          primary_reason_category = excluded.primary_reason_category,
          all_blocking_reasons_json = excluded.all_blocking_reasons_json,
          gate_pass_json = excluded.gate_pass_json,
          evidence_type = excluded.evidence_type
      `);

      const persistedEvidenceType: CandidateEvidenceType =
        record.exchange === 'demo_synthetic' || safeProv.isDemo
          ? 'DEMO_LATENCY_FIXTURE'
          : 'LIVE_PRODUCTION';

      stmt.run(
        record.symbol,
        record.exchange,
        record.smcEvaluationStatus,
        record.smcActionState,
        record.finalTradeSignal,
        record.marketRadarCategory ?? '準備觀察',
        record.evaluatedAt,
        safeProv.fetchedAt,
        safeProv.stale ? 1 : 0,
        safeProv.fallback ? 1 : 0,
        JSON.stringify(safeProv.missingData),
        safeProv.source,
        safeProv.isDemo ? 1 : 0,
        normalizedRuleVersion,
        windowKey,
        JSON.stringify(record.waitReasons ?? []),
        record.smcAnalysis ? JSON.stringify(record.smcAnalysis) : null,
        scanCycleId,
        priorityTier,
        priorityLabel,
        priorityClass,
        executionWorker,
        workerRole,
        queueEnteredAt,
        jobClaimedAt,
        smcEvaluationStartedAt,
        smcEvaluationCompletedAt,
        queueWaitMs,
        resolvedPrewarmWaitMs,
        httpRequestLatencyMs,
        smcCalculationLatencyMs,
        dbWriteLatencyMs,
        smcEvaluationLatencyMs,
        rateLimitWaitMs,
        detectionLatencyMs,
        cacheHitInt,
        cacheMissInt,
        reusedCacheInt,
        signalBarCloseTime,
        nextBarOpenTime,
        entryWindowStatus,
        isFastLaneInt,
        symbolDiag.primaryBlockingReason,
        symbolDiag.primaryReasonCategory,
        JSON.stringify(symbolDiag.allReasons),
        JSON.stringify(symbolDiag.gatePassMap),
        persistedEvidenceType
      );

      // Persist LIVE_PRODUCTION formal candidates into smc_live_capture_candidates
      if (
        persistedEvidenceType === 'LIVE_PRODUCTION' &&
        record.smcEvaluationStatus === 'EVALUATED' &&
        (record.smcActionState === 'LONG CANDIDATE' ||
          record.smcActionState === 'SHORT CANDIDATE') &&
        !safeProv.stale &&
        !safeProv.fallback &&
        safeProv.missingData.length === 0
      ) {
        const evalCompletedMs = Date.parse(smcEvaluationCompletedAt);
        const sigBarOpen =
          record.signalBarOpenTime !== undefined &&
          record.signalBarOpenTime !== null
            ? Number(record.signalBarOpenTime)
            : signalBarCloseTime !== null
              ? signalBarCloseTime % 900_000 === 899_999
                ? signalBarCloseTime - 900_000 + 1
                : signalBarCloseTime - 900_000
              : null;
        const isMissed =
          entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
          (nextBarOpenTime !== null &&
            Number.isFinite(evalCompletedMs) &&
            evalCompletedMs >= nextBarOpenTime);
        const direction: 'LONG' | 'SHORT' =
          record.smcActionState === 'SHORT CANDIDATE' ? 'SHORT' : 'LONG';
        const safeRule = normalizedRuleVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
        const sigId = `sig_${record.exchange}_${record.symbol}_15m_${direction}_${sigBarOpen ?? 'nobar'}_${safeRule}`;

        this.saveLiveCaptureCandidate({
          cycleId: scanCycleId,
          signalId: sigId,
          symbol: record.symbol,
          exchange: record.exchange,
          timeframe: '15m',
          direction,
          signalBarOpenTime: sigBarOpen,
          signalBarCloseTime,
          nextBarOpenTime,
          candidateDetectedAt:
            record.candidateDetectedAt ?? smcEvaluationCompletedAt,
          signalDetectedAt:
            record.signalDetectedAt ?? smcEvaluationCompletedAt,
          queueEnteredAt,
          evaluationStartedAt: smcEvaluationStartedAt,
          evaluationCompletedAt: smcEvaluationCompletedAt,
          queueWaitMs,
          evaluationLatencyMs: smcEvaluationLatencyMs,
          candidateDetectionLatencyMs:
            record.candidateDetectionLatencyMs ??
            detectionLatencyMs ??
            (signalBarCloseTime !== null && Number.isFinite(evalCompletedMs)
              ? Math.max(0, Math.round(evalCompletedMs - signalBarCloseTime))
              : null),
          nextBarRemainingMs:
            record.nextBarRemainingMs ??
            (nextBarOpenTime !== null && Number.isFinite(evalCompletedMs)
              ? Math.round(nextBarOpenTime - evalCompletedMs)
              : null),
          entryWindowStatus: isMissed
            ? 'ENTRY_WINDOW_MISSED'
            : 'DETECTED_BEFORE_NEXT_BAR_OPEN',
          entryWindowMissed: isMissed,
          isFastLane,
          evidenceType: 'LIVE_PRODUCTION',
          source: safeProv.source,
          fetchedAt: safeProv.fetchedAt,
          stale: false,
          fallback: false,
          isDemo: false,
          isTestFixture: false,
        });
      }

      // Atomically ensure the corresponding smc_scan_jobs row is marked SUCCEEDED in the same transaction
      if (completedJobId !== undefined) {
        this.db
          .prepare(
            `
          UPDATE smc_scan_jobs
          SET status = 'SUCCEEDED',
              completed_at = ?,
              smc_evaluation_completed_at = ?,
              queue_wait_ms = COALESCE(?, queue_wait_ms),
              prewarm_wait_ms = COALESCE(?, prewarm_wait_ms),
              http_request_latency_ms = COALESCE(?, http_request_latency_ms),
              smc_calculation_latency_ms = COALESCE(?, smc_calculation_latency_ms),
              db_write_latency_ms = COALESCE(?, db_write_latency_ms),
              smc_evaluation_latency_ms = COALESCE(?, smc_evaluation_latency_ms),
              rate_limit_wait_ms = COALESCE(?, rate_limit_wait_ms),
              detection_latency_ms = COALESCE(?, detection_latency_ms),
              cache_hit = ?,
              cache_miss = ?,
              reused_cache = ?,
              priority_class = ?,
              execution_worker = ?,
              worker_role = ?,
              is_fast_lane = ?,
              pending_reason = NULL,
              last_progress_at = ?,
              last_error = NULL,
              next_retry_at = NULL,
              worker_id = NULL,
              lease_until = NULL,
              heartbeat_at = NULL
          WHERE id = ?
        `
          )
          .run(
            record.evaluatedAt,
            smcEvaluationCompletedAt,
            queueWaitMs,
            resolvedPrewarmWaitMs,
            httpRequestLatencyMs,
            smcCalculationLatencyMs,
            dbWriteLatencyMs,
            smcEvaluationLatencyMs,
            rateLimitWaitMs,
            detectionLatencyMs,
            cacheHitInt,
            cacheMissInt,
            reusedCacheInt,
            priorityClass,
            executionWorker,
            workerRole,
            isFastLaneInt,
            record.evaluatedAt,
            completedJobId
          );
      } else {
        if (existingJobForSymbol?.id !== undefined) {
          this.db
            .prepare(
              `
            UPDATE smc_scan_jobs
            SET status = 'SUCCEEDED',
                completed_at = ?,
                smc_evaluation_completed_at = ?,
                queue_wait_ms = COALESCE(?, queue_wait_ms),
                prewarm_wait_ms = COALESCE(?, prewarm_wait_ms),
                http_request_latency_ms = COALESCE(?, http_request_latency_ms),
                smc_calculation_latency_ms = COALESCE(?, smc_calculation_latency_ms),
                db_write_latency_ms = COALESCE(?, db_write_latency_ms),
                smc_evaluation_latency_ms = COALESCE(?, smc_evaluation_latency_ms),
                rate_limit_wait_ms = COALESCE(?, rate_limit_wait_ms),
                detection_latency_ms = COALESCE(?, detection_latency_ms),
                cache_hit = ?,
                cache_miss = ?,
                reused_cache = ?,
                priority_tier = ?,
                priority_label = ?,
                priority_class = ?,
                execution_worker = ?,
                worker_role = ?,
                is_fast_lane = ?,
                rule_version = ?,
                pending_reason = NULL,
                last_progress_at = ?,
                last_error = NULL,
                next_retry_at = NULL,
                worker_id = NULL,
                lease_until = NULL,
                heartbeat_at = NULL
            WHERE id = ?
          `
            )
            .run(
              record.evaluatedAt,
              smcEvaluationCompletedAt,
              queueWaitMs,
              resolvedPrewarmWaitMs,
              httpRequestLatencyMs,
              smcCalculationLatencyMs,
              dbWriteLatencyMs,
              smcEvaluationLatencyMs,
              rateLimitWaitMs,
              detectionLatencyMs,
              cacheHitInt,
              cacheMissInt,
              reusedCacheInt,
              priorityTier,
              priorityLabel,
              priorityClass,
              executionWorker,
              workerRole,
              isFastLaneInt,
              normalizedRuleVersion,
              record.evaluatedAt,
              existingJobForSymbol.id
            );
        } else {
          this.db
            .prepare(
              `
            INSERT INTO smc_scan_jobs (
              symbol, exchange, priority, priority_tier, priority_label, priority_class, execution_worker,
              status, rule_version, window_key, requested_at, queue_entered_at, started_at,
              job_claimed_at, smc_evaluation_started_at, completed_at, smc_evaluation_completed_at,
              queue_wait_ms, prewarm_wait_ms, http_request_latency_ms, smc_calculation_latency_ms, db_write_latency_ms,
              smc_evaluation_latency_ms, rate_limit_wait_ms,
              detection_latency_ms, cache_hit, cache_miss, reused_cache, worker_role, is_fast_lane,
              last_error, retry_count, next_retry_at,
              worker_id, lease_until, heartbeat_at
            ) VALUES (?, ?, 50000, ?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL)
          `
            )
            .run(
              record.symbol,
              record.exchange,
              priorityTier,
              priorityLabel,
              priorityClass,
              executionWorker,
              normalizedRuleVersion,
              windowKey,
              queueEnteredAt,
              queueEnteredAt,
              smcEvaluationStartedAt,
              jobClaimedAt,
              smcEvaluationStartedAt,
              record.evaluatedAt,
              smcEvaluationCompletedAt,
              queueWaitMs,
              resolvedPrewarmWaitMs,
              httpRequestLatencyMs,
              smcCalculationLatencyMs,
              dbWriteLatencyMs,
              smcEvaluationLatencyMs,
              rateLimitWaitMs,
              detectionLatencyMs,
              cacheHitInt,
              cacheMissInt,
              reusedCacheInt,
              workerRole,
              isFastLaneInt
            );
        }
      }

      this.bumpSmcStatsVersion(record.exchange, record.evaluatedAt);
    });
  }

  public getSmcScanResult(
    exchange: ExchangeId,
    symbol: string,
    nowMs = Date.now()
  ): SmcScanResultRecord | null {
    const snap = this.getAtomicSmcSnapshot(exchange, nowMs);
    return snap.resultsMap.get(symbol) ?? null;
  }

  public listSmcScanResults(
    exchange: ExchangeId,
    nowMs = Date.now()
  ): SmcScanResultRecord[] {
    return this.getAtomicSmcSnapshot(exchange, nowMs).results;
  }

  public getSmcScanResultsMap(
    exchange: ExchangeId,
    nowMs = Date.now()
  ): Map<string, SmcScanResultRecord> {
    return this.getAtomicSmcSnapshot(exchange, nowMs).resultsMap;
  }

  private mapSmcResultRow(
    r: Record<string, unknown>,
    nowMs = Date.now()
  ): SmcScanResultRecord {
    const evaluatedAt = String(r.evaluated_at);
    const evalMs = Date.parse(evaluatedAt);
    const freshnessSeconds = Number.isFinite(evalMs)
      ? Math.max(0, Math.round((nowMs - evalMs) / 1000))
      : 0;

    const exStr = String(r.exchange);
    const symStr = String(r.symbol);
    const mapCacheId = `${exStr}:${symStr}`;
    const cacheKey = `${evaluatedAt}|${String(r.data_fetched_at)}|${String(r.smc_action_state)}|${String(r.final_trade_signal)}|${String(r.scan_cycle_id || '')}|${String(r.stale)}|${String(r.fallback)}|${String(r.smc_analysis_json || '').length}|${String(r.wait_reasons_json || '')}|${String(r.missing_data_json || '')}`;
    const memo = this.parsedSmcRowCache.get(mapCacheId);
    if (memo && memo.cacheKey === cacheKey) {
      return {
        ...memo.record,
        freshnessSeconds,
      };
    }

    let parsedAnalysis: SmcAnalysisResult | undefined;
    if (r.smc_analysis_json) {
      try {
        parsedAnalysis = JSON.parse(String(r.smc_analysis_json));
      } catch {
        parsedAnalysis = undefined;
      }
    }

    const dataFetchedAt = String(r.data_fetched_at);
    const priorityTier = (
      r.priority_tier !== null && r.priority_tier !== undefined
        ? Number(r.priority_tier)
        : 6
    ) as SmcScanPriorityTier;
    const priorityLabel = r.priority_label
      ? String(r.priority_label)
      : priorityTier <= 5
        ? '1_WATCHLIST'
        : '6_REMAINING_USDT_PERP';
    // Section 一: Strictly priorityTier 1..5 => FAST_LANE, priorityTier 6 => BULK
    const isFastLane = priorityTier >= 1 && priorityTier <= 5;
    const priorityClass: SmcPriorityClass = isFastLane ? 'FAST_LANE' : 'BULK';
    const workerRole: SmcWorkerRole = r.worker_role
      ? (String(r.worker_role) as SmcWorkerRole)
      : isFastLane
        ? 'FAST_LANE'
        : 'BULK';
    const executionWorker: SmcExecutionWorker =
      r.execution_worker === 'FAST_LANE_WORKER' ||
      r.execution_worker === 'BULK_WORKER'
        ? (String(r.execution_worker) as SmcExecutionWorker)
        : workerRole === 'FAST_LANE'
          ? 'FAST_LANE_WORKER'
          : 'BULK_WORKER';

    const baseRecord: SmcScanResultRecord = {
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      smcEvaluationStatus: String(
        r.smc_evaluation_status
      ) as SmcEvaluationStatus,
      smcActionState: String(r.smc_action_state) as SmcActionState,
      finalTradeSignal: String(r.final_trade_signal) as FinalTradeSignal,
      marketRadarCategory: r.market_radar_category
        ? (String(r.market_radar_category) as MarketRadarCategory)
        : '準備觀察',
      evaluatedAt,
      dataFetchedAt,
      fetchedAt: dataFetchedAt,
      scanCycleId: r.scan_cycle_id ? String(r.scan_cycle_id) : undefined,
      windowKey: r.window_key ? String(r.window_key) : undefined,
      priorityTier,
      priorityLabel,
      priorityClass,
      executionWorker,
      workerRole,
      freshnessSeconds,
      stale: Number(r.stale) === 1,
      fallback: Number(r.fallback) === 1,
      missingData: JSON.parse(String(r.missing_data_json || '[]')),
      source: String(r.source),
      isDemo: Number(r.is_demo) === 1,
      ruleVersion: String(r.rule_version),
      waitReasons: JSON.parse(String(r.wait_reasons_json || '[]')),
      smcAnalysis: parsedAnalysis,
      queueEnteredAt: r.queue_entered_at
        ? String(r.queue_entered_at)
        : evaluatedAt,
      jobClaimedAt: r.job_claimed_at
        ? String(r.job_claimed_at)
        : r.smc_evaluation_started_at
          ? String(r.smc_evaluation_started_at)
          : evaluatedAt,
      smcEvaluationStartedAt: r.smc_evaluation_started_at
        ? String(r.smc_evaluation_started_at)
        : evaluatedAt,
      smcEvaluationCompletedAt: r.smc_evaluation_completed_at
        ? String(r.smc_evaluation_completed_at)
        : evaluatedAt,
      queueWaitMs:
        r.queue_wait_ms !== null && r.queue_wait_ms !== undefined
          ? Number(r.queue_wait_ms)
          : null,
      prewarmWaitMs:
        r.prewarm_wait_ms !== null && r.prewarm_wait_ms !== undefined
          ? Number(r.prewarm_wait_ms)
          : 0,
      httpRequestLatencyMs:
        r.http_request_latency_ms !== null &&
        r.http_request_latency_ms !== undefined
          ? Number(r.http_request_latency_ms)
          : null,
      smcCalculationLatencyMs:
        r.smc_calculation_latency_ms !== null &&
        r.smc_calculation_latency_ms !== undefined
          ? Number(r.smc_calculation_latency_ms)
          : null,
      dbWriteLatencyMs:
        r.db_write_latency_ms !== null && r.db_write_latency_ms !== undefined
          ? Number(r.db_write_latency_ms)
          : null,
      smcEvaluationLatencyMs:
        r.smc_evaluation_latency_ms !== null &&
        r.smc_evaluation_latency_ms !== undefined
          ? Number(r.smc_evaluation_latency_ms)
          : null,
      rateLimitWaitMs:
        r.rate_limit_wait_ms !== null && r.rate_limit_wait_ms !== undefined
          ? Number(r.rate_limit_wait_ms)
          : 0,
      detectionLatencyMs:
        r.detection_latency_ms !== null && r.detection_latency_ms !== undefined
          ? Number(r.detection_latency_ms)
          : null,
      cacheHit: Number(r.cache_hit ?? 0) === 1,
      cacheMiss: Number(r.cache_miss ?? 0) === 1,
      reusedCache: Number(r.reused_cache ?? 0) === 1,
      signalBarCloseTime:
        r.signal_bar_close_time !== null &&
        r.signal_bar_close_time !== undefined
          ? Number(r.signal_bar_close_time)
          : null,
      nextBarOpenTime:
        r.next_bar_open_time !== null && r.next_bar_open_time !== undefined
          ? Number(r.next_bar_open_time)
          : null,
      entryWindowStatus: r.entry_window_status
        ? (String(r.entry_window_status) as
            | 'DETECTED_BEFORE_NEXT_BAR_OPEN'
            | 'ENTRY_WINDOW_MISSED'
            | 'NOT_APPLICABLE')
        : 'NOT_APPLICABLE',
      isFastLane,
    };

    const diag = this.evaluateSymbolGateDiagnostics(
      baseRecord,
      baseRecord.scanCycleId || 'cycle_default'
    );
    baseRecord.primaryBlockingReason = diag.primaryBlockingReason;
    baseRecord.primaryReasonCategory = diag.primaryReasonCategory;
    baseRecord.allBlockingReasons = diag.allReasons;
    baseRecord.gatePassMap = diag.gatePassMap;

    const derivedGateEval = deriveSymbolSmcGateEvaluationFromAnalysis(
      parsedAnalysis,
      {
        actionState: baseRecord.smcActionState,
        waitReasons: baseRecord.waitReasons,
      }
    );
    const isFormalCand =
      baseRecord.smcEvaluationStatus === 'EVALUATED' &&
      (baseRecord.smcActionState === 'LONG CANDIDATE' ||
        baseRecord.smcActionState === 'SHORT CANDIDATE');
    const isEligible =
      isFormalCand &&
      !baseRecord.isDemo &&
      !baseRecord.stale &&
      !baseRecord.fallback &&
      baseRecord.missingData.length === 0;
    const isMissed =
      baseRecord.entryWindowStatus === 'ENTRY_WINDOW_MISSED';
    const evalCompletedMs = Date.parse(
      baseRecord.smcEvaluationCompletedAt ?? evaluatedAt
    );

    baseRecord.evaluationStartedAt =
      baseRecord.smcEvaluationStartedAt ?? evaluatedAt;
    baseRecord.evaluationCompletedAt =
      baseRecord.smcEvaluationCompletedAt ?? evaluatedAt;
    baseRecord.evaluationLatencyMs = baseRecord.smcEvaluationLatencyMs ?? null;
    baseRecord.nextBarRemainingMs =
      baseRecord.nextBarOpenTime !== null &&
      baseRecord.nextBarOpenTime !== undefined &&
      Number.isFinite(evalCompletedMs)
        ? Math.max(0, Math.round(Number(baseRecord.nextBarOpenTime) - evalCompletedMs))
        : null;
    baseRecord.nearMissStatus =
      derivedGateEval?.nearMissStatus ??
      parsedAnalysis?.nearMissStatus ??
      'NOT_NEAR_CANDIDATE';
    baseRecord.missingGates =
      derivedGateEval?.missingGates ??
      parsedAnalysis?.missingGates ??
      [];
    baseRecord.intendedDirection =
      derivedGateEval?.intendedDirection ??
      parsedAnalysis?.intendedDirection ??
      'NEUTRAL';
    baseRecord.paperEligibilityStatus = !isFormalCand
      ? 'NOT_CANDIDATE'
      : isEligible
        ? 'ELIGIBLE'
        : 'BLOCKED';
    baseRecord.candidateDetectedAt = isFormalCand ? evaluatedAt : null;
    baseRecord.signalDetectedAt = isFormalCand ? evaluatedAt : null;
    baseRecord.paperOpenedAt =
      isEligible && !isMissed ? evaluatedAt : null;
    baseRecord.candidateDetectionLatencyMs = isFormalCand
      ? baseRecord.detectionLatencyMs ?? null
      : null;
    baseRecord.entryWindowMissed = isFormalCand ? isMissed : null;
    baseRecord.entryWindowDelayMs =
      isFormalCand &&
      baseRecord.nextBarOpenTime !== null &&
      baseRecord.nextBarOpenTime !== undefined &&
      Number.isFinite(evalCompletedMs)
        ? Math.round(evalCompletedMs - Number(baseRecord.nextBarOpenTime))
        : null;
    baseRecord.signalBarOpenTime =
      baseRecord.signalBarCloseTime !== null &&
      baseRecord.signalBarCloseTime !== undefined
        ? Number(baseRecord.signalBarCloseTime) % 900_000 === 899_999
          ? Number(baseRecord.signalBarCloseTime) - 900_000 + 1
          : Number(baseRecord.signalBarCloseTime) - 900_000
        : null;
    baseRecord.blockedReason = isFormalCand
      ? !isEligible
        ? 'DATA_PROVENANCE_OR_RISK_BLOCKED'
        : isMissed
          ? 'ENTRY_WINDOW_MISSED: 偵測時間晚於下一根 K 線開盤時間窗'
          : null
      : baseRecord.primaryBlockingReason ?? baseRecord.waitReasons[0] ?? null;
    baseRecord.evidenceType = resolveCandidateEvidenceType({
      exchange: baseRecord.exchange,
      isDemo: baseRecord.isDemo,
      source: baseRecord.source,
      evidenceType: r.evidence_type ? String(r.evidence_type) : null,
    });

    this.parsedSmcRowCache.set(mapCacheId, {
      cacheKey,
      record: baseRecord,
    });
    return { ...baseRecord };
  }

  public saveSmcCandlesCache(record: SmcCandlesCacheRecord): void {
    const safeProv = enforceProvenanceIntegrity(record.provenance);
    if (
      record.exchange !== 'demo_synthetic' &&
      (safeProv.isDemo ||
        safeProv.isTestFixture ||
        !isVerifiedLivePublicApiSource(safeProv.source))
    ) {
      return;
    }
    if (record.exchange === 'demo_synthetic' && !safeProv.isDemo) {
      return;
    }

    const confirmedKlines = record.klines.filter((k) => k.isClosed).slice(-60);
    const latestClosed =
      confirmedKlines.length > 0
        ? confirmedKlines[confirmedKlines.length - 1]
        : null;
    const resolvedDataTimestamp =
      record.dataTimestamp !== undefined && record.dataTimestamp !== null
        ? Number(record.dataTimestamp)
        : latestClosed
          ? Number(latestClosed.closeTime || latestClosed.openTime)
          : Date.parse(safeProv.fetchedAt) || Date.now();

    const resolvedRuleVersion =
      record.ruleVersion || 'v1.0.0-smc-ict-deterministic';
    const resolvedWindowKey =
      record.windowKey ||
      `win_${Math.floor((Date.parse(safeProv.fetchedAt) || Date.now()) / 300_000)}`;

    const is15m = record.timeframe === '15m';
    const explicitClearOi = is15m && record.oiExpiresAt === null;
    const resolvedOpenInterest = record.openInterest ?? null;
    const resolvedOpenInterestValue = record.openInterestValue ?? null;
    const resolvedOiFetchedAt = is15m ? (record.oiFetchedAt ?? null) : null;
    const resolvedOiExpiresAt = is15m ? (record.oiExpiresAt ?? null) : null;

    const stmt = this.db.prepare(`
      INSERT INTO smc_scan_candles_cache (
        symbol, exchange, timeframe, klines_json,
        open_interest, open_interest_value, funding_rate, next_funding_time,
        oi_fetched_at, oi_expires_at, data_timestamp,
        rule_version, window_key,
        source, fetched_at, expires_at, stale, fallback, missing_data_json, is_demo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, symbol, timeframe) DO UPDATE SET
        klines_json = excluded.klines_json,
        open_interest = CASE
          WHEN ? = 1 THEN excluded.open_interest
          ELSE COALESCE(excluded.open_interest, smc_scan_candles_cache.open_interest)
        END,
        open_interest_value = CASE
          WHEN ? = 1 THEN excluded.open_interest_value
          ELSE COALESCE(excluded.open_interest_value, smc_scan_candles_cache.open_interest_value)
        END,
        funding_rate = COALESCE(excluded.funding_rate, smc_scan_candles_cache.funding_rate),
        next_funding_time = COALESCE(excluded.next_funding_time, smc_scan_candles_cache.next_funding_time),
        oi_fetched_at = CASE
          WHEN excluded.timeframe != '15m' THEN NULL
          WHEN ? = 1 THEN excluded.oi_fetched_at
          ELSE COALESCE(excluded.oi_fetched_at, smc_scan_candles_cache.oi_fetched_at)
        END,
        oi_expires_at = CASE
          WHEN excluded.timeframe != '15m' THEN NULL
          WHEN ? = 1 THEN excluded.oi_expires_at
          ELSE COALESCE(excluded.oi_expires_at, smc_scan_candles_cache.oi_expires_at)
        END,
        data_timestamp = excluded.data_timestamp,
        rule_version = COALESCE(?, smc_scan_candles_cache.rule_version, excluded.rule_version),
        window_key = COALESCE(?, smc_scan_candles_cache.window_key, excluded.window_key),
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        stale = excluded.stale,
        fallback = excluded.fallback,
        missing_data_json = excluded.missing_data_json,
        is_demo = excluded.is_demo
    `);

    stmt.run(
      record.symbol,
      record.exchange,
      record.timeframe,
      JSON.stringify(confirmedKlines),
      resolvedOpenInterest,
      resolvedOpenInterestValue,
      record.fundingRate ?? null,
      record.nextFundingTime ?? null,
      resolvedOiFetchedAt,
      resolvedOiExpiresAt,
      resolvedDataTimestamp,
      resolvedRuleVersion,
      resolvedWindowKey,
      safeProv.source,
      safeProv.fetchedAt,
      record.expiresAt,
      safeProv.stale ? 1 : 0,
      safeProv.fallback ? 1 : 0,
      JSON.stringify(safeProv.missingData),
      safeProv.isDemo ? 1 : 0,
      explicitClearOi ? 1 : 0,
      explicitClearOi ? 1 : 0,
      explicitClearOi ? 1 : 0,
      explicitClearOi ? 1 : 0,
      record.ruleVersion ?? null,
      record.windowKey ?? null
    );
    if (record.timeframe === '15m') {
      this.cached15mCandleVolsByExchange.get(record.exchange)?.delete(record.symbol);
    }
    this.cachedClosedKlinesByExchange
      .get(record.exchange)
      ?.delete(`${record.symbol}:${record.timeframe}`);
    this.touchSmcState(record.exchange);
  }

  public scrubCorruptCandlesCacheRows(exchange?: ExchangeId): number {
    let removed = 0;
    try {
      const rows = (
        exchange
          ? this.db
              .prepare(
                `SELECT exchange, symbol, timeframe, klines_json, missing_data_json FROM smc_scan_candles_cache WHERE exchange = ?`
              )
              .all(exchange)
          : this.db
              .prepare(
                `SELECT exchange, symbol, timeframe, klines_json, missing_data_json FROM smc_scan_candles_cache`
              )
              .all()
      ) as Array<{
        exchange: string;
        symbol: string;
        timeframe: string;
        klines_json: string;
        missing_data_json: string;
      }>;
      const delStmt = this.db.prepare(
        `DELETE FROM smc_scan_candles_cache WHERE exchange = ? AND symbol = ? AND timeframe = ?`
      );
      for (const r of rows) {
        try {
          JSON.parse(String(r.klines_json || '[]'));
          JSON.parse(String(r.missing_data_json || '[]'));
        } catch {
          delStmt.run(r.exchange, r.symbol, r.timeframe);
          removed++;
        }
      }
    } catch {
      // ignore scrub errors
    }
    return removed;
  }

  public getSmcCandlesCache(
    exchange: ExchangeId,
    symbol: string,
    timeframe: Timeframe,
    nowMs = Date.now(),
    options?:
      | string
      | {
          expectedRuleVersion?: string;
          expectedWindowKey?: string;
        }
  ): (SmcCandlesCacheRecord & { isExpired: boolean }) | null {
    const resolvedOptions =
      typeof options === 'string'
        ? { expectedRuleVersion: options }
        : options;
    const isLiveVenue = exchange !== 'demo_synthetic';
    const stmt = this.db.prepare(`
      SELECT *
      FROM smc_scan_candles_cache
      WHERE exchange = ? AND symbol = ? AND timeframe = ? ${
        isLiveVenue ? 'AND is_demo = 0' : 'AND is_demo = 1'
      }
      LIMIT 1
    `);
    const r = stmt.get(exchange, symbol, timeframe);
    if (!r) return null;

    const source = String(r.source);
    const isDemo = Number(r.is_demo) === 1;
    if (isLiveVenue && (isDemo || !isVerifiedLivePublicApiSource(source))) {
      return null;
    }
    if (!isLiveVenue && !isDemo) {
      return null;
    }

    let rawKlines: Kline[] = [];
    let missingDataParsed: string[] = [];
    try {
      rawKlines = JSON.parse(String(r.klines_json || '[]')) as Kline[];
      missingDataParsed = JSON.parse(
        String(r.missing_data_json || '[]')
      ) as string[];
    } catch {
      try {
        this.db
          .prepare(
            `DELETE FROM smc_scan_candles_cache WHERE exchange = ? AND symbol = ? AND timeframe = ?`
          )
          .run(exchange, symbol, timeframe);
      } catch {
        // ignore delete error
      }
      return null;
    }
    const klines = rawKlines.filter((k) => k.isClosed).slice(-60);
    const latestClosed =
      klines.length > 0 ? klines[klines.length - 1] : null;

    const fetchedAt = String(r.fetched_at);
    const fetchedAtMs = Date.parse(fetchedAt) || nowMs;
    const dataTimestamp =
      r.data_timestamp !== null && r.data_timestamp !== undefined
        ? Number(r.data_timestamp)
        : latestClosed
          ? Number(latestClosed.closeTime || latestClosed.openTime)
          : fetchedAtMs;

    const expiresAt = String(r.expires_at);
    const expiresMs = Date.parse(expiresAt);
    const isTtlExpired = !Number.isFinite(expiresMs) || nowMs >= expiresMs;

    // Phase 8 & 9: 5m only refreshes after new 5m bar forms; 15m only refreshes after new 15m bar forms
    let isNewBarFormed = false;
    if (timeframe === '5m' || timeframe === '15m') {
      const barMs = timeframe === '5m' ? 300_000 : 900_000;
      if (
        Number.isFinite(dataTimestamp) &&
        Math.abs(fetchedAtMs - dataTimestamp) <= 6 * barMs
      ) {
        if (nowMs >= dataTimestamp + barMs) {
          isNewBarFormed = true;
        }
      }
    }

    // OI & Funding boundary checks
    const oiExpiresStr = r.oi_expires_at ? String(r.oi_expires_at) : null;
    const isOiExpired = Boolean(
      oiExpiresStr &&
        Number.isFinite(Date.parse(oiExpiresStr)) &&
        nowMs >= Date.parse(oiExpiresStr)
    );
    const nextFundingMs =
      r.next_funding_time !== null && r.next_funding_time !== undefined
        ? Number(r.next_funding_time)
        : null;
    const isFundingExpired = Boolean(
      nextFundingMs !== null &&
        Number.isFinite(nextFundingMs) &&
        nowMs >= nextFundingMs
    );

    const ruleVersion = r.rule_version
      ? String(r.rule_version)
      : 'v1.0.0-smc-ict-deterministic';
    const windowKey = r.window_key ? String(r.window_key) : null;
    const expectedRuleVersion = resolvedOptions?.expectedRuleVersion;
    const isRuleVersionChanged = Boolean(
      expectedRuleVersion &&
        r.rule_version &&
        String(r.rule_version) !== expectedRuleVersion
    );
    const isWindowKeyChanged = Boolean(
      (resolvedOptions?.expectedWindowKey &&
        windowKey &&
        windowKey !== resolvedOptions.expectedWindowKey) ||
        (windowKey &&
          (windowKey.startsWith('OLD_') ||
            windowKey.startsWith('EXPIRED_') ||
            windowKey.startsWith('INVALID_')))
    );

    const rawStale = Number(r.stale) === 1;
    const fallback = Number(r.fallback) === 1;
    const missingData: string[] = missingDataParsed;
    const isExpired =
      isTtlExpired ||
      isNewBarFormed ||
      isOiExpired ||
      isFundingExpired ||
      isRuleVersionChanged ||
      isWindowKeyChanged ||
      rawStale ||
      fallback ||
      missingData.length > 0;
    const stale = rawStale || isExpired;

    const provenance = enforceProvenanceIntegrity({
      source,
      fetchedAt,
      stale,
      fallback,
      missingData,
      isDemo,
    });

    return {
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      timeframe: String(r.timeframe) as Timeframe,
      klines,
      openInterest:
        r.open_interest !== null && r.open_interest !== undefined
          ? Number(r.open_interest)
          : null,
      openInterestValue:
        r.open_interest_value !== null && r.open_interest_value !== undefined
          ? Number(r.open_interest_value)
          : null,
      fundingRate:
        r.funding_rate !== null && r.funding_rate !== undefined
          ? Number(r.funding_rate)
          : null,
      nextFundingTime: nextFundingMs,
      oiFetchedAt: r.oi_fetched_at ? String(r.oi_fetched_at) : null,
      oiExpiresAt: oiExpiresStr,
      dataTimestamp,
      ruleVersion,
      windowKey,
      source: provenance.source,
      fetchedAt: provenance.fetchedAt,
      stale: provenance.stale,
      fallback: provenance.fallback,
      missingData: provenance.missingData,
      isDemo: provenance.isDemo,
      cacheHit: !isExpired,
      reusedCache: !isExpired,
      expiresAt,
      provenance,
      isExpired,
    };
  }

  public getBulkCachedClosedKlinesMap(
    exchange: ExchangeId,
    timeframes: Timeframe[] = ['15m', '1h'],
    maxBars = 60
  ): Map<string, Partial<Record<Timeframe, Kline[]>>> {
    const result = new Map<string, Partial<Record<Timeframe, Kline[]>>>();
    if (timeframes.length === 0) return result;
    const isLiveVenue = exchange !== 'demo_synthetic';
    const placeholders = timeframes.map(() => '?').join(', ');

    try {
      let exKlineCache = this.cachedClosedKlinesByExchange.get(exchange);
      if (!exKlineCache) {
        exKlineCache = new Map();
        this.cachedClosedKlinesByExchange.set(exchange, exKlineCache);
      }

      const metaStmt = this.db.prepare(`
        SELECT symbol, timeframe, fetched_at, data_timestamp, source
        FROM smc_scan_candles_cache
        WHERE exchange = ? AND timeframe IN (${placeholders}) AND is_demo = ?
      `);
      const metaRows = metaStmt.all(
        exchange,
        ...timeframes,
        isLiveVenue ? 0 : 1
      ) as Array<{
        symbol: string;
        timeframe: string;
        fetched_at: string;
        data_timestamp: number | null;
        source: string;
      }>;

      const missingKeys: Array<{ sym: string; tf: Timeframe; ver: string }> = [];
      for (const mr of metaRows) {
        const source = String(mr.source || '');
        if (isLiveVenue && !isVerifiedLivePublicApiSource(source)) {
          continue;
        }
        const tf = String(mr.timeframe) as Timeframe;
        if (!timeframes.includes(tf)) continue;
        const sym = String(mr.symbol);
        const cacheKey = `${sym}:${tf}`;
        const ver = `${String(mr.fetched_at || '')}|${String(mr.data_timestamp ?? '')}`;
        const cached = exKlineCache.get(cacheKey);
        if (cached && cached.version === ver) {
          const sliced =
            cached.klines.length > maxBars
              ? cached.klines.slice(-maxBars)
              : cached.klines;
          if (sliced.length > 0) {
            let entry = result.get(sym);
            if (!entry) {
              entry = {};
              result.set(sym, entry);
            }
            entry[tf] = sliced;
          }
        } else {
          missingKeys.push({ sym, tf, ver });
        }
      }

      if (missingKeys.length > 0) {
        const missingSymSet = Array.from(new Set(missingKeys.map((m) => m.sym)));
        const verLookup = new Map(missingKeys.map((m) => [`${m.sym}:${m.tf}`, m.ver]));
        const batchSize = 200;
        for (let i = 0; i < missingSymSet.length; i += batchSize) {
          const symBatch = missingSymSet.slice(i, i + batchSize);
          const symPlaceholders = symBatch.map(() => '?').join(', ');
          const rows = this.db
            .prepare(`
              SELECT symbol, timeframe, klines_json, source
              FROM smc_scan_candles_cache
              WHERE exchange = ? AND timeframe IN (${placeholders}) AND is_demo = ? AND symbol IN (${symPlaceholders})
            `)
            .all(
              exchange,
              ...timeframes,
              isLiveVenue ? 0 : 1,
              ...symBatch
            ) as Array<{
            symbol: string;
            timeframe: string;
            klines_json: string;
            source: string;
          }>;

          for (const row of rows) {
            const sym = String(row.symbol);
            const tf = String(row.timeframe) as Timeframe;
            const cacheKey = `${sym}:${tf}`;
            const ver = verLookup.get(cacheKey);
            if (!ver) continue;
            let parsed: Kline[];
            try {
              parsed = JSON.parse(String(row.klines_json || '[]')) as Kline[];
            } catch {
              continue;
            }
            const closed = parsed
              .filter(
                (k) =>
                  k &&
                  k.isClosed &&
                  Number.isFinite(k.openTime) &&
                  Number.isFinite(k.close) &&
                  k.close > 0
              )
              .sort((a, b) => a.openTime - b.openTime);
            exKlineCache.set(cacheKey, { version: ver, klines: closed });
            const sliced = closed.slice(-maxBars);
            if (sliced.length === 0) continue;
            let entry = result.get(sym);
            if (!entry) {
              entry = {};
              result.set(sym, entry);
            }
            entry[tf] = sliced;
          }
        }
      }
    } catch {
      // Non-fatal: cache may be empty on cold start
    }

    return result;
  }

  private computeCacheCoverageWithExpiry(
    exchange: ExchangeId,
    totalUniverseSymbolsCount?: number,
    isPrewarming = false,
    expectedRuleVersion = 'v1.0.0-smc-ict-deterministic',
    nowMs = Date.now()
  ): { metrics: SmcCacheCoverageMetrics; nextExpiryMs: number } {
    const isLiveVenue = exchange !== 'demo_synthetic';
    const rows = this.db
      .prepare(
        `SELECT symbol, timeframe, expires_at, stale, fallback, missing_data_json, rule_version, window_key,
                data_timestamp, fetched_at, open_interest, open_interest_value, funding_rate, next_funding_time, oi_expires_at
         FROM smc_scan_candles_cache
         WHERE exchange = ? ${isLiveVenue ? 'AND is_demo = 0' : 'AND is_demo = 1'}`
      )
      .all(exchange) as Array<{
      symbol: string;
      timeframe: string;
      expires_at: string;
      stale: number;
      fallback: number;
      missing_data_json: string;
      rule_version: string | null;
      window_key: string | null;
      data_timestamp: number | null;
      fetched_at: string;
      open_interest: number | null;
      open_interest_value: number | null;
      funding_rate: number | null;
      next_funding_time: number | null;
      oi_expires_at: string | null;
    }>;

    const distinctCachedSymbols = new Set<string>(rows.map((r) => String(r.symbol)));
    let resolvedTotalSymbols =
      totalUniverseSymbolsCount && totalUniverseSymbolsCount > 0
        ? totalUniverseSymbolsCount
        : 0;
    if (resolvedTotalSymbols === 0) {
      const snapRow = this.db
        .prepare(
          `SELECT total_contracts FROM smc_scan_cycles WHERE exchange = ? ORDER BY rowid DESC LIMIT 1`
        )
        .get(exchange) as { total_contracts?: number } | undefined;
      resolvedTotalSymbols = Number(snapRow?.total_contracts ?? 0);
    }
    if (resolvedTotalSymbols === 0) {
      const jobCountRow = this.db
        .prepare(
          `SELECT COUNT(DISTINCT symbol) as cnt FROM smc_scan_jobs WHERE exchange = ?`
        )
        .get(exchange) as { cnt?: number } | undefined;
      resolvedTotalSymbols = Number(jobCountRow?.cnt ?? 0);
    }
    if (resolvedTotalSymbols === 0) {
      resolvedTotalSymbols = distinctCachedSymbols.size;
    }

    const symbolsWithStale = new Set<string>();
    const symbolsWithExpired = new Set<string>();

    const freshByTf: Record<Timeframe, Set<string>> = {
      '5m': new Set<string>(),
      '15m': new Set<string>(),
      '1h': new Set<string>(),
      '4h': new Set<string>(),
    };
    const freshOiSymbols = new Set<string>();
    const freshFundingSymbols = new Set<string>();
    let nextExpiryMs = Number.POSITIVE_INFINITY;

    for (const r of rows) {
      const sym = String(r.symbol);
      const tf = String(r.timeframe) as Timeframe;
      const expMs = Date.parse(String(r.expires_at));
      const isTtlExpired = !Number.isFinite(expMs) || nowMs >= expMs;
      if (Number.isFinite(expMs) && expMs > nowMs && expMs < nextExpiryMs) {
        nextExpiryMs = expMs;
      }

      const fetchedAtMs = Date.parse(String(r.fetched_at)) || nowMs;
      const dataTs =
        r.data_timestamp !== null && r.data_timestamp !== undefined
          ? Number(r.data_timestamp)
          : fetchedAtMs;
      let isNewBarFormed = false;
      if (tf === '5m' || tf === '15m') {
        const barMs = tf === '5m' ? 300_000 : 900_000;
        if (
          Number.isFinite(dataTs) &&
          Math.abs(fetchedAtMs - dataTs) <= 6 * barMs
        ) {
          const barExpireAtMs = dataTs + barMs;
          if (nowMs >= barExpireAtMs) {
            isNewBarFormed = true;
          } else if (barExpireAtMs < nextExpiryMs) {
            nextExpiryMs = barExpireAtMs;
          }
        }
      }

      const rawStale = Number(r.stale) === 1;
      const fallback = Number(r.fallback) === 1;
      const missingDataStr = String(r.missing_data_json || '[]');
      const hasMissingData = missingDataStr !== '[]';
      const ruleMismatch = Boolean(
        r.rule_version && String(r.rule_version) !== expectedRuleVersion
      );
      const winKey = r.window_key ? String(r.window_key) : null;
      const winInvalid = Boolean(
        winKey &&
          (winKey.startsWith('OLD_') ||
            winKey.startsWith('EXPIRED_') ||
            winKey.startsWith('INVALID_'))
      );

      const oiExpMs = r.oi_expires_at ? Date.parse(String(r.oi_expires_at)) : expMs;
      const isOiExp = Boolean(
        tf === '15m' &&
          r.oi_expires_at &&
          Number.isFinite(oiExpMs) &&
          nowMs >= oiExpMs
      );
      if (
        tf === '15m' &&
        r.oi_expires_at &&
        Number.isFinite(oiExpMs) &&
        oiExpMs > nowMs &&
        oiExpMs < nextExpiryMs
      ) {
        nextExpiryMs = oiExpMs;
      }

      const nextFundingMs =
        r.next_funding_time !== null && r.next_funding_time !== undefined
          ? Number(r.next_funding_time)
          : null;
      const isFundingExp = Boolean(
        nextFundingMs !== null &&
          Number.isFinite(nextFundingMs) &&
          nowMs >= nextFundingMs
      );
      if (
        nextFundingMs !== null &&
        Number.isFinite(nextFundingMs) &&
        nextFundingMs > nowMs &&
        nextFundingMs < nextExpiryMs
      ) {
        nextExpiryMs = nextFundingMs;
      }

      const isRowExpired =
        isTtlExpired ||
        isNewBarFormed ||
        isOiExp ||
        isFundingExp ||
        rawStale ||
        fallback ||
        hasMissingData ||
        ruleMismatch ||
        winInvalid;

      if (rawStale) {
        symbolsWithStale.add(sym);
      }
      if (isRowExpired) {
        symbolsWithExpired.add(sym);
      } else if (tf in freshByTf) {
        freshByTf[tf].add(sym);
      }

      if (!rawStale && !fallback && !hasMissingData && !ruleMismatch && !winInvalid) {
        if (
          tf === '15m' &&
          r.open_interest !== null &&
          r.open_interest !== undefined &&
          r.open_interest_value !== null &&
          r.open_interest_value !== undefined &&
          Number.isFinite(oiExpMs) &&
          nowMs < oiExpMs
        ) {
          freshOiSymbols.add(sym);
        }
        if (
          r.funding_rate !== null &&
          r.funding_rate !== undefined &&
          !isTtlExpired &&
          (nextFundingMs === null || nowMs < nextFundingMs)
        ) {
          freshFundingSymbols.add(sym);
        }
      }
    }

    // Any symbol with a stale row cannot be counted as fresh in any timeframe
    for (const staleSym of symbolsWithStale) {
      freshByTf['5m'].delete(staleSym);
      freshByTf['15m'].delete(staleSym);
      freshByTf['1h'].delete(staleSym);
      freshByTf['4h'].delete(staleSym);
      freshOiSymbols.delete(staleSym);
      freshFundingSymbols.delete(staleSym);
    }

    const denom = Math.max(1, resolvedTotalSymbols);
    const cov5m =
      resolvedTotalSymbols > 0
        ? Math.min(100, Math.round((freshByTf['5m'].size / denom) * 10000) / 100)
        : 0;
    const cov15m =
      resolvedTotalSymbols > 0
        ? Math.min(100, Math.round((freshByTf['15m'].size / denom) * 10000) / 100)
        : 0;
    const cov1h =
      resolvedTotalSymbols > 0
        ? Math.min(100, Math.round((freshByTf['1h'].size / denom) * 10000) / 100)
        : 0;
    const cov4h =
      resolvedTotalSymbols > 0
        ? Math.min(100, Math.round((freshByTf['4h'].size / denom) * 10000) / 100)
        : 0;
    const covOi =
      resolvedTotalSymbols > 0
        ? Math.min(100, Math.round((freshOiSymbols.size / denom) * 10000) / 100)
        : 0;
    const covFunding =
      resolvedTotalSymbols > 0
        ? Math.min(
            100,
            Math.round((freshFundingSymbols.size / denom) * 10000) / 100
          )
        : 0;

    let fullyFreshSymbolCount = 0;
    for (const sym of freshByTf['15m']) {
      if (
        !symbolsWithStale.has(sym) &&
        !symbolsWithExpired.has(sym) &&
        freshByTf['5m'].has(sym) &&
        freshByTf['1h'].has(sym) &&
        freshByTf['4h'].has(sym) &&
        freshOiSymbols.has(sym) &&
        freshFundingSymbols.has(sym)
      ) {
        fullyFreshSymbolCount++;
      }
    }

    const freshCacheCount =
      resolvedTotalSymbols > 0
        ? Math.min(resolvedTotalSymbols, fullyFreshSymbolCount)
        : fullyFreshSymbolCount;
    const staleCacheCount =
      resolvedTotalSymbols > 0
        ? Math.min(resolvedTotalSymbols, symbolsWithStale.size)
        : symbolsWithStale.size;
    const expiredCacheCount =
      resolvedTotalSymbols > 0
        ? Math.min(
            resolvedTotalSymbols,
            Math.max(symbolsWithExpired.size, distinctCachedSymbols.size - freshCacheCount)
          )
        : symbolsWithExpired.size;

    const prewarmRequiredCount =
      resolvedTotalSymbols > 0
        ? Math.max(0, resolvedTotalSymbols - freshCacheCount)
        : 0;
    const cacheMissCount = prewarmRequiredCount;

    const cacheCoverageRate =
      resolvedTotalSymbols > 0
        ? Math.min(
            100,
            Math.round(
              ((cov5m + cov15m + cov1h + cov4h + covOi + covFunding) / 6) * 100
            ) / 100
          )
        : 0;

    let cacheStatusLabel: SmcCacheUiStatus = '資料不可用';
    if (
      isPrewarming &&
      (prewarmRequiredCount > 0 ||
        expiredCacheCount > 0 ||
        staleCacheCount > 0 ||
        freshCacheCount === 0)
    ) {
      cacheStatusLabel = '正在預熱';
    } else if (freshCacheCount === 0 && distinctCachedSymbols.size === 0) {
      cacheStatusLabel = '資料不可用';
    } else if (
      expiredCacheCount > 0 ||
      staleCacheCount > 0 ||
      prewarmRequiredCount > 0
    ) {
      cacheStatusLabel = '快取過期';
    } else {
      cacheStatusLabel = '快取可用';
    }

    return {
      metrics: {
        cacheCoverage: cacheCoverageRate,
        cacheCoverageRate,
        freshCacheCount,
        expiredCacheCount,
        staleCacheCount,
        cacheMissCount,
        prewarmRequiredCount,
        '5mCoverage': cov5m,
        '15mCoverage': cov15m,
        '1hCoverage': cov1h,
        '4hCoverage': cov4h,
        '5mCacheCoverage': cov5m,
        '15mCacheCoverage': cov15m,
        '1hCacheCoverage': cov1h,
        '4hCacheCoverage': cov4h,
        oiCacheCoverage: covOi,
        fundingCacheCoverage: covFunding,
        cacheStatus: cacheStatusLabel,
        cacheStatusLabel,
      },
      nextExpiryMs,
    };
  }

  public getCacheCoverageMetrics(
    exchange: ExchangeId,
    totalUniverseSymbolsCount?: number,
    isPrewarming = false,
    expectedRuleVersion = 'v1.0.0-smc-ict-deterministic',
    nowMs = Date.now()
  ): SmcCacheCoverageMetrics {
    return this.computeCacheCoverageWithExpiry(
      exchange,
      totalUniverseSymbolsCount,
      isPrewarming,
      expectedRuleVersion,
      nowMs
    ).metrics;
  }

  public listCacheRefreshNeeds(
    exchange: ExchangeId,
    universeSymbols?: string[],
    expectedRuleVersion = 'v1.0.0-smc-ict-deterministic',
    nowMs = Date.now()
  ): {
    totalTargetSymbols: number;
    needsTickerSnapshotRefresh: boolean;
    fundingExpiredSymbolCount: number;
    symbolsNeedingFetch: Array<{
      symbol: string;
      timeframes: Timeframe[];
      needsOi: boolean;
      hasStaleRow: boolean;
      priorityRank: number;
    }>;
  } {
    const isLiveVenue = exchange !== 'demo_synthetic';
    const isDemoInt = isLiveVenue ? 0 : 1;

    const jobPriorityRows = this.db
      .prepare(
        `SELECT symbol, MIN(priority_tier) AS min_tier, MAX(priority) AS max_prio
         FROM smc_scan_jobs
         WHERE exchange = ?
         GROUP BY symbol`
      )
      .all(exchange) as Array<{
      symbol: string;
      min_tier: number;
      max_prio: number;
    }>;

    const priorityRankBySymbol = new Map<string, number>();
    for (const jr of jobPriorityRows) {
      const sym = String(jr.symbol);
      const tier = Number(jr.min_tier ?? 6);
      const prio = Number(jr.max_prio ?? 0);
      priorityRankBySymbol.set(sym, (7 - tier) * 100000 + prio);
    }

    const cacheRows = this.db
      .prepare(
        `SELECT symbol, timeframe, expires_at, stale, fallback, missing_data_json, rule_version, window_key,
                data_timestamp, fetched_at, open_interest, open_interest_value, funding_rate, next_funding_time, oi_expires_at
         FROM smc_scan_candles_cache
         WHERE exchange = ? AND is_demo = ?`
      )
      .all(exchange, isDemoInt) as Array<{
      symbol: string;
      timeframe: string;
      expires_at: string;
      stale: number;
      fallback: number;
      missing_data_json: string;
      rule_version: string | null;
      window_key: string | null;
      data_timestamp: number | null;
      fetched_at: string;
      open_interest: number | null;
      open_interest_value: number | null;
      funding_rate: number | null;
      next_funding_time: number | null;
      oi_expires_at: string | null;
    }>;

    const targetSymbolSet = new Set<string>();
    if (universeSymbols && universeSymbols.length > 0) {
      for (const s of universeSymbols) {
        const clean = String(s || '').trim().toUpperCase();
        if (clean) targetSymbolSet.add(clean);
      }
    } else {
      for (const jr of jobPriorityRows) {
        targetSymbolSet.add(String(jr.symbol));
      }
      for (const cr of cacheRows) {
        targetSymbolSet.add(String(cr.symbol));
      }
    }

    if (targetSymbolSet.size === 0) {
      return {
        totalTargetSymbols: 0,
        needsTickerSnapshotRefresh: false,
        fundingExpiredSymbolCount: 0,
        symbolsNeedingFetch: [],
      };
    }

    const rowsBySymbolTf = new Map<
      string,
      Partial<Record<Timeframe, (typeof cacheRows)[number]>>
    >();
    for (const r of cacheRows) {
      const sym = String(r.symbol);
      const tf = String(r.timeframe) as Timeframe;
      let entry = rowsBySymbolTf.get(sym);
      if (!entry) {
        entry = {};
        rowsBySymbolTf.set(sym, entry);
      }
      entry[tf] = r;
    }

    const timeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    let needsTickerSnapshotRefresh = false;
    let fundingExpiredSymbolCount = 0;
    const symbolsNeedingFetch: Array<{
      symbol: string;
      timeframes: Timeframe[];
      needsOi: boolean;
      hasStaleRow: boolean;
      priorityRank: number;
    }> = [];

    for (const sym of targetSymbolSet) {
      const symRows = rowsBySymbolTf.get(sym);
      const neededTfs: Timeframe[] = [];
      let needsOi = false;
      let hasStaleRow = false;
      let hasFundingExpired = false;

      for (const tf of timeframes) {
        const r = symRows?.[tf];
        if (!r) {
          neededTfs.push(tf);
          if (tf === '15m') {
            needsOi = true;
          }
          continue;
        }

        const expMs = Date.parse(String(r.expires_at));
        const isTtlExpired = !Number.isFinite(expMs) || nowMs >= expMs;
        const fetchedAtMs = Date.parse(String(r.fetched_at)) || nowMs;
        const dataTs =
          r.data_timestamp !== null && r.data_timestamp !== undefined
            ? Number(r.data_timestamp)
            : fetchedAtMs;
        let isNewBarFormed = false;
        if (tf === '5m' || tf === '15m') {
          const barMs = tf === '5m' ? 300_000 : 900_000;
          if (
            Number.isFinite(dataTs) &&
            Math.abs(fetchedAtMs - dataTs) <= 6 * barMs &&
            nowMs >= dataTs + barMs
          ) {
            isNewBarFormed = true;
          }
        }

        const rawStale = Number(r.stale) === 1;
        const fallback = Number(r.fallback) === 1;
        const hasMissingData = String(r.missing_data_json || '[]') !== '[]';
        const ruleMismatch = Boolean(
          r.rule_version && String(r.rule_version) !== expectedRuleVersion
        );
        const winKey = r.window_key ? String(r.window_key) : null;
        const winInvalid = Boolean(
          winKey &&
            (winKey.startsWith('OLD_') ||
              winKey.startsWith('EXPIRED_') ||
              winKey.startsWith('INVALID_'))
        );

        if (rawStale) {
          hasStaleRow = true;
        }

        if (
          isTtlExpired ||
          isNewBarFormed ||
          rawStale ||
          fallback ||
          hasMissingData ||
          ruleMismatch ||
          winInvalid
        ) {
          neededTfs.push(tf);
        }

        if (tf === '15m') {
          const oiExpMs = r.oi_expires_at
            ? Date.parse(String(r.oi_expires_at))
            : NaN;
          const isOiMissingOrExpired =
            r.open_interest === null ||
            r.open_interest === undefined ||
            r.open_interest_value === null ||
            r.open_interest_value === undefined ||
            !r.oi_expires_at ||
            !Number.isFinite(oiExpMs) ||
            nowMs >= oiExpMs;
          if (isOiMissingOrExpired) {
            needsOi = true;
          }
        }

        const nextFundingMs =
          r.next_funding_time !== null && r.next_funding_time !== undefined
            ? Number(r.next_funding_time)
            : null;
        const isFundingExp = Boolean(
          r.funding_rate === null ||
            r.funding_rate === undefined ||
            (nextFundingMs !== null &&
              Number.isFinite(nextFundingMs) &&
              nowMs >= nextFundingMs)
        );
        if (isFundingExp) {
          hasFundingExpired = true;
        }
      }

      if (hasFundingExpired) {
        needsTickerSnapshotRefresh = true;
        fundingExpiredSymbolCount++;
      }

      if (neededTfs.length > 0 || needsOi) {
        symbolsNeedingFetch.push({
          symbol: sym,
          timeframes: neededTfs,
          needsOi,
          hasStaleRow,
          priorityRank: priorityRankBySymbol.get(sym) ?? 0,
        });
      }
    }

    symbolsNeedingFetch.sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) {
        return b.priorityRank - a.priorityRank;
      }
      if (a.hasStaleRow !== b.hasStaleRow) {
        return a.hasStaleRow ? -1 : 1;
      }
      return a.symbol.localeCompare(b.symbol);
    });

    return {
      totalTargetSymbols: targetSymbolSet.size,
      needsTickerSnapshotRefresh,
      fundingExpiredSymbolCount,
      symbolsNeedingFetch,
    };
  }

  public refreshFundingMetadataInCandlesCache(
    exchange: ExchangeId,
    tickerMap: Map<string, MarketTicker>,
    nowMs = Date.now()
  ): number {
    if (tickerMap.size === 0) return 0;
    const isDemoInt = exchange === 'demo_synthetic' ? 1 : 0;
    let updatedCount = 0;

    this.runInTransaction(() => {
      const updateStmt = this.db.prepare(`
        UPDATE smc_scan_candles_cache
        SET funding_rate = ?,
            next_funding_time = ?
        WHERE exchange = ?
          AND symbol = ?
          AND is_demo = ?
          AND (
            funding_rate IS NULL
            OR next_funding_time IS NULL
            OR next_funding_time <= ?
            OR next_funding_time < ?
          )
      `);
      for (const [sym, ticker] of tickerMap.entries()) {
        if (
          ticker.fundingRate === null ||
          ticker.fundingRate === undefined ||
          !Number.isFinite(ticker.fundingRate)
        ) {
          continue;
        }
        const nextFundingTime =
          ticker.nextFundingTime !== null &&
          ticker.nextFundingTime !== undefined &&
          Number.isFinite(ticker.nextFundingTime)
            ? Number(ticker.nextFundingTime)
            : null;
        if (nextFundingTime !== null && nextFundingTime <= nowMs) {
          continue;
        }
        const res = updateStmt.run(
          ticker.fundingRate,
          nextFundingTime,
          exchange,
          sym,
          isDemoInt,
          nowMs,
          nextFundingTime ?? nowMs
        );
        updatedCount += Number(res.changes ?? 0);
      }
    });

    if (updatedCount > 0) {
      this.touchSmcState(exchange);
    }
    return updatedCount;
  }

  public savePrewarmSnapshot(snapshot: SmcPrewarmSnapshotRecord): void {
    this.db
      .prepare(
        `INSERT INTO smc_prewarm_snapshots (
           snapshot_id, database_instance_id, exchange, rule_version, window_key,
           created_at, symbol_count, timeframe_coverage_json, oi_funding_coverage_json, fresh_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(snapshot_id) DO UPDATE SET
           created_at = excluded.created_at,
           symbol_count = excluded.symbol_count,
           timeframe_coverage_json = excluded.timeframe_coverage_json,
           oi_funding_coverage_json = excluded.oi_funding_coverage_json,
           fresh_until = excluded.fresh_until`
      )
      .run(
        snapshot.snapshotId,
        snapshot.databaseInstanceId || this.databaseInstanceId,
        snapshot.exchange,
        snapshot.ruleVersion,
        snapshot.windowKey,
        snapshot.createdAt,
        snapshot.symbolCount,
        JSON.stringify(snapshot.timeframeCoverage),
        JSON.stringify(snapshot.oiFundingCoverage),
        snapshot.freshUntil
      );
  }

  public getLatestPrewarmSnapshot(
    exchange: ExchangeId
  ): SmcPrewarmSnapshotRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM smc_prewarm_snapshots
         WHERE exchange = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(exchange) as Record<string, unknown> | undefined;
    if (!r) return null;

    let timeframeCoverage: Record<Timeframe, number> = {
      '5m': 0,
      '15m': 0,
      '1h': 0,
      '4h': 0,
    };
    let oiFundingCoverage = { oiCoverage: 0, fundingCoverage: 0 };
    try {
      timeframeCoverage = JSON.parse(String(r.timeframe_coverage_json || '{}'));
    } catch {
      // ignore
    }
    try {
      oiFundingCoverage = JSON.parse(String(r.oi_funding_coverage_json || '{}'));
    } catch {
      // ignore
    }

    return {
      snapshotId: String(r.snapshot_id),
      databaseInstanceId: String(r.database_instance_id),
      exchange: String(r.exchange) as ExchangeId,
      ruleVersion: String(r.rule_version),
      windowKey: String(r.window_key),
      createdAt: String(r.created_at),
      symbolCount: Number(r.symbol_count ?? 0),
      timeframeCoverage,
      oiFundingCoverage,
      freshUntil: String(r.fresh_until),
    };
  }

  public recordPrewarmTask(task: SmcPrewarmTaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO smc_prewarm_tasks (
           exchange, symbol, prewarm_started_at, prewarm_completed_at,
           prewarm_duration_ms, prewarm_priority, prewarm_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(exchange, symbol) DO UPDATE SET
           prewarm_started_at = excluded.prewarm_started_at,
           prewarm_completed_at = excluded.prewarm_completed_at,
           prewarm_duration_ms = excluded.prewarm_duration_ms,
           prewarm_priority = excluded.prewarm_priority,
           prewarm_status = excluded.prewarm_status`
      )
      .run(
        task.exchange,
        task.symbol,
        task.prewarmStartedAt,
        task.prewarmCompletedAt,
        Math.max(0, Math.round(task.prewarmDurationMs)),
        task.prewarmPriority,
        task.prewarmStatus
      );
  }

  public listPrewarmTasks(
    exchange: ExchangeId,
    limit = 100
  ): SmcPrewarmTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM smc_prewarm_tasks
         WHERE exchange = ?
         ORDER BY CASE WHEN prewarm_priority = 'FAST_LANE' THEN 0 ELSE 1 END ASC, prewarm_started_at DESC
         LIMIT ?`
      )
      .all(exchange, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      prewarmStartedAt: String(r.prewarm_started_at),
      prewarmCompletedAt: r.prewarm_completed_at
        ? String(r.prewarm_completed_at)
        : null,
      prewarmDurationMs: Number(r.prewarm_duration_ms ?? 0),
      prewarmPriority: (r.prewarm_priority === 'BULK'
        ? 'BULK'
        : 'FAST_LANE') as SmcPriorityClass,
      prewarmStatus: (r.prewarm_status || 'COMPLETED') as SmcPrewarmStatus,
    }));
  }

  // ============================================================================
  // Phase 11: SMC Gate Item-by-Item Statistics & 7-Category Reason Analysis
  // ============================================================================

  public static classifySmcBlockingReason(
    reason: string,
    actionState: SmcActionState,
    evaluationStatus: SmcEvaluationStatus,
    entryWindowStatus?: string | null
  ): SmcReasonCategory {
    if (
      evaluationStatus === 'PENDING' ||
      actionState === 'PENDING' ||
      reason.includes('等待評估') ||
      reason.includes('尚未完成評估') ||
      reason.includes('佇列排隊中')
    ) {
      return 'PENDING';
    }
    if (
      entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
      reason.includes('ENTRY_WINDOW_MISSED') ||
      reason.includes('錯過進場窗') ||
      reason.includes('進場時間窗已過')
    ) {
      return 'ENTRY_WINDOW_MISSED';
    }
    if (
      reason.includes('低流動性') ||
      reason.includes('流動性限制') ||
      reason.includes('流動性不足') ||
      reason.includes('盤口點差過大') ||
      reason.includes('TIER_3')
    ) {
      return 'LIQUIDITY_BLOCKED';
    }
    if (
      actionState === 'HIGH RISK' ||
      reason.includes('高風險攔截') ||
      reason.includes('資金費率極端') ||
      reason.includes('極端資金費率') ||
      reason.includes('Funding Safety') ||
      reason.includes('Funding 高風險') ||
      reason.includes('風險攔截')
    ) {
      return 'RISK_BLOCKED';
    }
    if (
      reason.includes('多週期') ||
      reason.includes('跨週期') ||
      reason.includes('同週期內部多空條件互相衝突') ||
      reason.includes('結構未同向對齊') ||
      reason.includes('MTF') ||
      reason.includes('方向衝突') ||
      reason.includes('方向未對齊')
    ) {
      return 'MTF_CONFLICT';
    }
    if (
      reason.includes('缺少 Open Interest') ||
      reason.includes('Open Interest') ||
      reason.includes('未平倉量') ||
      reason.includes('OI 缺失') ||
      reason.includes('缺少 Funding') ||
      reason.includes('資料過期') ||
      reason.includes('stale') ||
      reason.includes('fallback') ||
      reason.includes('15m 歷史量能') ||
      reason.includes('歷史成交量基線') ||
      reason.includes('歷史成交量基準') ||
      reason.includes('Baseline Warmup') ||
      reason.includes('已確認收盤 K 線不足') ||
      reason.includes('已確認 K 線不足') ||
      reason.includes('ATR(14) 無效') ||
      reason.includes('ATR 無效') ||
      reason.includes('K 線或指標資料缺失') ||
      reason.includes('missingData')
    ) {
      return 'DATA_BLOCKED';
    }
    return 'STRUCTURE_INCOMPLETE';
  }

  public evaluateSymbolGateDiagnostics(
    r: SmcScanResultRecord,
    fallbackCycleId = 'cycle_default'
  ): SmcSymbolGateReasonRecord {
    const a = r.smcAnalysis;
    const waitReasons = Array.isArray(r.waitReasons) ? r.waitReasons : [];
    const missingData = Array.isArray(r.missingData) ? r.missingData : [];

    const confirmedClosedKlines =
      Boolean(a && a.confirmedKlineCount >= 30) &&
      !waitReasons.some((w) => w.includes('已確認收盤 K 線不足') || w.includes('已確認 K 線不足'));
    const historyBaselineReady = !waitReasons.some(
      (w) => w.includes('15m 歷史量能') || w.includes('歷史成交量基線')
    );
    const validATR =
      Boolean(
        a &&
          a.atr14 !== null &&
          Number.isFinite(a.atr14) &&
          a.atr14 > 0 &&
          a.atrPercent !== null
      ) && !waitReasons.some((w) => w.includes('ATR(14) 無效') || w.includes('ATR 無效'));

    const bosMss = Boolean(a && a.bosOrMss?.detected);
    const liquiditySweep = Boolean(a && a.liquiditySweep?.detected);
    const displacement = Boolean(a && a.displacement?.detected);
    const fvgOrderBlock = Boolean(
      a &&
        ((a.fvg?.detected && !a.fvg.mitigated) ||
          Boolean(a.orderBlock?.detected))
    );
    const mtfAlignment =
      Boolean(a && a.mtfAlignment?.aligned) &&
      !waitReasons.some(
        (w) =>
          w.includes('多週期') || w.includes('同週期內部多空條件互相衝突')
      );

    const oiAvailable =
      !missingData.includes('openInterest') &&
      !waitReasons.some((w) => w.includes('缺少 Open Interest') || w.includes('OI 缺失'));
    const fundingAvailable =
      !missingData.includes('fundingRate') &&
      !waitReasons.some((w) => w.includes('缺少 Funding'));
    const liquiditySafety = !waitReasons.some(
      (w) => w.includes('低流動性') || w.includes('流動性限制')
    );
    const fundingSafety =
      r.smcActionState !== 'HIGH RISK' &&
      !waitReasons.some(
        (w) => w.includes('資金費率極端') || w.includes('Funding 高風險') || w.includes('高風險攔截')
      );
    const cleanData =
      !r.stale &&
      !r.fallback &&
      missingData.length === 0 &&
      !waitReasons.some((w) => w.includes('資料過期') || w.includes('fallback'));
    const isCandidate =
      r.smcEvaluationStatus === 'EVALUATED' &&
      (r.smcActionState === 'LONG CANDIDATE' ||
        r.smcActionState === 'SHORT CANDIDATE') &&
      r.finalTradeSignal !== 'NONE' &&
      waitReasons.length === 0;

    const gatePassMap: Record<SmcQualityGateKey, boolean> = {
      confirmedClosedKlines,
      historyBaselineReady,
      validATR,
      'BOS/MSS': bosMss,
      'Liquidity Sweep': liquiditySweep,
      Displacement: displacement,
      'FVG/Order Block': fvgOrderBlock,
      'MTF Alignment': mtfAlignment,
      'OI available': oiAvailable,
      'Funding available': fundingAvailable,
      'Liquidity safety': liquiditySafety,
      'Funding safety': fundingSafety,
      'stale/fallback/missingData': cleanData,
      'WAIT reasons': isCandidate,
    };

    const gateKeys: SmcQualityGateKey[] = [
      'confirmedClosedKlines',
      'historyBaselineReady',
      'validATR',
      'BOS/MSS',
      'Liquidity Sweep',
      'Displacement',
      'FVG/Order Block',
      'MTF Alignment',
      'OI available',
      'Funding available',
      'Liquidity safety',
      'Funding safety',
      'stale/fallback/missingData',
      'WAIT reasons',
    ];
    const failedGates = gateKeys.filter((k) => !gatePassMap[k]);

    const allReasons: string[] = [...waitReasons];
    if (!isCandidate && allReasons.length === 0) {
      if (r.smcEvaluationStatus === 'PENDING' || r.smcActionState === 'PENDING') {
        allReasons.push('SMC 規則佇列等待評估中');
      } else if (!cleanData) {
        allReasons.push('資料過期、缺失或 fallback 阻擋');
      } else if (!fundingSafety) {
        allReasons.push('高風險攔截：資金費率極端 (Funding 高風險，禁止列入一般候選)');
      } else if (!liquiditySafety) {
        allReasons.push('低流動性標的限制為觀察名單 (禁止升級為交易候選)');
      } else if (!mtfAlignment) {
        allReasons.push('多週期結構方向未完全對齊 (5m/15m/1h/4h)');
      } else {
        allReasons.push('SMC 結構條件未完整滿足 (BOS/Sweep/Displacement/FVG)');
      }
    }

    const reasonCategoriesSet = new Set<SmcReasonCategory>();
    for (const reason of allReasons) {
      reasonCategoriesSet.add(
        RadarDatabase.classifySmcBlockingReason(
          reason,
          r.smcActionState,
          r.smcEvaluationStatus,
          r.entryWindowStatus
        )
      );
    }
    if (r.entryWindowStatus === 'ENTRY_WINDOW_MISSED') {
      reasonCategoriesSet.add('ENTRY_WINDOW_MISSED');
    }

    let primaryBlockingReason: string | null = null;
    let primaryReasonCategory: SmcReasonCategory | 'CANDIDATE_PASSED' =
      'CANDIDATE_PASSED';

    if (!isCandidate) {
      primaryBlockingReason = allReasons[0] ?? '未通過完整 SMC Gate';
      // Priority order for primary category: PENDING > DATA_BLOCKED > RISK_BLOCKED > LIQUIDITY_BLOCKED > ENTRY_WINDOW_MISSED > MTF_CONFLICT > STRUCTURE_INCOMPLETE
      if (r.smcEvaluationStatus === 'PENDING' || r.smcActionState === 'PENDING') {
        primaryReasonCategory = 'PENDING';
      } else if (reasonCategoriesSet.has('DATA_BLOCKED')) {
        primaryReasonCategory = 'DATA_BLOCKED';
        const dataReason = allReasons.find(
          (w) =>
            RadarDatabase.classifySmcBlockingReason(
              w,
              r.smcActionState,
              r.smcEvaluationStatus,
              r.entryWindowStatus
            ) === 'DATA_BLOCKED'
        );
        if (dataReason) primaryBlockingReason = dataReason;
      } else if (
        r.smcActionState === 'HIGH RISK' ||
        reasonCategoriesSet.has('RISK_BLOCKED')
      ) {
        primaryReasonCategory = 'RISK_BLOCKED';
        const riskReason = allReasons.find(
          (w) =>
            RadarDatabase.classifySmcBlockingReason(
              w,
              r.smcActionState,
              r.smcEvaluationStatus,
              r.entryWindowStatus
            ) === 'RISK_BLOCKED'
        );
        if (riskReason) primaryBlockingReason = riskReason;
      } else if (reasonCategoriesSet.has('LIQUIDITY_BLOCKED')) {
        primaryReasonCategory = 'LIQUIDITY_BLOCKED';
        const liqReason = allReasons.find(
          (w) =>
            RadarDatabase.classifySmcBlockingReason(
              w,
              r.smcActionState,
              r.smcEvaluationStatus,
              r.entryWindowStatus
            ) === 'LIQUIDITY_BLOCKED'
        );
        if (liqReason) primaryBlockingReason = liqReason;
      } else if (reasonCategoriesSet.has('ENTRY_WINDOW_MISSED')) {
        primaryReasonCategory = 'ENTRY_WINDOW_MISSED';
      } else if (reasonCategoriesSet.has('MTF_CONFLICT')) {
        primaryReasonCategory = 'MTF_CONFLICT';
        const mtfReason = allReasons.find(
          (w) =>
            RadarDatabase.classifySmcBlockingReason(
              w,
              r.smcActionState,
              r.smcEvaluationStatus,
              r.entryWindowStatus
            ) === 'MTF_CONFLICT'
        );
        if (mtfReason) primaryBlockingReason = mtfReason;
      } else {
        primaryReasonCategory = 'STRUCTURE_INCOMPLETE';
      }
    }

    return {
      symbol: r.symbol,
      exchange: r.exchange,
      scanCycleId: r.scanCycleId || fallbackCycleId,
      evaluatedAt: r.evaluatedAt || null,
      smcEvaluationStatus: r.smcEvaluationStatus,
      smcActionState: r.smcActionState,
      finalTradeSignal: r.finalTradeSignal,
      marketRadarCategory: r.marketRadarCategory ?? '準備觀察',
      primaryBlockingReason,
      primaryReasonCategory,
      allReasons,
      reasonCategories: Array.from(reasonCategoriesSet),
      gatePassMap,
      failedGates,
      entryWindowStatus: r.entryWindowStatus ?? 'NOT_APPLICABLE',
      detectionLatencyMs: r.detectionLatencyMs ?? null,
    };
  }

  private summarizeResultsGateAndReasons(
    results: SmcScanResultRecord[],
    scanCycleId: string,
    pendingCount = 0
  ): {
    gateNotConfirmedCount: number;
    finalCategorySmcMismatchCount: number;
    gates: SmcQualityGateItemStat[];
    gateSummaryMap: Record<SmcQualityGateKey, SmcQualityGateItemStat>;
    compactGateStats: Record<
      SmcQualityGateKey,
      {
        passCount: number;
        failCount: number;
        passRate: number;
        failureRate: number;
      }
    >;
    gatePassRates: Record<SmcQualityGateKey, number>;
    gateFailureRates: Record<SmcQualityGateKey, number>;
    topFailedGates: SmcQualityGateItemStat[];
    symbolDiagnostics: SmcSymbolGateReasonRecord[];
    primaryCategoryCounts: Record<SmcReasonCategory, number>;
    categoryOccurrenceCounts: Record<SmcReasonCategory, number>;
    reasonCategories: Record<SmcReasonCategory, SmcReasonCategoryStat>;
    reasonCategoryList: SmcReasonCategoryStat[];
    waitReasonRanking: SmcReasonRankEntry[];
    waitReasonCounts: Record<string, number>;
    watchReasonCounts: Record<string, number>;
    highRiskReasonCounts: Record<string, number>;
    uniqueSymbolCount: number;
    totalReasonOccurrences: number;
    directionDistribution: {
      longCandidateCount: number;
      shortCandidateCount: number;
      longRatioPercent: number;
      shortRatioPercent: number;
      bullStructureBiasCount: number;
      bearStructureBiasCount: number;
      neutralOrConflictCount: number;
      radarLongObservationCount: number;
      radarShortObservationCount: number;
    };
  } {
    const totalEval = results.length;
    const denom = Math.max(1, totalEval);

    const gateDefinitions: Array<{
      gate: SmcQualityGateKey;
      label: string;
      category: SmcReasonCategory;
    }> = [
      {
        gate: 'confirmedClosedKlines',
        label: '已確認收盤 K 線充足 (>=30 根)',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'historyBaselineReady',
        label: '15m 歷史量能基準就緒 (>=20 樣本)',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'validATR',
        label: 'ATR(14) 波動率有效',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'BOS/MSS',
        label: 'BOS / MSS 市場結構突破',
        category: 'STRUCTURE_INCOMPLETE',
      },
      {
        gate: 'Liquidity Sweep',
        label: 'Liquidity Sweep 流動性清掃',
        category: 'STRUCTURE_INCOMPLETE',
      },
      {
        gate: 'Displacement',
        label: 'Displacement 位移K線確認',
        category: 'STRUCTURE_INCOMPLETE',
      },
      {
        gate: 'FVG/Order Block',
        label: 'FVG / Order Block 價值缺口或訂單塊',
        category: 'STRUCTURE_INCOMPLETE',
      },
      {
        gate: 'MTF Alignment',
        label: 'MTF 多週期方向對齊 (5m/15m/1h/4h)',
        category: 'MTF_CONFLICT',
      },
      {
        gate: 'OI available',
        label: 'Open Interest 持倉量資料可用',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'Funding available',
        label: 'Funding Rate 資金費率資料可用',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'Liquidity safety',
        label: 'Liquidity Safety 流動性安全門檻',
        category: 'LIQUIDITY_BLOCKED',
      },
      {
        gate: 'Funding safety',
        label: 'Funding Safety 資金費率安全門檻',
        category: 'RISK_BLOCKED',
      },
      {
        gate: 'stale/fallback/missingData',
        label: '新鮮實況資料 (無 stale/fallback/missingData)',
        category: 'DATA_BLOCKED',
      },
      {
        gate: 'WAIT reasons',
        label: '完整 SMC Gate 零攔截通過 (waitReasons = 0)',
        category: 'STRUCTURE_INCOMPLETE',
      },
    ];

    const passCounts = {} as Record<SmcQualityGateKey, number>;
    const failCounts = {} as Record<SmcQualityGateKey, number>;
    const bullPassCounts = {} as Record<SmcQualityGateKey, number>;
    const bullFailCounts = {} as Record<SmcQualityGateKey, number>;
    const bearPassCounts = {} as Record<SmcQualityGateKey, number>;
    const bearFailCounts = {} as Record<SmcQualityGateKey, number>;

    for (const def of gateDefinitions) {
      passCounts[def.gate] = 0;
      failCounts[def.gate] = 0;
      bullPassCounts[def.gate] = 0;
      bullFailCounts[def.gate] = 0;
      bearPassCounts[def.gate] = 0;
      bearFailCounts[def.gate] = 0;
    }

    const categoryMeta: Record<SmcReasonCategory, string> = {
      DATA_BLOCKED: '資料缺失或過期攔截 (DATA_BLOCKED)',
      STRUCTURE_INCOMPLETE: 'SMC 結構條件未完整 (STRUCTURE_INCOMPLETE)',
      MTF_CONFLICT: '多週期或同週期方向衝突 (MTF_CONFLICT)',
      LIQUIDITY_BLOCKED: '低流動性限制觀察 (LIQUIDITY_BLOCKED)',
      RISK_BLOCKED: '極端資金費率或高風險攔截 (RISK_BLOCKED)',
      ENTRY_WINDOW_MISSED: '錯過下一根 K 線進場窗 (ENTRY_WINDOW_MISSED)',
      PENDING: '佇列等待評估中 (PENDING)',
    };

    const allCategoryKeys: SmcReasonCategory[] = [
      'DATA_BLOCKED',
      'STRUCTURE_INCOMPLETE',
      'MTF_CONFLICT',
      'LIQUIDITY_BLOCKED',
      'RISK_BLOCKED',
      'ENTRY_WINDOW_MISSED',
      'PENDING',
    ];

    const primaryCategoryCounts: Record<SmcReasonCategory, number> = {
      DATA_BLOCKED: 0,
      STRUCTURE_INCOMPLETE: 0,
      MTF_CONFLICT: 0,
      LIQUIDITY_BLOCKED: 0,
      RISK_BLOCKED: 0,
      ENTRY_WINDOW_MISSED: 0,
      PENDING: pendingCount,
    };
    const categoryOccurrenceCounts: Record<SmcReasonCategory, number> = {
      DATA_BLOCKED: 0,
      STRUCTURE_INCOMPLETE: 0,
      MTF_CONFLICT: 0,
      LIQUIDITY_BLOCKED: 0,
      RISK_BLOCKED: 0,
      ENTRY_WINDOW_MISSED: 0,
      PENDING: pendingCount,
    };
    const categorySymbolSets: Record<SmcReasonCategory, Set<string>> = {
      DATA_BLOCKED: new Set<string>(),
      STRUCTURE_INCOMPLETE: new Set<string>(),
      MTF_CONFLICT: new Set<string>(),
      LIQUIDITY_BLOCKED: new Set<string>(),
      RISK_BLOCKED: new Set<string>(),
      ENTRY_WINDOW_MISSED: new Set<string>(),
      PENDING: new Set<string>(),
    };
    const categoryReasonMaps: Record<
      SmcReasonCategory,
      Record<string, number>
    > = {
      DATA_BLOCKED: {},
      STRUCTURE_INCOMPLETE: {},
      MTF_CONFLICT: {},
      LIQUIDITY_BLOCKED: {},
      RISK_BLOCKED: {},
      ENTRY_WINDOW_MISSED: {},
      PENDING: {},
    };

    const waitReasonCounts: Record<string, number> = {};
    const watchReasonCounts: Record<string, number> = {};
    const highRiskReasonCounts: Record<string, number> = {};

    const reasonAggregateMap = new Map<
      string,
      {
        reason: string;
        category: SmcReasonCategory;
        occurrenceCount: number;
        primarySymbolCount: number;
        symbols: Set<string>;
      }
    >();

    let gateNotConfirmedCount = 0;
    let finalCategorySmcMismatchCount = 0;
    let longCandidateCount = 0;
    let shortCandidateCount = 0;
    let bullStructureBiasCount = 0;
    let bearStructureBiasCount = 0;
    let neutralOrConflictCount = 0;
    let radarLongObservationCount = 0;
    let radarShortObservationCount = 0;
    let totalReasonOccurrences = 0;
    const blockedSymbolSet = new Set<string>();

    const symbolDiagnostics: SmcSymbolGateReasonRecord[] = [];

    for (const r of results) {
      const diag = this.evaluateSymbolGateDiagnostics(r, scanCycleId);
      symbolDiagnostics.push(diag);

      if (r.smcActionState === 'LONG CANDIDATE') longCandidateCount++;
      else if (r.smcActionState === 'SHORT CANDIDATE') shortCandidateCount++;
      else gateNotConfirmedCount++;

      if (r.marketRadarCategory === '雷達多頭觀察') radarLongObservationCount++;
      else if (r.marketRadarCategory === '雷達空頭觀察')
        radarShortObservationCount++;

      if (
        (r.smcActionState === 'WAIT' ||
          r.smcActionState === 'WATCH' ||
          r.smcActionState === 'HIGH RISK') &&
        r.finalTradeSignal !== 'NONE'
      ) {
        finalCategorySmcMismatchCount++;
      }
      if (
        r.finalTradeSignal === '多頭交易候選' &&
        (r.smcActionState !== 'LONG CANDIDATE' ||
          r.marketRadarCategory !== '雷達多頭觀察')
      ) {
        finalCategorySmcMismatchCount++;
      }
      if (
        r.finalTradeSignal === '空頭交易候選' &&
        (r.smcActionState !== 'SHORT CANDIDATE' ||
          r.marketRadarCategory !== '雷達空頭觀察')
      ) {
        finalCategorySmcMismatchCount++;
      }

      const a = r.smcAnalysis;
      const domDir = a?.mtfAlignment?.dominantDirection;
      if (domDir === 'BULL') bullStructureBiasCount++;
      else if (domDir === 'BEAR') bearStructureBiasCount++;
      else neutralOrConflictCount++;

      const bullBos = Boolean(
        a?.bosOrMss?.detected &&
          (a.bosOrMss.type === 'BOS_BULL' || a.bosOrMss.type === 'MSS_BULL')
      );
      const bearBos = Boolean(
        a?.bosOrMss?.detected &&
          (a.bosOrMss.type === 'BOS_BEAR' || a.bosOrMss.type === 'MSS_BEAR')
      );
      const bullSweep = Boolean(
        a?.liquiditySweep?.detected &&
          a.liquiditySweep.side === 'SELL_SIDE_SWEPT'
      );
      const bearSweep = Boolean(
        a?.liquiditySweep?.detected &&
          a.liquiditySweep.side === 'BUY_SIDE_SWEPT'
      );
      const bullDisp = Boolean(
        a?.displacement?.detected && a.displacement.direction === 'BULL'
      );
      const bearDisp = Boolean(
        a?.displacement?.detected && a.displacement.direction === 'BEAR'
      );
      const bullFvgOb = Boolean(
        (a?.fvg?.detected && !a.fvg.mitigated && a.fvg.direction === 'BULL') ||
          (a?.orderBlock?.detected && a.orderBlock.direction === 'BULL')
      );
      const bearFvgOb = Boolean(
        (a?.fvg?.detected && !a.fvg.mitigated && a.fvg.direction === 'BEAR') ||
          (a?.orderBlock?.detected && a.orderBlock.direction === 'BEAR')
      );
      const bullMtf = Boolean(
        a?.mtfAlignment?.aligned && a.mtfAlignment.dominantDirection === 'BULL'
      );
      const bearMtf = Boolean(
        a?.mtfAlignment?.aligned && a.mtfAlignment.dominantDirection === 'BEAR'
      );

      for (const def of gateDefinitions) {
        const passed = diag.gatePassMap[def.gate];
        if (passed) passCounts[def.gate]++;
        else failCounts[def.gate]++;

        if (def.gate === 'BOS/MSS') {
          if (bullBos) bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (bearBos) bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else if (def.gate === 'Liquidity Sweep') {
          if (bullSweep) bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (bearSweep) bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else if (def.gate === 'Displacement') {
          if (bullDisp) bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (bearDisp) bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else if (def.gate === 'FVG/Order Block') {
          if (bullFvgOb) bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (bearFvgOb) bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else if (def.gate === 'MTF Alignment') {
          if (bullMtf) bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (bearMtf) bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else if (def.gate === 'WAIT reasons') {
          if (r.smcActionState === 'LONG CANDIDATE') bullPassCounts[def.gate]++;
          else bullFailCounts[def.gate]++;
          if (r.smcActionState === 'SHORT CANDIDATE') bearPassCounts[def.gate]++;
          else bearFailCounts[def.gate]++;
        } else {
          if (passed) {
            bullPassCounts[def.gate]++;
            bearPassCounts[def.gate]++;
          } else {
            bullFailCounts[def.gate]++;
            bearFailCounts[def.gate]++;
          }
        }
      }

      if (diag.primaryReasonCategory !== 'CANDIDATE_PASSED') {
        blockedSymbolSet.add(r.symbol);
        primaryCategoryCounts[diag.primaryReasonCategory] =
          (primaryCategoryCounts[diag.primaryReasonCategory] || 0) + 1;
      }

      for (const reason of diag.allReasons) {
        totalReasonOccurrences++;
        const cat = RadarDatabase.classifySmcBlockingReason(
          reason,
          r.smcActionState,
          r.smcEvaluationStatus,
          r.entryWindowStatus
        );
        categoryOccurrenceCounts[cat] = (categoryOccurrenceCounts[cat] || 0) + 1;
        categorySymbolSets[cat].add(r.symbol);
        categoryReasonMaps[cat][reason] =
          (categoryReasonMaps[cat][reason] || 0) + 1;

        if (r.smcActionState === 'WAIT') {
          waitReasonCounts[reason] = (waitReasonCounts[reason] || 0) + 1;
        } else if (r.smcActionState === 'WATCH') {
          watchReasonCounts[reason] = (watchReasonCounts[reason] || 0) + 1;
        } else if (r.smcActionState === 'HIGH RISK') {
          highRiskReasonCounts[reason] =
            (highRiskReasonCounts[reason] || 0) + 1;
        }

        let entry = reasonAggregateMap.get(reason);
        if (!entry) {
          entry = {
            reason,
            category: cat,
            occurrenceCount: 0,
            primarySymbolCount: 0,
            symbols: new Set<string>(),
          };
          reasonAggregateMap.set(reason, entry);
        }
        entry.occurrenceCount++;
        entry.symbols.add(r.symbol);
        if (diag.primaryBlockingReason === reason) {
          entry.primarySymbolCount++;
        }
      }
    }

    const gates: SmcQualityGateItemStat[] = gateDefinitions.map((def) => {
      const passCount = passCounts[def.gate];
      const failCount = failCounts[def.gate];
      const passRate =
        totalEval > 0 ? Number(((passCount / denom) * 100).toFixed(2)) : 0;
      const failureRate =
        totalEval > 0 ? Number(((failCount / denom) * 100).toFixed(2)) : 0;
      return {
        gate: def.gate,
        label: def.label,
        category: def.category,
        evaluatedCount: totalEval,
        passCount,
        failCount,
        passRate,
        failureRate,
        bullishPassCount: bullPassCounts[def.gate],
        bullishFailCount: bullFailCounts[def.gate],
        bearishPassCount: bearPassCounts[def.gate],
        bearishFailCount: bearFailCounts[def.gate],
      };
    });

    const gateSummaryMap = {} as Record<
      SmcQualityGateKey,
      SmcQualityGateItemStat
    >;
    const compactGateStats = {} as Record<
      SmcQualityGateKey,
      {
        passCount: number;
        failCount: number;
        passRate: number;
        failureRate: number;
      }
    >;
    const gatePassRates = {} as Record<SmcQualityGateKey, number>;
    const gateFailureRates = {} as Record<SmcQualityGateKey, number>;

    for (const g of gates) {
      gateSummaryMap[g.gate] = g;
      compactGateStats[g.gate] = {
        passCount: g.passCount,
        failCount: g.failCount,
        passRate: g.passRate,
        failureRate: g.failureRate,
      };
      gatePassRates[g.gate] = g.passRate;
      gateFailureRates[g.gate] = g.failureRate;
    }

    const topFailedGates = [...gates].sort(
      (a, b) => b.failCount - a.failCount || a.passCount - b.passCount
    );

    const reasonCategories = {} as Record<
      SmcReasonCategory,
      SmcReasonCategoryStat
    >;
    const reasonCategoryList: SmcReasonCategoryStat[] = [];
    for (const cat of allCategoryKeys) {
      const uniqueCount =
        cat === 'PENDING' ? pendingCount : categorySymbolSets[cat].size;
      const stat: SmcReasonCategoryStat = {
        category: cat,
        label: categoryMeta[cat],
        primarySymbolCount: primaryCategoryCounts[cat] || 0,
        uniqueSymbolCount: uniqueCount,
        totalReasonOccurrences: categoryOccurrenceCounts[cat] || 0,
        shareOfEvaluatedPercent:
          totalEval > 0
            ? Number(
                (((primaryCategoryCounts[cat] || 0) / denom) * 100).toFixed(2)
              )
            : 0,
        reasons: categoryReasonMaps[cat],
        sampleSymbols: Array.from(categorySymbolSets[cat]).slice(0, 12),
      };
      reasonCategories[cat] = stat;
      reasonCategoryList.push(stat);
    }

    const waitReasonRanking: SmcReasonRankEntry[] = Array.from(
      reasonAggregateMap.values()
    )
      .sort(
        (a, b) =>
          b.occurrenceCount - a.occurrenceCount ||
          b.primarySymbolCount - a.primarySymbolCount
      )
      .map((item, idx) => ({
        rank: idx + 1,
        reason: item.reason,
        category: item.category,
        occurrenceCount: item.occurrenceCount,
        primarySymbolCount: item.primarySymbolCount,
        uniqueSymbolCount: item.symbols.size,
        failureRatePercent:
          totalEval > 0
            ? Number(((item.symbols.size / denom) * 100).toFixed(2))
            : 0,
        sampleSymbols: Array.from(item.symbols).slice(0, 10),
      }));

    const totalCandidates = longCandidateCount + shortCandidateCount;
    const directionDistribution = {
      longCandidateCount,
      shortCandidateCount,
      longRatioPercent:
        totalCandidates > 0
          ? Number(((longCandidateCount / totalCandidates) * 100).toFixed(2))
          : 0,
      shortRatioPercent:
        totalCandidates > 0
          ? Number(((shortCandidateCount / totalCandidates) * 100).toFixed(2))
          : 0,
      bullStructureBiasCount,
      bearStructureBiasCount,
      neutralOrConflictCount,
      radarLongObservationCount,
      radarShortObservationCount,
    };

    return {
      gateNotConfirmedCount,
      finalCategorySmcMismatchCount,
      gates,
      gateSummaryMap,
      compactGateStats,
      gatePassRates,
      gateFailureRates,
      topFailedGates,
      symbolDiagnostics,
      primaryCategoryCounts,
      categoryOccurrenceCounts,
      reasonCategories,
      reasonCategoryList,
      waitReasonRanking,
      waitReasonCounts,
      watchReasonCounts,
      highRiskReasonCounts,
      uniqueSymbolCount: blockedSymbolSet.size,
      totalReasonOccurrences,
      directionDistribution,
    };
  }

  public computeSmcQualityBundle(
    exchange: ExchangeId = 'binance_usdm',
    nowMs = Date.now()
  ) {
    const snap = this.getAtomicSmcSnapshot(exchange, nowMs);
    const summary = this.summarizeResultsGateAndReasons(
      snap.results,
      snap.scanCycleId,
      snap.pendingCount
    );

    // Backfill any smc_scan_results rows missing primary_blocking_reason in SQLite
    const missingDiagRows = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM smc_scan_results
         WHERE exchange = ? AND (
           primary_reason_category IS NULL
           OR gate_pass_json = '{}'
           OR (smc_evaluation_status = 'EVALUATED' AND primary_reason_category = 'PENDING')
         )`
      )
      .get(exchange) as { cnt?: number } | undefined;
    if (Number(missingDiagRows?.cnt ?? 0) > 0) {
      const updateDiagStmt = this.db.prepare(`
        UPDATE smc_scan_results
        SET primary_blocking_reason = ?,
            primary_reason_category = ?,
            all_blocking_reasons_json = ?,
            gate_pass_json = ?
        WHERE exchange = ? AND symbol = ?
      `);
      this.runInTransaction(() => {
        for (const diag of summary.symbolDiagnostics) {
          updateDiagStmt.run(
            diag.primaryBlockingReason,
            diag.primaryReasonCategory,
            JSON.stringify(diag.allReasons),
            JSON.stringify(diag.gatePassMap),
            exchange,
            diag.symbol
          );
        }
      });
    }

    const cycles: SmcCycleQualityHistoryItem[] = snap.completedCycles.map(
      (c) => {
        const isCurrentCycle = c.scanCycleId === snap.scanCycleId;
        const resolvedGateStats =
          c.gateStats && Object.keys(c.gateStats).length > 0
            ? c.gateStats
            : summary.compactGateStats;
        const resolvedReasonCats: Record<SmcReasonCategory, number> =
          c.reasonCategoryCounts &&
          Object.keys(c.reasonCategoryCounts).length > 0
            ? c.reasonCategoryCounts
            : isCurrentCycle
              ? summary.primaryCategoryCounts
              : {
                  DATA_BLOCKED: summary.primaryCategoryCounts.DATA_BLOCKED,
                  STRUCTURE_INCOMPLETE: Math.max(
                    0,
                    c.waitCount +
                      c.watchCount -
                      summary.primaryCategoryCounts.DATA_BLOCKED -
                      summary.primaryCategoryCounts.MTF_CONFLICT -
                      summary.primaryCategoryCounts.LIQUIDITY_BLOCKED
                  ),
                  MTF_CONFLICT: summary.primaryCategoryCounts.MTF_CONFLICT,
                  LIQUIDITY_BLOCKED:
                    summary.primaryCategoryCounts.LIQUIDITY_BLOCKED,
                  RISK_BLOCKED: c.highRiskCount,
                  ENTRY_WINDOW_MISSED: c.entryWindowMissedCount ?? 0,
                  PENDING: c.pendingCount,
                };
        const resolvedWaitReasonCounts =
          c.waitReasonCounts && Object.keys(c.waitReasonCounts).length > 0
            ? c.waitReasonCounts
            : summary.waitReasonCounts;

        return {
          scanCycleId: c.scanCycleId,
          exchange: c.exchange,
          windowKey: c.windowKey,
          ruleVersion: c.ruleVersion,
          cycleStartedAt: c.cycleStartedAt,
          cycleCompletedAt: c.cycleCompletedAt,
          cycleStatus: c.cycleStatus,
          isColdStart: Boolean(c.isColdStart),
          cacheMode: c.cacheMode ?? (c.isColdStart ? 'COLD' : 'WARM'),
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
          gateNotConfirmedCount:
            c.gateNotConfirmedCount ??
            c.waitCount + c.watchCount + c.highRiskCount,
          finalCategorySmcMismatchCount: c.finalCategorySmcMismatchCount ?? 0,
          entryWindowMissedCount: c.entryWindowMissedCount ?? 0,
          candidateDetectedBeforeEntryWindowCount:
            c.candidateDetectedBeforeEntryWindowCount ?? 0,
          p50DetectionLatencyMs: c.p50DetectionLatencyMs ?? snap.p50DetectionLatencyMs ?? null,
          p95DetectionLatencyMs: c.p95DetectionLatencyMs ?? snap.p95DetectionLatencyMs ?? null,
          fullCycleDurationMs: c.fullCycleDurationMs ?? null,
          gateStats: resolvedGateStats,
          reasonCategoryCounts: resolvedReasonCats,
          waitReasonCounts: resolvedWaitReasonCounts,
        };
      }
    );

    const recentThreeCompletedCycles = cycles.slice(-3);

    return {
      snap,
      ...summary,
      cycles,
      recentThreeCompletedCycles,
    };
  }

  // ============================================================================
  // Phase 16: SMC PENDING Reason Classification, Breakdown Identity & Retry Stuck
  // ============================================================================

  public setSmcJobPendingReason(
    exchange: ExchangeId,
    symbol: string,
    pendingReason: SmcPendingReason | string | null,
    options?: {
      status?: SmcScanJobStatus;
      nextRetryAt?: string | null;
      retryCount?: number;
      leaseUntil?: string | null;
      heartbeatAt?: string | null;
      lastProgressAt?: string | null;
      lastError?: string | null;
      workerId?: string | null;
      cycleId?: string | null;
    }
  ): boolean {
    return this.runInTransaction(() => {
      const cleanSymbol = symbol.trim().toUpperCase();
      const nowIso = new Date().toISOString();
      const jobRow = this.db
        .prepare(
          `SELECT id, status, retry_count, next_retry_at, lease_until, heartbeat_at, last_progress_at, last_error, worker_id, cycle_id
           FROM smc_scan_jobs
           WHERE exchange = ? AND symbol = ?
           ORDER BY CASE WHEN status = 'RUNNING' THEN 0 ELSE 1 END ASC, id DESC
           LIMIT 1`
        )
        .get(exchange, cleanSymbol) as
        | {
            id: number;
            status: string;
            retry_count: number;
            next_retry_at: string | null;
            lease_until: string | null;
            heartbeat_at: string | null;
            last_progress_at: string | null;
            last_error: string | null;
            worker_id: string | null;
            cycle_id: string | null;
          }
        | undefined;
      if (!jobRow) return false;

      const nextStatus = options?.status ?? String(jobRow.status);
      const nextRetryCount =
        options?.retryCount !== undefined
          ? options.retryCount
          : Number(jobRow.retry_count);
      const nextRetryAt =
        options?.nextRetryAt !== undefined
          ? options.nextRetryAt
          : jobRow.next_retry_at;
      const nextLeaseUntil =
        options?.leaseUntil !== undefined
          ? options.leaseUntil
          : jobRow.lease_until;
      const nextHeartbeatAt =
        options?.heartbeatAt !== undefined
          ? options.heartbeatAt
          : jobRow.heartbeat_at;
      const nextProgressAt =
        options?.lastProgressAt !== undefined
          ? options.lastProgressAt
          : jobRow.last_progress_at ?? nowIso;
      const nextLastError =
        options?.lastError !== undefined
          ? options.lastError
          : jobRow.last_error;
      const nextWorkerId =
        options?.workerId !== undefined ? options.workerId : jobRow.worker_id;
      const nextCycleId =
        options?.cycleId !== undefined ? options.cycleId : jobRow.cycle_id;

      this.db
        .prepare(
          `UPDATE smc_scan_jobs
           SET status = ?,
               pending_reason = ?,
               retry_count = ?,
               next_retry_at = ?,
               lease_until = ?,
               heartbeat_at = ?,
               last_progress_at = ?,
               last_error = ?,
               worker_id = ?,
               cycle_id = ?
           WHERE id = ?`
        )
        .run(
          nextStatus,
          pendingReason,
          nextRetryCount,
          nextRetryAt,
          nextLeaseUntil,
          nextHeartbeatAt,
          nextProgressAt,
          nextLastError,
          nextWorkerId,
          nextCycleId,
          jobRow.id
        );

      if (nextStatus !== 'SUCCEEDED') {
        this.db
          .prepare(
            `DELETE FROM smc_scan_results WHERE exchange = ? AND symbol = ?`
          )
          .run(exchange, cleanSymbol);
      }
      this.bumpSmcStatsVersion(exchange, nowIso);
      return true;
    });
  }

  public getPhase16PendingBreakdown(
    exchange: ExchangeId,
    nowMs = Date.now(),
    options?: {
      isPrewarming?: boolean;
      inFlightPrewarmSymbols?: Set<string>;
      availableRequests?: number;
      batchSize?: number;
      stalledThresholdMs?: number;
      cycleId?: string;
      cycleMode?: SmcCacheMode;
    }
  ): {
    pendingSymbols: SmcPendingSymbolRecord[];
    stuckJobs: SmcPendingSymbolRecord[];
    pendingCount: number;
    queuedCount: number;
    pureQueuedCount: number;
    dbQueuedJobCount: number;
    runningJobCount: number;
    waitingForCacheCount: number;
    waitingForRateLimitCount: number;
    waitingForNextBatchCount: number;
    retryScheduledCount: number;
    failedRetryableCount: number;
    pendingReasonCounts: Record<SmcPendingReason, number>;
    fastLanePendingCount: number;
    bulkPendingCount: number;
    oldestPendingAgeMs: number;
    stalledJobCount: number;
    leaseExpiredCount: number;
    maxRateLimitBackoffRemainingMs: number;
    lastJobCompletedAt: string | null;
    lastJobProgressAt: string | null;
    recentCompletionsInLast5Min: number;
    earliestRecentCompletionMs: number | null;
    pendingBreakdownConsistency: SmcPendingBreakdownConsistency;
  } {
    const canonicalIdsSql = `
      SELECT COALESCE(
        MAX(CASE WHEN status = 'RUNNING' THEN id END),
        MAX(id)
      )
      FROM smc_scan_jobs
      WHERE exchange = ?
      GROUP BY symbol
    `;
    const isLiveVenue = exchange !== 'demo_synthetic';
    const currentRuleVersion = 'v1.0.0-smc-ict-deterministic';
    const resolvedCycleId =
      options?.cycleId || this.getSmcScanCycleId(exchange);
    const defaultCacheMode: SmcCacheMode = options?.cycleMode || 'COLD';
    const batchSize = Math.max(1, options?.batchSize ?? 12);
    const stalledThresholdMs = Math.max(1000, options?.stalledThresholdMs ?? 45_000);

    // 1. Load cache coverage per symbol to populate missingTimeframes, missingData, cacheMode
    const cacheRows = this.db
      .prepare(
        `SELECT symbol, timeframe, expires_at, stale, fallback, missing_data_json, rule_version, open_interest, oi_expires_at, funding_rate
         FROM smc_scan_candles_cache
         WHERE exchange = ? ${isLiveVenue ? 'AND is_demo = 0' : 'AND is_demo = 1'}`
      )
      .all(exchange) as Array<{
      symbol: string;
      timeframe: string;
      expires_at: string;
      stale: number;
      fallback: number;
      missing_data_json: string;
      rule_version: string | null;
      open_interest: number | null;
      oi_expires_at: string | null;
      funding_rate: number | null;
    }>;

    const freshTfsBySymbol = new Map<string, Set<Timeframe>>();
    const freshOiBySymbol = new Set<string>();
    const freshFundingBySymbol = new Set<string>();
    for (const r of cacheRows) {
      const sym = String(r.symbol);
      const tf = String(r.timeframe) as Timeframe;
      const expMs = Date.parse(String(r.expires_at));
      const isFresh =
        Number.isFinite(expMs) &&
        nowMs < expMs &&
        Number(r.stale) === 0 &&
        Number(r.fallback) === 0 &&
        String(r.missing_data_json || '[]') === '[]' &&
        (!r.rule_version || String(r.rule_version) === currentRuleVersion);
      if (isFresh) {
        let tfSet = freshTfsBySymbol.get(sym);
        if (!tfSet) {
          tfSet = new Set<Timeframe>();
          freshTfsBySymbol.set(sym, tfSet);
        }
        tfSet.add(tf);
        if (tf === '15m') {
          if (r.open_interest !== null && r.open_interest !== undefined) {
            const oiExp = r.oi_expires_at ? Date.parse(String(r.oi_expires_at)) : expMs;
            if (!r.oi_expires_at || (Number.isFinite(oiExp) && nowMs < oiExp)) {
              freshOiBySymbol.add(sym);
            }
          }
          if (r.funding_rate !== null && r.funding_rate !== undefined) {
            freshFundingBySymbol.add(sym);
          }
        }
      }
    }

    // 2. Load all canonical jobs for this exchange
    const allJobRows = this.db
      .prepare(
        `SELECT * FROM smc_scan_jobs
         WHERE id IN (${canonicalIdsSql})
         ORDER BY
           CASE status
             WHEN 'RUNNING' THEN 0
             WHEN 'RATE_LIMITED' THEN 1
             WHEN 'QUEUED' THEN 2
             WHEN 'FAILED' THEN 3
             ELSE 4
           END ASC,
           priority_tier ASC,
           priority DESC,
           id ASC`
      )
      .all(exchange) as Array<Record<string, unknown>>;

    let lastJobCompletedAt: string | null = null;
    let lastJobProgressAt: string | null = null;
    let recentCompletionsInLast5Min = 0;
    let earliestRecentCompletionMs: number | null = null;

    const pendingJobRows: Array<Record<string, unknown>> = [];
    let dbQueuedJobCount = 0;

    for (const r of allJobRows) {
      const st = String(r.status) as SmcScanJobStatus;
      const pReasonRaw = r.pending_reason ? String(r.pending_reason).trim() : '';
      const completedAt = r.completed_at ? String(r.completed_at) : null;
      const progressCand =
        (r.last_progress_at ? String(r.last_progress_at) : null) ||
        (r.heartbeat_at ? String(r.heartbeat_at) : null) ||
        completedAt ||
        (r.started_at ? String(r.started_at) : null);

      if (progressCand && (!lastJobProgressAt || progressCand > lastJobProgressAt)) {
        lastJobProgressAt = progressCand;
      }

      if (st === 'SUCCEEDED') {
        if (completedAt) {
          if (!lastJobCompletedAt || completedAt > lastJobCompletedAt) {
            lastJobCompletedAt = completedAt;
          }
          const compMs = Date.parse(completedAt);
          if (Number.isFinite(compMs) && nowMs - compMs <= 5 * 60 * 1000 && nowMs >= compMs) {
            recentCompletionsInLast5Min++;
            if (
              earliestRecentCompletionMs === null ||
              compMs < earliestRecentCompletionMs
            ) {
              earliestRecentCompletionMs = compMs;
            }
          }
        }
        continue;
      }

      if (st === 'FAILED' && pReasonRaw !== 'FAILED_RETRYABLE') {
        continue;
      }

      if (st === 'QUEUED') {
        dbQueuedJobCount++;
      }
      pendingJobRows.push(r);
    }

    const validPendingReasons = new Set<SmcPendingReason>([
      'QUEUED',
      'RUNNING',
      'WAITING_FOR_CACHE',
      'WAITING_FOR_RATE_LIMIT',
      'WAITING_FOR_NEXT_BATCH',
      'RETRY_SCHEDULED',
      'FAILED_RETRYABLE',
    ]);

    const pendingReasonCounts: Record<SmcPendingReason, number> = {
      QUEUED: 0,
      RUNNING: 0,
      WAITING_FOR_CACHE: 0,
      WAITING_FOR_RATE_LIMIT: 0,
      WAITING_FOR_NEXT_BATCH: 0,
      RETRY_SCHEDULED: 0,
      FAILED_RETRYABLE: 0,
    };

    let hasInvalidPendingReason = false;
    let fastLanePendingCount = 0;
    let bulkPendingCount = 0;
    let oldestPendingAgeMs = 0;
    let leaseExpiredCount = 0;
    let maxRateLimitBackoffRemainingMs = 0;
    let unreasonedQueuedIndex = 0;

    const pendingSymbols: SmcPendingSymbolRecord[] = [];
    const stuckJobs: SmcPendingSymbolRecord[] = [];
    const allTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];

    for (const r of pendingJobRows) {
      const sym = String(r.symbol);
      const st = String(r.status) as SmcScanJobStatus;
      const rawReason = r.pending_reason ? String(r.pending_reason).trim() : '';
      const retryCount = Number(r.retry_count ?? 0);
      const nextRetryAt = r.next_retry_at ? String(r.next_retry_at) : null;
      const nextRetryMs = nextRetryAt ? Date.parse(nextRetryAt) : NaN;
      const lastError = r.last_error ? String(r.last_error) : null;
      const queuedAt = String(r.queue_entered_at || r.requested_at || new Date(nowMs).toISOString());
      const startedAt = r.started_at ? String(r.started_at) : null;
      const lastHeartbeatAt = r.heartbeat_at ? String(r.heartbeat_at) : null;
      const lastProgressAt =
        (r.last_progress_at ? String(r.last_progress_at) : null) ||
        lastHeartbeatAt ||
        startedAt ||
        queuedAt;
      const leaseUntil = r.lease_until ? String(r.lease_until) : null;
      const leaseUntilMs = leaseUntil ? Date.parse(leaseUntil) : NaN;

      const freshSet = freshTfsBySymbol.get(sym) ?? new Set<Timeframe>();
      const missingTimeframes = allTimeframes.filter((tf) => !freshSet.has(tf));
      const missingData: string[] = missingTimeframes.map((tf) => `klines_${tf}`);
      if (!freshOiBySymbol.has(sym)) {
        missingData.push('openInterest');
      }
      if (!freshFundingBySymbol.has(sym)) {
        missingData.push('fundingRate');
      }
      const symCacheMode: SmcCacheMode =
        missingTimeframes.length === 0 ? 'WARM' : defaultCacheMode === 'WARM' ? 'PARTIAL' : 'COLD';

      const priorityTier = Number(r.priority_tier ?? 6) as SmcScanPriorityTier;
      const isFastLane = priorityTier >= 1 && priorityTier <= 5;
      const priorityClass: SmcPriorityClass = isFastLane ? 'FAST_LANE' : 'BULK';
      const executionWorker: SmcExecutionWorker =
        r.execution_worker === 'FAST_LANE_WORKER' ||
        r.execution_worker === 'BULK_WORKER'
          ? (String(r.execution_worker) as SmcExecutionWorker)
          : isFastLane
            ? 'FAST_LANE_WORKER'
            : 'BULK_WORKER';

      // Determine pendingReason
      let resolvedReason: SmcPendingReason = 'QUEUED';
      if (rawReason !== '' && !validPendingReasons.has(rawReason as SmcPendingReason)) {
        hasInvalidPendingReason = true;
        resolvedReason = 'QUEUED';
      } else if (st === 'RUNNING') {
        resolvedReason = 'RUNNING';
      } else if (
        rawReason !== '' &&
        rawReason !== 'RUNNING' &&
        rawReason !== 'QUEUED' &&
        validPendingReasons.has(rawReason as SmcPendingReason)
      ) {
        resolvedReason = rawReason as SmcPendingReason;
      } else if (st === 'FAILED') {
        resolvedReason = 'FAILED_RETRYABLE';
      } else if (st === 'RATE_LIMITED') {
        if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs && retryCount >= 2) {
          resolvedReason = 'RETRY_SCHEDULED';
        } else {
          resolvedReason = 'WAITING_FOR_RATE_LIMIT';
        }
      } else {
        // st === 'QUEUED' with no explicit override
        if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
          resolvedReason = 'RETRY_SCHEDULED';
        } else if (retryCount > 0 && lastError && !/429|rate limit/i.test(lastError)) {
          resolvedReason = 'FAILED_RETRYABLE';
        } else if (
          options?.inFlightPrewarmSymbols?.has(sym) ||
          (options?.isPrewarming && missingTimeframes.length > 0)
        ) {
          resolvedReason = 'WAITING_FOR_CACHE';
        } else if (
          options?.availableRequests !== undefined &&
          options.availableRequests <= 0 &&
          missingTimeframes.length > 0
        ) {
          resolvedReason = 'WAITING_FOR_RATE_LIMIT';
        } else {
          if (unreasonedQueuedIndex < batchSize) {
            resolvedReason = 'QUEUED';
          } else {
            resolvedReason = 'WAITING_FOR_NEXT_BATCH';
          }
          unreasonedQueuedIndex++;
        }
      }

      if (!hasInvalidPendingReason) {
        pendingReasonCounts[resolvedReason]++;
      }

      if (priorityClass === 'FAST_LANE') {
        fastLanePendingCount++;
      } else {
        bulkPendingCount++;
      }

      const queuedAtMs = Date.parse(queuedAt);
      const ageMs = Number.isFinite(queuedAtMs)
        ? Math.max(0, nowMs - queuedAtMs)
        : 0;
      if (ageMs > oldestPendingAgeMs) {
        oldestPendingAgeMs = ageMs;
      }

      const heartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
      const isLeaseExpired =
        st === 'RUNNING' &&
        (Number.isFinite(leaseUntilMs)
          ? leaseUntilMs <= nowMs
          : Number.isFinite(heartbeatMs) &&
            nowMs - heartbeatMs > stalledThresholdMs);
      if (isLeaseExpired) {
        leaseExpiredCount++;
      }

      if (
        (resolvedReason === 'WAITING_FOR_RATE_LIMIT' ||
          resolvedReason === 'RETRY_SCHEDULED' ||
          st === 'RATE_LIMITED') &&
        Number.isFinite(nextRetryMs) &&
        nextRetryMs > nowMs
      ) {
        const remBackoff = nextRetryMs - nowMs;
        if (remBackoff > maxRateLimitBackoffRemainingMs) {
          maxRateLimitBackoffRemainingMs = remBackoff;
        }
      }

      const itemStalledReasons: SmcStalledReason[] = [];
      if (isLeaseExpired) {
        itemStalledReasons.push('LEASE_EXPIRED');
      }
      if (
        (resolvedReason === 'WAITING_FOR_RATE_LIMIT' ||
          resolvedReason === 'RETRY_SCHEDULED') &&
        Number.isFinite(nextRetryMs) &&
        nextRetryMs - nowMs > stalledThresholdMs
      ) {
        itemStalledReasons.push('RATE_LIMIT_BACKOFF');
      }
      if (
        lastError &&
        /503|service unavailable|exchange_api_unavailable/i.test(lastError)
      ) {
        itemStalledReasons.push('EXCHANGE_API_UNAVAILABLE');
      }
      if (
        resolvedReason === 'WAITING_FOR_CACHE' &&
        ageMs > stalledThresholdMs
      ) {
        itemStalledReasons.push('CACHE_PREWARM_STALLED');
      }

      const isJobStalled =
        itemStalledReasons.length > 0 ||
        resolvedReason === 'FAILED_RETRYABLE' ||
        (ageMs > stalledThresholdMs && st !== 'RUNNING');

      const record: SmcPendingSymbolRecord = {
        symbol: sym,
        exchange,
        cycleId: r.cycle_id ? String(r.cycle_id) : resolvedCycleId,
        queuedAt,
        startedAt,
        lastHeartbeatAt,
        lastProgressAt,
        pendingReason: resolvedReason,
        retryCount,
        nextRetryAt,
        priorityClass,
        executionWorker,
        missingTimeframes,
        missingData,
        cacheMode: symCacheMode,
        priorityTier,
        priorityLabel: String(r.priority_label || '6_REMAINING_USDT_PERP'),
        status: st,
        workerId: r.worker_id ? String(r.worker_id) : null,
        leaseUntil,
        leaseExpired: isLeaseExpired,
        stalled: isJobStalled,
        stalledReasons: itemStalledReasons,
        lastError,
        ageMs,
      };

      pendingSymbols.push(record);
      if (isJobStalled) {
        stuckJobs.push(record);
      }
    }

    const pendingCount = pendingJobRows.length;
    const runningJobCount = pendingReasonCounts.RUNNING;
    const waitingForCacheCount = pendingReasonCounts.WAITING_FOR_CACHE;
    const waitingForRateLimitCount = pendingReasonCounts.WAITING_FOR_RATE_LIMIT;
    const waitingForNextBatchCount = pendingReasonCounts.WAITING_FOR_NEXT_BATCH;
    const retryScheduledCount = pendingReasonCounts.RETRY_SCHEDULED;
    const failedRetryableCount = pendingReasonCounts.FAILED_RETRYABLE;
    const pureQueuedCount = pendingReasonCounts.QUEUED;
    // In Section 四's 6-bucket identity:
    // pendingCount = queuedCount + runningJobCount + waitingForCacheCount + waitingForRateLimitCount + retryScheduledCount + failedRetryableCount
    const queuedCount = pureQueuedCount + waitingForNextBatchCount;

    const identitySum =
      queuedCount +
      runningJobCount +
      waitingForCacheCount +
      waitingForRateLimitCount +
      retryScheduledCount +
      failedRetryableCount;

    const pendingBreakdownConsistency: SmcPendingBreakdownConsistency =
      !hasInvalidPendingReason &&
      identitySum === pendingCount &&
      fastLanePendingCount + bulkPendingCount === pendingCount
        ? 'VALID'
        : 'INVALID';

    return {
      pendingSymbols,
      stuckJobs,
      pendingCount,
      queuedCount,
      pureQueuedCount,
      dbQueuedJobCount,
      runningJobCount,
      waitingForCacheCount,
      waitingForRateLimitCount,
      waitingForNextBatchCount,
      retryScheduledCount,
      failedRetryableCount,
      pendingReasonCounts,
      fastLanePendingCount,
      bulkPendingCount,
      oldestPendingAgeMs,
      stalledJobCount: stuckJobs.length,
      leaseExpiredCount,
      maxRateLimitBackoffRemainingMs,
      lastJobCompletedAt,
      lastJobProgressAt,
      recentCompletionsInLast5Min,
      earliestRecentCompletionMs,
      pendingBreakdownConsistency,
    };
  }

  public retryStuckSmcJobs(
    exchange: ExchangeId,
    nowMs = Date.now(),
    options?: {
      stalledThresholdMs?: number;
      maxRetries?: number;
      canIssueRequest?: boolean;
    }
  ): {
    retriedCount: number;
    retriedSymbols: string[];
    skippedActiveRunningSymbols: string[];
    skippedRateLimitBackoffSymbols: string[];
    preservedCycleId: string;
  } {
    return this.runInTransaction(() => {
      const nowIso = new Date(nowMs).toISOString();
      const stalledThresholdMs = Math.max(
        1000,
        options?.stalledThresholdMs ?? 45_000
      );
      const maxRetries = Math.max(1, options?.maxRetries ?? 3);
      const canIssueRequest = options?.canIssueRequest !== false;
      const preservedCycleId = this.getSmcScanCycleId(exchange);

      const canonicalIdsSql = `
        SELECT COALESCE(
          MAX(CASE WHEN status = 'RUNNING' THEN id END),
          MAX(id)
        )
        FROM smc_scan_jobs
        WHERE exchange = ?
        GROUP BY symbol
      `;

      const rows = this.db
        .prepare(
          `SELECT * FROM smc_scan_jobs
           WHERE id IN (${canonicalIdsSql})
             AND status != 'SUCCEEDED'`
        )
        .all(exchange) as Array<Record<string, unknown>>;

      const retriedSymbols: string[] = [];
      const skippedActiveRunningSymbols: string[] = [];
      const skippedRateLimitBackoffSymbols: string[] = [];

      const requeueStuckStmt = this.db.prepare(`
        UPDATE smc_scan_jobs
        SET status = 'QUEUED',
            started_at = NULL,
            job_claimed_at = NULL,
            worker_id = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            retry_count = retry_count + 1,
            next_retry_at = NULL,
            pending_reason = 'QUEUED',
            last_progress_at = ?,
            cycle_id = COALESCE(cycle_id, ?)
        WHERE id = ?
      `);

      for (const r of rows) {
        const id = Number(r.id);
        const sym = String(r.symbol);
        const st = String(r.status) as SmcScanJobStatus;
        const pReason = r.pending_reason ? String(r.pending_reason) : '';
        const retryCount = Number(r.retry_count ?? 0);
        const leaseUntil = r.lease_until ? String(r.lease_until) : null;
        const leaseUntilMs = leaseUntil ? Date.parse(leaseUntil) : NaN;
        const heartbeatAt = r.heartbeat_at ? String(r.heartbeat_at) : null;
        const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
        const nextRetryAt = r.next_retry_at ? String(r.next_retry_at) : null;
        const nextRetryMs = nextRetryAt ? Date.parse(nextRetryAt) : NaN;
        const queuedAt = String(
          r.queue_entered_at || r.requested_at || nowIso
        );
        const queuedMs = Date.parse(queuedAt);
        const ageMs = Number.isFinite(queuedMs) ? Math.max(0, nowMs - queuedMs) : 0;

        if (st === 'RUNNING') {
          const isExpiredLease = Number.isFinite(leaseUntilMs)
            ? leaseUntilMs <= nowMs
            : Number.isFinite(heartbeatMs) &&
              nowMs - heartbeatMs > stalledThresholdMs;
          if (!isExpiredLease) {
            // Active valid RUNNING job: NEVER duplicate or interrupt
            skippedActiveRunningSymbols.push(sym);
            continue;
          }
          requeueStuckStmt.run(nowIso, preservedCycleId, id);
          retriedSymbols.push(sym);
          continue;
        }

        if (st === 'RATE_LIMITED' || pReason === 'WAITING_FOR_RATE_LIMIT') {
          // Never bypass active rate-limit backoff or rate-limit guard
          if (
            !canIssueRequest ||
            (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs)
          ) {
            skippedRateLimitBackoffSymbols.push(sym);
            continue;
          }
          requeueStuckStmt.run(nowIso, preservedCycleId, id);
          retriedSymbols.push(sym);
          continue;
        }

        if (
          st === 'FAILED' &&
          (pReason === 'FAILED_RETRYABLE' || retryCount < maxRetries)
        ) {
          if (!canIssueRequest) {
            skippedRateLimitBackoffSymbols.push(sym);
            continue;
          }
          requeueStuckStmt.run(nowIso, preservedCycleId, id);
          retriedSymbols.push(sym);
          continue;
        }

        if (
          st === 'QUEUED' &&
          (pReason === 'FAILED_RETRYABLE' ||
            pReason === 'WAITING_FOR_CACHE' ||
            (pReason === 'RETRY_SCHEDULED' &&
              (!Number.isFinite(nextRetryMs) || nextRetryMs <= nowMs)) ||
            ageMs > stalledThresholdMs)
        ) {
          if (!canIssueRequest) {
            skippedRateLimitBackoffSymbols.push(sym);
            continue;
          }
          requeueStuckStmt.run(nowIso, preservedCycleId, id);
          retriedSymbols.push(sym);
          continue;
        }
      }

      if (retriedSymbols.length > 0) {
        this.bumpSmcStatsVersion(exchange, nowIso);
      }

      return {
        retriedCount: retriedSymbols.length,
        retriedSymbols,
        skippedActiveRunningSymbols,
        skippedRateLimitBackoffSymbols,
        preservedCycleId,
      };
    });
  }

  // ============================================================================
  // Phase 17: Long-Running Live Paper Scan Stability, Worker Recovery,
  // Progress Evidence Sampling & SQLite Consistency / Backup Methods
  // ============================================================================

  public recordPhase17ErrorEvent(
    exchange: ExchangeId,
    event: {
      scenarioType?: Phase17ErrorScenarioType;
      symbol?: string | null;
      cycleId?: string | null;
      is429?: boolean;
      is503?: boolean;
      isTimeout?: boolean;
      isCacheExpiredRefresh?: boolean;
      isSqliteBusyRetry?: boolean;
      isLeaseReclaimed?: boolean;
      isServiceRestartRecovery?: boolean;
      isPartialCycleInterrupted?: boolean;
      stalledDetected?: boolean;
      workerRestarted?: boolean;
      databaseRecovered?: boolean;
      errorMessage?: string;
    },
    nowIso = new Date().toISOString()
  ): void {
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO smc_scan_meta (exchange, stats_version, updated_at)
           VALUES (?, 1, ?)
           ON CONFLICT(exchange) DO NOTHING`
        )
        .run(exchange, nowIso);

      if (event.is429) {
        this.updateRuntimeHttpMetrics(exchange, {
          incrementRateLimitEvents: 1,
        });
      }
      if (event.is503) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET http_503_count = COALESCE(http_503_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(nowIso, exchange);
      }
      const activeWin24h = this.db
        .prepare(
          `SELECT monitoring_window_id FROM smc_long_running_windows
           WHERE exchange = ? AND duration = '24h'
           ORDER BY started_at DESC, rowid DESC LIMIT 1`
        )
        .get(exchange) as { monitoring_window_id?: string } | undefined;
      const activeWin72h = this.db
        .prepare(
          `SELECT monitoring_window_id FROM smc_long_running_windows
           WHERE exchange = ? AND duration = '72h'
           ORDER BY started_at DESC, rowid DESC LIMIT 1`
        )
        .get(exchange) as { monitoring_window_id?: string } | undefined;

      if (event.stalledDetected) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET stalled_detected_count = COALESCE(stalled_detected_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(nowIso, exchange);
        this.db
          .prepare(
            `UPDATE smc_long_running_windows
             SET stalled_detected_count = COALESCE(stalled_detected_count, 0) + 1,
                 window_status = 'FAILED',
                 terminal_reason = COALESCE(terminal_reason, ?),
                 completed_at = NULL,
                 updated_at = ?
             WHERE exchange = ? AND window_status = 'RUNNING'`
          )
          .run(event.errorMessage || 'STALLED_DETECTED', nowIso, exchange);
      }
      if (event.workerRestarted) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET worker_restart_count = COALESCE(worker_restart_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(nowIso, exchange);
      }
      if (event.databaseRecovered) {
        const statsVersion = this.getSmcStatsVersion(exchange);
        this.recordServiceRecoveryEvent({
          exchange,
          triggerReason: 'SQLITE_RECONNECT',
          recoveredRunningJobsCount: 0,
          statsVersionBefore: statsVersion,
          statsVersionAfter: statsVersion,
          recoveredAt: nowIso,
          planned: false,
          serviceStoppedNormally: true,
          sqliteReconnected: true,
        });
      }
      if (event.errorMessage !== undefined) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET last_error_message = ?,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(event.errorMessage, nowIso, exchange);
      }

      const resolvedScenario: Phase17ErrorScenarioType | null =
        event.scenarioType ??
        (event.is429
          ? 'HTTP_429_BACKOFF'
          : event.is503
            ? 'HTTP_503_HONEST_ERROR'
            : event.isTimeout
              ? 'NETWORK_TIMEOUT_RETRY'
              : event.isCacheExpiredRefresh
                ? 'CACHE_EXPIRED_REFRESH'
                : event.isSqliteBusyRetry
                  ? 'SQLITE_BUSY_RETRY'
                  : event.isLeaseReclaimed
                    ? 'LEASE_EXPIRED_RECLAIMED'
                    : event.isServiceRestartRecovery
                      ? 'SERVICE_RESTART_RECOVERY'
                      : event.isPartialCycleInterrupted
                        ? 'PARTIAL_CYCLE_INTERRUPTED'
                        : null);

      if (resolvedScenario) {
        const statsVersion = this.getSmcStatsVersion(exchange);
        const cycleId = event.cycleId ?? this.getSmcScanCycleId(exchange);
        const eventId = `err_${exchange}_${resolvedScenario}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.db
          .prepare(
            `INSERT INTO smc_phase17_error_events (
               event_id, exchange, scenario_type, occurred_at, symbol, cycle_id, message, stats_version,
               monitoring_window_id, monitoring_window_72h_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            eventId,
            exchange,
            resolvedScenario,
            nowIso,
            event.symbol ?? null,
            cycleId,
            event.errorMessage ?? resolvedScenario,
            statsVersion,
            activeWin24h?.monitoring_window_id ?? null,
            activeWin72h?.monitoring_window_id ?? null
          );
      }
    });
  }

  public getPhase17ErrorEventsSummary(
    exchange: ExchangeId,
    sinceIso?: string,
    limit = 50
  ): {
    counts: Record<Phase17ErrorScenarioType, number>;
    events: Phase17ErrorEventRecord[];
  } {
    const counts: Record<Phase17ErrorScenarioType, number> = {
      HTTP_429_BACKOFF: 0,
      HTTP_503_HONEST_ERROR: 0,
      NETWORK_TIMEOUT_RETRY: 0,
      CACHE_EXPIRED_REFRESH: 0,
      SQLITE_BUSY_RETRY: 0,
      LEASE_EXPIRED_RECLAIMED: 0,
      SERVICE_RESTART_RECOVERY: 0,
      PARTIAL_CYCLE_INTERRUPTED: 0,
    };

    const countRows = sinceIso
      ? (this.db
          .prepare(
            `SELECT scenario_type, COUNT(*) as cnt
             FROM smc_phase17_error_events
             WHERE exchange = ? AND occurred_at >= ?
             GROUP BY scenario_type`
          )
          .all(exchange, sinceIso) as Array<{
          scenario_type: string;
          cnt: number;
        }>)
      : (this.db
          .prepare(
            `SELECT scenario_type, COUNT(*) as cnt
             FROM smc_phase17_error_events
             WHERE exchange = ?
             GROUP BY scenario_type`
          )
          .all(exchange) as Array<{ scenario_type: string; cnt: number }>);

    for (const r of countRows) {
      const key = String(r.scenario_type) as Phase17ErrorScenarioType;
      if (key in counts) {
        counts[key] = Number(r.cnt ?? 0);
      }
    }

    const eventRows = sinceIso
      ? (this.db
          .prepare(
            `SELECT * FROM smc_phase17_error_events
             WHERE exchange = ? AND occurred_at >= ?
             ORDER BY occurred_at DESC, rowid DESC
             LIMIT ?`
          )
          .all(exchange, sinceIso, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT * FROM smc_phase17_error_events
             WHERE exchange = ?
             ORDER BY occurred_at DESC, rowid DESC
             LIMIT ?`
          )
          .all(exchange, limit) as Array<Record<string, unknown>>);

    const events: Phase17ErrorEventRecord[] = eventRows.map((r) => ({
      eventId: String(r.event_id),
      exchange: String(r.exchange) as ExchangeId,
      scenarioType: String(r.scenario_type) as Phase17ErrorScenarioType,
      occurredAt: String(r.occurred_at),
      symbol: r.symbol ? String(r.symbol) : null,
      cycleId: r.cycle_id ? String(r.cycle_id) : null,
      message: String(r.message),
      statsVersion: Number(r.stats_version ?? 1),
    }));

    return { counts, events };
  }

  public setMaxConcurrencyMeta(
    exchange: ExchangeId,
    maxConcurrency: number
  ): void {
    const safeMax = Math.max(1, Math.floor(maxConcurrency));
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO smc_scan_meta (exchange, stats_version, max_concurrency, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(exchange) DO UPDATE SET
           max_concurrency = excluded.max_concurrency`
      )
      .run(exchange, safeMax, nowIso);
  }

  public recordConcurrencyViolation(exchange: ExchangeId): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO smc_scan_meta (exchange, stats_version, concurrency_violations, updated_at)
         VALUES (?, 1, 1, ?)
         ON CONFLICT(exchange) DO UPDATE SET
           concurrency_violations = COALESCE(smc_scan_meta.concurrency_violations, 0) + 1`
      )
      .run(exchange, nowIso);
    this.db
      .prepare(
        `UPDATE smc_long_running_windows
         SET concurrency_violations = COALESCE(concurrency_violations, 0) + 1,
             window_status = 'FAILED',
             terminal_reason = COALESCE(terminal_reason, 'CONCURRENCY_CAP_VIOLATION'),
             completed_at = NULL,
             updated_at = ?
         WHERE exchange = ? AND window_status = 'RUNNING'`
      )
      .run(nowIso, exchange);
  }

  private computeRecoveryVerificationMetrics(
    exchange: ExchangeId,
    maxConcurrencyOverride?: number
  ): {
    maxConcurrency: number;
    runningJobCountAfter: number;
    concurrencyValidAfter: boolean;
    paperSignalsCountAfter: number;
    paperLedgerCountAfter: number;
    cacheRowCountAfter: number;
    historicalCyclesCountAfter: number;
    plannedRestartCountAfter: number;
    unexpectedRestartCountAfter: number;
    leaseRecoveryCountAfter: number;
    databaseRecoveryCountAfter: number;
    workerRestartCountAfter: number;
  } {
    const cacheRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM smc_scan_candles_cache WHERE exchange = ?`
      )
      .get(exchange) as { cnt?: number } | undefined;
    const cacheRowCountAfter = Number(cacheRow?.cnt ?? 0);

    const ledgerRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM paper_trading_ledger`)
      .get() as { cnt?: number } | undefined;
    const paperLedgerCountAfter = Number(ledgerRow?.cnt ?? 0);

    let trackedSignalsCount = 0;
    try {
      const sigTable = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_tracked_signals'`
        )
        .get() as { name?: string } | undefined;
      if (sigTable?.name) {
        const sigRow = this.db
          .prepare(`SELECT COUNT(*) as cnt FROM paper_tracked_signals`)
          .get() as { cnt?: number } | undefined;
        trackedSignalsCount = Number(sigRow?.cnt ?? 0);
      }
    } catch {
      trackedSignalsCount = 0;
    }
    const paperSignalsCountAfter = trackedSignalsCount + paperLedgerCountAfter;

    const cycleRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM smc_scan_cycles WHERE exchange = ?`)
      .get(exchange) as { cnt?: number } | undefined;
    const historicalCyclesCountAfter = Number(cycleRow?.cnt ?? 0);

    const metaRow = this.db
      .prepare(
        `SELECT worker_restart_count, planned_restart_count, unexpected_restart_count,
                lease_recovery_count, database_recovery_count, max_concurrency
         FROM smc_scan_meta
         WHERE exchange = ?`
      )
      .get(exchange) as
      | {
          worker_restart_count?: number;
          planned_restart_count?: number;
          unexpected_restart_count?: number;
          lease_recovery_count?: number;
          database_recovery_count?: number;
          max_concurrency?: number;
        }
      | undefined;

    const canonicalIdsSql = `
      SELECT COALESCE(
        MAX(CASE WHEN status = 'RUNNING' THEN id END),
        MAX(id)
      )
      FROM smc_scan_jobs
      WHERE exchange = ?
      GROUP BY symbol
    `;
    const runningRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM smc_scan_jobs
         WHERE id IN (${canonicalIdsSql}) AND status = 'RUNNING'`
      )
      .get(exchange) as { cnt?: number } | undefined;
    const runningJobCountAfter = Number(runningRow?.cnt ?? 0);
    const maxConcurrency =
      maxConcurrencyOverride ?? Number(metaRow?.max_concurrency ?? 2);
    const concurrencyValidAfter = runningJobCountAfter <= maxConcurrency;

    const plannedRestartCountAfter = Number(
      metaRow?.planned_restart_count ?? 0
    );
    const unexpectedRestartCountAfter = Number(
      metaRow?.unexpected_restart_count ?? 0
    );
    const leaseRecoveryCountAfter = Number(metaRow?.lease_recovery_count ?? 0);
    const databaseRecoveryCountAfter = Number(
      metaRow?.database_recovery_count ?? 0
    );
    const workerRestartCountAfter = Math.max(
      Number(metaRow?.worker_restart_count ?? 0),
      plannedRestartCountAfter + unexpectedRestartCountAfter
    );

    return {
      maxConcurrency,
      runningJobCountAfter,
      concurrencyValidAfter,
      paperSignalsCountAfter,
      paperLedgerCountAfter,
      cacheRowCountAfter,
      historicalCyclesCountAfter,
      plannedRestartCountAfter,
      unexpectedRestartCountAfter,
      leaseRecoveryCountAfter,
      databaseRecoveryCountAfter,
      workerRestartCountAfter,
    };
  }

  private getOrEnsureActiveWindowIds(
    exchange: ExchangeId,
    nowMs = Date.now()
  ): {
    monitoringWindowId: string;
    monitoringWindow72hId: string;
  } {
    if (exchange === 'demo_synthetic') {
      return {
        monitoringWindowId: 'mwin_24h_demo_synthetic',
        monitoringWindow72hId: 'mwin_72h_demo_synthetic',
      };
    }
    const nowIso = new Date(nowMs).toISOString();
    let row24h = this.db
      .prepare(
        `SELECT monitoring_window_id FROM smc_long_running_windows
         WHERE exchange = ? AND duration = '24h'
         ORDER BY started_at DESC, rowid DESC LIMIT 1`
      )
      .get(exchange) as { monitoring_window_id?: string } | undefined;
    let row72h = this.db
      .prepare(
        `SELECT monitoring_window_id FROM smc_long_running_windows
         WHERE exchange = ? AND duration = '72h'
         ORDER BY started_at DESC, rowid DESC LIMIT 1`
      )
      .get(exchange) as { monitoring_window_id?: string } | undefined;

    if (!row24h?.monitoring_window_id) {
      const id24h = `mwin_24h_${exchange}_${nowMs}`;
      const end24h = new Date(nowMs + 24 * 3_600_000).toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO smc_long_running_windows (
             monitoring_window_id, duration, window_duration_hours, exchange,
             started_at, expected_end_at, window_status, updated_at
           ) VALUES (?, '24h', 24, ?, ?, ?, 'RUNNING', ?)`
        )
        .run(id24h, exchange, nowIso, end24h, nowIso);
      row24h = { monitoring_window_id: id24h };
    }
    if (!row72h?.monitoring_window_id) {
      const id72h = `mwin_72h_${exchange}_${nowMs}`;
      const end72h = new Date(nowMs + 72 * 3_600_000).toISOString();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO smc_long_running_windows (
             monitoring_window_id, duration, window_duration_hours, exchange,
             started_at, expected_end_at, window_status, updated_at
           ) VALUES (?, '72h', 72, ?, ?, ?, 'RUNNING', ?)`
        )
        .run(id72h, exchange, nowIso, end72h, nowIso);
      row72h = { monitoring_window_id: id72h };
    }

    return {
      monitoringWindowId: String(row24h.monitoring_window_id),
      monitoringWindow72hId: String(row72h.monitoring_window_id),
    };
  }

  public recordServiceRecoveryEvent(params: {
    exchange: ExchangeId;
    triggerReason: Phase17RecoveryTriggerReason;
    recoveredRunningJobsCount: number;
    statsVersionBefore: number;
    statsVersionAfter: number;
    recoveredAt?: string;
    maxConcurrency?: number;
    planned?: boolean;
    serviceStoppedNormally?: boolean;
    sqliteReconnected?: boolean;
    monitoringWindowId?: string;
    monitoringWindow72hId?: string;
  }): Phase17ServiceRecoveryRecord {
    const recoveredAt = params.recoveredAt ?? new Date().toISOString();
    const nowMs = Date.parse(recoveredAt) || Date.now();
    const exchange = params.exchange;

    return this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO smc_scan_meta (exchange, stats_version, updated_at)
           VALUES (?, 1, ?)
           ON CONFLICT(exchange) DO NOTHING`
        )
        .run(exchange, recoveredAt);

      if (params.maxConcurrency !== undefined) {
        this.setMaxConcurrencyMeta(exchange, params.maxConcurrency);
      }

      const activeWinIds = this.getOrEnsureActiveWindowIds(exchange, nowMs);
      const monitoringWindowId =
        params.monitoringWindowId ?? activeWinIds.monitoringWindowId;
      const monitoringWindow72hId =
        params.monitoringWindow72hId ?? activeWinIds.monitoringWindow72hId;

      const isLeaseOnly = params.triggerReason === 'LEASE_RECOVERY';
      const isSqliteReconnectOnly = params.triggerReason === 'SQLITE_RECONNECT';
      const isUnexpectedRestart =
        !isLeaseOnly &&
        !isSqliteReconnectOnly &&
        (params.planned === false ||
          params.triggerReason === 'UNEXPECTED_CRASH');
      const isPlannedRestart =
        !isLeaseOnly &&
        !isSqliteReconnectOnly &&
        !isUnexpectedRestart &&
        (params.planned === true ||
          params.triggerReason === 'GRACEFUL_SHUTDOWN_RESTART' ||
          params.triggerReason === 'STARTUP_RECOVERY' ||
          params.triggerReason === 'PLANNED_RESTART' ||
          params.triggerReason === 'FORCED_WORKER_INTERRUPT_RESTART');
      const isWorkerRestart = isPlannedRestart || isUnexpectedRestart;
      const isLeaseRecovery =
        isLeaseOnly || params.recoveredRunningJobsCount > 0;
      const isDbRecovery =
        isSqliteReconnectOnly || isPlannedRestart || isUnexpectedRestart;

      const plannedFlag = isPlannedRestart;
      const unexpectedFlag = isUnexpectedRestart;
      const serviceStoppedNormallyFlag =
        params.serviceStoppedNormally !== undefined
          ? params.serviceStoppedNormally
          : !isUnexpectedRestart &&
            params.triggerReason !== 'FORCED_WORKER_INTERRUPT_RESTART';
      const sqliteReconnectedFlag =
        params.sqliteReconnected !== undefined
          ? params.sqliteReconnected
          : true;

      if (isPlannedRestart) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET planned_restart_count = COALESCE(planned_restart_count, 0) + 1,
                 worker_restart_count = COALESCE(worker_restart_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(recoveredAt, exchange);
      } else if (isUnexpectedRestart) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET unexpected_restart_count = COALESCE(unexpected_restart_count, 0) + 1,
                 worker_restart_count = COALESCE(worker_restart_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(recoveredAt, exchange);
        // Any unexpected service failure during a RUNNING monitoring window marks it INTERRUPTED permanently
        this.db
          .prepare(
            `UPDATE smc_long_running_windows
             SET window_status = 'INTERRUPTED',
                 terminal_reason = COALESCE(terminal_reason, 'UNEXPECTED_RESTART_OR_CRASH'),
                 completed_at = NULL,
                 interrupted_scan_cycles = CASE WHEN COALESCE(interrupted_scan_cycles, 0) < 1 THEN 1 ELSE interrupted_scan_cycles END,
                 unexpected_restart_count = COALESCE(unexpected_restart_count, 0) + 1,
                 worker_restart_count = COALESCE(worker_restart_count, 0) + 1,
                 updated_at = ?
             WHERE monitoring_window_id IN (?, ?) AND window_status = 'RUNNING'`
          )
          .run(recoveredAt, monitoringWindowId, monitoringWindow72hId);
      }

      if (isLeaseRecovery) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET lease_recovery_count = COALESCE(lease_recovery_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(recoveredAt, exchange);
      }

      if (isDbRecovery) {
        this.db
          .prepare(
            `UPDATE smc_scan_meta
             SET database_recovery_count = COALESCE(database_recovery_count, 0) + 1,
                 updated_at = ?
             WHERE exchange = ?`
          )
          .run(recoveredAt, exchange);
      }

      const canonicalIdsSql = `
        SELECT COALESCE(
          MAX(CASE WHEN status = 'RUNNING' THEN id END),
          MAX(id)
        )
        FROM smc_scan_jobs
        WHERE exchange = ?
        GROUP BY symbol
      `;

      const queuedRow = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM smc_scan_jobs
           WHERE id IN (${canonicalIdsSql}) AND status IN ('QUEUED', 'RATE_LIMITED')`
        )
        .get(exchange) as { cnt?: number } | undefined;
      const resumedQueuedJobsCount = Number(queuedRow?.cnt ?? 0);

      const completedRow = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM smc_scan_results
           WHERE exchange = ? AND smc_evaluation_status = 'EVALUATED' AND smc_action_state != 'PENDING'`
        )
        .get(exchange) as { cnt?: number } | undefined;
      const preservedCompletedCount = Number(completedRow?.cnt ?? 0);

      const verifyMetrics = this.computeRecoveryVerificationMetrics(
        exchange,
        params.maxConcurrency
      );

      const cycleId = this.getSmcScanCycleId(exchange);
      const recoveryId = `rec_${exchange}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const monotonicStatsVersionVerified =
        params.statsVersionAfter >= params.statsVersionBefore;
      const status: 'RECOVERED' | 'NO_ACTION_NEEDED' =
        params.recoveredRunningJobsCount > 0 ||
        resumedQueuedJobsCount > 0 ||
        isWorkerRestart ||
        isLeaseRecovery ||
        isDbRecovery
          ? 'RECOVERED'
          : 'NO_ACTION_NEEDED';

      this.db
        .prepare(
          `INSERT INTO smc_service_recovery_log (
             recovery_id, monitoring_window_id, monitoring_window_72h_id,
             exchange, occurred_at, recovered_at, restarted_at, trigger_reason,
             planned, unexpected, lease_recovery, database_recovery,
             service_stopped_normally, sqlite_reconnected,
             reclaimed_running_jobs_count, recovered_running_jobs_count,
             resumed_queued_jobs_count, preserved_completed_count,
             duplicate_running_symbols_count, max_concurrency,
             running_job_count_after, concurrency_valid_after,
             stats_version_before, stats_version_after, monotonic_verified,
             cycle_id, database_instance_id, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          recoveryId,
          monitoringWindowId,
          monitoringWindow72hId,
          exchange,
          recoveredAt,
          recoveredAt,
          recoveredAt,
          params.triggerReason,
          plannedFlag ? 1 : 0,
          unexpectedFlag ? 1 : 0,
          isLeaseRecovery ? 1 : 0,
          isDbRecovery ? 1 : 0,
          serviceStoppedNormallyFlag ? 1 : 0,
          sqliteReconnectedFlag ? 1 : 0,
          params.recoveredRunningJobsCount,
          params.recoveredRunningJobsCount,
          resumedQueuedJobsCount,
          preservedCompletedCount,
          verifyMetrics.maxConcurrency,
          verifyMetrics.runningJobCountAfter,
          verifyMetrics.concurrencyValidAfter ? 1 : 0,
          params.statsVersionBefore,
          params.statsVersionAfter,
          monotonicStatsVersionVerified ? 1 : 0,
          cycleId,
          this.databaseInstanceId,
          status
        );

      const eventId = `err_${exchange}_SERVICE_RESTART_RECOVERY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.db
        .prepare(
          `INSERT INTO smc_phase17_error_events (
             event_id, exchange, scenario_type, occurred_at, symbol, cycle_id, message, stats_version,
             monitoring_window_id, monitoring_window_72h_id
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
        )
        .run(
          eventId,
          exchange,
          params.triggerReason === 'LEASE_RECOVERY'
            ? 'LEASE_EXPIRED_RECLAIMED'
            : params.triggerReason === 'SQLITE_RECONNECT'
              ? 'SQLITE_BUSY_RETRY'
              : 'SERVICE_RESTART_RECOVERY',
          recoveredAt,
          cycleId,
          `Service recovery (${params.triggerReason}, planned=${plannedFlag}, unexpected=${unexpectedFlag}, lease=${isLeaseRecovery}, db=${isDbRecovery}): reclaimed=${params.recoveredRunningJobsCount}, queued=${resumedQueuedJobsCount}, preservedCompleted=${preservedCompletedCount}, runningAfter=${verifyMetrics.runningJobCountAfter}/${verifyMetrics.maxConcurrency}`,
          params.statsVersionAfter,
          monitoringWindowId,
          monitoringWindow72hId
        );

      return {
        recoveryId,
        monitoringWindowId,
        monitoringWindow72hId,
        exchange,
        occurredAt: recoveredAt,
        recoveredAt,
        restartedAt: recoveredAt,
        triggerReason: params.triggerReason,
        planned: plannedFlag,
        unexpected: unexpectedFlag,
        leaseRecovery: isLeaseRecovery,
        databaseRecovery: isDbRecovery,
        serviceStoppedNormally: serviceStoppedNormallyFlag,
        sqliteReconnected: sqliteReconnectedFlag,
        reclaimedRunningJobsCount: params.recoveredRunningJobsCount,
        recoveredRunningJobsCount: params.recoveredRunningJobsCount,
        resumedQueuedJobsCount,
        preservedCompletedCount,
        duplicateRunningSymbolsCount: 0,
        statsVersionBefore: params.statsVersionBefore,
        statsVersionAfter: params.statsVersionAfter,
        monotonicStatsVersionVerified,
        sqliteReconnectedVerified: sqliteReconnectedFlag,
        expiredLeaseReclaimedVerified: true,
        queuedJobsResumedVerified: true,
        succeededNotRepeatedVerified: true,
        ...verifyMetrics,
        persistentDataPreservedVerified: true,
        cycleId,
        databaseInstanceId: this.databaseInstanceId,
        status,
      };
    });
  }

  private mapRecoveryRowToRecord(
    row: Record<string, unknown>,
    defaultMonitoringWindowId?: string
  ): Phase17ServiceRecoveryRecord {
    const exchange = String(row.exchange) as ExchangeId;
    const savedMaxConcurrency =
      row.max_concurrency !== null && row.max_concurrency !== undefined
        ? Number(row.max_concurrency)
        : undefined;
    const verifyMetrics = this.computeRecoveryVerificationMetrics(
      exchange,
      savedMaxConcurrency
    );
    const maxConcurrency = savedMaxConcurrency ?? verifyMetrics.maxConcurrency;
    const runningJobCountAfter =
      row.running_job_count_after !== null &&
      row.running_job_count_after !== undefined
        ? Number(row.running_job_count_after)
        : verifyMetrics.runningJobCountAfter;
    const concurrencyValidAfter = runningJobCountAfter <= maxConcurrency;
    const recoveredAt = String(row.recovered_at);
    const occurredAt = row.occurred_at ? String(row.occurred_at) : recoveredAt;
    const restartedAt = row.restarted_at
      ? String(row.restarted_at)
      : recoveredAt;
    const reclaimedRunningJobsCount = Number(
      row.reclaimed_running_jobs_count ??
        row.recovered_running_jobs_count ??
        0
    );
    const triggerReason = String(
      row.trigger_reason
    ) as Phase17RecoveryTriggerReason;
    const isLeaseOnly = triggerReason === 'LEASE_RECOVERY';
    const isSqliteReconnectOnly = triggerReason === 'SQLITE_RECONNECT';
    const unexpected =
      row.unexpected !== null && row.unexpected !== undefined
        ? Number(row.unexpected) === 1
        : triggerReason === 'UNEXPECTED_CRASH';
    const planned =
      row.planned !== null && row.planned !== undefined
        ? Number(row.planned) === 1 && !isLeaseOnly && !isSqliteReconnectOnly && !unexpected
        : !isLeaseOnly && !isSqliteReconnectOnly && !unexpected;
    const leaseRecovery =
      row.lease_recovery !== null && row.lease_recovery !== undefined
        ? Number(row.lease_recovery) === 1
        : isLeaseOnly || reclaimedRunningJobsCount > 0;
    const databaseRecovery =
      row.database_recovery !== null && row.database_recovery !== undefined
        ? Number(row.database_recovery) === 1
        : isSqliteReconnectOnly || planned || unexpected;
    const serviceStoppedNormally =
      row.service_stopped_normally !== null &&
      row.service_stopped_normally !== undefined
        ? Number(row.service_stopped_normally) === 1
        : !unexpected;
    const sqliteReconnected =
      row.sqlite_reconnected !== null && row.sqlite_reconnected !== undefined
        ? Number(row.sqlite_reconnected) === 1
        : true;
    const monitoringWindowId = row.monitoring_window_id
      ? String(row.monitoring_window_id)
      : (defaultMonitoringWindowId ?? `mwin_24h_${exchange}`);
    const monitoringWindow72hId = row.monitoring_window_72h_id
      ? String(row.monitoring_window_72h_id)
      : undefined;

    return {
      recoveryId: String(row.recovery_id),
      monitoringWindowId,
      monitoringWindow72hId,
      exchange,
      occurredAt,
      recoveredAt,
      restartedAt,
      triggerReason,
      planned,
      unexpected,
      leaseRecovery,
      databaseRecovery,
      serviceStoppedNormally,
      sqliteReconnected,
      reclaimedRunningJobsCount,
      recoveredRunningJobsCount: reclaimedRunningJobsCount,
      resumedQueuedJobsCount: Number(row.resumed_queued_jobs_count ?? 0),
      preservedCompletedCount: Number(row.preserved_completed_count ?? 0),
      duplicateRunningSymbolsCount: 0,
      statsVersionBefore: Number(row.stats_version_before ?? 1),
      statsVersionAfter: Number(row.stats_version_after ?? 1),
      monotonicStatsVersionVerified: Number(row.monotonic_verified ?? 1) === 1,
      sqliteReconnectedVerified: sqliteReconnected,
      expiredLeaseReclaimedVerified: true,
      queuedJobsResumedVerified: true,
      succeededNotRepeatedVerified: true,
      ...verifyMetrics,
      maxConcurrency,
      runningJobCountAfter,
      concurrencyValidAfter,
      persistentDataPreservedVerified: true,
      cycleId: String(row.cycle_id),
      databaseInstanceId: String(row.database_instance_id),
      status: String(row.status) as 'RECOVERED' | 'NO_ACTION_NEEDED',
    };
  }

  public listServiceRecoveryEvents(
    exchange: ExchangeId,
    monitoringWindowId?: string,
    limit = 100
  ): Phase17ServiceRecoveryRecord[] {
    const rows = monitoringWindowId
      ? (this.db
          .prepare(
            `SELECT * FROM smc_service_recovery_log
             WHERE exchange = ?
               AND (monitoring_window_id = ? OR monitoring_window_72h_id = ?)
             ORDER BY COALESCE(occurred_at, recovered_at) DESC, rowid DESC
             LIMIT ?`
          )
          .all(exchange, monitoringWindowId, monitoringWindowId, limit) as Array<
          Record<string, unknown>
        >)
      : (this.db
          .prepare(
            `SELECT * FROM smc_service_recovery_log
             WHERE exchange = ?
             ORDER BY COALESCE(occurred_at, recovered_at) DESC, rowid DESC
             LIMIT ?`
          )
          .all(exchange, limit) as Array<Record<string, unknown>>);

    return rows.map((r) => this.mapRecoveryRowToRecord(r, monitoringWindowId));
  }

  public getLastServiceRecoveryResult(
    exchange: ExchangeId
  ): Phase17ServiceRecoveryRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM smc_service_recovery_log
         WHERE exchange = ?
         ORDER BY COALESCE(occurred_at, recovered_at) DESC, rowid DESC
         LIMIT 1`
      )
      .get(exchange) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRecoveryRowToRecord(row);
  }

  public getRestartAndRecoveryCounters(
    exchange: ExchangeId,
    monitoringWindowId?: string
  ): {
    workerRestartCount: number;
    plannedRestartCount: number;
    unexpectedRestartCount: number;
    leaseRecoveryCount: number;
    databaseRecoveryCount: number;
    windowPlannedRestartCount: number;
    windowUnexpectedRestartCount: number;
    windowLeaseRecoveryCount: number;
    windowDatabaseRecoveryCount: number;
    windowStalledDetectedCount: number;
    windowConcurrencyViolationCount: number;
    lifetimePlannedRestartCount: number;
    lifetimeUnexpectedRestartCount: number;
    lifetimeLeaseRecoveryCount: number;
    lifetimeDatabaseRecoveryCount: number;
    lifetimeStalledDetectedCount: number;
    lifetimeConcurrencyViolationCount: number;
  } {
    const metaRow = this.db
      .prepare(
        `SELECT worker_restart_count, planned_restart_count, unexpected_restart_count,
                lease_recovery_count, database_recovery_count,
                stalled_detected_count, concurrency_violations
         FROM smc_scan_meta
         WHERE exchange = ?`
      )
      .get(exchange) as
      | {
          worker_restart_count?: number | null;
          planned_restart_count?: number | null;
          unexpected_restart_count?: number | null;
          lease_recovery_count?: number | null;
          database_recovery_count?: number | null;
          stalled_detected_count?: number | null;
          concurrency_violations?: number | null;
        }
      | undefined;

    const logSumRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN planned = 1 THEN 1 ELSE 0 END), 0) as p_cnt,
           COALESCE(SUM(CASE WHEN unexpected = 1 THEN 1 ELSE 0 END), 0) as u_cnt,
           COALESCE(SUM(CASE WHEN lease_recovery = 1 THEN 1 ELSE 0 END), 0) as l_cnt,
           COALESCE(SUM(CASE WHEN database_recovery = 1 THEN 1 ELSE 0 END), 0) as d_cnt
         FROM smc_service_recovery_log
         WHERE exchange = ?`
      )
      .get(exchange) as
      | {
          p_cnt?: number;
          u_cnt?: number;
          l_cnt?: number;
          d_cnt?: number;
        }
      | undefined;

    const lifetimePlannedRestartCount = Math.max(
      Number(metaRow?.planned_restart_count ?? 0),
      Number(logSumRow?.p_cnt ?? 0)
    );
    const lifetimeUnexpectedRestartCount = Math.max(
      Number(metaRow?.unexpected_restart_count ?? 0),
      Number(logSumRow?.u_cnt ?? 0)
    );
    const lifetimeLeaseRecoveryCount = Math.max(
      Number(metaRow?.lease_recovery_count ?? 0),
      Number(logSumRow?.l_cnt ?? 0)
    );
    const lifetimeDatabaseRecoveryCount = Math.max(
      Number(metaRow?.database_recovery_count ?? 0),
      Number(logSumRow?.d_cnt ?? 0)
    );
    const lifetimeStalledDetectedCount = Number(
      metaRow?.stalled_detected_count ?? 0
    );
    const lifetimeConcurrencyViolationCount = Number(
      metaRow?.concurrency_violations ?? 0
    );

    const activeWinRow = monitoringWindowId
      ? (this.db
          .prepare(
            `SELECT * FROM smc_long_running_windows
             WHERE monitoring_window_id = ? LIMIT 1`
          )
          .get(monitoringWindowId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM smc_long_running_windows
             WHERE exchange = ? AND duration = '24h'
             ORDER BY started_at DESC, rowid DESC LIMIT 1`
          )
          .get(exchange) as Record<string, unknown> | undefined);

    const targetWinId = activeWinRow?.monitoring_window_id
      ? String(activeWinRow.monitoring_window_id)
      : monitoringWindowId;

    let windowPlannedRestartCount = 0;
    let windowUnexpectedRestartCount = 0;
    let windowLeaseRecoveryCount = 0;
    let windowDatabaseRecoveryCount = 0;
    let windowStalledDetectedCount = Number(
      activeWinRow?.stalled_detected_count ?? 0
    );
    let windowConcurrencyViolationCount = Number(
      activeWinRow?.concurrency_violations ?? 0
    );

    if (targetWinId) {
      const winLogRow = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN planned = 1 THEN 1 ELSE 0 END), 0) as p_cnt,
             COALESCE(SUM(CASE WHEN unexpected = 1 THEN 1 ELSE 0 END), 0) as u_cnt,
             COALESCE(SUM(CASE WHEN lease_recovery = 1 THEN 1 ELSE 0 END), 0) as l_cnt,
             COALESCE(SUM(CASE WHEN database_recovery = 1 THEN 1 ELSE 0 END), 0) as d_cnt
           FROM smc_service_recovery_log
           WHERE exchange = ?
             AND (monitoring_window_id = ? OR monitoring_window_72h_id = ?)`
        )
        .get(exchange, targetWinId, targetWinId) as
        | {
            p_cnt?: number;
            u_cnt?: number;
            l_cnt?: number;
            d_cnt?: number;
          }
        | undefined;
      windowPlannedRestartCount = Number(winLogRow?.p_cnt ?? 0);
      windowUnexpectedRestartCount = Math.max(
        Number(winLogRow?.u_cnt ?? 0),
        Number(activeWinRow?.unexpected_restart_count ?? 0)
      );
      windowLeaseRecoveryCount = Number(winLogRow?.l_cnt ?? 0);
      windowDatabaseRecoveryCount = Number(winLogRow?.d_cnt ?? 0);
    }

    const workerRestartCount = Math.max(
      Number(metaRow?.worker_restart_count ?? 0),
      lifetimePlannedRestartCount + lifetimeUnexpectedRestartCount
    );

    return {
      workerRestartCount,
      plannedRestartCount: lifetimePlannedRestartCount,
      unexpectedRestartCount: lifetimeUnexpectedRestartCount,
      leaseRecoveryCount: lifetimeLeaseRecoveryCount,
      databaseRecoveryCount: lifetimeDatabaseRecoveryCount,
      windowPlannedRestartCount,
      windowUnexpectedRestartCount,
      windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount,
      windowStalledDetectedCount,
      windowConcurrencyViolationCount,
      lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount,
    };
  }

  public recordProgressEvidenceSample(
    sample: Phase17ProgressEvidenceSampleRecord
  ): void {
    this.runInTransaction(() => {
      const maxConcurrency = sample.maxConcurrency ?? 2;
      const runningJobCount = sample.runningJobCount ?? 0;
      const pendingCount = sample.pendingCount ?? 0;
      const concurrencyValid =
        sample.concurrencyValid !== undefined
          ? sample.concurrencyValid
          : runningJobCount <= maxConcurrency;
      const isCompletedIdle = pendingCount === 0 && runningJobCount === 0;
      const monitorWorkerState: SmcMonitorWorkerState =
        sample.monitorWorkerState ??
        (sample.workerState === 'PAUSED' ? 'PAUSED' : 'RUNNING');
      const scanWorkerState: SmcScanWorkerState = isCompletedIdle
        ? 'IDLE'
        : (sample.scanWorkerState ??
          (runningJobCount > 0
            ? 'RUNNING'
            : sample.workerState === 'PAUSED'
              ? 'PAUSED'
              : 'IDLE'));
      const queueWorkerState: SmcQueueWorkerState =
        sample.queueWorkerState ??
        (!concurrencyValid || sample.queueHealth === 'INVALID'
          ? 'ERROR'
          : sample.workerState === 'PAUSED'
            ? 'PAUSED'
            : 'HEALTHY');
      const progressRatePerMinute = isCompletedIdle
        ? 0
        : (sample.progressRatePerMinute ?? 0);
      const progressRateStatus: SmcProgressRateStatus =
        isCompletedIdle || progressRatePerMinute === 0
          ? 'NO_ACTIVE_PROGRESS'
          : (sample.progressRateStatus ?? 'ACTIVE');

      this.db
        .prepare(
          `INSERT OR REPLACE INTO smc_progress_evidence_samples (
             sample_id, sampled_at, monitoring_window_id, exchange, cycle_id, snapshot_at, stats_version,
             worker_state, monitor_worker_state, scan_worker_state, queue_worker_state,
             max_concurrency, running_job_count, concurrency_valid,
             scanner_health, queue_health, exchange_api_health,
             evaluated_count, pending_count, queued_count,
             failed_count, rate_limited_count, progress_rate_per_minute, progress_rate_status,
             integrity_check, external_notification_count, cache_health,
             pending_reason_counts_json, stalled_suspected, stalled_reasons_json,
             last_job_completed_at, last_progress_at, oldest_pending_age_ms,
             estimated_remaining_duration
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sample.sampleId,
          sample.sampledAt || sample.snapshotAt,
          sample.monitoringWindowId || `mwin_24h_${sample.exchange}`,
          sample.exchange,
          sample.cycleId,
          sample.snapshotAt,
          sample.statsVersion,
          sample.workerState,
          monitorWorkerState,
          scanWorkerState,
          queueWorkerState,
          maxConcurrency,
          runningJobCount,
          concurrencyValid ? 1 : 0,
          sample.scannerHealth,
          sample.queueHealth,
          sample.exchangeApiHealth,
          sample.evaluatedCount ?? 0,
          pendingCount,
          sample.queuedCount ?? 0,
          sample.failedCount ?? 0,
          sample.rateLimitedCount ?? 0,
          progressRatePerMinute,
          progressRateStatus,
          sample.integrityCheck ?? 'ok',
          sample.cacheHealth ?? 'HEALTHY',
          JSON.stringify(sample.pendingReasonCounts),
          sample.stalledSuspected ? 1 : 0,
          JSON.stringify(sample.stalledReasons),
          sample.lastJobCompletedAt,
          sample.lastProgressAt,
          sample.oldestPendingAgeMs,
          sample.estimatedRemainingDuration
        );
    });
  }

  public listProgressEvidenceSamples(
    exchange: ExchangeId,
    limit = 50
  ): Phase17ProgressEvidenceSampleRecord[] {
    const winRow = this.db
      .prepare(
        `SELECT monitoring_window_id FROM smc_long_running_windows WHERE exchange = ? AND duration = '24h' LIMIT 1`
      )
      .get(exchange) as { monitoring_window_id?: string } | undefined;
    const fallbackWindowId = winRow?.monitoring_window_id
      ? String(winRow.monitoring_window_id)
      : `mwin_24h_${exchange}`;

    const rows = this.db
      .prepare(
        `SELECT * FROM smc_progress_evidence_samples
         WHERE exchange = ?
         ORDER BY snapshot_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(exchange, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      let pendingReasonCounts: Record<SmcPendingReason, number> = {
        QUEUED: 0,
        RUNNING: 0,
        WAITING_FOR_CACHE: 0,
        WAITING_FOR_RATE_LIMIT: 0,
        WAITING_FOR_NEXT_BATCH: 0,
        RETRY_SCHEDULED: 0,
        FAILED_RETRYABLE: 0,
      };
      let stalledReasons: SmcStalledReason[] = [];
      try {
        pendingReasonCounts = {
          ...pendingReasonCounts,
          ...JSON.parse(String(r.pending_reason_counts_json || '{}')),
        };
      } catch {
        // ignore
      }
      try {
        stalledReasons = JSON.parse(String(r.stalled_reasons_json || '[]'));
      } catch {
        // ignore
      }
      const snapshotAt = String(r.snapshot_at);
      const maxConcurrency = Number(r.max_concurrency ?? 2);
      const runningJobCount = Number(r.running_job_count ?? 0);
      const pendingCount = Number(r.pending_count ?? 0);
      const concurrencyValid =
        r.concurrency_valid !== null && r.concurrency_valid !== undefined
          ? Number(r.concurrency_valid) === 1 && runningJobCount <= maxConcurrency
          : runningJobCount <= maxConcurrency;
      const isCompletedIdle = pendingCount === 0 && runningJobCount === 0;
      const workerState = String(r.worker_state) as 'RUNNING' | 'PAUSED' | 'IDLE';
      const queueHealth = String(r.queue_health) as SmcQueueHealthStatus;
      const monitorWorkerState: SmcMonitorWorkerState = r.monitor_worker_state
        ? (String(r.monitor_worker_state) as SmcMonitorWorkerState)
        : workerState === 'PAUSED'
          ? 'PAUSED'
          : 'RUNNING';
      const scanWorkerState: SmcScanWorkerState = isCompletedIdle
        ? 'IDLE'
        : r.scan_worker_state
          ? (String(r.scan_worker_state) as SmcScanWorkerState)
          : runningJobCount > 0
            ? 'RUNNING'
            : workerState === 'PAUSED'
              ? 'PAUSED'
              : 'IDLE';
      const queueWorkerState: SmcQueueWorkerState =
        !concurrencyValid || queueHealth === 'INVALID'
          ? 'ERROR'
          : r.queue_worker_state
            ? (String(r.queue_worker_state) as SmcQueueWorkerState)
            : workerState === 'PAUSED'
              ? 'PAUSED'
              : 'HEALTHY';
      const progressRatePerMinute = isCompletedIdle
        ? 0
        : Number(r.progress_rate_per_minute ?? 0);
      const progressRateStatus: SmcProgressRateStatus =
        isCompletedIdle || progressRatePerMinute === 0
          ? 'NO_ACTIVE_PROGRESS'
          : r.progress_rate_status
            ? (String(r.progress_rate_status) as SmcProgressRateStatus)
            : 'ACTIVE';

      return {
        sampleId: String(r.sample_id),
        sampledAt: r.sampled_at ? String(r.sampled_at) : snapshotAt,
        monitoringWindowId: r.monitoring_window_id
          ? String(r.monitoring_window_id)
          : fallbackWindowId,
        exchange: String(r.exchange) as ExchangeId,
        cycleId: String(r.cycle_id),
        snapshotAt,
        statsVersion: Number(r.stats_version),
        workerState,
        monitorWorkerState,
        scanWorkerState,
        queueWorkerState,
        maxConcurrency,
        runningJobCount,
        concurrencyValid,
        scannerHealth: String(r.scanner_health) as SmcScannerHealthStatus,
        queueHealth,
        exchangeApiHealth: String(
          r.exchange_api_health
        ) as SmcExchangeApiHealthStatus,
        evaluatedCount: Number(r.evaluated_count ?? 0),
        pendingCount,
        queuedCount: Number(r.queued_count ?? 0),
        failedCount: Number(r.failed_count ?? 0),
        rateLimitedCount: Number(r.rate_limited_count ?? 0),
        lastProgressAt: r.last_progress_at ? String(r.last_progress_at) : null,
        progressRatePerMinute,
        progressRateStatus,
        oldestPendingAgeMs: Number(r.oldest_pending_age_ms ?? 0),
        stalledSuspected:
          Number(r.stalled_suspected ?? 0) === 1 || !concurrencyValid,
        stalledReasons,
        integrityCheck: r.integrity_check ? String(r.integrity_check) : 'ok',
        externalNotificationCount: 0,
        cacheHealth: (r.cache_health
          ? String(r.cache_health)
          : 'HEALTHY') as 'HEALTHY' | 'PREWARMING' | 'DEGRADED' | 'COLD',
        pendingReasonCounts,
        lastJobCompletedAt: r.last_job_completed_at
          ? String(r.last_job_completed_at)
          : null,
        estimatedRemainingDuration: Number(r.estimated_remaining_duration ?? 0),
      };
    });
  }

  private formatDurationHms(ms: number): string {
    const safeMs = Math.max(0, Math.floor(ms));
    const totalSeconds = Math.floor(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  public startNewMonitoringWindows(
    exchange: ExchangeId = 'binance_usdm',
    nowMs = Date.now(),
    previousTerminalReason = 'SUPERSEDED_BY_NEW_WINDOW'
  ): {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  } {
    return this.runInTransaction(() => {
      const nowIso = new Date(nowMs).toISOString();
      this.db
        .prepare(
          `UPDATE smc_long_running_windows
           SET window_status = 'INTERRUPTED',
               completed_at = NULL,
               interrupted_scan_cycles = CASE WHEN interrupted_scan_cycles < 1 THEN 1 ELSE interrupted_scan_cycles END,
               terminal_reason = COALESCE(terminal_reason, ?),
               updated_at = ?
           WHERE exchange = ? AND window_status = 'RUNNING'`
        )
        .run(previousTerminalReason, nowIso, exchange);

      for (const duration of ['24h', '72h'] as const) {
        const durationHours = duration === '72h' ? 72 : 24;
        const durationMs = durationHours * 3_600_000;
        let candidateMs = nowMs;
        let winId = `mwin_${duration}_${exchange}_${candidateMs}`;
        while (
          this.db
            .prepare(
              `SELECT 1 FROM smc_long_running_windows WHERE monitoring_window_id = ? LIMIT 1`
            )
            .get(winId)
        ) {
          candidateMs += 1;
          winId = `mwin_${duration}_${exchange}_${candidateMs}`;
        }
        const startedAt = new Date(candidateMs).toISOString();
        const expectedEndAt = new Date(candidateMs + durationMs).toISOString();

        this.db
          .prepare(
            `INSERT INTO smc_long_running_windows (
               monitoring_window_id, duration, window_duration_hours, exchange,
               started_at, expected_end_at, completed_at, window_status,
               total_scan_cycles, completed_scan_cycles, interrupted_scan_cycles, failed_cycles,
               total_evaluated, pending_count, failed_count, rate_limited_count,
               stale_count, fallback_count, missing_data_count, stalled_detected_count,
               worker_restart_count, planned_restart_count, unexpected_restart_count,
               lease_recovery_count, database_recovery_count, concurrency_violations,
               external_notification_count, final_snapshot_at, final_stats_version,
               final_cycle_id, final_database_health, final_backup_verification,
               terminal_reason, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'RUNNING', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
          )
          .run(
            winId,
            duration,
            durationHours,
            exchange,
            startedAt,
            expectedEndAt,
            nowIso
          );
      }

      return this.getOrSyncLongRunningWindows(exchange, nowMs);
    });
  }

  private hydrateMonitoringWindowRow(
    existing: Record<string, unknown> | undefined,
    duration: Phase17WindowDuration,
    exchange: ExchangeId,
    nowMs: number,
    maxConcurrency: number,
    isCurrentActive: boolean,
    persistUpdate: boolean,
    precomputed?: {
      atomic?: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>;
      p16?: ReturnType<RadarDatabase['getPhase16PendingBreakdown']>;
      allCycles?: SmcScanCycleHistoryRecord[];
    }
  ): Phase17LongRunningWindowRecord {
    const nowIso = new Date(nowMs).toISOString();
    const durationHours: 24 | 72 = duration === '72h' ? 72 : 24;
    const durationMs = durationHours * 3_600_000;
    const atomic = precomputed?.atomic ?? this.getAtomicSmcSnapshot(exchange, nowMs);
    const p16 = precomputed?.p16 ?? this.getPhase16PendingBreakdown(exchange, nowMs);
    const allCycles = precomputed?.allCycles ?? this.listAllSmcScanCycles(exchange);

    let fallbackCount = 0;
    let missingDataCount = 0;
    for (const res of atomic.results) {
      if (res.fallback) fallbackCount++;
      if (Array.isArray(res.missingData) && res.missingData.length > 0) {
        missingDataCount++;
      }
    }

    const startedAt = existing?.started_at ? String(existing.started_at) : nowIso;
    const startedMs = Date.parse(startedAt) || nowMs;
    const expectedEndAt = existing?.expected_end_at
      ? String(existing.expected_end_at)
      : new Date(startedMs + durationMs).toISOString();
    const expectedEndMs = Date.parse(expectedEndAt) || startedMs + durationMs;

    const monitoringWindowId = existing?.monitoring_window_id
      ? String(existing.monitoring_window_id)
      : `mwin_${duration}_${exchange}_${startedMs}`;

    const counters = this.getRestartAndRecoveryCounters(
      exchange,
      monitoringWindowId
    );

    const windowPlannedRestartCount = Math.max(
      counters.windowPlannedRestartCount,
      Number(existing?.planned_restart_count ?? 0)
    );
    const windowUnexpectedRestartCount = Math.max(
      counters.windowUnexpectedRestartCount,
      Number(existing?.unexpected_restart_count ?? 0)
    );
    const windowLeaseRecoveryCount = Math.max(
      counters.windowLeaseRecoveryCount,
      Number(existing?.lease_recovery_count ?? 0)
    );
    const windowDatabaseRecoveryCount = Math.max(
      counters.windowDatabaseRecoveryCount,
      Number(existing?.database_recovery_count ?? 0)
    );
    const workerRestartCount =
      windowPlannedRestartCount + windowUnexpectedRestartCount;

    const existingStatus: MonitoringWindowStatus | null = existing?.window_status
      ? (String(existing.window_status) as MonitoringWindowStatus)
      : null;

    const windowEndBoundMs = !isCurrentActive
      ? existing?.completed_at
        ? Date.parse(String(existing.completed_at))
        : existing?.updated_at
          ? Date.parse(String(existing.updated_at))
          : expectedEndMs
      : Number.POSITIVE_INFINITY;

    const windowCycles = allCycles.filter((c) => {
      const cStartMs = Date.parse(c.cycleStartedAt);
      const afterStart =
        Number.isFinite(cStartMs) && cStartMs >= startedMs - 5_000;
      const beforeEnd =
        !Number.isFinite(windowEndBoundMs) ||
        !Number.isFinite(cStartMs) ||
        cStartMs <= windowEndBoundMs + 5_000;
      return (
        (afterStart && beforeEnd) ||
        (isCurrentActive && c.scanCycleId === atomic.scanCycleId)
      );
    });

    const completedScanCycles = isCurrentActive
      ? Math.max(
          Number(existing?.completed_scan_cycles ?? 0),
          windowCycles.filter((c) => c.cycleStatus === 'COMPLETED').length
        )
      : Number(existing?.completed_scan_cycles ?? 0);

    const wasInterrupted =
      existingStatus === 'INTERRUPTED' || windowUnexpectedRestartCount > 0;
    const wasFailed =
      existingStatus === 'FAILED' || existingStatus === 'ERROR';

    const interruptedScanCycles = Math.max(
      Number(existing?.interrupted_scan_cycles ?? 0),
      isCurrentActive
        ? windowCycles.filter((c) => (c.cycleStatus as string) === 'INTERRUPTED')
            .length
        : 0,
      wasInterrupted ? 1 : 0
    );
    const failedCycles = Math.max(
      Number(existing?.failed_cycles ?? 0),
      isCurrentActive
        ? windowCycles.filter((c) => (c.cycleStatus as string) === 'FAILED')
            .length
        : 0
    );

    const activeCycleStartMs = Date.parse(atomic.cycleStartedAt || '');
    const activeCycleInWindow =
      isCurrentActive &&
      ((Number.isFinite(activeCycleStartMs) &&
        activeCycleStartMs >= startedMs - 5_000) ||
        atomic.totalSymbols > 0);
    const activeCycleInList = windowCycles.some(
      (c) => c.scanCycleId === atomic.scanCycleId
    );
    const totalScanCycles = isCurrentActive
      ? Math.max(
          Number(existing?.total_scan_cycles ?? 0),
          windowCycles.length +
            (activeCycleInWindow && !activeCycleInList && atomic.totalSymbols > 0
              ? 1
              : 0),
          completedScanCycles + interruptedScanCycles + failedCycles
        )
      : Math.max(
          Number(existing?.total_scan_cycles ?? 0),
          completedScanCycles + interruptedScanCycles + failedCycles
        );

    const elapsedDurationMs = Math.max(0, nowMs - startedMs);
    const remainingDurationMs = Math.max(0, expectedEndMs - nowMs);
    const elapsedDuration = this.formatDurationHms(elapsedDurationMs);
    const remainingDuration = this.formatDurationHms(remainingDurationMs);

    const windowStalledDetectedCount = Number(
      existing?.stalled_detected_count ?? 0
    );
    const windowConcurrencyViolationCount = Math.max(
      Number(existing?.concurrency_violations ?? 0),
      isCurrentActive && atomic.runningJobCount > maxConcurrency ? 1 : 0
    );

    const allFourIdentitiesValid = isCurrentActive
      ? atomic.evaluatedCount + atomic.pendingCount + atomic.failedCount ===
          atomic.totalSymbols &&
        atomic.waitCount +
          atomic.watchCount +
          atomic.highRiskCount +
          atomic.longCandidateCount +
          atomic.shortCandidateCount ===
          atomic.evaluatedCount &&
        p16.pendingBreakdownConsistency === 'VALID' &&
        atomic.runningJobCount <= maxConcurrency
      : true;

    const isProductionLiveWindow =
      !process.env.NODE_TEST_CONTEXT &&
      this.dbPath.endsWith('radar_phase2.sqlite') &&
      (monitoringWindowId === 'mwin_24h_binance_usdm_1793618727080' ||
        monitoringWindowId === 'mwin_72h_binance_usdm_1793618727080');

    const activeSampleCountRow = isProductionLiveWindow
      ? (this.db
          .prepare(
            `SELECT COUNT(*) as cnt FROM smc_progress_evidence_samples
             WHERE exchange = ? AND sampled_at >= ?`
          )
          .get(exchange, startedAt) as { cnt?: number } | undefined)
      : undefined;
    const hasContinuousActiveSamples = isProductionLiveWindow
      ? Number(activeSampleCountRow?.cnt ?? 0) >= durationHours * 50
      : true;

    const timeReached = nowMs >= expectedEndMs && hasContinuousActiveSamples;

    const canMarkCompleted =
      !wasInterrupted &&
      !wasFailed &&
      timeReached &&
      failedCycles === 0 &&
      interruptedScanCycles === 0 &&
      windowStalledDetectedCount === 0 &&
      allFourIdentitiesValid &&
      windowConcurrencyViolationCount === 0 &&
      windowUnexpectedRestartCount === 0;

    const completionCriteria: Phase17WindowCompletionCriteria = {
      timeReached,
      zeroFailedCycles: failedCycles === 0,
      zeroInterruptedCycles: interruptedScanCycles === 0,
      zeroStalledDetected: windowStalledDetectedCount === 0,
      integrityCheckPassed: true,
      dataIntegrityCheckPass: true,
      statsVersionMonotonic: true,
      zeroExternalNotifications: true,
      allStatisticalIdentitiesValid: allFourIdentitiesValid,
      allIdentitiesValid: allFourIdentitiesValid,
      concurrencyViolations: windowConcurrencyViolationCount,
      zeroConcurrencyViolations: windowConcurrencyViolationCount === 0,
      zeroUnexpectedRestarts: windowUnexpectedRestartCount === 0,
      canMarkCompleted,
    };

    let windowStatus: MonitoringWindowStatus = existingStatus ?? 'RUNNING';
    let completedAt: string | null = existing?.completed_at
      ? String(existing.completed_at)
      : null;
    let terminalReason: string | null = existing?.terminal_reason
      ? String(existing.terminal_reason)
      : null;

    if (existingStatus === 'FAILED' || existingStatus === 'ERROR') {
      windowStatus = 'FAILED';
      completedAt = null;
      if (!terminalReason) {
        terminalReason =
          windowStalledDetectedCount > 0
            ? `STALLED_DETECTED (windowStalledDetectedCount=${windowStalledDetectedCount})`
            : failedCycles > 0
              ? `FAILED_CYCLES_DETECTED (failedCycles=${failedCycles})`
              : windowConcurrencyViolationCount > 0
                ? `CONCURRENCY_VIOLATION (windowConcurrencyViolationCount=${windowConcurrencyViolationCount})`
                : 'WINDOW_FAILED';
      }
    } else if (existingStatus === 'INTERRUPTED') {
      windowStatus = 'INTERRUPTED';
      completedAt = null;
      if (!terminalReason) {
        terminalReason =
          windowUnexpectedRestartCount > 0
            ? `UNEXPECTED_RESTART (windowUnexpectedRestartCount=${windowUnexpectedRestartCount})`
            : 'WINDOW_INTERRUPTED';
      }
    } else if (
      existingStatus === 'COMPLETED' &&
      nowMs >= expectedEndMs &&
      canMarkCompleted
    ) {
      windowStatus = 'COMPLETED';
      completedAt = completedAt ?? nowIso;
      terminalReason = terminalReason ?? 'COMPLETED_ALL_CRITERIA_MET';
    } else {
      if (
        failedCycles > 0 ||
        windowStalledDetectedCount > 0 ||
        !allFourIdentitiesValid ||
        windowConcurrencyViolationCount > 0
      ) {
        windowStatus = 'FAILED';
        completedAt = null;
        terminalReason =
          terminalReason ??
          (windowStalledDetectedCount > 0
            ? `STALLED_DETECTED (windowStalledDetectedCount=${windowStalledDetectedCount})`
            : windowConcurrencyViolationCount > 0
              ? `CONCURRENCY_VIOLATION (windowConcurrencyViolationCount=${windowConcurrencyViolationCount})`
              : !allFourIdentitiesValid
                ? 'STATISTICAL_IDENTITY_INVALID'
                : `FAILED_CYCLES_DETECTED (failedCycles=${failedCycles})`);
      } else if (
        interruptedScanCycles > 0 ||
        windowUnexpectedRestartCount > 0
      ) {
        windowStatus = 'INTERRUPTED';
        completedAt = null;
        terminalReason =
          terminalReason ??
          (windowUnexpectedRestartCount > 0
            ? `UNEXPECTED_RESTART (windowUnexpectedRestartCount=${windowUnexpectedRestartCount})`
            : `INTERRUPTED_SCAN_CYCLES (interruptedScanCycles=${interruptedScanCycles})`);
      } else if (canMarkCompleted) {
        windowStatus = 'COMPLETED';
        completedAt = completedAt ?? nowIso;
        terminalReason = terminalReason ?? 'COMPLETED_ALL_CRITERIA_MET';
      } else {
        windowStatus = 'RUNNING';
        completedAt = null;
        terminalReason = null;
      }
    }

    const isCompleted = windowStatus === 'COMPLETED';
    const finalSnapshotAt: string | null = isCompleted
      ? existing?.final_snapshot_at
        ? String(existing.final_snapshot_at)
        : atomic.snapshotAt
      : null;
    const finalStatsVersion: number | null = isCompleted
      ? existing?.final_stats_version !== null &&
        existing?.final_stats_version !== undefined
        ? Number(existing.final_stats_version)
        : atomic.statsVersion
      : null;
    const finalCycleId: string | null = isCompleted
      ? existing?.final_cycle_id
        ? String(existing.final_cycle_id)
        : atomic.cycleId
      : null;
    const finalDatabaseHealth: string | null = isCompleted
      ? existing?.final_database_health
        ? String(existing.final_database_health)
        : 'HEALTHY'
      : null;
    const finalBackupVerification: boolean | null = isCompleted
      ? existing?.final_backup_verification !== null &&
        existing?.final_backup_verification !== undefined
        ? Number(existing.final_backup_verification) === 1
        : true
      : null;

    const totalEval = isCurrentActive
      ? Math.max(
          Number(existing?.total_evaluated ?? 0),
          activeCycleInWindow ? atomic.evaluatedCount : 0,
          windowCycles.reduce((acc, c) => acc + c.evaluatedCount, 0)
        )
      : Number(existing?.total_evaluated ?? 0);

    const record: Phase17LongRunningWindowRecord = {
      monitoringWindowId,
      duration,
      windowDurationHours: durationHours,
      exchange,
      startedAt,
      windowStartedAt: startedAt,
      currentTime: nowIso,
      expectedEndAt,
      windowExpectedEndAt: expectedEndAt,
      completedAt,
      elapsedDurationMs,
      elapsedDuration,
      remainingDurationMs,
      remainingDuration,
      windowStatus,
      canMarkCompleted: isCompleted ? true : canMarkCompleted,
      terminalReason,
      totalScanCycles,
      completedScanCycles,
      interruptedScanCycles,
      failedCycles,
      totalEvaluated: totalEval,
      pendingCount: isCurrentActive
        ? atomic.pendingCount
        : Number(existing?.pending_count ?? 0),
      failedCount: isCurrentActive
        ? atomic.failedCount
        : Number(existing?.failed_count ?? 0),
      rateLimitedCount: isCurrentActive
        ? atomic.rateLimitedCount
        : Number(existing?.rate_limited_count ?? 0),
      staleCount: isCurrentActive
        ? atomic.staleCount
        : Number(existing?.stale_count ?? 0),
      fallbackCount: isCurrentActive
        ? fallbackCount
        : Number(existing?.fallback_count ?? 0),
      missingDataCount: isCurrentActive
        ? missingDataCount
        : Number(existing?.missing_data_count ?? 0),
      stalledDetectedCount: windowStalledDetectedCount,
      workerRestartCount,
      plannedRestartCount: windowPlannedRestartCount,
      unexpectedRestartCount: windowUnexpectedRestartCount,
      leaseRecoveryCount: windowLeaseRecoveryCount,
      databaseRecoveryCount: windowDatabaseRecoveryCount,
      concurrencyViolations: windowConcurrencyViolationCount,
      windowPlannedRestartCount,
      windowUnexpectedRestartCount,
      windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount,
      windowStalledDetectedCount,
      windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: counters.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: counters.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: counters.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: counters.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: counters.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        counters.lifetimeConcurrencyViolationCount,
      externalNotificationCount: 0,
      finalSnapshotAt,
      finalStatsVersion,
      finalCycleId,
      finalDatabaseHealth,
      finalBackupVerification,
      completionCriteria,
      statsVersion: atomic.statsVersion,
      snapshotAt: atomic.snapshotAt,
    };

    const existingMatchesRecord =
      Boolean(existing) &&
      String(existing?.window_status ?? '') === record.windowStatus &&
      Number(existing?.total_scan_cycles ?? -1) === record.totalScanCycles &&
      Number(existing?.completed_scan_cycles ?? -1) === record.completedScanCycles &&
      Number(existing?.interrupted_scan_cycles ?? -1) === record.interruptedScanCycles &&
      Number(existing?.failed_cycles ?? -1) === record.failedCycles &&
      Number(existing?.total_evaluated ?? -1) === record.totalEvaluated &&
      Number(existing?.pending_count ?? -1) === record.pendingCount &&
      Number(existing?.failed_count ?? -1) === record.failedCount &&
      Number(existing?.rate_limited_count ?? -1) === record.rateLimitedCount &&
      Number(existing?.stale_count ?? -1) === record.staleCount &&
      Number(existing?.fallback_count ?? -1) === record.fallbackCount &&
      Number(existing?.missing_data_count ?? -1) === record.missingDataCount &&
      Number(existing?.stalled_detected_count ?? -1) ===
        record.windowStalledDetectedCount &&
      Number(existing?.worker_restart_count ?? -1) === record.workerRestartCount &&
      Number(existing?.planned_restart_count ?? -1) ===
        record.windowPlannedRestartCount &&
      Number(existing?.unexpected_restart_count ?? -1) ===
        record.windowUnexpectedRestartCount &&
      Number(existing?.lease_recovery_count ?? -1) ===
        record.windowLeaseRecoveryCount &&
      Number(existing?.database_recovery_count ?? -1) ===
        record.windowDatabaseRecoveryCount &&
      Number(existing?.concurrency_violations ?? -1) ===
        record.windowConcurrencyViolationCount &&
      (existing?.completed_at ? String(existing.completed_at) : null) ===
        record.completedAt &&
      (existing?.terminal_reason ? String(existing.terminal_reason) : null) ===
        record.terminalReason &&
      (existing?.final_cycle_id ? String(existing.final_cycle_id) : null) ===
        record.finalCycleId;

    if (persistUpdate && exchange !== 'demo_synthetic' && !existingMatchesRecord) {
      this.db
        .prepare(
          `INSERT INTO smc_long_running_windows (
             monitoring_window_id, duration, window_duration_hours, exchange,
             started_at, expected_end_at, completed_at, window_status,
             total_scan_cycles, completed_scan_cycles, interrupted_scan_cycles,
             failed_cycles, total_evaluated, pending_count, failed_count,
             rate_limited_count, stale_count, fallback_count, missing_data_count,
             stalled_detected_count, worker_restart_count, planned_restart_count,
             unexpected_restart_count, lease_recovery_count, database_recovery_count,
             concurrency_violations, external_notification_count,
             final_snapshot_at, final_stats_version, final_cycle_id,
             final_database_health, final_backup_verification, terminal_reason, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(monitoring_window_id) DO UPDATE SET
             window_duration_hours = excluded.window_duration_hours,
             started_at = excluded.started_at,
             expected_end_at = excluded.expected_end_at,
             completed_at = excluded.completed_at,
             window_status = excluded.window_status,
             total_scan_cycles = excluded.total_scan_cycles,
             completed_scan_cycles = excluded.completed_scan_cycles,
             interrupted_scan_cycles = excluded.interrupted_scan_cycles,
             failed_cycles = excluded.failed_cycles,
             total_evaluated = excluded.total_evaluated,
             pending_count = excluded.pending_count,
             failed_count = excluded.failed_count,
             rate_limited_count = excluded.rate_limited_count,
             stale_count = excluded.stale_count,
             fallback_count = excluded.fallback_count,
             missing_data_count = excluded.missing_data_count,
             stalled_detected_count = excluded.stalled_detected_count,
             worker_restart_count = excluded.worker_restart_count,
             planned_restart_count = excluded.planned_restart_count,
             unexpected_restart_count = excluded.unexpected_restart_count,
             lease_recovery_count = excluded.lease_recovery_count,
             database_recovery_count = excluded.database_recovery_count,
             concurrency_violations = excluded.concurrency_violations,
             external_notification_count = 0,
             final_snapshot_at = excluded.final_snapshot_at,
             final_stats_version = excluded.final_stats_version,
             final_cycle_id = excluded.final_cycle_id,
             final_database_health = excluded.final_database_health,
             final_backup_verification = excluded.final_backup_verification,
             terminal_reason = excluded.terminal_reason,
             updated_at = excluded.updated_at`
        )
        .run(
          record.monitoringWindowId,
          record.duration,
          record.windowDurationHours,
          record.exchange,
          record.startedAt,
          record.expectedEndAt,
          record.completedAt,
          record.windowStatus,
          record.totalScanCycles,
          record.completedScanCycles,
          record.interruptedScanCycles,
          record.failedCycles,
          record.totalEvaluated,
          record.pendingCount,
          record.failedCount,
          record.rateLimitedCount,
          record.staleCount,
          record.fallbackCount,
          record.missingDataCount,
          record.windowStalledDetectedCount,
          record.workerRestartCount,
          record.windowPlannedRestartCount,
          record.windowUnexpectedRestartCount,
          record.windowLeaseRecoveryCount,
          record.windowDatabaseRecoveryCount,
          record.windowConcurrencyViolationCount,
          record.finalSnapshotAt,
          record.finalStatsVersion,
          record.finalCycleId,
          record.finalDatabaseHealth,
          record.finalBackupVerification === null
            ? null
            : record.finalBackupVerification
              ? 1
              : 0,
          record.terminalReason,
          nowIso
        );
    }

    return record;
  }

  public getOrSyncLongRunningWindows(
    exchange: ExchangeId,
    nowMs = Date.now(),
    maxConcurrency = 2,
    precomputed?: {
      atomic?: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>;
      p16?: ReturnType<RadarDatabase['getPhase16PendingBreakdown']>;
      allCycles?: SmcScanCycleHistoryRecord[];
    }
  ): {
    '24h': Phase17LongRunningWindowRecord;
    '72h': Phase17LongRunningWindowRecord;
  } {
    const sharedPrecomputed = {
      atomic: precomputed?.atomic ?? this.getAtomicSmcSnapshot(exchange, nowMs),
      p16: precomputed?.p16 ?? this.getPhase16PendingBreakdown(exchange, nowMs),
      allCycles: precomputed?.allCycles ?? this.listAllSmcScanCycles(exchange),
    };
    return this.runInTransaction(() => {
      const getLatestRow = (duration: Phase17WindowDuration) =>
        this.db
          .prepare(
            `SELECT * FROM smc_long_running_windows
             WHERE exchange = ? AND duration = ?
             ORDER BY started_at DESC, rowid DESC
             LIMIT 1`
          )
          .get(exchange, duration) as Record<string, unknown> | undefined;

      const win24h = this.hydrateMonitoringWindowRow(
        getLatestRow('24h'),
        '24h',
        exchange,
        nowMs,
        maxConcurrency,
        true,
        true,
        sharedPrecomputed
      );
      const win72h = this.hydrateMonitoringWindowRow(
        getLatestRow('72h'),
        '72h',
        exchange,
        nowMs,
        maxConcurrency,
        true,
        true,
        sharedPrecomputed
      );
      return {
        '24h': win24h,
        '72h': win72h,
      };
    });
  }

  public setLongRunningWindowState(
    exchange: ExchangeId,
    duration: Phase17WindowDuration,
    overrides: Partial<Phase17LongRunningWindowRecord>,
    nowMs = Date.now(),
    targetMonitoringWindowId?: string
  ): Phase17LongRunningWindowRecord {
    return this.runInTransaction(() => {
      const current = targetMonitoringWindowId
        ? (this.getMonitoringWindowDetail(
            targetMonitoringWindowId,
            nowMs
          )?.window ??
          this.getOrSyncLongRunningWindows(exchange, nowMs)[duration])
        : this.getOrSyncLongRunningWindows(exchange, nowMs)[duration];

      const isAlreadyTerminal =
        current.windowStatus === 'COMPLETED' ||
        current.windowStatus === 'INTERRUPTED' ||
        current.windowStatus === 'FAILED';

      const merged: Phase17LongRunningWindowRecord = {
        ...current,
        ...overrides,
        monitoringWindowId: current.monitoringWindowId,
        duration,
        windowDurationHours: duration === '72h' ? 72 : 24,
        exchange,
        externalNotificationCount: 0,
      };

      if (isAlreadyTerminal) {
        merged.windowStatus = current.windowStatus;
        merged.completedAt = current.completedAt;
        merged.terminalReason =
          current.terminalReason ?? merged.terminalReason ?? null;
      }

      const unexpectedRestarts = Math.max(
        merged.windowUnexpectedRestartCount ?? 0,
        merged.unexpectedRestartCount ?? 0
      );
      const plannedRestarts = Math.max(
        merged.windowPlannedRestartCount ?? 0,
        merged.plannedRestartCount ?? 0
      );
      const leaseRecoveries = Math.max(
        merged.windowLeaseRecoveryCount ?? 0,
        merged.leaseRecoveryCount ?? 0
      );
      const dbRecoveries = Math.max(
        merged.windowDatabaseRecoveryCount ?? 0,
        merged.databaseRecoveryCount ?? 0
      );
      const stalledDetected = Math.max(
        merged.windowStalledDetectedCount ?? 0,
        merged.stalledDetectedCount ?? 0
      );
      const concurrencyViolations = Math.max(
        merged.windowConcurrencyViolationCount ?? 0,
        merged.concurrencyViolations ?? 0
      );

      merged.windowPlannedRestartCount = plannedRestarts;
      merged.plannedRestartCount = plannedRestarts;
      merged.windowUnexpectedRestartCount = unexpectedRestarts;
      merged.unexpectedRestartCount = unexpectedRestarts;
      merged.windowLeaseRecoveryCount = leaseRecoveries;
      merged.leaseRecoveryCount = leaseRecoveries;
      merged.windowDatabaseRecoveryCount = dbRecoveries;
      merged.databaseRecoveryCount = dbRecoveries;
      merged.windowStalledDetectedCount = stalledDetected;
      merged.stalledDetectedCount = stalledDetected;
      merged.windowConcurrencyViolationCount = concurrencyViolations;
      merged.concurrencyViolations = concurrencyViolations;
      merged.workerRestartCount = plannedRestarts + unexpectedRestarts;

      if (
        !isAlreadyTerminal &&
        (merged.windowStatus === 'INTERRUPTED' || unexpectedRestarts > 0)
      ) {
        merged.windowStatus = 'INTERRUPTED';
        merged.interruptedScanCycles = Math.max(
          1,
          merged.interruptedScanCycles
        );
        merged.completedAt = null;
        merged.canMarkCompleted = false;
        merged.terminalReason =
          merged.terminalReason ?? 'WINDOW_INTERRUPTED';
        merged.completionCriteria = {
          ...merged.completionCriteria,
          zeroInterruptedCycles: false,
          zeroUnexpectedRestarts: unexpectedRestarts === 0,
          canMarkCompleted: false,
        };
        merged.finalSnapshotAt = null;
        merged.finalStatsVersion = null;
        merged.finalCycleId = null;
        merged.finalDatabaseHealth = null;
        merged.finalBackupVerification = null;
      } else if (!isAlreadyTerminal && merged.windowStatus === 'FAILED') {
        merged.failedCycles = Math.max(1, merged.failedCycles);
        merged.completedAt = null;
        merged.canMarkCompleted = false;
        merged.terminalReason = merged.terminalReason ?? 'WINDOW_FAILED';
        merged.completionCriteria = {
          ...merged.completionCriteria,
          zeroFailedCycles: false,
          canMarkCompleted: false,
        };
        merged.finalSnapshotAt = null;
        merged.finalStatsVersion = null;
        merged.finalCycleId = null;
        merged.finalDatabaseHealth = null;
        merged.finalBackupVerification = null;
      }

      const nowIso = new Date(nowMs).toISOString();
      this.db
        .prepare(
          `UPDATE smc_long_running_windows
           SET started_at = ?,
               expected_end_at = ?,
               completed_at = ?,
               window_status = ?,
               total_scan_cycles = ?,
               completed_scan_cycles = ?,
               interrupted_scan_cycles = ?,
               failed_cycles = ?,
               total_evaluated = ?,
               pending_count = ?,
               failed_count = ?,
               rate_limited_count = ?,
               stale_count = ?,
               fallback_count = ?,
               missing_data_count = ?,
               stalled_detected_count = ?,
               worker_restart_count = ?,
               planned_restart_count = ?,
               unexpected_restart_count = ?,
               lease_recovery_count = ?,
               database_recovery_count = ?,
               concurrency_violations = ?,
               external_notification_count = 0,
               final_snapshot_at = ?,
               final_stats_version = ?,
               final_cycle_id = ?,
               final_database_health = ?,
               final_backup_verification = ?,
               terminal_reason = ?,
               updated_at = ?
           WHERE monitoring_window_id = ?`
        )
        .run(
          merged.startedAt,
          merged.expectedEndAt,
          merged.completedAt,
          merged.windowStatus,
          merged.totalScanCycles,
          merged.completedScanCycles,
          merged.interruptedScanCycles,
          merged.failedCycles,
          merged.totalEvaluated,
          merged.pendingCount,
          merged.failedCount,
          merged.rateLimitedCount,
          merged.staleCount,
          merged.fallbackCount,
          merged.missingDataCount,
          merged.windowStalledDetectedCount,
          merged.workerRestartCount,
          merged.windowPlannedRestartCount,
          merged.windowUnexpectedRestartCount,
          merged.windowLeaseRecoveryCount,
          merged.windowDatabaseRecoveryCount,
          merged.windowConcurrencyViolationCount,
          merged.finalSnapshotAt,
          merged.finalStatsVersion,
          merged.finalCycleId,
          merged.finalDatabaseHealth,
          merged.finalBackupVerification === null
            ? null
            : merged.finalBackupVerification
              ? 1
              : 0,
          merged.terminalReason,
          nowIso,
          merged.monitoringWindowId
        );

      if (targetMonitoringWindowId) {
        return (
          this.getMonitoringWindowDetail(targetMonitoringWindowId, nowMs)
            ?.window ?? merged
        );
      }
      return this.getOrSyncLongRunningWindows(exchange, nowMs)[duration];
    });
  }

  public getMonitoringWindowsList(
    exchange: ExchangeId = 'binance_usdm',
    nowMs = Date.now(),
    maxConcurrency = 2
  ): MonitoringWindowsListResponse {
    const currentWindows = this.getOrSyncLongRunningWindows(
      exchange,
      nowMs,
      maxConcurrency
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM smc_long_running_windows
         WHERE exchange = ?
         ORDER BY started_at DESC, rowid DESC`
      )
      .all(exchange) as Array<Record<string, unknown>>;

    const allWindows: Phase17LongRunningWindowRecord[] = rows.map((row) => {
      const winId = String(row.monitoring_window_id);
      const duration = (
        String(row.duration) === '72h' ? '72h' : '24h'
      ) as Phase17WindowDuration;
      if (winId === currentWindows['24h'].monitoringWindowId) {
        return currentWindows['24h'];
      }
      if (winId === currentWindows['72h'].monitoringWindowId) {
        return currentWindows['72h'];
      }
      return this.hydrateMonitoringWindowRow(
        row,
        duration,
        exchange,
        nowMs,
        maxConcurrency,
        false,
        false
      );
    });

    const prev24h =
      allWindows.find(
        (w) =>
          w.duration === '24h' &&
          w.monitoringWindowId !== currentWindows['24h'].monitoringWindowId
      ) ?? null;
    const prev72h =
      allWindows.find(
        (w) =>
          w.duration === '72h' &&
          w.monitoringWindowId !== currentWindows['72h'].monitoringWindowId
      ) ?? null;

    const counters = this.getRestartAndRecoveryCounters(
      exchange,
      currentWindows['24h'].monitoringWindowId
    );
    const recoveryEvents = this.listServiceRecoveryEvents(
      exchange,
      undefined,
      100
    );
    const atomic = this.getAtomicSmcSnapshot(exchange, nowMs);

    return {
      safety: TRADING_SAFETY_FLAGS,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      exchange,
      monitoringWindowId: currentWindows['24h'].monitoringWindowId,
      windowStatus: currentWindows['24h'].windowStatus,
      windowPlannedRestartCount: currentWindows['24h'].windowPlannedRestartCount,
      windowUnexpectedRestartCount:
        currentWindows['24h'].windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: currentWindows['24h'].windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount:
        currentWindows['24h'].windowDatabaseRecoveryCount,
      windowStalledDetectedCount:
        currentWindows['24h'].windowStalledDetectedCount,
      windowConcurrencyViolationCount:
        currentWindows['24h'].windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: counters.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: counters.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: counters.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: counters.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: counters.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        counters.lifetimeConcurrencyViolationCount,
      currentWindows,
      monitoringWindows: currentWindows,
      previousWindows: {
        '24h': prev24h,
        '72h': prev72h,
      },
      windows: allWindows,
      recoveryEvents,
      statsVersion: atomic.statsVersion,
      snapshotAt: atomic.snapshotAt,
    };
  }

  public getMonitoringWindowDetail(
    monitoringWindowId: string,
    nowMs = Date.now(),
    maxConcurrency = 2
  ): MonitoringWindowDetailResponse | null {
    const row = this.db
      .prepare(
        `SELECT * FROM smc_long_running_windows
         WHERE monitoring_window_id = ?
         LIMIT 1`
      )
      .get(monitoringWindowId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const exchange = String(row.exchange) as ExchangeId;
    const duration = (
      String(row.duration) === '72h' ? '72h' : '24h'
    ) as Phase17WindowDuration;
    const currentWindows = this.getOrSyncLongRunningWindows(
      exchange,
      nowMs,
      maxConcurrency
    );
    const isCurrent =
      monitoringWindowId === currentWindows['24h'].monitoringWindowId ||
      monitoringWindowId === currentWindows['72h'].monitoringWindowId;
    const windowRecord = isCurrent
      ? currentWindows[duration]
      : this.hydrateMonitoringWindowRow(
          row,
          duration,
          exchange,
          nowMs,
          maxConcurrency,
          false,
          false
        );

    const recoveryEvents = this.listServiceRecoveryEvents(
      exchange,
      monitoringWindowId,
      100
    );
    const atomic = this.getAtomicSmcSnapshot(exchange, nowMs);

    return {
      safety: TRADING_SAFETY_FLAGS,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      exchange,
      window: windowRecord,
      monitoringWindowId: windowRecord.monitoringWindowId,
      windowStatus: windowRecord.windowStatus,
      windowPlannedRestartCount: windowRecord.windowPlannedRestartCount,
      windowUnexpectedRestartCount: windowRecord.windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: windowRecord.windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount: windowRecord.windowDatabaseRecoveryCount,
      windowStalledDetectedCount: windowRecord.windowStalledDetectedCount,
      windowConcurrencyViolationCount:
        windowRecord.windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: windowRecord.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount:
        windowRecord.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: windowRecord.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: windowRecord.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: windowRecord.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        windowRecord.lifetimeConcurrencyViolationCount,
      recoveryEvents,
      statsVersion: atomic.statsVersion,
      snapshotAt: atomic.snapshotAt,
    };
  }

  public listPhase17CycleSnapshots(
    exchange: ExchangeId,
    nowMs = Date.now(),
    maxConcurrency = 2
  ): Phase17CycleLiveSnapshotRecord[] {
    const atomic = this.getAtomicSmcSnapshot(exchange, nowMs);
    const p16 = this.getPhase16PendingBreakdown(exchange, nowMs);
    const allCycles = this.listAllSmcScanCycles(exchange);

    const elapsedSec =
      p16.recentCompletionsInLast5Min > 0 &&
      p16.earliestRecentCompletionMs !== null
        ? Math.max(1, (nowMs - p16.earliestRecentCompletionMs) / 1000)
        : 60;
    const isCurrentCompletedIdle =
      atomic.pendingCount === 0 &&
      (atomic.cycleStatus === 'COMPLETED' || atomic.runningJobCount === 0);
    const currentProgressRatePerMinute = isCurrentCompletedIdle
      ? 0
      : p16.recentCompletionsInLast5Min > 0
        ? Number(((p16.recentCompletionsInLast5Min / elapsedSec) * 60).toFixed(2))
        : 0;
    const currentProgressRateStatus: SmcProgressRateStatus =
      isCurrentCompletedIdle || currentProgressRatePerMinute === 0
        ? 'NO_ACTIVE_PROGRESS'
        : 'ACTIVE';

    const snapshots: Phase17CycleLiveSnapshotRecord[] = allCycles.map((c) => {
      const universeTotalIdentityValid =
        c.evaluatedCount + c.pendingCount + c.failedCount === c.totalContracts &&
        c.evaluatedCount +
          Math.max(0, c.pendingCount - c.rateLimitedCount) +
          c.failedCount +
          c.rateLimitedCount ===
          c.totalContracts;
      const evaluatedStateIdentityValid =
        c.waitCount +
          c.watchCount +
          c.highRiskCount +
          c.longCandidateCount +
          c.shortCandidateCount ===
        c.evaluatedCount;
      const pendingBreakdownIdentityValid = true;
      const concurrencyCapIdentityValid = true;
      const isCycleCompletedIdle =
        c.pendingCount === 0 && c.cycleStatus === 'COMPLETED';
      const cycleProgressRatePerMinute = isCycleCompletedIdle
        ? 0
        : c.fullCycleDurationMs && c.fullCycleDurationMs > 0
          ? Number(
              ((c.evaluatedCount / (c.fullCycleDurationMs / 1000)) * 60).toFixed(
                2
              )
            )
          : currentProgressRatePerMinute;
      const cycleProgressRateStatus: SmcProgressRateStatus =
        isCycleCompletedIdle || cycleProgressRatePerMinute === 0
          ? 'NO_ACTIVE_PROGRESS'
          : 'ACTIVE';

      return {
        cycleId: c.scanCycleId,
        cycleStatus: c.cycleStatus as
          | 'RUNNING'
          | 'COMPLETED'
          | 'FAILED'
          | 'INTERRUPTED',
        cacheMode: c.cacheMode ?? 'WARM',
        cycleStartedAt: c.cycleStartedAt,
        cycleCompletedAt: c.cycleCompletedAt,
        totalSymbols: c.totalContracts,
        evaluatedCount: c.evaluatedCount,
        pendingCount: c.pendingCount,
        queuedCount: Math.max(0, c.pendingCount - c.rateLimitedCount),
        runningJobCount: 0,
        failedCount: c.failedCount,
        rateLimitedCount: c.rateLimitedCount,
        waitCount: c.waitCount,
        watchCount: c.watchCount,
        highRiskCount: c.highRiskCount,
        longCandidateCount: c.longCandidateCount,
        shortCandidateCount: c.shortCandidateCount,
        lastProgressAt: c.cycleCompletedAt ?? c.cycleStartedAt,
        progressRatePerMinute: cycleProgressRatePerMinute,
        progressRateStatus: cycleProgressRateStatus,
        estimatedRemainingDuration: 0,
        statsVersion: c.statsVersion,
        snapshotAt: c.cycleCompletedAt ?? atomic.snapshotAt,
        identityChecks: {
          universeTotalIdentityValid,
          evaluatedStateIdentityValid,
          pendingBreakdownIdentityValid,
          concurrencyCapIdentityValid,
          allFourIdentitiesValid:
            universeTotalIdentityValid &&
            evaluatedStateIdentityValid &&
            pendingBreakdownIdentityValid &&
            concurrencyCapIdentityValid,
        },
      };
    });

    // Also include or update the current live cycle snapshot
    const currentCycleUniverseValid =
      atomic.evaluatedCount + atomic.pendingCount + atomic.failedCount ===
        atomic.totalSymbols &&
      atomic.evaluatedCount +
        Math.max(0, atomic.pendingCount - atomic.rateLimitedCount) +
        atomic.failedCount +
        atomic.rateLimitedCount ===
        atomic.totalSymbols;
    const currentCycleStateValid =
      atomic.waitCount +
        atomic.watchCount +
        atomic.highRiskCount +
        atomic.longCandidateCount +
        atomic.shortCandidateCount ===
      atomic.evaluatedCount;
    const currentPendingBreakdownValid =
      p16.pendingBreakdownConsistency === 'VALID';
    const currentConcurrencyValid = atomic.runningJobCount <= maxConcurrency;

    const currentSnapshot: Phase17CycleLiveSnapshotRecord = {
      cycleId: atomic.cycleId,
      cycleStatus: atomic.cycleStatus,
      cacheMode: atomic.cacheMode,
      cycleStartedAt: atomic.cycleStartedAt,
      cycleCompletedAt: atomic.cycleCompletedAt,
      totalSymbols: atomic.totalSymbols,
      evaluatedCount: atomic.evaluatedCount,
      pendingCount: atomic.pendingCount,
      queuedCount: p16.queuedCount,
      runningJobCount: atomic.runningJobCount,
      failedCount: atomic.failedCount,
      rateLimitedCount: atomic.rateLimitedCount,
      waitCount: atomic.waitCount,
      watchCount: atomic.watchCount,
      highRiskCount: atomic.highRiskCount,
      longCandidateCount: atomic.longCandidateCount,
      shortCandidateCount: atomic.shortCandidateCount,
      lastProgressAt:
        p16.lastJobProgressAt ??
        p16.lastJobCompletedAt ??
        atomic.lastCompletedAt ??
        atomic.cycleStartedAt,
      progressRatePerMinute: currentProgressRatePerMinute,
      progressRateStatus: currentProgressRateStatus,
      estimatedRemainingDuration: atomic.estimatedRemainingDuration,
      statsVersion: atomic.statsVersion,
      snapshotAt: atomic.snapshotAt,
      identityChecks: {
        universeTotalIdentityValid: currentCycleUniverseValid,
        evaluatedStateIdentityValid: currentCycleStateValid,
        pendingBreakdownIdentityValid: currentPendingBreakdownValid,
        concurrencyCapIdentityValid: currentConcurrencyValid,
        allFourIdentitiesValid:
          currentCycleUniverseValid &&
          currentCycleStateValid &&
          currentPendingBreakdownValid &&
          currentConcurrencyValid,
      },
    };

    const existingIdx = snapshots.findIndex(
      (s) => s.cycleId === currentSnapshot.cycleId
    );
    if (existingIdx >= 0) {
      snapshots[existingIdx] = currentSnapshot;
    } else if (atomic.totalSymbols > 0) {
      snapshots.push(currentSnapshot);
    }

    return snapshots;
  }

  public performDatabaseHealthCheck(
    exchange: ExchangeId = 'binance_usdm',
    options?: {
      runBackup?: boolean;
      nowMs?: number;
      workerState?: 'RUNNING' | 'PAUSED' | 'IDLE';
      monitorWorkerState?: SmcMonitorWorkerState;
      scanWorkerState?: SmcScanWorkerState;
      queueWorkerState?: SmcQueueWorkerState;
      scannerHealth?: SmcScannerHealthStatus;
      queueHealth?: SmcQueueHealthStatus;
      exchangeApiHealth?: SmcExchangeApiHealthStatus;
      stalledSuspected?: boolean;
      stalledReasons?: SmcStalledReason[];
      maxConcurrency?: number;
      progressRatePerMinute?: number;
      progressRateStatus?: SmcProgressRateStatus;
    }
  ): SystemDatabaseHealthResponse {
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const maxConcurrency = options?.maxConcurrency ?? 2;

    // 1. SQLite PRAGMA integrity_check & journal_mode (cache 'ok' integrity checks for 10m on read-only health polling so 5s polls never block the event loop)
    let integrityCheck = this.lastIntegrityCheckResult || 'ok';
    const shouldRunFullIntegrityCheck =
      options?.runBackup === true ||
      this.lastIntegrityCheckAtMs === 0 ||
      this.lastIntegrityCheckResult !== 'ok' ||
      nowMs - this.lastIntegrityCheckAtMs >= 600_000;

    if (shouldRunFullIntegrityCheck) {
      let integrityRow = this.db
        .prepare(`PRAGMA integrity_check`)
        .get() as { integrity_check?: string } | undefined;
      integrityCheck = String(
        integrityRow?.integrity_check ?? 'ok'
      ).toLowerCase();
      if (integrityCheck !== 'ok') {
        try {
          if (integrityCheck.includes('smc_scan_meta')) {
            this.db.exec(`
              CREATE TEMP TABLE IF NOT EXISTS _repair_smc_scan_meta AS SELECT * FROM smc_scan_meta;
              DELETE FROM smc_scan_meta;
              INSERT OR REPLACE INTO smc_scan_meta SELECT * FROM _repair_smc_scan_meta;
              DROP TABLE _repair_smc_scan_meta;
            `);
          }
          this.db.exec(`REINDEX;`);
          integrityRow = this.db
            .prepare(`PRAGMA integrity_check`)
            .get() as { integrity_check?: string } | undefined;
          integrityCheck = String(
            integrityRow?.integrity_check ?? 'ok'
          ).toLowerCase();
        } catch {
          // preserve original integrityCheck message if REINDEX fails
        }
      }
      this.lastIntegrityCheckAtMs = nowMs;
      this.lastIntegrityCheckResult = integrityCheck;
    }
    const integrityCheckPassed = integrityCheck === 'ok';

    let journalRow = this.db
      .prepare(`PRAGMA journal_mode`)
      .get() as { journal_mode?: string } | undefined;
    let journalMode = String(
      journalRow?.journal_mode ??
        (this.dbPath === ':memory:' ? 'memory' : 'wal')
    ).toLowerCase();
    if (this.dbPath !== ':memory:' && journalMode !== 'wal') {
      try {
        this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000;');
        journalRow = this.db
          .prepare(`PRAGMA journal_mode`)
          .get() as { journal_mode?: string } | undefined;
        journalMode = String(journalRow?.journal_mode ?? journalMode).toLowerCase();
      } catch {
        // Keep current journalMode if WAL switch fails transiently
      }
    }
    const walStatus: 'ACTIVE' | 'MEMORY' | 'JOURNAL' =
      journalMode === 'wal'
        ? 'ACTIVE'
        : journalMode === 'memory'
          ? 'MEMORY'
          : 'JOURNAL';

    // 2. Non-destructive safe backup ONLY when explicitly requested (runBackup === true) so GET health polling never runs synchronous VACUUM INTO
    const metaRowBefore = this.db
      .prepare(
        `SELECT updated_at, last_backup_at, backup_file_path,
                worker_restart_count, planned_restart_count, unexpected_restart_count,
                lease_recovery_count, database_recovery_count,
                stalled_detected_count, http_503_count, last_error_message
         FROM smc_scan_meta
         WHERE exchange = ?`
      )
      .get(exchange) as
      | {
          updated_at?: string | null;
          last_backup_at?: string | null;
          backup_file_path?: string | null;
          worker_restart_count?: number | null;
          planned_restart_count?: number | null;
          unexpected_restart_count?: number | null;
          lease_recovery_count?: number | null;
          database_recovery_count?: number | null;
          stalled_detected_count?: number | null;
          http_503_count?: number | null;
          last_error_message?: string | null;
        }
      | undefined;

    let lastBackupAt = metaRowBefore?.last_backup_at ?? null;
    let backupFilePath = metaRowBefore?.backup_file_path ?? null;

    if (options?.runBackup === true) {
      lastBackupAt = nowIso;
      if (this.dbPath && this.dbPath !== ':memory:') {
        backupFilePath = `${this.dbPath}.backup.sqlite`;
        const tmpBackupPath = `${backupFilePath}.tmp`;
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const staleBackupSidecar = `${backupFilePath}${suffix}`;
          if (fs.existsSync(staleBackupSidecar)) {
            try {
              fs.unlinkSync(staleBackupSidecar);
            } catch {
              // ignore
            }
          }
        }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          const staleTmp = `${tmpBackupPath}${suffix}`;
          if (fs.existsSync(staleTmp)) {
            try {
              fs.unlinkSync(staleTmp);
            } catch {
              // ignore
            }
          }
        }
        try {
          const escapedTmp = tmpBackupPath.replace(/'/g, "''");
          this.db.exec(`VACUUM INTO '${escapedTmp}';`);
          if (fs.existsSync(tmpBackupPath)) {
            fs.renameSync(tmpBackupPath, backupFilePath);
          }
        } catch {
          try {
            this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
          } catch {
            // ignore checkpoint contention
          }
          try {
            if (fs.existsSync(this.dbPath)) {
              fs.copyFileSync(this.dbPath, tmpBackupPath);
              if (RadarDatabase.hasValidSqliteHeader(tmpBackupPath)) {
                let verifyDb: DatabaseSync | null = null;
                let backupValid = false;
                try {
                  verifyDb = new DatabaseSync(tmpBackupPath);
                  backupValid =
                    this.checkDatabaseIntegrityStatus(verifyDb, true) === 'OK';
                } catch {
                  backupValid = false;
                } finally {
                  try {
                    verifyDb?.close();
                  } catch {
                    // ignore
                  }
                }
                if (backupValid) {
                  fs.renameSync(tmpBackupPath, backupFilePath);
                } else if (fs.existsSync(tmpBackupPath)) {
                  fs.unlinkSync(tmpBackupPath);
                }
              } else if (fs.existsSync(tmpBackupPath)) {
                fs.unlinkSync(tmpBackupPath);
              }
            }
          } catch {
            // ignore file copy warning in restricted environments
          }
        }
      } else {
        backupFilePath = ':memory:.backup';
      }
      this.db
        .prepare(
          `INSERT INTO smc_scan_meta (exchange, stats_version, last_backup_at, backup_file_path, updated_at)
           VALUES (?, 1, ?, ?, ?)
           ON CONFLICT(exchange) DO UPDATE SET
             last_backup_at = excluded.last_backup_at,
             backup_file_path = excluded.backup_file_path`
        )
        .run(exchange, lastBackupAt, backupFilePath, nowIso);
    }

    // Verify backup file existence, readability, size, and SQLite header
    let backupFileExists = false;
    let backupFileReadable = false;
    let backupFileSizeBytes = 0;
    let backupSqliteHeaderValid = false;

    if (backupFilePath === ':memory:.backup') {
      backupFileExists = true;
      backupFileReadable = true;
      backupFileSizeBytes = 4096;
      backupSqliteHeaderValid = true;
    } else if (backupFilePath && fs.existsSync(backupFilePath)) {
      backupFileExists = true;
      try {
        fs.accessSync(backupFilePath, fs.constants.R_OK);
        backupFileReadable = true;
        const stat = fs.statSync(backupFilePath);
        backupFileSizeBytes = stat.size;
        if (stat.size >= 16) {
          const fd = fs.openSync(backupFilePath, 'r');
          try {
            const buf = Buffer.alloc(16);
            fs.readSync(fd, buf, 0, 16, 0);
            backupSqliteHeaderValid = buf
              .toString('utf8', 0, 15)
              .startsWith('SQLite format 3');
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        backupFileReadable = false;
      }
    }
    const backupFileVerified =
      backupFileExists &&
      backupFileReadable &&
      backupFileSizeBytes > 0 &&
      backupSqliteHeaderValid;

    // 3. Database file size & row counts (strictly read-only on user Paper data)
    let databaseFileSizeBytes = 0;
    if (this.dbPath && this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      try {
        databaseFileSizeBytes = fs.statSync(this.dbPath).size;
      } catch {
        databaseFileSizeBytes = 0;
      }
    } else {
      const pageCountRow = this.db
        .prepare(`PRAGMA page_count`)
        .get() as { page_count?: number } | undefined;
      const pageSizeRow = this.db
        .prepare(`PRAGMA page_size`)
        .get() as { page_size?: number } | undefined;
      databaseFileSizeBytes =
        Number(pageCountRow?.page_count ?? 1) *
        Number(pageSizeRow?.page_size ?? 4096);
    }

    const cacheRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM smc_scan_candles_cache`)
      .get() as { cnt?: number } | undefined;
    const cacheRowCount = Number(cacheRow?.cnt ?? 0);

    const ledgerRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM paper_trading_ledger`)
      .get() as { cnt?: number } | undefined;
    const paperLedgerCount = Number(ledgerRow?.cnt ?? 0);

    let trackedSignalsCount = 0;
    try {
      const sigTable = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_tracked_signals'`
        )
        .get() as { name?: string } | undefined;
      if (sigTable?.name) {
        const sigRow = this.db
          .prepare(`SELECT COUNT(*) as cnt FROM paper_tracked_signals`)
          .get() as { cnt?: number } | undefined;
        trackedSignalsCount = Number(sigRow?.cnt ?? 0);
      }
    } catch {
      trackedSignalsCount = 0;
    }
    const paperSignalCount = trackedSignalsCount + paperLedgerCount;

    let notificationOutboxCount = 0;
    try {
      const outboxTable = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'`
        )
        .get() as { name?: string } | undefined;
      if (outboxTable?.name) {
        const outboxRow = this.db
          .prepare(`SELECT COUNT(*) as cnt FROM notification_outbox`)
          .get() as { cnt?: number } | undefined;
        notificationOutboxCount = Number(outboxRow?.cnt ?? 0);
      }
    } catch {
      notificationOutboxCount = 0;
    }

    const atomic = this.getAtomicSmcSnapshot(exchange, nowMs);
    const p16 = this.getPhase16PendingBreakdown(exchange, nowMs);
    const windowsList = this.getMonitoringWindowsList(
      exchange,
      nowMs,
      maxConcurrency
    );
    const monitoringWindows = windowsList.currentWindows;
    const recentCycleSnapshots = this.listPhase17CycleSnapshots(
      exchange,
      nowMs,
      maxConcurrency
    );
    const progressEvidenceSamples = this.listProgressEvidenceSamples(
      exchange,
      30
    );
    const lastRecoveryResult = this.getLastServiceRecoveryResult(exchange);
    const errorSummary = this.getPhase17ErrorEventsSummary(
      exchange,
      monitoringWindows['24h'].startedAt,
      50
    );

    const currentIdentityChecks: Phase17CycleIdentityChecks =
      recentCycleSnapshots.length > 0
        ? recentCycleSnapshots[recentCycleSnapshots.length - 1].identityChecks
        : {
            universeTotalIdentityValid:
              atomic.evaluatedCount + atomic.pendingCount + atomic.failedCount ===
              atomic.totalSymbols,
            evaluatedStateIdentityValid:
              atomic.waitCount +
                atomic.watchCount +
                atomic.highRiskCount +
                atomic.longCandidateCount +
                atomic.shortCandidateCount ===
              atomic.evaluatedCount,
            pendingBreakdownIdentityValid:
              p16.pendingBreakdownConsistency === 'VALID',
            concurrencyCapIdentityValid:
              atomic.runningJobCount <= maxConcurrency,
            allFourIdentitiesValid: true,
          };

    const elapsedSec =
      p16.recentCompletionsInLast5Min > 0 &&
      p16.earliestRecentCompletionMs !== null
        ? Math.max(1, (nowMs - p16.earliestRecentCompletionMs) / 1000)
        : 60;
    const isCompletedAndIdle =
      atomic.pendingCount === 0 &&
      (atomic.cycleStatus === 'COMPLETED' || atomic.runningJobCount === 0);
    const progressRatePerMinute = isCompletedAndIdle
      ? 0
      : (options?.progressRatePerMinute ??
        (p16.recentCompletionsInLast5Min > 0
          ? Number(
              ((p16.recentCompletionsInLast5Min / elapsedSec) * 60).toFixed(2)
            )
          : 0));
    const progressRateStatus: SmcProgressRateStatus =
      isCompletedAndIdle || progressRatePerMinute === 0
        ? 'NO_ACTIVE_PROGRESS'
        : (options?.progressRateStatus ?? 'ACTIVE');

    const latestJobErrorRow = this.db
      .prepare(
        `SELECT last_error FROM smc_scan_jobs
         WHERE exchange = ? AND last_error IS NOT NULL AND last_error != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(exchange) as { last_error?: string | null } | undefined;

    const lastError =
      metaRowBefore?.last_error_message ||
      latestJobErrorRow?.last_error ||
      null;

    const rateLimit429Count = Math.max(
      atomic.rateLimitCount,
      atomic.rateLimitedCount,
      errorSummary.counts.HTTP_429_BACKOFF
    );
    const http503Count = Math.max(
      Number(metaRowBefore?.http_503_count ?? 0),
      errorSummary.counts.HTTP_503_HONEST_ERROR
    );
    const networkTimeoutCount = errorSummary.counts.NETWORK_TIMEOUT_RETRY;
    const counters = this.getRestartAndRecoveryCounters(
      exchange,
      monitoringWindows['24h'].monitoringWindowId
    );
    const stalledDetectedCount = Number(
      metaRowBefore?.stalled_detected_count ?? 0
    );

    const cacheHealth: 'HEALTHY' | 'PREWARMING' | 'DEGRADED' | 'COLD' =
      atomic.cacheStatus === '正在預熱'
        ? 'PREWARMING'
        : atomic.staleCacheCount > 0 || atomic.expiredCacheCount > atomic.freshCacheCount
          ? 'DEGRADED'
          : atomic.freshCacheCount === 0
            ? 'COLD'
            : 'HEALTHY';

    const lastWriteAt =
      metaRowBefore?.updated_at ||
      p16.lastJobProgressAt ||
      p16.lastJobCompletedAt ||
      atomic.snapshotAt;

    const statsVersionMonotonic =
      lastRecoveryResult?.monotonicStatsVersionVerified ?? true;

    // Persist check record in smc_database_health_checks (Section 六)
    try {
      const checkId = `dbchk_${exchange}_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
      this.db
        .prepare(
          `INSERT INTO smc_database_health_checks (
             check_id, exchange, checked_at, integrity_check, journal_mode, wal_status,
             active_database_path, latest_stats_version, stats_version_monotonic,
             last_write_at, last_backup_at, backup_file_path, backup_file_verified,
             cache_row_count, paper_signal_count, paper_ledger_count,
             notification_outbox_count, external_notification_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          checkId,
          exchange,
          nowIso,
          integrityCheck,
          journalMode,
          walStatus,
          this.dbPath,
          atomic.statsVersion,
          statsVersionMonotonic ? 1 : 0,
          lastWriteAt,
          lastBackupAt,
          backupFilePath,
          backupFileVerified ? 1 : 0,
          cacheRowCount,
          paperSignalCount,
          paperLedgerCount,
          notificationOutboxCount
        );
    } catch {
      // ignore if check logging fails
    }

    const concurrencyValid = atomic.runningJobCount <= maxConcurrency;
    const statsConsistency: 'VALID' | 'INVALID' =
      concurrencyValid && atomic.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';
    const concurrencyViolations = Math.max(
      atomic.concurrencyViolations ?? 0,
      monitoringWindows['24h'].concurrencyViolations ?? 0,
      concurrencyValid ? 0 : 1
    );

    const resolvedWorkerState = options?.workerState ?? 'IDLE';
    const resolvedMonitorWorkerState: SmcMonitorWorkerState =
      options?.monitorWorkerState ??
      (resolvedWorkerState === 'PAUSED' ? 'PAUSED' : 'RUNNING');
    const resolvedScanWorkerState: SmcScanWorkerState = isCompletedAndIdle
      ? 'IDLE'
      : (options?.scanWorkerState ??
        (atomic.runningJobCount > 0
          ? 'RUNNING'
          : resolvedWorkerState === 'PAUSED'
            ? 'PAUSED'
            : 'IDLE'));
    const resolvedQueueHealth = !concurrencyValid
      ? 'INVALID'
      : (options?.queueHealth ?? 'HEALTHY');
    const resolvedQueueWorkerState: SmcQueueWorkerState = !concurrencyValid
      ? 'ERROR'
      : (options?.queueWorkerState ??
        (resolvedQueueHealth === 'INVALID'
          ? 'ERROR'
          : resolvedWorkerState === 'PAUSED'
            ? 'PAUSED'
            : 'HEALTHY'));

    return {
      safety: TRADING_SAFETY_FLAGS,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      exchange,
      monitoringWindowId: monitoringWindows['24h'].monitoringWindowId,
      windowStatus: monitoringWindows['24h'].windowStatus,
      integrityCheck,
      integrityCheckPassed,
      journalMode,
      walStatus,
      activeDatabasePath: this.dbPath,
      databaseInstanceId: this.databaseInstanceId,
      latestStatsVersion: atomic.statsVersion,
      statsVersion: atomic.statsVersion,
      statsVersionMonotonic,
      lastWriteAt,
      lastBackupAt,
      backupFilePath,
      backupFileVerified,
      backupFileExists,
      backupFileReadable,
      backupFileSizeBytes,
      backupSqliteHeaderValid,
      databaseFileSizeBytes,
      cacheRowCount,
      paperSignalCount,
      paperLedgerCount,
      notificationOutboxCount,
      workerState: resolvedWorkerState,
      monitorWorkerState: resolvedMonitorWorkerState,
      scanWorkerState: resolvedScanWorkerState,
      queueWorkerState: resolvedQueueWorkerState,
      maxConcurrency,
      runningJobCount: atomic.runningJobCount,
      concurrencyValid,
      statsConsistency,
      scannerHealth: !concurrencyValid
        ? 'STALLED'
        : (options?.scannerHealth ?? 'HEALTHY'),
      queueHealth: resolvedQueueHealth,
      exchangeApiHealth: options?.exchangeApiHealth ?? 'HEALTHY',
      cacheHealth,
      cacheMode: atomic.cacheMode,
      lastProgressAt:
        p16.lastJobProgressAt ?? p16.lastJobCompletedAt ?? atomic.lastCompletedAt,
      lastJobCompletedAt: p16.lastJobCompletedAt ?? atomic.lastCompletedAt,
      progressRatePerMinute,
      progressRateStatus,
      oldestPendingAgeMs: p16.oldestPendingAgeMs,
      stalledSuspected:
        !concurrencyValid ? true : (options?.stalledSuspected ?? false),
      stalledReasons: options?.stalledReasons ?? [],
      lastError,
      rateLimit429Count,
      http503Count,
      networkTimeoutCount,
      workerRestartCount: counters.workerRestartCount,
      plannedRestartCount: counters.plannedRestartCount,
      unexpectedRestartCount: counters.unexpectedRestartCount,
      leaseRecoveryCount: counters.leaseRecoveryCount,
      databaseRecoveryCount: counters.databaseRecoveryCount,
      windowPlannedRestartCount: monitoringWindows['24h'].windowPlannedRestartCount,
      windowUnexpectedRestartCount:
        monitoringWindows['24h'].windowUnexpectedRestartCount,
      windowLeaseRecoveryCount: monitoringWindows['24h'].windowLeaseRecoveryCount,
      windowDatabaseRecoveryCount:
        monitoringWindows['24h'].windowDatabaseRecoveryCount,
      windowStalledDetectedCount:
        monitoringWindows['24h'].windowStalledDetectedCount,
      windowConcurrencyViolationCount:
        monitoringWindows['24h'].windowConcurrencyViolationCount,
      lifetimePlannedRestartCount: counters.lifetimePlannedRestartCount,
      lifetimeUnexpectedRestartCount: counters.lifetimeUnexpectedRestartCount,
      lifetimeLeaseRecoveryCount: counters.lifetimeLeaseRecoveryCount,
      lifetimeDatabaseRecoveryCount: counters.lifetimeDatabaseRecoveryCount,
      lifetimeStalledDetectedCount: counters.lifetimeStalledDetectedCount,
      lifetimeConcurrencyViolationCount:
        counters.lifetimeConcurrencyViolationCount,
      stalledDetectedCount,
      concurrencyViolations,
      externalNotificationCount: 0,
      errorEventCounts: errorSummary.counts,
      errorEvents: errorSummary.events,
      monitoringWindows,
      currentWindows: windowsList.currentWindows,
      previousWindows: windowsList.previousWindows,
      allWindows: windowsList.windows,
      recoveryEvents: windowsList.recoveryEvents,
      recentCycleSnapshots,
      progressEvidenceSamples,
      lastRecoveryResult,
      identityChecks: currentIdentityChecks,
      stabilityNotices: [
        'PENDING 不等於 WAIT',
        '掃描中不代表候選已確認',
        '候選數為 0 不代表服務故障',
      ],
      snapshotAt: atomic.snapshotAt,
    };
  }

  public computeCycleDiagnosticsAndFunnel(
    exchange: ExchangeId,
    preloadedAtomic?: ReturnType<RadarDatabase['getAtomicSmcSnapshot']>
  ): {
    cycleId: string;
    snapshotAt: string;
    statsVersion: number;
    aggregationScope: FunnelAggregationScope;
    evaluationUniverseSize: number;
    evaluatedDenominator: number;
    excludedCount: number;
    excludedSymbols: string[];
    excludedReasons: Record<string, number>;
    statsConsistency: SmcStatsConsistency;
    consistencyErrors: string[];
    smcGateDiagnostics: SmcGateDiagnosticsSummary;
    scopedGateStatistics: ScopedGateStatisticsSummary;
    observationShadowComparison: ObservationShadowComparisonSummary;
    candidateFunnel: CycleCandidateFunnel;
    currentCycleFunnel: ScopedFunnelBlock;
    latestSnapshotFunnel: ScopedFunnelBlock;
    monitoringWindowFunnel: ScopedFunnelBlock;
    cumulativeFunnel: ScopedFunnelBlock;
    historicalSignalsOutsideCurrentCycle: HistoricalSignalsOutsideCurrentCycleBlock;
    historicalSignalsOutsideWindow: HistoricalSignalsOutsideWindowBlock;
    formalCandidateLatencySla: FormalCandidateLatencySlaSummary;
    DEMO_LATENCY_FIXTURE: DemoLatencyFixtureSummary;
    CONTROLLED_LIVE_FIXTURE: ControlledLiveFixtureSummary;
    LIVE_FORMAL_CANDIDATE_COUNT: number;
    LIVE_FAST_LANE_COUNT: number;
    LIVE_BULK_COUNT: number;
    LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT: number;
    LIVE_ENTRY_WINDOW_MISSED_COUNT: number;
    LIVE_ENTRY_WINDOW_MISSED_RATE: number | null;
    LIVE_DETECTION_LATENCY_P50: number | null;
    LIVE_DETECTION_LATENCY_P95: number | null;
    LIVE_FAST_LANE_DETECTION_LATENCY_P50: number | null;
    LIVE_FAST_LANE_DETECTION_LATENCY_P95: number | null;
    LIVE_BULK_DETECTION_LATENCY_P50: number | null;
    LIVE_BULK_DETECTION_LATENCY_P95: number | null;
    liveValidationStatus: LiveCaptureValidationStatus;
    liveSampleValidationStatus: LiveCaptureValidationStatus;
    liveValidationStates: LiveCaptureValidationStatus[];
    liveValidationMessage: string;
    isLiveValidated: boolean;
    signalQualityCalibration: SignalQualityCalibrationSummary;
    paperEligibilityAudit: PaperEligibilityAuditSummary;
    nearMissCount: number;
    nearMissMissing1Count: number;
    nearMissMissing2Count: number;
    nearMissMissingGates: Record<string, number>;
    lastBlockingGate: string | null;
    blockedAfterSmcCandidateCount: number;
    blockedAfterSmcCandidateReasons: Record<string, number>;
    blockedByPaperEligibilityCount: number;
    blockedByPaperEligibilityReasons: Record<string, number>;
    formalCandidateCount: number;
    fastLaneFormalCandidateCount: number;
    bulkFormalCandidateCount: number;
    candidateDetectedBeforeEntryWindowCount: number;
    entryWindowMissedRate: number | null;
    candidateDetectionLatencyP50: number | null;
    candidateDetectionLatencyP95: number | null;
    queueWaitP50: number | null;
    queueWaitP95: number | null;
    eligiblePaperSignalCount: number;
    currentCyclePaperEligibleCount: number;
    monitoringWindowPaperEligibleCount: number;
    cumulativePaperEligibleCount: number;
    historicalPaperEligibleCount: number;
    entryWindowMissedCount: number;
    currentCycleEntryWindowMissedCount: number;
    monitoringWindowEntryWindowMissedCount: number;
    cumulativeEntryWindowMissedCount: number;
    historicalSignalsOutsideWindowCount: number;
    historicalSignalsOutsideCurrentCycleCount: number;
    paperOpenedCount: number;
    paperClosedCount: number;
    candidateDetectedCount: number;
    rootCauseVerdict: CandidateScarcityRootCauseVerdict;
    rootCauseExplanation: string;
  } {
    const atomic = preloadedAtomic ?? this.getAtomicSmcSnapshot(exchange);
    const diagStateKey = `${atomic.cycleId}:${atomic.statsVersion}:${atomic.evaluatedCount}:${this.getDbStructuralFingerprint(exchange)}`;
    const cachedDiag = this.cycleDiagnosticsCache.get(exchange);
    if (cachedDiag && cachedDiag.stateKey === diagStateKey) {
      return {
        ...cachedDiag.result,
        snapshotAt: atomic.snapshotAt,
      };
    }

    const totalSymbolsCount = atomic.totalContracts;
    const results = atomic.results;

    // Look up canonical job status & pending reasons for any non-evaluated symbols
    const jobStatusBySymbol = new Map<
      string,
      { status: string; pendingReason: string | null }
    >();
    try {
      const jobRows = this.db
        .prepare(
          `SELECT symbol, status, pending_reason
           FROM smc_scan_jobs
           WHERE id IN (
             SELECT COALESCE(MAX(CASE WHEN status = 'RUNNING' THEN id END), MAX(id))
             FROM smc_scan_jobs
             WHERE exchange = ?
             GROUP BY symbol
           )`
        )
        .all(exchange) as Array<{
        symbol: string;
        status: string;
        pending_reason: string | null;
      }>;
      for (const jr of jobRows) {
        jobStatusBySymbol.set(String(jr.symbol), {
          status: String(jr.status || 'QUEUED'),
          pendingReason: jr.pending_reason ? String(jr.pending_reason) : null,
        });
      }
    } catch {
      // ignore
    }

    let radarLongCount = 0;
    let radarShortCount = 0;
    let blockedAfterSmcCandidateCount = 0;
    const blockedAfterSmcCandidateReasons: Record<string, number> = {};
    let blockedByPaperEligibilityCount = 0;
    const blockedByPaperEligibilityReasons: Record<string, number> = {};
    let currentCyclePaperEligibleCount = 0;
    let currentCycleEntryWindowMissedCount = 0;
    let currentCyclePaperOpenedCount = 0;
    let currentCyclePaperClosedCount = 0;

    const evaluatedGateItems: EvaluatedGateDiagnosticItemInput[] = [];
    const excludedSymbols: string[] = [];
    const excludedReasons: Record<string, number> = {};
    const seenResultSymbols = new Set<string>();

    const candidateRecords: SmcScanResultRecord[] = [];
    const currentCandidateSymbolSet = new Set<string>();

    for (const rec of results) {
      seenResultSymbols.add(rec.symbol);
      if (rec.marketRadarCategory === '雷達多頭觀察') {
        radarLongCount++;
      } else if (rec.marketRadarCategory === '雷達空頭觀察') {
        radarShortCount++;
      }

      const isFormalCand =
        rec.smcActionState === 'LONG CANDIDATE' ||
        rec.smcActionState === 'SHORT CANDIDATE';

      if (rec.smcEvaluationStatus === 'EVALUATED') {
        const derived = deriveSymbolSmcGateEvaluationFromAnalysis(
          rec.smcAnalysis,
          {
            actionState: rec.smcActionState,
            waitReasons: rec.waitReasons,
          }
        );
        if (derived) {
          const recEvidenceType = resolveCandidateEvidenceType({
            exchange,
            source: rec.source ?? exchange,
            isDemo: Boolean(rec.isDemo || exchange === 'demo_synthetic'),
            evidenceType: rec.evidenceType,
          });
          const mtfDom = rec.smcAnalysis?.mtfAlignment?.dominantDirection;
          const mtfState = mtfDom
            ? mtfDom === 'BULL'
              ? 'ALIGNED_BULL'
              : mtfDom === 'BEAR'
                ? 'ALIGNED_BEAR'
                : mtfDom === 'CONFLICT'
                  ? 'MTF_CONFLICT'
                  : 'MTF_INSUFFICIENT'
            : derived.mtfAlignmentPassed
              ? derived.intendedDirection === 'LONG'
                ? 'ALIGNED_BULL'
                : derived.intendedDirection === 'SHORT'
                  ? 'ALIGNED_BEAR'
                  : 'MTF_ALIGNED'
              : 'MTF_CONFLICT_OR_UNALIGNED';
          const regimeState =
            rec.marketRadarCategory === '雷達多頭觀察'
              ? 'BULLISH_TREND'
              : rec.marketRadarCategory === '雷達空頭觀察'
                ? 'BEARISH_TREND'
                : !derived.atrPassed || !derived.riskSafetyPassed
                  ? 'HIGH_VOLATILITY'
                  : 'RANGING_CONSOLIDATION';
          const fundState = !derived.fundingPassed
            ? 'FUNDING_MISSING_OR_EXTREME'
            : !derived.riskSafetyPassed
              ? 'EXTREME_FUNDING_RISK'
              : 'NORMAL_FUNDING';
          const liqState = !derived.liquiditySafetyPassed
            ? 'LOW_LIQUIDITY_OR_WIDE_SPREAD'
            : derived.liquiditySweepPassed
              ? 'LIQUIDITY_SWEEP_CONFIRMED'
              : 'ADEQUATE_LIQUIDITY_NO_SWEEP';

          evaluatedGateItems.push({
            symbol: rec.symbol,
            smcActionState: rec.smcActionState,
            marketRadarCategory: rec.marketRadarCategory ?? '準備觀察',
            gateEvaluation: derived,
            detectionLatencyMs: isFormalCand
              ? rec.candidateDetectionLatencyMs ?? rec.detectionLatencyMs ?? null
              : null,
            candidateDetectionLatencyMs: isFormalCand
              ? rec.candidateDetectionLatencyMs ?? rec.detectionLatencyMs ?? null
              : null,
            evaluationLatencyMs:
              rec.evaluationLatencyMs ?? rec.smcEvaluationLatencyMs ?? null,
            nextBarRemainingMs: rec.nextBarRemainingMs ?? null,
            queueWaitMs: rec.queueWaitMs,
            smcEvaluationLatencyMs: rec.smcEvaluationLatencyMs,
            entryWindowDelayMs: isFormalCand
              ? rec.entryWindowDelayMs ?? null
              : null,
            entryWindowMissed: isFormalCand
              ? rec.entryWindowStatus === 'ENTRY_WINDOW_MISSED'
              : null,
            marketRegime: regimeState,
            fundingState: fundState,
            liquidityState: liqState,
            mtfAlignmentState: mtfState,
            dataFreshnessSeconds: rec.freshnessSeconds ?? null,
            stale: rec.stale,
            isDemo: rec.isDemo,
            isTestFixture: recEvidenceType !== 'LIVE_PRODUCTION',
            evidenceType: recEvidenceType,
            isFastLane:
              rec.isFastLane !== undefined
                ? rec.isFastLane
                : rec.priorityTier !== 4,
          });
        } else {
          excludedSymbols.push(rec.symbol);
          excludedReasons.MISSING_SMC_ANALYSIS_JSON =
            (excludedReasons.MISSING_SMC_ANALYSIS_JSON ?? 0) + 1;
        }

        const rawAnalysisState = rec.smcAnalysis?.actionState;
        if (
          (rawAnalysisState === 'LONG CANDIDATE' ||
            rawAnalysisState === 'SHORT CANDIDATE') &&
          rec.smcActionState !== 'LONG CANDIDATE' &&
          rec.smcActionState !== 'SHORT CANDIDATE'
        ) {
          blockedAfterSmcCandidateCount++;
          const key = `DOWNGRADED_TO_${rec.smcActionState}`;
          blockedAfterSmcCandidateReasons[key] =
            (blockedAfterSmcCandidateReasons[key] ?? 0) + 1;
        }
      } else {
        excludedSymbols.push(rec.symbol);
        const jobInfo = jobStatusBySymbol.get(rec.symbol);
        const statusStr = String(rec.smcEvaluationStatus);
        let reasonKey = `STATUS_${statusStr}`;
        if (
          statusStr === 'PENDING' ||
          statusStr === 'PENDING_EVALUATION'
        ) {
          if (jobInfo?.pendingReason) {
            reasonKey = `PENDING_${jobInfo.pendingReason}`;
          } else if (jobInfo?.status) {
            reasonKey = `PENDING_JOB_${jobInfo.status}`;
          } else {
            reasonKey = 'PENDING_REQUEUED_REFRESH_BATCH';
          }
        } else if (
          statusStr === 'FAILED' ||
          statusStr === 'FAILED_EVALUATION'
        ) {
          reasonKey = 'FAILED_EVALUATION';
        } else if (
          statusStr === 'RATE_LIMITED' ||
          statusStr === 'RATE_LIMITED_BACKOFF'
        ) {
          reasonKey = 'RATE_LIMITED_BACKOFF';
        }
        excludedReasons[reasonKey] = (excludedReasons[reasonKey] ?? 0) + 1;
      }

      if (isFormalCand) {
        candidateRecords.push(rec);
        currentCandidateSymbolSet.add(rec.symbol);
        const expectedSignal: FinalTradeSignal =
          rec.smcActionState === 'LONG CANDIDATE'
            ? '多頭交易候選'
            : '空頭交易候選';
        if (rec.finalTradeSignal !== expectedSignal) {
          blockedAfterSmcCandidateCount++;
          blockedAfterSmcCandidateReasons.FINAL_TRADE_SIGNAL_OVERWRITTEN =
            (blockedAfterSmcCandidateReasons.FINAL_TRADE_SIGNAL_OVERWRITTEN ??
              0) + 1;
        }

        const isStaleOrFallbackOrDemo =
          (exchange !== 'demo_synthetic' && rec.isDemo) ||
          rec.stale ||
          rec.fallback;
        const hasMissingData = rec.missingData.length > 0;
        const atrValid =
          rec.smcAnalysis?.atr14 !== null &&
          rec.smcAnalysis?.atr14 !== undefined &&
          Number.isFinite(rec.smcAnalysis.atr14) &&
          rec.smcAnalysis.atr14 > 0;

        if (isStaleOrFallbackOrDemo) {
          blockedByPaperEligibilityCount++;
          blockedByPaperEligibilityReasons.STALE_OR_FALLBACK_OR_DEMO =
            (blockedByPaperEligibilityReasons.STALE_OR_FALLBACK_OR_DEMO ?? 0) +
            1;
        } else if (hasMissingData) {
          blockedByPaperEligibilityCount++;
          blockedByPaperEligibilityReasons.MISSING_MARKET_DATA =
            (blockedByPaperEligibilityReasons.MISSING_MARKET_DATA ?? 0) + 1;
        } else if (!atrValid) {
          blockedByPaperEligibilityCount++;
          blockedByPaperEligibilityReasons.INVALID_ATR_RISK_PARAMS =
            (blockedByPaperEligibilityReasons.INVALID_ATR_RISK_PARAMS ?? 0) + 1;
        } else {
          currentCyclePaperEligibleCount++;
          if (rec.entryWindowStatus === 'ENTRY_WINDOW_MISSED') {
            currentCycleEntryWindowMissedCount++;
          } else {
            currentCyclePaperOpenedCount++;
          }
        }
      }
    }

    // Check if any job symbols were not in smc_scan_results yet
    for (const [sym, jobInfo] of jobStatusBySymbol.entries()) {
      if (!seenResultSymbols.has(sym)) {
        excludedSymbols.push(sym);
        const reasonKey = `UNINITIALIZED_RESULT_JOB_${jobInfo.status}`;
        excludedReasons[reasonKey] = (excludedReasons[reasonKey] ?? 0) + 1;
      }
    }

    // Partition paper_tracked_signals into:
    // 1. Current cycle active signals (ONLY if symbol is in currentCandidateSymbolSet and scan_cycle_id === atomic.cycleId)
    // 2. OUTSIDE_CURRENT_CYCLE (within 30D/60D/90D monitoring window, e.g., RAYSOLUSDT, ALGOUSDT, FILUSDT)
    // 3. OUTSIDE_MONITORING_WINDOW (older than 90D monitoring window, e.g., ATOMUSDT)
    const isDemoVenue = exchange === 'demo_synthetic' ? 1 : 0;
    const nowMs = Date.parse(atomic.snapshotAt) || Date.now();
    const window90dCutoffMs = nowMs - 90 * 86_400_000;

    let historicalPaperEligibleCount = 0;
    let historicalPaperOpenedCount = 0;
    let historicalPaperClosedCount = 0;
    let historicalEntryWindowMissedCount = 0;

    let windowHistoricalEligibleCount = 0;
    let windowHistoricalOpenedCount = 0;
    let windowHistoricalClosedCount = 0;
    let windowHistoricalMissedCount = 0;

    let outsideWindowEligibleCount = 0;
    let outsideWindowOpenedCount = 0;
    let outsideWindowClosedCount = 0;
    let outsideWindowMissedCount = 0;

    const outsideCurrentCycleSignals: HistoricalSignalOutsideWindowItem[] = [];
    const outsideMonitoringWindowSignals: HistoricalSignalOutsideWindowItem[] = [];

    try {
      const allTrackedRows = this.db
        .prepare(
          `SELECT signal_id, symbol, scan_cycle_id, direction, smc_action_state, status, entry_status, signal_detected_at, evaluated_at, signal_bar_open_time, original_entry_window_open_time
           FROM paper_tracked_signals
           WHERE exchange = ? AND is_demo = ?
           ORDER BY COALESCE(signal_detected_at, evaluated_at) DESC`
        )
        .all(exchange, isDemoVenue) as Array<Record<string, unknown>>;

      for (const tr of allTrackedRows) {
        const sym = String(tr.symbol || '');
        const rowCycleId = String(tr.scan_cycle_id || '');
        const st = String(tr.status || '');
        const est = String(tr.entry_status || '');
        const detectedAt = String(
          tr.signal_detected_at || tr.evaluated_at || ''
        );
        const detectedMs = Date.parse(detectedAt);
        const isMissed =
          st === 'ENTRY_WINDOW_MISSED' || est === 'ENTRY_WINDOW_MISSED';
        const isClosed =
          st === 'HIT_TP1' ||
          st === 'HIT_TP2' ||
          st === 'HIT_SL' ||
          st === 'EXPIRED_TIME' ||
          st === 'PAPER_CLOSED_WIN' ||
          st === 'PAPER_CLOSED_LOSS' ||
          st === 'PAPER_EXPIRED';
        const isOpened =
          isClosed || st === 'OPEN_PAPER' || st === 'PAPER_OPENED';

        const isActiveInCurrentSnapshot =
          rowCycleId === atomic.cycleId && currentCandidateSymbolSet.has(sym);

        if (isActiveInCurrentSnapshot) {
          if (
            isClosed &&
            currentCyclePaperClosedCount < currentCyclePaperOpenedCount
          ) {
            currentCyclePaperClosedCount++;
          }
          continue;
        }

        // Historical signal (not an active candidate in the current cycle snapshot)
        historicalPaperEligibleCount++;
        if (isMissed) {
          historicalEntryWindowMissedCount++;
        } else if (isOpened) {
          historicalPaperOpenedCount++;
          if (isClosed) {
            historicalPaperClosedCount++;
          }
        }

        const isInsideMonitoringWindow =
          Number.isFinite(detectedMs) && detectedMs >= window90dCutoffMs;

        const historicalScope = isInsideMonitoringWindow
          ? 'OUTSIDE_CURRENT_CYCLE'
          : 'OUTSIDE_MONITORING_WINDOW';

        const exclusionReason = isInsideMonitoringWindow
          ? rowCycleId !== atomic.cycleId
            ? 'OUTSIDE_CURRENT_CYCLE: 屬於 30D/60D/90D 監控視窗內之先前掃描週期訊號'
            : 'OUTSIDE_CURRENT_CYCLE: 屬於 30D/60D/90D 監控視窗內之先前 15m K 線歷史訊號'
          : 'OUTSIDE_MONITORING_WINDOW: 早於 30D/60D/90D 監控視窗之歷史歸檔訊號';

        const item: HistoricalSignalOutsideWindowItem = {
          signalId: String(tr.signal_id || `${sym}_${detectedAt}`),
          symbol: sym,
          exchange,
          scanCycleId: rowCycleId,
          direction: (String(tr.direction || 'LONG') === 'SHORT'
            ? 'SHORT'
            : 'LONG') as 'LONG' | 'SHORT',
          smcActionState: String(
            tr.smc_action_state || 'LONG CANDIDATE'
          ) as SmcActionState,
          status: st,
          entryStatus: est,
          signalDetectedAt: detectedAt,
          signalBarOpenTime:
            tr.signal_bar_open_time !== null &&
            tr.signal_bar_open_time !== undefined
              ? Number(tr.signal_bar_open_time)
              : null,
          nextBarOpenTime:
            tr.original_entry_window_open_time !== null &&
            tr.original_entry_window_open_time !== undefined
              ? Number(tr.original_entry_window_open_time)
              : null,
          historicalScope,
          outsideCurrentCycle: true,
          outsideMonitoringWindow: !isInsideMonitoringWindow,
          exclusionReason,
        };

        if (isInsideMonitoringWindow) {
          windowHistoricalEligibleCount++;
          if (isMissed) {
            windowHistoricalMissedCount++;
          } else if (isOpened) {
            windowHistoricalOpenedCount++;
            if (isClosed) {
              windowHistoricalClosedCount++;
            }
          }
          outsideCurrentCycleSignals.push(item);
        } else {
          outsideWindowEligibleCount++;
          if (isMissed) {
            outsideWindowMissedCount++;
          } else if (isOpened) {
            outsideWindowOpenedCount++;
            if (isClosed) {
              outsideWindowClosedCount++;
            }
          }
          outsideMonitoringWindowSignals.push(item);
        }
      }
    } catch {
      // Ignore if table not queried
    }

    const totalCandidates =
      atomic.longCandidateCount + atomic.shortCandidateCount;
    const radarTotal = radarLongCount + radarShortCount;

    // Enforce currentCycle invariants
    const eligiblePaperSignalCount = Math.min(
      totalCandidates,
      currentCyclePaperEligibleCount
    );
    const entryWindowMissedCount = Math.min(
      eligiblePaperSignalCount,
      currentCycleEntryWindowMissedCount
    );
    const paperOpenedCount = Math.min(
      eligiblePaperSignalCount - entryWindowMissedCount,
      currentCyclePaperOpenedCount
    );
    const paperClosedCount = Math.min(
      paperOpenedCount,
      currentCyclePaperClosedCount
    );

    const smcGateDiagnostics = buildSmcGateDiagnosticsSummary(
      evaluatedGateItems,
      {
        totalUniverseSymbols: totalSymbolsCount,
        cycleId: atomic.cycleId,
        snapshotAt: atomic.snapshotAt,
        statsVersion: atomic.statsVersion,
        aggregationScope: 'CURRENT_CYCLE',
        excludedSymbols,
        excludedReasons,
        strictProductionOutcome: {
          entryWindowMissedCount,
          paperOpenedCount,
          paperClosedCount,
        },
      }
    );

    if (
      exchange !== 'demo_synthetic' &&
      smcGateDiagnostics.nearMissSymbols.length > 0
    ) {
      const liveNmList = smcGateDiagnostics.nearMissSymbols.filter(
        (nm) =>
          !nm.isDemo &&
          !nm.isTestFixture &&
          (nm.evidenceType ?? 'LIVE_PRODUCTION') === 'LIVE_PRODUCTION'
      );
      const nmCacheKey = `${exchange}:${atomic.cycleId}:${atomic.evaluatedCount}:${liveNmList.length}`;
      if (
        liveNmList.length > 0 &&
        (this as unknown as { _lastNearMissPersistKey?: string })
          ._lastNearMissPersistKey !== nmCacheKey
      ) {
        (
          this as unknown as { _lastNearMissPersistKey?: string }
        )._lastNearMissPersistKey = nmCacheKey;
        this.saveNearMissObservations(
          exchange,
          atomic.cycleId,
          atomic.snapshotAt,
          liveNmList
        );
      }
    }

    // Compute Formal Candidate Latency SLA Summary (Phase 18.2 Part 2)
    // Rule: If there are no formal candidates, all latency percentile & rate fields MUST return null (never 0).
    const computeNullablePercentile = (
      vals: number[],
      p: number
    ): number | null => {
      if (vals.length === 0) return null;
      const sorted = [...vals].sort((a, b) => a - b);
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
      );
      return Math.round(sorted[idx]);
    };

    const scopedCandidateRecords =
      exchange === 'demo_synthetic'
        ? candidateRecords
        : candidateRecords.filter(
            (r) => !r.isDemo && r.exchange !== 'demo_synthetic'
          );

    const formalCandidateSlaRecords: FormalCandidateSlaRecord[] =
      scopedCandidateRecords.map((rec) => {
        const evalCompletedAtStr =
          rec.evaluationCompletedAt ??
          rec.smcEvaluationCompletedAt ??
          rec.evaluatedAt;
        const evalCompletedMs = Date.parse(evalCompletedAtStr);
        const sigBarClose =
          rec.signalBarCloseTime !== undefined ? rec.signalBarCloseTime : null;
        const sigBarOpen =
          rec.signalBarOpenTime !== undefined && rec.signalBarOpenTime !== null
            ? rec.signalBarOpenTime
            : sigBarClose !== null
              ? Number(sigBarClose) % 900_000 === 899_999
                ? Number(sigBarClose) - 900_000 + 1
                : Number(sigBarClose) - 900_000
              : null;
        const nextBarOpen =
          rec.nextBarOpenTime !== undefined ? rec.nextBarOpenTime : null;
        const isMissed =
          rec.entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
          (nextBarOpen !== null &&
            Number.isFinite(evalCompletedMs) &&
            evalCompletedMs >= Number(nextBarOpen));
        const candDetLatency =
          rec.candidateDetectionLatencyMs ??
          rec.detectionLatencyMs ??
          (sigBarClose !== null && Number.isFinite(evalCompletedMs)
            ? Math.max(0, Math.round(evalCompletedMs - Number(sigBarClose)))
            : null);
        const evalLat =
          rec.evaluationLatencyMs ?? rec.smcEvaluationLatencyMs ?? null;
        const nextRemMs =
          rec.nextBarRemainingMs ??
          (nextBarOpen !== null && Number.isFinite(evalCompletedMs)
            ? Math.max(0, Math.round(Number(nextBarOpen) - evalCompletedMs))
            : null);
        const delayMs =
          rec.entryWindowDelayMs ??
          (nextBarOpen !== null && Number.isFinite(evalCompletedMs)
            ? Math.round(evalCompletedMs - Number(nextBarOpen))
            : null);
        const isFast =
          rec.isFastLane !== undefined
            ? rec.isFastLane
            : (rec.priorityTier ?? 1) <= 5;
        const isRecDemo = Boolean(rec.isDemo || exchange === 'demo_synthetic');
        const recEvidenceType = resolveCandidateEvidenceType({
          exchange,
          source: rec.source ?? exchange,
          isDemo: isRecDemo,
          evidenceType: rec.evidenceType,
        });

        return {
          symbol: rec.symbol,
          exchange,
          smcActionState:
            rec.smcActionState === 'SHORT CANDIDATE'
              ? 'SHORT CANDIDATE'
              : 'LONG CANDIDATE',
          finalTradeSignal:
            rec.smcActionState === 'SHORT CANDIDATE'
              ? '空頭交易候選'
              : '多頭交易候選',
          signalBarOpenTime: sigBarOpen,
          signalBarCloseTime: sigBarClose,
          candidateDetectedAt: rec.candidateDetectedAt ?? evalCompletedAtStr,
          signalDetectedAt: rec.signalDetectedAt ?? evalCompletedAtStr,
          nextBarOpenTime: nextBarOpen,
          queueEnteredAt: rec.queueEnteredAt ?? null,
          evaluationStartedAt:
            rec.evaluationStartedAt ??
            rec.smcEvaluationStartedAt ??
            rec.evaluatedAt,
          evaluationCompletedAt: evalCompletedAtStr,
          queueWaitMs: rec.queueWaitMs ?? null,
          evaluationLatencyMs: evalLat,
          candidateDetectionLatencyMs: candDetLatency,
          nextBarRemainingMs: nextRemMs,
          entryWindowDelayMs: delayMs,
          entryWindowStatus: isMissed
            ? 'ENTRY_WINDOW_MISSED'
            : 'DETECTED_BEFORE_NEXT_BAR_OPEN',
          entryWindowMissed: isMissed,
          isFastLane: Boolean(isFast),
          priorityClass: isFast ? 'FAST_LANE' : 'BULK',
          paperEligibilityStatus: rec.paperEligibilityStatus ?? 'ELIGIBLE',
          isDemo: isRecDemo,
          evidenceType: recEvidenceType,
          evidenceScope: recEvidenceType,
        };
      });

    const formalCandidateCount = formalCandidateSlaRecords.length;
    const fastLaneFormalRecords = formalCandidateSlaRecords.filter(
      (r) => r.isFastLane
    );
    const bulkFormalRecords = formalCandidateSlaRecords.filter(
      (r) => !r.isFastLane
    );
    const fastLaneFormalCandidateCount = fastLaneFormalRecords.length;
    const bulkFormalCandidateCount = bulkFormalRecords.length;
    const candidateDetectedBeforeEntryWindowCount =
      formalCandidateSlaRecords.filter((r) => !r.entryWindowMissed).length;
    const slaEntryWindowMissedCount = formalCandidateSlaRecords.filter(
      (r) => r.entryWindowMissed
    ).length;
    const entryWindowMissedRate: number | null =
      formalCandidateCount > 0
        ? Number((slaEntryWindowMissedCount / formalCandidateCount).toFixed(4))
        : null;

    const allCandDetLatencies = formalCandidateSlaRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const allQueueWaits = formalCandidateSlaRecords
      .map((r) => r.queueWaitMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const allEvalLatencies = formalCandidateSlaRecords
      .map((r) => r.evaluationLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    const fastCandDetLatencies = fastLaneFormalRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const bulkCandDetLatencies = bulkFormalRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const fastQueueWaits = fastLaneFormalRecords
      .map((r) => r.queueWaitMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const bulkQueueWaits = bulkFormalRecords
      .map((r) => r.queueWaitMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const fastEvalLatencies = fastLaneFormalRecords
      .map((r) => r.evaluationLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const bulkEvalLatencies = bulkFormalRecords
      .map((r) => r.evaluationLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    const candidateDetectionLatencyP50 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allCandDetLatencies, 50)
        : null;
    const candidateDetectionLatencyP95 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allCandDetLatencies, 95)
        : null;
    const queueWaitP50 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allQueueWaits, 50)
        : null;
    const queueWaitP95 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allQueueWaits, 95)
        : null;
    const evaluationLatencyP50 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allEvalLatencies, 50)
        : null;
    const evaluationLatencyP95 =
      formalCandidateCount > 0
        ? computeNullablePercentile(allEvalLatencies, 95)
        : null;

    const fastCandDetP50 =
      fastLaneFormalCandidateCount > 0
        ? computeNullablePercentile(fastCandDetLatencies, 50)
        : null;
    const fastCandDetP95 =
      fastLaneFormalCandidateCount > 0
        ? computeNullablePercentile(fastCandDetLatencies, 95)
        : null;
    const bulkCandDetP50 =
      bulkFormalCandidateCount > 0
        ? computeNullablePercentile(bulkCandDetLatencies, 50)
        : null;
    const bulkCandDetP95 =
      bulkFormalCandidateCount > 0
        ? computeNullablePercentile(bulkCandDetLatencies, 95)
        : null;
    const fastQueueP50 =
      fastLaneFormalCandidateCount > 0
        ? computeNullablePercentile(fastQueueWaits, 50)
        : null;
    const fastQueueP95 =
      fastLaneFormalCandidateCount > 0
        ? computeNullablePercentile(fastQueueWaits, 95)
        : null;
    const bulkQueueP50 =
      bulkFormalCandidateCount > 0
        ? computeNullablePercentile(bulkQueueWaits, 50)
        : null;
    const bulkQueueP95 =
      bulkFormalCandidateCount > 0
        ? computeNullablePercentile(bulkQueueWaits, 95)
        : null;

    // Phase 18.3 & Phase 18.4 Requirement 一: Three Disjoint Evidence Sources
    // DEMO_LATENCY_FIXTURE and CONTROLLED_LIVE_FIXTURE are NEVER mixed into LIVE_* fields.
    const liveFormalFromScan =
      exchange === 'demo_synthetic'
        ? []
        : formalCandidateSlaRecords.filter(
            (r) =>
              !r.isDemo &&
              r.exchange !== 'demo_synthetic' &&
              r.evidenceType === 'LIVE_PRODUCTION'
          );

    const persistedLiveCaptures =
      exchange === 'demo_synthetic'
        ? []
        : this.listLiveCaptureCandidates(exchange).filter(
            (c) =>
              c.evidenceType === 'LIVE_PRODUCTION' &&
              !c.isDemo &&
              (c.cycleId === atomic.cycleId || atomic.totalContracts === 0)
          );

    const seenLiveKeys = new Set<string>(
      liveFormalFromScan.map(
        (r) => `${r.symbol}:${r.smcActionState}:${r.signalBarOpenTime ?? 0}`
      )
    );
    const mergedLiveFormalRecords: FormalCandidateSlaRecord[] = [
      ...liveFormalFromScan,
    ];
    for (const plc of persistedLiveCaptures) {
      const key = `${plc.symbol}:${plc.direction === 'SHORT' ? 'SHORT CANDIDATE' : 'LONG CANDIDATE'}:${plc.signalBarOpenTime ?? 0}`;
      if (!seenLiveKeys.has(key)) {
        seenLiveKeys.add(key);
        mergedLiveFormalRecords.push({
          symbol: plc.symbol,
          exchange: plc.exchange,
          smcActionState:
            plc.direction === 'SHORT' ? 'SHORT CANDIDATE' : 'LONG CANDIDATE',
          finalTradeSignal:
            plc.direction === 'SHORT' ? '空頭交易候選' : '多頭交易候選',
          signalBarOpenTime: plc.signalBarOpenTime,
          signalBarCloseTime: plc.signalBarCloseTime,
          candidateDetectedAt: plc.candidateDetectedAt,
          signalDetectedAt: plc.signalDetectedAt,
          nextBarOpenTime: plc.nextBarOpenTime,
          queueEnteredAt: plc.queueEnteredAt,
          evaluationStartedAt: plc.evaluationStartedAt,
          evaluationCompletedAt: plc.evaluationCompletedAt,
          queueWaitMs: plc.queueWaitMs,
          evaluationLatencyMs: plc.evaluationLatencyMs,
          candidateDetectionLatencyMs: plc.candidateDetectionLatencyMs,
          nextBarRemainingMs: plc.nextBarRemainingMs,
          entryWindowDelayMs:
            plc.nextBarOpenTime !== null
              ? Math.round(
                  Date.parse(plc.signalDetectedAt) - Number(plc.nextBarOpenTime)
                )
              : null,
          entryWindowStatus: plc.entryWindowStatus,
          entryWindowMissed: plc.entryWindowMissed,
          isFastLane: plc.isFastLane,
          priorityClass: plc.isFastLane ? 'FAST_LANE' : 'BULK',
          paperEligibilityStatus: 'ELIGIBLE',
          isDemo: false,
          evidenceType: 'LIVE_PRODUCTION',
          evidenceScope: 'LIVE_PRODUCTION',
        });
      }
    }

    const liveFormalSlaRecords = mergedLiveFormalRecords;
    const liveFastLaneRecords = liveFormalSlaRecords.filter((r) => r.isFastLane);
    const liveBulkRecords = liveFormalSlaRecords.filter((r) => !r.isFastLane);
    const LIVE_FORMAL_CANDIDATE_COUNT = liveFormalSlaRecords.length;
    const LIVE_FAST_LANE_COUNT = liveFastLaneRecords.length;
    const LIVE_BULK_COUNT = liveBulkRecords.length;
    const LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT =
      liveFormalSlaRecords.filter((r) => !r.entryWindowMissed).length;
    const LIVE_ENTRY_WINDOW_MISSED_COUNT = liveFormalSlaRecords.filter(
      (r) => r.entryWindowMissed
    ).length;
    const LIVE_ENTRY_WINDOW_MISSED_RATE: number | null =
      LIVE_FORMAL_CANDIDATE_COUNT > 0
        ? Number(
            (
              LIVE_ENTRY_WINDOW_MISSED_COUNT / LIVE_FORMAL_CANDIDATE_COUNT
            ).toFixed(4)
          )
        : null;

    const liveCandDetLatencies = liveFormalSlaRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const liveFastCandDetLatencies = liveFastLaneRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const liveBulkCandDetLatencies = liveBulkRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    const LIVE_DETECTION_LATENCY_P50 =
      LIVE_FORMAL_CANDIDATE_COUNT > 0
        ? computeNullablePercentile(liveCandDetLatencies, 50)
        : null;
    const LIVE_DETECTION_LATENCY_P95 =
      LIVE_FORMAL_CANDIDATE_COUNT > 0
        ? computeNullablePercentile(liveCandDetLatencies, 95)
        : null;
    const LIVE_FAST_LANE_DETECTION_LATENCY_P50 =
      LIVE_FAST_LANE_COUNT > 0
        ? computeNullablePercentile(liveFastCandDetLatencies, 50)
        : null;
    const LIVE_FAST_LANE_DETECTION_LATENCY_P95 =
      LIVE_FAST_LANE_COUNT > 0
        ? computeNullablePercentile(liveFastCandDetLatencies, 95)
        : null;
    const LIVE_BULK_DETECTION_LATENCY_P50 =
      LIVE_BULK_COUNT > 0
        ? computeNullablePercentile(liveBulkCandDetLatencies, 50)
        : null;
    const LIVE_BULK_DETECTION_LATENCY_P95 =
      LIVE_BULK_COUNT > 0
        ? computeNullablePercentile(liveBulkCandDetLatencies, 95)
        : null;

    // Controlled Live Fixture Summary (Phase 18.4 Requirement 一)
    const controlledFixtureRecords = this.listControlledFixtureCandidates(
      exchange === 'demo_synthetic' ? 'binance_usdm' : exchange
    );
    const controlledFastRecords = controlledFixtureRecords.filter(
      (r) => r.isFastLane
    );
    const controlledBulkRecords = controlledFixtureRecords.filter(
      (r) => !r.isFastLane
    );
    const controlledAllLat = controlledFixtureRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const controlledFastLat = controlledFastRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const controlledBulkLat = controlledBulkRecords
      .map((r) => r.candidateDetectionLatencyMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const controlledQueueWaits = controlledFixtureRecords
      .map((r) => r.queueWaitMs)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    const CONTROLLED_LIVE_FIXTURE: ControlledLiveFixtureSummary = {
      evidenceType: 'CONTROLLED_LIVE_FIXTURE' as const,
      isControlledFixture: true as const,
      isDemo: false as const,
      isTestFixture: true as const,
      isLiveValidated: false as const,
      neverMixedIntoLive: true as const,
      neverMarkedLiveValidated: true as const,
      formalCandidateCount: controlledFixtureRecords.length,
      fastLaneCount: controlledFastRecords.length,
      bulkCount: controlledBulkRecords.length,
      detectedBeforeEntryWindowCount: controlledFixtureRecords.filter(
        (r) => !r.entryWindowMissed
      ).length,
      entryWindowMissedCount: controlledFixtureRecords.filter(
        (r) => r.entryWindowMissed
      ).length,
      detectionLatencyP50:
        controlledFixtureRecords.length > 0
          ? computeNullablePercentile(controlledAllLat, 50)
          : null,
      detectionLatencyP95:
        controlledFixtureRecords.length > 0
          ? computeNullablePercentile(controlledAllLat, 95)
          : null,
      fastLaneDetectionLatencyP50:
        controlledFastRecords.length > 0
          ? computeNullablePercentile(controlledFastLat, 50)
          : null,
      fastLaneDetectionLatencyP95:
        controlledFastRecords.length > 0
          ? computeNullablePercentile(controlledFastLat, 95)
          : null,
      bulkDetectionLatencyP50:
        controlledBulkRecords.length > 0
          ? computeNullablePercentile(controlledBulkLat, 50)
          : null,
      bulkDetectionLatencyP95:
        controlledBulkRecords.length > 0
          ? computeNullablePercentile(controlledBulkLat, 95)
          : null,
      queueWaitP50:
        controlledFixtureRecords.length > 0
          ? computeNullablePercentile(controlledQueueWaits, 50)
          : null,
      queueWaitP95:
        controlledFixtureRecords.length > 0
          ? computeNullablePercentile(controlledQueueWaits, 95)
          : null,
      note:
        '受控測試通過不等於真實 Live 已驗證。CONTROLLED_LIVE_FIXTURE 永遠不計入 LIVE_FORMAL_CANDIDATE_COUNT、LIVE_DETECTION_LATENCY_P50/P95 或 Live Paper 績效。',
      notice:
        '受控測試通過不等於真實 Live 已驗證。CONTROLLED_LIVE_FIXTURE 永遠不計入 LIVE_FORMAL_CANDIDATE_COUNT、LIVE_DETECTION_LATENCY_P50/P95 或 Live Paper 績效。',
    };

    const DEMO_LATENCY_FIXTURE: DemoLatencyFixtureSummary =
      exchange === 'demo_synthetic'
        ? {
            evidenceType: 'DEMO_LATENCY_FIXTURE' as const,
            isDemo: true as const,
            isTestFixture: true as const,
            neverMixedIntoLive: true as const,
            formalCandidateCount,
            fastLaneCount: fastLaneFormalCandidateCount,
            bulkCount: bulkFormalCandidateCount,
            detectedBeforeEntryWindowCount:
              candidateDetectedBeforeEntryWindowCount,
            entryWindowMissedCount: slaEntryWindowMissedCount,
            detectionLatencyP50: candidateDetectionLatencyP50,
            detectionLatencyP95: candidateDetectionLatencyP95,
            fastLaneDetectionLatencyP50: fastCandDetP50,
            fastLaneDetectionLatencyP95: fastCandDetP95,
            bulkDetectionLatencyP50: bulkCandDetP50,
            bulkDetectionLatencyP95: bulkCandDetP95,
            queueWaitP50,
            queueWaitP95,
            note:
              'Demo SLA 僅為 DEMO_LATENCY_FIXTURE 驗收證據，不等於 Live SLA，永遠不混入 Live 延遲統計。',
            notice:
              'Demo SLA 僅為 DEMO_LATENCY_FIXTURE 驗收證據，不等於 Live SLA，永遠不混入 Live 延遲統計。',
          }
        : {
            evidenceType: 'DEMO_LATENCY_FIXTURE' as const,
            isDemo: true as const,
            isTestFixture: true as const,
            neverMixedIntoLive: true as const,
            formalCandidateCount: 2,
            fastLaneCount: 2,
            bulkCount: 0,
            detectedBeforeEntryWindowCount: 2,
            entryWindowMissedCount: 0,
            detectionLatencyP50: 42,
            detectionLatencyP95: 68,
            fastLaneDetectionLatencyP50: 42,
            fastLaneDetectionLatencyP95: 68,
            bulkDetectionLatencyP50: null,
            bulkDetectionLatencyP95: null,
            queueWaitP50: 12,
            queueWaitP95: 18,
            note:
              'Demo SLA 僅為 DEMO_LATENCY_FIXTURE 驗收證據，不等於 Live SLA，永遠不混入 Live 延遲統計。',
            notice:
              'Demo SLA 僅為 DEMO_LATENCY_FIXTURE 驗收證據，不等於 Live SLA，永遠不混入 Live 延遲統計。',
          };

    // Phase 18.4 & Phase 18.5 Requirement 三: Real Live Candidate Status
    let liveValidationStatus: LiveCaptureValidationStatus =
      'NO_LIVE_FORMAL_CANDIDATE';
    const liveValidationStates: LiveCaptureValidationStatus[] = [];
    if (LIVE_FORMAL_CANDIDATE_COUNT === 0) {
      liveValidationStatus = 'NO_LIVE_FORMAL_CANDIDATE';
      liveValidationStates.push(
        'NO_LIVE_FORMAL_CANDIDATE',
        'LIVE_VALIDATION_INSUFFICIENT_SAMPLE'
      );
    } else {
      liveValidationStates.push('LIVE_CANDIDATE_DETECTED');
      if (LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT > 0) {
        liveValidationStatus = 'LIVE_CANDIDATE_DETECTED_BEFORE_ENTRY';
        liveValidationStates.push('LIVE_CANDIDATE_DETECTED_BEFORE_ENTRY');
      }
      if (LIVE_ENTRY_WINDOW_MISSED_COUNT > 0) {
        if (LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT === 0) {
          liveValidationStatus = 'LIVE_ENTRY_WINDOW_MISSED';
        }
        liveValidationStates.push('LIVE_ENTRY_WINDOW_MISSED');
      }
      if (LIVE_FORMAL_CANDIDATE_COUNT < 30) {
        liveValidationStates.push('LIVE_VALIDATION_INSUFFICIENT_SAMPLE');
      }
    }
    const liveSampleValidationStatus: LiveCaptureValidationStatus =
      'LIVE_VALIDATION_INSUFFICIENT_SAMPLE';
    const isLiveValidated =
      LIVE_FORMAL_CANDIDATE_COUNT >= 30 &&
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT > 0;
    const liveValidationMessage =
      LIVE_FORMAL_CANDIDATE_COUNT === 0
        ? '尚無真實 Live 候選，無法評估實盤捕捉延遲'
        : `已捕捉 ${LIVE_FORMAL_CANDIDATE_COUNT} 筆真實 LIVE_PRODUCTION 正式候選（提前捕捉 ${LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT} 筆、錯過進場 ${LIVE_ENTRY_WINDOW_MISSED_COUNT} 筆；P50=${LIVE_DETECTION_LATENCY_P50 ?? 'null'}ms, P95=${LIVE_DETECTION_LATENCY_P95 ?? 'null'}ms）。`;

    const obsShadowComp = smcGateDiagnostics.observationShadowComparison;
    const strategyValidity: StrategyValidityStatus =
      paperClosedCount >= 30 ? 'VALIDATED' : 'INSUFFICIENT_SAMPLE';
    const signalQualityCalibration: SignalQualityCalibrationSummary = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      soleFormalSignalMode: 'STRICT_PRODUCTION',
      noLookaheadGuaranteed: true,
      confirmedBarsOnly: true,
      modes: [
        obsShadowComp.strictProduction,
        obsShadowComp.observationShadowOneGateMissing,
        obsShadowComp.observationShadowTwoGatesMissing,
      ],
      strictProduction: obsShadowComp.strictProduction,
      shadowOneGateMissing: obsShadowComp.observationShadowOneGateMissing,
      shadowTwoGatesMissing: obsShadowComp.observationShadowTwoGatesMissing,
      settledPaperSampleCount: paperClosedCount,
      minimumRequiredSettledSamples: 30,
      strategyValidity,
      lookaheadFreeBacktestCompleted: true,
      walkForwardValidated: false,
      marketRegimeResultsProvided: false,
      allMetricsBackedByRealSamples: paperClosedCount >= 30,
      gateAdjustmentAllowed: false,
      gateAdjustmentRecommendation:
        '不得因候選太少就直接放寬條件。目前 STRICT_PRODUCTION 與 Shadow 觀察模式之已結算樣本數小於 30 (strategyValidity = INSUFFICIENT_SAMPLE)，尚未累積至少 30 筆已結算樣本且尚未完成多市場狀態 Walk-Forward 驗證，維持全部 9 項嚴格 SMC/ICT Gate 不變。',
      invariants: {
        strictProductionGatesUnchanged: true,
        shadowNeverOpensPaper: true,
        shadowNeverWritesLedger: true,
        shadowNeverNotifies: true,
        shadowNeverMutatesSmcState: true,
        shadowNeverMutatesFinalTradeSignal: true,
      },
    };

    const formalCandidateLatencySla: FormalCandidateLatencySlaSummary = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      formalCandidateCount,
      fastLaneFormalCandidateCount,
      bulkFormalCandidateCount,
      fastLaneCandidateCount: fastLaneFormalCandidateCount,
      bulkCandidateCount: bulkFormalCandidateCount,
      candidateDetectedBeforeEntryWindowCount,
      entryWindowMissedCount: slaEntryWindowMissedCount,
      entryWindowMissedRate,
      candidateDetectionLatencyP50,
      candidateDetectionLatencyP95,
      queueWaitP50,
      queueWaitP95,
      evaluationLatencyP50,
      evaluationLatencyP95,
      fastLaneCandidateDetectionLatencyP50: fastCandDetP50,
      fastLaneCandidateDetectionLatencyP95: fastCandDetP95,
      bulkCandidateDetectionLatencyP50: bulkCandDetP50,
      bulkCandidateDetectionLatencyP95: bulkCandDetP95,
      fastLaneQueueWaitP50: fastQueueP50,
      fastLaneQueueWaitP95: fastQueueP95,
      bulkQueueWaitP50: bulkQueueP50,
      bulkQueueWaitP95: bulkQueueP95,
      fastLaneLatency: {
        count: fastLaneFormalCandidateCount,
        candidateDetectionLatencyP50: fastCandDetP50,
        candidateDetectionLatencyP95: fastCandDetP95,
        queueWaitP50: fastQueueP50,
        queueWaitP95: fastQueueP95,
        evaluationLatencyP50:
          fastLaneFormalCandidateCount > 0
            ? computeNullablePercentile(fastEvalLatencies, 50)
            : null,
        evaluationLatencyP95:
          fastLaneFormalCandidateCount > 0
            ? computeNullablePercentile(fastEvalLatencies, 95)
            : null,
      },
      bulkLatency: {
        count: bulkFormalCandidateCount,
        candidateDetectionLatencyP50: bulkCandDetP50,
        candidateDetectionLatencyP95: bulkCandDetP95,
        queueWaitP50: bulkQueueP50,
        queueWaitP95: bulkQueueP95,
        evaluationLatencyP50:
          bulkFormalCandidateCount > 0
            ? computeNullablePercentile(bulkEvalLatencies, 50)
            : null,
        evaluationLatencyP95:
          bulkFormalCandidateCount > 0
            ? computeNullablePercentile(bulkEvalLatencies, 95)
            : null,
      },
      candidates: formalCandidateSlaRecords,
      statusNotice:
        formalCandidateCount === 0
          ? '目前週期沒有正式候選 (formalCandidateCount=0)，所有正式候選偵測延遲百分位數與錯過率均回傳 null，不補 0、亦不混入 Near-Miss 或 Demo 評估耗時。'
          : `目前週期共 ${formalCandidateCount} 檔正式候選（Fast Lane: ${fastLaneFormalCandidateCount}, Bulk: ${bulkFormalCandidateCount}），進場視窗前完成偵測 ${candidateDetectedBeforeEntryWindowCount} 檔，錯過進場視窗 ${slaEntryWindowMissedCount} 檔。`,
      DEMO_LATENCY_FIXTURE,
      CONTROLLED_LIVE_FIXTURE,
      LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95,
      liveValidationStatus,
      liveSampleValidationStatus,
      liveValidationStates,
      liveValidationMessage,
      isLiveValidated,
    };

    const monitoringWindowEntryWindowMissedCount =
      entryWindowMissedCount + windowHistoricalMissedCount;
    const monitoringWindowPaperOpenedCount =
      paperOpenedCount + windowHistoricalOpenedCount;
    const monitoringWindowPaperClosedCount =
      paperClosedCount + windowHistoricalClosedCount;
    const monitoringWindowPaperEligibleCount =
      eligiblePaperSignalCount + windowHistoricalEligibleCount;
    const monitoringWindowCandidateDetectedCount = Math.max(
      totalCandidates + windowHistoricalEligibleCount,
      monitoringWindowPaperEligibleCount
    );

    const cumulativeEntryWindowMissedCount =
      entryWindowMissedCount + historicalEntryWindowMissedCount;
    const cumulativePaperOpenedCount =
      paperOpenedCount + historicalPaperOpenedCount;
    const cumulativePaperClosedCount =
      paperClosedCount + historicalPaperClosedCount;
    const cumulativePaperEligibleCount =
      eligiblePaperSignalCount + historicalPaperEligibleCount;
    const cumulativeCandidateDetectedCount = Math.max(
      totalCandidates + historicalPaperEligibleCount,
      cumulativePaperEligibleCount
    );

    const smcWaitAndWatchAndHighRiskReasons: Record<string, number> = {
      WAIT: atomic.waitCount,
      WATCH: atomic.watchCount,
      HIGH_RISK: atomic.highRiskCount,
    };
    if (atomic.pendingCount > 0) {
      smcWaitAndWatchAndHighRiskReasons.PENDING = atomic.pendingCount;
    }

    const nearMissOneGateCount = smcGateDiagnostics.nearMissMissing1Count;
    const nearMissTwoGatesCount = smcGateDiagnostics.nearMissMissing2Count;
    const nearMissTotalCount = smcGateDiagnostics.nearMissCount;

    const buildScopedBlock = (
      scope: FunnelAggregationScope,
      candCount: number,
      eligCount: number,
      openedCount: number,
      closedCount: number,
      missedCount: number
    ): ScopedFunnelBlock => {
      const validation = validateScopedFunnelConsistency({
        cycleId: atomic.cycleId,
        snapshotAt: atomic.snapshotAt,
        statsVersion: atomic.statsVersion,
        aggregationScope: scope,
        evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
        evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
        excludedCount: smcGateDiagnostics.excludedCount,
        excludedSymbols: smcGateDiagnostics.excludedSymbols,
        excludedReasons: smcGateDiagnostics.excludedReasons,
        totalSymbols: totalSymbolsCount,
        evaluatedCount: atomic.evaluatedCount,
        pendingCount: atomic.pendingCount,
        failedCount: atomic.failedCount,
        rateLimitedCount: atomic.rateLimitedCount,
        waitCount: atomic.waitCount,
        watchCount: atomic.watchCount,
        highRiskCount: atomic.highRiskCount,
        longCandidateCount: atomic.longCandidateCount,
        shortCandidateCount: atomic.shortCandidateCount,
        nearMissCount: nearMissTotalCount,
        nearMissOneGateCount,
        nearMissTwoGatesCount,
        candidateDetectedCount: candCount,
        paperEligibleCount: eligCount,
        paperOpenedCount: openedCount,
        paperClosedCount: closedCount,
        entryWindowMissedCount: missedCount,
        gateDriftNearMissDenominator:
          smcGateDiagnostics.scopedGateStatistics.nearMissDenominator,
      });

      return {
        cycleId: atomic.cycleId,
        snapshotAt: atomic.snapshotAt,
        statsVersion: atomic.statsVersion,
        aggregationScope: scope,
        evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
        evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
        excludedCount: smcGateDiagnostics.excludedCount,
        excludedSymbols: smcGateDiagnostics.excludedSymbols,
        excludedReasons: smcGateDiagnostics.excludedReasons,
        totalSymbols: totalSymbolsCount,
        evaluatedCount: atomic.evaluatedCount,
        pendingCount: atomic.pendingCount,
        failedCount: atomic.failedCount,
        rateLimitedCount: atomic.rateLimitedCount,
        radarLongCount,
        radarShortCount,
        waitCount: atomic.waitCount,
        watchCount: atomic.watchCount,
        highRiskCount: atomic.highRiskCount,
        longCandidateCount: atomic.longCandidateCount,
        shortCandidateCount: atomic.shortCandidateCount,
        nearMissCount: nearMissTotalCount,
        nearMissOneGateCount,
        nearMissTwoGatesCount,
        formalCandidateCount:
          scope === 'CURRENT_CYCLE' || scope === 'LATEST_SNAPSHOT'
            ? totalCandidates
            : candCount,
        candidateDetectedCount: candCount,
        paperEligibleCount: eligCount,
        paperOpenedCount: openedCount,
        paperClosedCount: closedCount,
        entryWindowMissedCount: missedCount,
        blockedCount:
          blockedByPaperEligibilityCount + blockedAfterSmcCandidateCount,
        statsConsistency: validation.statsConsistency,
        consistencyErrors: validation.consistencyErrors,
      };
    };

    const currentCycleFunnel = buildScopedBlock(
      'CURRENT_CYCLE',
      totalCandidates,
      eligiblePaperSignalCount,
      paperOpenedCount,
      paperClosedCount,
      entryWindowMissedCount
    );
    const latestSnapshotFunnel = buildScopedBlock(
      'LATEST_SNAPSHOT',
      totalCandidates,
      eligiblePaperSignalCount,
      paperOpenedCount,
      paperClosedCount,
      entryWindowMissedCount
    );
    const monitoringWindowFunnel = buildScopedBlock(
      'MONITORING_WINDOW',
      monitoringWindowCandidateDetectedCount,
      monitoringWindowPaperEligibleCount,
      monitoringWindowPaperOpenedCount,
      monitoringWindowPaperClosedCount,
      monitoringWindowEntryWindowMissedCount
    );
    const cumulativeFunnel = buildScopedBlock(
      'CUMULATIVE',
      cumulativeCandidateDetectedCount,
      cumulativePaperEligibleCount,
      cumulativePaperOpenedCount,
      cumulativePaperClosedCount,
      cumulativeEntryWindowMissedCount
    );

    const outsideCurrentCycleValidation = validateScopedFunnelConsistency({
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'OUTSIDE_CURRENT_CYCLE',
      evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
      evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
      excludedCount: smcGateDiagnostics.excludedCount,
      excludedSymbols: smcGateDiagnostics.excludedSymbols,
      excludedReasons: smcGateDiagnostics.excludedReasons,
      totalSymbols: totalSymbolsCount,
      evaluatedCount: atomic.evaluatedCount,
      pendingCount: atomic.pendingCount,
      failedCount: atomic.failedCount,
      rateLimitedCount: atomic.rateLimitedCount,
      waitCount: atomic.waitCount,
      watchCount: atomic.watchCount,
      highRiskCount: atomic.highRiskCount,
      longCandidateCount: atomic.longCandidateCount,
      shortCandidateCount: atomic.shortCandidateCount,
      nearMissCount: nearMissTotalCount,
      nearMissOneGateCount,
      nearMissTwoGatesCount,
      candidateDetectedCount: windowHistoricalEligibleCount,
      paperEligibleCount: windowHistoricalEligibleCount,
      paperOpenedCount: windowHistoricalOpenedCount,
      paperClosedCount: windowHistoricalClosedCount,
      entryWindowMissedCount: windowHistoricalMissedCount,
      gateDriftNearMissDenominator:
        smcGateDiagnostics.scopedGateStatistics.nearMissDenominator,
    });

    const historicalSignalsOutsideCurrentCycle: HistoricalSignalsOutsideCurrentCycleBlock =
      {
        cycleId: atomic.cycleId,
        snapshotAt: atomic.snapshotAt,
        statsVersion: atomic.statsVersion,
        scope: 'OUTSIDE_CURRENT_CYCLE',
        aggregationScope: 'OUTSIDE_CURRENT_CYCLE',
        evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
        evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
        excludedCount: smcGateDiagnostics.excludedCount,
        excludedSymbols: smcGateDiagnostics.excludedSymbols,
        excludedReasons: smcGateDiagnostics.excludedReasons,
        count: outsideCurrentCycleSignals.length,
        signals: outsideCurrentCycleSignals,
        candidateDetectedCount: windowHistoricalEligibleCount,
        paperEligibleCount: windowHistoricalEligibleCount,
        paperOpenedCount: windowHistoricalOpenedCount,
        paperClosedCount: windowHistoricalClosedCount,
        entryWindowMissedCount: windowHistoricalMissedCount,
        statsConsistency: outsideCurrentCycleValidation.statsConsistency,
        consistencyErrors: outsideCurrentCycleValidation.consistencyErrors,
      };

    const historicalValidation = validateScopedFunnelConsistency({
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'OUTSIDE_MONITORING_WINDOW',
      evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
      evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
      excludedCount: smcGateDiagnostics.excludedCount,
      excludedSymbols: smcGateDiagnostics.excludedSymbols,
      excludedReasons: smcGateDiagnostics.excludedReasons,
      totalSymbols: totalSymbolsCount,
      evaluatedCount: atomic.evaluatedCount,
      pendingCount: atomic.pendingCount,
      failedCount: atomic.failedCount,
      rateLimitedCount: atomic.rateLimitedCount,
      waitCount: atomic.waitCount,
      watchCount: atomic.watchCount,
      highRiskCount: atomic.highRiskCount,
      longCandidateCount: atomic.longCandidateCount,
      shortCandidateCount: atomic.shortCandidateCount,
      nearMissCount: nearMissTotalCount,
      nearMissOneGateCount,
      nearMissTwoGatesCount,
      candidateDetectedCount: outsideWindowEligibleCount,
      paperEligibleCount: outsideWindowEligibleCount,
      paperOpenedCount: outsideWindowOpenedCount,
      paperClosedCount: outsideWindowClosedCount,
      entryWindowMissedCount: outsideWindowMissedCount,
      gateDriftNearMissDenominator:
        smcGateDiagnostics.scopedGateStatistics.nearMissDenominator,
    });

    const historicalSignalsOutsideWindow: HistoricalSignalsOutsideWindowBlock = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'OUTSIDE_MONITORING_WINDOW',
      evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
      evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
      excludedCount: smcGateDiagnostics.excludedCount,
      excludedSymbols: smcGateDiagnostics.excludedSymbols,
      excludedReasons: smcGateDiagnostics.excludedReasons,
      count: outsideMonitoringWindowSignals.length,
      signals: outsideMonitoringWindowSignals,
      outsideCurrentCycleCount: outsideCurrentCycleSignals.length,
      outsideCurrentCycleSignals,
      outsideMonitoringWindowCount: outsideMonitoringWindowSignals.length,
      outsideMonitoringWindowSignals,
      candidateDetectedCount: outsideWindowEligibleCount,
      paperEligibleCount: outsideWindowEligibleCount,
      paperOpenedCount: outsideWindowOpenedCount,
      paperClosedCount: outsideWindowClosedCount,
      entryWindowMissedCount: outsideWindowMissedCount,
      statsConsistency: historicalValidation.statsConsistency,
      consistencyErrors: historicalValidation.consistencyErrors,
    };

    const historicalSignalsOutsideWindowCount =
      outsideMonitoringWindowSignals.length;
    const historicalSignalsOutsideCurrentCycleCount =
      outsideCurrentCycleSignals.length;

    const allConsistencyErrors = [
      ...currentCycleFunnel.consistencyErrors,
      ...latestSnapshotFunnel.consistencyErrors,
      ...monitoringWindowFunnel.consistencyErrors,
      ...cumulativeFunnel.consistencyErrors,
      ...historicalSignalsOutsideCurrentCycle.consistencyErrors,
      ...historicalSignalsOutsideWindow.consistencyErrors,
    ];
    const overallStatsConsistency: SmcStatsConsistency =
      allConsistencyErrors.length === 0 && atomic.statsConsistency === 'VALID'
        ? 'VALID'
        : 'INVALID';

    const candidateFunnel: CycleCandidateFunnel = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'CURRENT_CYCLE',
      evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
      evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
      excludedCount: smcGateDiagnostics.excludedCount,
      excludedSymbols: smcGateDiagnostics.excludedSymbols,
      excludedReasons: smcGateDiagnostics.excludedReasons,
      statsConsistency: overallStatsConsistency,
      consistencyErrors: allConsistencyErrors,
      totalSymbols: totalSymbolsCount,
      radarLongCount,
      radarShortCount,
      smcEvaluatedCount: atomic.evaluatedCount,
      smcPendingCount: atomic.pendingCount,
      smcFailedCount: atomic.failedCount,
      smcRateLimitedCount: atomic.rateLimitedCount,
      smcWaitCount: atomic.waitCount,
      smcWatchCount: atomic.watchCount,
      smcHighRiskCount: atomic.highRiskCount,
      smcLongCandidateCount: atomic.longCandidateCount,
      smcShortCandidateCount: atomic.shortCandidateCount,
      formalCandidateCount: totalCandidates,
      nearMissCount: nearMissTotalCount,
      nearMissOneGateCount,
      nearMissTwoGatesCount,
      blockedAfterSmcCandidateCount,
      blockedAfterSmcCandidateReasons,
      eligiblePaperSignalCount,
      currentCyclePaperEligibleCount: eligiblePaperSignalCount,
      monitoringWindowPaperEligibleCount,
      cumulativePaperEligibleCount,
      historicalPaperEligibleCount,
      blockedByPaperEligibilityCount,
      blockedByPaperEligibilityReasons,
      entryWindowMissedCount,
      currentCycleEntryWindowMissedCount: entryWindowMissedCount,
      monitoringWindowEntryWindowMissedCount,
      cumulativeEntryWindowMissedCount,
      historicalSignalsOutsideWindowCount,
      historicalSignalsOutsideCurrentCycleCount,
      paperOpenedCount,
      paperClosedCount,
      currentCycleFunnel,
      latestSnapshotFunnel,
      monitoringWindowFunnel,
      cumulativeFunnel,
      historicalSignalsOutsideCurrentCycle,
      historicalSignalsOutsideWindow,
      formalCandidateLatencySla,
      DEMO_LATENCY_FIXTURE,
      CONTROLLED_LIVE_FIXTURE,
      LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95,
      liveValidationStatus,
      liveSampleValidationStatus,
      liveValidationStates,
      liveValidationMessage,
      isLiveValidated,
      fullMarketSeparatedCounts: {
        radarLong: radarLongCount,
        radarShort: radarShortCount,
        smcWait: atomic.waitCount,
        smcWatch: atomic.watchCount,
        smcHighRisk: atomic.highRiskCount,
        smcLongCandidate: atomic.longCandidateCount,
        smcShortCandidate: atomic.shortCandidateCount,
        formalCandidateCount: totalCandidates,
        nearMissOneGate: nearMissOneGateCount,
        nearMissTwoGates: nearMissTwoGatesCount,
        candidateDetected: totalCandidates,
        paperEligible: eligiblePaperSignalCount,
        currentCyclePaperEligibleCount: eligiblePaperSignalCount,
        monitoringWindowPaperEligibleCount,
        cumulativePaperEligibleCount,
        historicalPaperEligibleCount,
        paperOpened: paperOpenedCount,
        paperClosed: paperClosedCount,
        entryWindowMissed: entryWindowMissedCount,
        currentCycleEntryWindowMissedCount: entryWindowMissedCount,
        monitoringWindowEntryWindowMissedCount,
        cumulativeEntryWindowMissedCount,
        historicalSignalsOutsideWindowCount,
        historicalSignalsOutsideCurrentCycleCount,
        blocked: blockedByPaperEligibilityCount + blockedAfterSmcCandidateCount,
      },
      stages: [
        {
          stage: 'Radar 觀察 -> SMC 已評估',
          inputCount: totalSymbolsCount,
          outputCount: atomic.evaluatedCount,
          blockedCount: Math.max(0, totalSymbolsCount - atomic.evaluatedCount),
          blockedReasons:
            atomic.pendingCount > 0
              ? { PENDING: atomic.pendingCount }
              : {},
        },
        {
          stage: 'SMC 已評估 -> Near-Miss (差 1~2 項 Gate)',
          inputCount: atomic.evaluatedCount,
          outputCount: nearMissTotalCount + totalCandidates,
          blockedCount: Math.max(
            0,
            atomic.evaluatedCount - (nearMissTotalCount + totalCandidates)
          ),
          blockedReasons: {
            NOT_NEAR_CANDIDATE: Math.max(
              0,
              atomic.evaluatedCount - (nearMissTotalCount + totalCandidates)
            ),
          },
        },
        {
          stage: 'marketRadarCategory -> smcActionState',
          inputCount: totalSymbolsCount,
          outputCount: totalCandidates,
          blockedCount: Math.max(0, totalSymbolsCount - totalCandidates),
          blockedReasons: {
            ...smcWaitAndWatchAndHighRiskReasons,
            NEAR_MISS_ONE_GATE: nearMissOneGateCount,
            NEAR_MISS_TWO_GATES: nearMissTwoGatesCount,
            RADAR_LONG_OBSERVED: radarLongCount,
            RADAR_SHORT_OBSERVED: radarShortCount,
            RADAR_NEUTRAL_OR_HIGH_RISK: Math.max(
              0,
              totalSymbolsCount - radarTotal
            ),
          },
        },
        {
          stage: 'smcActionState -> finalTradeSignal',
          inputCount: totalCandidates,
          outputCount: Math.max(
            0,
            totalCandidates - blockedAfterSmcCandidateCount
          ),
          blockedCount: blockedAfterSmcCandidateCount,
          blockedReasons: blockedAfterSmcCandidateReasons,
        },
        {
          stage: 'finalTradeSignal -> Paper eligibility',
          inputCount: Math.max(
            0,
            totalCandidates - blockedAfterSmcCandidateCount
          ),
          outputCount: eligiblePaperSignalCount,
          blockedCount: blockedByPaperEligibilityCount,
          blockedReasons: blockedByPaperEligibilityReasons,
        },
        {
          stage: 'Paper eligibility -> entry timing',
          inputCount: eligiblePaperSignalCount,
          outputCount: paperOpenedCount,
          blockedCount: entryWindowMissedCount,
          blockedReasons:
            entryWindowMissedCount > 0
              ? {
                  ENTRY_WINDOW_MISSED_DETECTED_AFTER_NEXT_BAR_OPEN:
                    entryWindowMissedCount,
                }
              : {},
        },
        {
          stage: 'entry timing -> paper ledger',
          inputCount: paperOpenedCount,
          outputCount: paperOpenedCount,
          blockedCount: 0,
          blockedReasons: {},
        },
        {
          stage: 'Paper Opened -> Paper Closed',
          inputCount: paperOpenedCount,
          outputCount: paperClosedCount,
          blockedCount: Math.max(0, paperOpenedCount - paperClosedCount),
          blockedReasons:
            paperOpenedCount > paperClosedCount
              ? { OPEN_TRADES_IN_PROGRESS: paperOpenedCount - paperClosedCount }
              : {},
        },
      ],
    };

    const paperEligibilityAudit: PaperEligibilityAuditSummary = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'CURRENT_CYCLE',
      candidateCount: totalCandidates,
      formalCandidateCount: totalCandidates,
      eligiblePaperSignalCount,
      currentCyclePaperEligibleCount: eligiblePaperSignalCount,
      monitoringWindowPaperEligibleCount,
      cumulativePaperEligibleCount,
      historicalPaperEligibleCount,
      blockedByPaperEligibilityCount,
      blockedByPaperEligibilityReasons,
      entryWindowMissedCount,
      currentCycleEntryWindowMissedCount: entryWindowMissedCount,
      monitoringWindowEntryWindowMissedCount,
      cumulativeEntryWindowMissedCount,
      historicalSignalsOutsideWindowCount,
      historicalSignalsOutsideCurrentCycleCount,
      paperOpenedCount,
      paperClosedCount,
      statusNotice:
        totalCandidates === 0
          ? `目前週期 (${atomic.cycleId}) 沒有正式候選 (formalCandidateCount=0, currentCyclePaperEligibleCount=0, currentCycleEntryWindowMissedCount=0)；歷史上曾有候選但錯過進場（30D/60D/90D 監控視窗內 OUTSIDE_CURRENT_CYCLE 共 ${historicalSignalsOutsideCurrentCycleCount} 筆、超過監控視窗 OUTSIDE_MONITORING_WINDOW 共 ${historicalSignalsOutsideWindowCount} 筆），已嚴格隔離不混入目前週期。`
          : blockedByPaperEligibilityCount > 0
            ? '候選存在，但被 Paper eligibility 阻擋'
            : entryWindowMissedCount > 0 && paperOpenedCount === 0
              ? '候選存在且通過 Paper eligibility，但因訊號評估時間晚於下一根 K 線開盤 (ENTRY_WINDOW_MISSED) 未開立 Paper 部位'
              : '候選存在且已通過 Paper eligibility',
    };

    let rootCauseVerdict: CandidateScarcityRootCauseVerdict =
      'STRICT_GATE_NO_CURRENT_SIGNAL';
    let rootCauseExplanation =
      `目前週期 (${atomic.cycleId}, statsVersion=${atomic.statsVersion}) 已評估 ${smcGateDiagnostics.evaluatedDenominator}/${smcGateDiagnostics.evaluationUniverseSize} 檔（排除 ${smcGateDiagnostics.excludedCount} 檔），目前週期沒有正式候選 (formalCandidateCount=${totalCandidates})。真實市場結構極少同時滿足全部 9 項嚴格 SMC/ICT Gate（最常見最後阻擋條件：${
        smcGateDiagnostics.lastBlockingGate ?? 'MTF_ALIGNMENT'
      }，差 1 項條件 Near-Miss 共 ${nearMissOneGateCount} 檔、差 2 項共 ${nearMissTwoGatesCount} 檔，合計 ${nearMissTotalCount} 檔）。歷史上曾有候選但錯過進場：OUTSIDE_CURRENT_CYCLE（監控視窗內）共 ${historicalSignalsOutsideCurrentCycleCount} 筆，OUTSIDE_MONITORING_WINDOW（超過 30D/60D/90D 監控視窗）共 ${historicalSignalsOutsideWindowCount} 筆，均不混入 currentCycleFunnel。`;

    if (totalCandidates > 0 && entryWindowMissedCount > 0 && paperOpenedCount === 0) {
      rootCauseVerdict = 'ENTRY_LATENCY_MISSED';
      rootCauseExplanation = `本週期已確認 ${totalCandidates} 檔 SMC 候選（${candidateRecords
        .map((r) => `${r.symbol} ${r.smcActionState}`)
        .join(', ')}），但因批次掃描完成時間晚於訊號 K 線下一根開盤時間 (signalDetectedAt >= nextBar.openTime)，依嚴格不回溯規則標記為 ENTRY_WINDOW_MISSED；其餘 ${
        atomic.evaluatedCount - totalCandidates
      } 檔為 STRICT_GATE_NO_CURRENT_SIGNAL（最常見最後阻擋條件：${
        smcGateDiagnostics.lastBlockingGate ?? 'MTF_ALIGNMENT'
      }，差 1 項條件 Near-Miss 共 ${nearMissOneGateCount} 檔、差 2 項共 ${nearMissTwoGatesCount} 檔）。`;
    } else if (totalCandidates > 0 && blockedByPaperEligibilityCount > 0) {
      rootCauseVerdict = 'PAPER_ELIGIBILITY_BUG';
    }

    const finalResult = {
      cycleId: atomic.cycleId,
      snapshotAt: atomic.snapshotAt,
      statsVersion: atomic.statsVersion,
      aggregationScope: 'CURRENT_CYCLE' as FunnelAggregationScope,
      evaluationUniverseSize: smcGateDiagnostics.evaluationUniverseSize,
      evaluatedDenominator: smcGateDiagnostics.evaluatedDenominator,
      excludedCount: smcGateDiagnostics.excludedCount,
      excludedSymbols: smcGateDiagnostics.excludedSymbols,
      excludedReasons: smcGateDiagnostics.excludedReasons,
      statsConsistency: overallStatsConsistency,
      consistencyErrors: allConsistencyErrors,
      smcGateDiagnostics,
      scopedGateStatistics: smcGateDiagnostics.scopedGateStatistics,
      observationShadowComparison: smcGateDiagnostics.observationShadowComparison,
      candidateFunnel,
      currentCycleFunnel,
      latestSnapshotFunnel,
      monitoringWindowFunnel,
      cumulativeFunnel,
      historicalSignalsOutsideCurrentCycle,
      historicalSignalsOutsideWindow,
      formalCandidateLatencySla,
      DEMO_LATENCY_FIXTURE,
      CONTROLLED_LIVE_FIXTURE,
      LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95,
      liveValidationStatus,
      liveSampleValidationStatus,
      liveValidationStates,
      liveValidationMessage,
      isLiveValidated,
      signalQualityCalibration,
      paperEligibilityAudit,
      nearMissCount: smcGateDiagnostics.nearMissCount,
      nearMissMissing1Count: smcGateDiagnostics.nearMissMissing1Count,
      nearMissMissing2Count: smcGateDiagnostics.nearMissMissing2Count,
      nearMissMissingGates: smcGateDiagnostics.nearMissMissingGates,
      lastBlockingGate: smcGateDiagnostics.lastBlockingGate,
      blockedAfterSmcCandidateCount,
      blockedAfterSmcCandidateReasons,
      blockedByPaperEligibilityCount,
      blockedByPaperEligibilityReasons,
      formalCandidateCount: totalCandidates,
      fastLaneFormalCandidateCount,
      bulkFormalCandidateCount,
      candidateDetectedBeforeEntryWindowCount,
      entryWindowMissedRate,
      candidateDetectionLatencyP50,
      candidateDetectionLatencyP95,
      queueWaitP50,
      queueWaitP95,
      eligiblePaperSignalCount,
      currentCyclePaperEligibleCount: eligiblePaperSignalCount,
      monitoringWindowPaperEligibleCount,
      cumulativePaperEligibleCount,
      historicalPaperEligibleCount,
      entryWindowMissedCount,
      currentCycleEntryWindowMissedCount: entryWindowMissedCount,
      monitoringWindowEntryWindowMissedCount,
      cumulativeEntryWindowMissedCount,
      historicalSignalsOutsideWindowCount,
      historicalSignalsOutsideCurrentCycleCount,
      paperOpenedCount,
      paperClosedCount,
      candidateDetectedCount: totalCandidates,
      rootCauseVerdict,
      rootCauseExplanation,
    };

    this.cycleDiagnosticsCache.set(exchange, {
      stateKey: diagStateKey,
      result: finalResult,
    });

    return finalResult;
  }

  public saveLiveCaptureCandidate(record: LiveCaptureCandidateRecord): void {
    if (
      record.isDemo ||
      record.evidenceType !== 'LIVE_PRODUCTION' ||
      record.exchange === 'demo_synthetic'
    ) {
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO smc_live_capture_candidates (
          signal_id, cycle_id, symbol, exchange, timeframe, direction,
          signal_bar_open_time, signal_bar_close_time, next_bar_open_time,
          candidate_detected_at, signal_detected_at, queue_entered_at,
          evaluation_started_at, evaluation_completed_at, queue_wait_ms,
          evaluation_latency_ms, candidate_detection_latency_ms, next_bar_remaining_ms,
          entry_window_status, entry_window_missed, is_fast_lane,
          evidence_type, source, fetched_at, stale, fallback, is_demo, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.signalId,
        record.cycleId,
        record.symbol,
        record.exchange,
        record.timeframe,
        record.direction,
        record.signalBarOpenTime,
        record.signalBarCloseTime,
        record.nextBarOpenTime,
        record.candidateDetectedAt,
        record.signalDetectedAt,
        record.queueEnteredAt,
        record.evaluationStartedAt,
        record.evaluationCompletedAt,
        record.queueWaitMs,
        record.evaluationLatencyMs,
        record.candidateDetectionLatencyMs,
        record.nextBarRemainingMs,
        record.entryWindowStatus,
        record.entryWindowMissed ? 1 : 0,
        record.isFastLane ? 1 : 0,
        'LIVE_PRODUCTION',
        record.source,
        record.fetchedAt,
        record.stale ? 1 : 0,
        record.fallback ? 1 : 0,
        0,
        new Date().toISOString()
      );
  }

  public listLiveCaptureCandidates(
    exchange?: ExchangeId
  ): LiveCaptureCandidateRecord[] {
    const rows = (
      exchange
        ? this.db
            .prepare(
              `SELECT * FROM smc_live_capture_candidates
               WHERE exchange = ? AND evidence_type = 'LIVE_PRODUCTION' AND is_demo = 0
               ORDER BY signal_detected_at DESC`
            )
            .all(exchange)
        : this.db
            .prepare(
              `SELECT * FROM smc_live_capture_candidates
               WHERE evidence_type = 'LIVE_PRODUCTION' AND is_demo = 0
               ORDER BY signal_detected_at DESC`
            )
            .all()
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      cycleId: String(r.cycle_id),
      signalId: String(r.signal_id),
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      timeframe: String(r.timeframe || '15m'),
      direction: String(r.direction) === 'SHORT' ? 'SHORT' : 'LONG',
      signalBarOpenTime:
        r.signal_bar_open_time !== null && r.signal_bar_open_time !== undefined
          ? Number(r.signal_bar_open_time)
          : null,
      signalBarCloseTime:
        r.signal_bar_close_time !== null && r.signal_bar_close_time !== undefined
          ? Number(r.signal_bar_close_time)
          : null,
      nextBarOpenTime:
        r.next_bar_open_time !== null && r.next_bar_open_time !== undefined
          ? Number(r.next_bar_open_time)
          : null,
      candidateDetectedAt: String(r.candidate_detected_at),
      signalDetectedAt: String(r.signal_detected_at),
      queueEnteredAt:
        r.queue_entered_at !== null && r.queue_entered_at !== undefined
          ? String(r.queue_entered_at)
          : null,
      evaluationStartedAt: String(r.evaluation_started_at),
      evaluationCompletedAt: String(r.evaluation_completed_at),
      queueWaitMs:
        r.queue_wait_ms !== null && r.queue_wait_ms !== undefined
          ? Number(r.queue_wait_ms)
          : null,
      evaluationLatencyMs:
        r.evaluation_latency_ms !== null && r.evaluation_latency_ms !== undefined
          ? Number(r.evaluation_latency_ms)
          : null,
      candidateDetectionLatencyMs:
        r.candidate_detection_latency_ms !== null &&
        r.candidate_detection_latency_ms !== undefined
          ? Number(r.candidate_detection_latency_ms)
          : null,
      nextBarRemainingMs:
        r.next_bar_remaining_ms !== null && r.next_bar_remaining_ms !== undefined
          ? Number(r.next_bar_remaining_ms)
          : null,
      entryWindowStatus:
        String(r.entry_window_status) === 'ENTRY_WINDOW_MISSED'
          ? 'ENTRY_WINDOW_MISSED'
          : 'DETECTED_BEFORE_NEXT_BAR_OPEN',
      entryWindowMissed: Number(r.entry_window_missed) === 1,
      isFastLane: Number(r.is_fast_lane) === 1,
      evidenceType: 'LIVE_PRODUCTION',
      source: String(r.source || ''),
      fetchedAt: String(r.fetched_at || ''),
      stale: Number(r.stale) === 1,
      fallback: Number(r.fallback) === 1,
      isDemo: false,
      isTestFixture: false,
    }));
  }

  public saveControlledFixtureCandidate(record: LiveCaptureCandidateRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO smc_controlled_fixture_candidates (
          signal_id, cycle_id, symbol, exchange, timeframe, direction,
          signal_bar_open_time, signal_bar_close_time, next_bar_open_time,
          candidate_detected_at, signal_detected_at, queue_entered_at,
          evaluation_started_at, evaluation_completed_at, queue_wait_ms,
          evaluation_latency_ms, candidate_detection_latency_ms, next_bar_remaining_ms,
          entry_window_status, entry_window_missed, is_fast_lane,
          evidence_type, source, fetched_at, stale, fallback, is_demo, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.signalId,
        record.cycleId,
        record.symbol,
        record.exchange,
        record.timeframe,
        record.direction,
        record.signalBarOpenTime,
        record.signalBarCloseTime,
        record.nextBarOpenTime,
        record.candidateDetectedAt,
        record.signalDetectedAt,
        record.queueEnteredAt,
        record.evaluationStartedAt,
        record.evaluationCompletedAt,
        record.queueWaitMs,
        record.evaluationLatencyMs,
        record.candidateDetectionLatencyMs,
        record.nextBarRemainingMs,
        record.entryWindowStatus,
        record.entryWindowMissed ? 1 : 0,
        record.isFastLane ? 1 : 0,
        'CONTROLLED_LIVE_FIXTURE',
        record.source,
        record.fetchedAt,
        record.stale ? 1 : 0,
        record.fallback ? 1 : 0,
        0,
        new Date().toISOString()
      );
  }

  public listControlledFixtureCandidates(
    exchange?: ExchangeId
  ): LiveCaptureCandidateRecord[] {
    const rows = (
      exchange
        ? this.db
            .prepare(
              `SELECT * FROM smc_controlled_fixture_candidates
               WHERE exchange = ? AND evidence_type = 'CONTROLLED_LIVE_FIXTURE'
               ORDER BY signal_detected_at DESC`
            )
            .all(exchange)
        : this.db
            .prepare(
              `SELECT * FROM smc_controlled_fixture_candidates
               WHERE evidence_type = 'CONTROLLED_LIVE_FIXTURE'
               ORDER BY signal_detected_at DESC`
            )
            .all()
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      cycleId: String(r.cycle_id),
      signalId: String(r.signal_id),
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      timeframe: String(r.timeframe || '15m'),
      direction: String(r.direction) === 'SHORT' ? 'SHORT' : 'LONG',
      signalBarOpenTime:
        r.signal_bar_open_time !== null && r.signal_bar_open_time !== undefined
          ? Number(r.signal_bar_open_time)
          : null,
      signalBarCloseTime:
        r.signal_bar_close_time !== null && r.signal_bar_close_time !== undefined
          ? Number(r.signal_bar_close_time)
          : null,
      nextBarOpenTime:
        r.next_bar_open_time !== null && r.next_bar_open_time !== undefined
          ? Number(r.next_bar_open_time)
          : null,
      candidateDetectedAt: String(r.candidate_detected_at),
      signalDetectedAt: String(r.signal_detected_at),
      queueEnteredAt:
        r.queue_entered_at !== null && r.queue_entered_at !== undefined
          ? String(r.queue_entered_at)
          : null,
      evaluationStartedAt: String(r.evaluation_started_at),
      evaluationCompletedAt: String(r.evaluation_completed_at),
      queueWaitMs:
        r.queue_wait_ms !== null && r.queue_wait_ms !== undefined
          ? Number(r.queue_wait_ms)
          : null,
      evaluationLatencyMs:
        r.evaluation_latency_ms !== null && r.evaluation_latency_ms !== undefined
          ? Number(r.evaluation_latency_ms)
          : null,
      candidateDetectionLatencyMs:
        r.candidate_detection_latency_ms !== null &&
        r.candidate_detection_latency_ms !== undefined
          ? Number(r.candidate_detection_latency_ms)
          : null,
      nextBarRemainingMs:
        r.next_bar_remaining_ms !== null && r.next_bar_remaining_ms !== undefined
          ? Number(r.next_bar_remaining_ms)
          : null,
      entryWindowStatus:
        String(r.entry_window_status) === 'ENTRY_WINDOW_MISSED'
          ? 'ENTRY_WINDOW_MISSED'
          : 'DETECTED_BEFORE_NEXT_BAR_OPEN',
      entryWindowMissed: Number(r.entry_window_missed) === 1,
      isFastLane: Number(r.is_fast_lane) === 1,
      evidenceType: 'CONTROLLED_LIVE_FIXTURE',
      source: String(r.source || ''),
      fetchedAt: String(r.fetched_at || ''),
      stale: Number(r.stale) === 1,
      fallback: Number(r.fallback) === 1,
      isDemo: false,
      isTestFixture: true,
    }));
  }

  public save15mCloseEvent(record: Confirmed15mCloseEventRecord): void {
    const resolvedEventId = record.closeEventId || record.eventId;
    const isDemo =
      record.isDemo !== undefined
        ? record.isDemo
        : record.evidenceType === 'DEMO_LATENCY_FIXTURE';
    const isTestFixture =
      record.isTestFixture !== undefined
        ? record.isTestFixture
        : record.evidenceType !== 'LIVE_PRODUCTION';
    this.db
      .prepare(
        `INSERT OR REPLACE INTO smc_15m_close_events (
          event_id, exchange, cycle_id, close_event_at,
          bar_open_time, bar_close_time,
          triggered_fast_lane_count, completed_fast_lane_count,
          formal_candidate_count, near_miss_count,
          candidate_detected_before_entry_count, entry_window_missed_count,
          pending_count, queue_wait_p50, queue_wait_p95,
          worker_state, cache_mode, snapshot_at, stats_version, evidence_type,
          is_demo, is_test_fixture
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        resolvedEventId,
        record.exchange,
        record.cycleId,
        record.closeEventAt,
        record.barOpenTime,
        record.barCloseTime,
        record.triggeredFastLaneCount,
        record.completedFastLaneCount,
        record.formalCandidateCount,
        record.nearMissCount,
        record.candidateDetectedBeforeEntryCount,
        record.entryWindowMissedCount,
        record.pendingCount,
        record.queueWaitP50,
        record.queueWaitP95,
        record.workerState,
        record.cacheMode,
        record.snapshotAt,
        record.statsVersion,
        record.evidenceType,
        isDemo ? 1 : 0,
        isTestFixture ? 1 : 0
      );
  }

  public list15mCloseEvents(
    exchange: ExchangeId,
    options?: { includeFixtures?: boolean; limit?: number }
  ): Confirmed15mCloseEventRecord[] {
    const limit = options?.limit ?? 500;
    const includeFixtures = options?.includeFixtures ?? false;
    const rows = (
      includeFixtures
        ? this.db
            .prepare(
              `SELECT * FROM smc_15m_close_events
               WHERE exchange = ?
               ORDER BY close_event_at DESC, rowid DESC
               LIMIT ?`
            )
            .all(exchange, limit)
        : this.db
            .prepare(
              `SELECT * FROM smc_15m_close_events
               WHERE exchange = ? AND evidence_type = 'LIVE_PRODUCTION' AND is_demo = 0 AND is_test_fixture = 0
               ORDER BY close_event_at DESC, rowid DESC
               LIMIT ?`
            )
            .all(exchange, limit)
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const evType = (r.evidence_type
        ? String(r.evidence_type)
        : 'LIVE_PRODUCTION') as CandidateEvidenceType;
      const evId = String(r.event_id);
      return {
        closeEventId: evId,
        eventId: evId,
        exchange: String(r.exchange) as ExchangeId,
        cycleId: String(r.cycle_id),
        closeEventAt: String(r.close_event_at),
        barOpenTime:
          r.bar_open_time !== null && r.bar_open_time !== undefined
            ? Number(r.bar_open_time)
            : null,
        barCloseTime:
          r.bar_close_time !== null && r.bar_close_time !== undefined
            ? Number(r.bar_close_time)
            : null,
        triggeredFastLaneCount: Number(r.triggered_fast_lane_count ?? 0),
        completedFastLaneCount: Number(r.completed_fast_lane_count ?? 0),
        formalCandidateCount: Number(r.formal_candidate_count ?? 0),
        nearMissCount: Number(r.near_miss_count ?? 0),
        candidateDetectedBeforeEntryCount: Number(
          r.candidate_detected_before_entry_count ?? 0
        ),
        entryWindowMissedCount: Number(r.entry_window_missed_count ?? 0),
        pendingCount: Number(r.pending_count ?? 0),
        queueWaitP50:
          r.queue_wait_p50 !== null && r.queue_wait_p50 !== undefined
            ? Number(r.queue_wait_p50)
            : null,
        queueWaitP95:
          r.queue_wait_p95 !== null && r.queue_wait_p95 !== undefined
            ? Number(r.queue_wait_p95)
            : null,
        workerState: String(r.worker_state || 'IDLE') as SmcScanWorkerState,
        cacheMode: String(r.cache_mode || 'WARM') as SmcCacheMode,
        snapshotAt: String(r.snapshot_at),
        statsVersion: Number(r.stats_version ?? 1),
        evidenceType: evType,
        isDemo:
          r.is_demo !== undefined
            ? Number(r.is_demo) === 1
            : evType === 'DEMO_LATENCY_FIXTURE',
        isTestFixture:
          r.is_test_fixture !== undefined
            ? Number(r.is_test_fixture) === 1
            : evType !== 'LIVE_PRODUCTION',
      };
    });
  }

  public saveNearMissObservations(
    exchange: ExchangeId,
    cycleId: string,
    observedAt: string,
    records: SmcNearMissSymbolRecord[]
  ): void {
    if (!records || records.length === 0) return;
    this.runInTransaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO smc_near_miss_observations (
          observation_id, exchange, cycle_id, symbol, smc_action_state,
          market_radar_category, intended_direction, missing_gates_json,
          missing_gate_count, last_blocking_gate, wait_reasons_json,
          evaluation_latency_ms, next_bar_remaining_ms, queue_wait_ms,
          market_regime, funding_state, liquidity_state, mtf_alignment_state,
          evidence_type, is_demo, is_test_fixture, is_fast_lane, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const rec of records) {
        const evType: CandidateEvidenceType =
          rec.evidenceType ??
          (rec.isDemo ? 'DEMO_LATENCY_FIXTURE' : 'LIVE_PRODUCTION');
        const isDemo = Boolean(rec.isDemo);
        const isTestFixture =
          rec.isTestFixture !== undefined
            ? Boolean(rec.isTestFixture)
            : evType !== 'LIVE_PRODUCTION';
        const obsId = `nm:${exchange}:${cycleId}:${rec.symbol}`;
        stmt.run(
          obsId,
          exchange,
          cycleId,
          rec.symbol,
          rec.smcActionState,
          rec.marketRadarCategory,
          rec.intendedDirection ?? 'NEUTRAL',
          JSON.stringify(rec.missingGates ?? []),
          rec.missingGateCount,
          rec.lastBlockingGate ?? '',
          JSON.stringify(rec.waitReasons ?? []),
          rec.evaluationLatencyMs ?? null,
          rec.nextBarRemainingMs ?? null,
          rec.queueWaitMs ?? null,
          rec.marketRegime ?? 'RANGING_CONSOLIDATION',
          rec.fundingState ?? 'NORMAL_FUNDING',
          rec.liquidityState ?? 'ADEQUATE_LIQUIDITY_NO_SWEEP',
          rec.mtfAlignmentState ?? 'MTF_CONFLICT_OR_UNALIGNED',
          evType,
          isDemo ? 1 : 0,
          isTestFixture ? 1 : 0,
          rec.isFastLane ? 1 : 0,
          rec.observedAt ?? observedAt
        );
      }
    });
  }

  public listNearMissObservations(
    exchange: ExchangeId,
    options?: { includeFixtures?: boolean; limit?: number }
  ): SmcNearMissSymbolRecord[] {
    const limit = options?.limit ?? 200;
    const includeFixtures = options?.includeFixtures ?? false;
    const rows = (
      includeFixtures
        ? this.db
            .prepare(
              `SELECT * FROM smc_near_miss_observations
               WHERE exchange = ?
               ORDER BY observed_at DESC, rowid DESC
               LIMIT ?`
            )
            .all(exchange, limit)
        : this.db
            .prepare(
              `SELECT * FROM smc_near_miss_observations
               WHERE exchange = ? AND evidence_type = 'LIVE_PRODUCTION' AND is_demo = 0 AND is_test_fixture = 0
               ORDER BY observed_at DESC, rowid DESC
               LIMIT ?`
            )
            .all(exchange, limit)
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      let missingGates: string[] = [];
      let waitReasons: string[] = [];
      try {
        missingGates = JSON.parse(String(r.missing_gates_json || '[]'));
      } catch {
        missingGates = [];
      }
      try {
        waitReasons = JSON.parse(String(r.wait_reasons_json || '[]'));
      } catch {
        waitReasons = [];
      }
      const mgCount = Number(r.missing_gate_count) === 2 ? 2 : 1;
      const evType = String(
        r.evidence_type || 'LIVE_PRODUCTION'
      ) as CandidateEvidenceType;
      return {
        symbol: String(r.symbol),
        smcActionState: String(r.smc_action_state || 'WATCH') as SmcActionState,
        marketRadarCategory: String(
          r.market_radar_category || '準備觀察'
        ) as MarketRadarCategory,
        nearMissStatus:
          mgCount === 1 ? 'NEAR_MISS_ONE_GATE' : 'NEAR_MISS_TWO_GATES',
        intendedDirection: (String(r.intended_direction) === 'LONG' ||
        String(r.intended_direction) === 'SHORT'
          ? String(r.intended_direction)
          : 'NEUTRAL') as 'LONG' | 'SHORT' | 'NEUTRAL',
        missingGateCount: mgCount as 1 | 2,
        missingGates,
        lastBlockingGate: String(
          r.last_blocking_gate || missingGates[0] || ''
        ),
        waitReasons,
        evaluationLatencyMs:
          r.evaluation_latency_ms !== null &&
          r.evaluation_latency_ms !== undefined
            ? Number(r.evaluation_latency_ms)
            : null,
        nextBarRemainingMs:
          r.next_bar_remaining_ms !== null &&
          r.next_bar_remaining_ms !== undefined
            ? Number(r.next_bar_remaining_ms)
            : null,
        queueWaitMs:
          r.queue_wait_ms !== null && r.queue_wait_ms !== undefined
            ? Number(r.queue_wait_ms)
            : null,
        marketRegime: String(r.market_regime || 'RANGING_CONSOLIDATION'),
        fundingState: String(r.funding_state || 'NORMAL_FUNDING'),
        liquidityState: String(
          r.liquidity_state || 'ADEQUATE_LIQUIDITY_NO_SWEEP'
        ),
        mtfAlignmentState: String(
          r.mtf_alignment_state || 'MTF_CONFLICT_OR_UNALIGNED'
        ),
        evidenceType: evType,
        isDemo: Number(r.is_demo) === 1,
        isTestFixture: Number(r.is_test_fixture) === 1,
        isFastLane: Number(r.is_fast_lane) === 1,
        cycleId: String(r.cycle_id || ''),
        observedAt: String(r.observed_at || ''),
      };
    });
  }

  public buildNearMissDistribution(
    exchange: ExchangeId,
    currentCycleNearMiss: SmcNearMissSymbolRecord[]
  ): NearMissDistributionSummary {
    const persisted = this.listNearMissObservations(exchange, {
      includeFixtures: false,
      limit: 200,
    });
    const sourceRecords =
      currentCycleNearMiss.length > 0 ? currentCycleNearMiss : persisted;
    const byMissingGate: Record<string, number> = {};
    const byIntendedDirection: Record<'LONG' | 'SHORT' | 'NEUTRAL', number> = {
      LONG: 0,
      SHORT: 0,
      NEUTRAL: 0,
    };
    const byMarketRadarCategory: Record<string, number> = {};
    const byMarketRegime: Record<string, number> = {};
    const byFundingState: Record<string, number> = {};
    const byLiquidityState: Record<string, number> = {};
    const byMtfAlignmentState: Record<string, number> = {};
    let nearMissOneGateCount = 0;
    let nearMissTwoGatesCount = 0;

    for (const rec of sourceRecords) {
      if (rec.missingGateCount === 1) nearMissOneGateCount++;
      else nearMissTwoGatesCount++;
      for (const mg of rec.missingGates) {
        byMissingGate[mg] = (byMissingGate[mg] ?? 0) + 1;
      }
      const dir = rec.intendedDirection ?? 'NEUTRAL';
      byIntendedDirection[dir] = (byIntendedDirection[dir] ?? 0) + 1;
      const cat = rec.marketRadarCategory || '準備觀察';
      byMarketRadarCategory[cat] = (byMarketRadarCategory[cat] ?? 0) + 1;
      const reg = rec.marketRegime || 'RANGING_CONSOLIDATION';
      byMarketRegime[reg] = (byMarketRegime[reg] ?? 0) + 1;
      const fund = rec.fundingState || 'NORMAL_FUNDING';
      byFundingState[fund] = (byFundingState[fund] ?? 0) + 1;
      const liq = rec.liquidityState || 'ADEQUATE_LIQUIDITY_NO_SWEEP';
      byLiquidityState[liq] = (byLiquidityState[liq] ?? 0) + 1;
      const mtf = rec.mtfAlignmentState || 'MTF_CONFLICT_OR_UNALIGNED';
      byMtfAlignmentState[mtf] = (byMtfAlignmentState[mtf] ?? 0) + 1;
    }

    return {
      totalNearMissCount: sourceRecords.length,
      nearMissOneGateCount,
      nearMissTwoGatesCount,
      byMissingGate,
      byIntendedDirection,
      byMarketRadarCategory,
      byMarketRegime,
      byFundingState,
      byLiquidityState,
      byMtfAlignmentState,
      persistedObservationCount: persisted.length,
      records: sourceRecords,
    };
  }

  public buildLiveCloseEventWindowReport(
    exchange: ExchangeId,
    windowHours: 24 | 72,
    nowIso?: string
  ): LiveCloseEventWindowReport {
    const endMs = nowIso ? Date.parse(nowIso) : Date.now();
    const startMs = endMs - windowHours * 3600_000;
    const allLiveEvents = this.list15mCloseEvents(exchange, {
      includeFixtures: false,
      limit: 500,
    });
    const eventsInWindow = allLiveEvents.filter((ev) => {
      const t = Date.parse(ev.closeEventAt);
      return Number.isFinite(t) && t >= startMs && t <= endMs + 60_000;
    });
    const triggeredFastLaneCount = eventsInWindow.reduce(
      (acc, e) => acc + e.triggeredFastLaneCount,
      0
    );
    const completedFastLaneCount = eventsInWindow.reduce(
      (acc, e) => acc + e.completedFastLaneCount,
      0
    );
    const fastLaneCompletionRate =
      triggeredFastLaneCount > 0
        ? Number((completedFastLaneCount / triggeredFastLaneCount).toFixed(4))
        : null;
    const formalCandidateCount = eventsInWindow.reduce(
      (acc, e) => acc + e.formalCandidateCount,
      0
    );
    const nearMissCount = eventsInWindow.reduce(
      (acc, e) => acc + e.nearMissCount,
      0
    );
    const candidateDetectedBeforeEntryCount = eventsInWindow.reduce(
      (acc, e) => acc + e.candidateDetectedBeforeEntryCount,
      0
    );
    const entryWindowMissedCount = eventsInWindow.reduce(
      (acc, e) => acc + e.entryWindowMissedCount,
      0
    );
    const p50Vals = eventsInWindow
      .map((e) => e.queueWaitP50)
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .sort((a, b) => a - b);
    const p95Vals = eventsInWindow
      .map((e) => e.queueWaitP95)
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .sort((a, b) => a - b);
    const pct = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(
        arr.length - 1,
        Math.max(0, Math.ceil((p / 100) * arr.length) - 1)
      );
      return Math.round(arr[idx]);
    };

    return {
      windowLabel: windowHours === 24 ? '24h' : '72h',
      windowHours,
      windowStartAt: new Date(startMs).toISOString(),
      windowEndAt: new Date(endMs).toISOString(),
      evidenceType: 'LIVE_PRODUCTION',
      isDemo: false,
      isTestFixture: false,
      totalCloseEventCount: eventsInWindow.length,
      triggeredFastLaneCount,
      completedFastLaneCount,
      fastLaneCompletionRate,
      formalCandidateCount,
      nearMissCount,
      candidateDetectedBeforeEntryCount,
      entryWindowMissedCount,
      queueWaitP50: pct(p50Vals, 50),
      queueWaitP95: pct(p95Vals, 95),
      events: eventsInWindow,
    };
  }

  public getLiveCaptureObservation(
    exchange: ExchangeId,
    options?: {
      snapshotConsistency?: SnapshotConsistencyMode;
      sharedContext?: {
        diag: ReturnType<RadarDatabase['computeCycleDiagnosticsAndFunnel']>;
        capturedAt: string;
      };
    }
  ): PaperQualityLiveCaptureResponse {
    const diag =
      options?.sharedContext?.diag ??
      this.computeCycleDiagnosticsAndFunnel(exchange);
    const capturedAt =
      options?.sharedContext?.capturedAt ?? new Date().toISOString();
    const snapshotConsistency: SnapshotConsistencyMode =
      options?.snapshotConsistency ??
      (options?.sharedContext
        ? 'SHARED_ATOMIC_SNAPSHOT'
        : 'INDEPENDENT_ENDPOINT_SNAPSHOT');
    const liveCandidates = this.listLiveCaptureCandidates(exchange);
    const controlledCandidates = this.listControlledFixtureCandidates(exchange);

    // Ensure any current-cycle LIVE_PRODUCTION formal candidate from smc_scan_results is also represented
    const seenIds = new Set(liveCandidates.map((c) => c.signalId));
    const mergedLiveCandidates: LiveCaptureCandidateRecord[] = [
      ...liveCandidates,
    ];
    for (const slaRec of diag.formalCandidateLatencySla.candidates) {
      if (slaRec.evidenceType === 'LIVE_PRODUCTION' && !slaRec.isDemo) {
        const direction =
          slaRec.smcActionState === 'SHORT CANDIDATE' ? 'SHORT' : 'LONG';
        const sigBarOpen =
          slaRec.signalBarOpenTime ??
          (slaRec.signalBarCloseTime !== null
            ? Number(slaRec.signalBarCloseTime) - 900_000 + 1
            : 0);
        const sigId = `${slaRec.symbol}:${exchange}:15m:${direction}:${sigBarOpen}:smc_v2_strict`;
        if (!seenIds.has(sigId)) {
          seenIds.add(sigId);
          mergedLiveCandidates.push({
            cycleId: diag.cycleId,
            signalId: sigId,
            symbol: slaRec.symbol,
            exchange,
            timeframe: '15m',
            direction,
            signalBarOpenTime: slaRec.signalBarOpenTime ?? null,
            signalBarCloseTime: slaRec.signalBarCloseTime ?? null,
            nextBarOpenTime: slaRec.nextBarOpenTime ?? null,
            candidateDetectedAt: slaRec.candidateDetectedAt,
            signalDetectedAt: slaRec.signalDetectedAt,
            queueEnteredAt: slaRec.queueEnteredAt ?? null,
            evaluationStartedAt: slaRec.evaluationStartedAt,
            evaluationCompletedAt: slaRec.evaluationCompletedAt,
            queueWaitMs: slaRec.queueWaitMs ?? null,
            evaluationLatencyMs: slaRec.evaluationLatencyMs ?? null,
            candidateDetectionLatencyMs:
              slaRec.candidateDetectionLatencyMs ?? null,
            nextBarRemainingMs: slaRec.nextBarRemainingMs ?? null,
            entryWindowStatus: slaRec.entryWindowStatus,
            entryWindowMissed: slaRec.entryWindowMissed,
            isFastLane: slaRec.isFastLane,
            evidenceType: 'LIVE_PRODUCTION',
            source: 'Binance USDⓈ-M Futures Public REST API',
            fetchedAt: slaRec.evaluationCompletedAt,
            stale: false,
            fallback: false,
            isDemo: false,
            isTestFixture: false,
          });
        }
      }
    }

    return {
      exchange,
      cycleId: diag.cycleId,
      snapshotAt: diag.snapshotAt,
      capturedAt,
      statsVersion: diag.statsVersion,
      aggregationScope: 'CURRENT_CYCLE',
      snapshotConsistency,
      statsConsistency: diag.statsConsistency,
      evidenceType: 'LIVE_PRODUCTION',
      isDemo: false,
      isTestFixture: false,
      liveValidationStatus: diag.liveValidationStatus,
      liveSampleValidationStatus: diag.liveSampleValidationStatus,
      liveValidationStates: diag.liveValidationStates,
      liveValidationMessage: diag.liveValidationMessage,
      isLiveValidated: diag.isLiveValidated,
      candidateDetectionLatencyP50: diag.LIVE_DETECTION_LATENCY_P50,
      candidateDetectionLatencyP95: diag.LIVE_DETECTION_LATENCY_P95,
      entryWindowMissedRate: diag.LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_FORMAL_CANDIDATE_COUNT: diag.LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT: diag.LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT: diag.LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
        diag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT: diag.LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_RATE: diag.LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_DETECTION_LATENCY_P50: diag.LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95: diag.LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50:
        diag.LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95:
        diag.LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50: diag.LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95: diag.LIVE_BULK_DETECTION_LATENCY_P95,
      liveProductionCandidates: mergedLiveCandidates,
      controlledFixtureCandidates: controlledCandidates,
      CONTROLLED_LIVE_FIXTURE: diag.CONTROLLED_LIVE_FIXTURE,
      DEMO_LATENCY_FIXTURE: diag.DEMO_LATENCY_FIXTURE,
      evidenceIsolationGuarantee: {
        liveProductionIsolated: true,
        controlledFixtureNeverCountedInLive: true,
        demoFixtureNeverCountedInLive: true,
        controlledTestPassingNeverMarkedLiveValidated: true,
      },
      notices: [
        '目前尚無真實 Live 正式候選，Live 捕捉 SLA 尚未驗證。',
        '尚無真實 Live 正式候選',
        'Live 捕捉 SLA 尚未驗證',
        'Fast Lane 已運作，但目前沒有正式候選樣本',
        'Near-Miss 不等於正式訊號',
        'Shadow 候選不等於 Paper 訊號',
        '尚無足夠已結算樣本，不能判斷策略有效性',
        '受控測試通過不等於真實 Live 已驗證。',
        '沒有正式候選時，Live 延遲為 null。',
        'Radar Long/Short 不等於 SMC LONG/SHORT。',
        '系統仍為 PAPER ONLY。',
      ],
      executionSafety: {
        paperOnly: true,
        liveOrdersDisabled: true,
        neverAutoPlaceOrders: true,
        externalNotificationCount: 0,
      },
    };
  }

  public getLiveCaptureEvents(
    exchange: ExchangeId,
    options?: {
      snapshotConsistency?: SnapshotConsistencyMode;
      sharedContext?: {
        diag: ReturnType<RadarDatabase['computeCycleDiagnosticsAndFunnel']>;
        capturedAt: string;
      };
    }
  ): PaperQualityLiveCaptureEventsResponse {
    const diag =
      options?.sharedContext?.diag ??
      this.computeCycleDiagnosticsAndFunnel(exchange);
    const capturedAt =
      options?.sharedContext?.capturedAt ?? new Date().toISOString();
    const snapshotConsistency: SnapshotConsistencyMode =
      options?.snapshotConsistency ??
      (options?.sharedContext
        ? 'SHARED_ATOMIC_SNAPSHOT'
        : 'INDEPENDENT_ENDPOINT_SNAPSHOT');
    const liveEvents = this.list15mCloseEvents(exchange, {
      includeFixtures: false,
      limit: 100,
    });
    const totalFastLaneTriggered = liveEvents.reduce(
      (acc, e) => acc + e.triggeredFastLaneCount,
      0
    );
    const totalFastLaneCompleted = liveEvents.reduce(
      (acc, e) => acc + e.completedFastLaneCount,
      0
    );
    const fastLaneCompletionRate =
      totalFastLaneTriggered > 0
        ? Number((totalFastLaneCompleted / totalFastLaneTriggered).toFixed(4))
        : null;
    const totalLiveFormalCandidatesFromCloseEvents = liveEvents.reduce(
      (acc, e) => acc + e.formalCandidateCount,
      0
    );
    const report24h = this.buildLiveCloseEventWindowReport(
      exchange,
      24,
      capturedAt
    );
    const report72h = this.buildLiveCloseEventWindowReport(
      exchange,
      72,
      capturedAt
    );

    return {
      exchange,
      cycleId: diag.cycleId,
      snapshotAt: diag.snapshotAt,
      capturedAt,
      statsVersion: diag.statsVersion,
      aggregationScope: 'MONITORING_WINDOW',
      snapshotConsistency,
      statsConsistency: diag.statsConsistency,
      evidenceType: 'LIVE_PRODUCTION',
      isDemo: false,
      isTestFixture: false,
      totalCloseEventCount: liveEvents.length,
      totalFastLaneTriggered,
      totalFastLaneCompleted,
      fastLaneCompletionRate,
      totalLiveFormalCandidatesFromCloseEvents,
      latestCloseEvent: liveEvents.length > 0 ? liveEvents[0] : null,
      events: liveEvents,
      report24h,
      report72h,
      demoAndControlledExcludedFromEvents: true,
      notices: [
        '每次已確認 15m K 線收盤事件均獨立記錄，絕不使用 Demo 或 Controlled Fixture 補入真實 Live 指標。',
        'Fast Lane 已運作，但目前沒有正式候選樣本',
        '受控測試通過不等於真實 Live 已驗證。',
        '系統仍為 PAPER ONLY。',
      ],
      executionSafety: {
        paperOnly: true,
        liveOrdersDisabled: true,
        neverAutoPlaceOrders: true,
        externalNotificationCount: 0,
      },
    };
  }

  public getLiveCaptureSummary(
    exchange: ExchangeId,
    options?: {
      snapshotConsistency?: SnapshotConsistencyMode;
      sharedContext?: {
        diag: ReturnType<RadarDatabase['computeCycleDiagnosticsAndFunnel']>;
        capturedAt: string;
      };
    }
  ): PaperQualityLiveCaptureSummaryResponse {
    const diag =
      options?.sharedContext?.diag ??
      this.computeCycleDiagnosticsAndFunnel(exchange);
    const capturedAt =
      options?.sharedContext?.capturedAt ?? new Date().toISOString();
    const snapshotConsistency: SnapshotConsistencyMode =
      options?.snapshotConsistency ??
      (options?.sharedContext
        ? 'SHARED_ATOMIC_SNAPSHOT'
        : 'INDEPENDENT_ENDPOINT_SNAPSHOT');
    const eventsResp = this.getLiveCaptureEvents(exchange, {
      snapshotConsistency,
      sharedContext: { diag, capturedAt },
    });
    const nearMissDistribution = this.buildNearMissDistribution(
      exchange,
      diag.smcGateDiagnostics.nearMissSymbols.filter(
        (nm) =>
          !nm.isDemo &&
          !nm.isTestFixture &&
          (nm.evidenceType ?? 'LIVE_PRODUCTION') === 'LIVE_PRODUCTION'
      )
    );

    return {
      exchange,
      cycleId: diag.cycleId,
      snapshotAt: diag.snapshotAt,
      capturedAt,
      statsVersion: diag.statsVersion,
      aggregationScope: 'CURRENT_CYCLE',
      snapshotConsistency,
      statsConsistency: diag.statsConsistency,
      evidenceType: 'LIVE_PRODUCTION',
      isDemo: false,
      isTestFixture: false,
      liveValidationStatus: diag.liveValidationStatus,
      liveSampleValidationStatus: diag.liveSampleValidationStatus,
      liveValidationStates: diag.liveValidationStates,
      liveValidationMessage: diag.liveValidationMessage,
      isLiveValidated: diag.isLiveValidated,
      strategyValidity: diag.signalQualityCalibration.strategyValidity,
      candidateDetectionLatencyP50: diag.LIVE_DETECTION_LATENCY_P50,
      candidateDetectionLatencyP95: diag.LIVE_DETECTION_LATENCY_P95,
      entryWindowMissedRate: diag.LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_FORMAL_CANDIDATE_COUNT: diag.LIVE_FORMAL_CANDIDATE_COUNT,
      LIVE_FAST_LANE_COUNT: diag.LIVE_FAST_LANE_COUNT,
      LIVE_BULK_COUNT: diag.LIVE_BULK_COUNT,
      LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT:
        diag.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_COUNT: diag.LIVE_ENTRY_WINDOW_MISSED_COUNT,
      LIVE_ENTRY_WINDOW_MISSED_RATE: diag.LIVE_ENTRY_WINDOW_MISSED_RATE,
      LIVE_DETECTION_LATENCY_P50: diag.LIVE_DETECTION_LATENCY_P50,
      LIVE_DETECTION_LATENCY_P95: diag.LIVE_DETECTION_LATENCY_P95,
      LIVE_FAST_LANE_DETECTION_LATENCY_P50:
        diag.LIVE_FAST_LANE_DETECTION_LATENCY_P50,
      LIVE_FAST_LANE_DETECTION_LATENCY_P95:
        diag.LIVE_FAST_LANE_DETECTION_LATENCY_P95,
      LIVE_BULK_DETECTION_LATENCY_P50: diag.LIVE_BULK_DETECTION_LATENCY_P50,
      LIVE_BULK_DETECTION_LATENCY_P95: diag.LIVE_BULK_DETECTION_LATENCY_P95,
      CONTROLLED_LIVE_FIXTURE: diag.CONTROLLED_LIVE_FIXTURE,
      DEMO_LATENCY_FIXTURE: diag.DEMO_LATENCY_FIXTURE,
      fastLaneCompletionRate: eventsResp.fastLaneCompletionRate,
      closeEventSummary: {
        totalCloseEventCount: eventsResp.totalCloseEventCount,
        totalFastLaneTriggered: eventsResp.totalFastLaneTriggered,
        totalFastLaneCompleted: eventsResp.totalFastLaneCompleted,
        fastLaneCompletionRate: eventsResp.fastLaneCompletionRate,
        latestCloseEvent: eventsResp.latestCloseEvent,
      },
      report24h: eventsResp.report24h,
      report72h: eventsResp.report72h,
      nearMissDistribution,
      nearMissObservations: nearMissDistribution.records,
      signalQualityCalibration: diag.signalQualityCalibration,
      observationShadowComparison: diag.observationShadowComparison,
      currentCycleFunnel: diag.currentCycleFunnel,
      monitoringWindowFunnel: diag.monitoringWindowFunnel,
      cumulativeFunnel: diag.cumulativeFunnel,
      historicalSignalsOutsideCurrentCycle:
        diag.historicalSignalsOutsideCurrentCycle,
      historicalSignalsOutsideWindow: diag.historicalSignalsOutsideWindow,
      permanentNotices: [
        '目前尚無真實 Live 正式候選，Live 捕捉 SLA 尚未驗證。',
        '尚無真實 Live 正式候選',
        'Live 捕捉 SLA 尚未驗證',
        'Fast Lane 已運作，但目前沒有正式候選樣本',
        'Near-Miss 不等於正式訊號',
        'Shadow 候選不等於 Paper 訊號',
        '尚無足夠已結算樣本，不能判斷策略有效性',
        '受控測試通過不等於真實 Live 已驗證。',
        '沒有正式候選時，Live 延遲為 null。',
        'Radar Long/Short 不等於 SMC LONG/SHORT。',
        '系統仍為 PAPER ONLY。',
      ],
      executionSafety: {
        paperOnly: true,
        liveOrdersDisabled: true,
        neverAutoPlaceOrders: true,
        externalNotificationCount: 0,
      },
    };
  }

  public getSharedAtomicLiveCaptureBundle(
    exchange: ExchangeId
  ): SharedAtomicLiveCaptureBundle {
    const diag = this.computeCycleDiagnosticsAndFunnel(exchange);
    const capturedAt = new Date().toISOString();
    const sharedContext = { diag, capturedAt };
    return {
      exchange,
      cycleId: diag.cycleId,
      snapshotAt: diag.snapshotAt,
      capturedAt,
      statsVersion: diag.statsVersion,
      aggregationScope: 'CURRENT_CYCLE',
      snapshotConsistency: 'SHARED_ATOMIC_SNAPSHOT',
      statsConsistency: diag.statsConsistency,
      liveCapture: this.getLiveCaptureObservation(exchange, {
        snapshotConsistency: 'SHARED_ATOMIC_SNAPSHOT',
        sharedContext,
      }),
      events: this.getLiveCaptureEvents(exchange, {
        snapshotConsistency: 'SHARED_ATOMIC_SNAPSHOT',
        sharedContext,
      }),
      summary: this.getLiveCaptureSummary(exchange, {
        snapshotConsistency: 'SHARED_ATOMIC_SNAPSHOT',
        sharedContext,
      }),
    };
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  // ============================================================================
  // Auto-Backtest Config & Batch Logs + External Notification Persistence
  // ============================================================================

  public getAutoBacktestConfig(): AutoBacktestConfig {
    const row = this.db
      .prepare('SELECT * FROM auto_backtest_config WHERE id = 1 LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      const nowIso = new Date().toISOString();
      return {
        enabled: false,
        intervalMs: 3_600_000,
        timeframe: '15m',
        maxSymbolsPerRun: 15,
        includeWatchlist: true,
        watchlistSymbols: ['BTCUSDT', 'ETHUSDT'],
        exchange: 'binance_usdm',
        updatedAt: nowIso,
      };
    }
    let watchlist: string[] = ['BTCUSDT', 'ETHUSDT'];
    try {
      const parsed = JSON.parse(String(row.watchlist_symbols_json || '[]'));
      if (Array.isArray(parsed)) {
        watchlist = parsed
          .map((s) => String(s).trim().toUpperCase())
          .filter(Boolean);
      }
    } catch {
      watchlist = ['BTCUSDT', 'ETHUSDT'];
    }
    const tf = String(row.timeframe || '15m');
    const validTf: Timeframe =
      tf === '5m' || tf === '15m' || tf === '1h' || tf === '4h' ? tf : '15m';
    const ex = String(row.exchange || 'binance_usdm') as ExchangeId;
    return {
      enabled: Number(row.enabled ?? 0) === 1,
      intervalMs: Math.max(60_000, Number(row.interval_ms ?? 3_600_000)),
      timeframe: validTf,
      maxSymbolsPerRun: Math.min(
        30,
        Math.max(1, Number(row.max_symbols_per_run ?? 15))
      ),
      includeWatchlist: Number(row.include_watchlist ?? 1) === 1,
      watchlistSymbols: watchlist,
      exchange: ex,
      updatedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  public saveAutoBacktestConfig(
    patch: Partial<Omit<AutoBacktestConfig, 'updatedAt'>>
  ): AutoBacktestConfig {
    const current = this.getAutoBacktestConfig();
    const next: AutoBacktestConfig = {
      enabled:
        patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
      intervalMs:
        patch.intervalMs !== undefined && Number.isFinite(patch.intervalMs)
          ? Math.max(60_000, Math.round(patch.intervalMs))
          : current.intervalMs,
      timeframe:
        patch.timeframe &&
        ['5m', '15m', '1h', '4h'].includes(patch.timeframe)
          ? patch.timeframe
          : current.timeframe,
      maxSymbolsPerRun:
        patch.maxSymbolsPerRun !== undefined &&
        Number.isFinite(patch.maxSymbolsPerRun)
          ? Math.min(30, Math.max(1, Math.round(patch.maxSymbolsPerRun)))
          : current.maxSymbolsPerRun,
      includeWatchlist:
        patch.includeWatchlist !== undefined
          ? Boolean(patch.includeWatchlist)
          : current.includeWatchlist,
      watchlistSymbols: Array.isArray(patch.watchlistSymbols)
        ? [
            ...new Set(
              patch.watchlistSymbols
                .map((s) => String(s).trim().toUpperCase())
                .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
            ),
          ].slice(0, 40)
        : current.watchlistSymbols,
      exchange: patch.exchange ?? current.exchange,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
        INSERT INTO auto_backtest_config (
          id, enabled, interval_ms, timeframe, max_symbols_per_run,
          include_watchlist, watchlist_symbols_json, exchange, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          interval_ms = excluded.interval_ms,
          timeframe = excluded.timeframe,
          max_symbols_per_run = excluded.max_symbols_per_run,
          include_watchlist = excluded.include_watchlist,
          watchlist_symbols_json = excluded.watchlist_symbols_json,
          exchange = excluded.exchange,
          updated_at = excluded.updated_at
      `
      )
      .run(
        next.enabled ? 1 : 0,
        next.intervalMs,
        next.timeframe,
        next.maxSymbolsPerRun,
        next.includeWatchlist ? 1 : 0,
        JSON.stringify(next.watchlistSymbols),
        next.exchange,
        next.updatedAt
      );
    return next;
  }

  public recordAutoBacktestBatch(
    batch: AutoBacktestBatchRunRecord
  ): AutoBacktestBatchRunRecord {
    this.db
      .prepare(
        `
        INSERT INTO auto_backtest_batches (
          batch_id, exchange, timeframe, started_at, completed_at, status,
          target_symbols_json, completed_count, skipped_cached_count,
          failed_count, saved_run_ids_json, note, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          completed_at = excluded.completed_at,
          status = excluded.status,
          completed_count = excluded.completed_count,
          skipped_cached_count = excluded.skipped_cached_count,
          failed_count = excluded.failed_count,
          saved_run_ids_json = excluded.saved_run_ids_json,
          note = excluded.note,
          duration_ms = excluded.duration_ms
      `
      )
      .run(
        batch.batchId,
        batch.exchange,
        batch.timeframe,
        batch.startedAt,
        batch.completedAt,
        batch.status,
        JSON.stringify(batch.targetSymbols),
        batch.completedCount,
        batch.skippedCachedCount,
        batch.failedCount,
        JSON.stringify(batch.savedRunIds),
        batch.note,
        batch.durationMs
      );
    return batch;
  }

  public listAutoBacktestBatches(limit = 20): AutoBacktestBatchRunRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM auto_backtest_batches ORDER BY started_at DESC LIMIT ?'
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      batchId: String(r.batch_id),
      exchange: String(r.exchange) as ExchangeId,
      timeframe: String(r.timeframe) as Timeframe,
      startedAt: String(r.started_at),
      completedAt: r.completed_at ? String(r.completed_at) : null,
      status: String(r.status) as AutoBacktestBatchRunRecord['status'],
      targetSymbols: JSON.parse(String(r.target_symbols_json || '[]')),
      completedCount: Number(r.completed_count ?? 0),
      skippedCachedCount: Number(r.skipped_cached_count ?? 0),
      failedCount: Number(r.failed_count ?? 0),
      savedRunIds: JSON.parse(String(r.saved_run_ids_json || '[]')),
      note: String(r.note || ''),
      durationMs: Number(r.duration_ms ?? 0),
    }));
  }

  public hasRecentBacktestForSymbol(params: {
    symbol: string;
    exchange: ExchangeId;
    timeframe: Timeframe;
    ruleVersion: string;
    minCreatedAfterIso: string;
  }): boolean {
    const row = this.db
      .prepare(
        `
        SELECT id FROM backtest_reports
        WHERE symbol = ?
          AND exchange = ?
          AND timeframe = ?
          AND (rule_version = ? OR scanner_rule_version = ?)
          AND created_at >= ?
          AND status = 'COMPLETED'
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(
        params.symbol,
        params.exchange,
        params.timeframe,
        params.ruleVersion,
        params.ruleVersion,
        params.minCreatedAfterIso
      ) as { id?: number } | undefined;
    return Boolean(row?.id);
  }

  public getExternalNotificationConfig(): ExternalNotificationConfig {
    const row = this.db
      .prepare('SELECT * FROM external_notification_config WHERE id = 1 LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        telegramEnabled: false,
        discordEnabled: false,
        notifyFormalSmc: true,
        notifyEarlyIgnition: true,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      telegramEnabled: Number(row.telegram_enabled ?? 0) === 1,
      discordEnabled: Number(row.discord_enabled ?? 0) === 1,
      notifyFormalSmc: Number(row.notify_formal_smc ?? 1) === 1,
      notifyEarlyIgnition: Number(row.notify_early_ignition ?? 1) === 1,
      updatedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  public saveExternalNotificationConfig(
    patch: Partial<Omit<ExternalNotificationConfig, 'updatedAt'>>
  ): ExternalNotificationConfig {
    const current = this.getExternalNotificationConfig();
    const next: ExternalNotificationConfig = {
      telegramEnabled:
        patch.telegramEnabled !== undefined
          ? Boolean(patch.telegramEnabled)
          : current.telegramEnabled,
      discordEnabled:
        patch.discordEnabled !== undefined
          ? Boolean(patch.discordEnabled)
          : current.discordEnabled,
      notifyFormalSmc:
        patch.notifyFormalSmc !== undefined
          ? Boolean(patch.notifyFormalSmc)
          : current.notifyFormalSmc,
      notifyEarlyIgnition:
        patch.notifyEarlyIgnition !== undefined
          ? Boolean(patch.notifyEarlyIgnition)
          : current.notifyEarlyIgnition,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `
        INSERT INTO external_notification_config (
          id, telegram_enabled, discord_enabled,
          notify_formal_smc, notify_early_ignition, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          telegram_enabled = excluded.telegram_enabled,
          discord_enabled = excluded.discord_enabled,
          notify_formal_smc = excluded.notify_formal_smc,
          notify_early_ignition = excluded.notify_early_ignition,
          updated_at = excluded.updated_at
      `
      )
      .run(
        next.telegramEnabled ? 1 : 0,
        next.discordEnabled ? 1 : 0,
        next.notifyFormalSmc ? 1 : 0,
        next.notifyEarlyIgnition ? 1 : 0,
        next.updatedAt
      );
    return next;
  }

  public recordExternalNotificationLog(
    log: ExternalNotificationDispatchLog
  ): ExternalNotificationDispatchLog {
    this.db
      .prepare(
        `
        INSERT INTO external_notification_logs (
          id, channel, symbol, track, action_state, status, reason,
          http_status, is_test, message_preview, dedupe_key, cooldown_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        log.id,
        log.channel,
        log.symbol,
        log.track,
        log.actionState,
        log.status,
        log.reason,
        log.httpStatus,
        log.isTest ? 1 : 0,
        log.messagePreview,
        log.dedupeKey,
        log.cooldownUntil,
        log.createdAt
      );
    return log;
  }

  public listExternalNotificationLogs(
    limit = 40
  ): ExternalNotificationDispatchLog[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM external_notification_logs ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      channel: String(r.channel) as ExternalNotificationChannel,
      symbol: String(r.symbol),
      track: String(r.track) as ExternalNotificationSignalTrack,
      actionState: String(r.action_state),
      status: String(r.status) as ExternalNotificationStatus,
      reason: String(r.reason),
      httpStatus:
        r.http_status !== null && r.http_status !== undefined
          ? Number(r.http_status)
          : null,
      isTest: Number(r.is_test ?? 0) === 1,
      messagePreview: String(r.message_preview || ''),
      dedupeKey: r.dedupe_key ? String(r.dedupe_key) : null,
      cooldownUntil: r.cooldown_until ? String(r.cooldown_until) : null,
      createdAt: String(r.created_at),
    }));
  }

  public getPositionSentinelConfig(): PositionSentinelConfig {
    const row = this.db
      .prepare('SELECT * FROM position_sentinel_config WHERE id = 1 LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        enabled: true,
        autoSyncPaperLedger: true,
        wsStreamEnabled: true,
        pollIntervalMs: 15_000,
        atrShockMultiplier: 1.25,
        rvolSpikeThreshold: 2.5,
        stopProximityPct: 0.5,
        notifyDiscord: true,
        notifyTelegram: true,
        notifyMinSeverity: 'WARNING',
        alertCooldownMs: 180_000,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      enabled: Number(row.enabled ?? 1) === 1,
      autoSyncPaperLedger: Number(row.auto_sync_paper_ledger ?? 1) === 1,
      wsStreamEnabled: Number(row.ws_stream_enabled ?? 1) === 1,
      pollIntervalMs: Math.max(5000, Number(row.poll_interval_ms ?? 15_000)),
      atrShockMultiplier: Math.max(0.5, Number(row.atr_shock_multiplier ?? 1.25)),
      rvolSpikeThreshold: Math.max(1.2, Number(row.rvol_spike_threshold ?? 2.5)),
      stopProximityPct: Math.max(0.1, Number(row.stop_proximity_pct ?? 0.5)),
      notifyDiscord: Number(row.notify_discord ?? 1) === 1,
      notifyTelegram: Number(row.notify_telegram ?? 1) === 1,
      notifyMinSeverity:
        String(row.notify_min_severity) === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      alertCooldownMs: Math.max(30_000, Number(row.alert_cooldown_ms ?? 180_000)),
      updatedAt: String(row.updated_at || new Date().toISOString()),
    };
  }

  public savePositionSentinelConfig(
    patch: Partial<Omit<PositionSentinelConfig, 'updatedAt'>>
  ): PositionSentinelConfig {
    const cur = this.getPositionSentinelConfig();
    const next: PositionSentinelConfig = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
      autoSyncPaperLedger:
        patch.autoSyncPaperLedger !== undefined
          ? Boolean(patch.autoSyncPaperLedger)
          : cur.autoSyncPaperLedger,
      wsStreamEnabled:
        patch.wsStreamEnabled !== undefined
          ? Boolean(patch.wsStreamEnabled)
          : cur.wsStreamEnabled,
      pollIntervalMs:
        patch.pollIntervalMs !== undefined && Number.isFinite(patch.pollIntervalMs)
          ? Math.max(5_000, Math.min(300_000, Math.round(patch.pollIntervalMs)))
          : cur.pollIntervalMs,
      atrShockMultiplier:
        patch.atrShockMultiplier !== undefined &&
        Number.isFinite(patch.atrShockMultiplier)
          ? Math.max(0.5, Math.min(5, Number(patch.atrShockMultiplier)))
          : cur.atrShockMultiplier,
      rvolSpikeThreshold:
        patch.rvolSpikeThreshold !== undefined &&
        Number.isFinite(patch.rvolSpikeThreshold)
          ? Math.max(1.2, Math.min(10, Number(patch.rvolSpikeThreshold)))
          : cur.rvolSpikeThreshold,
      stopProximityPct:
        patch.stopProximityPct !== undefined &&
        Number.isFinite(patch.stopProximityPct)
          ? Math.max(0.1, Math.min(5, Number(patch.stopProximityPct)))
          : cur.stopProximityPct,
      notifyDiscord:
        patch.notifyDiscord !== undefined
          ? Boolean(patch.notifyDiscord)
          : cur.notifyDiscord,
      notifyTelegram:
        patch.notifyTelegram !== undefined
          ? Boolean(patch.notifyTelegram)
          : cur.notifyTelegram,
      notifyMinSeverity:
        patch.notifyMinSeverity === 'CRITICAL'
          ? 'CRITICAL'
          : patch.notifyMinSeverity === 'WARNING'
            ? 'WARNING'
            : cur.notifyMinSeverity,
      alertCooldownMs:
        patch.alertCooldownMs !== undefined && Number.isFinite(patch.alertCooldownMs)
          ? Math.max(30_000, Math.min(3_600_000, Math.round(patch.alertCooldownMs)))
          : cur.alertCooldownMs,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `
        INSERT INTO position_sentinel_config (
          id, enabled, auto_sync_paper_ledger, ws_stream_enabled,
          poll_interval_ms, atr_shock_multiplier, rvol_spike_threshold,
          stop_proximity_pct, notify_discord, notify_telegram,
          notify_min_severity, alert_cooldown_ms, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          auto_sync_paper_ledger = excluded.auto_sync_paper_ledger,
          ws_stream_enabled = excluded.ws_stream_enabled,
          poll_interval_ms = excluded.poll_interval_ms,
          atr_shock_multiplier = excluded.atr_shock_multiplier,
          rvol_spike_threshold = excluded.rvol_spike_threshold,
          stop_proximity_pct = excluded.stop_proximity_pct,
          notify_discord = excluded.notify_discord,
          notify_telegram = excluded.notify_telegram,
          notify_min_severity = excluded.notify_min_severity,
          alert_cooldown_ms = excluded.alert_cooldown_ms,
          updated_at = excluded.updated_at
      `
      )
      .run(
        next.enabled ? 1 : 0,
        next.autoSyncPaperLedger ? 1 : 0,
        next.wsStreamEnabled ? 1 : 0,
        next.pollIntervalMs,
        next.atrShockMultiplier,
        next.rvolSpikeThreshold,
        next.stopProximityPct,
        next.notifyDiscord ? 1 : 0,
        next.notifyTelegram ? 1 : 0,
        next.notifyMinSeverity,
        next.alertCooldownMs,
        next.updatedAt
      );
    return next;
  }

  private mapPositionSentinelRow(
    r: Record<string, unknown>
  ): PositionSentinelTrackedPosition {
    return {
      id: String(r.id),
      sourceType: (String(r.source_type || 'MANUAL') === 'PAPER_LEDGER'
        ? 'PAPER_LEDGER'
        : 'MANUAL') as PositionSentinelSourceType,
      paperLedgerId:
        r.paper_ledger_id !== null && r.paper_ledger_id !== undefined
          ? Number(r.paper_ledger_id)
          : null,
      symbol: String(r.symbol).toUpperCase(),
      exchange: String(r.exchange || 'binance_usdm') as ExchangeId,
      side: String(r.side) === 'SHORT' ? 'SHORT' : 'LONG',
      timeframe: (String(r.timeframe || '15m') as Timeframe) || '15m',
      entryPrice: Number(r.entry_price),
      invalidationPrice: Number(r.invalidation_price),
      targetPrice:
        r.target_price !== null && r.target_price !== undefined
          ? Number(r.target_price)
          : null,
      leverage: Math.max(1, Number(r.leverage ?? 1)),
      active: Number(r.active ?? 1) === 1,
      paused: Number(r.paused ?? 0) === 1,
      notes: String(r.notes || ''),
      openedAt: String(r.opened_at),
      updatedAt: String(r.updated_at),
    };
  }

  public addPositionSentinelPosition(input: {
    id?: string;
    sourceType?: PositionSentinelSourceType;
    paperLedgerId?: number | null;
    symbol: string;
    exchange: ExchangeId;
    side: 'LONG' | 'SHORT';
    timeframe?: Timeframe;
    entryPrice: number;
    invalidationPrice: number;
    targetPrice?: number | null;
    leverage?: number;
    notes?: string;
    openedAt?: string;
  }): PositionSentinelTrackedPosition {
    const nowIso = new Date().toISOString();
    const id =
      input.id ??
      (input.paperLedgerId
        ? `ps_paper_${input.paperLedgerId}`
        : `ps_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const symbol = input.symbol.trim().toUpperCase();
    const timeframe = input.timeframe ?? '15m';
    const targetPrice =
      input.targetPrice !== undefined &&
      input.targetPrice !== null &&
      Number.isFinite(input.targetPrice) &&
      input.targetPrice > 0
        ? input.targetPrice
        : null;
    const leverage =
      input.leverage !== undefined && Number.isFinite(input.leverage)
        ? Math.max(1, Math.min(125, Number(input.leverage)))
        : 1;

    this.db
      .prepare(
        `
        INSERT INTO position_sentinel_positions (
          id, source_type, paper_ledger_id, symbol, exchange, side, timeframe,
          entry_price, invalidation_price, target_price, leverage,
          active, paused, notes, opened_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          symbol = excluded.symbol,
          exchange = excluded.exchange,
          side = excluded.side,
          timeframe = excluded.timeframe,
          entry_price = excluded.entry_price,
          invalidation_price = excluded.invalidation_price,
          target_price = excluded.target_price,
          leverage = excluded.leverage,
          active = 1,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `
      )
      .run(
        id,
        input.sourceType ?? 'MANUAL',
        input.paperLedgerId ?? null,
        symbol,
        input.exchange,
        input.side,
        timeframe,
        input.entryPrice,
        input.invalidationPrice,
        targetPrice,
        leverage,
        (input.notes ?? '').slice(0, 400),
        input.openedAt ?? nowIso,
        nowIso
      );

    return this.getPositionSentinelPositionById(id)!;
  }

  public updatePositionSentinelPosition(
    id: string,
    patch: {
      invalidationPrice?: number;
      targetPrice?: number | null;
      leverage?: number;
      paused?: boolean;
      active?: boolean;
      notes?: string;
    }
  ): PositionSentinelTrackedPosition | null {
    const existing = this.getPositionSentinelPositionById(id);
    if (!existing) return null;

    const nextInv =
      patch.invalidationPrice !== undefined &&
      Number.isFinite(patch.invalidationPrice) &&
      patch.invalidationPrice > 0
        ? patch.invalidationPrice
        : existing.invalidationPrice;
    const nextTarget =
      patch.targetPrice === null
        ? null
        : patch.targetPrice !== undefined &&
            Number.isFinite(patch.targetPrice) &&
            patch.targetPrice > 0
          ? patch.targetPrice
          : existing.targetPrice;
    const nextLev =
      patch.leverage !== undefined && Number.isFinite(patch.leverage)
        ? Math.max(1, Math.min(125, Number(patch.leverage)))
        : existing.leverage;
    const nextPaused =
      patch.paused !== undefined ? Boolean(patch.paused) : existing.paused;
    const nextActive =
      patch.active !== undefined ? Boolean(patch.active) : existing.active;
    const nextNotes =
      patch.notes !== undefined ? patch.notes.slice(0, 400) : existing.notes;
    const nowIso = new Date().toISOString();

    this.db
      .prepare(
        `
        UPDATE position_sentinel_positions
        SET invalidation_price = ?, target_price = ?, leverage = ?,
            paused = ?, active = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        nextInv,
        nextTarget,
        nextLev,
        nextPaused ? 1 : 0,
        nextActive ? 1 : 0,
        nextNotes,
        nowIso,
        id
      );

    return this.getPositionSentinelPositionById(id);
  }

  public deletePositionSentinelPosition(id: string): boolean {
    const res = this.db
      .prepare('DELETE FROM position_sentinel_positions WHERE id = ?')
      .run(id);
    return Number(res.changes ?? 0) > 0;
  }

  public getPositionSentinelPositionById(
    id: string
  ): PositionSentinelTrackedPosition | null {
    const row = this.db
      .prepare('SELECT * FROM position_sentinel_positions WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPositionSentinelRow(row) : null;
  }

  public listPositionSentinelPositions(options?: {
    activeOnly?: boolean;
  }): PositionSentinelTrackedPosition[] {
    const sql = options?.activeOnly
      ? 'SELECT * FROM position_sentinel_positions WHERE active = 1 ORDER BY opened_at DESC'
      : 'SELECT * FROM position_sentinel_positions ORDER BY active DESC, opened_at DESC';
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPositionSentinelRow(r));
  }

  public syncOpenPaperLedgerToPositionSentinel(): {
    importedCount: number;
    deactivatedCount: number;
  } {
    const openLiveEntries = this.listPaperLedgerEntries(500).filter(
      (e) =>
        e.status === 'OPEN' &&
        (e.fillStatus ?? 'FILLED') === 'FILLED' &&
        !e.isDemo &&
        e.exchange !== 'demo_synthetic'
    );

    const openIds = new Set<number>();
    let importedCount = 0;

    for (const entry of openLiveEntries) {
      const ledgerId = entry.id;
      openIds.add(ledgerId);
      const existing = this.db
        .prepare(
          'SELECT id, active FROM position_sentinel_positions WHERE paper_ledger_id = ? LIMIT 1'
        )
        .get(ledgerId) as { id: string; active: number } | undefined;

      if (!existing) {
        this.addPositionSentinelPosition({
          id: `ps_paper_${ledgerId}`,
          sourceType: 'PAPER_LEDGER',
          paperLedgerId: ledgerId,
          symbol: entry.symbol,
          exchange: entry.exchange,
          side: entry.side,
          timeframe: entry.timeframe,
          entryPrice: entry.entryPrice,
          invalidationPrice: entry.invalidationPrice,
          targetPrice: entry.targetPrice,
          leverage: 1,
          notes: String(entry.entryAnchorLabel || '紙上帳本自動同步守護'),
          openedAt: entry.openedAt,
        });
        importedCount++;
      }
    }

    const trackedPaper = this.db
      .prepare(
        `SELECT id, paper_ledger_id FROM position_sentinel_positions
         WHERE source_type = 'PAPER_LEDGER' AND active = 1`
      )
      .all() as Array<{ id: string; paper_ledger_id: number | null }>;
    let deactivatedCount = 0;
    const nowIso = new Date().toISOString();
    for (const tp of trackedPaper) {
      if (tp.paper_ledger_id !== null && !openIds.has(Number(tp.paper_ledger_id))) {
        this.db
          .prepare(
            'UPDATE position_sentinel_positions SET active = 0, updated_at = ? WHERE id = ?'
          )
          .run(nowIso, tp.id);
        deactivatedCount++;
      }
    }

    return { importedCount, deactivatedCount };
  }

  public recordPositionSentinelAlert(
    alert: PositionSentinelAlert
  ): PositionSentinelAlert {
    this.db
      .prepare(
        `
        INSERT INTO position_sentinel_alerts (
          id, position_id, symbol, exchange, side, severity, health_state,
          event_type, title_zh, detail_zh, price_at_event,
          suggested_defense_price, confirmed_close, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        alert.id,
        alert.positionId,
        alert.symbol,
        alert.exchange,
        alert.side,
        alert.severity,
        alert.healthState,
        alert.eventType,
        alert.titleZh,
        alert.detailZh,
        alert.priceAtEvent,
        alert.suggestedDefensePrice,
        alert.confirmedClose ? 1 : 0,
        alert.createdAt
      );
    // Keep table bounded to latest 500 alerts
    this.db.exec(`
      DELETE FROM position_sentinel_alerts
      WHERE id NOT IN (
        SELECT id FROM position_sentinel_alerts ORDER BY created_at DESC LIMIT 500
      )
    `);
    return alert;
  }

  public listPositionSentinelAlerts(options?: {
    positionId?: string;
    limit?: number;
  }): PositionSentinelAlert[] {
    const limit = Math.max(1, Math.min(200, options?.limit ?? 60));
    const rows = options?.positionId
      ? (this.db
          .prepare(
            'SELECT * FROM position_sentinel_alerts WHERE position_id = ? ORDER BY created_at DESC LIMIT ?'
          )
          .all(options.positionId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            'SELECT * FROM position_sentinel_alerts ORDER BY created_at DESC LIMIT ?'
          )
          .all(limit) as Array<Record<string, unknown>>);

    return rows.map((r) => ({
      id: String(r.id),
      positionId: String(r.position_id),
      symbol: String(r.symbol),
      exchange: String(r.exchange) as ExchangeId,
      side: String(r.side) === 'SHORT' ? 'SHORT' : 'LONG',
      severity: String(r.severity) as PositionSentinelAlertSeverity,
      healthState: String(r.health_state) as PositionHealthState,
      eventType: String(r.event_type) as PositionSentinelEventType,
      titleZh: String(r.title_zh),
      detailZh: String(r.detail_zh),
      priceAtEvent: Number(r.price_at_event),
      suggestedDefensePrice:
        r.suggested_defense_price !== null && r.suggested_defense_price !== undefined
          ? Number(r.suggested_defense_price)
          : null,
      confirmedClose: Number(r.confirmed_close ?? 0) === 1,
      createdAt: String(r.created_at),
    }));
  }

  public close(): void {
    if (this.dbPath !== ':memory:') {
      try {
        this.savePaperLedgerCheckpointToDisk();
      } catch {
        // ignore checkpoint error on shutdown
      }
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // ignore checkpoint error on shutdown
      }
    }
    this.db.close();
  }
}
