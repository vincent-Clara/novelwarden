/**
 * 歷史版本：閘道器**覆蓋一份已存在的創作產物之前**，把磁碟上的舊內容存成一個快照。
 *
 * 「不靜默覆蓋」（第 3 條）管的是落盤之前那一問；問過了、寫下去了，作者回頭髮現「剛才那一版其實更好」，
 * 從前只有定稿寫回細綱會在回收站裡留一份舊的。這一層讓**每一條走閘道器的覆蓋**（編輯器儲存、重寫 / 修稿
 * 落盤、定稿寫回、MCP 的 `edit`、一鍵排版之後的儲存……）都先把舊內容留一版。
 *
 * ## 佈局
 *
 * ```
 * .novelwarden/history/
 * ├── .gitignore                            第一次存快照時放進來，內容 `*`（Git 預設不收；想收就刪掉它，之後不再補）
 * ├── chapters/第一卷/003-深处.txt/          每份檔案一個目錄：原檔案的相對路徑（連副檔名）原樣當目錄名
 * │   ├── 2026-10-18_14-32-05+0800.txt      每個快照一個檔案：被覆蓋那一刻的本地時間與時區
 * │   └── 2026-10-18_14-32-05+0800-2.txt    同一秒裡的第二個
 * └── .novelwarden/summaries/第一卷/003-深处.md/
 *     └── …                                  `.novelwarden/` 裡的檔案（細綱、角色卡、大綱……）同樣映象
 * ```
 *
 * - **一一對應、不撞車**：目錄名就是原檔案的相對路徑（含副檔名），`003.md` 與 `003.txt` 各是各的目錄。
 * - **快照一律 `.txt`，位元組原樣複製**（不轉碼，GBK 的舊稿存下來還是 GBK）：不是 `.md`，外掛殼的
 *   `.novelwarden/**\/*.md` 監聽就不會每存一版多跑一輪全量重掃；內建編輯器與「檔案」頁照樣打得開。
 * - **時間從檔名讀**（帶時區，換了時區也排得對），不看 mtime——拷來拷去 mtime 會變。
 *
 * ## 存不存（{@link decideSnapshot}）
 *
 * - 只管創作產物：`kindOfPath` 不是 `other` 的（章節、草稿、細綱、角色卡、設定、架構、大綱、文風、敘事線、
 *   全文大綱、技能）；還不是小說工程（沒有 `.novelwarden/`）的目錄裡不存——不替作者憑空建出一個工程目錄。
 * - 新內容與舊內容一樣（什麼都沒覆蓋）、舊內容與最新一個快照一樣：不存。
 * - **節流**：最新一個快照不到 {@link HISTORY_QUIET_MS}（10 分鐘），而且「舊內容 ↔ 最新快照」「舊內容 ↔ 新內容」
 *   兩處改動都在 {@link HISTORY_SMALL_CHANGE}（300 字）以內——不存。自動儲存每兩秒存一次時攢不出幾百個快照；
 *   **大改總是存**：整章重寫、修稿、一鍵排版、定稿寫回，新內容和舊內容一比就超出這個數。改動按公共前字尾粗算
 *   （{@link changedChars}）。
 * - 「現在存一版」（{@link snapshotNow}）跳過節流，但和最新快照一字不差時照樣不重複存。
 *
 * ## 保留
 *
 * 每份檔案最多留最近 {@link HISTORY_KEEP} 個，多的刪掉最舊的。**這些是閘道器自己存的副本，不是作者的檔案**，
 * 刪它們不違背第 6 條「不真刪」——第 6 條護的是作者的東西（章節、角色卡、會話……），而這裡刪的是閘道器為了
 * 「找得回來」額外抄的那幾份，作者自己的檔案一個位元組都沒動。
 *
 * ## 改名 / 搬家：快照跟著走（{@link moveHistory}）
 *
 * 快照按路徑存。閘道器 `move` 成功之後（連同它帶走的草稿、細綱，以及 `writePlot` 換了檔名的細綱），快照目錄挪到新路徑下；
 * 新路徑下已經有快照就兩邊合併（撞名加序號、合併完按保留上限修剪）。搬不動只記 warn，**不擋搬家、不回滾**。刪除（進回收站）
 * 不搬：快照留在原路徑，檔案從回收站搬回原處，歷史也就回來了。
 *
 * ## 絕不擋住儲存
 *
 * 存快照的任何一步失敗（磁碟滿、`.novelwarden/history` 被佔成了檔案、許可權……）都只記一條 warn，照常寫盤
 * （第 1 條：容錯優先）。{@link snapshotBeforeWrite} 不拋。
 *
 * ## 不進上下文、不觸發重掃
 *
 * `kindOfPath` 把這裡的東西判成 `other`（裝配器只按種類與固定目錄讀，碰不到它）；全文檢索跳過它（與
 * `.trash/` 同理：搜出來的是一份舊稿）；`watchPolicy` 擋掉它的變動；`isProtectedPath` 把這個目錄列為固定目錄，
 * 類檔案操作搬不走、刪不掉它。「檔案」頁照常看得見、點得開。
 */
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { countWords, hash } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { NovelProject } from '../model/project';
import { MAX_EDITABLE_BYTES, WsError } from './guard';
import { kindOfPath, normalizeRel } from './kind';

const log = scoped('歷史版本');

/** 每份檔案最多留幾個快照。 */
export const HISTORY_KEEP = 50;
/** 最新一個快照「還新」的時長：這之內的小改動不另存。 */
export const HISTORY_QUIET_MS = 10 * 60 * 1000;
/** 「小改動」的上限（字元數，按公共前字尾粗算）。 */
export const HISTORY_SMALL_CHANGE = 300;
/** 第一次存快照時放進 `.novelwarden/history/` 的 `.gitignore`。 */
export const HISTORY_GITIGNORE = '*\n';

// ---------------------------------------------------------------- 純函式

/**
 * 這份檔案的快照放在哪個目錄（工程內相對路徑）：`.novelwarden/history/<原檔案的相對路徑>`，副檔名原樣
 * 留在目錄名裡。越界給 undefined。純函式，零 I/O。
 */
export function historyDirOf(project: NovelProject, rel: string): string | undefined {
  const normalized = normalizeRel(rel);
  return normalized === undefined ? undefined : `${project.relPath(project.historyDir)}/${normalized}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * 快照的檔名：被覆蓋那一刻的本地時間 + 時區，`dup > 1` 時帶序號（同一秒裡的第二個）。
 * 例：`2026-10-18_14-32-05+0800.txt`、`2026-10-18_14-32-05+0800-2.txt`。
 */
export function snapshotFileName(at: Date, dup = 1): string {
  const off = -at.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return `${stamp}${dup > 1 ? `-${dup}` : ''}.txt`;
}

const SNAPSHOT_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})([+-])(\d{2})(\d{2})(?:-(\d+))?\.txt$/;

/** 讀快照檔名：那一刻（毫秒時間戳）與序號。不是快照的名字（作者放進來的別的檔案、子目錄）給 undefined。 */
export function parseSnapshotFileName(name: string): { time: number; dup: number } | undefined {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) {
    return undefined;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const time = Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000;
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return { time, dup: m[10] ? Number(m[10]) : 1 };
}

/** 快照檔名按時刻排，新的在前；不是快照的名字丟掉。 */
export function sortSnapshotNames(names: readonly string[]): string[] {
  return names
    .map((name) => ({ name, at: parseSnapshotFileName(name) }))
    .filter((x): x is { name: string; at: { time: number; dup: number } } => !!x.at)
    .sort((a, b) => b.at.time - a.at.time || b.at.dup - a.at.dup)
    .map((x) => x.name);
}

/** 超出保留數的那幾個（最舊的），要刪掉。 */
export function snapshotsToPrune(names: readonly string[], keep = HISTORY_KEEP): string[] {
  return sortSnapshotNames(names).slice(Math.max(0, keep));
}

/**
 * 兩份文字差了多少：去掉公共字首與公共字尾之後，剩下那段中間較長的一邊有幾個字元。粗算——一處改動
 * 是準的；首尾各改一處會把中間全算進去（寧可多存一版）。
 */
export function changedChars(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) {
    p++;
  }
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) {
    s++;
  }
  return Math.max(a.length, b.length) - p - s;
}

export type SnapshotSkip = 'unchanged' | 'same' | 'small';

export type SnapshotDecision =
  | { save: true; reason: 'first' | 'force' | 'quiet' | 'bigChange' }
  | { save: false; reason: SnapshotSkip };

/**
 * 存不存這一版（規則見檔案頭）。`old` 是磁碟上要被覆蓋的內容，`next` 是要寫下去的（「現在存一版」沒有），
 * `latest` 是最新一個快照，`now` 是此刻。
 */
export function decideSnapshot(input: {
  old: string;
  next?: string;
  latest?: { text: string; time: number };
  now: number;
  force?: boolean;
}): SnapshotDecision {
  const { old, next, latest, now } = input;
  if (next !== undefined && hash(next) === hash(old)) {
    return { save: false, reason: 'unchanged' };
  }
  if (latest && hash(latest.text) === hash(old)) {
    return { save: false, reason: 'same' };
  }
  if (input.force) {
    return { save: true, reason: 'force' };
  }
  if (!latest) {
    return { save: true, reason: 'first' };
  }
  if (now - latest.time >= HISTORY_QUIET_MS) {
    return { save: true, reason: 'quiet' };
  }
  const drift = changedChars(latest.text, old);
  const incoming = next === undefined ? 0 : changedChars(old, next);
  if (drift <= HISTORY_SMALL_CHANGE && incoming <= HISTORY_SMALL_CHANGE) {
    return { save: false, reason: 'small' };
  }
  return { save: true, reason: 'bigChange' };
}

// ---------------------------------------------------------------- 讀

export interface SnapshotInfo {
  /** 快照的檔名，也是讀它、對比它時的身份。 */
  id: string;
  /** 那一刻（毫秒時間戳）：這一版在磁碟上被覆蓋掉的時候。 */
  time: number;
  words: number;
  bytes: number;
}

/**
 * 這份檔案能不能存歷史版本。能就給 undefined，不能給一句給人看的原因（介面上禁用按鈕時說的就是它）。
 * 越界、不是創作產物、還不是小說工程，都不能。
 */
export async function historyUnavailable(project: NovelProject, rel: string): Promise<string | undefined> {
  const normalized = normalizeRel(rel);
  if (normalized === undefined) {
    return `路徑超出工程目錄：${rel}`;
  }
  const kind = kindOfPath(project, normalized).kind;
  if (kind === 'other') {
    return '這份檔案不是工程裡的創作產物（章節、草稿、細綱、角色卡、設定、架構、文風、敘事線……），不存歷史版本。';
  }
  if (kind === 'outline') {
    return '情節大綱沒有檔案，是各章細綱「梗概」的彙總：它自己不存歷史版本。存回去時改了哪一章，那一章的細綱各自存了一版（開啟那一章的細綱看「歷史」）。';
  }
  if (!(await isDir(project.novelDir))) {
    return '這個目錄還不是小說工程（沒有 .novelwarden/），不存歷史版本。';
  }
  return undefined;
}

/** 列出這份檔案的快照，新的在前。沒有就是空陣列；讀不動的那一個跳過，不拋。 */
export async function listSnapshots(project: NovelProject, rel: string): Promise<SnapshotInfo[]> {
  const relDir = historyDirOf(project, rel);
  if (relDir === undefined) {
    return [];
  }
  const dir = project.pathOf(relDir);
  const out: SnapshotInfo[] = [];
  for (const name of sortSnapshotNames(await snapshotNamesIn(dir))) {
    try {
      const buf = await fs.readFile(path.join(dir, name));
      out.push({ id: name, time: parseSnapshotFileName(name)!.time, words: countWords(decodeFileText(buf)), bytes: buf.length });
    } catch {
      // 列的時候剛被裁掉、或者作者手刪了：跳過這一個。
    }
  }
  return out;
}

/** 讀某一個快照的全文。`id` 只認快照檔名（防 `../`）；不存在拋 `WsError('notFound')`。 */
export async function readSnapshot(project: NovelProject, rel: string, id: string): Promise<string> {
  const relDir = historyDirOf(project, rel);
  if (relDir === undefined || id.includes('/') || id.includes('\\') || !parseSnapshotFileName(id)) {
    throw new WsError('notFound', `找不到這一版：${id}`);
  }
  try {
    return decodeFileText(await fs.readFile(path.join(project.pathOf(relDir), id)));
  } catch {
    throw new WsError('notFound', `找不到這一版（可能已經被裁掉了）：${id}`);
  }
}

// ---------------------------------------------------------------- 存

export interface SnapshotResult {
  /** 存下來的快照檔名。 */
  saved?: string;
  /** 為什麼沒存。 */
  skipped?: SnapshotSkip | 'notTracked' | 'missing' | 'tooLarge';
  /** 存的時候出錯了（已經記了 warn）。 */
  error?: string;
}

/**
 * 閘道器覆蓋 `rel` 之前調：磁碟上那份舊內容該存就存一版（規則見檔案頭）。`next` 是馬上要寫下去的內容。
 * **絕不拋**：任何一步失敗都只記 warn，呼叫方照常寫盤。
 */
export async function snapshotBeforeWrite(
  project: NovelProject,
  rel: string,
  next: string | undefined,
  opts: { force?: boolean; now?: number } = {}
): Promise<SnapshotResult> {
  try {
    return await snapshot(project, rel, next, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`沒能給 ${rel} 存歷史版本，照常寫盤`, message);
    return { error: message };
  }
}

/** 「現在存一版」：把**磁碟上當前**這份強制存一個快照（跳過節流；與最新快照一字不差時不重複存）。 */
export function snapshotNow(project: NovelProject, rel: string): Promise<SnapshotResult> {
  return snapshotBeforeWrite(project, rel, undefined, { force: true });
}

async function snapshot(
  project: NovelProject,
  rel: string,
  next: string | undefined,
  opts: { force?: boolean; now?: number }
): Promise<SnapshotResult> {
  const normalized = normalizeRel(rel);
  // 情節大綱沒有檔案（各章細綱梗概的彙總）：磁碟上殘留的老 `outline.md` 不是現在的書，不存。
  const kind = normalized === undefined ? 'other' : kindOfPath(project, normalized).kind;
  if (normalized === undefined || kind === 'other' || kind === 'outline') {
    return { skipped: 'notTracked' };
  }
  if (!(await isDir(project.novelDir))) {
    return { skipped: 'notTracked' };
  }
  const abs = project.pathOf(normalized);
  let buf: Buffer;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { skipped: 'missing' };
    }
    if (stat.size > MAX_EDITABLE_BYTES) {
      return { skipped: 'tooLarge' };
    }
    buf = await fs.readFile(abs);
  } catch {
    return { skipped: 'missing' };
  }
  const old = decodeFileText(buf);

  const dir = project.pathOf(historyDirOf(project, normalized)!);
  const names = sortSnapshotNames(await snapshotNamesIn(dir));
  let latest: { text: string; time: number } | undefined;
  if (names[0]) {
    try {
      latest = { text: decodeFileText(await fs.readFile(path.join(dir, names[0]))), time: parseSnapshotFileName(names[0])!.time };
    } catch {
      latest = undefined;
    }
  }

  const now = opts.now ?? Date.now();
  const decision = decideSnapshot({ old, next, latest, now, force: opts.force });
  if (!decision.save) {
    return { skipped: decision.reason };
  }

  await ensureHistoryRoot(project);
  await fs.mkdir(dir, { recursive: true });
  const name = await writeUnique(dir, new Date(now), buf);
  log.debug(`存了一版 ${normalized}`, `${name}｜${buf.length} 位元組｜${decision.reason}`);

  const pruned = snapshotsToPrune([name, ...names]);
  for (const stale of pruned) {
    await fs.unlink(path.join(dir, stale)).catch(() => undefined);
  }
  if (pruned.length > 0) {
    log.debug(`裁掉 ${normalized} 最舊的 ${pruned.length} 個歷史版本`, `只留最近 ${HISTORY_KEEP} 個`);
  }
  return { saved: name };
}

// ---------------------------------------------------------------- 搬

/**
 * 閘道器把 `from` 搬到了 `to`（一份檔案或整個目錄，`move` 本身與它連帶搬走的草稿、細綱）之後，把快照目錄也搬過去：
 * 在新路徑上開啟「歷史」面板，看得到改名之前存的那幾版。目錄搬的是整棵——分卷目錄改名，下面每份檔案的快照都跟著走。
 *
 * - 新路徑下還沒有快照目錄：整個挪過去。
 * - 已經有（以前那裡有過同名檔案，或者從回收站搬回來過）：兩邊合併。撞了名的按 {@link writeUnique} 的規矩加序號
 *   （同一刻、序號往上加，絕不蓋掉已有的那一個），合併完的那幾個目錄按 {@link HISTORY_KEEP} 修剪。
 * - 搬不動（新位置被一個檔案佔了、磁碟滿、許可權……）：只記一條 warn，**絕不拋**——搬家已經成了，不能因為幾份副本
 *   讓它失敗或回滾，與「存快照失敗不擋儲存」同一個口徑。沒搬過去的留在舊路徑下，一個不丟。
 *
 * 刪除（進回收站）不調它：快照留在原路徑，作者從回收站把檔案搬回原處，歷史也就回來了。
 * 返回補進 `side` 的說明（沒有快照目錄時空陣列）。
 */
export async function moveHistory(project: NovelProject, from: string, to: string): Promise<string[]> {
  try {
    return await carryHistory(project, from, to);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`沒能把 ${from} 的歷史版本搬到 ${to}，搬家照常`, `沒搬過去的快照留在舊路徑下｜${message}`);
    return [`歷史版本沒能跟過去，沒搬過去的留在 ${from} 的舊路徑下`];
  }
}

async function carryHistory(project: NovelProject, from: string, to: string): Promise<string[]> {
  const fromRel = normalizeRel(from);
  const toRel = normalizeRel(to);
  if (fromRel === undefined || toRel === undefined || fromRel === toRel) {
    return [];
  }
  // 歷史目錄裡的東西本身不存歷史（`kindOfPath` 判 `other`）；搬進、搬出它都不該再套一層 `history/.novelwarden/history/…`。
  const root = project.relPath(project.historyDir);
  if ([fromRel, toRel].some((r) => r === root || r.startsWith(`${root}/`))) {
    return [];
  }
  const src = project.pathOf(historyDirOf(project, fromRel)!);
  if (!(await isDir(src))) {
    return [];
  }
  const dst = project.pathOf(historyDirOf(project, toRel)!);
  const there = await statOf(dst);
  if (!there) {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    log.debug(`歷史版本跟著搬了`, `${fromRel} → ${toRel}`);
    return [`歷史版本 ${fromRel} → ${toRel}`];
  }
  if (!there.isDirectory()) {
    throw new Error(`新路徑的快照目錄被一個檔案佔了：${project.relPath(dst)}`);
  }
  const renamed = await mergeHistoryDir(src, dst);
  log.debug(`歷史版本跟著搬了，與新路徑下原有的合併`, `${fromRel} → ${toRel}｜撞名加序號 ${renamed} 個`);
  return [`歷史版本 ${fromRel} → ${toRel}（與那裡原有的合併）`];
}

/**
 * 把快照目錄 `src` 並進 `dst`（兩邊都是目錄），返回撞了名、加了序號的有幾個。子目錄遞迴（整個分卷的快照），檔案一個一個
 * 拷過去再刪源（拷用 `COPYFILE_EXCL`：絕不蓋掉 `dst` 裡已有的那一個）。並進了檔案的目錄按保留上限修剪；`src` 搬空了就刪掉
 * （只刪空目錄，那是閘道器自己建的）。
 */
async function mergeHistoryDir(src: string, dst: string): Promise<number> {
  let renamed = 0;
  let received = false;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const into = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const there = await statOf(into);
      if (!there) {
        await fs.rename(from, into);
      } else if (there.isDirectory()) {
        renamed += await mergeHistoryDir(from, into);
      } else {
        throw new Error(`快照目錄被一個檔案佔了：${into}`);
      }
      continue;
    }
    const name = await copyUnique(from, dst, entry.name);
    await fs.unlink(from);
    received = true;
    if (name !== entry.name) {
      renamed++;
    }
  }
  if (received) {
    const names = await snapshotNamesIn(dst);
    for (const stale of snapshotsToPrune(names)) {
      await fs.unlink(path.join(dst, stale)).catch(() => undefined);
    }
  }
  await fs.rmdir(src).catch(() => undefined);
  return renamed;
}

/**
 * 把 `file` 拷進 `dir`，名字撞了就加序號：快照名去掉原有的序號、從 2 往上加（與 {@link writeUnique} 同一個規矩，那一刻與時區
 * 原樣留著）；不是快照的名字（作者放進來的別的檔案）在副檔名前加 `-2`、`-3`。返回落下的名字。
 */
async function copyUnique(file: string, dir: string, name: string): Promise<string> {
  const snap = SNAPSHOT_RE.test(name);
  const ext = snap ? '.txt' : path.extname(name);
  const stem = snap ? name.replace(/(?:-\d+)?\.txt$/, '') : name.slice(0, name.length - ext.length);
  for (let dup = 1; dup < 1000; dup++) {
    const candidate = dup === 1 ? name : `${stem}-${dup}${ext}`;
    try {
      await fs.copyFile(file, path.join(dir, candidate), fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error(`${name} 撞名太多`);
}

async function statOf(abs: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(abs);
  } catch {
    return undefined;
  }
}

/**
 * 歷史根第一次出現時順手放一個 `.gitignore`（`*`）。只在**建出這個目錄**的那一次放：作者刪掉它就是想讓
 * Git 收這些快照，之後不再補回來。
 */
async function ensureHistoryRoot(project: NovelProject): Promise<void> {
  if (await isDir(project.historyDir)) {
    return;
  }
  await fs.mkdir(project.historyDir, { recursive: true });
  await fs.writeFile(path.join(project.historyDir, '.gitignore'), HISTORY_GITIGNORE, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
}

/** 按此刻起名寫下去；同一秒已經有了就加序號。`wx`：絕不蓋掉已有的那一個。 */
async function writeUnique(dir: string, at: Date, bytes: Buffer): Promise<string> {
  for (let dup = 1; dup < 1000; dup++) {
    const name = snapshotFileName(at, dup);
    try {
      await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' });
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err;
      }
    }
  }
  throw new Error('同一秒裡存了太多版');
}

async function snapshotNamesIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}
