import React from 'react';
import { Bell, CheckCircle2, Send, ShieldAlert } from 'lucide-react';
import {
  ExternalNotificationChannel,
  ExternalNotificationStatusResponse,
} from '../types/market.ts';

interface ExternalNotificationPanelProps {
  status: ExternalNotificationStatusResponse | null;
  loading: boolean;
  testingChannel: ExternalNotificationChannel | null;
  testFeedback: {
    channel: ExternalNotificationChannel;
    ok: boolean;
    message: string;
  } | null;
  selectedSymbol: string;
  onUpdateConfig: (patch: {
    telegramEnabled?: boolean;
    discordEnabled?: boolean;
    notifyFormalSmc?: boolean;
    notifyEarlyIgnition?: boolean;
  }) => void;
  onSendTest: (channel: ExternalNotificationChannel) => void;
}

export const ExternalNotificationPanel: React.FC<
  ExternalNotificationPanelProps
> = ({
  status,
  loading,
  testingChannel,
  testFeedback,
  selectedSymbol,
  onUpdateConfig,
  onSendTest,
}) => {
  const cfg = status?.config ?? {
    telegramEnabled: false,
    discordEnabled: false,
    notifyFormalSmc: true,
    notifyEarlyIgnition: true,
    updatedAt: '',
  };
  const env = status?.envReadiness ?? {
    telegramConfigured: false,
    telegramMissingVars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    discordConfigured: false,
    discordMissingVars: ['DISCORD_WEBHOOK_URL'],
  };
  const logs = status?.recentLogs ?? [];

  return (
    <div
      id="external-notifications-panel"
      className="border border-slate-800 bg-slate-950 p-4 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Bell className="h-4 w-4 text-sky-400 shrink-0" />
            <span>外部通知串接控制台 (Telegram Bot · Discord Webhook)</span>
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>敏感金鑰僅存於後端環境變數</span>
            <span aria-hidden="true">·</span>
            <span>僅限 Live 訊號觸發</span>
            <span aria-hidden="true">·</span>
            <span>PAPER ONLY · 絕不自動下單</span>
          </div>
        </div>
      </div>

      {/* Channel Controls (2 flat peer cards) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Telegram */}
        <div className="border border-slate-800 bg-slate-900/40 p-3.5 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-100">
                Telegram Bot 推播
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                {env.telegramConfigured ? (
                  <span className="text-emerald-400">
                    後端環境變數已就緒 (TOKEN / CHAT_ID)
                  </span>
                ) : (
                  <span className="text-amber-300">
                    尚未設定: {env.telegramMissingVars.join(', ')}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={loading}
              onClick={() =>
                onUpdateConfig({ telegramEnabled: !cfg.telegramEnabled })
              }
              className={`rounded px-2.5 py-1 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 ${
                cfg.telegramEnabled
                  ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {cfg.telegramEnabled ? '已啟用外發' : '已停用'}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              官方 API 端點直連 · 10 分鐘同軌冷卻
            </span>
            <button
              type="button"
              disabled={loading || testingChannel !== null}
              onClick={() => onSendTest('TELEGRAM')}
              className="flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-950/30 px-2.5 py-1 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Send className="h-3 w-3 shrink-0" />
              <span>
                {testingChannel === 'TELEGRAM'
                  ? '發送測試中...'
                  : `發送測試通知 (${selectedSymbol})`}
              </span>
            </button>
          </div>
        </div>

        {/* Discord */}
        <div className="border border-slate-800 bg-slate-900/40 p-3.5 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-100">
                Discord Webhook 推播
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                {env.discordConfigured ? (
                  <span className="text-emerald-400">
                    後端環境變數已就緒 (DISCORD_WEBHOOK_URL)
                  </span>
                ) : (
                  <span className="text-amber-300">
                    尚未設定: {env.discordMissingVars.join(', ')}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={loading}
              onClick={() =>
                onUpdateConfig({ discordEnabled: !cfg.discordEnabled })
              }
              className={`rounded px-2.5 py-1 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 ${
                cfg.discordEnabled
                  ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-950 border border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {cfg.discordEnabled ? '已啟用外發' : '已停用'}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              限官方 discord.com Webhook · 卡片式推播
            </span>
            <button
              type="button"
              disabled={loading || testingChannel !== null}
              onClick={() => onSendTest('DISCORD')}
              className="flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-950/30 px-2.5 py-1 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Send className="h-3 w-3 shrink-0" />
              <span>
                {testingChannel === 'DISCORD'
                  ? '發送測試中...'
                  : `發送測試通知 (${selectedSymbol})`}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Trigger Event Subscriptions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-800 bg-slate-900/30 px-3.5 py-2.5 text-xs">
        <span className="text-slate-300 font-medium">
          觸發外推事件訂閱（兩軌獨立冷卻與去重，互不覆蓋）：
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onUpdateConfig({ notifyFormalSmc: !cfg.notifyFormalSmc })
            }
            className={`rounded px-2.5 py-1 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              cfg.notifyFormalSmc
                ? 'border border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                : 'border border-slate-700 bg-slate-950 text-slate-400'
            }`}
          >
            {cfg.notifyFormalSmc ? '✓ 正式 SMC 候選' : '正式 SMC 候選 (關)'}
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onUpdateConfig({ notifyEarlyIgnition: !cfg.notifyEarlyIgnition })
            }
            className={`rounded px-2.5 py-1 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              cfg.notifyEarlyIgnition
                ? 'border border-sky-500/50 bg-sky-500/15 text-sky-200'
                : 'border border-slate-700 bg-slate-950 text-slate-400'
            }`}
          >
            {cfg.notifyEarlyIgnition
              ? '✓ 早鳥起漲訊號'
              : '早鳥起漲訊號 (關)'}
          </button>
        </div>
      </div>

      {testFeedback && (
        <div
          className={`flex items-center gap-2 border px-3 py-2 text-xs font-mono ${
            testFeedback.ok
              ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
              : 'border-amber-500/40 bg-amber-950/30 text-amber-200'
          }`}
        >
          {testFeedback.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
          )}
          <span>
            [{testFeedback.channel}] {testFeedback.message}
          </span>
        </div>
      )}

      {/* External Dispatch Audit Log */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-slate-300">
          外部推播審計紀錄 (最近 {logs.length} 筆)
        </div>
        <div className="border border-slate-800 bg-slate-950 overflow-x-auto max-h-[260px] overflow-y-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead className="border-b border-slate-800 text-slate-400 bg-slate-900/40">
              <tr>
                <th className="py-2 px-2.5">時間</th>
                <th className="py-2 px-2.5">通道</th>
                <th className="py-2 px-2.5">標的</th>
                <th className="py-2 px-2.5">軌道</th>
                <th className="py-2 px-2.5">狀態</th>
                <th className="py-2 px-2.5">說明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {logs.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-5 text-center font-sans text-slate-500"
                  >
                    尚無外部推播紀錄；可設定後端環境變數並點擊「發送測試通知」驗證連線。
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/40">
                    <td className="py-1.5 px-2.5 text-slate-400 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleTimeString('zh-TW', {
                        hour12: false,
                      })}
                    </td>
                    <td className="py-1.5 px-2.5 text-slate-200 whitespace-nowrap">
                      {log.channel}
                    </td>
                    <td className="py-1.5 px-2.5 font-semibold text-amber-300 whitespace-nowrap">
                      {log.symbol}
                    </td>
                    <td className="py-1.5 px-2.5 text-slate-300 whitespace-nowrap">
                      {log.track === 'FORMAL_SMC'
                        ? '正式 SMC'
                        : log.track === 'EARLY_IGNITION'
                          ? '早鳥起漲'
                          : '手動測試'}
                    </td>
                    <td className="py-1.5 px-2.5 whitespace-nowrap">
                      <span
                        className={
                          log.status === 'DELIVERED'
                            ? 'text-emerald-400 font-semibold'
                            : log.status === 'SEND_FAILED' ||
                                log.status === 'SKIPPED_UNCONFIGURED'
                              ? 'text-rose-400 font-semibold'
                              : 'text-amber-300'
                        }
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="py-1.5 px-2.5 font-sans text-slate-300 max-w-[280px] truncate">
                      {log.reason}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
