import { TradingCostConfig } from '../../src/types/market.ts';
import {
  DEFAULT_FUNDING_INTERVAL_HOURS,
  fundingPeriodsForHold,
  getCachedFundingInterval,
  sanitizeFundingIntervalHours,
} from '../market/FundingInterval.ts';

export const DEFAULT_TRADING_COST_CONFIG: TradingCostConfig = {
  makerFeeBps: 2, // 0.02% Binance USD-M Futures VIP0 Maker
  takerFeeBps: 5, // 0.05% Binance USD-M Futures VIP0 Taker
  slippageBps: 3, // 0.03% conservative per market/stop leg
  defaultFundingRatePer8h: 0.0001, // 0.01% per 8h baseline when funding rate unavailable
  entryOrderType: 'MARKET',
};

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function normalizeTradingCostConfig(
  partial?: Partial<TradingCostConfig> | null
): TradingCostConfig {
  const makerFeeBps = clampNumber(
    partial?.makerFeeBps,
    0,
    50,
    DEFAULT_TRADING_COST_CONFIG.makerFeeBps
  );
  const takerFeeBps = clampNumber(
    partial?.takerFeeBps,
    0,
    50,
    DEFAULT_TRADING_COST_CONFIG.takerFeeBps
  );
  const slippageBps = clampNumber(
    partial?.slippageBps,
    0,
    50,
    DEFAULT_TRADING_COST_CONFIG.slippageBps
  );
  const defaultFundingRatePer8h = clampNumber(
    partial?.defaultFundingRatePer8h,
    -0.01,
    0.01,
    DEFAULT_TRADING_COST_CONFIG.defaultFundingRatePer8h
  );
  const entryOrderType =
    partial?.entryOrderType === 'LIMIT' ? 'LIMIT' : 'MARKET';

  return {
    makerFeeBps: Number(makerFeeBps.toFixed(2)),
    takerFeeBps: Number(takerFeeBps.toFixed(2)),
    slippageBps: Number(slippageBps.toFixed(2)),
    defaultFundingRatePer8h: Number(defaultFundingRatePer8h.toFixed(6)),
    entryOrderType,
  };
}

export interface TradeCostCalculationInput {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  invalidationPrice: number;
  exitPrice: number;
  entryTimeMs: number;
  exitTimeMs: number;
  entryOrderType?: 'MARKET' | 'LIMIT';
  exitIsLimitFill?: boolean;
  fundingRatePer8h?: number | null;
  /**
   * Hours between funding settlements. The rate is the per-settlement rate
   * (historically named per 8h). Omit to use a cached symbol interval or 8h.
   */
  fundingIntervalHours?: number | null;
  /** Set when the caller already knows the 8h value is a fallback. */
  fundingIntervalFallback?: boolean;
  symbol?: string;
  costConfig?: Partial<TradingCostConfig> | null;
}

export interface TradeCostCalculationResult {
  grossRMultiple: number;
  grossPnlPercent: number;
  feeCostR: number;
  slippageCostR: number;
  fundingCostR: number;
  totalCostR: number;
  netRMultiple: number;
  netPnlPercent: number;
  fundingRateUsed: number;
  fundingIntervalHoursUsed: number;
  fundingIntervalFallback: boolean;
  costConfigUsed: TradingCostConfig;
}

/**
 * Computes realistic perpetual futures trading costs in R-multiples:
 * - Maker / Taker exchange commissions on entry and exit
 * - Bid-Ask / impact slippage on market / stop-loss / timeout legs (0 slippage on limit fills)
 * - Funding accrual prorated by the symbol settlement interval
 *   (LONG pays positive rate, SHORT receives positive rate). 8h is only the fallback.
 */
export function calculateTradeTradingCosts(
  input: TradeCostCalculationInput
): TradeCostCalculationResult {
  const cfg = normalizeTradingCostConfig(input.costConfig);
  const entryOrderType = input.entryOrderType ?? cfg.entryOrderType ?? 'MARKET';
  const entryPrice = Math.max(input.entryPrice, 1e-8);
  const riskDistance = Math.max(
    Math.abs(entryPrice - input.invalidationPrice),
    entryPrice * 0.002
  );
  const riskFraction = Math.max(riskDistance / entryPrice, 0.0005);

  const rawDiff =
    input.direction === 'LONG'
      ? input.exitPrice - entryPrice
      : entryPrice - input.exitPrice;
  const grossRMultiple = Number((rawDiff / riskDistance).toFixed(2));
  const grossPnlPercent = Number(((rawDiff / entryPrice) * 100).toFixed(2));

  const entryFeeFrac =
    (entryOrderType === 'LIMIT' ? cfg.makerFeeBps : cfg.takerFeeBps) / 10_000;
  const exitFeeFrac =
    (input.exitIsLimitFill ? cfg.makerFeeBps : cfg.takerFeeBps) / 10_000;
  const totalFeeFrac = entryFeeFrac + exitFeeFrac;

  const entrySlipFrac =
    entryOrderType === 'LIMIT' ? 0 : cfg.slippageBps / 10_000;
  const exitSlipFrac =
    input.exitIsLimitFill ? 0 : cfg.slippageBps / 10_000;
  const totalSlipFrac = entrySlipFrac + exitSlipFrac;

  const fundingRateUsed =
    typeof input.fundingRatePer8h === 'number' &&
    Number.isFinite(input.fundingRatePer8h)
      ? Math.max(-0.02, Math.min(0.02, input.fundingRatePer8h))
      : cfg.defaultFundingRatePer8h;
  const cachedRaw = input.symbol ? getCachedFundingInterval(input.symbol) : null;
  // Only an exchange fundingInfo hit may change settlement away from 8h.
  // Observed history stays on the backtest call that passed hours explicitly.
  const cachedInterval = cachedRaw && cachedRaw.source === 'exchange' ? cachedRaw : null;
  const explicitHours =
    typeof input.fundingIntervalHours === 'number' &&
    Number.isFinite(input.fundingIntervalHours) &&
    input.fundingIntervalHours > 0;
  const fundingIntervalHoursUsed = explicitHours
    ? sanitizeFundingIntervalHours(input.fundingIntervalHours)
    : cachedInterval
      ? cachedInterval.fundingIntervalHours
      : DEFAULT_FUNDING_INTERVAL_HOURS;
  const fundingIntervalFallback = explicitHours
    ? input.fundingIntervalFallback === true
    : cachedInterval
      ? cachedInterval.fallback
      : true;
  const holdingMs = Math.max(0, input.exitTimeMs - input.entryTimeMs);
  const fundingPeriods = fundingPeriodsForHold(holdingMs, fundingIntervalHoursUsed);
  // LONG pays positive funding; SHORT receives positive funding (negative cost)
  const signedFundingRate =
    input.direction === 'LONG' ? fundingRateUsed : -fundingRateUsed;
  const totalFundingFrac = signedFundingRate * fundingPeriods;

  const feeCostR = Number((totalFeeFrac / riskFraction).toFixed(3));
  const slippageCostR = Number((totalSlipFrac / riskFraction).toFixed(3));
  const fundingCostR = Number((totalFundingFrac / riskFraction).toFixed(3));
  const totalCostR = Number(
    (feeCostR + slippageCostR + fundingCostR).toFixed(3)
  );
  const netRMultiple = Number((grossRMultiple - totalCostR).toFixed(2));
  const totalCostFrac = totalFeeFrac + totalSlipFrac + totalFundingFrac;
  const netPnlPercent = Number(
    (grossPnlPercent - totalCostFrac * 100).toFixed(2)
  );

  return {
    grossRMultiple,
    grossPnlPercent,
    feeCostR,
    slippageCostR,
    fundingCostR,
    totalCostR,
    netRMultiple,
    netPnlPercent,
    fundingRateUsed,
    fundingIntervalHoursUsed,
    fundingIntervalFallback,
    costConfigUsed: { ...cfg, entryOrderType },
  };
}
