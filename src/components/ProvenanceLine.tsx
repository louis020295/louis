import React from 'react';
import { DataProvenance, SmcEvaluationStatus } from '../types/market.ts';

interface ProvenanceLineProps {
  provenance: DataProvenance;
  prefixLabel?: string;
  smcEvaluationStatus?: SmcEvaluationStatus;
}

export const ProvenanceLine: React.FC<ProvenanceLineProps> = ({
  provenance,
  prefixLabel,
  smcEvaluationStatus,
}) => {
  const formattedTime = (() => {
    try {
      const d = new Date(provenance.fetchedAt);
      return d.toLocaleTimeString('zh-TW', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return provenance.fetchedAt;
    }
  })();

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--apple-text-secondary)] tabular-nums">
      {prefixLabel && (
        <>
          <span className="font-medium text-[var(--apple-text-primary)]">
            {prefixLabel}
          </span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>
        source:{' '}
        <strong
          className={
            provenance.isDemo
              ? 'text-amber-600 dark:text-amber-400 font-semibold'
              : 'text-[var(--apple-text-primary)] font-semibold'
          }
        >
          {provenance.source}
        </strong>
      </span>
      <span aria-hidden="true">·</span>
      <span>fetchedAt: {formattedTime}</span>
      <span aria-hidden="true">·</span>
      <span
        className={
          provenance.stale
            ? 'text-rose-600 dark:text-rose-400 font-semibold'
            : 'text-[var(--apple-text-secondary)]'
        }
      >
        stale: {provenance.stale ? 'TRUE (已過期)' : 'false'}
      </span>
      <span aria-hidden="true">·</span>
      <span
        className={
          provenance.fallback
            ? 'text-amber-600 dark:text-amber-400 font-semibold'
            : 'text-[var(--apple-text-secondary)]'
        }
      >
        fallback: {provenance.fallback ? 'TRUE' : 'false'}
      </span>
      <span aria-hidden="true">·</span>
      <span
        className={
          provenance.missingData.length > 0
            ? 'text-amber-600 dark:text-amber-400 font-semibold'
            : 'text-[var(--apple-text-secondary)]'
        }
      >
        missingData:{' '}
        {provenance.missingData.length > 0
          ? provenance.missingData.join(', ')
          : 'none'}
      </span>
      <span aria-hidden="true">·</span>
      <span>volumeTimeframe: {provenance.volumeTimeframe ?? '15m'}</span>
      <span aria-hidden="true">·</span>
      <span>
        aggregationWindow:{' '}
        {provenance.aggregationWindow ?? '15m_CONFIRMED_KLINE_30_BARS'}
      </span>
      <span aria-hidden="true">·</span>
      <span>volumeMetric: {provenance.volumeMetric ?? 'quoteVolume'}</span>
      {smcEvaluationStatus && (
        <>
          <span aria-hidden="true">·</span>
          <span
            className={
              smcEvaluationStatus === 'EVALUATED'
                ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                : 'text-[var(--apple-text-secondary)]'
            }
          >
            smcEvaluationStatus: {smcEvaluationStatus}
          </span>
        </>
      )}
    </div>
  );
};
