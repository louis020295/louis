import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTaipeiDateTime, formatTaipeiTime } from './utils/taipeiTime.ts';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Bookmark,
  ChevronDown,
  Clock,
  FileSpreadsheet,
  GitCompare,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Square,
} from 'lucide-react';
import { AutoBacktestControlPanel } from './components/AutoBacktestControlPanel.tsx';
import { BtcCorrelationCard } from './components/BtcCorrelationCard.tsx';
import { DerivativesStructureCard } from './components/DerivativesStructureCard.tsx';
import { ExternalNotificationPanel } from './components/ExternalNotificationPanel.tsx';
import { KeyLevelsSessionStrip } from './components/KeyLevelsSessionStrip.tsx';
import { KlineSmcChart } from './components/KlineSmcChart.tsx';
import { MarketBreadthSectorPanel } from './components/MarketBreadthSectorPanel.tsx';
import { MicrostructureCard } from './components/MicrostructureCard.tsx';
import { PositionRiskPlannerCard } from './components/PositionRiskPlannerCard.tsx';
import {
  AddPositionSentinelInput,
  PositionSentinelPanel,
  UpdatePositionSentinelPatch,
} from './components/PositionSentinelPanel.tsx';
import { PriceAlertDrawer } from './components/PriceAlertDrawer.tsx';
import { ProvenanceLine } from './components/ProvenanceLine.tsx';
import {
  SettingsFormulasModal,
  SettingsHubTab,
} from './components/SettingsFormulasModal.tsx';
import { SystemStabilityPanel } from './components/SystemStabilityPanel.tsx';
import {
  AutoBacktestStatusResponse,
  BackgroundSchedulerStatus,
  BacktestResult,
  BacktestTriggerSource,
  CrossExchangeDivergenceResponse,
  DecisionTraceApiResponse,
  ExchangeId,
  ExternalNotificationChannel,
  ExternalNotificationStatusResponse,
  GeminiExplainResponse,
  MarketRadarCategory,
  MarketScanResponse,
  MarketSectorKey,
  NotificationDispatchRecord,
  NotificationOutboxRecord,
  PaperLedgerEntry,
  PaperMonitorHealthResponse,
  PaperMonitorReportResponse,
  PaperMonitorStatusResponse,
  PaperQualityGateDriftResponse,
  PaperQualityMarketRegimesResponse,
  PaperQualityStatusResponse,
  PaperStrategyTrack,
  PaperTrackComparisonStats,
  PaperTrackedSignalRecord,
  Phase7MonitoringWindowReport,
  PortfolioBacktestResult,
  PortfolioRiskConfig,
  PositionSentinelConfig,
  PositionSentinelStatusResponse,
  PriceAlertRule,
  ScanCategory,
  SmcAbComparisonResponse,
  SmcActionState,
  SmcQualityCycleHistoryResponse,
  SmcQualityGateStatsResponse,
  SmcQualityReasonStatsResponse,
  SmcQualitySignalLatencyResponse,
  SmcQualityWindowReportResponse,
  SmcRuleProfile,
  SmcScanStatusResponse,
  SymbolDetailResponse,
  SystemDatabaseHealthResponse,
  SystemWatchdogStatusResponse,
  Timeframe,
  TradeHorizonProfile,
  TRADING_SAFETY_FLAGS,
  TradingCostConfig,
  TriggeredAlertEvent,
  ValidationReadinessResponse,
  WatchdogConfig,
} from './types/market.ts';

type ActiveSection =
  | 'radar'
  | 'divergence'
  | 'backtest'
  | 'paper_ledger'
  | 'position_sentinel'
  | 'notifications'
  | 'paper_quality';

type DetailWorkstationTab =
  | 'chart_smc'
  | 'micro_deriv'
  | 'btc_corr'
  | 'planner_diag';

const WATCHLIST_STORAGE_KEY = 'crypto_radar_watchlist_v1';
const THEME_STORAGE_KEY = 'crypto_radar_theme_v1';
const ALERTS_STORAGE_KEY = 'crypto_radar_price_alerts_v1';
const ALERT_EVENTS_STORAGE_KEY = 'crypto_radar_alert_events_v1';

function getTradeHorizonToneClass(
  category?: TradeHorizonProfile['category']
): string {
  switch (category) {
    case 'SWING_EXTENDED':
      return 'text-violet-300';
    case 'INTRADAY_TREND':
      return 'text-sky-300';
    case 'SCALP_FAST':
      return 'text-amber-300';
    default:
      return 'text-slate-400';
  }
}

function playAlertChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(784, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.32);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.34);
  } catch {
    // ignore audio autoplay restrictions
  }
}

export default function App() {
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [dataMode, setDataMode] = useState<'live' | 'demo'>('live');
  const [selectedExchange, setSelectedExchange] =
    useState<ExchangeId>('binance_usdm');
  const [minQuoteVolume24h, setMinQuoteVolume24h] = useState<number>(0);
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('15m');
  const [categoryFilter, setCategoryFilter] = useState<
    | 'ALL'
    | 'WATCHLIST'
    | 'SMC_CONFIRMED'
    | 'EARLY_IGNITION'
    | 'PULLBACK_READY'
    | 'SMC_WATCH'
    | 'NEAR_MISS'
    | ScanCategory
    | MarketRadarCategory
  >('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeSection, setActiveSection] = useState<ActiveSection>('radar');
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [settingsHubTab, setSettingsHubTab] =
    useState<SettingsHubTab>('settings');
  const [showMarketWeather, setShowMarketWeather] = useState<boolean>(true);
  const [sectorFilter, setSectorFilter] = useState<'ALL' | MarketSectorKey>(
    'ALL'
  );
  const [multiChartSplit, setMultiChartSplit] = useState<boolean>(false);
  const [detailTab, setDetailTab] = useState<DetailWorkstationTab>('chart_smc');
  const [detailExpanded, setDetailExpanded] = useState<boolean>(false);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // ignore storage errors
    }
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('theme-light', themeMode === 'light');
    }
  }, [themeMode]);

  useEffect(() => {
    if (!settingsModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsModalOpen]);

  // Market Scan State
  const [scanData, setScanData] = useState<MarketScanResponse | null>(null);
  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastHttpStatus, setLastHttpStatus] = useState<number | null>(null);

  // Selected Symbol Detail State (Loads OI + 5m/15m/1h/4h Klines + Historical Volume Collector + Decision Trace)
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [symbolDetail, setSymbolDetail] =
    useState<SymbolDetailResponse | null>(null);
  const [decisionTraceData, setDecisionTraceData] =
    useState<DecisionTraceApiResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadedOiBySymbol, setLoadedOiBySymbol] = useState<
    Record<string, { oi: number | null; oiValue: number | null }>
  >({});

  // Cross-Exchange Divergence State
  const [divergenceData, setDivergenceData] =
    useState<CrossExchangeDivergenceResponse | null>(null);
  const [divergenceLoading, setDivergenceLoading] = useState<boolean>(false);
  const [divergenceError, setDivergenceError] = useState<string | null>(null);

  // Gemini AI Explanation State
  const [geminiResult, setGeminiResult] =
    useState<GeminiExplainResponse | null>(null);
  const [geminiLoading, setGeminiLoading] = useState<boolean>(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);

  // Backtest & Persisted Reports State
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(
    null
  );
  const [backtestReports, setBacktestReports] = useState<BacktestResult[]>([]);
  const [backtestLoading, setBacktestLoading] = useState<boolean>(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [backtestBarLimit, setBacktestBarLimit] = useState<number>(240);
  const [costConfigState, setCostConfigState] = useState<TradingCostConfig>({
    makerFeeBps: 2,
    takerFeeBps: 5,
    slippageBps: 3,
    defaultFundingRatePer8h: 0.0001,
    entryOrderType: 'MARKET',
  });
  const [portfolioSymbolsInput, setPortfolioSymbolsInput] = useState<string>(
    'BTCUSDT,ETHUSDT,SOLUSDT,SUIUSDT,BNBUSDT'
  );
  const [portfolioRiskConfig, setPortfolioRiskConfig] =
    useState<PortfolioRiskConfig>({
      maxOpenPositions: 3,
      maxSameDirectionPositions: 2,
      dailyMaxDrawdownR: 3,
      consecutiveLossCooldownLimit: 3,
      cooldownBars: 8,
    });
  const [portfolioBacktestResult, setPortfolioBacktestResult] =
    useState<PortfolioBacktestResult | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState<boolean>(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [smcRuleProfile, setSmcRuleProfile] =
    useState<SmcRuleProfile>('STRICT_PRODUCTION');
  const [abCompareResult, setAbCompareResult] =
    useState<SmcAbComparisonResponse | null>(null);
  const [abCompareLoading, setAbCompareLoading] = useState<boolean>(false);
  const [abCompareError, setAbCompareError] = useState<string | null>(null);
  const [validationReadiness, setValidationReadiness] =
    useState<ValidationReadinessResponse | null>(null);

  // Paper Trading Ledger State (SQLite Persisted, Strictly PAPER ONLY)
  const [paperLedger, setPaperLedger] = useState<PaperLedgerEntry[]>([]);
  const [trackComparisonLive, setTrackComparisonLive] =
    useState<PaperTrackComparisonStats | null>(null);
  const [trackComparisonAll, setTrackComparisonAll] =
    useState<PaperTrackComparisonStats | null>(null);
  const [paperTrackScope, setPaperTrackScope] = useState<
    'LIVE_ONLY' | 'ALL_INCLUDING_DEMO'
  >('LIVE_ONLY');
  const [paperTrackFilter, setPaperTrackFilter] = useState<
    'ALL' | PaperStrategyTrack | 'WAITING_LIMIT' | 'EXPIRED_LIMIT'
  >('ALL');
  const [pullbackTtlMinutes, setPullbackTtlMinutes] = useState<number>(240);
  const [pendingPaperConflict, setPendingPaperConflict] = useState<{
    kind: 'OBSERVATION' | 'EARLY_IGNITION' | 'PULLBACK_LIMIT';
    symbol: string;
    side: 'LONG' | 'SHORT';
    strategyTrack: PaperStrategyTrack;
    conflictingEntries: PaperLedgerEntry[];
    highBtcSameSideCount: number;
    pullbackParams?: {
      side: 'LONG' | 'SHORT';
      entryPrice: number;
      invalidationPrice: number;
      targetPrice: number;
      anchorLabel: string;
      ttlMinutes?: number;
    };
  } | null>(null);
  const [overextendedChaseWarning, setOverextendedChaseWarning] = useState<{
    symbol: string;
    conflictMode?: 'FORCE' | 'REPLACE';
    errorMessage?: string;
  } | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState<boolean>(false);
  const prevPaperLedgerRef = useRef<Map<number, PaperLedgerEntry>>(new Map());
  const fetchPaperLedgerRef = useRef<(() => Promise<void>) | null>(null);
  const activeExchangeRef = useRef<ExchangeId>(selectedExchange);
  activeExchangeRef.current = selectedExchange;
  const marketScanSeqRef = useRef<number>(0);
  const marketScanAbortRef = useRef<AbortController | null>(null);
  const symbolDetailSeqRef = useRef<number>(0);
  const symbolDetailAbortRef = useRef<AbortController | null>(null);

  // Notification & Background Scheduler State
  const [notificationHistory, setNotificationHistory] = useState<
    NotificationDispatchRecord[]
  >([]);
  const [notifyLoading, setNotifyLoading] = useState<boolean>(false);
  const [schedulerStatus, setSchedulerStatus] =
    useState<BackgroundSchedulerStatus | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState<boolean>(false);

  // Auto-Backtest Scheduler & External Notification Channels State
  const [autoBacktestStatus, setAutoBacktestStatus] =
    useState<AutoBacktestStatusResponse | null>(null);
  const [autoBacktestLoading, setAutoBacktestLoading] =
    useState<boolean>(false);
  const [backtestSourceFilter, setBacktestSourceFilter] = useState<
    'ALL' | BacktestTriggerSource
  >('ALL');
  const [backtestSearchQuery, setBacktestSearchQuery] = useState<string>('');
  const [externalNotifyStatus, setExternalNotifyStatus] =
    useState<ExternalNotificationStatusResponse | null>(null);
  const [externalNotifyLoading, setExternalNotifyLoading] =
    useState<boolean>(false);
  const [externalTestingChannel, setExternalTestingChannel] =
    useState<ExternalNotificationChannel | null>(null);
  const [externalTestFeedback, setExternalTestFeedback] = useState<{
    channel: ExternalNotificationChannel;
    ok: boolean;
    message: string;
  } | null>(null);

  // Position Sentinel: Active Trade Trend & Reversal Guardian
  const [positionSentinelStatus, setPositionSentinelStatus] =
    useState<PositionSentinelStatusResponse | null>(null);
  const [positionSentinelLoading, setPositionSentinelLoading] =
    useState<boolean>(false);

  // Phase 3: Full-Market SMC Background Queue Status
  const [smcScanStatus, setSmcScanStatus] =
    useState<SmcScanStatusResponse | null>(null);
  const [smcQueueLoading, setSmcQueueLoading] = useState<boolean>(false);
  const [systemDbHealth, setSystemDbHealth] =
    useState<SystemDatabaseHealthResponse | null>(null);
  const [dbCheckLoading, setDbCheckLoading] = useState<boolean>(false);
  const lastDbHealthFetchAtRef = useRef<number>(0);
  const [watchdogStatus, setWatchdogStatus] =
    useState<SystemWatchdogStatusResponse | null>(null);
  const [watchdogLoading, setWatchdogLoading] = useState<boolean>(false);

  // Phase 5: Paper Shadow Monitor, Signal Quality Report & Notification Sandbox State
  const [paperMonitorStatus, setPaperMonitorStatus] =
    useState<PaperMonitorStatusResponse | null>(null);
  const [paperMonitorReport, setPaperMonitorReport] =
    useState<PaperMonitorReportResponse | null>(null);
  const [paperWindowReport, setPaperWindowReport] =
    useState<Phase7MonitoringWindowReport | null>(null);
  const [paperMonitorHealth, setPaperMonitorHealth] =
    useState<PaperMonitorHealthResponse | null>(null);
  const [paperTrackedSignals, setPaperTrackedSignals] = useState<
    PaperTrackedSignalRecord[]
  >([]);
  const [notificationOutbox, setNotificationOutbox] = useState<
    NotificationOutboxRecord[]
  >([]);
  const [reportWindow, setReportWindow] = useState<'24h' | '7d' | '30d'>('24h');
  const [paperMonitorLoading, setPaperMonitorLoading] =
    useState<boolean>(false);
  const [selectedTrackedSignal, setSelectedTrackedSignal] =
    useState<PaperTrackedSignalRecord | null>(null);

  // Phase 11: SMC Signal Quality & Gate Analysis State
  const [smcQualityGateStats, setSmcQualityGateStats] =
    useState<SmcQualityGateStatsResponse | null>(null);
  const [smcQualityReasonStats, setSmcQualityReasonStats] =
    useState<SmcQualityReasonStatsResponse | null>(null);
  const [smcQualityCycleHistory, setSmcQualityCycleHistory] =
    useState<SmcQualityCycleHistoryResponse | null>(null);
  const [smcQualitySignalLatency, setSmcQualitySignalLatency] =
    useState<SmcQualitySignalLatencyResponse | null>(null);
  const [smcQualityReport7d, setSmcQualityReport7d] =
    useState<SmcQualityWindowReportResponse | null>(null);
  const [smcQualityReport30d, setSmcQualityReport30d] =
    useState<SmcQualityWindowReportResponse | null>(null);

  // Phase 12: Long-Term Paper Quality (30d/60d/90d), Gate Drift & Market Regimes State
  const [paperQualityStatus, setPaperQualityStatus] =
    useState<PaperQualityStatusResponse | null>(null);
  const [paperQualityGateDrift, setPaperQualityGateDrift] =
    useState<PaperQualityGateDriftResponse | null>(null);
  const [paperQualityRegimes, setPaperQualityRegimes] =
    useState<PaperQualityMarketRegimesResponse | null>(null);
  const [paperQualitySelectedWindow, setPaperQualitySelectedWindow] =
    useState<'30d' | '60d' | '90d'>('30d');

  // Browser Watchlist State
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(WATCHLIST_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as string[]) : ['BTCUSDT', 'SOLUSDT'];
    } catch {
      return ['BTCUSDT', 'SOLUSDT'];
    }
  });

  const toggleWatchlist = useCallback((symbol: string) => {
    setWatchlist((prev) => {
      const next = prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : [...prev, symbol];
      try {
        localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  }, []);

  // Interactive Price / Structure Alert Engine State (Local Browser Only)
  const [alertDrawerOpen, setAlertDrawerOpen] = useState<boolean>(false);
  const [alertSoundEnabled, setAlertSoundEnabled] = useState<boolean>(true);
  const [browserNotifyEnabled, setBrowserNotifyEnabled] =
    useState<boolean>(false);
  const [latestAlertToast, setLatestAlertToast] =
    useState<TriggeredAlertEvent | null>(null);
  const [priceAlerts, setPriceAlerts] = useState<PriceAlertRule[]>(() => {
    try {
      const raw = localStorage.getItem(ALERTS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PriceAlertRule[]) : [];
    } catch {
      return [];
    }
  });
  const [alertEvents, setAlertEvents] = useState<TriggeredAlertEvent[]>(() => {
    try {
      const raw = localStorage.getItem(ALERT_EVENTS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as TriggeredAlertEvent[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(priceAlerts));
    } catch {
      // ignore storage errors
    }
  }, [priceAlerts]);

  useEffect(() => {
    try {
      localStorage.setItem(
        ALERT_EVENTS_STORAGE_KEY,
        JSON.stringify(alertEvents.slice(0, 50))
      );
    } catch {
      // ignore storage errors
    }
  }, [alertEvents]);

  const addPriceAlertRule = useCallback(
    (
      draft: Omit<
        PriceAlertRule,
        'id' | 'createdAt' | 'triggered' | 'triggeredAt' | 'triggeredPrice'
      >
    ) => {
      const rule: PriceAlertRule = {
        ...draft,
        id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        triggered: false,
        triggeredAt: null,
        triggeredPrice: null,
        createdAt: new Date().toISOString(),
      };
      setPriceAlerts((prev) => [rule, ...prev]);
    },
    []
  );

  const createPullbackAlertRule = useCallback(
    (price: number, direction: 'LONG' | 'SHORT', note: string) => {
      if (!symbolDetail) return;
      addPriceAlertRule({
        symbol: symbolDetail.symbol,
        conditionType: direction === 'LONG' ? 'PRICE_BELOW' : 'PRICE_ABOVE',
        targetPrice: price,
        zoneLow: symbolDetail.entryZoneAnalysis?.zoneLow ?? null,
        zoneHigh: symbolDetail.entryZoneAnalysis?.zoneHigh ?? null,
        thresholdPct: null,
        note,
        enabled: true,
      });
      setAlertDrawerOpen(true);
    },
    [symbolDetail, addPriceAlertRule]
  );

  const deletePriceAlertRule = useCallback((id: string) => {
    setPriceAlerts((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const togglePriceAlertRule = useCallback((id: string) => {
    setPriceAlerts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  }, []);

  const rearmPriceAlertRule = useCallback((id: string) => {
    setPriceAlerts((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              enabled: true,
              triggered: false,
              triggeredAt: null,
              triggeredPrice: null,
            }
          : r
      )
    );
  }, []);

  const handleToggleBrowserNotify = useCallback(async () => {
    if (browserNotifyEnabled) {
      setBrowserNotifyEnabled(false);
      return;
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        setBrowserNotifyEnabled(true);
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        setBrowserNotifyEnabled(perm === 'granted');
      }
    }
  }, [browserNotifyEnabled]);

  // Evaluate local alert rules on every scanData / symbolDetail refresh
  useEffect(() => {
    const candidates = scanData?.candidates ?? [];
    if (candidates.length === 0 && !symbolDetail) return;

    const priceMap = new Map<
      string,
      { lastPrice: number; fundingRate: number | null; change24h: number }
    >();
    for (const c of candidates) {
      priceMap.set(c.symbol, {
        lastPrice: c.lastPrice,
        fundingRate: c.fundingRate,
        change24h: c.priceChangePercent24h,
      });
    }
    if (symbolDetail?.candidate) {
      priceMap.set(symbolDetail.symbol, {
        lastPrice: symbolDetail.candidate.lastPrice,
        fundingRate: symbolDetail.candidate.fundingRate,
        change24h: symbolDetail.candidate.priceChangePercent24h,
      });
    }

    const newlyTriggered: TriggeredAlertEvent[] = [];
    const triggeredMap = new Map<
      string,
      { triggeredAt: string; triggerPrice: number | null }
    >();

    for (const rule of priceAlerts) {
      if (!rule.enabled || rule.triggered) continue;
      const snap = priceMap.get(rule.symbol);
      if (!snap) continue;

      let hit = false;
      let msg = '';
      if (
        rule.conditionType === 'PRICE_ABOVE' &&
        rule.targetPrice !== null &&
        snap.lastPrice >= rule.targetPrice
      ) {
        hit = true;
        msg = `${rule.symbol} 現價 ${snap.lastPrice} 突破目標價 ${rule.targetPrice}（${rule.note}）`;
      } else if (
        rule.conditionType === 'PRICE_BELOW' &&
        rule.targetPrice !== null &&
        snap.lastPrice <= rule.targetPrice
      ) {
        hit = true;
        msg = `${rule.symbol} 現價 ${snap.lastPrice} 跌破目標價 ${rule.targetPrice}（${rule.note}）`;
      } else if (
        (rule.conditionType === 'TOUCH_OB' ||
          rule.conditionType === 'TOUCH_FVG') &&
        rule.zoneLow !== null &&
        rule.zoneHigh !== null &&
        snap.lastPrice >= rule.zoneLow &&
        snap.lastPrice <= rule.zoneHigh
      ) {
        hit = true;
        msg = `${rule.symbol} 現價 ${snap.lastPrice} 進入 ${
          rule.conditionType === 'TOUCH_OB' ? 'OB' : 'FVG'
        } 區間 [${rule.zoneLow}–${rule.zoneHigh}]（${rule.note}）`;
      } else if (
        rule.conditionType === 'FUNDING_EXTREME' &&
        rule.thresholdPct !== null &&
        snap.fundingRate !== null &&
        Math.abs(snap.fundingRate * 100) >= rule.thresholdPct
      ) {
        hit = true;
        msg = `${rule.symbol} 資金費率達 ${(snap.fundingRate * 100).toFixed(4)}%，超過門檻 ±${rule.thresholdPct}%`;
      } else if (
        rule.conditionType === 'BTC_MOVE_SHOCK' &&
        rule.thresholdPct !== null &&
        Math.abs(snap.change24h) >= rule.thresholdPct
      ) {
        hit = true;
        msg = `BTCUSDT 24h 波動達 ${snap.change24h >= 0 ? '+' : ''}${snap.change24h.toFixed(2)}%，觸發急變預警`;
      }

      if (hit) {
        const nowIso = new Date().toISOString();
        triggeredMap.set(rule.id, {
          triggeredAt: nowIso,
          triggerPrice: snap.lastPrice,
        });
        newlyTriggered.push({
          id: `ev_${Date.now()}_${rule.id}`,
          ruleId: rule.id,
          symbol: rule.symbol,
          conditionType: rule.conditionType,
          messageZh: msg,
          triggerPrice: snap.lastPrice,
          triggeredAt: nowIso,
        });
      }
    }

    if (newlyTriggered.length > 0) {
      setPriceAlerts((prev) =>
        prev.map((r) => {
          const hitInfo = triggeredMap.get(r.id);
          return hitInfo
            ? {
                ...r,
                triggered: true,
                triggeredAt: hitInfo.triggeredAt,
                triggeredPrice: hitInfo.triggerPrice,
              }
            : r;
        })
      );
      setAlertEvents((prev) => [...newlyTriggered, ...prev].slice(0, 50));
      setLatestAlertToast(newlyTriggered[0]);
      if (alertSoundEnabled) {
        playAlertChime();
      }
      if (
        browserNotifyEnabled &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification(`條件告警觸發 · ${newlyTriggered[0].symbol}`, {
            body: newlyTriggered[0].messageZh,
          });
        } catch {
          // ignore notification error in iframe
        }
      }
    }
  }, [
    scanData,
    symbolDetail,
    priceAlerts,
    alertSoundEnabled,
    browserNotifyEnabled,
  ]);

  // 1. Execute Full Market Scan
  const executeMarketScan = useCallback(
    async (overrideMode?: 'live' | 'demo', overrideExchange?: ExchangeId) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      const reqSeq = ++marketScanSeqRef.current;

      marketScanAbortRef.current?.abort('SUPERSEDED');
      const controller = new AbortController();
      marketScanAbortRef.current = controller;
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('REQUEST_TIMEOUT', 'AbortError'));
      }, 45000);

      setScanLoading(true);
      setScanError(null);

      try {
        const params = new URLSearchParams({
          mode: targetMode,
          exchange: targetExchange,
          minQuoteVolume24h: String(minQuoteVolume24h),
          compact: '1',
        });
        const res = await fetch(`/api/scan?${params.toString()}`, {
          signal: controller.signal,
        });
        if (reqSeq !== marketScanSeqRef.current) return;
        setLastHttpStatus(res.status);
        const data = (await res.json()) as MarketScanResponse;
        if (reqSeq !== marketScanSeqRef.current) return;

        setScanData(data);
        if (data.smcScanStatus) {
          setSmcScanStatus(data.smcScanStatus);
        }
        if (!res.ok || data.apiError) {
          setSymbolDetail(null);
          setScanError(
            data.apiErrorDetail
              ? `${data.apiError || '即時資料不可用'} (${data.apiErrorDetail})`
              : data.apiError || '即時資料不可用'
          );
        } else {
          void fetchPaperLedgerRef.current?.();
        }
      } catch (err) {
        if (reqSeq !== marketScanSeqRef.current) {
          return;
        }
        const isAbortErr =
          controller.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError');
        if (isAbortErr && !timedOut) {
          return;
        }
        const msg = timedOut
          ? '即時掃描請求逾時 (超過 45 秒)，系統仍在背景處理中，請點擊「重試即時 API」'
          : err instanceof Error
            ? err.message
            : '網路連線失敗，無法取得行情';
        const fetchedAt = new Date().toISOString();
        const emptyStats = {
          totalContractsScanned: 0,
          insufficientHistoryCount: 0,
          baselineUnstableCount: 0,
          liquidityRejectedCount: 0,
          momentumPassedCount: 0,
          relativeBtcPassedCount: 0,
          marketRadarLongCount: 0,
          marketRadarShortCount: 0,
          smcPendingCount: 0,
          smcWaitCount: 0,
          smcWatchCount: 0,
          smcLongCandidateCount: 0,
          smcShortCandidateCount: 0,
          smcHighRiskCount: 0,
          smcGateNotConfirmedCount: 0,
          finalCategorySmcMismatchCount: 0,
        };
        setLastHttpStatus(503);
        setSymbolDetail(null);
        setDecisionTraceData(null);
        setScanData({
          safety: TRADING_SAFETY_FLAGS,
          mode: 'live',
          exchange: targetExchange,
          isDemo: false,
          fallback: false,
          source: 'Public Futures REST API',
          fetchedAt,
          stale: false,
          missingData: ['ALL_MARKET_TICKERS'],
          ruleVersion: 'v2.1.0-phase2-15m-consistent-vol-multiex',
          btcBenchmarkChange24h: null,
          candidates: [],
          summaryCounts: {
            多頭候選: 0,
            空頭候選: 0,
            準備觀察: 0,
            高風險: 0,
          },
          marketRadarCounts: {
            雷達多頭觀察: 0,
            雷達空頭觀察: 0,
            準備觀察: 0,
            高風險: 0,
          },
          smcStateCounts: {
            PENDING: 0,
            WAIT: 0,
            WATCH: 0,
            'LONG CANDIDATE': 0,
            'SHORT CANDIDATE': 0,
            'HIGH RISK': 0,
          },
          waitWatchReasonBreakdown: {},
          waitWatchReasonStats: {
            scope: 'EVALUATED_WAIT_WATCH_ONLY',
            uniqueSymbolCount: 0,
            totalReasonOccurrences: 0,
            reasonOccurrenceCount: {},
            mutuallyExclusivePrimaryReasonCount: {},
          },
          highRiskReasonStats: {
            scope: 'EVALUATED_HIGH_RISK_ONLY',
            uniqueSymbolCount: 0,
            totalReasonOccurrences: 0,
            reasonOccurrenceCount: {},
            mutuallyExclusivePrimaryReasonCount: {},
          },
          nonCandidateReasonStats: {
            scope: 'EVALUATED_NON_CANDIDATE_ALL',
            uniqueSymbolCount: 0,
            totalReasonOccurrences: 0,
            reasonOccurrenceCount: {},
            mutuallyExclusivePrimaryReasonCount: {},
          },
          radarGateReasonStats: {
            uniqueSymbolCount: 0,
            totalReasonOccurrences: 0,
            reasonOccurrenceCount: {},
            mutuallyExclusivePrimaryReasonCount: {},
          },
          marketStats: emptyStats,
          ...emptyStats,
          dataQuality: {
            ...emptyStats,
            totalSymbolsScanned: 0,
            validSymbolsCount: 0,
            missingFundingCount: 0,
            missingSpreadCount: 0,
            staleRecordCount: 0,
            lowLiquidityCount: 0,
            extremeFundingCount: 0,
            historicalVolumeReadyCount: 0,
            scannerConfig: {
              MIN_QUOTE_VOLUME_24H: 15_000_000,
              MAX_ALLOWED_SPREAD_PERCENT: 0.15,
              LOW_LIQUIDITY_POLICY: 'ONLY_HIGH_RISK_OR_WATCH_OR_WAIT',
            },
            volumeProxyNotice: '即時資料不可用',
            generatedAt: fetchedAt,
            source: 'Public Futures REST API',
            isDemo: false,
          },
          provenance: {
            source: 'Public Futures REST API',
            fetchedAt,
            stale: false,
            fallback: false,
            missingData: ['ALL_MARKET_TICKERS'],
            isDemo: false,
          },
          apiError: '即時資料不可用',
          apiErrorDetail: msg,
        });
        setScanError(`即時資料不可用 (${msg})`);
      } finally {
        clearTimeout(timeoutId);
        if (reqSeq === marketScanSeqRef.current) {
          setScanLoading(false);
        }
      }
    },
    [dataMode, selectedExchange, minQuoteVolume24h]
  );

  // 2. Load Single Symbol Detail & Decision Trace
  const loadSymbolDetail = useCallback(
    async (
      symbol: string,
      timeframe: Timeframe = selectedTimeframe,
      overrideMode?: 'live' | 'demo',
      overrideExchange?: ExchangeId
    ) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      const reqSeq = ++symbolDetailSeqRef.current;

      symbolDetailAbortRef.current?.abort('SUPERSEDED');
      const controller = new AbortController();
      symbolDetailAbortRef.current = controller;

      setSelectedSymbol(symbol);
      setDetailLoading(true);
      setDetailError(null);
      setGeminiResult(null);
      setGeminiError(null);

      try {
        const params = new URLSearchParams({
          mode: targetMode,
          exchange: targetExchange,
          timeframe,
        });
        const [res, traceRes] = await Promise.all([
          fetch(`/api/symbol/${encodeURIComponent(symbol)}?${params.toString()}`, {
            signal: controller.signal,
          }),
          fetch(
            `/api/symbol/${encodeURIComponent(symbol)}/decision-trace?${params.toString()}`,
            { signal: controller.signal }
          ),
        ]);
        if (reqSeq !== symbolDetailSeqRef.current) return;
        const data = await res.json();
        if (reqSeq !== symbolDetailSeqRef.current) return;

        if (!res.ok) {
          setDetailError(
            data.error || `即時資料不可用：無法載入 ${symbol} 結構詳情`
          );
          setSymbolDetail(null);
          setDecisionTraceData(null);
          return;
        }

        const detail = data as SymbolDetailResponse;
        setSymbolDetail(detail);
        if (traceRes.ok) {
          const traceJson = (await traceRes.json()) as DecisionTraceApiResponse;
          if (reqSeq === symbolDetailSeqRef.current) {
            setDecisionTraceData(traceJson);
          }
        } else if (detail.decisionTrace) {
          setDecisionTraceData(detail.decisionTrace as DecisionTraceApiResponse);
        } else {
          setDecisionTraceData(null);
        }
        setLoadedOiBySymbol((prev) => ({
          ...prev,
          [symbol]: {
            oi: detail.openInterest.openInterest,
            oiValue: detail.openInterest.openInterestValue,
          },
        }));
      } catch (err) {
        if (reqSeq !== symbolDetailSeqRef.current) return;
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        const msg =
          err instanceof Error ? err.message : '載入單一幣種 K 線與 OI 失敗';
        setDetailError(`即時資料不可用：${msg}`);
        setSymbolDetail(null);
        setDecisionTraceData(null);
      } finally {
        if (reqSeq === symbolDetailSeqRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [dataMode, selectedExchange, selectedTimeframe]
  );

  // 3. Load Cross-Exchange Divergence (Binance + Bybit + BingX)
  const fetchDivergence = useCallback(
    async (overrideMode?: 'live' | 'demo') => {
      const targetMode = overrideMode ?? dataMode;
      setDivergenceLoading(true);
      setDivergenceError(null);
      try {
        const res = await fetch(
          `/api/divergence?mode=${targetMode}&limit=30`
        );
        const data = await res.json();
        if (!res.ok) {
          setDivergenceError(data.apiError || '跨交易所背離資料不可用');
          setDivergenceData(null);
          return;
        }
        setDivergenceData(data as CrossExchangeDivergenceResponse);
      } catch (err) {
        setDivergenceError(
          err instanceof Error ? err.message : '跨交易所比較連線失敗'
        );
      } finally {
        setDivergenceLoading(false);
      }
    },
    [dataMode]
  );

  // 4. Request Gemini AI Explanation from server-side /api/explain
  const requestGeminiExplanation = useCallback(async () => {
    if (!symbolDetail) return;
    setGeminiLoading(true);
    setGeminiError(null);

    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate: symbolDetail.candidate,
          smcAnalysis: symbolDetail.smcAnalysis,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGeminiError(data.error || 'Gemini 解釋生成失敗');
        return;
      }
      setGeminiResult(data as GeminiExplainResponse);
    } catch (err) {
      setGeminiError(
        err instanceof Error ? err.message : '呼叫 /api/explain 失敗'
      );
    } finally {
      setGeminiLoading(false);
    }
  }, [symbolDetail]);

  // 5. Run Deterministic Lookahead-Free Backtest & Load Persisted Reports
  const fetchBacktestReports = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/reports');
      if (res.ok) {
        const data = await res.json();
        setBacktestReports(data.reports || []);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchValidationReadiness = useCallback(
    async (overrideExchange?: ExchangeId) => {
      const targetEx = overrideExchange ?? selectedExchange;
      const ex = targetEx === 'demo_synthetic' ? 'binance_usdm' : targetEx;
      try {
        const res = await fetch(`/api/validation/readiness?exchange=${ex}`);
        if (res.ok) {
          setValidationReadiness(
            (await res.json()) as ValidationReadinessResponse
          );
        }
      } catch {
        // ignore background readiness error
      }
    },
    [selectedExchange]
  );

  const executeBacktest = useCallback(
    async (
      symbol: string,
      timeframe: Timeframe,
      writeToPaperLedger = false
    ) => {
      setBacktestLoading(true);
      setBacktestError(null);

      try {
        const res = await fetch('/api/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol,
            timeframe,
            mode: dataMode,
            exchange: selectedExchange,
            barLimit: backtestBarLimit,
            includeWalkForward: true,
            writeToPaperLedger,
            smcRuleProfile,
            costConfig: costConfigState,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBacktestError(data.error || '回測執行失敗');
          setBacktestResult(null);
          return;
        }
        setBacktestResult(data as BacktestResult);
        await fetchBacktestReports();
        if (writeToPaperLedger) {
          await fetchPaperLedger();
        }
        void fetchValidationReadiness();
      } catch (err) {
        setBacktestError(
          err instanceof Error ? err.message : '呼叫 /api/backtest 失敗'
        );
      } finally {
        setBacktestLoading(false);
      }
    },
    [
      dataMode,
      selectedExchange,
      backtestBarLimit,
      smcRuleProfile,
      costConfigState,
      fetchBacktestReports,
      fetchValidationReadiness,
    ]
  );

  const executePortfolioBacktest = useCallback(async () => {
    setPortfolioLoading(true);
    setPortfolioError(null);
    const parsedSymbols = portfolioSymbolsInput
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      .slice(0, 15);
    try {
      const res = await fetch('/api/backtest/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols:
            parsedSymbols.length > 0
              ? parsedSymbols
              : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
          timeframe: selectedTimeframe,
          mode: dataMode,
          exchange: selectedExchange,
          barLimit: backtestBarLimit,
          smcRuleProfile,
          costConfig: costConfigState,
          riskConfig: portfolioRiskConfig,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPortfolioError(data.error || '多幣種組合回測執行失敗');
        return;
      }
      setPortfolioBacktestResult(data as PortfolioBacktestResult);
      void fetchValidationReadiness();
    } catch (err) {
      setPortfolioError(
        err instanceof Error ? err.message : '呼叫 /api/backtest/portfolio 失敗'
      );
    } finally {
      setPortfolioLoading(false);
    }
  }, [
    portfolioSymbolsInput,
    selectedTimeframe,
    dataMode,
    selectedExchange,
    backtestBarLimit,
    smcRuleProfile,
    costConfigState,
    portfolioRiskConfig,
    fetchValidationReadiness,
  ]);

  const executeSmcAbComparison = useCallback(async () => {
    setAbCompareLoading(true);
    setAbCompareError(null);
    const parsedSymbols = portfolioSymbolsInput
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
      .slice(0, 15);
    try {
      const res = await fetch('/api/backtest/ab-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols:
            parsedSymbols.length > 0
              ? parsedSymbols
              : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
          timeframe: selectedTimeframe,
          mode: dataMode,
          exchange: selectedExchange,
          barLimit: backtestBarLimit,
          costConfig: costConfigState,
          riskConfig: portfolioRiskConfig,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAbCompareError(data.error || 'A/B 規則對比回測執行失敗');
        return;
      }
      setAbCompareResult(data as SmcAbComparisonResponse);
    } catch (err) {
      setAbCompareError(
        err instanceof Error ? err.message : '呼叫 /api/backtest/ab-compare 失敗'
      );
    } finally {
      setAbCompareLoading(false);
    }
  }, [
    portfolioSymbolsInput,
    selectedTimeframe,
    dataMode,
    selectedExchange,
    backtestBarLimit,
    costConfigState,
    portfolioRiskConfig,
  ]);

  // 6. Paper Trading Ledger Actions (Strictly PAPER ONLY)
  const applyPaperLedgerUpdate = useCallback(
    (entries: PaperLedgerEntry[]) => {
      const prevMap = prevPaperLedgerRef.current;
      const eventsToAdd: TriggeredAlertEvent[] = [];
      if (prevMap.size > 0) {
        for (const entry of entries) {
          const prev = prevMap.get(entry.id);
          if (!prev) continue;
          if (
            prev.fillStatus === 'WAITING_LIMIT' &&
            entry.fillStatus === 'FILLED'
          ) {
            eventsToAdd.push({
              id: `paper_fill_${entry.id}_${Date.now()}`,
              ruleId: `paper_limit_${entry.id}`,
              symbol: entry.symbol,
              conditionType:
                entry.side === 'LONG' ? 'PRICE_BELOW' : 'PRICE_ABOVE',
              messageZh: `[PAPER] ${entry.symbol} 回踩限價單 #${entry.id} 已觸價成交 ($${entry.entryPrice})`,
              triggerPrice: entry.currentPrice,
              triggeredAt: entry.filledAt ?? new Date().toISOString(),
            });
          } else if (
            prev.status === 'OPEN' &&
            prev.fillStatus === 'WAITING_LIMIT' &&
            entry.status === 'CLOSED_EXPIRED'
          ) {
            const reasonZh =
              entry.expiredReason === 'TARGET_MISSED'
                ? '價格未回踩即先行達標，自動作廢'
                : entry.expiredReason === 'INVALIDATED_BEFORE_FILL'
                  ? '未觸價前跌破/突破結構失效位，自動作廢'
                  : '超過等待時限 (TTL)，自動過期作廢';
            eventsToAdd.push({
              id: `paper_exp_${entry.id}_${Date.now()}`,
              ruleId: `paper_limit_${entry.id}`,
              symbol: entry.symbol,
              conditionType:
                entry.side === 'LONG' ? 'PRICE_BELOW' : 'PRICE_ABOVE',
              messageZh: `[PAPER] ${entry.symbol} 回踩限價單 #${entry.id} ${reasonZh} (0R)`,
              triggerPrice: entry.currentPrice,
              triggeredAt: entry.closedAt ?? new Date().toISOString(),
            });
          }
        }
      }
      prevPaperLedgerRef.current = new Map(entries.map((e) => [e.id, e]));
      setPaperLedger(entries);

      if (eventsToAdd.length > 0) {
        setAlertEvents((prev) => [...eventsToAdd, ...prev].slice(0, 50));
        setLatestAlertToast(eventsToAdd[0]);
        if (alertSoundEnabled) {
          playAlertChime();
        }
      }
    },
    [alertSoundEnabled]
  );

  const fetchPaperLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      const res = await fetch('/api/paper-ledger');
      if (res.ok) {
        const data = await res.json();
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
      }
    } finally {
      setLedgerLoading(false);
    }
  }, [applyPaperLedgerUpdate]);

  fetchPaperLedgerRef.current = fetchPaperLedger;

  const portfolioHighBtcStats = useMemo(() => {
    const corrBySymbol = new Map(
      (scanData?.candidates ?? []).map((c) => [c.symbol, c.btcCorrelation])
    );
    let longCount = 0;
    let shortCount = 0;
    for (const e of paperLedger) {
      if (e.status !== 'OPEN' || (e.fillStatus ?? 'FILLED') !== 'FILLED') {
        continue;
      }
      const corr =
        corrBySymbol.get(e.symbol) ??
        (symbolDetail?.symbol === e.symbol ? symbolDetail.btcCorrelation : null);
      const isHigh =
        e.symbol === 'BTCUSDT' ||
        (corr !== undefined &&
          corr !== null &&
          corr.status === 'READY' &&
          !corr.isBenchmark &&
          (corr.tier === 'HIGH_COUPLED' || (corr.pearson15m ?? 0) >= 0.7));
      if (!isHigh) continue;
      if (e.side === 'LONG') longCount++;
      else shortCount++;
    }
    return { longCount, shortCount };
  }, [paperLedger, scanData, symbolDetail]);

  const activeSymbolOpenOrders = useMemo(() => {
    if (!symbolDetail) return [];
    return paperLedger.filter(
      (e) => e.status === 'OPEN' && e.symbol === symbolDetail.symbol
    );
  }, [paperLedger, symbolDetail]);

  useEffect(() => {
    setPendingPaperConflict(null);
    setOverextendedChaseWarning(null);
  }, [symbolDetail?.symbol]);

  const submitPaperObservation = useCallback(
    async (
      conflictMode?: 'FORCE' | 'REPLACE',
      allowOverextendedMarketEntry = false
    ) => {
      if (!symbolDetail) return;
      const { candidate, smcAnalysis } = symbolDetail;
      const isOverextended =
        symbolDetail.entryZoneAnalysis?.status === 'OVEREXTENDED';
      if (isOverextended && !allowOverextendedMarketEntry) {
        setOverextendedChaseWarning({
          symbol: candidate.symbol,
          conflictMode,
        });
        return;
      }

      const atr = smcAnalysis.atr14 ?? candidate.lastPrice * 0.015;
      const side: 'LONG' | 'SHORT' =
        smcAnalysis.actionState === 'SHORT CANDIDATE' ||
        candidate.category === '空頭候選'
          ? 'SHORT'
          : 'LONG';
      const isFormalSmc =
        smcAnalysis.actionState === 'LONG CANDIDATE' ||
        smcAnalysis.actionState === 'SHORT CANDIDATE';
      const strategyTrack: PaperStrategyTrack = isFormalSmc
        ? 'FORMAL_SMC_MARKET'
        : candidate.earlyIgnition && candidate.earlyIgnition.status !== 'NONE'
          ? 'EARLY_IGNITION'
          : 'MANUAL_OBSERVATION';

      const conflicts = paperLedger.filter(
        (e) =>
          e.status === 'OPEN' &&
          e.symbol === candidate.symbol &&
          e.side === side &&
          (e.strategyTrack ?? 'MANUAL_OBSERVATION') === strategyTrack
      );
      if (conflicts.length > 0 && !conflictMode) {
        const highBtcSameSideCount =
          side === 'LONG'
            ? portfolioHighBtcStats.longCount
            : portfolioHighBtcStats.shortCount;
        setPendingPaperConflict({
          kind: 'OBSERVATION',
          symbol: candidate.symbol,
          side,
          strategyTrack,
          conflictingEntries: conflicts,
          highBtcSameSideCount,
        });
        return;
      }

      if (conflictMode === 'REPLACE' && conflicts.length > 0) {
        for (const c of conflicts) {
          await fetch(`/api/paper-ledger/${c.id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exitPrice: candidate.lastPrice,
              notes: '[PAPER ONLY] 由新單覆蓋結算/撤銷',
            }),
          });
        }
      }

      const entryPrice = candidate.lastPrice;
      const riskDist = Math.max(atr * 1.8, entryPrice * 0.006);
      const rewardDist = riskDist * 1.67;
      const invalidationPrice =
        side === 'LONG'
          ? Number((entryPrice - riskDist).toPrecision(6))
          : Number((entryPrice + riskDist).toPrecision(6));
      const targetPrice =
        side === 'LONG'
          ? Number((entryPrice + rewardDist).toPrecision(6))
          : Number((entryPrice - rewardDist).toPrecision(6));

      const res = await fetch('/api/paper-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: candidate.symbol,
          exchange: selectedExchange,
          timeframe: symbolDetail.primaryTimeframe,
          side,
          category: candidate.category,
          actionState: smcAnalysis.actionState,
          strategyTrack,
          fillStatus: 'FILLED',
          entryAnchorLabel: isFormalSmc ? '正式 SMC 現價進場' : '即時觀察基準價',
          entryPrice,
          invalidationPrice,
          targetPrice,
          ruleVersion: smcAnalysis.ruleVersion,
          entryZoneStatus: symbolDetail.entryZoneAnalysis?.status,
          allowOverextendedMarketEntry,
          evidences: [
            ...candidate.evidences
              .filter((e) => e.passed)
              .map((e) => `${e.label}: ${e.value}`),
            ...smcAnalysis.evidences
              .filter((e) => e.passed)
              .map((e) => `${e.label}: ${e.value}`),
          ],
          notes: `[PAPER ONLY] 紙上結構觀察紀錄 (${selectedExchange})`,
          provenance: symbolDetail.provenance,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPendingPaperConflict(null);
        setOverextendedChaseWarning(null);
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
        if (dataMode === 'demo') {
          setPaperTrackScope('ALL_INCLUDING_DEMO');
        }
        setActiveSection('paper_ledger');
      } else {
        const errBody = await res.json().catch(() => ({} as { error?: string }));
        setOverextendedChaseWarning({
          symbol: candidate.symbol,
          conflictMode,
          errorMessage:
            errBody?.error ||
            '反追價保護攔截：請改掛回踩限價單或確認風險後重試。',
        });
      }
    },
    [
      symbolDetail,
      selectedExchange,
      dataMode,
      applyPaperLedgerUpdate,
      paperLedger,
      portfolioHighBtcStats,
    ]
  );

  const recordPaperObservation = useCallback(
    () => submitPaperObservation(),
    [submitPaperObservation]
  );

  const submitEarlyIgnitionPaper = useCallback(
    async (conflictMode?: 'FORCE' | 'REPLACE') => {
      if (!symbolDetail) return;
      const { candidate, smcAnalysis } = symbolDetail;
      const ign = candidate.earlyIgnition;
      if (!ign || ign.status === 'NONE' || ign.direction === 'NEUTRAL') return;

      const side: 'LONG' | 'SHORT' = ign.direction === 'LONG' ? 'LONG' : 'SHORT';
      const conflicts = paperLedger.filter(
        (e) =>
          e.status === 'OPEN' &&
          e.symbol === candidate.symbol &&
          e.side === side &&
          e.strategyTrack === 'EARLY_IGNITION'
      );
      if (conflicts.length > 0 && !conflictMode) {
        const highBtcSameSideCount =
          side === 'LONG'
            ? portfolioHighBtcStats.longCount
            : portfolioHighBtcStats.shortCount;
        setPendingPaperConflict({
          kind: 'EARLY_IGNITION',
          symbol: candidate.symbol,
          side,
          strategyTrack: 'EARLY_IGNITION',
          conflictingEntries: conflicts,
          highBtcSameSideCount,
        });
        return;
      }

      if (conflictMode === 'REPLACE' && conflicts.length > 0) {
        for (const c of conflicts) {
          await fetch(`/api/paper-ledger/${c.id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exitPrice: candidate.lastPrice,
              notes: '[PAPER ONLY] 由新早鳥紙上單覆蓋結算',
            }),
          });
        }
      }

      const entryPrice = candidate.lastPrice;
      const atr = smcAnalysis.atr14 ?? entryPrice * 0.012;
      const invalidationPrice =
        ign.invalidationPrice !== null &&
        ((side === 'LONG' && ign.invalidationPrice < entryPrice) ||
          (side === 'SHORT' && ign.invalidationPrice > entryPrice))
          ? ign.invalidationPrice
          : side === 'LONG'
            ? Number((entryPrice - atr * 1.1).toPrecision(6))
            : Number((entryPrice + atr * 1.1).toPrecision(6));
      const riskDist = Math.max(
        Math.abs(entryPrice - invalidationPrice),
        entryPrice * 0.003
      );
      const targetPrice =
        side === 'LONG'
          ? Number((entryPrice + riskDist * 2.2).toPrecision(6))
          : Number((entryPrice - riskDist * 2.2).toPrecision(6));

      const res = await fetch('/api/paper-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: candidate.symbol,
          exchange: selectedExchange,
          timeframe: ign.triggerTimeframe ?? symbolDetail.primaryTimeframe,
          side,
          category: candidate.category,
          actionState: smcAnalysis.actionState,
          strategyTrack: 'EARLY_IGNITION',
          fillStatus: 'FILLED',
          entryAnchorLabel: ign.headlineZh,
          entryPrice,
          invalidationPrice,
          targetPrice,
          ruleVersion: smcAnalysis.ruleVersion,
          evidences: [`Early Ignition (${ign.ignitionScore}分): ${ign.headlineZh}`],
          notes: `[PAPER ONLY] 早鳥起漲軌道觀察 (${ign.tier})`,
          provenance: symbolDetail.provenance,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPendingPaperConflict(null);
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
        if (dataMode === 'demo') {
          setPaperTrackScope('ALL_INCLUDING_DEMO');
        }
        setActiveSection('paper_ledger');
      }
    },
    [
      symbolDetail,
      selectedExchange,
      dataMode,
      applyPaperLedgerUpdate,
      paperLedger,
      portfolioHighBtcStats,
    ]
  );

  const recordEarlyIgnitionPaper = useCallback(
    () => submitEarlyIgnitionPaper(),
    [submitEarlyIgnitionPaper]
  );

  const submitPullbackLimitPaper = useCallback(
    async (
      params: {
        side: 'LONG' | 'SHORT';
        entryPrice: number;
        invalidationPrice: number;
        targetPrice: number;
        anchorLabel: string;
        ttlMinutes?: number;
      },
      conflictMode?: 'FORCE' | 'REPLACE'
    ) => {
      if (!symbolDetail) return;
      const { candidate, smcAnalysis } = symbolDetail;
      const conflicts = paperLedger.filter(
        (e) =>
          e.status === 'OPEN' &&
          e.symbol === candidate.symbol &&
          e.side === params.side &&
          e.strategyTrack === 'SMC_PULLBACK_LIMIT'
      );
      if (conflicts.length > 0 && !conflictMode) {
        const highBtcSameSideCount =
          params.side === 'LONG'
            ? portfolioHighBtcStats.longCount
            : portfolioHighBtcStats.shortCount;
        setPendingPaperConflict({
          kind: 'PULLBACK_LIMIT',
          symbol: candidate.symbol,
          side: params.side,
          strategyTrack: 'SMC_PULLBACK_LIMIT',
          conflictingEntries: conflicts,
          highBtcSameSideCount,
          pullbackParams: params,
        });
        return;
      }

      if (conflictMode === 'REPLACE' && conflicts.length > 0) {
        for (const c of conflicts) {
          await fetch(`/api/paper-ledger/${c.id}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exitPrice: candidate.lastPrice,
              notes: '[PAPER ONLY] 由新回踩限價單覆蓋撤銷/結算',
            }),
          });
        }
      }

      const alreadyAtOrBeyondEntry =
        params.side === 'LONG'
          ? candidate.lastPrice <= params.entryPrice
          : candidate.lastPrice >= params.entryPrice;
      const chosenTtl = params.ttlMinutes ?? pullbackTtlMinutes;

      const res = await fetch('/api/paper-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: candidate.symbol,
          exchange: selectedExchange,
          timeframe: symbolDetail.primaryTimeframe,
          side: params.side,
          category: candidate.category,
          actionState: smcAnalysis.actionState,
          strategyTrack: 'SMC_PULLBACK_LIMIT',
          fillStatus: alreadyAtOrBeyondEntry ? 'FILLED' : 'WAITING_LIMIT',
          entryAnchorLabel: params.anchorLabel,
          ttlMinutes: alreadyAtOrBeyondEntry ? undefined : chosenTtl,
          entryPrice: params.entryPrice,
          invalidationPrice: params.invalidationPrice,
          targetPrice: params.targetPrice,
          ruleVersion: smcAnalysis.ruleVersion,
          evidences: [`回踩限價錨點: ${params.anchorLabel}`],
          notes: `[PAPER ONLY] FVG/OB 回踩限價掛單 (${params.anchorLabel})`,
          provenance: symbolDetail.provenance,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPendingPaperConflict(null);
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
        if (dataMode === 'demo') {
          setPaperTrackScope('ALL_INCLUDING_DEMO');
        }
        if (!alreadyAtOrBeyondEntry) {
          const condType: PriceAlertRule['conditionType'] =
            params.side === 'LONG' ? 'PRICE_BELOW' : 'PRICE_ABOVE';
          const duplicateExists = priceAlerts.some(
            (r) =>
              r.enabled &&
              !r.triggered &&
              r.symbol === candidate.symbol &&
              r.conditionType === condType &&
              r.targetPrice !== null &&
              Math.abs(r.targetPrice - params.entryPrice) <=
                params.entryPrice * 1e-4
          );
          if (!duplicateExists) {
            addPriceAlertRule({
              symbol: candidate.symbol,
              conditionType: condType,
              targetPrice: params.entryPrice,
              zoneLow: symbolDetail.entryZoneAnalysis?.zoneLow ?? null,
              zoneHigh: symbolDetail.entryZoneAnalysis?.zoneHigh ?? null,
              thresholdPct: null,
              note: `同步回踩限價單觸價提醒 (${params.anchorLabel})`,
              enabled: true,
            });
          }
        }
        setActiveSection('paper_ledger');
      }
    },
    [
      symbolDetail,
      selectedExchange,
      dataMode,
      pullbackTtlMinutes,
      applyPaperLedgerUpdate,
      priceAlerts,
      addPriceAlertRule,
      paperLedger,
      portfolioHighBtcStats,
    ]
  );

  const recordPullbackLimitPaper = useCallback(
    (params: {
      side: 'LONG' | 'SHORT';
      entryPrice: number;
      invalidationPrice: number;
      targetPrice: number;
      anchorLabel: string;
      ttlMinutes?: number;
    }) => submitPullbackLimitPaper(params),
    [submitPullbackLimitPaper]
  );

  const extendPaperLimitPosition = useCallback(
    async (id: number, extraMinutes = 120) => {
      const res = await fetch(`/api/paper-ledger/${id}/extend-ttl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraMinutes }),
      });
      if (res.ok) {
        const data = await res.json();
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
      }
    },
    [applyPaperLedgerUpdate]
  );

  const closePaperPosition = useCallback(
    async (id: number, currentPrice: number) => {
      const res = await fetch(`/api/paper-ledger/${id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exitPrice: currentPrice,
          notes: '[PAPER ONLY] 手動結算紙上觀察紀錄',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        applyPaperLedgerUpdate(data.entries || []);
        if (data.trackComparisonLive) {
          setTrackComparisonLive(data.trackComparisonLive);
        }
        if (data.trackComparisonAll) {
          setTrackComparisonAll(data.trackComparisonAll);
        }
      }
    },
    [applyPaperLedgerUpdate]
  );

  // 7. Trigger Notification Dry-Run Preview & Background Scheduler Control
  const dispatchNotificationPreview = useCallback(
    async (channel: 'TELEGRAM' | 'TRADINGVIEW_WEBHOOK') => {
      if (!symbolDetail) return;
      setNotifyLoading(true);

      const { candidate, smcAnalysis } = symbolDetail;
      const confirmedEvidences = [
        ...candidate.evidences
          .filter((e) => e.passed)
          .map((e) => `${e.label}: ${e.value}`),
        ...smcAnalysis.evidences
          .filter((e) => e.passed)
          .map((e) => `${e.label}: ${e.value}`),
      ];

      const riskWarnings: string[] = [];
      if (candidate.isLowLiquidity) {
        riskWarnings.push('低流動性：不列入一般候選');
      }
      if (candidate.extremeFunding) {
        riskWarnings.push('極端資金費率擠壓風險');
      }
      if (smcAnalysis.waitReasons.length > 0) {
        riskWarnings.push(...smcAnalysis.waitReasons);
      }

      try {
        const res = await fetch('/api/notify/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            payload: {
              symbol: candidate.symbol,
              category: candidate.category,
              actionState: smcAnalysis.actionState,
              finalTradeSignal: candidate.finalTradeSignal,
              smcEvaluationStatus: smcAnalysis.smcEvaluationStatus,
              stale: symbolDetail.provenance.stale,
              fallback: symbolDetail.provenance.fallback,
              waitReasons: smcAnalysis.waitReasons,
              score: candidate.score,
              confirmedEvidences,
              missingData: symbolDetail.provenance.missingData,
              riskWarnings,
              source: symbolDetail.provenance.source,
              fetchedAt: symbolDetail.provenance.fetchedAt,
              safetyBanner: `${TRADING_SAFETY_FLAGS.mode} / ${TRADING_SAFETY_FLAGS.liveOrders}`,
            },
          }),
        });
        const data = await res.json();
        if (res.ok && data.history) {
          setNotificationHistory(data.history);
          setActiveSection('notifications');
        }
      } finally {
        setNotifyLoading(false);
      }
    },
    [symbolDetail]
  );

  const fetchSchedulerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduler/status');
      if (res.ok) {
        setSchedulerStatus(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchAutoBacktestStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-backtest/status');
      if (res.ok) {
        setAutoBacktestStatus(
          (await res.json()) as AutoBacktestStatusResponse
        );
      }
    } catch {
      // ignore
    }
  }, []);

  const updateAutoBacktestConfig = useCallback(
    async (patch: {
      enabled?: boolean;
      intervalMs?: number;
      timeframe?: Timeframe;
      maxSymbolsPerRun?: number;
      includeWatchlist?: boolean;
      watchlistSymbols?: string[];
      exchange?: ExchangeId;
    }) => {
      setAutoBacktestLoading(true);
      try {
        const res = await fetch('/api/auto-backtest/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...patch,
            watchlistSymbols: patch.watchlistSymbols ?? watchlist,
          }),
        });
        if (res.ok) {
          setAutoBacktestStatus(
            (await res.json()) as AutoBacktestStatusResponse
          );
        }
      } finally {
        setAutoBacktestLoading(false);
      }
    },
    [watchlist]
  );

  const runAutoBacktestNow = useCallback(async () => {
    setAutoBacktestLoading(true);
    try {
      const res = await fetch('/api/auto-backtest/run-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: dataMode,
          exchange: selectedExchange,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          status?: AutoBacktestStatusResponse;
        };
        if (data.status) {
          setAutoBacktestStatus(data.status);
        }
        await fetchBacktestReports();
      }
    } finally {
      setAutoBacktestLoading(false);
    }
  }, [dataMode, selectedExchange, fetchBacktestReports]);

  const fetchExternalNotifyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/notify/external/status');
      if (res.ok) {
        setExternalNotifyStatus(
          (await res.json()) as ExternalNotificationStatusResponse
        );
      }
    } catch {
      // ignore
    }
  }, []);

  const updateExternalNotifyConfig = useCallback(
    async (patch: {
      telegramEnabled?: boolean;
      discordEnabled?: boolean;
      notifyFormalSmc?: boolean;
      notifyEarlyIgnition?: boolean;
    }) => {
      setExternalNotifyLoading(true);
      try {
        const res = await fetch('/api/notify/external/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          setExternalNotifyStatus(
            (await res.json()) as ExternalNotificationStatusResponse
          );
        }
      } finally {
        setExternalNotifyLoading(false);
      }
    },
    []
  );

  const sendExternalTestNotification = useCallback(
    async (channel: ExternalNotificationChannel) => {
      setExternalTestingChannel(channel);
      setExternalTestFeedback(null);
      try {
        const res = await fetch('/api/notify/external/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            symbol: selectedSymbol,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          record?: { reason?: string };
          status?: ExternalNotificationStatusResponse;
          error?: string;
        };
        if (data.status) {
          setExternalNotifyStatus(data.status);
        }
        setExternalTestFeedback({
          channel,
          ok: Boolean(data.ok),
          message:
            data.record?.reason ??
            data.error ??
            (data.ok ? '測試通知已成功送出' : '測試通知發送失敗'),
        });
      } catch (err) {
        setExternalTestFeedback({
          channel,
          ok: false,
          message:
            err instanceof Error ? err.message : '測試通知網路連線失敗',
        });
      } finally {
        setExternalTestingChannel(null);
      }
    },
    [selectedSymbol]
  );

  const fetchPositionSentinelStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/position-sentinel/status');
      if (res.ok) {
        setPositionSentinelStatus(
          (await res.json()) as PositionSentinelStatusResponse
        );
      }
    } catch {
      // ignore background status fetch failure
    }
  }, []);

  const refreshPositionSentinelCheck = useCallback(async () => {
    setPositionSentinelLoading(true);
    try {
      const res = await fetch('/api/position-sentinel/check-now', {
        method: 'POST',
      });
      if (res.ok) {
        setPositionSentinelStatus(
          (await res.json()) as PositionSentinelStatusResponse
        );
      }
    } finally {
      setPositionSentinelLoading(false);
    }
  }, []);

  const importPaperToPositionSentinel = useCallback(async () => {
    setPositionSentinelLoading(true);
    try {
      const res = await fetch('/api/position-sentinel/import-paper', {
        method: 'POST',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          status?: PositionSentinelStatusResponse;
        };
        if (data.status) setPositionSentinelStatus(data.status);
      }
    } finally {
      setPositionSentinelLoading(false);
    }
  }, []);

  const addPositionToSentinel = useCallback(
    async (input: AddPositionSentinelInput) => {
      setPositionSentinelLoading(true);
      try {
        const res = await fetch('/api/position-sentinel/positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, evaluateNow: true }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            status?: PositionSentinelStatusResponse;
          };
          if (data.status) setPositionSentinelStatus(data.status);
        }
      } finally {
        setPositionSentinelLoading(false);
      }
    },
    []
  );

  const updatePositionInSentinel = useCallback(
    async (id: string, patch: UpdatePositionSentinelPatch) => {
      setPositionSentinelLoading(true);
      try {
        const res = await fetch(`/api/position-sentinel/positions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            status?: PositionSentinelStatusResponse;
          };
          if (data.status) setPositionSentinelStatus(data.status);
          if (patch.syncPaperLedger) {
            await fetchPaperLedgerRef.current?.();
          }
        }
      } finally {
        setPositionSentinelLoading(false);
      }
    },
    []
  );

  const deletePositionFromSentinel = useCallback(async (id: string) => {
    setPositionSentinelLoading(true);
    try {
      const res = await fetch(`/api/position-sentinel/positions/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          status?: PositionSentinelStatusResponse;
        };
        if (data.status) setPositionSentinelStatus(data.status);
      }
    } finally {
      setPositionSentinelLoading(false);
    }
  }, []);

  const updatePositionSentinelConfig = useCallback(
    async (patch: Partial<PositionSentinelConfig>) => {
      setPositionSentinelLoading(true);
      try {
        const res = await fetch('/api/position-sentinel/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          setPositionSentinelStatus(
            (await res.json()) as PositionSentinelStatusResponse
          );
        }
      } finally {
        setPositionSentinelLoading(false);
      }
    },
    []
  );

  const quickGuardSymbolDetail = useCallback(async () => {
    if (!symbolDetail) return;
    const { candidate, smcAnalysis } = symbolDetail;
    const atr = smcAnalysis.atr14 ?? candidate.lastPrice * 0.015;
    const side: 'LONG' | 'SHORT' =
      smcAnalysis.actionState === 'SHORT CANDIDATE' ||
      candidate.category === '空頭候選' ||
      candidate.marketRadarCategory === '雷達空頭觀察'
        ? 'SHORT'
        : 'LONG';
    const entryPrice = candidate.lastPrice;
    const invalidationPrice =
      symbolDetail.entryZoneAnalysis?.stopLossPrice ??
      (side === 'LONG'
        ? Number((entryPrice - atr * 1.5).toPrecision(6))
        : Number((entryPrice + atr * 1.5).toPrecision(6)));
    const targetPrice =
      symbolDetail.entryZoneAnalysis?.targetPrice ??
      (side === 'LONG'
        ? Number((entryPrice + atr * 2.5).toPrecision(6))
        : Number((entryPrice - atr * 2.5).toPrecision(6)));
    await addPositionToSentinel({
      symbol: candidate.symbol,
      exchange:
        selectedExchange === 'demo_synthetic'
          ? 'binance_usdm'
          : selectedExchange,
      side,
      timeframe: symbolDetail.primaryTimeframe,
      entryPrice,
      invalidationPrice,
      targetPrice,
      leverage: 1,
      notes: `[快速加入守護] ${candidate.finalTradeSignal}`,
    });
    setActiveSection('position_sentinel');
  }, [symbolDetail, selectedExchange, addPositionToSentinel]);

  const fetchSystemDbHealth = useCallback(
    async (overrideMode?: 'live' | 'demo', overrideExchange?: ExchangeId) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      try {
        const res = await fetch(
          `/api/system/database-health?mode=${targetMode}&exchange=${targetExchange}`
        );
        if (res.ok && activeExchangeRef.current === targetExchange) {
          lastDbHealthFetchAtRef.current = Date.now();
          setSystemDbHealth((await res.json()) as SystemDatabaseHealthResponse);
        }
      } catch {
        // ignore
      }
    },
    [dataMode, selectedExchange]
  );

  const runSystemDbCheck = useCallback(async () => {
    setDbCheckLoading(true);
    try {
      const res = await fetch('/api/system/database-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: dataMode,
          exchange: selectedExchange,
          createBackup: true,
        }),
      });
      if (res.ok) {
        lastDbHealthFetchAtRef.current = Date.now();
        setSystemDbHealth((await res.json()) as SystemDatabaseHealthResponse);
      }
    } finally {
      setDbCheckLoading(false);
    }
  }, [dataMode, selectedExchange]);

  const fetchWatchdogStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/watchdog/status');
      if (res.ok) {
        setWatchdogStatus((await res.json()) as SystemWatchdogStatusResponse);
      }
    } catch {
      // ignore
    }
  }, []);

  const runWatchdogCheck = useCallback(async () => {
    setWatchdogLoading(true);
    try {
      const res = await fetch('/api/system/watchdog/run-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceHeartbeat: true, forceBackup: true }),
      });
      if (res.ok) {
        const payload = (await res.json()) as {
          status: SystemWatchdogStatusResponse;
        };
        if (payload?.status) {
          setWatchdogStatus(payload.status);
        }
        void fetchSystemDbHealth();
      }
    } finally {
      setWatchdogLoading(false);
    }
  }, [fetchSystemDbHealth]);

  const updateWatchdogConfig = useCallback(
    async (patch: Partial<Omit<WatchdogConfig, 'updatedAt'>>) => {
      setWatchdogLoading(true);
      try {
        const res = await fetch('/api/system/watchdog/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          setWatchdogStatus((await res.json()) as SystemWatchdogStatusResponse);
        }
      } finally {
        setWatchdogLoading(false);
      }
    },
    []
  );

  const fetchSmcScanStatus = useCallback(
    async (overrideMode?: 'live' | 'demo', overrideExchange?: ExchangeId) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      try {
        const res = await fetch(
          `/api/smc-scan/status?mode=${targetMode}&exchange=${targetExchange}&compact=1`
        );
        if (res.ok && activeExchangeRef.current === targetExchange) {
          setSmcScanStatus((await res.json()) as SmcScanStatusResponse);
        }
        if (Date.now() - lastDbHealthFetchAtRef.current >= 15000) {
          void fetchSystemDbHealth(targetMode, targetExchange);
        }
      } catch {
        // ignore
      }
    },
    [dataMode, selectedExchange, fetchSystemDbHealth]
  );

  const controlSmcQueue = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'step') => {
      setSmcQueueLoading(true);
      try {
        const endpoint =
          action === 'pause'
            ? '/api/smc-scan/pause'
            : action === 'resume' || action === 'step'
              ? '/api/smc-scan/resume'
              : '/api/smc-scan/start';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: selectedExchange,
            mode: dataMode,
            watchlistSymbols: watchlist,
            processBatchNow: action === 'step' || action === 'start',
            batchLimit: action === 'step' ? 4 : undefined,
          }),
        });
        if (res.ok) {
          const status = (await res.json()) as SmcScanStatusResponse;
          setSmcScanStatus(status);
          if (action === 'step' || action === 'start') {
            await executeMarketScan(dataMode, selectedExchange);
          }
        }
      } finally {
        setSmcQueueLoading(false);
      }
    },
    [selectedExchange, dataMode, watchlist, executeMarketScan]
  );

  const retryStuckSmcJobs = useCallback(async () => {
    setSmcQueueLoading(true);
    try {
      const res = await fetch('/api/smc-scan/retry-stuck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: selectedExchange,
          mode: dataMode,
        }),
      });
      if (res.ok) {
        await fetchSmcScanStatus(dataMode, selectedExchange);
        await executeMarketScan(dataMode, selectedExchange);
      }
    } finally {
      setSmcQueueLoading(false);
    }
  }, [selectedExchange, dataMode, fetchSmcScanStatus, executeMarketScan]);

  const refreshSingleSmcSymbol = useCallback(
    async (symbol: string) => {
      setSmcQueueLoading(true);
      try {
        const res = await fetch(`/api/smc-scan/refresh/${symbol}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: selectedExchange,
            mode: dataMode,
            executeImmediately: true,
          }),
        });
        if (res.ok) {
          const body = await res.json();
          if (body.status) {
            setSmcScanStatus(body.status as SmcScanStatusResponse);
          }
          await executeMarketScan(dataMode, selectedExchange);
          if (symbol === selectedSymbol) {
            await loadSymbolDetail(symbol, selectedTimeframe);
          }
        }
      } finally {
        setSmcQueueLoading(false);
      }
    },
    [
      selectedExchange,
      dataMode,
      selectedSymbol,
      selectedTimeframe,
      executeMarketScan,
    ]
  );

  const controlScheduler = useCallback(
    async (action: 'start' | 'stop' | 'run_once') => {
      setSchedulerLoading(true);
      try {
        const res = await fetch('/api/scheduler/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            exchange: selectedExchange,
            mode: dataMode,
          }),
        });
        if (res.ok) {
          setSchedulerStatus(await res.json());
          if (action === 'run_once') {
            const histRes = await fetch('/api/notify/history');
            if (histRes.ok) {
              const hData = await histRes.json();
              setNotificationHistory(hData.history || []);
            }
          }
        }
      } finally {
        setSchedulerLoading(false);
      }
    },
    [selectedExchange, dataMode]
  );

  const fetchPaperMonitorAll = useCallback(
    async (
      targetWindow?: '24h' | '7d' | '30d',
      targetExchange?: ExchangeId
    ) => {
      const win = targetWindow ?? reportWindow;
      const rawEx = targetExchange ?? selectedExchange;
      if (rawEx === 'demo_synthetic' && !targetExchange) {
        return;
      }
      const ex: ExchangeId =
        rawEx === 'demo_synthetic' ? 'binance_usdm' : rawEx;

      const fetchAndApply = async <T,>(
        url: string,
        apply: (data: T) => void
      ): Promise<void> => {
        try {
          const res = await fetch(url);
          if (
            res.ok &&
            (activeExchangeRef.current === ex || rawEx === 'demo_synthetic')
          ) {
            const data = (await res.json()) as T;
            apply(data);
          }
        } catch {
          // ignore network errors during background refresh
        }
      };

      // Wave 1: Primary monitor status, report, signals, outbox, and live gate/reason stats (updates each panel progressively as it resolves)
      await Promise.allSettled([
        fetchAndApply<PaperMonitorStatusResponse>(
          `/api/paper-monitor/status?exchange=${ex}`,
          setPaperMonitorStatus
        ),
        fetchAndApply<PaperMonitorReportResponse>(
          `/api/paper-monitor/report?window=${win}&exchange=${ex}`,
          setPaperMonitorReport
        ),
        fetchAndApply<Phase7MonitoringWindowReport>(
          `/api/paper-monitor/window-report?exchange=${ex}`,
          setPaperWindowReport
        ),
        fetchAndApply<PaperMonitorHealthResponse>(
          `/api/paper-monitor/health?exchange=${ex}`,
          setPaperMonitorHealth
        ),
        fetchAndApply<{ signals?: PaperTrackedSignalRecord[] }>(
          `/api/paper-monitor/signals?exchange=${ex}&limit=50`,
          (sData) => setPaperTrackedSignals(sData.signals || [])
        ),
        fetchAndApply<{
          outbox?: NotificationOutboxRecord[];
          entries?: NotificationOutboxRecord[];
        }>(`/api/notification-sandbox/outbox?limit=50`, (oData) =>
          setNotificationOutbox(oData.outbox || oData.entries || [])
        ),
        fetchAndApply<SmcQualityGateStatsResponse>(
          `/api/smc-quality/gate-stats?exchange=${ex}`,
          setSmcQualityGateStats
        ),
        fetchAndApply<SmcQualityReasonStatsResponse>(
          `/api/smc-quality/reason-stats?exchange=${ex}`,
          setSmcQualityReasonStats
        ),
      ]);

      // Wave 2: Historical & calibration panels (staggered to avoid browser connection/SQLite contention)
      await Promise.allSettled([
        fetchAndApply<SmcQualityCycleHistoryResponse>(
          `/api/smc-quality/cycle-history?exchange=${ex}&limit=20`,
          setSmcQualityCycleHistory
        ),
        fetchAndApply<SmcQualitySignalLatencyResponse>(
          `/api/smc-quality/signal-latency?exchange=${ex}`,
          setSmcQualitySignalLatency
        ),
        fetchAndApply<SmcQualityWindowReportResponse>(
          `/api/smc-quality/report?window=7d&exchange=${ex}`,
          setSmcQualityReport7d
        ),
        fetchAndApply<SmcQualityWindowReportResponse>(
          `/api/smc-quality/report?window=30d&exchange=${ex}`,
          setSmcQualityReport30d
        ),
        fetchAndApply<PaperQualityStatusResponse>(
          `/api/paper-quality/status?exchange=${ex}`,
          setPaperQualityStatus
        ),
        fetchAndApply<PaperQualityGateDriftResponse>(
          `/api/paper-quality/gate-drift?exchange=${ex}`,
          setPaperQualityGateDrift
        ),
        fetchAndApply<PaperQualityMarketRegimesResponse>(
          `/api/paper-quality/market-regimes?window=30d&exchange=${ex}`,
          setPaperQualityRegimes
        ),
      ]);
    },
    [reportWindow, selectedExchange]
  );

  const controlPaperMonitor = useCallback(
    async (action: 'start' | 'pause' | 'resume') => {
      setPaperMonitorLoading(true);
      try {
        const endpoint =
          action === 'start'
            ? '/api/paper-monitor/start'
            : action === 'pause'
              ? '/api/paper-monitor/pause'
              : '/api/paper-monitor/resume';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchange: selectedExchange,
            mode: 'live',
            runImmediateCycle: action === 'start' || action === 'resume',
          }),
        });
        if (res.ok) {
          setPaperMonitorStatus(
            (await res.json()) as PaperMonitorStatusResponse
          );
        }
        await fetchPaperMonitorAll(reportWindow, selectedExchange);
        await fetchPaperLedger();
      } finally {
        setPaperMonitorLoading(false);
      }
    },
    [selectedExchange, reportWindow, fetchPaperMonitorAll, fetchPaperLedger]
  );

  const triggerSandboxPreviewForSignal = useCallback(
    async (
      signalId: string,
      channel: 'TELEGRAM_SANDBOX' | 'TRADINGVIEW_SANDBOX'
    ) => {
      setPaperMonitorLoading(true);
      try {
        await fetch(`/api/notification-sandbox/preview/${signalId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel }),
        });
        await fetchPaperMonitorAll(reportWindow, selectedExchange);
      } finally {
        setPaperMonitorLoading(false);
      }
    },
    [reportWindow, selectedExchange, fetchPaperMonitorAll]
  );

  // Initial load: prioritize critical primary market scan first so the live table renders within ~1-2s,
  // then yield briefly so React commits the table before starting secondary background analytics without contention.
  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      await executeMarketScan();
      if (cancelled) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (cancelled) return;
      await Promise.allSettled([
        fetchPaperLedger(),
        fetchBacktestReports(),
        fetchSchedulerStatus(),
        fetchAutoBacktestStatus(),
        fetchExternalNotifyStatus(),
        fetchPositionSentinelStatus(),
        fetchSystemDbHealth(),
        fetchWatchdogStatus(),
        fetchValidationReadiness(),
      ]);
      if (cancelled) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (cancelled) return;
      void fetchPaperMonitorAll();
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [
    executeMarketScan,
    fetchPaperLedger,
    fetchBacktestReports,
    fetchSchedulerStatus,
    fetchAutoBacktestStatus,
    fetchExternalNotifyStatus,
    fetchPositionSentinelStatus,
    fetchPaperMonitorAll,
    fetchSystemDbHealth,
    fetchWatchdogStatus,
    fetchValidationReadiness,
  ]);

  // Real-time Position Sentinel SSE stream + lightweight fallback poll
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      const id = setInterval(() => {
        void fetchPositionSentinelStatus();
      }, 15000);
      return () => clearInterval(id);
    }
    const es = new EventSource('/api/position-sentinel/stream');
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as PositionSentinelStatusResponse;
        if (parsed && Array.isArray(parsed.positions)) {
          setPositionSentinelStatus(parsed);
        }
      } catch {
        // ignore malformed SSE chunk
      }
    };
    return () => {
      es.close();
    };
  }, [fetchPositionSentinelStatus]);

  useEffect(() => {
    if (
      (activeSection === 'paper_quality' || settingsModalOpen) &&
      Date.now() - lastDbHealthFetchAtRef.current >= 5000
    ) {
      void fetchSystemDbHealth();
      void fetchWatchdogStatus();
    }
    if (
      activeSection === 'backtest' ||
      activeSection === 'paper_quality' ||
      activeSection === 'paper_ledger'
    ) {
      void fetchValidationReadiness();
    }
  }, [
    activeSection,
    settingsModalOpen,
    fetchSystemDbHealth,
    fetchWatchdogStatus,
    fetchValidationReadiness,
  ]);

  // Keep backend auto-backtest watchlist synced whenever user stars/unstars symbols
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch('/api/auto-backtest/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchlistSymbols: watchlist }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d) setAutoBacktestStatus(d as AutoBacktestStatusResponse);
        })
        .catch(() => {
          // ignore background sync error
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [watchlist]);

  const prevWorkerStateRef = useRef<'RUNNING' | 'PAUSED' | 'IDLE' | undefined>(
    undefined
  );
  const prevCompletedCyclesRef = useRef<number | undefined>(undefined);

  // Poll lightweight SMC queue status & Paper Monitor status only after initial scan commits (5s RUNNING, 10s IDLE)
  useEffect(() => {
    if (!scanData) return;
    const intervalMs = smcScanStatus?.workerState === 'RUNNING' ? 5000 : 10000;
    const id = setInterval(() => {
      void fetchSmcScanStatus();
      if (dataMode === 'live' && !scanData?.apiError) {
        const targetEx =
          selectedExchange === 'demo_synthetic' ? 'binance_usdm' : selectedExchange;
        void fetch(`/api/paper-monitor/status?exchange=${targetEx}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) {
              setPaperMonitorStatus(d as PaperMonitorStatusResponse);
            }
          })
          .catch(() => {});
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [
    scanData,
    smcScanStatus?.workerState,
    dataMode,
    selectedExchange,
    fetchSmcScanStatus,
  ]);

  // Refresh full scan & Paper Quality reports only when a Live cycle completes or transitions RUNNING -> IDLE
  useEffect(() => {
    const currState = smcScanStatus?.workerState;
    const currCompleted = smcScanStatus?.completedScanCyclesCount;
    const prevState = prevWorkerStateRef.current;
    const prevCompleted = prevCompletedCyclesRef.current;
    prevWorkerStateRef.current = currState;
    prevCompletedCyclesRef.current = currCompleted;

    const cycleFinished =
      (prevState === 'RUNNING' && currState === 'IDLE') ||
      (prevCompleted !== undefined &&
        currCompleted !== undefined &&
        currCompleted > prevCompleted);

    if (
      cycleFinished &&
      dataMode === 'live' &&
      !scanData?.apiError &&
      !scanLoading
    ) {
      void fetchPaperMonitorAll();
      if (!detailLoading) {
        void executeMarketScan('live', selectedExchange);
      }
    }
  }, [
    smcScanStatus?.workerState,
    smcScanStatus?.completedScanCyclesCount,
    scanData?.apiError,
    dataMode,
    scanLoading,
    detailLoading,
    selectedExchange,
    executeMarketScan,
    fetchPaperMonitorAll,
  ]);

  // When scan finishes and candidates are available, load detail for selectedSymbol
  useEffect(() => {
    if (scanData && scanData.candidates.length > 0 && !scanData.apiError) {
      const exists = scanData.candidates.some(
        (c) => c.symbol === selectedSymbol
      );
      const target = exists ? selectedSymbol : scanData.candidates[0].symbol;
      loadSymbolDetail(target, selectedTimeframe);
    }
  }, [scanData, selectedTimeframe]);

  const nearMissRecords = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    const isDemo = dataMode === 'demo' || Boolean(scanData.provenance?.isDemo);
    const scanList = scanData.smcGateDiagnostics?.nearMissSymbols ?? [];
    const liveStatusList =
      !isDemo ? smcScanStatus?.smcGateDiagnostics?.nearMissSymbols ?? [] : [];
    const raw =
      isDemo
        ? scanList
        : liveStatusList.length >= scanList.length
          ? liveStatusList
          : scanList;
    const scoreBySymbol = new Map<string, number>(
      (scanData.candidates ?? []).map((c) => [c.symbol, c.score])
    );
    return [...raw].sort((a, b) => {
      if (a.missingGateCount !== b.missingGateCount) {
        return a.missingGateCount - b.missingGateCount;
      }
      const sa = a.score ?? scoreBySymbol.get(a.symbol) ?? 0;
      const sb = b.score ?? scoreBySymbol.get(b.symbol) ?? 0;
      return sb - sa;
    });
  }, [dataMode, smcScanStatus, scanData]);

  const nearMissSymbolSet = useMemo(() => {
    if (!scanData || scanData.apiError) return new Set<string>();
    const set = new Set<string>(nearMissRecords.map((r) => r.symbol));
    for (const c of scanData.candidates ?? []) {
      if (
        c.nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
        c.nearMissStatus === 'NEAR_MISS_TWO_GATES'
      ) {
        set.add(c.symbol);
      }
    }
    return set;
  }, [nearMissRecords, scanData]);

  const top3Recommended = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return [...scanData.candidates]
      .sort((a, b) => {
        const aFormal = a.finalTradeSignal !== 'NONE' ? 1 : 0;
        const bFormal = b.finalTradeSignal !== 'NONE' ? 1 : 0;
        if (aFormal !== bFormal) return bFormal - aFormal;
        return b.score - a.score;
      })
      .slice(0, 3);
  }, [scanData]);

  const watchApproachCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return [...scanData.candidates]
      .filter(
        (c) =>
          c.smcActionState === 'LONG CANDIDATE' ||
          c.smcActionState === 'SHORT CANDIDATE' ||
          c.smcActionState === 'WATCH'
      )
      .sort((a, b) => {
        const aFormal =
          a.smcActionState === 'LONG CANDIDATE' ||
          a.smcActionState === 'SHORT CANDIDATE'
            ? 1
            : 0;
        const bFormal =
          b.smcActionState === 'LONG CANDIDATE' ||
          b.smcActionState === 'SHORT CANDIDATE'
            ? 1
            : 0;
        if (aFormal !== bFormal) return bFormal - aFormal;
        return b.score - a.score;
      });
  }, [scanData]);

  const confirmedSmcCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return [...scanData.candidates]
      .filter(
        (c) =>
          c.smcActionState === 'LONG CANDIDATE' ||
          c.smcActionState === 'SHORT CANDIDATE'
      )
      .sort((a, b) => b.score - a.score);
  }, [scanData]);

  const confirmedSmcLongCount = useMemo(
    () =>
      confirmedSmcCandidates.filter((c) => c.smcActionState === 'LONG CANDIDATE')
        .length,
    [confirmedSmcCandidates]
  );

  const confirmedSmcShortCount = useMemo(
    () =>
      confirmedSmcCandidates.filter(
        (c) => c.smcActionState === 'SHORT CANDIDATE'
      ).length,
    [confirmedSmcCandidates]
  );

  const earlyIgnitionCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return [...scanData.candidates]
      .filter((c) => c.earlyIgnition && c.earlyIgnition.status !== 'NONE')
      .sort(
        (a, b) =>
          (b.earlyIgnition?.ignitionScore ?? 0) -
          (a.earlyIgnition?.ignitionScore ?? 0)
      );
  }, [scanData]);

  const pullbackReadyCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return [...scanData.candidates]
      .filter((c) => {
        const ez = c.entryZoneSummary;
        if (!ez || ez.idealPullbackEntry === null) return false;
        if (ez.direction !== 'LONG' && ez.direction !== 'SHORT') return false;
        if (
          c.smcActionState === 'HIGH RISK' ||
          c.marketRadarCategory === '高風險'
        ) {
          return false;
        }
        return (
          ez.status === 'NEAR_POI' || ez.status === 'NEAR_PULLBACK_ZONE'
        );
      })
      .sort((a, b) => {
        const ezA = a.entryZoneSummary!;
        const ezB = b.entryZoneSummary!;
        const tierA = ezA.status === 'NEAR_POI' ? 0 : 1;
        const tierB = ezB.status === 'NEAR_POI' ? 0 : 1;
        if (tierA !== tierB) return tierA - tierB;
        const candA =
          a.smcActionState === 'LONG CANDIDATE' ||
          a.smcActionState === 'SHORT CANDIDATE'
            ? 0
            : 1;
        const candB =
          b.smcActionState === 'LONG CANDIDATE' ||
          b.smcActionState === 'SHORT CANDIDATE'
            ? 0
            : 1;
        if (candA !== candB) return candA - candB;
        const distA = Math.abs(ezA.distanceToZonePct ?? 99);
        const distB = Math.abs(ezB.distanceToZonePct ?? 99);
        if (Math.abs(distA - distB) > 0.15) return distA - distB;
        return (ezB.pullbackRR ?? 0) - (ezA.pullbackRR ?? 0);
      });
  }, [scanData]);

  const filteredCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    const baseList =
      categoryFilter === 'PULLBACK_READY'
        ? pullbackReadyCandidates
        : scanData.candidates;
    return baseList.filter((c) => {
      if (categoryFilter === 'WATCHLIST' && !watchlist.includes(c.symbol)) {
        return false;
      }
      if (categoryFilter === 'PULLBACK_READY') {
        // already filtered and sniper-sorted via pullbackReadyCandidates
      } else if (categoryFilter === 'SMC_CONFIRMED') {
        if (
          c.smcActionState !== 'LONG CANDIDATE' &&
          c.smcActionState !== 'SHORT CANDIDATE'
        ) {
          return false;
        }
      } else if (categoryFilter === 'EARLY_IGNITION') {
        if (!c.earlyIgnition || c.earlyIgnition.status === 'NONE') {
          return false;
        }
      } else if (categoryFilter === 'SMC_WATCH') {
        if (
          c.smcActionState !== 'WATCH' &&
          c.smcActionState !== 'LONG CANDIDATE' &&
          c.smcActionState !== 'SHORT CANDIDATE'
        ) {
          return false;
        }
      } else if (categoryFilter === 'NEAR_MISS') {
        if (
          !nearMissSymbolSet.has(c.symbol) &&
          c.nearMissStatus !== 'NEAR_MISS_ONE_GATE' &&
          c.nearMissStatus !== 'NEAR_MISS_TWO_GATES'
        ) {
          return false;
        }
      } else if (
        categoryFilter === '雷達多頭觀察' ||
        categoryFilter === '多頭候選'
      ) {
        if (
          c.marketRadarCategory !== '雷達多頭觀察' &&
          c.category !== '多頭候選'
        ) {
          return false;
        }
      } else if (
        categoryFilter === '雷達空頭觀察' ||
        categoryFilter === '空頭候選'
      ) {
        if (
          c.marketRadarCategory !== '雷達空頭觀察' &&
          c.category !== '空頭候選'
        ) {
          return false;
        }
      } else if (categoryFilter === '準備觀察') {
        if (
          c.marketRadarCategory !== '準備觀察' &&
          c.category !== '準備觀察'
        ) {
          return false;
        }
      } else if (categoryFilter === '高風險') {
        if (c.marketRadarCategory !== '高風險' && c.category !== '高風險') {
          return false;
        }
      }
      if (sectorFilter !== 'ALL' && c.sector?.key !== sectorFilter) {
        return false;
      }
      if (
        searchQuery.trim() !== '' &&
        !c.symbol.toLowerCase().includes(searchQuery.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [
    scanData,
    categoryFilter,
    pullbackReadyCandidates,
    sectorFilter,
    searchQuery,
    watchlist,
    nearMissSymbolSet,
  ]);

  const switchToExplicitDemoMode = () => {
    if (dataMode === 'demo' && selectedExchange === 'demo_synthetic') {
      void executeMarketScan('demo', 'demo_synthetic');
      return;
    }
    marketScanSeqRef.current += 1;
    symbolDetailSeqRef.current += 1;
    marketScanAbortRef.current?.abort('SWITCH_DEMO');
    symbolDetailAbortRef.current?.abort('SWITCH_DEMO');
    prevWorkerStateRef.current = undefined;
    prevCompletedCyclesRef.current = undefined;
    lastDbHealthFetchAtRef.current = 0;
    setScanError(null);
    setScanData(null);
    setSymbolDetail(null);
    setDecisionTraceData(null);
    setSmcScanStatus(null);
    setPaperMonitorStatus(null);
    setScanLoading(true);
    setDataMode('demo');
    setSelectedExchange('demo_synthetic');
  };

  const switchToLiveExchange = (exId: ExchangeId) => {
    if (dataMode === 'live' && selectedExchange === exId) {
      void executeMarketScan('live', exId);
      return;
    }
    marketScanSeqRef.current += 1;
    symbolDetailSeqRef.current += 1;
    marketScanAbortRef.current?.abort('SWITCH_LIVE');
    symbolDetailAbortRef.current?.abort('SWITCH_LIVE');
    prevWorkerStateRef.current = undefined;
    prevCompletedCyclesRef.current = undefined;
    lastDbHealthFetchAtRef.current = 0;
    setScanError(null);
    setScanData(null);
    setSymbolDetail(null);
    setDecisionTraceData(null);
    setSmcScanStatus(null);
    setPaperMonitorStatus(null);
    setScanLoading(true);
    setDataMode('live');
    setSelectedExchange(exId);
  };

  const isDemoActive =
    dataMode === 'demo' || Boolean(scanData?.provenance.isDemo);

  return (
    <div
      className={`min-h-screen flex flex-col transition-colors ${
        themeMode === 'light'
          ? 'theme-light bg-[#f5f5f7] text-[#1d1d1f]'
          : 'bg-[#000000] text-[#f5f5f7]'
      }`}
    >
      {/* Sticky Demo Mode Warning Banner (Required when Demo Mode is active) */}
      {isDemoActive && (
        <div className="sticky top-0 z-40 border-b border-rose-500/40 bg-rose-950/90 px-4 sm:px-6 py-2.5 text-amber-200 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-2 font-semibold text-amber-300">
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
              <span>目前為 DEMO 模擬資料，非即時行情，不可用於交易判斷</span>
              <span className="font-mono text-rose-200 font-normal">
                (mode: "demo" · isDemo: true · fallback: false · source:
                DEMO_SYNTHETIC_DATASET)
              </span>
            </div>
            <button
              type="button"
              onClick={() => switchToLiveExchange('binance_usdm')}
              className="rounded-lg border border-amber-400/50 bg-amber-500/15 px-3.5 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              切換回 Binance Live 即時模式
            </button>
          </div>
        </div>
      )}

      {/* Apple Frosted-Glass Top Header: Strictly 3 zones with responsive wrap to prevent horizontal clipping */}
      <header className="apple-glass-header sticky top-0 z-30 flex flex-wrap xl:flex-nowrap items-center justify-between gap-3 xl:gap-6 px-4 sm:px-6 py-3">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#radar"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('radar');
          }}
          className="text-[17px] font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0 order-1"
        >
          加密貨幣全市場行情雷達
        </a>

        {/* Zone 2: Apple Segmented Navigation Bar */}
        <nav className="apple-segmented-track flex items-center gap-1 text-xs font-medium text-slate-400 order-3 xl:order-2 w-full xl:w-auto max-w-full overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSection('radar')}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'radar'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            全市場雷達與結構
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('divergence');
              fetchDivergence();
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'divergence'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            跨交易所背離監控
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('backtest');
              fetchBacktestReports();
              if (!backtestResult && selectedSymbol) {
                executeBacktest(selectedSymbol, selectedTimeframe);
              }
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'backtest'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            無前視回測與報表
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('paper_ledger');
              fetchPaperLedger();
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'paper_ledger'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            紙上交易帳本 ({paperLedger.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('position_sentinel');
              void fetchPositionSentinelStatus();
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'position_sentinel'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            持倉哨兵 ({positionSentinelStatus?.summary.totalTracked ?? 0}
            {(positionSentinelStatus?.summary.earlyReversalCount ?? 0) +
              (positionSentinelStatus?.summary.thesisBrokenCount ?? 0) >
            0
              ? ` · ${(positionSentinelStatus?.summary.earlyReversalCount ?? 0) + (positionSentinelStatus?.summary.thesisBrokenCount ?? 0)}預警`
              : ''}
            )
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('notifications');
              fetchSchedulerStatus();
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'notifications'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            背景排程與品管
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('paper_quality');
              fetchPaperMonitorAll();
            }}
            className={`px-3.5 py-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'paper_quality'
                ? 'apple-segmented-pill-active font-semibold'
                : 'hover:text-slate-100'
            }`}
          >
            長期 Paper 品質
          </button>
        </nav>

        {/* Zone 3: Unified Settings & Formulas Hub + Primary Scan Action */}
        <div className="flex items-center gap-2 shrink-0 order-2 xl:order-3">
          <button
            type="button"
            onClick={() => {
              setSettingsHubTab('settings');
              setSettingsModalOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/90 px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-amber-400/60 hover:text-amber-200 transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-amber-400" />
            <span>設定與公式</span>
          </button>
          <button
            type="button"
            onClick={() => executeMarketScan()}
            disabled={scanLoading}
            className="flex items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-sm hover:bg-amber-400 disabled:opacity-50 transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${scanLoading ? 'animate-spin' : ''}`}
            />
            <span>{scanLoading ? '正在掃描全市場...' : '執行全市場掃描'}</span>
          </button>
        </div>
      </header>

      {/* Quiet Apple-Style Status & Safety Disclosure Strip */}
      <div className="border-b border-white/[0.08] bg-slate-950/60 px-4 sm:px-6 py-2 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-mono text-amber-300">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
            <span className="font-semibold">{TRADING_SAFETY_FLAGS.mode}</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold">
              {TRADING_SAFETY_FLAGS.liveOrders}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold">
              {TRADING_SAFETY_FLAGS.executionPolicy}
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => {
                setSettingsHubTab('settings');
                setSettingsModalOpen(true);
              }}
              className="font-semibold text-slate-200 hover:text-amber-300 cursor-pointer"
            >
              {dataMode === 'demo'
                ? 'Demo 驗證模式 (DEMO_ONLY)'
                : selectedExchange === 'bybit_linear'
                  ? 'Bybit Linear (LIVE)'
                  : selectedExchange === 'bingx_swap'
                    ? 'BingX Swap (LIVE)'
                    : 'Binance USDⓈ-M (LIVE)'}
            </button>
            <span aria-hidden="true">·</span>
            <span className="font-sans text-slate-400">
              快取狀態：
              <strong
                className={
                  (smcScanStatus?.cacheStatusLabel ??
                    scanData?.cacheStatusLabel) === '快取可用'
                    ? 'text-emerald-400'
                    : (smcScanStatus?.cacheStatusLabel ??
                          scanData?.cacheStatusLabel) === '正在預熱'
                      ? 'text-sky-400'
                      : 'text-amber-400'
                }
              >
                {smcScanStatus?.cacheStatusLabel ??
                  scanData?.cacheStatusLabel ??
                  '快取可用'}
              </strong>{' '}
              ({smcScanStatus?.cacheCoverageRate ?? scanData?.cacheCoverageRate ?? 100}%)
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => {
                setSettingsHubTab('controls');
                setSettingsModalOpen(true);
              }}
              className="font-mono text-slate-300 hover:text-amber-300 underline decoration-slate-600 underline-offset-2 cursor-pointer"
            >
              SMC 佇列:{' '}
              {smcScanStatus?.succeededCount ??
                scanData?.smcScanStatus?.succeededCount ??
                0}
              /
              {smcScanStatus?.totalJobs ??
                scanData?.totalContractsScanned ??
                0}
            </button>
          </div>

          {scanData?.provenance && (
            <ProvenanceLine
              provenance={scanData.provenance}
              prefixLabel="全市場資料源"
            />
          )}
        </div>
      </div>

      {/* Explicit Live API Failure Banner (Never Faking Live Data, Preserving 503 & Provenance) */}
      {scanError && (
        <div className="border-b border-rose-500/40 bg-rose-950/60 px-4 sm:px-6 py-4 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-bold text-rose-300">
                <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
                <span>
                  即時資料不可用 (HTTP {lastHttpStatus ?? 503}) — 候選清單已清空，系統禁止自動切換為假資料
                </span>
              </div>
              <p className="text-xs text-rose-200/90 font-mono">{scanError}</p>
              {scanData?.provenance && (
                <div className="pt-1">
                  <ProvenanceLine
                    provenance={scanData.provenance}
                    prefixLabel="錯誤狀態追蹤"
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => executeMarketScan()}
                className="rounded-lg border border-rose-400/40 bg-rose-900/40 px-3.5 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-900/60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                重試即時 API
              </button>
              <button
                type="button"
                onClick={switchToExplicitDemoMode}
                className="rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 whitespace-nowrap shrink-0 cursor-pointer"
              >
                切換 Demo 驗證模式
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Container */}
      <main className="mx-auto w-full max-w-[1680px] min-w-0 flex-1 px-4 sm:px-6 py-5 flex flex-col gap-5">
        {/* SECTION 0: Long-Term Paper Quality, Regimes, Gate Drift & System Stability */}
        {activeSection === 'paper_quality' && (
          <div className="order-3 space-y-5">
            <div className="apple-bento-card p-5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    長期 Paper 品質與系統穩定性監控中心
                  </h2>
                  <p className="text-xs text-slate-400">
                    統一檢視 Phase 11–14 訊號品質統計、7 大市場狀態分層、Phase 17 系統穩定性與 SQLite 備份健康度。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fetchPaperMonitorAll()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-amber-400/60 hover:text-amber-200 cursor-pointer"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重新整理品管數據
                </button>
              </div>
            </div>

            <SystemStabilityPanel
              systemDbHealth={systemDbHealth}
              activeSmc={smcScanStatus ?? scanData?.smcScanStatus ?? null}
              dbCheckLoading={dbCheckLoading}
              onRunSystemDbCheck={runSystemDbCheck}
              watchdogStatus={watchdogStatus}
              watchdogLoading={watchdogLoading}
              onRunWatchdogCheck={runWatchdogCheck}
              onUpdateWatchdogConfig={updateWatchdogConfig}
            />







          {/* Phase 11: SMC 訊號品質與 Gate 分析 (SMC Signal Quality & Gate Analysis Panel) */}
          <div
            id="phase11-smc-quality-panel"
            className="border border-slate-800 bg-slate-950/95 px-4 py-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-amber-300 text-xs">
                  SMC 訊號品質與 Gate 分析 (Phase 11 · 長期 Paper 品質監控與 Gate 攔截診斷)
                </span>
                <span className="border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-300">
                  候選數為 0 不代表掃描失敗
                </span>
                <span className="border border-sky-500/40 bg-sky-950/40 px-2 py-0.5 font-mono text-[11px] font-semibold text-sky-300">
                  候選數為 0 代表目前沒有標的通過完整 Gate
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
                <span>
                  cycleId:{' '}
                  <strong className="text-slate-200">
                    {smcQualityGateStats?.cycleId ??
                      smcScanStatus?.cycleId ??
                      scanData?.cycleId ??
                      '—'}
                  </strong>
                </span>
                <span>
                  · statsVersion:{' '}
                  <strong className="text-amber-300">
                    {smcQualityGateStats?.statsVersion ??
                      smcScanStatus?.statsVersion ??
                      scanData?.statsVersion ??
                      1}
                  </strong>
                </span>
                <span>
                  · snapshotAt:{' '}
                  <strong className="text-slate-200">
                    {smcQualityGateStats?.snapshotAt ??
                      smcScanStatus?.snapshotAt ??
                      scanData?.snapshotAt ??
                      '—'}
                  </strong>
                </span>
                <span>
                  · 資料來源:{' '}
                  <strong className="text-emerald-300">
                    {smcQualityGateStats?.provenance?.source ??
                      'real_exchange_live'}{' '}
                    (
                    {smcQualityGateStats?.cacheMode ??
                      smcScanStatus?.cacheMode ??
                      'WARM'}
                    )
                  </strong>
                </span>
              </div>
            </div>

            {/* Row 1: Candidate Counts (Latest / 7d / 30d / Long-Short Ratio) + Latency & Paper Signal Status */}
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-12">
              <div className="lg:col-span-5 border border-slate-800/80 bg-slate-900/40 p-2.5 text-xs">
                <div className="font-semibold text-slate-200 mb-1.5">
                  候選稀少與週期統計 (最新週期 / 7d / 30d)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
                  <div className="border border-slate-800 bg-slate-950/70 p-2">
                    <div className="text-slate-400">最新週期候選數</div>
                    <div className="text-sm font-bold text-amber-300 mt-0.5">
                      {(smcQualityGateStats?.longCandidateCount ??
                        smcScanStatus?.longCandidateCount ??
                        0) +
                        (smcQualityGateStats?.shortCandidateCount ??
                          smcScanStatus?.shortCandidateCount ??
                          0)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      LONG:{' '}
                      {smcQualityGateStats?.longCandidateCount ??
                        smcScanStatus?.longCandidateCount ??
                        0}{' '}
                      / SHORT:{' '}
                      {smcQualityGateStats?.shortCandidateCount ??
                        smcScanStatus?.shortCandidateCount ??
                        0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950/70 p-2">
                    <div className="text-slate-400">7d 候選數</div>
                    <div className="text-sm font-bold text-emerald-300 mt-0.5">
                      {(smcQualityReport7d?.longCandidateCount ?? 0) +
                        (smcQualityReport7d?.shortCandidateCount ?? 0)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      週期數: {smcQualityReport7d?.totalScans ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950/70 p-2">
                    <div className="text-slate-400">30d 候選數</div>
                    <div className="text-sm font-bold text-sky-300 mt-0.5">
                      {(smcQualityReport30d?.longCandidateCount ?? 0) +
                        (smcQualityReport30d?.shortCandidateCount ?? 0)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      週期數: {smcQualityReport30d?.totalScans ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950/70 p-2">
                    <div className="text-slate-400">多空候選比例</div>
                    <div className="text-xs font-bold text-slate-100 mt-0.5">
                      {smcQualityReport7d?.directionDistribution
                        ?.longCandidateCount ?? 0}
                      :
                      {smcQualityReport7d?.directionDistribution
                        ?.shortCandidateCount ?? 0}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      歷史週期:{' '}
                      {smcQualityCycleHistory?.cycleCount ?? 0} 筆
                    </div>
                  </div>
                </div>
                <div className="mt-2 font-mono text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
                  <span>
                    WAIT:{' '}
                    <strong className="text-slate-200">
                      {smcQualityGateStats?.waitCount ??
                        smcScanStatus?.waitCount ??
                        0}
                    </strong>
                  </span>
                  <span>
                    · WATCH:{' '}
                    <strong className="text-amber-300">
                      {smcQualityGateStats?.watchCount ??
                        smcScanStatus?.watchCount ??
                        0}
                    </strong>
                  </span>
                  <span>
                    · HIGH RISK:{' '}
                    <strong className="text-rose-400">
                      {smcQualityGateStats?.highRiskCount ??
                        smcScanStatus?.highRiskCount ??
                        0}
                    </strong>
                  </span>
                  <span>
                    · PENDING:{' '}
                    <strong className="text-sky-300">
                      {smcQualityGateStats?.pendingCount ??
                        smcScanStatus?.pendingCount ??
                        0}
                    </strong>
                  </span>
                  <span>
                    · gateNotConfirmed:{' '}
                    <strong className="text-slate-200">
                      {smcQualityGateStats?.gateNotConfirmedCount ?? 0}
                    </strong>
                  </span>
                  <span>
                    · mismatchCount:{' '}
                    <strong className="text-emerald-400">
                      {smcQualityGateStats?.finalCategorySmcMismatchCount ?? 0}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Top Gate Blocking Reasons */}
              <div className="lg:col-span-4 border border-slate-800/80 bg-slate-900/40 p-2.5 text-xs">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-slate-200">
                    Top Gate 攔截原因 (逐項通過率與失敗率)
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    共評估 {smcQualityGateStats?.totalEvaluated ?? 0} 檔
                  </span>
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1 font-mono text-[11px]">
                  {(smcQualityGateStats?.topFailedGates ??
                    smcQualityGateStats?.gates ??
                    [])
                    .slice(0, 6)
                    .map((g) => (
                      <div
                        key={g.gate}
                        className="flex items-center justify-between gap-2 border-b border-slate-800/50 pb-1"
                      >
                        <span className="text-slate-300 truncate">
                          {g.label}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="text-emerald-400">
                            通過 {g.passCount} ({g.passRate}%)
                          </span>{' '}
                          ·{' '}
                          <span className="text-rose-400">
                            失敗 {g.failCount} ({g.failureRate}%)
                          </span>
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              {/* Latency, ENTRY_WINDOW_MISSED & Paper Signal Metric Status */}
              <div className="lg:col-span-3 border border-slate-800/80 bg-slate-900/40 p-2.5 text-xs">
                <div className="font-semibold text-slate-200 mb-1.5">
                  訊號延遲、ENTRY_WINDOW_MISSED 與 Paper 狀態
                </div>
                <div className="space-y-1 font-mono text-[11px] text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">7d 視窗樣本數:</span>
                    <strong>
                      n={smcQualitySignalLatency?.sampleCount ?? 0} (
                      {smcQualitySignalLatency?.sampleSufficiency ??
                        'INSUFFICIENT'}{' '}
                      ·{' '}
                      {smcQualitySignalLatency?.sampleSufficiencyNotice ??
                        '樣本不足，僅供觀察'}
                      )
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">視窗內 P50 / P95 延遲:</span>
                    <strong>
                      {smcQualitySignalLatency?.signalLatencyP50 !== null &&
                      smcQualitySignalLatency?.signalLatencyP50 !== undefined
                        ? `${smcQualitySignalLatency.signalLatencyP50} ms`
                        : 'null'}{' '}
                      /{' '}
                      {smcQualitySignalLatency?.signalLatencyP95 !== null &&
                      smcQualitySignalLatency?.signalLatencyP95 !== undefined
                        ? `${smcQualitySignalLatency.signalLatencyP95} ms`
                        : 'null'}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">
                      ENTRY_WINDOW_MISSED (當輪 / 7d / 視窗外歷史):
                    </span>
                    <strong className="text-amber-300">
                      {smcQualityGateStats?.entryWindowMissedCount ?? 0} /{' '}
                      {smcQualityReport7d?.entryWindowMissed ?? 0} /{' '}
                      {smcQualityReport7d?.historicalSignalsOutsideWindowCount ??
                        0}{' '}
                      筆
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">7d / 30d Paper 狀態:</span>
                    <strong
                      className={
                        smcQualityReport7d?.metricStatus === 'NO_TRADES'
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                      }
                    >
                      7d={smcQualityReport7d?.metricStatus ?? 'NO_TRADES'} / 30d=
                      {smcQualityReport30d?.metricStatus ?? 'NO_TRADES'}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">
                      7d 勝率 / 平均 R / Expectancy:
                    </span>
                    <strong className="text-slate-200">
                      {smcQualityReport7d?.winRate !== null &&
                      smcQualityReport7d?.winRate !== undefined
                        ? `${smcQualityReport7d.winRate}%`
                        : 'null'}{' '}
                      /{' '}
                      {smcQualityReport7d?.averageR !== null &&
                      smcQualityReport7d?.averageR !== undefined
                        ? `${smcQualityReport7d.averageR}R`
                        : 'null'}{' '}
                      /{' '}
                      {smcQualityReport7d?.expectancyR !== null &&
                      smcQualityReport7d?.expectancyR !== undefined
                        ? `${smcQualityReport7d.expectancyR}R`
                        : 'null'}
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: 7 Explicit Blocking Categories Breakdown (DATA_BLOCKED / STRUCTURE_INCOMPLETE / MTF_CONFLICT / LIQUIDITY_BLOCKED / RISK_BLOCKED / ENTRY_WINDOW_MISSED / PENDING) */}
            <div className="mt-2.5 border border-slate-800/80 bg-slate-900/30 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <span className="font-semibold text-slate-200">
                  WAIT / WATCH / HIGH RISK 原因分類（嚴格區分 7 大攔截類別，絕不混入同一數字）
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  Top Primary Reason:{' '}
                  <strong className="text-amber-300">
                    {smcQualityReasonStats?.waitReasonRanking?.[0]?.reason ??
                      '無'}
                  </strong>{' '}
                  (
                  {smcQualityReasonStats?.waitReasonRanking?.[0]
                    ?.uniqueSymbolCount ?? 0}{' '}
                  檔 /{' '}
                  {smcQualityReasonStats?.waitReasonRanking?.[0]
                    ?.failureRatePercent ?? 0}
                  %)
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 font-mono text-[11px]">
                {(
                  smcQualityReasonStats?.reasonCategoryList ?? [
                    {
                      category: 'DATA_BLOCKED' as const,
                      label: '資料缺失/過期/基準未就緒',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'STRUCTURE_INCOMPLETE' as const,
                      label: 'SMC 結構條件未齊全',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'MTF_CONFLICT' as const,
                      label: '跨週期趨勢衝突',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'LIQUIDITY_BLOCKED' as const,
                      label: '流動性不足保護攔截',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'RISK_BLOCKED' as const,
                      label: '資金費率/波動風險攔截',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'ENTRY_WINDOW_MISSED' as const,
                      label: '偵測延遲錯過進場區間',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                    {
                      category: 'PENDING' as const,
                      label: '佇列評估進行中',
                      primarySymbolCount: 0,
                      uniqueSymbolCount: 0,
                      totalReasonOccurrences: 0,
                      shareOfEvaluatedPercent: 0,
                      reasons: {},
                      sampleSymbols: [],
                    },
                  ]
                ).map((cat) => (
                  <div
                    key={cat.category}
                    className="border border-slate-800 bg-slate-950/80 px-2.5 py-1.5"
                  >
                    <div className="text-[10px] font-bold text-amber-300 truncate">
                      {cat.category}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      {cat.label}
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-slate-100">
                      {cat.primarySymbolCount} 檔{' '}
                      <span className="text-[10px] font-normal text-slate-400">
                        ({cat.shareOfEvaluatedPercent}%)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Phase 12–14: Long-Term Paper Signal Quality, 3-Mode Aggregation, Cycle Details, Gate Drift & Lifecycle Panel */}
          <div
            id="phase12-paper-quality-panel"
            className="border border-slate-800 bg-slate-950/90 px-4 py-3.5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-slate-100">
                  長期 Paper 品質、樣本累積、Gate 穩定度與市場狀態分析（Phase 14：最新週期 / 去重標的 / 累計評估事件分離與分母驗證）
                </span>
                <span className="font-mono text-[11px] font-bold text-amber-300 border border-amber-500/40 bg-amber-950/30 px-2 py-0.5">
                  目前仍無已結算交易
                </span>
                <span className="font-mono text-[11px] font-bold text-amber-300 border border-amber-500/40 bg-amber-950/30 px-2 py-0.5">
                  目前樣本不足，僅供觀察
                </span>
                <span className="font-mono text-[11px] font-bold text-sky-300 border border-sky-500/40 bg-sky-950/30 px-2 py-0.5">
                  候選數為 0 不代表掃描失敗
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  (目前樣本不足，不代表策略有效或無效)
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400">
                <span>
                  資料庫實例:{' '}
                  <strong className="text-slate-200">
                    {paperQualityStatus?.databaseInstanceId ?? 'N/A'}
                  </strong>
                </span>
                <span>·</span>
                <span>
                  statsVersion:{' '}
                  <strong className="text-slate-200">
                    v{paperQualityStatus?.statsVersion ?? scanData?.statsVersion ?? 1}
                  </strong>
                </span>
                <span>·</span>
                <span>
                  資料新鮮度:{' '}
                  <strong
                    className={
                      paperQualityStatus?.dataFreshness?.status === 'FRESH'
                        ? 'text-emerald-400'
                        : 'text-amber-300'
                    }
                  >
                    {paperQualityStatus?.dataFreshness?.status ?? 'FRESH'} (stale=
                    {String(paperQualityStatus?.dataFreshness?.stale ?? false)} / fallback=
                    {String(paperQualityStatus?.dataFreshness?.fallback ?? false)} / missing=
                    {paperQualityStatus?.dataFreshness?.missingDataCount ?? 0})
                  </strong>
                </span>
                <span>·</span>
                <span>
                  最後更新: {paperQualityStatus?.lastUpdatedAt ?? scanData?.snapshotAt ?? 'N/A'}
                </span>
              </div>
            </div>

            {/* Phase 14 Section 一 & 三: Explicitly Separate Latest Cycle / Deduped Symbols / Cumulative Evaluation Events */}
            {(() => {
              const activeWin =
                paperQualityStatus?.windows?.[paperQualitySelectedWindow] ??
                paperQualityStatus?.windows?.['30d'];
              const latestStats =
                activeWin?.latestCycleStats ??
                paperQualityStatus?.latestCycleStats;
              const dedupedStats =
                activeWin?.dedupedSymbolStats ??
                paperQualityStatus?.dedupedSymbolStats;
              const cumulativeStats =
                activeWin?.cumulativeEventStats ??
                paperQualityStatus?.cumulativeEventStats;
              const lifecycleSum =
                activeWin?.lifecycleSummary ??
                paperQualityStatus?.lifecycleSummary;
              return (
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3 font-mono text-[11px]">
                  <div className="border border-slate-800/90 bg-slate-900/50 p-2.5 space-y-1">
                    <div className="flex items-center justify-between border-b border-slate-800/70 pb-1">
                      <span className="font-sans font-bold text-xs text-emerald-300">
                        1. 最新週期 (LATEST_CYCLE)
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {latestStats?.cycleId ?? paperQualityStatus?.scanCycleId ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">latestCycleEvaluatedCount:</span>
                      <strong className="text-slate-100">
                        {latestStats?.latestCycleEvaluatedCount ??
                          paperQualityStatus?.latestCycleEvaluatedCount ??
                          0}{' '}
                        / {latestStats?.evaluationUniverseSize ?? 522}
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">WAIT / WATCH / HIGH RISK:</span>
                      <strong>
                        {latestStats?.waitCount ?? 0} / {latestStats?.watchCount ?? 0} /{' '}
                        {latestStats?.highRiskCount ?? 0}
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">候選訊號 / 開倉 / 結算 / 錯過:</span>
                      <strong>
                        {latestStats?.totalSignals ?? 0} / {latestStats?.paperOpened ?? 0} /{' '}
                        {latestStats?.paperClosed ?? 0} / {latestStats?.entryWindowMissed ?? 0}
                      </strong>
                    </div>
                  </div>

                  <div className="border border-amber-500/40 bg-slate-900/60 p-2.5 space-y-1">
                    <div className="flex items-center justify-between border-b border-slate-800/70 pb-1">
                      <span className="font-sans font-bold text-xs text-amber-300">
                        2. 去重標的 (DEDUPED_SYMBOLS)
                      </span>
                      <span className="text-[10px] text-amber-200">
                        全市場母體 {dedupedStats?.evaluationUniverseSize ?? 522} 檔
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">uniqueEvaluatedSymbols + excluded:</span>
                      <strong className="text-slate-100">
                        {dedupedStats?.uniqueEvaluatedSymbols ??
                          paperQualityStatus?.uniqueEvaluatedSymbols ??
                          0}{' '}
                        + {dedupedStats?.excludedSymbols ?? 0} ={' '}
                        {dedupedStats?.evaluationUniverseSize ?? 522}
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">去重候選訊號 / 開倉 / 結算:</span>
                      <strong>
                        {dedupedStats?.totalSignals ?? 0} / {dedupedStats?.paperOpened ?? 0} /{' '}
                        {dedupedStats?.paperClosed ?? 0}
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">去重 ENTRY_WINDOW_MISSED:</span>
                      <strong className="text-amber-300">
                        {dedupedStats?.entryWindowMissed ?? 0}
                      </strong>
                    </div>
                  </div>

                  <div className="border border-sky-500/40 bg-slate-900/50 p-2.5 space-y-1">
                    <div className="flex items-center justify-between border-b border-slate-800/70 pb-1">
                      <span className="font-sans font-bold text-xs text-sky-300">
                        3. 累計評估事件 (CUMULATIVE_EVENTS)
                      </span>
                      <span className="text-[10px] text-sky-200">
                        共 {cumulativeStats?.totalScanCycles ?? 0} 週期 (完成{' '}
                        {cumulativeStats?.completedScanCycles ?? 0} / 中斷{' '}
                        {cumulativeStats?.interruptedScanCycles ?? 0})
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">cumulativeEvaluationEvents:</span>
                      <strong className="text-sky-300">
                        {cumulativeStats?.cumulativeEvaluationEvents ??
                          paperQualityStatus?.cumulativeEvaluationEvents ??
                          0}{' '}
                        次評估事件
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">累計 WAIT / WATCH / HIGH RISK:</span>
                      <strong>
                        {cumulativeStats?.waitCount ?? 0} / {cumulativeStats?.watchCount ?? 0} /{' '}
                        {cumulativeStats?.highRiskCount ?? 0}
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span className="text-slate-400">訊號生命週期 (偵測/開倉/結算/錯過):</span>
                      <strong>
                        {lifecycleSum?.candidateDetected ?? 0} /{' '}
                        {lifecycleSum?.paperOpened ?? 0} /{' '}
                        {lifecycleSum?.paperClosed ?? 0} /{' '}
                        {lifecycleSum?.entryWindowMissed ?? 0}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 30d / 60d / 90d Window Summary Cards */}
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3 font-mono text-[11px]">
              {(['30d', '60d', '90d'] as const).map((winKey) => {
                const winSum = paperQualityStatus?.windows?.[winKey];
                const isSelected = paperQualitySelectedWindow === winKey;
                return (
                  <div
                    key={winKey}
                    onClick={() => setPaperQualitySelectedWindow(winKey)}
                    className={`min-w-0 border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-amber-500/60 bg-slate-900/70'
                        : 'border-slate-800/80 bg-slate-900/35 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-slate-800/70 pb-1.5 mb-1.5">
                      <span className="font-bold text-xs text-slate-100 min-w-0 break-all">
                        {winKey} 長期監控週期 ({winSum?.monitoringWindowId ?? `win_${winKey}`})
                      </span>
                      <span
                        className={`shrink-0 ${
                          winSum?.sampleSufficiency === 'SUFFICIENT'
                            ? 'text-emerald-400 font-semibold'
                            : 'text-amber-300 font-semibold'
                        }`}
                      >
                        {winSum?.sampleSufficiency ?? 'INSUFFICIENT'} (n=
                        {winSum?.sampleCount ?? 0})
                      </span>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-3 gap-y-1 text-slate-300">
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">最新/去重/累計評估:</span>
                        <strong className="text-slate-100">
                          {winSum?.latestCycleEvaluatedCount ?? 0} /{' '}
                          {winSum?.uniqueEvaluatedSymbols ?? 0} /{' '}
                          {winSum?.cumulativeEvaluationEvents ?? 0}
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">完整/中斷週期:</span>
                        <strong className="text-slate-200">
                          {winSum?.completedScanCycles ?? 0} /{' '}
                          {winSum?.interruptedScanCycles ?? 0} (共{' '}
                          {winSum?.totalScanCycles ?? 0})
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">候選數 (L/S):</span>
                        <strong className="text-slate-100">
                          {winSum?.totalSignals ?? 0} ({winSum?.longSignals ?? 0}/
                          {winSum?.shortSignals ?? 0})
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">開倉 / 結算:</span>
                        <strong className="text-slate-100">
                          {winSum?.paperOpened ?? 0} / {winSum?.paperClosed ?? 0}
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">ENTRY_WINDOW_MISSED:</span>
                        <strong className="text-amber-300">
                          {winSum?.entryWindowMissed ?? 0}
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0">
                        <span className="text-slate-400">metricStatus:</span>
                        <strong className="text-sky-300">
                          {winSum?.metricStatus ?? 'NO_TRADES'}
                        </strong>
                      </div>
                      <div className="flex flex-wrap justify-between gap-1 min-w-0 xl:col-span-2">
                        <span className="text-slate-400">勝率 / 平均 R:</span>
                        <strong className="text-slate-200">
                          {winSum?.winRate !== null && winSum?.winRate !== undefined
                            ? `${winSum.winRate}%`
                            : 'null (目前仍無已結算交易)'}{' '}
                          /{' '}
                          {winSum?.averageR !== null && winSum?.averageR !== undefined
                            ? `${winSum.averageR}R`
                            : 'null'}
                        </strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Gate Stability & Denominator Check + Latency + Market Regimes */}
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-12 text-xs">
              {/* Gate Drift (latest vs prev, 7d vs 30d, 30d vs 60d, 60d vs 90d) */}
              <div className="lg:col-span-5 border border-slate-800/80 bg-slate-900/40 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-slate-200">
                    Gate 穩定度與分母檢查 (最近vs前一週期 / 7d vs 30d / 30d vs 60d / 60d vs 90d)
                  </span>
                  <span
                    className={`font-mono text-[11px] font-bold ${
                      paperQualityGateDrift?.driftStatus ===
                      'QUALITY_DRIFT_SUSPECTED'
                        ? 'text-rose-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {paperQualityGateDrift?.driftStatus ?? 'STABLE'} (自動放寬:{' '}
                    {String(paperQualityGateDrift?.gatesRelaxed ?? false)})
                  </span>
                </div>
                <div className="space-y-1 font-mono text-[11px] text-slate-300">
                  {(paperQualityGateDrift?.comparisonList ?? []).map((comp) => (
                    <div
                      key={comp.pair}
                      className="flex items-center justify-between border-b border-slate-800/60 pb-1"
                    >
                      <span className="text-slate-300">
                        {comp.shortWindow} vs {comp.longWindow} (分母:{' '}
                        {comp.shortEvaluatedDenominator}/{comp.longEvaluatedDenominator} · 週期:{' '}
                        {comp.shortWindowCycleCount}/{comp.longWindowCycleCount})
                      </span>
                      <span
                        className={
                          !comp.comparisonAllowed
                            ? 'text-amber-300 font-semibold'
                            : comp.driftStatus === 'QUALITY_DRIFT_SUSPECTED'
                              ? 'text-rose-400 font-semibold'
                              : 'text-emerald-400'
                        }
                      >
                        {comp.comparisonAllowed
                          ? comp.driftStatus
                          : `${comp.comparisonReason} (禁止異分母直接比較)`}
                      </span>
                    </div>
                  ))}
                  <div className="pt-1 text-[10px] text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      BOS/MSS: {paperQualityGateDrift?.currentGatePassRates?.['BOS/MSS'] ?? 0}%
                    </span>
                    <span>
                      Sweep:{' '}
                      {paperQualityGateDrift?.currentGatePassRates?.['Liquidity Sweep'] ?? 0}%
                    </span>
                    <span>
                      Disp: {paperQualityGateDrift?.currentGatePassRates?.Displacement ?? 0}%
                    </span>
                    <span>
                      FVG/OB:{' '}
                      {paperQualityGateDrift?.currentGatePassRates?.['FVG/Order Block'] ?? 0}%
                    </span>
                    <span>
                      MTF: {paperQualityGateDrift?.currentGatePassRates?.['MTF Alignment'] ?? 0}%
                    </span>
                    <span>
                      OI/Funding:{' '}
                      {paperQualityGateDrift?.currentGatePassRates?.['OI/Funding'] ?? 0}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Latency & Fast Lane vs Bulk Coverage */}
              <div className="lg:col-span-3 border border-slate-800/80 bg-slate-900/40 p-2.5 font-mono text-[11px]">
                <div className="font-sans font-semibold text-slate-200 mb-1.5 flex items-center justify-between">
                  <span>偵測延遲與樣本覆蓋率</span>
                  <span className="text-[10px] font-mono text-emerald-300">
                    覆蓋率 {paperQualityStatus?.latencyCoverageRate ?? 100}%
                  </span>
                </div>
                <div className="space-y-1 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">延遲 / 績效樣本充足度:</span>
                    <strong className="text-amber-300">
                      {paperQualityStatus?.latencySampleSufficiency ??
                        'INSUFFICIENT'}{' '}
                      (n={paperQualityStatus?.latencySampleCount ?? 0}) /{' '}
                      {paperQualityStatus?.performanceSampleSufficiency ??
                        'INSUFFICIENT'}{' '}
                      (closed={paperQualityStatus?.performanceSampleCount ?? 0})
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">
                      FastLane + Bulk + 缺漏 = 已評估:
                    </span>
                    <strong className="text-slate-100">
                      {paperQualityStatus?.fastLaneCount ?? 0} +{' '}
                      {paperQualityStatus?.bulkCount ?? 0} +{' '}
                      {paperQualityStatus?.missingLatencySampleCount ?? 0} ={' '}
                      {paperQualityStatus?.latencyEvaluatedCount ?? 0}
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">訊號 P50 / P95 / Avg:</span>
                    <strong>
                      {paperQualityStatus?.latencySummary?.detectionLatencyP50 ??
                        'null'}{' '}
                      /{' '}
                      {paperQualityStatus?.latencySummary?.detectionLatencyP95 ??
                        'null'}{' '}
                      /{' '}
                      {paperQualityStatus?.latencySummary
                        ?.detectionLatencyAverage ?? 'null'}{' '}
                      ms
                    </strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Fast Lane / Bulk P95:</span>
                    <strong className="text-emerald-400">
                      {paperQualityStatus?.latencySummary?.fastLaneLatency?.p95 ??
                        'null'}{' '}
                      ms /{' '}
                      <span className="text-sky-300">
                        {paperQualityStatus?.latencySummary?.bulkLatency?.p95 ??
                          'null'}{' '}
                        ms
                      </span>
                    </strong>
                  </div>
                </div>
              </div>

              {/* 7 Market Regime Dimensions & Denominator Scope */}
              <div className="lg:col-span-4 border border-slate-800/80 bg-slate-900/40 p-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-200">
                    7 大市場狀態分層 ({paperQualityRegimes?.regimeScope ?? 'LATEST_COMPLETED_CYCLE'})
                  </span>
                  <span className="font-mono text-[10px] text-amber-300">
                    分母: {paperQualityRegimes?.regimeEvaluatedCount ?? 0} +{' '}
                    {paperQualityRegimes?.regimeExcludedCount ?? 0} ={' '}
                    {paperQualityRegimes?.regimeTotalSymbols ?? 0}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mb-1 truncate">
                  {paperQualityRegimes?.regimeDenominatorSummary ??
                    '全市場分母一致性已驗證'}
                </div>
                <div className="space-y-1 max-h-24 overflow-y-auto pr-1 font-mono text-[11px]">
                  {(paperQualityRegimes?.dimensionList ?? []).map((dim) => (
                    <div
                      key={dim.dimension}
                      className="flex items-center justify-between gap-2 border-b border-slate-800/50 pb-0.5"
                    >
                      <span className="text-slate-300 truncate">
                        {dim.label} ({dim.currentMarketState})
                      </span>
                      <span className="text-slate-400 shrink-0">
                        {dim.buckets
                          .map((b) => `${b.bucketKey}:${b.evaluatedCount}`)
                          .join(' · ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Phase 14: 5 Statistical Identities & Atomic Snapshot Verification Bar */}
            <div className="border border-slate-800/80 bg-slate-900/30 px-3 py-2 font-mono text-[11px] flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3 text-slate-300">
                <span className="font-sans font-semibold text-amber-300">
                  Phase 14 統計恆等式驗證 ({paperQualityStatus?.statsConsistency ?? 'VALID'})：
                </span>
                <span>
                  1. 全市場:{' '}
                  {paperQualityStatus?.identityChecks?.totalSymbolsIdentity
                    ?.expression ?? '—'}
                </span>
                <span>·</span>
                <span>
                  2. 狀態總和:{' '}
                  {paperQualityStatus?.identityChecks?.actionStateIdentity
                    ?.expression ?? '—'}
                </span>
                <span>·</span>
                <span>
                  3. 去重母體:{' '}
                  {paperQualityStatus?.identityChecks?.uniqueUniverseIdentity
                    ?.expression ?? '—'}
                </span>
                <span>·</span>
                <span>
                  4. 延遲覆蓋:{' '}
                  {paperQualityStatus?.identityChecks?.latencyCoverageIdentity
                    ?.expression ?? '—'}
                </span>
              </div>
              <div className="text-[10px] text-emerald-300">
                reportAnchorAt: {paperQualityStatus?.reportAnchorAt ?? '—'} (
                {paperQualityStatus?.isAtomicSnapshot
                  ? 'ATOMIC_UNIFIED_SNAPSHOT'
                  : 'SEPARATE_WINDOW_QUERY'}
                )
              </div>
            </div>
          </div>
          </div>
        )}

        {/* SECTION 1: Standalone Full Market Radar + Selected Symbol SMC/ICT Workstation */}
        {activeSection === 'radar' && (
          <div className="order-3 space-y-4">
            {/* Compact Radar Workspace Toolbar */}
            <div className="apple-bento-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilter('ALL');
                    setSectorFilter('ALL');
                  }}
                  className={`rounded-lg px-2.5 py-1 font-mono transition-colors cursor-pointer ${
                    categoryFilter === 'ALL' && sectorFilter === 'ALL'
                      ? 'bg-slate-800 text-slate-100 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  全市場 {scanData?.totalContractsScanned ?? 0}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCategoryFilter(
                      categoryFilter === '雷達多頭觀察' ? 'ALL' : '雷達多頭觀察'
                    )
                  }
                  className={`rounded-lg px-2.5 py-1 font-mono transition-colors cursor-pointer ${
                    categoryFilter === '雷達多頭觀察'
                      ? 'bg-emerald-500/20 text-emerald-300 font-semibold ring-1 ring-emerald-500/50'
                      : 'text-emerald-400/90 hover:bg-emerald-500/10'
                  }`}
                >
                  多頭雷達{' '}
                  {scanData?.marketRadarLongCount ??
                    scanData?.marketRadarCounts?.['雷達多頭觀察'] ??
                    0}{' '}
                  (SMC {scanData?.smcLongCandidateCount ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCategoryFilter(
                      categoryFilter === '雷達空頭觀察' ? 'ALL' : '雷達空頭觀察'
                    )
                  }
                  className={`rounded-lg px-2.5 py-1 font-mono transition-colors cursor-pointer ${
                    categoryFilter === '雷達空頭觀察'
                      ? 'bg-rose-500/20 text-rose-300 font-semibold ring-1 ring-rose-500/50'
                      : 'text-rose-400/90 hover:bg-rose-500/10'
                  }`}
                >
                  空頭雷達{' '}
                  {scanData?.marketRadarShortCount ??
                    scanData?.marketRadarCounts?.['雷達空頭觀察'] ??
                    0}{' '}
                  (SMC {scanData?.smcShortCandidateCount ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCategoryFilter(
                      categoryFilter === '高風險' ? 'ALL' : '高風險'
                    )
                  }
                  className={`rounded-lg px-2.5 py-1 font-mono transition-colors cursor-pointer ${
                    categoryFilter === '高風險'
                      ? 'bg-amber-500/20 text-amber-300 font-semibold ring-1 ring-amber-500/50'
                      : 'text-amber-400/90 hover:bg-amber-500/10'
                  }`}
                >
                  高風險 {scanData?.summaryCounts['高風險'] ?? 0}
                </button>
                <span className="font-mono text-slate-400 px-1 tabular-nums">
                  BTC 24h:{' '}
                  <strong className="text-slate-200">
                    {scanData?.btcBenchmarkChange24h !== null &&
                    scanData?.btcBenchmarkChange24h !== undefined
                      ? `${scanData.btcBenchmarkChange24h >= 0 ? '+' : ''}${scanData.btcBenchmarkChange24h.toFixed(2)}%`
                      : 'N/A'}
                  </strong>
                  {scanData?.btcMarketRegime &&
                    scanData.btcMarketRegime.state !== 'UNKNOWN' && (
                      <>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span
                          title={scanData.btcMarketRegime.warningZh}
                          className={
                            scanData.btcMarketRegime.state === 'VOLATILITY_SPIKE'
                              ? 'text-rose-300 font-semibold'
                              : scanData.btcMarketRegime.state === 'BEAR_TREND'
                                ? 'text-amber-300'
                                : scanData.btcMarketRegime.state === 'BULL_TREND'
                                  ? 'text-emerald-300'
                                  : 'text-slate-400'
                          }
                        >
                          {scanData.btcMarketRegime.state === 'VOLATILITY_SPIKE'
                            ? '大盤濾網：極端波動攔截山寨'
                            : scanData.btcMarketRegime.state === 'BEAR_TREND'
                              ? '大盤濾網：BTC 偏空壓制 (擋逆勢多)'
                              : scanData.btcMarketRegime.state === 'BULL_TREND'
                                ? '大盤濾網：BTC 偏多推升 (擋逆勢空)'
                                : '大盤濾網：震盪區間'}
                        </span>
                      </>
                    )}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {/* Quick Timeframe Pills */}
                <div className="apple-segmented-track flex items-center gap-1">
                  {(['5m', '15m', '1h', '4h'] as Timeframe[]).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => {
                        setSelectedTimeframe(tf);
                        if (selectedSymbol && !scanError) {
                          loadSymbolDetail(selectedSymbol, tf);
                        }
                      }}
                      className={`px-2.5 py-1 text-xs font-mono transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                        selectedTimeframe === tf
                          ? 'apple-segmented-pill-active font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>

                {/* Symbol Search */}
                <div className="relative w-52 sm:w-60">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜尋幣種 (如 SOL, SUI, BTC)..."
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setAlertDrawerOpen(true)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
                    priceAlerts.some((r) => r.enabled && !r.triggered)
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                      : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:text-slate-100'
                  }`}
                >
                  <Bell className="h-3.5 w-3.5" />
                  <span>
                    條件告警 (
                    {priceAlerts.filter((r) => r.enabled && !r.triggered).length}
                    )
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowMarketWeather((v) => !v)}
                  className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 cursor-pointer whitespace-nowrap"
                >
                  {showMarketWeather
                    ? '收合市場情報列'
                    : '展開市場情報列'}
                </button>
              </div>
            </div>

            {/* Compact Position Sentinel Strip (shown on Radar whenever positions are tracked) */}
            {positionSentinelStatus &&
              positionSentinelStatus.positions.length > 0 && (
                <div className="apple-bento-card flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-semibold text-emerald-300">
                      持倉趨勢即時守護中
                    </span>
                    <span className="text-slate-600" aria-hidden="true">
                      |
                    </span>
                    {positionSentinelStatus.positions.slice(0, 5).map((pos) => {
                      const stateTone =
                        pos.healthState === 'THESIS_BROKEN'
                          ? 'text-rose-300 border-rose-500/40 bg-rose-950/30'
                          : pos.healthState === 'EARLY_REVERSAL'
                            ? 'text-orange-300 border-orange-500/40 bg-orange-950/25'
                            : pos.healthState === 'MOMENTUM_FADING'
                              ? 'text-amber-300 border-amber-500/40 bg-amber-950/25'
                              : 'text-emerald-300 border-emerald-500/35 bg-emerald-950/20';
                      return (
                        <button
                          key={pos.id}
                          type="button"
                          onClick={() => setActiveSection('position_sentinel')}
                          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] cursor-pointer ${stateTone}`}
                        >
                          <strong className="text-slate-100">
                            {pos.symbol}
                          </strong>
                          <span>{pos.side}</span>
                          <span className="tabular-nums">
                            {pos.unrealizedPnlPercent >= 0 ? '+' : ''}
                            {pos.unrealizedPnlPercent.toFixed(2)}%
                          </span>
                          <span>· {pos.healthLabelZh}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSection('position_sentinel')}
                    className="font-medium text-sky-300 hover:text-sky-200 cursor-pointer whitespace-nowrap"
                  >
                    前往持倉哨兵詳情 →
                  </button>
                </div>
              )}

            {latestAlertToast && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/50 bg-amber-950/40 px-4 py-2.5 text-xs text-amber-100">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell className="h-4 w-4 text-amber-300 shrink-0" />
                  <span className="font-semibold shrink-0">條件告警觸發：</span>
                  <span className="truncate">{latestAlertToast.messageZh}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setAlertDrawerOpen(true)}
                    className="rounded-lg border border-amber-400/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                  >
                    檢視告警中心
                  </button>
                  <button
                    type="button"
                    onClick={() => setLatestAlertToast(null)}
                    className="text-[11px] text-amber-300/80 hover:text-amber-100 cursor-pointer"
                  >
                    關閉提示
                  </button>
                </div>
              </div>
            )}

            {/* Unified Compact Market Intel Dock: Top 3 + WATCH + Near-Miss + Breadth & 8 Sectors */}
            {showMarketWeather && scanData && !scanError && (
              <div className="@container apple-bento-card p-3.5 space-y-3 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-slate-100">
                      當前最推薦 Top 3、接近 SMC 完整評估 (WATCH) 與差一點 (Near-Miss)
                    </span>
                    <span className="text-[11px] text-slate-400">
                      —{' '}
                      {(scanData.summaryCounts['多頭候選'] ?? 0) +
                        (scanData.summaryCounts['空頭候選'] ?? 0) >
                      0
                        ? `已有 ${(scanData.summaryCounts['多頭候選'] ?? 0) + (scanData.summaryCounts['空頭候選'] ?? 0)} 檔通過完整 SMC 結構確認`
                        : `掃描 ${scanData.totalContractsScanned ?? 0} 檔 · WATCH ${scanData.smcWatchCount ?? watchApproachCandidates.length} 檔 · Near-Miss ${nearMissSymbolSet.size} 檔`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsHubTab('telemetry');
                      setSettingsModalOpen(true);
                    }}
                    className="text-[11px] font-medium text-amber-300 hover:underline cursor-pointer whitespace-nowrap shrink-0"
                  >
                    開啟漏斗與工程遙測 →
                  </button>
                </div>

                {/* Compact Top 3 + WATCH + Near-Miss Row */}
                <div className="grid grid-cols-1 gap-2.5 @4xl:grid-cols-12 items-stretch">
                  {/* Left 6 cols: Top 3 Focus Cards */}
                  {top3Recommended.length > 0 && (
                    <div className="@4xl:col-span-6 grid grid-cols-1 gap-2 @lg:grid-cols-3">
                      {top3Recommended.map((topC, idx) => {
                        const isSel = topC.symbol === selectedSymbol;
                        const plainInfo = getPlainLanguageRowExplanation(
                          topC,
                          topC.smcActionState,
                          topC.smcEvaluationStatus
                        );
                        return (
                          <button
                            key={topC.symbol}
                            type="button"
                            onClick={() =>
                              loadSymbolDetail(topC.symbol, selectedTimeframe)
                            }
                            className={`min-w-0 overflow-hidden text-left border px-2.5 py-2 rounded-xl transition-all cursor-pointer ${
                              isSel
                                ? 'border-amber-500/80 bg-slate-950 shadow-sm'
                                : 'border-slate-800/80 bg-slate-950/60 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="text-[11px] font-mono font-bold text-amber-400 shrink-0">
                                  0{idx + 1}.
                                </span>
                                <span className="text-xs font-bold font-mono text-slate-100 truncate">
                                  {topC.symbol}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0 font-mono text-[10px]">
                                <span className={getSmcStateColor(topC.smcActionState)}>
                                  {topC.smcActionState}
                                </span>
                                <span className="font-semibold text-slate-200">
                                  {topC.score}
                                </span>
                              </div>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1 text-[11px] font-mono tabular-nums">
                              <span className="text-slate-200 truncate">
                                ${formatPriceDynamic(topC.lastPrice)}
                              </span>
                              <span
                                className={`shrink-0 ${
                                  topC.priceChangePercent24h >= 0
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-rose-400 font-semibold'
                                }`}
                              >
                                {topC.priceChangePercent24h >= 0 ? '+' : ''}
                                {topC.priceChangePercent24h.toFixed(2)}%
                              </span>
                              <span className="text-slate-400 shrink-0">
                                {topC.historicalVolume.status === 'READY'
                                  ? `${topC.historicalVolume.rvol}x`
                                  : '收集中'}
                              </span>
                            </div>
                            <div
                              className={`mt-0.5 text-[10px] truncate ${plainInfo.toneClass}`}
                            >
                              {plainInfo.headline}
                            </div>
                            {topC.tradeHorizon &&
                              topC.tradeHorizon.category !==
                                'PENDING_OR_NEUTRAL' && (
                                <div
                                  className={`mt-0.5 text-[10px] font-mono tabular-nums truncate ${getTradeHorizonToneClass(
                                    topC.tradeHorizon.category
                                  )}`}
                                >
                                  建議週期：{topC.tradeHorizon.labelZh} ·{' '}
                                  {topC.tradeHorizon.holdingWindowZh}
                                </div>
                              )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Right 6 cols: WATCH & Near-Miss compact side-by-side */}
                  <div className="@4xl:col-span-6 grid grid-cols-1 gap-2 @xl:grid-cols-2 text-xs">
                    {/* Approaching Full SMC Evaluation (WATCH / Candidates) */}
                    <div className="min-w-0 overflow-hidden rounded-xl border border-sky-500/25 bg-slate-950/70 px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-[11px] text-sky-300 truncate">
                            接近 SMC 完整評估狀態 (WATCH / 結構已成形)
                          </span>
                          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 shrink-0">
                            {watchApproachCandidates.length}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setCategoryFilter(
                              categoryFilter === 'SMC_WATCH' ? 'ALL' : 'SMC_WATCH'
                            )
                          }
                          className="text-[10px] font-medium text-sky-300 hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                        >
                          {categoryFilter === 'SMC_WATCH' ? '全部' : '篩選 →'}
                        </button>
                      </div>
                      {watchApproachCandidates.length === 0 ? (
                        <div className="text-[10px] text-slate-400 truncate">
                          尚無 WATCH 或正式候選標的（背景評估中）。
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5">
                          {watchApproachCandidates.slice(0, 4).map((wc) => (
                            <button
                              key={wc.symbol}
                              type="button"
                              onClick={() =>
                                loadSymbolDetail(wc.symbol, selectedTimeframe)
                              }
                              className={`min-w-0 overflow-hidden text-left rounded-lg border px-2 py-1 transition-colors cursor-pointer ${
                                wc.symbol === selectedSymbol
                                  ? 'border-amber-500/80 bg-slate-900'
                                  : 'border-slate-800/80 bg-slate-900/50 hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1 font-mono text-[10px]">
                                <span className="font-bold text-slate-100 truncate">
                                  {wc.symbol.replace('USDT', '')}
                                </span>
                                <span
                                  className={`font-semibold shrink-0 ${getSmcStateColor(wc.smcActionState)}`}
                                >
                                  {wc.score}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Near-Miss (Missing 1-2 Gates) */}
                    <div className="min-w-0 overflow-hidden rounded-xl border border-amber-500/25 bg-slate-950/70 px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-[11px] text-amber-300 truncate">
                            差一點就通過 (Near-Miss 差 1~2 項 Gate)
                          </span>
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300 shrink-0">
                            {nearMissSymbolSet.size}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setCategoryFilter(
                              categoryFilter === 'NEAR_MISS' ? 'ALL' : 'NEAR_MISS'
                            )
                          }
                          className="text-[10px] font-medium text-amber-300 hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                        >
                          {categoryFilter === 'NEAR_MISS' ? '全部' : '篩選 →'}
                        </button>
                      </div>
                      {nearMissRecords.length === 0 ? (
                        <div className="text-[10px] text-slate-400 truncate">
                          尚無只差 1~2 項 Gate 的 Near-Miss 標的。
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5">
                          {nearMissRecords.slice(0, 4).map((nm) => (
                            <button
                              key={nm.symbol}
                              type="button"
                              onClick={() =>
                                loadSymbolDetail(nm.symbol, selectedTimeframe)
                              }
                              className={`min-w-0 overflow-hidden text-left rounded-lg border px-2 py-1 transition-colors cursor-pointer ${
                                nm.symbol === selectedSymbol
                                  ? 'border-amber-500/80 bg-slate-900'
                                  : 'border-slate-800/80 bg-slate-900/50 hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1 font-mono text-[10px]">
                                <span className="font-bold text-slate-100 truncate">
                                  {nm.symbol.replace('USDT', '')}
                                </span>
                                <span
                                  className={`rounded px-1 text-[9px] font-bold shrink-0 ${
                                    nm.missingGateCount === 1
                                      ? 'bg-amber-500/20 text-amber-300'
                                      : 'bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  -{nm.missingGateCount}項
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Dedicated Formal Confirmed SMC Candidates Strip (Strict Gate Passed Only) */}
                <div
                  id="formal-smc-panel"
                  className="border-t border-slate-800/70 pt-2.5 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-emerald-300">
                        正式 SMC 確認清單 (Formal SMC · 已通過全部結構與閘門)
                      </span>
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                        {confirmedSmcCandidates.length} 檔
                      </span>
                      <span className="font-mono text-[10px] text-slate-300">
                        多 {confirmedSmcLongCount} · 空 {confirmedSmcShortCount}
                      </span>
                      <span className="text-[10px] text-slate-400 truncate">
                        僅列第二層為 LONG / SHORT CANDIDATE 之正式候選標的（與 finalTradeSignal 1:1 一致，PAPER ONLY）
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCategoryFilter(
                          categoryFilter === 'SMC_CONFIRMED'
                            ? 'ALL'
                            : 'SMC_CONFIRMED'
                        )
                      }
                      className="text-[11px] font-medium text-emerald-300 hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      {categoryFilter === 'SMC_CONFIRMED'
                        ? '顯示全部 →'
                        : '僅看正式 SMC →'}
                    </button>
                  </div>

                  {confirmedSmcCandidates.length === 0 ? (
                    <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
                      目前尚無同時通過多週期共振與全部安全閘門之正式 SMC 候選標的（可先觀察上方 WATCH 或下方「早鳥起漲」）。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @4xl:grid-cols-4">
                      {confirmedSmcCandidates.slice(0, 8).map((cc) => {
                        const isSel = cc.symbol === selectedSymbol;
                        const isLong = cc.smcActionState === 'LONG CANDIDATE';
                        const zone = cc.entryZoneSummary;
                        return (
                          <button
                            key={cc.symbol}
                            type="button"
                            onClick={() =>
                              loadSymbolDetail(cc.symbol, selectedTimeframe)
                            }
                            className={`min-w-0 overflow-hidden text-left rounded-xl border px-3 py-2 transition-all cursor-pointer ${
                              isSel
                                ? isLong
                                  ? 'border-emerald-400/80 bg-slate-950 shadow-sm'
                                  : 'border-rose-400/80 bg-slate-950 shadow-sm'
                                : isLong
                                  ? 'border-emerald-500/25 bg-slate-950/60 hover:border-emerald-400/50'
                                  : 'border-rose-500/25 bg-slate-950/60 hover:border-rose-400/50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5 font-mono text-[11px]">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-bold text-slate-100 truncate">
                                  {cc.symbol}
                                </span>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 ${
                                    isLong
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : 'bg-rose-500/15 text-rose-300'
                                  }`}
                                >
                                  {isLong ? '正式多單' : '正式空單'}
                                </span>
                              </div>
                              <span
                                className={`font-bold shrink-0 ${
                                  isLong ? 'text-emerald-300' : 'text-rose-300'
                                }`}
                              >
                                {cc.score}分
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1.5 font-mono text-[10px] tabular-nums">
                              <span className="text-slate-200 truncate">
                                ${formatPriceDynamic(cc.lastPrice)}
                              </span>
                              <span
                                className={`shrink-0 ${
                                  cc.priceChangePercent24h >= 0
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-rose-400 font-semibold'
                                }`}
                              >
                                {cc.priceChangePercent24h >= 0 ? '+' : ''}
                                {cc.priceChangePercent24h.toFixed(2)}%
                              </span>
                              <span className="text-amber-300 shrink-0">
                                {cc.historicalVolume.status === 'READY'
                                  ? `15m ${cc.historicalVolume.rvol}x`
                                  : '收集中'}
                              </span>
                            </div>
                            <div
                              className={`mt-0.5 text-[10px] truncate ${
                                zone?.status === 'OVEREXTENDED'
                                  ? 'text-amber-300'
                                  : zone?.status === 'NEAR_POI'
                                    ? 'text-emerald-300'
                                    : zone?.status === 'NEAR_PULLBACK_ZONE'
                                      ? 'text-sky-300'
                                      : 'text-slate-400'
                              }`}
                            >
                              {zone?.status === 'OVEREXTENDED'
                                ? `延伸過熱 (${zone.distanceToZoneAtr !== null ? `${zone.distanceToZoneAtr.toFixed(2)}x ATR` : '遠離區間'}) · 建議等回踩 ${zone.anchorLabel}`
                                : zone?.status === 'NEAR_POI'
                                  ? `已入 ${zone.anchorLabel} 理想回踩區`
                                  : zone?.status === 'NEAR_PULLBACK_ZONE'
                                    ? `接近 ${zone.anchorLabel} 回踩區`
                                    : isLong
                                      ? '已通過全部多頭結構與閘門 · 可評估紙上做多'
                                      : '已通過全部空頭結構與閘門 · 可評估紙上做空'}
                            </div>
                            {cc.tradeHorizon &&
                              cc.tradeHorizon.category !==
                                'PENDING_OR_NEUTRAL' && (
                                <div
                                  className={`mt-0.5 text-[10px] font-mono tabular-nums truncate ${getTradeHorizonToneClass(
                                    cc.tradeHorizon.category
                                  )}`}
                                >
                                  {cc.tradeHorizon.verdictShortZh} ·{' '}
                                  {cc.tradeHorizon.holdingWindowZh}
                                </div>
                              )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Early Ignition Hunter Strip (Independent of Strict SMC Lag) */}
                <div
                  id="early-ignition-panel"
                  className="border-t border-slate-800/70 pt-2.5 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-cyan-300">
                        早鳥起漲獵手 (Early Ignition · 剛放量且未漲遠)
                      </span>
                      <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                        {earlyIgnitionCandidates.length} 檔
                      </span>
                      <span className="text-[10px] text-slate-400 truncate">
                        獨立軌道（尚未等 1h/4h 共振，嚴格守前低／掃單極值止損，不計入正式 SMC 候選）
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCategoryFilter(
                          categoryFilter === 'EARLY_IGNITION'
                            ? 'ALL'
                            : 'EARLY_IGNITION'
                        )
                      }
                      className="text-[11px] font-medium text-cyan-300 hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      {categoryFilter === 'EARLY_IGNITION'
                        ? '顯示全部 →'
                        : '僅看早鳥起漲 →'}
                    </button>
                  </div>

                  {earlyIgnitionCandidates.length === 0 ? (
                    <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
                      目前無同時符合「24h 漲幅溫和 + 15m 剛放量或 5m/15m 剛轉折」之早鳥起漲標的。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @4xl:grid-cols-4">
                      {earlyIgnitionCandidates.slice(0, 4).map((ec) => {
                        const ign = ec.earlyIgnition!;
                        const isSel = ec.symbol === selectedSymbol;
                        const isLong = ign.direction === 'LONG';
                        return (
                          <button
                            key={ec.symbol}
                            type="button"
                            onClick={() =>
                              loadSymbolDetail(ec.symbol, selectedTimeframe)
                            }
                            className={`min-w-0 overflow-hidden text-left rounded-xl border px-3 py-2 transition-all cursor-pointer ${
                              isSel
                                ? 'border-cyan-400/80 bg-slate-950 shadow-sm'
                                : 'border-cyan-500/20 bg-slate-950/60 hover:border-cyan-400/50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5 font-mono text-[11px]">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-bold text-slate-100 truncate">
                                  {ec.symbol}
                                </span>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 ${
                                    isLong
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : 'bg-rose-500/15 text-rose-300'
                                  }`}
                                >
                                  {isLong ? '早鳥多' : '早鳥空'}
                                </span>
                              </div>
                              <span className="font-bold text-cyan-300 shrink-0">
                                {ign.ignitionScore}分
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1.5 font-mono text-[10px] tabular-nums">
                              <span
                                className={
                                  ign.change24hPct >= 0
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-rose-400 font-semibold'
                                }
                              >
                                24h {ign.change24hPct >= 0 ? '+' : ''}
                                {ign.change24hPct.toFixed(2)}%
                              </span>
                              <span className="text-amber-300 truncate">
                                {ign.rvol15m !== null
                                  ? `15m ${ign.rvol15m}x`
                                  : `${ign.triggerTimeframe ?? '15m'} 轉折`}
                              </span>
                              {ign.invalidationPrice !== null && (
                                <span className="text-slate-400 truncate">
                                  止損 {formatPriceDynamic(ign.invalidationPrice)}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                              {ign.headlineZh}
                            </div>
                            <div
                              className={`mt-0.5 text-[10px] font-mono tabular-nums truncate ${getTradeHorizonToneClass(
                                ec.tradeHorizon?.category ?? 'SCALP_FAST'
                              )}`}
                            >
                              {ec.tradeHorizon &&
                              ec.tradeHorizon.category !== 'PENDING_OR_NEUTRAL'
                                ? `${ec.tradeHorizon.labelZh} · ${ec.tradeHorizon.holdingWindowZh}`
                                : '短線快打 · 30分 ~ 2 小時（尚未等 1h/4h 共振）'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Pullback Ready Sniper Strip (FVG / OB Discount or Near Zone) */}
                <div
                  id="pullback-sniper-panel"
                  className="border-t border-slate-800/70 pt-2.5 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-amber-300">
                        回踩狙擊雷達 (FVG / OB 興趣區 POI)
                      </span>
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                        {pullbackReadyCandidates.length} 檔
                      </span>
                      <span className="text-[10px] text-slate-400 truncate">
                        已進入或緊貼理想 FVG / OB 回踩區（依貼近距離與回踩 R:R 排序）
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCategoryFilter(
                          categoryFilter === 'PULLBACK_READY'
                            ? 'ALL'
                            : 'PULLBACK_READY'
                        )
                      }
                      className="text-[11px] font-medium text-amber-300 hover:underline cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      {categoryFilter === 'PULLBACK_READY'
                        ? '顯示全部 →'
                        : '僅看回踩狙擊 →'}
                    </button>
                  </div>

                  {pullbackReadyCandidates.length === 0 ? (
                    <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
                      目前尚無已進入或接近 FVG / OB 理想回踩區間之標的，可先參考上方「正式 SMC」或「早鳥起漲」。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @4xl:grid-cols-4">
                      {pullbackReadyCandidates.slice(0, 4).map((pc) => {
                        const ez = pc.entryZoneSummary!;
                        const isSel = pc.symbol === selectedSymbol;
                        const isInZone = ez.status === 'NEAR_POI';
                        const isLong = ez.direction === 'LONG';
                        const distPct =
                          ez.distanceToZonePct !== null
                            ? Math.abs(ez.distanceToZonePct)
                            : 0;
                        return (
                          <button
                            key={pc.symbol}
                            type="button"
                            onClick={() =>
                              loadSymbolDetail(pc.symbol, selectedTimeframe)
                            }
                            className={`min-w-0 overflow-hidden text-left rounded-xl border px-3 py-2 transition-all cursor-pointer ${
                              isSel
                                ? 'border-amber-400/80 bg-slate-950 shadow-sm'
                                : isInZone
                                  ? 'border-emerald-500/30 bg-slate-950/60 hover:border-emerald-400/60'
                                  : 'border-sky-500/25 bg-slate-950/60 hover:border-sky-400/50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5 font-mono text-[11px]">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-bold text-slate-100 truncate">
                                  {pc.symbol}
                                </span>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 ${
                                    isInZone
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : 'bg-sky-500/15 text-sky-300'
                                  }`}
                                >
                                  {isInZone ? '已入回踩區' : '接近回踩區'}
                                </span>
                              </div>
                              <span
                                className={`font-bold shrink-0 ${
                                  isLong ? 'text-emerald-300' : 'text-rose-300'
                                }`}
                              >
                                {isLong ? '回踩多' : '回踩空'}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1.5 font-mono text-[10px] tabular-nums">
                              <span className="text-slate-200 truncate">
                                掛 ${formatPriceDynamic(ez.idealPullbackEntry!)}
                              </span>
                              <span className="text-amber-300 shrink-0">
                                距 {distPct.toFixed(2)}%
                              </span>
                              {ez.pullbackRR !== null && (
                                <span className="text-emerald-300 shrink-0">
                                  R:R 1:{ez.pullbackRR}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                              {ez.anchorLabel} · {pc.smcActionState}
                              {pc.tradeHorizon &&
                              pc.tradeHorizon.category !== 'PENDING_OR_NEUTRAL'
                                ? ` · ${pc.tradeHorizon.labelZh} (${pc.tradeHorizon.holdingWindowZh})`
                                : ''}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Integrated Market Breadth & 8-Sector Strip */}
                <div className="border-t border-slate-800/70 pt-2.5">
                  <MarketBreadthSectorPanel
                    breadth={scanData.marketBreadth}
                    sectors={scanData.sectorRotation}
                    activeSector={sectorFilter}
                    onSelectSector={setSectorFilter}
                    onSelectSymbol={(sym) =>
                      loadSymbolDetail(sym, selectedTimeframe)
                    }
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
            {/* Left Column (42%): Streamlined 5-Column Candidate Table (Hidden when Right Workstation is Full-Width) */}
            {!detailExpanded && (
            <div className="xl:col-span-5 apple-bento-card overflow-hidden min-w-0">
              <div className="flex flex-col gap-2.5 border-b border-slate-800/70 px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <h2 className="text-sm font-semibold tracking-tight text-slate-100">
                      USDT 永續合約候選清單 ({filteredCandidates.length})
                    </h2>
                    <span className="text-[11px] font-medium text-amber-300 truncate">
                      · 點擊任一標的查看右側工作站
                    </span>
                  </div>
                </div>
                <div className="apple-segmented-track flex flex-wrap items-center gap-1 p-1 text-[11px]">
                  {(
                    [
                      { key: 'ALL', label: '全部標的' },
                      { key: 'WATCHLIST', label: `★ 自選 (${watchlist.length})` },
                      {
                        key: 'SMC_CONFIRMED',
                        label: `正式 SMC (${confirmedSmcCandidates.length})`,
                      },
                      {
                        key: 'EARLY_IGNITION',
                        label: `早鳥 (${earlyIgnitionCandidates.length})`,
                      },
                      {
                        key: 'PULLBACK_READY',
                        label: `回踩狙擊 (${pullbackReadyCandidates.length})`,
                      },
                      {
                        key: 'SMC_WATCH',
                        label: `接近 SMC (${watchApproachCandidates.length})`,
                      },
                      {
                        key: 'NEAR_MISS',
                        label: `差一點 (${nearMissSymbolSet.size})`,
                      },
                      { key: '準備觀察', label: '準備觀察' },
                      { key: '雷達多頭觀察', label: '多頭雷達' },
                      { key: '雷達空頭觀察', label: '空頭雷達' },
                      { key: '多頭候選', label: '多頭候選' },
                      { key: '空頭候選', label: '空頭候選' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => {
                        setCategoryFilter(f.key);
                        if (f.key === 'ALL') {
                          setSectorFilter('ALL');
                        }
                      }}
                      className={`px-2 py-1 text-[11px] cursor-pointer transition-all whitespace-nowrap ${
                        categoryFilter === f.key
                          ? 'apple-segmented-pill-active text-amber-200 font-semibold'
                          : 'rounded-lg text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="max-h-[760px] overflow-x-auto overflow-y-auto">
                <table className="w-full border-collapse text-left text-xs table-fixed">
                  <thead className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#11131a] text-slate-400 text-[11px]">
                    <tr>
                      <th className="w-9 py-2.5 pl-3 pr-1 font-medium">★</th>
                      <th className="w-[104px] py-2.5 px-1.5 font-medium">合約標的</th>
                      <th className="py-2.5 px-1.5 font-medium">
                        雙層分類 / SMC 狀態 / 訊號
                      </th>
                      <th className="w-[110px] py-2.5 px-1.5 text-right font-medium">
                        價格 / 24h / BTC
                      </th>
                      <th className="w-[92px] py-2.5 pl-1.5 pr-3 text-right font-medium">
                        Score / 量費
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                    {scanLoading ? (
                      Array.from({ length: 8 }).map((_, idx) => (
                        <tr key={idx} className="animate-pulse">
                          <th
                            colSpan={5}
                            className="py-3.5 px-4 text-left font-normal text-slate-600"
                          >
                            正在載入並計算全市場規則證據...
                          </th>
                        </tr>
                      ))
                    ) : filteredCandidates.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="py-12 text-center font-sans text-sm text-slate-400 px-4"
                        >
                          {scanError
                            ? '即時資料不可用（候選清單已清空）。請重試即時連線，或手動按下「切換 Demo 驗證模式」。'
                            : '無符合目前篩選條件之合約標的。'}
                        </td>
                      </tr>
                    ) : (
                      filteredCandidates.map((c) => {
                        const isSelected = c.symbol === selectedSymbol;
                        const inWatchlist = watchlist.includes(c.symbol);
                        const hv = c.historicalVolume;
                        const rowSmcEvalStatus =
                          isSelected && symbolDetail?.symbol === c.symbol
                            ? symbolDetail.smcAnalysis.smcEvaluationStatus
                            : c.smcEvaluationStatus;
                        const rowSmcState =
                          isSelected && symbolDetail?.symbol === c.symbol
                            ? symbolDetail.smcAnalysis.actionState
                            : c.smcActionState;
                        const rowPlain = getPlainLanguageRowExplanation(
                          c,
                          rowSmcState,
                          rowSmcEvalStatus
                        );
                        const btcCorr = c.btcCorrelation;
                        const use15m = btcCorr?.pearson15m !== null;
                        const btcOvVal = use15m
                          ? btcCorr?.directionalOverlap15m
                          : btcCorr?.directionalOverlap1h;
                        const btcRVal = use15m ? btcCorr?.pearson15m : btcCorr?.pearson1h;

                        return (
                          <tr
                            key={c.symbol}
                            onClick={() =>
                              loadSymbolDetail(c.symbol, selectedTimeframe)
                            }
                            className={`radar-table-row cursor-pointer ${
                              isSelected
                                ? 'bg-amber-500/12 text-slate-100'
                                : 'hover:bg-slate-800/40 text-slate-300'
                            }`}
                          >
                            <td
                              className="py-2.5 pl-3 pr-1 align-top"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWatchlist(c.symbol);
                              }}
                            >
                              <button
                                type="button"
                                aria-label={`切換觀察清單 ${c.symbol}`}
                                className={`p-1 rounded-md cursor-pointer transition-colors ${
                                  inWatchlist
                                    ? 'text-amber-400'
                                    : 'text-slate-600 hover:text-slate-400'
                                }`}
                              >
                                <Bookmark
                                  className="h-3.5 w-3.5"
                                  fill={inWatchlist ? 'currentColor' : 'none'}
                                />
                              </button>
                            </td>
                            <td className="py-2.5 px-1.5 align-top font-semibold text-slate-100">
                              <div className="tracking-tight truncate">
                                {c.symbol}
                              </div>
                              <div className="text-[10px] font-normal text-slate-400 truncate">
                                {c.provenance.isDemo ? 'DEMO' : 'LIVE'} ·{' '}
                                {c.isLowLiquidity ? '低流動' : '主流'}
                              </div>
                              <div className="text-[10px] font-normal text-slate-500 truncate">
                                額 ${formatUsdCompact(c.quoteVolume24h)}
                              </div>
                            </td>
                            <td className="py-2.5 px-1.5 align-top font-sans min-w-0">
                              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                                <span
                                  className={`font-semibold truncate ${getMarketRadarTextColor(
                                    c.marketRadarCategory
                                  )}`}
                                >
                                  {c.marketRadarCategory}
                                </span>
                                <span className="text-slate-600">·</span>
                                {rowSmcEvalStatus === 'PENDING' ||
                                rowSmcState === 'PENDING' ? (
                                  <span className="font-mono text-[10px] text-slate-400 truncate">
                                    SMC PENDING
                                  </span>
                                ) : (
                                  <span
                                    className={`font-mono text-[10px] font-semibold truncate ${getSmcStateColor(
                                      rowSmcState
                                    )}`}
                                  >
                                    {rowSmcState}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-slate-400">
                                <span className="truncate">
                                  訊號：
                                  <span
                                    className={
                                      c.finalTradeSignal === '多頭交易候選'
                                        ? 'text-emerald-400 font-semibold'
                                        : c.finalTradeSignal === '空頭交易候選'
                                          ? 'text-rose-400 font-semibold'
                                          : 'text-slate-300'
                                    }
                                  >
                                    {c.finalTradeSignal}
                                  </span>
                                </span>
                                {c.earlyIgnition &&
                                  c.earlyIgnition.status !== 'NONE' && (
                                    <span className="rounded bg-cyan-500/15 px-1 py-0.2 text-[9px] font-semibold text-cyan-300 shrink-0">
                                      {c.earlyIgnition.direction === 'LONG'
                                        ? '早鳥多'
                                        : '早鳥空'}
                                    </span>
                                  )}
                                {c.entryZoneSummary?.status ===
                                  'OVEREXTENDED' && (
                                  <span className="rounded bg-amber-500/15 px-1 py-0.2 text-[9px] font-semibold text-amber-300 shrink-0">
                                    延伸警戒
                                  </span>
                                )}
                              </div>
                              <div
                                className={`mt-0.5 text-[10px] font-sans truncate ${rowPlain.toneClass}`}
                                title={rowPlain.headline}
                              >
                                {rowPlain.headline}
                              </div>
                              {c.tradeHorizon &&
                                c.tradeHorizon.category !==
                                  'PENDING_OR_NEUTRAL' && (
                                  <div
                                    className={`mt-0.5 text-[10px] font-mono tabular-nums truncate ${getTradeHorizonToneClass(
                                      c.tradeHorizon.category
                                    )}`}
                                  >
                                    {c.tradeHorizon.labelZh} ·{' '}
                                    {c.tradeHorizon.holdingWindowZh}
                                  </div>
                                )}
                            </td>
                            <td className="py-2.5 px-1.5 align-top text-right">
                              <div className="truncate font-semibold text-slate-100">
                                ${formatPriceDynamic(c.lastPrice)}
                              </div>
                              <div
                                className={`text-[11px] font-medium truncate ${
                                  c.priceChangePercent24h >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {c.priceChangePercent24h >= 0 ? '+' : ''}
                                {c.priceChangePercent24h.toFixed(2)}%
                              </div>
                              <div className="text-[10px] text-slate-400 truncate">
                                {c.symbol === 'BTCUSDT'
                                  ? 'BTC 基準'
                                  : btcCorr?.status === 'READY' && btcOvVal != null
                                    ? `重合 ${btcOvVal.toFixed(0)}% · r${btcRVal?.toFixed(2) ?? ''}`
                                    : `vsBTC ${c.relativeBtcStrength >= 0 ? '+' : ''}${c.relativeBtcStrength.toFixed(1)}%`}
                              </div>
                            </td>
                            <td className="py-2.5 pl-1.5 pr-3 align-top text-right">
                              <div className="font-bold text-slate-100 truncate">
                                {c.score}
                                {c.scoreCapApplied && (
                                  <span className="ml-0.5 text-[9px] font-normal text-amber-400">
                                    (Cap)
                                  </span>
                                )}
                              </div>
                              <div
                                className={`text-[10px] truncate ${
                                  hv.status === 'READY' && hv.isHistoricalAnomaly
                                    ? 'text-amber-300 font-semibold'
                                    : 'text-slate-400'
                                }`}
                              >
                                {hv.status === 'READY'
                                  ? `RVOL ${hv.rvol}x`
                                  : '累積中'}
                              </div>
                              <div
                                className={`text-[10px] truncate ${
                                  c.extremeFunding
                                    ? 'text-amber-300 font-semibold'
                                    : 'text-slate-400'
                                }`}
                              >
                                {c.fundingRate !== null
                                  ? `F ${(c.fundingRate * 100).toFixed(3)}%`
                                  : 'F 缺失'}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            )}

            {/* Right Column (58% split or 100% expanded): Tabbed Symbol Workstation */}
            <div
              className={`${
                detailExpanded ? 'xl:col-span-12' : 'xl:col-span-7'
              } min-w-0 space-y-4`}
            >
              {scanError ? (
                <div className="apple-bento-card border-rose-500/40 bg-rose-950/30 p-6 text-xs text-rose-200 space-y-2">
                  <div className="font-semibold text-sm text-rose-300">
                    即時資料不可用
                  </div>
                  <p>
                    目前外部即時 API 無法連線，系統不會自動載入任何模擬幣種詳情。若需驗證系統功能，請手動點擊上方「切換 Demo 驗證模式」。
                  </p>
                </div>
              ) : detailLoading &&
                (!symbolDetail || symbolDetail.symbol !== selectedSymbol) ? (
                <div className="apple-bento-card p-8 text-center text-sm text-slate-400">
                  正在載入 {selectedSymbol} 之 Open Interest、K 線、歷史成交量基線與 Decision Trace...
                </div>
              ) : detailError ? (
                <div className="apple-bento-card border-rose-500/40 bg-rose-950/30 p-6 text-xs text-rose-200">
                  {detailError}
                </div>
              ) : symbolDetail ? (
                <div className="@container apple-bento-card p-4 sm:p-5 space-y-4 min-w-0 overflow-hidden">
                  {/* Compact Workstation Header */}
                  <div className="space-y-2.5 border-b border-slate-800/70 pb-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1 min-w-[240px] space-y-1">
                        <div className="flex flex-wrap items-baseline gap-2.5">
                          <h3 className="text-xl sm:text-2xl font-bold tracking-tight font-mono text-slate-100">
                            {symbolDetail.symbol}
                          </h3>
                          <span className="font-mono text-base font-bold text-slate-100 tabular-nums">
                            ${formatPriceDynamic(symbolDetail.candidate.lastPrice)}
                          </span>
                          <span
                            className={`font-mono text-xs font-semibold tabular-nums ${
                              symbolDetail.candidate.priceChangePercent24h >= 0
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {symbolDetail.candidate.priceChangePercent24h >= 0 ? '+' : ''}
                            {symbolDetail.candidate.priceChangePercent24h.toFixed(2)}%
                          </span>
                        </div>
                        <div
                          className={`text-xs font-semibold ${getMarketRadarTextColor(
                            symbolDetail.candidate.marketRadarCategory
                          )}`}
                        >
                          {symbolDetail.candidate.marketRadarCategory} (Score:{' '}
                          {symbolDetail.candidate.score}
                          {symbolDetail.candidate.scoreCapApplied
                            ? ` / 原始 ${symbolDetail.candidate.rawScoreBeforeCap}`
                            : ''}
                          )
                        </div>
                      </div>

                      {/* SMC/ICT Output State Box + Full-Width Toggle */}
                      <div className="flex flex-wrap items-start gap-2 shrink-0">
                        <div className="rounded-xl border border-slate-800/80 bg-slate-950/90 px-3 py-1.5 text-right">
                          <div className="text-[10px] text-slate-400">
                            第二層：SMC 評估狀態 ({symbolDetail.smcAnalysis.smcEvaluationStatus})
                          </div>
                          <div
                            className={`text-sm font-bold font-mono tracking-wide ${getSmcStateColor(
                              symbolDetail.smcAnalysis.actionState
                            )}`}
                          >
                            {symbolDetail.smcAnalysis.actionState === 'PENDING'
                              ? 'SMC 尚未評估'
                              : symbolDetail.smcAnalysis.actionState}
                          </div>
                          <div className="mt-0.5 flex items-center justify-end gap-2 text-[10px] font-mono text-slate-400">
                            <span>
                              {symbolDetail.smcAnalysis.evaluatedAt
                                ? formatTaipeiTime(symbolDetail.smcAnalysis.evaluatedAt)
                                : formatTaipeiTime(symbolDetail.provenance.fetchedAt)}
                              <span className="text-slate-500"> 台北</span>
                            </span>
                            <button
                              type="button"
                              disabled={smcQueueLoading}
                              onClick={() =>
                                refreshSingleSmcSymbol(symbolDetail.symbol)
                              }
                              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20 cursor-pointer disabled:opacity-50"
                            >
                              重新評估單幣種 SMC
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setDetailExpanded((v) => !v)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-200 hover:border-amber-400/60 hover:text-amber-200 cursor-pointer whitespace-nowrap"
                          title={
                            detailExpanded
                              ? '恢復左右雙欄視圖'
                              : '展開全寬看盤工作站'
                          }
                        >
                          {detailExpanded ? (
                            <>
                              <Minimize2 className="h-3.5 w-3.5" />
                              <span>恢復雙欄</span>
                            </>
                          ) : (
                            <>
                              <Maximize2 className="h-3.5 w-3.5" />
                              <span>展開全寬看盤</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <ProvenanceLine
                      provenance={symbolDetail.provenance}
                      prefixLabel="單幣種詳情來源"
                      smcEvaluationStatus={
                        symbolDetail.smcAnalysis.smcEvaluationStatus
                      }
                    />

                    {/* Slim Two-Layer Result Summary */}
                    <div className="rounded-xl border border-slate-800/80 bg-slate-950/85 px-3.5 py-2.5 text-xs space-y-1">
                      <div className="grid grid-cols-1 gap-1.5 @xl:grid-cols-3 font-mono text-[11px]">
                        <div className="min-w-0 truncate">
                          <span className="text-slate-400">第一層：市場雷達分類：</span>
                          <strong
                            className={getMarketRadarTextColor(
                              symbolDetail.candidate.marketRadarCategory
                            )}
                          >
                            {symbolDetail.candidate.marketRadarCategory}
                          </strong>
                        </div>
                        <div className="min-w-0 truncate">
                          <span className="text-slate-400">第二層：SMC 評估狀態：</span>
                          <strong
                            className={getSmcStateColor(
                              symbolDetail.smcAnalysis.actionState
                            )}
                          >
                            {symbolDetail.smcAnalysis.actionState === 'PENDING'
                              ? 'SMC 尚未評估 (PENDING)'
                              : `${symbolDetail.smcAnalysis.actionState} (${symbolDetail.smcAnalysis.smcEvaluationStatus})`}
                          </strong>
                        </div>
                        <div className="min-w-0 truncate">
                          <span className="text-slate-400">最終交易訊號：</span>
                          <strong
                            className={
                              symbolDetail.candidate.finalTradeSignal ===
                              '多頭交易候選'
                                ? 'text-emerald-400'
                                : symbolDetail.candidate.finalTradeSignal ===
                                    '空頭交易候選'
                                  ? 'text-rose-400'
                                  : 'text-amber-300'
                            }
                          >
                            {symbolDetail.candidate.finalTradeSignal}
                          </strong>
                        </div>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">
                        SMC evaluatedAt:{' '}
                        <span className="text-slate-300">
                          {symbolDetail.smcAnalysis.evaluatedAt ??
                            symbolDetail.candidate.smcEvaluatedAt ??
                            symbolDetail.provenance.fetchedAt}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-300 break-words">
                        <span className="text-slate-400 font-mono">原因：</span>
                        {symbolDetail.smcAnalysis.actionState === 'PENDING'
                          ? 'SMC 尚未評估／點擊載入單幣種結構（尚未載入完整 5m/15m/1h/4h K 線）'
                          : symbolDetail.smcAnalysis.actionState === 'WAIT'
                            ? symbolDetail.smcAnalysis.waitReasons.length > 0
                              ? `尚未形成完整 MSS/FVG/OB 或多週期未確認（${symbolDetail.smcAnalysis.waitReasons.join('；')}）`
                              : '尚未形成完整 MSS/FVG/OB 或多週期未確認'
                            : symbolDetail.smcAnalysis.actionState === 'WATCH'
                              ? '已偵測部分結構證據（如 FVG 或多週期方向一致），等待完整 BOS/MSS、流動性清掃與強勢位移確認（不可交易，finalTradeSignal=NONE）'
                              : symbolDetail.smcAnalysis.actionState ===
                                  'HIGH RISK'
                                ? `高風險狀態（${symbolDetail.smcAnalysis.waitReasons.join('；') || '極端資金費率或低流動性高波動'}）`
                                : `已確認完整 ${symbolDetail.smcAnalysis.actionState} 結構與多週期共振`}
                      </div>
                    </div>

                    {/* Clear Trade Horizon Verdict (Short-Term vs Swing Holding Guide) */}
                    {(() => {
                      const th =
                        symbolDetail.tradeHorizon ??
                        symbolDetail.smcAnalysis.tradeHorizon ??
                        symbolDetail.candidate.tradeHorizon;
                      if (!th) return null;
                      const isPending = th.category === 'PENDING_OR_NEUTRAL';
                      const containerTone =
                        th.category === 'SWING_EXTENDED'
                          ? 'border-violet-500/35 bg-slate-950/90'
                          : th.category === 'INTRADAY_TREND'
                            ? 'border-sky-500/35 bg-slate-950/90'
                            : th.category === 'SCALP_FAST'
                              ? 'border-amber-500/35 bg-slate-950/90'
                              : 'border-slate-800/80 bg-slate-950/80';
                      return (
                        <div
                          id="trade-horizon-panel"
                          className={`rounded-xl border px-3.5 py-2.5 text-xs space-y-2 ${containerTone}`}
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="flex flex-wrap items-baseline gap-2 min-w-0">
                              <span className="font-semibold text-slate-200">
                                長短線交易結論
                              </span>
                              <span className="text-slate-600" aria-hidden="true">
                                ·
                              </span>
                              <span
                                className={`text-sm font-bold ${getTradeHorizonToneClass(
                                  th.category
                                )}`}
                              >
                                {th.verdictShortZh}
                              </span>
                              <span className="text-slate-600" aria-hidden="true">
                                ·
                              </span>
                              <span className="font-mono text-[11px] tabular-nums text-slate-200">
                                建議持倉：{th.holdingWindowZh}
                              </span>
                            </div>
                            <span className="text-[11px] font-mono text-slate-400">
                              {isPending
                                ? '先等待方向表態'
                                : th.category === 'SWING_EXTENDED'
                                  ? '具備高週期共振與抱單空間'
                                  : th.category === 'INTRADAY_TREND'
                                    ? '當日內順勢結案為主'
                                    : '短線動能訊號，勿扛長單'}
                            </span>
                          </div>

                          <div className="text-[11px] text-slate-300 leading-relaxed break-words">
                            <span>{th.summaryZh}</span>{' '}
                            <span className="text-slate-100 font-medium">
                              操作準則：{th.executionPlaybookZh}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-slate-800/70 @3xl:grid-cols-4 font-mono tabular-nums text-[11px]">
                            {th.criteria.map((cr) => (
                              <div key={cr.key} className="min-w-0 space-y-0.5">
                                <div className="flex items-center justify-between gap-1 text-[10px]">
                                  <span className="font-sans text-slate-400 truncate">
                                    {cr.labelZh}
                                  </span>
                                  <span
                                    className={
                                      cr.passedForSwing
                                        ? 'text-emerald-400 font-semibold shrink-0'
                                        : 'text-amber-300 shrink-0'
                                    }
                                  >
                                    {cr.passedForSwing ? '利長抱 ✓' : '偏短線'}
                                  </span>
                                </div>
                                <div className="text-slate-100 font-semibold truncate">
                                  {cr.valueText}
                                </div>
                                <div className="font-sans text-[10px] text-slate-400 leading-snug break-words">
                                  {cr.impactZh}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Key Metrics Row: 2 cols split -> 4 cols wide, strictly overflow-protected */}
                    <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4 font-mono tabular-nums text-xs">
                      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/70 p-2.5">
                        <div className="font-sans text-[10px] text-slate-400 truncate">
                          最新價格 / 盤口 Spread
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-100 truncate">
                          ${formatPriceDynamic(symbolDetail.candidate.lastPrice)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                          {symbolDetail.candidate.spreadPercent !== null
                            ? `Spread ${symbolDetail.candidate.spreadPercent.toFixed(4)}%`
                            : 'Spread 不可用'}
                        </div>
                      </div>
                      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/70 p-2.5">
                        <div className="font-sans text-[10px] text-slate-400 truncate">
                          Open Interest (OI) / Funding
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-100 truncate">
                          {symbolDetail.openInterest.openInterestValue !== null
                            ? `$${formatUsdCompact(
                                symbolDetail.openInterest.openInterestValue
                              )}`
                            : symbolDetail.openInterest.openInterest !== null
                              ? `${symbolDetail.openInterest.openInterest}`
                              : '缺失 (觸發 WAIT)'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                          Funding:{' '}
                          <span
                            className={
                              symbolDetail.candidate.extremeFunding
                                ? 'text-amber-300 font-semibold'
                                : 'text-slate-200'
                            }
                          >
                            {symbolDetail.candidate.fundingRate !== null
                              ? `${(symbolDetail.candidate.fundingRate * 100).toFixed(4)}%`
                              : '缺失'}
                          </span>
                        </div>
                      </div>
                      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/70 p-2.5">
                        <div className="font-sans text-[10px] text-slate-400 truncate">
                          歷史量能 RVOL / Z ({symbolDetail.candidate.historicalVolume.volumeTimeframe ?? '15m'})
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-amber-300 truncate">
                          {symbolDetail.candidate.historicalVolume.status ===
                          'READY'
                            ? `${symbolDetail.candidate.historicalVolume.rvol}x (Z=${symbolDetail.candidate.historicalVolume.zScore})`
                            : `${symbolDetail.candidate.historicalVolume.status} (Z=${symbolDetail.candidate.historicalVolume.rawRobustZScore ?? 'N/A'})`}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                          {symbolDetail.candidate.historicalVolume.rollingMedian !==
                          null
                            ? `Med $${formatUsdCompact(
                                symbolDetail.candidate.historicalVolume
                                  .rollingMedian ?? 0
                              )} / MAD $${formatUsdCompact(
                                symbolDetail.candidate.historicalVolume.mad ?? 0
                              )}`
                            : `N=${symbolDetail.candidate.historicalVolume.sampleCount}/${symbolDetail.candidate.historicalVolume.minRequiredSamples}`}
                        </div>
                      </div>
                      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-800/90 bg-slate-950/70 p-2.5">
                        <div className="font-sans text-[10px] text-slate-400 truncate">
                          已確認 ATR(14) ({symbolDetail.primaryTimeframe})
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-100 truncate">
                          {symbolDetail.smcAnalysis.atr14 !== null
                            ? `${symbolDetail.smcAnalysis.atr14} (${symbolDetail.smcAnalysis.atrPercent}%)`
                            : 'K 線不足'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                          24h 額 ${formatUsdCompact(symbolDetail.candidate.quoteVolume24h)}
                        </div>
                      </div>
                    </div>

                    {/* Compact 5-Step Progress Strip & Primary Actions Bar */}
                    {(() => {
                      const plainGuide = buildPlainLanguageSmcSteps(
                        symbolDetail,
                        decisionTraceData ?? symbolDetail.candidate.decisionTrace
                      );
                      return (
                        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-800/80 bg-slate-950/85 px-3.5 py-2.5 text-xs">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span className="font-bold text-amber-300 shrink-0">
                              5 步闖關 {plainGuide.passedCount}/5
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {plainGuide.steps.map((st, i) => (
                                <span
                                  key={i}
                                  className={`h-2 w-4 rounded-full ${
                                    st.passed ? 'bg-emerald-500' : 'bg-slate-800'
                                  }`}
                                  title={`第 ${st.stepNumber} 關: ${st.title} (${st.statusLabel})`}
                                />
                              ))}
                            </div>
                            <span className="text-[11px] text-slate-300 truncate">
                              {plainGuide.recommendationTitle}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={requestGeminiExplanation}
                              disabled={geminiLoading}
                              className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              <Sparkles className="h-3 w-3" />
                              <span>
                                {geminiLoading
                                  ? '生成中...'
                                  : '產生 Gemini 證據解釋'}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={recordPaperObservation}
                              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                                symbolDetail.entryZoneAnalysis?.status ===
                                'OVEREXTENDED'
                                  ? 'border-amber-500/50 bg-amber-950/30 text-amber-200 hover:bg-amber-950/50'
                                  : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50'
                              }`}
                            >
                              {symbolDetail.entryZoneAnalysis?.status ===
                              'OVEREXTENDED'
                                ? '現價追高攔截 (建議回踩掛單)'
                                : '登記紙上觀察帳本'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void quickGuardSymbolDetail()}
                              disabled={positionSentinelLoading}
                              className="rounded-lg border border-sky-500/40 bg-sky-950/30 px-2.5 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-950/50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                            >
                              加入持倉哨兵守護
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                executeBacktest(
                                  symbolDetail.symbol,
                                  symbolDetail.primaryTimeframe
                                );
                                setActiveSection('backtest');
                              }}
                              className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                            >
                              執行回測並存檔
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {symbolDetail.btcMarketRegime &&
                      symbolDetail.symbol !== 'BTCUSDT' &&
                      (symbolDetail.btcMarketRegime.blocksLongAlts ||
                        symbolDetail.btcMarketRegime.blocksShortAlts) && (
                        <div className="rounded-xl border border-amber-500/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-200">
                          大盤順逆勢濾網提示：{symbolDetail.btcMarketRegime.warningZh}
                        </div>
                      )}

                    {overextendedChaseWarning &&
                      overextendedChaseWarning.symbol === symbolDetail.symbol && (
                        <div
                          id="overextended-anti-chase-guard"
                          className="rounded-xl border border-amber-500/60 bg-amber-950/35 p-3 text-xs space-y-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-bold text-amber-200">
                              反追價保護：{symbolDetail.symbol}{' '}
                              {overextendedChaseWarning.errorMessage ||
                                '目前價格已過度偏離 FVG/OB 結構錨點 (OVEREXTENDED)，直接市價追單勝率較低。'}
                            </span>
                            <button
                              type="button"
                              onClick={() => setOverextendedChaseWarning(null)}
                              className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {(() => {
                              const ez = symbolDetail.entryZoneAnalysis;
                              if (
                                !ez ||
                                ez.idealPullbackEntry === null ||
                                ez.stopLossPrice === null ||
                                ez.targetPrice === null ||
                                (ez.direction !== 'LONG' &&
                                  ez.direction !== 'SHORT')
                              ) {
                                return null;
                              }
                              const pullbackDir = ez.direction;
                              const pullbackEntry = ez.idealPullbackEntry;
                              const pullbackStop = ez.stopLossPrice;
                              const pullbackTarget = ez.targetPrice;
                              const pullbackLabel = ez.anchorLabel;
                              return (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOverextendedChaseWarning(null);
                                    void recordPullbackLimitPaper({
                                      side: pullbackDir,
                                      entryPrice: pullbackEntry,
                                      invalidationPrice: pullbackStop,
                                      targetPrice: pullbackTarget,
                                      anchorLabel: pullbackLabel,
                                      ttlMinutes: pullbackTtlMinutes,
                                    });
                                  }}
                                  className="rounded-lg border border-emerald-400/60 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/30 cursor-pointer"
                                >
                                  改掛 FVG/OB 回踩限價單 (${pullbackEntry})
                                </button>
                              );
                            })()}
                            <button
                              type="button"
                              onClick={() => {
                                const mode =
                                  overextendedChaseWarning.conflictMode;
                                setOverextendedChaseWarning(null);
                                void submitPaperObservation(mode, true);
                              }}
                              className="rounded-lg border border-rose-500/50 bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                            >
                              仍承受追高風險以現價登記
                            </button>
                          </div>
                        </div>
                      )}

                    {/* Pre-Trade Duplicate & High-BTC Concentration Guard Banner */}
                    {pendingPaperConflict &&
                      pendingPaperConflict.symbol === symbolDetail.symbol && (
                        <div
                          id="paper-conflict-guard"
                          className="rounded-xl border border-amber-500/60 bg-amber-950/35 p-3 text-xs space-y-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-bold text-amber-200 flex items-center gap-1.5">
                              <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
                              防呆攔截：{pendingPaperConflict.symbol} 同方向 (
                              {pendingPaperConflict.side}) 已有進行中紙上單（
                              {pendingPaperConflict.conflictingEntries
                                .map(
                                  (c) =>
                                    `#${c.id} ${
                                      c.fillStatus === 'WAITING_LIMIT'
                                        ? '待觸價'
                                        : '已成交'
                                    } $${c.entryPrice}`
                                )
                                .join('、')}
                              ）
                            </span>
                            <button
                              type="button"
                              onClick={() => setPendingPaperConflict(null)}
                              className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                          {pendingPaperConflict.highBtcSameSideCount >= 2 && (
                            <div className="text-[11px] text-rose-200">
                              組合風險提醒：帳本目前已有{' '}
                              {pendingPaperConflict.highBtcSameSideCount}{' '}
                              筆同向高 BTC 連動持倉 (r ≥ 0.70)，請留意整體大盤單邊曝險。
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                if (pendingPaperConflict.kind === 'OBSERVATION') {
                                  void submitPaperObservation('REPLACE');
                                } else if (
                                  pendingPaperConflict.kind === 'EARLY_IGNITION'
                                ) {
                                  void submitEarlyIgnitionPaper('REPLACE');
                                } else if (pendingPaperConflict.pullbackParams) {
                                  void submitPullbackLimitPaper(
                                    pendingPaperConflict.pullbackParams,
                                    'REPLACE'
                                  );
                                }
                              }}
                              className="rounded-lg border border-amber-400/60 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/30 cursor-pointer"
                            >
                              覆蓋舊單並開新單
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (pendingPaperConflict.kind === 'OBSERVATION') {
                                  void submitPaperObservation('FORCE');
                                } else if (
                                  pendingPaperConflict.kind === 'EARLY_IGNITION'
                                ) {
                                  void submitEarlyIgnitionPaper('FORCE');
                                } else if (pendingPaperConflict.pullbackParams) {
                                  void submitPullbackLimitPaper(
                                    pendingPaperConflict.pullbackParams,
                                    'FORCE'
                                  );
                                }
                              }}
                              className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
                            >
                              仍要並存加碼開單
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPendingPaperConflict(null);
                                setActiveSection('paper_ledger');
                              }}
                              className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 cursor-pointer"
                            >
                              前往帳本查看
                            </button>
                          </div>
                        </div>
                      )}

                    {!pendingPaperConflict &&
                      activeSymbolOpenOrders.length > 0 && (
                        <div className="rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-1.5 text-[11px] text-amber-300/90 flex flex-wrap items-center justify-between gap-2">
                          <span>
                            目前已有 {activeSymbolOpenOrders.length} 筆{' '}
                            {symbolDetail.symbol} 進行中紙上單（
                            {activeSymbolOpenOrders
                              .map(
                                (o) =>
                                  `#${o.id} ${o.side} ${
                                    o.fillStatus === 'WAITING_LIMIT'
                                      ? '待觸價'
                                      : '已成交'
                                  }`
                              )
                              .join('、')}
                            ）
                          </span>
                          <button
                            type="button"
                            onClick={() => setActiveSection('paper_ledger')}
                            className="text-sky-300 hover:underline cursor-pointer"
                          >
                            查看帳本 →
                          </button>
                        </div>
                      )}

                    {/* Gemini AI Output Banner (shown immediately when triggered) */}
                    {(geminiError || geminiResult) && (
                      <div className="rounded-xl border border-amber-500/35 bg-slate-950 p-3 text-xs space-y-2">
                        {geminiError && (
                          <div className="text-rose-400 font-mono">{geminiError}</div>
                        )}
                        {geminiResult && (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-400">
                              <div className="flex flex-wrap items-center gap-2">
                                <span>
                                  鎖定分類:{' '}
                                  <strong className="text-slate-200">
                                    {geminiResult.lockedCategory}
                                  </strong>
                                </span>
                                <span>·</span>
                                <span>
                                  鎖定 SMC:{' '}
                                  <strong className="text-amber-300">
                                    {geminiResult.lockedActionState}
                                  </strong>
                                </span>
                                <span>·</span>
                                <span>
                                  WAIT 閘門驗證:{' '}
                                  {String(geminiResult.guardrails.waitGateEnforced)}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => setGeminiResult(null)}
                                className="text-slate-400 hover:text-slate-200 cursor-pointer"
                              >
                                收合解釋
                              </button>
                            </div>
                            <p className="text-slate-200 leading-relaxed bg-slate-900/70 p-2.5 rounded-lg border border-slate-800">
                              {geminiResult.explanationZh}
                            </p>
                            <ProvenanceLine
                              provenance={geminiResult.provenance}
                              prefixLabel="解釋層來源"
                            />
                          </>
                        )}
                      </div>
                    )}

                    {/* Collapsible Decision Trace & 6-Gate Inspector Bar */}
                    {(() => {
                      const trace =
                        decisionTraceData ?? symbolDetail.candidate.decisionTrace;
                      if (!trace) return null;
                      const histGate = trace.gates.history;
                      const madRatioPct =
                        histGate.madToMedianRatio !== null &&
                        histGate.madToMedianRatio !== undefined
                          ? `${(histGate.madToMedianRatio * 100).toFixed(2)}%`
                          : 'N/A';
                      return (
                        <details className="group border border-slate-700/80 bg-slate-950 rounded-xl text-xs overflow-hidden">
                          <summary className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 cursor-pointer select-none">
                            <span className="font-semibold text-amber-300 font-mono flex items-center gap-1.5 min-w-0">
                              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180 shrink-0" />
                              <span className="truncate">
                                Decision Trace 降級與安全閘門追蹤 (/api/symbol/
                                {symbolDetail.symbol}/decision-trace)
                              </span>
                            </span>
                            <span className="font-mono text-[10px] text-slate-300 truncate">
                              marketRadar: <strong>{trace.marketRadarCategory}</strong> · SMCEval:{' '}
                              <strong>{trace.smcEvaluationStatus}</strong> · SMC:{' '}
                              <strong>{trace.smcActionState}</strong> → finalTradeSignal:{' '}
                              <strong>{trace.finalTradeSignal}</strong>
                            </span>
                          </summary>

                          <div className="border-t border-slate-800 p-3 space-y-2.5">
                            <div className="grid grid-cols-2 gap-2 @xl:grid-cols-3 font-mono text-[11px]">
                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    1. history gate
                                  </span>
                                  <span
                                    className={
                                      histGate.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-amber-400 font-bold shrink-0'
                                    }
                                  >
                                    {histGate.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  {histGate.sampleCount}/
                                  {histGate.minRequiredSamples} · {histGate.status}
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  TF: {histGate.volumeTimeframe ?? '15m'} · MAD/Med: {madRatioPct}
                                </div>
                              </div>

                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    2. liquidity gate
                                  </span>
                                  <span
                                    className={
                                      trace.gates.liquidity.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-rose-400 font-bold shrink-0'
                                    }
                                  >
                                    {trace.gates.liquidity.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  Vol ${formatUsdCompact(trace.gates.liquidity.quoteVolume24h)}
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  Spread:{' '}
                                  {trace.gates.liquidity.spreadPercent !== null
                                    ? `${trace.gates.liquidity.spreadPercent.toFixed(4)}%`
                                    : 'null'}
                                </div>
                              </div>

                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    3. momentum gate
                                  </span>
                                  <span
                                    className={
                                      trace.gates.momentum.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-amber-400 font-bold shrink-0'
                                    }
                                  >
                                    {trace.gates.momentum.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  24h:{' '}
                                  {trace.gates.momentum.change24h >= 0 ? '+' : ''}
                                  {trace.gates.momentum.change24h.toFixed(2)}%
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  門檻: |change24h| ≥ 3.0%
                                </div>
                              </div>

                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    4. relativeBtc gate
                                  </span>
                                  <span
                                    className={
                                      trace.gates.relativeBtc.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-amber-400 font-bold shrink-0'
                                    }
                                  >
                                    {trace.gates.relativeBtc.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  vs BTC:{' '}
                                  {trace.gates.relativeBtc.value >= 0 ? '+' : ''}
                                  {trace.gates.relativeBtc.value.toFixed(2)}%
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  門檻: 同向 ≥ 1.2%
                                </div>
                              </div>

                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    5. funding gate
                                  </span>
                                  <span
                                    className={
                                      trace.gates.funding.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-rose-400 font-bold shrink-0'
                                    }
                                  >
                                    {trace.gates.funding.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  {trace.gates.funding.value !== null
                                    ? `${(trace.gates.funding.value * 100).toFixed(4)}%`
                                    : 'null'}
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  門檻: |Funding| &lt; 0.05%
                                </div>
                              </div>

                              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-slate-400 truncate">
                                    6. smc gate
                                  </span>
                                  <span
                                    className={
                                      trace.gates.smc.passed
                                        ? 'text-emerald-400 font-bold shrink-0'
                                        : 'text-amber-400 font-bold shrink-0'
                                    }
                                  >
                                    {trace.gates.smc.passed ? 'PASS' : 'FAIL'}
                                  </span>
                                </div>
                                <div className="mt-1 text-slate-200 truncate">
                                  {trace.gates.smc.actionState} ({trace.gates.smc.evaluationStatus})
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">
                                  第二層結構確認
                                </div>
                              </div>
                            </div>

                            {trace.downgradeReasons.length > 0 && (
                              <div className="border-t border-slate-800 pt-2 space-y-1">
                                <div className="font-semibold text-slate-300">
                                  downgradeReasons (降級與分數封頂規則明細):
                                </div>
                                <ul className="list-disc pl-5 space-y-0.5 text-[11px] text-slate-300 font-mono">
                                  {trace.downgradeReasons.map((reason, idx) => (
                                    <li key={idx} className="break-words">{reason}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </details>
                      );
                    })()}

                    {/* WAIT Gate Reasons Alert */}
                    {symbolDetail.smcAnalysis.waitReasons.length > 0 && (
                      <div className="rounded-xl border border-amber-500/40 bg-amber-950/25 px-3.5 py-2.5 text-xs text-amber-200 space-y-1">
                        <div className="font-semibold text-amber-300 flex items-center gap-2">
                          <Clock className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            WAIT 安全閘門觸發原因（條件不足、OI 缺失或結構衝突時強制輸出 WAIT）：
                          </span>
                        </div>
                        <ul className="list-disc pl-5 space-y-0.5 text-[11px] text-amber-100/90">
                          {symbolDetail.smcAnalysis.waitReasons.map((r, idx) => (
                            <li key={idx} className="break-words">{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Workstation 4-Tab Segmented Navigation */}
                  <div className="apple-segmented-track flex flex-wrap items-center gap-1 p-1 text-xs">
                    {(
                      [
                        { key: 'chart_smc', label: '1. 結構看盤 & 關鍵位' },
                        { key: 'micro_deriv', label: '2. 籌碼與微結構' },
                        { key: 'btc_corr', label: '3. BTC 大盤連動' },
                        { key: 'planner_diag', label: '4. 風控試算 & 診斷' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setDetailTab(tab.key)}
                        className={`flex-1 min-w-[120px] px-3 py-1.5 text-center transition-all whitespace-nowrap cursor-pointer ${
                          detailTab === tab.key
                            ? 'apple-segmented-pill-active font-semibold text-amber-200'
                            : 'text-slate-400 hover:text-slate-100'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* TAB 1: Interactive Chart + Multi-Timeframe + Key Levels + SMC Evidences */}
                  {detailTab === 'chart_smc' && (
                    <div className="space-y-4">
                      {/* Early Ignition + Anti-Chase / Pullback Zone Strip */}
                      {(symbolDetail.candidate.earlyIgnition?.status !== 'NONE' ||
                        symbolDetail.entryZoneAnalysis) && (
                        <div className="grid grid-cols-1 gap-2.5 @3xl:grid-cols-2">
                          {symbolDetail.candidate.earlyIgnition &&
                            symbolDetail.candidate.earlyIgnition.status !==
                              'NONE' && (
                              <div className="min-w-0 overflow-hidden rounded-xl border border-cyan-500/40 bg-cyan-950/20 px-3.5 py-2.5 text-xs space-y-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-bold text-cyan-300">
                                    早鳥起漲偵測 (
                                    {symbolDetail.candidate.earlyIgnition
                                      .direction === 'LONG'
                                      ? '多頭點火'
                                      : '空頭點火'}{' '}
                                    ·{' '}
                                    {
                                      symbolDetail.candidate.earlyIgnition
                                        .ignitionScore
                                    }
                                    分)
                                  </span>
                                  <div className="flex flex-wrap items-center gap-2">
                                    {symbolDetail.candidate.earlyIgnition
                                      .invalidationPrice !== null && (
                                      <span className="font-mono text-[10px] text-rose-300">
                                        防守止損{' '}
                                        {
                                          symbolDetail.candidate.earlyIgnition
                                            .invalidationPrice
                                        }
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      onClick={recordEarlyIgnitionPaper}
                                      className="rounded-lg border border-cyan-400/50 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/30 cursor-pointer shrink-0 whitespace-nowrap"
                                    >
                                      登記早鳥紙上單
                                    </button>
                                  </div>
                                </div>
                                <div className="text-[11px] text-slate-200 break-words">
                                  {
                                    symbolDetail.candidate.earlyIgnition
                                      .headlineZh
                                  }
                                </div>
                                <div className="text-[10px] text-cyan-200/80 break-words">
                                  {
                                    symbolDetail.candidate.earlyIgnition
                                      .riskWarningZh
                                  }
                                </div>
                              </div>
                            )}

                          {symbolDetail.entryZoneAnalysis && (() => {
                            const ez = symbolDetail.entryZoneAnalysis;
                            const distPct =
                              ez.distanceToZonePct !== null
                                ? Math.abs(ez.distanceToZonePct)
                                : ez.idealPullbackEntry !== null
                                  ? Math.abs(
                                      ((ez.idealPullbackEntry -
                                        symbolDetail.candidate.lastPrice) /
                                        Math.max(
                                          1e-9,
                                          symbolDetail.candidate.lastPrice
                                        )) *
                                        100
                                    )
                                  : null;
                            const distAtr = ez.distanceToZoneAtr;
                            const isFarPullback =
                              (distPct !== null && distPct > 3.5) ||
                              (distAtr !== null && distAtr > 2.5);
                            return (
                              <div
                                id="entry-pullback-panel"
                                className={`min-w-0 overflow-hidden rounded-xl border px-3.5 py-2.5 text-xs space-y-1.5 ${
                                  symbolDetail.candidate.earlyIgnition?.status ===
                                  'NONE'
                                    ? '@3xl:col-span-2'
                                    : ''
                                } ${
                                  ez.status === 'OVEREXTENDED'
                                    ? 'border-amber-500/45 bg-amber-950/25 text-amber-100'
                                    : ez.status === 'NEAR_POI'
                                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-100'
                                      : ez.status === 'NEAR_PULLBACK_ZONE'
                                        ? 'border-sky-500/35 bg-sky-950/20 text-sky-100'
                                        : 'border-slate-800 bg-slate-950 text-slate-300'
                                }`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                                    <span className="font-bold">
                                      {ez.headlineZh}
                                    </span>
                                    {symbolDetail.smcAnalysis.premiumDiscount?.labels.map(
                                      (label) => (
                                        <span
                                          key={label}
                                          className="rounded border border-violet-400/40 bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200"
                                        >
                                          {label === 'IN_DISCOUNT'
                                            ? '折價 IN_DISCOUNT'
                                            : label === 'IN_PREMIUM'
                                              ? '溢價 IN_PREMIUM'
                                              : label === 'IN_OTE'
                                                ? 'OTE IN_OTE'
                                                : '均衡'}
                                        </span>
                                      )
                                    )}
                                    {symbolDetail.smcAnalysis.eventSequence && (
                                      <span className="rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                                        序列{' '}
                                        {symbolDetail.smcAnalysis.eventSequence.isComplete
                                          ? '完成'
                                          : `${symbolDetail.smcAnalysis.eventSequence.completedStepCount}/4`}
                                        {symbolDetail.smcAnalysis.eventSequence.direction !==
                                        'NONE'
                                          ? ` · ${symbolDetail.smcAnalysis.eventSequence.direction}`
                                          : ''}
                                      </span>
                                    )}
                                    {distPct !== null && (
                                      <span className="rounded bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                                        距現價 {distPct.toFixed(2)}%
                                        {distAtr !== null
                                          ? ` · ${distAtr.toFixed(1)} ATR`
                                          : ''}
                                      </span>
                                    )}
                                    {isFarPullback && (
                                      <span className="rounded border border-rose-500/50 bg-rose-950/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-200">
                                        掛單偏遠・易踏空
                                      </span>
                                    )}
                                  </div>
                                  {ez.idealPullbackEntry !== null &&
                                    (ez.direction === 'LONG' ||
                                      ez.direction === 'SHORT') && (
                                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            createPullbackAlertRule(
                                              ez.idealPullbackEntry!,
                                              ez.direction as 'LONG' | 'SHORT',
                                              `${ez.anchorLabel} 回踩提醒`
                                            )
                                          }
                                          className="rounded-lg border border-amber-400/50 bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/30 cursor-pointer whitespace-nowrap"
                                        >
                                          一鍵設回踩告警 ({ez.idealPullbackEntry})
                                        </button>
                                        {ez.stopLossPrice !== null &&
                                          ez.targetPrice !== null && (
                                            <>
                                              <select
                                                aria-label="回踩限價掛單 TTL"
                                                value={pullbackTtlMinutes}
                                                onChange={(e) =>
                                                  setPullbackTtlMinutes(
                                                    Number(e.target.value)
                                                  )
                                                }
                                                className="rounded-lg border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] text-slate-200 cursor-pointer"
                                              >
                                                <option value={120}>TTL 2h</option>
                                                <option value={240}>TTL 4h</option>
                                                <option value={720}>TTL 12h</option>
                                                <option value={1440}>TTL 24h</option>
                                              </select>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  recordPullbackLimitPaper({
                                                    side: ez.direction as
                                                      | 'LONG'
                                                      | 'SHORT',
                                                    entryPrice:
                                                      ez.idealPullbackEntry!,
                                                    invalidationPrice:
                                                      ez.stopLossPrice!,
                                                    targetPrice: ez.targetPrice!,
                                                    anchorLabel: ez.anchorLabel,
                                                    ttlMinutes: pullbackTtlMinutes,
                                                  })
                                                }
                                                className="rounded-lg border border-emerald-400/50 bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/30 cursor-pointer whitespace-nowrap"
                                              >
                                                掛回踩紙上限價單
                                              </button>
                                            </>
                                          )}
                                      </div>
                                    )}
                                </div>
                                <div className="text-[11px] opacity-90 break-words">
                                  {ez.actionAdviceZh}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Multi-Timeframe Direction Alignment Strip */}
                      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-slate-200">
                            多週期結構方向一致性 (5m / 15m / 1h / 4h)
                          </span>
                          <span className="font-mono text-[11px] text-slate-400">
                            {symbolDetail.smcAnalysis.mtfAlignment.description}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 @md:grid-cols-4 gap-2 font-mono text-xs">
                          {(['5m', '15m', '1h', '4h'] as Timeframe[]).map((tf) => {
                            const bias =
                              symbolDetail.smcAnalysis.mtfAlignment.byTimeframe[tf];
                            const tfMeta = symbolDetail.klinesByTimeframe[tf];
                            return (
                              <button
                                key={tf}
                                type="button"
                                onClick={() => {
                                  setSelectedTimeframe(tf);
                                  loadSymbolDetail(symbolDetail.symbol, tf);
                                }}
                                className={`min-w-0 overflow-hidden rounded-lg border p-2 text-left transition-colors cursor-pointer ${
                                  selectedTimeframe === tf
                                    ? 'border-amber-500/60 bg-slate-900'
                                    : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="font-bold text-slate-200">
                                    {tf}
                                  </span>
                                  <span
                                    className={
                                      bias === 'BULL'
                                        ? 'text-emerald-400 font-semibold'
                                        : bias === 'BEAR'
                                          ? 'text-rose-400 font-semibold'
                                          : 'text-slate-400'
                                    }
                                  >
                                    {bias}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[10px] text-slate-400 truncate">
                                  已收盤: {tfMeta?.confirmedCount ?? 0} 根
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Interactive Candlestick & SMC Structure Chart + Multi-Chart Split Toggle */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-slate-200">
                            互動式 K 線結構圖（支援滾輪縮放 / 拖曳平移 / 測距尺 / 關鍵位疊加）
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setAlertDrawerOpen(true)}
                              className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                            >
                              <Bell className="h-3 w-3" />
                              <span>設為條件告警</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setMultiChartSplit((v) => !v)}
                              className={`rounded-lg border px-3 py-1 text-[11px] font-medium cursor-pointer transition-colors ${
                                multiChartSplit
                                  ? 'border-amber-400/70 bg-amber-500/20 text-amber-200 font-semibold'
                                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-slate-100'
                              }`}
                            >
                              {multiChartSplit
                                ? '切換回單圖模式'
                                : `多圖同框 (BTC + ${symbolDetail.symbol})`}
                            </button>
                          </div>
                        </div>

                        {multiChartSplit ? (
                          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                            <KlineSmcChart
                              symbol={symbolDetail.symbol}
                              timeframe={symbolDetail.primaryTimeframe}
                              klines={
                                symbolDetail.klinesByTimeframe[
                                  symbolDetail.primaryTimeframe
                                ]?.klines || []
                              }
                              smcAnalysis={symbolDetail.smcAnalysis}
                              liquidityPools={
                                symbolDetail.derivativesStructure
                                  ?.liquidityClusters ?? []
                              }
                              keyLevels={symbolDetail.keyLevelsSession}
                              compact
                            />
                            {symbolDetail.symbol !== 'BTCUSDT' &&
                            (symbolDetail.btcKlinesByTimeframe?.[
                              symbolDetail.primaryTimeframe
                            ]?.length ||
                              symbolDetail.btcKlinesByTimeframe?.['15m']?.length) ? (
                              <KlineSmcChart
                                symbol="BTCUSDT"
                                timeframe={
                                  symbolDetail.btcKlinesByTimeframe?.[
                                    symbolDetail.primaryTimeframe
                                  ]?.length
                                    ? symbolDetail.primaryTimeframe
                                    : '15m'
                                }
                                klines={
                                  symbolDetail.btcKlinesByTimeframe?.[
                                    symbolDetail.primaryTimeframe
                                  ]?.length
                                    ? symbolDetail.btcKlinesByTimeframe[
                                        symbolDetail.primaryTimeframe
                                      ]!
                                    : symbolDetail.btcKlinesByTimeframe?.['15m'] ??
                                      []
                                }
                                compact
                                titleOverride={`BTCUSDT 大盤基準 (${
                                  symbolDetail.btcKlinesByTimeframe?.[
                                    symbolDetail.primaryTimeframe
                                  ]?.length
                                    ? symbolDetail.primaryTimeframe
                                    : '15m'
                                })`}
                              />
                            ) : (
                              <KlineSmcChart
                                symbol={symbolDetail.symbol}
                                timeframe={
                                  symbolDetail.primaryTimeframe === '1h'
                                    ? '4h'
                                    : '1h'
                                }
                                klines={
                                  symbolDetail.klinesByTimeframe[
                                    symbolDetail.primaryTimeframe === '1h'
                                      ? '4h'
                                      : '1h'
                                  ]?.klines || []
                                }
                                compact
                                titleOverride={`${symbolDetail.symbol} · ${
                                  symbolDetail.primaryTimeframe === '1h'
                                    ? '4h'
                                    : '1h'
                                } 高週期對照`}
                              />
                            )}
                          </div>
                        ) : (
                          <KlineSmcChart
                            symbol={symbolDetail.symbol}
                            timeframe={symbolDetail.primaryTimeframe}
                            klines={
                              symbolDetail.klinesByTimeframe[
                                symbolDetail.primaryTimeframe
                              ]?.klines || []
                            }
                            smcAnalysis={symbolDetail.smcAnalysis}
                            liquidityPools={
                              symbolDetail.derivativesStructure
                                ?.liquidityClusters ?? []
                            }
                            keyLevels={symbolDetail.keyLevelsSession}
                          />
                        )}
                      </div>

                      {/* Key Session Killzones, Funding Settlement Clock & PDH/PDL/DO/WO/VWAP Anchors */}
                      <KeyLevelsSessionStrip data={symbolDetail.keyLevelsSession} />

                      {/* SMC/ICT Evidences Table (computed strictly on closed K-lines) */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-xs font-semibold text-slate-200">
                            SMC / ICT 已確認 K 線結構證據 ({symbolDetail.primaryTimeframe} · 基於已收盤 K 線 isClosed=true)
                          </h4>
                          <span className="text-[11px] font-mono text-slate-400">
                            已收盤: {symbolDetail.smcAnalysis.confirmedKlineCount} 根 · 狀態:{' '}
                            <strong
                              className={getSmcStateColor(
                                symbolDetail.smcAnalysis.actionState
                              )}
                            >
                              {symbolDetail.smcAnalysis.actionState}
                            </strong>
                          </span>
                        </div>
                        <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950 text-xs overflow-hidden">
                          {symbolDetail.smcAnalysis.evidences.map((ev) => (
                            <div
                              key={ev.code}
                              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span
                                    className={`font-mono font-semibold shrink-0 ${
                                      ev.passed
                                        ? 'text-emerald-400'
                                        : 'text-slate-500'
                                    }`}
                                  >
                                    {ev.passed ? '[PASS]' : '[----]'}
                                  </span>
                                  <span className="font-medium text-slate-200">
                                    {ev.label}
                                  </span>
                                  <span className="text-slate-500">·</span>
                                  <span className="font-mono text-slate-300 break-words">
                                    {ev.value}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-400 break-words">
                                  {ev.detail}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: Spot-Perp Basis, Orderbook Depth OBI/Walls & Derivatives Structure */}
                  {detailTab === 'micro_deriv' && (
                    <div className="space-y-4">
                      <MicrostructureCard data={symbolDetail.microstructure} />
                      <DerivativesStructureCard
                        symbol={symbolDetail.symbol}
                        analysis={symbolDetail.derivativesStructure}
                      />
                    </div>
                  )}

                  {/* TAB 3: BTCUSDT K-line Overlap & Coupling Risk Analysis */}
                  {detailTab === 'btc_corr' && (
                    <div className="space-y-4">
                      <BtcCorrelationCard
                        symbol={symbolDetail.symbol}
                        primaryTimeframe={symbolDetail.primaryTimeframe}
                        analysis={symbolDetail.btcCorrelation}
                      />
                    </div>
                  )}

                  {/* TAB 4: Position Risk Planner, 5-Step Details & Market Score Breakdown */}
                  {detailTab === 'planner_diag' && (
                    <div className="space-y-4">
                      <PositionRiskPlannerCard
                        symbol={symbolDetail.symbol}
                        candidate={symbolDetail.candidate}
                        smcAnalysis={symbolDetail.smcAnalysis}
                        entryZoneAnalysis={symbolDetail.entryZoneAnalysis}
                        btcCorrelation={symbolDetail.btcCorrelation}
                        microstructure={symbolDetail.microstructure}
                        existingOpenOrders={activeSymbolOpenOrders}
                        highBtcLongCount={portfolioHighBtcStats.longCount}
                        highBtcShortCount={portfolioHighBtcStats.shortCount}
                        onCreatePullbackAlert={createPullbackAlertRule}
                        onRecordPullbackPaper={recordPullbackLimitPaper}
                      />

                      {/* Full 5-Step Plain-Language Guide */}
                      {(() => {
                        const plainGuide = buildPlainLanguageSmcSteps(
                          symbolDetail,
                          decisionTraceData ?? symbolDetail.candidate.decisionTrace
                        );
                        return (
                          <div className="rounded-xl border border-slate-800/80 bg-slate-950/90 p-4 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 pb-2.5">
                              <div className="flex items-center gap-2.5">
                                <span className="text-xs font-bold tracking-tight text-amber-300">
                                  白話文 5 步闖關進度明細
                                </span>
                                <span className="text-slate-600">·</span>
                                <span className="text-xs font-semibold text-slate-100">
                                  已通過 {plainGuide.passedCount} / 5 關
                                </span>
                              </div>
                            </div>

                            <div
                              className={`rounded-xl border p-3 text-xs space-y-1 ${
                                plainGuide.recommendationTone === 'emerald'
                                  ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200'
                                  : plainGuide.recommendationTone === 'rose'
                                    ? 'border-rose-500/40 bg-rose-950/20 text-rose-200'
                                    : plainGuide.recommendationTone === 'sky'
                                      ? 'border-sky-500/40 bg-sky-950/20 text-sky-200'
                                      : 'border-amber-500/35 bg-amber-950/15 text-amber-200'
                              }`}
                            >
                              <div className="font-bold text-sm tracking-tight">
                                {plainGuide.recommendationTitle}
                              </div>
                              <p className="text-xs text-slate-300 leading-relaxed">
                                {plainGuide.recommendationBody}
                              </p>
                            </div>

                            <div className="grid grid-cols-1 gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3 text-xs">
                              {plainGuide.steps.map((st, idx) => (
                                <div
                                  key={idx}
                                  className={`min-w-0 overflow-hidden rounded-xl border p-3 space-y-1.5 ${
                                    st.passed
                                      ? 'border-emerald-500/35 bg-emerald-950/15'
                                      : 'border-slate-800/80 bg-slate-900/50'
                                  }`}
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[10px]">
                                    <span className="shrink-0 text-slate-400">
                                      第 {st.stepNumber} 關
                                    </span>
                                    <span
                                      className={`max-w-full break-words rounded-md font-bold px-1.5 py-0.5 leading-tight ${
                                        st.passed
                                          ? 'bg-emerald-500/20 text-emerald-300'
                                          : 'bg-slate-800 text-slate-400'
                                      }`}
                                    >
                                      {st.statusLabel}
                                    </span>
                                  </div>
                                  <div className="font-semibold text-slate-100">
                                    {st.title}
                                  </div>
                                  <div className="text-[11px] text-slate-300 leading-snug break-words">
                                    {st.plainDesc}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Score Breakdown & Market Scan Evidences (Collapsible) */}
                      <details className="group rounded-xl border border-slate-800 bg-slate-950/90 text-xs overflow-hidden">
                        <summary className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 cursor-pointer select-none">
                          <h4 className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                            <span>
                              全市場評分拆解與證據 (總分: {symbolDetail.candidate.score}/96)
                            </span>
                          </h4>
                          <span className="text-[11px] font-mono text-slate-400 truncate">
                            histVol:{symbolDetail.candidate.scoreBreakdown.volumeAnomaly} ·
                            auxPR:{symbolDetail.candidate.scoreBreakdown.auxiliaryVolumeRank} ·
                            mom:{symbolDetail.candidate.scoreBreakdown.momentum} ·
                            rs:{symbolDetail.candidate.scoreBreakdown.relativeBtcStrength}
                          </span>
                        </summary>
                        <div className="divide-y divide-slate-800 border-t border-slate-800 bg-slate-950 text-xs">
                          {symbolDetail.candidate.evidences.map((ev) => (
                            <div
                              key={ev.code}
                              className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2"
                            >
                              <div className="min-w-0">
                                <span
                                  className={`font-mono font-semibold mr-2 ${
                                    ev.passed
                                      ? 'text-emerald-400'
                                      : 'text-amber-400'
                                  }`}
                                >
                                  {ev.passed ? '[PASS]' : '[WARN]'}
                                </span>
                                <span className="text-slate-200 font-medium">
                                  {ev.label}
                                </span>
                                <span className="mx-1.5 text-slate-500">·</span>
                                <span className="text-slate-400 break-words">{ev.detail}</span>
                              </div>
                              <span className="font-mono text-slate-200 whitespace-nowrap shrink-0">
                                {ev.value} ({ev.weight >= 0 ? `+${ev.weight}` : ev.weight})
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          </div>
        )}

        {/* SECTION 2: Cross-Exchange Price, Funding, OI & Spread Divergence */}
        {activeSection === 'divergence' && (
          <section className="order-3 border border-slate-800 bg-slate-900/30 p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <GitCompare className="h-4 w-4 text-amber-400" />
                  <span>
                    跨交易所價格、資金費率、OI 與盤口價差背離監控 (Binance · Bybit · BingX)
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  同步比對三家公開永續合約數據，每家交易所獨立保留完整 source / fetchedAt / stale / fallback / missingData / isDemo
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetchDivergence()}
                disabled={divergenceLoading}
                className="rounded bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
              >
                {divergenceLoading ? '正在同步三所行情...' : '重新同步跨所背離'}
              </button>
            </div>

            {divergenceError && (
              <div className="border border-rose-500/40 bg-rose-950/30 p-4 text-xs text-rose-200 font-mono">
                {divergenceError}
              </div>
            )}

            {divergenceData && (
              <div className="space-y-4">
                {/* Per-Exchange Provenance Strip */}
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  {(
                    [
                      'binance_usdm',
                      'bybit_linear',
                      'bingx_swap',
                    ] as const
                  ).map((exId) => {
                    const st = divergenceData.venueStatuses[exId];
                    return (
                      <div
                        key={exId}
                        className="border border-slate-800 bg-slate-950 p-3 space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between font-mono">
                          <span className="font-bold text-slate-200">
                            {exId}
                          </span>
                          <span
                            className={
                              st.available
                                ? 'text-emerald-400 font-semibold'
                                : 'text-rose-400 font-semibold'
                            }
                          >
                            {st.available ? 'AVAILABLE' : 'UNAVAILABLE'}
                          </span>
                        </div>
                        <ProvenanceLine provenance={st.provenance} />
                      </div>
                    );
                  })}
                </div>

                <div className="border border-slate-800 bg-slate-950 overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono tabular-nums">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-2.5 px-3">合約標的</th>
                        <th className="py-2.5 px-3 text-right">
                          Binance 價格 / Funding / Spread
                        </th>
                        <th className="py-2.5 px-3 text-right">
                          Bybit 價格 / Funding / Spread
                        </th>
                        <th className="py-2.5 px-3 text-right">
                          BingX 價格 / Funding / Spread
                        </th>
                        <th className="py-2.5 px-3 text-right">跨所最大價差</th>
                        <th className="py-2.5 px-3 text-right">
                          Funding 背離 (bps)
                        </th>
                        <th className="py-2.5 px-3 text-right">
                          Spread 差異
                        </th>
                        <th className="py-2.5 px-3">跨所 OI 聚合與背離警示</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {divergenceData.items.map((item) => {
                        const b = item.legs.binance_usdm;
                        const y = item.legs.bybit_linear;
                        const x = item.legs.bingx_swap;
                        return (
                          <tr key={item.symbol} className="hover:bg-slate-900/50">
                            <td className="py-2.5 px-3 font-bold text-slate-100">
                              {item.symbol}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              {b.available && b.lastPrice !== null ? (
                                <>
                                  <div>${formatPriceDynamic(b.lastPrice)}</div>
                                  <div className="text-[10px] text-slate-400">
                                    F:{' '}
                                    {b.fundingRate !== null
                                      ? `${(b.fundingRate * 100).toFixed(4)}%`
                                      : 'N/A'}{' '}
                                    · S:{' '}
                                    {b.spreadPercent !== null
                                      ? `${b.spreadPercent.toFixed(3)}%`
                                      : 'N/A'}
                                  </div>
                                </>
                              ) : (
                                <span className="text-slate-600">未上架/不可用</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              {y.available && y.lastPrice !== null ? (
                                <>
                                  <div>${formatPriceDynamic(y.lastPrice)}</div>
                                  <div className="text-[10px] text-slate-400">
                                    F:{' '}
                                    {y.fundingRate !== null
                                      ? `${(y.fundingRate * 100).toFixed(4)}%`
                                      : 'N/A'}{' '}
                                    · S:{' '}
                                    {y.spreadPercent !== null
                                      ? `${y.spreadPercent.toFixed(3)}%`
                                      : 'N/A'}
                                  </div>
                                </>
                              ) : (
                                <span className="text-slate-600">未上架/不可用</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              {x.available && x.lastPrice !== null ? (
                                <>
                                  <div>${formatPriceDynamic(x.lastPrice)}</div>
                                  <div className="text-[10px] text-slate-400">
                                    F:{' '}
                                    {x.fundingRate !== null
                                      ? `${(x.fundingRate * 100).toFixed(4)}%`
                                      : 'N/A'}{' '}
                                    · S:{' '}
                                    {x.spreadPercent !== null
                                      ? `${x.spreadPercent.toFixed(3)}%`
                                      : 'N/A'}
                                  </div>
                                </>
                              ) : (
                                <span className="text-slate-600">未上架/不可用</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right text-amber-300 font-semibold">
                              {item.priceDivergencePercent !== null
                                ? `${item.priceDivergencePercent.toFixed(4)}%`
                                : 'N/A'}
                            </td>
                            <td className="py-2.5 px-3 text-right text-sky-300">
                              {item.fundingDivergenceBps !== null
                                ? `${item.fundingDivergenceBps.toFixed(2)} bps`
                                : 'N/A'}
                            </td>
                            <td className="py-2.5 px-3 text-right text-slate-300">
                              {item.spreadDivergencePercent !== null
                                ? `${item.spreadDivergencePercent.toFixed(4)}%`
                                : 'N/A'}
                            </td>
                            <td className="py-2.5 px-3 font-sans text-[11px] text-slate-300">
                              <div>
                                總 OI:{' '}
                                {item.totalOpenInterestUsd !== null
                                  ? `$${formatUsdCompact(
                                      item.totalOpenInterestUsd
                                    )}`
                                  : '按需載入'}
                              </div>
                              {item.divergenceFlags.length > 0 && (
                                <div className="text-amber-300">
                                  {item.divergenceFlags.join(' · ')}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {/* SECTION 3: Phase 4 Lookahead-Free Deterministic & Walk-Forward Backtest + SQLite Reports */}
        {activeSection === 'backtest' && (
          <section className="order-3 border border-slate-800 bg-slate-900/30 p-6 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-100">
                  Phase 4：SMC/ICT 訊號品質回測、Walk-Forward 三階段時間序列驗證與紙上帳本整合
                </h2>
                <p className="text-xs text-slate-400">
                  嚴格禁止前視偏差 (Lookahead-Free: baseline = klines.slice(i - 30, i))，僅計入 EVALUATED + LONG/SHORT CANDIDATE + 最終多空交易候選訊號；維持 PAPER ONLY / LIVE ORDERS DISABLED / NEVER AUTO-PLACE ORDERS。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-slate-300">
                  標的: <strong>{selectedSymbol}</strong> · 交易所:{' '}
                  <strong>{selectedExchange}</strong> · 週期:
                </span>
                {(['15m', '1h', '4h', '5m'] as Timeframe[]).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setSelectedTimeframe(tf)}
                    className={`px-2.5 py-1 text-xs font-mono border cursor-pointer ${
                      selectedTimeframe === tf
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200 font-bold'
                        : 'border-slate-700 bg-slate-950 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    executeBacktest(selectedSymbol, selectedTimeframe, false)
                  }
                  disabled={backtestLoading}
                  className="rounded bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                >
                  {backtestLoading
                    ? '回測計算中...'
                    : '執行無前視 + Walk-Forward 回測'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    executeBacktest(selectedSymbol, selectedTimeframe, true)
                  }
                  disabled={backtestLoading}
                  className="rounded border border-emerald-500/50 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 cursor-pointer"
                >
                  執行回測並寫入紙上帳本
                </button>
              </div>
            </div>

            {/* Net Cost Config, Extended Bar Limit & Portfolio Benchmark Bar */}
            <div className="border border-slate-800 bg-slate-950/90 p-3.5 text-xs font-mono space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-400 font-sans font-semibold">
                    歷史回測 K 線數 (Bar Limit):
                  </span>
                  {([120, 240, 500, 1000, 2000, 5000] as const).map((bl) => (
                    <button
                      key={bl}
                      type="button"
                      onClick={() => setBacktestBarLimit(bl)}
                      className={`px-2 py-1 border cursor-pointer ${
                        backtestBarLimit === bl
                          ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 font-bold'
                          : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {bl} 根
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-slate-400 font-sans font-semibold">
                    淨損益交易成本模型:
                  </span>
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>Maker(bps)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={costConfigState.makerFeeBps}
                      onChange={(e) =>
                        setCostConfigState((prev) => ({
                          ...prev,
                          makerFeeBps: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="w-14 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right text-slate-100"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>Taker(bps)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={costConfigState.takerFeeBps}
                      onChange={(e) =>
                        setCostConfigState((prev) => ({
                          ...prev,
                          takerFeeBps: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="w-14 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right text-slate-100"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>滑價(bps)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={costConfigState.slippageBps}
                      onChange={(e) =>
                        setCostConfigState((prev) => ({
                          ...prev,
                          slippageBps: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="w-14 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right text-slate-100"
                    />
                  </label>
                  <select
                    value={costConfigState.entryOrderType ?? 'MARKET'}
                    onChange={(e) =>
                      setCostConfigState((prev) => ({
                        ...prev,
                        entryOrderType:
                          e.target.value === 'LIMIT' ? 'LIMIT' : 'MARKET',
                      }))
                    }
                    className="border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-100"
                  >
                    <option value="MARKET">市價進場 (Taker + 滑價)</option>
                    <option value="LIMIT">限價回踩進場 (Maker / 0滑價)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-400 font-sans font-semibold">
                    多幣種組合標的:
                  </span>
                  <input
                    type="text"
                    value={portfolioSymbolsInput}
                    onChange={(e) => setPortfolioSymbolsInput(e.target.value)}
                    className="w-64 border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100"
                    placeholder="BTCUSDT,ETHUSDT,SOLUSDT"
                  />
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>總倉上限</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={portfolioRiskConfig.maxOpenPositions}
                      onChange={(e) =>
                        setPortfolioRiskConfig((prev) => ({
                          ...prev,
                          maxOpenPositions: Math.max(
                            1,
                            Number(e.target.value) || 3
                          ),
                        }))
                      }
                      className="w-12 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>同向上限</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={portfolioRiskConfig.maxSameDirectionPositions}
                      onChange={(e) =>
                        setPortfolioRiskConfig((prev) => ({
                          ...prev,
                          maxSameDirectionPositions: Math.max(
                            1,
                            Number(e.target.value) || 2
                          ),
                        }))
                      }
                      className="w-12 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1 text-slate-300">
                    <span>單日熔斷(R)</span>
                    <input
                      type="number"
                      min={0.5}
                      max={20}
                      step={0.5}
                      value={portfolioRiskConfig.dailyMaxDrawdownR}
                      onChange={(e) =>
                        setPortfolioRiskConfig((prev) => ({
                          ...prev,
                          dailyMaxDrawdownR: Math.max(
                            0.5,
                            Number(e.target.value) || 3
                          ),
                        }))
                      }
                      className="w-14 border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
                    <span className="text-slate-400 font-sans font-semibold">
                      SMC 規則配置:
                    </span>
                    <select
                      value={smcRuleProfile}
                      onChange={(e) =>
                        setSmcRuleProfile(e.target.value as SmcRuleProfile)
                      }
                      className="border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100"
                    >
                      <option value="STRICT_PRODUCTION">
                        STRICT_PRODUCTION (原版嚴格正式規則)
                      </option>
                      <option value="RELAXED_MTF_DISP">
                        RELAXED_MTF_DISP (放寬MTF/雙K位移 · 保留Sweep)
                      </option>
                      <option value="TREND_NO_SWEEP">
                        TREND_NO_SWEEP (放寬MTF/位移 · 免除Sweep)
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void executePortfolioBacktest()}
                    disabled={portfolioLoading}
                    className="rounded border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50 cursor-pointer"
                  >
                    {portfolioLoading
                      ? '組合回測中...'
                      : '執行多幣種組合回測 (Portfolio Benchmark)'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void executeSmcAbComparison()}
                    disabled={abCompareLoading}
                    className="rounded border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 cursor-pointer"
                  >
                    {abCompareLoading
                      ? '3 規則 A/B 對比計算中...'
                      : '執行 3 規則 A/B 扣成本對比'}
                  </button>
                </div>
              </div>
            </div>

            {abCompareError && (
              <div className="border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200 font-mono">
                {abCompareError}
              </div>
            )}

            {abCompareResult && (
              <div
                id="smc-ab-comparison-panel"
                className="border border-emerald-500/40 bg-slate-950 p-4 space-y-3 text-xs font-mono"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-sans text-xs font-bold text-emerald-300">
                      SMC 規則 A/B 扣成本對比回測 ({abCompareResult.comparisonId})
                    </span>
                    <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/30 text-emerald-200 text-[10px]">
                      {abCompareResult.dataClassification} · Lookahead-Free=
                      {String(abCompareResult.lookaheadFree)} ·{' '}
                      {abCompareResult.barLimit} 根 {abCompareResult.timeframe}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    標的: {abCompareResult.symbolsRequested.join(', ')} (成功{' '}
                    {abCompareResult.symbolsSucceeded}/
                    {abCompareResult.symbolsRequested.length})
                  </div>
                </div>

                <div className="border border-slate-800 bg-slate-900/60 p-2.5 text-[11px] font-sans text-slate-200">
                  <strong className="text-emerald-300">對比結論：</strong>
                  {abCompareResult.recommendationReasonZh}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px] tabular-nums">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-1.5 px-2">規則版本</th>
                        <th className="py-1.5 px-2 text-right">接受 / 原始筆數</th>
                        <th className="py-1.5 px-2 text-right">多 / 空</th>
                        <th className="py-1.5 px-2 text-right">淨勝率 (毛勝率)</th>
                        <th className="py-1.5 px-2 text-right">淨 Expectancy</th>
                        <th className="py-1.5 px-2 text-right">淨 PF (毛 PF)</th>
                        <th className="py-1.5 px-2 text-right">淨 MDD</th>
                        <th className="py-1.5 px-2 text-right">累計淨 R (成本拖累)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {abCompareResult.profiles.map((row) => {
                        const isWinner =
                          abCompareResult.recommendedProfile === row.profile;
                        return (
                          <tr
                            key={row.profile}
                            className={
                              isWinner ? 'bg-emerald-950/20' : undefined
                            }
                          >
                            <td className="py-2 px-2">
                              <div className="font-bold text-slate-100">
                                {row.profile}{' '}
                                {isWinner && (
                                  <span className="ml-1 px-1.5 py-0.5 text-[10px] border border-emerald-500/50 text-emerald-300">
                                    較優
                                  </span>
                                )}
                              </div>
                              <div className="font-sans text-[10px] text-slate-400">
                                {row.profileLabelZh}
                              </div>
                            </td>
                            <td className="py-2 px-2 text-right text-slate-200">
                              {row.acceptedTradesCount} / {row.rawTotalTrades}
                            </td>
                            <td className="py-2 px-2 text-right text-slate-300">
                              {row.longCount} / {row.shortCount}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {row.netWinRate !== null
                                ? `${row.netWinRate}%`
                                : '--'}{' '}
                              <span className="text-slate-400">
                                ({row.winRate !== null ? `${row.winRate}%` : '--'})
                              </span>
                            </td>
                            <td
                              className={`py-2 px-2 text-right font-bold ${
                                (row.netExpectancyR ?? 0) > 0
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              {row.netExpectancyR !== null
                                ? `${row.netExpectancyR}R`
                                : '--'}
                            </td>
                            <td className="py-2 px-2 text-right text-amber-300">
                              {row.netProfitFactor ?? '--'}{' '}
                              <span className="text-slate-400">
                                ({row.profitFactor ?? '--'})
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right text-rose-400">
                              {row.netMaxDrawdownR !== null
                                ? `${row.netMaxDrawdownR}R`
                                : '--'}
                            </td>
                            <td className="py-2 px-2 text-right text-sky-300">
                              {row.totalNetR !== null ? `${row.totalNetR}R` : '--'}{' '}
                              <span className="text-slate-400">
                                (成本 -{row.totalCostDragR ?? 0}R)
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 5-Point Validation Readiness Scorecard */}
            {validationReadiness && (
              <div
                id="validation-readiness-scorecard"
                className="border border-slate-800 bg-slate-950 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xs font-bold text-emerald-300">
                      5 項實戰驗證就緒計分卡 (Validation Readiness Scorecard)
                    </h3>
                    <span
                      className={`px-2 py-0.5 border text-[10px] font-mono font-bold ${
                        validationReadiness.overallStatus === 'VALIDATED'
                          ? 'border-emerald-500/50 bg-emerald-950/30 text-emerald-300'
                          : validationReadiness.overallStatus === 'IN_PROGRESS'
                            ? 'border-amber-500/50 bg-amber-950/30 text-amber-300'
                            : 'border-slate-700 bg-slate-900 text-slate-300'
                      }`}
                    >
                      {validationReadiness.overallStatus} (
                      {validationReadiness.passedCount}/
                      {validationReadiness.totalCount} ·{' '}
                      {validationReadiness.readinessScorePercent}%)
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">
                    Live Capture:{' '}
                    <strong className="text-cyan-300">
                      {validationReadiness.livePaperStats.captureRatePercent !==
                      null
                        ? `${validationReadiness.livePaperStats.captureRatePercent}%`
                        : 'N/A'}
                    </strong>{' '}
                    · Live 已結算:{' '}
                    <strong className="text-slate-200">
                      {validationReadiness.livePaperStats.settledPaperTradesCount}{' '}
                      筆
                    </strong>{' '}
                    · 歷史回測樣本:{' '}
                    <strong className="text-slate-200">
                      {validationReadiness.backtestStats.latestRealTradeCount}{' '}
                      筆
                    </strong>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5 text-[11px]">
                  {validationReadiness.criteria.map((c) => (
                    <div
                      key={c.id}
                      className={`border p-2.5 space-y-1 ${
                        c.status === 'PASSED'
                          ? 'border-emerald-500/40 bg-emerald-950/15'
                          : c.status === 'PARTIAL'
                            ? 'border-amber-500/40 bg-amber-950/15'
                            : c.status === 'FAILED'
                              ? 'border-rose-500/40 bg-rose-950/15'
                              : 'border-slate-800 bg-slate-900/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-slate-200">
                          {c.titleZh}
                        </span>
                        <span
                          className={`font-mono text-[10px] font-bold ${
                            c.status === 'PASSED'
                              ? 'text-emerald-300'
                              : c.status === 'PARTIAL'
                                ? 'text-amber-300'
                                : c.status === 'FAILED'
                                  ? 'text-rose-300'
                                  : 'text-slate-400'
                          }`}
                        >
                          {c.status}
                        </span>
                      </div>
                      <div className="font-mono text-xs font-bold text-slate-100">
                        {c.currentValueLabel}
                      </div>
                      <div className="font-mono text-[10px] text-slate-400">
                        目標: {c.targetThresholdLabel}
                      </div>
                      <div className="text-[10px] text-slate-400 leading-snug">
                        {c.detailZh}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {portfolioError && (
              <div className="border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200 font-mono">
                {portfolioError}
              </div>
            )}

            {portfolioBacktestResult && (
              <div
                id="portfolio-benchmark-panel"
                className="border border-cyan-500/35 bg-slate-950 p-4 space-y-3 text-xs font-mono"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-sans text-xs font-bold text-cyan-300">
                      多幣種組合風控回測報告 ({portfolioBacktestResult.portfolioRunId})
                    </span>
                    <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/30 text-emerald-300 text-[10px]">
                      {portfolioBacktestResult.dataClassification} ·{' '}
                      {portfolioBacktestResult.sampleSufficiency}
                    </span>
                    <span className="text-slate-400 text-[11px]">
                      MTF 歷史共振標的使用:{' '}
                      {portfolioBacktestResult.mtfHistoricalAlignedCount}/
                      {portfolioBacktestResult.symbolsSucceeded}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300">
                    接受 {portfolioBacktestResult.acceptedTradesCount} / 原始{' '}
                    {portfolioBacktestResult.rawTotalTrades} 筆 · 風控攔截{' '}
                    <strong className="text-amber-300">
                      {portfolioBacktestResult.blockedByRiskCapCount} 筆
                    </strong>{' '}
                    (總倉 {portfolioBacktestResult.blockedBreakdown.maxOpenPositions} · 同向{' '}
                    {portfolioBacktestResult.blockedBreakdown.sameDirectionCap} · 熔斷{' '}
                    {portfolioBacktestResult.blockedBreakdown.dailyDrawdownCircuitBreaker} · 冷卻{' '}
                    {portfolioBacktestResult.blockedBreakdown.consecutiveLossCooldown})
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5 tabular-nums">
                  <div className="border border-slate-800 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] font-sans text-slate-400">
                      組合淨勝率 / 毛勝率
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-slate-100">
                      {portfolioBacktestResult.netWinRate ?? '--'}% /{' '}
                      <span className="text-slate-400">
                        {portfolioBacktestResult.winRate ?? '--'}%
                      </span>
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] font-sans text-slate-400">
                      組合淨 Expectancy R
                    </div>
                    <div
                      className={`mt-0.5 text-sm font-bold ${
                        (portfolioBacktestResult.netExpectancyR ?? 0) > 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {portfolioBacktestResult.netExpectancyR ?? '--'}R (毛{' '}
                      {portfolioBacktestResult.expectancyR ?? '--'}R)
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] font-sans text-slate-400">
                      組合淨 Profit Factor
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-amber-300">
                      {portfolioBacktestResult.netProfitFactor ?? '--'} (毛{' '}
                      {portfolioBacktestResult.profitFactor ?? '--'})
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] font-sans text-slate-400">
                      組合淨最大回撤 (Net MDD)
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-rose-400">
                      {portfolioBacktestResult.netMaxDrawdownR ?? '--'}R (毛{' '}
                      {portfolioBacktestResult.maxDrawdownR ?? '--'}R)
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] font-sans text-slate-400">
                      組合累計淨 R / 總成本拖累
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-sky-300">
                      {portfolioBacktestResult.totalNetR ?? '--'}R (成本 -
                      {portfolioBacktestResult.totalCostDragR ?? 0}R)
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px] tabular-nums">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="py-1.5 px-2">標的</th>
                        <th className="py-1.5 px-2">狀態</th>
                        <th className="py-1.5 px-2 text-right">接受 / 攔截</th>
                        <th className="py-1.5 px-2 text-right">淨勝率</th>
                        <th className="py-1.5 px-2 text-right">淨均 R (毛均 R)</th>
                        <th className="py-1.5 px-2 text-right">淨 PF</th>
                        <th className="py-1.5 px-2 text-right">淨 MDD</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {portfolioBacktestResult.symbolSummaries.map((sym) => (
                        <tr key={sym.symbol}>
                          <td className="py-1.5 px-2 font-semibold text-slate-100">
                            {sym.symbol}
                          </td>
                          <td className="py-1.5 px-2 text-slate-300">
                            {sym.status} · MTF=
                            {sym.mtfHistoricalAligned ? 'ON' : 'OFF'}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            {sym.acceptedTradesCount} / {sym.blockedTradesCount}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            {sym.netWinRate !== null ? `${sym.netWinRate}%` : '--'}
                          </td>
                          <td className="py-1.5 px-2 text-right text-sky-300">
                            {sym.netAverageR !== null
                              ? `${sym.netAverageR}R`
                              : '--'}{' '}
                            (
                            {sym.averageR !== null ? `${sym.averageR}R` : '--'})
                          </td>
                          <td className="py-1.5 px-2 text-right text-amber-300">
                            {sym.netProfitFactor ?? '--'}
                          </td>
                          <td className="py-1.5 px-2 text-right text-rose-400">
                            {sym.netMaxDrawdownR !== null
                              ? `${sym.netMaxDrawdownR}R`
                              : '--'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {backtestError && (
              <div className="border border-rose-500/40 bg-rose-950/30 p-4 text-xs text-rose-200 font-mono">
                {backtestError}
              </div>
            )}

            {backtestResult && (
              <div className="space-y-5">
                {/* Metadata & Data Classification Strip */}
                <div className="border border-slate-800 bg-slate-950 p-3.5 text-xs font-mono space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-amber-300">
                        [{backtestResult.dataClassification ?? (backtestResult.isDemo ? 'DEMO' : 'REAL')} ·{' '}
                        {backtestResult.dataClassificationLabel ??
                          (backtestResult.status === 'INSUFFICIENT_DATA'
                            ? '資料不足'
                            : backtestResult.isDemo
                              ? 'Demo 資料'
                              : '實際資料')}
                        ]
                      </span>
                      <span className="text-slate-300">
                        RunID: {backtestResult.backtestRunId ?? 'N/A'}
                      </span>
                      <span>·</span>
                      <span className="text-slate-300">
                        規則版本: {backtestResult.ruleVersion}
                      </span>
                      <span>·</span>
                      <span
                        className={
                          backtestResult.lookaheadFree
                            ? 'text-emerald-400 font-semibold'
                            : 'text-amber-400 font-semibold'
                        }
                      >
                        Lookahead-Free:{' '}
                        {backtestResult.lookaheadFree ? 'VERIFIED (TRUE)' : 'FALSE'}
                      </span>
                      <span>·</span>
                      <span
                        className={
                          backtestResult.mtfHistoricalAligned
                            ? 'text-cyan-300 font-semibold'
                            : 'text-slate-400'
                        }
                      >
                        1h/4h 歷史共振:{' '}
                        {backtestResult.mtfHistoricalAligned ? 'ON (無未來洩漏)' : 'OFF'}
                      </span>
                      <span>·</span>
                      <span className="text-sky-300">
                        metricStatus: {backtestResult.metricStatus ?? 'READY'}
                      </span>
                    </div>
                    <div className="text-slate-400">
                      時間範圍: {backtestResult.startTime ?? 'N/A'} ~{' '}
                      {backtestResult.endTime ?? 'N/A'}
                    </div>
                  </div>
                  <ProvenanceLine
                    provenance={backtestResult.provenance}
                    prefixLabel="本次回測資料來源"
                  />
                </div>

                {/* Signal & State Counters Strip */}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5 lg:grid-cols-9 font-mono tabular-nums text-xs">
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      合格交易訊號 (signalCount)
                    </div>
                    <div className="mt-1 text-base font-bold text-emerald-400">
                      {backtestResult.signalCount ?? backtestResult.totalTrades ?? 0}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      LONG {backtestResult.longCount ?? 0} / SHORT{' '}
                      {backtestResult.shortCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      已執行紙上交易 (executedPaper)
                    </div>
                    <div className="mt-1 text-base font-bold text-slate-100">
                      {backtestResult.executedPaperCount ??
                        backtestResult.totalTrades ??
                        0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      閘門攔截數 (blockedCount)
                    </div>
                    <div className="mt-1 text-base font-bold text-amber-300">
                      {backtestResult.blockedCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      持倉屆滿平倉 (expiredCount)
                    </div>
                    <div className="mt-1 text-base font-bold text-sky-300">
                      {backtestResult.expiredCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      資料不足根數 (insufficient)
                    </div>
                    <div className="mt-1 text-base font-bold text-slate-300">
                      {backtestResult.insufficientDataCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      WAIT 數量
                    </div>
                    <div className="mt-1 text-base font-bold text-amber-300">
                      {backtestResult.waitCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      WATCH 數量
                    </div>
                    <div className="mt-1 text-base font-bold text-sky-300">
                      {backtestResult.watchCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      PENDING 數量
                    </div>
                    <div className="mt-1 text-base font-bold text-slate-400">
                      {backtestResult.pendingCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800 bg-slate-950 p-3">
                    <div className="text-[11px] font-sans text-slate-400">
                      HIGH RISK 數量
                    </div>
                    <div className="mt-1 text-base font-bold text-rose-400">
                      {backtestResult.highRiskCount ?? 0}
                    </div>
                  </div>
                </div>

                {backtestResult.status === 'INSUFFICIENT_DATA' ? (
                  <div className="border border-amber-500/40 bg-amber-950/30 p-6 text-sm text-amber-200 space-y-2">
                    <div className="font-bold text-amber-300">
                      回測狀態：資料不足 (status = INSUFFICIENT_DATA · metricStatus = {backtestResult.metricStatus ?? 'INSUFFICIENT_DATA'} · lookaheadFree = {String(backtestResult.lookaheadFree)})
                    </div>
                    <p className="text-xs font-mono">
                      原因：{backtestResult.insufficientReason}
                    </p>
                    <p className="text-xs text-slate-400">
                      根據系統誠實性規範，歷史 K 線或歷史 OI／Funding 資料不足時嚴禁使用當下值回填過去，亦嚴禁自行補零、虛構歷史統計或估算回測指標。
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 font-mono tabular-nums">
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        已驗證收盤 K 線
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-100">
                        {backtestResult.confirmedBarsTested} 根
                      </div>
                      <div
                        className={
                          backtestResult.lookaheadFree
                            ? 'mt-1 text-[11px] text-emerald-400'
                            : 'mt-1 text-[11px] text-amber-400'
                        }
                      >
                        Lookahead-Free: {backtestResult.lookaheadFree ? 'Verified' : 'False'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        紙上交易總數 (tradeCount)
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-100">
                        {backtestResult.tradeCount ??
                          backtestResult.totalTrades ??
                          '資料不足'}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        多 {backtestResult.longCount ?? 0} / 空{' '}
                        {backtestResult.shortCount ?? 0}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        歷史紙上勝率 (淨 / 毛)
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-100">
                        {(backtestResult.netWinRate ??
                          backtestResult.winRate ??
                          backtestResult.winRatePercent) !== null
                          ? `${backtestResult.netWinRate ?? backtestResult.winRate ?? backtestResult.winRatePercent}%`
                          : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[10px] font-sans text-slate-400">
                        毛勝率:{' '}
                        {(backtestResult.winRate ??
                          backtestResult.winRatePercent) !== null
                          ? `${backtestResult.winRate ?? backtestResult.winRatePercent}%`
                          : 'null'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        淨期望值 / 成本拖累
                      </div>
                      <div
                        className={`mt-1 text-lg font-bold ${
                          (backtestResult.netExpectancyR ??
                            backtestResult.expectancyR ??
                            0) > 0
                            ? 'text-emerald-400'
                            : 'text-sky-300'
                        }`}
                      >
                        {backtestResult.netExpectancyR !== null &&
                        backtestResult.netExpectancyR !== undefined
                          ? `${backtestResult.netExpectancyR}R`
                          : backtestResult.averageR !== null &&
                              backtestResult.averageR !== undefined
                            ? `${backtestResult.averageR}R`
                            : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        毛 Expectancy:{' '}
                        {backtestResult.expectancyR !== null &&
                        backtestResult.expectancyR !== undefined
                          ? `${backtestResult.expectancyR}R`
                          : 'null'}
                        {backtestResult.totalCostDragR !== null &&
                        backtestResult.totalCostDragR !== undefined
                          ? ` · 成本 -${backtestResult.totalCostDragR}R`
                          : ''}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        最大回撤 (淨 / 毛)
                      </div>
                      <div className="mt-1 text-lg font-bold text-rose-400">
                        {backtestResult.netMaxDrawdownR !== null &&
                        backtestResult.netMaxDrawdownR !== undefined
                          ? `${backtestResult.netMaxDrawdownR} R`
                          : backtestResult.maxDrawdownR !== null
                            ? `${backtestResult.maxDrawdownR} R`
                            : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400">
                        毛 MDD:{' '}
                        {backtestResult.maxDrawdownR !== null
                          ? `${backtestResult.maxDrawdownR}R`
                          : 'null'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        盈虧因子 (淨 PF / 毛 PF)
                      </div>
                      <div className="mt-1 text-lg font-bold text-amber-300">
                        {backtestResult.netProfitFactor !== null &&
                        backtestResult.netProfitFactor !== undefined
                          ? backtestResult.netProfitFactor
                          : backtestResult.profitFactor !== null
                            ? backtestResult.profitFactor
                            : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400">
                        毛 PF: {backtestResult.profitFactor ?? 'null'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        平均持倉時間 (avgHolding)
                      </div>
                      <div className="mt-1 text-sm font-bold text-slate-100">
                        {backtestResult.averageHoldingTime ?? 'null (NO_TRADES)'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Walk-Forward 3-Window Chronological Split Table */}
                {backtestResult.walkForward && (
                  <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-bold text-amber-300">
                          Walk-Forward 三階段時間切割驗證 (Training / Validation / Forward Test)
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          嚴格依照時間先後切割，禁止隨機打散時間序列 (noShufflingVerified=true)，且凍結規則版本 ({backtestResult.walkForward.frozenRuleVersion}) 禁止將 Forward Test 結果回流調參。
                        </p>
                      </div>
                      <div className="text-[11px] font-mono text-emerald-400">
                        chronologicalOrderVerified: TRUE · parameterFeedbackBlocked: TRUE
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono tabular-nums">
                        <thead className="border-b border-slate-800 text-slate-400">
                          <tr>
                            <th className="py-2 px-2.5">階段 (Window)</th>
                            <th className="py-2 px-2.5">時間範圍 (startTime ~ endTime)</th>
                            <th className="py-2 px-2.5 text-right">K 線數</th>
                            <th className="py-2 px-2.5">狀態</th>
                            <th className="py-2 px-2.5 text-right">訊號 / 攔截</th>
                            <th className="py-2 px-2.5 text-right">交易數 (多/空)</th>
                            <th className="py-2 px-2.5 text-right">勝率</th>
                            <th className="py-2 px-2.5 text-right">平均R / 期望值</th>
                            <th className="py-2 px-2.5 text-right">Max DD</th>
                            <th className="py-2 px-2.5 text-right">Profit Factor</th>
                            <th className="py-2 px-2.5">平均持倉時間</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {[
                            backtestResult.walkForward.trainingWindow,
                            backtestResult.walkForward.validationWindow,
                            backtestResult.walkForward.forwardTestWindow,
                          ].map((w) => (
                            <tr key={w.stage}>
                              <td className="py-2 px-2.5 font-semibold text-slate-100">
                                {w.stageLabel}
                              </td>
                              <td className="py-2 px-2.5 text-[11px] text-slate-400">
                                {w.startTime.slice(0, 16).replace('T', ' ')} ~{' '}
                                {w.endTime.slice(0, 16).replace('T', ' ')}
                              </td>
                              <td className="py-2 px-2.5 text-right">
                                {w.confirmedBarsCount}
                              </td>
                              <td className="py-2 px-2.5">
                                <span
                                  className={
                                    w.status === 'COMPLETED'
                                      ? 'text-emerald-400'
                                      : 'text-amber-300'
                                  }
                                >
                                  {w.status} ({w.metricStatus ?? 'READY'})
                                </span>
                              </td>
                              <td className="py-2 px-2.5 text-right">
                                {w.signalCount} / {w.blockedCount}
                              </td>
                              <td className="py-2 px-2.5 text-right">
                                {w.tradeCount ?? 'null'} (
                                {w.longCount ?? 0}/{w.shortCount ?? 0})
                              </td>
                              <td className="py-2 px-2.5 text-right">
                                {w.netWinRate !== null &&
                                w.netWinRate !== undefined
                                  ? `${w.netWinRate}%`
                                  : w.winRate !== null
                                    ? `${w.winRate}%`
                                    : 'null'}
                                {w.winRate !== null && (
                                  <div className="text-[10px] text-slate-500">
                                    毛 {w.winRate}%
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-2.5 text-right text-sky-300">
                                {w.netAverageR !== null &&
                                w.netAverageR !== undefined
                                  ? `${w.netAverageR}R`
                                  : w.averageR !== null
                                    ? `${w.averageR}R`
                                    : 'null'}
                                {w.averageR !== null && (
                                  <div className="text-[10px] text-slate-500">
                                    毛 {w.averageR}R
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-2.5 text-right text-rose-400">
                                {w.netMaxDrawdownR !== null &&
                                w.netMaxDrawdownR !== undefined
                                  ? `${w.netMaxDrawdownR}R`
                                  : w.maxDrawdownR !== null
                                    ? `${w.maxDrawdownR}R`
                                    : 'null'}
                              </td>
                              <td className="py-2 px-2.5 text-right text-amber-300">
                                {w.netProfitFactor ?? w.profitFactor ?? 'null'}
                              </td>
                              <td className="py-2 px-2.5 text-[11px] text-slate-300">
                                {w.averageHoldingTime ?? 'null'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Per-Signal Point-in-Time Evidence & Decision Trace List */}
                {backtestResult.trades.length > 0 && (
                  <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                    <h3 className="text-xs font-bold text-slate-200">
                      回測紙上交易明細與 Point-in-Time Decision Trace ({backtestResult.trades.length} 筆)
                    </h3>
                    <div className="space-y-2 max-h-[360px] overflow-y-auto">
                      {backtestResult.trades.map((tr, idx) => (
                        <details
                          key={tr.signalId ?? idx}
                          className="border border-slate-800/90 bg-slate-900/50 p-3 text-xs font-mono"
                        >
                          <summary className="cursor-pointer flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span
                                className={
                                  tr.direction === 'LONG'
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-rose-400 font-bold'
                                }
                              >
                                [{tr.direction} · {tr.actionStateAtSignal}]
                              </span>{' '}
                              <span className="text-slate-200">
                                進場 ${formatPriceDynamic(tr.referenceEntryPrice)} → 出場 $
                                {formatPriceDynamic(tr.exitPrice)} (失效 $
                                {formatPriceDynamic(tr.structuralInvalidationPrice)} / 目標 $
                                {formatPriceDynamic(tr.structuralTargetPrice)})
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span
                                className={
                                  (tr.netRMultiple ?? tr.rMultiple) > 0
                                    ? 'text-emerald-400 font-bold'
                                    : (tr.netRMultiple ?? tr.rMultiple) < 0
                                      ? 'text-rose-400 font-bold'
                                      : 'text-slate-300'
                                }
                              >
                                {tr.outcome} (淨{' '}
                                {(tr.netRMultiple ?? tr.rMultiple) > 0 ? '+' : ''}
                                {tr.netRMultiple ?? tr.rMultiple}R · 毛{' '}
                                {tr.rMultiple > 0 ? '+' : ''}
                                {tr.rMultiple}R
                                {typeof tr.totalCostR === 'number'
                                  ? ` · 成本 -${tr.totalCostR}R`
                                  : ''}
                                )
                              </span>
                              <span className="text-slate-400 text-[11px]">
                                點擊展開 Decision Trace & Point-in-Time Evidence
                              </span>
                            </div>
                          </summary>
                          <div className="mt-2.5 border-t border-slate-800 pt-2.5 text-[11px] text-slate-300 space-y-1">
                            <div>證據摘要: {tr.evidencesSummary}</div>
                            {tr.pointInTimeEvidence && (
                              <>
                                <div>
                                  Point-in-Time K 線時間（台北）: openTime=
                                  {formatTaipeiDateTime(
                                    tr.pointInTimeEvidence.barOpenTime
                                  )}{' '}
                                  · closeTime=
                                  {formatTaipeiDateTime(
                                    tr.pointInTimeEvidence.barCloseTime
                                  )}{' '}
                                  · decisionAt=
                                  {formatTaipeiDateTime(tr.pointInTimeEvidence.decisionAt)}
                                </div>
                                <div>
                                  當時可見已確認 K 線數 (confirmedBarsCount)={' '}
                                  {tr.pointInTimeEvidence.confirmedBarsCount} ·
                                  前 30 根量能基線數 (volumeBaselineBars)={' '}
                                  {tr.pointInTimeEvidence.volumeBaselineBars} ·
                                  oiFundingPointInTime={' '}
                                  {String(tr.pointInTimeEvidence.oiFundingPointInTime)}
                                </div>
                                <div>
                                  歷史 OI 對齊: oiValue=
                                  {tr.pointInTimeEvidence.oiValue ?? tr.pointInTimeEvidence.oi ?? 'N/A'} ·
                                  oiDataTimestamp=
                                  {tr.pointInTimeEvidence.oiDataTimestamp
                                    ? formatTaipeiDateTime(tr.pointInTimeEvidence.oiDataTimestamp)
                                    : 'N/A'}{' '}
                                  · 歷史 Funding 對齊: fundingRate=
                                  {tr.pointInTimeEvidence.fundingRate ?? tr.pointInTimeEvidence.funding ?? 'N/A'} ·
                                  fundingDataTimestamp=
                                  {tr.pointInTimeEvidence.fundingDataTimestamp
                                    ? formatTaipeiDateTime(tr.pointInTimeEvidence.fundingDataTimestamp)
                                    : 'N/A'}
                                </div>
                                <div>
                                  雙層狀態: 第一層={tr.pointInTimeEvidence.marketRadarCategory} ·
                                  第二層={tr.pointInTimeEvidence.smcActionState} (
                                  {tr.pointInTimeEvidence.smcEvaluationStatus}) ·
                                  最終訊號={tr.pointInTimeEvidence.finalTradeSignal}
                                </div>
                                <div>
                                  SMC Evidences:{' '}
                                  {tr.pointInTimeEvidence.smcEvidence.join(' | ')}
                                </div>
                              </>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Auto-Backtest Scheduler & Persisted SQLite Backtest Reports Table */}
            <div className="space-y-4 pt-2">
              <AutoBacktestControlPanel
                status={autoBacktestStatus}
                loading={autoBacktestLoading}
                watchlistCount={watchlist.length}
                dataMode={dataMode}
                selectedExchange={selectedExchange}
                sourceFilter={backtestSourceFilter}
                searchQuery={backtestSearchQuery}
                onChangeSourceFilter={setBacktestSourceFilter}
                onChangeSearchQuery={setBacktestSearchQuery}
                onUpdateConfig={updateAutoBacktestConfig}
                onRunNow={runAutoBacktestNow}
              />

              {(() => {
                const cleanQuery = backtestSearchQuery.trim().toUpperCase();
                const visibleReports = backtestReports.filter((rep) => {
                  const src = rep.triggerSource ?? 'MANUAL';
                  if (
                    backtestSourceFilter !== 'ALL' &&
                    src !== backtestSourceFilter
                  ) {
                    return false;
                  }
                  if (cleanQuery && !rep.symbol.toUpperCase().includes(cleanQuery)) {
                    return false;
                  }
                  return true;
                });

                return (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-200">
                      SQLite 持久化歷史回測報表庫 (顯示 {visibleReports.length} /{' '}
                      {backtestReports.length} 筆)
                    </h3>
                    <div className="border border-slate-800 bg-slate-950 overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono tabular-nums">
                        <thead className="border-b border-slate-800 text-slate-400">
                          <tr>
                            <th className="py-2.5 px-3">ID / RunID</th>
                            <th className="py-2.5 px-3">來源</th>
                            <th className="py-2.5 px-3">建立時間</th>
                            <th className="py-2.5 px-3">標的 / 交易所 / 週期</th>
                            <th className="py-2.5 px-3">資料分類 / 狀態</th>
                            <th className="py-2.5 px-3 text-right">驗證 K 線數</th>
                            <th className="py-2.5 px-3 text-right">交易數 (多/空)</th>
                            <th className="py-2.5 px-3 text-right">紙上勝率</th>
                            <th className="py-2.5 px-3 text-right">Expectancy R</th>
                            <th className="py-2.5 px-3 text-right">Max DD</th>
                            <th className="py-2.5 px-3 text-right">Profit Factor</th>
                            <th className="py-2.5 px-3">共用規則版本</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {visibleReports.length === 0 ? (
                            <tr>
                              <td
                                colSpan={12}
                                className="py-6 text-center font-sans text-slate-500"
                              >
                                {backtestReports.length === 0
                                  ? '尚無歷史回測報表紀錄'
                                  : '目前篩選條件下無相符回測報表紀錄'}
                              </td>
                            </tr>
                          ) : (
                            visibleReports.map((rep) => {
                              const isAuto =
                                rep.triggerSource === 'AUTO_SCHEDULED';
                              return (
                                <tr key={rep.id ?? rep.backtestRunId}>
                                  <td className="py-2 px-3 text-slate-400">
                                    #{rep.id ?? '-'}{' '}
                                    {rep.backtestRunId
                                      ? `(${rep.backtestRunId.slice(0, 16)})`
                                      : ''}
                                  </td>
                                  <td className="py-2 px-3 whitespace-nowrap">
                                    <span
                                      className={
                                        isAuto
                                          ? 'text-sky-300 font-semibold'
                                          : 'text-slate-400'
                                      }
                                    >
                                      {isAuto ? '自動排程' : '手動'}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-slate-300">
                                    {rep.createdAt
                                      ? formatTaipeiTime(rep.createdAt)
                                      : ''}
                                  </td>
                                  <td className="py-2 px-3 font-semibold text-slate-100">
                                    {rep.symbol} · {rep.exchange} ·{' '}
                                    {rep.timeframe}
                                  </td>
                                  <td className="py-2 px-3">
                                    <span className="text-amber-300 mr-1.5">
                                      [
                                      {rep.dataClassification ??
                                        (rep.provenance.isDemo ? 'DEMO' : 'REAL')}
                                      ]
                                    </span>
                                    <span
                                      className={
                                        rep.status === 'COMPLETED'
                                          ? 'text-emerald-400'
                                          : 'text-amber-300'
                                      }
                                    >
                                      {rep.status}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {rep.confirmedBarsTested}
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {rep.tradeCount ?? rep.totalTrades ?? 'N/A'}
                                    {rep.longCount !== undefined &&
                                    rep.longCount !== null
                                      ? ` (${rep.longCount}/${rep.shortCount ?? 0})`
                                      : ''}
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {(rep.winRate ?? rep.winRatePercent) !== null
                                      ? `${rep.winRate ?? rep.winRatePercent}%`
                                      : 'N/A'}
                                  </td>
                                  <td className="py-2 px-3 text-right text-sky-300">
                                    {rep.expectancyR !== null &&
                                    rep.expectancyR !== undefined
                                      ? `${rep.expectancyR}R`
                                      : 'N/A'}
                                  </td>
                                  <td className="py-2 px-3 text-right text-rose-400">
                                    {rep.maxDrawdownR !== null
                                      ? `${rep.maxDrawdownR}R`
                                      : 'N/A'}
                                  </td>
                                  <td className="py-2 px-3 text-right text-amber-300">
                                    {rep.profitFactor ?? 'N/A'}
                                  </td>
                                  <td className="py-2 px-3 text-[11px] text-slate-400">
                                    {rep.ruleVersion}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </div>
          </section>
        )}

        {/* SECTION 4: Paper Trading Ledger (SQLite Persisted, Strictly PAPER ONLY) */}
        {activeSection === 'paper_ledger' && (
          <section className="order-3 border border-slate-800 bg-slate-900/30 p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-amber-400" />
                  <span>
                    SQLite 持久化紙上交易觀察帳本 (Paper Trading Ledger — PAPER ONLY / LIVE ORDERS DISABLED)
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  僅供紙上結構驗證與 R 值統計追蹤，每次全市場掃描自動以最新公開價格更新未實現 R 值，絕不執行任何實盤下單。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {symbolDetail && (
                  <button
                    type="button"
                    onClick={recordPaperObservation}
                    className="rounded bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    將目前選取標的 ({symbolDetail.symbol}) 登記至紙上帳本
                  </button>
                )}
                <button
                  type="button"
                  onClick={fetchPaperLedger}
                  disabled={ledgerLoading}
                  className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  重新整理帳本
                </button>
              </div>
            </div>

            {/* Paper Portfolio Net BTC Exposure & Directional Concentration */}
            {(() => {
              const allOpenEntries = paperLedger.filter(
                (e) => e.status === 'OPEN'
              );
              const waitingLimitCount = allOpenEntries.filter(
                (e) => e.fillStatus === 'WAITING_LIMIT'
              ).length;
              const openEntries = allOpenEntries.filter(
                (e) => (e.fillStatus ?? 'FILLED') === 'FILLED'
              );
              const longCount = openEntries.filter(
                (e) => e.side === 'LONG'
              ).length;
              const shortCount = openEntries.filter(
                (e) => e.side === 'SHORT'
              ).length;
              const netDirectionScore = longCount - shortCount;
              const corrBySymbol = new Map(
                (scanData?.candidates ?? []).map((c) => [
                  c.symbol,
                  c.btcCorrelation,
                ])
              );
              let highCoupledOpenCount = 0;
              const betaSamples: number[] = [];
              for (const e of openEntries) {
                const corr = corrBySymbol.get(e.symbol);
                if (corr && corr.status === 'READY' && !corr.isBenchmark) {
                  if (
                    corr.tier === 'HIGH_COUPLED' ||
                    (corr.pearson15m ?? 0) >= 0.7
                  ) {
                    highCoupledOpenCount++;
                  }
                  if (typeof corr.beta15m === 'number') {
                    betaSamples.push(
                      e.side === 'LONG' ? corr.beta15m : -corr.beta15m
                    );
                  }
                } else if (e.symbol === 'BTCUSDT') {
                  betaSamples.push(e.side === 'LONG' ? 1 : -1);
                }
              }
              const netBtcBeta =
                betaSamples.length > 0
                  ? betaSamples.reduce((a, b) => a + b, 0) /
                    Math.max(1, openEntries.length)
                  : null;
              return (
                <div
                  id="paper-portfolio-btc-exposure"
                  className="grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono tabular-nums text-xs"
                >
                  <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3">
                    <div className="font-sans text-[11px] text-slate-400">
                      已成交持倉 / 待觸價限價單
                    </div>
                    <div className="mt-1 text-sm font-bold text-slate-100">
                      {openEntries.length} 筆 (多 {longCount} / 空 {shortCount})
                      {waitingLimitCount > 0 && (
                        <span className="ml-1.5 text-[11px] text-amber-300">
                          · 待觸價 {waitingLimitCount}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3">
                    <div className="font-sans text-[11px] text-slate-400">
                      組合淨方向傾向 (已成交)
                    </div>
                    <div
                      className={`mt-1 text-sm font-bold ${
                        netDirectionScore > 0
                          ? 'text-emerald-400'
                          : netDirectionScore < 0
                            ? 'text-rose-400'
                            : 'text-slate-200'
                      }`}
                    >
                      {netDirectionScore > 0
                        ? `淨偏多 (+${netDirectionScore})`
                        : netDirectionScore < 0
                          ? `淨偏空 (${netDirectionScore})`
                          : '多空均衡 (0)'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3">
                    <div className="font-sans text-[11px] text-slate-400">
                      高 BTC 連動持倉 (r ≥ 0.70)
                    </div>
                    <div
                      className={`mt-1 text-sm font-bold ${
                        highCoupledOpenCount >= 2
                          ? 'text-amber-300'
                          : 'text-slate-100'
                      }`}
                    >
                      {highCoupledOpenCount} 筆
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3">
                    <div className="font-sans text-[11px] text-slate-400">
                      等效 BTC 淨曝險 Beta
                    </div>
                    <div className="mt-1 text-sm font-bold text-sky-300">
                      {netBtcBeta !== null
                        ? `${netBtcBeta >= 0 ? '+' : ''}${netBtcBeta.toFixed(2)}x`
                        : openEntries.length === 0
                          ? '無持倉 (0.00x)'
                          : '待累積對齊'}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Multi-Track Paper Strategy & Pullback Effectiveness Comparison Panel */}
            {(() => {
              const activeComparison =
                paperTrackScope === 'ALL_INCLUDING_DEMO'
                  ? trackComparisonAll
                  : trackComparisonLive;
              const tracks = activeComparison?.tracks ?? [];
              const trackColors: Record<
                PaperStrategyTrack,
                { border: string; title: string; badge: string }
              > = {
                EARLY_IGNITION: {
                  border: 'border-cyan-500/30 bg-cyan-950/15',
                  title: 'text-cyan-300',
                  badge: 'bg-cyan-500/15 text-cyan-200',
                },
                FORMAL_SMC_MARKET: {
                  border: 'border-emerald-500/30 bg-emerald-950/15',
                  title: 'text-emerald-300',
                  badge: 'bg-emerald-500/15 text-emerald-200',
                },
                SMC_PULLBACK_LIMIT: {
                  border: 'border-amber-500/35 bg-amber-950/15',
                  title: 'text-amber-300',
                  badge: 'bg-amber-500/15 text-amber-200',
                },
                MANUAL_OBSERVATION: {
                  border: 'border-slate-800 bg-slate-950/80',
                  title: 'text-slate-300',
                  badge: 'bg-slate-800 text-slate-300',
                },
              };

              const waitingCount = paperLedger.filter(
                (e) => e.status === 'OPEN' && e.fillStatus === 'WAITING_LIMIT'
              ).length;
              const expiredCount = paperLedger.filter(
                (e) => e.status === 'CLOSED_EXPIRED'
              ).length;

              const visibleEntries = paperLedger.filter((e) => {
                if (paperTrackFilter === 'ALL') return true;
                if (paperTrackFilter === 'WAITING_LIMIT') {
                  return e.status === 'OPEN' && e.fillStatus === 'WAITING_LIMIT';
                }
                if (paperTrackFilter === 'EXPIRED_LIMIT') {
                  return e.status === 'CLOSED_EXPIRED';
                }
                return (e.strategyTrack ?? 'MANUAL_OBSERVATION') === paperTrackFilter;
              });

              const trackBadgeLabel = (t?: PaperStrategyTrack) => {
                if (t === 'EARLY_IGNITION') return '早鳥起漲';
                if (t === 'FORMAL_SMC_MARKET') return '正式 SMC 現價';
                if (t === 'SMC_PULLBACK_LIMIT') return 'FVG/OB 回踩限價';
                return '一般觀察';
              };

              const formatExpiredReasonZh = (
                reason?: PaperLedgerEntry['expiredReason']
              ) => {
                if (reason === 'TARGET_MISSED') return '未回踩即達標作廢';
                if (reason === 'INVALIDATED_BEFORE_FILL') return '結構提前失效作廢';
                if (reason === 'TTL_TIMEOUT') return 'TTL 逾時過期作廢';
                if (reason === 'MANUAL_CANCEL') return '手動撤銷掛單';
                return '已過期作廢';
              };

              const formatTtlRemaining = (expiresAt?: string | null) => {
                if (!expiresAt) return null;
                const remMs = Date.parse(expiresAt) - Date.now();
                if (!Number.isFinite(remMs)) return null;
                if (remMs <= 0) return { label: '待掃描清理 (已到期)', urgent: true };
                const totalMins = Math.floor(remMs / 60_000);
                const hrs = Math.floor(totalMins / 60);
                const mins = totalMins % 60;
                return {
                  label: hrs > 0 ? `TTL 剩 ${hrs}h ${mins}m` : `TTL 剩 ${mins}m`,
                  urgent: totalMins <= 30,
                };
              };

              return (
                <>
                  <div
                    id="paper-track-comparison-panel"
                    className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold text-slate-100">
                          分軌勝率與回踩成效統計 (早鳥 vs 正式 SMC 現價 vs FVG/OB 回踩限價)
                        </span>
                        {activeComparison?.pullbackVsChaseDeltaR !== null &&
                          activeComparison?.pullbackVsChaseDeltaR !== undefined && (
                            <span
                              className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                (activeComparison.netPullbackVsChaseDeltaR ??
                                  activeComparison.pullbackVsChaseDeltaR) >= 0
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : 'bg-rose-500/15 text-rose-300'
                              }`}
                            >
                              回踩 vs 現價追單 Delta: 淨{' '}
                              {activeComparison.netPullbackVsChaseDeltaR !==
                              null &&
                              activeComparison.netPullbackVsChaseDeltaR !==
                                undefined
                                ? `${activeComparison.netPullbackVsChaseDeltaR >= 0 ? '+' : ''}${activeComparison.netPullbackVsChaseDeltaR}R`
                                : '--'}{' '}
                              (毛{' '}
                              {activeComparison.pullbackVsChaseDeltaR >= 0
                                ? '+'
                                : ''}
                              {activeComparison.pullbackVsChaseDeltaR}R)
                            </span>
                          )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setPaperTrackScope('LIVE_ONLY')}
                          className={`rounded-lg border px-2.5 py-1 cursor-pointer ${
                            paperTrackScope === 'LIVE_ONLY'
                              ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200 font-semibold'
                              : 'border-slate-700 bg-slate-900 text-slate-400'
                          }`}
                        >
                          僅統計 Live 真實紀錄
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaperTrackScope('ALL_INCLUDING_DEMO')}
                          className={`rounded-lg border px-2.5 py-1 cursor-pointer ${
                            paperTrackScope === 'ALL_INCLUDING_DEMO'
                              ? 'border-amber-500/60 bg-amber-500/15 text-amber-200 font-semibold'
                              : 'border-slate-700 bg-slate-900 text-slate-400'
                          }`}
                        >
                          含 Demo 模擬對照
                        </button>
                      </div>
                    </div>

                    {activeComparison &&
                      paperTrackScope === 'LIVE_ONLY' &&
                      activeComparison.totalDemoExcluded > 0 && (
                        <div className="text-[11px] text-amber-300/90">
                          已嚴格隔離排除 {activeComparison.totalDemoExcluded} 筆 Demo 模擬紀錄（可切換右側「含 Demo 模擬對照」檢視模擬統計）。
                        </div>
                      )}

                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 font-mono tabular-nums text-xs">
                      {tracks.map((tr) => {
                        const style = trackColors[tr.track];
                        const isLeader = activeComparison?.leaderTrack === tr.track;
                        return (
                          <div
                            key={tr.track}
                            className={`rounded-xl border p-3 space-y-1.5 ${style.border}`}
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <span className={`font-sans text-xs font-bold ${style.title}`}>
                                {tr.labelZh}
                              </span>
                              {isLeader && (
                                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                                  平均 R 領先
                                </span>
                              )}
                            </div>
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-lg font-bold text-slate-100">
                                {tr.netWinRatePercent !== null &&
                                tr.netWinRatePercent !== undefined
                                  ? `${tr.netWinRatePercent}%`
                                  : tr.winRatePercent !== null
                                    ? `${tr.winRatePercent}%`
                                    : '尚無結算'}
                              </span>
                              <span
                                className={`text-xs font-bold ${
                                  (tr.netAvgPnlR ?? tr.avgPnlR ?? 0) > 0
                                    ? 'text-emerald-400'
                                    : (tr.netAvgPnlR ?? tr.avgPnlR ?? 0) < 0
                                      ? 'text-rose-400'
                                      : 'text-slate-400'
                                }`}
                              >
                                {(tr.netAvgPnlR ?? tr.avgPnlR) !== null
                                  ? `淨均 ${(tr.netAvgPnlR ?? tr.avgPnlR)! > 0 ? '+' : ''}${tr.netAvgPnlR ?? tr.avgPnlR}R`
                                  : '淨均 --'}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 flex flex-wrap items-center justify-between gap-1">
                              <span>
                                總 {tr.totalEntries} · 待觸價 {tr.waitingLimitCount} · 已結 {tr.closedCount}
                              </span>
                              <span>
                                淨累計{' '}
                                {(tr.netTotalPnlR ?? tr.totalPnlR) > 0 ? '+' : ''}
                                {tr.netTotalPnlR ?? tr.totalPnlR}R (毛{' '}
                                {tr.totalPnlR > 0 ? '+' : ''}
                                {tr.totalPnlR}R)
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 flex flex-wrap items-center justify-between gap-1">
                              <span>
                                勝/敗 {tr.winCount}/{tr.lossCount}
                                {tr.expiredLimitCount > 0
                                  ? ` · 過期 ${tr.expiredLimitCount}`
                                  : ''}
                              </span>
                              <span>
                                {tr.track === 'SMC_PULLBACK_LIMIT' &&
                                tr.fillRatePercent !== null
                                  ? `觸價率 ${tr.fillRatePercent}% · `
                                  : ''}
                                淨PF{' '}
                                {(tr.netProfitFactor ?? tr.profitFactor) !== null
                                  ? tr.netProfitFactor ?? tr.profitFactor
                                  : '--'}
                                {tr.avgCostDragR !== null &&
                                tr.avgCostDragR !== undefined
                                  ? ` · 成本 -${tr.avgCostDragR}R`
                                  : ''}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Ledger Track Filter Bar */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    {(
                      [
                        { key: 'ALL', label: `全部紀錄 (${paperLedger.length})` },
                        { key: 'EARLY_IGNITION', label: '早鳥起漲' },
                        { key: 'FORMAL_SMC_MARKET', label: '正式 SMC 現價' },
                        { key: 'SMC_PULLBACK_LIMIT', label: 'FVG/OB 回踩限價' },
                        {
                          key: 'WAITING_LIMIT',
                          label: `待觸價掛單 (${waitingCount})`,
                        },
                        {
                          key: 'EXPIRED_LIMIT',
                          label: `已過期/撤銷 (${expiredCount})`,
                        },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => setPaperTrackFilter(f.key)}
                        className={`rounded-lg border px-2.5 py-1 cursor-pointer ${
                          paperTrackFilter === f.key
                            ? 'border-amber-500/60 bg-amber-500/15 text-amber-200 font-semibold'
                            : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <div className="border border-slate-800 bg-slate-950 overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono tabular-nums">
                      <thead className="border-b border-slate-800 text-slate-400">
                        <tr>
                          <th className="py-2.5 px-3">ID</th>
                          <th className="py-2.5 px-3">標的 / 軌道</th>
                          <th className="py-2.5 px-3">方向 / 成交與效期</th>
                          <th className="py-2.5 px-3 text-right">進場/掛單價</th>
                          <th className="py-2.5 px-3 text-right">結構失效參考</th>
                          <th className="py-2.5 px-3 text-right">結構目標參考</th>
                          <th className="py-2.5 px-3 text-right">目前/結算價</th>
                          <th className="py-2.5 px-3 text-right">紙上 R 值</th>
                          <th className="py-2.5 px-3">資料來源與時間</th>
                          <th className="py-2.5 px-3 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {visibleEntries.length === 0 ? (
                          <tr>
                            <td
                              colSpan={10}
                              className="py-8 text-center font-sans text-slate-500"
                            >
                              目前此篩選條件下尚無紙上交易觀察紀錄。請在雷達選取幣種後點擊「登記紙上觀察帳本」、「登記早鳥紙上單」或「掛回踩紙上限價單」。
                            </td>
                          </tr>
                        ) : (
                          visibleEntries.map((entry) => {
                            const isWaitingLimit =
                              entry.status === 'OPEN' &&
                              entry.fillStatus === 'WAITING_LIMIT';
                            const isExpiredLimit =
                              entry.status === 'CLOSED_EXPIRED';
                            const limitDistPct =
                              entry.currentPrice > 0
                                ? ((entry.entryPrice - entry.currentPrice) /
                                    entry.currentPrice) *
                                  100
                                : null;
                            const isFarWaitingLimit =
                              isWaitingLimit &&
                              limitDistPct !== null &&
                              Math.abs(limitDistPct) > 3.5;
                            const ttlInfo = isWaitingLimit
                              ? formatTtlRemaining(entry.expiresAt)
                              : null;

                            return (
                              <tr key={entry.id}>
                                <td className="py-2.5 px-3 text-slate-400">
                                  #{entry.id}
                                </td>
                                <td className="py-2.5 px-3 font-semibold text-slate-100">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span>{entry.symbol}</span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                        entry.strategyTrack === 'EARLY_IGNITION'
                                          ? 'bg-cyan-500/15 text-cyan-300'
                                          : entry.strategyTrack ===
                                              'SMC_PULLBACK_LIMIT'
                                            ? 'bg-amber-500/15 text-amber-300'
                                            : entry.strategyTrack ===
                                                'FORMAL_SMC_MARKET'
                                              ? 'bg-emerald-500/15 text-emerald-300'
                                              : 'bg-slate-800 text-slate-300'
                                      }`}
                                    >
                                      {trackBadgeLabel(entry.strategyTrack)}
                                    </span>
                                    {(entry.isDemo ||
                                      entry.provenance.isDemo ||
                                      entry.exchange === 'demo_synthetic') && (
                                      <span className="rounded border border-amber-500/50 bg-amber-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                                        {entry.demoIsolationLabel ??
                                          'DEMO · 非即時資料 · 不計入 Live Paper 績效'}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    {entry.exchange} · {entry.timeframe}
                                    {entry.entryAnchorLabel
                                      ? ` · ${entry.entryAnchorLabel}`
                                      : ''}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3">
                                  <div>
                                    <span
                                      className={
                                        entry.side === 'LONG'
                                          ? 'text-emerald-400 font-semibold'
                                          : 'text-rose-400 font-semibold'
                                      }
                                    >
                                      {entry.side}
                                    </span>{' '}
                                    ·{' '}
                                    <span className="text-slate-300">
                                      {entry.status}
                                    </span>
                                  </div>
                                  <div className="text-[10px] mt-0.5 space-y-0.5">
                                    {isWaitingLimit ? (
                                      <>
                                        <div className="flex flex-wrap items-center gap-1 text-amber-300">
                                          <span>待觸價 (WAITING_LIMIT)</span>
                                          {limitDistPct !== null && (
                                            <span
                                              className={
                                                isFarWaitingLimit
                                                  ? 'text-rose-300 font-semibold'
                                                  : 'text-sky-300'
                                              }
                                            >
                                              · 距觸價{' '}
                                              {limitDistPct >= 0 ? '+' : ''}
                                              {limitDistPct.toFixed(2)}%
                                              {isFarWaitingLimit ? ' (偏遠)' : ''}
                                            </span>
                                          )}
                                        </div>
                                        {ttlInfo && (
                                          <div
                                            className={
                                              ttlInfo.urgent
                                                ? 'text-rose-300 font-semibold'
                                                : 'text-slate-400'
                                            }
                                          >
                                            {ttlInfo.label}
                                          </div>
                                        )}
                                      </>
                                    ) : isExpiredLimit ? (
                                      <span className="text-slate-400">
                                        {formatExpiredReasonZh(entry.expiredReason)}
                                      </span>
                                    ) : (
                                      <span className="text-slate-400">
                                        已成交 (FILLED)
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  ${formatPriceDynamic(entry.entryPrice)}
                                </td>
                                <td className="py-2.5 px-3 text-right text-slate-400 tabular-nums">
                                  <div>${formatPriceDynamic(entry.invalidationPrice)}</div>
                                  {entry.breakevenArmed &&
                                    entry.trailingStopPrice && (
                                      <div className="text-[10px] text-emerald-400">
                                        +1R 保本 $
                                        {formatPriceDynamic(
                                          entry.trailingStopPrice
                                        )}
                                      </div>
                                    )}
                                </td>
                                <td className="py-2.5 px-3 text-right text-slate-400">
                                  ${formatPriceDynamic(entry.targetPrice)}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  $
                                  {formatPriceDynamic(
                                    entry.exitPrice ?? entry.currentPrice
                                  )}
                                </td>
                                <td
                                  className={`py-2.5 px-3 text-right font-semibold ${
                                    isWaitingLimit
                                      ? 'text-amber-300'
                                      : isExpiredLimit
                                        ? 'text-slate-400'
                                        : (entry.netPnlR ?? entry.pnlR) > 0
                                          ? 'text-emerald-400'
                                          : (entry.netPnlR ?? entry.pnlR) < 0
                                            ? 'text-rose-400'
                                            : 'text-slate-300'
                                  }`}
                                >
                                  {isWaitingLimit ? (
                                    '待回踩觸發'
                                  ) : isExpiredLimit ? (
                                    '0R (已作廢)'
                                  ) : (
                                    <>
                                      <div>
                                        淨 {(entry.netPnlR ?? entry.pnlR) > 0 ? '+' : ''}
                                        {entry.netPnlR ?? entry.pnlR}R ({entry.pnlPercent > 0 ? '+' : ''}
                                        {entry.pnlPercent}%)
                                      </div>
                                      <div className="text-[10px] text-slate-400 font-normal">
                                        毛 {entry.pnlR > 0 ? '+' : ''}
                                        {entry.pnlR}R
                                        {typeof entry.totalCostR === 'number'
                                          ? ` · 成本 -${entry.totalCostR}R`
                                          : ''}
                                      </div>
                                    </>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 text-[10px] text-slate-400">
                                  <div>{entry.provenance.source.slice(0, 38)}</div>
                                  <div>
                                    {formatTaipeiDateTime(entry.openedAt)}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  {entry.status === 'OPEN' ? (
                                    <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                                      {isWaitingLimit && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            extendPaperLimitPosition(entry.id, 120)
                                          }
                                          className="rounded border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/25 cursor-pointer whitespace-nowrap"
                                        >
                                          延長 +2h
                                        </button>
                                      )}
                                      {!isWaitingLimit && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            void importPaperToPositionSentinel();
                                            setActiveSection('position_sentinel');
                                          }}
                                          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/25 cursor-pointer whitespace-nowrap"
                                        >
                                          哨兵守護
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          closePaperPosition(
                                            entry.id,
                                            entry.currentPrice
                                          )
                                        }
                                        className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                                      >
                                        {isWaitingLimit
                                          ? '撤銷待觸價單'
                                          : '紙上平倉結算'}
                                      </button>
                                    </div>
                                  ) : isExpiredLimit ? (
                                    <span className="text-slate-500">
                                      已作廢
                                    </span>
                                  ) : (
                                    <span className="text-slate-500">
                                      已結算
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </section>
        )}

        {/* SECTION 5: Background Scan Scheduler (Dry-Run Notifications) & Data Quality Report */}
        {activeSection === 'notifications' && (
          <div className="order-3 grid grid-cols-1 gap-6 lg:grid-cols-12">
            <section className="lg:col-span-7 border border-slate-800 bg-slate-900/30 p-5 space-y-5">
              {/* External Notification Channels Control (Telegram Bot & Discord Webhook) */}
              <ExternalNotificationPanel
                status={externalNotifyStatus}
                loading={externalNotifyLoading}
                testingChannel={externalTestingChannel}
                testFeedback={externalTestFeedback}
                selectedSymbol={selectedSymbol}
                onUpdateConfig={updateExternalNotifyConfig}
                onSendTest={sendExternalTestNotification}
              />

              {/* Background Scheduler Control */}
              <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      背景全市場掃描與歷史量能 Collector 排程器 (通知維持 DRY_RUN_ONLY)
                    </h3>
                    <p className="text-xs text-slate-400">
                      定時收集各幣種歷史成交量樣本寫入 SQLite，並將候選送入 Dry-Run 預覽佇列（絕不主動外發或下單）。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => controlScheduler('run_once')}
                      disabled={schedulerLoading}
                      className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer"
                    >
                      立即執行一次背景掃描
                    </button>
                    {schedulerStatus?.running ? (
                      <button
                        type="button"
                        onClick={() => controlScheduler('stop')}
                        className="flex items-center gap-1 rounded border border-rose-500/40 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-200 cursor-pointer"
                      >
                        <Square className="h-3 w-3" />
                        <span>停止背景排程</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => controlScheduler('start')}
                        className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-200 cursor-pointer"
                      >
                        <Play className="h-3 w-3" />
                        <span>啟動背景排程</span>
                      </button>
                    )}
                  </div>
                </div>

                {schedulerStatus && (
                  <div className="text-xs font-mono text-slate-400 flex flex-wrap items-center gap-3">
                    <span>
                      排程狀態:{' '}
                      <strong
                        className={
                          schedulerStatus.running
                            ? 'text-emerald-400'
                            : 'text-slate-300'
                        }
                      >
                        {schedulerStatus.running ? 'RUNNING' : 'IDLE'}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>
                      通知模式:{' '}
                      <strong className="text-amber-300">
                        {schedulerStatus.notificationMode}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>累計執行: {schedulerStatus.totalRuns} 次</span>
                  </div>
                )}
              </div>

              {/* Dry-Run Notification Preview Queue */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <Send className="h-4 w-4 text-amber-400" />
                    <span>
                      Telegram 與 TradingView Webhook 通知介面 (Dry-Run 預覽，不自動外發)
                    </span>
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => dispatchNotificationPreview('TELEGRAM')}
                    disabled={!symbolDetail}
                    className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    Dry-Run Telegram ({selectedSymbol})
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      dispatchNotificationPreview('TRADINGVIEW_WEBHOOK')
                    }
                    disabled={!symbolDetail}
                    className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
                  >
                    Dry-Run TradingView ({selectedSymbol})
                  </button>
                </div>
              </div>

              <div className="space-y-3 max-h-[420px] overflow-y-auto">
                {notificationHistory.length === 0 ? (
                  <div className="border border-slate-800 bg-slate-950 p-6 text-center text-xs text-slate-400">
                    尚無通知預覽紀錄。請點擊上方按鈕測試 Dry-Run 預覽。
                  </div>
                ) : (
                  notificationHistory.map((rec) => (
                    <div
                      key={rec.id}
                      className="border border-slate-800 bg-slate-950 p-4 space-y-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-200">
                            {rec.channel}
                          </span>
                          <span>·</span>
                          <span className="text-amber-300 font-semibold">
                            {rec.symbol}
                          </span>
                          <span>·</span>
                          <span>{rec.actionState}</span>
                        </div>
                        <span
                          className={
                            rec.status === 'PREVIEW_DRY_RUN'
                              ? 'text-emerald-400 font-semibold'
                              : 'text-rose-400 font-semibold'
                          }
                        >
                          [{rec.status}]
                        </span>
                      </div>
                      <div className="text-slate-400">{rec.reason}</div>
                      <div className="text-[11px] font-mono text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                        <span>scanRunId: {rec.scanRunId ?? 'N/A'}</span>
                        <span>signalId: {rec.signalId ?? 'N/A'}</span>
                        <span>ruleVersion: {rec.ruleVersion ?? 'N/A'}</span>
                        <span>evaluatedAt: {rec.evaluatedAt ?? 'N/A'}</span>
                        <span>cooldownUntil: {rec.cooldownUntil ?? 'N/A'}</span>
                      </div>
                      <pre className="overflow-x-auto border border-slate-800/90 bg-slate-900/60 p-3 font-mono text-[11px] text-slate-200 whitespace-pre-wrap">
                        {rec.formattedMessage}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Right 5 cols: Data Quality Report */}
            <section className="lg:col-span-5 border border-slate-800 bg-slate-900/30 p-5 space-y-4">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-amber-400" />
                  <span>全市場資料品質報表 (Data Quality Report)</span>
                </h2>
              </div>

              {scanData?.dataQuality ? (
                <div className="space-y-3 text-xs font-mono tabular-nums">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        掃描合約總數
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-100">
                        {scanData.dataQuality.totalSymbolsScanned}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        歷史量能基線完備數
                      </div>
                      <div className="mt-1 text-lg font-bold text-emerald-400">
                        {scanData.dataQuality.historicalVolumeReadyCount ?? 0}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        資金費率缺失數
                      </div>
                      <div className="mt-1 text-lg font-bold text-amber-300">
                        {scanData.dataQuality.missingFundingCount}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        極端資金費率標的數
                      </div>
                      <div className="mt-1 text-lg font-bold text-amber-400">
                        {scanData.dataQuality.extremeFundingCount}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        低流動性標的數
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-200">
                        {scanData.dataQuality.lowLiquidityCount}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3">
                      <div className="font-sans text-slate-400">
                        過期時間戳 (Stale) 標的
                      </div>
                      <div className="mt-1 text-lg font-bold text-rose-400">
                        {scanData.dataQuality.staleRecordCount}
                      </div>
                    </div>
                  </div>

                  <div className="border border-slate-800 bg-slate-950 p-3.5 space-y-1.5">
                    <div className="font-sans font-semibold text-slate-100">
                      低流動性與真實盤口門檻設定 (Scanner Config)
                    </div>
                    <div className="text-[11px] text-slate-300 space-y-0.5">
                      <div>
                        MIN_QUOTE_VOLUME_24H: $
                        {scanData.dataQuality.scannerConfig.MIN_QUOTE_VOLUME_24H.toLocaleString()}
                      </div>
                      <div>
                        MAX_ALLOWED_SPREAD_PERCENT:{' '}
                        {
                          scanData.dataQuality.scannerConfig
                            .MAX_ALLOWED_SPREAD_PERCENT
                        }
                        %
                      </div>
                      <div>
                        MISSING_SPREAD_COUNT (BID_ASK_SPREAD):{' '}
                        {scanData.dataQuality.missingSpreadCount}
                      </div>
                      <div>
                        LOW_LIQUIDITY_POLICY:{' '}
                        {
                          scanData.dataQuality.scannerConfig
                            .LOW_LIQUIDITY_POLICY
                        }
                      </div>
                    </div>
                    <p className="font-sans text-slate-400 pt-1">
                      {scanData.dataQuality.volumeProxyNotice}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-400">尚無資料品質報表</div>
              )}
            </section>

            {/* Phase 5 Full-Width Panel: Paper Shadow Monitor, Signal Lifecycle & Notification Sandbox */}
            <section className="lg:col-span-12 border border-slate-800 bg-slate-900/30 p-5 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                    <span>
                      Phase 5：長時間 Paper Trading 影子運行、訊號品質監控與通知沙盒 (Paper Shadow Monitor &amp; Notification Sandbox)
                    </span>
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    持續以即時公開資料執行全市場雷達與 SMC 評估，所有訊號只寫入紙上交易帳本與本地{' '}
                    <code className="text-amber-300">notification_outbox</code>{' '}
                    沙盒 · 嚴禁真實下單與外部推播
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={paperMonitorLoading}
                    onClick={() => controlPaperMonitor('start')}
                    className="inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    啟動影子運行 (Start Shadow Monitor)
                  </button>
                  <button
                    type="button"
                    disabled={paperMonitorLoading}
                    onClick={() => controlPaperMonitor('pause')}
                    className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
                  >
                    <Square className="h-3.5 w-3.5" />
                    暫停 (Pause)
                  </button>
                  <button
                    type="button"
                    disabled={paperMonitorLoading}
                    onClick={() => controlPaperMonitor('resume')}
                    className="inline-flex items-center gap-1 rounded border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
                  >
                    恢復 (Resume)
                  </button>
                  <button
                    type="button"
                    disabled={paperMonitorLoading}
                    onClick={() =>
                      fetchPaperMonitorAll(reportWindow, selectedExchange)
                    }
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${paperMonitorLoading ? 'animate-spin' : ''}`}
                    />
                    刷新監控與報表
                  </button>
                </div>
              </div>

              {/* Monitor Run Provenance & Health Strip */}
              <div className="border border-slate-800 bg-slate-950 p-3.5 text-xs font-mono space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span>
                      影子運行狀態:{' '}
                      <strong
                        className={
                          paperMonitorStatus?.workerState === 'RUNNING'
                            ? 'text-emerald-400'
                            : paperMonitorStatus?.workerState === 'ERROR'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                        }
                      >
                        {paperMonitorStatus?.workerState ?? 'STOPPED'}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>
                      scannerHealth:{' '}
                      <strong className="text-emerald-300">
                        {paperMonitorHealth?.scannerHealth ?? 'IDLE'}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>
                      queueHealth:{' '}
                      <strong className="text-sky-300">
                        {paperMonitorHealth?.queueHealth ?? 'IDLE'}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>
                      exchangeApiHealth:{' '}
                      <strong className="text-cyan-300">
                        {paperMonitorHealth?.exchangeApiHealth ?? 'HEALTHY'}
                      </strong>
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    mode: {paperMonitorStatus?.mode ?? 'PAPER ONLY'} ·{' '}
                    {paperMonitorStatus?.liveOrders ?? 'LIVE ORDERS DISABLED'} ·{' '}
                    {paperMonitorStatus?.executionPolicy ??
                      'NEVER AUTO-PLACE ORDERS'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                  <span>
                    monitorRunId: {paperMonitorStatus?.monitorRunId ?? 'N/A'}
                  </span>
                  <span>
                    scanRunId: {paperMonitorStatus?.scanRunId ?? 'N/A'}
                  </span>
                  <span>
                    databaseInstanceId:{' '}
                    {paperMonitorStatus?.databaseInstanceId ?? 'N/A'}
                  </span>
                  <span>
                    statsVersion: {paperMonitorStatus?.statsVersion ?? 1}
                  </span>
                  <span>
                    lastScanAt:{' '}
                    {paperMonitorStatus?.lastScanAt ?? '尚未執行'}
                  </span>
                  <span>
                    nextScanAt:{' '}
                    {paperMonitorStatus?.nextScanAt ?? '未排程'}
                  </span>
                  <span>
                    lastHeartbeatAt:{' '}
                    {paperMonitorStatus?.lastHeartbeatAt ?? 'N/A'}
                  </span>
                </div>

                {/* Health Warnings */}
                {paperMonitorHealth &&
                  paperMonitorHealth.warnings.length > 0 && (
                    <div className="border border-amber-500/40 bg-amber-950/30 p-2.5 text-[11px] text-amber-200 space-y-1">
                      {paperMonitorHealth.warnings.map((w, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>

              {/* Phase 7: 24-Hour Monitoring Window Panel & Four-State Diagnostic Classification */}
              <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-amber-300">
                      Phase 7 · 24 小時 Paper 影子監控視窗 (24-Hour Monitoring Window)
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      monitoringWindowId:{' '}
                      {paperWindowReport?.monitoringWindowId ??
                        paperMonitorStatus?.monitoringWindowId ??
                        'N/A'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                    <span
                      className={`px-2 py-0.5 font-bold border ${
                        paperWindowReport?.windowStatus === 'COMPLETED'
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                          : paperWindowReport?.windowStatus === 'ERROR'
                            ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                            : paperWindowReport?.windowStatus === 'INTERRUPTED'
                              ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                              : 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                      }`}
                    >
                      windowStatus: {paperWindowReport?.windowStatus ?? 'RUNNING'}
                    </span>
                    <span className="border border-slate-700 bg-slate-900 px-2 py-0.5 text-amber-200">
                      {paperWindowReport?.windowStatus === 'COMPLETED'
                        ? '24 小時監控：已完成'
                        : '24 小時監控：未完成／未驗證'}
                    </span>
                  </div>
                </div>

                {/* Required 11 Fields Grid (Section 八) */}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6 font-mono tabular-nums text-xs">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      24 小時監控狀態
                    </div>
                    <div className="mt-1 font-bold text-sky-300">
                      {paperWindowReport?.windowStatus ?? 'RUNNING'}
                    </div>
                    <div className="text-[10px] font-sans text-amber-300">
                      {paperWindowReport?.windowStatus === 'COMPLETED'
                        ? '已滿 24 小時'
                        : '未完成／未驗證 (<24h)'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      已運行時間 / 剩餘時間
                    </div>
                    <div className="mt-1 font-bold text-slate-100">
                      {paperWindowReport?.windowElapsedFormatted ?? '0h 0m 0s'}
                    </div>
                    <div className="text-[10px] text-amber-300">
                      剩餘:{' '}
                      {paperWindowReport?.windowRemainingFormatted ??
                        '24h 0m 0s'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      完成掃描週期數 / 最後掃描
                    </div>
                    <div className="mt-1 font-bold text-emerald-400">
                      {paperWindowReport?.completedScanCycles ?? 0} 個有效週期 (總計{' '}
                      {paperWindowReport?.totalScanCycles ?? 0})
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      最後掃描:{' '}
                      {paperMonitorStatus?.lastScanAt ?? '尚未執行'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      LONG 候選數 / SHORT 候選數 (24h 視窗)
                    </div>
                    <div className="mt-1 font-bold">
                      <span className="text-emerald-400">
                        LONG:{' '}
                        {paperWindowReport?.longCandidateCount ??
                          paperMonitorStatus?.longCandidateCount ??
                          0}
                      </span>{' '}
                      /{' '}
                      <span className="text-rose-400">
                        SHORT:{' '}
                        {paperWindowReport?.shortCandidateCount ??
                          paperMonitorStatus?.shortCandidateCount ??
                          0}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      WAIT: {paperWindowReport?.waitCount ?? 0} · WATCH:{' '}
                      {paperWindowReport?.watchCount ?? 0} · HIGH RISK:{' '}
                      {paperWindowReport?.highRiskCount ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      Paper 訊號數 (Opened / Closed)
                    </div>
                    <div className="mt-1 font-bold text-sky-300">
                      總訊號: {paperWindowReport?.totalSignals ?? 0} (開倉{' '}
                      {paperWindowReport?.paperOpened ?? 0} / 平倉{' '}
                      {paperWindowReport?.paperClosed ?? 0})
                    </div>
                    <div className="text-[10px] text-slate-400">
                      openSignals: {paperWindowReport?.openSignals ?? 0} ·
                      missed:{' '}
                      <strong className="text-amber-300">
                        {paperWindowReport?.entryWindowMissed ?? 0}
                      </strong>{' '}
                      · {paperWindowReport?.metricStatus ?? 'NO_TRADES'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2.5">
                    <div className="text-[10px] text-slate-400">
                      資料健康度 / 外部通知請求數
                    </div>
                    <div className="mt-1 font-bold text-emerald-400">
                      {paperMonitorHealth?.exchangeApiHealth ?? 'HEALTHY'} ·{' '}
                      {paperWindowReport?.candidateStatus ??
                        'NO_CANDIDATE_VALID'}
                    </div>
                    <div className="text-[10px] text-emerald-300">
                      外部請求: TG=
                      {paperWindowReport?.externalTelegramRequestsCount ?? 0} /
                      TV=
                      {paperWindowReport?.externalTradingViewRequestsCount ?? 0}
                    </div>
                  </div>
                </div>

                {/* Separated Snapshots: windowFinalSnapshot vs currentLiveCycleSnapshot vs latestScanSnapshot */}
                <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-3 font-mono text-[11px]">
                  <div className="border border-emerald-500/40 bg-emerald-950/15 p-2.5 space-y-1">
                    <div className="font-sans font-semibold text-emerald-300 flex items-center justify-between">
                      <span>1. 已完成 24 小時固定報告 (windowFinalSnapshot)</span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-200">
                        {paperWindowReport?.windowFinalSnapshot
                          ? 'FROZEN_COMPLETED'
                          : 'WINDOW_ACTIVE'}
                      </span>
                    </div>
                    {paperWindowReport?.windowFinalSnapshot ? (
                      <div className="text-slate-300 space-y-0.5">
                        <div>
                          windowStatus:{' '}
                          <strong className="text-emerald-300">
                            {paperWindowReport.windowFinalSnapshot.windowStatus}
                          </strong>{' '}
                          · completedAt:{' '}
                          {paperWindowReport.windowFinalSnapshot.windowCompletedAt}
                        </div>
                        <div>
                          finalEvaluatedCount:{' '}
                          {paperWindowReport.windowFinalSnapshot.finalEvaluatedCount}{' '}
                          · finalCandidateCount:{' '}
                          <strong className="text-amber-300">
                            {paperWindowReport.windowFinalSnapshot.finalCandidateCount}
                          </strong>{' '}
                          (LONG:{' '}
                          {paperWindowReport.windowFinalSnapshot.longCandidateCount}{' '}
                          / SHORT:{' '}
                          {paperWindowReport.windowFinalSnapshot.shortCandidateCount}
                          )
                        </div>
                        <div>
                          finalPaperSignalCount:{' '}
                          <strong className="text-sky-300">
                            {
                              paperWindowReport.windowFinalSnapshot
                                .finalPaperSignalCount
                            }
                          </strong>{' '}
                          · completedCycles:{' '}
                          {
                            paperWindowReport.windowFinalSnapshot
                              .completedCycleIds.length
                          }
                        </div>
                      </div>
                    ) : (
                      <div className="text-slate-400">
                        24 小時視窗尚未凍結完成快照
                      </div>
                    )}
                  </div>

                  <div className="border border-sky-500/40 bg-sky-950/15 p-2.5 space-y-1">
                    <div className="font-sans font-semibold text-sky-300 flex items-center justify-between">
                      <span>
                        2. 目前掃描週期即時狀態 (currentLiveCycleSnapshot)
                      </span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 bg-sky-500/20 text-sky-200">
                        {paperWindowReport?.currentLiveCycleSnapshot
                          ?.currentCycleStatus ??
                          paperMonitorStatus?.currentLiveCycleSnapshot
                            ?.currentCycleStatus ??
                          'IDLE'}
                      </span>
                    </div>
                    <div className="text-slate-300 space-y-0.5">
                      <div>
                        currentScanCycleId:{' '}
                        {paperWindowReport?.currentLiveCycleSnapshot
                          ?.currentScanCycleId ??
                          paperMonitorStatus?.currentLiveCycleSnapshot
                            ?.currentScanCycleId ??
                          'N/A'}
                      </div>
                      <div>
                        currentEvaluatedCount:{' '}
                        <strong className="text-slate-100">
                          {paperWindowReport?.currentLiveCycleSnapshot
                            ?.currentEvaluatedCount ??
                            paperMonitorStatus?.currentLiveCycleSnapshot
                              ?.currentEvaluatedCount ??
                            0}
                        </strong>{' '}
                        · currentPendingCount:{' '}
                        <strong className="text-amber-300">
                          {paperWindowReport?.currentLiveCycleSnapshot
                            ?.currentPendingCount ??
                            paperMonitorStatus?.currentLiveCycleSnapshot
                              ?.currentPendingCount ??
                            0}
                        </strong>
                      </div>
                      <div>
                        LONG:{' '}
                        {paperWindowReport?.currentLiveCycleSnapshot
                          ?.currentLongCandidateCount ?? 0}{' '}
                        · SHORT:{' '}
                        {paperWindowReport?.currentLiveCycleSnapshot
                          ?.currentShortCandidateCount ?? 0}{' '}
                        (與已完成 24h 報告分離)
                      </div>
                    </div>
                  </div>

                  <div className="border border-amber-500/40 bg-slate-900/60 p-2.5 space-y-1">
                    <div className="font-sans font-semibold text-amber-300 flex items-center justify-between">
                      <span>3. 最新完整掃描快照 (latestScanSnapshot)</span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-200">
                        LATEST_COMPLETED
                      </span>
                    </div>
                    <div className="text-slate-300 space-y-0.5">
                      <div>
                        latestScanCycleId:{' '}
                        {paperWindowReport?.latestScanSnapshot
                          ?.latestScanCycleId ?? 'N/A'}
                      </div>
                      <div>
                        evaluated:{' '}
                        {paperWindowReport?.latestScanSnapshot?.evaluatedCount ??
                          0}{' '}
                        / pending:{' '}
                        {paperWindowReport?.latestScanSnapshot?.pendingCount ??
                          0}{' '}
                        · LONG:{' '}
                        {paperWindowReport?.latestScanSnapshot
                          ?.longCandidateCount ?? 0}{' '}
                        / SHORT:{' '}
                        <strong className="text-rose-400">
                          {paperWindowReport?.latestScanSnapshot
                            ?.shortCandidateCount ?? 0}
                        </strong>
                      </div>
                      <div>
                        snapshotAt:{' '}
                        {paperWindowReport?.latestScanSnapshot?.snapshotAt ??
                          'N/A'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Explicit 4-State Diagnostic Distinction Strip (Section 八) */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                  <div
                    className={`border p-2.5 ${
                      paperWindowReport?.candidateStatus ===
                      'NO_CANDIDATE_VALID'
                        ? 'border-emerald-500/60 bg-emerald-950/25 text-emerald-200'
                        : 'border-slate-800 bg-slate-900/30 text-slate-400'
                    }`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>1. 沒有候選 (NO_CANDIDATE_VALID)</span>
                      <span className="font-mono text-[11px]">
                        {paperWindowReport?.candidateStatus ===
                        'NO_CANDIDATE_VALID'
                          ? '● 目前成立'
                          : '○ 未觸發'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] opacity-90">
                      522 檔全數完成評估、無 PENDING/過期/Fallback，因真實市場未同時滿足全套 SMC Gate 而無候選。
                    </div>
                  </div>

                  <div
                    className={`border p-2.5 ${
                      paperWindowReport?.windowStatus === 'RUNNING'
                        ? 'border-sky-500/60 bg-sky-950/25 text-sky-200'
                        : 'border-slate-800 bg-slate-900/30 text-slate-400'
                    }`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>2. 尚未完成監控 (RUNNING &lt; 24h)</span>
                      <span className="font-mono text-[11px]">
                        {paperWindowReport?.windowStatus === 'RUNNING'
                          ? '● 目前成立'
                          : '○ 未觸發'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] opacity-90">
                      {paperWindowReport?.full24hVerificationNotice ??
                        '24 小時監控：未完成／未驗證（不得以單次掃描冒充 24 小時完成）'}
                    </div>
                  </div>

                  <div
                    className={`border p-2.5 ${
                      paperWindowReport?.windowStatus === 'INTERRUPTED'
                        ? 'border-amber-500/60 bg-amber-950/25 text-amber-200'
                        : 'border-slate-800 bg-slate-900/30 text-slate-400'
                    }`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>3. 監控中斷 (INTERRUPTED)</span>
                      <span className="font-mono text-[11px]">
                        {paperWindowReport?.windowStatus === 'INTERRUPTED'
                          ? '● 目前成立'
                          : '○ 正常運行'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] opacity-90">
                      背景排程被手動暫停或中斷；恢復運行後將繼續累積 24 小時視窗週期。
                    </div>
                  </div>

                  <div
                    className={`border p-2.5 ${
                      paperWindowReport?.candidateStatus ===
                        'NO_CANDIDATE_SUSPECTED' ||
                      paperWindowReport?.windowStatus === 'ERROR'
                        ? 'border-rose-500/60 bg-rose-950/25 text-rose-200'
                        : 'border-slate-800 bg-slate-900/30 text-slate-400'
                    }`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>4. 資料品質錯誤 (NO_CANDIDATE_SUSPECTED)</span>
                      <span className="font-mono text-[11px]">
                        {paperWindowReport?.candidateStatus ===
                          'NO_CANDIDATE_SUSPECTED' ||
                        paperWindowReport?.windowStatus === 'ERROR'
                          ? '● 偵測異常'
                          : '○ 0 錯誤'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] opacity-90">
                      若存在 PENDING &gt; 0、FAILED、RATE_LIMITED、stale 或 fallback，強制標記為可疑並排除於有效週期外。
                    </div>
                  </div>
                </div>

                {/* Recorded Scan Cycles in 24h Window */}
                {paperWindowReport && paperWindowReport.cycles.length > 0 && (
                  <div className="border-t border-slate-800 pt-2.5">
                    <div className="text-[11px] font-semibold text-slate-300 mb-1.5">
                      24 小時監控視窗已記錄掃描週期 (共{' '}
                      {paperWindowReport.cycles.length} 次掃描，有效完成{' '}
                      {paperWindowReport.completedScanCycles} 次)
                    </div>
                    <div className="max-h-36 overflow-y-auto space-y-1 font-mono text-[11px]">
                      {paperWindowReport.cycles.map((c) => (
                        <div
                          key={c.scanCycleId}
                          className="flex flex-wrap items-center justify-between gap-2 border border-slate-800/80 bg-slate-900/40 px-2.5 py-1 text-slate-300"
                        >
                          <span>
                            cycleId:{' '}
                            <strong className="text-amber-300">
                              {c.scanCycleId}
                            </strong>{' '}
                            · snapshotAt: {c.snapshotAt}
                          </span>
                          <span>
                            evaluated: {c.evaluatedCount}/{c.totalContracts} ·
                            PENDING: {c.pendingCount} · WAIT: {c.waitCount} ·
                            WATCH: {c.watchCount} · HIGH_RISK:{' '}
                            {c.highRiskCount} · LONG: {c.longCandidateCount} ·
                            SHORT: {c.shortCandidateCount} ·{' '}
                            <strong
                              className={
                                c.cycleValid
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                              }
                            >
                              {c.cycleValid
                                ? 'VALID_COMPLETED'
                                : `INVALID (${c.dataQualityWarning ?? 'WARNING'})`}
                            </strong>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Health & Quality Metrics Grid */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8 font-mono tabular-nums text-xs">
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    視窗最終已評估 / PENDING
                  </div>
                  <div className="mt-1 text-sm font-bold text-slate-100">
                    {paperWindowReport?.evaluatedCount ??
                      paperMonitorStatus?.evaluatedCount ??
                      0}{' '}
                    /{' '}
                    <span className="text-amber-300">
                      {paperWindowReport?.pendingCount ??
                        paperMonitorStatus?.pendingCount ??
                        0}
                    </span>
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    視窗 LONG / SHORT 候選
                  </div>
                  <div className="mt-1 text-sm font-bold">
                    <span className="text-emerald-400">
                      {paperWindowReport?.longCandidateCount ??
                        paperMonitorStatus?.longCandidateCount ??
                        0}
                    </span>{' '}
                    /{' '}
                    <span className="text-rose-400">
                      {paperWindowReport?.shortCandidateCount ??
                        paperMonitorStatus?.shortCandidateCount ??
                        0}
                    </span>
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    rateLimitCount (429)
                  </div>
                  <div className="mt-1 text-sm font-bold text-amber-300">
                    {paperMonitorHealth?.rateLimitCount ?? 0}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    failedJobCount
                  </div>
                  <div className="mt-1 text-sm font-bold text-rose-400">
                    {paperMonitorHealth?.failedJobCount ?? 0}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    staleResultCount
                  </div>
                  <div className="mt-1 text-sm font-bold text-amber-300">
                    {paperMonitorHealth?.staleResultCount ?? 0}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    missingOiFundingCount
                  </div>
                  <div className="mt-1 text-sm font-bold text-amber-400">
                    {paperMonitorHealth?.missingOiFundingCount ?? 0}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    notificationBlocked (PENDING_ENTRY:{' '}
                    {paperWindowReport?.pendingEntryNotificationCount ?? 0})
                  </div>
                  <div className="mt-1 text-sm font-bold text-sky-300">
                    {paperWindowReport?.notificationBlockedCount ??
                      paperMonitorHealth?.notificationBlockedCount ??
                      0}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-[11px] text-slate-400">
                    categorySmcMismatch
                  </div>
                  <div className="mt-1 text-sm font-bold text-emerald-400">
                    {paperMonitorHealth?.finalCategorySmcMismatchCount ?? 0}
                  </div>
                </div>
              </div>

              {/* 24h / 7d / 30d Signal Outcome Report */}
              <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-100">
                      時間範圍訊號結果統計報表 (24h / 7d / 30d Signal Outcome Report)
                    </span>
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono text-amber-300">
                      metricStatus: {paperMonitorReport?.metricStatus ?? 'NO_TRADES'}
                    </span>
                    <span className="text-xs text-amber-200 font-medium">
                      {paperMonitorReport?.sampleSufficiencyNotice ??
                        '樣本不足，僅供觀察'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(['24h', '7d', '30d'] as const).map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => {
                          setReportWindow(w);
                          void fetchPaperMonitorAll(w, selectedExchange);
                        }}
                        className={`px-2.5 py-1 text-xs font-mono cursor-pointer border ${
                          reportWindow === w
                            ? 'border-amber-400 bg-amber-400/20 text-amber-200 font-bold'
                            : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-11 font-mono tabular-nums text-xs">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">totalSignals</div>
                    <div className="mt-0.5 font-bold text-slate-100">
                      {paperMonitorReport?.totalSignals ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">LONG / SHORT</div>
                    <div className="mt-0.5 font-bold">
                      <span className="text-emerald-400">
                        {paperMonitorReport?.longSignals ?? 0}
                      </span>{' '}
                      /{' '}
                      <span className="text-rose-400">
                        {paperMonitorReport?.shortSignals ?? 0}
                      </span>
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">
                      openSignals / missed
                    </div>
                    <div className="mt-0.5 font-bold text-amber-300">
                      {paperMonitorReport?.openSignals ?? 0} /{' '}
                      {paperMonitorReport?.entryWindowMissed ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">
                      paperOpened / Closed
                    </div>
                    <div className="mt-0.5 font-bold text-sky-300">
                      {paperMonitorReport?.paperOpened ?? 0} /{' '}
                      {paperMonitorReport?.paperClosed ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">wins / losses</div>
                    <div className="mt-0.5 font-bold">
                      <span className="text-emerald-400">
                        {paperMonitorReport?.wins ?? 0}
                      </span>{' '}
                      /{' '}
                      <span className="text-rose-400">
                        {paperMonitorReport?.losses ?? 0}
                      </span>
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">
                      expired / blocked
                    </div>
                    <div className="mt-0.5 font-bold text-amber-300">
                      {paperMonitorReport?.expired ?? 0} /{' '}
                      {paperMonitorReport?.blocked ?? 0}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">winRate</div>
                    <div className="mt-0.5 font-bold text-slate-200">
                      {paperMonitorReport?.winRate !== null &&
                      paperMonitorReport?.winRate !== undefined
                        ? `${paperMonitorReport.winRate}%`
                        : 'null'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">averageR</div>
                    <div className="mt-0.5 font-bold text-slate-200">
                      {paperMonitorReport?.averageR !== null &&
                      paperMonitorReport?.averageR !== undefined
                        ? `${paperMonitorReport.averageR}R`
                        : 'null'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">profitFactor</div>
                    <div className="mt-0.5 font-bold text-slate-200">
                      {paperMonitorReport?.profitFactor !== null &&
                      paperMonitorReport?.profitFactor !== undefined
                        ? paperMonitorReport.profitFactor
                        : 'null'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">expectancyR</div>
                    <div className="mt-0.5 font-bold text-slate-200">
                      {paperMonitorReport?.expectancyR !== null &&
                      paperMonitorReport?.expectancyR !== undefined
                        ? `${paperMonitorReport.expectancyR}R`
                        : 'null'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-[10px] text-slate-400">signalLatency</div>
                    <div className="mt-0.5 font-bold text-cyan-300">
                      {paperMonitorReport?.signalLatency !== null &&
                      paperMonitorReport?.signalLatency !== undefined
                        ? `${paperMonitorReport.signalLatency}ms`
                        : 'N/A'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Two-column layout: Tracked Paper Signals (Left) & Notification Sandbox Outbox (Right) */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Tracked Signals & Decision Trace */}
                <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <h3 className="text-xs font-semibold text-slate-100">
                      訊號生命週期追蹤 (Paper Tracked Signals · 共{' '}
                      {paperTrackedSignals.length} 筆)
                    </h3>
                    <span className="text-[11px] font-mono text-slate-400">
                      進場價僅用 i+1 開盤價 · 同根觸及 SL/TP 保守判止損
                    </span>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto space-y-2">
                    {paperTrackedSignals.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-500">
                        目前尚無追蹤中訊號。當即時 SMC Gate 完整確認或攔截時將自動記錄於此。
                      </div>
                    ) : (
                      paperTrackedSignals.map((sig) => (
                        <div
                          key={sig.signalId}
                          className="border border-slate-800/90 bg-slate-900/50 p-3 text-xs space-y-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-amber-300">
                                {sig.symbol}
                              </span>
                              <span>·</span>
                              <span
                                className={
                                  sig.direction === 'LONG'
                                    ? 'text-emerald-400 font-semibold'
                                    : sig.direction === 'SHORT'
                                      ? 'text-rose-400 font-semibold'
                                      : 'text-slate-400'
                                }
                              >
                                {sig.direction}
                              </span>
                              <span>·</span>
                              <span className="text-slate-300">
                                {sig.smcActionState}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {sig.entryWindowStatus && (
                                <span
                                  className={`px-2 py-0.5 text-[11px] font-semibold border ${
                                    sig.status === 'ENTRY_WINDOW_MISSED' ||
                                    sig.entryWindowStatus.includes('已錯過')
                                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                                      : 'border-slate-700 bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  {sig.entryWindowStatus}
                                </span>
                              )}
                              <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                                {sig.status}
                              </span>
                            </div>
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
                            <span>signalId: {sig.signalId}</span>
                            <span>
                              entryRefPrice:{' '}
                              {sig.entryReferencePrice !== null
                                ? formatPriceDynamic(sig.entryReferencePrice)
                                : sig.status === 'ENTRY_WINDOW_MISSED'
                                  ? 'null (原始進場窗口已錯過·嚴禁回溯)'
                                  : '等待 i+1 開盤確認'}
                            </span>
                            <span>
                              SL/TP:{' '}
                              {sig.stopLoss !== null
                                ? formatPriceDynamic(sig.stopLoss)
                                : 'N/A'}{' '}
                              /{' '}
                              {sig.takeProfit !== null
                                ? formatPriceDynamic(sig.takeProfit)
                                : 'N/A'}
                            </span>
                            <span>
                              R:{' '}
                              {sig.riskMultiple !== null
                                ? `${sig.riskMultiple}R`
                                : '未結算'}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 border-t border-slate-800/70 pt-1 flex flex-wrap gap-x-3 gap-y-1">
                            <span>
                              signalBarCloseTime:{' '}
                              <strong className="text-slate-200">
                                {sig.signalBarCloseTime !== null
                                  ? formatTaipeiDateTime(sig.signalBarCloseTime)
                                  : 'N/A'}
                              </strong>
                            </span>
                            <span>
                              signalDetectedAt:{' '}
                              <strong className="text-slate-200">
                                {formatTaipeiDateTime(
                                  sig.signalDetectedAt ?? sig.evaluatedAt
                                )}
                              </strong>
                            </span>
                            <span>
                              detectionLatencyMs:{' '}
                              <strong
                                className={
                                  (sig.detectionLatencyMs ?? 0) > 1000
                                    ? 'text-amber-300'
                                    : 'text-emerald-300'
                                }
                              >
                                {sig.detectionLatencyMs ?? sig.signalLatencyMs}ms
                              </strong>
                            </span>
                            <span>
                              entryWindowStatus:{' '}
                              <strong
                                className={
                                  sig.status === 'ENTRY_WINDOW_MISSED' ||
                                  (sig.entryWindowStatus ?? '').includes(
                                    '已錯過'
                                  )
                                    ? 'text-amber-300'
                                    : 'text-sky-300'
                                }
                              >
                                {sig.entryWindowStatus ?? '等待下一根 K 線開盤'}
                              </strong>
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => setSelectedTrackedSignal(sig)}
                              className="border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                            >
                              檢視 Decision Trace
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                triggerSandboxPreviewForSignal(
                                  sig.signalId,
                                  'TELEGRAM_SANDBOX'
                                )
                              }
                              className="border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20 cursor-pointer"
                            >
                              Telegram 沙盒預覽
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                triggerSandboxPreviewForSignal(
                                  sig.signalId,
                                  'TRADINGVIEW_SANDBOX'
                                )
                              }
                              className="border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/20 cursor-pointer"
                            >
                              TradingView 沙盒預覽
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {selectedTrackedSignal && (
                    <div className="border border-amber-500/40 bg-slate-900 p-3 text-xs space-y-1.5">
                      <div className="flex items-center justify-between font-mono">
                        <span className="font-semibold text-amber-300">
                          Decision Trace：{selectedTrackedSignal.symbol} (
                          {selectedTrackedSignal.signalId})
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedTrackedSignal(null)}
                          className="text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          關閉
                        </button>
                      </div>
                      <pre className="max-h-48 overflow-auto bg-slate-950 p-2.5 font-mono text-[11px] text-slate-200 whitespace-pre-wrap">
                        {JSON.stringify(
                          {
                            signalId: selectedTrackedSignal.signalId,
                            monitorRunId: selectedTrackedSignal.monitorRunId,
                            scanRunId: selectedTrackedSignal.scanRunId,
                            symbol: selectedTrackedSignal.symbol,
                            exchange: selectedTrackedSignal.exchange,
                            direction: selectedTrackedSignal.direction,
                            marketRadarCategory:
                              selectedTrackedSignal.marketRadarCategory,
                            smcEvaluationStatus:
                              selectedTrackedSignal.smcEvaluationStatus,
                            smcActionState:
                              selectedTrackedSignal.smcActionState,
                            finalTradeSignal:
                              selectedTrackedSignal.finalTradeSignal,
                            ruleVersion: selectedTrackedSignal.ruleVersion,
                            signalBarOpenTime:
                              selectedTrackedSignal.signalBarOpenTime,
                            signalBarCloseTime:
                              selectedTrackedSignal.signalBarCloseTime,
                            signalDetectedAt:
                              selectedTrackedSignal.signalDetectedAt,
                            originalEntryWindowOpenTime:
                              selectedTrackedSignal.originalEntryWindowOpenTime,
                            originalEntryWindowCloseTime:
                              selectedTrackedSignal.originalEntryWindowCloseTime,
                            detectionLatencyMs:
                              selectedTrackedSignal.detectionLatencyMs,
                            entryStatus: selectedTrackedSignal.entryStatus,
                            entryWindowStatus:
                              selectedTrackedSignal.entryWindowStatus,
                            entryReferenceTime:
                              selectedTrackedSignal.entryReferenceTime,
                            entryReferencePrice:
                              selectedTrackedSignal.entryReferencePrice,
                            stopLoss: selectedTrackedSignal.stopLoss,
                            takeProfit: selectedTrackedSignal.takeProfit,
                            riskMultiple: selectedTrackedSignal.riskMultiple,
                            status: selectedTrackedSignal.status,
                            statusReason: selectedTrackedSignal.statusReason,
                            waitReasons: selectedTrackedSignal.waitReasons,
                            evidences: selectedTrackedSignal.evidences,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Local Notification Sandbox Outbox */}
                <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <h3 className="text-xs font-semibold text-slate-100">
                      本地通知沙盒佇列 (notification_outbox · 共{' '}
                      {notificationOutbox.length} 筆)
                    </h3>
                    <span className="text-[11px] font-mono text-emerald-400">
                      外部網路呼叫: 0 (純本地沙盒)
                    </span>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto space-y-2">
                    {notificationOutbox.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-500">
                        目前 notification_outbox 尚無沙盒通知紀錄。
                      </div>
                    ) : (
                      notificationOutbox.map((item) => (
                        <div
                          key={item.notificationId}
                          className="border border-slate-800/90 bg-slate-900/50 p-3 text-xs space-y-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-200">
                                {item.channel}
                              </span>
                              <span>·</span>
                              <span className="text-amber-300">
                                {item.symbol}
                              </span>
                            </div>
                            <span
                              className={
                                item.status === 'SANDBOX_QUEUED' ||
                                item.status === 'PREVIEW_DRY_RUN'
                                  ? 'text-emerald-400 font-semibold'
                                  : item.status === 'PENDING_ENTRY'
                                    ? 'text-amber-300 font-semibold'
                                    : 'text-rose-400 font-semibold'
                              }
                            >
                              [{item.status}]
                            </span>
                          </div>
                          {item.blockedReason && (
                            <div
                              className={`text-[11px] ${
                                item.status === 'PENDING_ENTRY'
                                  ? 'text-amber-200'
                                  : 'text-rose-300'
                              }`}
                            >
                              {item.status === 'PENDING_ENTRY'
                                ? `待進場狀態: ${item.blockedReason}`
                                : `攔截原因: ${item.blockedReason}`}
                            </div>
                          )}
                          <div className="text-[10px] font-mono text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                            <span>id: {item.notificationId}</span>
                            <span>signalId: {item.signalId}</span>
                            <span>scanCycleId: {item.scanCycleId ?? 'N/A'}</span>
                            <span>snapshotAt: {item.snapshotAt ?? 'N/A'}</span>
                            <span>dedupeKey: {item.dedupeKey}</span>
                            <span>
                              cooldownUntil: {item.cooldownUntil ?? 'N/A'}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* SECTION: Position Sentinel (Active Trade Live Trend & Reversal Guardian) */}
        {activeSection === 'position_sentinel' && (
          <PositionSentinelPanel
            status={positionSentinelStatus}
            loading={positionSentinelLoading}
            selectedExchange={selectedExchange}
            availableSymbols={(scanData?.candidates ?? []).map((c) => c.symbol)}
            defaultSymbol={symbolDetail?.symbol ?? selectedSymbol}
            defaultPrice={symbolDetail?.candidate.lastPrice ?? null}
            onRefreshCheck={refreshPositionSentinelCheck}
            onImportPaper={importPaperToPositionSentinel}
            onAddPosition={addPositionToSentinel}
            onUpdatePosition={updatePositionInSentinel}
            onDeletePosition={deletePositionFromSentinel}
            onUpdateConfig={updatePositionSentinelConfig}
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveSection('radar');
              loadSymbolDetail(sym, selectedTimeframe);
            }}
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 bg-[#090d16] px-6 py-4 text-xs text-slate-500">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4">
          <span>
            加密貨幣全市場行情雷達 Phase 2 · 跨所背離、歷史量能異常與 SMC/ICT 結構證據系統
          </span>
          <span className="font-mono text-slate-400">
            PAPER ONLY · LIVE ORDERS DISABLED · NEVER AUTO-PLACE ORDERS
          </span>
        </div>
      </footer>

      <SettingsFormulasModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        activeTab={settingsHubTab}
        onChangeTab={setSettingsHubTab}
        dataMode={dataMode}
        selectedExchange={selectedExchange}
        onSwitchLiveExchange={switchToLiveExchange}
        onSwitchDemoMode={switchToExplicitDemoMode}
        minQuoteVolume24h={minQuoteVolume24h}
        onChangeMinQuoteVolume24h={setMinQuoteVolume24h}
        selectedTimeframe={selectedTimeframe}
        onChangeTimeframe={(tf) => {
          setSelectedTimeframe(tf);
          if (selectedSymbol && !scanError) {
            loadSymbolDetail(selectedSymbol, tf);
          }
        }}
        themeMode={themeMode}
        onChangeThemeMode={setThemeMode}
        scanData={scanData}
        smcScanStatus={smcScanStatus}
        smcQueueLoading={smcQueueLoading}
        onControlSmcQueue={controlSmcQueue}
        onRetryStuckSmcJobs={retryStuckSmcJobs}
        onRefreshSingleSmcSymbol={refreshSingleSmcSymbol}
        selectedSymbol={selectedSymbol}
        schedulerStatus={schedulerStatus}
        schedulerLoading={schedulerLoading}
        onControlScheduler={controlScheduler}
        paperMonitorStatus={paperMonitorStatus}
        paperMonitorLoading={paperMonitorLoading}
        onControlPaperMonitor={controlPaperMonitor}
        systemDbHealth={systemDbHealth}
        dbCheckLoading={dbCheckLoading}
        onRunSystemDbCheck={runSystemDbCheck}
        onRefreshScan={() => executeMarketScan()}
        onSelectSymbolDetail={(sym) => {
          setActiveSection('radar');
          void loadSymbolDetail(sym, selectedTimeframe);
        }}
      />

      <PriceAlertDrawer
        open={alertDrawerOpen}
        onClose={() => setAlertDrawerOpen(false)}
        rules={priceAlerts}
        events={alertEvents}
        soundEnabled={alertSoundEnabled}
        onToggleSound={() => setAlertSoundEnabled((v) => !v)}
        browserNotifyEnabled={browserNotifyEnabled}
        onToggleBrowserNotify={() => {
          void handleToggleBrowserNotify();
        }}
        onAddRule={addPriceAlertRule}
        onDeleteRule={deletePriceAlertRule}
        onToggleRule={togglePriceAlertRule}
        onRearmRule={rearmPriceAlertRule}
        onClearEvents={() => setAlertEvents([])}
        activeSymbolDetail={symbolDetail}
        availableSymbols={(scanData?.candidates ?? []).map((c) => c.symbol)}
      />
    </div>
  );
}

function formatPriceDynamic(price: number): string {
  if (!Number.isFinite(price)) return '0.00';
  if (price >= 1000)
    return price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatUsdCompact(val: number): string {
  if (!Number.isFinite(val)) return '0';
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toFixed(0);
}

function getCategoryTextColor(cat: ScanCategory): string {
  switch (cat) {
    case '多頭候選':
      return 'text-emerald-400 font-semibold';
    case '空頭候選':
      return 'text-rose-400 font-semibold';
    case '高風險':
      return 'text-amber-400 font-semibold';
    default:
      return 'text-sky-300 font-medium';
  }
}

function getMarketRadarTextColor(cat: MarketRadarCategory): string {
  switch (cat) {
    case '雷達多頭觀察':
      return 'text-emerald-400 font-semibold';
    case '雷達空頭觀察':
      return 'text-rose-400 font-semibold';
    case '高風險':
      return 'text-amber-400 font-semibold';
    default:
      return 'text-sky-300 font-medium';
  }
}

function getSmcStateColor(state: SmcActionState): string {
  switch (state) {
    case 'LONG CANDIDATE':
      return 'text-emerald-400';
    case 'SHORT CANDIDATE':
      return 'text-rose-400';
    case 'HIGH RISK':
      return 'text-amber-400';
    case 'WATCH':
      return 'text-sky-300';
    case 'PENDING':
      return 'text-slate-400';
    default:
      return 'text-amber-300';
  }
}

function getPlainLanguageRowExplanation(
  c: MarketScanResponse['candidates'][number],
  smcState: SmcActionState,
  smcEvalStatus: string
): {
  headline: string;
  toneClass: string;
} {
  if (c.finalTradeSignal === '多頭交易候選') {
    return {
      headline: '已通過全部多頭結構關卡 · 可評估紙上做多',
      toneClass: 'text-emerald-400 font-semibold',
    };
  }
  if (c.finalTradeSignal === '空頭交易候選') {
    return {
      headline: '已通過全部空頭結構關卡 · 可評估紙上做空',
      toneClass: 'text-rose-400 font-semibold',
    };
  }
  if (c.isLowLiquidity) {
    return {
      headline: '成交額偏低易有滑價風險 · 僅供觀察不建議進場',
      toneClass: 'text-amber-400',
    };
  }
  if (c.extremeFunding) {
    return {
      headline: '資金費率極端擁擠 · 提防反向清算插針',
      toneClass: 'text-amber-400',
    };
  }
  if (smcEvalStatus === 'PENDING' || smcState === 'PENDING') {
    return {
      headline: '背景排隊檢測中 · 點擊此列可立即插隊解析 K 線結構',
      toneClass: 'text-slate-400',
    };
  }
  if (smcState === 'WATCH') {
    return {
      headline: '已出現初步機構足跡 (FVG/趨勢) · 等待突破與回踩確認',
      toneClass: 'text-sky-300 font-medium',
    };
  }
  if (c.marketRadarCategory === '雷達多頭觀察') {
    return {
      headline: '多頭動能強勁 · 正等待 15m 結構突破或回踩買盤區',
      toneClass: 'text-emerald-300',
    };
  }
  if (c.marketRadarCategory === '雷達空頭觀察') {
    return {
      headline: '空頭動能顯著 · 正等待 15m 結構跌破或反彈壓力區',
      toneClass: 'text-rose-300',
    };
  }
  return {
    headline: '多空結構整理中 · 建議耐心等待方向表態 (觀望)',
    toneClass: 'text-slate-400',
  };
}

function buildPlainLanguageSmcSteps(
  detail: SymbolDetailResponse,
  trace: DecisionTraceApiResponse | SymbolDetailResponse['candidate']['decisionTrace'] | null | undefined
): {
  passedCount: number;
  recommendationTitle: string;
  recommendationBody: string;
  recommendationTone: 'emerald' | 'rose' | 'sky' | 'amber';
  steps: Array<{
    stepNumber: number;
    title: string;
    passed: boolean;
    statusLabel: string;
    plainDesc: string;
  }>;
} {
  const c = detail.candidate;
  const smc = detail.smcAnalysis;
  const liqPassed = trace ? trace.gates.liquidity.passed && trace.gates.funding.passed : !c.isLowLiquidity && !c.extremeFunding;
  const histPassed = trace ? trace.gates.history.passed : c.historicalVolume.status === 'READY';
  const htf1h = smc.mtfAlignment.byTimeframe['1h'];
  const htf4h = smc.mtfAlignment.byTimeframe['4h'];
  const mtfPassed =
    (htf1h === 'BULL' && htf4h === 'BULL') ||
    (htf1h === 'BEAR' && htf4h === 'BEAR') ||
    smc.mtfAlignment.aligned;
  const hasBosOrChoch = smc.evidences.some(
    (e) => (e.code.includes('BOS') || e.code.includes('CHOCH') || e.code.includes('MSS')) && e.passed
  );
  const hasFvgOrOb = smc.evidences.some(
    (e) => (e.code.includes('FVG') || e.code.includes('OB')) && e.passed
  );
  const structurePassed =
    smc.actionState === 'LONG CANDIDATE' ||
    smc.actionState === 'SHORT CANDIDATE' ||
    (hasBosOrChoch && hasFvgOrOb);
  const finalPassed =
    c.finalTradeSignal === '多頭交易候選' ||
    c.finalTradeSignal === '空頭交易候選';

  const steps = [
    {
      stepNumber: 1,
      title: '市場流動性與資金費率安全',
      passed: liqPassed,
      statusLabel: liqPassed ? '安全通過' : '風險攔截',
      plainDesc: liqPassed
        ? `24h 成交額 $${formatUsdCompact(c.quoteVolume24h)} 充足，資金費率正常，不易被惡意插針。`
        : c.isLowLiquidity
          ? `24h 成交額僅 $${formatUsdCompact(c.quoteVolume24h)}（低於 $1,500 萬安全門檻），容易滑價。`
          : '資金費率過度擁擠（|Funding| ≥ 0.05%），提防主力反向軋空或殺多。',
    },
    {
      stepNumber: 2,
      title: '15m 真實歷史量能基線 (30 根 K 線)',
      passed: histPassed,
      statusLabel: histPassed ? '基線穩定' : '基線待確認',
      plainDesc:
        c.historicalVolume.status === 'READY'
          ? `已比對過去 ${c.historicalVolume.sampleCount} 根已收盤 15m K 線，目前量能為平時的 ${c.historicalVolume.rvol} 倍 (Z=${c.historicalVolume.zScore})。`
          : c.historicalVolume.status === 'BASELINE_UNSTABLE'
            ? '近期成交量波動過大（基線不穩定），系統自動限制評分避免誤判假爆量。'
            : `歷史 K 線樣本收集中 (${c.historicalVolume.sampleCount}/${c.historicalVolume.minRequiredSamples})，暫不發出激進訊號。`,
    },
    {
      stepNumber: 3,
      title: '大週期 (1H / 4H) 趨勢共振方向',
      passed: mtfPassed,
      statusLabel: mtfPassed ? `順勢 (${htf4h}/${htf1h})` : `分歧 (${htf4h}/${htf1h})`,
      plainDesc: mtfPassed
        ? `1H (${htf1h}) 與 4H (${htf4h}) 大方向一致，順應大級別資金趨勢。`
        : `目前 4H (${htf4h}) 與 1H (${htf1h}) 方向尚未完全同向，貿然進場容易遇到大級別反壓。`,
    },
    {
      stepNumber: 4,
      title: '15m 機構結構 (突破 BOS/CHoCH + 缺口 FVG)',
      passed: structurePassed,
      statusLabel: structurePassed ? '結構完整' : smc.actionState === 'WATCH' ? '初步成形' : '等待表態',
      plainDesc: structurePassed
        ? '已確認結構突破 (BOS/CHoCH) 並伴隨公平價值缺口 (FVG) 或訂單塊支撐壓力。'
        : smc.actionState === 'WATCH'
          ? '已觀察到部分結構（如 FVG 缺口），正等待價格回踩或完成最後的位移確認。'
          : '目前 15m K 線尚未走出明確的機構突破與回踩形態，系統維持 WAIT 幫您過濾盤整雜訊。',
    },
    {
      stepNumber: 5,
      title: '最終進場確認與盈虧比把關',
      passed: finalPassed,
      statusLabel: finalPassed ? '候選成立' : '觀望等待',
      plainDesc: finalPassed
        ? `已達成「${c.finalTradeSignal}」全部條件！請於下一根 K 線開盤確認進場，絕不回溯舊價。`
        : '尚未同時滿足第一層動能雷達與第二層 SMC 全部關卡，目前最佳策略為「空手觀望」。',
    },
  ];

  const passedCount = steps.filter((s) => s.passed).length;

  if (c.finalTradeSignal === '多頭交易候選') {
    return {
      passedCount,
      recommendationTitle: '🟢 白話結論：多頭結構已完整確認（多頭交易候選）',
      recommendationBody:
        '此標的已通過流動性、歷史量能、多週期趨勢與 15m SMC 結構全部 5 道關卡。可參考下方計算之進場區間、止損價與止盈目標，或點擊「登記紙上觀察帳本」進行無風險模擬驗證。',
      recommendationTone: 'emerald',
      steps,
    };
  }
  if (c.finalTradeSignal === '空頭交易候選') {
    return {
      passedCount,
      recommendationTitle: '🔴 白話結論：空頭結構已完整確認（空頭交易候選）',
      recommendationBody:
        '此標的已通過流動性、歷史量能、多週期趨勢與 15m SMC 空頭結構全部 5 道關卡。可參考下方計算之進場區間、止損價與止盈目標，或點擊「登記紙上觀察帳本」進行無風險模擬驗證。',
      recommendationTone: 'rose',
      steps,
    };
  }
  if (smc.actionState === 'HIGH RISK' || c.isLowLiquidity || c.extremeFunding) {
    return {
      passedCount,
      recommendationTitle: '⚠️ 白話結論：高風險或低流動性警示，建議迴避',
      recommendationBody:
        '目前該幣種成交額偏低或資金費率過度極端，容易出現剧烈上下插針掃損，系統安全閘門已自動攔截，不建議此時操作。',
      recommendationTone: 'amber',
      steps,
    };
  }
  if (smc.actionState === 'WATCH') {
    return {
      passedCount,
      recommendationTitle: `👀 白話結論：結構已過 ${passedCount}/5 關，列入重點觀察（暫勿搶跑）`,
      recommendationBody:
        '已經看到初步機構進場跡象（例如趨勢同向或出現 FVG 缺口），但還差最後一步回踩或位移確認。建議點擊星號加入「觀察清單」，等第 4、5 關亮綠燈再行動。',
      recommendationTone: 'sky',
      steps,
    };
  }
  return {
    passedCount,
    recommendationTitle: `⏳ 白話結論：目前通過 ${passedCount}/5 關，建議耐心等待結構表態`,
    recommendationBody:
      '真正的機構級 SMC 交易機會講究「寧可錯過，不可做錯」。目前此幣種尚未形成高勝率的突破回踩形態，系統強制維持 WAIT 幫您避開盤整磨損。',
    recommendationTone: 'amber',
    steps,
  };
}

