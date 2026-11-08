export type AssetClass = 'crypto' | 'tradfi' | 'unverified';

export interface InstrumentIdentity {
  assetClass: AssetClass;
  underlying: string | null;
  symbolType: string | null;
  metadataAvailable: boolean;
}

const TRADFI_TOKENS = new Set([
  'stock',
  'stocks',
  'equity',
  'equities',
  'tradfi',
  'commodity',
  'commodities',
  'forex',
  'index',
  'indices',
  'metal',
  'etf',
]);

const CRYPTO_TOKENS = new Set(['crypto', 'coin', 'coins', 'innovation']);

function tokensOf(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Classify a contract from fields the venue itself returns.
 * Missing or unrecognized type fields stay unverified so they are not
 * compared with a verified instrument that only shares a ticker.
 */
export function classifyFromExchangeFields(input: {
  symbolType?: string | null;
  underlyingType?: string | null;
  underlyingSubType?: Array<string | null | undefined> | string | null;
  underlying?: string | null;
  baseAsset?: string | null;
}): InstrumentIdentity {
  const subtypes = Array.isArray(input.underlyingSubType)
    ? input.underlyingSubType
    : input.underlyingSubType
      ? [input.underlyingSubType]
      : [];
  const typeTokens = [
    ...tokensOf(input.symbolType),
    ...tokensOf(input.underlyingType),
    ...subtypes.flatMap((item) => tokensOf(item)),
  ];
  const underlying = (input.underlying || input.baseAsset || '').trim() || null;
  const symbolType =
    (input.symbolType || input.underlyingType || '').trim() || null;

  if (typeTokens.length === 0) {
    return {
      assetClass: 'unverified',
      underlying,
      symbolType: null,
      metadataAvailable: false,
    };
  }
  if (typeTokens.some((token) => TRADFI_TOKENS.has(token))) {
    return {
      assetClass: 'tradfi',
      underlying,
      symbolType,
      metadataAvailable: true,
    };
  }
  if (typeTokens.some((token) => CRYPTO_TOKENS.has(token))) {
    return {
      assetClass: 'crypto',
      underlying,
      symbolType,
      metadataAvailable: true,
    };
  }
  return {
    assetClass: 'unverified',
    underlying,
    symbolType,
    metadataAvailable: false,
  };
}

export function unverifiedInstrument(
  underlying?: string | null
): InstrumentIdentity {
  return {
    assetClass: 'unverified',
    underlying: underlying?.trim() || null,
    symbolType: null,
    metadataAvailable: false,
  };
}

/** Null means this leg must not be included in a cross-venue price comparison. */
export function comparisonGroupKey(
  identity: InstrumentIdentity | null | undefined,
  fallbackUnderlying?: string | null
): string | null {
  if (
    !identity ||
    !identity.metadataAvailable ||
    identity.assetClass === 'unverified'
  ) {
    return null;
  }
  const underlying = (identity.underlying || fallbackUnderlying || '')
    .trim()
    .toLowerCase();
  if (!underlying) return null;
  return `${identity.assetClass}:${underlying}`;
}
