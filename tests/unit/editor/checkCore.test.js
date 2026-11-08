/**
 * 寫作體檢的口徑（`media/src/editor/checkCore.ts`，零 DOM）。狀態列、面板、高亮映象層那一整條鏈路在
 * tests/dom/standalone/check.test.js，這裡釘口徑：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 四類 | 敏感詞 / 禁用詞 / 超出上限的比喻詞 / 英文縮寫各自認出來、各自的 class |
 * | 疊在一起 | 同一段字落在兩類裡兩類都算、都畫；同一個詞出現幾次就幾處 |
 * | 英文大小寫 | 敏感詞不分大小寫（全形當半形），禁用詞區分（與生成鏈的 `countBanned` 一樣） |
 * | 比喻詞 | 沒超上限不算、不畫；超了算超出的那幾個，每一處都畫 |
 * | 與生成鏈同一口徑 | 禁用詞每個詞的次數等於 `countBanned`、比喻詞合計等於 `countSimiles`、縮寫去重等於 `latinAcronyms` |
 * | 跳轉與替換 | 下一處（選區正好是第 k 處就去 k+1、到底繞回）、全部替換隻改第一處到最後一處那一段 |
 * | 跟著改動挪 | 平移規則與 `highlight.ts` 一樣；前後文字差（撤銷、組字中途用） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const c = loadModule('media/src/editor/checkCore.ts');
const mc = loadModule('src/core/model/manuscriptCheck.ts');
const plain = (x) => JSON.parse(JSON.stringify(x));

const VOCAB = {
  banned: ['能量', '神經'],
  sensitive: [{ term: '賭博', replacement: '博戲' }, { term: 'sb' }, { term: '能量' }],
};

describe('寫作體檢：四類', () => {
  const text = '他賭博輸了，能量耗盡。PTSD 又犯了。';
  const r = c.runCheck(text, VOCAB);

  test('敏感詞帶著替換詞', () => {
    const e = r.entries.find((x) => x.category === 'sensitive' && x.term === '賭博');
    assert.deepEqual(plain(e), { category: 'sensitive', term: '賭博', offsets: [1], length: 2, replacement: '博戲' });
  });

  test('禁用詞、英文縮寫各自認出來', () => {
    assert.deepEqual(
      r.entries.filter((x) => x.category !== 'sensitive').map((x) => [x.category, x.term, x.offsets]),
      [
        ['banned', '能量', [6]],
        ['acronym', 'PTSD', [11]],
      ]
    );
  });

  test('一共幾個問題：每一處算一個', () => {
    assert.deepEqual(plain(r.counts), { sensitive: 2, banned: 1, simile: 0, acronym: 1 });
    assert.equal(r.total, 4);
  });

  test('畫到圖層上的段：每一處一段、各類各自的 class、按起點排', () => {
    assert.deepEqual(plain(c.checkRanges(r)), [
      { start: 1, end: 3, cls: 'ed-hl-chk-sensitive' },
      { start: 6, end: 8, cls: 'ed-hl-chk-banned' },
      { start: 6, end: 8, cls: 'ed-hl-chk-sensitive' },
      { start: 11, end: 15, cls: 'ed-hl-chk-acronym' },
    ]);
  });

  test('面板裡的順序：敏感詞 → 禁用詞 → 比喻詞 → 英文縮寫，同一類裡次數多的在前', () => {
    const r2 = c.runCheck('能量，神經，神經。sb SB', VOCAB);
    assert.deepEqual(r2.entries.map((e) => `${e.category}:${e.term}`), [
      'sensitive:sb',
      'sensitive:能量',
      'banned:神經',
      'banned:能量',
      'acronym:SB',
    ]);
  });

  test('詞表還沒到（空的）：比喻詞與縮寫照查', () => {
    const r3 = c.runCheck('CPU 燒了。', c.EMPTY_VOCAB);
    assert.deepEqual(r3.entries.map((e) => e.term), ['CPU']);
  });
});

describe('寫作體檢：疊在一起、出現幾次', () => {
  test('同一段字落在兩類裡：兩類都算、都畫', () => {
    const r = c.runCheck('能量', VOCAB);
    assert.deepEqual(r.entries.map((e) => e.category), ['sensitive', 'banned']);
    assert.equal(r.total, 2);
    assert.equal(c.checkRanges(r).length, 2);
  });

  test('同一個詞出現三次就是三處', () => {
    const r = c.runCheck('賭博、賭博，又是賭博', VOCAB);
    assert.deepEqual(r.entries[0].offsets, [0, 3, 8]);
    assert.equal(r.counts.sensitive, 3);
  });

  test('兩個詞疊在同一段字上（「資料」與「資料庫」）各算各的', () => {
    const r = c.runCheck('資料庫', { banned: ['資料', '資料庫'], sensitive: [] });
    assert.deepEqual(r.entries.map((e) => [e.term, e.offsets]), [
      ['資料', [0]],
      ['資料庫', [0]],
    ]);
  });
});

describe('寫作體檢：英文大小寫', () => {
  test('敏感詞不分大小寫，全形字母當半形；位置與長度是原文的', () => {
    const r = c.runCheck('SB、Sb、ｓｂ、sb', VOCAB);
    const e = r.entries.find((x) => x.term === 'sb');
    assert.deepEqual(e.offsets, [0, 3, 6, 9]);
    assert.equal(e.length, 2);
  });

  test('禁用詞區分大小寫（與寫完一章之後的 countBanned 一樣）', () => {
    const r = c.runCheck('Qi 與 qi', { banned: ['qi'], sensitive: [] });
    assert.deepEqual(r.entries.map((e) => e.offsets), [[5]]);
  });
});

describe('寫作體檢：比喻詞只在超過上限時才算', () => {
  test(`沒超（${3} 次以內）：不算問題、不畫，合計照記`, () => {
    const r = c.runCheck('彷彿、猶如、宛如', c.EMPTY_VOCAB);
    assert.deepEqual(plain(r.similes), { total: 3, limit: 3, over: 0 });
    assert.equal(r.counts.simile, 0);
    assert.deepEqual(c.checkRanges(r), []);
  });

  test('超了：算超出的那幾個，每一處都畫', () => {
    const r = c.runCheck('彷彿、猶如、宛如、彷彿、如同', c.EMPTY_VOCAB);
    assert.deepEqual(plain(r.similes), { total: 5, limit: 3, over: 2 });
    assert.equal(r.counts.simile, 2);
    assert.equal(r.total, 2);
    assert.equal(c.checkRanges(r).filter((x) => x.cls === 'ed-hl-chk-simile').length, 5);
    assert.deepEqual(r.entries[0].term, '彷彿');
  });

  test('上限與比喻詞表就是生成鏈那一份', () => {
    assert.equal(c.runCheck('', c.EMPTY_VOCAB).similes.limit, mc.SIMILE_LIMIT);
  });
});

describe('寫作體檢：與生成鏈同一口徑（對拍）', () => {
  const samples = [
    '能量湧動，彷彿潮水；能量退去，猶如夢醒，彷彿未醒，宛如新生，如同隔世。他的神經繃緊，PTSD、CPU、PTSD。',
    '沒有問題的一段。',
    '能量能量能量神經\n\n彷彿彷彿彷彿彷彿 ＤＮＡ',
  ];
  for (const text of samples) {
    test(`禁用詞次數等於 countBanned、比喻詞合計等於 countSimiles、縮寫等於 latinAcronyms：${text.slice(0, 8)}…`, () => {
      const terms = mc.bannedTerms({ styleBanList: '- 「能量」\n- 「神經」', genre: '仙俠' });
      const r = c.runCheck(text, { banned: terms, sensitive: [] });
      const mine = r.entries
        .filter((e) => e.category === 'banned')
        .map((e) => ({ term: e.term, count: e.offsets.length }))
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
      const theirs = mc.countBanned(text, terms).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
      assert.deepEqual(plain(mine), plain(theirs));
      assert.equal(r.similes.total, mc.countSimiles(text));
      assert.deepEqual(
        [...new Set(r.entries.filter((e) => e.category === 'acronym').map((e) => e.term))],
        mc.latinAcronyms(text)
      );
    });
  }
});

describe('寫作體檢：跳轉與替換', () => {
  const entry = { offsets: [2, 10, 20], length: 2 };

  test('選區正好是第 k 處：下一下去 k+1；到底了繞回第一處', () => {
    assert.equal(c.nextOccurrence(entry, 2, 4), 1);
    assert.equal(c.nextOccurrence(entry, 20, 22), 0);
  });

  test('別的選區或游標：游標處及之後的第一處；都在前面就繞回', () => {
    assert.equal(c.nextOccurrence(entry, 0, 0), 0);
    assert.equal(c.nextOccurrence(entry, 10, 10), 1);
    assert.equal(c.nextOccurrence(entry, 11, 11), 2);
    assert.equal(c.nextOccurrence(entry, 25, 25), 0);
    assert.equal(c.nextOccurrence({ offsets: [], length: 2 }, 0, 0), -1);
  });

  test('occurrenceAt 只認選區正好蓋住某一處', () => {
    assert.equal(c.occurrenceAt(entry, 10, 12), 1);
    assert.equal(c.occurrenceAt(entry, 10, 11), -1);
    assert.equal(c.occurrenceAt(entry, 9, 11), -1);
  });

  test('全部替換：只改第一處到最後一處那一段，各處之間的字原樣', () => {
    const text = '前面賭博中間賭博後面';
    const e = c.runCheck(text, VOCAB).entries.find((x) => x.term === '賭博');
    const edit = c.replaceAllEdit(text, e, '博戲');
    assert.deepEqual(plain(edit), { start: 2, end: 8, text: '博戲中間博戲', count: 2 });
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '前面博戲中間博戲後面');
  });

  test('全部替換：大小寫不同的幾處一起換', () => {
    const text = 'SB, sb';
    const e = c.runCheck(text, { banned: [], sensitive: [{ term: 'sb', replacement: '某人' }] }).entries[0];
    const edit = c.replaceAllEdit(text, e, '某人');
    assert.equal(text.slice(0, edit.start) + edit.text + text.slice(edit.end), '某人, 某人');
  });

  test('一處都沒有時 undefined', () => {
    assert.equal(c.replaceAllEdit('x', { offsets: [], length: 1 }, 'y'), undefined);
  });
});

describe('寫作體檢：跟著改動挪', () => {
  const ranges = [
    { start: 0, end: 2, cls: 'a' },
    { start: 5, end: 7, cls: 'b' },
    { start: 10, end: 12, cls: 'c' },
  ];

  test('改動之前的不動、之後的平移、壓在改動上的丟掉（與 highlight.ts 同一條規則）', () => {
    assert.deepEqual(plain(c.shiftRanges(ranges, { at: 6, removed: '', inserted: '字' })), [
      { start: 0, end: 2, cls: 'a' },
      { start: 11, end: 13, cls: 'c' },
    ]);
    assert.deepEqual(plain(c.shiftRanges(ranges, { at: 3, removed: 'xx', inserted: '' })), [
      { start: 0, end: 2, cls: 'a' },
      { start: 3, end: 5, cls: 'b' },
      { start: 8, end: 10, cls: 'c' },
    ]);
  });

  test('前後文字差：公共字首與字尾之外的那一段', () => {
    assert.deepEqual(plain(c.diffChange('他賭博了', '他nihao賭博了')), { at: 1, removed: '', inserted: 'nihao' });
    assert.deepEqual(plain(c.diffChange('aXb', 'aYYb')), { at: 1, removed: 'X', inserted: 'YY' });
    assert.equal(c.diffChange('一樣', '一樣'), undefined);
    assert.deepEqual(plain(c.diffChange('aaa', 'aa')), { at: 2, removed: 'a', inserted: '' });
  });

  test('sameRanges', () => {
    assert.equal(c.sameRanges(ranges, ranges.map((r) => ({ ...r }))), true);
    assert.equal(c.sameRanges(ranges, ranges.slice(1)), false);
  });

  test('describeCounts：各類幾個，比喻詞說超出幾個', () => {
    const r = c.runCheck('賭博 PTSD 彷彿彷彿彷彿彷彿', VOCAB);
    assert.equal(c.describeCounts(r), '敏感詞 1 處 · 比喻詞超出 1 個 · 英文縮寫 1 處');
  });
});

describe('寫作體檢：大正文不卡', () => {
  test('十萬字、一千個敏感詞：一趟查完（< 1.5 秒，寬裕的上限只防退化成「詞數 × 全文」）', () => {
    const words = Array.from({ length: 1000 }, (_, i) => ({ term: `詞${i}號` }));
    const text = '他走進巷子，雨下得很大。'.repeat(8500) + '詞999號';
    const t0 = Date.now();
    const r = c.runCheck(text, { banned: ['能量'], sensitive: words });
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
    assert.deepEqual(r.entries.map((e) => e.term), ['詞999號']);
  });
});
