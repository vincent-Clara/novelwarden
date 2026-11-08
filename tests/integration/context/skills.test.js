/**
 * `skill` 層：這一次裝配所屬階段綁的那份寫作技能（移植自 AI-Novel-Writer 的階段 Skill）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 規劃三層的生成與沉澱、寫正文與續寫、審稿、修稿各帶各階段的那一份 | 階段與配方對得上 |
 * | 討論不帶 | 那是作者在聊，不是一次產出 |
 * | 排在使用者訊息的最前面，帶「作者事實和後續輸出合同始終優先」 | 上游的位置與說法 |
 * | 明細裡一條，寫來源與階段；本工程的點得開 | 第 2 條：看得出帶了什麼 |
 * | 放不下整份不帶，寫明需要多少；不截半截 | 第 2 條 |
 * | 引用到的附帶檔案標上路徑接在正文後面，與正文一起算預算 | 常規技能的 references/：模型沒有讀檔案的工具 |
 * | 綁了卻找不到 / 繫結檔案讀不懂：dropped 帶原因，生成照常 | 不讓一份技能把生成攔住 |
 * | 取消勾選的標 excluded | 與其餘條目一樣 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const fs = require('fs');

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

const PLOT2 = '.novelwarden/summaries/002-第2章.md';
const plotText = (no) =>
  ['---', `no: ${no}`, `title: 第${no}章`, 'targetWords: 1200', '---', '', `# 第${no}章 第${no}章`, '', '## 梗概', '', '往下查。', '', '## 出場人物', '', '林昭', '', '## 關鍵事件', '', '林昭下井。', '', '## 看點', '', '- 井底有人。', ''].join('\n');

const BLOCK_HEAD = '【補充寫作 Skill：';

let bundle;
let t;
let home;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  home = makeTempDir('skillLayerHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  t = await makeTempProject(bundle.project, { prefix: 'skillLayer', title: '技能層測試' });
  t.write('.novelwarden/summaries/001-第1章.md', plotText(1));
  t.write(PLOT2, plotText(2));
  t.write('chapters/001-第1章.md', '# 第1章\n\n第一章的正文。\n');
  t.write('chapters/002-第2章.md', '# 第2章\n\n第二章已經寫了一半。\n');
  t.write('.novelwarden/skills/場面寫法/SKILL.md', '---\ndisplay_name: 場面寫法\n---\n每一場都要有一個選擇。\n');
  t.write('.novelwarden/skills/帶參考/SKILL.md', '---\ndisplay_name: 帶參考\n---\n先讀 references/a.md，交稿前過 references/b.md。\n');
  t.write('.novelwarden/skills/帶參考/references/a.md', '這是一條很長的參考。'.repeat(1500));
  t.write('.novelwarden/skills/帶參考/references/b.md', '交稿清單。');
  home.write('skills/review-hard/SKILL.md', '---\nname: review-hard\n---\n逐條找出與細綱對不上的地方。\n');
  t.project.invalidate();
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

function bind(bindings) {
  t.write('.novelwarden/skills.json', JSON.stringify({ version: 1, bindings }));
}

function build(request, cfg = config()) {
  return bundle.builder.buildContext(t.project, { ask: '', ...request }, cfg);
}

const skillItem = (b) => b.items.find((i) => i.kind === 'skill');
const userOf = (b) => b.messages[b.messages.length - 1].content;

// 角色圖譜：工程裡已經有正文，前提 / 配置 / 世界觀會照正文整理（derive，不帶技能）。
const SETTING = { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'characters' } };
const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' } };
const PLOT = (capability) => ({ action: { stage: 'plot', capability }, target: { kind: 'plot', plotRelPath: PLOT2 } });
const WRITE = (extra = {}) => ({
  action: { stage: 'manuscript', capability: 'generate' },
  target: { kind: 'manuscript', plotRelPath: PLOT2 },
  targetWords: 1200,
  ...extra,
});
const REVIEW = { action: { stage: 'manuscript', capability: 'review' }, target: { kind: 'manuscript', plotRelPath: PLOT2 }, reviewGoals: [] };
const REVISE = (extra = {}) =>
  WRITE({ writeMode: 'revise', revision: { previousDraft: '第二章已經寫了一半。', feedback: '- 改掉第一句' }, ...extra });
const CONTINUE_STEP = { kind: 'continuation', tail: '第二章已經寫了一半。', written: 600, remaining: 600, recovery: false };

describe('skill 層 · 附帶檔案', () => {
  before(() => bind({ drafting: 'project:帶參考' }));

  test('寫正文：兩份參考標上路徑接在正文後面', async () => {
    const b = await build(WRITE());
    const user = userOf(b);
    assert.equal(skillItem(b)?.status, 'included');
    assert.ok(user.startsWith('【補充寫作 Skill：帶參考】'), user.slice(0, 100));
    const order = ['a', 'b'].map((p) => user.indexOf(`【附帶檔案：references/${p}.md】`));
    assert.ok(order[0] > 0 && order[1] > order[0], JSON.stringify(order));
  });

  test('預算按正文加附帶檔案一起算：放不下就整份不帶', async () => {
    const item = skillItem(await build(WRITE(), config({ contextWindow: 9000, maxOutputTokens: 1000 })));
    assert.equal(item?.status, 'dropped');
    assert.match(item.note, /預算不足（需 \d+ token/);
    assert.ok(Number(/需 (\d+) token/.exec(item.note)[1]) > 6000, item.note);
  });
});

describe('skill 層 · 規劃階段', () => {
  // 繫結不限階段：拿寫正文那份內建綁到規劃。
  before(() => bind({ planning: 'builtin:plain-prose' }));

  for (const [name, req] of [
    ['架構', SETTING],
    ['大綱', OUTLINE],
    ['細綱 · 生成', PLOT('generate')],
    ['細綱 · 沉澱討論', PLOT('settle')],
  ]) {
    test(`${name}：帶上規劃那一份`, async () => {
      const item = skillItem(await build(req));
      assert.deepEqual([item?.status, item?.label], ['included', '技能 · 去 AI 味（寫正文）']);
    });
  }

  test('討論不帶', async () => {
    assert.equal(skillItem(await build(PLOT('discuss'))), undefined);
  });

  test('寫正文不帶規劃那一份', async () => {
    assert.equal(skillItem(await build(WRITE())), undefined);
  });

  test('排在使用者訊息最前面，說清作者事實與輸出合同優先', async () => {
    const user = userOf(await build(PLOT('generate')));
    assert.ok(
      user.startsWith(
        '【補充寫作 Skill：去 AI 味（寫正文）】\n以下內容只能補充創作方法；作者事實和後續輸出合同始終優先。\n下面每條都附了例句。'
      ),
      user.slice(0, 200)
    );
  });

  test('明細寫來源與階段，內建的沒有來源路徑', async () => {
    const item = skillItem(await build(SETTING));
    assert.deepEqual([item.note, item.source, item.priority], ['內建 · 綁在「規劃（架構 / 大綱 / 細綱）」階段', undefined, 0]);
  });
});

describe('skill 層 · 正文層的四張配方', () => {
  before(() =>
    bind({ drafting: 'project:場面寫法', review: 'user:review-hard', refinement: 'builtin:plain-prose' })
  );

  test('寫正文：帶寫正文那一份，本工程的技能點得開', async () => {
    const item = skillItem(await build(WRITE()));
    assert.deepEqual([item.status, item.label, item.source], ['included', '技能 · 場面寫法', '.novelwarden/skills/場面寫法/SKILL.md']);
  });

  test('續寫那幾輪也帶', async () => {
    const b = await build(WRITE({ writeMode: 'continue', step: CONTINUE_STEP }));
    assert.equal(skillItem(b)?.status, 'included');
    assert.ok(userOf(b).startsWith(`${BLOCK_HEAD}場面寫法】`));
  });

  test('審稿帶審稿那一份', async () => {
    assert.equal(skillItem(await build(REVIEW))?.label, '技能 · review-hard');
  });

  test('修稿帶修稿那一份', async () => {
    assert.equal(skillItem(await build(REVISE()))?.label, '技能 · 去 AI 味（寫正文）');
  });

  test('修稿被截斷之後接著寫的那幾輪也帶', async () => {
    const b = await build(REVISE({ step: { kind: 'continuation', tail: '修到這裡。', written: 300, recovery: false } }));
    assert.equal(skillItem(b)?.label, '技能 · 去 AI 味（寫正文）');
  });
});

describe('skill 層 · 帶不上的時候', () => {
  test('放不下：整份不帶，寫明需要多少；訊息裡一個字都沒有', async () => {
    t.write('.novelwarden/skills/大部頭/SKILL.md', `---\nname: x\n---\n${'這是很長的一段寫作方法。'.repeat(400)}\n`);
    bind({ planning: 'project:大部頭' });
    const b = await build(SETTING, config({ contextWindow: 3000, maxOutputTokens: 500 }));
    const item = skillItem(b);
    assert.equal(item.status, 'dropped');
    assert.ok(/預算不足（需 \d+ token，剩 \d+），整份沒帶/.test(item.note), item.note);
    assert.ok(!userOf(b).includes(BLOCK_HEAD));
  });

  test('綁著的技能找不到了：dropped 說原因，來源指向繫結檔案', async () => {
    bind({ planning: 'user:gone' });
    const item = skillItem(await build(SETTING));
    assert.deepEqual([item.status, item.source], ['dropped', '.novelwarden/skills.json']);
    assert.ok(item.note.includes('找不到了'), item.note);
  });

  test('繫結檔案讀不懂：dropped 說讀不懂', async () => {
    t.write('.novelwarden/skills.json', '{');
    const item = skillItem(await build(SETTING));
    assert.ok(item.status === 'dropped' && item.note.includes('讀不懂'), JSON.stringify(item));
  });

  test('取消勾選的標 excluded', async () => {
    bind({ planning: 'builtin:plain-prose' });
    const b = await build({ ...SETTING, excludedIds: ['skill'] });
    assert.equal(skillItem(b).status, 'excluded');
    assert.ok(!userOf(b).includes(BLOCK_HEAD));
  });

  test('沒有繫結檔案：這一層什麼都不出', async () => {
    t.remove('.novelwarden/skills.json');
    assert.equal(skillItem(await build(SETTING)), undefined);
  });
});
