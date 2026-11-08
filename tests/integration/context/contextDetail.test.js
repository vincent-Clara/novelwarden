/**
 * 上下文詳細度（model/contextDetail.ts）在裝配器裡的落點：同一個工程、同一章，四級各裝一次。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 近章全文 0 / 1 / 2 / 3 章 | 級別越高帶得越多，這是開關的全部意思 |
 * | 「精簡」只帶最近 5 章細綱，更早的合成**一條** dropped，說明寫級別 | 第 2 條：不靜默截斷；也不拿九十幾行「不帶」淹掉明細 |
 * | 沒寫級別（老配置、手寫的測試配置）= 「詳細」 | 預設第 3 級，與從前一樣 |
 * | 「精簡」不帶定稿原文片段，出一條說明 | 第 2 條 |
 * | 「精簡」上一章結尾不超過 1000 字、角色卡只帶要點、敘事線 3 條 | 每一項都按級別 |
 * | 歷史封頂隨級別；落定細綱仍是 60% | settle 要沉澱的就是那段討論 |
 * | 細綱階段前後幾章、前序細綱一覽按級別 | 同上 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };
const N = 12;

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

/** 一章約 2000 字，十來段：上一章結尾要真被截。 */
function chapterText(no) {
  const para = (k) => `第${no}章第${k}段，${'雨還在下，'.repeat(36)}林昭往井邊走。`;
  return [
    `# 第${no}章`,
    '',
    `林昭在第${no}章把第${no}塊令牌塞進懷裡。`,
    '',
    ...Array.from({ length: 10 }, (_, k) => [para(k + 1), '']).flat(),
  ].join('\n');
}

/** 一份還沒定稿的細綱（計劃）。 */
function plotText(no) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    '往下查。',
    '',
    '## 出場人物',
    '',
    '林昭',
    '',
    '## 關鍵事件',
    '',
    `林昭在第${no}章去井邊。`,
    '',
    '## 看點',
    '',
    '- 井底有人。',
    '',
  ].join('\n');
}

/** 五條都與第 13 章有關（區間蓋住第 13 章），「精簡」只帶得下 3 條。一條線一個檔案。 */
const THREADS = ['玉佩', '名冊', '大火', '師父', '來信'].map((name) => [
  `.novelwarden/threads/${name}之謎.md`,
  `---\nkind: 支線\nplan: 10-20\n---\n\n# ${name}之謎\n\n## 意圖\n${name}的來歷。\n`,
]);

let bundle;
before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    detail: './src/core/model/contextDetail.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
});

/** 第 1..12 章正文都寫了、細綱都定稿了（sourceHash 對得上）；第 13 章的細綱還是計劃。 */
async function setupManuscript() {
  const t = await makeTempProject(bundle.project, { prefix: 'contextDetail', title: '詳細度測試' });
  for (let no = 1; no <= N; no++) {
    t.write(CH(no), chapterText(no));
  }
  t.write(PLOT(N + 1), plotText(N + 1));
  t.write(
    '.novelwarden/characters/林昭.md',
    '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒\n\n## 外貌\n\n左眉有一道疤\n\n## 當前狀態\n\n在查案\n'
  );
  for (const [rel, text] of THREADS) {
    t.write(rel, text);
  }
  t.project.invalidate();
  const chapters = await t.project.listChapters();
  for (let no = 1; no <= N; no++) {
    const ch = chapters.find((c) => c.order === no);
    t.write(
      `.novelwarden/summaries/${pad3(no)}-第${no}章.md`,
      `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${ch.contentHash}\ncast: [林昭]\n---\n\n# 第${no}章 第${no}章\n\n## 梗概\n\n第${no}章的事。\n\n## 出場人物\n\n林昭\n\n## 連續性事實\n\n- 林昭收起第${no}塊令牌 〔證據：「林昭在第${no}章把第${no}塊令牌塞進懷裡。」〕\n`
    );
  }
  t.project.invalidate();
  return t;
}

function write13(t, extra = {}, request = {}) {
  return bundle.builder.buildContext(
    t.project,
    { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(N + 1) }, ask: '', targetWords: 1200, ...request },
    config(extra)
  );
}

const live = (b, kind) => b.items.filter((i) => i.kind === kind && (i.status === 'included' || i.status === 'degraded'));

describe('上下文詳細度 · 寫第 13 章（前 12 章都定稿了）', () => {
  let t;
  const built = {};

  before(async () => {
    t = await setupManuscript();
    for (const d of [1, 2, 3, 4]) {
      built[d] = await write13(t, { contextDetail: d });
    }
    built.none = await write13(t);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('裝配結果記著按哪一級裝的；沒寫級別 = 3', () => {
    assert.deepEqual([1, 2, 3, 4].map((d) => built[d].detail), [1, 2, 3, 4]);
    assert.equal(built.none.detail, 3);
  });

  test('近章全文 0 / 1 / 2 / 3 章', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((d) => live(built[d], 'manuscriptFull').length),
      [0, 1, 2, 3]
    );
  });

  test('級別越高用量越大', () => {
    const used = [1, 2, 3, 4].map((d) => built[d].usedTokens);
    assert.ok(used[0] < used[1] && used[1] < used[2] && used[2] < used[3], used.join(' < '));
  });

  // 寫正文只帶前幾章細綱（`plotPrev`，上文），條數隨級別 1 / 2 / 3 / 5；更早的不帶，也不一章一條說「不帶」（2026-10-21）。
  test('前幾章細綱 1 / 2 / 3 / 5 章，都是緊挨著的那幾章', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((d) => live(built[d], 'plotSummary').map((i) => i.label.match(/第 (\d+) 章/)[1]).join(',')),
      ['12', '11,12', '10,11,12', '8,9,10,11,12']
    );
    assert.ok(!built[4].items.some((i) => i.kind === 'plotSummary' && i.status === 'dropped'), '更早的不一章一條');
  });

  test('「精簡」不帶定稿原文片段，出一條說明', () => {
    const ev = built[1].items.filter((i) => i.kind === 'evidence');
    assert.deepEqual(ev.map((i) => [i.id, i.status]), [['evidence:off', 'dropped']]);
    assert.match(ev[0].note, /上下文詳細度「精簡」不帶原文片段/);
    assert.ok(live(built[3], 'evidence').length > 0, '預設那一級照樣帶');
  });

  test('「精簡」上一章結尾不超過 1000 字', () => {
    const tail = (b) => b.items.find((i) => i.kind === 'prevTail');
    const short = tail(built[1]).text.replace('……（前略）\n\n', '');
    assert.ok(short.length <= 1000, String(short.length));
    // 「標準」起帶了上一章全文，結尾片段被整章取代（去重），不再單獨帶。
    assert.equal(tail(built[2]).status, 'dropped');
  });

  test('「精簡」角色卡只帶要點，說明寫級別', () => {
    const card = built[1].items.find((i) => i.id === 'character:林昭');
    assert.equal(card.status, 'degraded');
    assert.ok(!card.text.includes('左眉有一道疤'), card.text);
    assert.ok(card.text.includes('在查案'), card.text);
    // 寫正文時暗設不帶（敘事線重做第 10 個提交），要點只剩身份 / 當前狀態。
    assert.match(card.note, /上下文詳細度「精簡」只帶身份\/當前狀態$/);
    const full = built[3].items.find((i) => i.id === 'character:林昭');
    assert.equal(full.status, 'included');
    assert.ok(full.text.includes('左眉有一道疤'));
  });

  test('敘事線：「精簡」3 條，「詳細」5 條全帶', () => {
    assert.equal(live(built[1], 'thread').length, 3);
    const dropped = built[1].items.filter((i) => i.kind === 'thread' && i.status === 'dropped');
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((i) => i.note === '敘事線一次只帶 3 條，排在後面的沒帶'), dropped.map((i) => i.note).join('|'));
    assert.equal(live(built[3], 'thread').length, 5);
  });

  test('續寫那幾輪的近章事實：「精簡」最多 6 章', async () => {
    const step = { kind: 'continuation', tail: '林昭往井邊走。', written: 800, remaining: 400, recovery: false };
    const cont = await write13(t, { contextDetail: 1 }, { step });
    assert.equal(live(cont, 'facts').length, 6);
    const contDefault = await write13(t, {}, { step });
    assert.equal(live(contDefault, 'facts').length, 12);
  });

  test('測試的單項覆蓋疊在級別那一行上', async () => {
    const b = await write13(t, { contextDetail: 4, contextOverrides: { fullTextChapters: 0 } });
    assert.equal(live(b, 'manuscriptFull').length, 0);
    assert.ok(live(b, 'evidence').length > 0, '其餘照「完整」');
  });
});

describe('上下文詳細度 · 歷史封頂', () => {
  let t;
  const many = [];
  before(async () => {
    t = await setupManuscript();
    for (let i = 1; i <= 40; i++) {
      many.push({ id: `m${i}`, role: i % 2 === 1 ? 'user' : 'assistant', content: `第 ${i} 輪的內容。`.repeat(60), at: '2026-08-01T10:00:00Z' });
    }
  });
  after(() => cleanup(t.dir, bundle.db));

  const historyTokens = (b) => live(b, 'history').reduce((s, i) => s + i.tokens, 0);

  test('「精簡」歷史不超過預算 15%，「完整」可以到 40%', async () => {
    const small = await write13(t, { contextDetail: 1, contextWindow: 40000 }, { history: many });
    assert.ok(historyTokens(small) <= Math.floor(small.budget * 0.15) + 5, `${historyTokens(small)} / ${small.budget}`);
    const big = await write13(t, { contextDetail: 4, contextWindow: 40000 }, { history: many });
    assert.ok(historyTokens(big) > Math.floor(big.budget * 0.3), `${historyTokens(big)} / ${big.budget}`);
    assert.ok(historyTokens(big) <= Math.floor(big.budget * 0.4) + 5, `${historyTokens(big)} / ${big.budget}`);
  });

  test('落定細綱不隨級別：「精簡」也照樣能用到 15% 以上', async () => {
    const settle = await bundle.builder.buildContext(
      t.project,
      { action: { stage: 'plot', capability: 'settle' }, target: { kind: 'plot', plotRelPath: PLOT(N + 1) }, ask: '', history: many },
      config({ contextDetail: 1, contextWindow: 40000 })
    );
    assert.ok(historyTokens(settle) > Math.floor(settle.budget * 0.15), `${historyTokens(settle)} / ${settle.budget}`);
  });
});

describe('上下文詳細度 · 細綱階段（第 36 章，前面 35 章、後面 2 章都排了細綱）', () => {
  let t;
  const built = {};
  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'contextDetailPlot', title: '細綱測試' });
    for (let no = 1; no <= 38; no++) {
      t.write(PLOT(no), plotText(no));
    }
    t.project.invalidate();
    for (const d of [1, 3, 4]) {
      built[d] = await bundle.builder.buildContext(
        t.project,
        { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(36) }, ask: '' },
        config({ contextDetail: d })
      );
    }
  });
  after(() => cleanup(t.dir, bundle.db));

  /** 細綱條目的章號（`plot:<路徑>`），本章自己除外。 */
  const neighbours = (b) =>
    b.items
      .filter((i) => i.kind === 'plot' && i.status === 'included')
      .map((i) => Number(/summaries\/(\d+)/.exec(i.id)?.[1]))
      .filter((no) => no !== 36);

  test('前後幾章細綱：「精簡」1 / 1，「詳細」3 / 1，「完整」5 / 2', () => {
    const count = (b) => {
      const nos = neighbours(b);
      return [nos.filter((n) => n < 36).length, nos.filter((n) => n > 36).length];
    };
    assert.deepEqual(count(built[1]), [1, 1]);
    assert.deepEqual(count(built[3]), [3, 1]);
    assert.deepEqual(count(built[4]), [5, 2]);
  });

  // 2026-10-24 一覽單獨一組數（10 / 20 / 30 / 不限），不再與大綱的中段共用 30 / 50 / 100 / 不限。
  test('前序細綱一覽：「精簡」只帶最近 10 章、「詳細」30 章並說明；「完整」不限', () => {
    const list = (b) => b.items.find((i) => i.id === 'plotList');
    assert.match(list(built[1]).label, /（10 章）/);
    assert.match(list(built[1]).note, /只帶最近 10 章（上下文詳細度「精簡」）/);
    assert.match(list(built[3]).label, /（30 章）/);
    assert.match(list(built[3]).note, /只帶最近 30 章（上下文詳細度「詳細」）/);
    assert.match(list(built[4]).label, /（30 章）/);
    assert.equal(list(built[4]).note, undefined);
  });
});
