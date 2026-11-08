import * as path from 'node:path';
import { NON_CHAPTER_EXTENSIONS } from './model/chapterFile';
import { LEGACY_NOVEL_DIRS, NOVEL_DIR } from './model/project';
import { NovelConfig } from './model/types';

/**
 * 「工程裡哪些改動值得重新整理介面」——**策略**在這裡，**機制**在殼裡。
 *
 * 兩個殼的監聽機制天差地別（外掛用 VS Code 的 FileSystemWatcher 吃 glob，
 * 獨立版用 `fs.watch` 吃事件流），但要看的是同一批東西：章節根、草稿目錄、
 * 後設資料目錄（`.novelwarden/`，舊工程是 `.novelforge/` / `.novel/`）。這份知識屬於 core——
 * 章節能是什麼副檔名、草稿在哪、哪些目錄算後設資料，都是 core 定義的規則，殼照抄一遍就會跟著規則變化一起腐爛。
 */

/** 後設資料目錄名，從新到舊。舊工程沒遷移時資料在舊目錄裡，三處都要看。 */
const METADATA_DIRS = [NOVEL_DIR, ...LEGACY_NOVEL_DIRS];

/**
 * 給吃 glob 的宿主用的模式清單（相對工程根）。
 *
 * 三處不顯然的地方：
 * - `${chaptersDir}/**` 是**全量**的，不是 `**\/*.md`：目錄本身的增刪要看得見
 *   （工程頁上資料夾是可見節點，新建空資料夾不動任何 .md），順帶也覆蓋了非 .md
 *   的章節（.txt / 無副檔名 / .json），所以章節副檔名放寬不需要在這裡加模式。
 * - 草稿目錄也要監聽：手工建的草稿也該讓工程頁上的「有草稿」標記翻過來。
 * - `<後設資料目錄>/characters/**` 與 `lore/**`（舊工程同理，三處後設資料目錄都出）用全量而不是 `*.md`：
 *   那兩個區允許子目錄收納。
 */
export function watchGlobs(config: NovelConfig): string[] {
  return [
    `${config.chaptersDir}/**/*.md`,
    ...METADATA_DIRS.flatMap((dir) => [
      `${dir}/**/*.md`,
      `${dir}/project.json`,
      `${dir}/characters/**`,
      `${dir}/lore/**`,
    ]),
    `${config.chaptersDir}/**`,
    `${config.draftsDir}/**`,
  ];
}

/** 後設資料目錄的哪個子目錄（相對、絕對路徑都認）。新舊目錄名都算。 */
function metadataSubdirRe(sub: string): RegExp {
  return new RegExp(`(^|/)\\.(?:novelwarden|novelforge|novel)/${sub}(/|$)`);
}

/** `.novelwarden/history`（舊工程 `.novelforge/history` 等）本身或它下面的任何東西。 */
const HISTORY_RE = metadataSubdirRe('history');
/** 存檔點目錄同上。 */
const CHECKPOINTS_RE = metadataSubdirRe('checkpoints');

/**
 * 給吃事件流的宿主用的過濾：這條變更該不該忽略。
 *
 * 用**黑名單**而不是白名單：章節可以是 `.txt`、可以沒有副檔名，目錄事件也沒有
 * 副檔名——白名單式過濾會讓這些改動看不見。放行面因此偏寬，呼叫方要自己去抖
 * （一次 onChange 會觸發全量重掃）。
 *
 * @param name 事件帶回來的路徑或檔名（相對、絕對都行；`fs.watch` 給的是相對）
 */
export function shouldIgnoreChange(name: string): boolean {
  if (!name) {
    return false;
  }
  // 依賴目錄與回收站裡的動靜與工程內容無關。回收站尤其要擋：刪除是「搬進
  // .trash/」，不擋的話每次刪除都會多觸發一輪重掃。
  if (name.includes('node_modules') || name.includes('.trash')) {
    return true;
  }
  // 歷史版本同理：閘道器每覆蓋一份產物就先往 `<後設資料目錄>/history/` 存一版（workspace/history.ts），
  // 不擋的話每存一個快照就多一輪全量重掃。外掛殼那邊快照是 `.txt`，`watchGlobs` 本來就掃不到。
  // 存檔點（workspace/checkpoints.ts）一次存幾十上百個物件，更要擋。
  const posix = name.replace(/\\/g, '/');
  if (HISTORY_RE.test(posix) || CHECKPOINTS_RE.test(posix)) {
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  return ext !== '' && NON_CHAPTER_EXTENSIONS.has(ext);
}
