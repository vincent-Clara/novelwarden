/**
 * 全書替換（`src/core/features/bookReplace.ts`），真臨時工程：預覽（`views/bookFind.ts` 的 `searchBook`）→ 照預覽拼請求 →
 * 替換 → 看磁碟、歷史版本、指紋鏈、派生資料。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 經閘道器寫 | 勾著的那幾處換了、勾掉的沒換；不按預覽的那幾處（檔案裡對不上）整份不寫 |
 * | 歷史版本 | 每個改過的檔案都在「歷史」裡留著替換前那一版——**不受節流**（十分鐘內的小改動照樣存） |
 * | 樂觀鎖 | 預覽之後磁碟上改過的跳過，磁碟上那份一個字不動（不拿舊的蓋新的） |
 * | 未儲存 | 編輯器裡有未儲存修改的那幾份跳過 |
 * | 範圍 | 不在勾著的範圍裡的路徑、內部檔案不寫 |
 * | 還不是小說工程 | 存不了歷史版本，不換 |
 * | 第 18 條 | 細綱與正文都改了、原本對得上的：`writtenFrom` / `sourceHash` 刷成替換後的（不掛 ⟳、不退回待定稿）；只改細綱：正文掛 ⟳；只改正文：回到待定稿；改之前就對不上的不刷；細綱的 `upstreamHash` 退回替換前的判斷（掛著的照掛、沒記過的照舊不記）；大綱與細綱一起改的對得上、大綱改了細綱沒改的掛 ⟳ |
 * | 角色卡改名 | 彙總裡提檔名沒跟著改；機器記的 `appearsIn` 不動 |
 * | 派生資料 | 替換角色卡、細綱之後出場索引照新的名字認人 |
 * | controller | `bookReplace` 回 `bookReplaceDone` 之後推 `state`；同一時刻只有一次替換 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
const made = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsm: './src/core/model/fs.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    bookFind: './src/core/views/bookFind.ts',
    bookReplace: './src/core/features/bookReplace.ts',
    history: './src/core/workspace/history.ts',
    workspace: './src/core/workspace/index.ts',
    pipe: './src/core/views/pipeline.ts',
    projectView: './src/core/views/projectView.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
});

after(() => {
  for (const t of made) cleanup(t.dir, bundle.db);
});

/**
 * 一份細綱：`fresh` 時 `writtenFrom` 記的就是這份的內容指紋；`body` 給了就定稿過（`sourceHash` = 正文指紋）。
 * `upstream`：`'fresh'` 記這一章梗概的指紋（梗概就是大綱裡這一章那一條），`'none'` 不記，其餘原樣寫進去（對不上的舊指紋）。
 */
function plotFile(no, title, sections, { upstream = 'fresh', written = 'fresh', body, cast } = {}) {
  const { renderPlotFile, parsePlotFile, plotContentHash, emptyPlotSections } = bundle.plotFile;
  const plot = {
    no,
    title,
    upstreamHash: upstream === 'fresh' ? bundle.plotFile.plotSynopsisHash(sections.梗概) : upstream === 'none' ? '' : upstream,
    done: false,
    sections: { ...emptyPlotSections(), ...sections },
    sourceHash: body !== undefined ? bundle.fsm.hash(body.trim()) : undefined,
    cast: body !== undefined ? cast ?? [] : undefined,
  };
  const rel = `.novelwarden/summaries/${String(no).padStart(3, '0')}-${title}.md`;
  const writtenFrom = written === 'fresh' ? plotContentHash(parsePlotFile(renderPlotFile(plot), rel)) : written === 'none' ? '' : written;
  return renderPlotFile({ ...plot, writtenFrom });
}

/**
 * 六章：
 *
 * | 章 | 正文 | 細綱 | 用來測 |
 * |---|---|---|---|
 * | 1 入宗 | 有「林晚」 | 有「林晚」，定稿過、指紋全對得上 | 兩頭都改了 → 重新整理 |
 * | 2 下山 | 有「林晚」 | 有「林晚」，定稿過 | 正文未儲存被跳過 → 只改了細綱 |
 * | 3 夜訪 | 有「林晚」 | 沒有「林晚」，定稿過 | 只改了正文 → 待定稿 |
 * | 4 北行 | — | 有「林晚」，梗概（大綱那一條）早就改過（⟳） | ⟳ 照掛 |
 * | 5 遠行 | — | 有「林晚」，手寫的、沒記過上游指紋 | 照舊不記 |
 * | 6 歸來 | 有「林晚」 | 有「林晚」，正文寫完之後細綱又改過（⟳），沒定稿 | 改之前就對不上的不刷 |
 */
async function setup(prefix) {
  const t = await makeTempProject(bundle.project, { prefix: `book-replace-${prefix}`, title: '青雲劍錄' });
  made.push(t);
  const bodies = {
    1: '# 入宗\n\n林晚推開山門。\n',
    2: '# 下山\n\n林晚下山去了。\n',
    3: '# 夜訪\n\n夜裡林晚來過。\n',
    6: '# 歸來\n\n林晚回來了。\n',
  };
  t.write('chapters/001-入宗.md', bodies[1]);
  t.write('.novelwarden/summaries/001-入宗.md', plotFile(1, '入宗', { 梗概: '林晚入宗', 出场人物: '林晚', 关键事件: '- 林晚推開山門' }, { body: bodies[1], cast: [{ name: '林晚', aliases: ['阿晚'] }] }));
  t.write('chapters/002-下山.md', bodies[2]);
  t.write('.novelwarden/summaries/002-下山.md', plotFile(2, '下山', { 梗概: '林晚下山', 关键事件: '- 下山' }, { body: bodies[2], cast: [{ name: '林晚', aliases: [] }] }));
  t.write('chapters/003-夜访.md', bodies[3]);
  t.write('.novelwarden/summaries/003-夜访.md', plotFile(3, '夜訪', { 梗概: '有人夜訪', 关键事件: '- 夜訪' }, { body: bodies[3] }));
  t.write('.novelwarden/summaries/004-北行.md', plotFile(4, '北行', { 梗概: '林晚北行', 关键事件: '- 北行' }, { upstream: 'deadbeef', written: 'none' }));
  t.write('.novelwarden/summaries/005-遠行.md', '---\nno: 5\ntitle: 遠行\n---\n\n# 第5章 遠行\n\n## 梗概\n林晚遠行\n\n## 關鍵事件\n- 出發\n');
  t.write('chapters/006-歸來.md', bodies[6]);
  t.write('.novelwarden/summaries/006-歸來.md', plotFile(6, '歸來', { 梗概: '林晚歸來', 关键事件: '- 歸來' }, { written: 'old-plot-hash' }));
  t.write(
    '.novelwarden/characters/林晚.md',
    '---\nname: 林晚\naliases: [阿晚]\nappearsIn: [1]\n---\n\n# 林晚\n\n## 身份\n林晚是主角。\n'
  );
  t.project.invalidate();
  return t;
}

/** 預覽一次，照預覽拼替換請求（預設全勾）。`pick(file, hit)` 返回 false 的那幾處勾掉。 */
async function previewAndRequest(t, q, opts = {}) {
  const query = { query: '林晚', replacement: '林婉', ...q };
  const preview = await bundle.bookFind.searchBook(t.project, query);
  const files = preview.files
    .map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.filter((h) => (opts.pick ? opts.pick(f, h) : true)).map((h) => ({ start: h.start, end: h.end })) }))
    .filter((f) => f.hits.length > 0);
  return { preview, request: { ...query, files, dirty: opts.dirty ?? [] } };
}

const replace = (t, request) => bundle.bookReplace.replaceInBook(t.project, request);

/** 流水線索引裡第 no 章那一行。 */
async function row(t, no) {
  t.project.invalidate();
  return (await bundle.pipe.buildPipelineIndex(t.project)).byNo.get(no);
}

describe('features/bookReplace › 經閘道器寫、歷史版本', () => {
  let t;
  let summary;
  const originals = {};
  let beforeReplace;

  before(async () => {
    t = await setup('write');
    for (const rel of ['chapters/001-入宗.md', 'chapters/003-夜访.md', '.novelwarden/summaries/001-入宗.md']) {
      originals[rel] = t.read(rel);
    }
    // 先經閘道器存一次小改動：第一版進了歷史，最新快照不到十分鐘——按節流，再來一次小改動不會存。
    const ws = new bundle.workspace.Workspace(t.project);
    await ws.write('chapters/001-入宗.md', { text: '# 入宗\n\n林晚推開山門。山風很冷。\n' }, { mode: 'overwrite', review: false });
    beforeReplace = t.read('chapters/001-入宗.md');
    const { request } = await previewAndRequest(t, { scopes: ['chapter', 'plot'] }, {
      // 第 6 章正文裡那一處勾掉。
      pick: (f) => f.path !== 'chapters/006-歸來.md',
    });
    summary = await replace(t, request);
  });

  test('勾著的換了，勾掉的沒換', () => {
    assert.match(t.read('chapters/001-入宗.md'), /林婉推開山門/);
    assert.match(t.read('chapters/003-夜访.md'), /夜裡林婉來過/);
    assert.match(t.read('chapters/006-歸來.md'), /林晚回來了/);
    assert.match(t.read('.novelwarden/summaries/006-歸來.md'), /林婉歸來/);
  });

  test('彙總：幾個檔案幾處', () => {
    assert.equal(summary.error, undefined);
    assert.deepEqual(summary.skipped, []);
    assert.equal(summary.files, summary.replaced.length);
    assert.equal(summary.hits, summary.replaced.reduce((n, r) => n + r.count, 0));
    assert.ok(summary.replaced.some((r) => r.path === 'chapters/001-入宗.md' && r.label === '第 1 章 入宗' && r.count === 1));
    assert.ok(!summary.replaced.some((r) => r.path === 'chapters/006-歸來.md'));
  });

  test('每個改過的檔案都在「歷史」裡留著替換前那一版——十分鐘內的小改動也存（不受節流）', async () => {
    for (const r of summary.replaced) {
      const snaps = await bundle.history.listSnapshots(t.project, r.path);
      assert.ok(snaps.length > 0, `${r.path} 沒有歷史版本`);
      const newest = await bundle.history.readSnapshot(t.project, r.path, snaps[0].id);
      const expected = r.path === 'chapters/001-入宗.md' ? beforeReplace : originals[r.path];
      if (expected !== undefined) {
        assert.equal(newest, expected, r.path);
      }
    }
  });

  test('frontmatter 裡機器記的賬一個字沒動', () => {
    const plot = bundle.plotFile.parsePlotFile(t.read('.novelwarden/summaries/004-北行.md'), '.novelwarden/summaries/004-北行.md');
    assert.equal(plot.upstreamHash, 'deadbeef');
    assert.equal(plot.no, 4);
  });
});

describe('features/bookReplace › 樂觀鎖、未儲存、範圍、還不是小說工程', () => {
  test('預覽之後磁碟上改過的跳過，磁碟上那份一個字不動', async () => {
    const t = await setup('conflict');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚在別處改過了。\n');
    const summary = await replace(t, request);
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason, s.label]), [['chapters/001-入宗.md', 'changed', '第 1 章 入宗']]);
    assert.match(summary.skipped[0].message, /重新預覽/);
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林晚在別處改過了。\n');
    assert.match(t.read('chapters/003-夜访.md'), /林婉/);
  });

  test('編輯器裡有未儲存修改的跳過（讓作者先儲存或放棄）', async () => {
    const t = await setup('dirty');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] }, { dirty: ['chapters/002-下山.md'] });
    const summary = await replace(t, request);
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason]), [['chapters/002-下山.md', 'dirty']]);
    assert.match(summary.skipped[0].message, /未儲存/);
    assert.match(t.read('chapters/002-下山.md'), /林晚下山/);
  });

  test('不在勾著的範圍裡的、內部檔案：不寫', async () => {
    const t = await setup('scope');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    const plotRel = '.novelwarden/summaries/001-入宗.md';
    const plotBefore = t.read(plotRel);
    const projectJson = t.read('.novelwarden/project.json');
    const extra = [
      { path: plotRel, hash: bundle.fsm.hash(plotBefore), hits: [{ start: plotBefore.indexOf('林晚'), end: plotBefore.indexOf('林晚') + 2 }] },
      { path: '.novelwarden/project.json', hash: bundle.fsm.hash(projectJson), hits: [{ start: 0, end: 1 }] },
    ];
    const summary = await replace(t, { ...request, files: [...request.files, ...extra] });
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason]), [[plotRel, 'outOfScope'], ['.novelwarden/project.json', 'outOfScope']]);
    assert.equal(t.read(plotRel), plotBefore);
    // project.json 會因為正文換了而重算一次章節清單（manifest），但第一個字沒被當成「一處」換掉。
    assert.doesNotThrow(() => JSON.parse(t.read('.novelwarden/project.json')));
    assert.equal(t.read('.novelwarden/project.json')[0], projectJson[0]);
  });

  test('勾著的那幾處對不上（不是一處匹配）：整份不寫', async () => {
    const t = await setup('mismatch');
    const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
    const first = request.files[0];
    const summary = await replace(t, { ...request, files: [{ ...first, hits: [{ start: 0, end: 2 }] }] });
    assert.deepEqual(summary.skipped.map((s) => s.reason), ['mismatch']);
    assert.match(t.read(first.path), /林晚/);
  });

  test('還不是小說工程（沒有 .novelwarden/）：存不了歷史版本，不換', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-book-replace-bare-'));
    try {
      fs.mkdirSync(path.join(dir, 'chapters'));
      fs.writeFileSync(path.join(dir, 'chapters', '001-楔子.md'), '林晚推門。');
      const bare = bundle.project.NovelProject.open(dir);
      const preview = await bundle.bookFind.searchBook(bare, { query: '林晚', scopes: ['chapter'], replacement: '林婉' });
      assert.equal(preview.listed, 1, '沒初始化也搜得到');
      const f = preview.files[0];
      const summary = await bundle.bookReplace.replaceInBook(bare, {
        query: '林晚', replacement: '林婉', scopes: ['chapter'], dirty: [],
        files: [{ path: f.path, hash: f.hash, hits: f.hits.map((h) => ({ start: h.start, end: h.end })) }],
      });
      assert.deepEqual(summary.skipped.map((s) => s.reason), ['noHistory']);
      assert.match(summary.skipped[0].message, /歷史版本/);
      assert.equal(fs.readFileSync(path.join(dir, 'chapters', '001-楔子.md'), 'utf8'), '林晚推門。');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('查詢串為空、正則寫錯：整個不做', async () => {
    const t = await setup('bad');
    assert.match((await replace(t, { query: '', replacement: 'x', scopes: ['chapter'], files: [], dirty: [] })).error, /空/);
    assert.match((await replace(t, { query: '(', regex: true, replacement: 'x', scopes: ['chapter'], files: [], dirty: [] })).error, /正則/);
  });
});

describe('features/bookReplace › 第 18 條：指紋鏈', () => {
  let t;
  let summary;
  const before18 = {};

  before(async () => {
    t = await setup('chain');
    for (const no of [1, 2, 3, 4, 6]) {
      before18[no] = await row(t, no);
    }
    // 正文與細綱一起換，第 2 章正文未儲存（被跳過）。
    const { request } = await previewAndRequest(t, { scopes: ['chapter', 'plot'] }, { dirty: ['chapters/002-下山.md'] });
    summary = await replace(t, request);
  });

  test('替換之前：1、2、3 章寫完且定稿過、對得上；4 章細綱掛 ⟳；6 章正文掛 ⟳', () => {
    assert.equal(before18[1].chapter.upstreamStale, false);
    assert.equal(before18[1].summary.stale, false);
    assert.equal(before18[2].chapter.upstreamStale, false);
    assert.equal(before18[3].summary.stale, false);
    assert.equal(before18[4].plot.upstreamStale, true);
    assert.equal(before18[6].chapter.upstreamStale, true);
  });

  test('細綱與正文都改了、原本對得上：writtenFrom / sourceHash 刷成替換後的，不掛 ⟳、不退回待定稿', async () => {
    const r = await row(t, 1);
    assert.equal(r.chapter.upstreamStale, false);
    assert.equal(r.summary.stale, false);
    assert.equal(r.plot.upstreamStale, false);
    assert.deepEqual(summary.chainKept, ['第 1 章 入宗']);
    // 定稿那份細綱裡的出場（cast）也跟著換了名字。
    assert.match(t.read('.novelwarden/summaries/001-入宗.md'), /cast: \[林婉\(阿晚\)\]/);
  });

  test('只改了細綱（正文未儲存被跳過）：正文掛 ⟳，彙總裡說出來', async () => {
    const r = await row(t, 2);
    assert.equal(r.chapter.upstreamStale, true);
    assert.deepEqual(summary.plotOnly, ['第 2 章 下山']);
  });

  test('只改了正文（細綱裡沒有這個名字）：定稿過的回到待定稿，彙總裡說出來', async () => {
    const r = await row(t, 3);
    assert.equal(r.summary.stale, true);
    assert.equal(r.chapter.upstreamStale, false);
    assert.deepEqual(summary.bodyOnly, ['第 3 章 夜访']);
  });

  test('改之前就對不上的不刷：第 6 章正文照掛 ⟳', async () => {
    assert.equal((await row(t, 6)).chapter.upstreamStale, true);
    assert.ok(!summary.chainKept.includes('第 6 章 歸來'));
  });

  test('細綱的上游：掛著 ⟳ 的照掛（舊指紋原樣留著），沒記過的照舊不記', async () => {
    const r4 = await row(t, 4);
    assert.equal(r4.plot.upstreamStale, true);
    assert.match(t.read('.novelwarden/summaries/004-北行.md'), /upstreamHash: deadbeef/);
    assert.match(t.read('.novelwarden/summaries/004-北行.md'), /林婉北行/);
    const p5 = t.read('.novelwarden/summaries/005-遠行.md');
    assert.match(p5, /林婉遠行/);
    assert.doesNotMatch(p5, /upstreamHash/);
  });
});

describe('features/bookReplace › 第 18 條：細綱在這一次裡卻被跳過', () => {
  test('正文換了、細綱因為未儲存被跳過：定稿過的章同樣回到待定稿，彙總裡說「只改了正文」', async () => {
    const t = await setup('plot-dirty');
    const { request } = await previewAndRequest(t, { scopes: ['chapter', 'plot'] }, { dirty: ['.novelwarden/summaries/001-入宗.md'] });
    const summary = await replace(t, request);
    assert.deepEqual(summary.skipped.map((s) => [s.path, s.reason]), [['.novelwarden/summaries/001-入宗.md', 'dirty']]);
    assert.equal((await row(t, 1)).summary.stale, true);
    assert.ok(summary.bodyOnly.includes('第 1 章 入宗'), JSON.stringify(summary.bodyOnly));
    assert.ok(!summary.chainKept.includes('第 1 章 入宗'));
  });
});

// 情節大綱沒有檔案，是各章細綱梗概的彙總（docs/design/plans/2026-10-22-outline-from-plots.md）：不單列，換細綱就換了它。
describe('features/bookReplace › 第 18 條：情節大綱（各章細綱的梗概）', () => {
  test('預覽裡沒有 outline.md；梗概與其餘幾節在同一份細綱裡一起換，上游對得上；彙總出來的大綱跟著變', async () => {
    const t = await setup('outline');
    const { preview, request } = await previewAndRequest(t, { scopes: ['doc', 'plot', 'chapter'] });
    assert.ok(!preview.files.some((f) => f.path.endsWith('outline.md')), JSON.stringify(preview.files.map((f) => f.path)));
    await replace(t, request);
    assert.equal((await row(t, 1)).plot.upstreamStale, false);
    assert.equal((await row(t, 2)).plot.upstreamStale, false);
    t.project.invalidate();
    assert.match(await t.project.readOutline(), /## 第1章：入宗\n林婉入宗/);
  });
});

describe('features/bookReplace › 角色卡改名與派生資料', () => {
  let t;
  const cardRel = '.novelwarden/characters/林晚.md';
  const tree = async () => {
    t.project.invalidate();
    return bundle.projectView.buildProjectTree(t.project);
  };

  before(async () => {
    t = await setup('cast');
  });

  test('替換之前：卡叫林晚，第 1、2 章的定稿裡認得出她', async () => {
    const tr = await tree();
    assert.deepEqual(tr.castByCard[cardRel].plots, [1, 2]);
  });

  test('只換角色卡：彙總裡提檔名沒跟著改；機器記的 appearsIn 不動；定稿裡只寫了舊名字的那一章暫時認不出她', async () => {
    const { request } = await previewAndRequest(t, { scopes: ['character'] });
    const summary = await replace(t, request);
    assert.deepEqual(summary.renamedCards, [{ path: cardRel, label: '角色 · 林晚', name: '林婉', nameChanged: true }]);
    assert.ok(t.has(cardRel), '檔名沒改');
    assert.match(t.read(cardRel), /appearsIn: \[1\]/);
    const tr = await tree();
    // 第 1 章的定稿記著別名「阿晚」，照樣認得出；第 2 章只寫了「林晚」，成了沒建卡的出場人物。
    assert.deepEqual(tr.castByCard[cardRel].plots, [1]);
    assert.ok(tr.cast.some((c) => c.name === '林晚' && c.plots.includes(2)), JSON.stringify(tr.cast));
  });

  test('再把細綱也換了：出場索引照新的名字認回來（派生資料從磁碟現算）', async () => {
    const { request } = await previewAndRequest(t, { scopes: ['plot'] });
    await replace(t, request);
    const tr = await tree();
    assert.deepEqual(tr.castByCard[cardRel].plots, [1, 2]);
    assert.ok(!tr.cast.some((c) => c.name === '林晚'));
  });

  test('只換了別名：也提一句，nameChanged 是 false', async () => {
    const t2 = await setup('alias');
    const { request } = await previewAndRequest(t2, { query: '阿晚', replacement: '婉兒', scopes: ['character'] });
    const summary = await replace(t2, request);
    assert.deepEqual(summary.renamedCards.map((c) => [c.name, c.nameChanged]), [['林晚', false]]);
  });
});

describe('controller › bookReplace', () => {
  test('回 bookReplaceDone，之後推 state；同一時刻只有一次替換', async () => {
    const t = await setup('controller');
    const posted = [];
    const controller = new bundle.controller.ChatController(t.project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      const { request } = await previewAndRequest(t, { scopes: ['chapter'] });
      const first = controller.handle({ type: 'bookReplace', requestId: 'br-1', request });
      const second = controller.handle({ type: 'bookReplace', requestId: 'br-2', request });
      await Promise.all([first, second]);
      const done = posted.filter((m) => m.type === 'bookReplaceDone');
      const one = done.find((m) => m.requestId === 'br-1');
      const two = done.find((m) => m.requestId === 'br-2');
      assert.ok(one && two, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(one.summary.error, undefined);
      assert.ok(one.summary.files > 0);
      assert.match(two.summary.error, /還沒換完/);
      const doneAt = posted.indexOf(one);
      assert.ok(posted.slice(doneAt + 1).some((m) => m.type === 'state'), '替換完沒推 state');
    } finally {
      controller.dispose();
    }
  });
});
