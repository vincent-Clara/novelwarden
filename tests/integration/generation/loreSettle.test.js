/**
 * 落定設定（完善設定二期，設計稿 §4）：經對話頁從一段討論一路走到落盤。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 落定 | 在細綱層聊完、`/落定設定`：這一輪臨時換到設定目錄，落完回到原來那一章；命令記成「落定設定」 |
 * | 裝配 | 系統提示是落定設定那一份；討論作為多輪訊息帶著；討論裡提到的已有條目整條帶（含暗設，標明讀者還不知道），其餘一行；合同是落定那一份 |
 * | 卡片 | 落到「設定名錄」；會新建、會更新（按磁碟認）、還沒定的都列出來；人名丟掉寫進說明 |
 * | 落盤 | 新的直接建在分類目錄、記作機器寫的、水位 0；已有的關鍵詞只增不減、記作機器寫的、**水位不動**；一律先對比（只有一句話的也是）；問題不寫進任何檔案 |
 * | 放棄 | 覆蓋審閱裡放棄了那一條原樣留著，別的照寫 |
 * | 重來 | 會話已經回到原來的目標，重來一輪照樣換過去再回來 |
 * | 攔下 | 一句都沒聊過、輸入框也空著：不調模型；解析不了：沒有卡片、不寫入、照樣回到原來的目標；一條都沒定下來：沒有卡片，氣泡裡說清 |
 * | 按格式寫、轉寫成 JSON | 2026-10-25 起按小標題寫，轉寫模型照抄成 JSON：轉寫只帶合同與原文，照抄的落盤；只寫了「還沒定的問題」的照樣認成一條都沒定 |
 * | 會話 | 存下的落定草稿讀回來還是落定設定，不是設定清單 |
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

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;
let gates;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const TJG = '.novelwarden/lore/宗門/天機閣.md';
const JCL = '.novelwarden/lore/地域/九層樓.md';
const GS = '.novelwarden/lore/地域/鬼市.md';
const LORE_DIR = { kind: 'setting', doc: 'lore' };
const PLOT3 = { kind: 'plot', plotRelPath: PLOT(3) };
const QUESTION = '鬼市開在哪座城下？';

function entry(title, { keywords = [title], brief = '', body = '', through } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(through !== undefined ? [`updatedThrough: ${through}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function plotText(no, { hash, synopsis = '往下查。', lore = '' } = {}) {
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
    '- 有事發生',
    '',
    '## 設定',
    '',
    lore || '（無）',
    '',
  ].join('\n');
}

const SETTLED = {
  entries: [
    {
      title: '天機閣',
      category: '宗門',
      keywords: ['天機樓', '林昭'],
      brief: '江湖上賣訊息的樓閣',
      body: {
        概要: '作者寫的：七層樓，立在青崖鎮北。',
        规则与边界: '一問一價；問閣主身世的一律不答。',
        现状: '閣主閉關，二當家打理。',
        暗设: '作者寫的：閣主是前朝太子。二當家也知道。',
      },
    },
    { title: '九層樓', category: '地域', keywords: [], brief: '天機閣的藏書樓', body: { 概要: '九層，每層一個守樓人。', 规则与边界: '（未交代）', 现状: '（未交代）', 暗设: '' } },
    { title: '鬼市', category: '地域', keywords: ['夜市'], brief: '城下的夜市', body: { 概要: '子時開張的夜市。', 规则与边界: '只收現銀。', 现状: '（未交代）', 暗设: '鬼市主人是天機閣二當家。' } },
    { title: '阿昭', category: '', keywords: [], brief: '人', body: { 概要: '人。', 规则与边界: '', 现状: '', 暗设: '' } },
  ],
  questions: [QUESTION, '二當家知不知道閣主的身世？'],
};

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

const payload = (over) => ({ text: '', targetNo: 3, attachments: [], excludedIds: [], ...over });

/** 在第 3 章細綱上討論一句（模型答 `reply`）。 */
async function discuss(text, reply) {
  fake.reset([{ text: reply, stop: 'end' }]);
  await controller.handle({ type: 'send', payload: payload({ text, stage: 'plot', capability: 'discuss', target: PLOT3 }) });
}

/** `/落定設定`：模型答 `answer`（字串或一串）。 */
async function settle(answer, text = '') {
  posted.length = 0;
  gates = [];
  h.expect();
  fake.reset((Array.isArray(answer) ? answer : [answer]).map((a) => ({ text: typeof a === 'string' ? a : JSON.stringify(a), stop: 'end' })));
  await controller.handle({ type: 'send', payload: payload({ text, stage: 'setting', capability: 'settle', target: LORE_DIR }) });
  project.invalidate();
  return gates[0];
}

const read = (rel) => t.read(rel);
const listLore = async () => {
  project.invalidate();
  return project.listLore();
};
const toasts = () => posted.filter((m) => m.type === 'toast').map((m) => m.message);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    session: './src/core/model/session.ts',
    generate: './src/core/generation/generate.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'loreSettle', title: '天機錄' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ngenre: 武俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
  t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n江湖訊息都從天機閣買。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒。\n');
  // 作者寫過的：明面、暗設都有，整合到了第 1 章。
  t.write(
    TJG,
    entry('天機閣', {
      keywords: ['天機閣', '閣裡'],
      brief: '賣訊息的樓',
      body: '## 概要\n作者寫的：七層樓。\n\n## 暗設\n作者寫的：閣主是前朝太子。',
      through: 1,
    })
  );
  // 只有一句話（細綱帶出來的空條目）。
  t.write(JCL, entry('九層樓', { brief: '天機閣的藏書樓' }));
  t.write('.novelwarden/lore/宗門/青雲宗.md', entry('青雲宗', { brief: '正道第一宗', body: '## 概要\n劍修。' }));
  fs.mkdirSync(path.join(t.dir, '.novelwarden/lore/地域'), { recursive: true });

  t.write(CH(1), '# 第1章\n\n第1章的正文。\n');
  project.invalidate();
  const chapters = await project.listChapters();
  t.write(PLOT(1), plotText(1, { hash: chapters[0].contentHash, lore: '- 天機閣〔宗門〕：一問一價' }));
  t.write(PLOT(3), plotText(3, { synopsis: '林昭夜入九層樓。' }));
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
  await controller.handle({ type: 'setTarget', target: PLOT3 });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('攔下：一句都沒聊過', () => {
  test('輸入框也空著：不調模型、不記一輪，說清為什麼', async () => {
    const before0 = controller.current.turns.length;
    await settle(SETTLED);
    assert.equal(fake.callCount(), 0);
    assert.equal(controller.current.turns.length, before0);
    assert.ok(toasts().some((m) => m.includes('這個對話裡還沒有討論')), toasts().join('|'));
    assert.deepEqual(controller.current.target, PLOT3);
  });
});

describe('落定', () => {
  let gate;
  let built;
  before(async () => {
    await discuss('天機閣要立規矩：一問一價，問閣主身世的不答。再加一個鬼市，子時開張。', '好的。天機閣的閣規就這麼定；鬼市只收現銀。');
    gate = await settle(SETTLED);
    built = fake.calls[0];
  });

  test('一次呼叫；命令記成「落定設定」；落完回到第 3 章的細綱', () => {
    assert.equal(fake.callCount(), 1);
    const userTurn = controller.current.turns.filter((x) => x.role === 'user').at(-1);
    assert.equal(userTurn.command, '落定設定');
    assert.equal(userTurn.settleLore, true);
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
    assert.equal(controller.current.capability, 'discuss');
    const sessions = posted.filter((m) => m.type === 'session');
    assert.deepEqual(sessions.at(-1).session.target, PLOT3);
  });

  test('裝配：系統提示是落定設定那一份；討論作為多輪訊息帶著', () => {
    const system = built[0].content;
    assert.ok(system.includes('這一次只把討論裡已經定下來的設定落成條目'), system.slice(0, 300));
    assert.ok(!system.includes('你和作者剛討論完這一章'), system);
    assert.ok(built.some((m) => m.role === 'user' && m.content.startsWith('天機閣要立規矩')), JSON.stringify(built.map((m) => m.role)));
    assert.ok(built.some((m) => m.role === 'assistant' && m.content.includes('鬼市只收現銀')));
  });

  test('裝配：討論裡提到的已有條目整條帶（含暗設），沒提到的一行；合同是落定那一份', () => {
    const user = built[built.length - 1].content;
    assert.ok(user.includes('作者寫的：七層樓。'), user.slice(0, 2000));
    assert.ok(user.includes('暗設（讀者還不知道）') && user.includes('作者寫的：閣主是前朝太子。'), user.slice(0, 2000));
    assert.ok(user.includes('- 青雲宗〔宗門〕：正道第一宗'), user.slice(0, 2000));
    // 2026-10-25 起按小標題寫，不寫 JSON（JSON 合同挪給轉寫那一步）。
    assert.ok(user.includes('【落定格式】') && user.includes('不寫 JSON') && !user.includes('{"entries"'), user.slice(-1500));
    assert.ok(!user.includes('【設定清單格式】'));
  });

  test('裝配明細：命中的來源寫的是「討論裡提到」', () => {
    const turn = controller.current.turns.filter((x) => x.role === 'assistant').at(-1);
    const item = turn.context.items.find((i) => i.label === '設定 · 天機閣');
    assert.equal(item.status, 'included');
    assert.ok(item.note.includes('討論裡提到「天機閣」'), item.note);
  });

  test('卡片：落到設定名錄；會新建、會更新、還沒定的都列出來；人名丟掉寫進說明', () => {
    assert.ok(gate, toasts().join('|'));
    assert.ok(gate.title.includes('「設定名錄」') && gate.title.includes('寫入'), gate.title);
    assert.ok(gate.detail.includes('落定設定 · 3 條（改已有的 2 條）'), gate.detail);
    assert.ok(gate.detail.includes('會新建設定條目：鬼市'), gate.detail);
    assert.ok(gate.detail.includes('會更新設定條目：天機閣、九層樓'), gate.detail);
    assert.ok(gate.detail.includes('還沒定的') && gate.detail.includes(`1. ${QUESTION}`), gate.detail);
    assert.ok(gate.detail.includes('「阿昭」是角色卡上的人'), gate.detail);
  });

  test('已有的一律先對比：寫過內容的、只有一句話的都是', () => {
    assert.deepEqual(h.reviewed.map((r) => r.relPath), [TJG, JCL]);
    assert.deepEqual(h.reviewed.map((r) => r.name), ['設定「天機閣」', '設定「九層樓」']);
  });

  test('新的：建在分類目錄，記作機器寫的，水位 0', async () => {
    const e = (await listLore()).find((x) => x.relPath === GS);
    assert.ok(e, (await listLore()).map((x) => x.relPath).join(','));
    assert.equal(e.title, '鬼市');
    assert.deepEqual(e.keywords, ['鬼市', '夜市']);
    assert.equal(e.brief, '城下的夜市');
    assert.ok(e.body.includes('子時開張的夜市。') && e.body.endsWith('## 暗設\n鬼市主人是天機閣二當家。'), e.body);
    assert.equal(e.updatedThrough, 0);
    assert.ok(bundle.lore.loreOwnedByMachine(e));
  });

  test('已有的：正文換成合併後的，關鍵詞只增不減（人名不收），記作機器寫的，水位不動', async () => {
    const e = (await listLore()).find((x) => x.relPath === TJG);
    assert.equal(e.brief, '江湖上賣訊息的樓閣');
    assert.deepEqual(e.keywords, ['天機閣', '閣裡', '天機樓']);
    assert.ok(e.body.includes('一問一價；問閣主身世的一律不答。') && e.body.includes('二當家也知道。'), e.body);
    assert.equal(e.updatedThrough, 1);
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    const j = (await listLore()).find((x) => x.relPath === JCL);
    assert.ok(j.body.includes('九層，每層一個守樓人。'), j.body);
    assert.equal(j.updatedThrough, undefined);
    assert.ok(!(await listLore()).some((x) => x.title === '阿昭'));
  });

  test('還沒定的問題不寫進任何工程檔案', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const hits = walk(path.join(t.dir, '.novelwarden'))
      .filter((f) => !f.includes(`${path.sep}sessions${path.sep}`) && !f.endsWith('.db') && !f.includes(`${path.sep}.history${path.sep}`))
      .filter((f) => fs.readFileSync(f, 'utf8').includes(QUESTION));
    assert.deepEqual(hits, []);
  });

  test('toast 說清建了哪幾條、更新了哪幾條', () => {
    assert.ok(toasts().some((m) => m.includes('落定設定：新建 1 條設定條目（鬼市），更新 天機閣、九層樓')), toasts().join('|'));
  });
});

describe('放棄與重來', () => {
  after(() => h.setReviewVerdict('apply'));

  test('覆蓋審閱裡放棄了那一條原樣留著，別的照寫', async () => {
    const before1 = read(TJG);
    h.setReviewVerdict('discard');
    await settle({
      entries: [
        { ...SETTLED.entries[0], body: { ...SETTLED.entries[0].body, 现状: '天機閣被燒了。' } },
        { title: '黑水渡', category: '地域', keywords: [], brief: '鬼市的渡口', body: { 概要: '渡口。', 规则与边界: '', 现状: '', 暗设: '' } },
      ],
      questions: [],
    }, '再定一個黑水渡');
    assert.equal(read(TJG), before1);
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden/lore/地域/黑水渡.md')));
    assert.ok(toasts().some((m) => m.includes('保留原樣的 天機閣')), toasts().join('|'));
  });

  test('重來：會話已經回到第 3 章，照樣換到設定目錄跑一輪，再回來', async () => {
    const userTurn = controller.current.turns.filter((x) => x.role === 'user').at(-1);
    assert.equal(userTurn.settleLore, true);
    assert.deepEqual(controller.current.target, PLOT3);
    gates = [];
    h.expect();
    fake.reset([{ text: JSON.stringify({ entries: [], questions: [] }), stop: 'end' }]);
    await controller.handle({ type: 'retry', turnId: userTurn.id, payload: payload({ stage: 'plot', capability: 'discuss', target: PLOT3 }) });
    assert.equal(fake.callCount(), 1);
    assert.ok(fake.calls[0][0].content.includes('這一次只把討論裡已經定下來的設定落成條目'));
    assert.deepEqual(controller.current.target, PLOT3);
    assert.equal(controller.current.stage, 'plot');
  });
});

describe('攔下：解析不了、一條都沒定', () => {
  test('解析不了：沒有卡片、不寫入、失敗說清；照樣回到原來的目標', async () => {
    const before2 = read(TJG);
    const gate = await settle('我覺得天機閣還可以再想想……');
    assert.equal(gate, undefined);
    assert.equal(read(TJG), before2);
    const turn = controller.current.turns.at(-1);
    assert.ok(turn.error && turn.error.includes('落定設定解析不出來'), turn.error);
    assert.deepEqual(controller.current.target, PLOT3);
  });

  // 2026-10-25 起語法修復那一次換成轉寫：壞了語法的 JSON 交給轉寫理順，照抄的收下。
  test('JSON 語法壞了交給轉寫理順：一共 2 次', async () => {
    const broken = '{"entries":[{"title":"亂葬崗","category":"地域","keywords":[],"brief":"城外" "body":{"概要":"城外的墳地。"}}],"questions":[]}';
    const fixed = '{"entries":[{"title":"亂葬崗","category":"地域","keywords":[],"brief":"城外", "body":{"概要":"城外的墳地。"}}],"questions":[]}';
    const gate = await settle([broken, fixed]);
    assert.equal(fake.callCount(), 2);
    assert.ok(fake.calls[1][0].content.includes('格式轉寫員'), fake.calls[1][0].content);
    assert.ok(gate.detail.includes('一共調了 2 次模型'), gate.detail);
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden/lore/地域/亂葬崗.md')));
  });

  test('一條都沒定下來：沒有卡片、不算失敗，氣泡裡說清並列出還沒定的', async () => {
    const gate = await settle({ entries: [], questions: [QUESTION] });
    assert.equal(gate, undefined);
    const turn = controller.current.turns.at(-1);
    assert.equal(turn.error, undefined);
    assert.ok(turn.content.startsWith('討論裡還沒有定下來的設定') && turn.content.includes(`1. ${QUESTION}`), turn.content);
    assert.equal(turn.artifact, undefined);
  });
});

// 2026-10-25 起按小標題寫，轉寫模型照抄成 JSON（features/transcribe.ts）。
describe('按格式寫、轉寫成 JSON', () => {
  const PROSE = [
    '## 亂石灘',
    '### 分類',
    '地域',
    '### 關鍵詞',
    '石灘',
    '### 一句話',
    '城南河邊的亂石灘',
    '### 概要',
    '城南河邊的一片亂石灘，夜裡有人在這裡交易。',
    '### 規則與邊界',
    '只認銅錢，不認銀票。',
    '### 現狀',
    '（未交代）',
    '### 暗設',
    '無',
    '## 還沒定的問題',
    `- ${QUESTION}`,
  ].join('\n');
  const COPIED = {
    entries: [
      {
        title: '亂石灘',
        category: '地域',
        keywords: ['石灘'],
        brief: '城南河邊的亂石灘',
        body: { 概要: '城南河邊的一片亂石灘，夜裡有人在這裡交易。', 规则与边界: '只認銅錢，不認銀票。', 现状: '（未交代）', 暗设: '無' },
      },
    ],
    questions: [QUESTION],
  };

  test('寫一次、轉一次：轉寫只帶合同與原文，照抄的落盤', async () => {
    h.setReviewVerdict('apply');
    const gate = await settle([PROSE, COPIED]);
    assert.equal(fake.callCount(), 2);
    const system = fake.calls[1][0].content;
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(system.includes('格式轉寫員'), system);
    assert.ok(user.includes('【落定設定 JSON 合同】') && user.includes('【原文】') && user.includes('只認銅錢，不認銀票。'), user);
    assert.ok(!user.includes('作者寫的：七層樓。'), user);
    assert.ok(gate, JSON.stringify(toasts()));
    assert.ok(gate.detail.includes(QUESTION), gate.detail);
    const made = (await listLore()).find((e) => e.title === '亂石灘');
    assert.ok(made && made.body.includes('只認銅錢，不認銀票。'), JSON.stringify(made));
  });

  test('只寫了「還沒定的問題」：照樣認成一條都沒定，氣泡裡說清', async () => {
    const gate = await settle([`## 還沒定的問題\n- ${QUESTION}`, { entries: [], questions: [QUESTION] }]);
    assert.equal(gate, undefined);
    assert.equal(fake.callCount(), 2);
    const turn = controller.current.turns.at(-1);
    assert.equal(turn.error, undefined);
    assert.ok(turn.content.startsWith('討論裡還沒有定下來的設定') && turn.content.includes(`1. ${QUESTION}`), turn.content);
  });
});

describe('會話', () => {
  test('存下的落定草稿讀回來還是落定設定，不是設定清單', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: LORE_DIR });
    session.stage = 'setting';
    session.capability = 'settle';
    session.drafts = [
      { id: 'd1', action: { stage: 'setting', capability: 'settle' }, target: LORE_DIR, raw: '{}', words: 0, createdAt: new Date().toISOString() },
    ];
    await store.write(session);
    const back = await store.read(session.id);
    assert.equal(back.capability, 'settle');
    assert.deepEqual(back.drafts[0].action, { stage: 'setting', capability: 'settle' });
    const art = bundle.generate.parseDraftArtifact(back.drafts[0].action, JSON.stringify(SETTLED), back.drafts[0].target);
    assert.equal(art.kind, 'loreEntries');
    assert.equal(art.settle, true);
  });

  test('別的架構檔案上記著 settle 的會話讀回來是討論', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: { kind: 'setting', doc: 'world' } });
    session.stage = 'setting';
    session.capability = 'settle';
    await store.write(session);
    assert.equal((await store.read(session.id)).capability, 'discuss');
  });
});
