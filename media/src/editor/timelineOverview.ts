import { traditionalLabel } from '../../../src/core/model/labels';
/**
 * 編輯區「時間線總覽」標籤（2026-10-24，設計稿 docs/design/plans/2026-10-24-timeline-page.md）：豎著按故事裡的日子排，一個日子一行、
 * 那一天開頭的幾章一章一張卡片，作者一眼看出故事裡誰先誰後、隔了多久、這一章在各條線上發生了什麼、哪裡對不上。
 *
 * - **一個不對應檔案的特殊標籤**（同「敘事線總覽」，`store.ts` 的 `SpecialTab`）：掛在這一塊的 `.ed-stage` 上、蓋住正文區，同一時刻只開在
 *   一塊裡（預設主區）。只在獨立版、桌面版有：工程頁先問 `nf-timeline-query` 有沒有人畫得了，外掛形態沒有 editor.js，沒人回答（能力探測）。
 * - **資料按需要**：顯示出來時發 `requestTimelineOverview`，後端回 `timelineOverview`（`core/views/timeline.ts` 的 `buildTimelineMatrix`：
 *   純讀盤、不調模型、日期與對賬現算）；認 requestId（回覆是廣播）。顯示著收到 `state` / `init` 停一下再要一次；藏著只記一筆「過期」。
 * - **畫法**：月份變了插一行（`大衍三年三月 · 春`）；一個日子一行——左邊那一天（大字日子、小字第幾天），中間一條豎軸一個點，右邊卡片；
 *   相鄰兩個日子之間空了 2 天以上插一行「N 天后」（照上一行裡最晚的結尾算；只壓空白、不按比例，⚑2）。卡片：狀態點、章號章名、時段與
 *   比上一章、依據，這一章在各條線上實際發生的事（線名是帶色塊的小標籤，收著時最多 3 條，⚑3），沒有事件時是細綱梗概，對賬報了的紅字；
 *   回憶的章虛線框、縮排（⚑5）。
 * - **互動**：單擊卡片展開 / 收起詳情（同時選中）；右鍵卡片改時間、重推、開啟正文 / 細綱 / 時間線檔案；右鍵標題欄與空白處改曆法與起點、
 *   填為起點、補推、重推、開啟檔案、重新整理（⚑7：設定都在右鍵，標題欄上只有篩選與重新整理）。改時間、重推走工程頁同一個 `projectAction`，後端照舊
 *   先問。篩選「只看有問題的」「線」只在前端，不記住。
 * - **入口**：工程頁「時間線」組標題旁的「總覽」、點一章、點一條帶章號的 ⚠（`nf-timeline-command`，帶 `chapter` 就展開那一張、滾過去）。
 *
 * 使用者內容一律 `textContent`。樣式在 `css/standalone/timeline.css`。
 */
import { el, setHidden } from '../dom';
import { onContextMenu, toast } from '../globals';
import type { MenuItem, TimelineOverviewCommand } from '../globals';
import type { InMessage, OutMessage, ProjectAction, TimelineOverview, TimelineOverviewCard, TimelineOverviewDay, TimelineOverviewEvent } from '../protocol';
import { onMessage } from '../vscodeApi';
import { openChapterMessage } from '../narrow';
import { claimRequest, newRequestId } from './replace';
import { revealEditor } from './shell';
import { panes, paneWithSpecial, registerSpecialTab } from './store';
import type { Pane } from './store';

/** 特殊標籤的 id（記進 localStorage）。 */
export const TIMELINE_OVERVIEW_TAB = 'timeline-overview';

/** 顯示著時收到 `state` 之後停多久再要一次（作者連著存幾次只要一次）。 */
const REFRESH_DELAY_MS = 600;
/** 卡片收著時最多列幾條事件（⚑3）。 */
const CARD_EVENTS = 3;
/** 相鄰兩個日子差幾天起插一行「N 天后」（次日不畫：日子變了一眼看得出）。 */
const GAP_DAYS = 2;

const TITLE = '時間線總覽';
const TAB_TIP = '時間線總覽：豎著按故事裡的日子排，一章一張卡片——哪天、隔了多久、這一章在各條線上發生了什麼、哪裡對不上。現算，不調模型。';
const NO_WORKSPACE = '先開啟一個小說工程，才有時間線總覽。';

/** 狀態點（同工程頁「時間線」組那一行）。 */
const STATE_DOT: Record<TimelineOverviewCard['state'], string> = {
  evidence: '●',
  guess: '○',
  unknown: '?',
  missing: '·',
  anchor: '★',
  dated: '◆',
  flashback: '↺',
  bad: '✕',
};

const STATE_LABEL: Record<TimelineOverviewCard['state'], string> = {
  evidence: '有原文依據',
  guess: '推測的',
  unknown: '推不出',
  missing: '還沒推',
  anchor: '你定的',
  dated: '正文寫明瞭日子',
  flashback: '整章是回憶',
  bad: '那一行認不出',
};

interface View {
  root: HTMLElement;
  meta: HTMLElement;
  problems: HTMLInputElement;
  thread: HTMLSelectElement;
  issues: HTMLElement;
  note: HTMLElement;
  scroll: HTMLElement;
}

let post: (msg: InMessage) => void = () => {};
let view: View | undefined;
/** 顯示在哪一塊。 */
let host: Pane | undefined;
let data: TimelineOverview | undefined;
/** 在路上的那一次請求。 */
let waiting: string | undefined;
/** 拿到這一份之後磁碟上變過（或從沒拿過）：下次顯示時再要。 */
let stale = true;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** 展開著的卡片（章號）；換了資料重畫也展開著。 */
const expanded = new Set<number>();
/** 選中的那一張（最近點過、或從工程頁定位過來的）。 */
let selected: number | undefined;
/** 定位之後還沒滾過去的那一章（資料到了、畫好了才滾，滾一次）。 */
let scrollTo: number | undefined;
/** 篩選：只看有問題的、只看某條線（空串是全部）。 */
let onlyProblems = false;
let threadFilter = '';

// ---------------------------------------------------------------- 裝

export function installTimelineOverview(postMessage: (msg: InMessage) => void): void {
  post = postMessage;
  registerSpecialTab({
    id: TIMELINE_OVERVIEW_TAB,
    label: () => ({ title: TITLE, tip: TAB_TIP }),
    show,
    hide,
    menu: () => [{ label: '重新整理', run: () => request() }],
  });

  // 工程頁問「畫得了嗎」：只有裝了編輯器（獨立版、桌面版）才有人回答（能力探測）。
  window.addEventListener('nf-timeline-query', (e) => {
    e.detail.available = true;
  });
  window.addEventListener('nf-timeline-command', (e) => openOverview(e.detail));

  window.addEventListener('nf-workspace-reset', () => {
    // 標籤由 index.ts 一併關掉；這裡丟掉上一個工程的資料與篩選。
    data = undefined;
    waiting = undefined;
    stale = true;
    expanded.clear();
    selected = undefined;
    scrollTo = undefined;
    onlyProblems = false;
    threadFilter = '';
    clearTimeout(refreshTimer);
    if (view) {
      view.scroll.replaceChildren();
      view.issues.replaceChildren();
    }
  });

  onMessage((msg: OutMessage) => {
    if (msg.type === 'timelineOverview') {
      if (!claimRequest(msg.requestId) || msg.requestId !== waiting) {
        return;
      }
      waiting = undefined;
      data = msg.overview;
      stale = false;
      render();
    } else if (msg.type === 'state' || msg.type === 'init') {
      // 磁碟上可能變過（同步、補推、改時間……）。顯示著就停一下再要一次，藏著就等下次顯示。
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

/** 開啟總覽（已經開著就切過去）；`chapter` 給了就展開那一張、滾過去。 */
function openOverview(cmd: TimelineOverviewCommand | undefined): void {
  if (document.body.classList.contains('no-workspace')) {
    toast(NO_WORKSPACE);
    return;
  }
  const pane = paneWithSpecial(TIMELINE_OVERVIEW_TAB) ?? panes.main;
  if (!pane) {
    return;
  }
  if (cmd?.chapter !== undefined) {
    expanded.add(cmd.chapter);
    selected = cmd.chapter;
    scrollTo = cmd.chapter;
  }
  // 作者點了就是要看現在的樣子：開著也再要一次。
  stale = true;
  pane.openSpecial(TIMELINE_OVERVIEW_TAB);
  if (data) {
    render();
  }
  revealEditor();
}

function visible(): boolean {
  return !!view && !!host && !view.root.classList.contains('hidden') && host.activeSpecial() === TIMELINE_OVERVIEW_TAB;
}

function request(): void {
  if (document.body.classList.contains('no-workspace')) {
    return;
  }
  clearTimeout(refreshTimer);
  waiting = newRequestId('timeline');
  post({ type: 'requestTimelineOverview', requestId: waiting });
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
}

// ---------------------------------------------------------------- DOM

function ensureView(): View {
  if (view) {
    return view;
  }
  const root = el('section', 'tlp hidden');
  root.setAttribute('aria-label', TITLE);
  const head = el('div', 'tlp-head');
  head.appendChild(el('span', 'tlp-title', TITLE));
  const meta = el('span', 'tlp-meta');
  head.appendChild(meta);
  head.appendChild(legend());
  head.appendChild(el('span', 'spacer'));

  const problemsLabel = el('label', 'tlp-filter');
  const problems = el('input');
  problems.type = 'checkbox';
  problems.addEventListener('change', () => {
    onlyProblems = problems.checked;
    render();
  });
  problemsLabel.append(problems, el('span', undefined, '只看有問題的'));
  problemsLabel.title = '只留對賬報了的章，和推不出、認不出、還沒推的章';
  head.appendChild(problemsLabel);

  const thread = el('select', 'tlp-thread');
  thread.title = '只看在這條線上有事發生的章';
  thread.addEventListener('change', () => {
    threadFilter = thread.value;
    render();
  });
  head.appendChild(thread);

  const refresh = el('button', 'chip-btn tlp-refresh', '重新整理');
  refresh.type = 'button';
  refresh.title = '照磁碟上現在的時間線與敘事線重畫（不調模型）';
  refresh.addEventListener('click', () => request());
  head.appendChild(refresh);

  const issues = el('div', 'tlp-issues hidden');
  const note = el('p', 'hint tlp-note hidden');
  const scroll = el('div', 'tlp-scroll');
  root.append(head, issues, note, scroll);

  scroll.addEventListener('click', onClick);
  // 標題欄、對賬、空白處：設定、補推、重推都在這裡（⚑7）。卡片自己登記了，右鍵卡片彈的是卡片那一份。
  onContextMenu(root, pageMenu);
  view = { root, meta, problems, thread, issues, note, scroll };
  return view;
}

/** 圖例：幾種狀態點。 */
function legend(): HTMLElement {
  const box = el('span', 'tlp-legend');
  for (const state of ['evidence', 'guess', 'dated', 'anchor', 'unknown', 'flashback'] as const) {
    const item = el('span', `tlp-legend-item tlp-${state}`);
    item.append(el('span', 'tlp-dot', STATE_DOT[state]), el('span', undefined, STATE_LABEL[state]));
    box.appendChild(item);
  }
  return box;
}

// ---------------------------------------------------------------- 畫

function render(): void {
  const v = ensureView();
  const keep = v.scroll.scrollTop;
  v.scroll.replaceChildren();
  v.issues.replaceChildren();
  setHidden(v.issues, true);
  if (!data) {
    v.meta.textContent = '';
    showNote(document.body.classList.contains('no-workspace') ? NO_WORKSPACE : '正在讀取時間線…');
    return;
  }
  if (!data.initialized) {
    v.meta.textContent = '';
    showNote('這個目錄還不是小說工程（沒有工程後設資料目錄），沒有時間線。');
    return;
  }
  v.meta.textContent = data.meta;
  v.meta.title = data.tip;
  for (const issue of data.issues) {
    v.issues.appendChild(issueRow(issue.text, issue.chapter, issue.start));
  }
  setHidden(v.issues, data.issues.length === 0);
  fillThreads(v.thread, data);
  if (data.days.length === 0) {
    syncFilters(v);
    showNote(
      data.missing
        ? `時間線裡還沒有一章。${data.missing.text}：右鍵這裡「從正文補推故事時間」（先問你，寫明呼叫次數），或到工程頁「時間線」組點「補推時間」。`
        : '時間線裡還沒有一章。同步一章就會推它的故事時間。'
    );
    return;
  }
  // 從工程頁定位過來的那一章被篩選藏起來了：篩選放開（作者點的就是要看它）。
  if (scrollTo !== undefined && !data.days.some((d) => d.cards.some((c) => c.no === scrollTo && passes(c)))) {
    onlyProblems = false;
    threadFilter = '';
  }
  syncFilters(v);
  const days = data.days.map((d) => ({ ...d, cards: d.cards.filter(passes) })).filter((d) => d.cards.length > 0);
  if (days.length === 0) {
    showNote('沒有符合篩選的章。');
    return;
  }
  showNote('');
  v.scroll.appendChild(buildAxis(days));
  v.scroll.scrollTop = keep;
  applyScroll();
}

function showNote(text: string): void {
  if (!view) {
    return;
  }
  view.note.textContent = text;
  setHidden(view.note, !text);
}

/** 篩選：只看有問題的、只看某條線上有事發生的。 */
function passes(c: TimelineOverviewCard): boolean {
  return (!onlyProblems || c.problem) && (!threadFilter || c.events.some((e) => e.thread === threadFilter));
}

function syncFilters(v: View): void {
  v.problems.checked = onlyProblems;
  v.thread.value = threadFilter;
}

/** 「線」下拉：全部線 + 有實際事件的線（換了資料、那條線不在了就回到全部）。 */
function fillThreads(select: HTMLSelectElement, d: TimelineOverview): void {
  select.replaceChildren();
  const all = el('option', undefined, '全部線');
  all.value = '';
  select.appendChild(all);
  for (const t of d.threads) {
    const opt = el('option', undefined, t.name);
    opt.value = t.name;
    select.appendChild(opt);
  }
  if (!d.threads.some((t) => t.name === threadFilter)) {
    threadFilter = '';
  }
  setHidden(select, d.threads.length === 0);
}

/** 一條 ⚠。帶章號的點了展開那一張；說起點的右鍵改起點、填為起點（標題欄右鍵也有）。 */
function issueRow(text: string, chapter: number | undefined, start: boolean | undefined): HTMLElement {
  const row = el('div', `tlp-issue${chapter !== undefined ? ' is-link' : ''}`, `⚠ ${text}`);
  if (chapter !== undefined) {
    row.dataset.chapter = String(chapter);
    row.title = `點選展開第 ${chapter} 章`;
    row.addEventListener('click', () => focusChapter(chapter));
  }
  if (start) {
    onContextMenu(row, () => [...startItems(), { sep: true }, ...pageMenu()]);
  }
  return row;
}

/** 豎軸：月份分隔、「N 天后」、一個日子一行。 */
function buildAxis(days: readonly TimelineOverviewDay[]): HTMLElement {
  const axis = el('div', 'tlp-axis');
  let month: string | undefined;
  let reach: number | undefined;
  for (const d of days) {
    // 「N 天后」照上一行裡最晚的結尾算（跨了幾天的章把它往後推）；回憶那一行（第 0 天）不算。
    if (reach !== undefined && d.day - reach >= GAP_DAYS) {
      axis.appendChild(el('div', 'tlp-gap', `${d.day - reach} 天后`));
    }
    if (d.month && d.month !== month) {
      axis.appendChild(el('div', 'tlp-month', d.season ? `${d.month} · ${d.season}` : d.month));
      month = d.month;
    }
    axis.appendChild(dayRow(d));
    if (d.day > 0) {
      reach = Math.max(reach ?? d.day, d.day, ...d.cards.map((c) => c.end ?? d.day));
    }
  }
  return axis;
}

function dayRow(d: TimelineOverviewDay): HTMLElement {
  const row = el('div', 'tlp-day');
  row.dataset.day = String(d.day);
  const when = el('div', 'tlp-when');
  when.title = d.full;
  when.appendChild(el('div', 'tlp-date', d.label));
  if (d.sub) {
    when.appendChild(el('div', 'tlp-sub', d.sub));
  }
  const rail = el('div', 'tlp-rail');
  rail.appendChild(el('span', 'tlp-node'));
  const cards = el('div', 'tlp-cards');
  for (const c of d.cards) {
    cards.appendChild(cardEl(c));
  }
  row.append(when, rail, cards);
  return row;
}

/** 一章一張卡片：收著時是摘要，展開多一塊詳情、事件帶原文。 */
function cardEl(c: TimelineOverviewCard): HTMLElement {
  const open = expanded.has(c.no);
  const card = el(
    'div',
    `tlp-card tlp-${c.state}${c.flashback ? ' tlp-flashback' : ''}${c.issues.length > 0 ? ' has-issue' : ''}${open ? ' is-open' : ''}${selected === c.no ? ' is-selected' : ''}`
  );
  card.dataset.no = String(c.no);

  const head = el('div', 'tlp-card-head');
  const dot = el('span', 'tlp-dot', STATE_DOT[c.state]);
  dot.title = STATE_LABEL[c.state];
  const title = el('span', 'tlp-card-title', `第 ${c.no} 章${c.title ? ` ${c.title}` : ''}`);
  title.title = open ? '點選收起；右鍵改時間、重推、開啟正文' : '點選展開詳情；右鍵改時間、重推、開啟正文';
  head.append(dot, title);
  const time = [c.when, c.delta].filter(Boolean).join(' · ');
  if (time) {
    head.appendChild(el('span', 'tlp-card-time', time));
  }
  card.appendChild(head);
  if (c.note) {
    card.appendChild(el('div', 'tlp-card-note', c.note));
  }
  const events = open ? c.events : c.events.slice(0, CARD_EVENTS);
  if (events.length > 0) {
    const list = el('div', 'tlp-events');
    for (const e of events) {
      list.appendChild(eventEl(e, open));
    }
    card.appendChild(list);
  }
  if (!open && c.events.length > CARD_EVENTS) {
    card.appendChild(el('div', 'tlp-more', `還有 ${c.events.length - CARD_EVENTS} 條，點開看`));
  }
  if (c.synopsis) {
    card.appendChild(el('div', 'tlp-synopsis', c.synopsis));
  }
  for (const issue of c.issues) {
    card.appendChild(el('div', 'tlp-card-issue', `⚠ ${issue}`));
  }
  if (open) {
    const detail = el('div', 'tlp-detail');
    for (const line of c.detail) {
      detail.appendChild(el('div', undefined, line));
    }
    card.appendChild(detail);
  }
  onContextMenu(card, () => cardMenu(c));
  return card;
}

/** 一條事件：線名小標籤（色塊 + 名字，名字用正文的顏色）、事件；展開時帶原文。 */
function eventEl(e: TimelineOverviewEvent, withEvidence: boolean): HTMLElement {
  const row = el('div', 'tlp-event');
  const chip = el('span', `tlp-chip ${e.color >= 0 ? `tlp-c${e.color}` : 'tlp-cx'}`);
  chip.append(el('span', 'tlp-swatch'), el('span', 'tlp-chip-name', e.thread));
  row.appendChild(chip);
  const label = e.foreshadowing ? `${traditionalLabel(e.type)}〈${e.foreshadowing}〉` : e.type === '推进' ? '' : traditionalLabel(e.type);
  row.appendChild(el('span', 'tlp-event-what', label ? `${label}：${e.what}` : e.what));
  if (withEvidence && e.evidence) {
    row.appendChild(el('div', 'tlp-quote', `「${e.evidence}」`));
  }
  return row;
}

// ---------------------------------------------------------------- 定位與互動

/** 展開那一張、選中、滾過去（從 ⚠ 點過來的）。 */
function focusChapter(no: number): void {
  expanded.add(no);
  selected = no;
  scrollTo = no;
  render();
}

/** 定位過來、還沒滾過的滾過去（滾一次），那一張放在上面一點。 */
function applyScroll(): void {
  if (!view || scrollTo === undefined) {
    return;
  }
  const card = view.scroll.querySelector<HTMLElement>(`.tlp-card[data-no="${scrollTo}"]`);
  if (!card) {
    return;
  }
  scrollTo = undefined;
  const top = card.getBoundingClientRect().top - view.scroll.getBoundingClientRect().top;
  view.scroll.scrollTop = Math.max(0, view.scroll.scrollTop + top - 48);
}

/** 單擊卡片：展開 / 收起，同時選中。只換這一張（整頁重畫會丟掉滾動位置）。 */
function onClick(e: MouseEvent): void {
  const node = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tlp-card');
  const no = node?.dataset.no ? Number(node.dataset.no) : undefined;
  const c = no !== undefined ? data?.days.flatMap((d) => d.cards).find((x) => x.no === no) : undefined;
  if (!node || !c || !view) {
    return;
  }
  if (expanded.has(c.no)) {
    expanded.delete(c.no);
  } else {
    expanded.add(c.no);
  }
  selected = c.no;
  for (const other of view.scroll.querySelectorAll('.tlp-card.is-selected')) {
    other.classList.remove('is-selected');
  }
  node.replaceWith(cardEl(c));
}

function act(action: ProjectAction, extra: { name?: string; range?: { from: number; to: number } } = {}): void {
  post({ type: 'projectAction', action, ...extra });
}

function openFile(path: string): void {
  post({ type: 'openEditor', path, pane: host?.id ?? 'main' });
}

/** 改曆法與起點、填為起點（標題欄右鍵與說起點的那條 ⚠）。 */
function startItems(): MenuItem[] {
  const suggestion = data?.calendar.suggestion;
  return [
    { label: '改曆法與起點…', run: () => act('setTimelineStart') },
    ...(suggestion ? [{ label: `填為起點「${suggestion.start}」（${suggestion.note}）`, run: () => act('setTimelineStart', { name: suggestion.start }) }] : []),
  ];
}

/** 標題欄與空白處的右鍵（⚑7）。 */
function pageMenu(): MenuItem[] {
  if (!data?.initialized) {
    return [{ label: '重新整理', run: () => request() }];
  }
  const d = data;
  return [
    ...startItems(),
    ...(d.missing ? [{ label: '從正文補推故事時間', run: () => act('backfillTimeline') }] : []),
    ...(d.machine > 0 ? [{ label: `重推機器寫的 ${d.machine} 行…`, run: () => act('refreshTimeline') }] : []),
    { sep: true },
    ...(d.exists ? [{ label: '開啟時間線檔案', run: () => openFile(d.relPath) }] : []),
    { label: '重新整理', run: () => request() },
  ];
}

/** 右鍵一張卡片：改時間、重推（機器寫的、還沒推的才給「重推這一章」）、開啟正文 / 細綱 / 時間線檔案。 */
function cardMenu(c: TimelineOverviewCard): MenuItem[] {
  const d = data;
  if (!d) {
    return [];
  }
  return [
    { label: '改時間…', run: () => act('editTimeline', { name: String(c.no) }) },
    ...(c.machine || c.state === 'missing' ? [{ label: '重推這一章', run: () => act('refreshTimeline', { range: { from: c.no, to: c.no } }) }] : []),
    ...(d.last > c.no ? [{ label: `從這一章起重推（到第 ${d.last} 章）`, run: () => act('refreshTimeline', { range: { from: c.no, to: d.last } }) }] : []),
    { sep: true },
    // 正文進主區、細綱並排（同敘事線總覽點格子）。
    ...(c.chapterPath ? [{ label: '開啟這一章', run: () => post(openChapterMessage(c.chapterPath!)) }] : []),
    ...(c.plotPath ? [{ label: '開啟細綱', run: () => openFile(c.plotPath!) }] : []),
    ...(d.exists ? [{ label: '開啟時間線檔案', run: () => openFile(d.relPath) }] : []),
  ];
}
