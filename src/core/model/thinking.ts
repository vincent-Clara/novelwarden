/**
 * 思考深度：**這一輪讓模型想多久。**
 *
 * 與 `tiers.ts` 同一個位置的東西——型別、可選值、介面上的
 * 說法在資料層定義一次（純資料 + 純函式、零 import，所以前端可以直接打包
 * 這一份），對映成各家的請求欄位則在兩個 provider 裡各寫一次。
 *
 * ## 一個檔位，兩套欄位
 *
 * 兩家都從「給個 token 預算」走到了「給個檔位」，但欄位名與梯子不一樣：
 *
 * | 檔 | OpenAI Responses | Anthropic Messages |
 * |---|---|---|
 * | 關 | 不帶 `reasoning` | 不帶 `thinking` / `output_config` |
 * | 低 / 中 / 高 | `reasoning.effort: low/medium/high` | `output_config.effort: low/medium/high` |
 * | 極限 | `reasoning.effort: xhigh` | `output_config.effort: max` |
 *
 * 最高那一檔兩家的叫法不同（一個 `xhigh`、一個 `max`），所以對映表分兩張，
 * 介面上仍然只有一個「極限」——作者選的是「想到底」，不是某家的列舉值。
 *
 * ## 為什麼「關」是不帶欄位而不是顯式關掉
 *
 * 顯式關（OpenAI 的 `effort: 'none'`、Anthropic 的 `thinking: {type:'disabled'}`）
 * 都是**部分模型才認**的：前者在老模型上 400，後者在 Claude Fable 5 / Mythos 5
 * 上直接被拒，Opus 5 在 xhigh/max 檔也拒。而「不帶欄位」在所有模型上都合法，
 * 且恰好是這個功能出現之前的行為——所以它才是預設檔：升級不改任何人的請求。
 */

export type ThinkingDepth = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_DEPTHS: ThinkingDepth[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * 預設不思考。
 *
 * 第 4 條（不偷偷燒 token）：思考的 token 按輸出計費，一句「幫我看看這段」
 * 可能因此貴好幾倍。作者主動選了才開。
 */
export const DEFAULT_THINKING_DEPTH: ThinkingDepth = 'off';

/** 下拉框與日誌共用這一份說法，前端不另寫。 */
export const THINKING_LABEL: Record<ThinkingDepth, string> = {
  off: '不思考',
  low: '淺思考',
  medium: '中思考',
  high: '深思考',
  max: '極限思考',
};

export const THINKING_HINT: Record<ThinkingDepth, string> = {
  off: '不帶思考引數，跟隨服務商預設',
  low: '想一下就答，最省錢',
  medium: '折中，日常討論夠用',
  high: '想透了再答，慢且貴',
  max: '想到底（OpenAI 走 xhigh，Claude 走 max）',
};

export function isThinkingDepth(value: unknown): value is ThinkingDepth {
  return typeof value === 'string' && (THINKING_DEPTHS as string[]).includes(value);
}

/** 容錯讀取：認不出一律回落「不思考」，絕不拋。 */
export function normalizeThinkingDepth(value: unknown): ThinkingDepth {
  return isThinkingDepth(value) ? value : DEFAULT_THINKING_DEPTH;
}

/** OpenAI Responses 的 `reasoning.effort`。`undefined` = 不帶 `reasoning` 欄位。 */
export function responsesEffort(depth: ThinkingDepth): string | undefined {
  switch (depth) {
    case 'off':
      return undefined;
    case 'max':
      return 'xhigh';
    default:
      return depth;
  }
}

/** Anthropic 的 `output_config.effort`。`undefined` = 不帶思考欄位。 */
export function anthropicEffort(depth: ThinkingDepth): string | undefined {
  return depth === 'off' ? undefined : depth;
}

/**
 * 老模型（Claude 4.5 及更早）那條路的 `thinking.budget_tokens`。
 *
 * 兩條硬約束來自 API：**最少 1024**，且**必須小於 `max_tokens`**（思考
 * token 算在輸出上限裡）。所以預算按輸出上限收緊，收到 1024 以下就等於
 * 這個模型的輸出上限根本裝不下思考——返回 `undefined`，呼叫方退回不思考，
 * 而不是發一個必然 400 的請求。
 */
export function thinkingBudget(depth: ThinkingDepth, maxOutputTokens: number): number | undefined {
  const wanted = BUDGET[depth];
  if (!wanted) {
    return undefined;
  }
  // 留 1024 給正文：預算等於上限的話，模型想完就沒有額度說話了。
  const room = Math.floor(maxOutputTokens) - 1024;
  const budget = Math.min(wanted, room);
  return budget >= 1024 ? budget : undefined;
}

/** 各檔想要的思考預算。與 Claude Code 的三檔（think / think hard / ultrathink）同源。 */
const BUDGET: Record<ThinkingDepth, number> = {
  off: 0,
  low: 4096,
  medium: 10240,
  high: 24576,
  max: 31999,
};

/**
 * 思考開著時，這個輸出上限夠不夠。
 *
 * 思考的 token **算在輸出上限裡**（兩家都是），所以 4096 的上限配上深思考，
 * 模型可能想完就沒有額度說話了，作者看到的是一段被截斷的回答或者乾脆空白，
 * 而介面上沒有任何東西指向「輸出上限太小」這個原因。
 *
 * 這裡只判斷、不悄悄改：把作者配的上限乘個係數等於替他決定花多少錢。
 * 呼叫方據此 warn 一次（每個模型一次），話說清楚就夠了。
 */
export function outputRoomTooSmall(depth: ThinkingDepth, maxOutputTokens: number): boolean {
  return depth !== 'off' && maxOutputTokens < 8192;
}

/**
 * 降一檔。服務商拒了某個 effort 值（新梯子上的檔位老模型不認）時退一步再試，
 * 而不是把這一輪直接判死。`off` 已經在最底下，返回它自己表示沒得再降。
 */
export function downgradeDepth(depth: ThinkingDepth): ThinkingDepth {
  const i = THINKING_DEPTHS.indexOf(depth);
  return i <= 0 ? 'off' : THINKING_DEPTHS[i - 1];
}
