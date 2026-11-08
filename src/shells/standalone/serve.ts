/**
 * 起 HTTP + WebSocket 服務的那一層，與執行時無關的一面。
 *
 * 獨立版平時跑在 Bun 裡，直接用 `Bun.serve`；Android 殼裡沒有 Bun（它不出 Android 的構建，
 * bionic 也跑不了 glibc 的二進位制），只有 Termux 編的 node，於是同一份服務端要在 node 上也起得來。
 * 兩邊的差別只在「怎麼監聽」，路由、鑑權、WebSocket 的收發都在 [server.ts](server.ts) 裡寫一份：
 * 這裡的形狀照 `Bun.serve` 擺（`fetch(req, ctl)` + `websocket` 三個回呼），Bun 下原樣交過去，
 * node 下由 [nodeServe.ts](nodeServe.ts) 轉成 `node:http` + `ws`。
 *
 * 挑哪一個看執行時有沒有 `Bun` 這個全域——是執行時的能力，不是「我是哪個殼」。
 *
 * `ws` 靜態 import 也不怕 Bun：Bun 把 `ws` 這個包換成自己內建的實現，不讀 node_modules。
 */
import { serveNode } from './nodeServe';

/** 一條 WebSocket 連線。`data` 是升級時給的那份。 */
export interface ServerSocket {
  send(text: string): void;
  close(): void;
  readonly data: unknown;
}

/** 處理一個請求時能對服務做的事（Bun 的 `server` 引數裡用得到的那幾樣）。 */
export interface ServeControl {
  readonly port: number;
  /** 把這個請求升級成 WebSocket；成了返回 true，`fetch` 隨後返回 undefined。 */
  upgrade(req: Request, options?: { data?: unknown }): boolean;
  /** 這一個請求的空閒超時（秒），0 = 不限。 */
  timeout(req: Request, seconds: number): void;
}

export interface ServeSpec {
  port: number;
  hostname: string;
  fetch(req: Request, ctl: ServeControl): Response | undefined | Promise<Response | undefined>;
  websocket: {
    open(ws: ServerSocket): void;
    message(ws: ServerSocket, data: string): void | Promise<void>;
    close(ws: ServerSocket): void;
  };
}

export interface Served {
  port: number;
  stop(): void;
}

/** 埠被佔等起不來的情況一律拋（main.ts 據此順延埠重試）。 */
export async function serve(spec: ServeSpec): Promise<Served> {
  if (typeof Bun !== 'undefined') {
    return Bun.serve({
      port: spec.port,
      hostname: spec.hostname,
      fetch: spec.fetch,
      websocket: {
        open: spec.websocket.open,
        message: (ws, raw) => spec.websocket.message(ws, String(raw)),
        close: spec.websocket.close,
      },
    });
  }
  return serveNode(spec);
}
