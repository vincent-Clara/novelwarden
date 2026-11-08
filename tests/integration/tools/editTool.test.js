/**
 * `edit` 工具：定點替換。
 *
 * 五件事：
 *
 * 1. **唯一才改**——命中多處且沒給 all 時報錯，且錯誤裡說清幾處。
 * 2. **找不到時指路「先 read 一遍」**，否則模型會把同一個 old 再發一遍。
 * 3. **守衛照舊**：越界、回收站一條都不放行。
 * 4. **記賬照舊**：改一份細綱照樣記 upstreamHash（`ws.edit` 走的是 `write`）。
 * 5. **指紋鏈不斷**：改細綱只動小節文字，正文落盤時記在細綱 frontmatter 上的 `writtenFrom`
 *    原樣留著——於是改過細綱之後，同號那一章的正文如實掛 ⟳（細綱在正文之後改過）。
 *    定稿記的 `sourceHash` 也在同一份 frontmatter 裡，同樣原樣留著：定稿過的章只掛 ⟳，不被拉回。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

let bundle;
let t;
let project;
let h;
let ctx;

const PLOT_REL = '.novelwarden/summaries/001-夜入青雲.md';
const CHAPTER_REL = 'chapters/001-夜入青雲.txt';
const NOTE_REL = '.novelwarden/lore/門派.md';

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'edit');
const run = (args) => tool().run(ctx, args);

function resetCtx() {
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    views: './src/core/views/projectView.ts',
    tools: './src/core/tools/novel/index.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });

  h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'agentedit', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.write(
    project.relPath(project.outlinePath),
    { text: outlineOf(20, { title: '大綱', text: { 1: '林昭入宗。' } }) },
    { mode: 'overwrite' }
  );
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      梗概: '進入宗門',
      出场人物: '林昭',
      关键事件: '林昭踩點，林昭失手，最後翻牆進去。',
      看点: '第三塊令牌',
    },
  });
  await ws.write(NOTE_REL, { text: '# 門派\n\n青雲宗在北境。\n' }, { mode: 'create' });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('唯一命中就改', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: NOTE_REL, old: '北境', new: '南嶺' });
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('檔案真的改了', async () => {
    const file = await ctx.workspace.read(NOTE_REL);
    assert.ok(file.text.includes('南嶺'), file.text);
    assert.ok(!file.text.includes('北境'), file.text);
  });

  test('返回文字說了替換幾處、改的是哪份', () => {
    assert.ok(r.text.includes('1 處'), r.text);
    assert.ok(r.text.includes(NOTE_REL), r.text);
  });

  test('display 給介面畫一行', () => {
    assert.ok(r.display && r.display.title.includes('edit'), JSON.stringify(r.display));
  });
});

describe('命中多處', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: PLOT_REL, old: '林昭', new: '林昀' });
  });

  test('沒給 all 就報錯', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 「出場人物」一節裡也有一個「林昭」，所以是 3 處——編輯按整份檔案的原文算，
  // 不是隻看「關鍵事件」那一節。
  test('錯誤裡說清了命中幾處', () => {
    assert.ok(r.error.includes('3 處'), r.error);
  });

  test('錯誤裡給了兩條出路（寫長一點 / all=true）', () => {
    assert.ok(r.error.includes('all=true'), r.error);
  });

  test('一個字都沒改', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昭踩點'), plot.sections.关键事件);
  });

  test('給了 all=true 就全換', async () => {
    resetCtx();
    const ok = await run({ path: PLOT_REL, old: '林昭', new: '林昀', all: true });
    assert.equal(ok.error, undefined, ok.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(!plot.sections.关键事件.includes('林昭'), plot.sections.关键事件);
  });

  // 一期把記賬下沉到寫入路徑本身：edit 也走 write，所以指紋鏈不會斷。
  test('改完照樣記 upstreamHash', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.upstreamHash, JSON.stringify(plot.upstreamHash));
  });

  test('把 old 寫長一點讓它唯一也行', async () => {
    resetCtx();
    const ok = await run({ path: PLOT_REL, old: '林昀失手', new: '林昀被發現' });
    assert.equal(ok.error, undefined, ok.error);
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昀被發現'), plot.sections.关键事件);
  });
});

/**
 * 細綱 → 正文那一環的指紋記在細綱上（`writtenFrom`，正文落盤時記）。edit 改的是
 * 小節裡的一句話，**frontmatter 裡那條記錄必須原樣留著**：抹掉它，這一章就再也
 * 不會因為細綱改過而掛 ⟳；留著它、而小節變了，正文就如實顯示「與細綱對不上」。
 */
describe('改細綱之後，同號那一章的正文掛 ⟳', () => {
  let before_;
  let after_;
  let writtenFromBefore;

  before(async () => {
    resetCtx();
    const ws = new bundle.ws.Workspace(project);
    // 按當前細綱寫出第 1 章的正文，並像正文落盤那一步一樣記下細綱指紋。
    await ws.createChapter(1, '夜入青雲', '雨下了三天。林昀翻牆進了宗門。');
    const plot = await project.readPlot(PLOT_REL);
    writtenFromBefore = bundle.plotFile.plotContentHash(plot);
    await ws.recordWrittenFrom(PLOT_REL, writtenFromBefore);
    await project.syncManifest();
    before_ = await bundle.views.buildPlotPipelineView(project, PLOT_REL);

    await run({ path: PLOT_REL, old: '最後翻牆進去', new: '最後從後山溜進去' });
    after_ = await bundle.views.buildPlotPipelineView(project, PLOT_REL);
  });

  test('改之前正文不掛 ⟳', () => {
    assert.equal(before_.chapter.upstreamStale, false, JSON.stringify(before_.chapter));
  });

  test('edit 沒抹掉 writtenFrom', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.equal(plot.writtenFrom, writtenFromBefore);
  });

  test('改之後正文掛 ⟳', () => {
    assert.equal(after_.chapter.upstreamStale, true, JSON.stringify(after_.chapter));
  });

  // 狀態機據此說「重寫第 1 章」而不是「定稿」。
  test('狀態機把這一章拉回「待寫正文」', () => {
    assert.equal(after_.stage, 'manuscript', after_.stage);
  });

  test('正文一個字都沒動（編輯細綱不碰章節）', () => {
    assert.ok(t.read(CHAPTER_REL).includes('林昀翻牆進了宗門'), t.read(CHAPTER_REL));
  });
});

/**
 * 細綱與「定稿檔案」現在是同一份檔案：定稿記的 `sourceHash` 就在 edit 要改的那份 frontmatter 裡。
 * edit 只改小節文字，那條記錄必須留著——抹掉它，一章寫完的書會因為作者順手改了一句細綱
 * 退回「待定稿」，再定稿一次就是白花一次模型呼叫。留著它、而小節變了，正文掛 ⟳ 提醒
 * 「定稿之後細綱又改過，正文可能沒跟上」（作者定案 7），這一章仍算寫完（第 18 條）。
 */
describe('改一份定稿過的細綱：正文掛 ⟳，這一章仍算定稿過', () => {
  const FINAL_REL = '.novelwarden/summaries/002-藏書閣.md';
  let sourceHashBefore;
  let after_;

  before(async () => {
    resetCtx();
    const ws = new bundle.ws.Workspace(project);
    await ws.createChapter(2, '藏書閣', '林昀摸進藏書閣，在最底層翻到第三塊令牌。');
    await project.syncManifest();
    const chapter = (await project.listChapters()).find((c) => c.order === 2);
    await ws.finalizePlot(
      chapter,
      {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: '林昀夜探藏書閣。',
        出场人物: '林昀',
        关键事件: '林昀摸進藏書閣，翻到第三塊令牌。',
      },
      [{ name: '林昀', aliases: [] }]
    );
    sourceHashBefore = (await project.readPlot(FINAL_REL)).sourceHash;

    await run({ path: FINAL_REL, old: '翻到第三塊令牌', new: '翻到半塊令牌' });
    after_ = await bundle.views.buildPlotPipelineView(project, FINAL_REL);
  });

  test('定稿前提成立：落盤時記下了 sourceHash', () => {
    assert.ok(sourceHashBefore, JSON.stringify(sourceHashBefore));
  });

  test('edit 沒抹掉定稿記的 sourceHash', async () => {
    const plot = await project.readPlot(FINAL_REL);
    assert.equal(plot.sourceHash, sourceHashBefore);
  });

  test('改之後正文掛 ⟳', () => {
    assert.equal(after_.chapter.upstreamStale, true, JSON.stringify(after_.chapter));
  });

  test('這一章不被拉回，仍是完成', () => {
    assert.equal(after_.stage, 'done', after_.stage);
  });
});

describe('找不到要替換的內容', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ path: PLOT_REL, old: '這段話根本不在檔案裡', new: 'x' });
  });

  test('給 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 只回一句「找不到」，它多半會原地把同一個 old 再發一遍。
  test('指路「先 read 一遍」', () => {
    assert.ok(r.error.includes('read'), r.error);
  });

  test('檔案沒被動過', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(plot.sections.关键事件.includes('林昀被發現'), plot.sections.关键事件);
  });
});

describe('守衛照舊攔著', () => {
  test('越界路徑給 error', async () => {
    resetCtx();
    const r = await run({ path: '../../etc/passwd', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('不存在的檔案給 error 而不是拋', async () => {
    resetCtx();
    const r = await run({ path: '.novelwarden/summaries/999-沒有這一章.md', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('回收站裡的東西改不了', async () => {
    resetCtx();
    const r = await run({ path: '.novelwarden/.trash/x.md', old: 'a', new: 'b' });
    assert.ok(r.error, JSON.stringify(r));
  });
});

describe('引數本身', () => {
  test('path 必填', async () => {
    resetCtx();
    const r = await run({ old: 'a', new: 'b' });
    assert.ok(r.error && r.error.includes('path'), JSON.stringify(r));
  });

  test('old 不能是空串', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '', new: 'b' });
    assert.ok(r.error && r.error.includes('old'), JSON.stringify(r));
  });

  test('new 缺席就 error', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '青雲宗' });
    assert.ok(r.error && r.error.includes('new'), JSON.stringify(r));
  });

  // 刪掉一段是合法的編輯。
  test('new 是空串表示刪掉這一段', async () => {
    resetCtx();
    const r = await run({ path: NOTE_REL, old: '在南嶺', new: '' });
    assert.equal(r.error, undefined, r.error);
    const file = await ctx.workspace.read(NOTE_REL);
    assert.ok(!file.text.includes('南嶺'), file.text);
  });
});

describe('工具定義本身', () => {
  test('標了 mutating', () => {
    assert.equal(tool().mutating, true);
  });

  test('不標 costly（改字不調模型）', () => {
    assert.ok(!tool().costly, String(tool().costly));
  });

  test('引數是扁平的四個標量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['all', 'new', 'old', 'path']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });

  // 不收 edits 陣列：一次一處，出錯時狀態清楚。
  test('不收多處批次編輯', () => {
    assert.ok(!('edits' in tool().parameters.properties), JSON.stringify(tool().parameters.properties));
  });

  test('描述裡說清了 old 要逐字相同且唯一', () => {
    assert.ok(tool().description.includes('唯一'), tool().description);
  });
});
