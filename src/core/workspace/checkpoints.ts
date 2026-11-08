/**
 * 存檔點：整本書在某一刻的樣子。作者在工程頁「存檔點…」裡手動存一個（帶一句備註），批次動作之前機器自動存一個
 * （`features/checkpoint.ts` 的 `checkpointBefore`）；之後可以看每個存檔點跟現在比改了哪幾份，整本或單份退回去。
 * 設計見 `docs/design/plans/2026-10-20-checkpoints.md`。
 *
 * 歷史版本（`history.ts`）管的是**一份檔案**被覆蓋之前的那一版；這裡管的是**整本書一起**——批次寫了二十章、全書替換
 * 改了幾十份，按檔案一份一份找回去不現實。兩層互不替代：退回存檔點時，被蓋掉的每一份照樣先存一版歷史。
 *
 * ## 佈局
 *
 * ```
 * .novelwarden/checkpoints/
 * ├── .gitignore                                第一次建這個目錄時放進來，內容 `*`（同歷史版本）
 * ├── objects/3f/a9c1…                          檔案內容，按 sha256 定址：前兩位當目錄，餘下 62 位當檔名；位元組原樣
 * └── points/2026-10-20_22-30-05+0800.json      一個存檔點一份清單（名字的格式同歷史版本的快照，去掉 `.txt`）
 * ```
 *
 * - **同樣的內容只存一份**：第二個存檔點只多存這期間改過的那幾份，外加一份清單。
 * - **先寫物件、最後寫清單**：清單是提交點。寫到一半失敗，剩下的只是沒人引用的物件，清理時帶走。物件先寫進臨時檔案
 *   再改名：斷電時不會留下一個名字對、內容只有半截的物件。
 * - **位元組原樣**：不轉碼（GBK 的章節存下來還是 GBK）、不壓縮。退回時原樣寫回（`Workspace.restoreBytes`）。
 *
 * ## 存哪些（{@link trackedFiles}）
 *
 * `kindOfPath` 不是 `other` 的——與歷史版本同一個口徑（章節、草稿、細綱、角色卡、設定、架構、大綱、文風、敘事線、
 * 全文大綱、技能、敏感詞表）。只掃章節根、草稿根與 `.novelwarden/` 三處，不掃整個工程根；隱藏目錄、會話、回收站、
 * 歷史版本、存檔點自己都不進。超過閘道器大小上限（2 MB）的單份不存，記進清單的 `skipped`，介面上說出來（第 2 條）。
 *
 * ## 保留（{@link checkpointsToPrune}）
 *
 * 手動的永遠留；自動的留最近 {@link CHECKPOINT_AUTO_KEEP} 個。給自動的寫備註就是留住它（{@link noteCheckpoint}：變成手動）。
 * 刪掉清單之後清理沒人引用的物件（{@link collectGarbage}）：只刪寫下超過 {@link ORPHAN_GRACE_MS} 的——另一個程序可能
 * 正在存、物件寫了清單還沒寫。有一份清單讀不懂就整個不清（不知道它引用了哪些，寧可多留）。
 *
 * ## 內部檔案
 *
 * 整個目錄是 Novelwarden 的內部檔案（`guard.ts` 的 `isInternalPath`）：搜不到、讀當不存在、寫搬刪都拒；監聽也擋掉它
 * （`watchPolicy.ts`）。這裡的寫盤都是這一層自己的（與 `history.ts` 一樣在閘道器裡），不經 `Workspace.write`。
 *
 * ## 排隊
 *
 * 同一個工程的存、寫備註、清理在程序裡排隊（{@link withCheckpointLock}，按工程根一把鎖）：自動存檔點可能與作者手動存的
 * 撞在一起，清理不能刪掉另一個正在存的那一份的物件。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { countWords, hash, isIgnoredDir } from '../model/fs';
import { decodeFileText } from '../model/importText';
import { NovelProject } from '../model/project';
import { MAX_EDITABLE_BYTES, WsError, isInHistory, isInTrash, isInternalPath } from './guard';
import { parseSnapshotFileName, snapshotFileName } from './history';
import { ArtifactKind, kindOfPath } from './kind';

const log = scoped('存檔點');

/** 自動存檔點留最近幾個。 */
export const CHECKPOINT_AUTO_KEEP = 30;
/** 沒人引用的物件，寫下多久之後才清（另一個程序可能正在存）。 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
/** 第一次建存檔點目錄時放進去的 `.gitignore`。 */
export const CHECKPOINT_GITIGNORE = '*\n';
/** 掃目錄的最大深度（同 `model/project.ts` 列章節）。 */
const MAX_DEPTH = 8;

/** 清單裡的一份檔案。 */
export interface CheckpointFile {
  /** 內容的 sha256（十六進位制）：物件的名字。 */
  sha: string;
  bytes: number;
  words: number;
}

/** 一份清單（`points/<id>.json`）。 */
export interface CheckpointManifest {
  v: 1;
  /** 存下的那一刻（毫秒時間戳）。 */
  time: number;
  note: string;
  auto: boolean;
  /** 工程內相對路徑 → 那一刻的內容。 */
  files: Record<string, CheckpointFile>;
  /** 超過大小上限、沒存進去的。 */
  skipped: string[];
}

export interface CheckpointInfo extends CheckpointManifest {
  /** 清單的檔名去掉 `.json`。 */
  id: string;
}

// ---------------------------------------------------------------- 純函式

/** 存檔點的名字：那一刻的本地時間 + 時區，同一秒的第二個帶序號。格式同歷史版本的快照（去掉 `.txt`）。 */
export function checkpointIdOf(at: Date, dup = 1): string {
  return snapshotFileName(at, dup).replace(/\.txt$/, '');
}

/** 讀存檔點的名字：那一刻（毫秒時間戳）。不是存檔點的名字（帶斜槓、`..`、亂寫的）給 undefined。 */
export function parseCheckpointId(id: string): number | undefined {
  if (typeof id !== 'string' || id.includes('/') || id.includes('\\')) {
    return undefined;
  }
  return parseSnapshotFileName(`${id}.txt`)?.time;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * 解析一份清單。**容錯**（第 1 條）：認不出的整份給 undefined；單份檔案的記錄壞了就丟掉那一份（路徑越界、sha 不像、
 * 數字不對）。`id` 用來在 `time` 缺了時從名字補。
 */
export function parseManifest(text: string, id?: string): CheckpointManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) {
    return undefined;
  }
  const files: Record<string, CheckpointFile> = {};
  for (const [rel, value] of Object.entries(obj.files as Record<string, unknown>)) {
    if (!isSafeRel(rel) || !value || typeof value !== 'object') {
      continue;
    }
    const f = value as Record<string, unknown>;
    if (typeof f.sha !== 'string' || !SHA_RE.test(f.sha)) {
      continue;
    }
    files[rel] = { sha: f.sha, bytes: numberOr(f.bytes, 0), words: numberOr(f.words, 0) };
  }
  const time = typeof obj.time === 'number' && Number.isFinite(obj.time) ? obj.time : id ? parseCheckpointId(id) : undefined;
  if (time === undefined) {
    return undefined;
  }
  return {
    v: 1,
    time,
    note: typeof obj.note === 'string' ? obj.note : '',
    auto: obj.auto === true,
    files,
    skipped: Array.isArray(obj.skipped) ? obj.skipped.filter((s): s is string => typeof s === 'string') : [],
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 清單裡的路徑只認工程內的相對路徑（手改壞了的清單不能把退回引到工程外面去）。 */
function isSafeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) {
    return false;
  }
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** 兩個存檔點（或存檔點與此刻）的檔案是不是一模一樣：路徑一樣、每份的 sha 一樣。 */
export function sameFiles(a: Record<string, { sha: string }>, b: Record<string, { sha: string }>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) {
    return false;
  }
  return ka.every((k) => b[k]?.sha === a[k].sha);
}

/** 此刻磁碟上的一份（比較用）。 */
export interface CurrentFile {
  sha: string;
  words: number;
  /** 閘道器樂觀鎖的口徑（`model/fs.ts` 的 `hash`，按 utf8 讀出來算，與 `guardWrite` 讀盤的方式一致）。 */
  hash: string;
}

export interface FileDiff {
  path: string;
  status: 'changed' | 'deleted' | 'added';
  wordsThen?: number;
  wordsNow?: number;
  hashNow?: string;
}

/**
 * 存檔點 ↔ 此刻逐份比：改過的、之後刪掉的、之後新建的。一模一樣的只計數。按路徑排（中文、數字按數值）。
 * 存檔點裡因為太大沒存的（`skipped`）不算「之後新建」——那一份當時就在，只是沒存。
 */
export function compareFiles(
  then: Record<string, CheckpointFile>,
  now: Record<string, CurrentFile>,
  skipped: readonly string[] = []
): { unchanged: number; entries: FileDiff[] } {
  const entries: FileDiff[] = [];
  let unchanged = 0;
  for (const [rel, f] of Object.entries(then)) {
    const cur = now[rel];
    if (!cur) {
      entries.push({ path: rel, status: 'deleted', wordsThen: f.words });
    } else if (cur.sha === f.sha) {
      unchanged++;
    } else {
      entries.push({ path: rel, status: 'changed', wordsThen: f.words, wordsNow: cur.words, hashNow: cur.hash });
    }
  }
  const tooLarge = new Set(skipped);
  for (const [rel, cur] of Object.entries(now)) {
    if (!then[rel] && !tooLarge.has(rel)) {
      entries.push({ path: rel, status: 'added', wordsNow: cur.words, hashNow: cur.hash });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
  return { unchanged, entries };
}

/** 該刪掉的存檔點（`list` 新的在前）：自動的超出保留數的那幾個（最舊的）。手動的一個不刪。 */
export function checkpointsToPrune(
  list: readonly Pick<CheckpointInfo, 'id' | 'auto'>[],
  keep = CHECKPOINT_AUTO_KEEP
): string[] {
  return list
    .filter((c) => c.auto)
    .slice(Math.max(0, keep))
    .map((c) => c.id);
}

// ---------------------------------------------------------------- 路徑

const pointsDirOf = (project: NovelProject) => path.join(project.checkpointsDir, 'points');
const objectsDirOf = (project: NovelProject) => path.join(project.checkpointsDir, 'objects');
const objectPathOf = (project: NovelProject, sha: string) => path.join(objectsDirOf(project), sha.slice(0, 2), sha.slice(2));

/** 能不能存存檔點。能就給 undefined，不能給一句給人看的原因。 */
export async function checkpointUnavailable(project: NovelProject): Promise<string | undefined> {
  return (await isDir(project.novelDir)) ? undefined : '這個目錄還不是小說工程（沒有 .novelwarden/），存不了存檔點。';
}

// ---------------------------------------------------------------- 掃

/**
 * 要進存檔點的檔案（工程內相對路徑，排好序）。只掃章節根、草稿根與 `.novelwarden/`；隱藏目錄（含回收站）、
 * 會話、歷史版本、存檔點自己都不進；符號連結不跟。種類是 `other` 的不要；情節大綱也不要（它沒有檔案，是各章細綱梗概的彙總，
 * 細綱在存檔點裡就退得回；磁碟上殘留的老 `outline.md` 不是現在的書）。
 */
export async function trackedFiles(project: NovelProject): Promise<string[]> {
  const skip = new Set([project.draftsDir, project.historyDir, project.checkpointsDir, project.sessionsDir, project.trashDir].map((d) => path.resolve(d)));
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name) && !skip.has(path.resolve(abs))) {
          await walk(abs, depth + 1);
        }
      } else if (entry.isFile()) {
        const rel = project.relPath(abs);
        if (
          !rel.startsWith('..') &&
          !isInternalPath(project, rel) &&
          !isInHistory(project, rel) &&
          !isInTrash(project, rel) &&
          kindOfPath(project, rel).kind !== 'other' &&
          kindOfPath(project, rel).kind !== 'outline'
        ) {
          found.add(rel);
        }
      }
    }
  };
  // 三個根各自從裡面開始走：`.novelwarden/` 本身是隱藏目錄，從工程根走過來會被跳過。草稿根在章節根下面時
  // （`chaptersDir` 配成 `.`）走章節根時跳過它，單獨再走一遍。
  await walk(project.chaptersDir, 1);
  await walk(project.draftsDir, 1);
  await walk(project.novelDir, 1);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 讀過、算過的那幾樣按「大小 + 修改時間 + 狀態改變時間」記著（絕對路徑為鍵）：編輯器「版本」側欄的全書改動每存一次盤就
 * 跟存檔點比一次，全書幾千份每次都整份讀、整份算 sha 不值得。寫過的檔案 ctime 一定變（`utimes` 改不了它），記著的就不認了；
 * 萬一認錯，`hashNow` 只是退回時的樂觀鎖，對不上就跳過那一份，不會拿舊稿蓋新稿。
 */
const scanCache = new Map<string, { stamp: string; file: CurrentFile }>();

/** 此刻磁碟上要進存檔點的每一份：sha、字數、樂觀鎖 hash。讀不動的跳過（剛被刪掉）。 */
export async function scanCurrent(project: NovelProject): Promise<Record<string, CurrentFile>> {
  const out: Record<string, CurrentFile> = {};
  const seen = new Set<string>();
  for (const rel of await trackedFiles(project)) {
    const abs = path.resolve(project.pathOf(rel));
    let stamp: string;
    try {
      const st = await fs.stat(abs);
      stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      continue;
    }
    seen.add(abs);
    const cached = scanCache.get(abs);
    if (cached?.stamp === stamp) {
      out[rel] = cached.file;
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    const file = { sha: shaOf(buf), words: countWords(decodeFileText(buf)), hash: hash(buf.toString('utf8')) };
    scanCache.set(abs, { stamp, file });
    out[rel] = file;
  }
  // 這個工程裡不在了的（刪了、搬了）不再佔著記憶體。
  const root = path.resolve(project.root) + path.sep;
  for (const key of scanCache.keys()) {
    if (key.startsWith(root) && !seen.has(key)) {
      scanCache.delete(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 排隊

const locks = new Map<string, Promise<void>>();

/** 同一個工程的存檔點操作在程序裡排隊，一個做完再做下一個。 */
export async function withCheckpointLock<T>(project: NovelProject, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(project.root);
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

// ---------------------------------------------------------------- 讀

/**
 * 列出存檔點，新的在前。讀不懂的清單跳過（記一條 warn），不拋。讀過的清單記著（{@link manifestCache}）：「版本」側欄
 * 每存一次盤就要一次列表。裁舊的、清理物件那兩處要知道有沒有讀不懂的，走 {@link readAll}，不用記著的。
 */
export async function listCheckpoints(project: NovelProject): Promise<CheckpointInfo[]> {
  const dir = pointsDirOf(project);
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return [];
  }
  const list: CheckpointInfo[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (parseCheckpointId(id) === undefined) {
      continue;
    }
    const abs = path.join(dir, name);
    seen.add(abs);
    let stamp: string;
    try {
      const st = await fs.stat(abs);
      stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      continue;
    }
    let cached = manifestCache.get(abs);
    if (cached?.stamp !== stamp) {
      let manifest: CheckpointManifest | undefined;
      try {
        manifest = parseManifest(await fs.readFile(abs, 'utf8'), id);
      } catch {
        manifest = undefined;
      }
      if (!manifest) {
        log.warn(`讀不懂存檔點清單 ${name}，跳過`);
      }
      cached = { stamp, manifest };
      manifestCache.set(abs, cached);
    }
    if (cached.manifest) {
      list.push({ ...cached.manifest, id });
    }
  }
  // 裁掉了的存檔點不再佔著記憶體。
  for (const key of manifestCache.keys()) {
    if (path.dirname(key) === dir && !seen.has(key)) {
      manifestCache.delete(key);
    }
  }
  list.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  return list;
}

/**
 * 讀過的清單按「檔名 + 大小 + 修改時間 + 狀態改變時間」記著：一份清單列著全書每份檔案，幾十個存檔點每次都整份重讀重解析不值得。
 * 寫備註改了清單、裁掉了舊的，大小或修改時間變了、名字沒了，自然重讀。
 */
const manifestCache = new Map<string, { stamp: string; manifest: CheckpointManifest | undefined }>();

async function readAll(project: NovelProject): Promise<{ list: CheckpointInfo[]; unreadable: number }> {
  let names: string[];
  try {
    names = (await fs.readdir(pointsDirOf(project), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return { list: [], unreadable: 0 };
  }
  const list: CheckpointInfo[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const id = name.slice(0, -'.json'.length);
    if (parseCheckpointId(id) === undefined) {
      continue;
    }
    let manifest: CheckpointManifest | undefined;
    try {
      manifest = parseManifest(await fs.readFile(path.join(pointsDirOf(project), name), 'utf8'), id);
    } catch {
      manifest = undefined;
    }
    if (!manifest) {
      unreadable++;
      log.warn(`讀不懂存檔點清單 ${name}，跳過`);
      continue;
    }
    list.push({ ...manifest, id });
  }
  list.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  return { list, unreadable };
}

/** 讀一個存檔點的清單。不在、讀不懂都拋 `WsError('notFound')`。 */
export async function readCheckpoint(project: NovelProject, id: string): Promise<CheckpointInfo> {
  if (parseCheckpointId(id) === undefined) {
    throw new WsError('notFound', `找不到這個存檔點：${id}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path.join(pointsDirOf(project), `${id}.json`), 'utf8');
  } catch {
    throw new WsError('notFound', `找不到這個存檔點（可能已經被裁掉了）：${id}`);
  }
  const manifest = parseManifest(text, id);
  if (!manifest) {
    throw new WsError('notFound', `存檔點的清單讀不懂：${id}`);
  }
  return { ...manifest, id };
}

/** 讀存檔點裡的一份（位元組原樣）。存檔點裡沒有這一份、物件丟了、物件內容與 sha 對不上，都拋 `WsError('notFound')`。 */
export async function readCheckpointBytes(project: NovelProject, cp: CheckpointInfo, rel: string): Promise<Buffer> {
  const f = cp.files[rel];
  if (!f) {
    throw new WsError('notFound', `存檔點「${cp.id}」裡沒有 ${rel}`);
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(objectPathOf(project, f.sha));
  } catch {
    throw new WsError('notFound', `存檔點「${cp.id}」裡 ${rel} 的內容丟了`);
  }
  if (shaOf(buf) !== f.sha) {
    throw new WsError('notFound', `存檔點「${cp.id}」裡 ${rel} 的內容壞了（與記下的指紋對不上）`);
  }
  return buf;
}

/** 存檔點 ↔ 此刻（見 {@link compareFiles}），每份帶種類。 */
export async function diffCheckpoint(
  project: NovelProject,
  id: string
): Promise<{ unchanged: number; entries: (FileDiff & { kind: ArtifactKind })[] }> {
  const cp = await readCheckpoint(project, id);
  const { unchanged, entries } = compareFiles(cp.files, await scanCurrent(project), cp.skipped);
  return { unchanged, entries: entries.map((e) => ({ ...e, kind: kindOfPath(project, e.path).kind })) };
}

/** 一份檔案在某個存檔點裡的樣子（編輯器「版本」側欄的時間線上一行）。 */
export interface CheckpointVersion {
  /** 存檔點的 id。 */
  id: string;
  time: number;
  note: string;
  auto: boolean;
  words: number;
  bytes: number;
}

/**
 * 一份檔案在各存檔點裡的樣子，新的在前。**內容一樣的連著幾個只留最早那一個**：一行說的是「到這個存檔點，這一份變成了
 * 這樣」——三十個自動存檔點裡它一字沒動，就只有一行。中間有存檔點裡沒有它（當時刪了、還沒建）的，之後再出現算新的一行。
 */
export async function checkpointVersionsOf(project: NovelProject, rel: string): Promise<CheckpointVersion[]> {
  const out: CheckpointVersion[] = [];
  let prev: string | undefined;
  for (const cp of (await listCheckpoints(project)).slice().reverse()) {
    const f = cp.files[rel];
    if (f && f.sha !== prev) {
      out.push({ id: cp.id, time: cp.time, note: cp.note, auto: cp.auto, words: f.words, bytes: f.bytes });
    }
    prev = f?.sha;
  }
  return out.reverse();
}

// ---------------------------------------------------------------- 存

export interface CreateCheckpointResult {
  id: string;
  /** false：自動存檔點與最近一個一模一樣，沒有另存（`id` 是最近那一個）。 */
  created: boolean;
  files: number;
  /** 這一次新寫下的物件有幾個（其餘與以前的存檔點共用）。 */
  newObjects: number;
  skipped: string[];
  /** 自動的超出保留數，裁掉了哪幾個。 */
  pruned: string[];
}

/**
 * 存一個存檔點。`auto`：機器存的（批次動作之前、退回之前）——與最近一個存檔點一模一樣就不另存；存完按保留數
 * 裁掉最舊的自動存檔點並清理物件。手動的一模一樣也照樣存。會拋（磁碟滿、許可權……），自動那條路由呼叫方兜住。
 */
export function createCheckpoint(
  project: NovelProject,
  opts: { note: string; auto: boolean; now?: number }
): Promise<CreateCheckpointResult> {
  return withCheckpointLock(project, () => create(project, opts));
}

async function create(project: NovelProject, opts: { note: string; auto: boolean; now?: number }): Promise<CreateCheckpointResult> {
  const reason = await checkpointUnavailable(project);
  if (reason) {
    throw new WsError('notFound', reason);
  }
  await ensureRoot(project);

  const files: Record<string, CheckpointFile> = {};
  const skipped: string[] = [];
  let newObjects = 0;
  for (const rel of await trackedFiles(project)) {
    const abs = project.pathOf(rel);
    let buf: Buffer;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_EDITABLE_BYTES) {
        skipped.push(rel);
        continue;
      }
      buf = await fs.readFile(abs);
    } catch {
      continue; // 列的時候還在、讀的時候沒了
    }
    const sha = shaOf(buf);
    if (await writeObject(project, sha, buf)) {
      newObjects++;
    }
    files[rel] = { sha, bytes: buf.length, words: countWords(decodeFileText(buf)) };
  }

  const { list } = await readAll(project);
  if (opts.auto && list[0] && sameFiles(list[0].files, files)) {
    log.debug(`與最近一個存檔點一模一樣，不另存`, `${opts.note}｜沿用 ${list[0].id}`);
    return { id: list[0].id, created: false, files: Object.keys(files).length, newObjects, skipped, pruned: [] };
  }

  const now = opts.now ?? Date.now();
  const manifest: CheckpointManifest = { v: 1, time: now, note: opts.note.trim(), auto: opts.auto, files, skipped };
  const id = await writeManifestUnique(project, new Date(now), manifest);
  log.info(
    `存了一個存檔點 ${id}`,
    `${opts.auto ? '自動' : '手動'}｜${manifest.note || '（沒寫備註）'}｜${Object.keys(files).length} 份，新存 ${newObjects} 份內容` +
      (skipped.length ? `｜超過大小上限沒存 ${skipped.length} 份` : '')
  );

  let pruned: string[] = [];
  if (opts.auto) {
    pruned = checkpointsToPrune([{ id, auto: true }, ...list]);
    for (const stale of pruned) {
      await fs.unlink(path.join(pointsDirOf(project), `${stale}.json`)).catch(() => undefined);
    }
    if (pruned.length > 0) {
      log.debug(`裁掉最舊的 ${pruned.length} 個自動存檔點`, `只留最近 ${CHECKPOINT_AUTO_KEEP} 個`);
      await gc(project, now);
    }
  }
  return { id, created: true, files: Object.keys(files).length, newObjects, skipped, pruned };
}

/**
 * 給一個存檔點寫備註。自動的寫了備註就留住（變成手動，不再被裁掉）；備註空著時手動的照樣是手動。返回改好的那一份。
 */
export function noteCheckpoint(project: NovelProject, id: string, note: string): Promise<CheckpointInfo> {
  return withCheckpointLock(project, async () => {
    const cp = await readCheckpoint(project, id);
    const trimmed = note.trim();
    const next: CheckpointManifest = {
      v: 1,
      time: cp.time,
      note: trimmed || cp.note,
      auto: false,
      files: cp.files,
      skipped: cp.skipped,
    };
    const file = path.join(pointsDirOf(project), `${id}.json`);
    const tmp = path.join(pointsDirOf(project), `.${randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(next, null, 1), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, file);
    log.info(`存檔點 ${id} 寫了備註、留住了`, trimmed);
    return { ...next, id };
  });
}

/** 清理沒人引用的物件（見檔案頭）。返回刪了幾個。 */
export function collectGarbage(project: NovelProject, now = Date.now()): Promise<number> {
  return withCheckpointLock(project, () => gc(project, now));
}

async function gc(project: NovelProject, now: number): Promise<number> {
  const { list, unreadable } = await readAll(project);
  if (unreadable > 0) {
    log.warn(`有 ${unreadable} 份存檔點清單讀不懂，這一次不清理物件`, '不知道它們引用了哪些內容，寧可多留');
    return 0;
  }
  const referenced = new Set<string>();
  for (const cp of list) {
    for (const f of Object.values(cp.files)) {
      referenced.add(f.sha);
    }
  }
  let removed = 0;
  const root = objectsDirOf(project);
  let prefixes: string[];
  try {
    prefixes = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }
  for (const prefix of prefixes) {
    const dir = path.join(root, prefix);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (referenced.has(`${prefix}${name}`)) {
        continue;
      }
      const abs = path.join(dir, name);
      try {
        const stat = await fs.stat(abs);
        if (now - stat.mtimeMs < ORPHAN_GRACE_MS) {
          continue;
        }
        await fs.unlink(abs);
        removed++;
      } catch {
        // 別處剛刪掉：跳過。
      }
    }
    await fs.rmdir(dir).catch(() => undefined); // 只刪空的
  }
  if (removed > 0) {
    log.debug(`清掉 ${removed} 份沒有存檔點再用到的內容`);
  }
  return removed;
}

// ---------------------------------------------------------------- 寫盤（這一層自己的）

/**
 * 存檔點目錄第一次出現時放一個 `.gitignore`（`*`）。只在**建出這個目錄**的那一次放：作者刪掉它就是想讓
 * git 收存檔點，之後不再補回來（同歷史版本）。
 */
async function ensureRoot(project: NovelProject): Promise<void> {
  if (await isDir(project.checkpointsDir)) {
    return;
  }
  await fs.mkdir(project.checkpointsDir, { recursive: true });
  await fs
    .writeFile(path.join(project.checkpointsDir, '.gitignore'), CHECKPOINT_GITIGNORE, { encoding: 'utf8', flag: 'wx' })
    .catch(() => undefined);
}

/** 寫一個物件；已經有了（大小也對得上）就不寫。先寫臨時檔案再改名。返回是不是新寫的。 */
async function writeObject(project: NovelProject, sha: string, buf: Buffer): Promise<boolean> {
  const abs = objectPathOf(project, sha);
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile() && stat.size === buf.length) {
      return false;
    }
  } catch {
    // 沒有：往下寫。
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, buf, { flag: 'wx' });
  await fs.rename(tmp, abs);
  return true;
}

/**
 * 按那一刻起名寫下清單；同一秒已經有了就加序號。先寫臨時檔案再改名（斷電時不留半份清單——半份清單讀不懂，
 * 會讓清理整個停下來）；改名之前看一眼那個名字沒人用，絕不蓋掉已有的那一份（同一程序裡有鎖，跨程序撞在同一秒同一個
 * 序號上的機會可以不計）。
 */
async function writeManifestUnique(project: NovelProject, at: Date, manifest: CheckpointManifest): Promise<string> {
  const dir = pointsDirOf(project);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 1), { encoding: 'utf8', flag: 'wx' });
  try {
    for (let dup = 1; dup < 1000; dup++) {
      const id = checkpointIdOf(at, dup);
      const file = path.join(dir, `${id}.json`);
      if (await exists(file)) {
        continue;
      }
      await fs.rename(tmp, file);
      return id;
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fs.unlink(tmp).catch(() => undefined);
  throw new Error('同一秒裡存了太多存檔點');
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}
