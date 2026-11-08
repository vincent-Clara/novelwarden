/**
 * 碼字統計（獨立版內建編輯器，階段四）的裝配：狀態列字數那一格、本次碼字、今日碼字、「檢視 → 統計」那一組的
 * 編輯器一半。口徑在 `writingStats.ts`（純函式），「今日」怎麼存在 `statsDaily.ts`，面板在 `statsPanel.ts`。
 *
 * ## 狀態列字數那一格
 *
 * 每塊編輯區一格（`#edStatusWords` 與草稿區那一格），`pane.ts` 的 `updateStatus` 調 {@link renderWordStatus}，
 * 別的都是這裡自己掛上的：
 *
 * - 全文：「全文 3,120 字」；有選區時前面加「選中 120 字 / 」（口徑同 `countWords`）。
 * - 距目標（預設開）：當前標籤是某一章的**正文**、章節索引裡這一章有 `targetWords`（細綱的目標字數，沒寫就是
 *   `config.md` 的每章字數——與寫正文時判「寫夠沒有」的是同一個數，後端 `views/pipeline.ts` 算）時，換成
 *   「3,120 / 4,000 字，還差 880」（超了寫「超出 120」）＋一條細進度條，到八成換色。字數用編輯區裡的當前內容
 *   實時算、不等儲存；細綱、草稿、角色卡不顯示目標；沒寫目標、索引裡還沒有這一章也不顯示。
 * - 本次碼字 / 今日碼字（預設關）：「· 本次 +356 字」「· 今日 1,820 字」。
 * - 章節（Markdown）開頭的「# 標題」那一行不算字數——後端數章節字數就是這麼數的（`countWords(stripH1(body))`），
 *   狀態列與工程頁、章節條才對得上。
 * - 點一下（或獲得焦點時回車 / 空格）彈出碼字統計面板。按下滑鼠不奪編輯區的焦點。
 *
 * ## 大章節不卡
 *
 * 每敲一下都可能要數一遍全文。做法：
 * 1. `countWords` 一趟迴圈數完（`words.ts`），不造中間字串與陣列。
 * 2. 每份檔案快取「數過的是哪一份文字、幾個字」。打字、上屏、貼上、程式改寫都帶著這一處改動（`change`），
 *    核對快取的正是改動之前那一份，就只數改動那一段（`wordDelta`，英文按詞往兩邊擴到詞邊界）——幾萬字的章節
 *    每敲一下也只數幾個字。
 * 3. 沒有改動可用（撤銷 / 重做、輸入法組字中途）時整份重數：兩萬字以內當場數，更長的至多每 300ms 數一次
 *    （其間先顯示上一次的數）。
 * 4. 選中字數只數選中的那一段，按（文字、起止）記住，游標挪動不重數。
 * 5. 本次 / 今日碼字只看改動那一段，與全文多長無關。
 */
import { el, setHidden } from '../dom';
import { toast } from '../globals';
import { onEditorChange } from './api';
import type { EditSource } from './api';
import { chapterAt, onChapterIndex } from './chapterIndex';
import type { EditHistory, TextChange } from './history';
import type { OpenFile } from './paneElements';
import { PREFS_KEY, storedPrefs } from './paragraphState';
import { flushDaily, installDaily, onDailyChange, recordDaily, todayTally } from './statsDaily';
import { closeStatsPanel, refreshStatsPanel, toggleStatsPanel } from './statsPanel';
import type { StatsPanelData } from './statsPanel';
import type { Pane } from './store';
import {
  StepLedger,
  WritingSession,
  countsAsWriting,
  goalProgress,
  headingWords,
  isWritingActivity,
  signedWords,
  wordDelta,
} from './writingStats';
import type { GoalProgress } from './writingStats';
import { countWords, groupDigits } from './words';

/** 這麼長以內的文字沒有改動可用時當場整份重數；更長的節流。 */
export const SYNC_COUNT_LIMIT = 20_000;
/** 長文字整份重數至多這麼久一次。 */
export const RECOUNT_MS = 300;
/** 與 core 的 `isMarkdownExt` 同一組副檔名：只有這些章節認開頭的 `# 標題`。 */
const MARKDOWN_RE = /\.(md|markdown)$/i;

// ---------------------------------------------------------------- 偏好

/** 狀態列字數那一格除了全文 / 選中還顯示哪幾項。按瀏覽器記在 `novelforge.editor.prefs` 的 `stats` 裡。 */
interface StatsPrefs {
  goal: boolean;
  session: boolean;
  today: boolean;
}

let prefs: StatsPrefs = loadPrefs();

function loadPrefs(): StatsPrefs {
  const raw = storedPrefs().stats as Partial<StatsPrefs> | undefined;
  const s = raw && typeof raw === 'object' ? raw : {};
  // 距目標預設開（只認明明白白的 false）；本次 / 今日預設關（只認明明白白的 true）。
  return { goal: s.goal !== false, session: s.session === true, today: s.today === true };
}

function setPref(key: keyof StatsPrefs, on: boolean): void {
  prefs = { ...prefs, [key]: on };
  try {
    // 同一個鍵裡還有段落那幾項（`paragraphState.ts`）：讀出來合上再寫。
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...storedPrefs(), stats: prefs }));
  } catch {
    /* 不可寫就只在記憶體裡生效 */
  }
  refreshCells();
}

// ---------------------------------------------------------------- 全文字數（帶快取）

interface WordCache {
  /** 數過的是哪一份文字。 */
  text: string;
  words: number;
  /** 上一次整份重數的時刻（節流用）。 */
  countedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const wordCache = new WeakMap<OpenFile, WordCache>();

/** 這份檔案（編輯區裡的當前內容）一共幾個字。 */
function textWords(file: OpenFile): number {
  const cache = wordCache.get(file);
  if (cache && cache.text === file.draft) {
    return cache.words;
  }
  if (!cache || file.draft.length <= SYNC_COUNT_LIMIT) {
    return recount(file);
  }
  scheduleRecount(file, cache);
  return cache.words;
}

function recount(file: OpenFile): number {
  const words = countWords(file.draft);
  const cache = wordCache.get(file);
  if (cache) {
    clearTimeout(cache.timer);
    Object.assign(cache, { text: file.draft, words, countedAt: Date.now(), timer: undefined });
  } else {
    wordCache.set(file, { text: file.draft, words, countedAt: Date.now() });
  }
  return words;
}

function scheduleRecount(file: OpenFile, cache: WordCache): void {
  if (cache.timer !== undefined) {
    return;
  }
  const wait = Math.max(0, cache.countedAt + RECOUNT_MS - Date.now());
  cache.timer = setTimeout(() => {
    cache.timer = undefined;
    if (cache.text !== file.draft) {
      recount(file);
      refreshCells();
      refreshStatsPanel();
    }
  }, wait);
}

/** 內容變了（`edit` 事件）：帶著改動、快取又正是改動之前那一份，就只數改動那一段。 */
function syncWordCache(file: OpenFile, change: TextChange | undefined): void {
  const cache = wordCache.get(file);
  if (!cache || cache.text === file.draft) {
    return;
  }
  if (change) {
    const after = file.draft;
    const tail = change.at + change.inserted.length;
    if (
      cache.text.length === after.length - change.inserted.length + change.removed.length &&
      after.slice(0, change.at) + change.removed + after.slice(tail) === cache.text
    ) {
      cache.text = after;
      cache.words += wordDelta(after, change);
      return;
    }
  }
  if (file.draft.length <= SYNC_COUNT_LIMIT) {
    recount(file);
  } else {
    scheduleRecount(file, cache);
  }
}

/** 章節（Markdown）不算開頭的 `# 標題` 那一行——與後端數章節字數同一個數法。 */
function skipsHeading(file: OpenFile): boolean {
  return file.kind === 'chapter' && MARKDOWN_RE.test(file.path);
}

/** 狀態列與面板上說的「全文 N 字」。 */
function fileWords(file: OpenFile): number {
  const words = textWords(file);
  return skipsHeading(file) ? words - headingWords(file.draft) : words;
}

/** 當前標籤是某一章的正文、且這一章有目標字數時的進度。 */
function goalOf(file: OpenFile, words: number): GoalProgress | undefined {
  const at = chapterAt(file.path);
  return at && at.side === 'chapter' ? goalProgress(words, at.entry.targetWords) : undefined;
}

// ---------------------------------------------------------------- 選中字數

const selectionMemo = new WeakMap<Pane, { text: string; start: number; end: number; words: number }>();

function selectionWords(pane: Pane, file: OpenFile): number {
  if (pane.isPreviewing() || pane.activeFile() !== file) {
    return 0;
  }
  const { selectionStart: start, selectionEnd: end, value } = pane.area;
  if (start === end) {
    return 0;
  }
  const memo = selectionMemo.get(pane);
  if (memo && memo.start === start && memo.end === end && memo.text === value) {
    return memo.words;
  }
  const words = countWords(value.slice(start, end));
  selectionMemo.set(pane, { text: value, start, end, words });
  return words;
}

// ---------------------------------------------------------------- 本次碼字

let session = new WritingSession(Date.now());
/** 每份撤銷歷史一本賬：撤銷 / 重做的是哪一步、那一步計入過幾個字。重新開始計時就換一批新的。 */
let ledgers = new WeakMap<EditHistory, StepLedger>();

function ledgerOf(history: EditHistory): StepLedger {
  let ledger = ledgers.get(history);
  if (!ledger) {
    ledger = new StepLedger();
    ledgers.set(history, ledger);
  }
  return ledger;
}

/** 明細上怎麼稱呼這份檔案：章節用章節索引的說法，別的用標籤上的名字。 */
function titleOf(file: OpenFile): string {
  const at = chapterAt(file.path);
  if (at) {
    return at.side === 'plot' ? `${at.entry.label} · 細綱` : at.entry.label;
  }
  if (file.label) {
    return file.label.tag ? `${file.label.tag} · ${file.label.title}` : file.label.title;
  }
  return file.name;
}

/** 一次內容變化：算這一下碼了幾個字、記時長，記進本次與今日。 */
function onEdit(file: OpenFile, source: EditSource, change: TextChange | undefined): void {
  syncWordCache(file, change);
  const now = Date.now();
  const ledger = ledgerOf(file.history);
  let words = 0;
  if (source === 'undo') {
    words = ledger.afterUndo(file.history.topId);
  } else if (source === 'redo') {
    words = ledger.afterRedo(file.history.topId);
  } else {
    words = countsAsWriting(source, change) ? wordDelta(file.draft, change!) : 0;
    ledger.afterEdit(file.history.topId, words);
  }
  const title = titleOf(file);
  const ms = isWritingActivity(source) ? session.touch(file.path, title, now) : 0;
  session.add(file.path, title, words);
  recordDaily(now, words, ms);
}

function restart(quiet = false): void {
  session = new WritingSession(Date.now());
  ledgers = new WeakMap();
  refreshCells();
  refreshStatsPanel();
  if (!quiet) {
    toast('本次碼字從現在起重新算。');
  }
}

// ---------------------------------------------------------------- 狀態列那一格

interface Cell {
  root: HTMLElement;
  sel: HTMLElement;
  total: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  extra: HTMLElement;
}

const cells = new Map<Pane, Cell>();

function cellOf(root: HTMLElement, pane: Pane): Cell {
  const known = cells.get(pane);
  if (known && known.root === root && known.sel.parentNode === root) {
    return known;
  }
  root.classList.add('ed-words');
  root.setAttribute('role', 'button');
  root.setAttribute('aria-expanded', 'false');
  root.tabIndex = 0;
  const cell: Cell = {
    root,
    sel: el('span', 'ed-words-sel'),
    total: el('span', 'ed-words-total'),
    bar: el('span', 'ed-words-bar hidden'),
    fill: el('span', 'ed-words-fill'),
    extra: el('span', 'ed-words-extra'),
  };
  cell.bar.appendChild(cell.fill);
  root.replaceChildren(cell.sel, cell.total, cell.bar, cell.extra);
  if (known?.root !== root) {
    // 按下滑鼠不奪編輯區的焦點（點開面板看一眼，回來接著打字）。
    root.addEventListener('mousedown', (e) => e.preventDefault());
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(root, pane);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel(root, pane);
      }
    });
  }
  cells.set(pane, cell);
  return cell;
}

/**
 * 畫一塊編輯區狀態列上字數那一格（`pane.ts` 的 `updateStatus` 調；沒開檔案時傳 undefined：清空）。
 * 打字、挪游標、換選區都會調到，所以只用快取過的數（見檔案頭「大章節不卡」）。
 */
export function renderWordStatus(root: HTMLElement, pane: Pane, file: OpenFile | undefined): void {
  const cell = cellOf(root, pane);
  if (!file) {
    cell.sel.textContent = '';
    cell.total.textContent = '';
    cell.extra.textContent = '';
    setHidden(cell.bar, true);
    root.title = '';
    return;
  }
  const words = fileWords(file);
  const sel = selectionWords(pane, file);
  const goal = prefs.goal ? goalOf(file, words) : undefined;

  cell.sel.textContent = sel > 0 ? `選中 ${groupDigits(sel)} 字${goal ? ' · ' : ' / '}` : '';
  cell.total.textContent = goal ? `${goal.count}，${goal.rest}` : `全文 ${groupDigits(words)} 字`;
  setHidden(cell.bar, !goal);
  cell.bar.classList.toggle('enough', !!goal?.enough);
  cell.bar.classList.toggle('over', !!goal?.over);
  cell.fill.style.width = goal ? `${Math.min(100, Math.round(goal.ratio * 100))}%` : '0%';

  const extras: string[] = [];
  if (prefs.session) {
    extras.push(`本次 ${signedWords(session.words)} 字`);
  }
  if (prefs.today) {
    extras.push(`今日 ${groupDigits(todayTally(Date.now()).words)} 字`);
  }
  cell.extra.textContent = extras.length ? ` · ${extras.join(' · ')}` : '';

  const tips = [`${groupDigits(file.draft.length)} 字元（含標點與空白）`];
  if (skipsHeading(file)) {
    tips.push('開頭的「# 標題」那一行不算字數，與工程頁同一個數法');
  }
  if (goal) {
    tips.push(`本章目標 ${groupDigits(goal.target)} 字（細綱的目標字數，沒寫就是小說配置的每章字數）`);
  }
  tips.push('點一下看碼字統計（本次、今日、按檔案）');
  root.title = tips.join('\n');
}

/** 兩塊編輯區的那一格都重畫（本次 / 今日碼字是全域的，章節索引變了目標可能變）。 */
function refreshCells(): void {
  for (const [pane, cell] of cells) {
    renderWordStatus(cell.root, pane, pane.activeFile());
  }
}

// ---------------------------------------------------------------- 面板

function togglePanel(root: HTMLElement, pane: Pane): void {
  toggleStatsPanel(root, () => panelData(pane), () => restart());
}

function panelData(pane: Pane): StatsPanelData {
  const file = pane.activeFile();
  const today = todayTally(Date.now());
  let info: StatsPanelData['file'];
  if (file) {
    const words = fileWords(file);
    const at = chapterAt(file.path);
    const chapter = at?.side === 'chapter';
    const goal = chapter ? goalOf(file, words) : undefined;
    info = {
      title: titleOf(file),
      path: file.path,
      words,
      chars: file.draft.length,
      goal,
      goalNote: chapter && !goal ? '這一章沒有目標字數（細綱裡沒寫，小說配置裡也沒寫每章字數）。' : undefined,
      headingExcluded: skipsHeading(file),
    };
  }
  return {
    file: info,
    session: { startedAt: session.startedAt, words: session.words, ms: session.ms, files: session.breakdown() },
    today,
  };
}

// ---------------------------------------------------------------- 裝配

/** 裝一次（`index.ts`）。 */
export function installWritingStats(): void {
  installDaily();

  onEditorChange((ev) => {
    if (ev.type !== 'edit') {
      return;
    }
    onEdit(ev.file, ev.source, ev.change);
    refreshCells();
    refreshStatsPanel();
  });

  onChapterIndex(() => {
    refreshCells();
    refreshStatsPanel();
  });
  // 別的視窗記了今日碼字。
  onDailyChange(() => {
    refreshCells();
    refreshStatsPanel();
  });

  window.addEventListener('nf-files-moved', (e) => {
    if (e.detail.from && e.detail.to) {
      session.rename(e.detail.from, e.detail.to);
    }
  });

  // 換了工程（或關掉了）：還沒寫進去的今日碼字按原來那個工程的鍵寫掉；本次從頭算（明細裡是上一個工程的檔案）。
  window.addEventListener('nf-workspace-reset', () => {
    flushDaily();
    closeStatsPanel();
    restart(true);
  });

  window.addEventListener('nf-stats-query', (e) => {
    e.detail.available = true;
    e.detail.goal = prefs.goal;
    e.detail.session = prefs.session;
    e.detail.today = prefs.today;
  });

  window.addEventListener('nf-stats-command', (e) => {
    switch (e.detail.name) {
      case 'toggleGoal':
        setPref('goal', !prefs.goal);
        break;
      case 'toggleSession':
        setPref('session', !prefs.session);
        break;
      case 'toggleToday':
        setPref('today', !prefs.today);
        break;
      case 'restart':
        restart();
        break;
    }
  });
}
