/**
 * 「名詞補全」的匹配與排序（`media/src/editor/namesCore.ts`，純函式、零 DOM）。
 * 彈出框本身（按鍵、插入、撤銷、自動模式、組字保護）在 tests/dom/standalone/names.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 哪些檔案補全 | 正文、草稿、細綱、角色卡、設定、大綱、敘事線；`setting`（含配置）、文風、`other`、沒給 kind 不補 |
 * | 切表 | 正名在前、別名去重去空白、型別那一格（角色 / 分類 / 設定）、空名字跳過、字首與全稱表 |
 * | 查詢詞 | 從游標往前 1~4 個字、挑能匹配上名字開頭的最長那段；碰到標點空白就停；匹配不上是空查詢；不劈開代理對 |
 * | 匹配 | 只認開頭、不分大小寫；正名先於別名；一個名詞一行；別名命中插別名 |
 * | 排序 | 最近在本檔案出現（查詢詞之前，越近越前）→ 只在後面出現 → 沒出現；同檔角色 → 設定 → 未建條目、短的在前 |
 * | 邊打邊彈 | 至少 2 個字、打完整了不彈、剩下那截已在游標後面不彈、組字中 / 刪字 / 貼上 / 程式改寫 / 有選區不彈 |
 * | 插入 | 換掉查詢詞（與選區），補全整個叫法，游標落在後面 |
 * | 名詞高亮 | 正名與別名都認、不分大小寫；長的優先不重疊；一個字的不認；英文要整詞；卡自己那一份不標它自己；三種來源三種 class；撞了的叫法歸表裡排前面的；按字認回那一條 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  AUTO_MIN_CHARS,
  MAX_QUERY,
  NAME_LIST_LIMIT,
  autoPopQuery,
  autoQueryAt,
  buildNameCatalog,
  buildNameMatcher,
  completionApplies,
  insertionFor,
  isNameChar,
  matchNames,
  nameItemOf,
  nameRanges,
  queryBefore,
  queryBetween,
} = loadModule('media/src/editor/namesCore.ts');

/** 樣本表：角色（帶別名）、設定（帶關鍵詞與分類）、未建條目。 */
function sample() {
  return buildNameCatalog({
    initialized: true,
    names: [
      { name: '林昭', aliases: ['阿昭', '小林'], source: 'character', category: '', brief: '青雲宗外門弟子。', path: 'c/林昭.md' },
      { name: '林昭陽', aliases: [], source: 'character', category: '', brief: '', path: 'c/林昭陽.md' },
      { name: '沈懷山', aliases: ['老沈'], source: 'character', category: '', brief: '', path: 'c/沈懷山.md' },
      { name: '青雲宗', aliases: ['青雲門', '宗門'], source: 'lore', category: '門派', brief: '正道第一大宗', path: 'l/青雲宗.md' },
      { name: '青崖鎮', aliases: [], source: 'lore', category: '地點', brief: '', path: 'l/青崖镇.md' },
      { name: '太上忘情訣', aliases: [], source: 'lore', category: '', brief: '', path: 'l/太上忘情訣.md' },
      { name: '黑水河', aliases: [], source: 'unfiled', category: '地點', brief: '河上起了霧' },
      { name: 'Lin Zhao', aliases: [], source: 'character', category: '', brief: '', path: 'c/lin.md' },
    ],
  });
}

const match = (catalog, query, text = '', caret = text.length, extra = {}) =>
  matchNames(catalog, query, { text, start: caret - query.length, caret, ...extra });
const forms = (result) => result.items.map((c) => c.form);

describe('namesCore › 哪些檔案補全', () => {
  test('正文、草稿、細綱、角色卡、設定、大綱、敘事線補全', () => {
    for (const kind of ['chapter', 'draft', 'plot', 'character', 'lore', 'outline', 'threads']) {
      assert.equal(completionApplies(kind), true, kind);
    }
  });

  test('架構幾件（setting，含小說配置）、敏感詞表（sensitive）、文風、全文大綱、技能、other、沒給 kind 不補', () => {
    for (const kind of ['setting', 'sensitive', 'style', 'globalSummary', 'skill', 'other', undefined, '']) {
      assert.equal(completionApplies(kind), false, String(kind));
    }
  });
});

describe('namesCore › 切表', () => {
  test('正名在前、別名去重去空白（與正名一樣的去掉）', () => {
    const c = buildNameCatalog({
      initialized: true,
      names: [{ name: ' 林昭 ', aliases: ['阿昭', ' 阿昭', '', '林昭', '小林'], source: 'character', category: '', brief: '' }],
    });
    assert.deepEqual(c.items[0].forms.map((f) => [f.text, f.alias]), [['林昭', false], ['阿昭', true], ['小林', true]]);
    assert.deepEqual(c.items[0].aliases, ['阿昭', '小林']);
  });

  test('型別那一格：角色卡寫「角色」，設定與未建條目寫分類，沒有分類寫「設定」', () => {
    const c = sample();
    const badge = (name) => c.items.find((i) => i.name === name).badge;
    assert.equal(badge('林昭'), '角色');
    assert.equal(badge('青雲宗'), '門派');
    assert.equal(badge('太上忘情訣'), '設定');
    assert.equal(badge('黑水河'), '地點');
  });

  test('空名字跳過；沒給表時是空的', () => {
    assert.equal(buildNameCatalog({ initialized: true, names: [{ name: ' ', aliases: [], source: 'lore', category: '', brief: '' }] }).items.length, 0);
    assert.equal(buildNameCatalog(undefined).items.length, 0);
  });

  test('還不是小說工程：initialized 是 false', () => {
    assert.equal(buildNameCatalog({ initialized: false, names: [] }).initialized, false);
  });
});

describe('namesCore › 從游標前取查詢詞', () => {
  const c = sample();

  test(`最多往前取 ${MAX_QUERY} 個字，挑能匹配上名字開頭的最長那段`, () => {
    assert.deepEqual(queryBefore(c, '他看見林', 4), { query: '林', start: 3 });
    assert.deepEqual(queryBefore(c, '他看見林昭', 5), { query: '林昭', start: 3 });
    assert.deepEqual(queryBefore(c, '那天青雲', 4), { query: '青雲', start: 2 });
    assert.deepEqual(queryBefore(c, '修太上忘情', 5), { query: '太上忘情', start: 1 });
  });

  test('超過 4 個字的名字：只看游標前 4 個字（再往前的不取）', () => {
    // 「太上忘情訣」打到「上忘情訣」時，往前 4 個字是「上忘情訣」，不是哪個名字的開頭；3、2、1 個字也不是。
    assert.deepEqual(queryBefore(c, '太上忘情訣', 5), { query: '', start: 5 });
  });

  test('碰到標點、空白就停', () => {
    assert.deepEqual(queryBefore(c, '“林', 2), { query: '林', start: 1 });
    assert.deepEqual(queryBefore(c, '林 昭', 3), { query: '', start: 3 });
    assert.deepEqual(queryBefore(c, '青雲，', 3), { query: '', start: 3 });
  });

  test('什麼都匹配不上：空查詢，起點就是游標', () => {
    assert.deepEqual(queryBefore(c, '他走了', 3), { query: '', start: 3 });
    assert.deepEqual(queryBefore(c, '', 0), { query: '', start: 0 });
  });

  test('游標在中間：只看游標前面', () => {
    assert.deepEqual(queryBefore(c, '林走了', 1), { query: '林', start: 0 });
  });

  test('英文不分大小寫，查詢詞保留原樣', () => {
    assert.deepEqual(queryBefore(c, 'see lin', 7), { query: 'lin', start: 4 });
  });

  test('不劈開代理對（𠀋 是一個字）', () => {
    const cc = buildNameCatalog({ initialized: true, names: [{ name: '𠀋山', aliases: [], source: 'lore', category: '', brief: '' }] });
    assert.deepEqual(queryBefore(cc, '去𠀋', 3), { query: '𠀋', start: 1 });
  });

  test('間隔號、連字元算名字裡的字', () => {
    assert.equal(isNameChar('·'), true);
    assert.equal(isNameChar('-'), true);
    assert.equal(isNameChar('，'), false);
    assert.equal(isNameChar(' '), false);
  });

  test('手動彈出之後接著打字：起點到游標還是查詢詞；碰到標點、游標退到起點前面就不是了', () => {
    assert.equal(queryBetween('他看見林昭', 3, 5), '林昭');
    assert.equal(queryBetween('他看見林，', 3, 5), undefined);
    assert.equal(queryBetween('他看見', 3, 2), undefined);
    assert.equal(queryBetween('他看見', 3, 3), '');
  });
});

describe('namesCore › 匹配', () => {
  const c = sample();

  test('只認開頭：「昭」不匹配「林昭」', () => {
    assert.deepEqual(forms(match(c, '昭')), []);
  });

  test('一個名詞只列一行，正名對得上就是正名', () => {
    assert.deepEqual(forms(match(c, '林')), ['林昭', '林昭陽']);
  });

  test('正名對不上、別名對得上：插別名，標著別名', () => {
    const r = match(c, '阿');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].form, '阿昭');
    assert.equal(r.items[0].viaAlias, true);
    assert.equal(r.items[0].item.name, '林昭');
  });

  test('設定的關鍵詞也是別名', () => {
    assert.deepEqual(match(c, '宗').items.map((x) => [x.form, x.item.name]), [['宗門', '青雲宗']]);
  });

  test('不分大小寫', () => {
    assert.deepEqual(forms(match(c, 'lin')), ['Lin Zhao']);
  });

  test('高亮查詢詞那幾個字（碼位）', () => {
    assert.deepEqual(match(c, '青雲').items[0].hits, [0, 1]);
  });

  test('空查詢列全部', () => {
    assert.equal(match(c, '').total, c.items.length);
  });

  test(`最多列 ${NAME_LIST_LIMIT} 條，報一共幾條`, () => {
    const many = buildNameCatalog({
      initialized: true,
      names: Array.from({ length: 80 }, (_, i) => ({ name: `甲${i}`, aliases: [], source: 'lore', category: '', brief: '' })),
    });
    const r = match(many, '甲');
    assert.equal(r.items.length, NAME_LIST_LIMIT);
    assert.equal(r.total, 80);
  });
});

describe('namesCore › 排序', () => {
  const c = sample();

  test('沒出現過：角色 → 設定 → 未建條目', () => {
    const r = match(c, '');
    const sources = r.items.map((x) => x.item.source);
    assert.deepEqual(sources, [...sources].sort((a, b) => ['character', 'lore', 'unfiled'].indexOf(a) - ['character', 'lore', 'unfiled'].indexOf(b)));
  });

  test('最近在本檔案出現的排前面：越近越前', () => {
    const text = '沈懷山推門進來。青崖鎮下著雨。';
    const r = match(c, '', text);
    assert.deepEqual(forms(r).slice(0, 2), ['青崖鎮', '沈懷山']);
  });

  test('別名出現過也算', () => {
    const r = match(c, '', '老沈笑了。');
    assert.equal(r.items[0].item.name, '沈懷山');
  });

  test('只在游標後面出現過的排在前面出現過的後面、沒出現過的前面', () => {
    const text = '林昭說完。|青雲宗來人了。';
    const caret = text.indexOf('|');
    const r = matchNames(c, '', { text, start: caret, caret });
    assert.deepEqual(r.items.slice(0, 2).map((x) => [x.form, x.rank]), [['林昭', 0], ['青雲宗', 1]]);
  });

  test('正在打的那幾個字不算「出現過」', () => {
    // 游標前的「林昭」就是查詢詞本身：不算之前出現過（rank 2），否則每次都把正在打的那個排第一。
    const r = match(c, '林昭', '他看見林昭');
    assert.deepEqual(r.items.map((x) => [x.form, x.rank]), [['林昭', 2], ['林昭陽', 2]]);
  });

  test('同一檔裡短的在前', () => {
    assert.deepEqual(forms(match(c, '林昭')), ['林昭', '林昭陽']);
  });
});

describe('namesCore › 邊打邊彈的判定', () => {
  const c = sample();
  /** 在 `before` 末尾打進 `typed`（鍵盤或輸入法上屏），返回判定。 */
  const typed = (before, typedText, extra = {}) => {
    const text = before + typedText;
    return autoPopQuery(c, {
      source: 'composition',
      change: { at: before.length, removed: '', inserted: typedText },
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
      ...extra,
    });
  };

  test(`至少 ${AUTO_MIN_CHARS} 個字才彈：「沈懷」彈、「沈」不彈`, () => {
    assert.deepEqual(typed('他看見', '沈懷'), { query: '沈懷', start: 3 });
    assert.equal(typed('他看見', '沈'), undefined);
  });

  test('打完整了不彈：「沈懷山」', () => {
    assert.equal(typed('他看見沈懷', '山'), undefined);
  });

  test('打完整了不彈，哪怕還有更長的名字以它開頭：「林昭」（還有「林昭陽」）', () => {
    assert.equal(typed('', '林昭'), undefined);
  });

  test('別名的開頭也彈：「青雲」→ 青雲宗 / 青雲門', () => {
    assert.deepEqual(typed('', '青雲'), { query: '青雲', start: 0 });
  });

  test('剩下那截已經在游標後面：不彈', () => {
    const text = '沈懷山';
    assert.equal(
      autoPopQuery(c, { source: 'typing', change: { at: 1, removed: '', inserted: '懷' }, text, selectionStart: 2, selectionEnd: 2 }),
      undefined
    );
  });

  test('鍵盤打字也彈', () => {
    assert.ok(typed('', '青崖', { source: 'typing' }));
  });

  test('組字中途不彈', () => {
    assert.equal(typed('', '沈懷', { composing: true }), undefined);
  });

  test('刪字、貼上、程式改寫、撤銷不彈', () => {
    assert.equal(typed('', '沈懷', { source: 'input' }), undefined);
    assert.equal(typed('', '沈懷', { source: 'program' }), undefined);
    assert.equal(typed('', '沈懷', { source: 'undo' }), undefined);
    assert.equal(
      autoPopQuery(c, { source: 'typing', change: { at: 2, removed: '山', inserted: '' }, text: '沈懷', selectionStart: 2, selectionEnd: 2 }),
      undefined
    );
  });

  test('沒有 change（組字中途那幾下）不彈', () => {
    assert.equal(autoPopQuery(c, { source: 'composition', text: '沈懷', selectionStart: 2, selectionEnd: 2 }), undefined);
  });

  test('有選區、游標不在插進來的字後面：不彈', () => {
    assert.equal(typed('', '沈懷', { selectionStart: 0 }), undefined);
    assert.equal(typed('', '沈懷', { selectionStart: 1, selectionEnd: 1 }), undefined);
  });

  test('接著打了別的字：不再是哪個名字的開頭，不彈', () => {
    assert.equal(typed('沈懷', '了'), undefined);
  });

  test('退格之後重判（autoQueryAt）：還是沒打完的開頭就留著', () => {
    assert.deepEqual(autoQueryAt(c, '青雲', 2), { query: '青雲', start: 0 });
    assert.equal(autoQueryAt(c, '青', 1), undefined);
  });

  test('邊打邊彈只列沒打完的：正好是查詢詞的那個叫法不列', () => {
    const r = match(c, '青雲', '青雲', 2, { unfinished: true });
    assert.deepEqual(forms(r), ['青雲宗']);
  });
});

describe('namesCore › 插入時替換哪一段', () => {
  test('換掉查詢詞，補全整個名字，游標落在後面', () => {
    // 「他看見林」，查詢詞「林」從 3 起，游標在 4。
    assert.deepEqual(insertionFor(3, 4, 4, '林昭'), { start: 3, end: 4, text: '林昭', caret: 5 });
  });

  test('空查詢：在游標處插入', () => {
    assert.deepEqual(insertionFor(4, 4, 4, '青雲宗'), { start: 4, end: 4, text: '青雲宗', caret: 7 });
  });

  test('有選區：連選中的一起換掉', () => {
    assert.deepEqual(insertionFor(3, 4, 6, '林昭'), { start: 3, end: 6, text: '林昭', caret: 5 });
  });

  test('別名插別名', () => {
    assert.deepEqual(insertionFor(0, 1, 1, '阿昭').text, '阿昭');
  });
});

describe('namesCore › 名詞高亮：正文裡哪幾段是名字', () => {
  const matcher = () => buildNameMatcher(sample());
  /** [那一段字, class] */
  const marks = (text, selfPath) =>
    nameRanges(matcher(), text, selfPath).map((r) => [text.slice(r.start, r.end), r.cls.replace('ed-hl-name-', '')]);

  test('正名、別名（角色別名與設定關鍵詞）都認，三種來源三種 class', () => {
    assert.deepEqual(marks('阿昭走進青雲門，沈懷山在黑水河邊等他。'), [
      ['阿昭', 'character'],
      ['青雲門', 'lore'],
      ['沈懷山', 'character'],
      ['黑水河', 'unfiled'],
    ]);
  });

  test('長的優先、不重疊：林昭陽不認成林昭；同一處起頭取最長的', () => {
    assert.deepEqual(marks('林昭陽看著林昭。'), [
      ['林昭陽', 'character'],
      ['林昭', 'character'],
    ]);
  });

  test('一個字的叫法不認（滿屏都是），兩個字起認', () => {
    const one = buildNameMatcher(
      buildNameCatalog({
        initialized: true,
        names: [
          { name: '道', aliases: [], source: 'lore', category: '概念', brief: '', path: 'l/道.md' },
          { name: '靈氣', aliases: ['氣'], source: 'lore', category: '概念', brief: '', path: 'l/靈氣.md' },
        ],
      })
    );
    const text = '道心不穩，氣息全亂，靈氣倒灌。';
    assert.deepEqual(nameRanges(one, text).map((r) => text.slice(r.start, r.end)), ['靈氣']);
  });

  test('英文叫法不分大小寫、要整詞：Linear 裡那一截不算', () => {
    assert.deepEqual(marks('lin zhao said hi. LIN ZHAO again. Lin Zhaoxyz no.'), [
      ['lin zhao', 'character'],
      ['LIN ZHAO', 'character'],
    ]);
  });

  test('卡或條目自己那一份裡不標它自己，別的照標', () => {
    assert.deepEqual(marks('林昭，外號阿昭，青雲宗弟子。', 'c/林昭.md'), [['青雲宗', 'lore']]);
  });

  test('兩條叫法撞了：歸表裡排前面的那條（角色先於設定）', () => {
    const clash = buildNameMatcher(
      buildNameCatalog({
        initialized: true,
        names: [
          { name: '林昭', aliases: ['小林'], source: 'character', category: '', brief: '', path: 'c/林昭.md' },
          { name: '小林寺', aliases: ['小林'], source: 'lore', category: '門派', brief: '', path: 'l/小林寺.md' },
        ],
      })
    );
    assert.equal(nameItemOf(clash, '小林').name, '林昭');
    const text = '小林去了小林寺。';
    assert.deepEqual(
      nameRanges(clash, text).map((r) => [text.slice(r.start, r.end), r.item.name]),
      [
        ['小林', '林昭'],
        ['小林寺', '小林寺'],
      ]
    );
  });

  test('按那一段字認回表裡那一條（懸停浮窗用）：不分大小寫，不認識的給 undefined', () => {
    const m = matcher();
    assert.equal(nameItemOf(m, '阿昭').name, '林昭');
    assert.equal(nameItemOf(m, 'LIN ZHAO').name, 'Lin Zhao');
    assert.equal(nameItemOf(m, '路人甲'), undefined);
  });

  test('空表、空文字：什麼都不標', () => {
    assert.deepEqual(nameRanges(buildNameMatcher(buildNameCatalog({ initialized: true, names: [] })), '林昭'), []);
    assert.deepEqual(nameRanges(matcher(), ''), []);
  });
});
