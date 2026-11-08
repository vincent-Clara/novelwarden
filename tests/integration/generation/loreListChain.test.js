/**
 * 架構 · 設定清單（設定名錄第四期）：經對話頁從生成一路走到落盤。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 兩段式落盤 | 清單 → 每批 6 條補正文、截斷拆半；裝配帶本書的分類表與已有條目；人名不進清單；卡片列出會新建哪幾條；先建分類目錄（空的也建），新條目建在分類裡、歸機器、水位 0；名字撞上已有條目的走覆蓋審閱，關鍵詞並起來 |
 * | 覆蓋審閱放棄了 | 作者那一條一個字不動，新條目照建（第 3 條） |
 * | 呼叫次數封頂 | 詳情一路截斷拆到底也不越過主按鈕報的上限 24 次，剩下的只按清單建（第 4 條）；轉寫的呼叫也算進去 |
 * | 按格式寫、轉寫成 JSON | 2026-10-25 起清單與詳情都按小標題寫，轉寫模型照抄成 JSON：轉寫只帶合同與原文；改了字重轉一次 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;
let gates;

/** 作者手寫的已有條目：正文沒有機器的指紋，算作者的。 */
const QINGYUN = '---\ntitle: 青雲宗\nkeywords: [青雲門]\nbrief: 正道第一大宗\n---\n\n# 青雲宗\n\n作者寫的：山門在北。\n';

const MANIFEST = {
  categories: ['宗門', '地域', '法寶', '禁地/北境'],
  entries: [
    // 「青雲門」是已有條目的關鍵詞：認回「青雲宗」，分類以它實際所在的目錄為準。
    { title: '青雲門', category: '地域', keywords: ['青雲'], brief: '正道大宗，執掌北境' },
    { title: '青崖鎮', category: '地域', keywords: ['青崖'], brief: '偏僻小鎮，鎮口設卡查過所' },
    { title: '停舟客棧', category: '地域', keywords: [], brief: '鎮上唯一的客棧' },
    { title: '崖字令', category: '法寶', keywords: ['令牌'], brief: '刻著崖字的舊令牌' },
    // 人不是設定：角色卡上有他。
    { title: '林昭', category: '地域', keywords: [], brief: '主角' },
  ],
};
const body = (title) => `## 概要\n${title}的概要。\n\n## 規則與邊界\n${title}的規矩。\n\n## 現狀\n（未交代）`;
const detailsOf = (...titles) => JSON.stringify({ entries: titles.map((title) => ({ title, body: body(title) })) });

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

async function generateLoreList() {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', targetNo: 0, attachments: [], excludedIds: [], stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'lore' } },
  });
  return gates[0];
}

const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    lore: './src/core/features/lore.ts',
    fs: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'lorelist', title: '青雲劍錄' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ngenre: 仙俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭入青雲宗查舊案。\n');
  t.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n滅門 → 入宗 → 查案。\n');
  t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n北境諸鎮憑過所出入，崖字令能開鎮口的卡子。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒。\n');
  t.write('.novelwarden/lore/宗門/青雲宗.md', QINGYUN);
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('設定清單 · 兩段式落盤', () => {
  let gate;
  let entries;

  before(async () => {
    fake.reset([
      { text: JSON.stringify(MANIFEST), stop: 'end' },
      // 一批四條被截斷：拆成兩條 + 兩條重試。
      { text: '{"entries":[{"title":"青雲宗"', stop: 'maxTokens' },
      { text: detailsOf('青雲宗', '青崖鎮'), stop: 'end' },
      { text: detailsOf('停舟客棧', '崖字令'), stop: 'end' },
    ]);
    h.setReviewVerdict('apply');
    gate = await generateLoreList();
    project.invalidate();
    entries = await project.listLore();
  });

  test('清單 1 次 + 詳情（截斷拆半）3 次', () => {
    assert.equal(fake.callCount(), 4);
    // 凍結的清單一條一行（2026-10-25 起不再是 JSON）：「青雲門」已認回「青雲宗」，分類以它所在的目錄為準。
    assert.ok(userOf(1).includes('【凍結設定清單】') && userOf(1).includes('- 青雲宗（宗門）：正道大宗，執掌北境'), userOf(1).slice(-1500));
    assert.ok(userOf(2).includes('【本批必須完整生成的條目】\n青雲宗、青崖鎮'), userOf(2).slice(-800));
  });

  // 清單要照用本書的目錄、照抄已有條目的名字：分類表與已有條目一行一條由 lore 層帶進來。
  test('清單那一次帶著世界觀、本書的分類表與已有條目', () => {
    const u = userOf(0);
    assert.ok(u.includes('崖字令能開鎮口的卡子'), u.slice(0, 2000));
    assert.ok(u.includes('本書的設定分類：宗門'), u);
    assert.ok(u.includes('- 青雲宗〔宗門〕：正道第一大宗'), u);
    assert.ok(u.includes('【設定清單格式】') && u.includes('人不是設定'), u.slice(-2000));
    // 按格式寫，不要 JSON（2026-10-25 起）。
    assert.ok(u.includes('不寫 JSON') && !u.includes('{"categories"'), u.slice(-2000));
  });

  test('卡片：形狀、會新建哪幾條、拆半與丟掉人名的說明；不說「會覆蓋」', () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('設定清單 · 4 條 · 4 個分類'), gate.detail);
    assert.ok(gate.detail.includes('會新建設定條目：青崖鎮、停舟客棧、崖字令'), gate.detail);
    assert.ok(gate.detail.includes('拆成兩半重試'), gate.detail);
    assert.ok(gate.detail.includes('「林昭」是角色卡上的人'), gate.detail);
    assert.ok(!gate.detail.includes('那裡已經有內容了'), gate.detail);
  });

  test('先建分類目錄：空的也建（作者看得到分類表）', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '法寶', '禁地', '禁地/北境', '宗門']);
  });

  test('新條目建在分類目錄裡：一句話、關鍵詞含標題、機器寫的指紋、水位 0', () => {
    const town = entries.find((e) => e.title === '青崖鎮');
    assert.equal(town.relPath, '.novelwarden/lore/地域/青崖鎮.md');
    assert.equal(town.brief, '偏僻小鎮，鎮口設卡查過所');
    assert.deepEqual(town.keywords, ['青崖鎮', '青崖']);
    assert.equal(town.updatedThrough, 0);
    assert.equal(town.bodyHash, bundle.fs.hash(body('青崖鎮')));
    assert.ok(bundle.lore.loreOwnedByMachine(town));
    assert.ok(!entries.some((e) => e.title === '林昭'));
  });

  // 第 3 條：名字（這裡是關鍵詞）撞上已有條目的，一條一審；關鍵詞並起來，一句話新的優先，正文換新、歸機器。
  test('撞上已有條目的走覆蓋審閱，採納後合併', () => {
    assert.deepEqual(h.reviewed.map((r) => r.relPath), ['.novelwarden/lore/宗門/青雲宗.md']);
    assert.equal(h.reviewed[0].name, '設定「青雲宗」');
    const qy = entries.find((e) => e.title === '青雲宗');
    assert.equal(qy.relPath, '.novelwarden/lore/宗門/青雲宗.md');
    assert.deepEqual(qy.keywords, ['青雲門', '青雲']);
    assert.equal(qy.brief, '正道大宗，執掌北境');
    assert.ok(qy.body.includes('青雲宗的規矩。') && !qy.body.includes('作者寫的'), qy.body);
    assert.ok(bundle.lore.loreOwnedByMachine(qy));
    assert.equal(entries.filter((e) => e.title === '青雲宗').length, 1);
  });

  test('一共四條：新建三條 + 合併進去的那一條已有條目，沒有重複', () => {
    assert.equal(entries.length, 4);
  });
});

describe('設定清單 · 覆蓋審閱放棄了', () => {
  let before2;

  before(async () => {
    t.write('.novelwarden/lore/宗門/青雲宗.md', QINGYUN);
    project.invalidate();
    before2 = t.read('.novelwarden/lore/宗門/青雲宗.md');
    fake.reset([
      {
        text: JSON.stringify({
          categories: ['宗門'],
          entries: [
            { title: '青雲宗', category: '宗門', keywords: [], brief: '換一個說法' },
            { title: '藏經閣', category: '宗門', keywords: [], brief: '青雲宗的藏書處' },
          ],
        }),
        stop: 'end',
      },
      { text: detailsOf('青雲宗', '藏經閣'), stop: 'end' },
    ]);
    h.expect();
    h.setReviewVerdict('discard');
    await generateLoreList();
    project.invalidate();
  });

  after(() => h.setReviewVerdict('apply'));

  test('作者那一條一個字不動', () => {
    assert.equal(h.reviewed.length, 1);
    assert.equal(t.read('.novelwarden/lore/宗門/青雲宗.md'), before2);
  });

  test('新條目照建，並說出保留了哪一條', async () => {
    assert.ok((await project.listLore()).some((e) => e.relPath === '.novelwarden/lore/宗門/藏經閣.md'));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('新建 1 條設定條目') && m.includes('保留原樣的 青雲宗')), toasts.join('|'));
  });
});

describe('設定清單 · 呼叫次數封頂', () => {
  const S = loadModule('src/core/generation/structured.ts');
  const P = loadModule('src/core/model/pipeline.ts');
  let result;
  let calls = 0;

  before(async () => {
    const manifest = {
      categories: ['地域', '宗門', '法寶'],
      entries: Array.from({ length: 30 }, (_, i) => ({ title: `物${i + 1}`, category: '地域', keywords: [], brief: `第 ${i + 1} 樣` })),
    };
    // 詳情每一次都被截斷：一路對半拆下去。
    const io = {
      messages: [],
      build: async () => [{ role: 'user', content: '詳情' }],
      call: async () => {
        calls++;
        return { text: '{"entries":[', stop: 'maxTokens' };
      },
    };
    result = await S.completeLoreList({ text: JSON.stringify(manifest), stop: 'end' }, io, { categories: [], entries: [], people: [] });
  });

  // 一批要寫一次、轉寫一次：餘量不夠兩次就不寫了，所以停在上限或差一次。
  test('一共呼叫不超過主按鈕報的上限', () => {
    assert.ok(result.calls <= P.LORE_LIST_CALLS_MAX && result.calls >= P.LORE_LIST_CALLS_MAX - 1, String(result.calls));
    assert.equal(calls + 1, result.calls);
    assert.equal(P.loreListCalls().max, P.LORE_LIST_CALLS_MAX);
  });

  test('剩下的條目只按清單建，並說明為什麼', () => {
    const out = JSON.parse(result.raw);
    assert.equal(out.entries.length, 30);
    assert.ok(out.entries.every((e) => !e.body && e.brief), JSON.stringify(out.entries.slice(0, 2)));
    assert.ok(result.notes.some((n) => n.includes(`上限 ${P.LORE_LIST_CALLS_MAX}`)), result.notes.join('\n'));
  });
});

// 寫到一半再排清單：定稿裡單獨記下的名字不能被清單裡的一條收成關鍵詞（收了它就再也建不出自己的條目）。
describe('設定清單 · 名錄裡另記著的名字', () => {
  before(async () => {
    t.write('chapters/001-第1章.md', '# 第1章\n\n他抬手一道寒冰鎖。\n');
    project.invalidate();
    const [ch] = await project.listChapters();
    t.write(
      '.novelwarden/summaries/001-第1章.md',
      `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch.contentHash}\n---\n\n# 第1章 第1章\n\n## 設定\n\n- 寒冰鎖〔法術〕：縛住對手的冰鎖\n`
    );
    project.invalidate();
    fake.reset([
      {
        text: JSON.stringify({
          categories: ['法術'],
          entries: [{ title: '魔法體系', category: '法術', keywords: ['寒冰鎖', '施法'], brief: '這本書的魔法' }],
        }),
        stop: 'end',
      },
      { text: detailsOf('魔法體系'), stop: 'end' },
    ]);
    await generateLoreList();
    project.invalidate();
  });

  test('「魔法體系」不收「寒冰鎖」', async () => {
    const magic = (await project.listLore()).find((e) => e.title === '魔法體系');
    assert.ok(magic, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.deepEqual(magic.keywords, ['魔法體系', '施法']);
  });
});

// ---------------------------------------------------------------- 按格式寫、轉寫成 JSON（2026-10-25 起）

const TRANSCRIBER = '格式轉寫員';
const systemOf = (i) => fake.calls[i][0].content;

describe('設定清單 · 按格式寫、轉寫成 JSON', () => {
  const PROSE_LIST = ['## 分類', '- 地域', '- 渡口', '## 清單', '- 黑水渡（渡口；別稱：黑渡）：北境唯一能過黑水的渡口', '- 斷劍崖（地域）：崖上插滿斷劍'].join('\n');
  const LIST_JSON = JSON.stringify({
    categories: ['地域', '渡口'],
    entries: [
      { title: '黑水渡', category: '渡口', keywords: ['黑渡'], brief: '北境唯一能過黑水的渡口' },
      { title: '斷劍崖', category: '地域', keywords: [], brief: '崖上插滿斷劍' },
    ],
  });
  const PROSE_DETAILS = [
    '## 黑水渡',
    '### 概要',
    '黑水河上的老渡口，歸船幫。',
    '### 規則與邊界',
    '只在子時開船，一船不過七人。',
    '### 現狀',
    '（未交代）',
    '## 斷劍崖',
    '### 概要',
    '北境的斷崖，崖上插滿斷劍。',
    '### 規則與邊界',
    '拔劍者會被崖上的劍意所傷。',
    '### 現狀',
    '無',
  ].join('\n');
  const detailJson = (rule) =>
    JSON.stringify({
      entries: [
        { title: '黑水渡', body: { 概要: '黑水河上的老渡口，歸船幫。', 规则与边界: rule, 现状: '（未交代）' } },
        { title: '斷劍崖', body: { 概要: '北境的斷崖，崖上插滿斷劍。', 规则与边界: '拔劍者會被崖上的劍意所傷。', 现状: '無' } },
      ],
    });
  let gate;

  before(async () => {
    fake.reset([
      { text: PROSE_LIST, stop: 'end' },
      { text: LIST_JSON, stop: 'end' },
      { text: PROSE_DETAILS, stop: 'end' },
      // 轉寫改了原文的字：不收，重轉一次。
      { text: detailJson('子時開船，最多載七人。'), stop: 'end' },
      { text: detailJson('只在子時開船，一船不過七人。'), stop: 'end' },
    ]);
    h.setReviewVerdict('apply');
    gate = await generateLoreList();
    project.invalidate();
  });

  test('清單寫 1 次、轉寫 1 次；詳情寫 1 次、轉寫 2 次（改了字重轉一次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok(!systemOf(0).includes(TRANSCRIBER) && !systemOf(2).includes(TRANSCRIBER));
    assert.ok([1, 3, 4].every((i) => systemOf(i).includes(TRANSCRIBER)), systemOf(1));
  });

  // 轉寫只看原文：給多了它會順手補內容。
  test('轉寫只帶合同與原文，不帶書的上下文', () => {
    assert.ok(userOf(1).includes('【設定清單 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('- 黑水渡（渡口；別稱：黑渡）'), userOf(1));
    assert.ok(!userOf(1).includes('崖字令能開鎮口的卡子'), userOf(1));
    assert.ok(userOf(3).includes('【設定詳情 JSON 合同】') && userOf(3).includes('只在子時開船，一船不過七人。'), userOf(3));
  });

  test('詳情那一次帶著凍結清單（一條一行）', () => {
    assert.ok(userOf(2).includes('- 黑水渡（渡口）：北境唯一能過黑水的渡口'), userOf(2).slice(-1500));
    assert.ok(userOf(2).includes('【本批必須完整生成的條目】\n黑水渡、斷劍崖'), userOf(2).slice(-1500));
  });

  test('重轉那一次說清哪幾處不是原文裡的字', () => {
    assert.ok(userOf(4).includes('【上次轉寫不合格】這幾處不是原文裡的字：「子時開船，最多載七人。」'), userOf(4).slice(0, 800));
  });

  test('照抄的落盤：分類、關鍵詞、正文三節；卡片上說出重轉', async () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('重轉一次'), gate.detail);
    const ferry = (await project.listLore()).find((e) => e.title === '黑水渡');
    assert.ok(ferry, JSON.stringify((await project.listLore()).map((e) => e.title)));
    assert.equal(ferry.category, '渡口');
    assert.deepEqual(ferry.keywords, ['黑水渡', '黑渡']);
    assert.ok(ferry.body.includes('只在子時開船，一船不過七人。'), ferry.body);
  });
});

describe('設定清單 · 轉寫的呼叫也算進封頂', () => {
  const S = loadModule('src/core/generation/structured.ts');
  const P = loadModule('src/core/model/pipeline.ts');
  let result;
  let writes = 0;
  let transcribes = 0;

  before(async () => {
    const manifest = {
      categories: ['地域', '宗門', '法寶'],
      entries: Array.from({ length: 30 }, (_, i) => ({ title: `物${i + 1}`, category: '地域', keywords: [], brief: `第 ${i + 1} 樣` })),
    };
    // 詳情按格式寫了，轉寫每一次都改字：重轉一次（全程只這一次），之後對半拆、各寫各轉，直到上限。
    const io = {
      messages: [],
      build: async () => [{ role: 'user', content: '詳情' }],
      call: async () => {
        writes++;
        return { text: '## 物1\n### 概要\n第一樣東西。\n### 規則與邊界\n無\n### 現狀\n無', stop: 'end' };
      },
      transcribe: async () => {
        transcribes++;
        return { text: JSON.stringify({ entries: [{ title: '物1', body: { 概要: '改寫過的東西' } }] }), stop: 'end' };
      },
    };
    result = await S.completeLoreList({ text: JSON.stringify(manifest), stop: 'end' }, io, { categories: [], entries: [], people: [] });
  });

  test('寫與轉寫合起來不超過上限，兩樣都記在賬上', () => {
    assert.ok(transcribes > 0);
    assert.equal(result.calls, 1 + writes + transcribes);
    assert.ok(result.calls <= P.LORE_LIST_CALLS_MAX, String(result.calls));
    assert.ok(result.notes.some((n) => n.includes(`上限 ${P.LORE_LIST_CALLS_MAX}`)), result.notes.join('\n'));
  });

  test('全程只重轉一次', () => {
    assert.equal(result.notes.filter((n) => n.includes('重轉一次')).length, 1, result.notes.join('\n'));
  });
});
