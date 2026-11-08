/**
 * 數字與時間的格式化。整個 view 共用。
 *
 * `countWords` 這裡統計的是**模型回覆的長度**（去空白後的字元數）——
 * 與 editor/words.ts 的同名函式是兩件事，那邊要與後端算的章節字數對得上，
 * 走的是「中文按字、英文按詞」。別合併。
 */

/** token 數之類的大數字：1000 以上折成 k。 */
export function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 章節字數：一萬以上折成「萬字」。 */
export function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 萬字` : `${n} 字`;
}

export function countWords(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 長任務的已用時：一分鐘以上給 `m:ss`，以下給 `Ns`。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}:${String(total % 60).padStart(2, '0')}` : `${total}s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 訊息與會話上的時刻：今天只給時分，往前的帶上月日。 */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 日誌行的時刻：要看到秒，一次同步幾十條全在同一分鐘裡。 */
export function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
