/**
 * makeAbortSignal 的空閒超時：timeoutMs 是「多久沒收到資料」，
 * 不是整段請求的上限。流式還在 poke 時不應 abort。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('llm/makeAbortSignal', () => {
  let makeAbortSignal;

  before(() => {
    ({ makeAbortSignal } = loadModule('src/core/llm/provider.ts'));
  });

  test('無 poke 則到期 abort', async () => {
    const { signal, dispose } = makeAbortSignal({ timeoutMs: 40 });
    await wait(80);
    assert.equal(signal.aborted, true);
    dispose();
  });

  test('持續 poke 則不 abort', async () => {
    const { signal, dispose, poke } = makeAbortSignal({ timeoutMs: 60 });
    const t = setInterval(poke, 20);
    await wait(180);
    clearInterval(t);
    assert.equal(signal.aborted, false);
    dispose();
  });

  test('停止 poke 之後才 abort', async () => {
    const { signal, dispose, poke } = makeAbortSignal({ timeoutMs: 50 });
    poke();
    await wait(20);
    poke();
    await wait(20);
    assert.equal(signal.aborted, false);
    await wait(80);
    assert.equal(signal.aborted, true);
    dispose();
  });

  test('dispose 之後不再 abort', async () => {
    const { signal, dispose } = makeAbortSignal({ timeoutMs: 30 });
    dispose();
    await wait(60);
    assert.equal(signal.aborted, false);
  });
});
