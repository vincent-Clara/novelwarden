/**
 * 標題欄「幫助 → 快捷鍵一覽」（獨立版，緊跟「使用說明」）：開啟內建編輯器的快捷鍵一覽面板
 * （`editor/shortcutsPanel.ts`，與 `Ctrl+/` 同一件事）。能不能用問編輯器（`nf-shortcuts-query`）——編輯器沒裝時沒人回答，
 * 置灰。與 `quickOpenMenu.ts` 同一個做法：經 `MenuEntry.run` 接進 `menubar`，不往它的 `run` 分支表裡加。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandShortcuts, queryShortcuts } from '../globals';
import type { MenuEntry } from './menubar';

export function shortcutsMenuEntry(): MenuEntry {
  const available = queryShortcuts();
  return {
    label: '快捷鍵一覽',
    kbd: shortcutLabel('shortcuts'),
    disabled: !available,
    detail: available ? '編輯器與選單的全部快捷鍵，按分組列出，可以篩選' : '沒有內建編輯器',
    run: () => commandShortcuts(),
  };
}
