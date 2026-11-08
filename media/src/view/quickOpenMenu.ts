/**
 * 標題欄「檔案」選單的「轉到…」（獨立版，緊跟在「開啟檔案…」後面）：開啟內建編輯器的「轉到」面板
 * （`editor/quickOpen.ts`，與 Ctrl+P 同一件事）。能不能用問編輯器（`nf-quickopen-query`）——沒開啟工程時置灰，
 * 原因掛在提示上。與 `versionsMenu.ts` 同一個做法：經 `MenuEntry.run` 接進 `menubar`。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandQuickOpen, queryQuickOpen } from '../globals';
import type { MenuEntry } from './menubar';

export function quickOpenMenuEntry(): MenuEntry {
  const status = queryQuickOpen();
  return {
    label: '轉到…',
    kbd: shortcutLabel('quickOpen'),
    disabled: !status.available,
    detail: status.available ? '按章號、標題、角色名、設定或路徑轉到一章或一個檔案' : status.reason,
    run: () => commandQuickOpen('open'),
  };
}
