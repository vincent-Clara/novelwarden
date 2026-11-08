/**
 * 角色卡與設定的維護改成轉寫（2026-10-25）：更新角色卡 / 建卡、提取角色、記設定、建條目 / 整合、按目錄整理，
 * 幹活的模型按格式寫自然語言，轉寫那一檔的模型照抄成原來那份 JSON，解碼與後處理一行沒改。
 *
 * 幹活的走各自那一檔（這裡沒配，沿用預設模型 big），轉寫走「轉寫」那一檔（快速檔配的是 small）：兩個模型分得清誰幹活誰轉寫。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 更新角色卡 · 照抄收下 | 寫一次（不要 JSON，十個小標題）、轉一次；轉寫只帶合同與原文；照抄的落進卡裡；確認框報「預計 2 次，最多 3 次」、單列轉寫 |
 * | 更新角色卡 · 改了字 | 不收，重轉一次，說清哪幾處；重轉照抄了就照常寫回 |
 * | 更新角色卡 · 轉寫呼叫失敗 | 同從前解析失敗：這一批跳過，卡一個字不改，卡上掛紅 ❗ |
 * | 提取角色 | 按人物、小標題寫，轉寫成陣列；劇作稱謂換成別名裡的真名那條後處理照舊 |
 * | 記設定 | 「## 設定」一條一行寫，轉寫成 `{"设定":[…]}`，寫進細綱「設定」一節前照舊校驗；轉寫呼叫失敗同從前解析不出來：「設定」一節不動、掛黃 ❗ |
 * | 建條目 | 「一句話 / 關鍵詞 / ## 概要……」寫，轉寫成 `{brief, keywords, body}`，body 是整段 Markdown；重轉仍不合格同從前解析不了：這一條重寫一次、再轉 |
 * | 按目錄整理 | 「## 新目錄」「## 搬家」寫，轉寫成搬家清單，路徑照抄才認得出來 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
/** 按模型引用注入異常（fakeProvider 的 behavior）：建 provider 時現讀。 */
const behavior = {};

const TRANSCRIBER = '格式轉寫員';
const CARD = '.novelwarden/characters/林昭.md';
const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/00${no}-第${no}章.md`;
const TEXT = [
  '雨下了一整夜。林昭進了青崖鎮，鎮口的守衛查驗過所。',
  '停舟客棧是鎮上唯一的客棧，二層木樓。韓厲帶人摸進鎮口，火把一路燒到客棧門前。',
  '沈氏在櫃檯後看著他，沒說話。林昭只說了一句「知道了」。',
].join('\n\n');

/** 幹活那一次各步的原文（按系統提示認）；轉寫那一次按佇列交回。 */
const prose = {};
let transcripts = [];
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    return transcripts.shift() ?? '（轉寫佇列空了）';
  }
  if (system.includes('負責維護一部長篇小說的人物檔案')) return prose.card;
  if (system.includes('負責從正文中提取人物檔案')) return prose.characters;
  if (system.includes('負責記下這一章正文裡出現了哪些設定')) return prose.record;
  if (system.includes('把定稿細綱裡關於一個設定的記錄整理成一條設定條目')) return prose.entry;
  if (system.includes('負責把設定條目歸進合適的目錄')) return prose.organize;
  return '（認不出這一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
const lastConfirm = () => h.confirms[h.confirms.length - 1];

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    characterCard: './src/core/features/characterCard.ts',
    characters: './src/core/features/characters.ts',
    loreRecord: './src/core/features/loreRecord.ts',
    lore: './src/core/features/lore.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 16000 }, { name: 'small', contextWindow: 16000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    // 記設定預設也是快速檔：挪到均衡檔（沒配，沿用 big），寫的與轉寫的才分得開。
    taskTiers: { loreScan: 'balanced' },
    contextWindow: 16000,
    maxOutputTokens: 1000,
    concurrency: 1,
  };
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'maintain-transcribe', title: '維護轉寫' });
  project = t.project;
  t.write(CH(1), `# 第1章\n\n${TEXT}\n`);
  t.write(CARD, '---\nname: 林昭\naliases: []\ntags: []\n---\n\n# 林昭\n\n## 身份\n\n（待補充）\n');
  project.invalidate();
  // 第 1 章定稿過（細綱的 sourceHash 對得上正文）：林昭出場；「設定」一節記過停舟客棧。
  const ch1 = (await project.listChapters()).find((c) => c.order === 1);
  t.write(
    PLOT(1),
    `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch1.contentHash}\ncast: [林昭, 沈氏]\n---\n\n# 第1章 第1章\n\n` +
      '## 梗概\n\n林昭進鎮。\n\n## 關鍵事件\n\n- 林昭住進停舟客棧。\n\n## 設定\n\n- 停舟客棧〔地域〕：鎮上唯一的客棧\n'
  );
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

// ---------------------------------------------------------------- 更新角色卡

prose.card = [
  '## 別名',
  '阿昭',
  '## 標籤',
  '主角',
  '## 性別',
  '男',
  '## 身份',
  '剛進青崖鎮的外鄉少年，揹著滅門舊案。',
  '## 外貌',
  '無',
  '## 性格',
  '沉默寡言，遇事先藏三分。',
  '## 語言習慣',
  '答話極短，常說「知道了」。',
  '## 人物關係',
  '- 沈氏：客棧掌櫃，收留了他',
  '## 當前狀態',
  '住在停舟客棧，等天亮。',
  '## 暗設',
  '無',
].join('\n');

const cardJson = (over = {}) =>
  JSON.stringify({
    aliases: ['阿昭'],
    tags: ['主角'],
    性别: '男',
    身份: '剛進青崖鎮的外鄉少年，揹著滅門舊案。',
    外貌: '無',
    性格: '沉默寡言，遇事先藏三分。',
    语言习惯: '答話極短，常說「知道了」。',
    人物关系: '- 沈氏：客棧掌櫃，收留了他',
    当前状态: '住在停舟客棧，等天亮。',
    暗设: '',
    ...over,
  });

describe('更新角色卡 · 按小標題寫，轉寫照抄收下', () => {
  let card;

  before(async () => {
    transcripts = [cardJson()];
    fake.reset();
    h.expect('開始');
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    card = t.read(CARD);
  });

  test('寫一次、轉一次：幹活的是 big，轉寫的是轉寫那一檔的 small', () => {
    assert.equal(fake.callCount(), 2);
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
  });

  test('寫角色卡的提示詞不要 JSON，十個小標題；字數上限與暗設只做減法照舊', () => {
    const s = systemOf(0);
    assert.ok(s.includes('不寫 JSON') && s.includes('## 別名') && s.includes('## 暗設'), s.slice(0, 600));
    assert.ok(s.includes('80 字以內') && s.includes('可以寫到 200 字') && s.includes('150 字以內') && s.includes('每條不超過 25 字'), s);
    assert.match(s, /「暗設」是作者定下的、讀者還不知道的真相，只做減法/);
    assert.ok(userOf(0).includes('按格式寫出完整的檔案'), userOf(0).slice(-200));
  });

  test('轉寫只帶合同與原文，不帶正文', () => {
    assert.ok(systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【角色卡 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('沉默寡言，遇事先藏三分。'), userOf(1));
    assert.ok(!userOf(1).includes('雨下了一整夜'), userOf(1));
  });

  test('照抄的落進卡裡；寫「無」的那一節空著', () => {
    assert.match(card, /## 性格\n\n沉默寡言，遇事先藏三分。/);
    assert.match(card, /## 人物關係\n\n- 沈氏：客棧掌櫃，收留了他/);
    assert.match(card, /阿昭/);
    assert.doesNotMatch(card, /## 外貌\n\n無/);
  });

  test('確認框報寫 1 次、轉寫 1 次，單列轉寫交給誰', () => {
    const c = h.confirms.find((x) => x.message.includes('次呼叫'));
    assert.ok(c.message.includes('分 1 批，預計 2 次呼叫，最多 3 次（寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次）'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('轉寫 · 整理成 JSON') && x.includes('不跟這一次挑的模型')), JSON.stringify(c.call));
  });
});

describe('更新角色卡 · 轉寫改了原文的字', () => {
  let card;

  before(async () => {
    transcripts = [cardJson({ 性格: '冷靜剋制，城府很深。' }), cardJson()];
    fake.reset();
    h.expect('開始');
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    card = t.read(CARD);
  });

  test('不收，重轉一次，說清哪幾處不是原文裡的字；重轉照抄了就照常寫回', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「冷靜剋制，城府很深。」'), userOf(2).slice(0, 600));
    assert.match(card, /沉默寡言，遇事先藏三分。/);
    assert.doesNotMatch(card, /冷靜剋制/);
  });
});

describe('更新角色卡 · 轉寫呼叫失敗', () => {
  let before1;
  let after1;
  let marks;

  before(async () => {
    t.write(CARD, '---\nname: 林昭\naliases: []\ntags: []\n---\n\n# 林昭\n\n## 身份\n\n舊的身份\n');
    project.invalidate();
    before1 = t.read(CARD);
    behavior['p/small'] = 'fail';
    try {
      transcripts = [];
      fake.reset();
      h.expect('開始');
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      delete behavior['p/small'];
    }
    after1 = t.read(CARD);
    marks = (await bundle.errorLog.listActiveFailures(project))[CARD] ?? [];
  });

  test('同從前解析失敗：這一批跳過，卡一個字不改，卡上掛紅 ❗，說清是轉寫呼叫失敗', () => {
    assert.equal(after1, before1);
    assert.ok(marks.some((m) => m.severity === 'error' && m.message.includes('解析失敗')), JSON.stringify(marks));
    assert.ok(marks.some((m) => (m.detail ?? '').includes('轉寫呼叫失敗')), JSON.stringify(marks));
  });
});

// ---------------------------------------------------------------- 提取角色

prose.characters = [
  '## 韓厲',
  '### 別名',
  '無',
  '### 標籤',
  '反派',
  '### 性別',
  '男',
  '### 身份',
  '黑風寨寨主，帶人夜襲青崖鎮。',
  '### 外貌',
  '無',
  '### 性格',
  '多疑，下手狠。',
  '### 語言習慣',
  '無',
  '### 人物關係',
  '無',
  '### 當前狀態',
  '帶人摸進鎮口。',
  '### 暗設',
  '無',
  '',
  '## 反派',
  '### 別名',
  '韓厲、頭領',
  '### 標籤',
  '反派',
  '### 性別',
  '男',
  '### 身份',
  '黑風寨頭領',
  '### 外貌',
  '無',
  '### 性格',
  '無',
  '### 語言習慣',
  '無',
  '### 人物關係',
  '無',
  '### 當前狀態',
  '無',
  '### 暗設',
  '無',
].join('\n');

describe('提取角色 · 按人物、小標題寫，轉寫成陣列', () => {
  let card;
  let files;

  before(async () => {
    transcripts = [
      JSON.stringify([
        { name: '韓厲', aliases: [], tags: ['反派'], 性别: '男', 身份: '黑風寨寨主，帶人夜襲青崖鎮。', 性格: '多疑，下手狠。', 当前状态: '帶人摸進鎮口。' },
        { name: '反派', aliases: ['韓厲', '頭領'], tags: ['反派'], 性别: '男', 身份: '黑風寨頭領' },
      ]),
    ];
    fake.reset();
    h.expect('1', '開始提取');
    await bundle.characters.extractCharacters(project);
    project.invalidate();
    card = (await project.listCharacters()).find((c) => c.name === '韓厲');
    files = (await project.listCharacters()).map((c) => c.name);
  });

  test('寫一次、轉一次；寫的提示詞不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不寫 JSON') && systemOf(0).includes('### 別名'), systemOf(0).slice(0, 400));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【人物檔案 JSON 合同】') && userOf(1).includes('黑風寨寨主'), userOf(1));
    assert.equal(refOf(1), 'p/small');
  });

  test('確認框報寫 1 次、轉寫 1 次', () => {
    const c = h.confirms.find((x) => x.actions.includes('開始提取'));
    assert.ok(c.message.includes('預計 2 次呼叫，最多 3 次'), c.message);
  });

  test('照抄的建成卡；劇作稱謂換成別名裡的真名、併成一條（後處理照舊）', () => {
    assert.ok(card, files.join('、'));
    assert.ok(!files.includes('反派'), files.join('、'));
    assert.equal(card.sections.性格, '多疑，下手狠。');
    assert.equal(card.gender, '男');
    assert.ok(card.aliases.includes('頭領') && card.tags.includes('反派'), JSON.stringify(card));
  });
});

// ---------------------------------------------------------------- 記設定

prose.record = ['## 設定', '- 停舟客棧（地域）：鎮上唯一的客棧，二層木樓', '- 過所（制度）', '- 黑市（地點）'].join('\n');

describe('記設定 · 一條一行寫，轉寫成 {"设定":[…]}', () => {
  let plot;

  before(async () => {
    transcripts = [
      JSON.stringify({
        设定: [
          { name: '停舟客棧', category: '地域', fact: '鎮上唯一的客棧，二層木樓' },
          { name: '過所', category: '制度', fact: '' },
          { name: '黑市', category: '地點', fact: '' },
        ],
      }),
    ];
    fake.reset();
    h.expect('開始記');
    await bundle.loreRecord.recordLore(project, CH(1));
    project.invalidate();
    plot = await project.getPlot(1);
  });

  test('寫一次、轉一次；寫的提示詞不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.deepEqual([refOf(0), refOf(1)], ['p/big', 'p/small']);
    assert.ok(systemOf(0).includes('不寫 JSON') && systemOf(0).includes('「名字（分類）：說明」'), systemOf(0).slice(0, 600));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【設定 JSON 合同】') && userOf(1).includes('二層木樓'), userOf(1));
  });

  test('確認框報寫 1 次、轉寫 1 次，單列轉寫', () => {
    const c = lastConfirm();
    assert.ok(c.message.includes('讀第 1 章正文，預計 2 次呼叫，最多 3 次'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('轉寫 · 整理成 JSON')), JSON.stringify(c.call));
  });

  test('寫進「設定」一節之前照舊校驗：名字不在正文裡的丟掉', () => {
    assert.deepEqual(plot.lore, [
      { name: '停舟客棧', category: '地域', note: '鎮上唯一的客棧，二層木樓' },
      { name: '過所', category: '制度', note: '' },
    ]);
  });
});

describe('記設定 · 轉寫呼叫失敗', () => {
  let beforeText;
  let failures;

  before(async () => {
    beforeText = t.read(PLOT(1));
    behavior['p/small'] = 'fail';
    try {
      transcripts = [];
      fake.reset();
      h.expect('開始記');
      await bundle.loreRecord.recordLore(project, CH(1));
    } finally {
      delete behavior['p/small'];
    }
    failures = (await bundle.errorLog.listActiveFailures(project))[CH(1)] ?? [];
  });

  test('同從前解析不出來：「設定」一節不動，掛黃 ❗，說清是轉寫呼叫失敗', () => {
    assert.equal(t.read(PLOT(1)), beforeText);
    assert.ok(failures.some((f) => f.op === 'loreRecord' && f.severity === 'warn' && f.message.includes('轉寫呼叫失敗')), JSON.stringify(failures));
  });
});

// ---------------------------------------------------------------- 建條目

prose.entry = [
  '一句話：青崖鎮上唯一的客棧',
  '關鍵詞：停舟、客棧',
  '## 概要',
  '青崖鎮上唯一的客棧，二層木樓。',
  '',
  '## 規則與邊界',
  '（未交代）',
  '',
  '## 現狀',
  '照常開門。',
].join('\n');

describe('建條目 · 「一句話 / 關鍵詞 / ## 概要」寫，轉寫成 {brief, keywords, body}', () => {
  let entry;

  before(async () => {
    transcripts = [
      JSON.stringify({
        brief: '青崖鎮上唯一的客棧',
        keywords: ['停舟', '客棧'],
        body: '## 概要\n青崖鎮上唯一的客棧，二層木樓。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n照常開門。',
      }),
    ];
    fake.reset();
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project, ['停舟客棧']);
    project.invalidate();
    entry = (await project.listLore()).find((e) => e.title === '停舟客棧');
  });

  test('寫一次、轉一次；寫的提示詞不要 JSON，統稱那一條照舊在', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不寫 JSON') && systemOf(0).includes('一句話：') && systemOf(0).includes('關鍵詞：'), systemOf(0).slice(0, 600));
    assert.match(systemOf(0), /5\. 它是一個統稱/);
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【設定條目 JSON 合同】') && userOf(1).includes('照常開門。'), userOf(1));
  });

  test('確認框報寫 1 次、轉寫 1 次，整理不出來重寫一次', () => {
    const c = lastConfirm();
    assert.ok(c.message.includes('建 1 條設定：預計 2 次呼叫，最多 6 次'), c.message);
    assert.ok(c.call.fixed?.some((x) => x.startsWith('轉寫 · 整理成 JSON')), JSON.stringify(c.call));
  });

  test('照抄的建成條目：一句話、關鍵詞、正文三節', () => {
    assert.ok(entry, '沒建出來');
    assert.equal(entry.brief, '青崖鎮上唯一的客棧');
    assert.ok(entry.keywords.includes('停舟'), JSON.stringify(entry.keywords));
    assert.match(entry.body, /## 概要\n+青崖鎮上唯一的客棧，二層木樓。/);
    assert.match(entry.body, /## 現狀\n+照常開門。/);
  });
});

describe('建條目 · 重轉仍不合格：這一條重寫一次、再轉', () => {
  let entry;

  before(async () => {
    const good = {
      brief: '青崖鎮上唯一的客棧',
      keywords: [],
      body: '## 概要\n青崖鎮上唯一的客棧，二層木樓。\n\n## 規則與邊界\n（未交代）\n\n## 現狀\n照常開門。',
    };
    const reworded = JSON.stringify({ ...good, brief: '鎮口查驗身份用的憑證' });
    transcripts = [reworded, reworded, JSON.stringify(good)];
    fake.reset();
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project, ['過所']);
    project.invalidate();
    entry = (await project.listLore()).find((e) => e.title === '過所');
  });

  test('寫、轉、重轉都不合格之後重寫一次，再轉照抄了就照常建（一共 5 次，沒超過報的 6 次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「鎮口查驗身份用的憑證」'), userOf(2).slice(0, 400));
    assert.ok(!systemOf(3).includes(TRANSCRIBER) && systemOf(3).includes('整理成一條設定條目'), systemOf(3).slice(0, 100));
    assert.ok(entry, '沒建出來');
  });
});

// ---------------------------------------------------------------- 按目錄整理

prose.organize = ['## 新目錄', '文書', '## 搬家', '- 路引 → 文書'].join('\n');

describe('按目錄整理 · 「## 新目錄」「## 搬家」寫，轉寫成搬家清單', () => {
  let plan;

  before(async () => {
    t.write('.novelwarden/lore/路引.md', '---\ntitle: 路引\nkeywords: [路引]\n---\n\n# 路引\n\n出入憑證。\n');
    project.invalidate();
    transcripts = [JSON.stringify({ folders: ['文書'], moves: [{ from: '路引', to: '文書' }] })];
    fake.reset();
    h.expect('開始', '照這樣整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    plan = lastConfirm();
  });

  test('寫一次、轉一次；寫的提示詞不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('不寫 JSON') && systemOf(0).includes('條目路徑 → 要搬去的目錄'), systemOf(0));
    assert.ok(systemOf(1).includes(TRANSCRIBER) && userOf(1).includes('【搬家清單 JSON 合同】') && userOf(1).includes('- 路引 → 文書'), userOf(1));
  });

  test('確認框報寫 1 次、轉寫 1 次', () => {
    const go = h.confirms.find((c) => c.actions.includes('開始'));
    assert.ok(go.message.includes('分 1 批，預計 2 次呼叫，最多 3 次'), go.message);
  });

  test('照抄的清單照常校驗、給作者看、搬', () => {
    assert.match(plan.message, /搬 1 條設定，新建 1 個目錄/);
    assert.ok(!t.has('.novelwarden/lore/路引.md'));
    assert.ok(t.has('.novelwarden/lore/文書/路引.md'));
  });
});
