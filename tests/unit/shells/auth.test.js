/**
 * 獨立版的訪問控制（auth.ts）：什麼時候必須配令牌、憑據認不認、Origin 認不認、登入後往哪跳。
 * 整條登入往返（種 cookie、WS / MCP 帶憑據）在 tests/e2e/standalone/server.test.js 的「令牌鑑權」裡。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const auth = loadModule('src/shells/standalone/auth.ts');

const TOKEN = 'a-long-enough-token-0123';
const req = (headers = {}, url = 'http://127.0.0.1:3680/') => new Request(url, { headers });

describe('tokenFromEnv', () => {
  test('主變數是 NOVELWARDEN_TOKEN', () => {
    assert.equal(auth.TOKEN_ENV, 'NOVELWARDEN_TOKEN');
  });

  test('只給舊變數 NOVELFORGE_TOKEN 也認（0.2.x 部署升級不斷檔）', () => {
    assert.equal(auth.tokenFromEnv({ NOVELFORGE_TOKEN: TOKEN }), TOKEN);
  });

  test('兩個都給時新變數優先', () => {
    assert.equal(auth.tokenFromEnv({ NOVELWARDEN_TOKEN: TOKEN, NOVELFORGE_TOKEN: 'old-token-0123456789' }), TOKEN);
  });

  test('空白的當沒給', () => {
    assert.equal(auth.tokenFromEnv({ NOVELWARDEN_TOKEN: '  ', NOVELFORGE_TOKEN: '  ' }), undefined);
    assert.equal(auth.tokenFromEnv({}), undefined);
  });
});

describe('exposureError', () => {
  test('只綁本機時不要令牌', () => {
    assert.equal(auth.exposureError('127.0.0.1', undefined), undefined);
    assert.equal(auth.exposureError('localhost', undefined), undefined);
    assert.equal(auth.exposureError('::1', undefined), undefined);
  });

  test('綁非迴環地址又沒令牌：拒絕，並說出環境變數名', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      const err = auth.exposureError(host, undefined);
      assert.ok(err && err.includes(auth.TOKEN_ENV), `${host}: ${err}`);
    }
  });

  test('令牌太短：不管綁在哪都拒絕', () => {
    assert.ok(auth.exposureError('127.0.0.1', 'short'));
    assert.ok(auth.exposureError('0.0.0.0', 'x'.repeat(auth.MIN_TOKEN_LENGTH - 1)));
  });

  test('夠長的令牌：綁 0.0.0.0 也放行', () => {
    assert.equal(auth.exposureError('0.0.0.0', TOKEN), undefined);
  });
});

describe('isAuthorized', () => {
  const cookie = `nf_session=${auth.sessionValue(TOKEN)}`;

  test('Bearer 令牌對了就認，字首不分大小寫', () => {
    assert.ok(auth.isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN));
    assert.ok(auth.isAuthorized(req({ authorization: `bearer ${TOKEN}` }), TOKEN));
  });

  test('登入換來的 cookie 認，夾在別的 cookie 中間也認', () => {
    assert.ok(auth.isAuthorized(req({ cookie }), TOKEN));
    assert.ok(auth.isAuthorized(req({ cookie: `a=1; ${cookie}; b=2` }), TOKEN));
  });

  test('cookie 裡不是令牌原文：直接把令牌塞進 cookie 不認', () => {
    assert.ok(!auth.isAuthorized(req({ cookie: `nf_session=${TOKEN}` }), TOKEN));
  });

  test('錯的、空的、沒帶的都不認', () => {
    assert.ok(!auth.isAuthorized(req({ authorization: 'Bearer wrong' }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ authorization: 'Bearer ' }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ authorization: `Basic ${TOKEN}` }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ cookie: 'nf_session=nope' }), TOKEN));
    assert.ok(!auth.isAuthorized(req(), TOKEN));
  });

  test('換了令牌，舊 cookie 作廢', () => {
    assert.ok(!auth.isAuthorized(req({ cookie }), `${TOKEN}-rotated`));
  });
});

describe('isAllowedOrigin', () => {
  test('沒有 Origin（命令列客戶端）放過', () => {
    assert.ok(auth.isAllowedOrigin(null, req(), 3680, false));
  });

  test('本機同埠始終認，埠不同不認', () => {
    for (const o of ['http://127.0.0.1:3680', 'http://localhost:3680', 'http://[::1]:3680']) {
      assert.ok(auth.isAllowedOrigin(o, req(), 3680, false), o);
    }
    assert.ok(!auth.isAllowedOrigin('http://127.0.0.1:9999', req(), 3680, false));
  });

  test('沒配令牌時不認同源：擋住 DNS rebinding', () => {
    const r = req({ host: 'evil.com:3680' }, 'http://evil.com:3680/ws');
    assert.ok(!auth.isAllowedOrigin('http://evil.com:3680', r, 3680, false));
  });

  test('配了令牌時認同源：直連伺服器地址', () => {
    const r = req({ host: '192.168.1.5:3680' }, 'http://192.168.1.5:3680/ws');
    assert.ok(auth.isAllowedOrigin('http://192.168.1.5:3680', r, 3680, true));
  });

  test('配了令牌時認同源：經反代，認 X-Forwarded-Host', () => {
    const r = req({ host: '127.0.0.1:3680', 'x-forwarded-host': 'novel.example.com' });
    assert.ok(auth.isAllowedOrigin('https://novel.example.com', r, 3680, true));
  });

  test('配了令牌也不認跨源、不認壞 Origin', () => {
    const r = req({ host: 'novel.example.com' });
    assert.ok(!auth.isAllowedOrigin('https://evil.com', r, 3680, true));
    assert.ok(!auth.isAllowedOrigin('not a url', r, 3680, true));
  });
});

describe('safeNext', () => {
  test('站內路徑原樣保留（帶查詢串）', () => {
    assert.equal(auth.safeNext('/?project=%2Fdata%2Fbook'), '/?project=%2Fdata%2Fbook');
  });

  test('外站、協議相對、反斜槓、空值一律回首頁', () => {
    for (const next of ['https://evil.com', '//evil.com', '/\\evil.com', '', null, undefined, 'relative']) {
      assert.equal(auth.safeNext(next), '/', String(next));
    }
  });
});

describe('loginPage', () => {
  test('next 進隱藏域前轉義', () => {
    const html = auth.loginPage('/?a="><script>', false);
    assert.ok(!html.includes('"><script>'));
  });

  test('失敗時才顯示「令牌不對」', () => {
    assert.ok(!auth.loginPage('/', false).includes('令牌不對'));
    assert.ok(auth.loginPage('/', true).includes('令牌不對'));
  });
});
