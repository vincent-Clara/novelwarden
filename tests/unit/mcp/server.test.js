/**
 * MCP 協議層（`src/core/mcp/server.ts` + `http.ts`）：**只測協議，不碰工程。**
 *
 * 執行端是一個假的 `McpBackend`——真的那一份（綁在 `ChatController` 上）在
 * `tests/integration/mcp/backend.test.js`。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | initialize | 版本協商、回會話 id、帶上使用說明 |
 * | tools/list | 十三個工具；`costly` / `mutating` 落成 readOnlyHint / destructiveHint |
 * | tools/call | 引數原樣轉給執行端；出錯走 `isError`，不走 JSON-RPC 錯誤 |
 * | 沒開啟工程 | 回一句能照著做的話，`isError` |
 * | 狀態簡報 | 第一次必貼；沒變不貼；變了再貼 |
 * | 取消 | `notifications/cancelled` 與連線斷開都中斷那一次呼叫 |
 * | HTTP | 通知 202、壞 JSON 400、認不出的會話 404、DELETE 結束會話、GET 405、跨源 403 |
 * | 長呼叫 | `tools/call` 回 SSE：響應頭先回、跑的期間發進度、讀的一方走了就中斷；只收 JSON 的照舊 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mcp = loadModule('src/core/mcp/index.ts');

const URL_ = 'http://127.0.0.1:5000/mcp';

/** 可程式設計的執行端。`calls` 記下每一次呼叫，`brief` 可隨時改。 */
function fakeBackend() {
  const b = {
    calls: [],
    brief: '# 當前工程\n下一步：寫第 1 章細綱',
    reply: (name) => ({ text: `ran ${name}`, isError: false }),
    /** 給了就在呼叫裡等它（測取消）。 */
    hold: undefined,
    backend: {
      call: async (name, args, signal) => {
        b.calls.push({ name, args, signal });
        if (b.hold) {
          await b.hold(signal);
        }
        return b.reply(name, args);
      },
      brief: async () => b.brief,
    },
  };
  return b;
}

function makeHandler({ backend, allowOrigin, heartbeatMs } = {}) {
  return mcp.createNovelMcp(() => backend, { ...(allowOrigin ? { allowOrigin } : {}), ...(heartbeatMs ? { heartbeatMs } : {}) });
}

/** SSE 正文 → 逐條事件（只認 `data:` 行）。 */
function sseEvents(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

/**
 * `tools/call` 回的是 SSE：把其中的回覆（不含進度通知）重新包成一份 JSON 響應，
 * 其餘用例照舊 `res.json()`。
 */
async function post(handler, body, headers = {}) {
  const res = await handler.handle(
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return res;
  }
  const replies = sseEvents(await res.text()).filter((m) => m.method === undefined);
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: res.status, headers: res.headers });
}

let nextId = 1;
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: nextId++, method, params });

/** initialize 一次，返回會話 id。 */
async function open(handler) {
  const res = await post(handler, rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } }));
  return res.headers.get('mcp-session-id');
}

async function call(handler, sid, name, args = {}) {
  const res = await post(handler, rpc('tools/call', { name, arguments: args }), sid ? { 'mcp-session-id': sid } : {});
  return (await res.json()).result;
}

describe('initialize', () => {
  test('認得的版本原樣回，帶會話 id 與說明', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const res = await post(h, rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'x' } }));
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('mcp-session-id'));
    const body = await res.json();
    assert.equal(body.result.protocolVersion, '2025-03-26');
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(body.result.serverInfo.name, 'novelwarden');
    assert.ok(body.result.instructions.includes('generate'), body.result.instructions);
  });

  test('認不出的版本回我們最新的那個', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const body = await (await post(h, rpc('initialize', { protocolVersion: '1999-01-01' }))).json();
    assert.equal(body.result.protocolVersion, mcp.PROTOCOL_VERSIONS[0]);
  });
});

describe('tools/list', () => {
  let tools;
  test('十三個工具，按模型看到的順序', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const sid = await open(h);
    const body = await (await post(h, rpc('tools/list'), { 'mcp-session-id': sid })).json();
    tools = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(tools), [
      'list',
      'read',
      'search',
      'generate',
      'write',
      'edit',
      'pipeline',
      'summary',
      'characters',
      'lore',
      'extract',
      'book',
      'skills',
    ]);
  });

  test('引數 schema 原樣給成 inputSchema', () => {
    assert.equal(tools.read.inputSchema.type, 'object');
    assert.ok(tools.read.inputSchema.properties.path, JSON.stringify(tools.read.inputSchema));
  });

  test('查詢只讀，生成不只讀，寫盤有破壞性', () => {
    assert.equal(tools.read.annotations.readOnlyHint, true);
    assert.equal(tools.read.annotations.destructiveHint, false);
    assert.equal(tools.generate.annotations.readOnlyHint, false);
    assert.equal(tools.generate.annotations.destructiveHint, false);
    assert.equal(tools.write.annotations.readOnlyHint, false);
    assert.equal(tools.write.annotations.destructiveHint, true);
  });

  // 工具級的兩個標記由動作表推出來：有一個動作調模型就 costly，有一個動作不是 auto 就 mutating。
  // skills 一個模型都不調，但裝與綁會改東西——所以不只讀，且有破壞性。
  test('帶 action 的工具：標記由動作表推出', () => {
    assert.equal(tools.skills.annotations.readOnlyHint, false);
    assert.equal(tools.skills.annotations.destructiveHint, true);
    for (const name of ['pipeline', 'summary', 'characters', 'lore', 'extract', 'book']) {
      assert.equal(tools[name].annotations.readOnlyHint, false, name);
      assert.equal(tools[name].annotations.destructiveHint, true, name);
    }
  });

  test('帶 action 的工具：action 必填且是列舉', () => {
    for (const name of ['pipeline', 'summary', 'characters', 'lore', 'extract', 'book', 'skills']) {
      const schema = tools[name].inputSchema;
      assert.deepEqual(schema.required, ['action'], name);
      assert.ok(Array.isArray(schema.properties.action.enum), name);
    }
  });

  test('沒開啟工程也列得出來', async () => {
    const h = makeHandler({ backend: undefined });
    const body = await (await post(h, rpc('tools/list'))).json();
    assert.equal(body.result.tools.length, 13);
  });
});

describe('tools/call', () => {
  test('引數原樣轉給執行端，結果放進 text 內容塊', async () => {
    const b = fakeBackend();
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const r = await call(h, sid, 'read', { path: 'a.md' });
    assert.deepEqual(b.calls.map((c) => [c.name, c.args]), [['read', { path: 'a.md' }]]);
    assert.equal(r.isError, false);
    assert.equal(r.content[0].type, 'text');
    assert.ok(r.content[0].text.startsWith('ran read'), r.content[0].text);
  });

  test('執行端報錯走 isError，不是 JSON-RPC 錯誤', async () => {
    const b = fakeBackend();
    b.reply = () => ({ text: '沒有這個檔案', isError: true });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const res = await post(h, rpc('tools/call', { name: 'read', arguments: {} }), { 'mcp-session-id': sid });
    const body = await res.json();
    assert.equal(body.error, undefined);
    assert.equal(body.result.isError, true);
    assert.ok(body.result.content[0].text.startsWith('沒有這個檔案'));
  });

  test('沒開啟工程：說清楚，isError', async () => {
    const h = makeHandler({ backend: undefined });
    const r = await call(h, undefined, 'read', { path: 'a.md' });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.includes('開啟'), r.content[0].text);
  });

  test('缺 name 是引數錯誤', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const body = await (await post(h, rpc('tools/call', {}))).json();
    assert.equal(body.error.code, -32602);
  });

  test('地址上的 ?project= 交給殼挑工程；那個工程沒開著時說出是哪個', async () => {
    const asked = [];
    const b = fakeBackend();
    const h = mcp.createNovelMcp((project) => {
      asked.push(project);
      return project === 'D:/books/a' ? b.backend : undefined;
    });
    const at = (query, body) =>
      h.handle(
        new Request(`${URL_}${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    const ok = (await (await at('?project=D%3A%2Fbooks%2Fa', rpc('tools/call', { name: 'read', arguments: {} }))).json()).result;
    assert.equal(ok.isError, false);
    const miss = (await (await at('?project=D%3A%2Fbooks%2Fb', rpc('tools/call', { name: 'read', arguments: {} }))).json()).result;
    assert.equal(miss.isError, true);
    assert.ok(miss.content[0].text.includes('D:/books/b'), miss.content[0].text);
    await at('', rpc('tools/call', { name: 'read', arguments: {} }));
    assert.deepEqual(asked, ['D:/books/a', 'D:/books/b', undefined]);
  });
});

describe('狀態簡報：變了才貼', () => {
  const b = fakeBackend();
  const h = makeHandler({ backend: b.backend });
  let sid;

  test('會話的第一次呼叫必貼', async () => {
    sid = await open(h);
    const r = await call(h, sid, 'list');
    assert.ok(r.content[0].text.endsWith(b.brief), r.content[0].text);
  });

  test('沒變不貼', async () => {
    const r = await call(h, sid, 'read');
    assert.equal(r.content[0].text, 'ran read');
  });

  test('變了再貼', async () => {
    b.brief = '# 當前工程\n下一步：寫第 1 章正文';
    const r = await call(h, sid, 'generate');
    assert.ok(r.content[0].text.endsWith('寫第 1 章正文'), r.content[0].text);
  });

  test('另一條會話從頭算', async () => {
    const other = await open(h);
    const r = await call(h, other, 'list');
    assert.ok(r.content[0].text.endsWith(b.brief), r.content[0].text);
  });
});

describe('取消', () => {
  test('notifications/cancelled 中斷那一次呼叫', async () => {
    const b = fakeBackend();
    let aborted = false;
    b.hold = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const req = rpc('tools/call', { name: 'generate', arguments: {} });
    const pending = post(h, req, { 'mcp-session-id': sid });
    while (b.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const note = await post(
      h,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req.id } },
      { 'mcp-session-id': sid }
    );
    assert.equal(note.status, 202);
    await pending;
    assert.ok(aborted);
  });

  test('連線斷開也中斷', async () => {
    const b = fakeBackend();
    let aborted = false;
    b.hold = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const ctrl = new AbortController();
    const pending = h.handle(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
        body: JSON.stringify(rpc('tools/call', { name: 'generate', arguments: {} })),
        signal: ctrl.signal,
      })
    );
    while (b.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ctrl.abort();
    await pending;
    assert.ok(aborted);
  });
});

describe('HTTP', () => {
  const h = makeHandler({ backend: fakeBackend().backend });

  test('只有通知：202，沒有正文', async () => {
    const sid = await open(h);
    const res = await post(h, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });

  test('壞 JSON：400 + parse error', async () => {
    const res = await post(h, '{oops');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  test('認不出的會話：404（客戶端會重新 initialize）', async () => {
    const res = await post(h, rpc('ping'), { 'mcp-session-id': 'gone' });
    assert.equal(res.status, 404);
  });

  test('批次：一條請求一條回覆', async () => {
    const sid = await open(h);
    const res = await post(h, [rpc('ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping')], {
      'mcp-session-id': sid,
    });
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);
    assert.deepEqual(body[0].result, {});
  });

  test('認不出的方法：-32601', async () => {
    const body = await (await post(h, rpc('resources/list'))).json();
    assert.equal(body.error.code, -32601);
  });

  test('DELETE 結束會話，之後它就認不出了', async () => {
    const sid = await open(h);
    const del = await h.handle(new Request(URL_, { method: 'DELETE', headers: { 'mcp-session-id': sid } }));
    assert.equal(del.status, 200);
    const res = await post(h, rpc('ping'), { 'mcp-session-id': sid });
    assert.equal(res.status, 404);
  });

  test('GET（服務端推送流）不支援：405', async () => {
    const res = await h.handle(new Request(URL_, { method: 'GET' }));
    assert.equal(res.status, 405);
  });

  test('跨源請求：403；命令列客戶端不帶 Origin，放過', async () => {
    const guarded = makeHandler({ backend: fakeBackend().backend, allowOrigin: (o) => !o || o === 'http://127.0.0.1:5000' });
    const evil = await post(guarded, rpc('ping'), { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    const cli = await post(guarded, rpc('ping'));
    assert.equal(cli.status, 200);
  });
});

describe('長呼叫走 SSE', () => {
  const raw = (h, body, headers = {}) =>
    h.handle(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      })
    );

  test('tools/call：先回響應頭，跑的期間帶 progressToken 發進度，跑完發回復', async () => {
    const b = fakeBackend();
    let release;
    b.hold = () => new Promise((r) => (release = r));
    const h = makeHandler({ backend: b.backend, heartbeatMs: 10 });
    const sid = await open(h);
    // 呼叫還沒跑完，響應頭已經回來了
    const res = await raw(h, rpc('tools/call', { name: 'generate', arguments: {}, _meta: { progressToken: 'p1' } }), { 'mcp-session-id': sid });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('mcp-session-id'), sid);
    await new Promise((r) => setTimeout(r, 60));
    release();
    const events = sseEvents(await res.text());
    const progress = events.filter((e) => e.method === 'notifications/progress');
    assert.ok(progress.length >= 2, `進度只有 ${progress.length} 條`);
    assert.ok(progress.every((e) => e.params.progressToken === 'p1'));
    assert.ok(progress[1].params.progress > progress[0].params.progress, '進度要遞增');
    const last = events[events.length - 1];
    assert.equal(last.result.content[0].text.startsWith('ran generate'), true);
  });

  test('沒帶 progressToken：只發 SSE 註釋保活', async () => {
    const b = fakeBackend();
    b.hold = () => new Promise((r) => setTimeout(r, 40));
    const h = makeHandler({ backend: b.backend, heartbeatMs: 10 });
    const sid = await open(h);
    const text = await (await raw(h, rpc('tools/call', { name: 'list', arguments: {} }), { 'mcp-session-id': sid })).text();
    assert.match(text, /^: running$/m);
    assert.equal(sseEvents(text).length, 1);
  });

  test('客戶端只收 JSON：照舊回整份 JSON', async () => {
    const h = makeHandler({ backend: fakeBackend().backend });
    const sid = await open(h);
    const res = await raw(h, rpc('tools/call', { name: 'list', arguments: {} }), { 'mcp-session-id': sid, accept: 'application/json' });
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal((await res.json()).result.isError, false);
  });

  test('讀流的一方走了：中斷那一次呼叫', async () => {
    const b = fakeBackend();
    let aborted = false;
    b.hold = (signal) => new Promise((r) => signal.addEventListener('abort', () => ((aborted = true), r())));
    const h = makeHandler({ backend: b.backend });
    const sid = await open(h);
    const res = await raw(h, rpc('tools/call', { name: 'generate', arguments: {} }), { 'mcp-session-id': sid });
    while (b.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await res.body.cancel();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(aborted);
  });
});
