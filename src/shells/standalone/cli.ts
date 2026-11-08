import * as path from 'node:path';

/**
 * 避開 Windows 的動態埠段（Hyper-V / WinNAT 會在裡面隨機整段保留，被保留的埠
 * listen 直接報 EADDRINUSE，順延 20 個也可能跳不出去）：預設 49152 起，改過的機器常是 1024 起。
 */
export const DEFAULT_PORT = 36800;

export interface CliOptions {
  /** 小說工程目錄。不帶位置引數且不是 `init` 時為空——進空視窗。 */
  root: string | undefined;
  port: number;
  /** 監聽地址。預設只綁本機；綁別的地址必須配令牌（見 auth.ts 的 `exposureError`）。 */
  host: string;
  open: boolean;
  init: boolean;
  /** 終端裡連 debug 級日誌一起打（逐章進度等）。網頁的日誌頁始終收全量。 */
  verbose: boolean;
}

/**
 * novelwarden [dir] [--port N] [--host ADDR] [--no-open] [--verbose]
 * novelwarden init [dir]
 *
 * 不帶目錄起服務時 `root` 為 undefined（不再把 cwd 當成工程）。
 * `init` 不帶目錄時仍預設當前目錄，與原來一致。
 * 令牌不走引數（會出現在 `ps` 裡），只認環境變數 `NOVELWARDEN_TOKEN`（舊名 `NOVELFORGE_TOKEN` 相容），由 main.ts 讀。
 */
export function parseArgs(argv: string[]): CliOptions {
  let port = DEFAULT_PORT;
  let host = '127.0.0.1';
  let open = true;
  let init = false;
  let verbose = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = Number(argv[++i]) || DEFAULT_PORT;
    } else if (a === '--host') {
      host = argv[++i]?.trim() || '127.0.0.1';
    } else if (a === '--no-open') {
      open = false;
    } else if (a === '--verbose' || a === '-v') {
      verbose = true;
    } else if (a === 'init') {
      init = true;
    } else if (!a.startsWith('-')) {
      rest.push(a);
    }
  }
  let root: string | undefined;
  if (rest.length > 0) {
    root = path.resolve(rest[0]);
  } else if (init) {
    root = path.resolve('.');
  }
  return { root, port, host, open, init, verbose };
}
