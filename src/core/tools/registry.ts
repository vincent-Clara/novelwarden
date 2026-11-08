/**
 * 工具登錄檔：**一組 `ToolDef` + 一份環境 = 一個能被呼叫的工具集**。
 *
 * 它是 {@link ToolInvoker} 的實現，也是這一層唯一的執行入口。四件事：
 *
 * 1. **註冊時校驗**（[schema.ts](schema.ts)）——描述寫歪了當場拋，不留到線上；
 * 2. **`ToolDef[]` → `ToolSpec[]`**，透傳給各家 API；
 * 3. **執行時兜住一切**——認不出的名字、工具拋的異常，都變成一條模型讀得懂的
 *    結果。**`invoke` 絕不拋**：一個工具炸掉不該帶走整輪對話；
 * 4. **記一條日誌**——工具名與**引數的鍵名**，不記值（第 11 條：值裡可能有
 *    整段正文）。
 *
 * ## 為什麼執行也在這一層
 *
 * 從前「跑一個工具」那三十行住在 agent 的迴圈裡：計時、兜異常、翻 draft store
 * 認新草稿、拼「沒有叫 X 的工具」那句話。它們沒有一件是**排程**——換一個呼叫
 * 方（另一個迴圈、將來的 MCP server）就得原樣再抄一遍，而抄漏一條（比如沒兜住
 * 異常）不會紅，只會在某天讓一整輪對話炸掉。
 *
 * 所以呼叫方那邊只剩一行 `await tools.invoke(...)`。
 */
import { describeError, scoped } from '../runtime/logger';
import { checkArgs, validateToolDef } from './schema';
import type {
  ToolDef,
  ToolEnv,
  ToolIntent,
  ToolInvocation,
  ToolInvoker,
  ToolResult,
  ToolRun,
  ToolSpec,
} from './types';

// 日誌來源按作者看到的入口叫：工具現在只經 MCP 端給外部 agent，同一次呼叫在日誌頁上歸在一處。
const log = scoped('MCP');

export class ToolRegistry implements ToolInvoker {
  private readonly defs: ToolDef[];
  private readonly byName: Map<string, ToolDef>;

  /**
   * @param defs 順序即模型看到的順序。
   * @param env 工程那一面，繫結一次此後不變。
   */
  constructor(defs: ToolDef[], private readonly env: ToolEnv) {
    const seen = new Set<string>();
    for (const def of defs) {
      const issue = validateToolDef(def, seen);
      if (issue) {
        throw new Error(`工具「${def.name || '(無名)'}」定義有問題：${issue}`);
      }
      seen.add(def.name);
    }
    this.defs = [...defs];
    this.byName = new Map(this.defs.map((d) => [d.name, d]));
  }

  specs(): ToolSpec[] {
    // run / intent 是本地函式，序列化出去會炸，所以逐欄位挑而不是整個塞過去。
    return this.defs.map(specOf);
  }

  names(): string[] {
    return this.defs.map((d) => d.name);
  }

  /**
   * 這一步的意圖。工具沒實現 `intent` 時兜一個通用的：**花錢或寫盤就歸
   * `mutating`**（寧可多問，也不要有一條沒人想過的路）。
   */
  intent(name: string, args: Record<string, unknown>): ToolIntent | undefined {
    const def = this.byName.get(name);
    if (!def) {
      return undefined;
    }
    if (def.intent) {
      return def.intent(args ?? {}, this.env.project);
    }
    return {
      gate: def.mutating || def.costly ? 'mutating' : 'auto',
      title: `執行 ${def.name}`,
    };
  }

  /** 工具自己的 `check` 先說（話更貼切），它放過了再按 `parameters` 過一遍通用校驗。 */
  check(name: string, args: Record<string, unknown>): string | undefined {
    const def = this.byName.get(name);
    if (!def) {
      return undefined;
    }
    return def.check?.(args ?? {}) ?? checkArgs(def.parameters, args ?? {});
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    run: ToolRun
  ): Promise<ToolInvocation> {
    const startedAt = Date.now();
    // 第 11 條：**只記工具名與引數的鍵名**，不記值——值裡可能有正文片段。
    log.debug(`呼叫工具 ${name}`, `引數鍵：${Object.keys(args ?? {}).join(', ') || '（無）'}`);

    const def = this.byName.get(name);
    if (!def) {
      // 名單從**實際註冊的那一份**來。寫死一串名字，加了工具之後這句話就在撒謊。
      const error = `沒有叫 ${name} 的工具。可用的是：${this.names().join(' / ')}。`;
      return { ok: false, text: error, error, draftIds: [], elapsedMs: 0 };
    }

    const issue = this.check(name, args);
    if (issue) {
      return { ok: false, text: issue, error: issue, draftIds: [], elapsedMs: 0 };
    }

    let result: ToolResult;
    try {
      result = await def.run({ ...this.env, ...run }, args ?? {});
    } catch (err) {
      // 工具拋異常時變成 error 回給模型：它看到說明會換條路，而拋出去的話
      // 呼叫方只得到一句「處理訊息時出錯」，之前幾步的成果全丟。
      result = { text: '', error: `工具執行失敗：${describeError(err)}` };
      log.warn(`工具 ${name} 拋異常`, describeError(err));
    }

    return {
      ok: !result.error,
      text: result.error ?? result.text,
      error: result.error,
      display: result.display,
      draftIds: result.draftIds ?? [],
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** `ToolDef` → 對外的那一條宣告。不綁環境也算得出來：MCP 沒開啟工程時 `tools/list` 照樣要回。 */
export function specOf(d: ToolDef): ToolSpec {
  return {
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    ...(d.costly ? { costly: true } : {}),
    ...(d.mutating ? { mutating: true } : {}),
  };
}
