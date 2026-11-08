import type { ChatController } from './index';
import {
  normalizeModelList,
  normalizeTaskTiers,
  normalizeTierModels,
  promoteModel,
  updateSettings,
  readConfig,
} from '../config';
import { describeTierConfig } from '../model/tiers';
import { CONTEXT_DETAIL_LABEL, normalizeContextDetail } from '../model/contextDetail';
import { apiKeyStatus, pruneApiKeys } from '../llm/registry';
import {
  describeModelIssue,
  normalizeProviders,
  resolveModelRef,
} from '../model/providers';
import { OutMessage, SerializedProvider, SettingsPayload } from '../protocol';
import { testConnection as runConnectionTest } from '../features/creation';
import { scoped } from '../runtime/logger';

const log = scoped('面板');

/** 設定讀寫不依賴 NovelProject：空視窗也能開啟設定頁。 */
export interface SettingsSink {
  post(message: OutMessage): void;
  toast(message: string, level?: 'info' | 'error'): void;
}

/** 設定頁。欄位只給 controller/ 同包用。 */

export async function pushSettingsTo(sink: SettingsSink, ack?: 'saved' | 'rejected'): Promise<void> {
  const cfg = readConfig();
  sink.post({
    type: 'settings',
    ack,
    settings: {
      providers: cfg.providers.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => ({
          name: m.name,
          label: m.label,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        })),
      })),
      models: cfg.models,
      tierModels: cfg.tierModels,
      taskTiers: cfg.taskTiers,
      temperature: cfg.temperature,
      contextDetail: cfg.contextDetail,
      summaryBatchSize: cfg.summaryBatchSize,
      requestTimeoutMs: cfg.requestTimeoutMs,
      concurrency: cfg.concurrency,
      fallbackAttempts: cfg.fallbackAttempts,
      trimModifiers: cfg.trimModifiers,
      openInNewWindow: cfg.openInNewWindow,
    },
    keys: await apiKeyStatus(cfg.providers),
  });
}

export async function pushSettings(c: ChatController, ack?: 'saved' | 'rejected'): Promise<void> {
  await pushSettingsTo(c, ack);
}

export async function saveSettingsFrom(
  s: SettingsPayload,
  sink: SettingsSink,
  afterSave?: () => Promise<void>
): Promise<void> {
  const before = readConfig().providers.map((p) => p.id);
  const providers = normalizeProviders(s.providers);
  if (s.providers.length > 0 && providers.length === 0) {
    log.error(
      '設定未儲存：服務商配置不合法',
      'id 不能為空或含斜槓，且每個服務商至少要有一個模型。前端已收到 rejected 回執，編輯內容保留。'
    );
    sink.toast('服務商配置不合法：id 不能為空或含斜槓，且每個服務商至少要有一個模型。', 'error');
    // 回執必須發——前端據此知道這次沒落盤，從而保住未儲存的編輯。
    await pushSettingsTo(sink, 'rejected');
    return;
  }

  const models = normalizeModelList(s.models);
  // 檔位清單與 models 同樣容錯：去空、去重、保序，認不出的檔位名丟棄。
  const tierModels = normalizeTierModels(s.tierModels);
  const taskTiers = normalizeTaskTiers(s.taskTiers);
  const contextDetail = normalizeContextDetail(s.contextDetail);
  await updateSettings({
    providers,
    // 列表是唯一真相；updateSettings 會順手把 model 對齊到首項。
    models,
    model: models[0] ?? '',
    tierModels,
    taskTiers,
    temperature: s.temperature,
    contextDetail,
    summaryBatchSize: s.summaryBatchSize,
    requestTimeoutMs: s.requestTimeoutMs,
    concurrency: s.concurrency,
    fallbackAttempts: s.fallbackAttempts,
    trimModifiers: s.trimModifiers !== false,
    ...(typeof s.openInNewWindow === 'boolean' ? { openInNewWindow: s.openInNewWindow } : {}),
  });

  // 刪掉的服務商不該在鑰匙串裡留下孤兒 Key。
  await pruneApiKeys(providers, before);

  log.info(
    '設定已儲存',
    `${providers.length} 個服務商｜預設模型 ${models.join('、') || '（未選）'}｜` +
      `${describeTierConfig(tierModels, taskTiers)}｜` +
      `溫度 ${s.temperature}｜上下文詳細度 ${CONTEXT_DETAIL_LABEL[contextDetail]}｜超時 ${s.requestTimeoutMs}ms｜` +
      `併發 ${s.concurrency}｜換模型重試 ${s.fallbackAttempts} 次｜` +
      `刪修飾 ${s.trimModifiers !== false ? '開' : '關'}`
  );
  await pushSettingsTo(sink, 'saved');
  if (afterSave) {
    await afterSave();
  }
  sink.toast('設定已儲存。');
}

export async function saveSettings(c: ChatController, s: SettingsPayload): Promise<void> {
  await saveSettingsFrom(s, c, () => c.pushState());
}

/**
 * 輸入框旁邊的模型下拉框。只改選中項，不動服務商列表。
 *
 * 「預設模型列表」是唯一真相，所以這裡不是覆蓋某個欄位，而是**把選中的
 * 模型提到列表頭**——設定頁裡排的順序其餘部分原樣保留。
 */
export async function selectModel(c: ChatController, ref: string): Promise<void> {
  const config = readConfig();
  if (!resolveModelRef(config.providers, ref)) {
    const issue = describeModelIssue(config.providers, ref);
    log.error(`切換模型失敗：${issue}`, `請求的引用 ${ref}`);
    c.toast(issue, 'error');
    await c.pushState();
    return;
  }
  const models = await promoteModel(ref);
  log.info(`已切換到模型 ${ref}`, models.length > 1 ? `預設模型列表：${models.join('、')}` : undefined);
  await c.pushState();
  // 設定頁開著時，列表順序變了要立刻看得見。
  await pushSettings(c);
}

export async function testConnection(
  c: ChatController,
  ref?: string,
  provider?: SerializedProvider
): Promise<void> {
  await testConnectionTo(c, ref, provider, () => c.pushState());
}

export async function testConnectionTo(
  sink: SettingsSink,
  ref?: string,
  provider?: SerializedProvider,
  after?: () => Promise<void>
): Promise<void> {
  const target = ref ?? readConfig().model;
  const draft = provider ? normalizeProviders([provider])[0] : undefined;
  sink.toast(`正在測試 ${target}…`);
  const result = await runConnectionTest(ref, draft);
  sink.toast(result.message, result.ok ? 'info' : 'error');
  if (after) {
    await after();
  }
}
