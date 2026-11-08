/**
 * 兩個彈窗（W3 表單 · W4 一句話 · W5 拆細綱）與主按鈕上的呼叫次數。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 一句話 · 主按鈕 | 「生成小說配置」開啟表單而不直接傳送；預設值來自後端；提交發 send 帶 setup、切到對話頁 |
 * | 一句話 · 校驗 | 腦洞空著不許提交；全書字數實時算；Esc 關掉什麼都不發 |
 * | 拆細綱 | 預設區間、實時說明（跳過幾章、分幾批、預計與最多幾次）與後端同一個純函式；提交帶 call |
 * | 拆細綱 · 越界 | 超出大綱覆蓋時不許提交，並說清先續寫大綱 |
 * | 呼叫次數 | 主按鈕提示後面寫「預計 2 次呼叫，最多 29 次」（第 4 條；細綱試點起多一次轉寫） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, workbenchView, sampleTree, viewState } = require('../../helpers/dom');

const modal = (ui) => ui.doc.getElementById('providerModal');
const isOpen = (ui) => !modal(ui).classList.contains('hidden');
const note = (ui) => ui.doc.querySelector('.nf-form .form-note')?.textContent ?? '';
const field = (ui, key) => ui.doc.querySelector(`.nf-form [data-key="${key}"]`);
const submitBtn = (ui) => ui.doc.querySelector('.nf-form .modal-foot button.primary');
function type(ui, key, value) {
  const input = field(ui, key);
  input.value = String(value);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
function key(ui, target, k, extra = {}) {
  target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
}
/** 工程頁某一組的標題欄右鍵，點其中一項。三個批次入口從前在工具欄上，現在只在分組右鍵裡。 */
function pickFromGroup(ui, group, label) {
  const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent === group);
  ui.pick(ui.rightClick(head), label);
}

describe('一句話彈窗 · 從主按鈕開啟', { skip: JSDOM_SKIP }, () => {
  let ui;
  const goBtn = () => ui.doc.getElementById('nextStepBtn');
  const hint = () => ui.doc.getElementById('nextStepHint').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'setting', title: '架構 · 小說配置' }),
      next: {
        stage: 'setting',
        capability: 'generate',
        label: '生成小說配置',
        hint: '先把這個腦洞展開成一份小說配置。',
        target: { kind: 'setting', doc: 'config' },
        form: 'idea',
        calls: { low: 1, high: 1, max: 3 },
        formDefaults: { idea: '少年入宗', totalChapters: 60, wordsPerChapter: 2500, configHasContent: true },
      },
    });
  });

  test('主按鈕寫明要先填表，提示裡帶呼叫次數', () => {
    assert.equal(goBtn().textContent, '生成小說配置…');
    assert.ok(hint().includes('（預計 1 次呼叫，最多 3 次）'), hint());
  });

  test('點主按鈕開啟表單，不直接傳送', () => {
    ui.sent.length = 0;
    ui.clickEl(goBtn());
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });

  test('預設值來自後端：一句話原文與規模', () => {
    assert.equal(field(ui, 'idea').value, '少年入宗');
    assert.equal(field(ui, 'totalChapters').value, '60');
    assert.equal(field(ui, 'wordsPerChapter').value, '2500');
  });

  // 後端就是這麼合的：配置寫過東西時保留原文、生成的追加在後。
  test('配置已有內容時明說「保留原文，追加生成」', () => {
    assert.ok(ui.doc.querySelector('.nf-form .form-lead').textContent.includes('保留原文'));
  });

  test('全書字數實時算', () => {
    assert.ok(note(ui).includes('全書約 15 萬字'), note(ui));
    type(ui, 'totalChapters', 100);
    type(ui, 'wordsPerChapter', 3000);
    assert.ok(note(ui).includes('全書約 30 萬字'), note(ui));
  });

  // 2026-10-25 起配置寫完轉寫一次：只報數，原因太長不進這一行。
  test('說明裡報配置的呼叫次數，不帶原因', () => {
    assert.ok(note(ui).includes('預計 2 次呼叫，最多 5 次 · Ctrl+Enter 提交'), note(ui));
  });

  test('Ctrl+Enter 提交：切到對話頁，發 send 帶 setup', () => {
    ui.sent.length = 0;
    type(ui, 'idea', '一個從火裡活下來的人回到起火的地方');
    key(ui, field(ui, 'idea'), 'Enter', { ctrlKey: true });
    const send = ui.last('send');
    assert.ok(send, JSON.stringify(ui.sent));
    assert.equal(send.payload.text, '一個從火裡活下來的人回到起火的地方');
    assert.equal(send.payload.stage, 'setting');
    assert.equal(JSON.stringify(send.payload.target), JSON.stringify({ kind: 'setting', doc: 'config' }));
    assert.equal(JSON.stringify(send.payload.setup), JSON.stringify({ totalChapters: 100, wordsPerChapter: 3000 }));
    assert.equal(ui.last('switchTab')?.tab, 'chat');
    assert.ok(!isOpen(ui));
    ui.post({ type: 'busy', value: false });
  });
});

describe('一句話彈窗 · 校驗與關閉', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'project', tree: sampleTree() });
    // 故事架構組右鍵「從一句話生成小說配置…」也能開啟它。
    const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '故事架構');
    ui.pick(ui.rightClick(head), '從一句話生成小說配置…');
  });

  test('從工程頁也能開啟，預設值來自工程頁快照', () => {
    assert.ok(isOpen(ui));
    assert.equal(field(ui, 'idea').value, '一個從火裡活下來的人回到起火的地方。');
    assert.equal(field(ui, 'totalChapters').value, '30');
  });

  test('腦洞空著不許提交，並說清為什麼', () => {
    type(ui, 'idea', '');
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('還空著'), note(ui));
  });

  test('規模越界不許提交', () => {
    type(ui, 'idea', '少年入宗');
    type(ui, 'totalChapters', 0);
    assert.ok(submitBtn(ui).disabled, note(ui));
    type(ui, 'totalChapters', 30);
    assert.ok(!submitBtn(ui).disabled, note(ui));
  });

  test('Esc 關掉，什麼都不發', () => {
    ui.sent.length = 0;
    key(ui, ui.doc, 'Escape');
    assert.ok(!isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });
});

describe('拆細綱彈窗', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    pickFromGroup(ui, '章節', '批次拆細綱…');
  });

  // 下一可寫章是第 4 章，預設拆 5 章，不越過大綱覆蓋（20）與總章數（30）。
  test('預設區間是下一可寫章起 5 章', () => {
    assert.ok(isOpen(ui));
    assert.equal(field(ui, 'from').value, '4');
    assert.equal(field(ui, 'to').value, '8');
  });

  // 第 4 章排過細綱：跳過它，第 5–8 章一批。已經有敘事線，不先排線。與後端 planPlotBatches 同一個演算法。
  test('實時說明：拆幾章、跳過幾章、分幾批、預計與最多', () => {
    assert.ok(note(ui).includes('要拆 4 章，分 1 批（每批最多 5 章），跳過已有細綱的 1 章'), note(ui));
    assert.ok(note(ui).includes('預計 2 次呼叫，最多 23 次'), note(ui));
    assert.ok(!note(ui).includes('敘事線'), note(ui));
  });

  test('改區間說明跟著變', () => {
    type(ui, 'from', 1);
    type(ui, 'to', 12);
    // 第 1、3、4 章排過：2 一批，5–9 一批，10–12 一批。
    assert.ok(note(ui).includes('要拆 9 章，分 3 批') && note(ui).includes('預計 6 次呼叫，最多 51 次'), note(ui));
  });

  // 敘事線重做（設計稿 ⚑8）：一條線都沒有時後端開拆之前先排一次，彈窗把它算進去（2026-10-25 起排 1 次、轉寫 1 次，最多 3 次）。
  test('一條敘事線都沒有：說明裡 +2 次（最多 +3），寫明先從情節大綱排一次', () => {
    key(ui, ui.doc, 'Escape');
    ui.post({ type: 'project', tree: { ...sampleTree(), threads: { lines: [], current: 0 } } });
    pickFromGroup(ui, '章節', '批次拆細綱…');
    assert.ok(note(ui).includes('預計 4 次呼叫，最多 26 次'), note(ui));
    assert.ok(note(ui).includes('還沒有敘事線：開拆之前先從情節大綱排一次（排 1 次、轉寫 1 次'), note(ui));
    key(ui, ui.doc, 'Escape');
    ui.post({ type: 'project', tree: sampleTree() });
    pickFromGroup(ui, '章節', '批次拆細綱…');
  });

  test('超出大綱覆蓋不許提交，說清先續寫大綱', () => {
    type(ui, 'to', 25);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('只覆蓋到第 20 章'), note(ui));
  });

  test('這一段都排過時不許提交', () => {
    type(ui, 'from', 3);
    type(ui, 'to', 4);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('都已經排過細綱了'), note(ui));
  });

  // 彈窗已經報過呼叫次數：帶 call（這一次的模型與詳細度，預設按分檔、設定頁那一級），後端不再彈第二個確認框（不疊彈窗）。
  test('提交發 generatePlots，帶區間與 call', () => {
    type(ui, 'from', 5);
    type(ui, 'to', 9);
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.ok(msg, JSON.stringify(ui.sent));
    assert.equal(msg.action, 'generatePlots');
    assert.equal(JSON.stringify(msg.range), JSON.stringify({ from: 5, to: 9 }));
    assert.equal(JSON.stringify(msg.call), JSON.stringify({ contextDetail: 3 }));
    assert.ok(!isOpen(ui));
  });

  test('再從章節組右鍵開啟，只開彈窗、什麼都不發', () => {
    ui.sent.length = 0;
    pickFromGroup(ui, '章節', '批次拆細綱…');
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
    key(ui, ui.doc, 'Escape');
  });

  test('故事架構組右鍵「補齊架構（只補空白）」發 completeSettings（後端先問）', () => {
    ui.sent.length = 0;
    pickFromGroup(ui, '故事架構', '補齊架構（只補空白）');
    assert.equal(ui.last('projectAction')?.action, 'completeSettings', JSON.stringify(ui.sent));
  });
});

describe('故事架構 · 第一件沒填的是小說配置時', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    const tree = sampleTree();
    tree.architecture = tree.architecture.map((a) => ({ ...a, filled: a.key === 'outline' ? false : a.key !== 'config' && a.filled }));
    tree.book = { ...tree.book, configHasContent: false, idea: '' };
    ui.post({ type: 'project', tree });
  });

  // 配置要作者先給一句話：「去生成」直接開啟一句話彈窗，不繞去對話頁。
  test('「去生成」開啟一句話彈窗', () => {
    const go = [...ui.doc.querySelectorAll('#projectBody .row-architecture .row-go')];
    assert.equal(go.length, 1);
    ui.sent.length = 0;
    ui.clickEl(go[0]);
    assert.ok(isOpen(ui));
    assert.ok(ui.doc.querySelector('.nf-form .form-lead').textContent.includes('寫下你的腦洞'));
    assert.ok(!ui.sent.some((m) => m.type === 'setTarget' || m.type === 'send'), JSON.stringify(ui.sent));
  });
});

describe('故事架構 · 已經寫了正文時生成小說配置', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    const tree = sampleTree();
    tree.architecture = tree.architecture.map((a) => ({ ...a, filled: a.key === 'outline' ? false : a.key !== 'config' && a.filled }));
    tree.book = { ...tree.book, configHasContent: false, idea: '', totalChapters: undefined, writtenThrough: 3 };
    ui.post({ type: 'project', tree });
  });

  test('「去生成」開啟的是照已寫正文生成的彈窗，補充要求可以留空', () => {
    const go = [...ui.doc.querySelectorAll('#projectBody .row-architecture .row-go')];
    ui.clickEl(go[0]);
    assert.ok(isOpen(ui));
    assert.ok(ui.doc.querySelector('.nf-form .form-lead').textContent.includes('已經寫了第 1–3 章'));
    assert.equal(field(ui, 'totalChapters').value, '100');
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const sent = ui.last('send');
    assert.ok(sent, JSON.stringify(ui.sent));
    assert.equal(sent.payload.text, '');
    assert.equal(JSON.stringify(sent.payload.target), JSON.stringify({ kind: 'setting', doc: 'config' }));
    assert.equal(sent.payload.setup.totalChapters, 100);
  });
});

/**
 * 批次寫章彈窗（四期，W9）：區間、模式、呼叫上限與後端同一個 `planWriteBatch`；
 * 「寫完即定稿」要點兩下（按鈕文案兩段式，不疊彈窗）。
 *
 * sampleTree：第 1–3 章有正文，第 1、3、4 章排過細綱，下一可寫章是第 4 章。
 */
describe('批次寫章彈窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const open = () => pickFromGroup(ui, '章節', '批次寫章…');
  function choose(value) {
    const sel = field(ui, 'mode');
    sel.value = value;
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  }

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  test('章節組右鍵「批次寫章…」開啟彈窗', () => {
    assert.ok(isOpen(ui));
  });

  test('預設從下一可寫章起 3 章、只寫正文', () => {
    assert.equal(field(ui, 'from').value, '4');
    assert.equal(field(ui, 'to').value, '6');
    assert.equal(field(ui, 'mode').value, 'draft');
  });

  // 第 5、6 章沒排細綱、大綱覆蓋到第 20 章：寫到時先拆。上限含自動續寫（一章最多 8 次）、寫前比對（比對 1 次、轉寫 1 次、
  // 重轉 1 次，最多 3 次）與拆細綱（2 章一批最多 6 次）。
  test('實時說明：寫幾章、哪幾章寫到時先拆細綱、預計與最多', () => {
    assert.ok(note(ui).includes('要寫 3 章（第 4–6 章）。第 5–6 章還沒有細綱，寫到時先拆'), note(ui));
    assert.ok(note(ui).includes('預計 5–14 次呼叫，最多 47 次'), note(ui));
  });

  test('大綱只覆蓋到第 4 章：第 5 章在它前面收住', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), book: { ...sampleTree().book, outlineCoverage: 4 } } });
    open();
    assert.ok(note(ui).includes('要寫 1 章（第 4 章）；第 5 章還沒有細綱、大綱也沒覆蓋到，寫到它前面為止。'), note(ui));
    assert.ok(note(ui).includes('預計 1–4 次呼叫，最多 12 次'), note(ui));
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  // 敘事線二期：寫前檢查的兩類提醒（零呼叫、不攔），與後端確認框同一個 `threadRemindersFor`、同一句；資料是工程頁「敘事線」那一份。
  test('敘事線提醒：區間裡寫到哪一章就過了回收章、斷了幾章，區間裡的計劃又都沒安排的，說明裡多一句', () => {
    const watch = {
      lines: [
        { name: '青崖舊案', kind: '主线', lastActive: 1, stall: 5, planned: [] },
        { name: '林昭與沈氏', kind: '感情线', lastActive: 1, stall: 15, planned: [] },
      ],
      foreshadowing: [
        { name: '玉佩的來歷', resolve: 3, planned: [] },
        { name: '殘令', resolve: 4, planned: [6] },
      ],
    };
    const tree = sampleTree();
    ui.post({ type: 'project', tree: { ...tree, threads: { ...tree.threads, watch } } });
    open();
    type(ui, 'to', 7);
    assert.ok(
      note(ui).includes(
        '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 3 章前收，寫到第 4 章還沒收，區間裡也沒安排收；〈青崖舊案〉（主線）寫到第 7 章就斷了 5 章，區間裡也沒安排推進。只是提醒，不攔。'
      ),
      note(ui)
    );
    type(ui, 'to', 6);
    assert.ok(!note(ui).includes('青崖舊案'), note(ui));
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  // 復跑之後的第三類：伏筆計劃第 a 章埋，寫到 a 之後還沒埋、區間裡也沒安排埋。與後端同一個函式、同一句。
  test('敘事線提醒：計劃埋了卻一直沒埋的伏筆，說明裡也提', () => {
    const watch = {
      lines: [],
      foreshadowing: [],
      unplanted: [
        { name: '阿婆的真實身份', plant: 2, planned: [] },
        { name: '照骨鏡', plant: 3, planned: [5] },
      ],
    };
    const tree = sampleTree();
    ui.post({ type: 'project', tree: { ...tree, threads: { ...tree.threads, watch } } });
    open();
    type(ui, 'to', 7);
    assert.ok(
      note(ui).includes('敘事線提醒：伏筆〈阿婆的真實身份〉計劃第 2 章埋，寫到第 4 章還沒埋，區間裡也沒安排埋。只是提醒，不攔。'),
      note(ui)
    );
    ui.post({ type: 'project', tree: sampleTree() });
    open();
  });

  test('一次最多 10 章', () => {
    type(ui, 'from', 1);
    type(ui, 'to', 11);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('一次最多寫 10 章'), note(ui));
  });

  test('這一段都寫過了不許提交', () => {
    type(ui, 'to', 3);
    assert.ok(submitBtn(ui).disabled);
    assert.ok(note(ui).includes('都已經寫過正文了'), note(ui));
  });

  test('寫完即定稿：說明裡加上定稿那幾次', () => {
    type(ui, 'from', 4);
    type(ui, 'to', 6);
    choose('finalize');
    assert.ok(note(ui).includes('預計 23–50 次呼叫，最多 101 次'), note(ui));
    assert.ok(note(ui).includes('每寫完一章就同步'), note(ui));
    assert.ok(note(ui).includes('由轉寫模型照抄成 JSON'), note(ui));
  });

  test('寫完即定稿要點兩下：第一下只換字，不發', () => {
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    assert.ok(isOpen(ui));
    assert.equal(submitBtn(ui).textContent, '再點一下：寫完即同步 3 章');
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
  });

  test('改了任何一個值就退回第一段', () => {
    type(ui, 'to', 5);
    assert.equal(submitBtn(ui).textContent, '開始寫章');
  });

  test('第二下才發：writeManuscripts，帶區間、模式與 call', () => {
    ui.clickEl(submitBtn(ui));
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'writeManuscripts', JSON.stringify(ui.sent));
    assert.equal(JSON.stringify(msg.range), JSON.stringify({ from: 4, to: 5 }));
    assert.equal(msg.mode, 'finalize');
    assert.equal(JSON.stringify(msg.call), JSON.stringify({ contextDetail: 3 }));
    assert.ok(!isOpen(ui));
  });

  test('只寫正文一下就發', () => {
    open();
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.mode, 'draft', JSON.stringify(ui.sent));
    assert.equal(msg.review, undefined);
  });

  // 五期補遺 §4：寫完即審稿，與模式分開選；多出審稿那幾次，也要點兩下。
  test('寫完即審稿：說明裡加上審稿那幾次，點兩下才發，帶 review', () => {
    open();
    assert.equal(field(ui, 'review').value, 'off');
    const sel = field(ui, 'review');
    sel.value = 'on';
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    assert.ok(note(ui).includes('預計 11–20 次呼叫，最多 68 次'), note(ui));
    assert.ok(note(ui).includes('報告放進一個新會話「批次審稿」'), note(ui));
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    assert.equal(submitBtn(ui).textContent, '再點一下：寫完即審稿 3 章');
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.review, true, JSON.stringify(ui.sent));
    assert.equal(msg.mode, 'draft');
  });

  test('章節組右鍵「批次寫章…」開啟同一個彈窗', () => {
    const head = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章節');
    ui.sent.length = 0;
    ui.pick(ui.rightClick(head), '批次寫章…');
    assert.ok(isOpen(ui));
    assert.ok(!ui.sent.some((m) => m.type === 'projectAction'), JSON.stringify(ui.sent));
    key(ui, ui.doc, 'Escape');
  });
});

// 調模型之前那兩個下拉框（2026-10-20）：批次表單上作者為這一次挑模型與詳細度，提交時作為 `call` 帶給後端。
describe('批次表單上的模型與上下文詳細度', { skip: JSDOM_SKIP }, () => {
  let ui;
  const options = (key) => [...field(ui, key).querySelectorAll('option')].map((o) => o.value);
  const choose = (key, value) => {
    const sel = field(ui, key);
    sel.value = value;
    sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'state',
      state: viewState({
        contextDetail: 2,
        models: [
          { ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: '智譜 GLM' },
          { ref: 'or/claude', label: 'claude', group: 'OpenRouter' },
        ],
      }),
    });
    ui.post({ type: 'project', tree: sampleTree() });
    pickFromGroup(ui, '章節', '批次拆細綱…');
  });

  test('模型：第一項按分檔（預設），其餘按服務商分組', () => {
    assert.deepEqual(options('callModel'), ['', 'glm/glm-4-plus', 'or/claude']);
    assert.equal(field(ui, 'callModel').value, '');
    assert.equal(field(ui, 'callModel').options[0].textContent, '按分檔');
    const groups = [...field(ui, 'callModel').querySelectorAll('optgroup')].map((g) => g.label);
    assert.deepEqual(groups, ['智譜 GLM', 'OpenRouter']);
  });

  test('詳細度：四級，預設是設定頁那一級', () => {
    assert.deepEqual(options('callDetail'), ['1', '2', '3', '4']);
    assert.equal(field(ui, 'callDetail').value, '2');
  });

  test('挑了模型與級別：提交的 call 帶上這兩樣', () => {
    choose('callModel', 'or/claude');
    choose('callDetail', '1');
    ui.sent.length = 0;
    ui.clickEl(submitBtn(ui));
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'generatePlots', JSON.stringify(ui.sent));
    assert.equal(JSON.stringify(msg.call), JSON.stringify({ model: 'or/claude', contextDetail: 1 }));
  });
});
