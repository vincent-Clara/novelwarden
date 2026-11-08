/**
 * 標題欄「檢視」選單（獨立版，放在「編輯」與「幫助」之間）。
 *
 * **一組一個函式**：`viewMenuEntries` 只把各組按順序接起來、組與組之間隔一條線。之後的階段往「檢視」里加東西，
 * 寫一個返回 `MenuEntry[]` 的函式接在 `GROUPS` 裡即可，不往 `menubar.ts` 的 `run` 分支表裡加。狀態問編輯器
 * （`nf-view-query`，`editor/viewPrefs.ts` 回答），開關經 `nf-view-command` 交給它——那是編輯器的偏好，
 * 按瀏覽器記（`novelforge.editor.prefs`）。編輯器沒裝（空視窗之外不會發生；外掛里根本沒有選單欄）時置灰。
 */
import { commandViewPrefs, queryViewPrefs } from '../globals';
import type { ViewPrefsStatus } from '../globals';
import { checkMenuEntries } from './checkMenu';
import { appearanceEntries, focusEntries } from './lookMenu';
import type { MenuEntry } from './menubar';
import { namesMenuEntries } from './namesMenu';
import { statsMenuEntries } from './statsMenu';

/**
 * 「檢視」裡的各組，從上到下：標籤 → 外觀 → 專注 → 統計 → 體檢 → 補全。「外觀」「專注」兩組在 `lookMenu.ts`，「統計」在
 * `statsMenu.ts`，「體檢」在 `checkMenu.ts`，「補全」在 `namesMenu.ts`（後三組的狀態自己問編輯器）。
 */
const GROUPS: ((status: ViewPrefsStatus) => MenuEntry[])[] = [
  editorTabs,
  appearanceEntries,
  focusEntries,
  statsMenuEntries,
  checkMenuEntries,
  namesMenuEntries,
];

export function viewMenuEntries(): MenuEntry[] {
  const status = queryViewPrefs();
  const out: MenuEntry[] = [];
  for (const group of GROUPS) {
    const entries = group(status);
    if (entries.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push({ label: 'sep' });
    }
    out.push(...entries);
  }
  return out;
}

/** 編輯器的標籤：單擊開啟為臨時標籤。 */
function editorTabs(status: ViewPrefsStatus): MenuEntry[] {
  return [
    {
      label: '單擊開啟為臨時標籤',
      checked: status.previewTabs,
      disabled: !status.available,
      detail: '在工程頁 / 檔案頁單擊開啟的檔案是臨時標籤（名字斜體），下一次單擊別的檔案時換掉它；編輯、儲存或雙擊就固定下來。',
      run: () => commandViewPrefs('togglePreviewTabs'),
    },
  ];
}
