/**
 * `tools/registry.ts` + `tools/schema.ts`：登錄檔怎麼把 `ToolDef[]` 變成能發出去
 * 的 `ToolSpec[]`，以及它拒收什麼。
 *
 * 模型只看得見 `description` 與 `parameters`，所以這裡釘的是**寫法**而不是
 * 轉換本身（那是十行）。四件事各有一批斷言：
 *
 * 1. **schema 合法**——名字合規、不重、必填欄位在 properties 裡；
 * 2. **引數扁平**——巢狀物件直接拒，那是模型最容易填錯的地方；
 * 3. **描述不空**——沒有描述的工具/引數模型只能瞎猜；
 * 4. **`invoke` 絕不拋**——認不出的名字、工具自己炸掉，都變成一條模型讀得懂的
 *    結果。一個工具炸掉不該帶走整輪對話。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const reg = loadModule('src/core/tools/registry.ts');
const schema = loadModule('src/core/tools/schema.ts');

/** 登錄檔要一份環境，但這一組用例一個工具都不真跑，給個空殼就夠。 */
const ENV = { project: undefined, workspace: undefined, drafts: undefined, sessionId: 's1' };

/** 一條最小可用的定義。各用例改其中一處。 */
function def(extra = {}) {
  return {
    name: 'read',
    description: '讀一份檔案',
    parameters: schema.objectSchema({ path: schema.str('工程內相對路徑') }, ['path']),
    run: async () => ({ text: '' }),
    ...extra,
  };
}

const specsOf = (defs) => new reg.ToolRegistry(defs, ENV).specs();

/** 一次呼叫那一面：工具體拿到的 signal / report / usage。 */
function run() {
  const calls = [];
  return {
    signal: new AbortController().signal,
    report: () => {},
    usage: { record: (n) => calls.push(n) },
    calls,
  };
}

describe('specs 產出的 schema', () => {
  const specs = specsOf([
    def(),
    def({
      name: 'search',
      description: '全文檢索',
      parameters: schema.objectSchema(
        {
          pattern: schema.str('要找的字面量'),
          kinds: schema.strArray('限定種類'),
          regex: schema.bool('按正則搜'),
          limit: schema.int('最多返回幾條'),
        },
        ['pattern']
      ),
    }),
  ]);

  test('每條只帶 name / description / parameters 三個欄位', () => {
    assert.deepEqual(Object.keys(specs[0]).sort(), ['description', 'name', 'parameters']);
  });

  test('run 不會漏進 spec（它是本地函式，透傳給 API 會炸）', () => {
    assert.equal('run' in specs[0], false, JSON.stringify(specs[0]));
  });

  test('intent 也不會漏進 spec', () => {
    const s = specsOf([def({ intent: () => ({ gate: 'auto', title: 'x' }) })])[0];
    assert.equal('intent' in s, false, JSON.stringify(s));
  });

  test('parameters 原樣透傳', () => {
    assert.equal(specs[0].parameters.type, 'object');
    assert.deepEqual(specs[0].parameters.required, ['path']);
  });

  test('陣列引數帶 items 型別', () => {
    assert.equal(specs[1].parameters.properties.kinds.items.type, 'string');
  });

  test('additionalProperties 關掉——模型多塞欄位要當場看得出來', () => {
    assert.equal(specs[0].parameters.additionalProperties, false);
  });

  test('names 是註冊順序，也就是模型看到的順序', () => {
    assert.deepEqual(new reg.ToolRegistry([def(), def({ name: 'search' })], ENV).names(), [
      'read',
      'search',
    ]);
  });
});

describe('校驗：名字', () => {
  test('名字重複要報出來', () => {
    assert.throws(() => specsOf([def(), def()]), /重複/);
  });

  test('大寫字母不收（各家 API 的字符集取交集）', () => {
    assert.throws(() => specsOf([def({ name: 'readFile' })]), /小寫/);
  });

  test('空名字不收', () => {
    assert.throws(() => specsOf([def({ name: '' })]), /小寫|無名/);
  });

  test('下劃線合法', () => {
    assert.equal(specsOf([def({ name: 'read_file' })])[0].name, 'read_file');
  });
});

describe('校驗：描述', () => {
  test('工具沒有描述要報出來', () => {
    assert.throws(() => specsOf([def({ description: '  ' })]), /描述/);
  });

  test('引數沒有描述要報出來', () => {
    const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: [] };
    assert.throws(() => specsOf([def({ parameters })]), /description/);
  });
});

describe('校驗：引數必須扁平', () => {
  test('巢狀物件引數被拒', () => {
    const parameters = {
      type: 'object',
      properties: {
        target: { type: 'object', description: '目標', properties: { kind: { type: 'string' } } },
      },
      required: [],
    };
    assert.throws(() => specsOf([def({ parameters })]), /巢狀|攤平/);
  });

  test('物件陣列被拒', () => {
    const parameters = {
      type: 'object',
      properties: { edits: { type: 'array', description: '若干編輯', items: { type: 'object' } } },
      required: [],
    };
    assert.throws(() => specsOf([def({ parameters })]), /攤平/);
  });

  test('沒說元素型別的陣列被拒', () => {
    const parameters = {
      type: 'object',
      properties: { kinds: { type: 'array', description: '種類' } },
      required: [],
    };
    assert.throws(() => specsOf([def({ parameters })]), /元素型別/);
  });
});

describe('校驗：必填欄位', () => {
  test('required 裡出現 properties 沒有的鍵要報出來', () => {
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string', description: '路徑' } },
      required: ['path', 'offset'],
    };
    assert.throws(() => specsOf([def({ parameters })]), /offset/);
  });

  test('parameters 不是 object schema 時報出來', () => {
    assert.throws(() => specsOf([def({ parameters: { type: 'string' } })]), /object/);
  });
});

describe('objectSchema 助手', () => {
  test('沒給 required 時是空陣列，不是 undefined', () => {
    assert.deepEqual(schema.objectSchema({ a: schema.str('a') }).required, []);
  });

  test('str 帶候選值時產出 enum', () => {
    assert.deepEqual(schema.str('能力', ['discuss', 'generate']).enum, ['discuss', 'generate']);
  });
});

// ★ 這一組是「換個呼叫方也不會漏掉」的那一半：從前它們散在 agent 的迴圈裡。
describe('invoke 絕不拋', () => {
  test('認不出的名字回一條結果，而不是異常', async () => {
    const r = await new reg.ToolRegistry([def()], ENV).invoke('並不存在的工具', {}, run());
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('沒有叫'), r.error);
  });

  // 名單從實際註冊的那一份來：寫死一串名字，加了工具之後這句話就在撒謊。
  test('順帶告訴模型有哪些可用', async () => {
    const r = await new reg.ToolRegistry([def(), def({ name: 'search' })], ENV).invoke('x', {}, run());
    assert.ok(r.error.includes('read / search'), r.error);
  });

  test('工具拋異常變成 error 結果', async () => {
    const boom = def({
      name: 'boom',
      run: async () => {
        throw new Error('磁碟著火了');
      },
    });
    const r = await new reg.ToolRegistry([boom], ENV).invoke('boom', { path: 'a.md' }, run());
    assert.equal(r.ok, false);
    assert.ok(r.text.includes('磁碟著火了'), r.text);
  });

  test('出錯時 text 就是那句錯誤（模型只讀 text）', async () => {
    const bad = def({ name: 'bad', run: async () => ({ text: '', error: '路徑超出工程目錄' }) });
    const r = await new reg.ToolRegistry([bad], ENV).invoke('bad', { path: 'a.md' }, run());
    assert.equal(r.text, '路徑超出工程目錄');
  });

  test('成功時帶出 draftIds 與耗時', async () => {
    const ok = def({ name: 'gen', run: async () => ({ text: '好了', draftIds: ['d1'] }) });
    const r = await new reg.ToolRegistry([ok], ENV).invoke('gen', { path: 'a.md' }, run());
    assert.equal(r.ok, true);
    assert.deepEqual(r.draftIds, ['d1']);
    assert.equal(typeof r.elapsedMs, 'number');
  });

  test('沒產出草稿時 draftIds 是空陣列而不是 undefined', async () => {
    const r = await new reg.ToolRegistry([def()], ENV).invoke('read', { path: 'a.md' }, run());
    assert.deepEqual(r.draftIds, []);
  });
});

describe('入參校驗：run 之前先過一遍', () => {
  const search = def({
    name: 'search',
    parameters: schema.objectSchema(
      {
        pattern: schema.str('要找的字面量'),
        kinds: schema.strArray('限定種類'),
        regex: schema.bool('按正則搜'),
        limit: schema.int('最多返回幾條'),
        mode: schema.str('怎麼搜', ['fast', 'full']),
      },
      ['pattern']
    ),
    run: async () => ({ text: '跑了' }),
  });
  const check = (args) => new reg.ToolRegistry([search], ENV).check('search', args);

  test('合法的入參放過', () => {
    assert.equal(check({ pattern: '林', kinds: ['chapter'], regex: true, limit: 5, mode: 'fast' }), undefined);
  });

  test('空串不算缺（「不能為空」由工具自己說）', () => {
    assert.equal(check({ pattern: '' }), undefined);
  });

  test('缺必填時說出缺哪個、那個引數是幹什麼的', () => {
    assert.equal(check({}), '缺少引數：pattern（要找的字面量）');
  });

  test('型別不對', () => {
    assert.ok(check({ pattern: 1 }).includes('pattern 應該是字串'));
    assert.ok(check({ pattern: 'a', limit: 1.5 }).includes('limit 應該是整數'));
    assert.ok(check({ pattern: 'a', regex: 'yes' }).includes('regex 應該是'));
    assert.ok(check({ pattern: 'a', kinds: 'chapter' }).includes('kinds 應該是陣列'));
    assert.ok(check({ pattern: 'a', kinds: [1] }).includes('元素是字串'));
  });

  test('不在列舉裡', () => {
    assert.equal(check({ pattern: 'a', mode: 'slow' }), 'mode 只能是：fast / full。');
  });

  test('多塞了 schema 裡沒有的鍵', () => {
    assert.ok(check({ pattern: 'a', path: 'x' }).startsWith('沒有 path 這個引數'));
  });

  test('工具自己的 check 先說，它放過了再走通用校驗', () => {
    const own = def({ check: (args) => (args.path === 'bad' ? '工具自己的話' : undefined) });
    const reg1 = new reg.ToolRegistry([own], ENV);
    assert.equal(reg1.check('read', { path: 'bad' }), '工具自己的話');
    assert.ok(reg1.check('read', { path: 'ok', extra: 1 }).startsWith('沒有 extra'));
  });

  test('名字不認識時不歸它管（invoke 會說「沒有叫 X 的工具」）', () => {
    assert.equal(new reg.ToolRegistry([search], ENV).check('nope', {}), undefined);
  });

  test('invoke 校驗不過就不跑工具體', async () => {
    let ran = false;
    const spy = def({ run: async () => ((ran = true), { text: '' }) });
    const r = await new reg.ToolRegistry([spy], ENV).invoke('read', { path: 3 }, run());
    assert.equal(r.ok, false);
    assert.equal(ran, false);
    assert.ok(r.text.includes('path 應該是字串'), r.text);
  });
});

describe('工具體拿到環境 + 這一次呼叫', () => {
  test('兩邊合成一份 ctx 遞進去', async () => {
    let seen;
    const spy = def({ name: 'spy', run: async (ctx) => ((seen = ctx), { text: '' }) });
    const r = run();
    await new reg.ToolRegistry([spy], { ...ENV, sessionId: 's7' }).invoke('spy', { path: 'a.md' }, r);
    assert.equal(seen.sessionId, 's7');
    assert.equal(seen.signal, r.signal);
    assert.equal(typeof seen.usage.record, 'function');
  });
});

describe('意圖：工具不報時兜一個通用的', () => {
  const intentOf = (d, args = {}) => new reg.ToolRegistry([d], ENV).intent(d.name, args);

  test('讀類工具歸 auto', () => {
    assert.equal(intentOf(def()).gate, 'auto');
  });

  // 寧可多問，也不要有一條沒人想過的路。
  test('寫盤或花錢的歸 mutating', () => {
    assert.equal(intentOf(def({ mutating: true })).gate, 'mutating');
    assert.equal(intentOf(def({ costly: true })).gate, 'mutating');
  });

  test('工具自己報了就用它那一份', () => {
    const d = def({ intent: () => ({ gate: 'always', title: '改一段文字', detail: '原文：甲 → 乙' }) });
    assert.deepEqual(intentOf(d), { gate: 'always', title: '改一段文字', detail: '原文：甲 → 乙' });
  });

  test('認不出的名字沒有意圖', () => {
    assert.equal(new reg.ToolRegistry([def()], ENV).intent('沒這個', {}), undefined);
  });
});
