/**
 * 工程頁的流水線批次動作：**補齊故事架構、一次拆幾十章細綱、一章一章寫正文**。
 *
 * 三個動作都**嚴格序列**、**一件失敗就停**，已經寫好的留著：
 *
 * - 補齊架構：前提要照著配置寫，世界觀要照著前提與角色寫。
 * - 批次拆細綱：後一批要接著前一批往下排（前序細綱一覽）。
 * - 批次寫章（四期，D10）：後一章接著前一章的結尾寫，寫完即定稿時還要讀前一章更新過的
 *   角色狀態與證據原文。
 *
 * 補齊架構與拆細綱走 generation/structured.ts 的生成鏈，寫章走 generation/continuation.ts
 * 的續寫鏈——與對話頁同一份，截斷拆半、轉寫、自動續寫、重演檢測一樣不少。
 *
 * 結構與 `syncSummaries` 對齊（runTask + recordFailure + 分檔確認框），因為作者對這類批次
 * 動作已經有了預期：先說清要調幾次模型、用哪一檔，跑起來能看進度、能取消，失敗的掛在那一行上
 * 第二天還看得見。
 *
 * ## 只補不改
 *
 * 三個批次動作都**跳過已經有產物的章**，不問、不覆蓋。批次路徑上沒有「逐個審閱」的餘地——
 * 一次彈幾十個 diff 沒有人看得完——所以唯一安全的做法是隻處理空白的那些。要重做某一章，去
 * 創作頁單獨重做。
 *
 * ## 返回值是「這一次實際調了幾次模型」
 *
 * 自動修復與自動續寫讓實際次數在跑完之前說不準：確認框裡報的是區間與上限（同一個純函式算的，
 * 見 model/pipeline.ts 的 `planPlotBatches` / `planWriteBatch` / `CallEstimate`），返回的是實際數。
 * 使用者取消、沒有可做的、沒有可用模型時是 0。**只在這裡算**：MCP 的 `pipeline` 工具拿它記賬。
 * 讓呼叫方各算一遍，彈窗寫著 7 次、賬上記 1 次，正是第 4 條要防的事。
 */
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost } from '../host';
import { ChatMessage, CancelledError, LlmProvider, StopSignal } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { NovelProject } from '../model/project';
import { Plot, isPlotFilled, plotContentHash } from '../model/plotFile';
import { isOutlineFilled } from '../model/outlineFile';
import { buildBookFacts, chapterTargetOf } from '../views/pipeline';
import { defaultTotalChapters } from '../model/importText';
import { CallChoice } from '../model/callChoice';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { BuildRequest, buildContext } from '../context/builder';
import { runTask } from '../runtime/progress';
import { countWords } from '../model/fs';
import { describeFinalize, finalizeChapter } from './finalize';
import { CastCardsPlan, createCastCards, planCastCards } from './characterCard';
import { checkPlotAgainstFacts } from './plotCheck';
import { describePlanned, planThreadsFromOutline } from './threads';
import { expandLoreEntries } from './lore';
import { poolIO, poolTranscriber } from './poolIO';
import { checkpointBefore } from './checkpoint';
import { thinLoreFor } from '../views/lore';
import { threadReminders } from '../views/threads';
import { confirmDespiteGap } from './chapterGap';
import { summarizeCallsOf, updateGlobalSummary } from './summarize';
import { PLOT_CHECK_SUGGESTION, describeConflict } from '../model/plotCheck';
import { PREFLIGHT_SUGGESTION, PreflightRisk, describeExempted, describeRisks, describeThreadNotes, preflightChapter, riskKey } from './preflight';
import { isArtifactEmpty, parseArtifact } from './artifact';
import {
  GLOBAL_SUMMARY_EVERY,
  PLOT_BATCH,
  PlotBatchPlan,
  SETTING_DOCS,
  SETTING_DOC_LABEL,
  SettingDoc,
  TRANSCRIBED_SETTINGS,
  WRITE_BATCH_DEFAULT,
  WriteBatchMode,
  WriteBatchPlan,
  addCalls,
  commandOf,
  describeCalls,
  describeThinLore,
  planPlotBatches,
  planWriteBatch,
  settingCalls,
} from '../model/pipeline';
import { Workspace } from '../workspace';
import { acceptArtifact, acceptPlotBatch } from '../generation/accept';
import {
  CallOutcome,
  ChainError,
  ChainIO,
  completeBlueprints,
  completeConfig,
  completeLoreList,
  completeRoster,
} from '../generation/structured';
import { writingAim } from '../model/trimProse';
import { ManuscriptChainResult, WriteProgress, completeManuscript } from '../generation/continuation';
import { loreListKnown, planReview, planWriting } from '../generation/generate';
import { completeReview } from '../generation/review';
import { ReviewReport, describeReport, renderReport } from '../model/review';
import { ChatSession, SessionStore, makeTurnId, nowIso } from '../model/session';

const log = scoped('流水線');

/** 沒有寫總章數、每章字數時，補齊架構按這個規模展開配置（與一句話彈窗的預設值一致）。 */
const DEFAULT_SETUP = { totalChapters: 100, wordsPerChapter: 3000 };

/**
 * 批次拆細綱：`range` 裡還沒有細綱的章，按 {@link PLOT_BATCH} 章一批、**嚴格序列**地拆。
 *
 * - 預設區間是「下一可寫章起 5 章」，不越過大綱的覆蓋與總章數。
 * - 已經排過的章一律跳過（第 19 條批次那一面：不問、不覆蓋），跳過的章把區間斷開。
 * - 每批寫完就落盤，後一批的裝配讀得到它（前序細綱一覽）；一批失敗就停——後一批要
 *   接著它往下排，接不上的細綱比沒有更糟。失敗掛在那一批第一章的細綱上（第 16 條）。
 * - 新角色照樣建卡（D19）。
 *
 * `call`：工程頁彈窗已經把切分與呼叫次數寫給作者看過了（同一個 `planPlotBatches`），這是作者在那裡為這一次挑的
 * 模型與詳細度，不再彈第二個確認框。MCP 的 `pipeline` 工具不帶它，照舊先問（`askCall`）。
 *
 * `expandLore`（完善設定三期，彈窗上「拆完展開本批新設定」，預設否）：拆完把這一次順帶新建的設定空條目批次展開
 * （features/lore.ts 的 `expandLoreEntries`）。新設定有幾條要拆完才知道，所以拆完**再問一次次數**（同批次寫章補建角色卡
 * 那一問，第 4 條）；取消了只是不展開。中途被取消就不問。返回值含展開那幾次。
 */
export async function generatePlots(
  project: NovelProject,
  opts: { range?: { from: number; to: number }; call?: CallChoice; expandLore?: boolean } = {}
): Promise<number> {
  const outline = await project.readOutline();
  if (!isOutlineFilled(outline)) {
    // 沒有大綱就寫細綱，等於讓模型憑空編四十章——那不是作者要的。
    log.warn('情節大綱是空的，批次拆細綱已中止');
    getHost().toast('情節大綱還是空的。先寫一份大綱，細綱才有依據。', 'error');
    return 0;
  }
  const facts = await buildBookFacts(project);
  const cap = Math.min(facts.outlineCoverage, facts.totalChapters ?? Infinity);
  const from = Math.max(1, opts.range?.from ?? facts.nextChapterNo);
  const to = Math.min(opts.range?.to ?? from + PLOT_BATCH - 1, cap);
  if (to < from) {
    getHost().toast(
      Number.isFinite(facts.outlineCoverage) && from > facts.outlineCoverage
        ? `情節大綱只覆蓋到第 ${facts.outlineCoverage} 章。先續寫大綱，再拆第 ${from} 章以後的細綱。`
        : `第 ${from} 章已經超出總章數。`,
      'error'
    );
    return 0;
  }
  // 一條敘事線都還沒有：開拆之前先從情節大綱排一次（設計稿 ⚑8）。有線了就不排——計劃改成拆細綱時逐章寫進線裡。
  const threadsFirst = (await project.readThreads()).threads.length === 0;
  const plan = planPlotBatches({ from, to, filledNos: facts.plotFilledNos, planThreads: threadsFirst });
  const where = plan.from === plan.to ? `第 ${plan.from} 章` : `第 ${plan.from}–${plan.to} 章`;
  if (plan.batches.length === 0) {
    getHost().toast(`${where}都已經排過細綱了。`);
    return 0;
  }

  let choice = opts.call;
  if (!choice) {
    const answer = await askCall({
      message: `${where}：要拆 ${plan.chapters.length} 章細綱，分 ${plan.batches.length} 批，${describeCalls(plan.calls)}。現在拆？`,
      actions: ['開始拆細綱'],
      detail:
        (plan.skipped.length > 0 ? `已經排過的第 ${plan.skipped.join('、')} 章跳過，不會被改動。\n` : '') +
        (threadsFirst ? '還沒有一條敘事線：開拆之前先從情節大綱排一次（排 1 次、轉寫 1 次，算在上面的數裡；沒排成不擋拆細綱）。\n' : '') +
        '每批寫完就落盤，後一批接著前一批往下排；一批失敗就停，已經寫好的留著。\n' +
        '每批寫完由轉寫模型照抄成 JSON（不跟這裡挑的模型，算在上面的數裡）。\n' +
        (opts.expandLore ? '拆完展開本批新設定：新設定有幾條要拆完才知道，到時再問一次次數。\n' : '') +
        '輸出被截斷或格式不對時會自動拆小重試，所以給的是上限。',
      tasks: ['plotOutline', 'transcribe'],
      contextDetail: true,
    });
    if (answer?.action !== '開始拆細綱') {
      log.info('使用者取消了批次拆細綱');
      return 0;
    }
    choice = answer.choice;
  }
  return withCallChoice(choice, () => runPlotBatches(project, plan, where, opts.expandLore === true, threadsFirst));
}

/** 批次拆細綱問過之後：（一條線都沒有時先排敘事線）一批一批拆，按需展開本批新設定。返回呼用次數。 */
async function runPlotBatches(
  project: NovelProject,
  plan: PlotBatchPlan,
  where: string,
  expandLore: boolean,
  threadsFirst: boolean
): Promise<number> {
  const config = readConfig();
  const pool = await createModelPool({ task: 'plotOutline', concurrent: false });
  if (!pool) {
    log.error('沒有可用的模型，批次拆細綱中止');
    return 0;
  }
  const ws = new Workspace(project);
  let calls = 0;
  /** 這一次順帶新建的設定空條目（拆完展開本批新設定用）。 */
  const newLore: string[] = [];
  let cancelled = false;
  await runTask(
    '批次拆細綱',
    async ({ signal, report }) => {
      // 先存一個存檔點（features/checkpoint.ts）：一次拆好幾批、還要排敘事線，整本退得回去。
      await checkpointBefore(project, `批次拆細綱之前（${where}）`);
      const startedAt = Date.now();
      let done = 0;
      let threadsNote = '';
      if (threadsFirst) {
        // 開拆之前先排線：沒排成不擋拆細綱（敘事線是可選的），失敗掛在敘事線目錄上，完成提示裡說一句。
        report({ message: '排敘事線', current: 0, total: plan.chapters.length });
        const th = await planThreadsFromOutline(project, pool, signal);
        calls += th.calls;
        if (th.cancelled) {
          cancelled = true;
          return;
        }
        threadsNote = th.error
          ? `；敘事線沒排成（${th.error}）`
          : `；${describePlanned(th, project.relPath(project.threadsDir)).replace(/。$/, '')}`;
      }
      for (let i = 0; i < plan.batches.length; i++) {
        const batch = plan.batches[i];
        const span = rangeLabel(batch[0], batch[batch.length - 1]);
        report({ message: `${span}（第 ${i + 1}/${plan.batches.length} 批）`, current: done, total: plan.chapters.length });
        const r = await runPlotBatch(project, ws, pool, config, signal, batch);
        calls += r.calls;
        if (r.ok) {
          done += batch.length;
          newLore.push(...r.lore);
        } else {
          if (r.cancelled) {
            cancelled = true;
            log.warn(`批次拆細綱被取消，已完成 ${done}/${plan.chapters.length} 章`);
            return;
          }
          const reason = r.reason;
          getHost().toast(
            `${span}的細綱沒拆成（${reason}）。${done > 0 ? `前面 ${done} 章已經寫好。` : ''}後面的批次已停下。`,
            'error'
          );
          return;
        }
      }
      report({ message: '收尾', current: done, total: plan.chapters.length });
      log.info(`批次拆細綱結束：${done} 章`, `呼叫 ${calls} 次，總耗時 ${elapsed(startedAt)}`);
      getHost().toast(`已為${where}寫好 ${done} 章細綱${plan.skipped.length > 0 ? `（跳過已有的 ${plan.skipped.length} 章）` : ''}${threadsNote}。`);
    },
    { scope: '流水線' }
  );
  // 拆完展開本批新設定（完善設定三期）：幾條要拆完才知道，展開那邊自己再問一次次數（預設跟著這一次）。
  if (expandLore && !cancelled) {
    if (newLore.length > 0) {
      calls += await expandLoreEntries(project, newLore, { lead: `${where}拆出了 ${newLore.length} 條新設定。` });
    } else {
      log.info('拆完展開本批新設定：這一次沒有新設定，不用展開');
    }
  }
  return calls;
}

/**
 * 補齊故事架構：配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單，**只補空白、嚴格序列**（D21）。
 *
 * - 小說配置要麼照已寫正文整理（第 1 章起有正文，裝配器自動帶 `derive`），要麼展開「一句話」那一節——
 *   兩樣都沒有，這一步就是憑空編；規模預設按一句話彈窗的預設值（100 章 × 3000 字，已寫得多就往上取整），
 *   確認框裡寫明。
 * - 角色圖譜只在一張卡都沒有時生成（有卡就算填過，見 `settingFilled`）；設定清單同理（一條條目都沒有，
 *   而且還沒有正文——有正文的書設定從定稿里長）。
 * - 一件失敗就停：後面幾件都吃它的產出。
 *
 * 走分檔池的 `setting` 檔，不帶思考深度（第 26 條：工程頁的批次任務一律不帶）。
 */
export async function completeSettings(project: NovelProject): Promise<number> {
  const facts = await buildBookFacts(project);
  const missing = SETTING_DOCS.filter((doc) => !facts.settings[doc]);
  if (missing.length === 0) {
    getHost().toast('故事架構五件都已經有了。');
    return 0;
  }
  if (!(await confirmDespiteGap(await project.listChapters(), '補齊架構'))) {
    return 0;
  }
  const book = await project.readBookConfig();
  const idea = book.sections.一句话.trim();
  const written = facts.nextChapterNo - 1;
  if (missing.includes('config') && !idea && written < 1) {
    getHost().toast('小說配置還沒寫，也沒有「一句話」可以展開。先點「生成小說配置」寫下你的腦洞。', 'error');
    return 0;
  }
  const setup = {
    totalChapters: book.totalChapters ?? (written > 0 ? defaultTotalChapters(written) : DEFAULT_SETUP.totalChapters),
    wordsPerChapter: book.wordsPerChapter ?? DEFAULT_SETUP.wordsPerChapter,
  };
  const estimate = missing.map(settingCalls).reduce(addCalls);
  const labels = missing.map((doc) => SETTING_DOC_LABEL[doc]);

  const answer = await askCall({
    message: `要補齊${labels.join('、')}，${describeCalls(estimate)}。現在補？`,
    actions: ['開始補齊'],
    detail:
      '按 配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單 的順序一件一件來，每件都吃前面幾件的產出；已經有的不會被改動。一件失敗就停。' +
      (written > 0 ? `\n已經寫了第 1–${written} 章：配置、前提與世界觀照已寫正文整理。` : '') +
      (missing.includes('config') && (!book.totalChapters || !book.wordsPerChapter)
        ? `\n小說配置裡沒寫總章數或每章字數，按 ${setup.totalChapters} 章 × ${setup.wordsPerChapter} 字展開。`
        : '') +
      (missing.some((doc) => TRANSCRIBED_SETTINGS.includes(doc))
        ? '\n配置、角色圖譜、設定清單寫完由轉寫模型照抄成 JSON（不跟這裡挑的模型，算在上面的數裡）。'
        : ''),
    tasks: missing.some((doc) => TRANSCRIBED_SETTINGS.includes(doc)) ? ['setting', 'transcribe'] : ['setting'],
    contextDetail: true,
  });
  if (answer?.action !== '開始補齊') {
    log.info('使用者取消了補齊架構');
    return 0;
  }
  return withCallChoice(answer.choice, () => fillSettings(project, missing, idea, setup));
}

/** 補齊架構問過之後：按順序一件一件補，一件失敗就停。返回呼用次數。 */
async function fillSettings(
  project: NovelProject,
  missing: SettingDoc[],
  idea: string,
  setup: { totalChapters: number; wordsPerChapter: number }
): Promise<number> {
  const config = readConfig();
  const labels = missing.map((doc) => SETTING_DOC_LABEL[doc]);
  const pool = await createModelPool({ task: 'setting', concurrent: false });
  if (!pool) {
    log.error('沒有可用的模型，補齊架構中止');
    return 0;
  }

  let calls = 0;
  await runTask(
    '補齊架構',
    async ({ signal, report }) => {
      // 先存一個存檔點（features/checkpoint.ts）：一次補好幾件，整本退得回去。
      await checkpointBefore(project, '補齊架構之前');
      for (let i = 0; i < missing.length; i++) {
        const doc = missing[i];
        const label = SETTING_DOC_LABEL[doc];
        report({ message: label, current: i, total: missing.length });
        const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
          action: { stage: 'setting', capability: 'generate' },
          target: { kind: 'setting', doc },
          ask: doc === 'config' ? idea : '',
          ...(doc === 'config' ? { setup } : {}),
        };
        const io = poolIO(project, pool, config, signal, request);
        try {
          const raw = await settingRaw(project, doc, request, io, idea, setup);
          const artifact = parseArtifact(request.action, raw, request.target);
          if (isArtifactEmpty(artifact)) {
            throw new Error('模型返回的內容裡解析不出這一件');
          }
          const r = await acceptArtifact(project, request.target, artifact, { onlyBlank: true });
          log.info(`${label}已補上`, r.message);
          void clearFailures(project, 'setting', settingKey(project, doc), 'setting');
          calls += io.calls();
        } catch (err) {
          calls += err instanceof ChainError ? err.calls : io.calls();
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`補齊架構被取消，停在${label}`);
            return;
          }
          const reason = describeError(err);
          log.error(`補齊架構：${label}失敗：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
          // 掛在「故事架構」那一行上（第 16 條）：toast 五秒就沒了。
          void recordFailure(project, {
            scope: '流水線',
            targetKind: 'setting',
            targetKey: settingKey(project, doc),
            severity: 'error',
            op: 'setting',
            message: `${label}生成失敗：${reason}`,
            detail: '補齊架構停在這一件。後面幾件依賴它，沒有繼續。',
          });
          getHost().toast(`${label}沒補上（${reason}）。後面幾件依賴它，已經停下。`, 'error');
          return;
        }
      }
      report({ message: '收尾', current: missing.length, total: missing.length });
      getHost().toast(`已補齊${labels.join('、')}。`);
    },
    { scope: '流水線' }
  );
  return calls;
}

/** 故事架構那一行的失敗記在哪：它的檔案（角色圖譜是角色目錄、設定清單是設定目錄）。與工程頁那一行的 `relPath` 一致。 */
export function settingKey(project: NovelProject, doc: SettingDoc): string {
  return project.relPath(project.settingPath(doc));
}

/** 補齊架構的一件：第一次呼叫，配置、角色圖譜與設定清單再接上各自的鏈。從已寫正文補齊（features/derive.ts）也走它。 */
export async function settingRaw(
  project: NovelProject,
  doc: SettingDoc,
  request: Omit<BuildRequest, 'providerMaxInputTokens'>,
  io: ReturnType<typeof poolIO>,
  idea: string,
  setup: { totalChapters: number; wordsPerChapter: number }
): Promise<string> {
  const messages = await io.chain.build({});
  const first = await io.chain.call(messages, SETTING_DOC_LABEL[doc]);
  const chain = { ...io.chain, messages };
  if (doc === 'config') {
    return (await completeConfig(first, chain, { existing: await project.readBookConfig(), idea, setup })).raw;
  }
  if (doc === 'characters') {
    return (await completeRoster(first, chain)).raw;
  }
  if (doc === 'lore') {
    return (await completeLoreList(first, chain, await loreListKnown(project))).raw;
  }
  void request;
  return first.text.trim();
}

/**
 * 拆一批細綱：生成鏈（截斷拆半、寫完轉寫成 JSON、漏章 fail-closed）→ 只補空白地落盤。批次拆細綱與批次寫章
 * 「邊寫邊拆」共用。**不拋**：失敗掛在這一批第一章的細綱上（第 16 條），由呼叫方決定停不停；取消單列。
 * 成功時 `lore` 是這一批順帶新建的設定空條目（「設定」一節 `isNew`）：批次拆細綱「拆完展開本批新設定」按它接著展開。
 */
export async function runPlotBatch(
  project: NovelProject,
  ws: Workspace,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  batch: readonly number[]
): Promise<{ ok: true; calls: number; lore: string[] } | { ok: false; calls: number; cancelled: boolean; reason: string }> {
  const range = { from: batch[0], to: batch[batch.length - 1] };
  const span = rangeLabel(range.from, range.to);
  const target = { kind: 'plot' as const, plotRelPath: await project.plotPathOfNo(range.from) };
  const io = poolIO(project, pool, config, signal, {
    action: { stage: 'plot', capability: 'generate' },
    target,
    targetNo: range.from,
    range,
    ask: '',
  });
  try {
    const result = await completeBlueprints(undefined, io.chain, [...batch]);
    if (result.notes.length > 0) {
      log.warn(`${span}：${result.notes.length} 處降級`, result.notes.join('\n'));
    }
    const r = await acceptPlotBatch(project, ws, result.items, range, { onlyBlank: true });
    log.info(`${span}的細綱已落盤`, r.message);
    void clearFailures(project, 'plot', target.plotRelPath, 'plotOutline');
    return { ok: true, calls: result.calls, lore: r.createdLore ?? [] };
  } catch (err) {
    const calls = err instanceof ChainError ? err.calls : io.calls();
    if (err instanceof CancelledError || signal.aborted) {
      return { ok: false, calls, cancelled: true, reason: '已取消' };
    }
    const reason = describeError(err);
    log.error(`${span}的細綱失敗：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
    await recordFailure(project, {
      scope: '流水線',
      targetKind: 'plot',
      targetKey: target.plotRelPath,
      severity: 'error',
      op: 'plotOutline',
      message: `細綱生成失敗：${reason}`,
      detail: `${span}這一批沒有寫入。後面的批次依賴它，已經停下。`,
    });
    return { ok: false, calls, cancelled: false, reason };
  }
}

/** 兩種模式在確認框與完成提示裡的說法。 */
const MODE_LABEL: Record<WriteBatchMode, string> = {
  draft: '只寫正文',
  finalize: '寫完即同步',
};

/**
 * 批次寫章（D10）：區間裡還沒有正文的章，**嚴格序列**地一章一章寫。
 *
 * ```
 * for 每一章：
 *   寫（續寫鏈，與對話頁同一個 completeManuscript；一章之內續寫那幾輪釘住同一個模型）
 *   → 新建 chapters/NNN-标题.txt、記 writtenFrom
 *   → 寫完即審稿：審一遍，報告進「批次審稿」那個會話（五期補遺 §4）
 *   → 寫完即定稿：定稿（照正文更新細綱 + 角色狀態，features/finalize.ts）
 *   → 作者點過「寫完這一章就停」：停
 * ```
 *
 * - **為什麼序列**：後一章要接前一章的結尾寫（上一章結尾、重演檢測），寫完即定稿時還要讀前一章
 *   更新過的角色狀態與證據原文。併發寫出來的幾章彼此接不上。所以不看併發設定。
 * - **只補空白**（第 19 條）：已有正文的章跳過；區間裡第一章沒有細綱的就在它前面收住
 *   （`planWriteBatch`，前端彈窗與這裡的確認框同源）。
 * - **失敗即停**：寫不出來（呼叫失敗、思考吃光、空正文）或定稿時細綱沒更新成——停，紅 ❗ 掛在
 *   那一章上，已經寫好的留著。
 * - **寫出來但不能往下接的也停**：重演命中（開頭把上一章最後一場又演了一遍）、後面幾章才登場的人
 *   提前寫了進來（五期補遺 §1.2：下一章要從他「第一次露面」寫起）、最後仍不到目標的八成。這幾種照樣
 *   落盤（新章，沒有東西可吞；錢已經花了，D6），不定稿，黃 ❗ 掛在那一章上寫明原因。對話頁那邊有卡片
 *   讓作者當場判斷；批次沒有人看，接著往下寫等於讓後面幾章踩在一個有問題的結尾上。上游前後兩種直接
 *   作廢整章（GD:1130-1186）。
 * - **停止**（中斷）：正在寫的那一章不落盤。**寫完這一章就停**：這一章照常寫完、落盤、（定稿），然後收。
 * - 模型走 `manuscript` 檔（第 12 條：失敗換同檔其餘），不帶思考深度（第 26 條）；定稿兩步各走
 *   `plotSummary` / `characterCard` 檔。
 * - **寫完即審稿**（五期補遺 §4 ⚑）：順序是寫 → 審 → 定稿——審稿對照的是「截至上一章」的角色狀態與
 *   連續性事實，先定稿的話本章剛寫下的事會被當成前文拿來對照它自己。報告一章一輪放進新會話
 *   「批次審稿 · 第 a–b 章」，每審完一章落盤一次；作者開啟它在報告卡上逐章勾選、修稿（走對話頁那條路）。
 *   **審出問題不停**（要人勾了才修，批次停下也沒人勾），**審稿失敗也不停**（後面幾章不靠這份報告往下寫），
 *   都在完成提示裡說清。走 `review` 檔。寫進去但要停下的那一章（重演、提前登場、沒寫夠）照樣審完再停。
 * - **寫前提醒**（完善設定三期）：確認框裡多一行「區間裡 K 條要用到的設定還只有一句話」（`thinLoreFor`，零呼叫）。
 *   不攔，也不在這裡順帶展開——批次寫章不再多一類呼叫。敘事線的兩類提醒（二期：伏筆逾期、線斷了，`threadReminders`）
 *   同一個做法：區間裡寫到哪一章就過了回收章、斷了幾章，區間裡的計劃又都沒安排的，確認框裡多一行，不攔。
 *
 * `call`：工程頁彈窗已經把切分與呼叫次數寫給作者看過了，這是作者在那裡為這一次挑的模型與詳細度，不再彈第二個
 * 確認框（有角色卡要補建時除外）。MCP 的 `pipeline` 工具不帶它，照舊先問。返回實際調了幾次模型（取消、無事可做、
 * 沒有模型時是 0）。
 */
/** 批次寫章開跑前補建角色卡：定稿過的細綱裡至少出場這麼多章的人。 */
export const CAST_CARD_MIN_APPEARANCES = 2;

export async function writeManuscripts(
  project: NovelProject,
  opts: { range?: { from: number; to: number }; mode?: WriteBatchMode; review?: boolean; call?: CallChoice } = {}
): Promise<number> {
  const [facts, chapters, manifest] = await Promise.all([buildBookFacts(project), project.listChapters(), project.readManifest()]);
  const mode = opts.mode ?? 'draft';
  const reviewing = opts.review === true;
  const from = Math.max(1, opts.range?.from ?? facts.nextChapterNo);
  const to = Math.max(from, opts.range?.to ?? from + WRITE_BATCH_DEFAULT - 1);
  const plan = planWriteBatch({
    from,
    to,
    mode,
    review: reviewing,
    writtenNos: chapters.filter((c) => c.wordCount > 0).map((c) => c.order),
    plotFilledNos: facts.plotFilledNos,
    outlineCoverage: Math.min(facts.outlineCoverage, facts.totalChapters ?? Infinity),
    globalSummaryThrough: manifest.globalSummaryThrough ?? 0,
  });
  const where = rangeLabel(plan.from, plan.to);
  if (plan.chapters.length === 0) {
    getHost().toast(
      plan.stopAt !== undefined
        ? `第 ${plan.stopAt} 章還沒有細綱，情節大綱也沒覆蓋到它。先續寫大綱，再寫正文。`
        : `${where}都已經寫過正文了。`,
      plan.stopAt !== undefined ? 'error' : 'info'
    );
    return 0;
  }
  const writing = rangeLabel(plan.chapters[0], plan.chapters[plan.chapters.length - 1]);

  // 一致性預檢（五期，零呼叫）：開跑之前把要寫的幾章一起查一遍，有就先問一句。作者說「僅本次
  // 忽略」的那幾處記下來，跑的中途不再為它們停；中途新冒出來的（前面剛定稿的一章把某人寫死了）
  // 在那一章前面停下——批次沒有人看著，接著寫就是明知有矛盾還往下寫。
  const ignored = new Set<string>();
  const found: [number, PreflightRisk[]][] = [];
  for (const no of plan.chapters) {
    const { risks, exempted } = await preflightChapter(project, no);
    if (risks.length > 0) {
      found.push([no, risks]);
    }
    if (exempted.length > 0) {
      log.info(`第 ${no} 章：${exempted.map(describeExempted).join('；')}`);
    }
  }
  if (found.length > 0) {
    const lines = found.flatMap(([no, risks]) => describeRisks(no, risks, true));
    log.warn(`批次寫章之前的一致性預檢：${lines.length} 處`, lines.join('\n'));
    const pick = await getHost().confirm(
      `一致性預檢：${writing}裡有 ${lines.length} 處要留意（這一步沒有呼叫模型）。仍要寫？`,
      ['僅本次忽略，照寫'],
      {
        modal: true,
        detail: [
          ...lines,
          PREFLIGHT_SUGGESTION,
          '要永久放行某一處：在對話頁寫那一章時選「記為刻意安排」，或在那一章細綱的 frontmatter 里加一行 preflightOk。',
        ].join('\n'),
      }
    );
    if (pick !== '僅本次忽略，照寫') {
      log.info('一致性預檢有問題，作者沒有開始批次寫章');
      return 0;
    }
    for (const [no, risks] of found) {
      risks.forEach((r) => ignored.add(riskKey(no, r)));
    }
  }

  // 開寫之前補建角色卡：已經在定稿裡出場兩章以上、還沒有卡的人。沒有卡就沒有「當前狀態」可維護，
  // 定稿時不更新、預檢也只能靠定稿事實認人（百章實驗裡 13 張卡有 8 張是寫完才建的）。
  const castCards = await planCastCards(project, { minAppearances: CAST_CARD_MIN_APPEARANCES });
  const totalCalls = castCards.batches > 0 ? addCalls(plan.calls, castCards.calls) : plan.calls;
  // 寫前提醒（完善設定三期，零呼叫、不攔）：要寫的這幾章細綱點名、卻還只有一句話的設定。前端彈窗算的是同一份（「待完善」）。
  const thin = await thinLoreFor(project, plan.chapters);
  const threadNotes = await threadReminders(project, plan.chapters);
  const threadNote = describeThreadNotes('区间里', threadNotes.reminders, threadNotes.through, plan.chapters[0]);
  if (threadNote) {
    log.info(`批次寫章之前的敘事線提醒：${threadNotes.reminders.length} 條（不攔）`, threadNote);
  }
  // 前端彈窗算不出補卡那幾次（要讀定稿過的細綱），所以有卡要補時照樣再問一次（第 4 條），預設是彈窗上的選擇。
  let choice = opts.call;
  if (!choice || castCards.batches > 0) {
    const answer = await askCall({
      message: `${writing}：要寫 ${plan.chapters.length} 章正文（${MODE_LABEL[mode]}${reviewing ? '、寫完即審稿' : ''}），${describeCalls(totalCalls)}。現在寫？`,
      actions: ['開始寫章'],
      detail: [
        castCards.plans.length > 0
          ? `開寫之前先給${castCards.plans.map((p) => p.member.name).join('、')}建角色卡（同步過的章裡已經出場 ${CAST_CARD_MIN_APPEARANCES} 章以上、還沒有卡；${describeCalls(castCards.calls).replace(/（.*）$/, '')}，算在上面的數裡）。`
          : '',
        '一章一章序列寫：後一章接著前一章的結尾寫。沒寫夠時自動續寫（算在上限裡）。',
        plan.plotBatches.length > 0
          ? `${plan.plotBatches.map((b) => rangeLabel(b[0], b[b.length - 1])).join('、')}還沒有細綱：寫到時先按情節大綱拆這一批，拆的時候看得見前面已經同步下來的事實。`
          : '',
        '每章寫之前先比對一次細綱與前面同步下來的連續性事實（前面沒同步過的章就不調）；對不上就停在那一章前面。',
        reviewing ? '每寫完一章先審一遍，報告放進一個新會話「批次審稿」，在對話頁逐章勾選修稿；審出問題不會停。' : '',
        mode === 'finalize'
          ? '每寫完一章就同步（照正文更新細綱 + 出場角色的當前狀態 + 敘事線：認事件、更新當前進度、需要時歸併 + 故事時間），再寫下一章；同步的每一次寫完都由轉寫模型照抄成 JSON（算在上面的數裡）。'
          : '只寫正文，不同步；之後在主按鈕上逐章同步。',
        plan.globalSummaryAt.length > 0
          ? `第 ${plan.globalSummaryAt.join('、')} 章同步之後各更新一次全文大綱（落後 ${GLOBAL_SUMMARY_EVERY} 章就更新，每次 1 次呼叫）。`
          : '',
        plan.skipped.length > 0 ? `已經寫過正文的第 ${plan.skipped.join('、')} 章跳過，不會被改動。` : '',
        plan.stopAt !== undefined ? `第 ${plan.stopAt} 章還沒有細綱、情節大綱也沒覆蓋到它，寫到它前面為止。` : '',
        thin.length > 0 ? describeThinLore('区间里', thin.map((t) => t.name)) : '',
        threadNote,
        '一章寫不出來就停；寫出來但開頭重演了上一章、把後面幾章的人提前寫了進來、沒寫夠八成或結尾停在半句上，也寫進去然後停下，等你看過再繼續。',
      ]
        .filter(Boolean)
        .join('\n'),
      // 轉寫一律列上：寫前衝突檢查、寫完即審稿、邊寫邊拆的細綱都要轉寫成 JSON（2026-10-25 起）。
      tasks: [
        'manuscript',
        ...(reviewing ? ['review' as const] : []),
        'plotSummary',
        ...(plan.plotBatches.length > 0 ? ['plotOutline' as const] : []),
        'transcribe',
        ...(mode === 'finalize' || castCards.plans.length > 0 ? ['characterCard' as const] : []),
        ...(castCards.plans.length > 0 ? ['transcribe' as const] : []),
      ],
      contextDetail: true,
      preset: opts.call,
    });
    if (answer?.action !== '開始寫章') {
      log.info('使用者取消了批次寫章');
      return 0;
    }
    choice = answer.choice;
  }
  return withCallChoice(choice, () => runWriteBatch(project, { plan, mode, reviewing, castCards, ignored }));
}

/** 批次寫章問過之後：建池、補建角色卡，然後一章一章寫（審、定稿）。返回呼用次數。 */
async function runWriteBatch(
  project: NovelProject,
  batch: { plan: WriteBatchPlan; mode: WriteBatchMode; reviewing: boolean; castCards: CastCardsPlan; ignored: Set<string> }
): Promise<number> {
  const { plan, mode, reviewing, castCards, ignored } = batch;
  const config = readConfig();
  const pool = await createModelPool({ task: 'manuscript', concurrent: false });
  if (!pool) {
    log.error('沒有可用的模型，批次寫章中止');
    return 0;
  }
  let summaryPool: ModelPool | undefined;
  let statePool: ModelPool | undefined;
  if (mode === 'finalize') {
    summaryPool = await createModelPool({ task: 'plotSummary', concurrent: false });
    statePool = (await createModelPool({ task: 'characterCard', concurrent: false })) ?? summaryPool;
    if (!summaryPool) {
      log.error('沒有可用的模型來同步，批次寫章中止');
      return 0;
    }
  }
  const cardPool = castCards.plans.length > 0 ? (statePool ?? (await createModelPool({ task: 'characterCard', concurrent: false }))) : undefined;
  // 寫前衝突檢查與定稿同檔：讀兩份短文字、按合同摘出東西。
  const checkPool = summaryPool ?? (await createModelPool({ task: 'plotSummary', concurrent: false }));
  const plotPool = plan.plotBatches.length > 0 ? await createModelPool({ task: 'plotOutline', concurrent: false }) : undefined;
  if (plan.plotBatches.length > 0 && !plotPool) {
    log.error('沒有可用的模型拆細綱，批次寫章中止');
    return 0;
  }
  const ws = new Workspace(project);
  const reviewPool = reviewing ? await createModelPool({ task: 'review', concurrent: false }) : undefined;
  if (reviewing && !reviewPool) {
    log.error('沒有可用的模型審稿，批次寫章中止');
    return 0;
  }
  // 報告放進的那個會話：審完第一章才落盤（一章都沒審成就不在歷史裡佔位）。
  const reviews = reviewing ? reviewSession(project, plan.chapters) : undefined;

  let calls = 0;
  await runTask(
    '批次寫章',
    async ({ signal, report, stopRequested, finish }) => {
      // 寫前衝突檢查的轉寫（2026-10-25 起）：走「轉寫」那一檔，那一檔一個可用的都沒有時用比對的那個池。
      const checkTranscriber = checkPool ? poolTranscriber(signal, checkPool) : undefined;
      // 先存一個存檔點（features/checkpoint.ts）：補卡、邊寫邊拆、寫章、定稿都在後面，整本退得回去。
      // 「邊寫邊拆」拆細綱走的是 runPlotBatch，不另存。
      const writing = rangeLabel(plan.chapters[0], plan.chapters[plan.chapters.length - 1]);
      await checkpointBefore(project, `批次寫章${mode === 'finalize' ? `（${MODE_LABEL.finalize}）` : ''}之前（${writing}）`);
      const startedAt = Date.now();
      const total = plan.chapters.length;
      const written: number[] = [];
      let finalized = 0;
      /** 停在哪、為什麼。沒有就是全部寫完了。 */
      let halt: { no: number; why: string; level: 'info' | 'error' } | undefined;
      let last: Plot | undefined;

      if (cardPool && castCards.plans.length > 0) {
        const names = castCards.plans.map((p) => p.member.name).join('、');
        report({ message: `補建角色卡：${names}`, current: 0, total });
        try {
          const made = await createCastCards(project, castCards.plans, {
            signal,
            pool: cardPool,
            config,
            report: (p) => report({ message: `補建角色卡 · ${p.message}` }),
          });
          calls += made.calls;
          log.info(`開寫之前補建了 ${made.created} 張角色卡`, `${names}${made.failed > 0 ? `｜失敗 ${made.failed} 張（空卡已留下）` : ''}`);
        } catch (err) {
          calls += castCards.calls.high;
          if (err instanceof CancelledError || signal.aborted) {
            log.warn('批次寫章被取消，停在補建角色卡');
            return;
          }
          // 卡沒建成不擋寫章：預檢照樣能靠定稿事實認人。
          log.warn(`補建角色卡失敗：${describeError(err)}，接著寫章`);
        }
        project.invalidate();
      }

      for (let i = 0; i < total && !halt; i++) {
        const no = plan.chapters[i];
        // 這一路要跑好幾分鐘：作者可能在這期間自己寫了這一章、或刪了它的細綱。
        project.invalidate();
        let plot = await project.getPlot(no);
        const existing = await project.getChapter(no);
        if (existing && existing.wordCount > 0) {
          log.info(`第 ${no} 章在批次寫章期間已經有了正文，跳過`);
          continue;
        }
        // 邊寫邊拆：寫到一批沒細綱的章的第一章時先拆這一批——前面的章剛寫完、定稿，細綱看得見。
        const plotBatch = plan.plotBatches.find((b) => b[0] === no);
        if (plotBatch && plotPool && (!plot || !isPlotFilled(plot.sections))) {
          const span = rangeLabel(plotBatch[0], plotBatch[plotBatch.length - 1]);
          report({ message: `${span} · 拆細綱`, current: i, total });
          const r = await runPlotBatch(project, ws, plotPool, config, signal, plotBatch);
          calls += r.calls;
          if (!r.ok) {
            if (r.cancelled) {
              log.warn(`批次寫章被取消，停在拆${span}的細綱`);
              return;
            }
            halt = { no, why: `的細綱沒拆成（${r.reason}）`, level: 'error' };
            break;
          }
          project.invalidate();
          plot = await project.getPlot(no);
        }
        if (!plot || !isPlotFilled(plot.sections)) {
          halt = { no, why: '還沒有細綱', level: 'error' };
          break;
        }
        const fresh = (await preflightChapter(project, no)).risks.filter((r) => !ignored.has(riskKey(no, r)));
        if (fresh.length > 0) {
          const lines = describeRisks(no, fresh);
          log.warn(`第 ${no} 章的一致性預檢沒過，批次停在它前面`, lines.join('\n'));
          await recordFailure(project, {
            scope: '流水線',
            targetKind: 'plot',
            targetKey: plot.relPath,
            severity: 'warn',
            op: 'preflight',
            message: `一致性預檢：${lines.join('；')}`,
            detail: `批次寫章停在這一章前面，沒有寫。${PREFLIGHT_SUGGESTION}`,
          });
          halt = { no, why: `的一致性預檢發現 ${fresh.length} 處問題（${fresh.map((r) => r.name).join('、')}已經死了，細綱仍排著）`, level: 'info' };
          break;
        }
        void clearFailures(project, 'plot', plot.relPath, 'preflight');
        // 寫前衝突檢查：細綱是計劃，定稿事實是歷史。對不上就停在這一章前面（批次沒有人看著）。
        if (checkPool) {
          report({ message: `第 ${no} 章 · 比對細綱與既成事實`, current: i, total });
          try {
            const check = await checkPlotAgainstFacts(project, no, checkPool, signal, checkTranscriber);
            calls += check.calls;
            if (check.conflicts.length > 0) {
              const lines = check.conflicts.map(describeConflict);
              log.warn(`第 ${no} 章的細綱與前面同步下來的事實對不上，批次停在它前面`, lines.join('\n'));
              await recordFailure(project, {
                scope: '流水線',
                targetKind: 'plot',
                targetKey: plot.relPath,
                severity: 'warn',
                op: 'plotCheck',
                message: `寫前衝突檢查：${lines.join('；')}`,
                detail: `批次寫章停在這一章前面，沒有寫。${PLOT_CHECK_SUGGESTION}`,
              });
              halt = { no, why: `的細綱與前面同步下來的事實有 ${check.conflicts.length} 處對不上（${clip(lines[0], 60)}）`, level: 'info' };
              break;
            }
            void clearFailures(project, 'plot', plot.relPath, 'plotCheck');
          } catch (err) {
            calls += (err as { calls?: number }).calls ?? 1;
            if (err instanceof CancelledError || signal.aborted) {
              log.warn(`批次寫章被取消，停在第 ${no} 章的寫前衝突檢查`);
              return;
            }
            // 檢查是額外的一道：它沒做成不該擋寫章。
            log.warn(`第 ${no} 章的寫前衝突檢查沒做成（${describeError(err)}），照寫`);
          }
        }
        const name = `第 ${no} 章${plot.title ? `《${plot.title}》` : ''}`;
        report({ message: `${name} · 寫正文`, current: i, total });
        let chapterCalls = 0;
        try {
          const out = await writeOne(project, plot, pool, config, signal, {
            onCall: () => {
              chapterCalls++;
            },
            onProgress: (p) =>
              report({
                message: `${name} · ${p.round > 0 ? `續寫第 ${p.round} 輪 · ` : ''}已寫 ${p.words}${p.target ? ` / ${p.target}` : ''} 字`,
              }),
          });
          calls += chapterCalls;
          written.push(no);
          last = plot;
          if (out.notes.length > 0) {
            log.info(`${name}：${out.notes.length} 條說明`, out.notes.join('\n'));
          }
          // 寫完即審稿（五期補遺 §4）：寫 → 審 → 定稿。要停下的那一章也照樣審完再停——作者回來要看它。
          if (reviews && reviewPool) {
            report({ message: `${name} · 審稿`, current: i, total });
            project.invalidate();
            const r = await reviewOne(project, plot, reviewPool, config, signal);
            calls += r.calls;
            if (r.cancelled) {
              log.warn(`批次寫章被取消，${name}寫好了、沒審完`);
              return;
            }
            await reviews.add(plot, r);
          }
          const problem = out.replay
            ? `開頭與上一章結尾大段重合（「${clip(out.replay, 40)}」），可能把上一章最後一場又演了一遍`
            : out.early?.length
              ? `${out.early.map((e) => `第 ${e.no} 章才登場的${e.name}`).join('、')}提前寫進了這一章（「${clip(out.early[0].quote, 40)}」）`
              : out.short
                ? `只寫到 ${out.words} / ${out.target} 字，不到目標的八成`
                : out.truncated
                  ? '結尾停在半句上（被截斷，續寫沒能接完）'
                  : undefined;
          if (problem) {
            void recordFailure(project, {
              scope: '流水線',
              targetKind: 'plot',
              targetKey: plot.relPath,
              severity: 'warn',
              op: 'manuscript',
              message: `批次寫章：這一章寫進去了，但${problem}`,
              detail: '批次在這一章停下，沒有同步，也沒有往下寫。看過這一章（接著寫、重寫或手改）再繼續。',
            });
            halt = { no, why: problem, level: 'info' };
            break;
          }
          void clearFailures(project, 'plot', plot.relPath, 'manuscript');
        } catch (err) {
          calls += err instanceof ChainError ? Math.max(err.calls, chapterCalls) : chapterCalls;
          if (err instanceof CancelledError || signal.aborted) {
            log.warn(`批次寫章被取消，停在${name}（這一章沒有寫入）`);
            return;
          }
          const reason = describeError(err);
          log.error(`${name}的正文沒寫成：${reason}`, err instanceof ChainError ? err.notes.join('\n') : err);
          void recordFailure(project, {
            scope: '流水線',
            targetKind: 'plot',
            targetKey: plot.relPath,
            severity: 'error',
            op: 'manuscript',
            message: `正文生成失敗：${reason}`,
            detail: '批次寫章停在這一章。後面的章要接著它寫，已經停下。',
          });
          halt = { no, why: `沒寫成（${reason}）`, level: 'error' };
          break;
        }

        if (mode === 'finalize') {
          report({ message: `${name} · 同步`, current: i, total });
          project.invalidate();
          const chapter = await project.getChapter(no);
          try {
            // 敘事線那一步與更新細綱同檔：讀一章、按合同摘出東西，是同一種活。
            const outcome = chapter
              ? await finalizeChapter(project, chapter, { signal, summary: summaryPool, state: statePool, threads: summaryPool })
              : undefined;
            if (!outcome) {
              halt = { no, why: '寫好了，但沒能同步', level: 'error' };
              break;
            }
            calls += outcome.calls;
            finalized++;
            log.info(`${name}已同步`, describeFinalize(no, outcome));
            if (summaryPool && plan.globalSummaryAt.includes(no)) {
              report({ message: `${name} · 更新全文大綱`, current: i, total });
              try {
                const g = await updateGlobalSummary(project, summaryPool, signal);
                calls += g.calls;
              } catch (err) {
                calls += 1;
                if (err instanceof CancelledError || signal.aborted) {
                  log.warn(`批次寫章被取消，${name}同步了、全文大綱沒更新`);
                  return;
                }
                // 全文大綱是額外的一道：沒更新成不擋寫章，下一次落後得更多時再更新。
                log.warn(`全文大綱沒更新成（${describeError(err)}），接著寫`);
              }
            }
          } catch (err) {
            // 請求發出去了錢就花了：更新細綱那一次算上（讀不出來的帶著寫與轉寫的實數）。
            calls += summarizeCallsOf(err);
            if (err instanceof CancelledError || signal.aborted) {
              log.warn(`批次寫章被取消，${name}寫好了、沒同步`);
              return;
            }
            halt = { no, why: `寫好了，但同步失敗（${describeError(err)}）`, level: 'error' };
            break;
          }
        }

        report({ current: i + 1, total });
        if (stopRequested() && i < total - 1) {
          halt = { no, why: '按你的要求寫完這一章就停', level: 'info' };
          break;
        }
      }

      // 停下之後還沒寫的：停在的那一章之後的（那一章本身在前面那句裡已經說過了）。
      const rest = halt ? plan.chapters.filter((n) => n > halt!.no) : [];
      const done = written.length > 0 ? `${rangeLabel(written[0], written[written.length - 1])}已寫好${mode === 'finalize' ? `，同步 ${finalized} 章` : ''}` : '';
      log.info(`批次寫章結束：寫了 ${written.length} 章`, `呼叫 ${calls} 次，總耗時 ${elapsed(startedAt)}`);
      const reviewed = reviews?.summary();
      const open = reviews?.sessionId
        ? { sessionId: reviews.sessionId, label: '開啟審稿報告' }
        : last
          ? { plotRelPath: last.relPath, label: `開啟第 ${last.no} 章` }
          : undefined;
      if (!halt) {
        finish({ message: `${done}（呼叫 ${calls} 次）。${reviewed ?? ''}`, open });
        return;
      }
      const tail = rest.length > 0 ? `後面的${rangeLabel(rest[0], rest[rest.length - 1])}沒寫。` : '';
      const head =
        halt.why === '按你的要求寫完這一章就停'
          ? `寫完第 ${halt.no} 章停下了`
          : written.includes(halt.no)
            ? `第 ${halt.no} 章寫進去了，但${halt.why}，沒有往下寫`
            : `第 ${halt.no} 章${halt.why}，批次停在這裡`;
      finish({
        message: [done ? `${done}。` : '', `${head}。`, tail, reviewed ?? ''].join(''),
        level: halt.level,
        // 停在一章有問題的正文上：先看那一章（審稿報告在歷史頁的那個會話裡，提示裡說了）。
        open: written.includes(halt.no) && halt.why !== '按你的要求寫完這一章就停' ? { plotRelPath: last!.relPath, label: `開啟第 ${halt.no} 章` } : open,
      });
    },
    { scope: '流水線', pausable: true }
  );
  return calls;
}

/**
 * 寫一章：裝配 → 第一次呼叫 → 續寫鏈 → 落盤、記 `writtenFrom`。
 *
 * 模型：第一次呼叫走池（失敗換同檔其餘，第 12 條）；**之後續寫那幾輪釘住第一次成功的那個**——
 * 一章寫到一半換人，文風會斷在段落中間（三期約束：續寫每一輪都用第一次那個模型）。
 */
async function writeOne(
  project: NovelProject,
  plot: Plot,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  hooks: { onCall(): void; onProgress(p: WriteProgress): void }
): Promise<ManuscriptChainResult & { target?: number }> {
  const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    action: { stage: 'manuscript', capability: 'generate' },
    target: { kind: 'manuscript', plotRelPath: plot.relPath },
    targetNo: plot.no,
    // 批次路徑上沒有作者那一句話。整份細綱與執行卡已經由裝配器帶上了，這一句只說清寫的是哪一章。
    ask: `寫第 ${plot.no} 章${plot.title ? `《${plot.title}》` : ''}的正文。`,
  };
  const writing = await planWriting(project, request);
  // 開著刪修飾時往多寫一點，刪完落在目標附近。
  const aim = writingAim(writing.target, config.trimModifiers);
  const built: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    ...request,
    writeMode: writing.mode,
    targetWords: aim,
    notYet: writing.notYet.map(({ name, no }) => ({ name, no })),
    banned: writing.banned,
  };
  const budgeted = { ...config, ...pool.primaryBudget };
  let pinned: LlmProvider | undefined;
  const stream = async (
    llm: LlmProvider,
    messages: ChatMessage[],
    progress?: { round: number; base: number },
    temperature = config.temperature
  ): Promise<CallOutcome> => {
    let text = '';
    let stop: StopSignal | undefined;
    let reportedAt = 0;
    for await (const ev of llm.stream(messages, {
      maxOutputTokens: pool.primaryBudget.maxOutputTokens,
      temperature,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })) {
      if (ev.type === 'text') {
        text += ev.text;
        if (progress && Date.now() - reportedAt >= 1000) {
          reportedAt = Date.now();
          hooks.onProgress({ round: progress?.round ?? 0, words: (progress?.base ?? 0) + countWords(text), target: writing.target });
        }
      } else if (ev.type === 'stop') {
        stop = ev.reason;
      }
    }
    return { text, stop };
  };
  const io: ChainIO = {
    messages: [],
    build: async (patch) => (await buildContext(project, { ...built, ...patch }, budgeted)).messages,
    call: async (messages, label, opts) => {
      hooks.onCall();
      if (pinned) {
        return stream(pinned, messages, opts?.progress, opts?.temperature);
      }
      return pool.run(label, async (llm) => {
        const out = await stream(llm, messages, opts?.progress, opts?.temperature);
        pinned = llm;
        return out;
      });
    },
  };
  io.messages = await io.build({});
  const first = await io.call(io.messages, `第 ${plot.no} 章`, { progress: { round: 0, base: 0 } });
  const result = await completeManuscript(first, io, {
    mode: writing.mode,
    existing: writing.existing,
    target: writing.target,
    aim,
    prevEnding: writing.prevEnding,
    reasoned: false,
    notYet: writing.notYet,
    banned: writing.banned,
    trim: config.trimModifiers,
    onProgress: hooks.onProgress,
    signal,
  });
  if (!result.raw.trim()) {
    throw new Error('模型返回的正文是空的');
  }
  // 同號章節不在就新建（落在細綱所在的子目錄，細綱檔名對不上時跟著改名），在（空檔案）就填進去；
  // 然後在細綱上記 `writtenFrom`，少了那一步這一章會永遠顯示「正文與細綱對不上」或永遠不顯示。
  const ws = new Workspace(project);
  const dest = await chapterTargetOf(project, plot.relPath);
  if (dest.exists) {
    await ws.write(dest.rel, { text: result.raw }, { mode: 'append' });
  } else {
    await ws.createChapterAt(dest.rel, result.raw, dest.plotRelPath);
  }
  // 細綱可能剛跟著新正文改了名：按這一章現在的那一份記。
  const writtenPlot = (await project.resolvePlot(plot.relPath)) ?? plot;
  await ws.recordWrittenFrom(writtenPlot.relPath, plotContentHash(plot));
  await project.syncManifest();
  return { ...result, target: writing.target };
}

/** 「第 3 章」或「第 3–7 章」。 */
function rangeLabel(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

// ---------------------------------------------------------------- 寫完即審稿（五期補遺 §4）

/** 審一章的結果：報告，或者審不成的原因；取消單列（整個批次就此收）。 */
type ReviewOutcome =
  | { report: ReviewReport; notes: string[]; calls: number; cancelled?: false }
  | { error: string; notes: string[]; calls: number; cancelled?: false }
  | { cancelled: true; calls: number };

/**
 * 審一章：與對話頁同一條審稿鏈（generation/review.ts 的 `completeReview`：截斷重來、轉寫成 JSON、不合格重寫、
 * 引文校驗、目標核對），只是每次呼叫走 `review` 檔的池、不流式；轉寫走「轉寫」那一檔（`poolIO` 的 `transcribe`）。
 * **不拋**（取消除外，也收成一個結果）：審稿失敗不該被當成寫章失敗把批次停下。
 */
async function reviewOne(
  project: NovelProject,
  plot: Plot,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal
): Promise<ReviewOutcome> {
  const request: Omit<BuildRequest, 'providerMaxInputTokens'> = {
    action: { stage: 'manuscript', capability: 'review' },
    target: { kind: 'manuscript', plotRelPath: plot.relPath },
    targetNo: plot.no,
    ask: '',
  };
  const ctx = await planReview(project, request);
  if (!ctx) {
    return { error: '這一章沒有正文，沒法審', notes: [], calls: 0 };
  }
  const io = poolIO(project, pool, config, signal, { ...request, reviewGoals: [...ctx.goals] });
  try {
    const messages = await io.chain.build({});
    const first = await io.chain.call(messages, `審第 ${plot.no} 章`);
    const r = await completeReview(first, { ...io.chain, messages }, ctx);
    log.info(`第 ${plot.no} 章審完：${describeReport(r.report)}`, r.notes.join('\n'));
    return { report: r.report, notes: r.notes, calls: r.calls };
  } catch (err) {
    const calls = err instanceof ChainError ? Math.max(err.calls, io.calls()) : io.calls();
    if (err instanceof CancelledError || signal.aborted) {
      return { cancelled: true, calls };
    }
    log.warn(`第 ${plot.no} 章審稿失敗：${describeError(err)}`, err instanceof ChainError ? err.notes.join('\n') : err);
    return { error: describeError(err), notes: err instanceof ChainError ? err.notes : [], calls };
  }
}

/**
 * 「批次審稿 · 第 a–b 章」那個會話：一章一輪（使用者輪 `/審稿`，助手輪是報告卡；審不成的那一輪記報錯），
 * 每加一輪落盤一次。作者在對話頁開啟它，報告卡上勾選、修稿與對話頁裡審出來的那一份一模一樣。
 */
function reviewSession(project: NovelProject, nos: readonly number[]) {
  const store = new SessionStore(project);
  let session: ChatSession | undefined;
  const lines: string[] = [];
  const command = commandOf('manuscript', 'review')?.label ?? '審稿';
  return {
    get sessionId(): string | undefined {
      return session?.id;
    },
    async add(plot: Plot, r: Exclude<ReviewOutcome, { cancelled: true }>): Promise<void> {
      if (!session) {
        session = store.create({ target: { kind: 'manuscript', plotRelPath: plot.relPath }, stage: 'manuscript', targetNo: plot.no });
        session.title = `批次審稿 · ${rangeLabel(nos[0], nos[nos.length - 1])}`;
      }
      session.target = { kind: 'manuscript', plotRelPath: plot.relPath };
      session.targetNo = plot.no;
      session.turns.push({ id: makeTurnId(), role: 'user', content: '', at: nowIso(), command });
      if ('report' in r) {
        session.turns.push({
          id: makeTurnId(),
          role: 'assistant',
          content: renderReport(r.report),
          at: nowIso(),
          review: { report: r.report, ...(r.notes.length > 0 ? { notes: r.notes } : {}), calls: r.calls },
        });
        const errors = r.report.issues.filter((x) => x.severity === 'error').length;
        const warnings = r.report.issues.length - errors;
        lines.push(`第 ${plot.no} 章${r.report.issues.length > 0 ? ` ${errors} 嚴重 · ${warnings} 建議` : '沒有找到問題'}`);
      } else {
        session.turns.push({ id: makeTurnId(), role: 'assistant', content: '', at: nowIso(), error: `審稿失敗：${r.error}` });
        lines.push(`第 ${plot.no} 章審稿失敗`);
      }
      session.updatedAt = nowIso();
      await store.write(session);
    },
    /** 完成提示裡的那一句：「審稿：第 1 章 1 嚴重 · 2 建議；第 2 章沒有找到問題。報告在……」。 */
    summary(): string | undefined {
      return session && lines.length > 0 ? `審稿：${lines.join('；')}。報告在會話「${session.title}」裡。` : undefined;
    },
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
