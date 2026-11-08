/**
 * 審稿鏈（五期）：一次呼叫出一份報告，出岔子時整份重來，最後校驗引文、核對目標。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`review-chapter.command.ts` 的重試
 * （RV:288-367）。2026-10-25 起改成轉寫：審稿模型按小標題寫自然語言（引文用「」括出來），轉寫模型照抄成 JSON
 * （context/prompts.ts 的 `reviewJsonContract`，走法在 features/transcribe.ts）：
 *
 * ```
 * 第一次呼叫（對話頁流式）
 *   → 被輸出上限截斷：丟棄，整份重來 1 次（截斷的那一半不可信，不續接）
 *   → 轉寫成 JSON（不合格重轉 1 次；模型自己給了 JSON 就不轉）
 *   → 沒按格式寫、或轉寫沒成：丟棄，按格式重寫 1 次，照樣轉寫
 *   → 仍不行：報錯，不出報告（對話頁的原文留在氣泡裡）
 *   → 校驗引文、凍結的目標逐項核對（model/review.ts）
 * ```
 *
 * 最多 7 次（{@link REVIEW_CALLS}：審 3 次、轉寫 4 次）。轉寫呼叫本身失敗（池裡同檔換完了人）不重寫——換一份原文也轉不了。
 *
 * 與 structured.ts 那幾條鏈同一個 {@link ChainIO}：重來的那一次照樣流進同一個氣泡，前面一行
 * 說清這一次在補什麼；轉寫只加一行；最後氣泡換成給人讀的那一份報告（`renderReport`），不留一段 JSON。
 */
import { reviewJsonContract } from '../context/prompts';
import { TranscribeResult, TranscribeSpec } from '../features/transcribe';
import { REVIEW_CALLS } from '../model/pipeline';
import { FrozenGoal, RawReview, ReviewReport, parseReviewJson, renderReport, verifyReview } from '../model/review';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';

export { REVIEW_CALLS };

export interface ReviewChainContext {
  /** 待審的那一章正文（去掉標題行）。引文在它裡面找。 */
  text: string;
  goals: readonly FrozenGoal[];
  chapterNo: number;
  chapterTitle?: string;
  chapterRelPath: string;
  chapterHash: string;
}

export interface ReviewChainResult extends ChainResult {
  report: ReviewReport;
}

/** 審稿報告的樣子：「總評」「目標核對」「### 問題」至少有一個。連這都沒有的（「這一章寫得挺好」）不花轉寫那一次，按不合格重寫。 */
export function looksLikeReview(source: string): boolean {
  return /(?:总|總)(?:评|評)|目(?:标|標)核(?:对|對)|#\s*(?:问|問)(?:题|題)/u.test(source);
}

/** 審稿那一步的轉寫：合同、原來的解碼，按對應關係填的鍵（維度、嚴重程度、目標編號、結論）不比原文。 */
const REVIEW_TRANSCRIBE: TranscribeSpec<RawReview> = {
  label: '審稿',
  contract: reviewJsonContract(),
  decode: (json) => {
    const p = parseReviewJson(json);
    return p.ok ? { ok: true, value: p.value } : { ok: false, message: p.reason };
  },
  mapped: ['category', 'severity', 'id', 'status'],
  looksLike: looksLikeReview,
};

export async function completeReview(first: CallOutcome, io: ChainIO, ctx: ReviewChainContext): Promise<ReviewChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('審稿輸出被輸出上限截斷，截斷的那一半不可信，已丟棄並整份重來一次');
    out = await t.call(io, await io.build({ step: { kind: 'reviewRetry', why: 'truncated' } }), '審稿被截斷，整份重來');
    if (out.stop === 'maxTokens') {
      t.fail('審稿重來一次仍被輸出上限截斷，沒有出報告。調大設定頁的「最大輸出 token」，或降低思考深度再試。');
    }
  }
  let parsed: TranscribeResult<RawReview> = await t.transcribeJson(io, out.text, REVIEW_TRANSCRIBE);
  if (!parsed.ok) {
    if (parsed.failed) {
      failTranscribe(t, parsed.message);
    }
    // 轉寫過還不合格：毛病多半在轉寫，但原文也可能寫得亂；照原來解析失敗的走法重寫一次。告訴審稿模型的只是「整理不出來」——
    // 「這幾處不是原文裡的字」是說給轉寫模型的，審稿模型看了不知道改什麼。
    t.note(
      parsed.calls > 0
        ? `審稿轉寫沒成（${parsed.message}），已丟棄並重寫一次`
        : `審稿輸出不合格（${parsed.message}），已丟棄並按格式重寫一次`
    );
    const reason = parsed.calls > 0 ? '整理不出一份報告' : parsed.message;
    out = await t.call(io, await io.build({ step: { kind: 'reviewRetry', why: 'invalid', reason } }), '審稿不合格，按格式重寫');
    parsed =
      out.stop === 'maxTokens'
        ? { ok: false, message: '被輸出上限截斷', failed: false, calls: 0, notes: [] }
        : await t.transcribeJson(io, out.text, REVIEW_TRANSCRIBE);
    if (!parsed.ok) {
      if (parsed.failed) {
        failTranscribe(t, parsed.message);
      }
      const hint = /截(?:断|斷)/.test(parsed.message) ? '這種情況多半是審稿輸出被輸出上限截斷：調大設定頁的「最大輸出 token」再試。' : '';
      t.fail(`兩次都沒有產出合格的審稿報告（${parsed.message}），沒有出報告。${hint}`);
    }
  }
  const { report, notes } = verifyReview(parsed.value, ctx);
  t.note(...notes);
  return { raw: renderReport(report), notes: t.notes, calls: t.calls, report };
}

/** 轉寫呼叫本身失敗：不重寫——換一份原文也轉不了。對話頁寫好的原文留在氣泡裡（generation/generate.ts）。 */
function failTranscribe(t: Tally, message: string): never {
  t.fail(`審稿寫好了，但${message}，沒有出報告。稍後再審一次，或檢查設定裡「轉寫」那一檔的模型。`);
}
