/**
 * 正文的自動續寫：一章寫不到目標字數、或者被輸出上限截斷時，接著再調幾次把它寫完。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts`
 * 的 `extendDraftIfNeeded` / `shouldAutoContinue`（GD:930-1186）與 `bounded-completion.ts`
 * 的 `appendVisibleTextContinuation`（拼接時去掉與已寫末尾重疊的開頭）。
 *
 * ## 一條鏈，單步與批次共用
 *
 * 與 `structured.ts` 那三條鏈同一個 {@link ChainIO}：對話頁第一次呼叫是流式的，後面幾輪
 * 照樣流進同一個氣泡；將來批次寫正文（四期）換一個走分檔池的 `ChainIO` 就能用。
 *
 * ## 比上游寬鬆：已寫的不丟（D6）
 *
 * 上游在這幾種情況下整份作廢、不儲存：恢復那一輪仍沒進展、最後仍被截斷、最後仍不到八成。
 * 這裡一律**保留並說清**——卡片照樣可以寫入，說明裡寫著為什麼停、差多少。作者看著
 * 一章寫了 2100 / 3000 字的正文，比看著一句「結果未儲存」有用得多，而且那 2100 字的錢
 * 已經花了。只有「一個字正文都沒有」（思考把輸出預算吃光）才報錯。
 *
 * 另一處：續寫某一輪呼叫失敗（網路、限流）時，前面寫好的也保留，不讓一次抖動把整章帶走。
 * 作者自己點了停止不算——那是他不要了。
 *
 * ## 收尾過早時先回退（五期補遺 §1.1 ⚑，上游沒有）
 *
 * 三期真實模型首跑：三章的第一次呼叫都正常收尾、只寫到目標的 55–77%。第一次呼叫已經按細綱
 * 收了尾（章末吊著讀者的那一下），不到八成的續寫只能接在收尾**後面**——第 3 章在收尾之後又寫了 869 字，
 * 最後把第 4 章才登場的人寫了出來。被截斷時結尾停在半句上，往後接沒問題；正常收尾時結尾就是
 * 收尾那一場，往後接必然越過它。
 *
 * 所以正常收尾（`end`）又不夠八成時，續寫先把收尾那一場切掉（model/manuscriptCheck.ts 的
 * `rewindPoint`：切最後約四分之一、最多 600 字，至少留一半），從切點接著寫、寫足之後重新收尾。
 * 一次寫一千字上下的模型一章要這樣走兩三輪，所以可以回退幾次，但**每次只在
 * 上一輪新寫的那一段裡切**（前幾輪已經接受的正文不再動）；回退那一輪淨多的不到 300 字、或者上一輪那一段
 * 短得沒法切，就停——不往收尾後面接。閘道器不報收尾原因（`stop` 缺席）時分不清是收尾還是截斷，照舊往後接。
 *
 * ## 停在半句上算截斷
 *
 * 只信模型報的收尾原因不夠：百章實驗第 3 章停在「他已經到了極限，全身」，字數過了八成，照樣定稿了。
 * 每一次呼叫之後看一眼結尾那個字（model/manuscriptCheck.ts 的 `endsMidSentence`）：不是句末標點就按
 * `maxTokens` 處理——往後接、不回退。寫完仍停在半句上時 `truncated` 為真，批次寫章據此停下。
 *
 * ## 寫完查三樣（§1.2、§1.3、§1.5）
 *
 * 比喻詞超沒超上限、有沒有拉丁字母縮寫、後面幾章才登場的人有沒有提前寫進來——只記說明，
 * 不改正文。最後一樣批次寫章據此停下（features/pipelineBatch.ts）。
 */
import { CancelledError, StopSignal } from '../llm/provider';
import { countWords } from '../model/fs';
import { MANUSCRIPT_DONE_RATIO, MAX_CONTINUE_ROUNDS, WriteMode } from '../model/pipeline';
import {
  DIALOGUE_FLOOR,
  dialogueShare,
  EarlyEntrance,
  NotYet,
  SIMILE_LIMIT,
  SIMILE_WORDS,
  countBanned,
  countSimiles,
  describeBanned,
  describeSimiles,
  endsMidSentence,
  findEarlyEntrances,
  latinAcronyms,
  rewindPoint,
} from '../model/manuscriptCheck';
import { continuationTail } from '../context/layers/render';
import { detectReplay } from '../context/replay';
import { cleanOutput } from '../features/creation';
import { describeError } from '../runtime/logger';
import { CallOutcome, ChainIO, ChainResult, Tally } from './structured';
import { trimModifiers } from './trim';

// 續寫時帶已寫正文的最後 1600 字：取法在裝配那一層（「接著寫」的第一次呼叫也要它）。
export { CONTINUE_TAIL_CHARS, continuationTail } from '../context/layers/render';

/** 一輪續寫少於這麼多字算「沒進展」（上游 GD:1121）。 */
export const MIN_ROUND_GAIN = 300;
/** 被截斷、而正文還不到這麼多字：輸出預算被思考吃光了（上游 GD:973-986）。 */
export const STARVED_CHARS = 100;
/**
 * 續寫的開頭與已寫末尾重合這麼多個非空白字元才算「重複了一截」，要去掉。
 * 太短會誤傷：兩段都以「他」開頭不算重疊（上游 `MIN_VISIBLE_OVERLAP_CHARS`）。
 */
export const MIN_OVERLAP_CHARS = 48;
/** 比對重疊時各取多少字（上游 `CONTINUATION_VISIBLE_TAIL_CHARS`）。 */
const OVERLAP_WINDOW = 1600;
/** 整段重複：去掉空白後不短於這麼多字、又與已寫的某一段一字不差（上游 `sanitizeDraftText`）。 */
const DUPLICATE_PARAGRAPH_CHARS = 40;

/**
 * 這一輪之後還要不要續。
 *
 * - 沒有目標字數：不續——「有字就算寫夠」，不拿猜出來的數去續（總計劃 D6 的另一半）；
 * - 到了 {@link MAX_CONTINUE_ROUNDS} 輪：不續；
 * - 被輸出上限截斷：續——結尾停在半句上，哪怕字數夠了；
 * - 因為別的原因停了（`other`：多半是內容審查）：不續，再調一次多半還是停；
 * - 其餘看字數：不到目標的八成就續（與 `deriveStage` 同一個 {@link MANUSCRIPT_DONE_RATIO}）。
 */
export function shouldContinue(s: { words: number; target?: number; stop?: StopSignal; rounds: number }): boolean {
  if (!s.target || s.target <= 0 || s.rounds >= MAX_CONTINUE_ROUNDS) {
    return false;
  }
  if (s.stop === 'maxTokens') {
    return true;
  }
  if (s.stop === 'other') {
    return false;
  }
  return s.words < lowerBound(s.target);
}

/** 目標字數的八成：到了這個數就算寫夠。 */
export function lowerBound(target: number): number {
  return Math.floor(target * MANUSCRIPT_DONE_RATIO);
}

/**
 * 去掉模型自己加的介面話術：「點我繼續生成後續內容」「未完待續」這類單獨成行的提示，
 * 以及三個以上的連續空行。只動這幾樣，正文一個字不碰。
 */
export function sanitizeAddition(text: string): string {
  return text
    .replace(/^\s*(?:(?:点|點)我(?:继|繼)(?:续|續)生成(?:后|後)(?:续|續)(?:内|內)容|(?:继|繼)(?:续|續)生成(?:后|後)(?:续|續)(?:内|內)容|(?:请|請)(?:点|點)(?:击|擊)(?:继|繼)(?:续|續)|未完待(?:续|續))[。.！!…]*\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 續出來的這一段開頭與已寫末尾重疊的那一截去掉（按非空白字元比，≥ {@link MIN_OVERLAP_CHARS}）。
 *
 * 模型接著寫時常把已寫的最後一兩句複述一遍再往下走——拼上去就是一句話出現兩次。
 */
export function stripOverlap(existing: string, addition: string): string {
  const tail = existing.slice(-OVERLAP_WINDOW).replace(/\s+/g, '');
  const head = addition.slice(0, OVERLAP_WINDOW).replace(/\s+/g, '');
  const maximum = Math.min(tail.length, head.length);
  let overlap = 0;
  for (let length = maximum; length >= MIN_OVERLAP_CHARS; length--) {
    if (tail.slice(-length) === head.slice(0, length)) {
      overlap = length;
      break;
    }
  }
  if (overlap === 0) {
    return addition;
  }
  // 按非空白字元數往後數，跳過重疊的那一截。
  let consumed = 0;
  for (let i = 0; i < addition.length; i++) {
    if (!/\s/.test(addition[i])) {
      consumed++;
    }
    if (consumed >= overlap) {
      return addition.slice(i + 1).trimStart();
    }
  }
  return '';
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function paragraphKey(p: string): string {
  return p.replace(/\s+/g, '');
}

/**
 * 把續寫的這一段接到已寫的後面：去話術、去重疊、去整段重複，段與段之間空一行。
 *
 * 返回拼好的全文與**真正新增**的那一段——`continue` 寫法落盤時只追加後者，
 * 「這一輪多了幾個字」也按後者算。
 */
export function joinContinuation(existing: string, addition: string): { text: string; added: string } {
  const base = existing.trim();
  const trimmed = stripOverlap(base, sanitizeAddition(addition));
  const seen = new Set(paragraphsOf(base).map(paragraphKey).filter((k) => k.length >= DUPLICATE_PARAGRAPH_CHARS));
  const kept: string[] = [];
  for (const p of paragraphsOf(trimmed)) {
    const key = paragraphKey(p);
    if (key.length >= DUPLICATE_PARAGRAPH_CHARS) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    kept.push(p);
  }
  const added = kept.join('\n\n');
  return { text: [base, added].filter(Boolean).join('\n\n'), added };
}

/** 兩段文字合起來有多少字：`continue` 寫法下「這一章寫到多少字了」要連已有的一起算。 */
export function wordsOf(...parts: string[]): number {
  return parts.reduce((sum, p) => sum + countWords(p), 0);
}

// ---------------------------------------------------------------- 續寫鏈

/** 寫正文時的進度：第幾輪（0 = 第一次呼叫）、這一章寫到多少字了、目標多少。 */
export interface WriteProgress {
  round: number;
  words: number;
  target?: number;
}

export interface ManuscriptChainContext {
  mode: WriteMode;
  /** 本章已有的正文（`continue` 寫法才有）。「寫到多少字了」連它一起算。 */
  existing: string;
  /** 目標字數。缺席時不自動續寫（`shouldContinue`）。卡片上的「寫夠了沒有」、刪修飾的保底按它算。 */
  target?: number;
  /**
   * 續寫往哪兒寫：該不該再續、還差多少字按它算。開著刪修飾時比 `target` 多兩成（`writingAim`），
   * 刪完落在目標附近；缺席就是 `target`。
   */
  aim?: number;
  /** 上一章的結尾（重演檢測用）。第 1 章、上一章還沒寫正文時缺席。 */
  prevEnding?: string;
  /** 第一次呼叫有沒有思考——截斷且沒幾個字時，報錯的說法不一樣。 */
  reasoned: boolean;
  /** 後面幾章才登場的人（名字與別名）：寫完查一遍有沒有提前寫進來。 */
  notYet?: readonly (NotYet & { aliases?: readonly string[] })[];
  /** 這本書寫正文時不該用的詞：續寫那一輪告訴它已經用了哪幾個，寫完數一遍。 */
  banned?: readonly string[];
  /** 寫完之後跑一輪刪修飾（`trim.ts`）。設定裡的「寫完正文刪修飾」。 */
  trim?: boolean;
  /** 每一輪開始時報一次進度。流式期間的進度由 `ChainIO.call` 的 `progress` 選項另報。 */
  onProgress?(p: WriteProgress): void;
  signal?: AbortSignal;
}

export interface ManuscriptChainResult extends ChainResult {
  /** 續寫了幾輪（不含第一次呼叫；丟棄的那一輪也算）。 */
  rounds: number;
  /** 這一章寫完之後的總字數（`continue` 寫法含已有的）。 */
  words: number;
  /** 這一次新寫的字數。 */
  added: number;
  /** 不到目標的八成。 */
  short: boolean;
  /** 結尾停在半句上：最後一輪仍被輸出上限截斷，或者結尾那個字不是句末標點（{@link endsMidSentence}）。 */
  truncated: boolean;
  /** 新稿開頭與上一章結尾重合的那一段原文（重演）。 */
  replay?: string;
  /** 後面幾章才登場、卻寫進了這一次新寫的正文裡的人。 */
  early?: EarlyEntrance[];
  /** 刪修飾真刪了字時：刪之前那一版（只含這一次新寫的，與 `raw` 對應）。 */
  untrimmed?: string;
}

/**
 * 寫一章正文：第一次呼叫之後按需續寫，最後查一遍重演。見檔案頭與三期計劃 §3。
 *
 * `first` 是已經跑完的第一次呼叫（對話頁流式跑的那一次）。返回的 `raw` 只含**這一次
 * 新寫的**正文——`continue` 寫法落盤是追加，已有的那部分不該再寫一遍。
 */
export async function completeManuscript(
  first: CallOutcome,
  io: ChainIO,
  ctx: ManuscriptChainContext
): Promise<ManuscriptChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  const base = ctx.existing.trim();
  const aim = ctx.aim ?? ctx.target;
  // 「接著寫」的第一次呼叫也可能把已寫的最後幾句複述一遍：一樣去重疊。
  let added = joinContinuation(base, cleanOutput(first.text)).added;
  let stop = first.stop;
  const total = () => wordsOf(base, added);

  if (stop === 'maxTokens' && countWords(added) < STARVED_CHARS) {
    t.fail(
      ctx.reasoned
        ? '模型把輸出上限幾乎全用在了思考上，正文還沒寫幾個字就被截斷了。調大設定頁的「最大輸出 token」，或降低思考深度再試。'
        : '正文還沒寫幾個字就被輸出上限截斷了。調大設定頁的「最大輸出 token」再試。'
    );
  }
  // 模型說正常收尾（或閘道器不報原因）、結尾卻停在半句上：照截斷處理——往後接，不回退。
  const settle = (s: StopSignal | undefined, text: string, round: string): StopSignal | undefined => {
    if (s === 'maxTokens' || s === 'other' || !endsMidSentence(text)) {
      return s;
    }
    t.note(`${round}的結尾停在半句上（${s === 'end' ? '模型報的是正常收尾' : '閘道器沒報收尾原因'}），按截斷接著寫`);
    return 'maxTokens';
  };
  stop = settle(stop, added, '第一次呼叫');

  let rounds = 0;
  let recoveryUsed = false;
  let recoveryPending = false;
  let rewinds = 0;
  /** 最近一次回退之前這一章寫到多少字：回退那一輪寫完之後對著它算淨多了幾個字。 */
  let beforeCut = 0;
  /**
   * 上一輪新寫的那一段（第一次呼叫之後就是 `added` 全部）。**回退只在它裡面切**：前幾輪已經接受的
   * 正文不再動，最多也只白扔上一輪的四分之一。
   */
  let fresh = added;
  /**
   * 回退時切掉、還沒有被新寫的結尾替上的那一截。回退之後那一輪沒寫成（呼叫失敗、截斷丟棄）
   * 就把它放回去——寧可留著那個短一點但收了尾的結尾，也不留一章沒有結尾的正文。
   */
  let pendingCut: string | undefined;
  const restoreCut = () => {
    if (pendingCut) {
      added = [added, pendingCut].filter(Boolean).join('\n\n');
      pendingCut = undefined;
      // 放回去的是一個正常收尾的結尾，不是停在半句上的那一截。
      stop = 'end';
      io.reset?.(added);
      t.note('回退之後那一輪沒寫成，原來的結尾放回去了');
    }
  };
  const usedBanned = (text: string) => (ctx.banned?.length ? countBanned(text, ctx.banned) : []);
  let lastGain = Number.POSITIVE_INFINITY;
  while (shouldContinue({ words: total(), target: aim, stop, rounds })) {
    // 正常收尾、而上一輪只多了幾句：模型認為這一章寫完了，再催也是注水（上游 GD:1152）。
    if (stop !== 'maxTokens' && lastGain < MIN_ROUND_GAIN) {
      t.note(`續寫第 ${rounds} 輪只多了 ${lastGain} 字，模型已經收尾，不再續寫`);
      break;
    }
    // 正常收尾又不夠八成：結尾已經收在這一章的最後一場上了，往後接就越過它（見檔案頭）。先回退到收尾那一場
    // 之前再寫；寫完又是這樣就再回退一次——一次寫一千字上下的模型，一章要這樣走兩三輪。回退那一輪
    // 淨多的不到 300 字、或者上一輪那一段短得沒法切，就停在這裡，不往收尾後面接。
    let rewinding = false;
    if (stop === 'end') {
      if (rewinds > 0 && total() - beforeCut < MIN_ROUND_GAIN) {
        t.note(`回退重寫那一輪只比回退之前多了 ${total() - beforeCut} 字，模型又收了尾，沒有再往收尾後面續寫`);
        break;
      }
      const point = rewindPoint(fresh);
      if (!point && rewinds > 0) {
        t.note(`回退重寫之後模型又收了尾（到 ${total()} 字），上一輪那一段太短、沒法再切，沒有再往收尾後面續寫`);
        break;
      }
      if (point) {
        beforeCut = total();
        const head = added.slice(0, added.length - fresh.length).trim();
        added = [head, point.keep].filter(Boolean).join('\n\n');
        fresh = point.keep;
        pendingCut = point.cut;
        rewinds++;
        rewinding = true;
        io.reset?.(added);
        t.note(
          `寫到 ${beforeCut}${ctx.target ? ` / ${ctx.target}` : ''} 字就收了尾：` +
            `拿掉結尾 ${point.paragraphs} 段（約 ${countWords(point.cut)} 字），從它前面接著寫，寫足之後重新收尾`
        );
      }
    }
    rounds++;
    const written = [base, added].filter(Boolean).join('\n\n');
    const before = total();
    // 上一輪停在半句上：新寫的是那半句的後半截，直接接上，不空行。
    const glue = endsMidSentence(written) ? '' : '\n\n';
    ctx.onProgress?.({ round: rounds, words: before, target: ctx.target });
    const messages = await io.build({
      step: {
        kind: 'continuation',
        tail: continuationTail(written),
        written: before,
        remaining: aim ? Math.max(0, aim - before) : undefined,
        recovery: recoveryPending,
        ...(rewinding ? { rewound: true } : {}),
        similes: countSimiles(written),
        dialogue: dialogueShare(written),
        ...(usedBanned(written).length > 0 ? { banned: usedBanned(written) } : {}),
      },
    });
    let out: CallOutcome;
    try {
      out = await t.call(
        io,
        messages,
        recoveryPending ? `續寫第 ${rounds} 輪（恢復）` : rewinding ? `續寫第 ${rounds} 輪（回退重寫結尾）` : `續寫第 ${rounds} 輪`,
        {
          separator: glue,
          progress: { round: rounds, base: before },
        }
      );
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal?.aborted) {
        throw err;
      }
      // 一次網路抖動不該把前面寫好的幾千字帶走（D6）。
      t.note(`續寫第 ${rounds} 輪呼叫失敗（${describeError(err)}），停在這裡，已寫的保留`);
      io.reset?.(added);
      restoreCut();
      break;
    }
    const joined = joinContinuation(written, cleanOutput(out.text));
    const gain = countWords(joined.added);
    const outStop = settle(out.stop, `${written}${glue}${joined.added}`, `續寫第 ${rounds} 輪`);

    // 被截斷又幾乎沒寫出新東西：這一輪丟掉，只給一次恢復機會（上游 GD:1130-1146）。
    if (outStop === 'maxTokens' && gain < MIN_ROUND_GAIN) {
      io.reset?.(added);
      if (recoveryUsed) {
        t.note(`續寫第 ${rounds} 輪（恢復）仍被截斷、只多了 ${gain} 字，已丟棄，停在這裡；已寫的保留`);
        stop = outStop;
        restoreCut();
        break;
      }
      recoveryUsed = true;
      recoveryPending = true;
      t.note(`續寫第 ${rounds} 輪被截斷、只多了 ${gain} 字，已丟棄，再給一次恢復機會`);
      stop = outStop;
      lastGain = Number.POSITIVE_INFINITY;
      continue;
    }
    added = added ? `${added}${glue}${joined.added}` : joined.added;
    fresh = joined.added;
    pendingCut = undefined;
    stop = outStop;
    recoveryPending = false;
    lastGain = gain;
    t.note(`續寫第 ${rounds} 輪：多了 ${gain} 字，到 ${total()}${ctx.target ? ` / ${ctx.target}` : ''} 字`);
  }
  // 到了輪數上限、回退之後那一輪還沒寫成：同樣放回去。
  restoreCut();

  if (rounds >= MAX_CONTINUE_ROUNDS && shouldContinue({ words: total(), target: aim, stop, rounds: 0 })) {
    t.note(`續寫到了上限 ${MAX_CONTINUE_ROUNDS} 輪，沒有再續`);
  }
  if (stop === 'other') {
    t.note('模型因為別的原因停下了（常見的是內容審查），沒有再續寫');
  }
  let untrimmed: string | undefined;
  if (ctx.trim) {
    // 刪之前夠八成的，刪完也得夠：不然主按鈕轉去推「接著寫」，這一輪等於白刪。
    const floor = ctx.target && total() >= lowerBound(ctx.target) ? lowerBound(ctx.target) - wordsOf(base) : undefined;
    const trimmed = await trimModifiers(io, t, added, { floor, signal: ctx.signal });
    added = trimmed.text;
    untrimmed = trimmed.untrimmed;
  }
  const chapterText = [base, added].filter(Boolean).join('\n\n');
  const midSentence = endsMidSentence(chapterText);
  const truncated = stop === 'maxTokens' || midSentence;
  if (truncated) {
    t.note(
      midSentence
        ? `結尾停在半句上：「${chapterText.trim().slice(-20)}」。${ctx.target ? '續寫沒能把它接完，' : '細綱與配置裡都沒寫目標字數，所以沒有自動續寫，'}寫入後可以接著寫或手改。`
        : ctx.target
          ? '最後一輪仍被輸出上限截斷，結尾可能停在半句上。寫入後可以接著寫或手改。'
          : '輸出被輸出上限截斷，結尾可能停在半句上。細綱與配置裡都沒寫目標字數，所以沒有自動續寫。'
    );
  }
  const words = total();
  const short = !!ctx.target && words < lowerBound(ctx.target);
  if (short) {
    t.note(`未寫夠：這一章寫到 ${words} / ${ctx.target} 字，不到八成。已寫的照樣可以寫入，之後主按鈕會推「接著寫」`);
  }

  let replay: string | undefined;
  if (ctx.mode !== 'continue' && ctx.prevEnding) {
    const v = detectReplay(ctx.prevEnding, added);
    if (v.hit) {
      replay = v.quote;
      t.note(`開頭與上一章結尾大段重合（連續 ${v.run} 字），可能把上一章最後一場又演了一遍`);
    }
  }

  // 寫完查三樣（五期補遺 §1.2、§1.3、§1.5）：只記說明，不改正文。
  const similes = countSimiles(chapterText);
  if (similes > SIMILE_LIMIT) {
    t.note(`比喻詞${SIMILE_WORDS.map((w) => `「${w}」`).join('')}全章合計 ${similes} 次（${describeSimiles(chapterText)}），超過 ${SIMILE_LIMIT} 次的上限`);
  }
  const dialogue = dialogueShare(chapterText);
  if (dialogue < DIALOGUE_FLOOR) {
    t.note(`對白段只佔 ${Math.round(dialogue * 100)}%（人類網文約三成），讀起來像旁白`);
  }
  const banned = usedBanned(chapterText);
  if (banned.length > 0) {
    t.note(`正文用到了這本書不該用的詞：${describeBanned(banned)}。換成這個故事裡的人會說的話`);
  }
  const acronyms = latinAcronyms(added);
  if (acronyms.length > 0) {
    t.note(`正文裡有英文縮寫：${acronyms.join('、')}。故事的年代用不上這種說法的話，改成那個年代的人會說的話`);
  }
  const early = ctx.notYet?.length ? findEarlyEntrances(added, ctx.notYet) : [];
  for (const e of early) {
    t.note(`${e.name}按細綱第 ${e.no} 章才登場，本章已經寫到了：「${e.quote}」`);
  }

  return {
    raw: added,
    notes: t.notes,
    calls: t.calls,
    rounds,
    words,
    added: countWords(added),
    short,
    truncated,
    replay,
    ...(early.length > 0 ? { early } : {}),
    ...(untrimmed ? { untrimmed } : {}),
  };
}
