/**
 * 段落聚焦（「檢視 → 專注 → 段落聚焦」，開關在 `focus.ts`）：游標所在那一段照常顯示，其餘的變淡。只對正文
 * （`isProse`：章節與草稿）——分段是按工程的分段格式認的（`focusCore.ts` 的 `paragraphRangeAt`），那是正文的設定。
 *
 * ## 做法（⚑）
 *
 * textarea 只有一種文字顏色，畫不出「這一段深、別處淡」。於是：
 *
 * 1. textarea 的字整體調淡（`.ed-area.ed-para-dim`：前景色 × 30% 的**半透明**色，游標顏色不變）；
 * 2. 高亮映象層開一個命名圖層 `focus`（`setHighlights`，**不另起一層映象**），把當前那一段包進
 *    `<mark class="ed-hl-focus">`，這一層的 `<mark>` 用**實色**畫字（`highlight.css`）——映象層在 textarea 底下，
 *    同一個位置、同一個字形，半透明的淡字疊在實色字上看起來就是實色，別處只有淡字。
 *
 * 游標、選區、輸入法、點選、右鍵仍然全是 textarea 自己的，一樣都不受影響。代價：
 *
 * - 當前那一段畫了兩遍（淡的疊在實的上面），筆畫邊緣略重一點；映象層萬一與 textarea 差了半個畫素，這一段會有
 *   一點重影（其餘段落不受影響）。映象層與 textarea 讀同一組排版變數、每次重畫都抄計算樣式，正是為了不差。
 * - 映象層每次改動都要重畫一遍全文（查詢開著時本來也是這樣）。超過 30 萬字不畫——那時**不調淡**，整篇照常顯示，
 *   不會出現「全是淡字」。
 *
 * 另一條路是 textarea 文字全透明、由映象層畫全部文字：那樣游標會畫在一層看不見的字上、輸入法組字時的拼音也是
 * 透明的，對不齊時游標與字錯位——代價大得多，不取。
 *
 * ## 什麼時候重算
 *
 * - 改了字（`edit`，含組字中途）：等這一下的同步訂閱都跑完（`highlight.ts` 會先把各層平移、壓在改動上的丟掉），
 *   在微任務裡按新文字重算並 `setHighlights`——當場重畫，瀏覽器兩次繪製之間只畫一次，不閃。
 * - 游標挪了（鍵盤、滑鼠、`selectionchange`）：段落變了才重畫。
 * - 換了檔案、切了預覽（`render`）：重算。
 */
import { isProse, onEditorChange } from './api';
import type { Pane } from './api';
import { paragraphRangeAt } from './focusCore';
import type { TextRange } from './focusCore';
import { clearHighlights, setHighlights, tooLargeToHighlight } from './highlight';
import { paragraphStyle } from './paragraphState';
import { panes } from './store';
import { caretOf } from './typewriter';

/** 高亮映象層上的圖層名與那一段 `<mark>` 的 class。 */
export const FOCUS_LAYER = 'focus';
const CLS_FOCUS = 'ed-hl-focus';
/** textarea 上的字調淡。 */
const CLS_DIM = 'ed-para-dim';

export function installParagraphFocus(enabled: () => boolean): { refresh(): void } {
  /** 每塊編輯區上一次畫的是哪個檔案的哪一段。 */
  const drawn = new Map<Pane, { path: string; range: TextRange }>();
  const hooked = new WeakSet<Pane>();
  const pending = new Set<Pane>();

  function applies(pane: Pane): boolean {
    const file = pane.activeFile();
    return enabled() && !!file && isProse(file) && !pane.isPreviewing() && !tooLargeToHighlight(pane.area.value);
  }

  function off(pane: Pane): void {
    pane.area.classList.remove(CLS_DIM);
    if (drawn.delete(pane)) {
      clearHighlights(pane, FOCUS_LAYER);
    }
  }

  /** 按游標重算這一塊的當前段。`force`：圖層可能已經被平移 / 丟掉了（改過字），照畫不誤。 */
  function update(pane: Pane, force = false): void {
    if (!applies(pane)) {
      off(pane);
      return;
    }
    const area = pane.area;
    const path = pane.activePath!;
    const range = paragraphRangeAt(area.value, caretOf(area), paragraphStyle());
    const prev = drawn.get(pane);
    if (!force && prev && prev.path === path && prev.range.start === range.start && prev.range.end === range.end) {
      return;
    }
    drawn.set(pane, { path, range });
    setHighlights(pane, FOCUS_LAYER, [{ start: range.start, end: range.end, cls: CLS_FOCUS }]);
    area.classList.add(CLS_DIM);
  }

  /** 這一下的同步訂閱都跑完之後再算（`highlight.ts` 先平移各層，之後才輪到這裡落新的一段）。 */
  function updateSoon(pane: Pane): void {
    if (pending.size === 0) {
      queueMicrotask(() => {
        const list = [...pending];
        pending.clear();
        for (const p of list) {
          update(p, true);
        }
      });
    }
    pending.add(pane);
  }

  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    const onCaret = (): void => {
      if (enabled()) {
        update(pane);
      }
    };
    for (const evt of ['keyup', 'mouseup', 'select', 'focus'] as const) {
      pane.area.addEventListener(evt, onCaret);
    }
  }

  // 游標挪了（按住方向鍵時一路都有）：textarea 有焦點時 document 上的 selectionchange 就是它的。
  document.addEventListener('selectionchange', () => {
    if (!enabled()) {
      return;
    }
    const pane = Object.values(panes).find((p) => p.area === document.activeElement);
    if (pane) {
      update(pane);
    }
  });

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      const prev = drawn.get(ev.pane);
      // 換了檔案：映象層已經把上一個檔案的圖層全清了，照畫；同一個檔案只在段落變了時重畫。
      update(ev.pane, !!prev && prev.path !== ev.pane.activePath);
      return;
    }
    if (enabled() && ev.file === ev.pane.activeFile()) {
      updateSoon(ev.pane);
    }
  });

  return {
    refresh(): void {
      for (const pane of Object.values(panes)) {
        if (enabled()) {
          update(pane, true);
        } else {
          off(pane);
        }
      }
    },
  };
}
