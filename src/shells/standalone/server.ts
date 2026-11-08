/**
 * 獨立版 Web 服務：靜態頁 + /ws WebSocket。Bun 下是 `Bun.serve`，沒有 Bun 的地方（Android 殼裡的 node）
 * 走 `node:http` + `ws`，兩邊的差別收在 [serve.ts](serve.ts)，路由與收發只在這裡寫一份。
 * 預設只綁 127.0.0.1、無鑑權——服務本機作者。部署到伺服器時綁別的地址、配上令牌，
 * 規則與理由見 [auth.ts](auth.ts)。
 *
 * 工程由 WorkspaceHub 持有：一個程序同時開著幾個，每個視窗（WebSocket）各綁一個或者空著，
 * 視窗網址上的 `?project=` 說它開的是哪個。ChatController 仍然一對一綁一份 NovelProject，
 * 沒有工程時不造假例項。
 */
import { initHost } from '../../core/host';
import { setTaskOwnerResolver } from '../../core/runtime/progress';
import { initSecrets } from '../../core/llm/registry';
import {
  addLogSink,
  describeError,
  formatLogEntry,
  scoped,
  setSinkLevel,
} from '../../core/runtime/logger';
import { InMessage, OutMessage } from '../../core/protocol';
import { MCP_PATH, createNovelMcp } from '../../core/mcp';
import { FileConfigStore, FileSecretStore } from '../../core/stores';
import { PRODUCT_VERSION, assetBytes } from './assets';
import { LEGACY_TOKEN_ENV, LOGIN_PATH, TOKEN_ENV, handleLogin, isAllowedOrigin, isAuthorized, loginRequired } from './auth';
import { FileHost } from './fileHost';
import { standalonePage } from './page';
import { currentScope, ScopedHost } from './scopedHost';
import { serve, ServerSocket } from './serve';
import { WindowConn, WorkspaceHub } from './workspaceHub';

const log = scoped('服務');

/** 終端 sink 只掛一次：埠被佔時 main.ts 會重試著調 startServer，
 *  每次都掛會讓同一條日誌列印好幾遍。 */
let consoleSinkAttached = false;

export interface ServeOptions {
  /** 小說工程目錄。不傳則按 window.json 恢復，或進空視窗。 */
  root?: string;
  port: number;
  /** 監聽地址，預設 127.0.0.1。安不安全由呼叫方先過 `exposureError`。 */
  host?: string;
  /** 訪問令牌。給了就所有頁面、WS、MCP 都要鑑權。 */
  token?: string;
  /** 終端裡也打 debug 級日誌。網頁的日誌頁始終收全量，不受這裡影響。 */
  verbose?: boolean;
  /** window.json 所在目錄。測試注入，預設為 ~/.novelwarden。 */
  windowDir?: string;
}

export async function startServer(opts: ServeOptions): Promise<number> {
  // 終端只轉 info 及以上（--verbose 時放開 debug）：debug 裡有逐章進度，
  // 跑一次同步會刷屏，而網頁的日誌頁本來就看得到那些。
  setSinkLevel(opts.verbose ? 'debug' : 'info');
  if (!consoleSinkAttached) {
    consoleSinkAttached = true;
    addLogSink((entry) => console.log(formatLogEntry(entry)));
  }

  const clients = new Map<ServerSocket, WindowConn>();

  const broadcast = (msg: OutMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients.keys()) {
      ws.send(text);
    }
  };

  // 不在任何視窗上下文裡的 getHost()（啟動期）落到這一份，廣播給所有網頁。
  const config = new FileConfigStore();
  initHost(new ScopedHost(new FileHost(config, broadcast)));
  initSecrets(new FileSecretStore());
  setTaskOwnerResolver(() => currentScope()?.owner);
  const hub = new WorkspaceHub({ config, windowDir: opts.windowDir });
  await hub.bootstrap(opts.root);

  // 外部 agent（Claude Code 之類）從這裡接進來。地址帶 `?project=<工程目錄>` 就落到那個工程，
  // 不帶落到作者最近操作的那個視窗的工程。沒開啟工程時工具照樣列得出來，呼叫回一句「先開啟工程」。
  let port = opts.port;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token;
  const mcp = createNovelMcp((project) => hub.mcpBackend(project), {
    allowOrigin: (origin, req) => isAllowedOrigin(origin, req, port, !!token),
  });

  const server = await serve({
    port: opts.port,
    hostname: host,

    fetch(req, server) {
      const url = new URL(req.url);
      if (token) {
        // 靜態資源與登入本身不設防：登入頁要用 favicon，資源裡也沒有作者的東西。
        if (url.pathname === LOGIN_PATH) {
          return handleLogin(req, token);
        }
        const open = url.pathname.startsWith('/media/') || url.pathname === '/favicon.ico';
        if (!open && !isAuthorized(req, token)) {
          if (url.pathname === '/' || url.pathname === '/index.html') {
            return loginRequired(url);
          }
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="novelwarden"' },
          });
        }
      }
      if (url.pathname === MCP_PATH) {
        // 一次工具呼叫可能跑幾分鐘（寫一章），期間連線上一個位元組都沒有。Bun 預設 10 秒
        // 空閒就斷，這裡對這一個請求關掉。
        server.timeout(req, 0);
        return mcp.handle(req);
      }
      if (url.pathname === '/ws') {
        // 沒配令牌時只靠「僅綁 127.0.0.1」保護。惡意網頁無法讀跨源
        // WebSocket 的響應，但能發訊息（WS 不受同源策略約束），
        // 所以這裡顯式校驗 Origin，把 DNS rebinding 一類的寫入攻擊擋在外面。
        if (!isAllowedOrigin(req.headers.get('origin'), req, server.port, !!token)) {
          log.warn('拒絕了一個跨源 WebSocket 連線', `Origin: ${req.headers.get('origin')}`);
          return new Response('Forbidden origin', { status: 403 });
        }
        // 視窗開的是哪個工程：頁面把自己網址上的 `?project=` 原樣帶過來。
        const project = url.searchParams.get('project')?.trim() || undefined;
        if (server.upgrade(req, { data: { project } })) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const project = url.searchParams.get('project')?.trim();
        // 不帶工程的網址落到最近操作的那個工程上，並把它寫進網址：之後重新整理、重連都認這一個，
        // 別的視窗換了「最近操作」也不會把這個視窗帶走。
        // 只寫路徑：反代（https 終結在 nginx）後面 req.url 是 http，寫全了會跳到 http 去，
        // Android 殼看到源變了就當外鏈交給系統瀏覽器。
        const fallback = project ? undefined : hub.defaultRoot();
        if (fallback) {
          const target = new URL(url);
          target.searchParams.set('project', fallback);
          return new Response(null, { status: 302, headers: { location: target.pathname + target.search } });
        }
        return new Response(standalonePage(project, PRODUCT_VERSION), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/media/')) {
        const asset = assetBytes(url.pathname.slice('/media/'.length));
        if (asset) {
          return new Response(asset.bytes, { headers: { 'content-type': asset.mime } });
        }
      }
      // 瀏覽器會自動請求 /favicon.ico；不接住的話每次載入都在控制檯留一條 404。
      // icon.svg 用 currentColor（活動欄裡要跟隨主題），單獨當 favicon 時沒有
      // 繼承色可用，這裡替換成品牌藍，深淺色標籤欄上都看得見。
      if (url.pathname === '/favicon.ico') {
        const icon = assetBytes('icon.svg');
        if (icon) {
          const svg = new TextDecoder().decode(icon.bytes).replaceAll('currentColor', '#4daafc');
          return new Response(svg, { headers: { 'content-type': icon.mime } });
        }
      }
      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        // 重連時 view.js 不會再發 ready，connect 裡主動推一遍全量狀態；
        // 首次載入時前端還沒掛監聽，view.js 載入完會發 ready 再推一遍。
        const project = (ws.data as { project?: string } | undefined)?.project;
        clients.set(ws, hub.connect((msg) => ws.send(JSON.stringify(msg)), project));
        log.debug(`網頁已連線（當前 ${clients.size} 個客戶端）`);
      },
      async message(ws, raw) {
        const conn = clients.get(ws);
        if (!conn) {
          return;
        }
        let msg: InMessage;
        try {
          msg = JSON.parse(raw) as InMessage;
        } catch (err) {
          log.error(`處理網頁訊息失敗：${describeError(err)}`, err);
          return;
        }
        await hub.receive(conn, msg);
      },
      close(ws) {
        const conn = clients.get(ws);
        clients.delete(ws);
        if (conn) {
          hub.disconnect(conn);
        }
        log.debug(`網頁已斷開（剩 ${clients.size} 個客戶端）`);
      },
    },
  });

  port = server.port;

  // 走日誌而不是裸 console.log：終端 sink 會把它打出來，網頁的日誌頁也留一條。
  // 令牌本身絕不進日誌（網頁日誌頁、docker logs 都看得到）。帶令牌的請求頭寫法也不打：
  // 日誌脫敏（logger.ts 的 redact）見到 Bearer / Authorization 就整段抹掉，打出來也只剩省略號。
  const rootLabel = hub.defaultRoot() ?? '未開啟工程';
  const wildcard = host === '0.0.0.0' || host === '::';
  const shown = wildcard ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const base = `http://${shown}:${server.port}`;
  log.info(`服務已啟動：${base}/`, `工程根 ${rootLabel}${wildcard ? `；監聽 ${host}（所有網路卡）` : ''}`);
  if (token) {
    log.info('已開啟令牌鑑權', `令牌取自環境變數 ${TOKEN_ENV}（舊名 ${LEGACY_TOKEN_ENV} 也認）；網頁先登入，MCP 客戶端在請求頭裡帶上它`);
  }
  const addCmd = `claude mcp add --transport http novelwarden ${base}${MCP_PATH}`;
  log.info(`MCP 已就緒：${base}${MCP_PATH}`, token ? `${addCmd}（另加 --header 帶令牌，寫法見 README「Docker 部署」）` : addCmd);
  return server.port;
}
