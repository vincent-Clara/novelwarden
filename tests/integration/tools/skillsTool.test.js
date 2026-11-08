/**
 * `skills` 工具：寫作技能的查、檢查、安裝、繫結（移植自 AI-Novel-Writer 的 inspect / install / bind
 * 三個工具，多一個 list 用來查 id）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 查與檢查 `auto`；安裝與繫結 `always` | 上游這兩個都要確認；它們改的東西下游沒有 diff 可看 |
 * | 安裝的確認框說清裝的是哪一份、正文開頭是什麼 | 上游的確認卡只顯示一個地址 |
 * | 檢查的回話說清後設資料不可信、安裝要作者確認 | 照搬上游的 note |
 * | 一個模型都不調 | 賬上記 0 |
 * | 解除安裝被當成有意不給的動作攔下 | 與刪除同理 |
 * | 引數給錯動作當場報錯 | 模型以為傳了、其實被忽略，比多一次往返更糟 |
 * | 工具一個模型都不調，但不只讀 | 裝與綁會改東西：MCP 上落成 readOnlyHint=false |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const URL = 'https://github.com/o/r/tree/main/scene';
const RAW = 'https://raw.githubusercontent.com/o/r/main/scene/SKILL.md';
const SKILL = '---\nname: scene-craft\ndisplay_name: 場面寫法\ndescription: 寫場面的辦法\n---\n每一場都要有一個選擇。\n';

let bundle;
let t;
let home;
let ctx;
const realFetch = globalThis.fetch;

const tool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'skills');
const run = (args) => tool().run(ctx, args);
const gateOf = (args) => tool().intent(args).gate;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    skills: './src/core/skills/index.ts',
    tools: './src/core/tools/novel/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost().host);
  home = makeTempDir('skillsToolHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  t = await makeTempProject(bundle.project, { prefix: 'skillsTool', title: '技能動作' });
  globalThis.fetch = async (url) => (url === RAW ? new Response(SKILL, { status: 200 }) : new Response('nope', { status: 404 }));
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
});

after(() => {
  globalThis.fetch = realFetch;
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  if (t) cleanup(t.dir, bundle?.db);
});

describe('閘門按動作分', () => {
  test('查與檢查不問', () => {
    assert.deepEqual([gateOf({ action: 'list' }), gateOf({ action: 'inspect', url: URL })], ['auto', 'auto']);
  });

  test('安裝與繫結三種策略都問', () => {
    assert.deepEqual(
      [gateOf({ action: 'install', url: URL }), gateOf({ action: 'bind', id: 'builtin:x', stage: 'review' })],
      ['always', 'always']
    );
  });

  // 認不出的動作在執行時會被拒；問的那一步按預設 mutating 走，不因為同屬 skills 就跟著 auto。
  test('認不出的動作歸 mutating', () => {
    assert.equal(gateOf({ action: 'uninstall' }), 'mutating');
  });

  test('沒檢查過就要裝：確認框先說會被拒絕', () => {
    assert.ok(tool().intent({ action: 'install', url: 'https://github.com/x/y' }).detail.includes('還沒檢查過'));
  });

  // 不然 agent 用 write 新建一份 skills.json，就繞過了 bind 那一問。
  test('write 新建 / 追加技能檔案也是三種策略都問；別的檔案照舊', () => {
    const write = bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
    const gate = (path, mode) => write.intent({ path, mode }, t.project).gate;
    assert.deepEqual(
      [
        gate('.novelwarden/skills.json'),
        gate('.novelwarden/skills/x/SKILL.md', 'append'),
        gate('.novelwarden/skills.json', 'overwrite'),
        gate('.novelwarden/style.md'),
      ],
      ['always', 'always', 'reviewed', 'mutating']
    );
  });

  test('繫結的確認框說清階段', () => {
    assert.equal(
      tool().intent({ action: 'bind', id: 'builtin:plain-prose', stage: 'drafting' }).title,
      '把寫作技能 builtin:plain-prose 綁到「寫正文」階段'
    );
  });
});

describe('list', () => {
  let r;
  before(async () => {
    r = await run({ action: 'list' });
  });

  test('列出內建的 id，寫明可綁', () => {
    assert.ok(r.text.includes('- builtin:plain-prose｜去 AI 味（寫正文）｜內建｜建議 drafting｜可綁'), r.text);
  });

  test('寫明本工程每個階段綁了什麼', () => {
    assert.ok(r.text.includes('本工程的繫結：planning=（沒綁）；drafting=（沒綁）；review=（沒綁）；refinement=（沒綁）。'), r.text);
  });

  test('一個模型都不調', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('檢查 → 安裝 → 繫結', () => {
  let inspected;
  before(async () => {
    inspected = await run({ action: 'inspect', url: URL });
  });

  test('檢查的回話寫明可以裝，後設資料不可信、安裝要作者確認', () => {
    assert.ok(inspected.text.includes('檢查了「場面寫法」（name=scene-craft）：寫場面的辦法。'), inspected.text);
    assert.ok(inspected.text.includes('可以裝。') && inspected.text.includes('不受信任的第三方檔案'), inspected.text);
    // 下一步該調哪個動作寫在回話裡：動作名要與這個工具的列舉對得上。
    assert.ok(inspected.text.includes('（install，url 用同一個地址）'), inspected.text);
  });

  test('檢查過之後，安裝的確認框說清是哪一份、正文開頭是什麼', () => {
    const intent = tool().intent({ action: 'install', url: URL });
    assert.equal(intent.title, '把寫作技能「場面寫法」裝進我的技能庫');
    assert.ok(intent.detail.includes('正文開頭：每一場都要有一個選擇。'), intent.detail);
  });

  test('安裝：裝進我的技能庫，說清還沒綁', async () => {
    const r = await run({ action: 'install', url: URL });
    assert.equal(r.text, '已裝進我的技能庫：user:scene-craft（場面寫法）。它還沒綁到任何階段。');
    assert.ok(fs.existsSync(home.rel('skills/scene-craft/SKILL.md')));
  });

  test('繫結：寫進本工程的 skills.json', async () => {
    const r = await run({ action: 'bind', id: 'user:scene-craft', stage: 'drafting' });
    assert.ok(!r.error, r.error);
    assert.deepEqual(JSON.parse(t.read('.novelwarden/skills.json')).bindings, { drafting: 'user:scene-craft' });
  });

  test('一個模型都沒調', () => {
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('引數與拒絕', () => {
  // stage 是 bind 的必填：缺了在動手前就攔下，帶上階段的說明。
  test('bind 沒給 stage', async () => {
    const r = await run({ action: 'bind', id: 'builtin:plain-prose' });
    assert.ok(r.error.startsWith('bind 需要引數：stage。stage：綁到哪個階段'), r.error);
  });

  test('bind 兩個都沒給：一次說全', async () => {
    const r = await run({ action: 'bind' });
    assert.ok(r.error.startsWith('bind 需要引數：id、stage。'), r.error);
  });

  test('bind 給了認不出的 stage', async () => {
    const r = await run({ action: 'bind', id: 'builtin:plain-prose', stage: 'polish' });
    assert.equal(r.error, 'stage 只能是 planning / drafting / review / refinement。');
  });

  test('bind 綁一份不存在的技能', async () => {
    assert.ok((await run({ action: 'bind', id: 'user:never-was', stage: 'review' })).error.includes('找不到技能'));
  });

  test('inspect 沒給 url', async () => {
    assert.ok((await run({ action: 'inspect' })).error.startsWith('inspect 需要引數：url。'));
  });

  // 從前 bind 的 id 走的是 name：拿著老提示詞來的模型要聽到「不認 name」，而不是被靜默忽略。
  test('bind 給了 name 當場報錯', async () => {
    const r = await run({ action: 'bind', name: 'builtin:plain-prose', stage: 'review' });
    assert.equal(r.error, 'bind 不認 name。');
  });

  test('別的動作給了 url / stage 當場報錯，說清誰認', async () => {
    const [a, b] = await Promise.all([run({ action: 'list', url: URL }), run({ action: 'inspect', url: URL, stage: 'review' })]);
    assert.equal(a.error, 'list 不認 url，只有 inspect / install 認。');
    assert.equal(b.error, 'inspect 不認 stage，只有 bind 認。');
  });

  test('解除安裝技能被當成有意不給的動作攔下', async () => {
    for (const action of ['uninstall', 'uninstallSkill']) {
      const r = await run({ action, id: 'user:scene-craft' });
      assert.ok(r.error.includes('沒有解除安裝技能這個動作，而且這是有意的'), r.error);
    }
    assert.ok(fs.existsSync(home.rel('skills/scene-craft/SKILL.md')));
  });
});

describe('工具定義本身', () => {
  test('引數：action、url、id、stage', () => {
    assert.deepEqual(Object.keys(tool().parameters.properties).sort(), ['action', 'id', 'stage', 'url']);
    assert.deepEqual(tool().parameters.properties.stage.enum, ['planning', 'drafting', 'review', 'refinement']);
  });

  // 一個模型都不調，但裝與綁改東西：不 costly，mutating。
  test('不 costly，但 mutating', () => {
    assert.equal(tool().costly, false);
    assert.equal(tool().mutating, true);
  });

  test('描述裡寫著先 inspect 再 install、裝完 bind', () => {
    assert.ok(tool().description.includes('先 inspect 再 install（同一個 url），裝完用 bind 綁到階段才會用上'), tool().description);
  });
});
