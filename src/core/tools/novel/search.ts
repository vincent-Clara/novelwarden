/**
 * `search` —— 全文檢索。`workspace/search.ts` 的薄包裝。
 *
 * 這是三期唯一的**新能力**：作者問「主角前面說過他沒去過北境嗎」，從前只能
 * 靠他自己手動 `@` 引用幾章原文，跨章對賬根本做不了。零模型呼叫的樸素掃描
 * 一上來就解決它——與「新鮮度只靠 hash 傳播」（第 18 條）是同一條取捨：
 * 能用確定性方法算出來的，不花 token。
 *
 * 兩件必須做對的事：
 *
 * 1. **`dropped > 0` 一定寫進返回文字**（第 2 條）。搜尋的丟棄尤其危險：
 *    模型看到「命中 2 處」會當成「全書只有 2 處」，然後據此斷言主角從沒提過
 *    北境——而真相是第 40 處被上限截掉了。
 * 2. **按章號升序**（`search.ts` 已經這麼排了，這裡只是不去打亂它）。作者問的
 *    是「他**前面**說過嗎」，時間線順序才有意義。
 */
import type { ToolContext, ToolDef, ToolResult } from '../types';
import { bool, int, objectSchema, str, strArray } from '../schema';
import type { ArtifactKind } from '../../workspace';

/** 一次最多返回幾條命中。 */
export const SEARCH_LIMIT = 40;
/** 每個檔案最多幾條，免得一份長文件吃掉全部名額。 */
export const SEARCH_PER_FILE = 4;

/** `kinds` 引數的候選值。與 `workspace/kind.ts` 的 `ArtifactKind` 同源。 */
// 沒有 `outline`：情節大綱是各章細綱梗概的彙總，沒有檔案，搜 `plot` 就搜到了。
const KINDS: ArtifactKind[] = [
  'setting',
  'style',
  'globalSummary',
  'threads',
  'skill',
  'plot',
  'chapter',
  'draft',
  'character',
  'lore',
  'other',
];

export const searchTool: ToolDef = {
  name: 'search',
  description:
    '在工程裡全文檢索，返回命中的行（帶路徑與行號），**按章號升序**。' +
    '預設按字面量搜（作者搜的多半是人名地名），regex=true 才當正則。' +
    'path 可限定目錄，kinds 可限定產物種類（setting=小說配置 / 故事前提 / 世界觀，' +
    'plot=細綱（情節大綱就是各章細綱的「梗概」，搜它就搜到了），chapter=正文，character=角色卡，lore=設定，style=文風指南，' +
    'globalSummary=全文大綱，threads=敘事線（.novelwarden/threads/ 下一條線一個檔案），draft=章節草稿）。' +
    `一次最多返回 ${SEARCH_LIMIT} 條、每個檔案最多 ${SEARCH_PER_FILE} 條；` +
    '有命中因為超上限被丟掉時會明確告訴你丟了幾條——那時不要斷言「全書只有這幾處」。',
  parameters: objectSchema(
    {
      pattern: str('要找的字串（或正則）。'),
      path: str('限定在這個目錄下搜，工程內相對路徑。留空搜全工程。'),
      kinds: strArray(`限定產物種類，可多個。可用值：${KINDS.join(' / ')}。`),
      regex: bool('把 pattern 當正則。預設 false（按字面量搜）。'),
      limit: int(`最多返回幾條，上限 ${SEARCH_LIMIT}。`),
    },
    ['pattern']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern.trim()) {
      return { text: '', error: 'pattern 是必填的：給一個要找的字串。' };
    }
    const limit = Math.min(SEARCH_LIMIT, Math.max(1, toInt(args.limit) ?? SEARCH_LIMIT));

    const r = await ctx.workspace.search(pattern, {
      path: typeof args.path === 'string' ? args.path : undefined,
      kinds: pickKinds(args.kinds),
      regex: args.regex === true,
      perFile: SEARCH_PER_FILE,
      limit,
      // 上下文行不帶：agent 拿到路徑與行號之後可以自己 read 那一段，
      // 而前後文乘以 40 條就是幾千 token 的重複內容。
      context: 0,
    });

    const lines = r.hits.map((h) => `${h.rel}:${h.line}  ${h.text.trim()}`);
    const foot = [`（命中 ${r.hits.length} 處，掃了 ${r.scanned} 個檔案）`];
    if (r.dropped > 0) {
      // 不靜默截斷。模型據此知道「這不是全部」，別拿它當全書結論。
      foot.push(`⚠ 因超上限丟棄 ${r.dropped} 條——這不是全部命中，縮小 path 或 kinds 再搜一次。`);
    }
    if (r.note) {
      foot.push(`⚠ ${r.note}`);
    }
    if (r.hits.length === 0) {
      lines.push('（沒有命中）');
    }

    return {
      text: [...lines, ...foot].join('\n'),
      display: {
        title: `search「${clip(pattern)}」`,
        detail: `${r.hits.length} 處命中${r.dropped > 0 ? `，丟棄 ${r.dropped}` : ''}`,
      },
    };
  },
};

/**
 * 認不出的種類名一律丟掉，全丟光就當沒限定——不因為一個錯字搜出空結果。`outline` 認成 `plot`：情節大綱是各章細綱的梗概，
 * 照老說法要搜大綱的，搜細綱就是。
 */
function pickKinds(raw: unknown): ArtifactKind[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const known = raw
    .map((k) => (k === 'outline' ? 'plot' : k))
    .filter((k): k is ArtifactKind => (KINDS as string[]).includes(k as string));
  return known.length > 0 ? known : undefined;
}

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 20 ? `${one.slice(0, 20)}…` : one;
}
