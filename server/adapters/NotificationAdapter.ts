import {
  NotificationDispatchRecord,
  NotificationPayload,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export interface NotificationAdapter {
  readonly channel: 'TELEGRAM' | 'TRADINGVIEW_WEBHOOK';
  formatPayload(payload: NotificationPayload): string;
  dispatchPreview(
    payload: NotificationPayload
  ): Promise<NotificationDispatchRecord>;
}

export interface NotificationGuardConfig {
  cooldownMs: number;
  maxPerMinute: number;
  dedupeWindowMs: number;
}

const DEFAULT_GUARD_CONFIG: NotificationGuardConfig = {
  cooldownMs: 5 * 60 * 1000, // 5 minutes per symbol per channel
  maxPerMinute: 6, // Max 6 notifications per rolling 60s
  dedupeWindowMs: 30 * 60 * 1000, // 30 minutes identical signature dedupe
};

export class NotificationGuardEngine {
  private readonly config: NotificationGuardConfig;
  private readonly dedupeMap = new Map<string, number>();
  private readonly cooldownMap = new Map<string, number>();
  private readonly slidingWindowTimestamps: number[] = [];
  private readonly history: NotificationDispatchRecord[] = [];

  constructor(config: Partial<NotificationGuardConfig> = {}) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
  }

  public evaluateAndRecord(
    adapter: NotificationAdapter,
    payload: NotificationPayload,
    nowMs = Date.now()
  ): NotificationDispatchRecord {
    const formattedMessage = adapter.formatPayload(payload);
    const resolvedFinalSignal =
      payload.finalTradeSignal ??
      (payload.actionState === 'LONG CANDIDATE' &&
      payload.category === '多頭候選'
        ? '多頭交易候選'
        : payload.actionState === 'SHORT CANDIDATE' &&
            payload.category === '空頭候選'
          ? '空頭交易候選'
          : 'NONE');

    const nowIso = new Date(nowMs).toISOString();
    const ruleVersion = payload.ruleVersion ?? '2.2.0-smc-BatchQueue+2.2.0-twoLayer-RadarSmc';
    const scanRunId = payload.scanRunId ?? `scan_live_${nowMs}`;
    const snapshotAt = payload.snapshotAt ?? payload.fetchedAt ?? nowIso;
    const evaluatedAt = payload.evaluatedAt ?? payload.fetchedAt ?? nowIso;
    const signalId =
      payload.signalId ??
      `sig_${payload.symbol}_${payload.actionState.replace(/\s+/g, '_')}_${ruleVersion}_${evaluatedAt}`;
    const dedupeSignature =
      payload.dedupeKey ??
      `${adapter.channel}:${payload.symbol}:${payload.category}:${payload.actionState}:${ruleVersion}:${payload.confirmedEvidences.join('|')}`;
    const cooldownKey = `${adapter.channel}:${payload.symbol}`;
    const existingCooldownStart = this.cooldownMap.get(cooldownKey);
    const computedCooldownUntil =
      payload.cooldownUntil ??
      new Date(
        (existingCooldownStart !== undefined &&
        nowMs - existingCooldownStart < this.config.cooldownMs
          ? existingCooldownStart
          : nowMs) + this.config.cooldownMs
      ).toISOString();

    // 0. Strict Candidate Safety Gate: Dry-Run notification ONLY processes when ALL conditions hold:
    // - isBacktest !== true (Backtest data must NEVER trigger live/formal notifications)
    // - smcEvaluationStatus === 'EVALUATED' (or not PENDING)
    // - actionState === 'LONG CANDIDATE' or 'SHORT CANDIDATE'
    // - finalTradeSignal !== 'NONE'
    // - stale === false (not expired)
    // - fallback === false
    // - no WAIT Gate (waitReasons empty)
    const hasWaitGate =
      Array.isArray(payload.waitReasons) && payload.waitReasons.length > 0;
    const isStale = payload.stale === true;
    const isFallback = payload.fallback === true;
    const isBacktest = payload.isBacktest === true;

    if (
      isBacktest ||
      payload.smcEvaluationStatus === 'PENDING' ||
      payload.actionState === 'PENDING' ||
      payload.actionState === 'WAIT' ||
      payload.actionState === 'WATCH' ||
      payload.actionState === 'HIGH RISK' ||
      (payload.actionState !== 'LONG CANDIDATE' &&
        payload.actionState !== 'SHORT CANDIDATE') ||
      (resolvedFinalSignal !== '多頭交易候選' &&
        resolvedFinalSignal !== '空頭交易候選') ||
      isStale ||
      isFallback ||
      hasWaitGate
    ) {
      const blockReasonDetail = isBacktest
        ? '回測模式訊號 (isBacktest=true) 嚴禁觸發正式或即時通知'
        : isStale
          ? '資料已過期 (stale=true)'
          : isFallback
            ? '使用了降級資料 (fallback=true)'
            : hasWaitGate
              ? `仍存在 WAIT Gate (${payload.waitReasons!.join('；')})`
              : `SMC 狀態為 ${payload.actionState} (finalTradeSignal=${resolvedFinalSignal})`;

      const record: NotificationDispatchRecord = {
        id: `notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: adapter.channel,
        symbol: payload.symbol,
        actionState: payload.actionState,
        finalTradeSignal: resolvedFinalSignal,
        category: payload.category,
        score: payload.score,
        status: 'NON_CANDIDATE_BLOCKED',
        reason: `通知安全閘門攔截：${blockReasonDetail}，通知 Dry-Run 僅允許處理已評估完成、無 WAIT Gate、未過期且 fallback=false 之「多頭交易候選 (LONG CANDIDATE)」或「空頭交易候選 (SHORT CANDIDATE)」，不得處理 PENDING / WAIT / WATCH / HIGH RISK`,
        formattedMessage,
        createdAt: nowIso,
        sourceTimestamp: payload.fetchedAt,
        scanRunId,
        signalId,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        dedupeKey: dedupeSignature,
        cooldownUntil: computedCooldownUntil,
      };
      this.pushHistory(record);
      return record;
    }

    // 1. Clean expired sliding window timestamps
    while (
      this.slidingWindowTimestamps.length > 0 &&
      nowMs - this.slidingWindowTimestamps[0] > 60_000
    ) {
      this.slidingWindowTimestamps.shift();
    }

    // 2. Check Rate Limit
    if (this.slidingWindowTimestamps.length >= this.config.maxPerMinute) {
      const record: NotificationDispatchRecord = {
        id: `notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: adapter.channel,
        symbol: payload.symbol,
        actionState: payload.actionState,
        finalTradeSignal: resolvedFinalSignal,
        category: payload.category,
        score: payload.score,
        status: 'RATE_LIMITED_BLOCKED',
        reason: `超過每分鐘發送上限 (${this.config.maxPerMinute} 則/分鐘)，已觸發 Rate Limit 攔截`,
        formattedMessage,
        createdAt: nowIso,
        sourceTimestamp: payload.fetchedAt,
        scanRunId,
        signalId,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        dedupeKey: dedupeSignature,
        cooldownUntil: computedCooldownUntil,
      };
      this.pushHistory(record);
      return record;
    }

    // 3. Check Deduplication
    const lastDedupeTime = this.dedupeMap.get(dedupeSignature);
    if (
      lastDedupeTime !== undefined &&
      nowMs - lastDedupeTime < this.config.dedupeWindowMs
    ) {
      const record: NotificationDispatchRecord = {
        id: `notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: adapter.channel,
        symbol: payload.symbol,
        actionState: payload.actionState,
        finalTradeSignal: resolvedFinalSignal,
        category: payload.category,
        score: payload.score,
        status: 'DEDUPED_BLOCKED',
        reason: '相同幣種、分類、SMC 狀態與證據組合於去重時間窗內已存在，攔截重複通知',
        formattedMessage,
        createdAt: nowIso,
        sourceTimestamp: payload.fetchedAt,
        scanRunId,
        signalId,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        dedupeKey: dedupeSignature,
        cooldownUntil: computedCooldownUntil,
      };
      this.pushHistory(record);
      return record;
    }

    // 4. Check Cooldown per symbol
    const lastSymbolTime = this.cooldownMap.get(cooldownKey);
    if (
      lastSymbolTime !== undefined &&
      nowMs - lastSymbolTime < this.config.cooldownMs
    ) {
      const remainingSec = Math.ceil(
        (this.config.cooldownMs - (nowMs - lastSymbolTime)) / 1000
      );
      const record: NotificationDispatchRecord = {
        id: `notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: adapter.channel,
        symbol: payload.symbol,
        actionState: payload.actionState,
        finalTradeSignal: resolvedFinalSignal,
        category: payload.category,
        score: payload.score,
        status: 'COOLDOWN_BLOCKED',
        reason: `${payload.symbol} 處於冷卻時間內 (剩餘 ${remainingSec} 秒)，防止頻繁洗版`,
        formattedMessage,
        createdAt: nowIso,
        sourceTimestamp: payload.fetchedAt,
        scanRunId,
        signalId,
        ruleVersion,
        snapshotAt,
        evaluatedAt,
        dedupeKey: dedupeSignature,
        cooldownUntil: new Date(
          lastSymbolTime + this.config.cooldownMs
        ).toISOString(),
      };
      this.pushHistory(record);
      return record;
    }

    // Passed all guards -> Phase 1 dry-run preview
    this.slidingWindowTimestamps.push(nowMs);
    this.dedupeMap.set(dedupeSignature, nowMs);
    this.cooldownMap.set(cooldownKey, nowMs);

    const activeCooldownUntil = new Date(
      nowMs + this.config.cooldownMs
    ).toISOString();

    const record: NotificationDispatchRecord = {
      id: `notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      channel: adapter.channel,
      symbol: payload.symbol,
      actionState: payload.actionState,
      finalTradeSignal: resolvedFinalSignal,
      category: payload.category,
      score: payload.score,
      status: 'PREVIEW_DRY_RUN',
      reason:
        '第一階段 Dry-Run 模式：通過最終交易候選確認 (finalTradeSignal) 與 Dedupe、Cooldown、Rate Limit 檢查（僅產生預覽，未對外自動推播）',
      formattedMessage,
      createdAt: nowIso,
      sourceTimestamp: payload.fetchedAt,
      scanRunId,
      signalId,
      ruleVersion,
      snapshotAt,
      evaluatedAt,
      dedupeKey: dedupeSignature,
      cooldownUntil: activeCooldownUntil,
    };
    this.pushHistory(record);
    return record;
  }

  public getHistory(): NotificationDispatchRecord[] {
    return [...this.history];
  }

  private pushHistory(record: NotificationDispatchRecord) {
    this.history.unshift(record);
    if (this.history.length > 50) {
      this.history.pop();
    }
  }
}

export class TelegramNotificationAdapter implements NotificationAdapter {
  public readonly channel = 'TELEGRAM' as const;
  private readonly guard: NotificationGuardEngine;

  constructor(guard: NotificationGuardEngine) {
    this.guard = guard;
  }

  public formatPayload(payload: NotificationPayload): string {
    const evidencesList =
      payload.confirmedEvidences.length > 0
        ? payload.confirmedEvidences.map((e) => `  • ${e}`).join('\n')
        : '  • 尚無通過之確認條件';

    const missingList =
      payload.missingData.length > 0
        ? payload.missingData.join(', ')
        : '無缺失欄位';

    const riskList =
      payload.riskWarnings.length > 0
        ? payload.riskWarnings.map((r) => `  • ${r}`).join('\n')
        : '  • 標準波動風險';

    return [
      `【加密貨幣全市場行情雷達 · 結構觀察通知】`,
      `幣種: ${payload.symbol}`,
      `全市場分類: ${payload.category} (Score: ${payload.score}/100)`,
      `SMC/ICT 狀態: ${payload.actionState}`,
      `已確認 Evidence:`,
      evidencesList,
      `風險與資料缺失提示:`,
      `  • 缺失資料: ${missingList}`,
      riskList,
      `資料來源: ${payload.source}`,
      `資料時間: ${payload.fetchedAt}`,
      `安全宣告: ${TRADING_SAFETY_FLAGS.mode} | ${TRADING_SAFETY_FLAGS.liveOrders} | ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ].join('\n');
  }

  public async dispatchPreview(
    payload: NotificationPayload
  ): Promise<NotificationDispatchRecord> {
    return this.guard.evaluateAndRecord(this, payload);
  }
}

export class TradingViewWebhookAdapter implements NotificationAdapter {
  public readonly channel = 'TRADINGVIEW_WEBHOOK' as const;
  private readonly guard: NotificationGuardEngine;

  constructor(guard: NotificationGuardEngine) {
    this.guard = guard;
  }

  public formatPayload(payload: NotificationPayload): string {
    // Strictly limited to allowed observational fields; no order execution or TP/SL fields allowed
    const safeWebhookObject = {
      schemaVersion: '1.0.0-observation-only',
      symbol: payload.symbol,
      category: payload.category,
      score: payload.score,
      state: payload.actionState,
      confirmedEvidences: payload.confirmedEvidences,
      missingData: payload.missingData,
      riskWarnings: payload.riskWarnings,
      source: payload.source,
      fetchedAt: payload.fetchedAt,
      safety: TRADING_SAFETY_FLAGS,
    };
    return JSON.stringify(safeWebhookObject, null, 2);
  }

  public async dispatchPreview(
    payload: NotificationPayload
  ): Promise<NotificationDispatchRecord> {
    return this.guard.evaluateAndRecord(this, payload);
  }
}
