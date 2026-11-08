/**
 * 「轉到…」：`Ctrl+P`（Mac 上 `Cmd+P`）或標題欄「檔案 → 轉到…」，頁面頂部居中一個輸入框 + 候選列表，
 * 按章號、標題、角色名 / 別名、設定標題、路徑找一章或一個檔案開啟。只在獨立版（editor.js 只在那兒載入，
 * `editor/index.ts` 探測不到 `#wbEditor` 就整個不裝）。
 *
 * ## 資料
 *
 * 開啟時發 `requestQuickOpen`（帶 requestId），後端回 `quickOpenIndex`（`core/views/quickOpen.ts`）。**按需要**，
 * 不常駐推送；面板開著時工程變了不重新整理，下次開啟再要。上一次的索引留著：再開啟時先拿它畫（幾百章也是當場出），
 * 新的一到就換掉。匹配與排序全在零 DOM 的 `quickOpenCore.ts`。
 *
 * ## 鍵盤（照 `/` 命令面板的教訓）
 *
 * - 過濾串**從輸入框的值算**，重算掛在 `input` 事件上（組字中途的不算，`compositionend` 再算一次），不在 keydown
 *   裡攢字——輸入法打的中文、退格、貼上全都自動對。
 * - 輸入框只接管 ↑↓ / Enter / Ctrl+Enter / Esc（Tab 留在面板裡）；組字中途一個都不攔（`isImeComposing`）。
 * - `Ctrl+P` 在焦點落在編輯區之外的輸入框 / 文字框（左側對話輸入框之類）時照樣能用——這個鍵在那些地方沒有別的用處；
 *   Chrome 允許頁面攔下「列印」。沒開工程時不開面板，只說一句（也不彈列印）。頁內對話方塊、彈窗開著時不開。
 *
 * ## 開啟什麼
 *
 * - 章節：Enter 與工程頁點章節行**同一個動作**（`openChapter`：正文進主區，有細綱時並排開細綱；沒有正文開細綱）；
 *   Ctrl+Enter 把正文（沒有正文時是細綱）開在第二塊編輯區。
 * - 角色卡、設定、架構幾件、草稿：開啟那個檔案（Ctrl+Enter 開在第二塊）。
 * - 開啟後焦點進編輯區：等那份檔案的 `editorOpen` 到了，把焦點放進擁有它的那一塊（章節並排的細綱隨後才到，
 *   到了也把焦點留在正文那一塊）。
 *
 * ## 最近開啟的
 *
 * 編輯器裡每啟用一份檔案（`nf-editor-active`，不論從哪開啟的）記一筆，按工程記在 localStorage
 * （`novelforge.quickopen.recent@<工程>`），記不進去就算了。空輸入時列出來（按路徑認回條目：同一章的正文與細綱
 * 算一條，刪了的、不在索引裡的跳過），後面接前幾章。
 */
import { clear, el } from '../dom';
import { projectStorageKey, toast } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { openChapterMessage } from '../narrow';
import { isImeComposing } from './api';
import { isDialogOpen } from './dialog';
import {
  QUICK_OPEN_LIMIT,
  RECENT_KEPT,
  buildCatalog,
  highlightSegments,
  pushRecent,
  searchQuickOpen,
} from './quickOpenCore';
import type { QuickOpenCatalog, QuickOpenEntry, QuickOpenHit } from './quickOpenCore';
import { claimRequest, newRequestId } from './replace';
import { shortcutLabel } from './shortcuts';
import { announceActive, paneOwning, setActivePane } from './store';

const RECENT_KEY = 'novelforge.quickopen.recent';
/** 開啟之後等那份檔案的 `editorOpen` 多久（之後到的不再搶焦點）。 */
const FOCUS_WAIT_MS = 3000;
const NO_WORKSPACE = '先開啟一個工程，才能轉到章節或檔案。';

interface PanelDom {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  note: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let panel: PanelDom | null = null;
/** 最近一份索引（切好的）。換工程時作廢。 */
let catalog: QuickOpenCatalog | null = null;
/** 正在等的那一次請求。 */
let waiting: string | null = null;
let hits: QuickOpenHit[] = [];
let active = 0;
/** 開啟面板之前焦點在哪（Esc 關掉時還回去）。 */
let returnFocus: HTMLElement | null = null;
/** 開啟之後焦點要落進哪份檔案所在的那一塊，以及還在等哪幾份的 `editorOpen`。 */
let focusAfter: { path: string; expect: Set<string>; until: number } | null = null;

// ---------------------------------------------------------------- 最近開啟的

function loadRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(projectStorageKey(RECENT_KEY)) || '[]');
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string').slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

function rememberOpened(path: string): void {
  try {
    const list = loadRecent();
    if (list[0] === path) {
      return;
    }
    localStorage.setItem(projectStorageKey(RECENT_KEY), JSON.stringify(pushRecent(list, path)));
  } catch {
    /* 隱私模式下寫不進去：沒有「最近開啟的」，別的照常 */
  }
}

// ---------------------------------------------------------------- 開關

function workspaceOpen(): boolean {
  return !document.body.classList.contains('no-workspace');
}

/** 頁內對話方塊、彈窗（表單、合併檢視、目錄選擇器）開著時不開面板——那時作者在答別的問題。 */
function blocked(): boolean {
  return isDialogOpen() || !!document.querySelector('.modal-overlay:not(.hidden)');
}

/** 開啟「轉到」面板。已經開著就把輸入框裡的字全選上。 */
export function openQuickOpen(): void {
  if (panel) {
    panel.input.focus();
    panel.input.select();
    return;
  }
  if (!workspaceOpen()) {
    toast(NO_WORKSPACE);
    return;
  }
  if (blocked()) {
    return;
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel = buildPanel();
  document.body.appendChild(panel.root);
  document.addEventListener('mousedown', onOutside, true);
  panel.input.focus();
  waiting = newRequestId('quickopen');
  post({ type: 'requestQuickOpen', requestId: waiting });
  render();
}

/** 關掉面板。`restoreFocus`：焦點還回開啟之前的地方（Esc）；開啟了某一項時不還（焦點要進編輯區）。 */
export function closeQuickOpen(restoreFocus = false): void {
  if (!panel) {
    return;
  }
  document.removeEventListener('mousedown', onOutside, true);
  const hadFocus = panel.root.contains(document.activeElement);
  panel.root.remove();
  panel = null;
  hits = [];
  if (restoreFocus && hadFocus && returnFocus?.isConnected) {
    returnFocus.focus();
  }
  returnFocus = null;
}

/** 點在面板外面：關掉（不還焦點——點到哪兒焦點就該去哪兒）。 */
function onOutside(e: MouseEvent): void {
  if (panel && !panel.root.contains(e.target as Node)) {
    closeQuickOpen(false);
  }
}

// ---------------------------------------------------------------- DOM

function buildPanel(): PanelDom {
  const root = el('div', 'qo-panel');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '轉到');
  const input = el('input', 'qo-input');
  input.type = 'text';
  input.placeholder = '轉到：章號（12、第十二章）、標題、角色名、設定或路徑';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  const list = el('div', 'qo-list');
  list.setAttribute('role', 'listbox');
  list.id = 'qoList';
  input.setAttribute('aria-controls', list.id);
  const note = el('div', 'qo-note hidden');
  note.setAttribute('aria-live', 'polite');
  const foot = el('div', 'qo-foot', `↑↓ 選擇 · Enter 開啟 · ${shortcutLabel('quickOpenBeside')} 開在另一塊編輯區 · Esc 關閉`);
  root.append(input, list, note, foot);

  input.addEventListener('input', (e) => {
    // 組字中途（拼音還沒上屏）不重算：compositionend 之後那一下再算。
    if ((e as InputEvent).isComposing) {
      return;
    }
    render();
  });
  input.addEventListener('compositionend', () => render());
  input.addEventListener('keydown', onKey);
  return { root, input, list, note };
}

function onKey(e: KeyboardEvent): void {
  if (isImeComposing(e)) {
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      if (hits.length > 0) {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + hits.length) % hits.length;
        markActive();
      }
      return;
    }
    case 'Enter': {
      e.preventDefault();
      const hit = hits[active];
      if (hit) {
        openEntry(hit.entry, e.ctrlKey || e.metaKey);
      }
      return;
    }
    case 'Escape':
      e.preventDefault();
      // 別讓標題欄、查詢條那幾個 document 上的 Esc 再處理一遍。
      e.stopPropagation();
      closeQuickOpen(true);
      return;
    case 'Tab':
      // 焦點留在面板裡：Tab 出去等於面板還開著、鍵盤卻不歸它了。
      e.preventDefault();
      return;
  }
}

/**
 * 按輸入框的值重算、重畫。輸入變了選中回到第一條；`keepActive`（新索引到了、輸入沒變）時儘量停在原來那一條上。
 */
function render(keepActive = false): void {
  if (!panel) {
    return;
  }
  const query = panel.input.value;
  const activeKey = keepActive ? hits[active]?.entry.key : undefined;
  const result = catalog ? searchQuickOpen(catalog, query, { limit: QUICK_OPEN_LIMIT, recent: loadRecent() }) : { hits: [], total: 0 };
  hits = result.hits;
  const kept = activeKey ? hits.findIndex((h) => h.entry.key === activeKey) : -1;
  active = kept >= 0 ? kept : 0;

  clear(panel.list);
  let group: QuickOpenHit['group'];
  hits.forEach((hit, i) => {
    if (hit.group && hit.group !== group) {
      group = hit.group;
      panel!.list.appendChild(el('div', 'qo-section', group === 'recent' ? '最近開啟的' : '章節'));
    }
    panel!.list.appendChild(buildRow(hit, i));
  });
  setNote(noteFor(query, result.total));
  markActive();
}

function noteFor(query: string, total: number): string {
  if (!catalog) {
    return '正在讀取這本書的章節與檔案…';
  }
  if (!catalog.initialized) {
    return '這個資料夾還不是小說工程，沒有可轉到的章節。';
  }
  if (query.trim() === '') {
    return hits.length === 0 ? '還沒有章節，也沒有最近開啟過的檔案。' : '';
  }
  if (total === 0) {
    return '沒有匹配的章節、角色、設定或檔案。';
  }
  if (total > hits.length) {
    return `只列出前 ${hits.length} 條（一共 ${total} 條），多打幾個字縮小範圍。`;
  }
  return '';
}

function setNote(text: string): void {
  if (!panel) {
    return;
  }
  panel.note.textContent = text;
  panel.note.classList.toggle('hidden', text === '');
}

function buildRow(hit: QuickOpenHit, i: number): HTMLElement {
  const { entry } = hit;
  const row = el('div', `qo-item qo-${entry.kind}`);
  row.setAttribute('role', 'option');
  row.id = `qoItem${i}`;
  row.dataset.key = entry.key;
  row.title = entry.path;

  row.appendChild(el('span', `qo-badge qo-badge-${entry.kind}`, entry.badge));
  const text = el('span', 'qo-text');
  text.appendChild(highlighted('qo-name', entry.name, hit.nameHits));
  text.appendChild(highlighted('qo-detail', hit.detail, hit.detailHits));
  row.appendChild(text);

  // 點一下不該把焦點從輸入框拿走（拿走了 ↑↓ 就不歸面板了）。
  row.addEventListener('mousedown', (e) => e.preventDefault());
  row.addEventListener('click', (e) => openEntry(entry, e.ctrlKey || e.metaKey));
  return row;
}

/** 一段字，命中的字包進 `<mark>`。不拼 HTML：一截一截 textContent。 */
function highlighted(cls: string, text: string, hitsAt: readonly number[]): HTMLElement {
  const node = el('span', cls);
  for (const seg of highlightSegments(text, hitsAt)) {
    node.appendChild(seg.hit ? el('mark', undefined, seg.text) : document.createTextNode(seg.text));
  }
  return node;
}

function markActive(): void {
  if (!panel) {
    return;
  }
  const rows = panel.list.querySelectorAll<HTMLElement>('.qo-item');
  rows.forEach((row, i) => {
    const on = i === active;
    row.classList.toggle('active', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const current = rows[active];
  if (current) {
    panel.input.setAttribute('aria-activedescendant', current.id);
    if (typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest' });
    }
  } else {
    panel.input.removeAttribute('aria-activedescendant');
  }
}

// ---------------------------------------------------------------- 開啟

/**
 * 開啟一條。`other`：開在第二塊編輯區（Ctrl+Enter / Ctrl+點選）。
 *
 * 不帶「臨時標籤」那一類標記：從這裡開啟是作者明確要去的地方，開成正常的標籤。
 */
function openEntry(entry: QuickOpenEntry, other: boolean): void {
  closeQuickOpen(false);
  let expect: string[];
  if (entry.kind === 'chapter' && !other) {
    // 與工程頁點章節行同一個動作：後端按宿主能力開正文與並排的細綱。
    post(openChapterMessage(entry.path));
    expect = [entry.chapterPath, entry.plotPath].filter((p): p is string => !!p);
  } else {
    post({ type: 'openEditor', path: entry.path, pane: other ? 'draft' : 'main' });
    expect = [entry.path];
  }
  focusAfter = { path: entry.path, expect: new Set(expect), until: Date.now() + FOCUS_WAIT_MS };
}

/** 開啟的那份檔案到了：焦點放進擁有它的那一塊。章節並排的細綱隨後才到，到了也把焦點留在正文那一塊。 */
function settleFocus(path: string): void {
  if (!focusAfter) {
    return;
  }
  if (Date.now() > focusAfter.until) {
    focusAfter = null;
    return;
  }
  if (!focusAfter.expect.delete(path)) {
    return;
  }
  const pane = paneOwning(focusAfter.path);
  if (pane) {
    setActivePane(pane);
    announceActive();
    pane.area.focus();
  }
  if (focusAfter.expect.size === 0) {
    focusAfter = null;
  }
}

// ---------------------------------------------------------------- 裝配

function onIndex(msg: Extract<OutMessage, { type: 'quickOpenIndex' }>): void {
  if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
    return;
  }
  waiting = null;
  catalog = buildCatalog(msg.index);
  render(true);
}

let installed = false;

/**
 * 裝上 Ctrl+P、「檔案 → 轉到…」、索引與 `editorOpen` 的接收、最近開啟的記錄。`editor/index.ts` 調一次，
 * **要在它自己的 `onMessage` 之後**：`editorOpen` 先讓編輯區收下檔案，這裡才找得到擁有它的那一塊。
 */
export function installQuickOpen(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
      return;
    }
    if (e.key !== 'p' && e.key !== 'P' && e.code !== 'KeyP') {
      return;
    }
    // 瀏覽器的「列印」在這裡沒有用處（Chrome 允許頁面攔下它）。
    e.preventDefault();
    openQuickOpen();
  });

  window.addEventListener('nf-quickopen-query', (e) => {
    e.detail.available = workspaceOpen();
    e.detail.reason = e.detail.available ? undefined : NO_WORKSPACE;
  });
  window.addEventListener('nf-quickopen-command', (e) => {
    if (e.detail.name === 'open') {
      openQuickOpen();
    }
  });

  window.addEventListener('nf-editor-active', (e) => {
    if (e.detail.path && workspaceOpen()) {
      rememberOpened(e.detail.path);
    }
  });

  window.addEventListener('nf-workspace-reset', () => {
    closeQuickOpen(false);
    catalog = null;
    waiting = null;
    focusAfter = null;
  });

  onMessage((msg) => {
    if (msg.type === 'quickOpenIndex') {
      onIndex(msg);
    } else if (msg.type === 'editorOpen') {
      settleFocus(msg.file.path);
    }
  });
}
