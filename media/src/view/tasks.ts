/**
 * 頁頭的長任務進度條（W8）：所有頁籤都看得見（DOM 在 shells/shared/panes.ts 的 `taskBar`）。
 *
 * 後端每次進度變化都全量重推 `tasks`，這裡整塊重畫——列表最多兩三項，
 * 增量更新換來的那點開銷不值得多維護一份狀態。
 *
 * **計時由前端自己走**：後端只在有進度時才推，一次模型呼叫能安靜一分鐘，
 * 那期間計時器停住會讓人以為卡死了。收到快照時記下 `Date.now() - elapsedMs`
 * 當基線，之後每秒**只改計時文字**——重建 DOM 會打斷「停止」按鈕上的點選。
 */
import { el as mk, setHidden, spacer } from '../dom';
import type { TaskSnapshot } from '../protocol';
import { linkBtn } from './buttons';
import { durationText } from './format';
import { el } from './refs';
import { vscode } from './store';

/** 快照 + 收到它時的本地基線時刻。 */
interface RunningTask {
  snapshot: TaskSnapshot;
  baseAt: number;
}

let tasks: RunningTask[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function renderTasks(list: TaskSnapshot[]): void {
  const now = Date.now();
  tasks = (list || []).map((snapshot) => ({ snapshot, baseAt: now - (snapshot.elapsedMs || 0) }));

  el.taskList.innerHTML = '';
  setHidden(el.taskList, tasks.length === 0);

  if (tasks.length === 0) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  for (const task of tasks) {
    el.taskList.appendChild(buildTaskRow(task.snapshot));
  }
  timer ??= setInterval(tick, 1000);
}

/** 某個標題的長任務是否在跑。用於避免重複觸發同一個動作。 */
export function hasTask(title: string): boolean {
  return tasks.some((t) => t.snapshot.title === title);
}

/** 每秒只改計時文字，不重建 DOM——重建會打斷「停止」按鈕上的點選。 */
function tick(): void {
  for (const { snapshot, baseAt } of tasks) {
    const node = el.taskList.querySelector(`[data-task="${snapshot.id}"] .task-time`);
    if (node) {
      node.textContent = durationText(Date.now() - baseAt);
    }
  }
}

function buildTaskRow(t: TaskSnapshot): HTMLElement {
  const box = mk('div', 'task');
  box.dataset.task = t.id;

  const head = mk('div', 'task-head');
  head.appendChild(mk('span', 'task-title', t.title));
  head.appendChild(mk('span', 'meta task-counter', counterText(t)));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'meta task-time', durationText(t.elapsedMs || 0)));
  // 批次寫章只在章與章之間停（D10）：「寫完這一章就停」讓正在寫的這一章寫完、落盤再收；
  // 「停止」是中斷，正在寫的那一章不要了。點過之後按鈕換成一句說明，不再能點第二下。
  if (t.pausable) {
    if (t.stopping) {
      head.appendChild(mk('span', 'meta task-stopping', '寫完這一章就停'));
    } else {
      const pause = linkBtn('寫完這一章就停', () => vscode.postMessage({ type: 'stopAfterItem', id: t.id }));
      pause.classList.add('task-pause');
      head.appendChild(pause);
    }
  }
  head.appendChild(linkBtn('停止', () => vscode.postMessage({ type: 'cancelTask', id: t.id })));
  box.appendChild(head);

  box.appendChild(buildBar(t));
  box.appendChild(mk('div', 'task-msg', t.message || ''));
  return box;
}

function buildBar(t: TaskSnapshot): HTMLElement {
  const bar = mk('div', 'task-bar');
  const fill = mk('div', 'task-fill');
  const total = t.total ?? 0;
  if (total > 0) {
    fill.style.width = `${Math.min(100, Math.round(((t.current || 0) / total) * 100))}%`;
  } else {
    // 不知道總量時走一條來回掃的條，至少表明還活著——別顯示假的百分比。
    bar.classList.add('indeterminate');
    fill.style.width = '35%';
  }
  bar.appendChild(fill);
  return bar;
}

function counterText(t: TaskSnapshot): string {
  const total = t.total ?? 0;
  if (total <= 0) {
    return '';
  }
  const current = Math.min(t.current || 0, total);
  return `${current}/${total} · ${Math.round((current / total) * 100)}%`;
}
