/**
 * 工程頁的設定名錄（設定名錄第一期）：設定行的出現章與「＋N」、「出現過 · 未建條目」那一組、
 * 「設定」組標題旁的篩選框。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 設定行 | 右邊寫出現章（`loreByEntry[relPath].detail`，後端算的）、副標題仍是一句話；待整合的掛「＋N」（樣子同角色卡）、tooltip 分水位有沒有兩種說法；沒出現過的兩樣都不掛；失敗標記、右鍵選單照舊；舊後端沒有 `loreByEntry` 不崩 |
 * | 三件維護（第三期） | 設定組選單按待辦寫「補記設定（N 章）」「整合設定（K 條）」，外加「按目錄整理…」，沒待辦只剩整理；有新內容的設定行右鍵「整合這一條」帶路徑；未建條目組選單「給全部 M 個建條目」 |
 * | 出現過 · 未建條目 | 只在有時出現、緊跟在「設定」組後面、副標題寫個數；一行是 名字〔分類〕· 出現章；右鍵「建條目」發 `buildLore` 帶名字，「新建這條設定」發 `newLore` 帶 `name` 與分類目錄（沒分類落在設定根目錄）；點名字不新建；一次先畫 30 個，「顯示全部 N 個」攤開，重推樹不縮回 |
 * | 篩選框 | 在標題欄上、摺疊開關之外（點它不折疊）；按標題 / 一句話 / 關鍵詞篩（不分大小寫），匹配項的祖先資料夾自動展開、沒匹配的資料夾不畫；也按名字 / 分類篩未建條目；一個都不匹配時說「沒有匹配的設定」；重推樹篩選還在；打字與推樹都不丟焦點和游標；**組字期間不重畫**；Esc 與 × 清空；不發任何訊息給後端；組折著時開始篩就展開 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LORE = '.novelwarden/lore';

/** 33 個只出現過一次的雜項，湊出一條超過 30 個的長尾。 */
const filler = Array.from({ length: 33 }, (_, i) => ({
  name: `雜項${i + 1}`,
  category: '雜物',
  chapters: [10],
  detail: '1 章 · 第 10 章起',
}));

/**
 * 一棵有設定的工程頁快照。設定區按目錄（= 分類）分組：
 *
 * | 條目 | 位置 | 一句話 | 出現章 | 水位 / 待整合 | 關鍵詞 |
 * |---|---|---|---|---|---|
 * | 青崖鎮 | 地域/ | 偏僻小鎮，鎮口設卡查過所 | 第 3–57 章 · 12 章 | 40 / ＋3 | 停舟渡、Qingya |
 * | 停舟客棧 | 地域/青崖/ | 鎮上唯一的客棧，二層木樓 | 第 5 章 · 1 章 | 0 / ＋1 | — |
 * | 崖字令牌 | 根目錄 | 刻著崖字的銅令牌 | 沒出現過 | 0 / 0 | 信物 |
 *
 * 外加一個空資料夾「信物」（篩選時沒有匹配，不該畫出來），以及 35 個未建條目
 * （黑水渡〔地域/青崖〕、斷魂香〔無分類〕、33 個雜項〔雜物〕），按出現章數降序。
 */
const loreTree = (extra) => ({
  ...sampleTree(),
  lore: [
    {
      kind: 'dir', label: '地域', relPath: `${LORE}/地域`, fileCount: 2, children: [
        {
          kind: 'dir', label: '青崖', relPath: `${LORE}/地域/青崖`, fileCount: 1, children: [
            { kind: 'file', label: '停舟客棧', relPath: `${LORE}/地域/青崖/停舟客棧.md`, detail: '鎮上唯一的客棧，二層木樓' },
          ],
        },
        { kind: 'file', label: '青崖鎮', relPath: `${LORE}/地域/青崖镇.md`, detail: '偏僻小鎮，鎮口設卡查過所' },
      ],
    },
    { kind: 'dir', label: '信物', relPath: `${LORE}/信物`, fileCount: 0, children: [] },
    { kind: 'file', label: '崖字令牌', relPath: `${LORE}/崖字令牌.md`, detail: '刻著崖字的銅令牌' },
  ],
  loreByEntry: {
    [`${LORE}/地域/青崖镇.md`]: {
      chapters: [3, 5, 57], detail: '第 3–57 章 · 12 章', updatedThrough: 40, pending: 3, keywords: ['停舟渡', 'Qingya'],
    },
    [`${LORE}/地域/青崖/停舟客棧.md`]: {
      chapters: [5], detail: '第 5 章 · 1 章', updatedThrough: 0, pending: 1, keywords: [],
    },
    [`${LORE}/崖字令牌.md`]: { chapters: [], detail: '', updatedThrough: 0, pending: 0, keywords: ['信物'] },
  },
  loreUnfiled: [
    { name: '黑水渡', category: '地域/青崖', chapters: [3, 4, 5, 6, 7], detail: '5 章 · 第 3 章起' },
    { name: '斷魂香', category: '', chapters: [8, 9], detail: '2 章 · 第 8 章起' },
    ...filler,
  ],
  loreUnrecorded: 0,
  ...extra,
});

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const groupNames = (ui) => [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent);
const loreRow = (ui, label) =>
  [...groupOf(ui, '設定').querySelectorAll('.row-lore')].find((r) => r.querySelector('.row-label')?.textContent === label);
/** 設定組裡畫出來的條目名（不含資料夾）。 */
const loreLabels = (ui) =>
  [...groupOf(ui, '設定').querySelectorAll('.row-lore .row-label')].map((n) => n.textContent);
/** 設定組裡畫出來的資料夾（帶開合圖示）。 */
const folderLabels = (ui) =>
  [...groupOf(ui, '設定').querySelectorAll('.row-dir-label')].map((n) => n.textContent);
const dirLabel = (ui, name) =>
  [...groupOf(ui, '設定').querySelectorAll('.row-dir-label')].find((n) => n.textContent.endsWith(` ${name}`));
const unfiledGroup = (ui) => groupOf(ui, '出現過 · 未建條目');
const unfiledRows = (ui) => [...(unfiledGroup(ui)?.querySelectorAll('.row-lore-unfiled') ?? [])];
const unfiledRow = (ui, name) => unfiledRows(ui).find((r) => r.querySelector('.row-label')?.textContent === name);
const unfiledNames = (ui) => unfiledRows(ui).map((r) => r.querySelector('.row-label').textContent);
const filterInput = (ui) => groupOf(ui, '設定')?.querySelector('.lore-filter-input') ?? null;

/** 往篩選框裡打一串字：先聚焦（真實使用者就是這樣），游標落在末尾，發一條 input。 */
function typeFilter(ui, text) {
  const input = filterInput(ui);
  input.focus();
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}

describe('設定行：出現章與「＋N」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
    // 資料夾預設摺疊：把兩層都開啟，三條都畫出來。
    ui.clickEl(dirLabel(ui, '地域'));
    ui.clickEl(dirLabel(ui, '青崖'));
  });

  test('三條都畫成設定行', () => {
    assert.deepEqual(loreLabels(ui).sort(), ['停舟客棧', '崖字令牌', '青崖鎮'].sort());
  });

  // 出現章由後端從定稿過的細綱「設定」一節算好，前端照抄。
  test('右邊寫出現章', () => {
    const span = loreRow(ui, '青崖鎮').querySelector('.lore-span');
    assert.equal(span?.textContent, '第 3–57 章 · 12 章', loreRow(ui, '青崖鎮').outerHTML);
  });

  test('副標題仍是那一句話', () => {
    assert.equal(loreRow(ui, '青崖鎮').querySelector('.row-detail')?.textContent, '偏僻小鎮，鎮口設卡查過所');
  });

  // 出現章另起一格放在一句話後面，不併進副標題（並進去會被省略號吃掉）。
  test('出現章另起一格，排在一句話後面', () => {
    const kids = [...loreRow(ui, '青崖鎮').children];
    const detail = kids.findIndex((n) => n.classList.contains('row-detail'));
    const span = kids.findIndex((n) => n.classList.contains('lore-span'));
    assert.ok(detail >= 0 && span > detail, kids.map((n) => n.className).join('|'));
    assert.ok(!loreRow(ui, '青崖鎮').querySelector('.row-detail').textContent.includes('章'));
  });

  test('待整合的掛「＋N」，用角色卡那個樣子', () => {
    const flag = loreRow(ui, '青崖鎮').querySelector('.cast-pending');
    assert.equal(flag?.textContent, '＋3', loreRow(ui, '青崖鎮').outerHTML);
  });

  test('「＋N」的 tooltip 寫水位之後幾章', () => {
    assert.equal(
      loreRow(ui, '青崖鎮').querySelector('.cast-pending').title,
      '第 40 章之後又有 3 章的新內容沒整合進這一條'
    );
  });

  // 水位是 0（從沒整合過）時說「第 0 章之後」是句怪話。
  test('沒整合過的換一種說法', () => {
    assert.equal(loreRow(ui, '停舟客棧').querySelector('.cast-pending').title, '有 1 章的新內容還沒整合進這一條');
  });

  test('定稿裡沒出現過的：不掛出現章，也不掛「＋N」', () => {
    const row = loreRow(ui, '崖字令牌');
    assert.equal(row.querySelector('.lore-span'), null, row.outerHTML);
    assert.equal(row.querySelector('.cast-pending'), null, row.outerHTML);
  });

  test('右鍵選單照舊：開啟與三個類檔案操作', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖鎮')));
    for (const label of ['開啟', '重新命名', '移動到…', '刪除（移到回收站）']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
    ui.pick(ui.doc.querySelector('.ctx-menu'), '開啟');
    assert.equal(ui.last('openFile')?.path, `${LORE}/地域/青崖镇.md`, JSON.stringify(ui.sent));
  });

  test('點名字開啟那一條', () => {
    ui.sent.length = 0;
    ui.clickEl(loreRow(ui, '崖字令牌').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, `${LORE}/崖字令牌.md`, JSON.stringify(ui.sent));
  });

  test('失敗標記照掛，排在名字前面', () => {
    const tree = loreTree({
      failures: { [`${LORE}/崖字令牌.md`]: [{ at: '', severity: 'warn', message: '整合了一半' }] },
    });
    ui.post({ type: 'project', tree });
    const row = loreRow(ui, '崖字令牌');
    const kids = [...row.children];
    const mark = kids.findIndex((n) => n.classList.contains('row-failure'));
    const label = kids.findIndex((n) => n.classList.contains('row-label'));
    assert.ok(mark >= 0 && mark < label, row.outerHTML);
    assert.ok(row.querySelector('.row-failure').classList.contains('is-warn'));
  });
});

describe('名錄的三件維護：補記、整合、按目錄整理、建條目（第三期）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const loreHead = () => groupOf(ui, '設定').querySelector('.group-head');
  const unfiledHead = () => unfiledGroup(ui).querySelector('.group-head');

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree({ loreUnrecorded: 4 }) });
    ui.clickEl(dirLabel(ui, '地域'));
  });

  test('設定組選單：有幾件待辦就寫幾件，外加按目錄整理', () => {
    const items = ui.itemsOf(ui.rightClick(loreHead()));
    ui.closeMenu();
    for (const label of ['補記設定（4 章同步過、還沒記）', '整合設定（2 條有新內容）', '按目錄整理…']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
  });

  test('三項各發各的動作，都不帶物件（次數在後端的確認框裡報）', () => {
    for (const [label, action] of [
      ['補記設定（4 章同步過、還沒記）', 'recordLore'],
      ['整合設定（2 條有新內容）', 'integrateLore'],
      ['按目錄整理…', 'organizeLore'],
    ]) {
      ui.sent.length = 0;
      ui.pick(ui.rightClick(loreHead()), label);
      const msg = ui.last('projectAction');
      assert.equal(msg?.action, action, JSON.stringify(ui.sent));
      assert.equal(msg.relPath, undefined, JSON.stringify(msg));
    }
  });

  test('沒有待辦時只剩按目錄整理', () => {
    const quiet = loreTree({ loreUnrecorded: 0 });
    for (const s of Object.values(quiet.loreByEntry)) {
      s.pending = 0;
    }
    ui.post({ type: 'project', tree: quiet });
    const items = ui.itemsOf(ui.rightClick(loreHead()));
    ui.closeMenu();
    assert.ok(items.includes('按目錄整理…'), JSON.stringify(items));
    assert.ok(!items.some((i) => i.startsWith('補記設定') || i.startsWith('整合設定')), JSON.stringify(items));
    ui.post({ type: 'project', tree: loreTree({ loreUnrecorded: 4 }) });
  });

  test('有新內容的設定行：右鍵「整合這一條」發 integrateLore，帶這一條的路徑', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖鎮')));
    assert.ok(items.includes('整合這一條（新增 3 章，預計 2 次呼叫，最多 6 次）'), JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), '整合這一條（新增 3 章，預計 2 次呼叫，最多 6 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'integrateLore', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, `${LORE}/地域/青崖镇.md`);
  });

  test('沒有新內容的設定行：沒有「整合這一條」', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '崖字令牌')));
    ui.closeMenu();
    assert.ok(!items.some((i) => i.startsWith('整合這一條')), JSON.stringify(items));
  });

  test('未建條目組選單：給全部建條目，發 buildLore 不帶名字', () => {
    const items = ui.itemsOf(ui.rightClick(unfiledHead()));
    assert.ok(items.includes('給全部 35 個建條目'), JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), '給全部 35 個建條目');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'buildLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, undefined, JSON.stringify(msg));
  });
});

describe('「出現過 · 未建條目」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
  });

  test('緊跟在「設定」組後面', () => {
    const names = groupNames(ui);
    assert.equal(names.indexOf('出現過 · 未建條目'), names.indexOf('設定') + 1, names.join('|'));
  });

  test('副標題寫個數', () => {
    assert.equal(unfiledGroup(ui).querySelector('.group-head .meta').textContent, '35 個');
  });

  test('一行：名字〔分類〕· 出現章', () => {
    const row = unfiledRow(ui, '黑水渡');
    assert.equal(row.querySelector('.lore-category')?.textContent, '〔地域/青崖〕', row.outerHTML);
    assert.equal(row.querySelector('.row-detail')?.textContent, '5 章 · 第 3 章起');
    const kids = [...row.children].map((n) => n.className);
    assert.ok(
      kids.findIndex((c) => c.includes('row-label')) < kids.findIndex((c) => c.includes('lore-category')) &&
        kids.findIndex((c) => c.includes('lore-category')) < kids.findIndex((c) => c.includes('row-detail')),
      kids.join('|')
    );
  });

  test('沒有分類的不畫空的〔〕', () => {
    assert.equal(unfiledRow(ui, '斷魂香').querySelector('.lore-category'), null);
  });

  test('按後端給的順序排（出現章數降序）', () => {
    assert.deepEqual(unfiledNames(ui).slice(0, 3), ['黑水渡', '斷魂香', '雜項1']);
  });

  // 這些名字還沒有檔案：沒有類檔案操作，只有建條目（調模型）與新建空條目（不調）。
  test('右鍵給「建條目」「新建這條設定」與重新整理', () => {
    const items = ui.itemsOf(ui.rightClick(unfiledRow(ui, '黑水渡')));
    assert.deepEqual(items, ['建條目（預計 2 次呼叫，最多 6 次）', '新建這條設定（空的，不調模型）', '重新整理'], JSON.stringify(items));
    ui.closeMenu();
  });

  test('「建條目」發 buildLore，帶名字', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(unfiledRow(ui, '黑水渡')), '建條目（預計 2 次呼叫，最多 6 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'buildLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, '黑水渡', JSON.stringify(msg));
  });

  test('「新建這條設定」發 newLore，帶名字，落在建議的分類目錄裡', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(unfiledRow(ui, '黑水渡')), '新建這條設定（空的，不調模型）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'newLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, '黑水渡', JSON.stringify(msg));
    assert.equal(msg.dir, `${LORE}/地域/青崖`, JSON.stringify(msg));
  });

  test('沒有分類的落在設定根目錄', () => {
    ui.pick(ui.rightClick(unfiledRow(ui, '斷魂香')), '新建這條設定（空的，不調模型）');
    const msg = ui.last('projectAction');
    assert.equal(msg.name, '斷魂香', JSON.stringify(msg));
    assert.equal(msg.dir, LORE, JSON.stringify(msg));
  });

  // 新建出來的是一份空條目：掃列表時手一滑就多一個檔案，不放在點名字上。
  test('點名字不新建', () => {
    ui.sent.length = 0;
    ui.clickEl(unfiledRow(ui, '黑水渡').querySelector('.row-label'));
    assert.ok(!ui.last('projectAction'), JSON.stringify(ui.sent));
  });

  test('一次先畫 30 個，後面收在「顯示全部 35 個」', () => {
    assert.equal(unfiledRows(ui).length, 30);
    const more = unfiledGroup(ui).querySelector('.row-more');
    assert.equal(more?.textContent, '顯示全部 35 個', unfiledGroup(ui).outerHTML.slice(-400));
  });

  test('「顯示全部」那一行不是名錄裡的一項（沒有右鍵選單）', () => {
    const more = unfiledGroup(ui).querySelector('.row-more');
    assert.ok(!more.classList.contains('row'), more.className);
  });

  test('點「顯示全部」攤開全部，不發訊息', () => {
    ui.sent.length = 0;
    ui.clickEl(unfiledGroup(ui).querySelector('.row-more button'));
    assert.equal(unfiledRows(ui).length, 35);
    assert.equal(unfiledGroup(ui).querySelector('.row-more'), null);
    assert.deepEqual(ui.sent, []);
  });

  // 檔案一變後端就整棵重推：點開之後每次都縮回 30 個，等於那顆按鈕白點。
  test('重推樹之後仍是全部', () => {
    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(unfiledRows(ui).length, 35);
  });

  test('沒有未建條目時整組不出現', () => {
    ui.post({ type: 'project', tree: loreTree({ loreUnfiled: [] }) });
    assert.ok(!groupNames(ui).includes('出現過 · 未建條目'), groupNames(ui).join('|'));
  });
});

describe('「設定」組的篩選框', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
  });

  test('在「設定」組的標題欄上，摺疊開關之外', () => {
    const input = filterInput(ui);
    assert.ok(input, groupOf(ui, '設定').querySelector('.group-head').outerHTML);
    assert.ok(input.closest('.group-head'));
    assert.equal(input.closest('.group-toggle'), null);
  });

  test('別的組沒有篩選框', () => {
    assert.equal(ui.doc.querySelectorAll('#projectBody .lore-filter-input').length, 1);
  });

  test('沒篩的時候 × 藏著', () => {
    assert.ok(groupOf(ui, '設定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('點篩選框不把組折起來', () => {
    ui.clickEl(filterInput(ui));
    assert.ok(groupOf(ui, '設定').querySelector('.group-body').children.length > 0);
    assert.equal(groupOf(ui, '設定').querySelector('.group-head .caret').textContent, '▾');
  });

  test('沒篩的時候資料夾照舊折著', () => {
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
  });

  test('按標題篩', () => {
    typeFilter(ui, '令牌');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), []);
  });

  // 匹配的那一條在兩層摺疊著的目錄裡：不自動展開就等於沒篩出來。
  test('按一句話篩，匹配項的祖先資料夾自動展開', () => {
    typeFilter(ui, '二層木樓');
    assert.deepEqual(loreLabels(ui), ['停舟客棧']);
    assert.deepEqual(folderLabels(ui), ['📂 地域', '📂 青崖']);
  });

  test('沒有匹配的資料夾不畫（空資料夾「信物」也不畫）', () => {
    assert.ok(!folderLabels(ui).some((l) => l.includes('信物')), folderLabels(ui).join('|'));
    assert.equal(groupOf(ui, '設定').querySelector('.row-empty'), null);
  });

  // 篩選不清它就一直開著：點了、右鍵「摺疊」都沒有看得見的效果，乾脆不掛，免得悄悄改掉
  // 清篩選之後的開合（下面「Esc 清空」那條驗資料夾仍是原來折著的樣子）。
  test('篩選中強制展開的資料夾點了不折疊，右鍵也沒有「摺疊 / 展開」', () => {
    ui.clickEl(dirLabel(ui, '地域'));
    assert.deepEqual(loreLabels(ui), ['停舟客棧']);
    const items = ui.itemsOf(ui.rightClick(dirLabel(ui, '地域').closest('.row')));
    assert.ok(!items.includes('摺疊') && !items.includes('展開'), JSON.stringify(items));
    assert.ok(items.includes('在此新建設定'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('按關鍵詞篩，不分大小寫', () => {
    typeFilter(ui, 'QINGYA');
    assert.deepEqual(loreLabels(ui), ['青崖鎮']);
    assert.deepEqual(folderLabels(ui), ['📂 地域']);
  });

  // 關鍵詞「信物」恰好與空資料夾同名：匹配的是崖字令牌這一條，空資料夾照樣不畫。
  test('關鍵詞命中根目錄下的條目', () => {
    typeFilter(ui, '信物');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), []);
  });

  test('有字時 × 出現', () => {
    assert.ok(!groupOf(ui, '設定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('也按名字篩未建條目；設定組沒有匹配時說「沒有匹配的設定」', () => {
    typeFilter(ui, '黑水');
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
    assert.equal(groupOf(ui, '設定').querySelector('.row-no-match')?.textContent, '沒有匹配的設定');
    assert.deepEqual(loreLabels(ui), []);
  });

  test('按分類篩未建條目', () => {
    typeFilter(ui, '地域/青');
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
  });

  test('篩出來的未建條目超過 30 個照樣收起來，「顯示全部」報的是篩出來的個數', () => {
    typeFilter(ui, '雜物');
    assert.equal(unfiledRows(ui).length, 30);
    assert.equal(unfiledGroup(ui).querySelector('.row-more')?.textContent, '顯示全部 33 個');
  });

  test('一個都不匹配：設定組說「沒有匹配的設定」，未建條目整組不畫', () => {
    typeFilter(ui, '查無此物');
    const none = groupOf(ui, '設定').querySelector('.row-no-match');
    assert.equal(none?.textContent, '沒有匹配的設定');
    assert.ok(none.classList.contains('hint'), none.className);
    assert.equal(unfiledGroup(ui), undefined);
  });

  test('重推樹之後篩選還在，框裡的字也還在', () => {
    typeFilter(ui, '二層木樓');
    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(filterInput(ui).value, '二層木樓');
    assert.deepEqual(loreLabels(ui), ['停舟客棧']);
  });

  test('打一個字重畫一次，焦點與游標留在新的框裡', () => {
    const input = filterInput(ui);
    input.focus();
    input.value = '二層木';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    const now = filterInput(ui);
    assert.notEqual(now, input, '沒有重畫（換了輸入框才測得到焦點放回去）');
    assert.equal(ui.doc.activeElement, now);
    assert.equal(now.value, '二層木');
    assert.equal(now.selectionStart, 1);
    assert.equal(now.selectionEnd, 1);
  });

  // 檔案監視推來的樹：正在打字的人不該被踢出篩選框。
  test('打字時推來一棵樹，焦點與游標不丟', () => {
    const input = filterInput(ui);
    input.setSelectionRange(2, 2);
    ui.post({ type: 'project', tree: loreTree() });
    const now = filterInput(ui);
    assert.equal(ui.doc.activeElement, now);
    assert.equal(now.selectionStart, 2);
  });

  test('焦點不在框裡時，推樹不把焦點拽進去', () => {
    filterInput(ui).blur();
    ui.post({ type: 'project', tree: loreTree() });
    assert.notEqual(ui.doc.activeElement, filterInput(ui));
  });

  // 組字中途換掉輸入框，打了一半的拼音就沒了：中途的 input 不篩，推來的樹也先不畫。
  test('輸入法組字期間不重畫，組字結束再篩', () => {
    typeFilter(ui, '');
    const input = filterInput(ui);
    input.focus();
    input.dispatchEvent(new ui.window.Event('compositionstart', { bubbles: true }));
    input.value = '黑';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.equal(filterInput(ui), input, '組字中途重畫了');
    assert.ok(unfiledNames(ui).length > 1, '組字中途就篩了');

    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(filterInput(ui), input, '組字中途推來的樹把輸入框換掉了');

    input.value = '黑水';
    input.dispatchEvent(new ui.window.Event('compositionend', { bubbles: true }));
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
    assert.equal(ui.doc.activeElement, filterInput(ui));
  });

  test('Esc 清空篩選，全部回來', () => {
    filterInput(ui).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(filterInput(ui).value, '');
    assert.equal(unfiledRows(ui).length, 30);
    // 資料夾回到原來的開合（預設折著）。
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), ['📁 地域', '📁 信物']);
  });

  test('× 清空篩選，焦點回到框裡', () => {
    typeFilter(ui, '令牌');
    ui.clickEl(groupOf(ui, '設定').querySelector('.lore-filter-clear'));
    assert.equal(filterInput(ui).value, '');
    assert.equal(groupOf(ui, '設定').querySelector('.row-no-match'), null);
    assert.equal(ui.doc.activeElement, filterInput(ui));
    assert.ok(groupOf(ui, '設定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('篩選是純前端的：一條訊息都不發', () => {
    ui.sent.length = 0;
    typeFilter(ui, '青崖');
    filterInput(ui).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.deepEqual(ui.sent, []);
  });

  test('組折著時開始篩就展開', () => {
    ui.clickEl(groupOf(ui, '設定').querySelector('.group-toggle'));
    assert.equal(groupOf(ui, '設定').querySelector('.group-body').children.length, 0, '先折起來');
    typeFilter(ui, '令牌');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
  });

  test('沒有條目也沒有未建條目時不擺篩選框', () => {
    typeFilter(ui, '');
    ui.post({ type: 'project', tree: loreTree({ lore: [], loreByEntry: {}, loreUnfiled: [] }) });
    assert.equal(filterInput(ui), null);
  });
});
