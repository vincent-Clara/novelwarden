/**
 * Anthropic provider 的訊息轉換。
 *
 * 與 OpenAI 不同的硬約束：system 走頂層欄位、user/assistant 嚴格交替（相鄰
 * 同角色合併）、首條必須是 user。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('llm/anthropicProvider · 訊息轉換', () => {
  let m;
  before(() => {
    m = loadModule('src/core/llm/anthropicProvider.ts');
  });

  test('user / assistant 純文字原樣', () => {
    assert.deepEqual(
      m.toAnthropicMessages([
        { role: 'user', content: '續寫' },
        { role: 'assistant', content: '上一版' },
      ]),
      [
        { role: 'user', content: '續寫' },
        { role: 'assistant', content: '上一版' },
      ]
    );
  });

  test('相鄰同角色訊息被合併', () => {
    assert.deepEqual(
      m.toAnthropicMessages([
        { role: 'user', content: '第一段' },
        { role: 'user', content: '第二段' },
      ]),
      [{ role: 'user', content: '第一段\n\n第二段' }]
    );
  });

  test('首條不是 user 時前面補一條「（繼續）」', () => {
    const out = m.toAnthropicMessages([{ role: 'assistant', content: '上一版' }]);
    assert.deepEqual(out[0], { role: 'user', content: '（繼續）' });
    assert.equal(out.length, 2);
  });

  test('system 訊息不進 messages（由頂層欄位帶）', () => {
    const out = m.toAnthropicMessages([
      { role: 'system', content: '你是作者' },
      { role: 'user', content: '續寫' },
    ]);
    assert.deepEqual(out, [{ role: 'user', content: '續寫' }]);
  });
});
