import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateDeterministicSmcKlines } from '../server/adapters/ExchangeAdapter.ts';
import {
  collectUnfilledFvgZones,
  computeFvgFillRatio,
  coreMissingData,
  detectStrictOrderBlock,
  evaluateSmcStructure,
  findConfirmedSwingPoints,
  OPTIONAL_PROVENANCE_GAPS,
} from '../server/engine/SmcRuleEngine.ts';
import { DataProvenance, Kline } from '../src/types/market.ts';

const liveProvenance: DataProvenance = {
  source: 'Binance USDⓈ-M Futures REST (https://fapi.binance.com: /fapi/v1/klines)',
  fetchedAt: new Date().toISOString(),
  stale: false,
  fallback: false,
  missingData: [],
  isDemo: false,
};

function closedKline(partial: Partial<Kline> & Pick<Kline, 'openTime' | 'open' | 'high' | 'low' | 'close'>): Kline {
  const volume = partial.volume ?? 10_000;
  const close = partial.close;
  return {
    volume,
    closeTime: partial.closeTime ?? partial.openTime + 14 * 60 * 1000,
    quoteVolume: partial.quoteVolume ?? Number((volume * close).toFixed(2)),
    takerBuyVolume: partial.takerBuyVolume ?? volume * 0.55,
    takerBuyQuoteVolume: partial.takerBuyQuoteVolume ?? volume * close * 0.55,
    isClosed: true,
    ...partial,
  };
}

function staircase(count: number, start: number, step: number): Kline[] {
  const out: Kline[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    out.push(
      closedKline({
        openTime: 1_700_000_000_000 + i * 15 * 60 * 1000,
        open,
        close,
        high: Math.max(open, close) + Math.abs(step) * 0.1,
        low: Math.min(open, close) - Math.abs(step) * 0.1,
        quoteVolume: 20_000 + (i % 5) * 3_000,
      })
    );
    price = close;
  }
  return out;
}

describe('audit-signal-fixes: 5-bar swing, FVG 部分回補, 嚴格 OB, 缺失欄位與冷啟動量能', () => {
  it('findConfirmedSwingPoints 需要左右各 2 根已收盤 K 確認，3 根形態不算擺動點', () => {
    // Bars: 0,1 low sides; 2 is a local high vs i±1 only; 3 is higher than bar 2 so a 5-bar check rejects bar 2.
    const klines: Kline[] = [
      closedKline({ openTime: 0, open: 10, close: 10.2, high: 10.3, low: 9.9 }),
      closedKline({ openTime: 1, open: 10.2, close: 10.4, high: 10.5, low: 10.1 }),
      closedKline({ openTime: 2, open: 10.4, close: 10.3, high: 11.0, low: 10.2 }), // 3-bar high only
      closedKline({ openTime: 3, open: 10.3, close: 10.5, high: 11.2, low: 10.25 }), // high >= bar 2, denies 5-bar confirmation
      closedKline({ openTime: 4, open: 10.5, close: 10.2, high: 10.6, low: 10.1 }),
      closedKline({ openTime: 5, open: 10.2, close: 10.0, high: 10.3, low: 9.95 }),
      closedKline({ openTime: 6, open: 10.0, close: 10.1, high: 10.2, low: 9.9 }),
    ];
    const weak = findConfirmedSwingPoints(klines);
    assert.equal(
      weak.swingHighs.some((s) => s.index === 2),
      false,
      'high that only beats i+1 must not be a 5-bar swing'
    );

    // Genuine 5-bar high at index 3: 11.5 > both left and both right.
    const confirmed: Kline[] = [
      closedKline({ openTime: 0, open: 10, close: 10.1, high: 10.2, low: 9.9 }),
      closedKline({ openTime: 1, open: 10.1, close: 10.3, high: 10.4, low: 10.0 }),
      closedKline({ openTime: 2, open: 10.3, close: 10.2, high: 10.5, low: 10.1 }),
      closedKline({ openTime: 3, open: 10.2, close: 10.4, high: 11.5, low: 10.15 }),
      closedKline({ openTime: 4, open: 10.4, close: 10.2, high: 10.6, low: 10.1 }),
      closedKline({ openTime: 5, open: 10.2, close: 10.0, high: 10.3, low: 9.95 }),
      closedKline({ openTime: 6, open: 10.0, close: 10.05, high: 10.15, low: 9.9 }),
    ];
    const strong = findConfirmedSwingPoints(confirmed);
    assert.equal(strong.swingHighs.some((s) => s.index === 3 && s.price === 11.5), true);
  });

  it('未收盤 K 線不得成為擺動點或進入 FVG / OB 判定', () => {
    const closed = staircase(40, 100, 0.4);
    const fakeBreak: Kline = {
      ...closedKline({
        openTime: closed[closed.length - 1].openTime + 15 * 60 * 1000,
        open: 120,
        close: 140,
        high: 142,
        low: 119,
      }),
      isClosed: false,
    };
    const res = evaluateSmcStructure({
      symbol: 'TESTUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: { '15m': [...closed, fakeBreak] },
      openInterest: 1_000_000,
      provenance: liveProvenance,
    });
    assert.equal(res.unclosedKlineIgnoredCount, 1);
    assert.equal(res.confirmedKlineCount, 40);
  });

  it('computeFvgFillRatio 與 collectUnfilledFvgZones 保留未回補與部分回補，排除完全回補', () => {
    // Bullish FVG between bar 0 high=10 and bar 2 low=12, then a partial wick to 11.
    const c0 = closedKline({ openTime: 0, open: 9.5, close: 10, high: 10, low: 9.4 });
    const c1 = closedKline({ openTime: 1, open: 10.2, close: 11.5, high: 11.6, low: 10.2 });
    const c2 = closedKline({ openTime: 2, open: 11.6, close: 12.2, high: 12.4, low: 12 });
    const partial = closedKline({ openTime: 3, open: 12.1, close: 11.8, high: 12.2, low: 11 });
    const fill = computeFvgFillRatio('BULL', 12, 10, [partial]);
    assert.ok(fill > 0.4 && fill < 0.6, `expected ~0.5 fill, got ${fill}`);

    const fullFillBar = closedKline({ openTime: 4, open: 11.5, close: 10.5, high: 11.6, low: 9.8 });
    const full = computeFvgFillRatio('BULL', 12, 10, [partial, fullFillBar]);
    assert.equal(full, 1);

    // Two gaps: older unfilled, newer fully filled — unfilled must remain in the live set.
    const olderUnfilled: Kline[] = [
      closedKline({ openTime: 10, open: 8, close: 8.5, high: 8.5, low: 7.9 }),
      closedKline({ openTime: 11, open: 8.6, close: 9.4, high: 9.5, low: 8.6 }),
      closedKline({ openTime: 12, open: 9.5, close: 9.8, high: 9.9, low: 9.6 }), // gap 8.5-9.6
      // later bars never trade back into 8.5-9.6
      closedKline({ openTime: 13, open: 9.8, close: 10.0, high: 10.1, low: 9.7 }),
      closedKline({ openTime: 14, open: 10.0, close: 10.2, high: 10.3, low: 9.95 }),
      closedKline({ openTime: 15, open: 10.2, close: 10.8, high: 10.9, low: 10.2 }),
      closedKline({ openTime: 16, open: 10.9, close: 11.5, high: 11.6, low: 10.9 }),
      closedKline({ openTime: 17, open: 11.6, close: 12.0, high: 12.1, low: 11.6 }), // newer gap 10.9-11.6
      closedKline({ openTime: 18, open: 11.8, close: 11.0, high: 11.9, low: 10.8 }), // fully fills newer gap
    ];
    const zones = collectUnfilledFvgZones(olderUnfilled, 24);
    const live = zones.filter((z) => !z.mitigated && z.direction === 'BULL');
    assert.ok(live.some((z) => z.bottom === 8.5 && z.top === 9.6));
    assert.equal(live.some((z) => z.bottom === 10.9), false);
  });

  it('detectStrictOrderBlock 拒絕微小 Doji，且收盤穿越後視為失效', () => {
    const before = staircase(20, 100, 0.3);
    const doji = closedKline({
      openTime: before[before.length - 1].openTime + 15 * 60 * 1000,
      open: 106,
      close: 105.99,
      high: 106.05,
      low: 105.9,
    });
    const disp = closedKline({
      openTime: doji.openTime + 15 * 60 * 1000,
      open: 106,
      close: 110,
      high: 110.2,
      low: 105.95,
    });
    const atr = 1.2;
    const rejected = detectStrictOrderBlock({
      confirmed: [...before, doji, disp],
      displacementIndex: before.length + 1,
      direction: 'BULL',
      atr14: atr,
    });
    assert.equal(rejected.found, false);

    const offer = closedKline({
      openTime: before[before.length - 1].openTime + 15 * 60 * 1000,
      open: 107,
      close: 105.5,
      high: 107.2,
      low: 105.3,
    });
    const bullDisp = closedKline({
      openTime: offer.openTime + 15 * 60 * 1000,
      open: 105.6,
      close: 109.5,
      high: 109.7,
      low: 105.5,
    });
    const valid = detectStrictOrderBlock({
      confirmed: [...before, offer, bullDisp],
      displacementIndex: before.length + 1,
      direction: 'BULL',
      atr14: atr,
    });
    assert.equal(valid.found, true);
    assert.equal(valid.evidence.detected, true);

    const through = closedKline({
      openTime: bullDisp.openTime + 15 * 60 * 1000,
      open: 109,
      close: 104.9, // close through OB low 105.3
      high: 109.1,
      low: 104.8,
    });
    const invalidated = detectStrictOrderBlock({
      confirmed: [...before, offer, bullDisp, through],
      displacementIndex: before.length + 1,
      direction: 'BULL',
      atr14: atr,
    });
    assert.equal(invalidated.found, false);
    assert.equal(invalidated.evidence.mitigated, true);
  });

  it('BID_ASK_SPREAD 屬於可選缺失欄位，不得單獨把完整結構打成 WAIT', () => {
    assert.equal(OPTIONAL_PROVENANCE_GAPS.has('BID_ASK_SPREAD'), true);
    assert.deepEqual(coreMissingData(['BID_ASK_SPREAD', 'openInterest']), ['openInterest']);

    const fullBullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });
    const res = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': fullBullKlines,
        '15m': fullBullKlines,
        '1h': fullBullKlines,
        '4h': fullBullKlines,
      },
      openInterest: 100_000_000,
      provenance: { ...liveProvenance, missingData: ['BID_ASK_SPREAD'] },
    });
    assert.equal(res.actionState, 'LONG CANDIDATE');
    assert.equal(res.waitReasons.some((r) => r.includes('BID_ASK_SPREAD')), false);
  });

  it('歷史量能 INSUFFICIENT_HISTORY 時，可從已收盤 15m K 線回補 30 根基線而不再誤觸 WAIT', () => {
    const fullBullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });
    const res = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': fullBullKlines,
        '15m': fullBullKlines,
        '1h': fullBullKlines,
        '4h': fullBullKlines,
      },
      openInterest: 100_000_000,
      historicalVolume: {
        symbol: 'SOLUSDT',
        exchange: 'binance_usdm',
        status: 'INSUFFICIENT_HISTORY',
        sampleCount: 0,
        minRequiredSamples: 30,
        currentVolume: 0,
        rollingMedian: null,
        mad: null,
        zScore: null,
        robustZScore: null,
        rvol: null,
        isHistoricalAnomaly: false,
        baselineUnstable: false,
        volumeTimeframe: '15m',
        aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
        volumeMetric: 'quoteVolume',
        provenance: liveProvenance,
      },
      provenance: liveProvenance,
    });
    assert.equal(
      res.waitReasons.some((r) => r.includes('INSUFFICIENT_HISTORY')),
      false,
      res.waitReasons.join(' | ')
    );
    assert.equal(res.actionState, 'LONG CANDIDATE');
  });

  it('BULL 延續突破標為 BOS，先做更低低點再往上收盤突破則標為 MSS', () => {
    const fullBullKlines = generateDeterministicSmcKlines({
      basePrice: 100,
      count: 60,
      intervalMs: 15 * 60 * 1000,
      endOpenTime: Date.now(),
      mode: 'BULL',
    });
    const bull = evaluateSmcStructure({
      symbol: 'SOLUSDT',
      primaryTimeframe: '15m',
      klinesByTimeframe: {
        '5m': fullBullKlines,
        '15m': fullBullKlines,
        '1h': fullBullKlines,
        '4h': fullBullKlines,
      },
      openInterest: 100_000_000,
      provenance: liveProvenance,
    });
    assert.equal(bull.bosOrMss.detected, true);
    assert.ok(
      bull.bosOrMss.type === 'BOS_BULL' || bull.bosOrMss.type === 'MSS_BULL',
      bull.bosOrMss.type
    );
  });
});
