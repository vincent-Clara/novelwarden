/**
 * 打字機滾動（「檢視 → 專注 → 打字機滾動」，開關在 `focus.ts`）：開著時，游標所在那一行始終停在編輯區垂直
 * 中間附近——打字、回車、撤銷、方向鍵 / 翻頁 / Home / End 移動之後，下一幀滾過去。
 *
 * - **游標的畫素位置借高亮映象層量**（`highlight.ts` 的 `measureOffset`：在那份看不見的映象裡排出游標之前的文字，
 *   量標記的 `offsetTop`）。不另起測量 DOM——另起一份就得再抄一遍排版，對不齊的地方會翻倍。量不了（文字超過
 *   30 萬字、textarea 藏著）就不滾。該滾到哪是 `focusCore.ts` 的 `typewriterScrollTop`（純函式）。
 * - **輸入法組字中途不滾**：組字中的 `edit` 不帶 `change`，不認；上屏那一下（帶 `change`）才滾。方向鍵在組字中
 *   是挑候選詞，`isImeComposing` 的也不認。
 * - **用滾輪翻看前文時不拉回來**：只對輸入與鍵盤移動游標做反應，不聽 `scroll`，也不聽滑鼠點選——翻上去看、
 *   點一下選個字都不動；下一次打字才回到游標那裡。
 * - **只在焦點在這塊正文裡時滾**：磁碟上的新版就地換進來（程式改寫）、別處觸發的改寫，游標並不在人眼前，不替他滾。
 * - 開啟時 `<body>` 掛 `nf-typewriter`：編輯區底下多墊半屏（`--nf-ed-pad-bottom`，映象層用同一個變數），
 *   最後一行也滾得到中間。
 */
import { isImeComposing, onEditorChange } from './api';
import type { Pane } from './api';
import { typewriterScrollTop } from './focusCore';
import { cancelFrame, measureOffset, nextFrame } from './highlight';
import { activePane } from './store';

/** 移動游標、之後要滾過去的鍵。 */
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/** 游標那一頭（有選區時是正在拖的那一頭）。 */
export function caretOf(area: HTMLTextAreaElement): number {
  return area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd;
}

export function installTypewriter(enabled: () => boolean): { refresh(): void } {
  const frames = new Map<Pane, number>();
  const hooked = new WeakSet<Pane>();

  function schedule(pane: Pane): void {
    if (frames.has(pane)) {
      return;
    }
    frames.set(
      pane,
      nextFrame(() => {
        frames.delete(pane);
        center(pane);
      })
    );
  }

  function center(pane: Pane): void {
    const area = pane.area;
    if (!enabled() || !pane.activeFile() || pane.isPreviewing() || document.activeElement !== area) {
      return;
    }
    const pos = measureOffset(pane, caretOf(area));
    if (!pos) {
      return;
    }
    const top = typewriterScrollTop(pos.top, pos.height, area.clientHeight, area.scrollTop);
    if (top !== undefined) {
      area.scrollTop = top;
    }
  }

  /** 每塊編輯區第一次重畫時掛上方向鍵那一下（兩塊共用這一份）。 */
  function hook(pane: Pane): void {
    if (hooked.has(pane)) {
      return;
    }
    hooked.add(pane);
    pane.area.addEventListener('keydown', (e) => {
      if (enabled() && !isImeComposing(e) && NAV_KEYS.has(e.key)) {
        // keydown 時游標還沒動，下一幀（瀏覽器挪完游標之後）再量。
        schedule(pane);
      }
    });
  }

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      return;
    }
    if (!enabled() || ev.file !== ev.pane.activeFile()) {
      return;
    }
    // 組字中途（拼音還沒上屏）不帶 change：不滾，上屏那一下再滾。
    if (ev.source === 'composition' && !ev.change) {
      return;
    }
    schedule(ev.pane);
  });

  return {
    refresh(): void {
      const on = enabled();
      document.body.classList.toggle('nf-typewriter', on);
      if (on && activePane) {
        schedule(activePane);
      } else if (!on) {
        for (const handle of frames.values()) {
          cancelFrame(handle);
        }
        frames.clear();
      }
    },
  };
}
