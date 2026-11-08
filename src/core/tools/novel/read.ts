/**
 * `read` —— 讀一份檔案，帶行號。`Workspace.read` 的薄包裝。
 *
 * 兩條上限**取先到的那一個**：400 行 / 20000 字元。行數管的是散文式的
 * markdown（細綱、場景卡），字元數管的是「一行三千字」的正文——只按行數
 * 截的話，一章正文常常是三行，一次就把整章塞進 agent 上下文了。
 *
 * 截斷必須寫在返回文字裡（AGENTS 第 2 條）：模型不知道自己只看了一半，會
 * 拿著半份正文去下結論，而它下的結論看起來跟讀全了一模一樣。
 *
 * **越界與不存在都返回 `error` 而不是拋**：模型看得到 error，據此換個路徑
 * 重試；拋出去只會讓這一輪迴圈炸掉，而它本來只是猜錯了一個檔名。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { int, objectSchema, str } from '../schema';
import { WsError } from '../../workspace';

/** 一次最多讀幾行。 */
export const READ_LINE_LIMIT = 400;
/** 一次最多讀多少字元。正文常常一行幾千字，只按行數截等於不截。 */
export const READ_CHAR_LIMIT = 20000;

export const readTool: ToolDef = {
  name: 'read',
  description:
    '讀一份檔案的內容，返回帶行號的文字。path 是工程內相對路徑、用正斜槓。' +
    `一次最多返回 ${READ_LINE_LIMIT} 行或 ${READ_CHAR_LIMIT} 字元（取先到的），` +
    '截斷時會告訴你還剩多少行，用 offset 接著讀下一段。' +
    'offset 是起始行號（從 1 開始），limit 是最多讀幾行。',
  parameters: objectSchema(
    {
      path: str('要讀的檔案，工程內相對路徑。'),
      offset: int('從第幾行開始讀，從 1 開始。留空從頭讀。'),
      limit: int(`最多讀幾行。留空按上限 ${READ_LINE_LIMIT} 行。`),
    },
    ['path']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rel) {
      return { text: '', error: 'path 是必填的：給一個工程內相對路徑。' };
    }
    // 行號對模型是 1-based（返回值裡就是這麼標的），Workspace 收的是 0-based。
    const from = Math.max(1, toInt(args.offset) ?? 1);
    const want = Math.min(READ_LINE_LIMIT, Math.max(1, toInt(args.limit) ?? READ_LINE_LIMIT));

    let file;
    try {
      file = await ctx.workspace.read(rel, { offset: from - 1, limit: want });
    } catch (err) {
      return { text: '', error: describe(err, rel) };
    }

    const lines = file.text === '' ? [] : file.text.split('\n');
    const total = file.truncated?.total ?? from - 1 + lines.length;

    // 字元上限：逐行累加，超了就停在上一行——切在行中間會讓最後一行看起來
    // 像是原文就那麼短。
    const kept: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (chars + line.length > READ_CHAR_LIMIT && kept.length > 0) {
        break;
      }
      kept.push(line);
      chars += line.length + 1;
    }

    const numbered = kept.map((line, i) => `${from + i}\t${line}`).join('\n');
    const lastRead = from - 1 + kept.length;
    const note =
      lastRead < total
        ? `\n（第 ${lastRead + 1}–${total} 行未讀，共 ${total} 行。用 offset=${lastRead + 1} 接著讀）`
        : '';

    return {
      text: `${rel}${numbered ? `\n${numbered}` : '\n（空檔案）'}${note}`,
      display: { title: `read ${rel}`, detail: `${kept.length} 行` },
    };
  },
};

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * 異常 → 一句模型能照著改的話。
 *
 * `WsError` 的 message 本來就是人話（「檔案不存在：…」「路徑超出工程目錄：…」），
 * 原樣轉述就夠；意外異常給一句通用的，不把呼叫棧餵給模型。
 */
function describe(err: unknown, rel: string): string {
  if (err instanceof WsError) {
    return err.code === 'notFound'
      ? `${err.message}。可以用 list 看看那個目錄下有什麼，或用 search 找找。`
      : err.message;
  }
  return `讀 ${rel} 失敗：${err instanceof Error ? err.message : String(err)}`;
}
