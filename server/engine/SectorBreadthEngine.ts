import {
  MarketBreadthSummary,
  MarketSectorInfo,
  MarketSectorKey,
  ScannedCandidate,
  SectorRotationItem,
} from '../../src/types/market.ts';

const SECTOR_META: Record<MarketSectorKey, string> = {
  BTC_ETH: '大盤龍頭 BTC/ETH',
  L1: '主流公鏈 L1',
  L2: 'Layer 2 擴容',
  AI: 'AI 與算力代理',
  MEME: 'Meme 迷因板塊',
  DEFI: 'DeFi 與借貸衍生品',
  RWA_INFRA: 'RWA / 儲存基建',
  OTHER: '其他山寨合約',
};

const SECTOR_MAP: Record<MarketSectorKey, Set<string>> = {
  BTC_ETH: new Set(['BTC', 'ETH']),
  L1: new Set([
    'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'TON', 'TRX', 'SUI', 'APT',
    'NEAR', 'ATOM', 'SEI', 'TIA', 'INJ', 'FTM', 'S', 'KAS', 'ALGO', 'HBAR',
    'ICP', 'EGLD', 'FLOW', 'KAVA', 'MINA', 'XTZ', 'EOS', 'ETC', 'BCH', 'LTC',
    'BERA', 'MOVE', 'IP', 'TONCOIN', 'STX', 'LTC', 'XLM', 'VET', 'IOTA',
  ]),
  L2: new Set([
    'ARB', 'OP', 'STRK', 'ZK', 'MANTA', 'METIS', 'IMX', 'POL', 'MATIC',
    'LINEA', 'SCROLL', 'SCR', 'BLAST', 'MODE', 'BOBA', 'LRC', 'TAIKO',
    'ZETA', 'ALT', 'AEVO', 'STARK',
  ]),
  AI: new Set([
    'TAO', 'FET', 'RENDER', 'RNDR', 'WLD', 'ARKM', 'IO', 'AKT', 'VIRTUAL',
    'AI16Z', 'AIXBT', 'GRIFFAIN', 'SWARMS', 'GRASS', 'KAITO', 'PHB', 'NMR',
    'AGIX', 'OCEAN', 'AI', 'NFP', 'RLC', 'CTXC', 'CGPT', 'GOAT', 'COOKIE',
  ]),
  MEME: new Set([
    'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'BOME', 'MEME', 'MYRO',
    'POPCAT', 'NEIRO', 'PNUT', 'ACT', 'TURBO', 'MEW', 'BRETT', 'SPX',
    'PENGU', 'FARTCOIN', 'CHILLGUY', 'TRUMP', 'MELANIA', 'MOG', 'COQ', 'RATS',
    'SATS', 'ORDI', 'PEOPLE', 'LUNC', 'DOGS', 'HMSTR', 'CATI', 'BAN', 'MOODENG',
    'HIPPO', 'SLERF', 'BOOK', 'DEGEN', 'BABYDOGE', 'CHEEMS',
  ]),
  DEFI: new Set([
    'UNI', 'AAVE', 'MKR', 'SKY', 'CRV', 'SNX', 'COMP', 'LDO', 'PENDLE',
    'ENA', 'ETHFI', 'JUP', 'RAY', 'DYDX', 'GMX', 'RUNE', 'SUSHI', '1INCH',
    'CAKE', 'CVX', 'FXS', 'YFI', 'BAL', 'MORPHO', 'EIGEN', 'USUAL', 'ONDO',
    'AERO', 'ORCA', 'DRIFT', 'COW', 'KMNO', 'SSV', 'RSR',
  ]),
  RWA_INFRA: new Set([
    'LINK', 'PYTH', 'GRT', 'AR', 'FIL', 'THETA', 'ENS', 'HNT', 'JTO',
    'OM', 'MANTRA', 'POLYX', 'TRU', 'CFG', 'ANKR', 'GLM', 'LPT', 'ROSE',
    'SAFE', 'W', 'ZRO', 'AXL', 'API3', 'BAND', 'TRB', 'UMA', 'XDC', 'QNT',
  ]),
  OTHER: new Set(),
};

function normalizeBaseToken(baseAsset: string, symbol: string): string {
  const raw = (baseAsset || symbol.replace(/USDT$/i, '')).toUpperCase().trim();
  // Strip multiplier prefixes commonly used in perpetual contracts (e.g. 1000PEPE, 1000SHIB, 1MBABYDOGE)
  return raw.replace(/^(1000000|10000|1000|100|1M)/, '');
}

export function classifySymbolSector(
  baseAsset: string,
  symbol: string
): MarketSectorInfo {
  const token = normalizeBaseToken(baseAsset, symbol);
  const rawUpper = (baseAsset || symbol.replace(/USDT$/i, '')).toUpperCase();

  for (const key of [
    'BTC_ETH',
    'AI',
    'MEME',
    'L2',
    'DEFI',
    'RWA_INFRA',
    'L1',
  ] as MarketSectorKey[]) {
    if (SECTOR_MAP[key].has(token) || SECTOR_MAP[key].has(rawUpper)) {
      return { key, labelZh: SECTOR_META[key] };
    }
  }
  return { key: 'OTHER', labelZh: SECTOR_META.OTHER };
}

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function computeMarketBreadthAndSectors(
  candidates: ScannedCandidate[]
): {
  marketBreadth: MarketBreadthSummary;
  sectorRotation: SectorRotationItem[];
} {
  const totalSymbols = candidates.length;
  if (totalSymbols === 0) {
    return {
      marketBreadth: {
        totalSymbols: 0,
        advancingCount: 0,
        decliningCount: 0,
        advancingRatioPct: 0,
        medianChange24hPct: 0,
        avgChange24hPct: 0,
        avgBtcPearson15m: null,
        highBtcCoupledCount: 0,
        highBtcCoupledRatioPct: null,
        lowIndependentCount: 0,
        bullRadarCount: 0,
        bearRadarCount: 0,
        formalCandidateCount: 0,
        marketRegime: 'SELECTIVE_CHOP',
        marketRegimeLabelZh: '無有效掃描標的',
      },
      sectorRotation: [],
    };
  }

  let advancingCount = 0;
  let decliningCount = 0;
  let sumChange = 0;
  const changes: number[] = [];
  let sumVolAll = 0;

  let bullRadarCount = 0;
  let bearRadarCount = 0;
  let formalCandidateCount = 0;

  const pearsonList: number[] = [];
  let highBtcCoupledCount = 0;
  let lowIndependentCount = 0;

  const sectorBuckets = new Map<MarketSectorKey, ScannedCandidate[]>();
  for (const key of Object.keys(SECTOR_META) as MarketSectorKey[]) {
    sectorBuckets.set(key, []);
  }

  for (const c of candidates) {
    const ch = Number.isFinite(c.priceChangePercent24h)
      ? c.priceChangePercent24h
      : 0;
    if (ch > 0) advancingCount++;
    else if (ch < 0) decliningCount++;
    sumChange += ch;
    changes.push(ch);
    sumVolAll += Math.max(0, c.quoteVolume24h || 0);

    if (c.marketRadarCategory === '雷達多頭觀察') bullRadarCount++;
    if (c.marketRadarCategory === '雷達空頭觀察') bearRadarCount++;
    if (
      c.finalTradeSignal === '多頭交易候選' ||
      c.finalTradeSignal === '空頭交易候選'
    ) {
      formalCandidateCount++;
    }

    const corr = c.btcCorrelation;
    if (corr && !corr.isBenchmark && corr.status === 'READY') {
      if (typeof corr.pearson15m === 'number') {
        pearsonList.push(corr.pearson15m);
      }
      if (corr.tier === 'HIGH_COUPLED') highBtcCoupledCount++;
      if (corr.tier === 'LOW_INDEPENDENT' || corr.tier === 'INVERSE') {
        lowIndependentCount++;
      }
    }

    const sec = c.sector ?? classifySymbolSector(c.baseAsset, c.symbol);
    c.sector = sec;
    sectorBuckets.get(sec.key)!.push(c);
  }

  changes.sort((a, b) => a - b);
  const mid = Math.floor(changes.length / 2);
  const medianChange24hPct =
    changes.length % 2 === 1
      ? changes[mid]
      : (changes[mid - 1] + changes[mid]) / 2;

  const advancingRatioPct = roundTo((advancingCount / totalSymbols) * 100, 1);
  const avgChange24hPct = roundTo(sumChange / totalSymbols, 2);
  const avgBtcPearson15m =
    pearsonList.length > 0
      ? roundTo(
          pearsonList.reduce((a, b) => a + b, 0) / pearsonList.length,
          2
        )
      : null;
  const highBtcCoupledRatioPct =
    pearsonList.length > 0
      ? roundTo((highBtcCoupledCount / pearsonList.length) * 100, 1)
      : null;

  let marketRegime: MarketBreadthSummary['marketRegime'] = 'SELECTIVE_CHOP';
  let marketRegimeLabelZh = '板塊分化震盪（精選獨立強勢結構）';
  if (advancingRatioPct >= 65 && avgChange24hPct >= 1.2) {
    marketRegime = 'BROAD_RISK_ON';
    marketRegimeLabelZh = '全面多頭風險偏好（廣度擴張，利於順勢多單）';
  } else if (advancingRatioPct <= 35 && avgChange24hPct <= -1.2) {
    marketRegime = 'BROAD_RISK_OFF';
    marketRegimeLabelZh = '系統性普跌避險（廣度疲弱，慎防多單接刀）';
  } else if (
    highBtcCoupledRatioPct !== null &&
    highBtcCoupledRatioPct >= 60
  ) {
    marketRegime = 'BTC_LED_ROTATION';
    marketRegimeLabelZh = '大盤 BTC 主導高度共振（山寨易受大餅突變連帶影響）';
  }

  const sectorRotation: SectorRotationItem[] = [];
  for (const [key, list] of sectorBuckets.entries()) {
    if (list.length === 0) continue;
    const totalQuoteVolume24h = list.reduce(
      (acc, c) => acc + Math.max(0, c.quoteVolume24h || 0),
      0
    );
    const secAdvancing = list.filter((c) => c.priceChangePercent24h > 0).length;
    const secAvgChg =
      list.reduce((acc, c) => acc + (c.priceChangePercent24h || 0), 0) /
      list.length;
    const secBull = list.filter(
      (c) => c.marketRadarCategory === '雷達多頭觀察'
    ).length;
    const secBear = list.filter(
      (c) => c.marketRadarCategory === '雷達空頭觀察'
    ).length;
    const secIndep = list.filter(
      (c) =>
        c.btcCorrelation?.status === 'READY' &&
        (c.btcCorrelation.tier === 'LOW_INDEPENDENT' ||
          c.btcCorrelation.tier === 'INVERSE')
    ).length;
    const secPearsons = list
      .map((c) => c.btcCorrelation?.pearson15m)
      .filter((v): v is number => typeof v === 'number');
    const secAvgPearson =
      secPearsons.length > 0
        ? roundTo(
            secPearsons.reduce((a, b) => a + b, 0) / secPearsons.length,
            2
          )
        : null;

    const sortedByChange = [...list].sort(
      (a, b) => b.priceChangePercent24h - a.priceChangePercent24h
    );
    const leader = sortedByChange[0];

    sectorRotation.push({
      key,
      labelZh: SECTOR_META[key],
      symbolCount: list.length,
      totalQuoteVolume24h: Math.round(totalQuoteVolume24h),
      volumeSharePct:
        sumVolAll > 0
          ? roundTo((totalQuoteVolume24h / sumVolAll) * 100, 1)
          : 0,
      avgChange24hPct: roundTo(secAvgChg, 2),
      advancingRatioPct: roundTo((secAdvancing / list.length) * 100, 1),
      bullRadarCount: secBull,
      bearRadarCount: secBear,
      independentCount: secIndep,
      avgBtcPearson15m: secAvgPearson,
      topLeaderSymbol: leader?.symbol ?? null,
      topLeaderChange24hPct: leader
        ? roundTo(leader.priceChangePercent24h, 2)
        : null,
    });
  }

  sectorRotation.sort((a, b) => {
    if (b.avgChange24hPct !== a.avgChange24hPct) {
      return b.avgChange24hPct - a.avgChange24hPct;
    }
    return b.totalQuoteVolume24h - a.totalQuoteVolume24h;
  });

  return {
    marketBreadth: {
      totalSymbols,
      advancingCount,
      decliningCount,
      advancingRatioPct,
      medianChange24hPct: roundTo(medianChange24hPct, 2),
      avgChange24hPct,
      avgBtcPearson15m,
      highBtcCoupledCount,
      highBtcCoupledRatioPct,
      lowIndependentCount,
      bullRadarCount,
      bearRadarCount,
      formalCandidateCount,
      marketRegime,
      marketRegimeLabelZh,
    },
    sectorRotation,
  };
}
