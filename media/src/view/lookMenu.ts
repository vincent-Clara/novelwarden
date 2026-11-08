/**
 * 標題欄「檢視」選單裡的「外觀」與「專注」兩組（接在 `viewMenu.ts` 的 `GROUPS` 裡，一組一個函式）。狀態問編輯器
 * （`nf-view-query` 的 `look` / `focus`，`editor/look.ts` 與 `editor/focus.ts` 回答），開關經 `nf-view-command`
 * 交過去。編輯器沒裝（外掛、空視窗之外不會發生）時沒人回答，兩組置灰。
 */
import { shortcutLabel } from '../editor/shortcuts';
import { commandViewPrefs } from '../globals';
import type { ViewPrefsStatus } from '../globals';
import type { MenuEntry } from './menubar';

/** 外觀：字號放大 / 縮小 / 還原（快捷鍵只在焦點在編輯區裡時攔），其餘幾項在外觀面板裡。 */
export function appearanceEntries(status: ViewPrefsStatus): MenuEntry[] {
  const look = status.look;
  const size = look ? `當前 ${look.fontSize}px，預設 ${look.defaultFontSize}px。` : '';
  const keys = '快捷鍵只在焦點在編輯區裡時管用，別處照常是瀏覽器的頁面縮放。';
  return [
    {
      label: '放大字號',
      kbd: shortcutLabel('zoomIn'),
      disabled: !look?.canZoomIn,
      detail: look?.canZoomIn === false ? `已經是最大字號（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomIn'),
    },
    {
      label: '縮小字號',
      kbd: shortcutLabel('zoomOut'),
      disabled: !look?.canZoomOut,
      detail: look?.canZoomOut === false ? `已經是最小字號（${look.fontSize}px）。` : `${size}${keys}`,
      run: () => commandViewPrefs('zoomOut'),
    },
    {
      label: '還原字號',
      kbd: shortcutLabel('zoomReset'),
      disabled: !look,
      detail: `${size}${keys}`,
      run: () => commandViewPrefs('zoomReset'),
    },
    {
      label: '外觀設定…',
      disabled: !look,
      detail: '正文字型、字號、行距、版心寬度與主題（深色 / 淺色 / 護眼），改了當場生效。',
      run: () => commandViewPrefs('openLook'),
    },
  ];
}

/** 專注：專注模式、全屏、打字機滾動、段落聚焦，開著的打 ✓。 */
export function focusEntries(status: ViewPrefsStatus): MenuEntry[] {
  const focus = status.focus;
  return [
    {
      label: '專注模式',
      kbd: shortcutLabel('focusMode'),
      checked: !!focus?.focusMode,
      disabled: !focus,
      detail: `只留正文：藏起側欄、標籤條、工具欄與章節條，狀態列淡成一行。兩塊編輯區都開著時只專注當前那一塊。Esc 或再按 ${shortcutLabel('focusMode')} 退出。`,
      run: () => commandViewPrefs('toggleFocusMode'),
    },
    {
      label: '全屏',
      checked: !!focus?.fullscreen,
      disabled: !focus?.fullscreenSupported,
      detail: focus?.fullscreenSupported
        ? '整個頁面佔滿螢幕（瀏覽器的 F11 也行）。Esc 退出。'
        : '這個瀏覽器（或視窗）不支援全屏。',
      run: () => commandViewPrefs('toggleFullscreen'),
    },
    {
      label: '打字機滾動',
      checked: !!focus?.typewriter,
      disabled: !focus,
      detail: '游標所在那一行始終停在編輯區中間附近；用滾輪翻看前文時不拉回來，下一次打字才回來。',
      run: () => commandViewPrefs('toggleTypewriter'),
    },
    {
      label: '段落聚焦',
      checked: !!focus?.paragraphFocus,
      disabled: !focus,
      detail: '正文裡游標所在那一段照常顯示，其餘變淡。按工程的分段格式認段落。',
      run: () => commandViewPrefs('toggleParagraphFocus'),
    },
  ];
}
