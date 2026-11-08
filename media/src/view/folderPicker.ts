/**
 * VS Code 遠端風目錄選擇器。沒有選單欄（外掛）就不裝。
 *
 * 資料夾模式走 `listHostDir`；檔案模式鎖在當前工程，走 `listDir`（ephemeral，
 * 不沖掉資源管理器的關注集合）。選本機檔案模式（`hostFile`，後端 `Host.pickHostFile` 推來的
 * `prompt kind: 'file'`）也走 `listHostDir`，只列目錄與允許的副檔名，選定或取消都回 `promptResult`。
 * 歡迎頁的「新建一本書」「匯入寫好的書」（2026-10-24）用 {@link pickHostPath}：選一個目錄或一本 txt，選定交給回呼，
 * 不經後端那一問。
 */
import { el as mk } from '../dom';
import type { DirListing, OutMessage } from '../protocol';
import { hasWorkspace, store, vscode } from './store';
import { openProject } from './welcome';
import { onMessage } from '../vscodeApi';

/** `pickDir` / `pickFile`：{@link pickHostPath}，選定交給 `onPick`。 */
type Intent = 'open' | 'file' | 'hostFile' | 'pickDir' | 'pickFile';

interface PickerState {
  intent: Intent;
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  selected?: string;
  /** 選本機檔案：後端在等的那個彈窗，與允許的副檔名（小寫、不帶點）。 */
  requestId?: string;
  extensions?: string[];
  title?: string;
  onPick?: (path: string) => void;
}

let wrap: HTMLElement | undefined;
let titleEl: HTMLElement | undefined;
let pathInput: HTMLInputElement | undefined;
let listEl: HTMLElement | undefined;
let okBtn: HTMLButtonElement | undefined;
let mkdirBtn: HTMLButtonElement | undefined;
let state: PickerState | undefined;

export function installFolderPicker(): void {
  if (!document.getElementById('wbMenubar')) {
    return;
  }

  wrap = build();
  document.body.appendChild(wrap);

  window.addEventListener('nf-pick-folder', (e) => {
    e.preventDefault();
    openPicker(e.detail.intent);
  });

  // 捕獲階段先拿到 Esc、只關選擇器：它可能是從表單上的「選…」開出來的（新建一本書的「放在」），表單的 Esc 也掛在
  // document 上，不攔下的話一下 Esc 連表單帶填了一半的字一起關掉。
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && wrap?.classList.contains('open')) {
        e.stopPropagation();
        closePicker();
      }
    },
    true
  );

  onMessage((msg) => {
    if (!state) {
      return;
    }
    if (msg.type === 'hostDir' && state.intent !== 'file') {
      applyHostDir(msg);
    } else if (msg.type === 'dirListings' && state.intent === 'file') {
      const listing = msg.listings[0];
      if (listing) {
        applyDirListing(listing);
      }
    }
  });
}

export function openPicker(intent: Intent): void {
  if (!wrap || !titleEl || !pathInput) {
    return;
  }
  if (intent === 'file' && !hasWorkspace()) {
    return;
  }
  state = { intent, path: '', entries: [], truncated: 0 };
  wrap.classList.add('open');
  titleEl.textContent = titleOf(intent);
  if (mkdirBtn) {
    mkdirBtn.hidden = intent === 'file';
  }
  if (intent === 'file') {
    vscode.postMessage({ type: 'listDir', dirs: [''], ephemeral: true });
  } else {
    // 起點是這個視窗開著的工程，空視窗才落到家目錄。
    vscode.postMessage({ type: 'listHostDir', path: store.currentId || '~' });
  }
  pathInput.focus();
}

/**
 * 選本機檔案：後端那頭的 `pickHostFile` 在等，選定之外的一切關法（取消、×、Esc）都回一個
 * undefined，不能只把遮罩藏起來。
 */
export function openHostFilePicker(requestId: string, title: string, startDir: string, extensions: string[]): void {
  if (!wrap || !titleEl || !pathInput) {
    vscode.postMessage({ type: 'promptResult', requestId, value: undefined });
    return;
  }
  if (state?.intent === 'hostFile') {
    closePicker();
  }
  state = {
    intent: 'hostFile',
    path: '',
    entries: [],
    truncated: 0,
    requestId,
    title,
    extensions: extensions.map((e) => e.replace(/^\./, '').toLowerCase()),
  };
  wrap.classList.add('open');
  titleEl.textContent = titleOf('hostFile');
  if (mkdirBtn) {
    mkdirBtn.hidden = true;
  }
  vscode.postMessage({ type: 'listHostDir', path: startDir || '~' });
  pathInput.focus();
}

/**
 * 選一個本機目錄（`dir`：確定的是當前所在的那一層）或一個檔案（`file`：只列目錄與 `extensions` 裡的檔案，點中一個再確定），
 * 選定交給 `onPick`；取消什麼都不做。`start` 是從哪一層開始列，預設家目錄。沒裝選擇器（外掛）就什麼都不做。
 */
export function pickHostPath(opts: {
  kind: 'dir' | 'file';
  title: string;
  start?: string;
  extensions?: string[];
  onPick: (path: string) => void;
}): void {
  if (!wrap || !titleEl || !pathInput) {
    return;
  }
  if (state?.intent === 'hostFile') {
    closePicker();
  }
  const intent: Intent = opts.kind === 'dir' ? 'pickDir' : 'pickFile';
  state = {
    intent,
    path: '',
    entries: [],
    truncated: 0,
    title: opts.title,
    extensions: (opts.extensions ?? []).map((e) => e.replace(/^\./, '').toLowerCase()),
    onPick: opts.onPick,
  };
  wrap.classList.add('open');
  titleEl.textContent = titleOf(intent);
  if (mkdirBtn) {
    mkdirBtn.hidden = intent !== 'pickDir';
  }
  vscode.postMessage({ type: 'listHostDir', path: opts.start || '~' });
  pathInput.focus();
}

/** 選的是檔案（不是目錄）：點中一行才能確定，只列允許的副檔名。 */
function picksFile(intent: Intent): boolean {
  return intent === 'file' || intent === 'hostFile' || intent === 'pickFile';
}

function closePicker(answer?: string): void {
  if (state?.intent === 'hostFile' && state.requestId) {
    vscode.postMessage({ type: 'promptResult', requestId: state.requestId, value: answer });
  }
  wrap?.classList.remove('open');
  state = undefined;
}

function allowed(name: string): boolean {
  const exts = state?.extensions ?? [];
  const dot = name.lastIndexOf('.');
  return exts.length === 0 || (dot > 0 && exts.includes(name.slice(dot + 1).toLowerCase()));
}

function titleOf(intent: Intent): string {
  if (intent === 'file') {
    return '開啟檔案';
  }
  if (intent === 'pickDir') {
    return state?.title ?? '選擇資料夾';
  }
  if (intent === 'hostFile' || intent === 'pickFile') {
    const exts = state?.extensions?.length ? `（${state.extensions.map((e) => `.${e}`).join(' / ')}）` : '';
    return `${state?.title ?? '選擇檔案'}${exts}`;
  }
  return '開啟資料夾';
}

function applyHostDir(msg: Extract<OutMessage, { type: 'hostDir' }>): void {
  if (!state || !pathInput) {
    return;
  }
  state.path = msg.path;
  state.parent = msg.parent;
  state.entries = state.intent === 'hostFile' || state.intent === 'pickFile' ? msg.entries.filter((e) => e.kind === 'dir' || allowed(e.name)) : msg.entries;
  state.truncated = msg.truncated;
  state.error = msg.error;
  state.selected = undefined;
  pathInput.value = msg.path;
  renderList(msg.roots);
  syncOk();
}

function applyDirListing(listing: DirListing): void {
  if (!state || !pathInput) {
    return;
  }
  state.path = listing.relPath;
  state.parent = listing.relPath ? parentOf(listing.relPath) : undefined;
  state.entries = listing.entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    absPath: e.relPath,
  }));
  state.truncated = listing.truncated;
  state.error = listing.error;
  state.selected = undefined;
  pathInput.value = listing.relPath || '/';
  renderList(false);
  syncOk();
}

function renderList(roots?: boolean): void {
  if (!listEl || !state) {
    return;
  }
  listEl.innerHTML = '';
  if (state.error) {
    listEl.appendChild(mk('div', 'nf-picker-error', state.error));
  }
  if (state.parent !== undefined && !roots) {
    listEl.appendChild(row('..', 'dir', state.parent, true));
  }
  for (const entry of state.entries) {
    listEl.appendChild(row(entry.name, entry.kind, entry.absPath, false));
  }
  if (state.truncated) {
    listEl.appendChild(mk('div', 'nf-picker-more', `另有條目未列出（共 ${state.truncated}）`));
  }
}

function row(name: string, kind: 'dir' | 'file', target: string, up: boolean): HTMLElement {
  const btn = mk('button', 'nf-picker-row');
  btn.type = 'button';
  btn.dataset.kind = kind;
  btn.dataset.target = target;
  btn.appendChild(mk('span', 'nf-picker-kind', kind === 'dir' ? '📁' : '📄'));
  btn.appendChild(mk('span', undefined, name));
  if (up) {
    btn.classList.add('up');
  }
  btn.addEventListener('click', () => onRow(kind, target, up));
  return btn;
}

function onRow(kind: 'dir' | 'file', target: string, up: boolean): void {
  if (!state) {
    return;
  }
  if (kind === 'dir' || up) {
    navigate(target);
    return;
  }
  if (!picksFile(state.intent)) {
    return;
  }
  state.selected = target;
  highlightSelection();
  syncOk();
}

function highlightSelection(): void {
  if (!listEl || !state) {
    return;
  }
  for (const node of listEl.querySelectorAll('.nf-picker-row')) {
    node.classList.toggle('selected', (node as HTMLElement).dataset.target === state.selected);
  }
}

function navigate(target: string): void {
  if (!state) {
    return;
  }
  if (state.intent === 'file') {
    vscode.postMessage({ type: 'listDir', dirs: [target], ephemeral: true });
    return;
  }
  vscode.postMessage({ type: 'listHostDir', path: target });
}

function syncOk(): void {
  if (!okBtn || !state) {
    return;
  }
  okBtn.disabled = picksFile(state.intent) ? !state.selected : !state.path;
}

function confirm(): void {
  if (!state) {
    return;
  }
  if (state.intent === 'hostFile') {
    if (state.selected) {
      closePicker(state.selected);
    }
    return;
  }
  if (state.onPick) {
    const chosen = state.intent === 'pickFile' ? state.selected : state.path;
    const onPick = state.onPick;
    if (chosen) {
      closePicker();
      onPick(chosen);
    }
    return;
  }
  if (state.intent === 'file') {
    if (!state.selected) {
      return;
    }
    vscode.postMessage({ type: 'openEditor', path: state.selected });
    closePicker();
    return;
  }
  const chosen = state.path;
  closePicker();
  openProject(chosen);
}

function mkdir(): void {
  if (!state || state.intent === 'file') {
    return;
  }
  const name = window.prompt('新建資料夾名稱', '');
  if (!name?.trim()) {
    return;
  }
  vscode.postMessage({ type: 'createHostDir', parent: state.path, name: name.trim() });
}

function jumpToTyped(): void {
  if (!state || !pathInput) {
    return;
  }
  const typed = pathInput.value.trim();
  if (state.intent === 'file') {
    const rel = typed === '/' ? '' : typed.replace(/^\/+/, '');
    vscode.postMessage({ type: 'listDir', dirs: [rel], ephemeral: true });
    return;
  }
  // 直接粘了一個檔案的完整路徑：副檔名對得上就當選定，讀不讀得到由後端說。
  const typedFile = typed && allowed(typed.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '');
  if (state.intent === 'hostFile' && typedFile) {
    closePicker(typed);
    return;
  }
  if (state.intent === 'pickFile' && typedFile && state.onPick) {
    const onPick = state.onPick;
    closePicker();
    onPick(typed);
    return;
  }
  vscode.postMessage({ type: 'listHostDir', path: typed });
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function build(): HTMLElement {
  const root = mk('div', 'nf-picker');
  const card = mk('div', 'nf-picker-card');
  titleEl = mk('h2');
  pathInput = mk('input');
  pathInput.type = 'text';
  pathInput.spellcheck = false;
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToTyped();
    }
  });
  listEl = mk('div', 'nf-picker-list');

  const actions = mk('div', 'nf-picker-actions');
  mkdirBtn = mk('button', 'chip-btn', '新建資料夾');
  mkdirBtn.type = 'button';
  mkdirBtn.addEventListener('click', mkdir);
  const cancel = mk('button', 'chip-btn', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => closePicker());
  okBtn = mk('button', 'primary', '確定');
  okBtn.type = 'button';
  okBtn.addEventListener('click', confirm);
  actions.append(mkdirBtn, cancel, okBtn);

  card.append(titleEl, pathInput, listEl, actions);
  root.appendChild(card);
  return root;
}
