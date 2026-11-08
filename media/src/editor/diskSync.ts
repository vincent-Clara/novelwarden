/**
 * 磁碟上的改動同步到已開的標籤。
 *
 * 後端從前只在 `openFile` 時推 `editorOpen`；定稿寫回細綱、批次寫章、外部 agent 經 MCP 的 `edit`、外部編輯器 /
 * git 改了檔案，watcher 只觸發 `pushState` 刷介面，編輯器裡還是舊內容——作者改兩筆一儲存就撞衝突。
 *
 * - **什麼時候核對**：每收到一條 `state` / `init`（每次磁碟變動後的 `pushState` 都會推，哪個頁籤都推）就去抖
 *   {@link DISK_SYNC_DELAY_MS}，視窗重新拿到焦點、頁面重新可見時也來一次；把兩塊編輯區裡**所有開啟的檔案**的
 *   `{ path, hash }` 發給後端（`checkEditorFiles`）。`hash` 是 `Pane.knownDiskHash`：已刪除的給空串，見過一份
 *   沒載入的磁碟新版就給那一份的（同一個新版不再報一次）。正在儲存的那幾份不帶——以儲存的回執為準。
 * - **回話**：`editorDiskChanged` 交給擁有它的那一塊 `applyDiskChange`（沒改過的就地換、改過的掛衝突條，
 *   不切標籤、不搶焦點）；`editorDiskGone` 交給 `markGone`（標成已刪除）。自己那次儲存還在路上時收到的
 *   「變了」不認：多半是讀到了自己剛寫下去的那一份，回執會說清楚。
 *
 * **自己儲存之後不誤報**：`editorSaved` 先到（基線換成新的 hash）、`state` 後到（WebSocket 保證順序），
 * 於是這之後核對時帶的就是新 hash。
 */
import type { EditorFileCheck } from '../protocol';
import { onMessage } from '../vscodeApi';
import { isSaving } from './saving';
import { paneOwning, panes, postToHost } from './store';

/** 收到 `state` 之後等多久再核對：一次磁碟變動常常連著推好幾條。 */
export const DISK_SYNC_DELAY_MS = 400;

export function installDiskSync(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(check, DISK_SYNC_DELAY_MS);
  };

  onMessage((msg) => {
    if (msg.type === 'state' || msg.type === 'init') {
      schedule();
    } else if (msg.type === 'editorDiskChanged') {
      if (!isSaving(msg.file.path)) {
        paneOwning(msg.file.path)?.applyDiskChange(msg.file);
      }
    } else if (msg.type === 'editorDiskGone') {
      paneOwning(msg.path)?.markGone(msg.path);
    }
  });

  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedule();
    }
  });
}

/** 把開著的檔案報給後端核對。一個都沒開就不發。 */
function check(): void {
  const files: EditorFileCheck[] = [];
  for (const pane of Object.values(panes)) {
    for (const path of pane.files.keys()) {
      if (!isSaving(path)) {
        files.push({ path, hash: pane.knownDiskHash(path) });
      }
    }
  }
  if (files.length > 0) {
    postToHost({ type: 'checkEditorFiles', files });
  }
}
