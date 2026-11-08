/**
 * 二期驗收：從空工程開始，**跟著主按鈕走**，一路寫到前 5 章細綱。
 *
 *   一句話 → 小說配置 → 故事前提 → 角色圖譜 → 世界觀 → 設定清單 → 情節大綱（第 1–20 章）→ 第 1–5 章細綱
 *
 * 每一步都照前端的做法：取後端推來的下一步（`pipeline.next`），按它的 stage / capability /
 * target / range 傳送，落盤卡片答「寫入」。釘的是整條連結得上：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 主按鈕的順序 | 第 20 條：狀態機一次只推一個，推的是對的那一個 |
 * | 每一步的裝配裡有前面幾步的產物 | 架構幾件一件吃一件；大綱吃架構與結構指導；細綱吃大綱那一節 |
 * | 一共調了幾次模型 | 第 4 條：配置 1、前提 1、角色圖譜 2、世界觀 1、設定清單 2、大綱 1、細綱 1 |
 * | 一張審閱都不彈 | 新工程裡全是空模板，覆蓋審閱只在真的要換掉作者的東西時出現 |
 * | 最後主按鈕是「寫第 1 章」 | 細綱拆完，全書狀態機轉進單章狀態機 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted = [];

const IDEA = '一個從火裡活下來的少年回到起火的鎮子，發現倖存者不止他一個。';

const CONFIG_JSON = JSON.stringify({
  genre: '武俠',
  targetAudience: '男頻',
  subGenre: '懸疑武俠',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '林昭攜殘令回到青崖鎮，追查七年前那場火，發現鎮上的人集體緘默，而放火的人就在其中。',
  worldSetting: '江湖式微，鎮與鎮之間靠一份名冊維繫。',
  goldenFinger: '殘令能照見持令人最後看見的一幕，每用一次要付出一段記憶。',
  protagonistProfile: '林昭，外冷內熱，唯一的執念是找出放火的人。',
  globalGuidance: '1. 不寫上帝視角\n2. 每章結尾留一個未決的問題\n3. 殘令每次使用都有代價\n4. 對白要分得出是誰在說',
  writingStyle: '冷峻剋制，短句為主，少用比喻，動作先於心理。',
});

const PREMISE = [
  '## 一句話前提', '當孤兒林昭回到青崖鎮，必須找出放火的人，否則倖存者一個個死去。',
  '## 核心衝突鏈', '滅門之火 → 回鎮 → 殘令被認出 → 持令人接連出事 → 鎮上集體緘默。',
  '## 爽點迴圈', '殘令照見最後一幕，代價是記憶。',
  '## 懸念骨架', '顯性：誰在殺持令人。隱藏：那場火是鎮上的人一起放的。',
].join('\n\n');

const MANIFEST = JSON.stringify({
  slots: [
    { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '回鎮追查', relations: [{ targetSlotId: '2', relation: '互相試探' }] },
    { slotId: '2', name: '沈氏', role: 'supporting', narrativeDuty: '客棧老闆娘，知道一半真相', relations: [] },
    { slotId: '3', name: '李叔', role: 'antagonist', narrativeDuty: '守衛，守著鎮上的秘密', relations: [{ targetSlotId: '1', relation: '處處設防' }] },
  ],
});

const WORLD = [
  '## 規則與漏洞', '名冊決定誰算鎮上的人；殘令是名冊的鑰匙。',
  '## 階層與資源', '守衛壟斷出入，客棧壟斷訊息。',
  '## 深層危機', '名冊上的人正在被一個個抹掉。',
].join('\n\n');

/** 一章一條，第 1–20 章（三幕 100 章的第一幕）。 */
const OUTLINE = outlineOf(20, {
  heading: false,
  titles: { 1: '停舟', 15: '名冊' },
  text: { 1: '林昭進鎮，殘令被李叔認出。', 15: '持令人接連出事，名冊的存在被揭開。' },
});

/** 設定清單：按武俠懸疑排的目錄樹（「地域/青崖」是二級，「門派」空著也建），五條一批就補完詳情。 */
const LORE_LIST = JSON.stringify({
  categories: ['地域', '地域/青崖', '信物', '制度', '門派'],
  entries: [
    { title: '青崖鎮', category: '地域', keywords: ['青崖'], brief: '偏僻小鎮，七年前遭過一場大火' },
    { title: '停舟客棧', category: '地域/青崖', keywords: [], brief: '鎮上唯一的客棧，沈氏開的' },
    { title: '殘令', category: '信物', keywords: ['令牌'], brief: '能照見持令人最後一幕的令牌' },
    { title: '名冊', category: '制度', keywords: [], brief: '決定誰算鎮上的人' },
    { title: '鎮口卡子', category: '地域/青崖', keywords: [], brief: '守衛查過所的地方' },
  ],
});

/** 按契約裡認得出的那一段應答。 */
function reply(messages) {
  const user = messages[messages.length - 1].content;
  if (user.includes('【設定清單格式】')) return LORE_LIST;
  if (user.includes('【凍結設定清單】')) {
    const titles = /【本批必須完整生成的條目】\n([^\n]+)/.exec(user)[1].split('、');
    return JSON.stringify({ entries: titles.map((title) => ({ title, body: `## 概要\n${title}在青崖鎮。\n\n## 規則與邊界\n${title}的規矩。` })) });
  }
  if (user.includes('【小說配置格式】')) return CONFIG_JSON;
  if (user.includes('【凍結身份與關係清單】')) {
    const names = /【本批要寫詳情的人】\n([^\n]+)/.exec(user)[1].split('、');
    return JSON.stringify({
      entries: names.map((name) => ({ name, 身份: `${name}的身份`, 性格: '冷', 当前状态: '在青崖鎮' })),
    });
  }
  if (user.includes('【身份清單格式】')) return MANIFEST;
  if (user.includes('「故事前提」')) return PREMISE;
  if (user.includes('「世界觀」')) return WORLD;
  if (user.includes('整合為全書的情節大綱')) return OUTLINE;
  const m = /寫第 (\d+)(?:–(\d+))? 章的細綱：/.exec(user);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    const blueprints = [];
    for (let no = from; no <= to; no++) {
      blueprints.push({
        chapterNumber: no,
        title: ['停舟', '令牌', '夜訪', '井', '名冊'][no - 1] ?? `第${no}章`,
        synopsis: `第 ${no} 章林昭要弄清的一件事`,
        characters: no === 4 ? ['林昭', '周老漢'] : ['林昭', '沈氏'],
        timePlace: '青崖鎮，入夜',
        // 關鍵事件與定稿一樣是一條一件事的陣列（⚑B）。
        keyEvents: [`第 ${no} 章：林昭在鎮上追查，殘令照見一幕。`, '他為此付出代價。'],
        // 章末鉤子不單列了，並進看點。
        highlights: [`第 ${no} 章結尾：又一個持令人不見了。`],
        foreshadowing: [],
        stateChange: '',
        ...(no === 4 ? { newCharacters: [{ name: '周老漢', role: 'minor' }] } : {}),
        // 設定名錄：第 4 章引入一口古井（新設定，建空條目），也用到青崖鎮（不是新的，不建）。
        ...(no === 4
          ? {
              settings: [
                { name: '古井', category: '地域/青崖', isNew: true, note: '鎮北廢宅裡的枯井' },
                { name: '青崖鎮', category: '地域', isNew: false, note: '' },
              ],
            }
          : {}),
      });
    }
    return JSON.stringify({ blueprints });
  }
  return '（認不出這一步）';
}

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

/** 後端最近一次推來的下一步。 */
async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按鈕；一句話那一步照彈窗的做法帶 setup。 */
async function press(step) {
  posted = [];
  const payload =
    step.form === 'idea'
      ? {
          text: IDEA,
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: 100, wordsPerChapter: 3000 },
        }
      : {
          text: '',
          stage: step.stage,
          capability: step.capability,
          target: step.target,
          targetNo: step.no ?? step.range?.from ?? 1,
          range: step.range,
        };
  await controller.handle({ type: 'send', payload: { ...payload, attachments: [], excludedIds: [] } });
  return posted.filter((m) => m.type === 'gate').pop();
}

/** 第 i 次呼叫的 user 訊息。 */
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;

describe('二期驗收：一句話 → 前 5 章細綱', () => {
  const labels = [];
  const gates = [];
  let finalStep;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      registry: './src/core/llm/registry.ts',
      provider: './src/core/llm/provider.ts',
      controller: './src/core/controller/index.ts',
      outlineFile: './src/core/model/outlineFile.ts',
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
      reply: (messages) => reply(messages),
      errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    });
    t = await makeTempProject(bundle.project, { prefix: 'phase2', title: '青崖記' });
    project = t.project;
    controller = new bundle.controller.ChatController(project);
    attach();

    // 跟著主按鈕走七步。每一步之前記下按鈕上的字。
    for (let i = 0; i < 7; i++) {
      const step = await nextStep();
      assert.ok(step, `第 ${i + 1} 步沒有下一步`);
      labels.push(step.label);
      gates.push(await press(step));
    }
    finalStep = await nextStep();
  });

  after(() => {
    controller?.dispose();
    if (t) cleanup(t.dir, bundle?.db);
  });

  test('主按鈕的順序：配置 → 前提 → 角色圖譜 → 世界觀 → 設定清單 → 大綱 → 拆細綱', () => {
    assert.deepEqual(labels, [
      '生成小說配置',
      '生成故事前提',
      '生成角色圖譜',
      '生成世界觀',
      '生成設定清單',
      '生成情節大綱（第 1–20 章）',
      '拆細綱（第 1–5 章）',
    ]);
  });

  test('每一步都出了落盤卡片，而且一張覆蓋審閱都沒彈', () => {
    assert.equal(gates.filter(Boolean).length, 7, JSON.stringify(gates.map((g) => g?.title)));
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((r) => r.relPath)));
  });

  // 第 4 條：配置 1、前提 1、角色圖譜 2（清單 + 一批 3 人的詳情）、世界觀 1、設定清單 2（清單 + 一批 5 條的詳情）、
  // 大綱 1、細綱 1。
  test('一共調了 9 次模型', () => {
    assert.equal(fake.callCount(), 9);
  });

  test('小說配置：一句話、規模、結構都在，文風進了 style.md', async () => {
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, IDEA);
    assert.equal(book.totalChapters, 100);
    assert.equal(book.wordsPerChapter, 3000);
    assert.equal(book.structure, 'three_act');
    assert.ok((await project.readStyleGuide()).includes('冷峻剋制'));
  });

  test('前提照著配置寫：它的裝配裡有配置的核心梗概', () => {
    assert.ok(userOf(1).includes('林昭攜殘令回到青崖鎮'), userOf(1).slice(0, 1500));
  });

  test('角色圖譜：三張卡，關係寫到雙方卡上', async () => {
    const cards = await project.listCharacters();
    const lin = cards.find((c) => c.name === '林昭');
    assert.ok(lin && lin.tags.includes('主角'), JSON.stringify(lin));
    assert.ok(lin.sections.人物关系.includes('與沈氏：互相試探') && lin.sections.人物关系.includes('與李叔：李叔眼中——處處設防'), lin.sections.人物关系);
  });

  test('世界觀照著前提與角色寫：裝配裡有前提的衝突鏈與角色圖譜', () => {
    const world = userOf(4);
    assert.ok(world.includes('滅門之火 → 回鎮') && world.includes('【角色圖譜】') && world.includes('- 林昭'), world.slice(0, 2500));
  });

  // 設定清單吃世界觀與角色圖譜（一行一人：人不是設定），卡片上事先列出會建哪幾條。
  test('設定清單照著世界觀排：裝配裡有世界觀與角色圖譜，卡片列出會新建的條目', () => {
    const lore = userOf(5);
    assert.ok(lore.includes('名冊決定誰算鎮上的人') && lore.includes('【角色圖譜】') && lore.includes('- 林昭'), lore.slice(0, 2500));
    assert.ok(lore.includes('世界觀講整體怎麼運轉，條目講某一個東西') && lore.includes('人不是設定'), lore.slice(-2500));
    assert.ok(gates[4].detail.includes('設定清單 · 5 條 · 5 個分類'), gates[4].detail);
    assert.ok(gates[4].detail.includes('會新建設定條目：青崖鎮、停舟客棧、殘令、名冊、鎮口卡子'), gates[4].detail);
  });

  test('設定清單落了盤：分類目錄（空的也建）、條目建在分類裡', async () => {
    assert.deepEqual(await project.listLoreCategories(), ['地域', '地域/青崖', '門派', '信物', '制度']);
    const inn = (await project.listLore()).find((e) => e.title === '停舟客棧');
    assert.equal(inn.relPath, '.novelwarden/lore/地域/青崖/停舟客棧.md');
    assert.equal(inn.brief, '鎮上唯一的客棧，沈氏開的');
    assert.ok(inn.body.includes('## 概要\n停舟客棧在青崖鎮。'), inn.body);
  });

  // 三幕 100 章：第一幕是第 1–20 章。結構指導點明這一批落在第一幕。
  test('大綱帶著按總章數算好的結構指導，只寫第 1–20 章', async () => {
    const outline = userOf(7);
    assert.ok(outline.includes('第一幕 · 建置（第 1–20 章）') && outline.includes('本次只寫第 1–20 章'), outline.slice(0, 4000));
    assert.equal(bundle.outlineFile.outlineCoverage(await project.readOutline()), 20);
  });

  // 按遠近帶：本批第 1–5 章與前 10 章整條，本批之後的不帶。
  test('細綱批次只帶大綱裡本批那幾條，本批之後的不帶', () => {
    const plots = userOf(8);
    assert.ok(plots.includes('## 第1章：停舟\n林昭進鎮，殘令被李叔認出。') && plots.includes('## 第5章'), plots.slice(0, 4000));
    assert.ok(!plots.includes('## 第6章') && !plots.includes('名冊的存在被揭開'), plots.slice(0, 4000));
  });

  // 細綱與單章摘要併成一份之後落在 summaries/ 根下；鉤子並進了「看點」，每章都該有一條。
  test('第 1–5 章的細綱都落了盤：標題進檔名，目標字數取每章字數', async () => {
    // 大綱是各章細綱梗概的彙總：第 6–20 章是續寫大綱時建的空殼（只有梗概），看排過的那幾份。
    const plots = (await project.listPlots()).filter((p) => p.sections.关键事件.trim());
    assert.deepEqual(plots.map((p) => p.relPath), [
      '.novelwarden/summaries/001-停舟.md',
      '.novelwarden/summaries/002-令牌.md',
      '.novelwarden/summaries/003-夜訪.md',
      '.novelwarden/summaries/004-井.md',
      '.novelwarden/summaries/005-名冊.md',
    ]);
    assert.ok(plots.every((p) => p.targetWords === 3000 && p.sections.看点.trim()), JSON.stringify(plots.map((p) => p.targetWords)));
    // 關鍵事件落盤成一條一行，與定稿寫出來的樣子一致。
    assert.equal(plots[1].sections.关键事件, '- 第 2 章：林昭在鎮上追查，殘令照見一幕。\n- 他為此付出代價。');
  });

  test('細綱裡的新角色建了卡，卡片上事先列出過', async () => {
    assert.ok((await project.listCharacters()).some((c) => c.name === '周老漢'));
    assert.ok(gates[6].detail.includes('會新建角色卡：周老漢'), gates[6].detail);
  });

  // 設定名錄：新設定隨細綱一起建空條目（同 D19），建在它的分類目錄裡，一句話取藍圖的 note；
  // 用到的已有設定（設定清單排過的青崖鎮）只記進「設定」一節，不再建一條。
  test('細綱裡的新設定建了空條目，卡片上事先列出過；「設定」一節記下計劃用到的設定', async () => {
    const well = (await project.listLore()).find((e) => e.title === '古井');
    assert.ok(well, '建了「古井」');
    assert.equal(well.relPath, '.novelwarden/lore/地域/青崖/古井.md');
    assert.equal(well.category, '地域/青崖');
    assert.equal(well.brief, '鎮北廢宅裡的枯井');
    assert.equal((await project.listLore()).filter((e) => e.title === '青崖鎮').length, 1);
    assert.ok(gates[6].detail.includes('會新建設定條目：古井'), gates[6].detail);
    assert.ok(!gates[6].detail.includes('青崖鎮'), gates[6].detail);
    assert.deepEqual((await project.getPlot(4)).lore, [
      { name: '古井', category: '地域/青崖', note: '鎮北廢宅裡的枯井' },
      { name: '青崖鎮', category: '地域', note: '' },
    ]);
  });

  test('拆完細綱，主按鈕轉到「寫第 1 章」', () => {
    assert.equal(finalStep?.label, '寫第 1 章', JSON.stringify(finalStep));
  });
});
