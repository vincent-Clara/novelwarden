import { traditionalLabel } from '../model/labels';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_HIDDEN_MARK,
  LORE_LINE_LIMITS,
  LORE_SETTLE_LIMITS,
} from '../model/loreFile';

/**
 * 落定設定（完善設定二期）：把一段討論裡已經定下來的設定寫成一批條目。系統提示裡那一句做事原則與任務、附在
 * 使用者訊息末尾的輸出合同。
 *
 * 與落定細綱同一個能力（`settle`），任務卻不能借 `CAPABILITY_TASK.settle`：那一句說的是「這一章」，還要模型
 * 「在產物之外用一兩句話說明哪幾處還沒定」——可輸出格式又不許多寫一段，兩頭打架。這裡統一放進
 * 最後「還沒定的問題」一節（轉寫成 `questions`），只上卡片、不落盤（同展開）。
 *
 * 2026-10-25 起改成轉寫：按小標題寫自然語言（{@link loreSettleFormat}），JSON 由轉寫模型照抄（{@link loreSettleJsonContract}，
 * generation/structured.ts 的 `completeLoreSettle`）。
 *
 * 放在 context/ 而不是 features/：裝配器（prompts.ts）要拼它，而 context/ 不依賴 features/（同 loreExpandPrompt.ts）。
 * 解碼在 features/loreSettle.ts，兩邊共用 `LORE_ENTRY_LIMITS`、`LORE_EXPAND_LIMITS` 與 `LORE_SETTLE_LIMITS`
 * （第 27 條：字數上限是錨點，改提示詞時別抹掉）。
 */

/** 產出時那一句做事原則。 */
export const LORE_SETTLE_ETHOS =
  '這一次只把討論裡已經定下來的設定落成條目：作者拍了板的照寫，沒拍板的不替他拍；已有條目裡討論沒碰的內容一處都不丟。';

/** 系統提示裡的任務（替掉 `CAPABILITY_TASK.settle`，那一句說的是「這一章」）。 */
export const LORE_SETTLE_TASK =
  '你和作者剛討論過一些設定（完整對話就在上面）。把討論中**已經定下來的設定**整理成一批設定條目：新提出來的建新條目，' +
  '改動了已有設定的給出合併後的完整版。\n' +
  '以討論裡定下的為準：**不要塞進討論中被否掉的方案**，也不要臨時發明誰都沒提過的設定。' +
  '討論中懸而未決的地方不要替作者定，寫進最後「還沒定的問題」一節——那正是作者接下來要接著聊的東西。' +
  '一樣東西只是某幾處沒定（來源、代價、來歷……）時，照樣把定了的部分寫成條目，沒定的那幾處不寫，問題放進「還沒定的問題」；不要因為有一處沒定就整條不寫。';

/** 輸出合同：要求與輸出格式（{@link loreSettleFormat}）。 */
export function loreSettleContract(): string {
  const L = LORE_ENTRY_LIMITS;
  return [
    '請把上面這段討論裡已經定下來的設定寫成條目：地點、勢力、能力體系、關鍵物品、制度與概念，一樣一條。',
    '',
    '【要求】',
    `1. 只寫討論裡定下來的：新提出來的，和討論改動、補充了的已有條目；討論裡只是提到、沒有改動的已有條目不要列。最多 ${LORE_SETTLE_LIMITS.entries} 條。只有一部分定下來的照樣列，定了的寫進去，沒定的那幾處寫進「還沒定的問題」。`,
    '2. **人不是設定**：人物都在角色卡裡，人名、外號、稱謂一律不列（門派、家族這類勢力可以列）。',
    '3. 討論改動或補充了已有設定（上面「相關世界觀設定」裡列著的）時：名字一字不改照抄那一條的名字，正文給**合併後的完整版**——' +
      '討論沒碰的部分照抄原文，一處都不許丟；討論改了的照討論改；「定稿」「已經寫進正文」的事實不許推翻。',
    `4. 字數：${LORE_BODY_KEYS.map((k) => `${traditionalLabel(k)} ≤ ${L[k]} 字`).join('、')}，三節合計 ≤ ${L.body} 字；${traditionalLabel(LORE_HIDDEN_KEY)} ≤ ${L[LORE_HIDDEN_KEY]} 字，不算進那 ${L.body} 字。做減法，寫不下的說明它值得另立一條。`,
    `5. ${traditionalLabel(LORE_HIDDEN_KEY)}：討論裡定下的、讀者暫時還不知道的真相（真實身份、來歷、規則背後的真正原因）寫在這裡；已有條目裡標著「${LORE_HIDDEN_MARK}」的那一節是它原來的暗設，沒被討論推翻的照抄。沒有就寫「無」。`,
    `6. 關鍵詞：只放讀者在正文裡會看到的、專指這樣東西的別稱、簡稱（不含名字本身，不含人名，≤ ${LORE_EXPAND_LIMITS.keywords} 個，沒有就寫「無」）；` +
      `不放別的東西也叫得上的泛稱（如「法器」「防線」「硬通貨」「廟宇」）——正文裡一出現這個詞，這一條就會整條帶進上下文。${traditionalLabel(LORE_HIDDEN_KEY)}裡的東西不進關鍵詞，也不進一句話。`,
    `7. 還沒定的問題：討論裡提到了、還沒定下來、要作者拍板的問題，0–${LORE_EXPAND_LIMITS.questions} 條，每條 ≤ ${LORE_EXPAND_LIMITS.question} 字；不問已經定了的。沒定的事不寫進條目的任何一節——${traditionalLabel(LORE_HIDDEN_KEY)}放的是已經定下、只是讀者還不知道的事，不是還沒想好的事。`,
    '',
    loreSettleFormat(),
  ].join('\n');
}

/** 落定設定的輸出格式（2026-10-25 起改成轉寫）：一條一個「## 名字」，各節寫什麼照原來的 JSON 合同搬過來；問題放最後一節。 */
function loreSettleFormat(): string {
  return [
    '【落定格式】',
    `每條一份，以「## 名字」開頭（這樣東西在正文裡的叫法，≤ ${LORE_LINE_LIMITS.name} 字，同一批裡不得重複），下面依次是這七個「### 小標題」，哪一節沒有內容就寫「無」：`,
    '- 分類：從本書的設定分類裡挑（可以是二級，如「宗門/正道」）；已有條目照寫它原來的分類；',
    '- 關鍵詞：寫在一行裡，用頓號隔開；',
    `- 一句話：說清它是什麼（≤ ${LORE_ENTRY_LIMITS.brief} 字），只寫讀者看得到的那一面；`,
    '- 概要：它是什麼、在哪、歸誰；',
    '- 規則與邊界：怎麼運轉，能做到什麼、做不到什麼，代價與禁忌；',
    '- 現狀：它現在的樣子；',
    `- ${traditionalLabel(LORE_HIDDEN_KEY)}：見上面第 5 條。`,
    '明面三節（概要、規則與邊界、現狀）討論沒交代、原來也沒有的寫「（未交代）」。',
    '所有條目之後寫「## 還沒定的問題」：一條一行，行首寫「- 」；沒有就寫「無」。討論裡一條設定都沒定下來時，只寫這一節。',
    '只寫條目與問題：不要開場白和解釋，不用程式碼圍欄，不寫 JSON。',
    '【格式示例】',
    '## 〈名字〉',
    '### 分類',
    '……',
    '### 關鍵詞',
    '無',
    '### 一句話',
    '……',
    '### 概要',
    '……',
    '### 規則與邊界',
    '……',
    '### 現狀',
    '……',
    `### ${traditionalLabel(LORE_HIDDEN_KEY)}`,
    '無',
    '## 還沒定的問題',
    '- ……',
  ].join('\n');
}

/**
 * 落定設定轉寫那一步的 JSON 合同（2026-10-25 起改成轉寫）：形狀是 features/loreSettle.ts 的 `decodeLoreSettle` 認的那一份，
 * 也是氣泡裡放的規範化結果的形狀。
 */
export function loreSettleJsonContract(): string {
  return [
    '【落定設定 JSON 合同】',
    `只輸出 {"entries":[{"title":"…","category":"…","keywords":["…"],"brief":"…","body":{"概要":"…","规则与边界":"…","现状":"…","${traditionalLabel(LORE_HIDDEN_KEY)}":"…"}}],"questions":["…"]}：`,
    '- entries：原文裡「還沒定的問題」以外的每個「## 名字」是一項：title 是那個名字；category、brief：「分類」「一句話」兩節；keywords：「關鍵詞」一節，一個一項；',
    `  body 的四個鍵（概要、規則與邊界、現狀、${traditionalLabel(LORE_HIDDEN_KEY)}）：同名的那四節，整節照抄（保留換行）；`,
    '- questions：「還沒定的問題」一節，一條一項，去掉行首的「- 」；',
    '- 原文只有「還沒定的問題」一節時 entries 給 []；',
    '- 寫「無」或沒有這一節的：文字給 ""，列表給 []。',
    '- 文字一律從原文照抄：不改寫、不總結、不潤色，不補原文沒有的，也不刪原文寫了的。',
    '只輸出一個可由 JSON.parse 讀取的 JSON 物件，不要解釋、Markdown 或程式碼圍欄。',
  ].join('\n');
}
