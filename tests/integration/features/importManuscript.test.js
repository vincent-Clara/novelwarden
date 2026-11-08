/**
 * 匯入原稿（拆書 A 的前一半，features/importManuscript.ts）：工程裡的一本 txt → `chapters/NNN-標題.md`。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只列工程裡的 txt，章節檔案與隱藏目錄裡的不算 | 不拿章節去拆、不讀工程外 |
 * | 確認框報章數、章號區間、丟掉了什麼，寫明不調模型 | 切的結果作者看過才落盤 |
 * | 正文一段一行，標題進檔名；簡介、卷標題、目錄不匯入 | 原稿進來就是能接著寫的樣子 |
 * | 接在已有章節之後 | 一條軸（第 8 條），不撞號 |
 * | 認不出章標題：不彈確認框、一個檔案都不寫 | 不把整本當一章塞進來 |
 * | GBK 照讀 | 中文 txt 一大半是 GBK |
 * | 匯入完問一句要不要接著補齊；不接就零呼叫 | 第 4 條：調模型的那一步另報次數 |
 * | agent 給的路徑只認清單裡的 | 第 25 條：不越過既有的閘門 |
 * | 歡迎頁先看一眼（`inspectBookFile`）：認出幾章、說明與確認框同一份，不寫任何檔案 | 認不出章就不建工程 |
 * | 歡迎頁帶來的那一本（`hostPath`）：不彈選擇器、不再問切分結果，照樣問要不要接著補齊 | 表單就是那一問 |
 * | 還沒配模型：不問「接著補齊」，說清先去設定配模型 | 不彈一個點了就報錯的框 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
const projects = [];
/** 置 true 時設定裡一個服務商都沒有（剛上手、還沒配模型）。 */
let noModel = false;

const BOOK = [
  '青雲劍錄',
  '作者：某某',
  '',
  '目錄',
  '第一章 入宗',
  '第二章 雪夜',
  '',
  '第一卷 少年遊',
  '第一章 入宗',
  '　　林昭站在山門前。',
  '　　“你來晚了。”沈青說。',
  '第二章 雪夜',
  '雪下了一夜。',
  '第二卷 江湖遠',
  '第三章',
  '天亮了，林昭下山。',
].join('\n');

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    importer: './src/core/features/importManuscript.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () =>
      noModel
        ? {}
        : { providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: () => '' });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '匯入測試' });
  projects.push(t);
  fake.reset();
  return t;
}

describe('匯入原稿 · 挑檔案', () => {
  test('只列工程裡的 txt：章節檔案、隱藏目錄裡的不算', async () => {
    const t = await fresh('import-list');
    t.write('原稿.txt', BOOK);
    t.write('參考/別人的書.txt', BOOK);
    t.write('chapters/001-楔子.txt', '一章 txt 正文');
    t.write('.novelwarden/import/藏著的.txt', BOOK);
    t.project.invalidate();
    const files = await t.project.listImportableTexts();
    assert.deepEqual(files.map((f) => f.relPath).sort(), ['原稿.txt', '參考/別人的書.txt'].sort());
  });

  test('工程裡一本 txt 都沒有：說清放哪，不彈選擇框', async () => {
    const t = await fresh('import-none');
    h.expect();
    const r = await bundle.importer.importManuscript(t.project);
    assert.deepEqual(r, { imported: 0, calls: 0 });
    assert.equal(h.picks.length, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('把整本 txt 放進工程目錄')), h.toasts.join('|'));
  });
});

describe('匯入原稿 · 切章落盤', () => {
  let t;
  let r;
  let confirm;
  before(async () => {
    t = await fresh('import-ok');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    // 選檔案 → 匯入 → 不接著補齊
    h.expect('原稿.txt', '匯入', undefined);
    r = await bundle.importer.importManuscript(t.project);
    confirm = h.confirms[0];
  });

  test('確認框報章數、區間、丟掉了什麼，寫明不調模型', () => {
    assert.match(confirm.message, /^從《原稿》認出 3 章（\d+ 字），匯入為第 1–3 章？這一步不呼叫模型。$/);
    assert.match(confirm.detail, /UTF-8/);
    assert.match(confirm.detail, /第 1 章《入宗》（原文「第一章 入宗」/);
    assert.match(confirm.detail, /第一個章標題之前的 \d+ 字（「青雲劍錄 作者：某某 目錄」）不匯入/);
    assert.match(confirm.detail, /2 行卷標題（第一卷 少年遊、第二卷 江湖遠）不算章/);
    assert.match(confirm.detail, /2 個標題下面沒有正文（多半是目錄），跳過/);
  });

  // 正文一律出 .txt（2026-10-24），純文字不寫標題行：標題只在檔名裡。
  test('一章一個 .txt，標題進檔名，一段一行', () => {
    assert.deepEqual(r, { imported: 3, calls: 0 });
    assert.equal(t.read('chapters/001-入宗.txt'), '林昭站在山門前。\n\n“你來晚了。”沈青說。\n');
    assert.equal(t.read('chapters/002-雪夜.txt'), '雪下了一夜。\n');
    // 「第三章」一行沒有章名：純序號名。
    assert.equal(t.read('chapters/003.txt'), '天亮了，林昭下山。\n');
    // 原 txt 不動。
    assert.equal(t.read('原稿.txt'), BOOK);
  });

  test('匯入完問要不要接著補齊；不接就零呼叫', () => {
    assert.match(h.confirms[1].message, /^已匯入第 1–3 章。接著從已寫正文補齊/);
    assert.equal(fake.callCount(), 0);
  });

  test('工程認得出這三章', async () => {
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.deepEqual(chapters.map((c) => [c.order, c.title]), [[1, '入宗'], [2, '雪夜'], [3, '第 3 章']]);
  });
});

describe('匯入原稿 · 邊角', () => {
  test('接在已有章節之後', async () => {
    const t = await fresh('import-append');
    t.write('chapters/001-舊稿.md', '# 舊稿\n\n作者早先寫的。\n');
    t.write('續稿.txt', '第一章 新的\n新寫的一章。');
    t.project.invalidate();
    h.expect('續稿.txt', '匯入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 1);
    assert.match(h.confirms[0].message, /匯入為第 2 章/);
    assert.match(h.confirms[0].detail, /工程裡已經有 1 章，接在第 1 章之後/);
    assert.equal(t.read('chapters/002-新的.txt'), '新寫的一章。\n');
    assert.equal(t.read('chapters/001-舊稿.md'), '# 舊稿\n\n作者早先寫的。\n');
  });

  test('認不出章標題：不彈確認框，一個檔案都不寫', async () => {
    const t = await fresh('import-noheads');
    t.write('散文.txt', '從前有座山。\n山裡有座廟。');
    t.project.invalidate();
    h.expect('散文.txt', '匯入');
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('認不出章節標題')));
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
  });

  test('GBK 編碼照讀，確認框寫明編碼', async () => {
    const t = await fresh('import-gbk');
    // 「第一章 雪夜\n雪下了一夜。」的 GBK 編碼
    const bytes = Buffer.from('b5dad2bbd5c220d1a9d2b90ad1a9cfc2c1cbd2bbd2b9a1a3', 'hex');
    fs.writeFileSync(t.rel('舊稿.txt'), bytes);
    t.project.invalidate();
    h.expect('舊稿.txt', '匯入', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 1);
    assert.match(h.confirms[0].detail, /GBK/);
    assert.equal(t.read('chapters/001-雪夜.txt'), '雪下了一夜。\n');
  });

  test('作者取消：一個檔案都不寫', async () => {
    const t = await fresh('import-cancel');
    t.write('原稿.txt', BOOK);
    t.project.invalidate();
    h.expect('原稿.txt', undefined);
    const r = await bundle.importer.importManuscript(t.project);
    assert.equal(r.imported, 0);
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
  });

  test('agent 給的路徑只認清單裡的：章節檔案、工程外都拒絕', async () => {
    const t = await fresh('import-path');
    t.write('chapters/001-楔子.txt', '第一章 楔子\n正文');
    t.project.invalidate();
    await assert.rejects(() => bundle.importer.importManuscript(t.project, { path: 'chapters/001-楔子.txt' }), /不是工程裡能拆的 txt/);
    await assert.rejects(() => bundle.importer.importManuscript(t.project, { path: '../外面.txt' }), /不是工程裡能拆的 txt/);
  });
});

describe('匯入原稿 · 歡迎頁帶來的那一本', () => {
  const { makeTempDir } = require('../../helpers/tmpProject');
  /** 工程外的一本 txt（歡迎頁在本機任意處挑的）。 */
  function outsideBook(name, text) {
    const t = makeTempDir('import-host');
    projects.push(t);
    t.write(name, text);
    return t.rel(name);
  }

  test('先看一眼：認出幾章、導成第幾章、丟掉了什麼，與確認框同一份；不寫任何檔案', async () => {
    const abs = outsideBook('原稿.txt', BOOK);
    const r = await bundle.importer.inspectBookFile(abs);
    assert.equal(r.path, abs);
    assert.equal(r.title, '原稿');
    assert.equal(r.chapters, 3);
    assert.match(r.headline, /^從《原稿》認出 3 章（\d+ 字），匯入為第 1–3 章$/);
    assert.ok(r.detail.some((l) => /第 1 章《入宗》（原文「第一章 入宗」/.test(l)), r.detail.join('|'));
    assert.ok(r.detail.some((l) => l.includes('2 行卷標題')), r.detail.join('|'));
    assert.ok(r.detail.some((l) => l.includes('chapters/NNN-标题.txt')), r.detail.join('|'));
    assert.equal(r.error, undefined);
    assert.deepEqual(fs.readdirSync(require('path').dirname(abs)), ['原稿.txt']);
  });

  test('認不出章、讀不到：chapters 為 0，原因在 error', async () => {
    const r = await bundle.importer.inspectBookFile(outsideBook('散文.txt', '從前有座山。\n山裡有座廟。'));
    assert.equal(r.chapters, 0);
    assert.match(r.error, /認不出章節標題/);
    const gone = await bundle.importer.inspectBookFile(require('path').join(require('os').tmpdir(), 'nf-沒有這本書.txt'));
    assert.equal(gone.chapters, 0);
    assert.match(gone.error, /讀不到/);
  });

  test('帶著 hostPath 匯入：不彈選擇器、不再問切分結果，導完照樣問要不要接著補齊', async () => {
    const t = await fresh('import-host-ok');
    const abs = outsideBook('青雲劍錄.txt', BOOK);
    h.expect(undefined);
    const r = await bundle.importer.importManuscript(t.project, { hostPath: abs });
    assert.deepEqual(r, { imported: 3, calls: 0 });
    assert.equal(h.picks.length, 0);
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0].message, /^已匯入第 1–3 章。接著從已寫正文補齊/);
    assert.equal(t.read('chapters/001-入宗.txt'), '林昭站在山門前。\n\n“你來晚了。”沈青說。\n');
    assert.equal(fake.callCount(), 0);
  });

  test('還沒配模型：導完不問「接著補齊」，說清先去設定配一個', async () => {
    const t = await fresh('import-host-nomodel');
    const abs = outsideBook('原稿.txt', BOOK);
    noModel = true;
    try {
      h.expect();
      const r = await bundle.importer.importManuscript(t.project, { hostPath: abs });
      assert.deepEqual(r, { imported: 3, calls: 0 });
      assert.equal(h.confirms.length, 0);
      assert.ok(h.toasts.some((x) => x.includes('已匯入第 1–3 章') && x.includes('先到「設定」配一個模型')), h.toasts.join('|'));
    } finally {
      noModel = false;
    }
  });
});
