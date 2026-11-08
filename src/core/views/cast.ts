import { buildIdentityGroups, IdentityChapter, RejectedLink } from '../model/identity';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { CharacterCard, SummaryCast } from '../model/types';
import { normalizeName, sanitizeAliases } from '../model/naming';

/**
 * 出場人物索引：把各章**定稿過的**細綱裡的 `cast` 反向聚合成「誰在哪幾章出現過」。
 *
 * 這是「定稿 → 角色」這條鏈路的中樞，三處在用：
 * - 工程頁的角色區：已建卡的角色補出場章數，未建卡的單列一組等待建卡；
 * - 「更新角色卡」：拿某個角色的出場章去裝配語料；
 * - 角色卡的 `appearsIn` 欄位：寫卡時從這裡取。
 *
 * 關鍵約定：
 *
 * - **定稿過的細綱是真相，角色卡裡的 appearsIn 只是快取**（第 14 條）。任何時候想知道誰在哪出場，
 *   都從這裡重算，不要讀角色卡的欄位——重新定稿之後卡裡的值就舊了。**沒定稿的細綱不算**：
 *   那一節寫的是計劃出場，混進來會汙染出場統計與角色卡語料（D13）。
 * - **匹配按名字與別名，不按 slug**。細綱裡的名字是模型寫的，角色卡的
 *   檔名是作者起的，兩者沒有硬關聯；靠 `name ∪ aliases` 建索引。
 * - **正式名壓過別名**。兩趟登記：先把所有卡的 `name` 占上，再登記別名，
 *   別名搶不走別人的正式名。實戰裡模型給方源的卡掛過一條 `方正` 別名
 *   （那是她孿生弟弟），先到先得會讓方正的出場章節整批記到方源頭上。
 * - **卡上的別名先過泛稱過濾**（[model/naming.ts](../model/naming.ts)）。`姐姐`、`她` 這類
 *   稱呼誰都能用，拿去匹配會把幾個角色串成一個。隻影響匹配，不改檔案。
 * - **未建卡的人物經 [model/identity.ts](../model/identity.ts) 聚類**，不再按主名硬分——
 *   細綱裡 `方源` 與 `古月方源` 交替出現，只按主名分會各建一張卡。
 * - 一個名字被兩張卡同時宣告時先到先得，並在 `conflicts` 裡留下記錄，
 *   由工程頁提示作者（出場統計必然有一張是錯的）。
 */

/** 一位出場人物的聚合結果。 */
export interface CastMember {
  /** 展示名。已建卡的用卡上的 name，未建卡的用細綱裡出現最多的那個寫法。 */
  name: string;
  /** 細綱裡見過的其它稱呼（不含 name 本身）。 */
  aliases: string[];
  /** 出場章號，升序去重。 */
  plots: number[];
  /** 已建卡時給出那張卡；未建卡為 undefined。 */
  card?: CharacterCard;
}

/** 兩張卡搶同一個稱呼。 */
export interface CastConflict {
  /** 被搶的稱呼。 */
  name: string;
  /** 捲入的角色卡 slug。第一個是當前佔著這個稱呼的那張。 */
  slugs: string[];
  /**
   * - `name`：兩張卡的**正式名**一模一樣，多半是同一個人被建了兩張卡。
   * - `alias`：一個稱呼被多張卡當成自己的（別名撞別名，或別名撞上別人的正式名）。
   */
  kind: 'name' | 'alias';
}

export interface CastIndex {
  /** 已建卡的角色（含一次都沒在定稿裡出現過的——手寫的卡也要列出來）。 */
  known: CastMember[];
  /** 定稿裡出現、但還沒有角色卡的人物，按出場章數降序。 */
  unknown: CastMember[];
  /** 被多張角色卡同時宣告的稱呼，供上層提示作者。 */
  conflicts: CastConflict[];
  /**
   * 聚類時被守衛攔下的「看著像同一人但判定為兩個人」的連結。
   * 維護命令用它解釋「為什麼方源和方正沒有合併」。
   */
  rejectedLinks: RejectedLink[];
  /** 參與統計的（定稿過的）細綱數。為 0 時上層不該顯示「沒有出場人物」——是還沒定稿過。 */
  summaryCount: number;
}

/**
 * 掃全部定稿過的細綱，建出場索引。
 *
 * 細綱列表本身有快取（`NovelProject.listPlots`）；`plots` 傳進來就直接用——工程頁重新整理時
 * 流水線那一趟已經拿到這一份了。單獨呼叫（角色卡維護等）不傳即可。
 */
export async function buildCastIndex(project: NovelProject, plots?: readonly Plot[]): Promise<CastIndex> {
  const cards = await project.listCharacters();
  const finalized = finalizedPlots(project.pairPlots(plots ?? (await project.listPlots()), await project.listChapters()));

  const { cardByName, conflicts } = indexCards(cards);

  /** slug → 出場章號。 */
  const plotsOf = new Map<string, Set<number>>();
  /** slug → 細綱裡見過的別稱。 */
  const aliasesOf = new Map<string, Set<string>>();
  /** 沒能歸到任何一張卡的條目，按章收著，稍後整體聚類。 */
  const orphanPlots: IdentityChapter[] = [];

  for (const plot of finalized) {
    const orphans: SummaryCast[] = [];

    for (const entry of plot.cast) {
      const aliases = sanitizeAliases(entry.aliases, entry.name);
      // 名字與別名都拿去找卡：模型這一章寫的是「阿昭」，也該記到林昭頭上。
      const card =
        cardByName.get(normalizeName(entry.name)) ??
        aliases.map((a) => cardByName.get(normalizeName(a))).find(Boolean);
      if (!card) {
        orphans.push({ name: entry.name, aliases });
        continue;
      }

      const set = plotsOf.get(card.slug) ?? plotsOf.set(card.slug, new Set()).get(card.slug)!;
      set.add(plot.no);
      const known = aliasesOf.get(card.slug) ?? aliasesOf.set(card.slug, new Set()).get(card.slug)!;
      for (const alias of [entry.name, ...aliases]) {
        known.add(alias);
      }
    }

    if (orphans.length > 0) {
      orphanPlots.push({ order: plot.no, cast: orphans });
    }
  }

  const known: CastMember[] = cards.map((card) => ({
    name: card.name,
    aliases: [...(aliasesOf.get(card.slug) ?? [])].filter(
      (a) => a !== card.name && !card.aliases.includes(a)
    ),
    plots: sortedNos(plotsOf.get(card.slug)),
    card,
  }));

  const identity = buildIdentityGroups(orphanPlots);
  const unknown: CastMember[] = identity.groups.map((group) => ({
    name: group.primary,
    aliases: group.names.slice(1),
    plots: group.chapters,
  }));
  // 戲份重的排前面：作者要建的卡多半是這些。
  unknown.sort((a, b) => b.plots.length - a.plots.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return { known, unknown, conflicts, rejectedLinks: identity.rejected, summaryCount: finalized.length };
}

/**
 * 出場統計認的那幾份細綱：**定稿過的**（有 `sourceHash`，第 14 條），同號只認路徑排序第一份
 * （與流水線認號同一個口徑）。定稿之後正文又改過的照樣算——那是最後一次定稿時的實際出場，
 * 比沒有強；重新定稿就跟上了。設定名錄（views/lore.ts）認的也是這幾份。
 */
export function finalizedPlots(plots: readonly Plot[]): Plot[] {
  const seen = new Set<number>();
  return plots.filter((p) => p.sourceHash && !seen.has(p.no) && (seen.add(p.no), true));
}

/**
 * 建「稱呼 → 角色卡」表。
 *
 * **兩趟**：先登記全部卡的正式名，再登記別名。正式名之間撞車才是真衝突
 * （同一個人兩張卡）；別名撞上別人的正式名一律判別名輸——那多半是模型給
 * 張三的卡掛了李四的名字，讓它搶走李四的出場章節是最壞的結果。
 */
function indexCards(cards: readonly CharacterCard[]): {
  cardByName: Map<string, CharacterCard>;
  conflicts: CastConflict[];
} {
  const cardByName = new Map<string, CharacterCard>();
  const conflicts: CastConflict[] = [];
  const seen = new Map<string, CastConflict>();

  const clash = (name: string, kind: 'name' | 'alias', a: CharacterCard, b: CharacterCard): void => {
    const key = `${kind}:${normalizeName(name)}`;
    const existing = seen.get(key);
    if (existing) {
      existing.slugs = [...new Set([...existing.slugs, a.slug, b.slug])];
      return;
    }
    const conflict: CastConflict = { name, kind, slugs: [a.slug, b.slug] };
    seen.set(key, conflict);
    conflicts.push(conflict);
  };

  for (const card of cards) {
    const key = normalizeName(card.name);
    if (!key) {
      continue;
    }
    const owner = cardByName.get(key);
    if (owner && owner.slug !== card.slug) {
      // 兩張卡的正式名撞了：出場統計必然有一張是錯的，作者需要知道。
      clash(card.name, 'name', owner, card);
      continue;
    }
    cardByName.set(key, card);
  }

  for (const card of cards) {
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      const key = normalizeName(alias);
      if (!key) {
        continue;
      }
      const owner = cardByName.get(key);
      if (!owner) {
        cardByName.set(key, card);
        continue;
      }
      if (owner.slug === card.slug) {
        continue;
      }
      // 別名撞車一律判別名輸：撞上別人的正式名尤其如此——那多半是模型給張三
      // 的卡掛了李四的名字，讓它搶走李四的出場章節是最壞的結果。
      clash(alias, 'alias', owner, card);
    }
  }

  return { cardByName, conflicts };
}

/**
 * 「定稿裡的一位出場人物 → 他的角色卡」，與 {@link buildCastIndex} 同一張表（正式名壓過別名、
 * 泛稱先濾掉）。定稿更新角色狀態時用：本章細綱定稿說誰出場了，就給誰的卡更新——兩處認人
 * 的規則一旦分叉，出場統計說他在、狀態卻沒人更新。
 */
export function cardLookup(cards: readonly CharacterCard[]): (entry: SummaryCast | string) => CharacterCard | undefined {
  const { cardByName } = indexCards(cards);
  return (entry) => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const aliases = typeof entry === 'string' ? [] : sanitizeAliases(entry.aliases, entry.name);
    return cardByName.get(normalizeName(name)) ?? aliases.map((a) => cardByName.get(normalizeName(a))).find(Boolean);
  };
}

/** 某個角色的出場章號。找不到（名字對不上任何定稿）時返回空陣列。 */
export function appearancesOf(index: CastIndex, card: CharacterCard): number[] {
  return index.known.find((m) => m.card?.slug === card.slug)?.plots ?? [];
}

/**
 * 讀出全部定稿過的細綱的 cast，作為聚類的原料。
 *
 * 與 `buildCastIndex` 的區別：那裡**先**把條目分給角色卡、只對剩下的孤兒聚類；
 * 這裡不分卡，全量給出去——維護命令要問的恰恰是「已建的這幾張卡是不是同一個人」，
 * 先按卡分開就什麼也看不出來了。
 */
export async function readCastPlots(project: NovelProject): Promise<IdentityChapter[]> {
  return finalizedPlots(await project.listChapterPlots())
    .filter((plot) => plot.cast.length > 0)
    .map((plot) => ({
      order: plot.no,
      cast: plot.cast.map((entry) => ({
        name: entry.name,
        aliases: sanitizeAliases(entry.aliases, entry.name),
      })),
    }));
}

function sortedNos(set: Set<number> | undefined): number[] {
  return set ? [...set].sort((a, b) => a - b) : [];
}

/**
 * `第 3、7、12 章` / `第 3、7、12 章等 20 章`——列表太長時只列前幾個。
 * 前端與日誌共用，保證同一份資料在兩處說法一致。
 */
export function describePlots(nos: number[], max = 6): string {
  if (nos.length === 0) {
    return '未在同步過的章裡出現';
  }
  const head = nos.slice(0, max).join('、');
  return nos.length > max ? `第 ${head} 章等 ${nos.length} 章` : `第 ${head} 章`;
}
