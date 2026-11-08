/**
 * 服務商配置彈窗。
 *
 * 兩種模式：
 * - `edit` 直接改 draft 裡已有的那個物件（改完即生效，關窗只是收起來）；
 * - `add` 編輯一個臨時物件，**確認後才寫入 draft**——半路取消不該留下殘骸。
 *
 * 因此 `editorTouch()` 只在 edit 模式下把 draft 標髒：add 模式下改臨時物件
 * 與磁碟上的配置無關，標髒了 dirty 就再也清不掉。
 */
import { el as mk, setHidden } from '../../dom';
import type { SerializedModel, SerializedProvider } from '../../protocol';
import { linkBtn, primaryBtn, secondaryBtn } from '../buttons';
import { el } from '../refs';
import { vscode } from '../store';
import { toast } from '../toast';
import { draft, touch, uniqueId, validateProviders } from './draft';
import { compactField, compactNumber, selectField, textField } from './fields';
import { KIND_LABEL, PRESETS } from './presets';
import { renderProviders } from './providerList';

/**
 * 換協議時填進去的預設介面地址。與後端 `defaultBaseUrl` 同源的三個值——
 * 那邊是兜底（留空時用它），這邊是**填給作者看**，好讓他知道該往哪改。
 */
const DEFAULT_BASE_URL: Record<SerializedProvider['kind'], string | undefined> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'vscode-lm': undefined,
};

type ModalMode = 'edit' | 'add' | null;

let mode: ModalMode = null;
/** edit 模式下正在編輯的服務商 id。 */
let editingId: string | null = null;
/** add 模式下的臨時服務商，確認新增後才進 draft。 */
let temp: SerializedProvider | null = null;

export function openProviderModal(id: string): void {
  const p = draft.providers.find((x) => x.id === id);
  if (!p) {
    return;
  }
  mode = 'edit';
  editingId = id;
  fill(p);
  setHidden(el.providerModal, false);
}

export function openAddModal(): void {
  mode = 'add';
  temp = { id: uniqueId('provider'), kind: 'openai', baseUrl: '', models: [{ name: '' }] };
  fill(temp);
  setHidden(el.providerModal, false);
}

export function closeProviderModal(): void {
  if (mode === null) {
    return;
  }
  mode = null;
  editingId = null;
  temp = null;
  setHidden(el.providerModal, true);
  el.providerModalBody.innerHTML = '';
  // 彈窗裡改過的名字、模型數要反映回卡片。
  renderProviders();
}

/** draft.providers 被整體替換後（外部重新整理 / Key 變更），把彈窗重綁到新物件上。 */
export function refreshProviderModal(): void {
  if (mode === 'edit') {
    const p = draft.providers.find((x) => x.id === editingId);
    if (p) {
      fill(p);
    } else {
      closeProviderModal();
    }
  } else if (mode === 'add' && temp) {
    // 臨時物件不在 draft 裡，原樣重建，只重新整理 Key 狀態等。
    fill(temp);
  }
}

function fill(p: SerializedProvider): void {
  el.providerModalTitle.textContent = mode === 'add' ? '新增服務商' : `配置 · ${p.label || p.id}`;
  const body = el.providerModalBody;
  body.innerHTML = '';

  // 新增彈窗頂部放預設，點一下直接填入整套配置。
  if (mode === 'add') {
    body.appendChild(buildPresetRow());
  }
  body.appendChild(buildProviderEditor(p));

  const foot = mk('div', 'modal-foot');
  if (mode === 'add') {
    foot.appendChild(primaryBtn('確認新增', confirmAdd));
    foot.appendChild(secondaryBtn('取消', closeProviderModal));
  } else {
    foot.appendChild(secondaryBtn('完成', closeProviderModal));
  }
  body.appendChild(foot);
}

function buildPresetRow(): HTMLElement {
  const row = mk('div', 'modal-presets');
  row.appendChild(mk('span', 'meta', '從預設填入：'));
  for (const preset of PRESETS) {
    const btn = mk('button', 'chip-btn', preset.label ?? preset.id);
    btn.title = preset.baseUrl || KIND_LABEL[preset.kind];
    btn.addEventListener('click', () => applyPreset(preset));
    row.appendChild(btn);
  }
  return row;
}

/** 點預設：用預設配置替換臨時物件內容，仍可繼續微調。 */
function applyPreset(preset: SerializedProvider): void {
  if (!temp) {
    return;
  }
  const copy: SerializedProvider = JSON.parse(JSON.stringify(preset));
  temp.id = uniqueId(preset.id);
  temp.label = copy.label;
  temp.kind = copy.kind;
  temp.baseUrl = copy.baseUrl;
  temp.models = copy.models;
  fill(temp);
}

function confirmAdd(): void {
  const p = temp;
  if (!p) {
    return;
  }
  const problem = validateProviders([p]);
  if (problem) {
    toast(problem, true);
    return;
  }
  if (draft.providers.some((x) => x.id === p.id)) {
    toast(`字首「${p.id}」與已有服務商重複。`, true);
    return;
  }
  draft.providers.push(p);
  touch();
  closeProviderModal();
  toast(`已新增「${p.label || p.id}」，模型引用字首為 ${p.id}/，記得儲存。`);
}

/** add 模式下編輯的是臨時物件，不能把 draft 標髒，否則 dirty 清不掉。 */
function editorTouch(): void {
  if (mode === 'edit') {
    touch();
  }
}

/** 彈窗裡的完整編輯器。 */
function buildProviderEditor(p: SerializedProvider): HTMLElement {
  const card = mk('div', 'provider-block');

  const head = mk('div', 'provider-head');
  const title = mk('span', 'provider-title', p.label || p.id);
  head.appendChild(title);
  head.appendChild(mk('span', 'meta', KIND_LABEL[p.kind] || p.kind));
  card.appendChild(head);

  /** 名字一變，卡片標題與彈窗標題都要跟著走。 */
  const syncTitle = () => {
    title.textContent = p.label || p.id;
    if (mode === 'edit') {
      el.providerModalTitle.textContent = `配置 · ${p.label || p.id}`;
    }
  };

  const modelBox = mk('div', 'model-list');
  const renderModelRows = () => {
    modelBox.innerHTML = '';
    for (const m of p.models) {
      modelBox.appendChild(buildModelRow(p, m, renderModelRows));
    }
  };

  const row = mk('div', 'grid');
  row.appendChild(
    // 協議型別：從前只能由預設決定，手工新增的服務商永遠是 openai——想接
    // Anthropic 只能去手改配置檔案。它換了以後 baseUrl / API Key 那幾塊也要
    // 跟著變，所以整塊重畫。
    selectField(
      '協議型別',
      p.kind,
      [
        ['openai', KIND_LABEL.openai],
        ['anthropic', KIND_LABEL.anthropic],
        ['vscode-lm', KIND_LABEL['vscode-lm']],
      ],
      (v) => {
        p.kind = v as SerializedProvider['kind'];
        // 介面地址跟著協議走：換了協議還留著上一家的地址，一定 404。
        p.baseUrl = DEFAULT_BASE_URL[p.kind];
        editorTouch();
        fill(p);
      }
    )
  );
  row.appendChild(
    textField('字首 id', p.id, '不能含斜槓', (v) => {
      p.id = v.trim();
      if (mode === 'edit') {
        editingId = p.id;
      }
      syncTitle();
      editorTouch();
      // 模型行上顯示的是完整引用 `字首/模型名`，字首變了要一起重新整理。
      renderModelRows();
    })
  );
  row.appendChild(
    textField('顯示名', p.label || '', '可留空', (v) => {
      p.label = v.trim() || undefined;
      syncTitle();
      editorTouch();
    })
  );
  card.appendChild(row);

  if (p.kind !== 'vscode-lm') {
    card.appendChild(
      textField('介面地址 baseUrl', p.baseUrl || '', 'https://…', (v) => {
        p.baseUrl = v.trim() || undefined;
        editorTouch();
      })
    );
  }

  const modelsHead = mk('div', 'provider-head');
  modelsHead.appendChild(mk('span', 'meta', p.kind === 'vscode-lm' ? '模型 family' : '模型'));
  modelsHead.appendChild(
    linkBtn('＋ 新增模型', () => {
      p.models.push({ name: '' });
      editorTouch();
      renderModelRows();
    })
  );
  card.appendChild(modelsHead);

  card.appendChild(modelBox);
  renderModelRows();

  card.appendChild(p.kind === 'vscode-lm' ? buildLmHint() : buildKeyRow(p));
  return card;
}

function buildLmHint(): HTMLElement {
  return mk(
    'div',
    'hint',
    '複用 GitHub Copilot 訂閱，無需 API Key。模型有硬性輸入配額，裝配器會自動收緊預算。'
  );
}

/** API Key 從不回顯，這裡只顯示「有沒有」，設定與清除都走宿主。 */
function buildKeyRow(p: SerializedProvider): HTMLElement {
  const keyRow = mk('div', 'key-row');
  const has = !!draft.keys[p.id];
  const status = mk('span', 'key-status', has ? '✓ 已儲存 API Key' : '未設定 API Key');
  status.classList.toggle('set', has);
  keyRow.appendChild(status);
  keyRow.appendChild(
    secondaryBtn('設定 Key', () => vscode.postMessage({ type: 'setApiKey', providerId: p.id }))
  );
  keyRow.appendChild(
    secondaryBtn('清除', () => vscode.postMessage({ type: 'clearApiKey', providerId: p.id }))
  );
  return keyRow;
}

function buildModelRow(
  p: SerializedProvider,
  m: SerializedModel,
  rerender: () => void
): HTMLElement {
  const row = mk('div', 'model-row');

  const ref = mk('code', 'model-ref');
  const updateRef = () => {
    ref.textContent = m.name ? `${p.id}/${m.name}` : `${p.id}/…`;
  };
  updateRef();

  row.appendChild(
    compactField('模型名', m.name, p.kind === 'vscode-lm' ? 'gpt-4o' : 'glm-4-plus', (v) => {
      m.name = v.trim();
      editorTouch();
      updateRef();
    })
  );
  row.appendChild(
    compactField('顯示名', m.label || '', '可留空', (v) => {
      m.label = v.trim() || undefined;
      editorTouch();
    })
  );
  row.appendChild(
    compactNumber('視窗', m.contextWindow, '預設', (v) => {
      m.contextWindow = v;
      editorTouch();
    })
  );
  row.appendChild(
    compactNumber('輸出上限', m.maxOutputTokens, '預設', (v) => {
      m.maxOutputTokens = v;
      editorTouch();
    })
  );

  const tail = mk('div', 'model-tail');
  tail.appendChild(ref);
  tail.appendChild(linkBtn('測試', () => testModel(p, m)));
  tail.appendChild(
    linkBtn('刪除', () => {
      p.models = p.models.filter((x) => x !== m);
      touch();
      rerender();
    })
  );
  row.appendChild(tail);
  return row;
}

/**
 * 把螢幕上這份服務商一起發過去，測的就是眼前這份配置——新加的模型、
 * 剛改的 baseUrl 不必先儲存也能驗。API Key 仍取已儲存的：它從不回顯，
 * 草稿裡也就沒有。
 */
function testModel(p: SerializedProvider, m: SerializedModel): void {
  if (!m.name) {
    toast('先填模型名。', true);
    return;
  }
  vscode.postMessage({
    type: 'testConnection',
    ref: `${p.id}/${m.name}`,
    provider: JSON.parse(JSON.stringify(p)),
  });
}

export function installProviderModal(): void {
  el.providerModalClose.addEventListener('click', closeProviderModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeProviderModal();
    }
  });
  el.addProviderBtn.addEventListener('click', openAddModal);
}
