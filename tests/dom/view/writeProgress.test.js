/**
 * 寫章過程可見（W7）：寫正文時氣泡頂上的進度、丟棄一輪時氣泡退回、寫入卡的重演紅塊與兩段式
 * 寫入、氣泡上留下的字數記錄、主按鈕把寫法帶給後端。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | `writeProgress` | 「正在寫 / 續寫第 k 輪 · 已寫 x / 目標 y 字」+ 進度條；到八成換色 |
 * | 沒有目標字數 | 只報字數，進度條來回掃 |
 * | `streamReset` | 正文退回到那一份，進度條不動 |
 * | 收尾的 turnDone | 進度條隨氣泡重建消失；字數記錄留在氣泡上 |
 * | gate 帶 `danger` + `confirm` | 紅色塊；「寫入」點一下只換字，第二下才發 `gateResult` |
 * | 沒有 `confirm` | 一下就發（別的卡不受影響） |
 * | 主按鈕「接著寫」 | 發出去的 send 帶 `writeMode: 'continue'` |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, pipelineView, workbenchView } = require('../../helpers/dom');

function writing() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  return ui;
}

const progress = (ui) => ui.bubble('a1')?.querySelector('.write-progress');
const label = (ui) => progress(ui)?.querySelector('.write-progress-label').textContent;
const fill = (ui) => progress(ui)?.querySelector('.write-progress-fill').style.width;

describe('寫正文的進度', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = writing();
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 0, target: 3000 });
    ui.post({ type: 'delta', turnId: 'a1', text: '雨下了三天。' });
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 1200, target: 3000 });
  });

  test('第一次呼叫：正在寫 · 已寫 x / 目標 y 字', () => {
    assert.equal(label(ui), '正在寫 · 已寫 1200 / 目標 3000 字');
    assert.equal(fill(ui), '40%');
  });

  test('進度條排在正文前面', () => {
    const node = ui.bubble('a1');
    const bar = progress(ui);
    const body = node.querySelector('.msg-body');
    assert.ok(bar.compareDocumentPosition(body) & ui.window.Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('沒到八成不算達標', () => {
    assert.ok(!progress(ui).classList.contains('reached'));
  });

  test('續寫那幾輪：續寫第 k 輪；到了八成換色', () => {
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 2, words: 2500, target: 3000 });
    assert.equal(label(ui), '續寫第 2 輪 · 已寫 2500 / 目標 3000 字');
    assert.ok(progress(ui).classList.contains('reached'));
  });

  test('只有一條進度，就地更新', () => {
    assert.equal(ui.bubble('a1').querySelectorAll('.write-progress').length, 1);
  });

  test('丟棄一輪：正文退回，進度條不動', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '這一輪會被丟掉。' });
    ui.post({ type: 'streamReset', turnId: 'a1', text: '雨下了三天。' });
    assert.equal(ui.bodyOf('a1').textContent, '雨下了三天。');
    assert.ok(progress(ui));
  });

  test('收尾的 turnDone：進度條隨氣泡重建消失，字數記錄留在氣泡上', () => {
    ui.post({ type: 'busy', value: false });
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '雨下了三天。', {
        artifact: {
          where: '第 3 章《夜訪》 · 正文',
          summary: '正文 · 2500 字',
          overwrites: false,
          length: { words: 2500, target: 3000, added: 2500, rounds: 2, reached: true },
        },
      }),
    });
    assert.equal(progress(ui), null);
    const len = ui.bubble('a1').querySelector('.artifact-length');
    assert.equal(len.textContent, '2500 / 3000 字 · 已達標');
    assert.ok(!len.classList.contains('short'));
  });
});

describe('沒有目標字數', { skip: JSDOM_SKIP }, () => {
  test('只報字數，進度條來回掃', () => {
    const ui = writing();
    ui.post({ type: 'writeProgress', turnId: 'a1', round: 0, words: 800 });
    assert.equal(label(ui), '正在寫 · 已寫 800 字');
    assert.ok(progress(ui).classList.contains('indeterminate'));
  });
});

describe('氣泡上的記錄：未寫夠與重演', { skip: JSDOM_SKIP }, () => {
  let ui;
  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '正文', {
        artifact: {
          where: '第 3 章 · 正文',
          summary: '正文 · 1500 字',
          overwrites: false,
          declined: true,
          append: true,
          length: { words: 1500, target: 3000, added: 900, rounds: 0, reached: false },
          replay: '沈氏坐在櫃檯後面',
        },
      }),
    });
  });

  test('未寫夠用警示色，寫明已有與新寫', () => {
    const len = ui.bubble('a1').querySelector('.artifact-length');
    assert.ok(len.classList.contains('short'));
    assert.match(len.textContent, /1500 \/ 3000 字 · 未寫夠.*已有 600 字，這一次新寫 900 字/);
  });

  test('重演標紅，懸停看得到重合的原句', () => {
    const flag = ui.bubble('a1').querySelector('.artifact-replay');
    assert.equal(flag.textContent, '開頭與上一章結尾重合');
    assert.equal(flag.title, '沈氏坐在櫃檯後面');
  });
});

describe('寫入卡：重演時紅色塊與兩段式寫入', { skip: JSDOM_SKIP }, () => {
  let ui;
  const GATE = {
    type: 'gate',
    requestId: 'g1',
    turnId: 'a1',
    name: 'artifact',
    title: '把這份產物寫入到「第 4 章《井》 · 正文」',
    detail: '正文 · 2980 字\n2980 / 3000 字 · 已達標',
    proceed: '確認',
    skip: '不採納',
    danger: '開頭與上一章結尾大段重合，可能把上一章最後一場又演了一遍：\n「沈氏坐在櫃檯後面」',
    confirm: '確定仍要寫入',
  };
  const card = () => ui.doc.querySelector('#gateDock .gate');
  const proceedBtn = () => card().querySelector('.gate-actions button.primary');
  const results = () => ui.sent.filter((m) => m.type === 'gateResult');

  before(() => {
    ui = writing();
    ui.post(GATE);
  });

  test('紅色塊寫著重合的原句，整張卡標成警示', () => {
    assert.match(card().querySelector('.gate-danger').textContent, /沈氏坐在櫃檯後面/);
    assert.ok(card().classList.contains('gate-warn'));
  });

  test('第一下只換字，不發', () => {
    ui.clickEl(proceedBtn());
    assert.equal(results().length, 0);
    assert.equal(proceedBtn().textContent, '確定仍要寫入');
    assert.ok(card(), '卡片還在');
  });

  test('第二下才發 gateResult', () => {
    ui.clickEl(proceedBtn());
    assert.equal(results().length, 1);
    assert.equal(results()[0].verdict, 'proceed');
  });

  test('不採納一下就發', () => {
    ui.post({ ...GATE, requestId: 'g2' });
    ui.clickEl(card().querySelector('.gate-actions button.secondary'));
    assert.equal(results().at(-1).verdict, 'skip');
  });

  test('沒有 confirm 的卡：寫入一下就發', () => {
    const plain = { ...GATE, requestId: 'g3', danger: undefined, confirm: undefined };
    ui.post(plain);
    assert.equal(card().querySelector('.gate-danger'), null);
    ui.clickEl(proceedBtn());
    assert.equal(results().at(-1).requestId, 'g3');
  });
});

describe('主按鈕「接著寫」把寫法帶給後端', { skip: JSDOM_SKIP }, () => {
  test('send 帶 writeMode: continue', () => {
    const ui = mount();
    const PLOT = '.novelwarden/summaries/012-夜入青雲.md';
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'manuscript', plotRelPath: PLOT }, stage: 'manuscript', capability: 'discuss' }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ chapter: { exists: true, relPath: 'chapters/012-夜入青雲.md', words: 900, targetWords: 3000, upstreamStale: false } }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青雲》' }),
      next: {
        stage: 'manuscript',
        capability: 'generate',
        label: '接著寫',
        hint: '第 12 章寫了 900 字，還沒寫夠（約 38%）。',
        target: { kind: 'manuscript', plotRelPath: PLOT },
        no: 12,
        writeMode: 'continue',
        calls: { low: 1, high: 1, max: 8, why: '沒寫夠時自動續寫，最多再續 7 輪' },
      },
    });
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('nextStepBtn'));
    const sent = ui.last('send');
    assert.equal(sent?.payload.writeMode, 'continue', JSON.stringify(sent));
  });
});
