/**
 * 定稿一章（D17、D18、D15、七期）：
 *
 * ```
 * 1. 反向更新細綱（1 次）：當前細綱 + 正文 → 七節（含連續性事實）→ 證據用 bigram 在正文裡找（0 次）
 *    → 舊版進回收站 → 落盤（記 sourceHash / cast，writtenFrom 重新整理）
 * 2. 角色狀態（0–1 次）：本章出場、已經建卡的人 → 按歸屬寫、或掛黃 ❗
 * 3. 敘事線（1–3 次）：a 認事件（線是空的也認）→ c 有新線 / 新伏筆時歸併 → 證據逐字校驗後追加
 *    → b 本章動過的線更新當前進度（作者改過的不寫）
 * 4. 故事時間（1 次，2026-10-24 重做）：上一章的結尾 + 前面幾章的時間 + 本章正文 → 晚幾天、章內幾跳、結尾時段、正文寫明的日子
 *    → 證據逐字校驗後寫進 threads/时间线.md（機器寫的行照新推的換，作者的不動；features/storyTime.ts）
 * ```
 *
 * 後幾步讀的都是第一步更新過的那份細綱（出場人物、時間地點）與正文。
 *
 * 2026-10-25 起每一步都改成轉寫：幹活的模型按格式寫自然語言，「轉寫」那一檔的模型照抄成原來那份 JSON（features/transcribe.ts）。
 * 幾步共用一個轉寫呼叫（{@link FinalizeOptions.transcribe}），轉寫那一檔不跟確認框上為這一次挑的模型。
 *
 * 前兩步移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts` 的
 * `buildFinalizePostProcessSteps`（FC:246-563）的後兩步。知識庫匯入、定稿收據、來源 hash、
 * 專案租約不搬（總計劃 §1 #14）。第三步上游不在定稿裡（是敘事線編輯器裡的一顆按鈕），敘事線重做之後
 * 拆成認事件 / 當前進度 / 歸併三段，見 features/threads.ts 的 `recordThreads`。
 *
 * ## 幾步的失敗各算各的
 *
 * 更新細綱是這一章能不能「記住」的那一步：它失敗了整個定稿就算沒成，紅 ❗ 掛在章節上，細綱
 * 一個字不動。角色狀態、敘事線、故事時間失敗時細綱照樣算數——黃 ❗ 掛在章節上（第 16 條：
 * 部分完成），角色卡 / 敘事線 / 時間線停在上一次，下次重新定稿會再來一遍。
 *
 * ## 用哪個模型
 *
 * 單章入口（主按鈕、章節工作臺、MCP 的 `summary finalize`）用對話頁選定的那個。批次入口
 * 各走各的檔（細綱與敘事線 `plotSummary`、角色狀態 `characterCard`），失敗換同檔其餘。工程頁章節右鍵
 * 先彈確認框（`askFinalizeChapterTask`），預設仍是對話頁那個，可以為這一次換一個、或按分檔。
 *
 * 後三步在 finalizeSteps.ts：工程頁黃條上的「立即同步」（summarize.ts 的 `syncSummaries`）更新完細綱之後
 * 也走它們，同步過的章與逐章定稿的章是同一個結果。
 */
import { getHost } from '../host';
import { readConfig } from '../config';
import { createModelPool } from '../llm/pool';
import { LlmProvider } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { withCallChoice } from '../runtime/callScope';
import { scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { FINALIZE_CALLS, describeCalls } from '../model/pipeline';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { askCall } from './askCall';
import { poolTranscriber } from './poolIO';
import { TranscribeCall } from './transcribe';
import { SummaryOutcome, summarizeChapter } from './summarize';
import { ModelRunner, StateAndThreadsOutcome, updateStateAndThreads } from './finalizeSteps';
import { describeThreads } from './threads';
import { describeTimeOutcome } from './storyTime';

export type { ModelRunner } from './finalizeSteps';

const log = scoped('同步');

/** 只有一個模型（對話頁選定的那個）時的 runner：不換人，視窗取全域配置。 */
export function singleModel(llm: LlmProvider): ModelRunner {
  const config = readConfig();
  return {
    run: (_what, fn) => fn(llm),
    primaryBudget: { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens },
  };
}

export interface FinalizeOptions {
  signal?: AbortSignal;
  /** 更新細綱那一步用誰。預設對話頁選定的那個。 */
  summary?: ModelRunner;
  /** 角色狀態那一步用誰。預設同更新細綱。 */
  state?: ModelRunner;
  /** 敘事線那一步（認事件、當前進度、歸併）與故事時間那一步用誰。預設同更新細綱（讀一章、按合同摘出東西，是同一種活）。 */
  threads?: ModelRunner;
  /**
   * 轉寫那一次怎麼調（2026-10-25 起改成轉寫，幾步共用）。預設走「轉寫」那一檔（features/poolIO.ts 的 `poolTranscriber`），
   * 那一檔一個可用的模型都沒有時用更新細綱那一個。
   */
  transcribe?: TranscribeCall;
  /** 走到第幾步了（任務條上那一行）。 */
  onStep?(step: 'summary' | 'state' | 'threads' | 'time'): void;
}

export interface FinalizeOutcome extends StateAndThreadsOutcome {
  /** 實際調了幾次模型（四步合計，寫 3–6 次，加上轉寫的）。 */
  calls: number;
  summary: SummaryOutcome;
}

/**
 * 定稿一章。沒有可用的模型、正文是空的時返回 undefined（已經說過原因）；模型返回解析不出時拋錯
 * （失敗已經掛在章節上，細綱沒動）。
 */
export async function finalizeChapter(
  project: NovelProject,
  chapter: Chapter,
  opts: FinalizeOptions = {}
): Promise<FinalizeOutcome | undefined> {
  let summaryRunner = opts.summary;
  if (!summaryRunner) {
    const llm = await resolveProvider();
    if (!llm) {
      log.warn(`第 ${chapter.order} 章沒有同步：沒有可用的模型（未配置或未錄入 API Key）`);
      getHost().toast('沒有可用的模型：先在設定頁配一個。', 'error');
      return undefined;
    }
    summaryRunner = singleModel(llm);
  }
  const transcribe = opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, summaryRunner);
  opts.onStep?.('summary');
  const summary = await summaryRunner.run(`第 ${chapter.order} 章 · 細綱`, (llm) =>
    summarizeChapter(project, chapter, llm, opts.signal, summaryRunner!.primaryBudget, transcribe)
  );
  if (!summary) {
    return undefined;
  }
  const rest = await updateStateAndThreads(project, chapter, summary.cast, {
    state: opts.state ?? summaryRunner,
    threads: opts.threads ?? summaryRunner,
    signal: opts.signal,
    onStep: opts.onStep,
    transcribe,
  });
  return { ...rest, calls: summary.calls + rest.calls, summary };
}

/**
 * 「第 3 章已定稿：細綱照正文更新，7 條連續性事實；林昭、沈氏的當前狀態更新到這一章；敘事線：林昭與沈青推進；
 * 埋〈玉佩的來歷〉」。敘事線一定說（設計稿：什麼都沒認出就說「敘事線沒有新進展」）。丟了的事實、沒覆蓋的卡、沒記的事件、
 * 沒成的那一步都說出來（第 2 條）；舊版細綱進了回收站也說。
 */
export function describeFinalize(no: number, o: FinalizeOutcome): string {
  const parts = [
    `第 ${no} 章已同步：細綱照正文${o.summary.trashed ? '更新（舊版已放進回收站）' : '整理了一份'}，${o.summary.facts.length} 條連續性事實`,
  ];
  if (o.summary.dropped.length > 0) {
    parts.push(`另有 ${o.summary.dropped.length} 條在正文裡找不到依據，沒有收`);
  }
  const s = o.states;
  if (o.stateError) {
    parts.push(`角色狀態沒更新成（${o.stateError}）`);
  } else if (s) {
    if (s.updated.length > 0) {
      parts.push(`${s.updated.join('、')}的當前狀態更新到這一章`);
    }
    if (s.guarded.length > 0) {
      parts.push(`${s.guarded.join('、')}的當前狀態你改過，沒有覆蓋（卡上掛了黃 ❗，可以對比後決定）`);
    }
    if (s.calls === 0) {
      parts.push('出場的人都還沒有角色卡，沒有狀態可更新');
    }
  }
  if (o.threadsError) {
    parts.push(`敘事線沒認成（${o.threadsError}）`);
  } else if (o.threads) {
    parts.push(describeThreads(o.threads));
  }
  const time = describeTimeOutcome(o);
  if (time) {
    parts.push(time);
  }
  return `${parts.join('；')}。`;
}

/**
 * 單章定稿的外殼：進度、日誌、完成提示。主按鈕、章節工作臺、工程頁右鍵與 VS Code 的
 * 「定稿這一章」命令共用這一份（第 11 條：不悶著幹活）。`runners` 預設用對話頁選定的那個。返回實際呼叫次數。
 */
export async function finalizeChapterTask(
  project: NovelProject,
  chapter: Chapter,
  runners: Pick<FinalizeOptions, 'summary' | 'state' | 'threads'> = {}
): Promise<number> {
  let calls = 0;
  await runTask(
    `同步第 ${chapter.order} 章`,
    async ({ signal, report }) => {
      report({ message: `《${chapter.title}》 · 細綱`, current: 0, total: 4 });
      const outcome = await finalizeChapter(project, chapter, {
        ...runners,
        signal,
        onStep: (step) => {
          if (step === 'state') {
            report({ message: `《${chapter.title}》 · 角色狀態`, current: 1, total: 4 });
          } else if (step === 'threads') {
            report({ message: `《${chapter.title}》 · 敘事線`, current: 2, total: 4 });
          } else if (step === 'time') {
            report({ message: `《${chapter.title}》 · 故事時間`, current: 3, total: 4 });
          }
        },
      });
      report({ message: outcome ? '完成' : '未同步', current: 4, total: 4 });
      if (outcome) {
        calls = outcome.calls;
        getHost().toast(
          describeFinalize(chapter.order, outcome),
          outcome.stateError || outcome.threadsError || outcome.timeError ? 'error' : 'info'
        );
      }
    },
    { scope: '同步' }
  );
  return calls;
}

/**
 * 工程頁章節右鍵「定稿」「重新定稿」：先經確認框問這一次用哪個模型、帶多少上下文（features/askCall.ts），再走
 * {@link finalizeChapterTask}。模型下拉框開啟時選著對話頁那個——直接點與不問時是同一個模型；
 * 選「按分檔」就與「立即同步」一樣各走各的檔（細綱與敘事線 `plotSummary`、角色狀態 `characterCard`），
 * 失敗換同檔其餘。取消返回 0。
 */
export async function askFinalizeChapterTask(project: NovelProject, chapter: Chapter): Promise<number> {
  // 定稿過、正文沒再改過的是「重新定稿」，與右鍵選單上的字同一個判據。
  const plot = await project.plotOfChapter(chapter);
  const verb = plot?.sourceHash && plot.sourceHash === chapter.contentHash ? '重新同步' : '同步';
  const { why, ...calls } = FINALIZE_CALLS;
  const answer = await askCall({
    message: `${verb}第 ${chapter.order} 章《${chapter.title}》：照正文更新細綱、更新出場角色的當前狀態、認這一章在敘事線上發生了什麼、推這一章的故事時間。${describeCalls(calls)}。`,
    actions: [verb],
    detail: `${why}。\n舊版細綱先複製一份進 .novelwarden/.trash/。`,
    tasks: ['plotSummary', 'characterCard', 'transcribe'],
    // 定稿認敘事線帶幾條線、幾條伏筆隨詳細度（`recordThreads`）。
    contextDetail: true,
    preset: { model: readConfig().model || undefined },
  });
  if (answer?.action !== verb) {
    log.info(`作者取消了${verb}第 ${chapter.order} 章`);
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const summary = await createModelPool({ task: 'plotSummary', concurrent: false });
    if (!summary) {
      getHost().toast('沒有可用的模型：先在設定頁配一個。', 'error');
      return 0;
    }
    // 角色狀態走「角色卡」檔（與「立即同步」同一個分法），沒配就沿用定稿那一檔。
    const state = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? summary;
    log.info(`${verb}第 ${chapter.order} 章，使用模型 ${summary.label}`);
    return finalizeChapterTask(project, chapter, { summary, state, threads: summary });
  });
}
