/**
 * 失敗記錄：讓「剛才那張卡沒更新成功」這件事在介面上看得見。
 *
 * ## 為什麼需要它
 *
 * 此前所有失敗都只有兩條出口：一條 `log.error`，和一條五秒就消失的 toast。
 * 兩者都要求使用者**恰好在看**。於是出現了這個 bug：角色卡的批次全部解析失敗、
 * 卡一字未改（這個行為本身是對的），但工程頁上那張卡跟成功的一模一樣——
 * 作者以為更新過了，此後一直拿著一張舊卡續寫。
 *
 * 更隱蔽的是「部分失敗」：三批裡有一批掛了，成果照寫，但「已讀到」水位線
 * 停在失敗之前，下次增量會重來。這件事以前只有一條 `log.warn`，介面上
 * 完全無痕。
 *
 * 所以失敗要**留在目標身上**，而不是留在時間線上：工程頁那一行上掛個感嘆號，
 * 一直掛到它成功為止。
 *
 * ## 三條約定
 *
 * 1. **寫失敗記錄本身絕不會失敗**：全部 API 內部吞掉異常。庫打不開時
 *    整套機制靜默退化成「只有日誌」，一個功能都不受影響。
 * 2. **成功必須清記錄**（{@link clearFailures}）。修好了還掛著感嘆號，
 *    比一開始不報錯更糟——使用者會學會無視它。
 * 3. **`targetKey` 用 relPath 而不是名字**：名字會被作者改，路徑才是當下的
 *    身份，而且前端的樹本來就按 relPath 索引，能直接對上。代價是改名/移動
 *    之後舊記錄對不上而不再顯示；這可接受（重跑一次就有新記錄），不為它
 *    去給 `fileOps.ts` 加聯動。
 */

import { openDatabase } from './db';
import { NovelProject } from '../model/project';
import { FailureView } from '../protocol';

/**
 * 失敗掛在什麼東西上。與工程頁的分割槽一一對應。
 *
 * `plot` 是創作流水線那一區（細綱）；`chapter` 是釋出章節（定稿失敗掛這裡）。庫裡可能還躺著
 * 換軸之前記下的行——它們指向 `chapters/` 下的路徑，讀出來只是掛不到任何
 * 一行上，不該因此讓整張表讀不出來。
 */
export type FailureTargetKind = 'character' | 'plot' | 'chapter' | 'lore' | 'setting' | 'threads';

/**
 * - `error`：這次動作整體沒成，目標**一字未改**。
 * - `warn`：部分成了（成果已寫回），但有一塊沒成，下次會重來。
 */
export type FailureSeverity = 'error' | 'warn';

export interface FailureRecord {
  /** 日誌來源名，與 `scoped()` 用的那個一致（「角色卡」「定稿」「設定」）。 */
  scope: string;
  targetKind: FailureTargetKind;
  /** 目標的工作區相對路徑。 */
  targetKey: string;
  severity: FailureSeverity;
  /** 哪個動作失敗了，如 `updateCard` / `summarize`。清記錄時按它篩。 */
  op: string;
  /** 一句人話，直接顯示在浮窗的標題行。 */
  message: string;
  /** 多行補充：失敗的批次/章節、水位線停在哪、建議怎麼辦。 */
  detail?: string;
}

/**
 * 一個目標最多顯示幾條。
 *
 * 浮窗裡攤開五條以上就沒人看了，而最近的那條才是當下的狀態。
 * 在查詢處限制，不在寫入處刪——歷史留著，日誌頁將來要按目標翻。
 */
const MAX_PER_TARGET = 3;

/**
 * 記一條失敗。
 *
 * 呼叫方**不必** try/catch：庫不可用、盤滿、表被手刪，都只是這條記錄沒留下，
 * 絕不往上拋。失敗路徑上再拋一個異常，會把「更新失敗」變成「更新崩潰」。
 */
export async function recordFailure(project: NovelProject, record: FailureRecord): Promise<void> {
  const db = await openDatabase(project);
  if (!db) {
    return;
  }
  try {
    // 同一個目標 + 同一個動作只保留最新一條未清除的：連著重試三次失敗，
    // 使用者要看的是「現在還錯著」，不是三條一模一樣的記錄。
    db.run(
      "UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND op = ? AND cleared_at IS NULL",
      new Date().toISOString(),
      record.targetKind,
      record.targetKey,
      record.op
    );
    db.run(
      'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message, detail)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      record.scope,
      record.targetKind,
      record.targetKey,
      record.severity,
      record.op,
      record.message,
      record.detail ?? null
    );
  } catch {
    /* 見函式註釋：記不下來也不能影響正事 */
  }
}

/**
 * 目標成功了，把它掛著的失敗記錄清掉。
 *
 * `op` 給了就只清那個動作的——「定稿成功了」不該順手把「角色卡失敗了」
 * 一起抹掉。不給則清該目標的全部。
 */
export async function clearFailures(
  project: NovelProject,
  targetKind: FailureTargetKind,
  targetKey: string,
  op?: string
): Promise<void> {
  // 沒有庫就沒有要清的記錄——別為了「清空」把庫建出來。
  // 成功路徑每章/每卡都會走一次，這是最熱的呼叫點。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return;
  }
  try {
    const now = new Date().toISOString();
    if (op) {
      db.run(
        'UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND op = ? AND cleared_at IS NULL',
        now,
        targetKind,
        targetKey,
        op
      );
    } else {
      db.run(
        'UPDATE errors SET cleared_at = ? WHERE target_kind = ? AND target_key = ? AND cleared_at IS NULL',
        now,
        targetKind,
        targetKey
      );
    }
  } catch {
    /* 同上 */
  }
}

/**
 * 某個目標上某個動作還掛著的那一條（最新的）。沒有、或庫打不開時返回 undefined。
 *
 * 只有一處要它：定稿時作者改過的角色狀態沒被覆蓋，黃 ❗ 的說明裡帶著機器給出的那一版，
 * 「對比…」入口從這裡把它取回來（features/characterState.ts）。那一版是可以重新生成的
 * 痕跡，放在庫裡符合第 17 條；庫沒了只是這個入口說「沒有待對比的」，卡本身不受影響。
 */
export async function activeFailure(
  project: NovelProject,
  targetKind: FailureTargetKind,
  targetKey: string,
  op: string
): Promise<FailureView | undefined> {
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return undefined;
  }
  try {
    const row = db.all<{ at: string; severity: string; message: string; detail: string | null }>(
      'SELECT at, severity, message, detail FROM errors' +
        ' WHERE target_kind = ? AND target_key = ? AND op = ? AND cleared_at IS NULL ORDER BY id DESC LIMIT 1',
      targetKind,
      targetKey,
      op
    )[0];
    return row
      ? {
          at: row.at,
          severity: row.severity === 'warn' ? 'warn' : 'error',
          message: row.message,
          detail: row.detail ?? undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 全部未清除的失敗記錄，按 `targetKey` 聚合，每個目標最多 {@link MAX_PER_TARGET} 條（新的在前）。
 *
 * **一次查詢拿全部**，不要按目標逐個查：工程頁每次重新整理都要為幾十張卡、
 * 幾百章各查一次的話，一次 `pushState` 就是幾百條 SQL。
 */
export async function listActiveFailures(
  project: NovelProject
): Promise<Record<string, FailureView[]>> {
  // 純讀取：庫還不存在就別建。工程頁每次重新整理都走這裡，為一個從沒出過錯的
  // 工程憑空生出一個 db 檔案是不該有的副作用。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return {};
  }
  try {
    const rows = db.all<{
      at: string;
      target_key: string;
      severity: string;
      op: string | null;
      message: string;
      detail: string | null;
    }>(
      'SELECT at, target_key, severity, op, message, detail FROM errors' +
        ' WHERE cleared_at IS NULL ORDER BY id DESC'
    );

    const out: Record<string, FailureView[]> = {};
    for (const row of rows) {
      const list = (out[row.target_key] ??= []);
      if (list.length >= MAX_PER_TARGET) {
        continue;
      }
      list.push({
        at: row.at,
        // 庫是檔案，作者可能拿別的工具改過；認不出的一律當 error（寧可多提醒）。
        severity: row.severity === 'warn' ? 'warn' : 'error',
        message: row.message,
        detail: row.detail ?? undefined,
        ...(row.op ? { op: row.op } : {}),
      });
    }
    return out;
  } catch {
    // 讀不出來就當沒有失敗記錄——工程頁照常顯示，只是沒有感嘆號。
    return {};
  }
}
