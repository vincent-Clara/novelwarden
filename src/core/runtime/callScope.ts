import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallChoice } from '../model/callChoice';

/**
 * 「這一次」：作者在調模型之前的確認框上挑的模型與上下文詳細度（`model/callChoice.ts`）。
 *
 * 挑完的活跑在 {@link withCallChoice} 裡，**`readConfig()` 是唯一讀它的地方**：詳細度換掉
 * `contextDetail`，模型成了 `pinnedModel`（`refsForTask` 只給它）。不一路當引數遞：確認框之後讀
 * 配置的地方散在十幾個函式里，漏掉一處就是彈窗上寫著「精簡」、實際按「詳細」裝。
 *
 * 用 `AsyncLocalStorage.run`：同時在跑的別的任務各在各的上下文裡，互不串（獨立版的
 * `shells/standalone/scopedHost.ts` 按視窗轉發 Host 用的是同一個東西）。
 */
const scope = new AsyncLocalStorage<CallChoice>();

/**
 * 在作者的選擇下跑 `fn`。巢狀時裡面那一次的選擇優先；模型那一項**整項替換**——裡面選了
 * 「按分檔」就是不釘模型，哪怕外面釘了。詳細度裡面沒問（`undefined`）就沿用外面那一次。
 */
export function withCallChoice<T>(choice: CallChoice, fn: () => Promise<T>): Promise<T> {
  const outer = scope.getStore();
  const contextDetail = choice.contextDetail ?? outer?.contextDetail;
  return scope.run(
    {
      ...(choice.model ? { model: choice.model } : {}),
      ...(contextDetail ? { contextDetail } : {}),
    },
    fn
  );
}

/** 當前這一次的選擇；不在任何確認框之後（對話頁、啟動期）是 undefined。 */
export function currentCallChoice(): CallChoice | undefined {
  return scope.getStore();
}
