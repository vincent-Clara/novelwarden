/**
 * 只讀三件套：`list` / `read` / `search`。
 *
 * 三個都是 `Workspace` 的薄包裝，所以這裡驗的**不是**底層行為（那有
 * `tests/integration/workspace/` 守著），而是這一層自己的活：
 *
 * 1. **壓成模型讀得動的形狀**——帶行號、帶路徑、帶字數；
 * 2. **截斷必須說出來**（AGENTS 第 2 條）：list 的「還有 N 項」、read 的
 *    「第 X–Y 行未讀」、search 的 ⚠；
 * 3. **出錯給 `error` 而不是拋**——模型看得到 error 就能換條路，拋出去會把
 *    整輪迴圈炸掉，而它本來只是猜錯了一個檔名；
 * 4. **一個字都不寫盤**：三期的 agent 沒有寫許可權。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let ctx;

/** 跑一個工具，返回 ToolResult。 */
const run = (tool, args = {}) => tool.run(ctx, args);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    tools: './src/core/tools/novel/index.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'agenttools' });
  project = t.project;

  // 三章正文，只有第 9 章提到「北境」。刻意亂序建，用來驗排序不是檔案系統順序。
  t.write('chapters/012-入宗.md', '# 入宗\n\n他站在山門外。\n牆很高。\n');
  t.write('chapters/009-北行.md', '# 北行\n\n「我從沒去過北境。」他說。\n那年他十七。\n');
  t.write('chapters/003-楔子.md', '# 楔子\n\n雨下了三天。\n北境的雪他見過三回。\n');
  t.write(
    '.novelwarden/summaries/012-入宗.md',
    '## 梗概\n\n翻牆進宗門\n\n## 關鍵事件\n\n山門外等到天黑，三拍\n\n## 看點\n\n令牌\n'
  );
  // 100 行的長檔案，用來逼出 read 的行數截斷。
  t.write('chapters/020-長章.md', Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  // 80 個角色卡：逼出 list 的 60 項上限。
  for (let i = 1; i <= 80; i++) {
    t.write(`.novelwarden/characters/角色${String(i).padStart(2, '0')}.md`, `# 角色${i}\n`);
  }
  project.invalidate();

  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { put() {} },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report() {},
  };
});

after(() => {
  if (t) cleanup(t.dir);
});

const toolOf = (name) => bundle.tools.NOVEL_TOOLS.find((x) => x.name === name);

describe('list', () => {
  test('列得出章節目錄裡的檔案', async () => {
    const r = await run(toolOf('list'), { path: 'chapters' });
    assert.ok(r.text.includes('009-北行.md'), r.text);
  });

  test('檔案帶字數', async () => {
    const r = await run(toolOf('list'), { path: 'chapters' });
    assert.ok(/009-北行\.md\s+\d+ 字/.test(r.text), r.text);
  });

  test('目錄帶斜槓字尾，與檔案分得開', async () => {
    const r = await run(toolOf('list'), { path: '.novelwarden' });
    assert.ok(r.text.includes('summaries/'), r.text);
  });

  test('留空 path 列工程根', async () => {
    const r = await run(toolOf('list'), {});
    assert.ok(r.text.includes('chapters/'), r.text);
  });

  // 不靜默截斷。
  test('超 60 項時說明「還有 N 項未列出」', async () => {
    const r = await run(toolOf('list'), { path: '.novelwarden/characters' });
    assert.ok(/還有 \d+ 項未列出/.test(r.text), r.text.slice(-200));
  });

  test('截斷時只列 60 項', async () => {
    const r = await run(toolOf('list'), { path: '.novelwarden/characters' });
    const shown = r.text.split('\n').filter((l) => l.includes('.md')).length;
    assert.equal(shown, 60, String(shown));
  });

  test('總數寫在開頭', async () => {
    const r = await run(toolOf('list'), { path: '.novelwarden/characters' });
    assert.ok(r.text.startsWith('.novelwarden/characters（80 項）'), r.text.slice(0, 60));
  });

  // 越界不拋：這條路上的輸入來自模型，它會猜路徑。
  test('越界路徑給空結果而不是拋', async () => {
    const r = await run(toolOf('list'), { path: '../../etc' });
    assert.ok(r.text.includes('空目錄') || r.text.includes('0 項'), r.text);
  });

  test('不存在的目錄給一句人話', async () => {
    const r = await run(toolOf('list'), { path: 'chapters/根本沒有這個目錄' });
    assert.ok(r.text.includes('不存在') || r.text.includes('空目錄'), r.text);
  });
});

describe('read', () => {
  test('內容帶行號', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(r.text.includes('1\t# 北行'), JSON.stringify(r.text.slice(0, 80)));
  });

  test('開頭是路徑', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(r.text.startsWith('chapters/009-北行.md\n'), r.text.slice(0, 40));
  });

  test('短檔案不加截斷說明', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(!r.text.includes('未讀'), r.text);
  });

  test('offset 從指定行開始，行號跟著對', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-長章.md', offset: 50, limit: 3 });
    assert.ok(r.text.includes('50\t第 50 行'), r.text);
    assert.ok(!r.text.includes('49\t'), r.text);
  });

  // 不靜默截斷：模型不知道自己只看了一半，會拿半份正文下結論。
  test('超行數上限時說明「第 X–Y 行未讀」', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-長章.md', limit: 10 });
    assert.ok(/第 11–100 行未讀，共 100 行/.test(r.text), r.text.slice(-120));
  });

  test('截斷說明裡給出接著讀的 offset', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-長章.md', limit: 10 });
    assert.ok(r.text.includes('offset=11'), r.text.slice(-120));
  });

  // 拋出去會把整輪迴圈炸掉，而它本來只是猜錯了一個檔名。
  test('不存在的檔案給 error，不拋', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/根本沒有.md' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('error 說清楚了，模型能據此換路', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/根本沒有.md' });
    assert.ok(r.error.includes('不存在'), r.error);
    assert.ok(r.error.includes('list') || r.error.includes('search'), r.error);
  });

  test('越界路徑給 error，不拋', async () => {
    const r = await run(toolOf('read'), { path: '../../../etc/passwd' });
    assert.ok(r.error && r.error.includes('超出工程目錄'), JSON.stringify(r));
  });

  test('path 空著給 error', async () => {
    const r = await run(toolOf('read'), {});
    assert.ok(r.error && r.error.includes('必填'), JSON.stringify(r));
  });

  test('目錄不是檔案，給 error', async () => {
    const r = await run(toolOf('read'), { path: 'chapters' });
    assert.ok(r.error, JSON.stringify(r));
  });
});

describe('search', () => {
  test('命中帶路徑與行號', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    assert.ok(/chapters\/003-楔子\.md:\d+/.test(r.text), r.text);
  });

  test('命中帶整行原文', async () => {
    const r = await run(toolOf('search'), { pattern: '從沒去過北境' });
    assert.ok(r.text.includes('「我從沒去過北境。」他說。'), r.text);
  });

  // 作者問的是「他**前面**說過嗎」，時間線順序才有意義。
  test('跨章命中按章號升序', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    const order = r.text
      .split('\n')
      .map((l) => /chapters\/(\d+)-/.exec(l))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(order));
  });

  test('報出掃了幾個檔案', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    assert.ok(/掃了 \d+ 個檔案/.test(r.text), r.text);
  });

  test('kinds 限定生效', async () => {
    const r = await run(toolOf('search'), { pattern: '山門', kinds: ['plot'] });
    assert.ok(!r.text.includes('chapters/'), r.text);
    assert.ok(r.text.includes('.novelwarden/summaries/'), r.text);
  });

  test('認不出的 kinds 當沒限定，不是搜出空結果', async () => {
    const r = await run(toolOf('search'), { pattern: '北境', kinds: ['寫錯的種類名'] });
    assert.ok(r.text.includes('chapters/009-北行.md'), r.text);
  });

  test('path 限定生效', async () => {
    const r = await run(toolOf('search'), { pattern: '山門', path: '.novelwarden/summaries' });
    assert.ok(!r.text.includes('chapters/'), r.text);
  });

  // 模型看到「命中 2 處」會當成「全書只有 2 處」，然後據此斷言主角從沒提過北境。
  test('有丟棄時返回文字裡有 ⚠', async () => {
    const r = await run(toolOf('search'), { pattern: '行', limit: 1 });
    assert.ok(r.text.includes('⚠'), r.text);
  });

  test('⚠ 那句說清了丟了幾條', async () => {
    const r = await run(toolOf('search'), { pattern: '行', limit: 1 });
    assert.ok(/丟棄 \d+ 條/.test(r.text), r.text);
  });

  test('搜不到時明說沒命中', async () => {
    const r = await run(toolOf('search'), { pattern: '壓根不存在的一串字' });
    assert.ok(r.text.includes('沒有命中'), r.text);
  });

  test('pattern 空著給 error', async () => {
    const r = await run(toolOf('search'), { pattern: '  ' });
    assert.ok(r.error && r.error.includes('必填'), JSON.stringify(r));
  });

  test('壞正則降級成字面量並說明', async () => {
    const r = await run(toolOf('search'), { pattern: '北境(', regex: true });
    assert.ok(r.text.includes('⚠'), r.text);
  });
});

describe('三個工具都不寫盤', () => {
  let baseline;

  const snapshot = (dir) => {
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const p = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isFile()) {
        out[path.relative(dir, p)] = fs.statSync(p).mtimeMs;
      }
    }
    return out;
  };

  before(async () => {
    baseline = snapshot(t.dir);
    await run(toolOf('list'), { path: 'chapters' });
    await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    await run(toolOf('search'), { pattern: '北境' });
  });

  test('磁碟上一個檔案都沒變', () => {
    assert.deepEqual(snapshot(t.dir), baseline);
  });
});
