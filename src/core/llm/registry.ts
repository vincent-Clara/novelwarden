import { traditionalLabel } from '../model/labels';
import { readConfig } from '../config';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import {
  ActiveModel,
  ProviderProfile,
  defaultBaseUrl,
  describeModelIssue,
  listModelChoices,
  makeModelRef,
  providerLabel,
  resolveModelRef,
} from '../model/providers';
import { SecretStore } from '../stores';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAiProvider } from './openaiProvider';
import { LlmProvider } from './provider';

const log = scoped('模型');

/**
 * API Key 按服務商 id 存，不再按 kind——同一種協議下可以並存
 * 多個服務商（智谱官方、OpenRouter、本地 Ollama 都是 openai 相容），
 * 它們各有各的 Key。
 *
 * 鍵名裡的 `novel-forge.` 字首**故意不改**：它是已存進 secrets.json 的鍵，
 * 跟著產品改名只會把作者錄過的 Key 全丟掉。
 */
function secretKey(providerId: string): string {
  return `novel-forge.apiKey.provider.${providerId}`;
}

/** 0.1.x 按 kind 存的兩個 Key，用於一次性遷移。 */
const LEGACY_SECRET_KEYS: Record<string, string> = {
  openai: 'novel-forge.apiKey.openai',
  anthropic: 'novel-forge.apiKey.anthropic',
};

let secrets: SecretStore | undefined;

export function initSecrets(store: SecretStore): void {
  secrets = store;
}

/** vscode-lm 走 Copilot 授權，不需要 Key。 */
export function needsApiKey(profile: ProviderProfile): boolean {
  return profile.kind !== 'vscode-lm';
}

type ExtraProviderFactory = (active: ActiveModel) => LlmProvider | undefined;
let extraFactory: ExtraProviderFactory | undefined;

/** VS Code 殼啟動時註冊 vscode-lm provider 工廠（core 不反向依賴 vscode 層）。 */
export function registerProviderFactory(fn: ExtraProviderFactory): void {
  extraFactory = fn;
}

/**
 * 按當前設定構造 provider。缺 API Key 時會引導使用者錄入；
 * 模型引用無效或使用者放棄錄入則返回 undefined（呼叫方給出說明）。
 */
export async function resolveProvider(ref?: string): Promise<LlmProvider | undefined> {
  const config = readConfig();
  const active = ref ? resolveModelRef(config.providers, ref) : config.active;
  if (!active) {
    const issue = describeModelIssue(config.providers, ref ?? config.model);
    const wanted = ref ?? config.model;
    log.error(issue, `請求的引用 ${wanted || '（空）'}｜已配置 ${config.providers.length} 個服務商`);
    getHost().toast(`${issue}`, 'error');
    return undefined;
  }
  return buildProvider(active);
}

/** 已知模型時直接構造，不再讀配置。 */
export async function buildProvider(
  active: ActiveModel,
  opts: BuildProviderOptions = {}
): Promise<LlmProvider | undefined> {
  const { profile, model } = active;
  const quiet = opts.promptForKey === false;

  if (profile.kind === 'vscode-lm') {
    const provider = extraFactory?.(active);
    if (!provider) {
      const detail = `引用 ${active.ref}`;
      if (quiet) {
        log.warn('當前環境不提供 VS Code 語言模型（Copilot）', detail);
      } else {
        log.error('當前環境不提供 VS Code 語言模型（Copilot）', detail);
      }
    }
    return provider;
  }

  const key = quiet ? await lookupApiKey(profile) : await ensureApiKey(profile);
  if (!key) {
    const message = `未取得「${providerLabel(profile)}」的 API Key`;
    // 靜默構造用於備選模型：缺 Key 只是把它排除在池外，不是錯誤。
    if (quiet) {
      log.warn(message, `引用 ${active.ref}｜可在設定頁錄入後重新參與`);
    } else {
      log.error(message, `引用 ${active.ref}`);
    }
    return undefined;
  }
  const baseUrl = profile.baseUrl || defaultBaseUrl(profile.kind);
  log.debug(`構造 provider ${active.ref}`, `${traditionalLabel(profile.kind)}｜${baseUrl}｜模型 ${model.name}`);
  return profile.kind === 'anthropic'
    ? new AnthropicProvider(baseUrl, model.name, key)
    : new OpenAiProvider(baseUrl, model.name, key);
}

export interface BuildProviderOptions {
  /**
   * 缺 API Key 時是否彈輸入框引導錄入。預設 true（與使用者點了某個動作的
   * 直覺一致）。**模型池構造備選模型時必須傳 false**——一個池裡有五個
   * 模型就連彈五個輸入框，那比沒有 fallback 還糟。
   */
  promptForKey?: boolean;
}

async function ensureApiKey(profile: ProviderProfile): Promise<string | undefined> {
  const existing = await lookupApiKey(profile);
  return existing ?? promptForApiKey(profile.id);
}

/**
 * 取某服務商的 Key。
 *
 * 找不到時回落到 0.1.x 按 kind 存的 Key，並順手遷移到新鍵上——
 * 老使用者升級後不該被要求重新輸一遍。
 */
async function lookupApiKey(profile: ProviderProfile): Promise<string | undefined> {
  const store = requireSecrets();
  const current = await store.get(secretKey(profile.id));
  if (current) {
    return current;
  }
  const legacyKey = LEGACY_SECRET_KEYS[profile.id];
  if (!legacyKey) {
    return undefined;
  }
  const legacy = await store.get(legacyKey);
  if (legacy) {
    await store.set(secretKey(profile.id), legacy);
    await store.delete(legacyKey);
    log.info(`「${providerLabel(profile)}」的 API Key 已從 0.1.x 的鍵位遷移`);
  }
  return legacy ?? undefined;
}

/** 某個服務商是否已存過 Key——設定頁據此顯示狀態，不回顯 Key 本身。 */
export async function hasApiKey(providerId: string): Promise<boolean> {
  if (!secrets) {
    return false;
  }
  if (await secrets.get(secretKey(providerId))) {
    return true;
  }
  const legacyKey = LEGACY_SECRET_KEYS[providerId];
  return legacyKey ? !!(await secrets.get(legacyKey)) : false;
}

/** 每個服務商的 Key 狀態，一次問完，設定頁一次渲染。 */
export async function apiKeyStatus(providers: ProviderProfile[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const profile of providers) {
    out[profile.id] = needsApiKey(profile) ? await hasApiKey(profile.id) : true;
  }
  return out;
}

export async function promptForApiKey(providerId?: string): Promise<string | undefined> {
  const config = readConfig();
  const profile = providerId
    ? config.providers.find((p) => p.id === providerId)
    : config.active?.profile ?? (await pickProvider(config.providers, '為哪個服務商設定 API Key？'));

  if (!profile) {
    getHost().toast(
      `${describeModelIssue(config.providers, providerId ? `${providerId}/` : config.model)}`,
      'error'
    );
    return undefined;
  }
  if (!needsApiKey(profile)) {
    getHost().toast(`「${providerLabel(profile)}」使用 VS Code 語言模型（Copilot），無需 API Key。`);
    return undefined;
  }

  const host = profile.baseUrl || defaultBaseUrl(profile.kind);
  const value = await getHost().input({
    title: `設定「${providerLabel(profile)}」的 API Key`,
    prompt: `安全儲存在本機金鑰儲存中，不會寫入配置檔案。介面地址：${host}`,
    password: true,
    placeHolder: profile.kind === 'anthropic' ? 'sk-ant-...' : 'sk-...',
    validate: (v) => (v.trim().length === 0 ? 'API Key 不能為空' : undefined),
  });

  if (!value) {
    log.info(`使用者取消了「${providerLabel(profile)}」的 API Key 錄入`);
    return undefined;
  }
  await requireSecrets().set(secretKey(profile.id), value.trim());
  log.info(`「${providerLabel(profile)}」的 API Key 已儲存`, `介面地址 ${host}`);
  getHost().toast(`「${providerLabel(profile)}」的 API Key 已儲存。`);
  return value.trim();
}

export async function clearApiKey(providerId?: string): Promise<void> {
  const store = requireSecrets();
  const config = readConfig();

  // 設定頁會指名清哪個；從命令面板進來則要問一下。
  const profile = providerId
    ? config.providers.find((p) => p.id === providerId)
    : await pickProvider(config.providers.filter(needsApiKey), '清除哪個服務商的 API Key？');
  if (!profile) {
    return;
  }

  await store.delete(secretKey(profile.id));
  const legacyKey = LEGACY_SECRET_KEYS[profile.id];
  if (legacyKey) {
    await store.delete(legacyKey);
  }
  log.info(`已清除「${providerLabel(profile)}」的 API Key`);
  getHost().toast(`已清除「${providerLabel(profile)}」的 API Key。`);
}

/** 清掉配置裡已不存在的服務商的 Key——刪掉服務商後不該在鑰匙串裡留下孤兒。 */
export async function pruneApiKeys(providers: ProviderProfile[], removedIds: string[]): Promise<void> {
  if (!secrets || removedIds.length === 0) {
    return;
  }
  const alive = new Set(providers.map((p) => p.id));
  for (const id of removedIds) {
    if (!alive.has(id)) {
      await secrets.delete(secretKey(id));
      const legacyKey = LEGACY_SECRET_KEYS[id];
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
      log.info(`服務商「${id}」已刪除，順手清掉它的 API Key`);
    }
  }
}

async function pickProvider(
  providers: ProviderProfile[],
  title: string
): Promise<ProviderProfile | undefined> {
  if (providers.length === 0) {
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0];
  }
  return getHost().pick(
    providers.map((p) => ({
      label: providerLabel(p),
      description: p.id,
      detail: p.baseUrl || defaultBaseUrl(p.kind),
      value: p,
    })),
    title
  );
}

/** 命令面板裡的模型切換器。 */
export async function pickModelRef(): Promise<string | undefined> {
  const config = readConfig();
  const choices = listModelChoices(config.providers, getHost().supportsVscodeLm);
  if (choices.length === 0) {
    getHost().toast(`${describeModelIssue(config.providers, config.model)}`, 'error');
    return undefined;
  }

  return getHost().pick(
    choices.map((choice) => ({
      label: choice.ref,
      description: choice.label !== choice.ref.slice(choice.ref.indexOf('/') + 1) ? choice.label : undefined,
      detail: choice.contextWindow ? `視窗 ${choice.contextWindow} token` : undefined,
      group: choice.group,
      value: choice.ref,
    })),
    '選擇模型'
  );
}

export { makeModelRef };

function requireSecrets(): SecretStore {
  if (!secrets) {
    throw new Error('SecretStore 尚未初始化');
  }
  return secrets;
}
