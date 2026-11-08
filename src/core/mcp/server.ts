/**
 * MCP server：**把 `tools/` 那套工具端給外部 agent**（Claude Code、Codex……）。
 *
 * 這一層只懂協議：JSON-RPC 的那幾個方法、會話、取消。它不認識 `Workspace`、
 * `DraftStore`、任何一個具體工具——工具清單是一份 `ToolSpec[]`，執行交給
 * {@link McpBackend}（[controller/mcp.ts](../controller/mcp.ts) 綁在當前工程上的那一份）。
 * 傳輸在 [http.ts](http.ts)。
 *
 * ## 支援的方法
 *
 * | 方法 | 做什麼 |
 * |---|---|
 * | `initialize` | 協商版本，回 `instructions`（怎麼用這幾個工具） |
 * | `ping` | 回 `{}` |
 * | `tools/list` | 全部工具，帶 `readOnlyHint` / `destructiveHint` |
 * | `tools/call` | 執行；出錯照 MCP 的約定回 `isError`，不回 JSON-RPC 錯誤 |
 * | `notifications/cancelled` | 中斷那一次呼叫（生成會停在半路） |
 *
 * 沒有 resources / prompts / sampling：用不上，多宣告一項能力就多一處宿主會來問的東西。
 *
 * ## 狀態簡報跟著工具結果走（第 20 條）
 *
 * MCP 沒有「每回合往 system 裡注入」這個口子，於是狀態機給出的那份簡報貼在工具結果
 * 末尾——**只在它變了的時候貼**：會話的第一次呼叫必貼，之後與上一次貼出去的那份逐字比，
 * 一樣就不貼。連讀十份檔案不會被同一段簡報刷十遍，
 * 而寫完一章之後下一次呼叫一定看得到新的「下一步」。沒有 `status` 工具的理由照舊：
 * 狀態白送，不給模型「要不要查一下」的選擇。
 */
import type { ToolSpec } from '../tools/types';
import { describeError, scoped } from '../runtime/logger';

const log = scoped('MCP');

/** 認得的協議版本，新的在前。客戶端要的不在表裡時回第一個（規範的協商方式）。 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 一次 `tools/call` 的結果。 */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

/**
 * 綁在某一個工程上的執行端。**每次呼叫現取**（{@link McpServerOptions.backend}）：
 * 作者可能在網頁上換了工程，MCP 會話不跟著重連。
 */
export interface McpBackend {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  /** 現在這本書走到哪了（第 20 條的那份簡報）。 */
  brief(): Promise<string>;
}

export interface McpServerOptions {
  /** 工具清單。與工程無關，沒開啟工程時 `tools/list` 照樣回得出來。 */
  tools: ToolSpec[];
  /**
   * 工程的執行端。`project` 是客戶端在 MCP 地址上寫的 `?project=<工程目錄>`：給了就落到那個工程，
   * 沒給由殼決定（獨立版：作者最近操作的那個視窗）。那個工程沒開啟時回 undefined。
   */
  backend(project?: string): McpBackend | undefined;
  version: string;
  instructions: string;
}

// ---------------------------------------------------------------- JSON-RPC

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 帶 `id` 和 `method` 的是請求；只有 `method` 的是通知；只有 `id` 的是客戶端回的響應。 */
export function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

// ---------------------------------------------------------------- 會話

/** 一條 MCP 會話。`initialize` 時建，DELETE 或服務停掉時沒。 */
export class McpSession {
  /** 上一次貼出去的簡報。逐字比，一樣就不再貼。 */
  lastBrief?: string;
  /** 還在跑的呼叫，`notifications/cancelled` 按請求 id 找到它。 */
  readonly inflight = new Map<JsonRpcId, AbortController>();
  clientName = '';
  /** 客戶端在地址上指定的工程（`?project=`），每次請求按地址重新整理。 */
  project?: string;

  constructor(readonly id: string) {}

  /** 會話沒了：還在跑的一併中斷，不留一個沒人收結果的生成。 */
  close(): void {
    for (const ctrl of this.inflight.values()) {
      ctrl.abort();
    }
    this.inflight.clear();
  }
}

// ---------------------------------------------------------------- 服務

export class McpServer {
  constructor(private readonly opts: McpServerOptions) {}

  /**
   * 處理一條訊息。通知與客戶端回的響應返回 undefined（HTTP 那一層據此回 202）。
   * **絕不拋**：任何異常都變成一條 JSON-RPC 錯誤。
   */
  async dispatch(
    msg: JsonRpcMessage,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<JsonRpcResponse | undefined> {
    if (!msg || typeof msg !== 'object' || (msg.jsonrpc !== undefined && msg.jsonrpc !== '2.0')) {
      return rpcError(null, RPC.invalidRequest, '不是一條 JSON-RPC 2.0 訊息。');
    }
    if (typeof msg.method !== 'string') {
      // 客戶端回給我們的響應。我們從不發請求，收到了也無事可做。
      return undefined;
    }
    if (!isRequest(msg)) {
      this.notify(msg.method, msg.params ?? {}, session);
      return undefined;
    }
    const id = msg.id as JsonRpcId;
    try {
      return { jsonrpc: '2.0', id, result: await this.request(id, msg.method, msg.params ?? {}, session, signal) };
    } catch (err) {
      if (err instanceof RpcFailure) {
        return rpcError(id, err.code, err.message);
      }
      log.error(`處理 ${msg.method} 失敗：${describeError(err)}`, err);
      return rpcError(id, -32603, describeError(err));
    }
  }

  private notify(method: string, params: Record<string, unknown>, session: McpSession): void {
    if (method === 'notifications/cancelled') {
      const requestId = params.requestId as JsonRpcId | undefined;
      const ctrl = requestId === undefined ? undefined : session.inflight.get(requestId);
      if (ctrl) {
        log.info('客戶端取消了一次呼叫', `請求 ${String(requestId)}`);
        ctrl.abort();
      }
    }
    // notifications/initialized 之類：沒有要做的事。
  }

  private async request(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params, session);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.opts.tools.map(toMcpTool) };
      case 'tools/call':
        return this.callTool(id, params, session, signal);
      default:
        throw new RpcFailure(RPC.methodNotFound, `不支援 ${method}。`);
    }
  }

  private initialize(params: Record<string, unknown>, session: McpSession): unknown {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const client = params.clientInfo as { name?: unknown; version?: unknown } | undefined;
    session.clientName = typeof client?.name === 'string' ? client.name : '';
    log.info(`MCP 客戶端已連線${session.clientName ? `：${session.clientName}` : ''}`, `協議 ${asked || '（未宣告）'}`);
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'novelwarden', version: this.opts.version },
      instructions: this.opts.instructions,
    };
  }

  private async callTool(
    id: JsonRpcId,
    params: Record<string, unknown>,
    session: McpSession,
    signal?: AbortSignal
  ): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) {
      throw new RpcFailure(RPC.invalidParams, 'tools/call 缺 name。');
    }
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    const backend = this.opts.backend(session.project);
    if (!backend) {
      const text = session.project
        ? `Novelwarden 裡沒有開啟這個小說工程：${session.project}。請作者先在 Novelwarden 裡開啟它。`
        : 'Novelwarden 現在沒有開啟任何小說工程。請作者先在 Novelwarden 裡開啟一個工程。';
      return toCallResult({ text, isError: true });
    }

    // 兩條取消的路：客戶端發 `notifications/cancelled`，或者 HTTP 連線斷了。
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    if (signal?.aborted) {
      ctrl.abort();
    } else {
      signal?.addEventListener('abort', relay, { once: true });
    }
    session.inflight.set(id, ctrl);
    try {
      const result = await backend.call(name, args, ctrl.signal);
      return toCallResult({ ...result, text: await this.withBrief(result.text, backend, session) });
    } finally {
      session.inflight.delete(id);
      signal?.removeEventListener('abort', relay);
    }
  }

  /** 簡報變了才貼（見檔案頭）。取簡報本身失敗不連累這一次呼叫的結果。 */
  private async withBrief(text: string, backend: McpBackend, session: McpSession): Promise<string> {
    let brief: string;
    try {
      brief = await backend.brief();
    } catch (err) {
      log.warn('MCP 狀態簡報生成失敗', describeError(err));
      return text;
    }
    if (!brief || brief === session.lastBrief) {
      return text;
    }
    session.lastBrief = brief;
    return `${text}\n\n${brief}`;
  }
}

class RpcFailure extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function toCallResult(r: McpCallResult): unknown {
  return { content: [{ type: 'text', text: r.text }], isError: r.isError };
}

/**
 * `ToolSpec` → MCP 的一條工具宣告。`costly` / `mutating` 只是事實（見 `tools/types.ts`），
 * 落成規範裡的兩條提示：宿主據此決定要不要先問使用者。
 */
export function toMcpTool(spec: ToolSpec): unknown {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters,
    annotations: {
      readOnlyHint: !spec.costly && !spec.mutating,
      destructiveHint: !!spec.mutating,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}
