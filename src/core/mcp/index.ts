/**
 * Novelwarden 的 MCP 入口：工具清單 + 說明 + HTTP 傳輸，殼只要給出「當前工程的執行端」。
 *
 * ```ts
 * const mcp = createNovelMcp((project) => hub.mcpBackend(project));
 * // fetch 裡：if (url.pathname === '/mcp') return mcp.handle(req);
 * ```
 */
import { NOVEL_TOOLS } from '../tools/novel';
import { specOf } from '../tools/registry';
import { McpHttpHandler, McpHttpOptions } from './http';
import { MCP_INSTRUCTIONS } from './instructions';
import { McpBackend, McpServer } from './server';

export { McpHttpHandler } from './http';
export type { McpHttpOptions } from './http';
export { McpServer, McpSession, PROTOCOL_VERSIONS } from './server';
export type { McpBackend, McpCallResult } from './server';
export { MCP_INSTRUCTIONS } from './instructions';

/** 掛在獨立版服務上的路徑。 */
export const MCP_PATH = '/mcp';

/** `serverInfo.version`。只給客戶端日誌看，不參與任何判斷。 */
const SERVER_VERSION = '0.1.0';

export function createNovelMcp(backend: (project?: string) => McpBackend | undefined, opts: McpHttpOptions = {}): McpHttpHandler {
  const server = new McpServer({
    tools: NOVEL_TOOLS.map(specOf),
    backend,
    version: SERVER_VERSION,
    instructions: MCP_INSTRUCTIONS,
  });
  return new McpHttpHandler(server, opts);
}
