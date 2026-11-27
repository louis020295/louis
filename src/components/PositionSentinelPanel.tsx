import React, { useMemo, useState } from 'react';
import { formatTaipeiDateTime, formatTaipeiTime } from '../utils/taipeiTime.ts';
import {
  Activity,
  AlertTriangle,
  Bell,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  ExchangeId,
  PositionHealthState,
  PositionSentinelAlertSeverity,
  PositionSentinelConfig,
  PositionSentinelSnapshot,
  PositionSentinelStatusResponse,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../types/market.ts';

export interface AddPositionSentinelInput {
  symbol: string;
  exchange: ExchangeId;
  side: 'LONG' | 'SHORT';
  timeframe: Timeframe;
  entryPrice: number;
  invalidationPrice: number;
  targetPrice: number | null;
  leverage: number;
  notes: string;
}

export interface UpdatePositionSentinelPatch {
  invalidationPrice?: number;
  targetPrice?: number | null;
  leverage?: number;
  paused?: boolean;
  active?: boolean;
  notes?: string;
  syncPaperLedger?: boolean;
}

interface PositionSentinelPanelProps {
  status: PositionSentinelStatusResponse | null;
  loading: boolean;
  selectedExchange: ExchangeId;
  availableSymbols: string[];
  defaultSymbol?: string;
  defaultPrice?: number | null;
  onRefreshCheck: () => Promise<void>;
  onImportPaper: () => Promise<void>;
  onAddPosition: (input: AddPositionSentinelInput) => Promise<void>;
  onUpdatePosition: (
    id: string,
    patch: UpdatePositionSentinelPatch
  ) => Promise<void>;
  onDeletePosition: (id: string) => Promise<void>;
  onUpdateConfig: (patch: Partial<PositionSentinelConfig>) => Promise<void>;
  onSelectSymbol?: (symbol: string) => void;
}

const EXCHANGE_LABEL: Record<ExchangeId, string> = {
  binance_usdm: 'Binance USDⓈ-M',
  bybit_linear: 'Bybit Linear',
  bingx_swap: 'BingX Swap',
  demo_synthetic: 'Demo Synthetic',
};

const HEALTH_STYLE: Record<
  PositionHealthState,
  { label: string; textClass: string; borderClass: string; bgClass: string }
> = {
  TREND_INTACT: {
    label: '趨勢延續',
    textClass: 'text-emerald-300',
    borderClass: 'border-emerald-500/40',
    bgClass: 'bg-emerald-500/10',
  },
  MOMENTUM_FADING: {
    label: '動能轉弱',
    textClass: 'text-amber-300',
    borderClass: 'border-amber-500/40',
    bgClass: 'bg-amber-500/10',
  },
  EARLY_REVERSAL: {
    label: '早期反轉',
    textClass: 'text-orange-300',
    borderClass: 'border-orange-500/50',
    bgClass: 'bg-orange-500/10',
  },
  THESIS_BROKEN: {
    label: '結構失效',
    textClass: 'text-rose-300',
    borderClass: 'border-rose-500/50',
    bgClass: 'bg-rose-500/15',
  },
};

function fmtPrice(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  if (Math.abs(val) >= 1000) {
    return val.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (Math.abs(val) >= 1) return val.toFixed(4);
  if (Math.abs(val) >= 0.01) return val.toFixed(5);
  return val.toPrecision(4);
}

function fmtPct(val: number | null | undefined, signed = true): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const sign = signed && val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

function microStateLabel(state: PositionSentinelSnapshot['micro5mState']): string {
  if (state === 'ALIGNED') return '5m 順向維持';
  if (state === 'TESTING_SWING') return '5m 盤中試探前極值';
  if (state === 'ADVERSE_CHOCH') return '5m 收盤跌/突破反轉';
  return '5m 資料待補';
}

function structure15mLabel(
  state: PositionSentinelSnapshot['structure15mState']
): string {
  if (state === 'ALIGNED') return '15m 趨勢延續';
  if (state === 'WEAKENING') return '15m 動能趨緩';
  if (state === 'REVERSED') return '15m 結構反轉';
  return '15m 資料待補';
}

export const PositionSentinelPanel: React.FC<PositionSentinelPanelProps> = ({
  status,
  loading,
  selectedExchange,
  availableSymbols,
  defaultSymbol,
  defaultPrice,
  onRefreshCheck,
  onImportPaper,
  onAddPosition,
  onUpdatePosition,
  onDeletePosition,
  onUpdateConfig,
  onSelectSymbol,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<
    'ALL' | PositionSentinelAlertSeverity
  >('ALL');
  const [editingSlId, setEditingSlId] = useState<string | null>(null);
  const [editingSlValue, setEditingSlValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const fallbackExchange: ExchangeId =
    selectedExchange === 'demo_synthetic' ? 'binance_usdm' : selectedExchange;

  const [formSymbol, setFormSymbol] = useState(defaultSymbol || 'BTCUSDT');
  const [formExchange, setFormExchange] =
    useState<ExchangeId>(fallbackExchange);
  const [formSide, setFormSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [formTimeframe, setFormTimeframe] = useState<Timeframe>('15m');
  const [formEntryPrice, setFormEntryPrice] = useState(
    defaultPrice ? String(defaultPrice) : ''
  );
  const [formInvalidationPrice, setFormInvalidationPrice] = useState('');
  const [formTargetPrice, setFormTargetPrice] = useState('');
  const [formLeverage, setFormLeverage] = useState('1');
  const [formNotes, setFormNotes] = useState('');

  const positions = status?.positions ?? [];
  const alerts = status?.recentAlerts ?? [];
  const cfg = status?.config;
  const summary = status?.summary ?? {
    totalTracked: 0,
    intactCount: 0,
    fadingCount: 0,
    earlyReversalCount: 0,
    thesisBrokenCount: 0,
  };

  const filteredAlerts = useMemo(() => {
    if (severityFilter === 'ALL') return alerts;
    return alerts.filter((a) => a.severity === severityFilter);
  }, [alerts, severityFilter]);

  const openAddFormWithDefaults = () => {
    const sym = (defaultSymbol || 'BTCUSDT').toUpperCase();
    setFormSymbol(sym);
    setFormExchange(
      selectedExchange === 'demo_synthetic' ? 'binance_usdm' : selectedExchange
    );
    if (defaultPrice && Number.isFinite(defaultPrice) && defaultPrice > 0) {
      setFormEntryPrice(String(defaultPrice));
      const sl =
        formSide === 'LONG'
          ? Number((defaultPrice * 0.985).toPrecision(6))
          : Number((defaultPrice * 1.015).toPrecision(6));
      const tp =
        formSide === 'LONG'
          ? Number((defaultPrice * 1.03).toPrecision(6))
          : Number((defaultPrice * 0.97).toPrecision(6));
      setFormInvalidationPrice(String(sl));
      setFormTargetPrice(String(tp));
    }
    setFormError(null);
    setShowAddForm((prev) => !prev);
  };

  const handleSubmitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const symbol = formSymbol.trim().toUpperCase();
    const entry = Number(formEntryPrice);
    const inv = Number(formInvalidationPrice);
    const tp = formTargetPrice.trim() ? Number(formTargetPrice) : null;
    const lev = Number(formLeverage) || 1;

    if (!/^[A-Z0-9]{2,24}$/.test(symbol)) {
      setFormError('標的代號格式無效，例：BTCUSDT');
      return;
    }
    if (!Number.isFinite(entry) || entry <= 0) {
      setFormError('進場價格必須大於 0');
      return;
    }
    if (!Number.isFinite(inv) || inv <= 0) {
      setFormError('防守止損位 (SL) 必須大於 0');
      return;
    }
    if (formSide === 'LONG' && inv >= entry) {
      setFormError('做多持倉的防守止損位 (SL) 必須低於進場價');
      return;
    }
    if (formSide === 'SHORT' && inv <= entry) {
      setFormError('做空持倉的防守止損位 (SL) 必須高於進場價');
      return;
    }
    if (tp !== null && (!Number.isFinite(tp) || tp <= 0)) {
      setFormError('目標價若填寫必須為大於 0 的數字');
      return;
    }

    await onAddPosition({
      symbol,
      exchange: formExchange,
      side: formSide,
      timeframe: formTimeframe,
      entryPrice: entry,
      invalidationPrice: inv,
      targetPrice: tp,
      leverage: Math.max(1, Math.min(125, lev)),
      notes: formNotes.trim(),
    });
    setShowAddForm(false);
    setFormNotes('');
  };

  return (
    <section
      id="position-sentinel-panel"
      className="order-3 space-y-5 border border-slate-800 bg-slate-950/90 p-5"
    >
      {/* Header & Primary Controls */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
            <h2 className="text-base font-bold text-slate-100">
              持倉趨勢即時守護哨兵 (Position Sentinel)
            </h2>
            <span className="font-mono text-[11px] text-amber-300">
              {TRADING_SAFETY_FLAGS.mode} · 僅監控預警，絕不自動下單平倉
            </span>
          </div>
          <p className="text-xs text-slate-400">
            獨立於全市場掃描佇列的 P0 快速監控通道：結合交易所公開即時串流與 3
            層反轉偵測（1m/3m ATR 急殺、5m 微結構 CHoCH/FVG/RVOL 與 OI
            背離、15m/1h 主結構），在趨勢轉弱前即時通知並計算移動防守價。
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-400">
            <span>
              監控狀態:{' '}
              <strong
                className={
                  cfg?.enabled !== false ? 'text-emerald-300' : 'text-slate-400'
                }
              >
                {cfg?.enabled !== false ? '監控運作中' : '已暫停'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              WebSocket 即時串流:{' '}
              <strong className="text-sky-300">
                {(status?.wsConnectedExchanges ?? []).length > 0
                  ? status?.wsConnectedExchanges
                      .map((ex) => EXCHANGE_LABEL[ex] ?? ex)
                      .join(' / ')
                  : cfg?.wsStreamEnabled
                    ? '待機 / REST 快速輪詢備援'
                    : '停用 (僅 REST)'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              輪詢週期: {Math.round((cfg?.pollIntervalMs ?? 15000) / 1000)}s
            </span>
            <span aria-hidden="true">·</span>
            <span>
              最近檢查:{' '}
              {status?.lastCycleAt
                ? formatTaipeiTime(status.lastCycleAt)
                : '尚未執行'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={loading}
            onClick={() => void onRefreshCheck()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>立即檢查</span>
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void onImportPaper()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            <span>同步紙上 OPEN 持倉</span>
          </button>
          <button
            type="button"
            onClick={openAddFormWithDefaults}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新增追蹤持倉</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
              showSettings
                ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-slate-100'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>哨兵參數設定</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
          <div className="text-[11px] text-slate-400">守護中持倉</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-100">
            {summary.totalTracked}
          </div>
        </div>
        <div className="border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
          <div className="text-[11px] text-emerald-300">趨勢延續</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-300">
            {summary.intactCount}
          </div>
        </div>
        <div className="border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
          <div className="text-[11px] text-amber-300">動能轉弱</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-amber-300">
            {summary.fadingCount}
          </div>
        </div>
        <div className="border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
          <div className="text-[11px] text-orange-300">早期反轉預警</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-orange-300">
            {summary.earlyReversalCount}
          </div>
        </div>
        <div className="border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
          <div className="text-[11px] text-rose-300">結構失效</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-rose-300">
            {summary.thesisBrokenCount}
          </div>
        </div>
      </div>

      {/* Add Tracked Position Form */}
      {showAddForm && (
        <form
          onSubmit={(e) => void handleSubmitAdd(e)}
          className="border border-amber-500/40 bg-slate-900/60 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-amber-200">
              新增手動守護持倉 (若於實盤手動進場，可在此填入進場價與止損防守線即時守護)
            </h3>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              關閉
            </button>
          </div>
          {formError && (
            <div className="border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                交易對
              </label>
              <input
                type="text"
                list="sentinel-symbol-list"
                value={formSymbol}
                onChange={(e) => setFormSymbol(e.target.value.toUpperCase())}
                placeholder="BTCUSDT"
                className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              />
              <datalist id="sentinel-symbol-list">
                {availableSymbols.slice(0, 120).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                交易所
              </label>
              <select
                value={formExchange}
                onChange={(e) => setFormExchange(e.target.value as ExchangeId)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="binance_usdm">Binance USDⓈ-M</option>
                <option value="bybit_linear">Bybit Linear</option>
                <option value="bingx_swap">BingX Swap</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                持倉方向
              </label>
              <select
                value={formSide}
                onChange={(e) =>
                  setFormSide(e.target.value === 'SHORT' ? 'SHORT' : 'LONG')
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="LONG">做多 LONG</option>
                <option value="SHORT">做空 SHORT</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                基準週期
              </label>
              <select
                value={formTimeframe}
                onChange={(e) =>
                  setFormTimeframe(e.target.value as Timeframe)
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="4h">4h</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                進場價 (Entry)
              </label>
              <input
                type="number"
                step="any"
                required
                value={formEntryPrice}
                onChange={(e) => setFormEntryPrice(e.target.value)}
                placeholder="65000"
                className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                防守止損位 (SL)
              </label>
              <input
                type="number"
                step="any"
                required
                value={formInvalidationPrice}
                onChange={(e) => setFormInvalidationPrice(e.target.value)}
                placeholder="64000"
                className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                目標位 (選填)
              </label>
              <input
                type="number"
                step="any"
                value={formTargetPrice}
                onChange={(e) => setFormTargetPrice(e.target.value)}
                placeholder="67500"
                className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                槓桿 (顯示換算)
              </label>
              <input
                type="number"
                min={1}
                max={125}
                value={formLeverage}
                onChange={(e) => setFormLeverage(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder="備註進場依據 (例：15m OB 回踩確認多單)"
              className="flex-1 min-w-[220px] rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
            >
              啟動哨兵守護
            </button>
          </div>
        </form>
      )}

      {/* Sentinel Parameters & Notification Routing Panel */}
      {showSettings && cfg && (
        <div className="border border-slate-800 bg-slate-900/50 p-4 space-y-3 text-xs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span className="font-semibold text-slate-200">
              哨兵監控門檻與外部推播開關 (Discord / Telegram 沿用後端環境變數金鑰)
            </span>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              收起
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <label className="flex items-center gap-2 cursor-pointer text-slate-200">
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) =>
                  void onUpdateConfig({ enabled: e.target.checked })
                }
              />
              <span>啟用哨兵背景排程</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-slate-200">
              <input
                type="checkbox"
                checked={cfg.autoSyncPaperLedger}
                onChange={(e) =>
                  void onUpdateConfig({
                    autoSyncPaperLedger: e.target.checked,
                  })
                }
              />
              <span>自動同步紙上已成交單</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-slate-200">
              <input
                type="checkbox"
                checked={cfg.wsStreamEnabled}
                onChange={(e) =>
                  void onUpdateConfig({ wsStreamEnabled: e.target.checked })
                }
              />
              <span>啟用即時 WebSocket</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-slate-200">
              <input
                type="checkbox"
                checked={cfg.notifyDiscord}
                onChange={(e) =>
                  void onUpdateConfig({ notifyDiscord: e.target.checked })
                }
              />
              <span>Discord 異常警報</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-slate-200">
              <input
                type="checkbox"
                checked={cfg.notifyTelegram}
                onChange={(e) =>
                  void onUpdateConfig({ notifyTelegram: e.target.checked })
                }
              />
              <span>Telegram 異常警報</span>
            </label>
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                最低推播層級
              </span>
              <select
                value={cfg.notifyMinSeverity}
                onChange={(e) =>
                  void onUpdateConfig({
                    notifyMinSeverity:
                      e.target.value === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
              >
                <option value="WARNING">WARNING + CRITICAL</option>
                <option value="CRITICAL">僅 CRITICAL 緊急</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-1">
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                檢查週期
              </span>
              <select
                value={cfg.pollIntervalMs}
                onChange={(e) =>
                  void onUpdateConfig({
                    pollIntervalMs: Number(e.target.value),
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100"
              >
                <option value={5000}>5 秒 (極速)</option>
                <option value={15000}>15 秒 (預設)</option>
                <option value={30000}>30 秒</option>
                <option value={60000}>60 秒</option>
              </select>
            </div>
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                1m 異動 ATR 倍數
              </span>
              <select
                value={cfg.atrShockMultiplier}
                onChange={(e) =>
                  void onUpdateConfig({
                    atrShockMultiplier: Number(e.target.value),
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100"
              >
                <option value={1.0}>1.0x ATR (敏銳)</option>
                <option value={1.5}>1.5x ATR (預設)</option>
                <option value={2.0}>2.0x ATR (嚴格)</option>
              </select>
            </div>
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                5m 反向爆量門檻
              </span>
              <select
                value={cfg.rvolSpikeThreshold}
                onChange={(e) =>
                  void onUpdateConfig({
                    rvolSpikeThreshold: Number(e.target.value),
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100"
              >
                <option value={2.0}>2.0x RVOL</option>
                <option value={2.5}>2.5x RVOL (預設)</option>
                <option value={3.5}>3.5x RVOL</option>
              </select>
            </div>
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                防線逼近警示距離
              </span>
              <select
                value={cfg.stopProximityPct}
                onChange={(e) =>
                  void onUpdateConfig({
                    stopProximityPct: Number(e.target.value),
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100"
              >
                <option value={0.5}>0.5%</option>
                <option value={0.8}>0.8% (預設)</option>
                <option value={1.5}>1.5%</option>
              </select>
            </div>
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">
                同事件推播冷卻
              </span>
              <select
                value={cfg.alertCooldownMs}
                onChange={(e) =>
                  void onUpdateConfig({
                    alertCooldownMs: Number(e.target.value),
                  })
                }
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100"
              >
                <option value={180000}>3 分鐘 (升級穿透)</option>
                <option value={300000}>5 分鐘 (預設)</option>
                <option value={600000}>10 分鐘</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Active Tracked Positions */}
      {positions.length === 0 ? (
        <div className="border border-dashed border-slate-800 bg-slate-900/20 p-8 text-center space-y-2">
          <div className="text-sm font-medium text-slate-200">
            目前尚無守護中的進場持倉
          </div>
          <p className="text-xs text-slate-400 max-w-xl mx-auto">
            當您在「紙上交易帳本」有已成交 (FILLED) 的進行中持倉時系統會自動同步守護，或可點擊上方「新增追蹤持倉」手動輸入實際進場價與止損防線。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {positions.map((pos) => {
            const health = HEALTH_STYLE[pos.healthState];
            const isEditingSl = editingSlId === pos.id;
            return (
              <div
                key={pos.id}
                className={`border ${health.borderClass} bg-slate-900/45 p-4 space-y-3`}
              >
                {/* Row 1: Symbol + Health State */}
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectSymbol?.(pos.symbol)}
                        className="font-mono text-base font-bold text-slate-100 hover:text-amber-300 cursor-pointer"
                        title="切換至看盤與結構圖表"
                      >
                        {pos.symbol}
                      </button>
                      <span
                        className={`font-mono text-xs font-bold ${
                          pos.side === 'LONG'
                            ? 'text-emerald-300'
                            : 'text-rose-300'
                        }`}
                      >
                        {pos.side === 'LONG' ? '做多 LONG' : '做空 SHORT'}
                      </span>
                      <span className="text-xs text-slate-500">·</span>
                      <span className="font-mono text-xs text-slate-300">
                        {EXCHANGE_LABEL[pos.exchange] ?? pos.exchange} ·{' '}
                        {pos.timeframe}
                      </span>
                      {pos.leverage > 1 && (
                        <>
                          <span className="text-xs text-slate-500">·</span>
                          <span className="font-mono text-xs text-amber-300">
                            {pos.leverage}x
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400">
                      <span>
                        {pos.sourceType === 'PAPER_LEDGER'
                          ? `紙上帳本同步 #${pos.paperLedgerId}`
                          : '手動進場追蹤'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>報價來源: {pos.markSource}</span>
                      {pos.paused && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-300 font-semibold">
                            已暫停輪詢
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div
                    className={`border ${health.borderClass} ${health.bgClass} px-3 py-1 text-right shrink-0`}
                  >
                    <div
                      className={`text-xs font-bold ${health.textClass}`}
                    >
                      {health.label} ({pos.healthScore}/100)
                    </div>
                    <div className="font-mono text-[10px] text-slate-300 tabular-nums">
                      {pos.healthState}
                    </div>
                  </div>
                </div>

                {/* Row 2: Key Price & PnL Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] text-slate-400">
                      進場價 / 現價
                    </div>
                    <div className="mt-0.5 text-slate-100">
                      ${fmtPrice(pos.entryPrice)} →{' '}
                      <strong>${fmtPrice(pos.currentPrice)}</strong>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      未實現盈虧 (R / %)
                    </div>
                    <div
                      className={`mt-0.5 font-bold ${
                        pos.unrealizedPnlR >= 0
                          ? 'text-emerald-300'
                          : 'text-rose-300'
                      }`}
                    >
                      {pos.unrealizedPnlR >= 0 ? '+' : ''}
                      {pos.unrealizedPnlR.toFixed(2)}R (
                      {fmtPct(pos.unrealizedPnlPercent)})
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      防守止損線 (SL 距離)
                    </div>
                    <div className="mt-0.5 text-slate-200">
                      ${fmtPrice(pos.invalidationPrice)}{' '}
                      <span
                        className={
                          pos.distanceToInvalidationPercent <=
                          (cfg?.stopProximityPct ?? 0.8)
                            ? 'text-rose-300 font-semibold'
                            : 'text-slate-400'
                        }
                      >
                        ({pos.distanceToInvalidationPercent.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      目標止盈位 (TP 距離)
                    </div>
                    <div className="mt-0.5 text-slate-200">
                      {pos.targetPrice !== null
                        ? `$${fmtPrice(pos.targetPrice)} (${pos.distanceToTargetPercent?.toFixed(2) ?? '—'}%)`
                        : '未設定'}
                    </div>
                  </div>
                </div>

                {/* Row 3: 3-Layer Reversal & Shock Telemetry */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 border-y border-slate-800/80 py-2.5 text-[11px]">
                  <div className="space-y-0.5">
                    <div className="text-slate-400 font-semibold">
                      L1 短線急變與量能
                    </div>
                    <div className="font-mono text-slate-200 tabular-nums">
                      1m {fmtPct(pos.move1mPct)} · 3m {fmtPct(pos.move3mPct)}
                    </div>
                    <div className="font-mono text-slate-400 tabular-nums">
                      ATR倍數:{' '}
                      {pos.move1mAtrMultiple !== null
                        ? `${pos.move1mAtrMultiple.toFixed(2)}x`
                        : '—'}{' '}
                      · 5m RVOL:{' '}
                      {pos.liveBarRvol5m !== null
                        ? `${pos.liveBarRvol5m.toFixed(2)}x`
                        : '—'}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-slate-400 font-semibold">
                      L2 5m 微結構與 OI
                    </div>
                    <div
                      className={`font-mono ${
                        pos.micro5mState === 'ADVERSE_CHOCH'
                          ? 'text-orange-300 font-semibold'
                          : pos.micro5mState === 'TESTING_SWING'
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                      }`}
                    >
                      {microStateLabel(pos.micro5mState)}
                    </div>
                    <div className="font-mono text-slate-400 tabular-nums">
                      FVG:{' '}
                      {pos.adverseFvgDetected && pos.adverseFvgRange
                        ? `反向缺口 $${fmtPrice(pos.adverseFvgRange.low)}–$${fmtPrice(pos.adverseFvgRange.high)}`
                        : '無反向缺口'}{' '}
                      · OI{' '}
                      {pos.oiDeltaPct !== null ? fmtPct(pos.oiDeltaPct) : '—'}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-slate-400 font-semibold">
                      L3 15m / 1h 趨勢結構
                    </div>
                    <div
                      className={`font-mono ${
                        pos.structure15mState === 'REVERSED'
                          ? 'text-rose-300 font-semibold'
                          : pos.structure15mState === 'WEAKENING'
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                      }`}
                    >
                      {structure15mLabel(pos.structure15mState)}
                    </div>
                    <div className="font-mono text-slate-400">
                      1h 方向: {pos.htf1hBias}
                    </div>
                  </div>
                </div>

                {/* Row 4: Active Warnings */}
                {(pos.activeWarnings.length > 0 || pos.oiWarningZh) && (
                  <div className="space-y-1 text-xs">
                    {pos.activeWarnings.map((w, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-1.5 text-amber-200"
                      >
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </div>
                    ))}
                    {pos.oiWarningZh &&
                      !pos.activeWarnings.includes(pos.oiWarningZh) && (
                        <div className="flex items-start gap-1.5 text-amber-200">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                          <span>{pos.oiWarningZh}</span>
                        </div>
                      )}
                  </div>
                )}

                {/* Row 5: Advisory Trailing Defense + Manual Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    {pos.suggestedDefensePrice !== null && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() =>
                          void onUpdatePosition(pos.id, {
                            invalidationPrice: pos.suggestedDefensePrice!,
                            syncPaperLedger: pos.sourceType === 'PAPER_LEDGER',
                          })
                        }
                        className="rounded border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 cursor-pointer"
                        title={pos.suggestedDefenseLabel ?? '更新建議防守止損位'}
                      >
                        套用建議防守位 ($
                        {fmtPrice(pos.suggestedDefensePrice)})
                        {pos.breakEvenReady ? ' · 保本可上移' : ''}
                      </button>
                    )}

                    {isEditingSl ? (
                      <div className="inline-flex items-center gap-1.5">
                        <input
                          type="number"
                          step="any"
                          value={editingSlValue}
                          onChange={(e) => setEditingSlValue(e.target.value)}
                          className="w-28 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-100"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const nextSl = Number(editingSlValue);
                            if (Number.isFinite(nextSl) && nextSl > 0) {
                              void onUpdatePosition(pos.id, {
                                invalidationPrice: nextSl,
                                syncPaperLedger:
                                  pos.sourceType === 'PAPER_LEDGER',
                              });
                            }
                            setEditingSlId(null);
                          }}
                          className="rounded bg-amber-500 px-2 py-1 text-[11px] font-semibold text-slate-950 cursor-pointer"
                        >
                          儲存 SL
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSlId(null)}
                          className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSlId(pos.id);
                          setEditingSlValue(String(pos.invalidationPrice));
                        }}
                        className="rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-300 hover:text-slate-100 cursor-pointer"
                      >
                        調整防守價
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        void onUpdatePosition(pos.id, { paused: !pos.paused })
                      }
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-300 hover:text-slate-100 cursor-pointer"
                    >
                      {pos.paused ? (
                        <>
                          <Play className="h-3 w-3 text-emerald-400" />
                          <span>恢復</span>
                        </>
                      ) : (
                        <>
                          <Pause className="h-3 w-3 text-amber-400" />
                          <span>暫停</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void onDeletePosition(pos.id)}
                      className="inline-flex items-center gap-1 rounded border border-rose-500/35 bg-rose-950/25 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-950/50 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>移出守護</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent Sentinel Alerts Timeline */}
      <div className="border border-slate-800 bg-slate-900/35 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-amber-400" />
            <h3 className="text-xs font-semibold text-slate-100">
              近期持倉趨勢異動與反轉預警時間軸 ({filteredAlerts.length})
            </h3>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            {(['ALL', 'CRITICAL', 'WARNING', 'INFO'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                onClick={() => setSeverityFilter(sev)}
                className={`rounded px-2 py-0.5 cursor-pointer ${
                  severityFilter === sev
                    ? 'bg-slate-800 text-slate-100 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {sev === 'ALL' ? '全部' : sev}
              </button>
            ))}
          </div>
        </div>

        {filteredAlerts.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-500">
            尚無符合條件的趨勢預警事件。
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {filteredAlerts.map((alert) => {
              const sevColor =
                alert.severity === 'CRITICAL'
                  ? 'text-rose-300 border-rose-500/40 bg-rose-950/20'
                  : alert.severity === 'WARNING'
                    ? 'text-amber-300 border-amber-500/35 bg-amber-950/15'
                    : 'text-sky-300 border-slate-800 bg-slate-950/60';
              return (
                <div
                  key={alert.id}
                  className={`border ${sevColor} px-3 py-2 text-xs space-y-1`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                      <strong className="text-slate-100">{alert.symbol}</strong>
                      <span>{alert.side}</span>
                      <span>·</span>
                      <span>{alert.severity}</span>
                      <span>·</span>
                      <span>{alert.eventType}</span>
                      <span>·</span>
                      <span
                        className={
                          alert.confirmedClose
                            ? 'text-emerald-300'
                            : 'text-amber-200'
                        }
                      >
                        {alert.confirmedClose ? '已收盤確認' : '盤中即時預警'}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400">
                      {formatTaipeiDateTime(alert.createdAt)}
                    </span>
                  </div>
                  <div className="text-slate-100 font-medium">
                    {alert.titleZh}
                  </div>
                  <div className="text-[11px] text-slate-300">
                    {alert.detailZh}
                  </div>
                  <div className="font-mono text-[10px] text-slate-400 tabular-nums">
                    事件價格: ${fmtPrice(alert.priceAtEvent)}
                    {alert.suggestedDefensePrice !== null
                      ? ` · 建議防守位: $${fmtPrice(alert.suggestedDefensePrice)}`
                      : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
