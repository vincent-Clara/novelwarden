/**
 * 工程內的 SQLite 庫（`.novelwarden/novelwarden.db`）。
 *
 * **Markdown 仍然是內容的唯一真相**。庫裡只放兩類東西：
 * - `errors` —— 失敗記錄，驅動工程頁上的紅色感嘆號（見 [errorLog.ts](errorLog.ts)）；
 * - `logs` —— 日誌的持久副本，讓日誌頁能跨會話回看。
 *
 * 兩者都是「可丟棄的痕跡」：把 db 檔案刪掉，全部功能照常，只是丟歷史。
 * 別往這裡放角色卡/摘要/設定的正文——那些作者要手改、要 diff、要進 Git。
 * 改名前的 `novelforge.db` 留在原地不動（它只是痕跡，不遷移、不刪除）。
 *
 * ## 兩個殼要兩個驅動
 *
 * 這不是可選項，是實測結論：
 *
 * | 執行時 | `node:sqlite` | `bun:sqlite` |
 * |---|---|---|
 * | Node 22（跑 smoke） | ✓ | ✗ |
 * | VS Code / Electron（Node 24） | ✓ | ✗ |
 * | Bun（獨立版） | ✗ 沒有這個內建模組 | ✓ |
 *
 * 而 esbuild 解析不了 `bun:sqlite`（會直接構建失敗），`bun build --compile`
 * 又能把 `node:sqlite` 打進去、跑起來才炸。所以模組名**拼接**出來再
 * `await import`：拼接讓 esbuild 的靜態分析看不見它，於是兩條構建路徑
 * 都不必配 external，執行時按誰能 import 成功來選。
 *
 * ## 語句必須顯式 finalize（Windows 上不 finalize 就刪不掉庫檔案）
 *
 * 兩個驅動的另一處差異，比建構函式名要緊得多：`bun:sqlite` 的語句物件
 * 持有底層控制代碼，**不 finalize 就 `close()` 的話，Windows 上庫檔案仍被佔著**
 * （`fs.rmSync` 報 EBUSY，臨時工程清理不掉）；`node:sqlite` 的語句壓根沒有
 * `finalize` 方法，靠 GC。
 *
 * 所以對外只暴露 {@link SqlDatabase} 的 run/all/insertMany——它們內部
 * 「準備 → 執行 → 立刻 finalize」，呼叫方碰不到語句物件，也就不可能忘。
 *
 * ## 絕不因為庫壞了而帶崩正事
 *
 * 「容錯優先」在這裡的落法：{@link openDatabase} 把所有異常吞掉並只 warn
 * 一次，返回 `undefined`。庫鎖了、盤滿了、驅動缺了，角色卡該更新照樣更新，
 * 只是這次的失敗記錄留不下來。SQLite 是增強，不是新的失敗源——一旦這條
 * 破了，「更新角色卡」就會因為一個日誌表而失敗，那比沒有感嘆號糟得多。
 */

import * as path from 'node:path';
import { addLogSink, LogEntry, LogLevel, recentLogs, scoped, Unsubscribe } from './logger';
import { exists } from '../model/fs';
import { NovelProject } from '../model/project';

const log = scoped('資料庫');

/** 庫檔名。放在後設資料目錄（`.novelwarden/`，舊工程是 `.novelforge/`）下，與 summaries/ characters/ 平級。 */
const DB_FILE = 'novelwarden.db';

/** 日誌保留天數。超期的行在開庫時刪掉，庫不會無限長。 */
const LOG_RETENTION_DAYS = 30;

/** 日誌攢批寫入的間隔。長任務每秒好幾條，逐條一次事務會拖慢正事。 */
const LOG_FLUSH_MS = 200;

/** 能進 SQLite 的值。刻意不收 undefined——那多半是拼引數時漏了一個。 */
export type SqlValue = string | number | null;

// ---------------------------------------------------------------- 驅動適配

/** 兩個驅動的語句物件的公共子集。`finalize` 只有 bun 有。 */
interface RawStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  finalize?(): void;
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

interface BunSqliteModule {
  Database: new (filename: string) => RawDatabase;
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => RawDatabase;
}

/**
 * 對外的庫介面。**沒有 prepare**——語句的生命週期全在這一層裡管掉，
 * 見檔案頭「語句必須顯式 finalize」。
 */
export interface SqlDatabase {
  exec(sql: string): void;
  /** 跑一條寫語句。 */
  run(sql: string, ...params: SqlValue[]): void;
  /** 查一批行。 */
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** 同一條語句跑很多行，一次事務。日誌攢批寫入用它。 */
  insertMany(sql: string, rows: SqlValue[][]): void;
  close(): void;
}

/**
 * 按執行時挑一個驅動開庫。
 *
 * 順序是 bun 優先：獨立版跑在 Bun 裡，那兒 `node:sqlite` 根本不存在；
 * 外掛與 smoke 跑在 Node/Electron 裡，`bun:sqlite` import 會拋，落到第二條。
 *
 * **模組名必須是拼接出來的**（`'bun' + ':sqlite'`）。寫成字面量的話
 * esbuild 會在打包 `dist/extension.js` 時試圖解析 `bun:sqlite` 並直接
 * 構建失敗——那個模組在 Node 側不存在，也沒法 external 掉（external 之後
 * 外掛執行時會 require 一個不存在的模組）。
 */
async function openWithAnyDriver(filename: string): Promise<RawDatabase> {
  const bunSpec = 'bun' + ':sqlite';
  try {
    const mod = (await import(bunSpec)) as unknown as BunSqliteModule;
    return new mod.Database(filename);
  } catch {
    const nodeSpec = 'node' + ':sqlite';
    const mod = (await import(nodeSpec)) as unknown as NodeSqliteModule;
    return new mod.DatabaseSync(filename);
  }
}

/** 把裸驅動包成 {@link SqlDatabase}：語句一律用完即 finalize。 */
function wrap(raw: RawDatabase): SqlDatabase {
  /** 準備 → 用 → 收。`finalize` 只有 bun 有，node 側是個空操作。 */
  const withStatement = <T>(sql: string, use: (stmt: RawStatement) => T): T => {
    const stmt = raw.prepare(sql);
    try {
      return use(stmt);
    } finally {
      try {
        stmt.finalize?.();
      } catch {
        /* 收不掉也不能讓呼叫方看見——查詢本身已經成了 */
      }
    }
  };

  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => withStatement(sql, (s) => void s.run(...params)),
    all: <T>(sql: string, ...params: SqlValue[]) =>
      withStatement(sql, (s) => s.all(...params) as T[]),
    insertMany: (sql, rows) => {
      if (rows.length === 0) {
        return;
      }
      withStatement(sql, (stmt) => {
        raw.exec('BEGIN');
        try {
          for (const row of rows) {
            stmt.run(...row);
          }
          raw.exec('COMMIT');
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* 回滾失敗時原始異常更有價值，別用它蓋掉 */
          }
          throw err;
        }
      });
    },
    close: () => raw.close(),
  };
}

// ---------------------------------------------------------------- 開啟

/** 已開啟的連線，按工程根快取。一個工程一個連線，別每次查詢都開一次。 */
const connections = new Map<string, SqlDatabase>();
/**
 * 開庫失敗過的工程根。
 *
 * 記住它才不會每查一次錯誤記錄就重試一次開庫——那會在盤滿/無寫許可權時
 * 把日誌刷滿，而結論每次都一樣。
 */
const failedRoots = new Set<string>();

/**
 * 拿這個工程的庫連線；拿不到返回 `undefined`（呼叫方一律當「沒有庫」處理）。
 *
 * 首次呼叫時建表、設 PRAGMA、清理過期日誌。
 *
 * `opts.create` 為 false 時**庫檔案不存在就直接返回 undefined，不建庫**。
 * 純讀取的呼叫方（`listActiveFailures`，工程頁每次重新整理都走）必須用這一檔：
 * 否則光是開啟工程頁就會在作者的 `.novelwarden/` 裡憑空生出一個 db 檔案，
 * 而那個工程可能從來沒出過錯。寫入方（記失敗、寫日誌）才有理由建庫。
 */
export async function openDatabase(
  project: NovelProject,
  opts: { create?: boolean } = {}
): Promise<SqlDatabase | undefined> {
  const key = project.root;
  const cached = connections.get(key);
  if (cached) {
    return cached;
  }
  if (failedRoots.has(key)) {
    return undefined;
  }

  const file = path.join(project.novelDir, DB_FILE);
  if (opts.create === false && !(await exists(file))) {
    // 刻意不記進 failedRoots：這不是失敗，只是「還沒有庫」。
    // 之後某次寫入把庫建出來，讀取方下一次就該看得見。
    return undefined;
  }

  try {
    const db = wrap(await openWithAnyDriver(file));
    // WAL：寫日誌時不阻塞工程頁讀錯誤記錄。
    // busy_timeout：外掛與獨立版同開一個工程時，撞鎖先等一會兒而不是直接報錯。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(SCHEMA);
    pruneOldLogs(db);
    connections.set(key, db);
    log.debug('已開啟工程資料庫', `${project.relPath(project.novelDir)}/${DB_FILE}`);
    return db;
  } catch (err) {
    failedRoots.add(key);
    // 只 warn 不 error：這不影響任何功能，只是這個工程沒有失敗記錄與日誌歷史。
    log.warn(
      '打不開工程資料庫，本次會話不記錄失敗歷史',
      `${(err as Error)?.message ?? String(err)}｜功能不受影響，只是工程頁上不會顯示錯誤標記`
    );
    return undefined;
  }
}

/**
 * 關掉某個工程的連線（殼銷燬時調）。
 *
 * 順帶 flush 掉攢著還沒寫的日誌——不然最後那一兩百毫秒的日誌會丟，
 * 而崩潰前的最後幾條恰恰是最想看的。
 */
export function closeDatabase(project: NovelProject): void {
  flushPendingLogs();
  const db = connections.get(project.root);
  if (!db) {
    return;
  }
  connections.delete(project.root);
  logDbs = logDbs.filter((d) => d !== db);
  try {
    db.close();
  } catch {
    /* 關不掉也沒什麼可做的，程序退出時系統會收 */
  }
}

/** 僅供測試：關掉全部連線、忘掉失敗記憶，讓下一次 openDatabase 重新來。 */
export function resetDatabases(): void {
  flushPendingLogs();
  for (const db of connections.values()) {
    try {
      db.close();
    } catch {
      /* 同上 */
    }
  }
  connections.clear();
  failedRoots.clear();
  logDbs = [];
  logWriteBroken = false;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  target_kind TEXT    NOT NULL,
  target_key  TEXT    NOT NULL,
  severity    TEXT    NOT NULL,
  op          TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  detail      TEXT,
  cleared_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_target ON errors(target_kind, target_key, cleared_at);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- logger 那邊的程式內序號。**不是主鍵**——它每次程式重啟都從 1 開始，
  -- 做主鍵會讓今天的日誌覆蓋昨天的。留著它是因為前端按 seq 去重：
  -- 記憶體緩衝與庫裡那份必然重疊（同一條既進了緩衝也寫了庫）。
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  level   TEXT NOT NULL,
  scope   TEXT NOT NULL,
  message TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
`;

function pruneOldLogs(db: SqlDatabase): void {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString();
  try {
    db.run('DELETE FROM logs WHERE at < ?', cutoff);
  } catch {
    /* 清不掉只是庫大一點，不值得打擾使用者 */
  }
}

// ---------------------------------------------------------------- 日誌持久化

/**
 * 待寫的日誌。
 *
 * 攢批而不是逐條寫：一次摘要同步會打幾百條，每條一次事務足以讓長任務
 * 明顯變慢。200ms 一批，使用者感知不到，寫入次數降兩個數量級。
 */
let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 日誌寫進哪個庫：最近一個掛上來的。獨立版一個程序可能同時開著幾個工程，
 * 日誌是程序級的，寫進其中一份就夠；那個工程關了就落到前一個上。
 */
let logDbs: SqlDatabase[] = [];
/**
 * 寫庫失敗過了。
 *
 * **寫日誌失敗絕不能再打日誌**——那會遞迴刷屏（`logger.ts` 的重入保護只擋
 * 轉發，不擋入緩衝）。所以只在第一次往 stderr 說一句，此後徹底靜默。
 */
let logWriteBroken = false;

/**
 * 把日誌落進庫裡。返回的 dispose 必須在殼銷燬時呼叫。
 *
 * 不寫在 `logger.ts` 裡是有意的：那個模組是 core 裡唯一的零依賴模組
 * （連 host.ts 都不引），而這裡要 import `model/project`，反向 import
 * 會成環。用它現成的 `addLogSink` 從外面掛，是同一件事的乾淨做法。
 *
 * 開庫是非同步的，而 core 的模組在 import 期就已經在打日誌了（配置讀取、
 * 遷移檢測）。所以掛上 sink 之後**先把環形緩衝裡已有的補寫一遍**——
 * 否則「啟動時到底載入了什麼」這段永遠進不了庫，而那正是排查啟動問題
 * 要看的第一段。
 */
export async function installLogPersistence(project: NovelProject): Promise<Unsubscribe> {
  const db = await openDatabase(project);
  if (!db) {
    // 沒有庫就什麼都不做，但仍然給一個可 dispose 的物件——
    // 讓呼叫方不必區分「掛上了」和「沒掛上」。
    return { dispose: () => undefined };
  }
  logDbs.push(db);

  const sink = addLogSink((entry) => {
    if (logWriteBroken) {
      return;
    }
    pendingLogs.push(entry);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingLogs, LOG_FLUSH_MS);
    }
  });

  // 補上掛載之前的那些。sink 已經裝好了，所以這裡塞進同一個緩衝，
  // 由同一次 flush 寫掉；重複的那幾條由 seq 去重（前端與這裡都按 seq 認）。
  const backlog = recentLogs();
  if (backlog.length > 0) {
    pendingLogs.unshift(...backlog);
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingLogs, LOG_FLUSH_MS);
    }
  }

  return {
    dispose: () => {
      sink.dispose();
      flushPendingLogs();
      logDbs = logDbs.filter((d) => d !== db);
    },
  };
}

/** 把攢著的日誌一次事務寫完。庫壞了就丟掉這一批並從此靜默。 */
export function flushPendingLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const batch = pendingLogs;
  pendingLogs = [];
  const logDb = logDbs[logDbs.length - 1];
  if (batch.length === 0 || !logDb || logWriteBroken) {
    return;
  }

  try {
    // 按 seq 去重：補寫啟動前的緩衝時，同一條可能既在 backlog 裡
    // 又被 sink 收到過（`installLogPersistence` 的補寫與實時推送會重疊）。
    const seen = new Set<number>();
    const rows: SqlValue[][] = [];
    for (const e of batch) {
      if (seen.has(e.seq)) {
        continue;
      }
      seen.add(e.seq);
      rows.push([e.seq, e.at, e.level, e.scope, e.message, e.detail ?? null]);
    }
    logDb.insertMany(
      'INSERT INTO logs (seq, at, level, scope, message, detail) VALUES (?, ?, ?, ?, ?, ?)',
      rows
    );
  } catch (err) {
    logWriteBroken = true;
    // 刻意用 console 而不是 log.warn：見 logWriteBroken 的註釋。
    console.error('[novelwarden] 日誌寫入資料庫失敗，已停止持久化：', (err as Error)?.message ?? err);
  }
}

/**
 * 庫裡存著的歷史日誌，按時間正序返回最近的 `limit` 條。
 *
 * 日誌頁預設仍然顯示記憶體緩衝（那是實時的），這條只在使用者點「載入更早」
 * 時才走——預設路徑一次查詢都不做。`before` 給了就只取更早的，供翻頁。
 */
export async function readLogHistory(
  project: NovelProject,
  limit: number,
  before?: string
): Promise<LogEntry[]> {
  // 純讀取，不建庫：沒有庫就是沒有歷史。
  const db = await openDatabase(project, { create: false });
  if (!db) {
    return [];
  }
  try {
    // 先取最近的 N 條（倒序 + LIMIT 才用得上索引），再翻回正序給前端。
    // 排序用 id（庫內自增、跨會話單調）而不是 seq——seq 每次程序重啟都從 1
    // 開始，按它排會把昨天和今天的日誌交錯在一起。
    const rows = before
      ? db.all<LogRow>(
          'SELECT * FROM logs WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?',
          before,
          limit
        )
      : db.all<LogRow>('SELECT * FROM logs ORDER BY at DESC, id DESC LIMIT ?', limit);
    return rows.map(toLogEntry).reverse();
  } catch (err) {
    log.warn('讀取日誌歷史失敗', (err as Error)?.message ?? String(err));
    return [];
  }
}

interface LogRow {
  id: number;
  seq: number;
  at: string;
  level: string;
  scope: string;
  message: string;
  detail: string | null;
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function toLogEntry(row: LogRow): LogEntry {
  return {
    /**
     * **負數**，取庫內自增 id 的相反數。
     *
     * 前端按 seq 去重，而庫裡存的 `seq` 是各次程序的程序內序號——昨天的
     * 第 7 條與本次會話的第 7 條 seq 一樣，直接用它會讓「載入更早」把昨天
     * 那條當成重複的丟掉。取負的庫內 id 則永不與實時序號（從 1 遞增）撞車，
     * 而真正防重複顯示的是查詢裡的 `at < before`（只取比已顯示的更早的）。
     */
    seq: -row.id,
    at: row.at,
    // 庫裡的 level 是自由文字，讀回來時收一次口——手改過庫的人不該讓日誌頁崩。
    level: LEVELS.includes(row.level as LogLevel) ? (row.level as LogLevel) : 'info',
    scope: row.scope,
    message: row.message,
    detail: row.detail ?? undefined,
  };
}
