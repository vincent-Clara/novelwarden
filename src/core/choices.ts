import { appearancesOf, buildCastIndex, describePlots } from './views/cast';
import { PickChoice } from './host';
import { NovelProject } from './model/project';

/**
 * 供「讓使用者挑一個」用的清單構造，宿主無關。
 *
 * 為什麼在 core 而不在殼裡：清單裡的說明文字是**算出來的**——「＋3 章待讀」
 * 要比對定稿裡的出場章與角色卡的 `updatedThrough`，「1200 字」要讀正文。那是業務
 * 知識，殼照抄一遍就會與工程頁上的同一行說明分叉。殼只負責把清單交給
 * `Host.pick`（外掛是 QuickPick，獨立版是網頁彈窗）。
 *
 * 空清單一律返回空陣列，不在這裡 toast——「還沒有角色卡」該說什麼、說在哪，
 * 由呼叫方按自己的上下文決定。
 */

/** 角色卡清單。`value` 是卡的相對路徑（`updateCharacterCard` 認這個）。 */
export async function characterChoices(project: NovelProject): Promise<PickChoice<string>[]> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    return [];
  }
  // 出場章由定稿過的細綱自動關聯，所以清單裡能直接告訴使用者「這張卡還差幾章沒讀」。
  const index = await buildCastIndex(project);
  return cards.map((card) => {
    const plots = appearancesOf(index, card);
    const pending = plots.filter((no) => no > (card.updatedThrough ?? 0)).length;
    return {
      label: card.name,
      description: pending > 0 ? `＋${pending} 章待讀` : undefined,
      detail: describePlots(plots),
      value: card.relPath,
    };
  });
}

/** 章節清單。`value` 是章號——呼叫方拿它找細綱或成品。 */
export async function plotChoices(project: NovelProject): Promise<PickChoice<number>[]> {
  // 兩邊都列：老工程只有 `chapters/`，只列細綱的話下拉框是空的。
  const [plots, chapters] = await Promise.all([project.listPlots(), project.listChapters()]);
  const byNo = new Map<number, { title: string; words: number }>();
  for (const chapter of chapters) {
    byNo.set(chapter.order, { title: chapter.title, words: chapter.wordCount });
  }
  for (const plot of plots) {
    // 有正文的章只認它映象的那份細綱（`NovelProject.plotFor`）；字數是那一章正文的。
    if (project.plotFor(plot.no, plots, chapters) !== plot) {
      continue;
    }
    byNo.set(plot.no, { title: plot.title || byNo.get(plot.no)?.title || '', words: byNo.get(plot.no)?.words ?? 0 });
  }

  return [...byNo.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, { title, words }]) => ({
      // 補零對齊，長篇下拉里看著才是一列。
      label: `${String(no).padStart(3, '0')} ${title || '（未命名）'}`,
      description: words > 0 ? `${words} 字` : '還沒有正文',
      value: no,
    }));
}
