/**
 * 常用服務商預設與幾張對照表。
 *
 * 點一下預設新增**一整個服務商**（含幾個常用模型），而不是覆蓋當前配置——
 * 多服務商並存本來就是重點。
 *
 * ## 為什麼這裡只剩三個預設
 *
 * 兩種協議現在各自認一條路：openai 走 **Responses**（`/responses`，Codex 那
 * 一套），anthropic 走 **Messages**。思考深度只在這兩條路上有落點，所以兩條
 * 老路（`/chat/completions`）不再保留。DeepSeek、智谱、Kimi、通义、本地
 * Ollama 只認 `/chat/completions`，留著它們的預設等於在「新增服務商」裡擺幾個
 * 點了就 404 的按鈕——那比找不到更讓人惱火。要用它們仍然可以手工新增（配一個
 * 自己那側的 `/responses` 相容閘道器地址）。
 */
import type { SerializedProvider } from '../../protocol';

export const KIND_LABEL: Record<string, string> = {
  openai: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  'vscode-lm': 'VS Code 語言模型',
};

/** 設定頁上的數字輸入框：配置項名 -> 頁面上的 id。 */
export const NUMERIC_FIELDS = {
  temperature: 'setTemperature',
  summaryBatchSize: 'setSummaryBatchSize',
  requestTimeoutMs: 'setRequestTimeoutMs',
  concurrency: 'setConcurrency',
  fallbackAttempts: 'setFallbackAttempts',
} as const;

export type NumericField = keyof typeof NUMERIC_FIELDS;

export const PRESETS: SerializedProvider[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: [{ name: 'gpt-4o', contextWindow: 128000 }, { name: 'gpt-4o-mini', contextWindow: 128000 }],
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: [{ name: 'claude-sonnet-4-5', contextWindow: 200000 }],
  },
  {
    id: 'copilot', label: 'VS Code 語言模型', kind: 'vscode-lm',
    models: [{ name: 'gpt-4o' }, { name: 'claude-3.5-sonnet' }],
  },
];
