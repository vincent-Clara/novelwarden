/**
 * 工程頁「存檔點…」彈窗（`media/src/view/checkpoints.ts`，2026-10-20）。列表與比較結果都由後端推來（`checkpoints` /
 * `checkpointDiff`），這裡按訊息造；前端只發訊息，什麼都不寫。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 頁籤條 | 存檔點是工程頁頁籤條上重新整理左邊的一個圖示（⚑）；點了開彈窗、發 `listCheckpoints`、說「正在讀…」 |
 * | 列表 | 時刻「10-20 22:30」（不是今年的帶年份）、手動 / 自動、備註或「（沒寫備註）」、「正文 N 章 · X 字 · F 份檔案」、超過 2 MB 沒存的說出來；空列表說什麼時候會自動存；`unavailable` 照實說、輸入框與按鈕置灰 |
 * | 存一個 | 發 `createCheckpoint`（備註去掉首尾空白）、清空輸入框、列表回來之前「正在存…」且按鈕置灰；回車也存 |
 * | 留住 | 只有自動的有「留住…」；攤開一格（填著原來那句），「留住」發 `noteCheckpoint` |
 * | 跟現在比 | 發 `checkpointDiff`、先說「正在比…」、標題「時刻「備註」 ↔ 現在」；三組按 改過的 / 之後刪掉的 / 之後新建的 排、帶份數；種類、字數（「3,011 → 2,870 字」「當時」「現在」）；一樣的只報個數；別的 id 不認；出錯、一模一樣照實說；「← 返回列表」 |
 * | 對比 | 只有裝了內建編輯器（獨立版，回答 `nf-version-diff-query`）才有、只給改過的與刪掉的；點了關掉彈窗、在編輯區開對比標籤（沒開著的那份先開成臨時標籤） |
 * | 退回 | 點兩下才發：第一下只換字（`is-armed`），點別處退回第一段；單份的 `expect` 是這一份的 `hashNow`、刪掉的是 `null`；整本的 `paths` 是改過的 + 刪掉的，勾了才帶 `trash`；退回期間按鈕置灰，後端重推之後停在這一頁重畫、勾選框回到不勾 |
 * | 未儲存的檔案 | 獨立版經 `nf-dirty-query` 問內建編輯器，開著、改過沒存的那一份進 `dirty`；外掛形態沒人回答，是空的 |
 * | 關 | Esc / × 關、面板上的一切丟掉，之後再到的訊息不畫；合併檢視蓋在上面時 Esc 不關底下的面板；後端的 prompt 中途佔了這一層時，推來的列表不往上畫 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree, viewState, file } = require('../../helpers/dom');

/** 頁面裡造的物件原型在 jsdom 那一邊，deepStrictEqual 認原型：比之前先拍平。 */
const plain = (x) => JSON.parse(JSON.stringify(x));

const YEAR = new Date().getFullYear();
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

const MANUAL_ID = '2026-10-20_22-30-05+0800';
const AUTO_ID = '2026-10-19_09-05-00+0800';
const OLD_ID = '2025-03-04_08-00-00+0800';

/** 三個存檔點（新的在前）：手動帶備註、自動（有兩份超過 2 MB 沒存）、去年的手動沒寫備註。 */
const CHECKPOINTS = [
  { id: MANUAL_ID, time: at(YEAR, 10, 20, 22, 30), note: '第一卷寫完', auto: false, files: 40, chapters: 12, chapterWords: 36000, skipped: [] },
  {
    id: AUTO_ID, time: at(YEAR, 10, 19, 9, 5), note: '批次寫章之前（第 12–20 章）', auto: true,
    files: 38, chapters: 11, chapterWords: 3011, skipped: ['chapters/超大的一章.txt', 'drafts/超大的草稿.txt'],
  },
  { id: OLD_ID, time: at(YEAR - 1, 3, 4, 8, 0), note: '', auto: false, files: 2, chapters: 1, chapterWords: 900, skipped: [] },
];

const CH3 = 'chapters/第一卷/003-深處.txt';
const PLOT3 = '.novelwarden/summaries/第一卷/003-深處.md';
const LIN = '.novelwarden/characters/林昭.md';
const CH13 = 'chapters/第一卷/013-新章.txt';
const DRAFT13 = 'drafts/013-新章.txt';

/** 手動那個跟現在比：改過兩份、刪掉一份、新建兩份，另有 37 份一樣。 */
const DIFF = {
  id: MANUAL_ID,
  unchanged: 37,
  entries: [
    { path: PLOT3, kind: 'plot', status: 'changed', wordsThen: 800, wordsNow: 820, hashNow: 'h-plot3' },
    { path: LIN, kind: 'character', status: 'deleted', wordsThen: 1200 },
    { path: CH3, kind: 'chapter', status: 'changed', wordsThen: 3011, wordsNow: 2870, hashNow: 'h-ch3' },
    { path: CH13, kind: 'chapter', status: 'added', wordsNow: 2870, hashNow: 'h-ch13' },
    { path: DRAFT13, kind: 'draft', status: 'added', wordsNow: 120, hashNow: 'h-draft13' },
  ],
};

function harness(opts = {}) {
  const ui = mount(opts);
  const $ = (sel) => ui.doc.querySelector(sel);
  const $$ = (sel) => [...ui.doc.querySelectorAll(sel)];
  const modal = () => ui.doc.getElementById('providerModal');
  const h = {
    ui,
    $,
    $$,
    modal,
    isOpen: () => !modal().classList.contains('hidden') && !!$('#providerModalBody .cp-panel'),
    toolbarBtn: () => $('#projectTabs [data-form="checkpoints"]'),
    open() {
      ui.clickEl(h.toolbarBtn());
    },
    list(entries = CHECKPOINTS, extra = {}) {
      ui.post({ type: 'checkpoints', entries, ...extra });
    },
    rows: () => $$('.cp-list .cp-row'),
    row: (id) => $(`.cp-row[data-id="${id}"]`),
    btn(root, label) {
      return [...root.querySelectorAll('button')].find((b) => b.textContent === label);
    },
    status: () => $('.cp-list-view .cp-status'),
    groups: () => $$('.cp-diff-view .cp-group').map((g) => g.querySelector('.cp-group-head').textContent),
    fileRow: (path) => $(`.cp-file[data-path="${path}"]`),
    esc() {
      ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    },
    /** 開彈窗、收列表、點手動那一行的「跟現在比」、收比較結果。 */
    openDiff(diff = DIFF) {
      h.open();
      h.list();
      ui.clickEl(h.btn(h.row(diff.id), '跟現在比'));
      ui.post({ type: 'checkpointDiff', id: diff.id, diff });
    },
    lastRestore: () => plain(ui.last('restoreCheckpoint')?.request),
  };
  ui.post({ type: 'state', state: viewState() });
  ui.post({ type: 'project', tree: sampleTree() });
  return h;
}

describe('存檔點 · 工具欄與列表', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('工程頁頁籤條最右邊、重新整理的左邊是存檔點（⚑，只放圖示）', () => {
    const btn = h.toolbarBtn();
    assert.ok(btn, '頁籤條上沒有存檔點');
    assert.equal(btn.textContent, '⚑');
    assert.equal(btn.getAttribute('aria-label'), '存檔點');
    assert.match(btn.title, /^存檔點：/);
    assert.ok(btn.previousElementSibling.classList.contains('spacer'));
    assert.equal(btn.nextElementSibling.dataset.action, 'refresh');
  });

  test('點了開彈窗、發 listCheckpoints、先說「正在讀…」', () => {
    const before = h.ui.sent.length;
    h.open();
    assert.ok(h.isOpen());
    assert.equal(h.$('#providerModalTitle').textContent, '存檔點');
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'listCheckpoints' }]);
    assert.equal(h.status().textContent, '正在讀…');
    assert.equal(h.rows().length, 0);
  });

  test('一行：時刻、手動 / 自動、備註、正文與檔案數；不是今年的帶年份', () => {
    h.list();
    assert.equal(h.status().classList.contains('hidden'), true);
    const texts = (id) => {
      const row = h.row(id);
      return {
        time: row.querySelector('.cp-time').textContent,
        badge: row.querySelector('.cp-badge').textContent,
        note: row.querySelector('.cp-note').textContent,
        meta: row.querySelector('.cp-row-meta').textContent,
      };
    };
    assert.deepEqual(h.rows().map((r) => r.dataset.id), [MANUAL_ID, AUTO_ID, OLD_ID]);
    assert.deepEqual(texts(MANUAL_ID), { time: '10-20 22:30', badge: '手動', note: '第一卷寫完', meta: '正文 12 章 · 3.6 萬字 · 40 份檔案' });
    assert.deepEqual(texts(AUTO_ID), {
      time: '10-19 09:05', badge: '自動', note: '批次寫章之前（第 12–20 章）',
      meta: '正文 11 章 · 3011 字 · 38 份檔案 · 2 份超過 2 MB 沒存',
    });
    assert.deepEqual(texts(OLD_ID), { time: `${YEAR - 1}-03-04 08:00`, badge: '手動', note: '（沒寫備註）', meta: '正文 1 章 · 900 字 · 2 份檔案' });
    assert.ok(h.row(OLD_ID).querySelector('.cp-note').classList.contains('is-empty'));
  });

  test('超過 2 MB 沒存的那幾份掛在提示上', () => {
    const skipped = h.row(AUTO_ID).querySelector('.cp-skipped');
    assert.equal(skipped.title, 'chapters/超大的一章.txt\ndrafts/超大的草稿.txt');
    assert.equal(h.row(MANUAL_ID).querySelector('.cp-skipped'), null);
  });

  test('只有自動的有「留住…」，提示裡說寫了備註就不會被裁掉', () => {
    assert.ok(!h.btn(h.row(MANUAL_ID), '留住…'));
    assert.ok(!h.btn(h.row(OLD_ID), '留住…'));
    const keep = h.btn(h.row(AUTO_ID), '留住…');
    assert.ok(keep);
    assert.match(keep.title, /寫了備註就不會被自動裁掉/);
  });

  test('「留住…」攤開一格（填著原來那句），「留住」發 noteCheckpoint', () => {
    h.ui.clickEl(h.btn(h.row(AUTO_ID), '留住…'));
    const input = h.row(AUTO_ID).querySelector('.cp-keep-input');
    assert.ok(input, '沒攤開');
    assert.equal(input.value, '批次寫章之前（第 12–20 章）');
    input.value = '  第二捲開寫前  ';
    input.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(h.btn(h.row(AUTO_ID), '留住'));
    assert.deepEqual(plain(h.ui.last('noteCheckpoint')), { type: 'noteCheckpoint', id: AUTO_ID, note: '第二捲開寫前' });
    assert.equal(h.row(AUTO_ID).querySelector('.cp-keep-input'), null, '發了之後收起');
  });

  test('「存一個存檔點」發 createCheckpoint、清空輸入框；列表回來之前「正在存…」、按鈕置灰', () => {
    const input = h.$('.cp-note-input');
    const save = h.$('.cp-save');
    assert.equal(input.placeholder, '備註（可以空著），比如：第一卷寫完');
    input.value = '  第一卷寫完  ';
    h.ui.clickEl(save);
    assert.deepEqual(plain(h.ui.last('createCheckpoint')), { type: 'createCheckpoint', note: '第一卷寫完' });
    assert.equal(input.value, '');
    assert.equal(h.status().textContent, '正在存…');
    assert.equal(save.disabled, true);
    h.list();
    assert.equal(save.disabled, false);
    assert.equal(h.status().classList.contains('hidden'), true);
  });

  test('輸入框裡回車也存（備註可以空著）', () => {
    const before = h.ui.sent.length;
    h.$('.cp-note-input').dispatchEvent(new h.ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'createCheckpoint', note: '' }]);
    h.list();
  });

  test('空列表：說什麼時候會自動存', () => {
    h.list([]);
    assert.equal(h.rows().length, 0);
    assert.equal(
      h.$('.cp-list .cp-empty').textContent,
      '還沒有存檔點。批次寫章、全書替換這類批次動作之前會自動存一個；也可以現在存一個。'
    );
  });

  test('unavailable：照實說，輸入框與按鈕置灰，點了不發', () => {
    h.list([], { unavailable: '還不是小說工程：先初始化。' });
    assert.equal(h.status().textContent, '還不是小說工程：先初始化。');
    assert.equal(h.$('.cp-note-input').disabled, true);
    assert.equal(h.$('.cp-save').disabled, true);
    assert.equal(h.$('.cp-list .cp-empty'), null);
    h.list();
    assert.equal(h.$('.cp-save').disabled, false);
  });

  test('Esc 關：彈窗藏起、面板丟掉；之後再到的列表不畫', () => {
    h.esc();
    assert.equal(h.modal().classList.contains('hidden'), true);
    assert.equal(h.$('#providerModalBody').children.length, 0);
    h.list();
    assert.equal(h.modal().classList.contains('hidden'), true);
    assert.equal(h.$('.cp-panel'), null);
  });

  test('× 也關；再開啟從頭要一次', () => {
    h.open();
    h.list();
    h.ui.clickEl(h.$('#providerModalClose'));
    assert.equal(h.isOpen(), false);
    const before = h.ui.sent.length;
    h.open();
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'listCheckpoints' }]);
    assert.equal(h.status().textContent, '正在讀…');
    h.esc();
  });

  test('後端的 prompt 中途佔了這一層：推來的列表不往上畫，Esc 交給 prompt', () => {
    h.open();
    h.ui.post({ type: 'prompt', requestId: 'p1', kind: 'confirm', title: '繼續嗎？', actions: ['繼續'] });
    h.list();
    assert.equal(h.$('#providerModalTitle').textContent, '繼續嗎？');
    assert.equal(h.$('.cp-panel'), null);
    h.esc();
    // 取消回的是 `value: undefined`（拍平之後沒有這個鍵）。
    assert.deepEqual(plain(h.ui.last('promptResult')), { type: 'promptResult', requestId: 'p1' });
    assert.equal(h.modal().classList.contains('hidden'), true);
  });
});

describe('存檔點 · 跟現在比（外掛形態：沒有合併檢視）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('「跟現在比」發 checkpointDiff、先說「正在比…」，標題寫時刻與備註', () => {
    h.open();
    h.list();
    const before = h.ui.sent.length;
    h.ui.clickEl(h.btn(h.row(MANUAL_ID), '跟現在比'));
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'checkpointDiff', id: MANUAL_ID }]);
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), true);
    assert.equal(h.$('.cp-diff-title').textContent, '10-20 22:30「第一卷寫完」 ↔ 現在');
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在比…');
  });

  test('別的存檔點的比較結果不認', () => {
    h.ui.post({ type: 'checkpointDiff', id: AUTO_ID, diff: { ...DIFF, id: AUTO_ID } });
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在比…');
  });

  test('三組按 改過的 / 之後刪掉的 / 之後新建的 排、帶份數；一樣的只報個數', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.deepEqual(h.groups(), ['改過的 · 2 份', '之後刪掉的 · 1 份', '之後新建的 · 2 份']);
    assert.equal(h.$('.cp-unchanged').textContent, '另有 37 份跟現在一模一樣，不列。');
  });

  test('每份：路徑、種類、字數', () => {
    const cells = (path) => {
      const row = h.fileRow(path);
      return [row.querySelector('.cp-path').textContent, row.querySelector('.cp-kind').textContent, row.querySelector('.cp-words').textContent];
    };
    assert.deepEqual(cells(CH3), [CH3, '章節', '3,011 → 2,870 字']);
    assert.deepEqual(cells(PLOT3), [PLOT3, '細綱', '800 → 820 字']);
    assert.deepEqual(cells(LIN), [LIN, '角色卡', '當時 1,200 字']);
    assert.deepEqual(cells(CH13), [CH13, '章節', '現在 2,870 字']);
    assert.deepEqual(cells(DRAFT13), [DRAFT13, '草稿', '現在 120 字']);
  });

  test('沒有內建編輯器（外掛形態）：沒有「對比」；改過的、刪掉的能退回，新建的沒有按鈕', () => {
    assert.equal(h.$$('.cp-diff-view .cp-compare').length, 0);
    assert.ok(h.btn(h.fileRow(CH3), '退回這一份'));
    assert.ok(h.btn(h.fileRow(LIN), '退回這一份'));
    assert.equal(h.fileRow(CH13).querySelectorAll('button').length, 0);
  });

  test('退回這一份：第一下只換字，點別處退回第一段', () => {
    const btn = () => h.btn(h.fileRow(CH3), '退回這一份') ?? h.btn(h.fileRow(CH3), '確定退回這一份？');
    const before = h.ui.sent.length;
    h.ui.clickEl(btn());
    assert.equal(btn().textContent, '確定退回這一份？');
    assert.ok(btn().classList.contains('is-armed'));
    assert.equal(h.ui.sent.length, before, '第一下不該發');
    h.ui.clickEl(h.$('.cp-diff-title'));
    assert.equal(btn().textContent, '退回這一份');
    assert.ok(!btn().classList.contains('is-armed'));
    // 點另一份的「退回這一份」：前一份退回第一段，這一份換字。
    h.ui.clickEl(btn());
    h.ui.clickEl(h.btn(h.fileRow(LIN), '退回這一份'));
    assert.equal(btn().textContent, '退回這一份');
    assert.ok(h.btn(h.fileRow(LIN), '確定退回這一份？'));
    assert.equal(h.ui.sent.length, before);
    h.ui.clickEl(h.$('.cp-diff-title'));
  });

  test('退回這一份：第二下發 restoreCheckpoint，樂觀鎖是這一份的 hashNow；外掛形態 dirty 是空的', () => {
    h.ui.clickEl(h.btn(h.fileRow(CH3), '退回這一份'));
    h.ui.clickEl(h.btn(h.fileRow(CH3), '確定退回這一份？'));
    assert.deepEqual(h.lastRestore(), { id: MANUAL_ID, paths: [CH3], trash: [], expect: { [CH3]: 'h-ch3' }, dirty: [] });
  });

  test('退回期間說「正在退回…」、按鈕全置灰；後端重推之後停在這一頁重畫', () => {
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '正在退回…');
    assert.ok(h.$$('.cp-diff-view .cp-file button, .cp-restore-all').every((b) => b.disabled));
    // 後端：先重推列表（多了「退回之前」那一個），再重推這個存檔點的比較。
    const before = { id: '2026-10-20_23-00-00+0800', time: at(YEAR, 10, 20, 23, 0), note: '退回到「10-20 22:30」之前', auto: true, files: 40, chapters: 12, chapterWords: 36000, skipped: [] };
    h.list([before, ...CHECKPOINTS]);
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), true, '不該跳回列表');
    const rest = { ...DIFF, unchanged: 38, entries: DIFF.entries.filter((e) => e.path !== CH3) };
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: rest });
    assert.deepEqual(h.groups(), ['改過的 · 1 份', '之後刪掉的 · 1 份', '之後新建的 · 2 份']);
    assert.equal(h.$('.cp-diff-view .cp-status'), null);
    assert.ok(!h.$('.cp-restore-all').disabled);
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
  });

  test('刪掉的那一份退回：樂觀鎖是 null（當時磁碟上沒有它）', () => {
    h.ui.clickEl(h.btn(h.fileRow(LIN), '退回這一份'));
    h.ui.clickEl(h.btn(h.fileRow(LIN), '確定退回這一份？'));
    assert.deepEqual(h.lastRestore(), { id: MANUAL_ID, paths: [LIN], trash: [], expect: { [LIN]: null }, dirty: [] });
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
  });

  test('整本退回（不勾）：改過的 + 刪掉的，新建的不動', () => {
    const box = h.$('.cp-trash input');
    assert.equal(h.$('.cp-trash').textContent, '也把存檔點之後新建的 2 份搬進回收站');
    assert.equal(box.checked, false);
    const whole = h.$('.cp-restore-all');
    assert.equal(whole.textContent, '整本退回');
    h.ui.clickEl(whole);
    assert.equal(whole.textContent, '確定整本退回（3 份）');
    assert.ok(whole.classList.contains('is-armed'));
    h.ui.clickEl(whole);
    const req = h.lastRestore();
    assert.deepEqual([...req.paths].sort(), [CH3, LIN, PLOT3].sort());
    assert.deepEqual(req.trash, []);
    assert.deepEqual(req.expect, { [PLOT3]: 'h-plot3', [LIN]: null, [CH3]: 'h-ch3' });
    assert.deepEqual(req.dirty, []);
    assert.equal(req.id, MANUAL_ID);
    assert.equal(h.$('.cp-foot-hint').textContent, '退回之前會先自動存一個存檔點，退回也能撤回；編輯器裡沒儲存的檔案會跳過。');
  });

  test('整本退回（勾上）：新建的那幾份進 trash，樂觀鎖一起帶；重推之後勾選框回到不勾', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    const box = h.$('.cp-trash input');
    h.ui.clickEl(h.$('.cp-restore-all'));
    // 勾一下：點在別處，已經換了字的整本退回退回第一段（份數要變）。
    box.click();
    assert.equal(box.checked, true);
    assert.equal(h.$('.cp-restore-all').textContent, '整本退回');
    h.ui.clickEl(h.$('.cp-restore-all'));
    assert.equal(h.$('.cp-restore-all').textContent, '確定整本退回（5 份）');
    h.ui.clickEl(h.$('.cp-restore-all'));
    const req = h.lastRestore();
    assert.deepEqual([...req.paths].sort(), [CH3, LIN, PLOT3].sort());
    assert.deepEqual([...req.trash].sort(), [CH13, DRAFT13].sort());
    assert.deepEqual(req.expect, { [PLOT3]: 'h-plot3', [LIN]: null, [CH3]: 'h-ch3', [CH13]: 'h-ch13', [DRAFT13]: 'h-draft13' });
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.equal(h.$('.cp-trash input').checked, false);
  });

  test('只剩新建的：不勾時整本退回置灰', () => {
    const onlyAdded = { ...DIFF, entries: DIFF.entries.filter((e) => e.status === 'added') };
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: onlyAdded });
    assert.equal(h.$('.cp-restore-all').disabled, true);
    h.$('.cp-trash input').click();
    assert.equal(h.$('.cp-restore-all').disabled, false);
  });

  test('出錯、一模一樣照實說', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, error: '這個存檔點不在了（可能被裁掉了）。' });
    assert.equal(h.$('.cp-diff-view .cp-status').textContent, '這個存檔點不在了（可能被裁掉了）。');
    assert.ok(h.$('.cp-diff-view .cp-status').classList.contains('is-error'));
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: { id: MANUAL_ID, unchanged: 40, entries: [] } });
    assert.equal(h.$('.cp-same').textContent, '跟現在一模一樣（40 份），沒有可退回的。');
    assert.equal(h.$('.cp-restore-all'), null);
  });

  test('「← 返回列表」：回到列表，之後到的比較結果不認', () => {
    h.ui.clickEl(h.btn(h.$('.cp-diff-head'), '← 返回列表'));
    assert.equal(h.$('.cp-list-view').classList.contains('hidden'), false);
    assert.equal(h.$('.cp-diff-view').classList.contains('hidden'), true);
    assert.equal(h.rows().length, 4);
    h.ui.post({ type: 'checkpointDiff', id: MANUAL_ID, diff: DIFF });
    assert.equal(h.$('.cp-diff-view').classList.contains('hidden'), true);
    assert.equal(h.$$('.cp-diff-view .cp-file').length, 0);
  });
});

describe('存檔點 · 獨立版（有合併檢視與內建編輯器）', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'],
    });
    h.ui.window.__nfToast = () => {};
  });

  test('「對比」只給改過的與刪掉的；點了關掉彈窗，沒開著的那份先開成臨時標籤，進了編輯區就開對比標籤', async () => {
    h.openDiff();
    assert.ok(h.btn(h.fileRow(CH3), '對比'));
    assert.ok(h.btn(h.fileRow(LIN), '對比'));
    assert.ok(!h.btn(h.fileRow(CH13), '對比'));
    const before = h.ui.sent.length;
    h.ui.clickEl(h.btn(h.fileRow(CH3), '對比'));
    assert.equal(h.isOpen(), false, '彈窗關掉');
    assert.deepEqual(plain(h.ui.sent.slice(before)), [{ type: 'openEditor', path: CH3, preview: true }]);
    h.ui.post({ type: 'editorOpen', file: file(CH3, '現在的正文', { kind: 'chapter' }), preview: true });
    await new Promise((r) => setImmediate(r));
    assert.ok(h.ui.doc.querySelector('.ed-tab-special[data-special="version-diff"]'), '開了對比標籤');
    assert.equal(plain(h.ui.last('readVersion')).id, `cp:${MANUAL_ID}`);
    // 後面幾條要面板開著。
    h.openDiff();
  });

  test('合併檢視蓋在上面時 Esc 不關底下的面板', () => {
    const merge = h.ui.doc.getElementById('mergeModal');
    merge.classList.remove('hidden');
    h.esc();
    assert.ok(h.isOpen(), '面板不該被關');
    merge.classList.add('hidden');
  });

  test('內建編輯器裡開著、改過沒存的那一份進 dirty（nf-dirty-query）', () => {
    // 細綱開著、沒改；正文開著、改了沒存。
    h.ui.post({ type: 'editorOpen', file: file(PLOT3, '細綱', { kind: 'plot' }) });
    h.ui.post({ type: 'editorOpen', file: file(CH3, '舊的正文', { kind: 'chapter' }) });
    const area = h.ui.doc.getElementById('edArea');
    assert.equal(area.value, '舊的正文');
    area.value = '舊的正文，又寫了一句';
    area.dispatchEvent(new h.ui.window.Event('input', { bubbles: true }));
    h.ui.clickEl(h.$('.cp-restore-all'));
    h.ui.clickEl(h.$('.cp-restore-all'));
    assert.deepEqual(h.lastRestore().dirty, [CH3]);
  });

  test('Esc 關', () => {
    h.esc();
    assert.equal(h.isOpen(), false);
  });
});
