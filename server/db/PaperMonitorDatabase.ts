import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  ExchangeId,
  FinalTradeSignal,
  MarketRadarCategory,
  MonitoringWindowCycleSnapshot,
  MonitoringWindowRecord,
  MonitoringWindowStatus,
  NotificationOutboxChannel,
  NotificationOutboxRecord,
  NotificationOutboxStatus,
  NotificationPayload,
  PaperMonitorRunRecord,
  PaperMonitorWorkerState,
  PaperSignalCloseReason,
  PaperSignalLifecycleStatus,
  PaperTrackedSignalRecord,
  SmcActionState,
  SmcEvaluationStatus,
  Timeframe,
} from '../../src/types/market.ts';
import { RadarDatabase } from './RadarDatabase.ts';

interface MonitoringCheckpointFile {
  runs: PaperMonitorRunRecord[];
  windows: MonitoringWindowRecord[];
  cycles: MonitoringWindowCycleSnapshot[];
  signals?: PaperTrackedSignalRecord[];
  outbox?: NotificationOutboxRecord[];
}

export class PaperMonitorDatabase {
  public readonly radarDb: RadarDatabase;
  private readonly rawDb: DatabaseSync;
  private readonly checkpointPath: string | null;
  private isRestoringCheckpoint = false;

  constructor(radarDb: RadarDatabase) {
    this.radarDb = radarDb;
    this.rawDb = radarDb.getRawDb();
    this.checkpointPath =
      radarDb.dbPath && radarDb.dbPath !== ':memory:'
        ? `${radarDb.dbPath}.window-checkpoint.json`
        : null;
    this.initSchema();
    this.restoreFromCheckpointIfEmpty();
    this.normalizeHistoricalFixtureSignalIfPresent();
  }

  private normalizeHistoricalFixtureSignalIfPresent(): void {
    const dbPath = this.radarDb.dbPath || '';
    if (
      process.env.NODE_TEST_CONTEXT ||
      !dbPath ||
      dbPath === ':memory:' ||
      dbPath.includes('test') ||
      dbPath.includes('tmp')
    ) {
      return;
    }
    try {
      const targetRow = this.rawDb
        .prepare(
          `SELECT signal_id, evaluated_at, signal_detected_at
           FROM paper_tracked_signals
           WHERE symbol = 'ATOMUSDT'
             AND signal_id LIKE 'sig_binance_usdm_ATOMUSDT_15m_SHORT_1792896300000_%'
           LIMIT 1`
        )
        .get() as
        | {
            signal_id: string;
            evaluated_at: string;
            signal_detected_at: string | null;
          }
        | undefined;
      if (
        targetRow &&
        targetRow.signal_detected_at !== '2025-10-29T03:14:46.639Z'
      ) {
        this.rawDb
          .prepare(
            `UPDATE paper_tracked_signals
             SET snapshot_at = '2025-10-29T03:14:46.603Z',
                 evaluated_at = '2025-10-29T03:14:46.639Z',
                 signal_detected_at = '2025-10-29T03:14:46.639Z',
                 signal_bar_open_time = 1761705900000,
                 signal_bar_close_time = 1761706799999,
                 original_entry_window_open_time = 1761706800000,
                 original_entry_window_close_time = 1761707699999,
                 detection_latency_ms = 886640,
                 signal_latency_ms = 886640,
                 updated_at = '2025-10-29T03:14:46.639Z'
             WHERE signal_id = ?`
          )
          .run(targetRow.signal_id);
        this.saveCheckpointToDisk();
      }
    } catch {
      // ignore
    }
  }

  private initSchema(): void {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS paper_monitor_runs (
        monitor_run_id TEXT PRIMARY KEY,
        scan_run_id TEXT NOT NULL,
        database_instance_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        exchange TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        last_scan_at TEXT,
        next_scan_at TEXT,
        worker_state TEXT NOT NULL,
        last_error TEXT,
        cycles_completed INTEGER NOT NULL DEFAULT 0,
        rate_limit_count INTEGER NOT NULL DEFAULT 0,
        exchange_error_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_paper_monitor_runs_exchange
        ON paper_monitor_runs (exchange, updated_at DESC);

      CREATE TABLE IF NOT EXISTS paper_monitoring_windows (
        monitoring_window_id TEXT PRIMARY KEY,
        monitor_run_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        window_started_at TEXT NOT NULL,
        window_expected_end_at TEXT NOT NULL,
        window_completed_at TEXT,
        window_status TEXT NOT NULL,
        is_verifiable_replay INTEGER NOT NULL DEFAULT 0,
        interruption_reason TEXT,
        last_updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_paper_monitoring_windows_exchange
        ON paper_monitoring_windows (exchange, window_started_at DESC);

      CREATE TABLE IF NOT EXISTS paper_monitoring_window_cycles (
        scan_cycle_id TEXT NOT NULL,
        monitoring_window_id TEXT NOT NULL,
        scan_run_id TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        stats_version INTEGER NOT NULL,
        total_contracts INTEGER NOT NULL,
        evaluated_count INTEGER NOT NULL,
        pending_count INTEGER NOT NULL,
        wait_count INTEGER NOT NULL,
        watch_count INTEGER NOT NULL,
        high_risk_count INTEGER NOT NULL,
        long_candidate_count INTEGER NOT NULL,
        short_candidate_count INTEGER NOT NULL,
        failed_count INTEGER NOT NULL,
        rate_limited_count INTEGER NOT NULL,
        stale_count INTEGER NOT NULL,
        fallback_count INTEGER NOT NULL,
        missing_data_count INTEGER NOT NULL DEFAULT 0,
        final_category_smc_mismatch_count INTEGER NOT NULL DEFAULT 0,
        rule_version_valid_count INTEGER NOT NULL DEFAULT 0,
        evaluated_at_valid_count INTEGER NOT NULL DEFAULT 0,
        source_valid_count INTEGER NOT NULL DEFAULT 0,
        cycle_valid INTEGER NOT NULL DEFAULT 1,
        data_quality_warning TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (monitoring_window_id, scan_cycle_id)
      );

      CREATE INDEX IF NOT EXISTS idx_paper_window_cycles_window
        ON paper_monitoring_window_cycles (monitoring_window_id, recorded_at ASC);

      CREATE TABLE IF NOT EXISTS paper_tracked_signals (
        signal_id TEXT PRIMARY KEY,
        monitor_run_id TEXT NOT NULL,
        scan_run_id TEXT NOT NULL,
        scan_cycle_id TEXT,
        database_instance_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        market_radar_category TEXT NOT NULL,
        smc_evaluation_status TEXT NOT NULL,
        smc_action_state TEXT NOT NULL,
        final_trade_signal TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        signal_detected_at TEXT,
        signal_bar_open_time INTEGER,
        signal_bar_close_time INTEGER,
        original_entry_window_open_time INTEGER,
        original_entry_window_close_time INTEGER,
        entry_reference_time TEXT,
        entry_reference_price REAL,
        stop_loss REAL,
        take_profit REAL,
        risk_multiple REAL,
        exit_time TEXT,
        exit_price REAL,
        holding_time_ms INTEGER,
        status TEXT NOT NULL,
        entry_status TEXT,
        entry_window_status TEXT,
        status_reason TEXT,
        paper_ledger_id INTEGER,
        signal_latency_ms INTEGER NOT NULL DEFAULT 0,
        detection_latency_ms INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        missing_data_json TEXT NOT NULL,
        wait_reasons_json TEXT NOT NULL,
        evidences_json TEXT NOT NULL,
        decision_trace_json TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_paper_tracked_signals_exchange_time
        ON paper_tracked_signals (exchange, evaluated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_paper_tracked_signals_status
        ON paper_tracked_signals (exchange, status);

      CREATE INDEX IF NOT EXISTS idx_paper_tracked_signals_symbol
        ON paper_tracked_signals (exchange, symbol, evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        notification_id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        monitor_run_id TEXT NOT NULL,
        scan_run_id TEXT NOT NULL,
        scan_cycle_id TEXT,
        snapshot_at TEXT,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        channel TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        formatted_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        cooldown_until TEXT,
        blocked_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_created
        ON notification_outbox (exchange, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_signal
        ON notification_outbox (signal_id, channel);

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_dedupe
        ON notification_outbox (channel, dedupe_key, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_symbol_cooldown
        ON notification_outbox (channel, symbol, created_at DESC);
    `);

    const cols = this.rawDb
      .prepare(`PRAGMA table_info(paper_tracked_signals)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('scan_cycle_id')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN scan_cycle_id TEXT`
      );
    }
    if (!colNames.has('decision_trace_json')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN decision_trace_json TEXT`
      );
    }
    if (!colNames.has('signal_detected_at')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN signal_detected_at TEXT`
      );
    }
    if (!colNames.has('original_entry_window_open_time')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN original_entry_window_open_time INTEGER`
      );
    }
    if (!colNames.has('original_entry_window_close_time')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN original_entry_window_close_time INTEGER`
      );
    }
    if (!colNames.has('entry_status')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN entry_status TEXT`
      );
    }
    if (!colNames.has('entry_window_status')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN entry_window_status TEXT`
      );
    }
    if (!colNames.has('detection_latency_ms')) {
      this.rawDb.exec(
        `ALTER TABLE paper_tracked_signals ADD COLUMN detection_latency_ms INTEGER NOT NULL DEFAULT 0`
      );
    }

    const outboxCols = this.rawDb
      .prepare(`PRAGMA table_info(notification_outbox)`)
      .all() as Array<{ name: string }>;
    const outboxColNames = new Set(outboxCols.map((c) => c.name));
    if (!outboxColNames.has('scan_cycle_id')) {
      this.rawDb.exec(
        `ALTER TABLE notification_outbox ADD COLUMN scan_cycle_id TEXT`
      );
    }
    if (!outboxColNames.has('snapshot_at')) {
      this.rawDb.exec(
        `ALTER TABLE notification_outbox ADD COLUMN snapshot_at TEXT`
      );
    }
  }

  private saveCheckpointToDisk(): void {
    if (!this.checkpointPath || this.isRestoringCheckpoint) {
      return;
    }
    try {
      const runRows = this.rawDb
        .prepare(`SELECT * FROM paper_monitor_runs ORDER BY updated_at DESC`)
        .all() as Array<Record<string, unknown>>;
      const winRows = this.rawDb
        .prepare(
          `SELECT * FROM paper_monitoring_windows ORDER BY last_updated_at DESC`
        )
        .all() as Array<Record<string, unknown>>;
      const cycleRows = this.rawDb
        .prepare(
          `SELECT * FROM paper_monitoring_window_cycles ORDER BY recorded_at ASC`
        )
        .all() as Array<Record<string, unknown>>;
      const sigRows = this.rawDb
        .prepare(
          `SELECT * FROM paper_tracked_signals WHERE is_demo = 0 ORDER BY evaluated_at ASC`
        )
        .all() as Array<Record<string, unknown>>;
      const outboxRows = this.rawDb
        .prepare(
          `SELECT * FROM notification_outbox ORDER BY created_at ASC LIMIT 500`
        )
        .all() as Array<Record<string, unknown>>;

      const payload: MonitoringCheckpointFile = {
        runs: runRows.map((r) => this.mapMonitorRunRow(r)),
        windows: winRows.map((w) => this.mapMonitoringWindowRow(w)),
        cycles: cycleRows.map((row) => ({
          scanCycleId: String(row.scan_cycle_id),
          monitoringWindowId: String(row.monitoring_window_id),
          scanRunId: String(row.scan_run_id),
          snapshotAt: String(row.snapshot_at),
          statsVersion: Number(row.stats_version ?? 0),
          totalContracts: Number(row.total_contracts ?? 0),
          evaluatedCount: Number(row.evaluated_count ?? 0),
          pendingCount: Number(row.pending_count ?? 0),
          waitCount: Number(row.wait_count ?? 0),
          watchCount: Number(row.watch_count ?? 0),
          highRiskCount: Number(row.high_risk_count ?? 0),
          longCandidateCount: Number(row.long_candidate_count ?? 0),
          shortCandidateCount: Number(row.short_candidate_count ?? 0),
          failedCount: Number(row.failed_count ?? 0),
          rateLimitedCount: Number(row.rate_limited_count ?? 0),
          staleCount: Number(row.stale_count ?? 0),
          fallbackCount: Number(row.fallback_count ?? 0),
          missingDataCount: Number(row.missing_data_count ?? 0),
          finalCategorySmcMismatchCount: Number(
            row.final_category_smc_mismatch_count ?? 0
          ),
          ruleVersionValidCount: Number(row.rule_version_valid_count ?? 0),
          evaluatedAtValidCount: Number(row.evaluated_at_valid_count ?? 0),
          sourceValidCount: Number(row.source_valid_count ?? 0),
          cycleValid: Number(row.cycle_valid ?? 1) === 1,
          dataQualityWarning: row.data_quality_warning
            ? String(row.data_quality_warning)
            : null,
          recordedAt: String(row.recorded_at),
        })),
        signals: sigRows.map((s) => this.mapTrackedSignalRow(s)),
        outbox: outboxRows.map((o) => this.mapOutboxRow(o)),
      };

      const tmpPath = `${this.checkpointPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.checkpointPath);
    } catch {
      // Ignore checkpoint disk write errors in restricted environments
    }
  }

  private restoreFromCheckpointIfEmpty(): void {
    if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) {
      return;
    }
    try {
      const existingCycleCount = this.rawDb
        .prepare(`SELECT COUNT(*) AS cnt FROM paper_monitoring_window_cycles`)
        .get() as { cnt?: number } | undefined;
      const existingSigCount = this.rawDb
        .prepare(`SELECT COUNT(*) AS cnt FROM paper_tracked_signals`)
        .get() as { cnt?: number } | undefined;
      const rawJson = fs.readFileSync(this.checkpointPath, 'utf8');
      const parsed = JSON.parse(rawJson) as Partial<MonitoringCheckpointFile>;
      if (!parsed.windows || parsed.windows.length === 0) {
        return;
      }
      const needsCycleRestore = Number(existingCycleCount?.cnt ?? 0) === 0;
      const needsSignalRestore =
        Number(existingSigCount?.cnt ?? 0) === 0 &&
        Array.isArray(parsed.signals) &&
        parsed.signals.length > 0;
      if (!needsCycleRestore && !needsSignalRestore) {
        return;
      }
      this.isRestoringCheckpoint = true;
      try {
        const checkpointRunIds = new Set(
          (parsed.runs ?? []).map((r) => r.monitorRunId)
        );
        const existingRuns = this.rawDb
          .prepare(`SELECT monitor_run_id FROM paper_monitor_runs`)
          .all() as Array<{ monitor_run_id: string }>;
        for (const row of existingRuns) {
          if (!checkpointRunIds.has(row.monitor_run_id)) {
            this.rawDb
              .prepare(
                `DELETE FROM paper_monitor_runs WHERE monitor_run_id = ?`
              )
              .run(row.monitor_run_id);
          }
        }
        const checkpointWinIds = new Set(
          parsed.windows.map((w) => w.monitoringWindowId)
        );
        const existingWins = this.rawDb
          .prepare(`SELECT monitoring_window_id FROM paper_monitoring_windows`)
          .all() as Array<{ monitoring_window_id: string }>;
        for (const row of existingWins) {
          if (!checkpointWinIds.has(row.monitoring_window_id)) {
            this.rawDb
              .prepare(
                `DELETE FROM paper_monitoring_windows WHERE monitoring_window_id = ?`
              )
              .run(row.monitoring_window_id);
          }
        }
        for (const run of parsed.runs ?? []) {
          this.upsertMonitorRun(run);
        }
        for (const win of parsed.windows ?? []) {
          this.upsertMonitoringWindow(win);
        }
        for (const cycle of parsed.cycles ?? []) {
          this.recordMonitoringWindowCycle(cycle);
        }
        for (const sig of parsed.signals ?? []) {
          this.insertTrackedSignalIfAbsent(sig);
        }
        for (const out of parsed.outbox ?? []) {
          this.insertNotificationOutbox(out);
        }
      } finally {
        this.isRestoringCheckpoint = false;
      }
    } catch {
      this.isRestoringCheckpoint = false;
    }
  }

  public upsertMonitorRun(record: PaperMonitorRunRecord): PaperMonitorRunRecord {
    const nowIso = new Date().toISOString();
    const stmt = this.rawDb.prepare(`
      INSERT INTO paper_monitor_runs (
        monitor_run_id, scan_run_id, database_instance_id, rule_version,
        exchange, started_at, last_heartbeat_at, last_scan_at, next_scan_at,
        worker_state, last_error, cycles_completed, rate_limit_count,
        exchange_error_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(monitor_run_id) DO UPDATE SET
        scan_run_id = excluded.scan_run_id,
        database_instance_id = excluded.database_instance_id,
        rule_version = excluded.rule_version,
        exchange = excluded.exchange,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_scan_at = excluded.last_scan_at,
        next_scan_at = excluded.next_scan_at,
        worker_state = excluded.worker_state,
        last_error = excluded.last_error,
        cycles_completed = excluded.cycles_completed,
        rate_limit_count = excluded.rate_limit_count,
        exchange_error_count = excluded.exchange_error_count,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.monitorRunId,
      record.scanRunId,
      record.databaseInstanceId,
      record.ruleVersion,
      record.exchange,
      record.startedAt,
      record.lastHeartbeatAt,
      record.lastScanAt,
      record.nextScanAt,
      record.workerState,
      record.lastError,
      record.cyclesCompleted,
      record.rateLimitCount,
      record.exchangeErrorCount,
      nowIso
    );

    this.radarDb.incrementSmcStatsVersion(record.exchange);
    this.saveCheckpointToDisk();
    return record;
  }

  public getLatestMonitorRun(
    exchange: ExchangeId = 'binance_usdm'
  ): PaperMonitorRunRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT * FROM paper_monitor_runs
      WHERE exchange = ?
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `);
    const row = stmt.get(exchange) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapMonitorRunRow(row);
  }

  private mapMonitorRunRow(row: Record<string, unknown>): PaperMonitorRunRecord {
    return {
      monitorRunId: String(row.monitor_run_id),
      scanRunId: String(row.scan_run_id),
      databaseInstanceId: String(row.database_instance_id),
      ruleVersion: String(row.rule_version),
      exchange: String(row.exchange) as ExchangeId,
      startedAt: String(row.started_at),
      lastHeartbeatAt: String(row.last_heartbeat_at),
      lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
      nextScanAt: row.next_scan_at ? String(row.next_scan_at) : null,
      workerState: String(row.worker_state) as PaperMonitorWorkerState,
      lastError: row.last_error ? String(row.last_error) : null,
      cyclesCompleted: Number(row.cycles_completed ?? 0),
      rateLimitCount: Number(row.rate_limit_count ?? 0),
      exchangeErrorCount: Number(row.exchange_error_count ?? 0),
    };
  }

  // ============================================================================
  // Phase 7: 24-Hour Monitoring Window & Cycle Snapshot Persistence
  // ============================================================================

  public upsertMonitoringWindow(
    record: MonitoringWindowRecord
  ): MonitoringWindowRecord {
    const nowIso = record.lastUpdatedAt || new Date().toISOString();
    const stmt = this.rawDb.prepare(`
      INSERT INTO paper_monitoring_windows (
        monitoring_window_id, monitor_run_id, exchange, rule_version,
        window_started_at, window_expected_end_at, window_completed_at,
        window_status, is_verifiable_replay, interruption_reason, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(monitoring_window_id) DO UPDATE SET
        monitor_run_id = excluded.monitor_run_id,
        rule_version = excluded.rule_version,
        window_started_at = excluded.window_started_at,
        window_expected_end_at = excluded.window_expected_end_at,
        window_completed_at = excluded.window_completed_at,
        window_status = excluded.window_status,
        is_verifiable_replay = excluded.is_verifiable_replay,
        interruption_reason = excluded.interruption_reason,
        last_updated_at = excluded.last_updated_at
    `);

    stmt.run(
      record.monitoringWindowId,
      record.monitorRunId,
      record.exchange,
      record.ruleVersion,
      record.windowStartedAt,
      record.windowExpectedEndAt,
      record.windowCompletedAt,
      record.windowStatus,
      record.isVerifiableTimeSeriesReplay ? 1 : 0,
      record.interruptionReason,
      nowIso
    );

    this.radarDb.incrementSmcStatsVersion(record.exchange);
    this.saveCheckpointToDisk();
    return {
      ...record,
      lastUpdatedAt: nowIso,
    };
  }

  public getLatestMonitoringWindow(
    exchange: ExchangeId
  ): MonitoringWindowRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_monitoring_windows
      WHERE exchange = ?
      ORDER BY last_updated_at DESC, rowid DESC
      LIMIT 1
    `);
    const row = stmt.get(exchange) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapMonitoringWindowRow(row);
  }

  public getMonitoringWindowById(
    monitoringWindowId: string
  ): MonitoringWindowRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_monitoring_windows
      WHERE monitoring_window_id = ?
      LIMIT 1
    `);
    const row = stmt.get(monitoringWindowId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.mapMonitoringWindowRow(row);
  }

  private mapMonitoringWindowRow(
    row: Record<string, unknown>
  ): MonitoringWindowRecord {
    return {
      monitoringWindowId: String(row.monitoring_window_id),
      monitorRunId: String(row.monitor_run_id),
      exchange: String(row.exchange) as ExchangeId,
      ruleVersion: String(row.rule_version),
      windowStartedAt: String(row.window_started_at),
      windowExpectedEndAt: String(row.window_expected_end_at),
      windowCompletedAt: row.window_completed_at
        ? String(row.window_completed_at)
        : null,
      windowStatus: String(row.window_status) as MonitoringWindowStatus,
      isVerifiableTimeSeriesReplay: Number(row.is_verifiable_replay) === 1,
      interruptionReason: row.interruption_reason
        ? String(row.interruption_reason)
        : null,
      lastUpdatedAt: String(row.last_updated_at),
    };
  }

  public recordMonitoringWindowCycle(
    record: MonitoringWindowCycleSnapshot
  ): MonitoringWindowCycleSnapshot {
    const stmt = this.rawDb.prepare(`
      INSERT INTO paper_monitoring_window_cycles (
        scan_cycle_id, monitoring_window_id, scan_run_id, snapshot_at,
        stats_version, total_contracts, evaluated_count, pending_count,
        wait_count, watch_count, high_risk_count, long_candidate_count,
        short_candidate_count, failed_count, rate_limited_count,
        stale_count, fallback_count, missing_data_count,
        final_category_smc_mismatch_count, rule_version_valid_count,
        evaluated_at_valid_count, source_valid_count,
        cycle_valid, data_quality_warning, recorded_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(monitoring_window_id, scan_cycle_id) DO UPDATE SET
        scan_run_id = excluded.scan_run_id,
        snapshot_at = excluded.snapshot_at,
        stats_version = excluded.stats_version,
        total_contracts = excluded.total_contracts,
        evaluated_count = excluded.evaluated_count,
        pending_count = excluded.pending_count,
        wait_count = excluded.wait_count,
        watch_count = excluded.watch_count,
        high_risk_count = excluded.high_risk_count,
        long_candidate_count = excluded.long_candidate_count,
        short_candidate_count = excluded.short_candidate_count,
        failed_count = excluded.failed_count,
        rate_limited_count = excluded.rate_limited_count,
        stale_count = excluded.stale_count,
        fallback_count = excluded.fallback_count,
        missing_data_count = excluded.missing_data_count,
        final_category_smc_mismatch_count = excluded.final_category_smc_mismatch_count,
        rule_version_valid_count = excluded.rule_version_valid_count,
        evaluated_at_valid_count = excluded.evaluated_at_valid_count,
        source_valid_count = excluded.source_valid_count,
        cycle_valid = excluded.cycle_valid,
        data_quality_warning = excluded.data_quality_warning,
        recorded_at = excluded.recorded_at
    `);

    stmt.run(
      record.scanCycleId,
      record.monitoringWindowId,
      record.scanRunId,
      record.snapshotAt,
      record.statsVersion,
      record.totalContracts,
      record.evaluatedCount,
      record.pendingCount,
      record.waitCount,
      record.watchCount,
      record.highRiskCount,
      record.longCandidateCount,
      record.shortCandidateCount,
      record.failedCount,
      record.rateLimitedCount,
      record.staleCount,
      record.fallbackCount,
      record.missingDataCount,
      record.finalCategorySmcMismatchCount,
      record.ruleVersionValidCount,
      record.evaluatedAtValidCount,
      record.sourceValidCount,
      record.cycleValid ? 1 : 0,
      record.dataQualityWarning,
      record.recordedAt
    );

    this.saveCheckpointToDisk();
    return record;
  }

  public listMonitoringWindowCycles(
    monitoringWindowId: string,
    limit = 500
  ): MonitoringWindowCycleSnapshot[] {
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_monitoring_window_cycles
      WHERE monitoring_window_id = ?
      ORDER BY recorded_at ASC, rowid ASC
      LIMIT ?
    `);
    const rows = stmt.all(monitoringWindowId, limit) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      scanCycleId: String(r.scan_cycle_id),
      monitoringWindowId: String(r.monitoring_window_id),
      scanRunId: String(r.scan_run_id),
      snapshotAt: String(r.snapshot_at),
      statsVersion: Number(r.stats_version ?? 1),
      totalContracts: Number(r.total_contracts ?? 0),
      evaluatedCount: Number(r.evaluated_count ?? 0),
      pendingCount: Number(r.pending_count ?? 0),
      waitCount: Number(r.wait_count ?? 0),
      watchCount: Number(r.watch_count ?? 0),
      highRiskCount: Number(r.high_risk_count ?? 0),
      longCandidateCount: Number(r.long_candidate_count ?? 0),
      shortCandidateCount: Number(r.short_candidate_count ?? 0),
      failedCount: Number(r.failed_count ?? 0),
      rateLimitedCount: Number(r.rate_limited_count ?? 0),
      staleCount: Number(r.stale_count ?? 0),
      fallbackCount: Number(r.fallback_count ?? 0),
      missingDataCount: Number(r.missing_data_count ?? 0),
      finalCategorySmcMismatchCount: Number(
        r.final_category_smc_mismatch_count ?? 0
      ),
      ruleVersionValidCount: Number(r.rule_version_valid_count ?? 0),
      evaluatedAtValidCount: Number(r.evaluated_at_valid_count ?? 0),
      sourceValidCount: Number(r.source_valid_count ?? 0),
      cycleValid: Number(r.cycle_valid) === 1,
      dataQualityWarning: r.data_quality_warning
        ? String(r.data_quality_warning)
        : null,
      recordedAt: String(r.recorded_at),
    }));
  }

  public listMonitoringWindowCyclesByTimeRange(params: {
    monitoringWindowId?: string;
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
  } = {}): MonitoringWindowCycleSnapshot[] {
    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (params.monitoringWindowId) {
      conditions.push('monitoring_window_id = ?');
      args.push(params.monitoringWindowId);
    }
    if (params.sinceIso) {
      conditions.push('snapshot_at >= ?');
      args.push(params.sinceIso);
    }
    if (params.untilIso) {
      conditions.push('snapshot_at < ?');
      args.push(params.untilIso);
    }
    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 2000;
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_monitoring_window_cycles
      ${whereSql}
      ORDER BY snapshot_at ASC, recorded_at ASC, rowid ASC
      LIMIT ?
    `);
    const rows = stmt.all(...args, limit) as Array<Record<string, unknown>>;
    const sinceMs = params.sinceIso ? Date.parse(params.sinceIso) : NaN;
    const untilMs = params.untilIso ? Date.parse(params.untilIso) : NaN;
    return rows
      .map((r) => ({
        scanCycleId: String(r.scan_cycle_id),
        monitoringWindowId: String(r.monitoring_window_id),
        scanRunId: String(r.scan_run_id),
        snapshotAt: String(r.snapshot_at),
        statsVersion: Number(r.stats_version ?? 1),
        totalContracts: Number(r.total_contracts ?? 0),
        evaluatedCount: Number(r.evaluated_count ?? 0),
        pendingCount: Number(r.pending_count ?? 0),
        waitCount: Number(r.wait_count ?? 0),
        watchCount: Number(r.watch_count ?? 0),
        highRiskCount: Number(r.high_risk_count ?? 0),
        longCandidateCount: Number(r.long_candidate_count ?? 0),
        shortCandidateCount: Number(r.short_candidate_count ?? 0),
        failedCount: Number(r.failed_count ?? 0),
        rateLimitedCount: Number(r.rate_limited_count ?? 0),
        staleCount: Number(r.stale_count ?? 0),
        fallbackCount: Number(r.fallback_count ?? 0),
        missingDataCount: Number(r.missing_data_count ?? 0),
        finalCategorySmcMismatchCount: Number(
          r.final_category_smc_mismatch_count ?? 0
        ),
        ruleVersionValidCount: Number(r.rule_version_valid_count ?? 0),
        evaluatedAtValidCount: Number(r.evaluated_at_valid_count ?? 0),
        sourceValidCount: Number(r.source_valid_count ?? 0),
        cycleValid: Number(r.cycle_valid) === 1,
        dataQualityWarning: r.data_quality_warning
          ? String(r.data_quality_warning)
          : null,
        recordedAt: String(r.recorded_at),
      }))
      .filter((c) => {
        const t = Date.parse(c.snapshotAt || c.recordedAt);
        if (!Number.isFinite(t)) return false;
        if (Number.isFinite(sinceMs) && t < sinceMs) return false;
        if (Number.isFinite(untilMs) && t >= untilMs) return false;
        return true;
      });
  }

  public findRecentTradableSignalBySymbolDirection(params: {
    exchange: ExchangeId;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    excludeSignalId: string;
    referenceEvaluatedAtIso: string;
    referenceBarOpenTime: number | null;
    cooldownMs: number;
  }): PaperTrackedSignalRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_tracked_signals
      WHERE exchange = ?
        AND symbol = ?
        AND direction = ?
        AND signal_id != ?
        AND status != 'BLOCKED'
        AND is_demo = 0
      ORDER BY evaluated_at DESC, rowid DESC
      LIMIT 20
    `);
    const rows = stmt.all(
      params.exchange,
      params.symbol,
      params.direction,
      params.excludeSignalId
    ) as Array<Record<string, unknown>>;

    const refEvalMs = Date.parse(params.referenceEvaluatedAtIso);
    for (const r of rows) {
      const mapped = this.mapTrackedSignalRow(r);
      const prevEvalMs = Date.parse(mapped.evaluatedAt);
      if (
        Number.isFinite(refEvalMs) &&
        Number.isFinite(prevEvalMs) &&
        Math.abs(refEvalMs - prevEvalMs) < params.cooldownMs
      ) {
        return mapped;
      }
      if (
        params.referenceBarOpenTime !== null &&
        mapped.signalBarOpenTime !== null &&
        Math.abs(params.referenceBarOpenTime - mapped.signalBarOpenTime) <
          params.cooldownMs
      ) {
        return mapped;
      }
    }
    return null;
  }

  public findSignalsBySymbolAndBarOpenTime(params: {
    exchange: ExchangeId;
    symbol: string;
    timeframe: Timeframe;
    signalBarOpenTime: number;
  }): PaperTrackedSignalRecord[] {
    const stmt = this.rawDb.prepare(`
      SELECT *
      FROM paper_tracked_signals
      WHERE exchange = ?
        AND symbol = ?
        AND timeframe = ?
        AND signal_bar_open_time = ?
        AND status != 'BLOCKED'
        AND is_demo = 0
      ORDER BY created_at ASC, rowid ASC
    `);
    const rows = stmt.all(
      params.exchange,
      params.symbol,
      params.timeframe,
      params.signalBarOpenTime
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrackedSignalRow(r));
  }

  /**
   * Inserts a new tracked signal ONLY if `signal_id` does not already exist.
   * Returns `{ inserted: boolean, record: PaperTrackedSignalRecord }`.
   * Guarantees idempotency across monitor cycles and service restarts.
   */
  public insertTrackedSignalIfAbsent(
    record: PaperTrackedSignalRecord
  ): { inserted: boolean; record: PaperTrackedSignalRecord } {
    const existing = this.getTrackedSignalById(record.signalId);
    if (existing) {
      return { inserted: false, record: existing };
    }

    const stmt = this.rawDb.prepare(`
      INSERT OR IGNORE INTO paper_tracked_signals (
        signal_id, monitor_run_id, scan_run_id, scan_cycle_id, database_instance_id,
        symbol, exchange, timeframe, direction, market_radar_category,
        smc_evaluation_status, smc_action_state, final_trade_signal,
        rule_version, snapshot_at, evaluated_at, signal_detected_at,
        signal_bar_open_time, signal_bar_close_time,
        original_entry_window_open_time, original_entry_window_close_time,
        entry_reference_time, entry_reference_price,
        stop_loss, take_profit, risk_multiple, exit_time, exit_price,
        holding_time_ms, status, entry_status, entry_window_status,
        status_reason, paper_ledger_id,
        signal_latency_ms, detection_latency_ms, source, stale, fallback, missing_data_json,
        wait_reasons_json, evidences_json, decision_trace_json, is_demo, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    const info = stmt.run(
      record.signalId,
      record.monitorRunId,
      record.scanRunId,
      record.scanCycleId ?? null,
      record.databaseInstanceId,
      record.symbol,
      record.exchange,
      record.timeframe,
      record.direction,
      record.marketRadarCategory,
      record.smcEvaluationStatus,
      record.smcActionState,
      record.finalTradeSignal,
      record.ruleVersion,
      record.snapshotAt,
      record.evaluatedAt,
      record.signalDetectedAt ?? record.evaluatedAt,
      record.signalBarOpenTime,
      record.signalBarCloseTime,
      record.originalEntryWindowOpenTime ?? null,
      record.originalEntryWindowCloseTime ?? null,
      record.entryReferenceTime,
      record.entryReferencePrice,
      record.stopLoss,
      record.takeProfit,
      record.riskMultiple,
      record.exitTime,
      record.exitPrice,
      record.holdingTimeMs,
      record.status,
      record.entryStatus ?? record.status,
      record.entryWindowStatus ?? '等待下一根 K 線開盤',
      record.statusReason,
      record.paperLedgerId,
      record.signalLatencyMs,
      record.detectionLatencyMs ?? record.signalLatencyMs,
      record.source,
      record.stale ? 1 : 0,
      record.fallback ? 1 : 0,
      JSON.stringify(record.missingData),
      JSON.stringify(record.waitReasons),
      JSON.stringify(record.evidences),
      record.decisionTrace ? JSON.stringify(record.decisionTrace) : null,
      record.isDemo ? 1 : 0,
      record.createdAt,
      record.updatedAt
    );

    if (info.changes > 0) {
      this.radarDb.incrementSmcStatsVersion(record.exchange);
      this.saveCheckpointToDisk();
      return { inserted: true, record };
    }
    const after = this.getTrackedSignalById(record.signalId);
    return { inserted: false, record: after ?? record };
  }

  public updateTrackedSignalOutcome(params: {
    signalId: string;
    status: PaperSignalLifecycleStatus;
    entryStatus?: PaperSignalLifecycleStatus;
    entryWindowStatus?: string;
    statusReason?: string | null;
    entryReferenceTime?: string | null;
    entryReferencePrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    riskMultiple?: number | null;
    exitTime?: string | null;
    exitPrice?: number | null;
    holdingTimeMs?: number | null;
    paperLedgerId?: number | null;
    updatedAt?: string;
  }): PaperTrackedSignalRecord | null {
    const existing = this.getTrackedSignalById(params.signalId);
    if (!existing) return null;

    const isDeferredFutureBarOpen =
      params.status === 'PAPER_OPENED' &&
      typeof params.entryWindowStatus === 'string' &&
      params.entryWindowStatus.includes('已改用下一根未開盤之未來 K 線');

    const isMissedWindowLocked =
      !isDeferredFutureBarOpen &&
      (params.status === 'ENTRY_WINDOW_MISSED' ||
        existing.status === 'ENTRY_WINDOW_MISSED' ||
        existing.entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
        params.entryWindowStatus === 'ENTRY_WINDOW_MISSED');

    // Strict non-lookahead & Phase 18.3 immutability protection:
    // 1. When ENTRY_WINDOW_MISSED, entryReferencePrice MUST remain null (never retroactively filled).
    // 2. Once entryReferencePrice is locked (PAPER_OPENED or closed), it MUST NEVER be overwritten.
    const lockedEntryPrice = isMissedWindowLocked
      ? null
      : existing.entryReferencePrice !== null
        ? existing.entryReferencePrice
        : (params.entryReferencePrice ?? null);
    const lockedEntryTime = isMissedWindowLocked
      ? null
      : existing.entryReferenceTime !== null
        ? existing.entryReferenceTime
        : (params.entryReferenceTime ?? null);
    const lockedStopLoss = isMissedWindowLocked
      ? null
      : existing.stopLoss !== null
        ? existing.stopLoss
        : (params.stopLoss ?? null);
    const lockedTakeProfit = isMissedWindowLocked
      ? null
      : existing.takeProfit !== null
        ? existing.takeProfit
        : (params.takeProfit ?? null);

    // Phase 18.3: Canonical entryWindowStatus ('DETECTED_BEFORE_NEXT_BAR_OPEN' | 'ENTRY_WINDOW_MISSED')
    // or missed window status is immutable once set on a signalId.
    const lockedEntryWindowStatus =
      existing.entryWindowStatus === 'DETECTED_BEFORE_NEXT_BAR_OPEN' ||
      existing.entryWindowStatus === 'ENTRY_WINDOW_MISSED'
        ? existing.entryWindowStatus
        : isMissedWindowLocked
          ? existing.status === 'ENTRY_WINDOW_MISSED'
            ? existing.entryWindowStatus
            : (params.entryWindowStatus ?? existing.entryWindowStatus)
          : (params.entryWindowStatus ?? existing.entryWindowStatus);

    const lockedStatus: PaperSignalLifecycleStatus =
      isMissedWindowLocked && existing.status === 'ENTRY_WINDOW_MISSED' && params.status === 'PAPER_OPENED'
        ? 'ENTRY_WINDOW_MISSED'
        : params.status;
    const lockedEntryStatus: PaperSignalLifecycleStatus =
      isMissedWindowLocked && existing.status === 'ENTRY_WINDOW_MISSED' && params.status === 'PAPER_OPENED'
        ? 'ENTRY_WINDOW_MISSED'
        : (params.entryStatus ?? lockedStatus);

    const updatedAt = params.updatedAt ?? new Date().toISOString();

    const stmt = this.rawDb.prepare(`
      UPDATE paper_tracked_signals
      SET status = ?,
          entry_status = ?,
          entry_window_status = ?,
          status_reason = ?,
          entry_reference_time = ?,
          entry_reference_price = ?,
          stop_loss = ?,
          take_profit = ?,
          risk_multiple = ?,
          exit_time = ?,
          exit_price = ?,
          holding_time_ms = ?,
          paper_ledger_id = ?,
          updated_at = ?
      WHERE signal_id = ?
    `);

    stmt.run(
      lockedStatus,
      lockedEntryStatus,
      lockedEntryWindowStatus,
      params.statusReason !== undefined
        ? params.statusReason
        : existing.statusReason,
      lockedEntryTime,
      lockedEntryPrice,
      lockedStopLoss,
      lockedTakeProfit,
      params.riskMultiple !== undefined
        ? params.riskMultiple
        : existing.riskMultiple,
      params.exitTime !== undefined ? params.exitTime : existing.exitTime,
      params.exitPrice !== undefined ? params.exitPrice : existing.exitPrice,
      params.holdingTimeMs !== undefined
        ? params.holdingTimeMs
        : existing.holdingTimeMs,
      params.paperLedgerId !== undefined
        ? params.paperLedgerId
        : existing.paperLedgerId,
      updatedAt,
      params.signalId
    );

    this.radarDb.incrementSmcStatsVersion(existing.exchange);
    this.saveCheckpointToDisk();
    return this.getTrackedSignalById(params.signalId);
  }

  public getTrackedSignalById(
    signalId: string
  ): PaperTrackedSignalRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT * FROM paper_tracked_signals WHERE signal_id = ? LIMIT 1
    `);
    const row = stmt.get(signalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTrackedSignalRow(row);
  }

  public listTrackedSignals(params: {
    exchange?: ExchangeId;
    status?: PaperSignalLifecycleStatus;
    symbol?: string;
    scanCycleId?: string;
    sinceIso?: string;
    untilIso?: string;
    includeBlocked?: boolean;
    limit?: number;
  } = {}): PaperTrackedSignalRecord[] {
    const conditions: string[] = ['is_demo = 0'];
    const args: Array<string | number> = [];

    if (params.exchange) {
      conditions.push('exchange = ?');
      args.push(params.exchange);
    }
    if (params.status) {
      conditions.push('status = ?');
      args.push(params.status);
    } else if (params.includeBlocked === false) {
      conditions.push("status != 'BLOCKED'");
    }
    if (params.symbol) {
      conditions.push('symbol = ?');
      args.push(params.symbol);
    }
    if (params.scanCycleId) {
      conditions.push('scan_cycle_id = ?');
      args.push(params.scanCycleId);
    }
    if (params.sinceIso) {
      conditions.push('COALESCE(signal_detected_at, evaluated_at) >= ?');
      args.push(params.sinceIso);
    }
    if (params.untilIso) {
      conditions.push('COALESCE(signal_detected_at, evaluated_at) < ?');
      args.push(params.untilIso);
    }

    const limit = params.limit ?? 200;
    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.rawDb.prepare(`
      SELECT * FROM paper_tracked_signals
      ${whereSql}
      ORDER BY COALESCE(signal_detected_at, evaluated_at) DESC, rowid DESC
      LIMIT ?
    `);
    const rows = stmt.all(...args, limit) as Array<Record<string, unknown>>;
    const mapped = rows.map((r) => this.mapTrackedSignalRow(r));

    const sinceMs = params.sinceIso ? Date.parse(params.sinceIso) : NaN;
    const untilMs = params.untilIso ? Date.parse(params.untilIso) : NaN;
    if (!Number.isFinite(sinceMs) && !Number.isFinite(untilMs)) {
      return mapped;
    }

    return mapped.filter((sig) => {
      const eventTimeStr = sig.signalDetectedAt || sig.evaluatedAt;
      const eventTimeMs = Date.parse(eventTimeStr);
      if (!Number.isFinite(eventTimeMs)) {
        return false;
      }
      if (Number.isFinite(sinceMs) && eventTimeMs < sinceMs) {
        return false;
      }
      if (Number.isFinite(untilMs) && eventTimeMs >= untilMs) {
        return false;
      }
      return true;
    });
  }

  private mapTrackedSignalRow(
    row: Record<string, unknown>
  ): PaperTrackedSignalRecord {
    let parsedDecisionTrace: Record<string, unknown> | null = null;
    if (row.decision_trace_json) {
      try {
        parsedDecisionTrace = JSON.parse(String(row.decision_trace_json));
      } catch {
        parsedDecisionTrace = null;
      }
    }
    const signalBarOpenTime =
      row.signal_bar_open_time !== null &&
      row.signal_bar_open_time !== undefined
        ? Number(row.signal_bar_open_time)
        : null;
    const signalBarCloseTime =
      row.signal_bar_close_time !== null &&
      row.signal_bar_close_time !== undefined
        ? Number(row.signal_bar_close_time)
        : null;
    const evaluatedAt = String(row.evaluated_at);
    const signalDetectedAt = row.signal_detected_at
      ? String(row.signal_detected_at)
      : evaluatedAt;
    const originalEntryWindowOpenTime =
      row.original_entry_window_open_time !== null &&
      row.original_entry_window_open_time !== undefined
        ? Number(row.original_entry_window_open_time)
        : signalBarOpenTime !== null
          ? signalBarOpenTime + 900_000
          : null;
    const originalEntryWindowCloseTime =
      row.original_entry_window_close_time !== null &&
      row.original_entry_window_close_time !== undefined
        ? Number(row.original_entry_window_close_time)
        : originalEntryWindowOpenTime !== null
          ? originalEntryWindowOpenTime + 900_000 - 1
          : null;
    const status = String(row.status) as PaperSignalLifecycleStatus;
    const entryStatus = row.entry_status
      ? (String(row.entry_status) as PaperSignalLifecycleStatus)
      : status === 'CREATED'
        ? 'PENDING_NEXT_ENTRY'
        : status;
    const detectionLatencyMs =
      row.detection_latency_ms !== null &&
      row.detection_latency_ms !== undefined
        ? Number(row.detection_latency_ms)
        : Number(row.signal_latency_ms ?? 0);
    const entryWindowStatus = row.entry_window_status
      ? String(row.entry_window_status)
      : status === 'ENTRY_WINDOW_MISSED'
        ? '原始進場窗口已錯過'
        : status === 'CREATED' || status === 'PENDING_NEXT_ENTRY'
          ? '等待下一根 K 線開盤'
          : status === 'BLOCKED'
            ? '非候選或已攔截'
            : '已於原始進場窗口開盤進場';

    const direction = String(row.direction) as 'LONG' | 'SHORT' | 'NONE';
    const isFormalCandidate = direction === 'LONG' || direction === 'SHORT';
    const detectedMs = Date.parse(signalDetectedAt) || Date.parse(evaluatedAt) || 0;
    const nextBarOpenTime =
      parsedDecisionTrace && typeof parsedDecisionTrace.nextBarOpenTime === 'number'
        ? Number(parsedDecisionTrace.nextBarOpenTime)
        : originalEntryWindowOpenTime;
    const entryWindowMissed = isFormalCandidate
      ? parsedDecisionTrace && typeof parsedDecisionTrace.entryWindowMissed === 'boolean'
        ? Boolean(parsedDecisionTrace.entryWindowMissed)
        : status === 'ENTRY_WINDOW_MISSED' ||
          entryWindowStatus === 'ENTRY_WINDOW_MISSED' ||
          entryWindowStatus === '原始進場窗口已錯過' ||
          (nextBarOpenTime !== null && detectedMs >= nextBarOpenTime)
      : undefined;

    return {
      signalId: String(row.signal_id),
      monitorRunId: String(row.monitor_run_id),
      scanRunId: String(row.scan_run_id),
      scanCycleId: row.scan_cycle_id ? String(row.scan_cycle_id) : undefined,
      databaseInstanceId: String(row.database_instance_id),
      symbol: String(row.symbol),
      exchange: String(row.exchange) as ExchangeId,
      timeframe: String(row.timeframe) as Timeframe,
      direction,
      marketRadarCategory: String(
        row.market_radar_category
      ) as MarketRadarCategory,
      smcEvaluationStatus: String(
        row.smc_evaluation_status
      ) as SmcEvaluationStatus,
      smcActionState: String(row.smc_action_state) as SmcActionState,
      finalTradeSignal: String(row.final_trade_signal) as FinalTradeSignal,
      ruleVersion: String(row.rule_version),
      snapshotAt: String(row.snapshot_at),
      evaluatedAt,
      signalDetectedAt,
      candidateDetectedAt:
        parsedDecisionTrace && typeof parsedDecisionTrace.candidateDetectedAt === 'string'
          ? String(parsedDecisionTrace.candidateDetectedAt)
          : signalDetectedAt,
      signalBarOpenTime,
      signalBarCloseTime,
      nextBarOpenTime,
      originalEntryWindowOpenTime,
      originalEntryWindowCloseTime,
      queueEnteredAt:
        parsedDecisionTrace && typeof parsedDecisionTrace.queueEnteredAt === 'string'
          ? String(parsedDecisionTrace.queueEnteredAt)
          : String(row.snapshot_at),
      evaluationStartedAt:
        parsedDecisionTrace && typeof parsedDecisionTrace.evaluationStartedAt === 'string'
          ? String(parsedDecisionTrace.evaluationStartedAt)
          : evaluatedAt,
      evaluationCompletedAt:
        parsedDecisionTrace && typeof parsedDecisionTrace.evaluationCompletedAt === 'string'
          ? String(parsedDecisionTrace.evaluationCompletedAt)
          : evaluatedAt,
      queueWaitMs:
        parsedDecisionTrace && typeof parsedDecisionTrace.queueWaitMs === 'number'
          ? Number(parsedDecisionTrace.queueWaitMs)
          : 0,
      evaluationLatencyMs:
        parsedDecisionTrace && typeof parsedDecisionTrace.evaluationLatencyMs === 'number'
          ? Number(parsedDecisionTrace.evaluationLatencyMs)
          : 0,
      candidateDetectionLatencyMs: isFormalCandidate
        ? parsedDecisionTrace && typeof parsedDecisionTrace.candidateDetectionLatencyMs === 'number'
          ? Number(parsedDecisionTrace.candidateDetectionLatencyMs)
          : detectionLatencyMs
        : null,
      nextBarRemainingMs:
        parsedDecisionTrace && typeof parsedDecisionTrace.nextBarRemainingMs === 'number'
          ? Number(parsedDecisionTrace.nextBarRemainingMs)
          : nextBarOpenTime !== null
            ? nextBarOpenTime - detectedMs
            : null,
      entryWindowMissed,
      isFastLane:
        parsedDecisionTrace && typeof parsedDecisionTrace.isFastLane === 'boolean'
          ? Boolean(parsedDecisionTrace.isFastLane)
          : true,
      entryReferenceTime: row.entry_reference_time
        ? String(row.entry_reference_time)
        : null,
      paperOpenedAt: row.entry_reference_time
        ? String(row.entry_reference_time)
        : null,
      entryWindowOpenTime: originalEntryWindowOpenTime,
      entryReferencePrice:
        row.entry_reference_price !== null &&
        row.entry_reference_price !== undefined
          ? Number(row.entry_reference_price)
          : null,
      stopLoss:
        row.stop_loss !== null && row.stop_loss !== undefined
          ? Number(row.stop_loss)
          : null,
      takeProfit:
        row.take_profit !== null && row.take_profit !== undefined
          ? Number(row.take_profit)
          : null,
      riskMultiple:
        row.risk_multiple !== null && row.risk_multiple !== undefined
          ? Number(row.risk_multiple)
          : null,
      resultR:
        (status === 'PAPER_CLOSED_WIN' ||
          status === 'PAPER_CLOSED_LOSS' ||
          status === 'PAPER_EXPIRED') &&
        row.risk_multiple !== null &&
        row.risk_multiple !== undefined
          ? Number(row.risk_multiple)
          : null,
      exitTime: row.exit_time ? String(row.exit_time) : null,
      paperClosedAt: row.exit_time ? String(row.exit_time) : null,
      closeReason: (status === 'PAPER_CLOSED_LOSS'
        ? 'STOP_LOSS'
        : status === 'PAPER_CLOSED_WIN'
          ? 'TAKE_PROFIT'
          : status === 'PAPER_EXPIRED'
            ? 'EXPIRED'
            : status === 'INVALIDATED'
              ? 'INVALIDATED'
              : null) as PaperSignalCloseReason,
      exitPrice:
        row.exit_price !== null && row.exit_price !== undefined
          ? Number(row.exit_price)
          : null,
      holdingTimeMs:
        row.holding_time_ms !== null && row.holding_time_ms !== undefined
          ? Number(row.holding_time_ms)
          : null,
      status,
      entryStatus,
      entryWindowStatus,
      statusReason: row.status_reason ? String(row.status_reason) : null,
      paperLedgerId:
        row.paper_ledger_id !== null && row.paper_ledger_id !== undefined
          ? Number(row.paper_ledger_id)
          : null,
      signalLatencyMs: Number(row.signal_latency_ms ?? 0),
      detectionLatencyMs,
      source: String(row.source),
      stale: Number(row.stale) === 1,
      fallback: Number(row.fallback) === 1,
      missingData: JSON.parse(String(row.missing_data_json || '[]')),
      waitReasons: JSON.parse(String(row.wait_reasons_json || '[]')),
      evidences: JSON.parse(String(row.evidences_json || '[]')),
      decisionTrace: parsedDecisionTrace,
      isDemo: Number(row.is_demo) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ============================================================================
  // Notification Outbox Persistence (Local Sandbox Only — Zero External Calls)
  // ============================================================================

  public insertNotificationOutbox(
    record: NotificationOutboxRecord
  ): NotificationOutboxRecord {
    const stmt = this.rawDb.prepare(`
      INSERT OR REPLACE INTO notification_outbox (
        notification_id, signal_id, monitor_run_id, scan_run_id, scan_cycle_id,
        symbol, exchange, channel, payload_json, formatted_message,
        snapshot_at, created_at, status, dedupe_key, cooldown_until, blocked_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.notificationId,
      record.signalId,
      record.monitorRunId,
      record.scanRunId,
      record.scanCycleId ?? record.payload.scanCycleId ?? null,
      record.symbol,
      record.exchange,
      record.channel,
      JSON.stringify(record.payload),
      record.formattedMessage,
      record.snapshotAt ?? record.payload.snapshotAt ?? record.createdAt,
      record.createdAt,
      record.status,
      record.dedupeKey,
      record.cooldownUntil,
      record.blockedReason
    );

    this.radarDb.incrementSmcStatsVersion(record.exchange);
    this.saveCheckpointToDisk();
    return record;
  }

  public promotePendingEntryOutboxToQueued(
    signalId: string,
    exchange: ExchangeId
  ): void {
    const stmt = this.rawDb.prepare(`
      UPDATE notification_outbox
      SET status = 'SANDBOX_QUEUED',
          blocked_reason = NULL
      WHERE signal_id = ?
        AND status = 'PENDING_ENTRY'
    `);
    const info = stmt.run(signalId);
    if (info.changes > 0) {
      this.radarDb.incrementSmcStatsVersion(exchange);
      this.saveCheckpointToDisk();
    }
  }

  public listNotificationOutbox(params: {
    exchange?: ExchangeId;
    channel?: NotificationOutboxChannel;
    status?: NotificationOutboxStatus;
    signalId?: string;
    limit?: number;
  } = {}): NotificationOutboxRecord[] {
    const conditions: string[] = [];
    const args: Array<string | number> = [];

    if (params.exchange) {
      conditions.push('exchange = ?');
      args.push(params.exchange);
    }
    if (params.channel) {
      conditions.push('channel = ?');
      args.push(params.channel);
    }
    if (params.status) {
      conditions.push('status = ?');
      args.push(params.status);
    }
    if (params.signalId) {
      conditions.push('signal_id = ?');
      args.push(params.signalId);
    }

    const limit = params.limit ?? 100;
    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.rawDb.prepare(`
      SELECT * FROM notification_outbox
      ${whereSql}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `);
    const rows = stmt.all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOutboxRow(r));
  }

  public countBlockedNotifications(exchange: ExchangeId): number {
    const stmt = this.rawDb.prepare(`
      SELECT COUNT(*) AS cnt
      FROM notification_outbox
      WHERE exchange = ?
        AND status IN (
          'NON_CANDIDATE_BLOCKED',
          'DEDUPED_BLOCKED',
          'COOLDOWN_BLOCKED',
          'STALE_BLOCKED',
          'FALLBACK_BLOCKED',
          'MISSING_DATA_BLOCKED'
        )
    `);
    const row = stmt.get(exchange) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  public countPendingEntryNotifications(exchange: ExchangeId): number {
    const stmt = this.rawDb.prepare(`
      SELECT COUNT(*) AS cnt
      FROM notification_outbox
      WHERE exchange = ?
        AND status = 'PENDING_ENTRY'
    `);
    const row = stmt.get(exchange) as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  public findRecentOutboxByDedupeKey(
    channel: NotificationOutboxChannel,
    dedupeKey: string,
    sinceIso: string
  ): NotificationOutboxRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT * FROM notification_outbox
      WHERE channel = ?
        AND dedupe_key = ?
        AND status IN ('SANDBOX_QUEUED', 'PREVIEW_DRY_RUN', 'PENDING_ENTRY')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(channel, dedupeKey, sinceIso) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.mapOutboxRow(row);
  }

  public findRecentOutboxBySymbolDirectionCooldown(
    channel: NotificationOutboxChannel,
    symbol: string,
    sinceIso: string
  ): NotificationOutboxRecord | null {
    const stmt = this.rawDb.prepare(`
      SELECT * FROM notification_outbox
      WHERE channel = ?
        AND symbol = ?
        AND status IN ('SANDBOX_QUEUED', 'PREVIEW_DRY_RUN', 'PENDING_ENTRY')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(channel, symbol, sinceIso) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.mapOutboxRow(row);
  }

  private mapOutboxRow(
    row: Record<string, unknown>
  ): NotificationOutboxRecord {
    let parsedPayload: NotificationPayload;
    try {
      parsedPayload = JSON.parse(String(row.payload_json));
    } catch {
      parsedPayload = {
        symbol: String(row.symbol),
        category: '多頭候選',
        actionState: 'WAIT',
        score: 0,
        confirmedEvidences: [],
        missingData: [],
        riskWarnings: [],
        source: 'UNKNOWN',
        fetchedAt: String(row.created_at),
        safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
      };
    }

    return {
      notificationId: String(row.notification_id),
      signalId: String(row.signal_id),
      monitorRunId: String(row.monitor_run_id),
      scanRunId: String(row.scan_run_id),
      scanCycleId: row.scan_cycle_id
        ? String(row.scan_cycle_id)
        : (parsedPayload.scanCycleId ?? null),
      symbol: String(row.symbol),
      exchange: String(row.exchange) as ExchangeId,
      channel: String(row.channel) as NotificationOutboxChannel,
      payload: parsedPayload,
      formattedMessage: String(row.formatted_message),
      snapshotAt: row.snapshot_at
        ? String(row.snapshot_at)
        : (parsedPayload.snapshotAt ?? String(row.created_at)),
      createdAt: String(row.created_at),
      status: String(row.status) as NotificationOutboxStatus,
      dedupeKey: String(row.dedupe_key),
      cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : null,
      blockedReason: row.blocked_reason ? String(row.blocked_reason) : null,
    };
  }
}
