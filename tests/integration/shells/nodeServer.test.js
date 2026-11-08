/**
 * 獨立版在 node 上跑（Android 殼的內建服務端就是這樣跑的）。
 *
 * 兩層：
 * 1. `serveNode`：node:http + ws 轉成照 `Bun.serve` 擺的形狀，幾處要和 Bun 對齊的行為逐條釘住
 *    ——流式響應邊到邊寫、客戶端斷開要 abort `req.signal`、升級被拒回真的 HTTP 狀態、處理器拋了服務還在。
 * 2. 整個獨立版：照 Android 構建同一條路（scripts/build-android-server.js）打成單檔案，子程序裡用 node 起，
 *    走一遍令牌登入、頁面、WebSocket（含跨源拒絕）與 MCP。前端資源用佔位（見那個指令碼的說明）。
 *
 * e2e（tests/e2e/standalone/）只在 Bun 下跑，覆蓋不到 node 這一半，所以有這一份。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { loadModule } = require('../../helpers/load');
const { bundleServer } = require('../../../scripts/build-android-server');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 開一條 WS，等它連上或被拒。被拒時給出 HTTP 狀態碼。 */
function openWs(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.once('error', (err) => resolve({ error: err }));
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (m) => resolve(m.toString())));
}

describe('serveNode', () => {
  const { serveNode } = loadModule('src/shells/standalone/nodeServe.ts');
  let served;
  let base;
  const events = [];
  /** 流式用例裡「客戶端已經收到第一塊」的訊號，收到之前服務端不放第二塊。 */
  let releaseSecond;
  let aborted;

  before(async () => {
    const port = await freePort();
    served = await serveNode({
      port,
      hostname: '127.0.0.1',
      async fetch(req, ctl) {
        const url = new URL(req.url);
        switch (url.pathname) {
          case '/hello': {
            const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
            headers.append('set-cookie', 'a=1; Path=/');
            headers.append('set-cookie', 'b=2; Path=/');
            return new Response(`你好 ${req.method} ${ctl.port}`, { status: 201, headers });
          }
          case '/form': {
            const form = await req.formData();
            return new Response(`token=${form.get('token')}`);
          }
          case '/stream': {
            const second = new Promise((r) => (releaseSecond = r));
            let step = 0;
            const body = new ReadableStream({
              async pull(controller) {
                step++;
                if (step === 1) {
                  controller.enqueue(new TextEncoder().encode('first;'));
                } else if (step === 2) {
                  await second;
                  controller.enqueue(new TextEncoder().encode('second'));
                } else {
                  controller.close();
                }
              },
            });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          }
          case '/hang': {
            aborted = new Promise((r) => req.signal.addEventListener('abort', () => r(true)));
            const body = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('waiting'));
              },
            });
            return new Response(body);
          }
          case '/boom':
            throw new Error('故意的');
          case '/ws':
            if (req.headers.get('origin') === 'http://evil.example') {
              return new Response('Forbidden origin', { status: 403 });
            }
            ctl.upgrade(req, { data: { project: url.searchParams.get('project') } });
            return undefined;
          default:
            return new Response('Not Found', { status: 404 });
        }
      },
      websocket: {
        open: (ws) => events.push(['open', ws.data]),
        message: (ws, text) => {
          events.push(['message', text]);
          if (text === 'throw') {
            throw new Error('處理器炸了');
          }
          ws.send(`echo:${text}`);
        },
        close: () => events.push(['close']),
      },
    });
    base = `http://127.0.0.1:${served.port}`;
  });

  after(() => served?.stop());

  test('普通響應：狀態碼、正文、埠與多條 set-cookie 原樣帶出去', async () => {
    const res = await fetch(`${base}/hello`);
    assert.equal(res.status, 201);
    assert.equal(await res.text(), `你好 GET ${served.port}`);
    assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  });

  test('請求體：表單讀得出來（登入頁就是這樣交令牌的）', async () => {
    const res = await fetch(`${base}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=abc&next=%2F',
    });
    assert.equal(await res.text(), 'token=abc');
  });

  test('流式響應邊到邊寫：第二塊還沒產出，第一塊已經到了客戶端', async () => {
    const res = await fetch(`${base}/stream`);
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first;');
    releaseSecond();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.equal(rest, 'second');
  });

  test('客戶端斷開時 req.signal 被 abort（MCP 靠它取消呼叫）', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/hang`, { signal: ac.signal });
    await res.body.getReader().read();
    ac.abort();
    assert.equal(await aborted, true);
  });

  test('處理器拋了回 500，服務還在', async () => {
    assert.equal((await fetch(`${base}/boom`)).status, 500);
    assert.equal((await fetch(`${base}/hello`)).status, 201);
  });

  test('WebSocket：升級時給的 data 帶進 open，收發與關閉都回呼', async () => {
    events.length = 0;
    const { ws } = await openWs(`ws://127.0.0.1:${served.port}/ws?project=書`);
    assert.ok(ws, '沒連上');
    ws.send('throw');
    ws.send('你好');
    assert.equal(await nextMessage(ws), 'echo:你好');
    const closed = new Promise((r) => ws.once('close', r));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events, [['open', { project: '書' }], ['message', 'throw'], ['message', '你好'], ['close']]);
  });

  test('升級被拒：客戶端拿到 fetch 回的那個狀態碼', async () => {
    const { status } = await openWs(`ws://127.0.0.1:${served.port}/ws`, { origin: 'http://evil.example' });
    assert.equal(status, 403);
  });

  test('埠被佔時拋出來（main.ts 據此順延埠）', async () => {
    await assert.rejects(
      serveNode({ port: served.port, hostname: '127.0.0.1', fetch: () => undefined, websocket: {} }),
      /EADDRINUSE/
    );
  });
});

describe('獨立版打成 node 單檔案後能跑', () => {
  const TOKEN = 'node-runtime-test-token-0123';
  let dir;
  let child;
  let port;
  let base;
  let cookie;
  let output = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-node-server-'));
    const outfile = path.join(dir, 'server.cjs');
    await bundleServer({ outfile, stubMedia: true });
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    // 環境裡已有的令牌變數一律剔掉，這一條只驗 NOVELWARDEN_TOKEN。
    const env = { ...process.env, HOME: home, USERPROFILE: home, NOVELWARDEN_TOKEN: TOKEN };
    delete env.NOVELFORGE_TOKEN;
    child = spawn(process.execPath, [outfile, '--port', String(port), '--no-open'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服務 15 秒沒起來：${output}`)), 15000);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('服務已啟動')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`服務退出了（${code}）：${output}`));
      });
    });
  });

  after(() => {
    child?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('沒登入：頁面回 401 登入頁', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 401);
    assert.match(await res.text(), /name="token"/);
  });

  test('登入：交令牌換 cookie，303 跳回', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}&next=%2F`,
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    cookie = res.headers.getSetCookie()[0].split(';')[0];
    assert.match(cookie, /^nf_session=/);
  });

  test('帶 cookie：拿到頁面', async () => {
    const res = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/);
  });

  test('WebSocket：同源帶 cookie 連得上、一連上就推狀態；跨源 403', async () => {
    const ok = await openWs(`ws://127.0.0.1:${port}/ws`, { cookie, origin: base });
    assert.ok(ok.ws, `沒連上：${ok.status ?? ok.error}`);
    const first = JSON.parse(await nextMessage(ok.ws));
    assert.equal(typeof first.type, 'string');
    ok.ws.close();
    const evil = await openWs(`ws://127.0.0.1:${port}/ws`, { cookie, origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
  });

  test('MCP：帶令牌能 initialize，不帶 401', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${TOKEN}` }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.serverInfo.name, 'novelwarden');
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body })).status, 401);
  });
});

/**
 * 舊令牌變數仍能登入：0.2.x 的部署（Docker compose、Android 私有目錄）裡
 * 寫的是 `NOVELFORGE_TOKEN`，升級之後不能把作者鎖在門外。
 */
describe('NOVELFORGE_TOKEN 相容', () => {
  const TOKEN = 'legacy-runtime-test-token-0123';
  let dir;
  let child;
  let base;
  let output = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-node-legacy-token-'));
    const outfile = path.join(dir, 'server.cjs');
    await bundleServer({ outfile, stubMedia: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    // 只給舊變數；新變數必須缺席，否則測不到 fallback。
    const env = { ...process.env, HOME: home, USERPROFILE: home, NOVELFORGE_TOKEN: TOKEN };
    delete env.NOVELWARDEN_TOKEN;
    child = spawn(process.execPath, [outfile, '--port', String(port), '--no-open'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服務 15 秒沒起來：${output}`)), 15000);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('服務已啟動')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`服務退出了（${code}）：${output}`));
      });
    });
  });

  after(() => {
    child?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('用 NOVELFORGE_TOKEN 登入：303 跳回並種 cookie', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}&next=%2F`,
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.getSetCookie()[0], /^nf_session=/);
  });
});
