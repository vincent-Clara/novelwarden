/**
 * 懸停浮窗的定位。四隻浮窗共用這一份幾何：章節細綱、行內副標題、失敗標記
 * （`view/project/` 下那三隻）與創作頁的「當前產物」（`view/workbench.ts`）。
 *
 * 它們都掛在 body 上 `position: fixed`——工程頁與訊息流各有內部滾動，掛在行裡
 * 會被容器裁掉。代價是位置得自己算，而這套演算法此前在三個檔案裡各抄了一遍：
 *
 * - 橫向左對齊目標，右邊溢位就往左收，最左不越過邊距。
 * - 縱向優先放目標下方（順著視線），放不下翻到上方；**兩邊都放不下時選空間
 *   大的那一側，並把高度壓進那點空間**——內容可以滾，但絕不能長到螢幕外面去。
 *   只翻轉不壓高度的話，一份長細綱在矮視窗裡會有一截永遠夠不到。
 *
 * `minHeight: 0` 關掉壓高度那一步：`detail-tip` 只復讀一行被截斷的副標題，
 * 它 `pointer-events: none`、滾不動，壓出來的 max-height 等於把字截掉。
 */

export interface PlaceTipOptions {
  /** 浮窗與目標之間的縫。 */
  gap?: number;
  /** 與視口邊緣的留白。 */
  margin?: number;
  /** 壓高度時的下限：再擠也得看得見一行字。給 0 表示不壓高度。 */
  minHeight?: number;
}

/** 把 `box` 貼在 `anchor` 的下方/上方，並保證它整個落在視口內。 */
export function placeTip(anchor: Element, box: HTMLElement, opts: PlaceTipOptions = {}): void {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 8;
  const minHeight = opts.minHeight ?? 48;

  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  // 先撤掉上一次的限制再量，否則會一直沿用之前那個更矮的值。
  // 量到的「自然高度」已經含 CSS 裡 60vh 的可讀性上限。
  if (minHeight > 0) {
    box.style.maxHeight = '';
  }
  const natural = box.offsetHeight;

  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const putBelow = natural <= below || below >= above;
  if (minHeight > 0) {
    // 視窗特別矮時算出來的空間可能是 0 甚至負數，直接拿去當 max-height 會得到
    // 一個看不見的浮窗。給一個下限，寧可稍微出界一點也得留得住內容。
    const room = Math.max(minHeight, putBelow ? below : above);
    if (natural > room) {
      box.style.maxHeight = `${room}px`;
    }
  }

  // 壓過高度之後才量得到最終高度，上翻時要用它算 top。
  const h = box.offsetHeight;
  const top = putBelow ? r.bottom + gap : Math.max(margin, r.top - h - gap);

  const w = box.offsetWidth;
  let left = r.left;
  if (w > 0 && left + w > vw - margin) {
    left = vw - w - margin;
  }
  if (left < margin) {
    left = margin;
  }

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

/**
 * 釘住的浮窗（觸屏上的入口：長按選單裡的「看一眼」、點失敗的感嘆號）：手指沒有「移開」，收起改成**按在浮窗外面**
 * （捕獲階段的 `pointerdown`，按在浮窗裡——滾動、選字——不算）。返回撤掉監聽的函式；浮窗收起時調它。
 * Esc、頁面滾動、右鍵照舊由各只浮窗自己收。
 */
export function closeOnOutsidePress(box: HTMLElement, close: () => void): () => void {
  const onDown = (e: Event): void => {
    if (!box.contains(e.target as Node)) {
      close();
    }
  };
  // 推到下一輪再掛：釘住它的那一下（選單項的 click）之前那個 pointerdown 早過去了，但同一輪裡接著到的事件不該把它收掉。
  const timer = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onDown, true);
  };
}
