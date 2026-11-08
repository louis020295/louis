import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildDemoHistoricalVolumeMap,
  DemoExchangeAdapter,
} from '../server/adapters/ExchangeAdapter.ts';
import { RadarDatabase } from '../server/db/RadarDatabase.ts';
import { runMarketScan } from '../server/engine/MarketScanner.ts';
import {
  evaluateSmcStructure,
  SMC_RULE_VERSION,
} from '../server/engine/SmcRuleEngine.ts';
import { evaluateHistoricalVolumeAnomaly } from '../server/engine/VolumeAnomalyEngine.ts';
import { FinalTradeSignal } from '../src/types/market.ts';

describe('Phase 6: 多空 SMC 候選為 0 的完整診斷與連續 3 週期穩定度驗證', () => {
  it('1. Demo 固定測試集驗證：DemoExchangeAdapter 可正常產生 LONG CANDIDATE、SHORT CANDIDATE、WAIT、WATCH、HIGH RISK，且 finalCategorySmcMismatchCount = 0', async () => {
    const demoAdapter = new DemoExchangeAdapter();
    const snapshot = await demoAdapter.fetchMarketSnapshot();
    const histMap = buildDemoHistoricalVolumeMap();
    const preScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
      mode: 'demo',
      exchange: 'demo_synthetic',
      volumeTimeframe: '15m',
      historicalVolumeMap: histMap,
    });

    const smcMap = new Map<string, any>();
    let longCount = 0;
    let shortCount = 0;
    let waitCount = 0;
    let watchCount = 0;
    let highRiskCount = 0;

    for (const ticker of snapshot.tickers) {
      const preCandidate = preScan.candidates.find(
        (c) => c.symbol === ticker.symbol
      );
      const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
        demoAdapter.fetchOpenInterest(ticker.symbol, ticker.lastPrice),
        demoAdapter.fetchKlines(ticker.symbol, '5m', 90),
        demoAdapter.fetchKlines(ticker.symbol, '15m', 90),
        demoAdapter.fetchKlines(ticker.symbol, '1h', 90),
        demoAdapter.fetchKlines(ticker.symbol, '4h', 90),
      ]);

      const series15m = histMap.get(ticker.symbol) ?? [];
      const current15mVol =
        ticker.latestConfirmed15mQuoteVolume ??
        (series15m.length >= 31 ? series15m[series15m.length - 1] : null);
      const baseline15mVols =
        series15m.length >= 31 ? series15m.slice(0, -1) : series15m;

      const histVol =
        preCandidate?.historicalVolume ??
        evaluateHistoricalVolumeAnomaly({
          symbol: ticker.symbol,
          exchange: 'demo_synthetic',
          currentVolume: current15mVol,
          historicalVolumes: baseline15mVols,
          volumeTimeframe: '15m',
          baseProvenance: ticker.provenance,
        });

      const smcRes = evaluateSmcStructure({
        symbol: ticker.symbol,
        primaryTimeframe: '15m',
        klinesByTimeframe: {
          '5m': k5m.klines,
          '15m': k15m.klines,
          '1h': k1h.klines,
          '4h': k4h.klines,
        },
        openInterest: oiRes.openInterest,
        historicalVolume: histVol,
        isLowLiquidity:
          preCandidate?.isLowLiquidity ?? ticker.quoteVolume24h < 15_000_000,
        extremeFunding:
          preCandidate?.extremeFunding ??
          (ticker.fundingRate !== null &&
            Math.abs(ticker.fundingRate) >= 0.0005),
        lowLiquidityHighVolatility:
          preCandidate?.lowLiquidityHighVolatility ?? false,
        requireFullMultiTimeframe: true,
        provenance: ticker.provenance,
      });

      if (smcRes.actionState === 'LONG CANDIDATE') {
        longCount++;
        assert.equal(
          smcRes.waitReasons.length,
          0,
          'LONG CANDIDATE 通過完整條件時 waitReasons 必須為空陣列'
        );
      } else if (smcRes.actionState === 'SHORT CANDIDATE') {
        shortCount++;
        assert.equal(
          smcRes.waitReasons.length,
          0,
          'SHORT CANDIDATE 通過完整條件時 waitReasons 必須為空陣列'
        );
      } else if (smcRes.actionState === 'WAIT') {
        waitCount++;
        assert.ok(
          smcRes.waitReasons.length > 0,
          'WAIT 必須具備具體 waitReasons 阻擋原因'
        );
      } else if (smcRes.actionState === 'WATCH') {
        watchCount++;
        assert.ok(
          smcRes.waitReasons.length > 0,
          'WATCH 必須具備具體 waitReasons 原因'
        );
      } else if (smcRes.actionState === 'HIGH RISK') {
        highRiskCount++;
        assert.ok(
          smcRes.waitReasons.length > 0,
          'HIGH RISK 必須具備具體 waitReasons 風控攔截原因'
        );
      }

      smcMap.set(ticker.symbol, {
        smcEvaluationStatus: smcRes.smcEvaluationStatus,
        evaluationStatus: smcRes.smcEvaluationStatus,
        actionState: smcRes.actionState,
        waitReasons: smcRes.waitReasons,
        evaluatedAt: new Date().toISOString(),
        dataFetchedAt: ticker.provenance.fetchedAt,
      });
    }

    assert.ok(longCount >= 1, `Demo 必須至少產生 1 檔 LONG CANDIDATE (實際=${longCount})`);
    assert.ok(shortCount >= 1, `Demo 必須至少產生 1 檔 SHORT CANDIDATE (實際=${shortCount})`);
    assert.ok(waitCount >= 1, `Demo 必須包含 WAIT (實際=${waitCount})`);
    assert.ok(watchCount >= 1, `Demo 必須包含 WATCH (實際=${watchCount})`);
    assert.ok(highRiskCount >= 1, `Demo 必須包含 HIGH RISK (實際=${highRiskCount})`);

    const fullScan = runMarketScan(snapshot.tickers, snapshot.provenance, {
      mode: 'demo',
      exchange: 'demo_synthetic',
      volumeTimeframe: '15m',
      historicalVolumeMap: histMap,
      smcMap,
    });

    assert.equal(
      fullScan.finalCategorySmcMismatchCount,
      0,
      'Demo 全市場雙層分類 finalCategorySmcMismatchCount 必須為 0'
    );

    for (const c of fullScan.candidates) {
      if (
        c.smcActionState === 'WAIT' ||
        c.smcActionState === 'WATCH' ||
        c.smcActionState === 'HIGH RISK'
      ) {
        assert.equal(
          c.finalTradeSignal,
          'NONE',
          `${c.symbol} 當 SMC=${c.smcActionState} 時 finalTradeSignal 必須為 NONE`
        );
      } else if (
        c.smcActionState === 'LONG CANDIDATE' &&
        c.marketRadarCategory === '雷達多頭觀察' &&
        !c.isLowLiquidity &&
        !c.extremeFunding
      ) {
        assert.equal(c.finalTradeSignal, '多頭交易候選');
      } else if (
        c.smcActionState === 'SHORT CANDIDATE' &&
        c.marketRadarCategory === '雷達空頭觀察' &&
        !c.isLowLiquidity &&
        !c.extremeFunding
      ) {
        assert.equal(c.finalTradeSignal, '空頭交易候選');
      }
    }
  });

  it('2. NO_CANDIDATE_VALID vs NO_CANDIDATE_SUSPECTED vs NO_CANDIDATE_STABLE 完整判定與 11 項 SMC Gate 統計驗證', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-phase6-test-'));
    const dbPath = path.join(tmpDir, 'phase6.sqlite');
    const db = new RadarDatabase(dbPath);

    try {
      const demoAdapter = new DemoExchangeAdapter();
      const snapshot = await demoAdapter.fetchMarketSnapshot();
      const histMap = buildDemoHistoricalVolumeMap();
      const basePreScan = runMarketScan(
        snapshot.tickers,
        {
          ...snapshot.provenance,
          source: 'Binance USDⓈ-M Futures REST',
          isDemo: false,
        },
        {
          minQuoteVolume24h: 0,
          mode: 'live',
          exchange: 'binance_usdm',
          volumeTimeframe: '15m',
          historicalVolumeMap: histMap,
        }
      );

      // Select only symbols that evaluate to WAIT, WATCH, or HIGH RISK (0 candidates) with complete data
      const nonCandidateTickers: typeof snapshot.tickers = [];
      for (const t of snapshot.tickers) {
        if (t.provenance.missingData.length > 0) continue;
        const preCandidate = basePreScan.candidates.find(
          (c) => c.symbol === t.symbol
        );
        const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
          demoAdapter.fetchOpenInterest(t.symbol, t.lastPrice),
          demoAdapter.fetchKlines(t.symbol, '5m', 90),
          demoAdapter.fetchKlines(t.symbol, '15m', 90),
          demoAdapter.fetchKlines(t.symbol, '1h', 90),
          demoAdapter.fetchKlines(t.symbol, '4h', 90),
        ]);
        const series15m = histMap.get(t.symbol) ?? [];
        const histVol =
          preCandidate?.historicalVolume ??
          evaluateHistoricalVolumeAnomaly({
            symbol: t.symbol,
            exchange: 'binance_usdm',
            currentVolume: series15m[series15m.length - 1] ?? 1000000,
            historicalVolumes: series15m.slice(0, -1),
            volumeTimeframe: '15m',
            baseProvenance: {
              source: 'Binance USDⓈ-M Futures REST',
              fetchedAt: new Date().toISOString(),
              stale: false,
              fallback: false,
              missingData: [],
              isDemo: false,
            },
          });
        const checkSmc = evaluateSmcStructure({
          symbol: t.symbol,
          primaryTimeframe: '15m',
          klinesByTimeframe: {
            '5m': k5m.klines,
            '15m': k15m.klines,
            '1h': k1h.klines,
            '4h': k4h.klines,
          },
          openInterest: oiRes.openInterest ?? 5000000,
          historicalVolume: histVol,
          isLowLiquidity: preCandidate?.isLowLiquidity ?? false,
          extremeFunding: preCandidate?.extremeFunding ?? false,
          lowLiquidityHighVolatility:
            preCandidate?.lowLiquidityHighVolatility ?? false,
          requireFullMultiTimeframe: true,
          provenance: {
            source: 'Binance USDⓈ-M Futures REST',
            fetchedAt: new Date().toISOString(),
            stale: false,
            fallback: false,
            missingData: [],
            isDemo: false,
          },
        });
        if (
          checkSmc.actionState !== 'LONG CANDIDATE' &&
          checkSmc.actionState !== 'SHORT CANDIDATE'
        ) {
          nonCandidateTickers.push(t);
        }
      }

      const preScan = basePreScan;

      const runSimulatedCycle = async (windowKey: string) => {
        const nowIso = new Date().toISOString();
        db.enqueueSmcScanJobs(
          nonCandidateTickers.map((t, idx) => ({
            symbol: t.symbol,
            exchange: 'binance_usdm',
            priority: 1000 - idx,
            priorityTier: 2,
            priorityLabel: '2_RADAR_LONG',
            status: 'QUEUED',
            ruleVersion: SMC_RULE_VERSION,
            windowKey,
            requestedAt: nowIso,
            startedAt: null,
            completedAt: null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          })),
          true,
          true
        );

        for (const t of nonCandidateTickers) {
          const preCandidate = preScan.candidates.find(
            (c) => c.symbol === t.symbol
          );
          const [oiRes, k5m, k15m, k1h, k4h] = await Promise.all([
            demoAdapter.fetchOpenInterest(t.symbol, t.lastPrice),
            demoAdapter.fetchKlines(t.symbol, '5m', 90),
            demoAdapter.fetchKlines(t.symbol, '15m', 90),
            demoAdapter.fetchKlines(t.symbol, '1h', 90),
            demoAdapter.fetchKlines(t.symbol, '4h', 90),
          ]);
          const series15m = histMap.get(t.symbol) ?? [];
          const histVol =
            preCandidate?.historicalVolume ??
            evaluateHistoricalVolumeAnomaly({
              symbol: t.symbol,
              exchange: 'binance_usdm',
              currentVolume: series15m[series15m.length - 1] ?? 1000000,
              historicalVolumes: series15m.slice(0, -1),
              volumeTimeframe: '15m',
              baseProvenance: {
                source: 'Binance USDⓈ-M Futures REST',
                fetchedAt: nowIso,
                stale: false,
                fallback: false,
                missingData: [],
                isDemo: false,
              },
            });

          const smcAnalysis = evaluateSmcStructure({
            symbol: t.symbol,
            primaryTimeframe: '15m',
            klinesByTimeframe: {
              '5m': k5m.klines,
              '15m': k15m.klines,
              '1h': k1h.klines,
              '4h': k4h.klines,
            },
            openInterest: oiRes.openInterest ?? 5000000,
            historicalVolume: histVol,
            isLowLiquidity: preCandidate?.isLowLiquidity ?? false,
            extremeFunding: preCandidate?.extremeFunding ?? false,
            lowLiquidityHighVolatility:
              preCandidate?.lowLiquidityHighVolatility ?? false,
            requireFullMultiTimeframe: true,
            provenance: {
              source: 'Binance USDⓈ-M Futures REST',
              fetchedAt: nowIso,
              stale: false,
              fallback: false,
              missingData: [],
              isDemo: false,
            },
          });

          const finalTradeSignal: FinalTradeSignal = 'NONE';
          db.saveSmcScanResult({
            symbol: t.symbol,
            exchange: 'binance_usdm',
            smcEvaluationStatus: 'EVALUATED',
            smcActionState: smcAnalysis.actionState,
            finalTradeSignal,
            marketRadarCategory: preCandidate?.marketRadarCategory ?? '準備觀察',
            evaluatedAt: new Date().toISOString(),
            dataFetchedAt: nowIso,
            stale: false,
            fallback: false,
            missingData: [],
            source: 'Binance USDⓈ-M Futures REST',
            isDemo: false,
            ruleVersion: SMC_RULE_VERSION,
            waitReasons: smcAnalysis.waitReasons,
            smcAnalysis,
          });
        }

        return db.computePhase6Diagnostics('binance_usdm');
      };

      // Cycle 1: 0 candidates, all valid -> NO_CANDIDATE_VALID
      const diag1 = await runSimulatedCycle('win_cycle_1');
      assert.equal(diag1.candidateStatus, 'NO_CANDIDATE_VALID');
      assert.equal(diag1.completedCycles.length, 1);
      assert.equal(diag1.zeroCandidateVerification.allEvaluated, true);
      assert.equal(diag1.zeroCandidateVerification.allStaleFalse, true);
      assert.equal(diag1.zeroCandidateVerification.allFallbackFalse, true);
      assert.equal(diag1.zeroCandidateVerification.allMissingDataEmpty, true);
      assert.equal(diag1.zeroCandidateVerification.allCurrentRuleVersion, true);
      assert.equal(
        diag1.zeroCandidateVerification.allHaveConcreteBlockingReason,
        true
      );
      assert.equal(diag1.smcGateStatistics.conditions.length, 11);
      for (const cond of diag1.smcGateStatistics.conditions) {
        assert.equal(
          cond.bullishConditionPassCount + cond.bullishConditionFailCount,
          nonCandidateTickers.length
        );
        assert.equal(
          cond.bearishConditionPassCount + cond.bearishConditionFailCount,
          nonCandidateTickers.length
        );
      }

      // Cycle 2: 0 candidates, all valid -> still NO_CANDIDATE_VALID (2 cycles < 3)
      const diag2 = await runSimulatedCycle('win_cycle_2');
      assert.equal(diag2.candidateStatus, 'NO_CANDIDATE_VALID');
      assert.equal(diag2.completedCycles.length, 2);

      // Cycle 3: 3rd consecutive completed cycle with 0 candidates -> NO_CANDIDATE_STABLE
      const diag3 = await runSimulatedCycle('win_cycle_3');
      assert.equal(diag3.candidateStatus, 'NO_CANDIDATE_STABLE');
      assert.equal(diag3.completedCycles.length, 3);
      assert.equal(
        diag3.completedCycles[2].candidateStatus,
        'NO_CANDIDATE_STABLE'
      );

      // Now inject a suspected defect (empty waitReasons on a WAIT symbol) -> NO_CANDIDATE_SUSPECTED
      db.getRawDb()
        .prepare(
          `UPDATE smc_scan_results SET wait_reasons_json = '[]' WHERE exchange = 'binance_usdm' AND symbol = 'XRPUSDT'`
        )
        .run();
      const diagSuspected = db.computePhase6Diagnostics('binance_usdm');
      assert.equal(diagSuspected.candidateStatus, 'NO_CANDIDATE_SUSPECTED');
      assert.equal(
        diagSuspected.zeroCandidateVerification.exceptionOrDefaultWaitCount,
        1
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
