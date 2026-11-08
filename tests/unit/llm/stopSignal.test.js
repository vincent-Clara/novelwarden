/**
 * Anthropic 的收尾原因（`stop_reason`）→ `StopSignal`。
 *
 * 續寫鏈靠它分清「模型自己收了尾」與「被輸出上限截斷」，所以：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 說完了 | `stop: end` |
 * | 截斷 | `stop: maxTokens` |
 * | 認不出的值 | `stop: other` |
 * | 上游不發這一條 | 一個 stop 都不交（`undefined` 有它自己的意思） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

/** 一段 SSE 文字 → 一個假的 fetch。 */
function fakeFetch(sse) {
  return async () =>
    new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
}

const line = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

const START = line({
  type: 'message_start',
  message: { type: 'message', role: 'assistant', id: 'x', usage: { input_tokens: 2746 }, content: [] },
});
const STOP = (reason) =>
  line({ type: 'message_delta', usage: { output_tokens: 38 }, delta: { stop_reason: reason } }) +
  line({ type: 'message_stop' });

const ENDED =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '他說過。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  STOP('end_turn');

/** 壓根不發 `message_delta` 的相容實現。 */
const SILENT =
  START +
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的。' } }) +
  line({ type: 'content_block_stop', index: 0 }) +
  line({ type: 'message_stop' });

describe('llm/anthropicProvider · 收尾原因', () => {
  let m;
  let real;

  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
    real = globalThis.fetch;
  });

  /** 收全流，只留事件型別與要斷言的那幾個欄位。 */
  async function events(sse) {
    globalThis.fetch = fakeFetch(sse);
    try {
      const p = new m.AnthropicProvider('https://例子', '假模型', 'k');
      const out = [];
      for await (const ev of p.stream([{ role: 'user', content: '看看' }], {
        maxOutputTokens: 4096,
        temperature: 0.8,
        timeoutMs: 5000,
      })) {
        out.push(ev);
      }
      return out;
    } finally {
      globalThis.fetch = real;
    }
  }

  const stops = (evs) => evs.filter((e) => e.type === 'stop').map((e) => e.reason);

  test('說完了就是 end', async () => {
    assert.deepEqual(stops(await events(ENDED)), ['end']);
  });

  // undefined 有它自己的意思：「上游沒說」。補一個預設值等於替它編一句話。
  test('上游不發這一條時一個 stop 都不交', async () => {
    assert.deepEqual(stops(await events(SILENT)), []);
  });

  // 這個欄位上游還在加值（pause_turn、refusal）。認不出的報錯會讓續寫鏈因為一個
  // 不認識的字串就斷掉。
  test('認不出的收尾原因歸到 other', async () => {
    assert.deepEqual(stops(await events(START + STOP('pause_turn'))), ['other']);
  });

  test('截斷歸到 maxTokens', async () => {
    assert.deepEqual(stops(await events(START + STOP('max_tokens'))), ['maxTokens']);
  });
});
