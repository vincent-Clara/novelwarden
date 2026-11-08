/**
 * 全書查詢替換：`Ctrl+Shift+F`（替換框 `Ctrl+Shift+H`，Mac 上 `Cmd`）或標題欄「編輯 → 全書查詢替換…」。只在獨立版
 * （editor.js 只在那兒載入，`editor/index.ts` 探測不到 `#wbEditor` 就整個不裝）。
 *
 * ## 放在哪（⚑）
 *
 * **壓在側欄上**，與 VS Code 的「搜尋」檢視一樣：面板掛進 `#wbSide`、側欄掛 `bf-open`，原來那幾頁（對話、工程……）先藏起來，
 * 頁頭的任務條照常；編輯區一點都不擋——點一處、右邊編輯區跳過去，左邊的結果列表還在，對照著往下看。點活動欄上任一頁籤、
 * 面板上的 ×、Esc 收起（結果留著，再開啟還在）。不做成浮層：浮層要麼擋正文，要麼擋結果。
 *
 * ## 查詢
 *
 * 查詢框裡打字，**停頓 300ms** 才發（組字中途不發，`compositionend` 再算）；新的一次發出去之前先 `cancelBookFind` 上一次。
 * 區分大小寫、正則兩顆開關與查詢條同一套語義（匹配口徑是 core 的 `model/textFind.ts`，後端用的就是它）。範圍六個勾選框，
 * 預設只勾正文。結果按範圍分組、按檔案列：檔案的稱呼（與編輯器標籤同一套）、一共幾處、每一處一行上下文（命中的字高亮）。
 * **搜的是磁碟上的內容**（⚑）：編輯器裡開著、有未儲存修改的檔案在結果上標「未儲存」（列的是磁碟上那一份，替換時跳過）。
 *
 * 點某一處：那份檔案已經開著就切過去，沒開著就開成正常標籤（不帶臨時標籤的標記）；然後借查詢條的定位（`find.ts` 的
 * `revealFindMatch`：換成同一個查詢串與開關、按後端給的「行 + 列」認回編輯區裡的位置、選中離它最近的那一處、滾過去）。
 *
 * ## 替換
 *
 * 填好替換框 →「預覽替換」→ 每一處畫成「舊字劃掉 + 新字」，每一處、每個檔案都有勾選框（預設全勾；未儲存的那幾份勾不了）→
 * 「替換所選」（兩段式：第一下只把字換成「再點一下：替換 N 個檔案 M 處」，第二下才發，⚑）→ 彙總（替換了幾個檔案幾處、
 * 每份都在「歷史」裡留著替換前那一版、跨檔案沒有一步撤銷、指紋鏈怎麼處理的、角色卡改名、跳過了哪些與為什麼）。替換完自動
 * 再搜一次，列出還剩下的。寫盤在後端（`features/bookReplace.ts`，經閘道器）；已開著的沒改過的標籤靠磁碟同步（`diskSync.ts`）
 * 就地換成新內容，改過的掛衝突條——這裡什麼都不用做。
 */
import { clear, el } from '../dom';
import { toast } from '../globals';
import {
  BOOK_FIND_SCOPES,
  BOOK_FIND_SCOPE_HINT,
  BOOK_FIND_SCOPE_LABEL,
  DEFAULT_BOOK_FIND_SCOPES,
} from '../protocol';
import type {
  BookFindFile,
  BookFindHit,
  BookFindQuery,
  BookFindResult,
  BookFindScope,
  BookReplaceSummary,
  InMessage,
  OutMessage,
} from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, isImeComposing, onEditorChange } from './api';
import {
  buildReplaceRequest,
  fileCheck,
  groupByScope,
  hitKey,
  offsetAt,
  pickedCount,
  pruneExcluded,
  resultNotes,
  resultStatus,
  sameQuery,
  summaryLines,
} from './bookFindCore';
import { isDialogOpen } from './dialog';
import { revealFindMatch } from './find';
import { seedFromSelection } from './findCore';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { allOpenFiles, announceActive, paneOwning, setActivePane } from './store';

/** 停頓多久才搜。 */
export const BOOK_FIND_DEBOUNCE_MS = 300;
/** 「替換所選」第一下之後，多久沒點第二下就退回去。 */
const CONFIRM_MS = 4000;
/** 點了一處、那份檔案還沒開著：等它的 `editorOpen` 多久。 */
const JUMP_WAIT_MS = 3000;
const NO_WORKSPACE = '先開啟一個工程，才能全書查詢。';

interface PanelDom {
  root: HTMLElement;
  close: HTMLButtonElement;
  query: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  replace: HTMLInputElement;
  preview: HTMLButtonElement;
  scopes: Map<BookFindScope, HTMLInputElement>;
  status: HTMLElement;
  stop: HTMLButtonElement;
  notes: HTMLElement;
  summary: HTMLElement;
  actions: HTMLElement;
  replaceSelected: HTMLButtonElement;
  exitPreview: HTMLButtonElement;
  results: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let panel: PanelDom | null = null;

const opts = { caseSensitive: false, regex: false };
let mode: 'find' | 'preview' = 'find';
/** 正在等的那一次查詢，與它的條件。 */
let waiting: string | null = null;
let waitingQuery: BookFindQuery | null = null;
/** 畫著的結果，與它是按什麼條件搜出來的（點一處時按它定位、替換時按它拼請求）。 */
let result: BookFindResult | null = null;
let resultQuery: BookFindQuery | null = null;
/** 預覽裡勾掉的那幾處（`hitKey`）。 */
let excluded = new Set<string>();
/** 收起來的檔案。 */
const collapsed = new Set<string>();
let replacing: string | null = null;
let summary: BookReplaceSummary | null = null;
let armed = false;
let armTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
/** 開啟面板之前焦點在哪（Esc 收起時還回去）。 */
let returnFocus: HTMLElement | null = null;
/** 點了一處、那份檔案還沒開著：等它到了再定位。 */
let pendingJump: { path: string; hit: BookFindHit; query: BookFindQuery; until: number } | null = null;

// ---------------------------------------------------------------- 開關

function workspaceOpen(): boolean {
  return !document.body.classList.contains('no-workspace');
}

/** 頁內對話方塊、彈窗開著時不開——那時作者在答別的問題。 */
function blocked(): boolean {
  return isDialogOpen() || !!document.querySelector('.modal-overlay:not(.hidden)');
}

function side(): HTMLElement | null {
  return document.getElementById('wbSide');
}

export function isBookFindOpen(): boolean {
  return !!panel && !panel.root.classList.contains('hidden');
}

/** 開啟面板（已經開著就把焦點放回查詢框）。`replace`：焦點進替換框（查詢框還空著時仍進查詢框）。 */
export function openBookFind(o: { replace?: boolean } = {}): void {
  if (!workspaceOpen()) {
    toast(NO_WORKSPACE);
    return;
  }
  if (blocked()) {
    return;
  }
  const p = ensurePanel();
  if (!isBookFindOpen()) {
    returnFocus = document.activeElement instanceof HTMLElement && !p.root.contains(document.activeElement) ? document.activeElement : null;
    p.root.classList.remove('hidden');
    side()?.classList.add('bf-open');
  }
  // 編輯區裡選著一行之內的幾個字：預填進查詢框，當場搜。
  const ed = activeEditor();
  const seed = ed && !p.root.contains(document.activeElement)
    ? seedFromSelection(ed.area.value, ed.area.selectionStart, ed.area.selectionEnd)
    : undefined;
  if (seed !== undefined && seed !== p.query.value) {
    p.query.value = seed;
    inputsChanged(true);
  }
  const target = o.replace && p.query.value ? p.replace : p.query;
  target.focus();
  target.select();
}

/** 收起面板（結果留著，再開啟還在）。`restoreFocus`：焦點還回開啟之前的地方（Esc、×）。 */
export function closeBookFind(restoreFocus = false): void {
  if (!panel || !isBookFindOpen()) {
    return;
  }
  const hadFocus = panel.root.contains(document.activeElement);
  panel.root.classList.add('hidden');
  side()?.classList.remove('bf-open');
  disarm();
  if (restoreFocus && hadFocus && returnFocus?.isConnected) {
    returnFocus.focus();
  }
  returnFocus = null;
}

// ---------------------------------------------------------------- DOM

function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  return b;
}

function textInput(cls: string, placeholder: string): HTMLInputElement {
  const input = el('input', cls);
  // 不用 type="search"：Chrome 裡在 search 框按 Esc 是清空文字，與「Esc 收起面板」打架（同查詢條）。
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function ensurePanel(): PanelDom {
  if (panel) {
    return panel;
  }
  const root = el('section', 'bf-panel hidden');
  root.setAttribute('role', 'search');
  root.setAttribute('aria-label', '全書查詢替換');

  const head = el('div', 'bf-head');
  const close = button('icon-btn bf-close', '×', '收起（Esc）');
  head.append(el('span', 'bf-title', '全書查詢替換'), close);

  const findRow = el('div', 'bf-row');
  const query = textInput('bf-query', '全書查詢');
  const caseBtn = button('ed-find-opt bf-case', 'Aa', '區分大小寫');
  const regexBtn = button('ed-find-opt bf-regex', '.*', '正規表示式（與查詢條同一套：替換裡可以用 $1 引用分組）');
  for (const b of [caseBtn, regexBtn]) {
    b.setAttribute('aria-pressed', 'false');
  }
  findRow.append(query, caseBtn, regexBtn);

  const replaceRow = el('div', 'bf-row');
  const replace = textInput('bf-replace', '替換為');
  const preview = button('chip-btn bf-preview', '預覽替換', '先列出每一處換成什麼，看過、勾過再替換（Enter）');
  replaceRow.append(replace, preview);

  const scopeRow = el('div', 'bf-scopes');
  const scopes = new Map<BookFindScope, HTMLInputElement>();
  for (const scope of BOOK_FIND_SCOPES) {
    const label = el('label', 'bf-scope');
    label.title = BOOK_FIND_SCOPE_HINT[scope];
    const box = el('input');
    box.type = 'checkbox';
    box.dataset.scope = scope;
    box.checked = DEFAULT_BOOK_FIND_SCOPES.includes(scope);
    label.append(box, el('span', undefined, BOOK_FIND_SCOPE_LABEL[scope]));
    scopes.set(scope, box);
    scopeRow.appendChild(label);
  }

  const statusRow = el('div', 'bf-statusbar');
  const status = el('span', 'bf-status');
  status.setAttribute('aria-live', 'polite');
  const stop = button('chip-btn bf-stop hidden', '停止', '不搜了');
  statusRow.append(status, stop);

  const notes = el('div', 'bf-notes hidden');
  const summaryBox = el('div', 'bf-summary hidden');
  summaryBox.setAttribute('aria-live', 'polite');

  const actions = el('div', 'bf-actions hidden');
  const replaceSelected = button('primary bf-replace-selected', '替換所選', '');
  const exitPreview = button('secondary bf-exit-preview', '退出預覽', '回到只查詢');
  actions.append(replaceSelected, exitPreview);

  const results = el('div', 'bf-results');
  root.append(head, findRow, replaceRow, scopeRow, statusRow, notes, summaryBox, actions, results);

  panel = {
    root, close, query, caseBtn, regexBtn, replace, preview, scopes, status, stop,
    notes, summary: summaryBox, actions, replaceSelected, exitPreview, results,
  };
  wire(panel);
  (side() ?? document.body).appendChild(root);
  return panel;
}

function wire(p: PanelDom): void {
  p.query.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      inputsChanged();
    }
  });
  p.query.addEventListener('compositionend', () => inputsChanged());
  p.replace.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) {
      replacementChanged();
    }
  });
  p.replace.addEventListener('compositionend', () => replacementChanged());
  p.query.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  p.replace.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      startPreview();
    }
  });
  // 面板裡任何一處按 Esc 都是收起（組字中途的 Esc 是輸入法的）。
  p.root.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeBookFind(true);
    }
  });
  p.close.addEventListener('click', () => closeBookFind(true));
  p.caseBtn.addEventListener('click', () => toggleOption(p.caseBtn, 'caseSensitive'));
  p.regexBtn.addEventListener('click', () => toggleOption(p.regexBtn, 'regex'));
  for (const box of p.scopes.values()) {
    box.addEventListener('change', () => inputsChanged(true));
  }
  p.preview.addEventListener('click', startPreview);
  p.exitPreview.addEventListener('click', () => {
    mode = 'find';
    excluded.clear();
    runSearch();
  });
  p.replaceSelected.addEventListener('click', replaceSelected);
  p.stop.addEventListener('click', stopSearch);
}

function toggleOption(btn: HTMLButtonElement, key: 'caseSensitive' | 'regex'): void {
  opts[key] = !opts[key];
  btn.classList.toggle('on', opts[key]);
  btn.setAttribute('aria-pressed', String(opts[key]));
  inputsChanged(true);
}

// ---------------------------------------------------------------- 查詢

/** 面板上此刻的查詢條件。預覽時帶替換框裡的字。 */
function currentQuery(): BookFindQuery {
  const p = panel!;
  return {
    query: p.query.value,
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    scopes: BOOK_FIND_SCOPES.filter((s) => p.scopes.get(s)?.checked),
    ...(mode === 'preview' ? { replacement: p.replace.value } : {}),
  };
}

/** 查詢框、開關、範圍變了：彙總收起、兩段式退回，停頓之後再搜（`now`：開關、範圍這種一下就定的，當場搜）。 */
function inputsChanged(now = false): void {
  summary = null;
  disarm();
  if (now) {
    runSearch();
  } else {
    scheduleSearch();
  }
}

/** 替換框變了：預覽時停頓之後重新預覽；只查詢時不用搜。 */
function replacementChanged(): void {
  summary = null;
  disarm();
  if (mode === 'preview') {
    scheduleSearch();
  } else {
    render();
  }
}

function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, BOOK_FIND_DEBOUNCE_MS);
  render();
}

/** 叫停還在路上的那一次（不回話，前端也不再等它）。 */
function cancelWaiting(): void {
  if (waiting) {
    post({ type: 'cancelBookFind', requestId: waiting });
    claimRequest(waiting);
    waiting = null;
    waitingQuery = null;
  }
}

/** 照面板上此刻的條件搜一次（預覽時就是預覽）。查詢框空著、一個範圍都沒勾：清掉結果，不發。 */
function runSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  if (!panel) {
    return;
  }
  cancelWaiting();
  const q = currentQuery();
  if (!q.query || q.scopes.length === 0) {
    result = null;
    resultQuery = null;
    render();
    return;
  }
  waiting = newRequestId('bookfind');
  waitingQuery = q;
  post({ type: 'bookFind', requestId: waiting, query: q });
  render();
}

function stopSearch(): void {
  cancelWaiting();
  render();
  setStatus('已停止');
}

function startPreview(): void {
  if (!panel || !panel.query.value) {
    panel?.query.focus();
    return;
  }
  mode = 'preview';
  summary = null;
  disarm();
  runSearch();
}

function onResult(msg: Extract<OutMessage, { type: 'bookFindResult' }>): void {
  if (msg.requestId !== waiting || !claimRequest(msg.requestId)) {
    return;
  }
  result = msg.result;
  resultQuery = waitingQuery;
  waiting = null;
  waitingQuery = null;
  excluded = pruneExcluded(excluded, result.files);
  render();
}

// ---------------------------------------------------------------- 替換

/** 編輯器裡開著、有未儲存修改的檔案（替換時跳過）。 */
function dirtyPaths(): string[] {
  return allOpenFiles()
    .filter((f) => f.draft !== f.text)
    .map((f) => f.path);
}

/** 畫著的是不是一份預覽，而且條件與面板上此刻的一樣（預覽之後又改了輸入框，就得等新的預覽回來）。 */
function previewReady(): boolean {
  return !!result && !!resultQuery && resultQuery.replacement !== undefined && !waiting && !searchTimer && sameQuery(resultQuery, currentQuery());
}

function disarm(): void {
  clearTimeout(armTimer);
  armTimer = undefined;
  if (armed) {
    armed = false;
    renderActions();
  }
}

function replaceSelected(): void {
  if (!panel || !result || !resultQuery || replacing || !previewReady()) {
    return;
  }
  const dirty = dirtyPaths();
  const picked = pickedCount(result.files, excluded, new Set(dirty));
  if (picked.hits === 0) {
    return;
  }
  if (!armed) {
    // 兩段式：第一下只換字，第二下才發（改了任何一處勾選、輸入框，退回第一段）。
    armed = true;
    armTimer = setTimeout(disarm, CONFIRM_MS);
    renderActions();
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  replacing = newRequestId('bookreplace');
  post({ type: 'bookReplace', requestId: replacing, request: buildReplaceRequest(resultQuery, result, excluded, dirty) });
  render();
}

function onReplaced(msg: Extract<OutMessage, { type: 'bookReplaceDone' }>): void {
  if (msg.requestId !== replacing || !claimRequest(msg.requestId)) {
    return;
  }
  replacing = null;
  summary = msg.summary;
  if (msg.summary.error && msg.summary.files === 0) {
    // 什麼都沒做（上一次還沒換完、正則寫錯）：預覽留著。
    render();
    return;
  }
  // 換過了：預覽作廢（磁碟上的 hash 都變了），回到只查詢、再搜一次——列出來的是還剩下的。
  mode = 'find';
  excluded.clear();
  result = null;
  resultQuery = null;
  runSearch();
}

// ---------------------------------------------------------------- 點一處

function jumpTo(file: BookFindFile, hit: BookFindHit): void {
  const query = resultQuery;
  if (!query) {
    return;
  }
  if (paneOwning(file.path)) {
    revealHit(file.path, hit, query);
    return;
  }
  // 開成正常標籤（不帶臨時標籤的標記）：從結果裡點過去的是作者明確要看的那一份。
  pendingJump = { path: file.path, hit, query, until: Date.now() + JUMP_WAIT_MS };
  post({ type: 'openEditor', path: file.path, pane: 'main' });
}

function revealHit(path: string, hit: BookFindHit, query: BookFindQuery): void {
  const pane = paneOwning(path);
  if (!pane) {
    return;
  }
  if (pane.activePath !== path) {
    pane.activate(path);
  } else {
    setActivePane(pane);
    announceActive();
  }
  pane.setPreviewing(false);
  revealEditor();
  const offset = offsetAt(pane.area.value, hit.line, hit.col);
  if (!revealFindMatch(pane, query.query, { caseSensitive: query.caseSensitive, regex: query.regex }, offset)) {
    toast('這一處在編輯區裡找不到了（可能有沒儲存的修改）。', true);
  }
}

function settleJump(path: string): void {
  if (!pendingJump) {
    return;
  }
  if (Date.now() > pendingJump.until) {
    pendingJump = null;
    return;
  }
  if (pendingJump.path === path) {
    const { hit, query } = pendingJump;
    pendingJump = null;
    revealHit(path, hit, query);
  }
}

// ---------------------------------------------------------------- 畫

function setStatus(text: string): void {
  if (panel) {
    panel.status.textContent = text;
  }
}

function render(): void {
  if (!panel) {
    return;
  }
  renderStatus();
  renderSummary();
  renderResults();
  renderActions();
}

function renderStatus(): void {
  const p = panel!;
  const q = currentQuery();
  p.stop.classList.toggle('hidden', !waiting);
  p.query.classList.toggle('invalid', !!result?.error && !waiting);
  p.preview.disabled = !q.query || q.scopes.length === 0;
  const notes = result && !waiting ? resultNotes(result) : [];
  p.notes.textContent = '';
  for (const n of notes) {
    p.notes.appendChild(el('div', 'bf-note', n));
  }
  p.notes.classList.toggle('hidden', notes.length === 0);
  if (replacing) {
    setStatus('正在替換…');
  } else if (waiting) {
    setStatus(mode === 'preview' ? '正在預覽…' : '正在搜…');
  } else if (!q.query) {
    setStatus('輸入要找的字，停一下就開始搜。');
  } else if (q.scopes.length === 0) {
    setStatus('至少勾一個範圍。');
  } else if (searchTimer) {
    setStatus('');
  } else if (result) {
    const dirty = new Set(dirtyPaths());
    const blockedFiles = result.files.filter((f) => dirty.has(f.path)).length;
    const isPreview = resultQuery?.replacement !== undefined;
    setStatus(resultStatus(result, isPreview ? pickedCount(result.files, excluded, dirty) : undefined, isPreview ? blockedFiles : 0));
  } else {
    setStatus('');
  }
  // 正則寫錯時，瀏覽器給的原因放在提示裡。
  p.status.title = result?.error && !waiting ? result.error : '';
}

function renderSummary(): void {
  const box = panel!.summary;
  clear(box);
  box.classList.toggle('hidden', !summary);
  if (!summary) {
    return;
  }
  for (const line of summaryLines(summary)) {
    box.appendChild(el('div', `bf-summary-line${line.tone ? ` ${line.tone}` : ''}`, line.text));
  }
  const dismiss = button('icon-btn bf-summary-close', '×', '收起彙總');
  dismiss.addEventListener('click', () => {
    summary = null;
    renderSummary();
  });
  box.appendChild(dismiss);
}

function renderActions(): void {
  if (!panel) {
    return;
  }
  const p = panel;
  const isPreview = !!resultQuery && resultQuery.replacement !== undefined && !!result && result.files.length > 0;
  p.actions.classList.toggle('hidden', mode !== 'preview');
  p.exitPreview.disabled = !!replacing;
  if (!isPreview || !result) {
    p.replaceSelected.disabled = true;
    p.replaceSelected.textContent = '替換所選';
    p.replaceSelected.classList.remove('confirm');
    return;
  }
  const picked = pickedCount(result.files, excluded, new Set(dirtyPaths()));
  p.replaceSelected.disabled = picked.hits === 0 || !!replacing || !previewReady();
  p.replaceSelected.classList.toggle('confirm', armed);
  p.replaceSelected.textContent = armed
    ? `再點一下：替換 ${picked.files} 個檔案 ${picked.hits} 處`
    : `替換所選（${picked.files} 個檔案 ${picked.hits} 處）`;
  p.replaceSelected.title = armed
    ? '經閘道器逐份寫；每份先在「歷史」裡存一版替換前的，跨檔案沒有一步撤銷'
    : '先點一下，按鈕上寫明替換幾個檔案幾處，再點一下才替換';
}

function renderResults(): void {
  const box = panel!.results;
  const top = box.scrollTop;
  clear(box);
  if (!result || result.files.length === 0) {
    return;
  }
  const isPreview = resultQuery?.replacement !== undefined;
  const dirty = new Set(dirtyPaths());
  for (const group of groupByScope(result.files)) {
    box.appendChild(el('div', 'bf-group', `${group.label} · ${group.files.length} 個檔案 ${group.hits} 處`));
    for (const file of group.files) {
      box.appendChild(fileBlock(file, isPreview, dirty.has(file.path)));
    }
  }
  box.scrollTop = top;
}

function fileBlock(file: BookFindFile, isPreview: boolean, dirty: boolean): HTMLElement {
  const block = el('div', `bf-file${dirty ? ' dirty' : ''}${collapsed.has(file.path) ? ' collapsed' : ''}`);
  block.dataset.path = file.path;

  const head = el('div', 'bf-file-head');
  head.appendChild(el('span', 'bf-twisty', collapsed.has(file.path) ? '▸' : '▾'));
  if (isPreview) {
    const box = el('input', 'bf-file-check');
    box.type = 'checkbox';
    const state = dirty ? 'none' : fileCheck(file, excluded);
    box.checked = state === 'all';
    box.indeterminate = state === 'some';
    box.disabled = dirty;
    box.title = dirty ? '編輯器裡有未儲存的修改：替換時跳過' : '這份檔案裡的每一處';
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      for (const hit of file.hits) {
        const key = hitKey(file.path, hit);
        if (box.checked) {
          excluded.delete(key);
        } else {
          excluded.add(key);
        }
      }
      selectionChanged();
    });
    head.appendChild(box);
  }
  const label = el('span', 'bf-file-label', file.label);
  label.title = file.path;
  head.appendChild(label);
  head.appendChild(el('span', 'bf-file-count', file.count > file.hits.length ? `${file.hits.length}/${file.count}` : String(file.count)));
  if (dirty) {
    const badge = el('span', 'bf-dirty', '未儲存');
    badge.title = '編輯器裡有未儲存的修改：這裡列的是磁碟上的內容，替換時會跳過它——先儲存或放棄修改';
    head.appendChild(badge);
  }
  head.addEventListener('click', () => {
    if (collapsed.has(file.path)) {
      collapsed.delete(file.path);
    } else {
      collapsed.add(file.path);
    }
    block.classList.toggle('collapsed', collapsed.has(file.path));
    head.querySelector('.bf-twisty')!.textContent = collapsed.has(file.path) ? '▸' : '▾';
  });
  block.appendChild(head);

  const hits = el('div', 'bf-hits');
  for (const hit of file.hits) {
    hits.appendChild(hitRow(file, hit, isPreview, dirty));
  }
  block.appendChild(hits);
  return block;
}

function hitRow(file: BookFindFile, hit: BookFindHit, isPreview: boolean, dirty: boolean): HTMLElement {
  const key = hitKey(file.path, hit);
  const row = el('div', 'bf-hit');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.start = String(hit.start);
  row.title = `${file.label} · 第 ${hit.line} 行`;
  if (isPreview) {
    const box = el('input', 'bf-hit-check');
    box.type = 'checkbox';
    box.checked = !dirty && !excluded.has(key);
    box.disabled = dirty;
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      if (box.checked) {
        excluded.delete(key);
      } else {
        excluded.add(key);
      }
      selectionChanged();
    });
    row.appendChild(box);
  }
  row.appendChild(el('span', 'bf-line', String(hit.line)));
  const ctx = el('span', 'bf-ctx');
  ctx.appendChild(document.createTextNode(hit.before));
  if (isPreview && hit.replacement !== undefined) {
    ctx.appendChild(el('del', 'bf-old', hit.text));
    const ins = el('ins', 'bf-new', hit.replacement.replace(/\r?\n/g, '↵'));
    if (!hit.replacement) {
      ins.title = '換成空的（刪掉）';
    }
    ctx.appendChild(ins);
  } else {
    ctx.appendChild(el('mark', 'bf-mark', hit.text));
  }
  ctx.appendChild(document.createTextNode(hit.after));
  row.appendChild(ctx);
  row.addEventListener('click', () => jumpTo(file, hit));
  row.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      jumpTo(file, hit);
    }
  });
  return row;
}

/** 勾選變了：檔案那一格的三態、狀態行、按鈕上的數跟著改（不整個重畫，滾動位置不動）。 */
function selectionChanged(): void {
  disarm();
  if (!panel || !result) {
    return;
  }
  for (const block of panel.results.querySelectorAll<HTMLElement>('.bf-file')) {
    const file = result.files.find((f) => f.path === block.dataset.path);
    const box = block.querySelector<HTMLInputElement>('.bf-file-check');
    if (file && box && !box.disabled) {
      const state = fileCheck(file, excluded);
      box.checked = state === 'all';
      box.indeterminate = state === 'some';
      block.querySelectorAll<HTMLInputElement>('.bf-hit-check').forEach((hb, i) => {
        hb.checked = !excluded.has(hitKey(file.path, file.hits[i]));
      });
    }
  }
  renderStatus();
  renderActions();
}

/** 編輯器裡改了 / 存了：「未儲存」的標記與勾選、計數跟著變（停一下再畫）。 */
function scheduleDirtyRefresh(): void {
  if (!isBookFindOpen() || !result) {
    return;
  }
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = undefined;
    if (isBookFindOpen() && result) {
      renderStatus();
      renderResults();
      renderActions();
    }
  }, 250);
}

// ---------------------------------------------------------------- 裝配

function resetAll(): void {
  closeBookFind(false);
  cancelWaiting();
  clearTimeout(searchTimer);
  searchTimer = undefined;
  result = null;
  resultQuery = null;
  replacing = null;
  summary = null;
  excluded = new Set();
  collapsed.clear();
  pendingJump = null;
  mode = 'find';
  disarm();
  if (panel) {
    panel.query.value = '';
    panel.replace.value = '';
    render();
  }
}

let installed = false;

/**
 * 裝上 Ctrl+Shift+F / Ctrl+Shift+H、「編輯 → 全書查詢替換…」、結果與彙總的接收。`editor/index.ts` 調一次，**要在它自己的
 * `onMessage` 之後**：點了一處、那份檔案的 `editorOpen` 先讓編輯區收下，這裡才找得到擁有它的那一塊。
 */
export function installBookFind(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;

  document.addEventListener('keydown', (e) => {
    if (isImeComposing(e) || !(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey) {
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const isF = key === 'f' || e.code === 'KeyF';
    const isH = key === 'h' || e.code === 'KeyH';
    if (!isF && !isH) {
      return;
    }
    e.preventDefault();
    openBookFind({ replace: isH });
  });

  window.addEventListener('nf-bookfind-query', (e) => {
    e.detail.available = workspaceOpen();
    e.detail.reason = e.detail.available ? undefined : NO_WORKSPACE;
  });
  window.addEventListener('nf-bookfind-command', (e) => {
    openBookFind({ replace: e.detail.name === 'openReplace' });
  });

  // 點活動欄上任一頁籤：收起面板，讓那一頁露出來（結果留著）。
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('.tabbar .tab')) {
      closeBookFind(false);
    }
  });

  window.addEventListener('nf-workspace-reset', resetAll);

  onEditorChange((ev) => {
    if (ev.type === 'edit' || ev.type === 'render') {
      scheduleDirtyRefresh();
    }
  });

  onMessage((msg) => {
    if (msg.type === 'bookFindResult') {
      onResult(msg);
    } else if (msg.type === 'bookReplaceDone') {
      onReplaced(msg);
    } else if (msg.type === 'editorOpen') {
      settleJump(msg.file.path);
    } else if (msg.type === 'editorSaved') {
      scheduleDirtyRefresh();
    }
  });
}
