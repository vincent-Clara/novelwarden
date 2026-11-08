/**
 * 工程頁「敘事線」頁籤（敘事線重做第 8 個提交）：一條線一行，最後一行是「未歸屬的伏筆」。
 *
 * 一行寫 `林昭與沈青 · 感情線 · 進行中 · 最近第 12 章 · 2 條伏筆沒收`，有問題的另加 `⚠ 斷了 15 章`、
 * `⚠ 1 條伏筆逾期`、`⚠ 過了計劃收束的第 40 章`。這幾句由後端給（`views/threads.ts`，文案只有一份），這裡只渲染、
 * 只在每一句前面加 ⚠。作者一眼要看出的是「哪條線走到哪了、哪條該管一管」，所以 ⚠ 另起一格、不截斷。
 *
 * - **點一行開啟那條線的檔案**（單擊臨時標籤、雙擊轉正，同別的行）；右鍵「開啟」「在總覽裡看」（敘事線重做三期：編輯區裡
 *   「敘事線總覽」標籤開啟、定位到這一行）。
 * - **失敗的 ❗ 掛在對應的行上**：當前進度作者改過、沒覆蓋的黃 ❗ 掛在那條線的檔案上；排線失敗的紅 ❗ 掛在敘事線
 *   目錄上，沒有對應的行，放在頁籤標題旁邊、按鈕前面。
 * - **「從大綱排出 / 從大綱補充」在頁籤標題旁邊**（組標題只管摺疊，點不開東西，`groups.ts` 的 `head`）：線從情節
 *   大綱排，還沒有大綱時不給；排線在跑時也不給（點第二次只會撞上「已有任務在進行」，任務名與 features/threads.ts
 *   的 runTask 一字不差）。按鈕不直接花錢：後端先彈確認框，寫明 1 次呼叫。右鍵標題與頁裡的空白處也給這一項。
 * - **「總覽」也在頁籤標題旁邊**（三期）：開啟編輯區裡的「敘事線總覽」（章 × 線的時間軸）。**能力探測**：先問
 *   `nf-threads-query` 有沒有人畫得了——只有內建編輯器（editor.js）回答，外掛形態沒有內建編輯器，「總覽」與「在總覽裡看」
 *   都不畫（設計稿 ⚑11：VS Code 外掛先不做總覽；不判斷是哪個殼）。一條線、一條未歸屬的伏筆都沒有時也不給（開啟了是空的）。
 * - 掛伏筆靠作者在檔案裡剪貼（設計稿 ⚑10），這裡不做「挪」。
 * - **一行右鍵「標為收束」「標為放棄」**（2026-10-24）：同步漏報了收束的線（第 7 章就走完了，卻一直掛「斷了 75 章」）由作者補一筆。
 *   進行中的兩樣都給，計劃中的只給放棄，收束、放棄了的不給。不調模型，後端先問一句（features/threads.ts 的 `markThreadEnded`）。
 * - **敘事線判到哪**（四期）：定稿了、敘事線還沒判的章（拆書匯入、補齊整理出來的、補記停在半路的）在頁裡最上面說一句
 *   「⚠ 第 31–60 章還沒判」——線的狀態按判到的那一章算，這幾章上線裡本來就沒有事件。文案由後端給（`views/threads.ts`）。
 *   這時標題旁多一個「從正文補記」（右鍵標題、頁裡空白處也有）：逐章走定稿第三步，後端先彈確認框寫明章數與次數；補記在跑時
 *   不給（任務名與 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差）。不落後時不給——沒有要補的。
 * - **故事時間單獨一組「時間線」**（2026-10-24 重做，設計稿 docs/design/plans/2026-10-24-story-timeline-rework.md「五」）：排在敘事線組前面，
 *   {@link buildTimelineRows}。對賬一條一行，章按月分段（最後一段預設展開、其餘收起，⚑9）一章一行；右鍵改時間、重推這一章、從這一章起重推。
 *   標題旁「補推時間」「重推」「總覽」，都先由後端彈確認框。文案後端給。
 * - **同日「時間線總覽」**（docs/design/plans/2026-10-24-timeline-page.md「二」，作者嫌原來的點法反人類）：曆法與起點那一行去掉，挪到組標題的
 *   懸停裡、改走右鍵（沒填起點有建議、起點認不出的各成一條 ⚠，右鍵改）；**點一章開啟時間線總覽、展開這一章**，不再開啟正文（推翻上一稿
 *   ⚑10；開啟正文挪到右鍵）；點一條帶章號的 ⚠ 同樣定位過去；標題旁「總覽」開啟時間線總覽。外掛形態沒有內建編輯器（`nf-timeline-query`
 *   沒人回答）：點一章、點 ⚠ 開啟時間線檔案（⚑8），不給「總覽」。
 */
import { el as mk } from '../../dom';
import { commandThreadsOverview, commandTimelineOverview, queryThreadsOverview, queryTimelineOverview } from '../../globals';
import type { MenuItem } from '../../globals';
import { THREAD_PLAN_CALLS, THREADS_JUDGE_CALLS } from '../../protocol';
import type { ProjectTree, ThreadLineView, ThreadUnfiledView, TimelineChapterView, TimelineGroupView, TimelineSegmentView } from '../../protocol';
import { linkBtn } from '../buttons';
import { onContextMenu } from '../menu';
import { openPath, vscode } from '../store';
import { hasTask } from '../tasks';
import { baseMenuItems, projectAction } from './actions';
import { emptyRow, failureMark } from './rows';
import { indentOf, timelineFolds } from './treeState';

/** 排線的任務名：與 features/threads.ts 的 runTask 一字不差。 */
const PLAN_TASK = '排敘事線';
/** 補記的任務名：與 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差。 */
const BACKFILL_TASK = '從已寫正文補記敘事線';
/** 補推、重推故事時間的任務名：與 features/timelineBackfill.ts 的 `TIMELINE_BACKFILL_TASK` / `TIMELINE_REFRESH_TASK` 一字不差。 */
const TIME_BACKFILL_TASK = '從正文補推故事時間';
const TIME_REFRESH_TASK = '重推故事時間';

/** 補推、重推有一樣在跑：兩樣都不給（同時跑會互相寫同一份時間線）。 */
function timeTaskRunning(): boolean {
  return hasTask(TIME_BACKFILL_TASK) || hasTask(TIME_REFRESH_TASK);
}

/** 同步過、時間線裡還沒有（或還推不出）的章（2026-10-24）：給「補推時間」。 */
function canBackfillTime(tree: ProjectTree): boolean {
  return !!tree.threads.timeline?.missing;
}

/** 時間線裡有機器寫的行：給「重推」。 */
function canRefreshTime(tree: ProjectTree): boolean {
  return (tree.threads.timeline?.machine ?? 0) > 0;
}

/** 敘事線落後於定稿（有定稿了還沒判的章）：給「從正文補記」。 */
function canBackfill(tree: ProjectTree): boolean {
  return !!tree.threads.lag;
}

/** 有情節大綱才排得出線。 */
function canPlan(tree: ProjectTree): boolean {
  return tree.architecture.some((a) => a.key === 'outline' && a.filled);
}

/** 沒有線時「從大綱排出」，有了「從大綱補充」。 */
function planVerb(tree: ProjectTree): string {
  return tree.threads.lines.length === 0 ? '從大綱排出' : '從大綱補充';
}

/** 組標題的副標題：`4 條 · 3 條進行中`；一條都沒有說「還沒有」。 */
export function threadsGroupLabel(tree: ProjectTree): string {
  const lines = tree.threads.lines;
  if (lines.length === 0) {
    return '還沒有';
  }
  const going = lines.filter((l) => l.status === '进行中').length;
  return going > 0 ? `${lines.length} 條 · ${going} 條進行中` : `${lines.length} 條`;
}

/**
 * 「敘事線總覽」畫得了、也有東西可畫：有內建編輯器（能力探測，外掛形態沒有人回答）、至少有一條線或一條未歸屬的伏筆。時間線不算
 * （2026-10-24：時間線挪去了自己的「時間線總覽」）。
 */
function canOverview(tree: ProjectTree): boolean {
  return (tree.threads.lines.length > 0 || !!tree.threads.unfiled) && queryThreadsOverview();
}

/** 一行右鍵「在總覽裡看」：開啟編輯區裡的敘事線總覽，定位到這一行。沒有內建編輯器時不給。 */
function overviewItems(tree: ProjectTree, relPath: string): MenuItem[] {
  return canOverview(tree) ? [{ label: '在總覽裡看', run: () => commandThreadsOverview(relPath) }] : [];
}

/** 組標題與頁裡空白處的右鍵：補記（落後時才有）、排線那一項（有情節大綱才有）、開啟總覽（有內建編輯器才有）。 */
export function threadsMenuItems(tree: ProjectTree): MenuItem[] {
  const items: MenuItem[] = [];
  if (canBackfill(tree)) {
    items.push({ label: '從已寫正文補記敘事線', run: () => projectAction('backfillThreads') });
  }
  if (canPlan(tree)) {
    items.push({ label: `${planVerb(tree)}敘事線`, run: () => projectAction('generateThreads') });
  }
  if (canOverview(tree)) {
    items.push({ label: '開啟敘事線總覽', run: () => commandThreadsOverview() });
  }
  return items.length > 0 ? [...items, { sep: true }] : [];
}

/** 頁籤標題旁邊那一截：排線失敗的紅 ❗、「從正文補記」（落後時）、「從大綱排出 / 補充」與「總覽」。都沒有時是 undefined。 */
export function threadsHead(tree: ProjectTree): HTMLElement | undefined {
  const box = mk('span', 'threads-head');
  const mark = failureMark(tree.threadsPath);
  if (mark) {
    box.appendChild(mark);
  }
  if (canBackfill(tree) && !hasTask(BACKFILL_TASK)) {
    const btn = linkBtn('從正文補記', () => projectAction('backfillThreads'));
    btn.classList.add('threads-backfill-btn');
    btn.title = `從已寫正文補記敘事線：${tree.threads.lag!.text}，逐章認這一章在敘事線上發生了什麼（先彈確認框，每章呼叫模型 ${THREADS_JUDGE_CALLS.low}–${THREADS_JUDGE_CALLS.high} 次，含轉寫）；已有的不動，只往線裡追加`;
    box.appendChild(btn);
  }
  if (canPlan(tree) && !hasTask(PLAN_TASK)) {
    const btn = linkBtn(planVerb(tree), () => projectAction('generateThreads'));
    btn.title = `從情節大綱排敘事線（先彈確認框，呼叫模型 ${THREAD_PLAN_CALLS.low} 次：排 1 次、轉寫 1 次）；已有的線不動，同名跳過`;
    box.appendChild(btn);
  }
  if (canOverview(tree)) {
    const btn = linkBtn('總覽', () => commandThreadsOverview());
    btn.classList.add('threads-overview-btn');
    btn.title = '在編輯區開啟敘事線總覽：章 × 線的時間軸，每條線走到哪、伏筆埋了收了沒有、計劃的事哪一章沒發生（不調模型）';
    box.appendChild(btn);
  }
  return box.childElementCount > 0 ? box : undefined;
}

/**
 * 敘事線組的全部行：（敘事線落後於定稿時）最上面一句「還沒判」，一條線一行（後端已排好），最後是「未歸屬的伏筆」；
 * 一條線都沒有時說清先做什麼。
 */
export function buildThreadRows(tree: ProjectTree): HTMLElement[] {
  const { lines, unfiled, lag } = tree.threads;
  const rows = lines.map((line) => buildLineRow(tree, line));
  if (lag) {
    rows.unshift(buildLagRow(tree, lag));
  }
  if (lines.length === 0) {
    rows.push(
      emptyRow(
        canPlan(tree)
          ? '還沒有敘事線。點標題旁的「從大綱排出」，從情節大綱排出主線、支線、感情線、人物線；同步時也會從正文裡認出新的線。'
          : '還沒有敘事線。先排出情節大綱，再從大綱排出敘事線；同步時也會從正文裡認出新的線。'
      )
    );
  }
  if (unfiled) {
    rows.push(buildUnfiledRow(tree, unfiled));
  }
  return rows;
}

/**
 * 「⚠ 第 31–60 章還沒判」（四期）：定稿了、敘事線還沒判的章。掛在頁裡最上面（與角色組的「稱呼衝突」同一個樣子）：說清線的狀態
 * 按判到的那一章算、總覽上這幾章的計劃不算偏差。
 */
function buildLagRow(tree: ProjectTree, lag: NonNullable<ProjectTree['threads']['lag']>): HTMLElement {
  const through = tree.threads.through;
  const row = mk(
    'div',
    'row-conflict threads-lag',
    `⚠ ${lag.text}：這幾章同步了，敘事線還沒記上。` +
      `${through > 0 ? `線斷了幾章、伏筆逾期都按判到的第 ${through} 章算` : '線斷了幾章、伏筆逾期先不算'}，總覽上這幾章的計劃不算偏差。` +
      '點標題旁的「從正文補記」逐章補上（先問你，每章 1–3 次呼叫）。'
  );
  row.title = `敘事線判到第 ${through} 章（從第 1 章起連續判過的），同步到第 ${tree.threads.current} 章。`;
  return row;
}

/** 一章的狀態點：有依據 ●、推測 ○、推不出 ?、沒推 ·、你定的 ★、正文寫明 ◆、回憶 ↺、認不出 ✕。 */
const TIME_DOT: Record<TimelineChapterView['state'], string> = {
  evidence: '●',
  guess: '○',
  unknown: '?',
  missing: '·',
  anchor: '★',
  dated: '◆',
  flashback: '↺',
  bad: '✕',
};

const TIME_STATE: Record<TimelineChapterView['state'], string> = {
  evidence: '有原文依據',
  guess: '推測的',
  unknown: '推不出',
  missing: '還沒推',
  anchor: '你定的',
  dated: '正文寫明瞭日子',
  flashback: '整章是回憶',
  bad: '那一行認不出',
};

/** 「時間線」組標題後面那一串。 */
export function timelineGroupLabel(tree: ProjectTree): string {
  return tree.threads.timeline?.label ?? '';
}

/** 「時間線」組標題的懸停：曆法與起點、曆法怎麼算（2026-10-24 從組裡第一行挪上來）。 */
export function timelineGroupTip(tree: ProjectTree): string | undefined {
  const cal = tree.threads.timeline?.calendar;
  return cal ? `${cal.text}\n${cal.tip}` : undefined;
}

/** 改曆法與起點、填為起點（組標題右鍵、說起點的那條 ⚠ 右鍵）。 */
function startItems(tree: ProjectTree): MenuItem[] {
  const suggestion = tree.threads.timeline?.calendar.suggestion;
  return [
    { label: '改曆法與起點…', run: () => projectAction('setTimelineStart') },
    ...(suggestion ? [{ label: `填為起點「${suggestion.start}」（${suggestion.note}）`, run: () => projectAction('setTimelineStart', undefined, undefined, suggestion.start) }] : []),
  ];
}

/**
 * 點一章、點一條 ⚠：有內建編輯器就開啟時間線總覽（帶章號的展開那一章），沒有（外掛形態）開啟時間線檔案（⚑8）。看的是時間，不是正文。
 */
function showInTimeline(tree: ProjectTree, chapter?: number): void {
  const tl = tree.threads.timeline;
  if (queryTimelineOverview()) {
    commandTimelineOverview(chapter);
  } else if (tl?.exists) {
    openPath(tl.relPath);
  }
}

/** 時間線組標題與組裡空白處的右鍵：補推、重推、改曆法與起點（填為起點）、開啟時間線總覽、開啟檔案。 */
export function timelineMenuItems(tree: ProjectTree): MenuItem[] {
  const tl = tree.threads.timeline;
  if (!tl) {
    return [];
  }
  const busy = timeTaskRunning();
  return [
    ...(canBackfillTime(tree) && !busy ? [{ label: '從正文補推故事時間', run: () => projectAction('backfillTimeline') }] : []),
    ...(canRefreshTime(tree) && !busy ? [{ label: `重推機器寫的 ${tl.machine} 行…`, run: () => projectAction('refreshTimeline') }] : []),
    ...startItems(tree),
    ...(queryTimelineOverview() ? [{ label: '開啟時間線總覽', run: () => commandTimelineOverview() }] : []),
    ...(tl.exists ? [{ label: '開啟時間線檔案', run: () => openPath(tl.relPath) }] : []),
    { sep: true },
  ];
}

/** 時間線組標題旁邊那一截：補推 / 重推失敗的紅 ❗、「補推時間」「重推」「總覽」。都沒有時是 undefined。 */
export function timelineHead(tree: ProjectTree): HTMLElement | undefined {
  const tl = tree.threads.timeline;
  if (!tl) {
    return undefined;
  }
  const box = mk('span', 'threads-head');
  const mark = failureMark(tl.relPath);
  if (mark) {
    box.appendChild(mark);
  }
  const busy = timeTaskRunning();
  if (canBackfillTime(tree) && !busy) {
    const btn = linkBtn('補推時間', () => projectAction('backfillTimeline'));
    btn.classList.add('threads-time-btn');
    btn.title = `從正文補推故事時間：${tl.missing!.text}，幾章一批判每章比上一章晚幾天（先彈確認框，寫明呼叫次數）；只往時間線裡填空，你寫的行不動`;
    box.appendChild(btn);
  }
  if (canRefreshTime(tree) && !busy) {
    const btn = linkBtn('重推', () => projectAction('refreshTimeline'));
    btn.classList.add('threads-refresh-btn');
    btn.title = `機器寫的 ${tl.machine} 行照正文重新推一遍（先彈確認框，寫明會換掉幾行、呼叫次數）；你定的行一個字不動`;
    box.appendChild(btn);
  }
  if (queryTimelineOverview()) {
    const btn = linkBtn('總覽', () => commandTimelineOverview());
    btn.classList.add('timeline-overview-btn');
    btn.title = '在編輯區開啟時間線總覽：豎著按故事裡的日子排，一章一張卡片——哪天、隔了多久、這一章在各條線上發生了什麼、哪裡對不上（不調模型）';
    box.appendChild(btn);
  }
  return box.childElementCount > 0 ? box : undefined;
}

/**
 * 「時間線」組的全部行：對賬一條一行、各段（段頭 + 一章一行）。`rerender` 是摺疊之後重畫（同章節頁籤的卷）。曆法與起點在組標題的懸停裡
 * （{@link timelineGroupTip}）。
 */
export function buildTimelineRows(tree: ProjectTree, rerender: () => void): HTMLElement[] {
  const tl = tree.threads.timeline;
  if (!tl) {
    return [];
  }
  const rows: HTMLElement[] = [];
  const overview = queryTimelineOverview();
  for (const issue of tl.issues) {
    // 一條一行、不加框（敘事線組的「還沒判」是一句話的大框；對賬可能有好幾條，框起來要佔半屏）。
    const row = mk('div', 'timeline-issue', `⚠ ${issue.text}`);
    if (overview || tl.exists) {
      row.title = overview
        ? issue.chapter !== undefined
          ? `點選在時間線總覽裡看第 ${issue.chapter} 章`
          : '點選開啟時間線總覽'
        : '點選開啟時間線檔案（在那裡改，或者右鍵那一章「改時間」）';
      row.addEventListener('click', () => showInTimeline(tree, issue.chapter));
    }
    if (issue.start) {
      onContextMenu(row, () => [...startItems(tree), { sep: true }, ...timelineMenuItems(tree), ...baseMenuItems()]);
    }
    rows.push(row);
  }
  const lastKey = tl.segments[tl.segments.length - 1]?.key;
  for (const seg of tl.segments) {
    // 最後一段預設展開、其餘預設收起（⚑9）；作者點過的照作者的。
    const open = timelineFolds.open.has(seg.key) || (seg.key === lastKey && !timelineFolds.closed.has(seg.key));
    rows.push(buildSegmentHead(seg, open, seg.key === lastKey, rerender));
    if (open) {
      for (const c of seg.chapters) {
        rows.push(buildTimeChapterRow(tree, tl, c));
      }
    }
  }
  if (tl.segments.length === 0) {
    rows.push(emptyRow('時間線裡還沒有一章。同步時會推這一章的時間；已經同步過的章點標題旁的「補推時間」。'));
  }
  return rows;
}

/** 一段的段頭：`▾ 大衍三年三月 · 第 1–12 章 · 14 天`，點了摺疊。 */
function buildSegmentHead(seg: TimelineSegmentView, open: boolean, last: boolean, rerender: () => void): HTMLElement {
  const row = mk('div', 'row row-dir row-timeline-segment');
  row.dataset.segment = seg.key;
  row.style.paddingLeft = `${indentOf(0)}px`;
  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);
  row.appendChild(mk('span', 'row-label row-dir-label', seg.label));
  row.appendChild(mk('span', 'meta', seg.detail));
  const toggle = () => {
    // 記下作者的選擇：預設展開的（最後一段）折起來記在 closed，預設收起的展開記在 open。
    if (open) {
      timelineFolds.open.delete(seg.key);
      if (last) {
        timelineFolds.closed.add(seg.key);
      }
    } else {
      timelineFolds.closed.delete(seg.key);
      if (!last) {
        timelineFolds.open.add(seg.key);
      }
    }
    rerender();
  };
  row.addEventListener('click', toggle);
  return row;
}

/** 一章一行：狀態點、章號與章名、那一天、比上一章、依據；點了在時間線總覽裡展開這一章（外掛形態開啟時間線檔案），右鍵改時間與重推、開啟正文。 */
function buildTimeChapterRow(tree: ProjectTree, tl: TimelineGroupView, c: TimelineChapterView): HTMLElement {
  const row = mk('div', `row row-thread row-time-chapter time-${c.state}${c.issue ? ' has-issue' : ''}`);
  row.dataset.chapter = String(c.no);
  row.style.paddingLeft = `${indentOf(1)}px`;
  const dot = mk('span', 'dot', TIME_DOT[c.state]);
  dot.title = TIME_STATE[c.state];
  row.appendChild(dot);
  const label = mk('span', 'row-label', `第 ${c.no} 章${c.title ? ` ${c.title}` : ''}`);
  const overview = queryTimelineOverview();
  label.title = [c.tip, overview ? '點選在時間線總覽裡看這一章；右鍵改時間、開啟正文' : tl.exists ? '點選開啟時間線檔案；右鍵改時間、開啟正文' : '右鍵改時間'].join('\n\n');
  if (overview || tl.exists) {
    label.addEventListener('click', () => showInTimeline(tree, c.no));
  }
  row.appendChild(label);
  row.appendChild(mk('span', 'meta row-detail', [c.when, c.delta ?? '', c.note].filter(Boolean).join(' · ')));
  if (c.issue) {
    appendWarnings(row, ['對不上']);
  }
  const busy = timeTaskRunning();
  onContextMenu(row, () => [
    { label: '改時間…', run: () => projectAction('editTimeline', undefined, undefined, String(c.no)) },
    ...(!busy && (c.machine || c.state === 'missing') ? [{ label: '重推這一章', run: () => refreshRange(c.no, c.no) }] : []),
    ...(!busy && tl.last > c.no ? [{ label: `從這一章起重推（到第 ${tl.last} 章）`, run: () => refreshRange(c.no, tl.last) }] : []),
    { sep: true },
    ...(c.chapterPath ? [{ label: '開啟這一章', run: () => openPath(c.chapterPath!) }] : []),
    ...(tl.exists ? [{ label: '開啟時間線檔案', run: () => openPath(tl.relPath) }] : []),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 重推一段（後端先彈確認框）。 */
function refreshRange(from: number, to: number): void {
  vscode.postMessage({ type: 'projectAction', action: 'refreshTimeline', range: { from, to } });
}

/** 狀態點：進行中 ●、計劃中 ○、已收束 ✓、已放棄 ✕。 */
const STATUS_DOT: Record<ThreadLineView['status'], string> = { 进行中: '●', 计划中: '○', 已收束: '✓', 已放弃: '✕' };

function buildLineRow(tree: ProjectTree, line: ThreadLineView): HTMLElement {
  const closed = line.status === '已收束' || line.status === '已放弃';
  const row = mk('div', `row row-thread${closed ? ' row-thread-closed' : ''}`);
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', STATUS_DOT[line.status]);
  dot.title = line.status;
  row.appendChild(dot);

  const mark = failureMark(line.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', line.name);
  label.title = [line.tip, `${line.relPath}\n點選開啟這條線的檔案`].filter(Boolean).join('\n\n');
  // 單擊開成臨時標籤，雙擊轉正（見章節那一行）。
  label.addEventListener('click', (e) => openPath(line.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', line.detail));
  appendWarnings(row, line.warnings);

  onContextMenu(row, () => [
    { label: '開啟', run: () => openPath(line.relPath) },
    ...overviewItems(tree, line.relPath),
    ...endingItems(line),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 「標為收束」「標為放棄」：進行中的兩樣都給，計劃中的只給放棄（還沒發生過事，談不上收束），收束、放棄了的不給。 */
function endingItems(line: ThreadLineView): MenuItem[] {
  if (line.status === '已收束' || line.status === '已放弃') {
    return [];
  }
  return [
    { sep: true },
    ...(line.status === '进行中' ? [{ label: '標為收束…', run: () => projectAction('closeThread', line.relPath) }] : []),
    { label: '標為放棄…', run: () => projectAction('abandonThread', line.relPath) },
  ];
}

/** 「未歸屬的伏筆 · N 條」：掛不上哪條線的伏筆。作者把一行伏筆連同它的事件剪到某條線的檔案裡，就是掛上了。 */
function buildUnfiledRow(tree: ProjectTree, u: ThreadUnfiledView): HTMLElement {
  const row = mk('div', 'row row-thread row-thread-unfiled');
  row.style.paddingLeft = `${indentOf(0)}px`;
  row.appendChild(mk('span', 'dot', '◇'));

  const mark = failureMark(u.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', '未歸屬的伏筆');
  label.title = `${u.relPath}\n掛不上哪一條線的伏筆。把一行伏筆連同它的事件剪到某條線的檔案裡，就是掛上了。`;
  label.addEventListener('click', (e) => openPath(u.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', u.detail));
  appendWarnings(row, u.warnings);

  onContextMenu(row, () => [
    { label: '開啟', run: () => openPath(u.relPath) },
    ...overviewItems(tree, u.relPath),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** ⚠ 一句一格，不截斷：幾條線裡掃一眼要看的就是這個。 */
function appendWarnings(row: HTMLElement, warnings: readonly string[]): void {
  for (const w of warnings) {
    row.appendChild(mk('span', 'meta thread-warn', `⚠ ${w}`));
  }
}
