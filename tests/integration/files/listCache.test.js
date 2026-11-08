/**
 * 章節與細綱兩份列表快取的併發語義。
 *
 * 兩者都會讀**每一份檔案**（章節要算字數與 contentHash，細綱要解析七個小節），
 * 所以它們是全書重新整理裡最貴的兩步，快取不是錦上添花。但快取只在掃完之後才填得上，
 * 於是有兩條容易長回來的坑：
 *
 * 1. **併發擊穿**——兩個呼叫方同時進來都看到空快取，各掃一遍全書。
 *    `buildProjectTree` 的 `Promise.all` 正是這個形狀。
 * 2. **過期回填**——掃到一半作者改了檔案（`invalidate()`），掃描卻在結束時
 *    把變更之前的結果寫進快取，之後所有人都讀到舊資料，直到下一次 invalidate。
 *
 * 兩條都不會拋錯、不會變紅：第一條只是慢，第二條只是介面上的字數與「過期」
 * 標記停在上一版。只能靠斷言守。
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 細綱的寫入搬進了 `core/workspace/`：寫入要記上游指紋、刪除要進 `.trash/`，
 * 那些是閘道器的活。`NovelProject` 這一層只留領域查詢。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

/** 造多少份細綱。與章節數分開，斷言裡就看得出讀的是哪一批。 */
const PLOTS = 7;

let bundle;
let t;
let project;

/** 本輪讀了多少個章節正文檔案。 */
let chapterReads;
/** 本輪讀了多少個細綱檔案。 */
let plotReads;
let restore;

before(async () => {
  const original = fsp.readFile;
  restore = () => {
    fsp.readFile = original;
  };
  fsp.readFile = async (...args) => {
    const p = String(args[0]).replace(/\\/g, '/');
    if (p.includes('/chapters/')) {
      chapterReads++;
    } else if (p.includes('/.novelwarden/summaries/')) {
      plotReads++;
    }
    return original.apply(fsp, args);
  };

  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
  });

  wsMod = bundle.ws;
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'chapter-cache', title: '快取' });
  project = t.project;

  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(3, '0');
    t.write(`chapters/${n}-第${i}章.md`, `# 第${i}章\n\n${'正文。'.repeat(20)}`);
  }
  for (let i = 1; i <= PLOTS; i++) {
    const n = String(i).padStart(3, '0');
    t.write(`.novelwarden/summaries/${n}-第${i}章.md`, `---\nno: ${i}\n---\n\n## 關鍵事件\n事件。\n`);
  }
});

after(() => {
  if (restore) restore();
  if (t) cleanup(t.dir);
});

beforeEach(() => {
  project.invalidate();
  chapterReads = 0;
  plotReads = 0;
});

describe('章節列表快取', () => {
  test('序列的第二次呼叫不讀盤', async () => {
    await project.listChapters();
    const afterFirst = chapterReads;
    await project.listChapters();
    assert.equal(chapterReads, afterFirst, '第二次應當直接命中快取');
  });

  test('併發的兩次呼叫只掃一遍全書', async () => {
    const [a, b] = await Promise.all([project.listChapters(), project.listChapters()]);
    assert.equal(chapterReads, 12, `併發時讀了 ${chapterReads} 個正文檔案，應當只讀 12 個`);
    // 搭同一班車，拿到的自然是同一份結果。
    assert.equal(a, b);
  });

  test('併發呼叫拿到的內容與序列一致', async () => {
    const [concurrent] = await Promise.all([project.listChapters(), project.listChapters()]);
    project.invalidate();
    const serial = await project.listChapters();
    assert.deepEqual(
      concurrent.map((c) => c.relPath),
      serial.map((c) => c.relPath)
    );
  });

  test('invalidate 之後重新讀盤', async () => {
    await project.listChapters();
    project.invalidate();
    chapterReads = 0;
    await project.listChapters();
    assert.equal(chapterReads, 12, '失效之後應當重新掃一遍');
  });

  test('掃描途中 invalidate：新的呼叫方不搭舊車', async () => {
    const inFlight = project.listChapters();
    project.invalidate();
    // 變更之後進來的人必須自己再掃一遍，否則拿到的是變更之前的全書。
    // 兩輪各讀 12 個檔案：在途那一輪的讀盤也落在計數清零之後，所以是 24 而不是 12
    // ——關鍵在於它確實是**兩輪**，而不是第二個呼叫方搭了第一輪的車。
    chapterReads = 0;
    const [before, after] = await Promise.all([inFlight, project.listChapters()]);
    assert.equal(chapterReads, 24, `讀了 ${chapterReads} 個檔案，兩輪獨立掃描應當是 24 個`);
    assert.notEqual(before, after, 'invalidate 之後的呼叫不該複用在途那一輪的結果');
  });

  test('掃描途中 invalidate：舊結果不回填快取', async () => {
    const inFlight = project.listChapters();
    project.invalidate();
    await inFlight;
    // 新增一章。若剛才那輪把舊列表寫進了快取，這裡就會讀到 12 章。
    t.write('chapters/013-新章.md', '# 第13章\n\n新寫的。');
    try {
      const chapters = await project.listChapters();
      assert.equal(chapters.length, 13, '快取裡應當沒有那份過期結果');
    } finally {
      t.remove('chapters/013-新章.md');
      project.invalidate();
    }
  });
});

/**
 * 細綱列表快取。與章節那一份同構，但它是**更熱的那條路**：
 * 流水線索引與出場索引在同一次 `buildProjectTree` 裡都要 `listPlots()`，
 * 不共享的話每次重新整理都把 `summaries/` 裡的細綱整個讀兩遍。
 *
 * 另外多一條章節沒有的約束：`writePlot` / `deletePlot` 自己會寫盤，
 * **它們必須讓快取失效**——否則新建的章不出現在工程頁上，改過標題的章
 * 還掛著舊名字，而這兩件事都不會報錯。
 */
describe('細綱列表快取', () => {
  test('序列的第二次呼叫不讀盤', async () => {
    await project.listPlots();
    const afterFirst = plotReads;
    await project.listPlots();
    assert.equal(plotReads, afterFirst, '第二次應當直接命中快取');
  });

  test('併發的兩次呼叫只掃一遍', async () => {
    const [a, b] = await Promise.all([project.listPlots(), project.listPlots()]);
    assert.equal(plotReads, PLOTS, `併發時讀了 ${plotReads} 個細綱檔案，應當只讀 ${PLOTS} 個`);
    assert.equal(a, b);
  });

  test('invalidate 之後重新讀盤', async () => {
    await project.listPlots();
    project.invalidate();
    plotReads = 0;
    await project.listPlots();
    assert.equal(plotReads, PLOTS, '失效之後應當重新掃一遍');
  });

  test('掃描途中 invalidate：舊結果不回填快取', async () => {
    const inFlight = project.listPlots();
    project.invalidate();
    await inFlight;
    t.write('.novelwarden/summaries/013-新章.md', '---\nno: 13\n---\n\n## 關鍵事件\n新排的。\n');
    try {
      const plots = await project.listPlots();
      assert.equal(plots.length, PLOTS + 1, '快取裡應當沒有那份過期結果');
    } finally {
      t.remove('.novelwarden/summaries/013-新章.md');
      project.invalidate();
    }
  });

  // 寫盤的那兩條路自己失效快取，呼叫方不必記得調 invalidate()。
  test('writePlot 之後讀得到新的一章', async () => {
    await project.listPlots();
    try {
      await wsOf(project).writePlot({ no: 99, title: '新寫的', sections: { 关键事件: '事件' } });
      const plots = await project.listPlots();
      assert.ok(plots.some((p) => p.no === 99), plots.map((p) => p.no).join('|'));
    } finally {
      t.remove('.novelwarden/summaries/099-新寫的.md');
      project.invalidate();
    }
  });

  test('改標題之後讀到的是新檔名', async () => {
    try {
      await wsOf(project).writePlot({ no: 99, title: '初名', sections: { 关键事件: '事件' } });
      await project.listPlots();
      await wsOf(project).writePlot({ no: 99, title: '改過的名字', sections: { 关键事件: '事件' } });
      const found = (await project.listPlots()).find((p) => p.no === 99);
      assert.equal(found?.relPath, '.novelwarden/summaries/099-改過的名字.md', found?.relPath);
    } finally {
      t.remove('.novelwarden/summaries/099-改過的名字.md');
      project.invalidate();
    }
  });

  test('deletePlot 之後讀不到了', async () => {
    await wsOf(project).writePlot({ no: 99, title: '待刪', sections: { 关键事件: '事件' } });
    await project.listPlots();
    await wsOf(project).deletePlot('.novelwarden/summaries/099-待刪.md');
    const plots = await project.listPlots();
    assert.ok(!plots.some((p) => p.no === 99), plots.map((p) => p.no).join('|'));
  });
});
