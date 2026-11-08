/**
 * 工程頁「新建章節檔案」：先問章節名稱，正文建出來的同時配好細綱（`actions.ts` 的 `newChapterFlow`）。
 *
 * - 取消就什麼都不建；留空照舊是純序號名。正文是 `.txt`（2026-10-24），細綱照舊是 `.md`。
 * - 這一章還沒有細綱：在正文的映象位置建一份空骨架，標題就是這個名字，沒有上游指紋，還算「沒拆細綱」。
 * - 這一章已經排好了細綱：名字先填它的標題，正文落進它所在的子目錄，不另建一份；名字改了，細綱跟著新正文改名、
 *   改標題，作者在細綱裡手加的東西一個字不丟。
 *
 * 2026-10-23 作者定案：從前「不問標題、只建 0 字正文」，現在要先問名字、自動建細綱模板。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('新建章節檔案：先問名字、配上細綱', () => {
  let bundle;
  let h;
  let t;
  let project;
  let actions;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      actions: './src/core/actions.ts',
      plotFile: './src/core/model/plotFile.ts',
    });
    actions = bundle.actions;
    h = makeFakeHost();
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'new-chapter', title: '新建章節' });
    project = t.project;
    t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    project.invalidate();
  });

  after(() => cleanup(t.dir));

  describe('取消', () => {
    let result;
    let chapters;
    let plots;

    before(async () => {
      h.expect(undefined);
      result = await actions.newChapterFlow(project);
      project.invalidate();
      chapters = (await project.listChapters()).length;
      plots = (await project.listPlots()).length;
    });

    test('返回 undefined，正文與細綱都沒建', () => {
      assert.equal(result, undefined);
      assert.equal(chapters, 1);
      assert.equal(plots, 0);
    });
  });

  describe('這一章還沒有細綱：建一份空骨架', () => {
    let rel;
    let ask;
    let body;
    let plot;
    let paired;
    let toasts;

    before(async () => {
      h.expect('夜入 青雲');
      rel = await actions.newChapterFlow(project);
      ask = h.inputs[0];
      toasts = [...h.toasts];
      body = t.read(rel);
      project.invalidate();
      plot = await project.readPlot('.novelwarden/summaries/002-夜入-青雲.md');
      paired = (await project.getPlot(2))?.relPath;
    });

    test('先彈「新建第 N 章」，沒有預填', () => {
      assert.equal(ask?.title, '新建第 2 章');
      assert.equal(ask?.value, '');
    });

    // 2026-10-24 作者定：新建章節檔案預設 .txt，純文字不寫標題行（標題從檔名取）。
    test('正文按名字建出來，是 .txt、不帶標題行', () => {
      assert.equal(rel, 'chapters/002-夜入-青雲.txt');
      assert.equal(body, '\n');
    });

    test('細綱建在正文的映象位置，按路徑配得上', () => {
      assert.equal(paired, '.novelwarden/summaries/002-夜入-青雲.md');
    });

    test('細綱的標題與檔名同一份清洗過的名字', () => {
      assert.equal(plot?.title, '夜入-青雲');
    });

    test('是空骨架：沒有上游指紋，還算沒拆細綱', () => {
      assert.equal(plot?.upstreamHash, '');
      assert.equal(bundle.plotFile.isPlotFilled(plot.sections), false);
    });

    test('提示裡報了細綱的路徑', () => {
      assert.ok(toasts.some((x) => x.includes('.novelwarden/summaries/002-夜入-青雲.md')), toasts.join(' | '));
    });
  });

  describe('名字留空：純序號名，細綱也是純序號名', () => {
    let rel;
    let plotRel;

    before(async () => {
      h.expect('');
      rel = await actions.newChapterFlow(project);
      project.invalidate();
      plotRel = (await project.getPlot(3))?.relPath;
    });

    test('正文是純序號名', () => {
      assert.equal(rel, 'chapters/003.txt');
    });

    test('細綱也建了', () => {
      assert.equal(plotRel, '.novelwarden/summaries/003.md');
    });
  });

  describe('這一章已經排好了細綱', () => {
    const PLAN = (no, title) =>
      `---\nno: ${no}\ntitle: ${title}\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n${title}的梗概。\n\n## 作者備註\n\n別忘了伏筆。\n`;
    let same;
    let sameAsk;
    let sameBytes;
    let sameCount;
    let renamed;
    let renamedAsk;
    let renamedPlot;
    let oldGone;

    before(async () => {
      // 正文寫到第 3 章，細綱已經排到了第二卷的第 4、5 章。
      t.write('.novelwarden/summaries/第二卷/004-雪夜.md', PLAN(4, '雪夜'));
      t.write('.novelwarden/summaries/第二卷/005-風起.md', PLAN(5, '風起'));
      project.invalidate();

      h.expect('雪夜');
      same = await actions.newChapterFlow(project);
      sameAsk = h.inputs[0];
      sameBytes = t.read('.novelwarden/summaries/第二卷/004-雪夜.md');
      project.invalidate();
      sameCount = (await project.listPlots()).filter((p) => p.no === 4).length;

      h.expect('夜行');
      renamed = await actions.newChapterFlow(project);
      renamedAsk = h.inputs[0];
      renamedPlot = t.has('.novelwarden/summaries/第二卷/005-夜行.md') ? t.read('.novelwarden/summaries/第二卷/005-夜行.md') : undefined;
      oldGone = !t.has('.novelwarden/summaries/第二卷/005-風起.md');
    });

    test('名字先填了細綱的標題', () => {
      assert.equal(sameAsk?.value, '雪夜');
      assert.equal(renamedAsk?.value, '風起');
    });

    test('正文落進細綱所在的子目錄', () => {
      assert.equal(same, 'chapters/第二卷/004-雪夜.txt');
      assert.equal(renamed, 'chapters/第二卷/005-夜行.txt');
    });

    test('名字沒改：細綱一個位元組不動，也不另建一份', () => {
      assert.equal(sameBytes, PLAN(4, '雪夜'));
      assert.equal(sameCount, 1);
    });

    test('名字改了：細綱跟著新正文改名、改標題', () => {
      assert.ok(oldGone);
      assert.ok(renamedPlot && renamedPlot.includes('title: 夜行') && renamedPlot.includes('# 第5章 夜行'), String(renamedPlot));
    });

    test('細綱裡別的內容原樣留著（梗概、作者手加的小節）', () => {
      assert.ok(renamedPlot.includes('風起的梗概') && renamedPlot.includes('別忘了伏筆'), renamedPlot);
    });
  });
});
