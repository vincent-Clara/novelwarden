/**
 * WebSocket 測試客戶端（**ESM，只給 Bun 側的 e2e 用**）。
 *
 * 獨立版的 e2e（tests/e2e/standalone/）跑在 Bun 下：ESM、頂層 await、全域
 * WebSocket。Node 側的測試一律 CommonJS，用不到這份 helper，也 require 不進去。
 *
 * 協議是「發一條、等一條」：服務端會主動推狀態（連上就來一輪全量），
 * 所以不能假設下一條訊息就是自己要的那條——收到的一律先進 inbox，
 * 由 waitFor 按謂詞挑走。已經躺在 inbox 裡的舊訊息也能被挑中，
 * 於是「先 send 後 waitFor」和「訊息先到」兩種時序都成立。
 *
 * 遷自 scripts/smoke-server.js 的 connect()。
 */

const TIMEOUT_MS = 5000;

/**
 * 開一條 WS，把收到的訊息按謂詞分發給等待者，其餘排進 inbox。
 *
 * @param {number} port 服務埠
 * @param {string} [project] 視窗網址上的 `?project=`（獨立版一個視窗開一個工程）
 * @param {Record<string, string>} [headers] 握手時多帶的請求頭
 * @returns {{
 *   ws: WebSocket,
 *   ready: Promise<void>,
 *   waitFor: (match: (msg: any) => boolean, label: string) => Promise<any>,
 *   send: (msg: any) => void,
 *   drain: () => void,
 * }}
 */
export function connect(port, project, headers) {
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  // `headers` 是 Bun 的 WebSocket 擴充套件（瀏覽器沒有）：鑑權用例拿它帶登入換來的 cookie。
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, headers ? { headers } : undefined);
  const inbox = [];
  const waiters = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      waiters.splice(idx, 1)[0].resolve(msg);
    } else {
      inbox.push(msg);
    }
  };

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    setTimeout(() => reject(new Error('WS 連不上')), TIMEOUT_MS);
  });

  const waitFor = (match, label) =>
    new Promise((resolve, reject) => {
      // 先翻 inbox：想等的那條可能在 send 之前就到了。
      const idx = inbox.findIndex(match);
      if (idx >= 0) {
        resolve(inbox.splice(idx, 1)[0]);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`等不到 ${label}`)), TIMEOUT_MS);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });

  return {
    ws,
    ready,
    waitFor,
    send: (m) => ws.send(JSON.stringify(m)),
    /** 丟掉堆積的舊訊息——切目標前必須清，否則 waitFor 會立刻拿到上一輪的。 */
    drain: () => (inbox.length = 0),
    /** inbox 裡是否已有匹配的訊息（不等待）。用來斷言「沒有 init」。 */
    has: (match) => inbox.some(match),
  };
}
