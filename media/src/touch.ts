/**
 * 觸屏的能力探測——**不看 UA、不問是哪個殼**（見 [../../src/shells/README.md](../../src/shells/README.md)），只看指標本身：
 *
 * - {@link lastPointerWasTouch}：最近一次指標（按下 / 移進 / 移動）是不是手指。手指點一下之後 Chromium 會補發一串相容的
 *   滑鼠事件（`mouseover` → `mousemove` → `mousedown` → `mouseup` → `click`），懸停浮窗靠它分清「滑鼠停在這兒」與「手指點了
 *   一下」——後者不該當成懸停去彈浮窗（彈出來也沒有「移開」可收）。長按彈的 `contextmenu` 之前同樣有一下手指的 `pointerdown`，
 *   右鍵選單靠它認出「這是長按」，在最前面加幾項「看一眼」（見 `view/menu.ts` 的 `onTouchPeek`）。
 * - 同一臺機器可以既有滑鼠又有觸屏（觸屏筆記本），所以按**這一次**的指標認，不按整臺裝置的 `(hover: none)` 認。
 *
 * 兩個產物（view.js、editor.js）各打包一份、各裝一次監聽，互不相干：它只是一個記事的變數，不在產物之間傳東西。
 */

let lastType = '';
let installed = false;

function note(e: Event): void {
  const type = (e as PointerEvent).pointerType;
  if (typeof type === 'string' && type) {
    lastType = type;
  }
}

/** 裝上記事的監聽（捕獲階段，誰都攔不住）。重複呼叫無害。 */
export function trackPointer(): void {
  if (installed) {
    return;
  }
  installed = true;
  for (const type of ['pointerdown', 'pointerover', 'pointermove'] as const) {
    document.addEventListener(type, note, { capture: true, passive: true });
  }
}

/** 最近一次指標是手指。觸控筆算不是（筆能懸停）。 */
export function lastPointerWasTouch(): boolean {
  return lastType === 'touch';
}

/** 這個事件是手指發起的：事件自己帶 `pointerType` 就看它（Chromium 的 `click` / `contextmenu` 是 PointerEvent），否則看最近一次指標。 */
export function isTouchEvent(e: Event): boolean {
  const type = (e as PointerEvent).pointerType;
  if (typeof type === 'string' && type) {
    return type === 'touch';
  }
  return lastPointerWasTouch();
}

/**
 * 切頁、開啟檔案時**別替使用者把焦點放進輸入框**：手機上程式一聚焦輸入框就頂起軟鍵盤、蓋住半屏，想看的東西反倒看不見
 * （Android 實機上一載入就彈——對話頁籤自動聚焦輸入框；點一下編輯器頁籤也彈）。想打字的人自己會點進去。
 * 這一次是手指點的就算；頁面剛載入、還沒有指標的時候只能看整臺裝置的主指標能不能懸停（手機、平板不能）。
 * 只管「順手放焦點」的那幾處；作者明確要打字的（彈窗裡的輸入框、挑了命令之後的對話輸入框、「預覽」切回「編輯」）照舊聚焦。
 */
export function avoidSoftKeyboard(): boolean {
  return lastPointerWasTouch() || touchDevice();
}

/**
 * 整臺裝置的主要指標不能懸停（手機、平板），與樣式裡的 `(hover: none)` 同一條。只在桌面上管用的入口（「退出」關不掉手機瀏覽器的
 * 標籤頁，「開啟日誌目錄」開在服務端那臺機器上）在這種裝置上不列。
 */
export function touchDevice(): boolean {
  return !!window.matchMedia?.('(hover: none)').matches;
}
