/**
 * 預檢的永久放行落在細綱 frontmatter 裡（五期補遺 §2）：`Workspace.recordPreflightOk`。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 記進 `preflightOk`，同名換成新理由，別的原樣留著；正文一個位元組不動 | 只改 `---` 之間那一段 |
 * | 手寫的細綱（沒有 frontmatter）不補 | 補一段 frontmatter 等於把它拉進指紋鏈 |
 * | 改名留著，重新生成這一章的細綱就丟掉 | 重排過的出場是新的安排，要再問一次 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let ws;
const P8 = '.novelwarden/summaries/008-渡口.md';

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    fileOps: './src/core/files/fileOps.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);
  t = await makeTempProject(bundle.project, { prefix: 'preflight-ok', title: '青崖記' });
  ws = new bundle.ws.Workspace(t.project);
  const empty = bundle.plotFile.emptyPlotSections();
  await ws.writePlot({ no: 8, title: '渡口', upstreamHash: '', done: false, sections: { ...empty, 出场人物: '林昭、沈秋', 关键事件: '林昭在渡口夢見沈秋', 看点: '船上沒有人' } });
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const okOf = async (rel) => {
  t.project.invalidate();
  return JSON.parse(JSON.stringify((await t.project.readPlot(rel)).preflightOk));
};

describe('recordPreflightOk', () => {
  test('記進 frontmatter，正文一個位元組不動', async () => {
    const body = t.read(P8).split('\n---\n').slice(1).join('\n---\n');
    assert.equal(await ws.recordPreflightOk(P8, [{ name: '沈秋', reason: '託夢' }]), true);
    assert.deepEqual(await okOf(P8), [{ name: '沈秋', reason: '託夢' }]);
    assert.equal(t.read(P8).split('\n---\n').slice(1).join('\n---\n'), body);
  });

  test('同名換成新理由，別的原樣留著', async () => {
    await ws.recordPreflightOk(P8, [{ name: '李叔', reason: '回憶' }]);
    await ws.recordPreflightOk(P8, [{ name: '沈秋', reason: '幻象' }]);
    assert.deepEqual(await okOf(P8), [{ name: '李叔', reason: '回憶' }, { name: '沈秋', reason: '幻象' }]);
  });

  test('手寫的細綱（沒有 frontmatter）不補', async () => {
    const rel = '.novelwarden/summaries/009-手寫.md';
    t.write(rel, '# 第9章 手寫\n\n## 關鍵事件\n\n沈秋出場\n');
    assert.equal(await ws.recordPreflightOk(rel, [{ name: '沈秋', reason: '回憶' }]), false);
    assert.doesNotMatch(t.read(rel), /preflightOk/);
  });

  test('改名留著', async () => {
    t.project.invalidate();
    const plot = await t.project.readPlot(P8);
    const to = await ws.writePlot({ ...plot, title: '夜渡' }, P8);
    assert.deepEqual(await okOf(to), [{ name: '李叔', reason: '回憶' }, { name: '沈秋', reason: '幻象' }]);
  });

  test('重新生成這一章的細綱：丟掉', async () => {
    t.project.invalidate();
    const rel = (await t.project.getPlot(8)).relPath;
    const empty = bundle.plotFile.emptyPlotSections();
    await ws.write(rel, { artifact: { kind: 'plot', title: '夜渡', sections: { ...empty, 出场人物: '林昭、沈秋', 关键事件: '林昭在渡口又夢見沈秋', 看点: '船上沒有人' } } }, { mode: 'overwrite', review: false });
    assert.deepEqual(await okOf(rel), []);
  });
});
