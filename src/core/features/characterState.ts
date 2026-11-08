/**
 * 定稿時更新本章出場角色的「當前狀態」（D15），以及作者改過、沒被覆蓋的那幾張卡的對比入口。
 *
 * ## 誰的卡、寫不寫
 *
 * 出場人物以本章定稿後的細綱為準（第 14 條：定稿過的細綱是出場人物的唯一真相），按 `views/cast.ts` 同一張表
 * 認卡。一次呼叫出所有人的新狀態；歸屬看 model/characterState.ts：
 *
 * | 情形 | 做法 |
 * |---|---|
 * | 這一節歸機器 | 換成新的那一版、蓋章（`stateThrough` / `stateHash`） |
 * | 作者改過 | 不寫；掛黃 ❗，說明裡帶上機器給的那一版，右鍵「對比…」決定 |
 * | 卡上已經是更晚那一章的狀態 | 不回退（重新定稿早前的章時） |
 * | 出場了、狀態沒變 | 機器的卡把「寫到第幾章」推到這一章；作者的卡不動 |
 * | 模型給了名單外的名字 | 忽略，記日誌 |
 *
 * 寫卡**只動那一節與兩個 frontmatter 欄位**（`patchCardState`）：整卡重渲染會抹掉作者自加的
 * 小節。這裡不走覆蓋審閱——歸屬判據就是那道閘（與批次路徑「只補空白」同一個理由）。
 *
 * 2026-10-25 起改成轉寫：模型一人一節「## 人物名」寫自然語言，轉寫模型照抄成原來那份 `{"updates":[…]}`
 * （{@link parseStateUpdates} 照舊解碼）。只寫了「無」（或「本章沒有人的狀態變了」這種短短一句）的不轉，沒有人的狀態變了。
 */
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { LlmProvider, StreamOptions } from '../llm/provider';
import { readConfig } from '../config';
import { describeError, scoped } from '../runtime/logger';
import { activeFailure, clearFailures, recordFailure } from '../runtime/errorLog';
import { readText } from '../model/fs';
import { NovelProject } from '../model/project';
import { Chapter, CharacterCard, SummaryCast } from '../model/types';
import { hasContent } from '../model/markdown';
import { patchCardState, patchCardThrough, stateOwnedByMachine } from '../model/characterState';
import { clipLine } from '../context/layers/render';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { cardLookup } from '../views/cast';
import { Workspace } from '../workspace';
import { extractJsonObject, stripCodeFence } from './parse';
import { STATE_JSON_CONTRACT, STATE_SYSTEM } from './characterCardPrompt';
import { TranscribeCall, transcribeJson } from './transcribe';
import { poolTranscriber } from './poolIO';

const log = scoped('角色卡');

/** 失敗記錄的 op：作者改過的狀態沒被覆蓋、以及這一步呼叫失敗，都記在它名下。 */
export const STATE_OP = 'cardState';

/**
 * 角色狀態沒更新成（模型的回答讀不出來、轉寫沒成）。帶著這一步已經調了幾次（寫 1 次，加上轉寫的），定稿照它記賬。
 */
export class StateUpdateError extends Error {
  constructor(
    message: string,
    readonly calls: number
  ) {
    super(message);
    this.name = 'StateUpdateError';
  }
}

/** 角色狀態那一步沒成時調了幾次：讀不出來的帶著實數，別的錯（網路、超時）是寫的那 1 次。 */
export function stateCallsOf(err: unknown): number {
  return err instanceof StateUpdateError ? err.calls : 1;
}

export interface StateUpdateOutcome {
  /** 調了幾次模型：出場的人都沒建卡時是 0。 */
  calls: number;
  /** 當前狀態換成了這一章的那一版。 */
  updated: string[];
  /** 出場了、狀態沒變：機器的卡把「寫到第幾章」推到了這一章。 */
  carried: string[];
  /** 作者改過，沒有覆蓋（掛了黃 ❗）。 */
  guarded: string[];
  /** 卡上已經是更晚那一章的狀態，沒有回退。 */
  newer: string[];
  /** 模型給了名單外的名字。 */
  unknown: string[];
}

/**
 * 更新本章出場角色的當前狀態。
 *
 * `run` 決定怎麼調模型：單章入口直接用對話頁選定的那個；批次入口傳分檔池（失敗換同檔其餘，
 * 第 12 條）。呼叫失敗或返回解析不出來（轉寫沒成）時拋錯——細綱已經更新好了，由呼叫方把失敗掛在章節上。
 */
export async function updateCharacterStates(
  project: NovelProject,
  chapter: Chapter,
  cast: readonly SummaryCast[],
  opts: {
    run: <T>(what: string, fn: (llm: LlmProvider) => Promise<T>) => Promise<T>;
    budget: { contextWindow: number; maxOutputTokens: number };
    signal?: AbortSignal;
    /** 轉寫那一次怎麼調（2026-10-25 起）。預設走「轉寫」那一檔，那一檔沒有可用的模型時用 `run` 那一個。 */
    transcribe?: TranscribeCall;
  }
): Promise<StateUpdateOutcome> {
  const out: StateUpdateOutcome = { calls: 0, updated: [], carried: [], guarded: [], newer: [], unknown: [] };
  const cards = await project.listCharacters();
  const lookup = cardLookup(cards);
  const present: CharacterCard[] = [];
  for (const entry of cast) {
    const card = lookup(entry);
    if (card && !present.some((c) => c.relPath === card.relPath)) {
      present.push(card);
    }
  }
  if (present.length === 0) {
    log.info(`第 ${chapter.order} 章出場的人都還沒有角色卡，不更新角色狀態`);
    return out;
  }

  const text = await project.readChapterText(chapter);
  const config = readConfig();
  const roster = present
    .map((c) => {
      const identity = hasContent(c.sections.身份) ? clipLine(c.sections.身份, 60) : '';
      const now = hasContent(c.sections.当前状态) ? c.sections.当前状态.trim() : '（空）';
      return `- ${c.name}${identity ? `（${identity}）` : ''}\n  現在的當前狀態：${now}`;
    })
    .join('\n');
  const inputBudget = Math.max(2000, opts.budget.contextWindow - opts.budget.maxOutputTokens - 1500 - estimateTokens(roster));
  const body = takeHead(text, inputBudget);
  if (body.length < text.length) {
    log.warn(`第 ${chapter.order} 章正文超出輸入預算，更新角色狀態時已截斷`, `${text.length} 字 → ${body.length} 字`);
  }
  const user =
    `【第${chapter.order}章 ${chapter.title}】\n\n${body}\n\n` +
    `【本章出場、已經建檔的人物】\n${roster}\n\n請按要求寫。`;
  const options: StreamOptions = {
    maxOutputTokens: opts.budget.maxOutputTokens,
    temperature: 0.3,
    timeoutMs: config.requestTimeoutMs,
    signal: opts.signal,
  };

  out.calls = 1;
  const raw = await opts.run(`第 ${chapter.order} 章 · 角色狀態`, (llm) =>
    collectText(
      llm.stream(
        [
          { role: 'system', content: STATE_SYSTEM },
          { role: 'user', content: user },
        ],
        options
      )
    )
  );
  const transcribe =
    opts.transcribe ?? poolTranscriber(opts.signal ?? new AbortController().signal, { run: opts.run, primaryBudget: opts.budget });
  const read = await readStateUpdates(raw, present, transcribe, chapter.order);
  out.calls = 1 + read.calls;
  if (read.notes.length > 0) {
    log.warn(`第 ${chapter.order} 章角色狀態的轉寫不順`, read.notes.join('\n'));
  }
  if (!read.updates) {
    throw new StateUpdateError(`模型返回的角色狀態解析不出來（${read.why}）`, out.calls);
  }
  const updates = read.updates;

  const ws = new Workspace(project);
  const touched = new Set<string>();
  const byName = cardLookup(present);
  for (const u of updates) {
    const card = byName(u.name);
    if (!card) {
      out.unknown.push(u.name);
      continue;
    }
    if (touched.has(card.relPath)) {
      continue;
    }
    touched.add(card.relPath);
    if (card.stateThrough !== undefined && card.stateThrough > chapter.order) {
      out.newer.push(card.name);
      continue;
    }
    if (!stateOwnedByMachine(card)) {
      out.guarded.push(card.name);
      await recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: card.relPath,
        severity: 'warn',
        op: STATE_OP,
        message: `第 ${chapter.order} 章同步時給出了新的「當前狀態」，這一節你改過，沒有覆蓋`,
        detail: `${proposalHead(chapter.order)}\n${u.state}\n\n右鍵這張卡「對比第 ${chapter.order} 章給出的狀態…」可以對比後決定用不用。`,
      });
      continue;
    }
    const file = await readText(project.pathOf(card.relPath));
    await ws.write(card.relPath, { text: patchCardState(file, u.state, chapter.order) }, { mode: 'overwrite', review: false });
    await clearFailures(project, 'character', card.relPath, STATE_OP);
    out.updated.push(card.name);
  }

  // 出場了、狀態沒變：狀態仍然成立到這一章。只推機器的卡，作者的卡一個字不動。
  for (const card of present) {
    if (touched.has(card.relPath) || !hasContent(card.sections.当前状态) || !stateOwnedByMachine(card)) {
      continue;
    }
    if ((card.stateThrough ?? -1) >= chapter.order) {
      continue;
    }
    const file = await readText(project.pathOf(card.relPath));
    await ws.write(card.relPath, { text: patchCardThrough(file, card.sections.当前状态, chapter.order) }, { mode: 'overwrite', review: false });
    out.carried.push(card.name);
  }

  log.info(
    `第 ${chapter.order} 章的角色狀態已處理`,
    [
      out.updated.length > 0 ? `更新 ${out.updated.join('、')}` : '',
      out.carried.length > 0 ? `沿用 ${out.carried.join('、')}` : '',
      out.guarded.length > 0 ? `你改過、沒覆蓋 ${out.guarded.join('、')}` : '',
      out.newer.length > 0 ? `已是更晚的狀態 ${out.newer.join('、')}` : '',
      out.unknown.length > 0 ? `名單外的名字 ${out.unknown.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('｜') || '沒有人的狀態變了'
  );
  return out;
}

/** 黃 ❗ 說明裡機器那一版的開頭。對比入口按它把那一版取回來。 */
function proposalHead(no: number): string {
  return `【第 ${no} 章給出的當前狀態】`;
}

const PROPOSAL = /【第 (\d+) 章(?:给|給)出的(?:当|當)前(?:状|狀)(?:态|態)】\n([\s\S]*?)(?:\n\n右(?:键|鍵)(?:这|這)(?:张|張)卡|$)/;

/** 從黃 ❗ 的說明裡取回機器給的那一版。認不出返回 undefined。 */
export function proposalOf(detail: string | undefined): { no: number; state: string } | undefined {
  const m = PROPOSAL.exec(detail ?? '');
  return m ? { no: Number(m[1]), state: m[2].trim() } : undefined;
}

/** 「無」「本章沒有人的狀態變了」這種短短一句（名單上的名字一個都沒提）：沒有人的狀態變了。 */
const NOTHING = /(?:无|無)|(?:没|沒)有/u;
const NOTHING_MAX_CHARS = 40;

/**
 * 模型的回答 → 各人的新狀態（2026-10-25 起改成轉寫）：模型自己給了 JSON（老會話、測試裡的假模型）照原來的解碼、不轉；只寫了「無」
 * （或「本章沒有人的狀態變了」這種短短一句）的是沒人變、不轉；一個名單上的名字都沒有的（答非所問）不花轉寫那一次；其餘轉寫模型照抄成 `{"updates":[…]}`。
 * 讀不出來、轉寫沒成交回 `why`。
 */
async function readStateUpdates(
  raw: string,
  present: readonly CharacterCard[],
  transcribe: TranscribeCall,
  no: number
): Promise<{ updates?: { name: string; state: string }[]; why: string; calls: number; notes: string[] }> {
  const direct = parseStateUpdates(raw);
  if (direct) {
    return { updates: direct, why: '', calls: 0, notes: [] };
  }
  const names = present.flatMap((c) => [c.name, ...c.aliases]).filter((n) => n.trim().length > 0);
  const text = stripCodeFence(raw).trim();
  if ([...text].length <= NOTHING_MAX_CHARS && NOTHING.test(text) && !names.some((n) => text.includes(n))) {
    return { updates: [], why: '', calls: 0, notes: [] };
  }
  const r = await transcribeJson(
    raw,
    {
      label: `第 ${no} 章角色狀態`,
      contract: STATE_JSON_CONTRACT,
      decode: (json) => {
        const updates = parseStateUpdates(json);
        return updates ? { ok: true, value: updates } : { ok: false, message: '沒有 updates 這一項' };
      },
      looksLike: (source) => names.some((n) => source.includes(n)),
    },
    transcribe
  );
  return r.ok
    ? { updates: r.value, why: '', calls: r.calls, notes: r.notes }
    : { why: r.calls > 0 ? `轉寫沒成：${r.message}` : r.message, calls: r.calls, notes: r.notes };
}

/**
 * `{"updates":[{"name","当前状态"}]}`。欄位名寫成 `state` / `currentState`（上游的叫法，可能是
 * 物件）也收；`updates` 缺了、根本不是 JSON 時返回 undefined。當前狀態是空的那一條丟掉——
 * 空字串換掉一段有內容的狀態，比不換更糟。
 */
export function parseStateUpdates(raw: string): { name: string; state: string }[] | undefined {
  const json = extractJsonObject(stripCodeFence(raw));
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  const list = (data as { updates?: unknown })?.updates;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: { name: string; state: string }[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const value = o['当前状态'] ?? o.state ?? o.currentState;
    const state =
      typeof value === 'string'
        ? value.trim()
        : typeof value === 'object' && value !== null
          ? Object.values(value as Record<string, unknown>)
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .join('；')
          : '';
    if (name && state) {
      out.push({ name, state });
    }
  }
  return out;
}

/**
 * 「對比第 N 章給出的狀態…」：作者改過的那張卡，拿機器給的那一版做一次覆蓋審閱。
 *
 * 採用 → 按機器寫入（蓋章、清 ❗，這一節從此又歸機器）；放棄 → 清 ❗、不寫（這一節仍然歸作者，
 * 下一次定稿照樣不覆蓋、照樣掛 ❗）；關掉審閱框什麼都不做。
 */
export async function reviewCharacterState(project: NovelProject, relPath: string): Promise<void> {
  const card = (await project.listCharacters()).find((c) => c.relPath === relPath);
  if (!card) {
    getHost().toast('找不到這張角色卡，可能剛被改名或刪除。', 'error');
    return;
  }
  const failure = await activeFailure(project, 'character', relPath, STATE_OP);
  const proposal = proposalOf(failure?.detail);
  if (!proposal) {
    getHost().toast(`「${card.name}」沒有待對比的狀態。`);
    return;
  }
  const raw = await readText(project.pathOf(relPath));
  const next = patchCardState(raw, proposal.state, proposal.no);
  const host = getHost();
  let verdict: 'apply' | 'discard' | undefined;
  try {
    verdict = host.reviewReplace
      ? plainVerdict(await host.reviewReplace(`角色卡「${card.name}」的當前狀態`, raw, next, relPath))
      : (await host.confirm(`用第 ${proposal.no} 章給出的狀態換掉「${card.name}」現在的當前狀態？`, ['換', '不換'], {
            modal: true,
            detail: proposal.state,
          })) === '換'
        ? 'apply'
        : 'discard';
  } catch (err) {
    log.error(`對比「${card.name}」的狀態失敗：${describeError(err)}`, err);
    return;
  }
  if (verdict === 'apply') {
    await new Workspace(project).write(relPath, { text: next }, { mode: 'overwrite', review: false });
    await clearFailures(project, 'character', relPath, STATE_OP);
    log.info(`「${card.name}」換成了第 ${proposal.no} 章給出的狀態`, relPath);
    host.toast(`「${card.name}」的當前狀態已更新到第 ${proposal.no} 章。`);
  } else if (verdict === 'discard') {
    await clearFailures(project, 'character', relPath, STATE_OP);
    log.info(`「${card.name}」保留作者寫的狀態`, `沒有用第 ${proposal.no} 章給出的那一版`);
  }
}
