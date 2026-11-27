import React, { useState } from 'react';
import {
  MarketBreadthSummary,
  MarketSectorKey,
  SectorRotationItem,
} from '../types/market.ts';

interface MarketBreadthSectorPanelProps {
  breadth?: MarketBreadthSummary | null;
  sectors?: SectorRotationItem[];
  activeSector: 'ALL' | MarketSectorKey;
  onSelectSector: (sector: 'ALL' | MarketSectorKey) => void;
  onSelectSymbol?: (symbol: string) => void;
}

function formatUsdCompact(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export const MarketBreadthSectorPanel: React.FC<
  MarketBreadthSectorPanelProps
> = ({ breadth, sectors = [], activeSector, onSelectSector, onSelectSymbol }) => {
  const [expanded, setExpanded] = useState<boolean>(true);

  if (!breadth || sectors.length === 0) return null;

  const regimeBadgeClass =
    breadth.marketRegime === 'BROAD_RISK_ON'
      ? 'border-emerald-500/40 bg-emerald-950/75 text-emerald-200'
      : breadth.marketRegime === 'BROAD_RISK_OFF'
        ? 'border-rose-500/40 bg-rose-950/75 text-rose-200'
        : breadth.marketRegime === 'BTC_LED_ROTATION'
          ? 'border-amber-500/40 bg-amber-950/75 text-amber-200'
          : 'border-sky-500/40 bg-sky-950/75 text-sky-200';

  return (
    <div
      id="market-breadth-sector-panel"
      className="@container space-y-2.5 overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <span className="font-semibold text-slate-100 truncate">
            全市場廣度與板塊資金輪動
          </span>
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${regimeBadgeClass}`}
          >
            {breadth.marketRegimeLabelZh}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs shrink-0">
          {activeSector !== 'ALL' && (
            <button
              type="button"
              onClick={() => onSelectSector('ALL')}
              className="rounded-lg border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/25 cursor-pointer whitespace-nowrap"
            >
              全部板塊
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-300 hover:text-slate-100 cursor-pointer whitespace-nowrap"
          >
            {expanded ? '收合板塊明細' : '展開板塊明細'}
          </button>
        </div>
      </div>

      {/* Compact Market Breadth KPI Bar */}
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-5 font-mono tabular-nums text-[11px]">
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/75 px-2.5 py-1.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            全市場漲跌廣度
          </div>
          <div className="font-semibold text-slate-100 truncate">
            {breadth.advancingRatioPct}% 紅盤 ({breadth.advancingCount}/
            {breadth.totalSymbols})
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/75 px-2.5 py-1.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            24h 漲跌幅中位 / 均漲
          </div>
          <div
            className={`font-semibold truncate ${
              breadth.medianChange24hPct >= 0
                ? 'text-emerald-400'
                : 'text-rose-400'
            }`}
          >
            {breadth.medianChange24hPct >= 0 ? '+' : ''}
            {breadth.medianChange24hPct}% · 均{' '}
            {breadth.avgChange24hPct >= 0 ? '+' : ''}
            {breadth.avgChange24hPct}%
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/75 px-2.5 py-1.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            平均 BTC 相關係數 (15m)
          </div>
          <div className="font-semibold text-amber-300 truncate">
            {breadth.avgBtcPearson15m !== null
              ? `r = ${breadth.avgBtcPearson15m.toFixed(2)}`
              : '快取累積中'}
            {breadth.highBtcCoupledRatioPct !== null
              ? ` · 強共振 ${breadth.highBtcCoupledRatioPct}%`
              : ''}
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/75 px-2.5 py-1.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            獨立走勢低耦合標的
          </div>
          <div className="font-semibold text-emerald-300 truncate">
            {breadth.lowIndependentCount} 檔
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/75 px-2.5 py-1.5">
          <div className="font-sans text-[10px] text-slate-400 truncate">
            雷達多空比 / 正式候選
          </div>
          <div className="font-semibold text-slate-100 truncate">
            <span className="text-emerald-400">多{breadth.bullRadarCount}</span>{' '}
            :{' '}
            <span className="text-rose-400">空{breadth.bearRadarCount}</span> ·
            SMC {breadth.formalCandidateCount}
          </div>
        </div>
      </div>

      {/* Compact Clickable 8-Sector Strip */}
      {expanded && (
        <div className="grid grid-cols-2 gap-1.5 @md:grid-cols-4 @5xl:grid-cols-8">
          {sectors.map((sec) => {
            const isActive = activeSector === sec.key;
            return (
              <div
                key={sec.key}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSector(isActive ? 'ALL' : sec.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectSector(isActive ? 'ALL' : sec.key);
                  }
                }}
                className={`min-w-0 overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition-all cursor-pointer ${
                  isActive
                    ? 'border-amber-500/80 bg-slate-900 shadow-sm'
                    : 'border-slate-800/80 bg-slate-950/70 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-1 text-[11px]">
                  <span className="font-semibold text-slate-100 truncate">
                    {sec.labelZh}{' '}
                    <span className="font-mono text-[10px] text-slate-400">
                      ({sec.symbolCount})
                    </span>
                  </span>
                  <span
                    className={`font-mono font-bold tabular-nums shrink-0 ${
                      sec.avgChange24hPct >= 0
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {sec.avgChange24hPct >= 0 ? '+' : ''}
                    {sec.avgChange24hPct.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-1 font-mono tabular-nums text-[10px] text-slate-400">
                  <span className="truncate">
                    佔{sec.volumeSharePct}% · ${formatUsdCompact(sec.totalQuoteVolume24h)}
                  </span>
                  {sec.topLeaderSymbol && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSymbol?.(sec.topLeaderSymbol!);
                      }}
                      className="font-semibold text-sky-300 hover:underline cursor-pointer shrink-0"
                      title={`切換檢視板塊領漲 ${sec.topLeaderSymbol}`}
                    >
                      {sec.topLeaderSymbol.replace('USDT', '')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
