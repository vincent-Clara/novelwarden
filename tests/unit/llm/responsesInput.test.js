/**
 * OpenAI Responses provider 的兩段純邏輯：訊息轉換與事件解析。
 *
 * 訊息轉換那半邊釘的是與老的 `/chat/completions` 不同的那一處：**system 走
 * `instructions`**，不留在 input 裡。
 *
 * 事件解析那半邊的硬約束是「認不出的型別一律忽略」：這條協議有二十來種
 * 事件，為未知型別報錯等於上游加一個新事件就炸掉整輪生成。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/openaiProvider · 訊息轉換', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  test('system 合併進 instructions，不留在 input 裡', () => {
    const out = m.toResponsesInput([
      { role: 'system', content: '你是作者' },
      { role: 'system', content: '別寫畫面' },
      { role: 'user', content: '續寫' },
    ]);
    assert.equal(out.instructions, '你是作者\n\n別寫畫面');
    assert.deepEqual(out.input, [{ role: 'user', content: '續寫' }]);
  });

  test('assistant 是一條普通訊息', () => {
    const out = m.toResponsesInput([{ role: 'assistant', content: '上一版' }]);
    assert.deepEqual(out.input, [{ role: 'assistant', content: '上一版' }]);
  });

  test('assistant 空內容時不放空訊息', () => {
    const out = m.toResponsesInput([{ role: 'assistant', content: '' }]);
    assert.deepEqual(out.input, []);
  });
});

describe('llm/openaiProvider · 事件解析', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/openaiProvider.ts');
  });

  const read = (event) => m.readResponsesEvent(event, 'test-model @ 127.0.0.1');

  test('正文增量', () => {
    assert.deepEqual(read({ type: 'response.output_text.delta', delta: '雨' }), [
      { type: 'text', text: '雨' },
    ]);
  });

  test('思考摘要與推理正文都走 reasoning 事件', () => {
    assert.deepEqual(read({ type: 'response.reasoning_summary_text.delta', delta: '在想' }), [
      { type: 'reasoning', text: '在想' },
    ]);
    assert.deepEqual(read({ type: 'response.reasoning_text.delta', delta: '再想' }), [
      { type: 'reasoning', text: '再想' },
    ]);
  });

  test('completed 帶用量，報正常收尾', () => {
    assert.deepEqual(
      read({
        type: 'response.completed',
        response: { usage: { input_tokens: 12, output_tokens: 3 } },
      }),
      [
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
        // 續寫鏈要分清「模型自己收了尾」與「閘道器沒說」，completed 必須報 end。
        { type: 'stop', reason: 'end' },
      ]
    );
  });

  test('incomplete 報截斷；completed 裡寫著 incomplete 的也按截斷算', () => {
    assert.deepEqual(read({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }), [
      { type: 'stop', reason: 'maxTokens' },
    ]);
    assert.deepEqual(read({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }), [
      { type: 'stop', reason: 'other' },
    ]);
    assert.deepEqual(
      read({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
      [{ type: 'stop', reason: 'maxTokens' }]
    );
  });

  test('incomplete 也要把用量交出來', () => {
    const [ev] = read({
      type: 'response.incomplete',
      response: { usage: { input_tokens: 9 } },
    });
    assert.deepEqual(ev.usage, { inputTokens: 9, outputTokens: undefined });
  });

  test('failed 與 error 拋 LlmError，且帶上游原文', () => {
    assert.throws(
      () => read({ type: 'response.failed', response: { error: { message: '上游過載' } } }),
      (e) => e.name === 'LlmError' && e.message.includes('上游過載')
    );
    assert.throws(
      () => read({ type: 'error', error: { message: '金鑰無效' } }),
      (e) => e.name === 'LlmError' && e.message.includes('金鑰無效')
    );
  });

  test('認不出的事件型別一律忽略', () => {
    assert.deepEqual(read({ type: 'response.output_item.added', item: { type: 'message' } }), []);
    assert.deepEqual(read({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } }), []);
    assert.deepEqual(read({ type: 'response.content_part.done' }), []);
    assert.deepEqual(read({}), []);
  });
});
