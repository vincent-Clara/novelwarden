import { traditionalLabel } from '../model/labels';
/**
 * **單個角色**的檔案更新編排。每批模型按十個小標題寫檔案、轉寫那一檔照抄成 JSON（每批 2 次，最多 3 次，
 * `transcribedCalls`）；轉寫沒成跳過這一批。建卡 `createCastCards` 交回實際調了幾次。
 *
 * 解析在 characterCardParse.ts，控篇幅的提示詞在 characterCardPrompt.ts（字數上限是第 15 條的錨點）。
 */
import { appearancesOf, buildCastIndex, cardLookup, CastMember, describePlots } from '../views/cast';
import { readConfig } from '../config';
import { runPool, serialize } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { budgetForTask, createModelPool, ModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { readText, slugify, uniqueSlug } from '../model/fs';
import {
  NovelProject,
  emptyCharacterSections,
  renderCharacterCard,
} from '../model/project';
import { CHARACTER_SECTION_KEYS, Chapter, CharacterCard, CharacterSections, SummaryCast } from '../model/types';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { explainDroppedAliases, normalizeName, sanitizeAliases } from '../model/naming';
import { keepGender } from '../model/gender';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { stampState } from '../model/characterState';
import { cardTranscribeSpec, ParsedCard } from './characterCardParse';
import { UPDATE_SYSTEM } from './characterCardPrompt';
import { unique, uniqueNumbers } from './parse';
import { CallEstimate, describeCalls, transcribedCalls } from '../model/pipeline';
import { poolTranscriber } from './poolIO';
import { TranscribeCall, transcribeJson } from './transcribe';

export { parseCardResponse } from './characterCardParse';

const log = scoped('角色卡');

/**
 * 單個角色的檔案更新——右鍵角色行上的「更新角色卡」。
 *
 * 與 `extractCharacters`（一次從幾章裡扒出一批人）互補：那條流程面向
 * 「剛寫完幾章，把新出現的人補上」，這條面向「這個人寫了三十章了，
 * 把他的檔案重新過一遍」。
 *
 * 三件事是這條流程存在的理由：
 *
 * 1. **自動關聯出場章節**。作者不必再手輸章節號——出場章節由定稿過的細綱聚合出來（出場索引）。
 * 2. **控制上下文**。主角可能出現在幾十章裡，一次塞不進視窗，按輸入預算
 *    切成多批、逐批精煉同一張卡（後一批看得到前一批的產出）。
 * 3. **先說要調幾次模型**。分批意味著 N 次請求，動手前必須把 N 告訴作者
 *    ——「不偷偷燒 token」。
 */

/** 更新範圍。 */
export type UpdateScope =
  /** 只讀上次更新之後的新出場章節。首次更新時等同於全量。 */
  | 'incremental'
  /** 從頭通讀該角色的全部出場章節。 */
  | 'full';

export interface Batch {
  /** 這一批讀了哪幾章。 */
  plots: Chapter[];
  /** 這一批的語料（已按預算截斷）。 */
  corpus: string;
  /** 這幾章定稿過的細綱裡出場、但不是這個人的人物（見 {@link isSelfOf}）。 */
  others: string[];
}

/**
 * 更新一張已有角色卡。
 *
 * @param relPath 角色卡的工作區相對路徑。
 * @param scope 增量還是全量；不給則問使用者。
 */
export async function updateCharacterCard(
  project: NovelProject,
  relPath: string,
  scope?: UpdateScope
): Promise<void> {
  const cards = await project.listCharacters();
  const card = cards.find((c) => c.relPath === relPath);
  if (!card) {
    log.warn(`找不到角色卡 ${relPath}，可能剛被改名或刪除`);
    getHost().toast('找不到這張角色卡，可能剛被改名或刪除。', 'error');
    return;
  }

  const index = await buildCastIndex(project);
  const all = appearancesOf(index, card);
  if (all.length === 0) {
    log.warn(
      `「${card.name}」未在任何同步過的章裡出現`,
      index.summaryCount === 0
        ? '這個工程還沒有任何一章同步過：先同步（工程頁黃條上的「立即同步」，或章節右鍵「同步」）。'
        : '同步過的細綱裡沒有這個名字。可能是角色卡的 name/aliases 與正文裡的寫法對不上。'
    );
    getHost().toast(
      index.summaryCount === 0
        ? '還沒有同步過的章：先同步（工程頁黃條上的「立即同步」，或章節右鍵「同步」）。'
        : `同步過的細綱裡沒有出現「${card.name}」，無法自動關聯章節。`,
      'error'
    );
    return;
  }

  const updatedThrough = card.updatedThrough ?? 0;
  const fresh = all.filter((o) => o > updatedThrough);

  // 增量沒有新章節時不必白跑一趟模型。
  if (scope === 'incremental' && fresh.length === 0) {
    log.info(`「${card.name}」自第 ${updatedThrough} 章以來沒有新的出場章節`);
    getHost().toast(`「${card.name}」沒有新的出場章節，無需更新。`);
    return;
  }

  const picked = scope ?? (await askScope(card, all, fresh));
  if (!picked) {
    log.info('使用者取消了更新');
    return;
  }
  const nos = picked === 'incremental' && fresh.length > 0 ? fresh : all;

  const plots = (await project.listChapters()).filter((c) => nos.includes(c.order));
  if (plots.length === 0) {
    log.warn(`「${card.name}」的出場章都已不在磁碟上`, `同步記錄：${describePlots(nos)}`);
    getHost().toast('這些出場章的正文已不存在。', 'error');
    return;
  }

  await runUpdate(project, card, plots, {
    scope: picked,
    // 全量重來時 lastSeen/appearsIn 以完整清單為準；增量只補新的。
    allAppearances: all,
  });
}

/** 批次計劃裡的一張卡。 */
export interface CardUpdatePlan {
  card: CharacterCard;
  /** 本次要讀的出場章號。 */
  nos: number[];
  /** 預先算好的分批（總確認報呼叫次數用，執行時不重算）。 */
  batches: Batch[];
  /** 真正參與分析的章數（沒有正文的章已剔除）。 */
  plots: number;
}

export interface BatchUpdatePlan {
  plans: CardUpdatePlan[];
  skipped: { card: CharacterCard; reason: string }[];
}

/**
 * 批次計劃：列出全部角色卡，逐卡算出要讀哪些章、分幾批。
 * 增量模式只取 updatedThrough 之後的新出場；無新出場/未在定稿中出現/
 * 出場章節已不在磁碟/正文全空的卡計入 skipped。匯出供總確認與冒煙測試。
 */
export async function planAllUpdates(project: NovelProject, scope: UpdateScope): Promise<BatchUpdatePlan> {
  const cards = await project.listCharacters();
  const index = await buildCastIndex(project);
  // 分批用**角色卡那一檔**的視窗：批數就是確認框裡那句「預計呼叫 N 次」，
  // 拿對話頁模型的視窗來算，跑起來會超窗且數字對不上賬。
  const budget = budgetForTask('characterCard');
  const allPlots = await project.listChapters();
  const lookup = cardLookup(cards);
  const result: BatchUpdatePlan = { plans: [], skipped: [] };

  for (const card of cards) {
    const all = appearancesOf(index, card);
    if (all.length === 0) {
      result.skipped.push({ card, reason: '未在同步過的章裡出現' });
      continue;
    }
    const nos = scope === 'incremental' ? all.filter((n) => n > (card.updatedThrough ?? 0)) : all;
    if (nos.length === 0) {
      result.skipped.push({ card, reason: '沒有新的出場章節' });
      continue;
    }
    const plots = allPlots.filter((c) => nos.includes(c.order));
    if (plots.length === 0) {
      result.skipped.push({ card, reason: '出場章節已不在磁碟上' });
      continue;
    }
    const batches = await planBatches(project, plots, budget, isSelfOf(lookup, card.name, card));
    if (batches.length === 0) {
      result.skipped.push({ card, reason: '章節正文都為空' });
      continue;
    }
    result.plans.push({
      card,
      nos,
      batches,
      plots: batches.reduce((sum, b) => sum + b.plots.length, 0),
    });
  }
  return result;
}

/**
 * 批次更新全部角色卡——工程頁「角色」分組的右鍵動作。
 * incremental：每卡只讀上次更新後的新出場章節；full：每卡全量重讀。
 *
 * 「不偷偷燒 token」：總確認框先報清卡數、章數、批數（= 預計呼叫次數），
 * 並讓使用者選採納方式（逐張 diff 確認 / 全部直接採納）。
 *
 * 各卡之間沒有先後依賴，按配置併發；**卡內的批仍然嚴格序列**（後一批要
 * 看到前一批的產出）。逐張確認時 diff 走 `serialize` 排隊，一次只彈一張。
 */
export async function updateAllCharacterCards(project: NovelProject, scope: UpdateScope): Promise<void> {
  const { plans, skipped } = await planAllUpdates(project, scope);
  if (plans.length === 0) {
    log.info('沒有需要更新的角色卡', skipped.length > 0 ? `跳過 ${skipped.length} 張` : undefined);
    getHost().toast(
      `沒有需要更新的角色卡${skipped.length > 0 ? `（${skipped.length} 張被跳過）` : ''}。`
    );
    return;
  }

  const totalBatches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  const totalPlots = plans.reduce((sum, p) => sum + p.plots, 0);
  const lanes = Math.min(readConfig().concurrency, plans.length);
  const label = scope === 'incremental' ? '更新' : '從頭重建';
  const answer = await askCall({
    message:
      `${label} ${plans.length} 張角色卡：共需通讀 ${totalPlots} 章，` +
      `分 ${totalBatches} 批，${describeCalls(transcribedCalls(totalBatches, '每批'))}。現在開始？`,
    actions: ['逐張確認後開始', '全部直接採納並開始'],
    detail: [
      lanes > 1
        ? `併發 ${lanes} 張同時處理（同一張卡內的批次仍按順序來）。逐張確認時，diff 會按完成順序一張一張彈出。`
        : '逐張序列處理（併發數為 1）。',
      skipped.length > 0
        ? `跳過 ${skipped.length} 張：${skipped.map((s) => `「${s.card.name}」（${s.reason}）`).join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tasks: ['characterCard', 'transcribe'],
    contextDetail: false,
  });
  if (!answer) {
    log.info('使用者取消了批次更新');
    return;
  }
  const autoApply = answer.action === '全部直接採納並開始';

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const pool = await createModelPool({ task: 'characterCard', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，批次更新中止');
      return;
    }

    log.info(
      `開始批次${label}角色卡`,
      `${plans.length} 張｜${totalPlots} 章分 ${totalBatches} 批｜模型 ${pool.label}｜` +
        (lanes > 1 ? `併發 ${lanes} 路｜` : '') +
        (autoApply ? '全部直接採納' : '逐張確認')
    );

    await runTask(
      `批次${label}角色卡`,
      async ({ signal, report }) => {
        // 每張卡的步數（批數 + 寫入那一步），累加成總進度條的分母。
        const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
        let done = 0;
        let finished = 0;
        let updated = 0;
        let failed = 0;
        let discarded = 0;
        const running = new Set<string>();
        const transcribe = poolTranscriber(signal, pool);

        // 併發下按卡內步數細分只會互相打架，所以完成粒度取到「卡」：
        // 一張卡結束時把它的全部步數一次性計入，進行中的另行報。
        const describeState = (): string =>
          lanes > 1
            ? `已完成 ${finished}/${plans.length} 張` +
              (running.size > 0 ? ` · ${running.size} 張進行中（${[...running].join('、')}）` : '')
            : '';

        await runPool(
          plans,
          lanes,
          async (plan, i) => {
            const outcome = await runCardUpdate(
              project,
              plan.card,
              { scope, allAppearances: plan.nos, batches: plan.batches, skipReview: autoApply },
              {
                signal,
                report: (message, current) =>
                  report({
                    message:
                      lanes > 1
                        ? `${describeState()} · 「${plan.card.name}」${message}`
                        : `第 ${i + 1}/${plans.length} 張「${plan.card.name}」· ${message}`,
                    current: done + (lanes > 1 ? 0 : current ?? 0),
                    total: totalSteps,
                  }),
                pool,
                transcribe,
                config,
              }
            );
            return outcome;
          },
          {
            signal,
            onStart: (plan) => {
              running.add(`「${plan.card.name}」`);
            },
            onSettled: (result, plan, _index, count) => {
              running.delete(`「${plan.card.name}」`);
              finished = count;
              done += plan.batches.length + 1;
              if (result.status === 'rejected') {
                failed++;
                const reason = describeError(result.reason);
                log.error(`「${plan.card.name}」更新失敗：${reason}`, result.reason);
                // 拋出來的異常（網路/超時/取消以外的錯）此前只進了「失敗 N 張」
                // 這個彙總數字，看不出是哪一張。掛到卡上才找得回來。
                void recordFailure(project, {
                  scope: '角色卡',
                  targetKind: 'character',
                  targetKey: plan.card.relPath,
                  severity: 'error',
                  op: 'updateCard',
                  message: `更新失敗：${reason}`,
                  detail: `批次${label}時拋出異常，這張卡未改動｜共 ${plan.batches.length} 批`,
                });
              } else if (result.value.status === 'updated') {
                updated++;
              } else if (result.value.status === 'failed') {
                failed++;
              } else if (result.value.status === 'discarded') {
                discarded++;
              }
              report({ message: describeState() || `「${plan.card.name}」完成`, current: done, total: totalSteps });
            },
          }
        );

        report({ message: '完成', current: totalSteps, total: totalSteps });
        const summary =
          `已更新 ${updated} 張` +
          (discarded > 0 ? `，放棄 ${discarded} 張` : '') +
          (failed > 0 ? `，失敗 ${failed} 張` : '') +
          (skipped.length > 0 ? `，跳過 ${skipped.length} 張` : '');
        log.info(`批次${label}角色卡結束`, summary);
        getHost().toast(`角色卡${label}完成：${summary}。`);
        // 與單卡流程不同：批次結束後不自動開啟卡——連開幾十個標籤是災難，
        // 每張卡的路徑已經在日誌裡了。
      },
      { scope: '角色卡' }
    );
  });
}

/**
 * 給定稿裡出現、但還沒建卡的人物建一張卡，並立刻用它的出場章節跑一次提取。
 * 工程頁「出場人物 · 未建卡」那一組的右鍵動作。
 */
export async function createCardForCast(project: NovelProject, name: string): Promise<void> {
  const index = await buildCastIndex(project);
  const member = index.unknown.find((m) => m.name === name);
  if (!member) {
    log.warn(`同步過的細綱裡已經沒有「${name}」了，可能剛重新同步過`);
    getHost().toast(`同步過的細綱裡沒有「${name}」了，請重新整理工程頁。`, 'error');
    return;
  }

  const plots = (await project.listChapters()).filter((c) => member.plots.includes(c.order));
  if (plots.length === 0) {
    getHost().toast('這些出場章節的正文已不存在。', 'error');
    return;
  }

  const card = await seedEmptyCard(project, member);
  if (!card) {
    return;
  }
  await runUpdate(project, card, plots, {
    scope: 'full',
    allAppearances: member.plots,
    // 剛建出來的空卡沒有可覆蓋的人工內容，不必走 diff 審閱。
    skipReview: true,
  });
}

/** 給沒建卡的一位人物建卡要做的事：通讀哪幾章、分幾批（一批寫一次、轉寫一次）。 */
export interface CastCardPlan {
  member: CastMember;
  plots: Chapter[];
  batches: Batch[];
}

/** {@link planCastCards} 的結果。 */
export interface CastCardsPlan {
  plans: CastCardPlan[];
  /** 讀不到正文、建不了的人和原因。 */
  skipped: { name: string; reason: string }[];
  /** 一共幾批。 */
  batches: number;
  /** 預計呼叫次數：每批寫 1 次、轉寫 1 次（2026-10-25 起改成轉寫，`transcribedCalls`）。 */
  calls: CallEstimate;
  /** 一共通讀幾章（同一章給幾個人讀算幾次）。 */
  chapters: number;
}

/**
 * 定稿裡出現過、還沒建卡的人，各要通讀哪幾章、分幾批。`minAppearances` 只收出場至少這麼多章的人
 * （批次寫章開跑前補卡用 2：只露過一面的路人不值得一張卡）。零呼叫。
 */
export async function planCastCards(project: NovelProject, opts: { minAppearances?: number } = {}): Promise<CastCardsPlan> {
  const index = await buildCastIndex(project);
  const min = Math.max(1, opts.minAppearances ?? 1);
  const cardBudget = budgetForTask('characterCard');
  const allPlots = await project.listChapters();
  const lookup = cardLookup(await project.listCharacters());
  const plans: CastCardPlan[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const member of index.unknown.filter((m) => m.plots.length >= min)) {
    const plots = allPlots.filter((c) => member.plots.includes(c.order));
    if (plots.length === 0) {
      skipped.push({ name: member.name, reason: '出場章節已不在磁碟上' });
      continue;
    }
    const batches = await planBatches(project, plots, cardBudget, isSelfOf(lookup, member.name, undefined, member.aliases));
    if (batches.length === 0) {
      skipped.push({ name: member.name, reason: '章節正文都為空' });
      continue;
    }
    plans.push({ member, plots, batches });
  }
  const batches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  return {
    plans,
    skipped,
    batches,
    calls: transcribedCalls(batches, '每批'),
    chapters: plans.reduce((sum, p) => sum + p.batches.reduce((n, b) => n + b.plots.length, 0), 0),
  };
}

/**
 * 按 {@link planCastCards} 排好的建卡：各人之間沒有先後依賴，按 `lanes` 併發。每位先落一張空卡再讓模型來填——
 * 即便呼叫失敗或被取消，作者也拿到了一個可手寫的檔案；失敗掛在那張卡上。不彈框、不開任務，呼叫方負責
 * 確認與進度條（工程頁的「全部建卡」、批次寫章開跑前的補卡）。`calls` 是實際調了幾次（寫的與轉寫的都算）。
 */
export async function createCastCards(
  project: NovelProject,
  plans: readonly CastCardPlan[],
  opts: {
    signal: AbortSignal;
    pool: ModelPool;
    config: ReturnType<typeof readConfig>;
    lanes?: number;
    /** 進度：一句話，與已完成 / 一共多少步（一位 = 批數 + 1）。 */
    report?: (p: { message: string; current: number; total: number }) => void;
  }
): Promise<{ created: number; failed: number; calls: number }> {
  const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
  let done = 0;
  let finished = 0;
  let created = 0;
  let failed = 0;
  let calls = 0;
  const running = new Set<string>();
  const transcribe = poolTranscriber(opts.signal, opts.pool);
  /**
   * 每位人物那張剛落下的空卡的路徑，按 plan 下標記。
   *
   * 拋異常時 `onSettled` 只拿得到 `plan`（那裡只有名字），而失敗記錄要
   * 掛在**檔案**上。空卡是在 worker 裡現建的，只能這樣把路徑帶出來。
   */
  const seeded: (string | undefined)[] = [];
  const describeState = (): string =>
    `已完成 ${finished}/${plans.length} 位` +
    (running.size > 0 ? ` · ${running.size} 位進行中（${[...running].join('、')}）` : '');

  await runPool(
    [...plans],
    Math.max(1, opts.lanes ?? 1),
    async (plan, i) => {
      const card = await seedEmptyCard(project, plan.member);
      if (!card) {
        throw new Error(`建卡失敗：${plan.member.name}`);
      }
      seeded[i] = card.relPath;
      return runCardUpdate(
        project,
        card,
        {
          scope: 'full',
          allAppearances: plan.member.plots,
          batches: plan.batches,
          skipReview: true,
        },
        {
          signal: opts.signal,
          report: (message) =>
            opts.report?.({ message: `${describeState()} · 「${plan.member.name}」${message}`, current: done, total: totalSteps }),
          pool: opts.pool,
          transcribe,
          count: (n) => {
            calls += n;
          },
          config: opts.config,
        }
      );
    },
    {
      signal: opts.signal,
      onStart: (plan) => {
        running.add(`「${plan.member.name}」`);
      },
      onSettled: (result, plan, index, count) => {
        running.delete(`「${plan.member.name}」`);
        finished = count;
        done += plan.batches.length + 1;
        if (result.status === 'rejected') {
          failed++;
          const reason = describeError(result.reason);
          log.error(`「${plan.member.name}」建卡失敗：${reason}`, result.reason);
          // 空卡已經落盤了（那是有意的），但它是空的——不掛個標記的話
          // 作者會看到一張乾淨的新卡，以為模型就只寫出這麼點東西。
          const relPath = seeded[index];
          if (relPath) {
            void recordFailure(project, {
              scope: '角色卡',
              targetKind: 'character',
              targetKey: relPath,
              severity: 'error',
              op: 'updateCard',
              message: `建卡失敗：${reason}`,
              detail: '空卡已留下，可手寫或重新執行「更新角色卡」重試。',
            });
          }
        } else if (result.value.status === 'updated') {
          created++;
        } else if (result.value.status === 'failed') {
          failed++;
        }
        opts.report?.({ message: describeState(), current: done, total: totalSteps });
      },
    }
  );
  return { created, failed, calls };
}

/**
 * 給「出場人物 · 未建卡」裡的**所有**人建卡——該分組的右鍵動作。
 *
 * 各人之間沒有先後依賴，按配置併發。新卡都是空卡，一律 `skipReview`，
 * 沒有 diff 排隊的問題。
 *
 * 「不偷偷燒 token」：確認框裡報清人數、章數與預計呼叫次數——定稿裡
 * 冒出十幾個路人是常事，一次點下去可能是幾十次模型呼叫。
 */
export async function createCardsForAllCast(project: NovelProject): Promise<void> {
  const index = await buildCastIndex(project);
  if (index.unknown.length === 0) {
    log.info('沒有未建卡的出場人物');
    getHost().toast('同步過的章裡出現的人都已經有角色卡了。');
    return;
  }

  const { plans, skipped, batches, calls, chapters } = await planCastCards(project);
  if (plans.length === 0) {
    log.info('沒有可建卡的出場人物', skipped.map((s) => `${s.name}（${s.reason}）`).join('、'));
    getHost().toast('這些人物的出場章節都讀不到內容，無法建卡。');
    return;
  }

  const lanes = Math.min(readConfig().concurrency, plans.length);
  const answer = await askCall({
    message:
      `給 ${plans.length} 位未建卡的人物建卡：共需通讀 ${chapters} 章，` +
      `分 ${batches} 批，${describeCalls(calls)}。現在開始？`,
    actions: ['開始建卡'],
    detail: [
      `人物：${plans.map((p) => p.member.name).join('、')}`,
      lanes > 1 ? `併發 ${lanes} 位同時處理。` : '逐位序列處理（併發數為 1）。',
      skipped.length > 0
        ? `跳過 ${skipped.length} 位：${skipped.map((s) => `「${s.name}」（${s.reason}）`).join('、')}`
        : '',
      '新卡都是空卡，模型產出直接寫入，不走 diff 審閱。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tasks: ['characterCard', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '開始建卡') {
    log.info('使用者取消了批次建卡');
    return;
  }

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const pool = await createModelPool({ task: 'characterCard', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，批次建卡中止');
      return;
    }
    log.info(
      `開始批次建卡`,
      `${plans.length} 位｜${chapters} 章分 ${batches} 批｜模型 ${pool.label}｜` +
        (lanes > 1 ? `併發 ${lanes} 路` : '序列')
    );

    await runTask(
      '批次建角色卡',
      async ({ signal, report }) => {
        const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
        const { created, failed } = await createCastCards(project, plans, { signal, pool, config, lanes, report });
        report({ message: '完成', current: totalSteps, total: totalSteps });
        const summary =
          `已建 ${created} 張` +
          (failed > 0 ? `，失敗 ${failed} 張（空卡已留下，可手寫或重試）` : '') +
          (skipped.length > 0 ? `，跳過 ${skipped.length} 位` : '');
        log.info('批次建卡結束', summary);
        getHost().toast(`建卡完成：${summary}。`);
      },
      { scope: '角色卡' }
    );
  });
}

/**
 * 先落一張空卡再讓模型來填。
 *
 * 順序不能反過來：模型呼叫失敗或被取消時，作者至少拿到了一個可手寫的檔案，
 * 而不是白點一次。slug 衝突時自動加字尾。
 */
async function seedEmptyCard(project: NovelProject, member: CastMember): Promise<CharacterCard | undefined> {
  const slug = await uniqueSlug(project.charactersDir, slugify(member.name));
  const relPath = await new Workspace(project).writeCharacter({
    slug,
    name: member.name,
    aliases: sanitizeAliases(member.aliases, member.name),
    tags: [],
    firstAppear: member.plots[0],
    lastSeen: member.plots[member.plots.length - 1],
    appearsIn: member.plots,
    sections: emptyCharacterSections(),
  });
  log.info(`新建角色卡「${member.name}」`, `${relPath}｜出場 ${describePlots(member.plots)}`);
  return (await project.listCharacters()).find((c) => c.relPath === relPath);
}

// ---------------------------------------------------------------- 核心流程

/** 單卡執行的結果。批次編排據此統計。 */
export interface CardUpdateOutcome {
  status: 'updated' | 'discarded' | 'failed' | 'cancelled';
  /** status 為 updated 時給出推進後的水位線。 */
  updatedThrough?: number;
}

async function runUpdate(
  project: NovelProject,
  card: CharacterCard,
  plots: Chapter[],
  opts: { scope: UpdateScope; allAppearances: number[]; skipReview?: boolean }
): Promise<void> {
  const lookup = cardLookup(await project.listCharacters());
  const batches = await planBatches(project, plots, budgetForTask('characterCard'), isSelfOf(lookup, card.name, card));
  if (batches.length === 0) {
    log.warn(`「${card.name}」的出場章節都是空的`);
    getHost().toast('這些章節都是空的，沒有可分析的內容。', 'error');
    return;
  }

  // 空章節在 planBatches 裡被剔掉了，報數以真正要讀的為準——
  // 說「通讀 12 章」卻只讀了 9 章，作者對不上賬。
  const willRead = batches.reduce((sum, b) => sum + b.plots.length, 0);
  const skipped = plots.length - willRead;
  if (skipped > 0) {
    log.warn(`${skipped} 章正文為空，不參與分析`);
  }

  // 「不偷偷燒 token」：要調幾次模型，動手前說清楚。
  const scopeLabel = opts.scope === 'incremental' ? '增量更新' : '全量重建';
  const answer = await askCall({
    message:
      `${scopeLabel}「${card.name}」的角色卡：需要通讀 ${willRead} 章，` +
      `分 ${batches.length} 批，${describeCalls(transcribedCalls(batches.length, '每批'))}。現在開始？`,
    actions: ['開始'],
    detail:
      [
        batches.length > 1
          ? '章節太多，一次裝不進上下文視窗，因此分批處理：後一批會看到前一批已經歸納出的內容，逐批精煉同一張卡。'
          : '',
        skipped > 0 ? `（另有 ${skipped} 章正文為空，已跳過。）` : '',
      ]
        .filter(Boolean)
        .join('\n\n') || undefined,
    tasks: ['characterCard', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '開始') {
    log.info('使用者取消了更新');
    return;
  }

  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    // 單卡內的批必須序列（後一批看前一批的產出），所以池按序列取模型：
    // 恆用首選，失敗才隨機換。
    const pool = await createModelPool({ task: 'characterCard', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，更新中止');
      return;
    }

    log.info(
      `開始${scopeLabel}「${card.name}」`,
      `${willRead} 章分 ${batches.length} 批｜章節 ${describePlots(
        batches.flatMap((b) => b.plots.map((p) => p.order))
      )}｜模型 ${pool.label}`
    );

    await runTask(
      `更新角色卡「${card.name}」`,
      async ({ signal, report }) => {
        const outcome = await runCardUpdate(
          project,
          card,
          { scope: opts.scope, allAppearances: opts.allAppearances, batches, skipReview: opts.skipReview },
          {
            signal,
            report: (message, current, total) => report({ message, current, total }),
            pool,
            transcribe: poolTranscriber(signal, pool),
            config,
          }
        );
        if (outcome.status === 'updated') {
          getHost().toast(`「${card.name}」已更新，覆蓋至第 ${outcome.updatedThrough} 章。`);
          await getHost().openFile(card.relPath);
        }
      },
      { scope: '角色卡' }
    );
  });
}

/**
 * 單張卡的執行體：分批分析 → 合併 → 審閱/寫回。
 *
 * 不自己開 runTask，進度經 ctx.report 交給外層——單卡與批次共用一條
 * 進度條，不疊兩層。`batches` 由外層算好傳入：批次場景在總確認前已算過
 * 一次，執行時不必重讀章節。
 */
async function runCardUpdate(
  project: NovelProject,
  card: CharacterCard,
  opts: {
    scope: UpdateScope;
    allAppearances: number[];
    batches: Batch[];
    skipReview?: boolean;
  },
  ctx: {
    signal: AbortSignal;
    report: (message: string, current?: number, total?: number) => void;
    pool: ModelPool;
    /** 轉寫那一檔（features/poolIO.ts 的 `poolTranscriber`）。 */
    transcribe: TranscribeCall;
    /** 每調一次模型記一下（寫的與轉寫的都算）：建卡要報實際調了幾次。 */
    count?: (n: number) => void;
    config: { contextWindow: number; maxOutputTokens: number; requestTimeoutMs: number };
  }
): Promise<CardUpdateOutcome> {
  const startedAt = Date.now();
  const { batches } = opts;
  // 批數 + 最後寫入那一步。
  const steps = batches.length + 1;
  let sections: CharacterSections = { ...card.sections };
  let aliases = [...card.aliases];
  let tags = [...card.tags];
  let gender = card.gender;
  /**
   * 真正分析成功 / 失敗的章節。
   *
   * `updatedThrough` 是一條**水位線**（下次增量從它之後開始），所以不能
   * 簡單地推到「最後一批成功的章節」——中間某批失敗時，那幾章會被水位線
   * 越過去，此後永遠不會被重讀，而介面上看不出任何異常。因此水位線只能
   * 推進到**第一個失敗章節之前**，失敗之後的成果照樣寫進卡裡（那是白賺的），
   * 但下次更新會從失敗處重來。
   */
  const analyzed: number[] = [];
  const failed: number[] = [];
  /** 最後一批沒成的原因：全部失敗時寫進卡上的標記。 */
  let lastWhy = '';
  const others = new Set(batches.flatMap((b) => b.others.map(normalizeName)));

  for (let i = 0; i < batches.length; i++) {
    if (ctx.signal.aborted) {
      log.warn(`更新被取消，已完成 ${i}/${batches.length} 批`);
      return { status: 'cancelled' };
    }
    const batch = batches[i];
    const range = describePlots(batch.plots.map((p) => p.order));
    ctx.report(`分析 ${range}`, i, steps);

    const each = Date.now();
    const result = await analyzeBatch(ctx.pool, card, sections, batch, {
      index: i,
      total: batches.length,
      config: ctx.config,
      signal: ctx.signal,
      transcribe: ctx.transcribe,
      count: ctx.count,
    });
    if (!result.ok) {
      // 單批解析失敗不放棄整次更新：已歸納出的內容仍然值得寫回。
      failed.push(...batch.plots.map((p) => p.order));
      lastWhy = result.why;
      log.warn(
        `第 ${i + 1}/${batches.length} 批解析失敗，跳過`,
        `範圍 ${range}｜${result.why}｜這幾章不計入「已讀到」，下次更新會重試`
      );
      continue;
    }
    const parsed = result.card;
    sections = parsed.sections;
    aliases = unique([...aliases, ...parsed.aliases]);
    tags = unique([...tags, ...parsed.tags]);
    gender = keepGender(gender, parsed.gender);
    analyzed.push(...batch.plots.map((p) => p.order));
    log.info(
      `第 ${i + 1}/${batches.length} 批完成（${range}）`,
      `${batch.plots.length} 章，用時 ${elapsed(each)}`
    );
  }

  if (ctx.signal.aborted) {
    log.warn('更新被取消（寫入前）');
    return { status: 'cancelled' };
  }

  // 一批都沒成功：沒有任何新內容，不要拿一份原樣的卡去煩作者確認，
  // 更不能推進 updatedThrough（那等於宣稱讀過了這些章）。
  if (analyzed.length === 0) {
    const detail =
      `範圍 ${describePlots(batches.flatMap((b) => b.plots.map((p) => p.order)))}｜` +
      `模型沒有按格式寫，或者轉寫沒成（${lastWhy}）。可在日誌頁看到每批的失敗記錄；換個模型或稍後重試。`;
    log.error(`「${card.name}」的 ${batches.length} 批全部解析失敗，角色卡未改動`, detail);
    getHost().toast(`模型返回無法解析，「${card.name}」未改動。`, 'error');
    // 日誌與 toast 都是「要求使用者恰好在看」的出口。這一條必須留在卡上：
    // 介面上那張卡此刻與更新成功的一模一樣，作者會以為已經更新過了。
    await recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: card.relPath,
      severity: 'error',
      op: 'updateCard',
      message: `${batches.length} 批全部解析失敗，角色卡未改動`,
      detail,
    });
    return { status: 'failed' };
  }

  ctx.report('寫入角色卡', batches.length, steps);
  // 別名在這裡收一次口：並集是隻進不出的，模型吐出的 `她`/`姐姐`/`少女` 一旦
  // 混進來就再也出不去，而別名是「誰是誰」的判據（cast.ts / model/identity.ts 都吃它），
  // 泛稱會把幾個角色串成一個。順帶把存量髒別名一併清掉——差異走 diff 審閱，看得見。
  const droppedAliases = explainDroppedAliases(aliases, card.name);
  aliases = sanitizeAliases(aliases, card.name);
  // 別人的名字：模型把同場的主角當成了這個人時，頭一個症狀就是把主角的名字記成別名
  // （實戰：配角「葉倫」的卡掛上了「林樾」）。提示詞裡叮囑過，這裡兜底。
  const borrowed = aliases.filter((a) => others.has(normalizeName(a)));
  if (borrowed.length > 0) {
    aliases = aliases.filter((a) => !borrowed.includes(a));
    droppedAliases.push(...borrowed.map((alias) => ({ alias, reason: '是別的角色的名字' })));
  }
  if (droppedAliases.length > 0) {
    log.info(
      `「${card.name}」丟棄 ${droppedAliases.length} 個非專屬稱呼`,
      droppedAliases.map((d) => `${d.alias}（${d.reason}）`).join('、')
    );
  }
  const appearances = uniqueNumbers(
    opts.scope === 'incremental' ? [...card.appearsIn, ...opts.allAppearances] : opts.allAppearances
  );
  // 水位線只推進到第一個失敗章節之前——越過去的話那幾章再也不會被重讀。
  const firstFailure = failed.length > 0 ? Math.min(...failed) : Number.POSITIVE_INFINITY;
  const covered = analyzed.filter((o) => o < firstFailure);
  const updatedThrough = Math.max(card.updatedThrough ?? 0, ...covered, 0);
  if (failed.length > 0) {
    const detail = `失敗章節：${describePlots(uniqueNumbers(failed))}｜下次更新會從這裡重來`;
    log.warn(`${failed.length} 章解析失敗，「已讀到」只推進到第 ${updatedThrough} 章`, detail);
    // 這一條以前只有日誌：卡確實更新了一部分，介面上完全看不出還缺一塊。
    await recordFailure(project, {
      scope: '角色卡',
      targetKind: 'character',
      targetKey: card.relPath,
      severity: 'warn',
      op: 'updateCard',
      message: `${failed.length} 章解析失敗，「已讀到」只推進到第 ${updatedThrough} 章`,
      detail,
    });
  }
  // 「當前狀態」是機器按讀到的最後一章寫的：蓋章（D15），作者採納之後這一節歸機器，
  // 定稿時接著往後更新。
  const merged = stampState(
    {
      slug: card.slug,
      name: card.name,
      aliases,
      tags,
      gender,
      firstAppear: appearances[0] ?? card.firstAppear,
      lastSeen: appearances[appearances.length - 1] ?? card.lastSeen,
      appearsIn: appearances,
      updatedThrough,
      sections,
    },
    updatedThrough
  );

  const proposedText = renderCharacterCard(merged);
  if (opts.skipReview) {
    // 作者已經點過頭（批次的「全部直接採納」/ 剛建的空卡）：經閘道器覆蓋，舊內容先進歷史版本，不再彈覆蓋審閱。
    await writeCardText(project, card, proposedText);
    log.info(`已寫入角色卡「${card.name}」`, `${card.relPath}｜總耗時 ${elapsed(startedAt)}`);
  } else {
    const applied = await review(project, card, proposedText);
    if (!applied) {
      ctx.report('已放弃', steps, steps);
      return { status: 'discarded' };
    }
    log.info(
      `已更新角色卡「${card.name}」`,
      `${card.relPath}｜覆蓋至第 ${merged.updatedThrough} 章｜總耗時 ${elapsed(startedAt)}`
    );
  }
  ctx.report('完成', steps, steps);
  // 全批都成功才算這張卡「好了」，把它掛著的舊感嘆號收掉。
  // 有失敗批次時不能清——上面剛記了一條 warn，清掉等於自己把它抹了。
  if (failed.length === 0) {
    await clearFailures(project, 'character', card.relPath, 'updateCard');
  }
  return { status: 'updated', updatedThrough: merged.updatedThrough };
}

/**
 * 定稿過的細綱 cast 裡的一條是不是這個人。認人走 {@link cardLookup}（正式名壓過別名）：這張卡上
 * 已經混進來的別人的名字照樣算別人。未建卡的人物（`card` 不給）認自己的主名與聚類別稱，
 * 落到任何一張現有卡上的都不是他。
 */
function isSelfOf(
  lookup: ReturnType<typeof cardLookup>,
  name: string,
  card?: CharacterCard,
  aliases: readonly string[] = []
): (entry: SummaryCast) => boolean {
  const own = new Set([name, ...aliases].map(normalizeName));
  return (entry) => {
    const owner = lookup(entry);
    if (card) {
      return owner?.slug === card.slug || normalizeName(entry.name) === normalizeName(card.name);
    }
    return !owner && own.has(normalizeName(entry.name));
  };
}

/**
 * 把出場章節按輸入預算切成若干批。
 *
 * 每批順帶記下同場的其他人物（`others`）：配角那幾章往往通篇是主角視角，只告訴模型
 * 「歸納葉倫」，它會把戲份最重的那位當成葉倫，把主角的身份連同名字一起寫進這張卡。
 * 點名告訴它誰不是他，別名也拿這份名單攔。在計劃階段讀好，執行時不再碰盤。
 *
 * 一章都放不下時仍然單獨成批（正文會被 takeHead 截斷並打 warn）——
 * 寧可讀半章，也不能把這一章整個跳過而不吭聲。
 */
async function planBatches(
  project: NovelProject,
  plots: Chapter[],
  /** 幹活那個模型的視窗（`budgetForTask('characterCard')` / `pool.primaryBudget`）。 */
  window: { contextWindow: number; maxOutputTokens: number },
  isSelf: (entry: SummaryCast) => boolean
): Promise<Batch[]> {
  // 留出角色卡本體、提示詞與輸出的餘量。
  const budget = Math.max(2000, window.contextWindow - window.maxOutputTokens - 3000);
  const batches: Batch[] = [];
  let current: { plots: Chapter[]; parts: string[]; others: string[]; tokens: number } = {
    plots: [],
    parts: [],
    others: [],
    tokens: 0,
  };

  const flush = () => {
    if (current.plots.length > 0) {
      batches.push({ plots: current.plots, corpus: current.parts.join('\n\n'), others: current.others });
    }
    current = { plots: [], parts: [], others: [], tokens: 0 };
  };

  for (const plot of plots) {
    const text = await project.readChapterText(plot);
    if (!text.trim()) {
      continue;
    }
    // 與出場統計同一口徑（views/cast 的 finalizedPlots）：定稿過就認，定稿後正文又改過也照樣算。
    const summary = await project.plotOfChapter(plot);
    const others = (summary?.sourceHash ? summary.cast : [])
      .filter((entry) => entry.name.trim() && !isSelf(entry))
      .map((entry) => entry.name);
    const block = `【第${plot.order}章 ${plot.title}】\n${text}`;
    const tokens = estimateTokens(block);

    if (tokens > budget) {
      // 單章就超預算：自己單獨一批，截斷並說明。
      flush();
      const clipped = takeHead(block, budget);
      log.warn(
        `第 ${plot.order} 章正文超出單批預算，已截斷`,
        `${block.length} 字 → ${clipped.length} 字（預算 ${budget} token）`
      );
      batches.push({ plots: [plot], corpus: clipped, others: unique(others) });
      continue;
    }
    if (current.tokens + tokens > budget) {
      flush();
    }
    current.plots.push(plot);
    current.parts.push(block);
    current.others = unique([...current.others, ...others]);
    current.tokens += tokens;
  }
  flush();
  return batches;
}

/**
 * 分析一批章節，產出精煉後的角色卡內容。
 *
 * 關鍵點：把**當前已歸納出的卡**一併發過去，要求模型「在此基礎上修訂」而不是
 * 從零重寫。這既讓多批之間接得上，也是控制篇幅的抓手——提示詞裡反覆強調
 * 保持精煉、不要堆砌。
 *
 * 2026-10-25 起改成轉寫：模型按十個小標題寫檔案，轉寫那一檔照抄成 JSON（原文字身就是 JSON 的不轉）。
 * 轉寫沒成（重轉一次仍不合格、轉寫呼叫失敗）同從前解析失敗：這一批跳過，`why` 說清是哪一樣。
 */
async function analyzeBatch(
  pool: ModelPool,
  card: CharacterCard,
  current: CharacterSections,
  batch: Batch,
  ctx: {
    index: number;
    total: number;
    config: { requestTimeoutMs: number };
    signal: AbortSignal;
    transcribe: TranscribeCall;
    count?: (n: number) => void;
  }
): Promise<{ ok: true; card: ParsedCard } | { ok: false; why: string }> {
  const options: StreamOptions = {
    // 輸出上限跟著實際幹活的模型走（pool 就在手邊），不是對話頁那個。
    maxOutputTokens: pool.primaryBudget.maxOutputTokens,
    temperature: 0.3,
    timeoutMs: ctx.config.requestTimeoutMs,
    signal: ctx.signal,
  };

  const currentCard = [
    `性別：${card.gender || '（空）'}`,
    ...CHARACTER_SECTION_KEYS.map((k) => `${traditionalLabel(k)}：${current[k]?.trim() || '（空）'}`),
  ].join('\n');
  const range = describePlots(batch.plots.map((p) => p.order));
  const progress =
    ctx.total > 1 ? `這是第 ${ctx.index + 1}/${ctx.total} 批（${range}）。\n` : `本次分析 ${range}。\n`;
  const label = `角色卡「${card.name}」${range}`;

  ctx.count?.(1);
  const raw = await pool.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: UPDATE_SYSTEM },
          {
            role: 'user',
            content:
              `${progress}要歸納的角色：${card.name}` +
              `${card.aliases.length > 0 ? `（又稱 ${card.aliases.join('、')}）` : ''}\n` +
              (batch.others.length > 0
                ? `這幾章裡出場的其他人物：${batch.others.join('、')}。他們都不是${card.name}，` +
                  `不要把他們的身份、經歷、對白寫進這張卡，也不要把他們的名字寫進別名。` +
                  `正文多半以別人的視角展開，只歸納寫到${card.name}本人的部分。\n`
                : '') +
              '\n' +
              `【當前的角色檔案】\n${currentCard}\n\n` +
              `【正文】\n${batch.corpus}\n\n` +
              '請在當前檔案的基礎上修訂，按格式寫出完整的檔案。',
          },
        ],
        options
      )
    )
  );

  const r = await transcribeJson(raw, cardTranscribeSpec(label), ctx.transcribe);
  ctx.count?.(r.calls);
  if (r.notes.length > 0) {
    log.info(`${label}：轉寫 ${r.calls} 次`, r.notes.join('\n'));
  }
  if (!r.ok) {
    return { ok: false, why: r.failed ? r.message : `${r.message}（返回 ${raw.length} 字）` };
  }
  return { ok: true, card: r.value };
}

/**
 * 讓作者對比現有卡與新版本，確認後才寫入。返回是否寫入。
 *
 * 走 `serialize` 排隊：批次更新時幾張卡是併發分析的，但**同時彈三個 diff
 * 編輯器，使用者根本不知道自己在看誰**。分析照跑，審閱在這裡一張一張來，
 * 順序即完成順序。
 */
async function review(project: NovelProject, card: CharacterCard, proposedText: string): Promise<boolean> {
  const abs = project.pathOf(card.relPath);
  const host = getHost();

  const verdict = await serialize(async () => {
    // 現有內容在排到隊之前可能已被別處改過，進隊後再讀一次才是當下的真相。
    const currentText = await readText(abs);
    if (host.reviewReplace) {
      return plainVerdict(await host.reviewReplace(card.name, currentText, proposedText, card.relPath));
    }
    const pick = await host.confirm(`已生成「${card.name}」的新版角色卡。採納？`, ['採納', '跳過'], {
      modal: true,
    });
    return pick === '採納' ? 'apply' : pick === '跳過' ? 'discard' : undefined;
  });

  if (verdict !== 'apply') {
    log.info(`跳過角色卡「${card.name}」`, verdict === 'discard' ? '使用者放棄' : '使用者取消');
    return false;
  }
  await writeCardText(project, card, proposedText);
  return true;
}

/**
 * 把新版寫回**這張卡原來的檔案**：經閘道器（越界 / 大小守衛照過，覆蓋之前舊內容先存一版歷史），`review: false`——
 * 到這裡作者已經點過頭（上面那張審閱，或批次確認框裡的「全部直接採納」），同一件事不問第二次。
 *
 * 走 `write(card.relPath)` 而不是 `writeCharacter`：後者按 slug 拼 `<slug>.md`，作者的卡若是 `林昭.MD`，
 * 在分大小寫的檔案系統上會在旁邊另起一張；它也不過 `guardWrite`。
 */
async function writeCardText(project: NovelProject, card: CharacterCard, text: string): Promise<void> {
  await new Workspace(project).write(card.relPath, { text }, { mode: 'overwrite', review: false });
}

/**
 * 增量/全量二選一。帶上章數，作者才判斷得出該選哪個。
 *
 * **只在兩個選項確有區別時才問**：從沒更新過、或沒有新出場章節時，增量與全量
 * 是同一件事，彈一個只有「開始」的框純屬多此一舉——`runUpdate` 緊接著還會問
 * 一次（那一次帶批數與預計呼叫次數，資訊更全）。連著彈兩個框會讓人以為點錯了。
 */
async function askScope(
  card: CharacterCard,
  all: number[],
  fresh: number[]
): Promise<UpdateScope | undefined> {
  const updatedThrough = card.updatedThrough ?? 0;
  if (updatedThrough === 0 || fresh.length === 0) {
    return 'full';
  }
  const pick = await getHost().confirm(
    `更新「${card.name}」的角色卡。上次更新覆蓋到第 ${updatedThrough} 章。`,
    [`只讀新增的 ${fresh.length} 章`, `重讀全部 ${all.length} 章`],
    {
      modal: true,
      detail:
        `新增出場：${describePlots(fresh)}\n` +
        `全部出場：${describePlots(all)}\n\n` +
        '只讀新增更省 token；全部重讀更完整，適合角色卡被改亂或想徹底重來時。',
    }
  );
  if (!pick) {
    return undefined;
  }
  return pick.startsWith('只讀') ? 'incremental' : 'full';
}
