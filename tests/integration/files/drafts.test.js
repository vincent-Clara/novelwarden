/**
 * 草稿：每章在 drafts/ 下的映象，按需建立、絕不覆蓋、不進章節樹也不進上下文。
 * 遷自 scripts/smoke-chapters.js 的草稿各節（40 條）。
 *
 * 分家說明：章節掃描/可編輯判定/createChapter 在同目錄的 chapters.test.js；
 * 原 `== manifest 認得非 .md 章節 ==` 3 條裡，只有「manifest 裡沒有草稿」在本檔案
 * （它要求草稿真的存在才有意義），另兩條在 chapters.test.js。3 = 1 + 2。
 *
 * 原指令碼在草稿各節之前還跑過 `== createChapter ==` 一節（建 009/010 再刪掉並 invalidate），
 * 磁碟與 manifest 均無殘留，故此處略去，不影響任何斷言。
 *
 * 時序敏感：草稿會被改名/移動搬走，凡是讀草稿內容或 has() 的斷言，
 * 都在操作後**當場**取值存進變數——等到斷言時再讀，檔案早就不在原路徑了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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


describe('草稿', () => {
  let projectView;
  let fileOps;
  let attachments;
  let h;
  let project;
  let dir;
  let rel;
  let write;
  let read;
  let has;

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
    ({ projectView, fileOps, attachments } = bundle);
    // 原指令碼的 host 字面量裡沒有 reviewReplace，顯式抹掉，別走進 diff 審閱分支。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'drafts', title: '章節格式測試' });
    ({ dir, rel, write, read, has, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
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

  describe('草稿路徑推導', () => {
    test('根目錄 .md 章節', () => {
      assert.equal(
        project.draftRelPathFor('chapters/001-楔子.md'),
        'drafts/001-楔子.md',
        project.draftRelPathFor('chapters/001-楔子.md')
      );
    });

    test('子目錄映象層級', () => {
      assert.equal(
        project.draftRelPathFor('chapters/卷一/003-夜访.md'),
        'drafts/卷一/003-夜访.md',
        project.draftRelPathFor('chapters/卷一/003-夜访.md')
      );
    });

    test('.txt 章節草稿也是 .txt', () => {
      assert.equal(
        project.draftRelPathFor('chapters/002-手記.txt'),
        'drafts/002-手記.txt',
        project.draftRelPathFor('chapters/002-手記.txt')
      );
    });

    test('無副檔名章節草稿也無副檔名', () => {
      assert.equal(
        project.draftRelPathFor('chapters/004-無副檔名'),
        'drafts/004-無副檔名',
        project.draftRelPathFor('chapters/004-無副檔名')
      );
    });

    test('章節根之外的路徑沒有草稿', () => {
      assert.equal(
        project.draftRelPathFor('.novelwarden/characters/林昭.md'),
        undefined,
        project.draftRelPathFor('.novelwarden/characters/林昭.md')
      );
    });
  });

  describe('草稿按需建立，絕不覆蓋', () => {
    let first;
    let firstExists;
    let firstHead;
    let secondBody;
    let txtDraftBody;
    let paths;

    before(async () => {
      const md = await project.getChapter(1);
      first = await wsOf(project).ensureDraft(md);
      firstExists = has(first);
      firstHead = read(first);

      // 作者往草稿裡寫了東西，再點一次「開啟草稿」不能被抹掉。
      write(first, '# 楔子 · 草稿\n\n這段是我自己寫的，不能丟。\n');
      const second = await wsOf(project).ensureDraft(md);
      secondBody = read(second);

      const txt = await project.getChapter(2);
      const txtDraft = await wsOf(project).ensureDraft(txt);
      txtDraftBody = read(txtDraft);

      paths = await project.listDraftPaths();
    });

    test('返回草稿相對路徑', () => {
      assert.equal(first, 'drafts/001-楔子.md', first);
    });

    test('草稿已落盤', () => {
      assert.ok(firstExists);
    });

    test('markdown 草稿帶模板頭', () => {
      assert.ok(firstHead.startsWith('# 楔子 · 草稿'), firstHead.slice(0, 20));
    });

    test('第二次呼叫不覆蓋已有草稿', () => {
      assert.ok(secondBody.includes('這段是我自己寫的'), secondBody);
    });

    test('.txt 章節的草稿是空檔案（不塞 markdown）', () => {
      assert.equal(txtDraftBody, '', JSON.stringify(txtDraftBody));
    });

    test('listDraftPaths 收到兩份', () => {
      assert.equal(paths.size, 2, `got ${paths.size}`);
    });

    test('集合裡是工作區相對路徑', () => {
      assert.ok(paths.has('drafts/001-楔子.md'), [...paths].join(','));
      assert.ok(paths.has('drafts/002-手記.txt'), [...paths].join(','));
    });
  });

  describe('草稿不混進章節與工程樹', () => {
    let chapters;
    let flat;
    let withDraft;
    let noDraft;

    before(async () => {
      project.invalidate();
      chapters = await project.listChapters();

      // 工程樹只有一條章節列表（規劃與成品合在一起），本身就是扁平的。
      const tree = await projectView.buildProjectTree(project);
      flat = tree.plots;

      withDraft = flat.find((n) => n.no === 1);
      noDraft = flat.find((n) => n.no === 3);
    });

    test('drafts/ 裡的檔案不算章節', () => {
      assert.ok(
        !chapters.some((c) => c.relPath.startsWith('drafts/')),
        chapters.map((c) => c.relPath).join(',')
      );
    });

    test('章節數沒變', () => {
      assert.equal(chapters.length, 4, `got ${chapters.length}`);
    });

    test('樹上沒有 drafts 節點', () => {
      assert.ok(
        !flat.some((n) => n.relPath.startsWith('drafts/')),
        flat.map((n) => n.relPath).join(',')
      );
    });

    test('已建草稿的章節 hasDraft 為真', () => {
      assert.equal(withDraft.hasDraft, true);
    });

    test('帶上 draftPath', () => {
      assert.equal(withDraft.draftPath, 'drafts/001-楔子.md', withDraft.draftPath);
    });

    test('未建草稿的章節 hasDraft 為假', () => {
      assert.equal(noDraft.hasDraft, false);
    });

    test('未建也給出 draftPath（路徑是推匯出來的）', () => {
      assert.equal(noDraft.draftPath, 'drafts/卷一/003-夜访.md', noDraft.draftPath);
    });

    test('草稿不是可管理區', () => {
      assert.equal(fileOps.sectionOf(project, 'drafts/001-楔子.md'), undefined);
    });
  });

  describe('@ 引用裡的草稿組', () => {
    let choices;
    let drafts;

    before(async () => {
      choices = await attachments.listAttachmentChoices(project);
      drafts = choices.filter((c) => c.group === '草稿');
    });

    test('只列已存在的草稿', () => {
      assert.equal(drafts.length, 2, `got ${drafts.length}`);
    });

    test('標籤帶「· 草稿」', () => {
      assert.ok(
        drafts.every((d) => d.label.includes('· 草稿')),
        drafts.map((d) => d.label).join(' | ')
      );
    });

    test('detail 指向 drafts/', () => {
      assert.ok(
        drafts.every((d) => d.detail.startsWith('drafts/')),
        drafts.map((d) => d.detail).join(' | ')
      );
    });

    test('章節組不受影響', () => {
      assert.equal(choices.filter((c) => c.group === '章節').length, 4);
    });
  });

  describe('草稿跟隨章節改名 / 移動', () => {
    let renamed;
    let oldDraftGone;
    let renamedDraftExists;
    let renamedDraftBody;
    let moved;
    let movedDraftExists;
    let movedOldDraftGone;
    let txtRenamed;
    let txtBodyBefore;
    let txtBodyAfter;
    let txtDraftExists;

    before(async () => {
      h.expect('楔子改名');
      renamed = await fileOps.renameEntry(project, 'chapters/001-楔子.md');
      oldDraftGone = !has('drafts/001-楔子.md');
      renamedDraftExists = has('drafts/001-楔子改名.md');
      // 這份草稿馬上會被下面的移動搬到 drafts/歸檔/ 去，內容必須當場讀出來。
      renamedDraftBody = read('drafts/001-楔子改名.md');

      fs.mkdirSync(rel('chapters/歸檔'), { recursive: true });
      h.expect();
      moved = await fileOps.moveEntry(project, 'chapters/001-楔子改名.md', 'chapters/歸檔');
      movedDraftExists = has('drafts/歸檔/001-楔子改名.md');
      movedOldDraftGone = !has('drafts/001-楔子改名.md');

      // .txt 章節改名：不該往正文裡塞 H1。
      txtBodyBefore = read('chapters/002-手記.txt');
      h.expect('手記改名');
      txtRenamed = await fileOps.renameEntry(project, 'chapters/002-手記.txt');
      txtBodyAfter = read(txtRenamed);
      txtDraftExists = has('drafts/002-手記改名.txt');
    });

    test('章節已改名', () => {
      assert.equal(renamed, 'chapters/001-楔子改名.md', renamed);
    });

    test('舊草稿已不在', () => {
      assert.ok(oldDraftGone);
    });

    test('草稿跟著改名', () => {
      assert.ok(renamedDraftExists);
    });

    test('草稿內容原樣帶過去', () => {
      assert.ok(renamedDraftBody.includes('這段是我自己寫的'), renamedDraftBody);
    });

    test('章節已移動', () => {
      assert.equal(moved, 'chapters/歸檔/001-楔子改名.md', moved);
    });

    test('草稿跟著移動', () => {
      assert.ok(movedDraftExists);
    });

    test('舊位置草稿已清掉', () => {
      assert.ok(movedOldDraftGone);
    });

    test('.txt 章節改名保留序號字首', () => {
      assert.equal(txtRenamed, 'chapters/002-手記改名.txt', txtRenamed);
    });

    test('.txt 章節正文一個位元組沒動', () => {
      assert.equal(txtBodyAfter, txtBodyBefore);
    });

    test('.txt 草稿也跟著改名', () => {
      assert.ok(txtDraftExists);
    });
  });

  describe('目標已有草稿時不覆蓋', () => {
    let targetBody;
    let oldDraftKept;
    let oldDraftBody;
    let toastSnapshot;

    before(async () => {
      write('chapters/007-甲.md', '# 甲\n\n正文\n');
      project.invalidate();
      const seven = await project.getChapter(7);
      await wsOf(project).ensureDraft(seven);
      write('drafts/007-甲.md', '舊草稿');
      // 提前佔位：改名後的目標草稿已經存在。
      write('drafts/007-乙.md', '佔位的新草稿');

      h.expect('乙');
      await fileOps.renameEntry(project, 'chapters/007-甲.md');
      targetBody = read('drafts/007-乙.md');
      oldDraftKept = has('drafts/007-甲.md');
      oldDraftBody = read('drafts/007-甲.md');
      toastSnapshot = [...h.toasts];
    });

    test('目標草稿未被覆蓋', () => {
      assert.equal(targetBody, '佔位的新草稿', targetBody);
    });

    test('舊草稿留在原處', () => {
      assert.ok(oldDraftKept);
      assert.equal(oldDraftBody, '舊草稿');
    });

    test('給出了提示', () => {
      assert.ok(
        toastSnapshot.some((t) => t.startsWith('error:') && t.includes('drafts/007-乙.md')),
        toastSnapshot.join(' | ')
      );
    });
  });

  describe('刪章節不刪草稿', () => {
    let trashed;
    let draftKept;

    before(async () => {
      h.expect('刪除');
      await fileOps.deleteEntry(project, 'chapters/歸檔/001-楔子改名.md');
      trashed = has('.novelwarden/.trash/chapters/歸檔/001-楔子改名.md');
      draftKept = has('drafts/歸檔/001-楔子改名.md');
    });

    test('章節已進回收站', () => {
      assert.ok(trashed);
    });

    test('草稿沒被一起刪', () => {
      assert.ok(draftKept);
    });
  });

  /**
   * 草稿不進 manifest。
   *
   * manifest 索引的是 `chapters/` 裡的成品；`drafts/` 是它的映象目錄，
   * 與正文一一同名，掃岔一層就會讓每一章憑空多出一條索引。
   */
  describe('草稿不進 manifest', () => {
    let manifest;

    before(async () => {
      project.invalidate();
      manifest = await project.syncManifest();
    });

    test('manifest 裡沒有草稿', () => {
      assert.ok(
        !manifest.chapters.some((c) => c.file.startsWith('drafts/')),
        JSON.stringify(manifest.chapters.map((c) => c.file))
      );
    });

    // 反過來也要守：章節必須在，否則「不進草稿」可以靠索引全空來矇混過關。
    test('manifest 裡有章節', () => {
      assert.ok(
        manifest.chapters.every((c) => c.file.startsWith('chapters/')) && manifest.chapters.length > 0,
        JSON.stringify(manifest.chapters.map((c) => c.file))
      );
    });
  });
});
