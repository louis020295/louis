import React, { useState } from 'react';
import { DerivativesStructureAnalysis } from '../types/market.ts';

interface DerivativesStructureCardProps {
  symbol: string;
  analysis?: DerivativesStructureAnalysis | null;
}

function formatCompactUsdSigned(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatCompactUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export const DerivativesStructureCard: React.FC<
  DerivativesStructureCardProps
> = ({ symbol, analysis }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!analysis) {
    return (
      <div
        id="derivatives-structure-panel"
        className="apple-subcard p-4 text-xs text-[var(--apple-text-secondary)]"
      >
        衍生品資金結構與清算流動性指標尚未載入。
      </div>
    );
  }

  const { oiRegime, cvd, funding, liquidityClusters, series } = analysis;

  const regimeBadgeClass =
    oiRegime.regime === 'LONG_BUILDUP'
      ? 'border-emerald-500/40 bg-emerald-950/80 text-emerald-200'
      : oiRegime.regime === 'SHORT_BUILDUP'
        ? 'border-rose-500/40 bg-rose-950/80 text-rose-200'
        : oiRegime.regime === 'SHORT_COVERING' ||
            oiRegime.regime === 'LONG_LIQUIDATION'
          ? 'border-amber-500/40 bg-amber-950/80 text-amber-200'
          : 'border-slate-700 bg-slate-900 text-slate-300';

  const cvdPoints = series.filter((pt) => pt.cumulativeCvdUsd !== null);
  const width = 820;
  const height = 145;
  const padLeft = 10;
  const padRight = 72;
  const padTop = 14;
  const padBottom = 20;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const cvdVals = cvdPoints.map((p) => p.cumulativeCvdUsd ?? 0);
  const minCvd = cvdVals.length > 0 ? Math.min(0, ...cvdVals) : -1;
  const maxCvd = cvdVals.length > 0 ? Math.max(0, ...cvdVals) : 1;
  const spanCvd = Math.max(maxCvd - minCvd, 1);
  const cvdToY = (v: number) =>
    padTop + plotH - ((v - minCvd) / spanCvd) * plotH;
  const idxToX = (i: number) =>
    cvdPoints.length <= 1
      ? padLeft + plotW / 2
      : padLeft + (i / (cvdPoints.length - 1)) * plotW;

  const cvdPath = cvdPoints
    .map(
      (pt, i) =>
        `${i === 0 ? 'M' : 'L'} ${idxToX(i).toFixed(2)} ${cvdToY(
          pt.cumulativeCvdUsd ?? 0
        ).toFixed(2)}`
    )
    .join(' ');

  const activePoint =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < cvdPoints.length
      ? cvdPoints[hoverIdx]
      : cvdPoints.length > 0
        ? cvdPoints[cvdPoints.length - 1]
        : null;

  return (
    <div
      id="derivatives-structure-panel"
      className="@container apple-subcard p-4 space-y-3 overflow-hidden"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <h4 className="font-semibold text-[var(--apple-text-primary)] truncate">
            衍生品資金結構與清算流動性 ({symbol} · {analysis.timeframe})
          </h4>
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${regimeBadgeClass}`}
          >
            {oiRegime.regimeLabelZh}
          </span>
        </div>
        <span className="text-[11px] text-[var(--apple-text-secondary)]">
          純結構輔助參考（不改變現有 SMC / 6-Gate 評分）
        </span>
      </div>

      {/* 3-Card Derivatives KPI Grid */}
      <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-3 text-xs font-mono tabular-nums">
        {/* OI x Price Quadrant */}
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3 space-y-1">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            OI × 價格四象限 ({oiRegime.sampleCount} 筆)
          </div>
          <div className="text-sm font-semibold text-slate-100 break-words">
            {oiRegime.status === 'READY'
              ? `價格 ${oiRegime.priceChangePct !== null && oiRegime.priceChangePct >= 0 ? '+' : ''}${oiRegime.priceChangePct}% · OI ${oiRegime.oiChangePct !== null && oiRegime.oiChangePct >= 0 ? '+' : ''}${oiRegime.oiChangePct}%`
              : '歷史 OI 資料缺失'}
          </div>
          <div className="font-sans text-[11px] text-slate-400 leading-snug break-words">
            {oiRegime.interpretationZh}
          </div>
        </div>

        {/* CVD Active Flow */}
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3 space-y-1">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            主動成交累積 Delta (CVD · {cvd.barCount} 根)
          </div>
          <div
            className={`text-sm font-semibold break-words ${
              cvd.status !== 'READY'
                ? 'text-slate-300'
                : (cvd.netDeltaUsd ?? 0) >= 0
                  ? 'text-emerald-400'
                  : 'text-rose-400'
            }`}
          >
            {cvd.status === 'READY' && cvd.netDeltaUsd !== null
              ? `${formatCompactUsdSigned(cvd.netDeltaUsd)} · 買盤 ${cvd.takerBuyRatioPct}%`
              : 'Taker Buy 資料缺失'}
          </div>
          <div className="font-sans text-[11px] text-slate-400 leading-snug break-words">
            {cvd.divergenceLabelZh}
          </div>
        </div>

        {/* Funding Trend & Squeeze Bias */}
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3 space-y-1">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            資金費率趨勢與擠壓傾向
          </div>
          <div
            className={`text-sm font-semibold break-words ${
              funding.squeezeBias === 'SHORT_SQUEEZE_RISK'
                ? 'text-amber-300'
                : funding.squeezeBias === 'LONG_SQUEEZE_RISK'
                  ? 'text-rose-400'
                  : 'text-slate-100'
            }`}
          >
            {funding.status === 'READY' && funding.currentRate !== null
              ? `${(funding.currentRate * 100).toFixed(4)}% (年化 ${funding.annualizedPct}%${
                  funding.fundingIntervalHours
                    ? ` · 每 ${funding.fundingIntervalHours}h`
                    : ''
                }${funding.fundingIntervalFallback ? ' · 8h fallback' : ''})`
              : 'Funding 資料缺失'}
          </div>
          <div className="font-sans text-[11px] text-slate-400 leading-snug break-words">
            {funding.squeezeLabelZh}
            {funding.deltaBps !== null
              ? ` · 較均值 ${funding.deltaBps >= 0 ? '+' : ''}${funding.deltaBps} bps`
              : ''}
          </div>
        </div>
      </div>

      {/* CVD Mini Curve */}
      {cvd.status === 'READY' && cvdPoints.length >= 4 && (
        <div className="rounded-xl border border-slate-800 bg-[#0e1017] p-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-300">
            <span className="font-sans text-slate-400">
              累積主動買賣差 (CVD) 走勢 ({cvdPoints.length} 根已確認 K 線)
            </span>
            {activePoint && activePoint.cumulativeCvdUsd !== null && (
              <span>
                {activePoint.label} · 單根Delta{' '}
                {formatCompactUsdSigned(activePoint.barDeltaUsd ?? 0)} · 累積{' '}
                {formatCompactUsdSigned(activePoint.cumulativeCvdUsd)}
              </span>
            )}
          </div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-32 w-full select-none"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width <= 0 || cvdPoints.length <= 1) return;
              const xSvg = ((e.clientX - rect.left) / rect.width) * width;
              const ratio = Math.max(0, Math.min(1, (xSvg - padLeft) / plotW));
              setHoverIdx(Math.round(ratio * (cvdPoints.length - 1)));
            }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <line
              x1={padLeft}
              y1={cvdToY(0)}
              x2={width - padRight}
              y2={cvdToY(0)}
              stroke="rgba(148, 163, 184, 0.25)"
              strokeDasharray="3 3"
            />
            <text
              x={width - padRight + 6}
              y={cvdToY(0) + 3}
              fill="#94a3b8"
              fontSize="9.5"
              fontFamily="SF Mono, JetBrains Mono, monospace"
            >
              $0
            </text>
            <text
              x={width - padRight + 6}
              y={padTop + 6}
              fill="#94a3b8"
              fontSize="9.5"
              fontFamily="SF Mono, JetBrains Mono, monospace"
            >
              {formatCompactUsdSigned(maxCvd)}
            </text>
            <path
              d={cvdPath}
              fill="none"
              stroke={(cvd.netDeltaUsd ?? 0) >= 0 ? '#10b981' : '#f43f5e'}
              strokeWidth={1.8}
            />
          </svg>
        </div>
      )}

      {/* Swing-Derived Liquidation / Liquidity Pools */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-slate-300">
          關鍵止損 / 潛在清算流動性區間（依已確認 Wave High / Low 與當前 OI 推估）
        </div>
        {liquidityClusters.length === 0 ? (
          <div className="rounded-lg border border-slate-800/80 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-400">
            近端 K 線未形成足夠明顯之波段止損高低點流動性池。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 font-mono tabular-nums text-[11px]">
            {liquidityClusters.map((pool) => {
              const isBuy = pool.side === 'BUY_SIDE_LIQ';
              return (
                <div
                  key={pool.id}
                  className="min-w-0 overflow-hidden flex items-center justify-between gap-2 rounded-lg border border-slate-800/90 bg-slate-950/85 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div
                      className={`font-semibold truncate ${
                        isBuy ? 'text-amber-300' : 'text-purple-300'
                      }`}
                    >
                      {isBuy ? 'BSL 上方空單清算區' : 'SSL 下方多單清算區'} · $
                      {formatPrice(pool.price)}
                    </div>
                    <div className="font-sans text-[10px] text-slate-400 truncate">
                      {pool.basisLabel}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-slate-200">
                      {pool.distancePercent >= 0 ? '+' : ''}
                      {pool.distancePercent}%
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {pool.estimatedClusterUsd !== null
                        ? `估 ${formatCompactUsd(pool.estimatedClusterUsd)}`
                        : `強度 ${pool.strengthScore}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
