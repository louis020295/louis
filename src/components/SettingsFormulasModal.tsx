import React from 'react';
import { formatTaipeiTime } from '../utils/taipeiTime.ts';
import {
  Activity,
  Calculator,
  Moon,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Sun,
  X,
} from 'lucide-react';
import {
  BackgroundSchedulerStatus,
  ExchangeId,
  MarketScanResponse,
  PaperMonitorStatusResponse,
  SmcScanStatusResponse,
  SystemDatabaseHealthResponse,
  Timeframe,
} from '../types/market.ts';
import { SystemStabilityPanel } from './SystemStabilityPanel.tsx';

export type SettingsHubTab = 'settings' | 'controls' | 'formulas' | 'telemetry';

interface SettingsFormulasModalProps {
  open: boolean;
  onClose: () => void;
  activeTab: SettingsHubTab;
  onChangeTab: (tab: SettingsHubTab) => void;

  // Settings & environment
  dataMode: 'live' | 'demo';
  selectedExchange: ExchangeId;
  onSwitchLiveExchange: (ex: ExchangeId) => void;
  onSwitchDemoMode: () => void;
  minQuoteVolume24h: number;
  onChangeMinQuoteVolume24h: (val: number) => void;
  selectedTimeframe: Timeframe;
  onChangeTimeframe: (tf: Timeframe) => void;
  themeMode: 'dark' | 'light';
  onChangeThemeMode: (mode: 'dark' | 'light') => void;

  // Data & control handlers
  scanData: MarketScanResponse | null;
  smcScanStatus: SmcScanStatusResponse | null;
  smcQueueLoading: boolean;
  onControlSmcQueue: (action: 'start' | 'step' | 'pause' | 'resume') => void;
  onRetryStuckSmcJobs: () => void;
  onRefreshSingleSmcSymbol: (symbol: string) => void;
  selectedSymbol: string;

  schedulerStatus: BackgroundSchedulerStatus | null;
  schedulerLoading: boolean;
  onControlScheduler: (action: 'start' | 'stop' | 'run_once') => void;

  paperMonitorStatus: PaperMonitorStatusResponse | null;
  paperMonitorLoading: boolean;
  onControlPaperMonitor: (action: 'start' | 'pause' | 'resume') => void;

  systemDbHealth: SystemDatabaseHealthResponse | null;
  dbCheckLoading: boolean;
  onRunSystemDbCheck: () => void;
  onRefreshScan: () => void;
  onSelectSymbolDetail: (symbol: string) => void;
}

export const SettingsFormulasModal: React.FC<SettingsFormulasModalProps> = ({
  open,
  onClose,
  activeTab,
  onChangeTab,
  dataMode,
  selectedExchange,
  onSwitchLiveExchange,
  onSwitchDemoMode,
  minQuoteVolume24h,
  onChangeMinQuoteVolume24h,
  selectedTimeframe,
  onChangeTimeframe,
  themeMode,
  onChangeThemeMode,
  scanData,
  smcScanStatus,
  smcQueueLoading,
  onControlSmcQueue,
  onRetryStuckSmcJobs,
  onRefreshSingleSmcSymbol,
  selectedSymbol,
  schedulerStatus,
  schedulerLoading,
  onControlScheduler,
  paperMonitorStatus,
  paperMonitorLoading,
  onControlPaperMonitor,
  systemDbHealth,
  dbCheckLoading,
  onRunSystemDbCheck,
  onRefreshScan,
  onSelectSymbolDetail,
}) => {
  if (!open) return null;

  const activeSmc = smcScanStatus ?? scanData?.smcScanStatus ?? null;
  const totalJobs =
    activeSmc?.totalJobs ??
    activeSmc?.totalContractsCount ??
    scanData?.totalContractsScanned ??
    0;
  const queuedCount = activeSmc?.queuedCount ?? 0;
  const runningJobCount =
    activeSmc?.runningJobCount ?? activeSmc?.runningCount ?? 0;
  const waitingForCacheCount = activeSmc?.waitingForCacheCount ?? 0;
  const waitingForRateLimitCount =
    activeSmc?.waitingForRateLimitCount ?? activeSmc?.rateLimitedCount ?? 0;
  const waitingForNextBatchCount = activeSmc?.waitingForNextBatchCount ?? 0;
  const retryScheduledCount = activeSmc?.retryScheduledCount ?? 0;
  const failedRetryableCount = activeSmc?.failedRetryableCount ?? 0;
  const inFlightRequestCount = activeSmc?.inFlightRequestCount ?? 0;
  const succeededCount = activeSmc?.succeededCount ?? 0;
  const failedCount = activeSmc?.failedCount ?? 0;
  const rateLimitedCount = activeSmc?.rateLimitedCount ?? 0;
  const pendingCount = activeSmc?.pendingCount ?? scanData?.smcPendingCount ?? 0;
  const waitCount = activeSmc?.waitCount ?? scanData?.smcWaitCount ?? 0;
  const watchCount = activeSmc?.watchCount ?? scanData?.smcWatchCount ?? 0;
  const longCandidateCount =
    activeSmc?.longCandidateCount ?? scanData?.smcLongCandidateCount ?? 0;
  const shortCandidateCount =
    activeSmc?.shortCandidateCount ?? scanData?.smcShortCandidateCount ?? 0;
  const highRiskCount =
    activeSmc?.highRiskCount ?? scanData?.smcHighRiskCount ?? 0;
  const stalledSuspected = activeSmc?.stalledSuspected ?? false;
  const stalledReasons = activeSmc?.stalledReasons ?? [];
  const diagnosisLabel =
    activeSmc?.diagnosisLabel ??
    (stalledSuspected
      ? '背景掃描疑似卡住'
      : pendingCount === 0 && totalJobs > 0 && succeededCount === totalJobs
        ? '掃描已完成'
        : '正常背景評估中');
  const pendingBreakdownConsistency =
    activeSmc?.pendingBreakdownConsistency ?? 'VALID';

  const funnel = scanData?.candidateFunnel ?? smcScanStatus?.candidateFunnel;
  const gateDiag =
    scanData?.smcGateDiagnostics ?? smcScanStatus?.smcGateDiagnostics;
  const scopedStats =
    scanData?.scopedGateStatistics ??
    smcScanStatus?.scopedGateStatistics ??
    gateDiag?.scopedGateStatistics;
  const shadowComp =
    scanData?.observationShadowComparison ??
    smcScanStatus?.observationShadowComparison ??
    gateDiag?.observationShadowComparison;
  const smcCandTotal =
    (scanData?.smcLongCandidateCount ?? 0) +
    (scanData?.smcShortCandidateCount ?? 0);
  const nearMissTotal =
    gateDiag?.nearMissCount ??
    funnel?.nearMissCount ??
    scanData?.nearMissCount ??
    0;
  const nearMiss1 =
    gateDiag?.nearMissMissing1Count ??
    funnel?.nearMissOneGateCount ??
    scanData?.nearMissMissing1Count ??
    0;
  const nearMiss2 =
    gateDiag?.nearMissMissing2Count ??
    funnel?.nearMissTwoGatesCount ??
    scanData?.nearMissMissing2Count ??
    0;
  const blockedByPaper =
    scanData?.blockedByPaperEligibilityCount ??
    smcScanStatus?.blockedByPaperEligibilityCount ??
    0;
  const eligiblePaper =
    scanData?.eligiblePaperSignalCount ??
    smcScanStatus?.eligiblePaperSignalCount ??
    0;
  const missedWindow =
    scanData?.entryWindowMissedCount ??
    smcScanStatus?.entryWindowMissedCount ??
    0;
  const paperOpened =
    scanData?.paperOpenedCount ?? smcScanStatus?.paperOpenedCount ?? 0;
  const paperClosed =
    scanData?.paperClosedCount ??
    smcScanStatus?.paperClosedCount ??
    funnel?.paperClosedCount ??
    0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="設定與公式中心"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-[#0d1017] text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-base font-bold tracking-tight text-slate-100">
              設定與公式中心
            </h2>
            <p className="text-xs text-slate-400">
              集中管理資料源、篩選門檻、背景佇列排程、計算公式與工程遙測，讓雷達主畫面保持純淨
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
          >
            <X className="h-3.5 w-3.5" />
            <span>關閉介面</span>
          </button>
        </div>

        {/* Sub-navigation inside the unified modal */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-950/60 px-5 py-2.5 text-xs">
          {(
            [
              {
                id: 'settings' as const,
                label: '基本設定與門檻',
                icon: SlidersHorizontal,
              },
              {
                id: 'controls' as const,
                label: '佇列與排程控制',
                icon: Play,
              },
              {
                id: 'formulas' as const,
                label: '計算公式與 Gate 規則',
                icon: Calculator,
              },
              {
                id: 'telemetry' as const,
                label: '漏斗與工程遙測',
                icon: Activity,
              },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onChangeTab(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* TAB 1: 基本設定與門檻 */}
          {activeTab === 'settings' && (
            <div className="space-y-5">
              {/* Exchange & Data Mode */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      交易所資料源與驗證模式
                    </h3>
                    <p className="text-xs text-slate-400">
                      Live 失敗時嚴禁自動降級為 Demo；需手動切換才進入 DEMO_SYNTHETIC_DATASET
                    </p>
                  </div>
                  <span className="text-xs font-mono text-slate-400">
                    目前模式: {dataMode.toUpperCase()} · {selectedExchange}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSwitchLiveExchange('binance_usdm')}
                    className={`rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      dataMode === 'live' && selectedExchange === 'binance_usdm'
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-semibold'
                        : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    Binance USDⓈ-M (LIVE)
                  </button>
                  <button
                    type="button"
                    onClick={() => onSwitchLiveExchange('bybit_linear')}
                    className={`rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      dataMode === 'live' && selectedExchange === 'bybit_linear'
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-semibold'
                        : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    Bybit Linear (LIVE)
                  </button>
                  <button
                    type="button"
                    onClick={() => onSwitchLiveExchange('bingx_swap')}
                    className={`rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      dataMode === 'live' && selectedExchange === 'bingx_swap'
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-semibold'
                        : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    BingX Swap (LIVE)
                  </button>
                  <button
                    type="button"
                    onClick={onSwitchDemoMode}
                    className={`rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      dataMode === 'demo'
                        ? 'border-rose-400 bg-rose-500/20 text-amber-300 font-semibold'
                        : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    切換 Demo 驗證模式 (DEMO_ONLY)
                  </button>
                </div>
              </div>

              {/* Filter, Timeframe & Theme Grid */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2.5">
                  <label
                    htmlFor="modal-min-vol-select"
                    className="block text-sm font-semibold text-slate-100"
                  >
                    最低 24h 成交額過濾
                  </label>
                  <p className="text-xs text-slate-400">
                    篩選全市場掃描回傳的最低 24h Quote Volume 門檻
                  </p>
                  <select
                    id="modal-min-vol-select"
                    value={minQuoteVolume24h}
                    onChange={(e) =>
                      onChangeMinQuoteVolume24h(Number(e.target.value))
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    <option value={0}>全部標的 ($0+)</option>
                    <option value={15_000_000}>
                      ≥ $1,500萬 (排除低流動性)
                    </option>
                    <option value={50_000_000}>≥ $5,000萬 (50M USDT)</option>
                    <option value={100_000_000}>≥ $1億 (100M USDT)</option>
                    <option value={500_000_000}>≥ $5億 (500M USDT)</option>
                  </select>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2.5">
                  <div className="text-sm font-semibold text-slate-100">
                    結構分析週期 (K 線主圖)
                  </div>
                  <p className="text-xs text-slate-400">
                    切換右側 K 線圖與 SMC 結構檢視的預設週期
                  </p>
                  <div className="flex items-center gap-1.5">
                    {(['5m', '15m', '1h', '4h'] as Timeframe[]).map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        onClick={() => onChangeTimeframe(tf)}
                        className={`flex-1 rounded-lg border py-2 text-xs font-mono cursor-pointer transition-colors ${
                          selectedTimeframe === tf
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-bold'
                            : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2.5">
                  <div className="text-sm font-semibold text-slate-100">
                    介面主題外觀
                  </div>
                  <p className="text-xs text-slate-400">
                    切換深色專業模式或淺色白晝閱讀模式
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onChangeThemeMode('dark')}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                        themeMode === 'dark'
                          ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-semibold'
                          : 'border-slate-800 bg-slate-900 text-slate-300 hover:text-slate-100'
                      }`}
                    >
                      <Moon className="h-3.5 w-3.5" />
                      <span>深色專業</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeThemeMode('light')}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                        themeMode === 'light'
                          ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-semibold'
                          : 'border-slate-800 bg-slate-900 text-slate-300 hover:text-slate-100'
                      }`}
                    >
                      <Sun className="h-3.5 w-3.5" />
                      <span>淺色白晝</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Scanner Config Read-only Hard Guardrails */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">
                    實盤安全硬門檻設定 (Scanner Config — 唯讀保護)
                  </h3>
                  <span className="text-xs font-mono text-emerald-400">
                    PAPER ONLY · LIVE ORDERS DISABLED · NEVER AUTO-PLACE ORDERS
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-xs tabular-nums">
                  <div className="border border-slate-800 bg-slate-900/50 p-3">
                    <div className="font-sans text-slate-400">
                      MIN_QUOTE_VOLUME_24H
                    </div>
                    <div className="mt-1 font-bold text-slate-100">
                      $
                      {(
                        scanData?.dataQuality?.scannerConfig
                          ?.MIN_QUOTE_VOLUME_24H ?? 15_000_000
                      ).toLocaleString()}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-3">
                    <div className="font-sans text-slate-400">
                      MAX_ALLOWED_SPREAD_PERCENT
                    </div>
                    <div className="mt-1 font-bold text-slate-100">
                      {scanData?.dataQuality?.scannerConfig
                        ?.MAX_ALLOWED_SPREAD_PERCENT ?? 0.3}
                      %
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-3">
                    <div className="font-sans text-slate-400">
                      LOW_LIQUIDITY_POLICY
                    </div>
                    <div className="mt-1 font-bold text-amber-300 truncate">
                      {scanData?.dataQuality?.scannerConfig
                        ?.LOW_LIQUIDITY_POLICY ??
                        'ONLY_HIGH_RISK_OR_WATCH_OR_WAIT'}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-3">
                    <div className="font-sans text-slate-400">
                      SMC 卡住門檻 (stalledThresholdMs)
                    </div>
                    <div className="mt-1 font-bold text-slate-100">
                      {activeSmc?.stalledThresholdMs ?? 45000} ms · 並行上限{' '}
                      {activeSmc?.config?.maxConcurrency ?? 2}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 佇列與排程控制 */}
          {activeTab === 'controls' && (
            <div className="space-y-5">
              {/* Phase 3 & Phase 16 SMC Queue Control & Progress */}
              <div className="border border-slate-800 bg-slate-950/90 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-800/80 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-amber-300">
                      SMC 全市場掃描進度與 Phase 16 背景 Worker 健康度診斷
                    </span>
                    <span className="font-mono text-slate-300">
                      掃描進度：已完成{' '}
                      <strong className="text-emerald-400">
                        {succeededCount}
                      </strong>{' '}
                      / 總數{' '}
                      <strong className="text-slate-100">{totalJobs}</strong>{' '}
                      (完成數 / 總數)
                    </span>
                    <span
                      className={`px-2 py-0.5 font-mono text-[11px] font-bold border ${
                        stalledSuspected ||
                        pendingBreakdownConsistency === 'INVALID'
                          ? 'border-rose-500/60 bg-rose-950/50 text-rose-300'
                          : diagnosisLabel === '掃描已完成'
                            ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300'
                            : 'border-sky-500/50 bg-sky-950/40 text-sky-300'
                      }`}
                    >
                      診斷說明：{diagnosisLabel} (stalledSuspected=
                      {String(stalledSuspected)})
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => onControlSmcQueue('start')}
                      className="inline-flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" />
                      啟動背景分批掃描
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => onControlSmcQueue('step')}
                      className="inline-flex items-center gap-1 border border-sky-500/50 bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${smcQueueLoading ? 'animate-spin' : ''}`}
                      />
                      執行下一批次
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => onControlSmcQueue('pause')}
                      className="inline-flex items-center gap-1 border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <Square className="h-3 w-3" />
                      暫停佇列
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => onControlSmcQueue('resume')}
                      className="inline-flex items-center gap-1 border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 cursor-pointer disabled:opacity-50"
                    >
                      繼續佇列
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={onRetryStuckSmcJobs}
                      className="inline-flex items-center gap-1 border border-rose-500/50 bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25 cursor-pointer disabled:opacity-50"
                    >
                      重試卡住任務 (retry-stuck)
                    </button>
                    {selectedSymbol && (
                      <button
                        type="button"
                        disabled={smcQueueLoading}
                        onClick={() => onRefreshSingleSmcSymbol(selectedSymbol)}
                        className="inline-flex items-center gap-1 border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25 cursor-pointer disabled:opacity-50"
                      >
                        單檔刷新 ({selectedSymbol})
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-400">
                  monitorWorkerState:{' '}
                  {activeSmc?.monitorWorkerState ??
                    systemDbHealth?.monitorWorkerState ??
                    'RUNNING'}{' '}
                  · scanWorkerState:{' '}
                  {activeSmc?.scanWorkerState ??
                    systemDbHealth?.scanWorkerState ??
                    'IDLE'}{' '}
                  · queueWorkerState:{' '}
                  {activeSmc?.queueWorkerState ??
                    systemDbHealth?.queueWorkerState ??
                    'HEALTHY'}{' '}
                  · scannerHealth: {activeSmc?.scannerHealth ?? 'HEALTHY'} ·
                  queueHealth: {activeSmc?.queueHealth ?? 'HEALTHY'} ·
                  exchangeApiHealth: {activeSmc?.exchangeApiHealth ?? 'HEALTHY'}{' '}
                  · 佇列 Snapshot: {activeSmc?.snapshotAt ?? 'N/A'}{' '}
                  (statsVersion={activeSmc?.statsVersion ?? 1})
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border border-amber-500/30 bg-amber-950/20 px-3 py-1.5 text-[11px] font-mono text-amber-200">
                  <div className="flex flex-wrap items-center gap-3 font-semibold">
                    <span>· PENDING 不等於 WAIT</span>
                    <span>· PENDING 不代表 SMC 通過</span>
                    <span>· PENDING 不代表 SMC 被拒絕</span>
                    <span className="text-amber-300/90">
                      (SMC 尚未評估／點擊載入單幣種結構)
                    </span>
                  </div>
                  <div className="text-slate-300">
                    Fast Lane PENDING:{' '}
                    <strong className="text-amber-300">
                      {activeSmc?.fastLanePendingCount ?? 0}
                    </strong>{' '}
                    · Bulk PENDING:{' '}
                    <strong className="text-sky-300">
                      {activeSmc?.bulkPendingCount ?? 0}
                    </strong>{' '}
                    · 每分鐘完成速率:{' '}
                    <strong className="text-emerald-300">
                      {activeSmc?.progressRatePerMinute ?? 0}/min
                    </strong>{' '}
                    · 最舊 PENDING 等待時間:{' '}
                    <strong className="text-amber-300">
                      {activeSmc?.oldestPendingAgeMs ?? 0}ms
                    </strong>
                  </div>
                </div>

                {/* 12 Queue Tiles */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 font-mono tabular-nums text-[11px]">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      PENDING 數 ({`PENDING(${pendingCount})`})
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-slate-300">
                      {pendingCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      尚未完成 (一致性: {pendingBreakdownConsistency})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      QUEUED / RUNNING
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-sky-300">
                      Q:{queuedCount} / R:{runningJobCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      含下一批等待:{waitingForNextBatchCount} (並行≤
                      {activeSmc?.config.maxConcurrency ?? 2})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      WAITING_FOR_CACHE / IN-FLIGHT REQUESTS
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-cyan-300">
                      {waitingForCacheCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      等待快取預熱 (IN-FLIGHT REQUESTS: {inFlightRequestCount})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      RATE LIMITED / RATE_LIMITED / RETRY
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-amber-400">
                      RL:{waitingForRateLimitCount || rateLimitedCount} / RETRY:
                      {retryScheduledCount + failedRetryableCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      等待重試:{retryScheduledCount} · 可重試失敗:
                      {failedRetryableCount}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">SUCCEEDED</div>
                    <div className="mt-0.5 text-sm font-bold text-emerald-400">
                      {succeededCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已完成有效 SMC 結果數
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">WAIT</div>
                    <div className="mt-0.5 text-sm font-bold text-amber-300">
                      {waitCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已評估等待確認
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">WATCH</div>
                    <div className="mt-0.5 text-sm font-bold text-sky-300">
                      {watchCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已評估觀察結構
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      LONG / SHORT 候選
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-emerald-400">
                      L:{longCandidateCount} /{' '}
                      <span className="text-rose-400">
                        S:{shortCandidateCount}
                      </span>
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      HIGH RISK: {highRiskCount}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">FAILED 數</div>
                    <div className="mt-0.5 text-sm font-bold text-rose-400">
                      {failedCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      終端失敗 (不計入 PENDING)
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      最後完成時間 / 進度時間
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-slate-200 truncate">
                      {activeSmc?.lastJobCompletedAt ?? activeSmc?.lastCompletedAt
                        ? formatTaipeiTime(
                            activeSmc?.lastJobCompletedAt ??
                              activeSmc?.lastCompletedAt ??
                              ''
                          )
                        : '尚無完成紀錄'}
                    </div>
                    <div className="text-[10px] font-sans text-sky-300 truncate">
                      資料新鮮度 · 最後進度:{' '}
                      {activeSmc?.lastProgressAt
                        ? formatTaipeiTime(activeSmc.lastProgressAt)
                        : 'N/A'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      速率 / 預估剩餘時間
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-emerald-300 truncate">
                      {activeSmc?.progressRatePerMinute ?? 0} 檔/分 (
                      {activeSmc?.progressRateStatus ??
                        (pendingCount === 0
                          ? 'NO_ACTIVE_PROGRESS'
                          : 'ACTIVE')}
                      )
                    </div>
                    <div className="text-[10px] font-sans text-amber-300 truncate">
                      預估剩餘: {activeSmc?.estimatedRemaining ?? '0s'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      卡住診斷 (stalledJobCount)
                    </div>
                    <div
                      className={`mt-0.5 text-xs font-bold truncate ${
                        stalledSuspected ? 'text-rose-400' : 'text-emerald-400'
                      }`}
                    >
                      {stalledSuspected
                        ? `疑似卡住 (${activeSmc?.stalledJobCount ?? 0})`
                        : '正常 (0)'}
                    </div>
                    <div className="text-[10px] font-sans text-slate-400 truncate">
                      {stalledReasons.length > 0
                        ? stalledReasons.join(', ')
                        : `門檻 ${activeSmc?.stalledThresholdMs ?? 45000}ms`}
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-800/80 pt-2 text-[11px] font-mono text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    佇列總數恆等式 / Phase 16 PENDING 統計恆等式：pendingCount(
                    {pendingCount}) = queuedCount({queuedCount}) +
                    runningJobCount({runningJobCount}) + waitingForCacheCount(
                    {waitingForCacheCount}) + waitingForRateLimitCount(
                    {waitingForRateLimitCount}) + retryScheduledCount(
                    {retryScheduledCount}) + failedRetryableCount(
                    {failedRetryableCount}) · pendingBreakdownConsistency=
                    <strong
                      className={
                        pendingBreakdownConsistency === 'VALID'
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }
                    >
                      {pendingBreakdownConsistency}
                    </strong>
                  </span>
                  <span>
                    SUCCEEDED({succeededCount}) = WAIT({waitCount}) + WATCH(
                    {watchCount}) + LONG({longCandidateCount}) + SHORT(
                    {shortCandidateCount}) + HIGH_RISK({highRiskCount}) ·
                    FAILED({failedCount}) 不計入 PENDING
                  </span>
                </div>

                {/* Phase 8 & 9 Cache & Fast Lane summary */}
                <div className="border-t border-slate-800/80 pt-2 text-[11px] font-mono text-slate-300 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Phase 8 Fast Lane p50:{' '}
                    <strong className="text-emerald-400">
                      {activeSmc?.p50PriorityDetectionLatencyMs ??
                        activeSmc?.p50DetectionLatencyMs ??
                        0}
                      ms
                    </strong>{' '}
                    · p95:{' '}
                    <strong className="text-emerald-400">
                      {activeSmc?.p95PriorityDetectionLatencyMs ??
                        activeSmc?.p95DetectionLatencyMs ??
                        0}
                      ms
                    </strong>{' '}
                    · 命中率:{' '}
                    <strong className="text-sky-300">
                      {activeSmc?.cacheHitRate ?? 0}%
                    </strong>
                  </span>
                  <span>
                    快取覆蓋率:{' '}
                    <strong className="text-emerald-300">
                      {activeSmc?.cacheCoverageRate ??
                        scanData?.cacheCoverageRate ??
                        0}
                      %
                    </strong>{' '}
                    (5m:{activeSmc?.['5mCacheCoverage'] ?? 0}% · 15m:
                    {activeSmc?.['15mCacheCoverage'] ?? 0}% · 1h:
                    {activeSmc?.['1hCacheCoverage'] ?? 0}% · 4h:
                    {activeSmc?.['4hCacheCoverage'] ?? 0}%)
                  </span>
                </div>
              </div>

              {/* Background Scheduler + Paper Shadow Monitor Controls */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">
                        背景全市場掃描與歷史量能 Collector 排程器
                      </h3>
                      <p className="text-xs text-slate-400">
                        定時收集成交量樣本寫入 SQLite，通知維持 DRY_RUN_ONLY
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-emerald-400">
                      {schedulerStatus?.running ? 'RUNNING' : 'IDLE'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={schedulerLoading}
                      onClick={() => onControlScheduler('run_once')}
                      className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer disabled:opacity-50"
                    >
                      立即執行一次背景掃描
                    </button>
                    {schedulerStatus?.running ? (
                      <button
                        type="button"
                        disabled={schedulerLoading}
                        onClick={() => onControlScheduler('stop')}
                        className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-200 cursor-pointer disabled:opacity-50"
                      >
                        停止背景排程
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={schedulerLoading}
                        onClick={() => onControlScheduler('start')}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-200 cursor-pointer disabled:opacity-50"
                      >
                        啟動背景排程
                      </button>
                    )}
                    <span className="text-xs font-mono text-slate-400">
                      累計執行: {schedulerStatus?.totalRuns ?? 0} 次
                    </span>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">
                        Paper Shadow Monitor 背景影子監控
                      </h3>
                      <p className="text-xs text-slate-400">
                        持續評估全市場結構，僅寫入本地紙上帳本與沙盒佇列
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-sky-300">
                      {paperMonitorStatus?.workerState ?? 'STOPPED'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={paperMonitorLoading}
                      onClick={() => onControlPaperMonitor('start')}
                      className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
                    >
                      啟動影子運行
                    </button>
                    <button
                      type="button"
                      disabled={paperMonitorLoading}
                      onClick={() => onControlPaperMonitor('pause')}
                      className="rounded-lg border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
                    >
                      暫停影子運行
                    </button>
                    <button
                      type="button"
                      disabled={paperMonitorLoading}
                      onClick={() => onControlPaperMonitor('resume')}
                      className="rounded-lg border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
                    >
                      恢復影子運行
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 計算公式與 Gate 規則 */}
          {activeTab === 'formulas' && (
            <div className="space-y-4 text-xs">
              {/* Formula 1: Phase 2 Historical Volume Anomaly */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">
                  1. 歷史量能異常計算公式 (Phase 2 Historical Volume Anomaly)
                </h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 font-mono text-[11px] text-slate-300">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-slate-100">
                      基準樣本與波動率檢核
                    </div>
                    <div>• 取樣窗格：30 根已確認收盤 15m K 線 (isClosed = true)</div>
                    <div>• 指標口徑：quoteVolume (USDT 計價成交額)</div>
                    <div>• Rolling Median = median(V₁ … V₃₀)</div>
                    <div>• MAD = median(|Vᵢ - Rolling Median|)</div>
                    <div>• 穩定度條件：MAD / Rolling Median ≥ 門檻，否則標記 BASELINE_UNSTABLE</div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-slate-100">
                      RVOL、Robust Z-Score 與輔助 PR 區分
                    </div>
                    <div>• RVOL = Current Confirmed 15m QuoteVolume / Rolling Median</div>
                    <div>• Robust Z-Score = 0.6745 × (V_curr - Rolling Median) / MAD</div>
                    <div>• 樣本數 &lt; 30 → INSUFFICIENT_HISTORY（嚴禁以當下值回填）</div>
                    <div>• 24h 成交額百分位 (PR) 僅作輔助排序，不冒充歷史量能異常</div>
                    <div>• 基線未就緒或低流動性時觸發 Score Cap 48 封頂降級</div>
                  </div>
                </div>
              </div>

              {/* Formula 2: Layer 1 Market Radar 96-point Score */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">
                  2. 第一層：全市場雷達評分公式 (總分 96 分與封頂規則)
                </h3>
                <div className="overflow-x-auto border border-slate-800 bg-slate-900/40">
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-2 px-3">評分維度</th>
                        <th className="py-2 px-3">計算依據與門檻</th>
                        <th className="py-2 px-3">安全降級 / 扣分機制</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70 text-slate-300">
                      <tr>
                        <td className="py-2 px-3 font-semibold text-slate-100">
                          histVol (歷史量能異常)
                        </td>
                        <td className="py-2 px-3">
                          依 15m RVOL 與 Robust Z-Score 加權（僅 READY 時給滿分）
                        </td>
                        <td className="py-2 px-3">
                          INSUFFICIENT_HISTORY / BASELINE_UNSTABLE 強制壓低權重並觸發 Cap 48
                        </td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 font-semibold text-slate-100">
                          auxPR (24h 成交額輔助 PR)
                        </td>
                        <td className="py-2 px-3">
                          全市場 24h QuoteVolume 橫斷面百分位排名
                        </td>
                        <td className="py-2 px-3">僅為輔助參考權重</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 font-semibold text-slate-100">
                          momentum (24h 動能)
                        </td>
                        <td className="py-2 px-3">|change24h| ≥ 3.0% 通過動能門檻</td>
                        <td className="py-2 px-3">不足 3.0% 不進入多空觀察</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 font-semibold text-slate-100">
                          relativeBtc (相對 BTC 強弱)
                        </td>
                        <td className="py-2 px-3">
                          同方向超額報酬 |symbol24h - btc24h| ≥ 1.2%
                        </td>
                        <td className="py-2 px-3">未跑贏 BTC 降級為準備觀察</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 font-semibold text-slate-100">
                          fundingRisk / liquidityRisk / dataQuality
                        </td>
                        <td className="py-2 px-3">
                          |Funding| &lt; 0.05% · Vol ≥ $1,500萬 · Spread ≤ 0.3%
                        </td>
                        <td className="py-2 px-3">
                          極端費率或低流動性強制標記高風險並扣分
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Formula 3: Decision Trace 6 Gates & Layer 2 SMC STRICT_PRODUCTION */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">
                  3. 雙層安全閘門與 SMC/ICT 結構判定公式
                </h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 font-mono text-[11px] text-slate-300">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-slate-100">
                      Decision Trace 6 道硬閘門
                    </div>
                    <div>1. history gate：15m 歷史樣本 ≥ 30 根且基線穩定</div>
                    <div>2. liquidity gate：24h Vol ≥ $1,500萬 且盤口 Spread ≤ 0.3%</div>
                    <div>3. momentum gate：|change24h| ≥ 3.0%</div>
                    <div>4. relativeBtc gate：相對 BTC 同向超額報酬 ≥ 1.2%</div>
                    <div>5. funding gate：|FundingRate| &lt; 0.05%（非缺失）</div>
                    <div>6. smc gate：STRICT_PRODUCTION 全套 15m/MTF SMC 結構確認</div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-slate-100">
                      第二層 SMC 狀態機與進場風控規則
                    </div>
                    <div>• PENDING：尚未載入多週期 K 線評估（不等於 WAIT）</div>
                    <div>• WAIT：已評估但尚未形成完整 BOS/MSS + FVG/OB（finalTradeSignal=NONE）</div>
                    <div>• WATCH：已有部分結構或 Near-Miss（差 1~2 項 Gate，不建立 Paper）</div>
                    <div>• HIGH RISK：極端費率、低流動性或 OI/資料異常攔截</div>
                    <div>• LONG / SHORT CANDIDATE：同時通過 MTF (1h/4h) + Liquidity Sweep + BOS/MSS + Displacement + FVG/OB + OI/Funding</div>
                    <div>• 紙上進場嚴禁回溯：僅用下一根 (i+1) 開盤價進場，逾時記為 ENTRY_WINDOW_MISSED；同根觸及 SL/TP 保守判止損</div>
                  </div>
                </div>
              </div>

              {/* Formula 4: Three Scopes & Statistical Identities */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">
                  4. 統計口徑與系統恆等式驗證公式
                </h3>
                <div className="font-mono text-[11px] text-slate-300 space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-3">
                  <div>
                    • 佇列總數恆等式：pendingCount = queuedCount + runningJobCount + waitingForCacheCount + waitingForRateLimitCount + retryScheduledCount + failedRetryableCount
                  </div>
                  <div>
                    • 已完成結果恆等式：SUCCEEDED = WAIT + WATCH + LONG + SHORT + HIGH_RISK（FAILED 不計入 PENDING）
                  </div>
                  <div>
                    • 三種統計口徑嚴格分離：1. CURRENT_CYCLE (當輪週期) / 2. DEDUPED_SYMBOLS (30D/60D/90D 視窗去重標的) / 3. CUMULATIVE_EVENTS (歷史累計事件)，禁止異分母直接比較
                  </div>
                  <div>
                    • 樣本不足誠實原則：無已結算樣本時 WinRate / AverageR / ExpectancyR 必須回傳 null（不補 0），且正式候選為 0 時實盤延遲統計必為 null
                  </div>
                </div>
              </div>

              {/* Formula 5: BTC K-Line Overlap & Coupling Analysis */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">
                  5. 與比特幣 (BTCUSDT) 過去 K 線重合性與連動風險公式（純風險參考，不阻斷現有 Gate）
                </h3>
                <div className="font-mono text-[11px] text-slate-300 space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-3">
                  <div>
                    • 對齊樣本口徑：嚴格取同一 openTime 之已確認收盤 K 線 (isClosed = true)，最多取近 48 根（最少需 ≥ 15 根對齊 K 線才進入 READY 判定）
                  </div>
                  <div>
                    • Pearson 相關係數 (r)：計算相鄰收盤報酬率 r_sym 與 r_btc 之線性相關係數 (-1.00 ~ +1.00)；衡量短線漲跌節奏與波幅同步程度
                  </div>
                  <div>
                    • K 線同向重疊率 / BTC 下跌同步率：統計同向收漲或同向收跌之 K 線佔比 (%)，以及 BTCUSDT 收跌時該幣種同步收跌的比例 (%)
                  </div>
                  <div>
                    • Beta 連動彈性：Cov(r_sym, r_btc) / Var(r_btc)，估算 BTC 波動 1% 時該幣種之平均連動幅度（僅作開單風控提醒，不改寫 6-Gate 與評分）
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-cyan-300">
                  6. 衍生品資金結構（OI × 價格象限 / CVD / 清算流動性池）
                </h3>
                <div className="font-mono text-[11px] text-slate-300 space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-3">
                  <div>
                    • OI × 價格四象限：比較最近 16 筆歷史 OI 與對應價格報酬，區分「多頭主動增倉 (Price↑ OI↑)」、「空頭回補軋空 (Price↑ OI↓)」、「空頭主動增倉 (Price↓ OI↑)」、「多頭平倉殺多 (Price↓ OI↓)」
                  </div>
                  <div>
                    • CVD 累積主動買賣差：嚴格取交易所真實 Taker Buy Quote Volume 與總 Quote Volume 差額 (Buy − Sell) 累積，不對缺失資料虛擬補值
                  </div>
                  <div>
                    • 潛在清算流動性區間：以已確認收盤 Wave High/Low 結合 0.12×ATR14 估算多空止損密集池 (BSL/SSL)
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-emerald-300">
                  7. 交易前倉位風控試算與板塊廣度模型（純輔助試算）
                </h3>
                <div className="font-mono text-[11px] text-slate-300 space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-3">
                  <div>
                    • 名義倉位公式：建議名義倉位 = (帳戶總本金 × 單筆風險%) / (止損距離% + 雙邊費率滑點%)；Net R:R 扣除往返費率後計算
                  </div>
                  <div>
                    • BTC 連帶壓力預警：預估倉位受 BTC 突變 ±1% 波動 = 名義倉位 × |Beta_15m| × 1%
                  </div>
                  <div>
                    • 全市場廣度與板塊輪動：統計紅盤佔比、中位漲跌幅與 8 大板塊成交額比重（零額外 API 請求）
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-2">
                <h3 className="text-sm font-semibold text-violet-300">
                  8. 期現基差、盤口深度滑點、關鍵時間錨點與本地告警公式
                </h3>
                <div className="font-mono text-[11px] text-slate-300 space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-3">
                  <div>
                    • 期現基差 (Basis%)：(合約最新價 − 現貨價格) / 現貨價格 × 100%；合約/現貨量比 = Perp 24h QuoteVol / Spot 24h QuoteVol（查無對應現貨時誠實回傳 UNAVAILABLE）
                  </div>
                  <div>
                    • 盤口失衡 (OBI) 與滑點模擬：統計 ±0.5% / ±1.0% 深度美元總額，OBI = (Bid − Ask) / (Bid + Ask) × 100%；單檔掛單 ≥ 2.5× 中位數且 ≥ $10k 標記為巨鯨牆；市價滑點逐檔吃單計算加權均價偏離中間價之 bps
                  </div>
                  <div>
                    • 日內關鍵位與錨定 VWAP：由已收盤 1h / 4h / 主週期 K 線計算 UTC 前日高點 (PDH)、前日低點 (PDL)、日線開盤 (DO)、週一 00:00 UTC 開盤 (WO) 與日內成交額加權 VWAP ±1σ
                  </div>
                  <div>
                    • 本地條件告警引擎：純瀏覽器 localStorage 持久化，於行情更新時比對價格/OB/FVG/費率/BTC 波動，僅觸發本地提醒，絕不下單
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: 漏斗與工程遙測 */}
          {activeTab === 'telemetry' && (
            <div className="space-y-4">
              {/* Phase 18.2 Notices & Snapshot Consistency */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                  <span className="rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-0.5 text-emerald-300">
                    {smcCandTotal === 0
                      ? '目前週期沒有正式候選'
                      : `目前週期有 ${smcCandTotal} 檔正式候選`}
                  </span>
                  <span className="rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-2.5 py-0.5 text-rose-300">
                    歷史上曾有候選但錯過進場
                  </span>
                  <span className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-0.5 text-amber-300">
                    Near-Miss 不等於正式訊號
                  </span>
                  <span className="rounded-md border border-sky-500/25 bg-sky-500/[0.06] px-2.5 py-0.5 text-sky-300">
                    Radar Long/Short 不等於 SMC Long/Short
                  </span>
                  <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-slate-300">
                    PENDING 不等於 WAIT
                  </span>
                  <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-slate-300">
                    WAIT/WATCH 不會建立 Paper 交易
                  </span>
                </div>

                {/* 7-Stage Funnel */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                    <span className="font-semibold text-slate-200">
                      完整訊號漏斗追蹤：Radar 觀察 → SMC 已評估 → Near-Miss → 正式 SMC 候選 → Paper Eligible → Paper Opened → Paper Closed
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      ENTRY_WINDOW_MISSED: {missedWindow} · BLOCKED:{' '}
                      {blockedByPaper}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 font-mono text-xs">
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                      <div className="font-sans text-[11px] text-slate-400">
                        1. 第一層雷達觀察
                      </div>
                      <div className="mt-1 text-base font-bold text-slate-100">
                        {(scanData?.marketRadarLongCount ?? 0) +
                          (scanData?.marketRadarShortCount ?? 0)}{' '}
                        檔
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                      <div className="font-sans text-[11px] text-slate-400">
                        2. 第二層 SMC 已評估
                      </div>
                      <div className="mt-1 text-base font-bold text-sky-400">
                        {funnel?.smcEvaluatedCount ??
                          (scanData?.totalContractsScanned ?? 0) -
                            (scanData?.smcPendingCount ?? 0)}{' '}
                        / {scanData?.totalContractsScanned ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-2.5">
                      <div className="font-sans text-[11px] text-amber-300">
                        3. Near-Miss (差1~2項)
                      </div>
                      <div className="mt-1 text-base font-bold text-amber-400">
                        {nearMissTotal} 檔
                      </div>
                      <div className="text-[10px] text-amber-300/80">
                        差1項:{nearMiss1} · 差2項:{nearMiss2}
                      </div>
                    </div>
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-2.5">
                      <div className="font-sans text-[11px] text-emerald-300">
                        3. SMC 候選 (正式)
                      </div>
                      <div className="mt-1 text-base font-bold text-emerald-400">
                        {smcCandTotal} 檔
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                      <div className="font-sans text-[11px] text-slate-400">
                        4. Paper 合格訊號
                      </div>
                      <div className="mt-1 text-base font-bold text-amber-400">
                        {eligiblePaper} 檔
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                      <div className="font-sans text-[11px] text-slate-400">
                        5. 已錯過進場窗口
                      </div>
                      <div className="mt-1 text-base font-bold text-rose-300">
                        {missedWindow} 檔
                      </div>
                      <div className="text-[10px] text-emerald-400">
                        已開倉: {paperOpened}
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                      <div className="font-sans text-[11px] text-slate-400">
                        7. Paper Closed
                      </div>
                      <div className="mt-1 text-base font-bold text-slate-100">
                        {paperClosed} 檔
                      </div>
                    </div>
                  </div>
                </div>

                {/* Near-Miss & Root Cause Shadow Summary */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-[11px] font-mono">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-amber-300">
                      Near-Miss 觀察清單 ({nearMissTotal} 檔)
                    </div>
                    {(gateDiag?.nearMissSymbols ?? []).slice(0, 5).map((g) => (
                      <button
                        key={g.symbol}
                        type="button"
                        onClick={() => {
                          onSelectSymbolDetail(g.symbol);
                          onClose();
                        }}
                        className="w-full text-left flex items-center justify-between border-b border-slate-800/60 py-1 hover:text-amber-300 cursor-pointer"
                      >
                        <span>
                          {g.symbol} ({g.intendedDirection ?? 'NEUTRAL'}) · 缺{' '}
                          {g.missingGates?.join(', ') || 'NONE'}
                        </span>
                        <span className="text-slate-400">評分 {g.score ?? 0}</span>
                      </button>
                    ))}
                    {(gateDiag?.nearMissSymbols?.length ?? 0) === 0 && (
                      <div className="text-slate-400">
                        目前無差 1~2 項條件之 Near-Miss 標的
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1">
                    <div className="font-sans font-semibold text-sky-300">
                      無正式候選根因與 STRICT vs SHADOW 對照
                    </div>
                    <div>
                      根因診斷:{' '}
                      <strong className="text-amber-300">
                        {scanData?.rootCauseVerdict ??
                          smcScanStatus?.rootCauseVerdict ??
                          'STRICT_GATE_NO_CURRENT_SIGNAL'}
                      </strong>
                    </div>
                    {scopedStats && (
                      <div>
                        ALL_EVALUATED (n={scopedStats.allEvaluatedDenominator}):
                        MTF {scopedStats.allEvaluated.MTF_ALIGNMENT?.passRate ?? 0}% ·
                        BOS/MSS {scopedStats.allEvaluated.BOS_MSS?.passRate ?? 0}% ·
                        DISP {scopedStats.allEvaluated.DISPLACEMENT?.passRate ?? 0}%
                      </div>
                    )}
                    {shadowComp && (
                      <div>
                        STRICT: {shadowComp.strictProduction.candidateCount} ·
                        SHADOW(-1):{' '}
                        {shadowComp.observationShadowOneGateMissing.candidateCount}{' '}
                        · SHADOW(-2):{' '}
                        {shadowComp.observationShadowTwoGatesMissing.candidateCount}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Full-Market Gate & Reason Statistics */}
              <div className="border border-slate-800 bg-slate-950/90 px-4 py-3 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
                  <span className="font-semibold text-slate-200">
                    全市場雙層雷達與安全閘門統計 (總掃描合約:{' '}
                    {scanData?.totalContractsScanned ?? 0} · 市場雷達候選數量:{' '}
                    {(scanData?.marketRadarLongCount ?? 0) +
                      (scanData?.marketRadarShortCount ?? 0)}{' '}
                    · SMC PENDING (尚未評估): {scanData?.smcPendingCount ?? 0} ·
                    SMC LONG CANDIDATE 數量:{' '}
                    {scanData?.smcLongCandidateCount ?? 0} · SMC SHORT CANDIDATE
                    數量: {scanData?.smcShortCandidateCount ?? 0} · WATCH 數量:{' '}
                    {scanData?.smcWatchCount ?? 0} · WAIT 數量 (已評估):{' '}
                    {scanData?.smcWaitCount ?? 0} · HIGH RISK (已評估):{' '}
                    {scanData?.smcHighRiskCount ?? 0} · SMC_GATE_NOT_CONFIRMED
                    (僅計已評估): {scanData?.smcGateNotConfirmedCount ?? 0})
                  </span>
                  <button
                    type="button"
                    onClick={onRefreshScan}
                    className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                  >
                    同步快照
                  </button>
                </div>

                {scanData?.waitWatchReasonStats && (
                  <div className="text-[11px] font-mono text-slate-400 space-y-1">
                    <div>
                      <span className="text-slate-300 font-semibold">
                        waitWatchReasonStats [WAIT + WATCH]：
                      </span>
                      不重複幣種數 (uniqueSymbolCount)=
                      <strong className="text-slate-200">
                        {scanData.waitWatchReasonStats.uniqueSymbolCount}
                      </strong>{' '}
                      · 可重疊原因總次數 (totalReasonOccurrences)=
                      <strong className="text-amber-300">
                        {scanData.waitWatchReasonStats.totalReasonOccurrences}
                      </strong>
                    </div>
                    {scanData.nonCandidateReasonStats && (
                      <div>
                        <span className="text-slate-300 font-semibold">
                          nonCandidateReasonStats [全部非候選]：
                        </span>
                        uniqueSymbolCount=
                        <strong className="text-slate-200">
                          {scanData.nonCandidateReasonStats.uniqueSymbolCount}
                        </strong>{' '}
                        · totalReasonOccurrences=
                        <strong className="text-amber-300">
                          {
                            scanData.nonCandidateReasonStats
                              .totalReasonOccurrences
                          }
                        </strong>
                      </div>
                    )}
                    {scanData.radarGateReasonStats && (
                      <div>
                        <span className="text-slate-300 font-semibold">
                          第一層雷達閘門降級統計：
                        </span>
                        uniqueSymbolCount=
                        <strong className="text-slate-200">
                          {scanData.radarGateReasonStats.uniqueSymbolCount}
                        </strong>{' '}
                        · totalReasonOccurrences=
                        <strong className="text-sky-300">
                          {scanData.radarGateReasonStats.totalReasonOccurrences}
                        </strong>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Phase 17 System Stability Summary */}
              <SystemStabilityPanel
                systemDbHealth={systemDbHealth}
                activeSmc={activeSmc}
                dbCheckLoading={dbCheckLoading}
                onRunSystemDbCheck={onRunSystemDbCheck}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
