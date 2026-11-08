/**
 * 修稿鏈（五期）：按勾選的審稿意見把整章改一遍，被截斷就接著寫，最後查一遍長度。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 *
 * - 續寫：`refine-from-review.command.ts` 的 `{ mode: 'append-visible-text', maxContinuations: 3 }`
 *   與 `bounded-completion.ts` 的續接（只看 `finishReason === 'length'`，拼接時去掉與已寫末尾的
 *   重疊）。拼接用的是三期那一份 `joinContinuation`，同一套去重疊、去整段重複。
 * - 完整性校驗：`refinement-completeness.ts` 全文（{@link revisionShortfall}）。
 *
 * ## 與寫章相反：報錯就不出卡片（五期計劃 §5 ⚑）
 *
 * 寫章時那一版是新東西，半截也比沒有強，所以「已寫的不丟」（D6）。修稿是拿它**覆蓋**一章
 * 已經寫好的正文：截斷三輪仍沒寫完、或者明顯短於原稿，都說明這一份修訂稿不完整，覆蓋上去
 * 就是把作者的後半章弄丟了。已經收到的文字留在氣泡裡，作者可以自己取用。
 */
import { CancelledError } from '../llm/provider';
import { countWords } from '../model/fs';
import { REVISE_CONTINUE_ROUNDS } from '../model/pipeline';
import { continuationTail } from '../context/layers/render';
import { cleanOutput } from '../features/creation';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';
import { WriteProgress, joinContinuation } from './continuation';

/** 修訂稿至少要有原稿（或每章字數）的這個比例（上游 `MIN_REFINEMENT_COMPLETION_RATIO`）。 */
export const MIN_REVISION_RATIO = 0.6;
/** 下限不低於這麼多字（上游 `MIN_REFINEMENT_UNITS`）；原稿本身更短時以原稿為準。 */
export const MIN_REVISION_UNITS = 200;

const CJK = /[㐀-䶿一-鿿豈-﫿]/gu;
const EN_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/gu;

/**
 * 看得見的正文有多少「字」：漢字一個算一個、英文一個詞算一個、其餘非空白非標點的字元一個算一個。
 * 逐字移植自上游 `countVisibleProseUnits`——不拿 `countWords` 是因為那一份數的是給作者看的字數，
 * 這裡只用來判「是不是明顯短了」，兩者口徑一致與否無所謂，與上游一致才要緊。
 */
export function countProseUnits(text: string): number {
  const words = text.match(EN_WORD)?.length ?? 0;
  const rest = text.replace(EN_WORD, '');
  const cjk = rest.match(CJK)?.length ?? 0;
  const other = rest.replace(CJK, '').replace(SPACE_OR_PUNCT, '').length;
  return cjk + words + other;
}

/**
 * 修訂稿是不是明顯短於原稿。移植自 `assertMateriallyCompleteRevision`：
 * 下限 = min(原稿, max(200, ⌊0.6 × min(原稿, 每章字數)⌋))。只有下限，沒有上限。
 * 返回報錯的那一句；夠長時 undefined。
 */
export function revisionShortfall(source: string, revision: string, wordsPerChapter?: number): string | undefined {
  const src = countProseUnits(source);
  const rev = countProseUnits(revision);
  const bounded = wordsPerChapter && wordsPerChapter > 0 ? Math.min(src, wordsPerChapter) : src;
  const minimum = Math.min(src, Math.max(MIN_REVISION_UNITS, Math.floor(bounded * MIN_REVISION_RATIO)));
  if (rev >= minimum) {
    return undefined;
  }
  return `修訂稿明顯短於原稿（${rev} / ${src} 字，至少要 ${minimum} 字），可能不完整，沒有出卡片。請重試，或少勾幾條縮小這一次的修稿範圍。`;
}

export interface RevisionChainContext {
  /** 待修的原稿（整章正文，去掉標題行）。 */
  source: string;
  /** 小說配置的每章字數：完整性校驗的下限按它封頂（上游傳的也是它）。 */
  wordsPerChapter?: number;
  onProgress?(p: WriteProgress): void;
  signal?: AbortSignal;
}

export interface RevisionChainResult extends ChainResult {
  /** 續寫了幾輪（不含第一次呼叫）。 */
  rounds: number;
  /** 修訂稿多少字。 */
  words: number;
}

export async function completeRevision(first: CallOutcome, io: ChainIO, ctx: RevisionChainContext): Promise<RevisionChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  const sourceWords = countWords(ctx.source);
  let text = cleanOutput(first.text);
  let stop = first.stop;
  let rounds = 0;
  while (stop === 'maxTokens' && rounds < REVISE_CONTINUE_ROUNDS) {
    rounds++;
    const before = countWords(text);
    ctx.onProgress?.({ round: rounds, words: before, target: sourceWords });
    const messages = await io.build({
      step: { kind: 'continuation', tail: continuationTail(text), written: before, recovery: false },
    });
    let out: CallOutcome;
    try {
      out = await t.call(io, messages, `修稿續寫第 ${rounds} 輪`, { separator: '\n\n', progress: { round: rounds, base: before } });
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal?.aborted) {
        throw err;
      }
      t.fail(`修稿續寫第 ${rounds} 輪呼叫失敗（${err instanceof Error ? err.message : String(err)}），修訂稿不完整，沒有出卡片。`);
    }
    const joined = joinContinuation(text, cleanOutput(out.text));
    stop = out.stop;
    if (countWords(joined.added) === 0) {
      t.note(`修稿續寫第 ${rounds} 輪沒有寫出新的正文`);
      break;
    }
    text = joined.text;
    t.note(`修稿被輸出上限截斷，續寫第 ${rounds} 輪：到 ${countWords(text)} 字`);
  }
  if (stop === 'maxTokens') {
    t.fail(
      `修稿被輸出上限截斷，續寫 ${rounds} 輪仍沒寫完，沒有出卡片——半截的修訂稿覆蓋上去比不改更糟。` +
        '已經收到的在氣泡裡；調大設定頁的「最大輸出 token」再試。'
    );
  }
  if (stop === 'other') {
    t.fail('模型因為別的原因停下了（常見的是內容審查），修訂稿可能不完整，沒有出卡片。');
  }
  const short = revisionShortfall(ctx.source, text, ctx.wordsPerChapter);
  if (short) {
    t.fail(short);
  }
  const words = countWords(text);
  t.note(`修訂稿 ${words} 字（原稿 ${sourceWords} 字）`);
  return { raw: text, notes: t.notes, calls: t.calls, rounds, words };
}
