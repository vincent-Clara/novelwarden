/**
 * 落定設定（完善設定二期）的解碼、規範化與氣泡往返。**純函式、絕不拋。**
 *
 * 合同（context/loreSettlePrompt.ts）：
 *
 * ```json
 * { "entries": [{ "title": "…", "category": "…", "keywords": ["…"], "brief": "…",
 *                 "body": { "概要": "…", "规则与边界": "…", "现状": "…", "暗设": "…" } }],
 *   "questions": ["…"] }
 * ```
 *
 * 程式這一側的校驗不加呼叫，照展開那一套（features/loreExpand.ts）：一句話截 {@link LORE_ENTRY_LIMITS}.brief 字；
 * 明面三節按上限截、暗設另截（`decodeLoreBody`）；關鍵詞過 `cleanLoreKeywords`、最多
 * {@link LORE_EXPAND_LIMITS}.keywords 個；`questions` 同展開。另外幾條是一批才有的：沒名字的、同一批裡重名的、
 * 是角色卡上的人的、明面一節內容都沒有的丟掉；最多 {@link LORE_SETTLE_LIMITS}.entries 條。認出是已有條目、正文卻和
 * 原來一字不差的也丟掉（討論沒改它，只是順手改了一句話或關鍵詞——真跑時一次落定彈了三張這樣的對比）。丟了什麼寫進
 * `warnings`。
 *
 * ## 認已有條目
 *
 * 模型只給名字與分類（它不知道路徑）。生成鏈裡那一次（`known` 給了）按磁碟認出它說的是哪一條已有條目
 * （{@link findSettledEntry}：路徑 → 同名（同名不同分類的按分類挑）→ 關鍵詞），把路徑、標題、分類換成那一條的，
 * 寫進規範化結果——氣泡裡看得見哪幾條是改已有的（帶 `relPath`）。採納時拿氣泡文字重新解析（不讀盤），落盤那一步
 * （generation/loreSettle.ts）再按磁碟認一遍：這期間作者可能改了名、刪了條目、新建了同名的。兩次認同一個函式。
 *
 * **解析不了就沒有產物**，不做全文兜底（同展開）。
 */
import { pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_LINE_LIMITS,
  LORE_SETTLE_LIMITS,
  LoreLookup,
  cleanLoreKeywords,
  createLoreLookup,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import { LoreDraft, decodeLoreBody, decodeLoreQuestions, loreJsonObject } from './loreExpand';
import { loreFolderOf } from './loreList';
import { parseJson } from './structuredJson';

/** 解碼要對照的已有東西。不給就只做形狀上的校驗（採納時拿氣泡文字重新解析，那時不讀盤）。 */
export interface LoreSettleKnown {
  /** 全部條目：認出改的是哪一條；別的條目的標題不進關鍵詞。 */
  entries: readonly LoreEntry[];
  /** 角色卡上的名字與別稱：人不是設定，不建條目、不進關鍵詞。 */
  people: readonly string[];
  /** 名錄裡另記著、還沒建條目的名字：不進關鍵詞（同建條目、整合）。 */
  recorded: readonly string[];
}

/** 規範化之後的一次落定：條目（改已有的帶 `relPath`）與還沒定的問題。 */
export interface LoreSettlement {
  entries: LoreDraft[];
  questions: string[];
}

export type LoreSettleDecode = { ok: true; value: LoreSettlement; warnings: string[] } | { ok: false; message: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** 壓成一行、按字（不按 UTF-16 碼元）截到 `max`。 */
function clip(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function length(value: string): number {
  return Array.from(value.replace(/\s+/g, ' ').trim()).length;
}

/** 字串陣列；寫成一個字串時按頓號、逗號拆開。 */
function strings(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

/** 名字後面跟著的 `〔分類〕`（`【】` `[]` 也認）：上下文裡一行帶的設定就長這樣，模型會照抄進 title。 */
const TRAILING_CATEGORY = /\s*[〔【[]\s*([^〕】\]]*?)\s*[〕】\]]\s*$/u;

/**
 * 一條的名字與名字裡夾帶的分類：認幾種常見的鍵。真跑時模型把「土地廟〔地點/青羊鎮域〕」整個寫進了 title，認不出
 * 是已有的土地廟，另建了一份——名字後面的 `〔…〕` 剝掉，裡面的東西當分類（沒另給 category 時用）。
 */
function nameOf(row: Record<string, unknown>): { title: string; category: string } {
  const raw = str(row.title ?? row.name ?? row.标题 ?? row.名称 ?? row.名字);
  const m = TRAILING_CATEGORY.exec(raw);
  const bare = m ? raw.slice(0, m.index).trim() : raw;
  return { title: clip(bare || raw, LORE_LINE_LIMITS.name), category: m && bare ? m[1] : '' };
}

function titleOf(row: Record<string, unknown>): string {
  return nameOf(row).title;
}

/** 條目那一組：`{entries:[…]}`（認幾種鍵名），或者整段就是一個陣列。認不出返回 undefined。 */
function rowsOf(text: string): { rows: unknown[]; o?: Record<string, unknown> } | undefined {
  // 先認裸陣列：只有一條的 `[{…}]` 裡「唯一一個完整物件」恰好是那一條自己，當成外層物件就取不到條目。
  const bare = parseJson(text);
  if (Array.isArray(bare)) {
    return { rows: bare };
  }
  const o = loreJsonObject(text);
  if (o) {
    const rows = o.entries ?? o.条目 ?? o.设定 ?? o.lore;
    return Array.isArray(rows) ? { rows, o } : undefined;
  }
  return undefined;
}

/**
 * 一條要落定的設定說的是哪一條已有條目：給了路徑且那條還在 → 同名（歸一後；同名的不止一條時按分類挑，挑不出取第一條）
 * → 名字是某一條的關鍵詞。都不是就是新的。生成鏈與落盤共用（見檔案頭「認已有條目」）。
 */
export function findSettledEntry(
  entries: readonly LoreEntry[],
  draft: Pick<LoreDraft, 'relPath' | 'title' | 'category'>,
  lookup: LoreLookup = createLoreLookup(entries)
): LoreEntry | undefined {
  const byPath = draft.relPath ? entries.find((e) => e.relPath === draft.relPath) : undefined;
  if (byPath) {
    return byPath;
  }
  const key = normalizeLoreName(draft.title);
  const same = key ? entries.filter((e) => normalizeLoreName(e.title) === key) : [];
  if (same.length > 0) {
    const folder = loreFolderOf(draft.category);
    return same.find((e) => e.category === folder) ?? same[0];
  }
  return key ? lookup.find(draft.title) : undefined;
}

/**
 * 解碼一次落定。`known` 給了就按磁碟認已有條目、過濾關鍵詞與人名（生成鏈裡那一次）；不給只做形狀上的校驗與截斷
 * （採納時拿氣泡文字重新解析）。一條都沒留下也算解析成功（討論裡可能真的一條都沒定下來）——是不是空的由呼叫方判。
 */
export function decodeLoreSettle(text: string, known?: LoreSettleKnown): LoreSettleDecode {
  const found = rowsOf(text);
  if (!found) {
    return { ok: false, message: '不是 {"entries":[…],"questions":[…]} 形狀的 JSON 物件' };
  }
  const warnings: string[] = [];
  const lookup = known ? createLoreLookup(known.entries) : undefined;
  const people = new Set((known?.people ?? []).map(normalizeLoreName).filter(Boolean));
  const rows = found.rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  // 這一批裡別的條目的名字：關鍵詞不許收（提到一條就命中兩條）。
  const batchTitles = rows.map(titleOf).filter(Boolean);
  const seen = new Set<string>();
  const used = new Set<string>();
  const entries: LoreDraft[] = [];

  for (const row of rows) {
    const named = titleOf(row);
    const key = normalizeLoreName(named);
    if (!key) {
      warnings.push('有一條沒寫名字，丟掉');
      continue;
    }
    if (seen.has(key)) {
      warnings.push(`「${named}」在這一批裡重複了，只留第一條`);
      continue;
    }
    seen.add(key);
    if (people.has(key)) {
      warnings.push(`「${named}」是角色卡上的人，人不是設定，丟掉`);
      continue;
    }
    if (entries.length >= LORE_SETTLE_LIMITS.entries) {
      warnings.push(`一次最多落定 ${LORE_SETTLE_LIMITS.entries} 條，「${named}」及之後的沒收，下一輪接著落`);
      break;
    }
    const draft = {
      relPath: str(row.relPath ?? row.path) || undefined,
      title: named,
      category: loreFolderOf(str(row.category ?? row.分类) || nameOf(row).category),
    };
    const existing = known ? findSettledEntry(known.entries, draft, lookup) : undefined;
    if (existing && used.has(existing.relPath)) {
      warnings.push(`「${named}」認成了已有條目「${existing.title}」，前面已經有一條改它了，只留第一條`);
      continue;
    }
    const body = decodeLoreBody(row, warnings, `「${named}」`);
    if (!body) {
      warnings.push(`「${named}」正文三節一節內容都沒有，丟掉`);
      continue;
    }
    if (existing && sameBody(body, existing.body)) {
      warnings.push(`「${existing.title}」的正文和原來一樣（討論沒改它），這一次不動它`);
      continue;
    }
    if (existing) {
      used.add(existing.relPath);
      if (normalizeLoreName(existing.title) !== key) {
        warnings.push(`「${named}」認成了已有條目「${existing.title}」（${existing.relPath}），按改它算`);
      }
    }
    const title = existing?.title ?? named;
    const rawBrief = str(row.brief ?? row.一句话 ?? row.简介);
    if (length(rawBrief) > LORE_ENTRY_LIMITS.brief) {
      warnings.push(`「${title}」的一句話超過 ${LORE_ENTRY_LIMITS.brief} 字，已截斷`);
    }
    entries.push({
      ...(existing ? { relPath: existing.relPath } : draft.relPath && !known ? { relPath: draft.relPath } : {}),
      title,
      category: existing?.category ?? draft.category,
      keywords: keywordsOf(row, title, existing, batchTitles, known),
      brief: clip(rawBrief, LORE_ENTRY_LIMITS.brief),
      body,
    });
  }
  const o = found.o ?? {};
  const questions = decodeLoreQuestions(o.questions ?? o.问题 ?? o.还没定的, warnings);
  return { ok: true, value: { entries, questions }, warnings };
}

/** 兩份正文是不是同一份：只比字，不比空白與換行。 */
function sameBody(a: string, b: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '');
  return squash(a) === squash(b);
}

/**
 * 關鍵詞：截長、去重、去掉與本條同名的，最多 {@link LORE_EXPAND_LIMITS}.keywords 個。有 `known` 時再過
 * `cleanLoreKeywords`：人名、別的條目的標題（已有的、這一批裡別的）、名錄裡另記著的名字都不要。
 */
function keywordsOf(
  row: Record<string, unknown>,
  title: string,
  existing: LoreEntry | undefined,
  batchTitles: readonly string[],
  known?: LoreSettleKnown
): string[] {
  const words = strings(row.keywords ?? row.关键词).map((k) => clip(k, LORE_LINE_LIMITS.name)).filter(Boolean);
  const self = normalizeLoreName(title);
  const cleaned = known
    ? cleanLoreKeywords(title, words, {
        titles: [
          ...known.entries.filter((e) => e.relPath !== existing?.relPath).map((e) => e.title),
          ...batchTitles.filter((t) => normalizeLoreName(t) !== self),
        ],
        people: known.people,
        recorded: known.recorded,
      })
    : [...new Set(words)].filter((w) => normalizeLoreName(w) !== self);
  return cleaned.slice(0, LORE_EXPAND_LIMITS.keywords);
}

/**
 * 規範化輸出：生成鏈最後交給氣泡的那一份，也是採納時重新解析的那一份。與合同同一個形狀，改已有條目的多一個
 * `relPath`——作者在氣泡裡改了再點寫入，走的是同一個 {@link decodeLoreSettle}。
 */
export function renderLoreSettle(value: LoreSettlement): string {
  return JSON.stringify(
    {
      entries: value.entries.map((e) => {
        const { visible, hidden } = splitLoreHidden(e.body);
        return {
          title: e.title,
          category: e.category,
          ...(e.relPath ? { relPath: e.relPath } : {}),
          keywords: e.keywords,
          brief: e.brief,
          body: { ...pickSections(visible, LORE_BODY_KEYS), [LORE_HIDDEN_KEY]: hidden },
        };
      }),
      questions: value.questions,
    },
    null,
    2
  );
}

/** 一條都沒定下來時交給氣泡的那一段：說清沒寫什麼，列出還沒定的（沒有卡片，作者接著聊）。 */
export function renderNothingSettled(questions: readonly string[]): string {
  return [
    '討論裡還沒有定下來的設定，這一次沒有可寫入的條目。',
    ...(questions.length > 0 ? ['', '還沒定的：', ...questions.map((q, i) => `${i + 1}. ${q}`)] : []),
  ].join('\n');
}

/** 氣泡文字 → `loreEntries` 產物的兩樣。解析不了是空的——採納時據此說「解析不出」，不寫任何東西。 */
export function parseLoreSettle(text: string): LoreSettlement {
  const decoded = decodeLoreSettle(text);
  return decoded.ok ? decoded.value : { entries: [], questions: [] };
}
