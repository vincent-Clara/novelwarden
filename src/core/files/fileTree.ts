import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isEditablePath, resolveInRoot, toRelPosix } from './fileEditing';
import { scoped } from '../runtime/logger';

const log = scoped('檔案樹');

/**
 * 資源管理器（獨立版側欄的「檔案」頁）的資料來源。
 *
 * 與 [projectView.ts](../views/projectView.ts) 是兩件不同的事，別把它們合起來：
 * 那邊是**按語義整理過的**工程檢視（章節按 order 倒序、定稿狀態、角色別名），
 * 只包含三個可管理區裡的檔案；這裡是**磁碟上真實的目錄結構**，
 * 一個檔案都不隱藏——包括 `.novelwarden/`（細綱、會話、角色卡原文都在裡面），
 * 作者要手改那些檔案時，工程頁給不了入口。
 *
 * 三條約束：
 * 1. **懶載入，一次只列一層**：工程可能有幾百章外加一堆會話 JSON，
 *    整棵樹全量推送會讓每次重新整理都遍歷全盤。展開哪個目錄就只列那個目錄。
 * 2. **路徑不越界**：複用 `fileEditing.ts` 的 `resolveInRoot`，
 *    工程根之外一律拒絕（前端傳來的路徑不可信）。
 * 3. **不靜默截斷**：目錄條目過多時截斷，但把真實總數放在 `truncated` 裡
 *    交給前端顯示，並打一條 warn。
 */

/** 單個目錄一次最多返回多少條。超過就截斷，但會如實告知總數。 */
export const MAX_DIR_ENTRIES = 2000;

/**
 * 不列出的目錄名。只有兩個：
 * `node_modules` 是噪音，`.git` 展開是幾萬個物件檔案（而且改它沒有意義）。
 *
 * **`.novelwarden` 與其他點開頭的目錄刻意不在這裡**——它們正是這個頁面存在的理由。
 */
export const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** 資源管理器裡的一個條目。目錄與檔案共用一種形狀，靠 `kind` 區分。 */
export interface FsEntry {
  kind: 'dir' | 'file';
  /** 檔名（不含路徑）。 */
  name: string;
  /** 工程內相對路徑（正斜槓）。同時是前端的行 key 與摺疊狀態 key。 */
  relPath: string;
  /**
   * 能在內建編輯器裡開啟。false 的檔案（圖片、壓縮包等）前端置灰，
   * 點選回落到系統預設程式，不去撞一個必然失敗的 `openEditor`。
   * 目錄恆為 false。
   */
  editable: boolean;
  /** 檔案大小（位元組）。目錄為 0。 */
  bytes: number;
  /** 最後修改時間（毫秒時間戳）。讀不到時為 0。 */
  modified: number;
}

/** 一個目錄的列舉結果。`relPath` 為空串表示工程根。 */
export interface DirListing {
  /** 被列舉的目錄，工程內相對路徑；空串是工程根。 */
  relPath: string;
  entries: FsEntry[];
  /**
   * 條目總數超過 `MAX_DIR_ENTRIES` 時的真實總數；未截斷則為 0。
   * 前端據此顯示「另有 N 項未列出」——不靜默截斷。
   */
  truncated: number;
  /** 讀取失敗時的原因（目錄不存在、越界、無許可權）。有值時 `entries` 為空。 */
  error?: string;
}

/**
 * 列舉一個目錄的直接子項（不遞迴）。
 *
 * 失敗不拋：越界 / 不存在 / 讀不動都變成帶 `error` 的空結果。資源管理器
 * 是個常駐側欄，作者在別處刪掉一個展開著的目錄時，整頁不該跟著炸。
 */
export async function listDir(root: string, relPath: string): Promise<DirListing> {
  const rel = normalizeDirRel(relPath);

  let abs: string;
  if (rel === '') {
    abs = path.resolve(root);
  } else {
    try {
      abs = resolveInRoot(root, rel);
    } catch (err) {
      return { relPath: rel, entries: [], truncated: 0, error: describe(err) };
    }
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return { relPath: rel, entries: [], truncated: 0, error: describe(err) };
  }

  const kept = dirents.filter((d) => !(d.isDirectory() && HIDDEN_DIR_NAMES.has(d.name)));
  const truncated = kept.length > MAX_DIR_ENTRIES ? kept.length : 0;
  if (truncated) {
    log.warn(
      `目錄條目過多，只列出前 ${MAX_DIR_ENTRIES} 項：${rel || '（工程根）'}`,
      `實際 ${truncated} 項，其餘未推給前端。`
    );
  }

  const entries: FsEntry[] = [];
  for (const dirent of kept.slice(0, MAX_DIR_ENTRIES)) {
    const childAbs = path.join(abs, dirent.name);
    const childRel = toRelPosix(root, childAbs);
    // symlink 的 isDirectory() 為假；stat 一次才知道它指向什麼。
    // 順帶拿到大小與 mtime，省一輪系統呼叫。
    let isDir = dirent.isDirectory();
    let bytes = 0;
    let modified = 0;
    try {
      const stat = await fs.stat(childAbs);
      isDir = stat.isDirectory();
      bytes = stat.isFile() ? stat.size : 0;
      modified = stat.mtimeMs;
    } catch {
      // 斷掉的 symlink、剛被刪掉的檔案：按 dirent 的判斷走，大小留 0。
      // 仍然列出來——樹上看得見才知道它壞了。
      if (!isDir && !dirent.isFile()) {
        continue; // 管道 / socket 之類，不是作者會編輯的東西
      }
    }
    entries.push({
      kind: isDir ? 'dir' : 'file',
      name: dirent.name,
      relPath: childRel,
      editable: isDir ? false : isEditablePath(childRel),
      bytes,
      modified,
    });
  }

  entries.sort(compareEntries);
  log.debug(`列出 ${rel || '（工程根）'}`, `${entries.length} 項`);
  return { relPath: rel, entries, truncated };
}

/**
 * 一次列舉多個目錄（前端展開著的那些）。
 *
 * 併發跑：展開十幾層時逐個 await 會把一次重新整理拖成十幾輪盤 I/O。
 * 單個目錄失敗已經在 `listDir` 裡降級成帶 error 的結果，這裡不會被帶崩。
 */
export async function listDirs(root: string, relPaths: readonly string[]): Promise<DirListing[]> {
  const unique = [...new Set(relPaths.map(normalizeDirRel))];
  return Promise.all(unique.map((rel) => listDir(root, rel)));
}

/**
 * 目錄相對路徑的規範形狀：正斜槓、無首尾斜槓、`.` 與空串都表示工程根。
 *
 * 前端的摺疊狀態是按這個字串記的，規範化必須只在這一處做——
 * 後端回的 `relPath` 與前端請求的對不上，那一行就會永遠轉著圈。
 */
export function normalizeDirRel(relPath: string): string {
  const trimmed = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return trimmed === '.' ? '' : trimmed;
}

/** 目錄在前、檔案在後，各自按名稱排（與 VS Code 的資源管理器一致）。 */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === 'dir' ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // ENOENT / EACCES 這類裸錯誤碼對作者沒意義，翻成人話。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return '目錄不存在（可能剛被刪除或改名）';
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return '沒有讀取這個目錄的許可權';
    }
    if (code === 'ENOTDIR') {
      return '不是目錄';
    }
    return err.message;
  }
  return String(err);
}
