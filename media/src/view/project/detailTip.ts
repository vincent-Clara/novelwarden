/**
 * 行內副標題（別名、設定關鍵詞等）的懸停浮窗。
 *
 * 別名太多時副標題會被 CSS 截斷（`max-width: 50%` + 省略號），正名不再被
 * 擠沒，但被省略號吃掉的別名只能靠這隻浮窗看全。
 *
 * 與 `summaryTip.ts` 的區別：
 * - **只展示不互動**：一行文字，沒有滾動、沒有選中複製，所以 `pointer-events:
 *   none`，滑鼠永遠落不進來，收起不需要寬限期。
 * - **只在真的截斷時才彈**：`scrollWidth > clientWidth` 才說明有內容被吃掉，
 *   全文都看得見時彈窗只是復讀一遍。
 *
 * 定位在 [../tip.ts](../tip.ts)，四隻浮窗共用一份。這裡傳 `minHeight: 0` 關掉
 * 「壓高度」那一步：浮窗只有一行、滾不動，壓出來的 max-height 等於把字截掉。
 *
 * **觸屏**：相容滑鼠事件不當懸停（`touch.ts`）；入口是長按那一行彈的選單最前面一項「看完整說明」（只在說明真的被截斷時
 * 給），彈出來是釘住的，按在別處就收。
 */
import { el as mk, closestFrom } from '../../dom';
import type { MenuContext, MenuItem } from '../../globals';
import { lastPointerWasTouch } from '../../touch';
import { onTouchPeek } from '../menu';
import { el } from '../refs';
import { closeOnOutsidePress, placeTip } from '../tip';

const HOVER_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;

let tip: HTMLElement | null = null;
/** 釘住的（觸屏的入口）：收起時撤掉「按在外面就收」的監聽。 */
let unpin: (() => void) | null = null;
/** 當前浮窗對應的副標題（浮窗開著時再次懸停它不該關掉重開）。 */
let tipTarget: HTMLElement | null = null;
/** 正在等延遲的那一個副標題（延遲到點時用它定位）。 */
let hoverTarget: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 文字真的被省略號截斷了嗎？全文可見就不必彈浮窗。 */
function isTruncated(node: HTMLElement): boolean {
  return node.scrollWidth > node.clientWidth;
}

/** 立刻收起。滾動 / Esc / 重渲染用這個，不給寬限。 */
export function hideDetailTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  hoverTarget = null;
  tipTarget = null;
  unpin?.();
  unpin = null;
  if (tip) {
    tip.remove();
    tip = null;
  }
}

/** 長按一行：這一行的說明被截斷了就給「看完整說明」。 */
function peekItems(at: MenuContext): MenuItem[] {
  const row = at.target?.closest<HTMLElement>('.row');
  const detail = row?.querySelector<HTMLElement>('.row-detail');
  if (!row || !detail || !el.projectBody.contains(row) || !isTruncated(detail)) {
    return [];
  }
  return [
    {
      label: '看完整說明',
      run: () => {
        hideDetailTip();
        if (detail.isConnected) {
          showTip(detail);
          unpin = tip ? closeOnOutsidePress(tip, hideDetailTip) : null;
        }
      },
    },
  ];
}

/** 滑鼠挪到別處：給一點寬限再收，滑鼠在副標題上微動不會閃。 */
function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideDetailTip();
  }, CLOSE_DELAY_MS);
}

/** 懸停在某個副標題上：截斷就延遲後彈浮窗，沒截斷就什麼都不做。 */
function scheduleShow(node: HTMLElement): void {
  // mouseover 在行內子元素之間移動時也會冒泡上來。浮窗正開著、或已經在
  // 為同一個副標題計時時都別重置——否則游標在字上微動一下就閃掉/無限延長。
  if (tipTarget === node || hoverTarget === node) {
    return;
  }
  hideDetailTip();
  if (!isTruncated(node)) {
    return;
  }
  hoverTarget = node;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延遲期間行可能被重渲染丟棄，那就不彈了。
    if (!hoverTarget?.isConnected) {
      hoverTarget = null;
      return;
    }
    showTip(hoverTarget);
    hoverTarget = null;
  }, HOVER_DELAY_MS);
}

/** 建出浮窗並貼在副標題的下方/上方。 */
function showTip(node: HTMLElement): void {
  const box = mk('div', 'detail-tip', node.textContent ?? '');
  document.body.appendChild(box);
  tip = box;
  tipTarget = node;
  placeTip(node, box, { minHeight: 0 });
}

export function installDetailTip(): void {
  // 事件委託掛在 projectBody 上：樹每次重渲染都換掉全部行，
  // 逐行 addEventListener 會隨重渲染次數堆積（與 summaryTip 同一套取捨）。
  onTouchPeek(peekItems);

  el.projectBody.addEventListener('mouseover', (e) => {
    // 手指點一下之後補發的相容滑鼠事件不是懸停；釘住的浮窗也不跟滑鼠走。
    if (lastPointerWasTouch() || unpin) {
      return;
    }
    const detail = closestFrom<HTMLElement>(e.target, '.row-detail');
    if (detail) {
      scheduleShow(detail);
    } else if (tip || hoverTimer) {
      scheduleHide();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    if (!lastPointerWasTouch() && !unpin) {
      hideDetailTip();
    }
  });

  // 右鍵選單彈出來時浮窗該讓路，兩個都是 fixed 會疊在一起。
  el.projectBody.addEventListener('contextmenu', hideDetailTip);

  // 浮窗是 fixed 的，頁面一滾就和目標行脫節（與右鍵選單同一個理由）。
  // 捕獲階段才收得到內部容器（.project-body）的滾動。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!tip?.contains(e.target as Node)) {
        hideDetailTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideDetailTip();
    }
  });
}
