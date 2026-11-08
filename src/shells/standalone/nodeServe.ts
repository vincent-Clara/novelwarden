/**
 * node 上的監聽：`node:http` 接 HTTP，`ws` 接 WebSocket 升級，把它們轉成 [serve.ts](serve.ts) 那套
 * 照 `Bun.serve` 擺的形狀。只有沒有 Bun 的地方走這裡——眼下就是 Android 殼（內建 Termux 編的 node）。
 *
 * 幾處要對齊 Bun 的行為：
 * - **客戶端斷開要能取消**：MCP 的一次呼叫靠 `req.signal` 知道對面走了（`core/mcp/http.ts`），
 *   這裡在響應沒寫完就斷開時 abort 它。
 * - **流式響應邊到邊寫**：MCP 的 SSE 一條一條推，頭先發出去，背壓時等 drain。
 * - **升級被拒要回一個真的 HTTP 響應**：`fetch` 對 `/ws` 回 401 / 403 時，把它寫回裸 socket 再關。
 * - **一個處理器拋了不能帶走整個服務**：Bun 裡 WebSocket 回呼拋錯只打一行，node 裡沒接住的 rejection 會讓程序退出
 *   ——手機上那就是服務沒了、頁面一直重連。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { describeError, scoped } from '../../core/runtime/logger';
import type { ServeControl, ServeSpec, Served, ServerSocket } from './serve';

const log = scoped('服務');

let rejectionGuard = false;

export function serveNode(spec: ServeSpec): Promise<Served> {
  if (!rejectionGuard) {
    rejectionGuard = true;
    process.on('unhandledRejection', (err) => log.error(`未處理的異常：${describeError(err)}`, err));
  }

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let port = spec.port;

  // node 的 http 服務預設沒有空閒超時（`server.timeout` 為 0），一次跑幾分鐘的 MCP 呼叫不會被掐，
  // Bun 那邊才需要對 /mcp 單獨關掉；這裡 `timeout` 什麼都不用做。
  const control = (onUpgrade?: (data: unknown) => void): ServeControl => ({
    get port() {
      return port;
    },
    upgrade: (_req, options) => {
      if (!onUpgrade) {
        return false;
      }
      onUpgrade(options?.data);
      return true;
    },
    timeout: () => undefined,
  });

  server.on('request', (req, res) => {
    void (async () => {
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          gone.abort();
        }
      });
      let response: Response | undefined;
      try {
        response = await spec.fetch(toRequest(req, port, gone.signal), control());
      } catch (err) {
        log.error(`處理請求失敗：${req.method} ${req.url}：${describeError(err)}`, err);
        response = new Response('Internal Server Error', { status: 500 });
      }
      await sendResponse(res, response ?? new Response('Not Found', { status: 404 }));
    })();
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    void (async () => {
      let upgraded = false;
      let data: unknown;
      let response: Response | undefined;
      try {
        response = await spec.fetch(
          toRequest(req, port),
          control((d) => {
            upgraded = true;
            data = d;
          })
        );
      } catch (err) {
        log.error(`處理 WebSocket 握手失敗：${describeError(err)}`, err);
        response = new Response('Internal Server Error', { status: 500 });
      }
      if (upgraded && !response) {
        wss.handleUpgrade(req, socket, head, (ws) => attach(ws, data));
        return;
      }
      await refuseUpgrade(socket, response ?? new Response('Not Found', { status: 404 }));
    })();
  });

  const attach = (ws: WebSocket, data: unknown): void => {
    const sock: ServerSocket = {
      send: (text) => ws.send(text),
      close: () => ws.close(),
      data,
    };
    // 沒人接的 'error' 會被 EventEmitter 當異常拋出來；出錯之後 'close' 照樣會來，收尾在那裡做。
    ws.on('error', () => undefined);
    spec.websocket.open(sock);
    ws.on('message', (raw) => {
      Promise.resolve()
        .then(() => spec.websocket.message(sock, raw.toString()))
        .catch((err: unknown) => log.error(`處理網頁訊息失敗：${describeError(err)}`, err));
    });
    ws.on('close', () => spec.websocket.close(sock));
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.port, spec.hostname, () => {
      server.off('error', reject);
      server.on('error', (err) => log.error(`服務出錯：${describeError(err)}`, err));
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop: () => {
          for (const ws of wss.clients) {
            ws.terminate();
          }
          wss.close();
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

function toRequest(req: http.IncomingMessage, port: number, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const method = req.method ?? 'GET';
  const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url ?? '/'}`;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // `duplex` 是流式請求體必須給的（undici 的要求），lib.dom 的 RequestInit 裡還沒有這一項。
  const init = {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: 'half',
  } as RequestInit;
  return new Request(url, init);
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') {
      res.setHeader(key, value);
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    res.setHeader('set-cookie', cookies);
  }
  if (!response.body) {
    res.end();
    return;
  }
  // SSE 要先把頭發出去：第一條事件可能要等幾秒，客戶端在這之前一直以為沒連上。
  res.flushHeaders();
  const reader = response.body.getReader();
  res.on('close', () => {
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) {
        break;
      }
      if (!res.write(value)) {
        await drained(res);
      }
    }
  } catch {
    // 客戶端斷了，或響應體那一頭出錯：都沒有可以再寫給誰的了。
  }
  res.end();
}

/** 等到能接著寫，或者連線已經沒了（那時 drain 永遠不會來）。 */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

async function refuseUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.text());
  const head = [
    `HTTP/1.1 ${response.status} ${http.STATUS_CODES[response.status] ?? ''}`,
    'Connection: close',
    `Content-Type: ${response.headers.get('content-type') ?? 'text/plain; charset=utf-8'}`,
    `Content-Length: ${body.length}`,
    '',
    '',
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(head), body]));
}
