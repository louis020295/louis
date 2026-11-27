import zlib from 'node:zlib';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../db/RadarDatabase.ts';
import {
  calculateConfirmedAtr14,
  detectTimeframeBias,
  findConfirmedSwingPoints,
} from '../engine/SmcRuleEngine.ts';
import {
  DataProvenance,
  ExchangeId,
  Kline,
  PositionHealthState,
  PositionSentinelAlert,
  PositionSentinelAlertSeverity,
  PositionSentinelConfig,
  PositionSentinelEventType,
  PositionSentinelSnapshot,
  PositionSentinelStatusResponse,
  PositionSentinelTrackedPosition,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';
import { ExternalNotificationService } from './ExternalNotificationService.ts';

interface TickSample {
  price: number;
  ts: number;
}

interface WsExchangeConn {
  socket: WebSocket | null;
  subscribedKey: string;
  pingTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  connected: boolean;
  attempts: number;
}

const HEALTH_RANK: Record<PositionHealthState, number> = {
  TREND_INTACT: 0,
  MOMENTUM_FADING: 1,
  EARLY_REVERSAL: 2,
  THESIS_BROKEN: 3,
};

const HEALTH_LABEL_ZH: Record<PositionHealthState, string> = {
  TREND_INTACT: '趨勢延續中',
  MOMENTUM_FADING: '動能轉弱 / 逼近防線',
  EARLY_REVERSAL: '早期反轉 / 劇烈異動',
  THESIS_BROKEN: '趨勢失效 / 結構反轉',
};

const SAFE_SYMBOL_RE = /^[A-Z0-9]{2,24}$/;

function formatBybitSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function formatBingxWsSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith('USDT') && !s.includes('-')) {
    return `${s.slice(0, -4)}-USDT`;
  }
  return s;
}

function parseBingxWsSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace('-', '');
}

function healthScoreForState(
  state: PositionHealthState,
  warningsCount: number
): number {
  const base =
    state === 'TREND_INTACT'
      ? 92
      : state === 'MOMENTUM_FADING'
        ? 66
        : state === 'EARLY_REVERSAL'
          ? 38
          : 12;
  return Math.max(0, Math.min(100, base - Math.min(20, warningsCount * 5)));
}

function detectUnmitigatedOpposingFvg5m(
  confirmed5m: Kline[],
  side: 'LONG' | 'SHORT'
): { low: number; high: number } | null {
  if (confirmed5m.length < 5) return null;
  const recentStart = Math.max(2, confirmed5m.length - 12);
  const latestClose = confirmed5m[confirmed5m.length - 1].close;

  for (let i = confirmed5m.length - 1; i >= recentStart; i--) {
    const left = confirmed5m[i - 2];
    const right = confirmed5m[i];
    if (side === 'LONG') {
      // Bearish FVG: left.low > right.high, and price is still below or inside the gap
      if (left.low > right.high && latestClose < left.low) {
        const gapWidthPct = ((left.low - right.high) / right.high) * 100;
        if (gapWidthPct >= 0.05) {
          return {
            low: Number(right.high.toPrecision(6)),
            high: Number(left.low.toPrecision(6)),
          };
        }
      }
    } else {
      // Bullish FVG: right.low > left.high, and price is still above or inside the gap
      if (right.low > left.high && latestClose > left.high) {
        const gapWidthPct = ((right.low - left.high) / left.high) * 100;
        if (gapWidthPct >= 0.05) {
          return {
            low: Number(left.high.toPrecision(6)),
            high: Number(right.low.toPrecision(6)),
          };
        }
      }
    }
  }
  return null;
}

export class PositionSentinelService {
  private readonly db: RadarDatabase;
  private readonly adapters: Record<ExchangeId, ExchangeAdapter>;
  private readonly externalNotify?: ExternalNotificationService;
  private readonly disableWebSockets: boolean;

  private readonly snapshotsByPositionId = new Map<
    string,
    PositionSentinelSnapshot
  >();
  private readonly ticksByKey = new Map<string, TickSample[]>();
  private readonly prevOiValueByKey = new Map<string, number>();
  private readonly lastSuggestedDefenseByPosId = new Map<string, number>();
  private readonly alertThrottleMap = new Map<string, number>();
  private readonly wsConns = new Map<ExchangeId, WsExchangeConn>();
  private readonly listeners = new Set<
    (status: PositionSentinelStatusResponse) => void
  >();

  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private cycleInFlight = false;
  private lastCycleAt: string | null = null;
  private lastBroadcastAtMs = 0;

  constructor(params: {
    db: RadarDatabase;
    adapters: Record<ExchangeId, ExchangeAdapter>;
    externalNotificationService?: ExternalNotificationService;
    disableWebSockets?: boolean;
  }) {
    this.db = params.db;
    this.adapters = params.adapters;
    this.externalNotify = params.externalNotificationService;
    this.disableWebSockets =
      params.disableWebSockets ??
      (process.env.NODE_ENV === 'test' || typeof WebSocket === 'undefined');
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const cfg = this.db.getPositionSentinelConfig();
    if (cfg.autoSyncPaperLedger) {
      try {
        this.db.syncOpenPaperLedgerToPositionSentinel();
      } catch (err) {
        console.error('[PositionSentinel] Initial paper sync error:', err);
      }
    }
    this.scheduleNextPoll();
    void this.runEvaluationCycle().catch((err) => {
      console.error('[PositionSentinel] Initial cycle error:', err);
    });
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const ex of Array.from(this.wsConns.keys())) {
      this.closeWsForExchange(ex);
    }
    this.listeners.clear();
  }

  public subscribe(
    listener: (status: PositionSentinelStatusResponse) => void
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitStatusUpdate(force = false): void {
    if (this.listeners.size === 0) return;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastBroadcastAtMs < 600) {
      return;
    }
    this.lastBroadcastAtMs = nowMs;
    const status = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const cfg = this.db.getPositionSentinelConfig();
    const delayMs = cfg.enabled ? cfg.pollIntervalMs : 30_000;
    this.pollTimer = setTimeout(() => {
      void this.runEvaluationCycle().finally(() => {
        this.scheduleNextPoll();
      });
    }, delayMs);
    this.pollTimer.unref?.();
  }

  public updateConfig(
    patch: Partial<Omit<PositionSentinelConfig, 'updatedAt'>>
  ): PositionSentinelConfig {
    const saved = this.db.savePositionSentinelConfig(patch);
    if (!saved.enabled || !saved.wsStreamEnabled) {
      for (const ex of Array.from(this.wsConns.keys())) {
        this.closeWsForExchange(ex);
      }
    } else if (this.isRunning) {
      this.reconcileWebSockets();
    }
    if (this.isRunning) {
      this.scheduleNextPoll();
    }
    this.emitStatusUpdate(true);
    return saved;
  }

  public addPosition(input: {
    symbol: string;
    exchange: ExchangeId;
    side: 'LONG' | 'SHORT';
    timeframe?: '5m' | '15m' | '1h' | '4h';
    entryPrice: number;
    invalidationPrice: number;
    targetPrice?: number | null;
    leverage?: number;
    notes?: string;
  }): PositionSentinelTrackedPosition {
    const pos = this.db.addPositionSentinelPosition(input);
    this.reconcileWebSockets();
    this.emitStatusUpdate(true);
    return pos;
  }

  public updatePosition(
    id: string,
    patch: {
      invalidationPrice?: number;
      targetPrice?: number | null;
      leverage?: number;
      paused?: boolean;
      active?: boolean;
      notes?: string;
    }
  ): PositionSentinelTrackedPosition | null {
    const updated = this.db.updatePositionSentinelPosition(id, patch);
    if (updated) {
      const snap = this.snapshotsByPositionId.get(id);
      if (snap) {
        this.snapshotsByPositionId.set(id, {
          ...snap,
          invalidationPrice: updated.invalidationPrice,
          targetPrice: updated.targetPrice,
          leverage: updated.leverage,
          paused: updated.paused,
          active: updated.active,
          notes: updated.notes,
          updatedAt: updated.updatedAt,
        });
      }
      if (!updated.active && updated.sourceType === 'PAPER_LEDGER') {
        this.snapshotsByPositionId.delete(id);
      }
      this.reconcileWebSockets();
      this.emitStatusUpdate(true);
    }
    return updated;
  }

  public deletePosition(id: string): boolean {
    const ok = this.db.deletePositionSentinelPosition(id);
    if (ok) {
      this.snapshotsByPositionId.delete(id);
      this.reconcileWebSockets();
      this.emitStatusUpdate(true);
    }
    return ok;
  }

  public syncPaperLedgerNow(): {
    importedCount: number;
    deactivatedCount: number;
  } {
    const res = this.db.syncOpenPaperLedgerToPositionSentinel();
    const activeIds = new Set(
      this.db.listPositionSentinelPositions({ activeOnly: true }).map((p) => p.id)
    );
    for (const id of Array.from(this.snapshotsByPositionId.keys())) {
      if (!activeIds.has(id)) {
        this.snapshotsByPositionId.delete(id);
      }
    }
    this.reconcileWebSockets();
    this.emitStatusUpdate(true);
    return res;
  }

  public getStatus(): PositionSentinelStatusResponse {
    const cfg = this.db.getPositionSentinelConfig();
    const activePositions = this.db.listPositionSentinelPositions({
      activeOnly: true,
    });
    const recentAlerts = this.db.listPositionSentinelAlerts({ limit: 80 });

    const positions: PositionSentinelSnapshot[] = activePositions.map((pos) => {
      const existing = this.snapshotsByPositionId.get(pos.id);
      const posEvents = recentAlerts.filter((a) => a.positionId === pos.id).slice(0, 10);
      if (existing) {
        return {
          ...existing,
          ...pos,
          recentEvents: posEvents,
        };
      }
      return this.buildInitialSnapshot(pos, posEvents);
    });

    let intactCount = 0;
    let fadingCount = 0;
    let earlyReversalCount = 0;
    let thesisBrokenCount = 0;
    for (const p of positions) {
      if (p.healthState === 'THESIS_BROKEN') thesisBrokenCount++;
      else if (p.healthState === 'EARLY_REVERSAL') earlyReversalCount++;
      else if (p.healthState === 'MOMENTUM_FADING') fadingCount++;
      else intactCount++;
    }

    const wsConnectedExchanges: ExchangeId[] = [];
    for (const [ex, conn] of this.wsConns.entries()) {
      if (conn.connected) {
        wsConnectedExchanges.push(ex);
      }
    }

    return {
      safety: TRADING_SAFETY_FLAGS,
      config: cfg,
      isRunning: this.isRunning,
      wsConnectedExchanges,
      positions,
      recentAlerts,
      summary: {
        totalTracked: positions.length,
        intactCount,
        fadingCount,
        earlyReversalCount,
        thesisBrokenCount,
      },
      lastCycleAt: this.lastCycleAt,
    };
  }

  private buildInitialSnapshot(
    pos: PositionSentinelTrackedPosition,
    posEvents: PositionSentinelAlert[]
  ): PositionSentinelSnapshot {
    const distSl = this.calcStopDistancePct(
      pos.entryPrice,
      pos.invalidationPrice,
      pos.side
    );
    const distTp = pos.targetPrice
      ? this.calcTargetDistancePct(pos.entryPrice, pos.targetPrice, pos.side)
      : null;
    return {
      ...pos,
      currentPrice: pos.entryPrice,
      markSource: 'CACHE',
      lastTickAt: null,
      unrealizedPnlPercent: 0,
      unrealizedPnlR: 0,
      distanceToInvalidationPercent: distSl,
      distanceToTargetPercent: distTp,
      healthState: 'TREND_INTACT',
      healthLabelZh: HEALTH_LABEL_ZH.TREND_INTACT,
      healthScore: 90,
      atr15m: null,
      move1mPct: null,
      move3mPct: null,
      move1mAtrMultiple: null,
      liveBarRvol5m: null,
      micro5mState: 'UNKNOWN',
      structure15mState: 'UNKNOWN',
      htf1hBias: 'UNKNOWN',
      oiDeltaPct: null,
      oiWarningZh: null,
      adverseFvgDetected: false,
      adverseFvgRange: null,
      suggestedDefensePrice: null,
      suggestedDefenseLabel: null,
      breakEvenReady: false,
      activeWarnings: [],
      recentEvents: posEvents,
      lastEvaluatedAt: null,
      lastError: null,
      provenance: {
        source: this.adapters[pos.exchange]?.displayName ?? 'Pending Check',
        fetchedAt: pos.updatedAt,
        stale: false,
        fallback: false,
        missingData: [],
        isDemo: pos.exchange === 'demo_synthetic',
      },
    };
  }

  private calcPnlMetrics(
    entryPrice: number,
    invalidationPrice: number,
    currentPrice: number,
    side: 'LONG' | 'SHORT',
    leverage = 1
  ): { pnlPct: number; pnlR: number } {
    if (!(entryPrice > 0) || !(currentPrice > 0)) {
      return { pnlPct: 0, pnlR: 0 };
    }
    const rawPct =
      side === 'LONG'
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - currentPrice) / entryPrice) * 100;
    const riskPerUnit = Math.abs(entryPrice - invalidationPrice);
    const pnlR =
      riskPerUnit > 0
        ? side === 'LONG'
          ? (currentPrice - entryPrice) / riskPerUnit
          : (entryPrice - currentPrice) / riskPerUnit
        : 0;
    return {
      pnlPct: Number((rawPct * leverage).toFixed(2)),
      pnlR: Number(pnlR.toFixed(2)),
    };
  }

  private calcStopDistancePct(
    price: number,
    invalidationPrice: number,
    side: 'LONG' | 'SHORT'
  ): number {
    if (!(price > 0) || !(invalidationPrice > 0)) return 0;
    const raw =
      side === 'LONG'
        ? ((price - invalidationPrice) / price) * 100
        : ((invalidationPrice - price) / price) * 100;
    return Number(raw.toFixed(2));
  }

  private calcTargetDistancePct(
    price: number,
    targetPrice: number,
    side: 'LONG' | 'SHORT'
  ): number {
    if (!(price > 0) || !(targetPrice > 0)) return 0;
    const raw =
      side === 'LONG'
        ? ((targetPrice - price) / price) * 100
        : ((price - targetPrice) / price) * 100;
    return Number(raw.toFixed(2));
  }

  public async runEvaluationCycle(
    nowMs = Date.now()
  ): Promise<PositionSentinelStatusResponse> {
    if (this.cycleInFlight) {
      return this.getStatus();
    }
    this.cycleInFlight = true;
    try {
      const cfg = this.db.getPositionSentinelConfig();
      if (cfg.autoSyncPaperLedger) {
        this.db.syncOpenPaperLedgerToPositionSentinel();
      }
      const activePositions = this.db.listPositionSentinelPositions({
        activeOnly: true,
      });

      if (this.isRunning && cfg.enabled && cfg.wsStreamEnabled) {
        this.reconcileWebSockets();
      }

      if (cfg.enabled) {
        // Group REST requests per (exchange, symbol) so duplicate tracked entries share 1 fetch
        const sharedDataByKey = new Map<
          string,
          {
            klines1m: Kline[];
            klines5m: Kline[];
            klines15m: Kline[];
            klines1h: Kline[];
            openInterestValue: number | null;
            oiDeltaPct: number | null;
            provenance: DataProvenance;
            error: string | null;
          }
        >();

        const uniqueKeys = new Set<string>();
        const keyToMeta = new Map<
          string,
          { exchange: ExchangeId; symbol: string }
        >();
        for (const p of activePositions) {
          if (p.paused) continue;
          const k = `${p.exchange}:${p.symbol}`;
          if (!uniqueKeys.has(k)) {
            uniqueKeys.add(k);
            keyToMeta.set(k, { exchange: p.exchange, symbol: p.symbol });
          }
        }

        await Promise.all(
          Array.from(uniqueKeys).map(async (k) => {
            const meta = keyToMeta.get(k)!;
            const fetched = await this.fetchSymbolSentinelData(
              meta.exchange,
              meta.symbol
            );
            sharedDataByKey.set(k, fetched);
          })
        );

        for (const pos of activePositions) {
          if (pos.paused) continue;
          const data = sharedDataByKey.get(`${pos.exchange}:${pos.symbol}`);
          if (!data) continue;
          await this.evaluateSinglePosition(pos, data, cfg, nowMs);
        }
      }

      this.lastCycleAt = new Date(nowMs).toISOString();
      this.emitStatusUpdate(true);
      return this.getStatus();
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async fetchSymbolSentinelData(
    exchange: ExchangeId,
    symbol: string
  ): Promise<{
    klines1m: Kline[];
    klines5m: Kline[];
    klines15m: Kline[];
    klines1h: Kline[];
    openInterestValue: number | null;
    oiDeltaPct: number | null;
    provenance: DataProvenance;
    error: string | null;
  }> {
    const adapter = this.adapters[exchange];
    const nowIso = new Date().toISOString();
    if (!adapter) {
      return {
        klines1m: [],
        klines5m: [],
        klines15m: [],
        klines1h: [],
        openInterestValue: null,
        oiDeltaPct: null,
        provenance: {
          source: exchange,
          fetchedAt: nowIso,
          stale: true,
          fallback: false,
          missingData: ['ADAPTER_UNAVAILABLE'],
          isDemo: exchange === 'demo_synthetic',
        },
        error: `找不到交易所轉接器 ${exchange}`,
      };
    }

    try {
      const [k1mRes, k5mRes, k15mRes, k1hRes, oiRes, histOiRes] =
        await Promise.allSettled([
          adapter.fetchKlines1m
            ? adapter.fetchKlines1m(symbol, 20)
            : Promise.resolve(null),
          adapter.fetchKlines(symbol, '5m', 60),
          adapter.fetchKlines(symbol, '15m', 60),
          adapter.fetchKlines(symbol, '1h', 60),
          adapter.fetchOpenInterest(symbol),
          adapter.fetchHistoricalOpenInterest
            ? adapter.fetchHistoricalOpenInterest(symbol, '15m', 6)
            : Promise.resolve(null),
        ]);

      const klines1m =
        k1mRes.status === 'fulfilled' && k1mRes.value ? k1mRes.value.klines : [];
      const klines5m =
        k5mRes.status === 'fulfilled' ? k5mRes.value.klines : [];
      const klines15m =
        k15mRes.status === 'fulfilled' ? k15mRes.value.klines : [];
      const klines1h =
        k1hRes.status === 'fulfilled' ? k1hRes.value.klines : [];

      const provenance: DataProvenance =
        k5mRes.status === 'fulfilled'
          ? k5mRes.value.provenance
          : k15mRes.status === 'fulfilled'
            ? k15mRes.value.provenance
            : {
                source: adapter.displayName,
                fetchedAt: nowIso,
                stale: true,
                fallback: false,
                missingData: ['KLINES_UNAVAILABLE'],
                isDemo: adapter.isDemo,
              };

      const openInterestValue =
        oiRes.status === 'fulfilled' ? oiRes.value.openInterestValue : null;

      let oiDeltaPct: number | null = null;
      if (
        histOiRes.status === 'fulfilled' &&
        histOiRes.value &&
        Array.isArray(histOiRes.value.series) &&
        histOiRes.value.series.length >= 2
      ) {
        const series = histOiRes.value.series;
        const prev =
          series[series.length - 2].openInterestValue ??
          series[series.length - 2].openInterest;
        const curr =
          series[series.length - 1].openInterestValue ??
          series[series.length - 1].openInterest;
        if (prev && curr && prev > 0) {
          oiDeltaPct = Number((((curr - prev) / prev) * 100).toFixed(2));
        }
      } else if (openInterestValue !== null && openInterestValue > 0) {
        const cacheKey = `${exchange}:${symbol}`;
        const prevOi = this.prevOiValueByKey.get(cacheKey);
        if (prevOi && prevOi > 0) {
          oiDeltaPct = Number(
            (((openInterestValue - prevOi) / prevOi) * 100).toFixed(2)
          );
        }
        this.prevOiValueByKey.set(cacheKey, openInterestValue);
      }

      if (klines5m.length === 0 && klines15m.length === 0) {
        return {
          klines1m,
          klines5m,
          klines15m,
          klines1h,
          openInterestValue,
          oiDeltaPct,
          provenance: {
            ...provenance,
            stale: true,
            missingData: ['KLINES_5M', 'KLINES_15M'],
          },
          error: '即時 K 線資料取得失敗，暫停結構判讀',
        };
      }

      return {
        klines1m,
        klines5m,
        klines15m,
        klines1h,
        openInterestValue,
        oiDeltaPct,
        provenance,
        error: null,
      };
    } catch (err) {
      return {
        klines1m: [],
        klines5m: [],
        klines15m: [],
        klines1h: [],
        openInterestValue: null,
        oiDeltaPct: null,
        provenance: {
          source: adapter.displayName,
          fetchedAt: nowIso,
          stale: true,
          fallback: false,
          missingData: ['FETCH_ERROR'],
          isDemo: adapter.isDemo,
        },
        error: err instanceof Error ? err.message : '交易所資料讀取失敗',
      };
    }
  }

  private async evaluateSinglePosition(
    pos: PositionSentinelTrackedPosition,
    data: Awaited<ReturnType<PositionSentinelService['fetchSymbolSentinelData']>>,
    cfg: PositionSentinelConfig,
    nowMs: number
  ): Promise<PositionSentinelSnapshot> {
    const prevSnapshot = this.snapshotsByPositionId.get(pos.id);
    const key = `${pos.exchange}:${pos.symbol}`;
    const tickList = this.ticksByKey.get(key) ?? [];
    const latestTick =
      tickList.length > 0 ? tickList[tickList.length - 1] : null;
    const isFreshWsTick =
      latestTick !== null && nowMs - latestTick.ts <= 20_000;

    // Resolve live price prioritizing fresh WebSocket tick, then latest 1m/5m/15m candle close
    const latest1m = data.klines1m[data.klines1m.length - 1];
    const latest5m = data.klines5m[data.klines5m.length - 1];
    const latest15m = data.klines15m[data.klines15m.length - 1];
    const restPrice =
      latest1m?.close ?? latest5m?.close ?? latest15m?.close ?? null;

    const currentPrice = isFreshWsTick
      ? latestTick!.price
      : restPrice ?? prevSnapshot?.currentPrice ?? pos.entryPrice;
    const markSource: PositionSentinelSnapshot['markSource'] = isFreshWsTick
      ? 'WEBSOCKET'
      : restPrice !== null
        ? 'REST_FAST'
        : 'CACHE';
    const lastTickAt = isFreshWsTick
      ? new Date(latestTick!.ts).toISOString()
      : data.provenance.fetchedAt;

    const { pnlPct, pnlR } = this.calcPnlMetrics(
      pos.entryPrice,
      pos.invalidationPrice,
      currentPrice,
      pos.side,
      pos.leverage
    );
    const distanceToInvalidationPercent = this.calcStopDistancePct(
      currentPrice,
      pos.invalidationPrice,
      pos.side
    );
    const distanceToTargetPercent = pos.targetPrice
      ? this.calcTargetDistancePct(currentPrice, pos.targetPrice, pos.side)
      : null;

    // Update live PnL on matching open paper_ledger entry cleanly
    if (
      pos.sourceType === 'PAPER_LEDGER' &&
      pos.paperLedgerId !== null &&
      currentPrice > 0 &&
      !data.error
    ) {
      try {
        this.db.syncPaperLedgerOpenPriceAndPnl(
          pos.paperLedgerId,
          currentPrice,
          pnlPct,
          pnlR
        );
      } catch {
        // ignore if closed concurrently
      }
    }

    const confirmed5m = data.klines5m.filter((k) => k.isClosed);
    const confirmed15m = data.klines15m.filter((k) => k.isClosed);
    const confirmed1h = data.klines1h.filter((k) => k.isClosed);
    const atr15m = calculateConfirmedAtr14(confirmed15m);

    // 1. Compute 1m / 3m price move (prefer WS ticks, fallback to 1m klines)
    const { move1mPct, move3mPct } = this.computeShortTermMoves(
      key,
      currentPrice,
      data.klines1m,
      nowMs
    );
    const move1mAbsPrice =
      move1mPct !== null ? Math.abs(move1mPct / 100) * currentPrice : null;
    const move3mAbsPrice =
      move3mPct !== null ? Math.abs(move3mPct / 100) * currentPrice : null;
    const maxShortMovePrice = Math.max(move1mAbsPrice ?? 0, move3mAbsPrice ?? 0);
    const move1mAtrMultiple =
      atr15m && atr15m > 0 && maxShortMovePrice > 0
        ? Number((maxShortMovePrice / atr15m).toFixed(2))
        : null;

    // 2. Live 5m bar RVOL spike
    let liveBarRvol5m: number | null = null;
    let isAdverseLive5mBar = false;
    if (latest5m && confirmed5m.length >= 10) {
      const trailingVols = confirmed5m.slice(-20).map((k) => k.quoteVolume || k.volume);
      const avgVol =
        trailingVols.reduce((a, b) => a + b, 0) / Math.max(1, trailingVols.length);
      const currentVol = latest5m.quoteVolume || latest5m.volume;
      if (avgVol > 0) {
        liveBarRvol5m = Number((currentVol / avgVol).toFixed(2));
      }
      isAdverseLive5mBar =
        pos.side === 'LONG'
          ? latest5m.close < latest5m.open
          : latest5m.close > latest5m.open;
    }

    // 3. 5m Micro-Structure CHoCH & FVG
    let micro5mState: PositionSentinelSnapshot['micro5mState'] = 'UNKNOWN';
    let micro5mTriggerRef: number | null = null;
    if (confirmed5m.length >= 12) {
      const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed5m);
      const lastConf5m = confirmed5m[confirmed5m.length - 1];
      if (pos.side === 'LONG') {
        const lastSwingLow = swingLows[swingLows.length - 1];
        if (lastSwingLow) {
          micro5mTriggerRef = lastSwingLow.price;
          if (lastConf5m.close < lastSwingLow.price) {
            micro5mState = 'ADVERSE_CHOCH';
          } else if (
            currentPrice < lastSwingLow.price ||
            (latest5m && !latest5m.isClosed && latest5m.low < lastSwingLow.price)
          ) {
            micro5mState = 'TESTING_SWING';
          } else {
            micro5mState = 'ALIGNED';
          }
        } else {
          micro5mState = 'ALIGNED';
        }
      } else {
        const lastSwingHigh = swingHighs[swingHighs.length - 1];
        if (lastSwingHigh) {
          micro5mTriggerRef = lastSwingHigh.price;
          if (lastConf5m.close > lastSwingHigh.price) {
            micro5mState = 'ADVERSE_CHOCH';
          } else if (
            currentPrice > lastSwingHigh.price ||
            (latest5m && !latest5m.isClosed && latest5m.high > lastSwingHigh.price)
          ) {
            micro5mState = 'TESTING_SWING';
          } else {
            micro5mState = 'ALIGNED';
          }
        } else {
          micro5mState = 'ALIGNED';
        }
      }
    }

    const adverseFvgRange = detectUnmitigatedOpposingFvg5m(confirmed5m, pos.side);
    const adverseFvgDetected = adverseFvgRange !== null;

    // 4. 15m Primary Structure & 1h Bias
    let structure15mState: PositionSentinelSnapshot['structure15mState'] =
      'UNKNOWN';
    let structure15mRef: number | null = null;
    let trailingSwingDefense: number | null = null;
    if (confirmed15m.length >= 12) {
      const { swingHighs, swingLows } = findConfirmedSwingPoints(confirmed15m);
      const lastConf15m = confirmed15m[confirmed15m.length - 1];
      if (pos.side === 'LONG') {
        const lastSwingLow = swingLows[swingLows.length - 1];
        if (lastSwingLow) {
          structure15mRef = lastSwingLow.price;
          const buffer = atr15m ? atr15m * 0.2 : lastSwingLow.price * 0.0015;
          trailingSwingDefense = Number((lastSwingLow.price - buffer).toPrecision(6));
          if (lastConf15m.close < lastSwingLow.price) {
            structure15mState = 'REVERSED';
          } else if (currentPrice < lastSwingLow.price) {
            structure15mState = 'WEAKENING';
          } else {
            structure15mState = 'ALIGNED';
          }
        } else {
          structure15mState = 'ALIGNED';
        }
      } else {
        const lastSwingHigh = swingHighs[swingHighs.length - 1];
        if (lastSwingHigh) {
          structure15mRef = lastSwingHigh.price;
          const buffer = atr15m ? atr15m * 0.2 : lastSwingHigh.price * 0.0015;
          trailingSwingDefense = Number((lastSwingHigh.price + buffer).toPrecision(6));
          if (lastConf15m.close > lastSwingHigh.price) {
            structure15mState = 'REVERSED';
          } else if (currentPrice > lastSwingHigh.price) {
            structure15mState = 'WEAKENING';
          } else {
            structure15mState = 'ALIGNED';
          }
        } else {
          structure15mState = 'ALIGNED';
        }
      }
    }

    const rawBias1h = detectTimeframeBias(confirmed1h);
    const htf1hBias: PositionSentinelSnapshot['htf1hBias'] =
      rawBias1h === 'MISSING' ? 'UNKNOWN' : rawBias1h;

    // 5. OI Divergence Warning
    let oiWarningZh: string | null = null;
    if (data.oiDeltaPct !== null) {
      const priceDirPct = move3mPct ?? (latest5m ? ((latest5m.close - latest5m.open) / latest5m.open) * 100 : 0);
      if (pos.side === 'LONG') {
        if (data.oiDeltaPct >= 2.5 && priceDirPct <= -0.35) {
          oiWarningZh = `OI 逆勢暴增 +${data.oiDeltaPct}% 但價格轉跌 (${priceDirPct.toFixed(2)}%)，慎防多殺多擠壓`;
        } else if (data.oiDeltaPct <= -3.0 && priceDirPct <= -0.6) {
          oiWarningZh = `OI 急降 ${data.oiDeltaPct}% 伴隨急殺，疑似多頭連環清算`;
        }
      } else {
        if (data.oiDeltaPct >= 2.5 && priceDirPct >= 0.35) {
          oiWarningZh = `OI 逆勢暴增 +${data.oiDeltaPct}% 但價格強彈 (+${priceDirPct.toFixed(2)}%)，慎防軋空風險`;
        } else if (data.oiDeltaPct <= -3.0 && priceDirPct >= 0.6) {
          oiWarningZh = `OI 急降 ${data.oiDeltaPct}% 伴隨強拉，疑似空頭回補清算`;
        }
      }
    }

    // 6. Dynamic Trailing Defense Recommendation (advisory only)
    let suggestedDefensePrice: number | null = null;
    let suggestedDefenseLabel: string | null = null;
    const breakEvenReady = pnlR >= 1.0 || (pnlPct >= 1.2 && pos.leverage <= 2);

    if (pos.side === 'LONG') {
      const candidates: Array<{ price: number; label: string }> = [];
      if (breakEvenReady && pos.entryPrice > pos.invalidationPrice) {
        candidates.push({
          price: Number((pos.entryPrice * 1.0005).toPrecision(6)),
          label: '已達 +1R，可移動至保本防守位',
        });
      }
      if (
        trailingSwingDefense !== null &&
        trailingSwingDefense > pos.invalidationPrice &&
        trailingSwingDefense < currentPrice
      ) {
        candidates.push({
          price: trailingSwingDefense,
          label: '15m 新回踩低點 - 0.2 ATR 結構防守位',
        });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.price - a.price);
        suggestedDefensePrice = candidates[0].price;
        suggestedDefenseLabel = candidates[0].label;
      }
    } else {
      const candidates: Array<{ price: number; label: string }> = [];
      if (breakEvenReady && pos.entryPrice < pos.invalidationPrice) {
        candidates.push({
          price: Number((pos.entryPrice * 0.9995).toPrecision(6)),
          label: '已達 +1R，可移動至保本防守位',
        });
      }
      if (
        trailingSwingDefense !== null &&
        trailingSwingDefense < pos.invalidationPrice &&
        trailingSwingDefense > currentPrice
      ) {
        candidates.push({
          price: trailingSwingDefense,
          label: '15m 新反彈高點 + 0.2 ATR 結構防守位',
        });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.price - b.price);
        suggestedDefensePrice = candidates[0].price;
        suggestedDefenseLabel = candidates[0].label;
      }
    }

    // 7. Collect Active Warnings & Pending Alerts
    const activeWarnings: string[] = [];
    const candidateEvents: Array<{
      eventType: PositionSentinelEventType;
      severity: PositionSentinelAlertSeverity;
      titleZh: string;
      detailZh: string;
      confirmedClose: boolean;
    }> = [];

    const invalidated =
      pos.side === 'LONG'
        ? currentPrice <= pos.invalidationPrice
        : currentPrice >= pos.invalidationPrice;

    if (invalidated) {
      const detail = `現價 ${currentPrice} 已跌破/突破原定失效防線 ${pos.invalidationPrice}`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'THESIS_INVALIDATED',
        severity: 'CRITICAL',
        titleZh: '觸及結構失效防線 (SL)',
        detailZh: detail,
        confirmedClose: false,
      });
    } else if (distanceToInvalidationPercent <= cfg.stopProximityPct) {
      const detail = `現價距離止損失效位僅剩 ${distanceToInvalidationPercent.toFixed(2)}% (門檻 ${cfg.stopProximityPct}%)`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'STOP_PROXIMITY',
        severity: 'WARNING',
        titleZh: '逼近結構止損防線',
        detailZh: detail,
        confirmedClose: false,
      });
    }

    const adverseShock =
      move1mAtrMultiple !== null &&
      move1mAtrMultiple >= cfg.atrShockMultiplier &&
      ((pos.side === 'LONG' && ((move1mPct ?? 0) < 0 || (move3mPct ?? 0) < 0)) ||
        (pos.side === 'SHORT' && ((move1mPct ?? 0) > 0 || (move3mPct ?? 0) > 0)));
    if (adverseShock) {
      const pctVal =
        Math.abs(move1mPct ?? 0) >= Math.abs(move3mPct ?? 0)
          ? move1mPct ?? 0
          : move3mPct ?? 0;
      const detail = `短線逆向急動 ${pctVal >= 0 ? '+' : ''}${pctVal.toFixed(2)}% (約 ${move1mAtrMultiple}× ATR15m)`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'PRICE_SHOCK_1M',
        severity: 'CRITICAL',
        titleZh: '1～3 分鐘反向劇烈異動',
        detailZh: detail,
        confirmedClose: false,
      });
    }

    if (
      liveBarRvol5m !== null &&
      liveBarRvol5m >= cfg.rvolSpikeThreshold &&
      isAdverseLive5mBar
    ) {
      const detail = `5m 即時逆向K線成交量爆衝至均量 ${liveBarRvol5m}x (門檻 ${cfg.rvolSpikeThreshold}x)`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'VOLUME_SPIKE_ADVERSE',
        severity: 'WARNING',
        titleZh: '5m 逆向異常爆量',
        detailZh: detail,
        confirmedClose: false,
      });
    }

    if (micro5mState === 'ADVERSE_CHOCH') {
      const detail = `5m 已收盤跌破/突破前擺動位 ${micro5mTriggerRef ?? '--'}，短週期結構反轉`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'MICRO_CHOCH_5M_CONFIRMED',
        severity:
          liveBarRvol5m && liveBarRvol5m >= cfg.rvolSpikeThreshold
            ? 'CRITICAL'
            : 'WARNING',
        titleZh: '5m 逆向微結構 CHoCH (已收盤確認)',
        detailZh: detail,
        confirmedClose: true,
      });
    } else if (micro5mState === 'TESTING_SWING') {
      const detail = `5m 盤中正在測試/插針跌破擺動防線 ${micro5mTriggerRef ?? '--'} (尚未收盤)`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'MICRO_CHOCH_5M_UNCONFIRMED',
        severity: 'WARNING',
        titleZh: '5m 盤中測試微結構支撐/壓力',
        detailZh: detail,
        confirmedClose: false,
      });
    }

    if (adverseFvgDetected && adverseFvgRange) {
      const detail = `5m 形成逆向 FVG 失衡區 [${adverseFvgRange.low} ~ ${adverseFvgRange.high}] 壓制價格推進`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'ADVERSE_FVG_5M',
        severity: 'WARNING',
        titleZh: '5m 出現逆向 FVG 失衡壓制',
        detailZh: detail,
        confirmedClose: true,
      });
    }

    if (oiWarningZh) {
      activeWarnings.push(oiWarningZh);
      candidateEvents.push({
        eventType: 'OI_DIVERGENCE',
        severity: 'WARNING',
        titleZh: 'OI 與價格異常背離',
        detailZh: oiWarningZh,
        confirmedClose: false,
      });
    }

    if (structure15mState === 'REVERSED') {
      const detail = `15m 已收盤打破結構點 ${structure15mRef ?? '--'}，主架構轉弱反轉`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'STRUCTURE_CHOCH_15M',
        severity: 'CRITICAL',
        titleZh: '15m 主結構逆向 CHoCH 確認',
        detailZh: detail,
        confirmedClose: true,
      });
    }

    const htfOpposing =
      (pos.side === 'LONG' && htf1hBias === 'BEAR') ||
      (pos.side === 'SHORT' && htf1hBias === 'BULL');
    if (htfOpposing) {
      const detail = `1h 大週期方向已轉為 ${htf1hBias}，與持倉 (${pos.side}) 逆勢`;
      activeWarnings.push(detail);
      candidateEvents.push({
        eventType: 'HTF_BREAK_1H',
        severity: structure15mState === 'REVERSED' ? 'CRITICAL' : 'WARNING',
        titleZh: '1h 大趨勢方向逆轉',
        detailZh: detail,
        confirmedClose: true,
      });
    }

    // 8. Compute Unified Health State
    let healthState: PositionHealthState = 'TREND_INTACT';
    if (
      invalidated ||
      (structure15mState === 'REVERSED' &&
        (htfOpposing || micro5mState === 'ADVERSE_CHOCH'))
    ) {
      healthState = 'THESIS_BROKEN';
    } else if (
      micro5mState === 'ADVERSE_CHOCH' ||
      adverseShock ||
      structure15mState === 'REVERSED' ||
      (micro5mState === 'TESTING_SWING' &&
        liveBarRvol5m !== null &&
        liveBarRvol5m >= cfg.rvolSpikeThreshold)
    ) {
      healthState = 'EARLY_REVERSAL';
    } else if (
      micro5mState === 'TESTING_SWING' ||
      distanceToInvalidationPercent <= cfg.stopProximityPct ||
      adverseFvgDetected ||
      oiWarningZh !== null ||
      htfOpposing ||
      (liveBarRvol5m !== null &&
        liveBarRvol5m >= cfg.rvolSpikeThreshold &&
        isAdverseLive5mBar)
    ) {
      healthState = 'MOMENTUM_FADING';
    }

    const prevState = prevSnapshot?.healthState ?? 'TREND_INTACT';
    const escalated = HEALTH_RANK[healthState] > HEALTH_RANK[prevState];

    // Emit Trailing Defense Raised INFO event if meaningfully improved
    if (suggestedDefensePrice !== null && healthState === 'TREND_INTACT') {
      const prevDef = this.lastSuggestedDefenseByPosId.get(pos.id);
      const improved =
        prevDef === undefined ||
        (pos.side === 'LONG' && suggestedDefensePrice > prevDef * 1.001) ||
        (pos.side === 'SHORT' && suggestedDefensePrice < prevDef * 0.999);
      if (improved) {
        this.lastSuggestedDefenseByPosId.set(pos.id, suggestedDefensePrice);
        candidateEvents.push({
          eventType: 'TRAILING_DEFENSE_RAISED',
          severity: 'INFO',
          titleZh: '可上移建議防守位',
          detailZh: `${suggestedDefenseLabel ?? '結構跟隨防守位'}：建議調整追蹤防線至 ${suggestedDefensePrice}`,
          confirmedClose: true,
        });
      }
    }

    const nowIso = new Date(nowMs).toISOString();
    const snapshot: PositionSentinelSnapshot = {
      ...pos,
      currentPrice,
      markSource,
      lastTickAt,
      unrealizedPnlPercent: pnlPct,
      unrealizedPnlR: pnlR,
      distanceToInvalidationPercent,
      distanceToTargetPercent,
      healthState,
      healthLabelZh: HEALTH_LABEL_ZH[healthState],
      healthScore: healthScoreForState(healthState, activeWarnings.length),
      atr15m: atr15m !== null ? Number(atr15m.toPrecision(6)) : null,
      move1mPct,
      move3mPct,
      move1mAtrMultiple,
      liveBarRvol5m,
      micro5mState,
      structure15mState,
      htf1hBias,
      oiDeltaPct: data.oiDeltaPct,
      oiWarningZh,
      adverseFvgDetected,
      adverseFvgRange,
      suggestedDefensePrice,
      suggestedDefenseLabel,
      breakEvenReady,
      activeWarnings,
      recentEvents: prevSnapshot?.recentEvents ?? [],
      lastEvaluatedAt: nowIso,
      lastError: data.error,
      provenance: data.provenance,
    };

    // Persist & notify triggered alerts cleanly
    await this.recordAndDispatchEvents(
      snapshot,
      candidateEvents,
      cfg,
      escalated,
      nowMs
    );

    snapshot.recentEvents = this.db.listPositionSentinelAlerts({
      positionId: pos.id,
      limit: 10,
    });
    this.snapshotsByPositionId.set(pos.id, snapshot);
    return snapshot;
  }

  private async recordAndDispatchEvents(
    snapshot: PositionSentinelSnapshot,
    events: Array<{
      eventType: PositionSentinelEventType;
      severity: PositionSentinelAlertSeverity;
      titleZh: string;
      detailZh: string;
      confirmedClose: boolean;
    }>,
    cfg: PositionSentinelConfig,
    escalated: boolean,
    nowMs: number
  ): Promise<void> {
    if (events.length === 0) return;

    // Pick highest severity event first for external dispatch
    const sorted = [...events].sort((a, b) => {
      const rank = (s: PositionSentinelAlertSeverity) =>
        s === 'CRITICAL' ? 2 : s === 'WARNING' ? 1 : 0;
      return rank(b.severity) - rank(a.severity);
    });

    let dispatchedExternalThisCycle = false;

    for (const ev of sorted) {
      const throttleKey = `${snapshot.id}:${ev.eventType}`;
      const lastRecordedMs = this.alertThrottleMap.get(throttleKey);
      const shouldRecord =
        (escalated && ev.severity !== 'INFO') ||
        lastRecordedMs === undefined ||
        nowMs - lastRecordedMs >= cfg.alertCooldownMs;

      if (!shouldRecord) continue;

      this.alertThrottleMap.set(throttleKey, nowMs);
      const alert: PositionSentinelAlert = {
        id: `psa_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        positionId: snapshot.id,
        symbol: snapshot.symbol,
        exchange: snapshot.exchange,
        side: snapshot.side,
        severity: ev.severity,
        healthState: snapshot.healthState,
        eventType: ev.eventType,
        titleZh: ev.titleZh,
        detailZh: ev.detailZh,
        priceAtEvent: snapshot.currentPrice,
        suggestedDefensePrice: snapshot.suggestedDefensePrice,
        confirmedClose: ev.confirmedClose,
        createdAt: new Date(nowMs).toISOString(),
      };
      this.db.recordPositionSentinelAlert(alert);

      if (
        !dispatchedExternalThisCycle &&
        this.externalNotify &&
        ev.severity !== 'INFO'
      ) {
        dispatchedExternalThisCycle = true;
        await this.externalNotify
          .dispatchPositionSentinelAlert({
            position: snapshot,
            alert,
            sentinelConfig: cfg,
            escalated,
            nowMs,
          })
          .catch(() => {
            // isolate notification errors
          });
      }
    }
  }

  private computeShortTermMoves(
    key: string,
    currentPrice: number,
    klines1m: Kline[],
    nowMs: number
  ): { move1mPct: number | null; move3mPct: number | null } {
    const ticks = this.ticksByKey.get(key) ?? [];
    let ref1m: number | null = null;
    let ref3m: number | null = null;

    if (ticks.length >= 2) {
      for (const t of ticks) {
        const age = nowMs - t.ts;
        if (age >= 45_000 && age <= 90_000) {
          ref1m = t.price;
        }
        if (age >= 150_000 && age <= 240_000) {
          ref3m = t.price;
        }
      }
    }

    if (ref1m === null && klines1m.length >= 2) {
      ref1m = klines1m[klines1m.length - 2].close;
    }
    if (ref3m === null && klines1m.length >= 4) {
      ref3m = klines1m[klines1m.length - 4].close;
    }

    const move1mPct =
      ref1m && ref1m > 0
        ? Number((((currentPrice - ref1m) / ref1m) * 100).toFixed(2))
        : null;
    const move3mPct =
      ref3m && ref3m > 0
        ? Number((((currentPrice - ref3m) / ref3m) * 100).toFixed(2))
        : null;

    return { move1mPct, move3mPct };
  }

  private onLiveTick(
    exchange: ExchangeId,
    symbol: string,
    price: number,
    nowMs = Date.now()
  ): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const key = `${exchange}:${symbol}`;
    const arr = this.ticksByKey.get(key) ?? [];
    arr.push({ price, ts: nowMs });
    while (arr.length > 0 && nowMs - arr[0].ts > 5 * 60_000) {
      arr.shift();
    }
    if (arr.length > 240) {
      arr.splice(0, arr.length - 240);
    }
    this.ticksByKey.set(key, arr);

    const cfg = this.db.getPositionSentinelConfig();
    if (!cfg.enabled) return;

    const active = this.db
      .listPositionSentinelPositions({ activeOnly: true })
      .filter((p) => !p.paused && p.exchange === exchange && p.symbol === symbol);

    let updatedAny = false;
    for (const pos of active) {
      const prev = this.snapshotsByPositionId.get(pos.id);
      if (!prev) continue;

      const { pnlPct, pnlR } = this.calcPnlMetrics(
        pos.entryPrice,
        pos.invalidationPrice,
        price,
        pos.side,
        pos.leverage
      );
      const distSl = this.calcStopDistancePct(
        price,
        pos.invalidationPrice,
        pos.side
      );
      const distTp = pos.targetPrice
        ? this.calcTargetDistancePct(price, pos.targetPrice, pos.side)
        : null;
      const { move1mPct, move3mPct } = this.computeShortTermMoves(
        key,
        price,
        [],
        nowMs
      );
      const maxMoveAbs = Math.max(
        move1mPct !== null ? Math.abs(move1mPct / 100) * price : 0,
        move3mPct !== null ? Math.abs(move3mPct / 100) * price : 0
      );
      const move1mAtrMultiple =
        prev.atr15m && prev.atr15m > 0 && maxMoveAbs > 0
          ? Number((maxMoveAbs / prev.atr15m).toFixed(2))
          : prev.move1mAtrMultiple;

      let nextState = prev.healthState;
      const invalidated =
        pos.side === 'LONG'
          ? price <= pos.invalidationPrice
          : price >= pos.invalidationPrice;
      const shock =
        move1mAtrMultiple !== null &&
        move1mAtrMultiple >= cfg.atrShockMultiplier &&
        ((pos.side === 'LONG' && ((move1mPct ?? 0) < 0 || (move3mPct ?? 0) < 0)) ||
          (pos.side === 'SHORT' && ((move1mPct ?? 0) > 0 || (move3mPct ?? 0) > 0)));

      let urgentEvent: {
        eventType: PositionSentinelEventType;
        severity: PositionSentinelAlertSeverity;
        titleZh: string;
        detailZh: string;
      } | null = null;

      if (invalidated) {
        nextState = 'THESIS_BROKEN';
        urgentEvent = {
          eventType: 'THESIS_INVALIDATED',
          severity: 'CRITICAL',
          titleZh: '觸及結構失效防線 (SL)',
          detailZh: `即時價 ${price} 已觸及/突破止損失效價 ${pos.invalidationPrice}`,
        };
      } else if (shock) {
        if (HEALTH_RANK[nextState] < HEALTH_RANK.EARLY_REVERSAL) {
          nextState = 'EARLY_REVERSAL';
        }
        const pctVal =
          Math.abs(move1mPct ?? 0) >= Math.abs(move3mPct ?? 0)
            ? move1mPct ?? 0
            : move3mPct ?? 0;
        urgentEvent = {
          eventType: 'PRICE_SHOCK_1M',
          severity: 'CRITICAL',
          titleZh: 'WebSocket 即時劇烈反向異動',
          detailZh: `短線逆向急動 ${pctVal >= 0 ? '+' : ''}${pctVal.toFixed(2)}% (${move1mAtrMultiple}× ATR15m)`,
        };
      } else if (distSl <= cfg.stopProximityPct) {
        if (HEALTH_RANK[nextState] < HEALTH_RANK.MOMENTUM_FADING) {
          nextState = 'MOMENTUM_FADING';
        }
        urgentEvent = {
          eventType: 'STOP_PROXIMITY',
          severity: 'WARNING',
          titleZh: '逼近結構止損防線',
          detailZh: `即時價距離止損位僅剩 ${distSl.toFixed(2)}%`,
        };
      }

      const escalated = HEALTH_RANK[nextState] > HEALTH_RANK[prev.healthState];
      const nextSnapshot: PositionSentinelSnapshot = {
        ...prev,
        currentPrice: price,
        markSource: 'WEBSOCKET',
        lastTickAt: new Date(nowMs).toISOString(),
        unrealizedPnlPercent: pnlPct,
        unrealizedPnlR: pnlR,
        distanceToInvalidationPercent: distSl,
        distanceToTargetPercent: distTp,
        move1mPct: move1mPct ?? prev.move1mPct,
        move3mPct: move3mPct ?? prev.move3mPct,
        move1mAtrMultiple,
        healthState: nextState,
        healthLabelZh: HEALTH_LABEL_ZH[nextState],
        healthScore: healthScoreForState(nextState, prev.activeWarnings.length),
      };
      this.snapshotsByPositionId.set(pos.id, nextSnapshot);
      updatedAny = true;

      if (urgentEvent && (escalated || nextState === 'THESIS_BROKEN')) {
        void this.recordAndDispatchEvents(
          nextSnapshot,
          [{ ...urgentEvent, confirmedClose: false }],
          cfg,
          escalated,
          nowMs
        );
      }
    }

    if (updatedAny) {
      this.emitStatusUpdate(false);
    }
  }

  private reconcileWebSockets(): void {
    if (this.disableWebSockets || !this.isRunning) return;
    const cfg = this.db.getPositionSentinelConfig();
    if (!cfg.enabled || !cfg.wsStreamEnabled) return;

    const active = this.db
      .listPositionSentinelPositions({ activeOnly: true })
      .filter(
        (p) =>
          !p.paused &&
          p.exchange !== 'demo_synthetic' &&
          SAFE_SYMBOL_RE.test(p.symbol)
      );

    const symbolsByExchange = new Map<ExchangeId, string[]>();
    for (const p of active) {
      const list = symbolsByExchange.get(p.exchange) ?? [];
      if (!list.includes(p.symbol)) {
        list.push(p.symbol);
      }
      symbolsByExchange.set(p.exchange, list);
    }

    for (const ex of ['binance_usdm', 'bybit_linear', 'bingx_swap'] as ExchangeId[]) {
      const syms = (symbolsByExchange.get(ex) ?? []).sort();
      if (syms.length === 0) {
        this.closeWsForExchange(ex);
        continue;
      }
      const key = syms.join(',');
      const existing = this.wsConns.get(ex);
      if (existing && existing.subscribedKey === key && existing.socket) {
        continue;
      }
      this.openWsForExchange(ex, syms, key);
    }
  }

  private closeWsForExchange(exchange: ExchangeId): void {
    const conn = this.wsConns.get(exchange);
    if (!conn) return;
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    if (conn.socket) {
      try {
        conn.socket.close();
      } catch {
        // ignore
      }
    }
    this.wsConns.delete(exchange);
  }

  private openWsForExchange(
    exchange: ExchangeId,
    symbols: string[],
    subscribedKey: string
  ): void {
    this.closeWsForExchange(exchange);

    let wsUrl = '';
    if (exchange === 'binance_usdm') {
      const streams = symbols
        .slice(0, 20)
        .map((s) => `${s.toLowerCase()}@kline_1m`)
        .join('/');
      wsUrl = `wss://fstream.binance.com/stream?streams=${streams}`;
    } else if (exchange === 'bybit_linear') {
      wsUrl = 'wss://stream.bybit.com/v5/public/linear';
    } else if (exchange === 'bingx_swap') {
      wsUrl = 'wss://open-api-swap.bingx.com/swap-market';
    } else {
      return;
    }

    const conn: WsExchangeConn = {
      socket: null,
      subscribedKey,
      pingTimer: null,
      reconnectTimer: null,
      connected: false,
      attempts: 0,
    };
    this.wsConns.set(exchange, conn);

    try {
      const ws = new WebSocket(wsUrl);
      conn.socket = ws;

      ws.addEventListener('open', () => {
        if (this.wsConns.get(exchange) !== conn) return;
        conn.connected = true;
        conn.attempts = 0;

        if (exchange === 'bybit_linear') {
          const args = symbols
            .slice(0, 20)
            .map((s) => `kline.1.${formatBybitSymbol(s)}`);
          ws.send(JSON.stringify({ op: 'subscribe', args }));
          conn.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 'ping' }));
            }
          }, 20_000);
          conn.pingTimer.unref?.();
        } else if (exchange === 'bingx_swap') {
          for (const sym of symbols.slice(0, 20)) {
            ws.send(
              JSON.stringify({
                id: `sub_${sym}`,
                reqType: 'sub',
                dataType: `${formatBingxWsSymbol(sym)}@kline_1m`,
              })
            );
          }
          conn.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send('Ping');
            }
          }, 15_000);
          conn.pingTimer.unref?.();
        }
      });

      ws.addEventListener('message', async (ev) => {
        if (this.wsConns.get(exchange) !== conn) return;
        try {
          let text = '';
          if (typeof ev.data === 'string') {
            text = ev.data;
          } else if (ev.data instanceof ArrayBuffer) {
            const buf = Buffer.from(ev.data);
            try {
              text = zlib.gunzipSync(buf).toString('utf8');
            } catch {
              text = buf.toString('utf8');
            }
          } else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
            const buf = Buffer.from(await ev.data.arrayBuffer());
            try {
              text = zlib.gunzipSync(buf).toString('utf8');
            } catch {
              text = buf.toString('utf8');
            }
          }
          if (!text) return;
          if (text === 'Ping') {
            if (ws.readyState === WebSocket.OPEN) ws.send('Pong');
            return;
          }
          if (text === 'Pong') return;

          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (exchange === 'binance_usdm') {
            const data = parsed.data as Record<string, unknown> | undefined;
            const k = data?.k as Record<string, unknown> | undefined;
            const sym = typeof data?.s === 'string' ? data.s : undefined;
            const closePrice = k ? Number(k.c) : NaN;
            if (sym && Number.isFinite(closePrice)) {
              this.onLiveTick('binance_usdm', sym.toUpperCase(), closePrice);
            }
          } else if (exchange === 'bybit_linear') {
            const topic = typeof parsed.topic === 'string' ? parsed.topic : '';
            const arr = Array.isArray(parsed.data)
              ? (parsed.data as Array<Record<string, unknown>>)
              : [];
            if (topic.startsWith('kline.1.') && arr.length > 0) {
              const sym = topic.slice('kline.1.'.length).toUpperCase();
              const closePrice = Number(arr[arr.length - 1].close);
              if (sym && Number.isFinite(closePrice)) {
                this.onLiveTick('bybit_linear', sym, closePrice);
              }
            }
          } else if (exchange === 'bingx_swap') {
            const dataType =
              typeof parsed.dataType === 'string' ? parsed.dataType : '';
            const arr = Array.isArray(parsed.data)
              ? (parsed.data as Array<Record<string, unknown>>)
              : parsed.data && typeof parsed.data === 'object'
                ? [parsed.data as Record<string, unknown>]
                : [];
            if (dataType.includes('@kline_1m') && arr.length > 0) {
              const rawSym = dataType.split('@')[0];
              const sym = parseBingxWsSymbol(rawSym);
              const closePrice = Number(arr[arr.length - 1].c);
              if (sym && Number.isFinite(closePrice)) {
                this.onLiveTick('bingx_swap', sym, closePrice);
              }
            }
          }
        } catch {
          // ignore malformed ticker frames
        }
      });

      const scheduleReconnect = () => {
        if (this.wsConns.get(exchange) !== conn) return;
        conn.connected = false;
        if (conn.pingTimer) {
          clearInterval(conn.pingTimer);
          conn.pingTimer = null;
        }
        if (!this.isRunning) return;
        const backoff = Math.min(30_000, 1500 * Math.pow(2, conn.attempts));
        conn.attempts++;
        conn.reconnectTimer = setTimeout(() => {
          if (this.isRunning && this.wsConns.get(exchange) === conn) {
            this.openWsForExchange(exchange, symbols, subscribedKey);
          }
        }, backoff);
        conn.reconnectTimer.unref?.();
      };

      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', scheduleReconnect);
    } catch {
      conn.connected = false;
    }
  }
}
