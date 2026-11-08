/**
 * 設定頁的裝配：收後端推來的設定、渲染、儲存。
 */
import { byId, maybeById } from '../../dom';
import {
  CONTEXT_DETAILS,
  CONTEXT_DETAIL_HINT,
  CONTEXT_DETAIL_LABEL,
  DEFAULT_CONTEXT_DETAIL,
  MODEL_TIERS,
  describeContextDetail,
  normalizeContextDetail,
} from '../../protocol';
import type { SettingsPayload } from '../../protocol';
import { vscode } from '../store';
import { toast } from '../toast';
import { allRefs, draft, touch, validateProviders } from './draft';
import { NUMERIC_FIELDS } from './presets';
import type { NumericField } from './presets';
import { bindOpenModal, renderProviders } from './providerList';
import { installProviderModal, openProviderModal, refreshProviderModal } from './providerModal';
import { installSkillsPanel, requestSkills } from './skills';
import { renderTaskTiers } from './taskTiers';

type SettingsCategory = 'models' | 'context' | 'general' | 'skills';

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = ['models', 'context', 'general', 'skills'];

/** 頁面上真有的那幾頁（「通用」只有獨立版有），按顯示順序。 */
function presentCategories(): SettingsCategory[] {
  return SETTINGS_CATEGORIES.filter((c) => document.querySelector(`[data-settings-tab="${c}"]`));
}

export function renderSettings(
  settings: SettingsPayload,
  keys: Record<string, boolean> | undefined,
  ack: 'saved' | 'rejected' | undefined
): void {
  const nextKeys = keys || {};

  // 儲存成功的回執：磁碟上已是使用者的版本，可以清掉本地編輯狀態。
  // 被拒（ack === 'rejected'）則保持 dirty，別把使用者剛填的東西衝掉。
  if (ack === 'saved') {
    draft.dirty = false;
  }

  if (draft.dirty) {
    // 有未儲存的編輯，不能拿磁碟上的值覆蓋。但 Key 狀態得更新——
    // 使用者剛在彈窗裡輸完 Key 就等著看這個。
    if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) {
      draft.keys = nextKeys;
      renderProviders();
      refreshProviderModal();
    }
    return;
  }

  draft.providers = JSON.parse(JSON.stringify(settings.providers || []));
  draft.models = [...(settings.models || [])];
  draft.tierModels = {
    fast: [...(settings.tierModels?.fast || [])],
    balanced: [...(settings.tierModels?.balanced || [])],
    quality: [...(settings.tierModels?.quality || [])],
  };
  draft.taskTiers = { ...(settings.taskTiers || {}) };
  draft.keys = nextKeys;
  for (const [key, id] of Object.entries(NUMERIC_FIELDS)) {
    const node = maybeById<HTMLInputElement>(id);
    if (node) {
      node.value = String(settings[key as NumericField]);
    }
  }
  const trim = maybeById<HTMLInputElement>(TRIM_FIELD);
  if (trim) {
    trim.checked = settings.trimModifiers !== false;
  }
  const newWindow = maybeById<HTMLInputElement>(NEW_WINDOW_FIELD);
  if (newWindow) {
    newWindow.checked = settings.openInNewWindow !== false;
  }
  const detail = maybeById<HTMLSelectElement>(DETAIL_FIELD);
  if (detail) {
    detail.value = String(normalizeContextDetail(settings.contextDetail));
    renderDetailHint();
  }
  renderProviders();
  renderTaskTiers();
  refreshProviderModal();
}

/** 「寫完正文刪修飾」那個勾選框的 id。 */
const TRIM_FIELD = 'setTrimModifiers';
/** 「新視窗中開啟專案」那個勾選框的 id。只有獨立版的頁面上有。 */
const NEW_WINDOW_FIELD = 'setOpenInNewWindow';
/** 「上下文詳細度」下拉框與它下面那一行說明的 id。 */
const DETAIL_FIELD = 'setContextDetail';
const DETAIL_HINT = 'contextDetailHint';

/** 選項只建一次：標籤與每一級帶多少都來自 `contextDetail.ts`，前端不另寫。 */
function installDetailSelect(): void {
  const select = maybeById<HTMLSelectElement>(DETAIL_FIELD);
  if (!select) {
    return;
  }
  for (const d of CONTEXT_DETAILS) {
    const option = document.createElement('option');
    option.value = String(d);
    option.textContent = `${d} · ${CONTEXT_DETAIL_LABEL[d]}${d === DEFAULT_CONTEXT_DETAIL ? '（預設）' : ''}`;
    select.appendChild(option);
  }
  select.value = String(DEFAULT_CONTEXT_DETAIL);
  renderDetailHint();
  select.addEventListener('change', () => {
    touch();
    renderDetailHint();
  });
}

/** 下拉框下面那一行：這一級是幹什麼的，具體帶多少。 */
function renderDetailHint(): void {
  const select = maybeById<HTMLSelectElement>(DETAIL_FIELD);
  const hint = maybeById(DETAIL_HINT);
  if (!select || !hint) {
    return;
  }
  const d = normalizeContextDetail(Number(select.value));
  hint.textContent = `${CONTEXT_DETAIL_HINT[d]}。${describeContextDetail(d)}`;
}

function save(): void {
  const settings = {
    providers: draft.providers,
    models: draft.models,
    tierModels: draft.tierModels,
    taskTiers: draft.taskTiers,
  } as SettingsPayload;
  for (const [key, id] of Object.entries(NUMERIC_FIELDS)) {
    settings[key as NumericField] = Number(byId<HTMLInputElement>(id).value);
  }
  settings.trimModifiers = maybeById<HTMLInputElement>(TRIM_FIELD)?.checked !== false;
  const detail = maybeById<HTMLSelectElement>(DETAIL_FIELD);
  settings.contextDetail = normalizeContextDetail(detail ? Number(detail.value) : undefined);
  const newWindow = maybeById<HTMLInputElement>(NEW_WINDOW_FIELD);
  if (newWindow) {
    settings.openInNewWindow = newWindow.checked;
  }
  const problem = validateProviders(draft.providers);
  if (problem) {
    toast(problem, true);
    return;
  }

  // 列表裡指向已刪模型的項要摘掉，而不是儲存一串指向空氣的引用；
  // 全摘光了退回第一個可用的，別讓工程頁任務無模型可用。
  const refs = allRefs();
  settings.models = draft.models.filter((m) => refs.includes(m));
  if (settings.models.length === 0 && refs.length > 0) {
    settings.models = [refs[0]];
  }
  if (settings.models.length !== draft.models.length) {
    toast('預設模型列表裡有已刪除的模型，已自動摘掉。');
  }

  // 檔位清單同樣摘掉指向已刪模型的項，但**摘空了就讓它空著**——
  // 空檔位是有意義的（沿用預設模型），不該像預設模型那樣兜底塞一個進去。
  let droppedFromTiers = 0;
  settings.tierModels = { fast: [], balanced: [], quality: [] };
  for (const tier of MODEL_TIERS) {
    const kept = draft.tierModels[tier].filter((m) => refs.includes(m));
    droppedFromTiers += draft.tierModels[tier].length - kept.length;
    settings.tierModels[tier] = kept;
  }
  if (droppedFromTiers > 0) {
    toast(`檔位裡有 ${droppedFromTiers} 個已刪除的模型，已自動摘掉。`);
  }

  vscode.postMessage({ type: 'saveSettings', settings });
}

export function installSettings(): void {
  bindOpenModal(openProviderModal);
  installProviderModal();
  installCategoryTabs();
  installAdvancedToggle();
  installSkillsPanel();

  for (const id of Object.values(NUMERIC_FIELDS)) {
    maybeById(id)?.addEventListener('input', touch);
  }
  maybeById(TRIM_FIELD)?.addEventListener('change', touch);
  maybeById(NEW_WINDOW_FIELD)?.addEventListener('change', touch);
  installDetailSelect();

  byId('saveSettingsBtn').addEventListener('click', save);
  // 能力探測：只有帶原生設定介面的宿主（VS Code）才渲染這顆按鈕，
  // 獨立版的頁面里根本沒有它——不是渲染出來再 hidden 掉。
  maybeById('nativeSettingsBtn')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'openNativeSettings' })
  );
}

/**
 * 「高階設定」摺疊開關：預設收起模型分檔/任務檔位/請求與排程。
 * 展開狀態是純 UI 狀態，留在前端；重啟後回到預設摺疊。
 */
function installAdvancedToggle(): void {
  const toggle = maybeById<HTMLButtonElement>('settingsAdvancedToggle');
  const box = maybeById('settingsAdvanced');
  if (!toggle || !box) {
    return;
  }
  const sync = () => {
    const open = !box.hidden;
    toggle.setAttribute('aria-expanded', String(open));
    const caret = toggle.querySelector('.caret');
    if (caret) {
      caret.textContent = open ? '▾' : '▸';
    }
  };
  toggle.addEventListener('click', () => {
    box.hidden = !box.hidden;
    sync();
  });
  sync();
}

function showCategory(category: SettingsCategory, focus = false): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')) {
    const active = button.dataset.settingsTab === category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) {
      button.focus();
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-panel]')) {
    const active = panel.dataset.settingsPanel === category;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
  // 「技能」那一頁改了當場生效：底下那顆「儲存設定」與儲存說明在那一頁上只會讓人以為還要再點一下。
  const skills = category === 'skills';
  for (const id of ['settingsSaveRow', 'settingsStorageHint']) {
    const node = maybeById(id);
    if (node) {
      node.hidden = skills;
    }
  }
  if (skills) {
    requestSkills();
  }
}

function installCategoryTabs(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')];
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const category = button.dataset.settingsTab as SettingsCategory | undefined;
      if (category && SETTINGS_CATEGORIES.includes(category)) {
        showCategory(category);
      }
    });
    button.addEventListener('keydown', (event) => {
      const tabs = presentCategories();
      const current = tabs.indexOf(button.dataset.settingsTab as SettingsCategory);
      let next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== current) {
        event.preventDefault();
        showCategory(tabs[next], true);
      }
    });
  }
  showCategory('models');
}
