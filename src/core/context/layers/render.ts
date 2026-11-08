import { traditionalLabel } from '../../model/labels';
import { exists, readText } from '../../model/fs';
import { takeLast } from '../../model/contextDetail';
import { hasContent, stringifySections } from '../../model/markdown';
import { plotLabel } from '../../model/pipeline';
import { Plot, PLOT_SECTION_KEYS, sectionItems } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Attachment } from '../../model/session';
import {
  CHARACTER_ESSENTIAL_KEYS,
  CHARACTER_HIDDEN_KEY,
  CHARACTER_SECTION_KEYS,
  CharacterCard,
  CharacterSections,
  LoreEntry,
} from '../../model/types';
import { LORE_HIDDEN_MARK, PLOT_LORE_KEY, loreBrief, renderLoreLines, splitLoreHidden } from '../../model/loreFile';
import type { Focus } from './focus';

/**
 * 本章自己的細綱（`plotSelf`）。「設定」一節只在這裡帶：這一章打算引入什麼、用到什麼，寫的人要知道；
 * 前幾章細綱、細綱一覽、全文大綱的輸入都不帶它，免得幾十章的細綱一起變長。
 */
export function renderPlot(plot: Plot): string {
  const head = `【${plotLabel(plot.no, plot.title)} · 細綱】`;
  const lore = plot.lore?.length ? `\n\n## ${traditionalLabel(PLOT_LORE_KEY)}\n\n${renderLoreLines(plot.lore)}` : '';
  return `${head}\n${renderPlotSections(plot) || '（尚未填寫）'}${lore}`;
}

/** 細綱有內容的那幾節，`## 小節` 一節一段。一節都沒填是空串。 */
export function renderPlotSections(plot: Plot): string {
  return stringifySections(plot.sections as unknown as Record<string, string>, PLOT_SECTION_KEYS as readonly string[]);
}

/**
 * 前後章只注入幾節——夠讓排這一章的人知道上文停在哪個局面、下文要接到哪：
 * 上文給「梗概 / 關鍵事件 / 狀態變更」（發生了什麼、人物落在什麼處境），下文給
 * 「梗概 / 關鍵事件」（要去哪、要發生什麼）。其餘幾節是那一章自己的賬，
 * 攤在這裡只會擠掉本章的預算，還容易被誤當成本章要處理的東西。
 */
export function renderPlotBrief(plot: Plot, relation: '上文' | '下文', tag?: string): string {
  const lines = [`【${plotLabel(plot.no, plot.title)} · ${relation}${tag ? ` · ${tag}` : ''}】`];
  const keys = relation === '上文' ? (['梗概', '关键事件', '状态变更'] as const) : (['梗概', '关键事件'] as const);
  for (const key of keys) {
    const value = plot.sections[key]?.trim();
    if (value) {
      lines.push(labeledSection(key, value));
    }
  }
  return lines.join('\n');
}

/**
 * 「小節：內容」一行。內容是一條一行的列表（關鍵事件、看點……）時另起一行照原樣列，
 * 不然第一條會擠在冒號後面（「關鍵事件：- 甲」）；只有一條就去掉列表記號接在冒號後面。
 */
export function labeledSection(key: string, value: string): string {
  const v = value.trim();
  if (v.includes('\n')) {
    return `${traditionalLabel(key)}：\n${v}`;
  }
  return `${traditionalLabel(key)}：${sectionItems(v)[0] ?? v}`;
}

/** 本層產物的文字，供設定關鍵詞匹配。 */
export function focusText(focus: Focus): string {
  const parts: string[] = [];
  if (focus.plot) {
    parts.push(...Object.values(focus.plot.sections));
  }
  return parts.filter(Boolean).join('\n');
}

/** 設定名後面的 `〔分類〕`（分類就是目錄，根目錄下的不寫）。 */
function loreHead(entry: LoreEntry): string {
  return `${entry.title}${entry.category ? `〔${entry.category}〕` : ''}`;
}

/**
 * 寫正文時去掉了一條設定（或一張角色卡）的暗設，明細裡注的那一句（第 2 條）。lore 層、`characters` 層與 @ 引用共用。
 */
export const LORE_HIDDEN_DROPPED_NOTE = '暗設沒帶：寫正文不帶讀者還不知道的事，要讓這一章揭開就寫進本章細綱';

/**
 * 條目正文按場合處理「暗設」那一節（完善設定，2026-10-19）：
 *
 * - 寫正文（`withHidden: false`）：只帶明面（`splitLoreHidden` 的 `visible`）。寫正文字來不需要知道真相，
 *   需要的鋪墊細綱裡已經寫了；帶上了，正文模型看見就容易說漏。`dropped` 告訴呼叫方有沒有真去掉東西，
 *   去掉了要在明細裡注一句（第 2 條）。
 * - 規劃時（設定 / 大綱 / 細綱）：整份帶，暗設挪到最後、標題換成 {@link LORE_HIDDEN_MARK}。
 *
 * 沒有暗設的條目原樣帶（只是去掉首尾空白）。
 */
export function loreBodyFor(body: string, withHidden: boolean): { text: string; dropped: boolean } {
  const { visible, hidden } = splitLoreHidden(body);
  if (!hidden) {
    // 有個空的「## 暗設」標題時寫正文也去掉它：一個空標題只會讓模型去猜下面藏了什麼。
    return { text: withHidden ? (body ?? '').trim() : visible, dropped: false };
  }
  if (!withHidden) {
    return { text: visible, dropped: true };
  }
  return { text: [visible, `## ${LORE_HIDDEN_MARK}\n\n${hidden}`].filter(Boolean).join('\n\n'), dropped: false };
}

/**
 * 整條帶的設定：`【名〔分類〕】一句話`，下面是正文，最後是還沒整合進條目的新事實（帶章號）。
 * 尾巴是條目落後於正文時的那幾句——沒有它，模型拿到的是整合那時候的樣子。
 *
 * `withHidden`：帶不帶「暗設」那一節（{@link loreBodyFor}）。寫正文與續寫不帶，規劃時帶並標明。
 */
export function renderLoreFull(
  entry: LoreEntry,
  tail: readonly { no: number; text: string }[],
  withHidden: boolean
): string {
  // 沒寫 brief 時一句話就是正文第一句，下面整份正文還會再帶一遍，標題行上不重複。
  const brief = entry.brief.trim() ? loreBrief(entry) : '';
  const lines = [`【${loreHead(entry)}】${brief}`];
  const body = loreBodyFor(entry.body, withHidden).text;
  if (body) {
    lines.push(body);
  }
  if (tail.length > 0) {
    const since = entry.updatedThrough ? `第 ${entry.updatedThrough} 章之後` : '定稿裡';
    lines.push(`${since}新出現的（還沒整合進這一條）：`, ...tail.map((f) => `- 第 ${f.no} 章：${f.text}`));
  }
  return lines.join('\n');
}

/** 只帶一句話的設定：`- 名〔分類〕：一句話`。 */
export function renderLoreLine(entry: LoreEntry): string {
  const brief = loreBrief(entry);
  return `- ${loreHead(entry)}${brief ? `：${brief}` : ''}`;
}

/** 壓成一行並截短：換行變空格，超過 `max` 字截斷並補省略號。 */
export function clipLine(text: string, max: number): string {
  const one = (text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : one;
}

/** 名字後面那對括號：性別與別名，「（女；又稱 清河）」。兩樣都沒有就是空串。敘事線的當前進度也拿它告訴模型誰是男是女。 */
export function cardNote(card: Pick<CharacterCard, 'gender' | 'aliases'>): string {
  const parts = [card.gender, card.aliases.length > 0 ? `又稱 ${card.aliases.join('、')}` : ''].filter(Boolean);
  return parts.length > 0 ? `（${parts.join('；')}）` : '';
}

/**
 * 角色圖譜一覽裡的一個人：名字、性別與別名、定位，下面縮排三行身份 / 關係 / 當前狀態的開頭。
 * 完整角色卡由 `characters` 層按需帶（正文層）。
 */
export function renderRosterLine(card: CharacterCard): string {
  const tags = card.tags.length > 0 ? `［${card.tags.join('、')}］` : '';
  const parts = [`- ${card.name}${cardNote(card)}${tags}`];
  const add = (label: string, text: string, max: number) => {
    if (text?.trim()) {
      parts.push(`  ${label}：${clipLine(text, max)}`);
    }
  };
  add('身份', card.sections.身份, 120);
  add('人物关系', card.sections.人物关系, 160);
  add('当前状态', card.sections.当前状态, 80);
  return parts.join('\n');
}

/**
 * 角色卡「暗設」那一節寫了什麼（敘事線重做：原「未收伏筆」）。「無」也算沒寫：角色圖譜的提示詞讓模型沒有就寫「無」，
 * 帶進上下文只是一個空標題、寫正文時還會白注一句「暗設沒帶」。
 */
export function cardHidden(card: Pick<CharacterCard, 'sections'>): string {
  const t = (card.sections[CHARACTER_HIDDEN_KEY] ?? '').trim();
  return hasContent(t) && t !== '無' ? t : '';
}

/**
 * 一份檔案（@ 引用的整張角色卡）裡「暗設」那一節有沒有字：空的、佔位的、「無」都算沒有。
 * 判法同 {@link cardHidden}，只是從原文裡拆（`splitLoreHidden`，以「暗設」開頭的二級標題）。
 */
export function hiddenTextIn(raw: string): string {
  const t = splitLoreHidden(raw).hidden.trim();
  return hasContent(t) && t !== '無' ? t : '';
}

/**
 * 只帶要點時帶哪幾節（`essentialOnly`）：{@link CHARACTER_ESSENTIAL_KEYS}，寫正文時去掉「暗設」。明細裡那句
 * 「只帶身份/當前狀態/暗設」也照它寫。
 */
export function essentialCardKeys(withHidden: boolean): (keyof CharacterSections)[] {
  return CHARACTER_ESSENTIAL_KEYS.filter((k) => withHidden || k !== CHARACTER_HIDDEN_KEY);
}

/**
 * 一張角色卡（`characters` 層）。`essentialOnly`：只帶要點（{@link essentialCardKeys}，預算不足或上下文詳細度「精簡」）。
 *
 * `withHidden`：帶不帶「暗設」那一節（敘事線重做，設計稿「六、角色卡」⚑ 定案 B）——與設定條目的暗設同一個口徑
 * （第 27 條、{@link loreBodyFor}）：寫正文（正文階段的寫、接著寫、重寫、討論，審稿與修稿，續寫）不帶，揭開靠那一章的
 * 細綱；規劃時（架構 / 大綱 / 細綱）整份帶，放在最後、標題換成 {@link LORE_HIDDEN_MARK}，讓模型知道這是讀者還不知道的事。
 */
export function renderCharacter(card: CharacterCard, essentialOnly: boolean, withHidden: boolean): string {
  const keys = (essentialOnly ? essentialCardKeys(withHidden) : CHARACTER_SECTION_KEYS).filter((k) => k !== CHARACTER_HIDDEN_KEY);
  // 性別跟著名字走，預算再緊只帶三節時也在。
  const header = `【${card.name}${cardNote(card)}】`;
  const visible = stringifySections(card.sections as unknown as Record<string, string>, keys as readonly string[]);
  const hidden = withHidden ? cardHidden(card) : '';
  const body = [visible, hidden ? `## ${LORE_HIDDEN_MARK}\n\n${hidden}` : ''].filter(Boolean).join('\n\n');
  return `${header}\n${body || '（暫無設定）'}`;
}

/** 按字元數取結尾，並對齊到段落邊界。 */
export function tailByChars(text: string, chars: number): string {
  if (text.length <= chars) {
    return text;
  }
  let slice = text.slice(-chars);
  const br = slice.indexOf('\n');
  if (br !== -1 && br < chars * 0.25) {
    slice = slice.slice(br + 1);
  }
  return `……（前略）\n\n${slice.trimStart()}`;
}

/** 續寫時帶已寫正文的最後多少字（AI-Novel-Writer 的 `CONTINUE_PROMPT_MAX_CHARS`）。 */
export const CONTINUE_TAIL_CHARS = 1600;

/**
 * 已寫正文的最後 {@link CONTINUE_TAIL_CHARS} 字，開頭對齊到段落邊界。
 *
 * 與 {@link tailByChars} 的差別是**不加「（前略）」**：這一段是要讓模型從末尾接著寫的，
 * 開頭多一行說明，模型會以為那也是正文的一部分、跟著學。
 */
export function continuationTail(text: string, max = CONTINUE_TAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const slice = trimmed.slice(-max);
  const br = slice.indexOf('\n');
  return (br !== -1 && br < max * 0.25 ? slice.slice(br + 1) : slice).trimStart();
}

export function isPlaceholder(text: string): boolean {
  return /尚未生成|（待(?:补|補)充）/.test(text) && text.replace(/[#\s（）()]/g, '').length < 80;
}

export const ATTACHMENT_NOTE: Record<Attachment['kind'], string> = {
  selection: '編輯器選中片段',
  file: '整檔案引用',
  chapter: '章節原文引用',
  character: '角色卡引用',
  lore: '設定條目引用',
  summary: '摘要引用',
};

/** 選區使用快照，整檔案引用每次讀取最新內容。 */
export async function resolveAttachment(project: NovelProject, att: Attachment): Promise<string> {
  if (att.text !== undefined) {
    return att.text;
  }
  if (!att.relPath) {
    return '';
  }
  // 情節大綱沒有檔案：各章細綱梗概的彙總。
  if (att.relPath.replace(/\\/g, '/') === project.relPath(project.outlinePath)) {
    return (await project.readOutline()).trim();
  }
  const abs = project.pathOf(att.relPath);
  if (!(await exists(abs))) {
    return '';
  }
  try {
    return (await readText(abs)).trim();
  } catch {
    return '';
  }
}

export interface CharacterHit {
  card: CharacterCard;
  reason: string;
}

/**
 * 計劃出場、提及人物、近鄰章人物與主角的有序並集。
 *
 * **第一條是本章細綱的 `characters[]`**（D13）：細綱裡明寫了這一章有誰，那比在
 * 使用者那句話裡做子串匹配準得多。還沒定稿時那是計劃出場，只在**這裡**用——出場統計
 * 只認定稿過的細綱（第 14 條），兩者混在一起會汙染統計。之後才是這一輪的輸入、前幾章
 * （`castWindow`，上下文詳細度，預設 2）定稿過的出場人物與主角。
 */
export function selectCharacters(
  cards: CharacterCard[],
  ask: string,
  focus: Focus,
  castWindow: number
): CharacterHit[] {
  const hits = new Map<string, CharacterHit>();

  const planned = focus.plot?.characters ?? [];
  for (const name of planned) {
    const card = cards.find((c) => c.name === name || c.aliases.includes(name));
    if (card && !hits.has(card.slug)) {
      hits.set(card.slug, { card, reason: '本章細綱計劃出場' });
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    const hit = matchesKeywords(ask, [card.name, ...card.aliases]);
    if (hit) {
      hits.set(card.slug, { card, reason: `這一輪的要求裡提到「${hit}」` });
    }
  }

  for (const ref of takeLast(focus.previous, castWindow)) {
    // 只認定稿過的細綱：沒定稿的那一節寫的是計劃出場，不是這一章實際寫到了誰。
    const cast = ref.plot?.sourceHash ? ref.plot.sections.出场人物 : '';
    if (!cast.trim()) {
      continue;
    }
    for (const card of cards) {
      if (hits.has(card.slug)) {
        continue;
      }
      if (matchesKeywords(cast, [card.name, ...card.aliases])) {
        hits.set(card.slug, { card, reason: `第 ${ref.no} 章出場` });
      }
    }
  }

  for (const card of cards) {
    if (hits.has(card.slug)) {
      continue;
    }
    if (isLeadCard(card)) {
      hits.set(card.slug, { card, reason: '主角，始終注入' });
    }
  }

  return [...hits.values()];
}

/** 主角（標籤裡有「主角」「主要人物」或 main）：角色卡層始終帶，規劃時角色圖譜也始終給一段。 */
export function isLeadCard(card: Pick<CharacterCard, 'tags'>): boolean {
  return card.tags.some((t) => /主角|主要人物|main/i.test(t));
}

/** 返回命中的關鍵詞，未命中返回 undefined。 */
export function matchesKeywords(text: string, keywords: string[]): string | undefined {
  const haystack = text.toLowerCase();
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (needle.length >= 2 && haystack.includes(needle)) {
      return kw.trim();
    }
  }
  return undefined;
}
