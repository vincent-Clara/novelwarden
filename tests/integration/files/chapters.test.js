/**
 * 「什麼算章節」落到磁碟上的部分：任意字尾的掃描、可編輯判定、createChapter 的預設副檔名。
 * 遷自 scripts/smoke-chapters.js 的檔案系統半場（19 條）。
 *
 * 分家說明（三處，賬要對得上）：
 * - 本指令碼前兩節（`== 章節檔名規則 ==` 18 條、`== extractH1 只看首行 ==` 3 條）是純函式，
 *   不在本檔案，另見 unit 側。
 * - 草稿相關各節（40 條）在同目錄的 drafts.test.js。
 * - 原 `== manifest 認得非 .md 章節 ==` 那一節已隨「章節退出流水線」改寫：manifest
 *   索引的是釋出章節，見本檔案末尾那一節。
 *   「manifest 裡沒有草稿」那一條只有草稿真的存在時才有意義，放在 drafts.test.js。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 產物寫入搬進了 `core/workspace/`：正文落盤要在細綱上記 `writtenFrom`、
 * 建章節要同名報錯並同步 manifest、草稿按需建立但絕不覆蓋。`NovelProject`
 * 這一層只留領域查詢。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);


describe('章節檔案規則（磁碟）', () => {
  let projectView;
  let fileEditing;
  let project;
  let dir;
  let rel;
  let write;
  let read;
  let remove;

  before(async () => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      chapterFile: './src/core/model/chapterFile.ts',
      markdown: './src/core/model/markdown.ts',
      project: './src/core/model/project.ts',
      ws: './src/core/workspace/index.ts',
      projectView: './src/core/views/projectView.ts',
      fileOps: './src/core/files/fileOps.ts',
      fileEditing: './src/core/files/fileEditing.ts',
      attachments: './src/core/files/attachments.ts',
    });
    wsMod = bundle.ws;
    ({ projectView, fileEditing } = bundle);
    // 原指令碼的 host 字面量裡沒有 reviewReplace，顯式抹掉，別走進 diff 審閱分支。
    bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);

    const t = await makeTempProject(bundle.project, { prefix: 'chapters', title: '章節格式測試' });
    ({ dir, rel, write, read, remove, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    // 正文中段有一行像標題的字：不該被當成章節標題，也不該從正文裡消失。
    write('chapters/002-手記.txt', '他翻開筆記。\n\n# 這是紙上寫的字\n\n然後合上了。\n');
    write('chapters/卷一/003-夜访.md', '# 夜訪\n\n三更時分。\n');
    write('chapters/004-無副檔名', '沒有副檔名的一章。\n');
    write('chapters/005-封面.png', 'PNG 假裝');
    write('chapters/筆記.txt', '沒有數字字首，不是章節');
    write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    write('.novelwarden/characters/說明.txt', '角色區不放寬副檔名');
    project.invalidate();
  });

  after(() => cleanup(dir));

  describe('掃描：任意字尾', () => {
    let chapters;
    let txt;
    let txtBody;
    let md;
    let mdBody;
    let bare;
    let cards;

    before(async () => {
      chapters = await project.listChapters();
      txt = chapters.find((c) => c.order === 2);
      txtBody = await project.readChapterText(txt);
      md = chapters.find((c) => c.order === 1);
      mdBody = await project.readChapterText(md);
      bare = chapters.find((c) => c.order === 4);
      cards = await project.listCharacters();
    });

    test('掃到四章（.md / .txt / 無副檔名，跨子目錄）', () => {
      assert.equal(chapters.length, 4, `got ${chapters.length}`);
    });

    test('png 不算章節', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('.png')));
    });

    test('無數字字首的 txt 不算章節', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('筆記.txt')));
    });

    test('.txt 章節標題取自檔名，不吃正文裡的 #', () => {
      assert.equal(txt.title, '手記', txt.title);
    });

    test('.txt 章節正文原樣保留那行 #', () => {
      assert.ok(txtBody.includes('# 這是紙上寫的字'), txtBody);
    });

    test('.md 章節仍取 H1', () => {
      assert.equal(md.title, '楔子', md.title);
    });

    test('.md 章節 readChapterText 仍剝掉 H1', () => {
      assert.equal(mdBody, '雨下了三天。', mdBody);
    });

    test('無副檔名章節標題取自檔名', () => {
      assert.equal(bare.title, '無副檔名', bare.title);
    });

    test('角色區仍然只認 .md', () => {
      assert.equal(cards.length, 1, `got ${cards.length}`);
      assert.equal(cards[0].name, '林昭', `got ${cards.length}`);
    });
  });

  describe('可編輯判定', () => {
    test('無副檔名章節可編輯', () => {
      assert.ok(fileEditing.isEditablePath('chapters/004-無副檔名'));
    });

    test('.rtf 章節可編輯', () => {
      assert.ok(fileEditing.isEditablePath('chapters/006-手記.rtf'));
    });

    test('.png 不可編輯', () => {
      assert.ok(!fileEditing.isEditablePath('chapters/005-封面.png'));
    });

    test('白名單裡的 json 仍可編輯', () => {
      assert.ok(fileEditing.isEditablePath('.novelwarden/project.json'));
    });

    test('非章節的 png 不可編輯', () => {
      assert.ok(!fileEditing.isEditablePath('media/icon.png'));
    });
  });

  // 2026-10-24 作者定：新建正文一律出 .txt（從前預設是 .md）；指定 .md 時照舊寫標題行。
  describe('createChapter 預設出 .txt', () => {
    let created;
    let createdHead;
    let txt;
    let txtBody;
    let bare;
    let bareBody;
    let bareTitle;
    let bareWords;

    before(async () => {
      created = await wsOf(project).createChapter(9, '新章', '', undefined, '.md');
      createdHead = read(created);
      txt = await wsOf(project).createChapter(10, '純文字章', '正文', undefined);
      txtBody = read(txt);
      // 流水線新建那條路：還沒有標題可言，落成純序號名。
      bare = await wsOf(project).createChapter(11, '', '', undefined);
      bareBody = read(bare);
      project.invalidate();
      const scanned = (await project.listChapters()).find((c) => c.relPath === bare);
      bareTitle = scanned && scanned.title;
      bareWords = scanned && scanned.wordCount;
    });

    after(() => {
      remove(created);
      remove(txt);
      remove(bare);
      project.invalidate();
    });

    test('指定 .md 時檔名帶 .md', () => {
      assert.equal(created, 'chapters/009-新章.md', created);
    });

    test('markdown 家族寫標題行', () => {
      assert.ok(createdHead.startsWith('# 新章'), createdHead.slice(0, 20));
    });

    test('預設是 .txt，不寫標題行', () => {
      assert.equal(txt, 'chapters/010-純文字章.txt', txt);
      assert.equal(txtBody, '正文\n', JSON.stringify(txtBody));
    });

    test('標題留空時檔名只有序號', () => {
      assert.equal(bare, 'chapters/011.txt', bare);
    });

    // 不寫 `# `：空標題行既沒意義，又會讓改名時的 H1 同步判據從第一天就對不上。
    test('標題留空時不寫標題行', () => {
      assert.equal(bareBody.trim(), '', JSON.stringify(bareBody));
    });

    test('掃描時標題回落成「第 N 章」', () => {
      assert.equal(bareTitle, '第 11 章', bareTitle);
    });

    test('新建出來是 0 字', () => {
      assert.equal(bareWords, 0, String(bareWords));
    });
  });

  /**
   * manifest 索引的是**章節正文**：字數、正文 hash 描述的全是 `chapters/` 裡的檔案。
   * 細綱不進索引（它的新鮮度與定稿記在自己的 frontmatter 裡：upstreamHash / writtenFrom / sourceHash）。
   *
   * 任意副檔名都算章節（`.txt` / 無副檔名 / `.json`），所以它們也都要進。
   */
  describe('manifest 索引章節', () => {
    let manifest;

    before(async () => {
      project.invalidate();
      manifest = await project.syncManifest();
    });

    test('manifest 裡是 chapters', () => {
      assert.ok(Array.isArray(manifest.chapters), JSON.stringify(Object.keys(manifest)));
      assert.equal(manifest.plots, undefined);
    });

    test('磁碟上有幾章就索引幾章', async () => {
      assert.equal(manifest.chapters.length, (await project.listChapters()).length);
    });

    // 非 markdown 的章一樣要進——它們照樣是正文。
    test('.txt 章節也進索引', () => {
      assert.ok(
        manifest.chapters.some((c) => c.file.endsWith('.txt')),
        JSON.stringify(manifest.chapters.map((c) => c.file))
      );
    });
  });
});
