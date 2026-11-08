/**
 * webview API 的取用與訊息收發。
 *
 * 四個產物各自打包，因此各自呼叫一次 `acquireVsCodeApi()`——這與改造前
 * 逐個檔案呼叫的行為完全一致。VS Code 的 webview 裡這個函式只允許調一次，
 * 所以 editor / explorer 那兩個**必須**在確認自己那塊 DOM 存在（即獨立版）
 * 之後才走到這裡；獨立版的 bridge.js 每次呼叫都返回同一個物件，無此限制。
 */
import type { InMessage, OutMessage } from './protocol';

/** webview 宿主給的那點 API。獨立版由 bridge.js 偽裝出同樣的形狀。 */
export interface WebviewApi<State> {
  postMessage(message: InMessage): void;
  getState(): State | undefined;
  setState(state: State): State;
}

declare global {
  function acquireVsCodeApi(): WebviewApi<unknown>;

  interface Window {
    /** bridge.js 在獨立版裡裝上的偽裝實現；webview 裡由宿主注入。 */
    acquireVsCodeApi?: () => WebviewApi<unknown>;
  }
}

/**
 * 取一次 webview API。
 *
 * 型別引數是 `getState`/`setState` 裡那份 UI 狀態的形狀——只有 view 用得上
 * （輸入框草稿），其餘兩塊不帶引數即表示不碰它。宿主那邊這塊儲存本來就是
 * 無型別的 JSON，斷言只在這一處發生，呼叫方拿到的是確定的形狀。
 */
export function acquireApi<State = never>(): WebviewApi<State> {
  return acquireVsCodeApi() as WebviewApi<State>;
}

/**
 * 監聽後端推來的訊息。
 *
 * 三個前端產物各自掛一份監聽、各自認自己關心的 `type`，互不干擾——
 * 這是改造前就有的格局（view / editor / explorer 完全解耦），保持不變。
 */
export function onMessage(handler: (msg: OutMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<OutMessage>) => {
    if (event.data) {
      handler(event.data);
    }
  });
}
