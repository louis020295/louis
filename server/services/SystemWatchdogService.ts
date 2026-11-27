import { DatabaseSync } from 'node:sqlite';
import {
  ExchangeId,
  SystemWatchdogStatusResponse,
  TRADING_SAFETY_FLAGS,
  WatchdogConfig,
  WatchdogEventRecord,
} from '../../src/types/market.ts';
import { RadarDatabase } from '../db/RadarDatabase.ts';
import { ExternalNotificationService } from './ExternalNotificationService.ts';
import { SmcBatchScanService } from './SmcBatchScanService.ts';

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  heartbeatIntervalMs: 3_600_000, // 1 hour
  autoBackupIntervalMs: 21_600_000, // 6 hours
  alertOnStall: true,
  alertOnDbRecovery: true,
  alertOnApiErrorSpike: true,
  apiErrorSpikeThreshold: 5,
  updatedAt: new Date(0).toISOString(),
};

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export class SystemWatchdogService {
  private readonly radarDb: RadarDatabase;
  private readonly smcScanner: SmcBatchScanService;
  private readonly externalNotifications: ExternalNotificationService;
  private readonly getActiveExchangeFn: () => ExchangeId;

  private timer: ReturnType<typeof setInterval> | null = null;
  private runningTick = false;
  private lastCheckAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastAutoBackupAt: string | null = null;
  private alertsDispatchedCount = 0;
  private autoBackupsCount = 0;

  private lastObservedDbRecoveryCount: number | null = null;
  private lastObservedApiErrorsTotal: number | null = null;
  private lastStallAlertMs = 0;

  private get rawDb(): DatabaseSync {
    return this.radarDb.getRawDb();
  }

  constructor(params: {
    radarDb: RadarDatabase;
    smcScanner: SmcBatchScanService;
    externalNotifications: ExternalNotificationService;
    getActiveExchangeFn?: () => ExchangeId;
  }) {
    this.radarDb = params.radarDb;
    this.smcScanner = params.smcScanner;
    this.externalNotifications = params.externalNotifications;
    this.getActiveExchangeFn =
      params.getActiveExchangeFn ??
      (() => this.smcScanner.getActiveForegroundExchange());

    this.initSchema();
    this.radarDb.registerSchemaInitHook(() => this.initSchema());
    this.hydrateCountersFromDb();
  }

  private initSchema(): void {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS system_watchdog_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        heartbeat_interval_ms INTEGER NOT NULL DEFAULT 3600000,
        auto_backup_interval_ms INTEGER NOT NULL DEFAULT 21600000,
        alert_on_stall INTEGER NOT NULL DEFAULT 1,
        alert_on_db_recovery INTEGER NOT NULL DEFAULT 1,
        alert_on_api_error_spike INTEGER NOT NULL DEFAULT 1,
        api_error_spike_threshold INTEGER NOT NULL DEFAULT 5,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_watchdog_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message_zh TEXT NOT NULL,
        notified_external INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_watchdog_events_created
        ON system_watchdog_events(created_at DESC);
    `);

    const row = this.rawDb
      .prepare(`SELECT id FROM system_watchdog_config WHERE id = 1`)
      .get();
    if (!row) {
      this.rawDb
        .prepare(
          `
          INSERT INTO system_watchdog_config (
            id, enabled, heartbeat_interval_ms, auto_backup_interval_ms,
            alert_on_stall, alert_on_db_recovery, alert_on_api_error_spike,
            api_error_spike_threshold, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          DEFAULT_WATCHDOG_CONFIG.enabled ? 1 : 0,
          DEFAULT_WATCHDOG_CONFIG.heartbeatIntervalMs,
          DEFAULT_WATCHDOG_CONFIG.autoBackupIntervalMs,
          DEFAULT_WATCHDOG_CONFIG.alertOnStall ? 1 : 0,
          DEFAULT_WATCHDOG_CONFIG.alertOnDbRecovery ? 1 : 0,
          DEFAULT_WATCHDOG_CONFIG.alertOnApiErrorSpike ? 1 : 0,
          DEFAULT_WATCHDOG_CONFIG.apiErrorSpikeThreshold,
          new Date().toISOString()
        );
    }
  }

  private hydrateCountersFromDb(): void {
    try {
      let hasMetaRows = false;
      try {
        const metaCountRow = this.rawDb
          .prepare(`SELECT COUNT(*) AS cnt FROM smc_scan_meta`)
          .get() as { cnt?: number } | undefined;
        hasMetaRows = Number(metaCountRow?.cnt ?? 0) > 0;
        const metaBackup = this.rawDb
          .prepare(
            `SELECT last_backup_at FROM smc_scan_meta WHERE last_backup_at IS NOT NULL ORDER BY last_backup_at DESC LIMIT 1`
          )
          .get() as { last_backup_at?: string | null } | undefined;
        if (metaBackup?.last_backup_at) {
          this.lastAutoBackupAt = String(metaBackup.last_backup_at);
        }
      } catch {
        // Ignore if smc_scan_meta not populated yet
      }
      if (!this.lastAutoBackupAt && !hasMetaRows) {
        const latestBackup = this.rawDb
          .prepare(
            `SELECT created_at FROM system_watchdog_events WHERE event_type = 'AUTO_BACKUP' ORDER BY created_at DESC LIMIT 1`
          )
          .get() as { created_at?: string } | undefined;
        if (latestBackup?.created_at) {
          this.lastAutoBackupAt = String(latestBackup.created_at);
        }
      }
      const latestHb = this.rawDb
        .prepare(
          `SELECT created_at FROM system_watchdog_events WHERE event_type = 'HEARTBEAT' ORDER BY created_at DESC LIMIT 1`
        )
        .get() as { created_at?: string } | undefined;
      if (latestHb?.created_at) {
        this.lastHeartbeatAt = String(latestHb.created_at);
      }
      const backupCountRow = this.rawDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM system_watchdog_events WHERE event_type = 'AUTO_BACKUP'`
        )
        .get() as { cnt?: number } | undefined;
      this.autoBackupsCount = Number(backupCountRow?.cnt ?? 0);

      const alertCountRow = this.rawDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM system_watchdog_events WHERE notified_external = 1`
        )
        .get() as { cnt?: number } | undefined;
      this.alertsDispatchedCount = Number(alertCountRow?.cnt ?? 0);
    } catch {
      // Ignore hydration errors on fresh DB
    }
  }

  public getConfig(): WatchdogConfig {
    const row = this.rawDb
      .prepare(`SELECT * FROM system_watchdog_config WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return { ...DEFAULT_WATCHDOG_CONFIG, updatedAt: new Date().toISOString() };
    }
    return {
      enabled: Number(row.enabled ?? 1) === 1,
      heartbeatIntervalMs: Number(
        row.heartbeat_interval_ms ?? DEFAULT_WATCHDOG_CONFIG.heartbeatIntervalMs
      ),
      autoBackupIntervalMs: Number(
        row.auto_backup_interval_ms ??
          DEFAULT_WATCHDOG_CONFIG.autoBackupIntervalMs
      ),
      alertOnStall: Number(row.alert_on_stall ?? 1) === 1,
      alertOnDbRecovery: Number(row.alert_on_db_recovery ?? 1) === 1,
      alertOnApiErrorSpike: Number(row.alert_on_api_error_spike ?? 1) === 1,
      apiErrorSpikeThreshold: Number(
        row.api_error_spike_threshold ??
          DEFAULT_WATCHDOG_CONFIG.apiErrorSpikeThreshold
      ),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    };
  }

  public updateConfig(
    patch: Partial<Omit<WatchdogConfig, 'updatedAt'>>
  ): SystemWatchdogStatusResponse {
    const cur = this.getConfig();
    const next: WatchdogConfig = {
      enabled:
        typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      heartbeatIntervalMs: clampInt(
        patch.heartbeatIntervalMs,
        cur.heartbeatIntervalMs,
        60_000,
        86_400_000
      ),
      autoBackupIntervalMs: clampInt(
        patch.autoBackupIntervalMs,
        cur.autoBackupIntervalMs,
        300_000,
        604_800_000
      ),
      alertOnStall:
        typeof patch.alertOnStall === 'boolean'
          ? patch.alertOnStall
          : cur.alertOnStall,
      alertOnDbRecovery:
        typeof patch.alertOnDbRecovery === 'boolean'
          ? patch.alertOnDbRecovery
          : cur.alertOnDbRecovery,
      alertOnApiErrorSpike:
        typeof patch.alertOnApiErrorSpike === 'boolean'
          ? patch.alertOnApiErrorSpike
          : cur.alertOnApiErrorSpike,
      apiErrorSpikeThreshold: clampInt(
        patch.apiErrorSpikeThreshold,
        cur.apiErrorSpikeThreshold,
        1,
        100
      ),
      updatedAt: new Date().toISOString(),
    };

    this.rawDb
      .prepare(
        `
        UPDATE system_watchdog_config
        SET enabled = ?, heartbeat_interval_ms = ?, auto_backup_interval_ms = ?,
            alert_on_stall = ?, alert_on_db_recovery = ?, alert_on_api_error_spike = ?,
            api_error_spike_threshold = ?, updated_at = ?
        WHERE id = 1
      `
      )
      .run(
        next.enabled ? 1 : 0,
        next.heartbeatIntervalMs,
        next.autoBackupIntervalMs,
        next.alertOnStall ? 1 : 0,
        next.alertOnDbRecovery ? 1 : 0,
        next.alertOnApiErrorSpike ? 1 : 0,
        next.apiErrorSpikeThreshold,
        next.updatedAt
      );

    if (next.enabled) {
      if (!this.timer) {
        this.start();
      }
    } else {
      this.stop();
    }

    return this.getStatus();
  }

  public start(tickIntervalMs = 60_000): void {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.stop();
      return;
    }
    this.stop();
    const safeTick = Math.max(10_000, tickIntervalMs);
    this.timer = setInterval(() => {
      void this.runWatchdogTick();
    }, safeTick);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private recordEvent(params: {
    eventType: WatchdogEventRecord['eventType'];
    severity: WatchdogEventRecord['severity'];
    messageZh: string;
    notifiedExternal: boolean;
    nowMs: number;
  }): WatchdogEventRecord {
    const record: WatchdogEventRecord = {
      id: `wd_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      eventType: params.eventType,
      severity: params.severity,
      messageZh: params.messageZh,
      notifiedExternal: params.notifiedExternal,
      createdAt: new Date(params.nowMs).toISOString(),
    };
    this.rawDb
      .prepare(
        `
        INSERT INTO system_watchdog_events (
          id, event_type, severity, message_zh, notified_external, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        record.id,
        record.eventType,
        record.severity,
        record.messageZh,
        record.notifiedExternal ? 1 : 0,
        record.createdAt
      );
    if (params.notifiedExternal) {
      this.alertsDispatchedCount += 1;
    }
    return record;
  }

  public listRecentEvents(limit = 30): WatchdogEventRecord[] {
    const safeLimit = clampInt(limit, 30, 1, 200);
    const rows = this.rawDb
      .prepare(
        `SELECT * FROM system_watchdog_events ORDER BY created_at DESC LIMIT ?`
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      eventType: String(r.event_type) as WatchdogEventRecord['eventType'],
      severity: String(r.severity) as WatchdogEventRecord['severity'],
      messageZh: String(r.message_zh),
      notifiedExternal: Number(r.notified_external ?? 0) === 1,
      createdAt: String(r.created_at),
    }));
  }

  public async runWatchdogTick(options?: {
    forceHeartbeat?: boolean;
    forceBackup?: boolean;
    nowMs?: number;
  }): Promise<{
    status: SystemWatchdogStatusResponse;
    emittedEvents: WatchdogEventRecord[];
  }> {
    if (this.runningTick) {
      return { status: this.getStatus(), emittedEvents: [] };
    }
    this.runningTick = true;
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const emittedEvents: WatchdogEventRecord[] = [];

    try {
      const cfg = this.getConfig();
      const activeExchange = this.getActiveExchangeFn();
      const isLive = activeExchange !== 'demo_synthetic';
      const progress = this.smcScanner.getProgressAndHealth(
        activeExchange,
        isLive ? 'live' : 'demo',
        nowMs,
        { includeCycleDiagnostics: false }
      );
      this.lastCheckAt = nowIso;

      // 1. Worker Stall Detection
      if (
        cfg.enabled &&
        cfg.alertOnStall &&
        progress.stalledSuspected &&
        nowMs - this.lastStallAlertMs >= 15 * 60_000
      ) {
        this.lastStallAlertMs = nowMs;
        const reasons =
          progress.stalledReasons && progress.stalledReasons.length > 0
            ? progress.stalledReasons.join(', ')
            : 'SCAN_WORKER_NO_PROGRESS';
        const msg = `背景掃描線程 (${activeExchange}) 疑似卡死或長時間無進度更新 (${reasons})，進度 ${progress.evaluatedCount}/${progress.totalSymbols}`;
        const logs = await this.externalNotifications.dispatchSystemWatchdogAlert({
          eventType: 'WORKER_STALL',
          severity: 'CRITICAL',
          titleZh: `掃描異常卡死 (${activeExchange})`,
          messageZh: msg,
          nowMs,
        });
        const delivered = logs.some((l) => l.status === 'DELIVERED');
        emittedEvents.push(
          this.recordEvent({
            eventType: 'WORKER_STALL',
            severity: 'CRITICAL',
            messageZh: msg,
            notifiedExternal: delivered,
            nowMs,
          })
        );
      }

      // 2. Database Recovery Delta Detection
      const dbRecCount = Number(progress.lifetimeDatabaseRecoveryCount ?? 0);
      if (
        this.lastObservedDbRecoveryCount !== null &&
        dbRecCount > this.lastObservedDbRecoveryCount &&
        cfg.enabled &&
        cfg.alertOnDbRecovery
      ) {
        const msg = `SQLite 自動修復機制已觸發 (累計恢復 ${dbRecCount} 次)，請確認最近備份完整性`;
        const logs = await this.externalNotifications.dispatchSystemWatchdogAlert({
          eventType: 'DB_RECOVERY',
          severity: 'WARNING',
          titleZh: '資料庫自動修復觸發',
          messageZh: msg,
          nowMs,
        });
        const delivered = logs.some((l) => l.status === 'DELIVERED');
        emittedEvents.push(
          this.recordEvent({
            eventType: 'DB_RECOVERY',
            severity: 'WARNING',
            messageZh: msg,
            notifiedExternal: delivered,
            nowMs,
          })
        );
      }
      this.lastObservedDbRecoveryCount = dbRecCount;

      // 3. Exchange API 503 / 429 Error Spike Detection
      const phase17Errors = this.radarDb.getPhase17ErrorEventsSummary(
        activeExchange,
        undefined,
        20
      );
      const count429 = Number(phase17Errors.counts.HTTP_429_BACKOFF ?? 0);
      const count503 = Number(phase17Errors.counts.HTTP_503_HONEST_ERROR ?? 0);
      const totalErrors = count429 + count503;
      if (
        this.lastObservedApiErrorsTotal !== null &&
        totalErrors - this.lastObservedApiErrorsTotal >=
          cfg.apiErrorSpikeThreshold &&
        cfg.enabled &&
        cfg.alertOnApiErrorSpike
      ) {
        const delta = totalErrors - this.lastObservedApiErrorsTotal;
        const msg = `交易所公開 API (${activeExchange}) 近期 429/503 錯誤激增 +${delta} 次 (總 429: ${count429}, 503: ${count503})`;
        const logs = await this.externalNotifications.dispatchSystemWatchdogAlert({
          eventType: 'API_ERROR_SPIKE',
          severity: 'WARNING',
          titleZh: `API 限流/錯誤激增 (${activeExchange})`,
          messageZh: msg,
          nowMs,
        });
        const delivered = logs.some((l) => l.status === 'DELIVERED');
        emittedEvents.push(
          this.recordEvent({
            eventType: 'API_ERROR_SPIKE',
            severity: 'WARNING',
            messageZh: msg,
            notifiedExternal: delivered,
            nowMs,
          })
        );
      }
      this.lastObservedApiErrorsTotal = totalErrors;

      // 4. Scheduled Verified SQLite Auto-Backup
      const lastBackupMs = this.lastAutoBackupAt
        ? Date.parse(this.lastAutoBackupAt)
        : 0;
      const shouldBackup =
        options?.forceBackup === true ||
        (cfg.enabled &&
          (!this.lastAutoBackupAt ||
            nowMs - lastBackupMs >= cfg.autoBackupIntervalMs));
      if (shouldBackup) {
        const dbHealth = this.smcScanner.runDatabaseCheck({
          exchange: activeExchange,
          mode: isLive ? 'live' : 'demo',
          createBackup: true,
        });
        this.lastAutoBackupAt = dbHealth.lastBackupAt ?? nowIso;
        this.autoBackupsCount += 1;
        const msg = `已完成例行 SQLite 資料庫完整性檢查 (${dbHealth.integrityCheck}) 與熱備份 (${dbHealth.backupFilePath ?? 'OK'})`;
        emittedEvents.push(
          this.recordEvent({
            eventType: 'AUTO_BACKUP',
            severity: 'INFO',
            messageZh: msg,
            notifiedExternal: false,
            nowMs,
          })
        );
      }

      // 5. Periodic Watchdog Heartbeat
      const lastHbMs = this.lastHeartbeatAt
        ? Date.parse(this.lastHeartbeatAt)
        : 0;
      const shouldHeartbeat =
        options?.forceHeartbeat === true ||
        (cfg.enabled &&
          (!this.lastHeartbeatAt || nowMs - lastHbMs >= cfg.heartbeatIntervalMs));
      if (shouldHeartbeat) {
        this.lastHeartbeatAt = nowIso;
        const msg = `運作正常 · 交易所 ${activeExchange} · 掃描進度 ${progress.evaluatedCount}/${progress.totalSymbols} (候選=${progress.formalCandidateCount ?? 0}) · 速率 ${progress.progressRatePerMinute}/min`;
        const logs = await this.externalNotifications.dispatchSystemWatchdogAlert({
          eventType: 'HEARTBEAT',
          severity: 'INFO',
          titleZh: '定時健康心跳回報',
          messageZh: msg,
          nowMs,
        });
        const delivered = logs.some((l) => l.status === 'DELIVERED');
        emittedEvents.push(
          this.recordEvent({
            eventType: 'HEARTBEAT',
            severity: 'INFO',
            messageZh: msg,
            notifiedExternal: delivered,
            nowMs,
          })
        );
      }

      return { status: this.getStatus(), emittedEvents };
    } finally {
      this.runningTick = false;
    }
  }

  public getStatus(): SystemWatchdogStatusResponse {
    return {
      safety: TRADING_SAFETY_FLAGS,
      running: this.timer !== null,
      config: this.getConfig(),
      lastCheckAt: this.lastCheckAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastAutoBackupAt: this.lastAutoBackupAt,
      alertsDispatchedCount: this.alertsDispatchedCount,
      autoBackupsCount: this.autoBackupsCount,
      recentEvents: this.listRecentEvents(25),
    };
  }
}
