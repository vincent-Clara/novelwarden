/**
 * 「轉到…」（Ctrl+P）的匹配與排序（`media/src/editor/quickOpenCore.ts`，純函式、零 DOM）。
 * 面板本身（按鍵、開啟什麼、焦點）在 tests/dom/standalone/quickOpen.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 章號 | `12` / `第12章` / `第 12 章` / `第十二章` / `十二` / 全形都直接命中第 12 章並排第一；中文數字含「十」「百」「零」的常見寫法 |
 * | 標題、名字 | 子串優先於按先後順序的模糊；開頭就是、整個就是的更靠前；中文按字 |
 * | 別名 | 角色別名命中，小字裡高亮那個別名 |
 * | 路徑兜底 | 名字裡沒有的，按檔名 / 卷目錄 / 路徑找，小字換成那個路徑 |
 * | 空輸入 | 最近開啟的（同一章的正文與細綱算一條、認不出的跳過）再接前幾章 |
 * | 上限 | 最多列 50 條、報一共幾條；幾千章也不慢 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  QUICK_OPEN_LIMIT,
  LEAD_CHAPTERS,
  RECENT_KEPT,
  buildCatalog,
  highlightSegments,
  matchChars,
  parseChapterNo,
  parseChineseNumber,
  pushRecent,
  searchQuickOpen,
} = loadModule('media/src/editor/quickOpenCore.ts');

/** 一份樣本索引：分卷的章、只有細綱的章、第 120 章（章號字首）、角色帶別名、設定、文件、草稿。 */
function sampleIndex() {
  const ch = (no, title, volume, extra = {}) => {
    const stem = `${String(no).padStart(3, '0')}-${title}`;
    const dir = volume ? `${volume}/` : '';
    return {
      no,
      title,
      volume,
      chapterPath: `chapters/${dir}${stem}.md`,
      plotPath: `.novelwarden/summaries/${dir}${stem}.md`,
      words: 3000 + no,
      ...extra,
    };
  };
  return {
    initialized: true,
    chapters: [
      ch(1, '楔子', ''),
      ch(2, '青山雲外', '第一卷'),
      ch(3, '夜訪', '第一卷'),
      ch(12, '夜入青雲', '第一卷'),
      // 只有細綱、還沒有正文。
      { no: 13, title: '青雲夜', volume: '第二卷', plotPath: '.novelwarden/summaries/第二卷/013-青雲夜.md', words: 0 },
      ch(105, '林昭歸來', '第二卷'),
      ch(120, '風雪', '第二卷'),
    ],
    characters: [
      { name: '林昭', aliases: ['阿昭', '小林'], path: '.novelwarden/characters/林昭.md' },
      { name: '李叔', aliases: [], path: '.novelwarden/characters/配角/李叔.md' },
    ],
    lore: [{ title: '示例設定', path: '.novelwarden/lore/example-setting.md' }],
    docs: [
      { key: 'config', label: '小說配置', path: '.novelwarden/config.md' },
      { key: 'outline', label: '情節大綱', path: '.novelwarden/outline.md' },
      { key: 'style', label: '文風指南', path: '.novelwarden/style.md' },
      { key: 'threads', label: '沈家舊案', path: '.novelwarden/threads/沈家舊案.md' },
    ],
    drafts: [{ path: 'drafts/第一卷/003-夜訪.md', name: '003-夜訪.md', no: 3 }],
  };
}

const catalog = buildCatalog(sampleIndex());
const search = (q, opts) => searchQuickOpen(catalog, q, opts);
const names = (q, opts) => search(q, opts).hits.map((h) => h.entry.name);
const first = (q, opts) => search(q, opts).hits[0];
/** 一段字裡高亮的那幾個字，連起來。 */
const marked = (text, hits) => highlightSegments(text, hits).filter((s) => s.hit).map((s) => s.text).join('');

describe('quickOpenCore › 章號', () => {
  for (const [q, no] of [
    ['12', 12],
    ['012', 12],
    ['第12章', 12],
    ['第 12 章', 12],
    ['12章', 12],
    ['第12', 12],
    ['第十二章', 12],
    ['十二', 12],
    ['第十二', 12],
    ['１２', 12],
    ['十', 10],
    ['第二十章', 20],
    ['第一百零五章', 105],
    ['一百零五', 105],
    ['一百一十二', 112],
    ['一百十', 110],
    ['兩百', 200],
    ['第一〇五回', 105],
    ['一千零一', 1001],
    ['三萬', 30000],
  ]) {
    test(`「${q}」認成第 ${no} 章`, () => {
      assert.equal(parseChapterNo(q), no);
    });
  }

  for (const q of ['', '第', '第一卷', '12a', '三叔', '夜訪', 'ch12', '第12章夜']) {
    test(`「${q}」不是章號`, () => {
      assert.equal(parseChapterNo(q), undefined);
    });
  }

  test('中文數字逐位寫（一二三 = 123）與單個字', () => {
    assert.equal(parseChineseNumber('一二三'), 123);
    assert.equal(parseChineseNumber('零'), 0);
    assert.equal(parseChineseNumber('两'), 2);
    assert.equal(parseChineseNumber('二十三'), 23);
    assert.equal(parseChineseNumber('abc'), undefined);
  });

  for (const q of ['12', '第12章', '第 12 章', '第十二章', '十二', '１２']) {
    test(`「${q}」直接命中第 12 章並排第一`, () => {
      const hit = first(q);
      assert.equal(hit.entry.key, 'chapter:12');
      assert.equal(hit.score, 1000);
    });
  }

  test('章號命中時小字裡的「第 12 章」高亮', () => {
    const hit = first('第十二章');
    assert.equal(hit.detail, '第 12 章 · 第一卷 · 3012 字');
    assert.equal(marked(hit.detail, hit.detailHits), '第 12 章');
  });

  test('只打阿拉伯數字時也列出以它開頭的章（12 → 第 120 章），排在第 12 章之後', () => {
    const keys = search('12').hits.map((h) => h.entry.key);
    assert.deepEqual(keys.slice(0, 2), ['chapter:12', 'chapter:120']);
  });

  test('中文章號不帶字首那一檔（十二 只命中第 12 章，不拉出第 120 章）', () => {
    assert.ok(!search('十二').hits.some((h) => h.entry.key === 'chapter:120'));
  });

  test('「一百零五」命中第 105 章並排第一', () => {
    assert.equal(first('一百零五').entry.key, 'chapter:105');
  });

  test('章號對不上任何一章時不報錯，照樣按名字找', () => {
    assert.deepEqual(search('第九十九章').hits, []);
  });
});

describe('quickOpenCore › 標題、名字與別名', () => {
  test('標題子串命中，匹配的字高亮', () => {
    const hit = first('夜訪');
    assert.equal(hit.entry.key, 'chapter:3');
    assert.equal(marked(hit.entry.name, hit.nameHits), '夜訪');
  });

  test('子串優先於按先後順序的模糊（青雲：「夜入青雲」「青雲夜」在「青山雲外」前面）', () => {
    const list = names('青雲');
    assert.ok(list.indexOf('青山雲外') > list.indexOf('夜入青雲'), list.join('、'));
    assert.ok(list.indexOf('青山雲外') > list.indexOf('青雲夜'), list.join('、'));
  });

  test('開頭就是的子串排在中間才有的前面（青雲夜 在 夜入青雲 前面）', () => {
    const list = names('青雲');
    assert.ok(list.indexOf('青雲夜') < list.indexOf('夜入青雲'), list.join('、'));
  });

  test('整個就是的排在只是開頭的前面（林昭 的角色卡在「林昭歸來」前面）', () => {
    const list = names('林昭');
    assert.deepEqual(list.slice(0, 2), ['林昭', '林昭歸來']);
  });

  test('模糊匹配按字的先後順序（林歸 → 林昭歸來，高亮林、歸兩個字）', () => {
    const hit = first('林歸');
    assert.equal(hit.entry.name, '林昭歸來');
    assert.equal(marked(hit.entry.name, hit.nameHits), '林歸');
  });

  test('字的順序反了不算（歸林 不命中林昭歸來的名字）', () => {
    assert.ok(!search('歸林').hits.some((h) => h.entry.name === '林昭歸來' && h.nameHits.length > 0));
  });

  test('只有細綱的章照樣找得到，小字說「只有細綱」', () => {
    const hit = first('青雲夜');
    assert.equal(hit.entry.key, 'chapter:13');
    assert.equal(hit.detail, '第 13 章 · 第二卷 · 只有細綱');
    assert.equal(hit.entry.path, '.novelwarden/summaries/第二卷/013-青雲夜.md');
  });

  test('角色別名命中角色卡，小字裡高亮那個別名', () => {
    const hit = first('阿昭');
    assert.equal(hit.entry.name, '林昭');
    assert.equal(hit.entry.kind, 'character');
    assert.equal(hit.detail, '別名 阿昭 / 小林');
    assert.equal(marked(hit.detail, hit.detailHits), '阿昭');
  });

  test('第二個別名的高亮落在它自己身上', () => {
    const hit = first('小林');
    assert.equal(marked(hit.detail, hit.detailHits), '小林');
  });

  test('名字命中排在別名命中前面', () => {
    const idx = buildCatalog({
      initialized: true,
      chapters: [],
      characters: [
        { name: '老周', aliases: ['掌櫃'], path: 'a.md' },
        { name: '掌櫃', aliases: [], path: 'b.md' },
      ],
      lore: [],
      docs: [],
      drafts: [],
    });
    assert.deepEqual(searchQuickOpen(idx, '掌櫃').hits.map((h) => h.entry.path), ['b.md', 'a.md']);
  });

  test('設定標題、檔名都認', () => {
    assert.equal(first('示例').entry.kind, 'lore');
    assert.equal(first('大綱').entry.name, '情節大綱');
    assert.equal(first('大綱').entry.badge, '架構');
    assert.equal(first('文風').entry.badge, '檔案');
    // 敘事線一條線一項，名字是線名，型別標記寫「敘事線」。
    assert.equal(first('舊案').entry.badge, '敘事線');
  });

  test('英文不分大小寫', () => {
    assert.equal(first('EXAMPLE').entry.kind, 'lore');
  });

  test('查詢裡的空白不算（林 昭 = 林昭）', () => {
    assert.equal(first('林 昭').entry.name, '林昭');
  });
});

describe('quickOpenCore › 路徑兜底', () => {
  test('名字裡沒有的按路徑找（第一卷 → 那一卷的章），小字換成命中的路徑並高亮', () => {
    const hits = search('第一卷').hits;
    const keys = hits.map((h) => h.entry.key);
    for (const k of ['chapter:2', 'chapter:3', 'chapter:12']) {
      assert.ok(keys.includes(k), keys.join('、'));
    }
    assert.ok(!keys.includes('chapter:1'));
    const ch3 = hits.find((h) => h.entry.key === 'chapter:3');
    assert.equal(ch3.detail, 'chapters/第一卷/003-夜訪.md');
    assert.equal(marked(ch3.detail, ch3.detailHits), '第一卷');
  });

  test('檔名兜底（example → 標題是「示例設定」的那一條）', () => {
    const hit = first('example');
    assert.equal(hit.entry.name, '示例設定');
    assert.equal(marked(hit.detail, hit.detailHits), 'example');
  });

  test('路徑命中排在名字命中後面（夜訪：章節、草稿名字都有，路徑裡有的不搶前面）', () => {
    const hits = search('夜訪').hits;
    assert.equal(hits[0].entry.key, 'chapter:3');
    assert.ok(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score));
  });

  test('路徑模糊也認（smrs → summaries 下的細綱）', () => {
    assert.ok(search('smrs').total > 0);
  });

  test('哪兒都沒有：一條都不給', () => {
    assert.deepEqual(search('zzzz'), { hits: [], total: 0 });
  });
});

describe('quickOpenCore › 空輸入與最近開啟的', () => {
  test('沒有最近開啟的：列前幾章，按章號', () => {
    const { hits } = search('');
    assert.deepEqual(hits.map((h) => h.entry.no), [1, 2, 3, 12, 13, 105, 120]);
    assert.ok(hits.every((h) => h.group === 'chapters'));
  });

  test('最近開啟的排在前面，再接前幾章（已經列過的章不重複）', () => {
    const { hits } = search('', {
      recent: ['.novelwarden/characters/林昭.md', 'chapters/第一卷/003-夜訪.md'],
    });
    assert.deepEqual(hits.slice(0, 2).map((h) => h.entry.key), ['file:.novelwarden/characters/林昭.md', 'chapter:3']);
    assert.deepEqual(hits.slice(0, 2).map((h) => h.group), ['recent', 'recent']);
    assert.equal(hits.filter((h) => h.entry.key === 'chapter:3').length, 1);
    assert.equal(hits[2].group, 'chapters');
  });

  test('同一章的正文與細綱算一條；不在索引裡的（刪了、不是這幾類）跳過', () => {
    const { hits } = search('', {
      recent: [
        '.novelwarden/summaries/第一卷/012-夜入青雲.md',
        'chapters/第一卷/012-夜入青雲.md',
        'notes/隨手記.md',
        '.novelwarden/outline.md',
      ],
    });
    const recent = hits.filter((h) => h.group === 'recent').map((h) => h.entry.key);
    assert.deepEqual(recent, ['chapter:12', 'file:.novelwarden/outline.md']);
  });

  test('最近開啟的最多列 8 條，前幾章最多 10 章', () => {
    const big = buildCatalog({
      initialized: true,
      chapters: Array.from({ length: 30 }, (_, i) => ({ no: i + 1, title: `章${i + 1}`, volume: '', chapterPath: `chapters/${i + 1}.md`, words: 1 })),
      characters: [],
      lore: [],
      docs: [],
      drafts: [],
    });
    const recent = Array.from({ length: 12 }, (_, i) => `chapters/${30 - i}.md`);
    const { hits } = searchQuickOpen(big, '', { recent });
    assert.equal(hits.filter((h) => h.group === 'recent').length, 8);
    assert.equal(hits.filter((h) => h.group === 'chapters').length, LEAD_CHAPTERS);
  });

  test('pushRecent：新的在前、去重、只留 20 條', () => {
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    const long = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const out = pushRecent(long, 'new');
    assert.equal(out.length, RECENT_KEPT);
    assert.equal(out[0], 'new');
  });
});

describe('quickOpenCore › 上限與效能', () => {
  const many = buildCatalog({
    initialized: true,
    chapters: Array.from({ length: 3000 }, (_, i) => ({
      no: i + 1,
      title: `第${i + 1}回的標題林昭`,
      volume: `第${Math.floor(i / 100) + 1}卷`,
      chapterPath: `chapters/第${Math.floor(i / 100) + 1}卷/${String(i + 1).padStart(4, '0')}.md`,
      plotPath: `.novelwarden/summaries/第${Math.floor(i / 100) + 1}卷/${String(i + 1).padStart(4, '0')}.md`,
      words: 3000,
    })),
    characters: [],
    lore: [],
    docs: [],
    drafts: [],
  });

  test('最多列 50 條，報一共幾條', () => {
    const { hits, total } = searchQuickOpen(many, '林昭');
    assert.equal(hits.length, QUICK_OPEN_LIMIT);
    assert.equal(total, 3000);
  });

  test('上限可以調小；章號命中的那一章仍排第一', () => {
    const { hits } = searchQuickOpen(many, '1', { limit: 5 });
    assert.equal(hits.length, 5);
    assert.equal(hits[0].entry.no, 1);
    assert.deepEqual(hits.slice(1).map((h) => h.entry.no), [10, 11, 12, 13]);
  });

  test('結果按分數從高到低', () => {
    const { hits } = searchQuickOpen(many, '林');
    assert.ok(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score));
  });

  test('三千章、連著打二十個字也不卡（寬鬆的上限，只擋「每打一個字排一遍整本書再排序」那種量級）', () => {
    const started = Date.now();
    for (const q of ['林', '林昭', '第', '第1', '第12', '第123', '123', '标题', '卷', 'smr', '回的', '第五十卷', '0', '9', '99', '999', '一百', '第一百章', 'zz', '昭林']) {
      searchQuickOpen(many, q);
    }
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  });
});

describe('quickOpenCore › 小工具', () => {
  test('matchChars：子串給連著的下標，模糊給按順序的下標', () => {
    const text = Array.from('林昭歸來');
    assert.deepEqual(matchChars(text, Array.from('昭歸')).hits, [1, 2]);
    assert.equal(matchChars(text, Array.from('昭歸')).sub, true);
    const fuzzy = matchChars(text, Array.from('林來'));
    assert.deepEqual(fuzzy.hits, [0, 3]);
    assert.equal(fuzzy.sub, false);
    assert.equal(fuzzy.gaps, 2);
    assert.equal(matchChars(text, Array.from('來林')), undefined);
  });

  test('highlightSegments：連著的高亮併成一截，按碼位切（不劈開代理對）', () => {
    assert.deepEqual(highlightSegments('林昭歸來', [0, 1, 3]), [
      { text: '林昭', hit: true },
      { text: '歸', hit: false },
      { text: '來', hit: true },
    ]);
    assert.deepEqual(highlightSegments('𠀋字', [1]), [
      { text: '𠀋', hit: false },
      { text: '字', hit: true },
    ]);
  });

  test('還不是小說工程的索引：空的，標著 initialized: false', () => {
    const empty = buildCatalog({ initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] });
    assert.equal(empty.initialized, false);
    assert.deepEqual(searchQuickOpen(empty, '').hits, []);
  });

  test('章節的開啟路徑：有正文是正文，沒有正文是細綱', () => {
    const ch12 = catalog.entries.find((e) => e.key === 'chapter:12');
    assert.equal(ch12.path, 'chapters/第一卷/012-夜入青雲.md');
    assert.deepEqual(ch12.paths, ['chapters/第一卷/012-夜入青雲.md', '.novelwarden/summaries/第一卷/012-夜入青雲.md']);
  });

  test('沒有標題的章主名稱是「第 N 章」，但這幾個字不參與名字匹配（章號另認）', () => {
    const c = buildCatalog({
      initialized: true,
      chapters: [{ no: 7, title: '', volume: '', chapterPath: 'chapters/007.md', words: 0 }],
      characters: [], lore: [], docs: [], drafts: [],
    });
    assert.equal(c.entries[0].name, '第 7 章');
    assert.equal(searchQuickOpen(c, '7').hits[0].score, 1000);
    assert.equal(c.entries[0].detail, '第 7 章 · 0 字');
  });
});
