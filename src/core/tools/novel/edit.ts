/**
 * `edit` —— 定點替換一段文字。`Workspace.edit` 的薄包裝。
 *
 * ## 為什麼需要它
 *
 * 改一個人名、修一句臺詞、調一個數字——用 `generate` 重寫整份產物是浪費
 * （一次呼叫、幾百上千 token，還會把作者改過的別處一起換掉），用 `write` 全文
 * 覆蓋則要求模型把整份內容重新吐一遍（既慢又容易漏）。標準 edit 工具的形狀
 * （`old` / `new` / `all`）任何支援工具呼叫的模型都見過，不必另教。
 *
 * ## 四條硬約束
 *
 * 1. **`old` 命中多處且沒給 `all` 時報錯，不改。** 錯誤裡說清命中了幾處，
 *    讓它自己去加上下文把 `old` 變唯一——猜「他大概想改第一處」，改錯的那次
 *    作者要讀完整章才發現。
 * 2. **`old` 找不到時報錯**，並指路「先 read 一遍確認當前內容」。模型憑記憶
 *    拼出來的 `old` 常常差一個標點。
 * 3. **仍然走 `ws.edit` → guard**：越界、回收站、保護路徑、大小上限照樣攔。
 *    這裡一行新的路徑檢查都沒有。
 * 4. **編輯產物類檔案後照樣記賬**：`ws.edit` 內部走 `write` → handler 的
 *    `after`，`upstreamHash` 一期就下沉到寫入路徑本身了。
 *
 * ## 不做多處批次編輯
 *
 * 不收 `edits: [{old,new}]` 陣列。一次一處，出錯時狀態清楚（閘道器那一層雖然
 * 支援「要麼全成要麼全不成」，但模型拿到「第 3 條對不上，整批沒落盤」之後
 * 往往會重發一份改了一半的批次）。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { bool, objectSchema, str } from '../schema';
import { clip, describePath, text } from './naming';
import { WsError, kindOfPath } from '../../workspace';
import { clearFailures, recordFailure } from '../../runtime/errorLog';
import { describeError } from '../../runtime/logger';
import { WRITE_OP } from './write';

export const editTool: ToolDef = {
  name: 'edit',
  mutating: true,

  /**
   * **`always`：任何策略下都要問一句。**
   *
   * 它改的也是已有內容，但 `ws.edit` 走的是「拿這份內容和自己 diff」那條路
   * （`review: false`，理由見 `workspace/index.ts`），所以覆蓋審閱在這裡落成
   * 確認框——框裡寫出的 old → new 兩段原文**就是它的 diff**。放開它，
   * 「覆蓋已有內容一律過一遍人」就有了一個例外（第 25(a) 條）。
   */
  intent(args, project): ToolIntent {
    const target = text(args.path);
    return {
      gate: 'always',
      title: `改「${describePath(target, project)}」裡的一段文字`,
      detail: [
        target,
        `原文：${clip(text(args.old))}`,
        `改成：${clip(text(args.new)) || '（刪掉）'}`,
        args.all === true ? '檔案裡所有出現的地方都改。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '把一份檔案裡的一段文字換成另一段。path 是工程內相對路徑、用正斜槓。' +
    'old 必須與檔案裡的現有內容**逐字相同**（含標點與空格），' +
    '並且在這份檔案裡**唯一**——命中多處會報錯並告訴你幾處，' +
    '這時把 old 寫長一點（帶上前後文）讓它唯一，或者傳 all=true 全部替換。' +
    '改一個名字、修一句話、調一個數字用它，比重新 generate 整份產物省得多。' +
    '拿不準現在寫的是什麼就先 read 一遍。',

  parameters: objectSchema(
    {
      path: str('要改的檔案，工程內相對路徑。'),
      old: str('要被替換掉的原文，逐字相同且在檔案裡唯一。'),
      new: str('替換成什麼。留空表示刪掉這段。'),
      all: bool('命中多處時是否全部替換。預設 false：不唯一就報錯，不猜改哪一處。'),
    },
    ['path', 'old', 'new']
  ),

  check(args) {
    if (!text(args.path)) {
      return 'path 是必填的：給一個工程內相對路徑。';
    }
    if (typeof args.old !== 'string' || !args.old) {
      return 'old 是必填的，而且不能是空串：給一段檔案裡現有的、逐字相同的文字。';
    }
    // `new` 允許是空串（刪掉這一段），所以只校驗型別不校驗長度。
    if (typeof args.new !== 'string') {
      return 'new 是必填的：要替換成什麼。刪掉這一段就傳空字串。';
    }
    return undefined;
  },

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const issue = editTool.check!(args);
    if (issue) {
      return { text: '', error: issue };
    }
    const rel = text(args.path);
    const oldText = args.old as string;
    const newText = args.new as string;
    const all = args.all === true;

    const path = kindOfPath(ctx.project, rel);

    try {
      const r = await ctx.workspace.edit(rel, [{ old: oldText, new: newText, all }]);
      if (path.plotRelPath) {
        await clearFailures(ctx.project, 'plot', path.plotRelPath, WRITE_OP);
      }
      const side = r.side && r.side.length > 0 ? `\n連帶：${r.side.join('；')}` : '';
      return {
        text: `${r.message}${side}`,
        display: { title: `edit ${r.rel}`, detail: r.message.replace(/：.*$/, '') },
      };
    } catch (err) {
      const message = describe(err, rel);
      if (path.plotRelPath) {
        await noteFailure(ctx, path.plotRelPath, `編輯 ${rel} 失敗：${message}`);
      }
      return { text: '', error: message };
    }
  },
};

/**
 * 異常 → 一句模型能照著改的話。
 *
 * 兩條最常見的（找不到、不唯一）各補一句「接下來該怎麼辦」——只回一句
 * 「找不到」，它多半會原地把同一個 `old` 再發一遍。
 */
function describe(err: unknown, rel: string): string {
  if (err instanceof WsError) {
    switch (err.code) {
      case 'notFound':
        return (
          `${err.message}。先 read ${rel} 看一眼當前內容，照著上面的原文（含標點與空格）再來一次。`
        );
      case 'notUnique':
        return `${err.message} 把 old 寫長一點帶上前後文讓它唯一，或者傳 all=true 全部替換。`;
      case 'outOfRoot':
        return `${err.message}。只能改工程目錄之內的相對路徑。`;
      default:
        return err.message;
    }
  }
  return `編輯 ${rel} 失敗：${describeError(err)}`;
}

async function noteFailure(
  ctx: ToolContext,
  plotRelPath: string,
  message: string
): Promise<void> {
  await recordFailure(ctx.project, {
    scope: 'MCP',
    targetKind: 'plot',
    targetKey: plotRelPath,
    severity: 'error',
    op: WRITE_OP,
    message,
    detail: '這一次編輯沒有落盤，磁碟上那份未改動。',
  });
}
