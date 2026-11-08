/**
 * `generation/generate.ts`：裝配 → 調模型 → 解析 → 產出 Draft。
 *
 * 這一層**一個字都不寫磁碟**（落盤在 `workspace/`，且只在使用者點了採納之後），
 * 所以這裡要釘住的是三件事：
 *
 * 1. **產出的 Draft 自帶 artifact 與 summary**——從前生成一次要解析三次
 *    （生成時、後端畫卡片時、採納時），中間那次是多餘的。
 * 2. **`cleanOutput` 只對正文層做**——那幾條正則跑在 JSON 產物上會切壞結構。
 * 3. **失敗掛在細綱上、成功清掉**（AGENTS 第 16 條），取消不算失敗；架構與大綱沒有
 *    歸屬的那一行，失敗只進日誌。
 *
 * 細綱與單章摘要併成一份之後是七節（梗概 / 出場人物 / 時間地點 / 關鍵事件 / 看點 /
 * 狀態變更 / 連續性事實），落在 `summaries/`；架構層四件同屬一個階段，解析要看 target 才分得清。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

// 模型只答了七節裡的三節：沒寫的小節留空，形狀描述照實說「3/7 節」。
const PLOT_JSON = JSON.stringify({
  梗概: '林昭夜裡摸進青雲宗',
  关键事件: '踩點、失手、翻牆；收在藏書閣門口。三拍推進。',
  看点: '第三塊令牌',
});

let bundle;
let gen;
let h;
let fake;
let t;
let project;

/** `config.read()` 的返回值。 */
let settings = {};
/** 第 N 次呼叫該回什麼。 */
let replyFn = () => '';
/** warn / error 級日誌。 */
const warns = [];

function configure(extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    ...extra,
  };
  fake.calls.length = 0;
  warns.length = 0;
  h.answers.length = 0;
}

/** 收一次生成的全部回呼。 */
function recorder() {
  const r = { deltas: [], reasoning: [], done: undefined, error: undefined, cancelled: false };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: (d) => r.reasoning.push(d),
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => { r.cancelled = true; },
    },
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
    logger: './src/core/runtime/logger.ts',
  });
  gen = bundle.generate;

  h = makeFakeHost({
    name: 'standalone',
    supportsVscodeLm: true,
    settings: () => settings,
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  bundle.logger.addLogSink((e) => {
    if (e.level === 'warn' || e.level === 'error') {
      warns.push(`${e.message} ${e.detail ?? ''}`);
    }
  });
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'generate', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  await ws.writePlot({
    no: 1,
    title: '夜入青雲',
    upstreamHash: '',
    done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: '林昭進入宗門' },
  });
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const PLOT_TARGET = { kind: 'plot', plotRelPath: '.novelwarden/summaries/001-夜入青雲.md' };

describe('細綱層 · 產出 Draft', () => {
  let out;
  let rec;

  before(async () => {
    configure();
    replyFn = () => PLOT_JSON;
    rec = recorder();
    out = await gen.generate(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: '排一下這一章' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('調了一次模型', () => {
    assert.equal(fake.calls.length, 1, `調了 ${fake.calls.length} 次`);
  });

  test('產出了 draft', () => {
    assert.ok(out.draft, JSON.stringify(out));
  });

  test('draft 帶 id', () => {
    assert.ok(out.draft.id && typeof out.draft.id === 'string', out.draft.id);
  });

  test('draft 記下了 action 與 target', () => {
    assert.equal(out.draft.action.capability, 'generate');
    assert.equal(out.draft.target.plotRelPath, PLOT_TARGET.plotRelPath);
  });

  // 生成時就帶上 artifact：從前要等前端拿到文字、後端再 parse 一次畫卡片。
  test('draft 自帶解析好的產物', () => {
    assert.equal(out.draft.artifact.kind, 'plot', JSON.stringify(out.draft.artifact));
  });

  // 章末鉤子不單列了，模型寫進「看點」的那一下原樣落在看點裡。
  test('產物的看點在', () => {
    assert.equal(out.draft.artifact.sections.看点, '第三塊令牌');
  });

  test('draft 自帶一句話形狀描述', () => {
    assert.equal(out.draft.summary, '細綱 · 3/7 節', out.draft.summary);
  });

  test('draft 記下字數', () => {
    assert.ok(out.draft.words > 0, String(out.draft.words));
  });

  test('draft 帶建立時間', () => {
    assert.ok(!Number.isNaN(Date.parse(out.draft.createdAt)), out.draft.createdAt);
  });

  test('回呼拿到了完整文字', () => {
    assert.equal(rec.r.done, PLOT_JSON, rec.r.done);
  });

  test('裝配結果一併回給呼叫方', () => {
    assert.ok(out.built && out.built.messages.length > 0);
  });

  // 一個字都不寫磁碟：落盤只在使用者點了採納之後（AGENTS 第 19 條）。
  test('細綱沒有被寫過', async () => {
    const plot = await project.readPlot(PLOT_TARGET.plotRelPath);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });
});

describe('正文層 · cleanOutput 只在這一層跑', () => {
  let manuscript;
  let plotRaw;

  before(async () => {
    configure();
    replyFn = () => '好的，以下是續寫：\n\n## 第一章 燈下\n\n雨下了三天。';
    const a = recorder();
    manuscript = (
      await gen.generate(
        project,
        {
          action: { stage: 'manuscript', capability: 'generate' },
          target: { kind: 'manuscript', plotRelPath: PLOT_TARGET.plotRelPath },
          ask: '接著寫',
        },
        a.handlers,
        { signal: new AbortController().signal }
      )
    ).draft;

    // 同一段文字走細綱層：那幾條正則會把 JSON 的第一行剝掉，絕不能跑。
    replyFn = () => `\`\`\`json\n${PLOT_JSON}\n\`\`\``;
    const b = recorder();
    plotRaw = (
      await gen.generate(
        project,
        { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: 'x' },
        b.handlers,
        { signal: new AbortController().signal }
      )
    ).draft.raw;
  });

  test('正文剝掉了開場白', () => {
    assert.ok(!manuscript.raw.includes('以下是續寫'), manuscript.raw);
  });

  test('正文剝掉了章節標題', () => {
    assert.ok(!manuscript.raw.includes('第一章 燈下'), manuscript.raw);
  });

  test('正文字身留著', () => {
    assert.ok(manuscript.raw.includes('雨下了三天'), manuscript.raw);
  });

  // 正文直接落同號的章節——但那是採納那一步的事。生成這一步一個字都不寫。
  test('正文層也不落盤：同號章節沒被建出來', async () => {
    project.invalidate();
    assert.deepEqual((await project.listChapters()).map((c) => c.relPath), []);
  });

  // 關鍵：JSON 產物原樣保留程式碼圍欄，剝圍欄是 `parseArtifact` 的活
  // （`stripCodeFence`），在這裡剝會把「去掉開場白」那幾條正則用到 JSON 上。
  test('JSON 產物不過 cleanOutput', () => {
    assert.ok(plotRaw.startsWith('```json'), plotRaw.slice(0, 40));
  });

  test('圍欄包著的 JSON 照樣解析得出來', async () => {
    const artifact = bundle.generate.parseDraftArtifact(
      { stage: 'plot', capability: 'generate' },
      plotRaw,
      PLOT_TARGET
    );
    assert.equal(artifact.sections.看点, '第三塊令牌', JSON.stringify(artifact));
  });
});

/**
 * 架構四件同屬一個階段：**解析要看 target 才分得清是哪一件**——角色圖譜產出的是
 * 一組角色卡，另外三件是一份文件。這是 `parseDraftArtifact` 多收一個 target 的原因。
 */
describe('架構層 · 同一階段的四件靠 target 分辨', () => {
  const act = { stage: 'setting', capability: 'generate' };
  const ROSTER = JSON.stringify({
    characters: [
      { name: '林昭', role: '主角', 身份: '火場裡活下來的孤兒' },
      { name: '沈青', role: '盟友', 身份: '客棧老闆娘' },
    ],
  });
  let roster;
  let config;
  let cardsAfter;

  before(async () => {
    configure();
    replyFn = () => ROSTER;
    roster = (
      await gen.generate(
        project,
        { action: act, target: { kind: 'setting', doc: 'characters' }, ask: '排一下角色' },
        recorder().handlers,
        { signal: new AbortController().signal }
      )
    ).draft;
    replyFn = () => '## 核心梗概\n\n林昭回青崖鎮查火。\n\n## 金手指\n\n一塊殘缺的令牌。';
    config = (
      await gen.generate(
        project,
        { action: act, target: { kind: 'setting', doc: 'config' }, ask: '展開這個腦洞' },
        recorder().handlers,
        { signal: new AbortController().signal }
      )
    ).draft;
    cardsAfter = await project.listCharacters();
  });

  test('角色圖譜解析成一組人', () => {
    assert.equal(roster.artifact.kind, 'characterRoster', JSON.stringify(roster.artifact));
    assert.equal(roster.summary, '角色圖譜 · 2 人', roster.summary);
  });

  test('小說配置解析成一份檔案', () => {
    assert.equal(config.artifact.kind, 'settingDoc', JSON.stringify(config.artifact));
    assert.equal(config.artifact.doc, 'config');
    assert.equal(config.summary, '小說配置 · 2/8 節', config.summary);
  });

  // 同一段文字，target 不同解析出來就不同：採納時重新解析也必須帶上 target。
  test('parseDraftArtifact 帶上 target 才認得出角色圖譜', () => {
    const withTarget = gen.parseDraftArtifact(act, ROSTER, { kind: 'setting', doc: 'characters' });
    assert.equal(withTarget.kind, 'characterRoster');
  });

  // 一個字都不寫磁碟：角色卡要等作者在卡片上點了寫入才建（第 19 條）。
  test('生成角色圖譜不建角色卡', () => {
    assert.deepEqual(cardsAfter.map((c) => c.name), []);
  });
});

describe('討論類能力 · 沒有可採納的東西', () => {
  let draft;

  before(async () => {
    configure();
    replyFn = () => '我覺得這一章的衝突可以提前。';
    const rec = recorder();
    draft = (
      await gen.generate(
        project,
        { action: { stage: 'plot', capability: 'discuss' }, target: PLOT_TARGET, ask: '你怎麼看' },
        rec.handlers,
        { signal: new AbortController().signal }
      )
    ).draft;
  });

  test('仍然產出 draft（文字要留在氣泡裡）', () => {
    assert.ok(draft, '討論也該有 draft');
  });

  test('draft 沒有 artifact', () => {
    assert.equal(draft.artifact, undefined, JSON.stringify(draft.artifact));
  });

  test('draft 沒有 summary', () => {
    assert.equal(draft.summary, undefined, draft.summary);
  });
});

describe('模型拋錯', () => {
  let rec;
  let out;
  let failures;

  before(async () => {
    configure();
    fake.reset();
    replyFn = () => {
      throw new bundle.provider.LlmError('假裝 429 限流');
    };
    rec = recorder();
    out = await gen.generate(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    // recordFailure 是 fire-and-forget。
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('onError 被呼叫', () => {
    assert.ok(rec.r.error && rec.r.error.includes('429'), rec.r.error);
  });

  test('沒有產出 draft', () => {
    assert.equal(out.draft, undefined, JSON.stringify(out.draft));
  });

  // 第 16 條：失敗要留在出錯的東西身上，toast 五秒就沒了。
  test('失敗掛在細綱上', () => {
    assert.ok(failures[PLOT_TARGET.plotRelPath], JSON.stringify(Object.keys(failures)));
  });

  test('失敗進日誌', () => {
    assert.ok(warns.some((w) => w.includes('429')), warns.join('|'));
  });
});

describe('成功要清掉失敗標記', () => {
  let failures;

  before(async () => {
    configure();
    replyFn = () => PLOT_JSON;
    const rec = recorder();
    await gen.generate(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  // 修好了還掛著標記，使用者會學會無視它。
  test('細綱上的紅標記沒了', () => {
    assert.ok(!failures[PLOT_TARGET.plotRelPath], JSON.stringify(failures));
  });
});

/**
 * 失敗掛在**細綱**上（工程頁那一行）。架構與大綱沒有歸屬的那一行——失敗只進日誌，
 * 不憑空掛到某一章頭上。
 */
describe('模型拋錯 · 架構與大綱的失敗只進日誌', () => {
  let rec;
  let keysBefore;
  let keysAfter;

  before(async () => {
    configure();
    keysBefore = Object.keys(await bundle.errorLog.listActiveFailures(project)).sort();
    replyFn = () => {
      throw new bundle.provider.LlmError('假裝 429 限流');
    };
    rec = recorder();
    await gen.generate(
      project,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'premise' }, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
    await gen.generate(
      project,
      { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, ask: 'x' },
      recorder().handlers,
      { signal: new AbortController().signal }
    );
    await sleep(50);
    keysAfter = Object.keys(await bundle.errorLog.listActiveFailures(project)).sort();
  });

  test('onError 被呼叫', () => {
    assert.ok(rec.r.error && rec.r.error.includes('429'), rec.r.error);
  });

  test('不憑空掛到某一章上', () => {
    assert.deepEqual(keysAfter, keysBefore);
  });

  test('失敗進日誌', () => {
    assert.ok(warns.some((w) => w.includes('429')), warns.join('|'));
  });
});

describe('取消', () => {
  let rec;
  let failures;

  before(async () => {
    configure();
    replyFn = () => {
      throw new bundle.provider.CancelledError();
    };
    rec = recorder();
    const abort = new AbortController();
    await gen.generate(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: abort.signal }
    );
    await sleep(50);
    failures = await bundle.errorLog.listActiveFailures(project);
  });

  test('onCancelled 被呼叫', () => {
    assert.ok(rec.r.cancelled);
  });

  test('取消不報錯', () => {
    assert.equal(rec.r.error, undefined, rec.r.error);
  });

  // 使用者自己點的停止不是失敗，掛個紅標記只會讓他以為出了問題。
  test('取消不記失敗', () => {
    assert.ok(!failures[PLOT_TARGET.plotRelPath], JSON.stringify(failures));
  });
});

describe('模型引用無效時不調模型', () => {
  let rec;
  let out;
  let callsBefore;

  before(async () => {
    configure({ providers: [], models: [] });
    callsBefore = fake.calls.length;
    rec = recorder();
    out = await gen.generate(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: PLOT_TARGET, ask: 'x' },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('說明瞭原因', () => {
    assert.ok(rec.r.error, '應當 onError');
  });

  test('沒有調模型', () => {
    assert.equal(fake.calls.length, callsBefore);
  });

  test('沒有 draft 也沒有 built', () => {
    assert.equal(out.draft, undefined);
    assert.equal(out.built, undefined);
  });
});

describe('裝配明細 · 降級與丟棄進 warn 日誌', () => {
  before(async () => {
    // 預算壓到最小，長附件必然被截斷或丟棄。「不靜默截斷」要求它進日誌。
    configure({
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 2000, maxOutputTokens: 500 }] }],
      models: ['p/m'],
    });
    replyFn = () => PLOT_JSON;
    const rec = recorder();
    await gen.generate(
      project,
      {
        action: { stage: 'plot', capability: 'generate' },
        target: PLOT_TARGET,
        ask: 'x',
        attachments: [{ id: 'big', kind: 'file', label: '大檔案', text: '雨'.repeat(20000) }],
      },
      rec.handlers,
      { signal: new AbortController().signal }
    );
  });

  test('降級/丟棄的條目進了 warn 日誌', () => {
    assert.ok(warns.some((w) => w.includes('降級') || w.includes('丟棄')), warns.join('|'));
  });

  // 一次正文生成的 prompt 有十萬字，進了緩衝會把此前所有日誌擠沒。
  test('日誌裡沒有 prompt 全文', () => {
    assert.ok(!warns.some((w) => w.includes('雨雨雨雨雨雨雨雨雨雨')), warns.join('|').slice(0, 200));
  });
});

describe('previewContext · 只裝配不調模型', () => {
  let built;
  let callsBefore;

  before(async () => {
    configure();
    callsBefore = fake.calls.length;
    built = await gen.previewContext(project, {
      action: { stage: 'plot', capability: 'generate' },
      target: PLOT_TARGET,
      ask: '預覽一下',
    });
  });

  test('裝出了訊息', () => {
    assert.ok(built.messages.length > 0);
  });

  test('一次模型都沒調', () => {
    assert.equal(fake.calls.length, callsBefore);
  });
});
