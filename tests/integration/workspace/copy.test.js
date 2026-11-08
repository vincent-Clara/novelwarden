/**
 * 閘道器的複製（`Workspace.copy`）與檔案頁的「複製 → 貼上」（`files/projectFiles.ts` 的 `copyInto`）。
 *
 * 從前貼上的複製變體直接 `fs.cp`，**不過守衛**：能把檔案複製進 `.trash/`、`sessions/`、`.novelwarden/history/`，
 * 也能把會話檔案、工程庫從內部目錄裡複製出來；複製細綱時連定稿記下的指紋一起抄過去。現在走閘道器（AGENTS 第 7 條）：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 複製進回收站、會話目錄、歷史版本一律拒絕，什麼都不建 | 那三處不是作者的操作物件：回收站裡躺著刪掉的東西，會話是內部檔案，歷史版本是閘道器自己存的副本 |
 * | 會話檔案、工程庫複製不出來 | 內部檔案讀當不存在（守衛 `isInternalPath`） |
 * | 從回收站、歷史版本裡複製出來可以（⚑），原件一字不動 | 讀得到就複製得出來：這是在工程裡找回一份的唯一入口，回收站與歷史都不被改 |
 * | 同名不覆蓋 | 第 3 條 |
 * | 複製章節：manifest 同步；草稿與細綱**不跟**（⚑） | 副本是一章新的（第 8 條：按路徑認細綱，舊細綱不冒認）；草稿是作者對原章的筆記 |
 * | 複製細綱：去掉定稿那一側的指紋（`writtenFrom` / `sourceHash` / `cast`），`upstreamHash` 原樣不重新整理，換了章號就去掉 | 第 18 條：副本沒寫過、沒定稿過；上游指紋不該被複制順手重新整理成新鮮 |
 * | 位元組原樣（GBK、二進位制都不轉碼），不存歷史版本 | 複製不是「讀出來再寫一份」；沒覆蓋任何東西 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（沒拋）';
}

const bytes = (rel) => fs.readFileSync(t.rel(rel));

/** 一份定稿過的細綱（frontmatter 帶齊三環指紋與出場）。 */
function finalizedPlot(no, title, { upstreamHash, writtenFrom, sourceHash }) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    `upstreamHash: ${upstreamHash}`,
    `writtenFrom: ${writtenFrom}`,
    `sourceHash: ${sourceHash}`,
    'cast: [林昭, 老周]',
    'preflightOk: [老周：回憶裡的一場]',
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 梗概',
    '',
    `${title}的計劃。`,
    '',
    '## 出場人物',
    '',
    '林昭、老周',
    '',
    '## 關鍵事件',
    '',
    '- 林昭回到鎮上',
    '',
  ].join('\n');
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    ws: './src/core/workspace/index.ts',
    projectFiles: './src/core/files/projectFiles.ts',
    pipe: './src/core/views/pipeline.ts',
    cast: './src/core/views/cast.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wscopy', title: '複製測試' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  t.write('notes/備忘.txt', '隨便記的。\n');
  t.write('.novelwarden/sessions/會話甲.json', '{"id":"會話甲"}\n');
  t.write('.novelwarden/novelwarden.db', 'SQLite format 3\0');
  t.write('.novelwarden/.trash/chapters/009-刪過的.md', '# 刪過的\n\n找回來的那一章。\n');
  t.write('.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt', '舊稿\n');
  fs.mkdirSync(t.rel('archive'), { recursive: true });
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

// ---------------------------------------------------------------- 複製進受保護的地方

describe('貼上（複製）進回收站、會話目錄、歷史版本：一律拒絕', () => {
  const cases = [
    ['回收站根', '.novelwarden/.trash', '.novelwarden/.trash/備忘.txt'],
    ['回收站裡的子目錄', '.novelwarden/.trash/chapters', '.novelwarden/.trash/chapters/備忘.txt'],
    ['會話目錄', '.novelwarden/sessions', '.novelwarden/sessions/備忘.txt'],
    ['歷史版本根', '.novelwarden/history', '.novelwarden/history/備忘.txt'],
    ['歷史版本裡某份檔案的快照目錄', '.novelwarden/history/chapters/001-楔子.md', '.novelwarden/history/chapters/001-楔子.md/備忘.txt'],
  ];
  const results = {};
  let dirIntoTrash;
  let toastsAfter;

  before(async () => {
    h.expect();
    for (const [name, dest] of cases) {
      results[name] = (await bundle.projectFiles.copyInto(project, ['notes/備忘.txt'], dest))[0];
    }
    // 整個目錄複製進回收站。
    dirIntoTrash = (await bundle.projectFiles.copyInto(project, ['notes'], '.novelwarden/.trash'))[0];
    toastsAfter = [...h.toasts];
  });

  for (const [name, , landed] of cases) {
    test(`${name}：拒絕，沒有落下檔案`, () => {
      assert.equal(results[name].ok, false, JSON.stringify(results[name]));
      assert.equal(t.has(landed), false, landed);
    });
  }

  test('整個目錄複製進回收站：拒絕，一個檔案都沒建', () => {
    assert.equal(dirIntoTrash.ok, false, JSON.stringify(dirIntoTrash));
    assert.equal(t.has('.novelwarden/.trash/notes'), false);
  });

  test('拒絕的原因說得出來（回收站 / 內部檔案 / 歷史版本）', () => {
    assert.match(results['回收站根'].error, /回收站/);
    assert.match(results['會話目錄'].error, /內部檔案/);
    assert.match(results['歷史版本根'].error, /歷史版本/);
  });

  test('toast 報了沒複製成', () => {
    assert.ok(toastsAfter.some((x) => x.startsWith('error:') && x.includes('未複製')), toastsAfter.join(' | '));
  });

  test('閘道器直接調也一樣：copy 到這幾處拋守衛的錯', async () => {
    assert.equal(await codeOf(() => ws.copy('notes/備忘.txt', '.novelwarden/.trash/x.txt')), 'inTrash');
    assert.equal(await codeOf(() => ws.copy('notes/備忘.txt', '.novelwarden/sessions/x.json')), 'protected');
    assert.equal(await codeOf(() => ws.copy('notes/備忘.txt', '.novelwarden/history/x.txt')), 'inHistory');
    assert.equal(await codeOf(() => ws.copy('notes/備忘.txt', '.novelwarden/novelwarden.db-wal')), 'protected');
  });
});

// ---------------------------------------------------------------- 從受保護的地方複製出來

describe('從受保護的地方複製出來', () => {
  let fromTrash;
  let fromHistory;
  let fromSession;
  let fromDb;
  let fromSessionsDir;
  let manifestFiles;

  before(async () => {
    fromTrash = (await bundle.projectFiles.copyInto(project, ['.novelwarden/.trash/chapters/009-刪過的.md'], 'chapters'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);
    fromHistory = (
      await bundle.projectFiles.copyInto(project, ['.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt'], 'notes')
    )[0];
    fromSession = (await bundle.projectFiles.copyInto(project, ['.novelwarden/sessions/會話甲.json'], 'notes'))[0];
    fromDb = (await bundle.projectFiles.copyInto(project, ['.novelwarden/novelwarden.db'], 'notes'))[0];
    fromSessionsDir = (await bundle.projectFiles.copyInto(project, ['.novelwarden/sessions'], 'notes'))[0];
  });

  test('⚑ 回收站裡的一章複製得出來（找回一份），回收站裡那份一字不動', () => {
    assert.equal(fromTrash.ok, true, JSON.stringify(fromTrash));
    assert.equal(t.read('chapters/009-刪過的.md'), '# 刪過的\n\n找回來的那一章。\n');
    assert.equal(t.read('.novelwarden/.trash/chapters/009-刪過的.md'), '# 刪過的\n\n找回來的那一章。\n');
  });

  test('找回進 chapters/ 的那一章進了 manifest', () => {
    assert.ok(manifestFiles.includes('chapters/009-刪過的.md'), JSON.stringify(manifestFiles));
  });

  test('⚑ 歷史版本裡的一份快照複製得出來，快照本身一字不動', () => {
    assert.equal(fromHistory.ok, true, JSON.stringify(fromHistory));
    assert.equal(t.read('notes/2026-10-18_14-32-05+0800.txt'), '舊稿\n');
    assert.equal(t.read('.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt'), '舊稿\n');
  });

  test('會話檔案複製不出來（內部檔案）', () => {
    assert.equal(fromSession.ok, false, JSON.stringify(fromSession));
    assert.equal(t.has('notes/會話甲.json'), false);
  });

  test('工程庫複製不出來（內部檔案）', () => {
    assert.equal(fromDb.ok, false, JSON.stringify(fromDb));
    assert.equal(t.has('notes/novelwarden.db'), false);
  });

  test('整個會話目錄複製不出來（固定目錄）', () => {
    assert.equal(fromSessionsDir.ok, false, JSON.stringify(fromSessionsDir));
    assert.equal(t.has('notes/sessions'), false);
  });
});

// ---------------------------------------------------------------- 同名不覆蓋

describe('同名不覆蓋（第 3 條）', () => {
  let sameDir;
  let clash;
  let wsClash;

  before(async () => {
    t.write('archive/備忘.txt', '先來的，不能被蓋掉。\n');
    project.invalidate();
    sameDir = (await bundle.projectFiles.copyInto(project, ['notes/備忘.txt'], 'notes'))[0];
    clash = (await bundle.projectFiles.copyInto(project, ['notes/備忘.txt'], 'archive'))[0];
    wsClash = await codeOf(() => ws.copy('notes/備忘.txt', 'archive/備忘.txt'));
  });

  test('貼上回原目錄：拒絕（已經在這個目錄裡），不加序號另起一份', () => {
    assert.equal(sameDir.ok, false, JSON.stringify(sameDir));
    assert.deepEqual(fs.readdirSync(t.rel('notes')).filter((n) => n.startsWith('備忘')), ['備忘.txt']);
  });

  test('目標已有同名：拒絕並說同名，已有那份一字不動', () => {
    assert.equal(clash.ok, false, JSON.stringify(clash));
    assert.match(clash.error, /同名/);
    assert.equal(t.read('archive/備忘.txt'), '先來的，不能被蓋掉。\n');
  });

  test('閘道器直接調：exists', () => {
    assert.equal(wsClash, 'exists');
  });

  test('目錄不能複製進自己裡面', async () => {
    fs.mkdirSync(t.rel('notes/子目錄'), { recursive: true });
    assert.equal(await codeOf(() => ws.copy('notes', 'notes/子目錄/notes')), 'intoSelf');
    assert.equal(t.has('notes/子目錄/notes'), false);
  });

  test('固定目錄不能整個複製', async () => {
    assert.equal(await codeOf(() => ws.copy('chapters', 'archive/chapters')), 'protected');
  });
});

// ---------------------------------------------------------------- 複製章節

describe('複製一章正文', () => {
  const CH = 'chapters/第一卷/003-夜访.md';
  const BODY = '# 夜訪\n\n夜裡有人敲門，三下，停一停，又是兩下。\n';
  const DRAFT = 'drafts/第一卷/003-夜访.md';
  const PLOT = '.novelwarden/summaries/第一卷/003-夜访.md';
  let plotBefore;
  let castBefore;
  let result;
  let manifestFiles;
  let castAfter;

  before(async () => {
    t.write(CH, BODY);
    t.write(DRAFT, '# 夜訪 · 草稿\n\n作者對原章的筆記。\n');
    project.invalidate();
    const chapter = (await project.listChapters()).find((c) => c.relPath === CH);
    t.write(PLOT, finalizedPlot(3, '夜訪', { upstreamHash: 'aaaaaaaaaaaaaaaa', writtenFrom: 'bbbbbbbbbbbbbbbb', sourceHash: chapter.contentHash }));
    fs.mkdirSync(t.rel('chapters/第二卷'), { recursive: true });
    project.invalidate();
    plotBefore = t.read(PLOT);
    castBefore = (await bundle.cast.buildCastIndex(project)).summaryCount;

    result = (await bundle.projectFiles.copyInto(project, [CH], 'chapters/第二卷'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);
    project.invalidate();
    castAfter = (await bundle.cast.buildCastIndex(project)).summaryCount;
  });

  test('複製出來了，位元組一樣，原章還在', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read('chapters/第二卷/003-夜访.md'), BODY);
    assert.equal(t.read(CH), BODY);
  });

  test('manifest 同步：副本像新建的一章一樣進了索引', () => {
    assert.ok(manifestFiles.includes('chapters/第二卷/003-夜访.md'), JSON.stringify(manifestFiles));
    assert.ok(manifestFiles.includes(CH), JSON.stringify(manifestFiles));
  });

  test('⚑ 細綱不跟著複製（副本是一章新的，舊細綱不冒認），原細綱一字不動', () => {
    assert.equal(t.has('.novelwarden/summaries/第二卷/003-夜访.md'), false);
    assert.equal(t.read(PLOT), plotBefore);
  });

  test('草稿不跟著複製', () => {
    assert.equal(t.has('drafts/第二卷/003-夜访.md'), false);
  });

  test('副本不算定稿過：出場統計不多數一章（第 14 條）', () => {
    assert.equal(castBefore, 1);
    assert.equal(castAfter, 1);
  });

  test('副本照實是「待定稿」的一章', async () => {
    project.invalidate();
    const stale = (await project.staleChapters()).map((c) => c.relPath);
    assert.ok(stale.includes('chapters/第二卷/003-夜访.md'), JSON.stringify(stale));
    assert.ok(!stale.includes(CH), JSON.stringify(stale));
  });

  test('沒覆蓋任何東西，不存歷史版本', () => {
    assert.equal(t.has('.novelwarden/history/chapters/第二卷'), false);
  });
});

// ---------------------------------------------------------------- 複製細綱

describe('複製一份細綱：指紋不帶著把副本標成新鮮或定稿過（第 18 條）', () => {
  const PLOT = '.novelwarden/summaries/005-回鄉.md';
  const STALE_UP = 'deadbeefdeadbeef';
  let original;
  let origPlot;
  let result;
  let copy;
  let copyText;
  let currentUp;
  let pipeOriginal;
  let pipeCopy;

  before(async () => {
    // 梗概（大綱裡這一章那一條）在這份細綱之後改過：原件掛著 ⟳（upstreamHash 對不上此刻梗概的指紋）。
    t.write(PLOT, finalizedPlot(5, '回鄉', { upstreamHash: STALE_UP, writtenFrom: '1111111111111111', sourceHash: '2222222222222222' }));
    fs.mkdirSync(t.rel('.novelwarden/summaries/備份'), { recursive: true });
    project.invalidate();
    original = t.read(PLOT);
    currentUp = bundle.plotFile.plotSynopsisHash((await project.readPlot(PLOT)).sections.梗概);

    result = (await bundle.projectFiles.copyInto(project, [PLOT], '.novelwarden/summaries/備份'))[0];
    project.invalidate();
    copyText = t.read('.novelwarden/summaries/備份/005-回鄉.md');
    copy = await project.readPlot('.novelwarden/summaries/備份/005-回鄉.md');
    origPlot = await project.readPlot(PLOT);
    pipeOriginal = await bundle.pipe.buildPlotPipeline(project, { no: 5, plot: origPlot });
    pipeCopy = await bundle.pipe.buildPlotPipeline(project, { no: 5, plot: copy });
  });

  test('複製出來了，原件一字不動', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read(PLOT), original);
  });

  test('定稿那一側的指紋去掉了：writtenFrom / sourceHash / cast', () => {
    assert.equal(copy.writtenFrom, '');
    assert.equal(copy.sourceHash, '');
    assert.doesNotMatch(copyText, /^(writtenFrom|sourceHash|cast):/m);
  });

  test('upstreamHash 原樣留著，沒被重新整理成此刻梗概的指紋', () => {
    assert.notEqual(currentUp, STALE_UP);
    assert.equal(copy.upstreamHash, STALE_UP);
  });

  test('所以原件掛 ⟳ 的，副本照樣掛 ⟳（不被複制順手標成新鮮）', () => {
    assert.equal(pipeOriginal.plot.upstreamStale, true);
    assert.equal(pipeCopy.plot.upstreamStale, true);
  });

  test('副本不算定稿過', () => {
    assert.equal(pipeOriginal.summary.exists, true);
    assert.equal(pipeCopy.summary.exists, false);
  });

  test('作者寫的部分原樣：七節、標題、預檢放行', () => {
    assert.deepEqual(copy.sections, origPlot.sections);
    assert.match(copyText, /^title: 回鄉$/m);
    assert.match(copyText, /^preflightOk:/m);
    assert.equal(copyText.slice(copyText.indexOf('# 第5章')), original.slice(original.indexOf('# 第5章')));
  });

  test('閘道器直接複製成另一個章號：上游指紋也去掉（那是另一章了）', async () => {
    await ws.copy(PLOT, '.novelwarden/summaries/備份/007-回鄉.md');
    project.invalidate();
    const renumbered = await project.readPlot('.novelwarden/summaries/備份/007-回鄉.md');
    assert.equal(renumbered.upstreamHash, '');
    assert.equal(renumbered.sourceHash, '');
  });

  test('沒有 frontmatter 的手寫細綱複製過去一字不動（不補指紋）', async () => {
    const HAND = '# 第6章 手寫\n\n## 梗概\n\n作者自己寫的。\n';
    t.write('.novelwarden/summaries/006-手寫.md', HAND);
    await ws.copy('.novelwarden/summaries/006-手寫.md', '.novelwarden/summaries/備份/006-手寫.md');
    assert.equal(t.read('.novelwarden/summaries/備份/006-手寫.md'), HAND);
  });
});

// ---------------------------------------------------------------- 複製目錄

describe('複製整個目錄：逐個檔案過守衛，位元組原樣', () => {
  // 「卷稿」：GBK 編碼的 .txt 章節（第 9 條：章節不認副檔名）、一張圖、一份 markdown 章節。
  const GBK = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // 「你好」+ 換行，GBK
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  let result;
  let manifestFiles;
  let summariesDir;

  before(async () => {
    t.write('卷稿/020-甲.md', '# 甲\n\n第二十章。\n');
    fs.writeFileSync(t.rel('卷稿/021-乙.txt'), GBK);
    fs.mkdirSync(t.rel('卷稿/圖'), { recursive: true });
    fs.writeFileSync(t.rel('卷稿/圖/封面.png'), PNG);
    project.invalidate();
    result = (await bundle.projectFiles.copyInto(project, ['卷稿'], 'chapters'))[0];
    manifestFiles = (await project.readManifest()).chapters.map((c) => c.file);

    // 細綱目錄整個複製：裡面的每一份都去掉定稿那一側的指紋。
    summariesDir = (await bundle.projectFiles.copyInto(project, ['.novelwarden/summaries/第一卷'], '.novelwarden/summaries/備份'))[0];
  });

  test('整棵複製過去', () => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(t.read('chapters/卷稿/020-甲.md'), '# 甲\n\n第二十章。\n');
  });

  test('GBK 的章節、二進位制的圖位元組原樣，不轉碼', () => {
    assert.deepEqual(bytes('chapters/卷稿/021-乙.txt'), GBK);
    assert.deepEqual(bytes('chapters/卷稿/圖/封面.png'), PNG);
  });

  test('複製進 chapters/ 的兩章都進了 manifest', () => {
    assert.ok(manifestFiles.includes('chapters/卷稿/020-甲.md'), JSON.stringify(manifestFiles));
    assert.ok(manifestFiles.includes('chapters/卷稿/021-乙.txt'), JSON.stringify(manifestFiles));
  });

  test('目錄裡的細綱同樣去掉了定稿那一側的指紋', async () => {
    assert.equal(summariesDir.ok, true, JSON.stringify(summariesDir));
    project.invalidate();
    const copied = await project.readPlot('.novelwarden/summaries/備份/第一卷/003-夜访.md');
    assert.equal(copied.sourceHash, '');
    assert.equal(copied.writtenFrom, '');
    assert.equal(copied.upstreamHash, 'aaaaaaaaaaaaaaaa');
  });

  test('閘道器複製會補齊落點的父目錄（與 move 一樣）', async () => {
    await ws.copy('notes/備忘.txt', '新目錄/深處/備忘.txt');
    assert.equal(t.read('新目錄/深處/備忘.txt'), '隨便記的。\n');
  });

  test('符號連結不跟進去，跳過並說出來', { skip: process.platform === 'win32' }, async () => {
    fs.mkdirSync(t.rel('帶連結'), { recursive: true });
    t.write('帶連結/正常.txt', '正常\n');
    fs.symlinkSync('/etc/hostname', t.rel('帶連結/外面'));
    const r = await ws.copy('帶連結', 'archive/帶連結');
    assert.equal(t.read('archive/帶連結/正常.txt'), '正常\n');
    assert.equal(fs.existsSync(t.rel('archive/帶連結/外面')), false);
    assert.ok((r.side ?? []).some((s) => s.includes('外面')), JSON.stringify(r));
  });
});
