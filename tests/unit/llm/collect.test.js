/**
 * 事件流的收集器：collectText / collect。
 *
 * 這一層是 13 個既有呼叫點與 provider 之間唯一的橋，所以三件事必須釘死：
 * reasoning 絕不混進正文、usage 按欄位合併（同一次請求會回呼多次）、
 * 收尾原因原樣交出（上游沒說就是 undefined）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

async function* streamOf(events) {
  for (const e of events) yield e;
}

describe('llm/collect', () => {
  let c;
  before(() => {
    c = loadModule('src/core/llm/collect.ts');
  });

  test('collectText 只拼 text 事件', async () => {
    const text = await c.collectText(
      streamOf([
        { type: 'text', text: '雨下了' },
        { type: 'reasoning', text: '（先想想）' },
        { type: 'text', text: '三天。' },
      ])
    );
    assert.equal(text, '雨下了三天。');
  });

  test('reasoning 不混進正文，單獨回呼', async () => {
    const seen = [];
    await c.collectText(
      streamOf([
        { type: 'reasoning', text: 'a' },
        { type: 'text', text: 'X' },
        { type: 'reasoning', text: 'b' },
      ]),
      { onReasoning: (d, full) => seen.push([d, full]) }
    );
    assert.deepEqual(seen, [
      ['a', 'a'],
      ['b', 'ab'],
    ]);
  });

  test('usage 按欄位合併，缺席欄位保留', async () => {
    const r = await c.collect(
      streamOf([
        { type: 'usage', usage: { inputTokens: 100 } },
        { type: 'text', text: 'x' },
        { type: 'usage', usage: { outputTokens: 20 } },
      ])
    );
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20 });
  });

  test('usage 每條都回呼，不等收全', async () => {
    const seen = [];
    await c.collect(
      streamOf([
        { type: 'usage', usage: { inputTokens: 100 } },
        { type: 'usage', usage: { outputTokens: 20 } },
      ]),
      { onUsage: (u) => seen.push(u) }
    );
    assert.deepEqual(seen, [{ inputTokens: 100 }, { outputTokens: 20 }]);
  });

  test('onDelta 收到增量與全量', async () => {
    const seen = [];
    await c.collectText(
      streamOf([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
      { onDelta: (d, full) => seen.push([d, full]) }
    );
    assert.deepEqual(seen, [
      ['a', 'a'],
      ['b', 'ab'],
    ]);
  });

  test('collect 同時給出四份產出', async () => {
    const r = await c.collect(
      streamOf([
        { type: 'text', text: '正' },
        { type: 'reasoning', text: '想' },
        { type: 'usage', usage: { inputTokens: 5 } },
        { type: 'text', text: '文' },
        { type: 'stop', reason: 'end' },
      ])
    );
    assert.deepEqual(r, { text: '正文', reasoning: '想', usage: { inputTokens: 5 }, stopReason: 'end' });
  });

  test('空流產出空字串與空 usage', async () => {
    const r = await c.collect(streamOf([]));
    assert.deepEqual(r, {
      text: '',
      reasoning: '',
      usage: {},
      stopReason: undefined,
    });
  });

  test('收尾原因收進 stopReason', async () => {
    const r = await c.collect(
      streamOf([{ type: 'text', text: '寫到一半' }, { type: 'stop', reason: 'maxTokens' }])
    );
    assert.equal(r.stopReason, 'maxTokens');
  });

  // undefined 有它自己的意思：「上游沒說」。補一個預設值等於替它編一句話，而
  // 續寫鏈會照著那句話決定回退還是往後接。
  test('上游沒說時是 undefined，不補預設值', async () => {
    const r = await c.collect(streamOf([{ type: 'text', text: '好的。' }]));
    assert.equal(r.stopReason, undefined);
  });

  test('mergeUsage 就地按欄位合併，undefined 不覆蓋已有值', () => {
    const target = { inputTokens: 100, outputTokens: 7 };
    c.mergeUsage(target, { outputTokens: 20 });
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
    c.mergeUsage(target, {});
    assert.deepEqual(target, { inputTokens: 100, outputTokens: 20 });
  });

  // 續寫、修復重試各是一次新請求：請求之間相加（合併只會剩最後一次，「輸入實測」就報少了）。
  test('sumUsage 把幾次請求逐欄位相加', () => {
    assert.deepEqual(
      c.sumUsage([{ inputTokens: 100, outputTokens: 20 }, { inputTokens: 150, outputTokens: 30 }]),
      { inputTokens: 250, outputTokens: 50 }
    );
  });

  test('sumUsage 只加回報了的那幾次，一次都沒報就仍是 undefined', () => {
    assert.deepEqual(c.sumUsage([{ inputTokens: 100 }, {}, { inputTokens: 50 }]), { inputTokens: 150 });
    assert.deepEqual(c.sumUsage([{}, {}]), {});
    assert.deepEqual(c.sumUsage([]), {});
  });
});
