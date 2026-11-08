/**
 * 三期驗收：從空工程開始，**跟著主按鈕走**，一路寫完前 3 章。
 *
 *   一句話 → 架構五件 → 情節大綱 → 第 1–5 章細綱（二期那一段，9 次呼叫）
 *   → 寫第 1 章 → 定稿 → 寫第 2 章 → 定稿 → 寫第 3 章
 *
 * 每一步照前端的做法：取後端推來的下一步（`pipeline.next`），按它的 stage / capability /
 * target / range / writeMode 傳送（定稿走工程動作），落盤卡片答「寫入」。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 主按鈕的順序 | 第 20 條：寫完一章先推定稿（D17、D23），定稿完轉去下一章 |
 * | 寫正文那幾步的提示報「最多 8 次」 | D16：續寫算進呼叫次數，動手之前寫明 |
 * | 第 1 章用黃金第一章法則、後續章用連載法則 | 兩套提示詞（PT:720-855） |
 * | 第 2 章的裝配：上一章結尾不許重演、後幾章作邊界、執行卡重列關鍵事件、全域要求 | 總計劃 §2.3 |
 * | 第 2 章被截斷，自動續寫一輪 | §2.4 |
 * | 第 3 章開頭重演了第 2 章結尾：卡片標紅、寫入要點兩下 | §2.4：不替作者拒收 |
 * | 一共調了幾次 | 第 4 條：二期 9 次 + 1 + 3 + 2 + 3 + 1 = 19（定稿是更新細綱 + 角色狀態 + 認敘事線三次） |
 * | 定稿把同一份細綱照正文更新了 | 細綱並進摘要：定稿記 sourceHash、重新整理 writtenFrom，不另存一份摘要 |
 * | 一張覆蓋審閱都沒彈 | 新章都是新建，沒有東西可吞 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
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

const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊'];

/** 定稿那一次的應答：照正文更新過的細綱（八個中文鍵，與從前的摘要 JSON 同一份）。 */
const SUMMARY_JSON = (no) =>
  JSON.stringify({
    梗概: `第 ${no} 章：林昭在鎮上又往前查了一步。`,
    出场人物: [{ name: '林昭', aliases: [] }],
    时间地点: '青崖鎮，夜。',
    关键事件: [`第 ${no} 章的事`],
    状态变更: '林昭離真相近了一步。',
  });

/** 每一章正文的指令碼（按執行卡裡重列的關鍵事件認是第幾章）。 */
function manuscript(no) {
  if (no === 1) {
    return { text: filler(900, 101), stop: 'end' };
  }
  if (no === 2) {
    // 寫到一半被輸出上限截斷：續寫一輪補上。
    return { text: filler(600, 201), stop: 'maxTokens' };
  }
  // 第 3 章開頭把第 2 章的結尾又演了一遍。
  const ch2 = t.read('chapters/002-令牌.txt').trim();
  return { text: `${ch2.slice(-160)}\n\n${filler(900, 301)}`, stop: 'end' };
}

/** 按契約裡認得出的那一段應答。 */
function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('建立可檢索的章節檔案')) {
    // 定稿的 user 訊息先給當前細綱再給正文，兩塊的塊頭都是「【第N章 標題 · …】」。
    const no = Number(/【第(\d+)章 /.exec(user)?.[1] ?? 0);
    return SUMMARY_JSON(no);
  }
  if (system.includes('依據本章正文更新角色的「當前狀態」')) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '在青崖鎮，離真相近了一步。' }] });
  }
  // 敘事線認事件（每次定稿都跑）：還沒排線，什麼都認不出。
  if (system.includes('你是小說定稿事實審查員')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (user.includes('請無縫續寫當前章節正文')) {
    return { text: filler(500, 202), stop: 'end' };
  }
  const card = /- 必需事件：\n {2}- 第 (\d+) 章：/.exec(user);
  if (card && (user.includes('黃金第一章') || user.includes('連載更新核心法則'))) {
    return manuscript(Number(card[1]));
  }
  if (user.includes('【小說配置格式】')) return CONFIG_JSON;
  // 設定清單：三條一批就補完詳情。
  if (user.includes('【設定清單格式】')) {
    return JSON.stringify({
      categories: ['地域', '信物', '制度'],
      entries: [
        { title: '青崖鎮', category: '地域', keywords: [], brief: '偏僻小鎮' },
        { title: '殘令', category: '信物', keywords: [], brief: '照見最後一幕的令牌' },
        { title: '名冊', category: '制度', keywords: [], brief: '決定誰算鎮上的人' },
      ],
    });
  }
  if (user.includes('【凍結設定清單】')) {
    const titles = /【本批必須完整生成的條目】\n([^\n]+)/.exec(user)[1].split('、');
    return JSON.stringify({ entries: titles.map((title) => ({ title, body: `## 概要\n${title}。` })) });
  }
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
        title: TITLES[no - 1] ?? `第${no}章`,
        synopsis: `第 ${no} 章林昭要弄清的一件事。`,
        characters: ['林昭', '沈氏'],
        timePlace: '青崖鎮，夜。',
        // 關鍵事件與定稿一樣是一條一件事的陣列（⚑B）；執行卡裡多條縮排列在「必需事件」下面。
        keyEvents: [`第 ${no} 章：林昭在鎮上的兩個場面裡推進，殘令照見一幕。`, '他為此付出代價。'],
        highlights: [`第 ${no} 章結尾：又一個持令人不見了。`],
        foreshadowing: [],
        stateChange: '林昭離真相近了一步。',
      });
    }
    return JSON.stringify({ blueprints });
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
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

async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按鈕。返回這一步的落盤卡片（定稿沒有卡片）。 */
async function press(step) {
  posted = [];
  if (step.projectAction) {
    await controller.handle({ type: 'projectAction', action: step.projectAction, relPath: step.target.plotRelPath });
    return undefined;
  }
  const payload =
    step.form === 'idea'
      ? {
          text: IDEA,
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: 30, wordsPerChapter: 1000 },
        }
      : {
          text: '',
          stage: step.stage,
          capability: step.capability,
          target: step.target,
          targetNo: step.no ?? step.range?.from ?? 1,
          range: step.range,
          writeMode: step.writeMode,
        };
  await controller.handle({ type: 'send', payload: { ...payload, attachments: [], excludedIds: [] } });
  return posted.filter((m) => m.type === 'gate').pop();
}

/** 第 i 次呼叫的 user 訊息。 */
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
/** 第一次呼叫裡認得出是第幾章正文的那一次（按執行卡重列的關鍵事件）。 */
const firstWriteCallOf = (no) =>
  fake.calls.findIndex((c) => {
    const u = c[c.length - 1].content;
    return u.includes(`- 必需事件：\n  - 第 ${no} 章：`) && !u.includes('請無縫續寫當前章節正文');
  });

describe('三期驗收：一句話 → 寫完前 3 章', () => {
  const steps = [];
  const gates = [];
  let finalStep;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      registry: './src/core/llm/registry.ts',
      provider: './src/core/llm/provider.ts',
      controller: './src/core/controller/index.ts',
      pipelineModel: './src/core/model/pipeline.ts',
      plotFile: './src/core/model/plotFile.ts',
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
    t = await makeTempProject(bundle.project, { prefix: 'phase3', title: '青崖記' });
    project = t.project;
    controller = new bundle.controller.ChatController(project);
    attach();

    // 二期那七步 + 寫 / 定稿 / 寫 / 定稿 / 寫。
    for (let i = 0; i < 12; i++) {
      const step = await nextStep();
      assert.ok(step, `第 ${i + 1} 步沒有下一步`);
      steps.push(step);
      gates.push(await press(step));
    }
    finalStep = await nextStep();
  });

  after(() => {
    controller?.dispose();
    if (t) cleanup(t.dir, bundle?.db);
  });

  test('主按鈕的順序：拆完細綱之後，寫一章、定稿一章', () => {
    assert.deepEqual(steps.slice(7).map((s) => s.label), [
      '寫第 1 章',
      '同步第 1 章',
      '寫第 2 章',
      '同步第 2 章',
      '寫第 3 章',
    ]);
  });

  test('寫完第 3 章，主按鈕推第 3 章的定稿', () => {
    assert.equal(finalStep?.label, '同步第 3 章', JSON.stringify(finalStep));
    assert.equal(finalStep?.no, 3);
  });

  test('寫正文那幾步的提示報「1 次，最多 8 次」', () => {
    for (const s of steps.filter((x) => x.label.startsWith('寫第'))) {
      assert.deepEqual(s.calls, bundle.pipelineModel.WRITE_CALLS, s.label);
    }
  });

  // 第 4 條：二期 9 次 + 第 1 章 1 + 定稿 4 + 第 2 章 2（截斷續寫一輪）+ 定稿 4 + 第 3 章 1。
  // 定稿四次：照正文更新細綱一次，林昭有角色卡、再更新一次角色狀態（四期，D17），認一次敘事線（敘事線重做：
  // 線是空的也認），推一次故事時間（2026-10-24 重做）。
  test('一共調了 21 次模型', () => {
    assert.equal(fake.callCount(), 21);
  });

  test('三章都落在 chapters/，標題取細綱的，正文寫了進去', async () => {
    const chapters = await project.listChapters();
    // 正文是 .txt（2026-10-24）：標題只在檔名裡，不寫標題行。
    assert.deepEqual(chapters.map((c) => c.relPath), ['chapters/001-停舟.txt', 'chapters/002-令牌.txt', 'chapters/003-夜訪.txt']);
    assert.deepEqual(chapters.map((c) => c.title), ['停舟', '令牌', '夜訪']);
    assert.ok(!t.read('chapters/001-停舟.txt').startsWith('#'));
    assert.ok(t.read('chapters/001-停舟.txt').includes(filler(900, 101)));
  });

  test('第 2 章：截斷後續寫的那一輪拼在後面', () => {
    const text = t.read('chapters/002-令牌.txt');
    assert.ok(text.includes(`${filler(600, 201)}\n\n${filler(500, 202)}`), text.slice(0, 80));
    assert.match(gates[9].detail, /1100 \/ 1000 字 · 已達標/);
    assert.match(gates[9].detail, /這一輪一共調了 2 次模型（續寫 1 輪）/);
  });

  test('第 3 章：開頭重演了第 2 章結尾——卡片標紅、寫入要點兩下', () => {
    assert.match(gates[11].danger, /與上一章結尾大段重合/);
    assert.equal(gates[11].confirm, '確定仍要寫入');
    assert.ok(gates[7].danger === undefined && gates[9].danger === undefined);
  });

  test('第 1 章用黃金第一章法則', () => {
    const u = userOf(firstWriteCallOf(1));
    assert.match(u, /【網文「黃金第一章」創作法則】/);
    assert.ok(!u.includes('# 上一章結尾原文'));
  });

  test('第 2 章用連載法則', () => {
    assert.match(userOf(firstWriteCallOf(2)), /【網文連載更新核心法則】/);
  });

  test('第 2 章的裝配：上一章結尾只作邊界，不許重演', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('# 上一章結尾原文（只作邊界，不可重演）') || u.includes('不要重演它的結尾'), u.slice(0, 600));
  });

  test('第 2 章的裝配：後幾章的細綱作邊界', () => {
    const u = userOf(firstWriteCallOf(2));
    const boundary = u.slice(u.indexOf('# 後續章節預告'));
    assert.ok(['第3章', '第4章', '第5章'].every((x) => boundary.includes(x)), boundary.slice(0, 400));
  });

  test('第 2 章的執行卡按原來的順序一條一項重列本章細綱的關鍵事件', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('- 必需事件：\n  - 第 2 章：林昭在鎮上的兩個場面裡推進，殘令照見一幕。\n  - 他為此付出代價。\n'), u.slice(-800));
  });

  // 章末鉤子並進了「看點」：看點裡爽點與章末懸念混在一起，不是一件件到期的動作，執行卡不重列它。
  test('第 2 章的執行卡不再單列章節鉤子', () => {
    assert.doesNotMatch(userOf(firstWriteCallOf(2)), /- 章節鉤子：/);
  });

  test('第 2 章的裝配帶著全域要求', () => {
    assert.match(userOf(firstWriteCallOf(2)), /# 全域要求（每一章都要遵守）[\s\S]*不寫上帝視角/);
  });

  test('第 2 章的裝配裡帶著第 1 章（前文）', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('第 1 章《停舟》'), u.slice(0, 800));
  });

  // 細綱並進摘要之後不另存一份單章摘要：定稿就是把同一份細綱照正文改寫，記下正文的指紋。
  test('第 1、2 章定稿過：細綱的 sourceHash 對得上正文', async () => {
    const chapters = await project.listChapters();
    const finalized = await Promise.all(chapters.map((ch) => project.finalizedPlotOf(ch)));
    assert.deepEqual(finalized.map((p) => p?.no), [1, 2, undefined]);
  });

  test('定稿後的細綱換成了模型照正文更新的那一份', async () => {
    const plots = await Promise.all([1, 2].map((no) => project.getPlot(no)));
    assert.deepEqual(
      plots.map((p) => p.sections.梗概),
      ['第 1 章：林昭在鎮上又往前查了一步。', '第 2 章：林昭在鎮上又往前查了一步。']
    );
  });

  test('第 3 章寫完還沒定稿：細綱仍是計劃，沒有 sourceHash', async () => {
    assert.equal((await project.getPlot(3)).sourceHash, '');
  });

  // writtenFrom：第 1、2 章定稿時刷成更新後的內容指紋，第 3 章是正文落盤時記的——三章都不掛 ⟳。
  test('三章細綱的 writtenFrom 都對得上內容指紋', async () => {
    const plots = await Promise.all([1, 2, 3].map((no) => project.getPlot(no)));
    assert.deepEqual(
      plots.map((p) => p.writtenFrom),
      plots.map((p) => bundle.plotFile.plotContentHash(p))
    );
  });

  test('一張覆蓋審閱都沒彈', () => {
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((r) => r.relPath)));
  });
});
