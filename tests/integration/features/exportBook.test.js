/**
 * 匯出全文（`features/exportBook.ts`，2026-10-24）：全部章節按章號拼成一份 txt，寫到工程根下的 `匯出/<書名>.txt`。
 *
 * - 開頭《書名》與作者；章標題「第一章 楔子」（漢字章號），沒起名的只有「第二章」，標題已經帶章號的照原樣。
 * - 分卷的書進一卷之前單起一行卷名；更深的子目錄不出行。markdown 正文去掉 `# 標題` 行，`\r\n` 當 `\n`。
 * - 沒有正文的章不放進去；再導一次直接覆蓋，不審閱；超過閘道器 2MB 上限的也寫得下。
 * - `匯出/` 不掃成章節、不進匯入原稿的清單。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('匯出全文', () => {
  let bundle;
  let h;
  let t;
  let project;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      exportBook: './src/core/features/exportBook.ts',
    });
    h = makeFakeHost();
    bundle.host.initHost(h.host);
    t = await makeTempProject(bundle.project, { prefix: 'export-book', title: '雪夜行' });
    project = t.project;
  });

  after(() => cleanup(t.dir));

  describe('標題行', () => {
    test('漢字章號 + 標題', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 1, title: '楔子' }), '第一章 楔子');
      assert.equal(bundle.exportBook.exportHeading({ order: 105, title: '夜奔' }), '第一百零五章 夜奔');
    });

    test('沒起名的章只有章號', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 12, title: '第 12 章' }), '第十二章');
    });

    test('標題已經帶章號的照原樣', () => {
      assert.equal(bundle.exportBook.exportHeading({ order: 4, title: '第四章-風起' }), '第四章-風起');
    });
  });

  describe('還沒有章節', () => {
    let result;

    before(async () => {
      h.expect();
      result = await bundle.exportBook.exportBookText(project);
    });

    test('只提示，不寫檔案', () => {
      assert.equal(result, undefined);
      assert.ok(h.erred());
      assert.ok(!t.has('导出/雪夜行.txt'));
    });
  });

  describe('拼成一份', () => {
    let result;
    let text;
    let toasts;
    let chapterPaths;
    let importable;

    before(async () => {
      t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      t.write('chapters/002.txt', '他走進青崖鎮。\r\n\r\n鎮上很靜。\r\n');
      t.write('chapters/第二卷/003-夜訪.txt', '三更時分。\n');
      t.write('chapters/第二卷/深處/004-第四章-風起.txt', '風起了。');
      t.write('chapters/第二卷/005-空章.txt', '');
      t.write('chapters/第三卷/011-遠方.txt', '遠方。\n');
      t.write('原稿.txt', '一本要匯入的書。\n');
      project.invalidate();
      h.expect();
      result = await bundle.exportBook.exportBookText(project);
      toasts = [...h.toasts];
      text = t.read('导出/雪夜行.txt');
      project.invalidate();
      chapterPaths = (await project.listChapters()).map((c) => c.relPath);
      importable = (await project.listImportableTexts()).map((x) => x.relPath);
    });

    test('寫到 匯出/<書名>.txt', () => {
      assert.deepEqual(result, { rel: '导出/雪夜行.txt', chapters: 5, skipped: 1 });
    });

    test('書名、作者、卷名、章標題與正文按章號排好', () => {
      assert.equal(
        text,
        [
          '《雪夜行》\n作者：測試',
          '第一章 楔子\n\n雨下了三天。',
          '第二章\n\n他走進青崖鎮。\n\n鎮上很靜。',
          '第二卷',
          '第三章 夜訪\n\n三更時分。',
          '第四章-風起\n\n風起了。',
          '第三卷',
          '第十一章 遠方\n\n遠方。',
        ].join('\n\n') + '\n'
      );
    });

    test('提示裡報了路徑、章數與沒放進去的空章', () => {
      assert.ok(toasts.some((x) => x.startsWith('info: 已匯出全文：导出/雪夜行.txt（5 章') && x.includes('1 章沒有正文')), toasts.join(' | '));
    });

    test('匯出的那份不算章節、不進匯入原稿的清單', () => {
      assert.ok(!chapterPaths.some((p) => p.startsWith('导出/')), chapterPaths.join(', '));
      assert.deepEqual(importable, ['原稿.txt']);
    });
  });

  describe('再導一次', () => {
    let text;
    let reviews;
    let confirms;

    before(async () => {
      t.write('chapters/001-楔子.md', '# 楔子\n\n雨停了。\n');
      // 超過閘道器的 2MB 上限：匯出的那份照樣寫得下。
      t.write('chapters/012-長章.txt', '長'.repeat(800 * 1024));
      project.invalidate();
      h.expect();
      await bundle.exportBook.exportBookText(project);
      reviews = h.reviewed.length;
      confirms = h.confirms.length;
      text = t.read('导出/雪夜行.txt');
    });

    test('直接覆蓋，不審閱、不確認', () => {
      assert.equal(reviews, 0);
      assert.equal(confirms, 0);
      assert.ok(text.includes('第一章 楔子\n\n雨停了。'), text.slice(0, 80));
      assert.ok(!text.includes('雨下了三天'));
    });

    test('超過 2MB 也寫得下', () => {
      assert.ok(Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024);
      assert.ok(text.includes('第十二章 長章'));
    });
  });
});
