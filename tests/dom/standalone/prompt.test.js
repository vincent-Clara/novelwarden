/**
 * 獨立版的小彈窗（media/src/view/prompt.ts）：右上角 ×、Esc 都按「取消」回後端；點遮罩空白不關。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | × 關確認框 | 回 `undefined`（與「取消」按鈕同一個回答），遮罩收起——只藏遮罩不回話，後端那頭會一直等 |
 * | × 關選擇框 / Esc 關輸入框 | 回 `undefined` |
 * | 點遮罩空白 | 不關、不回話——誤觸不該丟掉填到一半的內容 |
 * | 回過一次就不再回 | 輸入框裡的 Esc 與全域 Esc 同時觸發也只回一條 |
 * | 確認框寫出補充說明 | `Host.confirm` 的 detail（調幾次、看哪幾章、會覆蓋什麼）原來在網頁上整段丟了 |
 * | 確認框一個 action 一顆按鈕 | 回的是按鈕上的字。從前只畫「確定 / 取消」，第二個 action（「全部直接採納並開始」「保留原樣」……）點不到 |
 * | 調模型之前的那一問（`call`） | 兩個下拉框（按分檔 + 各模型；四級詳細度），按分檔時列出各項活交給誰；回答帶 `choice`；不看詳細度時只有模型那一個 |
 * | 選本機檔案（`kind: 'file'`） | 從給的目錄起步；只列目錄與允許的副檔名；確定回絕對路徑，Esc / 取消回 undefined；粘完整路徑回車直接選定 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

describe('小彈窗的關閉', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('providerModal');
  /** jsdom 那一側造的物件跨 realm，deepEqual 認不出，拆成欄位比。 */
  const answer = () => {
    const m = ui.last('promptResult');
    return [m.requestId, m.value];
  };
  const results = () => ui.sent.filter((m) => m.type === 'promptResult');
  const open = (extra) => ui.post({ type: 'prompt', title: '從參考書學', ...extra });
  const esc = (target) => target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('× 關確認框：回 undefined，遮罩收起', () => {
    open({ requestId: 'c1', kind: 'confirm', message: '現在開始？', actions: ['開始'] });
    assert.ok(!modal().classList.contains('hidden'));
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['c1', undefined]);
    assert.ok(modal().classList.contains('hidden'));
  });

  test('× 關選擇框：回 undefined', () => {
    open({ requestId: 'k1', kind: 'pick', options: ['兩樣都學', '只學文風'] });
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['k1', undefined]);
  });

  test('點遮罩空白：不關、不回話', () => {
    open({ requestId: 'k2', kind: 'pick', options: ['兩樣都學'] });
    const before = results().length;
    ui.clickEl(modal());
    assert.equal(results().length, before);
    assert.ok(!modal().classList.contains('hidden'));
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    assert.deepEqual(answer(), ['k2', undefined]);
  });

  test('輸入框裡按 Esc：只回一條', () => {
    const before = results().length;
    open({ requestId: 'i1', kind: 'input', value: '' });
    esc(modal().querySelector('input'));
    assert.equal(results().length, before + 1);
    assert.deepEqual(answer(), ['i1', undefined]);
  });

  test('彈窗關著時點 ×、按 Esc：什麼都不回', () => {
    const before = results().length;
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    esc(ui.doc.body);
    assert.equal(results().length, before);
  });

  test('確認框寫出補充說明，一行一段', () => {
    open({ requestId: 'c2', kind: 'confirm', message: '現在開始？', value: '檔案：D:\\書\\a.txt（UTF-8）\n\n只學怎麼寫。' });
    const lines = [...modal().querySelectorAll('.prompt-detail')].map((p) => p.textContent);
    assert.deepEqual(lines, ['檔案：D:\\書\\a.txt（UTF-8）', '只學怎麼寫。']);
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
  });

  test('確認框一個 action 一顆按鈕，回的是按鈕上的字', () => {
    open({ requestId: 'c3', kind: 'confirm', message: '更新 3 張角色卡？', actions: ['逐張確認後開始', '全部直接採納並開始'] });
    const labels = [...modal().querySelectorAll('.actions button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['逐張確認後開始', '全部直接採納並開始', '取消']);
    assert.ok(modal().querySelector('.actions button').classList.contains('primary'));
    ui.clickEl([...modal().querySelectorAll('.actions button')][1]);
    assert.deepEqual(answer(), ['c3', '全部直接採納並開始']);
    assert.equal(ui.last('promptResult').choice, undefined);
  });
});

describe('調模型之前的那一問（confirm 帶 call）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const modal = () => ui.doc.getElementById('providerModal');
  const selects = () => [...modal().querySelectorAll('.call-picker select')];
  const tiers = () => modal().querySelector('.call-tiers');
  const CALL = {
    models: [
      { ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: '智譜 GLM' },
      { ref: 'or/claude', label: 'claude', group: 'OpenRouter' },
    ],
    model: '',
    tiers: ['批次寫正文 → 均衡檔：glm/glm-4-plus'],
    contextDetail: 3,
  };
  const open = (extra) =>
    ui.post({ type: 'prompt', title: '開始寫章', kind: 'confirm', message: '要寫 3 章？', actions: ['開始寫章'], call: CALL, ...extra });
  const choose = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  };

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('兩個下拉框：預設按分檔、開啟時那一級；按分檔時列出各項活交給誰', () => {
    open({ requestId: 'k1' });
    const [model, detail] = selects();
    assert.equal(model.value, '');
    assert.deepEqual([...model.options].map((o) => o.value), ['', 'glm/glm-4-plus', 'or/claude']);
    assert.equal(detail.value, '3');
    assert.ok(!tiers().classList.contains('hidden'));
    assert.ok(tiers().textContent.includes('均衡檔'));
  });

  test('挑了模型：那幾行收起；點按鈕回按鈕上的字與作者的選擇', () => {
    const [model, detail] = selects();
    choose(model, 'or/claude');
    assert.ok(tiers().classList.contains('hidden'));
    choose(detail, '1');
    ui.clickEl(modal().querySelector('.actions button.primary'));
    const m = ui.last('promptResult');
    assert.deepEqual([m.requestId, m.value], ['k1', '開始寫章']);
    assert.equal(JSON.stringify(m.choice), JSON.stringify({ model: 'or/claude', contextDetail: 1 }));
  });

  // 細綱試點（2026-10-25）：轉寫不跟這一次挑的模型，那一行挑了模型也照樣顯示。
  test('不跟這一次挑的模型的活（轉寫）：挑了模型也照樣顯示', () => {
    open({ requestId: 'k4', call: { ...CALL, fixed: ['轉寫 · 整理成 JSON → 快速檔：glm/glm-4-air（不跟這一次挑的模型）'] } });
    const [model] = selects();
    choose(model, 'or/claude');
    assert.ok(tiers().classList.contains('hidden'));
    const fixed = [...modal().querySelectorAll('.call-picker > p.hint')].find((p) => p.textContent.includes('轉寫'));
    assert.ok(fixed && !fixed.classList.contains('hidden'), modal().querySelector('.call-picker').innerHTML);
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
  });

  test('這一次不看詳細度：只有模型那一個下拉框', () => {
    open({ requestId: 'k2', call: { ...CALL, contextDetail: undefined } });
    assert.equal(selects().length, 1);
    ui.clickEl(modal().querySelector('.actions button.primary'));
    assert.equal(JSON.stringify(ui.last('promptResult').choice), JSON.stringify({}));
  });

  test('取消：不帶選擇', () => {
    open({ requestId: 'k3' });
    ui.clickEl(ui.doc.getElementById('providerModalClose'));
    const m = ui.last('promptResult');
    assert.deepEqual([m.requestId, m.value, m.choice], ['k3', undefined, undefined]);
  });
});

describe('選本機檔案', { skip: JSDOM_SKIP }, () => {
  let ui;
  const picker = () => ui.doc.querySelector('.nf-picker');
  const rows = () => [...picker().querySelectorAll('.nf-picker-row')].map((r) => r.textContent.replace(/^[📁📄]/u, ''));
  const answer = () => {
    const m = ui.last('promptResult');
    return m && [m.requestId, m.value];
  };
  const listing = (path, entries) => ui.post({ type: 'hostDir', path, parent: 'D:\\', entries, truncated: 0 });
  const ENTRIES = [
    { name: '子目錄', kind: 'dir', absPath: 'D:\\書\\子目錄' },
    { name: '參考.txt', kind: 'file', absPath: 'D:\\書\\參考.txt' },
    { name: '大寫.TXT', kind: 'file', absPath: 'D:\\書\\大寫.TXT' },
    { name: '封面.jpg', kind: 'file', absPath: 'D:\\書\\封面.jpg' },
  ];
  const openFile = (requestId) =>
    ui.post({ type: 'prompt', requestId, kind: 'file', title: '從參考書學寫法：選一本 txt', value: 'D:\\工程', options: ['txt'] });

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js'] });
  });

  test('開啟時從給的目錄起步，標題寫明副檔名', () => {
    openFile('f1');
    assert.ok(picker().classList.contains('open'));
    assert.equal(ui.last('listHostDir').path, 'D:\\工程');
    assert.equal(picker().querySelector('h2').textContent, '從參考書學寫法：選一本 txt（.txt）');
  });

  test('只列目錄與 txt（不分大小寫）；選中再點確定，回絕對路徑', () => {
    listing('D:\\書', ENTRIES);
    assert.deepEqual(rows(), ['..', '子目錄', '參考.txt', '大寫.TXT']);
    const ok = picker().querySelector('.nf-picker-actions .primary');
    assert.equal(ok.disabled, true);
    ui.clickEl([...picker().querySelectorAll('.nf-picker-row')].find((r) => r.textContent.includes('參考.txt')));
    assert.equal(ok.disabled, false);
    ui.clickEl(ok);
    assert.deepEqual(answer(), ['f1', 'D:\\書\\參考.txt']);
    assert.ok(!picker().classList.contains('open'));
  });

  test('Esc 關掉：回 undefined', () => {
    openFile('f2');
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.deepEqual(answer(), ['f2', undefined]);
    assert.ok(!picker().classList.contains('open'));
  });

  test('點取消：回 undefined', () => {
    openFile('f3');
    ui.clickEl([...picker().querySelectorAll('.nf-picker-actions button')].find((b) => b.textContent === '取消'));
    assert.deepEqual(answer(), ['f3', undefined]);
  });

  test('路徑框裡粘一個 txt 的完整路徑回車：直接當選定', () => {
    openFile('f4');
    const input = picker().querySelector('input');
    input.value = 'E:\\下載\\某書.txt';
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(answer(), ['f4', 'E:\\下載\\某書.txt']);
  });
});
