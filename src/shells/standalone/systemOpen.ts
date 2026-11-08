import { spawn } from 'node:child_process';

/**
 * 交給系統預設程式開啟（檔案、目錄或 URL）。
 *
 * 這一句 `explorer | open | xdg-open` 原先在兩處各寫了一份：`main.ts` 開瀏覽器、
 * `fileHost.ts` 的「在外部開啟」。屬於平臺機制，所以留在殼裡，但只留一份。
 *
 * `detached + unref`：起完就不管，別讓子程序拖著服務不退出。
 * 拋不拋異常由呼叫方決定要不要接——`spawn` 在找不到命令時是**非同步**報錯
 * （ENOENT 走 error 事件，不是拋出來），所以這裡掛一個空 handler，
 * 免得它冒成 unhandled error 把整個服務帶崩。
 */
export function openWithSystem(target: string): void {
  const cmd =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}
