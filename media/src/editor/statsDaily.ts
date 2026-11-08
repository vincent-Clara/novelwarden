/**
 * 「今日碼字」記在哪、幾個視窗怎麼合（獨立版內建編輯器，`stats.ts` 用）。
 *
 * ## 記在瀏覽器裡，不進工程
 *
 * localStorage `novelforge.editor.stats.daily@<工程>`（`projectStorageKey`，鍵裡帶工程根目錄），形狀
 * `{ v: 1, days: { 'YYYY-MM-DD': { words, ms } } }`，留最近 30 天，只顯示今天。這只是碼字習慣資料，丟了無所謂：
 * **不往工程目錄寫、也不往 SQLite 寫**。讀不懂（壞值）就當沒有、從零記（`parseDaily`）。網址上沒有工程標識、
 * 或者瀏覽器不讓記（隱私模式、配額滿），就只在這一頁的記憶體裡算——面板上照實說一句。
 *
 * ## 幾個視窗同開一個工程
 *
 * **各視窗只加自己的增量，不寫自己的總數**：碼一下記進這個視窗的「待寫」（按當時的工程鍵與本地日期分開），
 * 至多 {@link FLUSH_MS} 寫一次——寫的時候現讀 localStorage 裡那一份、加上待寫的、寫回去（`addDaily`），待寫清零。
 * 所以誰也不會把別的視窗記的沖掉，也不會重複算。頁面藏起來、關掉、換工程時立刻寫。別的視窗寫了，這邊收
 * `storage` 事件換上新的那份重畫。顯示的是「上次讀到的 + 自己還沒寫進去的」。讀改寫之間還隔著別的視窗的
 * 讀改寫的話（幾毫秒之內兩邊同時寫）會丟一筆——瀏覽器不給 localStorage 加鎖，這點誤差可以接受。
 *
 * 跨午夜：每一筆按落筆那一刻的本地日期記，所以 23:59 打的字記在前一天，過了零點打的記在新的一天；顯示的
 * 「今天」每次重畫時現算。
 */
import { projectStorageKey, windowProject } from '../globals';
import { addDaily, bumpDaily, dayKey, parseDaily, serializeDaily } from './writingStats';
import type { DailyRecord, DayTally } from './writingStats';

const BASE_KEY = 'novelforge.editor.stats.daily';
/** 碼字時至多隔多久寫一次 localStorage（別的視窗至多晚這麼久看到）。 */
export const FLUSH_MS = 2_000;

/** 工程鍵（沒有工程標識時是 null，只在記憶體裡算）→ 還沒寫進 localStorage 的增量。 */
const pending = new Map<string | null, DailyRecord>();
/** 工程鍵 → 上次讀到 / 寫下的那一份。 */
const stored = new Map<string, DailyRecord>();
/** localStorage 讀或寫拋過：之後只在記憶體裡算。 */
let broken = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** 這個視窗的工程在 localStorage 裡的鍵。網址上沒有工程標識時 null。 */
function currentKey(): string | null {
  return windowProject() ? projectStorageKey(BASE_KEY) : null;
}

/** 記一筆（`at` 那一刻的本地日期）。 */
export function recordDaily(at: number, words: number, ms: number): void {
  if (words === 0 && ms === 0) {
    return;
  }
  const key = currentKey();
  let inc = pending.get(key);
  if (!inc) {
    inc = {};
    pending.set(key, inc);
  }
  bumpDaily(inc, at, words, ms);
  if (key !== null && !broken && flushTimer === undefined) {
    flushTimer = setTimeout(flushDaily, FLUSH_MS);
  }
}

/** 今天（`now` 那一刻的本地日期）這個工程碼了多少，`persisted` 說是不是記在瀏覽器裡（跨重新整理、跨視窗）。 */
export function todayTally(now: number): DayTally & { persisted: boolean } {
  const key = currentKey();
  const day = dayKey(now);
  const base = key !== null ? storedOf(key)[day] : undefined;
  const mine = pending.get(key)?.[day];
  return {
    words: (base?.words ?? 0) + (mine?.words ?? 0),
    ms: (base?.ms ?? 0) + (mine?.ms ?? 0),
    persisted: key !== null && !broken,
  };
}

/** 把待寫的寫進 localStorage：現讀、加上、寫回。拋了就記下「記不了」，待寫的留在記憶體裡照樣算進顯示。 */
export function flushDaily(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (broken) {
    return;
  }
  for (const [key, inc] of [...pending]) {
    if (key === null) {
      continue;
    }
    try {
      const next = addDaily(parseDaily(localStorage.getItem(key)), inc);
      localStorage.setItem(key, serializeDaily(next));
      stored.set(key, next);
      pending.delete(key);
    } catch {
      broken = true;
      return;
    }
  }
}

/** 別的視窗寫了（`storage` 事件）、或者想重新讀一次時：丟掉快取，下次顯示現讀。 */
function forget(key: string | null): void {
  if (key === null) {
    stored.clear();
  } else {
    stored.delete(key);
  }
}

function storedOf(key: string): DailyRecord {
  let record = stored.get(key);
  if (!record) {
    try {
      record = parseDaily(localStorage.getItem(key));
    } catch {
      broken = true;
      record = {};
    }
    stored.set(key, record);
  }
  return record;
}

/** 別的視窗改了「今日碼字」時通知（重畫）。 */
export function onDailyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 裝一次（`stats.ts`）：別的視窗寫了就重讀重畫；頁面藏起來、關掉時立刻寫。 */
export function installDaily(): void {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(BASE_KEY)) {
      return;
    }
    forget(e.key);
    for (const fn of [...listeners]) {
      fn();
    }
  });
  window.addEventListener('pagehide', flushDaily);
  window.addEventListener('beforeunload', flushDaily);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushDaily();
    }
  });
}
