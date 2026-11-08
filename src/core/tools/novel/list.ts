/**
 * `list` —— 列一個目錄裡有什麼。`Workspace.list` 的薄包裝。
 *
 * 這一層的活是**把結構化陣列壓成模型一屏能掃完的文字**：
 *
 * ```
 * .novelwarden/summaries/（42 項）
 *   001-楔子.md          620 字
 *   002-入宗.md          710 字
 *   …
 *   （還有 32 項未列出，用 path 引數進子目錄看）
 * ```
 *
 * 上限 60 項，超了必須說出來（AGENTS 第 2 條：不靜默截斷）。60 是按「一屏
 * 能掃完、又裝得下一本書的章節目錄的前半」定的：真要找具體某一章，`search`
 * 比翻頁快得多。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { objectSchema, str } from '../schema';

/** 一次最多列幾項。 */
export const LIST_LIMIT = 60;

export const listTool: ToolDef = {
  name: 'list',
  description:
    '列出工程裡某個目錄的直接子項（不遞迴），帶型別與字數。' +
    'path 是工程內相對路徑、用正斜槓，留空則列工程根。' +
    '幾個固定位置：小說配置、故事前提、世界觀是 .novelwarden/config.md、premise.md、world.md，' +
    '情節大綱是 .novelwarden/outline.md（磁碟上沒有這份檔案，list 列不出來：它是各章細綱「梗概」的彙總，read / write 照樣認這個路徑，' +
    '寫回時按章號拆進各章細綱），細綱在 .novelwarden/summaries/（一章一份，與正文同樣的相對路徑、副檔名 .md：' +
    'chapters/上部/003-夜访.txt 的細綱是 .novelwarden/summaries/上部/003-夜访.md；同步會照正文改它），' +
    '正文在章節根目錄（預設 chapters/，可以分子目錄），' +
    '全文大綱是 .novelwarden/summaries/global.md，角色卡在 .novelwarden/characters/，設定在 .novelwarden/lore/，' +
    '敘事線（劇情線，一條線一個檔案，伏筆掛線上下，可選）在 .novelwarden/threads/，掛不上線的伏筆在 .novelwarden/threads/未归属的伏笔.md。' +
    `一次最多返回 ${LIST_LIMIT} 項，超出會截斷並告訴你還有多少。`,
  parameters: objectSchema({
    path: str('要列的目錄，工程內相對路徑。留空列工程根。'),
  }),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const dir = typeof args.path === 'string' ? args.path.trim() : '';
    // `Workspace.list` 不拋：越界、不存在、讀不動一律空陣列。所以「空」有兩種
    // 含義，這裡不去區分——對模型來說「這裡什麼都沒有」就是它要的答案，
    // 讓它換個路徑再試比給一句它讀不懂的錯誤程式碼有用。
    const entries = await ctx.workspace.list(dir);
    const shown = entries.slice(0, LIST_LIMIT);
    const head = `${dir || '（工程根）'}（${entries.length} 項）`;

    const lines = shown.map((e) =>
      e.type === 'dir'
        ? `  ${e.name}/`
        : `  ${e.name}    ${e.words !== undefined ? `${e.words} 字` : `${e.bytes} 位元組`}`
    );
    if (entries.length > shown.length) {
      lines.push(`  （還有 ${entries.length - shown.length} 項未列出，用 path 引數進子目錄看）`);
    }
    if (entries.length === 0) {
      lines.push('  （空目錄，或這個路徑不存在）');
    }

    return {
      text: [head, ...lines].join('\n'),
      display: { title: `list ${dir || '/'}`, detail: `${entries.length} 項` },
    };
  },
};
