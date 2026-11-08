/**
 * 重演檢測：新寫的這一章，開頭是不是把上一章的結尾又演了一遍。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts`
 * 的 `hasSubstantialPreviousChapterReuse`（GD:276-317）與 `chapter-materials.ts` 的
 * `previousChapterEnding`（:88-97）。
 *
 * ## 為什麼要查
 *
 * 模型拿到「上一章結尾原文」之後，最常見的失敗不是接不上，而是**從那裡重新演一遍**：
 * 同一場對話、同一個動作鏈換幾個字再寫一次。讀者讀到第二章開頭就會覺得見過。
 * 提示詞裡說了「不可重演」（context/prompts.ts），這裡是寫完之後的那道核對。
 *
 * ## 判法
 *
 * 兩邊各自歸一（NFKC、小寫、去空白與標點），把上一章結尾切成 8 字一段的 n-gram，
 * 標出新稿前 1200 字裡被這些 n-gram 覆蓋的位置；**連續覆蓋 ≥ 80 字**才算重演。
 * 零星撞上幾個片語（人名 + 動詞）湊不出 80 字的連續段，刻意呼應的一句臺詞通常也湊不出。
 *
 * ## 不在這裡決定拒不拒收
 *
 * 上游命中就整份作廢。這裡只報「命中了、重合的是哪一段」，由卡片標紅、讓作者點兩下
 * 再寫入（總計劃 §2.4）——有時重合的是作者要的呼應，判斷得交給人。
 */

/** 上一章結尾取多少字。 */
export const PREVIOUS_ENDING_CHARS = 1000;
/** 新稿只看開頭這麼多字：重演只會出在開頭。 */
export const REPLAY_HEAD_CHARS = 1200;
/** 中文按 8 字一段比對（上游 `CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS`）。 */
export const REPLAY_NGRAM = 8;
/** 連續覆蓋這麼多字才算重演（上游 `CROSS_CHAPTER_REUSE_LONG_RUN_CHARS`）。 */
export const REPLAY_RUN = 80;

/**
 * 上一章的結尾：最後約 {@link PREVIOUS_ENDING_CHARS} 字，開頭對齊到段落或句子邊界——
 * 從半句話開始比對，第一個 n-gram 就是殘的。
 */
export function previousEnding(text: string, max = PREVIOUS_ENDING_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const tail = trimmed.slice(-max);
  const boundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail);
  return boundary ? tail.slice(boundary.index + boundary[0].length).trim() || tail.trim() : tail.trim();
}

export interface ReplayVerdict {
  hit: boolean;
  /** 新稿裡重合的那一段原文（帶標點），給作者看。 */
  quote?: string;
  /** 那一段歸一之後有多少字。 */
  run?: number;
}

/** 空白、標點、符號：歸一時一律去掉。 */
const NOISE = /[\s\p{P}\p{S}]/u;

/** 逐個碼點歸一，記下每個留下來的字在原文裡的位置——命中之後要把原文那一段摘出來。 */
function normalizeWithPositions(text: string): { chars: string[]; pos: number[] } {
  const chars: string[] = [];
  const pos: number[] = [];
  let index = 0;
  for (const cp of text) {
    for (const ch of cp.normalize('NFKC').toLowerCase()) {
      if (!NOISE.test(ch)) {
        chars.push(ch);
        pos.push(index);
      }
    }
    index += cp.length;
  }
  return { chars, pos };
}

/**
 * 新稿開頭有沒有大段重演上一章結尾。
 *
 * 任一邊歸一之後不到一個 n-gram 就不判（`hit: false`）——第 1 章、上一章只有幾個字，
 * 都不是這道檢查要管的事。
 */
export function detectReplay(prevEnding: string, draft: string): ReplayVerdict {
  const prev = normalizeWithPositions(prevEnding).chars.join('');
  const headText = draft.slice(0, REPLAY_HEAD_CHARS);
  const head = normalizeWithPositions(headText);
  const n = REPLAY_NGRAM;
  if (prev.length < n || head.chars.length < n) {
    return { hit: false };
  }

  const grams = new Set<string>();
  for (let i = 0; i <= prev.length - n; i++) {
    grams.add(prev.slice(i, i + n));
  }
  const line = head.chars.join('');
  const covered = new Uint8Array(head.chars.length);
  for (let i = 0; i <= line.length - n; i++) {
    if (grams.has(line.slice(i, i + n))) {
      covered.fill(1, i, i + n);
    }
  }

  // 找最長的一段連續覆蓋：報給作者的是最刺眼的那一處。
  let best = { start: 0, length: 0 };
  let start = -1;
  for (let i = 0; i <= covered.length; i++) {
    if (i < covered.length && covered[i]) {
      if (start < 0) {
        start = i;
      }
      continue;
    }
    if (start >= 0 && i - start > best.length) {
      best = { start, length: i - start };
    }
    start = -1;
  }
  if (best.length < REPLAY_RUN) {
    return { hit: false };
  }
  const from = head.pos[best.start];
  const last = head.pos[best.start + best.length - 1];
  // 末字可能是一個代理對（生僻字），按碼點取完整。
  const to = last + (headText.codePointAt(last)! > 0xffff ? 2 : 1);
  return { hit: true, quote: headText.slice(from, to), run: best.length };
}
