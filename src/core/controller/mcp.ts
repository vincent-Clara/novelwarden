/**
 * MCP 的執行端：**外部 agent 的一次工具呼叫，落到當前開啟的這個工程上。**
 *
 * 協議在 [mcp/server.ts](../mcp/server.ts)，它只認 {@link McpBackend}。這裡把那兩個方法綁到
 * 一個 `ChatController` 上。每次呼叫各自做完，沒有迴圈：
 *
 * | 呼叫的性質（工具自報的 `gate`） | 這裡做什麼 |
 * |---|---|
 * | `auto`（list / read / search、查技能） | 直接跑，只進日誌。不佔生成位、不進對話頁 |
 * | 其餘（generate / write / edit / run） | 佔生成位、走 `runTask`（看得見、能停），在對話頁掛一條工具條 |
 * | `always`（edit、裝/綁技能、改技能檔案） | 另外**先在對話頁問作者一句**（[gate.ts](gate.ts)） |
 * | 產出了草稿（generate） | **當場問一句寫不寫**（第 19 條），結論接在返回後面 |
 *
 * 宿主（Claude Code 之類）自己還有一層「要不要讓它調這個工具」的許可權；那一層管的是
 * 「讓不讓調」，這裡的兩問管的是「下游沒有 diff 的改動」與「產物落盤」——第 19 / 25 條的
 * 承諾不交給宿主的配置。覆蓋已有內容走 workspace 的覆蓋審閱，與這裡無關，任何路徑都在。
 *
 * ## 對話頁上的樣子
 *
 * 外部 agent 的呼叫掛在當前會話裡一個標著 MCP 的氣泡上，連著幾次呼叫接在同一個氣泡裡，
 * 作者在中間說了話就另起一個。正文照舊流進那一條工具條下的卡片（`toolDelta`），**不回給
 * 外部 agent**：它拿到的只有形狀與 draftId（`tools/novel/generate.ts`）。
 */
import type { ChatController } from './index';
import type { McpBackend, McpCallResult } from '../mcp/server';
import { createNovelTools } from '../tools/novel';
import type { ToolIntent, ToolRun } from '../tools/types';
import { buildStateBrief } from '../views/stateBrief';
import { runTask } from '../runtime/progress';
import { describeError, scoped } from '../runtime/logger';
import { ChatTurn, TurnToolCall, makeTurnId, nowIso } from '../model/session';
import { askArtifact, describeArtifactOf, pushPipeline } from './chat';
import { askGate } from './gate';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('MCP');

/** 引數那一段的上限。路徑與查詢詞都短，幾百字夠看，一大段內嵌文字沒必要全留。 */
const ARGS_LIMIT = 800;
/** 返回那一段的上限。工具按契約本就回短文字，這道閘只防寫壞了的那一個。 */
const RESULT_LIMIT = 2000;
/**
 * `generate` 產出的正文上限。這是**產物本身**（一章三千字、一份大綱六千字），截短了那張卡
 * 就沒意義了；仍然要有個頭：它隨會話落盤。
 */
const OUTPUT_LIMIT = 20000;

/** 把這個工程端給 MCP。**每次呼叫現取**當前會話：作者可能在中途換了會話。 */
export function createMcpBackend(c: ChatController): McpBackend {
  return {
    brief: () => buildStateBrief(c.project, c.current.target),
    call: (name, args, signal) => callTool(c, name, args, signal),
  };
}

async function callTool(
  c: ChatController,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpCallResult> {
  const session = c.current;
  const tools = createNovelTools({
    project: c.project,
    workspace: c.workspace,
    drafts: c.drafts,
    sessionId: session.id,
  });
  const intent = tools.intent(name, args);

  // 查詢：不花錢不改東西，掛上對話頁只會把作者要看的那幾條淹掉。認不出的名字也走這條——
  // 登錄檔會回一句「沒有叫 X 的工具，可用的是…」。
  if (!intent || intent.gate === 'auto') {
    const r = await tools.invoke(name, args, quietRun(signal));
    return { text: r.text, isError: !r.ok };
  }

  // 引數本來就不對的呼叫當場回話：不佔鎖、不掛氣泡，更不在對話頁問一句「改「」裡的一段文字」。
  const issue = tools.check(name, args);
  if (issue) {
    return { text: issue, isError: true };
  }

  // 與對話頁的單步創作共用同一把鎖：兩條路同時跑會讓草稿與流式內容互相蓋。
  const lease = c.beginGeneration();
  if (!lease) {
    return {
      text: 'Novelwarden 的對話頁里正在跑另一個生成任務。等它結束再試，或者請作者先停掉它。',
      isError: true,
    };
  }
  const relay = () => lease.abort();
  if (signal.aborted) {
    relay();
  } else {
    signal.addEventListener('abort', relay, { once: true });
  }
  c.post({ type: 'busy', value: true });

  const turn = openTurn(c);
  const row: TurnToolCall = {
    callId: makeTurnId(),
    name,
    title: intent.title,
    ok: false,
    summary: '進行中…',
    elapsedMs: 0,
    argsText: describeArgs(args),
  };
  turn.segments = [...(turn.segments ?? []), { kind: 'tool', call: row }];
  c.post({
    type: 'toolCall',
    turnId: turn.id,
    callId: row.callId,
    name,
    title: row.title,
    detail: intent.detail,
    argsText: row.argsText,
  });

  try {
    return await runTask(
      'MCP',
      async (task) => {
        // 進度條上的「停止」與對話頁的「停止」是同一件事。
        if (task.signal.aborted) {
          relay();
        } else {
          task.signal.addEventListener('abort', relay, { once: true });
        }
        task.report({ message: intent.title });

        if (intent.gate === 'always') {
          const declined = await askFirst(c, turn.id, row, intent, lease.signal);
          if (declined) {
            settleRow(c, turn.id, row, { ok: true, summary: '作者沒有同意', elapsedMs: 0, text: declined });
            return { text: declined, isError: false };
          }
        }

        const r = await tools.invoke(name, args, {
          signal: lease.signal,
          report: (message) => c.toast(message),
          onDelta: (delta) => {
            row.output = (row.output ?? '') + delta;
            c.post({ type: 'toolDelta', turnId: turn.id, callId: row.callId, text: delta });
          },
          usage: { record: (calls) => log.info(`${name} 調了 ${calls} 次模型`) },
        });
        settleRow(c, turn.id, row, {
          ok: r.ok,
          summary: r.error ?? r.display?.detail ?? firstLine(r.text),
          elapsedMs: r.elapsedMs,
          text: r.text,
        });

        // 產出了東西就當場問一句寫不寫（第 19 條）。結論要回給外部 agent：不說的話它不知道
        // 那份產物落沒落盤，下一步多半是再生成一遍。
        const note = r.draftIds.length > 0 ? await adopt(c, turn.id, row, r.draftIds, lease.signal) : '';
        return { text: note ? `${r.text}\n\n${note}` : r.text, isError: !r.ok };
      },
      { scope: 'MCP' }
    );
  } catch (err) {
    const message = describeError(err);
    log.warn(`MCP 呼叫 ${name} 失敗`, message);
    settleRow(c, turn.id, row, { ok: false, summary: message, elapsedMs: 0, text: message });
    return { text: `執行失敗：${message}`, isError: true };
  } finally {
    signal.removeEventListener('abort', relay);
    if (row.output) {
      row.output = clip(row.output, OUTPUT_LIMIT);
    }
    lease.release();
    c.post({ type: 'busy', value: false });
    c.post({ type: 'turnDone', turn: serializeTurn(turn) });
    await persist(c);
    // write / edit / run 會真的改磁碟，流水線必須刷。
    await pushPipeline(c);
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
}

/** 查詢那一條路的 `ToolRun`：沒人看，說的話進日誌。 */
function quietRun(signal: AbortSignal): ToolRun {
  return {
    signal,
    report: (message) => log.debug(message),
    usage: { record: () => undefined },
  };
}

/**
 * 這次呼叫掛在哪個氣泡上：會話最後一輪就是 MCP 的氣泡就接著用，否則另起一個。
 * 作者在中間說過話，那就是另一段事了。
 */
function openTurn(c: ChatController): ChatTurn {
  const turns = c.current.turns;
  const last = turns[turns.length - 1];
  if (last?.role === 'assistant' && last.mcp) {
    return last;
  }
  const turn: ChatTurn = { id: makeTurnId(), role: 'assistant', content: '', at: nowIso(), mcp: true };
  turns.push(turn);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  return turn;
}

/**
 * `always` 那一檔：動手前先問。同意返回 undefined，否則返回回給外部 agent 的那句話。
 *
 * **必須有資訊量**：只回一句「被拒絕」，它多半會把同一個動作再發一遍。
 */
async function askFirst(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  intent: ToolIntent,
  signal: AbortSignal
): Promise<string | undefined> {
  const verdict = await askGate(
    c,
    {
      turnId,
      callId: row.callId,
      name: row.name,
      title: `Agent 要${intent.title}`,
      detail: intent.detail,
      argsText: row.argsText,
    },
    signal
  );
  if (verdict === 'proceed') {
    return undefined;
  }
  log.info(`作者${verdict === 'skip' ? '跳過了' : '沒有回答'} ${row.name}`, intent.title);
  return verdict === 'skip'
    ? `作者跳過了這一步（${intent.title}），它沒有執行，磁碟上什麼都沒變。**不要重試同一個動作**——換個做法，或者問問他想怎麼做。`
    : `這一步（${intent.title}）被取消了，沒有執行。不要再發起新的動作，把已經做到哪、還差什麼說清楚就行。`;
}

/** 產出的草稿：當場問一句寫不寫。返回接在工具結果後面的那句話。 */
async function adopt(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  draftIds: string[],
  signal: AbortSignal
): Promise<string> {
  const draftId = draftIds[draftIds.length - 1];
  const draft = c.drafts.get(draftId);
  const art = draft?.artifact ? await describeArtifactOf(c, draft.raw, draft) : undefined;
  if (!draft || !art) {
    // 解析不出可落盤的形狀（討論類的產出）：沒什麼可寫的，不問。
    return '';
  }
  c.current.drafts = c.drafts.bySession(c.current.id);
  const r = await askArtifact(c, {
    turnId,
    draft,
    art,
    byAgent: true,
    callId: row.callId,
    // **不開啟檔案**：外部 agent 可能連著寫好幾份，一次次搶編輯器。
    open: false,
    signal,
  });
  // 決定記在那條工具條上，隨會話留住——翻回來看得出「這一份我當時沒要」。
  row.summary = `${row.summary} · ${r.relPath ? `已寫入 ${r.relPath}` : '未採納'}`;
  postRow(c, turnId, row);
  return r.relPath
    ? `${r.message}這份產物已經落盤，**不要再寫一遍**。`
    : `${r.message}**不要重複生成同一份**——問問作者要改什麼。`;
}

function settleRow(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  r: { ok: boolean; summary: string; elapsedMs: number; text: string }
): void {
  row.ok = r.ok;
  row.summary = r.summary;
  row.elapsedMs = r.elapsedMs;
  row.resultText = r.text ? clip(r.text, RESULT_LIMIT) : undefined;
  postRow(c, turnId, row);
}

function postRow(c: ChatController, turnId: string, row: TurnToolCall): void {
  c.post({
    type: 'toolResult',
    turnId,
    callId: row.callId,
    name: row.name,
    ok: row.ok,
    summary: row.summary,
    elapsedMs: row.elapsedMs,
    argsText: row.argsText,
    resultText: row.resultText,
  });
}

/** 截一段給介面看的文字。**說出自己截了**（第 2 條：不靜默截斷）。 */
function clip(text: string, limit: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…（還有 ${trimmed.length - limit} 字，已截斷）`;
}

function describeArgs(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length === 0) {
    return undefined;
  }
  try {
    return clip(JSON.stringify(args, null, 2), ARGS_LIMIT);
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}
