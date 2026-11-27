import {
  CandidateEvidenceType,
  DataProvenance,
} from '../../src/types/market.ts';

export const TEST_FIXTURE_SOURCE_KEYWORDS = [
  'VERIFICATION_SCRIPT',
  'TEST_FIXTURE',
  'UNIT_TEST_FIXTURE',
  'SYNTHETIC_TEST_DATA',
  'API_INTEGRATION_TEST',
  'UNIT_TEST',
  'CONTROLLED_LIVE_FIXTURE',
  'CONTROLLED_FIXTURE',
] as const;

export const DEMO_SOURCE_KEYWORDS = [
  'DEMO_SYNTHETIC_DATASET',
  'DEMO_ONLY',
  'DEMO_LATENCY_FIXTURE',
] as const;

const VERIFIED_LIVE_PUBLIC_API_PATTERNS = [
  'Binance USDⓈ-M Futures REST',
  'Binance USDⓈ-M Futures',
  'Binance USD-M Futures',
  'fapi.binance.com',
  'fapi1.binance.com',
  'fapi2.binance.com',
  'Bybit V5 Linear REST',
  'Bybit V5 Linear',
  'api.bybit.com',
  'api.bytick.com',
  'BingX Swap V2 REST',
  'BingX Swap V3 REST',
  'BingX Swap',
  'open-api.bingx.com',
] as const;

export function isTestFixtureSourceName(source: string): boolean {
  const upper = (source || '').toUpperCase();
  return TEST_FIXTURE_SOURCE_KEYWORDS.some((kw) => upper.includes(kw));
}

export function isDemoSourceName(source: string): boolean {
  const upper = (source || '').toUpperCase();
  return (
    DEMO_SOURCE_KEYWORDS.some((kw) => upper.includes(kw)) ||
    upper.includes('(DEMO)')
  );
}

/**
 * Strictly returns true ONLY if the data provenance source originates from
 * genuine Binance, Bybit, or BingX public REST APIs and contains no test/demo markers.
 */
export function isVerifiedLivePublicApiSource(source: string): boolean {
  if (!source || typeof source !== 'string') return false;
  if (isTestFixtureSourceName(source) || isDemoSourceName(source)) {
    return false;
  }
  const upper = source.toUpperCase();
  if (
    upper.includes('FIXTURE') ||
    upper.includes('SYNTHETIC') ||
    upper.includes('DEMO') ||
    upper.includes('MOCK') ||
    upper.includes('VERIFICATION') ||
    upper.includes('CONTROLLED')
  ) {
    return false;
  }
  return VERIFIED_LIVE_PUBLIC_API_PATTERNS.some((pattern) =>
    source.includes(pattern)
  );
}

/**
 * Phase 18.4: Strictly resolves candidate & latency evidence into one of 3 disjoint categories:
 * - LIVE_PRODUCTION: genuine Binance/Bybit/BingX Live public data
 * - CONTROLLED_LIVE_FIXTURE: controlled test fixture data
 * - DEMO_LATENCY_FIXTURE: Demo simulation data
 */
export function resolveCandidateEvidenceType(params: {
  exchange?: string | null;
  isDemo?: boolean | null;
  isTestFixture?: boolean | null;
  source?: string | null;
  evidenceType?: CandidateEvidenceType | string | null;
}): CandidateEvidenceType {
  if (params.evidenceType === 'DEMO_LATENCY_FIXTURE') {
    return 'DEMO_LATENCY_FIXTURE';
  }
  if (params.evidenceType === 'CONTROLLED_LIVE_FIXTURE') {
    return 'CONTROLLED_LIVE_FIXTURE';
  }
  const src = String(params.source || '');
  const upper = src.toUpperCase();
  if (
    params.exchange === 'demo_synthetic' ||
    isDemoSourceName(src) ||
    upper.includes('DEMO_SYNTHETIC') ||
    upper.includes('DEMO_LATENCY') ||
    (params.isDemo === true &&
      !upper.includes('CONTROLLED') &&
      !upper.includes('TEST_FIXTURE') &&
      !params.isTestFixture)
  ) {
    return 'DEMO_LATENCY_FIXTURE';
  }
  if (
    params.isTestFixture === true ||
    isTestFixtureSourceName(src) ||
    upper.includes('CONTROLLED') ||
    upper.includes('FIXTURE')
  ) {
    return 'CONTROLLED_LIVE_FIXTURE';
  }
  if (!params.isDemo && isVerifiedLivePublicApiSource(src)) {
    return 'LIVE_PRODUCTION';
  }
  if (params.isDemo) {
    return 'DEMO_LATENCY_FIXTURE';
  }
  return 'CONTROLLED_LIVE_FIXTURE';
}

/**
 * Enforces strict provenance rules:
 * - Any source from VERIFICATION_SCRIPT, TEST_FIXTURE, SYNTHETIC_TEST_DATA, or DEMO_SYNTHETIC_DATASET with isDemo=false
 *   is forced to: { source: "TEST_FIXTURE", isDemo: true, isTestFixture: true, fallback: false }
 * - Manual Demo mode (DEMO_SYNTHETIC_DATASET with isDemo=true) is forced to: { isDemo: true, isTestFixture: true, fallback: false }
 * - Only genuine Binance, Bybit, or BingX public API data can have isDemo: false.
 */
export function enforceProvenanceIntegrity(
  prov: DataProvenance
): DataProvenance {
  const rawSource = prov.source || 'TEST_FIXTURE';

  if (isTestFixtureSourceName(rawSource)) {
    return {
      ...prov,
      source: 'TEST_FIXTURE',
      isDemo: true,
      isTestFixture: true,
      fallback: false,
    };
  }

  if (isDemoSourceName(rawSource)) {
    // If someone attempted to mark DEMO_SYNTHETIC_DATASET as isDemo: false, rewrite to TEST_FIXTURE
    if (!prov.isDemo) {
      return {
        ...prov,
        source: 'TEST_FIXTURE',
        isDemo: true,
        isTestFixture: true,
        fallback: false,
      };
    }
    return {
      ...prov,
      isDemo: true,
      isTestFixture: true,
      fallback: false,
    };
  }

  if (!isVerifiedLivePublicApiSource(rawSource)) {
    return {
      ...prov,
      source: 'TEST_FIXTURE',
      isDemo: true,
      isTestFixture: true,
      fallback: false,
    };
  }

  // Genuine Binance, Bybit, or BingX public API source:
  // If caller already marked isDemo or isTestFixture, preserve it; otherwise allow isDemo: false.
  if (prov.isDemo || prov.isTestFixture) {
    return {
      ...prov,
      isDemo: true,
      isTestFixture: Boolean(prov.isTestFixture),
    };
  }

  return {
    ...prov,
    isDemo: false,
    isTestFixture: false,
  };
}
