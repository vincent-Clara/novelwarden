import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { parseContinuityFacts } from '../model/continuity';
import { LoreThinKind, createLoreLookup, loreMentionsIn, loreThin, normalizeLoreName } from '../model/loreFile';
import { CharacterCard, LoreEntry } from '../model/types';
import { normalizeName } from '../model/naming';
import { finalizedPlots } from './cast';
import { loreBatchExpandable } from './loreMaterial';

/**
 * 設定名錄：把各章**定稿過的**細綱「設定」一節反向聚合成「哪個東西在哪幾章出現過、
 * 有沒有條目、條目落後了幾章」。和出場人物索引（views/cast.ts）是一個路子：
 *
 * - **定稿過的細綱是真相**（第 14 條同理）。沒定稿的「設定」一節寫的是計劃，不進統計——只給裝配器挑條目用。
 * - **兩趟認條目**：先按標題、再按關鍵詞（model/loreFile.ts 的 `createLoreLookup`），關鍵詞搶不走
 *   別人的標題。
 * - **待整合的新事實**：水位（條目的 `updatedThrough`）之後的定稿章裡，「設定」一節冒號後面那句、
 *   以及連續性事實裡提到它的標題或關鍵詞的那一條。會變的狀態（誰拿走了、毀了）一直記在連續性事實裡，
 *   名錄去那裡認，不另存一份。
 * - **人名不是設定**：「設定」一節裡的名字撞上角色卡的名字或別名就不算（模型偶爾把人也列進來）。
 * - **待完善**（完善設定，2026-10-19，按需算）：唯一往前看的一塊——還沒寫的那幾章細綱「設定」一節點名、卻還沒有條目
 *   或條目還只有一句話的，工程頁「待完善」那一組列它（{@link thinLore}）；寫前提醒（工作臺、批次寫章確認框）取其中
 *   要用到那幾章的（{@link thinLoreFor}，三期）。
 *
 * 純讀盤、不調模型、不落盤（第 18 條：狀態一律從磁碟推導）。
 */

/** 一條關於某個設定的新事實。 */
export interface LoreFact {
  /** 章號。 */
  no: number;
  text: string;
  /** `lore`：「設定」一節冒號後面那句；`fact`：連續性事實裡提到它的那一條。 */
  source: 'lore' | 'fact';
}

/** 一條已建的設定。 */
export interface LoreRecord {
  entry: LoreEntry;
  /** 定稿過的細綱「設定」一節點名它的章，升序。 */
  chapters: number[];
  /** 水位之後、定稿過的章裡關於它的新事實，按章號升序。 */
  pending: LoreFact[];
}

/** 定稿裡出現過、還沒有條目的名字。 */
export interface UnfiledLore {
  /** 展示名：各章寫法裡出現最多的那個。 */
  name: string;
  /** 建議的分類：各章 `〔分類〕` 的多數票，沒寫過是空串。 */
  category: string;
  chapters: number[];
  /** 各章冒號後面那句（建條目的原料）。 */
  notes: LoreFact[];
}

/** 「待完善」的哪一種：還沒有條目，或條目還只有一句話（{@link LoreThinKind}）。 */
export type ThinLoreKind = 'missing' | LoreThinKind;

/** 工程頁「待完善」那一行寫的種類。 */
export const THIN_LORE_LABEL: Record<ThinLoreKind, string> = {
  missing: '還沒有條目',
  empty: '只有一句話',
  placeholder: '只有佔位',
  untold: '三節全是未交代',
};

/**
 * 接下來要用、卻還是空的一條設定（完善設定 · 待完善，2026-10-19）：沒定稿、也還沒寫正文的細綱「設定」一節點名了它，
 * 而它還沒有條目，或條目還只有一句話。
 */
export interface ThinLore {
  /** 有條目是條目的標題；沒有是各章「設定」一節寫法裡出現最多的那個。 */
  name: string;
  /** 有條目是條目所在的目錄；沒有是各章 `〔分類〕` 的多數票，沒寫過是空串。 */
  category: string;
  /** 條目路徑；還沒有條目時缺席。 */
  relPath?: string;
  kind: ThinLoreKind;
  /** 要用到它的章（細綱「設定」一節點名它的），升序。 */
  chapters: number[];
  /** 最早要用到的那一章。 */
  first: number;
  /**
   * 條目裡有作者的字（三節全是「（未交代）」卻沒蓋過機器的章、明面空著但寫過暗設）：「全部展開」跳過它，
   * 要展開就單條展開、先對比（`loreBatchExpandable`，完善設定三期）。還沒有條目的、空的、佔位的沒有這一項。
   */
  authored?: true;
}

export interface LoreIndex {
  /** 全部條目（含一次都沒在定稿裡出現過的），按 `listLore` 的順序。 */
  known: LoreRecord[];
  /** 定稿裡出現、還沒有條目的名字，按出現章數降序。 */
  unknown: UnfiledLore[];
  /** 定稿過、但「設定」一節標題不在的章（還沒記過設定），升序。 */
  unrecorded: number[];
  /** 參與統計的（定稿過的）細綱數。 */
  finalizedCount: number;
  /** 待完善（`opts.thin` 開啟時才算，不然是空的），按最早要用到的章升序。 */
  thin: ThinLore[];
}

/**
 * 掃全部定稿過的細綱，建設定名錄。`plots` / `entries` / `cards` 傳進來就直接用（工程頁重新整理時
 * 已經讀過了，同一次重新整理裡一個檔案只讀一次——tests/integration/views/projectTreeReads），不傳就自己讀。
 *
 * `opts.pending: false`：不算待整合的新事實（`known[].pending` 一律空）。那一步要拿每一章的連續性事實去對每一條
 * 條目，幾百章 × 幾百條時是這裡最貴的一段；只要出現章與未建條目的呼叫方（編輯器的名詞補全，`views/nameIndex.ts`）
 * 用不著它。
 *
 * `opts.thin: true`：順帶算「待完善」（{@link thinLore}）。只有工程頁要，預設不算。
 */
export async function buildLoreIndex(
  project: NovelProject,
  read: { plots?: readonly Plot[]; entries?: readonly LoreEntry[]; cards?: readonly CharacterCard[] } = {},
  opts: { pending?: boolean; thin?: boolean } = {}
): Promise<LoreIndex> {
  const withPending = opts.pending !== false;
  const [entries, cards, chapters] = await Promise.all([
    read.entries ?? project.listLore(),
    read.cards ?? project.listCharacters(),
    project.listChapters(),
  ]);
  const paired = project.pairPlots(read.plots ?? (await project.listPlots()), chapters);
  const finalized = finalizedPlots(paired);
  const lookup = createLoreLookup(entries);

  const people = new Set<string>();
  for (const card of cards) {
    for (const name of [card.name, ...card.aliases]) {
      people.add(normalizeName(name));
    }
  }

  const chaptersOf = new Map<string, Set<number>>();
  const pendingOf = new Map<string, LoreFact[]>();
  /** 歸一後的名字 → 各章的寫法、分類的票、章號與說明。 */
  const unfiled = new Map<string, UnfiledGroup>();
  const unrecorded: number[] = [];

  const watermark = (entry: LoreEntry): number => entry.updatedThrough ?? 0;
  const addPending = (entry: LoreEntry, fact: LoreFact): void => {
    const list = pendingOf.get(entry.slug) ?? pendingOf.set(entry.slug, []).get(entry.slug)!;
    list.push(fact);
  };

  for (const plot of finalized) {
    if (!plot.lore) {
      unrecorded.push(plot.no);
    }
    for (const line of plot.lore ?? []) {
      if (people.has(normalizeName(line.name))) {
        continue;
      }
      const entry = lookup.find(line.name);
      if (entry) {
        const set = chaptersOf.get(entry.slug) ?? chaptersOf.set(entry.slug, new Set()).get(entry.slug)!;
        set.add(plot.no);
        if (withPending && line.note && plot.no > watermark(entry)) {
          addPending(entry, { no: plot.no, text: line.note, source: 'lore' });
        }
        continue;
      }
      const key = normalizeLoreName(line.name);
      const group =
        unfiled.get(key) ??
        unfiled
          .set(key, { names: new Map(), categories: new Map(), chapters: new Set(), notes: [] })
          .get(key)!;
      group.names.set(line.name, (group.names.get(line.name) ?? 0) + 1);
      if (line.category) {
        group.categories.set(line.category, (group.categories.get(line.category) ?? 0) + 1);
      }
      group.chapters.add(plot.no);
      if (line.note) {
        group.notes.push({ no: plot.no, text: line.note, source: 'lore' });
      }
    }
  }

  // 連續性事實裡提到的：狀態的變化記在那裡。只認水位之後的章。最長匹配（2026-10-25，`loreMentionsIn`）：「幻池秘境」裡的
  // 「秘境」不算提到「秘境」那一條——從前子串就算，各個具體秘境的事都掛到上位概念名下，整合時一條條並進去。別人的名字
  // 再加名錄裡記著、還沒建條目的，所以等「設定」一節都認完再認；水位之內的條目照樣算別人的名字，只是不收。
  if (withPending && entries.length > 0) {
    const names = [...unfiled.values()].flatMap((g) => [...g.names.keys()]);
    const lowest = Math.min(...entries.map(watermark));
    for (const plot of finalized) {
      if (plot.no <= lowest) {
        continue;
      }
      for (const fact of parseContinuityFacts(plot.sections.连续性事实)) {
        for (const entry of loreMentionsIn(fact.statement, entries, names).keys()) {
          if (plot.no > watermark(entry)) {
            addPending(entry, { no: plot.no, text: fact.statement, source: 'fact' });
          }
        }
      }
    }
  }

  const known: LoreRecord[] = entries.map((entry) => ({
    entry,
    chapters: [...(chaptersOf.get(entry.slug) ?? [])].sort((a, b) => a - b),
    pending: (pendingOf.get(entry.slug) ?? []).sort((a, b) => a.no - b.no),
  }));

  const unknown: UnfiledLore[] = [...unfiled.values()].map((group) => ({
    name: topOf(group.names),
    category: topOf(group.categories),
    chapters: [...group.chapters].sort((a, b) => a - b),
    notes: group.notes,
  }));
  // 出現得多的排前面：作者要建的條目多半是這些；同樣多的按第一次出現的章號。
  unknown.sort(
    (a, b) =>
      b.chapters.length - a.chapters.length ||
      a.chapters[0] - b.chapters[0] ||
      a.name.localeCompare(b.name, 'zh-Hans-CN')
  );

  const thin = opts.thin ? thinLore(paired, chapters, lookup, people) : [];
  return { known, unknown, unrecorded, finalizedCount: finalized.length, thin };
}

/**
 * 待完善（完善設定，2026-10-19）：**往前看**——沒定稿、也還沒寫正文（沒有章節檔案，或有檔案但 0 字）的細綱
 * 「設定」一節點名的設定裡，還沒有條目的、條目還只有一句話的（`loreThin`：空的、新建設定的佔位、三節全是「（未交代）」）。
 * 名錄別處都只認定稿過的「設定」一節（第 14 條），這裡反過來只認計劃：要提醒的正是「接下來幾章要用、卻還是空的」。
 * 已經寫了正文、還沒定稿的章不算——那一章已經寫過去了，再展開也幫不上它。
 *
 * 人名照樣不算（同上）。複用 {@link buildLoreIndex} 已經讀進來的細綱、章節與條目，不多讀盤。按最早要用到的章升序，
 * 同一章的按名字。
 */
function thinLore(
  plots: readonly Plot[],
  chapters: readonly { order: number; wordCount: number }[],
  lookup: ReturnType<typeof createLoreLookup>,
  people: ReadonlySet<string>
): ThinLore[] {
  const written = new Set(chapters.filter((c) => c.wordCount > 0).map((c) => c.order));
  /** 有條目的按 slug，沒有的按歸一後的名字。 */
  const byKey = new Map<string, { entry?: LoreEntry; kind: ThinLoreKind; group: UnfiledGroup }>();
  for (const plot of plots) {
    if (plot.sourceHash || written.has(plot.no)) {
      continue;
    }
    for (const line of plot.lore ?? []) {
      if (people.has(normalizeName(line.name))) {
        continue;
      }
      const entry = lookup.find(line.name);
      const kind: ThinLoreKind | undefined = entry ? loreThin(entry) : 'missing';
      if (!kind) {
        continue;
      }
      const key = entry ? `entry:${entry.slug}` : `name:${normalizeLoreName(line.name)}`;
      const item =
        byKey.get(key) ??
        byKey
          .set(key, { entry, kind, group: { names: new Map(), categories: new Map(), chapters: new Set(), notes: [] } })
          .get(key)!;
      item.group.names.set(line.name, (item.group.names.get(line.name) ?? 0) + 1);
      if (line.category) {
        item.group.categories.set(line.category, (item.group.categories.get(line.category) ?? 0) + 1);
      }
      item.group.chapters.add(plot.no);
    }
  }
  const out: ThinLore[] = [...byKey.values()].map(({ entry, kind, group }) => {
    const nos = [...group.chapters].sort((a, b) => a - b);
    return {
      name: entry?.title ?? topOf(group.names),
      category: entry ? entry.category : topOf(group.categories),
      ...(entry ? { relPath: entry.relPath } : {}),
      kind,
      chapters: nos,
      first: nos[0],
      ...(entry && !loreBatchExpandable(entry) ? { authored: true as const } : {}),
    };
  });
  return out.sort((a, b) => a.first - b.first || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 這幾章要用、卻還只有一句話的設定（寫前提醒，完善設定三期）：就是「待完善」裡要用到這幾章的那幾條（{@link thinLore}），
 * 口徑一字不差——沒定稿、也還沒寫正文的細綱「設定」一節點名的，沒有條目或條目還只有一句話。每條的 `chapters` 只留這幾章裡的。
 * 工作臺正文目標與批次寫章的確認框用它；零呼叫、只讀盤。
 */
export async function thinLoreFor(project: NovelProject, nos: readonly number[]): Promise<ThinLore[]> {
  const wanted = new Set(nos);
  if (wanted.size === 0) {
    return [];
  }
  const { thin } = await buildLoreIndex(project, {}, { pending: false, thin: true });
  return thin
    .map((item) => ({ ...item, chapters: item.chapters.filter((no) => wanted.has(no)) }))
    .filter((item) => item.chapters.length > 0)
    .map((item) => ({ ...item, first: item.chapters[0] }));
}

/** 還要整合幾章：待整合事實來自幾個不同的章。工程頁的 `＋N`。 */
export function pendingChapters(record: LoreRecord): number {
  return new Set(record.pending.map((f) => f.no)).size;
}

/**
 * `第 3–57 章 · 12 章` / `第 3 章`；一次都沒出現是空串。設定比人多得多、一條常常出現幾十章，
 * 不像出場人物那樣逐個列章號（`describePlots`），只給首尾與章數。
 */
export function describeSpan(nos: readonly number[]): string {
  if (nos.length === 0) {
    return '';
  }
  const first = nos[0];
  const last = nos[nos.length - 1];
  return first === last ? `第 ${first} 章` : `第 ${first}–${last} 章 · ${nos.length} 章`;
}

interface UnfiledGroup {
  names: Map<string, number>;
  categories: Map<string, number>;
  chapters: Set<number>;
  notes: LoreFact[];
}

/** 票數最多的那一項（同票取先出現的），沒有就是空串。 */
function topOf(votes: Map<string, number>): string {
  let best = '';
  let max = 0;
  for (const [value, count] of votes) {
    if (count > max) {
      best = value;
      max = count;
    }
  }
  return best;
}
