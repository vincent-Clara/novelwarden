/**
 * 統一入口守衛。**六處各帶一部分保護、誰也不認識誰**的局面到此為止。
 *
 * 從前的分佈：
 *
 * | 位置 | 帶哪些保護 |
 * | --- | --- |
 * | `files/fileOps.ts` | 區界限、同名不覆蓋、`.trash` |
 * | `files/fileEditing.ts` | 工程根包含、副檔名白名單、大小上限、內容 hash 樂觀鎖 |
 * | `files/projectFiles.ts` | 工程根包含、`isProtectedPath`、同名不覆蓋 |
 * | `features/creation.ts` | `confirmOverwrite` / `reviewReplace` |
 *
 * 這就是為什麼從前不敢給 agent 一個 `write`。八條守衛收進這一份，
 * `workspace/index.ts` 的每個寫盤方法全過一遍，**新程式碼不許繞過這裡直接
 * `fs.writeFile`**。
 *
 * | # | 守衛 | 觸發時怎麼辦 |
 * |---|---|---|
 * | 1 | 路徑規範化（絕對路徑 / `..` 逃逸 / 空串） | `WsError('outOfRoot')` |
 * | 2 | 工程根包含檢查（解析成絕對路徑再比一次） | `WsError('outOfRoot')` |
 * | 3 | 固定目錄保護（改名/刪除） | `WsError('protected')` |
 * | 4 | `.trash/` 內容不可**改**（讀得到，作者要能找回東西）；歷史版本 `.novelwarden/history/`（舊工程 `.novelforge/history/`）寫不進去（同樣讀得到） | `WsError('inTrash')` / `WsError('inHistory')` |
 * | 5 | 大小上限 2MB（讀、寫各一次） | `WsError('tooLarge')` |
 * | 6 | 同名不覆蓋（`mode: 'create'`） | `WsError('exists')` |
 * | 7 | 覆蓋前審閱（`reviewReplace` 或確認框） | 使用者拒絕 → 呼叫方 `{skipped:true}` |
 * | 8 | 內容 hash 樂觀鎖 | `WsConflictError(diskText, diskHash)` |
 *
 * **區界限不在這裡**：`fileOps` 的三區約束（章節挪不進角色目錄）是**工程頁
 * 的產品承諾**，比這裡的工程根約束更嚴。那一層留在 `fileOps` 裡，先判區再
 * 調閘道器。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { hash } from '../model/fs';
import { LEGACY_NOVEL_DIRS, NOVEL_DIR, NovelProject } from '../model/project';
import { normalizeRel } from './kind';

const log = scoped('工作區');

export type WsErrorCode =
  | 'outOfRoot'
  | 'protected'
  | 'inTrash'
  /** 歷史版本（`.novelwarden/history/`，舊工程是 `.novelforge/history/`）裡寫不進去：那是閘道器自己存的副本。讀得到。 */
  | 'inHistory'
  /** 目錄複製進它自己裡面。 */
  | 'intoSelf'
  | 'tooLarge'
  | 'exists'
  | 'notFound'
  | 'notFile'
  | 'notUnique'
  | 'conflict';

/** 守衛拒絕的統一形狀。`code` 是給呼叫方分支用的，`message` 直接進 toast。 */
export class WsError extends Error {
  readonly name = 'WsError';
  constructor(
    readonly code: WsErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * 樂觀鎖失敗：磁碟上的內容與呼叫方的基線不一致。
 *
 * 帶上磁碟版本交回前端由使用者取捨——**絕不靜默覆蓋**（AGENTS 第 3 條）。
 */
export class WsConflictError extends WsError {
  constructor(
    readonly diskText: string,
    readonly diskHash: string
  ) {
    super('conflict', '檔案已被外部修改，儲存已取消。');
  }
}

/**
 * 單檔案大小上限。再大就不進編輯器、也不進閘道器——一個 textarea 裝不下，
 * 塞進模型上下文更是純燒錢。
 */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/**
 * 後設資料目錄名，從新到舊。舊工程沒遷移時資料在舊目錄裡——**兩個都保護**，
 * 免得哪條檔案操作把作者還沒遷移的那一份整個搬走或刪掉。
 */
const METADATA_DIRS = [NOVEL_DIR, ...LEGACY_NOVEL_DIRS];

/**
 * 後設資料目錄下被程式碼寫死名字的那些子目錄。改了名就等於那批資料憑空消失，
 * **而介面上只會顯示「還沒生成過」**。所以這裡列的是全部固定子目錄，
 * 不只是作者常看見的那幾個。
 */
const METADATA_SUBDIRS = [
  'characters',
  'lore',
  'summaries',
  // 敘事線：一條線一個檔案（model/threadFile.ts）。整個目錄搬走或刪掉，所有線一起「還沒排過」。
  'threads',
  'skills',
  // 場景、卷、中轉站三層都已經刪掉（見 model/pipeline.ts 的檔案頭），細綱也從 `plots/`
  // 搬進了 `summaries/`，但老工程磁碟上那幾個目錄還在，而且是作者的檔案。留在這張表裡，
  // 免得哪條檔案操作把它們整棵刪掉——程式碼不再讀它們，不等於可以替作者處置它們。
  'plots',
  'scenes',
  'volumes',
  'manuscripts',
  'sessions',
  '.trash',
  // 歷史版本：閘道器自己存的副本（workspace/history.ts）。整個目錄搬走或刪掉，所有檔案的歷史一起沒了。
  'history',
  // 存檔點（workspace/checkpoints.ts）：內部檔案，本來就碰不到；列在這裡與歷史版本一樣多一道保險。
  'checkpoints',
];

/**
 * 工程的固定目錄：改名/搬走會讓工程結構散架（章節索引、草稿映象、
 * 後設資料與會話）。
 *
 * 後設資料目錄按**磁碟上實際存在的那個**（{@link NovelProject.novelDirName}）與兩級舊名字一起算：
 * 舊工程沒遷移時讀寫落在舊目錄，作者也不該經由檔案頁把它搬走。
 */
export function isProtectedPath(project: NovelProject, relPath: string): boolean {
  const rel = normalizeRel(relPath);
  if (!rel) {
    return true;
  }
  const fixed = new Set<string>([project.relPath(project.chaptersDir), project.relPath(project.draftsDir)]);
  for (const dir of new Set([...METADATA_DIRS, project.novelDirName])) {
    fixed.add(dir);
    for (const sub of METADATA_SUBDIRS) {
      fixed.add(`${dir}/${sub}`);
    }
  }
  return fixed.has(rel);
}

/** 工程庫的檔名。改名前的庫（`novelforge.db`）不刪，也一樣當內部檔案。 */
const DB_FILES = ['novelwarden.db', 'novelforge.db'];
const DB_SUFFIXES = ['', '-wal', '-shm', '-journal'];
/** 三個後設資料目錄下的兩種庫檔名（連同 WAL 帶出的字尾）。 */
const DB_PATHS = new Set(
  METADATA_DIRS.flatMap((dir) => DB_FILES.flatMap((name) => DB_SUFFIXES.map((suffix) => `${dir}/${name}${suffix}`)))
);

/**
 * Novelwarden 自己的內部檔案：工程庫（`novelwarden.db` 與 WAL 模式帶出的 `-wal` / `-shm`，
 * 舊庫 `novelforge.db` 同理）、會話記錄與存檔點。
 * 它們不是作品內容，讀出來是二進位制亂碼、對話流水或一堆按 hash 命名的物件，改壞了是整頁起不來、存檔點退不回去。
 * 所以列目錄、搜尋裡看不見，讀當不存在，寫、改、搬一律拒絕。存檔點只經「存檔點」面板看（workspace/checkpoints.ts）。
 */
export function isInternalPath(project: NovelProject, rel: string): boolean {
  if (DB_PATHS.has(rel)) {
    return true;
  }
  const sessions = project.relPath(project.sessionsDir);
  const checkpoints = project.relPath(project.checkpointsDir);
  return (
    rel === sessions ||
    rel.startsWith(`${sessions}/`) ||
    rel === checkpoints ||
    rel.startsWith(`${checkpoints}/`)
  );
}

/** 回收站目錄（新舊後設資料目錄都認）。`.trash/` 裡躺著剛刪掉的東西，不是操作物件。 */
function trashDirs(project: NovelProject): string[] {
  return [...new Set([project.relPath(project.trashDir), ...METADATA_DIRS.map((dir) => `${dir}/.trash`)])];
}

/** 這條路徑在回收站裡（當前工程的，或舊後設資料目錄下的）。 */
export function isInTrash(project: NovelProject, rel: string): boolean {
  return trashDirs(project).some((trash) => rel === trash || rel.startsWith(`${trash}/`));
}

/**
 * 這條路徑在歷史版本裡（`.novelwarden/history/`，舊工程是 `.novelforge/history/`；見 workspace/history.ts）。那是一份份舊稿：檢索跳過它，
 * 與回收站同一個理由——搜出來的不是現在的書。新舊目錄都認。
 */
export function isInHistory(project: NovelProject, rel: string): boolean {
  const history = [
    ...new Set([project.relPath(project.historyDir), ...METADATA_DIRS.map((dir) => `${dir}/history`)]),
  ];
  return history.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/**
 * 守衛 1 + 2：相對路徑 → 絕對路徑，並保證不逃出工程根。
 *
 * 兩道各攔一半：`normalizeRel` 擋的是字面上的越界（`../`、`C:\`、空串），
 * 這裡擋的是**歸一化之後仍然逃出去**的（`a/../../b`）與工程根自己。
 * 只做邏輯路徑包含檢查（不解析 symlink）：本機單使用者場景下夠了，
 * realpath 會讓每次讀寫多一次系統呼叫。
 *
 * 只收 `root` 而不是整個 `NovelProject`：目錄列舉（`files/fileTree.ts`）
 * 手裡只有一個路徑字串，它要的也正是這一條判據。
 */
export function resolveInRoot(root: string, relPath: string): string {
  const rel = normalizeRel(relPath);
  if (rel === undefined) {
    throw new WsError('outOfRoot', `路徑超出工程目錄：${relPath}`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const back = path.relative(base, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new WsError('outOfRoot', `路徑超出工程目錄：${relPath}`);
  }
  return abs;
}

/** 絕對路徑 → 工程內相對路徑（正斜槓，跨平臺一致）。 */
export function toRelPosix(root: string, absPath: string): string {
  return path.relative(path.resolve(root), absPath).replace(/\\/g, '/');
}

/**
 * 讀之前過一遍：返回絕對路徑。
 *
 * **回收站裡的東西讀得到**——作者要能翻進去找回刪掉的稿子。不可操作的是
 * 改名/刪除/寫入，見 `guardMutate` / `guardWrite`。
 */
export async function guardRead(project: NovelProject, relPath: string): Promise<string> {
  const abs = resolveInRoot(project.root, relPath);
  if (isInternalPath(project, normalizeRel(relPath)!)) {
    throw new WsError('notFound', `檔案不存在：${relPath}`);
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new WsError('notFound', `檔案不存在：${relPath}`);
  }
  if (!stat.isFile()) {
    throw new WsError('notFile', `不是檔案：${relPath}`);
  }
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new WsError(
      'tooLarge',
      `檔案超過 ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB，不讀：${relPath}`
    );
  }
  return abs;
}

export interface GuardWriteOptions {
  mode: 'create' | 'overwrite' | 'append';
  /** 樂觀鎖基線。給了就比對，磁碟變過報衝突。 */
  baseHash?: string;
  /** 要寫的內容。給了就一併做大小檢查——寫超限的東西不該等到落盤才發現。 */
  text?: string;
}

export interface GuardWriteResult {
  abs: string;
  existed: boolean;
  /** 目標已存在時的當前內容。供覆蓋審閱比對，省掉呼叫方再讀一次。 */
  current?: string;
}

/**
 * 寫之前過一遍。返回絕對路徑與「目標是否已存在」。
 *
 * 檢查順序是有意的：越界 → 內部檔案 / 回收站 / 歷史版本 → 大小 → 存在性 → 同名 → 樂觀鎖。
 * 先攔最便宜、最致命的，最後才讀盤。
 */
export async function guardWrite(
  project: NovelProject,
  relPath: string,
  opts: GuardWriteOptions
): Promise<GuardWriteResult> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;

  guardArea(project, rel);
  if (opts.text !== undefined && Buffer.byteLength(opts.text, 'utf8') > MAX_EDITABLE_BYTES) {
    throw new WsError('tooLarge', '內容超過大小上限，未寫入。');
  }

  let stat: import('node:fs').Stats | undefined;
  try {
    stat = await fs.stat(abs);
  } catch {
    stat = undefined;
  }
  if (stat && !stat.isFile()) {
    throw new WsError('notFile', `目標不是檔案：${rel}`);
  }
  if (stat && opts.mode === 'create') {
    throw new WsError('exists', `已存在：${rel}`);
  }

  let current: string | undefined;
  if (stat) {
    current = await fs.readFile(abs, 'utf8');
  }

  // 守衛 8：磁碟上的當前 hash 與基線不一致 = 作者在別處改過（或另一個標籤頁
  // 存過）。**檔案被刪了不算衝突**，當作新建處理——逐字沿用 fileEditing 的行為。
  if (opts.baseHash && current !== undefined) {
    const diskHash = hash(current);
    if (diskHash !== opts.baseHash) {
      log.warn(
        `寫入被拒：${rel} 在磁碟上已被改過`,
        `基線 ${opts.baseHash}，磁碟 ${diskHash}。已把磁碟版本交回呼用方由使用者取捨，未覆蓋。`
      );
      throw new WsConflictError(current, diskHash);
    }
  }

  return { abs, existed: stat !== undefined, current };
}

/**
 * 寫、建、複製的落點共用的一道：這三處**不是作者的操作物件**，什麼都寫不進去——
 *
 * - Novelwarden 自己的內部檔案（會話、工程庫、存檔點）：`protected`
 * - 回收站：`inTrash`（裡面躺著刪掉的東西，往裡寫等於偽造一份「刪掉過的」）
 * - 歷史版本：`inHistory`（閘道器自己存的副本；往裡塞檔案，「歷史」面板裡就多出一份作者從沒存過的「舊版」）
 *
 * 三處都**讀得到**（會話與存檔點除外，它們讀當不存在）：回收站與歷史版本是作者找回東西的地方。
 */
function guardArea(project: NovelProject, rel: string): void {
  if (isInternalPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是 Novelwarden 自己的內部檔案，不能寫。`);
  }
  if (isInTrash(project, rel)) {
    throw new WsError('inTrash', `回收站裡的內容不能寫：${rel}`);
  }
  if (isInHistory(project, rel)) {
    throw new WsError('inHistory', `歷史版本是閘道器自己存的副本，不能往裡寫：${rel}`);
  }
}

/**
 * 新建一個東西（目錄，或複製出來的一份）之前過一遍：越界、寫不進去的三處（{@link guardArea}）、落點上已經有東西。
 * 與 `guardWrite` 的 `mode: 'create'` 同一套，只是**落點上有什麼都算同名**——目錄也算（`guardWrite` 把它報成
 * `notFile`，對「建一個目錄」「複製一個目錄過去」來說那句話說反了）。返回絕對路徑。
 */
export async function guardCreate(project: NovelProject, relPath: string): Promise<string> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;
  guardArea(project, rel);
  try {
    await fs.lstat(abs);
  } catch {
    return abs;
  }
  throw new WsError('exists', `已存在：${rel}`);
}

/**
 * 複製的來源過一遍：在工程內、存在、不是符號連結、不是固定目錄（整個 `chapters/`、`.novelwarden/` 這種複製一份出來只是一堆
 * 重號的章，與檔案頁從前的規矩一樣不收）、不是內部檔案（會話與工程庫讀當不存在，也就複製不出來）。
 *
 * **回收站與歷史版本裡的東西可以複製出來**：複製只讀來源，讀得到就複製得出來——這是在工程裡找回一份的入口，
 * 回收站與歷史一個位元組都不動（搬出來仍然不行，那是改回收站，見 `guardMutate`）。
 */
export async function guardCopySource(
  project: NovelProject,
  relPath: string
): Promise<{ abs: string; rel: string; isDir: boolean }> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;
  if (isProtectedPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是工程的固定目錄，不能整個複製。`);
  }
  if (isInternalPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是 Novelwarden 自己的內部檔案，不能複製。`);
  }
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(abs);
  } catch {
    throw new WsError('notFound', `找不到：${rel}`);
  }
  // 符號連結不跟：鏈到工程外的東西不該被抄進工程（守衛 2 只比邏輯路徑，不解析連結）。
  if (stat.isSymbolicLink()) {
    throw new WsError('notFile', `「${rel}」是符號連結，不復制。`);
  }
  return { abs, rel, isDir: stat.isDirectory() };
}

/**
 * 改名/移動/刪除之前過一遍。比讀多兩條：保護路徑、回收站。
 *
 * 目錄也是合法物件（搬 `chapters/卷一/` 是正常操作），所以不判 `isFile`。
 */
export async function guardMutate(project: NovelProject, relPath: string): Promise<string> {
  const abs = resolveInRoot(project.root, relPath);
  const rel = normalizeRel(relPath)!;

  if (isProtectedPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是工程的固定目錄，不能改名或搬走。`);
  }
  if (isInternalPath(project, rel)) {
    throw new WsError('protected', `「${rel}」是 Novelwarden 自己的內部檔案，不能改名、搬走或刪除。`);
  }
  if (isInTrash(project, rel)) {
    throw new WsError('inTrash', `回收站裡的內容不能操作：${rel}`);
  }
  try {
    await fs.stat(abs);
  } catch {
    throw new WsError('notFound', `找不到：${rel}`);
  }
  return abs;
}

/**
 * 覆蓋前審閱。返回「可以寫了嗎」，以及要寫的是哪一份。
 *
 * 有 `reviewReplace` 的宿主開 diff：外掛是 diff 編輯器，作者能逐行看清改了什麼；獨立版是
 * 段級 diff / 合併檢視（五期 W11），作者可以逐段挑、手改，交回來的 `text` 就是他挑過的那一份，
 * 寫它而不是新版全文。沒有的宿主退化成一個帶字數對比的確認框。**都沒有確認就不寫。**
 *
 * 內容一模一樣時不問——一字未變還彈個框，只會讓人以為自己點錯了。
 *
 * 逐字搬自 `features/creation.ts` 的 `confirmOverwrite`：那兩句文案
 * （`「${what}」已經有內容了，用新版本覆蓋？`、`現有 N 字，新版 M 字`）
 * **是產品承諾的一部分，不要改措辭**。
 */
export async function reviewOverwrite(
  what: string,
  relPath: string,
  current: string,
  next: string
): Promise<{ ok: boolean; text?: string }> {
  if (current.trim() === next.trim()) {
    return { ok: true };
  }

  const host = getHost();
  const answer = host.reviewReplace ? await host.reviewReplace(what, current, next, relPath, { merge: true }) : undefined;
  if (typeof answer === 'object') {
    // 作者在合併檢視裡挑過：挑完與現有的一字不差（全保留原樣）也照樣算「寫了」——落盤是冪等的。
    log.info(`按合併結果覆蓋${what}`, `${answer.merged.length} 字（新版 ${next.length} 字，現有 ${current.length} 字）`);
    return { ok: true, text: answer.merged };
  }
  const verdict = host.reviewReplace
    ? answer
    : await host
        .confirm(`「${what}」已經有內容了，用新版本覆蓋？`, ['覆蓋', '保留原樣'], {
          modal: true,
          detail: `現有 ${current.length} 字，新版 ${next.length} 字。\n${relPath}`,
        })
        .then((pick) => (pick === '覆蓋' ? 'apply' : pick === '保留原樣' ? 'discard' : undefined));

  if (verdict !== 'apply') {
    log.info(`未覆蓋${what}`, verdict === 'discard' ? '使用者選擇保留原樣' : '使用者取消');
    return { ok: false };
  }
  return { ok: true };
}
