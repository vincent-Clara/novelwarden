/**
 * 衝突條上的「對比合併…」（放第一個，主要動作；原來那兩顆「用磁碟版本覆蓋編輯器」「用編輯器內容強制儲存」
 * 留著）。從前儲存撞上衝突只能整份二選一，看不到兩邊差在哪。
 *
 * 點下去把編輯器裡的這一份發給後端（`mergeWithDisk`）；後端讀磁碟上此刻的那一份，開合併檢視（左邊磁碟上的、
 * 右邊編輯器裡的，逐處挑、可以手改）。作者點「放回編輯器」之後後端回 `editorReplace`（帶 `base`），
 * `replace.ts` 換內容（一步撤銷）、把樂觀鎖基線換成磁碟那份、收起衝突條——這時它仍是未儲存，照常 Ctrl+S，
 * 不必強制儲存。放棄或關掉合併檢視：什麼都不變。
 *
 * 按鈕不寫進 `page.ts` / `createPaneElements`：與「排版」按鈕（`layout.ts`）同一個做法，每塊編輯區第一次
 * 重畫時插進它的衝突條（`.ed-conflict`，說明文字後面），兩塊編輯區走同一條路，`pane.ts` 不必知道它。
 * 衝突條顯隱、說明文字仍歸 `pane.ts`。磁碟上已經沒有這一份（`OpenFile.gone`）時衝突條也亮著（說的是「被刪或
 * 改名」），那時沒有磁碟版本可合併，這顆藏起來。
 */
import { el } from '../dom';
import type { InMessage } from '../protocol';
import { onEditorChange } from './api';
import type { Pane } from './api';
import { newRequestId } from './replace';

export function installConflictMerge(post: (msg: InMessage) => void): void {
  const buttons = new WeakMap<Pane, HTMLButtonElement>();
  onEditorChange((ev) => {
    if (ev.type !== 'render') {
      return;
    }
    const pane = ev.pane;
    let btn = buttons.get(pane);
    if (!btn) {
      const bar = pane.root.querySelector<HTMLElement>('.ed-conflict');
      if (!bar) {
        return;
      }
      btn = el('button', 'chip-btn ed-conflict-merge', '對比合併…');
      btn.type = 'button';
      btn.title = '左邊磁碟上的、右邊編輯器裡的，逐處挑、可以手改；放回編輯器之後照常儲存';
      btn.addEventListener('click', () => {
        const file = pane.activeFile();
        if (file && !file.gone) {
          post({ type: 'mergeWithDisk', path: file.path, text: file.draft, requestId: newRequestId('merge') });
        }
      });
      const text = bar.querySelector('.ed-conflict-text');
      bar.insertBefore(btn, text ? text.nextSibling : bar.firstChild);
      buttons.set(pane, btn);
    }
    // 磁碟上已經沒有這一份（`OpenFile.gone`，衝突條這時說的是「被刪或改名」）：沒有磁碟版本可合併，藏起來——
    // 與「用磁碟版本覆蓋編輯器」同一個判法。
    btn.classList.toggle('hidden', !!pane.activeFile()?.gone);
  });
}
