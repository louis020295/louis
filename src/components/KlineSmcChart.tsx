import React from 'react';
import { Kline, SmcAnalysisResult, Timeframe } from '../types/market.ts';

interface KlineSmcChartProps {
  symbol: string;
  timeframe: Timeframe;
  klines: Kline[];
  smcAnalysis: SmcAnalysisResult;
}

export const KlineSmcChart: React.FC<KlineSmcChartProps> = ({
  symbol,
  timeframe,
  klines,
  smcAnalysis,
}) => {
  const visibleKlines = klines.slice(-48);

  if (visibleKlines.length === 0) {
    return (
      <div className="apple-subcard flex h-64 items-center justify-center p-6 text-sm text-[var(--apple-text-secondary)]">
        無可用 K 線資料（禁止繪製虛構走勢）
      </div>
    );
  }

  const width = 820;
  const height = 270;
  const padTop = 20;
  const padBottom = 26;
  const padLeft = 12;
  const padRight = 76;

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const minLow = Math.min(...visibleKlines.map((k) => k.low));
  const maxHigh = Math.max(...visibleKlines.map((k) => k.high));
  const priceRange = Math.max(maxHigh - minLow, maxHigh * 0.001, 1e-6);

  const priceToY = (price: number) => {
    const ratio = (price - minLow) / priceRange;
    return padTop + plotHeight - ratio * plotHeight;
  };

  const stepX = plotWidth / visibleKlines.length;
  const candleWidth = Math.max(3, Math.min(11, stepX * 0.64));

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

  const { bosOrMss, fvg, orderBlock, liquiditySweep } = smcAnalysis;

  return (
    <div className="apple-subcard p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--apple-text-secondary)]">
        <div className="flex flex-wrap items-center gap-2 tabular-nums">
          <span className="font-semibold text-[var(--apple-text-primary)]">
            {symbol} · {timeframe} 結構證據圖
          </span>
          <span aria-hidden="true">·</span>
          <span>已確認收盤 K 線: {smcAnalysis.confirmedKlineCount} 根</span>
          <span aria-hidden="true">·</span>
          <span>忽略未收盤 K 線: {smcAnalysis.unclosedKlineIgnoredCount} 根</span>
          {smcAnalysis.atr14 !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                ATR(14): {smcAnalysis.atr14} ({smcAnalysis.atrPercent}%)
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--apple-text-secondary)]">
          <span className="text-emerald-600 dark:text-emerald-400">■ 多頭收盤</span>
          <span className="text-rose-600 dark:text-rose-400">■ 空頭收盤</span>
          <span className="text-amber-600 dark:text-amber-400">--- BOS/MSS 結構線</span>
          <span className="text-blue-600 dark:text-blue-400">▒ FVG 失衡區</span>
          <span className="text-[var(--apple-text-secondary)]">▒ Order Block</span>
        </div>
      </div>

      <div className="relative w-full overflow-x-auto rounded-xl bg-[#0e1017] p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-64 w-full min-w-[600px] select-none"
          role="img"
          aria-label={`${symbol} ${timeframe} K線與 SMC/ICT 結構圖`}
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
                  stroke="rgba(148, 163, 184, 0.16)"
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

          {/* Order Block Zone */}
          {orderBlock.detected &&
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

          {/* Fair Value Gap (FVG) Zone */}
          {fvg.detected && fvg.top !== null && fvg.bottom !== null && (
            <g>
              <rect
                x={padLeft + plotWidth * 0.35}
                y={Math.min(priceToY(fvg.top), priceToY(fvg.bottom))}
                width={plotWidth * 0.65}
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
                x={padLeft + plotWidth * 0.36}
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
          {bosOrMss.detected && bosOrMss.brokenLevel !== null && (
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
          {liquiditySweep.detected && liquiditySweep.sweptLevel !== null && (
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
                x={width - padRight - 185}
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
        </svg>
      </div>
    </div>
  );
};
