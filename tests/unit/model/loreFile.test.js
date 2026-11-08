/**
 * 設定的格式（model/loreFile.ts）與細綱「設定」一節（model/plotFile.ts）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 幾種手寫寫法都認、認不出的不崩、同名只留第一行 | 第 1 條：作者會手改 |
 * | 「（無）」讀回來是空陣列，渲染回去還是「（無）」 | 標題在 = 記過；沒有設定也要留下記過的痕跡 |
 * | 分類路徑規範成 `a/b`，「未分類」是空串 | 分類就是目錄，每本書自己定、可以巢狀 |
 * | 「設定」一節不進內容指紋 | 補記老章節不能把它們全掛上 ⟳ |
 * | 沒有這一節是 undefined，有標題沒內容是空陣列 | 「還沒記過」與「記過、沒有」是兩回事 |
 * | 兩趟認條目：關鍵詞搶不走別人的標題 | 同 views/cast.ts 的角色卡 |
 * | 認提到：最長匹配，落在別人更長的名字裡的不算 | 「聖地秘境」不該把上位概念「秘境」整條帶進來 |
 * | 「暗設」一節拆得出來，一句話不取它 | 寫正文時不帶暗設（完善設定） |
 * | 待完善只認空的、佔位、全是「（未交代）」 | 不按字數猜：作者寫了兩行就是夠了 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const lf = loadModule('src/core/model/loreFile.ts');
const pf = loadModule('src/core/model/plotFile.ts');

describe('「設定」一節的一行一條', () => {
  test('〔〕【】[] 都認，冒號全形半形都認，沒寫分類也行', () => {
    const lines = lf.parseLoreLines(
      [
        '- 青崖鎮〔地域/青崖〕',
        '- 停舟客棧【地域/青崖】：鎮上唯一的客棧',
        '* 崖字令牌[信物]: 不止一塊',
        '1. 過所：出入城鎮的憑證',
        '後山',
      ].join('\n')
    );
    assert.deepEqual(lines, [
      { name: '青崖鎮', category: '地域/青崖', note: '' },
      { name: '停舟客棧', category: '地域/青崖', note: '鎮上唯一的客棧' },
      { name: '崖字令牌', category: '信物', note: '不止一塊' },
      { name: '過所', category: '', note: '出入城鎮的憑證' },
      { name: '後山', category: '', note: '' },
    ]);
  });

  test('同一個名字（歸一後）只留第一行；空行、佔位、（無）跳過', () => {
    const lines = lf.parseLoreLines(['- 青崖鎮〔地域〕：甲', '', '（待補充）', '（無）', '- 「青崖鎮」：乙'].join('\n'));
    assert.deepEqual(lines, [{ name: '青崖鎮', category: '地域', note: '甲' }]);
  });

  test('超長的名字、分類、說明按上限截短', () => {
    const [line] = lf.parseLoreLines(`- ${'名'.repeat(50)}〔${'類'.repeat(60)}〕：${'說'.repeat(100)}`);
    assert.equal(line.name.length, lf.LORE_LINE_LIMITS.name);
    assert.equal(line.category.length, lf.LORE_LINE_LIMITS.category);
    assert.equal(line.note.length, lf.LORE_LINE_LIMITS.note);
  });

  test('渲染：沒有就寫「（無）」，讀回來是空陣列；有就一行一條往返不變', () => {
    assert.equal(lf.renderLoreLines([]), '（無）');
    assert.deepEqual(lf.parseLoreLines(lf.renderLoreLines([])), []);
    const lines = [
      { name: '青崖鎮', category: '地域/青崖', note: '' },
      { name: '過所', category: '', note: '出入城鎮的憑證' },
    ];
    assert.equal(lf.renderLoreLines(lines), '- 青崖鎮〔地域/青崖〕\n- 過所：出入城鎮的憑證');
    assert.deepEqual(lf.parseLoreLines(lf.renderLoreLines(lines)), lines);
  });

  test('分類路徑：反斜槓、全形斜槓當 /，空段丟掉，「未分類」是空串', () => {
    assert.equal(lf.normalizeLoreCategory(' 宗門 \\ 正道／ '), '宗門/正道');
    assert.equal(lf.normalizeLoreCategory('未分类'), '');
    assert.equal(lf.loreCategoryOfSlug('宗門/正道/青雲宗'), '宗門/正道');
    assert.equal(lf.loreCategoryOfSlug('青雲宗'), '');
  });
});

describe('條目的一句話與認名字（含暗設與待完善：完善設定，2026-10-19）', () => {
  test('有 brief 用 brief；沒有取正文第一句，跳過小標題與列表記號，截到 40 字', () => {
    assert.equal(lf.loreBrief({ brief: '一句话', body: '別的' }), '一句话');
    assert.equal(lf.loreBrief({ brief: '', body: '## 概要\n\n- 偏僻小鎮，前不著村。鎮口設卡。' }), '偏僻小鎮，前不著村。');
    assert.equal(lf.loreBrief({ brief: '', body: '字'.repeat(80) }).length, lf.LORE_ENTRY_LIMITS.brief);
    assert.equal(lf.loreBrief({ brief: '', body: '' }), '');
  });

  test('缺 brief 取第一句時跳過「暗設」：一句話會進寫正文的上下文', () => {
    assert.equal(lf.loreBrief({ brief: '', body: '## 暗設\n\n閣主是魔尊轉世。\n\n## 概要\n\n九層木樓。' }), '九層木樓。');
  });

  test('暗設：以「暗設」開頭的二級標題到下一個一二級標題為止，幾節都收', () => {
    const body = [
      '## 概要',
      '',
      '九層木樓。',
      '',
      '## 暗設（未揭示）',
      '',
      '閣主是魔尊轉世。',
      '### 細節',
      '三層以上無人上去過。',
      '',
      '## 現狀',
      '',
      '閉閣。',
      '',
      '## 暗設',
      '密道通往後山。',
    ].join('\n');
    const { visible, hidden } = lf.splitLoreHidden(body);
    assert.equal(visible, '## 概要\n\n九層木樓。\n\n## 現狀\n\n閉閣。');
    assert.equal(hidden, '閣主是魔尊轉世。\n### 細節\n三層以上無人上去過。\n\n密道通往後山。');
  });

  test('沒有暗設原樣返回；別的標題、三級標題「### 暗設」不認（當明面）；空的、undefined 不崩', () => {
    assert.deepEqual(lf.splitLoreHidden('## 概要\n\n九層木樓。'), { visible: '## 概要\n\n九層木樓。', hidden: '' });
    assert.equal(lf.splitLoreHidden('### 暗設\n秘密').hidden, '');
    assert.equal(lf.splitLoreHidden('## 秘密\n秘密').hidden, '');
    assert.deepEqual(lf.splitLoreHidden(''), { visible: '', hidden: '' });
    assert.deepEqual(lf.splitLoreHidden(undefined), { visible: '', hidden: '' });
  });

  test('待完善：空的、新建設定的佔位、三節全是「（未交代）」；寫了一點就不算', () => {
    assert.equal(lf.loreThin({ body: '' }), 'empty');
    assert.equal(lf.loreThin({ body: '## 暗設\n\n閣主是魔尊轉世。' }), 'empty');
    assert.equal(lf.loreThin({ body: '## 概要\n\n## 現狀\n' }), 'empty');
    assert.equal(lf.loreThin({ body: `${lf.LORE_PLACEHOLDER_PREFIX}：它是什麼……）` }), 'placeholder');
    assert.equal(
      lf.loreThin({ body: '## 概要\n\n（未交代）\n\n## 規則與邊界\n\n- (未交代)\n\n## 現狀\n\n（未交代）' }),
      'untold'
    );
    assert.equal(lf.loreThin({ body: '## 概要\n\n九層木樓。\n\n## 現狀\n\n（未交代）' }), undefined);
    assert.equal(lf.loreThin({ body: '兩行字，作者覺得夠了。' }), undefined);
  });

  test('先標題後關鍵詞：關鍵詞搶不走別人的標題', () => {
    const a = { slug: 'a', title: '青崖鎮', keywords: ['青崖', '停舟'] };
    const b = { slug: 'b', title: '停舟', keywords: [] };
    const lookup = lf.createLoreLookup([a, b]);
    assert.equal(lookup.find('停舟'), b);
    assert.equal(lookup.find('「青崖」'), a);
    assert.equal(lookup.find('後山'), undefined);
  });

  test('提到沒有：標題或兩個字以上的關鍵詞作為子串出現', () => {
    const entry = { title: '崖字令牌', keywords: ['令牌', '牌'] };
    assert.equal(lf.loreMentionIn('林昭把令牌交了出去', entry), '令牌');
    assert.equal(lf.loreMentionIn('門牌上寫著字', entry), undefined);
  });

  // 2026-10-25 外部報告：寫到第 83 章，「聖地秘境」一出現「秘境」那一條（各個秘境的彙總）就整條進上下文。
  test('最長匹配：每一處都落在別人更長的名字裡的不算；單獨出現的照算', () => {
    const concept = { title: '秘境', keywords: [] };
    const holy = { title: '聖地秘境', keywords: ['聖地'] };
    const magic = { title: '魔法', keywords: ['法術'] };
    const all = [concept, holy, magic];
    const hits = (text, names) => [...lf.loreMentionsIn(text, all, names)].map(([e, w]) => `${e.title}:${w}`);
    assert.deepEqual(hits('主角隨教眾潛入聖地秘境'), ['聖地秘境:聖地秘境']);
    assert.deepEqual(hits('聖地秘境和別的秘境不一樣'), ['秘境:秘境', '聖地秘境:聖地秘境']);
    assert.deepEqual(hits('她在練習魔法'), ['魔法:魔法']);
    // 名錄裡記著、還沒建條目的名字也算別人的名字。
    assert.deepEqual(hits('幻池秘境裡不能開口', []), ['秘境:秘境']);
    assert.deepEqual(hits('幻池秘境裡不能開口', ['幻池秘境']), []);
    // 一樣長的不算包住；自己更長的關鍵詞包住自己的標題照算自己。
    assert.deepEqual(hits('秘境', ['秘境']), ['秘境:秘境']);
    const gate = { title: '秘境', keywords: ['秘境入口'] };
    assert.deepEqual([...lf.loreMentionsIn('走到秘境入口', [gate]).values()], ['秘境']);
    // 一個字的不認，空文字什麼都沒有。
    assert.equal(lf.loreMentionsIn('', all).size, 0);
    assert.equal(lf.loreMentionsIn('牌', [{ title: '牌', keywords: [] }]).size, 0);
  });

  // 真跑（2026-10-18，gemini-3-flash-lite）：「偽人」的關鍵詞裡有人名「沈懷山」，「青羊鎮」與「沈家老宅」
  // 互相寫進對方的關鍵詞——寫正文時一提到這個人、這個地方，就把不相干的條目整條帶進來。
  test('機器寫的關鍵詞：人名、別的條目的標題、一個字的、與標題重複的都不要', () => {
    assert.deepEqual(
      lf.cleanLoreKeywords('偽人', ['偽人', '沈懷山', '皮囊怪物', '鬼', '青羊鎮', ' 皮囊怪物 '], {
        titles: ['青羊鎮', '偽人'],
        people: ['沈默', '沈懷山'],
      }),
      ['皮囊怪物']
    );
  });

  test('名錄裡另記著的名字也不要：「魔法體系」不能把「寒冰鎖」收成關鍵詞', () => {
    // 收了的話，往後各章記下的「寒冰鎖」都被認成「魔法體系」，它永遠建不出自己的條目。
    assert.deepEqual(
      lf.cleanLoreKeywords('魔法體系', ['魔法', '寒冰鎖', '奧術飛彈', '施法'], {
        titles: [],
        people: [],
        recorded: ['寒冰鎖', '奧術飛彈', '魔法體系'],
      }),
      ['魔法', '施法']
    );
  });
});

describe('細綱的「設定」一節', () => {
  const FILE = [
    '---',
    'no: 3',
    'title: 夜訪',
    'sourceHash: abc',
    '---',
    '',
    '# 第3章 夜訪',
    '',
    '## 關鍵事件',
    '',
    '- 年輕守衛潛入',
    '',
    '## 連續性事實',
    '',
    '- 林昭的令牌被看見了',
    '',
    '## 設定',
    '',
    '- 停舟客棧〔地域〕：二層木樓',
    '- 崖字令牌〔信物〕',
    '',
  ].join('\n');

  test('讀出「設定」一節，連續性事實不被它吃進去', () => {
    const plot = pf.parsePlotFile(FILE, '.novelwarden/summaries/003-夜訪.md');
    assert.deepEqual(plot.lore, [
      { name: '停舟客棧', category: '地域', note: '二層木樓' },
      { name: '崖字令牌', category: '信物', note: '' },
    ]);
    assert.equal(plot.sections.连续性事实, '- 林昭的令牌被看見了');
  });

  test('沒有這一節是 undefined；有標題、寫著（無）是空陣列', () => {
    const none = pf.parsePlotFile(FILE.replace(/## 設定[\s\S]*$/, ''), '.novelwarden/summaries/003-夜訪.md');
    assert.equal(none.lore, undefined);
    const empty = pf.parsePlotFile(FILE.replace(/## 設定[\s\S]*$/, '## 設定\n\n（無）\n'), '.novelwarden/summaries/003-夜訪.md');
    assert.deepEqual(empty.lore, []);
  });

  test('「設定」一節不進內容指紋', () => {
    const with_ = pf.parsePlotFile(FILE, '.novelwarden/summaries/003-夜訪.md');
    const without = pf.parsePlotFile(FILE.replace(/## 設定[\s\S]*$/, ''), '.novelwarden/summaries/003-夜訪.md');
    assert.equal(pf.plotContentHash(with_), pf.plotContentHash(without));
  });

  test('渲染：給了才寫，寫在七節之後；讀回來一樣', () => {
    const plot = pf.parsePlotFile(FILE, '.novelwarden/summaries/003-夜訪.md');
    const text = pf.renderPlotFile({ ...plot, sourceHash: 'abc', done: false });
    assert.ok(text.indexOf('## 設定') > text.indexOf('## 連續性事實'));
    assert.deepEqual(pf.parsePlotFile(text, plot.relPath).lore, plot.lore);
    const bare = pf.renderPlotFile({ ...plot, lore: undefined, done: false });
    assert.ok(!bare.includes('## 設定'));
    const empty = pf.renderPlotFile({ ...plot, lore: [], done: false });
    assert.ok(empty.includes('## 設定\n\n（無）'));
  });
});

describe('模型給的「設定」', () => {
  test('物件、字串、整段多行都認；同名只留一條', () => {
    assert.deepEqual(
      lf.loreLinesFromJson([
        { name: '青崖鎮', category: '地域', fact: '鎮口設卡' },
        { title: '過所', note: '出入憑證' },
        '崖字令牌〔信物〕：不止一塊',
        { name: '「青崖鎮」', fact: '重複的' },
        { category: '沒有名字' },
        42,
      ]),
      [
        { name: '青崖鎮', category: '地域', note: '鎮口設卡' },
        { name: '過所', category: '', note: '出入憑證' },
        { name: '崖字令牌', category: '信物', note: '不止一塊' },
      ]
    );
    assert.deepEqual(lf.loreLinesFromJson('- 後山〔地域〕\n- 黑市'), [
      { name: '後山', category: '地域', note: '' },
      { name: '黑市', category: '', note: '' },
    ]);
    assert.deepEqual(lf.loreLinesFromJson(undefined), []);
  });

  const TEXT = '林昭進了青崖鎮。鎮口的守衛查驗過所，見了令牌就放行。停舟客棧是鎮上唯一的客棧。';
  const entries = [
    { slug: '地域/青崖鎮', title: '青崖鎮', keywords: ['青崖'], category: '地域' },
    { slug: '信物/崖字令牌', title: '崖字令牌', keywords: ['令牌'], category: '信物' },
  ];

  test('名字要逐字出現在正文裡；人名不算；已有條目換成標題與實際目錄', () => {
    const r = lf.verifyLoreLines(
      [
        { name: '青崖', category: '地點', note: '' },
        { name: '令牌', category: '物品', note: '' },
        { name: '黑市', category: '地點', note: '' },
        { name: '林昭', category: '人物', note: '' },
        { name: '停舟客棧', category: '地域/青崖', note: '' },
      ],
      TEXT,
      { entries, people: ['林昭'] }
    );
    assert.deepEqual(r.lines, [
      { name: '青崖鎮', category: '地域', note: '' },
      { name: '崖字令牌', category: '信物', note: '' },
      { name: '停舟客棧', category: '地域/青崖', note: '' },
    ]);
    assert.deepEqual(
      r.dropped.map((d) => [d.name, d.why]),
      [
        ['黑市', '正文裡沒有這個名字'],
        ['林昭', '是角色卡上的人'],
      ]
    );
  });

  test('說明要在正文裡找得到依據，找不到清空說明、留下名字', () => {
    const r = lf.verifyLoreLines(
      [
        { name: '停舟客棧', category: '', note: '鎮上唯一的客棧' },
        { name: '青崖鎮', category: '', note: '建在海底的城市' },
      ],
      TEXT,
      { entries, people: [] }
    );
    assert.deepEqual(r.lines, [
      { name: '停舟客棧', category: '', note: '鎮上唯一的客棧' },
      { name: '青崖鎮', category: '地域', note: '' },
    ]);
    assert.equal(r.cleared.length, 1);
    assert.ok(r.cleared[0].why.includes('建在海底的城市'));
  });

  test('最多 12 行', () => {
    const names = Array.from({ length: 15 }, (_, i) => `地名${String.fromCharCode(0x4e00 + i)}`);
    const r = lf.verifyLoreLines(
      names.map((name) => ({ name, category: '', note: '' })),
      names.join('，'),
      { entries: [], people: [] }
    );
    assert.equal(r.lines.length, lf.LORE_LINE_LIMITS.lines);
    assert.equal(r.dropped.length, 3);
  });
});
