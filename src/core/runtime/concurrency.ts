import { CancelledError } from '../llm/provider';

/**
 * 有界併發。
 *
 * 工程頁上最費時的幾個動作——同步幾十章細綱、批次更新角色卡——裡的條目
 * 彼此**沒有先後依賴**：第 12 章照正文更新細綱不看第 11 章，A 的角色卡也不
 * 看 B 的。序列跑純粹是在排隊等網路往返，於是這裡給它們一條有界併發的路。
 *
 * 三條設計取捨：
 *
 * 1. **不 reject**。逐項 settle 後整批返回，呼叫方自己彙總——沿用
 *    features 層「失敗項打 error 並繼續跑完剩下的」的既有約定：一章細綱
 *    失敗不該讓另外 75 章白跑。
 * 2. **結果按 index 對齊**。完成順序是亂的，但返回陣列與入參一一對應，
 *    呼叫方要拼接有序產物（如全文大綱的階段小節）時不必自己歸位。
 * 3. **`limit <= 1` 走嚴格序列**，與改造前逐字一致——併發預設開著，
 *    出問題時使用者把併發調回 1 就能拿回舊行為，這條路必須沒有驚喜。
 */

/** 一項的結果。與 `Promise.allSettled` 同形，但 reason 保證是 Error。 */
export type Settled<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: Error };

export interface RunPoolOptions<T, R> {
  /** 取消訊號。已 aborted 後不再啟動新任務（在飛的由各自的請求 signal 打斷）。 */
  signal?: AbortSignal;
  /**
   * 每項結束時回呼（成功或失敗都回）。進度與日誌唯一的鉤子——
   * `done` 是**已結束**的項數，進度條的 `current` 只該跟著它走。
   */
  onSettled?: (result: Settled<R>, item: T, index: number, done: number) => void;
  /** 每項開始時回呼。併發下用來報「現在在跑哪幾項」。 */
  onStart?: (item: T, index: number) => void;
}

/**
 * 併發跑一批無序任務。
 *
 * @param limit 同時在飛的上限。<= 1 時嚴格序列。
 * @returns 與 `items` 一一對應的結果陣列（順序不亂）。取消後未啟動的項
 *          以 `CancelledError` 計入 rejected——**留個位置**，呼叫方要報
 *          「取消時還剩幾項沒跑」才有依據。
 */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: RunPoolOptions<T, R> = {}
): Promise<Settled<R>[]> {
  const results = new Array<Settled<R>>(items.length);
  let next = 0;
  let done = 0;

  const runOne = async (index: number): Promise<void> => {
    opts.onStart?.(items[index], index);
    let settled: Settled<R>;
    try {
      settled = { status: 'fulfilled', value: await worker(items[index], index) };
    } catch (err) {
      settled = { status: 'rejected', reason: err instanceof Error ? err : new Error(String(err)) };
    }
    results[index] = settled;
    done++;
    opts.onSettled?.(settled, items[index], index, done);
  };

  const consume = async (): Promise<void> => {
    while (next < items.length) {
      if (opts.signal?.aborted) {
        return;
      }
      await runOne(next++);
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, () => consume()));

  // 取消時留下的空位補成 rejected，呼叫方不必區分「沒跑」與「跑掛了」兩種 undefined。
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      results[i] = { status: 'rejected', reason: new CancelledError() };
    }
  }
  return results;
}

/**
 * 把若干次呼叫串成一條佇列，同一時刻只有一個在跑。
 *
 * 批次更新角色卡時分析是併發的，但 diff 審閱不能併發——同時彈三個 diff
 * 編輯器，使用者根本不知道自己在看誰。於是分析照跑，審閱在這裡排隊，
 * 按**完成順序**一張一張彈。
 *
 * 佇列是程序級的單條鏈：前一個 `fn` 無論成功失敗都不會卡住後面的。
 */
let chain: Promise<unknown> = Promise.resolve();

export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // 鏈上只保留「跑完了」這個事實，不傳播異常——否則一次審閱出錯會讓
  // 後面所有排隊的呼叫都收到同一個 rejection。
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
