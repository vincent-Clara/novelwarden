import { traditionalLabel } from '../model/labels';
/**
 * 文風提取（從本工程正文，features/style.ts）與從參考書學文風（features/reference.ts）共用這一份：
 * 只有開頭那一段不同——一份是「保證續寫與原作一致」，一份是「讓作者的書學參考書的寫法」。
 * 任務邊界與小節一字不差。
 */
import { StopSignal } from '../llm/provider';
import { stripCodeFence } from './parse';

const STYLE_INTRO =
  '你是文學編輯，需要從作者的樣章中歸納出一份「文風指南」。這份指南會在每次 AI 續寫時注入模型，用來保證續寫內容與原作風格一致，因此必須**具體、可執行**，不能是「文筆優美」這類無法操作的空話。';

const REFERENCE_STYLE_INTRO =
  '你是文學編輯，需要從一本**參考書**的樣章中歸納出一份「文風指南」。作者想讓自己的書學這本書的寫法：這份指南會在作者每次續寫時注入模型，因此必須**具體、可執行**，不能是「文筆優美」這類無法操作的空話。參考書是別人的作品，你要拆的是它的技法，不是它的內容。';

const STYLE_BODY = `【任務邊界】（來自 AI-Novel-Writer 的文風分析模板 analyze_writing_style，GPL-3.0，源自 AI_NovelGenerator）
- 只學習敘事技法、結構節奏、句式習慣、描寫比例、場景推進方式和對白組織。
- 禁止複述樣章的具體情節、角色名、地點名、專有設定或標誌性橋段——這份指南要約束的是「怎麼寫」，不是「寫什麼」。
- 不要複製原文句子，不要輸出長引文；詞例只摘詞，不摘句。
- 只提煉樣章中有效且可遷移的技法；不要把樣章的缺點或偶發模式當作寫作要求。
- 不得把樣章裡劇情事件、動作或物件的出現次數、每幕配額或樣章篇幅轉成寫作要求。

請按以下小節輸出 Markdown，不要增刪小節，不要輸出任何前言後語：

## 敘事視角
人稱、視角型別（限知/全知）、視角是否切換、時態。

## 句式節奏
平均句長、長短句配比、段落長度、不同場景（對話/動作/描寫）下的節奏差異。請給出具體傾向，例如「動作段落多用 10 字以內短句連排」。

## 遣詞特徵
偏好的詞彙色彩（書面/口語、雅/俗）、常見的動詞與形容詞習慣、是否使用文言詞、方言或特定行業詞彙。請從樣章中摘 3-5 個典型詞例。

## 對白風格
對白佔比、提示語寫法（「他說」還是動作代替）、不同人物的說話差異、是否使用大段獨白。

## 描寫偏好
環境描寫的密度與切入方式、心理描寫的處理、感官描寫側重（視覺/聽覺/嗅覺）。

## 修辭習慣
比喻/排比等修辭的使用頻率與偏好型別，是否剋制。

## 禁用清單
從樣章中反推出作者**明顯迴避**的寫法，逐條列出（如「不使用『不禁』『頓時』」「不寫上帝視角評論」「不用感嘆號」）。這一節直接影響續寫質量，請儘量列全。

要求：所有結論必須能從樣章中找到依據，寧可少寫也不要臆測。用繁體中文。`;

export const STYLE_SYSTEM = `${STYLE_INTRO}\n\n${STYLE_BODY}`;

/** 從參考書學文風（拆書 B）。 */
export const REFERENCE_STYLE_SYSTEM = `${REFERENCE_STYLE_INTRO}\n\n${STYLE_BODY}`;

/**
 * 從參考書學寫法（拆書 B）：結構與節奏層面的方法，寫成一份「規劃」階段的寫作技能
 * （`.novelwarden/skills/<名>/SKILL.md`）。任務邊界沿用上面那一份的口徑；最後一節「規劃時怎麼用」是
 * 給排大綱與細綱的人直接照做的規則——技能正文會原樣放在規劃那幾次生成的提示詞最前面。
 *
 * 「不要提到工具、指令碼、檔案」：寫作技能只收純提示詞（`model/writingSkill.ts` 的相容規則），
 * 正文裡寫了「呼叫……工具」「執行指令碼」會被判成不相容、綁不上。
 */
export const REFERENCE_SKILL_SYSTEM = `你是一位資深網文編輯，需要從一本參考書的樣章裡拆出它的「寫法」——章節怎麼搭、場景怎麼推進、鉤子怎麼下、節奏與爽點怎麼排、資訊怎麼投放——寫成一份寫作技能。這份技能會在另一本書**規劃情節大綱與細綱**時放在提示詞最前面，幫它學到這本書的排法。

【任務邊界】（與文風分析同一口徑，來自 AI-Novel-Writer 的 analyze_writing_style，GPL-3.0，源自 AI_NovelGenerator）
- 只學結構與節奏層面的方法：一章幾個場景、場景之間怎麼切、衝突怎麼升級、鉤子落在哪、多久一個小高潮、資訊什麼時候給。
- 禁止複述參考書的具體情節、角色名、地點名、專有設定或標誌性橋段——技能約束的是「怎麼排」，不是「排什麼」。
- 不要複製原文句子，不要輸出引文。
- 只提煉有效且可遷移的方法；不要把樣章的缺點或偶發模式當作要求。
- 「篇幅統計」是程式數出來的，可以引用其中的數；其他數字（幾章一個高潮之類）只寫樣章裡看得出來的。
- 不寫文風（句式、遣詞、修辭）：那由文風指南管。
- 這是一份純提示詞：不要提到工具、指令碼、檔案或附件。

請按以下小節輸出 Markdown，不要增刪小節，不要輸出任何前言後語，總長 800–1500 字：

## 章節結構
一章通常由幾個場景組成、開頭怎麼進入、結尾停在哪裡；章與章之間怎麼銜接。

## 場景推進
一個場景內部怎麼起、怎麼升級、怎麼轉；動作、對白、資訊在場景裡的比例。

## 鉤子與懸念
章末鉤子的常見型別與落點；長線懸念怎麼埋、隔多久回應一次。

## 節奏與爽點
小高潮與日常推進怎麼交替；爽點（打臉、升級、收穫、反轉）的密度與鋪墊長度。

## 資訊投放
設定、背景、人物過往什麼時候講、講多少、借誰的口講。

## 開篇寫法
開頭幾章怎麼拋出困境、亮出核心變數、完成第一次小破局。

## 規劃時怎麼用
5–8 條排大綱與細綱時可以直接照做的規則（如「每章至少一次局面變化，章末停在未決的選擇上」）。

要求：所有結論必須能從樣章中找到依據，寧可少寫也不要臆測。用繁體中文。`;

/**
 * 提示詞規定了哪些 `## 小節`，回答裡少了哪幾個。被截斷的回答尾巴上的小節必然缺席；
 * 有的閘道器不報收尾原因，只靠 `stopReason` 攔不住，所以按小節再核一遍。
 */
export function missingSections(system: string, output: string): string[] {
  const has = new Set(output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('## ')).map((l) => traditionalLabel(l.slice(3).trim())));
  return system
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => traditionalLabel(l.slice(3).trim()))
    .filter((h) => !has.has(h));
}

/** 截斷或缺小節就拋錯：半份文風指南、半份技能寫進工程比沒寫更糟——它會被當成完整的照做。 */
export function assertComplete(system: string, output: string, stopReason: StopSignal | undefined, maxOut: number): void {
  if (stopReason === 'maxTokens') {
    throw new Error(`回答撞到輸出上限（${maxOut} token）被截斷了`);
  }
  const missing = missingSections(system, output);
  if (missing.length > 0) {
    throw new Error(missing.length === missingSections(system, '').length ? '回答是空的或沒按小節寫' : `回答缺了「${missing.join('」「')}」${missing.length} 節，多半是被截斷了`);
  }
}

/** 沒撞上限卻缺小節時，同一個模型再問幾次。 */
export const INCOMPLETE_RETRIES = 2;

/**
 * 調一次、去掉程式碼圍欄、核小節；沒撞上限卻缺小節就重問。
 *
 * 有的閘道器會在上游半路斷流時照常發 `[DONE]`、不給收尾原因（實測 newapi 轉 gemini-3-flash
 * 時有發生），回答停在第一二節。這種斷流是偶發的，再問一次多半就全了；撞了輸出上限
 * 則是穩定復現的，重問只是白燒 token，直接報錯。放在 `pool.run` 裡面調：重試用完還缺，
 * 拋出去由池子換模型。
 */
export async function collectComplete(
  system: string,
  call: () => Promise<{ text: string; stopReason?: StopSignal }>,
  opts: { maxOut: number; signal?: AbortSignal; onRetry?: (attempt: number, reason: string) => void }
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await call();
    const text = stripCodeFence(r.text).trim();
    if (opts.signal?.aborted) {
      return text;
    }
    try {
      assertComplete(system, text, r.stopReason, opts.maxOut);
      return text;
    } catch (err) {
      const reason = (err as Error).message;
      if (r.stopReason === 'maxTokens') {
        throw err;
      }
      if (attempt >= INCOMPLETE_RETRIES) {
        throw new Error(`${reason}（連問 ${attempt + 1} 次都不完整，多半是服務商半路斷了流：過會兒再試，或給這一檔多配一個模型）`);
      }
      opts.onRetry?.(attempt + 1, reason);
    }
  }
}
