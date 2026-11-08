/**
 * 歷史版本的落盤一半（`src/core/workspace/history.ts` + 閘道器裡那幾處呼叫）：真臨時工程。
 *
 * 守的是「凡是走閘道器覆蓋一份創作產物，舊內容都先留一版」，以及幾條不能出錯的邊：新建不存、相同不存、
 * 節流、大改總存、只留 50 個、存不下也照常寫盤、`.gitignore` 只放一次、`other` 與還不是工程的目錄不存、
 * 不進檢索、監聽擋掉、類檔案操作刪不掉這個目錄；改名 / 搬家時快照跟著走（單個檔案、整個目錄、伴生的細綱與草稿、
 * 合併時撞名加序號並修剪），搬不動也照常搬家、刪除時留在原路徑。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
const dirs = [];

const MIN = 60_000;
const BIG = '正文'.repeat(600);

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    kind: './src/core/workspace/kind.ts',
    guard: './src/core/workspace/guard.ts',
    history: './src/core/workspace/history.ts',
    ws: './src/core/workspace/index.ts',
    fileEditing: './src/core/files/fileEditing.ts',
    fileOps: './src/core/files/fileOps.ts',
    logger: './src/core/runtime/logger.ts',
    watch: './src/core/watchPolicy.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  return { t, ws: new bundle.ws.Workspace(t.project) };
}

/** 這份檔案的快照檔名，新的在前。 */
function snaps(t, rel) {
  const dir = t.rel('.novelwarden/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

function snapText(t, rel, name) {
  return fs.readFileSync(t.rel('.novelwarden/history', rel, name), 'utf8');
}

/** 把這份檔案的快照整體往前挪 `minutes` 分鐘（改檔名裡的時間），模擬「最新快照已經是一陣子之前的了」。 */
function age(t, rel, minutes) {
  const dir = t.rel('.novelwarden/history', rel);
  for (const name of fs.readdirSync(dir)) {
    const at = bundle.history.parseSnapshotFileName(name);
    if (at) {
      fs.renameSync(path.join(dir, name), path.join(dir, bundle.history.snapshotFileName(new Date(at.time - minutes * MIN), at.dup)));
    }
  }
}

const overwrite = (ws, rel, text) => ws.write(rel, { text }, { mode: 'overwrite', review: false });

describe('閘道器覆蓋一份創作產物之前存舊版', () => {
  let t;
  let ws;
  const rel = 'chapters/001-雪夜.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-basic'));
    await ws.write(rel, { text: `# 雪夜\n\n${BIG}` }, { mode: 'create' });
  });

  test('新建不存（沒有被覆蓋的東西）', () => {
    assert.equal(fs.existsSync(t.rel('.novelwarden/history')), false);
  });

  test('覆蓋：存下磁碟上的舊內容，新內容照常落盤', async () => {
    await overwrite(ws, rel, '# 雪夜\n\n全換了。');
    const names = snaps(t, rel);
    assert.equal(names.length, 1);
    assert.equal(snapText(t, rel, names[0]), `# 雪夜\n\n${BIG}`);
    assert.equal(t.read(rel), '# 雪夜\n\n全換了。');
  });

  test('快照目錄映象原檔案的路徑，快照名是時間 + .txt', () => {
    assert.match(snaps(t, rel)[0], /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}[+-]\d{4}\.txt$/);
  });

  test('第一次存時放一個 .gitignore（內容 *）', () => {
    assert.equal(t.read('.novelwarden/history/.gitignore'), '*\n');
  });

  test('寫一樣的內容不存', async () => {
    await overwrite(ws, rel, '# 雪夜\n\n全換了。');
    assert.equal(snaps(t, rel).length, 1);
  });

  test('列得出來（新的在前，帶字數與位元組數）、讀得回全文', async () => {
    const list = await bundle.history.listSnapshots(t.project, rel);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, snaps(t, rel)[0]);
    assert.equal(list[0].words, 1202);
    assert.equal(list[0].bytes, Buffer.byteLength(`# 雪夜\n\n${BIG}`));
    assert.equal(await bundle.history.readSnapshot(t.project, rel, list[0].id), `# 雪夜\n\n${BIG}`);
  });

  test('讀快照只認快照檔名：../ 與認不出的名字給 notFound', async () => {
    for (const id of ['../../config.md', '.gitignore', '2026-10-18_14-32-05+0800.txt']) {
      await assert.rejects(bundle.history.readSnapshot(t.project, rel, id), (e) => e.code === 'notFound', id);
    }
  });
});

describe('節流：10 分鐘內的零星小改併成一版，大改總存', () => {
  let t;
  let ws;
  const rel = 'chapters/002-風起.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-throttle'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    await overwrite(ws, rel, `${BIG}一`);
  });

  test('起點：一版', () => {
    assert.equal(snaps(t, rel).length, 1);
  });

  test('自動儲存那樣連著存幾次小改：不再多存', async () => {
    for (const tail of ['一二', '一二三', '一二三四', '一二三四五']) {
      await overwrite(ws, rel, `${BIG}${tail}`);
    }
    assert.equal(snaps(t, rel).length, 1);
  });

  test('最新一版超過 10 分鐘之後，小改也存', async () => {
    age(t, rel, 11);
    await overwrite(ws, rel, `${BIG}一二三四五六`);
    const names = snaps(t, rel);
    assert.equal(names.length, 2);
    assert.equal(snapText(t, rel, names[0]), `${BIG}一二三四五`);
  });

  test('不到 10 分鐘的大改（整章重寫）：存，存的是重寫之前那一份', async () => {
    await overwrite(ws, rel, '重寫'.repeat(500));
    const names = snaps(t, rel);
    assert.equal(names.length, 3);
    assert.equal(snapText(t, rel, names[0]), `${BIG}一二三四五六`);
  });

  test('追加（接著寫）也算覆蓋：追加得多就存', async () => {
    await ws.write(rel, { text: '續'.repeat(400) }, { mode: 'append' });
    const names = snaps(t, rel);
    assert.equal(names.length, 4);
    assert.equal(snapText(t, rel, names[0]), '重寫'.repeat(500));
  });
});

describe('每份檔案最多留 50 個，多的刪掉最舊的', () => {
  let t;
  const rel = 'chapters/003-遠行.md';

  before(async () => {
    let ws;
    ({ t, ws } = await fresh('hist-keep'));
    await ws.write(rel, { text: '起點' }, { mode: 'create' });
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 55; i++) {
      t.write(rel, `第 ${i} 版`);
      await bundle.history.snapshotBeforeWrite(t.project, rel, undefined, { force: true, now: base + i * 1000 });
    }
  });

  test('只剩 50 個', () => {
    assert.equal(snaps(t, rel).length, 50);
  });

  test('刪掉的是最舊的 5 個，最新的那個在', () => {
    const names = snaps(t, rel);
    assert.equal(snapText(t, rel, names[0]), '第 54 版');
    assert.equal(snapText(t, rel, names[names.length - 1]), '第 5 版');
  });

  test('.gitignore 不算在 50 個裡，也不被裁掉', () => {
    assert.equal(t.read('.novelwarden/history/.gitignore'), '*\n');
  });
});

describe('存快照失敗絕不擋住儲存', () => {
  let t;
  let ws;
  let result;
  const rel = 'chapters/004-殘燈.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-fail'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    // 歷史根被一個同名檔案佔了：mkdir 必然失敗。
    t.write('.novelwarden/history', '不是目錄');
    bundle.logger.clearLogs();
    result = await overwrite(ws, rel, '照樣寫進去了。');
  });

  test('照常寫盤', () => {
    assert.equal(t.read(rel), '照樣寫進去了。');
    assert.equal(result.skipped, undefined);
  });

  test('記一條 warn，說清照常寫盤了', () => {
    const warn = bundle.logger.recentLogs().find((e) => e.level === 'warn' && e.message.includes('歷史版本'));
    assert.ok(warn, JSON.stringify(bundle.logger.recentLogs().map((e) => e.message)));
    assert.ok(warn.message.includes(rel) && warn.message.includes('照常寫盤'), warn.message);
  });

  test('佔位的那個檔案原樣沒動', () => {
    assert.equal(t.read('.novelwarden/history'), '不是目錄');
  });
});

describe('.gitignore 只在建出歷史目錄那一次放', () => {
  let t;
  const rel = 'chapters/005-夜雨.md';

  before(async () => {
    let ws;
    ({ t, ws } = await fresh('hist-gitignore'));
    await ws.write(rel, { text: BIG }, { mode: 'create' });
    await overwrite(ws, rel, '第二版');
    fs.rmSync(t.rel('.novelwarden/history/.gitignore'));
    await overwrite(ws, rel, BIG + BIG);
  });

  test('作者刪掉之後不再補回來（他想讓 Git 收這些快照）', () => {
    assert.equal(snaps(t, rel).length, 2);
    assert.equal(fs.existsSync(t.rel('.novelwarden/history/.gitignore')), false);
  });
});

describe('範圍：只管創作產物', () => {
  let t;
  let ws;

  before(async () => {
    ({ t, ws } = await fresh('hist-scope'));
  });

  test('other（工程根的隨手記）不存', async () => {
    await ws.write('隨手記.md', { text: '一' }, { mode: 'create' });
    await overwrite(ws, '隨手記.md', '二');
    assert.equal(fs.existsSync(t.rel('.novelwarden/history')), false);
  });

  test('不存的檔案，historyUnavailable 說得出為什麼', async () => {
    assert.match(await bundle.history.historyUnavailable(t.project, '隨手記.md'), /不是工程裡的創作產物/);
    assert.equal(await bundle.history.historyUnavailable(t.project, 'chapters/001.md'), undefined);
  });

  test('細綱、角色卡、設定、草稿都存（各在自己的映象目錄裡）', async () => {
    const files = [
      '.novelwarden/summaries/001-雪夜.md',
      '.novelwarden/characters/林昭.md',
      '.novelwarden/lore/青雲宗.md',
      'drafts/001-雪夜.md',
    ];
    for (const rel of files) {
      t.write(rel, `${rel} 的舊內容`);
      await overwrite(ws, rel, `${rel} 的新內容`);
      assert.equal(snaps(t, rel).length, 1, rel);
      assert.equal(snapText(t, rel, snaps(t, rel)[0]), `${rel} 的舊內容`, rel);
    }
  });

  // 情節大綱沒有檔案（各章細綱梗概的彙總）：存回去時改了梗概的那一章細綱存一版，outline.md 自己沒有歷史。
  test('情節大綱存回去：改了梗概的那一章細綱存一版舊的', async () => {
    const plot = '.novelwarden/summaries/002-入鎮.md';
    t.write(plot, '---\nno: 2\ntitle: 入鎮\n---\n\n# 第2章 入鎮\n\n## 梗概\n\n舊的梗概。\n');
    t.project.invalidate();
    const doc = (await ws.read('.novelwarden/outline.md')).text;
    await overwrite(ws, '.novelwarden/outline.md', doc.replace('舊的梗概。', '新的梗概。'));
    assert.equal(snaps(t, plot).length, 1);
    assert.match(snapText(t, plot, snaps(t, plot)[0]), /舊的梗概。/);
    assert.match(t.read(plot), /新的梗概。/);
    assert.equal(snaps(t, '.novelwarden/outline.md').length, 0);
  });

  test('還不是小說工程（沒有 .novelwarden/）的目錄裡不存，也不替作者建出歷史目錄', async () => {
    const d = makeTempDir('hist-noproject');
    dirs.push(d.dir);
    const project = bundle.project.NovelProject.open(d.dir);
    const plain = new bundle.ws.Workspace(project);
    d.write('chapters/001-雪夜.md', '舊的');
    assert.match(await bundle.history.historyUnavailable(project, 'chapters/001-雪夜.md'), /還不是小說工程/);
    await overwrite(plain, 'chapters/001-雪夜.md', '新的');
    assert.equal(d.read('chapters/001-雪夜.md'), '新的');
    assert.equal(fs.existsSync(d.rel('.novelwarden/history')), false);
  });
});

describe('各條覆蓋路徑都存：編輯器儲存、MCP 的 edit、領域寫入器、定稿寫回', () => {
  let t;
  let ws;

  before(async () => {
    ({ t, ws } = await fresh('hist-paths'));
  });

  test('內建編輯器儲存（writeFileFromEditor）', async () => {
    const rel = 'chapters/010-編輯器.md';
    t.write(rel, BIG);
    await bundle.fileEditing.writeFileFromEditor(t.dir, rel, '編輯器裡存的新版');
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), BIG);
  });

  test('MCP 的 edit（定點替換，走 write）', async () => {
    const rel = 'chapters/011-替換.md';
    t.write(rel, '他走進了院子。');
    await ws.edit(rel, [{ old: '走進', new: '衝進' }]);
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), '他走進了院子。');
  });

  test('領域寫入器：重寫角色卡、文風、敘事線', async () => {
    t.write('.novelwarden/characters/林昭.md', '# 林昭\n\n舊卡。');
    await ws.writeCharacter({ slug: '林昭', name: '林昭', aliases: [], tags: [], sections: {} });
    assert.equal(snapText(t, '.novelwarden/characters/林昭.md', snaps(t, '.novelwarden/characters/林昭.md')[0]), '# 林昭\n\n舊卡。');

    t.write('.novelwarden/style.md', '# 文風指南\n\n舊的文風。');
    await ws.writeStyleGuide('新的文風。');
    assert.equal(snaps(t, '.novelwarden/style.md').length, 1);

    const thread = '.novelwarden/threads/玉佩.md';
    t.write(thread, '# 玉佩\n\n舊的。');
    await ws.updateThread(thread, (raw) => `${raw}\n- 新的一條\n`);
    assert.equal(snapText(t, thread, snaps(t, thread)[0]), '# 玉佩\n\n舊的。');
  });

  test('敘事線：新建一條不存歷史（沒覆蓋任何東西），同名已在就一個位元組不動', async () => {
    const plan = { name: '沈家舊案', kind: '支线', origin: '计划', intent: '十年前那把火。', foreshadowing: [] };
    const rel = await ws.createThread(plan);
    assert.equal(rel, '.novelwarden/threads/沈家舊案.md');
    assert.equal(snaps(t, rel).length, 0);
    t.write(rel, '作者改過的。');
    assert.equal(await ws.createThread(plan), undefined);
    assert.equal(t.read(rel), '作者改過的。');
  });

  test('敘事線：改寫只認敘事線目錄裡的檔案', async () => {
    await assert.rejects(() => ws.updateThread('.novelwarden/style.md', (raw) => `${raw}x`), /不是敘事線目錄裡的檔案/);
    await assert.rejects(() => ws.updateThread('.novelwarden/threads.md', (raw) => `${raw}x`), /不是敘事線目錄裡的檔案/);
  });

  test('寫細綱覆蓋已有那份', async () => {
    const plot = {
      no: 12,
      title: '入宗',
      targetWords: 3000,
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '舊的梗概。', 关键事件: '舊的事件。' },
    };
    const rel = await ws.writePlot(plot);
    const before1 = t.read(rel);
    await ws.writePlot({ ...plot, sections: { ...plot.sections, 梗概: '新的梗概。'.repeat(80) } });
    assert.equal(snapText(t, rel, snaps(t, rel)[0]), before1);
  });

  test('定稿寫回細綱：回收站那一份照舊，歷史版本裡也有一版', async () => {
    await ws.createChapter(20, '山門', '他在山門外蹲了兩個時辰。');
    t.project.invalidate();
    const chapter = await t.project.getChapter(20);
    const plotRel = t.project.plotPathForChapter(chapter.relPath);
    t.write(plotRel, '---\nno: 20\ntitle: 山門\n---\n\n## 梗概\n\n計劃裡的梗概。\n');
    const plan = t.read(plotRel);
    t.project.invalidate();
    const r = await ws.finalizePlot(
      chapter,
      { ...bundle.plotFile.emptyPlotSections(), 梗概: '他在山門外蹲了兩個時辰。', 关键事件: '林昭在山門外等到天黑。' },
      [{ name: '林昭', aliases: [] }]
    );
    assert.ok(r.trashed, JSON.stringify(r));
    assert.equal(t.read(r.trashed), plan);
    assert.equal(snapText(t, plotRel, snaps(t, plotRel)[0]), plan);
  });

  test('只改 frontmatter 一個鍵的記賬（recordWrittenFrom）不存', async () => {
    const plotRel = '.novelwarden/summaries/030-記賬.md';
    t.write(plotRel, '---\nno: 30\ntitle: 記賬\n---\n\n## 梗概\n\n梗概。\n');
    await ws.recordWrittenFrom(plotRel, 'abcdef0123456789');
    assert.equal(snaps(t, plotRel).length, 0);
  });

  test('位元組原樣複製（CRLF 不被改成 LF）', async () => {
    const rel = 'chapters/012-換行.txt';
    fs.writeFileSync(t.rel(rel), Buffer.from('第一行\r\n第二行\r\n', 'utf8'));
    await overwrite(ws, rel, '全換了。'.repeat(100));
    assert.deepEqual(fs.readFileSync(t.rel('.novelwarden/history', rel, snaps(t, rel)[0])), Buffer.from('第一行\r\n第二行\r\n', 'utf8'));
  });
});

describe('不進上下文、不觸發重掃、刪不掉', () => {
  let t;
  let ws;
  const rel = 'chapters/001-青銅燈.md';
  let snapRel;

  before(async () => {
    ({ t, ws } = await fresh('hist-isolate'));
    await ws.write(rel, { text: `那盞燈的銅綠斑駁了一層。${BIG}` }, { mode: 'create' });
    await overwrite(ws, rel, '燈滅了。');
    snapRel = `.novelwarden/history/${rel}/${snaps(t, rel)[0]}`;
  });

  test('kindOfPath 把歷史目錄裡的東西判成 other（裝配器只按種類讀，碰不到它）', () => {
    assert.equal(bundle.kind.kindOfPath(t.project, snapRel).kind, 'other');
    assert.equal(bundle.kind.kindOfPath(t.project, '.novelwarden/history/.novelwarden/summaries/001-雪夜.md/x.txt').kind, 'other');
  });

  test('全文檢索跳過歷史版本（搜出來的不是現在的書）', async () => {
    assert.ok(t.read(snapRel).includes('銅綠斑駁'));
    const r = await ws.search('銅綠斑駁');
    assert.deepEqual(r.hits.map((x) => x.rel), []);
  });

  test('watchPolicy 擋掉歷史目錄的變動', () => {
    assert.equal(bundle.watch.shouldIgnoreChange(snapRel), true);
  });

  test('歷史目錄是固定目錄：閘道器刪不掉、搬不走', async () => {
    assert.equal(bundle.guard.isProtectedPath(t.project, '.novelwarden/history'), true);
    await assert.rejects(ws.remove('.novelwarden/history'), (e) => e.code === 'protected');
    await assert.rejects(ws.move('.novelwarden/history', '舊稿'), (e) => e.code === 'protected');
    assert.equal(fs.existsSync(t.rel(snapRel)), true);
  });

  test('工程頁的類檔案操作刪不到它（不在三個區裡）', async () => {
    h.expect('刪除');
    assert.equal(await bundle.fileOps.deleteEntry(t.project, '.novelwarden/history'), false);
    assert.equal(fs.existsSync(t.rel(snapRel)), true);
  });

  test('「檔案」頁照常列得出來', async () => {
    const names = (await ws.list('.novelwarden')).map((e) => e.name);
    assert.ok(names.includes('history'), names.join('、'));
  });
});

// ---------------------------------------------------------------- 改名 / 搬家：快照跟著走
//
// 快照按路徑存。從前 `move` 不搬歷史目錄，在新路徑上開啟「歷史」面板看不到改名之前存的版本。

/** 手放幾個快照：`items` 是 `[毫秒時間戳, 內容, 序號?]`。返回快照檔名。 */
function seed(t, rel, items) {
  return items.map(([ms, text, dup]) => {
    const name = bundle.history.snapshotFileName(new Date(ms), dup);
    t.write(`.novelwarden/history/${rel}/${name}`, text);
    return name;
  });
}

const histDir = (t, rel) => t.rel('.novelwarden/history', rel);

describe('改名 / 搬家：快照跟著走', () => {
  let t;
  let ws;

  before(async () => {
    ({ t, ws } = await fresh('hist-move'));
  });

  test('單個檔案：快照目錄搬到新路徑下，舊路徑不留', async () => {
    await ws.write('chapters/001-甲.md', { text: BIG }, { mode: 'create' });
    await overwrite(ws, 'chapters/001-甲.md', '改過一版。');
    await ws.move('chapters/001-甲.md', 'chapters/001-乙.md');
    assert.equal(snaps(t, 'chapters/001-乙.md').length, 1);
    assert.equal(snapText(t, 'chapters/001-乙.md', snaps(t, 'chapters/001-乙.md')[0]), BIG);
    assert.equal(fs.existsSync(histDir(t, 'chapters/001-甲.md')), false);
  });

  test('在新路徑上列得出來（「歷史」面板讀的就是它）', async () => {
    const list = await bundle.history.listSnapshots(t.project, 'chapters/001-乙.md');
    assert.equal(list.length, 1);
    assert.equal(await bundle.history.readSnapshot(t.project, 'chapters/001-乙.md', list[0].id), BIG);
  });

  test('章節改名時細綱、草稿跟著改名，它們的快照也跟著走', async () => {
    await ws.write('chapters/002-舊.md', { text: BIG }, { mode: 'create' });
    for (const rel of ['.novelwarden/summaries/002-舊.md', 'drafts/002-舊.md']) {
      t.write(rel, `${rel} 的舊內容`);
      await overwrite(ws, rel, `${rel} 的新內容`);
    }
    await ws.move('chapters/002-舊.md', 'chapters/002-新.md');
    assert.ok(t.has('.novelwarden/summaries/002-新.md') && t.has('drafts/002-新.md'));
    assert.equal(snapText(t, '.novelwarden/summaries/002-新.md', snaps(t, '.novelwarden/summaries/002-新.md')[0]), '.novelwarden/summaries/002-舊.md 的舊內容');
    assert.equal(snapText(t, 'drafts/002-新.md', snaps(t, 'drafts/002-新.md')[0]), 'drafts/002-舊.md 的舊內容');
    assert.equal(fs.existsSync(histDir(t, '.novelwarden/summaries/002-舊.md')), false);
    assert.equal(fs.existsSync(histDir(t, 'drafts/002-舊.md')), false);
  });

  test('整個分卷目錄改名：下面每份檔案（連同伴生的細綱、草稿）的快照都跟著走', async () => {
    const files = ['chapters/第一卷/003-雪.md', 'chapters/第一卷/004-風.txt', '.novelwarden/summaries/第一卷/003-雪.md', 'drafts/第一卷/003-雪.md'];
    for (const rel of files) {
      t.write(rel, `${rel} 的舊內容`);
      await overwrite(ws, rel, `${rel} 的新內容`);
    }
    await ws.move('chapters/第一卷', 'chapters/第二卷');
    for (const rel of files) {
      const moved = rel.replace('第一卷', '第二卷');
      assert.ok(t.has(moved), moved);
      assert.equal(snapText(t, moved, snaps(t, moved)[0]), `${rel} 的舊內容`, moved);
      assert.equal(fs.existsSync(histDir(t, rel)), false, rel);
    }
  });

  test('新路徑下已經有快照（以前有過同名檔案）：兩邊合併，撞名的按同一刻加序號，一份都不丟', async () => {
    const base = Date.UTC(2026, 5, 1, 8);
    // 新路徑上從前那份檔案留下的兩版。
    const [a, b] = seed(t, 'chapters/005-丙.md', [[base, '從前的丙·一'], [base + 60_000, '從前的丙·二']]);
    // 要搬過來的這份的兩版：第一版與 a 同一刻、同一個檔名。
    const [c, d] = seed(t, 'chapters/005-丁.md', [[base, '丁·一'], [base + 120_000, '丁·二']]);
    assert.equal(c, a);
    t.write('chapters/005-丁.md', '丁的現在。');
    await ws.move('chapters/005-丁.md', 'chapters/005-丙.md');

    const names = snaps(t, 'chapters/005-丙.md');
    assert.equal(names.length, 4, names.join('、'));
    const texts = Object.fromEntries(names.map((n) => [n, snapText(t, 'chapters/005-丙.md', n)]));
    assert.equal(texts[a], '從前的丙·一');
    assert.equal(texts[b], '從前的丙·二');
    assert.equal(texts[d], '丁·二');
    assert.equal(texts[bundle.history.snapshotFileName(new Date(base), 2)], '丁·一');
    assert.equal(fs.existsSync(histDir(t, 'chapters/005-丁.md')), false);
  });

  test('合併之後按保留上限修剪：只留最近 50 個', async () => {
    const base = Date.UTC(2026, 6, 1);
    seed(t, 'chapters/006-甲.md', Array.from({ length: 30 }, (_, i) => [base + i * 1000, `舊·${i}`]));
    seed(t, 'chapters/006-乙.md', Array.from({ length: 30 }, (_, i) => [base + 100_000 + i * 1000, `新·${i}`]));
    t.write('chapters/006-乙.md', '乙的現在。');
    await ws.move('chapters/006-乙.md', 'chapters/006-甲.md');
    const names = snaps(t, 'chapters/006-甲.md');
    assert.equal(names.length, 50);
    assert.equal(snapText(t, 'chapters/006-甲.md', names[0]), '新·29');
    // 最舊的 10 個（舊·0 … 舊·9）裁掉了。
    assert.equal(snapText(t, 'chapters/006-甲.md', names[names.length - 1]), '舊·10');
  });

  test('刪除（進回收站）時快照留在原路徑；從回收站搬回原處，歷史還在', async () => {
    await ws.write('chapters/007-殘燈.md', { text: BIG }, { mode: 'create' });
    await overwrite(ws, 'chapters/007-殘燈.md', '燈滅了。');
    await ws.remove('chapters/007-殘燈.md');
    assert.equal(snaps(t, 'chapters/007-殘燈.md').length, 1);
    fs.renameSync(t.rel('.novelwarden/.trash/chapters/007-殘燈.md'), t.rel('chapters/007-殘燈.md'));
    assert.equal((await bundle.history.listSnapshots(t.project, 'chapters/007-殘燈.md')).length, 1);
  });

  test('寫細綱時改了標題、檔名跟著變（還沒有正文）：細綱的快照也跟著走', async () => {
    const plot = {
      no: 40,
      title: '',
      upstreamHash: '',
      done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '還沒起名時的計劃。', 关键事件: '甲。' },
    };
    const first = await ws.writePlot(plot);
    await ws.writePlot({ ...plot, sections: { ...plot.sections, 梗概: '改過的計劃。'.repeat(80) } });
    assert.equal(snaps(t, first).length, 1);
    const renamed = await ws.writePlot({ ...plot, title: '入宗', sections: { ...plot.sections, 梗概: '改過的計劃。'.repeat(80) } });
    assert.notEqual(renamed, first);
    assert.ok(snaps(t, renamed).length >= 1, renamed);
    assert.equal(fs.existsSync(histDir(t, first)), false);
  });
});

describe('搬快照失敗絕不擋住搬家', () => {
  let t;
  let ws;
  let result;
  const from = 'chapters/008-甲.md';
  const to = 'chapters/008-乙.md';

  before(async () => {
    ({ t, ws } = await fresh('hist-move-fail'));
    await ws.write(from, { text: BIG }, { mode: 'create' });
    await overwrite(ws, from, '改過一版。');
    // 新路徑的快照目錄被一個同名檔案佔了：搬不過去。
    t.write(`.novelwarden/history/${to}`, '不是目錄');
    bundle.logger.clearLogs();
    result = await ws.move(from, to);
  });

  test('照常搬家', () => {
    assert.equal(result.rel, to);
    assert.equal(t.read(to), '改過一版。');
    assert.equal(t.has(from), false);
  });

  test('快照留在舊路徑下，一個不丟', () => {
    assert.equal(snaps(t, from).length, 1);
    assert.equal(snapText(t, from, snaps(t, from)[0]), BIG);
  });

  test('佔位的那個檔案原樣沒動', () => {
    assert.equal(t.read(`.novelwarden/history/${to}`), '不是目錄');
  });

  test('記一條 warn，說清搬家照常', () => {
    const warn = bundle.logger.recentLogs().find((e) => e.level === 'warn' && e.message.includes('歷史版本'));
    assert.ok(warn, JSON.stringify(bundle.logger.recentLogs().map((e) => e.message)));
    assert.ok(warn.message.includes(from) && warn.message.includes('照常'), warn.message);
  });
});
