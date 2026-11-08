/**
 * 帶 action 的工具共用的那一套（`tools/novel/actions.ts` 的 `defineActionTool`）。
 *
 * 六個工具（pipeline / summary / characters / extract / book / skills）各有一張動作表，
 * 引數校驗、拒絕清單、描述、閘門、記賬都由這一個工廠做。各工具自己的行為在同目錄的
 * `<工具>Tool.test.js`；這裡只釘工廠那一層：
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 刪除 / 改名 / 移動 / 拆分 / 解除安裝……被當成「有意不給」攔下 | 「認不出」會讓模型換十個名字繼續試；「這是有意的」能讓它停下來 |
 * | 認不出的動作列出這個工具可用的動作 | 列表裡只有這個工具的，模型不會跨工具去點 |
 * | 給了動作不認的引數當場報錯，說清誰認 | 以為傳了一個區間、其實被忽略，比多一次往返更糟 |
 * | 缺必填引數當場報錯，帶引數說明，不跑 | 不放它跑一趟空的 |
 * | 描述列出每個動作，標「調模型 / 不調模型」 | 模型據此決定要不要先問作者 |
 * | schema 是扁平標量，action 必填且是列舉 | 外部 agent 填巢狀物件最容易填錯 |
 * | 記賬：報幾次記幾次；引數錯不算執行失敗 | 第 4 條 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

const ACTION_TOOLS = ['pipeline', 'summary', 'characters', 'lore', 'extract', 'book', 'skills'];
const REFUSED = ['delete', 'remove', 'trash', 'rename', 'move', 'initProject', 'newChapter', 'split', 'uninstall'];

let bundle;
let ctx;
let reports;

const toolOf = (name) => bundle.tools.NOVEL_TOOLS.find((x) => x.name === name);

function resetCtx() {
  reports = [];
  ctx = {
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: (m) => reports.push(m),
    onDelta: () => {},
  };
}

/**
 * 一張假的動作表：不碰工程，只看工廠怎麼轉發。`ran` 記下每一次真正跑到 feature 的呼叫。
 */
let ran;
let fakeTool;

before(() => {
  bundle = loadBundle({
    tools: './src/core/tools/novel/index.ts',
    actions: './src/core/tools/novel/actions.ts',
    schema: './src/core/tools/schema.ts',
  });
  const { defineActionTool, ArgError } = bundle.actions;
  const { str } = bundle.schema;
  ran = [];
  fakeTool = defineActionTool({
    name: 'fake',
    summary: '假的動作表。',
    usage: '用法說明。',
    params: { path: str('那份檔案的路徑。'), name: str('那個人的名字。') },
    actions: {
      look: {
        label: '看一眼',
        costly: false,
        gate: 'auto',
        async run() {
          ran.push('look');
          return { text: '看過了', calls: 0 };
        },
      },
      spend: {
        label: '花三次',
        costly: true,
        uses: ['path', 'name'],
        requires: ['path'],
        async run(_ctx, args) {
          ran.push(['spend', args.path]);
          return { text: '花了', calls: 3 };
        },
      },
      badArg: {
        label: '引數值不對',
        costly: false,
        async run() {
          throw new ArgError('值不對。');
        },
      },
      boom: {
        label: '會炸',
        costly: true,
        async run() {
          throw new Error('磁碟滿了');
        },
      },
    },
  });
  resetCtx();
});

describe('故意不給的動作', () => {
  for (const name of ACTION_TOOLS) {
    test(`${name}：刪除、改名、拆分、解除安裝……都說清這是有意的`, async () => {
      for (const bad of REFUSED) {
        resetCtx();
        const r = await toolOf(name).run(ctx, { action: bad, path: 'x.md' });
        assert.ok(r.error?.includes('這個動作，而且這是有意的'), `${name} ${bad}: ${r.error}`);
        assert.ok(r.error.includes(`${name} 可用的是：`), r.error);
        assert.equal(ctx.usage.calls, 0);
      }
    });
  }

  // 拒絕在引數校驗之前：拿著 path 來刪東西，聽到的是「有意不給」，不是「不認 path」。
  test('拒絕的說法按動作分：刪除、改名、拆分正文', async () => {
    const say = async (action) => (await toolOf('pipeline').run(ctx, { action, path: 'x.md' })).error;
    assert.ok((await say('delete')).startsWith('沒有刪除這個動作，而且這是有意的——那類操作由作者自己做。'));
    assert.ok((await say('rename')).startsWith('沒有改名這個動作'));
    assert.ok((await say('split')).startsWith('沒有拆分正文這個動作'));
  });

  test('哪個工具的 action 列舉裡都沒有拒絕的動作', () => {
    for (const name of ACTION_TOOLS) {
      const values = toolOf(name).parameters.properties.action.enum;
      for (const bad of REFUSED) {
        assert.ok(!values.includes(bad), `${name} 的列舉裡有 ${bad}`);
      }
    }
  });
});

describe('認不出的動作', () => {
  test('列出這個工具可用的動作，且只列它自己的', async () => {
    const r = await toolOf('pipeline').run(ctx, { action: '把書寫完' });
    assert.equal(r.error, '認不出動作「把書寫完」。pipeline 可用的是：completeSettings / batchPlots / batchManuscripts / newPlot。');
  });

  // 拆過工具之後最常見的錯：拿 summary 的動作去調 pipeline。列表裡看得見該去哪。
  test('別的工具的動作也算認不出', async () => {
    const r = await toolOf('pipeline').run(ctx, { action: 'finalize', path: 'x.md' });
    assert.ok(r.error.startsWith('認不出動作「finalize」。'), r.error);
  });

  test('action 必填', async () => {
    const r = await toolOf('summary').run(ctx, {});
    assert.equal(r.error, 'action 是必填的。summary 可用的是：finalize / sync / rebuildGlobal。');
  });

  test('前後的空白不算', async () => {
    resetCtx();
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: '  look ' });
    assert.equal(r.text, '看過了');
    assert.deepEqual(ran, ['look']);
  });
});

describe('引數對得上動作', () => {
  test('給了動作不認的引數：當場報錯，說清誰認，不跑', async () => {
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: 'look', path: 'a.md' });
    assert.equal(r.error, 'look 不認 path，只有 spend 認。');
    assert.deepEqual(ran, []);
  });

  // 外部 agent 常把沒填的引數顯式寫成 undefined：那不算給了。
  test('值是 undefined 的引數不算給了', async () => {
    const r = await fakeTool.run(ctx, { action: 'look', path: undefined });
    assert.equal(r.error, undefined, r.error);
  });

  test('缺必填：報錯帶引數說明，不跑', async () => {
    ran.length = 0;
    const r = await fakeTool.run(ctx, { action: 'spend', name: '林昭' });
    assert.equal(r.error, 'spend 需要引數：path。path：那份檔案的路徑。');
    assert.deepEqual(ran, []);
  });

  test('只有空白的必填也算缺', async () => {
    const r = await fakeTool.run(ctx, { action: 'spend', path: '  ' });
    assert.ok(r.error?.startsWith('spend 需要引數：path。'), r.error);
  });
});

describe('執行與記賬', () => {
  test('報幾次記幾次，氣泡裡說出來，display 寫著次數', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'spend', path: 'a.md' });
    assert.equal(r.text, '花了');
    assert.equal(ctx.usage.calls, 3);
    assert.deepEqual(reports, ['花三次：呼叫模型 3 次']);
    assert.deepEqual(r.display, { title: 'fake spend', detail: '3 次呼叫' });
  });

  test('0 次不進氣泡，display 寫「未調模型」', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'look' });
    assert.deepEqual(reports, []);
    assert.deepEqual(r.display, { title: 'fake look', detail: '未調模型' });
  });

  // 引數值不對是模型能當場改的錯，原樣回給它；不掛「xx 失敗」的字首，那會讓它以為是工程出了事。
  test('ArgError 原樣回給模型', async () => {
    const r = await fakeTool.run(ctx, { action: 'badArg' });
    assert.equal(r.error, '值不對。');
  });

  test('feature 拋錯：掛上動作的說法，賬上不記', async () => {
    resetCtx();
    const r = await fakeTool.run(ctx, { action: 'boom' });
    assert.ok(r.error.startsWith('會炸失敗：'), r.error);
    assert.ok(r.error.includes('磁碟滿了'), r.error);
    assert.equal(ctx.usage.calls, 0);
  });
});

describe('描述與 schema', () => {
  test('描述 = 一句話 + 每個動作（調模型 / 不調模型、要什麼引數）+ 用法', () => {
    assert.equal(
      fakeTool.description,
      '假的動作表。可用的 action：look=看一眼（不調模型）；spend=花三次（調模型，要 path）；' +
        'badArg=引數值不對（不調模型）；boom=會炸（調模型）。用法說明。'
    );
  });

  for (const name of ACTION_TOOLS) {
    test(`${name}：描述列出每個動作，標明調不調模型`, () => {
      const tool = toolOf(name);
      for (const a of tool.parameters.properties.action.enum) {
        // 說法裡自己也可能帶括號與分號：認的是每一條末尾那個「（調模型…）」後面緊跟的分隔符。
        assert.match(tool.description, new RegExp(`(：|；)${a}=.*?（(調模型|不調模型)(，要 [^）]+)?）(；|。)`), `${name} ${a}`);
      }
    });

    test(`${name}：引數是扁平標量，action 必填`, () => {
      const schema = toolOf(name).parameters;
      assert.equal(schema.type, 'object');
      assert.deepEqual(schema.required, ['action']);
      assert.equal(schema.additionalProperties, false);
      for (const [key, p] of Object.entries(schema.properties)) {
        assert.ok(['string', 'integer', 'number', 'boolean'].includes(p.type), `${name}.${key}: ${JSON.stringify(p)}`);
        assert.ok(p.description, `${name}.${key} 沒有說明`);
      }
    });
  }

  // 工具級的兩個標記由動作表推出：有一個動作調模型就 costly，有一個動作不是 auto 就 mutating。
  test('工具級標記由動作表推出', () => {
    assert.equal(fakeTool.costly, true);
    assert.equal(fakeTool.mutating, true);
    const flags = Object.fromEntries(ACTION_TOOLS.map((n) => [n, [toolOf(n).costly, toolOf(n).mutating]]));
    assert.deepEqual(flags, {
      pipeline: [true, true],
      summary: [true, true],
      characters: [true, true],
      lore: [true, true],
      extract: [true, true],
      book: [true, true],
      skills: [false, true],
    });
  });
});

describe('意图', () => {
  test('預設 mutating，標題是動作的說法；調模型的提醒隨後還有一問', () => {
    const i = fakeTool.intent({ action: 'spend', path: 'a.md', name: '林昭' });
    assert.equal(i.gate, 'mutating');
    assert.equal(i.title, '花三次');
    assert.equal(i.detail, 'a.md 林昭\n要調模型的動作隨後還會告訴你預計呼叫幾次，那一步你也可以不同意。');
  });

  test('查詢類報 auto', () => {
    assert.equal(fakeTool.intent({ action: 'look' }).gate, 'auto');
  });

  test('認不出的動作歸 mutating', () => {
    const i = fakeTool.intent({ action: 'delete' });
    assert.equal(i.gate, 'mutating');
    assert.equal(i.title, '執行 fake delete');
  });
});
