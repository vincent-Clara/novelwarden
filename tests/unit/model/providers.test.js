/**
 * 多服務商 / 多模型：引用解析、配置容錯、舊配置相容，以及 readConfig 把這一切串起來的結果。
 * 遷自 scripts/smoke-providers.js（`== 模型分檔的配置容錯 ==` 一節除外，那節在 tiers.test.js）。
 *
 * 兩件與遷移前不同、但語義等價的事：
 *
 * 1. 原指令碼反覆整體重賦值 `settings = {...}`，而 helpers/vscodeStub.js 把 config 物件按引用
 *    閉包捕獲、換不了物件。這裡就地覆寫 stub 的 `getConfiguration`，讓它每次讀本檔案當前的
 *    `settings` 變數——同一個變數同時餵給 ConfigStore 與 legacy reader，與原指令碼的雙重身份一致。
 * 2. 原指令碼靠頂層 `return ....then(...)` 把最後兩節串在後面；這裡改成按 describe 宣告順序 +
 *    各自的 before()。node:test 同檔案預設序列，換 ConfigStore 的先後與遷移前一致。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, loadBundle, loadModule } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');

/** 當前這一輪的設定。既是 ConfigStore 的內容，也是 settings.json 的內容。 */
let settings = {};

let p;
let configMod;
let vscode;

before(() => {
  vscode = installVscodeStub({ level: 'workspace', root: ROOT, config: {} });
  vscode.stub.workspace.getConfiguration = () => ({
    get: (key, dflt) => (key in settings ? settings[key] : dflt),
  });

  const bundle = loadBundle({
    p: './src/core/model/providers.ts',
    config: './src/core/config.ts',
  });
  p = bundle.p;
  configMod = bundle.config;

  // readConfig 改由注入的 ConfigStore 供數：這裡用記憶體物件模擬 settings.json。
  configMod.initConfigFromHost({
    config: {
      read: () => settings,
      write: async (s) => { settings = s; },
    },
  });
  // 註冊遺留讀取器，才能走 0.1.x 兜底分支（與真實 VS Code 殼一致）。
  configMod.setLegacyConfigReader({ read: () => settings });
});

after(() => {
  vscode.restore();
});

describe('模型引用解析', () => {
  test('普通引用', () => {
    assert.deepEqual(p.parseModelRef('glm/glm-4-plus'), { providerId: 'glm', model: 'glm-4-plus' });
  });

  // 這是整個設計的關鍵：只切第一個斜槓，剩下的都屬於模型名。
  test('巢狀斜槓歸模型名', () => {
    const nested = p.parseModelRef('openrouter/z-ai/glm-4.6');
    assert.equal(nested.providerId, 'openrouter', JSON.stringify(nested));
    assert.equal(nested.model, 'z-ai/glm-4.6', JSON.stringify(nested));
  });

  test('多層斜槓也只切第一個', () => {
    const deep = p.parseModelRef('or/a/b/c/d');
    assert.equal(deep.providerId, 'or', JSON.stringify(deep));
    assert.equal(deep.model, 'a/b/c/d', JSON.stringify(deep));
  });

  test('冒號型模型名（Ollama）', () => {
    assert.equal(p.parseModelRef('ollama/qwen2.5:14b').model, 'qwen2.5:14b');
  });

  test('兩側空白被裁掉', () => {
    assert.equal(p.parseModelRef('  glm/glm-4-plus  ').providerId, 'glm');
  });

  test('沒有斜槓時無效', () => {
    assert.equal(p.parseModelRef('glm-4-plus'), undefined);
  });

  test('以斜槓開頭時無效', () => {
    assert.equal(p.parseModelRef('/glm-4-plus'), undefined);
  });

  test('以斜槓結尾時無效', () => {
    assert.equal(p.parseModelRef('glm/'), undefined);
  });

  test('空串無效', () => {
    assert.equal(p.parseModelRef(''), undefined);
  });

  test('只有斜槓無效', () => {
    assert.equal(p.parseModelRef('/'), undefined);
  });

  test('模型名全是空格時無效', () => {
    assert.equal(p.parseModelRef('glm/   '), undefined);
  });

  test('makeModelRef 與 parseModelRef 互逆', () => {
    assert.equal(p.parseModelRef(p.makeModelRef('openrouter', 'z-ai/glm-4.6')).model, 'z-ai/glm-4.6');
  });
});

describe('服務商列表容錯', () => {
  let ok;
  let messy;
  let strings;
  let kinds;
  let nums;

  before(() => {
    const n = p.normalizeProviders;
    ok = n([
      { id: 'glm', label: '智譜', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
    ]);

    // 手寫 settings.json 什麼都可能出現，壞條目跳過而不是整體失敗。
    messy = n([
      null,
      'not an object',
      { id: '', models: [{ name: 'x' }] },
      { id: 'has/slash', models: [{ name: 'x' }] },
      { id: 'has space', models: [{ name: 'x' }] },
      { id: 'nomodels', models: [] },
      { id: 'nomodels2' },
      { id: 'good', models: [{ name: 'm1' }] },
      { id: 'good', models: [{ name: 'dup' }] },
    ]);

    strings = n([{ id: 'a', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4o'] }]);

    kinds = n([
      { id: 'a', kind: 'anthropic', models: ['m'] },
      { id: 'b', kind: 'vscode-lm', models: ['m'] },
      { id: 'c', kind: '胡說', models: ['m'] },
    ]);

    nums = n([{ id: 'a', models: [{ name: 'm', contextWindow: -5, maxOutputTokens: 'x' }] }]);
  });

  test('非陣列返回空', () => {
    const n = p.normalizeProviders;
    assert.equal(n(undefined).length, 0);
    assert.equal(n('x').length, 0);
    assert.equal(n(null).length, 0);
  });

  test('正常條目被保留', () => {
    assert.equal(ok.length, 1);
  });

  test('baseUrl 末尾斜槓被裁掉', () => {
    assert.equal(ok[0].baseUrl, 'https://open.bigmodel.cn/api/paas/v4', ok[0].baseUrl);
  });

  test('模型視窗被保留', () => {
    assert.equal(ok[0].models[0].contextWindow, 128000);
  });

  test('壞條目全被跳過，只剩一個', () => {
    assert.equal(messy.length, 1, JSON.stringify(messy.map((x) => x.id)));
  });

  test('保留的是 good', () => {
    assert.equal(messy[0].id, 'good');
  });

  test('含斜槓的 id 被拒絕', () => {
    assert.ok(!messy.some((x) => x.id.includes('/')));
  });

  test('重複 id 只留第一個', () => {
    assert.equal(messy.filter((x) => x.id === 'good').length, 1);
  });

  test('模型可簡寫為字串', () => {
    assert.equal(strings[0].models.length, 2, JSON.stringify(strings[0].models));
  });

  test('重複模型名被去掉', () => {
    assert.equal(strings[0].models.map((m) => m.name).join(','), 'gpt-4o,gpt-4o-mini');
  });

  test('kind 原樣保留', () => {
    assert.equal(kinds[0].kind, 'anthropic');
    assert.equal(kinds[1].kind, 'vscode-lm');
  });

  test('非法 kind 退回 openai', () => {
    assert.equal(kinds[2].kind, 'openai');
  });

  test('非法數字被忽略', () => {
    assert.equal(nums[0].models[0].contextWindow, undefined);
    assert.equal(nums[0].models[0].maxOutputTokens, undefined);
  });
});

describe('解析與列舉', () => {
  let providers;
  let a;
  let b;
  let choices;

  before(() => {
    providers = p.normalizeProviders([
      { id: 'glm', label: '智譜 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }, { name: 'glm-4-air' }] },
      { id: 'openrouter', label: 'OpenRouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6' }] },
      { id: 'copilot', kind: 'vscode-lm', models: [{ name: 'gpt-4o' }] },
    ]);
    a = p.resolveModelRef(providers, 'glm/glm-4-plus');
    b = p.resolveModelRef(providers, 'openrouter/z-ai/glm-4.6');
    choices = p.listModelChoices(providers);
  });

  test('解析出服務商', () => {
    assert.equal(a.profile.id, 'glm');
  });

  test('解析出模型', () => {
    assert.equal(a.model.name, 'glm-4-plus');
  });

  test('帶回規範化的 ref', () => {
    assert.equal(a.ref, 'glm/glm-4-plus');
  });

  test('巢狀斜槓模型可解析', () => {
    assert.ok(b && b.model.name === 'z-ai/glm-4.6');
  });

  test('同名模型走不同渠道是兩條', () => {
    assert.notEqual(p.resolveModelRef(providers, 'glm/glm-4-plus').profile.id, b.profile.id);
  });

  test('未知字首返回 undefined', () => {
    assert.equal(p.resolveModelRef(providers, 'nope/x'), undefined);
  });

  test('未知模型返回 undefined', () => {
    assert.equal(p.resolveModelRef(providers, 'glm/不存在'), undefined);
  });

  test('部分匹配不算命中', () => {
    assert.equal(p.resolveModelRef(providers, 'glm/glm-4'), undefined);
  });

  test('firstModelRef 取第一個', () => {
    assert.equal(p.firstModelRef(providers), 'glm/glm-4-plus');
  });

  test('空列表時 firstModelRef 為空串', () => {
    assert.equal(p.firstModelRef([]), '');
  });

  test('列出全部 4 個模型', () => {
    assert.equal(choices.length, 4, `got ${choices.length}`);
  });

  test('列表保持配置順序', () => {
    assert.equal(
      choices.map((c) => c.ref).join(','),
      'glm/glm-4-plus,glm/glm-4-air,openrouter/z-ai/glm-4.6,copilot/gpt-4o',
      choices.map((c) => c.ref).join(',')
    );
  });

  test('分組用服務商顯示名', () => {
    assert.equal(choices[0].group, '智譜 GLM');
  });

  test('無 label 時分組回落到 id', () => {
    assert.equal(choices[3].group, 'copilot');
  });

  test('模型顯示名回落到模型名', () => {
    assert.equal(choices[1].label, 'glm-4-air');
  });

  test('帶上模型視窗', () => {
    assert.equal(choices[0].contextWindow, 128000);
    assert.equal(choices[1].contextWindow, undefined);
  });
});

describe('引用無效時的說明', () => {
  let providers;

  before(() => {
    providers = p.normalizeProviders([
      { id: 'glm', label: '智譜 GLM', models: [{ name: 'glm-4-plus' }, { name: 'glm-4-air' }] },
    ]);
  });

  test('沒有服務商時提示去設定頁', () => {
    assert.ok(p.describeModelIssue([], 'x').includes('設定'));
  });

  test('格式不對時說明格式', () => {
    assert.ok(p.describeModelIssue(providers, 'glm-4-plus').includes('服務商字首/模型名'));
  });

  // 錯誤資訊必須指名道姓，否則使用者只能靠猜。
  test('未知字首時列出已有字首', () => {
    const unknown = p.describeModelIssue(providers, 'kimi/x');
    assert.ok(unknown.includes('kimi') && unknown.includes('glm'), unknown);
  });

  test('未知模型時列出該商可用模型', () => {
    const noModel = p.describeModelIssue(providers, 'glm/不存在');
    assert.ok(noModel.includes('glm/glm-4-plus') && noModel.includes('glm/glm-4-air'), noModel);
  });

  test('未選模型時給出示例', () => {
    assert.ok(p.describeModelIssue(providers, '').includes('glm/glm-4-plus'));
  });
});

describe('0.1.x 配置相容', () => {
  let seeded;
  let lm;
  let none;

  before(() => {
    seeded = p.seedFromLegacy({
      provider: 'anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiModel: 'deepseek-chat',
      anthropicBaseUrl: 'https://api.anthropic.com',
      anthropicModel: 'claude-sonnet-4-5',
      vscodeLmFamily: 'gpt-4o',
    });

    lm = p.seedFromLegacy({
      provider: 'vscode-lm', openaiBaseUrl: '', openaiModel: 'gpt-4o',
      anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: 'claude-3.5-sonnet',
    });

    none = p.seedFromLegacy({
      provider: 'openai', openaiBaseUrl: '', openaiModel: '',
      anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: '',
    });
  });

  test('三個服務商都被建出來', () => {
    assert.equal(seeded.providers.length, 3, JSON.stringify(seeded.providers.map((x) => x.id)));
  });

  test('沿用舊的 baseUrl', () => {
    assert.equal(seeded.providers[0].baseUrl, 'https://api.deepseek.com/v1');
  });

  test('沿用舊的模型名', () => {
    assert.equal(seeded.providers[0].models[0].name, 'deepseek-chat');
  });

  test('舊的 provider 選擇被保留', () => {
    assert.equal(seeded.activeRef, 'anthropic/claude-sonnet-4-5', seeded.activeRef);
  });

  test('vscode-lm 對映到 copilot 字首', () => {
    assert.equal(lm.activeRef, 'copilot/claude-3.5-sonnet', lm.activeRef);
  });

  test('anthropic 模型為空時不建該服務商', () => {
    assert.ok(!lm.providers.some((x) => x.id === 'anthropic'));
  });

  test('baseUrl 為空時取預設值', () => {
    assert.equal(lm.providers[0].baseUrl, 'https://api.openai.com/v1');
  });

  test('全空時不產生服務商', () => {
    assert.equal(none.providers.length, 0);
    assert.equal(none.activeRef, '');
  });
});

describe('readConfig 串起來', () => {
  let cfg;
  let cfg2;
  let bad;
  let emptyModel;
  let globals;
  let legacy;
  let both;

  before(() => {
    settings = {
      providers: [
        { id: 'glm', label: '智譜 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
        { id: 'openrouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6', contextWindow: 200000, maxOutputTokens: 8192 }] },
      ],
      model: 'openrouter/z-ai/glm-4.6',
      contextWindow: 64000,
      maxOutputTokens: 4096,
    };
    cfg = configMod.readConfig();

    settings.model = 'glm/glm-4-plus';
    cfg2 = configMod.readConfig();

    settings.model = 'nope/x';
    bad = configMod.readConfig();

    settings.model = '';
    emptyModel = configMod.readConfig();

    globals = configMod.readBudgetFallback();

    // 老使用者升級：providers 為空，應從舊設定兜底，而不是「沒有模型」。
    settings = {
      provider: 'openai',
      'openai.baseUrl': 'https://api.deepseek.com/v1',
      'openai.model': 'deepseek-chat',
      'anthropic.model': '',
      'vscodeLm.family': '',
    };
    legacy = configMod.readConfig();

    // 新結構一旦存在就以它為準，不再看舊設定。
    settings.providers = [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }];
    settings.model = 'glm/glm-4-plus';
    both = configMod.readConfig();
  });

  test('讀出兩個服務商', () => {
    assert.equal(cfg.providers.length, 2);
  });

  test('當前模型已解析', () => {
    assert.ok(cfg.active && cfg.active.model.name === 'z-ai/glm-4.6');
  });

  // 同一服務商下 32k 和 200k 的模型常並存，全域值不該蓋住模型自帶的視窗。
  test('模型視窗覆蓋全域值', () => {
    assert.equal(cfg.contextWindow, 200000, String(cfg.contextWindow));
  });

  test('模型輸出上限覆蓋全域值', () => {
    assert.equal(cfg.maxOutputTokens, 8192, String(cfg.maxOutputTokens));
  });

  test('切換模型後視窗跟著變', () => {
    assert.equal(cfg2.contextWindow, 128000, String(cfg2.contextWindow));
  });

  test('模型沒設輸出上限時用全域值', () => {
    assert.equal(cfg2.maxOutputTokens, 4096, String(cfg2.maxOutputTokens));
  });

  test('引用無效時 active 為空', () => {
    assert.equal(bad.active, undefined);
  });

  test('引用無效時退回全域視窗', () => {
    assert.equal(bad.contextWindow, 64000, String(bad.contextWindow));
  });

  test('引用無效時不丟服務商列表', () => {
    assert.equal(bad.providers.length, 2);
  });

  test('未指定模型時取第一個', () => {
    assert.equal(emptyModel.model, 'glm/glm-4-plus');
  });

  test('readBudgetFallback 不受模型覆蓋影響', () => {
    assert.equal(globals.contextWindow, 64000, String(globals.contextWindow));
  });

  test('providers 為空時從舊設定兜底', () => {
    assert.equal(legacy.providers.length, 1, JSON.stringify(legacy.providers));
  });

  test('兜底後模型可用', () => {
    assert.ok(legacy.active && legacy.active.model.name === 'deepseek-chat');
  });

  test('兜底後引用為 openai/deepseek-chat', () => {
    assert.equal(legacy.model, 'openai/deepseek-chat', legacy.model);
  });

  test('新結構存在時忽略舊設定', () => {
    assert.equal(both.providers.length, 1, JSON.stringify(both.providers.map((x) => x.id)));
    assert.equal(both.providers[0].id, 'glm', JSON.stringify(both.providers.map((x) => x.id)));
  });
});

describe('預設模型列表', () => {
  const providers = [
    { id: 'glm', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
    { id: 'ds', models: [{ name: 'deepseek-chat', contextWindow: 64000 }] },
  ];

  let upgraded;
  let seeded;
  let listed;
  let broken;
  let defaults;
  let high;
  let low;
  let odd;

  before(() => {
    // 只有 model 的舊配置：自動升級成單元素列表，使用者無感。
    settings = { providers, model: 'ds/deepseek-chat' };
    upgraded = configMod.readConfig();

    // 兩者都空：取第一個可用模型，不能是空列表。
    settings = { providers };
    seeded = configMod.readConfig();

    // 列表是唯一真相：model 恆等於首項，哪怕磁碟上的 model 指著別處。
    settings = { providers, models: ['ds/deepseek-chat', 'glm/glm-4-plus'], model: 'glm/glm-4-plus' };
    listed = configMod.readConfig();

    // 解析不出的引用**留在列表裡**——設定頁要能說清「這個模型沒了」，
    // 剔除是模型池構造時的事（那裡會打 warn）。
    settings = { providers, models: ['nope/x', 'glm/glm-4-plus'] };
    broken = configMod.readConfig();

    // 併發與 fallback 的預設值與 clamp。
    settings = { providers };
    defaults = configMod.readConfig();

    settings = { providers, concurrency: 99, fallbackAttempts: 99 };
    high = configMod.readConfig();

    settings = { providers, concurrency: 0, fallbackAttempts: -3 };
    low = configMod.readConfig();

    settings = { providers, concurrency: 2.7, fallbackAttempts: '3' };
    odd = configMod.readConfig();
  });

  test('非陣列返回空', () => {
    const norm = configMod.normalizeModelList;
    assert.equal(norm(undefined).length, 0);
    assert.equal(norm(null).length, 0);
  });

  test('裸字串當作單元素列表', () => {
    assert.equal(configMod.normalizeModelList('glm/a').join(','), 'glm/a');
  });

  test('去空白與空項', () => {
    const norm = configMod.normalizeModelList;
    assert.equal(norm(['  a/x  ', '', '   ']).join(','), 'a/x', JSON.stringify(norm(['  a/x  ', '', '   '])));
  });

  test('去重且保序', () => {
    assert.equal(configMod.normalizeModelList(['a/x', 'b/y', 'a/x']).join(','), 'a/x,b/y');
  });

  test('非字串項被跳過', () => {
    assert.equal(configMod.normalizeModelList(['a/x', 42, null, { a: 1 }]).join(','), 'a/x');
  });

  test('舊配置只有 model 時升級成單元素列表', () => {
    assert.equal(upgraded.models.join(','), 'ds/deepseek-chat', upgraded.models.join(','));
  });

  test('升級後 model 不變', () => {
    assert.equal(upgraded.model, 'ds/deepseek-chat');
  });

  test('都沒配時取第一個可用模型', () => {
    assert.equal(seeded.models.join(','), 'glm/glm-4-plus', seeded.models.join(','));
  });

  test('model 恆等於列表首項', () => {
    assert.equal(listed.model, 'ds/deepseek-chat', listed.model);
  });

  test('首項決定視窗', () => {
    assert.equal(listed.contextWindow, 64000, String(listed.contextWindow));
  });

  test('列表原樣保留順序', () => {
    assert.equal(listed.models.join(','), 'ds/deepseek-chat,glm/glm-4-plus');
  });

  test('解析不出的引用不在 readConfig 裡被丟掉', () => {
    assert.equal(broken.models.length, 2, broken.models.join(','));
  });

  test('首項解析不出時 active 為空', () => {
    assert.equal(broken.active, undefined);
  });

  test('併發預設 3', () => {
    assert.equal(defaults.concurrency, 3, String(defaults.concurrency));
  });

  test('換模型重試預設 2 次', () => {
    assert.equal(defaults.fallbackAttempts, 2, String(defaults.fallbackAttempts));
  });

  test('併發超上限被收到 16', () => {
    assert.equal(high.concurrency, 16, String(high.concurrency));
  });

  test('重試超上限被收到 5', () => {
    assert.equal(high.fallbackAttempts, 5, String(high.fallbackAttempts));
  });

  test('併發不小於 1', () => {
    assert.equal(low.concurrency, 1, String(low.concurrency));
  });

  test('重試次數不小於 0', () => {
    assert.equal(low.fallbackAttempts, 0, String(low.fallbackAttempts));
  });

  test('小數向下取整', () => {
    assert.equal(odd.concurrency, 2, String(odd.concurrency));
  });

  test('非數字退回預設值', () => {
    assert.equal(odd.fallbackAttempts, 2, String(odd.fallbackAttempts));
  });
});

describe('設定頁未儲存編輯不被重新整理沖掉', () => {
  // 把 view.js 裡那段 renderSettings 的邏輯原樣復刻一遍。
  // 這是一條真實的丟資料路徑：FileSystemWatcher 一重新整理就推設定，
  // 使用者正在填的 baseUrl 不該被磁碟上的舊值覆蓋。
  const snap = {};

  before(() => {
    const draft = { providers: [], keys: {}, dirty: false };
    const render = (s, keys, ack) => {
      const nextKeys = keys || {};
      if (ack === 'saved') draft.dirty = false;
      if (draft.dirty) {
        if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) draft.keys = nextKeys;
        return;
      }
      draft.providers = JSON.parse(JSON.stringify(s.providers || []));
      draft.keys = nextKeys;
    };

    const onDisk = { providers: [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }] };
    render(onDisk, { glm: false });
    snap.firstId = draft.providers[0].id;

    // 使用者開始編輯
    draft.providers[0].baseUrl = 'https://正在填一半';
    draft.dirty = true;

    render(onDisk, { glm: false });
    snap.afterRefresh = draft.providers[0].baseUrl;

    // 剛在彈窗裡輸完 Key，狀態要更新
    render(onDisk, { glm: true });
    snap.keysGlm = draft.keys.glm;
    snap.afterKeyUpdate = draft.providers[0].baseUrl;

    // 儲存被拒：必須保住編輯
    render(onDisk, { glm: true }, 'rejected');
    snap.afterRejected = draft.providers[0].baseUrl;
    snap.dirtyAfterRejected = draft.dirty;

    // 儲存成功：以磁碟為準
    const saved = { providers: [{ id: 'glm', baseUrl: 'https://填完了', models: [{ name: 'glm-4-plus' }] }] };
    render(saved, { glm: true }, 'saved');
    snap.afterSaved = draft.providers[0].baseUrl;
    snap.dirtyAfterSaved = draft.dirty;

    render({ providers: [] }, { glm: true });
    snap.cleanLength = draft.providers.length;
  });

  test('首次渲染讀磁碟', () => {
    assert.equal(snap.firstId, 'glm');
  });

  test('重新整理不沖掉未儲存的編輯', () => {
    assert.equal(snap.afterRefresh, 'https://正在填一半');
  });

  test('髒狀態下 Key 狀態仍會更新', () => {
    assert.equal(snap.keysGlm, true);
  });

  test('更新 Key 狀態時不動編輯內容', () => {
    assert.equal(snap.afterKeyUpdate, 'https://正在填一半');
  });

  test('儲存被拒時保住編輯', () => {
    assert.equal(snap.afterRejected, 'https://正在填一半');
  });

  test('儲存被拒後仍是髒的', () => {
    assert.equal(snap.dirtyAfterRejected, true);
  });

  test('儲存成功後以磁碟為準', () => {
    assert.equal(snap.afterSaved, 'https://填完了');
  });

  test('儲存成功後不再是髒的', () => {
    assert.equal(snap.dirtyAfterSaved, false);
  });

  test('乾淨狀態下正常跟隨磁碟', () => {
    assert.equal(snap.cleanLength, 0);
  });
});

describe('設定頁草稿：新配置的模型不必先儲存就能測', () => {
  // 「新加的模型必須先儲存才能測」對使用者毫無道理——而且儲存一份沒驗過的
  // 配置正是「測試」這個按鈕想要避免的事。設定頁把螢幕上那份服務商隨
  // testConnection 一起發過來，解析時疊加到已儲存的列表上。
  let saved;
  let draft;
  let withDraft;
  let fresh;
  let movedResolved;
  let brandNew;

  before(() => {
    saved = p.normalizeProviders([
      { id: 'openai', label: 'my-router', kind: 'openai', baseUrl: 'https://router.example/v1',
        models: [{ name: 'gemini/gemma-4-31b-it' }, { name: 'ms/deepseek-ai/DeepSeek-V4-Flash' }] },
      { id: 'glm', kind: 'openai', models: [{ name: 'glm-4-plus' }] },
    ]);

    // 螢幕上：同一個服務商剛加了第三個模型，還沒儲存。
    draft = p.normalizeProviders([
      { id: 'openai', label: 'my-router', kind: 'openai', baseUrl: 'https://router.example/v1',
        models: [{ name: 'gemini/gemma-4-31b-it' }, { name: 'ms/deepseek-ai/DeepSeek-V4-Flash' },
          { name: 'ms/deepseek-ai/DeepSeek-V4-Pro' }] },
    ])[0];

    withDraft = p.withDraftProvider(saved, draft);
    fresh = p.resolveModelRef(withDraft, 'openai/ms/deepseek-ai/DeepSeek-V4-Pro');

    // 改了 baseUrl 但沒儲存，測試要打新地址而不是舊地址。
    const moved = p.normalizeProviders([
      { id: 'openai', kind: 'openai', baseUrl: 'https://新地址.example/v1', models: [{ name: 'gemini/gemma-4-31b-it' }] },
    ])[0];
    movedResolved = p.resolveModelRef(p.withDraftProvider(saved, moved), 'openai/gemini/gemma-4-31b-it');

    // 全新的服務商（還沒儲存過任何一份）同樣要能測。
    brandNew = p.normalizeProviders([
      { id: 'kimi', kind: 'openai', baseUrl: 'https://kimi.example/v1', models: [{ name: 'moonshot-v1-128k' }] },
    ])[0];
  });

  test('未儲存的新模型能解析出來', () => {
    assert.ok(!!fresh, p.describeModelIssue(withDraft, 'openai/ms/deepseek-ai/DeepSeek-V4-Pro'));
  });

  test('解析出的模型名是完整的（含兩層斜槓）', () => {
    assert.ok(fresh && fresh.model.name === 'ms/deepseek-ai/DeepSeek-V4-Pro', fresh && fresh.model.name);
  });

  // 草稿只頂掉同 id 的那一個，別家不能受牽連——否則 ref 指向 glm 時就廢了。
  test('草稿不影響其他服務商', () => {
    assert.ok(!!p.resolveModelRef(withDraft, 'glm/glm-4-plus'));
  });

  test('同 id 只保留草稿那一份', () => {
    assert.equal(withDraft.filter((x) => x.id === 'openai').length, 1);
  });

  test('草稿排在最前（同 id 時命中螢幕上這份）', () => {
    assert.equal(withDraft[0], draft);
  });

  test('未儲存的 baseUrl 生效', () => {
    assert.ok(
      movedResolved && movedResolved.profile.baseUrl === 'https://新地址.example/v1',
      movedResolved && movedResolved.profile.baseUrl
    );
  });

  test('沒有草稿時原樣返回', () => {
    assert.equal(p.withDraftProvider(saved, undefined), saved);
  });

  test('全新服務商的模型也能測', () => {
    assert.ok(!!p.resolveModelRef(p.withDraftProvider(saved, brandNew), 'kimi/moonshot-v1-128k'));
  });

  test('全新服務商不擠掉已儲存的', () => {
    assert.equal(p.withDraftProvider(saved, brandNew).length, 3);
  });
});

describe('config.json 缺席時的 settings.json 兜底', () => {
  // 真實 VS Code 殼裡這是**兩個不同的源**：ConfigStore 讀 ~/.novelwarden/config.json，
  // legacy reader 讀 settings.json。上面的用例讓兩者共用一個物件，
  // 恰好掩蓋了這條路徑——這裡必須分開。
  //
  // 觸發條件：config.json 不存在/損壞（FileConfigStore.read 返回 undefined），
  // 而使用者的 novel.providers 就在 settings.json 裡。
  let configJson;
  let cfg;
  let back;
  let seeded;
  /** 落盤那一刻的快照：configJson 在本節最後會被置回 undefined。 */
  let diskKeys;
  let diskProviders;

  before(async () => {
    const userProvider = {
      id: 'openai', label: 'my-router', kind: 'openai',
      baseUrl: 'https://router.example/v1',
      models: [{ name: 'gemini/gemma-4-31b-it', contextWindow: 256000, maxOutputTokens: 33000 }],
    };
    // cfg.get() 對宣告瞭預設值的鍵永遠返回值，所以 0.1.x 的鍵總是"存在"。
    const settingsJson = {
      providers: [userProvider],
      model: 'openai/gemini/gemma-4-31b-it',
      contextWindow: 256000,
      maxOutputTokens: 35840,
      provider: 'openai',
      'openai.baseUrl': 'https://api.openai.com/v1',
      'openai.model': 'gpt-4o',
      'anthropic.baseUrl': 'https://api.anthropic.com',
      'anthropic.model': 'claude-sonnet-4-5',
      'vscodeLm.family': 'gpt-4o',
    };
    configMod.initConfigFromHost({
      config: { read: () => configJson, write: async (s) => { configJson = JSON.parse(JSON.stringify(s)); } },
    });
    // 用**真實**的 legacySettingsReader，而不是手寫樁：這條 bug 的一半就出在
    // 那個 reader 只讀 0.1.x 的鍵、把 novel.providers 整份漏掉。
    settings = settingsJson;
    configMod.setLegacyConfigReader(loadModule('src/shells/vscode/migrate.ts').legacySettingsReader);

    cfg = configMod.readConfig();

    // 只改一個欄位的寫入（下拉框切模型）不能把 providers 弄丟，
    // 否則回讀時 model 指向的服務商解析不出來，介面報「下沒有模型」。
    await configMod.updateSettings({ model: 'openai/gemini/gemma-4-31b-it' });
    diskKeys = Object.keys(configJson);
    diskProviders = configJson.providers;
    back = configMod.readConfig();

    // providers 被使用者清空時，0.1.x 兜底仍要生效（老使用者升級路徑不能迴歸）。
    const legacyOnly = { provider: 'openai', 'openai.baseUrl': 'https://api.deepseek.com/v1', 'openai.model': 'deepseek-chat', 'anthropic.model': '', 'vscodeLm.family': '' };
    configJson = undefined;
    settings = legacyOnly;
    seeded = configMod.readConfig();
  });

  test('用 settings.json 裡的 providers，而不是 0.1.x 預設值', () => {
    assert.equal(cfg.providers.length, 1, JSON.stringify(cfg.providers.map((x) => x.label)));
    assert.equal(cfg.providers[0].label, 'my-router', JSON.stringify(cfg.providers.map((x) => x.label)));
  });

  test('當前模型解析得出', () => {
    assert.ok(!!cfg.active, cfg.active ? '' : p.describeModelIssue(cfg.providers, cfg.model));
  });

  test('視窗取模型自帶值', () => {
    assert.equal(cfg.contextWindow, 256000, String(cfg.contextWindow));
  });

  test('落盤時帶上 providers', () => {
    assert.ok(Array.isArray(diskProviders) && diskProviders.length === 1, JSON.stringify(diskKeys));
  });

  test('落盤時丟掉 0.1.x 的帶點鍵', () => {
    assert.ok(!diskKeys.some((k) => k.includes('.') || k === 'provider'), JSON.stringify(diskKeys));
  });

  test('回讀後模型仍可解析', () => {
    assert.ok(!!back.active, back.active ? '' : p.describeModelIssue(back.providers, back.model));
  });

  test('回讀後仍是使用者的服務商', () => {
    assert.ok(back.providers[0] && back.providers[0].label === 'my-router');
  });

  test('純 0.1.x 設定仍能兜底', () => {
    assert.ok(seeded.model === 'openai/deepseek-chat' && !!seeded.active, seeded.model);
  });
});

/**
 * 切換模型 = 把它提到預設模型列表首位。
 *
 * 單獨一節且放在最後，因為它要 await 落盤：前面的用例都是同步讀配置，
 * 混進去會打亂它們對 `settings` 的假設。
 */
describe('切換模型 = 提到列表首位', () => {
  const providers = [
    { id: 'glm', models: [{ name: 'glm-4-plus' }] },
    { id: 'ds', models: [{ name: 'deepseek-chat' }] },
    { id: 'kimi', models: [{ name: 'moonshot-v1-128k' }] },
  ];

  let disk;
  let after1;
  let diskAfter1;
  let afterPlainWrite;
  let afterPromoteKimi;
  let afterOutsideList;

  before(async () => {
    // 自帶一份儲存：上一節把 store 換成了 configJson，這裡要能直接看落盤結果。
    disk = { providers, models: ['glm/glm-4-plus', 'ds/deepseek-chat', 'kimi/moonshot-v1-128k'] };
    configMod.initConfigFromHost({
      config: { read: () => disk, write: async (s) => { disk = JSON.parse(JSON.stringify(s)); } },
    });

    await configMod.promoteModel('ds/deepseek-chat');
    after1 = configMod.readConfig();
    diskAfter1 = { models0: disk.models[0], model: disk.model };

    // 只寫 model 不寫 models 會被首項蓋回去——這是「列表是唯一真相」的代價：
    // 所有切換模型的入口都必須走 promoteModel，不能自己寫 model。
    await configMod.updateSettings({ model: 'kimi/moonshot-v1-128k' });
    afterPlainWrite = configMod.readConfig();

    await configMod.promoteModel('kimi/moonshot-v1-128k');
    afterPromoteKimi = configMod.readConfig();

    // 列表裡原本沒有的模型也能切過去（命令面板可以選到任何已配置的模型）。
    disk = { providers, models: ['glm/glm-4-plus'] };
    await configMod.promoteModel('ds/deepseek-chat');
    afterOutsideList = configMod.readConfig();
  });

  test('切換的模型排到了首位', () => {
    assert.equal(after1.models[0], 'ds/deepseek-chat', after1.models.join(','));
  });

  test('其餘順序原樣保留', () => {
    assert.equal(
      after1.models.join(','),
      'ds/deepseek-chat,glm/glm-4-plus,kimi/moonshot-v1-128k',
      after1.models.join(',')
    );
  });

  test('model 跟著變', () => {
    assert.equal(after1.model, 'ds/deepseek-chat', after1.model);
  });

  test('落盤的 models 與 model 一致', () => {
    assert.equal(diskAfter1.models0, diskAfter1.model, `${diskAfter1.models0} vs ${diskAfter1.model}`);
  });

  test('只寫 model 不生效（切換模型必須走 promoteModel）', () => {
    assert.equal(afterPlainWrite.model, 'ds/deepseek-chat', afterPlainWrite.model);
  });

  test('promoteModel 才切得動', () => {
    assert.equal(afterPromoteKimi.model, 'kimi/moonshot-v1-128k');
  });

  test('切換不丟別的模型', () => {
    assert.equal(afterPromoteKimi.models.length, 3, afterPromoteKimi.models.join(','));
  });

  test('切到列表外的模型會把它加進列表', () => {
    assert.equal(
      afterOutsideList.models.join(','),
      'ds/deepseek-chat,glm/glm-4-plus',
      afterOutsideList.models.join(',')
    );
  });
});
