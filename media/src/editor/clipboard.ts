/**
 * 正文區右鍵選單的剪下 / 複製 / 貼上。
 *
 * 之所以要自己實現這三樣：全域 `contextmenu` 監聽無條件 `preventDefault()`
 * （選單風格統一），原生的複製/貼上選單不會出現，代價就是這裡得補回來。
 *
 * - **複製**不改正文：優先 `execCommand('copy')`（同步、在使用者手勢裡最穩），不行再 Clipboard API。
 * - **剪下 / 貼上**要改正文，一律經 `Pane.applyEdit`——編輯區唯一的程式改寫入口，記一步撤銷、
 *   更新髒標記與草稿。從前這裡優先 `execCommand('cut' / 'insertText')` 是為了保住 textarea 的
 *   原生撤銷棧；撤銷現在由編輯器自己記（`history.ts`），這條理由沒了，直接拼 `value` 的兜底更是
 *   會繞過記賬，一併刪掉。
 *
 * 鍵盤上的 Ctrl+X / Ctrl+V 不經這裡：瀏覽器自己改 textarea、發 `input`，由 `pane.ts` 照常記賬。
 */
import { toast } from '../globals';
import type { Pane } from './store';

/** 複製選中的文字。返回是否交給了剪貼簿（非同步寫入事後失敗只會提示，返回時還不知道）。 */
export function areaCopy(area: HTMLTextAreaElement): boolean {
  area.focus();
  if (document.execCommand?.('copy')) {
    return true;
  }
  const text = area.value.slice(area.selectionStart, area.selectionEnd);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => toast('複製失敗，請手動選中複製。', true));
    return true;
  }
  toast('當前環境不支援剪貼簿。', true);
  return false;
}

/** 剪下：先複製，複製交出去了才刪——剪下丟字比不剪下糟得多（刪了也能撤銷回來）。 */
export function areaCut(pane: Pane): void {
  const area = pane.area;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  if (start === end || !areaCopy(area)) {
    return;
  }
  pane.applyEdit(start, end, '');
}

export async function areaPaste(pane: Pane): Promise<void> {
  if (!navigator.clipboard?.readText) {
    toast('當前環境不支援剪貼簿讀取。', true);
    return;
  }
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('貼上失敗：瀏覽器未授權剪貼簿讀取。', true);
    return;
  }
  const area = pane.area;
  area.focus();
  pane.applyEdit(area.selectionStart, area.selectionEnd, text);
}
