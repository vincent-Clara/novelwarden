import * as path from 'node:path';

/**
 * 「什麼檔案算章節」的唯一定義。
 *
 * 純函式、無 I/O，因此掃描器（model/project.ts）、內建編輯器的可編輯判定
 * （core/files/fileEditing.ts）、獨立版的檔案監聽（standalone/fileHost.ts）
 * 三處共用同一份規則，不會各寫一遍再慢慢跑偏。
 *
 * 規則：**數字字首 + 副檔名不在二進位制黑名單裡 + 標題不是筆記**。
 *
 * 用黑名單而不是白名單，是因為正文的花樣擋不完——作者可能從別處匯入
 * `.txt`，可能存成無副檔名，也可能用 `.json` 存一份結構化稿。這些都該是
 * 章節。反過來「開啟必然是亂碼」的那批（圖片、音影片、壓縮包、Office
 * 文件、可執行檔案）是可列舉的，把它們擋在外面就夠了——否則往 chapters/
 * 裡丟一張 `001-封面.png` 就會憑空多出「第 1 章」，還會被 utf8 讀成亂碼
 * 塞進 LLM 上下文。
 *
 * 筆記同理：作者順手在卷目錄裡放 `047 细纲.txt`、`048 作话.txt`，那是作者視角的文字，
 * 當成正文會被提取角色讀成「反派」「主角」兩個人，同號時還會頂掉真正的第 47 章
 * （空格排在 `-` 前面，流水線認路徑排序第一份）。
 */

/** 不當作章節正文的副檔名。小寫、含點。 */
export const NON_CHAPTER_EXTENSIONS: ReadonlySet<string> = new Set([
  // 圖片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.tif', '.tiff', '.avif', '.heic',
  // 音影片
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv',
  // 壓縮包
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz',
  // 富文件容器（.rtf 刻意不列：它是 ASCII 標記，編輯器打得開）
  '.docx', '.doc', '.pdf', '.odt', '.epub', '.mobi', '.azw3',
  '.xls', '.xlsx', '.ppt', '.pptx',
  // 字型
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 可執行 / 二進位制
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.apk',
  '.jar', '.class', '.wasm', '.pyc',
  // 資料庫
  '.db', '.sqlite', '.sqlite3',
]);

/**
 * 筆記的標題：去掉序號後**整個**標題就是這幾個詞之一（可以再帶個編號，`細綱2`）。
 * 不按字首、字尾認——「設定崩塌」「草稿紙上的名字」「大綱之外」都是真章節。
 */
const NOTE_STEM = /^((?:细|細)(?:纲|綱)|大(?:纲|綱)|提(?:纲|綱)|作(?:话|話)|(?:笔|筆)(?:记|記)|(?:备|備)忘|(?:设|設)定|草稿|(?:备|備)份|(?:灵|靈)感|notes?|outline)\d*$/i;

/** markdown 家族。只有這一族才解析 `# 標題`。 */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown']);

export interface ChapterFileName {
  order: number;
  /** 去掉序號字首與副檔名後的詞幹，可能為空（如 `003.md`）。 */
  stem: string;
  /** 小寫副檔名，含點；無副檔名為 ''。 */
  ext: string;
}

/**
 * 檔名 → 章節資訊。無數字字首、副檔名在黑名單裡、或標題是筆記（`047 细纲.txt`），返回 undefined。
 *
 * 必須**先剝副檔名再匹配序號字首**：字首分隔符裡含 `.`，直接對整個檔名
 * 跑正則的話，`003.md` 會被吃成「序號 003 + 詞幹 md」。
 *
 * 邊角：`001.楔子` 會被 path.extname 認成副檔名 `.楔子`——它不在黑名單裡，
 * 於是解析為第 1 章、詞幹為空、標題回落「第 1 章」。夠合理，不額外處理。
 */
export function parseChapterFileName(fileName: string): ChapterFileName | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext && NON_CHAPTER_EXTENSIONS.has(ext)) {
    return undefined;
  }
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const m = /^(\d{1,5})[-_.\s]*(.*)$/.exec(base);
  if (!m || NOTE_STEM.test(m[2].trim())) {
    return undefined;
  }
  return { order: Number(m[1]), stem: m[2], ext };
}

export function isChapterFileName(fileName: string): boolean {
  return parseChapterFileName(fileName) !== undefined;
}

export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}

export function isMarkdownPath(relPath: string): boolean {
  return isMarkdownExt(path.extname(relPath));
}
