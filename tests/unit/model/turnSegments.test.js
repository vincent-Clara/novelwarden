/**
 * 一輪 assistant 排下來的段（`serializeTurn` 的那一半）。
 *
 * 介面**只認 `segments`**：文字塊、工具條、generate 卡按陣列順序畫。寫段的只有 MCP 那條路，
 * 而且一定標 `mcp`；有段卻沒標的，是已經移除的內建 agent 留下的舊輪次，要標出來給介面認。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 有 segments | 原樣帶過去，不動它 |
 * | 普通一問一答 | **沒有段**：一塊正文就是全部，那一輪照舊可就地編輯 |
 * | 有段、沒標 mcp | 標 `builtinAgent`；MCP 氣泡與普通回答都不標 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { serializeTurn } = loadModule('src/core/controller/serialize.ts');

const call = (callId, name, extra) =>
  Object.assign({ callId, name, title: name, ok: true, summary: '摘要', elapsedMs: 1 }, extra);

const assistant = (extra) =>
  serializeTurn(Object.assign({ id: 'a1', role: 'assistant', content: '', at: 'x' }, extra));

const segments = [
  { kind: 'tool', call: call('c1', 'read') },
  { kind: 'text', text: '我先看看。' },
  { kind: 'tool', call: call('c2', 'generate', { output: '### 全書結構' }) },
  { kind: 'text', text: '寫好了。' },
];

describe('段：原樣帶過去', () => {
  test('順序與內容一個字都不動', () => {
    assert.deepEqual(assistant({ content: '我先看看。\n\n寫好了。', segments, mcp: true }).segments, segments);
  });

  // 那幾千字是產物本身，回放時要畫在卡裡。
  test('generate 產出的正文跟著段走', () => {
    const out = assistant({ segments, mcp: true }).segments[2];
    assert.equal(out.call.output, '### 全書結構');
  });
});

describe('段：普通一問一答沒有段', () => {
  test('assistant 一塊正文', () => {
    assert.equal(assistant({ content: '好的。' }).segments, undefined);
  });

  test('user 那一支也沒有', () => {
    const turn = serializeTurn({ id: 'u1', role: 'user', content: '寫一段', at: 'x' });
    assert.equal(turn.segments, undefined);
  });
});

describe('已經移除的內建 agent 留下的輪次', () => {
  test('有段、沒標 mcp 的標成 builtinAgent，段照舊帶', () => {
    const turn = assistant({ content: '我先看看。\n\n寫好了。', segments });
    assert.equal(turn.builtinAgent, true);
    assert.equal(turn.mcp, undefined);
    assert.deepEqual(turn.segments, segments);
  });

  test('MCP 的氣泡不標', () => {
    assert.equal(assistant({ segments, mcp: true }).builtinAgent, undefined);
  });

  test('普通回答與空段都不標', () => {
    assert.equal(assistant({ content: '好的。' }).builtinAgent, undefined);
    assert.equal(assistant({ content: '好的。', segments: [] }).builtinAgent, undefined);
  });
});
