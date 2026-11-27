import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTradeHorizon } from '../server/engine/TradeHorizonClassifier.ts';
import type { EntryZoneAnalysis, EarlyIgnitionSignal } from '../src/types/market.ts';

function makeEntryZone(overrides: Partial<EntryZoneAnalysis> = {}): EntryZoneAnalysis {
  return {
    status: 'IN_DISCOUNT_ZONE',
    direction: 'LONG',
    anchorType: 'FVG',
    anchorLabel: '未回補多頭 FVG 折價區',
    zoneLow: 98,
    zoneHigh: 100,
    idealPullbackEntry: 99,
    stopLossPrice: 97,
    targetPrice: 104.5, // +5.55% from 99
    currentPrice: 99.5,
    distanceToZonePct: 0.2,
    distanceToZoneAtr: 0.15,
    chaseRR: 2.0,
    pullbackRR: 2.75,
    headlineZh: '價格位於理想折價區',
    actionAdviceZh: '可沿折價區分批評估。',
    ...overrides,
  };
}

describe('TradeHorizonClassifier (短線 vs 長線波段具體判定)', () => {
  it('雙高週期 (1h+4h) 同向 + 充足目標空間 + 未過熱 + 低費率深度佳 -> 判定為長線波段 (SWING_EXTENDED)', () => {
    const res = classifyTradeHorizon({
      smcActionState: 'LONG CANDIDATE',
      intendedDirection: 'LONG',
      mtfAlignment: {
        aligned: true,
        dominantDirection: 'BULL',
        byTimeframe: {
          '5m': 'BULL',
          '15m': 'BULL',
          '1h': 'BULL',
          '4h': 'BULL',
        },
        description: '全週期偏多共識',
      },
      atrPercent: 1.4,
      priceChangePercent24h: 4.5,
      quoteVolume24h: 120_000_000,
      fundingRate: 0.0001,
      entryZoneAnalysis: makeEntryZone(),
      bosOrMssDetected: true,
      displacementDetected: true,
      rvol: 2.3,
    });

    assert.equal(res.category, 'SWING_EXTENDED');
    assert.equal(res.labelZh, '長線波段');
    assert.ok(res.verdictShortZh.includes('長線'));
    assert.ok(res.holdingWindowZh.includes('8 ~ 48'));
    assert.equal(res.criteria.length, 4);
    assert.ok(res.criteria.every((c) => c.passedForSwing === true));
  });

  it('僅單一高週期配合 (15m+1h 多頭、4h 中性) 且未過熱 -> 判定為日內順勢 (INTRADAY_TREND)', () => {
    const res = classifyTradeHorizon({
      smcActionState: 'LONG CANDIDATE',
      intendedDirection: 'LONG',
      mtfAlignment: {
        aligned: true,
        dominantDirection: 'BULL',
        byTimeframe: {
          '5m': 'BULL',
          '15m': 'BULL',
          '1h': 'BULL',
          '4h': 'NEUTRAL',
        },
        description: '15m/1h 偏多，4h 中性',
      },
      atrPercent: 1.0,
      priceChangePercent24h: 3.8,
      quoteVolume24h: 85_000_000,
      fundingRate: 0.00008,
      entryZoneAnalysis: makeEntryZone({ targetPrice: 101.6, pullbackRR: 2.1 }),
      bosOrMssDetected: true,
      displacementDetected: true,
    });

    assert.equal(res.category, 'INTRADAY_TREND');
    assert.equal(res.labelZh, '日內順勢');
    assert.ok(res.holdingWindowZh.includes('2 ~ 8'));
    const mtf = res.criteria.find((c) => c.key === 'MTF_CONSENSUS');
    assert.equal(mtf?.passedForSwing, false);
  });

  it('早鳥點火無 1h/4h 共振 / 追高過熱 (OVEREXTENDED) / 高資金費率 -> 皆判定為短線快打 (SCALP_FAST)', () => {
    const ignition: EarlyIgnitionSignal = {
      status: 'IGNITION_LONG',
      tier: 'STRUCTURAL_IGNITION',
      direction: 'LONG',
      ignitionScore: 78,
      change24hPct: 2.4,
      rvol15m: 3.1,
      zScore15m: 3.4,
      triggerTimeframe: '5m',
      sweepDetected: true,
      mssOrBreakDetected: true,
      displacementDetected: true,
      invalidationPrice: 98.2,
      invalidationLabel: '5m 前低',
      headlineZh: '5m 剛點火起漲',
      riskWarningZh: '未等 1h/4h 共振',
    };

    const earlyRes = classifyTradeHorizon({
      smcActionState: 'WATCH',
      intendedDirection: 'LONG',
      mtfAlignment: {
        aligned: false,
        dominantDirection: 'INSUFFICIENT',
        byTimeframe: {
          '5m': 'BULL',
          '15m': 'BULL',
          '1h': 'NEUTRAL',
          '4h': 'NEUTRAL',
        },
        description: '僅低週期點火',
      },
      atrPercent: 1.2,
      priceChangePercent24h: 2.4,
      quoteVolume24h: 60_000_000,
      fundingRate: 0.0001,
      earlyIgnition: ignition,
    });
    assert.equal(earlyRes.category, 'SCALP_FAST');
    assert.equal(earlyRes.labelZh, '短線快打');

    const overextendedRes = classifyTradeHorizon({
      smcActionState: 'LONG CANDIDATE',
      intendedDirection: 'LONG',
      mtfAlignment: {
        aligned: true,
        dominantDirection: 'BULL',
        byTimeframe: {
          '5m': 'BULL',
          '15m': 'BULL',
          '1h': 'BULL',
          '4h': 'BULL',
        },
        description: '多週期偏多',
      },
      atrPercent: 1.8,
      priceChangePercent24h: 21.5,
      quoteVolume24h: 150_000_000,
      fundingRate: 0.0004,
      entryZoneAnalysis: makeEntryZone({
        status: 'OVEREXTENDED',
        distanceToZoneAtr: 2.4,
      }),
    });
    assert.equal(overextendedRes.category, 'SCALP_FAST');
    assert.equal(
      overextendedRes.criteria.find((c) => c.key === 'EXTENSION_POSITION')?.passedForSwing,
      false
    );
    assert.equal(
      overextendedRes.criteria.find((c) => c.key === 'CARRY_COST')?.passedForSwing,
      false
    );
  });

  it('PENDING 且無點火方向時回傳 PENDING_OR_NEUTRAL，明確標示等待表態', () => {
    const res = classifyTradeHorizon({
      smcActionState: 'PENDING',
      intendedDirection: 'NEUTRAL',
      priceChangePercent24h: 1.1,
      quoteVolume24h: 45_000_000,
      fundingRate: 0.0001,
    });
    assert.equal(res.category, 'PENDING_OR_NEUTRAL');
    assert.equal(res.labelZh, '待確認');
  });
});
