/**
 * 工程根範圍的類檔案操作（檔案頁）：重新命名/移動/複製、固定目錄保護、同名拒絕、
 * 垃圾箱豁免、章節聯動。遷自 scripts/smoke-projectFiles.js（全部 30 條）。
 *
 * 條數說明：原指令碼文字上只有 26 個 `check(`，但「固定目錄不能改名」那條在
 * 5 元素的 for 迴圈裡，執行時是 5 條。以執行時為準 = 30 條，一條一個 test。
 *
 * 時序敏感：`erred()` 讀的是「距上一次 expect() 以來」攢下的 toast，
 * 所以每個操作後**當場**取值存進變數，斷言只讀變數。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

/** 固定目錄一律拒絕改名。 */
const FIXED_DIRS = ['chapters', '.novelwarden', 'drafts', '.novelwarden/characters', '.novelwarden/.trash'];

describe('projectFiles.ts', () => {
  let pf;
  let h;
  let project;
  let dir;
  let rel;
  let write;
  let read;

  before(async () => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      fileOps: './src/core/files/fileOps.ts',
      projectFiles: './src/core/files/projectFiles.ts',
    });
    pf = bundle.projectFiles;
    // 原指令碼的 host 字面量裡沒有 reviewReplace，顯式抹掉，別走進 diff 審閱分支。
    h = makeFakeHost({ overrides: { reviewReplace: undefined } });
    bundle.host.initHost(h.host);

    const t = await makeTempProject(bundle.project, { prefix: 'projfiles', title: '檔案頁測試' });
    ({ dir, rel, write, read, project } = t);

    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    write('.novelwarden/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    write('notes/備忘.txt', '隨便記的。\n');
    project.invalidate();
  });

  after(() => cleanup(dir));

  describe('根範圍重新命名', () => {
    let outside;
    let chapter;
    let h1Synced;
    const fixed = [];
    let escaped;
    let escapedErred;
    let missing;

    before(async () => {
      // 區外檔案（notes/）也能改名——這是檔案頁與工程頁的本質區別。
      h.expect('備忘改名');
      outside = await pf.renameAny(project, 'notes/備忘.txt');

      // 章節仍保留序號字首與 H1 同步。
      h.expect('新的標題');
      chapter = await pf.renameAny(project, 'chapters/001-楔子.md');
      h1Synced = read('chapters/001-新的標題.md').startsWith('# 新的標題');

      for (const p of FIXED_DIRS) {
        h.expect('隨便');
        const r = await pf.renameAny(project, p);
        fixed.push({ p, ok: r.ok, erred: h.erred() });
      }

      h.expect('外面');
      escaped = await pf.renameAny(project, '../外面');
      escapedErred = h.erred();

      h.expect('不存在');
      missing = await pf.renameAny(project, 'notes/幽靈.txt');
    });

    test('區外檔案可重新命名', () => {
      assert.ok(outside.ok, JSON.stringify(outside));
      assert.equal(outside.to, 'notes/備忘改名.txt', JSON.stringify(outside));
    });

    test('章節保留序號字首', () => {
      assert.ok(chapter.ok, JSON.stringify(chapter));
      assert.equal(chapter.to, 'chapters/001-新的標題.md', JSON.stringify(chapter));
    });

    test('章節 H1 同步', () => {
      assert.ok(h1Synced);
    });

    for (const p of FIXED_DIRS) {
      test(`固定目錄不能改名：${p}`, () => {
        const hit = fixed.find((x) => x.p === p);
        assert.equal(hit.ok, false);
        assert.ok(hit.erred);
      });
    }

    test('越界路徑拒絕', () => {
      assert.equal(escaped.ok, false);
      assert.ok(escapedErred);
    });

    test('不存在的路徑拒絕', () => {
      assert.equal(missing.ok, false);
    });
  });

  describe('移動（剪下+貼上）', () => {
    let free;
    let sourceEmptied;
    let okOne;
    let badOne;
    let bothKept;
    let intoSub;
    let draftFollowed;
    let landedInSub;
    let outOfChapters;
    let draftStayed;
    let fixedDir;
    let intoSelf;
    let fromTrash;
    let escaped;
    let escapedErred;
    let already;

    before(async () => {
      fs.mkdirSync(rel('archive'), { recursive: true });

      // 區外自由移動。
      let results = await pf.moveInto(project, ['notes/備忘改名.txt'], 'archive');
      free = results[0];
      sourceEmptied = !fs.existsSync(rel('notes/備忘改名.txt'));

      // 多項貼上：一項撞名，其餘照常。
      write('archive/撞名.txt', '先來的。\n');
      write('notes/甲.txt', '甲。\n');
      write('notes/撞名.txt', '後來的。\n');
      project.invalidate();
      results = await pf.moveInto(project, ['notes/甲.txt', 'notes/撞名.txt'], 'archive');
      okOne = results.find((x) => x.from === 'notes/甲.txt');
      badOne = results.find((x) => x.from === 'notes/撞名.txt');
      bothKept =
        read('archive/撞名.txt').includes('先來的') && read('notes/撞名.txt').includes('後來的');

      // 章節移進 chapters 子目錄：草稿跟著走。
      // manifest 已經不索引章節了（章節退出流水線，見 chapters.test.js 末尾），
      // 所以這裡只驗磁碟：檔案到了新位置、草稿也跟過去了。
      fs.mkdirSync(rel('chapters/卷一'), { recursive: true });
      fs.mkdirSync(rel('drafts'), { recursive: true });
      write('drafts/001-新的標題.md', '# 草稿\n');
      project.invalidate();
      results = await pf.moveInto(project, ['chapters/001-新的標題.md'], 'chapters/卷一');
      intoSub = results[0];
      draftFollowed = fs.existsSync(rel('drafts/卷一/001-新的標題.md'));
      project.invalidate();
      landedInSub = fs.existsSync(rel('chapters/卷一/001-新的標題.md'));

      // 章節移出 chapters/：允許，但草稿留在原處（日誌會 warn，這裡只驗磁碟狀態）。
      results = await pf.moveInto(project, ['chapters/卷一/001-新的標題.md'], 'archive');
      outOfChapters = results[0];
      draftStayed = fs.existsSync(rel('drafts/卷一/001-新的標題.md'));

      // 固定目錄不能搬。
      results = await pf.moveInto(project, ['chapters'], 'archive');
      fixedDir = results[0];

      // 資料夾不能進自己的子孫。
      results = await pf.moveInto(project, ['archive'], 'archive');
      intoSelf = results[0];

      // 垃圾箱裡的東西不搬。
      write('.novelwarden/.trash/notes/舊物.txt', '刪掉的。\n');
      results = await pf.moveInto(project, ['.novelwarden/.trash/notes/舊物.txt'], 'notes');
      fromTrash = results[0];

      // 越界落點。
      results = await pf.moveInto(project, ['notes/甲.txt'], '../../外面');
      escaped = results[0];
      escapedErred = h.erred();

      // 已在目標目錄裡。
      results = await pf.moveInto(project, ['archive/甲.txt'], 'archive');
      already = results[0];
    });

    test('區外檔案可移動', () => {
      assert.ok(free.ok, JSON.stringify(free));
      assert.equal(free.to, 'archive/備忘改名.txt', JSON.stringify(free));
    });

    test('原位置已空', () => {
      assert.ok(sourceEmptied);
    });

    test('撞名項拒絕且原因明確', () => {
      assert.ok(badOne, JSON.stringify(badOne));
      assert.ok(!badOne.ok, JSON.stringify(badOne));
      assert.ok(badOne.error.includes('同名'), JSON.stringify(badOne));
    });

    test('其餘項不受影響', () => {
      assert.ok(okOne, JSON.stringify(okOne));
      assert.ok(okOne.ok, JSON.stringify(okOne));
      assert.equal(okOne.to, 'archive/甲.txt', JSON.stringify(okOne));
    });

    test('撞名時兩份都還在', () => {
      assert.ok(bothKept);
    });

    test('章節可移入子目錄', () => {
      assert.ok(intoSub.ok, JSON.stringify(intoSub));
      assert.equal(intoSub.to, 'chapters/卷一/001-新的標題.md', JSON.stringify(intoSub));
    });

    test('草稿跟著搬', () => {
      assert.ok(draftFollowed);
    });

    test('檔案確實到了子目錄', () => {
      assert.ok(landedInSub);
    });

    test('章節可移出 chapters', () => {
      assert.ok(outOfChapters.ok, JSON.stringify(outOfChapters));
      assert.equal(outOfChapters.to, 'archive/001-新的標題.md', JSON.stringify(outOfChapters));
    });

    test('草稿留在原處', () => {
      assert.ok(draftStayed);
    });

    test('固定目錄不能移動', () => {
      assert.equal(fixedDir.ok, false, JSON.stringify(fixedDir));
    });

    test('資料夾不能貼上進自己', () => {
      assert.equal(intoSelf.ok, false, JSON.stringify(intoSelf));
    });

    test('回收站內容不能移動', () => {
      assert.equal(fromTrash.ok, false, JSON.stringify(fromTrash));
    });

    // ⚠ 這條的 erred() 沿用原指令碼的語義，而原指令碼**整節都沒有呼叫過 expect()**——
    //   toast 佇列自「根範圍重新命名」最後一次 expect('不存在') 起就沒清過。
    //   所以它只證明「這一長串操作裡出現過 error 級 toast」，
    //   **不**證明是這次越界落點報的錯：上面任何一次拒絕都足以讓它變綠。
    //   ok === false 那半邊才是真正在測越界。原樣保留，不在本次遷移裡改斷言。
    test('落點越界拒絕', () => {
      assert.equal(escaped.ok, false, JSON.stringify(escaped));
      assert.ok(escapedErred, JSON.stringify(escaped));
    });

    test('已在該目錄時拒絕', () => {
      assert.equal(already.ok, false, JSON.stringify(already));
    });
  });

  describe('複製（複製+貼上）', () => {
    let copied;
    let originalKept;
    let copyContent;
    let noDest;
    let recursive;
    let clash;
    let clashTargetKept;

    before(async () => {
      fs.mkdirSync(rel('copydest'), { recursive: true });
      let results = await pf.copyInto(project, ['archive/撞名.txt'], 'copydest');
      copied = results[0];
      originalKept = fs.existsSync(rel('archive/撞名.txt'));
      copyContent = read('copydest/撞名.txt');

      // 落點目錄必須已存在——貼上不會憑空建目錄。
      results = await pf.copyInto(project, ['archive'], 'backup');
      noDest = results[0];

      fs.mkdirSync(rel('backup'), { recursive: true });
      results = await pf.copyInto(project, ['archive'], 'backup');
      recursive = { r: results[0], nested: fs.existsSync(rel('backup/archive/甲.txt')) };

      // 複製撞名同樣拒絕。
      results = await pf.copyInto(project, ['notes/撞名.txt'], 'archive');
      clash = results[0];
      clashTargetKept = fs.existsSync(rel('archive/撞名.txt'));
    });

    test('複製後原檔案還在', () => {
      assert.ok(copied.ok, JSON.stringify(copied));
      assert.ok(originalKept, JSON.stringify(copied));
    });

    test('複製出同名新檔案', () => {
      assert.ok(copyContent.includes('先來的'));
    });

    test('落點目錄不存在時拒絕', () => {
      assert.equal(noDest.ok, false, JSON.stringify(noDest));
    });

    test('目錄遞迴複製', () => {
      assert.ok(recursive.r.ok, JSON.stringify(recursive.r));
      assert.ok(recursive.nested, JSON.stringify(recursive.r));
    });

    test('複製撞名拒絕', () => {
      assert.equal(clash.ok, false, JSON.stringify(clash));
      assert.ok(clashTargetKept, JSON.stringify(clash));
    });
  });
});
