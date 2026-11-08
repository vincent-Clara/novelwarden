/**
 * `lore` 層（設定名錄，2026-10-18）：幾百條設定的書，先排序、再分兩種形態裝、按上下文詳細度封頂。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 本章細綱「設定」一節點名的整條帶，關鍵詞命中的也整條帶 | 寫這一章最用得上的就是這幾條 |
 * | 關鍵詞命中按最長匹配：「聖地秘境」裡的「秘境」不算 | 上位概念不擠掉具體那幾條的整條名額 |
 * | 前幾章定稿出現過的只帶一句話 | 夠提醒有這個東西，不擠預算 |
 * | 整條後面跟水位之後的新事實（只到本章之前） | 條目落後於正文時模型照樣拿得到新的那幾句 |
 * | 條目整合到本章或更晚時 note 提醒可能劇透 | 回頭重寫前面的章時，條目裡有之後的事 |
 * | 整條超了上限降成一句話、一句話超了上限丟，都寫原因 | 第 2 條：不靜默截斷 |
 * | 排細綱時其餘條目列一覽（近幾章出現過的在前），超了的併成一條 | 規劃時照抄已有的名字；寫到後面開篇的高頻詞不霸屏；幾百條不逐條刷明細 |
 * | 續寫那幾輪也帶（只帶點名與命中的） | 從前續寫一條設定都不帶 |
 * | 取消勾選的不佔名額 | 作者排除一條，後面的補上來 |
 * | 整條的空行隔開，一句話的併成一張清單 | 訊息裡好讀 |
 * | 架構層只有設定清單（分類表 + 已有條目一覽，空目錄也算）與世界觀（點名的）帶設定 | 清單要照用目錄、照抄名字；配置、前提、角色圖譜在設定之前 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const PLAN = { stage: 'plot', capability: 'generate' };

const config = (contextDetail = 3) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail,
});

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

function plotText(no, { finalized = true, events = '- 林昭往前走。', lore, facts } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(finalized ? [`sourceHash: h${no}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 關鍵事件',
    '',
    events,
    '',
    '## 連續性事實',
    '',
    facts ?? '（待補充）',
    ...(lore === undefined ? [] : ['', '## 設定', '', lore]),
    '',
  ].join('\n');
}

function entry(title, { keywords = [], brief = '', body = '', updatedThrough } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(updatedThrough !== undefined ? [`updatedThrough: ${updatedThrough}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

let bundle;
let t;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  t = await makeTempProject(bundle.project, { prefix: 'loreLayer', title: '設定測試' });
  for (let no = 1; no <= 4; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  t.write(
    '.novelwarden/lore/地域/青崖镇.md',
    entry('青崖鎮', { keywords: ['青崖'], brief: '偏僻小鎮', body: '鎮口設卡。', updatedThrough: 1 })
  );
  t.write('.novelwarden/lore/信物/崖字令牌.md', entry('崖字令牌', { keywords: ['令牌'], body: '木牌，殘缺的崖字。' }));
  t.write('.novelwarden/lore/宗門/正道/青雲宗.md', entry('青雲宗', { brief: '正道第一宗', body: '劍修。' }));
  t.write('.novelwarden/lore/地域/後山.md', entry('後山', { brief: '後山禁地', body: '有陣法。' }));
  t.write('.novelwarden/lore/過所.md', entry('過所', { brief: '出入憑證', body: '鎮口查驗。' }));

  t.write(PLOT(1), plotText(1, { lore: '- 青崖鎮〔地域〕：鎮口查過所\n- 後山〔地域〕' }));
  t.write(
    PLOT(2),
    plotText(2, { lore: '- 青崖鎮：七年前大火\n- 青雲宗〔宗門/正道〕', facts: '- 青崖鎮的城門被燒燬' })
  );
  t.write(PLOT(3), plotText(3, { lore: '- 後山' }));
  t.write(PLOT(4), plotText(4, { finalized: false, events: '- 林昭回到青崖，摸了摸懷裡。', lore: '- 崖字令牌〔信物〕：不止一塊' }));
  t.project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

function build(no, extra = {}, detail = 3) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(no) }, ask: '', targetWords: 1200, ...extra },
    config(detail)
  );
}

const loreItems = (b) => b.items.filter((i) => i.kind === 'lore');
const byLabel = (b, title) => loreItems(b).find((i) => i.label === `設定 · ${title}`);
const userOf = (b) => b.messages[b.messages.length - 1].content;

describe('寫第 4 章正文', () => {
  let b;
  before(async () => {
    b = await build(4);
  });

  test('本章細綱點名的、關鍵詞命中的整條帶；前兩章定稿出現過的只帶一句話；無關的不帶', () => {
    assert.deepEqual(
      loreItems(b).map((i) => [i.label, i.status]),
      [
        ['設定 · 崖字令牌', 'included'],
        ['設定 · 青崖鎮', 'included'],
        ['設定 · 後山', 'included'],
        ['設定 · 青雲宗', 'included'],
      ]
    );
    assert.equal(byLabel(b, '崖字令牌').note, '本章細綱的設定裡有「崖字令牌」');
    assert.equal(byLabel(b, '青崖鎮').note, '上下文中出現「青崖」');
    assert.equal(byLabel(b, '後山').note, '第 3 章出現過');
    assert.equal(byLabel(b, '青雲宗').note, '第 2 章出現過');
  });

  test('整條：一句話、分類、正文，後面跟水位之後、本章之前的新事實', () => {
    assert.equal(
      byLabel(b, '青崖鎮').text,
      [
        '【青崖鎮〔地域〕】偏僻小鎮',
        '鎮口設卡。',
        '第 1 章之後新出現的（還沒整合進這一條）：',
        '- 第 2 章：七年前大火',
        '- 第 2 章：青崖鎮的城門被燒燬',
      ].join('\n')
    );
    // 沒寫 brief 的不在標題行上重複正文第一句。
    assert.equal(byLabel(b, '崖字令牌').text, '【崖字令牌〔信物〕】\n木牌，殘缺的崖字。');
  });

  test('一句話：名〔分類〕：一句話', () => {
    assert.equal(byLabel(b, '青雲宗').text, '- 青雲宗〔宗門/正道〕：正道第一宗');
  });

  test('本章細綱帶著「設定」一節（計劃引入什麼），別的細綱不帶', () => {
    const self = b.items.find((i) => i.id === `plot:${PLOT(4)}`);
    assert.ok(self.text.endsWith('## 設定\n\n- 崖字令牌〔信物〕：不止一塊'), self.text);
    const others = b.items.filter((i) => i.kind === 'plotSummary' && i.text);
    assert.ok(others.every((i) => !i.text.includes('## 設定')), others.map((i) => i.text).join('\n---\n'));
  });

  test('訊息裡一節：整條的空行隔開，一句話的併成一張清單跟在後面', () => {
    const user = userOf(b);
    const at = user.indexOf('# 相關世界觀設定');
    assert.ok(at > 0, user.slice(0, 1500));
    const section = user.slice(at, user.indexOf('\n---\n', at) > 0 ? user.indexOf('\n---\n', at) : undefined);
    assert.ok(section.includes('【崖字令牌〔信物〕】\n木牌，殘缺的崖字。\n\n【青崖鎮〔地域〕】'), section);
    assert.ok(
      section.includes(
        '其餘相關設定（只列一句話；提到它們時沿用這些名字）：\n- 後山〔地域〕：後山禁地\n- 青雲宗〔宗門/正道〕：正道第一宗'
      ),
      section
    );
  });
});

describe('回頭重寫第 1 章', () => {
  test('條目整合到本章或更晚：note 提醒可能含之後的事；尾巴只到本章之前', async () => {
    const b = await build(1);
    const qing = byLabel(b, '青崖鎮');
    assert.equal(qing.status, 'included');
    assert.ok(qing.note.includes('條目整合到第 1 章，可能含第 1 章之後才發生的事'), qing.note);
    assert.ok(!qing.text.includes('第 2 章'), qing.text);
  });
});

describe('上限', () => {
  // 命中的先後：本章細綱點名的 → 作者這次說的 → 本章細綱裡提到的。整條名額先給最確定要用的。
  test('精簡：整條只帶 2 條，其餘降成一句話並寫原因', async () => {
    const b = await build(4, { ask: '青雲宗、後山與過所' }, 1);
    const full = loreItems(b).filter((i) => i.status === 'included' && i.text.startsWith('【'));
    assert.deepEqual(
      full.map((i) => i.label),
      ['設定 · 崖字令牌', '設定 · 後山']
    );
    const degraded = loreItems(b).filter((i) => i.status === 'degraded');
    assert.deepEqual(
      degraded.map((i) => i.label),
      ['設定 · 青雲宗', '設定 · 過所', '設定 · 青崖鎮']
    );
    assert.ok(degraded.every((i) => i.text.startsWith('- ')));
    assert.ok(degraded[0].note.includes('整條的已帶滿 2 條（上下文詳細度「精簡」），只帶一句話'), degraded[0].note);
  });

  test('取消勾選的不佔名額', async () => {
    const b = await build(4, { ask: '青雲宗、後山與過所', excludedIds: ['lore:信物/崖字令牌'] }, 1);
    assert.equal(byLabel(b, '崖字令牌').status, 'excluded');
    const full = loreItems(b).filter((i) => i.status === 'included' && i.text.startsWith('【'));
    assert.deepEqual(
      full.map((i) => i.label),
      ['設定 · 後山', '設定 · 青雲宗']
    );
  });
});

describe('排細綱', () => {
  before(() => {
    for (let i = 1; i <= 12; i++) {
      t.write(`.novelwarden/lore/雜項/物件${i}.md`, entry(`物件${i}`, { brief: `第${i}件` }));
    }
    t.project.invalidate();
  });
  after(() => {
    t.remove('.novelwarden/lore/雜項');
    t.project.invalidate();
  });

  test('其餘條目按出現章數列一覽；超了上限的併成一條寫明', async () => {
    const b = await bundle.builder.buildContext(
      t.project,
      { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(5) }, ask: '' },
      config(1)
    );
    const items = loreItems(b);
    // 規劃時先給分類表：分類就是目錄、每本書自己的，新設定要從這裡挑。
    const categories = items.find((i) => i.id === 'lore:categories');
    // 目錄按拼音排（listFolders 的 zh-Hans-CN 排序）。
    assert.equal(categories.text, '本書的設定分類：地域、信物、雜項、宗門、宗門/正道（新設定的 category 從這裡挑）。');
    // 精簡：一句話最多 10 條。前兩章（第 3、4 章只有第 3 章定稿）出現過的先佔，
    // 其餘近 10 章出現過的在前、按這幾章裡出現的章數降序：青崖鎮 2 章、後山已帶、青雲宗 1 章……
    const lines = items.filter((i) => i.status === 'included' && i.id !== 'lore:categories');
    assert.equal(lines.length, 10, items.map((i) => `${i.label}:${i.status}`).join(' '));
    assert.equal(lines[0].label, '設定 · 後山');
    assert.equal(lines[1].label, '設定 · 青崖鎮');
    assert.equal(lines[1].note, '已有設定（近 10 章出現 2 章，最近第 2 章）');
    const rest = items.find((i) => i.id === 'lore:catalog');
    assert.equal(rest.status, 'dropped');
    assert.equal(rest.label, '設定 · 其餘 7 條');
    assert.ok(rest.note.includes('一句話的已帶滿 10 條'), rest.note);
  });
});

// 2026-10-25 外部報告：寫到第 83 章排細綱，一覽前幾十條全是開篇幾十章裡的高頻詞——從前一律按全書出現章數排。
describe('排細綱 · 寫到後面', () => {
  let late;
  before(async () => {
    late = await makeTempProject(bundle.project, { prefix: 'loreLayerLate', title: '後面' });
    const seen = { 湖泊: [1, 2, 3, 4, 5, 6, 7, 8], 街市: [1, 2, 3, 4, 5], 聖地: [22, 25], 戒律: [26], 暗號: [28] };
    for (const name of Object.keys(seen)) {
      late.write(`.novelwarden/lore/${name}.md`, entry(name, { brief: name }));
    }
    for (const no of [...new Set(Object.values(seen).flat())]) {
      const names = Object.keys(seen).filter((name) => seen[name].includes(no));
      late.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n正文。\n`);
      late.write(PLOT(no), plotText(no, { lore: names.map((n) => `- ${n}`).join('\n') }));
    }
    late.project.invalidate();
  });
  after(() => {
    if (late) cleanup(late.dir);
  });

  const plan = (detail) =>
    bundle.builder.buildContext(late.project, { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(30) }, ask: '' }, config(detail));

  test('近幾章（與角色圖譜同一個數）出現過的在前，按這幾章裡出現的章數；更早的在後，按全書出現章數', async () => {
    const lines = loreItems(await plan(1)).filter((i) => i.id !== 'lore:categories');
    assert.deepEqual(
      lines.map((i) => [i.label, i.note]),
      [
        ['設定 · 暗號', '第 28 章出現過'],
        ['設定 · 聖地', '已有設定（近 10 章出現 2 章，最近第 25 章）'],
        ['設定 · 戒律', '已有設定（近 10 章出現 1 章，最近第 26 章）'],
        ['設定 · 湖泊', '已有設定（出現 8 章，近 10 章沒出現）'],
        ['設定 · 街市', '已有設定（出現 5 章，近 10 章沒出現）'],
      ]
    );
  });

  test('「完整」那一級不限近幾章：照舊按全書出現章數', async () => {
    const lines = loreItems(await plan(4)).filter((i) => i.note?.startsWith('已有設定'));
    assert.deepEqual(
      lines.map((i) => [i.label, i.note]),
      [
        ['設定 · 湖泊', '已有設定（出現 8 章）'],
        ['設定 · 街市', '已有設定（出現 5 章）'],
      ]
    );
  });
});

// 2026-10-25 外部報告：「聖地秘境」一出現，彙總了各個秘境規則的「秘境」那一條就整條帶進來，擠掉具體那幾條。
describe('關鍵詞命中 · 最長匹配', () => {
  let p;
  before(async () => {
    p = await makeTempProject(bundle.project, { prefix: 'loreLayerLongest', title: '最長匹配' });
    p.write('.novelwarden/lore/概念/秘境.md', entry('秘境', { brief: '各處秘境的統稱', body: '幻池：水下不能開口。心枝：時間流速 22:90。' }));
    p.write('.novelwarden/lore/秘境/聖地秘境.md', entry('聖地秘境', { brief: '教派的據點', body: '外人進不去。' }));
    p.project.invalidate();
  });
  after(() => {
    if (p) cleanup(p.dir);
  });

  const ask = (text) =>
    bundle.builder.buildContext(p.project, { action: PLAN, target: { kind: 'plot', plotRelPath: PLOT(1) }, ask: text }, config(3));
  const full = (b) => loreItems(b).filter((i) => i.text.startsWith('【')).map((i) => [i.label, i.note]);

  test('「聖地秘境」裡的「秘境」不算提到上位概念；單獨說「秘境」照樣整條帶', async () => {
    assert.deepEqual(full(await ask('這一章主角隨教眾潛入聖地秘境')), [['設定 · 聖地秘境', '上下文中出現「聖地秘境」']]);
    assert.deepEqual(full(await ask('聖地秘境也守秘境的規矩')), [
      ['設定 · 秘境', '上下文中出現「秘境」'],
      ['設定 · 聖地秘境', '上下文中出現「聖地秘境」'],
    ]);
  });
});

describe('續寫那幾輪', () => {
  test('只帶點名的與命中的（含已寫的末尾），前幾章的不帶', async () => {
    const b = await build(4, {
      step: { kind: 'continuation', tail: '他想起了過所的事。', written: 300, recovery: false },
    });
    assert.deepEqual(
      loreItems(b).map((i) => i.label),
      ['設定 · 崖字令牌', '設定 · 青崖鎮', '設定 · 過所']
    );
  });
});

/*
 * 架構那一層（設定名錄第四期）：只有設定清單與世界觀兩件用得上設定。清單當規劃看——分類表 + 已有條目
 * 一行一條（照用目錄、照抄名字）；世界觀只帶作者這次點名的；其餘幾件在設定之前，一條都不帶。
 */
describe('架構那一層', () => {
  const setting = (doc, ask = '') =>
    bundle.builder.buildContext(
      t.project,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc }, ask },
      config(3)
    );

  test('設定清單：分類表 + 已有條目一行一條', async () => {
    const items = loreItems(await setting('lore'));
    assert.equal(items[0].id, 'lore:categories');
    assert.equal(items[0].text, '本書的設定分類：地域、信物、宗門、宗門/正道（新設定的 category 從這裡挑）。');
    const lines = items.filter((i) => i.id !== 'lore:categories');
    assert.deepEqual(lines.map((i) => i.label).sort(), ['設定 · 後山', '設定 · 過所', '設定 · 青崖鎮', '設定 · 青雲宗', '設定 · 崖字令牌'].sort());
    assert.ok(lines.every((i) => i.text.startsWith('- ')), lines.map((i) => i.text).join('\n'));
  });

  // 世界觀不當規劃看：沒有分類表、沒有全部條目的一覽；作者點名的整條帶（近幾章定稿裡出現過的照常一句話）。
  test('世界觀：作者點名的整條帶，不列分類表與一覽', async () => {
    const items = loreItems(await setting('world', '把青雲宗的規矩寫進去'));
    assert.deepEqual([items[0].label, items[0].note], ['設定 · 青雲宗', '上下文中出現「青雲宗」']);
    assert.ok(items[0].text.startsWith('【青雲宗〔宗門/正道〕】'), items[0].text);
    assert.ok(!items.some((i) => i.id === 'lore:categories' || i.note?.startsWith('已有設定')), items.map((i) => `${i.label}:${i.note}`).join('\n'));
  });

  test('配置、前提、角色圖譜：一條都不帶', async () => {
    for (const doc of ['config', 'premise', 'characters']) {
      assert.deepEqual(loreItems(await setting(doc, '青雲宗')), [], doc);
    }
  });

  test('設定清單：一條條目都沒有也給分類表（空目錄也算）', async () => {
    const empty = await makeTempProject(bundle.project, { prefix: 'loreLayerEmpty', title: '空' });
    try {
      empty.write('.novelwarden/lore/宗門/.keep', '');
      empty.project.invalidate();
      const b = await bundle.builder.buildContext(
        empty.project,
        { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'lore' }, ask: '' },
        config(3)
      );
      assert.deepEqual(loreItems(b).map((i) => i.text), ['本書的設定分類：宗門（新設定的 category 從這裡挑）。']);
    } finally {
      cleanup(empty.dir);
    }
  });
});
