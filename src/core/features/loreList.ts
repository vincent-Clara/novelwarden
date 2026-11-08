import { traditionalLabel } from '../model/labels';
/**
 * 設定清單（架構第五件，設定名錄）的兩段式解碼：先是一張**清單**（本書的分類目錄樹 + 每條的名字、
 * 分類、關鍵詞、一句話），再按凍結的清單每批 6 條補**正文**，最後拼成一條條設定條目。
 *
 * **純函式、絕不拋**。路子與角色圖譜（features/roster.ts）一樣：
 *
 * ## 為什麼分兩步
 *
 * 一次要三十條設定的全部正文，輸出長到一定會被截斷；而且分類、名字在長輸出裡前後不一（前面叫
 * 「青雲宗」、後面叫「青雲門」）。先凍結一張清單——分類與名字只在清單裡定一次——詳情那一步**不許**
 * 增刪條目、改名換分類，只補每一條自己的正文。
 *
 * ## 分類是這本書自己的目錄樹
 *
 * 沒有固定的分類表（作者定案）：清單第一步按題材排出 `categories`，落盤時建成 `lore/` 下的目錄（空的
 * 也建，作者看得到分類表）。本書已經有目錄的，提示詞要求照用、只補缺的。條目的 `category` 不在
 * `categories` 裡的照收、補進目錄樹並說明；是空的放根目錄（未分類）。
 *
 * ## 比合同寬鬆的地方
 *
 * 只有「清單裡一條能用的都沒有」才算失敗。條數不在 12–30、分類不在表裡、某條正文沒出來、超長——都照收
 * 並寫進 `warnings`，落盤卡片上列出來。超過 30 條只留前 30 條：呼叫次數是按 30 條報給作者的（第 4 條）。
 * 人名不是設定：清單裡撞上角色卡上的名字或別稱的丟掉（提示詞說一遍，這裡再過一遍）。
 */
import { sanitizeFileName } from '../model/fs';
import { hasContent, pickSections } from '../model/markdown';
import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_LINE_LIMITS,
  LORE_LIST_BODY_MAX,
  createLoreLookup,
  normalizeLoreCategory,
  normalizeLoreName,
} from '../model/loreFile';
import { LORE_LIST_MAX } from '../model/pipeline';
import type { LoreEntry } from '../model/types';
import { parseJson, singleJsonObject } from './structuredJson';

/** 設定清單裡的一條。落盤時變成一條設定條目。 */
export interface LoreListEntry {
  title: string;
  /** 分類路徑（`宗門/正道`），根目錄（未分類）是空串。 */
  category: string;
  keywords: string[];
  brief: string;
  /** 正文三節（`## 概要` / `## 規則與邊界` / `## 現狀`）。沒生成出來是空串。 */
  body: string;
}

/** 清單裡的一條（還沒有正文）。 */
export type LoreListSlot = Omit<LoreListEntry, 'body'>;

/** 解碼要對照的已有東西：本書的目錄樹、已有條目（照抄名字）、角色卡上的人（不進設定）。 */
export interface LoreListKnown {
  categories: readonly string[];
  entries: readonly LoreEntry[];
  people: readonly string[];
}

export type LoreManifestDecode =
  | { ok: true; categories: string[]; slots: LoreListSlot[]; warnings: string[] }
  | { ok: false; message: string };

/** 分類目錄最多幾層（與「按目錄整理」同一個數）。 */
const CATEGORY_DEPTH = 3;
/** 一條最多幾個關鍵詞。 */
const KEYWORDS_MAX = 8;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function objectOf(text: string): Record<string, unknown> | undefined {
  const whole = parseJson(text);
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    return whole as Record<string, unknown>;
  }
  const single = singleJsonObject(text);
  return single.ok ? single.value : undefined;
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter(Boolean);
  }
  const s = str(v);
  return s ? s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : [];
}

function clip(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

/**
 * 分類寫法規範成能當目錄用的路徑：`/` 分段、每段是合法的資料夾名、最多 {@link CATEGORY_DEPTH} 層。
 * 全是非法字元的段丟掉；「未分類」與空串都是根目錄。
 */
export function loreFolderOf(value: string): string {
  return normalizeLoreCategory(value)
    .split('/')
    .filter(Boolean)
    .map((part) => sanitizeFileName(part))
    .filter((part) => part !== '未命名' && !part.startsWith('.'))
    .slice(0, CATEGORY_DEPTH)
    .join('/');
}

/**
 * 清單 `{"categories":[…],"entries":[{title,category,keywords,brief}]}`。
 *
 * - `categories` 規範成目錄路徑，重複的去掉；本書已有的照收（不另報）。一級分類不在 3–8 個時說一聲。
 * - 已有條目（按標題、再按關鍵詞認）的名字換成條目的標題、分類換成它實際所在的目錄——已建條目以
 *   實際目錄為準。
 * - 同一個名字只收第一條；撞上角色卡上的人的丟掉；超過 {@link LORE_LIST_MAX} 條只留前面的。
 */
export function decodeLoreManifest(text: string, known: LoreListKnown): LoreManifestDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings ?? obj?.lore ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  if (!Array.isArray(rows)) {
    return { ok: false, message: '設定清單不是 {"categories":[…],"entries":[…]} 的形狀' };
  }
  const warnings: string[] = [];
  const categories: string[] = [];
  const addCategory = (value: string): void => {
    if (value && !categories.includes(value)) {
      categories.push(value);
    }
  };
  for (const raw of strings(obj?.categories ?? obj?.分类)) {
    const folder = loreFolderOf(raw);
    if (!folder) {
      warnings.push(`分類「${raw}」當不了目錄名，丟掉`);
      continue;
    }
    addCategory(folder);
  }

  const lookup = createLoreLookup(known.entries);
  const people = new Set(known.people.map(normalizeLoreName).filter(Boolean));
  const existing = new Set(known.categories);
  const seen = new Set<string>();
  const slots: LoreListSlot[] = [];
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i] && typeof rows[i] === 'object' ? (rows[i] as Record<string, unknown>) : undefined;
    const name = clip(str(o?.title ?? o?.name ?? o?.名称), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(name);
    if (!o || !key) {
      warnings.push(`設定清單第 ${i + 1} 項沒有名字，跳過`);
      continue;
    }
    if (people.has(key)) {
      warnings.push(`「${name}」是角色卡上的人，人不是設定，丟掉`);
      continue;
    }
    const entry = lookup.find(name);
    const title = entry?.title ?? name;
    const dedupe = normalizeLoreName(title);
    if (seen.has(dedupe)) {
      warnings.push(`設定清單裡「${title}」出現了不止一次，只收第一條`);
      continue;
    }
    if (slots.length >= LORE_LIST_MAX) {
      warnings.push(`設定清單超過 ${LORE_LIST_MAX} 條，「${title}」及之後的沒收`);
      break;
    }
    seen.add(dedupe);
    let category: string;
    if (entry) {
      category = entry.category;
    } else {
      const rawCategory = str(o.category ?? o.分类);
      category = loreFolderOf(rawCategory);
      if (!category) {
        warnings.push(`「${title}」沒寫分類，放在設定根目錄（未分類）`);
      } else if (!categories.includes(category) && !existing.has(category)) {
        warnings.push(`「${title}」的分類「${category}」不在 categories 裡，按新目錄建`);
        addCategory(category);
      }
    }
    const brief = str(o.brief ?? o.一句话 ?? o.简介);
    if (Array.from(brief).length > LORE_ENTRY_LIMITS.brief) {
      warnings.push(`「${title}」的一句話超過 ${LORE_ENTRY_LIMITS.brief} 字，已截斷`);
    }
    const keywords = [
      ...new Set(
        strings(o.keywords ?? o.关键词)
          .map((k) => clip(k, LORE_LINE_LIMITS.name))
          .filter((k) => k && normalizeLoreName(k) !== dedupe && !people.has(normalizeLoreName(k)))
      ),
    ].slice(0, KEYWORDS_MAX);
    slots.push({ title, category, keywords, brief: clip(brief, LORE_ENTRY_LIMITS.brief) });
  }
  if (slots.length === 0) {
    return { ok: false, message: '設定清單裡一條能用的都沒有' };
  }
  // 一級分類按本書已有的加上這一次新排的數：已有目錄的書，模型照合同只補缺的那幾個。
  const top = new Set([...known.categories, ...categories].map((c) => c.split('/')[0]));
  if (top.size < 3 || top.size > 8) {
    warnings.push(`一級分類有 ${top.size} 個，合同要求 3–8 個`);
  }
  if (slots.length < 12) {
    warnings.push(`設定清單有 ${slots.length} 條，合同要求 12–${LORE_LIST_MAX} 條`);
  }
  return { ok: true, categories, slots, warnings };
}

/** 一條的正文（詳情那一步交回來的）。 */
export interface LoreDetail {
  title: string;
  body: string;
}

export type LoreDetailsDecode =
  | { ok: true; items: LoreDetail[]; warnings: string[] }
  | { ok: false; message: string };

/**
 * 一批詳情 `{"entries":[{title, body}]}`。
 *
 * 只認這一批該有的名字（歸一後對上），清單外的丟掉並說明（清單是凍結的，詳情那一步不許加條目）。
 * `body` 給成三節 Markdown 或 `{概要, 規則與邊界, 現狀}` 物件都收，規範成三節、超長截斷
 * （{@link normalizeLoreBody}）。整段解不出來才算失敗——交給生成鏈拆半重試。
 */
export function decodeLoreDetails(text: string, batch: readonly LoreListSlot[]): LoreDetailsDecode {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings;
  if (!Array.isArray(rows)) {
    return { ok: false, message: '設定詳情不是 {"entries":[…]} 的形狀' };
  }
  const warnings: string[] = [];
  const wanted = new Map(batch.map((s) => [normalizeLoreName(s.title), s]));
  const items: LoreDetail[] = [];
  for (const row of rows) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    if (!o) {
      continue;
    }
    const name = str(o.title ?? o.name);
    const slot = wanted.get(normalizeLoreName(name));
    if (!slot) {
      warnings.push(`詳情裡多出一條清單外的「${name || '（沒有名字）'}」，丟掉`);
      continue;
    }
    if (items.some((d) => d.title === slot.title)) {
      continue;
    }
    const { body, clipped } = normalizeLoreBody(o.body ?? o.content ?? pickBodyFields(o));
    if (clipped) {
      warnings.push(
        `「${slot.title}」的正文超長，已截斷（每節不超過 ${LORE_BODY_KEYS.map((k) => LORE_ENTRY_LIMITS[k]).join(' / ')} 字，合計不超過 ${LORE_LIST_BODY_MAX} 字）`
      );
    }
    if (body) {
      items.push({ title: slot.title, body });
    }
  }
  return { ok: true, items, warnings };
}

/** 模型沒包一層 `body`、直接把三節寫成欄位時（`{title, 概要, 規則與邊界, 現狀}`）。 */
function pickBodyFields(o: Record<string, unknown>): Record<string, unknown> | undefined {
  return LORE_BODY_KEYS.some((k) => o[k] !== undefined) ? o : undefined;
}

/**
 * 正文規範成三節：`## 概要` / `## 規則與邊界` / `## 現狀`。給成物件按鍵取，給成 Markdown 按小節取，
 * 一個小節都認不出的整段當「概要」。每節不超過條目的上限（{@link LORE_ENTRY_LIMITS}），三節合計不超過
 * `max` 字（預設 {@link LORE_LIST_BODY_MAX}，設定清單起步時的數；展開一條設定給 `LORE_ENTRY_LIMITS.body`）——
 * 超了從超出的那一節起截掉。空著的節寫「（未交代）」：起步時不必寫滿，節在，作者一眼看得出這裡還沒東西。
 * 三節全空就是空串。
 */
export function normalizeLoreBody(value: unknown, max: number = LORE_LIST_BODY_MAX): { body: string; clipped: boolean } {
  const sections: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const key of LORE_BODY_KEYS) {
      sections[key] = Array.isArray(o[key]) ? (o[key] as unknown[]).map(str).filter(Boolean).join('\n') : str(o[key]);
    }
  } else {
    const text = Array.isArray(value) ? value.map(str).filter(Boolean).join('\n') : str(value);
    const picked = pickSections(text, LORE_BODY_KEYS);
    const any = LORE_BODY_KEYS.some((k) => picked[k]?.trim());
    for (const key of LORE_BODY_KEYS) {
      sections[key] = any ? (picked[key] ?? '').trim() : key === '概要' ? text.replace(/^#+\s.*$/gm, '').trim() : '';
    }
  }
  if (!LORE_BODY_KEYS.some((k) => hasContent(sections[k]))) {
    return { body: '', clipped: false };
  }
  let left = max;
  let clipped = false;
  const parts = LORE_BODY_KEYS.map((key) => {
    const chars = Array.from(hasContent(sections[key]) ? sections[key].trim() : '');
    const max = Math.min(LORE_ENTRY_LIMITS[key], left);
    if (chars.length > max) {
      clipped = true;
    }
    const kept = chars.slice(0, Math.max(0, max)).join('').trim();
    left -= Array.from(kept).length;
    return `## ${traditionalLabel(key)}\n${kept || '（未交代）'}`;
  });
  return { body: parts.join('\n\n'), clipped };
}

/**
 * 清單 + 詳情 → 條目。詳情缺席的條目照樣建（只有一句話），並記一條 warning——與角色圖譜
 * 「某人詳情沒出來照樣按清單建卡」同一個口徑。
 */
export function assembleLoreList(
  slots: readonly LoreListSlot[],
  details: readonly LoreDetail[]
): { entries: LoreListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byTitle = new Map(details.map((d) => [d.title, d.body]));
  const entries = slots.map((slot) => {
    const body = byTitle.get(slot.title) ?? '';
    if (!body) {
      warnings.push(`「${slot.title}」的正文沒有生成出來，只按清單建條目（一句話），寫到了再整合`);
    }
    return { ...slot, body };
  });
  return { entries, warnings };
}

/**
 * 規範化輸出：`{"categories":[…],"entries":[{title,category,keywords,brief,body}]}`。生成鏈最後交給氣泡的
 * 那一份，也是採納時重新解析的那一份（artifact.ts 的 `parseLoreList` 認得它）。
 */
export function renderLoreList(categories: readonly string[], entries: readonly LoreListEntry[]): string {
  return JSON.stringify(
    {
      categories,
      entries: entries.map((e) => ({
        title: e.title,
        category: e.category,
        keywords: e.keywords,
        brief: e.brief,
        ...(e.body ? { body: e.body } : {}),
      })),
    },
    null,
    2
  );
}

/**
 * 採納時讀回來（規範化輸出，或者模型第一次呼叫的原樣清單——agent 那條路、老會話）。寬鬆收：
 * 沒寫 `categories` 就從條目的分類裡收；同名只留第一條；正文按 {@link normalizeLoreBody} 規範。
 * 認不出就是空的。
 */
export function parseLoreList(text: string): { categories: string[]; entries: LoreListEntry[] } {
  const obj = objectOf(text);
  const rows = obj?.entries ?? obj?.settings ?? obj?.lore ?? (Array.isArray(parseJson(text)) ? parseJson(text) : undefined);
  const categories: string[] = [];
  const add = (c: string): void => {
    if (c && !categories.includes(c)) {
      categories.push(c);
    }
  };
  strings(obj?.categories ?? obj?.分类).map(loreFolderOf).forEach(add);
  const entries: LoreListEntry[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    const title = clip(str(o?.title ?? o?.name ?? o?.名称), LORE_LINE_LIMITS.name);
    const key = normalizeLoreName(title);
    if (!o || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const category = loreFolderOf(str(o.category ?? o.分类));
    add(category);
    entries.push({
      title,
      category,
      keywords: [...new Set(strings(o.keywords ?? o.关键词))].filter((k) => normalizeLoreName(k) !== key),
      brief: clip(str(o.brief ?? o.一句话 ?? o.简介), LORE_ENTRY_LIMITS.brief),
      body: normalizeLoreBody(o.body ?? o.content ?? pickBodyFields(o)).body,
    });
  }
  return { categories, entries };
}
