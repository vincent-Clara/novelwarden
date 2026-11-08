/**
 * 工程頁的「待完善」那一組與設定行的「展開…」（完善設定，2026-10-19）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 待完善 | 只在有時出現、排在「設定」與「出現過 · 未建條目」之間、副標題寫個數、預設展開；一行是 名字〔分類〕· 後端給的說明（第 N 章起要用 · 種類）；有條目的點名字開啟、右鍵「開啟」「展開…（預計 2 次呼叫，最多 3 次）」，展開發 `expandLore` 帶 `relPath`；還沒有條目的點名字不做事、右鍵展開帶 `name` 與 `category`；選單裡列出要用到的章；篩選框也篩它 |
 * | 設定行的「展開…」 | 每一條都有：有待整合的與沒有的兩種選單都帶，發 `expandLore` 帶這一條的路徑；「整合這一條」照舊只在有待整合時出現 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LORE = '.novelwarden/lore';
const EXPAND = '展開…（預計 2 次呼叫，最多 3 次）';

const thinTree = (extra) => ({
  ...sampleTree(),
  lore: [
    { kind: 'file', label: '天機閣', relPath: `${LORE}/天機閣.md`, detail: '' },
    { kind: 'file', label: '青崖鎮', relPath: `${LORE}/青崖镇.md`, detail: '偏僻小鎮' },
  ],
  loreByEntry: {
    [`${LORE}/天機閣.md`]: { chapters: [], detail: '', updatedThrough: 0, pending: 0, keywords: [] },
    [`${LORE}/青崖镇.md`]: { chapters: [3, 5], detail: '第 3–5 章 · 2 章', updatedThrough: 3, pending: 1, keywords: [] },
  },
  loreUnfiled: [{ name: '斷魂香', category: '', chapters: [2], detail: '1 章 · 第 2 章起' }],
  loreThin: [
    { name: '九層樓', category: '地域/青崖', kind: 'missing', chapters: [4, 6], detail: '第 4 章起要用 · 還沒有條目' },
    {
      name: '天機閣', category: '', relPath: `${LORE}/天機閣.md`, kind: 'empty', chapters: [5], detail: '第 5 章起要用 · 只有一句話',
    },
  ],
  loreUnrecorded: 0,
  ...extra,
});

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const groupNames = (ui) => [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent);
const thinGroup = (ui) => groupOf(ui, '待完善');
const thinRows = (ui) => [...(thinGroup(ui)?.querySelectorAll('.row-lore-thin') ?? [])];
const thinRow = (ui, name) => thinRows(ui).find((r) => r.querySelector('.row-label')?.textContent === name);
/** 最近一條 expandLore（jsdom 那邊的物件原型不同，轉一道 JSON 才比得了 deepEqual）。 */
const expandSent = (ui) => JSON.parse(JSON.stringify(ui.last('expandLore') ?? null));
const loreRow = (ui, label) =>
  [...groupOf(ui, '設定').querySelectorAll('.row-lore')].find((r) => r.querySelector('.row-label')?.textContent === label);

describe('「待完善」那一組', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: thinTree() });
  });

  test('排在「設定」與「出現過 · 未建條目」之間', () => {
    const names = groupNames(ui);
    assert.equal(names.indexOf('待完善'), names.indexOf('設定') + 1, names.join('|'));
    assert.equal(names.indexOf('出現過 · 未建條目'), names.indexOf('待完善') + 1, names.join('|'));
  });

  test('副標題寫個數，預設展開', () => {
    assert.equal(thinGroup(ui).querySelector('.group-head .meta').textContent, '2 個');
    assert.equal(thinRows(ui).length, 2);
  });

  test('一行：名字〔分類〕· 後端給的說明，按後端的順序', () => {
    assert.deepEqual(
      thinRows(ui).map((r) => r.querySelector('.row-label').textContent),
      ['九層樓', '天機閣']
    );
    const row = thinRow(ui, '九層樓');
    assert.equal(row.querySelector('.lore-category')?.textContent, '〔地域/青崖〕', row.outerHTML);
    assert.equal(row.querySelector('.row-detail')?.textContent, '第 4 章起要用 · 還沒有條目');
    assert.equal(thinRow(ui, '天機閣').querySelector('.lore-category'), null);
  });

  test('有條目的：點名字開啟那一條', () => {
    ui.sent.length = 0;
    ui.clickEl(thinRow(ui, '天機閣').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, `${LORE}/天機閣.md`, JSON.stringify(ui.sent));
  });

  test('還沒有條目的：點名字不做事，整行壓暗', () => {
    ui.sent.length = 0;
    ui.clickEl(thinRow(ui, '九層樓').querySelector('.row-label'));
    assert.deepEqual(ui.sent, []);
    assert.ok(thinRow(ui, '九層樓').classList.contains('row-cast'));
    assert.ok(!thinRow(ui, '天機閣').classList.contains('row-cast'));
  });

  test('有條目的右鍵：開啟、展開…、要用到的章、重新整理', () => {
    const items = ui.itemsOf(ui.rightClick(thinRow(ui, '天機閣')));
    assert.deepEqual(items, ['開啟', EXPAND, '要用到：第 5 章', '重新整理'], JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/天機閣.md` });
  });

  test('還沒有條目的右鍵：展開帶名字與分類（後端先按分類建空條目）', () => {
    const items = ui.itemsOf(ui.rightClick(thinRow(ui, '九層樓')));
    assert.deepEqual(items, [EXPAND, '要用到：第 4、6 章', '重新整理'], JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', name: '九層樓', category: '地域/青崖' });
  });

  test('篩選框也篩它；一個都不匹配就整組不畫', () => {
    const input = groupOf(ui, '設定').querySelector('.lore-filter-input');
    const type = (text) => {
      const box = groupOf(ui, '設定').querySelector('.lore-filter-input');
      box.focus();
      box.value = text;
      box.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    };
    assert.ok(input);
    type('地域/青');
    assert.deepEqual(thinRows(ui).map((r) => r.querySelector('.row-label').textContent), ['九層樓']);
    type('查無此物');
    assert.equal(thinGroup(ui), undefined);
    type('');
    assert.equal(thinRows(ui).length, 2);
  });

  test('沒有待完善的時候整組不出現', () => {
    ui.post({ type: 'project', tree: thinTree({ loreThin: [] }) });
    assert.ok(!groupNames(ui).includes('待完善'), groupNames(ui).join('|'));
  });
});

describe('設定行右鍵的「展開…」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: thinTree() });
  });

  test('沒有待整合的那一條也有，發 expandLore 帶路徑', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '天機閣')));
    assert.ok(items.includes(EXPAND), JSON.stringify(items));
    assert.ok(!items.some((i) => i.startsWith('整合這一條')), JSON.stringify(items));
    for (const label of ['開啟', '重新命名', '移動到…', '刪除（移到回收站）']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/天機閣.md` });
  });

  test('有待整合的那一條：「整合這一條」在前、「展開…」緊跟在後', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖鎮')));
    const integrate = items.findIndex((i) => i.startsWith('整合這一條'));
    assert.ok(integrate >= 0, JSON.stringify(items));
    assert.equal(items[integrate + 1], EXPAND, JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), EXPAND);
    assert.deepEqual(expandSent(ui), { type: 'expandLore', relPath: `${LORE}/青崖镇.md` });
  });
});
