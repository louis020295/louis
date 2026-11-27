import type {
  EarlyIgnitionSignal,
  EntryZoneAnalysis,
  SmcActionState,
  SmcMtfAlignment,
  TradeHorizonCategory,
  TradeHorizonCriterion,
  TradeHorizonProfile,
} from '../../src/types/market.ts';

export interface ClassifyTradeHorizonInput {
  smcActionState: SmcActionState;
  intendedDirection?: 'LONG' | 'SHORT' | 'NEUTRAL';
  mtfAlignment?: SmcMtfAlignment | null;
  atrPercent?: number | null;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  fundingRate: number | null;
  entryZoneAnalysis?: EntryZoneAnalysis | null;
  earlyIgnition?: EarlyIgnitionSignal | null;
  bosOrMssDetected?: boolean;
  displacementDetected?: boolean;
  rvol?: number | null;
}

function formatSignedPct(val: number): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

export function classifyTradeHorizon(
  input: ClassifyTradeHorizonInput
): TradeHorizonProfile {
  const {
    smcActionState,
    intendedDirection = 'NEUTRAL',
    mtfAlignment = null,
    atrPercent = null,
    priceChangePercent24h,
    quoteVolume24h,
    fundingRate,
    entryZoneAnalysis = null,
    earlyIgnition = null,
    bosOrMssDetected = false,
    displacementDetected = false,
    rvol = null,
  } = input;

  const hasActiveIgnition =
    earlyIgnition !== null &&
    earlyIgnition !== undefined &&
    earlyIgnition.status !== 'NONE' &&
    earlyIgnition.direction !== 'NEUTRAL';

  const effectiveDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
    smcActionState === 'LONG CANDIDATE'
      ? 'LONG'
      : smcActionState === 'SHORT CANDIDATE'
        ? 'SHORT'
        : intendedDirection !== 'NEUTRAL'
          ? intendedDirection
          : entryZoneAnalysis && entryZoneAnalysis.direction !== 'NEUTRAL'
            ? entryZoneAnalysis.direction
            : hasActiveIgnition
              ? earlyIgnition!.direction
              : 'NEUTRAL';

  if (
    effectiveDirection === 'NEUTRAL' ||
    (smcActionState === 'PENDING' && !hasActiveIgnition)
  ) {
    return {
      category: 'PENDING_OR_NEUTRAL',
      labelZh: '待確認',
      verdictShortZh: '待方向確立後判定長短線',
      holdingWindowZh: '尚未進場',
      summaryZh:
        '目前尚未形成明確多空方向或尚未完成多週期結構掃描，暫不建議設定持倉週期。',
      executionPlaybookZh:
        '先點選標的載入完整 15m/1h/4h 結構，待方向與止損位明確後再決定短打或抱波段。',
      criteria: [
        {
          key: 'MTF_CONSENSUS',
          labelZh: '多週期方向共識',
          passedForSwing: false,
          valueText:
            smcActionState === 'PENDING' ? '結構評估中' : '方向尚未表態',
          impactZh: '需先確認 15m / 1h / 4h 方向',
        },
        {
          key: 'TARGET_ROOM',
          labelZh: '預期目標空間',
          passedForSwing: false,
          valueText: atrPercent !== null ? `ATR ${atrPercent.toFixed(2)}%` : '待計算',
          impactZh: '無明確進場錨點與目標距離',
        },
        {
          key: 'EXTENSION_POSITION',
          labelZh: '進場位置熱度',
          passedForSwing: false,
          valueText: `24h ${formatSignedPct(priceChangePercent24h)}`,
          impactZh: '等待回踩或轉折出現',
        },
        {
          key: 'CARRY_COST',
          labelZh: '持倉成本與深度',
          passedForSwing:
            quoteVolume24h >= 30_000_000 &&
            (fundingRate === null || Math.abs(fundingRate) < 0.0003),
          valueText:
            fundingRate !== null
              ? `F ${(fundingRate * 100).toFixed(4)}%`
              : 'Funding 缺失',
          impactZh:
            quoteVolume24h >= 30_000_000
              ? '流動性充足，可支援進階評估'
              : '流動性偏低，宜謹慎控制部位',
        },
      ],
    };
  }

  const dirBias = effectiveDirection === 'LONG' ? 'BULL' : 'BEAR';
  const byTf = mtfAlignment?.byTimeframe;
  const tf15m = byTf?.['15m'] ?? 'MISSING';
  const tf1h = byTf?.['1h'] ?? 'MISSING';
  const tf4h = byTf?.['4h'] ?? 'MISSING';
  const aligned15m = tf15m === dirBias;
  const aligned1h = tf1h === dirBias;
  const aligned4h = tf4h === dirBias;
  const htfConflict = mtfAlignment?.dominantDirection === 'CONFLICT';
  const hasBothHtf = aligned1h && aligned4h && !htfConflict;
  const has1hOr4hSupport = (aligned1h || aligned4h) && !htfConflict;
  const isPureEarlyIgnition =
    hasActiveIgnition &&
    smcActionState !== 'LONG CANDIDATE' &&
    smcActionState !== 'SHORT CANDIDATE' &&
    !hasBothHtf;

  // Target distance & R:R evaluation
  const effectiveEntry =
    entryZoneAnalysis?.idealPullbackEntry ?? entryZoneAnalysis?.currentPrice ?? null;
  const targetDistancePct =
    entryZoneAnalysis?.targetPrice !== null &&
    entryZoneAnalysis?.targetPrice !== undefined &&
    effectiveEntry !== null &&
    effectiveEntry > 0
      ? (Math.abs(entryZoneAnalysis.targetPrice - effectiveEntry) /
          effectiveEntry) *
        100
      : null;
  const effectiveRR =
    entryZoneAnalysis?.pullbackRR ?? entryZoneAnalysis?.chaseRR ?? null;
  const estimatedRoomPct =
    targetDistancePct !== null
      ? targetDistancePct
      : atrPercent !== null
        ? atrPercent * 2.5
        : null;
  const hasSwingRoom =
    estimatedRoomPct !== null &&
    estimatedRoomPct >= 3.0 &&
    (effectiveRR === null || effectiveRR >= 2.0);
  const tightTarget = targetDistancePct !== null && targetDistancePct < 1.8;

  // Extension / overheated check
  const abs24h = Math.abs(priceChangePercent24h);
  const isOverextended =
    entryZoneAnalysis?.status === 'OVEREXTENDED' || abs24h >= 18;
  const inOrNearPoi =
    entryZoneAnalysis?.status === 'NEAR_POI' ||
    entryZoneAnalysis?.status === 'NEAR_PULLBACK_ZONE';

  // Funding & liquidity carry check
  const adverseFunding =
    fundingRate !== null &&
    ((effectiveDirection === 'LONG' && fundingRate >= 0.0003) ||
      (effectiveDirection === 'SHORT' && fundingRate <= -0.0003) ||
      Math.abs(fundingRate) >= 0.0005);
  const deepLiquidity = quoteVolume24h >= 30_000_000;
  const healthyCarry = !adverseFunding && deepLiquidity;

  // Determine exact horizon category
  let category: TradeHorizonCategory;
  if (
    smcActionState !== 'HIGH RISK' &&
    !isPureEarlyIgnition &&
    hasBothHtf &&
    hasSwingRoom &&
    !isOverextended &&
    healthyCarry &&
    (aligned15m || inOrNearPoi || bosOrMssDetected)
  ) {
    category = 'SWING_EXTENDED';
  } else if (
    isPureEarlyIgnition ||
    smcActionState === 'HIGH RISK' ||
    !has1hOr4hSupport ||
    isOverextended ||
    adverseFunding ||
    tightTarget
  ) {
    category = 'SCALP_FAST';
  } else {
    category = 'INTRADAY_TREND';
  }

  // Build 4 explicit criteria rows
  const mtfCriterion: TradeHorizonCriterion = {
    key: 'MTF_CONSENSUS',
    labelZh: '高週期共識 (15m/1h/4h)',
    passedForSwing: hasBothHtf,
    valueText: `15m:${tf15m === 'MISSING' ? '?' : tf15m} · 1h:${tf1h === 'MISSING' ? '?' : tf1h} · 4h:${tf4h === 'MISSING' ? '?' : tf4h}`,
    impactZh: hasBothHtf
      ? '1h 與 4h 雙高週期順向撐腰，可看波段延伸'
      : has1hOr4hSupport
        ? `${aligned4h ? '4h' : '1h'} 單一高週期配合，適合日內順勢`
        : isPureEarlyIgnition
          ? '僅 5m/15m 早鳥點火，缺高週期保護只宜短線'
          : '高週期尚未同向或存在分歧，不宜長抱',
  };

  const targetCriterion: TradeHorizonCriterion = {
    key: 'TARGET_ROOM',
    labelZh: '預期目標空間',
    passedForSwing: hasSwingRoom,
    valueText:
      targetDistancePct !== null
        ? `目標距 ${targetDistancePct.toFixed(2)}%${effectiveRR !== null ? ` (1:${effectiveRR})` : ''}`
        : estimatedRoomPct !== null
          ? `約 ${estimatedRoomPct.toFixed(2)}% (2.5x ATR)`
          : '空間待計算',
    impactZh: hasSwingRoom
      ? '目標潛在幅度與盈虧比充足，值得抱單吃主段'
      : tightTarget
        ? '距離關鍵壓力/支撐較近，見目標宜先落袋'
        : '屬標準日內波動空間（約 1.8% ~ 3%）',
  };

  const positionValue =
    entryZoneAnalysis?.status === 'OVEREXTENDED' &&
    entryZoneAnalysis.distanceToZoneAtr !== null
      ? `偏離 POI ${entryZoneAnalysis.distanceToZoneAtr.toFixed(1)}x ATR`
      : inOrNearPoi
        ? `${entryZoneAnalysis?.status === 'NEAR_POI' ? '已入' : '緊貼'} ${entryZoneAnalysis?.anchorType ?? 'FVG/OB'} 區`
        : `24h ${formatSignedPct(priceChangePercent24h)}${rvol !== null ? ` · ${rvol}x 量` : ''}`;

  const positionCriterion: TradeHorizonCriterion = {
    key: 'EXTENSION_POSITION',
    labelZh: '進場位置熱度',
    passedForSwing: !isOverextended,
    valueText: positionValue,
    impactZh: isOverextended
      ? '短線已大幅拉開或追高過熱，慎防回吐宜快進快出'
      : inOrNearPoi
        ? '位於 POI 回踩防守區，止損緊湊適合安心抱單'
        : '漲跌幅溫和未過熱，可依結構持有',
  };

  const carryCriterion: TradeHorizonCriterion = {
    key: 'CARRY_COST',
    labelZh: '費率與流動性成本',
    passedForSwing: healthyCarry,
    valueText: `${fundingRate !== null ? `F ${(fundingRate * 100).toFixed(4)}%` : 'F 缺失'} · 量 $${Math.round(quoteVolume24h / 1_000_000)}M`,
    impactZh: adverseFunding
      ? '資金費率偏高或逆風，跨日持倉磨損大建議短打'
      : !deepLiquidity
        ? '24h 成交額低於 $30M，流動性偏淺不宜隔夜重倉'
        : displacementDetected
          ? '費率低且深度夠，配合位移推動利於持倉'
          : '持倉成本低且深度充足，可跨時段持有',
  };

  const criteria = [
    mtfCriterion,
    targetCriterion,
    positionCriterion,
    carryCriterion,
  ];

  if (category === 'SWING_EXTENDED') {
    return {
      category,
      labelZh: '長線波段',
      verdictShortZh: '適合長線／波段持有',
      holdingWindowZh: '8 ~ 48 小時+',
      summaryZh:
        '1h 與 4h 高週期同向撐腰、目標空間大且尚未過熱、資金費率健康，具備跨時段抱波段條件。',
      executionPlaybookZh:
        '優先在 FVG / OB 興趣區（POI）掛單或以 4h 結構設止損；達 TP1 後移動止損至保本，保留部分倉位跟隨 1h/4h 趨勢延伸。',
      criteria,
    };
  }

  if (category === 'SCALP_FAST') {
    const quickReasonParts: string[] = [];
    if (isPureEarlyIgnition) quickReasonParts.push('早鳥 5m/15m 點火尚未等大週期共識');
    else if (!has1hOr4hSupport) quickReasonParts.push('缺 1h/4h 順向支撐');
    if (isOverextended) quickReasonParts.push('現價位置偏延伸過熱');
    if (adverseFunding) quickReasonParts.push('資金費率成本較高');
    if (tightTarget) quickReasonParts.push('距離目標阻力較近');
    if (smcActionState === 'HIGH RISK') quickReasonParts.push('高風險高波動區間');

    return {
      category,
      labelZh: '短線快打',
      verdictShortZh: '適合短線快打（勿久抱）',
      holdingWindowZh: '30分 ~ 2 小時',
      summaryZh: `${quickReasonParts.slice(0, 2).join('、') || '屬於短線動能訊號'}，適合吃爆發波段後快進快出，不建議硬扛成隔夜長單。`,
      executionPlaybookZh:
        '嚴守 5m/15m 前低或掃單極值止損；衝出第一段利潤或見 5m 反向失衡即分批獲利，不隔夜扛單。',
      criteria,
    };
  }

  return {
    category,
    labelZh: '日內順勢',
    verdictShortZh: '適合日內順勢（當日短波）',
    holdingWindowZh: '2 ~ 8 小時',
    summaryZh:
      '具備明確日內結構方向與部分高週期配合，但尚未全面滿足跨日大波段條件，以當日行情結算為主。',
    executionPlaybookZh:
      '順 15m/1h 結構抱到關鍵前高/前低 (PDH/PDL) 或 2R~2.5R 目標；若當日未延伸突破或 1h 轉弱則先結算落袋。',
    criteria,
  };
}
