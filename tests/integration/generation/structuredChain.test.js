/**
 * 生成鏈：一件產物分幾次呼叫才拼得出來時，經對話頁從生成一路走到落盤。
 *
 * 三條鏈移植自 AI-Novel-Writer（generation/structured.ts 的檔案頭有出處）：
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 小說配置 · 一句話 | 截斷整份重來、「全域要求」不合格只重寫這一節；一句話、規模按彈窗的來；文風寫進還沒動過的 style.md |
 * | 小說配置 · style.md 改過 | 文風不寫進去，並且說出來（第 3 條） |
 * | 角色圖譜 | 身份清單 → 每批 3 人補詳情；截斷拆半；關係由清單生成到雙方卡上；性別在清單裡定、落進卡的 frontmatter |
 * | 細綱批次 | 截斷對半拆，後一半看得見前一半；寫入卡片列出會新建的角色卡（D19）與降級說明（第 2 條） |
 * | 細綱批次 · 漏章 | 模型正常收尾卻漏寫：報錯、不出卡片、磁碟一個位元組不動（fail-closed） |
 * | 細綱批次 · JSON 語法壞了 | 細綱試點起交給轉寫理順：照抄的收下；改了內容的不收、重轉一次 |
 * | 細綱批次 · 缺欄位 | 單章緊湊重建一次，寫明上次哪裡不合格 |
 * | 大綱續寫 | 只並進那一段，純續寫不彈審閱 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;
let gates;
let onGate = async () => 'proceed';

const CONFIG = [
  '---',
  'genre: 玄幻',
  'structure: three_act',
  'totalChapters: 30',
  'wordsPerChapter: 400',
  '---',
  '# 小說配置',
  '## 一句話',
  '少年入宗查舊案',
  '## 核心梗概',
  '林昭揹著滅門舊案進青雲宗。',
].join('\n');

const OUTLINE = outlineOf(20, { titles: { 1: '入局' }, text: { 1: '林昭進青雲宗，查出第一塊令牌的來歷。' } });

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
}

async function send(payload) {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', targetNo: 0, attachments: [], excludedIds: [], ...payload },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    gate: gates[0],
    errors: posted.filter((m) => m.type === 'toast' && m.level === 'error').map((m) => m.message),
  };
}

/** 最後一次呼叫的 user 訊息。 */
const userOf = (i) => {
  const msgs = fake.calls[i];
  return msgs[msgs.length - 1].content;
};

// 新合同：梗概 / 出場人物 / 時間地點 / 關鍵事件 / 看點 / 狀態變更（連續性事實定稿時才有）。
// 章末鉤子並進了看點，role 與 purpose 都沒了。關鍵事件與定稿一樣是一條一件事的陣列（⚑B）。
const bp = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章題`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭'],
  timePlace: '青雲宗山門，入夜',
  keyEvents: [`第 ${no} 章的關鍵事件：林昭在山門外踩點。`, '他翻牆進了後院，落在藏書閣門口。'],
  highlights: [`第 ${no} 章的鉤子`],
  foreshadowing: [],
  stateChange: '',
  ...over,
});
const batchOf = (...items) => JSON.stringify({ blueprints: items });
const PLOT_T = (no) => ({ kind: 'plot', plotRelPath: `.novelwarden/summaries/${String(no).padStart(3, '0')}.md` });

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
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
  t = await makeTempProject(bundle.project, { prefix: 'chain', title: '青雲劍錄' });
  project = t.project;
  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

// ---------------------------------------------------------------- 小說配置

const GOOD_CONFIG = {
  genre: '玄幻',
  targetAudience: '男頻',
  subGenre: '宗門 · 查案',
  plotStructure: 'heros_journey',
  narrativePOV: 'third_limited',
  coreOutline: '少年揹著滅門舊案入宗，查出宗門與舊案的關係，最後在師門與真相之間做出選擇。',
  worldSetting: '靈脈枯竭的九州。',
  goldenFinger: '一塊能回放死者最後一刻的殘令，每用一次折壽一月。',
  protagonistProfile: '林昭，隱忍，想替父洗冤。',
  globalGuidance: Array.from({ length: 10 }, (_, i) => `${i + 1}. 規則${i + 1}`).join('\n'),
  writingStyle: '冷峻剋制，短句為主，少用比喻。',
};
const GOOD_GUIDANCE = '1. 不寫上帝視角\n2. 每章留鉤子\n3. 殘令每次使用都有代價\n4. 對白分得出是誰在說';

describe('小說配置 · 從一句話生成', () => {
  let r;
  let calls;

  before(async () => {
    fake.reset([
      { text: '{"genre":"玄幻","coreOutline":"少年揹著', stop: 'maxTokens' },
      { text: JSON.stringify(GOOD_CONFIG), stop: 'end' },
      { text: GOOD_GUIDANCE, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({
      text: '少年揹著滅門舊案進宗門',
      stage: 'setting',
      capability: 'generate',
      target: { kind: 'setting', doc: 'config' },
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    calls = fake.callCount();
  });

  test('截斷整份重來 1 次、全域要求重寫 1 次：一共 3 次', () => {
    assert.equal(calls, 3);
    assert.ok(userOf(1).includes('上一輪輸出因長度限制而中斷'), userOf(1).slice(-600));
    assert.ok(userOf(2).includes('只糾正小說配置中的 globalGuidance 欄位'), userOf(2).slice(0, 200));
  });

  test('卡片上寫清調了幾次、為什麼', () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('一共調了 3 次模型'), r.gate.detail);
    assert.ok(r.gate.detail.includes('被輸出上限截斷') && r.gate.detail.includes('全域要求有 10 條'), r.gate.detail);
  });

  test('config.md：一句話是作者的原話，規模按彈窗，全域要求用重寫的那一版', async () => {
    const book = await project.readBookConfig();
    assert.equal(book.sections.一句话, '少年揹著滅門舊案進宗門');
    assert.equal(book.totalChapters, 100);
    assert.equal(book.wordsPerChapter, 3000);
    assert.equal(book.structure, 'heros_journey');
    assert.equal(book.sections.全局要求, GOOD_GUIDANCE);
    assert.equal(book.sections.金手指, GOOD_CONFIG.goldenFinger);
  });

  // D14：文風不進 config.md。style.md 還是初始化那份模板，替換它不吞掉作者的一個字。
  test('文風寫進還沒動過的 style.md，不進 config.md', async () => {
    assert.ok((await project.readStyleGuide()).includes('冷峻剋制'));
    assert.ok(!t.read('.novelwarden/config.md').includes('冷峻剋制'));
  });
});

describe('小說配置 · style.md 已經改過', () => {
  let r;
  let toasts;

  before(async () => {
    t.write('.novelwarden/style.md', '# 文風指南\n\n作者自己寫的文風。\n');
    t.write('.novelwarden/config.md', CONFIG);
    project.invalidate();
    fake.reset([{ text: JSON.stringify({ ...GOOD_CONFIG, globalGuidance: GOOD_GUIDANCE }), stop: 'end' }]);
    h.expect();
    r = await send({
      text: '少年入宗查舊案，要更黑暗',
      stage: 'setting',
      capability: 'generate',
      target: { kind: 'setting', doc: 'config' },
      setup: { totalChapters: 30, wordsPerChapter: 400 },
    });
    toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
  });

  test('一次就過：只調 1 次', () => {
    assert.equal(fake.callCount(), 1);
  });

  test('style.md 一個字沒動，並且說出來', () => {
    assert.equal(t.read('.novelwarden/style.md'), '# 文風指南\n\n作者自己寫的文風。\n');
    assert.ok(toasts.some((m) => m.includes('style.md 已有內容')), toasts.join('|'));
  });

  // 上游 mergeExpandedNovelConfig：作者寫過的保留原文，生成的追加在後。
  test('保留原文，追加生成', async () => {
    const book = await project.readBookConfig();
    assert.ok(book.sections.核心梗概.startsWith('林昭揹著滅門舊案進青雲宗。\n\n'), book.sections.核心梗概);
    assert.equal(book.genre, '玄幻');
    assert.ok(r.gate.detail.includes('保留原文'), r.gate.detail);
  });
});

// ---------------------------------------------------------------- 角色圖譜

describe('角色圖譜 · 兩段式', () => {
  const manifest = {
    slots: [
      { slotId: '1', name: '林昭', role: 'protagonist', gender: '男', narrativeDuty: '揹著舊案入宗', relations: [{ targetSlotId: '2', relation: '同門，互相試探' }] },
      { slotId: '2', name: '沈青', role: 'supporting', gender: 'female', narrativeDuty: '引路人', relations: [] },
      { slotId: '3', name: '周嶽', role: 'antagonist', narrativeDuty: '執法堂首座', relations: [{ targetSlotId: '1', relation: '處處壓制' }] },
      { slotId: '4', name: '韓七', role: 'minor', narrativeDuty: '雜役', relations: [] },
    ],
  };
  const detail = (id, name) => ({ slotId: id, name, 身份: `${name}的身份`, 外貌: '青衫', 性格: '冷', 语言习惯: '少言', 当前状态: '在山門', 暗设: '無' });
  let r;
  let cards;

  before(async () => {
    for (const c of await project.listCharacters()) {
      t.remove(c.relPath);
    }
    project.invalidate();
    fake.reset([
      { text: JSON.stringify(manifest), stop: 'end' },
      // 第一批 3 人被截斷：拆成 1 人 + 2 人重試。
      { text: '{"entries":[{"slotId":"1"', stop: 'maxTokens' },
      { text: JSON.stringify({ entries: [detail('1', '林昭')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('2', '沈青'), detail('3', '周嶽')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('4', '韓七')] }), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'characters' } });
    cards = await project.listCharacters();
  });

  test('清單 1 次 + 詳情（截斷拆半）4 次', () => {
    assert.equal(fake.callCount(), 5);
    // 詳情那一步帶著凍結清單（2026-10-25 起一人一行，不再是 JSON），點名這一批寫誰。
    assert.ok(userOf(1).includes('【凍結身份與關係清單】') && userOf(1).includes('- 周嶽（反派）：執法堂首座'), userOf(1).slice(-1200));
    assert.ok(userOf(1).includes('【本批要寫詳情的人】\n林昭、沈青、周嶽'), userOf(1).slice(-1200));
    assert.ok(userOf(1).includes('  - 與沈青：同門，互相試探'), userOf(1).slice(-1200));
  });

  test('卡片上說出拆半重試', () => {
    assert.ok(r.gate.detail.includes('拆成兩半重試'), r.gate.detail);
    assert.ok(r.gate.detail.includes('角色圖譜 · 4 人'), r.gate.detail);
  });

  test('四張卡都建了，定位進 tags，關係寫到雙方卡上', () => {
    assert.deepEqual(cards.map((c) => c.name).sort(), ['周嶽', '林昭', '沈青', '韓七'].sort());
    const lin = cards.find((c) => c.name === '林昭');
    assert.deepEqual(lin.tags, ['主角']);
    assert.ok(lin.sections.人物关系.includes('- 與沈青：同門，互相試探'), lin.sections.人物关系);
    assert.ok(lin.sections.人物关系.includes('- 與周嶽：周嶽眼中——處處壓制'), lin.sections.人物关系);
    assert.ok(lin.sections.身份.includes('敘事職責：揹著舊案入宗'), lin.sections.身份);
  });

  // 名字看不出性別時寫正文只能猜：性別在清單那一步定，跟著凍結清單進詳情、落在卡的 frontmatter 上。
  test('性別：清單裡定，詳情那一步看得見，落盤成 frontmatter；沒給的不寫', () => {
    assert.ok(userOf(1).includes('- 沈青（配角，女）：引路人'), userOf(1).slice(-1200));
    assert.equal(cards.find((c) => c.name === '林昭').gender, '男');
    const shen = cards.find((c) => c.name === '沈青');
    assert.equal(shen.gender, '女');
    assert.match(t.read(shen.relPath), /^gender: 女$/m);
    assert.equal(cards.find((c) => c.name === '周嶽').gender, undefined);
  });
});

// ---------------------------------------------------------------- 細綱批次

describe('細綱批次 · 截斷對半拆', () => {
  let r;

  before(async () => {
    t.write('.novelwarden/config.md', CONFIG);
    writeOutline(t, OUTLINE);
    project.invalidate();
    fake.reset([
      { text: batchOf(bp(1), bp(2)), stop: 'maxTokens' },
      { text: batchOf(bp(1), bp(2, { characters: ['林昭', '蘇晚'], newCharacters: [{ name: '蘇晚', role: 'supporting', gender: '女' }] })), stop: 'end' },
      { text: batchOf(bp(3), bp(4), bp(5)), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(1), range: { from: 1, to: 5 } });
  });

  test('第一次截斷 → 1–2 章、3–5 章各一次', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(1).includes('第 1–2 章') && userOf(2).includes('第 3–5 章'), `${userOf(1).slice(-300)}\n${userOf(2).slice(-300)}`);
  });

  // 後一半要接得上前一半——前一半還沒落盤，前序細綱一覽把它接在最後；關鍵事件一章一行，條與條之間用「；」接。
  test('後一半看得見前一半剛排好的那兩章', () => {
    assert.ok(
      userOf(2).includes('第2章 第2章題（剛排好，還沒寫入檔案）：第 2 章的關鍵事件：林昭在山門外踩點。；他翻牆進了後院，落在藏書閣門口。'),
      userOf(2).slice(0, 3000)
    );
  });

  test('卡片：落點是第 1–5 章，列出會新建的角色卡與降級說明', () => {
    assert.ok(r.gate.title.includes('第 1–5 章 · 細綱'), r.gate.title);
    assert.ok(r.gate.detail.includes('會新建角色卡：蘇晚'), r.gate.detail);
    assert.ok(r.gate.detail.includes('被輸出上限截斷，拆成兩半重試'), r.gate.detail);
  });

  // 關鍵事件、看點都是一條一句的列表，落盤成 `- 一條` 一行，與定稿寫出來的樣子一致。
  test('五份細綱都落盤：標題進檔名，目標字數取配置的每章字數', async () => {
    // 第 6–20 章只有梗概（大綱排到了、細綱還沒拆）：看排過的那幾份。
    const plots = (await project.listPlots()).filter((p) => p.sections.关键事件.trim());
    assert.deepEqual(plots.map((p) => p.no), [1, 2, 3, 4, 5]);
    // 標題取大綱裡那一條的（空殼上已經有了），不換成模型起的。
    assert.equal(plots[0].relPath, '.novelwarden/summaries/001-入局.md');
    assert.ok(plots.every((p) => p.targetWords === 400), JSON.stringify(plots.map((p) => p.targetWords)));
    assert.equal(plots[2].sections.看点, '- 第 3 章的鉤子');
    assert.equal(plots[2].sections.关键事件, '- 第 3 章的關鍵事件：林昭在山門外踩點。\n- 他翻牆進了後院，落在藏書閣門口。');
  });

  test('新角色建了卡（D19），性別落在卡上', async () => {
    const su = (await project.listCharacters()).find((c) => c.name === '蘇晚');
    assert.ok(su && su.tags.includes('配角') && su.sections.身份.includes('第 2 章'), JSON.stringify(su));
    assert.equal(su.gender, '女');
  });

  test('全書下一步轉去寫第 1 章', async () => {
    const next = posted.filter((m) => m.type === 'pipeline').pop()?.next;
    assert.ok(next && next.label === '寫第 1 章', JSON.stringify(next));
  });
});

describe('細綱批次 · 漏章 fail-closed', () => {
  let r;
  let before6;

  before(async () => {
    before6 = (await project.listPlots()).length;
    fake.reset([{ text: batchOf(bp(6), bp(7), bp(9), bp(10)), stop: 'end' }]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 10 } });
  });

  test('報錯說出漏了哪一章，不出卡片', () => {
    assert.equal(r.gate, undefined);
    assert.ok(r.errors.some((m) => m.includes('漏寫了第 8 章')), r.errors.join('|'));
  });

  test('只調了 1 次（對偷懶的輸出不重試）', () => {
    assert.equal(fake.callCount(), 1);
  });

  test('磁碟上一份細綱都沒多', async () => {
    assert.equal((await project.listPlots()).length, before6);
  });

  test('已經收到的輸出留在氣泡裡', () => {
    assert.ok(r.assistant.content.includes('第 6 章的關鍵事件'), r.assistant.content.slice(0, 200));
  });
});

// 細綱試點（2026-10-25）：從前的語法修復換成了轉寫——壞了語法的 JSON 也交給轉寫模型理順，照抄的收下，改了字的重轉。
describe('細綱批次 · JSON 語法壞了交給轉寫', () => {
  const broken = batchOf(bp(6), bp(7)).replace(/}]}$/, '},]}');

  test('照抄的轉寫收下', async () => {
    fake.reset([{ text: broken, stop: 'end' }, { text: batchOf(bp(6), bp(7)), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 2);
    assert.ok(fake.calls[1][0].content.includes('格式轉寫員'), fake.calls[1][0].content);
    assert.ok(r.gate && r.gate.detail.includes('調了 2 次'), JSON.stringify(r.gate ?? r.errors));
  });

  // 轉寫只許照抄——藉機把關鍵事件改寫一遍，就是一次沒經過裝配器的第二次生成。
  test('改了內容的轉寫不收，重轉一次', async () => {
    fake.reset([
      { text: broken, stop: 'end' },
      { text: batchOf(bp(6, { keyEvents: ['改寫過的事件'] }), bp(7)), stop: 'end' },
      { text: batchOf(bp(6), bp(7)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 3);
    assert.ok(fake.calls[2][1].content.includes('【上次轉寫不合格】這幾處不是原文裡的字：「改寫過的事件」'), fake.calls[2][1].content.slice(0, 400));
    assert.ok(r.gate && r.gate.detail.includes('重轉一次'), JSON.stringify(r.gate ?? r.errors));
  });

  // 復跑報告問題 7：模型在結尾多寫了一個 `]`——轉寫理順之後照收。
  test('結尾多寫了一個收尾括號：轉寫理順之後收下', async () => {
    fake.reset([{ text: batchOf(bp(6), bp(7)).replace(/]}$/, ']]}'), stop: 'end' }, { text: batchOf(bp(6), bp(7)), stop: 'end' }]);
    onGate = async () => 'skip';
    const r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 7 } });
    assert.equal(fake.callCount(), 2);
    assert.ok(r.gate, JSON.stringify(r.errors));
  });
});

describe('細綱批次 · 單章缺欄位 → 緊湊重建', () => {
  let r;

  // 梗概是必填的三個欄位之一（另兩個是 title、keyEvents）；看點、伏筆這類可以空著，空了不重建。
  before(async () => {
    fake.reset([
      { text: batchOf(bp(6, { synopsis: '' })), stop: 'end' },
      { text: batchOf(bp(6)), stop: 'end' },
    ]);
    onGate = async () => 'skip';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('重建那一次寫明上次哪裡不合格', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(1).includes('「梗概」那一節缺了或是空的') && userOf(1).includes('只寫第 6 章這一章'), userOf(1).slice(-600));
  });

  test('卡片上說出重建過', () => {
    assert.ok(r.gate.detail.includes('單章重建一次'), r.gate.detail);
  });
});

// 關鍵事件是空陣列：與缺梗概一樣是必填項不合格，單章緊湊重建；重建時給成一段字（老合同的形狀）照收。
describe('細綱批次 · 關鍵事件空著 → 緊湊重建，一段字照收', () => {
  let r;

  before(async () => {
    fake.reset([
      { text: batchOf(bp(6, { keyEvents: [] })), stop: 'end' },
      { text: batchOf(bp(6, { keyEvents: '林昭踩點；翻牆進了後院\n- 落在藏書閣門口' })), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'plot', capability: 'generate', target: PLOT_T(6), range: { from: 6, to: 6 } });
  });

  test('重建那一次寫明是關鍵事件空著', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(1).includes('「關鍵事件」那一節缺了或是空的'), userOf(1).slice(-600));
    assert.ok(r.gate.detail.includes('單章重建一次'), r.gate.detail);
  });

  test('一段字按換行與分號切成條，落盤一條一行', async () => {
    const plot = (await project.listPlots()).find((p) => p.no === 6);
    assert.equal(plot?.sections.关键事件, '- 林昭踩點\n- 翻牆進了後院\n- 落在藏書閣門口', JSON.stringify(plot?.sections));
  });
});

// ---------------------------------------------------------------- 大綱續寫

describe('大綱續寫 · 只並進那一段', () => {
  let r;
  let reviewed;

  before(async () => {
    fake.reset([{ text: outlineOf(30, { from: 21, heading: false, titles: { 21: '風起' }, text: { 21: '名冊浮出水面。' } }), stop: 'end' }]);
    onGate = async () => 'proceed';
    h.expect();
    r = await send({ stage: 'outline', capability: 'generate', target: { kind: 'outline' }, range: { from: 21, to: 30 } });
    reviewed = h.reviewed.length;
  });

  test('卡片：落點是那一段，不說「覆蓋」', () => {
    assert.ok(r.gate.title.includes('寫入到「情節大綱 · 第 21–30 章」'), r.gate.title);
  });

  // 純續寫一個字都不吞，不彈審閱。
  test('不彈審閱，前 20 章原樣在，新的一段接在後面', async () => {
    assert.equal(reviewed, 0);
    const outline = await project.readOutline();
    assert.ok(outline.includes('林昭進青雲宗，查出第一塊令牌的來歷。') && outline.includes('名冊浮出水面。'), outline);
    assert.ok(outline.indexOf('## 第20章') < outline.indexOf('## 第21章：風起'));
    assert.equal((outline.match(/^## 第\d+章/gm) ?? []).length, 30, '第 1–30 章各一條');
  });
});

// ---------------------------------------------------------------- 按格式寫、轉寫成 JSON（2026-10-25 起）

const TRANSCRIBER = '格式轉寫員';
const systemOf = (i) => fake.calls[i][0].content;

/** 寫配置的模型按小標題寫出來的一份。 */
const CONFIG_PROSE = [
  '## 型別',
  '仙俠',
  '## 受眾',
  '男頻',
  '## 細分型別',
  '宗門 · 復仇',
  '## 故事結構',
  '英雄之旅',
  '## 敘事視角',
  '第三人稱有限視角',
  '## 一句話賣點',
  '無',
  '## 核心梗概',
  '孤兒入宗復仇，一路查到宗主頭上。',
  '## 核心賣點',
  '- 殘令回放死者最後一刻',
  '- 執法堂步步緊逼',
  '## 世界觀要點',
  '靈脈枯竭，宗門壟斷靈石。',
  '## 金手指',
  '殘令：每回放一次折壽一月。',
  '## 主角檔案',
  '沈默寡言，記仇。',
  '## 全域要求',
  '1. 不寫上帝視角',
  '2. 每章留鉤子',
  '3. 殘令每次使用都有代價',
  '4. 對白分得出是誰在說',
  '## 文風',
  '冷峻剋制，短句為主。',
  '## 參考作品',
  '無',
].join('\n');
const CONFIG_COPIED = {
  genre: '仙俠',
  targetAudience: '男頻',
  subGenre: '宗門 · 復仇',
  plotStructure: 'heros_journey',
  narrativePOV: 'third_limited',
  logline: '無',
  coreOutline: '孤兒入宗復仇，一路查到宗主頭上。',
  sellingPoints: '- 殘令回放死者最後一刻\n- 執法堂步步緊逼',
  worldSetting: '靈脈枯竭，宗門壟斷靈石。',
  goldenFinger: '殘令：每回放一次折壽一月。',
  protagonistProfile: '沈默寡言，記仇。',
  globalGuidance: '1. 不寫上帝視角\n2. 每章留鉤子\n3. 殘令每次使用都有代價\n4. 對白分得出是誰在說',
  writingStyle: '冷峻剋制，短句為主。',
  referenceWorks: '',
};

describe('小說配置 · 按格式寫、轉寫成 JSON', () => {
  let r;

  before(async () => {
    t.write('.novelwarden/config.md', CONFIG);
    project.invalidate();
    fake.reset([
      { text: CONFIG_PROSE, stop: 'end' },
      { text: JSON.stringify(CONFIG_COPIED), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ text: '要更黑暗', stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'config' } });
  });

  test('寫一次、轉一次；寫配置的提示詞不要 JSON', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(userOf(0).includes('【小說配置格式】') && userOf(0).includes('不寫 JSON') && !userOf(0).includes('"coreOutline"'), userOf(0).slice(-800));
  });

  // 轉寫只看原文：給多了它會順手補內容。
  test('轉寫只帶合同與原文，不帶書的上下文', () => {
    assert.ok(!systemOf(0).includes(TRANSCRIBER) && systemOf(1).includes(TRANSCRIBER), systemOf(1));
    assert.ok(userOf(1).includes('【小說配置 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('殘令：每回放一次折壽一月。'), userOf(1));
    assert.ok(!userOf(1).includes('林昭揹著滅門舊案進青雲宗'), userOf(1));
  });

  test('照抄的落進 config.md：中文詞對到故事結構，八節照原文', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('一共調了 2 次模型'), r.gate.detail);
    project.invalidate();
    const book = await project.readBookConfig();
    assert.equal(book.structure, 'heros_journey');
    assert.equal(book.pov, 'third_limited');
    assert.equal(book.sections.金手指, '殘令：每回放一次折壽一月。');
    assert.equal(book.sections.全局要求, CONFIG_COPIED.globalGuidance);
  });
});

describe('小說配置 · 轉寫兩次都改了字：按小節讀原文', () => {
  let r;

  before(async () => {
    t.write('.novelwarden/config.md', CONFIG);
    project.invalidate();
    const reworded = JSON.stringify({ ...CONFIG_COPIED, goldenFinger: '殘令能回放死者臨終一幕，代價是折壽。' });
    fake.reset([
      { text: CONFIG_PROSE, stop: 'end' },
      { text: reworded, stop: 'end' },
      { text: reworded, stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ text: '要更黑暗', stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'config' } });
  });

  test('重轉一次，說清哪幾處不是原文裡的字', () => {
    assert.equal(fake.callCount(), 3);
    assert.ok(userOf(2).includes('【上次轉寫不合格】這幾處不是原文裡的字：「殘令能回放死者臨終一幕，代價是折壽。」'), userOf(2).slice(0, 800));
  });

  test('不報錯：卡片上說清沒轉成、按小節讀了原文；八節照原文落盤', async () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('沒能整理成 JSON') && r.gate.detail.includes('按小節讀了原文'), r.gate.detail);
    project.invalidate();
    const book = await project.readBookConfig();
    assert.equal(book.sections.金手指, '殘令：每回放一次折壽一月。');
    assert.ok(book.sections.核心梗概.includes('孤兒入宗復仇'), book.sections.核心梗概);
  });
});

describe('角色圖譜 · 按格式寫、轉寫成 JSON', () => {
  const MANIFEST_PROSE = [
    '## 林昭',
    '- 定位：主角',
    '- 性別：男',
    '- 敘事職責：揹著舊案入宗',
    '- 關係：',
    '  - 與沈青：同門，互相試探',
    '## 沈青',
    '- 定位：配角',
    '- 性別：女',
    '- 敘事職責：引路人',
    '- 關係：無',
    '## 周嶽',
    '- 定位：反派',
    '- 性別：男',
    '- 敘事職責：執法堂首座',
    '- 關係：',
    '  - 與林昭：處處壓制',
  ].join('\n');
  // 轉寫模型把定位照抄成了中文（「主角」）：程式對回英文值，不按配角算。
  const MANIFEST_COPIED = {
    slots: [
      { slotId: '林昭', name: '林昭', role: '主角', gender: '男', narrativeDuty: '揹著舊案入宗', relations: [{ targetSlotId: '沈青', relation: '同門，互相試探' }] },
      { slotId: '沈青', name: '沈青', role: 'supporting', gender: '女', narrativeDuty: '引路人', relations: [] },
      { slotId: '周嶽', name: '周嶽', role: 'antagonist', gender: '男', narrativeDuty: '執法堂首座', relations: [{ targetSlotId: '林昭', relation: '處處壓制' }] },
    ],
  };
  const person = (name) => [`## ${name}`, '### 身份', `${name}出身寒門。`, '### 外貌', '青衫', '### 性格', '冷', '### 語言習慣', '少言', '### 當前狀態', '在山門', '### 暗設', '無', '### 專屬稱呼', '無'];
  const DETAILS_PROSE = ['林昭', '沈青', '周嶽'].flatMap(person).join('\n');
  const detail = (name, over = {}) => ({ name, 身份: `${name}出身寒門。`, 外貌: '青衫', 性格: '冷', 语言习惯: '少言', 当前状态: '在山門', 暗设: '無', aliases: [], ...over });
  let r;
  let cards;

  before(async () => {
    for (const c of await project.listCharacters()) {
      t.remove(c.relPath);
    }
    project.invalidate();
    fake.reset([
      { text: MANIFEST_PROSE, stop: 'end' },
      { text: JSON.stringify(MANIFEST_COPIED), stop: 'end' },
      { text: DETAILS_PROSE, stop: 'end' },
      // 改了一個人的身份：不收，重轉一次。
      { text: JSON.stringify({ entries: [detail('林昭', { 身份: '林昭是寒門子弟。' }), detail('沈青'), detail('周嶽')] }), stop: 'end' },
      { text: JSON.stringify({ entries: [detail('林昭'), detail('沈青'), detail('周嶽')] }), stop: 'end' },
    ]);
    onGate = async () => 'proceed';
    r = await send({ stage: 'setting', capability: 'generate', target: { kind: 'setting', doc: 'characters' } });
    project.invalidate();
    cards = await project.listCharacters();
  });

  test('清單寫 1、轉寫 1；詳情寫 1、轉寫 2（改了字重轉一次）', () => {
    assert.equal(fake.callCount(), 5);
    assert.ok([1, 3, 4].every((i) => systemOf(i).includes(TRANSCRIBER)) && !systemOf(0).includes(TRANSCRIBER) && !systemOf(2).includes(TRANSCRIBER));
    assert.ok(userOf(0).includes('【身份清單格式】') && userOf(0).includes('不寫 JSON'), userOf(0).slice(-800));
    assert.ok(userOf(1).includes('【身份清單 JSON 合同】') && userOf(1).includes('【原文】') && userOf(1).includes('- 敘事職責：執法堂首座'), userOf(1));
    assert.ok(userOf(4).includes('【上次轉寫不合格】這幾處不是原文裡的字：「林昭是寒門子弟。」'), userOf(4).slice(0, 800));
  });

  test('詳情那一步按凍結清單點名，按小標題寫', () => {
    assert.ok(userOf(2).includes('- 林昭（主角，男）：揹著舊案入宗\n  - 與沈青：同門，互相試探'), userOf(2).slice(-1500));
    assert.ok(userOf(2).includes('【本批要寫詳情的人】\n林昭、沈青、周嶽') && userOf(2).includes('【角色詳情格式】'), userOf(2).slice(-1500));
  });

  test('三張卡都建了：中文定位對回來，關係寫到雙方卡上，身份照原文', () => {
    assert.ok(r.gate, JSON.stringify(r.errors));
    assert.ok(r.gate.detail.includes('重轉一次'), r.gate.detail);
    const lin = cards.find((c) => c.name === '林昭');
    assert.deepEqual(lin.tags, ['主角']);
    assert.equal(lin.gender, '男');
    assert.ok(lin.sections.身份.startsWith('林昭出身寒門。'), lin.sections.身份);
    assert.ok(lin.sections.人物关系.includes('- 與沈青：同門，互相試探') && lin.sections.人物关系.includes('周嶽眼中——處處壓制'), lin.sections.人物关系);
    assert.equal(cards.find((c) => c.name === '沈青').gender, '女');
  });
});
