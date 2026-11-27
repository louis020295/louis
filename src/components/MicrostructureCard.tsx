import React from 'react';
import { BookOpen, Layers } from 'lucide-react';
import { MarketMicrostructureAnalysis } from '../types/market.ts';

interface MicrostructureCardProps {
  data: MarketMicrostructureAnalysis | null | undefined;
}

function formatUsdCompact(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return 'N/A';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPriceShort(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return 'N/A';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

export const MicrostructureCard: React.FC<MicrostructureCardProps> = ({
  data,
}) => {
  if (!data) return null;

  const { spotPerpBasis, orderbook } = data;

  const basisColorClass =
    spotPerpBasis.regime === 'SPOT_LED_HEALTHY'
      ? 'text-emerald-400'
      : spotPerpBasis.regime === 'PERP_OVERHEATED_PREMIUM'
        ? 'text-rose-400'
        : spotPerpBasis.regime === 'PERP_DISCOUNT_FEAR'
          ? 'text-amber-300'
          : 'text-slate-200';

  const bidDepth50 = orderbook.bidDepth50bpsUsd ?? 0;
  const askDepth50 = orderbook.askDepth50bpsUsd ?? 0;
  const totalDepth50 = bidDepth50 + askDepth50;
  const bidShare50 =
    totalDepth50 > 0 ? Math.min(95, Math.max(5, (bidDepth50 / totalDepth50) * 100)) : 50;

  return (
    <div
      id="microstructure-panel"
      className="@container apple-subcard p-4 space-y-3.5 overflow-hidden"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs min-w-0">
          <Layers className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
          <h4 className="font-semibold text-[var(--apple-text-primary)] truncate">
            期現基差結構 &amp; 訂單簿深度 / 市價滑點預估 ({data.symbol})
          </h4>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-slate-400 shrink-0">
          {orderbook.status === 'READY' && orderbook.spreadBps !== null
            ? `盤口價差 ${orderbook.spreadBps.toFixed(2)} bps`
            : '即時深度狀態'}
        </span>
      </div>

      {/* Main Layout: Stacks in split mode, 2 columns when full-width */}
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        {/* Column 1: Spot vs Perp Basis & Volume Ratio */}
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-200">
              1. 現貨 vs 合約基差與量能結構
            </span>
            <span className={`font-mono text-[11px] font-semibold shrink-0 ${basisColorClass}`}>
              {spotPerpBasis.regimeLabelZh}
            </span>
          </div>

          {spotPerpBasis.status === 'READY' ? (
            <>
              <div className="grid grid-cols-1 gap-2 @sm:grid-cols-3 font-mono tabular-nums text-xs">
                <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5">
                  <div className="font-sans text-[10px] text-slate-400 truncate">
                    期現基差 (Basis)
                  </div>
                  <div className={`mt-0.5 text-sm font-bold truncate ${basisColorClass}`}>
                    {spotPerpBasis.basisPct !== null
                      ? `${spotPerpBasis.basisPct >= 0 ? '+' : ''}${spotPerpBasis.basisPct.toFixed(3)}%`
                      : 'N/A'}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {spotPerpBasis.basisBps !== null
                      ? `${spotPerpBasis.basisBps >= 0 ? '+' : ''}${spotPerpBasis.basisBps.toFixed(1)} bps`
                      : '—'}
                  </div>
                </div>

                <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5">
                  <div className="font-sans text-[10px] text-slate-400 truncate">
                    合約 / 現貨量比
                  </div>
                  <div
                    className={`mt-0.5 text-sm font-bold truncate ${
                      spotPerpBasis.perpToSpotVolumeRatio !== null &&
                      spotPerpBasis.perpToSpotVolumeRatio >= 6
                        ? 'text-amber-300'
                        : spotPerpBasis.perpToSpotVolumeRatio !== null &&
                            spotPerpBasis.perpToSpotVolumeRatio <= 2.2
                          ? 'text-emerald-400'
                          : 'text-slate-100'
                    }`}
                  >
                    {spotPerpBasis.perpToSpotVolumeRatio !== null
                      ? `${spotPerpBasis.perpToSpotVolumeRatio.toFixed(2)}x`
                      : 'N/A'}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    現貨 {formatUsdCompact(spotPerpBasis.spotQuoteVolume24h)}
                  </div>
                </div>

                <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5">
                  <div className="font-sans text-[10px] text-slate-400 truncate">
                    現貨報價 ({spotPerpBasis.spotSymbol})
                  </div>
                  <div className="mt-0.5 text-sm font-bold text-slate-100 truncate">
                    {formatPriceShort(spotPerpBasis.spotPrice)}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    合約 {formatPriceShort(spotPerpBasis.perpPrice)}
                  </div>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-300 break-words">
                {spotPerpBasis.interpretationZh}
              </p>
            </>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400 break-words">
              {spotPerpBasis.interpretationZh}
            </div>
          )}
        </div>

        {/* Column 2: Orderbook Depth OBI & Whale Walls */}
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200 min-w-0">
              <BookOpen className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="truncate">2. 盤口掛單失衡 (OBI) 與巨鯨深度牆</span>
            </span>
            <span
              className={`font-mono text-[11px] font-semibold shrink-0 ${
                (orderbook.obi50bpsPct ?? 0) >= 10
                  ? 'text-emerald-400'
                  : (orderbook.obi50bpsPct ?? 0) <= -10
                    ? 'text-rose-400'
                    : 'text-slate-300'
              }`}
            >
              {orderbook.imbalanceLabelZh}
            </span>
          </div>

          {orderbook.status === 'READY' ? (
            <>
              {/* Visual OBI Balance Bar (±0.5% depth) */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
                  <span className="text-emerald-400">
                    買盤 ±0.5%: {formatUsdCompact(orderbook.bidDepth50bpsUsd)}
                  </span>
                  <span className="font-semibold text-slate-200">
                    OBI{' '}
                    {orderbook.obi50bpsPct !== null
                      ? `${orderbook.obi50bpsPct >= 0 ? '+' : ''}${orderbook.obi50bpsPct.toFixed(1)}%`
                      : 'N/A'}
                  </span>
                  <span className="text-rose-400">
                    賣盤 ±0.5%: {formatUsdCompact(orderbook.askDepth50bpsUsd)}
                  </span>
                </div>
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="bg-emerald-500/80 transition-all"
                    style={{ width: `${bidShare50.toFixed(1)}%` }}
                  />
                  <div
                    className="bg-rose-500/80 transition-all"
                    style={{ width: `${(100 - bidShare50).toFixed(1)}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-slate-400">
                  <span>±1.0% 買盤 {formatUsdCompact(orderbook.bidDepth100bpsUsd)}</span>
                  <span>
                    ±1.0% OBI{' '}
                    {orderbook.obi100bpsPct !== null
                      ? `${orderbook.obi100bpsPct >= 0 ? '+' : ''}${orderbook.obi100bpsPct.toFixed(1)}%`
                      : 'N/A'}
                  </span>
                  <span>±1.0% 賣盤 {formatUsdCompact(orderbook.askDepth100bpsUsd)}</span>
                </div>
              </div>

              {/* Whale Walls Grid */}
              <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 font-mono tabular-nums text-[11px]">
                <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800/80 bg-slate-900/50 p-2.5 space-y-1">
                  <div className="font-sans text-[10px] font-semibold text-emerald-300">
                    下方買單牆 (支撐掛單)
                  </div>
                  {orderbook.bidWalls.length > 0 ? (
                    orderbook.bidWalls.slice(0, 2).map((w, idx) => (
                      <div
                        key={`bw-${idx}`}
                        className="flex items-center justify-between gap-2 text-[11px] min-w-0"
                      >
                        <span className="text-slate-200 truncate">
                          {formatPriceShort(w.price)}{' '}
                          <span className="text-slate-400">
                            ({w.distancePct.toFixed(2)}%)
                          </span>
                        </span>
                        <span className="font-semibold text-emerald-400 shrink-0">
                          {formatUsdCompact(w.notionalUsd)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="font-sans text-[10px] text-slate-500">
                      ±2.5% 內無顯著買單巨鯨牆
                    </div>
                  )}
                </div>

                <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800/80 bg-slate-900/50 p-2.5 space-y-1">
                  <div className="font-sans text-[10px] font-semibold text-rose-300">
                    上方賣單牆 (反壓掛單)
                  </div>
                  {orderbook.askWalls.length > 0 ? (
                    orderbook.askWalls.slice(0, 2).map((w, idx) => (
                      <div
                        key={`aw-${idx}`}
                        className="flex items-center justify-between gap-2 text-[11px] min-w-0"
                      >
                        <span className="text-slate-200 truncate">
                          {formatPriceShort(w.price)}{' '}
                          <span className="text-slate-400">
                            (+{w.distancePct.toFixed(2)}%)
                          </span>
                        </span>
                        <span className="font-semibold text-rose-400 shrink-0">
                          {formatUsdCompact(w.notionalUsd)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="font-sans text-[10px] text-slate-500">
                      ±2.5% 內無顯著賣單巨鯨牆
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400 break-words">
              {orderbook.interpretationZh}
            </div>
          )}
        </div>
      </div>

      {/* Slippage Simulation Strip */}
      {orderbook.status === 'READY' && orderbook.slippageTiers.length > 0 && (
        <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-200">
              市價單即時深度滑點預估 (Orderbook Walk Simulation)
            </span>
            <span className="text-[11px] text-slate-400 break-words">
              {orderbook.interpretationZh}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 @lg:grid-cols-3 font-mono tabular-nums text-[11px]">
            {orderbook.slippageTiers.map((tier) => (
              <div
                key={tier.notionalUsd}
                className="min-w-0 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-slate-900/50 px-3 py-2"
              >
                <span className="font-semibold text-slate-200 shrink-0">
                  {formatUsdCompact(tier.notionalUsd)} 市價
                </span>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span
                    className={
                      (tier.buySlippageBps ?? 0) >= 15
                        ? 'text-rose-400 font-semibold'
                        : 'text-emerald-300'
                    }
                  >
                    買 {tier.buySlippageBps !== null ? `${tier.buySlippageBps.toFixed(1)}bp` : 'N/A'}
                    {!tier.buyDepthCovered ? '+' : ''}
                  </span>
                  <span
                    className={
                      (tier.sellSlippageBps ?? 0) >= 15
                        ? 'text-rose-400 font-semibold'
                        : 'text-sky-300'
                    }
                  >
                    賣 {tier.sellSlippageBps !== null ? `${tier.sellSlippageBps.toFixed(1)}bp` : 'N/A'}
                    {!tier.sellDepthCovered ? '+' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
