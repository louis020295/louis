import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, RotateCcw, ShieldAlert } from 'lucide-react';
import {
  BtcKlineCorrelationAnalysis,
  EntryZoneAnalysis,
  MarketMicrostructureAnalysis,
  OrderBookLevel,
  PaperLedgerEntry,
  ScannedCandidate,
  SmcAnalysisResult,
} from '../types/market.ts';

interface PositionRiskPlannerCardProps {
  symbol: string;
  candidate: ScannedCandidate;
  smcAnalysis: SmcAnalysisResult;
  entryZoneAnalysis?: EntryZoneAnalysis | null;
  btcCorrelation?: BtcKlineCorrelationAnalysis | null;
  microstructure?: MarketMicrostructureAnalysis | null;
  existingOpenOrders?: PaperLedgerEntry[];
  highBtcLongCount?: number;
  highBtcShortCount?: number;
  onCreatePullbackAlert?: (
    price: number,
    direction: 'LONG' | 'SHORT',
    note: string
  ) => void;
  onRecordPullbackPaper?: (params: {
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    invalidationPrice: number;
    targetPrice: number;
    anchorLabel: string;
    ttlMinutes?: number;
  }) => void;
}

function estimateNotionalSlippage(
  levels: OrderBookLevel[],
  notionalUsd: number,
  midPrice: number
): { slippageBps: number; slippageUsdt: number; depthCovered: boolean } | null {
  if (levels.length === 0 || notionalUsd <= 0 || midPrice <= 0) return null;
  let remaining = notionalUsd;
  let totalQty = 0;
  let totalSpent = 0;
  for (const lvl of levels) {
    if (remaining <= 1e-6) break;
    const lvlUsd = lvl.price * lvl.quantity;
    if (lvlUsd >= remaining) {
      totalQty += remaining / lvl.price;
      totalSpent += remaining;
      remaining = 0;
      break;
    }
    totalQty += lvl.quantity;
    totalSpent += lvlUsd;
    remaining -= lvlUsd;
  }
  if (totalQty <= 0) return null;
  const avgPrice = totalSpent / totalQty;
  const slippageBps = Math.abs((avgPrice - midPrice) / midPrice) * 10_000;
  const slippageUsdt = notionalUsd * (slippageBps / 10_000);
  return {
    slippageBps,
    slippageUsdt,
    depthCovered: remaining <= 1e-4,
  };
}

const STORAGE_KEY = 'crypto_radar_risk_planner_v1';

interface StoredPrefs {
  equityUsdt: number;
  riskPercent: number;
  roundTripFeePct: number;
}

function loadPrefs(): StoredPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        equityUsdt:
          Number(parsed.equityUsdt) > 0 ? Number(parsed.equityUsdt) : 10000,
        riskPercent:
          Number(parsed.riskPercent) > 0 ? Number(parsed.riskPercent) : 1.0,
        roundTripFeePct:
          Number(parsed.roundTripFeePct) >= 0
            ? Number(parsed.roundTripFeePct)
            : 0.1,
      };
    }
  } catch {
    // ignore storage errors
  }
  return { equityUsdt: 10000, riskPercent: 1.0, roundTripFeePct: 0.1 };
}

function deriveSuggestedLevels(
  lastPrice: number,
  side: 'LONG' | 'SHORT',
  smcAnalysis: SmcAnalysisResult
): { entry: number; stop: number; target: number; basisLabel: string } {
  const atr = smcAnalysis.atr14 ?? lastPrice * 0.015;
  let stop =
    side === 'LONG' ? lastPrice - atr * 1.5 : lastPrice + atr * 1.5;
  let basisLabel = '1.5 × ATR(14) 預設結構止損';

  if (
    side === 'LONG' &&
    smcAnalysis.orderBlock.detected &&
    smcAnalysis.orderBlock.direction === 'BULL' &&
    smcAnalysis.orderBlock.low !== null &&
    smcAnalysis.orderBlock.low < lastPrice
  ) {
    stop = smcAnalysis.orderBlock.low * 0.998;
    basisLabel = 'Bullish Order Block 下緣結構止損';
  } else if (
    side === 'SHORT' &&
    smcAnalysis.orderBlock.detected &&
    smcAnalysis.orderBlock.direction === 'BEAR' &&
    smcAnalysis.orderBlock.high !== null &&
    smcAnalysis.orderBlock.high > lastPrice
  ) {
    stop = smcAnalysis.orderBlock.high * 1.002;
    basisLabel = 'Bearish Order Block 上緣結構止損';
  } else if (
    side === 'LONG' &&
    smcAnalysis.liquiditySweep.detected &&
    smcAnalysis.liquiditySweep.side === 'SELL_SIDE_SWEPT' &&
    smcAnalysis.liquiditySweep.sweptLevel !== null &&
    smcAnalysis.liquiditySweep.sweptLevel < lastPrice
  ) {
    stop = smcAnalysis.liquiditySweep.sweptLevel * 0.998;
    basisLabel = 'Sell-Side Sweep 低點下方止損';
  } else if (
    side === 'SHORT' &&
    smcAnalysis.liquiditySweep.detected &&
    smcAnalysis.liquiditySweep.side === 'BUY_SIDE_SWEPT' &&
    smcAnalysis.liquiditySweep.sweptLevel !== null &&
    smcAnalysis.liquiditySweep.sweptLevel > lastPrice
  ) {
    stop = smcAnalysis.liquiditySweep.sweptLevel * 1.002;
    basisLabel = 'Buy-Side Sweep 高點上方止損';
  }

  const riskPerUnit = Math.max(Math.abs(lastPrice - stop), lastPrice * 0.002);
  const target =
    side === 'LONG' ? lastPrice + riskPerUnit * 2 : lastPrice - riskPerUnit * 2;

  return {
    entry: Number(lastPrice.toPrecision(6)),
    stop: Number(Math.max(1e-8, stop).toPrecision(6)),
    target: Number(Math.max(1e-8, target).toPrecision(6)),
    basisLabel,
  };
}

export const PositionRiskPlannerCard: React.FC<
  PositionRiskPlannerCardProps
> = ({
  symbol,
  candidate,
  smcAnalysis,
  entryZoneAnalysis,
  btcCorrelation,
  microstructure,
  existingOpenOrders = [],
  highBtcLongCount = 0,
  highBtcShortCount = 0,
  onCreatePullbackAlert,
  onRecordPullbackPaper,
}) => {
  const initialPrefs = useMemo(() => loadPrefs(), []);
  const [equityUsdt, setEquityUsdt] = useState<number>(initialPrefs.equityUsdt);
  const [riskPercent, setRiskPercent] = useState<number>(
    initialPrefs.riskPercent
  );
  const [roundTripFeePct, setRoundTripFeePct] = useState<number>(
    initialPrefs.roundTripFeePct
  );

  const defaultSide: 'LONG' | 'SHORT' =
    smcAnalysis.intendedDirection === 'SHORT' ||
    candidate.marketRadarCategory === '雷達空頭觀察'
      ? 'SHORT'
      : 'LONG';

  const [side, setSide] = useState<'LONG' | 'SHORT'>(defaultSide);
  const [limitTtlMinutes, setLimitTtlMinutes] = useState<number>(240);
  const suggested = useMemo(
    () => deriveSuggestedLevels(candidate.lastPrice, side, smcAnalysis),
    [candidate.lastPrice, side, smcAnalysis]
  );

  const [entryInput, setEntryInput] = useState<string>(String(suggested.entry));
  const [stopInput, setStopInput] = useState<string>(String(suggested.stop));
  const [targetInput, setTargetInput] = useState<string>(
    String(suggested.target)
  );

  useEffect(() => {
    setSide(defaultSide);
  }, [symbol, defaultSide]);

  useEffect(() => {
    setEntryInput(String(suggested.entry));
    setStopInput(String(suggested.stop));
    setTargetInput(String(suggested.target));
  }, [suggested]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ equityUsdt, riskPercent, roundTripFeePct })
      );
    } catch {
      // ignore
    }
  }, [equityUsdt, riskPercent, roundTripFeePct]);

  const entry = Number.parseFloat(entryInput);
  const stop = Number.parseFloat(stopInput);
  const target = Number.parseFloat(targetInput);

  const calc = useMemo(() => {
    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(stop) ||
      !Number.isFinite(target) ||
      entry <= 0 ||
      stop <= 0 ||
      equityUsdt <= 0 ||
      riskPercent <= 0
    ) {
      return null;
    }

    const validDirection =
      side === 'LONG' ? stop < entry && target > entry : stop > entry && target < entry;
    const stopDistPct = Math.abs(entry - stop) / entry;
    const targetDistPct = Math.abs(target - entry) / entry;
    if (stopDistPct <= 1e-6) return null;

    const feeRate = Math.max(0, roundTripFeePct) / 100;
    const maxRiskUsdt = equityUsdt * (riskPercent / 100);
    // Account for round-trip fees on total notional: Loss = Notional * (stopDistPct + feeRate)
    const effectiveRiskPerDollar = stopDistPct + feeRate;
    const notionalUsdt = maxRiskUsdt / effectiveRiskPerDollar;
    const contractsQty = notionalUsdt / entry;
    const impliedLeverage = notionalUsdt / equityUsdt;
    const rewardUsdt = notionalUsdt * Math.max(0, targetDistPct - feeRate);
    const netRR = maxRiskUsdt > 0 ? rewardUsdt / maxRiskUsdt : 0;

    // BTC Coupling 1% Move Stress Estimate
    const beta = btcCorrelation?.beta15m ?? null;
    const pearson = btcCorrelation?.pearson15m ?? null;
    const btc1PctImpactUsdt =
      beta !== null && !btcCorrelation?.isBenchmark
        ? Math.abs(notionalUsdt * (beta * 0.01))
        : null;
    const btc1PctEquityPct =
      btc1PctImpactUsdt !== null ? (btc1PctImpactUsdt / equityUsdt) * 100 : null;

    // Live orderbook slippage estimate for the planned notional
    const liveSlippage =
      microstructure?.orderbook.status === 'READY' &&
      microstructure.orderbook.midPrice !== null
        ? estimateNotionalSlippage(
            side === 'LONG'
              ? microstructure.orderbook.compactAsks
              : microstructure.orderbook.compactBids,
            notionalUsdt,
            microstructure.orderbook.midPrice
          )
        : null;

    return {
      validDirection,
      stopDistPct: stopDistPct * 100,
      targetDistPct: targetDistPct * 100,
      maxRiskUsdt,
      notionalUsdt,
      contractsQty,
      impliedLeverage,
      rewardUsdt,
      netRR,
      beta,
      pearson,
      btc1PctImpactUsdt,
      btc1PctEquityPct,
      liveSlippage,
    };
  }, [
    entry,
    stop,
    target,
    equityUsdt,
    riskPercent,
    roundTripFeePct,
    side,
    btcCorrelation,
    microstructure,
  ]);

  return (
    <div
      id="position-risk-planner"
      className="@container apple-subcard p-4 space-y-3 overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <Calculator className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <h4 className="font-semibold text-[var(--apple-text-primary)] truncate">
            交易前倉位風控試算器 ({symbol})
          </h4>
          <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-mono text-slate-300 shrink-0">
            僅供倉位試算 · 絕不觸發任何下單
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => setSide('LONG')}
            className={`rounded-md border px-2.5 py-0.5 font-mono cursor-pointer whitespace-nowrap ${
              side === 'LONG'
                ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300 font-semibold'
                : 'border-slate-700 bg-slate-900 text-slate-400'
            }`}
          >
            做多 LONG
          </button>
          <button
            type="button"
            onClick={() => setSide('SHORT')}
            className={`rounded-md border px-2.5 py-0.5 font-mono cursor-pointer whitespace-nowrap ${
              side === 'SHORT'
                ? 'border-rose-500/60 bg-rose-500/20 text-rose-300 font-semibold'
                : 'border-slate-700 bg-slate-900 text-slate-400'
            }`}
          >
            做空 SHORT
          </button>
          <button
            type="button"
            onClick={() => {
              setEntryInput(String(suggested.entry));
              setStopInput(String(suggested.stop));
              setTargetInput(String(suggested.target));
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-300 hover:text-amber-300 cursor-pointer whitespace-nowrap"
            title={suggested.basisLabel}
          >
            <RotateCcw className="h-3 w-3 shrink-0" />
            <span>套用現價結構</span>
          </button>
          {entryZoneAnalysis?.idealPullbackEntry &&
            entryZoneAnalysis.stopLossPrice &&
            entryZoneAnalysis.targetPrice && (
              <button
                type="button"
                onClick={() => {
                  if (entryZoneAnalysis.direction === 'LONG' || entryZoneAnalysis.direction === 'SHORT') {
                    setSide(entryZoneAnalysis.direction);
                  }
                  setEntryInput(String(entryZoneAnalysis.idealPullbackEntry));
                  setStopInput(String(entryZoneAnalysis.stopLossPrice));
                  setTargetInput(String(entryZoneAnalysis.targetPrice));
                }}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 text-emerald-300 hover:bg-emerald-950/70 cursor-pointer whitespace-nowrap"
                title={entryZoneAnalysis.anchorLabel}
              >
                <span>套用回踩區價位</span>
              </button>
            )}
        </div>
      </div>

      {(() => {
        const isHighBtcSymbol =
          btcCorrelation?.tier === 'HIGH_COUPLED' ||
          (btcCorrelation?.pearson15m ?? 0) >= 0.7 ||
          symbol === 'BTCUSDT';
        const sameSideHighBtc =
          side === 'LONG' ? highBtcLongCount : highBtcShortCount;
        const showBtcCapWarn = isHighBtcSymbol && sameSideHighBtc >= 2;
        if (existingOpenOrders.length === 0 && !showBtcCapWarn) return null;
        return (
          <div className="rounded-xl border border-amber-500/45 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200 space-y-1">
            {existingOpenOrders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                <span className="font-semibold">
                  重複部位提醒：此標的目前已有 {existingOpenOrders.length} 筆進行中紙上單（
                  {existingOpenOrders
                    .map(
                      (o) =>
                        `#${o.id} ${o.side} ${
                          o.fillStatus === 'WAITING_LIMIT' ? '待觸價' : '已成交'
                        } $${o.entryPrice}`
                    )
                    .join('、')}
                  ）
                </span>
              </div>
            )}
            {showBtcCapWarn && (
              <div className="flex flex-wrap items-center gap-1.5 text-rose-200">
                <ShieldAlert className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                <span>
                  高 BTC 連動警示：帳本已有 {sameSideHighBtc} 筆同向高 BTC 相關部位 (r ≥ 0.70)，再加碼 {side} 等同集中做{side === 'LONG' ? '多' : '空'} BTC 大盤曝險。
                </span>
              </div>
            )}
          </div>
        );
      })()}

      {entryZoneAnalysis && entryZoneAnalysis.idealPullbackEntry !== null && (() => {
        const distPct =
          entryZoneAnalysis.distanceToZonePct !== null
            ? Math.abs(entryZoneAnalysis.distanceToZonePct)
            : Math.abs(
                ((entryZoneAnalysis.idealPullbackEntry! - candidate.lastPrice) /
                  Math.max(1e-9, candidate.lastPrice)) *
                  100
              );
        const distAtr = entryZoneAnalysis.distanceToZoneAtr;
        const isFarPullback =
          distPct > 3.5 || (distAtr !== null && distAtr > 2.5);
        return (
          <div
            className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px] ${
              entryZoneAnalysis.status === 'OVEREXTENDED'
                ? 'border-amber-500/45 bg-amber-950/35 text-amber-200'
                : entryZoneAnalysis.status === 'NEAR_POI'
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                  : 'border-sky-500/35 bg-sky-950/25 text-sky-200'
            }`}
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5 font-semibold break-words">
                <span>{entryZoneAnalysis.headlineZh}</span>
                {isFarPullback && (
                  <span className="rounded border border-rose-500/50 bg-rose-950/60 px-1.5 py-0.5 font-mono text-[10px] text-rose-200">
                    偏遠掛單（距現價 {distPct.toFixed(2)}%
                    {distAtr !== null ? ` · ${distAtr.toFixed(1)} ATR` : ''}，易踏空）
                  </span>
                )}
              </div>
              <div className="text-[10px] opacity-90 font-mono tabular-nums break-words">
                現價追單 R:R 1:{entryZoneAnalysis.chaseRR ?? 'N/A'} vs 回踩理想價{' '}
                {entryZoneAnalysis.idealPullbackEntry} (R:R 1:
                {entryZoneAnalysis.pullbackRR ?? 'N/A'})
              </div>
            </div>
            {(onCreatePullbackAlert || onRecordPullbackPaper) &&
              (entryZoneAnalysis.direction === 'LONG' ||
                entryZoneAnalysis.direction === 'SHORT') && (
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {onCreatePullbackAlert && (
                    <button
                      type="button"
                      onClick={() =>
                        onCreatePullbackAlert(
                          entryZoneAnalysis.idealPullbackEntry!,
                          entryZoneAnalysis.direction as 'LONG' | 'SHORT',
                          `${entryZoneAnalysis.anchorLabel} 回踩進場`
                        )
                      }
                      className="rounded-lg border border-amber-400/50 bg-amber-500/20 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/30 cursor-pointer whitespace-nowrap"
                    >
                      設回踩條件告警
                    </button>
                  )}
                  {onRecordPullbackPaper &&
                    entryZoneAnalysis.stopLossPrice !== null &&
                    entryZoneAnalysis.targetPrice !== null && (
                      <>
                        <select
                          aria-label="回踩掛單有效時限 TTL"
                          value={limitTtlMinutes}
                          onChange={(e) =>
                            setLimitTtlMinutes(Number(e.target.value))
                          }
                          className="rounded-lg border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] text-slate-200 cursor-pointer"
                        >
                          <option value={120}>TTL 2h</option>
                          <option value={240}>TTL 4h</option>
                          <option value={720}>TTL 12h</option>
                          <option value={1440}>TTL 24h</option>
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            onRecordPullbackPaper({
                              side: entryZoneAnalysis.direction as 'LONG' | 'SHORT',
                              entryPrice: entryZoneAnalysis.idealPullbackEntry!,
                              invalidationPrice: entryZoneAnalysis.stopLossPrice!,
                              targetPrice: entryZoneAnalysis.targetPrice!,
                              anchorLabel: entryZoneAnalysis.anchorLabel,
                              ttlMinutes: limitTtlMinutes,
                            })
                          }
                          className="rounded-lg border border-emerald-400/50 bg-emerald-500/20 px-2.5 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/30 cursor-pointer whitespace-nowrap"
                        >
                          掛回踩紙上限價單
                        </button>
                      </>
                    )}
                </div>
              )}
          </div>
        );
      })()}

      {/* Input Grid: 2 cols narrow -> 3 cols split -> 6 cols full-width */}
      <div className="grid grid-cols-2 gap-2.5 @md:grid-cols-3 @4xl:grid-cols-6 text-[11px] font-mono tabular-nums">
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">帳戶總本金 (USDT)</span>
          <input
            type="number"
            min="10"
            step="100"
            value={equityUsdt}
            onChange={(e) => setEquityUsdt(Math.max(10, Number(e.target.value) || 0))}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">單筆風控 (%)</span>
          <input
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            value={riskPercent}
            onChange={(e) => setRiskPercent(Math.max(0.1, Number(e.target.value) || 0.1))}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">雙邊費率+滑點 (%)</span>
          <input
            type="number"
            min="0"
            max="2"
            step="0.02"
            value={roundTripFeePct}
            onChange={(e) => setRoundTripFeePct(Math.max(0, Number(e.target.value) || 0))}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">預計進場價</span>
          <input
            type="number"
            step="any"
            value={entryInput}
            onChange={(e) => setEntryInput(e.target.value)}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">結構止損價</span>
          <input
            type="number"
            step="any"
            value={stopInput}
            onChange={(e) => setStopInput(e.target.value)}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-rose-300 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="space-y-1 min-w-0">
          <span className="block font-sans text-slate-400 truncate">目標止盈價</span>
          <input
            type="number"
            step="any"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-emerald-300 focus:border-amber-500 focus:outline-none"
          />
        </label>
      </div>

      {/* Calculated Risk Output */}
      {calc ? (
        <div className="space-y-2">
          {!calc.validDirection && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-1.5 text-[11px] text-rose-200">
              警告：目前進場 / 止損 / 目標價相對方向與「{side}」不符，請調整價格。
            </div>
          )}
          <div className="grid grid-cols-2 gap-2.5 @2xl:grid-cols-4 font-mono tabular-nums text-xs">
            <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
              <div className="font-sans text-[10px] text-slate-400 truncate">
                建議合約名義倉位
              </div>
              <div className="mt-0.5 text-sm font-bold text-slate-100 truncate">
                ${Math.round(calc.notionalUsdt).toLocaleString()}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                數量 {calc.contractsQty.toFixed(3)} {candidate.baseAsset}
              </div>
            </div>

            <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
              <div className="font-sans text-[10px] text-slate-400 truncate">
                單筆最大虧損額
              </div>
              <div className="mt-0.5 text-sm font-bold text-rose-400 truncate">
                -${calc.maxRiskUsdt.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                止損距離 {calc.stopDistPct.toFixed(2)}%
              </div>
            </div>

            <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
              <div className="font-sans text-[10px] text-slate-400 truncate">
                建議槓桿倍數 / 風險提示
              </div>
              <div
                className={`mt-0.5 text-sm font-bold truncate ${
                  calc.impliedLeverage > 5 ? 'text-amber-300' : 'text-sky-300'
                }`}
              >
                {calc.impliedLeverage.toFixed(2)}x
              </div>
              <div className="font-sans text-[10px] text-slate-400 truncate">
                {calc.impliedLeverage > 5
                  ? '偏高槓桿，建議調寬止損或降倉'
                  : '安全等效槓桿區間'}
              </div>
            </div>

            <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/90 p-2.5">
              <div className="font-sans text-[10px] text-slate-400 truncate">
                扣費淨賺賠比 (Net R:R)
              </div>
              <div
                className={`mt-0.5 text-sm font-bold truncate ${
                  calc.netRR >= 1.8
                    ? 'text-emerald-400'
                    : calc.netRR >= 1.0
                      ? 'text-amber-300'
                      : 'text-rose-400'
                }`}
              >
                1 : {calc.netRR.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                預估淨利 +${calc.rewardUsdt.toFixed(2)}
              </div>
            </div>
          </div>

          {calc.liveSlippage && (
            <div
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px] ${
                calc.liveSlippage.slippageBps >= 12 || !calc.liveSlippage.depthCovered
                  ? 'border-rose-500/40 bg-rose-950/35 text-rose-200'
                  : 'border-cyan-500/30 bg-cyan-950/30 text-cyan-200'
              }`}
            >
              <span>
                即時訂單簿深度滑點估算 ({side === 'LONG' ? '市價買入吃賣盤' : '市價賣出吃買盤'} · 名義倉位 ${Math.round(calc.notionalUsdt).toLocaleString()})：
              </span>
              <span className="font-mono font-semibold tabular-nums">
                預估滑點 {calc.liveSlippage.slippageBps.toFixed(1)} bps
                {!calc.liveSlippage.depthCovered ? '+' : ''} (約 -$
                {calc.liveSlippage.slippageUsdt.toFixed(2)}
                {calc.liveSlippage.slippageBps >= 12 || !calc.liveSlippage.depthCovered
                  ? ' · 建議限價分批'
                  : ' · 流動性充裕'}
                )
              </span>
            </div>
          )}

          {calc.btc1PctImpactUsdt !== null && calc.btc1PctEquityPct !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-950/35 px-3 py-2 text-[11px] text-amber-200">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-300 shrink-0" />
                <span>
                  BTC 大盤Beta連動壓力估算 (15m r={calc.pearson?.toFixed(2) ?? 'N/A'} · Beta {calc.beta?.toFixed(2)}x)：
                </span>
              </div>
              <span className="font-mono font-semibold tabular-nums">
                若 BTC 突變 ±1% → 倉位波動約 ±${calc.btc1PctImpactUsdt.toFixed(2)} (佔本金 {calc.btc1PctEquityPct.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-slate-400">
          請輸入有效進場與止損價位以進行試算。
        </div>
      )}
    </div>
  );
};
