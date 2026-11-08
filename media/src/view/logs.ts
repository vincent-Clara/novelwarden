import { traditionalLabel } from '../../../src/core/model/labels';
/**
 * 日誌頁。
 *
 * 日誌頁是使用者唯一能事後複查「剛才那 76 章卡在哪」的地方，所以：
 * - 全量緩衝留在前端，篩選純在本地做，不往後端要；
 * - **增量不重畫整表**——長任務每秒好幾條，重畫會讓滾動位置亂跳，
 *   而且只在原本就貼著底時才跟著滾（使用者翻上去看東西時不該被拽回來）。
 */
import { el as mk, maybeById, setHidden } from '../dom';
import type { LogEntry, LogLevel } from '../protocol';
import { logTime } from './format';
import { el } from './refs';
import { vscode } from './store';
import { isTabActive } from './tabs';
import { toast } from './toast';

const LOG_ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LABEL: Record<string, string> = { debug: '除錯', info: '資訊', warn: '警告', error: '錯誤' };

/** 與後端 MAX_ENTRIES 同量級，避免網頁開一整天后攢下幾萬個節點。 */
const MAX_ROWS = 800;
/** 離底多近算「貼著底」。 */
const AT_BOTTOM_SLACK = 40;

/** 全量緩衝的前端副本。 */
let logs: LogEntry[] = [];
/** 只在日誌頁之外累計，切過去就清零——徽標是「有沒有沒看過的錯」。 */
let unseenErrors = 0;
/**
 * 從庫裡補進來的歷史條數。
 *
 * 單獨記一筆是為了讓 `MAX_ROWS` 的裁剪不把剛載入的歷史又切掉——
 * 使用者點「載入更早」就是要往前看，結果最早那批被裁掉才是荒謬的。
 */
let loadedHistory = 0;
/** 再往前沒有了。按鈕據此禁用——一直點一個什麼都不會發生的按鈕很挫。 */
let historyExhausted = false;

export function renderLogs(entries: LogEntry[]): void {
  logs = entries || [];
  // 後端重推的是記憶體緩衝（不含歷史），歷史副本隨之作廢。
  loadedHistory = 0;
  historyExhausted = false;
  syncEarlierBtn();
  redraw();
}

/** 按當前篩選重畫整表。載入歷史與切篩選條件都走它。 */
function redraw(): void {
  el.logBody.innerHTML = '';
  const shown = logs.filter(matches);
  for (const entry of shown) {
    el.logBody.appendChild(buildLogRow(entry));
  }
  updateMeta(shown.length);
  if (el.logFollow.checked) {
    el.logBody.scrollTop = el.logBody.scrollHeight;
  }
}

/**
 * 庫裡取來的更早日誌，接在最前面。
 *
 * **不自動滾動**：使用者點「載入更早」是要往前看，把他拽回底部等於白點。
 * 按 seq 去重——記憶體緩衝與庫裡那份必然重疊（同一條既進了緩衝也寫了庫）。
 */
export function prependLogHistory(entries: LogEntry[], exhausted: boolean): void {
  historyExhausted = exhausted;
  const known = new Set(logs.map((e) => e.seq));
  const fresh = entries.filter((e) => !known.has(e.seq));
  if (fresh.length > 0) {
    logs = [...fresh, ...logs];
    loadedHistory += fresh.length;
    // 保住滾動位置：重畫後把視口挪回原先那條上，不然會跳到頂。
    const anchor = el.logBody.scrollHeight - el.logBody.scrollTop;
    redraw();
    el.logBody.scrollTop = el.logBody.scrollHeight - anchor;
  }
  syncEarlierBtn();
}

/** 沒有更早的了（或沒有庫）就禁用按鈕並改文案。 */
function syncEarlierBtn(): void {
  const btn = maybeById<HTMLButtonElement>('logEarlierBtn');
  if (!btn) {
    return;
  }
  btn.disabled = historyExhausted;
  btn.textContent = historyExhausted ? '沒有更早的了' : '載入更早';
}

/** 增量追加一條。 */
export function appendLog(entry: LogEntry): void {
  logs.push(entry);
  // 裁剪時把載入進來的歷史算進上限：那是使用者主動要的，不能被實時日誌頂掉。
  const cap = MAX_ROWS + loadedHistory;
  if (logs.length > cap) {
    logs.splice(0, logs.length - cap);
  }

  if (entry.level === 'error' && !isTabActive('logs')) {
    unseenErrors++;
    syncDot();
  }
  if (!matches(entry)) {
    return;
  }

  const atBottom =
    el.logBody.scrollHeight - el.logBody.scrollTop - el.logBody.clientHeight < AT_BOTTOM_SLACK;
  el.logBody.appendChild(buildLogRow(entry));
  while (el.logBody.childElementCount > MAX_ROWS + loadedHistory) {
    el.logBody.removeChild(el.logBody.firstChild!);
  }
  updateMeta(el.logBody.childElementCount);
  if (el.logFollow.checked && atBottom) {
    el.logBody.scrollTop = el.logBody.scrollHeight;
  }
}

/** 切到日誌頁時把紅點收掉。 */
export function clearUnseenErrors(): void {
  unseenErrors = 0;
  syncDot();
}

/** 獨立版活動欄上的紅點：有沒看過的錯誤就亮著。外掛裡沒這個節點。 */
function syncDot(): void {
  const dot = maybeById('logsErrorDot');
  if (dot) {
    setHidden(dot, unseenErrors === 0);
  }
}

function levelValue(): number {
  return LOG_ORDER[el.logLevel.value] || LOG_ORDER.info;
}

function matches(entry: LogEntry): boolean {
  if ((LOG_ORDER[entry.level] || 0) < levelValue()) {
    return false;
  }
  const needle = el.logFilter.value.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return `${entry.scope} ${entry.message} ${entry.detail || ''}`.toLowerCase().includes(needle);
}

function levelLabel(level: LogLevel): string {
  return LOG_LABEL[level] || level;
}

function buildLogRow(entry: LogEntry): HTMLElement {
  const row = mk('div', `log-row log-${entry.level}`);

  const head = mk('div', 'log-head');
  head.appendChild(mk('span', 'log-time', logTime(entry.at)));
  head.appendChild(mk('span', 'log-level', levelLabel(entry.level)));
  head.appendChild(mk('span', 'log-scope', traditionalLabel(entry.scope)));
  head.appendChild(mk('span', 'log-msg', entry.message));
  row.appendChild(head);

  if (entry.detail) {
    // detail 預設收起：一次同步幾十條，攤開就沒法掃了。
    const det = mk('details', 'log-detail');
    det.appendChild(mk('summary', undefined, '詳情'));
    det.appendChild(mk('pre', undefined, entry.detail));
    row.appendChild(det);
  }
  return row;
}

function updateMeta(shown: number): void {
  el.logMeta.textContent =
    shown === logs.length ? `${logs.length} 條` : `${shown} / ${logs.length} 條`;
}

/** 複製當前篩選出來的那些行，格式與終端裡看到的一致。 */
function copyShown(): void {
  const text = logs
    .filter(matches)
    .map((e) => {
      const head = `[${logTime(e.at)}] ${levelLabel(e.level)} ${traditionalLabel(e.scope)}｜${e.message}`;
      return e.detail
        ? `${head}\n${e.detail.split('\n').map((l) => `    ${l}`).join('\n')}`
        : head;
    })
    .join('\n');

  if (!text) {
    toast('沒有可複製的日誌。');
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast('日誌已複製到剪貼簿。'))
    .catch(() => toast('複製失敗，可手動選中複製。', true));
}

export function installLogs(): void {
  el.logLevel.addEventListener('change', () => redraw());
  el.logFilter.addEventListener('input', () => redraw());
  // 清空走後端：它要在緩衝裡留一條「日誌已清空」的痕跡。
  el.logClearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearLogs' }));
  el.logCopyBtn.addEventListener('click', copyShown);

  // 「載入更早」是唯一會查資料庫的入口。預設進日誌頁只看記憶體緩衝，
  // 一次查詢都不做——那條路徑必須保持零開銷。
  const earlier = maybeById<HTMLButtonElement>('logEarlierBtn');
  earlier?.addEventListener('click', () => {
    // 已顯示的最早那條的時間戳，據它繼續往前翻。
    vscode.postMessage({ type: 'requestLogHistory', before: logs[0]?.at });
  });
}
