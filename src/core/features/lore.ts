/**
 * 設定條目的四件維護（建條目、整合、整理走 `loreSynthesis` 檔，批次展開走 `setting` 檔）：
 *
 * - 建條目 `buildLoreEntries`：名錄裡出現過、還沒有條目的名字（「全部」只建出現 ≥2 章的）；原料是定稿細綱裡
 *   提到它的記錄，**不重讀正文**；建在分類目錄裡，記水位與 `bodyHash`。
 * - 整合 `integrateLore`：水位之後的新事實並進條目，水位停在第一處沒定稿或定稿後正文又改過的章之前；
 *   機器寫的可以直接採納，作者改過的先對比；關鍵詞只增不減（第 27 條）。
 * - 按目錄整理 `organizeLore`：模型出搬家清單，`checkOrganizePlan` 校驗，作者看過才搬、只搬不改，不給外部 agent。
 * - 批次展開 `expandLoreEntries`：只寫 `loreBatchExpandable` 的（空的、佔位的、機器寫的薄條目），作者寫過的跳過；
 *   沒有卡片、寫完直接落盤，落盤前按磁碟再認一遍；子條目只建空條目、不接著展開。
 *
 * 都是按格式寫、轉寫那一檔照抄成 JSON；整理不出來這一條重寫一次再轉（`LORE_ENTRY_CALLS`，批次展開合計上限
 * `LORE_EXPAND_BATCH_CALLS`）。原料、水位與「誰寫的」在 views/loreMaterial.ts（裝配器與名錄要同一份，
 * context/、views/ 不依賴 features/）。系統提示詞在 lorePrompt.ts。
 */
import * as path from 'node:path';
import { readConfig } from '../config';
import { runPool, serialize } from '../runtime/concurrency';
import { clearFailures, recordFailure } from '../runtime/errorLog';
import { takeHead } from '../context/tokenizer';
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { CancelledError, StreamOptions } from '../llm/provider';
import { ModelPool, createModelPool } from '../llm/pool';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { exists, hash, readText, sanitizeFileName, slugify, uniqueSlug } from '../model/fs';
import { parseMarkdown, stripH1 } from '../model/markdown';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import {
  CreationTarget,
  LORE_ENTRY_ROUNDS,
  LORE_EXPAND_BATCH_CALLS,
  describeCalls,
  loreEntryCalls,
  loreExpandCalls,
  transcribedCalls,
} from '../model/pipeline';
import { NovelProject, renderLoreEntry } from '../model/project';
import { Plot } from '../model/plotFile';
import { LoreEntry } from '../model/types';
import { LORE_ENTRY_LIMITS, cleanLoreKeywords, normalizeLoreCategory, normalizeLoreName, splitLoreHidden } from '../model/loreFile';
import { runTask } from '../runtime/progress';
import { Workspace } from '../workspace';
import { finalizedPlots } from '../views/cast';
import { LoreFact, LoreRecord, UnfiledLore, buildLoreIndex } from '../views/lore';
import {
  MATERIAL_TOKENS,
  integrationWatermark,
  loreBatchExpandable,
  loreEntryAt,
  loreOwnedByMachine,
  recordsAbout,
} from '../views/loreMaterial';
import { createPlannedLoreAt } from '../generation/accept';
import { loreExpandKnown } from '../generation/generate';
import { ChainError, ChainResult, completeLoreExpand } from '../generation/structured';
import { parseLoreExpansion } from './loreExpand';
import { LORE_ENTRY_SYSTEM, LORE_ORGANIZE_SYSTEM, loreEntryJsonContract, loreOrganizeJsonContract } from './lorePrompt';
import { extractJsonObject, stringArray, stripCodeFence, stripTrailingCommas, unique } from './parse';
import { poolIO, poolTranscriber } from './poolIO';
import { TranscribeCall, TranscribeSpec, transcribeJson } from './transcribe';
import { checkpointBefore } from './checkpoint';

const log = scoped('设定');

/**
 * 設定條目的四件維護：**建條目**（名錄裡出現過、還沒有條目的名字）、**整合**（條目水位之後的新事實
 * 並進條目）、**批次展開**（「待完善」裡還只有一句話的，照已排的細綱往前想細，完善設定三期）、**按目錄整理**
 * （作者定案：分類就是目錄，讓模型出一份搬家清單）。
 *
 * 建條目與整合的原料全來自**定稿過的細綱**（「設定」一節、連續性事實、提到它的那幾句），**不重讀正文**——每章定稿時已經
 * 照正文記過、校驗過了（features/loreRecord.ts）。從前這裡是「通讀全書 → 每條整合」那一套，每跑一次
 * 都從第 1 章掃起（三百章、五百條約 800 次呼叫），作者定案刪掉：相似的東西不留兩份。批次展開走的是對話頁展開
 * 同一條裝配與生成鏈（單條設定這個目標），只是沒有卡片。
 *
 * 寫回的規矩（第 3 條：不靜默覆蓋）：
 * - 新條目直接建（不覆蓋任何東西）。
 * - 整合時條目正文是機器寫的（`bodyHash` 對得上，或正文是空的）：作者在確認框裡選「逐條確認」還是
 *   「直接採納」，同批次更新角色卡；作者改過的一律先給對比。
 * - 整合只並不刪作者的字（提示詞，第 27 條）；關鍵詞只增不減。
 * - 批次展開只寫還只有一句話、又沒有作者的字的（`loreBatchExpandable`），作者寫過的跳過（第 19 條批次那一面）。
 */

/** 「全部建條目」只建出現至少這麼多章的。 */
export const BUILD_MIN_CHAPTERS = 1;
/** 按目錄整理一次呼叫最多看幾條。 */
const ORGANIZE_BATCH = 80;
/** 新目錄最多幾層。 */
const ORGANIZE_DEPTH = 3;

/** 模型交回來的一條。 */
interface EntryDraft {
  brief: string;
  keywords: string[];
  body: string;
}

// ---------------------------------------------------------------- 水位
// 整合能推到第幾章（`integrationWatermark`）挪到了 views/loreMaterial.ts：展開一條設定落盤時記同一個水位。
// 正文是不是機器寫的（`loreOwnedByMachine`）也挪了過去：名錄算「待完善」時要判批次展開會不會寫它。這裡轉出一份，呼叫方不用改。
export { loreOwnedByMachine };

// ---------------------------------------------------------------- 原料
// 一個名字在定稿細綱裡的全部記錄（`recordsAbout`）也在 views/loreMaterial.ts：裝配器展開一條設定時要同一份，
// 而 context/ 不依賴 features/。

function renderRecords(records: readonly LoreFact[]): string {
  return takeHead(records.map((f) => `- 第 ${f.no} 章：${f.text}`).join('\n'), MATERIAL_TOKENS);
}

// ---------------------------------------------------------------- 調模型

/**
 * 要一條 `{brief, keywords, body}`。2026-10-25 起改成轉寫：模型按「一句話 / 關鍵詞 / ## 概要……」寫，轉寫那一檔照抄成 JSON
 * （原文字身就是 JSON 的不轉），轉寫不合格重轉一次。還整理不出來（沒照格式寫、重轉仍不合格）就這一條重寫一次
 * （{@link LORE_ENTRY_ROUNDS} 輪，`LORE_ENTRY_CALLS` 確認框裡報過上限），還不行才算失敗；轉寫呼叫本身失敗直接算失敗。
 * `onCall` 每調一次記一下（寫的與轉寫的都算）：拆書補齊要報實際調了幾次。
 */
async function draftEntry(
  pool: ModelPool,
  transcribe: TranscribeCall,
  label: string,
  user: string,
  signal: AbortSignal,
  onCall?: (n: number) => void
): Promise<EntryDraft> {
  const budget = pool.primaryBudget;
  const options: StreamOptions = {
    maxOutputTokens: budget.maxOutputTokens,
    temperature: 0.2,
    timeoutMs: readConfig().requestTimeoutMs,
    signal,
  };
  for (let attempt = 1; ; attempt++) {
    onCall?.(1);
    const raw = await pool.run(label, (llm) =>
      collectText(
        llm.stream(
          [
            { role: 'system', content: LORE_ENTRY_SYSTEM },
            { role: 'user', content: user },
          ],
          options
        )
      )
    );
    const r = await transcribeJson(raw, entrySpec(label), transcribe);
    onCall?.(r.calls);
    if (r.notes.length > 0) {
      log.info(`${label}：轉寫 ${r.calls} 次`, r.notes.join('\n'));
    }
    if (r.ok) {
      return r.value;
    }
    if (r.failed) {
      throw new Error(r.message);
    }
    if (attempt >= LORE_ENTRY_ROUNDS || signal.aborted) {
      throw new Error(`模型返回無法解析（${r.message}；${raw.length} 字${attempt > 1 ? `，重寫了 ${attempt - 1} 次` : ''}）`);
    }
    log.warn(`${label}：模型返回無法解析（${r.message}；${raw.length} 字），這一條重寫一次`);
  }
}

/**
 * 建條目與整合轉寫那一步：合同是 lorePrompt.ts 的 `loreEntryJsonContract`，解碼就是 {@link parseEntryDraft}。
 * 原文連「概要」「規則與邊界」「現狀」都沒有的不轉。
 */
function entrySpec(label: string): TranscribeSpec<EntryDraft> {
  return {
    label,
    contract: loreEntryJsonContract(),
    decode: (json) => {
      const draft = parseEntryDraft(json);
      return draft ? { ok: true, value: draft } : { ok: false, message: 'body 是空的，或者不是 {brief, keywords, body} 那樣的一個物件' };
    },
    looksLike: (source) => /概要|(?:规|規)(?:则|則)(?:与|與)(?:边|邊)界|(?:现|現)(?:状|狀)/.test(source),
  };
}

/** `{brief, keywords, body}`；正文為空或不是 JSON 返回 undefined。正文裡帶了一級標題就剝掉。 */
export function parseEntryDraft(raw: string): EntryDraft | undefined {
  const obj = jsonObject(raw);
  if (!obj) {
    return undefined;
  }
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const body = stripH1(parseMarkdown(text(obj.body ?? obj.content)).body).trim();
  if (!body) {
    return undefined;
  }
  return {
    brief: text(obj.brief ?? obj.一句话).replace(/\s+/g, ' ').slice(0, LORE_ENTRY_LIMITS.brief),
    keywords: unique(stringArray(obj.keywords ?? obj.关键词)),
    body,
  };
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  for (const candidate of [json, stripTrailingCommas(json)]) {
    try {
      const data: unknown = JSON.parse(candidate);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      // 下一個寫法
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 建條目

/**
 * 給名錄裡「出現過 · 未建條目」的名字建條目。給了 `names` 就建那幾個；沒給就建**出現過**的全部。
 * 每條寫 1 次、轉寫 1 次（整理不出來的重寫一次，`LORE_ENTRY_CALLS`），原料是定稿細綱裡提到它的記錄（不重讀正文），新檔案建在它的分類目錄裡（不存在就建）。
 */
export async function buildLoreEntries(project: NovelProject, names?: readonly string[]): Promise<void> {
  const host = getHost();
  const index = await buildLoreIndex(project);
  const wanted = names?.map(normalizeLoreName).filter(Boolean);
  const targets = wanted?.length
    ? index.unknown.filter((u) => wanted.includes(normalizeLoreName(u.name)))
    : index.unknown.filter((u) => u.chapters.length >= BUILD_MIN_CHAPTERS);
  if (targets.length === 0) {
    host.toast(
      wanted?.length
        ? '名錄裡沒有這個名字，或者它已經有條目了。'
        : '沒有還沒建條目的設定。'
    );
    return;
  }
  const n = targets.length;
  const lanes = Math.max(1, Math.min(readConfig().concurrency, n));
  const answer = await askCall({
    message: `建 ${n} 條設定：${describeCalls(loreEntryCalls(n))}。只讀同步過的細綱裡提到它們的那幾行，不重讀正文。`,
    actions: ['開始建'],
    detail: [
      `要建的：${targets.slice(0, 20).map((u) => u.name).join('、')}${n > 20 ? ` 等 ${n} 條` : ''}`,
      lanes > 1 ? `最多 ${lanes} 條同時建。` : '一條一條序列建（併發數為 1）。',
    ].join('\n\n'),
    tasks: ['loreSynthesis', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '開始建') {
    log.info('作者取消了建條目');
    return;
  }
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'loreSynthesis', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，建條目中止');
      return;
    }

    await runTask(
      '建設定條目',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        const { created, failed } = await createLoreEntries(project, targets, { signal, pool, lanes, report });
        const summary = `新建 ${created} 條設定${failed > 0 ? `，失敗 ${failed} 條（詳見日誌頁）` : ''}`;
        log.info('建條目結束', `${summary}｜總耗時 ${elapsed(startedAt)}`);
        host.toast(`${summary}。`);
      },
      { scope: '设定' }
    );
  });
}

/**
 * 建條目本身：**不問、不彈框**，呼叫方已經把條數與次數報過了（第 4 條）。每條寫 1 次、轉寫 1 次（整理不出來的重寫一次），
 * 最多 `lanes` 條同時建；原料是定稿細綱裡提到它的記錄，水位記到 {@link integrationWatermark}。「建條目」與
 * 拆書「從已寫正文補齊」（features/derive.ts）共用。一條失敗不連累別的，失敗的寫日誌、計進 `failed`；
 * `calls` 是實際調了幾次。
 */
export async function createLoreEntries(
  project: NovelProject,
  targets: readonly UnfiledLore[],
  opts: {
    signal: AbortSignal;
    pool: ModelPool;
    lanes: number;
    report: (p: { message?: string; current?: number; total?: number }) => void;
  }
): Promise<{ created: number; failed: number; calls: number }> {
  const n = targets.length;
  const [allPlots, chapters, through] = await Promise.all([
    project.listPlots(),
    project.listChapters(),
    integrationWatermark(project),
  ]);
  const plots = finalizedPlots(project.pairPlots(allPlots, chapters));
  // 名錄裡另記著的名字都算，不只是這一批：建出來的關鍵詞不收它們（model/loreFile.ts 的 cleanLoreKeywords）。
  const { unknown } = await buildLoreIndex(project, { plots: allPlots }, { pending: false });
  const recorded = unique([...targets.map((t) => t.name), ...unknown.map((u) => u.name)]);
  let created = 0;
  let failed = 0;
  let calls = 0;
  const onCall = (n: number): void => {
    calls += n;
  };
  const transcribe = poolTranscriber(opts.signal, opts.pool);
  await runPool([...targets], opts.lanes, (u) => buildOne(project, u, plots, through, opts.pool, transcribe, opts.signal, recorded, onCall), {
    signal: opts.signal,
    onSettled: (result, u, _i, done) => {
      if (result.status === 'fulfilled') {
        created++;
      } else {
        failed++;
        log.error(`設定「${u.name}」建條目失敗`, describeError(result.reason));
      }
      opts.report({ message: `已建 ${done}/${n} 條`, current: done, total: n });
    },
  });
  project.invalidate();
  return { created, failed, calls };
}

async function buildOne(
  project: NovelProject,
  u: UnfiledLore,
  plots: readonly Plot[],
  through: number,
  pool: ModelPool,
  transcribe: TranscribeCall,
  signal: AbortSignal,
  recorded: readonly string[],
  onCall: (n: number) => void
): Promise<void> {
  const records = recordsAbout(plots, [u.name], u.notes);
  const category = normalizeLoreCategory(u.category);
  const draft = await draftEntry(
    pool,
    transcribe,
    `設定「${u.name}」建條目`,
    `設定：${u.name}\n分類：${category || '未分類'}\n\n定稿細綱裡關於它的記錄（按章號）：\n${renderRecords(records)}`,
    signal,
    onCall
  );
  if (signal.aborted) {
    return;
  }
  // 等模型的時候作者可能已經手建了一條：撞上了就不建，不覆蓋。
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  if (entries.some((e) => normalizeLoreName(e.title) === normalizeLoreName(u.name))) {
    log.info(`設定「${u.name}」已經有條目了，這一條不建`);
    return;
  }
  const keywords = cleanLoreKeywords(u.name, draft.keywords, {
    titles: entries.map((e) => e.title),
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
    // 同一批一起建的、名錄裡另記著的：這一刻還沒有檔案，但都是別的東西。
    recorded,
  });
  const slug = await uniqueSlug(project.loreDir, `${category ? `${category}/` : ''}${slugify(u.name)}`);
  const relPath = await new Workspace(project).writeLore({
    slug,
    title: u.name,
    keywords: [u.name, ...keywords],
    brief: draft.brief,
    body: draft.body,
    updatedThrough: through,
    bodyHash: hash(draft.body.trim()),
  });
  log.info(`新建設定「${u.name}」`, `${relPath}｜依據 ${records.length} 條記錄｜${draft.body.length} 字`);
}

// ---------------------------------------------------------------- 整合

/** 一條要整合的：條目與水位之內的新事實。 */
interface IntegratePlan {
  record: LoreRecord;
  facts: LoreFact[];
}

/**
 * 把條目水位之後、定稿過的新事實並進條目。給了 `relPaths` 就整合那幾條；沒給就是名錄上掛 `＋N` 的全部。
 * 每條寫 1 次、轉寫 1 次（整理不出來的重寫一次）。水位推到 {@link integrationWatermark}，更晚的事實留到下次（它們照樣作為
 * 尾巴帶進上下文）。
 */
export async function integrateLore(project: NovelProject, relPaths?: readonly string[]): Promise<void> {
  const host = getHost();
  const [index, through] = await Promise.all([buildLoreIndex(project), integrationWatermark(project)]);
  const plans: IntegratePlan[] = index.known
    .filter((r) => !relPaths?.length || relPaths.includes(r.entry.relPath))
    .map((record) => ({ record, facts: record.pending.filter((f) => f.no <= through) }))
    .filter((p) => p.facts.length > 0);
  if (plans.length === 0) {
    const waiting = index.known.some(
      (r) => (!relPaths?.length || relPaths.includes(r.entry.relPath)) && r.pending.length > 0
    );
    host.toast(
      waiting
        ? `新內容在第 ${through + 1} 章之後：第 ${through + 1} 章還沒同步（或同步之後正文又改過），整合停在它前面。`
        : relPaths?.length
          ? '這一條沒有新內容要整合。'
          : '沒有要整合的設定：條目都跟上了同步過的章。'
    );
    return;
  }
  const n = plans.length;
  const authored = plans.filter((p) => !loreOwnedByMachine(p.record.entry)).length;
  const lanes = Math.max(1, Math.min(readConfig().concurrency, n));
  const answer = await askCall({
    message: `整合 ${n} 條設定：${describeCalls(loreEntryCalls(n))}。把同步過的章裡的新內容並進條目（整合到第 ${through} 章）。`,
    actions: authored < n ? ['逐條確認後開始', '機器寫的直接採納並開始'] : ['逐條確認後開始'],
    detail: [
      `要整合的：${plans.slice(0, 20).map((p) => p.record.entry.title).join('、')}${n > 20 ? ` 等 ${n} 條` : ''}`,
      authored > 0 ? `其中 ${authored} 條你改過，不管選哪個都會先給你對比再寫。` : '',
      lanes > 1 ? `最多 ${lanes} 條同時整合；逐條確認時，對比按完成順序一條一條彈出。` : '一條一條序列整合（併發數為 1）。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tasks: ['loreSynthesis', 'transcribe'],
    contextDetail: false,
  });
  if (!answer) {
    log.info('作者取消了整合設定');
    return;
  }
  const autoApply = answer.action === '機器寫的直接採納並開始';
  return withCallChoice(answer.choice, async () => {
    const pool = await createModelPool({ task: 'loreSynthesis', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，整合設定中止');
      return;
    }

    await runTask(
      '整合設定',
      async ({ signal, report }) => {
        const startedAt = Date.now();
        let updated = 0;
        let skipped = 0;
        let failed = 0;
        const recorded = index.unknown.map((u) => u.name);
        const transcribe = poolTranscriber(signal, pool);
        await runPool(plans, lanes, (p) => integrateOne(project, p, through, autoApply, pool, transcribe, signal, recorded), {
          signal,
          onSettled: (result, p, _i, done) => {
            if (result.status === 'fulfilled') {
              if (result.value) {
                updated++;
              } else {
                skipped++;
              }
            } else {
              failed++;
              log.error(`設定「${p.record.entry.title}」整合失敗`, describeError(result.reason));
              void recordFailure(project, {
                scope: '设定',
                targetKind: 'lore',
                targetKey: p.record.entry.relPath,
                severity: 'error',
                op: 'integrateLore',
                message: `整合失敗：${describeError(result.reason)}`,
                detail: `這一條沒有改動｜要並進的是第 ${unique(p.facts.map((f) => String(f.no))).join('、')} 章的新內容`,
              });
            }
            report({ message: `已整合 ${done}/${n} 條`, current: done, total: n });
          },
        });
        project.invalidate();
        const summary =
          `更新 ${updated} 條設定` +
          (skipped > 0 ? `，沒採納 ${skipped} 條` : '') +
          (failed > 0 ? `，失敗 ${failed} 條（詳見日誌頁）` : '');
        log.info('整合設定結束', `${summary}｜總耗時 ${elapsed(startedAt)}`);
        host.toast(`${summary}。`);
      },
      { scope: '设定' }
    );
  });
}

/** 整合一條。返回是否寫了。`recorded` 是名錄裡另記著、還沒建條目的名字（新關鍵詞不收）。 */
async function integrateOne(
  project: NovelProject,
  plan: IntegratePlan,
  through: number,
  autoApply: boolean,
  pool: ModelPool,
  transcribe: TranscribeCall,
  signal: AbortSignal,
  recorded: readonly string[]
): Promise<boolean> {
  const { entry } = plan.record;
  const user = [
    `設定：${entry.title}`,
    `分類：${entry.category || '未分類'}`,
    entry.keywords.length > 0 ? `已有關鍵詞：${entry.keywords.join('、')}` : '',
    '',
    `現有條目（作者認可過的內容，記錄沒有明確推翻的不刪）：\n一句話：${entry.brief || '（沒寫）'}\n${entry.body.trim() || '（還是空的）'}`,
    '',
    `第 ${entry.updatedThrough ?? 0} 章之後定稿細綱裡關於它的新記錄（按章號）：\n${renderRecords(plan.facts)}`,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  const draft = await draftEntry(pool, transcribe, `設定「${entry.title}」整合`, user, signal);
  if (signal.aborted) {
    return false;
  }
  // 已有的關鍵詞原樣留著（只增不減，可能是作者寫的）；模型新給的過一遍人名、別的條目的標題與名錄裡另記著的名字。
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const fresh = cleanLoreKeywords(entry.title, draft.keywords, {
    titles: entries.filter((e) => e.slug !== entry.slug).map((e) => e.title),
    people: cards.flatMap((c) => [c.name, ...c.aliases]),
    recorded,
  });
  const proposed = renderLoreEntry({
    slug: entry.slug,
    title: entry.title,
    keywords: unique([...entry.keywords, ...fresh]),
    brief: draft.brief || entry.brief,
    body: draft.body,
    updatedThrough: through,
    bodyHash: hash(draft.body.trim()),
  });
  const abs = project.pathOf(entry.relPath);
  const machine = loreOwnedByMachine(entry);
  // 原來有暗設、整合完一句都沒了：分不清是正文全揭開了還是模型漏了，機器寫的也先對比，不直接採納（第 27 條）。
  const hiddenGone = splitLoreHidden(entry.body).hidden !== '' && splitLoreHidden(draft.body).hidden === '';
  if (!(machine && autoApply) || hiddenGone) {
    const verdict = await serialize(async () => {
      // 排到隊之前檔案可能已被別處改過，進隊後再讀一次才是當下的真相。
      const current = await readText(abs);
      const host = getHost();
      if (host.reviewReplace) {
        return plainVerdict(await host.reviewReplace(`設定「${entry.title}」`, current, proposed, entry.relPath));
      }
      const pick = await host.confirm(`已整合設定「${entry.title}」。採納？`, ['採納', '跳過'], { modal: true });
      return pick === '採納' ? 'apply' : pick === '跳過' ? 'discard' : undefined;
    });
    if (verdict !== 'apply' || signal.aborted) {
      log.info(`沒採納設定「${entry.title}」的整合`, verdict === 'discard' ? '作者放棄' : '作者取消');
      return false;
    }
  }
  await new Workspace(project).write(entry.relPath, { text: proposed }, { mode: 'overwrite', review: false });
  await clearFailures(project, 'lore', entry.relPath, 'integrateLore');
  log.info(
    `已整合設定「${entry.title}」`,
    `${entry.relPath}｜並進 ${plan.facts.length} 條新記錄｜整合到第 ${through} 章${
      !machine ? '｜作者改過，對比後採納' : hiddenGone ? '｜暗設沒了，對比後採納' : ''
    }`
  );
  return true;
}

// ---------------------------------------------------------------- 批次展開（完善設定三期）

/** 批次展開一條的結果。 */
type ExpandOutcome =
  | { written: true; children: string[] }
  | { written: false; why: string };

/**
 * 批次展開（完善設定三期，設計稿 §5）：把還只有一句話的設定照已排的細綱往前想細，**寫完直接落盤，沒有卡片**。
 *
 * - 範圍：給了 `relPaths` 就是那幾條（批次拆細綱「拆完展開本批新設定」）；沒給就是「待完善」裡的全部——還沒有條目的
 *   先按細綱「設定」一節的分類建空條目（同單條「展開…」與細綱帶出新設定，`createPlannedLoreAt`）。
 * - 只寫 {@link loreBatchExpandable} 的（空的、佔位的、機器寫的薄條目）：作者寫過的跳過，確認框與完成提示裡都說出來
 *   （第 19 條批次那一面：不問、不覆蓋）。跑的這幾十秒裡作者改了某一條，落盤前再認一遍，改過就不寫。
 * - 同一份展開合同與裝配（對話頁單條設定那個目標，`poolIO`），每條寫 1 次、轉寫 1 次（2026-10-25 起改成轉寫）；轉寫不合格
 *   重轉一次、整理不出來重寫一次，兩樣不疊加，合計上限 4 次（{@link LORE_EXPAND_BATCH_CALLS}）；被輸出上限截斷不重寫。
 *   寫下的記作機器寫的（`bodyHash`），水位同整合、不往回退。
 * - 建議拆出的子條目照建空條目，**不在同一批裡接著展開**；還沒定的問題批次沒處放，丟掉（要問題就單條展開）。
 * - 模型走「故事架構」檔（設計稿 #12：展開是創作，和設定清單同一檔），不帶思考深度（第 26 條）。失敗掛在那一條上（第 16 條）。
 *
 * `opts.lead`：確認框開頭那句換成呼叫方的說法（拆細綱之後「第 1–5 章拆出了 3 條新設定」）。返回實際調了幾次模型。
 */
export async function expandLoreEntries(
  project: NovelProject,
  relPaths?: readonly string[],
  opts: { lead?: string } = {}
): Promise<number> {
  const host = getHost();
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  let found: LoreEntry[];
  let missing: { name: string; category: string }[] = [];
  if (relPaths) {
    found = relPaths.map((rel) => entries.find((e) => e.relPath === rel)).filter((e): e is LoreEntry => !!e);
  } else {
    const { thin } = await buildLoreIndex(project, { entries, cards }, { pending: false, thin: true });
    found = thin.map((t) => entries.find((e) => e.relPath === t.relPath)).filter((e): e is LoreEntry => !!e);
    missing = thin.filter((t) => !t.relPath).map((t) => ({ name: t.name, category: t.category }));
  }
  const ready = found.filter(loreBatchExpandable);
  const authored = found.filter((e) => !loreBatchExpandable(e));
  const n = ready.length + missing.length;
  const authoredNote =
    authored.length > 0
      ? `跳過你寫過的 ${authored.length} 條：${authored.slice(0, 10).map((e) => e.title).join('、')}${authored.length > 10 ? ' 等' : ''}` +
        '（要展開就在那一條上右鍵「展開…」，先對比再寫）。'
      : '';
  if (n === 0) {
    host.toast(
      authored.length > 0
        ? `沒有能直接展開的設定。${authoredNote}`
        : relPaths
          ? '這幾條設定都不在了，或者已經寫過內容。'
          : '「待完善」裡沒有要展開的設定。'
    );
    return 0;
  }

  const lanes = Math.max(1, Math.min(readConfig().concurrency, n));
  const names = [...ready.map((e) => e.title), ...missing.map((m) => m.name)];
  const answer = await askCall({
    message: `${opts.lead ?? ''}展開 ${n} 條設定：${describeCalls(loreExpandCalls(n))}。照已排的細綱把它們往前想細，寫完直接落盤。`,
    actions: ['開始展開'],
    detail: [
      `要展開的：${names.slice(0, 20).join('、')}${n > 20 ? ` 等 ${n} 條` : ''}`,
      missing.length > 0 ? `其中 ${missing.length} 條還沒有條目，先按細綱「設定」一節裡的分類建空條目。` : '',
      '只寫還只有一句話、沒有你的字的條目（空的、佔位的、機器寫的）；寫下的記作機器寫的，以後整合可以直接採納。',
      authoredNote,
      '建議拆出的子條目建成空條目，不在這一批裡接著展開；還沒定的問題批次不留——要看問題就單條展開。',
      lanes > 1 ? `最多 ${lanes} 條同時展開。` : '一條一條序列展開（併發數為 1）。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tasks: ['setting', 'transcribe'],
    contextDetail: true,
  });
  if (answer?.action !== '開始展開') {
    log.info('作者取消了批次展開設定');
    return 0;
  }
  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const pool = await createModelPool({ task: 'setting', concurrent: lanes > 1 });
    if (!pool) {
      log.error('沒有可用的模型，批次展開設定中止');
      return 0;
    }

    let calls = 0;
    await runTask(
      '展開設定',
      async ({ signal, report }) => {
        // 先存一個存檔點（features/checkpoint.ts）：沒有卡片、寫完直接落盤，整本退得回去。
        await checkpointBefore(project, `展開設定之前（${n} 條）`);
        const startedAt = Date.now();
        const targets = [...ready.map((e) => e.relPath)];
        if (missing.length > 0) {
          // 「待完善」裡還沒有條目的：先建空條目（名字這時已被別的條目或角色卡佔了的不建，同細綱帶出新設定）。
          const made = await createPlannedLoreAt(
            project,
            new Workspace(project),
            missing.map((m) => ({ name: m.name, category: m.category, note: '' }))
          );
          targets.push(...made.map((c) => c.relPath));
          if (made.length < missing.length) {
            log.info(`展開之前有 ${missing.length - made.length} 個名字沒建空條目`, '名字已被別的條目或角色卡佔了');
          }
        }
        const total = targets.length;
        let written = 0;
        let failed = 0;
        const skipped: string[] = [];
        const children: string[] = [];
        /** 失敗記賬等收尾時一起等完：完成提示出來時，紅 ❗ 已經掛在那一條上了。 */
        const records: Promise<void>[] = [];
        await runPool(
          targets,
          lanes,
          (rel) =>
            expandOne(project, rel, pool, config, signal, () => {
              calls++;
            }),
          {
            signal,
            onSettled: (result, rel, _i, done) => {
              if (result.status === 'fulfilled') {
                if (result.value.written) {
                  written++;
                  children.push(...result.value.children);
                } else {
                  skipped.push(result.value.why);
                }
              } else if (!(result.reason instanceof CancelledError) && !signal.aborted) {
                failed++;
                log.error(`設定 ${rel} 展開失敗`, describeError(result.reason));
                records.push(
                  recordFailure(project, {
                    scope: '设定',
                    targetKind: 'lore',
                    targetKey: rel,
                    severity: 'error',
                    op: 'expandLore',
                    message: `展開失敗：${describeError(result.reason)}`,
                    detail: '批次展開，這一條沒有改動。可以在這一條上右鍵「展開…」單條再試。',
                  })
                );
              }
              report({ message: `已展開 ${done}/${total} 條`, current: done, total });
            },
          }
        );
        await Promise.all(records);
        project.invalidate();
        if (signal.aborted) {
          log.warn(`批次展開設定被取消，已寫 ${written} 條`);
          return;
        }
        const summary =
          `展開 ${written} 條設定` +
          (children.length > 0 ? `，新建子條目 ${children.length} 條：${children.join('、')}` : '') +
          (skipped.length > 0 ? `，沒寫 ${skipped.length} 條（${skipped.join('；')}）` : '') +
          (authored.length > 0 ? `，跳過你寫過的 ${authored.length} 條` : '') +
          (failed > 0 ? `，失敗 ${failed} 條（詳見日誌頁）` : '');
        log.info('批次展開設定結束', `${summary}｜呼叫 ${calls} 次｜總耗時 ${elapsed(startedAt)}`);
        host.toast(`${summary}。`);
      },
      { scope: '设定' }
    );
    return calls;
  });
}

/**
 * 展開一條並落盤（批次那條路）。對話頁那條路是 generation/generate.ts 的單條設定目標 + 卡片 + `acceptLoreEntries`；
 * 這裡同一份裝配與鏈，落盤按批次的規矩：落盤前按磁碟再認一遍——不在了、作者在這期間寫了字的不寫。
 */
async function expandOne(
  project: NovelProject,
  relPath: string,
  pool: ModelPool,
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
  onCall: () => void
): Promise<ExpandOutcome> {
  const target: CreationTarget = { kind: 'lore', relPath };
  const known = await loreExpandKnown(project, target);
  const label = `展開設定「${known.title}」`;
  const io = poolIO(project, pool, config, signal, { action: { stage: 'setting', capability: 'generate' }, target, ask: '' });
  // 轉寫也算一次呼叫（完成提示報的總數，第 4 條）。
  const transcribe = io.chain.transcribe!;
  const counted = {
    ...io.chain,
    call: (...args: Parameters<typeof io.chain.call>) => (onCall(), io.chain.call(...args)),
    transcribe: (...args: Parameters<typeof transcribe>) => (onCall(), transcribe(...args)),
  };
  const messages = await counted.build({});
  let result: ChainResult | undefined;
  for (let attempt = 1; !result; attempt++) {
    const first = await counted.call(messages, label);
    try {
      // 第二次是重寫：轉寫不合格不再重轉（LORE_EXPAND_BATCH_CALLS）。
      result = await completeLoreExpand(first, { ...counted, messages }, known, { retranscribe: attempt === 1 });
    } catch (err) {
      // 只重寫一次；重寫連帶轉寫一次，餘量要夠兩次：第一次已經重轉過的不再重寫（兩樣不疊加）。
      const again =
        attempt === 1 &&
        err instanceof ChainError &&
        !signal.aborted &&
        first.stop !== 'maxTokens' &&
        io.calls() + 2 <= LORE_EXPAND_BATCH_CALLS.max;
      if (!again) {
        throw err;
      }
      log.warn(`${label}：${err.message}這一條重來一次`);
    }
  }
  if (result.notes.length > 0) {
    log.info(`${label}：${result.notes.length} 處說明`, result.notes.join('\n'));
  }
  const { entries: drafts } = parseLoreExpansion(result.raw, relPath);
  const [main, ...children] = drafts;
  if (!main || signal.aborted) {
    throw new Error('展開解析不出來');
  }
  return serialize(async () => {
    // 排到隊之前檔案可能已被別處改過，進隊後再讀一次才是當下的真相。
    const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
    const { entry, exists: there } = await loreEntryAt(project, relPath, entries);
    if (!there) {
      return { written: false, why: `「${entry.title}」不在了` };
    }
    if (!loreBatchExpandable(entry)) {
      return { written: false, why: `「${entry.title}」展開期間有人寫了內容` };
    }
    const fresh = cleanLoreKeywords(entry.title, main.keywords, {
      titles: [...entries.filter((e) => e.relPath !== relPath).map((e) => e.title), ...children.map((c) => c.title)],
      people: cards.flatMap((c) => [c.name, ...c.aliases]),
      recorded: known.recorded,
    });
    const body = main.body.trim();
    const text = renderLoreEntry({
      slug: entry.slug,
      title: entry.title,
      keywords: unique([...(entry.keywords.length > 0 ? entry.keywords : [entry.title]), ...fresh]),
      brief: main.brief || entry.brief,
      body,
      // 同單條展開：只往前推不往回退。
      updatedThrough: Math.max(entry.updatedThrough ?? 0, await integrationWatermark(project)),
      bodyHash: hash(body),
    });
    const ws = new Workspace(project);
    await ws.write(relPath, { text }, { mode: 'overwrite', review: false });
    const made = await createPlannedLoreAt(
      project,
      ws,
      children.map((c) => ({ name: c.title, category: c.category, note: c.brief }))
    );
    await clearFailures(project, 'lore', relPath, 'expandLore');
    await clearFailures(project, 'lore', relPath, 'creation');
    log.info(
      `已展開設定「${entry.title}」`,
      `${relPath}｜正文 ${body.length} 字｜批次，直接寫${made.length > 0 ? `｜新建子條目 ${made.map((c) => c.name).join('、')}` : ''}`
    );
    return { written: true, children: made.map((c) => c.name) };
  });
}

// ---------------------------------------------------------------- 按目錄整理

/** 整理的範圍：只整理根目錄下（未分類）的，還是全部。 */
export type OrganizeScope = 'unfiled' | 'all';

/** 校驗過的一次搬家。 */
export interface LoreMove {
  from: string;
  /** 現在所在的目錄（相對 `lore/`，根目錄是空串）。 */
  category: string;
  /** 目標目錄（相對 `lore/`，根目錄是空串）。 */
  to: string;
  title: string;
}

/**
 * 按目錄整理（作者定案）。模型只出一份搬家清單，程式校驗，作者看過點了「照這樣整理」才搬；
 * 搬家走閘道器的 `move`（只在設定區裡），**條目內容一個字不改**。`scope` 沒給就先問。
 */
export async function organizeLore(project: NovelProject, scope?: OrganizeScope): Promise<void> {
  const host = getHost();
  const entries = await project.listLore();
  if (entries.length === 0) {
    host.toast('還沒有設定條目，沒什麼可整理的。');
    return;
  }
  const unfiled = entries.filter((e) => !e.category).length;
  let range = scope;
  if (!range) {
    const ask = await host.confirm(
      `按目錄整理設定：讓模型照本書的目錄樹給條目歸類，先出一份搬家清單給你看，你點頭了才搬。`,
      [...(unfiled > 0 ? [`只整理未分類的 ${unfiled} 條`] : []), `全部 ${entries.length} 條都看一遍`],
      { modal: true, detail: '目錄就是分類，可以多層；模型可以提議新目錄。只搬檔案，條目內容一個字不改。' }
    );
    if (!ask) {
      return;
    }
    range = ask.startsWith('只整理') ? 'unfiled' : 'all';
  }
  const targets = range === 'unfiled' ? entries.filter((e) => !e.category) : entries;
  if (targets.length === 0) {
    host.toast('根目錄下沒有未分類的條目。');
    return;
  }
  const batches = chunk(targets, ORGANIZE_BATCH);
  const answer = await askCall({
    message: `整理 ${targets.length} 條設定：分 ${batches.length} 批，${describeCalls(transcribedCalls(batches.length, '每批'))}，出一份搬家清單。`,
    actions: ['開始'],
    tasks: ['loreSynthesis', 'transcribe'],
    contextDetail: false,
  });
  if (answer?.action !== '開始') {
    return;
  }
  return withCallChoice(answer.choice, async () => {
    const config = readConfig();
    const pool = await createModelPool({ task: 'loreSynthesis', concurrent: false });
    if (!pool) {
      log.error('沒有可用的模型，整理中止');
      return;
    }

    await runTask(
      '按目錄整理設定',
      async ({ signal, report }) => {
        const categories = await project.listLoreCategories();
        const folders = new Set<string>();
        const moves: LoreMove[] = [];
        const notes: string[] = [];
        const transcribe = poolTranscriber(signal, pool);
        for (const [i, batch] of batches.entries()) {
          if (signal.aborted) {
            return;
          }
          report({ message: `第 ${i + 1}/${batches.length} 批`, current: i, total: batches.length });
          try {
            const raw = await pool.run(`整理設定第 ${i + 1} 批`, (llm) =>
              collectText(
                llm.stream(
                  [
                    { role: 'system', content: LORE_ORGANIZE_SYSTEM },
                    { role: 'user', content: organizePrompt([...categories, ...folders], batch) },
                  ],
                  { maxOutputTokens: pool.primaryBudget.maxOutputTokens, temperature: 0.2, timeoutMs: config.requestTimeoutMs, signal }
                )
              )
            );
            // 2026-10-25 起改成轉寫：按「## 新目錄」「## 搬家」寫的清單交給轉寫那一檔照抄成 JSON（原文字身就是 JSON 的不轉）。
            // 轉寫沒成同從前解析不了：這一批算失敗，別的批照常。
            const known = [...categories, ...folders];
            const r = await transcribeJson(raw, organizeSpec(`整理設定第 ${i + 1} 批`, batch, known), transcribe);
            if (r.notes.length > 0) {
              log.info(`整理設定第 ${i + 1} 批：轉寫 ${r.calls} 次`, r.notes.join('\n'));
            }
            if (!r.ok) {
              throw new Error(r.failed ? r.message : `模型返回無法解析（${r.message}；${raw.length} 字）`);
            }
            const plan = r.value;
            plan.folders.forEach((f) => folders.add(f));
            moves.push(...plan.moves);
            notes.push(...plan.dropped);
          } catch (err) {
            if (signal.aborted) {
              return;
            }
            log.error(`整理設定第 ${i + 1} 批失敗`, describeError(err));
            notes.push(`第 ${i + 1} 批失敗：${describeError(err)}`);
          }
        }
        if (notes.length > 0) {
          log.warn(`搬家清單裡有 ${notes.length} 處沒收`, notes.join('\n'));
        }
        const used = new Set(moves.map((m) => m.to));
        const newFolders = [...folders].filter((f) => used.has(f) || moves.some((m) => m.to.startsWith(`${f}/`)));
        if (moves.length === 0) {
          host.toast('都放得好好的，不用搬。');
          return;
        }
        const listing = moves.slice(0, 60).map((m) => `${m.title}：${m.category || '未分類'} → ${m.to || '未分類'}`);
        const ok = await host.confirm(
          `搬 ${moves.length} 條設定${newFolders.length > 0 ? `，新建 ${newFolders.length} 個目錄` : ''}。只搬檔案，條目內容一個字不改。`,
          ['照這樣整理'],
          {
            modal: true,
            detail: [
              newFolders.length > 0 ? `新目錄：${newFolders.join('、')}` : '',
              listing.join('\n') + (moves.length > 60 ? `\n……還有 ${moves.length - 60} 條` : ''),
              notes.length > 0 ? `另有 ${notes.length} 處沒收（詳見日誌頁）。` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          }
        );
        if (ok !== '照這樣整理') {
          log.info('作者沒採納搬家清單');
          return;
        }
        // 先存一個存檔點（features/checkpoint.ts）：一次搬很多條，整本退得回去。
        await checkpointBefore(project, '按目錄整理設定之前');
        const moved = await applyMoves(project, newFolders, moves);
        host.toast(`已搬 ${moved} 條設定${moved < moves.length ? `，${moves.length - moved} 條沒搬（詳見日誌頁）` : ''}。`);
      },
      { scope: '设定' }
    );
  });
}

function organizePrompt(categories: readonly string[], batch: readonly LoreEntry[]): string {
  return [
    `本書現有目錄：${categories.length > 0 ? categories.join('、') : '（還沒有目錄）'}`,
    '',
    '要整理的條目（路徑｜標題｜一句話）：',
    ...batch.map((e) => `- ${e.slug}｜${e.title}｜${e.brief || e.body.trim().split(/\n/)[0]?.slice(0, LORE_ENTRY_LIMITS.brief) || ''}`),
  ].join('\n');
}

/**
 * 按目錄整理轉寫那一步：合同是 lorePrompt.ts 的 `loreOrganizeJsonContract`，解碼就是 {@link checkOrganizePlan}。
 * 路徑都照抄原文，沒有按對應關係填的（搬回根目錄的 `to` 是空串，不比）；原文連「新目錄」「搬家」、一個箭頭都沒有的不轉。
 */
function organizeSpec(
  label: string,
  batch: readonly LoreEntry[],
  categories: readonly string[]
): TranscribeSpec<ReturnType<typeof checkOrganizePlan>> {
  return {
    label,
    contract: loreOrganizeJsonContract(),
    decode: (json) => {
      try {
        return { ok: true, value: checkOrganizePlan(json, batch, categories) };
      } catch (err) {
        return { ok: false, message: describeError(err) };
      }
    },
    looksLike: (source) => /新目(?:录|錄)|搬家|→/.test(source),
  };
}

/**
 * 校驗模型給的搬家清單：`from` 得是這一批裡的條目（認路徑或標題），`to` 得是已有目錄或這次提議的新目錄
 * （最多三層、每段是合法的檔名），位置沒變的去掉，同一條只搬一次。沒收的寫進 `dropped`（第 2 條）。
 */
export function checkOrganizePlan(
  raw: string,
  batch: readonly LoreEntry[],
  categories: readonly string[]
): { folders: string[]; moves: LoreMove[]; dropped: string[] } {
  const obj = jsonObject(raw);
  if (!obj) {
    throw new Error(`模型返回無法解析（${raw.length} 字）`);
  }
  const folders: string[] = [];
  const dropped: string[] = [];
  for (const f of stringArray(obj.folders)) {
    const dir = normalizeLoreCategory(f);
    const parts = dir.split('/');
    if (!dir || parts.length > ORGANIZE_DEPTH || parts.some((p) => sanitizeFileName(p) !== p)) {
      dropped.push(`新目錄「${f}」不合規`);
      continue;
    }
    if (!folders.includes(dir) && !categories.includes(dir)) {
      folders.push(dir);
    }
  }
  const allowed = new Set([...categories, ...folders, '']);
  const bySlug = new Map(batch.map((e) => [e.slug, e]));
  const byTitle = new Map(batch.map((e) => [normalizeLoreName(e.title), e]));
  const moves: LoreMove[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(obj.moves) ? obj.moves : []) {
    const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const from = typeof m.from === 'string' ? m.from.trim().replace(/^\.(?:novelwarden|novelforge|novel)\/lore\//, '').replace(/\.md$/i, '') : '';
    const entry = bySlug.get(from) ?? byTitle.get(normalizeLoreName(from));
    if (!entry) {
      dropped.push(`「${from}」不是這一批裡的條目`);
      continue;
    }
    const to = normalizeLoreCategory(typeof m.to === 'string' ? m.to : '');
    if (!allowed.has(to)) {
      dropped.push(`「${entry.title}」要去的「${to}」既不是已有目錄，也沒在 folders 裡新建`);
      continue;
    }
    if (to === entry.category || seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    moves.push({ from: entry.relPath, category: entry.category, to, title: entry.title });
  }
  return { folders, moves, dropped };
}

/**
 * 搬檔案。返回搬了幾條。目標位置已有同名檔案的不搬、說出來。
 *
 * **新目錄不先建**：`ws.move` 落盤前自己補齊父目錄（落點過閘道器的守衛，第 7 條），所以新目錄只在真有條目搬進去時出現。
 * 從前這裡先直接 `fs.mkdir` 建出清單上的每個新目錄（繞過閘道器）——它唯一的效果是：搬不成的時候留下一個空目錄。
 */
async function applyMoves(project: NovelProject, folders: readonly string[], moves: readonly LoreMove[]): Promise<number> {
  const root = project.relPath(project.loreDir);
  const ws = new Workspace(project);
  let moved = 0;
  for (const m of moves) {
    const next = `${root}/${m.to ? `${m.to}/` : ''}${path.posix.basename(m.from)}`;
    if (await exists(project.pathOf(next))) {
      log.warn(`設定「${m.title}」沒搬：目標位置已有同名檔案`, `${m.from} → ${next}`);
      continue;
    }
    try {
      await ws.move(m.from, next);
      // 失敗記錄按路徑掛，搬了家就掛不住了：一併收掉，下次失敗再掛。
      await clearFailures(project, 'lore', m.from);
      moved++;
    } catch (err) {
      log.warn(`設定「${m.title}」沒搬：${describeError(err)}`, `${m.from} → ${next}`);
    }
  }
  project.invalidate();
  let created = 0;
  for (const dir of folders) {
    created += (await exists(project.pathOf(`${root}/${dir}`))) ? 1 : 0;
  }
  log.info('按目錄整理設定', `搬了 ${moved}/${moves.length} 條｜新目錄 ${created}/${folders.length} 個`);
  return moved;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
