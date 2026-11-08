import { GoogleGenAI, Type } from '@google/genai';
import {
  GeminiExplainRequest,
  GeminiExplainResponse,
  TRADING_SAFETY_FLAGS,
} from '../../src/types/market.ts';

const PROHIBITED_TERMS = [
  '這是高勝率機會',
  '高勝率機會',
  '100%勝率',
  '高勝率',
  '勝率',
  '保證獲利',
  '保證賺',
  '收益保證',
  '保證收益',
  '穩賺',
  '必漲',
  '必跌',
  '絕對獲利',
  '建議做多',
  '建議做空',
  '建議買入',
  '建議放空',
  '可以進場',
  '立即進場',
  '立刻進場',
  '立即市價買入',
  '立即市價做空',
  '自動下單',
];

export function sanitizeTextGuardrail(text: string): string {
  let cleaned = text;
  for (const term of PROHIBITED_TERMS) {
    cleaned = cleaned.split(term).join('[已過濾違規建議或保證語句]');
  }
  return cleaned;
}

export interface GeminiExplainServiceOptions {
  customModelCaller?: (prompt: string) => Promise<string>;
}

export function buildDeterministicFallbackExplanation(
  req: GeminiExplainRequest,
  fallbackReason: string
): GeminiExplainResponse {
  const { candidate, smcAnalysis } = req;
  const passedMarket = candidate.evidences
    .filter((e) => e.passed)
    .map((e) => `${e.label}: ${e.value} (${e.detail})`);
  const passedSmc = smcAnalysis.evidences
    .filter((e) => e.passed)
    .map((e) => `${e.label}: ${e.value} (${e.detail})`);

  const mandatoryWaitAndMissing: string[] = [
    ...new Set([
      ...smcAnalysis.waitReasons,
      ...candidate.provenance.missingData.map((m) => `行情缺失欄位: ${m}`),
      ...smcAnalysis.provenance.missingData.map((m) => `結構缺失欄位: ${m}`),
    ]),
  ];

  const isWait = smcAnalysis.actionState === 'WAIT';
  const explanationZh = isWait
    ? `【WAIT 觀望鎖定】${candidate.symbol} 目前在全市場掃描歸類為「${candidate.category}」(Score: ${candidate.score})，SMC/ICT 規則引擎判定狀態為「WAIT」。原因：${
        smcAnalysis.waitReasons.join('；') || '結構條件尚未完備'
      }。根據系統安全鐵律，條件不足或資料缺失時必須維持 WAIT，嚴禁視為進場訊號。`
    : `【規則引擎證據摘要】${candidate.symbol} 目前全市場掃描分類為「${candidate.category}」(Score: ${candidate.score})，SMC/ICT 結構觀察狀態為「${smcAnalysis.actionState}」。本摘要完全基於已確認收盤 K 線與公開合約數據生成，僅供紙上觀察，不構成任何買賣指令。`;

  const riskNotesZh: string[] = [
    'PAPER ONLY / LIVE ORDERS DISABLED / NEVER AUTO-PLACE ORDERS：本系統僅供結構觀察與回測，絕不提供自動下單或止損止盈點位。',
  ];
  if (candidate.isLowLiquidity) {
    riskNotesZh.push('低流動性：不列入一般候選。');
  }
  if (candidate.extremeFunding) {
    riskNotesZh.push(
      `資金費率極端 (${((candidate.fundingRate ?? 0) * 100).toFixed(4)}%)，需留意反向擠壓風險。`
    );
  }
  if (fallbackReason) {
    riskNotesZh.push(`說明來源註記：${fallbackReason}`);
  }

  return {
    safety: TRADING_SAFETY_FLAGS,
    symbol: candidate.symbol,
    category: candidate.category,
    actionState: smcAnalysis.actionState,
    waitReasons: [...smcAnalysis.waitReasons],
    lockedCategory: candidate.category,
    lockedActionState: smcAnalysis.actionState,
    explanationZh: sanitizeTextGuardrail(explanationZh),
    passedConditionsZh: [...passedMarket, ...passedSmc],
    missingDataOrWaitReasonsZh:
      mandatoryWaitAndMissing.length > 0
        ? mandatoryWaitAndMissing
        : ['無缺失基礎欄位（所有必要公開欄位與 OI 已載入）'],
    riskNotesZh,
    guardrails: {
      ruleEngineOverridden: false,
      containsGuaranteeLanguage: false,
      waitGateEnforced: isWait ? explanationZh.includes('WAIT') : true,
      sourceEvidenceTimestamp: smcAnalysis.provenance.fetchedAt,
    },
    provenance: {
      source: `Deterministic Rule Evidence Formatter (${fallbackReason})`,
      fetchedAt: new Date().toISOString(),
      stale: candidate.provenance.stale || smcAnalysis.provenance.stale,
      fallback: false,
      missingData: [
        ...new Set([
          ...candidate.provenance.missingData,
          ...smcAnalysis.provenance.missingData,
        ]),
      ],
      isDemo: candidate.provenance.isDemo,
    },
  };
}

export async function generateGeminiExplanation(
  req: GeminiExplainRequest,
  options: GeminiExplainServiceOptions = {}
): Promise<GeminiExplainResponse> {
  const { candidate, smcAnalysis } = req;
  const apiKey = process.env.GEMINI_API_KEY;

  if (
    !options.customModelCaller &&
    (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '')
  ) {
    return buildDeterministicFallbackExplanation(
      req,
      '伺服器未設定有效 GEMINI_API_KEY，使用決定性規則證據直譯模式'
    );
  }

  const strictEvidencePayload = {
    symbol: candidate.symbol,
    lockedMarketCategory: candidate.category,
    lockedSmcActionState: smcAnalysis.actionState,
    marketScore: candidate.score,
    marketEvidences: candidate.evidences,
    smcTimeframe: smcAnalysis.primaryTimeframe,
    confirmedKlineCount: smcAnalysis.confirmedKlineCount,
    unclosedKlineIgnoredCount: smcAnalysis.unclosedKlineIgnoredCount,
    atr14: smcAnalysis.atr14,
    smcEvidences: smcAnalysis.evidences,
    waitReasons: smcAnalysis.waitReasons,
    missingData: [
      ...candidate.provenance.missingData,
      ...smcAnalysis.provenance.missingData,
    ],
    provenance: smcAnalysis.provenance,
  };

  try {
    let rawText: string | undefined;

    if (options.customModelCaller) {
      rawText = await options.customModelCaller(
        JSON.stringify(strictEvidencePayload)
      );
    } else {
      const ai = new GoogleGenAI({
        apiKey: apiKey!,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = `你是一個嚴格受控的「加密貨幣全市場行情雷達 — 規則證據解釋器」。
你只能讀取輸入的 JSON evidence，並用繁體中文解釋規則引擎的判斷依據。

絕對鐵律（違反將導致系統拒絕輸出）：
1. 絕對不可以自己捏造任何價格、Open Interest (OI)、資金費率或成交量數據，只能引用 JSON 內已有的欄位。
2. 絕對不可以改寫規則引擎的分類 (lockedMarketCategory) 與 SMC 狀態 (lockedSmcActionState)。
3. 如果 lockedSmcActionState 為 "WAIT"，你的 explanationZh 必須明確包含 "WAIT" 字樣，並清楚說明為什麼目前必須等待，絕對不可把 WAIT 轉化為買入、做多或放空建議。
4. 絕對不可產生任何勝率預測、保證獲利語句、虛構公平價、進場價、止損價、止盈價或下單指令。
5. 清楚列出已通過的條件 (passedConditionsZh)、缺失或觸發 WAIT 的原因 (missingDataOrWaitReasonsZh)，以及客觀風險提示 (riskNotesZh)。`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `請根據以下規則引擎已確認的 JSON Evidence 產生繁體中文結構化解釋：\n${JSON.stringify(
          strictEvidencePayload,
          null,
          2
        )}`,
        config: {
          systemInstruction,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              explanationZh: {
                type: Type.STRING,
                description:
                  '繁體中文綜合解釋。若狀態為 WAIT 必須明確寫出 WAIT 與原因，不得包含任何買賣點位或保證字眼。',
              },
              passedConditionsZh: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '已通過的市場與 SMC/ICT 觀察條件列表。',
              },
              missingDataOrWaitReasonsZh: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '缺失的資料欄位或導致 WAIT 的原因列表。',
              },
              riskNotesZh: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '客觀風險與資料限制提示。',
              },
            },
            required: [
              'explanationZh',
              'passedConditionsZh',
              'missingDataOrWaitReasonsZh',
              'riskNotesZh',
            ],
          },
        },
      });
      rawText = response.text;
    }

    if (!rawText) {
      return buildDeterministicFallbackExplanation(
        req,
        'Gemini 回傳空白內容，使用規則引擎標準解釋'
      );
    }

    let parsed: {
      explanationZh?: string;
      passedConditionsZh?: string[];
      missingDataOrWaitReasonsZh?: string[];
      riskNotesZh?: string[];
    };

    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      parsed = {
        explanationZh: rawText,
        passedConditionsZh: [],
        missingDataOrWaitReasonsZh: [],
        riskNotesZh: [],
      };
    }

    let explanationZh = sanitizeTextGuardrail(parsed.explanationZh || '');

    // Mandatory preservation of rule engine's waitReasons & missingData
    const mandatoryWaitReasons = [
      ...smcAnalysis.waitReasons,
      ...candidate.provenance.missingData.map((m) => `缺失欄位: ${m}`),
      ...smcAnalysis.provenance.missingData.map((m) => `缺失欄位: ${m}`),
    ];

    if (smcAnalysis.actionState === 'WAIT') {
      const waitReasonText =
        smcAnalysis.waitReasons.join('、') || '結構條件尚未確認';
      if (!explanationZh.toUpperCase().includes('WAIT')) {
        explanationZh = `【WAIT 狀態強制鎖定（原因：${waitReasonText}）】${explanationZh}`;
      } else if (
        smcAnalysis.waitReasons.length > 0 &&
        !smcAnalysis.waitReasons.some((r) => explanationZh.includes(r))
      ) {
        explanationZh = `${explanationZh}（WAIT 觸發原因：${waitReasonText}）`;
      }
    }

    const mergedMissingAndWait = [
      ...new Set([
        ...mandatoryWaitReasons,
        ...(parsed.missingDataOrWaitReasonsZh || []).map(sanitizeTextGuardrail),
      ]),
    ];

    return {
      safety: TRADING_SAFETY_FLAGS,
      symbol: candidate.symbol,
      // Hard-lock category, actionState, and waitReasons from the deterministic rule engine — Gemini can NEVER override them
      category: candidate.category,
      actionState: smcAnalysis.actionState,
      waitReasons: [...smcAnalysis.waitReasons],
      lockedCategory: candidate.category,
      lockedActionState: smcAnalysis.actionState,
      explanationZh,
      passedConditionsZh: (parsed.passedConditionsZh || []).map(
        sanitizeTextGuardrail
      ),
      missingDataOrWaitReasonsZh:
        mergedMissingAndWait.length > 0
          ? mergedMissingAndWait
          : ['無缺失基礎欄位'],
      riskNotesZh: [
        ...(parsed.riskNotesZh || []).map(sanitizeTextGuardrail),
        'PAPER ONLY · LIVE ORDERS DISABLED · NEVER AUTO-PLACE ORDERS',
      ],
      guardrails: {
        ruleEngineOverridden: false,
        containsGuaranteeLanguage: false,
        waitGateEnforced:
          smcAnalysis.actionState === 'WAIT'
            ? explanationZh.toUpperCase().includes('WAIT')
            : true,
        sourceEvidenceTimestamp: smcAnalysis.provenance.fetchedAt,
      },
      provenance: {
        source: `Gemini AI Evidence Explainer (gemini-3.8-flash, Locked to ${smcAnalysis.ruleVersion})`,
        fetchedAt: new Date().toISOString(),
        stale: candidate.provenance.stale || smcAnalysis.provenance.stale,
        fallback: candidate.provenance.fallback,
        missingData: [
          ...new Set([
            ...candidate.provenance.missingData,
            ...smcAnalysis.provenance.missingData,
          ]),
        ],
        isDemo: candidate.provenance.isDemo,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown Gemini API error';
    return buildDeterministicFallbackExplanation(
      req,
      `Gemini API 呼叫異常 (${msg.slice(0, 80)})，使用規則引擎決定性解釋`
    );
  }
}
