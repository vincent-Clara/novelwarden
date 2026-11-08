/**
 * 全書查詢替換的訊息入口（獨立版「編輯 → 全書查詢替換…」）：`bookFind` / `cancelBookFind` / `bookReplace`。
 * 搜尋在 `views/bookFind.ts`（只讀），替換在 `features/bookReplace.ts`（經閘道器寫）。
 *
 * - **回覆是廣播**（同一個工程開著兩個視窗時兩邊都收到），前端認 `requestId`。
 * - **叫停按請求認，不按 controller 認**：獨立版幾個視窗開同一個工程時共用一個 controller，「新的一次頂掉上一次」要是記在
 *   controller 上，一個視窗打字會把另一個視窗正在搜的叫停。所以前端發新請求之前自己先 `cancelBookFind` 上一個，
 *   這裡只記「哪幾個 requestId 被叫停了」，搜尋在兩份檔案之間看一眼。
 * - **同一時刻只有一次替換**（同一個 controller 上）：兩次替換交錯著寫同一批檔案，樂觀鎖會讓後一次全部跳過，
 *   但彙總會說成「預覽之後改過了」——不如直接說「上一次還沒換完」。
 */
import type { ChatController } from './index';
import { scoped } from '../runtime/logger';
import { searchBook } from '../views/bookFind';
import { replaceInBook } from '../features/bookReplace';
import type { BookFindQuery, BookReplaceRequest, BookReplaceSummary } from '../protocol';

const log = scoped('全書查詢');

/** 還在搜的請求 → 叫停了沒有。搜完（不論結果）就刪掉。 */
const running = new Map<string, { cancelled: boolean }>();
/** 先到的叫停（`cancelBookFind` 比 `bookFind` 先處理完的那種時序：獨立版對每條訊息併發處理）。只留最近幾個。 */
const cancelledEarly = new Set<string>();
const EARLY_KEPT = 64;

/** 正在替換的 controller。 */
const replacing = new WeakSet<ChatController>();

export async function bookFind(c: ChatController, requestId: string, query: BookFindQuery): Promise<void> {
  if (typeof requestId !== 'string' || !requestId) {
    return;
  }
  if (cancelledEarly.delete(requestId)) {
    return;
  }
  const token = { cancelled: false };
  running.set(requestId, token);
  try {
    const result = await searchBook(c.project, query ?? { query: '', scopes: [] }, { cancelled: () => token.cancelled });
    if (result && !token.cancelled) {
      c.post({ type: 'bookFindResult', requestId, result });
    }
  } finally {
    running.delete(requestId);
  }
}

export function cancelBookFind(requestId: string): void {
  const token = running.get(requestId);
  if (token) {
    token.cancelled = true;
    return;
  }
  if (typeof requestId === 'string' && requestId) {
    cancelledEarly.add(requestId);
    if (cancelledEarly.size > EARLY_KEPT) {
      cancelledEarly.delete(cancelledEarly.values().next().value as string);
    }
  }
}

export async function bookReplace(c: ChatController, requestId: string, request: BookReplaceRequest): Promise<void> {
  if (typeof requestId !== 'string' || !requestId) {
    return;
  }
  if (replacing.has(c)) {
    c.post({ type: 'bookReplaceDone', requestId, summary: failed('上一次全書替換還沒換完，等它換完再來。') });
    return;
  }
  replacing.add(c);
  try {
    const summary = await replaceInBook(c.project, request ?? ({} as BookReplaceRequest));
    c.post({ type: 'bookReplaceDone', requestId, summary });
  } catch (err) {
    // 前端正等著這一句：出錯也要回話（已經換了的幾份在磁碟上、各自留著歷史版本，日誌裡有明細）。
    const message = err instanceof Error ? err.message : String(err);
    log.error(`全書替換出錯：${message}`, err);
    c.post({ type: 'bookReplaceDone', requestId, summary: failed(`替換中途出錯：${message}（已經換了的檔案各自留著歷史版本，日誌裡有明細）`) });
  } finally {
    replacing.delete(c);
    // 換過的檔案：工程樹、章節索引、出場索引、設定名錄都從磁碟現算；state 一到，編輯器核對已開的標籤
    // （沒改過的就地換成新內容，改過的掛衝突條）。
    await c.pushState();
  }
}

function failed(error: string): BookReplaceSummary {
  return { files: 0, hits: 0, replaced: [], skipped: [], chainKept: [], plotOnly: [], bodyOnly: [], renamedCards: [], error };
}
