import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { describeError, elapsed, formatDuration, scoped } from './logger';

/**
 * 長任務登記處。
 *
 * `Host.progress` 只把進度交給宿主自己的 UI（VS Code 的通知條 / 獨立版的
 * toast），網頁裡看不見——「同步 76 章細綱」跑起來之後介面上什麼都沒有，
 * 只能乾等。這裡在它外面補一層：把每次進度同時記進一張程序內的表，
 * 由 `ChatController` 訂閱後廣播給所有前端，工程頁據此畫進度條。
 *
 * 三件事一次做完，呼叫方只寫一遍：
 * 1. 宿主原生進度（通知條、可取消）照舊；
 * 2. 結構化進度（第幾項/共幾項）推給網頁；
 * 3. 開始 / 每步 / 結束都進日誌，附耗時。
 */

export interface TaskSnapshot {
  id: string;
  /** 展示名，如「同步章節細綱」。不帶「Novelwarden：」字首。 */
  title: string;
  /** 當前在做什麼，如「第 12 章《夜訪》」。 */
  message: string;
  /** 已完成項數 / 總項數。兩者都有才畫進度條。 */
  current?: number;
  total?: number;
  /** 已執行毫秒數（快照時刻）。前端自己續著走秒。 */
  elapsedMs: number;
  /**
   * 能在「這一項做完之後」停下（批次寫章：只在章與章之間停，D10）。前端據此多給一顆
   * 「寫完這一章就停」。
   */
  pausable?: boolean;
  /** 作者已經點過「寫完這一章就停」：這一項做完就收。 */
  stopping?: boolean;
}

/**
 * 任務結束時的那一句（D24）。前端出一條帶按鈕的提示——「開啟第 3 章」直接開那一章，
 * 而不是像上游那樣跳到輸出面板。給了它的任務不再另外 `toast`（不重複）。
 */
export interface TaskNotice {
  message: string;
  level?: 'info' | 'error';
  /** 提示條上的按鈕：開啟這一章（章節工作臺那一條，W6），或者開啟一個會話（批次審稿的報告，五期補遺 §4）。 */
  open?: TaskOpen;
}

export type TaskOpen = { plotRelPath: string; label: string } | { sessionId: string; label: string };

export interface TaskFinished extends TaskNotice {
  id: string;
  title: string;
  /** 任務屬於哪個工程（{@link setTaskOwnerResolver}）。沒有歸屬的人人都看得見。 */
  owner?: string;
}

export interface TaskContext {
  /** 取消訊號：使用者點了宿主的取消，或前端點了進度條上的「停止」。 */
  readonly signal: AbortSignal;
  /**
   * 彙報進度。傳字串只改文案；傳物件可同時給出 `current` / `total`，
   * 前端據此畫進度條。欄位留空表示沿用上一次的值。
   */
  report(update: string | { message?: string; current?: number; total?: number }): void;
  /**
   * 作者點過「寫完這一項就停」沒有（`pausable` 的任務才會有）。任務在每一項之間看一眼，
   * 是就收——正在做的那一項照常做完，與「停止」（中斷正在做的）是兩回事。
   */
  stopRequested(): boolean;
  /** 任務結束時說的那一句（{@link TaskNotice}）。多次呼叫以最後一次為準。 */
  finish(notice: TaskNotice): void;
}

interface TaskState extends TaskSnapshot {
  startedAt: number;
  abort: AbortController;
  owner?: string;
}

const log = scoped('任務');
const tasks = new Map<string, TaskState>();
const listeners = new Set<() => void>();
const finishers = new Set<(t: TaskFinished) => void>();
let counter = 0;
let ownerResolver: () => string | undefined = () => undefined;

/**
 * 任務開跑時記下它屬於哪個工程（獨立版一個程序同時開著幾個工程，進度條只該出現在
 * 那個工程的視窗裡）。外掛一個程序一個工程，不設。
 */
export function setTaskOwnerResolver(fn: () => string | undefined): void {
  ownerResolver = fn;
}

/**
 * 這個任務該不該給 `owner` 那個工程的視窗看。不問歸屬（undefined）的都看；沒有歸屬的任務誰都看；
 * `null` 是沒開工程的視窗，只看沒有歸屬的。
 */
export function visibleTo(taskOwner: string | undefined, owner: string | null | undefined): boolean {
  return owner === undefined || !taskOwner || taskOwner === owner;
}

/** 當前在跑的任務快照，按開始時間正序。`owner` 的意思見 {@link visibleTo}。 */
export function activeTasks(owner?: string | null): TaskSnapshot[] {
  return [...tasks.values()]
    .filter((t) => visibleTo(t.owner, owner))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({
      id: t.id,
      title: t.title,
      message: t.message,
      current: t.current,
      total: t.total,
      elapsedMs: Date.now() - t.startedAt,
      ...(t.pausable ? { pausable: true, stopping: !!t.stopping } : {}),
    }));
}

/** 任務說完那一句（{@link TaskNotice}）時回呼。返回的 dispose 必須在宿主銷燬時呼叫。 */
export function onTaskFinished(fn: (t: TaskFinished) => void): { dispose(): void } {
  finishers.add(fn);
  return { dispose: () => void finishers.delete(fn) };
}

/**
 * 前端點「寫完這一章就停」。只對 `pausable` 的任務有效；未知 id（任務剛好結束）當作無事發生。
 */
export function requestStop(id: string): boolean {
  const task = tasks.get(id);
  if (!task || !task.pausable) {
    return false;
  }
  if (!task.stopping) {
    log.info(`使用者要求「${task.title}」做完這一項就停`, `已執行 ${formatDuration(Date.now() - task.startedAt)}`);
    task.stopping = true;
    notify();
  }
  return true;
}

/** 任務表有變化時回呼（新增/進度/結束）。返回的 dispose 必須在宿主銷燬時呼叫。 */
export function onTasksChanged(fn: () => void): { dispose(): void } {
  listeners.add(fn);
  return { dispose: () => void listeners.delete(fn) };
}

/** 前端點「停止」。未知 id（任務剛好結束）當作無事發生。 */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) {
    return false;
  }
  log.info(`使用者取消「${task.title}」`, `已執行 ${formatDuration(Date.now() - task.startedAt)}`);
  task.abort.abort(new CancelledError());
  return true;
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 訂閱者出錯不影響任務本身 */
    }
  }
}

/**
 * 跑一個長任務。
 *
 * @param title 展示名，如「同步章節細綱」。
 * @param fn 任務體。拿到 `signal` 與 `report`。
 * @param opts.scope 日誌來源名，預設用 title。
 */
export async function runTask<T>(
  title: string,
  fn: (ctx: TaskContext) => Promise<T>,
  opts: { scope?: string; pausable?: boolean } = {}
): Promise<T> {
  const id = `task-${++counter}`;
  const scope = opts.scope ?? title;
  const taskLog = scoped(scope);
  const startedAt = Date.now();

  return getHost().progress(`Novelwarden：${title}`, async (hostSignal, hostReport) => {
    // 自己持一個 controller：宿主的取消（通知條上的 ×）與前端進度條上的
    // 「停止」都要能中斷，兩條來源在這裡併成一個 signal。
    const abort = new AbortController();
    const relay = () => abort.abort(hostSignal.reason ?? new CancelledError());
    if (hostSignal.aborted) {
      relay();
    } else {
      hostSignal.addEventListener('abort', relay, { once: true });
    }

    const state: TaskState = {
      id,
      title,
      message: '準備中…',
      elapsedMs: 0,
      startedAt,
      abort,
      owner: ownerResolver(),
      ...(opts.pausable ? { pausable: true, stopping: false } : {}),
    };
    let notice: TaskNotice | undefined;
    tasks.set(id, state);
    taskLog.info(`開始：${title}`);
    notify();

    const report: TaskContext['report'] = (update) => {
      if (typeof update === 'string') {
        state.message = update;
      } else {
        if (update.message !== undefined) {
          state.message = update.message;
        }
        if (update.current !== undefined) {
          state.current = update.current;
        }
        if (update.total !== undefined) {
          state.total = update.total;
        }
      }
      // 宿主原生進度只吃字串，把 n/N 拼進去。
      const suffix =
        state.current !== undefined && state.total !== undefined ? `（${state.current}/${state.total}）` : '';
      hostReport(`${state.message}${suffix}`);
      taskLog.debug(`${state.message}${suffix}`);
      notify();
    };

    try {
      const result = await fn({
        signal: abort.signal,
        report,
        stopRequested: () => !!state.stopping,
        finish: (n) => {
          notice = n;
        },
      });
      if (abort.signal.aborted) {
        taskLog.warn(`已取消：${title}`, `已執行 ${elapsed(startedAt)}`);
      } else {
        taskLog.info(`完成：${title}`, `耗時 ${elapsed(startedAt)}`);
      }
      if (notice) {
        const done: TaskFinished = { ...notice, id, title, owner: state.owner };
        for (const f of finishers) {
          try {
            f(done);
          } catch {
            /* 訂閱者出錯不影響任務本身 */
          }
        }
      }
      return result;
    } catch (err) {
      if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
        taskLog.warn(`已取消：${title}`, `已執行 ${elapsed(startedAt)}`);
      } else {
        taskLog.error(`失敗：${title}——${describeError(err)}`, err);
      }
      throw err;
    } finally {
      hostSignal.removeEventListener('abort', relay);
      tasks.delete(id);
      notify();
    }
  });
}
