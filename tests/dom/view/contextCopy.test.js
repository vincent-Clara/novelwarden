/**
 * 裝配清單摘要行上的「複製完整上下文」（前端一半）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 留著完整訊息的回覆才有這顆按鈕 | 功能加上之前的回覆只存了清單，給一顆點了必失敗的按鈕是騙人 |
 * | 點它發 `copyContext`，摺疊塊不跟著開合 | 一下就夠；按鈕長在 `<summary>` 裡，點它不該順帶把清單開啟 |
 * | 只認自己發的那個 `requestId` | 回覆是廣播，側欄與編輯器標籤頁都收得到，兩邊都寫剪貼簿會彈兩次提示 |
 * | 寫進剪貼簿的是後端給的那份，一個字不動 | 複製出去的就是發給模型的那份 |
 * | 後端說拿不到就報那一句 | 不假裝複製成功 |
 * | 剪貼簿不讓寫時給「再點一下複製」 | 中間隔著一趟來回，WebKit 可能不認那一下點選；再點一下是新的點選 |
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const digest = {
  usedTokens: 1200,
  budget: 100000,
  clamped: false,
  detail: 3,
  items: [{ id: 'style', label: '文風指南', kind: 'style', priority: 0, tokens: 1200, status: 'included' }],
};

const FULL = '你是作者。\n\n---\n\n# 我的要求\n\n寫第 3 章。';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('複製完整上下文', { skip: JSDOM_SKIP }, () => {
  let ui;
  /** 每次 writeText 寫了什麼；`reject` 置真時假裝瀏覽器不讓寫。 */
  let written;
  let reject;

  const copyBtn = (id) => ui.bubble(id)?.querySelector('details.ctx > summary .ctx-copy') ?? null;
  const toast = () => ui.doc.getElementById('toast');
  const lastCopy = () => ui.last('copyContext');

  before(() => {
    ui = mount();
    ui.window.navigator.clipboard = {
      writeText: (text) => {
        written.push(text);
        return reject ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
    };
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '這一版', { context: digest, fullContext: true }) });
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '老會話裡的一版', { context: digest }) });
  });

  beforeEach(() => {
    written = [];
    reject = false;
  });

  test('留著完整訊息的回覆：摘要行末尾有按鈕', () => {
    assert.equal(copyBtn('a1')?.textContent, '複製完整上下文');
  });

  test('只存了清單的老回覆：沒有按鈕，清單照舊', () => {
    assert.equal(copyBtn('a2'), null);
    assert.ok(ui.bubble('a2').querySelector('details.ctx'));
  });

  test('點它發 copyContext，摺疊塊不開合', () => {
    const det = ui.bubble('a1').querySelector('details.ctx');
    ui.clickEl(copyBtn('a1'));
    const msg = lastCopy();
    assert.equal(msg.turnId, 'a1');
    assert.ok(msg.requestId);
    assert.equal(det.open, false);
  });

  test('別的檢視點的（requestId 對不上）：不寫剪貼簿', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: '另一個檢視', text: FULL });
    await tick();
    assert.deepEqual(written, []);
  });

  test('自己點的：原樣寫進剪貼簿，提示已複製', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, text: FULL });
    await tick();
    assert.deepEqual(written, [FULL]);
    assert.match(toast().textContent, /^已複製完整上下文/);
  });

  test('同一個回覆只認一次', async () => {
    ui.clickEl(copyBtn('a1'));
    const requestId = lastCopy().requestId;
    ui.post({ type: 'contextText', requestId, text: FULL });
    ui.post({ type: 'contextText', requestId, text: FULL });
    await tick();
    assert.equal(written.length, 1);
  });

  test('後端說拿不到：報那一句，不碰剪貼簿', async () => {
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, error: '這一輪沒有留下完整上下文。' });
    await tick();
    assert.deepEqual(written, []);
    assert.equal(toast().textContent, '這一輪沒有留下完整上下文。');
    assert.ok(toast().classList.contains('error'));
  });

  test('剪貼簿不讓寫：給「再點一下複製」，點了再寫一次', async () => {
    reject = true;
    ui.clickEl(copyBtn('a1'));
    ui.post({ type: 'contextText', requestId: lastCopy().requestId, text: FULL });
    await tick();
    const again = toast().querySelector('.toast-action');
    assert.equal(again?.textContent, '再點一下複製');

    reject = false;
    ui.clickEl(again);
    await tick();
    assert.deepEqual(written, [FULL, FULL]);
    assert.match(toast().textContent, /^已複製完整上下文/);
  });
});
