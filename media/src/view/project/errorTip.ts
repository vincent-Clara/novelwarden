/**
 * 失敗標記的懸停浮窗。
 *
 * 工程頁的行上掛著一個感嘆號（`rows.ts` 建的 `.row-failure`），滑鼠移上去
 * 才說清「哪一步失敗了、卡有沒有被改、下次會不會重來」。
 *
 * 為什麼不用 `title` 屬性了事：原生 tooltip 不換行、延遲不可控、而且**選不中**
 * ——失敗資訊裡常有模型返回的片段，使用者要複製它去搜。
 *
 * 與另外兩隻浮窗的取捨：
 * - 不像 `detailTip.ts`（`pointer-events: none`，只復讀一行被截斷的副標題）：
 *   這裡是多行、要能選中複製，所以**滑鼠必須進得來**，於是收起要留寬限期
 *   ——從行挪到浮窗要跨一道縫，那一兩幀滑鼠既不在行上也不在浮窗上。
 * - 不像 `summaryTip.ts` 要向後端單取資料：失敗記錄已經隨 `ProjectTree.failures`
 *   全量推過來了（每條幾十字、只有出錯的目標才有），直接讀快取即可。
 *
 * 定位在 [../tip.ts](../tip.ts)，四隻浮窗共用一份。
 *
 * **觸屏**：相容滑鼠事件不當懸停（`touch.ts`）。兩個入口，彈出來都是釘住的（按在外面才收）：手指點感嘆號本身
 * （點的就是這個標記、看的就是它，不跳到別處），以及長按那一行彈的選單最前面一項「看失敗原因」。
 */
import { el as mk, closestFrom } from '../../dom';
import type { MenuContext, MenuItem } from '../../globals';
import type { FailureView } from '../../protocol';
import { isTouchEvent, lastPointerWasTouch } from '../../touch';
import { logTime } from '../format';
import { onTouchPeek } from '../menu';
import { el } from '../refs';
import { closeOnOutsidePress, placeTip } from '../tip';
import { lastTree } from './treeState';

const HOVER_DELAY_MS = 300;
/** 收起的寬限期：夠滑鼠從行跨到浮窗，又不至於讓它賴著不走。 */
const CLOSE_DELAY_MS = 200;

/** `unpin` 有值說明是釘住的（觸屏的入口）。 */
let tip: { key: string; box: HTMLElement; unpin?: () => void } | null = null;
/** 正在等延遲的那個感嘆號（延遲到點時用它定位）。 */
let hoverTarget: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 立刻收起。滾動 / Esc / 右鍵 / 重渲染用這個，不給寬限。 */
export function hideFailureTip(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  cancelScheduledHide();
  hoverTarget = null;
  if (tip) {
    tip.unpin?.();
    tip.box.remove();
    tip = null;
  }
}

function scheduleHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    hideFailureTip();
  }, CLOSE_DELAY_MS);
}

function cancelScheduledHide(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/** 懸停在某個感嘆號上：延遲後彈浮窗。 */
function scheduleShow(node: HTMLElement): void {
  const key = node.dataset.failureKey ?? '';
  if (!key) {
    return;
  }
  // mouseover 在行內子元素之間移動時也會冒泡上來。已經為它開著浮窗、或已經
  // 在為它計時了就什麼都別做——否則游標微動一下就重置延遲，浮窗永遠彈不出來。
  if (tip?.key === key || hoverTarget === node) {
    return;
  }
  hideFailureTip();
  hoverTarget = node;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    // 延遲期間行可能被重渲染丟棄，那就不彈了。
    if (!hoverTarget?.isConnected) {
      hoverTarget = null;
      return;
    }
    const target = hoverTarget;
    hoverTarget = null;
    const failures = lastTree?.failures?.[key];
    if (!failures || failures.length === 0) {
      return;
    }
    showTip(target, key, failures);
  }, HOVER_DELAY_MS);
}

function showTip(node: HTMLElement, key: string, failures: FailureView[]): void {
  const box = mk('div', 'failure-tip');
  box.appendChild(buildBody(failures));
  // 滑鼠進了浮窗就別收——使用者正在讀，或者要選中複製。
  box.addEventListener('mouseenter', cancelScheduledHide);
  box.addEventListener('mouseleave', () => {
    if (!tip?.unpin) {
      scheduleHide();
    }
  });
  document.body.appendChild(box);
  tip = { key, box };
  placeTip(node, box);
}

/** 釘住一隻失敗浮窗（觸屏：點感嘆號、長按選單裡的「看失敗原因」）。 */
function pinFailureTip(mark: HTMLElement): void {
  hideFailureTip();
  const key = mark.dataset.failureKey ?? '';
  const failures = lastTree?.failures?.[key];
  if (!key || !failures || failures.length === 0 || !mark.isConnected) {
    return;
  }
  showTip(mark, key, failures);
  if (tip) {
    tip.unpin = closeOnOutsidePress(tip.box, hideFailureTip);
  }
}

/** 長按一行：這一行掛著失敗標記就給「看失敗原因」。 */
function peekItems(at: MenuContext): MenuItem[] {
  const row = at.target?.closest<HTMLElement>('.row');
  const mark = row?.querySelector<HTMLElement>('.row-failure');
  if (!row || !mark || !el.projectBody.contains(row)) {
    return [];
  }
  return [{ label: '看失敗原因', run: () => pinFailureTip(mark) }];
}

function buildBody(failures: FailureView[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const failure of failures) {
    const item = mk('div', 'failure-tip-item');

    const head = mk('div', 'failure-tip-head');
    head.appendChild(
      mk(
        'span',
        `failure-tip-badge failure-${failure.severity}`,
        failure.severity === 'error' ? '未改動' : '部分完成'
      )
    );
    head.appendChild(mk('span', 'failure-tip-time', logTime(failure.at)));
    item.appendChild(head);

    // textContent（mk 內部就是）而非 innerHTML：這些文字裡有模型返回的片段。
    item.appendChild(mk('div', 'failure-tip-msg', failure.message));
    if (failure.detail) {
      item.appendChild(mk('div', 'failure-tip-detail', failure.detail));
    }
    frag.appendChild(item);
  }
  frag.appendChild(mk('div', 'hint failure-tip-foot', '成功一次後這個標記會自動消失。日誌頁有完整記錄。'));
  return frag;
}

export function installFailureTip(): void {
  // 事件委託掛在 projectBody 上：樹每次重渲染都換掉全部行，逐行
  // addEventListener 會隨重渲染次數堆積（與另兩隻浮窗同一套取捨）。
  onTouchPeek(peekItems);

  // 手指點感嘆號：看的就是這個標記，釘住它的浮窗（滑鼠點它不做事，懸停就看得到）。
  el.projectBody.addEventListener('click', (e) => {
    const mark = closestFrom<HTMLElement>(e.target, '.row-failure');
    if (mark && isTouchEvent(e)) {
      e.stopPropagation();
      pinFailureTip(mark);
    }
  });

  el.projectBody.addEventListener('mouseover', (e) => {
    // 手指點一下之後補發的相容滑鼠事件不是懸停；釘住的浮窗也不跟滑鼠走。
    if (lastPointerWasTouch() || tip?.unpin) {
      return;
    }
    const mark = closestFrom<HTMLElement>(e.target, '.row-failure');
    if (mark) {
      cancelScheduledHide();
      scheduleShow(mark);
    } else if (tip) {
      // 挪到了別處：給寬限而不是立刻收——滑鼠要去浮窗的話，半路會先掃過
      // 感嘆號下方的那道縫。
      scheduleHide();
    } else if (hoverTimer) {
      hideFailureTip();
    }
  });

  el.projectBody.addEventListener('mouseleave', () => {
    if (lastPointerWasTouch() || tip?.unpin) {
      return;
    }
    if (tip) {
      scheduleHide();
    } else {
      hideFailureTip();
    }
  });

  // 右鍵選單彈出來時浮窗該讓路，兩個都是 fixed 會疊在一起。
  el.projectBody.addEventListener('contextmenu', hideFailureTip);

  // 浮窗是 fixed 的，頁面一滾就和目標脫節。但**浮窗自己內部的滾動不算**
  // （詳情可能好幾行，一滾就收等於捲軸形同虛設）。捕獲階段才收得到
  // 內部容器（.project-body）的滾動。
  document.addEventListener(
    'scroll',
    (e) => {
      if (!tip?.box.contains(e.target as Node)) {
        hideFailureTip();
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideFailureTip();
    }
  });
}
