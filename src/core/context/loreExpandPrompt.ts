import { traditionalLabel } from '../model/labels';
import { LORE_BODY_KEYS, LORE_ENTRY_LIMITS, LORE_EXPAND_LIMITS, LORE_HIDDEN_KEY, LORE_LINE_LIMITS } from '../model/loreFile';

/**
 * 展開一條設定（完善設定，2026-10-19）：往前想細。系統提示裡那一句做事原則與附在使用者訊息末尾的輸出合同。
 *
 * **不借 `LORE_ENTRY_SYSTEM`**（features/lorePrompt.ts）：那一份是往回記的規矩，第 1 條就是「只寫給出的記錄裡
 * 明確有的，不補完、不推測」。展開反過來——要為已排的情節補完、推想；只是定稿裡寫過的不推翻、作者寫過的不刪。
 *
 * 放在 context/ 而不是 features/：裝配器（prompts.ts）要拼它，而 context/ 不依賴 features/（context/README.md）。
 * 解碼在 features/loreExpand.ts，兩邊共用 `LORE_ENTRY_LIMITS` 與 `LORE_EXPAND_LIMITS`（第 27 條：字數上限
 * 是錨點，改提示詞時別抹掉）。
 */

/** 產出時那一句做事原則（`ethosOf` 在單條設定目標上接它）。 */
export const LORE_EXPAND_ETHOS =
  '這一次只管一條設定：把它往前想細，讓已經排好的情節撐得住；定稿裡已經寫進正文的一個字都不推翻，這一條現有的具體內容一處都不丟，只補、只細化。';

/**
 * 輸出合同：要求 1–6 條與輸出格式。2026-10-25 起改成轉寫：按小標題寫自然語言（{@link loreExpandFormat}），JSON 由轉寫模型
 * 照抄（{@link loreExpandJsonContract}，generation/structured.ts 的 `completeLoreExpand`）。
 */
export function loreExpandContract(): string {
  const L = LORE_ENTRY_LIMITS;
  return [
    '請把上面「當前這一條設定」往前想細：照「已排細綱裡用到它的地方」要它做的事，補全它是什麼、怎麼運轉、現在是什麼樣子，以及讀者還不知道的那一面。',
    '',
    '【要求】',
    '1. 為已排的情節服務：細綱裡打算讓它做什麼，它就得撐得住；和劇情無關的百科不寫。',
    '2. 「定稿過的記錄」裡已經確立的不許改。「當前這一條設定」裡現有的每一處具體內容（名字、規則、做得到與做不到的、已經發生的事）' +
      '都是作者認過的，一處都不許丟：可以換說法、並句子；字數放不下先壓縮措辭，再放不下就把整塊拆進子條目。只補、只細化。',
    `3. 字數：${LORE_BODY_KEYS.map((k) => `${traditionalLabel(k)} ≤ ${L[k]} 字`).join('、')}，三節合計 ≤ ${L.body} 字；${traditionalLabel(LORE_HIDDEN_KEY)} ≤ ${L[LORE_HIDDEN_KEY]} 字，不算進那 ${L.body} 字，沒有就寫「無」。做減法，不寫逐章經過。`,
    `4. 關鍵詞 3–${LORE_EXPAND_LIMITS.keywords} 個，只放讀者在正文裡會看到的叫法（別稱、簡稱）；人名不算。${traditionalLabel(LORE_HIDDEN_KEY)}裡的東西不進關鍵詞，也不進一句話。`,
    `5. 子條目：寫不下、值得單獨立一條的部分，≤ ${LORE_EXPAND_LIMITS.children} 條，只給名字、分類、一句話；已有的設定、人物不要拆。沒有就寫「無」。`,
    `6. 還沒定的問題：2–${LORE_EXPAND_LIMITS.questions} 條還沒定、要作者拍板的問題（如「閣規是成文的還是口傳的？」），每條 ≤ ${LORE_EXPAND_LIMITS.question} 字；不問已經定了的。`,
    '',
    loreExpandFormat(),
  ].join('\n');
}

/** 展開的輸出格式（2026-10-25 起改成轉寫）：八個小標題，各節寫什麼照原來的 JSON 合同搬過來。 */
function loreExpandFormat(): string {
  return [
    '【展開格式】',
    '按下面八個小標題依次寫，一節以「## 小標題」開頭，小標題一字不改，哪一節沒有內容就寫「無」：',
    `- 一句話：說清它是什麼（≤ ${LORE_ENTRY_LIMITS.brief} 字），只寫讀者看得到的那一面；`,
    '- 關鍵詞：寫在一行裡，用頓號隔開；',
    '- 概要：它是什麼、在哪、歸誰；',
    '- 規則與邊界：怎麼運轉，能做到什麼、做不到什麼，代價與禁忌；',
    '- 現狀：以章號最大的定稿記錄與已排的細綱為準，它現在的樣子；',
    `- ${traditionalLabel(LORE_HIDDEN_KEY)}：讀者還不知道的真相（真實身份、來歷、規則背後的真正原因）；`,
    `- 子條目：一條一行，寫成「- 名字（分類）：一句話」；名字 ≤ ${LORE_LINE_LIMITS.name} 字，分類從本書的設定分類裡挑（可以寫子分類，如「宗門/正道」），一句話 ≤ ${LORE_ENTRY_LIMITS.brief} 字；`,
    '- 還沒定的問題：一條一行，行首寫「- 」。',
    '明面三節（概要、規則與邊界、現狀）還沒交代的寫「（未交代）」。',
    '只寫這一條的展開：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 一句話',
    '……',
    '## 關鍵詞',
    '〈別稱〉、〈簡稱〉',
    '## 概要',
    '……',
    '## 規則與邊界',
    '……',
    '## 現狀',
    '……',
    `## ${traditionalLabel(LORE_HIDDEN_KEY)}`,
    '……',
    '## 子條目',
    '- 〈名字〉（〈分類〉）：……',
    '## 還沒定的問題',
    '- ……',
  ].join('\n');
}

/**
 * 展開轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/loreExpand.ts 的 `decodeLoreExpansion` 認的那一份，
 * 也是氣泡裡放的規範化結果的形狀。
 */
export function loreExpandJsonContract(): string {
  return [
    '【設定展開 JSON 合同】',
    `只輸出 {"brief":"…","keywords":["…"],"body":{"概要":"…","规则与边界":"…","现状":"…","${traditionalLabel(LORE_HIDDEN_KEY)}":"…"},"children":[{"name":"…","category":"…","brief":"…"}],"questions":["…"]}：`,
    '- brief：「一句話」一節；keywords：「關鍵詞」一節，一個一項；',
    `- body 的四個鍵（概要、規則與邊界、現狀、${traditionalLabel(LORE_HIDDEN_KEY)}）：原文裡同名的那四節，整節照抄（保留換行）；`,
    '- children：「子條目」一節，一條一項：name 是名字，category 是括號裡的分類，brief 是冒號後面那一句；',
    '- questions：「還沒定的問題」一節，一條一項，去掉行首的「- 」；',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
  ].join('\n');
}
