import React from 'react';
import { formatTaipeiTime } from '../utils/taipeiTime.ts';
import { Clock, Play, RefreshCw, Search, Square } from 'lucide-react';
import {
  AutoBacktestStatusResponse,
  BacktestTriggerSource,
  ExchangeId,
  Timeframe,
} from '../types/market.ts';

interface AutoBacktestControlPanelProps {
  status: AutoBacktestStatusResponse | null;
  loading: boolean;
  watchlistCount: number;
  dataMode: 'live' | 'demo';
  selectedExchange: ExchangeId;
  sourceFilter: 'ALL' | BacktestTriggerSource;
  searchQuery: string;
  onChangeSourceFilter: (filter: 'ALL' | BacktestTriggerSource) => void;
  onChangeSearchQuery: (query: string) => void;
  onUpdateConfig: (patch: {
    enabled?: boolean;
    intervalMs?: number;
    timeframe?: Timeframe;
    maxSymbolsPerRun?: number;
    includeWatchlist?: boolean;
    exchange?: ExchangeId;
  }) => void;
  onRunNow: () => void;
}

const INTERVAL_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: '15 分鐘', ms: 15 * 60_000 },
  { label: '1 小時', ms: 60 * 60_000 },
  { label: '4 小時', ms: 4 * 60 * 60_000 },
  { label: '12 小時', ms: 12 * 60 * 60_000 },
];

export const AutoBacktestControlPanel: React.FC<
  AutoBacktestControlPanelProps
> = ({
  status,
  loading,
  watchlistCount,
  dataMode,
  selectedExchange,
  sourceFilter,
  searchQuery,
  onChangeSourceFilter,
  onChangeSearchQuery,
  onUpdateConfig,
  onRunNow,
}) => {
  const cfg = status?.config;
  const enabled = cfg?.enabled ?? false;
  const running = status?.running ?? false;
  const executing = status?.executingBatch ?? false;
  const latestBatch = status?.recentBatches?.[0] ?? null;

  return (
    <div id="auto-backtest-panel" className="space-y-3">
      <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>自動排程回測紀錄 (Auto-Backtest Recorder)</span>
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>
                狀態:{' '}
                <strong
                  className={
                    running ? 'text-emerald-400' : 'text-slate-300'
                  }
                >
                  {running ? '排程運作中' : '已暫停'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>優先覆蓋自選清單與當期高分候選</span>
              <span aria-hidden="true">·</span>
              <span>同一閉合 K 線不重複重跑</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onUpdateConfig({
                  enabled: !enabled,
                  exchange:
                    selectedExchange === 'demo_synthetic'
                      ? 'binance_usdm'
                      : selectedExchange,
                })
              }
              disabled={loading}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 ${
                enabled
                  ? 'border border-rose-500/40 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50'
                  : 'border border-emerald-500/40 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50'
              }`}
            >
              {enabled ? (
                <>
                  <Square className="h-3 w-3 shrink-0" />
                  <span>暫停自動排程</span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 shrink-0" />
                  <span>啟用自動排程</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onRunNow}
              disabled={loading || executing}
              className="flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 shrink-0 ${
                  loading || executing ? 'animate-spin' : ''
                }`}
              />
              <span>
                {loading || executing
                  ? '批次執行中...'
                  : `立即執行一輪自動回測 (${dataMode === 'demo' ? 'DEMO' : 'LIVE'})`}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1 border-t border-slate-800/80 text-xs">
          <label className="flex items-center justify-between gap-2 border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="text-slate-400 whitespace-nowrap">排程間隔</span>
            <select
              value={cfg?.intervalMs ?? 3_600_000}
              disabled={loading}
              onChange={(e) =>
                onUpdateConfig({ intervalMs: Number(e.target.value) })
              }
              className="bg-slate-950 border border-slate-700 px-2 py-1 text-xs font-mono tabular-nums text-slate-100 rounded"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="text-slate-400 whitespace-nowrap">回測週期</span>
            <select
              value={cfg?.timeframe ?? '15m'}
              disabled={loading}
              onChange={(e) =>
                onUpdateConfig({ timeframe: e.target.value as Timeframe })
              }
              className="bg-slate-950 border border-slate-700 px-2 py-1 text-xs font-mono text-slate-100 rounded"
            >
              {(['5m', '15m', '1h', '4h'] as Timeframe[]).map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="text-slate-400 whitespace-nowrap">每輪上限</span>
            <select
              value={cfg?.maxSymbolsPerRun ?? 15}
              disabled={loading}
              onChange={(e) =>
                onUpdateConfig({ maxSymbolsPerRun: Number(e.target.value) })
              }
              className="bg-slate-950 border border-slate-700 px-2 py-1 text-xs font-mono tabular-nums text-slate-100 rounded"
            >
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n} 檔
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onUpdateConfig({
                includeWatchlist: !(cfg?.includeWatchlist ?? true),
              })
            }
            className="flex items-center justify-between gap-2 border border-slate-800 bg-slate-900/40 px-3 py-2 text-left hover:border-slate-700 cursor-pointer"
          >
            <span className="text-slate-400 whitespace-nowrap">
              自選連動 ({watchlistCount})
            </span>
            <span
              className={`font-mono font-semibold whitespace-nowrap ${
                cfg?.includeWatchlist ?? true
                  ? 'text-emerald-400'
                  : 'text-slate-500'
              }`}
            >
              {cfg?.includeWatchlist ?? true ? '已納入' : '未納入'}
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono tabular-nums text-slate-400">
          {latestBatch ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-300 font-semibold">
                最新批次 [{latestBatch.status}]
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {formatTaipeiTime(latestBatch.startedAt)} 台北
              </span>
              <span aria-hidden="true">·</span>
              <span>{latestBatch.note}</span>
              <span aria-hidden="true">·</span>
              <span>耗時 {(latestBatch.durationMs / 1000).toFixed(1)}s</span>
            </div>
          ) : (
            <span>
              尚無自動回測批次紀錄；開啟排程或點擊「立即執行一輪自動回測」即可自動存檔。
            </span>
          )}
          {status?.nextRunAt && (
            <span className="text-sky-300">
              下次排程:{' '}
              {formatTaipeiTime(status.nextRunAt)} 台北
            </span>
          )}
        </div>
      </div>

      {/* Persisted Backtest Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded border border-slate-800 bg-slate-950 p-1">
          {(
            [
              { key: 'ALL', label: '全部來源' },
              { key: 'AUTO_SCHEDULED', label: '自動排程' },
              { key: 'MANUAL', label: '手動執行' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onChangeSourceFilter(item.key)}
              className={`rounded px-2.5 py-1 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                sourceFilter === item.key
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
            placeholder="篩選回測幣種 (如 BTC)"
            className="rounded border border-slate-800 bg-slate-950 pl-8 pr-3 py-1.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
};
