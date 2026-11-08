/**
 * 刪修飾：寫完正文之後的一輪「只許刪」修稿，這裡是它的純函式——編號、讀回、驗收、保底。
 *
 * 為什麼只許刪：flash-lite 這一檔的模型寫正文時管不住修飾（名詞前堆形容詞、動詞前掛程度副詞），
 * 提示詞與寫作技能怎麼說都壓不下來；但「從一段話裡刪掉多餘的字」它做得好，而且刪沒刪、加沒加
 * 是程式碼能確定地驗收的。實測與取捨見 docs/design/plans/2026-10-03-plain-prose.md。
 *
 * 驗收逐段做，不合格的段退回原文，其餘照用：一段被改壞不該連累整章。
 */

/** 一段裡允許新增的漢字數：刪掉半句之後偶爾要補一個「的」「地」「了」才通順。 */
export const TRIM_MAX_ADDED_HAN = 2;

/** 一段刪完至少留原來的這麼多（按漢字算）。刪得更狠的多半是把情節刪了。 */
export const TRIM_MIN_KEEP_RATIO = 0.4;

/**
 * 開著刪修飾時寫正文往多寫幾成：刪修飾一章刪掉一到兩成，按目標字數寫、刪完就跌破八成，保底又把刪改
 * 退回去（novel-test 第 91–100 章，十章七章觸發）。所以給模型的篇幅與續寫的判據都按目標的這麼多倍。
 */
export const TRIM_HEADROOM = 1.2;

/** 寫正文時給模型、給續寫判據的篇幅：開著刪修飾按 {@link TRIM_HEADROOM} 放大，取整到百字。 */
export function writingAim(target: number | undefined, trim: boolean): number | undefined {
  return trim && target ? Math.round((target * TRIM_HEADROOM) / 100) * 100 : target;
}

/** 新寫的正文不到這麼多字就不跑這一輪：幾句話沒什麼可刪的，白花一次呼叫。 */
export const TRIM_MIN_CHARS = 200;

const HAN = /[一-鿿]/g;

function hanCount(text: string): number {
  return text.match(HAN)?.length ?? 0;
}

/** 段裡的對白（中文雙引號、直角引號）。刪修飾不碰對白：人物怎麼說話歸角色設定管。 */
export function quotesOf(text: string): string[] {
  return text.match(/“[^”]*”|「[^」]*」/g) ?? [];
}

/** 按空行切段。段內的單個換行留著。 */
export function trimParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t　]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 給模型的那份：每段前面一個 `[n]`。 */
export function numberParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join('\n\n');
}

/**
 * 讀回模型的輸出：`[n] 正文`，一行一段。編號越界、重複的丟掉（取第一個）；沒出現的編號就是
 * 這一段沒交回來，驗收時當退回處理。
 */
export function parseNumbered(output: string, count: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of output.matchAll(/^\s*\[(\d+)\]\s*(.*)$/gm)) {
    const no = Number(m[1]);
    if (no >= 1 && no <= count && !out.has(no)) {
      out.set(no, m[2].trim());
    }
  }
  return out;
}

/**
 * 新版裡多出來的字：按字做最長公共子序列，新版裡不在公共子序列上的就是加的。段落只有幾百字，
 * n × m 的表放得下。
 */
export function addedChars(before: string, after: string): string {
  const a = [...before];
  const b = [...after];
  const n = a.length;
  const m = b.length;
  // 行 i 存 a[i..] 與 b[j..] 的 LCS 長度，倒著填，正著走一遍取出 b 裡沒配上的字。
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let added = '';
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      added += b[j];
      j++;
    }
  }
  return added;
}

/** 一段刪得合不合格。合格返回 undefined，否則返回退回的原因（進說明）。 */
export function trimProblem(before: string, after: string): string | undefined {
  if (!after.trim()) {
    return '整段刪光了';
  }
  const q1 = quotesOf(before);
  const q2 = quotesOf(after);
  if (q1.length !== q2.length || q1.some((q, i) => q !== q2[i])) {
    return '動了對白';
  }
  const added = addedChars(before, after);
  if (hanCount(added) > TRIM_MAX_ADDED_HAN) {
    return '加了原文沒有的字';
  }
  if (hanCount(after) < hanCount(before) * TRIM_MIN_KEEP_RATIO) {
    return '刪得太多';
  }
  // 結尾的句末標點換了，往往是把最後一句刪成了半句。
  if (before.slice(-1) !== after.slice(-1)) {
    return '改了段尾';
  }
  return undefined;
}

export interface TrimOutcome {
  /** 刪完的正文，段間空一行。 */
  text: string;
  /** 真的刪了字的段數。 */
  changed: number;
  /** 退回原文的段：原因 → 段數。 */
  rejected: Map<string, number>;
  /** 為了保住篇幅又退回的段數（見 {@link applyTrim} 的 `floor`）。 */
  restored: number;
}

/**
 * 逐段驗收、拼回正文。
 *
 * `floor`：刪完之後這一段正文至少要有多少字（按 `countWords` 那把尺子，由呼叫方給）。寫正文的
 * 「寫夠了」看的是目標字數的八成，刪修飾把一章刪到八成以下，主按鈕就會轉去推「接著寫」，等於
 * 白刪；所以刪多了就從刪得最多的段開始退回原文，直到夠數為止。
 */
export function applyTrim(
  paragraphs: readonly string[],
  edits: ReadonlyMap<number, string>,
  opts: { floor?: number; countWords?: (text: string) => number } = {}
): TrimOutcome {
  const rejected = new Map<string, number>();
  const result = paragraphs.map((before, i) => {
    const after = edits.get(i + 1);
    if (after === undefined) {
      rejected.set('沒交回來', (rejected.get('沒交回來') ?? 0) + 1);
      return before;
    }
    const why = trimProblem(before, after);
    if (why) {
      rejected.set(why, (rejected.get(why) ?? 0) + 1);
      return before;
    }
    return after;
  });

  let restored = 0;
  const count = opts.countWords;
  if (opts.floor !== undefined && count) {
    const order = result
      .map((after, i) => ({ i, cut: count(paragraphs[i]) - count(after) }))
      .filter((x) => x.cut > 0)
      .sort((x, y) => y.cut - x.cut);
    let total = count(result.join('\n\n'));
    for (const { i, cut } of order) {
      if (total >= opts.floor) {
        break;
      }
      result[i] = paragraphs[i];
      total += cut;
      restored++;
    }
  }

  return {
    text: result.join('\n\n'),
    changed: result.filter((after, i) => after !== paragraphs[i]).length,
    rejected,
    restored,
  };
}
