/**
 * 全書查詢替換的範圍與上限。**純資料、零 import**：面板上那幾個勾選框（`media/src/editor/bookFind.ts`）與後端按範圍
 * 列檔案（`views/bookFind.ts`）、替換時認路徑（`features/bookReplace.ts`）讀的是同一張表——介面上寫著「角色卡」，
 * 後端搜的就得是角色卡那個區。經 `media/src/protocol.ts` 打進瀏覽器產物。
 */

/** 一個範圍：正文、細綱、草稿、角色卡、設定條目，以及其餘幾份創作檔案（大綱 / 架構三件 / 文風 / 敘事線 / 全文大綱）。 */
export type BookFindScope = 'chapter' | 'plot' | 'draft' | 'character' | 'lore' | 'doc';

/** 面板上的順序，也是結果分組的順序。 */
export const BOOK_FIND_SCOPES: readonly BookFindScope[] = ['chapter', 'plot', 'draft', 'character', 'lore', 'doc'];

/** 勾選框上的字與結果分組的標題。 */
export const BOOK_FIND_SCOPE_LABEL: Record<BookFindScope, string> = {
  chapter: '正文',
  plot: '細綱',
  draft: '草稿',
  character: '角色卡',
  lore: '設定條目',
  doc: '其他創作檔案',
};

/** 勾選框的提示：這一項搜哪些檔案。 */
export const BOOK_FIND_SCOPE_HINT: Record<BookFindScope, string> = {
  chapter: '章節根下的正文（按章號）',
  plot: '每一章的細綱（.novelwarden/summaries/ 下，按章號）',
  draft: 'drafts/ 下的草稿',
  character: '角色卡（.novelwarden/characters/）',
  lore: '設定條目（.novelwarden/lore/）',
  doc: '情節大綱、小說配置、故事前提、世界觀、文風指南、敘事線、全文大綱',
};

/** 開啟面板時預設勾上哪幾項：只有正文（⚑ 作者最常搜的是正文；要連細綱、角色卡一起改名時自己勾上）。 */
export const DEFAULT_BOOK_FIND_SCOPES: readonly BookFindScope[] = ['chapter'];

/**
 * 一次最多列多少處。到了就停：後面的檔案不再讀，結果裡說「只列了前 N 處」並說停在哪一份上（⚑）。
 * 搜一個「的」在三百章裡能有十幾萬處——全列出來既讀不完也看不完，多打幾個字縮小範圍才是正路。
 * 替換也只作用於列出來的這些（預覽裡看過的才換，第 19 條），換完再搜一次接著換。
 */
export const BOOK_FIND_LIMIT = 1000;

/** 每一處那一行上下文：命中之前最多帶幾個字、之後最多帶幾個字（同一行之內，超了用「…」截）。 */
export const BOOK_FIND_CONTEXT = { before: 24, after: 40 } as const;

/** 認不認得這個範圍（前端傳上來的是字串）。 */
export function isBookFindScope(value: unknown): value is BookFindScope {
  return typeof value === 'string' && (BOOK_FIND_SCOPES as readonly string[]).includes(value);
}
