/**
 * `generate` 工具：agent 的「實際生成」入口。
 *
 * 這裡釘六件事，每一件都是這一層特有的（generate 本身的行為由
 * `tests/integration/generation/generate.test.js` 守著）：
 *
 * 1. **產物不回灌**——返回文字裡只有形狀與 draftId，一個正文字都沒有。
 *    三千字正文塞回迴圈，agent 每走一步重燒一遍。
 * 2. **層由路徑決定**：架構三件、大綱、細綱各有自己的路徑（細綱在
 *    `.novelwarden/summaries/NNN-標題.md`，與單章摘要併成了一份）；**正文層給章節路徑**
 *    （`chapters/NNN-標題.md`），工具按章號去認同號的細綱（細綱號 = 章號），
 *    target 以那份細綱的路徑為身份。老工程的中轉站、卷綱、`plots/` 路徑認不出，一律攔下。
 * 3. **能力由 STAGE_CAPABILITIES 說了算**（discuss / generate / settle / review），`split` 隨卷與中轉站一起刪了；
 *    `settle` 與 `review` 這個工具不做（一個要一段討論，一個要作者勾選）。
 * 4. **`settle` 明確不支援**：它要沉澱的是一段討論，而 agent 手上沒有。
 * 5. **`history` 恆為空**——混進裝配器會把工具呼叫當成作者的創作要求。
 * 6. **走對話頁選定的那個模型**（不傳 provider），第 12 條。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

/**
 * 細綱層的應答：單章也用批次合同的單項形式（`{"blueprints":[{…}]}`），欄位對到七節。
 * 連續性事實不在合同裡（證據要回正文定位，定稿時才有），所以填滿也只有 6/7 節。原來的「新增伏筆」刪了（敘事線二期：
 * 伏筆寫成 threads 裡的一條埋，寫進敘事線）。
 */
const PLOT_JSON = JSON.stringify({
  blueprints: [
    {
      chapterNumber: 1,
      title: '夜入青雲',
      synopsis: '林昭夜探青雲宗，想查清令牌的來歷。',
      characters: ['林昭'],
      timePlace: '深夜，青雲宗山門外',
      keyEvents: ['踩點、失手、翻牆', '收在藏書閣門口。'],
      highlights: ['第三塊令牌在牆內等著他'],
      stateChange: '林昭混進了外門',
      threads: [{ line: '', type: '埋', foreshadowing: '令牌的來歷', what: '守門弟子認得那塊令牌' }],
    },
  ],
});

let bundle;
let t;
let project;
let fake;
let h;
let ctx;
let settings;
/** 工具經 `ctx.report` 說的話（進氣泡，不進 agent 上下文）。 */
let reports;
/** 工具經 `ctx.onDelta` 推給前端的正文增量。 */
let deltas;
/** 存進 DraftStore 的草稿。 */
let stored;

const PLOT_REL = '.novelwarden/summaries/001-夜入青雲.md';
/** 第 1 章的正文路徑。檔案還不存在——正文就是要寫到這裡。 */
const CHAPTER_REL = 'chapters/001-夜入青雲.md';
const CONFIG_REL = '.novelwarden/config.md';

let replyFn = () => PLOT_JSON;
const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'generate');
const run = (args) => tool().run(ctx, args);
/** 最近一次模型呼叫裡的 system 與 user 兩段。 */
const lastSystem = () => fake.calls[fake.calls.length - 1][0].content;
const lastUser = () => {
  const call = fake.calls[fake.calls.length - 1];
  return call[call.length - 1].content;
};

function resetCtx() {
  reports = [];
  deltas = [];
  stored = [];
  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { put: (draft, sessionId) => stored.push({ draft, sessionId }) },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: (d) => deltas.push(d),
  };
  fake.calls.length = 0;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    plotFile: './src/core/model/plotFile.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });

  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'agentgen', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  // 只起了個頭的細綱：只寫了梗概，「關鍵事件」空著，所以還不算排過。
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '林昭進入宗門' },
  });
  await project.syncManifest();
  resetCtx();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('對細綱調 generate', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => PLOT_JSON;
    r = await run({ target: PLOT_REL, capability: 'generate', ask: '排一下這一章' });
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('draft 落進了 store', () => {
    assert.equal(stored.length, 1, JSON.stringify(stored.map((s) => s.draft && s.draft.id)));
  });

  test('draft 按會話分桶', () => {
    assert.equal(stored[0].sessionId, 's1');
  });

  test('draft 是細綱層的產物', () => {
    assert.deepEqual(stored[0].draft.target, { kind: 'plot', plotRelPath: PLOT_REL });
    assert.equal(stored[0].draft.artifact.kind, 'plot');
  });

  test('返回文字裡有 draftId', () => {
    assert.ok(r.text.includes(stored[0].draft.id), r.text);
  });

  // 七節裡模型答了六節（連續性事實計劃時為空）。
  test('返回文字裡有形狀描述', () => {
    assert.ok(r.text.includes('細綱 · 6/7 節'), r.text);
  });

  test('返回文字裡有落點', () => {
    assert.ok(r.text.includes(PLOT_REL), r.text);
  });

  // 這條是本 Task 的核心：三千字正文塞回迴圈，agent 每走一步重燒一遍。
  test('返回文字裡沒有正文', () => {
    assert.ok(!r.text.includes('踩點、失手、翻牆'), r.text);
    assert.ok(!r.text.includes('第三塊令牌'), r.text);
  });

  // 工具自己不落盤：寫不寫由呼叫方當場問作者（`controller` 的落盤卡片）。
  test('返回文字說清了落盤是另一回事', () => {
    assert.ok(r.text.includes('落盤'), r.text);
  });

  test('確實沒寫盤', async () => {
    const plot = await project.readPlot(PLOT_REL);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('呼叫一次報一次', () => {
    assert.equal(ctx.usage.calls, 1);
  });

  // 第 4 條：花了多少必須讓作者看見。工具說「生成了什麼」，
  // 「已用 1/10 次生成」那半句由呼叫方補——上限只有它知道。
  test('產出了什麼在氣泡裡說出來了', () => {
    assert.ok(reports.some((m) => m.includes('已生成')), JSON.stringify(reports));
  });

  // 工具不該知道上限是多少，說出「1/10」就是又把預算耦合回來了。
  test('工具自己不提上限', () => {
    assert.ok(!reports.join('|').includes('/10'), JSON.stringify(reports));
  });

  test('正文流給了前端', () => {
    assert.ok(deltas.join('').includes('踩點'), JSON.stringify(deltas));
  });

  test('display 給介面畫一行', () => {
    assert.ok(r.display && r.display.title.includes('generate'), JSON.stringify(r.display));
  });
});

describe('history 恆為空', () => {
  before(async () => {
    resetCtx();
    replyFn = () => PLOT_JSON;
    await run({ target: PLOT_REL, capability: 'generate', ask: '排一下' });
  });

  // agent 的工具呼叫不是作者的討論。混進去，裝配器會把 `list .novelwarden/summaries`
  // 當成作者提的創作要求。
  test('裝配出的訊息裡沒有工具呼叫的痕跡', () => {
    const all = JSON.stringify(fake.calls[0]);
    assert.ok(!all.includes('draftId'), all.slice(0, 400));
    assert.ok(!all.includes('toolCall'), all.slice(0, 400));
  });

  test('只調了一次模型', () => {
    assert.equal(fake.calls.length, 1, String(fake.calls.length));
  });
});

/**
 * ★ 一章一綱之後正文直接落 `chapters/`，agent 看到的「這一章」就是那個章節檔案。
 * 工具要按章號認出同號的細綱，把它當成正文層的 target——細綱**就是**寫正文的依據，
 * 認錯了號，模型手上就是另一章的事件。
 */
describe('給章節路徑：按章號認成正文層', () => {
  let r;
  let draft;
  let firstCall;

  before(async () => {
    resetCtx();
    replyFn = () => '雨下了三天。山門在雨裡。';
    const start = fake.calls.length;
    r = await run({ target: CHAPTER_REL, capability: 'generate', targetWords: 800 });
    draft = stored[0]?.draft;
    // 寫得太短會自動續寫，最後一次呼叫是續寫那一輪；這裡要看的是第一次。
    firstCall = fake.calls[start];
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  test('是正文層的生成', () => {
    assert.deepEqual(draft.action, { stage: 'manuscript', capability: 'generate' });
  });

  // target 以細綱路徑為身份（號會撞、路徑不會），這裡認的是同號那一份。
  test('target 指向同號的細綱', () => {
    assert.deepEqual(draft.target, { kind: 'manuscript', plotRelPath: PLOT_REL });
  });

  test('系統提示是作者的身份', () => {
    assert.ok(lastSystem().includes('中文長篇小說作者，正在為'), lastSystem().slice(0, 60));
  });

  // 細綱是寫正文的依據：認對了號，那一章的細綱就在上下文裡。
  test('那一章的細綱進了上下文', () => {
    assert.ok(lastUser().includes('# 細綱'), lastUser().slice(-600));
    assert.ok(lastUser().includes('林昭進入宗門'), lastUser().slice(-600));
  });

  test('目標字數傳進了 prompt', () => {
    const user = firstCall[firstCall.length - 1].content;
    assert.ok(user.includes('約 800 字'), user.slice(-400));
  });

  // 三期：寫得太短（十來個字對 800 字的目標）就自動續寫，續寫那一輪帶著已寫的末尾。
  test('沒寫夠就自動續寫', () => {
    assert.ok(draft.length.rounds >= 1, JSON.stringify(draft.length));
    assert.match(lastUser(), /請無縫續寫當前章節正文/);
  });

  test('返回文字裡的落點是作者給的那個章節路徑', () => {
    assert.ok(r.text.includes(`落點：${CHAPTER_REL}`), r.text);
  });

  test('確實沒寫盤（章節檔案還不在）', () => {
    assert.ok(!t.has(CHAPTER_REL));
  });

  // 老工程裡只有正文、沒有細綱的章：target 落在同號細綱**應該**在的位置，
  // 取正文的標題；寫正文的依據退化成空，但層與章號不會認錯。
  test('已有正文、還沒有細綱的章：target 落在同號細綱應在的位置', async () => {
    t.write('chapters/003-雪夜.md', '# 雪夜\n\n雪下了一夜。\n');
    project.invalidate();
    resetCtx();
    await run({ target: 'chapters/003-雪夜.md', capability: 'generate' });
    assert.deepEqual(stored[0].draft.target, { kind: 'manuscript', plotRelPath: '.novelwarden/summaries/003-雪夜.md' });
  });

  test('章節還不存在、也沒有細綱時同樣認成正文層', async () => {
    resetCtx();
    await run({ target: 'chapters/002-藏書閣.md', capability: 'generate' });
    const target = stored[0].draft.target;
    assert.equal(target.kind, 'manuscript', JSON.stringify(target));
    assert.ok(target.plotRelPath.startsWith('.novelwarden/summaries/002'), JSON.stringify(target));
  });
});

// 這一章已經有正文時，寫法由 writeMode 說：接著寫（落盤追加）還是整章重寫（落盤覆蓋、先對比）。
// 不給就是重寫——與對話頁主按鈕「重寫第 N 章」同一條路。
describe('正文層的 writeMode', () => {
  const REL = 'chapters/004-殘燈.md';

  before(() => {
    t.write(REL, '# 殘燈\n\n燈芯只剩一截。\n');
    project.invalidate();
  });

  test('continue：草稿記成接著寫', async () => {
    resetCtx();
    replyFn = () => '他把燈挑亮了一些。';
    const r = await run({ target: REL, capability: 'generate', writeMode: 'continue' });
    assert.equal(r.error, undefined, r.error);
    assert.equal(stored[0].draft.writeMode, 'continue');
  });

  test('rewrite：草稿記成重寫', async () => {
    resetCtx();
    replyFn = () => '燈芯只剩一截，他還是沒睡。';
    await run({ target: REL, capability: 'generate', writeMode: 'rewrite' });
    assert.equal(stored[0].draft.writeMode, 'rewrite');
  });

  test('不給：已有正文就是重寫', async () => {
    resetCtx();
    replyFn = () => '燈芯只剩一截。';
    await run({ target: REL, capability: 'generate' });
    assert.equal(stored[0].draft.writeMode, 'rewrite');
  });

  test('寫法認不出：當場報錯，不花錢', async () => {
    resetCtx();
    const before = fake.calls.length;
    const r = await run({ target: REL, capability: 'generate', writeMode: 'revise' });
    assert.ok(r.error?.includes('writeMode 只能是'), r.error);
    assert.equal(fake.calls.length, before);
  });

  test('別的層給了 writeMode：當場報錯，不花錢', async () => {
    resetCtx();
    const before = fake.calls.length;
    const r = await run({ target: PLOT_REL, capability: 'generate', writeMode: 'continue' });
    assert.ok(r.error?.includes('只對正文層'), r.error);
    assert.equal(fake.calls.length, before);
  });
});

describe('對架構檔案調 generate', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => '## 一句話\n\n少年入宗。\n\n## 核心梗概\n\n林昭夜入青雲宗，追查一塊令牌的來歷。\n';
    r = await run({ target: CONFIG_REL, capability: 'generate', ask: '玄幻，入宗流' });
  });

  test('沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
  });

  // 四件同屬一個階段，target 要帶上是哪一件，契約與落點都看它。
  test('target 是架構層的「小說配置」那一件', () => {
    assert.deepEqual(stored[0].draft.target, { kind: 'setting', doc: 'config' });
  });

  test('系統提示是策劃的身份', () => {
    assert.ok(fake.calls[0][0].content.includes('資深網文策劃編輯'), fake.calls[0][0].content.slice(0, 60));
  });

  // 2026-10-25 起配置按小標題寫（八節與 config.md 同名），JSON 合同（上游的英文鍵）挪給轉寫那一步。
  test('輸出契約是小說配置的格式；轉寫那一次帶 JSON 合同', () => {
    const first = fake.calls[0][fake.calls[0].length - 1].content;
    assert.ok(first.includes('【小說配置格式】') && first.includes('## 核心梗概') && !first.includes('"coreOutline"'), first.slice(-600));
    assert.ok(lastSystem().includes('格式轉寫員') && lastUser().includes('"coreOutline"'), lastUser().slice(0, 600));
  });

  // 假模型轉寫時照樣回那段 Markdown：兩次都轉不成，按小節讀原文（同從前模型沒按 JSON 答時）。
  test('轉寫不成：寫 1 次、轉寫 2 次，按小節讀了原文', () => {
    assert.equal(fake.calls.length, 3);
  });

  test('返回文字裡有形狀描述', () => {
    assert.ok(r.text.includes('小說配置 · 2/8 節'), r.text);
  });

  test('返回文字裡沒有正文', () => {
    assert.ok(!r.text.includes('追查一塊令牌'), r.text);
  });
});

/*
 * 設定清單（設定名錄）沒有自己的檔案：target 給設定目錄本身，與 `pathOfTarget` 的落點是同一個路徑。
 * 兩段式的鏈照樣跑（清單 → 詳情），返回裡只有形狀，條目正文不回灌。
 */
describe('對設定清單調 generate（target 是設定目錄）', () => {
  let r;
  let intent;

  before(async () => {
    resetCtx();
    replyFn = (messages) => {
      const user = messages[messages.length - 1].content;
      return user.includes('【凍結設定清單】')
        ? JSON.stringify({ entries: [{ title: '青雲宗', body: '## 概要\n正道第一大宗，山門在北。' }] })
        : JSON.stringify({ categories: ['宗門'], entries: [{ title: '青雲宗', category: '宗門', keywords: [], brief: '正道大宗' }] });
    };
    intent = tool().intent({ target: '.novelwarden/lore' }, project);
    r = await run({ target: '.novelwarden/lore/', capability: 'generate' });
  });

  test('確認框說的是「設定清單」，不是一個光禿禿的目錄', () => {
    assert.ok(intent.title.includes('「設定清單」'), intent.title);
  });

  test('認成架構層的設定清單，沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(stored[0].draft.target, { kind: 'setting', doc: 'lore' });
  });

  test('兩段式：清單 1 次 + 詳情 1 次', () => {
    assert.equal(fake.calls.length, 2);
    assert.ok(lastUser().includes('【凍結設定清單】'), lastUser().slice(-600));
  });

  test('返回只有形狀，沒有條目正文', () => {
    assert.ok(r.text.includes('設定清單 · 1 條 · 1 個分類'), r.text);
    assert.ok(!r.text.includes('山門在北'), r.text);
  });

  test('確實沒寫盤', async () => {
    assert.deepEqual(await project.listLore(), []);
  });

  // 別的目錄不認：角色區、章節區裡的目錄不是一件產物。
  test('設定目錄下的子目錄不認，給 error', async () => {
    const res = await run({ target: '.novelwarden/lore/宗門', capability: 'generate' });
    assert.ok(res.error && res.error.includes('設定清單給 .novelwarden/lore'), res.error);
  });
});

/*
 * 角色圖譜同樣沒有自己的檔案：target 給角色目錄本身（工程頁「故事架構」那一行的路徑）。從前這裡只認設定目錄，
 * 外部 agent 照 `list` 的說法給 .novelwarden/characters 會被當成認不出的路徑，只能繞去「補齊架構」。
 */
describe('對角色圖譜調 generate（target 是角色目錄）', () => {
  let r;
  let intent;

  before(async () => {
    resetCtx();
    replyFn = () =>
      JSON.stringify({
        characters: [
          { name: '林昭', role: '主角', 身份: '火場裡活下來的孤兒' },
          { name: '沈青', role: '盟友', 身份: '客棧老闆娘' },
        ],
      });
    intent = tool().intent({ target: '.novelwarden/characters' }, project);
    r = await run({ target: '.novelwarden/characters/', capability: 'generate' });
  });

  test('確認框說的是「角色圖譜」', () => {
    assert.ok(intent.title.includes('「角色圖譜」'), intent.title);
  });

  test('認成架構層的角色圖譜，沒有 error', () => {
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(stored[0].draft.target, { kind: 'setting', doc: 'characters' });
    assert.equal(stored[0].draft.artifact.kind, 'characterRoster');
  });

  test('確實沒建角色卡', async () => {
    assert.deepEqual((await project.listCharacters()).map((c) => c.name), []);
  });

  test('角色目錄下的子目錄照樣不認，報錯裡說清角色圖譜給哪個路徑', async () => {
    const res = await run({ target: '.novelwarden/characters/主角', capability: 'generate' });
    assert.ok(res.error && res.error.includes('角色圖譜給 .novelwarden/characters'), res.error);
  });
});

describe('能力由 STAGE_CAPABILITIES 說了算', () => {
  // 拆卷、拆段、拆章都刪了。agent 拿著老提示詞來試的話，要在這裡被攔住，
  // 並被告知現在有哪幾種能力。
  test('split 不再是能力，給 error', async () => {
    resetCtx();
    const r = await run({ target: CHAPTER_REL, capability: 'split' });
    assert.ok(r.error && r.error.includes('capability'), JSON.stringify(r));
  });

  test('error 裡列出實際能用什麼', async () => {
    resetCtx();
    const r = await run({ target: PLOT_REL, capability: 'split' });
    assert.ok(r.error.includes('generate') && r.error.includes('discuss'), r.error);
  });

  test('不支援的能力不調模型', async () => {
    resetCtx();
    await run({ target: PLOT_REL, capability: 'split' });
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('認不出的 capability 給 error', async () => {
    resetCtx();
    const r = await run({ target: PLOT_REL, capability: '排一下' });
    assert.ok(r.error && r.error.includes('capability'), JSON.stringify(r));
  });
});

// 五期：審稿報告要作者勾選才修稿，agent 拿到一份報告做不了什麼。
describe('review 明確不支援', () => {
  test('給 error，說清要作者在對話頁發起，不調模型', async () => {
    resetCtx();
    const r = await run({ target: CHAPTER_REL, capability: 'review' });
    assert.match(r.error, /審稿要作者在對話頁的正文層發起/);
    assert.equal(fake.calls.length, 0);
  });
});

describe('settle 明確不支援', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ target: PLOT_REL, capability: 'settle' });
  });

  test('給 error', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  // 餵它一個空歷史，它會憑空編一份「剛才討論出的結論」——比不支援更糟。
  test('error 指路到對話頁手動執行', () => {
    assert.ok(r.error.includes('對話頁'), r.error);
  });

  test('一次模型都沒調', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('一次呼叫都不報', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

// 完善設定二期：落定設定同樣要沉澱作者剛才的討論，agent 手裡沒有那段討論。
describe('落定設定也不給', () => {
  test('設定目錄上的 settle 同樣拒絕，指路 /落定設定，不調模型、不報賬', async () => {
    resetCtx();
    const r = await run({ target: '.novelwarden/lore', capability: 'settle' });
    assert.ok(r.error && r.error.includes('/落定設定') && r.error.includes('/落定細綱'), r.error);
    assert.equal(fake.calls.length, 0);
    assert.equal(ctx.usage.calls, 0);
  });

  test('描述裡架構那一層不列 settle', () => {
    assert.ok(tool().description.includes('setting=discuss/generate；'), tool().description);
  });

  test('別的架構檔案上給 settle：說這一層能用的，不列 settle', async () => {
    resetCtx();
    const r = await run({ target: CONFIG_REL, capability: 'settle' });
    assert.ok(r.error, JSON.stringify(r));
    assert.equal(fake.calls.length, 0);
  });
});

describe('認不出的路徑', () => {
  let r;

  before(async () => {
    resetCtx();
    r = await run({ target: '隨手寫的一個路徑.txt', capability: 'generate' });
  });

  test('給 error 而不是拋', () => {
    assert.ok(r.error, JSON.stringify(r));
  });

  test('error 裡給出各層正確的路徑形狀', () => {
    assert.ok(r.error.includes('.novelwarden/summaries/'), r.error);
    assert.ok(r.error.includes('chapters/'), r.error);
    assert.ok(r.error.includes('list'), r.error);
  });

  test('一次模型都沒調', () => {
    assert.equal(fake.calls.length, 0, String(fake.calls.length));
  });

  test('越界路徑同樣給 error', async () => {
    resetCtx();
    const bad = await run({ target: '../../etc/passwd', capability: 'generate' });
    assert.ok(bad.error, JSON.stringify(bad));
  });

  // 老工程磁碟上的中轉站、卷綱、`plots/` 下的細綱（平鋪的、按卷分目錄的）一個位元組都不動，但程式碼
  // 不再認它們：對著它們生成，產物沒有落點（流水線不讀那裡），只會白花一次錢。
  // （`summaries/` 子目錄裡的單章摘要不在此列：細綱映象正文的相對路徑，它就是那一章的細綱。）
  for (const [what, legacy] of [
    ['中轉站正文', '.novelwarden/manuscripts/001-夜入青雲.md'],
    ['卷綱', '.novelwarden/volumes/01-覺醒之日.md'],
    ['plots/ 下的細綱', '.novelwarden/plots/001-夜入青雲.md'],
    ['按卷分目錄的細綱', '.novelwarden/plots/01-覺醒之日/001-夜入青雲.md'],
  ]) {
    test(`老工程的${what}路徑認不出，不調模型`, async () => {
      resetCtx();
      const bad = await run({ target: legacy, capability: 'generate' });
      assert.ok(bad.error, JSON.stringify(bad));
      assert.equal(fake.calls.length, 0, String(fake.calls.length));
      assert.equal(ctx.usage.calls, 0);
    });
  }
});

describe('正文層用對話頁選定的那個模型', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => '雨下了三天。山門在雨裡。';
    r = await run({ target: CHAPTER_REL, capability: 'generate', targetWords: 800 });
  });

  // 第 12 條：中途換人會讓文風斷掉。不傳 provider = 走 config.active。
  test('用的是 config.active 那個模型', () => {
    assert.equal(fake.calls[0].ref, 'p/m', String(fake.calls[0].ref));
  });

  test('產出了 draft', () => {
    assert.equal(stored.length, 1, JSON.stringify(stored.length));
  });

  // 正文層最容易犯這個錯：一章三千字全塞回 agent 上下文。
  test('返回給模型的文字裡沒有正文', () => {
    assert.ok(!r.text.includes('雨下了三天'), r.text);
  });

  test('但正文流給了前端氣泡', () => {
    assert.ok(deltas.join('').includes('雨下了三天'), JSON.stringify(deltas));
  });

  test('給模型的只有字數與 draftId', () => {
    assert.ok(r.text.includes(stored[0].draft.id), r.text);
    assert.ok(/\d+ 字/.test(r.text), r.text);
  });
});

describe('模型失敗', () => {
  let r;

  before(async () => {
    resetCtx();
    replyFn = () => {
      throw new bundle.provider.LlmError('假裝 429 限流');
    };
    r = await run({ target: PLOT_REL, capability: 'generate' });
  });

  test('給 error 而不是拋', () => {
    assert.ok(r.error && r.error.includes('429'), JSON.stringify(r));
  });

  test('沒有 draft 落進 store', () => {
    assert.equal(stored.length, 0, JSON.stringify(stored.length));
  });

  // 錢已經花出去了（請求發出去了），賬要記上。
  test('仍然報了一次', () => {
    assert.equal(ctx.usage.calls, 1);
  });
});

describe('工具定義本身', () => {
  test('標了 costly', () => {
    assert.equal(tool().costly, true);
  });

  // 一個字都不寫磁碟。
  test('沒標 mutating', () => {
    assert.ok(!tool().mutating, String(tool().mutating));
  });

  // 領域知識在 context/prompts.ts 裡，由 generate 內部那次呼叫自己帶著。
  // 在工具描述裡再寫一遍會白燒 token，且兩處遲早跑偏。
  test('描述裡不寫領域知識', () => {
    const d = tool().description;
    assert.ok(!d.includes('天氣'), d);
    assert.ok(!d.includes('臺詞'), d);
    assert.ok(!d.includes('畫面'), d);
  });

  test('描述裡給出各層的路徑形狀（架構 / 細綱 / 章節）', () => {
    const d = tool().description;
    assert.ok(d.includes('config.md') && d.includes('.novelwarden/summaries/') && d.includes('chapters/'), d);
  });

  // agent 照著描述裡的老路徑給 `plots/`，會被當場攔下（見上面「認不出的路徑」）——白走一趟。
  test('描述裡不再提老的 plots/ 目錄', () => {
    assert.ok(!tool().description.includes('plots/'), tool().description);
  });

  test('描述裡的能力清單沒有 split', () => {
    assert.ok(!tool().description.includes('split'), tool().description);
  });

  // 細綱路徑經 kindOfPath 恆判成細綱層、工具也沒有別的引數能改層——描述要是許諾
  // 「細綱路徑也能當正文層」，agent 照著給細綱路徑想寫正文，拿到的會是一份細綱
  // （還走了細綱那一檔的便宜模型）。
  test('描述不許諾「細綱路徑也能當正文層」，並說清細綱路徑永遠是細綱層', () => {
    assert.ok(!tool().description.includes('正文層也可以給那一章細綱的路徑'), tool().description);
    assert.ok(tool().description.includes('細綱路徑永遠是細綱層'), tool().description);
  });

  test('引數是扁平的五個標量', () => {
    const props = tool().parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ['ask', 'capability', 'target', 'targetWords', 'writeMode']);
    assert.ok(Object.values(props).every((p) => p.type !== 'object'), JSON.stringify(props));
  });
});
