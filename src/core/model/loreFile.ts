import { traditionalLabel } from './labels';
/**
 * 設定的格式定義：細綱「設定」一節的一行一條、條目的一句話簡介與分類、怎麼認「同一個東西」。
 *
 * **純函式、零 I/O**，與 plotFile.ts / threadFile.ts 同類；條目的讀寫在 model/project.ts，
 * 名錄（誰出現在哪幾章、哪些還沒建條目）在 views/lore.ts。
 *
 * ## 兩處儲存，各管一件事
 *
 * - **每章出現了哪些設定** → 那一章細綱的「設定」一節（`Plot.lore`）。寫之前是計劃（這一章打算用到、
 *   要引入哪些），定稿後是實際（正文裡真出現的，以及這一章新確立的定義或規則）。名錄只認定稿過的，
 *   和出場人物同一個道理（第 14 條）。會變的狀態（誰拿走了、毀了沒）不在這裡記——照舊進連續性事實，
 *   名錄按條目的名字去那裡認，不保留兩份。
 * - **每個東西是什麼** → `lore/<分類>/<名>.md`，一條一份，作者可以手改。
 *
 * ## 分類就是目錄
 *
 * 條目所在目錄相對 `lore/` 的路徑就是它的分類，可以多層（`宗门/正道/青云宗.md` 的分類是
 * `宗門/正道`），根目錄下的是「未分類」。**沒有固定的分類表**：每本書自己的目錄樹就是它的分類表
 * （作者定案：每本書的分類不一樣）。不另設欄位，作者把檔案拖到別的目錄就是改分類，不會出現
 * 「欄位說 A、目錄說 B」兩份真相。「設定」一節裡的 `〔分類〕` 只是給還沒建條目的名字定去向用的建議。
 */
import { attachEvidence } from './continuity';
import { hasContent } from './markdown';
import type { LoreEntry } from './types';

/** 「設定」一節的小節名。 */
export const PLOT_LORE_KEY = '设定';

/** 「設定」一節一行的長度上限（字）與最多幾行。提示詞、解碼與解析共用這一份。 */
export const LORE_LINE_LIMITS = {
  lines: 12,
  name: 32,
  category: 40,
  note: 60,
} as const;

/**
 * 條目的字數上限（新增第 27 條：設定條目不能無限膨脹）。正文三節只是機器寫入時的格式，
 * 作者寫成什麼樣都照讀；整合、建條目的提示詞按這幾個數做減法。`body` 指明面三節合計，
 * 「暗設」另算（完善設定，2026-10-19）。
 */
export const LORE_ENTRY_LIMITS = {
  brief: 40,
  概要: 150,
  规则与边界: 250,
  现状: 150,
  body: 600,
  暗设: 200,
} as const;

/** 機器寫條目正文時用的三節（明面）。 */
export const LORE_BODY_KEYS = ['概要', '规则与边界', '现状'] as const;

/**
 * 展開一條設定（完善設定，2026-10-19）交回來的那幾樣的上限：關鍵詞幾個、建議拆出幾條子條目、附幾條還沒定的
 * 問題、一條問題多長。提示詞（context/loreExpandPrompt.ts）與解碼（features/loreExpand.ts）共用。條目本身的
 * 字數照 {@link LORE_ENTRY_LIMITS}（第 27 條）。
 */
export const LORE_EXPAND_LIMITS = {
  keywords: 8,
  children: 3,
  questions: 5,
  question: 60,
} as const;

/**
 * 落定設定（完善設定二期）一次最多寫幾條。討論裡定下的東西再多，一次也只落這麼多——多出來的丟掉、寫進說明，
 * 下一輪接著落。關鍵詞與問題的上限同 {@link LORE_EXPAND_LIMITS}，條目字數同 {@link LORE_ENTRY_LIMITS}（第 27 條）。
 */
export const LORE_SETTLE_LIMITS = {
  entries: 12,
} as const;

/**
 * 可選的第四節：讀者還不知道的真相（完善設定，2026-10-19）。規劃時（設定 / 大綱 / 細綱）帶，
 * 寫正文時不帶——揭開靠那一章的細綱。以它開頭的二級標題都認（`## 暗設`、`## 暗設（未揭示）`）。
 */
export const LORE_HIDDEN_KEY = '暗设';

/**
 * 規劃時（設定 / 大綱 / 細綱）暗設進上下文用的標題（不帶 `## `）：作者寫的是 `## 暗設` 還是 `## 暗設（未揭示）`，
 * 一律換成這一個，讓模型知道這一節是讀者還不知道的事。裝配（context/layers/render.ts 的 `loreBodyFor`）與
 * 細綱、大綱的提示詞（context/prompts.ts）共用，提示詞指的就是上下文裡寫著的那個標題。
 */
export const LORE_HIDDEN_MARK = `${traditionalLabel(LORE_HIDDEN_KEY)}（讀者還不知道）`;

/**
 * 工程頁「新建設定」寫進正文的那段佔位的開頭。認「還只有一句話」的條目（{@link loreThin}）
 * 要把它當空的，所以寫的地方（features/characters.ts）與認的地方共用這一份。
 */
export const LORE_PLACEHOLDER_PREFIX = '（在這裡寫這條設定';

const HIDDEN_HEADING = new RegExp(`^##(?!#)\\s*(?:${LORE_HIDDEN_KEY}|${traditionalLabel(LORE_HIDDEN_KEY)})`, 'u');
const ANY_HEADING = /^#{1,2}(?!#)\s*\S/u;

/**
 * 把條目正文拆成明面與暗設。暗設 = 以「暗設」開頭的二級標題，到下一個一、二級標題或文末為止；
 * 有幾節都收（按出現順序接起來）。`visible` 是去掉這些節之後的正文，`hidden` 是暗設的內容（不含標題）。
 * 作者寫成別的標題就當明面（第 1 條：認不出照常讀）。**絕不拋。**
 */
export function splitLoreHidden(body: string): { visible: string; hidden: string } {
  const visible: string[] = [];
  const hidden: string[] = [];
  let inHidden = false;
  for (const line of (body ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (HIDDEN_HEADING.test(trimmed)) {
      inHidden = true;
      continue;
    }
    if (inHidden && ANY_HEADING.test(trimmed)) {
      inHidden = false;
    }
    (inHidden ? hidden : visible).push(line);
  }
  return { visible: tidy(visible), hidden: tidy(hidden) };
}

/** 去掉首尾空行、把連著的空行併成一行。 */
function tidy(lines: string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 條目是不是「還只有一句話」（待完善）。三種：明面正文是空的（`empty`，含只剩一句話 `brief` 的）、
 * 是「新建設定」留下的佔位（`placeholder`）、三節都只寫著「（未交代）」（`untold`，設定清單起步時
 * 沒寫到的節）。都不是返回 `undefined`。**不按字數猜**——作者寫了兩行就是作者認為夠了。
 */
export type LoreThinKind = 'empty' | 'placeholder' | 'untold';

export function loreThin(entry: Pick<LoreEntry, 'body'>): LoreThinKind | undefined {
  const { visible } = splitLoreHidden(entry.body ?? '');
  if (!visible) {
    return 'empty';
  }
  if (visible.startsWith(LORE_PLACEHOLDER_PREFIX)) {
    return 'placeholder';
  }
  const content = visible
    .split(/\r?\n/)
    .map((raw) => raw.replace(LIST_MARKER, '').trim())
    .filter((line) => line && !/^#/.test(line));
  if (content.length === 0) {
    return 'empty';
  }
  return content.every((line) => UNTOLD.test(line)) ? 'untold' : undefined;
}

const UNTOLD = /^[（(]\s*未交代\s*[)）]$/u;

/**
 * 架構 · 設定清單起步時一條正文三節合計最多幾字：那是寫之前排的，現狀多半還沒交代，寫到了再從定稿裡
 * 整合（整合時的上限是 {@link LORE_ENTRY_LIMITS}.body）。提示詞與解碼共用。
 */
export const LORE_LIST_BODY_MAX = 300;

/** 「設定」一節的一行：`- 名〔分類〕：本章確立的定義或規則`。 */
export interface LoreLine {
  name: string;
  /** 分類路徑（`宗門/正道`），沒寫是空串。 */
  category: string;
  /** 冒號後面那句；只是出現、沒有新東西時是空串。 */
  note: string;
}

const LIST_MARKER = /^\s*(?:[-*·•]|\d+[.、)．])\s*/u;
const NOTHING = /^[（(]?\s*(?:(?:无|無)|(?:暂|暫)(?:无|無)|(?:没|沒)有|本章(?:无|無))\s*[)）]?$/u;
const BRACKETED = /^(.+?)\s*[〔【[]\s*([^〕】\]]*?)\s*[〕】\]]\s*(?:[：:]\s*(.*))?$/u;

/**
 * 讀回「設定」一節。**絕不拋**（第 1 條）：作者會手改，`〔〕` 寫成 `【】` `[]`、沒寫分類、冒號全形半形
 * 都認；認不出分類的整行就是名字（有冒號就切出說明）。同一個名字（歸一後）只留第一行。
 * 空行、佔位文字與「（無）」跳過。
 */
export function parseLoreLines(text: string): LoreLine[] {
  const out: LoreLine[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!hasContent(line) || NOTHING.test(line)) {
      continue;
    }
    let name: string;
    let category = '';
    let note = '';
    const m = BRACKETED.exec(line);
    if (m) {
      name = m[1];
      category = m[2];
      note = m[3] ?? '';
    } else {
      const at = line.search(/[：:]/u);
      name = at >= 0 ? line.slice(0, at) : line;
      note = at >= 0 ? line.slice(at + 1) : '';
    }
    const clipped = clipLine({ name, category, note });
    const key = normalizeLoreName(clipped.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(clipped);
  }
  return out;
}

/** 渲染「設定」一節。一行也沒有時寫「（無）」——標題在，表示這一章記過、只是沒有設定。 */
export function renderLoreLines(lines: readonly LoreLine[]): string {
  if (lines.length === 0) {
    return '（無）';
  }
  return lines
    .map((l) => `- ${l.name}${l.category ? `〔${l.category}〕` : ''}${l.note ? `：${l.note}` : ''}`)
    .join('\n');
}

/** 一行按上限截短，分類規範成 `a/b`。 */
export function clipLine(line: LoreLine): LoreLine {
  return {
    name: oneLine(line.name).slice(0, LORE_LINE_LIMITS.name),
    category: normalizeLoreCategory(line.category).slice(0, LORE_LINE_LIMITS.category),
    note: oneLine(line.note).slice(0, LORE_LINE_LIMITS.note),
  };
}

/**
 * 分類路徑的規範寫法：反斜槓、全形斜槓都當 `/`，每一段去掉首尾空白，空段丟掉。
 * 「未分類」與根目錄是同一件事，寫成空串。
 */
export function normalizeLoreCategory(value: string): string {
  const parts = (value ?? '')
    .replace(/[\\／]/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === '未分类' || value === '未分類') {
    return '';
  }
  return parts.join('/');
}

/** 條目的分類：slug（去掉副檔名的相對路徑）的目錄部分，根目錄下是空串。 */
export function loreCategoryOfSlug(slug: string): string {
  const at = slug.lastIndexOf('/');
  return at > 0 ? slug.slice(0, at) : '';
}

/**
 * 認「同一個東西」用的寫法：小寫，去掉空白、標點與符號。`青崖鎮` 與 `「青崖鎮」`、
 * `Qing Ya` 與 `qingya` 算同一個。
 */
export function normalizeLoreName(value: string): string {
  return (value ?? '').toLocaleLowerCase('zh-Hans-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 條目的一句話：frontmatter 的 `brief`，沒寫就取正文第一句（跳過小標題、列表記號與「暗設」那一節——
 * 一句話會進寫正文的上下文），截到 {@link LORE_ENTRY_LIMITS}.brief 字。名錄那一行與上下文裡「一行帶」都用它。
 */
export function loreBrief(entry: Pick<LoreEntry, 'brief' | 'body'>): string {
  const brief = oneLine(entry.brief ?? '');
  if (brief) {
    return brief.slice(0, LORE_ENTRY_LIMITS.brief);
  }
  for (const raw of splitLoreHidden(entry.body ?? '').visible.split(/\r?\n/)) {
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!hasContent(line) || /^#/.test(line)) {
      continue;
    }
    const first = line.split(/(?<=[。！？!?])/u)[0].trim();
    return first.slice(0, LORE_ENTRY_LIMITS.brief);
  }
  return '';
}

/** 名字表：一個名字（歸一後）→ 條目。 */
export interface LoreLookup {
  find(name: string): LoreEntry | undefined;
}

/**
 * 建「名字 → 條目」表。**兩趟**：先登記全部條目的標題，再登記關鍵詞，關鍵詞搶不走別人的標題
 * （與 views/cast.ts 的角色卡一樣）。同一個鍵先到先得。
 */
export function createLoreLookup(entries: readonly LoreEntry[]): LoreLookup {
  const byKey = new Map<string, LoreEntry>();
  for (const entry of entries) {
    const key = normalizeLoreName(entry.title);
    if (key && !byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  for (const entry of entries) {
    for (const keyword of entry.keywords) {
      const key = normalizeLoreName(keyword);
      if (key && !byKey.has(key)) {
        byKey.set(key, entry);
      }
    }
  }
  return { find: (name) => byKey.get(normalizeLoreName(name)) };
}

/**
 * 一段文字有沒有提到這個條目：標題或任一關鍵詞（至少兩個字）作為子串出現，不分大小寫。
 * 返回命中的那個詞，沒提到是 undefined。展開一條設定找用到它的句子、記設定時挑已有條目用它；連續性事實認條目、
 * 上下文關鍵詞命中要看別的名字，用 {@link loreMentionsIn}。
 */
export function loreMentionIn(text: string, entry: Pick<LoreEntry, 'title' | 'keywords'>): string | undefined {
  const haystack = (text ?? '').toLocaleLowerCase('zh-Hans-CN');
  for (const word of [entry.title, ...entry.keywords]) {
    const w = (word ?? '').trim();
    if (w.length >= 2 && haystack.includes(w.toLocaleLowerCase('zh-Hans-CN'))) {
      return w;
    }
  }
  return undefined;
}

/**
 * 一段文字提到了哪幾個條目，**最長匹配**（2026-10-25）：與 {@link loreMentionIn} 一樣按標題或關鍵詞（至少兩個字）認，
 * 但一個詞**每一處**都落在一個更長的別人的名字裡時不算——「潛入聖地秘境」裡的「秘境」不算提到「秘境」那一條，
 * 「這個秘境」「秘境的規矩」照算。別人的名字是別的條目的標題與關鍵詞，再加 `names`（名錄裡記著、還沒建條目的名字，
 * 本章細綱「設定」一節點的名字）。
 *
 * 從前一律按子串認：寫到後面，上位概念（「秘境」「魔法」）一提具體的東西就整條進上下文，擠掉具體那幾條；整合時
 * 連續性事實只要帶這兩個字就掛到上位概念名下，各個具體秘境的規則一條條並進去。裝配器的關鍵詞命中、名錄認連續性事實
 * 用它；返回條目 → 命中的那個詞，按 `entries` 的順序。
 */
export function loreMentionsIn<T extends Pick<LoreEntry, 'title' | 'keywords'>>(
  text: string,
  entries: readonly T[],
  names: readonly string[] = []
): Map<T, string> {
  const out = new Map<T, string>();
  const haystack = (text ?? '').toLocaleLowerCase('zh-Hans-CN');
  if (!haystack.trim()) {
    return out;
  }
  /** 文字裡每一處名字：從哪到哪、是哪一條的（名錄裡另記著的名字沒有 `owner`）。 */
  const spans: { start: number; end: number; owner?: T; word: string }[] = [];
  const find = (word: string, owner?: T): void => {
    const w = (word ?? '').trim();
    if (w.length < 2) {
      return;
    }
    const key = w.toLocaleLowerCase('zh-Hans-CN');
    for (let at = haystack.indexOf(key); at >= 0; at = haystack.indexOf(key, at + 1)) {
      spans.push({ start: at, end: at + key.length, owner, word: w });
    }
  };
  for (const entry of entries) {
    for (const word of [entry.title, ...entry.keywords]) {
      find(word, entry);
    }
  }
  for (const name of names) {
    find(name);
  }
  const covered = (s: (typeof spans)[number]): boolean =>
    spans.some((o) => o.owner !== s.owner && o.end - o.start > s.end - s.start && o.start <= s.start && s.end <= o.end);
  for (const entry of entries) {
    for (const word of [entry.title, ...entry.keywords]) {
      const w = (word ?? '').trim();
      if (spans.some((s) => s.owner === entry && s.word === w && !covered(s))) {
        out.set(entry, w);
        break;
      }
    }
  }
  return out;
}

/**
 * 機器寫進條目的關鍵詞過一遍（建條目、整合、設定清單）：**人名不要**（角色卡上的名字與別稱——
 * 真跑時模型把「沈懷山」寫成了「偽人」的關鍵詞，寫正文時一提到這個人就把「偽人」整條帶進來），
 * **別的條目的標題不要**（「青羊鎮」與「沈家老宅」互相寫進對方的關鍵詞，提到一個就命中兩條），
 * **名錄裡另記著的名字不要**（`recorded`：定稿時單獨記下、還沒建條目的。「魔法體系」把「寒冰鎖」收成
 * 關鍵詞，往後各章記下的「寒冰鎖」都被認成「魔法體系」，它永遠建不出自己的條目——舊的整本重掃就是
 * 這樣把幾十個法術並進了一條），一個字的不要（子串命中會到處撞），與本條標題重複的去掉。
 * 作者手寫的關鍵詞不經過這裡：作者認定兩個名字是同一個東西，自己加。
 */
export function cleanLoreKeywords(
  title: string,
  keywords: readonly string[],
  others: { titles: readonly string[]; people: readonly string[]; recorded?: readonly string[] }
): string[] {
  const self = normalizeLoreName(title);
  const banned = new Set(
    [...others.titles, ...others.people, ...(others.recorded ?? [])].map(normalizeLoreName).filter((k) => k && k !== self)
  );
  const out: string[] = [];
  const seen = new Set<string>([self]);
  for (const raw of keywords) {
    const word = oneLine(raw);
    const key = normalizeLoreName(word);
    if (Array.from(word).length < 2 || !key || seen.has(key) || banned.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(word);
  }
  return out;
}

function oneLine(value: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- 模型給的「設定」

/**
 * 模型輸出裡的「設定」欄位 → 一行一條。寫法五花八門都收（第 1 條）：
 * `[{name, category, fact}]`（`title` / `note` / `说明` 也認）、`["名〔分類〕：說明"]`、整段多行字串。
 * 定稿、單獨記設定、排細綱（`settings`）三處共用。
 */
export function loreLinesFromJson(value: unknown): LoreLine[] {
  if (typeof value === 'string') {
    return parseLoreLines(value);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: LoreLine[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let line: LoreLine | undefined;
    if (typeof item === 'string') {
      line = parseLoreLines(item)[0];
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const text = (v: unknown): string => (typeof v === 'string' ? v : '');
      line = clipLine({
        name: text(obj.name ?? obj.title ?? obj.名称 ?? obj.名字),
        category: text(obj.category ?? obj.分类),
        note: text(obj.fact ?? obj.note ?? obj.说明 ?? obj.事实),
      });
    }
    const key = line ? normalizeLoreName(line.name) : '';
    if (!line || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** 校驗時丟掉或改動的一行，寫進日誌（第 2 條）。 */
export interface LoreLineIssue {
  name: string;
  why: string;
}

/**
 * 定稿與單獨記設定寫進「設定」一節之前的校驗，**不調模型**：
 *
 * - 名字（已有條目時它的標題或任一關鍵詞）必須**逐字出現在正文裡**，否則整行丟——「設定」一節是名錄的
 *   唯一來源，模型編出來的名字會變成一條憑空的「未建條目」；
 * - 是角色卡上的人（名字或別名）就丟：人不是設定；
 * - 認得出已有條目的，名字換成條目的標題、分類換成條目所在的目錄（已建條目以實際目錄為準）；
 * - 說明要在正文裡找得到依據（與連續性事實同一套 `attachEvidence`），找不到就清空說明、留下名字；
 * - 最多 {@link LORE_LINE_LIMITS}.lines 行。
 */
export function verifyLoreLines(
  lines: readonly LoreLine[],
  content: string,
  known: { entries: readonly LoreEntry[]; people: readonly string[] }
): { lines: LoreLine[]; dropped: LoreLineIssue[]; cleared: LoreLineIssue[] } {
  const lookup = createLoreLookup(known.entries);
  const people = new Set(known.people.map(normalizeLoreName).filter(Boolean));
  const kept: LoreLine[] = [];
  const seen = new Set<string>();
  const dropped: LoreLineIssue[] = [];
  const cleared: LoreLineIssue[] = [];
  for (const raw of lines) {
    const line = clipLine(raw);
    const key = normalizeLoreName(line.name);
    if (!key) {
      continue;
    }
    if (people.has(key)) {
      dropped.push({ name: line.name, why: '是角色卡上的人' });
      continue;
    }
    const entry = lookup.find(line.name);
    const words = entry ? [line.name, entry.title, ...entry.keywords] : [line.name];
    if (!words.some((w) => w.trim() && content.includes(w.trim()))) {
      dropped.push({ name: line.name, why: '正文裡沒有這個名字' });
      continue;
    }
    const name = entry?.title ?? line.name;
    const dedupe = normalizeLoreName(name);
    if (seen.has(dedupe)) {
      continue;
    }
    let note = line.note;
    if (note && attachEvidence([note], content, words).facts.length === 0) {
      cleared.push({ name, why: `說明在正文裡找不到依據：${note}` });
      note = '';
    }
    if (kept.length >= LORE_LINE_LIMITS.lines) {
      dropped.push({ name, why: `超過 ${LORE_LINE_LIMITS.lines} 行` });
      continue;
    }
    seen.add(dedupe);
    kept.push({ name, category: entry ? entry.category : line.category, note });
  }
  return { lines: kept, dropped, cleared };
}
