import { traditionalLabel } from '../../../src/core/model/labels';
/**
 * 編輯區「敘事線總覽」標籤（敘事線重做三期，設計見 docs/design/plans/2026-10-20-narrative-threads.md「八」）：章 × 線的
 * 時間軸，作者一眼看出每條線走到哪、哪條伏筆該收了、計劃的事哪一章沒發生。
 *
 * - **一個不對應檔案的特殊標籤**（`store.ts` 的 `SpecialTab`）：標籤條上排在檔案標籤前面，切過去時這一塊沒有當前檔案，
 *   畫的東西掛在這一塊的 `.ed-stage` 上、蓋住正文區。同一時刻只開在一塊裡（預設主區）。
 *   重新整理記著、恢復時先於檔案開啟（`store.ts` 的 `restore`），記壞了的不認、不崩。
 * - **資料按需要**（仿「轉到…」）：顯示出來時發 `requestThreadsOverview { requestId }`，後端回 `threadsOverview`
 *   （`core/views/threads.ts` 的 `buildThreadsOverview`：純讀盤、不調模型、狀態現算）；認 requestId（回覆是廣播）。顯示著
 *   收到 `state` / `init`（磁碟上變過）停一下再要一次；藏著時只記一筆「過期」，下次顯示再要。不進 `ProjectTree`。
 * - **畫法**：橫軸是章（列頭標章號、分卷的書多一行卷名，列頭的樣子說這一章定稿沒有、定稿了的敘事線判過沒有），一條豎線標
 *   「定稿到第 N 章」，敘事線落後於定稿時另一條虛的標「敘事線判到第 M 章」（四期）；縱軸
 *   按種類分組，每條線下面縮排列它的伏筆，最後是「未歸屬的伏筆」。線的格子 ○ 只有計劃、● 只有實際、◉ 計劃也發生了、
 *   紅圈是計劃了那一章也定稿了卻沒發生（偏差）；伏筆一行埋 ● 到收 ◆ 連線、沒收的虛線延到回收章（那一格一道豎線）、
 *   還沒埋的按計劃淡虛線，逾期標紅、棄畫 ✕，計劃的埋與收畫空心。圓點借流水線條的 `pstage-mark`。連線、偏差、狀態
 *   都是後端算好的，這裡只畫。左列（線名、伏筆名）與表頭固定（`position: sticky`），橫向滾動；格子是稀疏的，一行只
 *   畫有事件的那幾章，幾千章也畫得動。
 * - **互動**：懸停格子看那幾條事件與證據；點格子、點列頭開啟那一章（`openChapter`：正文進主區、細綱並排，還沒寫的開啟細綱）；
 *   點線名、伏筆名、「未歸屬的伏筆」開啟那份檔案（開在總覽所在的這一塊）。右鍵格子、列頭給「開啟第 N 章」。
 *   **觸屏**（手指沒有懸停，`touch.ts` 認這一下是不是手指）：點格子、點列頭彈那隻浮窗（看這一格本身），**不**開啟那一章——
 *   開啟走長按選單裡的「開啟第 N 章」；點別處、滾動就收。相容滑鼠事件不當懸停。
 * - **入口**：工程頁「敘事線」頁籤標題旁的「總覽」與右鍵「在總覽裡看」（經 `nf-threads-command`，帶 `focus` 就定位到那一行）。
 *   工程頁先問 `nf-threads-query` 有沒有人畫得了——只有這個模組回答，外掛形態沒有 editor.js，入口就不畫（能力探測）。
 *
 * 使用者內容一律 `textContent`。樣式在 `css/standalone/threads.css`。
 */
import { el, setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuContext, MenuItem, ThreadsOverviewCommand } from '../globals';
import type {
  InMessage,
  OutMessage,
  ThreadsOverview,
  ThreadsOverviewCell,
  ThreadsOverviewChapter,
  ThreadsOverviewEvent,
  ThreadsOverviewForeshadow,
  ThreadsOverviewLine,
} from '../protocol';
import { isTouchEvent, lastPointerWasTouch, trackPointer } from '../touch';
import { onMessage } from '../vscodeApi';
import { openChapterMessage } from '../narrow';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';

/** 特殊標籤的 id（記進 localStorage）。 */
export const THREADS_OVERVIEW_TAB = 'threads-overview';

/** 一列多寬、左列多寬（px）。CSS 經 `--tov-cell` / `--tov-name` 拿同一個數。 */
const CELL = 24;
const NAME_WIDTH = 220;
/** 窄屏（手機豎屏）上左列收窄：360px 寬時 220 只剩六七列章可看。 */
const NAME_WIDTH_NARROW = 128;

/** 這一次畫的左列寬：按視口寬度挑（能力探測，不認是什麼裝置）。CSS 與幾條豎線的位置都按它。 */
let nameWidth = NAME_WIDTH;

function currentNameWidth(): number {
  return window.matchMedia?.('(max-width: 600px)').matches ? NAME_WIDTH_NARROW : NAME_WIDTH;
}
/** 顯示著時收到 `state` 之後停多久再要一次（作者連著存幾次只要一次）。 */
const REFRESH_DELAY_MS = 600;

const TITLE = '敘事線總覽';
const TAB_TIP = '敘事線總覽：章 × 線的時間軸——每條線走到哪、伏筆埋了收了沒有、計劃的事哪一章沒發生。現算，不調模型。';
const NO_WORKSPACE = '先開啟一個小說工程，才有敘事線總覽。';

const STATE_LABEL: Record<ThreadsOverviewChapter['state'], string> = {
  finalized: '已同步',
  written: '寫了，還沒同步',
  planned: '只有細綱',
  none: '還沒有細綱',
};

/** 線名前的狀態點（同工程頁那一行）。 */
const STATUS_DOT: Record<ThreadsOverviewLine['status'], string> = { 进行中: '●', 计划中: '○', 已收束: '✓', 已放弃: '✕' };

interface View {
  root: HTMLElement;
  meta: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
  tip: HTMLElement;
}

/** 一格懸停時要說的。 */
interface CellInfo {
  row: string;
  cell: ThreadsOverviewCell;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 顯示在哪一塊。 */
let host: Pane | undefined;
let data: ThreadsOverview | undefined;
/** 在路上的那一次請求。 */
let waiting: string | undefined;
/** 拿到這一份之後磁碟上變過（或從沒拿過）：下次顯示時再要。 */
let stale = true;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** 定位到的那一行（一條線、或「未歸屬的伏筆」那份檔案的路徑）：一直標著，換了資料重畫也標著。 */
let focused: string | undefined;
/** 定位之後還沒滾過去（資料到了、畫好了才滾，滾一次）。 */
let scrollPending = false;
const cellInfo = new WeakMap<HTMLElement, CellInfo>();

// ---------------------------------------------------------------- 裝

export function installThreadsOverview(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: THREADS_OVERVIEW_TAB,
    label: () => ({ title: TITLE, tip: TAB_TIP }),
    show,
    hide,
    menu: () => [{ label: '重新整理', run: () => request() }],
  });

  // 工程頁問「畫得了嗎」：只有裝了編輯器（獨立版、桌面版）才有人回答（能力探測）。
  window.addEventListener('nf-threads-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-threads-command', (e) => openOverview(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    // 標籤由 index.ts 一併關掉；這裡丟掉上一個工程的資料。
    data = undefined;
    waiting = undefined;
    stale = true;
    focused = undefined;
    scrollPending = false;
    clearTimeout(refreshTimer);
    if (view) {
      view.scroll.replaceChildren();
      hideTip();
    }
  });

  onMessage((msg: OutMessage) => {
    if (msg.type === 'threadsOverview') {
      if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
        return;
      }
      waiting = undefined;
      data = msg.overview;
      stale = false;
      render();
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁碟上可能變過（儲存、定稿、拆細綱……）。顯示著就停一下再要一次，藏著就等下次顯示。
      stale = true;
      if (visible()) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (visible() && stale && !waiting) {
            request();
          }
        }, REFRESH_DELAY_MS);
      }
    }
  });
}

/** 開啟總覽（已經開著就切過去）；`focus` 給了就定位到那一行。 */
function openOverview(cmd: ThreadsOverviewCommand | undefined): void {
  if (document.body.classList.contains('no-workspace')) {
    toast(NO_WORKSPACE);
    return;
  }
  const pane = paneWithSpecial(THREADS_OVERVIEW_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  if (cmd?.focus) {
    focused = cmd.focus;
    scrollPending = true;
  }
  // 作者點了「總覽」就是要看現在的樣子：開著也再要一次。
  stale = true;
  pane.openSpecial(THREADS_OVERVIEW_TAB);
  if (data) {
    applyFocus();
  }
  revealEditor();
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === THREADS_OVERVIEW_TAB;
}

function request(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  clearTimeout(refreshTimer);
  waiting = newRequestId('threads');
  post({ type: 'requestThreadsOverview', requestId: waiting });
  if (!data) {
    render();
  }
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
  host = pane;
  setHidden(v.root, false);
  if ((stale || !data) && !waiting) {
    request();
  }
}

function hide(pane: Pane): void {
  if (!view || host !== pane) {
    return;
  }
  setHidden(view.root, true);
  hideTip();
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'tov hidden');
  root.setAttribute('aria-label', TITLE);
  const head = el('div', 'tov-head');
  head.appendChild(el('span', 'tov-title', TITLE));
  const meta = el('span', 'tov-meta');
  head.appendChild(meta);
  head.appendChild(legend());
  head.appendChild(el('span', 'spacer'));
  const refresh = el('button', 'chip-btn tov-refresh', '重新整理');
  refresh.type = 'button';
  refresh.title = '照磁碟上現在的敘事線與章節重畫（不調模型）';
  refresh.addEventListener('click', () => request());
  head.appendChild(refresh);
  const note = el('p', 'hint tov-note hidden');
  const scroll = el('div', 'tov-scroll');
  scroll.style.setProperty('--tov-cell', `${CELL}px`);
  scroll.style.setProperty('--tov-name', `${nameWidth}px`);
  const tip = el('div', 'tov-tip hidden');
  tip.setAttribute('role', 'tooltip');
  root.append(head, note, scroll, tip);

  trackPointer();
  scroll.addEventListener('click', onClick);
  scroll.addEventListener('mouseover', onOver);
  scroll.addEventListener('mouseout', onOut);
  scroll.addEventListener('scroll', hideTip);
  onContextMenu(scroll, menuItems);
  // 手指點出來的浮窗沒有「移開」：按在表格外面（標題欄、說明）也收。
  root.addEventListener('pointerdown', (e) => {
    if (!scroll.contains(e.target as Node)) {
      hideTip();
    }
  });
  view = { root, meta, note, scroll, tip };
  return view;
}

/** 右鍵（觸屏上是長按）格子或列頭：「開啟第 N 章」（同點格子；觸屏上點格子只看浮窗，開啟走這裡）。別處給「重新整理」。 */
function menuItems(at: MenuContext): MenuItem[] {
  hideTip();
  const chapter = at.target?.closest<HTMLElement>('.tov-cell, .tov-col');
  const no = Number(chapter?.dataset.ch);
  const items: MenuItem[] = [];
  if (no > 0) {
    const c = data?.chapters[no - 1];
    items.push({
      label: c?.chapterPath || !c?.plotPath ? `開啟第 ${no} 章` : `開啟第 ${no} 章的細綱`,
      disabled: !c?.chapterPath && !c?.plotPath,
      run: () => openChapter(no),
    });
    items.push({ sep: true });
  }
  items.push({ label: '重新整理', run: () => request() });
  return items;
}

/** 圖例：線的四種格子、伏筆的幾樣記號。 */
function legend(): HTMLElement {
  const box = el('span', 'tov-legend');
  const item = (mark: HTMLElement, text: string): void => {
    const span = el('span', 'tov-legend-item');
    span.append(mark, el('span', undefined, text));
    box.appendChild(span);
  };
  item(lineMark('plan'), '只有計劃');
  item(lineMark('actual'), '只有實際');
  item(lineMark('both'), '計劃也發生了');
  item(lineMark('dev'), '計劃了、同步了卻沒發生');
  box.appendChild(el('span', 'tov-legend-sep', '·'));
  item(foreMark('埋', false), '埋');
  item(foreMark('收', false), '收');
  item(foreMark('棄', false), '棄');
  const dashed = el('span', 'tov-legend-dash');
  item(dashed, '沒收（到回收章）');
  return box;
}

type LineMarkKind = 'plan' | 'actual' | 'both' | 'dev';

/** 線的格子：○ 只有計劃、● 只有實際、◉ 計劃也發生了、紅圈偏差。借流水線條的 `pstage-mark`。 */
function lineMark(kind: LineMarkKind): HTMLElement {
  const filled = kind === 'actual' || kind === 'both';
  const mark = el('span', `pstage-mark tov-mark tov-mark-${kind}${filled ? ' done' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function lineMarkKind(cell: ThreadsOverviewCell): LineMarkKind {
  if (cell.deviation) {
    return 'dev';
  }
  if (cell.actual.length === 0) {
    return 'plan';
  }
  return cell.planned.length > 0 ? 'both' : 'actual';
}

/** 伏筆的記號：埋 ●、收 ◆、棄 ✕；計劃的（還沒發生的）畫空心 ○ / ◇。 */
function foreMark(type: '埋' | '收' | '棄', planned: boolean): HTMLElement {
  if (type === '棄') {
    const mark = el('span', 'tov-fmark tov-fmark-drop', '✕');
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  const shape = type === '埋' ? `pstage-mark tov-fmark tov-fmark-plant${planned ? '' : ' done'}` : 'tov-fmark tov-fmark-resolve';
  const mark = el('span', `${shape}${planned ? ' tov-fmark-plan' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/** 一格伏筆畫哪個記號：實際的先（棄 → 收 → 埋），沒有實際的畫計劃的（收 → 埋）。 */
function foreMarkOf(cell: ThreadsOverviewCell): HTMLElement {
  const actual = new Set(cell.actual.map((e) => e.type));
  const planned = new Set(cell.planned.map((e) => e.type));
  const type: '埋' | '收' | '棄' = actual.has('弃')
    ? '棄'
    : actual.has('收')
      ? '收'
      : actual.has('埋')
        ? '埋'
        : planned.has('收') || planned.has('弃')
          ? '收'
          : '埋';
  const mark = foreMark(type, actual.size === 0);
  if (cell.deviation) {
    mark.classList.add('tov-mark-dev');
  }
  return mark;
}

// ---------------------------------------------------------------- 畫

function render(): void {
  const v = ensureView();
  hideTip();
  v.scroll.replaceChildren();
  if (!data) {
    v.meta.textContent = '';
    showNote(document.body.classList.contains('no-workspace') ? NO_WORKSPACE : '正在讀取敘事線…');
    return;
  }
  if (!data.initialized) {
    v.meta.textContent = '';
    showNote('這個目錄還不是小說工程（沒有工程後設資料目錄），沒有敘事線。');
    return;
  }
  const lineCount = data.groups.reduce((n, g) => n + g.lines.length, 0);
  const foreCount =
    data.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.foreshadowing.length, 0), 0) +
    (data.unfiled?.foreshadowing.length ?? 0);
  v.meta.textContent = [
    data.current > 0 ? `同步到第 ${data.current} 章` : '還沒有同步的章',
    // 四期：敘事線落後於定稿時另說一句（定稿了還沒判的那幾列列頭另一種樣子，計劃不算偏差）。
    data.current > 0 && data.through < data.current ? (data.through > 0 ? `敘事線判到第 ${data.through} 章` : '敘事線還沒判過') : '',
    `${lineCount} 條線`,
    foreCount > 0 ? `${foreCount} 條伏筆` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (lineCount === 0 && !data.unfiled) {
    showNote(
      '還沒有敘事線。到工程頁「敘事線」頁籤點「從大綱排出」，從情節大綱排出主線、支線、感情線、人物線；同步時也會從正文裡認出新的線。'
    );
    return;
  }
  const notes: string[] = [];
  if (data.chapters.length === 0) {
    notes.push('還沒有章節：排出細綱、寫了正文之後，這裡按章畫出每條線走到哪。');
  }
  if (data.clippedFrom !== undefined) {
    notes.push(
      `計劃裡提到了第 ${data.clippedFrom} 章，太遠了，只畫到第 ${data.chapters.length} 章（多半是哪一處章號寫錯了：線的 plan、伏筆的回收章或某條事件）。`
    );
  }
  showNote(notes.join(''));
  v.scroll.appendChild(buildGrid(data));
  applyFocus();
}

function showNote(text: string): void {
  if (!view) {
    return;
  }
  view.note.textContent = text;
  setHidden(view.note, !text);
}

function buildGrid(d: ThreadsOverview): HTMLElement {
  const cols = d.chapters.length;
  nameWidth = currentNameWidth();
  view?.scroll.style.setProperty('--tov-name', `${nameWidth}px`);
  const grid = el('div', 'tov-grid');
  grid.style.width = `${nameWidth + cols * CELL}px`;
  grid.appendChild(buildHeader(d));
  for (const group of d.groups) {
    grid.appendChild(groupRow(traditionalLabel(group.kind), `${group.lines.length} 條`));
    for (const line of group.lines) {
      grid.appendChild(lineRow(line, cols));
      for (const f of line.foreshadowing) {
        grid.appendChild(foreRow(f, line.relPath, cols, d));
      }
    }
  }
  if (d.unfiled) {
    const head = groupRow('未歸屬的伏筆', `${d.unfiled.foreshadowing.length} 條`, d.unfiled.relPath);
    grid.appendChild(head);
    for (const f of d.unfiled.foreshadowing) {
      grid.appendChild(foreRow(f, d.unfiled.relPath, cols, d));
    }
  }
  // 「定稿到第 N 章」：一條豎線畫在第 N 章右邊。
  if (d.current > 0 && d.current <= cols) {
    const now = el('div', 'tov-now');
    now.style.left = `${nameWidth + d.current * CELL}px`;
    now.title = `同步到第 ${d.current} 章`;
    grid.appendChild(now);
  }
  // 「敘事線判到第 M 章」（四期）：落後於定稿時另一條虛線，畫在第 M 章右邊（一章都沒判過就不畫，表頭上說了）。
  if (d.through > 0 && d.through < d.current && d.through <= cols) {
    const judged = el('div', 'tov-judged');
    judged.style.left = `${nameWidth + d.through * CELL}px`;
    judged.title = `敘事線判到第 ${d.through} 章（從第 1 章起連續判過的）；右邊同步了還沒判的章，計劃不算偏差`;
    grid.appendChild(judged);
  }
  return grid;
}

/** 表頭：左上角一格，右邊一行卷名（分卷的書）、一行章號。 */
function buildHeader(d: ThreadsOverview): HTMLElement {
  const head = el('div', 'tov-header');
  const corner = el('div', 'tov-corner', '敘事線 ＼ 章');
  corner.title = [
    d.current > 0 ? `綠線：同步到第 ${d.current} 章` : '還沒有同步的章',
    d.through > 0 && d.through < d.current ? `虛線：敘事線判到第 ${d.through} 章` : '',
  ]
    .filter(Boolean)
    .join('\n');
  head.appendChild(corner);
  const cols = el('div', 'tov-cols');
  cols.style.width = `${d.chapters.length * CELL}px`;
  if (d.volumes) {
    const row = el('div', 'tov-vols');
    let start = 0;
    for (let i = 1; i <= d.chapters.length; i++) {
      if (i === d.chapters.length || d.chapters[i].volume !== d.chapters[start].volume) {
        const name = d.chapters[start].volume;
        const vol = el('div', `tov-vol${name ? '' : ' tov-vol-root'}`, name);
        vol.style.left = `${start * CELL}px`;
        vol.style.width = `${(i - start) * CELL}px`;
        vol.title = name ? `${name}：第 ${d.chapters[start].no}–${d.chapters[i - 1].no} 章` : '';
        row.appendChild(vol);
        start = i;
      }
    }
    cols.appendChild(row);
    head.classList.add('tov-header-vols');
  }
  const nums = el('div', 'tov-nums');
  for (const c of d.chapters) {
    const col = el(
      'div',
      `tov-col tov-col-${c.state}${c.unjudged ? ' tov-col-unjudged' : ''}${c.no === d.current ? ' tov-col-now' : ''}${c.no >= 1000 ? ' tov-col-wide' : ''}`,
      String(c.no)
    );
    col.style.left = `${(c.no - 1) * CELL}px`;
    col.dataset.ch = String(c.no);
    col.title = chapterTitle(c);
    nums.appendChild(col);
  }
  cols.appendChild(nums);
  head.appendChild(cols);
  return head;
}

function chapterTitle(c: ThreadsOverviewChapter): string {
  const name = `第 ${c.no} 章${c.title ? `《${c.title}》` : ''}${c.time ? ` · ${c.time}` : ''}`;
  const where = c.volume ? ` · ${c.volume}` : '';
  const open = c.chapterPath ? '點選開啟正文' : c.plotPath ? '點選開啟細綱' : '';
  const judged = c.unjudged ? '，敘事線還沒判（這一章的計劃不算偏差）' : '';
  return `${name}${where} · ${STATE_LABEL[c.state]}${judged}${open ? `\n${open}` : ''}`;
}

function rowShell(cls: string, cols: number): { row: HTMLElement; name: HTMLElement; track: HTMLElement } {
  const row = el('div', `tov-row ${cls}`);
  const name = el('div', 'tov-name');
  const track = el('div', 'tov-track');
  track.style.width = `${cols * CELL}px`;
  row.append(name, track);
  return { row, name, track };
}

/** 種類那一行（「主線 · 1 條」），「未歸屬的伏筆」那一行也是它（帶路徑，點名字開啟那份檔案）。 */
function groupRow(label: string, count: string, relPath?: string): HTMLElement {
  const row = el('div', 'tov-row tov-row-group');
  const name = el('div', 'tov-name');
  if (relPath) {
    const link = el('span', 'tov-link', label);
    link.dataset.path = relPath;
    link.title = `${relPath}\n掛不上哪一條線的伏筆。點選開啟這份檔案；把一行伏筆連同它的事件剪到某條線的檔案裡，就是掛上了。`;
    name.appendChild(link);
    row.dataset.path = relPath;
  } else {
    name.appendChild(el('span', 'tov-group-name', label));
  }
  name.appendChild(el('span', 'tov-count', count));
  row.appendChild(name);
  return row;
}

function lineRow(line: ThreadsOverviewLine, cols: number): HTMLElement {
  const closed = line.status === '已收束' || line.status === '已放弃';
  const { row, name, track } = rowShell(`tov-row-line${closed ? ' tov-row-closed' : ''}`, cols);
  row.dataset.path = line.relPath;
  const dot = el('span', 'tov-dot', STATUS_DOT[line.status]);
  dot.title = line.status;
  name.appendChild(dot);
  const link = el('span', 'tov-link', line.name);
  link.dataset.path = line.relPath;
  link.title = [line.detail, ...line.warnings.map((w) => `⚠ ${w}`), line.tip, `${line.relPath}\n點選開啟這條線的檔案`]
    .filter(Boolean)
    .join('\n');
  name.appendChild(link);
  if (line.warnings.length > 0) {
    const warn = el('span', 'tov-warn', '⚠');
    warn.title = line.warnings.join('\n');
    name.appendChild(warn);
  }

  // 計劃區間：一條淡底（只寫了開頭的延到最後一列，只寫了收束章的從第 1 章起）。
  if (line.from !== undefined || line.to !== undefined) {
    const from = Math.max(1, line.from ?? 1);
    const to = Math.min(cols, line.to ?? cols);
    if (from <= to) {
      const band = el('div', 'tov-band');
      band.style.left = `${(from - 1) * CELL}px`;
      band.style.width = `${(to - from + 1) * CELL}px`;
      band.title = line.from !== undefined && line.to !== undefined
        ? `計劃第 ${line.from}–${line.to} 章`
        : line.from !== undefined
          ? `計劃第 ${line.from} 章起`
          : `計劃第 ${line.to} 章收`;
      track.appendChild(band);
    }
  }
  for (const cell of line.cells) {
    track.appendChild(cellEl(cell, line.name, lineMark(lineMarkKind(cell))));
  }
  return row;
}

function foreRow(f: ThreadsOverviewForeshadow, relPath: string, cols: number, d: ThreadsOverview): HTMLElement {
  const closed = f.status === '已收' || f.status === '已弃';
  const { row, name, track } = rowShell(
    `tov-row-fore${closed ? ' tov-row-closed' : ''}${f.overdue ? ' tov-row-overdue' : ''}`,
    cols
  );
  const link = el('span', 'tov-link', f.name);
  link.dataset.path = relPath;
  link.title = [f.tip, '點選開啟它所在的檔案'].filter(Boolean).join('\n');
  name.appendChild(link);
  if (f.overdue) {
    const warn = el('span', 'tov-warn', '⚠');
    warn.title = `過了第 ${f.resolveBy ?? f.resolve} 章還沒收（逾期）`;
    name.appendChild(warn);
  }

  if (f.span) {
    const span = el('div', `tov-span tov-span-${f.span.kind}${f.overdue ? ' tov-overdue' : ''}`);
    span.style.left = `${(f.span.from - 1) * CELL + CELL / 2}px`;
    span.style.width = `${(f.span.to - f.span.from) * CELL}px`;
    span.title =
      f.span.kind === 'done'
        ? `第 ${f.span.from}–${f.span.to} 章`
        : f.span.kind === 'open'
          ? `第 ${f.span.from} 章埋下，還沒收${(f.resolveBy ?? f.resolve) !== undefined ? `（計劃第 ${f.resolveBy ?? f.resolve} 章前收）` : ''}`
          : `計劃第 ${f.span.from} 章埋、第 ${f.span.to} 章前收`;
    track.appendChild(span);
  }
  // 回收章（伏筆那一行寫的）：沒收的伏筆在它那一格畫一道豎線（逾期的標紅）。推遲過的另說推遲到哪，虛線越過豎線。
  if (!closed && f.resolve !== undefined && f.resolve <= cols) {
    const due = el('div', `tov-due${f.overdue ? ' tov-overdue' : ''}`);
    due.style.left = `${(f.resolve - 1) * CELL + CELL / 2}px`;
    const deferred = f.resolveBy !== undefined && f.resolveBy !== f.resolve ? `，推遲到第 ${f.resolveBy} 章` : '';
    due.title = `計劃第 ${f.resolve} 章前收${deferred}${f.overdue ? `——敘事線判到第 ${d.through} 章，逾期` : ''}`;
    track.appendChild(due);
  }
  for (const cell of f.cells) {
    track.appendChild(cellEl(cell, f.name, foreMarkOf(cell)));
  }
  return row;
}

function cellEl(cell: ThreadsOverviewCell, rowName: string, mark: HTMLElement): HTMLElement {
  const node = el('span', `tov-cell${cell.deviation ? ' tov-cell-dev' : ''}`);
  node.style.left = `${(cell.chapter - 1) * CELL}px`;
  node.dataset.ch = String(cell.chapter);
  node.appendChild(mark);
  cellInfo.set(node, { row: rowName, cell });
  return node;
}

// ---------------------------------------------------------------- 定位

/** 定位到的那一行標出來；剛定位、還沒滾過的滾過去（滾一次）。 */
function applyFocus(): void {
  if (!view || !focused) {
    return;
  }
  let target: HTMLElement | undefined;
  for (const row of view.scroll.querySelectorAll<HTMLElement>('.tov-row')) {
    const hit = row.dataset.path === focused;
    row.classList.toggle('tov-focus', hit);
    if (hit && !target) {
      target = row;
    }
  }
  if (target && scrollPending) {
    scrollPending = false;
    const header = view.scroll.querySelector<HTMLElement>('.tov-header');
    view.scroll.scrollTop = Math.max(0, target.offsetTop - (header?.offsetHeight ?? 0) - 4);
  }
}

// ---------------------------------------------------------------- 互動

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const link = target?.closest<HTMLElement>('.tov-link');
  if (link?.dataset.path) {
    // 開啟那份檔案，開在總覽所在的這一塊（正常標籤：作者明說要看它）。
    post({ type: 'openEditor', path: link.dataset.path, pane: host?.id ?? 'main' });
    return;
  }
  const chapter = target?.closest<HTMLElement>('.tov-cell, .tov-col');
  // 手指點一格：看這一格本身（彈浮窗），不跳去開啟正文；開啟在長按選單裡。點別處收起。
  if (isTouchEvent(e)) {
    const info = chapter && cellInfo.get(chapter);
    if (info) {
      showTip(chapter, info);
    } else if (chapter?.classList.contains('tov-col') && chapter.title) {
      showColumnTip(chapter);
    } else {
      hideTip();
    }
    return;
  }
  if (chapter?.dataset.ch) {
    openChapter(Number(chapter.dataset.ch));
  }
}

/** 手指點列頭：浮窗裡寫這一章的說明（滑鼠懸停時是原生提示 `title`，手指看不到）。 */
function showColumnTip(col: HTMLElement): void {
  if (!view) {
    return;
  }
  const tip = view.tip;
  const [head, ...rest] = col.title.split('\n');
  tip.replaceChildren(el('div', 'tov-tip-head', head));
  for (const line of rest) {
    // 「點選開啟正文」那一行是滑鼠的說法；手指點了只看，開啟在長按選單裡。
    tip.appendChild(el('div', 'tov-tip-row-name', line.startsWith('點選') ? '長按開啟這一章' : line));
  }
  placeTipBox(col);
}

/** 開啟那一章：正文進主區、細綱並排（`openChapter`，同工程頁點章節行）；還沒寫的開啟細綱。 */
function openChapter(no: number): void {
  const c = data?.chapters[no - 1];
  const path = c?.chapterPath ?? c?.plotPath;
  if (!path) {
    toast(`第 ${no} 章還沒有細綱，也沒有正文。`);
    return;
  }
  post(openChapterMessage(path));
}

function onOver(e: MouseEvent): void {
  // 手指點一下之後補發的相容滑鼠事件不是懸停（手指的浮窗走 onClick）。
  if (lastPointerWasTouch()) {
    return;
  }
  const node = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tov-cell');
  if (!node) {
    return;
  }
  const info = cellInfo.get(node);
  if (info) {
    showTip(node, info);
  }
}

function onOut(e: MouseEvent): void {
  if (lastPointerWasTouch()) {
    return;
  }
  const from = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tov-cell');
  const to = (e.relatedTarget as HTMLElement | null)?.closest?.('.tov-cell');
  if (from && from !== to) {
    hideTip();
  }
}

/** 懸停一格：第幾章、哪一行、計劃的與實際的事件（帶證據）、偏差說一句。 */
function showTip(node: HTMLElement, info: CellInfo): void {
  if (!view) {
    return;
  }
  const tip = view.tip;
  tip.replaceChildren();
  const c = data?.chapters[info.cell.chapter - 1];
  const head = c
    ? `第 ${c.no} 章${c.title ? `《${c.title}》` : ''} · ${STATE_LABEL[c.state]}${c.time ? ` · ${c.time}` : ''}`
    : `第 ${info.cell.chapter} 章`;
  tip.appendChild(el('div', 'tov-tip-head', head));
  tip.appendChild(el('div', 'tov-tip-row-name', info.row));
  for (const e of info.cell.planned) {
    tip.appendChild(eventLine(e, true));
  }
  for (const e of info.cell.actual) {
    tip.appendChild(eventLine(e, false));
  }
  if (info.cell.deviation) {
    tip.appendChild(el('div', 'tov-tip-dev', '⚠ 計劃了，這一章也同步了，卻沒有發生'));
  }
  placeTipBox(node);
}

/** 露出浮窗、貼著那一格擺：下面放不下翻上去，橫向夾進視口。 */
function placeTipBox(node: HTMLElement): void {
  if (!view) {
    return;
  }
  const tip = view.tip;
  setHidden(tip, false);
  const rect = node.getBoundingClientRect();
  const width = tip.offsetWidth || 280;
  const height = tip.offsetHeight || 0;
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const top = height > 0 && below + height > window.innerHeight - 4 ? Math.max(4, rect.top - height - 4) : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function eventLine(e: ThreadsOverviewEvent, planned: boolean): HTMLElement {
  const line = el('div', `tov-tip-ev${planned ? ' tov-tip-plan' : ''}`);
  const label = `${planned ? '計劃 · ' : ''}${traditionalLabel(e.type)}${e.foreshadowing ? `〈${e.foreshadowing}〉` : ''}：`;
  line.appendChild(el('span', 'tov-tip-type', label));
  line.appendChild(el('span', undefined, e.what));
  if (e.evidence) {
    line.appendChild(el('div', 'tov-tip-evidence', `「${e.evidence}」`));
  }
  return line;
}

function hideTip(): void {
  if (view) {
    setHidden(view.tip, true);
  }
}
