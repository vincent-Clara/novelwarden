/**
 * 選單擺在哪：右鍵選單、標題欄的下拉與子選單共用的幾何（純函式、零 DOM，`tests/unit/view/menuPlace.test.js` 釘著）。
 *
 * 一條規矩：**選單整個落在可視區裡**。從前右鍵選單隻翻轉、不平移不壓高——手機豎屏上在下半屏長按，選單比剩下的空間高、
 * 往上翻又頂出螢幕頂，被截掉一截；標題欄的「幫助」下拉與「開啟最近開啟的」子選單在窄屏上直接伸出右邊。現在：
 *
 * - **貼著一點彈**（右鍵）：右邊放不下往左翻，翻過去還放不下就貼著右邊緣；下面放不下往上翻，上面也放不下就平移到剛好
 *   貼著底邊（選單蓋住按下去的那一點，手指在那兒也不礙事）；比整個可視區還高就從頂上開始、壓 `max-height` 在選單裡滾。
 * - **貼著一個矩形彈**（下拉：在按鈕下方左對齊；子選單：在父選單項右邊、頂對齊，右邊放不下翻到左邊）：橫向夾進可視區，
 *   縱向照上面同一套（下拉只往下，放不下就壓高度）。
 *
 * 可視區不一定是 `innerWidth × innerHeight`：手機瀏覽器縮放過、或者軟鍵盤頂起了可視區時，`visualViewport` 才是人眼看得到的
 * 那一塊（`fixed` 的座標仍以佈局視口為準，可視區相對它偏了 `offsetLeft / offsetTop`）。取法見 {@link visibleArea}。
 */

/** 一塊矩形區域（座標與 `position: fixed` 同一個參照）。 */
export interface Area {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 擺出來的位置。`maxHeight` 只在選單比能用的高度還高時給（選單裡滾）。 */
export interface Placement {
  left: number;
  top: number;
  maxHeight?: number;
}

/** 與可視區邊緣的留白。 */
export const MENU_MARGIN = 4;

/** 橫向：從 `preferred` 起放 `w` 寬；放不下用 `fallback`（翻到另一邊），還放不下就貼邊。 */
function fitX(preferred: number, fallback: number, w: number, area: Area, margin: number): number {
  const min = area.left + margin;
  const max = area.left + area.width - margin;
  if (preferred + w <= max) {
    return Math.max(min, preferred);
  }
  if (fallback >= min && fallback + w <= max) {
    return fallback;
  }
  return Math.max(min, max - w);
}

/**
 * 縱向：從 `preferred` 往下放 `h` 高；放不下且 `flip` 給了就試往上翻（以 `flip` 為下沿），還放不下就平移到貼著底邊；
 * 比整塊還高就頂著上邊緣壓高度。
 */
function fitY(preferred: number, flip: number | undefined, h: number, area: Area, margin: number): Pick<Placement, 'top' | 'maxHeight'> {
  const min = area.top + margin;
  const max = area.top + area.height - margin;
  const room = Math.max(0, max - min);
  if (h > room) {
    return { top: min, maxHeight: room };
  }
  if (preferred + h <= max) {
    return { top: Math.max(min, preferred) };
  }
  if (flip !== undefined && flip - h >= min) {
    return { top: flip - h };
  }
  return { top: max - h };
}

/**
 * 在點 (x, y) 彈一個 `w × h` 的選單（右鍵）。量不出尺寸（jsdom 裡 `offsetWidth` 恆為 0）時就貼著那一點。
 */
export function placeAtPoint(x: number, y: number, w: number, h: number, area: Area, margin = MENU_MARGIN): Placement {
  if (w <= 0 || h <= 0 || area.width <= 0 || area.height <= 0) {
    return { left: x, top: y };
  }
  return { left: fitX(x, x - w, w, area, margin), ...fitY(y, y, h, area, margin) };
}

/** 一個矩形（按鈕、父選單項）的四邊。 */
export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 貼著 `anchor` 彈：`below` 是標題欄下拉（按鈕下方、左對齊，右邊放不下往左收，只往下、放不下壓高度）；`side` 是子選單
 * （父選單項右邊、頂對齊，右邊放不下翻到父選單項左邊，再不行就貼邊蓋住一點父選單；下面放不下往上平移）。
 */
export function placeNear(anchor: Anchor, w: number, h: number, area: Area, mode: 'below' | 'side', margin = MENU_MARGIN): Placement {
  const near = mode === 'below' ? { x: anchor.left, y: anchor.bottom } : { x: anchor.right, y: anchor.top };
  if (w <= 0 || h <= 0 || area.width <= 0 || area.height <= 0) {
    return { left: near.x, top: near.y };
  }
  if (mode === 'below') {
    const left = fitX(anchor.left, anchor.right - w, w, area, margin);
    const max = area.top + area.height - margin;
    const top = Math.max(area.top + margin, anchor.bottom);
    return h > max - top ? { left, top, maxHeight: Math.max(0, max - top) } : { left, top };
  }
  return { left: fitX(anchor.right, anchor.left - w, w, area, margin), ...fitY(anchor.top, undefined, h, area, margin) };
}

/** 人眼看得到的那一塊（`fixed` 座標系裡）。有 `visualViewport` 用它，沒有就是整個視窗。 */
export function visibleArea(win: Window = window): Area {
  const vv = win.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
  }
  return { left: 0, top: 0, width: win.innerWidth || 0, height: win.innerHeight || 0 };
}
