/**
 * 窄屏（≤900px，與 `css/standalone/narrow.css` 同一個界）：編輯區只有一塊、蓋在側欄上，活動欄是底欄。
 * 按視口寬度認，不看是不是觸屏——桌面上把視窗拖窄（或分屏）也是這一套；平板橫屏可以是寬屏 + 觸屏。
 */
import type { InMessage } from './protocol';

export const NARROW_WIDTH = 900;

export function narrowScreen(): boolean {
  return window.innerWidth <= NARROW_WIDTH;
}

/**
 * 「開啟這一章」：後端按宿主能力開正文、再把細綱（或草稿）並排開在第二塊。窄屏上沒有第二塊，並排的那份只能開進同一塊，
 * 而工程頁單擊開的是臨時標籤——細綱一到就把正文那個臨時標籤頂掉了，作者點的是正文、看到的是細綱。所以窄屏上不要並排的那份。
 */
export function openChapterMessage(plotRelPath: string, preview?: boolean): InMessage {
  return { type: 'openChapter', plotRelPath, ...(preview ? { preview: true } : {}), ...(narrowScreen() ? { beside: false } : {}) };
}
