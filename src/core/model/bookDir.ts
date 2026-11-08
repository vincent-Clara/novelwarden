/**
 * 新建一本書時資料夾叫什麼（獨立版歡迎頁「新建一本書」「匯入寫好的書」，2026-10-24）。**純函式、零 import**：表單上
 * 預覽的路徑（經 `media/src/protocol.ts` 打進瀏覽器產物）與後端真建的（`core/actions.ts` 的 `createBookAt`）是同一個名字。
 *
 * 只刪各平臺檔名裡不許出現的字元，空格留著（書名裡的空格是作者的）；開頭的點（會變成隱藏資料夾）與結尾的點、空格
 * （Windows 不認）一併去掉。刪完什麼都不剩時是空串——呼叫方據此說「書名裡的字都不能當資料夾名」。
 */
export function bookDirName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
}
