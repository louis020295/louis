import { ExchangeAdapter } from '../adapters/ExchangeAdapter.ts';
import { BacktestDatabase } from '../db/BacktestDatabase.ts';
import {
  BacktestEngine,
  getTimeframeDurationMs,
} from '../engine/BacktestEngine.ts';
import { MARKET_SCAN_RULE_VERSION } from '../engine/MarketScanner.ts';
import {
  getSmcRuleVersionForProfile,
  normalizeSmcRuleProfile,
} from '../engine/SmcRuleEngine.ts';
import { normalizeTradingCostConfig } from '../engine/TradingCostModel.ts';
import {
  clampBacktestBarCount,
  fetchClosedCandleSeries,
} from '../market/ClosedCandleSeries.ts';
import {
  ensureExchangeFundingMap,
  resolveFundingInterval,
} from '../market/FundingInterval.ts';
import {
  BacktestDataClassification,
  BacktestResult,
  BacktestTriggerSource,
  DataProvenance,
  ExchangeId,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  PaperLedgerEntry,
  PortfolioBacktestResult,
  PortfolioBacktestTradeRecord,
  PortfolioBlockedTradeEvent,
  PortfolioRiskConfig,
  PortfolioSymbolBacktestSummary,
  SampleSufficiencyTier,
  SmcAbComparisonResponse,
  SmcAbProfileComparisonRow,
  SmcRuleProfile,
  Timeframe,
  TradingCostConfig,
  TRADING_SAFETY_FLAGS,
  WalkForwardBacktestResult,
} from '../../src/types/market.ts';

async function fetchBacktestCandles(
  adapter: ExchangeAdapter,
  symbol: string,
  timeframe: Timeframe,
  barCount: number
) {
  return fetchClosedCandleSeries({
    symbol,
    timeframe,
    barCount,
    fetchPage: (query) =>
      adapter.fetchKlines(query.symbol, query.timeframe, query.limit, query.window),
    rateLimit: {
      enforce: process.env.NODE_ENV === 'production',
      maxWeightPerWindow: Number(process.env.KLINE_WEIGHT_PER_MINUTE ?? 1200),
      windowMs: 60_000,
    },
  });
}

async function resolveBacktestFundingInterval(
  adapter: ExchangeAdapter,
  symbol: string,
  series: HistoricalFundingRatePoint[]
) {
  if (adapter.fetchFundingIntervals) {
    await ensureExchangeFundingMap(async () => {
      const info = await adapter.fetchFundingIntervals!();
      return info.bySymbol;
    });
  }
  return resolveFundingInterval({
    symbol,
    seriesTimestamps: series.map((point) => point.timestamp),
  });
}

export const DEFAULT_PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  maxOpenPositions: 3,
  maxSameDirectionPositions: 2,
  dailyMaxDrawdownR: 3.0,
  consecutiveLossCooldownLimit: 3,
  cooldownBars: 4,
};

export function normalizePortfolioRiskConfig(
  raw?: Partial<PortfolioRiskConfig>
): PortfolioRiskConfig {
  const clampInt = (val: unknown, fallback: number, min: number, max: number) =>
    typeof val === 'number' && Number.isFinite(val)
      ? Math.min(max, Math.max(min, Math.round(val)))
      : fallback;
  const clampNum = (val: unknown, fallback: number, min: number, max: number) =>
    typeof val === 'number' && Number.isFinite(val)
      ? Math.min(max, Math.max(min, Number(val.toFixed(2))))
      : fallback;

  return {
    maxOpenPositions: clampInt(
      raw?.maxOpenPositions,
      DEFAULT_PORTFOLIO_RISK_CONFIG.maxOpenPositions,
      1,
      20
    ),
    maxSameDirectionPositions: clampInt(
      raw?.maxSameDirectionPositions,
      DEFAULT_PORTFOLIO_RISK_CONFIG.maxSameDirectionPositions,
      1,
      10
    ),
    dailyMaxDrawdownR: clampNum(
      raw?.dailyMaxDrawdownR,
      DEFAULT_PORTFOLIO_RISK_CONFIG.dailyMaxDrawdownR,
      0.5,
      25
    ),
    consecutiveLossCooldownLimit: clampInt(
      raw?.consecutiveLossCooldownLimit,
      DEFAULT_PORTFOLIO_RISK_CONFIG.consecutiveLossCooldownLimit,
      1,
      15
    ),
    cooldownBars: clampInt(
      raw?.cooldownBars,
      DEFAULT_PORTFOLIO_RISK_CONFIG.cooldownBars,
      0,
      96
    ),
  };
}

export class BacktestService {
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly backtestDb: BacktestDatabase;
  private readonly engine: BacktestEngine;

  constructor(params: {
    adapters: Record<ExchangeId, ExchangeAdapter>;
    backtestDb: BacktestDatabase;
    engine?: BacktestEngine;
  }) {
    this.adapters = params.adapters;
    this.backtestDb = params.backtestDb;
    this.engine = params.engine ?? new BacktestEngine();
  }

  public getEngine(): BacktestEngine {
    return this.engine;
  }

  public getDatabase(): BacktestDatabase {
    return this.backtestDb;
  }

  private resolveAdapter(
    modeParam?: string,
    exchangeParam?: string
  ): {
    adapter: ExchangeAdapter;
    resolvedMode: 'live' | 'demo';
    exchangeId: ExchangeId;
  } {
    if (modeParam === 'demo' || exchangeParam === 'demo_synthetic') {
      return {
        adapter: this.adapters.demo_synthetic,
        resolvedMode: 'demo',
        exchangeId: 'demo_synthetic',
      };
    }
    if (exchangeParam && exchangeParam in this.adapters) {
      const exId = exchangeParam as ExchangeId;
      return {
        adapter: this.adapters[exId],
        resolvedMode: 'live',
        exchangeId: exId,
      };
    }
    return {
      adapter: this.adapters.binance_usdm,
      resolvedMode: 'live',
      exchangeId: 'binance_usdm',
    };
  }

  public async executeBacktest(params: {
    symbol: string;
    timeframe?: Timeframe;
    mode?: string;
    exchange?: string;
    barLimit?: number;
    includeWalkForward?: boolean;
    writeToPaperLedger?: boolean;
    costConfig?: Partial<TradingCostConfig>;
    customKlines?: Kline[];
    customHigherTimeframeKlines?: { '1h'?: Kline[]; '4h'?: Kline[] };
    customHistoricalOpenInterest?: HistoricalOpenInterestPoint[];
    customHistoricalFundingRates?: HistoricalFundingRatePoint[];
    customProvenance?: DataProvenance;
    omitHistoricalOiAndFunding?: boolean;
    ruleVersion?: string;
    smcRuleProfile?: SmcRuleProfile;
    triggerSource?: BacktestTriggerSource;
    autoBatchId?: string | null;
  }): Promise<{
    report: BacktestResult;
    walkForward?: WalkForwardBacktestResult;
    paperEntriesCreated: PaperLedgerEntry[];
  }> {
    const cleanSymbol = (params.symbol || 'BTCUSDT').trim().toUpperCase();
    const validTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const timeframe: Timeframe =
      params.timeframe && validTimeframes.includes(params.timeframe)
        ? params.timeframe
        : '15m';
    const barLimit = clampBacktestBarCount(params.barLimit, 120, 45);
    const resolvedCostConfig = normalizeTradingCostConfig(params.costConfig);
    const resolvedRuleProfile = normalizeSmcRuleProfile(params.smcRuleProfile);

    const { adapter, exchangeId } = this.resolveAdapter(
      params.mode,
      params.exchange
    );

    let klines: Kline[];
    let higherTimeframeKlines: { '1h'?: Kline[]; '4h'?: Kline[] } | undefined =
      params.customHigherTimeframeKlines;
    let historicalOpenInterest: HistoricalOpenInterestPoint[] = [];
    let historicalFundingRates: HistoricalFundingRatePoint[] = [];
    let combinedProvenance: DataProvenance;

    if (params.customKlines && params.customProvenance) {
      klines = params.customKlines;
      combinedProvenance = params.customProvenance;
      if (!params.omitHistoricalOiAndFunding) {
        historicalOpenInterest = params.customHistoricalOpenInterest ?? [];
        historicalFundingRates = params.customHistoricalFundingRates ?? [];
      }
    } else {
      const klinesResult = await fetchBacktestCandles(
        adapter,
        cleanSymbol,
        timeframe,
        barLimit
      );
      klines = klinesResult.klines;

      const earliestBarOpenTime =
        klines.length > 0 ? klines[0].openTime : Date.now() - 30 * 24 * 3600_000;

      const shouldFetchMtf =
        !higherTimeframeKlines && (timeframe === '5m' || timeframe === '15m');
      const mtf1hLimit = clampBacktestBarCount(
        Math.max(120, Math.ceil(barLimit / (timeframe === '5m' ? 12 : 4)) + 80),
        120,
        80
      );
      const mtf4hLimit = clampBacktestBarCount(
        Math.max(80, Math.ceil(barLimit / (timeframe === '5m' ? 48 : 16)) + 60),
        80,
        40
      );

      const mtfPromise = shouldFetchMtf
        ? Promise.all([
            fetchBacktestCandles(adapter, cleanSymbol, '1h', mtf1hLimit)
              .then((r) => r.klines)
              .catch(() => [] as Kline[]),
            fetchBacktestCandles(adapter, cleanSymbol, '4h', mtf4hLimit)
              .then((r) => r.klines)
              .catch(() => [] as Kline[]),
          ])
        : Promise.resolve([[] as Kline[], [] as Kline[]]);

      if (params.omitHistoricalOiAndFunding) {
        const [k1h, k4h] = await mtfPromise;
        if (k1h.length > 0 || k4h.length > 0) {
          higherTimeframeKlines = {
            ...(k1h.length > 0 ? { '1h': k1h } : {}),
            ...(k4h.length > 0 ? { '4h': k4h } : {}),
          };
        }
        historicalOpenInterest = [];
        historicalFundingRates = [];
        combinedProvenance = {
          source: klinesResult.provenance.source,
          fetchedAt: klinesResult.provenance.fetchedAt,
          stale: klinesResult.provenance.stale,
          fallback: klinesResult.provenance.fallback,
          missingData: [
            ...new Set([
              ...klinesResult.provenance.missingData,
              'historicalOpenInterest',
              'historicalFundingRate',
            ]),
          ],
          isDemo: adapter.isDemo,
          volumeTimeframe: '15m',
          aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
          volumeMetric: 'quoteVolume',
        };
      } else {
        const [histOiRes, histFrRes, [k1h, k4h]] = await Promise.all([
          adapter.fetchHistoricalOpenInterest
            ? adapter.fetchHistoricalOpenInterest(
                cleanSymbol,
                timeframe,
                Math.max(barLimit + 30, 200)
              )
            : Promise.resolve({
                series: [] as HistoricalOpenInterestPoint[],
                provenance: {
                  source: adapter.displayName,
                  fetchedAt: new Date().toISOString(),
                  stale: false,
                  fallback: false,
                  missingData: ['historicalOpenInterest'],
                  isDemo: adapter.isDemo,
                },
              }),
          adapter.fetchHistoricalFundingRates
            ? adapter.fetchHistoricalFundingRates(
                cleanSymbol,
                500,
                earliestBarOpenTime - 24 * 3600_000
              )
            : Promise.resolve({
                series: [] as HistoricalFundingRatePoint[],
                provenance: {
                  source: adapter.displayName,
                  fetchedAt: new Date().toISOString(),
                  stale: false,
                  fallback: false,
                  missingData: ['historicalFundingRate'],
                  isDemo: adapter.isDemo,
                },
              }),
          mtfPromise,
        ]);

        if (k1h.length > 0 || k4h.length > 0) {
          higherTimeframeKlines = {
            ...(k1h.length > 0 ? { '1h': k1h } : {}),
            ...(k4h.length > 0 ? { '4h': k4h } : {}),
          };
        }

        historicalOpenInterest = histOiRes.series;
        historicalFundingRates = histFrRes.series;

        combinedProvenance = {
          source: klinesResult.provenance.source,
          fetchedAt: klinesResult.provenance.fetchedAt,
          stale:
            klinesResult.provenance.stale ||
            histOiRes.provenance.stale ||
            histFrRes.provenance.stale,
          fallback:
            klinesResult.provenance.fallback ||
            histOiRes.provenance.fallback ||
            histFrRes.provenance.fallback,
          missingData: [
            ...new Set([
              ...klinesResult.provenance.missingData,
              ...histOiRes.provenance.missingData,
              ...histFrRes.provenance.missingData,
            ]),
          ],
          isDemo: adapter.isDemo,
          volumeTimeframe: '15m',
          aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
          volumeMetric: 'quoteVolume',
        };
      }
    }

    let rawResult: BacktestResult;
    let walkForwardResult: WalkForwardBacktestResult | undefined;

    const fundingInterval = await resolveBacktestFundingInterval(
      adapter,
      cleanSymbol,
      historicalFundingRates
    );

    if (params.includeWalkForward !== false) {
      const wf = this.engine.runWalkForwardBacktest({
        symbol: cleanSymbol,
        exchange: exchangeId,
        timeframe,
        klines,
        higherTimeframeKlines,
        costConfig: resolvedCostConfig,
        historicalOpenInterest,
        historicalFundingRates,
        fundingIntervalHours: fundingInterval.fundingIntervalHours,
        fundingIntervalFallback: fundingInterval.fallback,
        provenance: combinedProvenance,
        ruleVersion: params.ruleVersion,
        smcRuleProfile: resolvedRuleProfile,
      });
      rawResult = wf.combinedReport;
      walkForwardResult = wf.walkForward;
    } else {
      rawResult = this.engine.runDeterministicBacktest({
        symbol: cleanSymbol,
        exchange: exchangeId,
        timeframe,
        klines,
        higherTimeframeKlines,
        costConfig: resolvedCostConfig,
        historicalOpenInterest,
        historicalFundingRates,
        fundingIntervalHours: fundingInterval.fundingIntervalHours,
        fundingIntervalFallback: fundingInterval.fallback,
        provenance: combinedProvenance,
        ruleVersion: params.ruleVersion,
        smcRuleProfile: resolvedRuleProfile,
      });
    }

    rawResult.triggerSource =
      params.triggerSource === 'AUTO_SCHEDULED' ? 'AUTO_SCHEDULED' : 'MANUAL';
    rawResult.autoBatchId = params.autoBatchId ?? null;

    const savedReport = this.backtestDb.saveBacktestRun(
      rawResult,
      exchangeId,
      MARKET_SCAN_RULE_VERSION
    );

    const paperEntriesCreated = params.writeToPaperLedger
      ? this.backtestDb.recordBacktestTradesToPaperLedger(savedReport)
      : [];

    return {
      report: savedReport,
      walkForward: walkForwardResult,
      paperEntriesCreated,
    };
  }

  public async runPortfolioBenchmarkBacktest(params: {
    symbols: string[];
    timeframe?: Timeframe;
    mode?: string;
    exchange?: string;
    barLimit?: number;
    smcRuleProfile?: SmcRuleProfile;
    costConfig?: Partial<TradingCostConfig>;
    riskConfig?: Partial<PortfolioRiskConfig>;
    customDatasetsBySymbol?: Record<
      string,
      {
        klines: Kline[];
        higherTimeframeKlines?: { '1h'?: Kline[]; '4h'?: Kline[] };
        historicalOpenInterest?: HistoricalOpenInterestPoint[];
        historicalFundingRates?: HistoricalFundingRatePoint[];
        provenance?: DataProvenance;
      }
    >;
  }): Promise<PortfolioBacktestResult> {
    const validTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const timeframe: Timeframe =
      params.timeframe && validTimeframes.includes(params.timeframe)
        ? params.timeframe
        : '15m';
    const barLimit = clampBacktestBarCount(params.barLimit, 240, 45);
    const resolvedRuleProfile = normalizeSmcRuleProfile(params.smcRuleProfile);
    const costConfig = normalizeTradingCostConfig(params.costConfig);
    const riskConfig = normalizePortfolioRiskConfig(params.riskConfig);
    const { resolvedMode, exchangeId } = this.resolveAdapter(
      params.mode,
      params.exchange
    );
    const isDemo = resolvedMode === 'demo' || exchangeId === 'demo_synthetic';

    const cleanSymbols = [
      ...new Set(
        (params.symbols.length > 0
          ? params.symbols
          : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
        )
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      ),
    ].slice(0, 15);

    const perSymbolReports = new Map<string, BacktestResult>();
    const symbolErrors = new Map<string, string>();

    for (const sym of cleanSymbols) {
      try {
        const custom = params.customDatasetsBySymbol?.[sym];
        const { report } = await this.executeBacktest({
          symbol: sym,
          timeframe,
          mode: resolvedMode,
          exchange: exchangeId,
          barLimit,
          includeWalkForward: true,
          writeToPaperLedger: false,
          smcRuleProfile: resolvedRuleProfile,
          costConfig,
          customKlines: custom?.klines,
          customHigherTimeframeKlines: custom?.higherTimeframeKlines,
          customHistoricalOpenInterest: custom?.historicalOpenInterest,
          customHistoricalFundingRates: custom?.historicalFundingRates,
          customProvenance: custom?.provenance,
        });
        perSymbolReports.set(sym, report);
      } catch (err) {
        symbolErrors.set(
          sym,
          err instanceof Error ? err.message : 'Backtest execution failed'
        );
      }
    }

    const candidateTrades: PortfolioBacktestTradeRecord[] = [];
    for (const sym of cleanSymbols) {
      const report = perSymbolReports.get(sym);
      if (!report || report.status !== 'COMPLETED') continue;
      for (const t of report.trades) {
        candidateTrades.push({
          ...t,
          symbol: sym,
        });
      }
    }

    // Strict chronological sorting for causal multi-symbol portfolio risk simulation
    candidateTrades.sort((a, b) => {
      if (a.entryBarTime !== b.entryBarTime) {
        return a.entryBarTime - b.entryBarTime;
      }
      if (a.exitBarTime !== b.exitBarTime) {
        return a.exitBarTime - b.exitBarTime;
      }
      return a.symbol.localeCompare(b.symbol);
    });

    const tfMs = getTimeframeDurationMs(timeframe);
    let activePositions: PortfolioBacktestTradeRecord[] = [];
    const acceptedTrades: PortfolioBacktestTradeRecord[] = [];
    const blockedEvents: PortfolioBlockedTradeEvent[] = [];
    const dailyRealizedNetR = new Map<string, number>();
    let consecutiveLosses = 0;
    let cooldownUntilMs = -Infinity;

    const settlePositionsUpTo = (tsMs: number) => {
      const closing = activePositions
        .filter((p) => p.exitBarTime <= tsMs)
        .sort((a, b) => a.exitBarTime - b.exitBarTime);
      if (closing.length === 0) return;

      for (const closed of closing) {
        const dayKey = new Date(closed.exitBarTime).toISOString().slice(0, 10);
        const netR = closed.netRMultiple ?? closed.rMultiple;
        dailyRealizedNetR.set(
          dayKey,
          Number(((dailyRealizedNetR.get(dayKey) ?? 0) + netR).toFixed(4))
        );
        if (netR < 0) {
          consecutiveLosses += 1;
          if (
            riskConfig.cooldownBars > 0 &&
            consecutiveLosses >= riskConfig.consecutiveLossCooldownLimit
          ) {
            cooldownUntilMs = Math.max(
              cooldownUntilMs,
              closed.exitBarTime + riskConfig.cooldownBars * tfMs
            );
          }
        } else {
          consecutiveLosses = 0;
        }
      }
      activePositions = activePositions.filter((p) => p.exitBarTime > tsMs);
    };

    const blockedBySymbol = new Map<string, number>();
    const acceptedBySymbol = new Map<string, PortfolioBacktestTradeRecord[]>();
    const blockedBreakdown = {
      maxOpenPositions: 0,
      sameDirectionCap: 0,
      dailyDrawdownCircuitBreaker: 0,
      consecutiveLossCooldown: 0,
    };

    for (const trade of candidateTrades) {
      settlePositionsUpTo(trade.entryBarTime);
      const entryDayKey = new Date(trade.entryBarTime).toISOString().slice(0, 10);
      const dayNetR = dailyRealizedNetR.get(entryDayKey) ?? 0;
      const sameDirCount = activePositions.filter(
        (p) => p.direction === trade.direction
      ).length;

      let blockReason: PortfolioBlockedTradeEvent['reasonCode'] | null = null;
      let reasonZh = '';

      if (trade.entryBarTime < cooldownUntilMs) {
        blockReason = 'CONSECUTIVE_LOSS_COOLDOWN';
        reasonZh = `連敗達 ${riskConfig.consecutiveLossCooldownLimit} 次觸發冷卻期 (${riskConfig.cooldownBars} 根 K 線)`;
        blockedBreakdown.consecutiveLossCooldown += 1;
      } else if (dayNetR <= -riskConfig.dailyMaxDrawdownR) {
        blockReason = 'DAILY_DRAWDOWN_CIRCUIT_BREAKER';
        reasonZh = `當日累積淨回撤 ${dayNetR.toFixed(2)}R 已觸及單日風控熔斷上限 (-${riskConfig.dailyMaxDrawdownR}R)`;
        blockedBreakdown.dailyDrawdownCircuitBreaker += 1;
      } else if (activePositions.length >= riskConfig.maxOpenPositions) {
        blockReason = 'MAX_OPEN_POSITIONS';
        reasonZh = `同時持倉數已達上限 (${activePositions.length}/${riskConfig.maxOpenPositions})`;
        blockedBreakdown.maxOpenPositions += 1;
      } else if (sameDirCount >= riskConfig.maxSameDirectionPositions) {
        blockReason = 'SAME_DIRECTION_CAP';
        reasonZh = `同方向 (${trade.direction}) 曝險部位數已達上限 (${sameDirCount}/${riskConfig.maxSameDirectionPositions})`;
        blockedBreakdown.sameDirectionCap += 1;
      }

      if (blockReason) {
        blockedEvents.push({
          symbol: trade.symbol,
          direction: trade.direction,
          entryBarTime: trade.entryBarTime,
          reasonCode: blockReason,
          reasonZh,
          projectedNetR: trade.netRMultiple ?? trade.rMultiple,
        });
        blockedBySymbol.set(
          trade.symbol,
          (blockedBySymbol.get(trade.symbol) ?? 0) + 1
        );
        continue;
      }

      activePositions.push(trade);
      acceptedTrades.push(trade);
      const arr = acceptedBySymbol.get(trade.symbol) ?? [];
      arr.push(trade);
      acceptedBySymbol.set(trade.symbol, arr);
    }

    settlePositionsUpTo(Number.POSITIVE_INFINITY);

    const calcSubsetMetrics = (trades: PortfolioBacktestTradeRecord[]) => {
      if (trades.length === 0) {
        return {
          winRate: null,
          averageR: null,
          expectancyR: null,
          profitFactor: null,
          maxDrawdownR: null,
          netWinRate: null,
          netAverageR: null,
          netExpectancyR: null,
          netProfitFactor: null,
          netMaxDrawdownR: null,
          totalGrossR: null,
          totalNetR: null,
          totalCostDragR: null,
          avgCostDragPerTradeR: null,
        };
      }
      const n = trades.length;
      const grossRs = trades.map((t) => t.grossRMultiple ?? t.rMultiple);
      const netRs = trades.map((t) => t.netRMultiple ?? t.rMultiple);
      const costs = trades.map((t) => t.totalCostR ?? 0);

      const totalGross = grossRs.reduce((a, b) => a + b, 0);
      const totalNet = netRs.reduce((a, b) => a + b, 0);
      const totalCost = costs.reduce((a, b) => a + b, 0);

      const grossWins = grossRs.filter((r) => r > 0);
      const grossLosses = grossRs.filter((r) => r <= 0);
      const netWins = netRs.filter((r) => r > 0);
      const netLosses = netRs.filter((r) => r <= 0);

      const grossSumW = grossWins.reduce((a, b) => a + b, 0);
      const grossSumL = Math.abs(grossLosses.reduce((a, b) => a + b, 0));
      const netSumW = netWins.reduce((a, b) => a + b, 0);
      const netSumL = Math.abs(netLosses.reduce((a, b) => a + b, 0));

      const computeMdd = (series: number[]) => {
        let eq = 0;
        let peak = 0;
        let mdd = 0;
        for (const r of series) {
          eq += r;
          if (eq > peak) peak = eq;
          const dd = peak - eq;
          if (dd > mdd) mdd = dd;
        }
        return Number(mdd.toFixed(2));
      };

      const sortedByExit = [...trades].sort(
        (a, b) => a.exitBarTime - b.exitBarTime
      );

      return {
        winRate: Number(((grossWins.length / n) * 100).toFixed(1)),
        averageR: Number((totalGross / n).toFixed(2)),
        expectancyR: Number((totalGross / n).toFixed(2)),
        profitFactor:
          grossSumL > 0
            ? Number((grossSumW / grossSumL).toFixed(2))
            : grossSumW > 0
              ? 99.9
              : 0,
        maxDrawdownR: computeMdd(
          sortedByExit.map((t) => t.grossRMultiple ?? t.rMultiple)
        ),
        netWinRate: Number(((netWins.length / n) * 100).toFixed(1)),
        netAverageR: Number((totalNet / n).toFixed(2)),
        netExpectancyR: Number((totalNet / n).toFixed(2)),
        netProfitFactor:
          netSumL > 0
            ? Number((netSumW / netSumL).toFixed(2))
            : netSumW > 0
              ? 99.9
              : 0,
        netMaxDrawdownR: computeMdd(
          sortedByExit.map((t) => t.netRMultiple ?? t.rMultiple)
        ),
        totalGrossR: Number(totalGross.toFixed(2)),
        totalNetR: Number(totalNet.toFixed(2)),
        totalCostDragR: Number(totalCost.toFixed(2)),
        avgCostDragPerTradeR: Number((totalCost / n).toFixed(4)),
      };
    };

    const symbolSummaries: PortfolioSymbolBacktestSummary[] = cleanSymbols.map(
      (sym) => {
        const rep = perSymbolReports.get(sym);
        const errMsg = symbolErrors.get(sym);
        if (!rep) {
          return {
            symbol: sym,
            status: 'FAILED',
            metricStatus: 'INSUFFICIENT_DATA',
            confirmedBarsTested: 0,
            mtfHistoricalAligned: false,
            rawTradesCount: 0,
            acceptedTradesCount: 0,
            blockedTradesCount: 0,
            winRate: null,
            netWinRate: null,
            averageR: null,
            netAverageR: null,
            profitFactor: null,
            netProfitFactor: null,
            maxDrawdownR: null,
            netMaxDrawdownR: null,
            errorMessage: errMsg ?? 'Execution failed',
          };
        }
        const symAccepted = acceptedBySymbol.get(sym) ?? [];
        const symMetrics = calcSubsetMetrics(symAccepted);
        return {
          symbol: sym,
          status:
            rep.status === 'COMPLETED' ? 'COMPLETED' : 'INSUFFICIENT_DATA',
          metricStatus: rep.metricStatus,
          confirmedBarsTested: rep.confirmedBarsTested,
          mtfHistoricalAligned: Boolean(rep.mtfHistoricalAligned),
          rawTradesCount: rep.trades.length,
          acceptedTradesCount: symAccepted.length,
          blockedTradesCount: blockedBySymbol.get(sym) ?? 0,
          winRate: symMetrics.winRate,
          netWinRate: symMetrics.netWinRate,
          averageR: symMetrics.averageR,
          netAverageR: symMetrics.netAverageR,
          profitFactor: symMetrics.profitFactor,
          netProfitFactor: symMetrics.netProfitFactor,
          maxDrawdownR: symMetrics.maxDrawdownR,
          netMaxDrawdownR: symMetrics.netMaxDrawdownR,
        };
      }
    );

    const portfolioMetrics = calcSubsetMetrics(acceptedTrades);
    const totalAccepted = acceptedTrades.length;
    const sampleSufficiency: SampleSufficiencyTier =
      totalAccepted < 10
        ? 'INSUFFICIENT'
        : totalAccepted < 30
          ? 'LIMITED'
          : 'SUFFICIENT';

    const reportsArr = Array.from(perSymbolReports.values());
    const dataClassification: BacktestDataClassification = isDemo
      ? 'DEMO'
      : reportsArr.some((r) => r.dataClassification === 'REAL')
        ? 'REAL'
        : reportsArr[0]?.dataClassification ?? 'INSUFFICIENT_DATA';

    return {
      safety: TRADING_SAFETY_FLAGS,
      portfolioRunId: `pf_${exchangeId}_${timeframe}_${Date.now()}`,
      exchange: exchangeId,
      timeframe,
      barLimit,
      smcRuleProfile: resolvedRuleProfile,
      isDemo,
      dataClassification,
      lookaheadFree:
        reportsArr.length > 0 && reportsArr.every((r) => r.lookaheadFree),
      mtfHistoricalAlignedCount: reportsArr.filter(
        (r) => r.mtfHistoricalAligned
      ).length,
      costConfig,
      riskConfig,
      symbolsRequested: cleanSymbols,
      symbolsSucceeded: reportsArr.filter((r) => r.status === 'COMPLETED')
        .length,
      symbolsWithTrades: symbolSummaries.filter(
        (s) => s.acceptedTradesCount > 0
      ).length,
      rawTotalTrades: candidateTrades.length,
      acceptedTradesCount: totalAccepted,
      blockedByRiskCapCount: blockedEvents.length,
      blockedBreakdown,
      sampleSufficiency,
      longCount: acceptedTrades.filter((t) => t.direction === 'LONG').length,
      shortCount: acceptedTrades.filter((t) => t.direction === 'SHORT').length,
      winRate: portfolioMetrics.winRate,
      averageR: portfolioMetrics.averageR,
      expectancyR: portfolioMetrics.expectancyR,
      profitFactor: portfolioMetrics.profitFactor,
      maxDrawdownR: portfolioMetrics.maxDrawdownR,
      netWinRate: portfolioMetrics.netWinRate,
      netAverageR: portfolioMetrics.netAverageR,
      netExpectancyR: portfolioMetrics.netExpectancyR,
      netProfitFactor: portfolioMetrics.netProfitFactor,
      netMaxDrawdownR: portfolioMetrics.netMaxDrawdownR,
      totalGrossR: portfolioMetrics.totalGrossR,
      totalNetR: portfolioMetrics.totalNetR,
      totalCostDragR: portfolioMetrics.totalCostDragR,
      avgCostDragPerTradeR: portfolioMetrics.avgCostDragPerTradeR,
      symbolSummaries,
      portfolioTrades: acceptedTrades,
      blockedEvents,
      createdAt: new Date().toISOString(),
    };
  }

  public async runSmcAbComparison(params: {
    symbols: string[];
    timeframe?: Timeframe;
    mode?: string;
    exchange?: string;
    barLimit?: number;
    costConfig?: Partial<TradingCostConfig>;
    riskConfig?: Partial<PortfolioRiskConfig>;
    customDatasetsBySymbol?: Record<
      string,
      {
        klines: Kline[];
        higherTimeframeKlines?: { '1h'?: Kline[]; '4h'?: Kline[] };
        historicalOpenInterest?: HistoricalOpenInterestPoint[];
        historicalFundingRates?: HistoricalFundingRatePoint[];
        provenance?: DataProvenance;
      }
    >;
  }): Promise<SmcAbComparisonResponse> {
    const validTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const timeframe: Timeframe =
      params.timeframe && validTimeframes.includes(params.timeframe)
        ? params.timeframe
        : '15m';
    const barLimit = clampBacktestBarCount(params.barLimit, 480, 45);
    const costConfig = normalizeTradingCostConfig(params.costConfig);
    const riskConfig = normalizePortfolioRiskConfig(params.riskConfig);
    const { adapter, resolvedMode, exchangeId } = this.resolveAdapter(
      params.mode,
      params.exchange
    );
    const isDemo = resolvedMode === 'demo' || exchangeId === 'demo_synthetic';

    const cleanSymbols = [
      ...new Set(
        (params.symbols.length > 0
          ? params.symbols
          : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT']
        )
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      ),
    ].slice(0, 15);

    const sharedDatasets: Record<
      string,
      {
        klines: Kline[];
        higherTimeframeKlines?: { '1h'?: Kline[]; '4h'?: Kline[] };
        historicalOpenInterest?: HistoricalOpenInterestPoint[];
        historicalFundingRates?: HistoricalFundingRatePoint[];
        provenance?: DataProvenance;
      }
    > = {};

    if (params.customDatasetsBySymbol) {
      for (const sym of cleanSymbols) {
        if (params.customDatasetsBySymbol[sym]) {
          sharedDatasets[sym] = params.customDatasetsBySymbol[sym];
        }
      }
    } else {
      const mtf1hLimit = clampBacktestBarCount(
        Math.max(120, Math.ceil(barLimit / (timeframe === '5m' ? 12 : 4)) + 80),
        120,
        80
      );
      const mtf4hLimit = clampBacktestBarCount(
        Math.max(80, Math.ceil(barLimit / (timeframe === '5m' ? 48 : 16)) + 60),
        80,
        40
      );

      for (const sym of cleanSymbols) {
        try {
          const klinesResult = await fetchBacktestCandles(
            adapter,
            sym,
            timeframe,
            barLimit
          );
          const klines = klinesResult.klines;
          const earliestBarOpenTime =
            klines.length > 0
              ? klines[0].openTime
              : Date.now() - 30 * 24 * 3600_000;
          const shouldFetchMtf = timeframe === '5m' || timeframe === '15m';

          const [histOiRes, histFrRes, k1h, k4h] = await Promise.all([
            adapter.fetchHistoricalOpenInterest
              ? adapter.fetchHistoricalOpenInterest(
                  sym,
                  timeframe,
                  Math.max(barLimit + 30, 200)
                )
              : Promise.resolve({
                  series: [] as HistoricalOpenInterestPoint[],
                  provenance: klinesResult.provenance,
                }),
            adapter.fetchHistoricalFundingRates
              ? adapter.fetchHistoricalFundingRates(
                  sym,
                  500,
                  earliestBarOpenTime - 24 * 3600_000
                )
              : Promise.resolve({
                  series: [] as HistoricalFundingRatePoint[],
                  provenance: klinesResult.provenance,
                }),
            shouldFetchMtf
              ? fetchBacktestCandles(adapter, sym, '1h', mtf1hLimit)
                  .then((r) => r.klines)
                  .catch(() => [] as Kline[])
              : Promise.resolve([] as Kline[]),
            shouldFetchMtf
              ? fetchBacktestCandles(adapter, sym, '4h', mtf4hLimit)
                  .then((r) => r.klines)
                  .catch(() => [] as Kline[])
              : Promise.resolve([] as Kline[]),
          ]);

          sharedDatasets[sym] = {
            klines,
            higherTimeframeKlines:
              k1h.length > 0 || k4h.length > 0
                ? {
                    ...(k1h.length > 0 ? { '1h': k1h } : {}),
                    ...(k4h.length > 0 ? { '4h': k4h } : {}),
                  }
                : undefined,
            historicalOpenInterest: histOiRes.series,
            historicalFundingRates: histFrRes.series,
            provenance: {
              source: klinesResult.provenance.source,
              fetchedAt: klinesResult.provenance.fetchedAt,
              stale:
                klinesResult.provenance.stale ||
                histOiRes.provenance.stale ||
                histFrRes.provenance.stale,
              fallback:
                klinesResult.provenance.fallback ||
                histOiRes.provenance.fallback ||
                histFrRes.provenance.fallback,
              missingData: [
                ...new Set([
                  ...klinesResult.provenance.missingData,
                  ...histOiRes.provenance.missingData,
                  ...histFrRes.provenance.missingData,
                ]),
              ],
              isDemo: adapter.isDemo,
              volumeTimeframe: '15m',
              aggregationWindow: '15m_CONFIRMED_KLINE_30_BARS',
              volumeMetric: 'quoteVolume',
            },
          };
        } catch {
          // Leave missing; runPortfolioBenchmarkBacktest handles per-symbol errors cleanly
        }
      }
    }

    const profilesMeta: Array<{
      profile: SmcRuleProfile;
      labelZh: string;
    }> = [
      {
        profile: 'STRICT_PRODUCTION',
        labelZh: 'A. 原版嚴格正式規則 (5 Gate 全過 + 單K≥1.3x ATR + 嚴格MTF)',
      },
      {
        profile: 'RELAXED_MTF_DISP',
        labelZh: 'B. 優化放寬版 (雙K位移/1.1x ATR + 核心週期MTF共識 + 保留Sweep)',
      },
      {
        profile: 'TREND_NO_SWEEP',
        labelZh: 'C. 趨勢延續版 (放寬MTF/位移 + 免除強制Liquidity Sweep)',
      },
    ];

    const rows: SmcAbProfileComparisonRow[] = [];
    for (const meta of profilesMeta) {
      const pfRes = await this.runPortfolioBenchmarkBacktest({
        symbols: cleanSymbols,
        timeframe,
        mode: resolvedMode,
        exchange: exchangeId,
        barLimit,
        smcRuleProfile: meta.profile,
        costConfig,
        riskConfig,
        customDatasetsBySymbol: sharedDatasets,
      });

      rows.push({
        profile: meta.profile,
        profileLabelZh: meta.labelZh,
        ruleVersion: `${getSmcRuleVersionForProfile(meta.profile)}+${MARKET_SCAN_RULE_VERSION}`,
        rawTotalTrades: pfRes.rawTotalTrades,
        acceptedTradesCount: pfRes.acceptedTradesCount,
        blockedByRiskCapCount: pfRes.blockedByRiskCapCount,
        longCount: pfRes.longCount,
        shortCount: pfRes.shortCount,
        sampleSufficiency: pfRes.sampleSufficiency,
        winRate: pfRes.winRate,
        netWinRate: pfRes.netWinRate,
        averageR: pfRes.averageR,
        netAverageR: pfRes.netAverageR,
        expectancyR: pfRes.expectancyR,
        netExpectancyR: pfRes.netExpectancyR,
        profitFactor: pfRes.profitFactor,
        netProfitFactor: pfRes.netProfitFactor,
        maxDrawdownR: pfRes.maxDrawdownR,
        netMaxDrawdownR: pfRes.netMaxDrawdownR,
        totalGrossR: pfRes.totalGrossR,
        totalNetR: pfRes.totalNetR,
        totalCostDragR: pfRes.totalCostDragR,
        avgCostDragPerTradeR: pfRes.avgCostDragPerTradeR,
        portfolioResult: pfRes,
      });
    }

    const eligiblePositive = rows
      .filter(
        (r) =>
          r.acceptedTradesCount >= 5 &&
          (r.netExpectancyR ?? -999) > 0 &&
          (r.netProfitFactor ?? 0) >= 1.05
      )
      .sort((a, b) => {
        const netTotalDiff = (b.totalNetR ?? -999) - (a.totalNetR ?? -999);
        if (Math.abs(netTotalDiff) > 0.25) return netTotalDiff;
        return (b.netExpectancyR ?? -999) - (a.netExpectancyR ?? -999);
      });

    let recommendedProfile: SmcRuleProfile | null = null;
    let recommendationReasonZh =
      '目前測試視窗內各規則組皆未同時達成「樣本 >= 5 筆且淨期望值 > 0R / 淨 PF >= 1.05」，建議維持原版觀察並擴大回測標的或樣本期間。';

    if (eligiblePositive.length > 0) {
      const winner = eligiblePositive[0];
      recommendedProfile = winner.profile;
      recommendationReasonZh = `${winner.profile} 在相同無前視歷史資料與扣成本條件下表現較佳：接受交易 ${winner.acceptedTradesCount} 筆、淨勝率 ${winner.netWinRate ?? '--'}%、淨期望值 ${winner.netExpectancyR ?? '--'}R、淨 PF ${winner.netProfitFactor ?? '--'}、累計淨 R ${winner.totalNetR ?? '--'}R（淨 MDD ${winner.netMaxDrawdownR ?? '--'}R）。`;
    }

    const basePf = rows[0]?.portfolioResult;
    return {
      safety: TRADING_SAFETY_FLAGS,
      comparisonId: `ab_${exchangeId}_${timeframe}_${Date.now()}`,
      exchange: exchangeId,
      timeframe,
      barLimit,
      isDemo,
      dataClassification: basePf?.dataClassification ?? 'INSUFFICIENT_DATA',
      lookaheadFree: rows.length > 0 && rows.every((r) => r.portfolioResult.lookaheadFree),
      symbolsRequested: cleanSymbols,
      symbolsSucceeded: basePf?.symbolsSucceeded ?? 0,
      costConfig,
      riskConfig,
      profiles: rows,
      recommendedProfile,
      recommendationReasonZh,
      createdAt: new Date().toISOString(),
    };
  }
}


