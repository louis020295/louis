import { RadarDatabase } from '../db/RadarDatabase.ts';
import {
  ExternalNotificationChannel,
  ExternalNotificationConfig,
  ExternalNotificationDispatchLog,
  ExternalNotificationEnvReadiness,
  ExternalNotificationSignalTrack,
  ExternalNotificationStatusResponse,
  PositionHealthState,
  PositionSentinelAlert,
  PositionSentinelConfig,
  PositionSentinelSnapshot,
  ScannedCandidate,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

export interface ExternalEnvCredentials {
  telegramBotToken?: string;
  telegramChatId?: string;
  discordWebhookUrl?: string;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

const ALLOWED_DISCORD_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
]);

export function isValidTelegramToken(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{20,120}$/.test(token.trim());
}

export function isValidDiscordWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (!ALLOWED_DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) {
      return false;
    }
    if (!/^\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9._-]{15,200}$/.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class ExternalNotificationService {
  private readonly db: RadarDatabase;
  private readonly fetchImpl: FetchLike;
  private readonly envProvider: () => ExternalEnvCredentials;
  private readonly cooldownMs: number;
  private readonly dedupeWindowMs: number;
  private readonly maxPerMinute: number;

  private readonly dedupeMap = new Map<string, number>();
  private readonly cooldownMap = new Map<string, number>();
  private readonly slidingTimestampsByChannel = new Map<
    ExternalNotificationChannel,
    number[]
  >();

  constructor(params: {
    db: RadarDatabase;
    fetchImpl?: FetchLike;
    envProvider?: () => ExternalEnvCredentials;
    cooldownMs?: number;
    dedupeWindowMs?: number;
    maxPerMinute?: number;
  }) {
    this.db = params.db;
    this.fetchImpl =
      params.fetchImpl ??
      ((url, init) =>
        fetch(url, init) as Promise<{
          ok: boolean;
          status: number;
          text: () => Promise<string>;
        }>);
    this.envProvider =
      params.envProvider ??
      (() => ({
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: process.env.TELEGRAM_CHAT_ID,
        discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      }));
    this.cooldownMs = params.cooldownMs ?? 10 * 60_000;
    this.dedupeWindowMs = params.dedupeWindowMs ?? 30 * 60_000;
    this.maxPerMinute = params.maxPerMinute ?? 6;
  }

  public getEnvReadiness(): ExternalNotificationEnvReadiness {
    const env = this.envProvider();
    const token = (env.telegramBotToken ?? '').trim();
    const chatId = (env.telegramChatId ?? '').trim();
    const discordUrl = (env.discordWebhookUrl ?? '').trim();

    const telegramMissingVars: string[] = [];
    if (!token || !isValidTelegramToken(token)) {
      telegramMissingVars.push('TELEGRAM_BOT_TOKEN');
    }
    if (!chatId) {
      telegramMissingVars.push('TELEGRAM_CHAT_ID');
    }

    const discordMissingVars: string[] = [];
    if (!discordUrl || !isValidDiscordWebhookUrl(discordUrl)) {
      discordMissingVars.push('DISCORD_WEBHOOK_URL');
    }

    return {
      telegramConfigured: telegramMissingVars.length === 0,
      telegramMissingVars,
      discordConfigured: discordMissingVars.length === 0,
      discordMissingVars,
    };
  }

  public getConfig(): ExternalNotificationConfig {
    return this.db.getExternalNotificationConfig();
  }

  public updateConfig(
    patch: Partial<Omit<ExternalNotificationConfig, 'updatedAt'>>
  ): ExternalNotificationStatusResponse {
    this.db.saveExternalNotificationConfig(patch);
    return this.getStatus();
  }

  public getStatus(limit = 40): ExternalNotificationStatusResponse {
    return {
      safety: TRADING_SAFETY_FLAGS,
      config: this.db.getExternalNotificationConfig(),
      envReadiness: this.getEnvReadiness(),
      recentLogs: this.db.listExternalNotificationLogs(limit),
    };
  }

  public async sendTestNotification(
    channel: ExternalNotificationChannel,
    symbol = 'BTCUSDT'
  ): Promise<{
    ok: boolean;
    record: ExternalNotificationDispatchLog;
    status: ExternalNotificationStatusResponse;
  }> {
    const cleanSym = (symbol || 'BTCUSDT').trim().toUpperCase();
    const nowIso = new Date().toISOString();
    const preview = [
      `[TEST_MESSAGE] 加密貨幣全市場行情雷達 · 外部通道連線測試`,
      `通道: ${channel}`,
      `測試標的: ${cleanSym}`,
      `測試時間: ${nowIso}`,
      `安全限制: ${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders} · ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ].join('\n');

    const envCheck = this.getEnvReadiness();
    if (channel === 'TELEGRAM' && !envCheck.telegramConfigured) {
      const record = this.db.recordExternalNotificationLog({
        id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        channel,
        symbol: cleanSym,
        track: 'TEST',
        actionState: 'TEST_PING',
        status: 'SKIPPED_UNCONFIGURED',
        reason: `後端尚未設定有效環境變數: ${envCheck.telegramMissingVars.join(', ')}`,
        httpStatus: null,
        isTest: true,
        messagePreview: preview,
        dedupeKey: null,
        cooldownUntil: null,
        createdAt: nowIso,
      });
      return { ok: false, record, status: this.getStatus() };
    }

    if (channel === 'DISCORD' && !envCheck.discordConfigured) {
      const record = this.db.recordExternalNotificationLog({
        id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        channel,
        symbol: cleanSym,
        track: 'TEST',
        actionState: 'TEST_PING',
        status: 'SKIPPED_UNCONFIGURED',
        reason: `後端尚未設定有效環境變數 (需為官方 https://discord.com/api/webhooks/... 格式): ${envCheck.discordMissingVars.join(', ')}`,
        httpStatus: null,
        isTest: true,
        messagePreview: preview,
        dedupeKey: null,
        cooldownUntil: null,
        createdAt: nowIso,
      });
      return { ok: false, record, status: this.getStatus() };
    }

    const sendRes =
      channel === 'TELEGRAM'
        ? await this.postTelegramMessage(preview)
        : await this.postDiscordWebhook({
            title: `[TEST_MESSAGE] ${cleanSym} · 雷達連線測試成功`,
            description: preview,
            color: 0x38bdf8,
            fields: [
              { name: '模式', value: TRADING_SAFETY_FLAGS.mode, inline: true },
              {
                name: '下單權限',
                value: TRADING_SAFETY_FLAGS.liveOrders,
                inline: true,
              },
            ],
          });

    const record = this.db.recordExternalNotificationLog({
      id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      channel,
      symbol: cleanSym,
      track: 'TEST',
      actionState: 'TEST_PING',
      status: sendRes.ok ? 'DELIVERED' : 'SEND_FAILED',
      reason: sendRes.ok
        ? `測試通知已成功送達 ${channel}`
        : `外部推播失敗 (${sendRes.errorDetail})`,
      httpStatus: sendRes.httpStatus,
      isTest: true,
      messagePreview: preview,
      dedupeKey: null,
      cooldownUntil: null,
      createdAt: nowIso,
    });

    return { ok: sendRes.ok, record, status: this.getStatus() };
  }

  public async dispatchCandidates(params: {
    candidates: ScannedCandidate[];
    mode: 'live' | 'demo';
    isDemo: boolean;
    nowMs?: number;
  }): Promise<ExternalNotificationDispatchLog[]> {
    if (params.mode !== 'live' || params.isDemo) {
      return [];
    }

    const config = this.db.getExternalNotificationConfig();
    if (!config.telegramEnabled && !config.discordEnabled) {
      return [];
    }
    if (!config.notifyFormalSmc && !config.notifyEarlyIgnition) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();
    const readiness = this.getEnvReadiness();
    const activeChannels: ExternalNotificationChannel[] = [];
    if (config.telegramEnabled) activeChannels.push('TELEGRAM');
    if (config.discordEnabled) activeChannels.push('DISCORD');

    const logs: ExternalNotificationDispatchLog[] = [];

    for (const candidate of params.candidates) {
      if (
        !candidate ||
        candidate.provenance?.isDemo ||
        candidate.provenance?.stale ||
        candidate.provenance?.fallback
      ) {
        continue;
      }

      // 1. Formal SMC track
      if (config.notifyFormalSmc && this.isEligibleFormalSmc(candidate)) {
        const message = this.formatFormalSmcMessage(candidate);
        const dedupeSig = `FORMAL_SMC:${candidate.symbol}:${candidate.smcActionState}:${candidate.evidences
          .filter((e) => e.passed)
          .map((e) => e.code)
          .join('|')}`;
        for (const ch of activeChannels) {
          const log = await this.guardAndDeliver({
            channel: ch,
            symbol: candidate.symbol,
            track: 'FORMAL_SMC',
            actionState: candidate.smcActionState,
            dedupeSig,
            message,
            discordTitle: `${
              candidate.smcActionState === 'LONG CANDIDATE'
                ? '🟢 正式 SMC 多頭候選'
                : '🔴 正式 SMC 空頭候選'
            } · ${candidate.symbol}`,
            discordColor:
              candidate.smcActionState === 'LONG CANDIDATE'
                ? 0x10b981
                : 0xf43f5e,
            readiness,
            nowMs,
          });
          logs.push(log);
        }
      }

      // 2. Early Ignition track (independent signature & warning)
      if (
        config.notifyEarlyIgnition &&
        this.isEligibleEarlyIgnition(candidate)
      ) {
        const ign = candidate.earlyIgnition!;
        const message = this.formatEarlyIgnitionMessage(candidate);
        const dedupeSig = `EARLY_IGNITION:${candidate.symbol}:${ign.status}:${ign.tier}:${ign.triggerTimeframe ?? '15m'}`;
        for (const ch of activeChannels) {
          const log = await this.guardAndDeliver({
            channel: ch,
            symbol: candidate.symbol,
            track: 'EARLY_IGNITION',
            actionState: ign.status,
            dedupeSig,
            message,
            discordTitle: `${
              ign.direction === 'LONG'
                ? '⚡ 早鳥起漲多頭'
                : '⚡ 早鳥起漲空頭'
            } · ${candidate.symbol} (${ign.ignitionScore}分)`,
            discordColor: ign.direction === 'LONG' ? 0x0ea5e9 : 0xf59e0b,
            readiness,
            nowMs,
          });
          logs.push(log);
        }
      }
    }

    return logs;
  }

  public async dispatchPositionSentinelAlert(params: {
    position: PositionSentinelSnapshot;
    alert: PositionSentinelAlert;
    sentinelConfig: PositionSentinelConfig;
    escalated: boolean;
    nowMs?: number;
  }): Promise<ExternalNotificationDispatchLog[]> {
    const { position, alert, sentinelConfig, escalated } = params;
    if (position.exchange === 'demo_synthetic' || position.provenance?.isDemo) {
      return [];
    }

    const minRank = sentinelConfig.notifyMinSeverity === 'CRITICAL' ? 2 : 1;
    const alertRank =
      alert.severity === 'CRITICAL' ? 2 : alert.severity === 'WARNING' ? 1 : 0;
    if (alertRank < minRank) {
      return [];
    }

    const globalConfig = this.db.getExternalNotificationConfig();
    const activeChannels: ExternalNotificationChannel[] = [];
    if (globalConfig.telegramEnabled && sentinelConfig.notifyTelegram) {
      activeChannels.push('TELEGRAM');
    }
    if (globalConfig.discordEnabled && sentinelConfig.notifyDiscord) {
      activeChannels.push('DISCORD');
    }
    if (activeChannels.length === 0) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();
    const readiness = this.getEnvReadiness();
    const healthBadge =
      alert.healthState === 'THESIS_BROKEN'
        ? '🔴 趨勢失效 / 結構反轉'
        : alert.healthState === 'EARLY_REVERSAL'
          ? '🟠 早期反轉 / 劇烈異動'
          : alert.healthState === 'MOMENTUM_FADING'
            ? '🟡 動能轉弱 / 逼近防線'
            : '🟢 趨勢延續';

    const pnlStr = `${position.unrealizedPnlPercent >= 0 ? '+' : ''}${position.unrealizedPnlPercent.toFixed(2)}% (${position.unrealizedPnlR >= 0 ? '+' : ''}${position.unrealizedPnlR.toFixed(2)}R)`;
    const defenseLine =
      alert.suggestedDefensePrice !== null
        ? `建議移動防守位 (僅供參考): ${alert.suggestedDefensePrice}`
        : `當前追蹤失效價 (SL): ${position.invalidationPrice}`;

    const message = [
      `【持倉趨勢哨兵 · ${healthBadge}】${position.symbol} (${position.side} · ${position.exchange})`,
      `觸發事件: ${alert.titleZh} (${alert.confirmedClose ? '已收盤確認' : '盤中即時預警'})`,
      `明細: ${alert.detailZh}`,
      `現價: ${position.currentPrice} | 進場價: ${position.entryPrice} | 浮動損益: ${pnlStr}`,
      defenseLine,
      `安全宣告: ${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders} · ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ].join('\n');

    const discordColor =
      alert.severity === 'CRITICAL'
        ? 0xf43f5e
        : alert.severity === 'WARNING'
          ? 0xf59e0b
          : 0x10b981;

    const logs: ExternalNotificationDispatchLog[] = [];
    const customCooldownMs = sentinelConfig.alertCooldownMs;

    for (const ch of activeChannels) {
      const cooldownKey = `${ch}:POSITION_SENTINEL:${position.id}:${alert.eventType}`;
      const dedupeKey = `${ch}:POSITION_SENTINEL:${position.id}:${alert.healthState}:${alert.eventType}`;
      const prevCooldown = this.cooldownMap.get(cooldownKey);

      if (
        !escalated &&
        prevCooldown !== undefined &&
        nowMs - prevCooldown < customCooldownMs
      ) {
        logs.push(
          this.db.recordExternalNotificationLog({
            id: `ext_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
            channel: ch,
            symbol: position.symbol,
            track: 'POSITION_SENTINEL',
            actionState: `${alert.healthState}:${alert.eventType}`,
            status: 'COOLDOWN_BLOCKED',
            reason: `持倉警報冷卻中 (${Math.round(customCooldownMs / 1000)}s)，未升級不重複洗版`,
            httpStatus: null,
            isTest: false,
            messagePreview: message,
            dedupeKey,
            cooldownUntil: new Date(prevCooldown + customCooldownMs).toISOString(),
            createdAt: new Date(nowMs).toISOString(),
          })
        );
        continue;
      }

      if (escalated) {
        // Clear previous dedupe/cooldown so escalation alerts always deliver immediately
        this.dedupeMap.delete(dedupeKey);
        this.cooldownMap.delete(cooldownKey);
      }

      const log = await this.guardAndDeliver({
        channel: ch,
        symbol: position.symbol,
        track: 'POSITION_SENTINEL',
        actionState: `${alert.healthState}:${alert.eventType}`,
        dedupeSig: `POSITION_SENTINEL:${position.id}:${alert.healthState}:${alert.eventType}:${escalated ? nowMs : Math.floor(nowMs / customCooldownMs)}`,
        message,
        discordTitle: `${healthBadge} · ${position.symbol} ${position.side}`,
        discordColor,
        readiness,
        nowMs,
        bypassCooldown: true,
      });
      this.cooldownMap.set(cooldownKey, nowMs);
      logs.push(log);
    }

    return logs;
  }

  public async dispatchSystemWatchdogAlert(params: {
    eventType:
      | 'HEARTBEAT'
      | 'AUTO_BACKUP'
      | 'WORKER_STALL'
      | 'DB_RECOVERY'
      | 'API_ERROR_SPIKE';
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    titleZh: string;
    messageZh: string;
    nowMs?: number;
  }): Promise<ExternalNotificationDispatchLog[]> {
    const globalConfig = this.db.getExternalNotificationConfig();
    const readiness = this.getEnvReadiness();
    const activeChannels: ExternalNotificationChannel[] = [];
    if (globalConfig.telegramEnabled && readiness.telegramConfigured) {
      activeChannels.push('TELEGRAM');
    }
    if (globalConfig.discordEnabled && readiness.discordConfigured) {
      activeChannels.push('DISCORD');
    }
    if (activeChannels.length === 0) {
      return [];
    }

    const nowMs = params.nowMs ?? Date.now();
    const badge =
      params.severity === 'CRITICAL'
        ? '🔴 系統嚴重告警'
        : params.severity === 'WARNING'
          ? '🟠 系統異常預警'
          : '🟢 系統運作心跳';

    const message = [
      `【7×24 Watchdog · ${badge}】${params.titleZh}`,
      params.messageZh,
      `時間: ${new Date(nowMs).toISOString()}`,
      `安全宣告: ${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders} · ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ].join('\n');

    const discordColor =
      params.severity === 'CRITICAL'
        ? 0xf43f5e
        : params.severity === 'WARNING'
          ? 0xf59e0b
          : 0x10b981;

    const logs: ExternalNotificationDispatchLog[] = [];
    const windowBucket =
      params.eventType === 'HEARTBEAT' || params.eventType === 'AUTO_BACKUP'
        ? nowMs
        : Math.floor(nowMs / (15 * 60_000));

    for (const ch of activeChannels) {
      const log = await this.guardAndDeliver({
        channel: ch,
        symbol: 'SYSTEM',
        track: 'SYSTEM_WATCHDOG',
        actionState: `${params.severity}:${params.eventType}`,
        dedupeSig: `SYSTEM_WATCHDOG:${params.eventType}:${windowBucket}`,
        message,
        discordTitle: `${badge} · ${params.titleZh}`,
        discordColor,
        readiness,
        nowMs,
        bypassCooldown: true,
      });
      logs.push(log);
    }

    return logs;
  }

  private isEligibleFormalSmc(c: ScannedCandidate): boolean {
    if (c.smcEvaluationStatus !== 'EVALUATED') return false;
    if (c.gates?.smc?.waitReasons && c.gates.smc.waitReasons.length > 0) {
      return false;
    }
    return (
      (c.smcActionState === 'LONG CANDIDATE' &&
        c.finalTradeSignal === '多頭交易候選') ||
      (c.smcActionState === 'SHORT CANDIDATE' &&
        c.finalTradeSignal === '空頭交易候選')
    );
  }

  private isEligibleEarlyIgnition(c: ScannedCandidate): boolean {
    if (c.isLowLiquidity) return false;
    if (!(c.lastPrice > 0)) return false;
    const ign = c.earlyIgnition;
    if (!ign) return false;
    return ign.status === 'IGNITION_LONG' || ign.status === 'IGNITION_SHORT';
  }

  private formatFormalSmcMessage(c: ScannedCandidate): string {
    const passed = c.evidences
      .filter((e) => e.passed)
      .slice(0, 5)
      .map((e) => `• ${e.label}: ${e.value}`)
      .join('\n');
    const zone = c.entryZoneSummary;
    const zoneLine =
      zone && zone.idealPullbackEntry !== null
        ? `回踩區間參考: ${zone.status} | 掛單參考價 ${zone.idealPullbackEntry}`
        : `當前最新價: ${c.lastPrice}`;
    return [
      `【正式 SMC 多週期共振候選】${c.symbol}`,
      `方向狀態: ${c.smcActionState} (${c.finalCategory}) | Score: ${c.score}/100`,
      `現價: ${c.lastPrice} | 24h: ${c.priceChangePercent24h >= 0 ? '+' : ''}${c.priceChangePercent24h.toFixed(2)}%`,
      zoneLine,
      passed ? `已確認結構證據:\n${passed}` : '',
      `來源: ${c.provenance.source} (${c.provenance.fetchedAt})`,
      `安全宣告: ${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders} · ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatEarlyIgnitionMessage(c: ScannedCandidate): string {
    const ign = c.earlyIgnition!;
    return [
      `【早鳥起漲獵手 · 獨立軌道 (尚未等待 1h/4h 共振)】${c.symbol}`,
      `訊號: ${ign.status} (${ign.tier}) | 評分: ${ign.ignitionScore}/100`,
      `摘要: ${ign.headlineZh}`,
      `現價: ${c.lastPrice} | 嚴格結構止損參考: ${ign.invalidationPrice ?? '待計算'} (${ign.invalidationLabel ?? '結構極值'})`,
      `提示: ${ign.riskWarningZh}`,
      `來源: ${c.provenance.source} (${c.provenance.fetchedAt})`,
      `安全宣告: ${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders} · ${TRADING_SAFETY_FLAGS.executionPolicy}`,
    ].join('\n');
  }

  private async guardAndDeliver(params: {
    channel: ExternalNotificationChannel;
    symbol: string;
    track: Exclude<ExternalNotificationSignalTrack, 'TEST'>;
    actionState: string;
    dedupeSig: string;
    message: string;
    discordTitle: string;
    discordColor: number;
    readiness: ExternalNotificationEnvReadiness;
    nowMs: number;
    bypassCooldown?: boolean;
  }): Promise<ExternalNotificationDispatchLog> {
    const nowIso = new Date(params.nowMs).toISOString();
    const dedupeKey = `${params.channel}:${params.dedupeSig}`;
    const cooldownKey = `${params.channel}:${params.track}:${params.symbol}`;

    // Check credentials readiness
    if (params.channel === 'TELEGRAM' && !params.readiness.telegramConfigured) {
      return this.db.recordExternalNotificationLog({
        id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: params.channel,
        symbol: params.symbol,
        track: params.track,
        actionState: params.actionState,
        status: 'SKIPPED_UNCONFIGURED',
        reason: `Telegram 已開啟但環境變數未設定 (${params.readiness.telegramMissingVars.join(', ')})`,
        httpStatus: null,
        isTest: false,
        messagePreview: params.message,
        dedupeKey,
        cooldownUntil: null,
        createdAt: nowIso,
      });
    }
    if (params.channel === 'DISCORD' && !params.readiness.discordConfigured) {
      return this.db.recordExternalNotificationLog({
        id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: params.channel,
        symbol: params.symbol,
        track: params.track,
        actionState: params.actionState,
        status: 'SKIPPED_UNCONFIGURED',
        reason: `Discord 已開啟但環境變數未設定 (${params.readiness.discordMissingVars.join(', ')})`,
        httpStatus: null,
        isTest: false,
        messagePreview: params.message,
        dedupeKey,
        cooldownUntil: null,
        createdAt: nowIso,
      });
    }

    // Check Deduplication
    const prevDedupe = this.dedupeMap.get(dedupeKey);
    if (
      prevDedupe !== undefined &&
      params.nowMs - prevDedupe < this.dedupeWindowMs
    ) {
      return this.db.recordExternalNotificationLog({
        id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: params.channel,
        symbol: params.symbol,
        track: params.track,
        actionState: params.actionState,
        status: 'DEDUPED_BLOCKED',
        reason: `相同軌道與結構簽章於去重時間窗內已推播，略過重複發送`,
        httpStatus: null,
        isTest: false,
        messagePreview: params.message,
        dedupeKey,
        cooldownUntil: null,
        createdAt: nowIso,
      });
    }

    // Check Cooldown per (channel, track, symbol)
    const prevCooldown = this.cooldownMap.get(cooldownKey);
    if (
      !params.bypassCooldown &&
      prevCooldown !== undefined &&
      params.nowMs - prevCooldown < this.cooldownMs
    ) {
      const cooldownUntil = new Date(
        prevCooldown + this.cooldownMs
      ).toISOString();
      return this.db.recordExternalNotificationLog({
        id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: params.channel,
        symbol: params.symbol,
        track: params.track,
        actionState: params.actionState,
        status: 'COOLDOWN_BLOCKED',
        reason: `${params.symbol} (${params.track}) 仍在冷卻期內，防止重複洗版`,
        httpStatus: null,
        isTest: false,
        messagePreview: params.message,
        dedupeKey,
        cooldownUntil,
        createdAt: nowIso,
      });
    }

    // Check Rate Limit per channel
    const timestamps = this.slidingTimestampsByChannel.get(params.channel) ?? [];
    while (timestamps.length > 0 && params.nowMs - timestamps[0] > 60_000) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxPerMinute) {
      this.slidingTimestampsByChannel.set(params.channel, timestamps);
      return this.db.recordExternalNotificationLog({
        id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        channel: params.channel,
        symbol: params.symbol,
        track: params.track,
        actionState: params.actionState,
        status: 'RATE_LIMITED_BLOCKED',
        reason: `${params.channel} 超過每分鐘推播上限 (${this.maxPerMinute} 則/分鐘)`,
        httpStatus: null,
        isTest: false,
        messagePreview: params.message,
        dedupeKey,
        cooldownUntil: null,
        createdAt: nowIso,
      });
    }

    timestamps.push(params.nowMs);
    this.slidingTimestampsByChannel.set(params.channel, timestamps);
    this.dedupeMap.set(dedupeKey, params.nowMs);
    this.cooldownMap.set(cooldownKey, params.nowMs);
    const cooldownUntil = new Date(
      params.nowMs + this.cooldownMs
    ).toISOString();

    const sendRes =
      params.channel === 'TELEGRAM'
        ? await this.postTelegramMessage(params.message)
        : await this.postDiscordWebhook({
            title: params.discordTitle,
            description: params.message,
            color: params.discordColor,
            fields: [
              { name: '軌道', value: params.track, inline: true },
              { name: '狀態', value: params.actionState, inline: true },
            ],
          });

    return this.db.recordExternalNotificationLog({
      id: `ext_${params.nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      channel: params.channel,
      symbol: params.symbol,
      track: params.track,
      actionState: params.actionState,
      status: sendRes.ok ? 'DELIVERED' : 'SEND_FAILED',
      reason: sendRes.ok
        ? `已成功推播至 ${params.channel}`
        : `外部推播失敗 (${sendRes.errorDetail})`,
      httpStatus: sendRes.httpStatus,
      isTest: false,
      messagePreview: params.message,
      dedupeKey,
      cooldownUntil,
      createdAt: nowIso,
    });
  }

  private async postTelegramMessage(text: string): Promise<{
    ok: boolean;
    httpStatus: number | null;
    errorDetail: string;
  }> {
    const env = this.envProvider();
    const token = (env.telegramBotToken ?? '').trim();
    const chatId = (env.telegramChatId ?? '').trim();
    if (!isValidTelegramToken(token) || !chatId) {
      return {
        ok: false,
        httpStatus: null,
        errorDetail: 'Telegram 環境變數格式無效或缺失',
      };
    }

    const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      const resp = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        return {
          ok: false,
          httpStatus: resp.status,
          errorDetail: `HTTP ${resp.status} ${bodyText.slice(0, 120)}`,
        };
      }
      return { ok: true, httpStatus: resp.status, errorDetail: '' };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        errorDetail:
          err instanceof Error ? err.message : 'Telegram 網路連線失敗',
      };
    }
  }

  private async postDiscordWebhook(embed: {
    title: string;
    description: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  }): Promise<{
    ok: boolean;
    httpStatus: number | null;
    errorDetail: string;
  }> {
    const env = this.envProvider();
    const webhookUrl = (env.discordWebhookUrl ?? '').trim();
    if (!isValidDiscordWebhookUrl(webhookUrl)) {
      return {
        ok: false,
        httpStatus: null,
        errorDetail: 'Discord Webhook URL 未設定或網域不符官方格式',
      };
    }

    try {
      const resp = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'CryptoMarketRadar (PAPER ONLY)',
          embeds: [
            {
              title: embed.title.slice(0, 240),
              description: embed.description.slice(0, 3800),
              color: embed.color,
              fields: embed.fields ?? [],
              footer: {
                text: `${TRADING_SAFETY_FLAGS.mode} · ${TRADING_SAFETY_FLAGS.liveOrders}`,
              },
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        return {
          ok: false,
          httpStatus: resp.status,
          errorDetail: `HTTP ${resp.status} ${bodyText.slice(0, 120)}`,
        };
      }
      return { ok: true, httpStatus: resp.status, errorDetail: '' };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        errorDetail:
          err instanceof Error ? err.message : 'Discord 網路連線失敗',
      };
    }
  }
}
