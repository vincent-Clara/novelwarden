import * as fsp from 'node:fs/promises';
import { hash } from '../model/fs';
import { loreBrief } from '../model/loreFile';
import { namesOf } from '../model/manuscriptCheck';
import { NovelProject, listMarkdownDeep } from '../model/project';
import type { CharacterCard, LoreEntry } from '../model/types';
import type { NameEntry, NameIndex } from '../protocol';
import { buildLoreIndex } from './lore';

/**
 * 內建編輯器「名詞補全」的名詞表：角色卡（名字、別名）、設定條目（標題、關鍵詞、分類）、設定名錄裡出現過還沒建條目的
 * 名字。每一條帶型別與一句話（卡或條目裡現成的那一句）。**純讀盤、不調模型**（第 4 條：補全不燒 token）。
 *
 * **按需要**：前端按了補全鍵、或開著「邊打邊彈」在打字時才要（`requestNameIndex`），不進每次檔案變動都重推的工程樹 /
 * `ViewState`。前端帶著手上那一份的指紋（`have`）來，沒變就只回指紋（controller 那一層比，見 {@link nameIndexSig}）。
 * 匹配與排序在前端（`media/src/editor/namesCore.ts`），這裡只給一份平鋪的表。
 *
 * ## 讀了哪些盤
 *
 * 幾百張卡、幾百條設定也要快——作者每存一次稿前端就會再問一次（問的時候帶著指紋），所以**沒變的時候不讀任何一份卡或
 * 條目的內容**：
 *
 * - **角色卡與設定條目**：遞迴列 `.novelwarden/characters/` 與 `.novelwarden/lore/`（與 `listCharacters` / `listLore`
 *   同一個列法），每個檔案 `stat` 一次，拼成「路徑 · 大小 · 修改時間」的簽名。簽名與上一次一樣就用上一次讀好的那一份
 *   （按工程例項記在記憶體裡）；不一樣（新建、刪掉、改過任何一張）才整份重讀——每個檔案讀一次，與工程頁同一個解析
 *   （`NovelProject.listCharacters` / `listLore`）。
 * - **未建條目**：設定名錄（`views/lore.ts` 的 `buildLoreIndex`，關掉「待整合」那一步）從定稿過的細綱「設定」一節算出來。
 *   細綱與章節列表借工程上的快取（`listPlots()` / `listChapters()`，每次 `pushState` 重算 `ViewState` 時就填上了，
 *   幾乎總是熱的），熱的時候**一份細綱都不讀**；卡與條目用上面那一份，不再讀。
 *
 * 不讀正文、大綱、配置。
 */
export async function buildNameIndex(project: NovelProject): Promise<NameIndex> {
  if (!(await project.isInitialized())) {
    return { initialized: false, names: [] };
  }
  const { cards, lore } = await readSources(project);
  const catalog = await buildLoreIndex(project, { entries: lore, cards }, { pending: false });

  const names: NameEntry[] = [];
  for (const card of cards) {
    names.push({
      name: card.name,
      aliases: aliasesOf(card.name, card.aliases),
      source: 'character',
      category: '',
      brief: loreBrief({ brief: '', body: card.sections.身份 ?? '' }) || card.tags.join('、'),
      path: card.relPath,
    });
  }
  for (const entry of lore) {
    names.push({
      name: entry.title,
      aliases: aliasesOf(entry.title, entry.keywords),
      source: 'lore',
      category: entry.category,
      brief: loreBrief(entry),
      path: entry.relPath,
    });
  }
  // 名錄裡出現過、還沒建條目的名字（⚑ 進表）：定稿過的正文裡真出現過，作者接著寫多半還會用到。一句話取最近那一章的說明。
  for (const item of catalog.unknown) {
    const latest = [...item.notes].sort((a, b) => b.no - a.no).find((n) => n.text.trim() !== '');
    names.push({
      name: item.name,
      aliases: [],
      source: 'unfiled',
      category: item.category,
      brief: latest?.text.trim() ?? '',
    });
  }
  return { initialized: true, names };
}

/** 名詞表的指紋：前端帶著它來問，對得上就不再發一遍表。 */
export function nameIndexSig(index: NameIndex): string {
  return hash(JSON.stringify(index));
}

/**
 * 別的叫法：別名 / 關鍵詞，外加名字裡括號內外各一截（`manuscriptCheck.ts` 的 `namesOf`，查提前登場也是這麼認人的）。
 * 不含正名，去重；一個字的不要——補全按開頭認，一個字的別名會把「林」這類常用字認成「已經打完整了」。
 */
function aliasesOf(name: string, aliases: readonly string[]): string[] {
  const self = name.trim();
  return namesOf(name, aliases).filter((n) => n !== self);
}

// ---------------------------------------------------------------- 卡與條目：沒變就不讀

interface Sources {
  sig: string;
  cards: CharacterCard[];
  lore: LoreEntry[];
}

/** 按工程例項記著上一次讀好的卡與條目（換工程就是另一個例項，舊的隨它回收）。 */
const sourceCache = new WeakMap<NovelProject, Sources>();

async function readSources(project: NovelProject): Promise<Sources> {
  const [cardFiles, loreFiles] = await Promise.all([
    listMarkdownDeep(project.charactersDir),
    listMarkdownDeep(project.loreDir),
  ]);
  const stamps = await Promise.all(
    [...cardFiles, ...loreFiles].map(async (abs) => {
      try {
        const s = await fsp.stat(abs);
        return `${abs}\u0000${s.size}\u0000${s.mtimeMs}`;
      } catch {
        // 列出來之後、stat 之前被刪了：簽名裡記一筆，下一次自然對不上。
        return `${abs}\u0000gone`;
      }
    })
  );
  const sig = `${cardFiles.length}\u0001${stamps.join('\n')}`;
  const known = sourceCache.get(project);
  if (known && known.sig === sig) {
    return known;
  }
  const [cards, lore] = await Promise.all([project.listCharacters(), project.listLore()]);
  const next: Sources = { sig, cards, lore };
  sourceCache.set(project, next);
  return next;
}
