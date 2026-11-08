/**
 * 工程頁：目錄樹的展開/縮排、「故事架構」組、一個章號一行的章節組、
 * 行與分組的右鍵選單、選單引擎的通用行為。
 *
 * 遷自 scripts/smoke-view.js 的這幾節：
 *   == 工程頁目錄樹 ==（1014） == 工程頁的右鍵選單 ==（1059）
 *   == 右鍵選單的通用行為 ==（1324）
 *
 * 一章一綱之後（commit 4e0d289）章節組不再分「已釋出的章 / 還沒交付的劇情段」
 * 兩種行，也沒有卷那一組：細綱號 = 章號，一行就是一章的細綱與正文兩面。
 * 夾具見 helpers/dom.js 的 `sampleTree()`——五行各是單章狀態機的一檔。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, sampleTree } = require('../../helpers/dom');

/**
 * 章節組的行。「故事架構」那幾行刻意複用了 `.row-plot` 的樣式與骨架，
 * 按 `.row-plot` 取時要排掉 `.row-architecture`，否則「章節有幾行」會連它們一起數。
 */
const chapterRowsOf = (ui) => [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture)')];

describe('工程頁目錄樹', { skip: JSDOM_SKIP }, () => {
  let ui;
  // 目錄樹只有**角色 / 設定**兩個區有——章節列表是扁平的（細綱與正文合成
  // 一行，順序即章號，折進目錄反而看不出來）。
  const charactersGroup = () =>
    [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '角色');
  const labels = () => [...charactersGroup().querySelectorAll('.row-label')].map((n) => n.textContent);
  const dirLabel = (name) =>
    [...charactersGroup().querySelectorAll('.row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('頂層節點都在', () => {
    assert.ok(
      labels().some((l) => l.includes('配角')) && labels().some((l) => l.includes('林昭')),
      labels().join(' | ')
    );
  });

  test('資料夾預設摺疊，不渲染子節點', () => {
    assert.ok(!labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });

  test('摺疊時用閉合資料夾圖示', () => {
    assert.ok(labels().some((l) => l.startsWith('📁 配角')));
  });

  test('展開後出現子節點', () => {
    ui.clickEl(dirLabel('配角'));
    assert.ok(labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });

  test('展開時用開啟資料夾圖示', () => {
    assert.ok(labels().some((l) => l.startsWith('📂 配角')));
  });

  // 層級靠 paddingLeft 表達（DOM 是扁平的），每層 14px。
  const padOf = (text) => {
    const row = [...charactersGroup().querySelectorAll('.row')].find((n) => n.textContent.includes(text));
    return row ? parseInt(row.style.paddingLeft, 10) : -1;
  };

  test('第 0 層縮排 16px', () => {
    assert.equal(padOf('林昭'), 16, String(padOf('林昭')));
  });

  test('第 1 層縮排 30px', () => {
    assert.equal(padOf('李叔'), 30, String(padOf('李叔')));
  });

  // 章節列表不折目錄：五行（一個章號一行）一律 16px，與正文在 chapters/ 下的層級無關。
  test('章節行一律是第 0 層縮排', () => {
    const rows = chapterRowsOf(ui);
    assert.ok(
      rows.length === 5 && rows.every((r) => parseInt(r.style.paddingLeft, 10) === 16),
      `${rows.length} 行：${rows.map((r) => r.style.paddingLeft).join('|')}`
    );
  });

  // 摺疊狀態是前端自己的，全量推送不該把它重置掉。
  test('重推資料後保持展開狀態', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });
});

/*
 * 「故事架構」組：小說配置 / 故事前提 / 角色圖譜 / 世界觀 / 設定清單 / 情節大綱。
 *
 * 它是後面一切的上游（寫正文要讀前提、角色與世界觀），所以排在章節組之前，
 * 組標題直接報「填了幾件」——缺哪件，全書狀態機的主按鈕就推哪件。
 */
describe('「故事架構」組', { skip: JSDOM_SKIP }, () => {
  let ui;
  const group = () =>
    [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '故事架構');
  const rows = () => [...group().querySelectorAll('.row-architecture')];
  const row = (label) => rows().find((r) => r.querySelector('.row-label')?.textContent === label);
  const groupMeta = () => group().querySelector('.group-head .meta').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('有「故事架構」這一組', () => {
    assert.ok(group(), [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent).join('|'));
  });

  // 它是章節的上游：「概覽」頁籤的第一組；章節在自己的頁籤裡。
  test('在「概覽」頁籤，排第一', () => {
    const panel = group().closest('[data-project-panel]');
    assert.equal(panel?.dataset.projectPanel, 'overview');
    assert.equal(panel.querySelector('.group'), group());
  });

  // 順序即生成順序：每一件都吃前面幾件的產出。設定清單排在世界觀之後、情節大綱之前。
  test('六行，順序即生成順序', () => {
    assert.deepEqual(
      rows().map((r) => r.querySelector('.row-label').textContent),
      ['小說配置', '故事前提', '角色圖譜', '世界觀', '設定清單', '情節大綱']
    );
  });

  // 夾具裡世界觀還沒寫，其餘五件都填過。
  test('組標題報填了幾件（x/6）', () => {
    assert.equal(groupMeta(), '5/6', groupMeta());
  });

  test('填過的那一件打實心點', () => {
    const dot = row('小說配置').querySelector('.dot');
    assert.equal(dot.textContent, '●', dot.outerHTML);
    assert.ok(!dot.classList.contains('stale'), dot.className);
  });

  test('沒填的那一件打空心點', () => {
    const dot = row('世界觀').querySelector('.dot');
    assert.equal(dot.textContent, '○', dot.outerHTML);
    assert.ok(dot.classList.contains('stale'), dot.className);
  });

  // 副標題由後端給（「2 人」「覆蓋到第 20 章」「待生成」），前端只渲染。
  test('情節大綱的副標題報覆蓋到第幾章', () => {
    assert.equal(row('情節大綱').querySelector('.row-detail')?.textContent, '覆蓋到第 20 章',
      row('情節大綱').outerHTML);
  });

  test('角色圖譜的副標題報人數', () => {
    assert.equal(row('角色圖譜').querySelector('.row-detail')?.textContent, '2 人', row('角色圖譜').outerHTML);
  });

  test('沒填的那一件說「待生成」', () => {
    assert.equal(row('世界觀').querySelector('.row-detail')?.textContent, '待生成', row('世界觀').outerHTML);
  });

  // 架構行復用章節行的樣式，但它們不是一章：不帶 data-plot（細綱浮窗認的就是它）。
  test('架構行不帶章節行的抓手', () => {
    assert.ok(rows().every((r) => r.dataset.plot === undefined), rows().map((r) => r.outerHTML).join('\n'));
  });

  // 與「去寫這一章」同一個道理：第一件還沒填的那一行給「去生成」，全組只有這一顆。
  test('只有第一件沒填的那一行有「去生成」', () => {
    const go = rows().filter((r) => r.querySelector('.row-go'));
    assert.equal(go.length, 1, String(go.length));
    assert.equal(go[0], row('世界觀'));
    assert.equal(go[0].querySelector('.row-go').textContent, '去生成');
  });

  // 它只是「進入這一層」：真正花錢的那一下仍是對話頁的主按鈕。
  test('點「去生成」進入那一層，不直接開寫', () => {
    ui.sent.length = 0;
    ui.clickEl(row('世界觀').querySelector('.row-go'));
    assert.equal(JSON.stringify(ui.last('setTarget')?.target), JSON.stringify({ kind: 'setting', doc: 'world' }), JSON.stringify(ui.sent));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });

  // 點名字 = 開啟那份檔案，與章節行同一個習慣。
  test('點檔名開啟那份檔案', () => {
    ui.sent.length = 0;
    ui.clickEl(row('故事前提').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelwarden/premise.md', JSON.stringify(ui.sent));
  });

  // 角色圖譜沒有自己的檔案（它就是 characters/ 下那一組卡）：已有卡時點它切到「角色」頁籤、展開那一組，
  // 不切到對話頁；開啟一個目錄在編輯器裡什麼都看不到。
  test('已有角色卡：點「角色圖譜」切到「角色」頁籤、展開「角色」組，不進入那一層、不開啟檔案', () => {
    const chars = () =>
      [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '角色');
    ui.clickEl(chars().querySelector('.group-toggle'));
    assert.equal(chars().querySelector('.group-body').children.length, 0, '先折起來');
    ui.sent.length = 0;
    ui.clickEl(row('角色圖譜').querySelector('.row-label'));
    assert.ok(chars().querySelector('.group-body').children.length > 0, chars().outerHTML);
    assert.equal(chars().closest('[data-project-panel]').hidden, false, '「角色」頁露出來');
    assert.equal(group().closest('[data-project-panel]').hidden, true, '「概覽」頁藏起來');
    assert.equal(ui.doc.querySelector('#projectTabs .project-tab.active')?.textContent, '角色');
    assert.ok(!ui.last('setTarget'), JSON.stringify(ui.sent));
    assert.ok(!ui.last('openFile'), JSON.stringify(ui.sent));
  });

  test('還沒有角色卡：點「角色圖譜」進入那一層', () => {
    const ui2 = mount();
    const tree = sampleTree();
    tree.architecture = tree.architecture.map((a) => (a.key === 'characters' ? { ...a, filled: false } : a));
    ui2.post({ type: 'project', tree });
    const r = [...ui2.doc.querySelectorAll('#projectBody .row-architecture')].find(
      (n) => n.querySelector('.row-label')?.textContent === '角色圖譜'
    );
    ui2.sent.length = 0;
    ui2.clickEl(r.querySelector('.row-label'));
    const t = ui2.last('setTarget');
    assert.ok(t, JSON.stringify(ui2.sent));
    // 逐欄位比：target 是在 jsdom 那個 realm 裡造的，原型不同，deepStrictEqual 會判不等。
    assert.equal(t.target.kind, 'setting', JSON.stringify(t));
    assert.equal(t.target.doc, 'characters', JSON.stringify(t));
  });

  // 設定清單同角色圖譜：沒有自己的檔案（它就是 lore/ 下那一組條目），填過時點它切到「設定」頁籤。
  test('設定清單的副標題報條數', () => {
    assert.equal(row('設定清單').querySelector('.row-detail')?.textContent, '0 條', row('設定清單').outerHTML);
  });

  test('設定清單填過：點它切到「設定」頁籤、展開「設定」組，不進入那一層、不開啟檔案', () => {
    const lore = () =>
      [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '設定');
    ui.clickEl(lore().querySelector('.group-toggle'));
    assert.equal(lore().querySelector('.group-body').children.length, 0, '先折起來');
    ui.sent.length = 0;
    ui.clickEl(row('設定清單').querySelector('.row-label'));
    assert.ok(lore().querySelector('.group-body').children.length > 0, lore().outerHTML);
    assert.equal(lore().closest('[data-project-panel]').hidden, false, '「設定」頁露出來');
    assert.ok(!ui.last('setTarget'), JSON.stringify(ui.sent));
    assert.ok(!ui.last('openFile'), JSON.stringify(ui.sent));
    assert.match(row('設定清單').querySelector('.row-label').title, /切到「設定」頁籤/);
  });

  test('設定清單的選單沒有「開啟」', () => {
    const items = ui.itemsOf(ui.rightClick(row('設定清單')));
    assert.ok(!items.includes('開啟'), JSON.stringify(items));
    assert.ok(items.includes('討論') && items.includes('重寫…'), JSON.stringify(items));
    ui.closeMenu();
  });

  // 新書走到世界觀之後：設定清單是第一件沒填的，「去生成」掛在它上面，點了進入那一層（與別的幾件一樣）。
  test('設定清單還沒填、是第一件沒填的：「去生成」進入那一層；點名字也進入那一層', () => {
    const ui2 = mount();
    const tree = sampleTree();
    tree.architecture = tree.architecture.map((a) =>
      a.key === 'world' ? { ...a, filled: true, detail: '' } : a.key === 'lore' ? { ...a, filled: false, detail: '待生成' } : a
    );
    ui2.post({ type: 'project', tree });
    const r = [...ui2.doc.querySelectorAll('#projectBody .row-architecture')].find(
      (n) => n.querySelector('.row-label')?.textContent === '設定清單'
    );
    const go = [...ui2.doc.querySelectorAll('#projectBody .row-architecture .row-go')];
    assert.equal(go.length, 1);
    assert.equal(go[0].closest('.row-architecture'), r);
    ui2.sent.length = 0;
    ui2.clickEl(go[0]);
    const t = ui2.last('setTarget');
    assert.equal(t?.target.kind, 'setting', JSON.stringify(ui2.sent));
    assert.equal(t?.target.doc, 'lore', JSON.stringify(ui2.sent));
    assert.ok(!ui2.sent.some((m) => m.type === 'send'), JSON.stringify(ui2.sent));
    ui2.sent.length = 0;
    ui2.clickEl(r.querySelector('.row-label'));
    assert.equal(ui2.last('setTarget')?.target.doc, 'lore', JSON.stringify(ui2.sent));
    assert.ok(!ui2.last('openFile'), JSON.stringify(ui2.sent));
  });

  let worldItems;
  test('沒填的那一件右鍵給「進入這一層（去生成）」', () => {
    worldItems = ui.itemsOf(ui.rightClick(row('世界觀')));
    assert.ok(worldItems.includes('進入這一層（去生成）'), JSON.stringify(worldItems));
  });

  test('有檔案的那一件右鍵也給「開啟」', () => {
    assert.ok(worldItems.includes('開啟'), JSON.stringify(worldItems));
  });

  // 四件文件與大綱是工程的固定檔案：改名或刪掉，狀態機就認不出它們了。
  test('架構行不給重新命名 / 刪除 / 移動', () => {
    assert.ok(
      !['重新命名', '刪除（移到回收站）', '移動到…'].some((l) => worldItems.includes(l)),
      JSON.stringify(worldItems)
    );
    ui.closeMenu();
  });

  test('「進入這一層」發 setTarget，帶的是那一件檔案', () => {
    ui.pick(ui.rightClick(row('世界觀')), '進入這一層（去生成）');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'setting', JSON.stringify(t));
    assert.equal(t?.target.doc, 'world', JSON.stringify(t));
  });

  // 填過的那一件：「討論」只進入那一層，「重寫…」直接發一輪生成（後端先問要求）。
  test('情節大綱右鍵「討論」進入大綱層，不發生成', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(row('情節大綱')), '討論');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'outline', JSON.stringify(t));
    assert.ok(!ui.last('rewriteArchitecture'), JSON.stringify(ui.sent));
  });

  test('情節大綱右鍵「重寫…」發 rewriteArchitecture，不只是切過去', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(row('情節大綱')), '重寫…');
    const r = ui.last('rewriteArchitecture');
    assert.equal(r?.target.kind, 'outline', JSON.stringify(ui.sent));
    assert.ok(!ui.last('setTarget'), JSON.stringify(ui.sent));
  });

  test('沒填的那一件不給「重寫…」', () => {
    assert.ok(!worldItems.includes('重寫…'), JSON.stringify(worldItems));
  });

  test('角色圖譜的選單沒有「開啟」', () => {
    const items = ui.itemsOf(ui.rightClick(row('角色圖譜')));
    assert.ok(!items.includes('開啟'), JSON.stringify(items));
    assert.ok(items.includes('討論') && items.includes('重寫…'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('全部填滿後組標題是 6/6', () => {
    const full = sampleTree();
    full.architecture = full.architecture.map((a) => ({ ...a, filled: true }));
    ui.post({ type: 'project', tree: full });
    assert.equal(groupMeta(), '6/6', groupMeta());
  });
});

/*
 * 章節組：**一個章號一行**。細綱號 = 章號，所以一行同時報細綱與正文兩面：
 * 徽章說這一章該做哪一步，字數寫著「寫了多少 / 目標多少」，⟳ 說上游變過，
 * 行首圓點說定稿沒有。
 */
describe('章節組：一個章號一行', { skip: JSDOM_SKIP }, () => {
  let ui;
  const plotRow = (text) => chapterRowsOf(ui).find((n) => n.textContent.includes(text));
  // 只數章節行上的：故事架構那一組有自己的「去生成」。
  const goBtns = () => [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-go')];
  const metaOf = (text) => plotRow(text).querySelector('.meta').textContent;
  const plotGroupMeta = () =>
    [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章節')
      .querySelector('.meta').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('每個章號一行，按章號升序', () => {
    assert.deepEqual(
      chapterRowsOf(ui).map((r) => r.querySelector('.row-label').textContent),
      ['第 1 章《楔子》', '第 2 章《入鎮》', '第 3 章《夜訪》', '第 4 章《北行》', '第 5 章《赤星》']
    );
  });

  // data-plot 是這一章在協議上的身份（懸停要細綱、selectPlot 都拿它）：
  // 有正文就是正文，否則是細綱。
  test('有正文的章，行的身份是正文路徑', () => {
    assert.equal(plotRow('楔子').dataset.plot, 'chapters/001-楔子.md');
  });

  test('還沒寫正文的章，行的身份是細綱路徑', () => {
    assert.equal(plotRow('北行').dataset.plot, '.novelwarden/summaries/004-北行.md');
  });

  // 從前這裡還帶「· 待寫 N 段」——劇情段沒了，只剩章數與字數。
  test('組標題報章數與字數', () => {
    assert.equal(plotGroupMeta(), '3 章 · 3580 字', plotGroupMeta());
  });

  // ---- 「去寫這一章」：樹行一律不掛行內按鈕，這是唯一的例外（W2）
  test('只有下一個該寫的章有「去寫這一章」', () => {
    assert.equal(goBtns().length, 1, String(goBtns().length));
    assert.equal(goBtns()[0].closest('.row-plot'), plotRow('北行'), goBtns()[0].closest('.row-plot')?.outerHTML);
  });

  test('那一行帶 row-next 標記', () => {
    assert.ok(plotRow('北行').classList.contains('row-next'));
    assert.equal(chapterRowsOf(ui).filter((r) => r.classList.contains('row-next')).length, 1);
  });

  // 它只是「進入這一章」：真正花錢的那一下仍是對話頁的主按鈕（第 20 條：只推一個）。
  test('點「去寫這一章」發 selectPlot，帶的是這一章的主路徑', () => {
    ui.sent.length = 0;
    ui.clickEl(goBtns()[0]);
    const sel = ui.last('selectPlot');
    assert.ok(sel, JSON.stringify(ui.sent));
    assert.equal(sel.plotRelPath, '.novelwarden/summaries/004-北行.md', JSON.stringify(sel));
  });

  test('點「去寫這一章」不順手開啟檔案，也不直接開寫', () => {
    assert.ok(!ui.sent.some((m) => m.type === 'openFile' || m.type === 'send'),
      JSON.stringify(ui.sent));
  });

  // 按鈕落在哪一行完全聽後端的 nextChapterNo，前端不自己數「第一個沒寫的」。
  test('按鈕跟著 nextChapterNo 走', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), nextChapterNo: 5 } });
    assert.equal(goBtns().length, 1, String(goBtns().length));
    assert.equal(goBtns()[0].closest('.row-plot'), plotRow('赤星'));
  });

  // 下一個該寫的章還沒有細綱也沒有正文時，列表裡沒有那一行——也就沒有按鈕，不補空行。
  test('那一章不在列表裡時一顆都不掛', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), nextChapterNo: 6 } });
    assert.equal(goBtns().length, 0, String(goBtns().length));
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // ---- 徽章：這一章現在該做哪一步
  test('待寫正文的章掛「待寫正文」', () => {
    assert.equal(plotRow('北行').querySelector('.row-stage')?.textContent, '待寫正文');
  });

  test('細綱只有骨架的章掛「待寫細綱」', () => {
    assert.equal(plotRow('赤星').querySelector('.row-stage')?.textContent, '待寫細綱');
  });

  test('寫夠了沒定稿的章掛「待定稿」', () => {
    assert.equal(plotRow('入鎮').querySelector('.row-stage')?.textContent, '待同步');
  });

  // 一列「已完成」只是噪聲。
  test('已完成的章不掛徽章', () => {
    assert.equal(plotRow('楔子').querySelector('.row-stage'), null, plotRow('楔子').outerHTML);
  });

  test('徽章的 tooltip 報三段完成度', () => {
    const title = plotRow('北行').querySelector('.row-stage').title;
    assert.ok(title.includes('細綱 100%') && title.includes('正文 0%') && title.includes('同步 0%'), title);
  });

  // ⟳ 不是錯誤，是「回頭看一眼」：大綱裡覆蓋這一章的那一節改過。
  test('上游變過的章掛 ⟳', () => {
    assert.ok(plotRow('北行').querySelector('.row-upstream'), plotRow('北行').outerHTML);
  });

  test('上游沒變的章不掛 ⟳', () => {
    assert.equal(plotRow('楔子').querySelector('.row-upstream'), null);
  });

  // ---- 字數：「2980 / 3000」比單報字數多說一件事——寫夠沒有
  test('有目標字數時報「寫了多少 / 目標多少」', () => {
    assert.ok(metaOf('入鎮').includes('2980 / 3000'), metaOf('入鎮'));
  });

  test('沒有目標字數時只報字數', () => {
    assert.ok(metaOf('夜訪').startsWith('300 字'), metaOf('夜訪'));
  });

  test('還沒寫正文報「未寫」', () => {
    assert.ok(metaOf('北行').startsWith('未寫'), metaOf('北行'));
  });

  test('已有草稿的章行帶標記', () => {
    assert.ok(metaOf('楔子').includes('· 草稿'), metaOf('楔子'));
  });

  test('沒寫正文的章不帶草稿標記', () => {
    assert.ok(!metaOf('北行').includes('· 草稿'), metaOf('北行'));
  });

  // ---- 行首圓點：定稿過、細綱與正文對得上沒有
  test('定稿過的章打實心點', () => {
    assert.equal(plotRow('楔子').querySelector('.dot').textContent, '●');
  });

  test('寫了沒定稿的章打空心點', () => {
    const dot = plotRow('入鎮').querySelector('.dot');
    assert.ok(dot.textContent === '○' && dot.classList.contains('stale'), dot.outerHTML);
  });

  // 還沒寫正文的章無從定稿——那不是「過期」，是還沒到那一步。
  test('還沒寫正文的章不算過期', () => {
    const dot = plotRow('北行').querySelector('.dot');
    assert.ok(dot.textContent === '·' && !dot.classList.contains('stale'), dot.outerHTML);
  });

  // 新手上手（2026-10-24）：空書最常見的開頭是自己寫第 1 章或者把寫好的書導進來，那一行先說這兩樣。
  test('沒有章節時說清先做什麼', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), plots: [], plotCount: 0, chapterCount: 0, totalWords: 0 } });
    const hint = [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '章節')
      .querySelector('.row-empty');
    assert.ok(hint && hint.textContent.includes('新建一章') && hint.textContent.includes('匯入'), hint && hint.textContent);
    ui.post({ type: 'project', tree: sampleTree() });
  });
});

describe('工程頁的右鍵選單', { skip: JSDOM_SKIP }, () => {
  let ui;
  let doneItems;
  let legacyItems;
  let planningItems;
  let folderItems;
  let fileItems;
  let groupHead;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const plotRow = (text) => chapterRowsOf(ui).find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));
  const treeGroups = () =>
    ['architecture', 'plots', 'characters'].map((id) => ui.doc.querySelector(`#projectBody .group[data-group="${id}"]`));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // 頁面整潔：故事架構 / 章節 / 角色三個區的行不掛行內操作按鈕。例外只有兩顆：
  // 下一個該寫的章那顆「去寫這一章」與第一件沒填的架構文件那顆「去生成」（W2）
  // ——各自全組只有一顆，不會變成一排按鈕。
  // （「文風與摘要」不是檔案管理區，它的「重建」「從正文提取」連結照舊留在行內。）
  test('樹上的行沒有行內操作區', () => {
    const treeRows = treeGroups()
      .flatMap((g) => [...g.querySelectorAll('.row')]);
    assert.ok(treeRows.length > 0 && treeRows.every((r) => !r.querySelector('.row-actions')),
      `${treeRows.length} 行`);
  });

  test('樹上的行裡只有「去生成」與「去寫這一章」兩顆按鈕', () => {
    const buttons = treeGroups()
      .flatMap((g) => [...g.querySelectorAll('.row button')]);
    assert.deepEqual(buttons.map((b) => b.textContent), ['去生成', '去寫這一章']);
  });

  test('分組標題欄不再有「＋」按鈕', () => {
    assert.ok(!ui.doc.querySelector('#projectBody .group-head .row-actions'));
  });

  // ---- 寫完且定稿過的章（第 1 章）：細綱、正文、草稿都在，選單最全。
  test('右鍵章節行彈出選單', () => {
    doneItems = ui.itemsOf(ui.rightClick(plotRow('楔子')));
    assert.ok(doneItems.length > 0);
  });

  // 「進入這一章」與「開啟正文」是兩件事：前者把創作頁切到這一章當前該做
  // 的那一層，後者只是讀檔案。
  for (const label of ['進入這一章', '開啟正文', '開啟細綱', '重寫正文', '重新同步',
    '開啟草稿', '重新命名', '刪除（移到回收站）']) {
    test(`定稿過的章選單含「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  // 定稿改的就是細綱本身，沒有另一份「摘要」可看——「開啟細綱」就是它。
  test('定稿過的章選單沒有「看摘要」', () => {
    assert.ok(!doneItems.includes('看摘要'), JSON.stringify(doneItems));
  });

  // 開啟哪一份與點名字同序（正文 → 細綱）：點行做的那件事在選單裡排第一。
  test('「開啟正文」排在「開啟細綱」前面', () => {
    assert.ok(doneItems.indexOf('開啟正文') < doneItems.indexOf('開啟細綱'), JSON.stringify(doneItems));
  });

  // 順序由章號決定——把一章挪進子目錄只會讓它從列表上消失，所以不給這一項。
  test('章節選單沒有「移動到…」', () => {
    assert.ok(!doneItems.includes('移動到…'), JSON.stringify(doneItems));
  });

  // 兩層入口：狀態機只給「該做的下一步」，而作者常要回頭改上一層。
  for (const label of ['細綱（100%）', '正文（100%）']) {
    test(`章節選單含兩層入口「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  test('章節選單不再有場景入口', () => {
    assert.ok(!doneItems.some((x) => x.includes('場景')), JSON.stringify(doneItems));
  });

  // 點章名 = 開啟這一章（W6 章節工作臺）：正文在主區、細綱並排在旁邊。開幾份、開在哪
  // 由後端按宿主的能力定（有沒有「並排開啟」），前端只說是哪一章——兩個殼發的是同一條。
  test('點章節名發 openChapter，帶這一行的主路徑', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    const open = ui.last('openChapter');
    assert.ok(open, '沒發出 openChapter');
    assert.equal(open.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(open));
  });

  test('還沒寫正文的章也發 openChapter（後端只開細綱）', () => {
    ui.clickEl(plotRow('北行').querySelector('.row-label'));
    assert.equal(ui.last('openChapter').plotRelPath, '.novelwarden/summaries/004-北行.md');
  });

  test('點章節名不再切到對話頁', () => {
    ui.sent.length = 0;
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    assert.ok(!ui.sent.some((m) => m.type === 'selectPlot'), JSON.stringify(ui.sent));
  });

  // selectPlot 帶的是主路徑：後端按章號認，正文路徑與細綱路徑認到的是同一章。
  test('「進入這一章」發 selectPlot，帶的是主路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '進入這一章');
    const sel = ui.last('selectPlot');
    assert.equal(sel?.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(sel));
  });

  // 兩層入口的 target 一律是**細綱路徑**（CreationTarget 按細綱認章），
  // 哪怕這一行的主路徑是正文。
  test('兩層入口發 setTarget，帶的是細綱路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '正文（100%）');
    const t = ui.last('setTarget');
    assert.ok(t, '沒發出 setTarget');
    // 逐欄位比：target 是在 jsdom 那個 realm 裡造的，原型不是本 realm 的
    // Object.prototype，deepStrictEqual 會因此判不等。
    assert.equal(t.target.kind, 'manuscript', JSON.stringify(t));
    assert.equal(t.target.plotRelPath, '.novelwarden/summaries/001-楔子.md', JSON.stringify(t));
  });

  // 定稿是照正文更新細綱，讀的是正文，所以帶的必須是 chapters/ 那條路徑。
  // 右鍵發的是 askFinalizeChapter：後端先彈確認框挑這一次的模型。
  test('「重新定稿」發 askFinalizeChapter，帶的是章節路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重新同步');
    const msg = ui.last('projectAction');
    assert.ok(msg, '沒發出 projectAction');
    assert.equal(msg.action, 'askFinalizeChapter', JSON.stringify(msg));
    assert.equal(msg.relPath, 'chapters/001-楔子.md', JSON.stringify(msg));
  });

  // 重寫正文不自己開寫：切到這一章的正文層，輸入框上方掛一枚「/重寫正文」，等作者寫下要求再傳送。
  test('「重寫正文」切到這一章的正文層、掛上「/重寫正文」，不傳送', () => {
    const before = ui.sent.filter((m) => m.type === 'send').length;
    ui.pick(ui.rightClick(plotRow('楔子')), '重寫正文');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'manuscript', JSON.stringify(t));
    assert.equal(t?.target.plotRelPath, '.novelwarden/summaries/001-楔子.md', JSON.stringify(t));
    const chip = ui.doc.querySelector('#pendingCmd .cmd-chip');
    assert.ok(chip?.textContent.includes('重寫正文'), chip?.textContent);
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, before);
  });

  test('寫下要求點傳送：寫的是這一章的正文（後端按重寫走），帶著要求', () => {
    ui.doc.getElementById('input').value = '節奏再快一點';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    const sent = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sent?.payload.stage, 'manuscript', JSON.stringify(sent?.payload));
    assert.equal(sent.payload.capability, 'generate');
    assert.equal(sent.payload.target.plotRelPath, '.novelwarden/summaries/001-楔子.md', JSON.stringify(sent.payload));
    assert.equal(sent.payload.text, '節奏再快一點');
    ui.post({ type: 'busy', value: false });
  });

  // 設定名錄：定稿過、正文沒再改過的章可以單獨記一次設定（只換細綱「設定」一節），帶的也是章節路徑。
  test('定稿過的章：「記設定」發 recordLore，帶章節路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '記設定（預計 2 次呼叫，最多 3 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'recordLore', JSON.stringify(msg));
    assert.equal(msg.relPath, 'chapters/001-楔子.md', JSON.stringify(msg));
  });

  test('點「開啟草稿」發 openDraft，帶的是章節路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '開啟草稿');
    const draftMsg = ui.last('openDraft');
    assert.ok(draftMsg, '沒發出 openDraft');
    assert.equal(draftMsg.path, 'chapters/001-楔子.md', JSON.stringify(draftMsg));
  });

  test('點刪除發 fileAction，帶的是主路徑', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '刪除（移到回收站）');
    const del = ui.last('fileAction');
    assert.ok(del, '沒發出 fileAction');
    assert.equal(del.action, 'delete', JSON.stringify(del));
    assert.equal(del.relPath, 'chapters/001-楔子.md', JSON.stringify(del));
  });

  test('點完選單關閉', () => {
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  test('「重新命名」發 fileAction', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重新命名');
    assert.equal(ui.last('fileAction').action, 'rename');
  });

  // ---- 作者手寫、只有正文沒有細綱的章（第 2 章）：寫夠了，等著定稿（定稿時照正文整理一份細綱）。
  test('沒有細綱的章不給「開啟細綱」', () => {
    legacyItems = ui.itemsOf(ui.rightClick(plotRow('入鎮')));
    assert.ok(!legacyItems.includes('開啟細綱'), JSON.stringify(legacyItems));
    assert.ok(legacyItems.includes('開啟正文'), JSON.stringify(legacyItems));
  });

  // 定稿 = 照正文更新細綱（帶連續性事實）+ 出場角色的當前狀態（四期）+ 敘事線（七期），
  // 選單上寫著呼叫次數（D17）。
  test('沒定稿的章給「定稿（細綱 + 角色狀態 + 敘事線）」並寫著呼叫次數', () => {
    assert.ok(legacyItems.includes('同步（細綱 + 角色狀態 + 敘事線 + 故事時間，預計 6–12 次呼叫，最多 18 次）'), JSON.stringify(legacyItems));
    assert.ok(!legacyItems.includes('重新同步'), JSON.stringify(legacyItems));
    // 沒定稿的章「設定」一節是計劃，記了也會被定稿沖掉：不給單獨記設定。
    assert.ok(!legacyItems.includes('記設定（預計 2 次呼叫，最多 3 次）'), JSON.stringify(legacyItems));
  });

  test('沒有草稿時給「新建草稿」', () => {
    assert.ok(legacyItems.includes('新建草稿'), JSON.stringify(legacyItems));
    ui.closeMenu();
  });

  test('「定稿」發 askFinalizeChapter，帶的是章節路徑', () => {
    ui.pick(ui.rightClick(plotRow('入鎮')), '同步（細綱 + 角色狀態 + 敘事線 + 故事時間，預計 6–12 次呼叫，最多 18 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'askFinalizeChapter', JSON.stringify(msg));
    assert.equal(msg?.relPath, 'chapters/002-入鎮.md', JSON.stringify(msg));
  });

  // 沒有細綱時「細綱」那一層仍然進得去：落點是它**應在**的位置，進去就是補細綱。
  test('沒有細綱的章點「細綱」切到它應在的位置', () => {
    ui.pick(ui.rightClick(plotRow('入鎮')), '細綱（0%）');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'plot', JSON.stringify(t));
    assert.equal(t?.target.plotRelPath, '.novelwarden/summaries/002-入鎮.md', JSON.stringify(t));
  });

  // ---- 細綱排好、還沒寫正文的章（第 4 章）：正文那幾項都沒有。
  test('沒寫正文的章選單隻給「開啟細綱」', () => {
    planningItems = ui.itemsOf(ui.rightClick(plotRow('北行')));
    assert.ok(planningItems.includes('開啟細綱'), JSON.stringify(planningItems));
    assert.ok(!planningItems.includes('開啟正文'), JSON.stringify(planningItems));
  });

  // 定稿、草稿讀的都是正文——沒有正文就無從談起。
  for (const label of ['重寫正文', '重新同步', '同步（細綱 + 角色狀態 + 敘事線 + 故事時間，預計 6–12 次呼叫，最多 18 次）', '開啟草稿', '新建草稿']) {
    test(`沒寫正文的章選單不含「${label}」`, () => {
      assert.ok(!planningItems.includes(label), JSON.stringify(planningItems));
    });
  }

  test('沒寫正文的章選單仍有「進入這一章」與兩層入口', () => {
    for (const label of ['進入這一章', '細綱（100%）', '正文（0%）']) {
      assert.ok(planningItems.includes(label), JSON.stringify(planningItems));
    }
    ui.closeMenu();
  });

  test('沒寫正文的章「進入這一章」帶的是細綱路徑', () => {
    ui.pick(ui.rightClick(plotRow('北行')), '進入這一章');
    assert.equal(ui.last('selectPlot')?.plotRelPath, '.novelwarden/summaries/004-北行.md');
  });

  test('沒寫正文的章刪除落在細綱上', () => {
    ui.pick(ui.rightClick(plotRow('北行')), '刪除（移到回收站）');
    assert.equal(ui.last('fileAction')?.relPath, '.novelwarden/summaries/004-北行.md');
  });

  // ---- 資料夾行：「在此新建」的落點必須是這個資料夾，不是區根目錄。
  test('資料夾選單含「在此新建角色卡」', () => {
    folderItems = ui.itemsOf(ui.rightClick(rowWith('配角')));
    assert.ok(folderItems.includes('在此新建角色卡'), JSON.stringify(folderItems));
  });

  test('資料夾選單含摺疊項', () => {
    assert.ok(folderItems.includes('展開') || folderItems.includes('摺疊'), JSON.stringify(folderItems));
  });

  test('資料夾的「在此新建角色卡」帶 dir', () => {
    ui.pick(ui.doc.querySelector('.ctx-menu'), '在此新建角色卡');
    const add = ui.last('projectAction');
    assert.ok(add, '沒發出 projectAction');
    assert.equal(add.action, 'newCharacter', JSON.stringify(add));
    assert.equal(add.dir, '.novelwarden/characters/配角', JSON.stringify(add));
  });

  test('「在此新建資料夾」帶 dir', () => {
    ui.pick(ui.rightClick(rowWith('配角')), '在此新建資料夾');
    const mk = ui.last('projectAction');
    assert.ok(mk, '沒發出 projectAction');
    assert.equal(mk.action, 'newFolder', JSON.stringify(mk));
    assert.equal(mk.dir, '.novelwarden/characters/配角', JSON.stringify(mk));
  });

  // ---- 角色檔案行
  test('角色行選單含開啟與三個類檔案操作', () => {
    ui.clickEl(dirLabel('配角'));
    fileItems = ui.itemsOf(ui.rightClick(rowWith('林昭')));
    assert.ok(['開啟', '重新命名', '移動到…', '刪除（移到回收站）'].every((l) => fileItems.includes(l)),
      JSON.stringify(fileItems));
  });

  test('角色行選單沒有「在此新建」', () => {
    assert.ok(!fileItems.some((l) => l.startsWith('在此新建')));
    ui.closeMenu();
  });

  // 點檔名仍走 openPath：外掛的 body 沒有 #wbEditor，應當發 openFile。
  test('點角色名發 openFile（外掛殼無內建編輯器）', () => {
    ui.clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '林昭'));
    const open = ui.last('openFile');
    assert.ok(open, '沒發出 openFile');
    assert.equal(open.path, '.novelwarden/characters/林昭.md', JSON.stringify(open));
  });

  // ---- 分組標題欄：落點是該區根目錄。
  // 注意用精確匹配取分組名：「出場人物 · 未建卡」也含「角色」二字之外的字樣，
  // 而角色區標題就是「角色」，includes 在兩組都在時會撞上第一個。
  test('分組標題欄的新建落點為區根目錄', () => {
    groupHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '角色');
    ui.pick(ui.rightClick(groupHead), '在此新建角色卡');
    const rootAdd = ui.last('projectAction');
    assert.equal(rootAdd.action, 'newCharacter', JSON.stringify(rootAdd));
    assert.equal(rootAdd.dir, '.novelwarden/characters', JSON.stringify(rootAdd));
  });

  // ---- 「文風與摘要」是工程固定檔案，不能重新命名/刪除。情節大綱已經挪進「故事架構」
  // 那一組，這裡拿文風指南那一行驗。
  let metaItems;
  test('固定後設資料行的選單沒有重新命名/刪除', () => {
    metaItems = ui.itemsOf(ui.rightClick(rowWith('文風指南')));
    assert.ok(!metaItems.includes('重新命名') && !metaItems.includes('刪除（移到回收站）'),
      JSON.stringify(metaItems));
  });

  test('固定後設資料行的選單有開啟與重新整理', () => {
    assert.ok(metaItems.includes('開啟') && metaItems.includes('重新整理'), JSON.stringify(metaItems));
  });

  // 從前這一組底下還掛著一行「同步過期細綱 / 提取/更新角色卡」（單章摘要時代的遺留），
  // 那四件事在別處都有入口：同步在頁頂黃條，提取在「角色」組右鍵，兩個批次在工具欄與「章節」組右鍵。
  // 敘事線那一行計數也不在這裡了：敘事線單佔一個頁籤（敘事線重做第 8 個提交）。
  test('「文風與摘要」只有全文大綱、文風指南兩行，沒有工具行', () => {
    const group = [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '文風與摘要');
    const labels = [...group.querySelectorAll('.group-body > .row .row-label')].map((n) => n.textContent);
    assert.deepEqual(labels, ['全文大綱', '文風指南'], group.outerHTML);
    assert.ok(!group.textContent.includes('同步過期細綱') && !group.textContent.includes('提取/更新角色卡'), group.textContent);
  });

  // ---- 角色分組：批次更新/重建。
  let charItems;
  test('角色分組選單含批次項', () => {
    charItems = ui.itemsOf(ui.rightClick(groupHead));
    assert.ok(charItems.includes('更新所有角色卡') && charItems.includes('從頭重建所有角色卡'),
      JSON.stringify(charItems));
  });

  test('角色分組選單仍含新建項', () => {
    assert.ok(charItems.includes('在此新建角色卡'), JSON.stringify(charItems));
  });

  test('「更新所有角色卡」發 updateAllCards', () => {
    ui.pick(ui.rightClick(groupHead), '更新所有角色卡');
    const upAll = ui.last('characterAction');
    assert.ok(upAll, '沒發出 characterAction');
    assert.equal(upAll.action, 'updateAllCards', JSON.stringify(upAll));
  });

  test('「從頭重建」發 rebuildAllCards', () => {
    ui.pick(ui.rightClick(groupHead), '從頭重建所有角色卡');
    const reAll = ui.last('characterAction');
    assert.ok(reAll, '沒發出 characterAction');
    assert.equal(reAll.action, 'rebuildAllCards', JSON.stringify(reAll));
    ui.closeMenu();
  });

  // ---- 設定分組：名錄的三件維護（有待辦才出現，見 loreCatalog.test.js）與手動新建並存。
  // 整本重掃的「從已寫正文生成/更新設定」刪了。
  let loreHead;
  let loreItems;
  test('設定分組選單：沒有整本重掃', () => {
    loreHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '設定');
    loreItems = ui.itemsOf(ui.rightClick(loreHead));
    assert.ok(!loreItems.some((i) => i.includes('從已寫正文生成')), JSON.stringify(loreItems));
    ui.closeMenu();
  });

  test('設定分組選單仍含手動新建', () => {
    assert.ok(loreItems.includes('在此新建設定'), JSON.stringify(loreItems));
  });

  // ---- 章節分組：三個新建項 + 兩個批次動作。
  // 章節組沒有 section（這一組按章號排、卷是一級目錄，不給「在此新建章節」那一套），
  // 所以它的選單全部來自 extraItems，分隔線要自己寫。
  let plotHead;
  let plotGroupItems;
  test('章節分組選單含三個新建項與兩個批次動作', () => {
    plotHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章節');
    plotGroupItems = ui.itemsOf(ui.rightClick(plotHead));
    for (const label of ['新建細綱（接在最後一章之後）', '新建章節檔案（直接粘正文用）', '新建卷…',
      '批次拆細綱…', '批次寫章…']) {
      assert.ok(plotGroupItems.includes(label), JSON.stringify(plotGroupItems));
    }
  });

  // 批次拆場景隨場景層一起刪掉了。忘記刪的話選單裡會多一條點了會炸的項。
  test('章節分組選單不再有批次拆場景', () => {
    assert.ok(!plotGroupItems.some((x) => x.includes('拆分場景')), JSON.stringify(plotGroupItems));
    ui.closeMenu();
  });

  // 卷 = 章節根下的一級目錄（2026-10-23，原「在此新建資料夾」）：落點是章節根，後端據此認出是章節區、說法換成卷。
  test('章節分組「新建卷…」發 newFolder，落點是章節根', () => {
    ui.pick(ui.rightClick(plotHead), '新建卷…');
    const msg = ui.last('projectAction');
    assert.ok(msg, '沒發出 projectAction');
    assert.equal(msg.action, 'newFolder', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters', JSON.stringify(msg));
    ui.closeMenu();
  });

  for (const [label, action] of [
    ['新建細綱（接在最後一章之後）', 'newPlot'],
    ['新建章節檔案（直接粘正文用）', 'newChapter'],
  ]) {
    test(`「${label}」發 ${action}`, () => {
      ui.pick(ui.rightClick(plotHead), label);
      const msg = ui.last('projectAction');
      assert.ok(msg, '沒發出 projectAction');
      assert.equal(msg.action, action, JSON.stringify(msg));
      ui.closeMenu();
    });
  }

  // 頁籤條上原來的五顆按鈕（補齊架構、拆細綱…、批次寫章…、＋ 角色卡、＋ 設定）在分組右鍵裡都有，拿掉了：
  // 「故事架構」組右鍵「補齊架構（只補空白）」，「章節」組右鍵兩個批次，「角色」「設定」組右鍵「在此新建…」。
  test('頁籤條：五個頁籤、存檔點（⚑）與重新整理，沒有別的按鈕', () => {
    const bar = ui.doc.getElementById('projectTabs');
    const parts = [...bar.children].map((n) => (n.classList.contains('spacer') ? '~' : n.textContent.trim()));
    assert.deepEqual(parts, ['概覽', '章節', '角色', '設定', '敘事線', '~', '⚑', '⟳'], JSON.stringify(parts));
    assert.equal(bar.querySelectorAll('.chip-btn').length, 0);
    assert.deepEqual([...bar.querySelectorAll('[data-form]')].map((b) => b.dataset.form), ['checkpoints']);
    assert.deepEqual([...bar.querySelectorAll('[data-action]')].map((b) => b.dataset.action), ['refresh']);
  });

  test('「重新整理」發 refresh', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('#projectTabs [data-action="refresh"]'));
    assert.equal(ui.last('projectAction')?.action, 'refresh', JSON.stringify(ui.sent));
  });

  // 頁裡分組下面的空白也屬於這一頁：右鍵給的是這一頁主分組的選單，不只是一個「重新整理」。
  for (const [tab, label, action, dir] of [
    ['characters', '在此新建角色卡', 'newCharacter', '.novelwarden/characters'],
    ['lore', '在此新建設定', 'newLore', '.novelwarden/lore'],
    ['chapters', '新建細綱（接在最後一章之後）', 'newPlot', undefined],
    ['threads', '從大綱補充敘事線', 'generateThreads', undefined],
  ]) {
    test(`「${tab}」頁的空白處右鍵「${label}」發 ${action}`, () => {
      const panel = ui.doc.querySelector(`#projectBody [data-project-panel="${tab}"]`);
      ui.sent.length = 0;
      ui.pick(ui.rightClick(panel), label);
      const msg = ui.last('projectAction');
      assert.equal(msg?.action, action, JSON.stringify(ui.sent));
      assert.equal(msg.dir, dir, JSON.stringify(msg));
      ui.closeMenu();
    });
  }
});

/**
 * 工程頁的五個頁籤（概覽 / 章節 / 角色 / 設定 / 敘事線）：章節、角色、設定、敘事線各佔一頁，其餘留在「概覽」。
 * 五頁全畫、只露當前那一頁；切頁籤不往後端要資料，重推樹不換頁。
 */
describe('工程頁的頁籤', { skip: JSDOM_SKIP }, () => {
  let ui;
  const panel = (tab) => ui.doc.querySelector(`#projectBody [data-project-panel="${tab}"]`);
  const tabBtn = (tab) => ui.doc.querySelector(`#projectTabs [data-project-tab="${tab}"]`);
  const groupsIn = (tab) => [...panel(tab).querySelectorAll('.group-name')].map((n) => n.textContent);
  const shown = () => [...ui.doc.querySelectorAll('#projectBody [data-project-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.projectPanel);

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('預設是「概覽」，只露這一頁', () => {
    assert.deepEqual(shown(), ['overview']);
    assert.equal(tabBtn('overview').getAttribute('aria-selected'), 'true');
    assert.ok(tabBtn('overview').classList.contains('active'));
  });

  test('「概覽」是故事架構與文風與摘要；章節、角色、設定、敘事線各在自己那一頁', () => {
    assert.deepEqual(groupsIn('overview'), ['故事架構', '文風與摘要']);
    assert.deepEqual(groupsIn('chapters'), ['章節']);
    assert.deepEqual(groupsIn('characters'), ['角色', '出場人物 · 未建卡']);
    assert.equal(groupsIn('lore')[0], '設定');
    assert.deepEqual(groupsIn('threads'), ['敘事線']);
  });

  test('沒有作品名那一塊', () => {
    assert.equal(ui.doc.querySelector('#projectBody .project-head, #projectBody .project-title'), null);
  });

  test('定稿進度橫幅在「概覽」頁最上面', () => {
    const banner = ui.doc.querySelector('#projectBody .banner-summary');
    assert.equal(banner?.parentElement, panel('overview'));
    assert.equal(panel('overview').firstElementChild, banner);
  });

  test('點頁籤切頁，不往後端發東西', () => {
    ui.sent.length = 0;
    ui.clickEl(tabBtn('chapters'));
    assert.deepEqual(shown(), ['chapters']);
    assert.equal(tabBtn('chapters').getAttribute('aria-selected'), 'true');
    assert.equal(tabBtn('overview').getAttribute('aria-selected'), 'false');
    assert.equal(tabBtn('chapters').tabIndex, 0);
    assert.equal(tabBtn('overview').tabIndex, -1);
    assert.deepEqual(ui.sent, []);
  });

  test('重推樹不換頁', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.deepEqual(shown(), ['chapters']);
    assert.ok(tabBtn('chapters').classList.contains('active'));
  });

  test('方向鍵與 Home / End 在頁籤之間走', () => {
    const press = (key) =>
      ui.doc.querySelector('#projectTabs .project-tab.active').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, bubbles: true }));
    press('ArrowRight');
    assert.deepEqual(shown(), ['characters']);
    press('ArrowRight');
    assert.deepEqual(shown(), ['lore']);
    press('ArrowRight');
    assert.deepEqual(shown(), ['threads']);
    press('ArrowRight');
    assert.deepEqual(shown(), ['overview']);
    press('ArrowLeft');
    assert.deepEqual(shown(), ['threads']);
    press('End');
    assert.deepEqual(shown(), ['threads']);
    press('Home');
    assert.deepEqual(shown(), ['overview']);
    assert.equal(ui.doc.activeElement, tabBtn('overview'));
  });

  test('還不是小說工程：頁籤條藏起來', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), initialized: false } });
    assert.ok(ui.doc.getElementById('projectTabs').classList.contains('hidden'));
    assert.ok(ui.doc.querySelector('#projectBody .project-empty'));
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(!ui.doc.getElementById('projectTabs').classList.contains('hidden'));
  });
});

describe('右鍵選單的通用行為', { skip: JSDOM_SKIP }, () => {
  let ui;
  let historyMenu;

  before(() => {
    ui = mount();
  });

  // 其它頁面只要基礎重新整理。
  test('歷史頁右鍵彈出選單', () => {
    historyMenu = ui.rightClick(ui.doc.getElementById('pane-history'));
    assert.ok(historyMenu);
  });

  test('歷史頁選單隻有「重新整理」', () => {
    assert.deepEqual(ui.itemsOf(historyMenu), ['重新整理'], JSON.stringify(ui.itemsOf(historyMenu)));
  });

  test('點「重新整理」發 projectAction refresh', () => {
    ui.clickEl(historyMenu.querySelector('button'));
    const refresh = ui.last('projectAction');
    assert.ok(refresh, '沒發出 projectAction');
    assert.equal(refresh.action, 'refresh', JSON.stringify(refresh));
  });

  test('設定頁右鍵也給重新整理', () => {
    assert.ok(ui.itemsOf(ui.rightClick(ui.doc.getElementById('pane-settings'))).includes('重新整理'));
  });

  // 同時只允許一個選單。
  test('同時只存在一個選單', () => {
    ui.rightClick(ui.doc.getElementById('pane-chat'));
    assert.equal(ui.doc.querySelectorAll('.ctx-menu').length, 1);
  });

  // 用絕對定位掛在 body 上，不會被內部滾動容器裁掉。
  test('選單掛在 body 上', () => {
    assert.equal(ui.doc.querySelector('.ctx-menu').parentElement, ui.doc.body);
  });

  test('點空白處關閉選單', () => {
    ui.closeMenu();
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  test('按 Esc 關閉選單', () => {
    ui.rightClick(ui.doc.getElementById('pane-history'));
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  // 氣泡的 ⋯ 選單與右鍵選單是兩個類名，互不干擾。
  test('⋯ 選單仍用 .msg-menu 且貼在氣泡裡', () => {
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    ui.clickEl(ui.bubble('u1').querySelector('.msg-menu-btn'));
    assert.ok(ui.doc.querySelector('.msg-menu'));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  // ⋯ 選單掛在氣泡裡、跟著一起滾，不該被滾動關掉——否則流式輸出貼著底
  // 跟滾時每來一段都 scrollToBottom()，選單剛點開就沒了。
  test('滾動不關閉 ⋯ 選單', () => {
    ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(ui.doc.querySelector('.msg-menu'));
  });

  test('右鍵會頂掉已開啟的 ⋯ 選單', () => {
    ui.rightClick(ui.doc.getElementById('pane-history'));
    assert.ok(!ui.doc.querySelector('.msg-menu'));
    assert.ok(ui.doc.querySelector('.ctx-menu'));
  });

  // 右鍵選單是 fixed 的，一滾就和目標行脫節，必須關掉。
  test('滾動關閉右鍵選單', () => {
    ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
    ui.closeMenu();
  });
});

/*
 * 原生右鍵選單一律不許出現。
 *
 * 觸控板雙指點選走的事件序列與按實體右鍵不一樣：有的環境發 contextmenu，
 * 有的只發 auxclick；頁面裡任何一處 stopPropagation() 又能讓冒泡階段的監聽
 * 根本輪不到。三樣都得擋住，漏一樣就是「彈出原生右鍵選單」。
 */
describe('接管原生右鍵選單', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('contextmenu 的預設行為被擋掉', () => {
    const ev = new ui.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    });
    ui.doc.getElementById('pane-history').dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, '沒有 preventDefault，原生選單會彈出來');
    ui.closeMenu();
  });

  // 監聽掛在 window 的捕獲階段，所以中途 stopPropagation 也攔不住它。
  test('半路 stopPropagation 仍擋得住', () => {
    const pane = ui.doc.getElementById('pane-history');
    const swallow = (e) => e.stopPropagation();
    pane.addEventListener('contextmenu', swallow);
    const ev = new ui.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    });
    pane.dispatchEvent(ev);
    pane.removeEventListener('contextmenu', swallow);
    assert.ok(ev.defaultPrevented, '被 stopPropagation 擋掉了，原生選單會彈出來');
    assert.ok(ui.doc.querySelector('.ctx-menu'), '選單也沒彈出來');
    ui.closeMenu();
  });

  // 只發 auxclick 的環境（部分瀏覽器/驅動下的雙指點選）。落點與上一發不同，
  // 所以不會被「同一次點選的尾巴」那條規則吃掉。
  test('只發 auxclick 也彈自己的選單', () => {
    const ev = ui.auxClick(ui.doc.getElementById('pane-history'), 100, 120);
    assert.ok(ev.defaultPrevented, 'auxclick 的預設行為沒擋');
    assert.ok(ui.doc.querySelector('.ctx-menu'), '沒彈出選單');
  });

  // 同一次點選的尾巴：contextmenu 之後緊跟的那發 auxclick 不該再彈一遍。
  test('contextmenu 之後的 auxclick 不重複彈', () => {
    ui.closeMenu();
    const menu = ui.rightClick(ui.doc.getElementById('pane-history'));
    ui.auxClick(ui.doc.getElementById('pane-history'));
    const now = ui.doc.querySelectorAll('.ctx-menu');
    assert.equal(now.length, 1, `彈了 ${now.length} 個`);
    assert.equal(now[0], menu, '選單被重建了一遍');
    ui.closeMenu();
  });

  // 中鍵（button 1）不接管：那是「新標籤頁開啟」之類的預設行為，不是右鍵。
  test('中鍵的 auxclick 不彈選單', () => {
    const ev = new ui.window.MouseEvent('auxclick', {
      bubbles: true, cancelable: true, button: 1, clientX: 40, clientY: 60,
    });
    ui.doc.getElementById('pane-history').dispatchEvent(ev);
    assert.ok(!ev.defaultPrevented);
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });
});
