/**
 * 「選中一章」這個入口：`selectPlot` 收一個路徑，由狀態機決定落在哪一層。
 *
 * 它是四層流水線在介面上的**唯一入口**——工程頁點章名、對話頁下拉框換章、
 * 新建一章之後都走它。而這三處給的路徑形狀並不一樣：
 *
 * | 入口 | 給的是什麼 |
 * |---|---|
 * | 工程頁點章名 | **主路徑**：有成品就是 `chapters/003-夜访.md` |
 * | 對話頁下拉框 | 細綱路徑，這一章還沒規劃過時那個檔案**並不存在** |
 * | 流水線 / 新建 | 真實的細綱路徑 |
 *
 * 從前它只 `readPlot` 一次、讀不到就報「這一章不存在，可能剛被改名或刪除」，
 * 於是**沒有細綱的章（老工程裡的每一章、直接粘進來的章）**一點開就是那句話——而它們明明
 * 好好地躺在 `chapters/` 裡。所以這裡的每一條都在守同一件事：認的是「哪一章」，
 * 不是「哪個細綱檔案」；只有兩邊都沒有才算不存在。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

let bundle;
let h;
let t;
let project;
let controller;
let posted;

/** 發一條 selectPlot，回收這一輪推給前端的訊息。 */
async function select(relPath) {
  posted.length = 0;
  await controller.handle({ type: 'selectPlot', plotRelPath: relPath });
  return {
    error: posted.find((m) => m.type === 'toast' && m.level === 'error'),
    session: posted.filter((m) => m.type === 'session').pop()?.session,
    pipe: posted.filter((m) => m.type === 'pipeline').pop(),
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    controller: './src/core/controller/index.ts',
  });
  wsMod = bundle.ws;
  h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'selectplot', title: '選章測試' });
  project = t.project;

  // 第 8 章：細綱排過，正文也寫好了 —— 兩面俱全。
  await wsOf(project).writePlot({
    no: 8, title: '夜訪', upstreamHash: '', done: false,
    sections: { 梗概: '暴露令牌', 出场人物: '', 时间地点: '', 关键事件: '甲、乙、丙。', 看点: '', 状态变更: '', 连续性事实: '' },
  });
  t.write('chapters/008-夜訪.md', '# 夜訪\n\n三更，林昭醒了。\n');
  // 第 9 章：**只有正文**。老工程裡的每一章都是這樣（直接把已有的章放進 chapters/），
  // 用「新建章節檔案」粘進來的章也是——沒有細綱，標題也還沒起（純序號名）。
  t.write('chapters/009.md', '雨停了。\n');
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  posted = [];
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('工程頁點章名（給的是主路徑）', () => {
  let r;

  before(async () => {
    r = await select('chapters/008-夜訪.md');
  });

  test('不報「這一章不存在」', () => {
    assert.equal(r.error, undefined, r.error && r.error.message);
  });

  // 目標一律落在**細綱那一側**：流水線、工作區卡與寫入都按細綱路徑認這一章（細綱號 = 章號），
  // 讓 target 指進 chapters/ 的話，同一章的細綱與正文會各找各的位置。
  test('目標歸到細綱路徑', () => {
    assert.equal(r.session.target.plotRelPath, '.novelwarden/summaries/008-夜訪.md');
  });

  test('推來的流水線是第 8 章', () => {
    assert.equal(r.pipe.pipeline?.no, 8, JSON.stringify(r.pipe.pipeline?.no));
  });
});

describe('對話頁下拉框選一個只有成品的章', () => {
  let r;
  let dropdownRel;

  before(async () => {
    // 下拉框給的就是 buildState 裡算出來的那個路徑（`plotPathOfNo`：有正文就是正文的映象）——
    // 這一章還沒規劃過，所以那個檔案並不存在。這正是 bug 的觸發點。
    const ninth = (await project.listChapters()).find((c) => c.order === 9);
    dropdownRel = await project.plotPathOfNo(ninth.order, ninth.title);
    r = await select(dropdownRel);
  });

  // 無標題的章在 listChapters 那邊會回落成「第 9 章」，那是「沒有標題」的樣子
  // 而不是標題。拼進檔名會得到 `009-第-9-章.md`——一個憑空的假名字，
  // 而作者哪天真去補規劃時，writePlot 落的又是另一個檔名。
  test('回落標題不進細綱檔名', () => {
    assert.equal(dropdownRel, '.novelwarden/summaries/009.md');
  });

  test('不報「這一章不存在」', () => {
    assert.equal(r.error, undefined, r.error && r.error.message);
  });

  test('推來的流水線是第 9 章', () => {
    assert.equal(r.pipe.pipeline?.no, 9, JSON.stringify(r.pipe.pipeline?.no));
  });

  // 正文在就不該被倒回去補細綱（`deriveStage` 先看 chapterExists）。
  test('已有正文的章不被倒回「待寫細綱」', () => {
    assert.notEqual(r.pipe.pipeline?.stage, 'plot', r.pipe.pipeline?.stage);
  });

  // 工作區卡上那句話也得改口：這一章沒丟，只是沒經過流水線。
  // 說「可能剛被改名或刪除」會讓作者去找一個根本沒丟的東西。
  test('工作區卡不說這一章丟了', () => {
    assert.ok(
      !(r.pipe.workbench?.empty ?? '').includes('改名或刪除'),
      JSON.stringify(r.pipe.workbench)
    );
  });
});

describe('真的不存在的章', () => {
  let r;

  before(async () => {
    r = await select('.novelwarden/summaries/777-沒這章.md');
  });

  // 兩邊都沒有才是「不存在」。這條提示本身沒錯，錯的是從前它太容易被撞上。
  test('給出提示而不是崩', () => {
    assert.ok(r.error, JSON.stringify(posted.map((m) => m.type)));
  });

  test('提示說的是改名或刪除', () => {
    assert.ok(r.error.message.includes('改名或刪除'), r.error.message);
  });
});

describe('狀態機仍然在管落在哪一層', () => {
  let planned;

  before(async () => {
    // 一個關鍵事件還沒排的新章：狀態機該把作者留在細綱層，而不是丟進正文。
    await wsOf(project).writePlot({
      no: 20, title: '', upstreamHash: '', done: false,
      sections: { 梗概: '還沒想好', 出场人物: '', 时间地点: '', 关键事件: '', 看点: '', 状态变更: '', 连续性事实: '' },
    });
    project.invalidate();
    planned = await select('.novelwarden/summaries/020.md');
  });

  test('沒排細綱的章落在細綱層', () => {
    assert.equal(planned.session.stage, 'plot', planned.session.stage);
  });

  // 切層一律把能力重置成 discuss：預設動作不該是花錢產出一份要不要都不知道的產物。
  test('切層不預置花錢的能力', () => {
    assert.equal(planned.session.capability, 'discuss', planned.session.capability);
  });

  test('主按鈕是「寫第 20 章細綱」那一類生成', () => {
    assert.equal(planned.pipe.next?.capability, 'generate', JSON.stringify(planned.pipe.next));
  });
});
