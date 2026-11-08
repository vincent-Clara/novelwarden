/**
 * 記設定：
 *
 * - 定稿第一步順手記進細綱「設定」一節：`loreHint` 給本書的分類表與這一章提到的已有設定，`checkLore` 寫盤前校驗
 *   （名字逐字在正文裡、人名不算、已有條目換成標題與目錄、說明找不到依據就清空）。
 * - 作者點的單獨記一章 / 補記 `recordLore`：只對定稿過、正文沒再改過的章，序列，只換「設定」一節，走 `loreScan` 檔；
 *   按「## 設定」一條一行寫、轉寫成 `{"设定":[…]}`，每章 2 次；轉寫沒成「設定」一節不動、掛黃 ❗。
 */
import { readConfig } from '../config';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { getHost } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { Chapter } from '../model/types';
import {
  LoreLine,
  createLoreLookup,
  loreLinesFromJson,
  loreMentionIn,
  normalizeLoreName,
  verifyLoreLines,
} from '../model/loreFile';
import { Workspace } from '../workspace';
import { buildLoreIndex } from '../views/lore';
import { LORE_RECORD_SYSTEM, loreRecordJsonContract } from './lorePrompt';
import { extractJsonObject, stripCodeFence, stripTrailingCommas } from './parse';
import { describeCalls, transcribedCalls } from '../model/pipeline';
import { poolTranscriber } from './poolIO';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';

const log = scoped('设定');

/**
 * 記設定：這一章正文裡出現了哪些設定，寫進細綱的「設定」一節（設定名錄，2026-10-18）。
 *
 * 預設路徑是**定稿時順手記**（features/summarize.ts，並進定稿第一步，不加呼叫次數）。這裡是作者定的
 * 「另外允許單獨呼叫」：覺得哪一章記得不好、或者老工程裡那些在這個功能之前就定稿過的章（細綱沒有
 * 「設定」一節），可以單獨記——每章寫 1 次、轉寫 1 次，只讀正文、只出「設定」一個欄位，只換掉「設定」一節，另外七節與指紋
 * 一個字不動。
 *
 * 只對**定稿過、而且正文沒再改過**的章開放：沒定稿的章，「設定」一節寫的是計劃，記了也會被定稿沖掉；
 * 定稿之後正文又改過的，先重新定稿（第 4 條：不偷偷補）。
 *
 * 2026-10-25 起單獨記的這一條改成轉寫：模型按「## 設定」一條一行寫，轉寫那一檔照抄成 JSON（`TRANSCRIBED_CALLS`）。
 * 定稿時順手記的那一份跟著定稿那一步走，不在這裡。
 *
 * 補記是**序列**的：「已有設定」提示裡除了條目，還有前面各章「設定」一節記過、還沒建條目的名字——
 * 後一章要看到前一章剛記下的名字，同一個東西才不會在兩章裡叫出兩個名字。
 */

/**
 * 「本書的設定分類」與「已有設定」提示段。定稿與單獨記設定共用。
 *
 * - 分類就是 `lore/` 下的目錄樹，每本書自己的（沒有固定表）。還沒有目錄時讓模型自己起短名字。
 * - 已有設定只列**這一章正文裡提到的**（標題或關鍵詞作為子串出現），加上計劃「設定」一節點名的，再加上
 *   前面各章記過、還沒建條目、這一章正文裡也出現了的名字：幾百條全列會擠掉正文的預算，而且模型要的
 *   只是「同一個東西照抄這個名字」。最多 60 條。
 */
export async function loreHint(project: NovelProject, text: string, plan?: Plot): Promise<string> {
  const [categories, entries] = await Promise.all([project.listLoreCategories(), project.listLore()]);
  const planned = new Set((plan?.lore ?? []).map((l) => normalizeLoreName(l.name)));
  const lookup = createLoreLookup(entries);
  const plannedEntries = new Set(
    (plan?.lore ?? []).map((l) => lookup.find(l.name)?.slug).filter((s): s is string => !!s)
  );
  const hits = entries
    .filter((e) => plannedEntries.has(e.slug) || planned.has(normalizeLoreName(e.title)) || loreMentionIn(text, e))
    .map((e) => {
      const also = e.keywords.filter((k) => k !== e.title);
      return `${e.title}${e.category ? `〔${e.category}〕` : ''}${also.length > 0 ? `（也叫 ${also.join('、')}）` : ''}`;
    });
  const unfiled = (await buildLoreIndex(project, { entries })).unknown
    .filter((u) => u.name.length >= 2 && text.includes(u.name))
    .map((u) => `${u.name}${u.category ? `〔${u.category}〕` : ''}`);
  const list = [...hits, ...unfiled].slice(0, HINT_ENTRIES);
  const lines = [
    categories.length > 0
      ? `本書的設定分類：${categories.join('、')}。`
      : '本書還沒有設定分類：分類寫一個簡短的名字（如「地點」「宗門」「法寶」），拿不準就不寫分類。',
  ];
  if (list.length > 0) {
    lines.push(`已有設定（本章正文裡提到的；同一個東西請照抄這裡的名字）：${list.join('、')}。`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** 已有設定最多列幾條。 */
const HINT_ENTRIES = 60;

/**
 * 模型給的「設定」寫進「設定」一節之前的校驗（model/loreFile.ts 的 `verifyLoreLines`，不調模型），
 * 丟掉與清空說明的都寫日誌（第 2 條）。`people` 是這一章出場人物的名字與別名，角色卡上的另外加上。
 */
export async function checkLore(
  project: NovelProject,
  chapter: Chapter,
  lines: readonly LoreLine[],
  text: string,
  people: readonly string[] = []
): Promise<LoreLine[]> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const result = verifyLoreLines(lines, text, {
    entries,
    people: [...people, ...cards.flatMap((c) => [c.name, ...c.aliases])],
  });
  if (result.dropped.length > 0) {
    log.warn(
      `第 ${chapter.order} 章有 ${result.dropped.length} 條設定沒記`,
      result.dropped.map((d) => `- ${d.name}：${d.why}`).join('\n')
    );
  }
  if (result.cleared.length > 0) {
    log.info(
      `第 ${chapter.order} 章有 ${result.cleared.length} 條設定只記名字`,
      result.cleared.map((d) => `- ${d.name}：${d.why}`).join('\n')
    );
  }
  return result.lines;
}

/** 這一章能不能單獨記設定：定稿過，而且記下的 `sourceHash` 對得上正文。 */
function freshFinalized(chapter: Chapter, plot: Plot | undefined): plot is Plot {
  return !!plot?.sourceHash && plot.sourceHash === chapter.contentHash;
}

/**
 * 單獨記一章的設定：寫 1 次、轉寫 1 次（轉寫不合格重轉 1 次），只換掉這一章細綱的「設定」一節。返回寫進去的行。
 * 寫那一次走 `pool`（失敗換同檔其餘），轉寫走 `transcribe`。解析不出來（沒照格式寫、轉寫沒成）就拋（「設定」一節不動）；
 * 呼叫方記失敗。
 */
export async function recordChapterLore(
  project: NovelProject,
  chapter: Chapter,
  pool: ModelPool,
  transcribe: TranscribeCall,
  signal?: AbortSignal
): Promise<LoreLine[]> {
  const plot = await project.plotOfChapter(chapter);
  if (!freshFinalized(chapter, plot)) {
    throw new Error(`第 ${chapter.order} 章還沒同步，或同步之後正文又改過`);
  }
  const config = readConfig();
  const window = pool.primaryBudget;
  const label = `第 ${chapter.order} 章記設定`;
  const text = await project.readChapterText(chapter);
  const hint = await loreHint(project, text, plot);
  const inputBudget = Math.max(2000, window.contextWindow - window.maxOutputTokens - estimateTokens(hint) - 1500);
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${chapter.order} 章正文超出輸入預算，記設定只讀了前 ${body.length} 字`, `原文 ${text.length} 字`);
  }
  const options: StreamOptions = {
    maxOutputTokens: window.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: config.requestTimeoutMs,
    signal,
  };
  const startedAt = Date.now();
  const raw = await pool.run(label, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: LORE_RECORD_SYSTEM },
          {
            role: 'user',
            content: `${hint}請記下這一章正文裡出現的設定。\n\n【第${chapter.order}章 ${chapter.title}】\n\n${body}`,
          },
        ],
        options
      )
    )
  );
  const r = await transcribeJson(raw, RECORD_SPEC, transcribe);
  if (r.notes.length > 0) {
    log.info(`${label}：轉寫 ${r.calls} 次`, r.notes.join('\n'));
  }
  if (!r.ok) {
    throw new Error(r.failed ? r.message : `模型返回無法解析（${r.message}；${raw.length} 字）`);
  }
  const parsed = r.value;
  const people = plot.cast.flatMap((c) => [c.name, ...c.aliases]);
  const lines = await checkLore(project, chapter, parsed, text, people);
  await new Workspace(project).patchPlotLore(plot.relPath, lines);
  await clearFailures(project, 'chapter', chapter.relPath, 'loreRecord');
  log.info(
    `第 ${chapter.order} 章《${chapter.title}》記下 ${lines.length} 條設定`,
    `${plot.relPath}｜用時 ${elapsed(startedAt)}｜返回 ${raw.length} 字` +
      (lines.length > 0 ? `｜${lines.map((l) => l.name).join('、')}` : '')
  );
  return lines;
}

/**
 * 記設定轉寫那一步（2026-10-25 起改成轉寫）：合同是 lorePrompt.ts 的 `loreRecordJsonContract`，解碼就是下面的
 * {@link parseLoreRecord}。原文連「設定」小標題、一條「- 」都沒有的不轉。名字、分類、說明都照抄原文，沒有按對應關係填的。
 */
const RECORD_SPEC: TranscribeSpec<LoreLine[]> = {
  label: '記設定',
  contract: loreRecordJsonContract(),
  decode: (json) => {
    const lines = parseLoreRecord(json);
    return lines ? { ok: true, value: lines } : { ok: false, message: '要一個 {"设定":[…]} 物件' };
  },
  looksLike: (source) => /(?:设|設)定|^\s*-\s/m.test(source),
};

/** `{"设定": [...]}` → 一行一條。不是 JSON、或沒有這個欄位，返回 undefined。 */
export function parseLoreRecord(raw: string): LoreLine[] | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    try {
      data = JSON.parse(stripTrailingCommas(json));
    } catch {
      return undefined;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const field = obj.设定 ?? obj.settings ?? obj.lore;
  return field === undefined ? undefined : loreLinesFromJson(field);
}

/**
 * 工程頁入口。給了 `relPath`（章節或細綱的路徑）就記那一章；沒給就**補記**全部還沒記過設定
 * （細綱沒有「設定」一節）的定稿章。動手之前報呼叫次數（第 4 條），序列，可取消。
 */
export async function recordLore(project: NovelProject, relPath?: string): Promise<void> {
  const chapters = await project.listChapters();
  const host = getHost();
  let targets: Chapter[] = [];
  let skipped = 0;
  if (relPath) {
    const chapter =
      chapters.find((c) => c.relPath === relPath) ??
      (await (async () => {
        const plot = await project.resolvePlot(relPath);
        return plot ? chapters.find((c) => c.order === plot.no) : undefined;
      })());
    if (!chapter) {
      host.toast('這一章還沒有正文，沒有設定可記。');
      return;
    }
    if (!freshFinalized(chapter, await project.plotOfChapter(chapter))) {
      host.toast(`第 ${chapter.order} 章還沒同步，或同步之後正文又改過：先同步，同步時會一併記下設定。`);
      return;
    }
    targets = [chapter];
  } else {
    for (const chapter of chapters) {
      const plot = await project.plotOfChapter(chapter);
      if (!plot?.sourceHash || plot.lore) {
        continue;
      }
      if (freshFinalized(chapter, plot)) {
        targets.push(chapter);
      } else {
        skipped++;
      }
    }
    if (targets.length === 0) {
      host.toast(
        skipped > 0
          ? `沒有可以補記的章：還有 ${skipped} 章同步之後正文又改過，先重新同步（同步時會一併記下設定）。`
          : '同步過的章都已經記過設定了。'
      );
      return;
    }
  }

  const n = targets.length;
  const what = relPath ? `第 ${targets[0].order} 章` : `${n} 章`;
  const answer = await askCall({
    message: `記設定：讀${what}正文，${describeCalls(transcribedCalls(n, '每章'))}。只換掉${relPath ? '這一章' : '這幾章'}細綱的「設定」一節，別的不動。`,
    actions: ['開始記'],
    detail: [
      relPath
        ? '這一章細綱原來的「設定」一節（同步時記的）會被這一次的結果替換。'
        : `補記的是同步過、但還沒記過設定的章（這個功能之前同步的章都是）。${skipped > 0 ? `另有 ${skipped} 章同步之後正文又改過，這次不記，先重新同步。` : ''}`,
      n > 1 ? '一章一章序列記，可以隨時停下，已經記好的留著。' : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tasks: ['loreScan', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '開始記') {
    log.info('作者取消了記設定');
    return;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'loreScan', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，記設定中止');
      return;
    }
    log.info('開始記設定', `${n} 章｜${pool.label}`);

    await runTask(
      '記設定',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        let done = 0;
        let failed = 0;
        let lines = 0;
        const transcribe = poolTranscriber(signal, pool);
        for (const chapter of targets) {
          if (signal.aborted) {
            break;
          }
          report({ message: `記第 ${chapter.order} 章《${chapter.title}》的設定`, current: done, total: n });
          try {
            const recorded = await recordChapterLore(project, chapter, pool, transcribe, signal);
            lines += recorded.length;
          } catch (err) {
            if (signal.aborted) {
              break;
            }
            failed++;
            log.error(`第 ${chapter.order} 章記設定失敗`, describeError(err));
            await recordFailure(project, {
              scope: '设定',
              targetKind: 'chapter',
              targetKey: chapter.relPath,
              severity: 'warn',
              op: 'loreRecord',
              message: `記設定失敗：${describeError(err)}`,
              detail: '細綱的「設定」一節沒有改動；可以在這一章上右鍵「記設定」再試一次。',
            });
          } finally {
            done++;
            report({ current: done, total: n });
          }
        }
        const summary = `記了 ${done - failed} 章，共 ${lines} 條設定${failed > 0 ? `，失敗 ${failed} 章（詳見日誌頁）` : ''}`;
        log.info('記設定結束', `${summary}｜總耗時 ${elapsed(startedAt)}`);
        host.toast(`${summary}。`);
      },
      { scope: '设定' }
    );
  });
}
