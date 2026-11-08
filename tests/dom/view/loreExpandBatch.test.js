/**
 * 完善設定三期的前端（設計稿 §5、§6）：「待完善」組標題的「全部展開」、拆細綱彈窗的「拆完展開本批新設定」、
 * 批次寫章彈窗與工作臺的寫前提醒。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 全部展開 | 組標題右鍵「全部展開（K 條，預計 2K 次呼叫，最多 4K 次）」（寫完轉寫，2026-10-25 起），K 不算作者寫過的（`authored`）；點了發 `expandLoreAll`；全是作者寫過的就沒有這一項 |
 * | 拆細綱彈窗 | 多一項「拆完展開本批新設定」，預設「否」；選「是」時說明裡寫清拆完再問次數，提交帶 `expandLore`；選「否」不帶 |
 * | 批次寫章彈窗 | 要寫的幾章用到的待完善設定在說明裡提一句（區間外的不算），不攔 |
 * | 工作臺 | `notice` 在浮窗裡淡色一句，入口掛淡色記號；有 ⟳ 時入口仍是 ⟳ |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, pipelineView, workbenchView, sampleTree } = require('../../helpers/dom');

const LORE = '.novelwarden/lore';
const note = (ui) => ui.doc.querySelector('.nf-form .form-note')?.textContent ?? '';
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot button.primary');
function choose(ui, key, value) {
  const sel = field(ui, key);
  sel.value = value;
  sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}
function type(ui, key, value) {
  const input = field(ui, key);
  input.value = String(value);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
const esc = (ui) => ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

const thin = [
  { name: '九層樓', category: '地域', kind: 'missing', chapters: [5, 6], detail: '第 5 章起要用 · 還沒有條目' },
  { name: '天機閣', category: '宗門', relPath: `${LORE}/宗門/天機閣.md`, kind: 'empty', chapters: [5], detail: '第 5 章起要用 · 只有一句話' },
  { name: '後山', category: '地域', relPath: `${LORE}/地域/後山.md`, kind: 'untold', chapters: [9], detail: '第 9 章起要用 · 三節全是未交代', authored: true },
];
const treeWith = (loreThin) => ({ ...sampleTree(), loreThin });
/** 「章節」組標題右鍵點一項：兩個批次彈窗的入口。 */
const pickFromChapters = (ui, label) =>
  ui.pick(
    ui.rightClick([...ui.doc.querySelectorAll('#projectBody .group-head')].find((n) => n.querySelector('.group-name').textContent === '章節')),
    label
  );
const thinHead = (ui) =>
  [...ui.doc.querySelectorAll('#projectBody .group')]
    .find((g) => g.querySelector('.group-name')?.textContent === '待完善')
    ?.querySelector('.group-head');

describe('「待完善」組標題的「全部展開」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const ALL = '全部展開（2 條，預計 4 次呼叫，最多 8 次）';

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: treeWith(thin) });
  });

  test('次數與後端確認框同一個數，不算作者寫過的', () => {
    const items = ui.itemsOf(ui.rightClick(thinHead(ui)));
    assert.equal(items[0], ALL, JSON.stringify(items));
  });

  test('點了發 expandLoreAll，不帶路徑', () => {
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), ALL);
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'expandLoreAll', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, undefined);
  });

  test('全是作者寫過的：沒有這一項', () => {
    ui.post({ type: 'project', tree: treeWith([thin[2]]) });
    const items = ui.itemsOf(ui.rightClick(thinHead(ui)));
    ui.closeMenu();
    assert.ok(!items.some((i) => i.startsWith('全部展開')), JSON.stringify(items));
  });
});

describe('拆細綱彈窗的「拆完展開本批新設定」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const open = () => pickFromChapters(ui, '批次拆細綱…');

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  test('預設「否」，說明裡不提', () => {
    assert.equal(field(ui, 'expandLore')?.value, 'off');
    assert.ok(!note(ui).includes('拆完展開本批新設定'), note(ui));
  });

  test('選「否」提交不帶 expandLore', () => {
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'generatePlots', JSON.stringify(ui.sent));
    assert.equal(msg.expandLore, undefined);
  });

  test('選「是」：說明裡寫清拆完再報次數、再問一次；提交帶 expandLore', () => {
    open();
    choose(ui, 'expandLore', 'on');
    assert.ok(note(ui).includes('拆完展開本批新設定：每條 1 次，有幾條要拆完才知道，到時再報次數、再問一次'), note(ui));
    // 拆細綱那一段的次數不變（展開那幾次不在這裡的數里）。
    assert.ok(note(ui).includes('預計 2 次呼叫，最多 23 次'), note(ui));
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.expandLore, true, JSON.stringify(msg));
    assert.ok(msg.call, JSON.stringify(msg));
  });
});

describe('批次寫章彈窗的寫前提醒', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: treeWith(thin) });
    pickFromChapters(ui, '批次寫章…');
  });

  // 預設寫第 4–6 章：九層樓（第 5、6 章）、天機閣（第 5 章）在區間裡，後山（第 9 章）不在。
  test('區間裡要用到的待完善設定提一句，不攔', () => {
    assert.ok(
      note(ui).includes('區間裡 2 條要用到的設定還只有一句話（九層樓、天機閣），寫之前可以先在工程頁「待完善」裡展開；不展開也照寫。'),
      note(ui)
    );
    assert.ok(!submitBtn(ui).disabled);
  });

  test('區間裡沒有就不提', () => {
    type(ui, 'from', 7);
    type(ui, 'to', 8);
    assert.ok(!note(ui).includes('還只有一句話'), note(ui));
    esc(ui);
  });
});

describe('工作臺的寫前提醒', { skip: JSDOM_SKIP }, () => {
  let ui;
  const entry = () => ui.doc.getElementById('workbench');
  const tip = () => ui.doc.querySelector('.workbench-tip');
  const NOTICE = '本章要用的 天機閣 還只有一句話，寫之前可以先展開（在工程頁「待完善」裡右鍵「展開…」）。';
  const post = (extra) =>
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青雲》', ...extra }),
    });

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    post({ notice: NOTICE });
  });

  test('入口掛淡色記號，不是 ⟳', () => {
    const mark = entry().querySelector('.wbt-entry-mark');
    assert.equal(mark?.textContent, '◌');
    assert.ok(mark.classList.contains('is-notice'));
  });

  test('浮窗裡淡色一句，與 ⟳ 分開', () => {
    ui.clickEl(entry());
    assert.equal(tip()?.querySelector('.wbt-notice')?.textContent, `◌ ${NOTICE}`);
    assert.equal(tip().querySelector('.wbt-warning'), null);
  });

  test('同時有上游變更：入口仍是 ⟳，浮窗兩句都在', () => {
    post({ notice: NOTICE, warning: '這一章的細綱在正文寫完（或定稿）之後改過。' });
    assert.equal(entry().querySelector('.wbt-entry-mark')?.textContent, '⟳');
    assert.ok(tip()?.querySelector('.wbt-warning'));
    assert.ok(tip()?.querySelector('.wbt-notice'));
  });
});
