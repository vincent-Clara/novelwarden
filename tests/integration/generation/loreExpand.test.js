/**
 * 展開一條設定（完善設定，2026-10-19，設計稿 §1、§3）：經對話頁從裝配一路走到落盤。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 原料 | views/loreMaterial.ts：計劃只認沒定稿的細綱（「設定」一節按名錄同一張表認，關鍵詞也算），記錄只認定稿過的；水位停在第一處沒定稿的章之前；路徑上沒有檔案時按路徑拼一條空的 |
 * | 裝配 | 這一條整份帶（含暗設，標明讀者還不知道）；已排細綱裡用到它的那幾句與定稿過的記錄帶章號；相關條目去掉它自己，關鍵詞命中的整條、同目錄的一行；不按正文「整理」；合同是展開那一份，不是設定清單 |
 * | 原料封頂 | 計劃與定稿記錄合計封頂，放不下的寫進明細（第 2 條） |
 * | 只有一句話的直接寫 | 右鍵「展開…」先問要求再發一輪生成；卡片列出會建的子條目與還沒定的問題；正文、一句話換新，關鍵詞只增不減，記作機器寫的，水位同整合；子條目建空條目；問題不寫進任何檔案 |
 * | 作者寫過的先對比 | 有內容（含只寫了暗設）的走覆蓋審閱；放棄了一個字不動、子條目也不建 |
 * | 只給名字 | 先在分類目錄下建空條目再展開；是人名就報錯、不問不建；取消就什麼都不做 |
 * | 路徑上還沒有檔案 | 按路徑新建、標題取檔名；是人名的不建 |
 * | 解析不了 | 沒有卡片、不寫入、失敗掛在這一條上；語法壞了交給轉寫理順（共 2 次） |
 * | 按格式寫、轉寫成 JSON | 2026-10-25 起按小標題寫，轉寫模型照抄成 JSON：轉寫只帶合同與原文；兩次都改字就不給寫入，原文留在氣泡裡 |
 * | 單章細綱建空條目 | `isNew` 的新設定隨單章細綱建空條目，卡片上先列出來（§3） |
 * | 會話 | 存下的草稿目標讀回來還是這一條，不是整批設定清單 |
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
const CJG = '.novelwarden/lore/宗門/藏經閣.md';

function plotText(no, { hash, synopsis = '往下查。', events = '- 有事發生', facts = '', lore = '' } = {}) {
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
    '## 連續性事實',
    '',
    facts || '（待補充）',
    '',
    '## 設定',
    '',
    lore || '（無）',
    '',
  ].join('\n');
}

function entry(title, { keywords = [title], brief = '', body = '' } = {}) {
  return ['---', `title: ${title}`, `keywords: [${keywords.join(', ')}]`, ...(brief ? [`brief: ${brief}`] : []), '---', '', `# ${title}`, '', body, ''].join('\n');
}

const EXPANSION = {
  brief: '江湖上賣訊息的樓閣',
  keywords: ['天機樓', '林昭', '閣規'],
  body: {
    概要: '一座賣訊息的七層樓，立在青崖鎮北。',
    规则与边界: '一問一價，不問來者；問到閣主身世的，一律不答。',
    现状: '閣主閉關，由二當家打理。',
    暗设: '閣主是前朝太子，樓下密道通往皇陵。',
  },
  children: [
    { name: '閣規', category: '制度', brief: '天機閣的十條規矩' },
    { name: '青雲宗', category: '宗門', brief: '已有條目' },
    { name: '林昭', category: '', brief: '人' },
  ],
  questions: ['閣規是成文的還是口傳的？', '二當家知不知道閣主的身世？'],
};
const QUESTION = '二當家知不知道閣主的身世？';

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

/**
 * 右鍵「展開…」：`answers` 是問要求那一句的回答（undefined = 取消）。答了要求，接著的確認框預設點「開始展開」；
 * 要測確認框的另傳 `confirm`（undefined = 取消，`{ action, choice }` = 換了模型）。
 */
async function expand(msg, ...answers) {
  const [ask] = answers;
  const confirm = answers.length > 1 ? answers[1] : '開始展開';
  posted.length = 0;
  gates = [];
  h.expect(...(answers.length === 0 ? [] : ask === undefined ? [undefined] : [ask, confirm]));
  await controller.handle({ type: 'expandLore', ...msg });
  project.invalidate();
  return gates[0];
}

const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const systemOf = (i) => fake.calls[i][0].content;
const read = (rel) => t.read(rel);
const listLore = async () => {
  project.invalidate();
  return project.listLore();
};

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    builder: './src/core/context/builder.ts',
    session: './src/core/model/session.ts',
    lore: './src/core/features/lore.ts',
    material: './src/core/views/loreMaterial.ts',
    fs: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  // 多配一個 strong：確認框上為這一輪換它。對話頁選定的（`models` 首項）仍是 m。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'strong', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'loreExpand', title: '天機錄' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ngenre: 武俠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小說配置\n\n## 核心梗概\n\n林昭查舊案。\n');
  t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n江湖訊息都從天機閣買。\n');
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒。\n');
  // 只有一句話（細綱帶出來的空條目）。
  t.write(TJG, entry('天機閣', { keywords: ['天機閣', '閣裡'], brief: '賣訊息的樓' }));
  // 作者寫過的：明面一句、暗設一句。
  t.write(CJG, entry('藏經閣', { brief: '青雲宗藏書處', body: '## 概要\n作者寫的：藏書三萬卷。\n\n## 暗設\n作者寫的：底層藏著魔功。' }));
  t.write('.novelwarden/lore/宗門/青雲宗.md', entry('青雲宗', { brief: '正道第一宗', body: '劍修。' }));
  t.write('.novelwarden/lore/地域/九層樓.md', entry('九層樓', { brief: '天機閣的藏書樓', body: '九層，每層一個守樓人。' }));
  t.write('.novelwarden/lore/地域/後山.md', entry('後山', { brief: '後山禁地', body: '有陣法。' }));
  t.write('.novelwarden/lore/秘藥.md', entry('秘藥', { brief: '只寫了暗設', body: '## 暗設\n作者寫的：秘藥是毒。' }));
  fs.mkdirSync(path.join(t.dir, '.novelwarden/lore/制度'), { recursive: true });

  for (let no = 1; no <= 2; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  const hashOf = (no) => chapters.find((c) => c.order === no).contentHash;
  t.write(PLOT(1), plotText(1, { hash: hashOf(1), lore: '- 天機閣〔宗門〕：一問一價', facts: '- 林昭在天機閣買了第一條訊息' }));
  t.write(PLOT(2), plotText(2, { hash: hashOf(2), events: '- 林昭再去天機閣，被拒之門外。' }));
  // 沒定稿（還沒寫正文）的計劃：展開要為它服務。
  t.write(
    PLOT(3),
    plotText(3, {
      synopsis: '林昭夜入天機閣，直奔九層樓。',
      events: '- 林昭在九層樓下見到二當家。\n- 二當家要價一條命。',
      lore: '- 天機閣〔宗門〕：林昭在此買閣主的訊息\n- 九層樓〔地域〕',
    })
  );
  project.invalidate();
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

const config = () => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  contextDetail: 3,
});

function build(relPath, extra = {}) {
  return bundle.builder.buildContext(
    project,
    { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'lore', relPath }, ask: '', targetNo: 1, ...extra },
    config()
  );
}

describe('原料（views/loreMaterial）', () => {
  test('計劃：沒定稿的細綱裡「設定」一節點名它的（寫的是關鍵詞也算）與提到它的句子；記錄：只認定稿過的', async () => {
    t.write(PLOT(6), plotText(6, { synopsis: '沒有提到。', lore: '- 閣裡：二當家坐鎮' }));
    project.invalidate();
    try {
      const { entry } = await bundle.material.loreEntryAt(project, TJG);
      const { uses, records } = await bundle.material.expansionMaterial(project, entry);
      assert.deepEqual(
        uses.map((u) => [u.no, u.where, u.text]),
        [
          [3, '设定', '天機閣：林昭在此買閣主的訊息'],
          [3, '梗概', '林昭夜入天機閣，直奔九層樓。'],
          [6, '设定', '閣裡：二當家坐鎮'],
        ]
      );
      assert.deepEqual(records.map((f) => [f.no, f.text]), [
        [1, '一問一價'],
        [1, '林昭在天機閣買了第一條訊息'],
        [2, '林昭再去天機閣，被拒之門外。'],
      ]);
    } finally {
      fs.rmSync(path.join(t.dir, PLOT(6)));
      project.invalidate();
    }
  });

  test('水位停在第一處沒定稿的章之前；路徑上沒有檔案時按路徑拼一條空的', async () => {
    assert.equal(await bundle.material.integrationWatermark(project), 2);
    const missing = await bundle.material.loreEntryAt(project, '.novelwarden/lore/地域/鬼門關.md');
    assert.equal(missing.exists, false);
    assert.equal(missing.entry.title, '鬼門關');
    assert.equal(missing.entry.category, '地域');
    assert.equal(missing.entry.body, '');
  });
});

describe('裝配', () => {
  let b;
  let user;
  before(async () => {
    b = await build(TJG);
    user = b.messages[b.messages.length - 1].content;
  });

  test('系統提示與合同是展開那一份，不借設定清單、不按正文「整理」', () => {
    assert.ok(b.messages[0].content.includes('這一次只管一條設定：把它往前想細'), b.messages[0].content.slice(0, 300));
    // 2026-10-25 起按小標題寫，不寫 JSON（JSON 合同挪給轉寫那一步）。
    assert.ok(user.includes('【展開格式】') && user.includes('不寫 JSON') && !user.includes('{"brief"'), user.slice(-1500));
    assert.ok(user.includes('2–5 條還沒定、要作者拍板的問題'));
    assert.ok(!user.includes('【設定清單格式】') && !user.includes('# 已寫正文'), user.slice(-3000));
    assert.ok(!b.messages[0].content.includes('不補完、不推測'));
  });

  test('這一條整份帶：一句話、關鍵詞、還只有一句話的說明', () => {
    const self = b.items.find((i) => i.kind === 'loreSelf');
    assert.equal(self.status, 'included');
    assert.equal(self.source, TJG);
    assert.ok(self.text.includes('【天機閣〔宗門〕】') && self.text.includes('一句話：賣訊息的樓') && self.text.includes('關鍵詞：天機閣、閣裡'), self.text);
    assert.ok(self.note.includes('還只有一句話'), self.note);
    assert.ok(user.includes('# 當前這一條設定'), user.slice(-3000));
  });

  test('已排細綱裡用到它的地方：「設定」一節那一行與提到它的句子，帶章號；定稿過的不算計劃', () => {
    const plan = b.items.find((i) => i.kind === 'lorePlan');
    assert.ok(plan.text.includes('第 3 章《第3章》（設定）：天機閣：林昭在此買閣主的訊息'), plan.text);
    assert.ok(plan.text.includes('第 3 章《第3章》（梗概）：林昭夜入天機閣，直奔九層樓。'), plan.text);
    assert.ok(!plan.text.includes('二當家要價一條命'), plan.text);
    assert.ok(!plan.text.includes('第 2 章'), plan.text);
    assert.ok(user.includes('# 已排細綱裡用到它的地方'));
  });

  test('定稿過的記錄：「設定」一節那一句、連續性事實、提到它的句子，帶章號', () => {
    const rec = b.items.find((i) => i.kind === 'loreRecord');
    assert.ok(rec.text.includes('- 第 1 章：一問一價'), rec.text);
    assert.ok(rec.text.includes('- 第 1 章：林昭在天機閣買了第一條訊息'), rec.text);
    assert.ok(rec.text.includes('- 第 2 章：林昭再去天機閣，被拒之門外。'), rec.text);
    assert.ok(user.includes('# 定稿過的記錄（已經寫進正文的事實，不能推翻）'));
  });

  test('相關條目：不帶它自己；用到它的句子裡提到的整條帶；同目錄的一行帶；不相干的不帶；給分類表', () => {
    const lore = b.items.filter((i) => i.kind === 'lore');
    const by = (title) => lore.find((i) => i.label === `設定 · ${title}`);
    assert.equal(by('天機閣'), undefined);
    assert.ok(by('九層樓').text.includes('九層，每層一個守樓人。'), by('九層樓').text);
    assert.ok(by('九層樓').note.includes('上下文中出現「九層樓」'), by('九層樓').note);
    assert.equal(by('青雲宗').text, '- 青雲宗〔宗門〕：正道第一宗');
    assert.equal(by('藏經閣').text, '- 藏經閣〔宗門〕：青雲宗藏書處');
    assert.equal(by('後山'), undefined);
    assert.ok(lore.some((i) => i.id === 'lore:categories'));
  });

  test('作者寫過暗設的：暗設整份帶、標明讀者還不知道', async () => {
    const b2 = await build(CJG);
    const self = b2.items.find((i) => i.kind === 'loreSelf');
    assert.ok(self.text.includes('作者寫的：藏書三萬卷。') && self.text.includes('作者寫的：底層藏著魔功。'), self.text);
    assert.ok(self.text.includes('暗設（讀者還不知道）'), self.text);
    assert.equal(self.note, undefined);
  });

  test('目標不是單條設定時那兩層什麼都不帶', async () => {
    const b3 = await bundle.builder.buildContext(
      project,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' },
      config()
    );
    assert.ok(!b3.items.some((i) => ['loreSelf', 'lorePlan', 'loreRecord'].includes(i.kind)));
  });
});

describe('原料封頂', () => {
  test('計劃超了封頂只帶前幾行，寫明帶到第幾章（第 2 條）', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `- 林昭第 ${i + 1} 次在天機閣打聽那樁舊案，二當家照例只收一半的價錢。`).join('\n');
    t.write(PLOT(4), plotText(4, { events: long }));
    project.invalidate();
    try {
      const b = await build(TJG);
      const plan = b.items.find((i) => i.kind === 'lorePlan');
      assert.equal(plan.status, 'degraded');
      assert.ok(/計劃與同步記錄合計封頂 6000 token，只帶了前 \d+ 行（到第 \d 章），第 4 章起的沒帶/.test(plan.note), plan.note);
      assert.ok(plan.text.includes('第 3 章《第3章》（設定）'), plan.text.slice(0, 200));
      const rec = b.items.find((i) => i.kind === 'loreRecord');
      assert.equal(rec.status, 'included');
    } finally {
      fs.rmSync(path.join(t.dir, PLOT(4)));
      project.invalidate();
    }
  });
});

describe('只有一句話的：直接寫', () => {
  let gate;
  let before1;
  before(async () => {
    fake.reset([{ text: JSON.stringify(EXPANSION), stop: 'end' }]);
    before1 = read(TJG);
    gate = await expand({ relPath: TJG }, '閣規要嚴一些');
  });

  test('先問一句要求（報呼叫次數），再發一輪生成：1 次，作者的話進上下文', () => {
    assert.equal(h.inputs.length, 1);
    assert.ok(h.inputs[0].title.includes('天機閣') && h.inputs[0].prompt.includes('預計 2 次呼叫，最多 3 次'), JSON.stringify(h.inputs[0]));
    assert.equal(fake.callCount(), 1);
    assert.ok(userOf(0).includes('閣規要嚴一些'));
    assert.ok(systemOf(0).includes('把它往前想細'));
  });

  test('問完要求再彈確認框：報次數，模型預設是對話頁那個，帶詳細度下拉框', () => {
    assert.equal(h.confirms.length, 1);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['開始展開']);
    assert.ok(c.message.includes('展開設定「天機閣」') && c.message.includes('預計 2 次呼叫，最多 3 次'), c.message);
    assert.equal(c.call.model, 'p/m');
    // 轉寫不跟這一次挑的模型：單列一行（2026-10-25 起）。
    assert.ok(c.call.fixed?.some((line) => line.includes('轉寫')), JSON.stringify(c.call));
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
    assert.equal(fake.calls[0].ref, 'p/m');
  });

  test('對話頁的目標換成這一條，命令記成「展開這條設定」', () => {
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: TJG });
    assert.equal(controller.current.stage, 'setting');
    const userTurn = controller.current.turns.find((x) => x.role === 'user');
    assert.equal(userTurn.command, '展開這條設定');
  });

  test('卡片：形狀、會新建的子條目（已有的、人名丟掉）、還沒定的問題；不說會覆蓋', () => {
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.title.includes('設定 · 天機閣') && gate.title.includes('寫入'), gate.title);
    assert.ok(gate.detail.includes('設定 · 天機閣 · 展開 3/3 節 + 暗設 · 拆出 1 條 · 還沒定的 2 問'), gate.detail);
    assert.ok(gate.detail.includes('會新建設定條目：閣規'), gate.detail);
    assert.ok(gate.detail.includes(`還沒定的`) && gate.detail.includes(`2. ${QUESTION}`), gate.detail);
    assert.ok(gate.detail.includes('「青雲宗」已經有條目了') && gate.detail.includes('「林昭」是角色卡上的人'), gate.detail);
    assert.ok(!gate.detail.includes('那裡已經有內容了'), gate.detail);
  });

  test('沒走覆蓋審閱（原來只有一句話）', () => {
    assert.equal(h.reviewed.length, 0);
    assert.notEqual(read(TJG), before1);
  });

  test('正文與一句話換新；關鍵詞只增不減，人名、子條目不收；記作機器寫的；水位同整合', async () => {
    const e = (await listLore()).find((x) => x.relPath === TJG);
    assert.equal(e.brief, '江湖上賣訊息的樓閣');
    assert.deepEqual(e.keywords, ['天機閣', '閣裡', '天機樓']);
    assert.ok(e.body.startsWith('## 概要\n一座賣訊息的七層樓'), e.body);
    assert.ok(e.body.endsWith('## 暗設\n閣主是前朝太子，樓下密道通往皇陵。'), e.body);
    assert.ok(bundle.lore.loreOwnedByMachine(e));
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    assert.equal(e.updatedThrough, 2);
  });

  test('子條目建成空條目，放在分類目錄裡', async () => {
    const child = (await listLore()).find((x) => x.title === '閣規');
    assert.equal(child.relPath, '.novelwarden/lore/制度/閣規.md');
    assert.equal(child.brief, '天機閣的十條規矩');
    assert.deepEqual(child.keywords, ['閣規']);
    assert.equal(child.body.trim(), '');
    assert.equal((await listLore()).filter((x) => x.title === '青雲宗').length, 1);
  });

  test('還沒定的問題不寫進任何工程檔案', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const hits = walk(path.join(t.dir, '.novelwarden'))
      .filter((f) => !f.includes(`${path.sep}sessions${path.sep}`) && !f.endsWith('.db') && !f.includes(`${path.sep}.history${path.sep}`))
      .filter((f) => fs.readFileSync(f, 'utf8').includes(QUESTION));
    assert.deepEqual(hits, []);
  });

  test('toast 說清展開了哪一條、建了哪幾條', () => {
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('已展開設定「天機閣」') && m.includes('閣規')), toasts.join('|'));
  });
});

describe('作者寫過的：先對比', () => {
  let before2;
  after(() => h.setReviewVerdict('apply'));

  test('有內容的走覆蓋審閱；放棄了一個字不動，子條目也不建', async () => {
    before2 = read(CJG);
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [{ name: '魔功', category: '功法', brief: '藏在底層的功法' }] }), stop: 'end' }]);
    h.setReviewVerdict('discard');
    const gate = await expand({ relPath: CJG }, '');
    assert.ok(gate.detail.includes('那裡已經有內容了'), gate.detail);
    assert.ok(gate.title.includes('覆蓋'), gate.title);
    assert.deepEqual(h.reviewed.map((r) => r.relPath), [CJG]);
    assert.equal(h.reviewed[0].name, '設定「藏經閣」');
    assert.equal(read(CJG), before2);
    assert.ok(!(await listLore()).some((x) => x.title === '魔功'));
  });

  test('採納了才寫，覆蓋審閱裡看得到原來的內容', async () => {
    h.setReviewVerdict('apply');
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ relPath: CJG }, '');
    assert.equal(h.reviewed.length, 1);
    assert.ok(h.reviewed[0].current.includes('作者寫的：藏書三萬卷。'));
    assert.ok(read(CJG).includes('一座賣訊息的七層樓'));
  });

  // 明面是空的，但作者寫過暗設：直接寫會吞掉那一句，所以也先對比。
  test('只寫了暗設的也先對比', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    const gate = await expand({ relPath: '.novelwarden/lore/秘藥.md' }, '');
    assert.ok(gate.detail.includes('那裡已經有內容了'), gate.detail);
    assert.deepEqual(h.reviewed.map((r) => r.relPath), ['.novelwarden/lore/秘藥.md']);
  });

  // 條目早就整合到了更後面（之後前面某章正文又改過、整合水位停在了那裡）：展開不能把它拉回去，
  // 不然已經並進條目的那些章又掛上 ＋N。
  test('水位只往前推不往回退', async () => {
    const QYZ = '.novelwarden/lore/宗門/青雲宗.md';
    const text = read(QYZ).replace('title: 青雲宗\n', 'title: 青雲宗\nupdatedThrough: 9\n');
    t.write(QYZ, text);
    project.invalidate();
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ relPath: QYZ }, '');
    const e = (await listLore()).find((x) => x.relPath === QYZ);
    assert.equal(e.updatedThrough, 9);
  });
});

describe('只給名字', () => {
  test('先在分類目錄下建空條目再展開', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '暗河', category: '地域' }, '');
    const e = (await listLore()).find((x) => x.title === '暗河');
    assert.equal(e.relPath, '.novelwarden/lore/地域/暗河.md');
    assert.ok(e.body.includes('一座賣訊息的七層樓'));
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: '.novelwarden/lore/地域/暗河.md' });
    assert.ok(h.inputs[0].prompt.includes('會先建一條空條目'), h.inputs[0].prompt);
  });

  test('名字已被已有條目（關鍵詞）佔了就展開那一條', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '閣裡', category: '地域' }, '');
    assert.deepEqual(controller.current.target, { kind: 'lore', relPath: TJG });
    assert.ok(!(await listLore()).some((x) => x.title === '閣裡'));
  });

  test('是人名就報錯：不問、不建、不調模型', async () => {
    fake.reset([]);
    await expand({ name: '阿昭', category: '地域' });
    assert.equal(h.inputs.length, 0);
    assert.equal(fake.callCount(), 0);
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('人不是設定')), toasts.join('|'));
    assert.ok(!(await listLore()).some((x) => x.title === '阿昭'));
  });

  test('取消就什麼都不做：不建空條目、不調模型', async () => {
    fake.reset([]);
    await expand({ name: '鬼市', category: '地域' }, undefined);
    assert.equal(h.inputs.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!(await listLore()).some((x) => x.title === '鬼市'));
  });

  // 確認框問在建空條目之前：在那裡取消也不留空條目。
  test('寫了要求、在確認框上取消：同樣不建空條目、不調模型', async () => {
    fake.reset([]);
    await expand({ name: '鬼市', category: '地域' }, '多寫些規矩', undefined);
    assert.equal(h.confirms.length, 1);
    assert.equal(fake.callCount(), 0);
    assert.ok(!(await listLore()).some((x) => x.title === '鬼市'));
  });
});

describe('路徑上還沒有檔案（MCP 給了一條新路徑）', () => {
  async function sendTo(relPath) {
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await controller.handle({
      type: 'send',
      payload: { text: '', targetNo: 1, attachments: [], excludedIds: [], stage: 'setting', capability: 'generate', target: { kind: 'lore', relPath } },
    });
    project.invalidate();
    return gates[0];
  }

  test('按這個路徑新建，標題取檔名，記作機器寫的', async () => {
    const gate = await sendTo('.novelwarden/lore/地域/鬼門關.md');
    assert.ok(!gate.detail.includes('那裡已經有內容了'), gate.detail);
    const e = (await listLore()).find((x) => x.relPath === '.novelwarden/lore/地域/鬼門關.md');
    assert.equal(e.title, '鬼門關');
    assert.equal(e.keywords[0], '鬼門關');
    assert.ok(bundle.lore.loreOwnedByMachine(e));
  });

  test('檔名是角色卡上的人就不建', async () => {
    await sendTo('.novelwarden/lore/林昭.md');
    assert.ok(!fs.existsSync(path.join(t.dir, '.novelwarden/lore/林昭.md')));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('「林昭」是角色卡上的人')), toasts.join('|'));
  });
});

describe('解析不了', () => {
  test('沒有卡片、不寫入；失敗掛在這一條上', async () => {
    const before3 = read('.novelwarden/lore/宗門/青雲宗.md');
    fake.reset([{ text: '青雲宗應該更神秘一些，我建議……', stop: 'end' }]);
    const gate = await expand({ relPath: '.novelwarden/lore/宗門/青雲宗.md' }, '');
    assert.equal(gate, undefined);
    assert.equal(read('.novelwarden/lore/宗門/青雲宗.md'), before3);
    const turn = controller.current.turns[controller.current.turns.length - 1];
    assert.ok(turn.error && turn.error.includes('展開解析不出來'), turn.error);
    assert.equal(turn.artifact, undefined);
  });

  test('被截斷的不給寫入，也不重來', async () => {
    fake.reset([{ text: '{"brief":"正道第一宗","body":{"概要":"劍修', stop: 'maxTokens' }]);
    const gate = await expand({ relPath: '.novelwarden/lore/宗門/青雲宗.md' }, '');
    assert.equal(gate, undefined);
    assert.equal(fake.callCount(), 1);
  });

  // 2026-10-25 起語法修復那一次換成轉寫：壞了語法的 JSON 一律交給轉寫理順，照抄的收下。
  test('JSON 語法壞了交給轉寫理順：一共 2 次', async () => {
    const broken = '{"brief":"正道第一宗","keywords":[],"body":{"概要":"劍修。" "现状":"封山。"},"children":[],"questions":[]}';
    const fixed = '{"brief":"正道第一宗","keywords":[],"body":{"概要":"劍修。", "现状":"封山。"},"children":[],"questions":[]}';
    fake.reset([{ text: broken, stop: 'end' }, { text: fixed, stop: 'end' }]);
    h.setReviewVerdict('apply');
    const gate = await expand({ relPath: '.novelwarden/lore/宗門/青雲宗.md' }, '');
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(1).includes('格式轉寫員') && userOf(1).includes('【設定展開 JSON 合同】'), userOf(1).slice(0, 500));
    assert.ok(gate.detail.includes('一共調了 2 次模型'), gate.detail);
    assert.ok(read('.novelwarden/lore/宗門/青雲宗.md').includes('封山。'));
  });
});

// 2026-10-25 起按小標題寫，轉寫模型照抄成 JSON（features/transcribe.ts）。
describe('按格式寫、轉寫成 JSON', () => {
  const DHD = '.novelwarden/lore/地域/斷魂渡.md';
  const PROSE = [
    '## 一句話',
    '斷魂河上的老渡口',
    '## 關鍵詞',
    '魂渡、老渡',
    '## 概要',
    '斷魂河上的老渡口，歸船幫。',
    '## 規則與邊界',
    '只在子時開船，一船不過七人。',
    '## 現狀',
    '（未交代）',
    '## 暗設',
    '船幫幫主是十年前失蹤的捕頭。',
    '## 子條目',
    '- 船幫（勢力）：把持斷魂渡的幫會',
    '## 還沒定的問題',
    '- 船幫收不收外人？',
  ].join('\n');
  const copied = (rule) =>
    JSON.stringify({
      brief: '斷魂河上的老渡口',
      keywords: ['魂渡', '老渡'],
      body: { 概要: '斷魂河上的老渡口，歸船幫。', 规则与边界: rule, 现状: '（未交代）', 暗设: '船幫幫主是十年前失蹤的捕頭。' },
      children: [{ name: '船幫', category: '勢力', brief: '把持斷魂渡的幫會' }],
      questions: ['船幫收不收外人？'],
    });

  before(() => {
    t.write(DHD, entry('斷魂渡', { brief: '渡口' }));
    project.invalidate();
  });

  test('寫一次、轉一次：轉寫只帶合同與原文，照抄的落盤、子條目建空條目', async () => {
    fake.reset([
      { text: PROSE, stop: 'end' },
      { text: copied('只在子時開船，一船不過七人。'), stop: 'end' },
    ]);
    const gate = await expand({ relPath: DHD }, '');
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes('把它往前想細') && !systemOf(0).includes('格式轉寫員'));
    assert.ok(systemOf(1).includes('格式轉寫員'), systemOf(1));
    assert.ok(userOf(1).includes('【原文】') && userOf(1).includes('只在子時開船，一船不過七人。'), userOf(1));
    assert.ok(!userOf(1).includes('# 定稿過的記錄') && !userOf(1).includes('# 相關世界觀設定'), userOf(1));
    assert.ok(gate, JSON.stringify(posted.filter((m) => m.type === 'toast')));
    assert.ok(gate.detail.includes('一共調了 2 次模型'), gate.detail);
    const text = read(DHD);
    assert.ok(text.includes('只在子時開船，一船不過七人。') && text.includes('## 暗設'), text);
    assert.ok((await listLore()).some((e) => e.title === '船幫'));
  });

  test('轉寫兩次都改了字：不給寫入，原文留在氣泡裡', async () => {
    t.write(DHD, entry('斷魂渡', { brief: '渡口' }));
    project.invalidate();
    const before4 = read(DHD);
    const reworded = copied('子時開船，最多載七人。');
    fake.reset([
      { text: PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    const gate = await expand({ relPath: DHD }, '');
    assert.equal(gate, undefined);
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字'), userOf(2).slice(0, 600));
    assert.equal(read(DHD), before4);
    const turn = controller.current.turns[controller.current.turns.length - 1];
    assert.ok(turn.error && turn.error.includes('展開解析不出來'), turn.error);
    assert.ok(turn.content.includes('只在子時開船，一船不過七人。'), turn.content.slice(0, 300));
  });
});

describe('單章細綱建空條目（§3）', () => {
  const blueprint = (no, settings) =>
    JSON.stringify({
      blueprints: [
        {
          chapterNumber: no,
          title: `第${no}章`,
          synopsis: '林昭下暗河。',
          characters: ['林昭'],
          timePlace: '夜，城下',
          keyEvents: ['林昭摸進鬼市。'],
          highlights: ['鬼市開張'],
          foreshadowing: [],
          stateChange: '',
          settings,
        },
      ],
    });

  async function writePlot(no, settings) {
    posted.length = 0;
    gates = [];
    h.expect();
    fake.reset([{ text: blueprint(no, settings), stop: 'end' }]);
    await controller.handle({
      type: 'send',
      payload: { text: '下鬼市', targetNo: no, attachments: [], excludedIds: [], stage: 'plot', capability: 'generate', target: { kind: 'plot', plotRelPath: PLOT(no) } },
    });
    project.invalidate();
    return gates[0];
  }

  test('新建一章細綱：isNew 的建空條目，卡片上先列出來；已有的、人名不建', async () => {
    const gate = await writePlot(5, [
      { name: '鬼市', category: '地域', isNew: true, note: '城下的夜市' },
      { name: '天機閣', category: '宗門', isNew: true, note: '已有' },
      { name: '阿昭', category: '', isNew: true, note: '人' },
      { name: '九層樓', category: '地域', isNew: false, note: '' },
    ]);
    assert.ok(gate.detail.includes('會新建設定條目：鬼市'), gate.detail);
    const ghost = (await listLore()).find((x) => x.title === '鬼市');
    assert.equal(ghost.relPath, '.novelwarden/lore/地域/鬼市.md');
    assert.equal(ghost.brief, '城下的夜市');
    assert.equal(ghost.body.trim(), '');
    assert.equal((await listLore()).filter((x) => x.title === '天機閣').length, 1);
    assert.ok(read(PLOT(5)).includes('- 鬼市〔地域〕：城下的夜市'));
    const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
    assert.ok(toasts.some((m) => m.includes('新建設定條目：鬼市')), toasts.join('|'));
  });

  test('覆蓋已有的那一章細綱時也建', async () => {
    const gate = await writePlot(5, [{ name: '黑水渡', category: '地域', isNew: true, note: '鬼市的渡口' }]);
    assert.ok(gate.detail.includes('會新建設定條目：黑水渡'), gate.detail);
    assert.ok((await listLore()).some((x) => x.relPath === '.novelwarden/lore/地域/黑水渡.md'));
  });
});

describe('會話', () => {
  test('存下的展開草稿讀回來目標還是這一條，不是整批設定清單', async () => {
    const store = new bundle.session.SessionStore(project);
    const session = store.create({ target: { kind: 'lore', relPath: TJG } });
    session.stage = 'setting';
    session.capability = 'generate';
    session.drafts = [
      { id: 'd1', action: { stage: 'setting', capability: 'generate' }, target: { kind: 'lore', relPath: TJG }, raw: '{}', words: 0, createdAt: new Date().toISOString() },
    ];
    await store.write(session);
    const back = await store.read(session.id);
    assert.deepEqual(back.target, { kind: 'lore', relPath: TJG });
    assert.equal(back.stage, 'setting');
    assert.equal(back.capability, 'generate');
    assert.deepEqual(back.drafts[0].target, { kind: 'lore', relPath: TJG });
  });
});

// 對話頁這條路認確認框上換的模型（generate 認 `pinnedModel`）：只這一輪，對話頁選定的不變。
describe('確認框上換一個模型', () => {
  test('這一輪只用它', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '寒潭', category: '地域' }, '', { action: '開始展開', choice: { model: 'p/strong' } });
    assert.equal(fake.callCount(), 1);
    assert.equal(fake.calls[0].ref, 'p/strong');
  });

  test('下一輪不問的生成照舊用對話頁那個（選擇不寫回設定）', async () => {
    fake.reset([{ text: JSON.stringify({ ...EXPANSION, children: [] }), stop: 'end' }]);
    await expand({ name: '寒潭', category: '地域' }, '');
    assert.equal(fake.calls[0].ref, 'p/m');
  });
});
