/**
 * `editorReplace`（「把編輯區裡這份檔案換成這段文字」）的接收端，衝突條的「對比合併…」（`conflictMerge.ts`）用；
 * 「版本」側欄與對比標籤的「恢復整份」也走這裡的 {@link replaceInEditor}。
 *
 * - **只認自己發出去的 `requestId`**：回覆是廣播，同一個工程開著兩個視窗時，另一個視窗裡那一份不該被換掉。
 * - **換內容只走 `Pane.applyEdit`**（`api.ts` 的硬規矩）：整份換掉也只記一步撤銷，成為未儲存，**不寫盤**。
 * - **帶 `base` 時先 `rebase` 再換內容**：樂觀鎖基線換成磁碟上那一份、衝突條收起；順序反過來的話，換內容
 *   那一刻的髒標記與標籤圓點是對著舊基線算的。
 */
import { toast } from '../globals';
import type { OutMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { paneOwning } from './store';

type ReplaceMessage = Extract<OutMessage, { type: 'editorReplace' }>;

/** 本頁發出去、還在等回話的請求。放棄合併時後端不回話，那幾個就一直留著——幾個字串，不值得清。 */
const pending = new Set<string>();
let seq = 0;

/** 給一次要等 `editorReplace` / `versionText` 回話的請求起個名字，並記下「這是我發的」。 */
export function newRequestId(prefix: string): string {
  const id = `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  pending.add(id);
  return id;
}

/** 這個 `requestId` 是不是本頁發的（認過一次就劃掉）。 */
export function claimRequest(id: string): boolean {
  return pending.delete(id);
}

export type ReplaceResult = 'changed' | 'unchanged' | 'closed';

/**
 * 把開著的這份檔案的內容整份換成 `text`（一步撤銷，不寫盤）。給了 `base` 就先換樂觀鎖基線、收衝突條。
 * 檔案不在當前標籤上（或在預覽裡）時先切過去——`applyEdit` 作用於那塊編輯區的當前檔案。
 */
export function replaceInEditor(path: string, text: string, base?: { text: string; hash: string }): ReplaceResult {
  const pane = paneOwning(path);
  if (!pane) {
    return 'closed';
  }
  if (base) {
    pane.rebase(path, base.text, base.hash);
  }
  if (pane.activePath !== path) {
    pane.activate(path);
  }
  pane.setPreviewing(false);
  return pane.applyEdit(0, pane.area.value.length, text) ? 'changed' : 'unchanged';
}

function handle(msg: ReplaceMessage): void {
  if (!claimRequest(msg.requestId)) {
    return;
  }
  const result = replaceInEditor(msg.path, msg.text, msg.base);
  if (result === 'closed') {
    toast('這份檔案已經關掉了，沒有放回編輯區。', true);
    return;
  }
  const file = paneOwning(msg.path)?.files.get(msg.path);
  const dirty = !!file && file.draft !== file.text;
  if (msg.base) {
    toast(dirty ? '已放回編輯區：還沒儲存，照常 Ctrl+S 儲存即可（不必強制儲存）。' : '已放回編輯區，與磁碟上的一致，不用再存。');
  } else {
    toast(result === 'changed' ? '已放回編輯區：還沒儲存，Ctrl+Z 可以退回。' : '編輯區內容沒有變化。');
  }
}

export function installEditorReplace(): void {
  onMessage((msg) => {
    if (msg.type === 'editorReplace') {
      handle(msg);
    }
  });
}
