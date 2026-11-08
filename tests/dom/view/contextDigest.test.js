/**
 * 裝配清單的摘要行點名上下文詳細度：作者回看某一輪時知道它是按哪一級裝的。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 帶 `detail` 的摘要行末尾寫「詳細度：精簡」 | 級別是全域設定，改過之後，老氣泡上得看得出當時按哪一級 |
 * | 沒有 `detail`（這個開關出現之前存下的會話）就不說 | 不編一個出來 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const digest = (extra) => ({
  usedTokens: 1200,
  budget: 100000,
  clamped: false,
  items: [{ id: 'style', label: '文風指南', kind: 'style', priority: 0, tokens: 1200, status: 'included' }],
  ...extra,
});

describe('裝配清單：上下文詳細度', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '第一版') });
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '老會話裡的一版') });
    ui.post({ type: 'context', turnId: 'a1', digest: digest({ detail: 1 }) });
    ui.post({ type: 'context', turnId: 'a2', digest: digest() });
  });

  test('帶級別的寫「詳細度：精簡」', () => {
    const text = [...ui.doc.querySelectorAll('details.ctx summary')].map((s) => s.textContent);
    assert.equal(text.length, 2, text.join(' | '));
    assert.match(text[0], /· 1 項 · 詳細度：精簡$/);
  });

  test('沒有級別的不說', () => {
    const text = [...ui.doc.querySelectorAll('details.ctx summary')].map((s) => s.textContent);
    assert.doesNotMatch(text[1], /詳細度/);
  });
});
