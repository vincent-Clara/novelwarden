/**
 * `pushState` 連流水線條一起推。
 *
 * 從前它只推 state：總結完、在編輯器裡手改了細綱、檔案監聽觸發，流水線條與主按鈕
 * 都停在舊狀態。殼的檔案監聽、編輯器儲存、工程頁動作走的都是 pushState，所以這裡
 * 直接調它，守的是「磁碟變了 → 主按鈕跟著變」這一件事。
 *
 * 一章一綱之後單章狀態機是「細綱 → 正文 → 定稿 → 完成」，這裡把四格各走一遍：
 * 每一格都是磁碟在創作頁之外變了（編輯器裡寫細綱、手貼正文、改細綱、定稿），
 * 主按鈕都得跟上。最後一格還守著「單章做完就轉去問全書」——主按鈕不該在一章做完
 * 之後沉默。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let controller;
let posted;
let ws;

const PLOT = '.novelwarden/summaries/010-夜渡.md';
const CHAPTER = 'chapters/010-夜渡.md';

/** 第 10 章的細綱（七節），判「排過沒有」只看「關鍵事件」。 */
const plot = (sections) => ({
  no: 10, title: '夜渡', upstreamHash: '', done: false,
  sections: { 梗概: '', 出场人物: '', 时间地点: '', 关键事件: '', 看点: '', 状态变更: '', 连续性事实: '', ...sections },
});

/** 調一次 pushState，回收這一輪推出去的最後一份流水線。 */
async function refresh() {
  posted.length = 0;
  await controller.pushState();
  return posted.filter((m) => m.type === 'pipeline').pop();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    controller: './src/core/controller/index.ts',
  });
  const h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'pipelinerefresh', title: '重新整理測試' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);

  // 一份只有「梗概」的細綱：還沒排過，主按鈕該是「寫細綱」。
  await ws.writePlot(plot({ 梗概: '渡河' }));
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
  await controller.handle({ type: 'selectPlot', plotRelPath: PLOT });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('pushState 推流水線條', () => {
  test('推了一份流水線', async () => {
    const pipe = await refresh();
    assert.ok(pipe, '沒推 pipeline');
    assert.equal(pipe.pipeline?.no, 10, JSON.stringify(pipe.pipeline?.no));
  });

  // 只寫了「梗概」不算排過：一句話就能寫，拿它當判據的話空殼會立刻顯示「已規劃」。
  test('還沒排細綱：主按鈕落在細綱層', async () => {
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'plot', JSON.stringify(pipe.next));
  });

  // 模擬作者在編輯器裡把細綱寫好、儲存——磁碟變了，沒有經過創作頁。
  test('細綱在別處寫好之後，主按鈕跟著換到正文', async () => {
    await ws.writePlot(plot({ 梗概: '渡河', 关键事件: '林昭夜渡青河，船到中流翻了。' }));
    const pipe = await refresh();
    assert.equal(pipe.next?.stage, 'manuscript', JSON.stringify(pipe.next));
    assert.equal(pipe.next?.label, '寫第 10 章', JSON.stringify(pipe.next));
  });

  // 正文就落在同號的章節上（沒有中轉站了）。作者手貼進來的一樣算：細綱與配置
  // 都沒寫目標字數，於是「有字就算寫夠」，下一步是定稿。
  test('同號章節在別處寫出正文之後，主按鈕換到定稿', async () => {
    t.write(CHAPTER, '# 夜渡\n\n船到中流，纜繩斷了。\n');
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.chapter.relPath, CHAPTER, JSON.stringify(pipe.pipeline?.chapter));
    assert.equal(pipe.next?.projectAction, 'finalizeChapter', JSON.stringify(pipe.next));
  });

  // 細綱在正文之後改過（在編輯器裡改，走 edit）→ 正文標髒 → 主按鈕換成「重寫」。
  // 前提是這一章記過 writtenFrom：作者手貼的正文沒有這筆賬，永遠不標髒（第 18a 條），
  // 所以先按正文落盤那一步的樣子記一筆。
  test('細綱在正文之後改過，主按鈕換成重寫', async () => {
    const current = await project.readPlot(PLOT);
    await ws.recordWrittenFrom(PLOT, bundle.plotFile.plotContentHash(current));
    const fresh = await refresh();
    assert.equal(fresh.next?.projectAction, 'finalizeChapter', '前提：記完賬這一章仍是待定稿');

    await ws.edit(PLOT, [{ old: '船到中流翻了', new: '船到中流被人鑿穿了' }]);
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.chapter.upstreamStale, true, JSON.stringify(pipe.pipeline?.chapter));
    assert.equal(pipe.next?.label, '重寫第 10 章', JSON.stringify(pipe.next));
  });

  // 定稿（細綱照正文反向更新，sourceHash 對得上正文）之後這一章做完了——主按鈕**轉去問全書**，
  // 而不是沉默。這個工程的架構一件都沒填，全書的下一步是「生成小說配置」。
  test('這一章定稿之後，主按鈕轉去問全書的下一步', async () => {
    const chapter = (await project.listChapters()).find((c) => c.order === 10);
    await ws.finalizePlot(
      chapter,
      { ...plot({}).sections, 梗概: '林昭夜渡青河。', 出场人物: '林昭', 关键事件: '纜繩斷了。' },
      [{ name: '林昭', aliases: [] }]
    );
    const pipe = await refresh();
    assert.equal(pipe.pipeline?.stage, 'done', JSON.stringify(pipe.pipeline?.stage));
    assert.deepEqual(pipe.next?.target, { kind: 'setting', doc: 'config' }, JSON.stringify(pipe.next));
  });
});
