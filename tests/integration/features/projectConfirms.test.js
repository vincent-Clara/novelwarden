/**
 * 工程頁上從前調模型不先問的三處，現在都先彈確認框（2026-10-23 作者要的）：報次數、為這一次挑模型。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 重建全文大綱：章章都定稿過也先問，報批數與次數；取消零呼叫、全文大綱不動 | 第 4 條：不偷偷燒 token。從前只有有沒定稿的章時才問（⚑9） |
 * | 提取文風：第一次（style.md 還是模板）也先問，按鈕是「開始提取」；已有內容時是「覆蓋」 | 從前只有覆蓋時才問 |
 * | 提取角色卡：挑完章先問；取消零呼叫 | 從前挑完章就調 |
 * | 換了模型，這一次只用它 | 確認框的規矩（docs/design/plans/2026-10-20-call-choice.md） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const N = 4;
const CH = (no) => `chapters/00${no}-第${no}章.md`;
const GLOBAL = '.novelwarden/summaries/global.md';
const STYLE = '.novelwarden/style.md';

/** 文風那一次要提示詞規定的小節齊全才算完整（照著系統提示詞裡的 `## ` 回）；別的一律給一段話。 */
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('文風')) {
    const heads = system.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('## '));
    return heads.map((head) => `${head}\n\n${head.slice(3)}的說明。`).join('\n\n');
  }
  if (system.includes('角色')) {
    return JSON.stringify([{ name: '林昭', 身份: '孤兒' }]);
  }
  return '林昭從青崖鎮一路查到天機閣。';
}

const refsUsed = () => [...new Set(fake.calls.map((m) => m.ref))];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    summarize: './src/core/features/summarize.ts',
    style: './src/core/features/style.ts',
    characters: './src/core/features/characters.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: makeSettings({
      contextWindow: 16000,
      maxOutputTokens: 1000,
      summaryBatchSize: 3,
      providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }, { name: 'strong' }] }],
    }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'project-confirms', title: '確認框測試' });
  project = t.project;
  for (let no = 1; no <= N; no++) {
    t.write(CH(no), `# 第${no}章\n\n林昭在第${no}章走進青崖鎮，沈氏在櫃檯後看著他。\n`);
  }
  project.invalidate();
  // 四章都定稿過：細綱記下的 sourceHash 對得上正文。
  for (const ch of await project.listChapters()) {
    t.write(
      `.novelwarden/summaries/00${ch.order}-第${ch.order}章.md`,
      `---\nno: ${ch.order}\ntitle: 第${ch.order}章\nsourceHash: ${ch.contentHash}\ncast: [林昭]\n---\n\n# 第${ch.order}章 第${ch.order}章\n\n## 梗概\n\n第${ch.order}章的事。\n`
    );
  }
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('重建全文大綱：章章都定稿過也先問', () => {
  let global;

  test('取消：不調模型，全文大綱一個字不動', async () => {
    global = t.has(GLOBAL) ? t.read(GLOBAL) : undefined;
    h.expect();
    fake.reset();
    await bundle.summarize.rebuildGlobalSummary(project);
    assert.equal(fake.callCount(), 0);
    assert.equal(t.has(GLOBAL) ? t.read(GLOBAL) : undefined, global);
  });

  test('確認框報批數與次數：4 章分 2 批、再合併一次，共 3 次；不帶詳細度下拉框', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['重建']);
    assert.ok(c.message.includes('4 章同步過的細綱分 2 批歸納，再合併成一份') && c.message.includes('預計 3 次呼叫'), c.message);
    assert.equal(c.call.contextDetail, undefined, JSON.stringify(c.call));
  });

  test('換一個模型點「重建」：3 次都用它，寫出全文大綱', async () => {
    h.expect({ action: '重建', choice: { model: 'fake/strong' } });
    fake.reset();
    await bundle.summarize.rebuildGlobalSummary(project);
    assert.equal(fake.callCount(), 3);
    assert.deepEqual(refsUsed(), ['fake/strong']);
    assert.notEqual(t.read(GLOBAL), global);
  });
});

describe('提取文風：第一次也先問', () => {
  test('挑完樣章、在確認框上取消：不調模型，style.md 不寫', async () => {
    const before = t.has(STYLE) ? t.read(STYLE) : undefined;
    h.expect('1,2');
    fake.reset();
    await bundle.style.extractStyle(project);
    assert.equal(fake.callCount(), 0);
    assert.equal(t.has(STYLE) ? t.read(STYLE) : undefined, before);
  });

  test('確認框說讀哪幾章、報次數；按鈕是「開始提取」，沒有覆蓋的話', () => {
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['開始提取']);
    assert.ok(c.message.includes('讀第 1、2 章正文') && c.message.includes('預計 1 次呼叫，最多 3 次'), c.message);
    assert.equal(c.detail, undefined);
  });

  test('點「開始提取」：寫進 style.md', async () => {
    h.expect('1,2', '開始提取');
    fake.reset();
    await bundle.style.extractStyle(project);
    assert.equal(fake.callCount(), 1);
    assert.match(t.read(STYLE), /敘事視角的說明/);
  });

  test('已有內容再提取：按鈕是「覆蓋」，說清會蓋掉', async () => {
    h.expect('1', undefined);
    fake.reset();
    await bundle.style.extractStyle(project);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['覆蓋']);
    assert.match(c.detail, /會覆蓋當前內容/);
    assert.equal(fake.callCount(), 0);
  });
});

describe('提取角色卡：挑完章先問', () => {
  test('在確認框上取消：不調模型', async () => {
    h.expect('3,4');
    fake.reset();
    await bundle.characters.extractCharacters(project);
    assert.equal(fake.callCount(), 0);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['開始提取']);
    assert.ok(c.message.includes('讀第 3、4 章正文'), c.message);
  });

  test('換一個模型點「開始提取」：只用它', async () => {
    h.expect('3,4', { action: '開始提取', choice: { model: 'fake/strong' } });
    fake.reset();
    await bundle.characters.extractCharacters(project);
    assert.equal(fake.callCount(), 1);
    assert.deepEqual(refsUsed(), ['fake/strong']);
  });
});
