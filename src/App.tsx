import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Bookmark,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  GitCompare,
  Moon,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  Sun,
} from 'lucide-react';
import { KlineSmcChart } from './components/KlineSmcChart.tsx';
import { ProvenanceLine } from './components/ProvenanceLine.tsx';
import {
  BackgroundSchedulerStatus,
  BacktestResult,
  CrossExchangeDivergenceResponse,
  DecisionTraceApiResponse,
  ExchangeId,
  GeminiExplainResponse,
  MarketRadarCategory,
  MarketScanResponse,
  NotificationDispatchRecord,
  NotificationOutboxRecord,
  PaperLedgerEntry,
  PaperMonitorHealthResponse,
  PaperMonitorReportResponse,
  PaperMonitorStatusResponse,
  PaperQualityGateDriftResponse,
  PaperQualityMarketRegimesResponse,
  PaperQualityStatusResponse,
  PaperTrackedSignalRecord,
  Phase7MonitoringWindowReport,
  ScanCategory,
  SmcActionState,
  SmcQualityCycleHistoryResponse,
  SmcQualityGateStatsResponse,
  SmcQualityReasonStatsResponse,
  SmcQualitySignalLatencyResponse,
  SmcQualityWindowReportResponse,
  SmcScanStatusResponse,
  SymbolDetailResponse,
  SystemDatabaseHealthResponse,
  Timeframe,
  TRADING_SAFETY_FLAGS,
} from './types/market.ts';

type ActiveSection =
  | 'radar'
  | 'divergence'
  | 'backtest'
  | 'paper_ledger'
  | 'notifications'
  | 'paper_quality';

const WATCHLIST_STORAGE_KEY = 'crypto_radar_watchlist_v1';
const THEME_STORAGE_KEY = 'crypto_radar_theme_v1';

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
    'ALL' | 'WATCHLIST' | ScanCategory | MarketRadarCategory
  >('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeSection, setActiveSection] = useState<ActiveSection>('radar');

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

  // Paper Trading Ledger State (SQLite Persisted, Strictly PAPER ONLY)
  const [paperLedger, setPaperLedger] = useState<PaperLedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState<boolean>(false);

  // Notification & Background Scheduler State
  const [notificationHistory, setNotificationHistory] = useState<
    NotificationDispatchRecord[]
  >([]);
  const [notifyLoading, setNotifyLoading] = useState<boolean>(false);
  const [schedulerStatus, setSchedulerStatus] =
    useState<BackgroundSchedulerStatus | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState<boolean>(false);

  // Phase 3: Full-Market SMC Background Queue Status
  const [smcScanStatus, setSmcScanStatus] =
    useState<SmcScanStatusResponse | null>(null);
  const [smcQueueLoading, setSmcQueueLoading] = useState<boolean>(false);
  const [systemDbHealth, setSystemDbHealth] =
    useState<SystemDatabaseHealthResponse | null>(null);
  const [dbCheckLoading, setDbCheckLoading] = useState<boolean>(false);

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

  // 1. Execute Full Market Scan
  const executeMarketScan = useCallback(
    async (
      overrideMode?: 'live' | 'demo',
      overrideExchange?: ExchangeId,
      enqueueSmc = false
    ) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;

      setScanLoading(true);
      setScanError(null);

      try {
        const params = new URLSearchParams({
          mode: targetMode,
          exchange: targetExchange,
          minQuoteVolume24h: String(minQuoteVolume24h),
          // 頁面載入與切換交易所只拉行情。全市場 SMC 要由手動掃描或 SMC 啟動鈕觸發。
          autoStartSmc: enqueueSmc ? 'true' : 'false',
        });
        const res = await fetch(`/api/scan?${params.toString()}`);
        setLastHttpStatus(res.status);
        const data = (await res.json()) as MarketScanResponse;

        setScanData(data);
        if (data.smcScanStatus) {
          setSmcScanStatus(data.smcScanStatus);
        }
        fetch(
          `/api/system/database-health?mode=${targetMode}&exchange=${targetExchange}`
        )
          .then((dbRes) => (dbRes.ok ? dbRes.json() : null))
          .then((dbData) => {
            if (dbData) {
              setSystemDbHealth(dbData as SystemDatabaseHealthResponse);
            }
          })
          .catch(() => {});
        if (!res.ok || data.apiError) {
          setSymbolDetail(null);
          setScanError(
            data.apiErrorDetail
              ? `${data.apiError || '即時資料不可用'} (${data.apiErrorDetail})`
              : data.apiError || '即時資料不可用'
          );
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : '網路連線失敗，無法取得行情';
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
        setScanLoading(false);
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
          fetch(`/api/symbol/${encodeURIComponent(symbol)}?${params.toString()}`),
          fetch(
            `/api/symbol/${encodeURIComponent(symbol)}/decision-trace?${params.toString()}`
          ),
        ]);
        const data = await res.json();

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
          setDecisionTraceData(traceJson);
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
        const msg =
          err instanceof Error ? err.message : '載入單一幣種 K 線與 OI 失敗';
        setDetailError(`即時資料不可用：${msg}`);
        setSymbolDetail(null);
        setDecisionTraceData(null);
      } finally {
        setDetailLoading(false);
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
            includeWalkForward: true,
            writeToPaperLedger,
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
      } catch (err) {
        setBacktestError(
          err instanceof Error ? err.message : '呼叫 /api/backtest 失敗'
        );
      } finally {
        setBacktestLoading(false);
      }
    },
    [dataMode, selectedExchange, fetchBacktestReports]
  );

  // 6. Paper Trading Ledger Actions (Strictly PAPER ONLY)
  const fetchPaperLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      const res = await fetch('/api/paper-ledger');
      if (res.ok) {
        const data = await res.json();
        setPaperLedger(data.entries || []);
      }
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  const recordPaperObservation = useCallback(async () => {
    if (!symbolDetail) return;
    const { candidate, smcAnalysis } = symbolDetail;
    const atr = smcAnalysis.atr14 ?? candidate.lastPrice * 0.015;
    const side: 'LONG' | 'SHORT' =
      smcAnalysis.actionState === 'SHORT CANDIDATE' ||
      candidate.category === '空頭候選'
        ? 'SHORT'
        : 'LONG';

    const entryPrice = candidate.lastPrice;
    const invalidationPrice =
      side === 'LONG'
        ? Number((entryPrice - atr * 1.5).toPrecision(6))
        : Number((entryPrice + atr * 1.5).toPrecision(6));
    const targetPrice =
      side === 'LONG'
        ? Number((entryPrice + atr * 2.5).toPrecision(6))
        : Number((entryPrice - atr * 2.5).toPrecision(6));

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
        entryPrice,
        invalidationPrice,
        targetPrice,
        ruleVersion: smcAnalysis.ruleVersion,
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
      setPaperLedger(data.entries || []);
      setActiveSection('paper_ledger');
    }
  }, [symbolDetail, selectedExchange]);

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
        setPaperLedger(data.entries || []);
      }
    },
    []
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

  const fetchSystemDbHealth = useCallback(
    async (overrideMode?: 'live' | 'demo', overrideExchange?: ExchangeId) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      try {
        const res = await fetch(
          `/api/system/database-health?mode=${targetMode}&exchange=${targetExchange}`
        );
        if (res.ok) {
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
        setSystemDbHealth((await res.json()) as SystemDatabaseHealthResponse);
      }
    } finally {
      setDbCheckLoading(false);
    }
  }, [dataMode, selectedExchange]);

  const fetchSmcScanStatus = useCallback(
    async (overrideMode?: 'live' | 'demo', overrideExchange?: ExchangeId) => {
      const targetMode = overrideMode ?? dataMode;
      const targetExchange = overrideExchange ?? selectedExchange;
      try {
        const res = await fetch(
          `/api/smc-scan/status?mode=${targetMode}&exchange=${targetExchange}`
        );
        if (res.ok) {
          setSmcScanStatus((await res.json()) as SmcScanStatusResponse);
        }
        void fetchSystemDbHealth(targetMode, targetExchange);
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
            await executeMarketScan(dataMode, selectedExchange, true);
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
      try {
        const [
          statusRes,
          reportRes,
          windowReportRes,
          healthRes,
          signalsRes,
          outboxRes,
          qGateRes,
          qReasonRes,
          qHistoryRes,
          qLatencyRes,
          qReport7dRes,
          qReport30dRes,
          pqStatusRes,
          pqDriftRes,
          pqRegimesRes,
        ] = await Promise.all([
          fetch(`/api/paper-monitor/status?exchange=${ex}`),
          fetch(`/api/paper-monitor/report?window=${win}&exchange=${ex}`),
          fetch(`/api/paper-monitor/window-report?exchange=${ex}`),
          fetch(`/api/paper-monitor/health?exchange=${ex}`),
          fetch(`/api/paper-monitor/signals?exchange=${ex}&limit=50`),
          fetch(`/api/notification-sandbox/outbox?limit=50`),
          fetch(`/api/smc-quality/gate-stats?exchange=${ex}`),
          fetch(`/api/smc-quality/reason-stats?exchange=${ex}`),
          fetch(`/api/smc-quality/cycle-history?exchange=${ex}&limit=20`),
          fetch(`/api/smc-quality/signal-latency?exchange=${ex}`),
          fetch(`/api/smc-quality/report?window=7d&exchange=${ex}`),
          fetch(`/api/smc-quality/report?window=30d&exchange=${ex}`),
          fetch(`/api/paper-quality/status?exchange=${ex}`),
          fetch(`/api/paper-quality/gate-drift?exchange=${ex}`),
          fetch(`/api/paper-quality/market-regimes?window=30d&exchange=${ex}`),
        ]);
        if (statusRes.ok) {
          setPaperMonitorStatus(
            (await statusRes.json()) as PaperMonitorStatusResponse
          );
        }
        if (reportRes.ok) {
          setPaperMonitorReport(
            (await reportRes.json()) as PaperMonitorReportResponse
          );
        }
        if (windowReportRes.ok) {
          setPaperWindowReport(
            (await windowReportRes.json()) as Phase7MonitoringWindowReport
          );
        }
        if (healthRes.ok) {
          setPaperMonitorHealth(
            (await healthRes.json()) as PaperMonitorHealthResponse
          );
        }
        if (signalsRes.ok) {
          const sData = await signalsRes.json();
          setPaperTrackedSignals(sData.signals || []);
        }
        if (outboxRes.ok) {
          const oData = await outboxRes.json();
          setNotificationOutbox(oData.outbox || oData.entries || []);
        }
        if (qGateRes.ok) {
          setSmcQualityGateStats(
            (await qGateRes.json()) as SmcQualityGateStatsResponse
          );
        }
        if (qReasonRes.ok) {
          setSmcQualityReasonStats(
            (await qReasonRes.json()) as SmcQualityReasonStatsResponse
          );
        }
        if (qHistoryRes.ok) {
          setSmcQualityCycleHistory(
            (await qHistoryRes.json()) as SmcQualityCycleHistoryResponse
          );
        }
        if (qLatencyRes.ok) {
          setSmcQualitySignalLatency(
            (await qLatencyRes.json()) as SmcQualitySignalLatencyResponse
          );
        }
        if (qReport7dRes.ok) {
          setSmcQualityReport7d(
            (await qReport7dRes.json()) as SmcQualityWindowReportResponse
          );
        }
        if (qReport30dRes.ok) {
          setSmcQualityReport30d(
            (await qReport30dRes.json()) as SmcQualityWindowReportResponse
          );
        }
        if (pqStatusRes.ok) {
          setPaperQualityStatus(
            (await pqStatusRes.json()) as PaperQualityStatusResponse
          );
        }
        if (pqDriftRes.ok) {
          setPaperQualityGateDrift(
            (await pqDriftRes.json()) as PaperQualityGateDriftResponse
          );
        }
        if (pqRegimesRes.ok) {
          setPaperQualityRegimes(
            (await pqRegimesRes.json()) as PaperQualityMarketRegimesResponse
          );
        }
      } catch {
        // ignore network errors during background refresh
      }
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

  // Initial load: executeMarketScan returns both scanData and smcScanStatus from the same atomic snapshot
  useEffect(() => {
    executeMarketScan();
    fetchPaperLedger();
    fetchBacktestReports();
    fetchSchedulerStatus();
    fetchPaperMonitorAll();
    fetchSystemDbHealth();
  }, [
    executeMarketScan,
    fetchPaperLedger,
    fetchBacktestReports,
    fetchSchedulerStatus,
    fetchPaperMonitorAll,
    fetchSystemDbHealth,
  ]);

  // Poll SMC background queue status when workerState is RUNNING
  useEffect(() => {
    if (smcScanStatus?.workerState !== 'RUNNING') return;
    const id = setInterval(() => {
      void fetchSmcScanStatus();
    }, 3500);
    return () => clearInterval(id);
  }, [smcScanStatus?.workerState, fetchSmcScanStatus]);

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

  const filteredCandidates = useMemo(() => {
    if (!scanData || scanData.apiError) return [];
    return scanData.candidates.filter((c) => {
      if (categoryFilter === 'WATCHLIST' && !watchlist.includes(c.symbol)) {
        return false;
      }
      if (categoryFilter === '雷達多頭觀察' || categoryFilter === '多頭候選') {
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
      if (
        searchQuery.trim() !== '' &&
        !c.symbol.toLowerCase().includes(searchQuery.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [scanData, categoryFilter, searchQuery, watchlist]);

  const switchToExplicitDemoMode = () => {
    if (dataMode === 'demo' && selectedExchange === 'demo_synthetic') {
      void executeMarketScan('demo', 'demo_synthetic');
      return;
    }
    setDataMode('demo');
    setSelectedExchange('demo_synthetic');
  };

  const switchToLiveExchange = (exId: ExchangeId) => {
    if (dataMode === 'live' && selectedExchange === exId) {
      void executeMarketScan('live', exId);
      return;
    }
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
        <div className="sticky top-0 z-40 border-b border-rose-500/40 bg-rose-950/90 px-6 py-2.5 text-amber-200 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 text-xs">
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

      {/* Apple Frosted-Glass Top Header: Strictly 3 zones separated by gap-8 */}
      <header className="apple-glass-header sticky top-0 z-30 flex items-center justify-between gap-8 px-6 py-3.5">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#radar"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('radar');
          }}
          className="text-[17px] font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          加密貨幣全市場行情雷達
        </a>

        {/* Zone 2: Apple Segmented Navigation Bar */}
        <nav className="apple-segmented-track hidden md:flex items-center gap-1 text-xs font-medium text-slate-400">
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

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => executeMarketScan(undefined, undefined, true)}
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
      <div className="border-b border-white/[0.08] bg-slate-950/60 px-6 py-2 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 text-xs">
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
            <span className="font-sans text-slate-400 hidden xl:inline">
              Phase 2：Binance / Bybit / BingX 跨所掃描、歷史量能異常 (Median/MAD/Z/RVOL)、SQLite 紙上帳本與回測報表
            </span>
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
        <div className="border-b border-rose-500/40 bg-rose-950/60 px-6 py-4 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4">
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
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-6 py-7 flex flex-col gap-6">
        {/* Apple Segmented Workspace Control Bar (order-1) */}
        <section className="apple-bento-card order-1 flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
          {/* Left: Exchange Adapter & Mode Selector */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="apple-segmented-track flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => switchToLiveExchange('binance_usdm')}
                className={`px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  dataMode === 'live' && selectedExchange === 'binance_usdm'
                    ? 'apple-segmented-pill-active font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Binance USDⓈ-M (LIVE)
              </button>
              <button
                type="button"
                onClick={() => switchToLiveExchange('bybit_linear')}
                className={`px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  dataMode === 'live' && selectedExchange === 'bybit_linear'
                    ? 'apple-segmented-pill-active font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Bybit Linear (LIVE)
              </button>
              <button
                type="button"
                onClick={() => switchToLiveExchange('bingx_swap')}
                className={`px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  dataMode === 'live' && selectedExchange === 'bingx_swap'
                    ? 'apple-segmented-pill-active font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                BingX Swap (LIVE)
              </button>
              <button
                type="button"
                onClick={switchToExplicitDemoMode}
                className={`px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                  dataMode === 'demo'
                    ? 'apple-segmented-pill-active text-amber-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                切換 Demo 驗證模式 (DEMO_ONLY)
              </button>
            </div>

            {/* Minimum 24h Quote Volume Filter */}
            <div className="flex items-center gap-2 text-xs">
              <label
                htmlFor="min-vol-select"
                className="text-slate-400 whitespace-nowrap"
              >
                最低 24h 成交額:
              </label>
              <select
                id="min-vol-select"
                value={minQuoteVolume24h}
                onChange={(e) => setMinQuoteVolume24h(Number(e.target.value))}
                className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-200 focus:border-amber-500 focus:outline-none"
              >
                <option value={0}>全部標的 ($0+)</option>
                <option value={15_000_000}>≥ $1,500萬 (排除低流動性)</option>
                <option value={50_000_000}>≥ $5,000萬 (50M USDT)</option>
                <option value={100_000_000}>≥ $1億 (100M USDT)</option>
                <option value={500_000_000}>≥ $5億 (500M USDT)</option>
              </select>
            </div>

            {/* Primary Timeframe Selector */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400 whitespace-nowrap">結構週期:</span>
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
            </div>
          </div>

          {/* Right: Theme Switcher (Apple Space Black vs Studio Silver) + Search Symbol */}
          <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            <div className="apple-segmented-track flex items-center gap-1">
              <button
                type="button"
                onClick={() => setThemeMode('dark')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                  themeMode === 'dark'
                    ? 'apple-segmented-pill-active font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Moon className="h-3.5 w-3.5" />
                <span>深色專業</span>
              </button>
              <button
                type="button"
                onClick={() => setThemeMode('light')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                  themeMode === 'light'
                    ? 'apple-segmented-pill-active font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sun className="h-3.5 w-3.5" />
                <span>淺色白晝</span>
              </button>
            </div>

            <div className="relative flex-1 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋幣種 (例如 SOL, SUI, BTC)..."
                className="w-full rounded-xl border border-slate-800 bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>
        </section>

        {/* Apple Bento Summary Grid + Plain-Language Market Weather & Top 3 Focus Cards (order-2) */}
        <section className="order-2 space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <button
              type="button"
              onClick={() => {
                setCategoryFilter(
                  categoryFilter === '雷達多頭觀察' ? 'ALL' : '雷達多頭觀察'
                );
                setActiveSection('radar');
              }}
              className={`apple-bento-card text-left p-5 cursor-pointer relative overflow-hidden group ${
                categoryFilter === '雷達多頭觀察' ||
                categoryFilter === '多頭候選'
                  ? 'ring-1 ring-emerald-500/60 bg-emerald-500/[0.04]'
                  : ''
              }`}
            >
              <div className="text-xs font-medium text-slate-400 group-hover:text-slate-300 transition-colors">
                第一層：雷達多頭觀察 (Radar Long)
              </div>
              <div className="mt-2 text-3xl font-semibold tracking-tight font-mono tabular-nums text-emerald-400">
                {scanData?.marketRadarLongCount ??
                  scanData?.marketRadarCounts?.['雷達多頭觀察'] ??
                  0}
              </div>
              <div className="mt-2 text-[11px] text-slate-400 font-mono">
                最終多頭候選: {scanData?.summaryCounts['多頭候選'] ?? 0} · SMC
                LONG: {scanData?.smcLongCandidateCount ?? 0}
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setCategoryFilter(
                  categoryFilter === '雷達空頭觀察' ? 'ALL' : '雷達空頭觀察'
                );
                setActiveSection('radar');
              }}
              className={`apple-bento-card text-left p-5 cursor-pointer relative overflow-hidden group ${
                categoryFilter === '雷達空頭觀察' ||
                categoryFilter === '空頭候選'
                  ? 'ring-1 ring-rose-500/60 bg-rose-500/[0.04]'
                  : ''
              }`}
            >
              <div className="text-xs font-medium text-slate-400 group-hover:text-slate-300 transition-colors">
                第一層：雷達空頭觀察 (Radar Short)
              </div>
              <div className="mt-2 text-3xl font-semibold tracking-tight font-mono tabular-nums text-rose-400">
                {scanData?.marketRadarShortCount ??
                  scanData?.marketRadarCounts?.['雷達空頭觀察'] ??
                  0}
              </div>
              <div className="mt-2 text-[11px] text-slate-400 font-mono">
                最終空頭候選: {scanData?.summaryCounts['空頭候選'] ?? 0} · SMC
                SHORT: {scanData?.smcShortCandidateCount ?? 0}
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setCategoryFilter(
                  categoryFilter === '準備觀察' ? 'ALL' : '準備觀察'
                );
                setActiveSection('radar');
              }}
              className={`apple-bento-card text-left p-5 cursor-pointer relative overflow-hidden group ${
                categoryFilter === '準備觀察'
                  ? 'ring-1 ring-sky-500/60 bg-sky-500/[0.04]'
                  : ''
              }`}
            >
              <div className="text-xs font-medium text-slate-400 group-hover:text-slate-300 transition-colors">
                準備觀察 (Prepare)
              </div>
              <div className="mt-2 text-3xl font-semibold tracking-tight font-mono tabular-nums text-sky-300">
                {scanData?.marketRadarCounts?.['準備觀察'] ??
                  scanData?.summaryCounts['準備觀察'] ??
                  0}
              </div>
              <div className="mt-2 text-[11px] text-slate-400 font-mono">
                含基線降級準備觀察: {scanData?.summaryCounts['準備觀察'] ?? 0}
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setCategoryFilter(
                  categoryFilter === '高風險' ? 'ALL' : '高風險'
                );
                setActiveSection('radar');
              }}
              className={`apple-bento-card text-left p-5 cursor-pointer relative overflow-hidden group ${
                categoryFilter === '高風險'
                  ? 'ring-1 ring-amber-500/60 bg-amber-500/[0.04]'
                  : ''
              }`}
            >
              <div className="text-xs font-medium text-slate-400 group-hover:text-slate-300 transition-colors">
                高風險 (High Risk)
              </div>
              <div className="mt-2 text-3xl font-semibold tracking-tight font-mono tabular-nums text-amber-400">
                {scanData?.summaryCounts['高風險'] ?? 0}
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                極端費率 · 低流動性高波動
              </div>
            </button>

            <div className="apple-bento-card p-5 relative overflow-hidden">
              <div className="text-xs font-medium text-slate-400">
                BTC 24h 基準 / 低流動性數
              </div>
              <div className="mt-2 text-3xl font-semibold tracking-tight font-mono tabular-nums text-slate-100">
                {scanData?.btcBenchmarkChange24h !== null &&
                scanData?.btcBenchmarkChange24h !== undefined
                  ? `${scanData.btcBenchmarkChange24h >= 0 ? '+' : ''}${scanData.btcBenchmarkChange24h.toFixed(2)}%`
                  : 'N/A'}
              </div>
              <div className="mt-2 text-[11px] font-mono text-slate-400 truncate">
                低流動性: {scanData?.liquidityRejectedCount ?? 0} 檔 ·{' '}
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilter(
                      categoryFilter === 'WATCHLIST' ? 'ALL' : 'WATCHLIST'
                    );
                    setActiveSection('radar');
                  }}
                  className="underline text-amber-300 cursor-pointer"
                >
                  觀察清單({watchlist.length})
                </button>
              </div>
            </div>
          </div>

          {/* Apple Bento: Plain-Language Market Weather Banner + 5-Stage Funnel + Top 3 Focus Cards */}
          {activeSection === 'radar' && scanData && !scanError && (
            <div className="apple-bento-card p-6 space-y-4">
              {(() => {
                const scanCycle = scanData.cycleId ?? scanData.scanCycleId ?? null;
                const smcCycle =
                  smcScanStatus?.cycleId ?? smcScanStatus?.scanCycleId ?? null;
                const scanSnap = scanData.snapshotAt ?? null;
                const smcSnap = smcScanStatus?.snapshotAt ?? null;
                const scanVer = scanData.statsVersion ?? null;
                const smcVer = smcScanStatus?.statsVersion ?? null;
                const hasSnapshotMismatch =
                  dataMode === 'live' &&
                  Boolean(scanCycle && smcCycle) &&
                  (scanCycle !== smcCycle ||
                    (scanVer !== null && smcVer !== null && scanVer !== smcVer) ||
                    (scanSnap !== null &&
                      smcSnap !== null &&
                      scanSnap !== smcSnap));
                const funnel =
                  scanData.candidateFunnel ?? smcScanStatus?.candidateFunnel;
                const gateDiag =
                  scanData.smcGateDiagnostics ??
                  smcScanStatus?.smcGateDiagnostics;
                const scopedStats =
                  scanData.scopedGateStatistics ??
                  smcScanStatus?.scopedGateStatistics ??
                  gateDiag?.scopedGateStatistics;
                const shadowComp =
                  scanData.observationShadowComparison ??
                  smcScanStatus?.observationShadowComparison ??
                  gateDiag?.observationShadowComparison;
                const smcCandTotal =
                  (scanData.smcLongCandidateCount ?? 0) +
                  (scanData.smcShortCandidateCount ?? 0);
                const nearMissTotal =
                  gateDiag?.nearMissCount ??
                  funnel?.nearMissCount ??
                  scanData.nearMissCount ??
                  0;
                const nearMiss1 =
                  gateDiag?.nearMissMissing1Count ??
                  funnel?.nearMissOneGateCount ??
                  scanData.nearMissMissing1Count ??
                  0;
                const nearMiss2 =
                  gateDiag?.nearMissMissing2Count ??
                  funnel?.nearMissTwoGatesCount ??
                  scanData.nearMissMissing2Count ??
                  0;
                const blockedByPaper =
                  scanData.blockedByPaperEligibilityCount ??
                  smcScanStatus?.blockedByPaperEligibilityCount ??
                  0;
                const eligiblePaper =
                  scanData.eligiblePaperSignalCount ??
                  smcScanStatus?.eligiblePaperSignalCount ??
                  0;
                const missedWindow =
                  scanData.entryWindowMissedCount ??
                  smcScanStatus?.entryWindowMissedCount ??
                  0;
                const paperOpened =
                  scanData.paperOpenedCount ??
                  smcScanStatus?.paperOpenedCount ??
                  0;
                const paperClosed =
                  scanData.paperClosedCount ??
                  smcScanStatus?.paperClosedCount ??
                  funnel?.paperClosedCount ??
                  0;
                const formalCandidateList = scanData.candidates.filter(
                  (c) =>
                    c.smcEvaluationStatus === 'EVALUATED' &&
                    (c.smcActionState === 'LONG CANDIDATE' ||
                      c.smcActionState === 'SHORT CANDIDATE')
                );
                const nearMissCandidateList = scanData.candidates.filter(
                  (c) =>
                    c.nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
                    c.nearMissStatus === 'NEAR_MISS_TWO_GATES' ||
                    c.gateEvaluation?.nearMissStatus === 'NEAR_MISS_ONE_GATE' ||
                    c.gateEvaluation?.nearMissStatus === 'NEAR_MISS_TWO_GATES'
                );

                return (
                  <div className="space-y-4 border-b border-slate-800/80 pb-4">
                    {hasSnapshotMismatch && (
                      <div className="rounded-xl border border-rose-500/60 bg-rose-950/70 px-4 py-2.5 text-xs font-semibold text-rose-200 flex items-center justify-between gap-3">
                        <span>
                          ⚠️ 不同時間快照，不可直接比較（/api/scan cycleId={scanCycle} vs /api/smc-scan/status cycleId={smcCycle}）
                        </span>
                        <button
                          type="button"
                          onClick={() => executeMarketScan()}
                          className="rounded border border-rose-400/50 bg-rose-900/50 px-2.5 py-1 text-[11px] text-rose-100 hover:bg-rose-800 cursor-pointer"
                        >
                          同步最新快照
                        </button>
                      </div>
                    )}

                    {/* Phase 18.2: Mandatory Notices Banner */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                      <span className="rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-0.5 text-emerald-300">
                        {smcCandTotal === 0
                          ? '目前週期沒有正式候選'
                          : `目前週期有 ${smcCandTotal} 檔正式候選`}
                      </span>
                      <span className="rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-2.5 py-0.5 text-rose-300">
                        歷史上曾有候選但錯過進場
                      </span>
                      <span className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-0.5 text-amber-300">
                        Near-Miss 不等於正式訊號
                      </span>
                      <span className="rounded-md border border-sky-500/25 bg-sky-500/[0.06] px-2.5 py-0.5 text-sky-300">
                        Radar Long/Short 不等於 SMC Long/Short
                      </span>
                      <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-slate-300">
                        PENDING 不等於 WAIT
                      </span>
                      <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-slate-300">
                        WAIT/WATCH 不會建立 Paper 交易
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-slate-900 px-2 py-0.5 text-slate-200 border border-slate-800">
                          快照一致性:{' '}
                          <strong
                            className={
                              hasSnapshotMismatch
                                ? 'text-rose-400'
                                : 'text-emerald-400'
                            }
                          >
                            {hasSnapshotMismatch
                              ? '不同時間快照，不可直接比較'
                              : '同週期原子快照 (CONSISTENT)'}
                          </strong>
                        </span>
                        <span>
                          cycleId:{' '}
                          <strong className="text-slate-200">
                            {scanCycle ?? smcCycle ?? '—'}
                          </strong>
                        </span>
                        <span>
                          · snapshotAt:{' '}
                          <strong className="text-slate-200">
                            {scanSnap ?? smcSnap ?? scanData.fetchedAt}
                          </strong>
                        </span>
                        <span>
                          · statsVersion:{' '}
                          <strong className="text-amber-300">
                            {scanVer ?? smcVer ?? 1}
                          </strong>
                        </span>
                      </div>
                      {gateDiag && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-slate-300">
                            Near-Miss (僅差1~2項Gate):{' '}
                            <strong className="text-amber-300">
                              {nearMissTotal} 檔
                            </strong>{' '}
                            (NEAR_MISS_ONE_GATE:{nearMiss1} / NEAR_MISS_TWO_GATES:
                            {nearMiss2})
                          </span>
                          <span>
                            · 最常見阻擋 Gate:{' '}
                            <strong className="text-sky-300">
                              {gateDiag.lastBlockingGate ?? 'MTF_ALIGNMENT'}
                            </strong>
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Phase 18 Section 七: 7-Stage Signal Funnel Bar */}
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
                        <span className="font-semibold text-slate-200">
                          完整訊號漏斗追蹤：Radar 觀察 → SMC 已評估 → Near-Miss → 正式 SMC 候選 → Paper Eligible → Paper Opened → Paper Closed
                        </span>
                        <span className="font-mono text-[11px] text-slate-400">
                          ENTRY_WINDOW_MISSED: {missedWindow} · BLOCKED: {blockedByPaper}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 font-mono text-xs">
                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                          <div className="font-sans text-[11px] text-slate-400">
                            1. Radar 觀察 (1. 第一層雷達觀察)
                          </div>
                          <div className="mt-1 text-base font-bold text-slate-100">
                            {(scanData.marketRadarLongCount ?? 0) +
                              (scanData.marketRadarShortCount ?? 0)}{' '}
                            檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            Radar Long {scanData.marketRadarLongCount ?? 0} · Short{' '}
                            {scanData.marketRadarShortCount ?? 0}
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                          <div className="font-sans text-[11px] text-slate-400">
                            2. SMC 已評估 (2. 第二層 SMC 已評估)
                          </div>
                          <div className="mt-1 text-base font-bold text-sky-400">
                            {funnel?.smcEvaluatedCount ??
                              (scanData.totalContractsScanned ?? 0) -
                                (scanData.smcPendingCount ?? 0)}{' '}
                            / {scanData.totalContractsScanned ?? 0}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            WAIT {scanData.smcWaitCount ?? 0} · WATCH{' '}
                            {scanData.smcWatchCount ?? 0} · HIGH RISK{' '}
                            {scanData.smcHighRiskCount ?? 0}
                          </div>
                        </div>

                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-2.5">
                          <div className="font-sans text-[11px] text-amber-300">
                            3. Near-Miss (觀察)
                          </div>
                          <div className="mt-1 text-base font-bold text-amber-400">
                            {nearMissTotal} 檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-amber-300/80">
                            差1項: {nearMiss1} · 差2項: {nearMiss2}
                          </div>
                        </div>

                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-2.5">
                          <div className="font-sans text-[11px] text-emerald-300">
                            4. 正式 SMC 候選 (3. SMC 候選)
                          </div>
                          <div className="mt-1 text-base font-bold text-emerald-400">
                            {smcCandTotal} 檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-300">
                            LONG: {scanData.smcLongCandidateCount ?? 0} · SHORT:{' '}
                            {scanData.smcShortCandidateCount ?? 0}
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                          <div className="font-sans text-[11px] text-slate-400">
                            5. Paper Eligible (4. Paper 合格訊號)
                          </div>
                          <div className="mt-1 text-base font-bold text-amber-400">
                            {eligiblePaper} 檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            BLOCKED: {blockedByPaper} 檔
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                          <div className="font-sans text-[11px] text-slate-400">
                            6. Paper Opened (5. 已錯過進場窗口)
                          </div>
                          <div className="mt-1 text-base font-bold text-emerald-400">
                            {paperOpened} 檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-rose-300">
                            MISSED: {missedWindow} 檔
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                          <div className="font-sans text-[11px] text-slate-400">
                            7. Paper Closed
                          </div>
                          <div className="mt-1 text-base font-bold text-slate-100">
                            {paperClosed} 檔
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            已結算部位數
                          </div>
                        </div>
                      </div>

                      {/* Phase 18.2: Explicit Three-Scope Separation (目前週期 / 監控視窗 / 歷史累計) */}
                      <div className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-3 font-mono text-[11px]">
                        <div className="rounded-xl border border-emerald-500/25 bg-slate-950/70 px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between text-emerald-300 font-semibold">
                            <span>目前週期 (CURRENT_CYCLE)</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] ${
                                (scanData.statsConsistency ??
                                  funnel?.statsConsistency ??
                                  'VALID') === 'VALID'
                                  ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-rose-950/70 text-rose-300 border border-rose-500/50'
                              }`}
                            >
                              {scanData.statsConsistency ??
                                funnel?.statsConsistency ??
                                'VALID'}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-300">
                            <span>
                              formalCandidateCount={' '}
                              <strong className="text-emerald-300">
                                {scanData.formalCandidateCount ??
                                  funnel?.formalCandidateCount ??
                                  smcCandTotal}
                              </strong>
                            </span>
                            <span>
                              currentCyclePaperEligibleCount={' '}
                              <strong className="text-emerald-300">
                                {scanData.currentCyclePaperEligibleCount ??
                                  funnel?.currentCyclePaperEligibleCount ??
                                  eligiblePaper}
                              </strong>
                            </span>
                            <span>
                              currentCycleEntryWindowMissedCount={' '}
                              <strong className="text-slate-100">
                                {scanData.currentCycleEntryWindowMissedCount ??
                                  funnel?.currentCycleEntryWindowMissedCount ??
                                  missedWindow}
                              </strong>
                            </span>
                          </div>
                        </div>

                        <div className="rounded-xl border border-amber-500/25 bg-slate-950/70 px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between text-amber-300 font-semibold">
                            <span>監控視窗 (30D/60D/90D · OUTSIDE_CURRENT_CYCLE)</span>
                            <span className="text-[10px] text-slate-400">
                              RAYSOL / ALGO 等
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-300">
                            <span>
                              monitoringWindowPaperEligibleCount={' '}
                              <strong className="text-amber-300">
                                {scanData.monitoringWindowPaperEligibleCount ??
                                  funnel?.monitoringWindowPaperEligibleCount ??
                                  scanData.monitoringWindowFunnel?.paperEligibleCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              monitoringWindowEntryWindowMissedCount={' '}
                              <strong className="text-amber-300">
                                {scanData.monitoringWindowEntryWindowMissedCount ??
                                  funnel?.monitoringWindowEntryWindowMissedCount ??
                                  0}
                              </strong>
                            </span>
                          </div>
                        </div>

                        <div className="rounded-xl border border-sky-500/25 bg-slate-950/70 px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between text-sky-300 font-semibold">
                            <span>歷史累計 (CUMULATIVE / OUTSIDE_MONITORING_WINDOW)</span>
                            <span className="text-[10px] text-slate-400">
                              分母{' '}
                              {scanData.evaluatedDenominator ??
                                funnel?.evaluatedDenominator ??
                                0}
                              /
                              {scanData.evaluationUniverseSize ??
                                funnel?.evaluationUniverseSize ??
                                scanData.totalContractsScanned ??
                                0}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-300">
                            <span>
                              cumulativePaperEligibleCount={' '}
                              <strong className="text-sky-300">
                                {scanData.cumulativePaperEligibleCount ??
                                  funnel?.cumulativePaperEligibleCount ??
                                  scanData.cumulativeFunnel?.paperEligibleCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              cumulativeEntryWindowMissedCount={' '}
                              <strong className="text-slate-100">
                                {scanData.cumulativeEntryWindowMissedCount ??
                                  funnel?.cumulativeEntryWindowMissedCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              historicalSignalsOutsideWindowCount={' '}
                              <strong className="text-rose-300">
                                {scanData.historicalSignalsOutsideWindowCount ??
                                  funnel?.historicalSignalsOutsideWindowCount ??
                                  scanData.historicalSignalsOutsideWindow?.count ??
                                  0}
                              </strong>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Phase 18.3 Section 五: 正式候選捕捉效率 (Demo Fixture SLA vs Live 實際 SLA 分離) */}
                    <div
                      data-testid="phase18-3-capture-efficiency-panel"
                      className="rounded-2xl border border-indigo-500/30 bg-slate-900/80 p-3.5 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-indigo-300">
                          正式候選捕捉效率 (Phase 18.3 · 15m 收盤事件觸發 Fast Lane / Live 與 Demo 證據嚴格分離)
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                          <span className="rounded-md bg-emerald-950/70 px-2 py-0.5 text-emerald-300 border border-emerald-500/40">
                            Demo SLA 不等於 Live SLA。
                          </span>
                          <span className="rounded-md bg-amber-950/70 px-2 py-0.5 text-amber-300 border border-amber-500/40">
                            Near-Miss 不等於正式訊號。
                          </span>
                          <span className="rounded-md bg-sky-950/70 px-2 py-0.5 text-sky-300 border border-sky-500/40">
                            Radar Long/Short 不等於 SMC LONG/SHORT。
                          </span>
                          <span className="rounded-md bg-slate-950/90 px-2 py-0.5 text-slate-300 border border-white/15">
                            沒有正式候選時，延遲統計為 null。
                          </span>
                          <span className="rounded-md bg-rose-950/70 px-2 py-0.5 text-rose-300 border border-rose-500/40">
                            ENTRY_WINDOW_MISSED 不得建立回溯 Paper 部位。
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-4 text-[11px] font-mono">
                        {/* 1. Demo Fixture SLA */}
                        <div className="rounded-xl border border-violet-500/25 bg-slate-950/75 px-3 py-2.5 space-y-1">
                          <div className="flex items-center justify-between text-violet-300 font-semibold">
                            <span>Demo Fixture SLA</span>
                            <span className="rounded bg-violet-950/80 px-1.5 py-0.5 text-[10px] text-violet-200 border border-violet-500/35">
                              {scanData.DEMO_LATENCY_FIXTURE?.evidenceType ??
                                'DEMO_LATENCY_FIXTURE'}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-300">
                            <span>
                              候選數={' '}
                              <strong className="text-violet-300">
                                {scanData.DEMO_LATENCY_FIXTURE
                                  ?.formalCandidateCount ?? 2}
                              </strong>
                            </span>
                            <span>
                              進場前偵測={' '}
                              <strong className="text-emerald-300">
                                {scanData.DEMO_LATENCY_FIXTURE
                                  ?.detectedBeforeEntryWindowCount ?? 2}
                              </strong>
                            </span>
                            <span>
                              P50={' '}
                              <strong className="text-slate-100">
                                {scanData.DEMO_LATENCY_FIXTURE
                                  ?.detectionLatencyP50 !== undefined &&
                                scanData.DEMO_LATENCY_FIXTURE
                                  ?.detectionLatencyP50 !== null
                                  ? `${scanData.DEMO_LATENCY_FIXTURE.detectionLatencyP50}ms`
                                  : 'null'}
                              </strong>
                            </span>
                            <span>
                              P95={' '}
                              <strong className="text-slate-100">
                                {scanData.DEMO_LATENCY_FIXTURE
                                  ?.detectionLatencyP95 !== undefined &&
                                scanData.DEMO_LATENCY_FIXTURE
                                  ?.detectionLatencyP95 !== null
                                  ? `${scanData.DEMO_LATENCY_FIXTURE.detectionLatencyP95}ms`
                                  : 'null'}
                              </strong>
                            </span>
                          </div>
                        </div>

                        {/* 2. Live 實際 SLA */}
                        <div className="rounded-xl border border-emerald-500/25 bg-slate-950/75 px-3 py-2.5 space-y-1">
                          <div className="flex items-center justify-between text-emerald-300 font-semibold">
                            <span>Live 實際 SLA</span>
                            <span className="text-[10px] text-slate-400">
                              LIVE_FORMAL_CANDIDATE_COUNT={' '}
                              {scanData.LIVE_FORMAL_CANDIDATE_COUNT ??
                                funnel?.LIVE_FORMAL_CANDIDATE_COUNT ??
                                0}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-300">
                            <span>
                              進場前偵測={' '}
                              <strong className="text-emerald-300">
                                {scanData.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT ??
                                  funnel?.LIVE_DETECTED_BEFORE_ENTRY_WINDOW_COUNT ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              LIVE_P50={' '}
                              <strong className="text-slate-100">
                                {scanData.LIVE_DETECTION_LATENCY_P50 !==
                                  undefined &&
                                scanData.LIVE_DETECTION_LATENCY_P50 !== null
                                  ? `${scanData.LIVE_DETECTION_LATENCY_P50}ms`
                                  : 'null'}
                              </strong>
                            </span>
                            <span>
                              LIVE_P95={' '}
                              <strong className="text-slate-100">
                                {scanData.LIVE_DETECTION_LATENCY_P95 !==
                                  undefined &&
                                scanData.LIVE_DETECTION_LATENCY_P95 !== null
                                  ? `${scanData.LIVE_DETECTION_LATENCY_P95}ms`
                                  : 'null'}
                              </strong>
                            </span>
                          </div>
                        </div>

                        {/* 3. Fast Lane vs Bulk Queue */}
                        <div className="rounded-xl border border-sky-500/25 bg-slate-950/75 px-3 py-2.5 space-y-1">
                          <div className="flex items-center justify-between text-sky-300 font-semibold">
                            <span>Fast Lane vs Bulk Queue</span>
                            <span className="text-[10px] text-slate-400">
                              15m 收盤優先佇列
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-300">
                            <span>
                              Fast Lane={' '}
                              <strong className="text-emerald-300">
                                {scanData.LIVE_FAST_LANE_COUNT ??
                                  scanData.fastLaneFormalCandidateCount ??
                                  0}
                              </strong>{' '}
                              (P50:{' '}
                              {scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P50 !==
                                undefined &&
                              scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P50 !==
                                null
                                ? `${scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P50}ms`
                                : 'null'}
                              , P95:{' '}
                              {scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P95 !==
                                undefined &&
                              scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P95 !==
                                null
                                ? `${scanData.LIVE_FAST_LANE_DETECTION_LATENCY_P95}ms`
                                : 'null'}
                              )
                            </span>
                            <span>
                              Bulk Queue={' '}
                              <strong className="text-amber-300">
                                {scanData.LIVE_BULK_COUNT ??
                                  scanData.bulkFormalCandidateCount ??
                                  0}
                              </strong>{' '}
                              (P50:{' '}
                              {scanData.LIVE_BULK_DETECTION_LATENCY_P50 !==
                                undefined &&
                              scanData.LIVE_BULK_DETECTION_LATENCY_P50 !== null
                                ? `${scanData.LIVE_BULK_DETECTION_LATENCY_P50}ms`
                                : 'null'}
                              , P95:{' '}
                              {scanData.LIVE_BULK_DETECTION_LATENCY_P95 !==
                                undefined &&
                              scanData.LIVE_BULK_DETECTION_LATENCY_P95 !== null
                                ? `${scanData.LIVE_BULK_DETECTION_LATENCY_P95}ms`
                                : 'null'}
                              )
                            </span>
                          </div>
                        </div>

                        {/* 4. 週期與視窗 ENTRY_WINDOW_MISSED 分離 */}
                        <div className="rounded-xl border border-amber-500/25 bg-slate-950/75 px-3 py-2.5 space-y-1">
                          <div className="flex items-center justify-between text-amber-300 font-semibold">
                            <span>ENTRY_WINDOW_MISSED 範圍分離</span>
                            <span className="text-[10px] text-slate-400">
                              嚴格不回溯開盤價
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-300">
                            <span>
                              目前週期正式候選={' '}
                              <strong className="text-emerald-300">
                                {scanData.formalCandidateCount ??
                                  funnel?.formalCandidateCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              目前週期 ENTRY_WINDOW_MISSED={' '}
                              <strong className="text-slate-100">
                                {scanData.currentCycleEntryWindowMissedCount ??
                                  funnel?.currentCycleEntryWindowMissedCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              監控視窗內 ENTRY_WINDOW_MISSED={' '}
                              <strong className="text-amber-300">
                                {scanData.monitoringWindowEntryWindowMissedCount ??
                                  funnel?.monitoringWindowEntryWindowMissedCount ??
                                  0}
                              </strong>
                            </span>
                            <span>
                              歷史視窗外 ENTRY_WINDOW_MISSED={' '}
                              <strong className="text-rose-300">
                                {scanData.historicalSignalsOutsideWindow
                                  ?.entryWindowMissedCount ??
                                  scanData.historicalSignalsOutsideWindowCount ??
                                  0}
                              </strong>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Phase 18 Section 七: Three Dedicated Panels (正式候選 / 接近候選 / 目前沒有正式候選的主要原因) */}
                    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3 pt-1">
                      {/* Panel 1: 正式候選 */}
                      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-emerald-300">
                            區塊一：正式候選 (STRICT_PRODUCTION)
                          </span>
                          <span className="font-mono text-xs font-bold text-emerald-400">
                            {formalCandidateList.length} 檔
                          </span>
                        </div>
                        {formalCandidateList.length === 0 ? (
                          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs text-slate-300 leading-relaxed space-y-1.5">
                            <div>
                              <strong>目前週期沒有正式候選</strong>（formalCandidateCount=0, LONG CANDIDATE=0, SHORT CANDIDATE=0）。
                            </div>
                            <div className="text-[11px] font-mono text-slate-400">
                              <strong>歷史上曾有候選但錯過進場</strong>：監控視窗內 OUTSIDE_CURRENT_CYCLE={scanData.historicalSignalsOutsideCurrentCycleCount ?? funnel?.historicalSignalsOutsideCurrentCycleCount ?? 0} 筆 · 視窗外 OUTSIDE_MONITORING_WINDOW={scanData.historicalSignalsOutsideWindowCount ?? funnel?.historicalSignalsOutsideWindowCount ?? 0} 筆。無正式候選時延遲統計 P50/P95=null（不補 0）。
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                            {formalCandidateList.map((fc) => (
                              <button
                                key={fc.symbol}
                                type="button"
                                onClick={() =>
                                  loadSymbolDetail(fc.symbol, selectedTimeframe)
                                }
                                className="w-full text-left rounded-xl border border-emerald-500/35 bg-emerald-500/[0.06] px-3 py-2 text-xs hover:bg-emerald-500/[0.12] transition-colors cursor-pointer"
                              >
                                <div className="flex items-center justify-between font-mono">
                                  <span className="font-bold text-slate-100">
                                    {fc.symbol} · {fc.smcActionState}
                                  </span>
                                  <span className="text-emerald-300">
                                    {fc.finalTradeSignal}
                                  </span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-300">
                                  <span>Radar: {fc.marketRadarCategory}</span>
                                  <span>· 評分: {fc.score}</span>
                                  <span>
                                    · candidateDetectionLatencyMs:{' '}
                                    {fc.candidateDetectionLatencyMs ??
                                      fc.detectionLatencyMs ??
                                      'null'}
                                    ms
                                  </span>
                                  <span>
                                    · entryWindowMissed:{' '}
                                    {fc.entryWindowMissed
                                      ? 'true (MISSED)'
                                      : 'false'}
                                  </span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Panel 2: 接近候選 (Near-Miss) */}
                      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.03] p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-amber-300">
                            區塊二：接近候選 (Near-Miss · 僅供觀察)
                          </span>
                          <span className="font-mono text-xs font-bold text-amber-400">
                            {nearMissCandidateList.length} 檔 (全市場 {nearMissTotal} 檔)
                          </span>
                        </div>
                        {nearMissCandidateList.length === 0 &&
                        (gateDiag?.nearMissSymbols?.length ?? 0) === 0 ? (
                          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs text-slate-400">
                            目前無差 1～2 項條件之 Near-Miss 標的。
                          </div>
                        ) : (
                          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                            {(nearMissCandidateList.length > 0
                              ? nearMissCandidateList.slice(0, 8).map((nm) => ({
                                  symbol: nm.symbol,
                                  direction:
                                    nm.intendedDirection ??
                                    nm.gateEvaluation?.intendedDirection ??
                                    (nm.marketRadarCategory === '雷達多頭觀察'
                                      ? 'LONG'
                                      : nm.marketRadarCategory === '雷達空頭觀察'
                                        ? 'SHORT'
                                        : 'NEUTRAL'),
                                  marketRadarCategory: nm.marketRadarCategory,
                                  score: nm.score,
                                  nearMissStatus:
                                    nm.nearMissStatus ??
                                    nm.gateEvaluation?.nearMissStatus ??
                                    'NEAR_MISS_ONE_GATE',
                                  missingGates:
                                    nm.missingGates ??
                                    nm.gateEvaluation?.missingGates ??
                                    [],
                                  evaluationLatencyMs:
                                    nm.evaluationLatencyMs ??
                                    nm.smcEvaluationLatencyMs ??
                                    null,
                                  nextBarRemainingMs:
                                    nm.nextBarRemainingMs ?? null,
                                  stale: nm.provenance.stale,
                                  isDemo: nm.provenance.isDemo,
                                }))
                              : (gateDiag?.nearMissSymbols ?? [])
                                  .slice(0, 8)
                                  .map((g) => ({
                                    symbol: g.symbol,
                                    direction: g.intendedDirection ?? 'NEUTRAL',
                                    marketRadarCategory: g.marketRadarCategory,
                                    score: g.score ?? 0,
                                    nearMissStatus:
                                      g.nearMissStatus ??
                                      (g.missingGateCount === 1
                                        ? 'NEAR_MISS_ONE_GATE'
                                        : 'NEAR_MISS_TWO_GATES'),
                                    missingGates: g.missingGates ?? [],
                                    evaluationLatencyMs:
                                      g.evaluationLatencyMs ?? null,
                                    nextBarRemainingMs:
                                      g.nextBarRemainingMs ?? null,
                                    stale: Boolean(g.stale),
                                    isDemo: g.isDemo ?? isDemoActive,
                                  }))
                            ).map((item) => (
                              <button
                                key={item.symbol}
                                type="button"
                                onClick={() =>
                                  loadSymbolDetail(
                                    item.symbol,
                                    selectedTimeframe
                                  )
                                }
                                className="w-full text-left rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] hover:border-amber-500/50 cursor-pointer"
                              >
                                <div className="flex items-center justify-between font-mono">
                                  <span className="font-bold text-slate-100">
                                    {item.symbol} ({item.direction}) ·{' '}
                                    {item.nearMissStatus}
                                  </span>
                                  <span className="text-amber-300">
                                    評分 {item.score}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-slate-300 font-mono">
                                  Radar: {item.marketRadarCategory} · 缺少 Gate:{' '}
                                  <strong className="text-rose-300">
                                    {item.missingGates.join(', ') || 'NONE'}
                                  </strong>
                                </div>
                                <div className="mt-0.5 text-slate-400 font-mono">
                                  evaluationLatencyMs:{' '}
                                  {item.evaluationLatencyMs ?? 'null'}ms ·
                                  nextBarRemainingMs:{' '}
                                  {item.nextBarRemainingMs ?? 'null'}ms ·
                                  新鮮度: {item.stale ? 'STALE' : 'FRESH'} ·
                                  isDemo: {String(item.isDemo)}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Panel 3: 目前沒有正式候選的主要原因 */}
                      <div className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.03] p-4 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-sky-300">
                            區塊三：目前沒有正式候選的主要原因與影子校準
                          </span>
                          <span className="font-mono text-[11px] text-slate-400">
                            statisticScope 分層口徑
                          </span>
                        </div>
                        <div className="space-y-1.5 text-[11px] font-mono text-slate-300">
                          <div>
                            • 根因診斷:{' '}
                            <strong className="text-amber-300">
                              {scanData.rootCauseVerdict ??
                                smcScanStatus?.rootCauseVerdict ??
                                'STRICT_GATE_NO_CURRENT_SIGNAL'}
                            </strong>
                          </div>
                          {scopedStats && (
                            <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 space-y-1">
                              <div className="text-slate-400">
                                全市場評估 (ALL_EVALUATED, 分母=
                                {scopedStats.allEvaluatedDenominator}
                                , 排除={scopedStats.allEvaluatedExcludedCount}
                                ):
                              </div>
                              <div>
                                MTF_ALIGNMENT 通過:{' '}
                                {scopedStats.allEvaluated.MTF_ALIGNMENT
                                  ?.passRate ?? 0}
                                % · BOS_MSS:{' '}
                                {scopedStats.allEvaluated.BOS_MSS
                                  ?.passRate ?? 0}
                                % · DISPLACEMENT:{' '}
                                {scopedStats.allEvaluated.DISPLACEMENT
                                  ?.passRate ?? 0}
                                %
                              </div>
                              <div className="text-amber-200/90">
                                Near-Miss 子集合 (NEAR_MISS_ONLY, 分母=
                                {scopedStats.nearMissDenominator}
                                ): 最常缺{' '}
                                {gateDiag?.lastBlockingGate ?? 'MTF_ALIGNMENT'}
                              </div>
                            </div>
                          )}
                          {shadowComp && (
                            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 space-y-0.5 text-[10px]">
                              <div className="text-slate-300 font-semibold">
                                STRICT_PRODUCTION vs OBSERVATION_SHADOW 對照:
                              </div>
                              <div>
                                • STRICT_PRODUCTION (正式):{' '}
                                <strong className="text-emerald-400">
                                  {shadowComp.strictProduction.candidateCount} 檔
                                </strong>{' '}
                                (paperClosed={shadowComp.strictProduction.paperClosedCount} · winRate={String(shadowComp.strictProduction.winRate)})
                              </div>
                              <div>
                                • SHADOW (差1項 Gate 觀察):{' '}
                                <strong className="text-amber-300">
                                  {
                                    shadowComp.observationShadowOneGateMissing
                                      .candidateCount
                                  }{' '}
                                  檔
                                </strong>{' '}
                                (nearMiss={shadowComp.observationShadowOneGateMissing.nearMissCount} · 不建立 Paper / 不推播)
                              </div>
                              <div>
                                • SHADOW (差1~2項 Gate 觀察):{' '}
                                <strong className="text-sky-300">
                                  {
                                    shadowComp.observationShadowTwoGatesMissing
                                      .candidateCount
                                  }{' '}
                                  檔
                                </strong>{' '}
                                (nearMiss={shadowComp.observationShadowTwoGatesMissing.nearMissCount} · winRate={String(shadowComp.observationShadowTwoGatesMissing.winRate)})
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-base font-semibold tracking-tight text-slate-100">
                    <span>今日市場白話氣象台與置頂潛力焦點</span>
                    <span className="text-xs font-normal text-slate-400">
                      · 自動將雙層機構規則轉譯為直覺操作建議
                    </span>
                  </div>
                  <p className="text-[13px] text-slate-300 leading-relaxed max-w-5xl">
                    {(scanData.summaryCounts['多頭候選'] ?? 0) +
                      (scanData.summaryCounts['空頭候選'] ?? 0) >
                    0
                      ? `目前全市場 ${scanData.totalContractsScanned ?? 0} 檔合約中，已有 ${
                          (scanData.summaryCounts['多頭候選'] ?? 0) +
                          (scanData.summaryCounts['空頭候選'] ?? 0)
                        } 檔同時通過「第一層動能雷達」與「第二層 SMC 機構結構確認」（其中已錯過下一根 K 線開盤進場窗口 ${
                          scanData.entryWindowMissedCount ?? 0
                        } 檔，Paper 已開倉 ${
                          scanData.paperOpenedCount ?? 0
                        } 檔）！請點擊下方焦點卡片查看右側 K 線與五步闖關進度。`
                      : `目前全市場共掃描 ${scanData.totalContractsScanned ?? 0} 檔合約，其中 ${
                          (scanData.marketRadarLongCount ?? 0) +
                          (scanData.marketRadarShortCount ?? 0)
                        } 檔進入第一層多空動能觀察，但尚無標的完全滿足嚴格的 15m SMC 突破與回踩條件（0 檔立即進場訊號）。這代表市場多處於結構整理期，系統已自動幫您過濾假突破雜訊；建議先點選下方評分最高的前 3 檔潛力幣種，觀察其右側 K 線結構。`}
                  </p>
                </div>
                <a
                  href="#engineering-telemetry-section"
                  className="text-xs font-medium text-amber-300 hover:underline whitespace-nowrap shrink-0"
                >
                  查看底部工程與 SLA 統計 ↓
                </a>
              </div>

              {scanData.candidates.length > 0 && (
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3 pt-1">
                  {[...scanData.candidates]
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 3)
                    .map((topC, idx) => {
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
                          className={`text-left border p-4 rounded-2xl transition-all cursor-pointer ${
                            isSel
                              ? 'border-amber-500/80 bg-slate-950 shadow-sm'
                              : 'border-slate-800/80 bg-slate-950/60 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-amber-400">
                                0{idx + 1}.
                              </span>
                              <span className="text-base font-bold font-mono text-slate-100">
                                {topC.symbol}
                              </span>
                              <span className="text-xs text-slate-400">
                                · {topC.marketRadarCategory}
                              </span>
                            </div>
                            <span className="font-mono text-xs font-semibold text-slate-200">
                              評分 {topC.score}/96
                            </span>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-xs font-mono tabular-nums">
                            <span className="text-slate-200 font-medium">
                              現價 ${formatPriceDynamic(topC.lastPrice)}
                            </span>
                            <span
                              className={
                                topC.priceChangePercent24h >= 0
                                  ? 'text-emerald-400 font-semibold'
                                  : 'text-rose-400 font-semibold'
                              }
                            >
                              24h{' '}
                              {topC.priceChangePercent24h >= 0 ? '+' : ''}
                              {topC.priceChangePercent24h.toFixed(2)}%
                            </span>
                            <span className="text-slate-400">
                              量能{' '}
                              {topC.historicalVolume.status === 'READY'
                                ? `${topC.historicalVolume.rvol}x`
                                : '收集中'}
                            </span>
                          </div>
                          <div
                            className={`mt-2.5 text-xs truncate ${plainInfo.toneClass}`}
                          >
                            {plainInfo.headline}
                          </div>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Engineering & Full-Market Gate Telemetry Section (order-5: cleanly placed below the Dual-Column Workstation) */}
        <section
          id="engineering-telemetry-section"
          className="order-5 space-y-3 pt-4 border-t border-slate-800/80"
        >
          {/* Full-Market Gate & Two-Layer Telemetry Bar */}
          <div className="border border-slate-800 bg-slate-950/90 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80 text-xs">
              <span className="font-semibold text-slate-200">
                全市場雙層雷達與安全閘門統計 (總掃描合約:{' '}
                {scanData?.totalContractsScanned ?? 0} · 市場雷達候選數量:{' '}
                {(scanData?.marketRadarLongCount ?? 0) +
                  (scanData?.marketRadarShortCount ?? 0)}{' '}
                · SMC PENDING (尚未評估): {scanData?.smcPendingCount ?? 0} · SMC
                LONG CANDIDATE 數量: {scanData?.smcLongCandidateCount ?? 0} ·
                SMC SHORT CANDIDATE 數量:{' '}
                {scanData?.smcShortCandidateCount ?? 0} · WATCH 數量:{' '}
                {scanData?.smcWatchCount ?? 0} · WAIT 數量 (已評估):{' '}
                {scanData?.smcWaitCount ?? 0} · HIGH RISK (已評估):{' '}
                {scanData?.smcHighRiskCount ?? 0} · SMC_GATE_NOT_CONFIRMED
                (僅計已評估): {scanData?.smcGateNotConfirmedCount ?? 0})
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                /api/scan Snapshot:{' '}
                {scanData?.snapshotAt ?? scanData?.fetchedAt ?? 'N/A'} (v
                {scanData?.statsVersion ?? 1}) · 尚未載入多週期 K 線 = PENDING
                (不計入 WAIT)
              </span>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-6 lg:grid-cols-12 font-mono tabular-nums text-[11px]">
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  marketRadarLongCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-emerald-400">
                  {scanData?.marketRadarLongCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  雷達多頭觀察
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  marketRadarShortCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-rose-400">
                  {scanData?.marketRadarShortCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  雷達空頭觀察
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">smcPendingCount</div>
                <div className="mt-0.5 text-sm font-bold text-slate-300">
                  {scanData?.smcPendingCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  SMC 尚未評估 (PENDING)
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">smcWaitCount</div>
                <div className="mt-0.5 text-sm font-bold text-amber-300">
                  {scanData?.smcWaitCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  已評估 WAIT 數量
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">smcWatchCount</div>
                <div className="mt-0.5 text-sm font-bold text-sky-300">
                  {scanData?.smcWatchCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  已評估 WATCH 數量
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  smcLongCandidateCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-emerald-300">
                  {scanData?.smcLongCandidateCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  SMC LONG CANDIDATE
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  smcShortCandidateCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-rose-300">
                  {scanData?.smcShortCandidateCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  SMC SHORT CANDIDATE
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  smcGateNotConfirmedCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-amber-400">
                  {scanData?.smcGateNotConfirmedCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  已評估未通過 SMC Gate
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  insufficientHistoryCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-slate-200">
                  {scanData?.insufficientHistoryCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  歷史樣本 &lt;30 筆
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  baselineUnstableCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-amber-400">
                  {scanData?.baselineUnstableCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  BASELINE_UNSTABLE
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  liquidityRejectedCount
                </div>
                <div className="mt-0.5 text-sm font-bold text-slate-200">
                  {scanData?.liquidityRejectedCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  低流動性攔截
                </div>
              </div>
              <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                <div className="text-slate-400 truncate">
                  momentum / relBtc
                </div>
                <div className="mt-0.5 text-sm font-bold text-sky-300">
                  {scanData?.momentumPassedCount ?? 0} /{' '}
                  {scanData?.relativeBtcPassedCount ?? 0}
                </div>
                <div className="text-[10px] font-sans text-slate-500">
                  24h動能 / 相對BTC通過
                </div>
              </div>
            </div>

            {/* Reason Statistics Transparency Strip (Explicitly Split Scopes: WAIT+WATCH vs HIGH RISK vs ALL NON-CANDIDATE) */}
            {scanData?.waitWatchReasonStats && (
              <div className="mt-2.5 border-t border-slate-800/80 pt-2 text-[11px] font-mono text-slate-400 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-slate-300 font-semibold">
                      waitWatchReasonStats [範圍: 僅已評估 WAIT + WATCH, 不含 HIGH RISK 與 PENDING]：
                    </span>
                    <span>
                      不重複幣種數 (uniqueSymbolCount)={' '}
                      <strong className="text-slate-200">
                        {scanData.waitWatchReasonStats.uniqueSymbolCount}
                      </strong>
                    </span>{' '}
                    ·{' '}
                    <span>
                      可重疊原因總次數 (totalReasonOccurrences)={' '}
                      <strong className="text-amber-300">
                        {scanData.waitWatchReasonStats.totalReasonOccurrences}
                      </strong>
                    </span>
                  </div>
                  {scanData.highRiskReasonStats && (
                    <div>
                      <span className="text-amber-300 font-semibold">
                        highRiskReasonStats [範圍: 僅已評估 HIGH RISK]：
                      </span>
                      <span>
                        uniqueSymbolCount={' '}
                        <strong className="text-slate-200">
                          {scanData.highRiskReasonStats.uniqueSymbolCount}
                        </strong>
                      </span>{' '}
                      ·{' '}
                      <span>
                        totalReasonOccurrences={' '}
                        <strong className="text-rose-300">
                          {scanData.highRiskReasonStats.totalReasonOccurrences}
                        </strong>
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {scanData.nonCandidateReasonStats && (
                    <div>
                      <span className="text-slate-300 font-semibold">
                        nonCandidateReasonStats [範圍: 全部已評估非候選 WAIT + WATCH + HIGH RISK]：
                      </span>
                      <span>
                        uniqueSymbolCount={' '}
                        <strong className="text-slate-200">
                          {scanData.nonCandidateReasonStats.uniqueSymbolCount}
                        </strong>
                      </span>{' '}
                      ·{' '}
                      <span>
                        totalReasonOccurrences={' '}
                        <strong className="text-amber-300">
                          {
                            scanData.nonCandidateReasonStats
                              .totalReasonOccurrences
                          }
                        </strong>
                      </span>
                    </div>
                  )}
                  {scanData.radarGateReasonStats && (
                    <div>
                      <span className="text-slate-300 font-semibold">
                        第一層雷達閘門降級統計 (radarGateReasonStats)：
                      </span>
                      <span>
                        uniqueSymbolCount={' '}
                        <strong className="text-slate-200">
                          {scanData.radarGateReasonStats.uniqueSymbolCount}
                        </strong>
                      </span>{' '}
                      ·{' '}
                      <span>
                        totalReasonOccurrences={' '}
                        <strong className="text-sky-300">
                          {scanData.radarGateReasonStats.totalReasonOccurrences}
                        </strong>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Phase 3 & Phase 16: SMC 全市場掃描進度、PENDING 原因分類、Worker 健康度與卡住診斷 */}
          {(() => {
            const activeSmc = smcScanStatus ?? scanData?.smcScanStatus ?? null;
            const totalJobs =
              activeSmc?.totalJobs ??
              activeSmc?.totalContractsCount ??
              scanData?.totalContractsScanned ??
              0;
            const queuedCount = activeSmc?.queuedCount ?? 0;
            const runningJobCount =
              activeSmc?.runningJobCount ?? activeSmc?.runningCount ?? 0;
            const waitingForCacheCount = activeSmc?.waitingForCacheCount ?? 0;
            const waitingForRateLimitCount =
              activeSmc?.waitingForRateLimitCount ??
              activeSmc?.rateLimitedCount ??
              0;
            const waitingForNextBatchCount =
              activeSmc?.waitingForNextBatchCount ?? 0;
            const retryScheduledCount = activeSmc?.retryScheduledCount ?? 0;
            const failedRetryableCount = activeSmc?.failedRetryableCount ?? 0;
            const inFlightRequestCount = activeSmc?.inFlightRequestCount ?? 0;
            const succeededCount = activeSmc?.succeededCount ?? 0;
            const failedCount = activeSmc?.failedCount ?? 0;
            const rateLimitedCount = activeSmc?.rateLimitedCount ?? 0;
            const pendingCount =
              activeSmc?.pendingCount ?? scanData?.smcPendingCount ?? 0;
            const waitCount =
              activeSmc?.waitCount ?? scanData?.smcWaitCount ?? 0;
            const watchCount =
              activeSmc?.watchCount ?? scanData?.smcWatchCount ?? 0;
            const longCandidateCount =
              activeSmc?.longCandidateCount ??
              scanData?.smcLongCandidateCount ??
              0;
            const shortCandidateCount =
              activeSmc?.shortCandidateCount ??
              scanData?.smcShortCandidateCount ??
              0;
            const highRiskCount =
              activeSmc?.highRiskCount ?? scanData?.smcHighRiskCount ?? 0;
            const stalledSuspected = activeSmc?.stalledSuspected ?? false;
            const stalledReasons = activeSmc?.stalledReasons ?? [];
            const diagnosisLabel =
              activeSmc?.diagnosisLabel ??
              (stalledSuspected
                ? '背景掃描疑似卡住'
                : pendingCount === 0 && totalJobs > 0 && succeededCount === totalJobs
                  ? '掃描已完成'
                  : '正常背景評估中');
            const pendingBreakdownConsistency =
              activeSmc?.pendingBreakdownConsistency ?? 'VALID';

            return (
              <div className="border border-slate-800 bg-slate-950/90 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-amber-300">
                      SMC 全市場掃描進度與 Phase 16 背景 Worker 健康度診斷
                    </span>
                    <span className="font-mono text-slate-300">
                      掃描進度：已完成{' '}
                      <strong className="text-emerald-400">
                        {succeededCount}
                      </strong>{' '}
                      / 總數{' '}
                      <strong className="text-slate-100">{totalJobs}</strong>{' '}
                      (完成數 / 總數)
                    </span>
                    <span
                      className={`px-2 py-0.5 font-mono text-[11px] font-bold border ${
                        stalledSuspected ||
                        pendingBreakdownConsistency === 'INVALID'
                          ? 'border-rose-500/60 bg-rose-950/50 text-rose-300'
                          : diagnosisLabel === '掃描已完成'
                            ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300'
                            : 'border-sky-500/50 bg-sky-950/40 text-sky-300'
                      }`}
                    >
                      診斷說明：{diagnosisLabel} (stalledSuspected=
                      {String(stalledSuspected)})
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">
                      · monitorWorkerState:{' '}
                      {activeSmc?.monitorWorkerState ??
                        systemDbHealth?.monitorWorkerState ??
                        'RUNNING'}{' '}
                      · scanWorkerState:{' '}
                      {activeSmc?.scanWorkerState ??
                        systemDbHealth?.scanWorkerState ??
                        'IDLE'}{' '}
                      · queueWorkerState:{' '}
                      {activeSmc?.queueWorkerState ??
                        systemDbHealth?.queueWorkerState ??
                        'HEALTHY'}{' '}
                      · scannerHealth: {activeSmc?.scannerHealth ?? 'HEALTHY'} ·
                      queueHealth: {activeSmc?.queueHealth ?? 'HEALTHY'} ·
                      exchangeApiHealth:{' '}
                      {activeSmc?.exchangeApiHealth ?? 'HEALTHY'} · 佇列
                      Snapshot: {activeSmc?.snapshotAt ?? 'N/A'} (statsVersion=
                      {activeSmc?.statsVersion ?? 1})
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => controlSmcQueue('start')}
                      className="inline-flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" />
                      啟動背景分批掃描
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => controlSmcQueue('step')}
                      className="inline-flex items-center gap-1 border border-sky-500/50 bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${smcQueueLoading ? 'animate-spin' : ''}`}
                      />
                      執行下一批次
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => controlSmcQueue('pause')}
                      className="inline-flex items-center gap-1 border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
                    >
                      <Square className="h-3 w-3" />
                      暫停佇列
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => controlSmcQueue('resume')}
                      className="inline-flex items-center gap-1 border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 cursor-pointer disabled:opacity-50"
                    >
                      繼續佇列
                    </button>
                    <button
                      type="button"
                      disabled={smcQueueLoading}
                      onClick={() => retryStuckSmcJobs()}
                      className="inline-flex items-center gap-1 border border-rose-500/50 bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25 cursor-pointer disabled:opacity-50"
                    >
                      重試卡住任務 (retry-stuck)
                    </button>
                    {selectedSymbol && (
                      <button
                        type="button"
                        disabled={smcQueueLoading}
                        onClick={() => refreshSingleSmcSymbol(selectedSymbol)}
                        className="inline-flex items-center gap-1 border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25 cursor-pointer disabled:opacity-50"
                      >
                        單檔刷新 ({selectedSymbol})
                      </button>
                    )}
                  </div>
                </div>

                {/* Phase 16 Mandatory PENDING Semantics Disclosure Banner */}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border border-amber-500/30 bg-amber-950/20 px-3 py-1.5 text-[11px] font-mono text-amber-200">
                  <div className="flex flex-wrap items-center gap-3 font-semibold">
                    <span>· PENDING 不等於 WAIT</span>
                    <span>· PENDING 不代表 SMC 通過</span>
                    <span>· PENDING 不代表 SMC 被拒絕</span>
                    <span className="text-amber-300/90">
                      (SMC 尚未評估／點擊載入單幣種結構)
                    </span>
                  </div>
                  <div className="text-slate-300">
                    Fast Lane PENDING:{' '}
                    <strong className="text-amber-300">
                      {activeSmc?.fastLanePendingCount ?? 0}
                    </strong>{' '}
                    · Bulk PENDING:{' '}
                    <strong className="text-sky-300">
                      {activeSmc?.bulkPendingCount ?? 0}
                    </strong>{' '}
                    · 每分鐘完成速率:{' '}
                    <strong className="text-emerald-300">
                      {activeSmc?.progressRatePerMinute ?? 0}/min
                    </strong>{' '}
                    · 最舊 PENDING 等待時間:{' '}
                    <strong className="text-amber-300">
                      {activeSmc?.oldestPendingAgeMs !== null &&
                      activeSmc?.oldestPendingAgeMs !== undefined
                        ? `${activeSmc.oldestPendingAgeMs}ms`
                        : '0ms'}
                    </strong>
                  </div>
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12 font-mono tabular-nums text-[11px]">
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      PENDING 數 ({`PENDING(${pendingCount})`})
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-slate-300">
                      {pendingCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      尚未完成 (一致性: {pendingBreakdownConsistency})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      QUEUED / RUNNING
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-sky-300">
                      Q:{queuedCount} / R:{runningJobCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      含下一批等待:{waitingForNextBatchCount} (並行≤
                      {activeSmc?.config.maxConcurrency ?? 2})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      WAITING_FOR_CACHE / IN-FLIGHT REQUESTS
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-cyan-300">
                      {waitingForCacheCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      等待快取預熱 (IN-FLIGHT REQUESTS: {inFlightRequestCount})
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      RATE LIMITED / RATE_LIMITED / RETRY
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-amber-400">
                      RL:{waitingForRateLimitCount || rateLimitedCount} / RETRY:
                      {retryScheduledCount + failedRetryableCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      等待重試:{retryScheduledCount} · 可重試失敗:
                      {failedRetryableCount}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">SUCCEEDED</div>
                    <div className="mt-0.5 text-sm font-bold text-emerald-400">
                      {succeededCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已完成有效 SMC 結果數
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">WAIT</div>
                    <div className="mt-0.5 text-sm font-bold text-amber-300">
                      {waitCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已評估等待確認
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">WATCH</div>
                    <div className="mt-0.5 text-sm font-bold text-sky-300">
                      {watchCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      已評估觀察結構
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      LONG / SHORT 候選
                    </div>
                    <div className="mt-0.5 text-sm font-bold text-emerald-400">
                      L:{longCandidateCount} /{' '}
                      <span className="text-rose-400">
                        S:{shortCandidateCount}
                      </span>
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      HIGH RISK: {highRiskCount}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">FAILED 數</div>
                    <div className="mt-0.5 text-sm font-bold text-rose-400">
                      {failedCount}
                    </div>
                    <div className="text-[10px] font-sans text-slate-500">
                      終端失敗 (不計入 PENDING)
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      最後完成時間 / 進度時間
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-slate-200 truncate">
                      {activeSmc?.lastJobCompletedAt ?? activeSmc?.lastCompletedAt
                        ? new Date(
                            activeSmc?.lastJobCompletedAt ??
                              activeSmc?.lastCompletedAt ??
                              ''
                          ).toLocaleTimeString('zh-TW', { hour12: false })
                        : '尚無完成紀錄'}
                    </div>
                    <div className="text-[10px] font-sans text-sky-300 truncate">
                      資料新鮮度 · 最後進度:{' '}
                      {activeSmc?.lastProgressAt
                        ? new Date(activeSmc.lastProgressAt).toLocaleTimeString(
                            'zh-TW',
                            { hour12: false }
                          )
                        : 'N/A'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      速率 / 預估剩餘時間
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-emerald-300 truncate">
                      {activeSmc?.progressRatePerMinute ?? 0} 檔/分 (
                      {activeSmc?.progressRateStatus ??
                        (pendingCount === 0
                          ? 'NO_ACTIVE_PROGRESS'
                          : 'ACTIVE')}
                      )
                    </div>
                    <div className="text-[10px] font-sans text-amber-300 truncate">
                      預估剩餘: {activeSmc?.estimatedRemaining ?? '0s'}
                    </div>
                  </div>
                  <div className="border border-slate-800/80 bg-slate-900/50 p-2">
                    <div className="text-slate-400 truncate">
                      卡住診斷 (stalledJobCount)
                    </div>
                    <div
                      className={`mt-0.5 text-xs font-bold truncate ${
                        stalledSuspected ? 'text-rose-400' : 'text-emerald-400'
                      }`}
                    >
                      {stalledSuspected
                        ? `疑似卡住 (${activeSmc?.stalledJobCount ?? 0})`
                        : `正常 (0)`}
                    </div>
                    <div className="text-[10px] font-sans text-slate-400 truncate">
                      {stalledReasons.length > 0
                        ? stalledReasons.join(', ')
                        : `門檻 ${activeSmc?.stalledThresholdMs ?? 45000}ms`}
                    </div>
                  </div>
                </div>

                {/* Atomic Snapshot & Phase 16 PENDING Breakdown Consistency Proof Strip */}
                <div className="mt-2 border-t border-slate-800/80 pt-2 text-[11px] font-mono text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    佇列總數恆等式 / Phase 16 PENDING 統計恆等式：pendingCount(
                    {pendingCount}) = queuedCount({queuedCount}) +
                    runningJobCount({runningJobCount}) + waitingForCacheCount(
                    {waitingForCacheCount}) + waitingForRateLimitCount(
                    {waitingForRateLimitCount}) + retryScheduledCount(
                    {retryScheduledCount}) + failedRetryableCount(
                    {failedRetryableCount}) · pendingBreakdownConsistency=
                    <strong
                      className={
                        pendingBreakdownConsistency === 'VALID'
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }
                    >
                      {pendingBreakdownConsistency}
                    </strong>
                  </span>
                  <span>
                    SUCCEEDED({succeededCount}) = WAIT({waitCount}) + WATCH(
                    {watchCount}) + LONG({longCandidateCount}) + SHORT(
                    {shortCandidateCount}) + HIGH_RISK({highRiskCount}) ·
                    FAILED({failedCount}) 不計入 PENDING
                  </span>
                </div>

                {/* Phase 8: Two-Stage Radar + Fast Lane Priority SMC Detection Latency Telemetry */}
                <div className="mt-2 border-t border-slate-800/80 pt-2 text-[11px] font-mono text-slate-300 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-amber-300">
                        Phase 8 兩階段掃描與 Fast Lane 延遲統計：
                      </span>
                      <span>
                        lastFullRadarScanAt:{' '}
                        <strong className="text-slate-100">
                          {activeSmc?.lastFullRadarScanAt ??
                            paperMonitorStatus?.lastFullRadarScanAt ??
                            'N/A'}
                        </strong>
                      </span>
                      <span>
                        · lastPriorityScanAt:{' '}
                        <strong className="text-slate-100">
                          {activeSmc?.lastPriorityScanAt ??
                            paperMonitorStatus?.lastPriorityScanAt ??
                            'N/A'}
                        </strong>
                      </span>
                      <span>
                        · queueWaitMs:{' '}
                        <strong className="text-sky-300">
                          {activeSmc?.queueWaitMs ??
                            paperMonitorStatus?.queueWaitMs ??
                            0}
                          ms
                        </strong>
                      </span>
                      <span>
                        · detectionLatencyMs:{' '}
                        <strong className="text-amber-300">
                          {activeSmc?.detectionLatencyMs ??
                            paperMonitorStatus?.detectionLatencyMs ??
                            0}
                          ms
                        </strong>
                      </span>
                      <span>
                        · FastLane p50:{' '}
                        <strong
                          className={
                            (activeSmc?.p50PriorityDetectionLatencyMs ??
                              activeSmc?.p50DetectionLatencyMs ??
                              0) <= 60_000
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {activeSmc?.p50PriorityDetectionLatencyMs ??
                            activeSmc?.p50DetectionLatencyMs ??
                            paperMonitorStatus?.p50PriorityDetectionLatencyMs ??
                            paperMonitorStatus?.p50DetectionLatencyMs ??
                            0}
                          ms (目標 &lt; 60s)
                        </strong>
                      </span>
                      <span>
                        · FastLane p95:{' '}
                        <strong
                          className={
                            (activeSmc?.p95PriorityDetectionLatencyMs ??
                              activeSmc?.p95DetectionLatencyMs ??
                              0) <= 120_000
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {activeSmc?.p95PriorityDetectionLatencyMs ??
                            activeSmc?.p95DetectionLatencyMs ??
                            paperMonitorStatus?.p95PriorityDetectionLatencyMs ??
                            paperMonitorStatus?.p95DetectionLatencyMs ??
                            0}
                          ms (目標 &lt; 120s)
                        </strong>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>
                        candidateDetectedBeforeEntryWindowCount:{' '}
                        <strong className="text-emerald-400">
                          {activeSmc?.candidateDetectedBeforeEntryWindowCount ??
                            paperMonitorStatus?.candidateDetectedBeforeEntryWindowCount ??
                            0}
                        </strong>
                      </span>
                      <span>
                        · entryWindowMissedCount:{' '}
                        <strong className="text-amber-400">
                          {activeSmc?.entryWindowMissedCount ??
                            paperMonitorStatus?.entryWindowMissedCount ??
                            0}
                        </strong>
                      </span>
                      {selectedSymbol && (
                        <button
                          type="button"
                          disabled={smcQueueLoading}
                          onClick={() => refreshSingleSmcSymbol(selectedSymbol)}
                          className="inline-flex items-center gap-1 border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
                        >
                          Fast Lane 優先評估 ({selectedSymbol})
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 border-t border-slate-800/50 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>
                        priorityDetectionSLA:{' '}
                        <strong
                          className={
                            (activeSmc?.priorityDetectionSLA ??
                              paperMonitorStatus?.priorityDetectionSLA) ===
                            'MET'
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {activeSmc?.priorityDetectionSLA ??
                            paperMonitorStatus?.priorityDetectionSLA ??
                            'PENDING'}
                        </strong>
                      </span>
                      <span>
                        · coldStartPrioritySLA:{' '}
                        <strong
                          className={
                            (activeSmc?.coldStartPrioritySLA ??
                              paperMonitorStatus?.coldStartPrioritySLA) ===
                            'MET'
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {activeSmc?.coldStartPrioritySLA ??
                            paperMonitorStatus?.coldStartPrioritySLA ??
                            'PENDING'}
                        </strong>{' '}
                        (p95:{' '}
                        {activeSmc?.coldStartP95 ??
                          paperMonitorStatus?.coldStartP95 ??
                          0}
                        ms)
                      </span>
                      <span>
                        · warmCachePrioritySLA:{' '}
                        <strong
                          className={
                            (activeSmc?.warmCachePrioritySLA ??
                              paperMonitorStatus?.warmCachePrioritySLA) ===
                            'MET'
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {activeSmc?.warmCachePrioritySLA ??
                            paperMonitorStatus?.warmCachePrioritySLA ??
                            'PENDING'}
                        </strong>{' '}
                        (p95:{' '}
                        {activeSmc?.warmCacheP95 ??
                          paperMonitorStatus?.warmCacheP95 ??
                          0}
                        ms)
                      </span>
                      <span>
                        · prewarmDurationMs:{' '}
                        <strong className="text-sky-300">
                          {activeSmc?.prewarmDurationMs ??
                            paperMonitorStatus?.prewarmDurationMs ??
                            0}
                          ms
                        </strong>
                      </span>
                      <span>
                        · Bulk p95 QueueWait:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.p95BulkQueueWaitMs ??
                            paperMonitorStatus?.p95BulkQueueWaitMs ??
                            0}
                          ms
                        </strong>
                      </span>
                      <span>
                        · 全市場完整耗時 (fullUniverseCompletionDuration):{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.fullUniverseCompletionDuration ??
                            activeSmc?.fullUniverseCompletionDurationMs ??
                            paperMonitorStatus?.fullUniverseCompletionDurationMs ??
                            0}
                          ms
                        </strong>{' '}
                        (coldStartFullUniverseDuration:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.coldStartFullUniverseDuration ??
                            activeSmc?.coldStartFullUniverseCompletionDuration ??
                            0}
                          ms
                        </strong>
                        )
                      </span>
                      <span>
                        · 快取命中率:{' '}
                        <strong className="text-emerald-300">
                          {activeSmc?.cacheHitRate ??
                            paperMonitorStatus?.cacheHitRate ??
                            0}
                          %
                        </strong>{' '}
                        (Hit:{' '}
                        {activeSmc?.cacheHitCount ??
                          paperMonitorStatus?.cacheHitCount ??
                          0}{' '}
                        / Miss:{' '}
                        {activeSmc?.cacheMissCount ??
                          paperMonitorStatus?.cacheMissCount ??
                          0}
                        )
                      </span>
                    </div>
                    {activeSmc?.latencyBreakdown && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          階段拆解 p95：queueWait=
                          {activeSmc.latencyBreakdown.queueWait.p95}ms ·
                          prewarm={activeSmc.latencyBreakdown.prewarmWait?.p95 ?? 0}ms ·
                          HTTP={activeSmc.latencyBreakdown.httpFetch.p95}ms ·
                          SMC={activeSmc.latencyBreakdown.smcCalculation.p95}ms ·
                          DB={activeSmc.latencyBreakdown.databaseWrite.p95}ms ·
                          429退避={activeSmc.latencyBreakdown.rateLimitBackoff.p95}
                          ms
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Phase 9: Persistent Warm Cache Snapshot & Timeframe Coverage Telemetry */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-300 border-t border-slate-800/50 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-cyan-300">
                        Phase 9 持久化預熱快照與多週期快取覆蓋率：
                      </span>
                      <span
                        className={`px-1.5 py-0.5 font-bold border ${
                          (activeSmc?.cacheStatusLabel ??
                            scanData?.cacheStatusLabel) === '快取可用'
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : (activeSmc?.cacheStatusLabel ??
                                  scanData?.cacheStatusLabel) === '正在預熱'
                              ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                              : (activeSmc?.cacheStatusLabel ??
                                    scanData?.cacheStatusLabel) === '快取過期'
                                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                                : 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                        }`}
                      >
                        {activeSmc?.cacheStatusLabel ??
                          scanData?.cacheStatusLabel ??
                          '資料不可用'}
                      </span>
                      <span>
                        cacheCoverageRate:{' '}
                        <strong className="text-emerald-300">
                          {activeSmc?.cacheCoverageRate ??
                            scanData?.cacheCoverageRate ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · freshCacheCount:{' '}
                        <strong className="text-emerald-400">
                          {activeSmc?.freshCacheCount ??
                            scanData?.freshCacheCount ??
                            0}
                        </strong>
                      </span>
                      <span>
                        · expiredCacheCount:{' '}
                        <strong className="text-amber-300">
                          {activeSmc?.expiredCacheCount ??
                            scanData?.expiredCacheCount ??
                            0}
                        </strong>
                      </span>
                      <span>
                        · staleCacheCount:{' '}
                        <strong className="text-rose-300">
                          {activeSmc?.staleCacheCount ??
                            scanData?.staleCacheCount ??
                            0}
                        </strong>
                      </span>
                      <span>
                        · prewarmRequiredCount:{' '}
                        <strong className="text-sky-300">
                          {activeSmc?.prewarmRequiredCount ??
                            scanData?.prewarmRequiredCount ??
                            0}
                        </strong>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-slate-400">
                      <span>
                        5m:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.['5mCacheCoverage'] ??
                            scanData?.['5mCacheCoverage'] ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · 15m:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.['15mCacheCoverage'] ??
                            scanData?.['15mCacheCoverage'] ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · 1h:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.['1hCacheCoverage'] ??
                            scanData?.['1hCacheCoverage'] ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · 4h:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.['4hCacheCoverage'] ??
                            scanData?.['4hCacheCoverage'] ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · OI:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.oiCacheCoverage ??
                            scanData?.oiCacheCoverage ??
                            0}
                          %
                        </strong>
                      </span>
                      <span>
                        · Funding:{' '}
                        <strong className="text-slate-200">
                          {activeSmc?.fundingCacheCoverage ??
                            scanData?.fundingCacheCoverage ??
                            0}
                          %
                        </strong>
                      </span>
                      {activeSmc?.latestPrewarmSnapshot && (
                        <span>
                          · 快照ID:{' '}
                          <strong className="text-cyan-300">
                            {activeSmc.latestPrewarmSnapshot.snapshotId}
                          </strong>{' '}
                          (有效至 {activeSmc.latestPrewarmSnapshot.freshUntil})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Phase 17: 系統穩定性 (System Stability, Worker Recovery, SQLite Health & Long-Running Windows) */}
                  <div className="mt-2 border-t border-slate-800/80 pt-2.5 text-[11px] font-mono text-slate-300 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-emerald-300">
                          系統穩定性 (Phase 17 長時間 Live Paper 掃描穩定性 · Worker 恢復 · SQLite 一致性)
                        </span>
                        <span className="px-2 py-0.5 border border-emerald-500/40 bg-emerald-950/30 text-emerald-300 font-semibold">
                          SQLite:{' '}
                          {systemDbHealth?.integrityCheckPassed !== false
                            ? 'HEALTHY'
                            : 'CORRUPTED'}{' '}
                          ({systemDbHealth?.integrityCheck ?? 'ok'} · WAL=
                          {systemDbHealth?.walStatus ?? 'ACTIVE'})
                        </span>
                        <span className="px-2 py-0.5 border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 font-semibold">
                          快取健康: {systemDbHealth?.cacheHealth ?? 'HEALTHY'} (
                          {activeSmc?.cacheStatusLabel ?? '快取可用'})
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={dbCheckLoading}
                          onClick={() => runSystemDbCheck()}
                          className="inline-flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer disabled:opacity-50"
                        >
                          {dbCheckLoading
                            ? 'SQLite 檢查備份中...'
                            : '執行 SQLite 檢查與安全備份 (database-check)'}
                        </button>
                      </div>
                    </div>

                    {/* Phase 17 Mandatory 3 Stability Notices */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border border-sky-500/30 bg-sky-950/20 px-3 py-1.5 text-[11px] text-sky-200">
                      <div className="flex flex-wrap items-center gap-4 font-semibold">
                        <span>· PENDING 不等於 WAIT</span>
                        <span>· 掃描中不代表候選已確認</span>
                        <span>· 候選數為 0 不代表服務故障</span>
                      </div>
                      <div className="text-[10px] text-slate-300">
                        429 次數:{' '}
                        <strong className="text-amber-300">
                          {systemDbHealth?.rateLimit429Count ??
                            activeSmc?.rateLimitCount ??
                            0}
                        </strong>{' '}
                        · 503 次數:{' '}
                        <strong className="text-rose-300">
                          {systemDbHealth?.http503Count ?? 0}
                        </strong>{' '}
                        · 最後一次錯誤:{' '}
                        <strong className="text-slate-200">
                          {systemDbHealth?.lastError ?? '無異常'}
                        </strong>
                      </div>
                    </div>

                    {/* Stability Core Telemetry Grid */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 text-[10px]">
                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          Monitor / Scan / Queue Worker 狀態
                        </div>
                        <div className="mt-0.5 font-bold text-slate-100 truncate">
                          Monitor:{' '}
                          <span className="text-emerald-300">
                            {systemDbHealth?.monitorWorkerState ??
                              activeSmc?.monitorWorkerState ??
                              'RUNNING'}
                          </span>{' '}
                          · Scan:{' '}
                          <span className="text-sky-300">
                            {systemDbHealth?.scanWorkerState ??
                              activeSmc?.scanWorkerState ??
                              'IDLE'}
                          </span>{' '}
                          · Queue:{' '}
                          <span className="text-cyan-300">
                            {systemDbHealth?.queueWorkerState ??
                              activeSmc?.queueWorkerState ??
                              'HEALTHY'}
                          </span>
                        </div>
                        <div className="text-slate-400 truncate">
                          每分鐘速率:{' '}
                          {systemDbHealth?.progressRatePerMinute ??
                            activeSmc?.progressRatePerMinute ??
                            0}
                          /min (
                          {systemDbHealth?.progressRateStatus ??
                            activeSmc?.progressRateStatus ??
                            'NO_ACTIVE_PROGRESS'}
                          ) · stalled=
                          <span
                            className={
                              (systemDbHealth?.stalledSuspected ??
                              stalledSuspected)
                                ? 'text-rose-400'
                                : 'text-emerald-400'
                            }
                          >
                            {String(
                              systemDbHealth?.stalledSuspected ??
                                stalledSuspected
                            )}
                          </span>
                        </div>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          最後進度 / 最後完成任務
                        </div>
                        <div className="mt-0.5 font-bold text-slate-100 truncate">
                          進度:{' '}
                          {systemDbHealth?.lastProgressAt ??
                            activeSmc?.lastProgressAt ??
                            'N/A'}
                        </div>
                        <div className="text-slate-400 truncate">
                          完成:{' '}
                          {systemDbHealth?.lastJobCompletedAt ??
                            activeSmc?.lastJobCompletedAt ??
                            'N/A'}
                        </div>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          最舊 PENDING 等待 / 錯誤統計
                        </div>
                        <div className="mt-0.5 font-bold text-amber-300">
                          最舊等待:{' '}
                          {systemDbHealth?.oldestPendingAgeMs ??
                            activeSmc?.oldestPendingAgeMs ??
                            0}
                          ms
                        </div>
                        <div className="text-slate-400 truncate">
                          429: {systemDbHealth?.rateLimit429Count ?? 0} · 503:{' '}
                          {systemDbHealth?.http503Count ?? 0} · Stalled:{' '}
                          {systemDbHealth?.stalledDetectedCount ?? 0}
                        </div>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          SQLite 一致性與安全備份
                        </div>
                        <div className="mt-0.5 font-bold text-emerald-300 truncate">
                          DB: {systemDbHealth?.databaseInstanceId ?? 'N/A'} (v
                          {systemDbHealth?.statsVersion ??
                            activeSmc?.statsVersion ??
                            1}
                          )
                        </div>
                        <div className="text-slate-400 truncate">
                          備份: {systemDbHealth?.lastBackupAt ?? '尚未備份'} (
                          {systemDbHealth?.backupFileVerified
                            ? 'READABLE_OK'
                            : 'PENDING'}
                          ) · 快取列:{systemDbHealth?.cacheRowCount ?? 0}
                        </div>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          目前窗口 / 窗口狀態 / 窗口剩餘時間 / 是否可完成
                        </div>
                        <div className="mt-0.5 font-bold text-sky-300 truncate">
                          目前窗口:{' '}
                          {systemDbHealth?.monitoringWindows?.['24h']
                            ?.monitoringWindowId ??
                            systemDbHealth?.monitoringWindowId ??
                            'N/A'}
                        </div>
                        <div className="text-slate-400 truncate">
                          窗口狀態:{' '}
                          <strong className="text-emerald-300">
                            {systemDbHealth?.monitoringWindows?.['24h']
                              ?.windowStatus ?? 'RUNNING'}
                          </strong>{' '}
                          · 窗口剩餘時間:{' '}
                          {systemDbHealth?.monitoringWindows?.['24h']
                            ?.remainingDuration ?? '24h 00m 00s'}{' '}
                          · 是否可完成:{' '}
                          <strong className="text-amber-300">
                            {String(
                              systemDbHealth?.monitoringWindows?.['24h']
                                ?.canMarkCompleted ?? false
                            )}
                          </strong>
                        </div>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/40 p-2">
                        <div className="text-slate-400">
                          本窗口 vs 服務累計重啟與恢復計數 (Phase 17.3)
                        </div>
                        <div className="mt-0.5 font-bold text-cyan-300 truncate">
                          本窗口計畫性重啟:{' '}
                          {systemDbHealth?.windowPlannedRestartCount ??
                            activeSmc?.windowPlannedRestartCount ??
                            0}{' '}
                          · 本窗口非預期重啟:{' '}
                          <span
                            className={
                              (systemDbHealth?.windowUnexpectedRestartCount ??
                                0) > 0
                                ? 'text-rose-400'
                                : 'text-emerald-300'
                            }
                          >
                            {systemDbHealth?.windowUnexpectedRestartCount ??
                              activeSmc?.windowUnexpectedRestartCount ??
                              0}
                          </span>{' '}
                          · 本窗口 Lease 恢復:{' '}
                          {systemDbHealth?.windowLeaseRecoveryCount ??
                            activeSmc?.windowLeaseRecoveryCount ??
                            0}{' '}
                          · 本窗口資料庫恢復:{' '}
                          {systemDbHealth?.windowDatabaseRecoveryCount ??
                            activeSmc?.windowDatabaseRecoveryCount ??
                            0}
                        </div>
                        <div className="text-slate-400 truncate">
                          服務累計計畫性重啟:{' '}
                          {systemDbHealth?.lifetimePlannedRestartCount ??
                            systemDbHealth?.plannedRestartCount ??
                            0}{' '}
                          · 服務累計非預期重啟:{' '}
                          {systemDbHealth?.lifetimeUnexpectedRestartCount ??
                            systemDbHealth?.unexpectedRestartCount ??
                            0}{' '}
                          · 服務累計 Lease 恢復:{' '}
                          {systemDbHealth?.lifetimeLeaseRecoveryCount ??
                            systemDbHealth?.leaseRecoveryCount ??
                            0}{' '}
                          · 服務累計資料庫恢復:{' '}
                          {systemDbHealth?.lifetimeDatabaseRecoveryCount ??
                            systemDbHealth?.databaseRecoveryCount ??
                            0}
                        </div>
                      </div>
                    </div>

                    {/* Phase 17.1 & 17.3 Concurrency Cap, Current vs Previous Window & Finalization Strip */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-[10px]">
                      <div className="border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex items-center justify-between">
                        <span className="text-slate-400">
                          並行限制驗證 (runningJobCount &lt;= maxConcurrency)
                        </span>
                        <span className="font-mono font-bold text-slate-100">
                          最大並行數:{' '}
                          <strong className="text-cyan-300">
                            {systemDbHealth?.maxConcurrency ??
                              activeSmc?.maxConcurrency ??
                              activeSmc?.config?.maxConcurrency ??
                              2}
                          </strong>{' '}
                          · 目前執行數:{' '}
                          <strong className="text-amber-300">
                            {systemDbHealth?.runningJobCount ??
                              activeSmc?.runningJobCount ??
                              0}
                          </strong>{' '}
                          · 並行限制是否通過:{' '}
                          <strong
                            className={
                              (systemDbHealth?.concurrencyValid ??
                                activeSmc?.concurrencyValid ??
                                true)
                                ? 'text-emerald-300'
                                : 'text-rose-400'
                            }
                          >
                            {(systemDbHealth?.concurrencyValid ??
                              activeSmc?.concurrencyValid ??
                              true)
                              ? 'PASS (true)'
                              : 'FAIL (false)'}
                          </strong>
                        </span>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex items-center justify-between">
                        <span className="text-slate-400">
                          目前窗口 (24h / 72h) 收尾驗證
                        </span>
                        <span className="font-mono font-bold text-slate-200 truncate">
                          24h:{' '}
                          <strong className="text-sky-300">
                            {systemDbHealth?.monitoringWindows?.['24h']
                              ?.windowStatus ?? 'RUNNING'}
                          </strong>{' '}
                          ({systemDbHealth?.monitoringWindows?.['24h']
                            ?.remainingDuration ?? '24h'}) · 72h:{' '}
                          <strong className="text-sky-300">
                            {systemDbHealth?.monitoringWindows?.['72h']
                              ?.windowStatus ?? 'RUNNING'}
                          </strong>{' '}
                          ({systemDbHealth?.monitoringWindows?.['72h']
                            ?.remainingDuration ?? '72h'}) · 是否可完成:{' '}
                          <strong className="text-amber-300">
                            {String(
                              systemDbHealth?.monitoringWindows?.['24h']
                                ?.canMarkCompleted ?? false
                            )}
                          </strong>
                        </span>
                      </div>

                      <div className="border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5 flex items-center justify-between">
                        <span className="text-slate-400">
                          上一個窗口 (歷史終態追蹤)
                        </span>
                        <span className="font-mono font-bold text-slate-200 truncate">
                          {systemDbHealth?.previousWindows?.['24h'] ? (
                            <>
                              {
                                systemDbHealth.previousWindows['24h']
                                  .monitoringWindowId
                              }{' '}
                              · 狀態:{' '}
                              <strong className="text-rose-300">
                                {
                                  systemDbHealth.previousWindows['24h']
                                    .windowStatus
                                }
                              </strong>{' '}
                              · 原因:{' '}
                              <span className="text-amber-300">
                                {systemDbHealth.previousWindows['24h']
                                  .terminalReason ?? 'N/A'}
                              </span>
                            </>
                          ) : (
                            '無上一個窗口紀錄'
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Phase 7: 24-Hour Paper Shadow Monitoring Window Compact Telemetry Bar */}
          <div className="border border-slate-800 bg-slate-950/90 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-semibold text-amber-300">
                  Phase 7 · 24 小時 Paper 影子監控視窗
                </span>
                <span
                  className={`px-2 py-0.5 font-mono text-[11px] font-bold border ${
                    paperWindowReport?.windowStatus === 'COMPLETED'
                      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                      : paperWindowReport?.windowStatus === 'ERROR'
                        ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                        : paperWindowReport?.windowStatus === 'INTERRUPTED'
                          ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                          : 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                  }`}
                >
                  24 小時監控狀態: {paperWindowReport?.windowStatus ?? 'RUNNING'} (
                  {paperWindowReport?.windowStatus === 'COMPLETED'
                    ? '24 小時監控：已完成'
                    : '24 小時監控：未完成／未驗證'}
                  )
                </span>
                <span className="font-mono text-[11px] text-slate-300">
                  已運行時間:{' '}
                  <strong className="text-slate-100">
                    {paperWindowReport?.windowElapsedFormatted ??
                      paperMonitorStatus?.windowElapsedFormatted ??
                      '0h 0m 0s'}
                  </strong>{' '}
                  · 剩餘時間:{' '}
                  <strong className="text-amber-300">
                    {paperWindowReport?.windowRemainingFormatted ??
                      paperMonitorStatus?.windowRemainingFormatted ??
                      '24h 0m 0s'}
                  </strong>{' '}
                  · 完成掃描週期數:{' '}
                  <strong className="text-emerald-400">
                    {paperWindowReport?.completedScanCycles ?? 0}
                  </strong>
                  /{paperWindowReport?.totalScanCycles ?? 0} ·
                  最後一次掃描時間:{' '}
                  <strong className="text-slate-200">
                    {paperMonitorStatus?.lastScanAt ?? '尚未執行'}
                  </strong>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                <span
                  className={`px-2 py-0.5 border ${
                    paperWindowReport?.candidateStatus === 'NO_CANDIDATE_VALID'
                      ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                      : paperWindowReport?.candidateStatus ===
                          'NO_CANDIDATE_SUSPECTED'
                        ? 'border-rose-500/40 bg-rose-950/30 text-rose-300'
                        : 'border-sky-500/40 bg-sky-950/30 text-sky-300'
                  }`}
                >
                  candidateStatus:{' '}
                  {paperWindowReport?.candidateStatus ?? 'NO_CANDIDATE_VALID'}
                </span>
                <span className="text-slate-400">
                  LONG 候選數:{' '}
                  <strong className="text-emerald-400">
                    {paperMonitorStatus?.longCandidateCount ?? 0}
                  </strong>{' '}
                  · SHORT 候選數:{' '}
                  <strong className="text-rose-400">
                    {paperMonitorStatus?.shortCandidateCount ?? 0}
                  </strong>{' '}
                  · Paper 訊號數:{' '}
                  <strong className="text-sky-300">
                    {paperWindowReport?.totalSignals ?? 0}
                  </strong>{' '}
                  · 外部通知請求數:{' '}
                  <strong className="text-emerald-400">
                    Telegram=
                    {paperWindowReport?.externalTelegramRequestsCount ?? 0} /
                    TradingView=
                    {paperWindowReport?.externalTradingViewRequestsCount ?? 0}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => setActiveSection('notifications')}
                  className="underline text-amber-300 hover:text-amber-200 cursor-pointer"
                >
                  開啟 24h 影子監控完整面板 →
                </button>
              </div>
            </div>
          </div>

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
                    className={`border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-amber-500/60 bg-slate-900/70'
                        : 'border-slate-800/80 bg-slate-900/35 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between border-b border-slate-800/70 pb-1.5 mb-1.5">
                      <span className="font-bold text-xs text-slate-100">
                        {winKey} 長期監控週期 ({winSum?.monitoringWindowId ?? `win_${winKey}`})
                      </span>
                      <span
                        className={
                          winSum?.sampleSufficiency === 'SUFFICIENT'
                            ? 'text-emerald-400 font-semibold'
                            : 'text-amber-300 font-semibold'
                        }
                      >
                        {winSum?.sampleSufficiency ?? 'INSUFFICIENT'} (n=
                        {winSum?.sampleCount ?? 0})
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-400">最新/去重/累計評估:</span>
                        <strong className="text-slate-100">
                          {winSum?.latestCycleEvaluatedCount ?? 0} /{' '}
                          {winSum?.uniqueEvaluatedSymbols ?? 0} /{' '}
                          {winSum?.cumulativeEvaluationEvents ?? 0}
                        </strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">完整/中斷週期:</span>
                        <strong className="text-slate-200">
                          {winSum?.completedScanCycles ?? 0} /{' '}
                          {winSum?.interruptedScanCycles ?? 0} (共{' '}
                          {winSum?.totalScanCycles ?? 0})
                        </strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">候選數 (L/S):</span>
                        <strong className="text-slate-100">
                          {winSum?.totalSignals ?? 0} ({winSum?.longSignals ?? 0}/
                          {winSum?.shortSignals ?? 0})
                        </strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">開倉 / 結算:</span>
                        <strong className="text-slate-100">
                          {winSum?.paperOpened ?? 0} / {winSum?.paperClosed ?? 0}
                        </strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">ENTRY_WINDOW_MISSED:</span>
                        <strong className="text-amber-300">
                          {winSum?.entryWindowMissed ?? 0}
                        </strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">metricStatus:</span>
                        <strong className="text-sky-300">
                          {winSum?.metricStatus ?? 'NO_TRADES'}
                        </strong>
                      </div>
                      <div className="flex justify-between col-span-2">
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
        </section>

        {/* Historical Volume Anomaly & Auxiliary 24h Rank Disclosure Notice */}
        <div className="order-4 flex flex-wrap items-center justify-between gap-2 border border-slate-800/80 bg-slate-900/25 px-4 py-2 text-xs text-slate-400">
          <span>
            <strong>Phase 2 歷史量能異常與真實盤口政策：</strong>
            已啟用 SQLite 歷史成交量 Collector 計算每個幣種之{' '}
            <code className="font-mono text-slate-200">
              Rolling Median / MAD / Z-Score / RVOL
            </code>
            ；原有的「全市場 24h 成交額百分位 (PR)」已改為<strong>輔助指標 (Auxiliary)</strong>，絕不冒充歷史異常成交量。
            低流動性標的強制標示「低流動性：不列入一般候選」。
          </span>
          <div className="flex items-center gap-2">
            <span>目前篩選:</span>
            <button
              type="button"
              onClick={() => setCategoryFilter('ALL')}
              className={`underline cursor-pointer ${
                categoryFilter === 'ALL'
                  ? 'text-amber-300 font-semibold'
                  : 'text-slate-400'
              }`}
            >
              顯示全部 ({scanData?.candidates.length ?? 0})
            </button>
          </div>
        </div>

        {/* SECTION 1: Full Market Radar + Selected Symbol SMC/ICT Detail Split (Apple Stocks Two-Column Workstation + Plain-Language Guide) */}
        {activeSection === 'paper_quality' && (
          <div className="order-3 apple-bento-card p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">
                  長期 Paper 品質監控中心（30d / 60d / 90d 樣本累積、Gate 穩定度與市場狀態分層）
                </h2>
                <p className="text-xs text-amber-300 font-semibold mt-1">
                  目前樣本不足，不代表策略有效或無效 · {paperQualityStatus?.sampleSufficiencyNotice ?? '樣本不足，僅供觀察'}
                </p>
              </div>
              <div className="text-xs font-mono text-slate-400">
                PAPER ONLY · LIVE ORDERS DISABLED · NEVER AUTO-PLACE ORDERS
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 font-mono text-xs">
              {(paperQualityRegimes?.dimensionList ?? []).map((dim) => (
                <div
                  key={dim.dimension}
                  className="border border-slate-800 bg-slate-950/70 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">{dim.label}</span>
                    <span className="text-[11px] text-amber-300">
                      {dim.currentMarketState}
                    </span>
                  </div>
                  {dim.buckets.map((b) => (
                    <div
                      key={b.bucketKey}
                      className="flex items-center justify-between text-[11px] text-slate-300 border-t border-slate-800/60 pt-1"
                    >
                      <span>{b.bucketLabel}</span>
                      <span>
                        評估 {b.evaluatedCount} · 訊號 {b.signalCount} · 結算{' '}
                        {b.paperClosed} ({b.sampleSufficiency})
                      </span>
                    </div>
                  ))}
                  <div className="text-[10px] text-slate-400 pt-1">
                    {dim.conclusion}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {activeSection === 'radar' && (
          <div className="order-3 grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
            {/* Left Column (60%): Candidate Table */}
            <div className="xl:col-span-7 apple-bento-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-base font-semibold tracking-tight text-slate-100">
                      USDT 永續合約候選清單 ({filteredCandidates.length})
                    </h2>
                    <span className="text-[11px] font-medium text-amber-300">
                      · 左欄快篩表 · 點擊任一幣種即可在右側查看 K 線與白話文 5 步闖關診斷
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    明確分離「第一層：市場雷達分類」、「第二層：SMC 評估狀態 (PENDING 尚未評估 vs EVALUATED 已評估)」與「最終交易訊號」
                  </p>
                </div>
                <div className="apple-segmented-track flex flex-wrap items-center gap-1 p-1 text-[11px]">
                  {(
                    [
                      { key: 'ALL', label: '全部標的' },
                      { key: 'WATCHLIST', label: `★ 觀察清單 (${watchlist.length})` },
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
                      onClick={() => setCategoryFilter(f.key)}
                      className={`px-2.5 py-1 text-[11px] cursor-pointer transition-all ${
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

              <div className="max-h-[680px] overflow-x-auto overflow-y-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#11131a]/95 backdrop-blur-md text-slate-400">
                    <tr>
                      <th className="py-3 pl-5 pr-2 font-medium">觀察</th>
                      <th className="py-3 px-2 font-medium">合約標的</th>
                      <th className="py-3 px-2 font-medium">
                        第一層：市場雷達分類 / 第二層：SMC 評估狀態 / 最終交易訊號
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        Score
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        最新價格 / Spread
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        24h 漲跌
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        歷史量能 (RVOL / Z)
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        24h 成交額 (輔助 PR)
                      </th>
                      <th className="py-3 px-2 text-right font-medium">
                        Funding
                      </th>
                      <th className="py-3 pl-2 pr-5 text-right font-medium">
                        OI (點選載入)
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                    {scanLoading ? (
                      Array.from({ length: 8 }).map((_, idx) => (
                        <tr key={idx} className="animate-pulse">
                          <th
                            colSpan={10}
                            className="py-3.5 px-5 text-left font-normal text-slate-600"
                          >
                            正在載入並計算全市場規則證據...
                          </th>
                        </tr>
                      ))
                    ) : filteredCandidates.length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          className="py-12 text-center font-sans text-sm text-slate-400"
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
                        const loadedOi = loadedOiBySymbol[c.symbol];
                        const oiValue =
                          loadedOi?.oiValue ?? c.openInterestValue;
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

                        return (
                          <tr
                            key={c.symbol}
                            onClick={() =>
                              loadSymbolDetail(c.symbol, selectedTimeframe)
                            }
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-amber-500/12 text-slate-100'
                                : 'hover:bg-slate-800/40 text-slate-300'
                            }`}
                          >
                            <td
                              className="py-3 pl-5 pr-2"
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
                            <td className="py-3 px-2 font-semibold text-slate-100 whitespace-nowrap">
                              <div className="tracking-tight">{c.symbol}</div>
                              <div className="text-[10px] font-normal text-slate-400">
                                {c.provenance.isDemo ? 'DEMO' : 'LIVE'} ·{' '}
                                {c.isLowLiquidity
                                  ? '低流動性'
                                  : '主流流動性'}
                              </div>
                            </td>
                            <td className="py-3 px-2 font-sans whitespace-nowrap">
                              <div
                                className={getMarketRadarTextColor(
                                  c.marketRadarCategory
                                )}
                              >
                                第一層：{c.marketRadarCategory}{' '}
                                <span className="text-[10px] font-normal text-slate-400">
                                  (非交易訊號)
                                </span>
                              </div>
                              <div className="mt-0.5 text-[10px] font-mono text-slate-400">
                                第二層：
                                {rowSmcEvalStatus === 'PENDING' ||
                                rowSmcState === 'PENDING' ? (
                                  <span className="text-slate-400 font-semibold">
                                    SMC 尚未評估／點擊載入單幣種結構 (PENDING)
                                  </span>
                                ) : (
                                  <span
                                    className={`font-semibold ${getSmcStateColor(
                                      rowSmcState
                                    )}`}
                                  >
                                    SMC {rowSmcState} ({rowSmcEvalStatus})
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[10px] font-mono text-slate-400">
                                最終交易訊號：
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
                                </span>{' '}
                                <span className="text-slate-500">
                                  · 分類:{c.finalCategory}
                                </span>
                              </div>
                              {c.decisionTrace?.downgradeReasons &&
                                c.decisionTrace.downgradeReasons.length > 0 && (
                                  <div
                                    className="mt-0.5 max-w-[230px] truncate text-[10px] font-mono text-amber-300/90"
                                    title={c.decisionTrace.downgradeReasons.join(
                                      ' | '
                                    )}
                                  >
                                    降級原因:{' '}
                                    {c.decisionTrace.downgradeReasons[0].split(
                                      ':'
                                    )[0] || c.decisionTrace.downgradeReasons[0]}
                                  </div>
                                )}
                              <div
                                className={`mt-1 max-w-[260px] whitespace-normal text-[11px] font-sans ${rowPlain.toneClass}`}
                              >
                                💡 {rowPlain.headline}
                              </div>
                            </td>
                            <td className="py-3 px-2 text-right font-semibold text-slate-100 whitespace-nowrap">
                              <div>{c.score}</div>
                              {c.scoreCapApplied && (
                                <div className="text-[10px] font-normal text-amber-400">
                                  原始 {c.rawScoreBeforeCap} (Cap 48)
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right whitespace-nowrap">
                              <div>${formatPriceDynamic(c.lastPrice)}</div>
                              <div className="text-[10px] text-slate-400">
                                {c.spreadPercent !== null
                                  ? `Spread ${c.spreadPercent.toFixed(3)}%`
                                  : 'Spread 資料不可用'}
                              </div>
                            </td>
                            <td
                              className={`py-3 px-2 text-right font-medium ${
                                c.priceChangePercent24h >= 0
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              <div>
                                {c.priceChangePercent24h >= 0 ? '+' : ''}
                                {c.priceChangePercent24h.toFixed(2)}%
                              </div>
                              <div className="text-[10px] text-slate-400">
                                vs BTC {c.relativeBtcStrength >= 0 ? '+' : ''}
                                {c.relativeBtcStrength.toFixed(1)}%
                              </div>
                            </td>
                            <td className="py-3 px-2 text-right whitespace-nowrap">
                              {hv.status === 'READY' ? (
                                <>
                                  <div
                                    className={
                                      hv.isHistoricalAnomaly
                                        ? 'text-amber-300 font-semibold'
                                        : 'text-slate-200'
                                    }
                                  >
                                    RVOL {hv.rvol}x ({hv.volumeTimeframe ?? '15m'})
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    Z={hv.zScore} (N={hv.sampleCount})
                                  </div>
                                </>
                              ) : hv.status === 'BASELINE_UNSTABLE' ? (
                                <>
                                  <div className="text-[10px] text-amber-400 font-semibold">
                                    BASELINE_UNSTABLE ({hv.sampleCount}/
                                    {hv.minRequiredSamples})
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    MAD/Med{' '}
                                    {(
                                      (hv.madToMedianRatio ?? 0) * 100
                                    ).toFixed(1)}
                                    % · {hv.volumeTimeframe ?? '15m'}
                                  </div>
                                </>
                              ) : (
                                <div className="text-[10px] text-slate-500 font-sans">
                                  INSUFFICIENT_HISTORY ({hv.sampleCount}/
                                  {hv.minRequiredSamples} ·{' '}
                                  {hv.volumeTimeframe ?? '15m'})
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right whitespace-nowrap">
                              <div>${formatUsdCompact(c.quoteVolume24h)}</div>
                              <div className="text-[10px] text-slate-400">
                                輔助 PR{' '}
                                {c.auxiliaryVolumeRankProxyPercentile.toFixed(
                                  0
                                )}
                              </div>
                            </td>
                            <td
                              className={`py-3 px-2 text-right whitespace-nowrap ${
                                c.extremeFunding
                                  ? 'text-amber-300 font-semibold'
                                  : 'text-slate-300'
                              }`}
                            >
                              {c.fundingRate !== null
                                ? `${(c.fundingRate * 100).toFixed(4)}%`
                                : '缺失'}
                            </td>
                            <td className="py-3 pl-2 pr-5 text-right whitespace-nowrap text-slate-300">
                              {oiValue !== null && oiValue !== undefined ? (
                                `$${formatUsdCompact(oiValue)}`
                              ) : loadedOi && loadedOi.oi === null ? (
                                <span className="text-rose-400">OI 缺失</span>
                              ) : (
                                <span className="text-slate-500 font-sans">
                                  點選載入
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
            </div>

            {/* Right Column: Selected Symbol Two-Layer Result, Decision Trace, SMC/ICT Evidence & Gemini Explainer */}
            <div className="xl:col-span-5 space-y-5">
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
                <div className="apple-bento-card p-6 space-y-5">
                  {/* Symbol Header & Two-Layer Separation Banner */}
                  <div className="space-y-3.5 border-b border-slate-800/70 pb-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-3">
                          <h3 className="text-2xl font-bold tracking-tight font-mono text-slate-100">
                            {symbolDetail.symbol}
                          </h3>
                          <span className="text-xs text-slate-400">·</span>
                          <span
                            className={`text-sm font-semibold ${getMarketRadarTextColor(
                              symbolDetail.candidate.marketRadarCategory
                            )}`}
                          >
                            {symbolDetail.candidate.marketRadarCategory} (Score:{' '}
                            {symbolDetail.candidate.score}
                            {symbolDetail.candidate.scoreCapApplied
                              ? ` / 原始 ${symbolDetail.candidate.rawScoreBeforeCap}`
                              : ''}
                            )
                          </span>
                        </div>
                        <div className="mt-1.5">
                          <ProvenanceLine
                            provenance={symbolDetail.provenance}
                            prefixLabel="單幣種詳情來源"
                            smcEvaluationStatus={
                              symbolDetail.smcAnalysis.smcEvaluationStatus
                            }
                          />
                        </div>
                      </div>

                      {/* SMC/ICT Output State Box */}
                      <div className="rounded-xl border border-slate-800/80 bg-slate-950/90 px-4 py-3 text-right">
                        <div className="text-[11px] text-slate-400">
                          第二層：SMC 評估狀態 ({symbolDetail.smcAnalysis.smcEvaluationStatus})
                        </div>
                        <div
                          className={`mt-0.5 text-base font-bold font-mono tracking-wide ${getSmcStateColor(
                            symbolDetail.smcAnalysis.actionState
                          )}`}
                        >
                          {symbolDetail.smcAnalysis.actionState === 'PENDING'
                            ? 'SMC 尚未評估／點擊載入單幣種結構'
                            : symbolDetail.smcAnalysis.actionState}
                        </div>
                        <div className="mt-1.5 flex items-center justify-end gap-2 text-[10px] font-mono text-slate-400">
                          <span>
                            SMC evaluatedAt:{' '}
                            {symbolDetail.smcAnalysis.evaluatedAt
                              ? new Date(
                                  symbolDetail.smcAnalysis.evaluatedAt
                                ).toLocaleTimeString('zh-TW', { hour12: false })
                              : new Date(
                                  symbolDetail.provenance.fetchedAt
                                ).toLocaleTimeString('zh-TW', { hour12: false })}
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
                    </div>

                    {/* Explicit Two-Layer Result Box (第一層：市場雷達分類 + 第二層：SMC 評估狀態 + 最終交易訊號 + 原因) */}
                    <div className="rounded-xl border border-slate-800/80 bg-slate-950/90 p-4 text-xs space-y-1.5">
                      <div className="font-semibold text-slate-200">
                        雙層結構判定結果（明確區分「第一層：市場雷達分類」、「第二層：SMC 評估狀態」與「最終交易訊號」）：
                      </div>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-3 font-mono">
                        <div>
                          <span className="text-slate-400">
                            第一層：市場雷達分類：
                          </span>
                          <strong
                            className={getMarketRadarTextColor(
                              symbolDetail.candidate.marketRadarCategory
                            )}
                          >
                            {symbolDetail.candidate.marketRadarCategory}
                          </strong>
                        </div>
                        <div>
                          <span className="text-slate-400">
                            第二層：SMC 評估狀態：
                          </span>
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
                        <div>
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
                      <div className="text-[11px] font-mono text-slate-400">
                        SMC evaluatedAt:{' '}
                        <span className="text-slate-200">
                          {symbolDetail.smcAnalysis.evaluatedAt ??
                            symbolDetail.candidate.smcEvaluatedAt ??
                            symbolDetail.provenance.fetchedAt}
                        </span>{' '}
                        · 資料來源與 fetchedAt:{' '}
                        <span className="text-slate-200">
                          {symbolDetail.provenance.source} (
                          {symbolDetail.smcAnalysis.dataFetchedAt ??
                            symbolDetail.candidate.smcDataFetchedAt ??
                            symbolDetail.provenance.fetchedAt}
                          )
                        </span>
                      </div>
                      <div className="text-slate-300">
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

                    {/* Template B: Plain-Language 5-Step SMC Gate Checklist & Action Advice */}
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
                                白話文 5 步闖關進度
                              </span>
                              <span className="text-slate-600">·</span>
                              <span className="text-xs font-semibold text-slate-100">
                                已通過 {plainGuide.passedCount} / 5 關
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {plainGuide.steps.map((st, i) => (
                                <span
                                  key={i}
                                  className={`h-2 w-7 rounded-full transition-colors ${
                                    st.passed ? 'bg-emerald-500' : 'bg-slate-800'
                                  }`}
                                  title={`第 ${st.stepNumber} 關: ${st.title}`}
                                />
                              ))}
                            </div>
                          </div>

                          <div
                            className={`rounded-xl border p-3.5 text-xs space-y-1 ${
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

                          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-5 text-xs">
                            {plainGuide.steps.map((st, idx) => (
                              <div
                                key={idx}
                                className={`rounded-xl border p-3 space-y-1.5 ${
                                  st.passed
                                    ? 'border-emerald-500/35 bg-emerald-950/15'
                                    : 'border-slate-800/80 bg-slate-900/50'
                                }`}
                              >
                                <div className="flex items-center justify-between font-mono text-[10px]">
                                  <span className="text-slate-400">
                                    第 {st.stepNumber} 關
                                  </span>
                                  <span
                                    className={`rounded-md font-bold px-1.5 py-0.5 ${
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
                                <div className="text-[11px] text-slate-300 leading-snug">
                                  {st.plainDesc}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Key Metrics Row: Price + Bid/Ask Spread, OI, Funding, Historical RVOL/Z */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 font-mono tabular-nums text-xs">
                    <div className="border border-slate-800/90 bg-slate-950/70 p-3">
                      <div className="font-sans text-slate-400">
                        最新價格 / 盤口 Spread
                      </div>
                      <div className="mt-1 text-sm font-semibold text-slate-100">
                        ${formatPriceDynamic(symbolDetail.candidate.lastPrice)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {symbolDetail.candidate.spreadPercent !== null
                          ? `Bid ${symbolDetail.candidate.bidPrice} / Ask ${symbolDetail.candidate.askPrice} (${symbolDetail.candidate.spreadPercent.toFixed(4)}%)`
                          : 'Spread 資料不可用'}
                      </div>
                    </div>
                    <div className="border border-slate-800/90 bg-slate-950/70 p-3">
                      <div className="font-sans text-slate-400">
                        Open Interest (OI) / Funding
                      </div>
                      <div className="mt-1 text-sm font-semibold text-slate-100">
                        {symbolDetail.openInterest.openInterestValue !== null
                          ? `$${formatUsdCompact(
                              symbolDetail.openInterest.openInterestValue
                            )}`
                          : symbolDetail.openInterest.openInterest !== null
                            ? `${symbolDetail.openInterest.openInterest}`
                            : '缺失 (觸發 WAIT)'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
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
                    <div className="border border-slate-800/90 bg-slate-950/70 p-3">
                      <div className="font-sans text-slate-400">
                        歷史量能 RVOL / Z ({symbolDetail.candidate.historicalVolume.volumeTimeframe ?? '15m'})
                      </div>
                      <div className="mt-1 text-sm font-semibold text-amber-300">
                        {symbolDetail.candidate.historicalVolume.status ===
                        'READY'
                          ? `${symbolDetail.candidate.historicalVolume.rvol}x (Z=${symbolDetail.candidate.historicalVolume.zScore})`
                          : `${symbolDetail.candidate.historicalVolume.status} (Z=${symbolDetail.candidate.historicalVolume.rawRobustZScore ?? 'N/A'})`}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {symbolDetail.candidate.historicalVolume.rollingMedian !==
                        null
                          ? `Med $${formatUsdCompact(
                              symbolDetail.candidate.historicalVolume
                                .rollingMedian ?? 0
                            )} / MAD $${formatUsdCompact(
                              symbolDetail.candidate.historicalVolume.mad ?? 0
                            )}`
                          : `N=${symbolDetail.candidate.historicalVolume.sampleCount}/${symbolDetail.candidate.historicalVolume.minRequiredSamples} · ${symbolDetail.candidate.historicalVolume.aggregationWindow ?? '15m_CONFIRMED_KLINE_30_BARS'}`}
                      </div>
                    </div>
                    <div className="border border-slate-800/90 bg-slate-950/70 p-3">
                      <div className="font-sans text-slate-400">
                        已確認 ATR(14) ({symbolDetail.primaryTimeframe})
                      </div>
                      <div className="mt-1 text-sm font-semibold text-slate-100">
                        {symbolDetail.smcAnalysis.atr14 !== null
                          ? `${symbolDetail.smcAnalysis.atr14} (${symbolDetail.smcAnalysis.atrPercent}%)`
                          : 'K 線不足'}
                      </div>
                    </div>
                  </div>

                  {/* Decision Trace & 6-Gate Inspector Panel */}
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
                      <div className="border border-slate-700 bg-slate-950 p-3.5 space-y-2.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                          <span className="font-semibold text-amber-300 font-mono">
                            Decision Trace 降級與安全閘門追蹤 (/api/symbol/
                            {symbolDetail.symbol}/decision-trace)
                          </span>
                          <span className="font-mono text-[11px] text-slate-300">
                            marketRadar: <strong>{trace.marketRadarCategory}</strong> · SMCEval:{' '}
                            <strong>{trace.smcEvaluationStatus}</strong> · SMC:{' '}
                            <strong>{trace.smcActionState}</strong> → finalTradeSignal:{' '}
                            <strong>{trace.finalTradeSignal}</strong> (finalCategory:{' '}
                            <strong>{trace.finalCategory}</strong>)
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 font-mono text-[11px]">
                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">
                                1. history gate
                              </span>
                              <span
                                className={
                                  histGate.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-amber-400 font-bold'
                                }
                              >
                                {histGate.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
                              {histGate.sampleCount}/
                              {histGate.minRequiredSamples} · {histGate.status}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              TF: {histGate.volumeTimeframe ?? '15m'} · MAD/Med: {madRatioPct}
                              {histGate.rawRobustZScore !== null &&
                              histGate.rawRobustZScore !== undefined
                                ? ` · rawZ=${histGate.rawRobustZScore}`
                                : ''}
                            </div>
                          </div>

                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">
                                2. liquidity gate
                              </span>
                              <span
                                className={
                                  trace.gates.liquidity.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-rose-400 font-bold'
                                }
                              >
                                {trace.gates.liquidity.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
                              Vol $
                              {formatUsdCompact(
                                trace.gates.liquidity.quoteVolume24h
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              Spread:{' '}
                              {trace.gates.liquidity.spreadPercent !== null
                                ? `${trace.gates.liquidity.spreadPercent.toFixed(4)}%`
                                : 'null'}
                            </div>
                          </div>

                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">
                                3. momentum gate
                              </span>
                              <span
                                className={
                                  trace.gates.momentum.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-amber-400 font-bold'
                                }
                              >
                                {trace.gates.momentum.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
                              24h:{' '}
                              {trace.gates.momentum.change24h >= 0 ? '+' : ''}
                              {trace.gates.momentum.change24h.toFixed(2)}%
                            </div>
                            <div className="text-[10px] text-slate-400">
                              門檻: |change24h| ≥ 3.0%
                            </div>
                          </div>

                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">
                                4. relativeBtc gate
                              </span>
                              <span
                                className={
                                  trace.gates.relativeBtc.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-amber-400 font-bold'
                                }
                              >
                                {trace.gates.relativeBtc.passed
                                  ? 'PASS'
                                  : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
                              vs BTC:{' '}
                              {trace.gates.relativeBtc.value >= 0 ? '+' : ''}
                              {trace.gates.relativeBtc.value.toFixed(2)}%
                            </div>
                            <div className="text-[10px] text-slate-400">
                              門檻: 同向 ≥ 1.2%
                            </div>
                          </div>

                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">
                                5. funding gate
                              </span>
                              <span
                                className={
                                  trace.gates.funding.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-rose-400 font-bold'
                                }
                              >
                                {trace.gates.funding.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
                              {trace.gates.funding.value !== null
                                ? `${(trace.gates.funding.value * 100).toFixed(4)}%`
                                : 'null'}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              門檻: |Funding| &lt; 0.05%
                            </div>
                          </div>

                          <div className="border border-slate-800 bg-slate-900/60 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">6. smc gate</span>
                              <span
                                className={
                                  trace.gates.smc.passed
                                    ? 'text-emerald-400 font-bold'
                                    : 'text-amber-400 font-bold'
                                }
                              >
                                {trace.gates.smc.passed ? 'PASS' : 'FAIL'}
                              </span>
                            </div>
                            <div className="mt-1 text-slate-200">
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
                            <ul className="list-disc pl-5 space-y-1 text-[11px] text-slate-300 font-mono">
                              {trace.downgradeReasons.map((reason, idx) => (
                                <li key={idx}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* WAIT Gate Reasons Alert */}
                  {symbolDetail.smcAnalysis.waitReasons.length > 0 && (
                    <div className="border border-amber-500/40 bg-amber-950/25 p-3.5 text-xs text-amber-200 space-y-1.5">
                      <div className="font-semibold text-amber-300 flex items-center gap-2">
                        <Clock className="h-4 w-4 shrink-0" />
                        <span>
                          WAIT 安全閘門觸發原因（條件不足、OI 缺失或結構衝突時強制輸出 WAIT）：
                        </span>
                      </div>
                      <ul className="list-disc pl-5 space-y-1 text-amber-100/90">
                        {symbolDetail.smcAnalysis.waitReasons.map((r, idx) => (
                          <li key={idx}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Multi-Timeframe Direction Alignment Strip */}
                  <div className="border border-slate-800 bg-slate-950 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-200">
                        多週期結構方向一致性 (5m / 15m / 1h / 4h)
                      </span>
                      <span className="font-mono text-slate-400">
                        {symbolDetail.smcAnalysis.mtfAlignment.description}
                      </span>
                    </div>
                    <div className="mt-2.5 grid grid-cols-4 gap-2 font-mono text-xs">
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
                            className={`border p-2 text-left transition-colors cursor-pointer ${
                              selectedTimeframe === tf
                                ? 'border-amber-500/60 bg-slate-900'
                                : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between">
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
                            <div className="mt-1 text-[10px] text-slate-400">
                              已收盤: {tfMeta?.confirmedCount ?? 0} 根
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Interactive Candlestick & SMC Structure Chart */}
                  <KlineSmcChart
                    symbol={symbolDetail.symbol}
                    timeframe={symbolDetail.primaryTimeframe}
                    klines={
                      symbolDetail.klinesByTimeframe[
                        symbolDetail.primaryTimeframe
                      ]?.klines || []
                    }
                    smcAnalysis={symbolDetail.smcAnalysis}
                  />

                  {/* SMC/ICT Evidences Table (computed strictly on closed K-lines) */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-200">
                        SMC / ICT 已確認 K 線結構證據 ({symbolDetail.primaryTimeframe} · 基於已收盤 K 線 isClosed=true)
                      </h4>
                      <span className="text-[11px] font-mono text-slate-400">
                        已收盤 K 線數: {symbolDetail.smcAnalysis.confirmedKlineCount} 根 (isClosed=true ≠ SMC 已確認) · 當前 SMC 狀態:{' '}
                        <strong
                          className={getSmcStateColor(
                            symbolDetail.smcAnalysis.actionState
                          )}
                        >
                          {symbolDetail.smcAnalysis.actionState}
                        </strong>
                      </span>
                    </div>
                    <div className="divide-y divide-slate-800 border border-slate-800 bg-slate-950 text-xs">
                      {symbolDetail.smcAnalysis.evidences.map((ev) => (
                        <div
                          key={ev.code}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-mono font-semibold ${
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
                              <span className="font-mono text-slate-300">
                                {ev.value}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400">
                              {ev.detail}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Score Breakdown & Market Scan Evidences */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-200">
                        全市場評分拆解與證據 (總分: {symbolDetail.candidate.score}/96)
                      </h4>
                      <span className="text-[11px] font-mono text-slate-400">
                        histVol:{symbolDetail.candidate.scoreBreakdown.volumeAnomaly} ·
                        auxPR:{symbolDetail.candidate.scoreBreakdown.auxiliaryVolumeRank} ·
                        mom:{symbolDetail.candidate.scoreBreakdown.momentum} ·
                        rs:{symbolDetail.candidate.scoreBreakdown.relativeBtcStrength} ·
                        fund:{symbolDetail.candidate.scoreBreakdown.fundingRisk} ·
                        liq:{symbolDetail.candidate.scoreBreakdown.liquidityRisk} ·
                        qual:{symbolDetail.candidate.scoreBreakdown.dataQuality}
                      </span>
                    </div>
                    <div className="divide-y divide-slate-800 border border-slate-800 bg-slate-950 text-xs">
                      {symbolDetail.candidate.evidences.map((ev) => (
                        <div
                          key={ev.code}
                          className="flex items-center justify-between gap-3 px-3.5 py-2"
                        >
                          <div>
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
                            <span className="text-slate-400">{ev.detail}</span>
                          </div>
                          <span className="font-mono text-slate-200 whitespace-nowrap">
                            {ev.value} ({ev.weight >= 0 ? `+${ev.weight}` : ev.weight})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Gemini AI Explanation + Paper Ledger + Backtest Actions */}
                  <div className="border border-slate-800 bg-slate-950 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                          <span>
                            Gemini 解釋層與紙上觀察操作 (PAPER ONLY)
                          </span>
                        </h4>
                        <p className="text-[11px] text-slate-400">
                          鎖定分類與 WAIT 狀態，可將此結構登記至 SQLite 紙上交易帳本追蹤
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={requestGeminiExplanation}
                          disabled={geminiLoading}
                          className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                        >
                          {geminiLoading
                            ? '正在生成解釋...'
                            : '產生 Gemini 證據解釋'}
                        </button>
                        <button
                          type="button"
                          onClick={recordPaperObservation}
                          className="rounded border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-950/50 cursor-pointer whitespace-nowrap"
                        >
                          登記紙上觀察帳本
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
                          className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                        >
                          執行回測並存檔
                        </button>
                      </div>
                    </div>

                    {geminiError && (
                      <div className="text-xs text-rose-400 font-mono">
                        {geminiError}
                      </div>
                    )}

                    {geminiResult && (
                      <div className="border-t border-slate-800 pt-3 space-y-3 text-xs">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
                          <span>
                            鎖定分類:{' '}
                            <strong className="text-slate-200">
                              {geminiResult.lockedCategory}
                            </strong>
                          </span>
                          <span>·</span>
                          <span>
                            鎖定 SMC 狀態:{' '}
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

                        <p className="text-slate-200 leading-relaxed bg-slate-900/70 p-3 border border-slate-800">
                          {geminiResult.explanationZh}
                        </p>

                        <ProvenanceLine
                          provenance={geminiResult.provenance}
                          prefixLabel="解釋層來源"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
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
                        歷史紙上勝率 (winRate)
                      </div>
                      <div className="mt-1 text-lg font-bold text-slate-100">
                        {(backtestResult.winRate ??
                          backtestResult.winRatePercent) !== null
                          ? `${backtestResult.winRate ?? backtestResult.winRatePercent}%`
                          : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[10px] font-sans text-slate-500">
                        僅歷史統計，非未來表現承諾
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        平均 R / 期望值 (expectancyR)
                      </div>
                      <div className="mt-1 text-lg font-bold text-sky-300">
                        {backtestResult.averageR !== null &&
                        backtestResult.averageR !== undefined
                          ? `${backtestResult.averageR}R`
                          : 'null (NO_TRADES)'}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        Expectancy:{' '}
                        {backtestResult.expectancyR !== null &&
                        backtestResult.expectancyR !== undefined
                          ? `${backtestResult.expectancyR}R`
                          : 'null'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        最大回撤 (maxDrawdownR)
                      </div>
                      <div className="mt-1 text-lg font-bold text-rose-400">
                        {backtestResult.maxDrawdownR !== null
                          ? `${backtestResult.maxDrawdownR} R`
                          : 'null (NO_TRADES)'}
                      </div>
                    </div>
                    <div className="border border-slate-800 bg-slate-950 p-3.5">
                      <div className="font-sans text-xs text-slate-400">
                        盈虧因子 (profitFactor)
                      </div>
                      <div className="mt-1 text-lg font-bold text-amber-300">
                        {backtestResult.profitFactor !== null
                          ? backtestResult.profitFactor
                          : 'null (NO_TRADES)'}
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
                                {w.winRate !== null ? `${w.winRate}%` : 'null'}
                              </td>
                              <td className="py-2 px-2.5 text-right text-sky-300">
                                {w.averageR !== null ? `${w.averageR}R` : 'null'}
                              </td>
                              <td className="py-2 px-2.5 text-right text-rose-400">
                                {w.maxDrawdownR !== null
                                  ? `${w.maxDrawdownR}R`
                                  : 'null'}
                              </td>
                              <td className="py-2 px-2.5 text-right text-amber-300">
                                {w.profitFactor ?? 'null'}
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
                                  tr.rMultiple > 0
                                    ? 'text-emerald-400 font-bold'
                                    : tr.rMultiple < 0
                                      ? 'text-rose-400 font-bold'
                                      : 'text-slate-300'
                                }
                              >
                                {tr.outcome} ({tr.rMultiple > 0 ? '+' : ''}
                                {tr.rMultiple}R)
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
                                  Point-in-Time K 線時間: openTime=
                                  {new Date(
                                    tr.pointInTimeEvidence.barOpenTime
                                  ).toISOString()}{' '}
                                  · closeTime=
                                  {new Date(
                                    tr.pointInTimeEvidence.barCloseTime
                                  ).toISOString()}{' '}
                                  · decisionAt={tr.pointInTimeEvidence.decisionAt}
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
                                    ? new Date(tr.pointInTimeEvidence.oiDataTimestamp).toISOString()
                                    : 'N/A'}{' '}
                                  · 歷史 Funding 對齊: fundingRate=
                                  {tr.pointInTimeEvidence.fundingRate ?? tr.pointInTimeEvidence.funding ?? 'N/A'} ·
                                  fundingDataTimestamp=
                                  {tr.pointInTimeEvidence.fundingDataTimestamp
                                    ? new Date(tr.pointInTimeEvidence.fundingDataTimestamp).toISOString()
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

            {/* Persisted SQLite Backtest Reports Table */}
            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-semibold text-slate-200">
                SQLite 持久化歷史回測報表庫 ({backtestReports.length} 筆)
              </h3>
              <div className="border border-slate-800 bg-slate-950 overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="border-b border-slate-800 text-slate-400">
                    <tr>
                      <th className="py-2.5 px-3">ID / RunID</th>
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
                    {backtestReports.length === 0 ? (
                      <tr>
                        <td
                          colSpan={11}
                          className="py-6 text-center font-sans text-slate-500"
                        >
                          尚無歷史回測報表紀錄
                        </td>
                      </tr>
                    ) : (
                      backtestReports.map((rep) => (
                        <tr key={rep.id ?? rep.backtestRunId}>
                          <td className="py-2 px-3 text-slate-400">
                            #{rep.id ?? '-'}{' '}
                            {rep.backtestRunId
                              ? `(${rep.backtestRunId.slice(0, 16)})`
                              : ''}
                          </td>
                          <td className="py-2 px-3 text-slate-300">
                            {rep.createdAt
                              ? new Date(rep.createdAt).toLocaleTimeString(
                                  'zh-TW',
                                  { hour12: false }
                                )
                              : ''}
                          </td>
                          <td className="py-2 px-3 font-semibold text-slate-100">
                            {rep.symbol} · {rep.exchange} · {rep.timeframe}
                          </td>
                          <td className="py-2 px-3">
                            <span className="text-amber-300 mr-1.5">
                              [{rep.dataClassification ?? (rep.provenance.isDemo ? 'DEMO' : 'REAL')}]
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
                            {rep.longCount !== undefined && rep.longCount !== null
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
                      ))
                    )}
                  </tbody>
                </table>
              </div>
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

            <div className="border border-slate-800 bg-slate-950 overflow-x-auto">
              <table className="w-full text-left text-xs font-mono tabular-nums">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="py-2.5 px-3">ID</th>
                    <th className="py-2.5 px-3">標的 / 交易所</th>
                    <th className="py-2.5 px-3">方向 / 狀態</th>
                    <th className="py-2.5 px-3 text-right">紙上記錄價</th>
                    <th className="py-2.5 px-3 text-right">結構失效參考</th>
                    <th className="py-2.5 px-3 text-right">結構目標參考</th>
                    <th className="py-2.5 px-3 text-right">目前/結算價</th>
                    <th className="py-2.5 px-3 text-right">紙上 R 值</th>
                    <th className="py-2.5 px-3">資料來源與時間</th>
                    <th className="py-2.5 px-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {paperLedger.length === 0 ? (
                    <tr>
                      <td
                        colSpan={10}
                        className="py-8 text-center font-sans text-slate-500"
                      >
                        目前尚無紙上交易觀察紀錄。請在雷達選取幣種後點擊「登記紙上觀察帳本」。
                      </td>
                    </tr>
                  ) : (
                    paperLedger.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-2.5 px-3 text-slate-400">
                          #{entry.id}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-slate-100">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{entry.symbol}</span>
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
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
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
                          <span className="text-slate-300">{entry.status}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          ${formatPriceDynamic(entry.entryPrice)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-400">
                          ${formatPriceDynamic(entry.invalidationPrice)}
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
                            entry.pnlR > 0
                              ? 'text-emerald-400'
                              : entry.pnlR < 0
                                ? 'text-rose-400'
                                : 'text-slate-300'
                          }`}
                        >
                          {entry.pnlR > 0 ? '+' : ''}
                          {entry.pnlR}R ({entry.pnlPercent > 0 ? '+' : ''}
                          {entry.pnlPercent}%)
                        </td>
                        <td className="py-2.5 px-3 text-[10px] text-slate-400">
                          <div>{entry.provenance.source.slice(0, 38)}</div>
                          <div>
                            {new Date(entry.openedAt).toLocaleString('zh-TW', {
                              hour12: false,
                            })}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {entry.status === 'OPEN' ? (
                            <button
                              type="button"
                              onClick={() =>
                                closePaperPosition(entry.id, entry.currentPrice)
                              }
                              className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
                            >
                              紙上平倉結算
                            </button>
                          ) : (
                            <span className="text-slate-500">已結算</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* SECTION 5: Background Scan Scheduler (Dry-Run Notifications) & Data Quality Report */}
        {activeSection === 'notifications' && (
          <div className="order-3 grid grid-cols-1 gap-6 lg:grid-cols-12">
            <section className="lg:col-span-7 border border-slate-800 bg-slate-900/30 p-5 space-y-5">
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
                                  ? new Date(
                                      sig.signalBarCloseTime
                                    ).toISOString()
                                  : 'N/A'}
                              </strong>
                            </span>
                            <span>
                              signalDetectedAt:{' '}
                              <strong className="text-slate-200">
                                {sig.signalDetectedAt ?? sig.evaluatedAt}
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

