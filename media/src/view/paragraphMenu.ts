/**
 * 標題欄「編輯」選單裡段落那一組（獨立版）：
 *
 * - 「段落格式 ▸」三項（空行分段 / 段首縮排 / 縮排加空行），當前那項打 ✓；沒開工程（或還不是小說工程）時置灰。
 *   點了直接發 `setParagraphStyle` 給後端——那是工程的設定，後端只改 `config.md` 的這一個鍵，再 `pushState`，
 *   勾隨新的 `ViewState.paragraphStyle` 回來（前端無狀態）。
 * - 「成對符號自動補全」開關（打 ✓）：編輯器的偏好，按瀏覽器記，經 `nf-paragraph-command` 交給編輯器。
 * - 「一鍵排版」「半形標點轉全形」：作用於當前那塊編輯區，當前檔案不是正文時置灰。
 *
 * 狀態問編輯器（`nf-paragraph-query`，`editor/paragraph.ts` 回答）；編輯器沒裝（外掛）時這一組根本不出現——
 * 選單欄本身就只在獨立版裡有。
 */
import { DEFAULT_PARAGRAPH_STYLE, PARAGRAPH_STYLES, PARAGRAPH_STYLE_HINT, PARAGRAPH_STYLE_LABEL } from '../protocol';
import { commandParagraph, queryParagraph } from '../globals';
import type { MenuEntry } from './menubar';
import { hasWorkspace, store, vscode } from './store';

export function paragraphMenuEntries(): MenuEntry[] {
  const project = hasWorkspace() && !!store.state?.initialized;
  const current = store.state?.paragraphStyle ?? DEFAULT_PARAGRAPH_STYLE;
  const status = queryParagraph();
  return [
    { label: 'sep' },
    {
      label: '段落格式',
      disabled: !project,
      submenu: PARAGRAPH_STYLES.map((style) => ({
        label: PARAGRAPH_STYLE_LABEL[style],
        detail: PARAGRAPH_STYLE_HINT[style],
        checked: style === current,
        run: () => vscode.postMessage({ type: 'setParagraphStyle', style }),
      })),
    },
    { label: '成對符號自動補全', checked: status.autoPair, run: () => commandParagraph('toggleAutoPair') },
    { label: 'sep' },
    { label: '一鍵排版', disabled: !status.prose, run: () => commandParagraph('formatProse') },
    { label: '半形標點轉全形', disabled: !status.prose, run: () => commandParagraph('fullWidthPunct') },
  ];
}
