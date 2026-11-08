/**
 * 後設資料目錄改名後的相容（0.2.x → 0.3）：舊工程必須還能開啟。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只有 `.novelforge/` 的工程 `isInitialized()` 為真 | 作者升級後開啟舊書不能當成「還不是工程」 |
 * | `needsMigration()` 為真，且開啟時不在旁邊建 `.novelwarden/` | 已有舊目錄時不得出現第二份後設資料 |
 * | `migrateLegacyDir()` 之後舊目錄整個 rename 成 `.novelwarden/` | 遷移只在作者確認後發生，內容一個位元組不丟 |
 * | 只有 `.novel/` 的 0.1.x 工程也能走到 `.novelwarden/` | 兩代舊目錄都要認 |
 * | 新舊目錄都在時認新的、不再提示遷移 | 遷移過的工程不該被反覆打擾 |
 *
 * 全部在臨時目錄裡跑，不碰真實家目錄與真實工程。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
const roots = [];

/** 造一箇舊格式工程：`dir` 是 `.novelforge` 或 `.novel`。 */
function legacyProject(dir) {
  const t = makeTempDir('migration');
  roots.push(t.dir);
  const meta = path.join(t.dir, dir);
  fs.mkdirSync(path.join(meta, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(meta, 'project.json'), JSON.stringify({ version: 1, title: '舊工程', chapters: [] }));
  fs.writeFileSync(path.join(meta, 'style.md'), '# 文風指南\n\n舊的內容。\n');
  fs.writeFileSync(path.join(meta, 'summaries', '001.md'), '細綱內容');
  return t;
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
});

after(() => {
  for (const root of roots) cleanup(root);
});

describe('0.2.x 的 .novelforge/', () => {
  let t;
  let project;
  let initializedBefore;
  let needsBefore;
  let novelDirBefore;
  let chaptersBefore;
  let parallelDirCreated;
  let legacyGone;
  let initializedAfter;
  let needsAfter;

  before(async () => {
    t = legacyProject('.novelforge');
    fs.mkdirSync(path.join(t.dir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'chapters', '001-測試.md'), '# 測試\n\n舊工程裡的正文。\n');
    project = bundle.project.NovelProject.open(t.dir);

    initializedBefore = await project.isInitialized();
    needsBefore = await project.needsMigration();
    novelDirBefore = path.basename(project.novelDir);
    chaptersBefore = (await project.listChapters()).length;
    // 開啟本身不能順手建一份新目錄——作者還沒確認遷移。
    parallelDirCreated = fs.existsSync(path.join(t.dir, '.novelwarden'));

    await project.migrateLegacyDir();
    legacyGone = !fs.existsSync(path.join(t.dir, '.novelforge'));
    initializedAfter = await project.isInitialized();
    needsAfter = await project.needsMigration();
  });

  test('舊工程能被開啟：isInitialized 為真', () => {
    assert.equal(initializedBefore, true);
  });

  test('讀寫落在舊目錄 .novelforge/ 裡，章節能讀出來', () => {
    assert.equal(novelDirBefore, '.novelforge');
    assert.equal(chaptersBefore, 1);
  });

  test('提示需要遷移', () => {
    assert.equal(needsBefore, true);
  });

  test('開啟時不併排新建 .novelwarden/', () => {
    assert.equal(parallelDirCreated, false);
  });

  test('遷移後舊目錄已 rename 走', () => {
    assert.equal(legacyGone, true);
  });

  test('manifest 與內容原樣搬進 .novelwarden/', () => {
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'project.json')));
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'summaries', '001.md')));
    assert.ok(fs.readFileSync(path.join(t.dir, '.novelwarden', 'style.md'), 'utf8').includes('舊的內容'));
  });

  test('遷移後 isInitialized 仍為真、不再提示遷移', () => {
    assert.equal(initializedAfter, true);
    assert.equal(needsAfter, false);
  });
});

describe('0.1.x 的 .novel/', () => {
  let t;
  let project;
  let initializedBefore;
  let needsBefore;
  let steps;
  let legacyGone;
  let needsAfter;

  before(async () => {
    t = legacyProject('.novel');
    project = bundle.project.NovelProject.open(t.dir);

    initializedBefore = await project.isInitialized();
    needsBefore = await project.needsMigration();

    // 兩代舊目錄都要認：實現可以一步 rename 到 .novelwarden/，也可以先 .novel → .novelforge
    // 再 .novelforge → .novelwarden；迴圈到狀態機說不需要遷移為止，最多三步。
    steps = 0;
    while ((await project.needsMigration()) && steps < 3) {
      await project.migrateLegacyDir();
      steps++;
    }
    legacyGone = !fs.existsSync(path.join(t.dir, '.novel')) && !fs.existsSync(path.join(t.dir, '.novelforge'));
    needsAfter = await project.needsMigration();
  });

  test('0.1.x 舊工程也能被開啟', () => {
    assert.equal(initializedBefore, true);
  });

  test('提示需要遷移', () => {
    assert.equal(needsBefore, true);
  });

  test('遷移到 .novelwarden/ 後舊目錄都不在了', () => {
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'project.json')));
    assert.equal(legacyGone, true);
  });

  test('遷移後不再提示遷移', () => {
    assert.equal(needsAfter, false);
  });
});

describe('新舊目錄並存', () => {
  let t;
  let project;
  let needsMigration;
  let novelDir;

  before(async () => {
    t = legacyProject('.novelforge');
    fs.mkdirSync(path.join(t.dir, '.novelwarden'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, '.novelwarden', 'project.json'), JSON.stringify({ version: 1, title: '新工程', chapters: [] }));
    project = bundle.project.NovelProject.open(t.dir);
    needsMigration = await project.needsMigration();
    novelDir = project.novelDir;
  });

  test('認新的 .novelwarden/', () => {
    assert.equal(path.basename(novelDir), '.novelwarden');
  });

  test('已有新目錄時不再提示遷移', () => {
    assert.equal(needsMigration, false);
  });
});

describe('空目錄', () => {
  test('還不是工程，也不順手建後設資料目錄', async () => {
    const t = makeTempDir('migration-empty');
    roots.push(t.dir);
    const project = bundle.project.NovelProject.open(t.dir);
    assert.equal(await project.isInitialized(), false);
    assert.equal(await project.needsMigration(), false);
    assert.equal(fs.existsSync(path.join(t.dir, '.novelwarden')), false);
  });
});
