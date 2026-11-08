/**
 * Bun 執行時的最小型別宣告。不引 bun-types 全量包——獨立殼只用
 * Bun.serve 的一小塊表面；真裝上 bun-types 後可刪除本檔案。
 */

interface BunServerWebSocket {
  send(text: string): void;
  close(): void;
  /** upgrade 時給的 `data`。 */
  readonly data: unknown;
}

interface BunServeOptions {
  port: number;
  hostname?: string;
  fetch(
    req: Request,
    server: {
      port: number;
      upgrade(req: Request, options?: { data?: unknown }): boolean;
      /** 這一個請求的空閒超時（秒），0 = 不限。 */
      timeout(req: Request, seconds: number): void;
    }
  ): Response | undefined | Promise<Response | undefined>;
  websocket?: {
    open?(ws: BunServerWebSocket): void;
    message?(ws: BunServerWebSocket, data: string | Buffer): void | Promise<void>;
    close?(ws: BunServerWebSocket): void;
  };
}

declare const Bun: {
  serve(options: BunServeOptions): { port: number; stop(): void };
};
