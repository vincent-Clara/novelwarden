/**
 * 空狀態寫出下一步（W12）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 章節組 | 空分組先擺「新建第 N 章」（建完就開啟）與「匯入原稿…」，下面另起一行寫全書的下一步；「下一章還沒有細綱那一行」時也寫下一步（與主按鈕同一句話）；按鈕不直接花錢 |
 * | 角色組 | 全書下一步正是角色圖譜時說它；老工程（已有正文）給「提取角色卡…」；否則只說清從哪來 |
 * | 設定組 | 不說「下一步」（設定是可選的）；說明寫清放什麼、定稿時會記下出現了哪些設定；「＋ 設定」不調模型；有定稿過、還沒記過設定的章時多一顆「補記設定…」 |
 * | 對話頁 · 還不是小說工程 | 訊息區換成「下一步：初始化」那一塊，按鈕與工程頁那顆同一個動作；頁尾不再寫 VS Code 命令名 |
 * | 歷史頁 | 空列表給「去對話頁」 |
 *
 * 「按鈕不直接花錢」是第 20 條的延伸：全書只推一個下一步，花錢的那一下在主按鈕或寫著呼叫次數的
 * 彈窗 / 確認框上。所以這裡每一顆按鈕都斷言**沒有發 `send`**。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, emptySession, sampleTree, viewState } = require('../../helpers/dom');

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const hintIn = (ui, name) => groupOf(ui, name).querySelector('.row-empty');
const nextIn = (ui, name) => groupOf(ui, name).querySelector('.row-next-step');
const buttonsIn = (node) => [...node.querySelectorAll('button')].map((b) => b.textContent);
const buttonIn = (node, label) => [...node.querySelectorAll('button')].find((b) => b.textContent === label);
const formOpen = (ui) => !ui.doc.getElementById('providerModal').classList.contains('hidden');
const closeForm = (ui) =>
  ui.doc.querySelector('.nf-form')?.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** 全書那一檔的下一步，形狀同 `bookStepView` 的產出。 */
const STEPS = {
  config: {
    stage: 'setting',
    capability: 'generate',
    label: '生成小說配置',
    hint: '先把這個腦洞展開成一份小說配置。',
    target: { kind: 'setting', doc: 'config' },
    form: 'idea',
    calls: { low: 1, high: 1, max: 3 },
    formDefaults: { idea: '少年入宗', totalChapters: 60, wordsPerChapter: 2500, configHasContent: true },
  },
  premise: {
    stage: 'setting',
    capability: 'generate',
    label: '生成故事前提',
    hint: '',
    target: { kind: 'setting', doc: 'premise' },
    calls: { low: 1, high: 1, max: 1 },
  },
  characters: {
    stage: 'setting',
    capability: 'generate',
    label: '生成角色圖譜',
    hint: '',
    target: { kind: 'setting', doc: 'characters' },
    calls: { low: 2, high: 4, max: 6 },
  },
  lore: {
    stage: 'setting',
    capability: 'generate',
    label: '生成設定清單',
    hint: '',
    target: { kind: 'setting', doc: 'lore' },
    calls: { low: 3, high: 6, max: 12 },
  },
  plots: {
    stage: 'plot',
    capability: 'generate',
    label: '拆細綱（第 1–5 章）',
    hint: '',
    range: { from: 1, to: 5 },
    target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/001.md' },
    no: 1,
    calls: { low: 1, high: 1, max: 4 },
  },
};

/** 一棵空白的工程頁快照：章節、角色、設定三組都空著。 */
const blankTree = (extra) => ({
  ...sampleTree(),
  plots: [],
  plotCount: 0,
  chapterCount: 0,
  totalWords: 0,
  characters: [],
  lore: [],
  cast: [],
  castByCard: {},
  loreByEntry: {},
  loreUnfiled: [],
  loreUnrecorded: 0,
  ...extra,
});

describe('W12 · 章節組寫出全書的下一步', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('空分組：「下一步：」後面就是主按鈕那一句', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    assert.equal(nextIn(ui, '章節').querySelector('.row-hint-text').textContent, '下一步：生成故事前提');
  });

  // 新手上手（2026-10-24）：編輯器為主，空書最常見的開頭是自己寫第 1 章或者把寫好的書導進來——擺在下一步上面。
  test('空分組先擺「新建第 N 章」「匯入原稿…」，下一步另起一行在它下面', () => {
    const rows = [...groupOf(ui, '章節').querySelectorAll('.row-empty')];
    assert.equal(rows.length, 2);
    assert.ok(rows[0].textContent.startsWith('還沒有章節'), rows[0].textContent);
    assert.ok(!rows[0].classList.contains('row-next-step'));
    assert.deepEqual(buttonsIn(rows[0]), ['新建第 4 章', '匯入原稿…']);
    assert.ok(rows[1].classList.contains('row-next-step'));
  });

  test('「新建第 N 章」帶 open（建完就開啟），「匯入原稿…」走工程動作；都不發 send', () => {
    const row = hintIn(ui, '章節');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '新建第 4 章'));
    const made = ui.last('projectAction');
    assert.equal(made?.action, 'newChapter');
    assert.equal(made?.open, true);
    ui.clickEl(buttonIn(row, '匯入原稿…'));
    assert.equal(ui.last('projectAction')?.action, 'importManuscript');
    assert.equal(ui.last('projectAction')?.hostPath, undefined);
    assert.ok(!ui.last('send'), JSON.stringify(ui.sent));
  });

  test('架構那幾件：「去生成」進入那一層，不發 send', () => {
    ui.sent.length = 0;
    ui.clickEl(buttonIn(nextIn(ui, '章節'), '去生成'));
    assert.deepEqual(ui.last('setTarget')?.target, { kind: 'setting', doc: 'premise' });
    assert.ok(!ui.last('send'), JSON.stringify(ui.sent));
  });

  test('小說配置：「去生成」開啟一句話彈窗，預設值是後端給的', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.config }) });
    ui.sent.length = 0;
    ui.clickEl(buttonIn(nextIn(ui, '章節'), '去生成'));
    assert.ok(formOpen(ui));
    assert.equal(ui.doc.querySelector('.nf-form [data-key="idea"]').value, '少年入宗');
    assert.ok(!ui.last('send') && !ui.last('setTarget'), JSON.stringify(ui.sent));
    closeForm(ui);
  });

  test('拆細綱：「拆細綱…」開啟拆細綱彈窗（呼叫次數寫在彈窗上）', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.plots }) });
    ui.sent.length = 0;
    const row = nextIn(ui, '章節');
    assert.equal(row.querySelector('.row-hint-text').textContent, '下一步：拆細綱（第 1–5 章）');
    ui.clickEl(buttonIn(row, '拆細綱…'));
    assert.ok(formOpen(ui));
    assert.ok(!ui.last('send') && !ui.last('projectAction'), JSON.stringify(ui.sent));
    closeForm(ui);
  });

  // 沒有 next（老快照、或者全書寫完了）：只剩新建 / 匯入那一行，不畫一個空的「下一步：」。
  test('沒有下一步時只有新建 / 匯入那一行', () => {
    ui.post({ type: 'project', tree: blankTree() });
    assert.equal(nextIn(ui, '章節'), null);
    const rows = [...groupOf(ui, '章節').querySelectorAll('.row-empty')];
    assert.equal(rows.length, 1);
    assert.deepEqual(buttonsIn(rows[0]), ['新建第 4 章', '匯入原稿…']);
  });

  // 章節不空，但下一章那一行還不存在（拆細綱那一檔）：「去寫這一章」掛不上，組末補一句。
  test('下一章還沒有細綱那一行時，組末寫出下一步', () => {
    const tree = sampleTree();
    const plots = tree.plots.filter((p) => p.no < tree.nextChapterNo);
    ui.post({
      type: 'project',
      tree: { ...tree, plots, next: { ...STEPS.plots, label: `拆細綱（第 ${tree.nextChapterNo}–8 章）` } },
    });
    const rows = [...groupOf(ui, '章節').querySelectorAll('.row-plot, .row-next-step')];
    assert.ok(rows[rows.length - 1].classList.contains('row-next-step'), rows.map((r) => r.className).join('|'));
    assert.ok(rows[rows.length - 1].textContent.startsWith(`下一步：拆細綱（第 ${tree.nextChapterNo}–8 章）`));
  });

  // 下一章那一行在：它自己帶「去寫這一章」，不再多說一句。
  test('下一章那一行在時不加「下一步」', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), next: STEPS.plots } });
    assert.equal(groupOf(ui, '章節').querySelector('.row-next-step'), null);
  });
});

describe('W12 · 角色組', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('全書下一步正是角色圖譜：說它，「去生成」進入那一層', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.characters }) });
    const row = hintIn(ui, '角色');
    assert.equal(row.querySelector('.row-hint-text').textContent, '下一步：生成角色圖譜');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '去生成'));
    assert.deepEqual(ui.last('setTarget')?.target, { kind: 'setting', doc: 'characters' });
    assert.ok(!ui.last('send'));
  });

  // 第 20 條：全書只推一個下一步。下一步是別的東西時，這裡不另起一個「下一步」。
  test('下一步是別的時只說清角色卡從哪來，不給按鈕', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    const row = hintIn(ui, '角色');
    assert.ok(!row.textContent.startsWith('下一步') && row.textContent.includes('角色圖譜'), row.textContent);
    assert.deepEqual(buttonsIn(row), []);
  });

  test('已經寫過正文（老工程）：「提取角色卡…」走自帶確認框的工程動作', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.config, totalWords: 30000 }) });
    const row = hintIn(ui, '角色');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '提取角色卡…'));
    assert.equal(ui.last('projectAction')?.action, 'extractCharacters');
    assert.ok(!ui.last('send'));
  });
});

describe('W12 · 設定組', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  // 設定條目是可選的：不說「下一步」，說清它是什麼、往後怎麼從定稿裡長出來。
  test('還沒寫正文：只有「＋ 設定」，不調模型', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.premise }) });
    const row = hintIn(ui, '設定');
    assert.ok(!row.textContent.startsWith('下一步'), row.textContent);
    assert.deepEqual(buttonsIn(row), ['＋ 設定']);
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '＋ 設定'));
    assert.equal(ui.last('projectAction')?.action, 'newLore');
  });

  // 設定名錄之後：設定會從每章定稿裡記下來，出現過卻沒建條目的列在下面那一組。
  test('說明寫清放什麼、定稿時會記下出現了哪些設定', () => {
    assert.equal(
      hintIn(ui, '設定').querySelector('.row-hint-text').textContent,
      '還沒有設定條目。地點、勢力、物品、概念這類要前後一致的東西各寫一條；每章同步時會記下這一章出現了哪些設定，出現過卻還沒建條目的會列在下面。'
    );
  });

  // 「從正文生成…」（整本重掃）刪了（設定名錄第三期）。有定稿過、還沒記過設定的章時給「補記設定…」。
  test('有正文但沒有要補記的章：只有「＋ 設定」', () => {
    ui.post({ type: 'project', tree: blankTree({ totalWords: 12000 }) });
    assert.deepEqual(buttonsIn(hintIn(ui, '設定')), ['＋ 設定']);
  });

  test('有定稿過、還沒記過設定的章：多一顆「補記設定…」，發 recordLore', () => {
    ui.post({ type: 'project', tree: blankTree({ totalWords: 12000, loreUnrecorded: 3 }) });
    const row = hintIn(ui, '設定');
    assert.deepEqual(buttonsIn(row), ['＋ 設定', '補記設定…']);
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '補記設定…'));
    assert.equal(ui.last('projectAction')?.action, 'recordLore');
  });

  // 同角色組：全書的下一步正是設定清單時就說它（同一步、同一句話），按鈕進入那一層，不直接花錢。
  test('全書下一步正是設定清單：說它，「去生成」進入那一層', () => {
    ui.post({ type: 'project', tree: blankTree({ next: STEPS.lore }) });
    const row = hintIn(ui, '設定');
    assert.equal(row.querySelector('.row-hint-text').textContent, '下一步：生成設定清單');
    ui.sent.length = 0;
    ui.clickEl(buttonIn(row, '去生成'));
    assert.deepEqual(ui.last('setTarget')?.target, { kind: 'setting', doc: 'lore' });
    assert.ok(!ui.last('send'));
  });
});

describe('W12 · 對話頁：還不是小說工程', { skip: JSDOM_SKIP }, () => {
  let ui;
  const messages = () => ui.doc.getElementById('messages');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'state', state: viewState({ initialized: false }) });
  });

  test('訊息區換成「下一步：初始化」那一塊', () => {
    assert.ok(messages().classList.contains('uninit'));
    const hint = ui.doc.getElementById('initHint');
    assert.ok(hint && messages().contains(hint));
    assert.ok(hint.textContent.includes('下一步：把這個資料夾初始化成小說工程'), hint.textContent);
  });

  // 從前寫「先執行「Novel: 初始化小說工程」」——那是 VS Code 的命令名，獨立版裡找不到。
  test('頁尾不再寫 VS Code 的命令名', () => {
    const meta = ui.doc.getElementById('providerMeta').textContent;
    assert.ok(!meta.includes('Novel:'), meta);
  });

  test('按鈕與工程頁那顆「初始化小說工程」同一個動作', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.getElementById('initProjectBtn'));
    assert.equal(ui.last('projectAction')?.action, 'initProject');
  });

  // 重畫會話（innerHTML 清空）之後那一塊還在。
  test('換會話之後那一塊仍在訊息區裡', () => {
    ui.post({ type: 'session', session: emptySession() });
    assert.ok(messages().contains(ui.doc.getElementById('initHint')));
  });

  test('初始化之後收起來', () => {
    ui.post({ type: 'state', state: viewState({ initialized: true }) });
    assert.ok(!messages().classList.contains('uninit'));
  });
});

describe('W12 · 歷史頁沒有會話', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'sessions', list: [] });
  });

  test('說清會話從哪來，給「去對話頁」', () => {
    const li = ui.doc.querySelector('#sessionList li.history-empty');
    assert.ok(li && li.textContent.includes('發出第一條訊息後會自動儲存'), li && li.textContent);
    assert.deepEqual(buttonsIn(li), ['去對話頁']);
  });

  test('點了切到對話頁', () => {
    ui.sent.length = 0;
    ui.clickEl(buttonIn(ui.doc.querySelector('#sessionList li.history-empty'), '去對話頁'));
    assert.equal(ui.last('switchTab')?.tab, 'chat');
    assert.ok(ui.doc.getElementById('pane-chat').classList.contains('active'));
  });
});
