/**
 * 「不丟稿」那幾樣的裝配入口：`index.ts` 啟動時調一次 {@link installSaveSafety}。
 *
 * | 模組 | 管什麼 |
 * |---|---|
 * | `diskSync.ts` | 磁碟上的改動同步到已開的標籤（`checkEditorFiles` ↔ `editorDiskChanged` / `editorDiskGone`） |
 * | `saving.ts` | 儲存本身：同一份只有一個在路上、狀態列的儲存狀態、磁碟上沒了先問、自動儲存的閘 |
 * | `closing.ts` | 關標籤時問「儲存 / 不儲存 / 取消」，批次關閉合成一次 |
 * | `dialog.ts` | 頁內對話方塊（編輯器裡不再用 `window.confirm`） |
 * | `autosave.ts` | 自動儲存（預設關）：停筆 2 秒、切標籤、視窗失焦 |
 *
 * `pane.ts` 只認 `saving.ts` / `closing.ts` / `dialog.ts` 的幾個函式；收訊息與定時都在這幾個模組自己身上。
 */
import { installAutoSave } from './autosave';
import { installDiskSync } from './diskSync';
import { installSaving } from './saving';

export function installSaveSafety(): void {
  installSaving();
  installDiskSync();
  installAutoSave();
}
