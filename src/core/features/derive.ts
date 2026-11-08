/**
 * 從已寫正文補齊（拆書 A 的後一半）：作者已經寫了 N 章（匯入的原稿，或者老工程），把新鏈路上缺的那幾樣
 * **照正文整理出來**，之後批次寫章接著往下寫。
 *
 * ```
 * 一、細綱（第 1–N 章裡沒定稿的、定稿後正文改過的）  ← 第一次確認：只報細綱的次數
 * 二、配置 → 前提 → 角色卡 → 世界觀（只補空白）     ← 第二次確認：細綱出來之後次數才算得準
 *     → 設定條目（還一條都沒有時，從名錄建）
 *     → 全文大綱（落後就增量更新）
 *     → 敘事線（一條線都沒有時先從情節大綱排一次；再從水位之後逐章補記，每章寫 1–3 次、每次寫完轉寫 1 次）
 * ```
 *
 * 第一步就是定稿的第一步（`summarizeChapters`）：照正文寫出 `summaries/NNN-<章名>.md`，帶 `sourceHash`
 * 與 `cast`——這幾章因此直接算定稿過，不必再另排一遍細綱。情節大綱是各章細綱「梗概」的彙總，細綱齊了它也就齊了：
 * 從前另有一步「照細綱整理情節大綱，每次 20 章」，刪了（docs/design/plans/2026-10-22-outline-from-plots.md）。
 *
 * 借鑑 AI-Novel-Writer 的「小說拆解」（`import-workflow.ts` 的 global / blueprints 兩步，
 * `import-novel.command.ts`）：上游推演設定只看首末兩章各 3000 字、匯入當前工程會覆蓋原有配置與角色。
 * 這裡設定看全書梗概加均勻抽樣（context/layers/written.ts），而且**只補空白**——已經有的一件不動
 * （第 19 條的批次那一面）。
 *
 * ## 為什麼是這個順序
 *
 * 與新鏈路往下展開的順序一致，每一件都吃前面幾件：前提照著配置寫，世界觀照著前提與角色。
 * 細綱排最前：建卡要從定稿過的細綱裡認出場人物，情節大綱就是細綱的梗概。設定條目排在建卡之後：名錄裡
 * 撞上角色卡的名字是人、不是設定，卡建好了才認得出來。
 *
 * 設定條目不走架構那一件「設定清單」：有正文的書那一件本來就算填過（`isLoreListFilled`），設定照名錄
 * 來——定稿過的細綱「設定」一節裡出現過、還沒有條目的名字，出現過的全部，
 * 與名錄上「全部建條目」同一份 `createLoreEntries`。它是額外的一道：沒建成不算補齊失敗，掛黃 ❗、
 * 後面幾樣照常補。
 *
 * ## 兩次確認（第 4 條）
 *
 * 建卡要調幾次，取決於細綱裡認出了誰、各出場幾章——細綱沒齊時算不出來。所以先只報細綱；細綱出來之後
 * 第二個框把其餘幾樣的次數一次列全。細綱本來就齊的，只彈第二個。
 *
 * ## 敘事線（敘事線重做四期）
 *
 * 第一步整理出來的細綱直接算定稿過，可定稿第三步（認敘事線）沒走——這些章「定稿了、敘事線還沒判」。最後接上
 * 「排線 + 補記」（features/threadsBackfill.ts，與工程頁「從正文補記」同一份）：一條線都沒有、有情節大綱（細綱整理出來了就有），
 * 先從情節大綱排一次；再從水位之後逐章補記到第 N 章。次數並進第二個確認框（`threadsBackfillCalls`：每章寫 1–3 次、各轉寫 1 次，排線 2 次）。它與設定條目、全文大綱
 * 一樣是額外的一道：排在最後，沒排成、一章沒判成都不算補齊失敗（補記停在沒判成的那一章、失敗掛在那一章上，完成提示說一句），
 * 已經判過的留著，之後在敘事線頁籤點「從正文補記」接著來。
 *
 * ## 不做的
 *
 * - 不帶寫作技能（context/layers/skill.ts）：這一次是照實整理，不是規劃。
 *
 * 一件失敗就停，已經寫好的留著；失敗掛在那一行上（第 16 條）。返回實際調了幾次模型。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CancelledError } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';
import { defaultTotalChapters, roundedAverageWords } from '../model/importText';
import {
  CONFIG_CALLS,
  CallEstimate,
  ONE_CALL,
  SETTING_DOC_LABEL,
  SettingDoc,
  addCalls,
  describeCalls,
  loreEntryCalls,
} from '../model/pipeline';
import { LlmTask } from '../model/tiers';
import { CallChoice } from '../model/callChoice';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { BuildRequest } from '../context/builder';
import { ChainError } from '../generation/structured';
import { acceptArtifact } from '../generation/accept';
import { buildBookFacts, nextWritableChapterNo } from '../views/pipeline';
import { UnfiledLore, buildLoreIndex } from '../views/lore';
import { normalizeLoreName } from '../model/loreFile';
import { confirmDespiteGap } from './chapterGap';
import { isArtifactEmpty, parseArtifact } from './artifact';
import { CastCardsPlan, createCastCards, planCastCards } from './characterCard';
import { BUILD_MIN_CHAPTERS, createLoreEntries } from './lore';
import { checkpointBefore } from './checkpoint';
import { settingKey, settingRaw } from './pipelineBatch';
import { poolIO } from './poolIO';
import { summarizeChapters, updateGlobalSummary } from './summarize';
import { ThreadsBackfillPlan, describeBackfill, planThreadsBackfill, runThreadsBackfill } from './threadsBackfill';
import { SUMMARIZE_CALLS, THREADS_JUDGE_CALLS } from '../model/pipeline';
import { describeChapterRuns } from '../model/threadFile';

const log = scoped('補齊');

/** 補建角色卡：定稿過的細綱裡出場至少這麼多章的人；一個都沒有就降到 1。 */
export const DERIVE_CARD_MIN_APPEARANCES = 2;
/** 補建設定條目：名錄裡出現至少這麼多章的（與「全部建條目」同一個門檻）。 */
export const DERIVE_LORE_MIN_CHAPTERS = BUILD_MIN_CHAPTERS;
/** 全文大綱一次並不完時最多再並幾次。 */
export const GLOBAL_SUMMARY_ROUNDS = 5;
/** 小說配置沒寫每章字數、已寫的章也量不出來時的預設（與補齊架構一致）。 */
const DEFAULT_WORDS = 3000;

const EXACT_CALLS = (n: number): CallEstimate => ({ low: n, high: n, max: n });

export async function deriveFromText(project: NovelProject): Promise<number> {
  const chapters = (await project.listChapters()).filter((c) => c.wordCount > 0);
  const through = nextWritableChapterNo(chapters) - 1;
  if (through < 1) {
    getHost().toast(
      chapters.length > 0 ? '第 1 章還沒有正文：從已寫正文補齊要從第 1 章起連續有正文。' : '還沒有正文，沒有可以整理的東西。',
      'error'
    );
    return 0;
  }
  if (!(await confirmDespiteGap(chapters, '從已寫正文補齊'))) {
    log.info('章號斷了一截，作者沒有繼續從已寫正文補齊');
    return 0;
  }
  const written = chapters.filter((c) => c.order <= through);

  let calls = 0;
  /** 先整理細綱那一問的選擇：其餘幾樣那一問開啟時預設跟著它（同一件事的兩步）。 */
  let preset: CallChoice | undefined;
  /** 細綱那一步已經先存了存檔點：其餘幾樣接著做，不另存。 */
  let checkpointed = false;
  project.invalidate();
  const stale = (await project.staleChapters()).filter((c) => c.order <= through && c.wordCount > 0);
  if (stale.length > 0) {
    const r = await summarizeFirst(project, stale, through);
    calls += r.calls;
    if (!r.ok) {
      return calls;
    }
    preset = r.choice;
    checkpointed = r.checkpoint !== undefined;
    project.invalidate();
  }
  return calls + (await deriveRest(project, through, written, calls, preset, checkpointed));
}

// ---------------------------------------------------------------- 一、細綱

async function summarizeFirst(
  project: NovelProject,
  stale: Chapter[],
  through: number
): Promise<{ ok: boolean; calls: number; choice?: CallChoice; checkpoint?: string }> {
  const lanes = Math.min(readConfig().concurrency, stale.length);
  const n = stale.length;
  // 一章寫 1 次、轉寫 1 次，轉寫不合格重轉 1 次（2026-10-25 起改成轉寫）。
  const estimate: CallEstimate = { low: n * SUMMARIZE_CALLS.low, high: n * SUMMARIZE_CALLS.high, max: n * SUMMARIZE_CALLS.max };
  const answer = await askCall({
    message: `從已寫正文補齊第 1–${through} 章：先照正文給 ${n} 章整理細綱（沒同步的、同步後正文改過的），${describeCalls(estimate)}。現在開始？`,
    actions: ['先整理細綱'],
    detail: [
      `每章 ${SUMMARIZE_CALLS.low} 次，最多 ${SUMMARIZE_CALLS.max} 次（${SUMMARIZE_CALLS.why}）。`,
      lanes > 1 ? `併發 ${lanes} 路，各章之間沒有先後依賴。` : '序列逐章處理（併發數為 1）。',
      '已經有細綱的章拿著它與正文對照著改，舊版先複製一份進 .novelwarden/.trash/。',
      '細綱出來之後再算建卡與設定要調幾次（建卡次數要看細綱裡認出了誰），到時再問你一次。',
    ].join('\n'),
    tasks: ['plotSummary', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '先整理細綱') {
    log.info('作者沒有開始從已寫正文補齊（細綱那一步）');
    return { ok: false, calls: 0 };
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'plotSummary', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，從已寫正文補齊中止');
      return { ok: false, calls: 0 };
    }
    let ok = false;
    let checkpoint: string | undefined;
    let calls = 0;
    await runTask(
      '從已寫正文補齊 · 細綱',
      async ({ signal, report }) => {
        // 先存一個存檔點（features/checkpoint.ts）：一次改很多份細綱，整本退得回去。
        checkpoint = await checkpointBefore(project, '從已寫正文補齊之前');
        const r = await summarizeChapters(project, stale, { pool, lanes, signal, report });
        calls = r.calls;
        if (signal.aborted) {
          log.warn(`從已寫正文補齊被取消，細綱完成 ${r.ok}/${stale.length} 章`);
          return;
        }
        if (r.failed.length > 0) {
          getHost().toast(
            `第 ${r.failed.map((f) => f.no).join('、')} 章的細綱沒整理成（可在日誌頁看原因）。建卡要照細綱來，已經停下；補上這幾章再來一次。`,
            'error'
          );
          return;
        }
        ok = true;
      },
      { scope: '補齊' }
    );
    return { ok, calls, choice: answer.choice, checkpoint };
  });
}

// ---------------------------------------------------------------- 二、其餘幾樣

interface DerivePlan {
  /** 要補的架構幾件，按鏈路順序。 */
  settings: SettingDoc[];
  cards?: CastCardsPlan & { min: number };
  /** 要建的設定條目（還一條都沒有時，名錄裡出現 ≥`min` 章的）。每條 1 次，解析不了的重來一次。 */
  lore?: { targets: UnfiledLore[]; min: number };
  globalSummary: boolean;
  setup?: { totalChapters: number; wordsPerChapter: number };
  /** 敘事線（四期）：還沒判的章逐章補記，一條線都沒有時先排線。沒有要判的章就缺席。 */
  threads?: ThreadsBackfillPlan;
}

/**
 * `before`：前面細綱那一步已經調了幾次（完成提示報的是總數）；`preset`：那一步作者挑的模型與詳細度；
 * `checkpointed`：那一步已經先存了存檔點（同一件事的兩步，退回去就是整件事之前）。
 */
async function deriveRest(
  project: NovelProject,
  through: number,
  written: Chapter[],
  before: number,
  preset?: CallChoice,
  checkpointed = false
): Promise<number> {
  const plan = await planRest(project, through, written);
  if (!plan) {
    return 0;
  }
  const estimate = estimateOf(plan);
  const labels = [
    ...plan.settings.map((doc) => (doc === 'characters' ? '角色卡' : SETTING_DOC_LABEL[doc])),
    ...(plan.lore ? ['設定條目'] : []),
    ...(plan.globalSummary ? ['全文大綱'] : []),
    ...(plan.threads ? ['敘事線'] : []),
  ];
  if (labels.length === 0) {
    getHost().toast(`第 1–${through} 章的細綱與架構都已經有了（情節大綱是各章細綱梗概的彙總）。`);
    return 0;
  }
  const answer = await askCall({
    message: `從已寫正文補齊第 1–${through} 章：${labels.join('、')}，${describeCalls(estimate)}。現在補？`,
    actions: ['開始補齊'],
    detail: describePlan(plan, through),
    tasks: tasksOf(plan),
    contextDetail: true,
    preset,
  });
  if (answer?.action !== '開始補齊') {
    log.info('作者沒有開始從已寫正文補齊');
    return 0;
  }

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const needSetting = plan.settings.some((d) => d !== 'characters');
    const settingPool = needSetting ? await createModelPool({ task: 'setting', concurrent: false }) : undefined;
    const lanes = plan.cards ? Math.min(config.concurrency, Math.max(1, plan.cards.plans.length)) : 1;
    const cardPool = plan.cards ? await createModelPool({ task: 'characterCard', concurrent: lanes > 1 }) : undefined;
    const loreLanes = plan.lore ? Math.min(config.concurrency, Math.max(1, plan.lore.targets.length)) : 1;
    // 建條目這一道是額外的：池建不出來不攔整件事，走到那一步時掛黃、接著往下補。
    const lorePool = plan.lore ? await createModelPool({ task: 'loreSynthesis', concurrent: loreLanes > 1 }) : undefined;
    const summaryPool =
      plan.globalSummary || plan.threads ? await createModelPool({ task: 'plotSummary', concurrent: false }) : undefined;
    // 敘事線先排線走「劇情細綱」檔。
    const threadsPlanPool = plan.threads?.planFirst ? await createModelPool({ task: 'plotOutline', concurrent: false }) : undefined;
    if ((needSetting && !settingPool) || (plan.cards && !cardPool)) {
      log.error('沒有可用的模型，從已寫正文補齊中止');
      return 0;
    }

    let calls = 0;
    await runTask(
      '從已寫正文補齊',
      async ({ signal, report }) => {
        // 先存一個存檔點（features/checkpoint.ts）：一次補好幾樣，整本退得回去。細綱那一步剛存過就不另存。
        if (!checkpointed) {
          await checkpointBefore(project, '從已寫正文補齊之前');
        }
        const startedAt = Date.now();
        const steps = labels.length;
        let step = 0;
        const done: string[] = [];
        /** 停在哪、為什麼。沒有就是全補完了。 */
        let halt: string | undefined;
        const stop = (what: string, err: unknown): 'cancelled' | 'failed' => {
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`從已寫正文補齊被取消，停在${what}`);
            return 'cancelled';
          }
          halt = `${what}沒補上（${describeError(err)}）`;
          log.error(`從已寫正文補齊：${halt}`, err instanceof ChainError ? err.notes.join('\n') : err);
          return 'failed';
        };

        // 架構幾件：配置 → 前提 → 角色卡 → 世界觀。
        for (const doc of plan.settings) {
          const label = doc === 'characters' ? '角色卡' : SETTING_DOC_LABEL[doc];
          report({ message: label, current: step, total: steps });
          if (doc === 'characters') {
            const r = await deriveCards(project, plan.cards!, { signal, pool: cardPool!, config, lanes, report });
            calls += r.calls;
            if (r.outcome !== 'ok') {
              if (r.outcome === 'failed') {
                halt = r.why;
              }
              break;
            }
            done.push(`角色卡 ${r.created} 張`);
            step++;
            continue;
          }
          const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
            action: { stage: 'setting', capability: 'generate' },
            target: { kind: 'setting', doc },
            ask: '',
            derive: { through },
            ...(doc === 'config' && plan.setup ? { setup: plan.setup } : {}),
          };
          const io = poolIO(project, settingPool!, config, signal, request);
          try {
            const raw = await settingRaw(project, doc, request, io, '', plan.setup ?? { totalChapters: 0, wordsPerChapter: 0 });
            const artifact = parseArtifact(request.action, raw, request.target);
            if (isArtifactEmpty(artifact)) {
              throw new Error('模型返回的內容裡解析不出這一件');
            }
            const r = await acceptArtifact(project, request.target, artifact, { onlyBlank: true });
            log.info(`${label}已從正文整理`, r.message);
            void clearFailures(project, 'setting', settingKey(project, doc), 'setting');
            calls += io.calls();
            done.push(label);
            step++;
          } catch (err) {
            calls += err instanceof ChainError ? err.calls : io.calls();
            if (stop(label, err) === 'failed') {
              void recordFailure(project, {
                scope: '補齊',
                targetKind: 'setting',
                targetKey: settingKey(project, doc),
                severity: 'error',
                op: 'setting',
                message: `從已寫正文整理${label}失敗：${describeError(err)}`,
                detail: '從已寫正文補齊停在這一件。後面幾件依賴它，沒有繼續。',
              });
            }
            break;
          }
          project.invalidate();
        }
        const settingsDone = done.length === plan.settings.length;

        // 設定條目：建卡之後（名錄才認得出哪些名字是人）。額外的一道，沒建成掛黃、後面照常補。
        if (plan.lore && !halt && !signal.aborted && settingsDone) {
          report({ message: '設定條目', current: step, total: steps });
          const r = await deriveLore(project, plan.lore, { signal, pool: lorePool, lanes: loreLanes, report });
          calls += r.calls;
          if (r.created > 0) {
            done.push(`設定條目 ${r.created} 條`);
          }
          step++;
        }

        // 全文大綱：落後就增量更新；它是額外的一道，沒更新成不算補齊失敗。
        if (!halt && !signal.aborted && plan.globalSummary && summaryPool) {
          report({ message: '全文大綱', current: step, total: steps });
          try {
            for (let round = 0; round < GLOBAL_SUMMARY_ROUNDS; round++) {
              const g = await updateGlobalSummary(project, summaryPool, signal);
              calls += g.calls;
              if (g.calls === 0 || (g.through ?? 0) >= through) {
                break;
              }
            }
            done.push('全文大綱');
          } catch (err) {
            calls += 1;
            if (!(err instanceof CancelledError || signal.aborted)) {
              log.warn(`全文大綱沒更新成（${describeError(err)}），之後可在工程頁點「重建」`);
            }
          }
        }

        // 敘事線（四期）：排線 + 補記，排在最後。額外的一道：沒排成、一章沒判成都不算補齊失敗，完成提示裡說一句。
        let threadsNote = '';
        if (!halt && !signal.aborted && plan.threads && summaryPool) {
          report({ message: '敘事線', current: step, total: steps });
          // 走到這裡時情節大綱、角色卡都補好了：照盤上再認一遍要判哪幾章；先排線只在確認框裡報過時才排（不超過報的數，第 4 條）。
          project.invalidate();
          const fresh = await planThreadsBackfill(project, { upTo: through });
          const now = { ...fresh, planFirst: fresh.planFirst && plan.threads.planFirst };
          if (now.chapters.length > 0) {
            const o = await runThreadsBackfill(project, now, {
              pool: summaryPool,
              planPool: threadsPlanPool,
              signal,
              report: (p) => report({ ...p, message: p.message ? `敘事線 · ${p.message}` : undefined }),
            });
            calls += o.calls;
            if (o.judged.length > 0) {
              done.push(`敘事線 ${o.judged.length} 章`);
            }
            if (o.failed || (o.planned?.error && !o.cancelled)) {
              threadsNote = describeBackfill(o, now, project.relPath(project.threadsDir));
            }
          }
          step++;
        }

        report({ message: '收尾', current: steps, total: steps });
        log.info(`從已寫正文補齊結束：${done.join('、') || '什麼都沒補上'}`, `呼叫 ${calls} 次，總耗時 ${elapsed(startedAt)}`);
        if (signal.aborted) {
          return;
        }
        const head = done.length > 0 ? `已從第 1–${through} 章補上：${before > 0 ? `${before} 章細綱、` : ''}${done.join('、')}` : '';
        if (halt) {
          getHost().toast(`${head ? `${head}。` : ''}${halt}，後面的已經停下。`, 'error');
          return;
        }
        getHost().toast(
          `${head}（呼叫 ${before + calls} 次）。${threadsNote ? `${threadsNote}` : ''}接下來可以續寫大綱、批次寫第 ${through + 1} 章以後的章。`,
          threadsNote ? 'error' : 'info'
        );
      },
      { scope: '補齊' }
    );
    return calls;
  });
}

/** 細綱齊了之後，其餘幾樣各要做什麼。零呼叫。總章數沒寫時問一句（取消就返回 undefined）。 */
async function planRest(project: NovelProject, through: number, written: Chapter[]): Promise<DerivePlan | undefined> {
  project.invalidate();
  const [facts, book, manifest, entries] = await Promise.all([
    buildBookFacts(project),
    project.readBookConfig(),
    project.readManifest(),
    project.listLore(),
  ]);
  // 設定清單不在這裡：有正文的書那一件算填過，設定條目單獨一步從名錄建（見 `planLore`）。
  const settings: SettingDoc[] = (['config', 'premise', 'characters', 'world'] as SettingDoc[]).filter((doc) => !facts.settings[doc]);

  let cards: DerivePlan['cards'];
  if (settings.includes('characters')) {
    let min = DERIVE_CARD_MIN_APPEARANCES;
    let planned = await planCastCards(project, { minAppearances: min });
    if (planned.plans.length === 0) {
      min = 1;
      planned = await planCastCards(project, { minAppearances: min });
    }
    if (planned.plans.length === 0) {
      // 細綱裡一個出場人物都認不出：建不了卡，後面幾件照樣補。
      log.warn('同步過的細綱裡認不出出場人物，角色卡這一步跳過', planned.skipped.map((s) => `${s.name}（${s.reason}）`).join('、'));
      settings.splice(settings.indexOf('characters'), 1);
    } else {
      cards = { ...planned, min };
    }
  }

  let setup: DerivePlan['setup'];
  if (settings.includes('config')) {
    const words = book.wordsPerChapter ?? roundedAverageWords(written.map((c) => c.wordCount)) ?? DEFAULT_WORDS;
    let total = book.totalChapters;
    if (!total) {
      const answer = await getHost().input({
        title: '全書計劃寫多少章？',
        prompt: `已經寫了 ${through} 章。小說配置要按全書的規模排節奏，之後可以在 config.md 裡改。`,
        value: String(defaultTotalChapters(through)),
        validate: (v) => {
          const n = Number(v.trim());
          return Number.isInteger(n) && n >= through ? undefined : `填一個不小於 ${through} 的整數`;
        },
      });
      if (answer === undefined) {
        log.info('作者沒有給總章數，從已寫正文補齊沒有開始');
        return undefined;
      }
      total = Number(answer.trim());
    }
    setup = { totalChapters: total, wordsPerChapter: words };
  }

  // 敘事線（四期）：第 1–N 章裡定稿了、還沒判的章；一條線都沒有、有情節大綱（細綱整理出來了，梗概就是大綱）時先排。
  const threads = await planThreadsBackfill(project, { upTo: through });
  return {
    settings,
    cards,
    lore: entries.length === 0 ? await planLore(project) : undefined,
    globalSummary: (manifest.globalSummaryThrough ?? 0) < through,
    setup,
    ...(threads.chapters.length > 0 ? { threads } : {}),
  };
}

/**
 * 要建哪幾條設定條目：名錄裡「出現過 · 未建條目」的、出現 ≥{@link DERIVE_LORE_MIN_CHAPTERS} 章的；
 * 一個都沒有就降到 1 章（與建卡同一個降法）。名錄裡一個名字都沒有（老細綱沒記過設定）就不建。零呼叫。
 */
async function planLore(project: NovelProject): Promise<DerivePlan['lore']> {
  const { unknown } = await buildLoreIndex(project);
  let min = DERIVE_LORE_MIN_CHAPTERS;
  let targets = unknown.filter((u) => u.chapters.length >= min);
  if (targets.length === 0) {
    min = 1;
    targets = unknown;
  }
  if (targets.length === 0) {
    log.info('同步過的細綱裡沒記下設定（或者都已經有條目），設定條目這一步跳過');
    return undefined;
  }
  return { targets, min };
}

/** 確認框上那個數：每一樣的次數加起來。 */
export function estimateOf(plan: Pick<DerivePlan, 'settings' | 'cards' | 'lore' | 'globalSummary' | 'threads'>): CallEstimate {
  const parts: CallEstimate[] = [];
  for (const doc of plan.settings) {
    parts.push(doc === 'config' ? CONFIG_CALLS : doc === 'characters' ? (plan.cards?.calls ?? EXACT_CALLS(0)) : ONE_CALL);
  }
  if (plan.lore) {
    parts.push(loreEntryCalls(plan.lore.targets.length));
  }
  if (plan.globalSummary) {
    parts.push({ low: 1, high: 1, max: GLOBAL_SUMMARY_ROUNDS });
  }
  if (plan.threads) {
    parts.push(plan.threads.calls);
  }
  return parts.reduce(addCalls, { low: 0, high: 0, max: 0 });
}

/** 這一次要用到哪幾項活（確認框「按分檔」下面逐項列）。 */
function tasksOf(plan: DerivePlan): LlmTask[] {
  return [
    ...(plan.settings.some((d) => d !== 'characters') ? ['setting' as const] : []),
    ...(plan.cards ? ['characterCard' as const] : []),
    ...(plan.lore ? ['loreSynthesis' as const] : []),
    ...(plan.threads?.planFirst ? ['plotOutline' as const] : []),
    ...(plan.globalSummary || plan.threads ? ['plotSummary' as const] : []),
    // 角色卡、設定條目、敘事線、小說配置寫完都由轉寫模型照抄成 JSON（2026-10-25 起），不跟這一次挑的模型。
    ...(plan.cards || plan.lore || plan.threads || plan.settings.includes('config') ? ['transcribe' as const] : []),
  ];
}

function describePlan(plan: DerivePlan, through: number): string {
  const lines: string[] = [];
  lines.push(
    '按 配置 → 前提 → 角色卡 → 世界觀 → 設定條目 → 全文大綱 → 敘事線 的順序一件一件來，每件都照已寫正文整理；已經有的不會被改動。一件失敗就停，已經寫好的留著（設定條目、敘事線沒補成不停）。' +
      '情節大綱不用另外整理：它是各章細綱梗概的彙總，細綱齊了它就齊了。'
  );
  if (plan.setup) {
    lines.push(`小說配置按 ${plan.setup.totalChapters} 章 × ${plan.setup.wordsPerChapter} 字展開（沒寫每章字數時取已寫各章的平均）。`);
  }
  if (plan.cards) {
    const names = plan.cards.plans.map((p) => p.member.name);
    lines.push(
      `角色卡：給${names.slice(0, 12).join('、')}${names.length > 12 ? `等 ${names.length} 人` : ''}建卡（細綱裡出場 ${plan.cards.min} 章以上、還沒有卡；讀他們出場的那幾章正文，分 ${plan.cards.batches} 批，${describeCalls(plan.cards.calls)}）。` +
        (plan.cards.skipped.length > 0 ? `跳過 ${plan.cards.skipped.map((s) => `「${s.name}」（${s.reason}）`).join('、')}。` : '')
    );
  }
  if (plan.lore) {
    const names = plan.lore.targets.map((u) => u.name);
    lines.push(
      `設定條目：給${names.slice(0, 12).join('、')}${names.length > 12 ? `等 ${names.length} 條` : ''}建條目（細綱裡出現 ${plan.lore.min} 章以上、還沒有條目；` +
        `只讀同步過的細綱裡提到它們的那幾行，${describeCalls(loreEntryCalls(names.length))}）。建卡之後認得出是人的不建，次數只會更少。`
    );
  }
  if (plan.globalSummary) {
    lines.push(`全文大綱：落後於第 ${through} 章，增量更新（一次並不完再來，最多 ${GLOBAL_SUMMARY_ROUNDS} 次）。`);
  }
  if (plan.threads) {
    const t = plan.threads;
    lines.push(
      `敘事線：${t.planFirst ? '還沒有一條線，先從情節大綱排一次（排 1 次、轉寫 1 次）；再' : ''}逐章認${describeChapterRuns(t.chapters.map((c) => c.order))}在敘事線上發生了什麼` +
        `（${t.chapters.length} 章，每章 ${THREADS_JUDGE_CALLS.low}–${THREADS_JUDGE_CALLS.high} 次，按章號序列）；一章沒判成就停在那裡，不算補齊失敗，之後在敘事線頁籤點「從正文補記」接著來。`
    );
  }
  return lines.join('\n');
}

/** 建卡那一步：與「給全部出場人物建卡」同一份 `createCastCards`。一張都沒建成才算失敗。 */
async function deriveCards(
  project: NovelProject,
  plan: CastCardsPlan,
  opts: {
    signal: AbortSignal;
    pool: ModelPool;
    config: ReturnType<typeof readConfig>;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ outcome: 'ok'; calls: number; created: number } | { outcome: 'cancelled' | 'failed'; calls: number; why?: string }> {
  try {
    const r = await createCastCards(project, plan.plans, {
      signal: opts.signal,
      pool: opts.pool,
      config: opts.config,
      lanes: opts.lanes,
      report: (p) => opts.report({ message: `角色卡 · ${p.message}` }),
    });
    project.invalidate();
    if (opts.signal.aborted) {
      return { outcome: 'cancelled', calls: r.calls };
    }
    if (r.created === 0) {
      return { outcome: 'failed', calls: r.calls, why: `角色卡一張都沒建成（${r.failed} 張失敗，空卡已留下）` };
    }
    if (r.failed > 0) {
      log.warn(`角色卡建了 ${r.created} 張，${r.failed} 張失敗（空卡已留下，掛在那張卡上）`);
    }
    return { outcome: 'ok', calls: r.calls, created: r.created };
  } catch (err) {
    // 拋出來（取消、建卡本身出錯）就不知道調了幾次：按報過的預計次數記。
    if (err instanceof CancelledError || opts.signal.aborted) {
      return { outcome: 'cancelled', calls: plan.calls.high };
    }
    return { outcome: 'failed', calls: plan.calls.high, why: `角色卡沒建成（${describeError(err)}）` };
  }
}

/**
 * 建設定條目那一步：與名錄上「全部建條目」同一份 `createLoreEntries`。**不拋、不停**：沒建成寫日誌、
 * 掛在「設定清單」那一行上（黃 ❗，第 16 條），後面幾樣照常補；全建成了收掉那條記錄。
 *
 * 動手前按剛建好的角色卡再認一遍名錄：確認框裡列的名字有的是人（卡在這一次才建出來），那些不建——
 * 次數只會比報的少（第 4 條）。
 */
async function deriveLore(
  project: NovelProject,
  plan: NonNullable<DerivePlan['lore']>,
  opts: {
    signal: AbortSignal;
    pool?: ModelPool;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ calls: number; created: number }> {
  const key = settingKey(project, 'lore');
  const warn = (message: string, detail: string): void => {
    log.warn(message, detail);
    void recordFailure(project, {
      scope: '補齊',
      targetKind: 'setting',
      targetKey: key,
      severity: 'warn',
      op: 'deriveLore',
      message,
      detail,
    });
  };
  project.invalidate();
  const still = new Set((await buildLoreIndex(project)).unknown.map((u) => normalizeLoreName(u.name)));
  const targets = plan.targets.filter((u) => still.has(normalizeLoreName(u.name)));
  if (targets.length === 0) {
    return { calls: 0, created: 0 };
  }
  if (!opts.pool) {
    warn('設定條目沒建：沒有可用的模型', '從已寫正文補齊的其餘幾樣照常補齊。配好模型後可以在設定組「出現過 · 未建條目」裡建。');
    return { calls: 0, created: 0 };
  }
  try {
    const r = await createLoreEntries(project, targets, {
      signal: opts.signal,
      pool: opts.pool,
      lanes: opts.lanes,
      report: (p) => opts.report({ message: `設定條目 · ${p.message}` }),
    });
    if (r.failed > 0 && !opts.signal.aborted) {
      warn(
        r.created > 0 ? `設定條目建了 ${r.created} 條，${r.failed} 條沒建成` : `設定條目一條都沒建成（${r.failed} 條失敗）`,
        '原因見日誌頁。其餘幾樣照常補齊；沒建成的仍在設定組「出現過 · 未建條目」裡，可以再建。'
      );
    } else if (r.failed === 0) {
      await clearFailures(project, 'setting', key, 'deriveLore');
    }
    return { calls: r.calls, created: r.created };
  } catch (err) {
    if (!(err instanceof CancelledError || opts.signal.aborted)) {
      warn(`設定條目沒建成（${describeError(err)}）`, '從已寫正文補齊的其餘幾樣照常補齊。');
    }
    return { calls: 0, created: 0 };
  }
}
