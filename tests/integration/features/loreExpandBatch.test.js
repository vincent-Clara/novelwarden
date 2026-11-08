/**
 * 完善設定三期（設計稿 §5、§6）：批次展開與寫前提醒。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 待完善的 `authored` | 三節全是「（未交代）」卻沒蓋過機器的章、明面空著只寫了暗設的，標成作者寫過（「全部展開」跳過）；空的、佔位的、機器寫的不標；`thinLoreFor` 只留要用到那幾章的 |
 * | 全部展開 | 先報次數（每條 2 次、最多 4 次——2026-10-25 起寫完轉寫一次，併發不改變這個數）與跳過誰；還沒有條目的先按「設定」一節的分類建空條目；只寫空的、佔位的、機器寫的；正文換成展開後的、記作機器寫的、水位同整合；關鍵詞只增不減、人名不收；子條目建空條目、不接著展開；還沒定的問題不寫進任何檔案；作者寫過的一個字不動 |
 * | 次數上限 | 轉寫不合格重轉一次、整理不出來重寫一次，兩樣不疊加（每條最多 4 次）；壞了語法的 JSON 交給轉寫理順；被截斷不重來；還不行算失敗，掛在那一條上（第 16 條）；完成提示說清寫了幾條、跳過幾條、失敗幾條 |
 * | 落盤前再認一遍 | 展開的這幾十秒裡作者寫了字的，不寫、說出來 |
 * | 沒有能寫的 | 全是作者寫過的：不問、不調，說清去單條展開 |
 * | 拆完展開本批新設定 | 預設不展開；選了就在拆完後按這一次新建的那幾條再問一次次數，答了才展開；取消只是不展開 |
 * | 寫前提醒 | 工作臺正文目標上一句（零呼叫、不攔，與 ⟳ 分開）；寫過字的、「設定」一節空著的、條目已經寫夠的不提；批次寫章確認框多一行 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const LORE = '.novelwarden/lore';
const TJG = `${LORE}/宗門/天機閣.md`;
const CJG = `${LORE}/宗門/藏經閣.md`;
const JCL = `${LORE}/地域/九層樓.md`;
const HS = `${LORE}/地域/後山.md`;
const MY = `${LORE}/秘藥.md`;
const QYZ = `${LORE}/宗門/青雲宗.md`;
const UNTOLD = '## 概要\n（未交代）\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n（未交代）';

function plotText(no, { hash, synopsis = '往下查。', events = '- 有事發生', lore = '' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(hash ? [`sourceHash: ${hash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    synopsis,
    '',
    '## 關鍵事件',
    '',
    events,
    '',
    '## 設定',
    '',
    lore || '（無）',
    '',
  ].join('\n');
}

function entry(title, { keywords = [title], brief = '', body = '', bodyHash } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(bodyHash ? [`bodyHash: ${bodyHash}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

const expansion = (over = {}) =>
  JSON.stringify({
    brief: '一句话',
    keywords: [],
    body: { 概要: '概要。', 规则与边界: '規則。', 现状: '現狀。', 暗设: '' },
    children: [],
    questions: [],
    ...over,
  });

/** 這一次在展開哪一條（裝配器把它寫在「當前這一條設定」那一節的第一行）。修 JSON 那一次沒有這一節。 */
function titleOf(messages) {
  const user = messages[messages.length - 1].content;
  return /# 當前這一條設定[^\n]*\n+【([^〔】]+)/.exec(user)?.[1];
}

/** 按條目名給應答；同一條的第幾次呼叫（含修 JSON 那一次）從 0 數。`route` 給了就全交給它。 */
let replies = {};
let route;
let lastTitle;
const seen = {};
function reply(messages) {
  if (route) {
    return route(messages);
  }
  const title = titleOf(messages) ?? lastTitle;
  lastTitle = title;
  const n = (seen[title] = (seen[title] ?? -1) + 1);
  const r = replies[title];
  const out = typeof r === 'function' ? r(n, messages) : Array.isArray(r) ? r[Math.min(n, r.length - 1)] : r;
  return out ?? { text: '（認不出這一步）', stop: 'end' };
}
function resetReplies(next, routeAll) {
  replies = next;
  route = routeAll;
  lastTitle = undefined;
  for (const k of Object.keys(seen)) delete seen[k];
  fake.calls.length = 0;
}

let settings;
function configure() {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    lore: './src/core/features/lore.ts',
    loreIndex: './src/core/views/lore.ts',
    material: './src/core/views/loreMaterial.ts',
    batch: './src/core/features/pipelineBatch.ts',
    workbench: './src/core/views/workbench.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    fs: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  configure();
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
});

/**
 * 第 1–2 章寫完、定稿；第 3–6 章細綱排好、還沒寫。
 *
 * - 天機閣：只有一句話（細綱帶出來的空條目）→ 批次寫
 * - 藏經閣：新建設定的佔位 → 批次寫
 * - 九層樓：設定清單起步時機器寫的三節「（未交代）」（蓋了章）→ 批次寫
 * - 後山：三節「（未交代）」，沒蓋章（作者手寫的）→ 跳過
 * - 秘藥：明面空著、作者寫了暗設 → 跳過
 * - 青雲宗：寫夠了，不在待完善裡
 * - 斷魂香：細綱點名、還沒有條目 → 先建空條目
 * - 林昭：人，不算
 */
async function setupBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '天機錄' });
  const project = t.project;
  t.write('.novelwarden/config.md', '---\ngenre: 武俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒。\n');
  t.write(TJG, entry('天機閣', { keywords: ['天機閣', '閣裡'], brief: '賣訊息的樓' }));
  t.write(CJG, entry('藏經閣', { body: '（在這裡寫這條設定：它是什麼、在哪、有什麼規矩……）' }));
  t.write(JCL, entry('九層樓', { brief: '藏書樓', body: UNTOLD, bodyHash: bundle.fs.hash(UNTOLD) }));
  t.write(HS, entry('後山', { body: UNTOLD }));
  t.write(MY, entry('秘藥', { brief: '只寫了暗設', body: '## 暗設\n作者寫的：秘藥是毒。' }));
  t.write(QYZ, entry('青雲宗', { brief: '正道第一宗', body: '劍修。' }));
  fs.mkdirSync(path.join(t.dir, `${LORE}/制度`), { recursive: true });
  for (let no = 1; no <= 2; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  const hashOf = (no) => chapters.find((c) => c.order === no).contentHash;
  t.write(PLOT(1), plotText(1, { hash: hashOf(1), lore: '- 天機閣〔宗門〕：一問一價' }));
  t.write(PLOT(2), plotText(2, { hash: hashOf(2) }));
  t.write(PLOT(3), plotText(3, { synopsis: '林昭夜入天機閣。', lore: '- 天機閣〔宗門〕：林昭在此買訊息\n- 後山〔地域〕\n- 林昭' }));
  t.write(PLOT(4), plotText(4, { lore: '- 藏經閣〔宗門〕\n- 秘藥' }));
  t.write(PLOT(5), plotText(5, { lore: '- 九層樓〔地域〕：二當家在樓下等\n- 青雲宗' }));
  t.write(PLOT(6), plotText(6, { lore: '- 斷魂香〔物品〕：二當家的毒' }));
  project.invalidate();
  return t;
}

describe('待完善的 authored 與 thinLoreFor', () => {
  let t;
  let thin;
  before(async () => {
    t = await setupBook('loreBatchThin');
    ({ thin } = await bundle.loreIndex.buildLoreIndex(t.project, {}, { pending: false, thin: true }));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('作者寫過的標 authored：三節未交代沒蓋章的、只寫了暗設的', () => {
    const flags = Object.fromEntries(thin.map((x) => [x.name, x.authored === true]));
    assert.deepEqual(flags, { 天機閣: false, 後山: true, 藏經閣: false, 秘藥: true, 九層樓: false, 斷魂香: false }, JSON.stringify(thin));
  });

  test('loreBatchExpandable：空的、佔位的、機器寫的可以；作者寫過的、寫夠了的不行', async () => {
    t.project.invalidate();
    const byTitle = Object.fromEntries((await t.project.listLore()).map((e) => [e.title, e]));
    const ok = (title) => bundle.material.loreBatchExpandable(byTitle[title]);
    assert.deepEqual(
      ['天機閣', '藏經閣', '九層樓', '後山', '秘藥', '青雲宗'].map(ok),
      [true, true, true, false, false, false]
    );
  });

  test('thinLoreFor 只留要用到那幾章的，章號也只留那幾章', async () => {
    const list = await bundle.loreIndex.thinLoreFor(t.project, [4, 5]);
    assert.deepEqual(list.map((x) => [x.name, x.chapters, x.first]), [['藏經閣', [4], 4], ['秘藥', [4], 4], ['九層樓', [5], 5]]);
    assert.deepEqual(await bundle.loreIndex.thinLoreFor(t.project, []), []);
  });
});

describe('全部展開', () => {
  let t;
  let project;
  let calls;
  const before3 = {};
  before(async () => {
    t = await setupBook('loreBatchAll');
    project = t.project;
    for (const rel of [HS, MY, QYZ]) before3[rel] = t.read(rel);
    resetReplies({
      // 一次就成：帶一條子條目、一條已有的子條目、一個人名關鍵詞、兩條問題。
      天機閣: {
        text: expansion({
          brief: '江湖上賣訊息的樓閣',
          keywords: ['天機樓', '林昭', '閣規'],
          body: { 概要: '賣訊息的七層樓。', 规则与边界: '一問一價。', 现状: '閣主閉關。', 暗设: '閣主是前朝太子。' },
          children: [
            { name: '閣規', category: '制度', brief: '天機閣的十條規矩' },
            { name: '青雲宗', category: '宗門', brief: '已有條目' },
          ],
          questions: ['閣規是成文的還是口傳的？'],
        }),
        stop: 'end',
      },
      // 解析不了（不是 JSON）→ 這一條重來一次。
      藏經閣: [{ text: '我先想想藏經閣……', stop: 'end' }, { text: expansion({ body: { 概要: '藏書三萬卷。' } }), stop: 'end' }],
      // 語法壞了 → 修一次（只改標點），不再重來。
      九層樓: [
        { text: '{"brief":"藏書樓","keywords":[],"body":{"概要":"九層。" "现状":"封樓。"},"children":[],"questions":[]}', stop: 'end' },
        { text: '{"brief":"藏書樓","keywords":[],"body":{"概要":"九層。", "现状":"封樓。"},"children":[],"questions":[]}', stop: 'end' },
      ],
      // 兩次都解析不了：失敗。
      斷魂香: { text: '斷魂香是一種毒……', stop: 'end' },
    });
    h.expect('開始展開');
    calls = await bundle.lore.expandLoreEntries(project);
    project.invalidate();
  });
  after(() => cleanup(t.dir, bundle.db));

  test('先報次數：每條 2 次（寫、轉寫各 1）、最多 4 次；說清跳過誰、誰先建空條目、用哪一檔', () => {
    const c = h.confirms[0];
    assert.match(c.message, /^展開 4 條設定：預計 8 次呼叫，最多 16 次（寫 1 次、轉寫 1 次；轉寫不合格重轉 1 次，或者整理不出來時這一條重寫、再轉寫 1 次，兩樣不疊加）。/, c.message);
    assert.ok(c.detail.includes('要展開的：天機閣、藏經閣、九層樓、斷魂香'), c.detail);
    assert.ok(c.detail.includes('其中 1 條還沒有條目，先按細綱「設定」一節裡的分類建空條目'), c.detail);
    assert.ok(c.detail.includes('跳過你寫過的 2 條：後山、秘藥'), c.detail);
    // 用哪一檔列在模型下拉框下面（「按分檔」時）；展開看詳細度，那個下拉框也在。
    assert.ok(c.call.tiers.join('\n').includes('故事架構'), c.call.tiers.join('\n'));
    // 轉寫不跟這一次挑的模型：單列一行。
    assert.ok(c.call.fixed?.some((line) => line.includes('轉寫')), JSON.stringify(c.call));
    assert.equal(c.call.contextDetail, 3);
    assert.deepEqual(c.actions, ['開始展開']);
  });

  // 九層樓：壞了語法的 JSON 交給轉寫理順（2026-10-25 起，從前是修一次），一樣是 2 次。
  test('實際呼叫：1 + 2（重寫）+ 2（轉寫理順）+ 2（重寫仍不行）= 7，返回的就是它', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(calls, 7);
  });

  test('裝配同對話頁的單條設定目標：展開合同、這一條在焦點上', () => {
    const user = fake.calls[0][fake.calls[0].length - 1].content;
    assert.ok(user.includes('【展開格式】') && user.includes('不寫 JSON'), user.slice(-800));
    assert.ok(user.includes('【天機閣〔宗門〕】'), user.slice(0, 2000));
    assert.ok(user.includes('林昭夜入天機閣'), '已排細綱裡用到它的地方');
  });

  test('只有一句話的：正文換成展開後的，暗設成第四節；記作機器寫的，水位同整合', async () => {
    const e = (await project.listLore()).find((x) => x.relPath === TJG);
    assert.ok(e.body.includes('賣訊息的七層樓。') && e.body.includes('## 暗設\n閣主是前朝太子。'), e.body);
    assert.equal(e.brief, '江湖上賣訊息的樓閣');
    assert.ok(bundle.lore.loreOwnedByMachine(e));
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    assert.equal(e.updatedThrough, 2);
  });

  test('關鍵詞只增不減；人名、拆出去的子條目不收', async () => {
    const e = (await project.listLore()).find((x) => x.relPath === TJG);
    assert.deepEqual(e.keywords, ['天機閣', '閣裡', '天機樓']);
  });

  test('還沒定的問題不寫進任何檔案', () => {
    const all = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.md')) all.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(path.join(t.dir, '.novelwarden'));
    assert.ok(!all.some((x) => x.includes('閣規是成文的還是口傳的')));
  });

  test('子條目建空條目（已有的不另建），不在同一批裡接著展開', async () => {
    const gz = (await project.listLore()).find((x) => x.title === '閣規');
    assert.equal(gz?.relPath, `${LORE}/制度/閣規.md`);
    assert.equal(gz.body.trim(), '');
    assert.equal(gz.brief, '天機閣的十條規矩');
    assert.equal((await project.listLore()).filter((x) => x.title === '青雲宗').length, 1);
    assert.ok(!fake.calls.some((m) => titleOf(m) === '閣規'));
  });

  test('佔位的、機器寫的薄條目也寫；解析不了的重來、語法壞了的修過', () => {
    assert.ok(t.read(CJG).includes('藏書三萬卷。'), t.read(CJG));
    assert.ok(!t.read(CJG).includes('在這裡寫這條設定'));
    assert.ok(t.read(JCL).includes('封樓。'), t.read(JCL));
  });

  test('作者寫過的一個字不動', () => {
    for (const rel of [HS, MY, QYZ]) assert.equal(t.read(rel), before3[rel], rel);
  });

  test('還沒有條目的先按「設定」一節的分類建空條目；展開失敗了空條目留著，失敗掛在它身上', async () => {
    const rel = `${LORE}/物品/斷魂香.md`;
    assert.ok(t.has(rel));
    const e = (await project.listLore()).find((x) => x.relPath === rel);
    assert.equal(e.body.trim(), '');
    const [f] = (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];
    assert.ok(f && f.op === 'expandLore' && f.message.includes('展開失敗'), JSON.stringify(f));
  });

  test('完成提示：寫了幾條、新建的子條目、跳過你寫過的、失敗幾條', () => {
    const toast = h.toasts[h.toasts.length - 1];
    assert.equal(toast, 'info: 展開 3 條設定，新建子條目 1 條：閣規，跳過你寫過的 2 條，失敗 1 條（詳見日誌頁）。');
  });

  test('寫過之後「待完善」裡只剩作者寫過的與失敗的那一條', async () => {
    const { thin } = await bundle.loreIndex.buildLoreIndex(project, {}, { pending: false, thin: true });
    assert.deepEqual(thin.map((x) => x.name).sort(), ['後山', '斷魂香', '秘藥'].sort());
  });
});

describe('次數上限與失敗', () => {
  let t;
  before(async () => {
    t = await setupBook('loreBatchCap');
  });
  after(() => cleanup(t.dir, bundle.db));

  test('被輸出上限截斷：不重來，算失敗', async () => {
    resetReplies({ 天機閣: { text: '{"brief":"賣訊息的","body":{"概要":"七層', stop: 'maxTokens' } });
    h.expect('開始展開');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 1);
    assert.equal(fake.callCount(), 1);
    assert.ok(!t.read(TJG).includes('七層'));
    const [f] = (await bundle.errorLog.listActiveFailures(t.project))[TJG] ?? [];
    assert.ok(f?.message.includes('截斷'), JSON.stringify(f));
  });

  // 寫 1 + 轉寫 1 + 重轉 1 = 3：已經重轉過就不再重寫（兩樣不疊加），轉寫的呼叫也算進返回的次數。
  test('重轉過一次仍解析不了：不再重寫（每條最多 4 次）', async () => {
    resetReplies({
      天機閣: [
        { text: '{"brief":"賣訊息的" "body":{}}', stop: 'end' },
        { text: '{"brief":"賣訊息的", "body":{}}', stop: 'end' },
      ],
    });
    h.expect('開始展開');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 3);
    assert.equal(fake.callCount(), 3);
    assert.ok(fake.calls[1][0].content.includes('格式轉寫員') && fake.calls[2][0].content.includes('格式轉寫員'));
  });

  // 按格式寫的原文（2026-10-25 起）：寫 1 + 轉寫 1，照抄的落盤；返回的次數含轉寫那一次。
  test('按格式寫、轉寫成 JSON：2 次，照抄的落盤', async () => {
    const prose = ['## 一句話', '賣訊息的樓', '## 關鍵詞', '天機樓', '## 概要', '九層的樓。', '## 規則與邊界', '一問一價。', '## 現狀', '（未交代）', '## 暗設', '無', '## 子條目', '無', '## 還沒定的問題', '無'].join('\n');
    const copied = expansion({ brief: '賣訊息的樓', keywords: ['天機樓'], body: { 概要: '九層的樓。', 规则与边界: '一問一價。', 现状: '（未交代）', 暗设: '無' } });
    const original = t.read(TJG);
    resetReplies({ 天機閣: [{ text: prose, stop: 'end' }, { text: copied, stop: 'end' }] });
    h.expect('開始展開');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 2);
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(fake.calls[1][0].content.includes('格式轉寫員') && user.includes('【原文】') && user.includes('九層的樓。'), user.slice(0, 600));
    assert.ok(t.read(TJG).includes('九層的樓。'), t.read(TJG));
    // 放回去：後面幾條還要拿它當只有一句話的條目展開。
    t.write(TJG, original);
    t.project.invalidate();
  });

  test('重來那一次就成了：失敗記錄收掉', async () => {
    resetReplies({ 天機閣: [{ text: '好的，我來想想。', stop: 'end' }, { text: expansion({ body: { 概要: '七層樓。' } }), stop: 'end' }] });
    h.expect('開始展開');
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [TJG]), 2);
    assert.ok(t.read(TJG).includes('七層樓。'));
    assert.equal(((await bundle.errorLog.listActiveFailures(t.project))[TJG] ?? []).length, 0);
  });

  test('取消就一次都不調', async () => {
    resetReplies({});
    h.expect(undefined);
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [CJG]), 0);
    assert.equal(fake.callCount(), 0);
  });

  test('給的幾條全是作者寫過的：不問、不調，說清去單條展開', async () => {
    resetReplies({});
    h.expect();
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [HS, MY]), 0);
    assert.equal(h.confirms.length, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('沒有能直接展開的設定') && x.includes('跳過你寫過的 2 條：後山、秘藥')), h.toasts.join('|'));
  });
});

describe('落盤前再認一遍', () => {
  let t;
  before(async () => {
    t = await setupBook('loreBatchRace');
    resetReplies({
      藏經閣: () => {
        // 模型想的這幾十秒裡，作者在編輯器裡寫了字。
        t.write(CJG, entry('藏經閣', { body: '## 概要\n作者剛寫的：藏書三萬卷。' }));
        return { text: expansion({ body: { 概要: '模型寫的。' } }), stop: 'end' };
      },
    });
    h.expect('開始展開');
    await bundle.lore.expandLoreEntries(t.project, [CJG]);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('作者寫了字的不寫，完成提示裡說出來', () => {
    assert.ok(t.read(CJG).includes('作者剛寫的'), t.read(CJG));
    assert.ok(!t.read(CJG).includes('模型寫的'));
    assert.ok(h.toasts.some((x) => x.includes('展開 0 條設定') && x.includes('「藏經閣」展開期間有人寫了內容')), h.toasts.join('|'));
  });
});

describe('拆完展開本批新設定', () => {
  let t;
  let project;
  const OUTLINE = outlineOf(20, { title: '大綱', text: { 1: '林昭進天機閣。' } });
  const blueprints = (messages) => {
    const user = messages[messages.length - 1].content;
    const m = /寫第 (\d+)(?:–(\d+))? 章的細綱：/.exec(user);
    const from = Number(m?.[1] ?? 1);
    const to = Number(m?.[2] ?? from);
    const items = [];
    for (let no = from; no <= to; no++) {
      items.push({
        chapterNumber: no,
        title: `第${no}章`,
        synopsis: '林昭下暗河。',
        characters: ['林昭'],
        timePlace: '夜',
        keyEvents: ['林昭摸進鬼市。'],
        highlights: ['鬼市開張'],
        foreshadowing: [],
        stateChange: '',
        settings: no === from ? [{ name: '鬼市', category: '地域', note: '暗河下的集市', isNew: true }] : [],
      });
    }
    return { text: JSON.stringify({ blueprints: items }), stop: 'end' };
  };
  /** 拆細綱、排敘事線、展開：按訊息認是哪一步。 */
  const steps = (messages) => {
    const user = messages[messages.length - 1].content;
    if (/寫第 \d+(?:–\d+)? 章的細綱：/.test(user)) return blueprints(messages);
    if (titleOf(messages)) return { text: expansion({ body: { 概要: '暗河下的集市。' } }), stop: 'end' };
    return { text: '{"threads":[]}', stop: 'end' };
  };
  /** 重拆第 2 章：刪掉它的細綱與它帶出來的新設定。 */
  const resetChapter2 = () => {
    t.remove(PLOT(2));
    t.remove(`${LORE}/地域/鬼市.md`);
    project.invalidate();
  };

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'loreBatchPlots', title: '鬼市' });
    project = t.project;
    t.write('.novelwarden/config.md', '---\ntotalChapters: 2\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
    writeOutline(t, OUTLINE);
    project.invalidate();
  });
  after(() => cleanup(t.dir, bundle.db));

  test('預設不展開：新設定照建空條目，拆完不再問', async () => {
    resetReplies({}, steps);
    h.expect();
    await bundle.batch.generatePlots(project, { range: { from: 1, to: 1 }, call: {} });
    project.invalidate();
    assert.equal(h.confirms.length, 0);
    const e = (await project.listLore()).find((x) => x.title === '鬼市');
    assert.equal(e?.body.trim(), '');
    assert.ok(!fake.calls.some((m) => titleOf(m)), '沒調展開');
  });

  test('選了展開、但這一次沒有新建設定（名字已經有條目）：不問', async () => {
    resetReplies({}, steps);
    h.expect('開始展開');
    const n = await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
    assert.equal(n, fake.callCount());
  });

  test('選了展開：拆完按這一次新建的那幾條再問一次次數，答了才展開', async () => {
    resetChapter2();
    resetReplies({}, steps);
    h.expect('開始展開');
    const n = await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    project.invalidate();
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
    assert.match(h.confirms[0].message, /^第 2 章拆出了 1 條新設定。展開 1 條設定：預計 2 次呼叫，最多 4 次/);
    assert.ok(h.confirms[0].detail.includes('要展開的：鬼市'), h.confirms[0].detail);
    const e = (await project.listLore()).find((x) => x.title === '鬼市');
    assert.ok(e.body.includes('暗河下的集市。'), e.body);
    assert.equal(n, fake.callCount(), '返回值含展開那一次');
  });

  test('第二問取消：只是不展開，細綱照樣在', async () => {
    resetChapter2();
    resetReplies({}, steps);
    h.expect(undefined);
    await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    project.invalidate();
    assert.equal(h.confirms.length, 1);
    assert.ok(t.has(PLOT(2)));
    assert.equal((await project.listLore()).find((x) => x.title === '鬼市')?.body.trim(), '');
    assert.ok(!fake.calls.some((m) => titleOf(m)), '沒調展開');
  });
});

describe('寫前提醒', () => {
  let t;
  let project;
  const wb = (no) => bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(no) });
  before(async () => {
    t = await setupBook('loreBatchHint');
    project = t.project;
    resetReplies({});
  });
  after(() => cleanup(t.dir, bundle.db));

  // 同一章的按名字排（後山在天機閣前面），與「待完善」同一個順序。
  test('還沒寫的章：本章要用的還只有一句話，提一句（與 ⟳ 分開）', async () => {
    const card = await wb(3);
    assert.equal(card.notice, '本章要用的 後山、天機閣 還只有一句話，寫之前可以先展開（在工程頁「待完善」裡右鍵「展開…」）。');
    assert.equal(card.warning, undefined);
  });

  test('還沒有條目的也算；寫夠了的不算', async () => {
    assert.ok((await wb(6)).notice?.includes('斷魂香'));
    assert.ok(!(await wb(5)).notice?.includes('青雲宗'));
    assert.ok((await wb(5)).notice?.includes('九層樓'));
  });

  test('已經寫了字的章、「設定」一節空著的章不提', async () => {
    assert.equal((await wb(1)).notice, undefined);
    assert.equal((await wb(2)).notice, undefined);
  });

  test('零呼叫', () => {
    assert.equal(fake.callCount(), 0);
  });

  test('批次寫章確認框多一行（不攔）', async () => {
    resetReplies({});
    h.expect(undefined);
    const n = await bundle.batch.writeManuscripts(project, { range: { from: 3, to: 5 } });
    assert.equal(n, 0);
    const c = h.confirms.find((x) => x.message.includes('要寫'));
    assert.ok(c, JSON.stringify(h.confirms));
    assert.ok(
      c.detail.includes('區間裡 5 條要用到的設定還只有一句話（後山、天機閣、藏經閣、秘藥、九層樓），寫之前可以先在工程頁「待完善」裡展開；不展開也照寫。'),
      c.detail
    );
    assert.deepEqual(c.actions, ['開始寫章']);
  });
});
