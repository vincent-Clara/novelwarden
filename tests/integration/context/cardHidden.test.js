/**
 * 角色卡的「暗設」在上下文裡的去留（敘事線重做第 10 個提交，設計稿「六、角色卡」⚑ 定案 B）：原來那一節叫「未收伏筆」，
 * 伏筆並進了敘事線，這一節改寫讀者還不知道的事。與設定條目的暗設（loreHidden.test.js、第 27 條）同一個口徑。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 正文階段（寫、討論、審稿）與續寫：卡上不帶暗設，真有暗設被去掉的在明細裡注一句；空的、寫著「無」的不注 | 寫正文不需要知道真相，帶上了正文模型就容易說漏；第 2 條 |
 * | 規劃（細綱 / 大綱 / 架構）：整張帶，暗設放在最後、標題寫「暗設（讀者還不知道）」 | 排細綱、排大綱要知道哪些沒揭開 |
 * | 只帶要點（「精簡」）時：規劃帶身份 / 當前狀態 / 暗設，寫正文只帶身份 / 當前狀態，明細照實寫 | 暗設是規劃時守秘密最要緊的那一節 |
 * | 老卡裡的「未收伏筆」不讀 | 不相容老工程：認不出的小節留在檔案裡，不進上下文 |
 * | 正文階段 @ 引用的角色卡去掉暗設、明細注一句；規劃時原樣帶 | 作者 @ 一張卡也不該把真相帶進正文 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = (contextDetail = 3) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail,
});

const PLOT = '.novelwarden/summaries/002-夜探.md';
const LIN = '.novelwarden/characters/林昭.md';
const SHEN = '.novelwarden/characters/沈青.md';
const SECRET = '林昭自己就是那份燒燬的名冊上的人。';
const OLD = '他認得那塊令牌的來歷';
const DROPPED = '暗設沒帶：寫正文不帶讀者還不知道的事，要讓這一章揭開就寫進本章細綱';
const MARKED = `## 暗設（讀者還不知道）\n\n${SECRET}`;

const card = (name, sections, tags = []) =>
  [
    '---',
    `name: ${name}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    `# ${name}`,
    '',
    ...Object.entries(sections).flatMap(([k, v]) => [`## ${k}`, '', v, '']),
  ].join('\n');

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'cardHidden', title: '角色暗設' });
  t.write(LIN, card('林昭', { 身份: '火災倖存者', 当前状态: '在客棧', 暗设: SECRET }, ['主角']));
  // 圖譜讓模型沒有就寫「無」：當沒有。
  t.write(SHEN, card('沈青', { 身份: '藥材商', 当前状态: '在客棧', 暗设: '無' }));
  // 老卡：「未收伏筆」是認不出的小節。
  t.write('.novelwarden/characters/李叔.md', card('李叔', { 身份: '鎮口守衛', 当前状态: '在鎮口', 未收伏筆: OLD }));
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write(
    PLOT,
    ['---', 'no: 2', 'title: 夜探', '---', '', '# 第2章 夜探', '', '## 梗概', '', '林昭夜探分舵。', '', '## 出場人物', '', '林昭、沈青、李叔', ''].join('\n')
  );
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(action, target, extra = {}, detail = 3) {
  return bundle.builder.buildContext(t.project, { action, target, ask: '', targetWords: 1200, ...extra }, config(detail));
}

const WRITE = { stage: 'manuscript', capability: 'generate' };
const ON_CHAPTER = { kind: 'manuscript', plotRelPath: PLOT };
const PLAN = { stage: 'plot', capability: 'generate' };
const ON_PLOT = { kind: 'plot', plotRelPath: PLOT };
const cardOf = (b, name) => b.items.find((i) => i.kind === 'character' && i.label === `角色 · ${name}`);
const prompt = (b) => b.messages.map((m) => m.content).join('\n');

describe('正文階段與續寫：角色卡的暗設不帶', () => {
  test('寫正文：卡上沒有暗設，明細裡注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    const item = cardOf(b, '林昭');
    assert.equal(item.status, 'included');
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗設'), item.text);
    assert.ok(item.text.includes('## 當前狀態\n\n在客棧'), item.text);
    assert.ok(item.note.endsWith(`；${DROPPED}`), item.note);
    assert.ok(!prompt(b).includes(SECRET), '真相進了寫正文的提示詞');
  });

  test('暗設寫著「無」的卡不注', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    assert.ok(!cardOf(b, '沈青').note.includes('暗設沒帶'), cardOf(b, '沈青').note);
    assert.ok(!cardOf(b, '沈青').text.includes('暗設'), cardOf(b, '沈青').text);
  });

  for (const [what, action, extra] of [
    ['討論正文', { stage: 'manuscript', capability: 'discuss' }, {}],
    ['審稿', { stage: 'manuscript', capability: 'review' }, {}],
    ['續寫那幾輪', WRITE, { step: { kind: 'continuation', tail: '他想起那場火。', written: 300, recovery: false } }],
  ]) {
    test(`${what}也不帶`, async () => {
      const b = await build(action, ON_CHAPTER, extra);
      assert.ok(!cardOf(b, '林昭').text.includes(SECRET), cardOf(b, '林昭').text);
      assert.ok(!prompt(b).includes(SECRET));
    });
  }

  test('精簡：寫正文只帶身份 / 當前狀態，明細照實寫', async () => {
    const b = await build(WRITE, ON_CHAPTER, {}, 1);
    const item = cardOf(b, '林昭');
    assert.equal(item.status, 'degraded');
    assert.match(item.note, /上下文詳細度「精簡」只帶身份\/當前狀態；暗設沒帶/);
    assert.ok(!item.text.includes(SECRET), item.text);
  });
});

describe('規劃階段：整張帶，暗設標明讀者還不知道', () => {
  test('細綱：暗設放在最後，標題寫「暗設（讀者還不知道）」', async () => {
    const b = await build(PLAN, ON_PLOT);
    const item = cardOf(b, '林昭');
    assert.ok(item.text.endsWith(`在客棧\n\n${MARKED}`), item.text);
    assert.ok(!item.note.includes('暗設沒帶'), item.note);
  });

  test('大綱、架構也帶', async () => {
    const outline = await build({ stage: 'outline', capability: 'generate' }, { kind: 'outline' }, { ask: '林昭' });
    assert.ok(cardOf(outline, '林昭').text.endsWith(MARKED), cardOf(outline, '林昭').text);
    const setting = await build({ stage: 'setting', capability: 'generate' }, { kind: 'setting', doc: 'world' }, { ask: '林昭' });
    assert.ok(cardOf(setting, '林昭').text.endsWith(MARKED), cardOf(setting, '林昭').text);
  });

  test('精簡：規劃時帶身份 / 當前狀態 / 暗設', async () => {
    const b = await build(PLAN, ON_PLOT, {}, 1);
    const item = cardOf(b, '林昭');
    assert.match(item.note, /只帶身份\/當前狀態\/暗設$/);
    assert.ok(item.text.endsWith(MARKED), item.text);
  });

  test('暗設寫著「無」的卡不帶空標題', async () => {
    const b = await build(PLAN, ON_PLOT);
    assert.ok(!cardOf(b, '沈青').text.includes('暗設'), cardOf(b, '沈青').text);
  });
});

describe('老卡裡的「未收伏筆」不讀', () => {
  test('寫正文、排細綱都不帶', async () => {
    for (const b of [await build(WRITE, ON_CHAPTER), await build(PLAN, ON_PLOT)]) {
      const item = cardOf(b, '李叔');
      assert.ok(item && !item.text.includes(OLD) && !item.text.includes('未收伏筆'), item?.text);
      assert.ok(!item.note.includes('暗設沒帶'), item.note);
    }
  });

  test('讀卡時這一節不進 sections，檔案裡還在', async () => {
    const li = (await t.project.listCharacters()).find((c) => c.name === '李叔');
    assert.equal(li.sections.暗设, '');
    assert.ok(!Object.values(li.sections).some((v) => v.includes(OLD)));
    assert.ok(t.read('.novelwarden/characters/李叔.md').includes(`## 未收伏筆\n\n${OLD}`));
  });
});

describe('@ 引用的角色卡', () => {
  const att = (relPath, label) => ({ id: `character:${relPath}`, kind: 'character', label, relPath });
  const attached = (b) => b.items.find((i) => i.kind === 'attachment');

  test('正文階段：去掉暗設，明細注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att(LIN, '角色 林昭')] });
    const item = attached(b);
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗設'), item.text);
    assert.ok(item.text.includes('火災倖存者'), item.text);
    assert.equal(item.note, `角色卡引用；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET));
  });

  test('正文階段：暗設寫著「無」只去掉那一節，不注', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att(SHEN, '角色 沈青')] });
    assert.ok(!attached(b).text.includes('暗設'), attached(b).text);
    assert.equal(attached(b).note, '角色卡引用');
  });

  test('規劃時原樣帶', async () => {
    const b = await build(PLAN, ON_PLOT, { attachments: [att(LIN, '角色 林昭')] });
    assert.ok(attached(b).text.includes(`## 暗设\n\n${SECRET}`), attached(b).text);
    assert.equal(attached(b).note, '角色卡引用');
  });
});
