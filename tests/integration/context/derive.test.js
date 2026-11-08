/**
 * 從已寫正文整理（拆書 A）的裝配：`BuildRequest.derive` 時架構那張配方帶上 `written` 層，
 * 契約換成「照正文整理」的說法。細綱不再從正文整理：拆書第一步「先整理細綱」已經照正文寫出了
 * 定稿過的細綱，「補細綱」那一步連同細綱配方里的 `written` 層一起刪了。情節大綱也不再整理：它是各章細綱梗概的
 * 彙總，細綱齊了它就齊了（docs/design/plans/2026-10-22-outline-from-plots.md），大綱配方不再掛 `written` 層。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 不是 derive 時一條 `written` 都沒有、契約照舊 | 配方掛著這一層，平時必須是空的 |
 * | 架構：均勻抽樣 5 章的開頭 + 全書梗概（取自定稿過的細綱）；系統提示說清「這一次是整理」 | 上游只看首末兩章，長書中段全丟 |
 * | 梗概放不下時降級或丟棄，寫明原因 | 第 2 條：不靜默截斷 |
 * | 大綱那一層不帶已寫正文，即使請求裡帶著 derive | 大綱配方不再掛 `written` 層 |
 * | 規劃階段綁了技能，derive 時也不帶 | 照實整理，不按技能的排法改寫已經發生的事 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

const N = 8;
/** 每章：開頭一句可認的話 + 很長的中段 + 結尾一句鉤子。 */
const body = (no) => `第${no}章開頭：林昭醒來。\n\n${'山風很冷。'.repeat(1200)}\n\n第${no}章結尾：門外有人敲了三下。`;

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    ws: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'deriveCtx', title: '整理測試' });
  for (let no = 1; no <= N; no++) {
    t.write(`chapters/00${no}-第${no}回.md`, `# 第${no}回\n\n${body(no)}\n`);
  }
  t.project.invalidate();
  // 第 1–6 章定稿過（細綱照正文更新、記了 sourceHash）；第 7、8 章還沒定稿。
  const ws = new bundle.ws.Workspace(t.project);
  for (const chapter of (await t.project.listChapters()).filter((c) => c.order <= 6)) {
    await ws.finalizePlot(chapter, {
      梗概: `第${chapter.order}章梗概：林昭查到了第${chapter.order}條線索。`,
      出场人物: '林昭',
      时间地点: '青雲山',
      关键事件: `第${chapter.order}章關鍵事件：翻牆。`,
      看点: `- 第${chapter.order}章看點：執事當眾被林昭拆穿\n- 門外是誰`,
      状态变更: `第${chapter.order}章後林昭受了輕傷。`,
      连续性事实: '',
    }, [{ name: '林昭', aliases: [] }]);
  }
  t.write('.novelwarden/skills/排法/SKILL.md', '---\nname: 排法\n---\n每章三個場景。\n');
  t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings: { planning: 'project:排法' } }));
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(request, cfg = config()) {
  return bundle.builder.buildContext(t.project, { ask: '', ...request }, cfg);
}
const written = (built) => built.items.filter((i) => i.kind === 'written');
const user = (built) => built.messages[built.messages.length - 1].content;
const system = (built) => built.messages[0].content;

describe('derive · 平時不帶', () => {
  test('架構、大綱不 derive 時沒有 written，契約照舊；細綱配方從來不帶', async () => {
    // 角色圖譜不隨正文自動整理（見下一條）。
    const setting = await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'characters' } });
    const outline = await build({ action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, range: { from: 1, to: 20 } });
    const plot = await build({
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/003.md' },
      range: { from: 3, to: 5 },
      targetNo: 3,
    });
    for (const b of [setting, outline, plot]) {
      assert.equal(written(b).length, 0);
      assert.ok(!user(b).includes('# 已寫正文'));
      assert.ok(!user(b).includes('從已寫正文整理'));
    }
    assert.match(user(outline), /一章一章推演這一段/);
    assert.match(user(plot), /商業網文節奏設計原則/);
    // 平時規劃階段綁的技能照帶。
    assert.ok(setting.items.some((i) => i.kind === 'skill' && i.status === 'included'));
  });
});

describe('derive · 單件生成架構', () => {
  test('已經寫了正文：配置、前提、世界觀自動照正文整理，寫到第幾章按連續有正文算；不帶規劃技能', async () => {
    for (const doc of ['config', 'premise', 'world']) {
      const b = await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc } });
      assert.ok(written(b).length > 0, doc);
      assert.ok(user(b).includes('從已寫正文整理'), doc);
      assert.ok(!b.items.some((i) => i.kind === 'skill' && i.status === 'included'), doc);
    }
  });

  test('討論照舊，不帶已寫正文', async () => {
    const b = await build({ action: { stage: 'setting', capability: 'discuss' }, target: { kind: 'setting', doc: 'premise' }, ask: '聊聊' });
    assert.equal(written(b).length, 0);
  });
});

describe('derive · 架構', () => {
  test('均勻抽樣 5 章的開頭節選 + 全書梗概；系統提示與契約說清是整理', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'config' },
      derive: { through: N },
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    const items = written(b);
    const samples = items.filter((i) => i.id !== 'written:synopsis');
    assert.deepEqual(samples.map((i) => i.id), ['written:1', 'written:3', 'written:5', 'written:6', 'written:8']);
    assert.ok(samples.every((i) => i.status === 'included'));
    assert.match(samples[0].text, /（後略 \d+ 字）/);
    const synopsis = items.find((i) => i.id === 'written:synopsis');
    assert.equal(synopsis.status, 'included');
    assert.match(synopsis.text, /第1章梗概/);
    // 看點跟在同一行梗概後面，多條用分號連起來。
    assert.match(synopsis.text, /第1章梗概：林昭查到了第1條線索。｜看點：第1章看點：執事當眾被林昭拆穿；門外是誰/);
    assert.match(synopsis.note, /2 章還沒同步，沒有梗概可帶/);

    assert.match(system(b), /這一次不是從零創作：作者已經寫到第 8 章/);
    const u = user(b);
    assert.ok(u.includes('# 已寫正文（作者已經寫成的權威事實'));
    assert.ok(u.includes('【從已寫正文整理（重要）】作者已經寫到第 8 章'));
    assert.ok(u.includes('基於上面「已寫正文」'));
    // 規模照給，格式不變（2026-10-25 起按小標題寫）；不說「我的腦洞」。
    assert.ok(u.includes('- 計劃總章數：100 章'));
    assert.ok(u.includes('【小說配置格式】'));
    // 沒有作者的一句話：一句話賣點必須寫。
    assert.ok(u.includes('「一句話賣點」也必須寫'), u.slice(-1500));
    assert.ok(!u.includes('# 我的腦洞'));
    assert.ok(!u.includes('契合市場'));
  });

  test('只看第 1–through 章', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'world' },
      derive: { through: 3 },
    });
    assert.ok(written(b).every((i) => i.id === 'written:synopsis' || Number(i.id.split(':')[1]) <= 3));
    assert.match(user(b), /基於「已寫正文」與小說配置/);
  });

  test('梗概放不下時降級（隔章抽）或丟棄，寫明預算不足', async () => {
    const b = await build(
      {
        action: { stage: 'setting', capability: 'generate' },
        target: { kind: 'setting', doc: 'premise' },
        derive: { through: N },
      },
      config({ contextWindow: 12000, maxOutputTokens: 1000 })
    );
    const synopsis = written(b).find((i) => i.id === 'written:synopsis');
    assert.ok(synopsis, '梗概那一條要留在明細裡');
    assert.ok(['degraded', 'dropped'].includes(synopsis.status), synopsis.status);
    assert.match(synopsis.note, /預算不足/);
  });

  test('規劃階段綁的技能 derive 時不帶', async () => {
    const b = await build({
      action: { stage: 'setting', capability: 'generate' },
      target: { kind: 'setting', doc: 'premise' },
      derive: { through: N },
    });
    assert.ok(!b.items.some((i) => i.kind === 'skill'));
  });
});

describe('derive · 大綱', () => {
  // 情節大綱是各章細綱梗概的彙總，不再照正文整理：大綱配方不掛 `written` 層，請求裡帶著 derive 也不帶正文。
  test('大綱配方不帶已寫正文，契約照舊是規劃', async () => {
    const b = await build({
      action: { stage: 'outline', capability: 'generate' },
      target: { kind: 'outline' },
      range: { from: 5, to: 8 },
      derive: { through: N },
    });
    assert.deepEqual(written(b), []);
    assert.ok(user(b).includes('一章一章推演這一段'));
  });
});
