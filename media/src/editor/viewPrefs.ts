/**
 * 標題欄「檢視」選單的編輯器那一半：回答 `nf-view-query`、執行 `nf-view-command`（選單那一半在
 * `view/viewMenu.ts`）。之後的階段往「檢視」里加的開關照這個樣子各加一個欄位、一個命令名。
 *
 * - **單擊開啟為臨時標籤**（預設開，記在 `novelforge.editor.prefs`）：關掉時兩塊編輯區裡現有的臨時標籤
 *   一律轉正——開關說「不要臨時標籤」，留著一個斜體的會讓人以為沒關上。
 */
import { panes } from './store';
import { onPrefsChange, previewTabsEnabled, setPreviewTabs } from './paragraphState';

export function installViewPrefs(): void {
  window.addEventListener('nf-view-query', (e) => {
    e.detail.available = true;
    e.detail.previewTabs = previewTabsEnabled();
  });

  window.addEventListener('nf-view-command', (e) => {
    if (e.detail.name === 'togglePreviewTabs') {
      setPreviewTabs(!previewTabsEnabled());
    }
  });

  onPrefsChange(() => {
    if (previewTabsEnabled()) {
      return;
    }
    for (const pane of Object.values(panes)) {
      for (const file of [...pane.files.values()]) {
        if (file.preview) {
          pane.pin(file.path);
        }
      }
    }
  });
}
