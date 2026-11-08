/**
 * 正文的分段格式與一鍵排版（`src/core/model/paragraphFormat.ts`，純函式、零 import——內建編輯器直接打包它）。
 *
 * | 組 | 釘的是什麼 |
 * |---|---|
 * | 取值 | 英文值與中文說法都認、寫壞了是 undefined；三種格式各自的段間隔與段首縮排 |
 * | 分隔行 | 標題行與只有符號的場景分隔行不縮排；一行省略號 / 破折號是一句話，要縮排 |
 * | `formatProse` | 三種格式各排一遍；frontmatter 原樣；首尾空白（含全形、不換行空格、製表符）去掉；空了幾行都收成一種；文末恰好一個換行；`\r\n` 當 `\n`；節選不認 frontmatter、不補換行；改了幾處數得對、沒變是 0 |
 * | `toFullWidthPunct` | 只在中文語境裡轉；數字之間、英文、`檔名.md`、網址、程式碼、frontmatter 不動；省略號、破折號、括號、直雙引號的正反例；只改給定範圍 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

let P;
before(() => {
  P = loadModule('src/core/model/paragraphFormat.ts');
});

const W = '　　';

describe('分段格式的取值', () => {
  test('英文值不分大小寫都認', () => {
    assert.equal(P.parseParagraphStyle('indent'), 'indent');
    assert.equal(P.parseParagraphStyle(' Both '), 'both');
  });

  test('中文說法也認', () => {
    assert.equal(P.parseParagraphStyle('空行分段'), 'blank');
    assert.equal(P.parseParagraphStyle('段首縮排'), 'indent');
    assert.equal(P.parseParagraphStyle('縮排加空行'), 'both');
  });

  test('寫壞了、空著是 undefined（不猜）', () => {
    assert.equal(P.parseParagraphStyle('縮排'), undefined);
    assert.equal(P.parseParagraphStyle(''), undefined);
    assert.equal(P.isParagraphStyle('tab'), false);
  });

  test('預設是空行分段', () => {
    assert.equal(P.DEFAULT_PARAGRAPH_STYLE, 'blank');
  });

  test('三種格式的段間隔、段首縮排與另起一段要插的字', () => {
    assert.deepEqual(
      P.PARAGRAPH_STYLES.map((s) => [P.paragraphGap(s), P.paragraphIndent(s), P.paragraphBreak(s)]),
      [
        ['\n\n', '', '\n\n'],
        ['\n', W, `\n${W}`],
        ['\n\n', W, `\n\n${W}`],
      ]
    );
  });
});

describe('標題行與場景分隔行', () => {
  test('# 開頭的是標題', () => {
    assert.equal(P.isHeadingLine('# 第一章'), true);
    assert.equal(P.isHeadingLine('  ## 雨夜'), true);
    assert.equal(P.isHeadingLine('他說 # 號'), false);
  });

  test('只有符號的行是場景分隔', () => {
    for (const line of ['---', '***', '* * *', '※', '◇◇◇', '＊＊＊', '　~~~　']) {
      assert.equal(P.isSceneBreakLine(line), true, line);
    }
  });

  test('一行省略號、破折號是一句話，不是分隔', () => {
    for (const line of ['……', '——', '“……”', '- 一項', '他']) {
      assert.equal(P.isSceneBreakLine(line), false, line);
    }
  });
});

describe('formatProse', () => {
  const messy = `\n\n# 第一章 雨夜\n${W}他推開門。 \n\n\n\t她笑了。 \n* * *\n　後來的事。`;

  test('空行分段：段間空一行、段首不縮排', () => {
    assert.equal(P.formatProse(messy, 'blank'), '# 第一章 雨夜\n\n他推開門。\n\n她笑了。\n\n* * *\n\n後來的事。\n');
  });

  test('段首縮排：段首兩個全形空格、段間不空行，標題與分隔行不縮排', () => {
    assert.equal(
      P.formatProse(messy, 'indent'),
      `# 第一章 雨夜\n${W}他推開門。\n${W}她笑了。\n* * *\n${W}後來的事。\n`
    );
  });

  test('縮排加空行：段首縮排且段間空一行', () => {
    assert.equal(
      P.formatProse(messy, 'both'),
      `# 第一章 雨夜\n\n${W}他推開門。\n\n${W}她笑了。\n\n* * *\n\n${W}後來的事。\n`
    );
  });

  test('頂部 frontmatter 原樣保留', () => {
    const text = '---\ntitle: 雨夜\ntags: [a, b]\n---\n他推開門。\n她笑了。';
    assert.equal(P.formatProse(text, 'blank'), '---\ntitle: 雨夜\ntags: [a, b]\n---\n他推開門。\n\n她笑了。\n');
  });

  test('開頭就是 --- 分隔線的正文不當成 frontmatter', () => {
    assert.equal(P.formatProse('---\n他推開門。\n---\n她笑了。', 'blank'), '---\n\n他推開門。\n\n---\n\n她笑了。\n');
  });

  test('\\r\\n 當 \\n', () => {
    assert.equal(P.formatProse('他推開門。\r\n\r\n她笑了。\r\n', 'blank'), '他推開門。\n\n她笑了。\n');
  });

  test('文末恰好一個換行', () => {
    assert.equal(P.formatProse('他推開門。\n\n\n', 'blank'), '他推開門。\n');
    assert.equal(P.formatProse('他推開門。', 'indent'), `${W}他推開門。\n`);
  });

  test('只有空白：排成空的', () => {
    assert.equal(P.formatProse('\n　\n', 'blank'), '');
  });

  test('已經是這個格式：一字不變，改了 0 處', () => {
    const text = `# 第一章\n${W}他推開門。\n${W}她笑了。\n`;
    assert.deepEqual(P.layoutProse(text, 'indent'), { text, changes: 0 });
  });

  test('改了幾處：重排過的行與改過的段間隔各算一處', () => {
    // 「她笑了。」要縮排（1）；兩段之間空了一行要收成不空行（1）；文末補換行（1）。
    assert.equal(P.layoutProse(`${W}他推開門。\n\n她笑了。`, 'indent').changes, 3);
  });

  test('節選：不認 frontmatter、不補文末換行', () => {
    assert.equal(P.formatProse('---\na: b\n---\n他推開門。', 'indent', { fragment: true }), `---\n${W}a: b\n---\n${W}他推開門。`);
  });
});

describe('toFullWidthPunct', () => {
  const t = (s) => P.toFullWidthPunct(s);

  test('前一個字是漢字時，半形 , . ? ! : ; 轉全形', () => {
    assert.equal(t('他來了,坐下.真的?好!注意:一;二'), '他來了，坐下。真的？好！注意：一；二');
  });

  test('前一個字是中文標點或彎引號時也轉', () => {
    assert.equal(t('“走吧”,他說'), '“走吧”，他說');
    assert.equal(t('（笑）.'), '（笑）。');
  });

  test('數字之間不動', () => {
    assert.equal(t('圓周率3.14，共1,000人'), '圓周率3.14，共1,000人');
  });

  test('英文句子不動', () => {
    assert.equal(t('Hello, world. Are you ok?'), 'Hello, world. Are you ok?');
  });

  test('「檔名.md」這種點後面緊跟字母數字的不動', () => {
    assert.equal(t('改一下配置.md裡的值'), '改一下配置.md裡的值');
  });

  test('網址與郵箱不動，網址後面那個句子的標點照轉', () => {
    assert.equal(t('見https://a.com/b?x=1,y=2.'), '見https://a.com/b?x=1,y=2.');
    assert.equal(t('網址www.example.com,好的.'), '網址www.example.com,好的。');
    assert.equal(t('寫信給我a.b@c.com,謝謝'), '寫信給我a.b@c.com,謝謝');
  });

  test('Markdown 程式碼（行內與圍欄）不動', () => {
    assert.equal(t('用`中,文`表示\n```\n程式碼,裡\n```\n完了,'), '用`中,文`表示\n```\n程式碼,裡\n```\n完了，');
  });

  test('頂部 frontmatter 不動', () => {
    assert.equal(t('---\ncast: [林昭, 蘇晚]\n---\n林昭,走了'), '---\ncast: [林昭, 蘇晚]\n---\n林昭，走了');
  });

  test('挨著中文的 ... 與 。。。 轉 ……', () => {
    assert.equal(t('他說...算了'), '他說……算了');
    assert.equal(t('...算了'), '……算了');
    assert.equal(t('真的。。。嗎'), '真的……嗎');
  });

  test('英文裡的省略號、兩個點不動', () => {
    assert.equal(t('Wait... ok'), 'Wait... ok');
    assert.equal(t('他..走'), '他..走');
  });

  test('漢字之間的 -- 轉 ——，別處不動', () => {
    assert.equal(t('他--他說'), '他——他說');
    assert.equal(t('a--b，十-一'), 'a--b，十-一');
  });

  test('括號裡有漢字：一對一起轉', () => {
    assert.equal(t('他(笑著)說'), '他（笑著）說');
  });

  test('括號裡沒有英文字母、外面挨著漢字：轉', () => {
    assert.equal(t('(1)第一條'), '（1）第一條');
  });

  test('f(x) 這種不動，落單的括號不動', () => {
    assert.equal(t('函式f(x)的值'), '函式f(x)的值');
    assert.equal(t('他說(沒說完'), '他說(沒說完');
  });

  test('直雙引號：同一行成對、中間有漢字時按順序轉成 “”', () => {
    assert.equal(t('他說:"你好."她答:"嗯."'), '他說：“你好。”她答：“嗯。”');
  });

  test('直雙引號落單、或那一對裡沒有漢字：不動', () => {
    assert.equal(t('他說:"你好'), '他說："你好');
    assert.equal(t('型號"A1"很好'), '型號"A1"很好');
  });

  test('直單引號一律不動（英文撇號會把配對攪亂）', () => {
    assert.equal(t("don't 他說'好'"), "don't 他說'好'");
  });

  test('只改給定範圍，判語境照樣看前後文', () => {
    const text = '第一句,第二句,第三句,';
    const r = P.fullWidthPunct(text, { range: { start: 4, end: 8 } });
    assert.equal(r.text, '第一句,第二句，第三句,');
    assert.equal(r.changes, 1);
  });

  test('列出每一處替換（位置按原文）', () => {
    assert.deepEqual(P.fullWidthPunct('好...,').edits, [
      { at: 1, from: '...', to: '……' },
      { at: 4, from: ',', to: '，' },
    ]);
  });

  test('沒有要轉的：原樣、0 處', () => {
    assert.deepEqual(P.fullWidthPunct('他走了。'), { text: '他走了。', changes: 0, edits: [] });
  });
});
