/**
 * 覆蓋審閱的段級 diff / 合併檢視（五期 W11，獨立版）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 兩個版本 | 相同的段一行帶過，每一處改動左右兩欄 + 一格結果；頂上「已處理 k / n 處」 |
 * | 什麼都不動就寫入 | 交回 `apply`（原樣用新版，不經段拼接） |
 * | 採用 / 保留 | 結果格跟著換，進度跟著漲 |
 * | **手改過的那一格** | 「採用新版」「保留原文」「全部採用新版」「全部保留原文」都不動它；「撤銷手改」才放開 |
 * | 寫入 | 交回的是合併結果（逐格拼起來） |
 * | 放棄 | 交回 `discard` |
 * | 只讀模式 | 沒有結果格、沒有逐段按鈕，底部是「採納」 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const CURRENT = ['雨下了一整夜。', '她把那塊殘令收進了袖中。', '天亮時，林昭離開了青崖鎮。', '他沒有回頭。'].join('\n\n');
const PROPOSED = ['雨下了一整夜。', '她看了一眼他空著的手，什麼也沒問。', '天亮時，林昭離開了青崖鎮。', '他回頭看了一眼客棧。'].join('\n\n');

function open(ui, extra = {}) {
  ui.post({
    type: 'prompt',
    requestId: extra.requestId ?? 'p1',
    kind: 'merge',
    title: '對比「第 2 章的正文」：現有 ↔ 新版',
    message: 'chapters/002-客棧.md',
    current: CURRENT,
    proposed: PROPOSED,
    mergeable: true,
    ...extra,
  });
}

describe('合併檢視', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('mergeModal');
  const hunks = () => [...modal().querySelectorAll('.merge-hunk')];
  const result = (i) => hunks()[i].querySelector('.merge-result');
  const btn = (i, cls) => hunks()[i].querySelector(`.${cls}`);
  const progress = () => ui.doc.getElementById('mergeProgress').textContent;
  const reply = () => JSON.parse(ui.last('promptResult').value);
  const type = (area, text) => {
    area.value = text;
    area.dispatchEvent(new ui.window.Event('input'));
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
  });

  test('相同的段一行帶過，兩處改動各一塊；結果格預設是新版', () => {
    open(ui);
    assert.ok(!modal().classList.contains('hidden'));
    assert.equal(hunks().length, 2);
    assert.equal(modal().querySelectorAll('.merge-same').length, 2);
    assert.match(hunks()[0].querySelector('.merge-old').textContent, /殘令/);
    assert.match(hunks()[0].querySelector('.merge-new').textContent, /空著的手/);
    assert.equal(result(0).value, '她看了一眼他空著的手，什麼也沒問。');
    assert.equal(progress(), '已處理 0 / 2 處');
    assert.equal(ui.doc.getElementById('mergePath').textContent, 'chapters/002-客棧.md');
  });

  test('什麼都不動就寫入：交回 apply，原樣用新版', () => {
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.deepEqual(reply(), { verdict: 'apply' });
    assert.ok(modal().classList.contains('hidden'));
  });

  test('保留原文：結果格換成原文，進度漲；寫入交回合併結果', () => {
    open(ui, { requestId: 'p2' });
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(result(0).value, '她把那塊殘令收進了袖中。');
    assert.equal(progress(), '已處理 1 / 2 處');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    const r = reply();
    assert.equal(r.verdict, 'apply');
    assert.equal(r.merged, ['雨下了一整夜。', '她把那塊殘令收進了袖中。', '天亮時，林昭離開了青崖鎮。', '他回頭看了一眼客棧。'].join('\n\n') + '\n');
  });

  test('手改過的那一格：採用、保留、全部採用、全部保留都不動它', () => {
    open(ui, { requestId: 'p3' });
    type(result(0), '作者自己改的一句。');
    assert.ok(hunks()[0].classList.contains('edited'));
    assert.equal(btn(0, 'merge-take-new').disabled, true);
    assert.equal(btn(0, 'merge-take-old').disabled, true);
    ui.clickEl(btn(0, 'merge-take-old'));
    ui.clickEl(ui.doc.getElementById('mergeAllOld'));
    ui.clickEl(ui.doc.getElementById('mergeAllNew'));
    assert.equal(result(0).value, '作者自己改的一句。');
    // 沒手改過的那一格照常跟著「全部採用」走。
    assert.equal(result(1).value, '他回頭看了一眼客棧。');
    assert.equal(progress(), '已處理 2 / 2 處');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.match(reply().merged, /作者自己改的一句。/);
  });

  test('撤銷手改：放開按鈕，回到當下挑的那一邊', () => {
    open(ui, { requestId: 'p4' });
    type(result(0), '改了一下。');
    ui.clickEl(btn(0, 'merge-undo'));
    assert.equal(hunks()[0].classList.contains('edited'), false);
    assert.equal(btn(0, 'merge-take-old').disabled, false);
    assert.equal(result(0).value, '她看了一眼他空著的手，什麼也沒問。');
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(result(0).value, '她把那塊殘令收進了袖中。');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
    assert.deepEqual(reply(), { verdict: 'discard' });
  });

  test('結果格清空：這一處整段刪掉', () => {
    open(ui, { requestId: 'p5' });
    type(result(1), '');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.doesNotMatch(reply().merged, /回頭/);
    assert.match(reply().merged, /青崖鎮。\n$/);
  });

  test('只讀模式：沒有結果格、沒有逐段按鈕，底部是「採納」', () => {
    open(ui, { requestId: 'p6', mergeable: false });
    assert.equal(modal().querySelectorAll('.merge-result').length, 0);
    assert.equal(modal().querySelectorAll('.merge-take-new').length, 0);
    assert.ok(ui.doc.getElementById('mergeAllNew').classList.contains('hidden'));
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '採納');
    assert.equal(progress(), '2 處改動');
    ui.clickEl(ui.doc.getElementById('mergeApply'));
    assert.deepEqual(reply(), { verdict: 'apply' });
  });

  test('帶兩欄稱呼（衝突時的對比合併）：兩欄、逐處與整體的按鈕、狀態、採納按鈕都換說法', () => {
    open(ui, {
      requestId: 'p7',
      sides: { current: '磁碟上的', proposed: '編輯器裡的' },
      applyLabel: '放回編輯器',
    });
    const h0 = hunks()[0];
    assert.equal(h0.querySelector('.merge-old .merge-side-label').textContent, '磁碟上的');
    assert.equal(h0.querySelector('.merge-new .merge-side-label').textContent, '編輯器裡的');
    assert.equal(btn(0, 'merge-take-old').textContent, '用磁碟上的');
    assert.equal(btn(0, 'merge-take-new').textContent, '用編輯器裡的');
    assert.equal(h0.querySelector('.merge-state').textContent, '未處理（預設是編輯器裡的）');
    assert.equal(ui.doc.getElementById('mergeAllOld').textContent, '全部用磁碟上的');
    assert.equal(ui.doc.getElementById('mergeAllNew').textContent, '全部用編輯器裡的');
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '放回編輯器');
    ui.clickEl(btn(0, 'merge-take-old'));
    assert.equal(h0.querySelector('.merge-state').textContent, '已用磁碟上的');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
  });

  test('下一次不帶稱呼：回到「原文 / 新版」與「寫入合併結果」', () => {
    open(ui, { requestId: 'p8' });
    assert.equal(hunks()[0].querySelector('.merge-old .merge-side-label').textContent, '原文');
    assert.equal(btn(0, 'merge-take-old').textContent, '保留原文');
    assert.equal(ui.doc.getElementById('mergeAllNew').textContent, '全部採用新版');
    assert.equal(ui.doc.getElementById('mergeApply').textContent, '寫入合併結果');
    ui.clickEl(ui.doc.getElementById('mergeDiscard'));
  });
});
