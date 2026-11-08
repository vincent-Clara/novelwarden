/**
 * 字數統計。**與 view.js 的同名函式口徑不同，別合併。**
 *
 * 這裡的 `countWords` 與 core 的一致（`src/core/model/fs.ts`）：中文按字（基本區與擴充套件 A 區的漢字）、
 * 英文按詞（連著的 `A-Z a-z 0-9 '` 算一個）、標點與空白不算——編輯器狀態列上的「N 字」要與工程頁上
 * 後端算出來的章節字數對得上，兩個數字不一樣會讓人以為有內容沒儲存。view.js 那邊統計的是模型回覆的
 * 長度（去空白後的字元數），是另一件事。
 *
 * 寫法與 core 不同、結果一字不差（`tests/unit/editor/writingStats.test.js` 拿 core 那一份對拍）：core 用
 * 正則先去空白、再把每個漢字 match 成一個陣列；這裡一趟迴圈數完，不造中間字串與陣列——編輯器每敲一下
 * 都可能要數一遍幾萬字（見 `stats.ts`），快三倍左右。
 */

/** 這個 UTF-16 碼元是不是算字的漢字（與 core 的 `[一-鿿㐀-䶿]` 同一個範圍）。 */
export function isCjkCode(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/** 這個碼元是不是英文詞裡的字元（與 core 的 `[A-Za-z0-9']` 同一個範圍）。 */
export function isWordCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x27 // '
  );
}

export function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isWordCode(code)) {
      if (!inWord) {
        n++;
        inWord = true;
      }
    } else {
      inWord = false;
      if (isCjkCode(code)) {
        n++;
      }
    }
  }
  return n;
}

/** 千分位：3120 → 「3,120」。負數帶負號。 */
export function groupDigits(n: number): string {
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${s}` : s;
}
