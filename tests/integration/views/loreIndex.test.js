/**
 * 設定名錄（views/lore.ts）：從定稿過的細綱「設定」一節聚合出「哪個東西在哪幾章、有沒有條目、落後幾章」。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只認定稿過的細綱 | 沒定稿的「設定」一節是計劃，混進來會汙染統計（第 14 條同理） |
 * | 標題先於關鍵詞認條目 | 關鍵詞搶不走別人的標題 |
 * | 水位之後的「設定」一節說明與連續性事實才算待整合 | 整合過的不再催；狀態的變化記在連續性事實裡 |
 * | 連續性事實認條目按最長匹配：落在別人更長的名字裡的不算 | 上位概念不再把各個具體東西的事並進自己 |
 * | 人名不是設定 | 模型偶爾把人列進「設定」一節 |
 * | 未建條目按出現章數降序，分類取多數票 | 作者要建的多半是出現得多的 |
 * | 沒有「設定」一節的定稿章計入「還沒記過」 | 老工程上線後要補記的就是這幾章 |
 * | 分類就是目錄，可以巢狀 | 每本書的分類不一樣（作者定案） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let index;

function plot(no, title, { finalized = true, lore, facts = '' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    ...(finalized ? ['sourceHash: h' + no] : []),
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 關鍵事件',
    '',
    '- 有事發生',
    '',
    '## 連續性事實',
    '',
    facts || '（待補充）',
    ...(lore === undefined ? [] : ['', '## 設定', '', lore]),
    '',
  ].join('\n');
}

before(async () => {
  bundle = loadBundle({
    project: './src/core/model/project.ts',
    lore: './src/core/views/lore.ts',
  });
  t = await makeTempProject(bundle.project, { prefix: 'loreindex' });
  t.write(
    '.novelwarden/lore/地域/青崖/青崖镇.md',
    '---\ntitle: 青崖鎮\nkeywords: [青崖]\nbrief: 偏僻小鎮\nupdatedThrough: 2\n---\n\n# 青崖鎮\n\n鎮口設卡。\n'
  );
  t.write('.novelwarden/lore/信物/崖字令牌.md', '---\ntitle: 崖字令牌\nkeywords: [令牌]\n---\n\n# 崖字令牌\n\n木牌。\n');
  t.write('.novelwarden/lore/過所.md', '---\ntitle: 過所\nkeywords: []\n---\n\n# 過所\n\n出入憑證。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n');

  t.write('.novelwarden/summaries/001-雨夜.md', plot(1, '雨夜', { lore: '- 青崖鎮〔地域〕：鎮口查過所\n- 後山〔地域〕' }));
  t.write(
    '.novelwarden/summaries/002-客棧.md',
    plot(2, '客棧', { lore: '- 青崖〔地域〕\n- 停舟客棧〔地域/青崖〕：唯一的客棧\n- 林昭〔人物〕' })
  );
  t.write(
    '.novelwarden/summaries/003-夜访.md',
    plot(3, '夜訪', {
      lore: '- 青崖鎮：七年前大火\n- 令牌〔信物〕\n- 停舟客棧〔地域〕\n- 後山',
      facts: '- 林昭的令牌被年輕守衛看見 〔證據：「牌子」〕\n- 青崖鎮的城門被燒燬',
    })
  );
  // 第 4 章定稿過、但還沒有「設定」一節；第 5 章是計劃，「設定」一節不算。
  t.write('.novelwarden/summaries/004-空匣.md', plot(4, '空匣'));
  t.write('.novelwarden/summaries/005-計劃.md', plot(5, '计划', { finalized: false, lore: '- 後山〔地域〕\n- 黑市〔地域〕' }));

  index = await bundle.lore.buildLoreIndex(t.project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('已建條目', () => {
  const record = (title) => index.known.find((r) => r.entry.title === title);

  test('每條都在，分類就是目錄（可以巢狀），根目錄下是未分類', () => {
    assert.deepEqual(
      index.known.map((r) => [r.entry.title, r.entry.category]).sort(),
      [
        ['崖字令牌', '信物'],
        ['過所', ''],
        ['青崖鎮', '地域/青崖'],
      ].sort()
    );
  });

  test('出現章：只認定稿過的「設定」一節，標題與關鍵詞都認', () => {
    assert.deepEqual(record('青崖鎮').chapters, [1, 2, 3]);
    assert.deepEqual(record('崖字令牌').chapters, [3]);
    assert.deepEqual(record('過所').chapters, []);
  });

  test('待整合：水位之後的「設定」一節說明與提到它的連續性事實', () => {
    assert.deepEqual(record('青崖鎮').pending, [
      { no: 3, text: '七年前大火', source: 'lore' },
      { no: 3, text: '青崖鎮的城門被燒燬', source: 'fact' },
    ]);
    assert.equal(bundle.lore.pendingChapters(record('青崖鎮')), 1);
    // 沒整合過（沒有水位）的條目，從第 1 章算起。
    assert.deepEqual(record('崖字令牌').pending, [{ no: 3, text: '林昭的令牌被年輕守衛看見', source: 'fact' }]);
  });
});

// 2026-10-25 外部報告：「秘境」那一條整合成了各個秘境的彙總——帶這兩個字的連續性事實從前都掛到它名下。
describe('待整合 · 最長匹配', () => {
  let p;
  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'loreindexLongest' });
    p.write('.novelwarden/lore/概念/秘境.md', '---\ntitle: 秘境\nkeywords: []\n---\n\n# 秘境\n\n各處秘境。\n');
    p.write('.novelwarden/lore/秘境/心枝.md', '---\ntitle: 心枝\nkeywords: [心枝秘境]\nupdatedThrough: 1\n---\n\n# 心枝\n\n時間流速不同。\n');
    p.write(
      '.novelwarden/summaries/001-入池.md',
      plot(1, '入池', { lore: '- 幻池秘境〔秘境〕：水下不能開口', facts: '- 幻池秘境裡水下不能開口\n- 心枝秘境與外界時間流速 22:90' })
    );
    p.write('.novelwarden/summaries/002-湖底.md', plot(2, '湖底', { lore: '- 秘境', facts: '- 秘境的入口都在湖底\n- 心枝秘境的時間又變快了' }));
  });
  after(() => {
    if (p) cleanup(p.dir);
  });

  test('落在別的條目、名錄裡另記著的名字裡的不算；水位之內的條目照樣算別人的名字，只是不收', async () => {
    const idx = await bundle.lore.buildLoreIndex(p.project);
    const pending = (title) => idx.known.find((r) => r.entry.title === title).pending.map((f) => `${f.no}:${f.text}`);
    // 「幻池秘境」還沒建條目（名錄裡記著），「心枝秘境」是「心枝」的關鍵詞——這兩句都不歸「秘境」。
    assert.deepEqual(pending('秘境'), ['2:秘境的入口都在湖底']);
    assert.deepEqual(pending('心枝'), ['2:心枝秘境的時間又變快了']);
  });
});

describe('未建條目', () => {
  test('定稿裡出現、沒有條目的名字；人名不算；計劃裡的不算', () => {
    // 兩個都出現了 2 章，同樣多的按第一次出現的章號：後山第 1 章、停舟客棧第 2 章。
    assert.deepEqual(
      index.unknown.map((u) => u.name),
      ['後山', '停舟客棧']
    );
  });

  test('按出現章數降序，分類取多數票，說明按章收著', () => {
    const inn = index.unknown.find((u) => u.name === '停舟客棧');
    assert.deepEqual(inn.chapters, [2, 3]);
    assert.ok(['地域/青崖', '地域'].includes(inn.category));
    assert.deepEqual(inn.notes, [{ no: 2, text: '唯一的客棧', source: 'lore' }]);
    const hill = index.unknown.find((u) => u.name === '後山');
    assert.deepEqual(hill.chapters, [1, 3]);
    assert.equal(hill.category, '地域');
  });
});

describe('還沒記過設定的定稿章', () => {
  test('定稿過、沒有「設定」一節的章', () => {
    assert.deepEqual(index.unrecorded, [4]);
    assert.equal(index.finalizedCount, 4);
  });
});

describe('describeSpan', () => {
  test('首尾與章數', () => {
    assert.equal(bundle.lore.describeSpan([]), '');
    assert.equal(bundle.lore.describeSpan([7]), '第 7 章');
    assert.equal(bundle.lore.describeSpan([3, 9, 57]), '第 3–57 章 · 3 章');
  });
});
