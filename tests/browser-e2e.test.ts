import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ARTIFACT_DIR =
  '/app/applet/.aistudio/artifacts/brain/6fa6d355-e4fa-41c9-9121-73133a81596f';
const PUBLIC_SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  'public',
  'screenshots'
);
const BASE_URL = 'http://localhost:3000';

describe('8. 瀏覽器端最終操作驗收測試 (Playwright Headless Chromium E2E)', () => {
  it('完整驗證 Live 成功、Live HTTP 503 失敗隔離、手動切換 Demo 警告、單幣種詳情 (Provenance/RVOL/Z/OI/Funding/SMC/WAIT)、紙上開平倉與通知 Dry-Run 並截取三種畫面', async () => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.mkdirSync(PUBLIC_SCREENSHOT_DIR, { recursive: true });

    const pwCandidates = [
      '/usr/local/share/bun-global/node_modules/playwright/index.mjs',
      '/root/.bun/install/global/node_modules/playwright/index.mjs',
    ];
    const pwModulePath =
      pwCandidates.find((p) => fs.existsSync(p)) ?? pwCandidates[0];
    const pw: any = await import(pwModulePath);

    const execCandidates = [
      '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
      '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    ];
    const executablePath = execCandidates.find((p) => fs.existsSync(p));

    const browser = await pw.chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1180 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();

      // Record all network requests made by the browser
      const recordedRequests: Array<{ method: string; url: string }> = [];
      page.on('request', (req: any) => {
        recordedRequests.push({
          method: req.method(),
          url: req.url(),
        });
      });

      const assertSafetyLabelsAlwaysVisible = async (stageName: string) => {
        const bodyText: string = await page.locator('body').innerText();
        assert.ok(
          bodyText.includes('PAPER ONLY'),
          `[${stageName}] 畫面必須顯示 PAPER ONLY`
        );
        assert.ok(
          bodyText.includes('LIVE ORDERS DISABLED'),
          `[${stageName}] 畫面必須顯示 LIVE ORDERS DISABLED`
        );
        assert.ok(
          bodyText.includes('NEVER AUTO-PLACE ORDERS'),
          `[${stageName}] 畫面必須顯示 NEVER AUTO-PLACE ORDERS`
        );
      };

      // =========================================================================
      // STEP 1 & STEP 4: Live 模式成功時顯示 LIVE 與資料來源 + 點選候選幣種顯示完整詳情
      // =========================================================================
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => (document as any).fonts?.ready);

      // Wait for Live scan candidates table and provenance to populate
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('Binance USDⓈ-M Futures REST') &&
          document.querySelectorAll('tbody tr td').length > 0,
        undefined,
        { timeout: 30000 }
      );
      await page.waitForTimeout(50);

      await assertSafetyLabelsAlwaysVisible('Step 1: Live Mode Initial');

      const liveBodyTextInitial: string = await page.locator('body').innerText();
      // Verify LIVE mode & real Binance data source are shown
      assert.ok(
        liveBodyTextInitial.includes('Binance USDⓈ-M (LIVE)'),
        '必須顯示 Binance USDⓈ-M (LIVE)'
      );
      assert.ok(
        liveBodyTextInitial.includes('Binance USDⓈ-M Futures REST'),
        '必須顯示真實 Binance USDⓈ-M Futures REST 資料來源'
      );
      // Verify Demo warning banner is NOT shown in Live mode
      assert.equal(
        liveBodyTextInitial.includes(
          '目前為 DEMO 模擬資料，非即時行情，不可用於交易判斷'
        ),
        false,
        'Live 模式成功時不得顯示 DEMO 模擬資料警告'
      );

      // Verify Top 3 Recommended, Approaching Full SMC (WATCH), and Near-Miss sections are visible on Radar
      assert.ok(
        liveBodyTextInitial.includes('當前最推薦 Top 3') &&
          liveBodyTextInitial.includes('接近 SMC 完整評估狀態 (WATCH / 結構已成形)') &&
          liveBodyTextInitial.includes('差一點就通過 (Near-Miss 差 1~2 項 Gate)'),
        '全市場雷達與結構必須顯示最推薦 Top 3、接近 SMC (WATCH) 與差一點 (Near-Miss)'
      );

      // Verify quick-filter pills for Approaching SMC and Near-Miss work and can reset to All
      const initialTableRows = await page.locator('tbody tr').count();
      await page.getByRole('button', { name: /^接近 SMC \(/ }).click();
      await page.waitForFunction(
        (total: number) => document.querySelectorAll('tbody tr').length < total,
        initialTableRows,
        { timeout: 10000 }
      );
      await page.getByRole('button', { name: /^差一點 \(/ }).click();
      await page.waitForFunction(
        (total: number) => document.querySelectorAll('tbody tr').length < total,
        initialTableRows,
        { timeout: 10000 }
      );
      await page.getByRole('button', { name: '全部標的', exact: true }).click();
      await page.waitForFunction(
        (expected: number) =>
          document.querySelectorAll('tbody tr').length === expected,
        initialTableRows,
        { timeout: 10000 }
      );

      // Click on BTCUSDT or QUSDT row in the Live table if present, otherwise 1st row
      const candidateRows = page.locator('tbody tr');
      const rowCount = await candidateRows.count();
      assert.ok(rowCount > 0, 'Live 模式成功時必須載入真實候選清單');

      const btcRow = page.locator('tbody tr', { hasText: 'BTCUSDT' });
      const qusdtRow = page.locator('tbody tr', { hasText: 'QUSDT' });
      if ((await btcRow.count()) > 0) {
        await btcRow.first().click();
      } else if ((await qusdtRow.count()) > 0) {
        await qusdtRow.first().click();
      } else {
        await candidateRows.first().click();
      }

      // Wait for symbol detail panel to finish loading
      await page.waitForFunction(
        () => {
          const text = document.body.innerText;
          return (
            text.includes('單幣種詳情來源') &&
            text.includes('第二層：SMC 評估狀態') &&
            text.includes('Decision Trace 降級與安全閘門追蹤') &&
            !text.includes('正在載入 ')
          );
        },
        undefined,
        { timeout: 30000 }
      );
      await page.waitForTimeout(50);

      const liveDetailText: string = await page.locator('body').innerText();
      // Step 4 checks on Live selected candidate: provenance, RVOL, Z-Score, OI, Funding, SMC, Two-Layer & Decision Trace
      assert.ok(
        liveDetailText.includes('單幣種詳情來源') &&
          liveDetailText.includes('source:') &&
          liveDetailText.includes('fetchedAt:') &&
          liveDetailText.includes('stale: false') &&
          liveDetailText.includes('fallback: false'),
        '點選候選幣種時必須顯示完整 provenance (source/fetchedAt/stale/fallback/missingData)'
      );
      assert.ok(
        liveDetailText.includes('歷史量能 RVOL / Z') &&
          liveDetailText.includes('Z='),
        '點選候選幣種時必須顯示歷史量能 RVOL 與 Z-Score'
      );
      assert.ok(
        liveDetailText.includes('Open Interest (OI) / Funding') &&
          liveDetailText.includes('Funding:'),
        '點選候選幣種時必須顯示 OI 與 Funding'
      );
      assert.ok(
        liveDetailText.includes('第二層：SMC 評估狀態') &&
          liveDetailText.includes('SMC / ICT 已確認 K 線結構證據'),
        '點選候選幣種時必須顯示 SMC/ICT 結構狀態與證據'
      );
      assert.ok(
        liveDetailText.includes('第一層：市場雷達分類') &&
          liveDetailText.includes('第二層：SMC 評估狀態') &&
          liveDetailText.includes('最終交易訊號') &&
          liveDetailText.includes('SMC evaluatedAt') &&
          liveDetailText.includes('原因：') &&
          liveDetailText.includes('Decision Trace 降級與安全閘門追蹤') &&
          liveDetailText.includes('volumeTimeframe:') &&
          liveDetailText.includes('aggregationWindow:'),
        '點選候選幣種時必須顯示雙層結果、SMC evaluatedAt 與 Decision Trace 摘要'
      );

      // Verify collapsible Decision Trace accordion can expand
      await page.locator('details summary', { hasText: 'Decision Trace' }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('1. history gate'),
        undefined,
        { timeout: 5000 }
      );
      await page.locator('details summary', { hasText: 'Decision Trace' }).click();

      // Verify Tab 3 (BTC 大盤連動) loads BTC K-line overlap card, then return to Tab 1
      await page.getByRole('button', { name: '3. BTC 大盤連動' }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes(
            '與比特幣 (BTCUSDT) 過去 K 線重合性與連動風險分析'
          ),
        undefined,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: '1. 結構看盤 & 關鍵位' }).click();
      await page.waitForFunction(
        () => Boolean(document.querySelector('#key-levels-session-strip')),
        undefined,
        { timeout: 5000 }
      );

      // Verify zero page-level horizontal overflow in Live mode (1440x1180)
      const liveOverflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.ok(
        liveOverflow.scrollWidth <= liveOverflow.clientWidth + 2,
        `Live 模式不應出現全域水平溢出: scrollWidth=${liveOverflow.scrollWidth}, clientWidth=${liveOverflow.clientWidth}`
      );

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(50);

      // Capture Screenshot 1: Clean Standalone Live Mode Radar
      const liveScreenshotPath1 = path.join(ARTIFACT_DIR, 'live_mode.png');
      const liveScreenshotPath2 = path.join(
        PUBLIC_SCREENSHOT_DIR,
        'live_mode.png'
      );
      await page.screenshot({ path: liveScreenshotPath1, fullPage: false });
      fs.copyFileSync(liveScreenshotPath1, liveScreenshotPath2);

      // Verify Queue Controls & Telemetry inside the consolidated Settings & Formulas Modal
      await page.getByRole('button', { name: /設定與公式/ }).click();
      await page.getByRole('button', { name: '佇列與排程控制' }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('SMC 全市場掃描進度'),
        undefined,
        { timeout: 5000 }
      );
      const modalControlsText: string = await page.getByRole('dialog').innerText();
      assert.ok(
        (modalControlsText.includes('SMC 尚未評估／點擊載入單幣種結構') ||
          modalControlsText.includes('PENDING(0)')) &&
          modalControlsText.includes('SMC 全市場掃描進度') &&
          modalControlsText.includes('掃描進度：已完成') &&
          modalControlsText.includes('RUNNING') &&
          modalControlsText.includes('IN-FLIGHT REQUESTS') &&
          modalControlsText.includes('SUCCEEDED') &&
          modalControlsText.includes('HIGH RISK') &&
          modalControlsText.includes('RATE LIMITED') &&
          modalControlsText.includes('等待重試') &&
          modalControlsText.includes('FAILED') &&
          modalControlsText.includes('不計入 PENDING') &&
          modalControlsText.includes('最後完成時間') &&
          modalControlsText.includes('資料新鮮度') &&
          modalControlsText.includes('佇列總數恆等式'),
        '設定與公式中心「佇列與排程控制」必須顯示 Phase 3 SMC 全市場掃描進度與 PENDING/WAIT 分離'
      );

      await page.getByRole('dialog').getByRole('button', { name: '漏斗與工程遙測' }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('市場雷達候選數量'),
        undefined,
        { timeout: 5000 }
      );
      const modalTelemetryText: string = await page.getByRole('dialog').innerText();
      assert.ok(
        modalTelemetryText.includes('不重複幣種數 (uniqueSymbolCount)') &&
          modalTelemetryText.includes('可重疊原因總次數') &&
          modalTelemetryText.includes('市場雷達候選數量') &&
          modalTelemetryText.includes('SMC PENDING (尚未評估)') &&
          modalTelemetryText.includes('SMC LONG CANDIDATE 數量') &&
          modalTelemetryText.includes('SMC SHORT CANDIDATE 數量') &&
          modalTelemetryText.includes('WAIT 數量'),
        '設定與公式中心「漏斗與工程遙測」必須顯示 uniqueSymbolCount/reasonOccurrenceCount 與全市場計數'
      );
      await page.getByRole('button', { name: /關閉介面/ }).click();
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]') === null,
        undefined,
        { timeout: 5000 }
      );

      // =========================================================================
      // STEP 2: Live API 失敗時顯示 HTTP 503、空候選，不得出現 Demo 資料
      // =========================================================================
      await page.route('**/api/scan*', async (route: any) => {
        const reqUrl = route.request().url();
        if (reqUrl.includes('mode=live')) {
          const headers = {
            ...route.request().headers(),
            'x-simulate-exchange-failure': '1',
          };
          await route.continue({ headers });
        } else {
          await route.continue();
        }
      });

      // Trigger scan in Live mode
      await page.getByRole('button', { name: /執行全市場掃描/ }).click();

      await page.waitForFunction(
        () =>
          document.body.innerText.includes(
            '即時資料不可用 (HTTP 503) — 候選清單已清空，系統禁止自動切換為假資料'
          ),
        { timeout: 10000 }
      );
      await page.waitForTimeout(50);

      await assertSafetyLabelsAlwaysVisible('Step 2: Live API Failure 503');
      const failureBodyText: string = await page.locator('body').innerText();

      assert.ok(
        failureBodyText.includes('即時資料不可用 (HTTP 503)'),
        'Live API 失敗時必須明確顯示 HTTP 503 與即時資料不可用'
      );
      assert.ok(
        failureBodyText.includes('USDT 永續合約候選清單 (0)'),
        'Live API 失敗時候選清單數量必須為 0 (空候選)'
      );
      assert.ok(
        failureBodyText.includes(
          '即時資料不可用（候選清單已清空）。請重試即時連線，或手動按下「切換 Demo 驗證模式」。'
        ),
        'Live API 失敗時表格必須顯示候選清單已清空提示'
      );
      assert.equal(
        failureBodyText.includes('DEMO_SYNTHETIC_DATASET'),
        false,
        'Live API 失敗時不得混入 DEMO_SYNTHETIC_DATASET'
      );
      assert.equal(
        failureBodyText.includes(
          '目前為 DEMO 模擬資料，非即時行情，不可用於交易判斷'
        ),
        false,
        'Live API 失敗時不得自動切換成 Demo 模式'
      );

      // Capture Screenshot 2: API Failure (HTTP 503)
      const failureScreenshotPath1 = path.join(
        ARTIFACT_DIR,
        'api_failure_503.png'
      );
      const failureScreenshotPath2 = path.join(
        PUBLIC_SCREENSHOT_DIR,
        'api_failure_503.png'
      );
      await page.screenshot({ path: failureScreenshotPath1, fullPage: false });
      fs.copyFileSync(failureScreenshotPath1, failureScreenshotPath2);

      // Remove failure simulation route
      await page.unroute('**/api/scan*');

      // =========================================================================
      // STEP 3 & STEP 4 (WAIT reasons): 使用者手動切換 Demo 時顯示醒目 DEMO 警告與完整 WAIT 原因
      // =========================================================================
      await page
        .getByRole('button', { name: '切換 Demo 驗證模式', exact: true })
        .first()
        .click();

      await page.waitForFunction(
        () =>
          document.body.innerText.includes(
            '目前為 DEMO 模擬資料，非即時行情，不可用於交易判斷'
          ) && document.body.innerText.includes('DEMO_SYNTHETIC_DATASET'),
        { timeout: 10000 }
      );
      await page.waitForTimeout(50);

      // Click XRPUSDT in Demo mode to verify WAIT gate reasons + provenance + RVOL/Z + OI + Funding + SMC
      const xrpRow = page.locator('tbody tr', { hasText: 'XRPUSDT' });
      await xrpRow.first().waitFor({ state: 'visible', timeout: 10000 });
      await xrpRow.first().click();
      await page.waitForFunction(
        () =>
          !document.body.innerText.includes('正在載入 XRPUSDT') &&
          document.body.innerText.includes(
            '/api/symbol/XRPUSDT/decision-trace'
          ) &&
          document.body.innerText.includes('WAIT 安全閘門觸發原因'),
        { timeout: 10000 }
      );
      await page.waitForTimeout(50);

      await assertSafetyLabelsAlwaysVisible('Step 3: Manual Demo Mode');
      const demoBodyText: string = await page.locator('body').innerText();

      assert.ok(
        demoBodyText.includes(
          '目前為 DEMO 模擬資料，非即時行情，不可用於交易判斷'
        ),
        '手動切換 Demo 時頂部必須顯示醒目 DEMO 警告'
      );
      assert.ok(
        demoBodyText.includes(
          'mode: "demo" · isDemo: true · fallback: false · source: DEMO_SYNTHETIC_DATASET'
        ),
        'Demo 警告必須標明 mode: "demo", isDemo: true, fallback: false, source: DEMO_SYNTHETIC_DATASET'
      );
      assert.ok(
        demoBodyText.includes('WAIT 安全閘門觸發原因'),
        '點選觸發 WAIT 的候選幣種時必須顯示 WAIT 安全閘門觸發原因'
      );
      assert.ok(
        demoBodyText.includes('最終交易訊號：NONE') &&
          demoBodyText.includes('finalTradeSignal: NONE'),
        '當第二層為 WAIT 時，UI 必須明確顯示 最終交易訊號：NONE 與 finalTradeSignal: NONE'
      );

      const assertNoHorizontalOverflow = async (label: string) => {
        const overflowReport = await page.evaluate(() => {
          const docOverflow =
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 2;
          const selectors = [
            '#formal-smc-panel',
            '#early-ignition-panel',
            '#pullback-sniper-panel',
            '#entry-pullback-panel',
            '#market-breadth-sector-panel',
            '#key-levels-session-strip',
            '#microstructure-panel',
            '#derivatives-structure-panel',
            '#btc-correlation-panel',
            '#position-risk-planner',
          ];
          const brokenCards: Array<{
            selector: string;
            scrollWidth: number;
            clientWidth: number;
          }> = [];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.scrollWidth > el.clientWidth + 2) {
              brokenCards.push({
                selector: sel,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
              });
            }
          }
          return {
            docOverflow,
            docScrollWidth: document.documentElement.scrollWidth,
            docClientWidth: document.documentElement.clientWidth,
            brokenCards,
          };
        });
        assert.equal(
          overflowReport.docOverflow,
          false,
          `[${label}] 頁面不應出現水平捲動溢出 (scrollWidth=${overflowReport.docScrollWidth}, clientWidth=${overflowReport.docClientWidth})`
        );
        assert.deepEqual(
          overflowReport.brokenCards,
          [],
          `[${label}] 卡片內部數字或元素不應水平溢出: ${JSON.stringify(overflowReport.brokenCards)}`
        );
      };

      // Verify Workstation Tab 1 (default) + Unified Market Intel Dock (incl. Formal SMC, Early Ignition & Anti-Chase Pullback panel)
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('產生 Gemini 證據解釋') &&
          document.body.innerText.includes('WAIT 安全閘門觸發原因') &&
          document.body.innerText.includes('正式 SMC 確認清單') &&
          Boolean(document.querySelector('#formal-smc-panel')) &&
          Boolean(document.querySelector('#early-ignition-panel')) &&
          Boolean(document.querySelector('#pullback-sniper-panel')) &&
          Boolean(document.querySelector('#entry-pullback-panel')) &&
          Boolean(document.querySelector('#market-breadth-sector-panel')) &&
          Boolean(document.querySelector('#key-levels-session-strip')),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 1 (1440x1180)');

      // Verify Formal SMC, Early Ignition & Pullback Sniper quick filter pills work cleanly and reset to 全部標的
      const demoTotalRows = await page.locator('tbody tr').count();
      await page.getByRole('button', { name: /^正式 SMC \(/ }).click();
      await page.waitForFunction(
        (total: number) => {
          const rows = document.querySelectorAll('tbody tr').length;
          return rows > 0 && rows < total;
        },
        demoTotalRows,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /^早鳥 \(/ }).click();
      await page.waitForFunction(
        (total: number) => {
          const rows = document.querySelectorAll('tbody tr').length;
          return rows > 0 && rows < total;
        },
        demoTotalRows,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /^回踩狙擊 \(/ }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('回踩狙擊雷達'),
        undefined,
        { timeout: 5000 }
      );
      await page.waitForFunction(
        (total: number) => document.querySelectorAll('tbody tr').length <= total,
        demoTotalRows,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: '全部標的', exact: true }).click();
      await page.waitForFunction(
        (total: number) => document.querySelectorAll('tbody tr').length === total,
        demoTotalRows,
        { timeout: 5000 }
      );

      // Verify Workstation Tab 2: 籌碼與微結構
      await page.getByRole('button', { name: '2. 籌碼與微結構' }).click();
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('#microstructure-panel')) &&
          Boolean(document.querySelector('#derivatives-structure-panel')),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 2 (1440x1180)');

      // Verify Workstation Tab 3: BTC 大盤連動
      await page.getByRole('button', { name: '3. BTC 大盤連動' }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('Pearson 相關係數') &&
          document.body.innerText.includes('K 線同向重疊率') &&
          Boolean(document.querySelector('#btc-correlation-panel svg path')),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 3 (1440x1180)');

      // Verify Workstation Tab 4: 風控試算 & 診斷
      await page.getByRole('button', { name: '4. 風控試算 & 診斷' }).click();
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('#position-risk-planner')) &&
          document.body.innerText.includes('白話文 5 步闖關進度明細'),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 4 (1440x1180)');

      // Verify Full-Width Expand / Restore Dual-Pane toggle & zero-overflow at 1280x900
      await page.getByRole('button', { name: '展開全寬看盤' }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('恢復雙欄') &&
          document.querySelectorAll('tbody tr').length === 0,
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 4 Full-Width (1440x1180)');
      await page.getByRole('button', { name: '恢復雙欄' }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('展開全寬看盤') &&
          document.querySelectorAll('tbody tr').length > 0,
        undefined,
        { timeout: 5000 }
      );

      // Check zero horizontal overflow at narrower 1280x900 viewport across Tab 1 & Tab 2
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: '2. 籌碼與微結構' }).click();
      await page.waitForFunction(
        () => Boolean(document.querySelector('#microstructure-panel')),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 2 (1280x900)');
      await page.getByRole('button', { name: '1. 結構看盤 & 關鍵位' }).click();
      await page.waitForFunction(
        () => Boolean(document.querySelector('#key-levels-session-strip')),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Demo Tab 1 (1280x900)');
      await page.setViewportSize({ width: 1440, height: 1180 });
      await page.waitForTimeout(50);

      // Verify Key Levels / VWAP overlay toggle on interactive chart
      await page.getByRole('button', { name: /關鍵位\/VWAP/ }).first().click();
      await page.waitForFunction(
        () => document.body.innerText.includes('關鍵位/VWAP 關'),
        undefined,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /關鍵位\/VWAP/ }).first().click();
      await page.waitForFunction(
        () => document.body.innerText.includes('關鍵位/VWAP 開'),
        undefined,
        { timeout: 5000 }
      );

      // Verify Interactive Price Alert Drawer open, add alert, and close cleanly
      await page.getByRole('button', { name: /條件告警/ }).first().click();
      await page.waitForFunction(
        () => Boolean(document.querySelector('#price-alert-drawer')),
        undefined,
        { timeout: 5000 }
      );
      const targetInput = page
        .locator('#price-alert-drawer')
        .getByPlaceholder('輸入觸發價位');
      await targetInput.fill('999999');
      await page
        .locator('#price-alert-drawer')
        .getByRole('button', { name: '加入監控告警' })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('#price-alert-drawer')
            ?.textContent?.includes('已設定條件 (1)') ?? false,
        undefined,
        { timeout: 5000 }
      );
      await page
        .locator('#price-alert-drawer')
        .getByRole('button', { name: '關閉' })
        .click();
      await page.waitForFunction(
        () => document.querySelector('#price-alert-drawer') === null,
        undefined,
        { timeout: 5000 }
      );

      // Verify Multi-Chart Split toggle & revert cleanly
      await page.getByRole('button', { name: /多圖同框/ }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('切換回單圖模式') &&
          document.body.innerText.includes('BTCUSDT 大盤基準'),
        undefined,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: '切換回單圖模式' }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('多圖同框'),
        undefined,
        { timeout: 5000 }
      );

      // Verify Sector Filter click + reset back to 全部板塊
      await page
        .locator('#market-breadth-sector-panel')
        .getByText('主流公鏈 L1')
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('全部板塊') &&
          document.querySelectorAll('tbody tr').length < 18,
        undefined,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: '全部板塊' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 18,
        undefined,
        { timeout: 5000 }
      );

      // Capture Screenshot 3: Clean Standalone Demo Mode Radar
      const demoScreenshotPath1 = path.join(ARTIFACT_DIR, 'demo_mode.png');
      const demoScreenshotPath2 = path.join(
        PUBLIC_SCREENSHOT_DIR,
        'demo_mode.png'
      );
      await page.screenshot({ path: demoScreenshotPath1, fullPage: false });
      fs.copyFileSync(demoScreenshotPath1, demoScreenshotPath2);

      // Verify 5-Stage Candidate Funnel inside Settings & Formulas Modal
      await page.getByRole('button', { name: /設定與公式/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: '漏斗與工程遙測' }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('1. 第一層雷達觀察') &&
          document.body.innerText.includes('2. 第二層 SMC 已評估') &&
          document.body.innerText.includes('3. SMC 候選') &&
          document.body.innerText.includes('4. Paper 合格訊號') &&
          document.body.innerText.includes('5. 已錯過進場窗口'),
        undefined,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /關閉介面/ }).click();
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]') === null,
        undefined,
        { timeout: 5000 }
      );

      // =========================================================================
      // STEP 5: 紙上開倉與平倉只寫入 paper ledger (跳轉至 紙上交易帳本)，不呼叫任何交易所 private API
      // =========================================================================
      const requestsBeforePaper = recordedRequests.length;

      await page.getByRole('button', { name: '登記紙上觀察帳本' }).click();

      await page.waitForFunction(
        () =>
          document.body.innerText.includes(
            'SQLite 持久化紙上交易觀察帳本 (Paper Trading Ledger — PAPER ONLY / LIVE ORDERS DISABLED)'
          ) &&
          document.body.innerText.includes(
            'DEMO · 非即時資料 · 不計入 Live Paper 績效'
          ) &&
          document.body.innerText.includes('紙上平倉結算') &&
          Boolean(document.querySelector('#paper-portfolio-btc-exposure')) &&
          Boolean(document.querySelector('#paper-track-comparison-panel')) &&
          document.body.innerText.includes('分軌勝率與回踩成效統計') &&
          document.body.innerText.includes('早鳥起漲進場 (Early Ignition)') &&
          document.body.innerText.includes('正式 SMC 現價進場') &&
          document.body.innerText.includes('FVG / OB 回踩限價進場') &&
          document.body.innerText.includes('待觸價掛單 (') &&
          document.body.innerText.includes('已過期/撤銷 ('),
        { timeout: 10000 }
      );

      await assertSafetyLabelsAlwaysVisible('Step 5: Paper Ledger Open');

      // Click close button on the first open paper position
      await page
        .getByRole('button', { name: '紙上平倉結算' })
        .first()
        .click();

      await page.waitForFunction(
        () => document.body.innerText.includes('已結算'),
        { timeout: 10000 }
      );

      const paperLedgerRequests = recordedRequests.slice(requestsBeforePaper);
      assert.ok(
        paperLedgerRequests.some(
          (r) => r.method === 'POST' && r.url.endsWith('/api/paper-ledger')
        ),
        '紙上開倉必須呼叫 POST /api/paper-ledger'
      );
      assert.ok(
        paperLedgerRequests.some(
          (r) =>
            r.method === 'POST' &&
            /\/api\/paper-ledger\/\d+\/close$/.test(r.url)
        ),
        '紙上平倉必須呼叫 POST /api/paper-ledger/:id/close'
      );

      // =========================================================================
      // STEP 6: 通知按鈕只能處理多頭/空頭交易候選並產生 Dry-Run 預覽，拒絕 WAIT 且不得真正外發
      // =========================================================================
      await page
        .getByRole('button', { name: /背景排程與品管/ })
        .click();
      await page.waitForTimeout(50);

      const requestsBeforeNotify = recordedRequests.length;

      // 6a. Currently selected symbol is XRPUSDT (WAIT -> finalTradeSignal=NONE): must be NON_CANDIDATE_BLOCKED
      await page.getByRole('button', { name: /Dry-Run Telegram/ }).first().click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('[NON_CANDIDATE_BLOCKED]') &&
          document.body.innerText.includes('TELEGRAM'),
        { timeout: 10000 }
      );

      // 6b. Switch to 全市場雷達與結構, select SOLUSDT (LONG CANDIDATE -> finalTradeSignal=多頭交易候選) and verify PREVIEW_DRY_RUN
      await page
        .getByRole('button', { name: /全市場雷達與結構/ })
        .click();
      await page.waitForTimeout(50);
      const solRow = page.locator('tbody tr', { hasText: 'SOLUSDT' });
      await solRow.first().click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('SOLUSDT') &&
          document.body.innerText.includes('LONG CANDIDATE') &&
          !document.body.innerText.includes('正在載入 '),
        { timeout: 10000 }
      );
      await page
        .getByRole('button', { name: /背景排程與品管/ })
        .click();
      await page.waitForTimeout(50);

      await page.getByRole('button', { name: /Dry-Run Telegram/ }).first().click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('[PREVIEW_DRY_RUN]') &&
          document.body.innerText.includes('SOLUSDT'),
        { timeout: 10000 }
      );

      await page.getByRole('button', { name: /Dry-Run TradingView/ }).first().click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('TRADINGVIEW_WEBHOOK') &&
          document.body.innerText.includes('僅產生預覽，未對外自動推播'),
        { timeout: 10000 }
      );

      // 6c. Verify External Notification Channels Panel (Telegram & Discord env status + test ping without external browser requests)
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('#external-notifications-panel')) &&
          document.body.innerText.includes('Telegram Bot 推播') &&
          document.body.innerText.includes('Discord Webhook 推播'),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Step 6: External Notifications Panel');
      await page
        .locator('#external-notifications-panel')
        .getByRole('button', { name: /發送測試通知/ })
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('#external-notifications-panel')?.textContent?.includes('SKIPPED_UNCONFIGURED') ||
          document.querySelector('#external-notifications-panel')?.textContent?.includes('DELIVERED'),
        undefined,
        { timeout: 8000 }
      );

      await assertSafetyLabelsAlwaysVisible('Step 6: Dry-Run Notifications');

      const notifyApiRequests = recordedRequests
        .slice(requestsBeforeNotify)
        .filter(
          (r) =>
            !r.url.startsWith('https://fonts.gstatic.com') &&
            !r.url.startsWith('https://fonts.googleapis.com')
        );
      assert.ok(
        notifyApiRequests.every((r) => r.url.startsWith(BASE_URL)),
        '通知按鈕不得向任何外部網域發送 API 請求'
      );
      assert.ok(
        notifyApiRequests.some(
          (r) => r.method === 'POST' && r.url.endsWith('/api/notify/preview')
        ),
        '通知按鈕只能呼叫本地 POST /api/notify/preview 產生 Dry-Run 預覽'
      );
      assert.ok(
        notifyApiRequests.some(
          (r) => r.method === 'POST' && r.url.endsWith('/api/notify/external/test')
        ),
        '測試推播必須透過後端代理 POST /api/notify/external/test'
      );

      // 6d. Verify Auto-Backtest Control Panel & Persisted Source Filtering
      await page.getByRole('button', { name: /無前視回測與報表/ }).click();
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('#auto-backtest-panel')) &&
          document.body.innerText.includes('自動排程回測紀錄 (Auto-Backtest Recorder)'),
        undefined,
        { timeout: 5000 }
      );
      await assertNoHorizontalOverflow('Step 6d: Auto-Backtest Panel');
      await page
        .locator('#auto-backtest-panel')
        .getByRole('button', { name: /立即執行一輪自動回測/ })
        .click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('最新批次 [SUCCESS]') &&
          document.body.innerText.includes('自動排程'),
        undefined,
        { timeout: 15000 }
      );
      await page
        .locator('#auto-backtest-panel')
        .getByRole('button', { name: '自動排程', exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length >= 1,
        undefined,
        { timeout: 5000 }
      );
      await page
        .locator('#auto-backtest-panel')
        .getByRole('button', { name: '全部來源', exact: true })
        .click();

      // =========================================================================
      // STEP 7: 長期 Paper 品質面板 (30d/60d/90d)、系統穩定性面板、深淺色模式驗證
      // =========================================================================
      await page
        .getByRole('button', { name: /長期 Paper 品質/ })
        .click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes(
            '長期 Paper 品質、樣本累積、Gate 穩定度與市場狀態分析'
          ) &&
          document.body.innerText.includes(
            '目前樣本不足，不代表策略有效或無效'
          ) &&
          document.body.innerText.includes('目前仍無已結算交易') &&
          document.body.innerText.includes('目前樣本不足，僅供觀察') &&
          document.body.innerText.includes('候選數為 0 不代表掃描失敗') &&
          document.body.innerText.includes('最新週期 (LATEST_CYCLE)') &&
          document.body.innerText.includes('去重標的 (DEDUPED_SYMBOLS)') &&
          document.body.innerText.includes('累計評估事件 (CUMULATIVE_EVENTS)') &&
          Boolean(document.querySelector('#phase12-paper-quality-panel')),
        undefined,
        { timeout: 10000 }
      );

      await assertSafetyLabelsAlwaysVisible(
        'Step 7a: Long-Term Paper Quality Panel (30d/60d/90d)'
      );

      // Verify Phase 17 System Stability telemetry (Worker states, 24h/72h windows, window vs lifetime counters, SQLite integrity)
      await page.waitForFunction(
        () =>
          document.body.innerText.includes('系統穩定性') &&
          document.body.innerText.includes('Monitor:') &&
          document.body.innerText.includes('Scan:') &&
          document.body.innerText.includes('Queue:') &&
          document.body.innerText.includes('本窗口計畫性重啟') &&
          document.body.innerText.includes('服務累計計畫性重啟') &&
          document.body.innerText.includes('SQLite 一致性與安全備份'),
        undefined,
        { timeout: 10000 }
      );
      await assertSafetyLabelsAlwaysVisible('Step 7b: System Stability Panel');

      // Verify Light Mode / Dark Mode toggle inside consolidated Settings & Formulas Modal
      await page.getByRole('button', { name: /設定與公式/ }).click();
      await page.getByRole('button', { name: '基本設定與門檻' }).click();
      await page.getByRole('button', { name: /淺色白晝/ }).click();
      await page.waitForFunction(
        () => document.querySelector('.theme-light') !== null,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /深色專業/ }).click();
      await page.waitForFunction(
        () => document.querySelector('.dark') !== null,
        { timeout: 5000 }
      );
      await page.getByRole('button', { name: /關閉介面/ }).click();
      await page.waitForFunction(
        () => document.querySelector('[role="dialog"]') === null,
        undefined,
        { timeout: 5000 }
      );


      // Global audit of all browser network requests across the entire session
      const forbiddenPatterns = [
        '/fapi/v1/order',
        '/v5/order',
        '/openApi/swap/v2/trade',
        '/api/orders',
        '/api/trades',
        '/api/execute',
        'api.telegram.org',
        'hooks.slack.com',
      ];
      for (const req of recordedRequests) {
        for (const pattern of forbiddenPatterns) {
          assert.equal(
            req.url.includes(pattern),
            false,
            `禁止呼叫任何交易所私密下單或外部通知 API: 發現 ${req.method} ${req.url}`
          );
        }
      }
    } finally {
      await browser.close();
    }
  });
});
