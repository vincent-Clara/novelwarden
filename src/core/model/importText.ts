/**
 * 拆書的純函式：一整本 txt → 一章一份。**零 I/O、絕不拋**（第 1 條：作者給什麼都不崩）。
 *
 * 兩條路共用：「匯入原稿」把作者自己的稿子切成 `chapters/NNN-标题.txt`；「從參考書學寫法」
 * 把別人的書切開、抽幾章樣章（features/importManuscript.ts、features/reference.ts）。
 *
 * 借鑑 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）的匯入：上游切章只認三條正則
 * （`electron/controllers/import-controller.ts:56-66`：`第X章`、`Chapter N`、`# 第X章`），
 * 認不出就把整個檔案當一章。這裡多認了「回 / 節」、序章楔子番外、卷標題，丟掉目錄裡那一串空標題；
 * 認不出就不匯入（作者的原稿被當成一章塞進來，比拒絕更難收拾）。
 *
 * ## 切章的判據只在這裡
 *
 * 一行算章標題要同時滿足：去掉 `#` 與空白之後不超過 {@link HEADING_MAX} 字、不以句末標點收尾、
 * 開頭是 `第X章`（中文或阿拉伯數字，`回`/`節` 後面還得跟分隔符或行尾——「第三回合」是正文）、
 * `Chapter N`，或序章 / 楔子 / 引子 / 尾聲 / 終章 / 番外。`第X卷/部/集` 那一行是卷標題：不算章、丟掉，
 * 說一聲。
 */
import { countWords } from './fs';

// ---------------------------------------------------------------- 解碼

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

/**
 * 位元組 → 文字。BOM 說了算；沒有 BOM 時先按 UTF-8 嚴格解，解不了就當 GB18030（中文 txt 小說
 * 最常見的另一種編碼，GBK 是它的子集）。換行統一成 `\n`。
 */
export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  const decode = (encoding: TextEncodingName, from: number, fatal = false): string =>
    new TextDecoder(encoding, { fatal }).decode(bytes.subarray(from));
  let text: string;
  let encoding: TextEncodingName;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    text = decode('utf-8', 3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    text = decode('utf-16le', 2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    text = decode('utf-16be', 2);
  } else {
    try {
      text = decode('utf-8', 0, true);
      encoding = 'utf-8';
    } catch {
      text = decode('gb18030', 0);
      encoding = 'gb18030';
    }
  }
  return { text: text.replace(/\r\n?/g, '\n'), encoding };
}

/**
 * 讀工程裡的檔案給 agent 看、數字數、檢索用：UTF-8 原樣返回（不動換行與 BOM，與寫盤那條路讀到的一字不差），
 * 不是 UTF-8 才走 `decodeTextBytes`——作者丟進工程的 txt 常是 GBK，按 UTF-8 讀出來是一屏亂碼。
 */
export function decodeFileText(bytes: Uint8Array): string {
  const decoded = decodeTextBytes(bytes);
  return decoded.encoding === 'utf-8' ? Buffer.from(bytes).toString('utf8') : decoded.text;
}

/** 確認框裡怎麼稱呼這種編碼。 */
export const ENCODING_LABEL: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16',
  'utf-16be': 'UTF-16',
  gb18030: 'GBK / GB18030',
};

// ---------------------------------------------------------------- 認標題

/** 章標題一行最長几個字。再長就是正文。 */
export const HEADING_MAX = 40;

const NUM = '[0-9０-９零〇○一二两兩三四五六七八九十百千千万萬]+';
const SEP = '[\\s：:、.．·\\-—｜|]';
/** 「第X章」後面可以直接跟標題；「第X回 / 節」後面必須是分隔符或行尾（「第三回合」「第二節課」是正文）。 */
const CHAPTER_HEAD = new RegExp(`^第\\s*${NUM}\\s*(?:章(.*)|[回节節](?:${SEP}+(.*))?)$`);
const VOLUME_HEAD = new RegExp(`^第\\s*${NUM}\\s*[卷部集](?:$|${SEP})`);
const EN_HEAD = /^chapter\s+\d+\b[\s:：.\-—]*(.*)$/i;
/** 序章、楔子這幾樣後面跟的標題不長（「番外篇 舊事」「楔子·雨夜」）；整行仍受 {@link HEADING_MAX} 與句末標點約束。 */
const SPECIAL_HEAD = /^(?:序章|楔子|引子|尾(?:声|聲)|(?:终|終)章|番外)(?:$|.{0,20}$)/;
/** 正文的句子收尾。標題幾乎不以它們結尾。 */
const SENTENCE_END = /[。！？!?…”」』，,；;]$/;
const SEPARATORS = new RegExp(`^${SEP}+|${SEP}+$`, 'g');

/** 行首行尾的空白（含全形空格、不換行空格、BOM）。 */
function trimAll(line: string): string {
  return line.replace(/^[\s　 ﻿]+|[\s　 ]+$/g, '');
}

function stripHashes(line: string): string {
  return trimAll(line.replace(/^\s*#{1,6}\s*/, ''));
}

export type HeadingKind = 'chapter' | 'volume';

/** 一行是不是標題；是章標題時交回標題（可能為空：「第一章」一行什麼都沒寫）。 */
export function classifyHeading(raw: string): { kind: HeadingKind; title: string } | undefined {
  const line = stripHashes(raw);
  if (!line || line.length > HEADING_MAX || SENTENCE_END.test(line)) {
    return undefined;
  }
  if (VOLUME_HEAD.test(line)) {
    return { kind: 'volume', title: line };
  }
  const zh = CHAPTER_HEAD.exec(line);
  if (zh) {
    return { kind: 'chapter', title: (zh[1] ?? zh[2] ?? '').replace(SEPARATORS, '') };
  }
  const en = EN_HEAD.exec(line);
  if (en) {
    return { kind: 'chapter', title: en[1].replace(SEPARATORS, '') };
  }
  if (SPECIAL_HEAD.test(line)) {
    return { kind: 'chapter', title: line.replace(SEPARATORS, '') };
  }
  return undefined;
}

// ---------------------------------------------------------------- 切章

export interface SplitChapter {
  /** 章名（不帶「第X章」）。原文那一行只寫了「第一章」時為空。 */
  title: string;
  /** 原文裡的那一行標題，確認框裡給作者看。按字數切的段沒有。 */
  heading: string;
  /** 規整過的正文：一段一行、段間空一行。 */
  body: string;
  words: number;
}

export interface SplitResult {
  chapters: SplitChapter[];
  /** 第一個標題之前的文字（書名、作者、簡介）：不匯入。 */
  preface: { words: number; head: string };
  /** 卷標題那幾行：不算章，丟掉。 */
  volumes: string[];
  /** 標題下面一個字都沒有的（目錄裡那一串）：跳過。 */
  empty: string[];
}

/**
 * 一整本 → 一章一份。認不出任何章標題時 `chapters` 為空——呼叫方據此拒絕匯入，或者（學寫法時）
 * 改用 {@link splitBySize}。
 */
export function splitChapters(text: string): SplitResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters: SplitChapter[] = [];
  const volumes: string[] = [];
  const empty: string[] = [];
  const prefaceLines: string[] = [];
  let seenHeading = false;
  let current: { title: string; heading: string; lines: string[] } | undefined;

  const flush = () => {
    if (!current) {
      return;
    }
    const body = normalizeParagraphs(current.lines);
    const words = countWords(body);
    if (words === 0) {
      empty.push(current.heading);
    } else {
      chapters.push({ title: current.title, heading: current.heading, body, words });
    }
    current = undefined;
  };

  for (const line of lines) {
    const head = classifyHeading(line);
    if (head) {
      seenHeading = true;
      flush();
      if (head.kind === 'volume') {
        volumes.push(head.title);
      } else {
        current = { title: head.title, heading: stripHashes(line), lines: [] };
      }
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (!seenHeading) {
      prefaceLines.push(line);
    }
  }
  flush();

  const preface = normalizeParagraphs(prefaceLines);
  return {
    chapters,
    preface: { words: countWords(preface), head: clipLine(preface, 40) },
    volumes,
    empty,
  };
}

/** 沒有章標題的書（學寫法時）：按段落攢到約 `size` 字切一段。標題是「第 N 段」。 */
export function splitBySize(text: string, size = 3000): SplitChapter[] {
  const paragraphs = normalizeParagraphs(text.split('\n')).split('\n\n').filter(Boolean);
  const out: SplitChapter[] = [];
  let buf: string[] = [];
  let words = 0;
  const flush = () => {
    if (buf.length > 0) {
      const body = buf.join('\n\n');
      out.push({ title: `第 ${out.length + 1} 段`, heading: '', body, words: countWords(body) });
      buf = [];
      words = 0;
    }
  };
  for (const p of paragraphs) {
    buf.push(p);
    words += countWords(p);
    if (words >= size) {
      flush();
    }
  }
  flush();
  return out;
}

/** 每個非空行一段、段間空一行，去掉行首行尾的空白（含全形空格）。 */
export function normalizeParagraphs(lines: readonly string[]): string {
  return lines.map(trimAll).filter(Boolean).join('\n\n');
}

function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// ---------------------------------------------------------------- 抽樣與節選

/** 從 `total` 份裡均勻抽 `count` 份的下標（0 起、升序、不重複）：首尾必在，中間均勻。 */
export function evenSample(total: number, count: number): number[] {
  const n = Math.max(0, Math.floor(total));
  const k = Math.max(0, Math.floor(count));
  if (n === 0 || k === 0) {
    return [];
  }
  if (n <= k) {
    return Array.from({ length: n }, (_, i) => i);
  }
  if (k === 1) {
    return [0];
  }
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) {
    picked.add(Math.round((i * (n - 1)) / (k - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * 學寫法時看結構用的那幾章（下標）：開頭 `opening` 章（開篇自成一套寫法），加全書 30% 處連續
 * `window` 章（過了開篇、還沒進高潮的日常推進）。書太短時兩段會重疊，去重。
 */
export function structureSample(total: number, opening = 3, window = 3): number[] {
  const n = Math.max(0, Math.floor(total));
  const picked = new Set<number>();
  for (let i = 0; i < Math.min(opening, n); i++) {
    picked.add(i);
  }
  const start = Math.max(opening, Math.floor(n * 0.3));
  for (let i = start; i < Math.min(start + window, n); i++) {
    picked.add(i);
  }
  return [...picked].sort((a, b) => a - b);
}

/** 開頭 `head` 字（按字元），超出時在末尾寫明省略了多少。 */
export function headOf(text: string, head: number): string {
  return text.length <= head ? text : `${text.slice(0, head)}\n\n（後略 ${text.length - head} 字）`;
}

/** 開頭 `head` 字 + 結尾 `tail` 字，中間省略的那一段寫明字數。不夠長就整份。 */
export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) {
    return text;
  }
  return `${text.slice(0, head)}\n\n（中略 ${text.length - head - tail} 字）\n\n${text.slice(text.length - tail)}`;
}

// ---------------------------------------------------------------- 篇幅統計（零呼叫）

export interface ShapeStats {
  chapters: number;
  /** 每章字數的平均與中位數。 */
  avgWords: number;
  medianWords: number;
  /** 每章幾段（平均）、每段幾個字（平均）。 */
  avgParagraphs: number;
  avgParagraphWords: number;
  /** 含對白（引號）的段落佔幾成，0–100。 */
  dialoguePercent: number;
}

const QUOTE = /[“”「」『』"]/;

/** 一本書的篇幅形狀：給學寫法那一次呼叫當資料——模型自己數不準。 */
export function shapeStats(chapters: readonly Pick<SplitChapter, 'body' | 'words'>[]): ShapeStats {
  if (chapters.length === 0) {
    return { chapters: 0, avgWords: 0, medianWords: 0, avgParagraphs: 0, avgParagraphWords: 0, dialoguePercent: 0 };
  }
  const words = chapters.map((c) => c.words).sort((a, b) => a - b);
  const paragraphs = chapters.flatMap((c) => c.body.split('\n\n').filter(Boolean));
  const total = words.reduce((s, w) => s + w, 0);
  const mid = Math.floor(words.length / 2);
  return {
    chapters: chapters.length,
    avgWords: Math.round(total / chapters.length),
    medianWords: words.length % 2 === 1 ? words[mid] : Math.round((words[mid - 1] + words[mid]) / 2),
    avgParagraphs: Math.round(paragraphs.length / chapters.length),
    avgParagraphWords: paragraphs.length > 0 ? Math.round(total / paragraphs.length) : 0,
    dialoguePercent:
      paragraphs.length > 0 ? Math.round((paragraphs.filter((p) => QUOTE.test(p)).length / paragraphs.length) * 100) : 0,
  };
}

export function describeShape(s: ShapeStats): string {
  return [
    `- 全書 ${s.chapters} 章；每章平均 ${s.avgWords} 字，中位數 ${s.medianWords} 字`,
    `- 每章平均 ${s.avgParagraphs} 段，每段平均 ${s.avgParagraphWords} 字`,
    `- 含對白的段落約佔 ${s.dialoguePercent}%`,
  ].join('\n');
}

// ---------------------------------------------------------------- 規模

/** 已寫的章平均多長，取整到百（小說配置「每章字數」的預設）。一章正文都沒有時 undefined。 */
export function roundedAverageWords(words: readonly number[]): number | undefined {
  const written = words.filter((w) => w > 0);
  if (written.length === 0) {
    return undefined;
  }
  return Math.max(100, Math.round(written.reduce((s, w) => s + w, 0) / written.length / 100) * 100);
}

/** 沒寫總章數時問作者的預設值：已寫章數的兩倍取整到 50，不少於 100。 */
export function defaultTotalChapters(written: number): number {
  return Math.max(100, Math.ceil((Math.max(0, written) * 2) / 50) * 50);
}

// ---------------------------------------------------------------- 參考書的寫法技能

/** 名字留給 `-寫法` 與去重字尾的餘量：技能名最長 64（`model/writingSkill.ts` 的 `isSkillName`）。 */
const SKILL_NAME_BODY_MAX = 54;

/**
 * 參考書的寫法技能叫什麼：書名（檔名去副檔名）+ `-寫法`，不合規的字元換成 `-`；`taken` 裡已經有了
 * 就加 `-2`、`-3`。書名清洗完是空的就叫「參考書-寫法」。規則與 `isSkillName` 一致：字母或數字開頭，
 * 只含字母、數字、`._-`。
 */
export function referenceSkillName(bookTitle: string, taken: ReadonlySet<string>): string {
  const cleaned = bookTitle
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .slice(0, SKILL_NAME_BODY_MAX)
    .replace(/[-._]+$/, '');
  const base = `${cleaned || '參考書'}-寫法`;
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}-${i}`;
  }
  return name;
}

/** 寫法技能的 `SKILL.md`：frontmatter 是上游那份手寫格式（一行一個鍵），`stage: planning`。 */
export function renderReferenceSkill(input: { name: string; bookTitle: string; body: string }): string {
  const title = input.bookTitle.replace(/[\r\n]+/g, ' ').trim() || '參考書';
  return [
    '---',
    `name: ${input.name}`,
    `display_name: 《${title}》的寫法`,
    `description: 從參考書《${title}》拆出的結構與節奏寫法，規劃大綱與細綱時參考；只學怎麼排，不照搬它的情節與人物。`,
    'stage: planning',
    'version: 1',
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
}
