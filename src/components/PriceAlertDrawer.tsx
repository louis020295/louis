import React, { useEffect, useMemo, useState } from 'react';
import { formatTaipeiTime } from '../utils/taipeiTime.ts';
import {
  Bell,
  BellOff,
  CheckCircle2,
  Plus,
  RotateCcw,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  PriceAlertConditionType,
  PriceAlertRule,
  SymbolDetailResponse,
  TriggeredAlertEvent,
} from '../types/market.ts';

interface PriceAlertDrawerProps {
  open: boolean;
  onClose: () => void;
  rules: PriceAlertRule[];
  events: TriggeredAlertEvent[];
  soundEnabled: boolean;
  onToggleSound: () => void;
  browserNotifyEnabled: boolean;
  onToggleBrowserNotify: () => void;
  onAddRule: (rule: Omit<PriceAlertRule, 'id' | 'createdAt' | 'triggered' | 'triggeredAt' | 'triggeredPrice'>) => void;
  onDeleteRule: (id: string) => void;
  onToggleRule: (id: string) => void;
  onRearmRule: (id: string) => void;
  onClearEvents: () => void;
  activeSymbolDetail?: SymbolDetailResponse | null;
  availableSymbols: string[];
}

const CONDITION_LABELS: Record<PriceAlertConditionType, string> = {
  PRICE_ABOVE: '價格突破目標價 (≥)',
  PRICE_BELOW: '價格跌破目標價 (≤)',
  TOUCH_OB: '價格回測 OB 訂單塊區間',
  TOUCH_FVG: '價格回補 FVG 缺口區間',
  FUNDING_EXTREME: '資金費率極端異動 (|FR| ≥ %)',
  BTC_MOVE_SHOCK: 'BTC 24h 劇烈波動 (|BTC%| ≥ %)',
};

function formatPriceBrief(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export const PriceAlertDrawer: React.FC<PriceAlertDrawerProps> = ({
  open,
  onClose,
  rules,
  events,
  soundEnabled,
  onToggleSound,
  browserNotifyEnabled,
  onToggleBrowserNotify,
  onAddRule,
  onDeleteRule,
  onToggleRule,
  onRearmRule,
  onClearEvents,
  activeSymbolDetail,
  availableSymbols,
}) => {
  const defaultSymbol = activeSymbolDetail?.symbol || availableSymbols[0] || 'BTCUSDT';
  const [symbol, setSymbol] = useState<string>(defaultSymbol);
  const [conditionType, setConditionType] =
    useState<PriceAlertConditionType>('PRICE_ABOVE');
  const [targetPriceInput, setTargetPriceInput] = useState<string>(
    activeSymbolDetail ? String(activeSymbolDetail.candidate.lastPrice) : ''
  );
  const [zoneLowInput, setZoneLowInput] = useState<string>('');
  const [zoneHighInput, setZoneHighInput] = useState<string>('');
  const [thresholdInput, setThresholdInput] = useState<string>('0.05');
  const [noteInput, setNoteInput] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open && activeSymbolDetail) {
      setSymbol(activeSymbolDetail.symbol);
      const suggestedTarget = Number(
        (activeSymbolDetail.candidate.lastPrice * 1.015).toPrecision(6)
      );
      setTargetPriceInput(String(suggestedTarget));
      setFormError(null);
    }
  }, [open, activeSymbolDetail?.symbol]);

  const presets = useMemo(() => {
    if (!activeSymbolDetail) return [];
    const list: Array<{
      label: string;
      rule: Omit<PriceAlertRule, 'id' | 'createdAt' | 'triggered' | 'triggeredAt' | 'triggeredPrice'>;
    }> = [];
    const sym = activeSymbolDetail.symbol;
    const ob = activeSymbolDetail.smcAnalysis.orderBlock;
    const fvg = activeSymbolDetail.smcAnalysis.fvg;
    const kl = activeSymbolDetail.keyLevelsSession;

    if (ob.detected && ob.low !== null && ob.high !== null) {
      list.push({
        label: `一鍵監控 ${sym} ${ob.direction} OB 區間`,
        rule: {
          symbol: sym,
          conditionType: 'TOUCH_OB',
          targetPrice: null,
          zoneLow: Math.min(ob.low, ob.high),
          zoneHigh: Math.max(ob.low, ob.high),
          thresholdPct: null,
          note: `${ob.direction} Order Block 回測提醒`,
          enabled: true,
        },
      });
    }
    if (fvg.detected && fvg.bottom !== null && fvg.top !== null) {
      list.push({
        label: `一鍵監控 ${sym} ${fvg.direction} FVG 缺口`,
        rule: {
          symbol: sym,
          conditionType: 'TOUCH_FVG',
          targetPrice: null,
          zoneLow: Math.min(fvg.bottom, fvg.top),
          zoneHigh: Math.max(fvg.bottom, fvg.top),
          thresholdPct: null,
          note: `${fvg.direction} FVG 回補提醒`,
          enabled: true,
        },
      });
    }
    if (kl?.pdh !== null && kl?.pdh !== undefined) {
      list.push({
        label: `突破前日高點 PDH (${formatPriceBrief(kl.pdh)})`,
        rule: {
          symbol: sym,
          conditionType: 'PRICE_ABOVE',
          targetPrice: kl.pdh,
          zoneLow: null,
          zoneHigh: null,
          thresholdPct: null,
          note: '觸及/突破 PDH 前日高點',
          enabled: true,
        },
      });
    }
    if (kl?.pdl !== null && kl?.pdl !== undefined) {
      list.push({
        label: `跌破前日低點 PDL (${formatPriceBrief(kl.pdl)})`,
        rule: {
          symbol: sym,
          conditionType: 'PRICE_BELOW',
          targetPrice: kl.pdl,
          zoneLow: null,
          zoneHigh: null,
          thresholdPct: null,
          note: '觸及/跌破 PDL 前日低點',
          enabled: true,
        },
      });
    }
    return list;
  }, [activeSymbolDetail]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const cleanSymbol =
      conditionType === 'BTC_MOVE_SHOCK'
        ? 'BTCUSDT'
        : symbol.trim().toUpperCase();
    if (!cleanSymbol) {
      setFormError('請輸入有效的合約標的代號（例如 SOLUSDT）');
      return;
    }

    if (conditionType === 'PRICE_ABOVE' || conditionType === 'PRICE_BELOW') {
      const p = Number.parseFloat(targetPriceInput);
      if (!Number.isFinite(p) || p <= 0) {
        setFormError('請輸入大於 0 的目標價格');
        return;
      }
      onAddRule({
        symbol: cleanSymbol,
        conditionType,
        targetPrice: p,
        zoneLow: null,
        zoneHigh: null,
        thresholdPct: null,
        note: noteInput.trim() || `${CONDITION_LABELS[conditionType]} ${p}`,
        enabled: true,
      });
      setNoteInput('');
      return;
    }

    if (conditionType === 'TOUCH_OB' || conditionType === 'TOUCH_FVG') {
      const lo = Number.parseFloat(zoneLowInput);
      const hi = Number.parseFloat(zoneHighInput);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) {
        setFormError('請輸入有效的區間下緣與上緣價格');
        return;
      }
      onAddRule({
        symbol: cleanSymbol,
        conditionType,
        targetPrice: null,
        zoneLow: Math.min(lo, hi),
        zoneHigh: Math.max(lo, hi),
        thresholdPct: null,
        note:
          noteInput.trim() ||
          `${conditionType === 'TOUCH_OB' ? 'OB' : 'FVG'} 區間觸發`,
        enabled: true,
      });
      setNoteInput('');
      return;
    }

    const th = Number.parseFloat(thresholdInput);
    if (!Number.isFinite(th) || th <= 0) {
      setFormError('請輸入大於 0 的百分比門檻');
      return;
    }
    onAddRule({
      symbol: cleanSymbol,
      conditionType,
      targetPrice: null,
      zoneLow: null,
      zoneHigh: null,
      thresholdPct: th,
      note:
        noteInput.trim() ||
        (conditionType === 'FUNDING_EXTREME'
          ? `費率絕對值達 ${th}%`
          : `BTC 24h 波動達 ${th}%`),
      enabled: true,
    });
    setNoteInput('');
  };

  return (
    <div
      id="price-alert-drawer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="互動式價格與結構條件告警中心"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-[#0d1017] text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-100">
              <Bell className="h-4 w-4 text-amber-400" />
              <span>條件告警引擎 (價格 / OB / FVG / 費率 / BTC 急變)</span>
            </h2>
            <p className="text-xs text-slate-400">
              純本地瀏覽器即時監控告警，每次行情更新自動檢核，絕不自動下單或發送外部未授權指令
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleSound}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer ${
                soundEnabled
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {soundEnabled ? (
                <Volume2 className="h-3.5 w-3.5" />
              ) : (
                <VolumeX className="h-3.5 w-3.5" />
              )}
              <span>{soundEnabled ? '提示音開' : '靜音'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleBrowserNotify}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer ${
                browserNotifyEnabled
                  ? 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {browserNotifyEnabled ? (
                <Bell className="h-3.5 w-3.5" />
              ) : (
                <BellOff className="h-3.5 w-3.5" />
              )}
              <span>{browserNotifyEnabled ? '桌面通知開' : '桌面通知關'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
              <span>關閉</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 1-Click Presets for currently viewed symbol */}
          {presets.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 space-y-2">
              <div className="text-xs font-semibold text-amber-300">
                快速從當前標的 ({activeSymbolDetail?.symbol}) 結構一鍵建立告警
              </div>
              <div className="flex flex-wrap gap-2">
                {presets.map((p, idx) => (
                  <button
                    key={`preset-${idx}`}
                    type="button"
                    onClick={() => onAddRule(p.rule)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Create New Alert Form */}
          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-200">
              新增自訂條件告警
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
              <label className="space-y-1">
                <span className="block text-slate-400">監控標的</span>
                <input
                  type="text"
                  value={conditionType === 'BTC_MOVE_SHOCK' ? 'BTCUSDT' : symbol}
                  disabled={conditionType === 'BTC_MOVE_SHOCK'}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="例如 SOLUSDT"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none disabled:opacity-60"
                />
              </label>

              <label className="space-y-1">
                <span className="block text-slate-400">觸發條件</span>
                <select
                  value={conditionType}
                  onChange={(e) =>
                    setConditionType(e.target.value as PriceAlertConditionType)
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  {(Object.keys(CONDITION_LABELS) as PriceAlertConditionType[]).map(
                    (k) => (
                      <option key={k} value={k}>
                        {CONDITION_LABELS[k]}
                      </option>
                    )
                  )}
                </select>
              </label>

              {(conditionType === 'PRICE_ABOVE' ||
                conditionType === 'PRICE_BELOW') && (
                <label className="space-y-1">
                  <span className="block text-slate-400">目標價格 (USDT)</span>
                  <input
                    type="number"
                    step="any"
                    value={targetPriceInput}
                    onChange={(e) => setTargetPriceInput(e.target.value)}
                    placeholder="輸入觸發價位"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
                  />
                </label>
              )}

              {(conditionType === 'TOUCH_OB' ||
                conditionType === 'TOUCH_FVG') && (
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-1">
                    <span className="block text-slate-400">區間下緣</span>
                    <input
                      type="number"
                      step="any"
                      value={zoneLowInput}
                      onChange={(e) => setZoneLowInput(e.target.value)}
                      placeholder="Low"
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-slate-400">區間上緣</span>
                    <input
                      type="number"
                      step="any"
                      value={zoneHighInput}
                      onChange={(e) => setZoneHighInput(e.target.value)}
                      placeholder="High"
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
                    />
                  </label>
                </div>
              )}

              {(conditionType === 'FUNDING_EXTREME' ||
                conditionType === 'BTC_MOVE_SHOCK') && (
                <label className="space-y-1">
                  <span className="block text-slate-400">
                    {conditionType === 'FUNDING_EXTREME'
                      ? '資金費率絕對值門檻 (%)'
                      : 'BTC 24h 漲跌幅門檻 (%)'}
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-slate-100 focus:border-amber-500 focus:outline-none"
                  />
                </label>
              )}

              <label className="space-y-1">
                <span className="block text-slate-400">備註標籤 (選填)</span>
                <input
                  type="text"
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="例如 等回踩看15m反轉"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </label>
            </div>

            {formError && (
              <div className="text-xs text-rose-400">{formError}</div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>加入監控告警</span>
              </button>
            </div>
          </form>

          {/* Active & Triggered Rules Table */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">
                  已設定條件 ({rules.length})
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  監控中 {rules.filter((r) => r.enabled && !r.triggered).length}
                </span>
              </div>

              {rules.length === 0 ? (
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 p-4 text-center text-xs text-slate-400">
                  尚未建立任何條件告警。可由上方表單或結構一鍵按鈕新增。
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {rules.map((r) => (
                    <div
                      key={r.id}
                      className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 text-xs ${
                        r.triggered
                          ? 'border-emerald-500/40 bg-emerald-950/25'
                          : r.enabled
                            ? 'border-slate-800 bg-slate-900/60'
                            : 'border-slate-800/60 bg-slate-950/60 opacity-60'
                      }`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="font-bold text-slate-100">
                            {r.symbol}
                          </span>
                          <span className="text-[11px] text-amber-300">
                            {r.conditionType === 'PRICE_ABOVE'
                              ? `≥ ${formatPriceBrief(r.targetPrice)}`
                              : r.conditionType === 'PRICE_BELOW'
                                ? `≤ ${formatPriceBrief(r.targetPrice)}`
                                : r.conditionType === 'TOUCH_OB' ||
                                    r.conditionType === 'TOUCH_FVG'
                                  ? `${r.conditionType === 'TOUCH_OB' ? 'OB' : 'FVG'} [${formatPriceBrief(r.zoneLow)}–${formatPriceBrief(r.zoneHigh)}]`
                                  : `≥ ${r.thresholdPct}%`}
                          </span>
                          {r.triggered && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              已觸發
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-slate-400">
                          {r.note}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {r.triggered ? (
                          <button
                            type="button"
                            onClick={() => onRearmRule(r.id)}
                            className="rounded-md border border-slate-700 bg-slate-900 p-1 text-slate-300 hover:text-amber-300 cursor-pointer"
                            title="重新啟用此告警"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onToggleRule(r.id)}
                            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300 hover:text-slate-100 cursor-pointer"
                          >
                            {r.enabled ? '暫停' : '啟用'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onDeleteRule(r.id)}
                          className="rounded-md border border-slate-700 bg-slate-900 p-1 text-slate-400 hover:text-rose-400 cursor-pointer"
                          title="刪除此告警"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Triggered Event History */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">
                  觸發紀錄 ({events.length})
                </span>
                {events.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearEvents}
                    className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    清除紀錄
                  </button>
                )}
              </div>

              {events.length === 0 ? (
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 p-4 text-center text-xs text-slate-400">
                  目前尚無觸發事件。當掃描價格或結構滿足條件時會立即記錄並提示。
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {events.map((ev) => (
                    <div
                      key={ev.id}
                      className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5 text-xs space-y-0.5"
                    >
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="font-semibold text-amber-300">
                          {ev.symbol}
                        </span>
                        <span className="text-slate-400">
                          {formatTaipeiTime(ev.triggeredAt)}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-200">
                        {ev.messageZh}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
