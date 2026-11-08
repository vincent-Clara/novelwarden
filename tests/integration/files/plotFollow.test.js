/**
 * 細綱跟著正文走：細綱映象正文在章節根下的相對路徑（`chapters/第一卷/003-深處.txt` ↔
 * `summaries/第一卷/003-深處.md`），與草稿同一套映象。
 *
 * - 工程頁給正文改名、移動（單章或整個卷目錄）時，細綱一併搬過去（`handlers/chapter.ts` 的 `carryPlot`）；
 *   不搬的話這一章立刻變成「還沒有細綱」，排好的計劃與定稿的檔案都還躺在舊路徑下。
 * - 目標位置已有細綱時不覆蓋，兩份都留著、說出來（第 3 條）；要同步正文 `# 標題` 行的改名乾脆整個不做（寫標題之前
 *   `Workspace.checkMove` 就攔下），不然標題與檔名換了，細綱卻留在舊路徑上。
 * - 刪正文不刪細綱：它退回這一章的計劃。
 * - 照細綱新寫一章正文時，細綱的檔名與新正文對不上（還沒起名時建的 `030.md`）就跟著改名
 *   （`Workspace.createChapterAt`），兩邊從此按路徑認得出彼此。
 *
 * 2026-10-18 作者定案：「必須要保證相對路徑，無相對路徑是絕對錯的」；工程頁裡改名、移動，細綱跟著走。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const PLOT = (no, title, extra = '') =>
  `---\nno: ${no}\ntitle: ${title}\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n${title}的梗概。\n\n## 關鍵事件\n\n- ${title}${extra}\n`;

describe('細綱跟著正文走', () => {
  let bundle;
  let h;
  let t;
  let project;
  let fileOps;
  const wsOf = (p) => new bundle.ws.Workspace(p);

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      ws: './src/core/workspace/index.ts',
      fileOps: './src/core/files/fileOps.ts',
      plotFile: './src/core/model/plotFile.ts',
    });
    fileOps = bundle.fileOps;
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'plot-follow', title: '分卷' });
    project = t.project;
  });

  after(() => cleanup(t.dir));

  describe('改名、移動單章', () => {
    let renamed;
    let renamedPlot;
    let oldPlotGone;
    let moved;
    let movedPlot;
    let txtRenamed;
    let txtPlot;

    before(async () => {
      t.write('chapters/第一卷/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      t.write('.novelwarden/summaries/第一卷/001-楔子.md', PLOT(1, '楔子'));
      t.write('chapters/第一卷/002-手記.txt', '他翻開筆記。\n');
      t.write('.novelwarden/summaries/第一卷/002-手記.md', PLOT(2, '手記'));
      project.invalidate();

      h.expect('入鎮');
      renamed = await fileOps.renameEntry(project, 'chapters/第一卷/001-楔子.md');
      renamedPlot = t.has('.novelwarden/summaries/第一卷/001-入鎮.md') && t.read('.novelwarden/summaries/第一卷/001-入鎮.md');
      oldPlotGone = !t.has('.novelwarden/summaries/第一卷/001-楔子.md');

      fs.mkdirSync(t.rel('chapters/第二卷'), { recursive: true });
      h.expect();
      moved = await fileOps.moveEntry(project, 'chapters/第一卷/001-入鎮.md', 'chapters/第二卷');
      movedPlot = await project.getPlot(1);

      h.expect('舊手記');
      txtRenamed = await fileOps.renameEntry(project, 'chapters/第一卷/002-手記.txt');
      txtPlot = await project.getPlot(2);
    });

    test('正文改了名', () => {
      assert.equal(renamed, 'chapters/第一卷/001-入鎮.md');
    });

    test('細綱跟著改名，內容原樣帶過去', () => {
      assert.ok(renamedPlot && renamedPlot.includes('楔子的梗概'), String(renamedPlot));
    });

    // 工程頁那一行先認細綱的標題：只搬檔案不改標題，改完名那一行還掛著舊名字（2026-10-23 作者提的）。
    test('細綱裡的標題跟著改成新名（frontmatter 與標題行）', () => {
      assert.ok(renamedPlot && renamedPlot.includes('title: 入鎮') && renamedPlot.includes('# 第1章 入鎮'), String(renamedPlot));
      assert.ok(!renamedPlot.includes('title: 楔子'), renamedPlot);
    });

    test('舊位置的細綱不在了，不會一章兩份', () => {
      assert.ok(oldPlotGone);
    });

    test('正文移進另一個卷目錄，細綱跟著進 summaries/ 的同名目錄', () => {
      assert.equal(moved, 'chapters/第二卷/001-入鎮.md');
      assert.equal(movedPlot?.relPath, '.novelwarden/summaries/第二卷/001-入鎮.md');
    });

    test('.txt 正文改名，細綱（.md）也跟著改名', () => {
      assert.equal(txtRenamed, 'chapters/第一卷/002-舊手記.txt');
      assert.equal(txtPlot?.relPath, '.novelwarden/summaries/第一卷/002-舊手記.md');
      assert.equal(txtPlot?.title, '舊手記');
    });
  });

  // 只改標題那兩行，別的一個位元組不動；作者在細綱上另起過的標題不動、說出來；標題不進指紋，改了不掛 ⟳。
  describe('改名時細綱的標題跟著改', () => {
    const KEPT = '---\nno: 50\ntitle: 另起的標題\n---\n\n# 第50章 另起的標題\n\n## 梗概\n\n梗概。\n';
    const NO_FM = '# 第52章 手寫\n\n## 梗概\n\n手寫的。\n\n## 作者備註\n\n別刪我。\n';
    const CRLF = '---\r\nno: 53\r\ntitle: 回車\r\n---\r\n\r\n# 第53章 回車\r\n\r\n## 梗概\r\n\r\n回車的梗概。\r\n';
    let kept;
    let keptToasts;
    let unnamed;
    let noFm;
    let crlf;
    let hashed;
    let writtenFrom;

    before(async () => {
      t.write('chapters/050-舊名.md', '# 舊名\n\n正文\n');
      t.write('.novelwarden/summaries/050-舊名.md', KEPT);
      project.invalidate();
      h.expect('新名');
      await fileOps.renameEntry(project, 'chapters/050-舊名.md');
      kept = t.read('.novelwarden/summaries/050-新名.md');
      keptToasts = [...h.toasts];

      // 純序號名的正文與細綱（新建時名字留空的樣子）：第一次起名，細綱的空標題也填上。
      t.write('chapters/051.md', '正文\n');
      project.invalidate();
      await wsOf(project).writePlot({ no: 51, title: '', upstreamHash: '', done: false, sections: { 梗概: '空著' } });
      h.expect('起名');
      await fileOps.renameEntry(project, 'chapters/051.md');
      unnamed = t.read('.novelwarden/summaries/051-起名.md');

      t.write('chapters/052-手寫.md', '# 手寫\n\n正文\n');
      t.write('.novelwarden/summaries/052-手寫.md', NO_FM);
      project.invalidate();
      h.expect('改過');
      await fileOps.renameEntry(project, 'chapters/052-手寫.md');
      noFm = t.read('.novelwarden/summaries/052-改過.md');

      t.write('chapters/053-回車.txt', '正文\r\n');
      t.write('.novelwarden/summaries/053-回車.md', CRLF);
      project.invalidate();
      h.expect('換行');
      await fileOps.renameEntry(project, 'chapters/053-回車.txt');
      crlf = t.read('.novelwarden/summaries/053-換行.md');

      // 照細綱寫過正文（記著 writtenFrom）：改名之後指紋還對得上，不掛 ⟳。
      t.write('chapters/054-指紋.md', '# 指紋\n\n正文\n');
      t.write('.novelwarden/summaries/054-指紋.md', PLOT(54, '指紋'));
      project.invalidate();
      const before54 = await project.getPlot(54);
      await wsOf(project).recordWrittenFrom(before54.relPath, bundle.plotFile.plotContentHash(before54));
      project.invalidate();
      writtenFrom = (await project.getPlot(54)).writtenFrom;
      h.expect('改指紋');
      await fileOps.renameEntry(project, 'chapters/054-指紋.md');
      project.invalidate();
      const after54 = await project.getPlot(54);
      hashed = { title: after54?.title, writtenFrom: after54?.writtenFrom, now: after54 && bundle.plotFile.plotContentHash(after54) };
    });

    test('作者另起的標題不動，檔案照樣跟著正文搬', () => {
      assert.equal(kept, KEPT);
    });

    test('另起的標題沒跟著改，說出來了', () => {
      assert.ok(keptToasts.some((x) => x.includes('另起的標題') && x.includes('沒跟著改')), keptToasts.join(' | '));
    });

    test('細綱的空標題第一次起名也填上', () => {
      assert.ok(unnamed.includes('title: 起名') && unnamed.includes('# 第51章 起名'), unnamed);
      assert.ok(unnamed.includes('空著'), unnamed);
    });

    test('沒有 frontmatter 的細綱只換標題行、不補 frontmatter，別的原樣', () => {
      assert.equal(noFm, NO_FM.replace('# 第52章 手寫', '# 第52章 改過'));
    });

    test('CRLF 的細綱照樣改，換行不變', () => {
      assert.equal(crlf, CRLF.replace('title: 回車', 'title: 換行').replace('# 第53章 回車', '# 第53章 換行'));
    });

    test('標題不進指紋：改名之後 writtenFrom 還對得上', () => {
      assert.equal(hashed.title, '改指紋');
      assert.ok(writtenFrom);
      assert.equal(hashed.writtenFrom, writtenFrom);
      assert.equal(hashed.now, writtenFrom);
    });
  });

  describe('整個卷目錄一起搬', () => {
    let movedDir;
    let plot;

    before(async () => {
      t.write('chapters/第三卷/010-雪夜.md', '# 雪夜\n\n雪。\n');
      t.write('.novelwarden/summaries/第三卷/010-雪夜.md', PLOT(10, '雪夜'));
      fs.mkdirSync(t.rel('chapters/歸檔'), { recursive: true });
      project.invalidate();
      h.expect();
      movedDir = await fileOps.moveEntry(project, 'chapters/第三卷', 'chapters/歸檔');
      plot = await project.getPlot(10);
    });

    test('卷目錄搬過去了', () => {
      assert.equal(movedDir, 'chapters/歸檔/第三卷');
    });

    test('summaries/ 裡那個卷目錄整棵跟著走', () => {
      assert.equal(plot?.relPath, '.novelwarden/summaries/歸檔/第三卷/010-雪夜.md');
      assert.ok(!t.has('.novelwarden/summaries/第三卷'));
    });
  });

  // 要同步正文 `# 標題` 行的改名（`.md` 正文、標題與舊檔名一致）先寫標題、再搬家：細綱那一側會撞時
  // 寫標題之前就停下，什麼都不動（第 3 條）——不然正文的標題、檔名改了，細綱卻留在舊路徑上。
  describe('目標位置已有細綱時不覆蓋：要同步標題的改名整個不做', () => {
    const CH = 'chapters/020-甲.md';
    const BODY = '# 甲\n\n正文\n';
    const MINE = PLOT(20, '甲');
    const THEIRS = PLOT(20, '乙', '（佔位）');
    let result;
    let body;
    let targetBody;
    let oldPlot;
    let renamedTo;
    let toasts;

    before(async () => {
      t.write(CH, BODY);
      t.write('.novelwarden/summaries/020-甲.md', MINE);
      t.write('.novelwarden/summaries/020-乙.md', THEIRS);
      project.invalidate();
      h.expect('乙');
      result = await fileOps.renameEntry(project, CH);
      body = t.has(CH) ? t.read(CH) : undefined;
      targetBody = t.read('.novelwarden/summaries/020-乙.md');
      oldPlot = t.has('.novelwarden/summaries/020-甲.md') ? t.read('.novelwarden/summaries/020-甲.md') : undefined;
      renamedTo = t.has('chapters/020-乙.md');
      toasts = [...h.toasts];
    });

    test('沒有改名', () => {
      assert.equal(result, undefined);
      assert.equal(renamedTo, false);
    });

    test('正文一字不動（# 標題行沒被改成新名字）', () => {
      assert.equal(body, BODY);
    });

    test('目標細綱沒被蓋掉', () => {
      assert.equal(targetBody, THEIRS);
    });

    test('這一章的細綱原樣留在原處', () => {
      assert.equal(oldPlot, MINE);
    });

    test('說出來了', () => {
      assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('020-乙.md')), toasts.join(' | '));
    });
  });

  // 不同步標題的改名（`.txt` 正文、標題與檔名不一致）行為照舊：正文照樣改名，細綱留在原處並說出來。
  describe('目標位置已有細綱時不覆蓋：不同步標題的改名照舊', () => {
    let targetBody;
    let oldKept;
    let renamed;
    let toasts;

    before(async () => {
      t.write('chapters/021-甲.txt', '正文\n');
      t.write('.novelwarden/summaries/021-甲.md', PLOT(21, '甲'));
      t.write('.novelwarden/summaries/021-乙.md', PLOT(21, '乙', '（佔位）'));
      project.invalidate();
      h.expect('乙');
      renamed = await fileOps.renameEntry(project, 'chapters/021-甲.txt');
      targetBody = t.read('.novelwarden/summaries/021-乙.md');
      oldKept = t.has('.novelwarden/summaries/021-甲.md');
      toasts = [...h.toasts];
    });

    test('正文照樣改名', () => {
      assert.equal(renamed, 'chapters/021-乙.txt');
    });

    test('目標細綱沒被蓋掉', () => {
      assert.ok(targetBody.includes('（佔位）'), targetBody);
    });

    test('舊細綱留在原處', () => {
      assert.ok(oldKept);
    });

    test('說出來了', () => {
      assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('021-乙.md')), toasts.join(' | '));
    });
  });

  describe('刪正文不刪細綱', () => {
    let plotKept;
    let back;

    before(async () => {
      t.write('chapters/030-殘燈.md', '# 殘燈\n\n燈芯燒到了底。\n');
      t.write('.novelwarden/summaries/030-殘燈.md', PLOT(30, '殘燈'));
      project.invalidate();
      h.expect('刪除');
      await fileOps.deleteEntry(project, 'chapters/030-殘燈.md');
      plotKept = t.has('.novelwarden/summaries/030-殘燈.md');
      back = await project.getPlot(30);
    });

    test('細綱還在', () => {
      assert.ok(plotKept);
    });

    test('它退回這一章的計劃（按號認得出）', () => {
      assert.equal(back?.relPath, '.novelwarden/summaries/030-殘燈.md');
    });
  });

  describe('照細綱新寫一章：細綱跟著改名到新正文的映象', () => {
    let rel;
    let plot;

    before(async () => {
      // 還沒起名時建的純序號細綱，後來排出了標題。
      t.write('.novelwarden/summaries/第二卷/040.md', PLOT(40, '冰河'));
      project.invalidate();
      rel = await wsOf(project).createChapterAt('chapters/第二卷/040-冰河.md', '冰面裂了。', '.novelwarden/summaries/第二卷/040.md');
      plot = await project.getPlot(40);
    });

    test('正文落在給定位置，標題行取檔名', () => {
      assert.equal(rel, 'chapters/第二卷/040-冰河.md');
      assert.equal(t.read(rel), '# 冰河\n\n冰面裂了。\n');
    });

    test('細綱改名到新正文的映象，按路徑認得出', () => {
      assert.equal(plot?.relPath, '.novelwarden/summaries/第二卷/040-冰河.md');
      assert.ok(!t.has('.novelwarden/summaries/第二卷/040.md'));
    });
  });
});
