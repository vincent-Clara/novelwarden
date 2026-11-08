/**
 * 模型池：構造與剔除、併發輪轉、序列恆用首選、隨機 fallback，以及模型分檔在池上的落法。
 * 遷自 scripts/smoke-pool.js 的 `== 模型池：… ==` 與 `== 模型分檔：… ==` 各節。
 *
 * 出錯的後果很隱蔽：fallback 挑錯模型會把使用者沒配 Key 的模型也算進去；取消後還接著
 * 起新任務，使用者點了「停止」卻停不下來。這些手測都看不出來，所以用假 provider 全部釘住。
 *
 * host / registry / config 都有模組級狀態，所以這幾個模組必須打進同一個 bundle。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');

/** 當前這一輪測試的配置。每個用例自己改。 */
let settings = {};
/** ref -> 這一輪該怎麼表現。注意：必須**就地改**，假工廠是按引用閉包捕獲它的。 */
const behavior = {};
const warns = [];

let createModelPool;
let collectText;
let fake;
let host;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    concurrency: './src/core/runtime/concurrency.ts',
    pool: './src/core/llm/pool.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    collect: './src/core/llm/collect.ts',
    logger: './src/core/runtime/logger.ts',
  });

  ({ createModelPool } = bundle.pool);
  ({ collectText } = bundle.collect);

  host = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(host.host);

  bundle.logger.addLogSink((entry) => {
    if (entry.level === 'warn' || entry.level === 'error') {
      warns.push(`${entry.message} ${entry.detail ?? ''}`);
    }
  });

  // 假模型走 vscode-lm 這個 kind：它是唯一一條走 registerProviderFactory 的路徑，
  // 於是不必碰 SecretStore 就能塞進假模型（其餘 kind 會去要 API Key）。
  fake = installFakeProvider(bundle.registry, {
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    // helper 在記下 calls 之後會給該條打上 .ref，所以這裡拿得到當前模型引用。
    reply: (messages) => `ok:${messages.ref}`,
  });
});

/** 代替遷移前的 `behavior = {...}`：helper 閉包捕獲了這個物件，只能就地改。 */
function setBehavior(next) {
  for (const key of Object.keys(behavior)) delete behavior[key];
  Object.assign(behavior, next);
}

/** 配 N 個模型（都在 vscode-lm 服務商 `p` 下）。 */
function configure(refs, extra = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: refs.map((r) => ({ name: r.slice(2) })) }],
    models: refs,
    ...extra,
  };
  fake.reset();
  host.inputs.length = 0;
  warns.length = 0;
}

/**
 * 分檔用的配置：providers 從「所有被提到的引用」推出來，
 * 於是檔位裡的模型也解析得出。`windows` 可給單個模型指定視窗。
 */
function configureTiers({ models = [], tierModels = {}, taskTiers = {}, windows = {}, ...extra }) {
  const all = [...models, ...Object.values(tierModels).flat()];
  const names = [...new Set(all.map((r) => r.slice(2)))];
  settings = {
    providers: [
      {
        id: 'p',
        kind: 'vscode-lm',
        models: names.map((name) => ({ name, ...(windows[`p/${name}`] ?? {}) })),
      },
    ],
    models,
    tierModels,
    taskTiers,
    ...extra,
  };
  fake.reset();
  host.inputs.length = 0;
  warns.length = 0;
}

/** 讓 pool.run 的回呼「調一次模型」。 */
const useModel = (llm) => collectText(llm.stream([], {}));
/** 這一輪實際調過的模型引用。 */
const usedRefs = () => fake.calls.map((c) => c.ref);

describe('模型池：構造', () => {
  describe('三個模型都可用', () => {
    let pool;

    before(async () => {
      setBehavior({});
      configure(['p/a', 'p/b', 'p/c']);
      pool = await createModelPool({ task: 'plotSummary', concurrent: true });
    });

    test('三個模型都進了池', () => {
      assert.ok(pool && pool.size === 3, pool && pool.refs.join('、'));
    });

    test('label 報得出數量', () => {
      assert.ok(pool.label.includes('3 個模型'), pool.label);
    });

    test('primary 是第一個', () => {
      assert.equal(pool.primary.label, 'p/a', pool.primary.label);
    });
  });

  describe('構造不出來的被剔除', () => {
    let pool;
    let warnText;
    let inputCount;

    before(async () => {
      setBehavior({ 'p/b': 'unavailable' });
      configure(['p/a', 'p/b', 'p/c']);
      pool = await createModelPool({ task: 'plotSummary' });
      warnText = warns.join(' | ');
      inputCount = host.inputs.length;
    });

    test('構造不出來的模型被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/c', pool.refs.join(','));
    });

    test('剔除時說清是誰、為什麼', () => {
      assert.ok(warnText.includes('p/b'), warnText);
    });

    test('剔除備選模型時不彈輸入框', () => {
      assert.equal(inputCount, 0, `彈了 ${inputCount} 次`);
    });
  });

  describe('解析不出的引用被剔除', () => {
    let pool;
    let warnText;

    before(async () => {
      setBehavior({});
      configure(['p/a', 'nosuch/x', 'p/c']);
      pool = await createModelPool({ task: 'plotSummary' });
      warnText = warns.join(' | ');
    });

    test('解析不出的引用被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/c', pool.refs.join(','));
    });

    test('解析失敗的原因寫進日誌', () => {
      assert.ok(warnText.includes('nosuch/x'), warnText);
    });
  });

  describe('一個都不可用', () => {
    let pool;

    before(async () => {
      setBehavior({ 'p/a': 'unavailable' });
      configure(['p/a']);
      pool = await createModelPool({ task: 'plotSummary' });
    });

    test('一個可用模型都沒有時返回 undefined', () => {
      assert.equal(pool, undefined);
    });
  });
});

describe('模型池：併發輪轉（負載均衡）', () => {
  let counts;

  before(async () => {
    setBehavior({});
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'plotSummary', concurrent: true });
    for (let i = 0; i < 6; i++) {
      await pool.run(`第 ${i} 項`, useModel);
    }
    counts = {};
    for (const ref of usedRefs()) {
      counts[ref] = (counts[ref] ?? 0) + 1;
    }
  });

  test('6 次呼叫均攤到 3 個模型', () => {
    assert.equal(counts['p/a'], 2, JSON.stringify(counts));
    assert.equal(counts['p/b'], 2, JSON.stringify(counts));
    assert.equal(counts['p/c'], 2, JSON.stringify(counts));
  });

  test('輪轉是按配置順序起步的', () => {
    assert.equal(usedRefs().slice(0, 3).join(','), 'p/a,p/b,p/c', usedRefs().join(','));
  });
});

describe('模型池：序列恆用首選', () => {
  before(async () => {
    setBehavior({});
    configure(['p/a', 'p/b', 'p/c']);
    const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
    for (let i = 0; i < 4; i++) {
      await pool.run('x', useModel);
    }
  });

  test('序列模式每次都用第一個', () => {
    assert.ok(usedRefs().every((ref) => ref === 'p/a'), usedRefs().join(','));
  });
});

describe('模型池：隨機 fallback', () => {
  describe('首選失敗換人', () => {
    let text;
    let warnText;

    before(async () => {
      setBehavior({ 'p/a': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 2 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      text = await pool.run('第 1 章', useModel);
      warnText = warns.join(' | ');
    });

    test('首選失敗後換了別的模型', () => {
      assert.notEqual(text, 'ok:p/a', text);
      assert.ok(text.startsWith('ok:p/'), text);
    });

    test('換的是列表裡的其餘模型', () => {
      assert.ok(['ok:p/b', 'ok:p/c'].includes(text), text);
    });

    test('第一次仍然先試首選', () => {
      assert.equal(usedRefs()[0], 'p/a', usedRefs().join(','));
    });

    test('換模型時留下 warn', () => {
      assert.ok(warnText.includes('改用'), warnText);
    });
  });

  describe('全都失敗', () => {
    let err;

    before(async () => {
      setBehavior({ 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 1 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('全失敗時把錯誤拋出去', () => {
      assert.ok(!!err, String(err));
    });

    test('重試次數不超過 fallbackAttempts', () => {
      assert.equal(fake.callCount(), 2, `調了 ${fake.callCount()} 次`);
    });
  });

  describe('重試上限大於池子', () => {
    before(async () => {
      setBehavior({ 'p/a': 'fail', 'p/b': 'fail', 'p/c': 'fail' });
      configure(['p/a', 'p/b', 'p/c'], { fallbackAttempts: 5 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    test('不會把同一個模型試兩遍', () => {
      assert.equal(new Set(usedRefs()).size, usedRefs().length, usedRefs().join(','));
    });

    test('最多把池裡每個模型試一遍', () => {
      assert.equal(fake.callCount(), 3, `調了 ${fake.callCount()} 次`);
    });
  });

  describe('池裡只有一個模型', () => {
    before(async () => {
      setBehavior({ 'p/a': 'fail' });
      configure(['p/a'], { fallbackAttempts: 3 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    test('池裡只有一個模型時不重試（換誰都是它自己）', () => {
      assert.equal(fake.callCount(), 1, `調了 ${fake.callCount()} 次`);
    });
  });

  describe('使用者取消', () => {
    let err;

    before(async () => {
      setBehavior({ 'p/a': 'cancel' });
      configure(['p/a', 'p/b'], { fallbackAttempts: 3 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('使用者取消時不 fallback', () => {
      assert.equal(fake.callCount(), 1, `調了 ${fake.callCount()} 次`);
    });

    test('取消原樣上拋', () => {
      assert.ok(err && err.name === 'CancelledError', String(err));
    });
  });

  describe('fallbackAttempts=0', () => {
    before(async () => {
      setBehavior({});
      configure(['p/a', 'p/b'], { fallbackAttempts: 0 });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      // 逐字遷自 smoke-pool.js:426-432，包括這一行的位置。
      setBehavior({ 'p/a': 'fail' });
      await pool.run('第 1 章', useModel).catch(() => {});
    });

    // 注意：這條斷言是空轉的，遷移時原樣保留。假工廠在 createModelPool **建池時**
    // 就把 behavior[ref] 讀進了 spec（同檔案 `fallback 不跨檔` 一節的註釋說的就是這件事），
    // 所以上面那次「建池之後」才設的 'p/a': 'fail' 根本不生效——p/a 壓根沒失敗。
    // 於是 callCount === 1 只說明「成功呼叫了一次」，
    // **並不能證明 fallbackAttempts=0 關掉了重試**。要真測這件事，behavior 必須在建池前設好。
    test('fallbackAttempts=0 時不重試', () => {
      assert.equal(fake.callCount(), 1, `調了 ${fake.callCount()} 次`);
    });
  });
});

describe('模型分檔：檔位生效', () => {
  let fast;
  let merge;
  let card;

  before(async () => {
    setBehavior({});
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], balanced: ['p/mid'], quality: ['p/smart'] },
    });
    fast = await createModelPool({ task: 'plotSummary' });
    merge = await createModelPool({ task: 'globalSummaryMerge' });
    card = await createModelPool({ task: 'characterCard' });
  });

  test('單章摘要走快速檔', () => {
    assert.equal(fast.refs.join(','), 'p/cheap', fast.refs.join(','));
  });

  test('全文大綱最終合併走精標檔', () => {
    assert.equal(merge.refs.join(','), 'p/smart', merge.refs.join(','));
  });

  test('角色卡走均衡檔', () => {
    assert.equal(card.refs.join(','), 'p/mid', card.refs.join(','));
  });

  test('label 裡帶檔位名', () => {
    assert.ok(fast.label.includes('快速檔'), fast.label);
  });

  test('分檔不動對話頁的當前模型', () => {
    assert.equal(settings.models.join(','), 'p/writer', settings.models.join(','));
  });
});

describe('模型分檔：空檔位繼承預設模型', () => {
  describe('三檔全空', () => {
    let pool;

    before(async () => {
      setBehavior({});
      configureTiers({ models: ['p/a', 'p/b'], tierModels: {} });
      pool = await createModelPool({ task: 'plotSummary', concurrent: true });
      // 分檔之前的行為：併發輪轉、失敗換人，一條都不能少。
      setBehavior({});
      for (let i = 0; i < 4; i++) {
        await pool.run(`第 ${i} 項`, useModel);
      }
    });

    test('三檔全空時沿用 models', () => {
      assert.equal(pool.refs.join(','), 'p/a,p/b', pool.refs.join(','));
    });

    test('label 說明是沿用來的', () => {
      assert.ok(pool.label.includes('未配置，沿用預設模型'), pool.label);
    });

    test('未配檔時併發輪轉與分檔前一致', () => {
      assert.equal(usedRefs().join(','), 'p/a,p/b,p/a,p/b', usedRefs().join(','));
    });
  });

  describe('只配了快速檔', () => {
    let fast;
    let merge;

    before(async () => {
      // 只配了快速檔：其餘兩檔的任務仍走預設模型，不該被快速檔順手接管。
      setBehavior({});
      configureTiers({ models: ['p/writer'], tierModels: { fast: ['p/cheap'] } });
      fast = await createModelPool({ task: 'plotSummary' });
      merge = await createModelPool({ task: 'globalSummaryMerge' });
    });

    test('配了的檔用自己的模型', () => {
      assert.equal(fast.refs.join(','), 'p/cheap', fast.refs.join(','));
    });

    test('沒配的檔仍繼承 models', () => {
      assert.equal(merge.refs.join(','), 'p/writer', merge.refs.join(','));
    });
  });
});

describe('模型分檔：任務歸檔的覆蓋', () => {
  let pool;
  let fallbackPool;

  before(async () => {
    setBehavior({});
    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      // 內建預設裡單章摘要是快速檔，這裡改成精標。
      taskTiers: { plotSummary: 'quality' },
    });
    pool = await createModelPool({ task: 'plotSummary' });

    configureTiers({
      models: ['p/writer'],
      tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
      taskTiers: { plotSummary: '超級檔', nosuchTask: 'fast' },
    });
    fallbackPool = await createModelPool({ task: 'plotSummary' });
  });

  test('覆蓋優先於內建預設', () => {
    assert.equal(pool.refs.join(','), 'p/smart', pool.refs.join(','));
  });

  test('非法檔位名退回內建預設而不是崩', () => {
    assert.equal(fallbackPool.refs.join(','), 'p/cheap', fallbackPool.refs.join(','));
  });
});

describe('模型分檔：fallback 不跨檔', () => {
  describe('檔內還有人可換', () => {
    let used;

    before(async () => {
      // behavior 要在建池**之前**定：假工廠在構造 provider 時就把它讀走了。
      setBehavior({ 'p/cheap': 'fail' });
      configureTiers({
        models: ['p/writer'],
        tierModels: { fast: ['p/cheap', 'p/cheap2'], quality: ['p/smart'] },
        fallbackAttempts: 5,
      });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      await pool.run('第 1 章', useModel).catch(() => {});
      used = usedRefs();
    });

    test('檔內換人照舊生效', () => {
      assert.ok(used.includes('p/cheap2'), used.join(','));
    });

    test('絕不升級到精標檔的模型', () => {
      assert.ok(!used.includes('p/smart'), used.join(','));
    });
  });

  describe('檔內無人可換', () => {
    let err;

    before(async () => {
      // 檔內只有一個模型：無人可換，照舊上拋，不去別的檔找。
      setBehavior({ 'p/cheap': 'fail' });
      configureTiers({
        models: ['p/writer', 'p/spare'],
        tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
        fallbackAttempts: 5,
      });
      const pool = await createModelPool({ task: 'plotSummary', concurrent: false });
      try {
        await pool.run('第 1 章', useModel);
      } catch (e) {
        err = e;
      }
    });

    test('檔內無人可換時不重試', () => {
      assert.equal(fake.callCount(), 1, `調了 ${fake.callCount()} 次`);
    });

    test('錯誤照舊上拋', () => {
      assert.ok(!!err, String(err));
    });

    test('也不去 models 裡撈人', () => {
      assert.ok(
        !usedRefs().some((ref) => ref === 'p/writer' || ref === 'p/spare'),
        usedRefs().join(',')
      );
    });
  });
});

describe('模型分檔：Key 輸入框與預算', () => {
  describe('檔內備選缺 Key', () => {
    let pool;
    let inputCount;
    let warnText;

    before(async () => {
      setBehavior({ 'p/cheap2': 'unavailable' });
      configureTiers({
        models: ['p/writer'],
        tierModels: { fast: ['p/cheap', 'p/cheap2'] },
      });
      pool = await createModelPool({ task: 'plotSummary' });
      inputCount = host.inputs.length;
      warnText = warns.join(' | ');
    });

    test('檔內備選缺 Key 被剔除', () => {
      assert.equal(pool.refs.join(','), 'p/cheap', pool.refs.join(','));
    });

    test('剔除檔內備選時不彈輸入框', () => {
      assert.equal(inputCount, 0, `彈了 ${inputCount} 次`);
    });

    test('剔除原因寫進日誌', () => {
      assert.ok(warnText.includes('p/cheap2'), warnText);
    });
  });

  describe('預算跟著檔位走', () => {
    let fast;
    let merge;

    before(async () => {
      setBehavior({});
      configureTiers({
        models: ['p/writer'],
        tierModels: { fast: ['p/cheap'], quality: ['p/smart'] },
        windows: {
          'p/writer': { contextWindow: 200000, maxOutputTokens: 8000 },
          'p/cheap': { contextWindow: 32000, maxOutputTokens: 2000 },
        },
        contextWindow: 128000,
        maxOutputTokens: 4096,
      });
      fast = await createModelPool({ task: 'plotSummary' });
      merge = await createModelPool({ task: 'globalSummaryMerge' });
    });

    test('primaryBudget 取該檔首選的視窗，不是對話頁模型的', () => {
      assert.equal(fast.primaryBudget.contextWindow, 32000, String(fast.primaryBudget.contextWindow));
    });

    test('primaryBudget 的輸出上限同樣跟著該檔走', () => {
      assert.equal(fast.primaryBudget.maxOutputTokens, 2000, String(fast.primaryBudget.maxOutputTokens));
    });

    test('模型沒自帶視窗時退回相容值', () => {
      assert.equal(merge.primaryBudget.contextWindow, 128000, JSON.stringify(merge.primaryBudget));
      assert.equal(merge.primaryBudget.maxOutputTokens, 4096, JSON.stringify(merge.primaryBudget));
    });
  });
});
