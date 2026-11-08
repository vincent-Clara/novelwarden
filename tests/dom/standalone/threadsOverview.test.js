/**
 * 編輯區「敘事線總覽」標籤（`media/src/editor/threadsOverview.ts`，敘事線重做三期）與它的兩個入口（工程頁「敘事線」頁籤標題旁
 * 的「總覽」、行右鍵「在總覽裡看」）。矩陣由後端推來（`threadsOverview`），這裡按訊息造；後端怎麼算在
 * tests/unit/views/threadsOverview.test.js 與 tests/integration/views/threadsOverview.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 能力探測 | 外掛的 webview 只有 view.js：「總覽」「在總覽裡看」「開啟敘事線總覽」都不畫；獨立版有；一條線都沒有不給 |
 * | 標籤 | 標籤條上一個不對應檔案的特殊標籤（排在檔案前面）；切到檔案就藏起覆蓋層、切回來再露出來；× / Ctrl+W 關掉回到原來那份檔案；「▾」裡也有它 |
 * | 矩陣 | 列頭的章號、卷名、定稿狀態，「定稿到第 N 章」那條豎線；按種類分組、線下面是伏筆、最後是「未歸屬的伏筆」 |
 * | 敘事線判到哪（四期） | 落後於定稿時頭上說判到第幾章、另一條虛豎線；定稿了還沒判的列頭另標，懸停說這一章的計劃不算偏差 |
 * | 四種格子 | ○ 只有計劃、● 只有實際、◉ 計劃也發生了、紅圈偏差；計劃區間一條淡底 |
 * | 伏筆連線 | 收了的實線、埋了沒收的虛線（逾期標紅）、還沒埋的淡虛線；回收章一道豎線；埋 ● 收 ◆ 棄 ✕，計劃的空心 |
 * | 點選 | 點格子 / 列頭髮 `openChapter`（有正文給正文路徑，只有細綱給細綱路徑，都沒有說一句不發）；點線名、伏筆名、「未歸屬的伏筆」發 `openEditor` |
 * | 觸屏與右鍵 | 手指點格子 / 列頭只彈浮窗、不發 `openChapter`（相容滑鼠事件不收它，點別處收）；滑鼠照舊開啟；右鍵（長按）格子給「開啟第 N 章」 |
 * | 懸停 | 那一格的計劃與實際事件、證據、偏差說一句 |
 * | 定位 | 右鍵「在總覽裡看」開啟並標出那一行 |
 * | 資料 | 按需要（requestId）；別人的 requestId 不認；顯示著收到 `state` 停一下再要；藏著時不要，切回來再要 |
 * | 重新整理恢復 | 記著、恢復時先開總覽，陸續回來的檔案不把它換下去；記壞了的不認、不崩；沒在顯示的恢復成背景標籤 |
 * | 換工程 | 標籤關掉 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState, sampleTree } = require('../../helpers/dom');

const T = (name) => `.novelwarden/threads/${name}.md`;
const UNFILED = T('未归属的伏笔');
const STORE_KEY = 'novelforge.editor.v1';

const ev = (type, what, evidence, foreshadowing) => ({
  type,
  ...(foreshadowing ? { foreshadowing } : {}),
  what,
  ...(evidence ? { evidence } : {}),
});
const cell = (chapter, planned, actual, deviation = false) => ({ chapter, planned, actual, deviation });

/**
 * 一份矩陣：第 1–3 章定稿了（根下）、第 4 章寫了沒定稿、第 5 章只有細綱、第 6 章什麼都沒有（第二卷）；「現在」第 3 章。
 * 主線一條（四種格子各一格）、感情線一條（兩條伏筆：收了的、計劃埋卻沒埋的）；「未歸屬的伏筆」兩條（逾期的、棄了的）。
 */
function overview(extra = {}) {
  const ch = (no, state, title, volume, paths) => ({ no, title, volume, state, ...paths });
  return {
    initialized: true,
    current: 3,
    through: 3,
    volumes: true,
    chapters: [
      ch(1, 'finalized', '楔子', '', { chapterPath: 'chapters/001-楔子.md', plotPath: '.novelwarden/summaries/001-楔子.md' }),
      ch(2, 'finalized', '入鎮', '', { chapterPath: 'chapters/002-入鎮.md', plotPath: '.novelwarden/summaries/002-入鎮.md' }),
      ch(3, 'finalized', '夜訪', '', { chapterPath: 'chapters/003-夜訪.md', plotPath: '.novelwarden/summaries/003-夜訪.md' }),
      ch(4, 'written', '北行', '第二卷', { chapterPath: 'chapters/第二卷/004-北行.md' }),
      ch(5, 'planned', '赤星', '第二卷', { plotPath: '.novelwarden/summaries/第二卷/005-赤星.md' }),
      ch(6, 'none', '', '第二卷', {}),
    ],
    groups: [
      {
        kind: '主线',
        lines: [
          {
            name: '青崖舊案',
            relPath: T('青崖舊案'),
            kind: '主线',
            status: '进行中',
            from: 1,
            to: 6,
            detail: '主線 · 進行中 · 最近第 3 章',
            warnings: [],
            tip: '意圖：查清七年前那場火',
            cells: [
              cell(1, [], [ev('推进', '回到青崖', '雨下了三天')]),
              cell(2, [ev('推进', '打聽名冊')], [], true),
              cell(3, [ev('推进', '找到空匣')], [ev('推进', '夜訪舊宅，找到空匣', '匣子是空的')]),
              cell(5, [ev('推进', '北上')], []),
            ],
            foreshadowing: [],
          },
        ],
      },
      {
        kind: '感情线',
        lines: [
          {
            name: '林昭與沈氏',
            relPath: T('林昭與沈氏'),
            kind: '感情线',
            status: '进行中',
            detail: '感情線 · 進行中 · 最近第 3 章 · 1 條伏筆沒收',
            warnings: ['1 條伏筆逾期'],
            tip: '',
            cells: [cell(2, [], [ev('关系', '猜忌 → 結盟', '你的仇就是我的仇')])],
            foreshadowing: [
              {
                name: '玉佩的來歷',
                what: '林昭的玉佩是沈家舊物',
                status: '已收',
                plant: 1,
                resolve: 3,
                plantedAt: 1,
                closedAt: 3,
                overdue: false,
                span: { from: 1, to: 3, kind: 'done' },
                tip: '林昭的玉佩是沈家舊物\n計劃第 1 章埋、第 3 章前收\n第 3 章收了',
                cells: [
                  cell(1, [], [ev('埋', '玉佩露面', '他摸了摸懷裡的玉佩', '玉佩的來歷')]),
                  cell(3, [ev('收', '認出雲紋', undefined, '玉佩的來歷')], [ev('收', '認出雲紋', '這是沈家的雲紋', '玉佩的來歷')]),
                ],
              },
              {
                name: '沈氏的舊傷',
                what: '左臂的刀疤',
                status: '计划',
                plant: 2,
                resolve: 6,
                overdue: false,
                span: { from: 2, to: 6, kind: 'planned' },
                tip: '左臂的刀疤\n計劃第 2 章埋、第 6 章前收\n還沒埋',
                cells: [cell(2, [ev('埋', '換藥時露出刀疤', undefined, '沈氏的舊傷')], [], true)],
              },
            ],
          },
        ],
      },
    ],
    unfiled: {
      relPath: UNFILED,
      foreshadowing: [
        {
          name: '斷劍',
          what: '劍上刻著青崖二字',
          status: '已埋',
          resolve: 2,
          plantedAt: 1,
          overdue: true,
          span: { from: 1, to: 3, kind: 'open' },
          tip: '劍上刻著青崖二字\n第 2 章前收\n第 1 章埋下，還沒收，過了第 2 章（逾期）',
          cells: [cell(1, [], [ev('埋', '斷劍出土', '半截斷劍', '斷劍')])],
        },
        {
          name: '火摺子',
          what: '',
          status: '已弃',
          closedAt: 2,
          overdue: false,
          tip: '第 2 章棄了',
          cells: [cell(2, [], [ev('弃', '扔進河裡', '撲通一聲', '火摺子')])],
        },
      ],
    },
    ...extra,
  };
}

/** 獨立版：view.js + editor.js，推一條 state 與工程樹。 */
function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['scrollIntoView', 'clipboard', ...(opts.shims ?? [])], ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  ui.post({ type: 'project', tree: opts.tree ?? sampleTree() });
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    window,
    toasts,
    threadsPanel: () => doc.querySelector('#projectBody [data-project-panel="threads"]'),
    overviewBtn: () => doc.querySelector('#projectBody .threads-overview-btn'),
    projectRow: (name) => [...doc.querySelectorAll('#projectBody .row-thread')].find((r) => r.querySelector('.row-label')?.textContent === name),
    specialTab: () => doc.querySelector('#edTabs .ed-tab-special'),
    tabs: () => [...doc.querySelectorAll('#edTabs .ed-tab')].map((t) => t.querySelector('.ed-tab-name').textContent),
    activeTab: () => doc.querySelector('#edTabs .ed-tab.active .ed-tab-name')?.textContent,
    tov: () => doc.querySelector('.wb-editor .ed-stage .tov'),
    shown: () => !!h.tov() && !h.tov().classList.contains('hidden'),
    note: () => {
      const n = doc.querySelector('.tov .tov-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    row: (path) => doc.querySelector(`.tov-row[data-path="${path}"]`),
    foreRow: (name) => [...doc.querySelectorAll('.tov-row-fore')].find((r) => r.querySelector('.tov-link')?.textContent === name),
    cellOf: (row, no) => row.querySelector(`.tov-cell[data-ch="${no}"]`),
    open() {
      ui.clickEl(h.overviewBtn());
    },
    respond(o = overview()) {
      const req = ui.last('requestThreadsOverview');
      assert.ok(req, '沒發 requestThreadsOverview');
      ui.post({ type: 'threadsOverview', requestId: req.requestId, overview: o });
    },
    openFile(path) {
      ui.post({ type: 'editorOpen', file: file(path, `${path} 的內容`) });
    },
    count: (type) => ui.sent.filter((m) => m.type === type).length,
    sentAfter: (n) => JSON.parse(JSON.stringify(ui.sent.slice(n))),
  };
  return h;
}

describe('敘事線總覽 · 能力探測（VS Code 外掛沒有內建編輯器）', { skip: JSDOM_SKIP }, () => {
  test('外掛的 webview（只有 view.js）：標題旁沒有「總覽」，右鍵沒有「在總覽裡看」「開啟敘事線總覽」', () => {
    const ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    const panel = ui.doc.querySelector('#projectBody [data-project-panel="threads"]');
    assert.ok(panel.querySelector('.threads-head'), '標題旁那一截還在（「從大綱補充」）');
    assert.equal(panel.querySelector('.threads-overview-btn'), null);
    assert.ok(![...panel.querySelectorAll('.threads-head button')].some((b) => b.textContent === '總覽'));
    const row = [...panel.querySelectorAll('.row-thread')].find((r) => r.textContent.includes('青崖舊案'));
    const items = ui.itemsOf(ui.rightClick(row));
    assert.ok(items.includes('開啟') && !items.includes('在總覽裡看'), JSON.stringify(items));
    ui.closeMenu();
    const groupItems = ui.itemsOf(ui.rightClick(panel.querySelector('.group-head')));
    assert.ok(!groupItems.includes('開啟敘事線總覽'), JSON.stringify(groupItems));
    ui.closeMenu();
  });

  test('獨立版：標題旁有「總覽」，行右鍵有「在總覽裡看」，組標題右鍵有「開啟敘事線總覽」', () => {
    const h = harness();
    assert.equal(h.overviewBtn()?.textContent, '總覽');
    const items = h.ui.itemsOf(h.ui.rightClick(h.projectRow('青崖舊案')));
    assert.deepEqual(items.slice(0, 2), ['開啟', '在總覽裡看']);
    h.ui.closeMenu();
    const unfiled = h.ui.itemsOf(h.ui.rightClick(h.projectRow('未歸屬的伏筆')));
    assert.ok(unfiled.includes('在總覽裡看'), JSON.stringify(unfiled));
    h.ui.closeMenu();
    const group = h.ui.itemsOf(h.ui.rightClick(h.threadsPanel().querySelector('.group-head')));
    assert.ok(group.includes('開啟敘事線總覽'), JSON.stringify(group));
    h.ui.closeMenu();
  });

  test('一條線、一條未歸屬的伏筆都沒有：不給「總覽」（開啟了也是空的）', () => {
    const h = harness({ tree: { ...sampleTree(), threads: { lines: [], current: 0, watch: { lines: [], foreshadowing: [] } } } });
    assert.equal(h.overviewBtn(), null);
    assert.ok(h.threadsPanel().querySelector('.threads-head'), '「從大綱排出」還在');
  });
});

describe('敘事線總覽 · 特殊標籤', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  test('點「總覽」：主區標籤條上多一個不對應檔案的「敘事線總覽」，覆蓋層掛在 .ed-stage 上；要資料、先說在讀', () => {
    const before = h.count('requestThreadsOverview');
    h.open();
    assert.ok(h.specialTab(), '沒有特殊標籤');
    assert.equal(h.specialTab().dataset.special, 'threads-overview');
    assert.ok(h.specialTab().classList.contains('active'));
    assert.deepEqual(h.tabs(), ['敘事線總覽']);
    assert.equal(h.specialTab().querySelector('.ed-tab-dirty'), null, '沒有髒標記');
    assert.ok(h.tov().closest('.wb-editor') === h.doc.getElementById('wbEditor'), '在主區');
    assert.ok(h.shown());
    assert.ok(h.doc.getElementById('edWelcome').classList.contains('hidden'), '歡迎頁藏起來');
    assert.equal(h.count('requestThreadsOverview'), before + 1);
    assert.match(h.ui.last('requestThreadsOverview').requestId, /^threads-/);
    assert.match(h.note(), /正在讀取/);
    // 不對應檔案：工具欄藏著、沒有「當前檔案」。
    assert.ok(h.doc.getElementById('edToolbar').classList.contains('hidden'));
  });

  test('已經開著再點「總覽」：不開第二個，切過去並再要一次', () => {
    h.open();
    h.respond();
    h.openFile('chapters/001-楔子.md');
    const before = h.count('requestThreadsOverview');
    h.open();
    assert.equal(h.doc.querySelectorAll('.ed-tab-special').length, 1);
    assert.deepEqual(h.tabs(), ['敘事線總覽', '001-楔子.md']);
    assert.equal(h.activeTab(), '敘事線總覽');
    assert.ok(h.shown());
    assert.equal(h.count('requestThreadsOverview'), before + 1);
  });

  test('切到一份檔案：覆蓋層藏起來；點特殊標籤再露出來；檔案標籤排在它後面', () => {
    h.open();
    h.respond();
    h.openFile('chapters/001-楔子.md');
    assert.equal(h.activeTab(), '001-楔子.md');
    assert.equal(h.shown(), false);
    assert.equal(h.doc.getElementById('edArea').classList.contains('hidden'), false);
    h.ui.clickEl(h.specialTab());
    assert.equal(h.activeTab(), '敘事線總覽');
    assert.ok(h.shown());
    assert.ok(h.doc.getElementById('edArea').classList.contains('hidden'), '正文區藏著');
    // 點檔案標籤切回去。
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'chapters/001-楔子.md'));
    assert.equal(h.shown(), false);
  });

  test('× 關掉：回到切過去之前的那份檔案；沒有檔案時回到歡迎頁', () => {
    h.openFile('a.md');
    h.openFile('b.md');
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    h.open();
    h.respond();
    h.ui.clickEl(h.specialTab().querySelector('.ed-tab-close'));
    assert.equal(h.specialTab(), null);
    assert.equal(h.activeTab(), 'a.md', '回到切過去之前的 a.md，不是最後一份');
    assert.equal(h.shown(), false);

    const g = harness();
    g.open();
    g.ui.clickEl(g.specialTab().querySelector('.ed-tab-close'));
    assert.equal(g.specialTab(), null);
    assert.equal(g.doc.getElementById('edWelcome').classList.contains('hidden'), false);
    assert.equal(g.doc.getElementById('edTabs').classList.contains('hidden'), true);
  });

  test('Ctrl+W 關掉正顯示著的特殊標籤；標籤右鍵「關閉」「重新整理」', () => {
    h.open();
    h.respond();
    const menu = h.ui.itemsOf(h.ui.rightClick(h.specialTab()));
    assert.deepEqual(menu, ['關閉', '重新整理']);
    const before = h.count('requestThreadsOverview');
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '重新整理');
    assert.equal(h.count('requestThreadsOverview'), before + 1);
    const e = new h.window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });
    h.doc.body.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
    assert.equal(h.specialTab(), null);
  });

  test('「▾」列表裡也有它，點了切過去', () => {
    h.open();
    h.respond();
    h.openFile('a.md');
    h.ui.clickEl(h.doc.querySelector('#edTabs .ed-tabs-more'));
    const items = [...h.doc.querySelectorAll('.ctx-menu button')].map((b) => b.textContent.trim());
    assert.ok(items.some((x) => x.endsWith('敘事線總覽')), JSON.stringify(items));
    [...h.doc.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.trim().endsWith('敘事線總覽')).click();
    assert.equal(h.activeTab(), '敘事線總覽');
    assert.ok(h.shown());
  });
});

describe('敘事線總覽 · 矩陣', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('頭上一行：定稿到第幾章、幾條線、幾條伏筆；圖例', () => {
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 2 條線 · 4 條伏筆');
    const legend = h.doc.querySelector('.tov-legend').textContent;
    for (const word of ['只有計劃', '只有實際', '計劃也發生了', '計劃了、同步了卻沒發生', '埋', '收', '棄']) {
      assert.ok(legend.includes(word), legend);
    }
    assert.equal(h.note(), '');
  });

  test('列頭：一章一列、章號、定稿狀態；分卷的書多一行卷名', () => {
    const cols = [...h.doc.querySelectorAll('.tov-nums .tov-col')];
    assert.deepEqual(cols.map((c) => c.textContent), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(
      cols.map((c) => ['finalized', 'written', 'planned', 'none'].find((s) => c.classList.contains(`tov-col-${s}`))),
      ['finalized', 'finalized', 'finalized', 'written', 'planned', 'none']
    );
    assert.ok(cols[2].classList.contains('tov-col-now'));
    assert.equal(cols[3].style.left, '72px');
    assert.match(cols[0].title, /第 1 章《楔子》 · 已同步/);
    assert.match(cols[3].title, /寫了，還沒同步/);
    assert.match(cols[5].title, /還沒有細綱/);
    const vols = [...h.doc.querySelectorAll('.tov-vols .tov-vol')];
    assert.deepEqual(vols.map((v) => [v.textContent, v.style.left, v.style.width]), [
      ['', '0px', '72px'],
      ['第二卷', '72px', '72px'],
    ]);
  });

  test('「定稿到第 3 章」：一條豎線畫在第 3 章右邊；敘事線跟上了定稿，不另畫', () => {
    const now = h.doc.querySelector('.tov-grid .tov-now');
    assert.ok(now);
    assert.equal(now.style.left, `${220 + 3 * 24}px`);
    assert.equal(now.title, '同步到第 3 章');
    assert.equal(h.doc.querySelector('.tov-grid .tov-judged'), null);
  });

  // 四期：定稿到第 3 章、敘事線只判到第 1 章——第 2、3 章定稿了還沒判。
  test('敘事線落後於定稿：頭上說判到第幾章；另一條虛豎線畫在第 1 章右邊；還沒判的列頭另標、懸停說計劃不算偏差', () => {
    const o = overview({ through: 1 });
    o.chapters = o.chapters.map((c) => (c.no === 2 || c.no === 3 ? { ...c, unjudged: true } : c));
    // 點「總覽」總是再要一次。
    h.open();
    h.respond(o);
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 敘事線判到第 1 章 · 2 條線 · 4 條伏筆');
    const judged = h.doc.querySelector('.tov-grid .tov-judged');
    assert.ok(judged);
    assert.equal(judged.style.left, `${220 + 1 * 24}px`);
    assert.match(judged.title, /^敘事線判到第 1 章/);
    assert.equal(h.doc.querySelector('.tov-grid .tov-now').style.left, `${220 + 3 * 24}px`);
    const cols = [...h.doc.querySelectorAll('.tov-nums .tov-col')];
    assert.deepEqual(cols.map((c) => c.classList.contains('tov-col-unjudged')), [false, true, true, false, false, false]);
    assert.match(cols[1].title, /已同步，敘事線還沒判（這一章的計劃不算偏差）/);
    assert.match(h.doc.querySelector('.tov-corner').title, /虛線：敘事線判到第 1 章/);
  });

  test('一章都沒判過：頭上說「敘事線還沒判過」，不畫虛線', () => {
    const o = overview({ through: 0 });
    h.open();
    h.respond(o);
    assert.equal(h.doc.querySelector('.tov-meta').textContent, '同步到第 3 章 · 敘事線還沒判過 · 2 條線 · 4 條伏筆');
    assert.equal(h.doc.querySelector('.tov-grid .tov-judged'), null);
  });

  test('行：按種類分組，每條線下面是它的伏筆，最後是「未歸屬的伏筆」', () => {
    const rows = [...h.doc.querySelectorAll('.tov-grid .tov-row')].map((r) => {
      const kind = ['group', 'line', 'fore'].find((k) => r.classList.contains(`tov-row-${k}`));
      return `${kind}:${r.querySelector('.tov-name').firstElementChild.textContent === '●' ? r.querySelector('.tov-link').textContent : r.querySelector('.tov-name').textContent}`;
    });
    assert.deepEqual(rows, [
      'group:主線1 條',
      'line:青崖舊案',
      'group:感情線1 條',
      'line:林昭與沈氏',
      'fore:玉佩的來歷',
      'fore:沈氏的舊傷',
      'group:未歸屬的伏筆2 條',
      'fore:斷劍⚠',
      'fore:火摺子',
    ]);
    // 線名懸停看說法、⚠、意圖；有 ⚠ 的掛一個 ⚠。
    const line = h.row(T('林昭與沈氏'));
    assert.match(line.querySelector('.tov-link').title, /感情線 · 進行中[\s\S]*⚠ 1 條伏筆逾期/);
    assert.ok(line.querySelector('.tov-warn'));
    assert.match(h.row(T('青崖舊案')).querySelector('.tov-link').title, /意圖：查清七年前那場火/);
  });

  test('還在讀、不是小說工程、一條線都沒有、列被截了：各說一句', () => {
    const g = harness();
    g.open();
    assert.match(g.note(), /正在讀取/);
    g.respond(overview({ initialized: false, chapters: [], groups: [], unfiled: undefined, current: 0 }));
    assert.match(g.note(), /還不是小說工程/);
    g.ui.clickEl(g.overviewBtn());
    g.respond(overview({ groups: [], unfiled: undefined }));
    assert.match(g.note(), /還沒有敘事線/);
    assert.equal(g.doc.querySelector('.tov-grid'), null);
    g.ui.clickEl(g.overviewBtn());
    g.respond(overview({ clippedFrom: 30000 }));
    assert.match(g.note(), /第 30000 章，太遠了，只畫到第 6 章/);
    assert.ok(g.doc.querySelector('.tov-grid'));
  });
});

describe('敘事線總覽 · 線的四種格子', { skip: JSDOM_SKIP }, () => {
  test('○ 只有計劃、● 只有實際、◉ 計劃也發生了、紅圈偏差；只畫有事件的章', () => {
    const h = harness();
    h.open();
    h.respond();
    const row = h.row(T('青崖舊案'));
    const kind = (no) => ['plan', 'actual', 'both', 'dev'].find((k) => h.cellOf(row, no).querySelector(`.tov-mark-${k}`));
    assert.equal(kind(1), 'actual');
    assert.equal(kind(2), 'dev');
    assert.equal(kind(3), 'both');
    assert.equal(kind(5), 'plan');
    assert.equal(h.cellOf(row, 4), null);
    assert.equal(h.cellOf(row, 6), null);
    // 圓點借流水線條的 pstage-mark：實際的實心（done），計劃的空心。
    assert.ok(h.cellOf(row, 1).querySelector('.pstage-mark.done'));
    assert.ok(h.cellOf(row, 3).querySelector('.pstage-mark.done'));
    assert.ok(!h.cellOf(row, 5).querySelector('.pstage-mark').classList.contains('done'));
    assert.ok(h.cellOf(row, 2).classList.contains('tov-cell-dev'));
    assert.equal(h.cellOf(row, 3).style.left, '48px');
  });

  test('計劃區間一條淡底', () => {
    const h = harness();
    h.open();
    h.respond();
    const band = h.row(T('青崖舊案')).querySelector('.tov-band');
    assert.deepEqual([band.style.left, band.style.width, band.title], ['0px', '144px', '計劃第 1–6 章']);
    assert.equal(h.row(T('林昭與沈氏')).querySelector('.tov-band'), null);
  });
});

describe('敘事線總覽 · 伏筆連線', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('收了的：埋 ● 到收 ◆ 一條實線', () => {
    const row = h.foreRow('玉佩的來歷');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-done'));
    assert.deepEqual([span.style.left, span.style.width], ['12px', '48px']);
    assert.ok(h.cellOf(row, 1).querySelector('.tov-fmark-plant.done'));
    const resolve = h.cellOf(row, 3).querySelector('.tov-fmark-resolve');
    assert.ok(resolve && !resolve.classList.contains('tov-fmark-plan'), '實際收了畫實心 ◆');
    assert.equal(row.querySelector('.tov-due'), null, '收了的不畫回收章');
    assert.ok(row.classList.contains('tov-row-closed'));
  });

  test('埋了沒收、逾期：虛線標紅，回收章那一格一道紅豎線，名字標紅掛 ⚠', () => {
    const row = h.foreRow('斷劍');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-open') && span.classList.contains('tov-overdue'));
    assert.deepEqual([span.style.left, span.style.width], ['12px', '48px']);
    const due = row.querySelector('.tov-due');
    assert.ok(due.classList.contains('tov-overdue'));
    assert.equal(due.style.left, `${24 + 12}px`);
    assert.match(due.title, /計劃第 2 章前收——敘事線判到第 3 章，逾期/);
    assert.ok(row.classList.contains('tov-row-overdue'));
    assert.ok(row.querySelector('.tov-warn'));
  });

  test('還沒埋：按計劃畫淡虛線到回收章；計劃埋的那一章定稿了卻沒埋，空心記號標紅', () => {
    const row = h.foreRow('沈氏的舊傷');
    const span = row.querySelector('.tov-span');
    assert.ok(span.classList.contains('tov-span-planned'));
    assert.ok(!span.classList.contains('tov-overdue'));
    assert.equal(row.querySelector('.tov-due').style.left, `${5 * 24 + 12}px`);
    const mark = h.cellOf(row, 2).querySelector('.tov-fmark-plant');
    assert.ok(mark.classList.contains('tov-fmark-plan') && mark.classList.contains('tov-mark-dev'));
    assert.ok(!mark.classList.contains('done'));
  });

  test('棄了的畫 ✕，沒有連線', () => {
    const row = h.foreRow('火摺子');
    assert.equal(h.cellOf(row, 2).querySelector('.tov-fmark-drop').textContent, '✕');
    assert.equal(row.querySelector('.tov-span'), null);
  });
});

describe('敘事線總覽 · 點選', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('點格子開啟那一章（openChapter：正文進主區、細綱並排）', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.row(T('青崖舊案')), 1).querySelector('.tov-mark'));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/001-楔子.md' }]);
    const m = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.foreRow('沈氏的舊傷'), 2));
    assert.deepEqual(h.sentAfter(m), [{ type: 'openChapter', plotRelPath: 'chapters/002-入鎮.md' }]);
  });

  test('還沒寫的開啟細綱；細綱正文都沒有的說一句、不發', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.cellOf(h.row(T('青崖舊案')), 5));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: '.novelwarden/summaries/第二卷/005-赤星.md' }]);
    const m = h.ui.sent.length;
    h.ui.clickEl(h.doc.querySelector('.tov-nums .tov-col[data-ch="6"]'));
    assert.deepEqual(h.sentAfter(m), []);
    assert.match(h.toasts.at(-1), /第 6 章還沒有細綱，也沒有正文/);
  });

  test('點列頭開啟那一章', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.doc.querySelector('.tov-nums .tov-col[data-ch="4"]'));
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/第二卷/004-北行.md' }]);
  });

  test('點線名開啟那條線的檔案；點伏筆名開啟它所在的檔案；點「未歸屬的伏筆」開啟那份檔案——開在總覽所在的這一塊', () => {
    const n = h.ui.sent.length;
    h.ui.clickEl(h.row(T('林昭與沈氏')).querySelector('.tov-link'));
    h.ui.clickEl(h.foreRow('玉佩的來歷').querySelector('.tov-link'));
    h.ui.clickEl(h.row(UNFILED).querySelector('.tov-link'));
    h.ui.clickEl(h.foreRow('斷劍').querySelector('.tov-link'));
    assert.deepEqual(h.sentAfter(n), [
      { type: 'openEditor', path: T('林昭與沈氏'), pane: 'main' },
      { type: 'openEditor', path: T('林昭與沈氏'), pane: 'main' },
      { type: 'openEditor', path: UNFILED, pane: 'main' },
      { type: 'openEditor', path: UNFILED, pane: 'main' },
    ]);
  });

  test('開啟的那一章到了：它成了當前標籤，總覽藏起來、標籤還在', () => {
    h.ui.clickEl(h.cellOf(h.row(T('青崖舊案')), 1));
    h.openFile('chapters/001-楔子.md');
    assert.equal(h.activeTab(), '001-楔子.md');
    assert.equal(h.shown(), false);
    assert.ok(h.specialTab());
  });
});

describe('敘事線總覽 · 懸停', { skip: JSDOM_SKIP }, () => {
  test('懸停一格：第幾章、哪一行、計劃與實際的事件與證據；偏差說一句；移開就收', () => {
    const h = harness();
    h.open();
    h.respond();
    const tip = () => h.doc.querySelector('.tov .tov-tip');
    const over = (node) => node.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
    const out = (node) => node.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: h.doc.body }));

    const dev = h.cellOf(h.row(T('青崖舊案')), 2);
    over(dev.querySelector('.tov-mark'));
    assert.equal(tip().classList.contains('hidden'), false);
    assert.equal(tip().querySelector('.tov-tip-head').textContent, '第 2 章《入鎮》 · 已同步');
    assert.equal(tip().querySelector('.tov-tip-row-name').textContent, '青崖舊案');
    assert.deepEqual([...tip().querySelectorAll('.tov-tip-ev')].map((n) => n.textContent), ['計劃 · 推進：打聽名冊']);
    assert.match(tip().querySelector('.tov-tip-dev').textContent, /計劃了，這一章也同步了，卻沒有發生/);
    out(dev);
    assert.equal(tip().classList.contains('hidden'), true);

    over(h.cellOf(h.row(T('青崖舊案')), 3));
    assert.deepEqual([...tip().querySelectorAll('.tov-tip-ev')].map((n) => n.textContent), [
      '計劃 · 推進：找到空匣',
      '推進：夜訪舊宅，找到空匣「匣子是空的」',
    ]);
    assert.equal(tip().querySelector('.tov-tip-evidence').textContent, '「匣子是空的」');
    assert.equal(tip().querySelector('.tov-tip-dev'), null);

    over(h.cellOf(h.foreRow('玉佩的來歷'), 1));
    assert.equal(tip().querySelector('.tov-tip-ev').textContent, '埋〈玉佩的來歷〉：玉佩露面「他摸了摸懷裡的玉佩」');
    // 使用者內容一律 textContent：證據裡的尖括號原樣是字。
    h.doc.querySelector('.tov').dispatchEvent(new h.window.Event('scroll'));
  });
});

describe('敘事線總覽 · 觸屏與右鍵', { skip: JSDOM_SKIP }, () => {
  let h;
  const tip = () => h.doc.querySelector('.tov .tov-tip');
  const shownTip = () => !tip().classList.contains('hidden');
  /** 手指按下（Chromium 在手指點一下之後才補發 click；`touch.ts` 認最近一次指標是不是手指）。 */
  const finger = (node) => node.dispatchEvent(new h.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  const mouse = (node) => node.dispatchEvent(new h.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('手指點一格：彈浮窗看這一格本身，不開啟那一章；點別處收起', () => {
    const cell = h.cellOf(h.row(T('青崖舊案')), 2);
    const n = h.ui.sent.length;
    finger(cell);
    h.ui.clickEl(cell.querySelector('.tov-mark') ?? cell);
    assert.deepEqual(h.sentAfter(n), []);
    assert.equal(shownTip(), true);
    assert.equal(tip().querySelector('.tov-tip-head').textContent, '第 2 章《入鎮》 · 已同步');
    // 相容滑鼠事件（手指點完補發的 mouseout）不收它
    cell.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: h.doc.body }));
    assert.equal(shownTip(), true);
    // 點表格裡別處：收起
    const scroll = h.doc.querySelector('.tov-scroll');
    finger(scroll);
    h.ui.clickEl(scroll);
    assert.equal(shownTip(), false);
  });

  test('手指點列頭：浮窗裡寫這一章的說明，「點選開啟」換成「長按開啟」；不發 openChapter', () => {
    const col = h.doc.querySelector('.tov-nums .tov-col[data-ch="4"]');
    const n = h.ui.sent.length;
    finger(col);
    h.ui.clickEl(col);
    assert.deepEqual(h.sentAfter(n), []);
    assert.equal(shownTip(), true);
    assert.match(tip().querySelector('.tov-tip-head').textContent, /^第 4 章/);
    assert.ok([...tip().querySelectorAll('.tov-tip-row-name')].some((r) => r.textContent === '長按開啟這一章'));
  });

  test('滑鼠點格子照舊開啟那一章（桌面不變）', () => {
    const cell = h.cellOf(h.row(T('青崖舊案')), 1);
    const n = h.ui.sent.length;
    mouse(cell);
    h.ui.clickEl(cell);
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/001-楔子.md' }]);
  });

  test('右鍵（長按）格子：「開啟第 N 章」與「重新整理」；還沒寫的寫「開啟第 N 章的細綱」；空白處只有重新整理', () => {
    finger(h.cellOf(h.row(T('青崖舊案')), 1));
    let menu = h.ui.rightClick(h.cellOf(h.row(T('青崖舊案')), 1));
    assert.deepEqual(h.ui.itemsOf(menu), ['開啟第 1 章', '重新整理']);
    const n = h.ui.sent.length;
    h.ui.pick(menu, '開啟第 1 章');
    assert.deepEqual(h.sentAfter(n), [{ type: 'openChapter', plotRelPath: 'chapters/001-楔子.md' }]);
    menu = h.ui.rightClick(h.cellOf(h.row(T('青崖舊案')), 5));
    assert.deepEqual(h.ui.itemsOf(menu), ['開啟第 5 章的細綱', '重新整理']);
    h.ui.closeMenu();
    menu = h.ui.rightClick(h.doc.querySelector('.tov-scroll'));
    assert.deepEqual(h.ui.itemsOf(menu), ['重新整理']);
    h.ui.closeMenu();
  });
});

describe('敘事線總覽 · 在總覽裡看', { skip: JSDOM_SKIP }, () => {
  test('工程頁行右鍵「在總覽裡看」：開啟總覽，資料到了標出那一行', () => {
    const h = harness();
    h.ui.pick(h.ui.rightClick(h.projectRow('林昭與沈氏')), '在總覽裡看');
    assert.ok(h.shown());
    h.respond();
    assert.ok(h.row(T('林昭與沈氏')).classList.contains('tov-focus'));
    assert.equal(h.row(T('青崖舊案')).classList.contains('tov-focus'), false);
    // 換一行定位：標記跟著走；已經有資料時當場標出來。
    h.ui.pick(h.ui.rightClick(h.projectRow('未歸屬的伏筆')), '在總覽裡看');
    assert.ok(h.row(UNFILED).classList.contains('tov-focus'));
    assert.equal(h.row(T('林昭與沈氏')).classList.contains('tov-focus'), false);
    // 新資料到了重畫，標記還在。
    h.respond();
    assert.ok(h.row(UNFILED).classList.contains('tov-focus'));
  });
});

describe('敘事線總覽 · 資料', { skip: JSDOM_SKIP }, () => {
  test('別的頁面的 requestId 不認', () => {
    const h = harness();
    h.open();
    h.ui.post({ type: 'threadsOverview', requestId: 'threads-別人的', overview: overview() });
    assert.equal(h.doc.querySelector('.tov-grid'), null);
    assert.match(h.note(), /正在讀取/);
    h.respond();
    assert.ok(h.doc.querySelector('.tov-grid'));
  });

  test('顯示著收到 state（磁碟上變過）：停一下再要一次；藏著時不要，切回來再要', () => {
    const h = harness({ shims: ['fakeTimers'] });
    h.open();
    h.respond();
    const n = h.count('requestThreadsOverview');
    h.ui.post({ type: 'state', state: viewState() });
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.count('requestThreadsOverview'), n, '還在等');
    h.window.__clock.tick(700);
    assert.equal(h.count('requestThreadsOverview'), n + 1, '連著兩條只要一次');
    h.respond();

    h.openFile('a.md');
    h.ui.post({ type: 'state', state: viewState() });
    h.window.__clock.tick(700);
    assert.equal(h.count('requestThreadsOverview'), n + 1, '藏著時不要');
    h.ui.clickEl(h.specialTab());
    assert.equal(h.count('requestThreadsOverview'), n + 2, '切回來再要');
    // 沒變過：切走再切回來不再要。
    h.respond();
    h.ui.clickEl([...h.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    h.ui.clickEl(h.specialTab());
    assert.equal(h.count('requestThreadsOverview'), n + 2);
  });
});

describe('敘事線總覽 · 重新整理恢復', { skip: JSDOM_SKIP }, () => {
  const SHIMS = ['scrollIntoView', 'clipboard'];

  test('記著：重新整理之後先開總覽，陸續回來的檔案不把它換下去；關掉它回到存下來的那一份', () => {
    const first = harness({ storage: {} });
    first.openFile('a.md');
    first.openFile('b.md');
    first.ui.clickEl([...first.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.dataset.path === 'a.md'));
    first.open();
    first.respond();
    const saved = first.window.localStorage.getItem(STORE_KEY);
    const data = JSON.parse(saved);
    assert.deepEqual(data.panes.main.specials, ['threads-overview']);
    assert.equal(data.panes.main.special, 'threads-overview');
    assert.equal(data.panes.main.active, 'a.md', '記的是切過去之前的那一份');

    const second = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: saved } });
    const tab = () => second.doc.querySelector('#edTabs .ed-tab-special');
    const shown = () => !second.doc.querySelector('.tov').classList.contains('hidden');
    assert.ok(tab()?.classList.contains('active'), '總覽先開、正顯示著');
    assert.ok(second.last('requestThreadsOverview'), '要了資料');
    assert.deepEqual(second.sent.filter((m) => m.type === 'openEditor').map((m) => m.path), ['a.md', 'b.md']);
    second.post({ type: 'editorOpen', file: file('a.md', 'a') });
    second.post({ type: 'editorOpen', file: file('b.md', 'b') });
    assert.ok(tab().classList.contains('active'), '回來的檔案沒把它換下去');
    assert.ok(shown());
    second.clickEl(tab().querySelector('.ed-tab-close'));
    assert.equal(second.doc.querySelector('#edTabs .ed-tab.active').dataset.path, 'a.md');
  });

  test('沒在顯示的總覽：恢復成標籤條上的一個標籤，當前的還是那份檔案', () => {
    const first = harness({ storage: {} });
    first.open();
    first.respond();
    first.openFile('a.md');
    const saved = first.window.localStorage.getItem(STORE_KEY);
    assert.equal(JSON.parse(saved).panes.main.special, undefined);

    const second = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: saved } });
    second.post({ type: 'editorOpen', file: file('a.md', 'a') });
    const tabs = [...second.doc.querySelectorAll('#edTabs .ed-tab')];
    assert.deepEqual(tabs.map((t) => t.dataset.special ?? t.dataset.path), ['threads-overview', 'a.md']);
    assert.ok(tabs[1].classList.contains('active'));
    assert.equal(second.doc.querySelector('.tov'), null, '沒顯示就不畫');
    assert.equal(second.last('requestThreadsOverview'), undefined, '沒顯示就不要資料');
  });

  test('只開著總覽、沒有檔案也恢復；記壞了的（認不出的標籤、形狀不對）不認、不崩，檔案照樣回來', () => {
    const onlyOverview = JSON.stringify({ v: 2, panes: { main: { open: [], active: null, specials: ['threads-overview'], special: 'threads-overview' } }, activePane: 'main' });
    const a = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: onlyOverview } });
    assert.ok(a.doc.querySelector('#edTabs .ed-tab-special.active'));

    const broken = JSON.stringify({
      v: 2,
      panes: {
        main: { open: [{ path: 'a.md', hash: 'h-a.md' }], active: 'a.md', specials: ['不認得的', 3, null], special: '不認得的' },
        draft: { open: [], specials: 'threads-overview' },
      },
      activePane: 'main',
    });
    const b = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS, storage: { [STORE_KEY]: broken } });
    assert.equal(b.doc.querySelector('.ed-tab-special'), null);
    assert.deepEqual(b.sent.filter((m) => m.type === 'openEditor').map((m) => m.path), ['a.md']);
    b.post({ type: 'editorOpen', file: file('a.md', 'a') });
    assert.equal(b.doc.querySelector('#edTabs .ed-tab.active').dataset.path, 'a.md');
  });
});

describe('敘事線總覽 · 換工程', { skip: JSDOM_SKIP }, () => {
  test('換工程：標籤關掉，覆蓋層藏起來', () => {
    const h = harness();
    h.open();
    h.respond();
    h.window.dispatchEvent(new h.window.Event('nf-workspace-reset'));
    assert.equal(h.specialTab(), null);
    assert.equal(h.shown(), false);
  });
});

// 故事時間（2026-10-24）：同日「時間線總覽」——「時間線」一組與月份帶挪去時間線總覽（tests/dom/standalone/timelineOverview.test.js），
// 敘事線總覽只在懸停裡帶一句「這一章是哪天」。
describe('敘事線總覽 · 故事時間', { skip: JSDOM_SKIP }, () => {
  /** 第 1 章三月初七傍晚，第 2 章回憶；其餘沒有時間。 */
  function withTime() {
    const o = overview();
    const times = ['大衍三年三月初七 傍晚', '回憶（約二十年前）'];
    o.chapters = o.chapters.map((c, i) => (times[i] ? { ...c, time: times[i] } : c));
    return o;
  }
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond(withTime());
  });

  test('沒有「時間線」一組、「故事時間」那一行與月份帶', () => {
    assert.equal(h.doc.querySelector('.tov-row-time'), null);
    assert.equal(h.doc.querySelector('.tov-months'), null);
    assert.ok(![...h.doc.querySelectorAll('.tov-row-group')].some((r) => r.textContent.startsWith('時間線')));
  });

  test('列頭與線格子的懸停帶上那一章的日期', () => {
    const col = h.doc.querySelector('.tov-nums .tov-col');
    assert.match(col.title, /^第 1 章《楔子》 · 大衍三年三月初七 傍晚 · 已同步/);
    const node = h.cellOf(h.row(T('青崖舊案')), 1);
    node.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
    assert.match(h.doc.querySelector('.tov-tip .tov-tip-head').textContent, /大衍三年三月初七 傍晚/);
  });
});
