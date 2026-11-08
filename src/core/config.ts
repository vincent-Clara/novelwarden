import { firstModelRef, normalizeProviders, resolveModelRef, seedFromLegacy } from './model/providers';
import { scoped } from './runtime/logger';
import { currentCallChoice } from './runtime/callScope';
import { NovelConfig } from './model/types';
import { isLlmTask, isModelTier, LlmTask, MODEL_TIERS, ModelTier, TierModels } from './model/tiers';
import {
  CONTEXT_DETAIL_LABEL,
  ContextDetail,
  ContextLimits,
  isContextDetail,
  normalizeContextDetail,
} from './model/contextDetail';

const log = scoped('配置');

/** 併發與 fallback 的取值範圍。超出一律 clamp，並說明一次。 */
export const CONCURRENCY_RANGE = { min: 1, max: 16, def: 3 };
export const FALLBACK_RANGE = { min: 0, max: 5, def: 2 };

/**
 * 配置讀取層。資料來源由宿主注入（ConfigStore），core 不再直接碰
 * vscode.workspace.getConfiguration。
 */

/** 落盤的設定形狀（與 SettingsPayload 對齊，另加 chaptersDir）。 */
export interface PersistedSettings {
  providers?: unknown[];
  /**
   * 預設模型列表，按順序，第一個是首選。工程頁的後臺任務從這裡取模型。
   *
   * 與 `model` 的關係：`model` 恆等於 `models[0]`，兩者都寫盤——
   * 前者是 0.2.x 就有的鍵（對話頁下拉、上下文裝配都讀它），
   * 後者是本版新增的。只有 `model` 的舊配置會被自動升級成單元素列表。
   */
  models?: string[];
  model?: string;
  /**
   * 三檔（快速 / 均衡 / 精標）各自的模型清單，與 `models` 同構。
   *
   * 某一檔為空 = 該檔的任務沿用 `models`。三檔都空則整個分檔不生效，
   * 行為與分檔之前完全一致（見 model/tiers.ts 的兩條硬約束）。
   */
  tierModels?: Record<string, unknown>;
  /**
   * 任務 → 檔位的**覆蓋**。只存與內建預設（`DEFAULT_TASK_TIERS`）不同的項，
   * 這樣日後調整預設值時，沒動過的任務會跟著新預設走。
   */
  taskTiers?: Record<string, unknown>;
  /** 工程頁批次任務的併發請求數。 */
  concurrency?: number;
  /** 一次呼叫失敗後，換模型重試的次數上限。 */
  fallbackAttempts?: number;
  /** 寫完正文刪修飾。缺席 = 開。 */
  trimModifiers?: boolean;
  /** 獨立版：已經開著工程時，開啟另一個工程用新視窗。缺席 = 開。 */
  openInNewWindow?: boolean;
  /** @deprecated 舊版全域預算，僅作相容兜底；設定頁不再提供寫入口。 */
  contextWindow?: number;
  /** @deprecated 舊版全域預算，僅作相容兜底；設定頁不再提供寫入口。 */
  maxOutputTokens?: number;
  temperature?: number;
  /** 上下文詳細度 1–4（model/contextDetail.ts）。缺席或認不出 = 3。 */
  contextDetail?: number;
  chaptersDir?: string;
  draftsDir?: string;
  summaryBatchSize?: number;
  requestTimeoutMs?: number;
}

export interface ConfigStore {
  /** 未遷移/未儲存過時返回 undefined。 */
  read(): PersistedSettings | undefined;
  write(settings: PersistedSettings): Promise<void>;
}

/**
 * 0.1.x 遺留配置讀取器。VS Code 殼注入（讀 settings.json 的 novel.*），
 * 用於尚未遷移到 ~/.novelwarden/config.json 的老使用者；獨立版不注入。
 */
export interface LegacyConfigReader { read(): PersistedSettings; }

let store: ConfigStore | undefined;
let legacy: LegacyConfigReader | undefined;

/** 由 initHost 呼叫：配置跟隨宿主。 */
export function initConfigFromHost(host: { config: ConfigStore }): void {
  store = host.config;
}

export function setLegacyConfigReader(reader: LegacyConfigReader): void {
  legacy = reader;
}

function raw(): PersistedSettings {
  return store?.read() ?? legacy?.read() ?? {};
}

/**
 * 解析後的配置。在調模型之前的確認框之後（`withCallChoice` 裡）讀，帶著作者為這一次挑的
 * 模型（`pinnedModel`）與詳細度——這是作者的選擇唯一的落點（runtime/callScope.ts）。
 */
export function readConfig(): NovelConfig {
  const c = raw();
  const choice = currentCallChoice();
  let providers = normalizeProviders(c.providers ?? []);
  let models = normalizeModelList(c.models);
  let model = (c.model ?? '').trim();

  // 0.1.x 的單服務商設定。只在新結構為空且宿主提供了遺留讀取器時兜底，
  // 不寫回磁碟——使用者一旦在設定頁儲存過，就以 providers 為準。
  if (providers.length === 0 && legacy) {
    const seeded = seedFromLegacyRaw(c);
    providers = seeded.providers;
    if (!model) {
      model = seeded.activeRef;
    }
  }
  // 只有 `model` 的舊配置自動升級成單元素列表；兩者都空則取第一個可用模型。
  if (models.length === 0) {
    models = normalizeModelList([model || firstModelRef(providers)]);
  }
  // 列表是唯一真相：`model` 恆等於首項。
  model = models[0] ?? '';

  const active = resolveModelRef(providers, model);
  const fallbackBudget = readBudgetFallback();

  return {
    providers,
    models,
    model,
    active,
    tierModels: normalizeTierModels(c.tierModels),
    taskTiers: normalizeTaskTiers(c.taskTiers),
    ...(choice?.model ? { pinnedModel: choice.model } : {}),
    // 模型自帶的視窗優先——同一個服務商下 32k 和 200k 的模型常常並存。
    contextWindow: active?.model.contextWindow ?? fallbackBudget.contextWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? fallbackBudget.maxOutputTokens,
    temperature: c.temperature ?? 0.8,
    contextDetail: choice?.contextDetail ?? readContextDetail(c.contextDetail),
    ...(contextOverride ? { contextOverrides: { ...contextOverride } } : {}),
    chaptersDir: c.chaptersDir ?? 'chapters',
    draftsDir: c.draftsDir ?? 'drafts',
    summaryBatchSize: c.summaryBatchSize ?? 15,
    requestTimeoutMs: c.requestTimeoutMs ?? 300000,
    concurrency: clamp('併發請求數', c.concurrency, CONCURRENCY_RANGE),
    fallbackAttempts: clamp('換模型重試次數', c.fallbackAttempts, FALLBACK_RANGE),
    trimModifiers: c.trimModifiers !== false,
    openInNewWindow: c.openInNewWindow !== false,
  };
}

/**
 * 預設模型列表的容錯讀取：去空、去重、保序。
 *
 * **不**在這裡剔除解析不出的引用——保留才能讓設定頁說清「這個模型沒了」，
 * 與 `model` 的處理一致（模型池會在構造時剔除並 warn）。
 */
export function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return typeof raw === 'string' && raw.trim() ? [raw.trim()] : [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const ref = typeof entry === 'string' ? entry.trim() : '';
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * 三檔模型清單的容錯讀取。每檔都走 `normalizeModelList`（去空、去重、保序），
 * 缺席或型別不對的檔退化為空陣列 = 該檔沿用預設模型清單。
 *
 * 與 `models` 一致，這裡**不**剔除解析不出的引用——留著才能讓設定頁說清
 * 「這個模型沒了」，模型池會在構造時剔除並 warn。
 */
export function normalizeTierModels(raw: unknown): TierModels {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as TierModels;
  for (const tier of MODEL_TIERS) {
    out[tier] = normalizeModelList(source[tier]);
  }
  return out;
}

/**
 * 任務 → 檔位覆蓋的容錯讀取。
 *
 * 認不出的任務名（舊版本留下的鍵、手改配置寫錯）與非法檔位名一律丟棄，
 * 那一項回落內建預設。配置檔案被手改壞不該讓工程頁任務無法啟動。
 */
export function normalizeTaskTiers(raw: unknown): Partial<Record<LlmTask, ModelTier>> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<LlmTask, ModelTier>> = {};
  for (const [task, tier] of Object.entries(source)) {
    if (isLlmTask(task) && isModelTier(tier)) {
      out[task] = tier;
    }
  }
  return out;
}

/**
 * 數字設定項收進合法區間。
 *
 * readConfig 每次推狀態都會跑，所以「被 clamp 了」只說一次：
 * 同一個越界值反覆刷屏會把日誌頁擠沒。
 */
const clampWarned = new Map<string, unknown>();

function clamp(label: string, value: unknown, range: { min: number; max: number; def: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return range.def;
  }
  const n = Math.floor(value);
  const bounded = Math.min(range.max, Math.max(range.min, n));
  if (bounded !== n && clampWarned.get(label) !== n) {
    clampWarned.set(label, n);
    log.warn(`${label} 設為 ${n}，超出 ${range.min}~${range.max}，按 ${bounded} 生效`);
  }
  return bounded;
}

/**
 * 設定頁上的那一級，**不看「這一次」**：工程頁表單的預設值用它。狀態推送可能就發生在某一次任務的
 * 呼叫鏈上（任務收尾時推一次），從 `readConfig()` 取會把作者只給那一次挑的級別當成設定推出去。
 */
export function settingsContextDetail(): ContextDetail {
  return readContextDetail(raw().contextDetail);
}

/** 上下文詳細度：認不出回落預設，同一個壞值只說一次（理由同 `clamp`）。 */
let detailWarned: unknown;

function readContextDetail(value: unknown): ContextDetail {
  const detail = normalizeContextDetail(value);
  if (value !== undefined && !isContextDetail(value) && detailWarned !== value) {
    detailWarned = value;
    log.warn(`上下文詳細度設為 ${JSON.stringify(value)}，認不出，按「${CONTEXT_DETAIL_LABEL[detail]}」生效`);
  }
  return detail;
}

/**
 * 單項覆蓋上下文上限，**只給測試用**：走 `readConfig()` 的那幾條鏈（批次寫章、定稿）沒有地方
 * 遞一份手寫配置進去。生產程式碼從不呼叫——config.json 裡不認這一項，作者能動的只有級別。
 */
let contextOverride: Partial<ContextLimits> | undefined;

export function setContextLimitsOverride(override: Partial<ContextLimits> | undefined): void {
  contextOverride = override;
}


/**
 * 單模型沒有宣告預算時的相容兜底。
 *
 * 新設定頁不再暴露全域預算：視窗與輸出上限都應寫在模型條目上。這裡仍讀取
 * 舊配置中的兩個鍵，避免升級後讓既有專案突然換預算；新使用者使用內建值。
 */
export function readBudgetFallback(): { contextWindow: number; maxOutputTokens: number } {
  const c = raw();
  return {
    contextWindow: c.contextWindow ?? 128000,
    maxOutputTokens: c.maxOutputTokens ?? 4096,
  };
}

/** 整體落盤（merge 後寫）。 */
export async function updateSettings(patch: PersistedSettings): Promise<void> {
  if (!store) {
    throw new Error('配置後端尚未初始化');
  }
  // 合併的基線必須是**解析後**的配置，不能是 raw()。
  // config.json 還不存在時 raw() 來自 legacy reader，其中的 providers 可能缺席；
  // 直接 merge 會把只改一個欄位（例如下拉框切模型）的寫入變成
  // 「一份沒有 providers 的 config.json」，此後 model 指向的服務商再也解析不出來。
  const merged = { ...effectiveSettings(), ...patch };
  // 「列表是唯一真相」的落盤保證：只改了 models 的補丁也要把 model 帶上，
  // 否則磁碟上會留下一個指向舊首選的 model，被 0.2.x 的讀取器當真。
  const models = normalizeModelList(merged.models);
  if (models.length > 0) {
    merged.models = models;
    merged.model = models[0];
  }
  await store.write(merged);
}

/**
 * 把某個模型提到預設模型列表的首位（= 切換當前模型）。
 *
 * 「列表是唯一真相」的唯一寫入口：`model` 由 `models[0]` 決定，所以
 * **不能只寫 `model`**——那會在下一次 `updateSettings` 時被首項蓋回去。
 * 對話頁的下拉框與命令面板的「選擇模型」都走這裡。
 */
export async function promoteModel(ref: string): Promise<string[]> {
  const target = ref.trim();
  const models = [target, ...readConfig().models.filter((m) => m !== target)];
  await updateSettings({ models, model: target });
  return models;
}

/**
 * 落盤用的完整快照：raw() 打底，再補上兜底推匯出的 providers/models/model。
 * 保證任何一次寫入都不會產出「有 model、沒 providers」的配置，
 * 也不會產出「有 model、沒 models」的半截列表。
 *
 * 順手丟掉 0.1.x 的帶點鍵：它們只是 legacy reader 的輸入，寫進
 * config.json 既無人讀取，又會在 providers 日後被清空時重新觸發兜底。
 * 退役的鍵（{@link RETIRED_KEYS}）同理：下一次儲存時從檔案裡清掉。
 */
function effectiveSettings(): PersistedSettings {
  const c = { ...raw() } as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (key.includes('.') || key === 'provider' || RETIRED_KEYS.includes(key)) {
      delete c[key];
    }
  }
  const settings = c as PersistedSettings;
  const config = readConfig();
  if (normalizeProviders(settings.providers ?? []).length === 0 && config.providers.length > 0) {
    settings.providers = config.providers;
  }
  if (normalizeModelList(settings.models).length === 0 && config.models.length > 0) {
    settings.models = config.models;
  }
  settings.model = normalizeModelList(settings.models)[0] ?? settings.model ?? config.model;
  return settings;
}

/**
 * 不再讀的鍵。「注入完整原文章數」「上一章結尾字數」並進了上下文詳細度：設定頁儲存過一次的人，
 * 這兩個數都已經寫在檔案裡，分不清是不是手改的，所以一律不讀，免得級別調了卻被舊數字蓋住。
 */
const RETIRED_KEYS = ['recentChaptersFullText', 'prevChapterTailChars'];

/** seedFromLegacy 原本吃 vscode 配置的分散鍵；這裡接受扁平 raw。 */
function seedFromLegacyRaw(c: PersistedSettings) {
  // 遺留鍵（novel.provider / novel.openai.baseUrl 等）只會出現在 legacy reader
  // 的返回值裡，因此把 raw 裡的帶點鍵直接透傳給 providers.ts 的寬鬆入口。
  const flat = c as Record<string, unknown>;
  return seedFromLegacy({
    provider: (flat.provider as string | undefined) ?? 'openai',
    openaiBaseUrl: (flat['openai.baseUrl'] as string | undefined) ?? 'https://api.openai.com/v1',
    openaiModel: (flat['openai.model'] as string | undefined) ?? 'gpt-4o',
    anthropicBaseUrl: (flat['anthropic.baseUrl'] as string | undefined) ?? 'https://api.anthropic.com',
    anthropicModel: (flat['anthropic.model'] as string | undefined) ?? 'claude-sonnet-4-5',
    vscodeLmFamily: (flat['vscodeLm.family'] as string | undefined) ?? 'gpt-4o',
  });
}
