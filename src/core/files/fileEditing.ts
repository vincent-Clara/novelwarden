import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { isChapterFileName } from '../model/chapterFile';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { Workspace } from '../workspace';
import {
  MAX_EDITABLE_BYTES,
  WsConflictError,
  WsError,
  resolveInRoot,
  toRelPosix,
} from '../workspace/guard';

const log = scoped('編輯器');

/**
 * 內建編輯器的檔案讀寫。宿主無關：獨立版把它接到網頁編輯器上，
 * 外掛殼不用（那邊直接開 VS Code 的編輯器 tab）。
 *
 * ## 只剩兩件事
 *
 * 三條硬約束（工程根包含、大小上限、內容 hash 樂觀鎖）已經搬進
 * `workspace/guard.ts`，這裡只留：
 *
 * 1. **可編輯判定**（副檔名白名單 ∪ 章節檔名規則）——那是**這個編輯器**
 *    的口徑，不是閘道器的：閘道器照樣讀寫 `.rtf`，只是網頁裡的 textarea 不該
 *    去開啟一個 `.png`。
 * 2. **`EditorFile` 的形狀轉換**——前端要的是 `{path, name, text, hash, bytes}`，
 *    閘道器給的是 `WsFile`。
 *
 * 外加編輯器自己的兩條口徑：儲存時磁碟上沒了這個檔案就停下來問（`FileGoneError`，比閘道器嚴一檔），
 * 以及按 hash 核對開著的幾份檔案在磁碟上變沒變（`checkEditorFiles`，只讀）。
 *
 * 落盤因此**經閘道器**：作者在內建編輯器裡改一份細綱，`upstreamHash` 現在會
 * 跟著更新（記賬下沉，見 workspace/README.md）。從前那條路直接
 * `fs.writeFile`，指紋鏈就斷在那兒。
 */

/**
 * 允許在內建編輯器裡開啟/儲存的副檔名。都是純文字，與「資料即 Markdown」的承諾一致。
 * 章節另有一條規則，見 isEditablePath。
 */
export const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml'];

export { MAX_EDITABLE_BYTES, resolveInRoot, toRelPosix };

/** 不可編輯（越界 / 副檔名不符 / 太大 / 不是檔案）。呼叫方據此決定是否回落到系統程式。 */
export class FileEditError extends Error {
  readonly name = 'FileEditError';
}

/** 儲存時發現磁碟內容已與編輯器基線不一致。帶上磁碟版本，供前端展示與取捨。 */
export class FileConflictError extends Error {
  readonly name = 'FileConflictError';
  constructor(
    readonly diskText: string,
    readonly diskHash: string
  ) {
    super('檔案已被外部修改，儲存已取消。');
  }
}

/**
 * 儲存時帶了基線、磁碟上卻已經沒有這個檔案（被刪、被改名），而作者沒說要在原路徑重建。
 *
 * 閘道器自己的口徑是「檔案被刪了不算衝突，當新建處理」（`workspace/guard.ts` 守衛 8）——對誰都一樣的
 * 寫入入口，這麼定沒錯。**編輯器這條路收緊一檔**：編輯器裡那份是照著一個已經不在的檔案改的，
 * 靜默在原路徑重建一份，作者在外面改的名就白改了（新名字那邊一份、原名字這邊又冒出一份）。
 * 所以先停下來交回前端問一句，答應了再帶 `recreate` 來。
 */
export class FileGoneError extends Error {
  readonly name = 'FileGoneError';
  constructor(readonly relPath: string) {
    super(`磁碟上已經沒有這個檔案：${relPath}`);
  }
}

/** 推給前端的一份檔案快照。`hash` 是儲存時的樂觀鎖基線。 */
export interface EditorFile {
  /** 工程內相對路徑（正斜槓）。 */
  path: string;
  /** 檔名，標籤頁上顯示。 */
  name: string;
  text: string;
  /** 內容 hash，儲存時回傳作為基線。 */
  hash: string;
  bytes: number;
}

export function isEditablePath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  if (EDITABLE_EXTENSIONS.includes(ext)) {
    return true;
  }
  // 章節可以叫 `001-楔子`（無副檔名）或 `001-手記.rtf`——白名單擋不住它們，
  // 但樹上看得見就必須打得開，否則點一下只彈「不是可編輯的文字檔案」。
  // 章節判定本身已經排掉了二進位制副檔名，工程根包含檢查與大小上限照舊兜底。
  return isChapterFileName(path.basename(relPath));
}

/**
 * 讀一份給編輯器用的快照。
 * 越界、副檔名不符、體積過大、不是普通檔案都拋 FileEditError。
 */
export async function readFileForEditor(root: string, relPath: string): Promise<EditorFile> {
  if (!isEditablePath(relPath)) {
    throw new FileEditError(`不是可編輯的文字檔案：${relPath}`);
  }
  const ws = new Workspace(NovelProject.open(root));
  try {
    const file = await ws.read(relPath);
    log.debug(`開啟 ${relPath}`, `${file.bytes} 位元組`);
    return { path: file.rel, name: path.basename(file.rel), text: file.text, hash: file.hash, bytes: file.bytes };
  } catch (err) {
    throw asEditError(err, relPath);
  }
}

/**
 * 儲存編輯器裡的內容。
 *
 * `baseHash` 是前端拿到這份檔案時的 hash：磁碟上的當前 hash 與它不一致，
 * 說明作者在別處改過（或另一個標籤頁存過），此時拋 FileConflictError 而不是覆蓋。
 * 傳空 baseHash 表示放棄樂觀鎖（使用者已在衝突提示裡明確選擇「強制覆蓋」）。
 *
 * 帶了 baseHash、磁碟上卻沒有這個檔案時拋 {@link FileGoneError}，**不在原路徑重建**；
 * `opts.recreate` 是作者答應過重建（這時照常帶著基線：期間又有人在原路徑放了一份的話，樂觀鎖照樣攔）。
 *
 * **`review: false` 是有意的**：樂觀鎖已經是這條路自己那道閘，作者手裡的
 * 那份就是他要寫的東西，再拿它和自己 diff 一遍沒有意義。
 */
export async function writeFileFromEditor(
  root: string,
  relPath: string,
  text: string,
  baseHash?: string,
  opts?: { recreate?: boolean }
): Promise<EditorFile> {
  if (!isEditablePath(relPath)) {
    throw new FileEditError(`不是可編輯的文字檔案：${relPath}`);
  }
  // 越界先攔：`../escape.md` 也是 `.md`，可編輯判定放它過。放到後面的話，
  // 下面那句「強制儲存」會先落進日誌，而這次儲存根本沒發生。
  let abs: string;
  try {
    abs = resolveInRoot(root, relPath);
  } catch (err) {
    throw asEditError(err, relPath);
  }
  const ws = new Workspace(NovelProject.open(root));
  if (!baseHash) {
    log.warn(`強制儲存 ${relPath}（使用者已確認覆蓋磁碟版本）`);
  } else if (!opts?.recreate && !ws.isOutline(relPath) && !(await exists(abs))) {
    // 情節大綱本來就沒有檔案（各章細綱梗概的彙總），不算「磁碟上沒有了」。
    log.warn(`儲存被拒：${relPath} 在磁碟上已經沒有了`, '沒有在原路徑重建，交回前端問作者。');
    throw new FileGoneError(relPath);
  }

  try {
    const r = await ws.write(relPath, { text }, { mode: 'overwrite', review: false, baseHash });
    const bytes = Buffer.byteLength(text, 'utf8');
    log.info(`已儲存 ${relPath}`, `${bytes} 位元組${r.side?.length ? `｜${r.side.join('｜')}` : ''}`);
    return { path: r.rel, name: path.basename(r.rel), text, hash: hash(text), bytes };
  } catch (err) {
    throw asEditError(err, relPath);
  }
}

/**
 * 一次最多核對幾份。兩塊編輯區開著的標籤遠到不了這個數；超出的不核對（不回話），
 * 免得一條手搓的訊息讓後端讀幾千個檔案。
 */
export const MAX_CHECKED_FILES = 200;

/** {@link checkEditorFiles} 的結果：磁碟上變了的（帶新版），以及讀不到的（被刪、被改名）。 */
export interface EditorDiskReport {
  changed: EditorFile[];
  gone: string[];
}

/**
 * 核對編輯器裡開著的幾份檔案在磁碟上還是不是編輯器知道的那一份（`checkEditorFiles` 訊息）。
 *
 * - hash 對不上：進 `changed`，帶磁碟上的新版（`path` 原樣用前端給的，前端按它認標籤）。
 * - 讀不到（不存在、不是檔案）：進 `gone`。
 * - 越界、不可編輯、超過大小上限、路徑不是字串：跳過，不回話——這幾樣編輯器本來就打不開，
 *   核對它們沒有意義，也不該因為一條壞訊息讓整批作廢。
 *
 * 只讀，一個位元組都不寫。同一路徑給了兩次只核對一次。
 */
export async function checkEditorFiles(
  root: string,
  files: readonly { path?: unknown; hash?: unknown }[]
): Promise<EditorDiskReport> {
  const report: EditorDiskReport = { changed: [], gone: [] };
  const ws = new Workspace(NovelProject.open(root));
  const seen = new Set<string>();
  for (const item of files.slice(0, MAX_CHECKED_FILES)) {
    const rel = item?.path;
    const known = item?.hash;
    if (typeof rel !== 'string' || typeof known !== 'string' || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    if (!isEditablePath(rel)) {
      continue;
    }
    try {
      resolveInRoot(root, rel);
    } catch {
      log.warn(`核對磁碟時跳過越界路徑：${rel}`);
      continue;
    }
    try {
      const file = await ws.read(rel);
      if (file.hash !== known) {
        report.changed.push({ path: rel, name: path.basename(file.rel), text: file.text, hash: file.hash, bytes: file.bytes });
      }
    } catch (err) {
      if (err instanceof WsError && (err.code === 'notFound' || err.code === 'notFile')) {
        report.gone.push(rel);
      } else if (!(err instanceof WsError)) {
        throw err;
      }
    }
  }
  if (report.changed.length || report.gone.length) {
    log.debug(
      '核對磁碟',
      `變了 ${report.changed.map((f) => f.path).join('、') || '無'}；沒了 ${report.gone.join('、') || '無'}`
    );
  }
  return report;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 閘道器的錯誤 → 編輯器的錯誤。
 *
 * 兩類要分開：衝突帶著磁碟版本回前端由使用者取捨，其餘一律是「打不開/存不下」。
 * 不是 `WsError` 的（真正的 I/O 異常）原樣上拋——那些是呼叫方該知道的事。
 */
function asEditError(err: unknown, relPath: string): unknown {
  if (err instanceof WsConflictError) {
    log.warn(
      `儲存被拒：${relPath} 在磁碟上已被改過`,
      `磁碟 ${err.diskHash}。已把磁碟版本交回前端由使用者取捨，未覆蓋。`
    );
    return new FileConflictError(err.diskText, err.diskHash);
  }
  if (err instanceof WsError) {
    return new FileEditError(err.message);
  }
  return err;
}
