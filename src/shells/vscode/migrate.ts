import * as vscode from 'vscode';
import * as path from 'node:path';
import { PersistedSettings } from '../../core/config';
import { normalizeProviders } from '../../core/model/providers';
import { FileConfigStore, FileSecretStore } from '../../core/stores';

const SETTING_KEYS = [
  'providers', 'models', 'model', 'tierModels', 'taskTiers',
  'contextWindow', 'maxOutputTokens', 'temperature',
  'chaptersDir', 'draftsDir',
  'summaryBatchSize', 'requestTimeoutMs', 'concurrency', 'fallbackAttempts',
];

/** 0.1.x 的單服務商鍵，供 config.ts 的 seedFromLegacyRaw 消費。 */
const LEGACY_KEYS = [
  'provider', 'openai.baseUrl', 'openai.model',
  'anthropic.baseUrl', 'anthropic.model', 'vscodeLm.family',
];

/**
 * settings.json 的讀取器，在 ~/.novelwarden/config.json 尚不可用時兜底
 *（未遷移、被刪、或內容損壞——FileConfigStore.read 對壞 JSON 返回 undefined）。
 *
 * 必須連**新結構**的鍵一起讀，不能只讀 0.1.x 的單服務商鍵：
 * 使用者在 settings.json 裡配好的 novel.providers 否則會被整份丟掉，
 * readConfig 只剩 0.1.x 預設值可兜底（novel.openai.model 宣告瞭預設值
 * "gpt-4o"，cfg.get 永遠拿得到值），於是介面報「服務商下沒有模型」，
 * 而那個模型明明就在設定裡躺著。
 */
export const legacySettingsReader = {
  read(): PersistedSettings {
    const cfg = vscode.workspace.getConfiguration('novel');
    const out: Record<string, unknown> = {};
    for (const key of [...SETTING_KEYS, ...LEGACY_KEYS]) {
      const value = cfg.get(key);
      if (value !== undefined) {
        out[key] = value;
      }
    }
    return out as PersistedSettings;
  },
};

/**
 * 一次性遷移：settings.json 的 novel.* + SecretStorage → ~/.novelwarden/。
 * 已遷移過（config.json 存在）則跳過。遷移成功後不刪舊配置，
 * 只在 VS Code 裡提示「可清理」，避免使用者回滾時丟東西。
 * 返回是否真的執行了遷移。
 */
export async function migrateVscodeSettings(secrets: vscode.SecretStorage): Promise<boolean> {
  const store = new FileConfigStore();
  if (store.read()) {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('novel');
  const settings: PersistedSettings = {};
  for (const k of SETTING_KEYS) {
    const v = cfg.get(k);
    if (v !== undefined) {
      (settings as Record<string, unknown>)[k] = v;
    }
  }
  // 沒配過新結構：把遺留單服務商鍵一併搬過去（seedFromLegacyRaw 會消費帶點鍵）。
  if ((settings.providers ?? []).length === 0 && !settings.model) {
    const legacy = legacySettingsReader.read();
    Object.assign(settings, legacy as Record<string, unknown>);
  }
  if (Object.keys(settings).length === 0) {
    return false;
  }
  await store.write(settings);

  // SecretStorage → ~/.novelwarden/secrets.json。這裡沿用舊的 `novel-forge.apiKey.*` 鍵名，
  // 因為老使用者的 Key 都存在這個字首下；字首若換新，registry 必須同時保留舊鍵的 fallback。
  const secretStore = new FileSecretStore();
  const ids = new Set<string>(normalizeProviders(settings.providers ?? []).map((p) => p.id));
  ids.add('openai');
  ids.add('anthropic');
  for (const id of ids) {
    const key = `novel-forge.apiKey.provider.${id}`;
    if (!(await secretStore.get(key))) {
      const v = await secrets.get(key);
      if (v) {
        await secretStore.set(key, v);
      }
    }
  }
  for (const legacyKey of ['novel-forge.apiKey.openai', 'novel-forge.apiKey.anthropic']) {
    if (!(await secretStore.get(legacyKey))) {
      const v = await secrets.get(legacyKey);
      if (v) {
        await secretStore.set(legacyKey, v);
      }
    }
  }

  // 提示裡的目錄以實際落點為準：舊 ~/.novelforge/ 還活著時 FileConfigStore 就落在那裡，
  // 寫死 ~/.novelwarden/ 會指錯地方。
  const configDir = path.dirname(store.filePath);
  void vscode.window.showInformationMessage(
    `Novelwarden：配置與金鑰已遷移到 ${configDir}，VS Code 內的舊配置可手動清理。`
  );
  return true;
}
