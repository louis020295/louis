import { ExchangeAdapter } from '../adapters/ExchangeAdapter.ts';
import { BacktestDatabase } from '../db/BacktestDatabase.ts';
import { BacktestEngine } from '../engine/BacktestEngine.ts';
import { MARKET_SCAN_RULE_VERSION } from '../engine/MarketScanner.ts';
import {
  BacktestResult,
  DataProvenance,
  ExchangeId,
  HistoricalFundingRatePoint,
  HistoricalOpenInterestPoint,
  Kline,
  PaperLedgerEntry,
  Timeframe,
  WalkForwardBacktestResult,
} from '../../src/types/market.ts';

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
    customKlines?: Kline[];
    customHistoricalOpenInterest?: HistoricalOpenInterestPoint[];
    customHistoricalFundingRates?: HistoricalFundingRatePoint[];
    customProvenance?: DataProvenance;
    omitHistoricalOiAndFunding?: boolean;
    ruleVersion?: string;
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
    const barLimit = Math.min(500, Math.max(45, params.barLimit ?? 120));

    const { adapter, exchangeId } = this.resolveAdapter(
      params.mode,
      params.exchange
    );

    let klines: Kline[];
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
      const klinesResult = await adapter.fetchKlines(
        cleanSymbol,
        timeframe,
        barLimit
      );
      klines = klinesResult.klines;

      const earliestBarOpenTime =
        klines.length > 0 ? klines[0].openTime : Date.now() - 30 * 24 * 3600_000;

      if (params.omitHistoricalOiAndFunding) {
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
        const [histOiRes, histFrRes] = await Promise.all([
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
        ]);

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

    if (params.includeWalkForward !== false) {
      const wf = this.engine.runWalkForwardBacktest({
        symbol: cleanSymbol,
        exchange: exchangeId,
        timeframe,
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: combinedProvenance,
        ruleVersion: params.ruleVersion,
      });
      rawResult = wf.combinedReport;
      walkForwardResult = wf.walkForward;
    } else {
      rawResult = this.engine.runDeterministicBacktest({
        symbol: cleanSymbol,
        exchange: exchangeId,
        timeframe,
        klines,
        historicalOpenInterest,
        historicalFundingRates,
        provenance: combinedProvenance,
        ruleVersion: params.ruleVersion,
      });
    }

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
}
