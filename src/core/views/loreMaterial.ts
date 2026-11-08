import { NovelProject } from '../model/project';
import { hash } from '../model/fs';
import { Plot, PLOT_SECTION_KEYS } from '../model/plotFile';
import { parseContinuityFacts } from '../model/continuity';
import { createLoreLookup, loreCategoryOfSlug, loreMentionIn, loreThin, splitLoreHidden } from '../model/loreFile';
import { LoreEntry } from '../model/types';
import { finalizedPlots } from './cast';
import type { LoreFact } from './lore';

/**
 * 一條設定的原料：定稿過的細綱裡關於它的記錄（建條目、整合、展開共用）、沒定稿的細綱裡用到它的地方
 * （展開用），以及寫完之後水位記到第幾章、條目正文是不是機器寫的。
 *
 * 純讀盤、不調模型、不落盤。從 features/lore.ts 挪過來（完善設定，2026-10-19）：裝配器展開一條設定時要
 * 同一份原料，而 context/ 不依賴 features/（見 context/README.md）。挪過來的那幾樣行為一字不變。
 */

/** 建條目、整合、展開時給模型的記錄最多多少 token（原料是一句一句的記錄，很少到這麼多）。 */
export const MATERIAL_TOKENS = 6000;

// ---------------------------------------------------------------- 水位

/**
 * 整合能推到第幾章：**第一處沒定稿（或定稿之後正文又改過）的章之前**。第 5 章沒定稿、第 6 章定稿了，
 * 水位最多到 4——否則第 5 章日後定稿，它的事實永遠進不了條目（全文大綱的增量也是這麼停的）。
 * 一章都沒寫是 0。展開寫下的條目水位也記這個（展開喂的定稿記錄就是整合會喂的那一份）。
 */
export async function integrationWatermark(project: NovelProject): Promise<number> {
  const chapters = [...(await project.listChapters())].sort((a, b) => a.order - b.order);
  let through = 0;
  for (const chapter of chapters) {
    if (chapter.wordCount === 0) {
      continue;
    }
    const plot = await project.plotOfChapter(chapter);
    if (!plot?.sourceHash || plot.sourceHash !== chapter.contentHash) {
      return chapter.order - 1;
    }
    through = chapter.order;
  }
  return through;
}

// ---------------------------------------------------------------- 定稿過的記錄

/**
 * 一個名字在定稿過的細綱裡的**所有記錄**，帶章號：「設定」一節冒號後那一句、連續性事實裡提到它的、
 * 另外幾節裡提到它的句子。建條目的原料。
 */
export function recordsAbout(plots: readonly Plot[], words: readonly string[], notes: readonly LoreFact[]): LoreFact[] {
  const out: LoreFact[] = [...notes];
  const hit = (text: string): boolean => words.some((w) => w.length >= 2 && text.includes(w));
  for (const plot of plots) {
    for (const fact of parseContinuityFacts(plot.sections.连续性事实)) {
      if (hit(fact.statement)) {
        out.push({ no: plot.no, text: fact.statement, source: 'fact' });
      }
    }
    for (const key of PLOT_SECTION_KEYS) {
      if (key === '连续性事实' || key === '出场人物') {
        continue;
      }
      for (const sentence of plot.sections[key].split(/(?<=[。！？!?])|\n+/u)) {
        const s = sentence.replace(/^\s*[-*·•]\s*/u, '').trim();
        if (s && hit(s)) {
          out.push({ no: plot.no, text: s, source: 'lore' });
        }
      }
    }
  }
  const seen = new Set<string>();
  return out
    .filter((f) => {
      const key = `${f.no}|${f.text}`;
      return !seen.has(key) && (seen.add(key), true);
    })
    .sort((a, b) => a.no - b.no);
}

// ---------------------------------------------------------------- 誰寫的

/**
 * 條目正文是不是機器寫的：空的，或記下的指紋對得上。沒蓋過章的非空正文算作者的。從 features/lore.ts 挪過來
 * （完善設定三期）：名錄算「待完善」時要判批次展開會不會寫它（{@link loreBatchExpandable}），而 views/ 不依賴 features/。
 */
export function loreOwnedByMachine(entry: Pick<LoreEntry, 'body' | 'bodyHash'>): boolean {
  const body = entry.body.trim();
  return !body || (!!entry.bodyHash && hash(body) === entry.bodyHash);
}

/**
 * 批次展開（完善設定三期）會不會寫這一條：還只有一句話（`loreThin`），而且沒有作者的字。第 19 條批次那一面——
 * 沒有卡片、不問，只寫吞不掉東西的：明面空的、新建設定的佔位（都沒有暗設），以及機器寫的（`bodyHash` 對得上，
 * 設定清單起步時留下的三節「（未交代）」就是這種）。三節全是「（未交代）」卻沒蓋過章的、明面空著但寫過暗設的，
 * 都可能是作者手寫的，批次跳過——要展開就單條展開，先對比。
 */
export function loreBatchExpandable(entry: Pick<LoreEntry, 'body' | 'bodyHash'>): boolean {
  const thin = loreThin(entry);
  if (!thin) {
    return false;
  }
  if (loreOwnedByMachine(entry)) {
    return true;
  }
  return thin !== 'untold' && !splitLoreHidden(entry.body).hidden;
}

// ---------------------------------------------------------------- 展開要的原料

/**
 * 路徑上的那一條條目（單條設定這個目標認的就是它）。檔案還不在時（MCP 給了一條新路徑、展開期間被刪了）
 * 按路徑拼一條空的：標題取檔名、分類取它在 `lore/` 下的目錄，`exists: false`。`entries` 給了就不再讀盤。
 */
export async function loreEntryAt(
  project: NovelProject,
  relPath: string,
  entries?: readonly LoreEntry[]
): Promise<{ entry: LoreEntry; exists: boolean }> {
  const found = (entries ?? (await project.listLore())).find((e) => e.relPath === relPath);
  if (found) {
    return { entry: found, exists: true };
  }
  const root = project.relPath(project.loreDir);
  const slug = (relPath.startsWith(`${root}/`) ? relPath.slice(root.length + 1) : relPath).replace(/\.(md|markdown)$/i, '');
  const title = slug.slice(slug.lastIndexOf('/') + 1);
  return {
    entry: { slug, relPath, title, keywords: [], brief: '', category: loreCategoryOfSlug(slug), body: '' },
    exists: false,
  };
}

/** 沒定稿的細綱裡用到這一條的一處：「設定」一節點名它的那一行，或梗概、關鍵事件裡提到它的一句。 */
export interface LorePlannedUse {
  no: number;
  /** 那一章細綱的標題（可能是空串）。 */
  title: string;
  where: '设定' | '梗概' | '关键事件';
  text: string;
}

/** 展開一條設定的原料（完善設定 §1「喂什麼」）。 */
export interface LoreExpansionMaterial {
  /** 已排（沒定稿）的細綱裡用到它的地方，按章號升序——展開是為這些情節服務的。 */
  uses: LorePlannedUse[];
  /** 定稿過的細綱裡關於它的全部記錄（{@link recordsAbout}，「設定」一節那一句也算）——已經寫進正文的，不能推翻。 */
  records: LoreFact[];
}

/**
 * 展開一條設定要喂的兩樣原料。同一個號只認一份細綱（`pairPlots`，與名錄同一個口徑）；有 `sourceHash` 的是
 * 定稿過的，其餘是計劃。「設定」一節裡的名字按名錄同一張表認（`createLoreLookup`：標題優先、關鍵詞搶不走別人的
 * 標題），句子裡的提及按標題或關鍵詞認（`loreMentionIn`）。`read` 裡給了就直接用，不再讀盤。
 */
export async function expansionMaterial(
  project: NovelProject,
  entry: LoreEntry,
  read: { plots?: readonly Plot[]; entries?: readonly LoreEntry[] } = {}
): Promise<LoreExpansionMaterial> {
  const [plots, chapters, entries] = await Promise.all([
    read.plots ?? project.listPlots(),
    project.listChapters(),
    read.entries ?? project.listLore(),
  ]);
  const paired = project.pairPlots(plots, chapters);
  const lookup = createLoreLookup(entries.some((e) => e.relPath === entry.relPath) ? entries : [...entries, entry]);
  const isSelf = (name: string): boolean => lookup.find(name)?.relPath === entry.relPath;

  const uses: LorePlannedUse[] = [];
  for (const plot of paired.filter((p) => !p.sourceHash).sort((a, b) => a.no - b.no)) {
    for (const line of plot.lore ?? []) {
      if (isSelf(line.name)) {
        uses.push({ no: plot.no, title: plot.title, where: '设定', text: line.note ? `${line.name}：${line.note}` : line.name });
      }
    }
    for (const key of ['梗概', '关键事件'] as const) {
      for (const sentence of (plot.sections[key] ?? '').split(/(?<=[。！？!?])|\n+/u)) {
        const s = sentence.replace(/^\s*(?:[-*·•]|\d+[.、)．])\s*/u, '').trim();
        if (s && loreMentionIn(s, entry)) {
          uses.push({ no: plot.no, title: plot.title, where: key, text: s });
        }
      }
    }
  }

  const finalized = finalizedPlots(paired);
  const notes: LoreFact[] = finalized.flatMap((plot) =>
    (plot.lore ?? [])
      .filter((line) => line.note && isSelf(line.name))
      .map((line) => ({ no: plot.no, text: line.note, source: 'lore' as const }))
  );
  const records = recordsAbout(finalized, [entry.title, ...entry.keywords], notes);
  return { uses, records };
}
