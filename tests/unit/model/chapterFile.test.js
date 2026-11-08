/**
 * 章節檔名規則：什麼算章節、序號/詞幹/副檔名怎麼拆，以及 extractH1 只看首行。
 * 遷自 scripts/smoke-chapters.js 的 `== 章節檔名規則 ==` 與 `== extractH1 只看首行 ==` 兩節
 * （原指令碼 main() 裡第一次 NovelProject.open 之前的純函式部分）。
 *
 * 這兩節零 I/O：不建工程、不要 host，直接 bundle 出來調。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('章節檔名規則', () => {
  let chapterFile;

  before(() => {
    chapterFile = loadModule('src/core/model/chapterFile.ts');
  });

  // 「什麼算章節」不再只認 .md——數字字首 + 非二進位制副檔名即可。
  const yes = ['001-楔子.md', '001-楔子.txt', '001-楔子', '004.json', '001-手記.rtf', '12_初入江湖.md', '003.md'];
  for (const name of yes) {
    test(`「${name}」算章節`, () => {
      assert.ok(chapterFile.isChapterFileName(name));
    });
  }

  const no = ['001-封面.png', '002-稿.docx', '003.zip', '004.mp3', '005.pdf', '006.exe', '筆記.txt', 'README.md'];
  for (const name of no) {
    test(`「${name}」不算章節`, () => {
      assert.ok(!chapterFile.isChapterFileName(name));
    });
  }

  // 作者放在卷目錄裡的筆記：整個標題就是筆記詞（可帶編號）才不算，詞只在開頭或結尾的照樣是章節。
  const notes = ['047 細綱.txt', '048 作話.txt', '049-大綱.md', '050_筆記', '051 細綱2.txt', '052-Notes.md', '053.設定.txt'];
  for (const name of notes) {
    test(`筆記「${name}」不算章節`, () => {
      assert.ok(!chapterFile.isChapterFileName(name));
    });
  }
  const titled = ['047-設定崩塌.txt', '012-草稿紙上的名字.txt', '003-大綱之外.md', '020-作話之後', '031-備份計劃.txt'];
  for (const name of titled) {
    test(`標題裡帶筆記詞的「${name}」仍是章節`, () => {
      assert.ok(chapterFile.isChapterFileName(name));
    });
  }

  test('解析出序號/詞幹/副檔名', () => {
    const parsed = chapterFile.parseChapterFileName('001-楔子.txt');
    assert.equal(parsed.order, 1, JSON.stringify(parsed));
    assert.equal(parsed.stem, '楔子', JSON.stringify(parsed));
    assert.equal(parsed.ext, '.txt', JSON.stringify(parsed));
  });

  test('`003.md` 的詞幹為空（點沒被當成分隔符吃掉副檔名）', () => {
    const bare = chapterFile.parseChapterFileName('003.md');
    assert.equal(bare.order, 3, JSON.stringify(bare));
    assert.equal(bare.stem, '', JSON.stringify(bare));
    assert.equal(bare.ext, '.md', JSON.stringify(bare));
  });

  test('無副檔名解析正確', () => {
    const noExt = chapterFile.parseChapterFileName('005-無副檔名');
    assert.equal(noExt.order, 5, JSON.stringify(noExt));
    assert.equal(noExt.stem, '無副檔名', JSON.stringify(noExt));
    assert.equal(noExt.ext, '', JSON.stringify(noExt));
  });
});

describe('extractH1 只看首行', () => {
  let markdown;

  before(() => {
    markdown = loadModule('src/core/model/markdown.ts');
  });

  test('首行是標題時取到', () => {
    assert.equal(markdown.extractH1('# 楔子\n\n正文'), '楔子');
  });

  test('標題在中段時不取', () => {
    assert.equal(
      markdown.extractH1('第一行\n\n# 後面的'),
      undefined,
      String(markdown.extractH1('第一行\n\n# 後面的'))
    );
  });

  test('與 stripH1 互逆', () => {
    assert.equal(markdown.stripH1('第一行\n\n# 後面的'), '第一行\n\n# 後面的');
  });
});
