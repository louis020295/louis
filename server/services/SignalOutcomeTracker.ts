import { PaperMonitorDatabase } from '../db/PaperMonitorDatabase.ts';
import { MARKET_SCAN_RULE_VERSION } from '../engine/MarketScanner.ts';
import { SMC_RULE_VERSION } from '../engine/SmcRuleEngine.ts';
import {
  DataProvenance,
  ExchangeId,
  FinalTradeSignal,
  Kline,
  MarketRadarCategory,
  NotificationOutboxChannel,
  NotificationOutboxRecord,
  NotificationOutboxStatus,
  NotificationPayload,
  PaperMetricStatus,
  PaperMonitorReportResponse,
  PaperMonitorReportWindow,
  PaperSignalLifecycleStatus,
  PaperTrackedSignalRecord,
  SampleSufficiencyTier,
  SmcActionState,
  SmcEvaluationStatus,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export interface EvaluateSignalCandidateInput {
  monitorRunId: string;
  scanRunId: string;
  scanCycleId?: string;
  symbol: string;
  exchange: ExchangeId;
  timeframe: Timeframe;
  marketRadarCategory: MarketRadarCategory;
  smcEvaluationStatus: SmcEvaluationStatus;
  smcActionState: SmcActionState;
  finalTradeSignal: FinalTradeSignal;
  ruleVersion?: string;
  snapshotAt: string;
  evaluatedAt: string;
  signalDetectedAt?: string;
  candidateDetectedAt?: string;
  queueEnteredAt?: string;
  evaluationStartedAt?: string;
  evaluationCompletedAt?: string;
  queueWaitMs?: number;
  evaluationLatencyMs?: number;
  candidateDetectionLatencyMs?: number;
  nextBarRemainingMs?: number | null;
  entryWindowStatus?: 'DETECTED_BEFORE_NEXT_BAR_OPEN' | 'ENTRY_WINDOW_MISSED' | string;
  entryWindowMissed?: boolean;
  isFastLane?: boolean;
  useCanonicalEntryWindowStatus?: boolean;
  klines: Kline[];
  signalBarIndex?: number;
  atr14?: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  provenance: DataProvenance;
  waitReasons: string[];
  evidences: string[];
  decisionTrace?: Record<string, unknown> | null;
  score?: number;
  isBacktest?: boolean;
  allowBacktestTracking?: boolean;
  allowDeferredFutureBarEntry?: boolean;
  recordBlockedInDb?: boolean;
  enqueueSandboxNotifications?: boolean;
}

export interface SettleSignalKlinesInput {
  signalId: string;
  klines: Kline[];
  atr14?: number | null;
  maxHoldBars?: number;
  invalidatedBeforeEntry?: boolean;
  invalidationReason?: string;
  isBacktest?: boolean;
  allowDeferredFutureBarEntry?: boolean;
  currentTimeMs?: number;
}

export class SignalOutcomeTracker {
  public readonly paperMonitorDb: PaperMonitorDatabase;
  public readonly defaultRuleVersion = `${SMC_RULE_VERSION}+${MARKET_SCAN_RULE_VERSION}`;
  private readonly cooldownMs: number;
  private readonly dedupeWindowMs: number;
  public externalTelegramRequestsCount: 0 = 0;
  public externalTradingViewRequestsCount: 0 = 0;

  constructor(params: {
    paperMonitorDb: PaperMonitorDatabase;
    cooldownMs?: number;
    dedupeWindowMs?: number;
  }) {
    this.paperMonitorDb = params.paperMonitorDb;
    this.cooldownMs = params.cooldownMs ?? 60 * 60 * 1000; // 60 minutes cooldown
    this.dedupeWindowMs = params.dedupeWindowMs ?? 30 * 60 * 1000; // 30 minutes dedupe
  }

  public timeframeToMs(timeframe: Timeframe): number {
    switch (timeframe) {
      case '5m':
        return 5 * 60 * 1000;
      case '15m':
        return 15 * 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '4h':
        return 4 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000;
    }
  }

  public buildDeterministicSignalId(params: {
    exchange: ExchangeId;
    symbol: string;
    timeframe: Timeframe;
    direction: 'LONG' | 'SHORT' | 'NONE';
    signalBarOpenTime: number | null;
    ruleVersion: string;
  }): string {
    const safeRule = params.ruleVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
    const barTag = params.signalBarOpenTime ?? 'nobar';
    return `sig_${params.exchange}_${params.symbol}_${params.timeframe}_${params.direction}_${barTag}_${safeRule}`;
  }

  /**
   * Evaluates a market + SMC result strictly without lookahead bias:
   * - Signal is anchored at confirmed candle `i` (`signalBarIndex`, default latest confirmed candle).
   * - Entry reference price can ONLY use candle `i + 1` open price (`klines[i + 1].open`).
   * - If candle `i + 1` does not exist yet, status remains `CREATED` (`entryReferencePrice = null`).
   * - If candle `i + 1` exists, locks `entryReferencePrice = klines[i + 1].open` and transitions to `PAPER_OPENED`,
   *   then evaluates any subsequent confirmed candles (`>= i + 1`) using conservative SL-first rules.
   */
  public evaluateAndTrackSignal(input: EvaluateSignalCandidateInput): {
    signal: PaperTrackedSignalRecord | null;
    insertedNew: boolean;
    outboxRecords: NotificationOutboxRecord[];
  } {
    const {
      monitorRunId,
      scanRunId,
      symbol,
      exchange,
      timeframe,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      finalTradeSignal,
      snapshotAt,
      evaluatedAt,
      klines,
      atr14,
      openInterest,
      fundingRate,
      provenance,
      waitReasons,
      evidences,
      score = 0,
      isBacktest = false,
      recordBlockedInDb = false,
      enqueueSandboxNotifications = true,
    } = input;

    const ruleVersion = input.ruleVersion || this.defaultRuleVersion;
    const dbInstanceId = this.paperMonitorDb.radarDb.databaseInstanceId;
    const scanCycleId =
      input.scanCycleId ??
      this.paperMonitorDb.radarDb.getSmcScanCycleId(exchange);

    // Filter only confirmed closed candles unless explicitly evaluating an index
    const confirmedKlines = klines.filter((k) => k.isClosed === true);
    const resolvedSignalBarIdx =
      input.signalBarIndex !== undefined
        ? input.signalBarIndex
        : confirmedKlines.length - 1;

    const signalBar =
      resolvedSignalBarIdx >= 0 && resolvedSignalBarIdx < confirmedKlines.length
        ? confirmedKlines[resolvedSignalBarIdx]
        : null;

    const tfMs = this.timeframeToMs(timeframe);
    const signalBarOpenTime = signalBar ? signalBar.openTime : null;
    const signalBarCloseTime = signalBar ? signalBar.closeTime : null;
    const originalEntryWindowOpenTime =
      signalBarOpenTime !== null ? signalBarOpenTime + tfMs : null;
    const originalEntryWindowCloseTime =
      originalEntryWindowOpenTime !== null
        ? originalEntryWindowOpenTime + tfMs - 1
        : null;
    const signalDetectedAt = input.signalDetectedAt ?? evaluatedAt;

    const direction: 'LONG' | 'SHORT' | 'NONE' =
      smcActionState === 'LONG CANDIDATE' &&
      finalTradeSignal === '多頭交易候選' &&
      marketRadarCategory === '雷達多頭觀察'
        ? 'LONG'
        : smcActionState === 'SHORT CANDIDATE' &&
            finalTradeSignal === '空頭交易候選' &&
            marketRadarCategory === '雷達空頭觀察'
          ? 'SHORT'
          : 'NONE';

    const missingData = [...(provenance.missingData || [])];
    if (
      openInterest === null ||
      openInterest === undefined ||
      !Number.isFinite(openInterest) ||
      openInterest <= 0
    ) {
      if (!missingData.includes('openInterest')) {
        missingData.push('openInterest');
      }
    }
    if (
      fundingRate === null ||
      fundingRate === undefined ||
      !Number.isFinite(fundingRate)
    ) {
      if (!missingData.includes('fundingRate')) {
        missingData.push('fundingRate');
      }
    }

    const isStale = provenance.stale === true;
    const isFallback = provenance.fallback === true;
    const isDemo = provenance.isDemo === true || exchange === 'demo_synthetic';
    const hasWaitReasons = Array.isArray(waitReasons) && waitReasons.length > 0;
    const hasMissingData = missingData.length > 0;
    const allowBacktestTracking = input.allowBacktestTracking === true;

    // Section 三: Strict Eligibility Check
    const isEligibleCandidate =
      (!isBacktest || allowBacktestTracking) &&
      !isDemo &&
      smcEvaluationStatus === 'EVALUATED' &&
      (smcActionState === 'LONG CANDIDATE' ||
        smcActionState === 'SHORT CANDIDATE') &&
      (finalTradeSignal === '多頭交易候選' ||
        finalTradeSignal === '空頭交易候選') &&
      direction !== 'NONE' &&
      !isStale &&
      !isFallback &&
      !hasWaitReasons &&
      !hasMissingData &&
      signalBar !== null;

    const signalId = this.buildDeterministicSignalId({
      exchange,
      symbol,
      timeframe,
      direction,
      signalBarOpenTime,
      ruleVersion,
    });

    const evalMs = Date.parse(evaluatedAt) || Date.now();
    const detectedMs = Date.parse(signalDetectedAt) || evalMs;
    const snapMs = Date.parse(snapshotAt) || evalMs;
    const detectionLatencyMs = Math.max(
      0,
      signalBarCloseTime !== null
        ? detectedMs - signalBarCloseTime
        : detectedMs - snapMs
    );
    const signalLatencyMs = detectionLatencyMs;

    const candidateDetectedAt = input.candidateDetectedAt ?? signalDetectedAt;
    const queueEnteredAt = input.queueEnteredAt ?? snapshotAt;
    const evaluationStartedAt = input.evaluationStartedAt ?? evaluatedAt;
    const evaluationCompletedAt = input.evaluationCompletedAt ?? evaluatedAt;
    const queueWaitMs =
      input.queueWaitMs ??
      Math.max(
        0,
        (Date.parse(evaluationStartedAt) || evalMs) -
          (Date.parse(queueEnteredAt) || snapMs)
      );
    const evaluationLatencyMs =
      input.evaluationLatencyMs ??
      Math.max(
        0,
        (Date.parse(evaluationCompletedAt) || evalMs) -
          (Date.parse(evaluationStartedAt) || evalMs)
      );
    const candidateDetectionLatencyMs =
      direction === 'LONG' || direction === 'SHORT'
        ? (input.candidateDetectionLatencyMs ?? detectionLatencyMs)
        : null;
    const nextBarOpenTime = originalEntryWindowOpenTime;
    const nextBarRemainingMs =
      input.nextBarRemainingMs !== undefined
        ? input.nextBarRemainingMs
        : nextBarOpenTime !== null
          ? nextBarOpenTime - detectedMs
          : null;
    const isFastLane = input.isFastLane ?? true;
    const canonicalEntryWindowMissed =
      !isBacktest &&
      nextBarOpenTime !== null &&
      detectedMs >= nextBarOpenTime;
    const canonicalEntryWindowStatus: 'DETECTED_BEFORE_NEXT_BAR_OPEN' | 'ENTRY_WINDOW_MISSED' =
      canonicalEntryWindowMissed
        ? 'ENTRY_WINDOW_MISSED'
        : 'DETECTED_BEFORE_NEXT_BAR_OPEN';

    const nowIso = new Date().toISOString();

    const resolvedDecisionTrace: Record<string, unknown> = {
      ...(input.decisionTrace ?? {}),
      symbol,
      exchange,
      timeframe,
      scanCycleId,
      scanRunId,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      finalTradeSignal,
      direction,
      ruleVersion,
      evaluatedAt,
      signalDetectedAt,
      candidateDetectedAt,
      snapshotAt,
      signalBarOpenTime,
      signalBarCloseTime,
      nextBarOpenTime,
      originalEntryWindowOpenTime,
      originalEntryWindowCloseTime,
      queueEnteredAt,
      evaluationStartedAt,
      evaluationCompletedAt,
      queueWaitMs,
      evaluationLatencyMs,
      candidateDetectionLatencyMs,
      nextBarRemainingMs,
      entryWindowStatus: canonicalEntryWindowStatus,
      entryWindowMissed: canonicalEntryWindowMissed,
      isFastLane,
      detectionLatencyMs,
      atr14: atr14 ?? null,
      openInterest,
      fundingRate,
      evidences,
      waitReasons,
      missingData,
      source: provenance.source,
      stale: isStale,
      fallback: isFallback,
      isDemo,
    };

    if (!isEligibleCandidate) {
      const blockReason = isBacktest
        ? '回測訊號 (isBacktest=true) 嚴禁進入即時影子監控與通知佇列'
        : isDemo
          ? 'Demo 模擬資料 (isDemo=true) 嚴禁混入 Live 影子運行'
          : isStale
            ? '資料已過期 (stale=true)，禁止建立可交易訊號'
            : isFallback
              ? '使用降級資料 (fallback=true)，禁止建立可交易訊號'
              : hasMissingData
                ? `缺少必要市場資料 (${missingData.join(', ')})，禁止建立可交易訊號`
                : hasWaitReasons
                  ? `存在安全閘門等待原因 (${waitReasons.join('；')})`
                  : `狀態未達交易候選門檻 (smcEvaluationStatus=${smcEvaluationStatus}, smcActionState=${smcActionState}, finalTradeSignal=${finalTradeSignal})`;

      let blockedSignal: PaperTrackedSignalRecord | null = null;
      if (recordBlockedInDb && !isDemo && !isBacktest) {
        const candidateBlockedRecord: PaperTrackedSignalRecord = {
          signalId,
          monitorRunId,
          scanRunId,
          scanCycleId,
          databaseInstanceId: dbInstanceId,
          symbol,
          exchange,
          timeframe,
          direction,
          marketRadarCategory,
          smcEvaluationStatus,
          smcActionState,
          finalTradeSignal,
          ruleVersion,
          snapshotAt,
          evaluatedAt,
          signalDetectedAt,
          signalBarOpenTime,
          signalBarCloseTime,
          originalEntryWindowOpenTime,
          originalEntryWindowCloseTime,
          entryReferenceTime: null,
          entryReferencePrice: null,
          stopLoss: null,
          takeProfit: null,
          riskMultiple: null,
          exitTime: null,
          exitPrice: null,
          holdingTimeMs: null,
          status: 'BLOCKED',
          entryStatus: 'BLOCKED',
          entryWindowStatus: '非候選或已攔截',
          statusReason: blockReason,
          paperLedgerId: null,
          signalLatencyMs,
          detectionLatencyMs,
          source: provenance.source,
          stale: isStale,
          fallback: isFallback,
          missingData,
          waitReasons,
          evidences,
          decisionTrace: resolvedDecisionTrace,
          isDemo: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const res = this.paperMonitorDb.insertTrackedSignalIfAbsent(
          candidateBlockedRecord
        );
        blockedSignal = res.record;
      }

      const outboxRecords: NotificationOutboxRecord[] = [];
      if (enqueueSandboxNotifications) {
        const notifPayload: NotificationPayload = {
          symbol,
          category:
            direction === 'LONG'
              ? '多頭候選'
              : direction === 'SHORT'
                ? '空頭候選'
                : '準備觀察',
          actionState: smcActionState,
          finalTradeSignal,
          smcEvaluationStatus,
          stale: isStale,
          fallback: isFallback,
          waitReasons,
          score,
          confirmedEvidences: evidences,
          missingData,
          riskWarnings: [],
          source: provenance.source,
          fetchedAt: snapshotAt,
          safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
          scanRunId,
          scanCycleId,
          signalId,
          ruleVersion,
          snapshotAt,
          evaluatedAt,
          isBacktest,
        };
        outboxRecords.push(
          this.dispatchToSandboxOutbox({
            monitorRunId,
            scanRunId,
            scanCycleId,
            snapshotAt,
            signalId,
            exchange,
            channel: 'TELEGRAM_SANDBOX',
            payload: notifPayload,
            forceBlockReason: blockReason,
            signalLifecycleStatus: 'BLOCKED',
          })
        );
      }

      return {
        signal: blockedSignal,
        insertedNew: false,
        outboxRecords,
      };
    }

    // Check if signal already exists (idempotency & immutability across restarts & cycles)
    const existing = this.paperMonitorDb.getTrackedSignalById(signalId);
    if (existing) {
      // Settle / advance existing signal if new confirmed bars have arrived,
      // while preserving immutable fields (direction, signalBarOpenTime, smcActionState, entryWindowStatus, entryReferencePrice)
      const updated = this.settleSignalWithKlines({
        signalId: existing.signalId,
        klines: confirmedKlines,
        atr14,
      });
      return {
        signal: updated ?? existing,
        insertedNew: false,
        outboxRecords: [],
      };
    }

    // Phase 18.3 Requirement 三:
    // 若同一 symbol 後續出現相反方向，必須建立新的 signalId，並確認 signalBarOpenTime 不同。不得覆寫歷史訊號。
    if (signalBarOpenTime !== null) {
      const sameBarSignals =
        this.paperMonitorDb.findSignalsBySymbolAndBarOpenTime({
          exchange,
          symbol,
          timeframe,
          signalBarOpenTime,
        });
      const oppositeOnSameBar = sameBarSignals.find(
        (s) => s.direction !== 'NONE' && s.direction !== direction
      );
      if (oppositeOnSameBar) {
        return {
          signal: oppositeOnSameBar,
          insertedNew: false,
          outboxRecords: [],
        };
      }
    }

    // Check symbol + direction cooldown within cooldownMs
    const recentCooldownSignal =
      this.paperMonitorDb.findRecentTradableSignalBySymbolDirection({
        exchange,
        symbol,
        direction,
        excludeSignalId: signalId,
        referenceEvaluatedAtIso: evaluatedAt,
        referenceBarOpenTime: signalBarOpenTime,
        cooldownMs: this.cooldownMs,
      });

    if (recentCooldownSignal) {
      const cooldownUntilIso = new Date(
        (Date.parse(recentCooldownSignal.evaluatedAt) || Date.now()) +
          this.cooldownMs
      ).toISOString();
      const cooldownReason = `COOLDOWN_BLOCKED: 同一標的同方向 (${symbol}:${direction}) 於冷卻視窗內已存在訊號 (${recentCooldownSignal.signalId}, cooldownUntil=${cooldownUntilIso})`;

      const cooldownBlockedRecord: PaperTrackedSignalRecord = {
        signalId,
        monitorRunId,
        scanRunId,
        scanCycleId,
        databaseInstanceId: dbInstanceId,
        symbol,
        exchange,
        timeframe,
        direction,
        marketRadarCategory,
        smcEvaluationStatus,
        smcActionState,
        finalTradeSignal,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        signalDetectedAt,
        signalBarOpenTime,
        signalBarCloseTime,
        originalEntryWindowOpenTime,
        originalEntryWindowCloseTime,
        entryReferenceTime: null,
        entryReferencePrice: null,
        stopLoss: null,
        takeProfit: null,
        riskMultiple: null,
        exitTime: null,
        exitPrice: null,
        holdingTimeMs: null,
        status: 'BLOCKED',
        entryStatus: 'BLOCKED',
        entryWindowStatus: '冷卻期間攔截',
        statusReason: cooldownReason,
        paperLedgerId: null,
        signalLatencyMs,
        detectionLatencyMs,
        source: provenance.source,
        stale: isStale,
        fallback: isFallback,
        missingData,
        waitReasons,
        evidences,
        decisionTrace: resolvedDecisionTrace,
        isDemo: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.paperMonitorDb.insertTrackedSignalIfAbsent(cooldownBlockedRecord);

      const outboxRecords: NotificationOutboxRecord[] = [];
      if (enqueueSandboxNotifications && !isBacktest) {
        const notifPayload: NotificationPayload = {
          symbol,
          category: direction === 'LONG' ? '多頭候選' : '空頭候選',
          actionState: smcActionState,
          finalTradeSignal,
          smcEvaluationStatus,
          stale: isStale,
          fallback: isFallback,
          waitReasons,
          score,
          confirmedEvidences: evidences,
          missingData,
          riskWarnings: [],
          source: provenance.source,
          fetchedAt: snapshotAt,
          safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
          scanRunId,
          scanCycleId,
          signalId,
          ruleVersion,
          snapshotAt,
          evaluatedAt,
          isBacktest,
        };
        outboxRecords.push(
          this.dispatchToSandboxOutbox({
            monitorRunId,
            scanRunId,
            scanCycleId,
            snapshotAt,
            signalId,
            exchange,
            channel: 'TELEGRAM_SANDBOX',
            payload: notifPayload,
            forceBlockReason: cooldownReason,
            signalLifecycleStatus: 'BLOCKED',
          }),
          this.dispatchToSandboxOutbox({
            monitorRunId,
            scanRunId,
            scanCycleId,
            snapshotAt,
            signalId,
            exchange,
            channel: 'TRADINGVIEW_SANDBOX',
            payload: notifPayload,
            forceBlockReason: cooldownReason,
            signalLifecycleStatus: 'BLOCKED',
          })
        );
      }

      return {
        signal: cooldownBlockedRecord,
        insertedNew: false,
        outboxRecords,
      };
    }

    // Check if the original entry window (bar i+1 openTime) was already missed in Live Paper mode:
    // Rule:
    //   If signalDetectedAt < nextBar.openTime => can use nextBar.open
    //   If signalDetectedAt >= nextBar.openTime => original entry window missed (ENTRY_WINDOW_MISSED), NEVER retroactively use nextBar.open
    const isOriginalEntryWindowMissed =
      !isBacktest &&
      originalEntryWindowOpenTime !== null &&
      detectedMs >= originalEntryWindowOpenTime;

    const initialStatus: PaperSignalLifecycleStatus =
      isOriginalEntryWindowMissed ? 'ENTRY_WINDOW_MISSED' : 'CREATED';
    const initialEntryStatus: PaperSignalLifecycleStatus =
      isOriginalEntryWindowMissed
        ? 'ENTRY_WINDOW_MISSED'
        : 'PENDING_NEXT_ENTRY';
    const initialEntryWindowStatus =
      input.entryWindowStatus !== undefined
        ? input.entryWindowStatus
        : input.useCanonicalEntryWindowStatus
          ? isOriginalEntryWindowMissed
            ? 'ENTRY_WINDOW_MISSED'
            : 'DETECTED_BEFORE_NEXT_BAR_OPEN'
          : isOriginalEntryWindowMissed
            ? '原始進場窗口已錯過'
            : '等待下一根 K 線開盤';
    const initialStatusReason = isOriginalEntryWindowMissed
      ? `ENTRY_WINDOW_MISSED: 原始進場窗口已錯過（訊號發現時間 ${signalDetectedAt} 已晚於第 i+1 根 K 線開盤時間 ${new Date(originalEntryWindowOpenTime!).toISOString()}，延遲 ${detectionLatencyMs}ms，嚴禁回溯使用已錯過的開盤價）`
      : '等待第 i+1 根 K 線開盤價確認進場參考價 (嚴格禁止使用訊號產生後才知道的未來收盤價修改進場價)';

    const initialRecord: PaperTrackedSignalRecord = {
      signalId,
      monitorRunId,
      scanRunId,
      scanCycleId,
      databaseInstanceId: dbInstanceId,
      symbol,
      exchange,
      timeframe,
      direction,
      marketRadarCategory,
      smcEvaluationStatus,
      smcActionState,
      finalTradeSignal,
      ruleVersion,
      snapshotAt,
      evaluatedAt,
      signalDetectedAt,
      candidateDetectedAt,
      signalBarOpenTime,
      signalBarCloseTime,
      nextBarOpenTime,
      originalEntryWindowOpenTime,
      originalEntryWindowCloseTime,
      queueEnteredAt,
      evaluationStartedAt,
      evaluationCompletedAt,
      queueWaitMs,
      evaluationLatencyMs,
      candidateDetectionLatencyMs,
      nextBarRemainingMs,
      entryWindowMissed: isOriginalEntryWindowMissed,
      isFastLane,
      entryReferenceTime: null,
      entryReferencePrice: null,
      stopLoss: null,
      takeProfit: null,
      riskMultiple: null,
      exitTime: null,
      exitPrice: null,
      holdingTimeMs: null,
      status: initialStatus,
      entryStatus: initialEntryStatus,
      entryWindowStatus: initialEntryWindowStatus,
      statusReason: initialStatusReason,
      paperLedgerId: null,
      signalLatencyMs,
      detectionLatencyMs,
      source: provenance.source,
      stale: false,
      fallback: false,
      missingData: [],
      waitReasons: [],
      evidences,
      decisionTrace: resolvedDecisionTrace,
      isDemo: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const { inserted, record: persistedSignal } =
      this.paperMonitorDb.insertTrackedSignalIfAbsent(initialRecord);

    // Attempt to open/settle according to Backtest vs Live Paper rules
    const settledSignal =
      this.settleSignalWithKlines({
        signalId: persistedSignal.signalId,
        klines,
        atr14,
        isBacktest,
        allowDeferredFutureBarEntry: input.allowDeferredFutureBarEntry,
      }) ?? persistedSignal;

    const outboxRecords: NotificationOutboxRecord[] = [];
    if (inserted && enqueueSandboxNotifications && !isBacktest) {
      const notifPayload: NotificationPayload = {
        symbol,
        category: direction === 'LONG' ? '多頭候選' : '空頭候選',
        actionState: smcActionState,
        finalTradeSignal,
        smcEvaluationStatus: 'EVALUATED',
        stale: false,
        fallback: false,
        waitReasons: [],
        score,
        confirmedEvidences: evidences,
        missingData: [],
        riskWarnings: [],
        source: provenance.source,
        fetchedAt: snapshotAt,
        safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
        scanRunId,
        scanCycleId,
        signalId: settledSignal.signalId,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        isBacktest: false,
      };

      outboxRecords.push(
        this.dispatchToSandboxOutbox({
          monitorRunId,
          scanRunId,
          scanCycleId,
          snapshotAt,
          signalId: settledSignal.signalId,
          exchange,
          channel: 'TELEGRAM_SANDBOX',
          payload: notifPayload,
          signalLifecycleStatus: settledSignal.status,
        }),
        this.dispatchToSandboxOutbox({
          monitorRunId,
          scanRunId,
          scanCycleId,
          snapshotAt,
          signalId: settledSignal.signalId,
          exchange,
          channel: 'TRADINGVIEW_SANDBOX',
          payload: notifPayload,
          signalLifecycleStatus: settledSignal.status,
        })
      );
    }

    return {
      signal: settledSignal,
      insertedNew: inserted,
      outboxRecords,
    };
  }

  /**
   * Advances a `CREATED`, `PENDING_NEXT_ENTRY`, `ENTRY_WINDOW_MISSED`, or `PAPER_OPENED` signal using strictly chronological K-lines:
   * - Backtest Mode (`isBacktest === true`):
   *   Signal is generated at bar `i` close; `entryReferencePrice = confirmedKlines[i + 1].open`.
   * - Live Paper Mode (`!isBacktest`):
   *   - `signalDetectedAt` = actual time the system detected the signal.
   *   - If `signalDetectedAt < nextBar.openTime`: can use `nextBar.open` as `entryReferencePrice`.
   *   - If `signalDetectedAt >= nextBar.openTime`: original entry window (`nextBar`) is MISSED (`ENTRY_WINDOW_MISSED`).
   *     MUST NOT retroactively use `nextBar.open`!
   *     Only if `allowDeferredFutureBarEntry === true` and a future bar with `bar.openTime > signalDetectedAt` arrives
   *     can it open at that future bar's open price.
   */
  public settleSignalWithKlines(
    input: SettleSignalKlinesInput
  ): PaperTrackedSignalRecord | null {
    const existing = this.paperMonitorDb.getTrackedSignalById(input.signalId);
    if (!existing) return null;

    // Terminal states are immutable
    if (
      existing.status === 'PAPER_CLOSED_WIN' ||
      existing.status === 'PAPER_CLOSED_LOSS' ||
      existing.status === 'PAPER_EXPIRED' ||
      existing.status === 'INVALIDATED' ||
      existing.status === 'BLOCKED'
    ) {
      return existing;
    }

    if (
      input.invalidatedBeforeEntry &&
      (existing.status === 'CREATED' ||
        existing.status === 'PENDING_NEXT_ENTRY' ||
        existing.status === 'ENTRY_WINDOW_MISSED')
    ) {
      return this.paperMonitorDb.updateTrackedSignalOutcome({
        signalId: existing.signalId,
        status: 'INVALIDATED',
        entryStatus: 'INVALIDATED',
        entryWindowStatus: '進場前結構失效',
        statusReason:
          input.invalidationReason ||
          '進場前結構已失效 (INVALIDATED)，取消建立紙上部位',
      });
    }

    if (existing.signalBarOpenTime === null) {
      return existing;
    }

    const sortedKlines = [...input.klines].sort(
      (a, b) => a.openTime - b.openTime
    );

    const tfMs = this.timeframeToMs(existing.timeframe);
    const origWindowOpen =
      existing.originalEntryWindowOpenTime ??
      existing.signalBarOpenTime + tfMs;
    const detectedIso = existing.signalDetectedAt || existing.evaluatedAt;
    const detectedMs = Date.parse(detectedIso) || 0;
    const isBacktest = input.isBacktest === true;

    // Find bar i+1 (the first bar with openTime > signalBarOpenTime)
    const nextBarIndex = sortedKlines.findIndex(
      (k) => k.openTime > existing.signalBarOpenTime!
    );

    let currentRecord = existing;
    let entryBarIndex = nextBarIndex;

    // Step 1: Handle entry eligibility for unopened signals
    if (
      currentRecord.status === 'CREATED' ||
      currentRecord.status === 'PENDING_NEXT_ENTRY' ||
      currentRecord.status === 'ENTRY_WINDOW_MISSED'
    ) {
      if (!isBacktest && detectedMs >= origWindowOpen) {
        // Live Paper: Signal was detected AT OR AFTER bar i+1 openTime!
        // Original entry window (nextBar.open) was ALREADY MISSED. NEVER retroactively use nextBar.open!
        if (currentRecord.status !== 'ENTRY_WINDOW_MISSED') {
          const missed = this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'ENTRY_WINDOW_MISSED',
            entryStatus: 'ENTRY_WINDOW_MISSED',
            entryWindowStatus: '原始進場窗口已錯過',
            statusReason: `ENTRY_WINDOW_MISSED: 原始進場窗口已錯過（訊號發現時間 ${detectedIso} >= 第 i+1 根 K 線開盤時間 ${new Date(origWindowOpen).toISOString()}，嚴禁回溯使用已錯過的開盤價）`,
            entryReferenceTime: null,
            entryReferencePrice: null,
          });
          if (missed) {
            currentRecord = missed;
          }
        }

        if (!input.allowDeferredFutureBarEntry) {
          return currentRecord;
        }

        // If allowDeferredFutureBarEntry is enabled, find the first future bar whose openTime > detectedMs
        const futureBarIdx = sortedKlines.findIndex(
          (k) => k.openTime > detectedMs
        );
        if (futureBarIdx === -1) {
          return currentRecord;
        }
        const futureBar = sortedKlines[futureBarIdx];
        if (
          input.currentTimeMs !== undefined &&
          input.currentTimeMs < futureBar.openTime
        ) {
          return currentRecord;
        }
        entryBarIndex = futureBarIdx;
      } else {
        // Backtest Mode OR Live Paper where signalDetectedAt < nextBar.openTime
        if (nextBarIndex === -1) {
          // No bar i+1 yet -> remain in CREATED waiting for next bar open
          return currentRecord;
        }
        const nextBarCandidate = sortedKlines[nextBarIndex];
        if (
          !isBacktest &&
          input.currentTimeMs !== undefined &&
          input.currentTimeMs < nextBarCandidate.openTime
        ) {
          // Not yet reached nextBar.openTime
          return currentRecord;
        }
        entryBarIndex = nextBarIndex;
      }

      const entryBar = sortedKlines[entryBarIndex];
      const entryReferencePrice = entryBar.open;
      const entryReferenceTime = new Date(entryBar.openTime).toISOString();
      const usedDeferredWindow = !isBacktest && entryBar.openTime > origWindowOpen;

      // Compute structural ATR if not provided
      const priorConfirmed = sortedKlines
        .slice(0, entryBarIndex)
        .filter((k) => k.isClosed);
      const effectiveAtr =
        input.atr14 && input.atr14 > 0
          ? input.atr14
          : priorConfirmed.length >= 5
            ? priorConfirmed
                .slice(-14)
                .reduce(
                  (acc, b) => acc + Math.max(b.high - b.low, b.close * 0.002),
                  0
                ) / Math.min(14, priorConfirmed.length)
            : entryReferencePrice * 0.006;

      const riskDistance = effectiveAtr * 1.5;
      const rewardDistance = effectiveAtr * 2.5; // 1.67R target

      const stopLoss =
        currentRecord.direction === 'LONG'
          ? Number((entryReferencePrice - riskDistance).toPrecision(6))
          : Number((entryReferencePrice + riskDistance).toPrecision(6));
      const takeProfit =
        currentRecord.direction === 'LONG'
          ? Number((entryReferencePrice + rewardDistance).toPrecision(6))
          : Number((entryReferencePrice - rewardDistance).toPrecision(6));

      // Write to paper_trading_ledger (PAPER ONLY)
      const ledgerEntry = this.paperMonitorDb.radarDb.addPaperLedgerEntry({
        symbol: currentRecord.symbol,
        exchange: currentRecord.exchange,
        timeframe: currentRecord.timeframe,
        side: currentRecord.direction === 'LONG' ? 'LONG' : 'SHORT',
        category:
          currentRecord.direction === 'LONG' ? '多頭候選' : '空頭候選',
        actionState: currentRecord.smcActionState,
        entryPrice: entryReferencePrice,
        invalidationPrice: stopLoss,
        targetPrice: takeProfit,
        ruleVersion: currentRecord.ruleVersion,
        evidences: currentRecord.evidences,
        notes: `[Phase 5 Shadow Monitor · ${currentRecord.signalId}] ${usedDeferredWindow ? '下一根未開盤未來 K 線' : '第 i+1 根 K 線'} (${entryReferenceTime}) 開盤價進場`,
        provenance: {
          source: currentRecord.source,
          fetchedAt: currentRecord.snapshotAt,
          stale: false,
          fallback: false,
          missingData: [],
          isDemo: false,
        },
      });

      const opened = this.paperMonitorDb.updateTrackedSignalOutcome({
        signalId: currentRecord.signalId,
        status: 'PAPER_OPENED',
        entryStatus: 'PAPER_OPENED',
        entryWindowStatus: usedDeferredWindow
          ? '原始進場窗口已錯過（已改用下一根未開盤之未來 K 線開盤進場）'
          : '已於原始進場窗口開盤進場',
        statusReason: `已於${usedDeferredWindow ? '下一根未開盤未來 K 線' : '第 i+1 根 K 線'}開盤價 (${entryReferencePrice}) 建立紙上部位`,
        entryReferenceTime,
        entryReferencePrice,
        stopLoss,
        takeProfit,
        riskMultiple: 0,
        paperLedgerId: ledgerEntry.id,
      });
      if (opened) {
        currentRecord = opened;
      }
      this.paperMonitorDb.promotePendingEntryOutboxToQueued(
        currentRecord.signalId,
        currentRecord.exchange
      );
    }

    if (currentRecord.status !== 'PAPER_OPENED' || currentRecord.entryReferencePrice === null) {
      return currentRecord;
    }

    // Step 2: Evaluate confirmed bars from entryBar onward for SL / TP / Expiry
    const maxHoldBars = input.maxHoldBars ?? 16;
    const entryPrice = currentRecord.entryReferencePrice!;
    const stopLoss = currentRecord.stopLoss!;
    const takeProfit = currentRecord.takeProfit!;
    const riskDistance = Math.max(Math.abs(entryPrice - stopLoss), 1e-8);
    const rewardDistance = Math.abs(takeProfit - entryPrice);
    const entryOpenMs = Date.parse(currentRecord.entryReferenceTime!);

    const resolvedEntryBarIndex = sortedKlines.findIndex(
      (k) => k.openTime >= (Number.isFinite(entryOpenMs) ? entryOpenMs : origWindowOpen)
    );
    if (resolvedEntryBarIndex === -1) {
      return currentRecord;
    }

    const confirmedFromEntry = sortedKlines
      .slice(resolvedEntryBarIndex)
      .filter((k) => k.isClosed === true);

    for (let idx = 0; idx < confirmedFromEntry.length; idx++) {
      const bar = confirmedFromEntry[idx];
      const holdingBars = idx + 1;
      const holdingTimeMs = Math.max(
        1,
        bar.closeTime - (Number.isFinite(entryOpenMs) ? entryOpenMs : bar.openTime)
      );
      const exitTimeIso = new Date(bar.closeTime).toISOString();

      if (currentRecord.direction === 'LONG') {
        const hitSl = bar.low <= stopLoss;
        const hitTp = bar.high >= takeProfit;

        // Section 四: 同一根 K 線同時觸及止損與止盈時，保守判定為止損
        if (hitSl && hitTp) {
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              stopLoss,
              '[PAPER ONLY] 同根 K 線同時觸及 SL/TP，保守判定為止損 CLOSED_LOSS'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_LOSS',
            statusReason:
              '同一根 K 線同時觸及止損與止盈，依保守無偏差規則判定為止損 (PAPER_CLOSED_LOSS)',
            riskMultiple: -1.0,
            exitTime: exitTimeIso,
            exitPrice: stopLoss,
            holdingTimeMs,
          });
        }

        if (hitSl) {
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              stopLoss,
              '[PAPER ONLY] 觸及結構失效止損位 CLOSED_LOSS'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_LOSS',
            statusReason: '觸及結構失效止損位 (PAPER_CLOSED_LOSS)',
            riskMultiple: -1.0,
            exitTime: exitTimeIso,
            exitPrice: stopLoss,
            holdingTimeMs,
          });
        }

        if (hitTp) {
          const rMult = Number((rewardDistance / riskDistance).toFixed(2));
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              takeProfit,
              '[PAPER ONLY] 觸及結構目標止盈位 CLOSED_WIN'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_WIN',
            statusReason: '觸及結構目標止盈位 (PAPER_CLOSED_WIN)',
            riskMultiple: rMult,
            exitTime: exitTimeIso,
            exitPrice: takeProfit,
            holdingTimeMs,
          });
        }
      } else if (currentRecord.direction === 'SHORT') {
        const hitSl = bar.high >= stopLoss;
        const hitTp = bar.low <= takeProfit;

        // Section 四: 同一根 K 線同時觸及止損與止盈時，保守判定為止損
        if (hitSl && hitTp) {
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              stopLoss,
              '[PAPER ONLY] 同根 K 線同時觸及 SL/TP，保守判定為止損 CLOSED_LOSS'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_LOSS',
            statusReason:
              '同一根 K 線同時觸及止損與止盈，依保守無偏差規則判定為止損 (PAPER_CLOSED_LOSS)',
            riskMultiple: -1.0,
            exitTime: exitTimeIso,
            exitPrice: stopLoss,
            holdingTimeMs,
          });
        }

        if (hitSl) {
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              stopLoss,
              '[PAPER ONLY] 觸及結構失效止損位 CLOSED_LOSS'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_LOSS',
            statusReason: '觸及結構失效止損位 (PAPER_CLOSED_LOSS)',
            riskMultiple: -1.0,
            exitTime: exitTimeIso,
            exitPrice: stopLoss,
            holdingTimeMs,
          });
        }

        if (hitTp) {
          const rMult = Number((rewardDistance / riskDistance).toFixed(2));
          if (currentRecord.paperLedgerId) {
            this.paperMonitorDb.radarDb.closePaperLedgerEntry(
              currentRecord.paperLedgerId,
              takeProfit,
              '[PAPER ONLY] 觸及結構目標止盈位 CLOSED_WIN'
            );
          }
          return this.paperMonitorDb.updateTrackedSignalOutcome({
            signalId: currentRecord.signalId,
            status: 'PAPER_CLOSED_WIN',
            statusReason: '觸及結構目標止盈位 (PAPER_CLOSED_WIN)',
            riskMultiple: rMult,
            exitTime: exitTimeIso,
            exitPrice: takeProfit,
            holdingTimeMs,
          });
        }
      }

      if (holdingBars >= maxHoldBars) {
        const rawDiff =
          currentRecord.direction === 'LONG'
            ? bar.close - entryPrice
            : entryPrice - bar.close;
        const expiredR = Number((rawDiff / riskDistance).toFixed(2));
        if (currentRecord.paperLedgerId) {
          this.paperMonitorDb.radarDb.closePaperLedgerEntry(
            currentRecord.paperLedgerId,
            bar.close,
            '[PAPER ONLY] 持倉到期平倉 PAPER_EXPIRED'
          );
        }
        return this.paperMonitorDb.updateTrackedSignalOutcome({
          signalId: currentRecord.signalId,
          status: 'PAPER_EXPIRED',
          statusReason: `持倉達上限 ${maxHoldBars} 根 K 線未觸及止損或止盈，依到期平倉結算 (PAPER_EXPIRED)`,
          riskMultiple: expiredR,
          exitTime: exitTimeIso,
          exitPrice: bar.close,
          holdingTimeMs,
        });
      }
    }

    return currentRecord;
  }

  /**
   * Local Notification Sandbox Adapter (TELEGRAM_SANDBOX / TRADINGVIEW_SANDBOX).
   * - NEVER makes external network requests (`externalTelegramRequestsCount === 0`, `externalTradingViewRequestsCount === 0`).
   * - Produces traceable statuses:
   *   `PREVIEW_DRY_RUN` | `SANDBOX_QUEUED` | `PENDING_ENTRY` | `NON_CANDIDATE_BLOCKED` | `DEDUPED_BLOCKED` | `COOLDOWN_BLOCKED` | `STALE_BLOCKED` | `FALLBACK_BLOCKED` | `MISSING_DATA_BLOCKED`
   */
  public dispatchToSandboxOutbox(params: {
    monitorRunId: string;
    scanRunId: string;
    scanCycleId?: string | null;
    snapshotAt?: string;
    signalId: string;
    exchange: ExchangeId;
    channel: NotificationOutboxChannel;
    payload: NotificationPayload;
    forceBlockReason?: string;
    isPreviewDryRun?: boolean;
    signalLifecycleStatus?: PaperSignalLifecycleStatus;
    nowMs?: number;
  }): NotificationOutboxRecord {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { payload, channel, exchange, monitorRunId, scanRunId, signalId } =
      params;
    const resolvedScanCycleId =
      params.scanCycleId ??
      payload.scanCycleId ??
      this.paperMonitorDb.radarDb.getSmcScanCycleId(exchange);
    const resolvedSnapshotAt =
      params.snapshotAt ?? payload.snapshotAt ?? payload.fetchedAt ?? nowIso;

    const directionTag =
      payload.actionState === 'LONG CANDIDATE'
        ? 'LONG'
        : payload.actionState === 'SHORT CANDIDATE'
          ? 'SHORT'
          : 'NONE';

    const ruleVersion = payload.ruleVersion ?? this.defaultRuleVersion;
    const dedupeKey =
      payload.dedupeKey ??
      `${channel}:${exchange}:${payload.symbol}:${directionTag}:${payload.actionState}:${ruleVersion}:${payload.confirmedEvidences.join('|')}`;
    const symbolDirectionKey = `${ payload.symbol }:${ directionTag }`;

    const formattedMessage =
      channel === 'TELEGRAM_SANDBOX'
        ? `[TELEGRAM_SANDBOX · PAPER ONLY | LIVE ORDERS DISABLED]\n標的: ${payload.symbol} (${exchange})\n狀態: ${payload.actionState} (${payload.finalTradeSignal ?? 'NONE'})\nSignalID: ${signalId}\n證據: ${payload.confirmedEvidences.join(', ') || '無'}\n來源: ${payload.source}`
        : JSON.stringify({
            sandboxChannel: 'TRADINGVIEW_SANDBOX',
            safety: TRADING_SAFETY_FLAGS,
            symbol: payload.symbol,
            exchange,
            signalId,
            scanCycleId: resolvedScanCycleId,
            snapshotAt: resolvedSnapshotAt,
            actionState: payload.actionState,
            finalTradeSignal: payload.finalTradeSignal ?? 'NONE',
            ruleVersion,
            evidences: payload.confirmedEvidences,
          });

    const hasWaitReasons =
      Array.isArray(payload.waitReasons) && payload.waitReasons.length > 0;
    const hasMissingData =
      Array.isArray(payload.missingData) && payload.missingData.length > 0;
    const isStale = payload.stale === true;
    const isFallback = payload.fallback === true;
    const isBacktest = payload.isBacktest === true;
    const isNonCandidate =
      payload.smcEvaluationStatus !== 'EVALUATED' ||
      (payload.actionState !== 'LONG CANDIDATE' &&
        payload.actionState !== 'SHORT CANDIDATE') ||
      (payload.finalTradeSignal !== '多頭交易候選' &&
        payload.finalTradeSignal !== '空頭交易候選');

    if (
      params.forceBlockReason ||
      isBacktest ||
      isStale ||
      isFallback ||
      hasWaitReasons ||
      hasMissingData ||
      isNonCandidate
    ) {
      const blockedReason =
        params.forceBlockReason ||
        (isBacktest
          ? '回測訊號 (isBacktest=true) 不得進入即時通知佇列'
          : isStale
            ? 'STALE_BLOCKED: 資料已過期 (stale=true) 不得通知'
            : isFallback
              ? 'FALLBACK_BLOCKED: 使用降級資料 (fallback=true) 不得通知'
              : hasMissingData
                ? `MISSING_DATA_BLOCKED: 缺失必要資料 (${payload.missingData.join(', ')}) 不得通知`
                : hasWaitReasons
                  ? `NON_CANDIDATE_BLOCKED: 存在 WAIT 原因 (${payload.waitReasons!.join('；')})`
                  : `NON_CANDIDATE_BLOCKED: 非可交易候選狀態 (${payload.actionState} / ${payload.finalTradeSignal ?? 'NONE'})`);

      const blockStatus: NotificationOutboxStatus =
        params.forceBlockReason?.startsWith('COOLDOWN_BLOCKED')
          ? 'COOLDOWN_BLOCKED'
          : params.forceBlockReason?.startsWith('DEDUPED_BLOCKED')
            ? 'DEDUPED_BLOCKED'
            : isStale || params.forceBlockReason?.includes('stale=true')
              ? 'STALE_BLOCKED'
              : isFallback || params.forceBlockReason?.includes('fallback=true')
                ? 'FALLBACK_BLOCKED'
                : hasMissingData ||
                    params.forceBlockReason?.includes('缺少必要市場資料')
                  ? 'MISSING_DATA_BLOCKED'
                  : 'NON_CANDIDATE_BLOCKED';

      const record: NotificationOutboxRecord = {
        notificationId: `outbox_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
        signalId,
        monitorRunId,
        scanRunId,
        scanCycleId: resolvedScanCycleId,
        symbol: payload.symbol,
        exchange,
        channel,
        payload,
        formattedMessage,
        snapshotAt: resolvedSnapshotAt,
        createdAt: nowIso,
        status: blockStatus,
        dedupeKey,
        cooldownUntil: null,
        blockedReason,
      };
      return this.paperMonitorDb.insertNotificationOutbox(record);
    }

    // Check Dedupe Window
    const dedupeSinceIso = new Date(nowMs - this.dedupeWindowMs).toISOString();
    const recentDedupe = this.paperMonitorDb.findRecentOutboxByDedupeKey(
      channel,
      dedupeKey,
      dedupeSinceIso
    );
    if (recentDedupe) {
      const record: NotificationOutboxRecord = {
        notificationId: `outbox_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
        signalId,
        monitorRunId,
        scanRunId,
        scanCycleId: resolvedScanCycleId,
        symbol: payload.symbol,
        exchange,
        channel,
        payload,
        formattedMessage,
        snapshotAt: resolvedSnapshotAt,
        createdAt: nowIso,
        status: 'DEDUPED_BLOCKED',
        dedupeKey,
        cooldownUntil: recentDedupe.cooldownUntil,
        blockedReason: `DEDUPED_BLOCKED: 相同訊號簽章 (${dedupeKey}) 於去重期間內已入列 (${recentDedupe.notificationId})`,
      };
      return this.paperMonitorDb.insertNotificationOutbox(record);
    }

    // Check Cooldown Window for same symbol & direction
    const cooldownSinceIso = new Date(nowMs - this.cooldownMs).toISOString();
    const recentSymbol =
      this.paperMonitorDb.findRecentOutboxBySymbolDirectionCooldown(
        channel,
        payload.symbol,
        cooldownSinceIso
      );
    if (
      recentSymbol &&
      recentSymbol.payload.actionState === payload.actionState
    ) {
      const cooldownUntil =
        recentSymbol.cooldownUntil ??
        new Date(
          Date.parse(recentSymbol.createdAt) + this.cooldownMs
        ).toISOString();
      const record: NotificationOutboxRecord = {
        notificationId: `outbox_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
        signalId,
        monitorRunId,
        scanRunId,
        scanCycleId: resolvedScanCycleId,
        symbol: payload.symbol,
        exchange,
        channel,
        payload,
        formattedMessage,
        snapshotAt: resolvedSnapshotAt,
        createdAt: nowIso,
        status: 'COOLDOWN_BLOCKED',
        dedupeKey,
        cooldownUntil,
        blockedReason: `COOLDOWN_BLOCKED: 同一標的同方向 (${symbolDirectionKey}) 處於冷卻期間內 (cooldownUntil=${cooldownUntil})`,
      };
      return this.paperMonitorDb.insertNotificationOutbox(record);
    }

    const cooldownUntil = new Date(nowMs + this.cooldownMs).toISOString();
    const status: NotificationOutboxStatus = params.isPreviewDryRun
      ? 'PREVIEW_DRY_RUN'
      : params.signalLifecycleStatus === 'CREATED'
        ? 'PENDING_ENTRY'
        : 'SANDBOX_QUEUED';
    const pendingEntryReason =
      status === 'PENDING_ENTRY'
        ? 'PENDING_ENTRY: 訊號已於第 i 根確認 K 線收盤後建立，等待第 i+1 根 K 線開盤價確認進場參考價（非交易被拒絕）'
        : null;

    const record: NotificationOutboxRecord = {
      notificationId: `outbox_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
      signalId,
      monitorRunId,
      scanRunId,
      scanCycleId: resolvedScanCycleId,
      symbol: payload.symbol,
      exchange,
      channel,
      payload,
      formattedMessage,
      snapshotAt: resolvedSnapshotAt,
      createdAt: nowIso,
      status,
      dedupeKey,
      cooldownUntil,
      blockedReason: pendingEntryReason,
    };
    return this.paperMonitorDb.insertNotificationOutbox(record);
  }

  public generatePreviewForSignalId(
    signalId: string,
    channel: NotificationOutboxChannel = 'TELEGRAM_SANDBOX'
  ): NotificationOutboxRecord | null {
    const sig = this.paperMonitorDb.getTrackedSignalById(signalId);
    if (!sig) return null;

    const payload: NotificationPayload = {
      symbol: sig.symbol,
      category:
        sig.direction === 'LONG'
          ? '多頭候選'
          : sig.direction === 'SHORT'
            ? '空頭候選'
            : '準備觀察',
      actionState: sig.smcActionState,
      finalTradeSignal: sig.finalTradeSignal,
      smcEvaluationStatus: sig.smcEvaluationStatus,
      stale: sig.stale,
      fallback: sig.fallback,
      waitReasons: sig.waitReasons,
      score: 85,
      confirmedEvidences: sig.evidences,
      missingData: sig.missingData,
      riskWarnings: [],
      source: sig.source,
      fetchedAt: sig.snapshotAt,
      safetyBanner: 'PAPER ONLY | LIVE ORDERS DISABLED',
      scanRunId: sig.scanRunId,
      scanCycleId: sig.scanCycleId ?? null,
      signalId: sig.signalId,
      ruleVersion: sig.ruleVersion,
      snapshotAt: sig.snapshotAt,
      evaluatedAt: sig.evaluatedAt,
      isBacktest: false,
    };

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const isEligible =
      sig.smcEvaluationStatus === 'EVALUATED' &&
      (sig.smcActionState === 'LONG CANDIDATE' ||
        sig.smcActionState === 'SHORT CANDIDATE') &&
      (sig.finalTradeSignal === '多頭交易候選' ||
        sig.finalTradeSignal === '空頭交易候選') &&
      !sig.stale &&
      !sig.fallback &&
      sig.missingData.length === 0 &&
      sig.waitReasons.length === 0;

    const dedupeKey = `${channel}:PREVIEW:${sig.exchange}:${sig.symbol}:${sig.signalId}`;
    const formattedMessage = `[PREVIEW_DRY_RUN · ${channel} · PAPER ONLY | LIVE ORDERS DISABLED]\nSignalID: ${sig.signalId}\n標的: ${sig.symbol} (${sig.exchange})\n狀態: ${sig.smcActionState} (${sig.finalTradeSignal})\n進場參考價: ${sig.entryReferencePrice ?? '等待下一根 K 線開盤'} (SL: ${sig.stopLoss ?? 'N/A'} / TP: ${sig.takeProfit ?? 'N/A'})\n來源: ${sig.source}`;

    const record: NotificationOutboxRecord = {
      notificationId: `outbox_preview_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
      signalId: sig.signalId,
      monitorRunId: sig.monitorRunId,
      scanRunId: sig.scanRunId,
      scanCycleId: sig.scanCycleId ?? null,
      symbol: sig.symbol,
      exchange: sig.exchange,
      channel,
      payload,
      formattedMessage,
      snapshotAt: sig.snapshotAt,
      createdAt: nowIso,
      status: isEligible ? 'PREVIEW_DRY_RUN' : 'NON_CANDIDATE_BLOCKED',
      dedupeKey,
      cooldownUntil: isEligible
        ? new Date(nowMs + this.cooldownMs).toISOString()
        : null,
      blockedReason: isEligible
        ? null
        : sig.statusReason || '訊號未通過完整 SMC 交易候選閘門，攔截預覽通知',
    };

    return this.paperMonitorDb.insertNotificationOutbox(record);
  }

  /**
   * Generates the 24h / 7d / 30d report (Section 五):
   * - If candidate signals exist but none opened yet (`totalSignals > 0, paperOpened = 0, paperClosed = 0`):
   *   `metricStatus = "SIGNALS_PENDING_ENTRY"`, `openSignals >= 1`.
   * - If paper positions opened but none closed yet (`paperOpened > 0, paperClosed = 0`):
   *   `metricStatus = "OPEN_TRADES_NO_CLOSED_RESULTS"`, `openTrades >= 1`.
   * - Only when `totalSignals === 0` (`paperClosed === 0`):
   *   `metricStatus = "NO_TRADES"`.
   * - All unsettled performance metrics (`winRate`, `averageR`, `profitFactor`, `maxDrawdownR`, `expectancyR`, `averageHoldingTime`) stay `null`.
   */
  public buildWindowReport(params: {
    window: PaperMonitorReportWindow;
    exchange: ExchangeId;
    monitorRunId: string;
    scanRunId: string;
    sinceIso?: string;
    untilIso?: string;
    reportAnchorAt?: string;
    nowMs?: number;
  }): PaperMonitorReportResponse {
    const generatedAtMs = params.nowMs ?? Date.now();
    const anchorMs =
      params.reportAnchorAt && Number.isFinite(Date.parse(params.reportAnchorAt))
        ? Date.parse(params.reportAnchorAt)
        : generatedAtMs;
    const durationMs =
      params.window === '90d'
        ? 90 * 24 * 3600_000
        : params.window === '60d'
          ? 60 * 24 * 3600_000
          : params.window === '30d'
            ? 30 * 24 * 3600_000
            : params.window === '7d'
              ? 7 * 24 * 3600_000
              : 24 * 3600_000;

    const windowEndIso =
      params.untilIso && Number.isFinite(Date.parse(params.untilIso))
        ? new Date(Date.parse(params.untilIso)).toISOString()
        : new Date(anchorMs).toISOString();
    const windowEndMs = Date.parse(windowEndIso);
    const windowStartIso =
      params.sinceIso && Number.isFinite(Date.parse(params.sinceIso))
        ? new Date(Date.parse(params.sinceIso)).toISOString()
        : new Date(windowEndMs - durationMs).toISOString();
    const reportGeneratedAt = new Date(generatedAtMs).toISOString();
    const reportAnchorAt = params.reportAnchorAt
      ? new Date(anchorMs).toISOString()
      : windowEndIso;

    const allRecords = this.paperMonitorDb.listTrackedSignals({
      exchange: params.exchange,
      sinceIso: windowStartIso,
      untilIso: windowEndIso,
      includeBlocked: true,
      limit: 5000,
    });

    const smcSnapshot = this.paperMonitorDb.radarDb.getAtomicSmcSnapshot(
      params.exchange,
      anchorMs
    );

    const tradableSignals = allRecords.filter((s) => s.status !== 'BLOCKED');
    const blockedSignals = allRecords.filter((s) => s.status === 'BLOCKED');

    const totalSignals = tradableSignals.length;
    const sampleCount = totalSignals;
    const sampleSufficiency: SampleSufficiencyTier =
      sampleCount < 30
        ? 'INSUFFICIENT'
        : sampleCount < 100
          ? 'LIMITED'
          : 'SUFFICIENT';
    const latestSignalDetectedAt =
      tradableSignals.length > 0
        ? tradableSignals[0].signalDetectedAt || tradableSignals[0].evaluatedAt
        : null;

    const longSignals = tradableSignals.filter(
      (s) => s.direction === 'LONG'
    ).length;
    const shortSignals = tradableSignals.filter(
      (s) => s.direction === 'SHORT'
    ).length;

    const openSignals = tradableSignals.filter(
      (s) => s.status === 'CREATED' || s.status === 'PENDING_NEXT_ENTRY'
    ).length;
    const entryWindowMissed = tradableSignals.filter(
      (s) => s.status === 'ENTRY_WINDOW_MISSED'
    ).length;
    const openTrades = tradableSignals.filter(
      (s) => s.status === 'PAPER_OPENED'
    ).length;

    const paperOpened = tradableSignals.filter(
      (s) =>
        s.status === 'PAPER_OPENED' ||
        s.status === 'PAPER_CLOSED_WIN' ||
        s.status === 'PAPER_CLOSED_LOSS' ||
        s.status === 'PAPER_EXPIRED'
    ).length;

    const winsList = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_WIN'
    );
    const lossesList = tradableSignals.filter(
      (s) => s.status === 'PAPER_CLOSED_LOSS'
    );
    const expiredList = tradableSignals.filter(
      (s) => s.status === 'PAPER_EXPIRED'
    );
    const invalidatedList = tradableSignals.filter(
      (s) => s.status === 'INVALIDATED'
    );

    const closedList = [
      ...winsList,
      ...lossesList,
      ...expiredList,
    ];
    const paperClosed = closedList.length;
    const wins = winsList.length;
    const losses = lossesList.length;
    const expired = expiredList.length;
    const invalidated = invalidatedList.length;
    const blocked = blockedSignals.length;

    const dataStaleCount =
      allRecords.filter((s) => s.stale).length +
      Array.from(smcSnapshot.resultsMap.values()).filter((r) => r.stale).length;
    const fallbackCount =
      allRecords.filter((s) => s.fallback).length +
      Array.from(smcSnapshot.resultsMap.values()).filter((r) => r.fallback)
        .length;
    const pendingCount = smcSnapshot.pendingCount;

    const signalLatency =
      tradableSignals.length > 0
        ? Math.round(
            tradableSignals.reduce(
              (acc, s) => acc + (s.detectionLatencyMs ?? s.signalLatencyMs ?? 0),
              0
            ) / tradableSignals.length
          )
        : null;

    const trades = tradableSignals
      .filter(
        (s) =>
          s.status === 'PAPER_OPENED' ||
          s.status === 'PAPER_CLOSED_WIN' ||
          s.status === 'PAPER_CLOSED_LOSS' ||
          s.status === 'PAPER_EXPIRED'
      )
      .map((s) => ({
        signalId: s.signalId,
        symbol: s.symbol,
        direction: s.direction,
        entryReferencePrice: s.entryReferencePrice,
        entryReferenceTime: s.entryReferenceTime,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        exitPrice: s.exitPrice,
        exitTime: s.exitTime,
        rMultiple: s.riskMultiple,
        status: s.status,
      }));

    if (paperClosed === 0) {
      const unsettledMetricStatus: PaperMetricStatus =
        totalSignals === 0
          ? 'NO_TRADES'
          : paperOpened > 0
            ? 'OPEN_TRADES_NO_CLOSED_RESULTS'
            : openSignals > 0
              ? 'SIGNALS_PENDING_ENTRY'
              : entryWindowMissed > 0
                ? 'ENTRY_WINDOW_MISSED'
                : 'SIGNALS_PENDING_ENTRY';

      const unsettledSampleNotice =
        unsettledMetricStatus === 'ENTRY_WINDOW_MISSED'
          ? '候選訊號原始進場窗口已錯過 (ENTRY_WINDOW_MISSED)，嚴禁回溯使用已錯過開盤價，樣本不足，僅供觀察'
          : unsettledMetricStatus === 'SIGNALS_PENDING_ENTRY'
            ? '已有候選訊號等待下一根 K 線開盤進場 (SIGNALS_PENDING_ENTRY)，樣本不足，僅供觀察'
            : unsettledMetricStatus === 'OPEN_TRADES_NO_CLOSED_RESULTS'
              ? '已有紙上開倉部位持倉中尚未平倉結算 (OPEN_TRADES_NO_CLOSED_RESULTS)，樣本不足，僅供觀察'
              : '樣本不足，僅供觀察';

      return {
        databaseInstanceId: this.paperMonitorDb.radarDb.databaseInstanceId,
        monitorRunId: params.monitorRunId,
        scanRunId: params.scanRunId,
        snapshotAt: new Date(anchorMs).toISOString(),
        reportGeneratedAt,
        reportAnchorAt,
        statsVersion: smcSnapshot.statsVersion,
        mode: 'PAPER ONLY',
        liveOrders: 'LIVE ORDERS DISABLED',
        executionPolicy: 'NEVER AUTO-PLACE ORDERS',
        safety: TRADING_SAFETY_FLAGS,
        window: params.window,
        windowStartAt: windowStartIso,
        windowEndAt: windowEndIso,
        signalDetectedAt: latestSignalDetectedAt,
        scanCycleCompletedAt: smcSnapshot.cycleCompletedAt,
        metricStatus: unsettledMetricStatus,
        sampleCount,
        sampleSufficiency,
        sampleSufficiencyNotice: unsettledSampleNotice,
        totalSignals,
        longSignals,
        shortSignals,
        openSignals,
        openTrades,
        paperOpened,
        paperClosed: 0,
        entryWindowMissed,
        wins: 0,
        losses: 0,
        expired: 0,
        invalidated,
        blocked,
        winRate: null,
        averageR: null,
        profitFactor: null,
        maxDrawdownR: null,
        expectancyR: null,
        averageHoldingTime: null,
        signalLatency,
        dataStaleCount,
        fallbackCount,
        pendingCount,
        trades,
      };
    }

    const rValues = closedList.map((s) => Number(s.riskMultiple ?? 0));
    const totalR = rValues.reduce((a, b) => a + b, 0);
    const averageR = Number((totalR / paperClosed).toFixed(2));
    const expectancyR = averageR;
    const winRate = Number(((wins / paperClosed) * 100).toFixed(1));

    const grossProfitR = rValues
      .filter((r) => r > 0)
      .reduce((a, b) => a + b, 0);
    const grossLossR = Math.abs(
      rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0)
    );
    const profitFactor =
      grossLossR > 0
        ? Number((grossProfitR / grossLossR).toFixed(2))
        : grossProfitR > 0
          ? Number(grossProfitR.toFixed(2))
          : null;

    let cumR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    for (const r of rValues) {
      cumR += r;
      if (cumR > peakR) peakR = cumR;
      const dd = peakR - cumR;
      if (dd > maxDrawdownR) maxDrawdownR = dd;
    }

    const avgHoldMs =
      closedList.reduce((acc, s) => acc + Number(s.holdingTimeMs ?? 900_000), 0) /
      paperClosed;
    const avgHoldMin = Math.round(avgHoldMs / 60_000);
    const averageHoldingTime =
      avgHoldMin >= 60
        ? `${(avgHoldMin / 60).toFixed(1)}h`
        : `${avgHoldMin}m`;

    return {
      databaseInstanceId: this.paperMonitorDb.radarDb.databaseInstanceId,
      monitorRunId: params.monitorRunId,
      scanRunId: params.scanRunId,
      snapshotAt: new Date(anchorMs).toISOString(),
      reportGeneratedAt,
      reportAnchorAt,
      statsVersion: smcSnapshot.statsVersion,
      mode: 'PAPER ONLY',
      liveOrders: 'LIVE ORDERS DISABLED',
      executionPolicy: 'NEVER AUTO-PLACE ORDERS',
      safety: TRADING_SAFETY_FLAGS,
      window: params.window,
      windowStartAt: windowStartIso,
      windowEndAt: windowEndIso,
      signalDetectedAt: latestSignalDetectedAt,
      scanCycleCompletedAt: smcSnapshot.cycleCompletedAt,
      metricStatus: 'READY',
      sampleCount,
      sampleSufficiency,
      sampleSufficiencyNotice:
        sampleSufficiency !== 'SUFFICIENT' || paperClosed < 30
          ? '樣本不足，僅供觀察'
          : '歷史紙上樣本統計，僅供研究觀察',
      totalSignals,
      longSignals,
      shortSignals,
      openSignals,
      openTrades,
      paperOpened,
      paperClosed,
      entryWindowMissed,
      wins,
      losses,
      expired,
      invalidated,
      blocked,
      winRate,
      averageR,
      profitFactor,
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
      expectancyR,
      averageHoldingTime,
      signalLatency,
      dataStaleCount,
      fallbackCount,
      pendingCount,
      trades,
    };
  }
}
