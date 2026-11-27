import React, { useEffect, useMemo, useState } from 'react';
import {
  BtcKlineCorrelationAnalysis,
  BtcTimeframeCorrelationMetric,
  Timeframe,
} from '../types/market.ts';

interface BtcCorrelationCardProps {
  symbol: string;
  primaryTimeframe: Timeframe;
  analysis?: BtcKlineCorrelationAnalysis | null;
}

const TIMEFRAME_ORDER: Timeframe[] = ['15m', '1h', '5m', '4h'];

function getTierStyles(analysis?: BtcKlineCorrelationAnalysis | null): {
  labelClass: string;
  bannerClass: string;
} {
  if (!analysis || analysis.status !== 'READY') {
    return {
      labelClass: 'text-slate-300 border-slate-700 bg-slate-900/90',
      bannerClass: 'border-slate-800 bg-slate-950/90 text-slate-200',
    };
  }
  switch (analysis.tier) {
    case 'BENCHMARK_BTC':
      return {
        labelClass: 'text-amber-200 border-amber-500/40 bg-amber-950/85',
        bannerClass: 'border-amber-500/35 bg-amber-950/85 text-amber-100',
      };
    case 'HIGH_COUPLED':
      return {
        labelClass: 'text-amber-200 border-amber-500/40 bg-amber-950/85',
        bannerClass: 'border-amber-500/40 bg-amber-950/85 text-amber-100',
      };
    case 'MODERATE_COUPLED':
      return {
        labelClass: 'text-sky-200 border-sky-500/40 bg-sky-950/85',
        bannerClass: 'border-sky-500/35 bg-slate-900/95 text-slate-100',
      };
    case 'LOW_INDEPENDENT':
      return {
        labelClass: 'text-emerald-200 border-emerald-500/40 bg-emerald-950/85',
        bannerClass: 'border-emerald-500/35 bg-emerald-950/85 text-emerald-100',
      };
    case 'INVERSE':
      return {
        labelClass: 'text-cyan-200 border-cyan-500/40 bg-cyan-950/85',
        bannerClass: 'border-cyan-500/35 bg-cyan-950/85 text-cyan-100',
      };
    default:
      return {
        labelClass: 'text-slate-300 border-slate-700 bg-slate-900/90',
        bannerClass: 'border-slate-800 bg-slate-950/90 text-slate-200',
      };
  }
}

export const BtcCorrelationCard: React.FC<BtcCorrelationCardProps> = ({
  symbol,
  primaryTimeframe,
  analysis,
}) => {
  const defaultTf = useMemo<Timeframe>(() => {
    if (analysis?.byTimeframe?.[primaryTimeframe]?.status === 'READY') {
      return primaryTimeframe;
    }
    if (analysis?.byTimeframe?.['15m']?.status === 'READY') {
      return '15m';
    }
    if (analysis?.byTimeframe?.['1h']?.status === 'READY') {
      return '1h';
    }
    return primaryTimeframe === '5m' || primaryTimeframe === '4h'
      ? primaryTimeframe
      : '15m';
  }, [analysis, primaryTimeframe]);

  const [chartTf, setChartTf] = useState<Timeframe>(defaultTf);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    setChartTf(defaultTf);
    setHoverIdx(null);
  }, [symbol, defaultTf]);

  const availableTimeframes = useMemo<Timeframe[]>(() => {
    if (!analysis?.byTimeframe) return ['15m', '1h'];
    return TIMEFRAME_ORDER.filter((tf) => {
      const m = analysis.byTimeframe[tf];
      return tf === '15m' || tf === '1h' || (m && m.alignedBarCount > 0);
    });
  }, [analysis]);

  if (!analysis) {
    return (
      <div className="apple-subcard p-4 text-xs text-[var(--apple-text-secondary)]">
        與比特幣 (BTCUSDT) 過去 K 線重合性分析資料尚未載入。
      </div>
    );
  }

  const metric: BtcTimeframeCorrelationMetric | undefined =
    analysis.byTimeframe[chartTf] ??
    analysis.byTimeframe['15m'] ??
    analysis.byTimeframe['1h'];

  const series = metric?.series ?? [];
  const styles = getTierStyles(analysis);

  // SVG chart coordinate math
  const width = 820;
  const height = 220;
  const padTop = 18;
  const padBottom = 26;
  const padLeft = 14;
  const padRight = 64;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const allValues = series.flatMap((pt) => [
    0,
    pt.btcReturnPct,
    pt.symbolReturnPct,
  ]);
  const rawMin = allValues.length > 0 ? Math.min(...allValues) : -1;
  const rawMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  const paddingRange = Math.max((rawMax - rawMin) * 0.12, 0.25);
  const minVal = rawMin - paddingRange;
  const maxVal = rawMax + paddingRange;
  const valSpan = Math.max(maxVal - minVal, 0.5);

  const valToY = (v: number) =>
    padTop + plotHeight - ((v - minVal) / valSpan) * plotHeight;
  const idxToX = (idx: number) =>
    series.length <= 1
      ? padLeft + plotWidth / 2
      : padLeft + (idx / (series.length - 1)) * plotWidth;

  const btcPath = series
    .map(
      (pt, i) =>
        `${i === 0 ? 'M' : 'L'} ${idxToX(i).toFixed(2)} ${valToY(
          pt.btcReturnPct
        ).toFixed(2)}`
    )
    .join(' ');
  const symPath = series
    .map(
      (pt, i) =>
        `${i === 0 ? 'M' : 'L'} ${idxToX(i).toFixed(2)} ${valToY(
          pt.symbolReturnPct
        ).toFixed(2)}`
    )
    .join(' ');

  const gridValues = [
    maxVal,
    minVal + valSpan * 0.75,
    0,
    minVal + valSpan * 0.25,
    minVal,
  ].filter((v, idx, arr) => {
    if (v === 0) return true;
    return Math.abs(v) > valSpan * 0.06 && arr.indexOf(v) === idx;
  });

  const activePoint =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < series.length
      ? series[hoverIdx]
      : series.length > 0
        ? series[series.length - 1]
        : null;

  return (
    <div
      id="btc-correlation-panel"
      className="@container apple-subcard p-4 space-y-3 overflow-hidden"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <h4 className="text-xs font-semibold text-[var(--apple-text-primary)]">
            與比特幣 (BTCUSDT) 過去 K 線重合性與連動風險分析
          </h4>
          <span aria-hidden="true" className="text-[var(--apple-text-muted)]">
            ·
          </span>
          <span
            className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${styles.labelClass}`}
          >
            {analysis.tierLabelZh}
          </span>
          <span aria-hidden="true" className="text-[var(--apple-text-muted)]">
            ·
          </span>
          <span className="text-[11px] text-[var(--apple-text-secondary)]">
            純風險輔助資訊（不影響 SMC / 6-Gate 評分）
          </span>
        </div>

        {/* Timeframe Segmented Switcher */}
        <div className="apple-segmented-track flex items-center gap-1 shrink-0">
          {availableTimeframes.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => {
                setChartTf(tf);
                setHoverIdx(null);
              }}
              className={`px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                chartTf === tf
                  ? 'apple-segmented-pill-active font-semibold'
                  : 'text-[var(--apple-text-secondary)] hover:text-[var(--apple-text-primary)]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Summary & Practical Trading Hint */}
      <div className={`rounded-xl border p-3 text-xs space-y-1 ${styles.bannerClass}`}>
        <div className="font-medium leading-snug break-words">{analysis.summaryZh}</div>
        <div className="text-[11px] opacity-90 leading-relaxed break-words">
          {analysis.tradingHintZh}
        </div>
      </div>

      {/* 4-Column Tabular KPI Strip */}
      <div className="grid grid-cols-2 gap-2.5 @2xl:grid-cols-4 font-mono tabular-nums text-xs">
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            Pearson 相關係數 ({chartTf})
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
            {metric?.pearsonCorrelation !== null &&
            metric?.pearsonCorrelation !== undefined
              ? `${metric.pearsonCorrelation >= 0 ? '+' : ''}${metric.pearsonCorrelation.toFixed(2)}`
              : '樣本不足'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400 truncate">
            15m:{' '}
            {analysis.pearson15m !== null
              ? analysis.pearson15m.toFixed(2)
              : 'N/A'}{' '}
            · 1h:{' '}
            {analysis.pearson1h !== null
              ? analysis.pearson1h.toFixed(2)
              : 'N/A'}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            K 線同向重疊率 ({chartTf})
          </div>
          <div className="mt-1 text-sm font-semibold text-amber-300 truncate">
            {metric?.directionalOverlapRate !== null &&
            metric?.directionalOverlapRate !== undefined
              ? `${metric.directionalOverlapRate.toFixed(1)}%`
              : '樣本不足'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400 truncate">
            上漲同步:{' '}
            {metric?.upsideOverlapRate !== null &&
            metric?.upsideOverlapRate !== undefined
              ? `${metric.upsideOverlapRate.toFixed(1)}%`
              : 'N/A'}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            BTC 下跌同步率 ({chartTf})
          </div>
          <div
            className={`mt-1 text-sm font-semibold truncate ${
              metric?.downsideOverlapRate !== null &&
              metric?.downsideOverlapRate !== undefined &&
              metric.downsideOverlapRate >= 75
                ? 'text-rose-300'
                : 'text-slate-100'
            }`}
          >
            {metric?.downsideOverlapRate !== null &&
            metric?.downsideOverlapRate !== undefined
              ? `${metric.downsideOverlapRate.toFixed(1)}%`
              : '樣本不足'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400 truncate">
            BTC 收跌時同步收跌比例
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
          <div className="font-sans text-[11px] text-slate-400 truncate">
            Beta 連動倍數 / 對齊 K 線
          </div>
          <div className="mt-1 text-sm font-semibold text-sky-300 truncate">
            {metric?.beta !== null && metric?.beta !== undefined
              ? `${metric.beta.toFixed(2)}x`
              : 'N/A'}
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400 truncate">
            已對齊收盤 {metric?.alignedBarCount ?? 0} 根 (門檻 ≥{' '}
            {metric?.minRequiredBars ?? 15})
          </div>
        </div>
      </div>

      {/* Normalized Cumulative Return Overlay Chart (Symbol vs BTCUSDT) */}
      {metric?.status === 'READY' && series.length >= 2 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--apple-text-secondary)]">
            <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
              <span className="text-amber-600 dark:text-amber-400">
                ━━ BTCUSDT 基準走勢 (%)
              </span>
              {!analysis.isBenchmark && (
                <span className="text-sky-600 dark:text-sky-400">
                  ━━ {symbol} 相對走勢 (%)
                </span>
              )}
              <span className="text-[var(--apple-text-secondary)]">
                --- 0% 起點基準
              </span>
            </div>
            {activePoint && (
              <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[11px] text-[var(--apple-text-primary)]">
                <span>{activePoint.label}</span>
                <span>·</span>
                <span className="text-amber-600 dark:text-amber-300">
                  BTC {activePoint.btcReturnPct >= 0 ? '+' : ''}
                  {activePoint.btcReturnPct.toFixed(2)}%
                </span>
                {!analysis.isBenchmark && (
                  <>
                    <span>·</span>
                    <span className="text-sky-600 dark:text-sky-300">
                      {symbol} {activePoint.symbolReturnPct >= 0 ? '+' : ''}
                      {activePoint.symbolReturnPct.toFixed(2)}%
                    </span>
                    <span>·</span>
                    <span
                      className={
                        activePoint.sameDirection
                          ? 'text-emerald-600 dark:text-emerald-300'
                          : 'text-rose-600 dark:text-rose-300'
                      }
                    >
                      {activePoint.sameDirection ? '當根同向' : '當根背離'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="relative w-full overflow-hidden rounded-xl bg-[#0e1017] p-2">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="h-52 w-full select-none"
              role="img"
              aria-label={`${symbol} 與 BTCUSDT ${chartTf} K線歸一化走勢重疊圖`}
              onMouseLeave={() => setHoverIdx(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width <= 0 || series.length === 0) return;
                const relX =
                  ((e.clientX - rect.left) / rect.width) * width - padLeft;
                const clamped = Math.max(0, Math.min(plotWidth, relX));
                const idx = Math.round(
                  (clamped / Math.max(plotWidth, 1)) * (series.length - 1)
                );
                setHoverIdx(Math.max(0, Math.min(series.length - 1, idx)));
              }}
            >
              {/* Horizontal Grid & Zero Line */}
              {gridValues.map((gv, idx) => {
                const y = valToY(gv);
                const isZero = Math.abs(gv) < 1e-6;
                return (
                  <g key={idx}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={width - padRight}
                      y2={y}
                      stroke={
                        isZero
                          ? 'rgba(226, 232, 240, 0.35)'
                          : 'rgba(148, 163, 184, 0.14)'
                      }
                      strokeDasharray={isZero ? '4 3' : '2 3'}
                      strokeWidth={isZero ? 1.1 : 1}
                    />
                    <text
                      x={width - padRight + 6}
                      y={y + 3}
                      fill={isZero ? '#e2e8f0' : '#94a3b8'}
                      fontSize="10"
                      fontFamily="SF Mono, JetBrains Mono, monospace"
                    >
                      {gv >= 0 ? '+' : ''}
                      {gv.toFixed(2)}%
                    </text>
                  </g>
                );
              })}

              {/* BTCUSDT Reference Curve */}
              <path
                d={btcPath}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={analysis.isBenchmark ? 1 : 0.85}
              />

              {/* Target Altcoin Overlay Curve */}
              {!analysis.isBenchmark && (
                <path
                  d={symPath}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth={2.1}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}

              {/* Hover Crosshair */}
              {hoverIdx !== null && series[hoverIdx] && (
                <g>
                  <line
                    x1={idxToX(hoverIdx)}
                    y1={padTop}
                    x2={idxToX(hoverIdx)}
                    y2={height - padBottom}
                    stroke="rgba(226, 232, 240, 0.35)"
                    strokeDasharray="2 2"
                    strokeWidth={1}
                  />
                  <circle
                    cx={idxToX(hoverIdx)}
                    cy={valToY(series[hoverIdx].btcReturnPct)}
                    r={3.5}
                    fill="#f59e0b"
                  />
                  {!analysis.isBenchmark && (
                    <circle
                      cx={idxToX(hoverIdx)}
                      cy={valToY(series[hoverIdx].symbolReturnPct)}
                      r={3.8}
                      fill="#38bdf8"
                    />
                  )}
                </g>
              )}

              {/* Start / Middle / End X-axis labels */}
              {[0, Math.floor((series.length - 1) / 2), series.length - 1]
                .filter((v, i, a) => a.indexOf(v) === i && series[v])
                .map((idx) => (
                  <text
                    key={idx}
                    x={idxToX(idx)}
                    y={height - 7}
                    textAnchor={
                      idx === 0
                        ? 'start'
                        : idx === series.length - 1
                          ? 'end'
                          : 'middle'
                    }
                    fill="#94a3b8"
                    fontSize="9.5"
                    fontFamily="SF Mono, JetBrains Mono, monospace"
                  >
                    {series[idx].label}
                  </text>
                ))}
            </svg>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800/80 bg-[#0e1017] p-4 text-center text-xs text-slate-400">
          {chartTf} 週期已對齊之 BTCUSDT 已收盤 K 線不足 {metric?.minRequiredBars ?? 15} 根（目前 {metric?.alignedBarCount ?? 0} 根），無法繪製重疊曲線。
        </div>
      )}
    </div>
  );
};
