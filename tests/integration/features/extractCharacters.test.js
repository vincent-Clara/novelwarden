/**
 * 「從正文提取角色卡」把「主角」「反派」建成卡（外部 issue，2026-10-24）。
 *
 * 那一次是三件事疊在一起：卷目錄裡的 `047 細綱.txt`、`048 作話.txt` 被當成正文讀進語料；
 * 模型讀到作者視角的文字，返回了「韓厲」與「反派（別名：韓厲、頭領）」兩條；
 * 同一批的兩條各建了一張卡，`反派.md` 與 `韓厲.md` 搶同一個稱呼。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const settings = makeSettings();

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    characters: './src/core/features/characters.ts',
    registry: './src/core/llm/registry.ts',
    logger: './src/core/runtime/logger.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { repeatLast: true, fallback: '[]' });
  t = await makeTempProject(bundle.project, { prefix: 'extract-labels', title: '劇作稱謂' });
  project = t.project;
  t.write('chapters/046-夜襲.txt', `${'韓厲帶人摸進鎮口，火把一路燒到客棧門前。'.repeat(10)}\n`);
  t.write('chapters/047 細綱.txt', '反派在此處需要透露哪些資訊……描述反派的心理壓力……\n');
  t.write('chapters/048 作話.txt', '大家放心，主角是……下一章會升級……\n');
  project.invalidate();
});

after(() => {
  cleanup(t.dir, bundle.db);
});

describe('提取角色：筆記不進語料，稱謂不建卡', () => {
  let chapters;
  let corpus;
  let files;
  let card;
  let confirms;

  before(async () => {
    chapters = (await project.listChapters()).map((c) => c.relPath);
    // 輸入框（章號）→ 確認框（開始提取）。並完只剩一張新卡，不該再問「逐個對比」。
    h.expect('46', '開始提取');
    fake.reset([
      JSON.stringify([
        { name: '韓厲', aliases: [], tags: ['反派'], 身份: '黑風寨寨主' },
        { name: '反派', aliases: ['韓厲', '頭領'], tags: ['反派'], 身份: '黑風寨頭領', 性格: '多疑' },
      ]),
    ]);
    await bundle.characters.extractCharacters(project);
    corpus = fake.calls[0]?.at(-1)?.content ?? '';
    files = fs.readdirSync(t.rel('.novelwarden/characters')).sort();
    card = (await project.listCharacters()).find((c) => c.name === '韓厲');
    confirms = h.confirms.map((c) => c.message);
  });

  test('卷目錄裡的細綱、作話不算章節', () => {
    assert.deepEqual(chapters, ['chapters/046-夜襲.txt']);
  });

  test('餵給模型的只有正文', () => {
    assert.match(corpus, /韓厲帶人摸進鎮口/);
    assert.doesNotMatch(corpus, /心理壓力|大家放心/);
  });

  test('只建了真名那一張卡', () => {
    assert.deepEqual(files, ['韓厲.md']);
  });

  test('「反派」那一條並進來了：頭領進別名、空著的小節補上', () => {
    assert.deepEqual(card.aliases, ['頭領']);
    assert.deepEqual(card.tags, ['反派']);
    assert.equal(card.sections.身份, '黑風寨寨主');
    assert.equal(card.sections.性格, '多疑');
  });

  test('沒有對一張剛建的卡再問「逐個對比」', () => {
    assert.ok(!confirms.some((m) => m.includes('要逐個對比確認嗎')), confirms.join(' | '));
  });
});
