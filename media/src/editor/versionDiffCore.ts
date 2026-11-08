/**
 * 「版本」對比標籤的純函式（`versionDiff.ts` 用，**零 DOM、零 import**，單測直接跑）：兩版按行比、一處改動裡逐字標出
 * 刪了什麼加了什麼、「用回這一處」該把現在這份的哪一截換成什麼。
 *
 * ## 按行比，不按空行切段
 *
 * 合併檢視（`model/paragraphDiff.ts`）按空行切段：「段首縮排」格式的書段與段之間沒有空行，整章會切成一段。這裡按行
 * 比——三種分段格式裡一行都是一段。**空行不算行，行首行尾的空白不算不同**（VS Code 的 diff 預設也忽略首尾空白）：
 * 一鍵排版補上的縮排、多一個空行不是作者要找的改動；兩版只差這些時介面上照實說「只有空白不同」（{@link onlyWhitespace}）。
 *
 * ## Myers
 *
 * 最短編輯指令碼（Myers 1986），先去掉兩頭相同的行。編輯步數超過上限（{@link MAX_LINE_EDITS}）就不再找，中間那一截整個
 * 當一處改動——整章重寫時找最短指令碼既慢又沒意義。一處改動裡逐字比也是它（按碼點，上限 {@link MAX_CHAR_EDITS}，
 * 超了就只標整行），比完把夾在兩處改動中間的一兩個字並進改動：中文沒有詞界，「的」「了」這種碰巧相同的單字會把
 * 一句改寫切成碎片。
 *
 * ## 位置
 *
 * 兩邊先把 `\r\n` / `\r` 歸一成 `\n`（textarea 的 `value` 就是這樣），所有下標按歸一後的文字算——與編輯區
 * `area.value` 同一套，{@link revertEdit} 給的範圍可以直接交給 `Pane.applyEdit`。
 */

/** 一行（不算空行）：在全文裡的 `[start, end)`（不含換行）。 */
export interface DiffLine {
  start: number;
  end: number;
  text: string;
}

/** 連著的一截：兩邊一樣的幾行，或一處改動（左邊刪掉的幾行、右邊加上的幾行，可以一邊是空的）。行號是 `[from, to)`。 */
export interface DiffBlock {
  kind: 'same' | 'change';
  left: [number, number];
  right: [number, number];
}

export interface LineDiff {
  /** 歸一換行之後的兩份全文。 */
  before: string;
  after: string;
  left: DiffLine[];
  right: DiffLine[];
  blocks: DiffBlock[];
  /** 幾處改動。 */
  changes: number;
}

/** 行級編輯步數的上限：超了中間整個當一處。 */
export const MAX_LINE_EDITS = 2000;
/** 一處改動裡逐字比的編輯步數上限：超了只標整行。 */
export const MAX_CHAR_EDITS = 1200;
/** 夾在兩處改動中間、並進改動的相同文字最多幾個字。 */
const NOISE_CHARS = 2;

export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** 全文裡的非空行（只有空白的行也不算）。 */
export function textLines(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(start, end);
    if (line.trim() !== '') {
      out.push({ start, end, text: line });
    }
    start = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------- Myers

/** 0 兩邊一樣（各進一步），1 刪掉左邊一個，2 加上右邊一個。 */
type Op = 0 | 1 | 2;

/** `a` → `b` 的最短編輯指令碼；步數超過 `maxD` 給 undefined。 */
function editScript<T>(a: readonly T[], b: readonly T[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) {
    return [];
  }
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 第 d 步開始時存下第 d-1 步的結果（只存這一步用得到的 [-d-1, d+1] 那一截），倒推時認它。
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) {
      return undefined;
    }
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m);
      }
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], last: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (down) {
      ops.push(2);
      y--;
    } else {
      ops.push(1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  return ops.reverse();
}

// ---------------------------------------------------------------- 按行

/** 兩版按行比。空行不算，行首行尾的空白不算不同。 */
export function diffLines(beforeText: string, afterText: string): LineDiff {
  const before = normalizeEol(beforeText);
  const after = normalizeEol(afterText);
  const left = textLines(before);
  const right = textLines(after);
  const ka = left.map((l) => l.text.trim());
  const kb = right.map((l) => l.text.trim());

  // 兩頭一樣的先去掉，只在中間那一截上找。
  let head = 0;
  while (head < ka.length && head < kb.length && ka[head] === kb[head]) {
    head++;
  }
  let tail = 0;
  while (tail < ka.length - head && tail < kb.length - head && ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]) {
    tail++;
  }
  const midA = ka.slice(head, ka.length - tail);
  const midB = kb.slice(head, kb.length - tail);
  const script = editScript(midA, midB, MAX_LINE_EDITS) ?? [...midA.map((): Op => 1), ...midB.map((): Op => 2)];
  const ops: Op[] = [...Array<Op>(head).fill(0), ...script, ...Array<Op>(tail).fill(0)];

  const blocks: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    const kind = op === 0 ? 'same' : 'change';
    let last = blocks[blocks.length - 1];
    if (last?.kind !== kind) {
      last = { kind, left: [i, i], right: [j, j] };
      blocks.push(last);
    }
    if (op !== 2) {
      i++;
      last.left[1] = i;
    }
    if (op !== 1) {
      j++;
      last.right[1] = j;
    }
  }
  return { before, after, left, right, blocks, changes: blocks.filter((b) => b.kind === 'change').length };
}

/** 兩版文字不一樣，但按行比沒有一處改動：只差空行、行首行尾的空白（縮排）。 */
export function onlyWhitespace(diff: LineDiff): boolean {
  return diff.changes === 0 && diff.before !== diff.after;
}

/** 一處改動兩邊各自的文字：那幾行原樣（行首空白也在），行與行之間一個換行。 */
export function blockText(diff: LineDiff, block: DiffBlock, side: 'left' | 'right'): string {
  const lines = side === 'left' ? diff.left : diff.right;
  const [from, to] = block[side];
  return lines
    .slice(from, to)
    .map((l) => l.text)
    .join('\n');
}

// ---------------------------------------------------------------- 逐字

/** 一處改動裡兩邊逐字比：左邊刪掉的、右邊加上的各是哪幾截（下標按 {@link blockText} 那段文字，UTF-16）。 */
export interface CharMarks {
  left: [number, number][];
  right: [number, number][];
}

/** 逐字比。太長、改得太多（超過上限）給 undefined：只標整行。 */
export function charDiff(a: string, b: string): CharMarks | undefined {
  const ca = Array.from(a);
  const cb = Array.from(b);
  // 兩頭一樣的先去掉。
  let head = 0;
  while (head < ca.length && head < cb.length && ca[head] === cb[head]) {
    head++;
  }
  let tail = 0;
  while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail]) {
    tail++;
  }
  const script = editScript(ca.slice(head, ca.length - tail), cb.slice(head, cb.length - tail), MAX_CHAR_EDITS);
  if (!script) {
    return undefined;
  }
  const ops = absorbNoise([...Array<Op>(head).fill(0), ...script, ...Array<Op>(tail).fill(0)]);

  // 碼點 → UTF-16 下標。
  const units = (chars: string[]) => {
    const at = [0];
    for (const c of chars) {
      at.push(at[at.length - 1] + c.length);
    }
    return at;
  };
  const ua = units(ca);
  const ub = units(cb);
  const marks: CharMarks = { left: [], right: [] };
  const push = (list: [number, number][], from: number, to: number) => {
    const last = list[list.length - 1];
    if (last && last[1] === from) {
      last[1] = to;
    } else {
      list.push([from, to]);
    }
  };
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 0) {
      i++;
      j++;
    } else if (op === 1) {
      push(marks.left, ua[i], ua[i + 1]);
      i++;
    } else {
      push(marks.right, ub[j], ub[j + 1]);
      j++;
    }
  }
  return marks;
}

/** 夾在兩處改動中間、不超過 {@link NOISE_CHARS} 個字的相同文字：兩邊都當改了（先刪後加）。 */
function absorbNoise(ops: Op[]): Op[] {
  const runs: { op: Op; len: number }[] = [];
  for (const op of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === op) {
      last.len++;
    } else {
      runs.push({ op, len: 1 });
    }
  }
  const out: Op[] = [];
  runs.forEach((run, k) => {
    const between = run.op === 0 && k > 0 && k < runs.length - 1;
    if (between && run.len <= NOISE_CHARS) {
      out.push(...Array<Op>(run.len).fill(1), ...Array<Op>(run.len).fill(2));
    } else {
      out.push(...Array<Op>(run.len).fill(run.op));
    }
  });
  return out;
}

// ---------------------------------------------------------------- 用回這一處

/** 對右邊（現在這份）全文的一次替換：把 `[start, end)` 換成 `text`。 */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * 「用回這一處」：把右邊這一處換回左邊那樣。換的是右邊那幾行連同它們之間的分隔；左邊那幾行連同它們之間原來的分隔原樣搬過來。
 * - 兩邊都有：右邊第一行行首到最後一行行尾，換成左邊第一行行首到最後一行行尾。
 * - 只有右邊（現在多出來的）：連同它前面那道分隔一起刪（在開頭就連同後面那道）。
 * - 只有左邊（現在少了的）：插在右邊前一行之後，前面補上左邊原來的那道分隔（在開頭就插在右邊第一行之前，後面補分隔）。
 */
export function revertEdit(diff: LineDiff, block: DiffBlock): TextEdit {
  const { left, right, before, after } = diff;
  const [i1, i2] = block.left;
  const [j1, j2] = block.right;
  const oldText = i2 > i1 ? before.slice(left[i1].start, left[i2 - 1].end) : '';
  if (j2 > j1 && i2 > i1) {
    return { start: right[j1].start, end: right[j2 - 1].end, text: oldText };
  }
  if (j2 > j1) {
    if (j1 > 0) {
      return { start: right[j1 - 1].end, end: right[j2 - 1].end, text: '' };
    }
    return { start: right[j1].start, end: j2 < right.length ? right[j2].start : right[j2 - 1].end, text: '' };
  }
  // 只有左邊：現在少了這幾行，插回去。
  const sepBefore = i1 > 0 ? before.slice(left[i1 - 1].end, left[i1].start) : '\n';
  const sepAfter = i2 < left.length ? before.slice(left[i2 - 1].end, left[i2].start) : '\n';
  if (j1 > 0) {
    const at = right[j1 - 1].end;
    return { start: at, end: at, text: `${sepBefore}${oldText}` };
  }
  if (right.length > 0) {
    const at = right[0].start;
    return { start: at, end: at, text: `${oldText}${sepAfter}` };
  }
  return { start: after.length, end: after.length, text: oldText };
}
