import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Ruler } from 'lucide-react';
import {
  KeyLevelsAndSessionAnalysis,
  Kline,
  LiquidityPoolLevel,
  SmcAnalysisResult,
  Timeframe,
} from '../types/market.ts';

interface KlineSmcChartProps {
  symbol: string;
  timeframe: Timeframe;
  klines: Kline[];
  smcAnalysis?: SmcAnalysisResult | null;
  liquidityPools?: LiquidityPoolLevel[];
  keyLevels?: KeyLevelsAndSessionAnalysis | null;
  compact?: boolean;
  titleOverride?: string;
}

function formatShortTime(tsMs: number): string {
  const d = new Date(tsMs);
  if (!Number.isFinite(d.getTime())) return '';
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

export const KlineSmcChart: React.FC<KlineSmcChartProps> = ({
  symbol,
  timeframe,
  klines,
  smcAnalysis,
  liquidityPools = [],
  keyLevels = null,
  compact = false,
  titleOverride,
}) => {
  const [visibleCount, setVisibleCount] = useState<number>(compact ? 36 : 48);
  const [panFromEnd, setPanFromEnd] = useState<number>(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showLiquidityPools, setShowLiquidityPools] = useState<boolean>(true);
  const [showKeyLevels, setShowKeyLevels] = useState<boolean>(true);
  const [rulerMode, setRulerMode] = useState<boolean>(false);
  const [rulerStart, setRulerStart] = useState<{
    index: number;
    price: number;
  } | null>(null);
  const [rulerEnd, setRulerEnd] = useState<{
    index: number;
    price: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    startX: number;
    startPan: number;
    moved: boolean;
  }>({ active: false, startX: 0, startPan: 0, moved: false });

  useEffect(() => {
    setVisibleCount(compact ? 36 : 48);
    setPanFromEnd(0);
    setHoverIdx(null);
    setRulerStart(null);
    setRulerEnd(null);
  }, [symbol, timeframe, compact]);

  const totalKlines = klines.length;
  const clampedVisibleCount = Math.min(
    Math.max(15, visibleCount),
    Math.max(15, totalKlines)
  );
  const maxPan = Math.max(0, totalKlines - clampedVisibleCount);
  const clampedPan = Math.min(Math.max(0, panFromEnd), maxPan);

  const visibleKlines = useMemo(() => {
    if (totalKlines === 0) return [];
    const endIdx = totalKlines - clampedPan;
    const startIdx = Math.max(0, endIdx - clampedVisibleCount);
    return klines.slice(startIdx, endIdx);
  }, [klines, totalKlines, clampedPan, clampedVisibleCount]);

  if (visibleKlines.length === 0) {
    return (
      <div className="apple-subcard flex h-56 items-center justify-center p-6 text-sm text-[var(--apple-text-secondary)]">
        無可用 K 線資料（禁止繪製虛構走勢）
      </div>
    );
  }

  const width = compact ? 540 : 820;
  const height = compact ? 225 : 290;
  const padTop = 22;
  const padBottom = 26;
  const padLeft = 10;
  const padRight = compact ? 64 : 78;

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const poolPrices =
    showLiquidityPools && liquidityPools.length > 0
      ? liquidityPools.map((p) => p.price)
      : [];
  const rawMinLow = Math.min(...visibleKlines.map((k) => k.low));
  const rawMaxHigh = Math.max(...visibleKlines.map((k) => k.high));
  const spanPad = Math.max((rawMaxHigh - rawMinLow) * 0.06, rawMaxHigh * 0.001);
  // Only expand bounds softly if a liquidity pool is close (within 15% of range)
  const nearPools = poolPrices.filter(
    (p) => p >= rawMinLow - spanPad * 3 && p <= rawMaxHigh + spanPad * 3
  );
  const minLow =
    nearPools.length > 0
      ? Math.min(rawMinLow, ...nearPools) - spanPad * 0.4
      : rawMinLow - spanPad * 0.4;
  const maxHigh =
    nearPools.length > 0
      ? Math.max(rawMaxHigh, ...nearPools) + spanPad * 0.4
      : rawMaxHigh + spanPad * 0.4;

  const priceRange = Math.max(maxHigh - minLow, maxHigh * 0.001, 1e-6);

  const priceToY = (price: number) => {
    const ratio = (price - minLow) / priceRange;
    return padTop + plotHeight - ratio * plotHeight;
  };

  const yToPrice = (y: number) => {
    const clampedY = Math.min(padTop + plotHeight, Math.max(padTop, y));
    const ratio = (padTop + plotHeight - clampedY) / plotHeight;
    return minLow + ratio * priceRange;
  };

  const stepX = plotWidth / visibleKlines.length;
  const candleWidth = Math.max(2.5, Math.min(12, stepX * 0.64));

  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toFixed(1);
    if (p >= 10) return p.toFixed(3);
    if (p >= 1) return p.toFixed(4);
    return p.toPrecision(4);
  };

  const gridPrices = [
    maxHigh,
    minLow + priceRange * 0.75,
    minLow + priceRange * 0.5,
    minLow + priceRange * 0.25,
    minLow,
  ];

  const bosOrMss = smcAnalysis?.bosOrMss;
  const fvg = smcAnalysis?.fvg;
  const orderBlock = smcAnalysis?.orderBlock;
  const liquiditySweep = smcAnalysis?.liquiditySweep;

  const activeKline =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < visibleKlines.length
      ? visibleKlines[hoverIdx]
      : visibleKlines[visibleKlines.length - 1];

  const activeBarPct =
    activeKline && activeKline.open > 0
      ? ((activeKline.close - activeKline.open) / activeKline.open) * 100
      : 0;
  const activeTakerBuyPct =
    activeKline &&
    typeof activeKline.takerBuyQuoteVolume === 'number' &&
    activeKline.quoteVolume > 0
      ? (activeKline.takerBuyQuoteVolume / activeKline.quoteVolume) * 100
      : null;

  const pointerToSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
    const rawIdx = Math.floor((x - padLeft) / stepX);
    const idx = Math.max(0, Math.min(visibleKlines.length - 1, rawIdx));
    return { x, y, idx, price: yToPrice(y) };
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (totalKlines <= 15) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 6 : -6;
    setVisibleCount((prev) =>
      Math.max(15, Math.min(totalKlines, prev + delta))
    );
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (rulerMode) {
      const pt = pointerToSvg(e.clientX, e.clientY);
      if (!pt) return;
      if (!rulerStart || (rulerStart && rulerEnd)) {
        setRulerStart({ index: pt.idx, price: pt.price });
        setRulerEnd(null);
      } else {
        setRulerEnd({ index: pt.idx, price: pt.price });
      }
      return;
    }
    dragStateRef.current = {
      active: true,
      startX: e.clientX,
      startPan: clampedPan,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = pointerToSvg(e.clientX, e.clientY);
    if (pt) {
      setHoverIdx(pt.idx);
    }
    if (dragStateRef.current.active && !rulerMode && svgRef.current) {
      const dx = e.clientX - dragStateRef.current.startX;
      if (Math.abs(dx) > 4) {
        dragStateRef.current.moved = true;
      }
      const rectWidth = svgRef.current.getBoundingClientRect().width || width;
      const barsPerPx = clampedVisibleCount / Math.max(100, rectWidth * 0.85);
      const barShift = Math.round(dx * barsPerPx);
      setPanFromEnd(Math.max(0, Math.min(maxPan, dragStateRef.current.startPan + barShift)));
    }
  };

  const handlePointerUpOrLeave = () => {
    dragStateRef.current.active = false;
  };

  const rulerActiveEnd =
    rulerEnd ??
    (rulerMode && rulerStart && hoverIdx !== null
      ? { index: hoverIdx, price: visibleKlines[hoverIdx]?.close ?? rulerStart.price }
      : null);

  const isDefaultView =
    clampedPan === 0 && clampedVisibleCount === (compact ? 36 : 48);

  return (
    <div className="apple-subcard p-3.5 space-y-2.5">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--apple-text-secondary)]">
        <div className="flex flex-wrap items-center gap-2 tabular-nums">
          <span className="font-semibold text-[var(--apple-text-primary)]">
            {titleOverride ?? `${symbol} · ${timeframe} 互動結構圖`}
          </span>
          {smcAnalysis && !compact && (
            <>
              <span aria-hidden="true">·</span>
              <span>已收盤 {smcAnalysis.confirmedKlineCount} 根</span>
              {smcAnalysis.atr14 !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    ATR(14): {smcAnalysis.atr14} ({smcAnalysis.atrPercent}%)
                  </span>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => {
              setRulerMode((v) => !v);
              setRulerStart(null);
              setRulerEnd(null);
            }}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 cursor-pointer transition-colors ${
              rulerMode
                ? 'border-amber-400/70 bg-amber-500/20 text-amber-200 font-semibold'
                : 'border-slate-700 bg-slate-900/70 text-slate-300 hover:text-slate-100'
            }`}
            title="啟用測距尺：點擊圖上兩點計算價格幅與 K 線根數"
          >
            <Ruler className="h-3 w-3" />
            <span>{rulerMode ? '測距中 (點兩點)' : '測距尺'}</span>
          </button>
          {liquidityPools.length > 0 && (
            <button
              type="button"
              onClick={() => setShowLiquidityPools((v) => !v)}
              className={`rounded-md border px-2 py-0.5 cursor-pointer transition-colors ${
                showLiquidityPools
                  ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-700 bg-slate-900/70 text-slate-400'
              }`}
            >
              清算池 {showLiquidityPools ? '開' : '關'}
            </button>
          )}
          {keyLevels && keyLevels.anchors.length > 0 && (
            <button
              type="button"
              onClick={() => setShowKeyLevels((v) => !v)}
              className={`rounded-md border px-2 py-0.5 cursor-pointer transition-colors ${
                showKeyLevels
                  ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
                  : 'border-slate-700 bg-slate-900/70 text-slate-400'
              }`}
              title="切換顯示前日高低點 (PDH/PDL)、日/週線開盤價與日內 VWAP"
            >
              關鍵位/VWAP {showKeyLevels ? '開' : '關'}
            </button>
          )}
          {!isDefaultView && (
            <button
              type="button"
              onClick={() => {
                setVisibleCount(compact ? 36 : 48);
                setPanFromEnd(0);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-slate-300 hover:text-slate-100 cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              <span>重置視角</span>
            </button>
          )}
        </div>
      </div>

      {/* Live Crosshair OHLCV + Taker Buy HUD */}
      {activeKline && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-slate-950/80 px-2.5 py-1 text-[11px] font-mono tabular-nums text-slate-300">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-slate-400">
              {formatShortTime(activeKline.openTime)} UTC
            </span>
            <span>O:{formatPrice(activeKline.open)}</span>
            <span>H:{formatPrice(activeKline.high)}</span>
            <span>L:{formatPrice(activeKline.low)}</span>
            <span
              className={
                activeBarPct >= 0
                  ? 'text-emerald-400 font-semibold'
                  : 'text-rose-400 font-semibold'
              }
            >
              C:{formatPrice(activeKline.close)} ({activeBarPct >= 0 ? '+' : ''}
              {activeBarPct.toFixed(2)}%)
            </span>
            {activeTakerBuyPct !== null && (
              <span
                className={
                  activeTakerBuyPct >= 52
                    ? 'text-emerald-300'
                    : activeTakerBuyPct <= 48
                      ? 'text-rose-300'
                      : 'text-slate-300'
                }
              >
                Taker買:{activeTakerBuyPct.toFixed(0)}%
              </span>
            )}
          </div>
          {!compact && (
            <span className="font-sans text-[10px] text-slate-400">
              滾輪縮放 ({visibleKlines.length} 根) · 拖曳平移 · 懸停十字線
            </span>
          )}
        </div>
      )}

      {/* Interactive SVG Canvas */}
      <div className="relative w-full overflow-hidden rounded-xl bg-[#0e1017] p-1.5">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className={`${compact ? 'h-52' : 'h-72'} w-full select-none ${
            rulerMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
          }`}
          role="img"
          aria-label={`${symbol} ${timeframe} 互動 K 線與 SMC/ICT 結構圖`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrLeave}
          onPointerLeave={() => {
            handlePointerUpOrLeave();
            setHoverIdx(null);
          }}
        >
          {/* Horizontal Price Grid */}
          {gridPrices.map((gp, idx) => {
            const y = priceToY(gp);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="rgba(148, 163, 184, 0.14)"
                  strokeDasharray="2 3"
                  strokeWidth={1}
                />
                <text
                  x={width - padRight + 6}
                  y={y + 3}
                  fill="#94a3b8"
                  fontSize="10"
                  fontFamily="SF Mono, JetBrains Mono, monospace"
                >
                  {formatPrice(gp)}
                </text>
              </g>
            );
          })}

          {/* Order Block Zone (extended right) */}
          {orderBlock?.detected &&
            orderBlock.high !== null &&
            orderBlock.low !== null && (
              <g>
                <rect
                  x={padLeft}
                  y={Math.min(priceToY(orderBlock.high), priceToY(orderBlock.low))}
                  width={plotWidth}
                  height={Math.max(
                    3,
                    Math.abs(priceToY(orderBlock.low) - priceToY(orderBlock.high))
                  )}
                  fill={
                    orderBlock.direction === 'BULL'
                      ? 'rgba(16, 185, 129, 0.14)'
                      : 'rgba(244, 63, 94, 0.14)'
                  }
                  stroke={
                    orderBlock.direction === 'BULL'
                      ? 'rgba(16, 185, 129, 0.45)'
                      : 'rgba(244, 63, 94, 0.45)'
                  }
                  strokeWidth={0.8}
                />
                <text
                  x={padLeft + 6}
                  y={
                    Math.min(priceToY(orderBlock.high), priceToY(orderBlock.low)) +
                    10
                  }
                  fill="#cbd5e1"
                  fontSize="9.5"
                  fontFamily="SF Mono, JetBrains Mono, monospace"
                >
                  {orderBlock.direction} OB [{formatPrice(orderBlock.low)}–
                  {formatPrice(orderBlock.high)}]
                </text>
              </g>
            )}

          {/* Fair Value Gap (FVG) Zone (extended right) */}
          {fvg?.detected && fvg.top !== null && fvg.bottom !== null && (
            <g>
              <rect
                x={padLeft + plotWidth * 0.25}
                y={Math.min(priceToY(fvg.top), priceToY(fvg.bottom))}
                width={plotWidth * 0.75}
                height={Math.max(
                  3,
                  Math.abs(priceToY(fvg.bottom) - priceToY(fvg.top))
                )}
                fill="rgba(10, 132, 255, 0.16)"
                stroke="rgba(10, 132, 255, 0.55)"
                strokeDasharray="3 2"
                strokeWidth={0.8}
              />
              <text
                x={padLeft + plotWidth * 0.26}
                y={Math.min(priceToY(fvg.top), priceToY(fvg.bottom)) - 3}
                fill="#60a5fa"
                fontSize="9.5"
                fontFamily="SF Mono, JetBrains Mono, monospace"
              >
                {fvg.direction} FVG {fvg.mitigated ? '(已回補)' : '(未回補)'}
              </text>
            </g>
          )}

          {/* BOS / MSS Structural Level Line */}
          {bosOrMss?.detected && bosOrMss.brokenLevel !== null && (
            <g>
              <line
                x1={padLeft}
                y1={priceToY(bosOrMss.brokenLevel)}
                x2={width - padRight}
                y2={priceToY(bosOrMss.brokenLevel)}
                stroke="#f59e0b"
                strokeDasharray="5 3"
                strokeWidth={1.2}
              />
              <text
                x={padLeft + 6}
                y={priceToY(bosOrMss.brokenLevel) - 4}
                fill="#fcd34d"
                fontSize="10"
                fontFamily="SF Mono, JetBrains Mono, monospace"
              >
                {bosOrMss.type} @ {formatPrice(bosOrMss.brokenLevel)}
              </text>
            </g>
          )}

          {/* Liquidity Sweep Level Line */}
          {liquiditySweep?.detected && liquiditySweep.sweptLevel !== null && (
            <g>
              <line
                x1={padLeft}
                y1={priceToY(liquiditySweep.sweptLevel)}
                x2={width - padRight}
                y2={priceToY(liquiditySweep.sweptLevel)}
                stroke="#38bdf8"
                strokeDasharray="2 2"
                strokeWidth={1}
              />
              <text
                x={width - padRight - 180}
                y={priceToY(liquiditySweep.sweptLevel) - 4}
                fill="#38bdf8"
                fontSize="9.5"
                fontFamily="SF Mono, JetBrains Mono, monospace"
              >
                Sweep ({liquiditySweep.side}) @{' '}
                {formatPrice(liquiditySweep.sweptLevel)}
              </text>
            </g>
          )}

          {/* Optional Estimated Liquidation Pools */}
          {showLiquidityPools &&
            liquidityPools.map((pool) => {
              if (pool.price < minLow || pool.price > maxHigh) return null;
              const py = priceToY(pool.price);
              const isBuySide = pool.side === 'BUY_SIDE_LIQ';
              const strokeCol = isBuySide
                ? 'rgba(251, 191, 36, 0.7)'
                : 'rgba(168, 85, 247, 0.7)';
              return (
                <g key={pool.id}>
                  <line
                    x1={padLeft}
                    y1={py}
                    x2={width - padRight}
                    y2={py}
                    stroke={strokeCol}
                    strokeDasharray="4 4"
                    strokeWidth={1}
                  />
                  <text
                    x={width - padRight - 145}
                    y={py - 3}
                    fill={isBuySide ? '#fbbf24' : '#c084fc'}
                    fontSize="9"
                    fontFamily="SF Mono, JetBrains Mono, monospace"
                  >
                    {isBuySide ? 'BSL 清算池' : 'SSL 清算池'} @{' '}
                    {formatPrice(pool.price)}
                  </text>
                </g>
              );
            })}

          {/* Optional Key Level Anchors (PDH / PDL / DO / WO / VWAP) */}
          {showKeyLevels &&
            keyLevels &&
            keyLevels.anchors.map((anchor) => {
              if (anchor.price < minLow || anchor.price > maxHigh) return null;
              const ay = priceToY(anchor.price);
              const colorMap: Record<string, string> = {
                PDH: '#fb7185',
                PDL: '#34d399',
                DAILY_OPEN: '#38bdf8',
                WEEKLY_OPEN: '#a78bfa',
                VWAP: '#fbbf24',
              };
              const strokeCol = colorMap[anchor.key] ?? '#cbd5e1';
              return (
                <g key={anchor.key}>
                  <line
                    x1={padLeft}
                    y1={ay}
                    x2={width - padRight}
                    y2={ay}
                    stroke={strokeCol}
                    strokeOpacity={anchor.key === 'VWAP' ? 0.85 : 0.65}
                    strokeDasharray={anchor.key === 'VWAP' ? undefined : '6 4'}
                    strokeWidth={anchor.key === 'VWAP' ? 1.25 : 0.95}
                  />
                  <text
                    x={padLeft + 6}
                    y={ay - 3}
                    fill={strokeCol}
                    fontSize="9"
                    fontFamily="SF Mono, JetBrains Mono, monospace"
                  >
                    {anchor.shortLabel} {formatPrice(anchor.price)}
                  </text>
                </g>
              );
            })}

          {/* Candlesticks */}
          {visibleKlines.map((k, index) => {
            const centerX = padLeft + index * stepX + stepX / 2;
            const isBull = k.close >= k.open;
            const color = !k.isClosed
              ? '#94a3b8'
              : isBull
                ? '#10b981'
                : '#f43f5e';
            const highY = priceToY(k.high);
            const lowY = priceToY(k.low);
            const openY = priceToY(k.open);
            const closeY = priceToY(k.close);
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));

            return (
              <g key={k.openTime} opacity={k.isClosed ? 1 : 0.45}>
                <line
                  x1={centerX}
                  y1={highY}
                  x2={centerX}
                  y2={lowY}
                  stroke={color}
                  strokeWidth={1.1}
                />
                <rect
                  x={centerX - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  fill={color}
                  stroke={!k.isClosed ? '#e2e8f0' : 'none'}
                  strokeDasharray={!k.isClosed ? '2 1' : undefined}
                />
              </g>
            );
          })}

          {/* Ruler Measurement Overlay */}
          {rulerStart && rulerActiveEnd && (() => {
            const x1 = padLeft + rulerStart.index * stepX + stepX / 2;
            const x2 = padLeft + rulerActiveEnd.index * stepX + stepX / 2;
            const y1 = priceToY(rulerStart.price);
            const y2 = priceToY(rulerActiveEnd.price);
            const pctDiff =
              rulerStart.price > 0
                ? ((rulerActiveEnd.price - rulerStart.price) /
                    rulerStart.price) *
                  100
                : 0;
            const barDiff = Math.abs(rulerActiveEnd.index - rulerStart.index);
            return (
              <g>
                <rect
                  x={Math.min(x1, x2)}
                  y={Math.min(y1, y2)}
                  width={Math.max(4, Math.abs(x2 - x1))}
                  height={Math.max(4, Math.abs(y2 - y1))}
                  fill={
                    pctDiff >= 0
                      ? 'rgba(16, 185, 129, 0.16)'
                      : 'rgba(244, 63, 94, 0.16)'
                  }
                  stroke={pctDiff >= 0 ? '#10b981' : '#f43f5e'}
                  strokeDasharray="3 2"
                  strokeWidth={1.1}
                />
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#f8fafc"
                  strokeWidth={1}
                />
                <text
                  x={Math.min(width - padRight - 140, Math.max(padLeft + 8, (x1 + x2) / 2 - 55))}
                  y={Math.max(padTop + 14, Math.min(y1, y2) - 4)}
                  fill="#f8fafc"
                  fontSize="10"
                  fontFamily="SF Mono, JetBrains Mono, monospace"
                >
                  {pctDiff >= 0 ? '+' : ''}
                  {pctDiff.toFixed(2)}% ({barDiff}根)
                </text>
              </g>
            );
          })()}

          {/* Interactive Crosshair */}
          {hoverIdx !== null && visibleKlines[hoverIdx] && (
            <g pointerEvents="none">
              <line
                x1={padLeft + hoverIdx * stepX + stepX / 2}
                y1={padTop}
                x2={padLeft + hoverIdx * stepX + stepX / 2}
                y2={padTop + plotHeight}
                stroke="rgba(226, 232, 240, 0.32)"
                strokeDasharray="3 3"
              />
              <line
                x1={padLeft}
                y1={priceToY(visibleKlines[hoverIdx].close)}
                x2={width - padRight}
                y2={priceToY(visibleKlines[hoverIdx].close)}
                stroke="rgba(226, 232, 240, 0.28)"
                strokeDasharray="3 3"
              />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};
