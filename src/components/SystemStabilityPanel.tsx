import React from 'react';
import {
  PaperMonitorStatusResponse,
  SmcScanStatusResponse,
  SystemDatabaseHealthResponse,
  SystemWatchdogStatusResponse,
  WatchdogConfig,
} from '../types/market.ts';

interface SystemStabilityPanelProps {
  systemDbHealth: SystemDatabaseHealthResponse | null;
  activeSmc: SmcScanStatusResponse | PaperMonitorStatusResponse | null;
  dbCheckLoading: boolean;
  onRunSystemDbCheck: () => void;
  watchdogStatus?: SystemWatchdogStatusResponse | null;
  watchdogLoading?: boolean;
  onRunWatchdogCheck?: () => void;
  onUpdateWatchdogConfig?: (
    patch: Partial<Omit<WatchdogConfig, 'updatedAt'>>
  ) => void;
}

export const SystemStabilityPanel: React.FC<SystemStabilityPanelProps> = ({
  systemDbHealth,
  activeSmc,
  dbCheckLoading,
  onRunSystemDbCheck,
  watchdogStatus,
  watchdogLoading = false,
  onRunWatchdogCheck,
  onUpdateWatchdogConfig,
}) => {
  const smcOnly = activeSmc as SmcScanStatusResponse | null;
  const stalledSuspected = smcOnly?.stalledSuspected ?? false;

  return (
    <div className="border border-slate-800 bg-slate-950/90 px-4 py-3.5 text-[11px] font-mono text-slate-300 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans font-semibold text-xs text-emerald-300">
            系統穩定性 (Phase 17 長時間 Live Paper 掃描穩定性 · Worker 恢復 · SQLite 一致性)
          </span>
          <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/30 text-emerald-300 font-semibold">
            SQLite:{' '}
            {systemDbHealth?.integrityCheckPassed !== false
              ? 'HEALTHY'
              : 'CORRUPTED'}{' '}
            ({systemDbHealth?.integrityCheck ?? 'ok'} · WAL=
            {systemDbHealth?.walStatus ?? 'ACTIVE'})
          </span>
          <span className="px-2 py-0.5 border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 font-semibold">
            快取健康: {systemDbHealth?.cacheHealth ?? 'HEALTHY'} (
            {smcOnly?.cacheStatusLabel ?? '快取可用'})
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={dbCheckLoading}
            onClick={onRunSystemDbCheck}
            className="inline-flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
          >
            {dbCheckLoading
              ? 'SQLite 檢查備份中...'
              : '執行 SQLite 檢查與安全備份 (database-check)'}
          </button>
        </div>
      </div>

      {/* Phase 17 Mandatory 3 Stability Notices */}
      <div className="flex flex-wrap items-center justify-between gap-2 border border-sky-500/30 bg-sky-950/20 px-3 py-1.5 text-[11px] text-sky-200">
        <div className="flex flex-wrap items-center gap-4 font-semibold">
          <span>· PENDING 不等於 WAIT</span>
          <span>· 掃描中不代表候選已確認</span>
          <span>· 候選數為 0 不代表服務故障</span>
        </div>
        <div className="text-[10px] text-slate-300">
          429 次數:{' '}
          <strong className="text-amber-300">
            {systemDbHealth?.rateLimit429Count ?? smcOnly?.rateLimitCount ?? 0}
          </strong>{' '}
          · 503 次數:{' '}
          <strong className="text-rose-300">
            {systemDbHealth?.http503Count ?? 0}
          </strong>{' '}
          · 最後一次錯誤:{' '}
          <strong className="text-slate-200">
            {systemDbHealth?.lastError ?? '無異常'}
          </strong>
        </div>
      </div>

      {/* Stability Core Telemetry Grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 text-[10px]">
        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">
            Monitor / Scan / Queue Worker 狀態
          </div>
          <div className="mt-0.5 font-bold text-slate-100 truncate">
            Monitor:{' '}
            <span className="text-emerald-300">
              {systemDbHealth?.monitorWorkerState ??
                smcOnly?.monitorWorkerState ??
                'RUNNING'}
            </span>{' '}
            · Scan:{' '}
            <span className="text-sky-300">
              {systemDbHealth?.scanWorkerState ??
                smcOnly?.scanWorkerState ??
                'IDLE'}
            </span>{' '}
            · Queue:{' '}
            <span className="text-cyan-300">
              {systemDbHealth?.queueWorkerState ??
                smcOnly?.queueWorkerState ??
                'HEALTHY'}
            </span>
          </div>
          <div className="text-slate-400 truncate">
            每分鐘速率:{' '}
            {systemDbHealth?.progressRatePerMinute ??
              smcOnly?.progressRatePerMinute ??
              0}
            /min (
            {systemDbHealth?.progressRateStatus ??
              smcOnly?.progressRateStatus ??
              'NO_ACTIVE_PROGRESS'}
            ) · stalled=
            <span
              className={
                (systemDbHealth?.stalledSuspected ?? stalledSuspected)
                  ? 'text-rose-400'
                  : 'text-emerald-400'
              }
            >
              {String(systemDbHealth?.stalledSuspected ?? stalledSuspected)}
            </span>
          </div>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">最後進度 / 最後完成任務</div>
          <div className="mt-0.5 font-bold text-slate-100 truncate">
            進度:{' '}
            {systemDbHealth?.lastProgressAt ?? smcOnly?.lastProgressAt ?? 'N/A'}
          </div>
          <div className="text-slate-400 truncate">
            完成:{' '}
            {systemDbHealth?.lastJobCompletedAt ??
              smcOnly?.lastJobCompletedAt ??
              'N/A'}
          </div>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">最舊 PENDING 等待 / 錯誤統計</div>
          <div className="mt-0.5 font-bold text-amber-300">
            最舊等待:{' '}
            {systemDbHealth?.oldestPendingAgeMs ??
              smcOnly?.oldestPendingAgeMs ??
              0}
            ms
          </div>
          <div className="text-slate-400 truncate">
            429: {systemDbHealth?.rateLimit429Count ?? 0} · 503:{' '}
            {systemDbHealth?.http503Count ?? 0} · Stalled:{' '}
            {systemDbHealth?.stalledDetectedCount ?? 0}
          </div>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">SQLite 一致性與安全備份</div>
          <div className="mt-0.5 font-bold text-emerald-300 truncate">
            DB: {systemDbHealth?.databaseInstanceId ?? 'N/A'} (v
            {systemDbHealth?.statsVersion ?? smcOnly?.statsVersion ?? 1})
          </div>
          <div className="text-slate-400 truncate">
            備份: {systemDbHealth?.lastBackupAt ?? '尚未備份'} (
            {systemDbHealth?.backupFileVerified ? 'READABLE_OK' : 'PENDING'}) ·
            快取列:{systemDbHealth?.cacheRowCount ?? 0}
          </div>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">
            目前窗口 / 窗口狀態 / 窗口剩餘時間 / 是否可完成
          </div>
          <div className="mt-0.5 font-bold text-sky-300 truncate">
            目前窗口:{' '}
            {systemDbHealth?.monitoringWindows?.['24h']?.monitoringWindowId ??
              systemDbHealth?.monitoringWindowId ??
              'N/A'}
          </div>
          <div className="text-slate-400 truncate">
            窗口狀態:{' '}
            <strong className="text-emerald-300">
              {systemDbHealth?.monitoringWindows?.['24h']?.windowStatus ??
                'RUNNING'}
            </strong>{' '}
            · 窗口剩餘時間:{' '}
            {systemDbHealth?.monitoringWindows?.['24h']?.remainingDuration ??
              '24h 00m 00s'}{' '}
            · 是否可完成:{' '}
            <strong className="text-amber-300">
              {String(
                systemDbHealth?.monitoringWindows?.['24h']?.canMarkCompleted ??
                  false
              )}
            </strong>
          </div>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="text-slate-400">
            本窗口 vs 服務累計重啟與恢復計數 (Phase 17.3)
          </div>
          <div className="mt-0.5 font-bold text-cyan-300 truncate">
            本窗口計畫性重啟:{' '}
            {systemDbHealth?.windowPlannedRestartCount ??
              smcOnly?.windowPlannedRestartCount ??
              0}{' '}
            · 本窗口非預期重啟:{' '}
            <span
              className={
                (systemDbHealth?.windowUnexpectedRestartCount ?? 0) > 0
                  ? 'text-rose-400'
                  : 'text-emerald-300'
              }
            >
              {systemDbHealth?.windowUnexpectedRestartCount ??
                smcOnly?.windowUnexpectedRestartCount ??
                0}
            </span>{' '}
            · 本窗口 Lease 恢復:{' '}
            {systemDbHealth?.windowLeaseRecoveryCount ??
              smcOnly?.windowLeaseRecoveryCount ??
              0}{' '}
            · 本窗口資料庫恢復:{' '}
            {systemDbHealth?.windowDatabaseRecoveryCount ??
              smcOnly?.windowDatabaseRecoveryCount ??
              0}
          </div>
          <div className="text-slate-400 truncate">
            服務累計計畫性重啟:{' '}
            {systemDbHealth?.lifetimePlannedRestartCount ??
              systemDbHealth?.plannedRestartCount ??
              0}{' '}
            · 服務累計非預期重啟:{' '}
            {systemDbHealth?.lifetimeUnexpectedRestartCount ??
              systemDbHealth?.unexpectedRestartCount ??
              0}{' '}
            · 服務累計 Lease 恢復:{' '}
            {systemDbHealth?.lifetimeLeaseRecoveryCount ??
              systemDbHealth?.leaseRecoveryCount ??
              0}{' '}
            · 服務累計資料庫恢復:{' '}
            {systemDbHealth?.lifetimeDatabaseRecoveryCount ??
              systemDbHealth?.databaseRecoveryCount ??
              0}
          </div>
        </div>
      </div>

      {/* Phase 17.1 & 17.3 Concurrency Cap, Current vs Previous Window & Finalization Strip */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3 text-[10px]">
        <div className="min-w-0 border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-slate-400">
            並行限制驗證 (runningJobCount &lt;= maxConcurrency)
          </span>
          <span className="font-mono font-bold text-slate-100 break-words">
            最大並行數:{' '}
            <strong className="text-cyan-300">
              {systemDbHealth?.maxConcurrency ??
                smcOnly?.maxConcurrency ??
                smcOnly?.config?.maxConcurrency ??
                2}
            </strong>{' '}
            · 目前執行數:{' '}
            <strong className="text-amber-300">
              {systemDbHealth?.runningJobCount ?? smcOnly?.runningJobCount ?? 0}
            </strong>{' '}
            · 並行限制是否通過:{' '}
            <strong
              className={
                (systemDbHealth?.concurrencyValid ??
                smcOnly?.concurrencyValid ??
                true)
                  ? 'text-emerald-300'
                  : 'text-rose-400'
              }
            >
              {(systemDbHealth?.concurrencyValid ??
              smcOnly?.concurrencyValid ??
              true)
                ? 'PASS (true)'
                : 'FAIL (false)'}
            </strong>
          </span>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-slate-400">
            目前窗口 (24h / 72h) 收尾驗證
          </span>
          <span className="font-mono font-bold text-slate-200 min-w-0 break-all">
            24h:{' '}
            <strong className="text-sky-300">
              {systemDbHealth?.monitoringWindows?.['24h']?.windowStatus ??
                'RUNNING'}
            </strong>{' '}
            (
            {systemDbHealth?.monitoringWindows?.['24h']?.remainingDuration ??
              '24h'}
            ) · 72h:{' '}
            <strong className="text-sky-300">
              {systemDbHealth?.monitoringWindows?.['72h']?.windowStatus ??
                'RUNNING'}
            </strong>{' '}
            (
            {systemDbHealth?.monitoringWindows?.['72h']?.remainingDuration ??
              '72h'}
            ) · 是否可完成:{' '}
            <strong className="text-amber-300">
              {String(
                systemDbHealth?.monitoringWindows?.['24h']?.canMarkCompleted ??
                  false
              )}
            </strong>
          </span>
        </div>

        <div className="min-w-0 border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-slate-400">上一個窗口 (歷史終態追蹤)</span>
          <span className="font-mono font-bold text-slate-200 min-w-0 break-all">
            {systemDbHealth?.previousWindows?.['24h'] ? (
              <>
                {systemDbHealth.previousWindows['24h'].monitoringWindowId} ·
                狀態:{' '}
                <strong className="text-rose-300">
                  {systemDbHealth.previousWindows['24h'].windowStatus}
                </strong>{' '}
                · 原因:{' '}
                <span className="text-amber-300">
                  {systemDbHealth.previousWindows['24h'].terminalReason ?? 'N/A'}
                </span>
              </>
            ) : (
              '無上一個窗口紀錄'
            )}
          </span>
        </div>
      </div>

      {/* 7x24 Watchdog Heartbeat, Auto-Backup & External Anomaly Alert Strip */}
      <div
        id="system-watchdog-panel"
        className="border border-slate-800/90 bg-slate-900/50 px-3 py-2.5 text-[10px] space-y-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans font-semibold text-xs text-cyan-300">
              7×24 Watchdog 自動巡檢、異常告警與定時備份
            </span>
            <span
              className={`px-2 py-0.5 border font-semibold ${
                watchdogStatus?.config?.enabled
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {watchdogStatus?.config?.enabled
                ? watchdogStatus.running
                  ? 'WATCHDOG RUNNING'
                  : 'ENABLED (IDLE)'
                : 'DISABLED'}
            </span>
            <span className="text-slate-400">
              最近心跳:{' '}
              <strong className="text-slate-200">
                {watchdogStatus?.lastHeartbeatAt
                  ? new Date(watchdogStatus.lastHeartbeatAt).toLocaleString(
                      'zh-TW',
                      { hour12: false }
                    )
                  : '尚未觸發'}
              </strong>
            </span>
            <span className="text-slate-400">
              自動備份:{' '}
              <strong className="text-emerald-300">
                {watchdogStatus?.autoBackupsCount ?? 0} 次
              </strong>
              {watchdogStatus?.lastAutoBackupAt
                ? ` (${new Date(
                    watchdogStatus.lastAutoBackupAt
                  ).toLocaleTimeString('zh-TW', { hour12: false })})`
                : ''}
            </span>
            <span className="text-slate-400">
              外部告警派發:{' '}
              <strong className="text-amber-300">
                {watchdogStatus?.alertsDispatchedCount ?? 0} 次
              </strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onUpdateWatchdogConfig && watchdogStatus?.config && (
              <>
                <label className="inline-flex items-center gap-1 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={watchdogStatus.config.enabled}
                    onChange={(e) =>
                      onUpdateWatchdogConfig({ enabled: e.target.checked })
                    }
                    className="accent-emerald-400"
                  />
                  <span>啟用 Watchdog</span>
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={watchdogStatus.config.alertOnStall}
                    onChange={(e) =>
                      onUpdateWatchdogConfig({ alertOnStall: e.target.checked })
                    }
                    className="accent-amber-400"
                  />
                  <span>卡死告警</span>
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={watchdogStatus.config.alertOnDbRecovery}
                    onChange={(e) =>
                      onUpdateWatchdogConfig({
                        alertOnDbRecovery: e.target.checked,
                      })
                    }
                    className="accent-amber-400"
                  />
                  <span>DB 恢復告警</span>
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={watchdogStatus.config.alertOnApiErrorSpike}
                    onChange={(e) =>
                      onUpdateWatchdogConfig({
                        alertOnApiErrorSpike: e.target.checked,
                      })
                    }
                    className="accent-amber-400"
                  />
                  <span>API 激增告警</span>
                </label>
              </>
            )}
            {onRunWatchdogCheck && (
              <button
                type="button"
                disabled={watchdogLoading}
                onClick={onRunWatchdogCheck}
                className="inline-flex items-center gap-1 border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer disabled:opacity-50"
              >
                {watchdogLoading
                  ? 'Watchdog 巡檢備份中...'
                  : '執行 Watchdog 心跳與備份檢查'}
              </button>
            )}
          </div>
        </div>

        {watchdogStatus?.recentEvents && watchdogStatus.recentEvents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-800/80 pt-1.5">
            <span className="text-slate-400">近期巡檢紀錄:</span>
            {watchdogStatus.recentEvents.slice(0, 5).map((ev) => (
              <span
                key={ev.id}
                className={`px-1.5 py-0.5 border ${
                  ev.severity === 'CRITICAL'
                    ? 'border-rose-500/50 bg-rose-950/30 text-rose-300'
                    : ev.severity === 'WARNING'
                      ? 'border-amber-500/50 bg-amber-950/30 text-amber-300'
                      : 'border-slate-700 bg-slate-950 text-slate-300'
                }`}
              >
                [{ev.eventType}] {ev.messageZh}
                {ev.notifiedExternal ? ' · 已推播' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
