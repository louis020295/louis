import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSwingLiquidityPools,
  detectConfirmedLiquiditySweep,
  detectLastStructureBreak,
  detectTimeframeBias,
  findConfirmedSwingPoints,
  swingEqualityTolerance,
} from '../server/engine/SmcRuleEngine.ts';
import {
  parseSchedulerSmcTopN,
  selectSchedulerSmcUniverse,
  buildSchedulerSmcCoverage,
  SCHEDULER_SMC_REQUESTS_PER_SYMBOL,
} from '../server/services/BackgroundScannerScheduler.ts';
import type { Kline, ScannedCandidate } from '../src/types/market.ts';

function closedKline(
  partial: Partial<Kline> & Pick<Kline, 'openTime' | 'open' | 'high' | 'low' | 'close'>
): Kline {
  const volume = partial.volume ?? 10_000;
  const close = partial.close;
  return {
    volume,
    closeTime: partial.closeTime ?? partial.openTime + 14 * 60 * 1000,
    quoteVolume: partial.quoteVolume ?? Number((volume * close).toFixed(2)),
    takerBuyVolume: partial.takerBuyVolume ?? volume * 0.55,
    takerBuyQuoteVolume: partial.takerBuyQuoteVolume ?? volume * close * 0.55,
    isClosed: partial.isClosed ?? true,
    ...partial,
  };
}

function flatThen(bars: Array<[number, number, number, number]>, startTime = 1_700_000_000_000): Kline[] {
  return bars.map(([open, high, low, close], i) =>
    closedKline({
      openTime: startTime + i * 15 * 60 * 1000,
      open,
      high,
      low,
      close,
    })
  );
}

/** 24-bar HH/HL uptrend with confirmed swings, plus optional last-bar close-through. */
function hhhlSeries(opts?: { bearishCloseThrough?: boolean; unclosedBreak?: boolean }): Kline[] {
  const bars: Array<[number, number, number, number]> = [];
  let price = 100;
  for (let i = 0; i < 24; i++) {
    const open = price;
    const close = price + 0.8;
    bars.push([open, close + 0.3, open - 0.2, close]);
    price = close;
  }
  // Insert a shallow pullback mid-series so we get distinct swing highs/lows.
  // Bar 10 dips, bar 11-12 recover, later highs exceed the pre-dip high.
  bars[8] = [bars[8][0], bars[8][0] + 1.2, bars[8][0] - 0.1, bars[8][0] + 1.0];
  bars[9] = [bars[8][3], bars[8][3] + 0.2, bars[8][3] - 0.15, bars[8][3] - 0.1];
  bars[10] = [bars[9][3], bars[9][3] + 0.15, bars[9][3] - 1.4, bars[9][3] - 0.6];
  bars[11] = [bars[10][3], bars[10][3] + 0.4, bars[10][3] - 0.1, bars[10][3] + 0.3];
  bars[12] = [bars[11][3], bars[11][3] + 0.8, bars[11][3] - 0.1, bars[11][3] + 0.7];
  const klines = flatThen(bars);
  if (opts?.bearishCloseThrough) {
    const lastSwingLow = findConfirmedSwingPoints(klines).swingLows.at(-1);
    assert.ok(lastSwingLow);
    const open = klines[klines.length - 1].close;
    klines.push(
      closedKline({
        openTime: klines[klines.length - 1].openTime + 15 * 60 * 1000,
        open,
        high: open + 0.1,
        low: lastSwingLow.price - 0.4,
        close: lastSwingLow.price - 0.2,
      })
    );
  }
  if (opts?.unclosedBreak) {
    const lastSwingHigh = findConfirmedSwingPoints(klines).swingHighs.at(-1);
    assert.ok(lastSwingHigh);
    const open = klines[klines.length - 1].close;
    klines.push(
      closedKline({
        openTime: klines[klines.length - 1].openTime + 15 * 60 * 1000,
        open,
        high: lastSwingHigh.price + 0.8,
        low: open - 0.1,
        close: lastSwingHigh.price + 0.5,
        isClosed: false,
      })
    );
  }
  return klines;
}

describe('audit-round2: structure bias, swing liquidity sweep, scheduler coverage', () => {
  it('detectTimeframeBias uses confirmed HH/HL or last BOS/CHoCH, ignores unclosed breaks, keeps NEUTRAL / MISSING', () => {
    const bullish = hhhlSeries();
    assert.equal(detectTimeframeBias(bullish), 'BULL');
    assert.equal(detectLastStructureBreak(bullish.filter((k) => k.isClosed)) !== 'BEAR', true);

    const flipped = hhhlSeries({ bearishCloseThrough: true });
    assert.equal(detectTimeframeBias(flipped), 'BEAR', 'later close-through of a swing low must flip bias to BEAR');

    const withUnclosed = hhhlSeries({ unclosedBreak: true });
    const closedOnly = detectTimeframeBias(withUnclosed.filter((k) => k.isClosed));
    assert.equal(detectTimeframeBias(withUnclosed), closedOnly, 'forming bar must not change bias');

    const range = flatThen(
      Array.from({ length: 24 }, (_, i) => {
        const wiggle = i % 2 === 0 ? 0.15 : -0.15;
        return [100, 100.4, 99.6, 100 + wiggle] as [number, number, number, number];
      })
    );
    const rangeBias = detectTimeframeBias(range);
    assert.ok(rangeBias === 'NEUTRAL' || rangeBias === 'BULL' || rangeBias === 'BEAR');
    // Tight range without a close-through should stay NEUTRAL.
    if (!detectLastStructureBreak(range)) {
      assert.equal(rangeBias, 'NEUTRAL');
    }

    assert.equal(detectTimeframeBias(bullish.slice(0, 15)), 'MISSING');
    assert.equal(detectTimeframeBias(undefined), 'MISSING');
    assert.equal(detectTimeframeBias([]), 'MISSING');
  });

  it('Liquidity Sweep 以已確認擺動／同等高低點為池，不採用前 12 根 min/max，且忽略未收盤 K', () => {
    // Confirmed swing low early at ~90, then a rally. A later wick through the
    // recent 12-bar min (~108) but well above the swing must NOT count.
    const bars: Kline[] = [];
    let price = 100;
    for (let i = 0; i < 8; i++) {
      const open = price;
      const close = price - 0.6;
      bars.push(closedKline({ openTime: i * 1000, open, high: open + 0.2, low: close - 0.15, close }));
      price = close;
    }
    // Bar 8 is the pivot low (~94) with 2 bars on each side once we continue higher.
    bars[5] = closedKline({ openTime: 5 * 1000, open: 96, high: 96.3, low: 94.0, close: 94.6 });
    bars[6] = closedKline({ openTime: 6 * 1000, open: 94.6, high: 95.2, low: 94.4, close: 95.0 });
    bars[7] = closedKline({ openTime: 7 * 1000, open: 95.0, high: 96.5, low: 94.8, close: 96.2 });
    price = 96.2;
    for (let i = 8; i < 28; i++) {
      const open = price;
      const close = price + 0.7;
      bars.push(closedKline({ openTime: i * 1000, open, high: close + 0.2, low: open - 0.15, close }));
      price = close;
    }
    const swings = findConfirmedSwingPoints(bars);
    const earlyLow = swings.swingLows.find((s) => s.price <= 94.1);
    assert.ok(earlyLow, 'fixture must contain a confirmed swing low near 94');

    const lastClose = bars[bars.length - 1].close;
    const fakeSweep = closedKline({
      openTime: 28 * 1000,
      open: lastClose,
      high: lastClose + 0.2,
      low: lastClose - 0.8, // pierces recent 12-bar min, stays far above 94
      close: lastClose + 0.05,
    });
    const noSwingSweep = detectConfirmedLiquiditySweep([...bars, fakeSweep], 0.8);
    assert.equal(
      noSwingSweep.detected,
      false,
      `12-bar min wick must not count as a sweep; got ${noSwingSweep.description}`
    );

    const realSweep = closedKline({
      openTime: 29 * 1000,
      open: lastClose,
      high: lastClose + 0.2,
      low: earlyLow.price - 0.3,
      close: earlyLow.price + 0.4,
    });
    const swept = detectConfirmedLiquiditySweep([...bars, realSweep], 0.8);
    assert.equal(swept.detected, true);
    assert.equal(swept.side, 'SELL_SIDE_SWEPT');
    assert.ok(swept.sweptLevel !== null && swept.sweptLevel <= earlyLow.price + 0.05);

    const unclosed = detectConfirmedLiquiditySweep(
      [
        ...bars,
        closedKline({
          openTime: 30 * 1000,
          open: lastClose,
          high: lastClose + 0.2,
          low: earlyLow.price - 0.3,
          close: earlyLow.price + 0.4,
          isClosed: false,
        }),
      ],
      0.8
    );
    assert.equal(unclosed.detected, false, 'unclosed sweep candle must be ignored');

    // Equal lows: two swing lows a few bps apart form one pool.
    const eqTol = swingEqualityTolerance(100, 1);
    const eqPools = collectSwingLiquidityPools(
      [
        { index: 4, price: 100 },
        { index: 10, price: 100 + eqTol * 0.4 },
      ],
      'LOW',
      eqTol
    );
    assert.equal(eqPools.length, 1);
    assert.equal(eqPools[0].memberCount, 2);
    assert.equal(eqPools[0].price, 100);
  });

  it('SCHEDULER_SMC_TOP_N 預設涵蓋全部合格標的，可設定上限，並計算 HTTP 成本', () => {
    const prev = process.env.SCHEDULER_SMC_TOP_N;
    try {
      delete process.env.SCHEDULER_SMC_TOP_N;
      assert.equal(parseSchedulerSmcTopN(), 'ALL');
      assert.equal(parseSchedulerSmcTopN('all'), 'ALL');
      assert.equal(parseSchedulerSmcTopN('0'), 'ALL');
      assert.equal(parseSchedulerSmcTopN(''), 'ALL');
      assert.equal(parseSchedulerSmcTopN('12'), 12);
      process.env.SCHEDULER_SMC_TOP_N = '8';
      assert.equal(parseSchedulerSmcTopN(), 8);
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_SMC_TOP_N;
      else process.env.SCHEDULER_SMC_TOP_N = prev;
    }

    const cands = [
      { symbol: 'AAAUSDT', marketRadarCategory: '準備觀察', score: 90 },
      { symbol: 'BTCUSDT', marketRadarCategory: '雷達多頭觀察', score: 40 },
      { symbol: 'ETHUSDT', marketRadarCategory: '雷達空頭觀察', score: 70 },
      { symbol: 'SOLUSDT', marketRadarCategory: '雷達多頭觀察', score: 80 },
      { symbol: 'ZZZUSDT', marketRadarCategory: '準備觀察', score: 10 },
    ] as ScannedCandidate[];
    const all = selectSchedulerSmcUniverse(cands, 'ALL');
    assert.equal(all.length, 5);
    assert.deepEqual(
      all.map((c) => c.symbol),
      ['SOLUSDT', 'ETHUSDT', 'BTCUSDT', 'AAAUSDT', 'ZZZUSDT']
    );
    const capped = selectSchedulerSmcUniverse(cands, 3);
    assert.deepEqual(
      capped.map((c) => c.symbol),
      ['SOLUSDT', 'ETHUSDT', 'BTCUSDT']
    );

    const coverage = buildSchedulerSmcCoverage({
      topN: 'ALL',
      selectedSymbolCount: 522,
      evaluatedInLatestMap: 0,
      batchWorkerState: 'IDLE',
    });
    assert.equal(coverage.estimatedRequestsPerCycle, 522 * SCHEDULER_SMC_REQUESTS_PER_SYMBOL);
    assert.ok(coverage.estimatedMinCycleMinutes > 2);
    assert.ok(coverage.rateLimitNoteZh.includes('1200'));
  });
});
