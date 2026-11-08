/**
 * 標題欄「編輯」選單的「全書查詢替換…」（獨立版，緊跟在「查詢」「替換」後面）：開啟內建編輯器的全書查詢替換面板
 * （`editor/bookFind.ts`，與 Ctrl+Shift+F 同一件事）。能不能用問編輯器（`nf-bookfind-query`）——沒開啟工程時置灰，
 * 原因掛在提示上。與 `quickOpenMenu.ts` 同一個做法：經 `MenuEntry.run` 接進 `menubar`。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandBookFind, queryBookFind } from '../globals';
import type { MenuEntry } from './menubar';

export function bookFindMenuEntry(): MenuEntry {
  const status = queryBookFind();
  return {
    label: '全書查詢替換…',
    kbd: shortcutLabel('bookFind'),
    disabled: !status.available,
    detail: status.available ? '在正文、細綱、角色卡、設定等檔案裡一起找；預覽之後一起替換' : status.reason,
    run: () => commandBookFind('open'),
  };
}
