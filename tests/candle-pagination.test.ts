import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BacktestEngine } from '../server/engine/BacktestEngine.ts';
import {
  binanceKlineRequestWeight,
  clampBacktestBarCount,
  fetchClosedCandleSeries,
  paceKlineRequestWeight,
  selectClosedCandles,
} from '../server/market/ClosedCandleSeries.ts';
import type { DataProvenance, Kline, Timeframe } from '../src/types/market.ts';

function provenance(): DataProvenance {
  return {
    source: 'TEST',
    fetchedAt: new Date(0).toISOString(),
    stale: false,
    fallback: false,
    missingData: [],
    isDemo: true,
  };
}

function bar(openTime: number, closed: boolean): Kline {
  return {
    openTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    closeTime: openTime + 60_000 - 1,
    quoteVolume: 100,
    isClosed: closed,
  };
}

describe('closed candle pagination', () => {
  it('maps Binance kline limit to request weight and refuses the >1000 tier in pages', () => {
    assert.equal(binanceKlineRequestWeight(50), 1);
    assert.equal(binanceKlineRequestWeight(100), 2);
    assert.equal(binanceKlineRequestWeight(499), 2);
    assert.equal(binanceKlineRequestWeight(500), 5);
    assert.equal(binanceKlineRequestWeight(1000), 5);
    assert.equal(binanceKlineRequestWeight(1001), 10);
    assert.ok(clampBacktestBarCount(2500, 120) === 2500);
    assert.equal(clampBacktestBarCount(50_000, 120), 10_000);
    assert.equal(clampBacktestBarCount(undefined, 240), 240);
  });

  it('walks endTime pages past 1000 bars and returns closed candles only', async () => {
    const limits: number[] = [];
    const endTimes: Array<number | undefined> = [];
    const series = await fetchClosedCandleSeries({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      barCount: 2500,
      fetchPage: async (query) => {
        limits.push(query.limit);
        endTimes.push(query.window?.endTime);
        assert.ok(query.limit <= 1000);
        const end = query.window?.endTime ?? 2_500_000 * 60_000;
        const rows: Kline[] = [];
        for (let i = query.limit - 1; i >= 0; i--) {
          const openTime = end - i * 60_000;
          if (openTime <= 0) continue;
          rows.push(bar(openTime, true));
        }
        rows.sort((a, b) => a.openTime - b.openTime);
        if (rows.length > 0 && query.window?.endTime == null) {
          rows[rows.length - 1] = bar(rows[rows.length - 1].openTime, false);
        }
        return { klines: rows, provenance: provenance() };
      },
    });

    assert.equal(series.klines.length, 2500);
    assert.ok(series.pages >= 3);
    assert.ok(limits.every((limit) => limit <= 1000));
    assert.equal(endTimes[0], undefined);
    assert.ok(endTimes.slice(1).every((t) => typeof t === 'number'));
    assert.ok(series.klines.every((k) => k.isClosed === true));
    assert.ok(series.forming.length >= 1);
    assert.equal(series.weightUsed, limits.reduce((sum, limit) => sum + binanceKlineRequestWeight(limit), 0));
    for (let i = 1; i < series.klines.length; i++) {
      assert.ok(series.klines[i].openTime > series.klines[i - 1].openTime);
    }
  });

  it('paces when the weight budget is already spent', async () => {
    const ledger = [{ at: 0, weight: 10 }];
    let now = 0;
    const sleeps: number[] = [];
    await paceKlineRequestWeight(5, {
      maxWeightPerWindow: 12,
      windowMs: 1_000,
      ledger,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    assert.ok(sleeps.length >= 1);
    assert.equal(now >= 1_000, true);
    assert.equal(ledger[ledger.length - 1].weight, 5);
  });

  it('shares the closed-candle predicate with a 5m backtest', () => {
    const klines = [bar(0, true), bar(5 * 60_000, true), bar(10 * 60_000, false)];
    assert.equal(selectClosedCandles(klines).length, 2);
    const engine = new BacktestEngine();
    const res = engine.runDeterministicBacktest({
      symbol: 'BTCUSDT',
      exchange: 'binance_usdm',
      timeframe: '5m' as Timeframe,
      klines,
      historicalOpenInterest: [],
      historicalFundingRates: [],
      provenance: provenance(),
    });
    assert.equal(res.timeframe, '5m');
    assert.equal(res.unclosedBarsIgnored, 1);
    assert.equal(res.status, 'INSUFFICIENT_DATA');
  });
});
