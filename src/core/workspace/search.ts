/**
 * 全文檢索。**零模型呼叫的樸素全文掃描**，三期的 `search` 工具吃它。
 *
 * ## 為什麼值得單獨一個函式
 *
 * 作者問「主角前面說過他沒去過北境嗎」，現在只能靠手動 `@` 引用幾章原文，
 * 跨章對賬根本做不了。把它做成 AI 功能等於每問一句燒一次錢，而且會給出
 * 看起來很像但沒有依據的答案——與「新鮮度只靠 hash 傳播，不調模型」
 * （AGENTS 第 18 條）是同一條取捨：能用確定性方法算出來的，不花 token。
 *
 * ## 四條實現約束
 *
 * 1. **跳過 `.trash/`、歷史版本、內部檔案與二進位制**：回收站裡躺著剛刪掉的東西，搜出來等於沒刪；`.novelwarden/history/`
 *    是一份份被覆蓋掉的舊稿（同一個理由：搜出來的不是現在的書）；工程庫與會話記錄（`isInternalPath`）不是作品內容；
 *    二進位制讀成 utf8 是一屏亂碼。
 * 2. **單檔案讀入有上限**（複用 `MAX_EDITABLE_BYTES`），超了跳過並計入 `dropped`。
 * 3. **`dropped > 0` 時必須在返回值裡說出來**（第 2 條：不靜默截斷）——
 *    三期的工具會把它轉述給模型，模型不知道自己只看了一半會拿半份證據下結論。
 * 4. **預設按章號排序**，不按檔案系統順序：作者問「他前面說過嗎」，
 *    時間線順序才有意義。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import { decodeFileText } from '../model/importText';
import { NovelProject } from '../model/project';
import { ArtifactKind, kindOfPath, normalizeRel } from './kind';
import { MAX_EDITABLE_BYTES, isInHistory, isInTrash, isInternalPath } from './guard';

const log = scoped('工作區');

/** 遞迴掃描的深度上限。與 project.ts 的 MAX_TREE_DEPTH 同一個數量級。 */
const MAX_DEPTH = 8;

export interface SearchOptions {
  /** 限定目錄，預設全工程。 */
  path?: string;
  /** 限定種類，如 `['chapter','plot']`。 */
  kinds?: ArtifactKind[];
  /** 正則還是字面量。預設字面量（作者搜的是人名地名，不是正則）。 */
  regex?: boolean;
  /** 每個檔案最多返回幾條命中。預設 5。 */
  perFile?: number;
  /** 總共最多返回幾條。預設 50。 */
  limit?: number;
  /** 命中行前後各帶幾行。預設 1。 */
  context?: number;
}

export interface SearchHit {
  rel: string;
  kind: ArtifactKind;
  no?: number;
  /** 行號，從 1 開始。 */
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** 掃了幾個檔案。 */
  scanned: number;
  /** 因為超上限（或檔案太大）被丟掉了幾條。**必須報出來**（第 2 條）。 */
  dropped: number;
  /** 降級說明，如「正則寫壞了，按字面量搜的」。有值時呼叫方要轉述。 */
  note?: string;
}

/**
 * 掃一遍工程找命中行。**絕不拋**：讀不動的檔案跳過，壞正則降級成字面量。
 *
 * 這是常駐介面與 agent 工具共用的取數路徑，一個許可權錯誤不該讓整次檢索失敗。
 */
export async function search(
  project: NovelProject,
  pattern: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const perFile = clampPositive(opts.perFile, 5);
  const limit = clampPositive(opts.limit, 50);
  const context = Math.max(0, Math.trunc(opts.context ?? 1));
  const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;

  if (!pattern) {
    return { hits: [], scanned: 0, dropped: 0 };
  }

  let note: string | undefined;
  let matcher: (line: string) => boolean;
  if (opts.regex) {
    try {
      const re = new RegExp(pattern);
      matcher = (line) => re.test(line);
    } catch {
      // 壞正則不拋：降級成字面量並說出來。作者輸錯一個括號不該什麼都搜不到，
      // 更不該只看到一句「出錯了」。
      note = `正則「${pattern}」寫不通，已按字面量搜尋。`;
      matcher = (line) => line.includes(pattern);
    }
  } else {
    matcher = (line) => line.includes(pattern);
  }

  // 限定目錄：越界給空結果，不拋（這條路徑來自前端與模型）。
  let rootRel = '';
  if (opts.path !== undefined && opts.path.trim() !== '') {
    const normalized = normalizeRel(opts.path);
    if (normalized === undefined) {
      return { hits: [], scanned: 0, dropped: 0, note: `路徑超出工程目錄：${opts.path}` };
    }
    rootRel = normalized;
  }

  const files = await collectFiles(project, rootRel, kinds);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let dropped = 0;

  for (const file of files) {
    const abs = project.pathOf(file.rel);
    let text: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_EDITABLE_BYTES) {
        // 太大就跳過——但**要計進 dropped**，否則作者會以為那一章裡沒有他要找的東西。
        dropped++;
        continue;
      }
      text = decodeFileText(await fs.readFile(abs));
    } catch {
      continue; // 許可權、剛被刪掉：跳過一份檔案不該讓整次檢索失敗
    }
    scanned++;

    const lines = text.split(/\r?\n/);
    let taken = 0;
    for (const [i, line] of lines.entries()) {
      if (!matcher(line)) {
        continue;
      }
      if (taken >= perFile) {
        dropped++;
        continue;
      }
      taken++;
      hits.push({
        rel: file.rel,
        kind: file.kind,
        no: file.no,
        line: i + 1,
        text: line,
        before: context > 0 ? lines.slice(Math.max(0, i - context), i) : undefined,
        after: context > 0 ? lines.slice(i + 1, i + 1 + context) : undefined,
      });
    }
  }

  // 按章號升序，無章號的排在最後（大綱、文風、角色卡都沒有章號）。
  // 同章內按路徑再按行號，輸出穩定。
  hits.sort(
    (a, b) =>
      (a.no ?? Number.MAX_SAFE_INTEGER) - (b.no ?? Number.MAX_SAFE_INTEGER) ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line
  );

  if (hits.length > limit) {
    dropped += hits.length - limit;
    hits.length = limit;
  }

  if (dropped > 0) {
    log.debug(`檢索「${pattern}」丟了 ${dropped} 條`, `掃了 ${scanned} 個檔案，返回 ${hits.length} 條`);
  }
  return { hits, scanned, dropped, note };
}

interface Candidate {
  rel: string;
  kind: ArtifactKind;
  no?: number;
}

/**
 * 收集要掃的檔案。
 *
 * 兩條過濾在這裡做，因為它們都只看路徑、不必讀盤：
 * **回收站裡的一律跳過**（搜出來等於沒刪），**二進位制一律跳過**
 * （`other` 且副檔名在黑名單裡）。
 */
async function collectFiles(
  project: NovelProject,
  rootRel: string,
  kinds: Set<ArtifactKind> | undefined
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const rootAbs = rootRel === '' ? project.root : project.pathOf(rootRel);

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (
        isInTrash(project, childRel) ||
        isInHistory(project, childRel) ||
        isInternalPath(project, childRel) ||
        entry.name === 'node_modules' ||
        entry.name === '.git'
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const k = kindOfPath(project, childRel);
      // 情節大綱沒有檔案（各章細綱梗概的彙總，搜細綱就搜到了）：老工程磁碟上殘留的那一份 `outline.md` 不是現在的書。
      if ((kinds && !kinds.has(k.kind)) || k.kind === 'outline') {
        continue;
      }
      // 認不出種類的檔案裡，只有可能是文字的才讀——圖片、壓縮包、可執行
      // 讀成 utf8 是一屏亂碼，還會白白佔掉 limit。
      if (k.kind === 'other' && !looksTextual(entry.name)) {
        continue;
      }
      out.push({ rel: childRel, kind: k.kind, no: k.no });
    }
  };

  await walk(rootAbs, rootRel, 1);
  return out;
}

/**
 * 這個檔名看著像純文字嗎。
 *
 * 複用章節那條判據（數字字首 + 副檔名不在二進位制黑名單）不合適——它要求數字
 * 字首，而工程根下的 `README.md` 沒有。這裡只看副檔名：黑名單之外、且有副檔名
 * 的當文字；無副檔名的一律跳過（`.gitignore` 之類不是作者要搜的東西）。
 */
function looksTextual(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return false;
  }
  return !NON_TEXT_EXTENSIONS.has(ext);
}

/** 二進位制黑名單。與 `model/chapterFile.ts` 的 `NON_CHAPTER_EXTENSIONS` 同源。 */
const NON_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.tif', '.tiff', '.avif', '.heic',
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz',
  '.docx', '.doc', '.pdf', '.odt', '.epub', '.mobi', '.azw3',
  '.xls', '.xlsx', '.ppt', '.pptx',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.apk',
  '.jar', '.class', '.wasm', '.pyc',
  '.db', '.sqlite', '.sqlite3',
]);

function clampPositive(value: number | undefined, def: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return def;
  }
  return Math.trunc(value);
}
