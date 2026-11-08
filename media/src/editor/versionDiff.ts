/**
 * 「版本」的對比標籤（獨立版的內建編輯器）：左邊一版、右邊現在（或後一版），按行比，一處改動裡逐字標出刪了什麼、
 * 加了什麼。在「版本」側欄（`versions.ts`）裡點一行就開在這裡，不經預覽、不彈窗。比的口徑在 `versionDiffCore.ts`。
 *
 * - **一個不對應檔案的特殊標籤**（`store.ts` 的 `SpecialTab`，同「敘事線總覽」），**只有一個**：再點別的一行就換掉裡面
 *   的內容（像 VS Code 的預覽標籤）；開在那份檔案所在的那一塊裡。**不進重新整理恢復**（`transient`）：看的是哪兩版只在這一頁裡記著。
 * - **三種比法**：一版 ↔ 現在（預設：右邊是編輯器裡那一份，沒儲存的也算）；一版 ↔ 它後面一版（側欄右鍵「跟後一版比」：
 *   看那一次改了什麼，兩邊都是存下的，只能看）；磁碟上的 ↔ 編輯器裡的（側欄最上面那一行「還沒儲存的改動」）。全書改動裡
 *   存檔點之後新建的左邊是空的、之後刪掉的右邊是空的（`empty`，只能看）。
 * - **右邊是現在、那份檔案卻沒開著**（全書改動、存檔點彈窗裡點的）：先開成臨時標籤（`openEditor` 帶 `preview`），等它進了
 *   編輯區再開對比標籤——用回、恢復都要改編輯區裡那一份。
 * - **跟得上**：右邊是編輯器裡那一份時，那份檔案一改（這裡放回一處、另一塊裡在打字、磁碟上的新版進來、儲存）就重比；
 *   藏著時只記一筆，下次顯示再比。那份檔案關掉了就照實說，不拿舊的比。
 * - **用回這一處 / 恢復整份**（只在右邊是編輯器裡那一份時有）：只換編輯區裡的內容——一步撤銷、成為未儲存、**不寫盤**（第 3 條）。
 *   換之前先發一條不說話的 `saveVersion { quiet }`：放回的內容一存檔（開著自動儲存時停筆兩秒就存）就蓋掉磁碟上那一份，節流
 *   可能不存它。用回一處要改的那份檔案就藏在這個標籤後面（`applyEdit` 只作用於當前檔案）：同一個任務裡切過去、改、再切回來，
 *   中間不畫，看不出閃；對比區滾到哪先記下、切回來放回去（藏起來那一下滾動位置會丟）。「恢復整份」換完停在那份檔案上。
 * - **沒改的折起來**：每處改動前後各留一行，中間相同的折成「⋯ 相同的 N 段 ⋯」，點開就展開（重比之後照舊展開著）。
 *
 * 使用者內容一律 `textContent`。樣式在 `css/standalone/versions.css`。
 */
import { el, setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { InMessage, OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { onEditorChange } from './api';
import { scrollToOffset } from './highlight';
import { claimRequest, newRequestId, replaceInEditor } from './replace';
import { paneOwning, panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';
import { blockText, charDiff, diffLines, normalizeEol, onlyWhitespace, revertEdit } from './versionDiffCore';
import type { DiffBlock, LineDiff } from './versionDiffCore';

/** 特殊標籤的 id。 */
export const VERSION_DIFF_TAB = 'version-diff';

/** 一版：讀它用的 id，標題上怎麼說。 */
export interface VersionRef {
  id: string;
  label: string;
}

/**
 * 要比的兩邊。左邊 `disk`：磁碟上的（上次儲存的那一份）；右邊 `now`：編輯器裡的；`empty`：那一邊沒有這份檔案（存檔點裡
 * 還沒有、現在已經刪了）。
 */
export interface DiffRequest {
  path: string;
  /** 標籤與標題上寫的檔名。 */
  name: string;
  left: VersionRef | 'disk' | 'empty';
  right: VersionRef | 'now' | 'empty';
}

type Side = DiffRequest['left'] | DiffRequest['right'];

/** 每處改動前後各留幾行沒改的。 */
const CONTEXT = 1;
/** 編輯器裡那一份變了之後停多久再比（連著打字只比一次）。 */
const REDIFF_MS = 200;
/** 讀過的版本全文最多記幾份（快照、存檔點裡的那一份都不會變，記著不用再要）。 */
const TEXT_CACHE = 20;

interface View {
  root: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  restore: HTMLButtonElement;
  open: HTMLButtonElement;
  leftHead: HTMLElement;
  rightHead: HTMLElement;
  body: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 顯示在哪一塊。 */
let host: Pane | undefined;
let req: DiffRequest | undefined;
/** 兩邊的全文（`now` 那邊每次從編輯區取，不記）。undefined = 還在路上；`error` = 讀不到。 */
let leftText: string | undefined;
let rightText: string | undefined;
let loadError: string | undefined;
/** 上一次畫的那一份比較，與畫的時候編輯器裡那份的文字（用回一處之前核對：變了就重比，不拿舊下標改）。 */
let shownDiff: LineDiff | undefined;
let shownRight: string | undefined;
/** 展開了的那幾截相同的（按左邊第一行的行號認：重比之後左邊不變，照舊展開著）。 */
const expanded = new Set<number>();
/** 上一處 / 下一處停在第幾處（-1 = 還沒停過）。 */
let current = -1;
/** 新換上的這一對還沒畫出改動：畫出來時停到第一處。 */
let jumpPending = false;
/** 等那份檔案進編輯區（`openEditor` 發出去了）再開的那一個。 */
let pendingOpen: DiffRequest | undefined;
/** 藏著的時候編輯器裡那份變過：下次顯示再比。 */
let stale = false;
let rediffTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

// ---------------------------------------------------------------- 讀一版的全文

const textCache = new Map<string, string>();
const waiting = new Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }>();

/** 一版的全文（快照或存檔點裡的那一份）。讀過的記著。 */
export function versionText(path: string, id: string): Promise<string> {
  const key = `${path}\u0000${id}`;
  const cached = textCache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const requestId = newRequestId('version');
    waiting.set(requestId, {
      resolve: (text) => {
        textCache.delete(key);
        textCache.set(key, text);
        if (textCache.size > TEXT_CACHE) {
          textCache.delete(textCache.keys().next().value!);
        }
        resolve(text);
      },
      reject,
    });
    post({ type: 'readVersion', path, id, requestId });
  });
}

function onVersionText(msg: Extract<OutMessage, { type: 'versionText' }>): void {
  const w = waiting.get(msg.requestId);
  if (!w || !claimRequest(msg.requestId)) {
    return;
  }
  waiting.delete(msg.requestId);
  if (msg.text !== undefined) {
    w.resolve(msg.text);
  } else {
    w.reject(new Error(msg.error ?? '讀不到這一版。'));
  }
}

// ---------------------------------------------------------------- 對外

/** 對比標籤此刻在比的是什麼（側欄據此標出選中的那一行）。沒開就是 undefined。 */
export function currentDiff(): DiffRequest | undefined {
  return req && paneWithSpecial(VERSION_DIFF_TAB) ? req : undefined;
}

/** 比的東西換了、標籤關了：側欄跟著重畫選中的那一行。 */
export function onDiffChange(listener: () => void): void {
  listeners.add(listener);
}

/** 在那份檔案所在的那一塊開對比標籤（已經開著就換掉裡面的內容）。 */
export function openDiff(next: DiffRequest): void {
  const pane = paneOwning(next.path) ?? paneWithSpecial(VERSION_DIFF_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  const same = req && sameRequest(req, next);
  req = next;
  pendingOpen = undefined;
  if (!same) {
    leftText = typeof next.left === 'string' ? undefined : textCache.get(`${next.path}\u0000${next.left.id}`);
    rightText = typeof next.right === 'string' ? undefined : textCache.get(`${next.path}\u0000${next.right.id}`);
    loadError = undefined;
    expanded.clear();
    current = -1;
    jumpPending = true;
    shownDiff = undefined;
    if (view) {
      view.body.scrollTop = 0;
    }
    load(next);
  }
  pane.openSpecial(VERSION_DIFF_TAB);
  render();
  notify();
}

/** 同 {@link openDiff}；右邊是現在、那份檔案卻沒開著時先開成臨時標籤，進了編輯區再開對比標籤。 */
export function openFileDiff(next: DiffRequest): void {
  if (next.right !== 'now' || paneOwning(next.path)) {
    openDiff(next);
    return;
  }
  pendingOpen = next;
  post({ type: 'openEditor', path: next.path, preview: true });
}

/**
 * 「恢復整份」：把編輯區裡這份檔案換成那一版（一步撤銷，成為未儲存，不寫盤），停在那份檔案上。換之前先讓後端把磁碟上
 * 現在那一份存一版（不說話、跳過節流）。
 */
export async function restoreVersion(path: string, ref: VersionRef): Promise<void> {
  let text: string;
  try {
    text = await versionText(path, ref.id);
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  const file = paneOwning(path)?.files.get(path);
  if (file && normalizeEol(file.draft) !== normalizeEol(text)) {
    // 訊息按順序到：排在之後任何一次 saveFile 前面。
    post({ type: 'saveVersion', path, quiet: true });
  }
  const result = replaceInEditor(path, text);
  if (result === 'closed') {
    toast('這份檔案已經關掉了。', true);
  } else if (result === 'unchanged') {
    toast('編輯區裡已經是這一版了。');
  } else {
    toast(`已把「${ref.label}」放進編輯區：還沒儲存，Ctrl+Z 可以退回。`);
  }
}

function sameRequest(a: DiffRequest, b: DiffRequest): boolean {
  const key = (s: Side) => (typeof s === 'string' ? s : s.id);
  return a.path === b.path && key(a.left) === key(b.left) && key(a.right) === key(b.right);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function load(r: DiffRequest): void {
  const fetch = (side: VersionRef, set: (text: string) => void) => {
    versionText(r.path, side.id).then(
      (text) => {
        if (req === r) {
          set(text);
          render();
        }
      },
      (err: Error) => {
        if (req === r) {
          loadError = err.message;
          render();
        }
      }
    );
  };
  if (typeof r.left !== 'string' && leftText === undefined) {
    fetch(r.left, (text) => (leftText = text));
  }
  if (typeof r.right !== 'string' && rightText === undefined) {
    fetch(r.right, (text) => (rightText = text));
  }
}

// ---------------------------------------------------------------- 裝

export function installVersionDiff(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: VERSION_DIFF_TAB,
    label: () => ({
      title: req ? `對比 · ${req.name}` : '對比',
      tip: req ? `${sideLabel('left')} ↔ ${sideLabel('right')}` : '對比',
    }),
    show,
    hide,
    transient: true,
  });

  onMessage((msg) => {
    if (msg.type === 'versionText') {
      onVersionText(msg);
    }
  });

  // 編輯器裡那份變了（打字、放回一處、磁碟上的新版、儲存換了基線）：顯示著就停一下再比，藏著就記一筆。
  onEditorChange((ev) => {
    // 等著的那份檔案進了編輯區：這一輪重畫完了再開對比標籤（這會兒還在 upsertFile 裡）。
    if (pendingOpen && ev.type === 'render' && paneOwning(pendingOpen.path)) {
      const next = pendingOpen;
      pendingOpen = undefined;
      queueMicrotask(() => openDiff(next));
    }
    if (!req || (req.right !== 'now' && req.left !== 'disk')) {
      return;
    }
    if (ev.type === 'edit' && ev.file.path !== req.path) {
      return;
    }
    if (!visible()) {
      stale = true;
      return;
    }
    clearTimeout(rediffTimer);
    rediffTimer = setTimeout(render, REDIFF_MS);
  });

  window.addEventListener('nf-workspace-reset', () => {
    req = undefined;
    pendingOpen = undefined;
    textCache.clear();
    shownDiff = undefined;
  });
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === VERSION_DIFF_TAB;
}

// ---------------------------------------------------------------- 顯示與收起（SpecialTab）

function show(pane: Pane): void {
  const stage = pane.root.querySelector<HTMLElement>('.ed-stage');
  if (!stage) {
    return;
  }
  const v = ensureView();
  if (v.root.parentElement !== stage) {
    stage.appendChild(v.root);
  }
  const wasHidden = v.root.classList.contains('hidden') || host !== pane;
  host = pane;
  setHidden(v.root, false);
  if (wasHidden && stale) {
    stale = false;
    render();
  }
}

function hide(pane: Pane): void {
  if (!view || host !== pane) {
    return;
  }
  setHidden(view.root, true);
  // 關掉了（不只是切走）：側欄不再標選中的那一行。
  if (!pane.specials.includes(VERSION_DIFF_TAB)) {
    notify();
  }
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'vd hidden');
  root.setAttribute('aria-label', '對比');
  const head = el('div', 'vd-head');
  const title = el('span', 'vd-title');
  const meta = el('span', 'vd-meta');
  const button = (cls: string, text: string, tip: string) => {
    const b = el('button', `chip-btn ${cls}`, text);
    b.type = 'button';
    b.title = tip;
    return b;
  };
  const prev = button('vd-prev', '↑ 上一處', '滾到上一處改動');
  const next = button('vd-next', '↓ 下一處', '滾到下一處改動');
  const restore = button('vd-restore', '恢復整份', '把編輯區換成左邊這一版（一步撤銷，不寫盤，存不存由你）');
  const open = button('vd-open', '開啟檔案', '回到這份檔案');
  head.append(title, meta, el('span', 'spacer'), prev, next, restore, open);
  const cols = el('div', 'vd-cols');
  const leftHead = el('div', 'vd-col vd-col-left');
  const rightHead = el('div', 'vd-col vd-col-right');
  cols.append(leftHead, rightHead);
  const body = el('div', 'vd-body');
  root.append(head, cols, body);

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  restore.addEventListener('click', () => {
    if (req && typeof req.left !== 'string' && req.right === 'now') {
      void restoreVersion(req.path, req.left);
    }
  });
  open.addEventListener('click', () => {
    if (req) {
      paneOwning(req.path)?.activate(req.path);
    }
  });
  view = { root, title, meta, prev, next, restore, open, leftHead, rightHead, body };
  return view;
}

function sideLabel(side: 'left' | 'right'): string {
  if (!req) {
    return '';
  }
  const s = req[side];
  if (s === 'disk') {
    return '磁碟上的（上次儲存的）';
  }
  if (s === 'empty') {
    return side === 'left' ? '存檔點裡還沒有這一份' : '現在已經沒有這一份了（刪了或改了名）';
  }
  if (s === 'now') {
    const file = paneOwning(req.path)?.files.get(req.path);
    return file && file.draft !== file.text ? '現在（編輯器裡，還沒儲存）' : '現在';
  }
  return s.label;
}

/** 右邊是編輯器裡那一份時，從編輯區取；那份檔案關了是 undefined。左邊是磁碟上的同樣從編輯區取（它的基線）。 */
function sideText(side: 'left' | 'right'): string | undefined {
  if (!req) {
    return undefined;
  }
  const s = req[side];
  if (s === 'empty') {
    return '';
  }
  if (s === 'now' || s === 'disk') {
    const file = paneOwning(req.path)?.files.get(req.path);
    return file ? (s === 'now' ? file.draft : file.text) : undefined;
  }
  return side === 'left' ? leftText : rightText;
}

/** 編輯器裡那一份能不能改：右邊是它時才能用回、恢復。 */
function editable(): boolean {
  return !!req && req.right === 'now' && !!paneOwning(req.path);
}

function render(): void {
  clearTimeout(rediffTimer);
  if (!view || !req) {
    return;
  }
  const v = view;
  const top = v.body.scrollTop;
  v.title.textContent = req.name;
  v.title.title = req.path;
  v.leftHead.textContent = sideLabel('left');
  v.rightHead.textContent = sideLabel('right');
  setHidden(v.restore, !(typeof req.left !== 'string' && editable()));
  host?.refresh();

  const before = sideText('left');
  const after = sideText('right');
  v.body.replaceChildren();
  shownDiff = undefined;
  const say = (text: string, error = false) => {
    v.meta.textContent = '';
    setNav(0);
    v.body.appendChild(el('p', error ? 'vd-note error' : 'vd-note', text));
  };
  if (loadError) {
    say(loadError, true);
    return;
  }
  if ((req.right === 'now' || req.left === 'disk') && !paneOwning(req.path)) {
    say('這份檔案已經關掉了：重新開啟它，再在「版本」裡點一行。');
    return;
  }
  if (before === undefined || after === undefined) {
    say('載入中…');
    return;
  }

  const diff = diffLines(before, after);
  shownDiff = diff;
  shownRight = after;
  if (diff.changes === 0) {
    say(
      onlyWhitespace(diff)
        ? '只有空白不同（縮排、空行、行尾空格），文字一樣。'
        : req.left === 'disk'
          ? '沒有還沒儲存的改動了。'
          : '兩邊一樣。'
    );
    return;
  }
  const changes = diff.blocks.filter((b) => b.kind === 'change');
  let removed = 0;
  let added = 0;
  diff.blocks.forEach((block, k) => {
    if (block.kind === 'same') {
      renderSame(v.body, diff, block, k === 0, k === diff.blocks.length - 1);
      return;
    }
    const counts = renderChange(v.body, diff, block, changes.indexOf(block));
    removed += counts.removed;
    added += counts.added;
  });
  v.meta.textContent = `${changes.length} 處改動 · 刪 ${removed} 字 · 加 ${added} 字`;
  if (jumpPending) {
    // 剛換上的：停到第一處（同 VS Code 開啟 diff）。
    jumpPending = false;
    current = -1;
    step(1);
    return;
  }
  current = Math.min(current, changes.length - 1);
  setNav(changes.length);
  markCurrent();
  v.body.scrollTop = top;
}

function setNav(count: number): void {
  if (!view) {
    return;
  }
  view.prev.disabled = count === 0 || current <= 0;
  view.next.disabled = count === 0 || current >= count - 1;
}

/** 一截相同的：前後各留 {@link CONTEXT} 行，中間折起來（開頭那截只留後面的、結尾那截只留前面的）。 */
function renderSame(body: HTMLElement, diff: LineDiff, block: DiffBlock, first: boolean, last: boolean): void {
  const lines = diff.left.slice(block.left[0], block.left[1]);
  const keepHead = first ? 0 : CONTEXT;
  const keepTail = last ? 0 : CONTEXT;
  const box = el('div', 'vd-same');
  const line = (text: string) => box.appendChild(el('div', 'vd-line', text));
  if (expanded.has(block.left[0]) || lines.length <= keepHead + keepTail + 1) {
    lines.forEach((l) => line(l.text));
  } else {
    lines.slice(0, keepHead).forEach((l) => line(l.text));
    const hidden = lines.length - keepHead - keepTail;
    const fold = el('button', 'vd-fold', `⋯ 相同的 ${hidden} 段 ⋯`);
    fold.type = 'button';
    fold.title = '展開';
    fold.addEventListener('click', () => {
      expanded.add(block.left[0]);
      render();
    });
    box.appendChild(fold);
    lines.slice(lines.length - keepTail).forEach((l) => line(l.text));
  }
  body.appendChild(box);
}

/** 一處改動：左邊刪的、右邊加的，逐字標；底下「用回這一處」。返回刪了幾個字、加了幾個字（不算空白）。 */
function renderChange(body: HTMLElement, diff: LineDiff, block: DiffBlock, index: number): { removed: number; added: number } {
  const a = blockText(diff, block, 'left');
  const b = blockText(diff, block, 'right');
  const marks = charDiff(a, b);
  const box = el('div', 'vd-change');
  box.dataset.change = String(index);
  const side = (cls: string, text: string, ranges: [number, number][] | undefined, tag: 'del' | 'ins') => {
    const cell = el('div', `vd-side ${cls}`);
    if (text === '') {
      cell.appendChild(el('div', 'vd-empty', tag === 'del' ? '（原來沒有）' : '（刪掉了）'));
      return cell;
    }
    let at = 0;
    for (const lineText of text.split('\n')) {
      const row = el('div', 'vd-line');
      appendMarked(row, lineText, at, ranges ?? [[at, at + lineText.length]], tag);
      cell.appendChild(row);
      at += lineText.length + 1;
    }
    return cell;
  };
  box.append(side('vd-old', a, marks?.left, 'del'), side('vd-new', b, marks?.right, 'ins'));
  if (editable()) {
    const bar = el('div', 'vd-bar');
    const revert = el('button', 'chip-btn vd-revert', '用回這一處');
    revert.type = 'button';
    revert.title = '把編輯區裡這一處換回左邊那樣（一步撤銷，不寫盤）';
    revert.addEventListener('click', () => revertBlock(index));
    bar.appendChild(revert);
    box.appendChild(bar);
  }
  onContextMenu(box, () => changeMenu(index));
  body.appendChild(box);
  const count = (text: string, ranges: [number, number][] | undefined) =>
    (ranges ? ranges.map(([s, e]) => text.slice(s, e)).join('') : text).replace(/\s+/g, '').length;
  return { removed: count(a, marks?.left), added: count(b, marks?.right) };
}

/** 一行文字（在那一處全文裡從 `offset` 開始），落在 `ranges` 裡的包進 `<del>` / `<ins>`。 */
function appendMarked(row: HTMLElement, text: string, offset: number, ranges: [number, number][], tag: 'del' | 'ins'): void {
  let pos = 0;
  for (const [s, e] of ranges) {
    const from = Math.max(s - offset, pos);
    const to = Math.min(e - offset, text.length);
    if (to <= from) {
      continue;
    }
    if (from > pos) {
      row.appendChild(document.createTextNode(text.slice(pos, from)));
    }
    row.appendChild(el(tag, undefined, text.slice(from, to)));
    pos = to;
  }
  if (pos < text.length) {
    row.appendChild(document.createTextNode(text.slice(pos)));
  }
}

function changeMenu(index: number): MenuItem[] {
  const items: MenuItem[] = [];
  if (editable()) {
    items.push({ label: '用回這一處', run: () => revertBlock(index) });
  }
  if (req && paneOwning(req.path) && req.right === 'now') {
    items.push({ label: '在編輯器裡開啟這裡', run: () => openHere(index) });
  }
  return items;
}

// ---------------------------------------------------------------- 上一處 / 下一處

function step(delta: number): void {
  const count = shownDiff?.changes ?? 0;
  if (count === 0) {
    return;
  }
  current = Math.max(0, Math.min(count - 1, current + delta));
  setNav(count);
  markCurrent();
  view?.body.querySelector(`.vd-change[data-change="${current}"]`)?.scrollIntoView({ block: 'center' });
}

function markCurrent(): void {
  for (const box of view?.body.querySelectorAll<HTMLElement>('.vd-change') ?? []) {
    box.classList.toggle('current', box.dataset.change === String(current));
  }
}

// ---------------------------------------------------------------- 用回這一處、在編輯器裡開啟

/** 第 `index` 處改動（按畫出來的那一份比較）。編輯器裡那份在畫完之後又變了：先重比，不拿舊下標改。 */
function changeBlock(index: number): DiffBlock | undefined {
  if (!req || !shownDiff) {
    return undefined;
  }
  if (sideText('right') !== shownRight) {
    render();
    toast('編輯區裡這份剛變過，重新比過了：再點一次。');
    return undefined;
  }
  return shownDiff.blocks.filter((b) => b.kind === 'change')[index];
}

function revertBlock(index: number): void {
  const block = changeBlock(index);
  const pane = req && paneOwning(req.path);
  if (!req || !block || !shownDiff || !pane) {
    return;
  }
  const edit = revertEdit(shownDiff, block);
  post({ type: 'saveVersion', path: req.path, quiet: true });
  // 那份檔案可能就藏在這個標籤後面：切過去改了再切回來（同一個任務裡，中間不畫）。對比區的滾動位置先記下。
  const top = view?.body.scrollTop ?? 0;
  const back = pane.activeSpecial() === VERSION_DIFF_TAB;
  if (pane.activePath !== req.path) {
    pane.activate(req.path, { focus: false });
  }
  pane.applyEdit(edit.start, edit.end, edit.text, { start: edit.start, end: edit.start + edit.text.length });
  if (back) {
    pane.openSpecial(VERSION_DIFF_TAB, { focus: false });
  }
  render();
  if (view) {
    view.body.scrollTop = top;
  }
}

function openHere(index: number): void {
  const block = changeBlock(index);
  const pane = req && paneOwning(req.path);
  if (!req || !block || !shownDiff || !pane) {
    return;
  }
  const lines = shownDiff.right;
  const [j1, j2] = block.right;
  const start = j2 > j1 ? lines[j1].start : j1 > 0 ? lines[j1 - 1].end : 0;
  const end = j2 > j1 ? lines[j2 - 1].end : start;
  pane.activate(req.path);
  pane.setPreviewing(false);
  pane.area.setSelectionRange(start, end);
  scrollToOffset(pane, start);
}
