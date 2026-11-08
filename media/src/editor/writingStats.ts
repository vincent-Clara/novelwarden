/**
 * 碼字統計的純邏輯（零 DOM、不碰 localStorage、時間由呼叫方給）：一處改動算多少字、哪些改動算作者碼的字、
 * 撤銷 / 重做退的是哪一步、停筆多久不算時長、速度、目標進度怎麼說、「今日碼字」那份記錄怎麼讀怎麼合。
 * 裝配（監聽編輯區、畫狀態列、記 localStorage）在 `stats.ts`，口徑在這裡——`tests/unit/editor/writingStats.test.js`
 * 釘著。
 *
 * ## 碼字口徑
 *
 * 「碼了多少字」是**作者在編輯區裡親手打進去的淨字數**（字數口徑同 `words.ts`：中文按字、英文按詞，標點空白不算）：
 *
 * - **算**：鍵盤打字（`typing`），輸入法上屏的那一下（`composition` 帶 `change`），在名詞補全裡挑了一個名字
 *   補上的那幾個字（`completion`，⚑：和輸入法在候選詞裡挑一個是同一回事——名字是作者自己要寫的字，只是打得快些；
 *   不算的話常用補全的人碼字數會偏少）。退格、Delete、打字蓋掉選區刪掉的字**倒扣**——所以是「淨」增加，打了又刪等於沒打。
 * - **不算**：貼上、剪下、拖放（`input`），一切程式改寫（`program`：回車與 Tab 補的空白、成對符號補的半邊、
 *   段落快捷鍵、一鍵排版、半形轉全形、替換 / 全部替換、對比合併、歷史版本恢復、還原、用磁碟版本覆蓋、
 *   磁碟同步換進來的新版、右鍵貼上），輸入法組字中途（拼音還沒上屏）。
 * - **撤銷 / 重做跟著那一步走**（⚑）：撤銷的是自己打的字，那幾個字減回去；重做再加上；撤銷的是一次貼上、
 *   排版這類本來就沒算的改動，碼字數不動。靠 `EditHistory.topId` 認出是哪一步（{@link StepLedger}）。
 *
 * ## 時長
 *
 * 只算真正在寫的時間：每一下落筆（打字、輸入法，組字中途也算）離上一下不超過 {@link IDLE_MS}（2 分鐘，⚑）的
 * 那一段記進時長，停筆更久那一段整個不算——掛著頁面去吃飯，回來速度不會被拉低。兩次落筆之間的那段記到後一下
 * 落筆的那份檔案上，所以各檔案的時長加起來就是總時長。
 */
import type { EditSource } from './api';
import type { TextChange } from './history';
import { countWords, groupDigits, isWordCode } from './words';

/** 停筆超過這麼久，那一段不算碼字時長（⚑ 2 分鐘）。 */
export const IDLE_MS = 2 * 60_000;
/** 寫夠這麼久才報速度：頭幾十秒的速度沒有意義（⚑ 1 分鐘）。 */
export const MIN_SPEED_MS = 60_000;
/** 「今日碼字」在 localStorage 裡留最近幾天（只顯示今天；多留幾天不佔地方，跨午夜補記前一天也有處落）。 */
export const DAILY_KEEP = 30;

// ---------------------------------------------------------------- 一處改動算多少字

/**
 * 這一處改動讓全文多了（或少了）幾個字，與改動前後各數一遍全文再相減的結果一字不差，但只看改動那一段：
 * 中文一個字一個字數，跟前後文無關；英文按詞，改動挨著的那個詞可能被接長、劈開或並起來，所以兩頭各往外
 * 擴到詞的邊界再比。`after` 是改動之後的全文，`change` 的位置按改動之前的文字算（`history.ts` 的約定）。
 */
export function wordDelta(after: string, change: TextChange): number {
  const end = change.at + change.inserted.length;
  let left = change.at;
  while (left > 0 && isWordCode(after.charCodeAt(left - 1))) {
    left--;
  }
  let right = end;
  while (right < after.length && isWordCode(after.charCodeAt(right))) {
    right++;
  }
  const head = after.slice(left, change.at);
  const tail = after.slice(end, right);
  return countWords(head + change.inserted + tail) - countWords(head + change.removed + tail);
}

/** 這一下改動算不算作者碼的字：鍵盤打字、輸入法上屏（帶 `change` 的那一下）、名詞補全裡挑的名字。 */
export function countsAsWriting(source: EditSource, change: TextChange | undefined): boolean {
  return !!change && (source === 'typing' || source === 'composition' || source === 'completion');
}

/** 這一下算不算「在寫」（時長的心跳）：打字與輸入法（組字中途也算——拼音還沒上屏，人確實在寫）、挑了一個補全。 */
export function isWritingActivity(source: EditSource): boolean {
  return source === 'typing' || source === 'composition' || source === 'completion';
}

// ---------------------------------------------------------------- Markdown 標題行

/** 與 core `stripH1`（`model/markdown.ts`）同一條規則：去掉首尾空白之後開頭的那個 `# 標題`。 */
const H1_RE = /^#\s+.+?(\r?\n|$)/;

/**
 * Markdown 正文開頭那一行 `# 標題` 裡有幾個字。後端數一章寫了多少字（工程頁、章節條、寫夠了沒有）時**不算**
 * 這一行（`countWords(stripH1(body))`），編輯器裡數章節字數同樣減掉它，兩邊才對得上。
 */
export function headingWords(text: string): number {
  const m = H1_RE.exec(text.trimStart());
  return m ? countWords(m[0]) : 0;
}

// ---------------------------------------------------------------- 撤銷 / 重做退的是哪一步

/**
 * 一份檔案的撤銷歷史（`EditHistory`）裡，每一步計入了多少碼字。撤銷那一步就減回去、重做再加上；
 * 那一步本來沒計入（貼上、排版……）就什麼都不動。
 *
 * 用法：每一次 `edit` 事件之後調一次——打字 / 上屏 / 程式改寫調 {@link afterEdit}（帶這一下計入的字數，
 * 不計入的給 0），撤銷調 {@link afterUndo}，重做調 {@link afterRedo}，引數都是事件發生之後的 `history.topId`。
 * 編輯區每改一次歷史都緊跟一條 `edit` 事件（`pane.ts`），所以上一次見到的棧頂就是撤銷之前的棧頂。
 */
export class StepLedger {
  private readonly counted = new Map<number, number>();
  private top: number | undefined;

  afterEdit(topId: number | undefined, words: number): void {
    if (topId !== undefined && words !== 0) {
      this.counted.set(topId, (this.counted.get(topId) ?? 0) + words);
    }
    this.top = topId;
  }

  /** 撤銷之後：返回碼字數要跟著變多少（撤銷自己打的字是負數）。 */
  afterUndo(topId: number | undefined): number {
    const undone = this.top;
    this.top = topId;
    const words = undone === undefined || undone === topId ? 0 : this.counted.get(undone) ?? 0;
    return words === 0 ? 0 : -words;
  }

  /** 重做之後：重做回來的那一步就是新的棧頂。 */
  afterRedo(topId: number | undefined): number {
    const before = this.top;
    this.top = topId;
    return topId === undefined || topId === before ? 0 : this.counted.get(topId) ?? 0;
  }
}

// ---------------------------------------------------------------- 本次碼字

/** 一份檔案在這次裡碼了多少。 */
export interface FileTally {
  path: string;
  /** 記下來那一刻它叫什麼（「第 3 章《夜訪》」「細綱 · 第 3 章」……）。檔案關掉了明細裡照樣寫得出。 */
  title: string;
  words: number;
  ms: number;
}

/**
 * 「本次碼字」：從開啟頁面（或「重新開始計時」）起。按檔案分別記，彙總成總數。
 * 時長的規則見檔案頭：兩下落筆之間不超過 {@link IDLE_MS} 的那段記進去，記在後一下落筆的那份檔案上。
 */
export class WritingSession {
  words = 0;
  ms = 0;
  readonly files = new Map<string, FileTally>();
  private last: number | undefined;

  constructor(readonly startedAt: number) {}

  /** 一下落筆。返回這一下記進時長的毫秒數（「今日」也要加上同樣的數）。 */
  touch(path: string, title: string, at: number): number {
    const gap = this.last === undefined ? 0 : at - this.last;
    const add = gap > 0 && gap <= IDLE_MS ? gap : 0;
    // 時鐘往回呼（改了系統時間）時不倒退，免得下一下算出一段很長的「在寫」。
    this.last = this.last === undefined ? at : Math.max(this.last, at);
    const tally = this.tally(path, title);
    tally.ms += add;
    this.ms += add;
    return add;
  }

  /** 這份檔案碼了（或退了）幾個字。 */
  add(path: string, title: string, words: number): void {
    if (words === 0) {
      return;
    }
    this.tally(path, title).words += words;
    this.words += words;
  }

  /** 檔案改了名：明細跟著換路徑。新路徑已經有一份時並進去。 */
  rename(from: string, to: string): void {
    const old = this.files.get(from);
    if (!old || from === to) {
      return;
    }
    this.files.delete(from);
    const into = this.files.get(to);
    if (into) {
      into.words += old.words;
      into.ms += old.ms;
    } else {
      this.files.set(to, { ...old, path: to });
    }
  }

  /** 按檔案的明細，碼字多的在前（一樣多時寫得久的在前）。 */
  breakdown(): FileTally[] {
    return [...this.files.values()].sort((a, b) => b.words - a.words || b.ms - a.ms);
  }

  private tally(path: string, title: string): FileTally {
    let tally = this.files.get(path);
    if (!tally) {
      tally = { path, title, words: 0, ms: 0 };
      this.files.set(path, tally);
    } else if (title) {
      tally.title = title;
    }
    return tally;
  }
}

/** 每小時多少字。寫了不到 {@link MIN_SPEED_MS}、或者淨字數不是正的，不報（undefined）。 */
export function speedPerHour(words: number, ms: number): number | undefined {
  if (ms < MIN_SPEED_MS || words <= 0) {
    return undefined;
  }
  return Math.round((words * 3_600_000) / ms);
}

/** 「42 分鐘」「2 小時 5 分」「不到 1 分鐘」。 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return '不到 1 分鐘';
  }
  if (minutes < 60) {
    return `${minutes} 分鐘`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/** 帶符號的字數：「+356」「-12」「0」。 */
export function signedWords(n: number): string {
  return n > 0 ? `+${groupDigits(n)}` : groupDigits(n);
}

// ---------------------------------------------------------------- 距目標

export interface GoalProgress {
  words: number;
  target: number;
  /** 寫了目標的幾成（可以超過 1）。 */
  ratio: number;
  /** 「3,120 / 4,000 字」 */
  count: string;
  /** 「還差 880」「超出 120」「正好寫夠」 */
  rest: string;
  /** 到了八成（後端判「寫夠了」的線，第 21 條）。 */
  enough: boolean;
  over: boolean;
}

/** 本章字數與目標的進度。沒有目標（不是正數）時 undefined。 */
export function goalProgress(words: number, target: number | undefined): GoalProgress | undefined {
  if (!target || !(target > 0)) {
    return undefined;
  }
  const diff = target - words;
  return {
    words,
    target,
    ratio: words / target,
    count: `${groupDigits(words)} / ${groupDigits(target)} 字`,
    rest: diff > 0 ? `還差 ${groupDigits(diff)}` : diff < 0 ? `超出 ${groupDigits(-diff)}` : '正好寫夠',
    enough: words >= target * 0.8,
    over: diff < 0,
  };
}

// ---------------------------------------------------------------- 今日碼字

/** 一天碼了多少：淨字數與時長（口徑與「本次」相同）。 */
export interface DayTally {
  words: number;
  ms: number;
}

/** 本地日期 → 那一天的數。鍵是 `YYYY-MM-DD`（本地時區，過了午夜就是新的一天）。 */
export type DailyRecord = Record<string, DayTally>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 這一刻是本地的哪一天。 */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 讀 localStorage 裡那一份。**壞值一律回落**：不是 JSON、形狀不對、某一天的數不是有限數，就當那一天（或整份）
 * 沒有——這只是碼字習慣資料，讀不懂就從零記，不報錯、不崩。
 */
export function parseDaily(raw: string | null | undefined): DailyRecord {
  let data: unknown;
  try {
    data = JSON.parse(raw || 'null');
  } catch {
    return {};
  }
  const days = data && typeof data === 'object' ? (data as { days?: unknown }).days : undefined;
  if (!days || typeof days !== 'object' || Array.isArray(days)) {
    return {};
  }
  const out: DailyRecord = {};
  for (const [key, value] of Object.entries(days as Record<string, unknown>)) {
    const v = value as { words?: unknown; ms?: unknown } | null;
    if (
      DAY_RE.test(key) &&
      v &&
      typeof v === 'object' &&
      typeof v.words === 'number' &&
      Number.isFinite(v.words) &&
      typeof v.ms === 'number' &&
      Number.isFinite(v.ms) &&
      v.ms >= 0
    ) {
      out[key] = { words: Math.round(v.words), ms: Math.round(v.ms) };
    }
  }
  return out;
}

export function serializeDaily(record: DailyRecord): string {
  return JSON.stringify({ v: 1, days: record });
}

/**
 * 把一個視窗攢下的增量加進存著的那一份（**加，不是覆蓋**：幾個視窗同開一個工程時各加各的增量，誰也不會
 * 把別人記的沖掉，也不會重複算）。只留最近 {@link DAILY_KEEP} 天。不改傳進來的兩份。
 */
export function addDaily(stored: DailyRecord, increment: DailyRecord, keep = DAILY_KEEP): DailyRecord {
  const out: DailyRecord = {};
  for (const [key, v] of Object.entries(stored)) {
    out[key] = { ...v };
  }
  for (const [key, v] of Object.entries(increment)) {
    const cur = out[key] ?? { words: 0, ms: 0 };
    out[key] = { words: cur.words + v.words, ms: cur.ms + v.ms };
  }
  const keys = Object.keys(out).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - keep))) {
    delete out[key];
  }
  return out;
}

/** 往一份增量裡記一筆（就地改）。 */
export function bumpDaily(record: DailyRecord, at: number, words: number, ms: number): void {
  if (words === 0 && ms === 0) {
    return;
  }
  const key = dayKey(at);
  const cur = record[key] ?? { words: 0, ms: 0 };
  record[key] = { words: cur.words + words, ms: cur.ms + ms };
}
