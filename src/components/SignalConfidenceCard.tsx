import React from 'react';
import { SignalDecision } from '../types/market.ts';

interface SignalConfidenceCardProps {
  decision: SignalDecision | null | undefined;
}

export const SignalConfidenceCard: React.FC<SignalConfidenceCardProps> = ({
  decision,
}) => {
  if (!decision) return null;
  const tone =
    decision.actionState === 'LONG CANDIDATE'
      ? 'border-emerald-500/40 bg-emerald-950/20'
      : decision.actionState === 'SHORT CANDIDATE'
        ? 'border-rose-500/40 bg-rose-950/20'
        : decision.actionState === 'HIGH RISK'
          ? 'border-amber-500/40 bg-amber-950/20'
          : 'border-slate-700 bg-slate-950/70';

  return (
    <section className={`rounded-xl border p-3.5 space-y-3 text-xs ${tone}`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            SMC 信心分數
          </div>
          <div className="text-2xl font-bold tabular-nums text-slate-100">
            {decision.confidence}
            <span className="ml-1 text-sm font-medium text-slate-400">/ 100</span>
          </div>
        </div>
        <div className="text-right text-[11px] text-slate-300 space-y-0.5">
          <div>
            多方 {decision.longScore} · 空方 {decision.shortScore} · 分差 {decision.margin}
            （邊距 {decision.conflictMargin}）
          </div>
          <div>
            預設 {decision.preset}
            {decision.lighterPath.used ? ' · 使用輕量路徑' : ''}
            {decision.conflictBlocked ? ' · 多空衝突' : ''}
          </div>
        </div>
      </div>
      <p className="text-slate-200 leading-relaxed">{decision.stateReasonZh}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {decision.requiredGates.map((gate) => (
          <div
            key={gate.key}
            className={`rounded-lg border px-2.5 py-2 ${
              gate.passed
                ? 'border-emerald-500/30 bg-emerald-950/20'
                : 'border-slate-700 bg-slate-900/60'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-semibold text-slate-100">
              <span>{gate.labelZh}</span>
              <span className={gate.passed ? 'text-emerald-300' : 'text-amber-300'}>
                {gate.passed ? '通過' : '未過'}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-300">{gate.reasonZh}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 font-semibold text-emerald-300">加分</div>
          <ul className="space-y-1 text-[11px] leading-snug text-slate-300">
            {decision.plusPoints.length === 0 ? <li>這側目前沒有加分項</li> : null}
            {decision.plusPoints.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-semibold text-rose-300">減分</div>
          <ul className="space-y-1 text-[11px] leading-snug text-slate-300">
            {decision.minusPoints.length === 0 ? <li>這側目前沒有減分項</li> : null}
            {decision.minusPoints.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        </div>
      </div>
      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">分數公式</summary>
        <ul className="mt-1 space-y-1">
          {decision.formulasZh.map((row) => (
            <li key={row}>{row}</li>
          ))}
          <li>{decision.lighterPath.documentedZh}</li>
        </ul>
      </details>
    </section>
  );
};
