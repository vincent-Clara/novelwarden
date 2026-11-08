/**
 * 設定頁的本地編輯狀態，以及儲存前的校驗。
 *
 * `dirty` 是必要的：FileSystemWatcher 一重新整理就會推一份新設定過來，
 * 如果無條件重渲染，使用者正在填的 baseUrl 會被磁碟上的舊值沖掉。
 */
import type { LlmTask, ModelTier, SerializedProvider } from '../../protocol';

export const draft: {
  providers: SerializedProvider[];
  /** 預設模型列表（有序，第一個是首選），每項形如 `glm/glm-4-plus`。 */
  models: string[];
  /** 三檔各自的模型清單，與 models 同構。空檔 = 沿用 models。 */
  tierModels: Record<ModelTier, string[]>;
  /** 任務 → 檔位的覆蓋，只存與內建預設不同的項。 */
  taskTiers: Partial<Record<LlmTask, ModelTier>>;
  /** providerId -> 有沒有存過 API Key。Key 本身從不回顯。 */
  keys: Record<string, boolean>;
  dirty: boolean;
} = {
  providers: [],
  models: [],
  tierModels: { fast: [], balanced: [], quality: [] },
  taskTiers: {},
  keys: {},
  dirty: false,
};

export function touch(): void {
  draft.dirty = true;
}

/** 生成一個不與現有服務商衝突的 id。 */
export function uniqueId(base: string): string {
  if (!draft.providers.some((p) => p.id === base)) {
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!draft.providers.some((p) => p.id === candidate)) {
      return candidate;
    }
  }
}

/** draft 裡全部模型的引用，按配置順序。 */
export function allRefs(): string[] {
  return draft.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m.name}`));
}

/**
 * 儲存前擋住會讓引用無法解析的配置。返回錯誤資訊，沒問題返回空串。
 *
 * 模型引用**只在第一個斜槓處切分**，所以字首裡絕不能有斜槓——
 * `openrouter/z-ai/glm-4.6` 的服務商是 `openrouter`，模型名是 `z-ai/glm-4.6`。
 */
export function validateProviders(providers: SerializedProvider[]): string {
  const ids = new Set<string>();
  for (const p of providers) {
    const id = (p.id || '').trim();
    if (!id) return '服務商的字首 id 不能為空。';
    if (id.includes('/')) return `字首「${id}」不能含斜槓，否則模型引用無法切分。`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return `字首「${id}」只能用字母、數字、點、下劃線和連字元。`;
    if (ids.has(id)) return `字首「${id}」重複了，每個服務商的字首必須唯一。`;
    ids.add(id);

    if (p.models.length === 0) return `服務商「${id}」下沒有模型。`;
    const names = new Set<string>();
    for (const m of p.models) {
      const name = (m.name || '').trim();
      if (!name) return `服務商「${id}」下有模型名為空。`;
      if (names.has(name)) return `服務商「${id}」下的模型「${name}」重複了。`;
      names.add(name);
      if (m.contextWindow && m.maxOutputTokens && m.maxOutputTokens >= m.contextWindow) {
        return `${id}/${name} 的輸出上限必須小於它的視窗。`;
      }
    }
  }
  return '';
}
