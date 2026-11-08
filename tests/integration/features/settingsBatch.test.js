/**
 * 工程頁「補齊架構」：配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單，只補空白、嚴格序列（D21）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 沒有一句話 | 配置缺席又沒有腦洞可展開：不調模型，說清先做什麼 |
 * | 補齊 | 確認框報出缺哪幾件、預計與上限；按順序一件一件來，後一件讀得到前一件；設定清單建了目錄與條目 |
 * | 一件失敗就停 | 後面幾件不跑；失敗掛在那一行上（第 16 條） |
 * | 都齊了 | 一次都不調 |
 * | 已經寫了正文 | 照正文整理；設定清單算填過，不排 |
 * | 按格式寫、轉寫成 JSON | 2026-10-25 起配置、角色圖譜、設定清單寫完由轉寫那一檔照抄成 JSON：確認框單列轉寫那一行，轉寫只帶合同與原文，次數算進返回的數 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let settings = {};
/** 按契約裡認得出的那一段應答；`fail` 裡列的那一件答空話。 */
let fail = new Set();

const CONFIG_JSON = JSON.stringify({
  genre: '玄幻',
  targetAudience: '男頻',
  subGenre: '宗門',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '少年揹著舊案入宗，查出宗門與舊案的關係。',
  worldSetting: '靈脈枯竭的九州。',
  goldenFinger: '殘令。',
  protagonistProfile: '林昭，隱忍。',
  globalGuidance: '1. 不寫上帝視角\n2. 每章留鉤子\n3. 金手指有代價\n4. 對白分得出是誰',
  writingStyle: '冷峻剋制。',
});
const MANIFEST = JSON.stringify({
  slots: [
    { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '主角', relations: [{ targetSlotId: '2', relation: '同門' }] },
    { slotId: '2', name: '沈青', role: 'supporting', narrativeDuty: '引路人', relations: [] },
    { slotId: '3', name: '周嶽', role: 'antagonist', narrativeDuty: '對手', relations: [] },
  ],
});
const DETAILS = JSON.stringify({
  entries: ['林昭', '沈青', '周嶽'].map((name, i) => ({ slotId: String(i + 1), name, 身份: `${name}的身份`, 当前状态: '在山門' })),
});
/** 設定清單：三個一級分類、十二條（詳情兩批）。 */
const LORE_TITLES = ['青雲宗', '執法堂', '藏經閣', '青崖鎮', '停舟客棧', '靈脈', '鎮妖塔', '殘令', '過所', '外門', '內門', '靈石'];
const LORE_CATEGORY = ['宗門', '宗門', '宗門', '地域', '地域', '地域', '地域', '法寶', '制度', '宗門', '宗門', '法寶'];
const LORE_MANIFEST = JSON.stringify({
  categories: ['宗門', '地域', '法寶', '制度'],
  entries: LORE_TITLES.map((title, i) => ({ title, category: LORE_CATEGORY[i], keywords: [], brief: `${title}的一句話` })),
});
/** 詳情：按這一批點名的條目答。 */
function loreDetails(user) {
  const named = /【本批必須完整生成的條目】\n([^\n]+)/.exec(user)?.[1].split('、') ?? [];
  return JSON.stringify({ entries: named.map((title) => ({ title, body: `## 概要\n${title}的概要。\n\n## 規則與邊界\n${title}的規矩。` })) });
}

function which(user) {
  return user.includes('【凍結設定清單】')
    ? 'loreDetails'
    : user.includes('【設定清單格式】')
      ? 'loreList'
      : user.includes('【小說配置格式】')
        ? 'config'
        : user.includes('【凍結身份與關係清單】')
          ? 'details'
          : user.includes('【身份清單格式】')
            ? 'manifest'
            : user.includes('「故事前提」')
              ? 'premise'
              : user.includes('「世界觀」')
                ? 'world'
                : '?';
}

/** 給了就先問它（按格式寫、轉寫那一組用）；交回 undefined 再走下面按契約認的那一套。 */
let override;

function reply(messages) {
  const user = messages[messages.length - 1].content;
  const own = override?.(messages);
  if (own !== undefined) {
    return own;
  }
  const kind = which(user);
  if (fail.has(kind)) {
    return '';
  }
  switch (kind) {
    case 'config':
      return CONFIG_JSON;
    case 'premise':
      return '## 一句話前提\n\n當孤兒遭遇滅門，必須入宗查案。\n\n## 核心衝突鏈\n\n滅門 → 入宗 → 查案 → 執法堂阻撓。\n\n## 爽點迴圈\n\n殘令。\n\n## 懸念骨架\n\n誰放的火。';
    case 'manifest':
      return MANIFEST;
    case 'details':
      return DETAILS;
    case 'world':
      return '## 規則與漏洞\n\n靈脈決定修為。\n\n## 階層與資源\n\n宗門壟斷靈脈。\n\n## 深層危機\n\n靈脈在枯竭。';
    case 'loreList':
      return LORE_MANIFEST;
    case 'loreDetails':
      return loreDetails(user);
    default:
      return 'unknown';
  }
}

/** 呼叫的順序：每次呼叫認出是哪一件。 */
function order() {
  return fake.calls.map((c) => which(c[c.length - 1].content));
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    batch: './src/core/features/pipelineBatch.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => reply(messages) });
  t = await makeTempProject(bundle.project, { prefix: 'settings', title: '青雲劍錄' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('補齊架構 · 沒有一句話', () => {
  test('配置缺席又沒有腦洞可展開：不調模型，說清先做什麼', async () => {
    h.expect('開始補齊');
    fake.reset();
    const n = await bundle.batch.completeSettings(project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('一句話')), h.toasts.join('|'));
  });
});

describe('補齊架構', () => {
  let confirm;
  let calls;
  let returned;

  before(async () => {
    const cfg = t.read('.novelwarden/config.md').replace(/## 一句話\n\n（待補充）/, '## 一句話\n\n少年揹著舊案入宗');
    t.write('.novelwarden/config.md', cfg);
    // 前提只寫了一句話前提、衝突鏈還空著：算沒填過，要補——但作者寫的那一節不能動。
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 一句話前提\n\n作者自己寫的一句話前提。\n\n## 核心衝突鏈\n\n（待補充）\n');
    project.invalidate();
    fail = new Set();
    fake.reset();
    h.expect('開始補齊');
    returned = await bundle.batch.completeSettings(project);
    confirm = h.confirms[0];
    calls = order();
  });

  // 配置 2 次（最多 5）+ 前提 1 次 + 角色圖譜 4–8 次（最多 31）+ 世界觀 1 次 + 設定清單 6–12 次（最多 24）：
  // 配置、角色圖譜、設定清單每寫一次都轉寫一次（2026-10-25 起）。
  test('確認框報出缺哪幾件、預計與上限', () => {
    assert.ok(
      confirm?.message.includes('要補齊小說配置、故事前提、角色圖譜、世界觀、設定清單，預計 14–24 次呼叫，最多 62 次'),
      JSON.stringify(confirm)
    );
    // 轉寫不跟這一次挑的模型：確認框單列一行。
    assert.ok(confirm.detail.includes('由轉寫模型照抄成 JSON'), confirm.detail);
    assert.ok(confirm.call.fixed?.some((line) => line.includes('轉寫')), JSON.stringify(confirm.call));
    assert.ok(confirm.detail.includes('按 100 章 × 3000 字展開'), confirm.detail);
    assert.ok(confirm.detail.includes('世界觀 → 設定清單'), confirm.detail);
  });

  test('按順序一件一件來', () => {
    assert.deepEqual(calls, ['config', 'premise', 'manifest', 'details', 'world', 'loreList', 'loreDetails', 'loreDetails']);
    assert.equal(returned, 8);
  });

  // 每件都吃前面幾件的產出：世界觀那一次的裝配裡有剛寫好的前提與角色。
  test('後一件讀得到前一件', () => {
    const world = fake.calls[4][fake.calls[4].length - 1].content;
    assert.ok(world.includes('滅門 → 入宗 → 查案') && world.includes('- 林昭'), world.slice(0, 1500));
    // 設定清單讀得到剛寫好的世界觀與角色圖譜（一行一人）。
    const lore = fake.calls[5][fake.calls[5].length - 1].content;
    assert.ok(lore.includes('靈脈在枯竭') && lore.includes('- 林昭'), lore.slice(0, 1500));
  });

  // 第 19 條的批次那一面：只補空白，作者寫過的節一個字不動，也不彈審閱。
  test('作者寫過的節原樣留著，不彈審閱', async () => {
    const premise = await project.readSettingDoc('premise');
    assert.equal(premise.sections.一句话前提, '作者自己寫的一句話前提。');
    assert.ok(premise.sections.核心冲突链.includes('滅門'), premise.sections.核心冲突链);
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms.map((c) => c.message)));
  });

  test('五件都落了盤', async () => {
    const filled = await project.settingFilled();
    assert.deepEqual(filled, { config: true, premise: true, characters: true, world: true, lore: true });
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, '少年揹著舊案入宗');
    assert.equal(book.totalChapters, 100);
    assert.equal((await project.listCharacters()).length >= 3, true);
  });

  // 分類就是目錄：清單排的四個目錄都建了（「制度」下也有一條，「法寶」兩條）；條目歸機器、水位 0。
  test('設定清單：建了分類目錄與十二條條目', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '法寶', '制度', '宗門'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    const entries = await project.listLore();
    assert.equal(entries.length, 12);
    const inn = entries.find((e) => e.title === '停舟客棧');
    assert.equal(inn.relPath, '.novelwarden/lore/地域/停舟客棧.md');
    assert.equal(inn.brief, '停舟客棧的一句話');
    assert.equal(inn.updatedThrough, 0);
    assert.ok(inn.body.includes('## 規則與邊界\n停舟客棧的規矩。'), inn.body);
    assert.ok(loadModule('src/core/features/lore.ts').loreOwnedByMachine(inn));
  });

  // D15：圖譜寫的當前狀態是開篇狀態、歸機器——定稿時才能接著往後更新，而不是被當成作者寫的。
  test('角色圖譜建的卡蓋了章：開篇狀態、歸機器', async () => {
    const stateModel = loadModule('src/core/model/characterState.ts');
    const cards = await project.listCharacters();
    assert.ok(cards.length > 0);
    for (const c of cards) {
      assert.equal(c.stateThrough, 0, c.name);
      assert.ok(stateModel.stateOwnedByMachine(c), c.name);
    }
  });

  test('都齊了就一次都不調', async () => {
    fake.reset();
    h.expect('開始補齊');
    assert.equal(await bundle.batch.completeSettings(project), 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('都已經有了')), h.toasts.join('|'));
  });
});

describe('補齊架構 · 一件失敗就停', () => {
  let calls;
  let failures;

  before(async () => {
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n（待補充）\n');
    t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n（待補充）\n');
    project.invalidate();
    fail = new Set(['premise']);
    fake.reset();
    h.expect('開始補齊');
    await bundle.batch.completeSettings(project);
    calls = order();
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('前提沒成，世界觀不跑', async () => {
    assert.deepEqual(calls, ['premise']);
    assert.equal((await project.settingFilled()).world, false);
  });

  test('失敗掛在故事前提那一行上', () => {
    assert.ok(!!failures['.novelwarden/premise.md'], JSON.stringify(Object.keys(failures)));
  });

  test('toast 說清停在哪', () => {
    assert.ok(h.toasts.some((x) => x.includes('故事前提沒補上') && x.includes('已經停下')), h.toasts.join('|'));
  });
});

describe('補齊架構 · 已經寫了正文', () => {
  let w;
  let n;
  let configCall;

  before(async () => {
    w = await makeTempProject(bundle.project, { prefix: 'settings-written', title: '舊稿' });
    w.write('chapters/001-第1章.md', '# 第1章\n\n林昭揹著藤箱進了青崖鎮。\n');
    w.write('chapters/002-第2章.md', '# 第2章\n\n林昭在鎮口撞見了守衛。\n');
    w.project.invalidate();
    fail = new Set();
    fake.reset();
    h.expect('開始補齊');
    n = await bundle.batch.completeSettings(w.project);
    configCall = fake.calls.find((c) => c[c.length - 1].content.includes('【小說配置格式】'));
  });

  after(() => {
    if (w) cleanup(w.dir);
  });

  test('沒有一句話也補得出配置：照已寫正文整理', async () => {
    assert.ok(n > 0);
    assert.ok(configCall, JSON.stringify(order()));
    assert.ok(configCall[configCall.length - 1].content.includes('從已寫正文整理'));
    assert.equal((await w.project.settingFilled()).config, true);
  });

  test('確認框說清照正文整理', () => {
    assert.ok(h.confirms.some((c) => (c.detail ?? '').includes('照已寫正文整理')), JSON.stringify(h.confirms));
  });

  // 在寫的書：設定清單算填過（設定從定稿里長、從名錄建條目），補齊不排它，也不調它。
  test('設定清單算填過：一條條目都沒有也不排', async () => {
    assert.equal((await w.project.settingFilled()).lore, true);
    assert.ok(!order().includes('loreList'), order().join(','));
    assert.ok(!h.confirms.some((c) => c.message.includes('設定清單')), JSON.stringify(h.confirms.map((c) => c.message)));
    assert.deepEqual(await w.project.listLore(), []);
  });
});

describe('補齊架構 · 設定清單按格式寫、轉寫成 JSON', () => {
  const PROSE_LIST = ['## 分類', '- 渡口', '## 清單', '- 黑水渡（渡口）：北境唯一能過黑水的渡口'].join('\n');
  const PROSE_DETAILS = ['## 黑水渡', '### 概要', '黑水河上的老渡口。', '### 規則與邊界', '只在子時開船。', '### 現狀', '無'].join('\n');
  const LIST_JSON = JSON.stringify({ categories: ['渡口'], entries: [{ title: '黑水渡', category: '渡口', keywords: [], brief: '北境唯一能過黑水的渡口' }] });
  const DETAILS_JSON = JSON.stringify({ entries: [{ title: '黑水渡', body: { 概要: '黑水河上的老渡口。', 规则与边界: '只在子時開船。', 现状: '無' } }] });
  let w;
  let n;
  let transcribed;

  before(async () => {
    w = await makeTempProject(bundle.project, { prefix: 'settings-transcribe', title: '黑水' });
    w.write('.novelwarden/config.md', '---\ngenre: 仙俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 一句話\n\n渡口舊事\n\n## 核心梗概\n\n林昭在渡口查舊案。\n');
    w.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n滅門 → 查案。\n');
    w.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n黑水不渡活人。\n');
    w.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒。\n');
    w.project.invalidate();
    transcribed = [];
    override = (messages) => {
      const user = messages[messages.length - 1].content;
      if (messages[0].content.includes('格式轉寫員')) {
        transcribed.push(user);
        return user.includes('【設定清單 JSON 合同】') ? LIST_JSON : DETAILS_JSON;
      }
      return user.includes('【設定清單格式】') ? PROSE_LIST : user.includes('【凍結設定清單】') ? PROSE_DETAILS : undefined;
    };
    fail = new Set();
    fake.reset();
    h.confirms.length = 0;
    h.expect('開始補齊');
    n = await bundle.batch.completeSettings(w.project);
  });

  after(() => {
    override = undefined;
    if (w) cleanup(w.dir);
  });

  test('確認框單列轉寫那一行，次數裡算上轉寫', () => {
    const c = h.confirms[0];
    assert.ok(c.message.includes('要補齊設定清單，預計 6–12 次呼叫，最多 24 次'), c.message);
    assert.ok(c.call.fixed?.some((line) => line.includes('轉寫')), JSON.stringify(c.call));
  });

  test('清單、詳情各寫 1 次、轉寫 1 次：返回 4 次', () => {
    assert.equal(fake.callCount(), 4);
    assert.equal(n, 4);
    assert.equal(transcribed.length, 2);
    assert.ok(transcribed[0].includes('【原文】') && transcribed[0].includes('- 黑水渡（渡口）') && !transcribed[0].includes('黑水不渡活人'), transcribed[0]);
  });

  test('照抄的落盤', async () => {
    w.project.invalidate();
    const e = (await w.project.listLore()).find((x) => x.title === '黑水渡');
    assert.ok(e && e.category === '渡口' && e.body.includes('只在子時開船。'), JSON.stringify(e));
  });
});
