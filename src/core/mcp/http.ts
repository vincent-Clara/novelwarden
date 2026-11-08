/**
 * MCP 的 Streamable HTTP 傳輸。**只用標準的 `Request` / `Response`**，Bun 與 Node 都跑得動。
 *
 * 實現的是規範裡最小的那一截：
 *
 * - `POST` 一條（或一批）JSON-RPC 訊息 → 有請求就回 `application/json`（`tools/call` 見下），只有通知回 202；
 * - `initialize` 的響應帶 `Mcp-Session-Id`，之後的請求帶著它來；認不出的 id 回 404，
 *   客戶端據此重新 `initialize`（服務重啟過就是這樣）；
 * - `DELETE` 結束會話；
 * - `GET`（服務端主動推的那條 SSE 流）回 405——我們從不主動推東西。
 *
 * 帶 `tools/call` 的請求、客戶端又收 `text/event-stream` 時回 SSE：一次呼叫可能跑幾分鐘（寫一章、
 * 等作者點確認），而客戶端等響應頭有上限（Claude Code 預設 60 秒，到點報「The operation timed out.」），
 * 等結果還有空閒上限（HTTP 預設 5 分鐘，收到 progress 通知才重新計時）。所以先回響應頭，跑的期間
 * 每隔 `HEARTBEAT_MS` 發一條 `notifications/progress`（請求沒帶 progressToken 就發一行 SSE 註釋），
 * 跑完把回覆當事件發出去、關流。其餘請求照舊回整份 JSON。
 * 連線上的空閒超時由殼關掉（`server.ts` 的 `server.timeout(req, 0)`）。
 *
 * 地址上可以帶 `?project=<工程目錄>` 指定落到哪個工程（獨立版能同時開幾個）；不帶由殼決定。
 *
 * 鑑權歸殼管，這裡只管 `Origin`：瀏覽器會帶它，認不認由殼給的 `allowOrigin` 定（獨立版預設只放
 * 本機同埠，配了令牌再放同源）——擋掉惡意網頁借瀏覽器打本機埠（DNS rebinding）。
 * 命令列客戶端不帶 `Origin`，放過。
 */
import { randomUUID } from 'node:crypto';
import { scoped } from '../runtime/logger';
import {
  JsonRpcMessage,
  JsonRpcResponse,
  McpServer,
  McpSession,
  RPC,
  isRequest,
  rpcError,
} from './server';

const log = scoped('MCP');

const SESSION_HEADER = 'mcp-session-id';

/** SSE 上多久發一次保活：遠小於客戶端的空閒上限（HTTP 預設 5 分鐘）。 */
export const HEARTBEAT_MS = 15_000;

export interface McpHttpOptions {
  /** 瀏覽器發來的 `Origin` 認不認（`req` 給殼比對 `Host` 用）。不給就一律放過（測試用）。 */
  allowOrigin?(origin: string | null, req: Request): boolean;
  /** SSE 保活間隔，預設 `HEARTBEAT_MS`（測試調小）。 */
  heartbeatMs?: number;
}

export class McpHttpHandler {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly server: McpServer, private readonly opts: McpHttpOptions = {}) {}

  async handle(req: Request): Promise<Response> {
    if (this.opts.allowOrigin && !this.opts.allowOrigin(req.headers.get('origin'), req)) {
      log.warn('拒絕了一個跨源 MCP 請求', `Origin: ${req.headers.get('origin')}`);
      return new Response('Forbidden origin', { status: 403 });
    }
    switch (req.method) {
      case 'POST':
        return this.post(req);
      case 'DELETE':
        return this.remove(req);
      default:
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } });
    }
  }

  /** 服務停掉時調：還在跑的呼叫全中斷。 */
  closeAll(): void {
    for (const s of this.sessions.values()) {
      s.close();
    }
    this.sessions.clear();
  }

  private async post(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json(rpcError(null, RPC.parseError, '請求體不是合法的 JSON。'), 400);
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    if (messages.length === 0) {
      return json(rpcError(null, RPC.invalidRequest, '空的批次請求。'), 400);
    }

    const initializing = messages.some((m) => m?.method === 'initialize');
    const sid = req.headers.get(SESSION_HEADER);
    let session: McpSession;
    if (initializing) {
      session = new McpSession(randomUUID());
      this.sessions.set(session.id, session);
    } else if (sid) {
      const found = this.sessions.get(sid);
      if (!found) {
        // 規範：認不出的會話回 404，客戶端會重新 initialize。
        return json(rpcError(null, RPC.invalidRequest, '會話不存在或已過期，請重新 initialize。'), 404);
      }
      session = found;
    } else {
      // 不帶會話 id 的客戶端也放過：只是沒法按會話省掉重複的狀態簡報。
      session = new McpSession('');
    }
    // 地址上的 `?project=` 跟著每次請求走：客戶端配置裡改了地址、不必重新 initialize。
    session.project = new URL(req.url).searchParams.get('project')?.trim() || undefined;

    const headers: Record<string, string> = session.id ? { 'Mcp-Session-Id': session.id } : {};
    const long = messages.some((m) => m?.method === 'tools/call' && isRequest(m));
    if (long && (req.headers.get('accept') ?? '').includes('text/event-stream')) {
      return this.stream(messages, session, req.signal, headers);
    }

    const replies = (
      await Promise.all(messages.map((m) => this.server.dispatch(m, session, req.signal)))
    ).filter((r): r is JsonRpcResponse => r !== undefined);

    if (replies.length === 0) {
      return new Response(null, { status: 202, headers });
    }
    return json(batch ? replies : replies[0], 200, headers);
  }

  /** 先回響應頭，跑的期間發保活，跑完一條回覆一個事件。 */
  private stream(
    messages: JsonRpcMessage[],
    session: McpSession,
    signal: AbortSignal,
    headers: Record<string, string>
  ): Response {
    const tokens = messages
      .map((m) => (m?.params?._meta as { progressToken?: unknown } | undefined)?.progressToken)
      .filter((t): t is string | number => typeof t === 'string' || typeof t === 'number');
    const encoder = new TextEncoder();
    // 客戶端斷開時流會被 cancel：與 req.signal 一起當取消訊號，哪個先到都中斷那次呼叫。
    const gone = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (chunk: string) => {
          if (!gone.signal.aborted) {
            controller.enqueue(encoder.encode(chunk));
          }
        };
        // Bun 等到第一塊正文才把響應頭發出去：先發一行註釋，響應頭當場就到。
        send(': open\n\n');
        let beat = 0;
        timer = setInterval(() => {
          beat++;
          if (tokens.length === 0) {
            send(': running\n\n');
          }
          for (const progressToken of tokens) {
            send(event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: beat, message: '仍在執行' } }));
          }
        }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
        try {
          const replies = await Promise.all(
            messages.map((m) => this.server.dispatch(m, session, AbortSignal.any([signal, gone.signal])))
          );
          for (const r of replies) {
            if (r !== undefined) {
              send(event(r));
            }
          }
        } finally {
          clearInterval(timer);
          if (!gone.signal.aborted) {
            controller.close();
          }
        }
      },
      cancel: () => {
        clearInterval(timer);
        gone.abort();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...headers },
    });
  }

  private remove(req: Request): Response {
    const sid = req.headers.get(SESSION_HEADER);
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session) {
      return new Response(null, { status: 404 });
    }
    session.close();
    this.sessions.delete(session.id);
    log.info(`MCP 會話結束${session.clientName ? `：${session.clientName}` : ''}`);
    return new Response(null, { status: 200 });
  }
}

function event(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function json(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
