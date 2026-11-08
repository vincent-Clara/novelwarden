/**
 * 正文的分段格式與一鍵排版：工程級設定 `paragraphStyle`（`config.md` 的 frontmatter）的取值與說法、
 * 各格式的段分隔，以及兩個排版用的純函式——`formatProse`（按格式重排段落）與 `toFullWidthPunct`
 * （中文語境裡的半形標點轉全形）。
 *
 * **純函式、零 import**：內建編輯器（`media/src/editor/`）直接打包它——回車插什麼、一鍵排版排成
 * 什麼樣，與後端認的是同一份；日後生成鏈要按格式整理模型的輸出也用這一份。
 *
 * ## 三種格式
 *
 * | 值 | 中文 | 段與段之間 | 段首 |
 * |---|---|---|---|
 * | `blank`（預設） | 空行分段 | 空一行 | 不縮排 |
 * | `indent` | 段首縮排 | 不空行 | 兩個全形空格 |
 * | `both` | 縮排加空行 | 空一行 | 兩個全形空格 |
 *
 * 標題行（`#` 開頭）與只有符號的場景分隔行（`* * *`、`※`、`◇◇◇`……）不縮排，但段與段之間照樣按格式隔開。
 */

/** 三種分段格式。順序即選單裡的順序。 */
export const PARAGRAPH_STYLES = ['blank', 'indent', 'both'] as const;

export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

/** `config.md` 裡沒寫（或寫壞了）時用的格式：空行分段、段首不縮排。 */
export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = 'blank';

/** 介面上的說法。作者在 frontmatter 裡寫這幾個中文也認（`parseParagraphStyle`）。 */
export const PARAGRAPH_STYLE_LABEL: Record<ParagraphStyle, string> = {
  blank: '空行分段',
  indent: '段首縮排',
  both: '縮排加空行',
};

/** 一句話說明，選單項的提示用。 */
export const PARAGRAPH_STYLE_HINT: Record<ParagraphStyle, string> = {
  blank: '段與段之間空一行，段首不縮排（網文常見）',
  indent: '段首兩個全形空格，段與段之間不空行（出版常見）',
  both: '段首兩個全形空格，段與段之間再空一行',
};

/** 正文段首的縮排：兩個全形空格。 */
export const PROSE_INDENT = '　　';

export function isParagraphStyle(value: unknown): value is ParagraphStyle {
  return typeof value === 'string' && (PARAGRAPH_STYLES as readonly string[]).includes(value);
}

/** 英文值（不分大小寫）、中文說法都認，認不出就是 undefined（不猜）。 */
export function parseParagraphStyle(raw: string): ParagraphStyle | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }
  const lower = s.toLowerCase();
  return PARAGRAPH_STYLES.find((v) => v === lower || PARAGRAPH_STYLE_LABEL[v] === s);
}

/** 段與段之間的換行：空一行的兩種是 `\n\n`，段首縮排是 `\n`。 */
export function paragraphGap(style: ParagraphStyle): string {
  return style === 'indent' ? '\n' : '\n\n';
}

/** 段首縮排：縮排的兩種是兩個全形空格，空行分段沒有。 */
export function paragraphIndent(style: ParagraphStyle): string {
  return style === 'blank' ? '' : PROSE_INDENT;
}

/** 另起一段要插的字：段間換行 + 新一段的段首縮排（回車、Ctrl+Enter 用）。 */
export function paragraphBreak(style: ParagraphStyle): string {
  return paragraphGap(style) + paragraphIndent(style);
}

// ---------------------------------------------------------------- 一鍵排版

/** 標題行：去掉首尾空白後以 `#` 開頭。不縮排。 */
export function isHeadingLine(line: string): boolean {
  return line.trim().startsWith('#');
}

/**
 * 只有符號的場景分隔行（`---`、`***`、`* * *`、`※`、`◇◇◇`、`＊＊＊`……）。不縮排。
 * 省略號與破折號**不在其列**：一行「……」或「——」多半是一句話（沉默、被打斷），要當段落縮排。
 */
const SCENE_BREAK = /^[\s\-*_=~#·•∙・＊※⁂◇◆○●◎□■△▲▽▼☆★♢♦◈❖✦✧✱❋＝－～]+$/u;

export function isSceneBreakLine(line: string): boolean {
  const s = line.trim();
  return s !== '' && SCENE_BREAK.test(s);
}

/**
 * 頂部的 frontmatter：`---` 開頭、`---` 收尾，中間每一行都像 YAML（`鍵: 值`、`  - 項`、`# 註釋`、空行）。
 * 要求中間像 YAML，是為了不把開頭就是場景分隔線 `---` 的正文誤當成 frontmatter。
 */
const FRONTMATTER = /^---\n(?:(?:[A-Za-z_][\w-]*\s*:.*|\s+-.*|\s*#.*|\s*)\n)*?---(?:\n|$)/;

export interface LayoutOptions {
  /**
   * 排的是一段節選（編輯器裡選中的那幾行）：不認 frontmatter、文末不補換行、
   * 首尾的空行直接去掉（呼叫方已經把範圍收到非空行上）。
   */
  fragment?: boolean;
}

export interface LayoutResult {
  text: string;
  /** 改了幾處：重排過的行數 + 改過的段間隔 + 文首文末的空白各算一處。沒變就是 0。 */
  changes: number;
}

/**
 * 按分段格式重排正文，並數出改了幾處。
 *
 * - 頂部 frontmatter 原樣保留；`\r\n` 當 `\n`。
 * - 每個非空行是一段：去掉首尾空白（半形 / 全形空格、不換行空格、製表符），段首按格式縮排。
 * - 標題行（`#` 開頭）與場景分隔行只去首尾空白、不縮排。
 * - 段與段之間按格式隔開（空一行或不空行），原來空了幾行都收成這一種。
 * - 文末恰好一個換行（`fragment` 時不補）。
 */
export function layoutProse(input: string, style: ParagraphStyle, opts: LayoutOptions = {}): LayoutResult {
  let changes = input.includes('\r') ? 1 : 0;
  const bom = !opts.fragment && input.startsWith('﻿') ? '﻿' : '';
  let text = (bom ? input.slice(1) : input).replace(/\r\n?/g, '\n');

  let head = '';
  const fm = opts.fragment ? null : FRONTMATTER.exec(text);
  if (fm) {
    head = fm[0].endsWith('\n') ? fm[0] : `${fm[0]}\n`;
    text = text.slice(fm[0].length);
  }

  const gap = paragraphGap(style);
  const indent = paragraphIndent(style);
  const blocks: string[] = [];
  /** 這一行在 `text` 裡從哪起。 */
  let pos = 0;
  /** 上一段末尾的位置（還沒有段時是文首）：它與這一段之間隔著的就是原來的段間隔。 */
  let prevEnd = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    const content = line.trim();
    if (content === '') {
      continue;
    }
    const formatted = isHeadingLine(content) || isSceneBreakLine(content) ? content : indent + content;
    if (formatted !== line) {
      changes++;
    }
    const between = text.slice(prevEnd, start);
    if (blocks.length === 0) {
      // 文首的空行要去掉（節選的首尾空行不算：呼叫方已經把範圍收到非空行上）。
      if (between !== '' && !opts.fragment) {
        changes++;
      }
    } else if (between !== gap) {
      changes++;
    }
    blocks.push(formatted);
    prevEnd = start + line.length;
  }

  if (blocks.length === 0) {
    // 只有空白（或什麼都沒有）：排成空的。
    if (text !== '' && !opts.fragment) {
      changes++;
    }
    return { text: bom + head, changes };
  }
  if (!opts.fragment && text.slice(prevEnd) !== '\n') {
    changes++;
  }
  return { text: bom + head + blocks.join(gap) + (opts.fragment ? '' : '\n'), changes };
}

/** {@link layoutProse} 只要文字的那一半。 */
export function formatProse(text: string, style: ParagraphStyle, opts?: LayoutOptions): string {
  return layoutProse(text, style, opts).text;
}

// ---------------------------------------------------------------- 半形標點轉全形

/** 一處替換：在原文 `at` 處把 `from` 換成 `to`。 */
export interface PunctEdit {
  at: number;
  from: string;
  to: string;
}

export interface PunctResult {
  text: string;
  /** 換了幾處（一對引號算兩處，`...` → `……` 算一處）。 */
  changes: number;
  /** 每一處替換，按位置升序。呼叫方據此挪游標。 */
  edits: PunctEdit[];
}

const HAN = /\p{Script=Han}/u;
/** 中文標點與引號：CJK 符號區、全形區、彎引號、省略號、破折號、間隔號。 */
const CN_PUNCT = /[　-〿＀-￯‘’“”…—·]/u;

/** 算不算中文語境裡的字：漢字、中文標點、彎引號。 */
function isChineseContext(ch: string | undefined): boolean {
  return !!ch && (HAN.test(ch) || CN_PUNCT.test(ch));
}

const FULL_WIDTH: Record<string, string> = {
  ',': '，',
  '.': '。',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};

/**
 * 不該動的地方：頂部 frontmatter、Markdown 程式碼（圍欄與行內）、網址、郵箱。標成 true 的下標原樣照抄。
 */
function protectedMask(text: string, fragment: boolean): Uint8Array {
  const mask = new Uint8Array(text.length);
  const mark = (from: number, to: number) => mask.fill(1, from, to);
  if (!fragment) {
    const fm = FRONTMATTER.exec(text);
    if (fm) {
      mark(0, fm[0].length);
    }
  }
  // 圍欄程式碼塊：``` 或 ~~~ 開頭的行到下一個同樣的行（沒收尾就到文末）。
  const fence = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
  for (const m of text.matchAll(fence)) {
    mark(m.index!, m.index! + m[0].length);
  }
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    mark(m.index!, m.index! + m[0].length);
  }
  // 網址與郵箱只認 ASCII（碰到漢字就斷開），末尾跟著的標點算句子的、不算網址的（`見 https://a.com/x.` 那個句點要轉）。
  for (const re of [/\b(?:https?|ftp):\/\/[!-~]+/gi, /\bwww\.[!-~]+/gi, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g]) {
    for (const m of text.matchAll(re)) {
      const url = m[0].replace(/[.,;:!?)\]'"]+$/, '');
      mark(m.index!, m.index! + url.length);
    }
  }
  return mask;
}

/**
 * 中文語境裡的半形標點轉全形，並列出每一處。
 *
 * - **前一個字是漢字（或中文標點、彎引號）時**，半形 `, . ? ! : ;` 轉成全形。數字之間（`3.14`、
 *   `1,000`）、英文句子、`文件名.md` 這類（`.` 後面緊跟字母數字）不動。
 * - `...`（三個及以上）挨著中文時、`。。。` 一律轉成 `……`。
 * - 漢字（或中文標點）之間的 `--` / `---` 轉成 `——`。
 * - 一對半形括號：括號裡有漢字，或裡面沒有英文字母且外面挨著漢字（`(1)第一條`），兩邊一起轉成全形；
 *   `f(x)的` 這種不動。落單的括號不動。
 * - 直雙引號：同一行裡成對出現、每一對中間都有漢字時，按出現順序轉成 “”；落單、或某一對裡沒有
 *   漢字就不動。直單引號一律不動——英文的撇號（`don't`）會把配對攪亂。
 * - 頂部 frontmatter、Markdown 程式碼（圍欄與行內）、網址、郵箱原樣不動。
 *
 * `range` 給了就只改這一段裡的字（判語境照樣看前後文）；`fragment` 表示 `text` 本身是一段節選，
 * 不認 frontmatter。
 */
export function fullWidthPunct(
  text: string,
  opts: { range?: { start: number; end: number }; fragment?: boolean } = {}
): PunctResult {
  const mask = protectedMask(text, !!opts.fragment);
  const lo = opts.range ? Math.max(0, opts.range.start) : 0;
  const hi = opts.range ? Math.min(text.length, opts.range.end) : text.length;
  const inRange = (i: number) => i >= lo && i < hi && !mask[i];

  /** 預先定好的單字替換：下標 → 新字（引號與括號要成對判，先算好）。 */
  const preset = new Map<number, string>();
  presetQuotes(text, inRange, preset);
  presetBrackets(text, inRange, preset);

  const edits: PunctEdit[] = [];
  let out = '';
  /** 輸出裡的上一個字：判語境要看替換之後的樣子（`"你好",` 裡的逗號跟在 ” 後面）。 */
  const prevOut = () => out[out.length - 1];
  const put = (at: number, from: string, to: string) => {
    edits.push({ at, from, to });
    out += to;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!inRange(i)) {
      out += ch;
      i++;
      continue;
    }
    const preset1 = preset.get(i);
    if (preset1 !== undefined) {
      put(i, ch, preset1);
      i++;
      continue;
    }
    // 省略號：三個及以上的 . 或 。
    if (ch === '.' || ch === '。') {
      let j = i;
      while (j < hi && text[j] === ch && !mask[j]) {
        j++;
      }
      if (j - i >= 3 && (ch === '。' || isChineseContext(prevOut()) || isChineseContext(text[j]))) {
        put(i, text.slice(i, j), '……');
        i = j;
        continue;
      }
      if (j - i >= 2) {
        // 兩個點、或英文裡的省略號：原樣照抄，不拆開逐個判。
        out += text.slice(i, j);
        i = j;
        continue;
      }
    }
    // 破折號：漢字之間的 -- / ---
    if (ch === '-') {
      let j = i;
      while (j < hi && text[j] === '-' && !mask[j]) {
        j++;
      }
      if (j - i >= 2 && j - i <= 3 && isChineseContext(prevOut()) && isChineseContext(text[j])) {
        put(i, text.slice(i, j), '——');
        i = j;
        continue;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const full = FULL_WIDTH[ch];
    if (full && isChineseContext(prevOut()) && !(ch === '.' && /[A-Za-z0-9]/.test(text[i + 1] ?? ''))) {
      put(i, ch, full);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, changes: edits.length, edits };
}

/** {@link fullWidthPunct} 只要文字的那一半。 */
export function toFullWidthPunct(text: string, opts?: { range?: { start: number; end: number }; fragment?: boolean }): string {
  return fullWidthPunct(text, opts).text;
}

/** 直雙引號：一行裡成對、每一對中間有漢字的，按順序轉成 “”。 */
function presetQuotes(text: string, ok: (i: number) => boolean, preset: Map<number, string>): void {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const quotes: number[] = [];
    for (let i = lineStart; i < lineEnd; i++) {
      if (text[i] === '"' && ok(i)) {
        quotes.push(i);
      }
    }
    if (quotes.length > 0 && quotes.length % 2 === 0) {
      for (let k = 0; k < quotes.length; k += 2) {
        const open = quotes[k];
        const close = quotes[k + 1];
        if (HAN.test(text.slice(open + 1, close))) {
          preset.set(open, '“');
          preset.set(close, '”');
        }
      }
    }
    if (nl === -1) {
      break;
    }
    lineStart = nl + 1;
  }
}

/** 半形括號：成對的才轉，判據見 {@link fullWidthPunct}。 */
function presetBrackets(text: string, ok: (i: number) => boolean, preset: Map<number, string>): void {
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      // 括號不跨行配對。
      stack.length = 0;
    } else if (ch === '(' && ok(i)) {
      stack.push(i);
    } else if (ch === ')' && ok(i) && stack.length > 0) {
      const open = stack.pop()!;
      const inner = text.slice(open + 1, i);
      const hasHan = HAN.test(inner);
      const outside = isChineseContext(text[open - 1]) || isChineseContext(text[i + 1]);
      if (hasHan || (outside && !/[A-Za-z]/.test(inner))) {
        preset.set(open, '（');
        preset.set(i, '）');
      }
    }
  }
}
