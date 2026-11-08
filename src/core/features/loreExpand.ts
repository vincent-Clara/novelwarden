import { traditionalLabel } from '../model/labels';
/**
 * 展開一條設定（完善設定，2026-10-19）的解碼、規範化與氣泡往返。**純函式、絕不拋。**
 *
 * 合同（context/loreExpandPrompt.ts）：
 *
 * ```json
 * { "brief": "…", "keywords": ["…"],
 *   "body": { "概要": "…", "规则与边界": "…", "现状": "…", "暗设": "…" },
 *   "children": [{ "name": "…", "category": "…", "brief": "…" }],
 *   "questions": ["…"] }
 * ```
 *
 * 程式這一側的校驗不加呼叫（設計稿 §1「合同」）：一句話截 {@link LORE_ENTRY_LIMITS}.brief 字；明面三節按上限截
 * （合計 {@link LORE_ENTRY_LIMITS}.body，做法同設定清單的 `normalizeLoreBody`），暗設另截
 * {@link LORE_ENTRY_LIMITS}.暗設；新關鍵詞過 `cleanLoreKeywords`；`children` 丟掉名字已有條目的、是人名的、
 * 重名的，最多 {@link LORE_EXPAND_LIMITS}.children 條；`questions` 最多 {@link LORE_EXPAND_LIMITS}.questions 條、
 * 每條截 {@link LORE_EXPAND_LIMITS}.question 字。
 *
 * **解析不了就沒有產物**，不做全文兜底：條目被一段沒解析開的原文蓋掉，比沒寫更糟（同定稿）。
 *
 * ## 氣泡裡放的就是將要落盤的樣子
 *
 * 生成鏈（generation/structured.ts 的 `completeLoreExpand`）解碼之後把規範化結果交給氣泡
 * （{@link renderLoreExpansion}，與合同同一個形狀），採納時拿氣泡裡當下的文字重新解析（作者可能改過，
 * {@link parseLoreExpansion}）。往返不丟欄位：`questions` 也在裡面——它只上卡片，不寫進任何檔案
 * （generation/accept.ts 的 `acceptLoreEntries` 不讀它）。
 */
import { hasContent, pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_LINE_LIMITS,
  cleanLoreKeywords,
  createLoreLookup,
  normalizeLoreName,
  splitLoreHidden,
} from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import { loreFolderOf, normalizeLoreBody } from './loreList';
import { stripCodeFence, stripTrailingCommas } from './parse';
import { parseJson, singleJsonObject } from './structuredJson';

/**
 * 一條要落盤的設定（`loreEntries` 產物裡的一項）。展開時第一項是目標條目（帶 `relPath`，按路徑認、不按標題——
 * 展開不改名），其餘是建議拆出來的子條目（沒有 `relPath`，正文空著，落盤時建空條目）。
 */
export interface LoreDraft {
  /** 已有條目的工程相對路徑；要新建的沒有。 */
  relPath?: string;
  title: string;
  /** 分類（相對 `lore/` 的目錄）。目標條目以它實際所在的目錄為準，這裡是空串。 */
  category: string;
  keywords: string[];
  brief: string;
  /** 正文：明面三節，有暗設時最後一節是 `## 暗設`。子條目是空串。 */
  body: string;
}

/** 建議拆出來的一條子條目：只有名字、分類、一句話。 */
export interface LoreChild {
  name: string;
  category: string;
  brief: string;
}

/** 規範化之後的一份展開。 */
export interface LoreExpansion {
  brief: string;
  /** 模型這一次給的關鍵詞（已過濾），落盤時並進已有的（只增不減）。 */
  keywords: string[];
  /** 正文：明面三節 + 可選的 `## 暗設`。 */
  body: string;
  children: LoreChild[];
  questions: string[];
}

/** 解碼要對照的已有東西。不給就只做形狀上的校驗（採納時拿氣泡文字重新解析，那時不讀盤）。 */
export interface LoreExpandKnown {
  /** 目標條目的標題：子條目不許與它同名，關鍵詞裡去掉它。 */
  title: string;
  /** 全部條目（含目標條目）：子條目名字已有條目的丟掉；別的條目的標題不進關鍵詞。 */
  entries: readonly LoreEntry[];
  /** 角色卡上的名字與別稱：人不是設定，不進關鍵詞、不拆成子條目。 */
  people: readonly string[];
  /** 名錄裡另記著、還沒建條目的名字：不進關鍵詞（同建條目、整合）。 */
  recorded: readonly string[];
}

export type LoreExpandDecode =
  | { ok: true; value: LoreExpansion; warnings: string[] }
  | { ok: false; message: string };

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

/** 字串陣列；寫成一個字串時按 `sep` 拆開。 */
function strings(v: unknown, sep: RegExp): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(sep).map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * 最外層那個物件：整段就是 JSON → 唯一一個完整物件 → 去掉 `]` `}` 前多出來的逗號再試一次（模型最常見的
 * 語法錯，不改任何值，不必為它調一次模型）。都不行返回 undefined。展開與落定設定共用（`loreJsonObject`）。
 */
export function loreJsonObject(text: string): Record<string, unknown> | undefined {
  const whole = parseJson(text);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    return whole as Record<string, unknown>;
  }
  const single = singleJsonObject(text);
  if (single.ok) {
    return single.value;
  }
  const fixed = parseJson(stripTrailingCommas(stripCodeFence(text)));
  return fixed && typeof fixed === 'object' && !Array.isArray(fixed) ? (fixed as Record<string, unknown>) : undefined;
}

/** 模型沒包一層 `body`、直接把幾節寫成頂層欄位時（`{brief, 概要, 規則與邊界, …}`）。 */
function bodyValueOf(o: Record<string, unknown>): unknown {
  if (o.body !== undefined) {
    return o.body;
  }
  if (o.content !== undefined) {
    return o.content;
  }
  return LORE_BODY_KEYS.some((k) => o[k] !== undefined) ? o : undefined;
}

/** 一節的文字：陣列按行接起來。 */
function sectionText(v: unknown): string {
  return Array.isArray(v) ? v.map(str).filter(Boolean).join('\n') : str(v);
}

/**
 * 正文拆成明面與暗設：給成物件按鍵取（暗設認 `暗设` / `hidden`，也認寫在頂層的），給成 Markdown 按
 * 「暗設」開頭的二級標題切（`splitLoreHidden`，與條目的認法同一份）。
 */
function splitBody(value: unknown, o: Record<string, unknown>): { visible: unknown; hidden: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const b = value as Record<string, unknown>;
    const hidden = sectionText(b[LORE_HIDDEN_KEY] ?? b.hidden ?? o[LORE_HIDDEN_KEY] ?? o.hidden);
    return { visible: b, hidden };
  }
  const text = sectionText(value);
  const split = splitLoreHidden(text);
  return { visible: split.visible, hidden: split.hidden || sectionText(o[LORE_HIDDEN_KEY] ?? o.hidden) };
}

/** 「（未交代）」「無」「沒有」這類寫法當沒有暗設。 */
const NO_HIDDEN = /^[（(]?\s*(?:未交代|(?:无|無)|(?:暂|暫)(?:无|無)|(?:没|沒)有|空)\s*[)）]?$/u;

/**
 * 解碼一份展開。`known` 給了就按磁碟上的東西過濾（生成鏈裡那一次）；不給只做形狀上的校驗與截斷
 * （採納時拿氣泡文字重新解析）。明面三節一節內容都沒有算解析不了。
 */
export function decodeLoreExpansion(text: string, known?: LoreExpandKnown): LoreExpandDecode {
  const o = loreJsonObject(text);
  if (!o) {
    return { ok: false, message: '不是 {"brief","keywords","body",…} 形狀的 JSON 物件' };
  }
  const warnings: string[] = [];
  const body = decodeLoreBody(o, warnings);
  if (!body) {
    return { ok: false, message: '正文三節（概要 / 規則與邊界 / 現狀）一節內容都沒有' };
  }

  const rawBrief = str(o.brief ?? o.一句话 ?? o.简介);
  if (length(rawBrief) > LORE_ENTRY_LIMITS.brief) {
    warnings.push(`一句話超過 ${LORE_ENTRY_LIMITS.brief} 字，已截斷`);
  }
  const brief = clip(rawBrief, LORE_ENTRY_LIMITS.brief);

  const children = decodeChildren(o.children ?? o.子条目 ?? o.split, known, warnings);
  const keywords = decodeKeywords(strings(o.keywords ?? o.关键词, /[,，、]/), children, known);
  const questions = decodeLoreQuestions(o.questions ?? o.问题 ?? o.还没定的, warnings);
  return { ok: true, value: { brief, keywords, body, children, questions }, warnings };
}

/**
 * 一條的正文：明面三節按上限截（合計 {@link LORE_ENTRY_LIMITS}.body，做法同設定清單的 `normalizeLoreBody`），
 * 暗設另截 {@link LORE_ENTRY_LIMITS}.暗設，有就接在最後一節 `## 暗設`。明面一節內容都沒有返回空串。截了什麼寫進
 * `warnings`，`who` 是字首（落定設定一次好幾條，說清是哪一條）。展開與落定設定（features/loreSettle.ts）共用。
 */
export function decodeLoreBody(o: Record<string, unknown>, warnings: string[], who = ''): string {
  const { visible, hidden: rawHidden } = splitBody(bodyValueOf(o), o);
  const { body: visibleBody, clipped } = normalizeLoreBody(visible, LORE_ENTRY_LIMITS.body);
  if (!visibleBody) {
    return '';
  }
  if (clipped) {
    warnings.push(
      `${who}正文超長，已截斷（每節不超過 ${LORE_BODY_KEYS.map((k) => LORE_ENTRY_LIMITS[k]).join(' / ')} 字，合計不超過 ${LORE_ENTRY_LIMITS.body} 字）`
    );
  }
  const hiddenText = hasContent(rawHidden) && !NO_HIDDEN.test(rawHidden.trim()) ? rawHidden.trim() : '';
  const hidden = Array.from(hiddenText).slice(0, LORE_ENTRY_LIMITS.暗设).join('').trim();
  if (hidden.length < hiddenText.length) {
    warnings.push(`${who}暗設超過 ${LORE_ENTRY_LIMITS.暗设} 字，已截斷`);
  }
  return hidden ? `${visibleBody}\n\n## ${traditionalLabel(LORE_HIDDEN_KEY)}\n${hidden}` : visibleBody;
}

/**
 * 關鍵詞：截長、去重、去掉與本條同名的，最多 {@link LORE_EXPAND_LIMITS}.keywords 個。有 `known` 時再過
 * `cleanLoreKeywords`：人名、別的條目的標題（含這一次建議拆出去的子條目——那是別的東西）、名錄裡另記著的名字都不要。
 */
function decodeKeywords(raw: readonly string[], children: readonly LoreChild[], known?: LoreExpandKnown): string[] {
  const words = raw.map((k) => clip(k, LORE_LINE_LIMITS.name)).filter(Boolean);
  const title = known?.title ?? '';
  const cleaned = known
    ? cleanLoreKeywords(title, words, {
        titles: [...known.entries.filter((e) => normalizeLoreName(e.title) !== normalizeLoreName(title)).map((e) => e.title), ...children.map((c) => c.name)],
        people: known.people,
        recorded: known.recorded,
      })
    : [...new Set(words)];
  return cleaned.slice(0, LORE_EXPAND_LIMITS.keywords);
}

/**
 * 子條目：只收名字、分類、一句話。名字截長；與本條同名的、重名的丟掉；有 `known` 時名字（或關鍵詞）已被
 * 已有條目佔了的、是角色卡上的人的也丟掉（落盤時按磁碟再認一遍）。最多 {@link LORE_EXPAND_LIMITS}.children 條。
 */
function decodeChildren(raw: unknown, known: LoreExpandKnown | undefined, warnings: string[]): LoreChild[] {
  const rows = Array.isArray(raw) ? raw : [];
  const lookup = known ? createLoreLookup(known.entries) : undefined;
  const people = new Set((known?.people ?? []).map(normalizeLoreName).filter(Boolean));
  const self = normalizeLoreName(known?.title ?? '');
  const seen = new Set<string>();
  const out: LoreChild[] = [];
  for (const row of rows) {
    const c = row && typeof row === 'object' ? (row as Record<string, unknown>) : typeof row === 'string' ? { name: row } : undefined;
    const name = clip(str(c?.name ?? c?.title ?? c?.名称 ?? c?.名字), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(name);
    if (!c || !key || key === self || seen.has(key)) {
      continue;
    }
    if (people.has(key)) {
      warnings.push(`建議拆出的「${name}」是角色卡上的人，人不是設定，丟掉`);
      continue;
    }
    if (lookup?.find(name)) {
      warnings.push(`建議拆出的「${name}」已經有條目了（${lookup.find(name)!.title}），不另建`);
      continue;
    }
    seen.add(key);
    if (out.length >= LORE_EXPAND_LIMITS.children) {
      warnings.push(`建議拆出的子條目超過 ${LORE_EXPAND_LIMITS.children} 條，「${name}」及之後的沒收`);
      break;
    }
    out.push({
      name,
      category: loreFolderOf(str(c.category ?? c.分类)),
      brief: clip(str(c.brief ?? c.一句话 ?? c.简介), LORE_ENTRY_LIMITS.brief),
    });
  }
  return out;
}

/**
 * 還沒定的問題：一條一行，去重，每條截 {@link LORE_EXPAND_LIMITS}.question 字，最多 {@link LORE_EXPAND_LIMITS}.questions 條。
 * 展開與落定設定共用。
 */
export function decodeLoreQuestions(raw: unknown, warnings: string[]): string[] {
  // 問題裡常有逗號，寫成一個字串時只按換行拆。
  const list = strings(raw, /\n+/).map((q) => q.replace(/^\s*(?:[-*·•]|\d+[.、)．])\s*/u, ''));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of list) {
    const text = clip(q, LORE_EXPAND_LIMITS.question);
    const key = normalizeLoreName(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(text);
  }
  if (out.length > LORE_EXPAND_LIMITS.questions) {
    warnings.push(`還沒定的問題有 ${out.length} 條，只留前 ${LORE_EXPAND_LIMITS.questions} 條`);
  }
  return out.slice(0, LORE_EXPAND_LIMITS.questions);
}

/**
 * 規範化輸出：生成鏈最後交給氣泡的那一份，也是採納時重新解析的那一份。與合同同一個形狀——作者在氣泡裡改了
 * 再點寫入，走的是同一個 {@link decodeLoreExpansion}。
 */
export function renderLoreExpansion(e: LoreExpansion): string {
  const { visible, hidden } = splitLoreHidden(e.body);
  const sections = pickSections(visible, LORE_BODY_KEYS);
  return JSON.stringify(
    {
      brief: e.brief,
      keywords: e.keywords,
      body: { ...sections, [LORE_HIDDEN_KEY]: hidden },
      children: e.children,
      questions: e.questions,
    },
    null,
    2
  );
}

/**
 * 氣泡文字 → `loreEntries` 產物的兩樣：目標條目在第一項（按 `relPath` 認，標題取檔名，落盤時以磁碟上的
 * 標題為準），其餘是子條目（關鍵詞就是名字本身，正文空著）。解析不了是空的——採納時據此說「解析不出」，
 * 不寫任何東西。
 */
export function parseLoreExpansion(text: string, relPath: string): { entries: LoreDraft[]; questions: string[] } {
  const decoded = decodeLoreExpansion(text);
  if (!decoded.ok) {
    return { entries: [], questions: [] };
  }
  const { value } = decoded;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
  return {
    entries: [
      { relPath, title: base, category: '', keywords: value.keywords, brief: value.brief, body: value.body },
      ...value.children.map((c) => ({ title: c.name, category: c.category, keywords: [c.name], brief: c.brief, body: '' })),
    ],
    questions: value.questions,
  };
}
