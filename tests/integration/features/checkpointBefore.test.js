/**
 * 批次動作之前自動存一個存檔點（`features/checkpoint.ts` 的 `checkpointBefore`，設計見
 * docs/design/plans/2026-10-20-checkpoints.md「自動存檔點」）。真臨時工程 + 假模型。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 與最近一個一模一樣就不另存，改過一份就另存；還不是小說工程給 undefined、不拋 | 多掛幾處沒有代價（⚑10）；絕不擋批次動作 |
 * | 批次寫章：作者點了「開始」才存，正好一個，備註說區間（寫完即定稿另說），存的是動手之前的樣子（新章不在裡面、細綱還沒記 `writtenFrom`） | 整本退得回批次之前 |
 * | 確認框取消、作者不點頭：一個都不存 | 存的是「動手之前」，沒動手就沒有這個點 |
 * | 全書替換：有要換的才存，備註裡的查詢串與替換串截短；一份都沒換成的不存 | 第 3 步之前、有要換的才存 |
 * | 按目錄整理設定、匯入原稿：點頭之後、動手之前存 | 同上 |
 * | 從已寫正文補齊：細綱那一步存過，其餘幾樣不另存；細綱本來就齊的，其餘幾樣那一步自己存 | 同一件事的兩步，退回去就是整件事之前 |
 * | 補齊架構、批次拆細綱、批次展開設定、立即同步、從正文補記敘事線各存一個 | 十處批次動作都掛上了 |
 * | 存不下：照常跑 | ⚑11：存不下不擋批次動作 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir, makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
/** 這一次假模型該答什麼。預設答空（要調模型的那一步就此失敗——存檔點在那之前已經存了）。 */
let replyFn = () => '';
const made = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    plotFile: './src/core/model/plotFile.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    checkpoint: './src/core/features/checkpoint.ts',
    batch: './src/core/features/pipelineBatch.ts',
    bookFind: './src/core/views/bookFind.ts',
    bookReplace: './src/core/features/bookReplace.ts',
    lore: './src/core/features/lore.ts',
    importer: './src/core/features/importManuscript.ts',
    derive: './src/core/features/derive.ts',
    summarize: './src/core/features/summarize.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
      models: ['p/m'],
      concurrency: 1,
    }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages, i) => replyFn(messages, i) });
});

after(() => {
  for (const t of made) cleanup(t.dir, bundle.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix: `cpb-${prefix}`, title: '存檔點' });
  made.push(t);
  fake.reset();
  replyFn = () => '';
  return t;
}

const list = (t) => bundle.checkpoints.listCheckpoints(t.project);
const bytesOf = (t, cp, rel) => bundle.checkpoints.readCheckpointBytes(t.project, cp, rel).then((b) => b.toString('utf8'));

/** 定稿第一步（照正文更新細綱）：有沒有當前細綱，系統提示都以同一句開頭。 */
const isSummary = (messages) => (messages[0]?.content ?? '').includes('建立可檢索的章節檔案');
const isState = (messages) => (messages[0]?.content ?? '').includes('依據本章正文更新角色的「當前狀態」');
const summaryJson = (messages) => {
  const no = Number(/第\s*(\d+)\s*章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
  return JSON.stringify({ 梗概: `第 ${no} 章的事。`, 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [`第 ${no} 章查到一條線索`], 连续性事实: [] });
};

describe('checkpointBefore 本身', () => {
  test('與最近一個一模一樣就不另存；改過一份就另存', async () => {
    const t = await fresh('dedupe');
    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他推開門。\n');
    const a = await bundle.checkpoint.checkpointBefore(t.project, '批次寫章之前（第 1 章）');
    const b = await bundle.checkpoint.checkpointBefore(t.project, '全書替換之前');
    assert.ok(a);
    assert.equal(b, a);
    assert.equal((await list(t)).length, 1);
    assert.equal((await list(t))[0].note, '批次寫章之前（第 1 章）');

    t.write('chapters/001-雨夜.md', '# 雨夜\n\n他慢慢推開門。\n');
    const c = await bundle.checkpoint.checkpointBefore(t.project, '全書替換之前');
    assert.notEqual(c, a);
    const all = await list(t);
    assert.deepEqual(all.map((x) => [x.note, x.auto]), [['全書替換之前', true], ['批次寫章之前（第 1 章）', true]]);
  });

  test('還不是小說工程：給 undefined，不拋、不建目錄', async () => {
    const d = makeTempDir('cpb-bare');
    made.push(d);
    d.write('chapters/001-雨夜.md', '# 雨夜\n');
    const project = bundle.project.NovelProject.open(d.dir);
    assert.equal(await bundle.checkpoint.checkpointBefore(project, '批次寫章之前'), undefined);
    assert.equal(d.has('.novelwarden'), false);
  });
});

// ---------------------------------------------------------------- 批次寫章

const TITLES = ['停舟', '令牌', '夜訪'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;

/** 排好前 3 章細綱（計劃）的工程，還沒有正文。 */
async function plotted(prefix) {
  const t = await fresh(prefix);
  t.write('.novelwarden/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 600\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒\n\n## 當前狀態\n\n（待補充）\n');
  const ws = new bundle.ws.Workspace(t.project);
  for (let no = 1; no <= TITLES.length; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: `第 ${no} 章的目的`,
        出场人物: '林昭',
        关键事件: `第 ${no} 章林昭查到一點東西。`,
        看点: `第 ${no} 章結尾：又一個人不見了。`,
      },
    });
  }
  t.project.invalidate();
  // 寫正文一次寫夠；定稿兩步各給一份。每一次呼叫的正文都不重樣（重演檢測按 n-gram 認）。
  replyFn = (messages, i) => {
    if (isSummary(messages)) return summaryJson(messages);
    if (isState(messages)) return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '往北去了' }] });
    return { text: filler(700, (i + 1) * 100), stop: 'end' };
  };
  return t;
}

describe('批次寫章', () => {
  let t;
  let planBefore;
  before(async () => {
    t = await plotted('write');
    planBefore = t.read(PLOT(1));
  });

  test('確認框上取消：一個都不存', async () => {
    h.expect();
    assert.equal(await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 } }), 0);
    assert.deepEqual(await list(t), []);
  });

  test('點了「開始寫章」：正好一個，備註說區間', async () => {
    h.expect('開始寫章');
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 } });
    assert.equal(calls, 2);
    assert.ok(t.has(CH(1)) && t.has(CH(2)));
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '批次寫章之前（第 1–2 章）');
    assert.equal(all[0].auto, true);
  });

  test('存的是動手之前的樣子：新寫的章不在裡面，細綱還是沒記 writtenFrom 的那一份', async () => {
    const [cp] = await list(t);
    assert.ok(!(CH(1) in cp.files) && !(CH(2) in cp.files), Object.keys(cp.files).join('\n'));
    assert.equal(await bytesOf(t, cp, PLOT(1)), planBefore);
    // 寫完之後磁碟上那一份記了 writtenFrom：與存檔點裡的不一樣了。
    assert.notEqual(t.read(PLOT(1)), planBefore);
  });

  test('寫完即定稿：備註另說；前面寫過的兩章在這一個裡面', async () => {
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 }, mode: 'finalize', call: {} });
    assert.ok(calls >= 2, `呼叫 ${calls} 次`);
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '批次寫章（寫完即同步）之前（第 3 章）');
    assert.ok(CH(1) in all[0].files && CH(2) in all[0].files);
    assert.ok(!(CH(3) in all[0].files));
  });
});

// ---------------------------------------------------------------- 全書替換

describe('全書替換', () => {
  let t;
  before(async () => {
    t = await fresh('replace');
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚推開山門。\n');
    t.write('chapters/002-下山.md', '# 下山\n\n林晚下山去了。\n');
    t.project.invalidate();
  });

  /** 預覽一次，照預覽拼請求（全勾）。 */
  async function request(query, replacement) {
    const q = { query, replacement, scopes: ['chapter'] };
    const preview = await bundle.bookFind.searchBook(t.project, q);
    const files = preview.files.map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.map((x) => ({ start: x.start, end: x.end })) }));
    return { ...q, files, dirty: [] };
  }

  test('有要換的：先存一個，存的是替換之前的那一份', async () => {
    const summary = await bundle.bookReplace.replaceInBook(t.project, await request('林晚', '林婉'));
    assert.equal(summary.files, 2);
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '全書替換之前（「林晚」→「林婉」，2 份）');
    assert.equal(await bytesOf(t, all[0], 'chapters/001-入宗.md'), '# 入宗\n\n林晚推開山門。\n');
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林婉推開山門。\n');
  });

  test('備註裡的查詢串、替換串截短', async () => {
    await bundle.bookReplace.replaceInBook(t.project, await request('林婉', '一個名字特別特別特別長的人物叫這個'));
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '全書替換之前（「林婉」→「一個名字特別特別特別長的…」，2 份）');
  });

  test('一處都沒找到、或預覽之後都改過（一份都換不成）：不存', async () => {
    const none = await bundle.bookReplace.replaceInBook(t.project, await request('不存在的詞', '別的'));
    assert.equal(none.files, 0);
    const req = await request('名字', '稱呼');
    t.write('chapters/001-入宗.md', '# 入宗\n\n別處改過了。\n');
    t.write('chapters/002-下山.md', '# 下山\n\n別處也改過了。\n');
    const stale = await bundle.bookReplace.replaceInBook(t.project, req);
    assert.equal(stale.files, 0);
    assert.equal(stale.skipped.length, 2);
    assert.equal((await list(t)).length, 2);
  });
});

// ---------------------------------------------------------------- 按目錄整理設定

describe('按目錄整理設定', () => {
  let t;
  before(async () => {
    t = await fresh('organize');
    t.write('.novelwarden/lore/過所.md', '---\ntitle: 過所\nkeywords: [過所]\n---\n\n# 過所\n\n出入憑證。\n');
    t.project.invalidate();
  });

  test('作者沒點「照這樣整理」：不存', async () => {
    replyFn = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '過所', to: '制度' }] });
    h.expect('開始', undefined);
    await bundle.lore.organizeLore(t.project, 'unfiled');
    assert.ok(t.has('.novelwarden/lore/過所.md'));
    assert.deepEqual(await list(t), []);
  });

  test('點了：搬之前存一個，裡面是搬家之前的路徑', async () => {
    replyFn = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '過所', to: '制度' }] });
    h.expect('開始', '照這樣整理');
    await bundle.lore.organizeLore(t.project, 'unfiled');
    assert.ok(t.has('.novelwarden/lore/制度/過所.md'));
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '按目錄整理設定之前');
    assert.ok('.novelwarden/lore/過所.md' in all[0].files);
    assert.ok(!('.novelwarden/lore/制度/過所.md' in all[0].files));
  });
});

// ---------------------------------------------------------------- 匯入原稿

describe('匯入原稿', () => {
  const BOOK = ['第一章 入宗', '林昭站在山門前。', '第二章 雪夜', '雪下了一夜。'].join('\n');

  test('沒點「匯入」：不存', async () => {
    const t = await fresh('import-no');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.deepEqual(await list(t), []);
  });

  test('點了：匯入之前存一個，裡面還沒有章節', async () => {
    const t = await fresh('import-ok');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', '匯入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 2);
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '匯入原稿之前');
    assert.deepEqual(Object.keys(all[0].files).filter((p) => p.startsWith('chapters/')), []);
  });
});

// ---------------------------------------------------------------- 從已寫正文補齊

describe('從已寫正文補齊', () => {
  let t;
  before(async () => {
    t = await fresh('derive');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 7)}\n`);
    t.project.invalidate();
  });

  // 細綱那一步照正文寫細綱；其餘幾樣（先是小說配置）答空，就此失敗——存檔點在那之前已經存了（或沒存）。
  test('細綱那一步存過：其餘幾樣接著做，不另存', async () => {
    replyFn = (messages) => (isSummary(messages) ? summaryJson(messages) : '');
    h.expect('先整理細綱', '10', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
    assert.ok(t.has('.novelwarden/summaries/001-入宗.md'));
    assert.ok(h.confirms.some((c) => c.actions.includes('開始補齊')), '其餘幾樣那一步沒走到');
    assert.ok(fake.calls.some((m) => !isSummary(m)), '其餘幾樣沒調到模型（沒進任務）');
    const all = await list(t);
    assert.equal(all.length, 1);
    assert.equal(all[0].note, '從已寫正文補齊之前');
    assert.ok(!('.novelwarden/summaries/001-入宗.md' in all[0].files));
  });

  test('細綱本來就齊：其餘幾樣那一步自己存一個', async () => {
    h.expect('10', '開始補齊');
    await bundle.derive.deriveFromText(t.project);
    const all = await list(t);
    assert.equal(all.length, 2);
    assert.equal(all[0].note, '從已寫正文補齊之前');
    assert.ok('.novelwarden/summaries/001-入宗.md' in all[0].files);
  });
});

// ---------------------------------------------------------------- 其餘幾處

describe('補齊架構、批次拆細綱、批次展開設定、立即同步、從正文補記敘事線', () => {
  test('補齊架構', async () => {
    const t = await fresh('settings');
    t.write('.novelwarden/config.md', t.read('.novelwarden/config.md').replace(/## 一句話\n\n（待補充）/, '## 一句話\n\n少年揹著舊案入宗'));
    t.project.invalidate();
    h.expect('開始補齊');
    await bundle.batch.completeSettings(t.project);
    assert.deepEqual((await list(t)).map((x) => x.note), ['補齊架構之前']);
  });

  test('批次拆細綱', async () => {
    const t = await fresh('plots');
    writeOutline(t, outlineOf(5, { text: { 1: '林昭入宗查舊案。' } }));
    t.project.invalidate();
    h.expect('開始拆細綱');
    await bundle.batch.generatePlots(t.project, { range: { from: 1, to: 3 } });
    assert.deepEqual((await list(t)).map((x) => x.note), ['批次拆細綱之前（第 1–3 章）']);
  });

  test('批次展開設定', async () => {
    const t = await fresh('expand');
    t.write('.novelwarden/lore/過所.md', '---\ntitle: 過所\nkeywords: [過所]\n---\n\n# 過所\n');
    t.project.invalidate();
    h.expect('開始展開');
    await bundle.lore.expandLoreEntries(t.project, ['.novelwarden/lore/過所.md']);
    assert.ok(h.confirms.some((c) => c.actions.includes('開始展開')), '這一條不算能展開的');
    assert.deepEqual((await list(t)).map((x) => x.note), ['展開設定之前（1 條）']);
  });

  test('立即同步', async () => {
    const t = await fresh('sync');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 3)}\n`);
    t.write('chapters/002-雪夜.md', `# 雪夜\n\n${filler(300, 5)}\n`);
    t.project.invalidate();
    replyFn = (messages) => (isSummary(messages) ? summaryJson(messages) : '');
    h.expect('開始同步');
    await bundle.summarize.syncSummaries(t.project);
    assert.deepEqual((await list(t)).map((x) => x.note), ['同步章節細綱之前（2 章）']);
  });

  test('從正文補記敘事線（合併存檔點時補上的第十處）', async () => {
    const t = await fresh('backfill');
    t.write('chapters/001-入宗.md', `# 入宗\n\n${filler(300, 3)}\n`);
    t.write('chapters/002-雪夜.md', `# 雪夜\n\n${filler(300, 5)}\n`);
    t.write('.novelwarden/threads/青崖舊案.md', '---\nkind: 主線\n---\n\n# 青崖舊案\n\n## 意圖\n查清七年前那場火。\n');
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    for (const c of chapters) {
      const rel = `.novelwarden/summaries/${c.relPath.replace(/^chapters\//, '')}`;
      t.write(rel, `---\nno: ${c.order}\ntitle: ${c.title}\nsourceHash: ${c.contentHash}\n---\n\n# ${c.title}\n\n## 梗概\n第 ${c.order} 章。\n`);
    }
    t.project.invalidate();
    h.expect('開始補記');
    await bundle.backfill.backfillThreads(t.project);
    const notes = (await list(t)).map((x) => x.note);
    assert.equal(notes.length, 1, '點了「開始補記」正好存一個（認事件答空、第 1 章就停，存檔點在那之前已經存了）');
    assert.match(notes[0], /^從正文補記敘事線之前（.*第 1.*2 章.*）$/);
  });
});

// ---------------------------------------------------------------- 存不下

describe('存不下不擋批次動作（⚑11）', () => {
  test('存檔點的目錄被一份檔案佔著：照樣替換', async () => {
    const t = await fresh('blocked');
    t.write('chapters/001-入宗.md', '# 入宗\n\n林晚推開山門。\n');
    fs.writeFileSync(t.rel('.novelwarden/checkpoints'), '不是目錄');
    t.project.invalidate();
    const q = { query: '林晚', replacement: '林婉', scopes: ['chapter'] };
    const preview = await bundle.bookFind.searchBook(t.project, q);
    const files = preview.files.map((f) => ({ path: f.path, hash: f.hash, hits: f.hits.map((x) => ({ start: x.start, end: x.end })) }));
    const summary = await bundle.bookReplace.replaceInBook(t.project, { ...q, files, dirty: [] });
    assert.equal(summary.files, 1);
    assert.equal(t.read('chapters/001-入宗.md'), '# 入宗\n\n林婉推開山門。\n');
    assert.deepEqual(await list(t), []);
  });
});
