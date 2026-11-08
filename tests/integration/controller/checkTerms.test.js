/**
 * 內建編輯器「寫作體檢」的後端一半（`controller/check.ts` + `views/checkTerms.ts`）與敏感詞表經閘道器的讀寫。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 連上就推一份 `checkTerms`（`init` 之後），哪個頁籤都推 | 編輯器不必等作者切到別的頁 |
 * | 禁用詞與寫正文時（`planWriting`）用的**一模一樣** | 同一個函式、同一份輸入：編輯器裡標的就是寫完數的 |
 * | 內容沒變的 `pushState` 不推；`style.md` 改了重推 | 作者每存一次盤就跑一次 `pushState` |
 * | 敏感詞表新建 / 修改 / 刪除各推一次，壞行帶著行號 | 詞表變了才推，面板裡能說「第 N 行沒看懂」 |
 * | 新連上的前端沒變也推 | 它手上什麼都沒有 |
 * | 宿主沒有內建編輯器（沒有 `openInEditor`）不推 | 外掛殼用不上，不為它多讀檔案 |
 * | 「編輯敏感詞表…」：沒有就經閘道器新建模板再開啟；有了只開啟、不蓋掉；還不是小說工程只說一句 | 第 3 條：同名不覆蓋 |
 * | `sensitive.txt` 是 `sensitive` 種類、經編輯器儲存會留歷史版本，不進上下文 | 作者手維護的詞表改壞了要找得回來 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const SENSITIVE = '.novelwarden/sensitive.txt';

let bundle;
let t;
let fake;
let controller;
let posted = [];
/** 編輯器裡開啟過的路徑（假宿主的 `openInEditor`）。 */
const openedInEditor = [];

const all = (type) => posted.filter((m) => m.type === type);
const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    generate: './src/core/generation/generate.ts',
    checkTerms: './src/core/views/checkTerms.ts',
    kind: './src/core/workspace/kind.ts',
    history: './src/core/workspace/history.ts',
    fileEditing: './src/core/files/fileEditing.ts',
    hash: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fake = makeFakeHost({
    name: 'standalone',
    settings: () => settings,
    overrides: { openInEditor: async (p) => openedInEditor.push(p) },
  });
  bundle.host.initHost(fake.host);
  t = await makeTempProject(bundle.project, { prefix: 'check-terms', title: '青雲劍錄' });
  t.write(
    '.novelwarden/config.md',
    '---\ngenre: 仙俠\nsubGenre: 修真\n---\n# 小說配置\n\n## 全域要求\n\n- 嚴禁出現「手機」「電腦」，須用「玉簡」\n'
  );
  t.write('.novelwarden/style.md', '# 文風指南\n\n## 禁用詞表\n\n- 不用「不禁」「頓時」\n');
  t.write('.novelwarden/summaries/001-雨夜.md', '---\ntargetWords: 3000\n---\n# 第1章 雨夜\n\n## 關鍵事件\n\n- 出城\n');
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('checkTerms：連上就推，與生成鏈同一份禁用詞', () => {
  before(async () => {
    t.project.invalidate();
    posted = [];
    await controller.handle({ type: 'ready' });
  });

  test('ready 之後推了一份，排在 init 後面', () => {
    const types = posted.map((m) => m.type);
    assert.ok(types.includes('checkTerms'), types.join(','));
    assert.ok(types.indexOf('init') < types.indexOf('checkTerms'), types.join(','));
  });

  test('禁用詞：文風禁用詞表、全域要求裡禁止的那一個分句、古代題材的現代說法', () => {
    const banned = lastOf('checkTerms').terms.banned;
    assert.deepEqual(banned.slice(0, 4), ['不禁', '頓時', '手機', '電腦']);
    assert.ok(banned.includes('能量'), banned.join('、'));
    // 「須用『玉簡』」是要用的詞，不收。
    assert.equal(banned.includes('玉簡'), false);
  });

  test('與寫正文時 planWriting 用的一模一樣（同一個函式、同一份輸入）', async () => {
    const plan = await bundle.generate.planWriting(t.project, {
      target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/001-雨夜.md' },
      targetNo: 1,
    });
    assert.deepEqual(lastOf('checkTerms').terms.banned, plan.banned);
    assert.deepEqual(await bundle.checkTerms.readBannedTerms(t.project), plan.banned);
  });

  test('還沒有敏感詞表：空的、說清不在、路徑給出來', () => {
    const terms = lastOf('checkTerms').terms;
    assert.deepEqual(terms.sensitive, []);
    assert.equal(terms.sensitiveExists, false);
    assert.equal(terms.sensitivePath, SENSITIVE);
    assert.deepEqual(terms.sensitiveBad, []);
  });
});

describe('checkTerms：變了才推', () => {
  test('什麼都沒變的 pushState 不推', async () => {
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 0);
  });

  test('style.md 的禁用詞表改了：重推，帶著新詞', async () => {
    t.write('.novelwarden/style.md', '# 文風指南\n\n## 禁用詞表\n\n- 不用「不禁」「頓時」「霎時」\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.ok(lastOf('checkTerms').terms.banned.includes('霎時'));
  });

  test('config.md 換成都市題材：現代說法不再算禁用詞', async () => {
    t.write('.novelwarden/config.md', '---\ngenre: 都市\n---\n# 小說配置\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.equal(lastOf('checkTerms').terms.banned.includes('能量'), false);
  });

  test('敏感詞表新建：推一份，詞與替換詞都在、壞行帶著行號與原因', async () => {
    t.write(SENSITIVE, '# 註釋\n賭博 => 博戲\nSB\n=> 沒詞\n');
    posted = [];
    await controller.pushState();
    const terms = lastOf('checkTerms').terms;
    assert.equal(all('checkTerms').length, 1);
    assert.equal(terms.sensitiveExists, true);
    assert.deepEqual(terms.sensitive, [{ term: '賭博', replacement: '博戲' }, { term: 'SB' }]);
    assert.deepEqual(terms.sensitiveBad.map((b) => b.line), [4]);
    assert.match(terms.sensitiveBad[0].reason, /前面沒有詞/);
  });

  test('敏感詞表改了：重推', async () => {
    t.write(SENSITIVE, '賭博 => 博戲\n');
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.deepEqual(lastOf('checkTerms').terms.sensitive, [{ term: '賭博', replacement: '博戲' }]);
    assert.deepEqual(lastOf('checkTerms').terms.sensitiveBad, []);
  });

  test('敏感詞表刪了：重推，空的、說不在', async () => {
    t.remove(SENSITIVE);
    posted = [];
    await controller.pushState();
    assert.equal(all('checkTerms').length, 1);
    assert.deepEqual(lastOf('checkTerms').terms.sensitive, []);
    assert.equal(lastOf('checkTerms').terms.sensitiveExists, false);
  });

  test('新連上的前端：沒變也推一份', async () => {
    posted = [];
    await controller.handle({ type: 'ready' });
    assert.equal(all('checkTerms').length, 1);
  });

  test('宿主沒有內建編輯器（沒有 openInEditor）：不推', async () => {
    const plain = makeFakeHost({ name: 'vscode', settings: () => makeSettings({ contextWindow: 100000 }) });
    bundle.host.initHost(plain.host);
    try {
      t.write('.novelwarden/style.md', '# 文風指南\n\n## 禁用詞表\n\n- 不用「剎那」\n');
      posted = [];
      await controller.handle({ type: 'ready' });
      await controller.pushState();
      assert.equal(all('checkTerms').length, 0);
    } finally {
      bundle.host.initHost(fake.host);
    }
  });
});

describe('編輯敏感詞表…', () => {
  before(() => {
    t.remove(SENSITIVE);
  });

  test('沒有：經閘道器新建一份帶說明註釋的模板，然後在編輯器裡開啟它', async () => {
    openedInEditor.length = 0;
    posted = [];
    await controller.handle({ type: 'editSensitiveWords' });
    assert.equal(t.has(SENSITIVE), true);
    const text = t.read(SENSITIVE);
    assert.match(text, /^# 敏感詞表/);
    assert.match(text, /=>/);
    assert.deepEqual(openedInEditor, [SENSITIVE]);
  });

  test('新建之後當場推一份詞表（檔案在了，一個詞都還沒生效）', () => {
    const terms = lastOf('checkTerms').terms;
    assert.equal(terms.sensitiveExists, true);
    assert.deepEqual(terms.sensitive, []);
  });

  test('已經有了：只開啟，一個字都不改', async () => {
    t.write(SENSITIVE, '賭博 => 博戲\n');
    openedInEditor.length = 0;
    await controller.handle({ type: 'editSensitiveWords' });
    assert.equal(t.read(SENSITIVE), '賭博 => 博戲\n');
    assert.deepEqual(openedInEditor, [SENSITIVE]);
  });

  test('還不是小說工程：不建檔案、不開啟，說一句為什麼', async () => {
    const dir = makeTempDir('check-bare');
    const bare = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    const out = [];
    bare.attach({ kind: 'sidebar', post: (m) => out.push(m), reveal() {} });
    openedInEditor.length = 0;
    try {
      await bare.handle({ type: 'editSensitiveWords' });
      assert.equal(dir.has(SENSITIVE), false);
      assert.deepEqual(openedInEditor, []);
      assert.match(out.find((m) => m.type === 'toast')?.message ?? '', /還不是小說工程/);
    } finally {
      bare.dispose();
      cleanup(dir.dir, bundle.db);
    }
  });
});

describe('sensitive.txt 經閘道器：種類、儲存、歷史版本', () => {
  test('種類是 sensitive（不是 other）：鏈外、沒有創作階段', () => {
    const k = bundle.kind.kindOfPath(t.project, SENSITIVE);
    assert.equal(k.kind, 'sensitive');
    assert.equal(k.stage, undefined);
    assert.equal(k.target, undefined);
  });

  test('編輯器儲存經閘道器（樂觀鎖），舊內容留一版歷史', async () => {
    const before = t.read(SENSITIVE);
    const baseHash = bundle.hash.hash(before);
    assert.equal(await bundle.history.historyUnavailable(t.project, SENSITIVE), undefined);
    await bundle.fileEditing.writeFileFromEditor(t.dir, SENSITIVE, '賭博 => 博戲\n殺人\n', baseHash);
    assert.equal(t.read(SENSITIVE), '賭博 => 博戲\n殺人\n');
    const snaps = await bundle.history.listSnapshots(t.project, SENSITIVE);
    assert.equal(snaps.length, 1);
    assert.equal(await bundle.history.readSnapshot(t.project, SENSITIVE, snaps[0].id), before);
  });

  test('磁碟上被別處改過：儲存被拒、不覆蓋（與別的檔案同一套樂觀鎖）', async () => {
    t.write(SENSITIVE, '別處改的\n');
    await assert.rejects(
      bundle.fileEditing.writeFileFromEditor(t.dir, SENSITIVE, '編輯器裡的\n', bundle.hash.hash('賭博 => 博戲\n殺人\n')),
      (err) => err.name === 'FileConflictError'
    );
    assert.equal(t.read(SENSITIVE), '別處改的\n');
  });
});
