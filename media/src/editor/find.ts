/**
 * 查詢替換條：每塊編輯區各一條，作用於**這一塊的當前檔案**。
 *
 * ## 結構
 *
 * 第一行：展開 / 收起替換行的小按鈕、查詢框、「Aa」區分大小寫、「.*」正則、計數「3/17」、上一個 / 下一個、×。
 * 第二行（替換行，預設收著）：替換框、「替換」「全部替換」。下面還有一行提示（正則寫錯了、檔案太大不畫高亮），
 * 平時藏著。
 *
 * **DOM 只在這裡生成一份**（`buildFindDom`），兩塊編輯區都是第一次用到時現造、插在 `.ed-stage` 前面——
 * 頁面模板（`page.ts`）與草稿區的克隆（`paneElements.ts`）裡都沒有它。查詢條從前是兩邊各寫一份、
 * 靠人對齊的（主區在 `page.ts`，草稿區在 `createPaneElements`），加了替換行與兩顆開關之後再抄兩份
 * 只會越抄越歪；它又是互動件、首屏用不到，與章節條（`chapterBar.ts`）一樣由前端自己造最省事。
 *
 * ## 行為
 *
 * - `Ctrl+F` 開啟（當前選區是一行之內的短文字時預填它）；`Ctrl+H` 開啟並展開替換行；預覽模式下先切回編輯。
 *   焦點在編輯區之外的輸入框 / 文字框（左側對話輸入框之類）時不攔，留給瀏覽器。加了 Shift 的（`Ctrl+Shift+F` /
 *   `Ctrl+Shift+H`）是全書查詢替換（`bookFind.ts`），不歸這裡；全書查詢點了一處時借這一條定位（`revealFindMatch`：
 *   換成那邊的查詢串與開關、選中離那一處最近的匹配）。
 * - 查詢框裡打字：**從當前游標往後**找最近的一處，選中並滾過去（目標停在視口偏上三分之一，已經看得見就不滾）。
 *   選中時不把焦點拿回編輯區，人還在查詢框裡接著打字；textarea 沒焦點時原生選區看不見，所以當前那一處
 *   另用一種顏色畫在高亮層上（`highlight.ts`）。
 * - Enter 下一個、Shift+Enter 上一個；編輯器裡 F3 / Shift+F3 也是；到頭繞回。替換框裡 Enter = 替換當前這一處並跳下一處。
 * - Esc 關掉、清高亮、焦點回編輯區（選區停在當前那一處）。
 * - 替換：選區**正好是**當前那一處時才換（否則這一下只是選中下一處，與常見編輯器一樣按兩下）；
 *   經 `pane.applyEdit`，一處一步撤銷。
 * - 全部替換：一次 `applyEdit` 換掉從第一處到最後一處的那一段，**只記一步撤銷**；提示「替換了 N 處」。
 * - 文字一變（打字、撤銷、替換）下一幀重算，當前序號儘量留在原處附近；換了檔案就按新檔案重算（不動選區）。
 */
import { el } from '../dom';
import { toast } from '../globals';
import { isImeComposing, onEditorChange, paneContaining, paneForShortcut } from './api';
import type { EditorEvent } from './api';
import {
  escapeRegExp,
  findMatches,
  matchAfter,
  matchAt,
  matchBefore,
  nearestMatch,
  replaceAllIn,
  replacementFor,
  seedFromSelection,
} from './findCore';
import type { FindMatch, FindOptions } from './findCore';
import {
  HIGHLIGHT_LIMIT,
  cancelFrame,
  clearHighlights,
  mapOffset,
  nextFrame,
  scrollToOffset,
  setHighlights,
  tooLargeToHighlight,
} from './highlight';
import { shortcutLabel } from './shortcuts';
import { activePane } from './store';
import type { Pane } from './store';

/** 高亮層的名字。 */
const LAYER = 'find';
const CLS_MATCH = 'ed-hl-find';
const CLS_CURRENT = 'ed-hl-find-current';

/** 查詢條的節點。class 名是對外的（測試按它取），**沒有 id**：兩塊編輯區各有一條。 */
interface FindDom {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  input: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  regexBtn: HTMLButtonElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
  replaceRow: HTMLElement;
  replaceInput: HTMLInputElement;
  replaceOne: HTMLButtonElement;
  replaceAll: HTMLButtonElement;
  note: HTMLElement;
}

function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  return b;
}

function textInput(cls: string, placeholder: string): HTMLInputElement {
  const input = el('input', cls);
  // 不用 type="search"：Chrome 裡在 search 框按 Esc 是清空文字，與「Esc 關掉查詢條」打架。
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function toggleButton(cls: string, text: string, title: string): HTMLButtonElement {
  const b = button(`ed-find-opt ${cls}`, text, title);
  b.setAttribute('aria-pressed', 'false');
  return b;
}

/** 查詢條的 DOM，兩塊編輯區共用這一份生成函式。 */
function buildFindDom(): FindDom {
  const root = el('div', 'ed-find hidden');
  root.setAttribute('role', 'search');

  const findRow = el('div', 'ed-find-row');
  const toggle = button('ed-find-toggle', '▸', `展開替換（${shortcutLabel('replace')}）`);
  toggle.setAttribute('aria-expanded', 'false');
  const input = textInput('ed-find-input', '查詢');
  const caseBtn = toggleButton('ed-find-case', 'Aa', '區分大小寫');
  const regexBtn = toggleButton('ed-find-regex', '.*', '正規表示式（替換裡可以用 $1 引用分組）');
  const count = el('span', 'ed-find-count');
  count.setAttribute('aria-live', 'polite');
  const prev = button('chip-btn ed-find-prev', '上一個', '上一個（Shift+Enter / Shift+F3）');
  const next = button('chip-btn ed-find-next', '下一個', '下一個（Enter / F3）');
  const close = button('chip-btn ed-find-close', '×', '關閉查詢（Esc）');
  findRow.append(toggle, input, caseBtn, regexBtn, count, prev, next, close);

  const replaceRow = el('div', 'ed-find-row ed-replace-row hidden');
  const replaceInput = textInput('ed-replace-input', '替換為');
  const replaceOne = button('chip-btn ed-replace-one', '替換', '替換當前這一處並跳到下一處（在替換框裡按 Enter）');
  const replaceAll = button('chip-btn ed-replace-all', '全部替換', '替換全部，一次撤銷就能全部退回');
  replaceRow.append(el('span', 'ed-find-gap'), replaceInput, replaceOne, replaceAll);

  const note = el('div', 'ed-find-note hidden');
  root.append(findRow, replaceRow, note);
  return {
    root, toggle, input, caseBtn, regexBtn, count, prev, next, close,
    replaceRow, replaceInput, replaceOne, replaceAll, note,
  };
}

// ---------------------------------------------------------------- 一條查詢條

interface FindBar {
  open(opts?: { replace?: boolean; focus?: boolean; seed?: boolean }): void;
  close(): void;
  isOpen(): boolean;
  /** F3 / Shift+F3：沒開著就開（焦點不動），有查詢串就跳一處。 */
  stepFromEditor(dir: 1 | -1): void;
  /** 換成這個查詢串與兩顆開關，選中離 `offset` 最近的那一處（全書查詢點了一處）。一處都沒有返回 false。 */
  showMatch(query: string, o: FindOptions, offset: number): boolean;
  onChange(ev: EditorEvent): void;
}

const bars = new WeakMap<Pane, FindBar>();

function barOf(pane: Pane): FindBar {
  let bar = bars.get(pane);
  if (!bar) {
    bar = createFindBar(pane);
    bars.set(pane, bar);
  }
  return bar;
}

function createFindBar(pane: Pane): FindBar {
  const dom = buildFindDom();
  const stage = pane.area.parentElement;
  (stage?.parentElement ?? pane.root).insertBefore(dom.root, stage);

  const opts: Required<FindOptions> = { caseSensitive: false, regex: false };
  let matches: FindMatch[] = [];
  let truncated = false;
  let error: string | undefined;
  /** 當前是第幾處（`matches` 的下標），-1 表示還沒落在哪一處上（計數寫「共 N 處」）。 */
  let current = -1;
  /** 當前那一處的起點。文字變了按改動平移，重算之後挑離它最近的那一處噹噹前。 */
  let currentPos: number | undefined;
  /** 匹配是給哪個檔案算的。 */
  let path = pane.activePath;
  let frame: number | undefined;

  const area = pane.area;
  const isOpen = () => !dom.root.classList.contains('hidden');
  const query = () => dom.input.value;

  /**
   * 預覽模式下先切回編輯（`setPreviewing(false)`：滾到預覽裡看著的那一處）。人正在查詢條裡打字的話焦點留在那裡，
   * 否則進正文區。
   */
  function ensureEditing(): void {
    if (pane.isPreviewing()) {
      const focused = document.activeElement;
      const typing = focused instanceof HTMLElement && dom.root.contains(focused);
      pane.setPreviewing(false, { focus: !typing });
    }
  }

  /** 按當前文字重算全部匹配；當前那一處取離 `currentPos` 最近的。`repaint: false` 時由呼叫方接著畫。 */
  function compute(repaint = true): void {
    if (frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    const result = findMatches(area.value, query(), opts);
    matches = result.matches;
    truncated = result.truncated;
    error = result.error;
    current = currentPos === undefined ? -1 : nearestMatch(matches, currentPos);
    currentPos = current >= 0 ? matches[current].start : undefined;
    if (repaint) {
      paint();
    }
  }

  function schedule(): void {
    if (frame === undefined) {
      frame = nextFrame(() => {
        frame = undefined;
        compute();
      });
    }
  }

  /** 計數、提示、高亮。 */
  function paint(): void {
    const q = query();
    const total = truncated ? `${matches.length}+` : `${matches.length}`;
    dom.count.textContent = !q || error
      ? ''
      : matches.length === 0
        ? '無結果'
        : current >= 0
          ? `${current + 1}/${total}`
          : `共 ${total} 處`;
    dom.input.classList.toggle('invalid', !!error);

    const note = error
      ? '正則寫錯了'
      : q && tooLargeToHighlight(area.value)
        ? `這份檔案超過 ${HIGHLIGHT_LIMIT / 10000} 萬字，不畫高亮（查詢替換照常）`
        : '';
    dom.note.textContent = note;
    dom.note.title = error ?? '';
    dom.note.classList.toggle('hidden', !note);

    if (!isOpen() || matches.length === 0) {
      clearHighlights(pane, LAYER);
      return;
    }
    setHighlights(
      pane,
      LAYER,
      matches.map((m, i) => ({ start: m.start, end: m.end, cls: i === current ? CLS_CURRENT : CLS_MATCH }))
    );
  }

  /** 選中第 i 處並滾過去。不奪焦點：人可能還在查詢框裡打字。 */
  function select(i: number): void {
    current = i;
    const m = matches[i];
    currentPos = m.start;
    area.setSelectionRange(m.start, m.end);
    scrollToOffset(pane, m.start, { onlyIfHidden: true });
    paint();
  }

  /** 重算，再選中 `pick` 挑出來的那一處；一處都沒有時只畫計數。高亮只畫一次。 */
  function recomputeAndSelect(pick: () => number): void {
    compute(false);
    if (matches.length > 0) {
      select(pick());
    } else {
      paint();
    }
  }

  /** 查詢框裡的字變了 / 開關換了：從當前游標（選區起點）往後找最近的一處。 */
  function searchFromCaret(): void {
    ensureEditing();
    currentPos = undefined;
    recomputeAndSelect(() => matchAfter(matches, area.selectionStart));
  }

  function step(dir: 1 | -1): void {
    ensureEditing();
    if (!query()) {
      dom.input.focus();
      return;
    }
    recomputeAndSelect(() => {
      const { selectionStart: s, selectionEnd: e } = area;
      return dir === 1 ? matchAfter(matches, e > s ? e : s) : matchBefore(matches, s);
    });
  }

  function replaceCurrent(): void {
    ensureEditing();
    if (!query()) {
      return;
    }
    compute(false);
    const i = matchAt(matches, area.selectionStart, area.selectionEnd);
    const m = matches[i];
    const text = m && replacementFor(area.value, m, query(), dom.replaceInput.value, opts);
    if (!m || text === undefined) {
      // 選區不是當前那一處（剛開啟、或游標挪過）：這一下只選中下一處，看清楚了再按一下才換。
      if (matches.length > 0) {
        select(matchAfter(matches, area.selectionStart));
      } else {
        paint();
      }
      return;
    }
    pane.applyEdit(m.start, m.end, text, { start: m.start, end: m.start + text.length });
    currentPos = undefined;
    recomputeAndSelect(() => matchAfter(matches, m.start + text.length));
  }

  function replaceEverything(): void {
    ensureEditing();
    if (!query()) {
      return;
    }
    const edit = replaceAllIn(area.value, query(), dom.replaceInput.value, opts);
    if (!edit) {
      compute();
      toast(error ? '正則寫錯了，沒有替換。' : '沒有可替換的。', !!error);
      return;
    }
    pane.applyEdit(edit.start, edit.end, edit.text);
    currentPos = undefined;
    compute();
    toast(`替換了 ${edit.count} 處`);
  }

  function setReplaceOpen(on: boolean): void {
    dom.replaceRow.classList.toggle('hidden', !on);
    dom.toggle.textContent = on ? '▾' : '▸';
    dom.toggle.title = on ? '收起替換' : `展開替換（${shortcutLabel('replace')}）`;
    dom.toggle.setAttribute('aria-expanded', String(on));
  }

  function setOption(btn: HTMLButtonElement, key: keyof FindOptions): void {
    opts[key] = !opts[key];
    btn.classList.toggle('on', opts[key]);
    btn.setAttribute('aria-pressed', String(opts[key]));
    dom.input.focus();
    if (query()) {
      searchFromCaret();
    }
  }

  /**
   * 開啟（已經開著就是回到查詢框）。`seed`：一行之內的短選區預填進查詢框——焦點已經在查詢條裡時不填
   * （那時 textarea 的選區就是當前那一處，填進去會把人剛寫好的正則換成它的字面量）。
   */
  function open(o: { replace?: boolean; focus?: boolean; seed?: boolean } = {}): void {
    if (!pane.activeFile()) {
      return;
    }
    const fromBar = isOpen() && dom.root.contains(document.activeElement);
    ensureEditing();
    dom.root.classList.remove('hidden');
    if (o.replace) {
      setReplaceOpen(true);
    }
    const seed = o.seed === false || fromBar
      ? undefined
      : seedFromSelection(area.value, area.selectionStart, area.selectionEnd);
    if (seed !== undefined) {
      dom.input.value = opts.regex ? escapeRegExp(seed) : seed;
    }
    if (o.focus !== false) {
      dom.input.focus();
      dom.input.select();
    }
    path = pane.activePath;
    currentPos = undefined;
    compute();
    // 選區正好是一處（預填的就是）：它就是當前這一處。
    const i = matchAt(matches, area.selectionStart, area.selectionEnd);
    if (i >= 0) {
      current = i;
      currentPos = matches[i].start;
      paint();
    }
  }

  function close(): void {
    if (!isOpen()) {
      return;
    }
    dom.root.classList.add('hidden');
    if (frame !== undefined) {
      cancelFrame(frame);
      frame = undefined;
    }
    clearHighlights(pane, LAYER);
    if (pane.activeFile() && !pane.isPreviewing()) {
      area.focus();
    }
  }

  function stepFromEditor(dir: 1 | -1): void {
    if (!isOpen()) {
      // 沒有查詢串時等於 Ctrl+F（預填選區、焦點進查詢框）；有就只把條亮出來，焦點留在編輯區。
      const empty = !query();
      open({ focus: empty, seed: empty });
    }
    if (query()) {
      step(dir);
    }
  }

  /**
   * 全書查詢點了一處：查詢條亮出來、換成那邊的查詢串與兩顆開關（這一份檔案裡的每一處都畫上高亮，F3 接著往下跳），
   * 選中離 `offset` 最近的那一處並滾過去，焦點進編輯區（選區看得見）。與查詢框裡打字之後的選中同一個辦法（`select`）。
   */
  function showMatch(q: string, o: FindOptions, offset: number): boolean {
    ensureEditing();
    dom.root.classList.remove('hidden');
    dom.input.value = q;
    for (const [btn, key] of [[dom.caseBtn, 'caseSensitive'], [dom.regexBtn, 'regex']] as const) {
      opts[key] = o[key] === true;
      btn.classList.toggle('on', opts[key]);
      btn.setAttribute('aria-pressed', String(opts[key]));
    }
    path = pane.activePath;
    currentPos = undefined;
    compute(false);
    if (matches.length === 0) {
      paint();
      return false;
    }
    select(nearestMatch(matches, offset));
    area.focus();
    return true;
  }

  function onChange(ev: EditorEvent): void {
    if (ev.type === 'render') {
      if (pane.activePath === path) {
        return;
      }
      // 換了檔案：上一個檔案的匹配作廢，按新檔案重算（不動選區）；標籤全關了就收起來。
      path = pane.activePath;
      matches = [];
      current = -1;
      currentPos = undefined;
      if (!pane.activeFile()) {
        dom.root.classList.add('hidden');
        clearHighlights(pane, LAYER);
      } else if (isOpen()) {
        schedule();
      }
      return;
    }
    if (!isOpen() || ev.file !== pane.activeFile()) {
      return;
    }
    if (ev.change && currentPos !== undefined) {
      currentPos = mapOffset(currentPos, ev.change);
    }
    schedule();
  }

  // ---- 事件
  dom.input.addEventListener('input', (e) => {
    // 拼音還沒上屏時不找（找的是那幾個字母），上屏時 compositionend 再找。
    if (!(e as InputEvent).isComposing) {
      searchFromCaret();
    }
  });
  dom.input.addEventListener('compositionend', searchFromCaret);
  dom.input.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
  dom.replaceInput.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    }
  });
  // 查詢條裡任何一處（兩個輸入框、按鈕）按 Esc 都是關掉。
  dom.root.addEventListener('keydown', (e) => {
    if (!isImeComposing(e) && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  dom.prev.addEventListener('click', () => step(-1));
  dom.next.addEventListener('click', () => step(1));
  dom.close.addEventListener('click', close);
  dom.toggle.addEventListener('click', () => {
    const on = dom.replaceRow.classList.contains('hidden');
    setReplaceOpen(on);
    (on ? dom.replaceInput : dom.input).focus();
  });
  dom.caseBtn.addEventListener('click', () => setOption(dom.caseBtn, 'caseSensitive'));
  dom.regexBtn.addEventListener('click', () => setOption(dom.regexBtn, 'regex'));
  dom.replaceOne.addEventListener('click', replaceCurrent);
  dom.replaceAll.addEventListener('click', replaceEverything);

  return { open, close, isOpen, stepFromEditor, showMatch, onChange };
}

// ---------------------------------------------------------------- 全域

/** 開啟某塊編輯區的查詢條（`replace` 時連替換行一起展開）。沒開檔案時什麼都不做。 */
export function openFind(pane: Pane | undefined, opts: { replace?: boolean } = {}): void {
  if (pane?.activeFile()) {
    barOf(pane).open(opts);
  }
}

/**
 * 全書查詢（`bookFind.ts`）點了一處：這一塊的查詢條換成同一個查詢串與兩顆開關，選中離 `offset`（編輯區裡的下標）最近的
 * 那一處、滾過去、焦點進編輯區——定位的辦法與查詢框裡打字之後選中一處同一個。這一塊的當前檔案就是要去的那一份
 * （呼叫方先 `activate`）。一處都找不到（編輯區裡有沒儲存的修改、那幾個字改掉了）返回 false。
 */
export function revealFindMatch(pane: Pane, query: string, opts: FindOptions, offset: number): boolean {
  return !!pane.activeFile() && barOf(pane).showMatch(query, opts, offset);
}

let installed = false;

/** 裝上查詢的快捷鍵、選單命令與變化訂閱。editor/index.ts 啟動時調一次。 */
export function installFind(): void {
  if (installed) {
    return;
  }
  installed = true;

  document.addEventListener('keydown', (e) => {
    // 輸入法組字中途的按鍵是輸入法的。
    if (isImeComposing(e)) {
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Ctrl+Shift+F / Ctrl+Shift+H 是全書查詢替換（bookFind.ts），不歸這一條。
    if (ctrl && !e.altKey && !e.shiftKey && (key === 'f' || key === 'h')) {
      const pane = paneForShortcut(e);
      if (pane) {
        // Chrome 允許攔 Ctrl+H（歷史記錄），攔得到。
        e.preventDefault();
        openFind(pane, { replace: key === 'h' });
      }
      return;
    }
    if (key === 'F3' && !ctrl && !e.altKey) {
      const pane = paneForShortcut(e);
      if (pane) {
        e.preventDefault();
        barOf(pane).stepFromEditor(e.shiftKey ? -1 : 1);
      }
      return;
    }
    if (key === 'Escape' && !ctrl) {
      // 編輯區裡按 Esc 也收起這一塊的查詢條（查詢框、替換框裡的 Esc 它們自己處理了）。
      const pane = paneContaining(e.target);
      const bar = pane && bars.get(pane);
      if (pane && bar?.isOpen() && e.target === pane.area) {
        e.preventDefault();
        bar.close();
      }
    }
  });

  // 標題欄「編輯 → 查詢 / 替換」。
  window.addEventListener('nf-editor-command', (e) => {
    if (e.detail.name === 'find' || e.detail.name === 'replace') {
      openFind(activePane, { replace: e.detail.name === 'replace' });
    }
  });

  onEditorChange((ev) => bars.get(ev.pane)?.onChange(ev));
}
