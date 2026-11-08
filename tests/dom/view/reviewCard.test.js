/**
 * 審稿報告卡（五期 W10）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 審稿那一輪 | 畫報告卡，不畫可就地編輯的正文 |
 * | 分組與計數 | 目標核對在前，嚴重 / 建議分組，通過與丟掉的意見摺疊 |
 * | 預設勾選 | 嚴重、建議、未完成勾上；待核實不勾；已完成沒有勾 |
 * | 勾選數進按鈕 | 「按勾選的 n 條修稿」，提示裡寫呼叫次數；0 條禁用 |
 * | 點引文 | 發 `revealQuote`，帶正文路徑與那一句 |
 * | 點修稿 | 發 `reviseChapter`，只帶勾選的 id |
 * | 氣泡重建 | 勾選狀態不丟（介面狀態留在前端） |
 * | 正在生成 | 修稿按鈕禁用 |
 * | 使用者氣泡 | `/按審稿修稿` 下面列出勾了哪幾條 |
 * | 編輯問題（五期補遺 §3） | 表裡能改能加，模型給的不能刪；重建不丟；儲存發 `editReview`；推回後作者加的預設勾上 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const REPORT = {
  chapterNo: 2,
  chapterTitle: '客棧',
  chapterRelPath: 'chapters/002-客棧.md',
  chapterHash: 'h',
  summary: '一處硬傷',
  issues: [
    { id: 'i1', category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '殘令前文已經交出去了' },
    { id: 'i2', category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '左臂有傷卻動作如常' },
  ],
  passes: [{ category: '前後章節串聯', description: '接得上' }],
  goals: [
    { id: 'g1', kind: 'event', text: '林昭回到客棧', status: 'completed', judgment: '回到了', quotes: ['林昭推開客棧的門'] },
    { id: 'g2', kind: 'event', text: '林昭當晚離開', status: 'unmet', judgment: '他說明天走', quotes: ['天一亮就走'] },
    { id: 'g3', kind: 'hook', text: '門外有人敲門', status: 'unknown', judgment: '沒寫到', quotes: [] },
  ],
  coverage: 'complete',
  dropped: [{ category: '角色狀態', severity: 'warning', description: '編的', quote: '林昭拔劍', why: '引文在正文裡找不到' }],
};

const reviewTurn = () =>
  turn('a1', 'assistant', '# 第 2 章《客棧》審稿', {
    review: { report: REPORT, picks: ['i1', 'i2', 'g2'], notes: ['丟掉 1 條引文站不住的意見'], calls: 1 },
  });

describe('審稿報告卡', { skip: JSDOM_SKIP }, () => {
  let ui;
  const card = () => ui.bubble('a1').querySelector('.review-card');
  const box = (id) => card().querySelector(`input[data-pick="${id}"]`);
  const submit = () => card().querySelector('.review-submit');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '', { command: '審稿' }) });
    ui.post({ type: 'turnDone', turn: reviewTurn() });
  });

  test('畫報告卡，不畫可就地編輯的正文', () => {
    assert.ok(card());
    assert.equal(ui.bubble('a1').querySelector('.msg-body'), null);
  });

  test('頭部：第幾章與一句話概括', () => {
    assert.match(card().querySelector('.review-title').textContent, /審稿 · 第 2 章《客棧》/);
    assert.equal(card().querySelector('.review-counts').textContent, '1 嚴重 · 1 建議 · 目標 1/3 已完成（1 項待核實）');
    assert.equal(card().querySelector('.review-summary').textContent, '一處硬傷');
  });

  test('分組：目標在前，嚴重、建議各一組；通過、丟掉的、說明摺疊', () => {
    const titles = [...card().querySelectorAll('.review-section-title')].map((n) => n.textContent);
    assert.match(titles[0], /^本章目標/);
    assert.deepEqual(titles.slice(1), ['嚴重（1）', '建議（1）']);
    const folded = [...card().querySelectorAll('.review-folded summary')].map((n) => n.textContent);
    assert.deepEqual(folded, ['通過（1）', '丟掉的意見（1，引文站不住）', '說明（1）']);
  });

  test('預設勾選：嚴重、建議、未完成勾上；待核實不勾；已完成沒有勾', () => {
    assert.equal(box('i1').checked, true);
    assert.equal(box('i2').checked, true);
    assert.equal(box('g2').checked, true);
    assert.equal(box('g3').checked, false);
    assert.equal(box('g1'), null);
  });

  test('按鈕寫勾了幾條；提示裡寫呼叫次數', () => {
    assert.equal(submit().textContent, '按勾選的 3 條修稿');
    assert.match(submit().title, /預計 1 次呼叫，最多 4 次/);
  });

  test('點引文：發 revealQuote', () => {
    const q = [...card().querySelectorAll('.review-quote')].find((n) => n.textContent.includes('殘令'));
    ui.clickEl(q);
    const sent = ui.last('revealQuote');
    assert.deepEqual({ relPath: sent.relPath, quote: sent.quote }, { relPath: 'chapters/002-客棧.md', quote: '她把那塊殘令收進了袖中' });
  });

  test('改勾選之後按鈕跟著變；點修稿只帶勾選的 id', () => {
    box('i2').checked = false;
    box('i2').dispatchEvent(new ui.window.Event('change'));
    box('g3').checked = true;
    box('g3').dispatchEvent(new ui.window.Event('change'));
    assert.equal(submit().textContent, '按勾選的 3 條修稿');
    ui.clickEl(submit());
    assert.deepEqual([...ui.last('reviseChapter').picks].sort(), ['g2', 'g3', 'i1']);
  });

  test('氣泡重建：勾選狀態不丟', () => {
    ui.post({ type: 'turnDone', turn: reviewTurn() });
    assert.equal(box('i2').checked, false);
    assert.equal(box('g3').checked, true);
  });

  test('一條都沒勾：按鈕禁用', () => {
    for (const id of ['i1', 'g2', 'g3']) {
      box(id).checked = false;
      box(id).dispatchEvent(new ui.window.Event('change'));
    }
    assert.equal(submit().disabled, true);
    assert.equal(submit().textContent, '勾選要修的條目');
  });

  test('正在生成：修稿按鈕禁用', () => {
    box('i1').checked = true;
    box('i1').dispatchEvent(new ui.window.Event('change'));
    assert.equal(submit().disabled, false);
    ui.post({ type: 'busy', value: true });
    assert.equal(submit().disabled, true);
    ui.post({ type: 'busy', value: false });
    assert.equal(submit().disabled, false);
  });

  test('使用者氣泡：/按審稿修稿 下面列出勾了哪幾條', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('u2', 'user', '', { command: '按審稿修稿', revise: { items: ['[嚴重] 劇情合理性：殘令前文已經交出去了'] } }),
    });
    const bubble = ui.bubble('u2');
    assert.equal(bubble.querySelector('.msg-command').textContent, '/按審稿修稿');
    assert.deepEqual([...bubble.querySelectorAll('.msg-revise-items li')].map((n) => n.textContent), ['[嚴重] 劇情合理性：殘令前文已經交出去了']);
  });
});

// 五期補遺 §3：編輯模式。
describe('審稿報告卡 · 編輯問題', { skip: JSDOM_SKIP }, () => {
  let ui;
  const card = () => ui.bubble('a9').querySelector('.review-card');
  const btn = (cls) => card().querySelector(cls);
  const rows = () => [...card().querySelectorAll('.review-edit-row')];
  const set = (node, value) => {
    node.value = value;
    node.dispatchEvent(new ui.window.Event(node.tagName === 'SELECT' ? 'change' : 'input'));
  };
  const theTurn = (report = REPORT, picks = ['i1', 'i2', 'g2']) =>
    turn('a9', 'assistant', '# 審稿', { review: { report, picks, calls: 1 } });

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: theTurn() });
  });

  test('點「編輯問題」：問題那幾組換成可改的表，修稿那一顆收起來', () => {
    ui.clickEl(btn('.review-edit'));
    assert.ok(card().classList.contains('editing'));
    assert.equal(rows().length, 2);
    assert.equal(card().querySelector('.review-submit'), null);
    assert.equal(rows()[0].querySelector('.review-edit-desc').value, '殘令前文已經交出去了');
    assert.equal(rows()[0].querySelector('.review-edit-remove'), null, '模型給的不能刪');
  });

  test('新增一條：作者補充，可以刪', () => {
    ui.clickEl(btn('.review-edit-add'));
    assert.equal(rows().length, 3);
    const added = rows()[2];
    assert.ok(added.classList.contains('author'));
    assert.equal(added.querySelector('.review-edit-category').value, '作者補充');
    assert.ok(added.querySelector('.review-edit-remove'));
  });

  test('氣泡重建：編輯中的表與剛敲的字不丟', () => {
    set(rows()[2].querySelector('.review-edit-desc'), '結尾太急');
    set(rows()[1].querySelector('.review-edit-severity'), 'error');
    ui.post({ type: 'turnDone', turn: theTurn() });
    assert.equal(rows().length, 3);
    assert.equal(rows()[2].querySelector('.review-edit-desc').value, '結尾太急');
    assert.equal(rows()[1].querySelector('.review-edit-severity').value, 'error');
  });

  test('儲存：發 editReview，整張表，新加的不帶 id；退出編輯模式', () => {
    ui.clickEl(btn('.review-edit-save'));
    const sent = ui.last('editReview');
    assert.equal(sent.turnId, 'a9');
    assert.deepEqual(
      sent.issues.map((i) => [i.id ?? '', i.severity, i.description]),
      [
        ['i1', 'error', '殘令前文已經交出去了'],
        ['i2', 'error', '左臂有傷卻動作如常'],
        ['', 'warning', '結尾太急'],
      ]
    );
    assert.ok(!card().classList.contains('editing'));
    assert.ok(card().querySelector('.review-submit'));
  });

  test('後端推回新報告：作者加的標「作者補充」、沒有引文不畫引文、預設勾上；改過的標「已改」', () => {
    const next = {
      ...REPORT,
      issues: [
        REPORT.issues[0],
        { ...REPORT.issues[1], severity: 'error', edited: true },
        { id: 'a1', category: '作者補充', severity: 'warning', quote: '', description: '結尾太急', origin: 'author' },
      ],
    };
    ui.post({ type: 'turnDone', turn: theTurn(next, ['i1', 'i2', 'a1', 'g2']) });
    const a1 = card().querySelector('.review-item[data-item="a1"]');
    assert.equal(a1.querySelector('.review-tag').textContent, '作者補充');
    assert.equal(a1.querySelector('.review-quote'), null);
    assert.equal(a1.querySelector('input[data-pick="a1"]').checked, true);
    assert.equal(card().querySelector('.review-item[data-item="i2"] .review-tag').textContent, '已改');
    assert.equal(card().querySelector('.review-submit').textContent, '按勾選的 4 條修稿');
  });

  test('取消：不發訊息，回到原樣', () => {
    const before = ui.sent.length;
    ui.clickEl(btn('.review-edit'));
    ui.clickEl(btn('.review-edit-cancel'));
    assert.equal(ui.sent.length, before);
    assert.ok(!card().classList.contains('editing'));
  });
});
