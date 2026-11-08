/**
 * 查詢替換的純函式（`media/src/editor/findCore.ts`；匹配口徑本身在 core 的 `src/core/model/textFind.ts`，
 * findCore 原樣轉出——全書查詢替換在後端用的也是它）。查詢條的整條鏈路（按鍵、高亮、撤銷）在
 * tests/dom/standalone/find.test.js，這裡釘口徑：大小寫、正則、壞正則、零長度、`$1`、中文、上限、定位，
 * 以及全書替換要的「只換挑出來的那幾處」（`replaceSelectedIn`）。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  MATCH_LIMIT,
  compileSearch,
  escapeRegExp,
  expandReplacement,
  findMatches,
  matchAfter,
  matchAt,
  matchBefore,
  nearestMatch,
  replaceAllIn,
  replaceSelectedIn,
  replacementFor,
  seedFromSelection,
} = loadModule('media/src/editor/findCore.ts');
const core = loadModule('src/core/model/textFind.ts');

/** 匹配到的字，按順序。 */
const found = (text, query, opts) => findMatches(text, query, opts).matches.map((m) => text.slice(m.start, m.end));
/** 把全部替換的那一筆套回原文。 */
const applyAll = (text, query, replacement, opts) => {
  const edit = replaceAllIn(text, query, replacement, opts);
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
};

describe('findMatches：大小寫與字面量', () => {
  test('預設不區分大小寫', () => {
    assert.deepEqual(found('Abc abc ABC', 'abc'), ['Abc', 'abc', 'ABC']);
  });

  test('區分大小寫時只認一樣的', () => {
    assert.deepEqual(found('Abc abc ABC', 'abc', { caseSensitive: true }), ['abc']);
  });

  test('不按正則時元字元是字面量', () => {
    assert.deepEqual(found('a.b axb (a.b)', 'a.b'), ['a.b', 'a.b']);
    assert.deepEqual(found('價格 $1.5 與 [注]', '$1.5'), ['$1.5']);
    assert.deepEqual(found('價格 $1.5 與 [注]', '[注]'), ['[注]']);
  });

  test('中文按字找，位置是字串下標', () => {
    const text = '林昭推開門。林昭沒有說話，林昭。';
    const { matches } = findMatches(text, '林昭');
    assert.deepEqual(matches.map((m) => m.start), [0, 6, 13]);
    assert.ok(matches.every((m) => m.end - m.start === 2));
  });

  test('匹配不重疊：從上一處的末尾往後找', () => {
    assert.deepEqual(findMatches('甲甲甲', '甲甲').matches, [{ start: 0, end: 2 }]);
  });

  test('空查詢串：空結果，不報錯', () => {
    assert.deepEqual(findMatches('甲乙', ''), { matches: [], truncated: false });
  });
});

describe('findMatches：正則', () => {
  test('按正則找', () => {
    assert.deepEqual(found('第3章 第12章 第章', '第\\d+章', { regex: true }), ['第3章', '第12章']);
  });

  test('^ 認每一行的開頭（段首）', () => {
    const text = '　　雨夜。\n　　風起。\n不是段首　　';
    assert.deepEqual(findMatches(text, '^　　', { regex: true }).matches.map((m) => m.start), [0, 6]);
  });

  test('正則也預設不區分大小寫', () => {
    assert.deepEqual(found('Ab ab', 'a.', { regex: true }), ['Ab', 'ab']);
    assert.deepEqual(found('Ab ab', 'a.', { regex: true, caseSensitive: true }), ['ab']);
  });

  test('寫錯的正則：不拋，給 error', () => {
    const r = findMatches('甲（乙', '(乙', { regex: true });
    assert.deepEqual(r.matches, []);
    assert.equal(typeof r.error, 'string');
    assert.equal(compileSearch('(乙', { regex: true }).ok, false);
  });

  test('u 模式下不合法、普通模式下合法的寫法退回普通模式（多寫的轉義照認）', () => {
    assert.deepEqual(found('他說。好', '\\。', { regex: true }), ['。']);
  });

  test('生僻字（代理對）用 . 匹配時按一個字算', () => {
    assert.deepEqual(found('𠀀甲', '.', { regex: true }), ['𠀀', '甲']);
  });

  test('零長度匹配跳過', () => {
    assert.deepEqual(found('甲乙', '^', { regex: true }), []);
    assert.deepEqual(found('ab cd', '\\b', { regex: true }), []);
    assert.deepEqual(found('xaaxa', 'a*', { regex: true }), ['aa', 'a']);
  });

  test('零長度匹配不把代理對劈開', () => {
    assert.deepEqual(found('𠀀a𠀀', 'a*', { regex: true }), ['a']);
  });

  test('超過上限：只數到上限，標 truncated', () => {
    const r = findMatches('甲'.repeat(10), '甲', {}, 4);
    assert.equal(r.matches.length, 4);
    assert.equal(r.truncated, true);
    assert.equal(findMatches('甲'.repeat(10), '甲').truncated, false);
    assert.ok(MATCH_LIMIT >= 10000);
  });
});

describe('替換：$1 這類引用與 String.prototype.replace 同語義', () => {
  /** 有零長度匹配的不比（那是查詢有意跳過的）。 */
  const CASES = [
    ['林昭說：好。沈氏說：走。', '(\\S+?)說：', '$1道：'],
    ['2026-10-18', '(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1'],
    ['甲乙丙', '乙', '[$&]'],
    ['甲乙丙', '乙', "<$`|$'>"],
    ['甲乙丙', '乙', '$$1'],
    ['甲乙丙', '(乙)', '$0$1$2'],
    ['甲乙丙', '(乙)', '$10'],
    ['甲乙丙', '(乙)', '$01'],
    ['甲乙丙', '(?<name>乙)', '<$<name>>'],
    ['甲乙丙', '(?<name>乙)', '<$<nope>>'],
    ['甲乙丙', '(乙)', '$<name>'],
    ['甲乙丙', '(?<name>乙)', '$<name'],
    ['甲乙丙', '乙', '末尾一個$'],
    ['a1b22c333', '(\\d)(\\d)?', '[$2$1]'],
    ['甲乙甲乙', '(?<=甲)乙', '丁'],
    ['一行\n二行\n三行', '^(.)行$', '第$1行'],
  ];

  for (const [text, pattern, template] of CASES) {
    test(`全部替換 /${pattern}/ → ${JSON.stringify(template)}`, () => {
      const expected = text.replace(new RegExp(pattern, 'gimu'), template);
      assert.equal(applyAll(text, pattern, template, { regex: true }), expected);
    });
  }

  test('逐處替換：前後文看的是整份文字（後行斷言、$` 都對）', () => {
    const text = '甲乙丙乙';
    const at = findMatches(text, '(?<=丙)乙', { regex: true }).matches[0];
    assert.deepEqual(at, { start: 3, end: 4 });
    assert.equal(replacementFor(text, at, '(?<=丙)乙', "[$`]", { regex: true }), '[甲乙丙]');
  });

  test('逐處替換：$1 取這一處自己的分組', () => {
    const text = '林昭說：好。沈氏說：走。';
    const [, second] = findMatches(text, '(\\S{2})說：', { regex: true }).matches;
    assert.equal(replacementFor(text, second, '(\\S{2})說：', '$1道：', { regex: true }), '沈氏道：');
  });

  test('逐處替換：這一處已經對不上（文字剛變過）時返回 undefined', () => {
    assert.equal(replacementFor('甲乙丙', { start: 0, end: 2 }, '乙', 'x'), undefined);
  });

  test('不按正則時 $1 是字面量', () => {
    assert.equal(applyAll('甲乙丙', '乙', '$1$&'), '甲$1$&丙');
    const at = findMatches('甲乙丙', '乙').matches[0];
    assert.equal(replacementFor('甲乙丙', at, '乙', '$1'), '$1');
  });

  test('expandReplacement 直接用：沒有 $ 原樣返回', () => {
    const m = /乙/.exec('甲乙');
    assert.equal(expandReplacement('丁', m, '甲乙'), '丁');
  });
});

describe('replaceAllIn：一筆改動覆蓋第一處到最後一處', () => {
  test('只覆蓋第一處到最後一處之間，前後不動', () => {
    const text = '開頭。林昭來了，林昭走了。結尾。';
    const edit = replaceAllIn(text, '林昭', '沈氏');
    assert.equal(edit.count, 2);
    assert.equal(edit.start, 3);
    assert.equal(edit.end, 10);
    assert.equal(edit.text, '沈氏來了，沈氏');
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '開頭。沈氏來了，沈氏走了。結尾。');
  });

  test('不區分大小寫的全部替換', () => {
    assert.equal(applyAll('Hi hi HI', 'hi', 'yo'), 'yo yo yo');
    assert.equal(applyAll('Hi hi HI', 'hi', 'yo', { caseSensitive: true }), 'Hi yo HI');
  });

  test('替換成含查詢串的文字不會沒完沒了', () => {
    assert.equal(applyAll('甲乙甲', '甲', '甲甲'), '甲甲乙甲甲');
  });

  test('一處都沒有、空查詢串、壞正則：undefined', () => {
    assert.equal(replaceAllIn('甲乙', '丙', 'x'), undefined);
    assert.equal(replaceAllIn('甲乙', '', 'x'), undefined);
    assert.equal(replaceAllIn('甲乙', '(', 'x', { regex: true }), undefined);
  });

  test('不受查詢的計數上限限制', () => {
    const text = '甲'.repeat(MATCH_LIMIT + 5);
    assert.equal(replaceAllIn(text, '甲', '乙').count, MATCH_LIMIT + 5);
  });

  test('零長度匹配不算一處', () => {
    const edit = replaceAllIn('xaaxa', 'a*', '-', { regex: true });
    assert.equal(edit.count, 2);
    assert.equal('xaaxa'.slice(0, edit.start) + edit.text + 'xaaxa'.slice(edit.end), 'x-x-');
  });
});

describe('在匹配表裡定位', () => {
  const ms = [{ start: 2, end: 3 }, { start: 5, end: 6 }, { start: 9, end: 10 }];

  test('matchAfter：start ≥ pos 的第一處，到頭繞回第一處', () => {
    assert.equal(matchAfter(ms, 0), 0);
    assert.equal(matchAfter(ms, 2), 0);
    assert.equal(matchAfter(ms, 3), 1);
    assert.equal(matchAfter(ms, 10), 0);
    assert.equal(matchAfter([], 0), -1);
  });

  test('matchBefore：start < pos 的最後一處，到頭繞回最後一處', () => {
    assert.equal(matchBefore(ms, 9), 1);
    assert.equal(matchBefore(ms, 10), 2);
    assert.equal(matchBefore(ms, 2), 2);
    assert.equal(matchBefore([], 0), -1);
  });

  test('nearestMatch：不在 pos 前面的最近一處，都在前面取最後一處', () => {
    assert.equal(nearestMatch(ms, 4), 1);
    assert.equal(nearestMatch(ms, 5), 1);
    assert.equal(nearestMatch(ms, 99), 2);
  });

  test('matchAt：正好是那一處才認', () => {
    assert.equal(matchAt(ms, 5, 6), 1);
    assert.equal(matchAt(ms, 5, 5), -1);
    assert.equal(matchAt(ms, 4, 6), -1);
  });
});

describe('選區預填', () => {
  test('一行之內的短文字預填', () => {
    assert.equal(seedFromSelection('甲乙丙', 1, 3), '乙丙');
  });

  test('沒選中、跨行、太長都不預填', () => {
    assert.equal(seedFromSelection('甲乙丙', 1, 1), undefined);
    assert.equal(seedFromSelection('甲\n乙', 0, 3), undefined);
    assert.equal(seedFromSelection('甲'.repeat(200), 0, 200), undefined);
  });

  test('escapeRegExp 讓預填的字在正則模式下仍按字面找', () => {
    assert.deepEqual(found('a.b axb', escapeRegExp('a.b'), { regex: true }), ['a.b']);
  });
});

describe('replaceSelectedIn：只換挑出來的那幾處（全書替換）', () => {
  const text = '林晚推門。林晚沒說話。林晚霞走了。';
  const all = findMatches(text, '林晚').matches;

  test('全挑：與全部替換的結果一樣', () => {
    const r = replaceSelectedIn(text, all, '林晚', '林婉');
    assert.equal(r.text, applyAll(text, '林晚', '林婉'));
    assert.equal(r.replaced.length, 3);
    assert.deepEqual(r.missed, []);
  });

  test('勾掉一處（「林晚霞」是另一個人）：那一處原樣留著', () => {
    const r = replaceSelectedIn(text, all.slice(0, 2), '林晚', '林婉');
    assert.equal(r.text, '林婉推門。林婉沒說話。林晚霞走了。');
    assert.equal(r.replaced.length, 2);
  });

  test('挑的順序無所謂，按位置排', () => {
    const r = replaceSelectedIn(text, [all[2], all[0]], '林晚', '林婉');
    assert.equal(r.text, '林婉推門。林晚沒說話。林婉霞走了。');
  });

  test('一處都不挑：原文不動', () => {
    const r = replaceSelectedIn(text, [], '林晚', '林婉');
    assert.equal(r.text, text);
    assert.deepEqual(r.replaced, []);
  });

  test('對不上的位置（文字變過、不是一處匹配、與前一處重疊）不換，記進 missed', () => {
    const r = replaceSelectedIn(text, [{ start: 1, end: 3 }, all[1], { start: all[1].start, end: all[1].end }], '林晚', '林婉');
    assert.equal(r.text, '林晚推門。林婉沒說話。林晚霞走了。');
    assert.equal(r.replaced.length, 1);
    assert.equal(r.missed.length, 2);
  });

  test('正則：$1 在原文裡逐處展開，前後文看整份文字', () => {
    const t = '第1章 第2章 第3章';
    const ms = findMatches(t, '第(\\d)章', { regex: true }).matches;
    const r = replaceSelectedIn(t, [ms[0], ms[2]], '第(\\d)章', 'Ch$1', { regex: true });
    assert.equal(r.text, 'Ch1 第2章 Ch3');
    // 後行斷言：只認「林」後面的「晚」，看的是整份原文
    const t2 = '林晚 夜晚';
    const ms2 = findMatches(t2, '(?<=林)晚', { regex: true }).matches;
    assert.equal(ms2.length, 1);
    assert.equal(replaceSelectedIn(t2, ms2, '(?<=林)晚', '婉', { regex: true }).text, '林婉 夜晚');
  });

  test('跨行的匹配照樣換', () => {
    const t = '上一行末尾\n下一行開頭';
    const ms = findMatches(t, '末尾\\n下', { regex: true }).matches;
    assert.equal(ms.length, 1);
    assert.equal(replaceSelectedIn(t, ms, '末尾\\n下', '末尾。下', { regex: true }).text, '上一行末尾。下一行開頭');
  });

  test('壞正則、空查詢串：undefined，不拋', () => {
    assert.equal(replaceSelectedIn(text, all, '(', 'x', { regex: true }), undefined);
    assert.equal(replaceSelectedIn(text, all, '', 'x'), undefined);
  });
});

describe('匹配口徑只有一份', () => {
  test('編輯器的 findCore 轉出的就是 core 的 textFind（全書查詢替換在後端用的那一份）', () => {
    const t = 'Abc abc ABC a.b';
    for (const [q, o] of [['abc', {}], ['abc', { caseSensitive: true }], ['a.b', {}], ['a.b', { regex: true }], ['^', { regex: true }]]) {
      assert.deepEqual(findMatches(t, q, o), core.findMatches(t, q, o));
    }
    assert.equal(MATCH_LIMIT, core.MATCH_LIMIT);
  });
});
