/**
 * 標題欄「檔案」選單的「歷史版本…」（獨立版，緊跟在「另存為…」後面）：切到側欄「版本」頁，列當前那塊編輯區那份檔案
 * 存下的各版（`editor/versions.ts`）。能不能用問編輯器（`nf-versions-query`）——沒開檔案、沒開啟工程、檔案不是工程裡的
 * 創作產物時置灰，原因掛在提示上。與 `paragraphMenu.ts` 同一個做法：經 `MenuEntry.run` 接進 `menubar`。
 */
import { commandVersions, queryVersions } from '../globals';
import type { MenuEntry } from './menubar';

export function versionsMenuEntry(): MenuEntry {
  const status = queryVersions();
  return {
    label: '歷史版本…',
    disabled: !status.available,
    detail: status.available ? '在側欄「版本」頁看這份檔案存下的各版，點一行在編輯區對比' : status.reason,
    run: () => commandVersions('open'),
  };
}
