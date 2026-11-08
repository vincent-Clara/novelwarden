# 零期：事件流 provider Implementation Plan

> **接手須知：** 這份計劃面向新的 agent，假設你**沒有讀過**前面的對話。開工前必讀：
> 1. 根目錄 [AGENTS.md](../../../AGENTS.md) —— 23 條產品承諾，一條都不能破
> 2. 本期的設計依據 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L0 一節**
> 3. [src/core/llm/README.md](../../../src/core/llm/README.md)
>
> 每個 Task 按 `- [ ]` 逐步執行，做完立刻 commit。

**Goal:** 把 `LlmProvider` 的唯一原語從「吐字串的流」換成「吐事件的流」，讓它能收發工具呼叫。三個 provider 全部改完，13 個既有呼叫點行為逐位元組不變。

**Architecture:** 先定型別與 `collectText`（純新增，不動任何實現），再逐個 provider 改造並讓老介面消失，最後一次性把 13 個呼叫點遷過去。**不留 `chatStream` 的相容層**——同時存在兩條路是這類改造最容易腐爛的地方。

**Tech Stack:** TypeScript（`src/core/llm/`，零 vscode 依賴；vscode-lm 那份在 `src/shells/vscode/`）+ `node:test` + `npm run typecheck`。不新增依賴。

## Global Constraints

- **行為不變**：13 個既有呼叫點產出的文字、reasoning 分流、usage 合併口徑，一個位元組都不能變。本期唯一的驗收標準就是 `npm test` 全綠。
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js` 守著）。
- **日誌不記 prompt 全文、不記正文全文、不出現 API Key**（AGENTS.md 第 11 條）。新加的工具呼叫日誌只記工具名與引數的鍵名，**不記引數值**——引數值裡可能有正文片段。
- `args` 解析失敗**絕不拋**：發一個 `args: {}` 的 `toolCall`，由上層報錯。拋異常會炸掉整輪對話。
- 每個 Task 結束立刻 commit；字首 `refactor` / `feat` / `test`；中文正文。
- 不要同時留下 `chatStream` 與 `stream`。

---

## 目標態檔案結構

```
src/core/llm/
├── provider.ts        ★ 大改：StreamEvent / AgentMessage / ToolSpec / LlmProvider.stream
├── collect.ts         ★ 新增：collectText（原 collectStream 的位置）
├── openaiProvider.ts  ★ 改：SSE → StreamEvent，含 tool_calls 按 index 累積
├── anthropicProvider.ts ★ 改：同上，含 tool_use content block
├── registry.ts        不動
└── pool.ts            不動（它只轉發 provider，不碰訊息形狀）

src/shells/vscode/
└── vscodeLmProvider.ts ★ 改：LanguageModelToolCallPart
```

## 提交節奏（5 個 commit）

| # | 字首 | 主題 |
|---|---|---|
| 1 | `refactor` | 定義 StreamEvent / AgentMessage / ToolSpec 與 collectText |
| 2 | `refactor` | OpenAI provider 改事件流，支援 tool_calls |
| 3 | `refactor` | Anthropic provider 改事件流，支援 tool_use |
| 4 | `refactor` | vscode-lm provider 改事件流 |
| 5 | `refactor` | 13 個呼叫點遷到 collectText，刪掉 chatStream |

---

### Task 1: 定義事件流型別與 `collectText`

**Files:**
- Modify: `src/core/llm/provider.ts`
- Create: `src/core/llm/collect.ts`
- Create: `tests/unit/llm/collect.test.js`

**Interfaces:**

`provider.ts` 新增（`ChatMessage` / `chatStream` / `collectStream` **本 Task 先留著**，Task 5 才刪）：

```ts
/** 一次工具呼叫。args 已解析成物件；解析失敗時是空物件。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 引數原文。解析失敗時上層要把它回顯給模型看。 */
  raw: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object，原樣透傳給各家 API。 */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required';

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface StreamOptions {
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
}

export interface LlmProvider {
  readonly id: 'openai' | 'anthropic' | 'vscode-lm';
  readonly label: string;
  maxInputTokens(): Promise<number | undefined>;
  stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent>;
}
```

`collect.ts`：

```ts
export interface CollectHandlers {
  onDelta?(delta: string, full: string): void;
  onReasoning?(delta: string, full: string): void;
  onUsage?(usage: TokenUsage): void;
  onToolCall?(call: ToolCall): void;
}

export interface CollectResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
}

/** 收全流，按欄位合併 usage。既有呼叫點用它替代 collectStream。 */
export async function collect(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<CollectResult>;

/** 只要文字那一份。13 個既有呼叫點用這個。 */
export async function collectText(
  stream: AsyncIterable<StreamEvent>,
  handlers?: CollectHandlers
): Promise<string>;
```

**usage 合併口徑必須與現狀一致**：同一次請求可能回呼多次（Anthropic 在 `message_start` 給輸入、`message_delta` 給輸出），**按欄位合併，後到的覆蓋同名欄位，缺席的欄位保留**。照抄 `features/creation.ts:145-152` 與 `features/summarize.ts` 裡那段。

- [ ] **Step 1: 寫失敗測試** `tests/unit/llm/collect.test.js`

```js
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

async function* streamOf(events) { for (const e of events) yield e; }

describe('llm/collect', () => {
  let c;
  before(() => { c = loadModule('src/core/llm/collect.ts'); });

  test('collectText 只拼 text 事件', async () => {
    const text = await c.collectText(streamOf([
      { type: 'text', text: '雨下了' },
      { type: 'reasoning', text: '（先想想）' },
      { type: 'text', text: '三天。' },
    ]));
    assert.equal(text, '雨下了三天。');
  });

  test('reasoning 不混進正文，單獨回呼', async () => {
    const seen = [];
    await c.collectText(streamOf([
      { type: 'reasoning', text: 'a' },
      { type: 'text', text: 'X' },
      { type: 'reasoning', text: 'b' },
    ]), { onReasoning: (d, full) => seen.push([d, full]) });
    assert.deepEqual(seen, [['a', 'a'], ['b', 'ab']]);
  });

  test('usage 按欄位合併，缺席欄位保留', async () => {
    const r = await c.collect(streamOf([
      { type: 'usage', usage: { inputTokens: 100 } },
      { type: 'text', text: 'x' },
      { type: 'usage', usage: { outputTokens: 20 } },
    ]));
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('toolCall 收進陣列並回呼', async () => {
    const call = { id: 'c1', name: 'read', args: { path: 'a.md' }, raw: '{"path":"a.md"}' };
    const seen = [];
    const r = await c.collect(streamOf([{ type: 'toolCall', call }]), {
      onToolCall: (x) => seen.push(x.name),
    });
    assert.deepEqual(r.toolCalls, [call]);
    assert.deepEqual(seen, ['read']);
  });

  test('onDelta 收到增量與全量', async () => {
    const seen = [];
    await c.collectText(streamOf([
      { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    ]), { onDelta: (d, full) => seen.push([d, full]) });
    assert.deepEqual(seen, [['a', 'a'], ['b', 'ab']]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
node --test "tests/unit/llm/collect.test.js"
```

Expected: FAIL（模組不存在）

- [ ] **Step 3: 實現**

`provider.ts` 加上面那批型別（`LlmProvider` **暫時同時宣告 `chatStream` 與可選的 `stream?`**，讓三個 provider 能分 Task 遷移）。`collect.ts` 實現兩個函式。

- [ ] **Step 4: 跑測試**

```bash
node --test "tests/unit/llm/collect.test.js"
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/llm/provider.ts src/core/llm/collect.ts tests/unit/llm/collect.test.js
git commit -m "refactor(llm): 定義事件流型別與 collect

StreamEvent / AgentMessage / ToolSpec 就位，collectText 保持「傳一個流拿一段文字」的形狀。provider 實現下一步改。"
```

---

### Task 2: OpenAI provider 改事件流

**Files:**
- Modify: `src/core/llm/openaiProvider.ts`
- Create: `tests/unit/llm/openaiToolCalls.test.js`

**關鍵實現點（照抄這幾條，不要自己發揮）：**

1. **訊息轉換**。`AgentMessage[]` → OpenAI 的 `messages[]`：
   - `system` / `user` 原樣
   - `assistant` 帶 `toolCalls` 時輸出 `tool_calls: [{id, type:'function', function:{name, arguments: raw}}]`；`content` 為空串時給 `null`
   - `tool` → `{role:'tool', tool_call_id, content}`
2. **tools 透傳**：`tools: specs.map(s => ({type:'function', function:{name, description, parameters}}))`，`tool_choice` 直接給 `'auto'|'none'|'required'`。**沒有 tools 時這兩個欄位一律不帶**——有些相容實現見到未知欄位會直接 400（既有程式碼在 `stream_options` 上已經踩過這個坑，註釋就在那兒）。
3. **`tool_calls` 分片按 `index` 累積，不是按 `id`**：

```ts
// 每個 index 一個累積槽。id 只在第一片給，name 通常也只給一次。
const slots = new Map<number, { id: string; name: string; args: string }>();
// delta.tool_calls?.forEach(tc => {
//   const slot = slots.get(tc.index) ?? { id: '', name: '', args: '' };
//   if (tc.id) slot.id = tc.id;
//   if (tc.function?.name) slot.name = tc.function.name;
//   if (tc.function?.arguments) slot.args += tc.function.arguments;
//   slots.set(tc.index, slot);
// });
```

4. **流結束時**（`finish_reason === 'tool_calls'` 或流自然結束）把每個槽 yield 成一個 `toolCall` 事件。`JSON.parse(args)` 失敗時 **`args: {}`，`raw` 保留原文，不拋**。
5. `reasoning_content` / `reasoning` → `{type:'reasoning'}`；`delta.content` → `{type:'text'}`；`usage` → `{type:'usage'}`。三條與現狀逐位元組一致。
6. `stream_options: { include_usage: true }` 的條件從「呼叫方給了 onUsage」改成**恆開**——事件流裡 usage 是一等公民，沒有「呼叫方想不想聽」這回事。

- [ ] **Step 1: 寫失敗測試** `tests/unit/llm/openaiToolCalls.test.js`

測的是**純函式**，不髮網路請求。因此實現時要把兩段邏輯抽成可匯出的純函式：

```ts
export function toOpenAiMessages(messages: AgentMessage[]): unknown[];
export function accumulateToolCalls(chunks: OpenAiToolCallDelta[][]): ToolCall[];
```

用例至少覆蓋：

| 用例 | 斷言 |
|---|---|
| 單個工具呼叫分三片到達（id 只在第一片） | 拼出完整 `{id, name, args}` |
| 兩個並行工具呼叫（index 0 與 1 交錯） | 各自拼對，不串味 |
| `arguments` 是壞 JSON | `args` 為 `{}`，`raw` 保留原文，不拋 |
| `assistant` 帶 toolCalls 轉換 | `content: null`，`tool_calls` 形狀正確 |
| `tool` 訊息轉換 | `{role:'tool', tool_call_id, content}` |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現** —— `chatStream` 改名為 `stream`，簽名換成 `(AgentMessage[], StreamOptions) => AsyncIterable<StreamEvent>`
- [ ] **Step 4: 跑測試**

```bash
node --test "tests/unit/llm/*.test.js"
npm run typecheck
node --test "tests/integration/llm/streaming.test.js"
```

`streaming.test.js` 這一輪會紅（它還在調 `chatStream`），**這是預期的**——Task 5 一起修。在 commit message 裡寫明。

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(llm): OpenAI provider 改事件流，支援 tool_calls

分片按 index 累積不是按 id——id 只在第一片給。壞 JSON 不拋，發一個 args 為空的 toolCall 讓上層去報。
integration/llm/streaming.test.js 暫紅，等呼叫點一起遷。"
```

---

### Task 3: Anthropic provider 改事件流

**Files:**
- Modify: `src/core/llm/anthropicProvider.ts`
- Create: `tests/unit/llm/anthropicToolUse.test.js`

**關鍵實現點：**

1. **`tool_result` 不是獨立 role**。Anthropic 把它放在 `user` 訊息的 content block 裡：

```json
{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"…"}]}
```

所以 `AgentMessage[]` → Anthropic messages 的轉換比 OpenAI 複雜：連續的 `tool` 訊息要合併進**一條** `user` 訊息的 content 陣列。

2. **`assistant` 帶 toolCalls** 輸出成 content block 陣列：

```json
{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"tool_use","id":"…","name":"…","input":{…}}]}
```

`text` 為空時不要放空的 text block（會 400）。

3. **工具呼叫分三個事件到達**：
   - `content_block_start` → `content_block.type === 'tool_use'`，帶 `id` / `name`，`input` 是 `{}`
   - `content_block_delta` → `delta.type === 'input_json_delta'`，`partial_json` 是**逐字元拼的 JSON 串**
   - `content_block_stop` → 這一塊完了，此時才 `JSON.parse` 並 yield `toolCall`

   按 `event.index` 累積（與 OpenAI 一樣，多個並行呼叫各佔一個 index）。

4. `mergeConsecutive` 那條「首條必須是 user、相鄰同角色合併」的既有邏輯**要保留**，但現在 content 可能是陣列，合併規則改成：相鄰同角色時把 content 陣列接起來（字串先包成 `[{type:'text',text}]`）。
5. `tools` 透傳：`tools: specs.map(s => ({name, description, input_schema: parameters}))`。**欄位名是 `input_schema` 不是 `parameters`。** `tool_choice`: `auto` → `{type:'auto'}`，`required` → `{type:'any'}`，`none` → 不帶 tools。
6. `text_delta` → `text`；`thinking_delta` → `reasoning`；兩處 usage → `usage`。與現狀逐位元組一致。

- [ ] **Step 1: 寫失敗測試** `tests/unit/llm/anthropicToolUse.test.js`

同樣抽純函式來測：

```ts
export function toAnthropicMessages(messages: AgentMessage[]): unknown[];
export function accumulateToolUse(events: AnthropicEvent[]): ToolCall[];
```

用例至少覆蓋：

| 用例 | 斷言 |
|---|---|
| `input_json_delta` 逐字元拼 | `content_block_stop` 後 yield 出完整 args |
| 兩個並行 tool_use（index 0 與 1） | 各自拼對 |
| 壞 JSON | `args: {}`，`raw` 保留 |
| 連續三條 `tool` 訊息 | 合併成**一條** user，content 裡三個 tool_result |
| `assistant` 空 text + toolCalls | content 裡沒有空 text block |
| 首條不是 user | 前面補一條 `（繼續）` |

- [ ] **Step 2: 跑測試確認失敗**
- [ ] **Step 3: 實現**
- [ ] **Step 4: 跑測試**
- [ ] **Step 5: Commit**

---

### Task 4: vscode-lm provider 改事件流

**Files:**
- Modify: `src/shells/vscode/vscodeLmProvider.ts`

**關鍵實現點：**

1. `sendRequest(msgs, { tools, toolMode }, token)`。`vscode.LanguageModelChatTool` 的欄位是 `{name, description, inputSchema}`。
2. 響應流用 `response.stream`（不是 `response.text`），逐個判斷 part 型別：
   - `vscode.LanguageModelTextPart` → `{type:'text'}`
   - `vscode.LanguageModelToolCallPart` → `{type:'toolCall'}`，**`input` 已經是解析好的物件**，不用累積；`raw` 填 `JSON.stringify(part.input)`
3. `tool` 訊息 → `vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(content)])])`
4. `assistant` 帶 toolCalls → `LanguageModelChatMessage.Assistant([...text, ...new LanguageModelToolCallPart(id, name, args)])`
5. **系統提示並進首條 user 的既有邏輯保留**（`toLmMessages`）——那是這個 provider 的特點，不是缺陷。
6. vscode-lm 不給 usage，不發 `usage` 事件（現狀也沒有）。

**注意**：這個檔案在 `src/shells/vscode/` 下，可以 import `vscode`；但它 import 的型別來自 `core/llm/provider`，方向是對的。

- [ ] **Step 1: 實現**（這一份沒有單元測試——它需要真實的 `vscode` 名稱空間。靠 `npm run typecheck` 與手動 F5 驗證）
- [ ] **Step 2: 驗證**

```bash
npm run typecheck
npm run compile
```

然後 F5 起 Extension Development Host，用一個 Copilot 模型跑一次普通續寫，確認文字照常流出來。

- [ ] **Step 3: Commit**

---

### Task 5: 13 個呼叫點遷移，刪掉 `chatStream`

**Files:**
- Modify: `src/core/llm/provider.ts`（刪 `ChatMessage` / `chatStream` / `collectStream`；`ChatOptions` 的 `onReasoning` / `onUsage` 一併刪掉）
- Modify: `src/core/features/creation.ts`（2 處）
- Modify: `src/core/features/summarize.ts`（3 處）
- Modify: `src/core/features/pipelineBatch.ts`（3 處）
- Modify: `src/core/features/characterCard.ts`（1 處）
- Modify: `src/core/features/characters.ts`（1 處）
- Modify: `src/core/features/lore.ts`（2 處）
- Modify: `src/core/features/style.ts`（1 處）
- Modify: `tests/integration/llm/streaming.test.js`
- Modify: `src/core/llm/README.md`

**遷移模式**（三種形狀，逐個對號入座）：

```ts
// ── 形狀 A：collectStream + 無回呼（summarize / lore / style / characters / characterCard）
const raw = await collectStream(llm.chatStream(messages, options));
// ↓
const raw = await collectText(llm.stream(messages, options));

// ── 形狀 B：collectStream + onUsage 在 options 裡（pipelineBatch）
const raw = await collectStream(llm.chatStream(messages, { …, onUsage: (u) => merge(u) }));
// ↓
const raw = await collectText(llm.stream(messages, { … }), { onUsage: (u) => merge(u) });

// ── 形狀 C：手寫 for-await（creation.ts:164 與 :479）
for await (const delta of provider.chatStream(built.messages, options)) { full += delta; handlers.onDelta(delta, full); }
// ↓
for await (const ev of provider.stream(built.messages, options)) {
  if (ev.type === 'text') { full += ev.text; handlers.onDelta(ev.text, full); }
  else if (ev.type === 'reasoning') { reasoning += ev.text; handlers.onReasoning?.(ev.text, reasoning); }
  else if (ev.type === 'usage') { mergeUsage(usage, ev.usage); }
}
```

`creation.ts` 的 `testConnection`（:479）是形狀 C 的簡化版：拿到任何 `text` 事件就 break。

**`ChatMessage` → `AgentMessage`**：13 處傳的都是 `{role:'system'|'user'|'assistant', content}`，結構上已經是合法的 `AgentMessage`，**只需要改 import 的型別名**。`buildContext` 返回的 `BuiltContext.messages` 型別也跟著改（`context/types.ts` 與 `context/builder.ts` 各一處）。

**usage 合併要抽成一個共享函式**：現在 `creation.ts` 與 `pipelineBatch.ts` 各寫了一遍同樣的 `if (u.inputTokens !== undefined) …`。搬進 `collect.ts` 匯出 `mergeUsage(target, patch)`。

- [ ] **Step 1: 改 `provider.ts`，刪掉老介面**

`LlmProvider` 上 `stream` 從可選改成必需，`chatStream` 刪掉。此時全專案編譯不過——這是預期的，下一步逐個修。

- [ ] **Step 2: 逐檔案遷移**

順序建議：`context/types.ts` → `context/builder.ts` → `features/creation.ts` → 其餘六個 feature。每改完一個跑一次 `npm run typecheck` 看剩餘錯誤在縮小。

- [ ] **Step 3: 修整合測試**

`tests/integration/llm/streaming.test.js` 現在調 `providerMod.collectStream(openai.chatStream(...))`。改成 `collectText(openai.stream(...))`，並**補兩條新用例**：

| 用例 | 斷言 |
|---|---|
| 假 SSE 裡帶 `tool_calls` 分片 | 收到一個 `toolCall` 事件，args 拼對 |
| 假 SSE 裡 `tool_calls` 的 arguments 是壞 JSON | `args` 為 `{}`，不拋 |

- [ ] **Step 4: 全量驗證**

```bash
npm run typecheck
npm test
```

Expected: 全綠。**這是本期唯一的驗收標準**——13 個呼叫點的行為必須逐位元組不變。

- [ ] **Step 5: 更新 `src/core/llm/README.md`**

至少寫清三件事：`StreamEvent` 是唯一原語；三家的工具呼叫分片累積各有什麼坑（OpenAI 按 index、Anthropic 按 content block、vscode-lm 不用累積）；壞 JSON 不拋的理由。

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(llm): 13 個呼叫點遷到 collectText，刪掉 chatStream

不留相容層：同時存在兩條路是這類改造最容易腐爛的地方。行為逐位元組不變，npm test 全綠是本期唯一的驗收標準。"
```

---

## 本期不做

- **不接 agent**。這一期結束時專案裡沒有任何一處**用**工具呼叫，只是**能**用。
- **不改 `pool.ts`**。它只轉發 provider，不碰訊息形狀。
- **不加 `supportsTools` 欄位**。那是三期的事（agent 模型選擇器要用），這一期加了沒人讀。
- **不改設定頁**。

## 給接手 agent 的提示詞

> 你在 novelwarden 倉庫裡執行「零期：事件流 provider」。
>
> 先讀 `AGENTS.md`（23 條產品承諾）與 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L0 一節，再讀 `src/core/llm/` 下的四個檔案與 `src/shells/vscode/vscodeLmProvider.ts`。
>
> 這一期**沒有新功能**，全部是重構。唯一的驗收標準是 `npm test` 全綠——13 個既有呼叫點（摘要、角色卡、設定、文風、批次流水線、創作、連線測試）產出的文字、reasoning 分流、usage 合併口徑，一個位元組都不能變。
>
> 按 `docs/design/plans/2026-08-15-agent-phase0-provider-events.md` 的 5 個 Task 逐個做，每個 Task 做完立刻 commit（字首 `refactor(llm)`，中文正文，**不要加 Co-Authored-By 或 Generated with 標記**）。
>
> 三件最容易做錯的事：
> 1. OpenAI 的 `tool_calls` 分片**按 `index` 累積，不是按 `id`**——`id` 只在第一片給。
> 2. Anthropic 的 `tool_result` **不是獨立 role**，要合併進一條 `user` 訊息的 content 陣列。
> 3. `JSON.parse(args)` 失敗**絕不拋**——發一個 `args: {}` 的 toolCall，`raw` 保留原文。拋異常會炸掉整輪對話。
>
> 遇到「這裡要不要順手改一下」的念頭時：不要。這一期只搬管道。
