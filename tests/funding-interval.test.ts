import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { calculateTradeTradingCosts } from '../server/engine/TradingCostModel.ts';
import {
  annualizedFundingPercent,
  ensureExchangeFundingMap,
  fundingPeriodsForHold,
  inferFundingIntervalHours,
  rememberExchangeFundingMap,
  resetFundingIntervalCache,
  resolveFundingInterval,
} from '../server/market/FundingInterval.ts';

after(() => {
  resetFundingIntervalCache();
});

describe('per-symbol funding interval', () => {
  it('annualizes 8h as 3 settlements per day and 4h as 6', () => {
    const rate = 0.0001;
    assert.equal(
      annualizedFundingPercent(rate, 8),
      rate * 3 * 365 * 100
    );
    assert.equal(
      annualizedFundingPercent(rate, 4),
      rate * 6 * 365 * 100
    );
    assert.equal(fundingPeriodsForHold(8 * 3_600_000, 8), 1);
    assert.equal(fundingPeriodsForHold(8 * 3_600_000, 4), 2);
  });

  it('uses the explicit interval in trading cost and falls back to flagged 8h', () => {
    const base = {
      direction: 'LONG' as const,
      entryPrice: 100,
      invalidationPrice: 98,
      exitPrice: 98,
      entryTimeMs: 0,
      exitTimeMs: 8 * 3_600_000,
      entryOrderType: 'MARKET' as const,
      exitIsLimitFill: false,
      fundingRatePer8h: 0.0005,
      costConfig: { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3 },
    };
    const eight = calculateTradeTradingCosts(base);
    assert.equal(eight.fundingCostR, 0.025);
    assert.equal(eight.fundingIntervalHoursUsed, 8);
    assert.equal(eight.fundingIntervalFallback, true);

    const four = calculateTradeTradingCosts({
      ...base,
      fundingIntervalHours: 4,
      fundingIntervalFallback: false,
    });
    assert.equal(four.fundingCostR, 0.05);
    assert.equal(four.fundingIntervalHoursUsed, 4);
    assert.equal(four.fundingIntervalFallback, false);
  });

  it('reads fundingInfo cache and flags symbols the payload omitted', async () => {
    resetFundingIntervalCache();
    await ensureExchangeFundingMap(async () => ({
      ETHUSDT: 4,
      BTCUSDT: 8,
    }));
    const eth = resolveFundingInterval({ symbol: 'ethusdt' });
    assert.equal(eth.fundingIntervalHours, 4);
    assert.equal(eth.source, 'exchange');
    assert.equal(eth.fallback, false);

    const missing = resolveFundingInterval({ symbol: 'SOLUSDT' });
    assert.equal(missing.fundingIntervalHours, 8);
    assert.equal(missing.source, 'fallback');
    assert.equal(missing.fallback, true);
    assert.match(missing.noteZh, /fallback|8/);
  });

  it('infers a stable 4h settlement cadence and ignores irregular gaps', () => {
    const start = 1_700_000_000_000;
    const four = [0, 1, 2, 3, 4].map((i) => start + i * 4 * 3_600_000);
    assert.equal(inferFundingIntervalHours(four), 4);
    assert.equal(inferFundingIntervalHours([start, start + 3_600_000, start + 9_999_000]), null);

    resetFundingIntervalCache();
    rememberExchangeFundingMap({}, Date.now(), false);
    const observed = resolveFundingInterval({
      symbol: 'DOGEUSDT',
      seriesTimestamps: four,
    });
    assert.equal(observed.fundingIntervalHours, 4);
    assert.equal(observed.source, 'observed_settlements');
    assert.equal(observed.fallback, false);
  });
});
