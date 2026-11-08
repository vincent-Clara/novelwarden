/**
 * 名詞補全（角色名、地名、勢力、物品……）：在游標處彈一個候選框，列出這本書的角色卡名字與別名、設定條目的標題與
 * 關鍵詞、設定名錄裡出現過還沒建條目的名字，挑一個補上。**不調模型**（第 4 條），名詞表來自後端
 * （`core/views/nameIndex.ts`），匹配與排序在零 DOM 的 `namesCore.ts`。
 *
 * ## 兩種彈法
 *
 * - **按鍵彈（預設）**：`Alt+/`（⚑ 登記在 `shortcuts.ts` 的 `names`；`Ctrl+Space` 在 Windows / Linux 上常被系統拿去切輸入法，
 *   瀏覽器與編輯器都沒佔 `Alt+/`，它也是 Emacs / Eclipse 的「補全一個詞」）或「檢視 → 名詞補全」。用游標前幾個字當查詢詞
 *   （`queryBefore`：往前 1~4 個字裡能匹配上名字開頭的最長那段），什麼都匹配不上就列全部、最近在本檔案出現的排前面。
 *   之後接著打字跟著篩，碰到空白標點、游標退到起點前面、一個都對不上就收起。`↑↓` 選，`Enter` / `Tab` 接受，`Esc` 收起。
 * - **邊打邊彈**（「檢視 → 邊打邊彈名詞補全」，預設關，記在 `novelforge.editor.prefs` 的 `nameAutoPopup`）：輸入法上屏
 *   或直接打字之後，游標前的字是某個名字的開頭（至少兩個字、還沒打完整，`autoPopQuery`）就彈。**不搶回車**：回車照常換段
 *   （順手收起），`Tab` 接受（⚑），`↑↓` 在框裡選，`Esc` 收起；接著打別的字就收起。
 *
 * ## 幾條規矩
 *
 * - **輸入法組字中途絕不彈、不接管任何鍵**：按鍵經 `addKeyHandler`，組字中途的鍵根本送不到；自動彈只認帶 `change` 的
 *   `edit`（上屏那一下）；框開著時一開始組字就先藏起來，上屏之後按新的文字重新篩（取消組字也重新看一眼）。
 * - **插入只走 `Pane.applyEdit`**（`opts.source: 'completion'`），一步撤銷：換掉作者已經打的那幾個字、補全剩下的，游標落在
 *   名字後面。別名命中時框裡寫「別名 → 正名」，插入的是那個別名（作者打的就是它，⚑）。碼字統計把補上的字算作者碼的字
 *   （⚑，見 `writingStats.ts`）。
 * - **只對作者會寫到名字的檔案**：後端給的 `kind`（`completionApplies`：正文、草稿、細綱、角色卡、設定、大綱、敘事線），
 *   前端不拿路徑猜；配置之類按鍵只說一句、不彈，自動模式不彈。
 * - **貼著游標**：位置借高亮映象層量（`highlight.ts` 的 `measureOffset`，與打字機滾動同一個辦法），不另起測量 DOM；
 *   放在游標那一行下面，靠近底邊翻到上面，兩邊都不夠就壓高度。掛在 `body` 上 `position: fixed`。
 * - **點外面、切標籤、滾動時收起**：document 捕獲階段的 `mousedown`（點在框裡的不算，框裡按下不奪焦點）、編輯區換了檔案 /
 *   切了預覽、滾輪、別處滾動、視窗改大小、編輯區失焦；編輯區自己滾（打字機滾動、打到底自動滾）時跟著挪，游標那一行滾出
 *   視口才收。
 * - **名詞表按需要**：第一次要用時發 `requestNameIndex`（帶 requestId 與手上那份的 `sig`），回 `nameIndex`；收到 `state`
 *   （磁碟上變過）就記一筆「可能過期」，下一次要用時再問（邊打邊彈時至多 3 秒問一次），沒變的話後端只回指紋。問的工夫裡照樣
 *   拿手上那份篩；手上還沒有時按鍵那一下等表到了再彈。換工程作廢。
 */
import { clear, el } from '../dom';
import { toast } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { activeEditor, addKeyHandler, editorOf, onEditorChange } from './api';
import type { EditorContext, EditorEvent, OpenFile, Pane } from './api';
import { measureOffset } from './highlight';
import {
  autoPopQuery,
  autoQueryAt,
  buildNameCatalog,
  completionApplies,
  insertionFor,
  matchNames,
  queryBefore,
  queryBetween,
} from './namesCore';
import type { NameCandidate, NameCatalog, NameQuery } from './namesCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { highlightSegments } from './quickOpenCore';
import { claimRequest, newRequestId } from './replace';

/** 偏好裡邊打邊彈那一項的鍵（只認明明白白的 `true`）。 */
const PREF_KEY = 'nameAutoPopup';
/** 邊打邊彈時，表可能過期了多久最多問一次。 */
const REFRESH_THROTTLE_MS = 3000;
/** 按了鍵、表還沒到：等多久，之後到的不再彈。 */
const PENDING_TRIGGER_MS = 3000;
/** 問出去多久沒回音就當丟了（斷線時訊息可能一直在 outbox 裡）。 */
const WAIT_GIVE_UP_MS = 10_000;

const NOT_HERE = '名詞補全只在正文、草稿、細綱、角色卡、設定、情節大綱與敘事線裡用。';

// ---------------------------------------------------------------- 名詞表

let post: (msg: InMessage) => void = () => {};
let catalog: NameCatalog | null = null;
let sig: string | undefined;
/** 收到過幾次 `state`（磁碟上變過）；問的時候記下當時的數，回來時對不上就還算過期。 */
let epoch = 0;
let fetchedEpoch = -1;
let waiting: { id: string; epoch: number } | null = null;
let lastAsk = 0;
/** 按了鍵、表還沒到：到了就在那裡彈（同一塊編輯區、同一份檔案還開著的話）。 */
let pendingTrigger: { pane: Pane; file: OpenFile; until: number } | null = null;

function fresh(): boolean {
  return !!catalog && fetchedEpoch === epoch;
}

/** 表換了（到了新的一份、換工程作廢）時叫誰：名詞高亮（`nameMarks.ts`）照它重畫。 */
const catalogListeners = new Set<() => void>();

function catalogChanged(): void {
  for (const fn of [...catalogListeners]) {
    fn();
  }
}

/** 手上那份名詞表（還沒要過、換了工程時是 null）。名詞高亮與補全用同一份。 */
export function currentNameCatalog(): NameCatalog | null {
  return catalog;
}

/** 表可能過期了就問一次（在路上的不重複問；沒變的話後端只回指紋）。名詞高亮開啟檔案、磁碟上變過時調。 */
export function refreshNameIndex(): void {
  refresh(false);
}

export function onNameCatalog(fn: () => void): () => void {
  catalogListeners.add(fn);
  return () => catalogListeners.delete(fn);
}

/** 表可能過期了就問一次（在路上的不重複問；問出去 10 秒沒回音——斷線了——就當丟了，可以再問）。`throttle`：邊打邊彈時，手上有表就至多 3 秒問一次。 */
function refresh(throttle: boolean): void {
  if (fresh() || (waiting && Date.now() - lastAsk < WAIT_GIVE_UP_MS)) {
    return;
  }
  if (throttle && catalog && Date.now() - lastAsk < REFRESH_THROTTLE_MS) {
    return;
  }
  const id = newRequestId('names');
  waiting = { id, epoch };
  lastAsk = Date.now();
  post({ type: 'requestNameIndex', requestId: id, ...(catalog && sig ? { have: sig } : {}) });
}

function onIndex(msg: Extract<OutMessage, { type: 'nameIndex' }>): void {
  if (!waiting || msg.requestId !== waiting.id || !claimRequest(msg.requestId)) {
    return;
  }
  const askedAt = waiting.epoch;
  waiting = null;
  if (msg.index) {
    catalog = buildNameCatalog(msg.index);
    catalogChanged();
  } else if (!catalog) {
    // 說沒變、手上卻沒有（換過工程之類）：重新要一份整的。
    sig = undefined;
    refresh(false);
    return;
  }
  sig = msg.sig;
  fetchedEpoch = askedAt;
  const pending = pendingTrigger;
  pendingTrigger = null;
  if (pending && Date.now() <= pending.until && !composing) {
    const ctx = editorOf(pending.pane);
    if (ctx && ctx.file === pending.file && !ctx.pane.isPreviewing()) {
      openManual(ctx);
      return;
    }
  }
  if (session) {
    resync();
  }
}

// ---------------------------------------------------------------- 偏好

let auto = false;

function readAuto(): boolean {
  return storedPrefs()[PREF_KEY] === true;
}

function setAuto(on: boolean): void {
  if (auto !== on) {
    setStoredPrefs({ [PREF_KEY]: on || undefined });
  }
}

// ---------------------------------------------------------------- 彈出框

interface Session {
  pane: Pane;
  file: OpenFile;
  mode: 'manual' | 'auto';
  /** 查詢詞在全文裡的起點（`area.value` 的下標）。 */
  start: number;
  query: string;
  items: NameCandidate[];
  total: number;
  active: number;
  box: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  foot: HTMLElement;
  /** 輸入法組字中途先藏起來。 */
  hidden: boolean;
}

let session: Session | null = null;
/** 自己調 `applyEdit` 的那一下也會發 `edit`，不當成作者在打字。 */
let accepting = false;
/** 輸入法正在組字（document 捕獲階段記，比編輯區自己的 compositionend 先跑）。 */
let composing = false;

function snapshot(ctx: EditorContext): { text: string; selStart: number; selEnd: number } {
  return { text: ctx.area.value, selStart: ctx.area.selectionStart, selEnd: ctx.area.selectionEnd };
}

/** 按鍵彈。 */
function trigger(ctx: EditorContext): void {
  if (!completionApplies(ctx.file.kind)) {
    toast(NOT_HERE);
    return;
  }
  if (ctx.pane.isPreviewing()) {
    toast('預覽裡不能補全，先切回編輯。');
    return;
  }
  if (!catalog) {
    pendingTrigger = { pane: ctx.pane, file: ctx.file, until: Date.now() + PENDING_TRIGGER_MS };
    refresh(false);
    return;
  }
  refresh(false);
  openManual(ctx);
}

function openManual(ctx: EditorContext): void {
  if (!catalog) {
    return;
  }
  if (!catalog.initialized) {
    toast('這個資料夾還不是小說工程，沒有名詞可補全。');
    return;
  }
  if (catalog.items.length === 0) {
    toast('這本書還沒有角色卡或設定條目，沒有名詞可補全。');
    return;
  }
  const { text, selStart } = snapshot(ctx);
  show(ctx, 'manual', queryBefore(catalog, text, selStart));
}

/** 按查詢詞篩出候選、開（或換掉）彈出框。一個都對不上就收起。 */
function show(ctx: EditorContext, mode: Session['mode'], q: NameQuery): void {
  if (!catalog) {
    return;
  }
  const { text, selEnd } = snapshot(ctx);
  const result = matchNames(catalog, q.query, { text, start: q.start, caret: selEnd, unfinished: mode === 'auto' });
  if (result.total === 0) {
    close();
    return;
  }
  if (!session) {
    const dom = buildBox();
    document.body.appendChild(dom.box);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    session = { pane: ctx.pane, file: ctx.file, mode, start: q.start, query: q.query, items: [], total: 0, active: 0, hidden: false, ...dom };
  }
  const s = session;
  // 接著打字、表換了新的一份時儘量停在原來選中的那一個上（新表裡的條目是新物件，按名字與來源認）。
  const keep = s.pane === ctx.pane && s.file === ctx.file ? s.items[s.active]?.item : undefined;
  Object.assign(s, { pane: ctx.pane, file: ctx.file, mode, start: q.start, query: q.query, hidden: false });
  s.items = result.items;
  s.total = result.total;
  const kept = keep ? s.items.findIndex((c) => c.item.name === keep.name && c.item.source === keep.source) : -1;
  s.active = kept >= 0 ? kept : 0;
  render();
  position();
}

/** 收起彈出框。 */
function close(): void {
  if (!session) {
    return;
  }
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  session.box.remove();
  session = null;
}

/** 框開著、文字或表變了：按當前文字重新篩（模式不變）。 */
function resync(): void {
  const s = session;
  if (!s || !catalog) {
    return;
  }
  const ctx = editorOf(s.pane);
  if (!ctx || ctx.file !== s.file || ctx.pane.isPreviewing()) {
    close();
    return;
  }
  const { text, selStart, selEnd } = snapshot(ctx);
  if (selStart !== selEnd) {
    close();
    return;
  }
  if (s.mode === 'auto') {
    const q = autoQueryAt(catalog, text, selEnd);
    if (q) {
      show(ctx, 'auto', q);
    } else {
      close();
    }
    return;
  }
  const query = queryBetween(text, s.start, selEnd);
  if (query === undefined) {
    close();
    return;
  }
  show(ctx, 'manual', { query, start: s.start });
}

function hideForComposition(): void {
  if (session && !session.hidden) {
    session.hidden = true;
    session.box.classList.add('hidden');
  }
}

function move(step: number): void {
  const s = session;
  if (!s || s.items.length === 0) {
    return;
  }
  s.active = (s.active + step + s.items.length) % s.items.length;
  markActive();
}

function acceptActive(): void {
  const c = session?.items[session.active];
  if (c) {
    accept(c);
  } else {
    close();
  }
}

/** 接受一條：換掉作者已經打的那幾個字，補成整個叫法；一步撤銷。 */
function accept(c: NameCandidate): void {
  const s = session;
  if (!s) {
    return;
  }
  const { pane, file, start } = s;
  close();
  if (pane.activeFile() !== file || pane.isPreviewing()) {
    return;
  }
  const area = pane.area;
  const ins = insertionFor(start, area.selectionStart, area.selectionEnd, c.form);
  accepting = true;
  try {
    pane.applyEdit(ins.start, ins.end, ins.text, { start: ins.caret, end: ins.caret }, { source: 'completion' });
  } finally {
    accepting = false;
  }
}

// ---------------------------------------------------------------- DOM

function buildBox(): Pick<Session, 'box' | 'list' | 'note' | 'foot'> {
  const box = el('div', 'nc-box');
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', '名詞補全');
  const list = el('div', 'nc-list');
  const note = el('div', 'nc-note hidden');
  const foot = el('div', 'nc-foot');
  box.append(list, note, foot);
  // 框裡按下滑鼠不奪編輯區的焦點（奪走了 ↑↓ 就不歸它了）；點一行接受由那一行的 click 做。
  box.addEventListener('mousedown', (e) => e.preventDefault());
  return { box, list, note, foot };
}

function render(): void {
  const s = session;
  if (!s) {
    return;
  }
  s.box.classList.toggle('hidden', s.hidden);
  s.box.classList.toggle('nc-auto', s.mode === 'auto');
  clear(s.list);
  s.items.forEach((c, i) => s.list.appendChild(buildRow(c, i)));
  const more = s.total > s.items.length ? `只列出前 ${s.items.length} 個（一共 ${s.total} 個），多打幾個字縮小範圍。` : '';
  s.note.textContent = more;
  s.note.classList.toggle('hidden', more === '');
  s.foot.textContent =
    s.mode === 'auto' ? '↑↓ 選擇 · Tab 插入 · 回車照常換段 · Esc 收起' : '↑↓ 選擇 · Enter / Tab 插入 · Esc 收起';
  markActive();
}

function buildRow(c: NameCandidate, i: number): HTMLElement {
  const row = el('div', `nc-item nc-${c.item.source}`);
  row.setAttribute('role', 'option');
  row.dataset.index = String(i);
  row.title = c.item.path ?? '還沒有條目：設定名錄裡「出現過 · 未建條目」的名字';

  const name = el('span', 'nc-name');
  for (const seg of highlightSegments(c.form, c.hits)) {
    name.appendChild(seg.hit ? el('mark', undefined, seg.text) : document.createTextNode(seg.text));
  }
  if (c.viaAlias) {
    name.appendChild(el('span', 'nc-canon', ` → ${c.item.name}`));
  }
  row.appendChild(name);
  row.appendChild(el('span', 'nc-badge', c.item.badge));
  const brief = c.item.source === 'unfiled' ? ['未建條目', c.item.brief].filter(Boolean).join(' · ') : c.item.brief;
  row.appendChild(el('span', 'nc-brief', brief));

  row.addEventListener('click', () => accept(c));
  return row;
}

function markActive(): void {
  const s = session;
  if (!s) {
    return;
  }
  const rows = s.list.querySelectorAll<HTMLElement>('.nc-item');
  rows.forEach((row, i) => {
    const on = i === s.active;
    row.classList.toggle('active', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const current = rows[s.active];
  if (current && typeof current.scrollIntoView === 'function') {
    current.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * 貼著游標擺：查詢詞開頭那個字的位置借高亮映象層量（量不了——文字太大、textarea 藏著——就擺在編輯區左上角附近）。
 * 優先放在那一行下面，放不下翻到上面，兩邊都不夠選空間大的一側並壓高度；橫向夾進視口。游標那一行滾出編輯區的視口就收起。
 */
function position(): void {
  const s = session;
  if (!s || s.hidden) {
    return;
  }
  const area = s.pane.area;
  const rect = area.getBoundingClientRect();
  const pos = measureOffset(s.pane, s.start);
  let x = rect.left + 24;
  let lineTop = rect.top + 24;
  let lineBottom = lineTop;
  if (pos) {
    x = rect.left + area.clientLeft + pos.left - area.scrollLeft;
    lineTop = rect.top + area.clientTop + pos.top - area.scrollTop;
    lineBottom = lineTop + pos.height;
    if (rect.height > 0 && (lineBottom <= rect.top || lineTop >= rect.bottom)) {
      close();
      return;
    }
  }
  const box = s.box;
  const gap = 2;
  const margin = 6;
  const minHeight = 72;
  box.style.maxHeight = '';
  const natural = box.offsetHeight;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const below = vh - lineBottom - gap - margin;
  const above = lineTop - gap - margin;
  const putBelow = natural <= below || below >= above;
  const room = Math.max(minHeight, putBelow ? below : above);
  if (natural > room) {
    box.style.maxHeight = `${room}px`;
  }
  const h = box.offsetHeight;
  const top = putBelow ? lineBottom + gap : Math.max(margin, lineTop - h - gap);
  const w = box.offsetWidth;
  let left = x;
  if (w > 0 && left + w > vw - margin) {
    left = vw - w - margin;
  }
  left = Math.max(margin, left);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.classList.toggle('nc-above', !putBelow);
}

// ---------------------------------------------------------------- 收起的時機

function onOutside(e: MouseEvent): void {
  if (session && !session.box.contains(e.target as Node)) {
    close();
  }
}

let repositionQueued = false;

function onScroll(e: Event): void {
  const s = session;
  if (!s || s.box.contains(e.target as Node)) {
    return;
  }
  if (e.target === s.pane.area) {
    // 編輯區自己滾（打字機滾動、打到底自動滾、拖捲軸）：跟著挪，滾出視口才收。滾輪另有一條直接收起。
    if (!repositionQueued) {
      repositionQueued = true;
      queueMicrotask(() => {
        repositionQueued = false;
        position();
      });
    }
    return;
  }
  close();
}

function onResize(): void {
  close();
}

const hooked = new WeakSet<Pane>();

/** 每塊編輯區第一次重畫時掛上：滾輪與失焦收起。 */
function hook(pane: Pane): void {
  if (hooked.has(pane)) {
    return;
  }
  hooked.add(pane);
  pane.area.addEventListener('wheel', () => {
    if (session?.pane === pane) {
      close();
    }
  });
  pane.area.addEventListener('blur', () => {
    if (session?.pane === pane) {
      close();
    }
  });
}

// ---------------------------------------------------------------- 編輯區的變化

function onEdit(ev: Extract<EditorEvent, { type: 'edit' }>): void {
  if (accepting) {
    return;
  }
  const ctx = editorOf(ev.pane);
  if (!ctx || ev.file !== ctx.file) {
    return;
  }
  const s = session;
  if (s && s.pane === ev.pane) {
    if (s.file !== ev.file || ev.source === 'undo' || ev.source === 'redo') {
      close();
      return;
    }
    if (ev.source === 'composition' && !ev.change) {
      // 組字中途：先藏起來，什麼都不接管；上屏那一下再篩。
      hideForComposition();
      return;
    }
    if (ev.change && ev.change.at < s.start && s.mode === 'manual') {
      // 改動落在查詢詞前面（別處的程式改寫）：起點對不上了。
      close();
      return;
    }
    resync();
    return;
  }
  if (!auto || !completionApplies(ev.file.kind) || ctx.pane.isPreviewing()) {
    return;
  }
  // 只認打字與輸入法上屏；先看一眼表是不是該更新了（在路上的不重複問）。
  if (ev.source !== 'typing' && ev.source !== 'composition') {
    return;
  }
  refresh(true);
  if (!catalog) {
    return;
  }
  const { text, selStart, selEnd } = snapshot(ctx);
  const q = autoPopQuery(catalog, {
    source: ev.source,
    change: ev.change,
    text,
    selectionStart: selStart,
    selectionEnd: selEnd,
    composing: composing || (ev.source === 'composition' && !ev.change),
  });
  if (q) {
    show(ctx, 'auto', q);
  }
}

// ---------------------------------------------------------------- 按鍵

function isTriggerKey(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && ((e.code === 'Slash' && !e.shiftKey) || e.key === '/');
}

function onKey(e: KeyboardEvent, ctx: EditorContext): boolean {
  const s = session;
  if (s && s.pane === ctx.pane && !s.hidden) {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (plain) {
          move(e.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        close();
        return false;
      case 'Tab':
        if (plain) {
          acceptActive();
          return true;
        }
        close();
        return false;
      case 'Enter':
        // 邊打邊彈不搶回車：回車照常換段，框收起。按鍵彈出來的才拿回車接受。
        if (plain && s.mode === 'manual') {
          acceptActive();
          return true;
        }
        close();
        return false;
      case 'Escape':
        close();
        // 別讓查詢條、專注模式那幾個 document 上的 Esc 再處理一遍。
        e.stopPropagation();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        close();
        return false;
    }
  }
  if (isTriggerKey(e)) {
    trigger(ctx);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 裝配

let installed = false;

/**
 * 裝上快捷鍵、邊打邊彈、名詞表的收發、「檢視 → 補全」的編輯器那一半。`editor/index.ts` 調一次，**要在
 * `installParagraphTools` 之前**：框開著時回車 / Tab 要先歸這裡（按鍵處理按掛的先後跑），不然回車先被分段那一條接走。
 */
export function installNames(postMessage: (msg: InMessage) => void): void {
  if (installed) {
    return;
  }
  installed = true;
  post = postMessage;
  auto = readAuto();

  addKeyHandler(onKey);

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      if (session && session.pane === ev.pane && (ev.pane.activeFile() !== session.file || ev.pane.isPreviewing())) {
        close();
      }
      // 開著邊打邊彈、正對著一份能補全的檔案：表先要一份（之後打字時就有了）。
      const file = ev.pane.activeFile();
      if (auto && file && completionApplies(file.kind)) {
        refresh(true);
      }
      return;
    }
    onEdit(ev);
  });

  // 組字開始 / 結束：document 捕獲階段記，比編輯區自己的監聽先跑（上屏那一下的 edit 發出來時已經不算在組字了）。
  document.addEventListener(
    'compositionstart',
    (e) => {
      composing = true;
      if (session && e.target === session.pane.area) {
        hideForComposition();
      }
    },
    true
  );
  document.addEventListener(
    'compositionend',
    () => {
      composing = false;
      // 取消組字（上屏的字與原來一樣）時編輯區不發 edit：藏著的框按現在的文字再看一眼。
      setTimeout(() => {
        if (session?.hidden) {
          resync();
        }
      }, 0);
    },
    true
  );

  onPrefsChange(() => {
    const next = readAuto();
    if (next === auto) {
      return;
    }
    auto = next;
    if (!auto && session?.mode === 'auto') {
      close();
    }
    const ed = activeEditor();
    if (auto && ed && completionApplies(ed.file.kind)) {
      refresh(false);
    }
  });

  window.addEventListener('nf-names-query', (e) => {
    const ed = activeEditor();
    e.detail.available = true;
    e.detail.auto = auto;
    e.detail.canTrigger = !!ed && completionApplies(ed.file.kind) && !ed.pane.isPreviewing();
    e.detail.reason = !ed
      ? '沒有開啟的檔案。'
      : !completionApplies(ed.file.kind)
        ? NOT_HERE
        : ed.pane.isPreviewing()
          ? '預覽裡不能補全，先切回編輯。'
          : undefined;
  });

  window.addEventListener('nf-names-command', (e) => {
    if (e.detail.name === 'toggleAuto') {
      setAuto(!auto);
      return;
    }
    if (e.detail.name === 'trigger') {
      const ed = activeEditor();
      if (!ed) {
        toast('先在編輯區裡開啟一份檔案。');
        return;
      }
      if (document.activeElement !== ed.area && !ed.pane.isPreviewing()) {
        ed.area.focus();
      }
      trigger(ed);
    }
  });

  window.addEventListener('nf-workspace-reset', () => {
    close();
    catalog = null;
    sig = undefined;
    waiting = null;
    pendingTrigger = null;
    fetchedEpoch = -1;
    catalogChanged();
  });

  onMessage((msg) => {
    if (msg.type === 'nameIndex') {
      onIndex(msg);
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁碟上變過（或剛連上）：手上那份可能過期了，下一次要用時再問。
      epoch++;
    }
  });
}
