/**
 * 自定義敏感詞表的解析（`src/core/model/sensitiveWords.ts`，純函式）。作者手維護這份檔案（第 1 條：認不出的行跳過、絕不拋），
 * 內建編輯器的寫作體檢拿解析結果在正文裡找字。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 一行一個詞 | 前後空白不算、詞中間的空格留著、行號從 1 起 |
 * | 註釋與空行 | `#` 開頭（前面可以有空白）的整行不算，空行不算；詞裡的 `#` 不當註釋 |
 * | 替換詞 | `詞 => 替換詞`，左右空白不算；只認半形 `=>` |
 * | 壞行 | `=>` 前沒詞、後沒替換詞、兩個 `=>`、太長、替換詞與原詞一樣、與前面某行重複（英文不分大小寫）——跳過並說出第幾行、為什麼 |
 * | 容錯 | BOM、CRLF、讀不到（undefined）都不拋 |
 * | 模板 | 全是註釋、一個詞都不生效 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const s = loadModule('src/core/model/sensitiveWords.ts');
const plain = (x) => JSON.parse(JSON.stringify(x));

describe('敏感詞表：一行一個詞', () => {
  test('前後空白不算、詞中間的空格留著、行號從 1 起', () => {
    const r = s.parseSensitiveWords('  某平臺  \nfree money\n賭博');
    assert.deepEqual(plain(r.terms), [
      { term: '某平臺', line: 1 },
      { term: 'free money', line: 2 },
      { term: '賭博', line: 3 },
    ]);
    assert.deepEqual(r.bad, []);
  });

  test('# 開頭的行是註釋（前面可以有空白），空行不算；詞裡的 # 不當註釋', () => {
    const r = s.parseSensitiveWords('# 註釋\n\n   # 也是註釋\n   \nC#\n第一#');
    assert.deepEqual(plain(r.terms), [
      { term: 'C#', line: 5 },
      { term: '第一#', line: 6 },
    ]);
  });
});

describe('敏感詞表：替換詞', () => {
  test('「詞 => 替換詞」，左右空白不算', () => {
    const r = s.parseSensitiveWords('賭博=>博戲\n  殺人   =>   傷人  ');
    assert.deepEqual(plain(r.terms), [
      { term: '賭博', replacement: '博戲', line: 1 },
      { term: '殺人', replacement: '傷人', line: 2 },
    ]);
  });

  test('只認半形的「=>」：全形的那幾個字原樣是詞的一部分', () => {
    const r = s.parseSensitiveWords('賭博＝＞博戲');
    assert.deepEqual(plain(r.terms), [{ term: '賭博＝＞博戲', line: 1 }]);
  });
});

describe('敏感詞表：壞行跳過，說出第幾行、為什麼', () => {
  const r = s.parseSensitiveWords(
    ['好詞', '=> 替換', '缺替換 =>', 'a => b => c', '長'.repeat(33), '同 => 同', 'Hello', 'HELLO => hi', 'ｈｅｌｌｏ', '後面的好詞'].join('\n')
  );

  test('好的行照收，壞行不連累後面', () => {
    assert.deepEqual(r.terms.map((t) => t.term), ['好詞', 'Hello', '後面的好詞']);
  });

  test('每一個壞行都記下行號', () => {
    assert.deepEqual(r.bad.map((b) => b.line), [2, 3, 4, 5, 6, 8, 9]);
  });

  test('原因說得出', () => {
    const reason = Object.fromEntries(r.bad.map((b) => [b.line, b.reason]));
    assert.match(reason[2], /前面沒有詞/);
    assert.match(reason[3], /後面沒有替換詞/);
    assert.match(reason[4], /只能有一個/);
    assert.match(reason[5], /太長/);
    assert.match(reason[6], /一樣/);
    assert.match(reason[8], /第 7 行/);
    assert.match(reason[9], /第 7 行/);
  });

  test('正好 32 個字不算太長', () => {
    assert.equal(s.parseSensitiveWords('長'.repeat(32)).terms.length, 1);
  });
});

describe('敏感詞表：容錯', () => {
  test('BOM 與 CRLF', () => {
    const r = s.parseSensitiveWords('﻿甲\r\n乙 => 丙\r\n');
    assert.deepEqual(plain(r.terms), [
      { term: '甲', line: 1 },
      { term: '乙', replacement: '丙', line: 2 },
    ]);
  });

  test('讀不到（undefined）、不是字串：當空的，不拋', () => {
    assert.deepEqual(plain(s.parseSensitiveWords(undefined)), { terms: [], bad: [] });
    assert.deepEqual(plain(s.parseSensitiveWords(42)), { terms: [], bad: [] });
  });

  test('模板全是註釋：一個詞都不生效、沒有壞行', () => {
    const r = s.parseSensitiveWords(s.SENSITIVE_TEMPLATE);
    assert.deepEqual(plain(r), { terms: [], bad: [] });
    assert.match(s.SENSITIVE_TEMPLATE, /=>/);
  });
});
