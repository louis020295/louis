import { DatabaseSync } from 'node:sqlite';
import {
  BacktestPointInTimeSignalEvidence,
  BacktestResult,
  ExchangeId,
  PaperLedgerEntry,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';
import { MARKET_SCAN_RULE_VERSION } from '../engine/MarketScanner.ts';
import {
  enforceProvenanceIntegrity,
  isTestFixtureSourceName,
} from '../utils/provenanceQuarantine.ts';
import { RadarDatabase } from './RadarDatabase.ts';

export class BacktestDatabase {
  private readonly radarDb: RadarDatabase;
  private readonly rawDb: DatabaseSync;

  constructor(radarDb: RadarDatabase) {
    this.radarDb = radarDb;
    this.rawDb = radarDb.getRawDb();
    this.initBacktestSchema();
  }

  private initBacktestSchema(): void {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        backtest_run_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        data_source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        lookahead_free INTEGER NOT NULL DEFAULT 1,
        data_classification TEXT NOT NULL,
        status TEXT NOT NULL,
        metric_status TEXT NOT NULL DEFAULT 'NO_TRADES',
        insufficient_reason TEXT,
        signal_count INTEGER NOT NULL DEFAULT 0,
        executed_paper_count INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        expired_count INTEGER NOT NULL DEFAULT 0,
        insufficient_data_count INTEGER NOT NULL DEFAULT 0,
        trade_count INTEGER,
        win_rate REAL,
        average_r REAL,
        profit_factor REAL,
        max_drawdown_r REAL,
        expectancy_r REAL,
        average_holding_time TEXT,
        long_count INTEGER,
        short_count INTEGER,
        walk_forward_json TEXT,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backtest_signal_evidences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backtest_run_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        bar_index INTEGER NOT NULL,
        bar_open_time INTEGER NOT NULL,
        bar_close_time INTEGER NOT NULL,
        confirmed_bars_count INTEGER NOT NULL,
        volume_baseline_bars INTEGER NOT NULL,
        smc_evidence_json TEXT NOT NULL,
        oi REAL,
        funding REAL,
        oi_value REAL,
        oi_fetched_at TEXT,
        oi_data_timestamp INTEGER,
        funding_rate REAL,
        funding_data_timestamp INTEGER,
        oi_funding_point_in_time INTEGER NOT NULL DEFAULT 0,
        decision_at TEXT NOT NULL,
        smc_evaluation_status TEXT NOT NULL,
        smc_action_state TEXT NOT NULL,
        final_trade_signal TEXT NOT NULL,
        counted_as_trade_signal INTEGER NOT NULL DEFAULT 0,
        block_reason TEXT,
        decision_trace_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_bt_sig_run
        ON backtest_signal_evidences(backtest_run_id, bar_index ASC);
    `);

    const alterColumns = [
      `ALTER TABLE backtest_runs ADD COLUMN metric_status TEXT NOT NULL DEFAULT 'NO_TRADES'`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN oi_value REAL`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN oi_fetched_at TEXT`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN oi_data_timestamp INTEGER`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN funding_rate REAL`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN funding_data_timestamp INTEGER`,
      `ALTER TABLE backtest_signal_evidences ADD COLUMN oi_funding_point_in_time INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of alterColumns) {
      try {
        this.rawDb.exec(sql);
      } catch {
        // column already exists
      }
    }
  }

  public saveBacktestRun(
    report: BacktestResult,
    exchange: ExchangeId = report.exchange ?? 'binance_usdm',
    scannerRuleVersion = MARKET_SCAN_RULE_VERSION
  ): BacktestResult {
    const saved = this.radarDb.saveBacktestReport(
      report,
      exchange,
      scannerRuleVersion
    );

    const rawSource = report.provenance?.source || '';
    const safeProv = enforceProvenanceIntegrity(report.provenance);
    if (
      isTestFixtureSourceName(rawSource) ||
      safeProv.source === 'TEST_FIXTURE'
    ) {
      return saved;
    }

    const runId =
      saved.backtestRunId ||
      `bt_${exchange}_${saved.symbol}_${saved.timeframe}_${Date.now()}`;
    const createdAt = saved.createdAt || new Date().toISOString();

    const insertRunStmt = this.rawDb.prepare(`
      INSERT INTO backtest_runs (
        backtest_run_id, symbol, exchange, rule_version, timeframe,
        start_time, end_time, data_source, fetched_at, is_demo,
        lookahead_free, data_classification, status, metric_status, insufficient_reason,
        signal_count, executed_paper_count, blocked_count, expired_count, insufficient_data_count,
        trade_count, win_rate, average_r, profit_factor, max_drawdown_r,
        expectancy_r, average_holding_time, long_count, short_count,
        walk_forward_json, report_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backtest_run_id) DO UPDATE SET
        status = excluded.status,
        metric_status = excluded.metric_status,
        lookahead_free = excluded.lookahead_free,
        data_classification = excluded.data_classification,
        report_json = excluded.report_json,
        walk_forward_json = excluded.walk_forward_json
    `);

    insertRunStmt.run(
      runId,
      saved.symbol,
      exchange,
      saved.ruleVersion,
      saved.timeframe,
      saved.startTime ?? null,
      saved.endTime ?? null,
      saved.dataSource ?? safeProv.source,
      saved.fetchedAt ?? safeProv.fetchedAt,
      safeProv.isDemo ? 1 : 0,
      saved.lookaheadFree ? 1 : 0,
      saved.dataClassification ?? (safeProv.isDemo ? 'DEMO' : 'REAL'),
      saved.status,
      saved.metricStatus ??
        (saved.status === 'INSUFFICIENT_DATA'
          ? 'INSUFFICIENT_DATA'
          : (saved.executedPaperCount ?? 0) === 0
            ? 'NO_TRADES'
            : 'READY'),
      saved.insufficientReason ?? null,
      saved.signalCount ?? 0,
      saved.executedPaperCount ?? 0,
      saved.blockedCount ?? 0,
      saved.expiredCount ?? 0,
      saved.insufficientDataCount ?? 0,
      saved.tradeCount ?? saved.totalTrades ?? null,
      saved.winRate ?? saved.winRatePercent ?? null,
      saved.averageR ?? null,
      saved.profitFactor ?? null,
      saved.maxDrawdownR ?? null,
      saved.expectancyR ?? null,
      saved.averageHoldingTime ?? null,
      saved.longCount ?? null,
      saved.shortCount ?? null,
      saved.walkForward ? JSON.stringify(saved.walkForward) : null,
      JSON.stringify(saved),
      createdAt
    );

    if (
      saved.pointInTimeDecisions &&
      saved.pointInTimeDecisions.length > 0
    ) {
      const insertSigStmt = this.rawDb.prepare(`
        INSERT INTO backtest_signal_evidences (
          backtest_run_id, symbol, bar_index, bar_open_time, bar_close_time,
          confirmed_bars_count, volume_baseline_bars, smc_evidence_json,
          oi, funding, oi_value, oi_fetched_at, oi_data_timestamp,
          funding_rate, funding_data_timestamp, oi_funding_point_in_time,
          decision_at, smc_evaluation_status, smc_action_state,
          final_trade_signal, counted_as_trade_signal, block_reason, decision_trace_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Persist candidate signals + up to 40 representative point-in-time decisions
      const decisionsToSave = saved.pointInTimeDecisions.filter(
        (d, idx, arr) =>
          d.countedAsTradeSignal || idx >= arr.length - 25
      );
      for (const dec of decisionsToSave) {
        insertSigStmt.run(
          runId,
          saved.symbol,
          dec.barIndex,
          dec.barOpenTime,
          dec.barCloseTime,
          dec.confirmedBarsCount,
          dec.volumeBaselineBars,
          JSON.stringify(dec.smcEvidence),
          dec.oiValue ?? dec.oi ?? null,
          dec.fundingRate ?? dec.funding ?? null,
          dec.oiValue ?? dec.oi ?? null,
          dec.oiFetchedAt ?? null,
          dec.oiDataTimestamp ?? null,
          dec.fundingRate ?? dec.funding ?? null,
          dec.fundingDataTimestamp ?? null,
          dec.oiFundingPointInTime ? 1 : 0,
          dec.decisionAt,
          dec.smcEvaluationStatus,
          dec.smcActionState,
          dec.finalTradeSignal,
          dec.countedAsTradeSignal ? 1 : 0,
          dec.blockReason ?? null,
          dec.decisionTrace ? JSON.stringify(dec.decisionTrace) : null
        );
      }
    }

    return saved;
  }

  public recordBacktestTradesToPaperLedger(
    report: BacktestResult
  ): PaperLedgerEntry[] {
    if (
      report.status !== 'COMPLETED' ||
      !report.lookaheadFree ||
      report.trades.length === 0
    ) {
      return [];
    }
    const entries: PaperLedgerEntry[] = [];
    const exchange: ExchangeId = report.exchange ?? 'binance_usdm';
    for (const trade of report.trades) {
      const category = trade.direction === 'LONG' ? '多頭候選' : '空頭候選';
      const opened = this.radarDb.addPaperLedgerEntry({
        symbol: report.symbol,
        exchange,
        timeframe: report.timeframe,
        side: trade.direction,
        category,
        actionState: trade.actionStateAtSignal,
        entryPrice: trade.referenceEntryPrice,
        invalidationPrice: trade.structuralInvalidationPrice,
        targetPrice: trade.structuralTargetPrice,
        ruleVersion: report.ruleVersion,
        evidences: [trade.evidencesSummary],
        notes: `[${TRADING_SAFETY_FLAGS.mode} / BACKTEST_PAPER_RECORD] Run=${report.backtestRunId} (${report.dataClassificationLabel ?? report.dataClassification}) Outcome=${trade.outcome} (${trade.rMultiple}R)`,
        provenance: report.provenance,
      });
      const closed =
        this.radarDb.closePaperLedgerEntry(
          opened.id,
          trade.exitPrice,
          opened.notes
        ) ?? opened;
      entries.push(closed);
    }
    return entries;
  }

  public getBacktestRunById(backtestRunId: string): BacktestResult | null {
    const row = this.rawDb
      .prepare(
        `SELECT report_json FROM backtest_runs WHERE backtest_run_id = ? LIMIT 1`
      )
      .get(backtestRunId) as { report_json?: string } | undefined;
    if (!row?.report_json) return null;
    try {
      return JSON.parse(String(row.report_json)) as BacktestResult;
    } catch {
      return null;
    }
  }

  public listBacktestRuns(limit = 30): BacktestResult[] {
    return this.radarDb.listBacktestReports(limit);
  }

  public listSignalEvidencesByRunId(
    backtestRunId: string
  ): BacktestPointInTimeSignalEvidence[] {
    const rows = this.rawDb
      .prepare(
        `SELECT * FROM backtest_signal_evidences WHERE backtest_run_id = ? ORDER BY bar_index ASC`
      )
      .all(backtestRunId);
    return rows.map((r) => {
      const oiVal =
        r.oi_value !== null && r.oi_value !== undefined
          ? Number(r.oi_value)
          : r.oi !== null && r.oi !== undefined
            ? Number(r.oi)
            : null;
      const frVal =
        r.funding_rate !== null && r.funding_rate !== undefined
          ? Number(r.funding_rate)
          : r.funding !== null && r.funding !== undefined
            ? Number(r.funding)
            : null;
      return {
        barIndex: Number(r.bar_index),
        barOpenTime: Number(r.bar_open_time),
        barCloseTime: Number(r.bar_close_time),
        confirmedBarsCount: Number(r.confirmed_bars_count),
        volumeBaselineBars: Number(r.volume_baseline_bars),
        smcEvidence: JSON.parse(String(r.smc_evidence_json || '[]')),
        oi: oiVal,
        funding: frVal,
        oiValue: oiVal,
        oiFetchedAt: r.oi_fetched_at ? String(r.oi_fetched_at) : null,
        oiDataTimestamp:
          r.oi_data_timestamp !== null && r.oi_data_timestamp !== undefined
            ? Number(r.oi_data_timestamp)
            : null,
        fundingRate: frVal,
        fundingDataTimestamp:
          r.funding_data_timestamp !== null &&
          r.funding_data_timestamp !== undefined
            ? Number(r.funding_data_timestamp)
            : null,
        oiFundingPointInTime: Number(r.oi_funding_point_in_time ?? 0) === 1,
        decisionAt: String(r.decision_at),
        smcEvaluationStatus: String(
          r.smc_evaluation_status
        ) as BacktestPointInTimeSignalEvidence['smcEvaluationStatus'],
        smcActionState: String(
          r.smc_action_state
        ) as BacktestPointInTimeSignalEvidence['smcActionState'],
        marketRadarCategory: '準備觀察' as const,
        finalTradeSignal: String(
          r.final_trade_signal
        ) as BacktestPointInTimeSignalEvidence['finalTradeSignal'],
        waitReasons: [],
        countedAsTradeSignal: Number(r.counted_as_trade_signal) === 1,
        countedAsSignal: Number(r.counted_as_trade_signal) === 1,
        blockReason: r.block_reason ? String(r.block_reason) : null,
        blockedReason: r.block_reason ? String(r.block_reason) : null,
        decisionTrace: r.decision_trace_json
          ? JSON.parse(String(r.decision_trace_json))
          : {},
      };
    });
  }
}
