import React, { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Compass } from 'lucide-react';
import { KeyLevelsAndSessionAnalysis } from '../types/market.ts';

interface KeyLevelsSessionStripProps {
  data: KeyLevelsAndSessionAnalysis | null | undefined;
}

function formatPriceCompact(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return 'N/A';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

function formatCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '資料缺失';
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const KeyLevelsSessionStrip: React.FC<KeyLevelsSessionStripProps> = ({
  data,
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!data) return null;

  const liveFundingMs =
    data.session.nextFundingTime !== null
      ? Math.max(0, data.session.nextFundingTime - nowMs)
      : data.session.fundingCountdownMs;
  const fundingSoon =
    liveFundingMs !== null && liveFundingMs <= 15 * 60 * 1000;

  const isKillzone =
    data.session.activeSession === 'LONDON_KILLZONE' ||
    data.session.activeSession === 'NY_AM_KILLZONE' ||
    data.session.activeSession === 'US_EQUITY_OPEN';

  return (
    <div
      id="key-levels-session-strip"
      className="@container apple-subcard p-3.5 space-y-2.5 overflow-hidden"
    >
      {/* Top Row: Session Killzone + Live Funding Settlement Clock */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <Compass className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          <h4 className="font-semibold text-[var(--apple-text-primary)] truncate">
            關鍵時間窗口與日內價格錨點 (PDH / PDL / DO / WO / VWAP)
          </h4>
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-medium shrink-0 ${
              isKillzone
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                : 'border-slate-700 bg-slate-900 text-slate-300'
            }`}
          >
            {data.session.sessionLabelZh}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums min-w-0">
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 shrink-0 ${
              fundingSoon
                ? 'border-amber-500/60 bg-amber-500/20 text-amber-200 font-semibold'
                : 'border-slate-700 bg-slate-900 text-slate-300'
            }`}
            title="距離下次永續合約資金費率結算時間"
          >
            <Clock className="h-3 w-3 shrink-0" />
            <span>費率結算倒數 {formatCountdown(liveFundingMs)}</span>
          </span>
          <span className="text-slate-400 truncate">
            {data.vwapPositionLabelZh}
          </span>
        </div>
      </div>

      {/* Anchors Grid: 2 cols narrow -> 3 cols split -> 6 cols full-width */}
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @3xl:grid-cols-6 font-mono tabular-nums text-xs">
        {[
          {
            key: 'PDH',
            label: '前日高點 (PDH)',
            price: data.pdh,
            accent: 'text-rose-300',
          },
          {
            key: 'PDL',
            label: '前日低點 (PDL)',
            price: data.pdl,
            accent: 'text-emerald-300',
          },
          {
            key: 'DAILY_OPEN',
            label: '日線開盤 (DO)',
            price: data.dailyOpen,
            accent: 'text-sky-300',
          },
          {
            key: 'WEEKLY_OPEN',
            label: '週線開盤 (WO)',
            price: data.weeklyOpen,
            accent: 'text-violet-300',
          },
          {
            key: 'VWAP',
            label: '日內錨定 VWAP',
            price: data.vwap,
            accent: 'text-amber-300',
          },
        ].map((item) => {
          const distPct =
            item.price !== null && data.lastPrice > 0
              ? ((item.price - data.lastPrice) / data.lastPrice) * 100
              : null;
          return (
            <div
              key={item.key}
              className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5"
            >
              <div className="font-sans text-[10px] text-slate-400 truncate">
                {item.label}
              </div>
              <div className={`mt-0.5 text-sm font-bold truncate ${item.accent}`}>
                {formatPriceCompact(item.price)}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {distPct !== null
                  ? `距現價 ${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%`
                  : 'K線樣本不足'}
              </div>
            </div>
          );
        })}

        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            VWAP ±1σ 通道
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-slate-200 truncate">
            +1σ {formatPriceCompact(data.vwapUpper1)}
          </div>
          <div className="text-[11px] text-slate-400 truncate">
            -1σ {formatPriceCompact(data.vwapLower1)}
          </div>
        </div>
      </div>

      {/* Proximity Warning or Session Note */}
      {data.proximityWarningZh ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-950/35 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-300 shrink-0" />
          <span className="min-w-0 break-words">{data.proximityWarningZh}</span>
        </div>
      ) : (
        <div className="text-[11px] text-slate-400 break-words">
          時段特性：{data.session.volatilityNoteZh}
        </div>
      )}
    </div>
  );
};
