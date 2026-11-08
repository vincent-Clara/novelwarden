/**
 * 把 `acquireVsCodeApi` 裝到 window 上，形狀與 webview 宿主給的那個一致。
 *
 * `getState`/`setState` 在瀏覽器裡落 localStorage：網頁會被 F5 重新整理，
 * 比 webview 更需要它——view.js 用它存輸入框裡沒發出去的草稿。
 */
import { projectStorageKey } from '../globals';
import type { WebviewApi } from '../vscodeApi';
import type { Socket } from './socket';

const STATE_KEY = 'novelforge.viewState';

export function installWebviewApi(socket: Socket): void {
  // 記憶體副本：同一個鍵讀一次 localStorage 就夠，之後以它為準。鍵隨工程變（projectStorageKey），
  // 視窗裡換了工程就重新讀。
  let memoryState: unknown;
  let loadedKey: string | undefined;

  const api: WebviewApi<unknown> = {
    postMessage(message) {
      socket.send(message);
    },
    getState() {
      const key = projectStorageKey(STATE_KEY);
      if (loadedKey !== key) {
        loadedKey = key;
        try {
          memoryState = JSON.parse(localStorage.getItem(key) || 'null') ?? undefined;
        } catch {
          memoryState = undefined;
        }
      }
      return memoryState;
    },
    setState(state) {
      memoryState = state;
      loadedKey = projectStorageKey(STATE_KEY);
      try {
        localStorage.setItem(loadedKey, JSON.stringify(state));
      } catch {
        // 隱私模式下寫不進去，退化為僅本次會話保留。
      }
      return state;
    },
  };

  // 每次呼叫都給同一個物件：view / editor / explorer 各調一次，
  // 它們共享同一條 WebSocket 與同一份狀態儲存。
  window.acquireVsCodeApi = () => api as WebviewApi<never>;
}
