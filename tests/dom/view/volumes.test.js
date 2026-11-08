/**
 * 工程頁「章節」頁籤的分卷（2026-10-23 作者要求：按卷分類、右鍵新建卷、新建的預設放進最新一卷）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 分卷畫法 | 一卷一個標題行（`📂 第一卷`），後面跟這一卷的章、縮一層；副標題寫章號區間與字數，空卷寫「空」；新章的落點那一卷多一句「新章落這裡」，空著的話卷裡那一行也這麼說；「去寫這一章」照舊掛在下一章上 |
 * | 摺疊 | 點卷名折起 / 展開，只折這一卷；重推樹還折著 |
 * | 卷的右鍵 | 「在此卷新建章節檔案」帶這一卷的目錄、「新建卷…」落在章節根、重新命名 / 刪除帶卷目錄，沒有「移動到…」 |
 * | 未分卷 | 直接放在章節根下的章叫「未分卷」，右鍵新建落在章節根、不給重新命名與刪除 |
 * | 沒分卷 | `volumes` 空：照舊平鋪，沒有卷標題 |
 * | 空書 | 一章都沒有、只建了一卷：畫出那一卷與空卷提示，下面照舊寫下一步 |
 *
 * 卷的先後、哪一卷是落點都是後端排好的（`views/projectView.ts` 的 `buildVolumes`，見 integration/files/volumes.test.js）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

/**
 * sampleTree 的五章分進兩卷，另有一卷剛建、還空著（新章落進它）：
 *
 * | 卷 | 章 | 字數 |
 * |---|---|---|
 * | 第一卷 | 1–3 | 3580 |
 * | 第二卷 | 4–5 | 0 |
 * | 第三卷 | — | — |
 */
const volumeTree = (extra) => {
  const base = sampleTree();
  return {
    ...base,
    plots: base.plots.map((p) => ({ ...p, volume: p.no <= 3 ? '第一卷' : '第二卷' })),
    volumes: [
      { name: '第一卷', relPath: 'chapters/第一卷', from: 1, to: 3, words: 3580, latest: false },
      { name: '第二卷', relPath: 'chapters/第二卷', from: 4, to: 5, words: 0, latest: false },
      { name: '第三卷', relPath: 'chapters/第三卷', words: 0, latest: true },
    ],
    ...extra,
  };
};

const chaptersGroup = (ui) => ui.doc.querySelector('#projectBody [data-group="plots"]');
const volumeRow = (ui, relPath) => chaptersGroup(ui).querySelector(`.row-volume[data-volume="${relPath}"]`);
/** 章節組裡從上到下畫了什麼：卷標題寫卷名，章寫章號，空提示寫原文。 */
const layout = (ui) =>
  [...chaptersGroup(ui).querySelector('.group-body').children].map((r) =>
    r.classList.contains('row-volume')
      ? `卷:${r.querySelector('.row-label').textContent.replace(/^\S+ /, '')}`
      : r.classList.contains('row-plot') && r.dataset.plot
        ? `章:${r.querySelector('.row-label').textContent}`
        : r.textContent
  );

describe('分卷畫法', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
  });

  test('一卷一個標題行，後面跟這一卷的章，空卷說新章落在這裡', () => {
    assert.deepEqual(layout(ui), [
      '卷:第一卷', '章:第 1 章《楔子》', '章:第 2 章《入鎮》', '章:第 3 章《夜訪》',
      '卷:第二卷', '章:第 4 章《北行》', '章:第 5 章《赤星》',
      '卷:第三卷', '（空卷：接下來新建的章落在這裡）',
    ]);
  });

  test('卷標題預設展開，帶開啟的資料夾圖示', () => {
    const row = volumeRow(ui, 'chapters/第一卷');
    assert.equal(row.querySelector('.caret').textContent, '▾');
    assert.equal(row.querySelector('.row-label').textContent, '📂 第一卷');
  });

  test('副標題寫章號區間與字數，沒寫正文不報字數，空卷寫「空」', () => {
    const meta = (rel) => volumeRow(ui, rel).querySelector('.meta').textContent;
    assert.equal(meta('chapters/第一卷'), '第 1–3 章 · 3580 字');
    assert.equal(meta('chapters/第二卷'), '第 4–5 章');
    assert.equal(meta('chapters/第三卷'), '空 · 新章落這裡');
  });

  test('只有落點那一卷標著', () => {
    const latest = [...chaptersGroup(ui).querySelectorAll('.row-volume.is-latest')].map((r) => r.dataset.volume);
    assert.deepEqual(latest, ['chapters/第三卷']);
  });

  test('卷裡的章縮排一層', () => {
    const row = chaptersGroup(ui).querySelector('.row-plot[data-plot="chapters/001-楔子.md"]');
    assert.equal(row.style.paddingLeft, '30px');
    assert.equal(volumeRow(ui, 'chapters/第一卷').style.paddingLeft, '16px');
  });

  test('「去寫這一章」照舊掛在下一章上', () => {
    const go = [...chaptersGroup(ui).querySelectorAll('.row-go')];
    assert.equal(go.length, 1);
    assert.equal(go[0].closest('.row-plot').dataset.plot, '.novelwarden/summaries/004-北行.md');
  });
});

describe('卷的摺疊', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
    ui.clickEl(volumeRow(ui, 'chapters/第一卷').querySelector('.row-label'));
  });

  test('點卷名只折這一卷', () => {
    assert.deepEqual(layout(ui), [
      '卷:第一卷',
      '卷:第二卷', '章:第 4 章《北行》', '章:第 5 章《赤星》',
      '卷:第三卷', '（空卷：接下來新建的章落在這裡）',
    ]);
    const row = volumeRow(ui, 'chapters/第一卷');
    assert.equal(row.querySelector('.caret').textContent, '▸');
    assert.equal(row.querySelector('.row-label').textContent, '📁 第一卷');
  });

  test('重推樹還折著', () => {
    ui.post({ type: 'project', tree: volumeTree() });
    assert.equal(layout(ui)[1], '卷:第二卷');
  });

  test('右鍵「展開」再開啟', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第一卷')), '展開');
    assert.equal(layout(ui)[1], '章:第 1 章《楔子》');
  });
});

describe('卷的右鍵', { skip: JSDOM_SKIP }, () => {
  let ui;
  let items;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: volumeTree() });
    items = ui.itemsOf(ui.rightClick(volumeRow(ui, 'chapters/第二卷')));
    ui.closeMenu();
  });

  test('摺疊、新建、重新命名、刪除，沒有移動', () => {
    assert.deepEqual(items, ['摺疊', '在此卷新建章節檔案', '新建卷…', '重新命名', '刪除（移到回收站）']);
  });

  test('「在此卷新建章節檔案」帶這一卷的目錄', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), '在此卷新建章節檔案');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newChapter', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters/第二卷', JSON.stringify(msg));
  });

  test('「新建卷…」落在章節根', () => {
    ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), '新建卷…');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newFolder', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters', JSON.stringify(msg));
  });

  for (const [label, action] of [['重新命名', 'rename'], ['刪除（移到回收站）', 'delete']]) {
    test(`「${label}」帶卷目錄`, () => {
      ui.pick(ui.rightClick(volumeRow(ui, 'chapters/第二卷')), label);
      const msg = ui.last('fileAction');
      assert.deepEqual({ ...msg }, { type: 'fileAction', action, relPath: 'chapters/第二卷' });
    });
  }
});

describe('未分卷', { skip: JSDOM_SKIP }, () => {
  let ui;

  // 第 1 章是序章，直接放在章節根下；2–5 章在第一卷，新章跟著進第一卷。
  before(() => {
    ui = mount();
    const base = sampleTree();
    ui.post({
      type: 'project',
      tree: {
        ...base,
        plots: base.plots.map((p) => ({ ...p, volume: p.no === 1 ? '' : '第一卷' })),
        volumes: [
          { name: '', relPath: 'chapters', from: 1, to: 1, words: 300, latest: false },
          { name: '第一卷', relPath: 'chapters/第一卷', from: 2, to: 5, words: 3280, latest: true },
        ],
      },
    });
  });

  test('根下的章叫「未分卷」，照章號排在前面', () => {
    assert.deepEqual(layout(ui).slice(0, 3), ['卷:未分卷', '章:第 1 章《楔子》', '卷:第一卷']);
    assert.equal(volumeRow(ui, 'chapters/第一卷').querySelector('.meta').textContent, '第 2–5 章 · 3280 字 · 新章落這裡');
  });

  test('右鍵新建落在章節根，不給重新命名與刪除', () => {
    const menu = ui.rightClick(volumeRow(ui, 'chapters'));
    assert.deepEqual(ui.itemsOf(menu), ['摺疊', '新建章節檔案（不放進卷裡）', '新建卷…']);
    ui.pick(menu, '新建章節檔案（不放進卷裡）');
    const msg = ui.last('projectAction');
    assert.equal(msg.action, 'newChapter', JSON.stringify(msg));
    assert.equal(msg.dir, 'chapters', JSON.stringify(msg));
  });
});

describe('沒分卷照舊平鋪', { skip: JSDOM_SKIP }, () => {
  test('沒有卷標題，章不縮排', () => {
    const ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    assert.equal(chaptersGroup(ui).querySelectorAll('.row-volume').length, 0);
    assert.equal(layout(ui).filter((x) => x.startsWith('章:')).length, 5);
    assert.equal(chaptersGroup(ui).querySelector('.row-plot').style.paddingLeft, '16px');
  });
});

describe('空書只建了一卷', { skip: JSDOM_SKIP }, () => {
  test('畫出那一卷與空卷提示，下面照舊寫下一步', () => {
    const ui = mount();
    ui.post({
      type: 'project',
      tree: {
        ...sampleTree(),
        plots: [], plotCount: 0, chapterCount: 0, totalWords: 0, nextChapterNo: 1,
        volumes: [{ name: '第一卷', relPath: 'chapters/第一卷', words: 0, latest: true }],
      },
    });
    const rows = layout(ui);
    assert.equal(rows[0], '卷:第一卷');
    assert.equal(rows[1], '（空卷：接下來新建的章落在這裡）');
    assert.ok(rows[2]?.startsWith('還沒有章節'), JSON.stringify(rows));
  });
});
