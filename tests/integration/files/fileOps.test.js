/**
 * 層級目錄與類檔案操作：遞迴掃描、樹摺疊、路徑守衛，以及新建/重新命名/移動/刪除，
 * 外加細綱的懸停浮窗（計劃 / 定稿 / 過期）與細綱的改名、刪除。遷自 scripts/smoke-fileops.js。
 *
 * 時序敏感（兩類，都按「操作後當場取值」處理）：
 * - `erred()` 讀的是距上一次 expect() 以來攢下的 toast，晚一步取值就串味；
 * - 檔案會被改名/移動/刪除，`existsSync` / `read` 晚一步取值讀到的是後來的狀態。
 * 斷言只讀變數，不在 test 裡現算。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/**
 * 細綱的寫入在 `core/workspace/`：檔名由章號與標題共同決定、寫入要記上游指紋、
 * 刪除要進 `.trash/`，那些是閘道器的活。`NovelProject` 這一層只留領域查詢。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

describe('fileOps.ts', () => {
  let projectView;
  let fileOps;
  let charactersMod;
  let actionsMod;
  let pipe;
  let plotFile;
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
      project: './src/core/model/project.ts',
      ws: './src/core/workspace/index.ts',
      projectView: './src/core/views/projectView.ts',
      fileOps: './src/core/files/fileOps.ts',
      characters: './src/core/features/characters.ts',
      actions: './src/core/actions.ts',
      pipe: './src/core/views/pipeline.ts',
      plotFile: './src/core/model/plotFile.ts',
    });
    wsMod = bundle.ws;
    projectView = bundle.projectView;
    fileOps = bundle.fileOps;
    charactersMod = bundle.characters;
    actionsMod = bundle.actions;
    pipe = bundle.pipe;
    plotFile = bundle.plotFile;
    // 原指令碼的 host 字面量裡沒有 reviewReplace，必須顯式抹掉：
    // characters.ts 用 `host.reviewReplace ? … : host.confirm(…)` 分支，
    // 預設 fakeHost 帶著它會把用例送進另一條路徑。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'fileops', title: '層級測試' });
    ({ dir, rel, write, read, has, project } = t);
  });

  after(() => cleanup(dir));

  describe('遞迴掃描', () => {
    let chapters;
    let cards;
    let lore;
    let afterTrash;

    before(async () => {
      write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
      write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n他走進青崖鎮。\n');
      write('chapters/第一卷/深處/003-夜访.md', '# 夜訪\n\n三更時分。\n');
      write('chapters/第一卷/筆記.txt', '沒有數字字首，不是章節');
      write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n');
      write('.novelwarden/characters/配角/李叔.md', '---\nname: 李叔\n---\n\n# 李叔\n');
      write('.novelwarden/lore/勢力/玄門七宗.md', '---\ntitle: 玄門七宗\nkeywords: [玄門]\n---\n\n# 玄門七宗\n');
      project.invalidate();

      chapters = await project.listChapters();
      cards = await project.listCharacters();
      lore = await project.listLore();

      // .trash 裡的東西不能被掃回來，否則「刪除」等於沒刪。
      write('.novelwarden/.trash/.novelwarden/characters/已刪.md', '---\nname: 已刪\n---\n');
      afterTrash = await project.listCharacters();
    });

    test('掃到三層裡的全部章節', () => {
      assert.equal(chapters.length, 3, `got ${chapters.length}`);
    });

    test('順序由序號決定而非目錄深度', () => {
      assert.equal(chapters.map((c) => c.order).join(','), '1,2,3');
    });

    test('子目錄章節的 relPath 帶目錄', () => {
      assert.equal(chapters[2].relPath, 'chapters/第一卷/深處/003-夜访.md', chapters[2].relPath);
    });

    test('無數字字首的檔案不算章節', () => {
      assert.ok(!chapters.some((c) => c.relPath.endsWith('.txt')));
    });

    test('角色卡遞迴掃描', () => {
      assert.equal(cards.length, 2, `got ${cards.length}`);
    });

    test('子目錄角色的 slug 帶路徑字首', () => {
      const li = cards.find((c) => c.name === '李叔');
      assert.equal(li.slug, '配角/李叔', li.slug);
    });

    test('根目錄角色的 slug 與改造前一致', () => {
      assert.equal(cards.find((c) => c.name === '林昭').slug, '林昭');
    });

    test('設定遞迴掃描', () => {
      assert.equal(lore.length, 1, lore[0] && lore[0].slug);
      assert.equal(lore[0].slug, '勢力/玄門七宗', lore[0] && lore[0].slug);
    });

    test('回收站裡的檔案不參與掃描', () => {
      assert.equal(afterTrash.length, 2);
    });
  });

  /**
   * 章節列表是**扁平**的：一行一章，按章號排。
   *
   * `chapters/` 下的分卷子目錄只是作者的收納，不體現在這條列表上——
   * 流水線的順序才是這一層最要緊的資訊，折進目錄反而看不出來。
   * （目錄樹那套仍在角色/設定兩個區裡用，見本檔案後面幾節。）
   */
  describe('章節列表是扁平的', () => {
    let tree;

    before(async () => {
      fs.mkdirSync(rel('chapters/第二卷'), { recursive: true });
      project.invalidate();
      tree = await projectView.buildProjectTree(project);
    });

    test('子目錄裡的章也列得出來', () => {
      assert.ok(
        tree.plots.some((p) => p.chapterPath.includes('第一卷/')),
        tree.plots.map((p) => p.chapterPath).join(',')
      );
    });

    test('列表上沒有目錄節點', () => {
      assert.ok(tree.plots.every((p) => typeof p.no === 'number'));
    });

    // 每層內章節正序（第 1 章在上），與檔名順序一致。
    describe('同層排序', () => {
      let reordered;

      before(async () => {
        write('chapters/第一卷/004-後續.md', '# 後續\n\n再後來。\n');
        project.invalidate();
        reordered = (await projectView.buildProjectTree(project)).plots.map((p) => p.no);
      });

      // 004 必須清掉：後面「在資料夾裡新建」等著 004 這個序號。
      // 原指令碼把清理寫在斷言之後，斷言一掛就汙染後續小節；這裡掛 after() 保證一定跑。
      after(() => {
        fs.rmSync(rel('chapters/第一卷/004-後續.md'));
        project.invalidate();
      });

      // 分卷子目錄不參與排序：`第一卷/002` 與根下的 `003` 是同一條列表上的
      // 兩章，按章號排。
      test('章節按章號正序排列', () => {
        assert.equal(reordered.join(','), '1,2,3,4');
      });
    });

    test('chapterCount 是全書總章數', () => {
      assert.equal(tree.chapterCount, 3, String(tree.chapterCount));
    });

    // 這個工程只有 chapters/ 裡的成品、一份細綱都沒有——字數照樣算得出來，
    // 那正是「老工程開啟就能用」的樣子。
    test('totalWords 算的是成品的字數', () => {
      assert.ok(tree.totalWords > 0, String(tree.totalWords));
    });

    test('給出各區根目錄', () => {
      assert.equal(tree.chaptersRoot, 'chapters', tree.chaptersRoot);
      assert.equal(tree.charactersRoot, '.novelwarden/characters', tree.charactersRoot);
    });

    test('角色區頂層：一個資料夾 + 一個檔案', () => {
      assert.equal(tree.characters.filter((n) => n.kind === 'dir').length, 1);
      assert.equal(tree.characters.filter((n) => n.kind === 'file').length, 1);
    });
  });

  describe('路徑守衛', () => {
    let norm;

    before(() => {
      norm = fileOps.normalizeRel;
    });

    test('拒絕 ..', () => {
      assert.equal(norm('../外面'), undefined);
    });

    test('拒絕夾在中間的 ..', () => {
      assert.equal(norm('chapters/../../外面'), undefined);
    });

    test('拒絕絕對路徑', () => {
      assert.equal(norm('/etc/passwd'), undefined);
      assert.equal(norm('C:/Windows'), undefined);
    });

    test('拒絕空路徑', () => {
      assert.equal(norm(''), undefined);
      assert.equal(norm('   '), undefined);
    });

    test('反斜槓歸一為正斜槓', () => {
      assert.equal(norm('chapters\\第一卷'), 'chapters/第一卷');
    });

    test('去掉結尾斜槓', () => {
      assert.equal(norm('chapters/第一卷/'), 'chapters/第一卷');
    });

    test('內部 . 被摺疊', () => {
      assert.equal(norm('chapters/./卷一'), 'chapters/卷一');
    });

    test('識別章節區', () => {
      assert.equal(fileOps.sectionOf(project, 'chapters/001-楔子.md').section, 'chapters');
    });

    test('識別角色區', () => {
      assert.equal(
        fileOps.sectionOf(project, '.novelwarden/characters/林昭.md').section,
        'characters'
      );
    });

    test('區外路徑無歸屬', () => {
      assert.equal(fileOps.sectionOf(project, '.novelwarden/style.md'), undefined);
    });

    test('越界路徑無歸屬', () => {
      assert.equal(fileOps.sectionOf(project, '../x'), undefined);
    });
  });

  describe('新建資料夾', () => {
    let created;
    let createdExists;
    let nested;
    let dup;
    let dupErred;
    let escaped;
    let dirty;

    before(async () => {
      h.expect('第三卷');
      created = await fileOps.newFolder(project, 'chapters');
      createdExists = fs.existsSync(rel('chapters/第三卷'));

      h.expect('子卷');
      nested = await fileOps.newFolder(project, 'chapters', 'chapters/第三卷');

      h.expect('第三卷');
      dup = await fileOps.newFolder(project, 'chapters');
      dupErred = h.erred();

      h.expect('越界');
      escaped = await fileOps.newFolder(project, 'chapters', '../../外面');

      // 名字裡的非法字元被清洗，而不是原樣寫進檔案系統。
      h.expect('第四:卷?');
      dirty = await fileOps.newFolder(project, 'chapters');
    });

    test('建在區根目錄下', () => {
      assert.equal(created, 'chapters/第三卷', created);
    });

    test('目錄真的建出來了', () => {
      assert.ok(createdExists);
    });

    test('可建在子目錄下', () => {
      assert.equal(nested, 'chapters/第三卷/子卷', nested);
    });

    test('同名資料夾被拒絕', () => {
      assert.equal(dup, undefined);
      assert.ok(dupErred);
    });

    test('落點越界時退回區根目錄', () => {
      assert.equal(escaped, 'chapters/越界', escaped);
    });

    test('檔名非法字元被清洗', () => {
      assert.equal(dirty, 'chapters/第四卷', dirty);
    });
  });

  describe('在資料夾裡新建', () => {
    let chapterPath;
    let chapterBody;
    let chapterTitle;
    let inputCount;
    let nextOrder;
    let cardCreated;
    let loreCreated;
    let loreEscaped;
    let escaped;
    let crossed;

    before(async () => {
      // 新建章節先問名字（2026-10-23 作者定的，見 newChapter.test.js），留空就是純序號名——這裡答空串，看的是落點與序號。
      // 當場記下 input 次數（h.expect 會清空錄製，晚一步取值就歸零了）。
      h.expect('');
      chapterPath = await actionsMod.newChapterFlow(project, 'chapters/第三卷');
      inputCount = h.inputs.length;
      chapterBody = read(chapterPath);
      project.invalidate();
      const chapters = await project.listChapters();
      nextOrder = chapters.find((c) => c.order === 4);
      chapterTitle = nextOrder && nextOrder.title;

      h.expect('沈氏');
      await charactersMod.newCharacter(project, '.novelwarden/characters/配角');
      cardCreated = fs.existsSync(rel('.novelwarden/characters/配角/沈氏.md'));

      h.expect('崖字令牌');
      await charactersMod.newLore(project, '.novelwarden/lore/勢力');
      loreCreated = fs.existsSync(rel('.novelwarden/lore/勢力/崖字令牌.md'));

      h.expect('青崖鎮');
      await charactersMod.newLore(project, '../../外面');
      loreEscaped = fs.existsSync(rel('.novelwarden/lore/青崖鎮.md'));

      h.expect('');
      escaped = await actionsMod.newChapterFlow(project, '../../../外面');
      h.expect('');
      crossed = await actionsMod.newChapterFlow(project, '.novelwarden/characters');
    });

    test('章節建到指定目錄，名字留空就只有序號', () => {
      assert.equal(chapterPath, 'chapters/第三卷/004.txt', chapterPath);
    });

    test('新建先彈一次名字輸入框', () => {
      assert.equal(inputCount, 1, `${inputCount} 次 input`);
    });

    // 沒有標題就不寫標題行：`# ` 後面空著的 H1 會讓改名時的同步判據從第一天
    // 就對不上（renamedBody 拿空標題去比，永遠不匹配）。
    test('無標題時正文裡沒有 H1', () => {
      assert.equal(chapterBody.trim(), '', JSON.stringify(chapterBody));
    });

    test('標題回落成「第 N 章」', () => {
      assert.equal(chapterTitle, '第 4 章', chapterTitle);
    });

    test('序號仍是全書唯一的下一個', () => {
      assert.notEqual(nextOrder, undefined);
    });

    test('角色卡建到指定目錄', () => {
      assert.ok(cardCreated);
    });

    test('設定建到指定目錄', () => {
      assert.ok(loreCreated);
    });

    test('落點越界的設定退回區根目錄', () => {
      assert.ok(loreEscaped);
    });

    test('落點越界的章節退回 chapters/', () => {
      assert.equal(escaped, 'chapters/005.txt', escaped);
    });

    test('落點跨區的章節退回 chapters/', () => {
      assert.equal(crossed, 'chapters/006.txt', crossed);
    });
  });

  describe('重新命名', () => {
    let renamed;
    let renamedBody;
    let renamedTitle;
    let renamedAgain;
    let renamedAgainBody;
    let keptBody;
    let dirRenamed;
    let dirExists;
    let childrenFollowed;
    let cleaned;
    let cleanedBody;
    let againBody;
    let clash;
    let clashErred;
    let clashKept;
    let root;
    let rootErred;
    let outside;
    let outsideErred;

    before(async () => {
      // 純序號名（新建出來的樣子）第一次命名：序號後面沒有分隔符，得補一個 `-`。
      h.expect('新的一章');
      renamed = await fileOps.renameEntry(project, 'chapters/第三卷/004.txt');
      renamedBody = read(renamed);
      project.invalidate();
      const named = (await project.listChapters()).find((c) => c.relPath === renamed);
      renamedTitle = named && named.title;

      // 再改一次：這一次舊標題非空，走的是 H1 同步那條路（此時沒有 H1 可同步，
      // 正文仍該一字不動）。
      h.expect('新的一章改名');
      renamedAgain = await fileOps.renameEntry(project, renamed);
      renamedAgainBody = read(renamedAgain);

      // 作者手寫過的 H1 不該被改名順手改掉。
      write('chapters/008-佔位.md', '# 作者自己寫的標題\n\n正文。\n');
      project.invalidate();
      h.expect('改過的名');
      const kept = await fileOps.renameEntry(project, 'chapters/008-佔位.md');
      keptBody = read(kept);

      h.expect('第三卷改名');
      dirRenamed = await fileOps.renameEntry(project, 'chapters/第三卷');
      dirExists = fs.existsSync(rel(dirRenamed));
      project.invalidate();
      childrenFollowed = (await project.listChapters()).some((c) =>
        c.relPath.startsWith('chapters/第三卷改名/')
      );

      // 名字被清洗後，H1 要與清洗結果一致而不是與使用者原樣輸入一致——
      // 否則下次改名就認不出「這個 H1 是跟著檔名走的」，同步會斷掉。
      write('chapters/007-原名.md', '# 原名\n\n正文。\n');
      project.invalidate();
      h.expect('帶:非法?字元');
      cleaned = await fileOps.renameEntry(project, 'chapters/007-原名.md');
      cleanedBody = read(cleaned);

      h.expect('再改一次');
      const again = await fileOps.renameEntry(project, cleaned);
      againBody = read(again);

      h.expect('第一卷');
      clash = await fileOps.renameEntry(project, 'chapters/第二卷');
      clashErred = h.erred();
      clashKept = fs.existsSync(rel('chapters/第二卷'));

      h.expect('隨便什麼');
      root = await fileOps.renameEntry(project, 'chapters');
      rootErred = h.erred();

      h.expect('隨便什麼');
      outside = await fileOps.renameEntry(project, '.novelwarden/style.md');
      outsideErred = h.erred();
    });

    test('純序號名改名補上分隔符', () => {
      assert.equal(renamed, 'chapters/第三卷/004-新的一章.txt', renamed);
    });

    // 本來沒有 H1 的章節**不該被憑空塞進一行**：那會改動正文，contentHash
    // 一變這一章的定稿立刻過期，而作者只是給它起了個名字。標題從檔名取
    // 就夠了（listChapters 的回落鏈本來就這麼做）。
    test('無 H1 的章節改名後正文仍是空的', () => {
      assert.equal(renamedBody.trim(), '', JSON.stringify(renamedBody));
    });

    test('標題跟著檔名走', () => {
      assert.equal(renamedTitle, '新的一章', renamedTitle);
    });

    test('保留序號字首', () => {
      assert.equal(renamedAgain, 'chapters/第三卷/004-新的一章改名.txt', renamedAgain);
    });

    test('沒有 H1 時不會憑空補出一行', () => {
      assert.equal(renamedAgainBody.trim(), '', JSON.stringify(renamedAgainBody));
    });

    test('與檔名不一致的 H1 不動', () => {
      assert.ok(keptBody.startsWith('# 作者自己寫的標題'));
    });

    test('資料夾可重新命名', () => {
      assert.equal(dirRenamed, 'chapters/第三卷改名', dirRenamed);
      assert.ok(dirExists, dirRenamed);
    });

    test('裡面的章節跟著走', () => {
      assert.ok(childrenFollowed);
    });

    test('非法字元被清洗進檔名', () => {
      assert.equal(cleaned, 'chapters/007-帶非法字元.md', cleaned);
    });

    test('H1 與清洗後的檔名一致', () => {
      assert.ok(cleanedBody.startsWith('# 帶非法字元'), cleanedBody.slice(0, 20));
    });

    test('清洗後仍能繼續同步 H1', () => {
      assert.ok(againBody.startsWith('# 再改一次'), againBody.slice(0, 20));
    });

    test('重名被拒絕且原目錄還在', () => {
      assert.equal(clash, undefined);
      assert.ok(clashErred);
      assert.ok(clashKept);
    });

    test('區根目錄不能重新命名', () => {
      assert.equal(root, undefined);
      assert.ok(rootErred);
    });

    test('區外檔案不能操作', () => {
      assert.equal(outside, undefined);
      assert.ok(outsideErred);
    });
  });

  describe('移動', () => {
    let moved;
    let sourceEmptied;
    let bodyBefore;
    let bodyAfter;
    let landed;
    let cross;
    let crossErred;
    let intoSelf;
    let intoSelfErred;
    let escape;
    let escapeErred;
    let collide;
    let collideErred;
    let bothKept;
    let picked;

    before(async () => {
      // 移動只搬檔案，不動內容。manifest 已經不索引章節了（章節退出流水線，
      // 見 chapters.test.js 末尾那一節），所以拿正文自己前後比。
      bodyBefore = read('chapters/001-楔子.md');

      moved = await fileOps.moveEntry(project, 'chapters/001-楔子.md', 'chapters/第二卷');
      sourceEmptied = !fs.existsSync(rel('chapters/001-楔子.md'));

      project.invalidate();
      // 當場取值：後面幾步還會把它移來移去，晚一步讀到的是後來的狀態。
      landed = fs.existsSync(rel('chapters/第二卷/001-楔子.md'));
      bodyAfter = read('chapters/第二卷/001-楔子.md');

      h.expect();
      cross = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', '.novelwarden/characters');
      crossErred = h.erred();

      h.expect();
      intoSelf = await fileOps.moveEntry(project, 'chapters/第一卷', 'chapters/第一卷/深處');
      intoSelfErred = h.erred();

      h.expect();
      escape = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', '../../外面');
      escapeErred = h.erred();

      // 目標目錄已有同名檔案時必須拒絕，不能覆蓋。
      write('chapters/第一卷/001-楔子.md', '# 另一個楔子\n\n別的內容。\n');
      project.invalidate();
      h.expect();
      collide = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md', 'chapters/第一卷');
      collideErred = h.erred();
      bothKept =
        fs.existsSync(rel('chapters/第二卷/001-楔子.md')) &&
        read('chapters/第一卷/001-楔子.md').includes('另一個楔子');
      fs.rmSync(rel('chapters/第一卷/001-楔子.md'));

      // 不帶 targetDir 時走 Host.pick。
      project.invalidate();
      h.expect('chapters');
      picked = await fileOps.moveEntry(project, 'chapters/第二卷/001-楔子.md');
    });

    test('檔案移動到目標目錄', () => {
      assert.equal(moved, 'chapters/第二卷/001-楔子.md', moved);
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('新位置讀得到', () => {
      assert.ok(landed);
    });

    test('正文沒被改動', () => {
      assert.equal(bodyAfter, bodyBefore);
    });

    test('不能跨區移動', () => {
      assert.equal(cross, undefined);
      assert.ok(crossErred);
    });

    test('資料夾不能移進自己裡面', () => {
      assert.equal(intoSelf, undefined);
      assert.ok(intoSelfErred);
    });

    test('不能移出工程', () => {
      assert.equal(escape, undefined);
      assert.ok(escapeErred);
    });

    test('同名不覆蓋', () => {
      assert.equal(collide, undefined);
      assert.ok(collideErred);
    });

    test('兩份檔案都還在', () => {
      assert.ok(bothKept);
    });

    test('可經選擇框移回根目錄', () => {
      assert.equal(picked, 'chapters/001-楔子.md', picked);
    });
  });

  describe('刪除', () => {
    let ok;
    let sourceEmptied;
    let trashed;
    let countBefore;
    let countAfter;
    let noOverwrite;
    let cancelled;
    let cancelledKept;
    let dirDeleted;
    let dirGone;
    let subtreeTrashed;
    let orderGone;
    let root;
    let rootErred;
    let rootKept;
    let missing;
    let missingErred;

    before(async () => {
      write('chapters/009-待刪.md', '# 待刪\n\n第一份內容。\n');
      project.invalidate();
      countBefore = (await project.listChapters()).length;

      h.expect('刪除');
      ok = await fileOps.deleteEntry(project, 'chapters/009-待刪.md');
      sourceEmptied = !fs.existsSync(rel('chapters/009-待刪.md'));
      trashed = fs.existsSync(rel('.novelwarden/.trash/chapters/009-待刪.md'));
      project.invalidate();
      countAfter = (await project.listChapters()).length;

      // 同名再刪一次不能把回收站裡那份覆蓋掉。
      write('chapters/009-待刪.md', '# 待刪\n\n第二份內容。\n');
      project.invalidate();
      h.expect('刪除');
      await fileOps.deleteEntry(project, 'chapters/009-待刪.md');
      noOverwrite =
        fs.existsSync(rel('.novelwarden/.trash/chapters/009-待刪-2.md')) &&
        read('.novelwarden/.trash/chapters/009-待刪.md').includes('第一份內容');

      h.expect(undefined);
      cancelled = await fileOps.deleteEntry(project, 'chapters/第一卷');
      cancelledKept = fs.existsSync(rel('chapters/第一卷'));

      h.expect('刪除');
      dirDeleted = await fileOps.deleteEntry(project, 'chapters/第一卷');
      dirGone = !fs.existsSync(rel('chapters/第一卷'));
      subtreeTrashed = fs.existsSync(rel('.novelwarden/.trash/chapters/第一卷/深處/003-夜访.md'));
      project.invalidate();
      orderGone = !(await project.listChapters()).some((c) => c.order === 3);

      h.expect('刪除');
      root = await fileOps.deleteEntry(project, 'chapters');
      rootErred = h.erred();
      rootKept = fs.existsSync(rel('chapters'));

      h.expect('刪除');
      missing = await fileOps.deleteEntry(project, 'chapters/不存在.md');
      missingErred = h.erred();
    });

    test('確認後刪除', () => {
      assert.equal(ok, true);
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('搬進回收站並保留原路徑', () => {
      assert.ok(trashed);
    });

    test('列表裡少了一章', () => {
      assert.equal(countAfter, countBefore - 1);
    });

    test('回收站裡同名不覆蓋', () => {
      assert.ok(noOverwrite);
    });

    test('取消則什麼都不做', () => {
      assert.equal(cancelled, false);
      assert.ok(cancelledKept);
    });

    test('資料夾整棵子樹一起刪', () => {
      assert.equal(dirDeleted, true);
      assert.ok(dirGone);
    });

    test('子樹內容在回收站裡', () => {
      assert.ok(subtreeTrashed);
    });

    test('刪掉的章節不再出現', () => {
      assert.ok(orderGone);
    });

    test('區根目錄不能刪', () => {
      assert.equal(root, false);
      assert.ok(rootErred);
      assert.ok(rootKept);
    });

    test('不存在的路徑報錯而非拋異常', () => {
      assert.equal(missing, false);
      assert.ok(missingErred);
    });
  });

  /**
   * 單章細綱的浮窗檢視（工程頁滑鼠懸停在章節行上時按需取一次）。
   *
   * 與 `buildProjectTree` 分開是有意的：細綱正文上千字，而那棵樹每次檔案變動
   * 都全量重推，把細綱塞進去等於每儲存一次正文就多推幾百 KB。
   *
   * 同一份細綱寫正文之前是計劃、定稿之後是檔案，浮窗要說清是哪一種：沒定稿標「計劃」
   * （`finalized: false`），定稿之後正文又改過標「已過期」，否則作者會照著舊檔案做判斷。
   */
  describe('單章細綱檢視（懸停浮窗的資料來源）', () => {
    const PLOT = '.novelwarden/summaries/030-夜行.md';
    let planned;
    let view;
    let staleAfterEdit;
    let none;
    let ghost;
    let handEdited;
    let allPlaceholder;

    const chapterOf = async (no) => {
      project.invalidate();
      return (await project.listChapters()).find((c) => c.order === no);
    };

    before(async () => {
      await wsOf(project).writePlot({
        no: 30, title: '夜行', upstreamHash: '', done: false,
        sections: { ...plotFile.emptyPlotSections(), 梗概: '計劃的梗概。', 关键事件: '甲乙丙' },
      });
      project.invalidate();
      planned = await projectView.buildPlotSummaryView(project, PLOT);

      // 寫了正文、定稿：細綱照正文反向更新成檔案。
      write('chapters/030-夜行.md', '# 夜行\n\n正文內容。\n');
      await wsOf(project).finalizePlot(
        await chapterOf(30),
        { ...plotFile.emptyPlotSections(), 梗概: '定稿的梗概。' },
        []
      );
      project.invalidate();
      view = await projectView.buildPlotSummaryView(project, PLOT);

      // 正文改過 → 浮窗必須說「已過期」。
      write('chapters/030-夜行.md', '# 夜行\n\n正文內容。又加了一段。\n');
      project.invalidate();
      staleAfterEdit = (await projectView.buildPlotSummaryView(project, PLOT)).stale;

      // 只有正文、還沒有細綱的章不是錯誤，給 exists:false 讓前端說清楚。
      write('chapters/031-沒細綱.md', '# 沒細綱\n\n隨便寫點。\n');
      project.invalidate();
      none = await projectView.buildPlotSummaryView(project, 'chapters/031-沒細綱.md');

      // 不存在的章：不拋異常，退化成「沒有細綱」。
      ghost = await projectView.buildPlotSummaryView(project, '.novelwarden/summaries/999-不存在.md');

      // 作者手寫細綱、一個 `## 小節` 都沒有 → 退回全文，不給空浮窗。
      write('.novelwarden/summaries/031-沒細綱.md', '---\nno: 31\n---\n\n# 第31章 沒細綱\n\n我自己寫的一段話。\n');
      project.invalidate();
      handEdited = await projectView.buildPlotSummaryView(project, 'chapters/031-沒細綱.md');

      // 七個小節全是佔位的空細綱：不退回全文，否則浮窗裡攤八行「（待補充）」。
      await wsOf(project).writePlot({
        no: 31, title: '沒細綱', upstreamHash: '', done: false, sections: plotFile.emptyPlotSections(),
      });
      project.invalidate();
      allPlaceholder = await projectView.buildPlotSummaryView(project, 'chapters/031-沒細綱.md');
    });

    test('沒定稿的細綱也給浮窗', () => {
      assert.equal(planned.exists, true);
    });

    test('沒定稿的細綱標成計劃', () => {
      assert.equal(planned.finalized, false);
    });

    // 計劃談不上過期：過期說的是「定稿之後正文又改過」。
    test('計劃不標過期', () => {
      assert.equal(planned.stale, false);
    });

    test('計劃給出它的非空小節', () => {
      assert.deepEqual(planned.sections.map((s) => s.name), ['梗概', '关键事件']);
    });

    test('定稿之後標成定稿過', () => {
      assert.equal(view.finalized, true);
    });

    test('帶章號與標題', () => {
      assert.equal(view.no, 30, view.title);
      assert.equal(view.title, '夜行', view.title);
    });

    test('剛定稿的細綱不標過期', () => {
      assert.equal(view.stale, false);
    });

    test('給出細綱檔案路徑', () => {
      assert.equal(view.relPath, PLOT, view.relPath);
    });

    test('只給非空小節', () => {
      const names = JSON.stringify(view.sections.map((s) => s.name));
      assert.equal(view.sections.length, 1, names);
      assert.equal(view.sections[0].name, '梗概', names);
    });

    test('小節帶正文（定稿反向更新之後的那一版）', () => {
      assert.equal(view.sections[0].text, '定稿的梗概。', view.sections[0].text);
    });

    test('「（待補充）」佔位不進浮窗', () => {
      assert.ok(
        !view.sections.some((s) => s.text.includes('待補充')),
        JSON.stringify(view.sections)
      );
    });

    test('定稿之後改正文標為過期', () => {
      assert.equal(staleAfterEdit, true);
    });

    test('沒有細綱的章 exists 為 false', () => {
      assert.equal(none.exists, false);
    });

    test('沒有細綱時仍帶標題（浮窗標題行要用）', () => {
      assert.equal(none.title, '沒細綱', none.title);
    });

    test('沒有細綱時小節為空', () => {
      assert.equal(none.sections.length, 0);
    });

    test('沒有細綱時不給細綱路徑', () => {
      assert.equal(none.relPath, '');
    });

    // 有正文就能定稿：浮窗順手告訴作者怎麼補一份。
    test('有正文沒細綱時提示可以定稿', () => {
      assert.equal(none.emptyHint, '這一章還沒有細綱。右鍵「同步」可以照正文整理一份。');
    });

    test('不存在的章退化為空檢視', () => {
      assert.equal(ghost.exists, false);
      assert.equal(ghost.title, '');
    });

    test('不存在的章只說還沒有細綱', () => {
      assert.equal(ghost.emptyHint, '這一章還沒有細綱。');
    });

    test('小節全被刪掉時退回細綱全文', () => {
      const dump = JSON.stringify(handEdited.sections);
      assert.equal(handEdited.sections.length, 1, dump);
      assert.equal(handEdited.sections[0].text, '我自己寫的一段話。', dump);
    });

    test('全佔位的細綱不退回全文', () => {
      assert.equal(allPlaceholder.sections.length, 0, JSON.stringify(allPlaceholder.sections));
    });

    test('全佔位的細綱仍算存在（前端說「細綱是空的」）', () => {
      assert.equal(allPlaceholder.exists, true);
    });
  });

  /**
   * 細綱的改名與刪除**不走區守衛那條路**。
   *
   * `summaries/` 不是三個可管理區之一（`sectionOf` 認不出它），而且細綱映象正文的路徑：還沒有正文時
   * 檔名由「章號 + 標題」共同決定，改名要經 `writePlot` 按新標題重新落盤並清掉舊檔案；有正文時
   * 檔名跟著正文不動，改名只換標題。當成普通檔案搬會讓同一章冒出兩份細綱、或與正文對不上。
   *
   * 一章一綱之後正文就是同號的章節，是作者的檔案：改細綱名、刪細綱都**不碰它**。
   * 從前要連帶搬走中轉站裡那份正文，那一層刪掉了。
   */
  describe('細綱的改名與刪除', () => {
    const NO = 40;
    const CHAPTER = 'chapters/040-入宗風波.md';
    const CHAPTER_TEXT = '正文內容。\n';
    let created;
    let renamed;
    let renamedExists;
    let oldGone;
    let sectionsKept;
    let retitled;
    let retitledTitle;
    let chapterUntouchedByRename;
    let staleAfterRename;
    let writtenFromKept;
    let deleted;
    let plotTrashed;
    let chapterKept;
    let chapterTrashed;
    let cancelled;
    let cancelledKept;
    let missing;
    let missingErred;

    before(async () => {
      // 落點寫明在 summaries/ 根下：前面「新建資料夾」那幾條在章節根下留了幾個空目錄（第四卷、越界……），
      // 不給落點的話接在最後的這一章會落進最新的空卷（2026-10-23 分卷，見 volumes.test.js）。這組測的是改名，不是落點。
      created = await wsOf(project).writePlot({
        no: NO, title: '', upstreamHash: '', done: false,
        sections: { ...plotFile.emptyPlotSections(), 梗概: '進宗門', 关键事件: '甲乙丙' },
      }, undefined, '.novelwarden/summaries/040.md');

      // 純序號名（新建出來的樣子）的第一次命名：還沒有正文，檔名跟著標題走。
      h.expect('入宗風波');
      renamed = await fileOps.renamePlot(project, created);
      renamedExists = !!renamed && has(renamed);
      oldGone = !has(created);
      project.invalidate();
      sectionsKept = (await project.readPlot(renamed))?.sections.关键事件;

      // 照它寫了正文（正文落在細綱反推出來的位置），細綱上記著 writtenFrom（正文落盤那一步的樣子）。
      write(CHAPTER, CHAPTER_TEXT);
      project.invalidate();
      await wsOf(project).recordWrittenFrom(renamed, plotFile.plotContentHash(await project.readPlot(renamed)));
      const writtenFrom = (await project.readPlot(renamed)).writtenFrom;
      await project.syncManifest();
      project.invalidate();

      // 有正文之後再改名：細綱映象正文的路徑，檔名不動，只換標題；正文也不動。
      h.expect('風波');
      retitled = await fileOps.renamePlot(project, renamed);
      chapterUntouchedByRename = has(CHAPTER) && read(CHAPTER) === CHAPTER_TEXT;
      project.invalidate();
      const after = await project.readPlot(renamed);
      retitledTitle = after?.title;
      writtenFromKept = after && after.writtenFrom === writtenFrom;
      staleAfterRename = (await pipe.buildPlotPipeline(project, { no: NO, plot: after })).chapter.upstreamStale;

      // 取消刪除：什麼都不該動。
      h.expect(undefined);
      cancelled = await fileOps.deletePlot(project, renamed);
      cancelledKept = has(renamed);

      h.expect('刪除');
      deleted = await fileOps.deletePlot(project, renamed);
      plotTrashed = has('.novelwarden/.trash/.novelwarden/summaries/040-入宗風波.md');
      chapterKept = has(CHAPTER) && read(CHAPTER) === CHAPTER_TEXT;
      chapterTrashed = has(`.novelwarden/.trash/${CHAPTER}`);

      // 已經刪掉的細綱再刪一次：報錯退出，不拋。
      h.expect('刪除');
      missing = await fileOps.deletePlot(project, renamed);
      missingErred = h.erred();
      project.invalidate();
    });

    test('改名後新檔案在', () => {
      assert.ok(renamedExists, String(renamed));
    });

    test('改名保留序號字首', () => {
      assert.equal(renamed, '.novelwarden/summaries/040-入宗風波.md', String(renamed));
    });

    test('舊檔案不再並存', () => {
      assert.ok(oldGone);
    });

    test('改名不動小節內容', () => {
      assert.equal(sectionsKept, '甲乙丙', String(sectionsKept));
    });

    // 有正文之後細綱是正文的映象：改名只換標題，檔名跟著正文不動。
    test('有正文時改名：檔名不動，只換標題', () => {
      assert.equal(retitled, renamed, String(retitled));
      assert.equal(retitledTitle, '風波', String(retitledTitle));
    });

    // 章節是作者的檔案：給細綱起個名字不該順手去改它的名字或內容。
    test('改細綱名不動同號的章節', () => {
      assert.ok(chapterUntouchedByRename);
    });

    // 改個名不該讓正文憑空標髒：writtenFrom 跟著帶過去，標題也不在內容指紋裡。
    test('改名帶著 writtenFrom，正文不標髒', () => {
      assert.ok(writtenFromKept);
      assert.equal(staleAfterRename, false);
    });

    test('取消刪除時返回 false', () => {
      assert.equal(cancelled, false);
    });

    test('取消刪除時檔案還在', () => {
      assert.ok(cancelledKept);
    });

    test('確認後刪掉了', () => {
      assert.equal(deleted, true);
    });

    test('刪除是搬進回收站，不真刪', () => {
      assert.ok(plotTrashed);
    });

    // 刪掉細綱只是放棄這一章的規劃稿，不該把作者已經寫出來的正文一起帶走。
    test('刪細綱不動同號的章節', () => {
      assert.ok(chapterKept);
      assert.ok(!chapterTrashed);
    });

    test('刪不存在的細綱返回 false', () => {
      assert.equal(missing, false);
    });

    test('刪不存在的細綱報錯而不是靜默', () => {
      assert.ok(missingErred);
    });
  });
});
