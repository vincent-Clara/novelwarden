import { traditionalLabel } from '../model/labels';
/**
 * 執行日誌。
 *
 * 一個程序內的環形緩衝 + 若干 sink：
 *
 * - **緩衝**永遠收全量（含 debug），上限 {@link MAX_ENTRIES} 條，供網頁的
 *   「日誌」頁在任何時刻回看——使用者看到介面卡住時才想起來看日誌，那時
 *   事情已經發生過了，沒有緩衝就什麼也查不到。
 * - **sink** 是殼註冊的轉發口（VS Code 的輸出面板、獨立版的終端、
 *   webview 推送），各自按 {@link setSinkLevel} 過濾。
 *
 * 三條約束：
 *
 * 1. **絕不記錄金鑰**：所有文字過一遍 {@link redact}。日誌會被使用者複製
 *    進 issue，API Key 不能跟著走。
 * 2. **絕不因日誌拋錯**：sink 拋異常只是被吞掉，日誌壞了不能帶崩正事。
 * 3. **絕不記錄 prompt 全文**：只記條數與字數。一次續寫的 prompt 有十萬字，
 *    進了緩衝會把此前所有日誌擠沒。
 *
 * core 層不依賴外部套件或 host.ts（僅引用純標籤表），任何模組都可以直接 `scoped()` 取一個記錄器。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  /** 單調遞增序號。前端據此去重（推送與全量重放會重疊）。 */
  seq: number;
  /** ISO 時間戳。 */
  at: string;
  level: LogLevel;
  /** 來源，如「摘要」「模型」。直接展示給使用者，用中文。 */
  scope: string;
  message: string;
  /** 補充細節（多行、已脫敏、已截斷）。 */
  detail?: string;
}

/** 緩衝上限。一次 76 章的摘要同步約產生 250 條，留足回看餘量。 */
export const MAX_ENTRIES = 800;
/** 單條 detail 的字數上限——日誌是線索，不是資料轉儲。 */
const MAX_DETAIL_CHARS = 2000;

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface LogSink {
  (entry: LogEntry): void;
}

export interface Unsubscribe {
  dispose(): void;
}

const buffer: LogEntry[] = [];
const sinks = new Set<LogSink>();
let seq = 0;
let sinkLevel: LogLevel = 'debug';
/** sink 內部再打日誌時的重入保護：照常入緩衝，但不再往下轉發。 */
let dispatching = false;

/** 取一個帶來源的記錄器。`scope` 原值保留在記錄中，日誌顯示時才轉換受控標籤，請用中文。 */
export function scoped(scope: string): Logger {
  return {
    debug: (message, detail) => emit('debug', scope, message, detail),
    info: (message, detail) => emit('info', scope, message, detail),
    warn: (message, detail) => emit('warn', scope, message, detail),
    error: (message, detail) => emit('error', scope, message, detail),
  };
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    seq: ++seq,
    at: new Date().toISOString(),
    level,
    scope,
    message: redact(String(message)),
    detail: describeDetail(detail),
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  if (dispatching || LEVEL_ORDER[level] < LEVEL_ORDER[sinkLevel]) {
    return;
  }
  dispatching = true;
  try {
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch {
        /* sink 壞掉不能影響正事 */
      }
    }
  } finally {
    dispatching = false;
  }
}

/**
 * 註冊一個轉發口。返回的 dispose 必須在殼銷燬時呼叫，
 * 否則 webview 重建後會有兩份 sink 往兩個已死的通道推。
 */
export function addLogSink(sink: LogSink): Unsubscribe {
  sinks.add(sink);
  return { dispose: () => void sinks.delete(sink) };
}

/** sink 側的級別閾值（緩衝不受影響，始終收全量）。 */
export function setSinkLevel(level: LogLevel): void {
  sinkLevel = level;
}

/** 緩衝裡最近的若干條，按時間正序。 */
export function recentLogs(limit = MAX_ENTRIES): LogEntry[] {
  return limit >= buffer.length ? [...buffer] : buffer.slice(buffer.length - limit);
}

/** 清空緩衝。留一條痕跡——「日誌是空的」和「日誌被清過」是兩回事。 */
export function clearLogs(): void {
  buffer.length = 0;
  emit('info', '日誌', '日誌已清空');
}

// ---------------------------------------------------------------- 格式化

/** `12:03:41` —— 日誌頁與輸出面板都按本地時間顯示。 */
export function logTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 單行文字形式，供終端、輸出面板與「複製日誌」共用。 */
export function formatLogEntry(entry: LogEntry): string {
  const head = `[${logTime(entry.at)}] ${entry.level.toUpperCase().padEnd(5)} ${traditionalLabel(entry.scope)}｜${entry.message}`;
  return entry.detail ? `${head}\n${indent(entry.detail)}` : head;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** 耗時的人話形式：`860ms` / `3.2s` / `1 分 12 秒`。 */
export function elapsed(startedAtMs: number, endedAtMs = Date.now()): string {
  return formatDuration(Math.max(0, endedAtMs - startedAtMs));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 異常 → 一句人話。CancelledError 之類只有名字的異常也能讀。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------- 脫敏

/**
 * 抹掉文字裡像金鑰的片段。
 *
 * 寧可多抹：日誌的用途是排查「哪一章失敗了」，不是核對 Key。
 * 保留前幾位是為了還能分辨「換了一把 Key」。
 *
 * 鍵名與分隔符之間允許一個引號——JSON 序列化出來的是
 * `"x-api-key": "…"`，少了這一段就漏掉最常見的那種形狀。
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9]{0,4})[A-Za-z0-9_-]{6,}/g, '$1…〔已隱去〕')
    .replace(/\b(Bearer\s+)\S+/gi, '$1…〔已隱去〕')
    .replace(
      /((?:api[-_]?key|apikey|authorization|x-api-key|secret|token)["']?\s*[=:]\s*)(["']?)[^\s"',}\]]+/gi,
      '$1$2…〔已隱去〕'
    );
}

function describeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) {
    return undefined;
  }
  const text = detail instanceof Error ? describeErrorDetail(detail) : stringify(detail);
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const clipped =
    trimmed.length > MAX_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…（餘 ${trimmed.length - MAX_DETAIL_CHARS} 字省略）`
      : trimmed;
  return redact(clipped);
}

function describeErrorDetail(err: Error): string {
  const stack = (err.stack ?? '').split('\n').slice(0, 6).join('\n');
  return stack || `${err.name}: ${err.message}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
