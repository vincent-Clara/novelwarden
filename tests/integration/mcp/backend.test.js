/**
 * MCP 執行端（`controller/mcp.ts`）：**外部 agent 的一次呼叫落到一個真的工程上。**
 *
 * 協議那一層在 `tests/unit/mcp/server.test.js`；這裡繞過協議直接調 `createMcpBackend`，
 * 守的是第 19 / 25 條在 MCP 這條路上還成立：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 查詢（read / list） | 不佔生成位、不進對話頁 |
 * | 查技能（skills list） | 帶 action 的工具按動作報閘門：查詢類同樣不進對話頁；綁技能（`always`）先問 |
 * | generate | 氣泡標 MCP、正文流進工具條、**當場問寫不寫**；同意才落盤，結論接在返回後面；**返回裡沒有正文** |
 * | generate 不採納 | 磁碟沒動，返回說「不要重複生成」 |
 * | 連著兩次呼叫 | 接在同一個氣泡裡；作者說過話就另起一個 |
 * | 生成位被佔 | 當場回 isError，不排隊 |
 * | edit（`always`） | 動手前先問；跳過就一字不改，返回說「不要重試」 |
 * | 引數不對 | 當場回 isError：不問、不佔生成位、不進對話頁 |
 * | 正文 writeMode=continue | 卡片寫追加，落盤接在已有正文後面 |
 * | 簡報 | 與狀態機同一句「下一步」 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const fs = require('fs');

const PLOT_JSON = JSON.stringify({
  梗概: '進入宗門',
  出场人物: '林昭',
  关键事件: '踩點、失手、翻牆；收在藏書閣門口。三拍推進。',
  看点: '第三塊令牌',
});

const P1 = '.novelwarden/summaries/001-夜入青雲.md';
const P2 = '.novelwarden/summaries/002-藏書閣.md';

let bundle;
let home;
let h;
let t;
let project;
let controller;
let backend;
let posted = [];
let gates = [];
/** 卡片來了怎麼答：返回 proceed / skip。 */
let onGate = async () => 'proceed';
let replyFn = () => PLOT_JSON;

const signal = () => new AbortController().signal;
const call = (name, args) => backend.call(name, args, signal());

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  // 「我的技能庫」指到臨時目錄：skills list 會列出它，不能讀到跑測試那臺機器上裝過的技能。
  home = makeTempDir('mcpSkillsHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  installFakeProvider(bundle.registry, {
    reply: () => replyFn(),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'mcp', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青雲'], [2, '藏書閣']]) {
    await ws.writePlot({
      no, title, upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: `第 ${no} 章要達成的事` },
    });
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
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
  backend = bundle.controller.createMcpBackend(controller);
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

function reset() {
  posted = [];
  gates = [];
}

const mcpTurns = () => controller.current.turns.filter((x) => x.mcp);

describe('查詢', () => {
  let r;
  before(async () => {
    reset();
    r = await call('read', { path: P1 });
  });

  test('讀得到', () => {
    assert.equal(r.isError, false);
    assert.ok(r.text.includes('第 1 章要達成的事'), r.text);
  });

  test('不進對話頁、不佔生成位', () => {
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone'].includes(m.type)), []);
    assert.equal(mcpTurns().length, 0);
  });
});

describe('generate → 當場問 → 同意才落盤', () => {
  let r;
  let diskWhenAsked;
  before(async () => {
    reset();
    onGate = async () => {
      diskWhenAsked = await project.readPlot(P1);
      return 'proceed';
    };
    r = await call('generate', { target: P1, capability: 'generate' });
  });

  test('氣泡標 MCP，掛一條工具條', () => {
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    const seg = turns[0].segments;
    assert.equal(seg.length, 1);
    assert.equal(seg[0].kind, 'tool');
    assert.equal(seg[0].call.name, 'generate');
  });

  test('正文流進那一條工具條下的卡片', () => {
    const deltas = posted.filter((m) => m.type === 'toolDelta').map((m) => m.text).join('');
    assert.ok(deltas.includes('進入宗門'), deltas);
    assert.ok(mcpTurns()[0].segments[0].call.output.includes('進入宗門'));
  });

  test('問了這一句，卡片掛在這個氣泡上', () => {
    assert.equal(gates.length, 1);
    assert.equal(gates[0].turnId, mcpTurns()[0].id);
    assert.ok(gates[0].title.startsWith('Agent 要'), gates[0].title);
  });

  test('還沒答時磁碟上沒動靜', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(diskWhenAsked.sections));
  });

  test('答了才落盤', async () => {
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['梗概'], '進入宗門');
  });

  test('返回裡沒有正文，只有形狀與結論', () => {
    assert.equal(r.isError, false);
    assert.ok(!r.text.includes('踩點、失手'), r.text);
    assert.ok(r.text.includes('draftId'), r.text);
    assert.ok(r.text.includes('不要再寫一遍'), r.text);
  });

  test('工具條上記著落盤結論', () => {
    assert.ok(mcpTurns()[0].segments[0].call.summary.includes('已寫入'), mcpTurns()[0].segments[0].call.summary);
  });

  test('收尾放開生成位', () => {
    assert.equal(controller.busy, false);
    const busy = posted.filter((m) => m.type === 'busy').map((m) => m.value);
    assert.deepEqual(busy, [true, false]);
  });
});

describe('generate 不採納', () => {
  let r;
  let before2;
  before(async () => {
    reset();
    before2 = await project.readPlot(P2);
    onGate = async () => 'skip';
    r = await call('generate', { target: P2, capability: 'generate' });
  });

  test('磁碟沒動', async () => {
    const plot = await project.readPlot(P2);
    assert.deepEqual(plot.sections, before2.sections);
  });

  test('返回說不要重複生成', () => {
    assert.ok(r.text.includes('不要重複生成'), r.text);
  });

  test('接在上一次的同一個氣泡裡', () => {
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].segments.length, 2);
  });

  test('作者說了話之後另起一個氣泡', async () => {
    controller.current.turns.push({ id: 'u-x', role: 'user', content: '先停一下', at: new Date().toISOString() });
    onGate = async () => 'skip';
    await call('generate', { target: P2, capability: 'generate' });
    assert.equal(mcpTurns().length, 2);
    assert.equal(controller.current.turns.at(-1).mcp, true);
  });
});

describe('生成位被佔', () => {
  test('當場回 isError，不排隊', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('generate', { target: P1, capability: 'generate' });
      assert.equal(r.isError, true);
      assert.ok(r.text.includes('另一個生成任務'), r.text);
    } finally {
      lease.release();
    }
  });
});

describe('edit：動手前先問', () => {
  test('跳過：一字不改，返回說不要重試', async () => {
    reset();
    onGate = async () => 'skip';
    const before3 = await project.readPlot(P1);
    const r = await call('edit', { path: P1, old: '進入宗門', new: '離開宗門' });
    assert.equal(gates.length, 1);
    assert.ok(gates[0].title.includes('改'), gates[0].title);
    assert.ok(r.text.includes('不要重試'), r.text);
    const after3 = await project.readPlot(P1);
    assert.deepEqual(after3.sections, before3.sections);
  });

  test('同意：改了', async () => {
    reset();
    onGate = async () => 'proceed';
    const r = await call('edit', { path: P1, old: '進入宗門', new: '離開宗門' });
    assert.equal(r.isError, false, r.text);
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['梗概'], '離開宗門');
  });
});

// 引數本來就不對的呼叫：不該先在對話頁彈一張「改「」裡的一段文字」，再等作者答完才報錯。
describe('引數不對：當場回話，不問、不佔生成位', () => {
  const cases = [
    ['edit 什麼都沒給', 'edit', {}, 'path 是必填的'],
    ['edit 缺 new', 'edit', { path: P1, old: '進入宗門' }, 'new 是必填的'],
    ['skills bind 缺 stage', 'skills', { action: 'bind', id: 'builtin:plain-prose' }, 'bind 需要引數：stage'],
    ['pipeline 認不出的動作', 'pipeline', { action: 'explode' }, '認不出動作「explode」'],
    ['generate 型別不對', 'generate', { target: P1, capability: 'generate', targetWords: '三千' }, 'targetWords 應該是整數'],
  ];
  for (const [label, name, args, want] of cases) {
    test(label, async () => {
      reset();
      onGate = async () => assert.fail('不該問作者');
      const r = await call(name, args);
      assert.equal(r.isError, true);
      assert.ok(r.text.includes(want), r.text);
      assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    });
  }

  test('生成位被佔時照樣先說引數不對', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('edit', {});
      assert.ok(r.text.includes('path 是必填的'), r.text);
    } finally {
      lease.release();
    }
  });
});

describe('generate 正文接著寫：落盤追加在已有正文後面', () => {
  const CH = 'chapters/001-夜入青雲.md';
  let r;
  before(async () => {
    reset();
    t.write(CH, '# 夜入青雲\n\n雨下了三天。\n');
    project.invalidate();
    replyFn = () => '林昭翻過了牆。';
    onGate = async () => 'proceed';
    r = await call('generate', { target: CH, capability: 'generate', writeMode: 'continue', targetWords: 10 });
  });

  test('卡片寫的是追加', () => {
    assert.ok(gates[0].title.includes('追加'), gates[0].title);
  });

  test('原有的正文還在，新寫的接在後面', async () => {
    const text = t.read(CH);
    assert.ok(text.indexOf('雨下了三天') >= 0 && text.indexOf('林昭翻過了牆') > text.indexOf('雨下了三天'), text);
    assert.equal(r.isError, false, r.text);
  });
});

// 動作工具的閘門按動作報：同一個 skills，list 是查詢，bind 要先問作者。
describe('skills：按動作分閘門', () => {
  test('list 是查詢：照樣列得出，不進對話頁、不佔生成位', async () => {
    reset();
    const turnsBefore = mcpTurns().length;
    const r = await call('skills', { action: 'list' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes('builtin:plain-prose'), r.text);
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    assert.equal(mcpTurns().length, turnsBefore);
  });

  // 繫結改的是這個工程往後每一次生成的提示詞，下游沒有 diff 可看：動手前問，跳過就不寫。
  test('bind 先在對話頁問；作者跳過就不寫 skills.json', async () => {
    reset();
    onGate = async () => 'skip';
    const r = await call('skills', { action: 'bind', id: 'builtin:plain-prose', stage: 'drafting' });
    assert.equal(gates.length, 1);
    assert.ok(gates[0].title.includes('綁到「寫正文」階段'), gates[0].title);
    assert.equal(r.isError, false, r.text);
    assert.equal(t.has('.novelwarden/skills.json'), false);
  });
});

describe('簡報', () => {
  test('說得出這本書走到哪、下一步是什麼', async () => {
    const brief = await backend.brief();
    assert.ok(brief.startsWith('# 當前工程'), brief);
    assert.ok(brief.includes('《青雲劍錄》'), brief);
    assert.ok(brief.includes('下一步'), brief);
  });
});
