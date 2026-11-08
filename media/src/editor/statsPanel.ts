/**
 * 碼字統計面板（獨立版內建編輯器）：點狀態列字數那一格彈出來的小面板——本章字數與目標、本次碼字（字數、時長、
 * 速度）、今日碼字、本次按檔案的明細，以及「重新開始計時」。資料由 `stats.ts` 現算現給（`data()`），這裡只管畫、
 * 開、關。
 *
 * - **不是遮罩**：掛在 `body` 上、`position: fixed`，貼著點開它的那一格往上彈（狀態列在編輯區底邊）。點面板外面
 *   （捕獲階段的 `mousedown`）、按 Esc、再點一下那一格都收起；正文照樣能接著打字——開著時碼字數跟著跳。
 * - **同一時刻只有一個**：從另一塊編輯區的狀態列點開，換成那一塊的當前檔案。
 * - 使用者內容（檔名、章節標題）一律 `textContent`，不拼 HTML。
 */
import { el, setHidden } from '../dom';
import type { FileTally, GoalProgress } from './writingStats';
import { IDLE_MS, formatDuration, signedWords, speedPerHour } from './writingStats';
import { groupDigits } from './words';

export interface StatsPanelData {
  /** 點開它的那一塊編輯區的當前檔案。沒開檔案時 undefined。 */
  file?: {
    title: string;
    path: string;
    words: number;
    chars: number;
    /** 是某一章的正文、且有目標字數。 */
    goal?: GoalProgress;
    /** 是某一章的正文、卻沒有目標時說一句為什麼。 */
    goalNote?: string;
    /** 字數不算開頭的 `# 標題` 那一行（章節，與工程頁同一個數法）。 */
    headingExcluded: boolean;
  };
  session: { startedAt: number; words: number; ms: number; files: FileTally[] };
  today: { words: number; ms: number; persisted: boolean };
}

interface Open {
  panel: HTMLElement;
  anchor: HTMLElement;
  data: () => StatsPanelData;
  onRestart: () => void;
}

let open: Open | undefined;

/** 開著沒有、是不是從這一格點開的。 */
export function statsPanelAnchor(): HTMLElement | undefined {
  return open?.anchor;
}

/** 點那一格：開著（且是這一格開的）就收起，否則開 / 換成這一格的。 */
export function toggleStatsPanel(anchor: HTMLElement, data: () => StatsPanelData, onRestart: () => void): void {
  if (open?.anchor === anchor) {
    closeStatsPanel();
    return;
  }
  closeStatsPanel();
  const panel = el('div', 'ed-stats-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '碼字統計');
  document.body.appendChild(panel);
  open = { panel, anchor, data, onRestart };
  anchor.setAttribute('aria-expanded', 'true');
  render();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
}

export function closeStatsPanel(): void {
  if (!open) {
    return;
  }
  open.panel.remove();
  open.anchor.setAttribute('aria-expanded', 'false');
  open = undefined;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
}

/** 數變了（打字、章節索引更新、別的視窗記了今日碼字）：開著就重畫。 */
export function refreshStatsPanel(): void {
  if (open) {
    render();
  }
}

function onOutside(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!open || (target && (open.panel.contains(target) || open.anchor.contains(target)))) {
    return;
  }
  closeStatsPanel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open) {
    e.stopPropagation();
    closeStatsPanel();
  }
}

function render(): void {
  if (!open) {
    return;
  }
  const d = open.data();
  const restart = el('button', 'chip-btn ed-stats-restart', '重新開始計時');
  restart.type = 'button';
  restart.title = '「本次碼字」的字數與時長從現在起重新算；今日碼字不受影響。';
  restart.addEventListener('click', () => open?.onRestart());

  const foot = el('div', 'ed-stats-foot');
  foot.append(
    el(
      'div',
      'ed-stats-rule',
      `只算親手打的字（輸入法上屏算，退格刪掉的倒扣）；貼上、一鍵排版、替換、合併、恢復歷史版本、磁碟同步不算，` +
        `撤銷 / 重做跟著那一步走。停筆超過 ${IDLE_MS / 60_000} 分鐘的那段不計時。`
    ),
    restart
  );

  open.panel.replaceChildren(fileSection(d), sessionSection(d), todaySection(d), filesSection(d), foot);
  place();
}

function section(cls: string, head: string, aside?: string): HTMLElement {
  const sec = el('div', `ed-stats-sec ${cls}`);
  const h = el('div', 'ed-stats-head', head);
  if (aside) {
    h.appendChild(el('span', 'ed-stats-aside', aside));
  }
  sec.appendChild(h);
  return sec;
}

function fileSection(d: StatsPanelData): HTMLElement {
  const f = d.file;
  if (!f) {
    const sec = section('ed-stats-file', '當前檔案');
    sec.appendChild(el('div', 'ed-stats-note', '沒有開啟的檔案'));
    return sec;
  }
  const chapter = !!f.goal || !!f.goalNote;
  const sec = section('ed-stats-file', chapter ? '本章' : '當前檔案');
  const title = el('div', 'ed-stats-title', f.title);
  title.title = f.path;
  sec.appendChild(title);
  sec.appendChild(el('div', 'ed-stats-big', f.goal ? `${f.goal.count}，${f.goal.rest}` : `${groupDigits(f.words)} 字`));
  const bar = el('div', 'ed-stats-bar');
  const fill = el('div', 'ed-stats-fill');
  bar.appendChild(fill);
  setHidden(bar, !f.goal);
  if (f.goal) {
    fill.style.width = `${Math.min(100, Math.round(f.goal.ratio * 100))}%`;
    bar.classList.toggle('enough', f.goal.enough);
    bar.classList.toggle('over', f.goal.over);
  }
  sec.appendChild(bar);
  const notes = [f.goalNote, `${groupDigits(f.chars)} 字元（含標點與空白）`];
  if (f.headingExcluded) {
    notes.push('開頭的「# 標題」那一行不算字數，與工程頁同一個數法');
  }
  for (const note of notes) {
    if (note) {
      sec.appendChild(el('div', 'ed-stats-note', note));
    }
  }
  return sec;
}

function sessionSection(d: StatsPanelData): HTMLElement {
  const s = d.session;
  const sec = section('ed-stats-session', '本次碼字', `從 ${clock(s.startedAt)} 起`);
  sec.appendChild(el('div', 'ed-stats-big', `${signedWords(s.words)} 字`));
  sec.appendChild(el('div', 'ed-stats-line', `寫了 ${formatDuration(s.ms)} · ${speedText(s.words, s.ms)}`));
  return sec;
}

function todaySection(d: StatsPanelData): HTMLElement {
  const t = d.today;
  const sec = section('ed-stats-today', '今日碼字', t.persisted ? '這個工程，重新整理、幾個視窗都累計' : undefined);
  sec.appendChild(el('div', 'ed-stats-big', `${groupDigits(t.words)} 字`));
  sec.appendChild(el('div', 'ed-stats-line', `寫了 ${formatDuration(t.ms)} · ${speedText(t.words, t.ms)}`));
  if (!t.persisted) {
    sec.appendChild(el('div', 'ed-stats-note', '這個瀏覽器記不下來（或者還沒開啟工程），只算這一頁。'));
  }
  return sec;
}

function filesSection(d: StatsPanelData): HTMLElement {
  const sec = section('ed-stats-files', '本次按檔案');
  const files = d.session.files;
  if (files.length === 0) {
    sec.appendChild(el('div', 'ed-stats-note', '還沒有動筆。'));
    return sec;
  }
  const list = el('div', 'ed-stats-list');
  for (const f of files) {
    const row = el('div', 'ed-stats-row');
    row.title = f.path;
    row.append(
      el('span', 'ed-stats-row-name', f.title || f.path),
      el('span', 'ed-stats-row-words', `${signedWords(f.words)} 字`),
      el('span', 'ed-stats-row-time', formatDuration(f.ms))
    );
    list.appendChild(row);
  }
  sec.appendChild(list);
  return sec;
}

function speedText(words: number, ms: number): string {
  const speed = speedPerHour(words, ms);
  return speed === undefined ? '寫夠 1 分鐘才算速度' : `每小時約 ${groupDigits(speed)} 字`;
}

/** 貼著那一格往上彈，左右夾進視口。 */
function place(): void {
  if (!open) {
    return;
  }
  const rect = open.anchor.getBoundingClientRect();
  const width = open.panel.offsetWidth || 320;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  open.panel.style.left = `${Math.round(left)}px`;
  open.panel.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 6))}px`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
