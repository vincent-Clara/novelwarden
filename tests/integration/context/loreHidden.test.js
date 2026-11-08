/**
 * 設定條目的「暗設」在上下文裡的去留（完善設定，2026-10-19）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 正文階段（寫、討論）與續寫：整條只帶明面，有暗設被去掉的在明細裡注一句；沒有暗設的不注 | 寫正文不需要知道真相，帶上了正文模型就容易說漏；第 2 條 |
 * | 規劃（細綱 / 大綱 / 世界觀）：整條帶全部，暗設挪到最後、標題換成「暗設（讀者還不知道）」 | 排細綱要知道哪些沒揭開，作者寫的標題五花八門 |
 * | 正文階段 @ 引用的設定條目去掉暗設、明細注一句；規劃時、別的種類的引用原樣帶 | 作者 @ 一條設定也不該把真相帶進正文 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail: 3,
});

const PLOT = '.novelwarden/summaries/002-夜探.md';
const TIANJI = '.novelwarden/lore/宗門/天機閣.md';
const SECRET = '閣主就是林昭失蹤的父親。';
const DROPPED = '暗設沒帶：寫正文不帶讀者還不知道的事，要讓這一章揭開就寫進本章細綱';

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
  t = await makeTempProject(bundle.project, { prefix: 'loreHidden', title: '暗設測試' });
  t.write(
    TIANJI,
    [
      '---',
      'title: 天機閣',
      'keywords: [天機]',
      'brief: 江湖上最大的情報組織',
      '---',
      '',
      '# 天機閣',
      '',
      '## 概要',
      '',
      '江湖上最大的情報組織。',
      '',
      '## 暗設（未揭示）',
      '',
      SECRET,
      '',
      '## 規則與邊界',
      '',
      '只賣訊息，不殺人。',
      '',
    ].join('\n')
  );
  t.write('.novelwarden/lore/地域/青崖镇.md', '---\ntitle: 青崖鎮\nkeywords: []\n---\n\n# 青崖鎮\n\n偏僻小鎮，鎮口設卡。\n');
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write(
    PLOT,
    [
      '---',
      'no: 2',
      'title: 夜探',
      '---',
      '',
      '# 第2章 夜探',
      '',
      '## 梗概',
      '',
      '林昭夜探分舵。',
      '',
      '## 關鍵事件',
      '',
      '- 林昭摸進分舵。',
      '',
      '## 設定',
      '',
      '- 天機閣〔宗門〕：分舵設在青崖鎮',
      '- 青崖鎮〔地域〕',
      '',
    ].join('\n')
  );
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(action, target, extra = {}) {
  return bundle.builder.buildContext(t.project, { action, target, ask: '', targetWords: 1200, ...extra }, config());
}

const WRITE = { stage: 'manuscript', capability: 'generate' };
const ON_CHAPTER = { kind: 'manuscript', plotRelPath: PLOT };
const lore = (b, title) => b.items.find((i) => i.kind === 'lore' && i.label === `設定 · ${title}`);
const prompt = (b) => b.messages.map((m) => m.content).join('\n');

describe('正文階段與續寫：暗設不帶', () => {
  test('寫正文：整條只帶明面，明細裡注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    const item = lore(b, '天機閣');
    assert.equal(item.status, 'included');
    assert.equal(item.text, '【天機閣〔宗門〕】江湖上最大的情報組織\n## 概要\n\n江湖上最大的情報組織。\n\n## 規則與邊界\n\n只賣訊息，不殺人。');
    assert.equal(item.note, `本章細綱的設定裡有「天機閣」；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET), '真相進了寫正文的提示詞');
  });

  test('沒有暗設的條目不注', async () => {
    const b = await build(WRITE, ON_CHAPTER);
    assert.equal(lore(b, '青崖鎮').note, '本章細綱的設定裡有「青崖鎮」');
  });

  test('討論正文也不帶', async () => {
    const b = await build({ stage: 'manuscript', capability: 'discuss' }, ON_CHAPTER);
    assert.ok(!lore(b, '天機閣').text.includes(SECRET));
    assert.ok(lore(b, '天機閣').note.endsWith(DROPPED));
  });

  test('續寫那幾輪也不帶', async () => {
    const b = await build(WRITE, ON_CHAPTER, {
      step: { kind: 'continuation', tail: '他想起天機閣的規矩。', written: 300, recovery: false },
    });
    assert.ok(!lore(b, '天機閣').text.includes(SECRET));
    assert.ok(!prompt(b).includes(SECRET));
  });
});

describe('規劃階段：整條帶全部，暗設標明讀者還不知道', () => {
  const MARKED = `## 暗設（讀者還不知道）\n\n${SECRET}`;

  test('細綱：暗設挪到最後，標題換成統一的標記', async () => {
    const b = await build({ stage: 'plot', capability: 'generate' }, { kind: 'plot', plotRelPath: PLOT });
    const item = lore(b, '天機閣');
    assert.ok(item.text.endsWith(`只賣訊息，不殺人。\n\n${MARKED}`), item.text);
    assert.ok(!item.text.includes('暗設（未揭示）'), item.text);
    assert.ok(!item.note.includes('暗設沒帶'), item.note);
  });

  test('大綱：作者點名的整條帶，含暗設', async () => {
    const b = await build({ stage: 'outline', capability: 'generate' }, { kind: 'outline' }, { ask: '天機閣的分舵' });
    assert.ok(lore(b, '天機閣').text.endsWith(MARKED), lore(b, '天機閣').text);
  });

  test('世界觀：作者點名的整條帶，含暗設', async () => {
    const b = await build(
      { stage: 'setting', capability: 'generate' },
      { kind: 'setting', doc: 'world' },
      { ask: '把天機閣寫進去' }
    );
    assert.ok(lore(b, '天機閣').text.endsWith(MARKED), lore(b, '天機閣').text);
  });
});

describe('@ 引用的設定條目', () => {
  const att = (kind) => ({ id: `${kind}:${TIANJI}`, kind, label: '設定 天機閣', relPath: TIANJI });
  const attached = (b) => b.items.find((i) => i.kind === 'attachment');

  test('正文階段：去掉暗設，明細注一句', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att('lore')] });
    const item = attached(b);
    assert.equal(item.status, 'included');
    assert.ok(!item.text.includes(SECRET) && !item.text.includes('暗設'), item.text);
    assert.ok(item.text.includes('只賣訊息，不殺人。'), item.text);
    assert.equal(item.note, `設定條目引用；${DROPPED}`);
    assert.ok(!prompt(b).includes(SECRET));
  });

  test('規劃時原樣帶', async () => {
    const b = await build({ stage: 'plot', capability: 'generate' }, { kind: 'plot', plotRelPath: PLOT }, {
      attachments: [att('lore')],
    });
    assert.ok(attached(b).text.includes(`## 暗設（未揭示）\n\n${SECRET}`), attached(b).text);
    assert.equal(attached(b).note, '設定條目引用');
  });

  test('別的種類（整檔案引用）不動', async () => {
    const b = await build(WRITE, ON_CHAPTER, { attachments: [att('file')] });
    assert.ok(attached(b).text.includes(SECRET));
    assert.equal(attached(b).note, '整檔案引用');
  });
});
