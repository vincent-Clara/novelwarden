/**
 * LLM provider 的流式解析：跨塊切分、CRLF、心跳註釋、非 JSON 行、流中錯誤、
 * 取消、超時、流式輸出期間不超時、HTTP 錯誤資訊、思考深度落成請求欄位，
 * 以及 Anthropic 的 system 抽取與相鄰訊息合併。
 *
 * OpenAI 那一側走的是 **Responses**（`/responses`）：事件名是
 * `response.output_text.delta` 這一套，思考深度是 `reasoning.effort`。
 *
 * ## 為什麼這份假伺服器留在檔案裡
 *
 * 它跑的是**真的 OpenAiProvider / AnthropicProvider**，走真的 fetch 與真的 SSE
 * 解析，所以必須有一個真的 HTTP 服務端把畸形分幀喂進去——事件被切在半路、
 * CRLF 分隔、註釋心跳、空 delta、流到一半改吐 error。這與
 * helpers/fakeProvider.js（經 registerProviderFactory 注入假模型、根本不過網路）
 * 是兩件事，別硬湊到一起。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');

/**
 * 服務端行為開關：每個用例在自己的 before() 裡切 mode，再看 lastRequest。
 *
 * `requests` 留著整串——**欄位協商**那幾條要看「第一次發了什麼、第二次少了
 * 什麼」，只留最後一條看不出來。用例自己在 before() 裡清空它。
 */
const server = { mode: 'openai-ok', lastRequest: null, requests: [] };

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    server.lastRequest = {
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };
    server.requests.push(server.lastRequest);

    const sse = () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    };

    switch (server.mode) {
      case 'openai-ok': {
        sse();
        // 故意把事件切成不規則的塊，檢驗緩衝區拼接。
        res.write('data: {"type":"response.output_text.delta","delta":"雨下了"}\n\n');
        res.write('data: {"type":"response.output_text.delta","del');
        res.write(
          'ta":"三天，"}\n\ndata: {"type":"response.output_text.delta","delta":"石板路"}\n\n'
        );
        res.write(': 這是一條註釋心跳\n\n');
        res.write('data: {"type":"response.output_text.delta"}\n\n'); // 空 delta
        res.write('data: {"type":"response.output_text.delta","delta":"泡得發白。"}\n\n');
        res.write(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4}}}\n\n'
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-crlf': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"CRLF"}\r\n\r\n');
        res.write('data: {"type":"response.output_text.delta","delta":"分隔"}\r\n\r\n');
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }
      case 'openai-reasoning': {
        sse();
        // 思考摘要先來、正文後到：摘要不能混進正文。
        res.write('data: {"type":"response.reasoning_summary_text.delta","delta":"我在思考"}\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"正文"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-garbage': {
        sse();
        res.write('data: 這不是 JSON\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"仍能繼續"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'openai-mid-error': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"開頭"}\n\n');
        res.write('data: {"type":"error","error":{"message":"上游過載"}}\n\n');
        res.end();
        return;
      }
      case 'http-401': {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      case 'http-404': {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      case 'http-429': {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('rate limited');
        return;
      }
      case 'slow': {
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"慢"}\n\n');
        // 不結束，用於測試取消與超時
        return;
      }
      case 'slow-stream': {
        // 持續吐字，總時長超過 timeoutMs；空閒超時不應打斷。
        sse();
        let i = 0;
        let closed = false;
        res.on('close', () => {
          closed = true;
        });
        const tick = () => {
          if (closed || res.writableEnded) {
            return;
          }
          if (i >= 6) {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(`data: {"type":"response.output_text.delta","delta":"${i}"}\n\n`);
          i += 1;
          setTimeout(tick, 150);
        };
        tick();
        return;
      }
      /**
       * 第一次 400（「不認這個 effort 值」），之後正常。
       *
       * 用來驗欄位協商：**降一檔再發**，而不是把這一輪判死——上游那句
       * 「Unsupported value」在作者眼裡只是「怎麼又不能用了」。
       */
      case 'openai-effort-400': {
        if (server.requests.length === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: "Unsupported value: 'reasoning.effort' does not support 'xhigh'" },
            })
          );
          return;
        }
        sse();
        res.write('data: {"type":"response.output_text.delta","delta":"降檔後成了"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      case 'anthropic-ok': {
        sse();
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"三更，"}}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"林昭醒了。"}}\n\n');
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      /** 思考塊：thinking_delta 若干 + 一個 signature_delta，然後才是正文。 */
      case 'anthropic-thinking': {
        sse();
        res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n');
        res.write(
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n'
        );
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想一下"}}\n\n'
        );
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}\n\n'
        );
        res.write('data: {"type":"content_block_stop","index":0}\n\n');
        res.write(
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}\n\n'
        );
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      /**
       * 第一次 400（「這個模型不認自適應思考」），之後正常。
       *
       * 驗的是**換寫法再發**：老模型只認手動預算，而作者的設定頁裡只有一個
       * 模型名，指望他知道自家模型屬於哪一代思考寫法是不合理的。
       */
      case 'anthropic-adaptive-400': {
        if (server.requests.length === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: '"thinking.type.adaptive" is not supported by this model' },
            })
          );
          return;
        }
        sse();
        res.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"換寫法後成了"}}\n\n'
        );
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      case 'anthropic-error': {
        sse();
        res.write('data: {"type":"error","error":{"message":"overloaded_error"}}\n\n');
        res.end();
        return;
      }
      default:
        res.writeHead(500);
        res.end('unknown mode');
    }
  });
});

const opts = (extra = {}) => ({
  maxOutputTokens: 1000,
  temperature: 0.8,
  timeoutMs: 5000,
  ...extra,
});

let vs;
let providerMod;
let collectText;
let collect;
let OpenAiProvider;
let AnthropicProvider;
let openai;
let anthropic;
let base;
let port;

/** core 側取消已改 AbortSignal：包一層，用 provider 模組自己的 CancelledError 作 reason。 */
function makeCancelSource() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel() { controller.abort(new providerMod.CancelledError()); },
  };
}

/** 把「跑一次流並接住異常」壓成一句，省掉每處都寫 try/catch。 */
async function catchError(fn) {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

before(async () => {
  vs = installVscodeStub({ level: 'minimal' });
  // 一個 bundle 裝全部：兩個 provider 與 provider.ts 必須共用同一份
  // CancelledError / LlmError，否則 normalizeError 的 instanceof 判斷落空
  //（它有 err.name 兜底，所以原指令碼分開 bundle 也過得去，但共用才是對的）。
  const bundle = loadBundle({
    openai: './src/core/llm/openaiProvider.ts',
    anthropic: './src/core/llm/anthropicProvider.ts',
    provider: './src/core/llm/provider.ts',
    collect: './src/core/llm/collect.ts',
  });
  providerMod = bundle.provider;
  ({ collectText, collect } = bundle.collect);
  OpenAiProvider = bundle.openai.OpenAiProvider;
  AnthropicProvider = bundle.anthropic.AnthropicProvider;

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
  base = `http://127.0.0.1:${port}/v1`;

  openai = new OpenAiProvider(base, 'test-model', 'sk-test');
  anthropic = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-test', 'sk-ant-test');
});

after(() => {
  // close() 只是停止接受新連線：slow 模式的響應從不 res.end()，不顯式銷燬
  // 已建立的連線就會把程序吊住。原指令碼靠 process.exit 掩蓋了這一點。
  httpServer.closeAllConnections();
  httpServer.close();
  vs.restore();
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 正常流', () => {
  let text;
  let req;
  let nestedModel;

  before(async () => {
    server.mode = 'openai-ok';
    text = await collectText(openai.stream(
      [{ role: 'system', content: '你是作者' }, { role: 'user', content: '續寫' }],
      opts()
    ));
    // 必須在下面那次請求之前抓下來：lastRequest 只留最後一條。
    req = server.lastRequest;

    // 含斜槓的模型名必須**原樣**上線。路由型服務商（OpenRouter、my-router 等）
    // 的模型名本就是 `渠道/廠商/模型`，任何一段被吃掉，上游都會回
    // 「has no provider supported」，而那個報錯看起來像是模型不存在。
    const nested = new OpenAiProvider(base, 'ms/deepseek-ai/DeepSeek-V4-Flash', 'sk-test');
    await collectText(nested.stream([], opts()));
    nestedModel = server.lastRequest.body.model;
  });

  test('拼接出完整文字', () => {
    assert.equal(text, '雨下了三天，石板路泡得發白。');
  });

  test('跨塊切分的事件被正確拼接', () => {
    assert.ok(text.includes('三天，'));
  });

  test('註釋心跳被忽略', () => {
    assert.ok(!text.includes('註釋'));
  });

  test('請求路徑正確', () => {
    assert.equal(req.url, '/v1/responses');
  });

  test('帶 Bearer 認證頭', () => {
    assert.equal(req.headers.authorization, 'Bearer sk-test');
  });

  test('stream 為 true', () => {
    assert.equal(req.body.stream, true);
  });

  test('傳遞 model', () => {
    assert.equal(req.body.model, 'test-model');
  });

  test('傳遞 max_output_tokens', () => {
    assert.equal(req.body.max_output_tokens, 1000);
  });

  // 不思考時它仍是有效的文風旋鈕；思考開著時一律不帶（見下面那一組）。
  test('不思考時帶 temperature', () => {
    assert.equal(req.body.temperature, 0.8);
  });

  test('system 走 instructions 頂層欄位，不留在 input 裡', () => {
    assert.equal(req.body.instructions, '你是作者');
    assert.deepEqual(req.body.input, [{ role: 'user', content: '續寫' }]);
  });

  // 會話歷史由本地那份 JSON 負責，服務端再存一份只是多一個副本。
  test('store 恆為 false', () => {
    assert.equal(req.body.store, false);
  });

  test('不思考時不帶 reasoning 欄位', () => {
    assert.equal('reasoning' in req.body, false);
  });

  test('provider label 含模型與主機', () => {
    assert.ok(openai.label.includes('test-model') && openai.label.includes('127.0.0.1'));
  });

  test('多層斜槓的模型名原樣傳給上游', () => {
    assert.equal(nestedModel, 'ms/deepseek-ai/DeepSeek-V4-Flash');
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 邊界情況', () => {
  let crlf;
  let reasoning;
  let garbage;
  let caught;

  before(async () => {
    server.mode = 'openai-crlf';
    crlf = await collectText(openai.stream([], opts()));

    server.mode = 'openai-reasoning';
    reasoning = await collectText(openai.stream([], opts()));

    server.mode = 'openai-garbage';
    garbage = await collectText(openai.stream([], opts()));

    server.mode = 'openai-mid-error';
    caught = await catchError(() => collectText(openai.stream([], opts())));
  });

  test('CRLF 分隔的 SSE', () => {
    assert.equal(crlf, 'CRLF分隔');
  });

  // 思考不該被採納寫進章節，所以它不進 text；但它必須有地方去，
  // 否則推理模型想幾十秒的那段時間介面上是一片空白。
  test('思考摘要不混進正文', () => {
    assert.equal(reasoning, '正文');
  });

  test('跳過非 JSON 行繼續解析', () => {
    assert.equal(garbage, '仍能繼續');
  });

  test('流中途的 error 事件被拋出', () => {
    assert.equal(caught && caught.name, 'LlmError');
  });

  test('錯誤資訊含上游原文', () => {
    assert.ok(caught && caught.message.includes('上游過載'), caught && caught.message);
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · HTTP 錯誤', () => {
  for (const [mode, expect] of [
    ['http-401', 'API Key 可能無效'],
    ['http-404', '介面地址或模型名可能填錯'],
    ['http-429', '觸發限流'],
  ]) {
    describe(mode, () => {
      let err;

      before(async () => {
        server.mode = mode;
        err = await catchError(() => collectText(openai.stream([], opts())));
      });

      test(`${mode} 拋出 LlmError`, () => {
        assert.ok(err && err.name === 'LlmError');
      });

      test(`${mode} 附帶排查提示`, () => {
        assert.ok(err && err.message.includes(expect), err && err.message);
      });
    });
  }
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 取消與超時', () => {
  let first;
  let cancelErr;
  let timeoutErr;
  let preCancelledErr;

  before(async () => {
    server.mode = 'slow';
    {
      const src = makeCancelSource();
      const stream = openai.stream([], opts({ signal: src.signal }));
      const iter = stream[Symbol.asyncIterator]();
      first = await iter.next();
      src.cancel();
      cancelErr = await catchError(() => iter.next());
    }

    server.mode = 'slow';
    timeoutErr = await catchError(() =>
      collectText(openai.stream([], opts({ timeoutMs: 300 })))
    );

    // 已取消的 signal 傳進來時應立刻失敗，不發請求
    server.mode = 'openai-ok';
    const src = makeCancelSource();
    src.cancel();
    preCancelledErr = await catchError(() =>
      collectText(openai.stream([], opts({ signal: src.signal })))
    );
  });

  test('取消前已收到首個分片', () => {
    assert.deepEqual(first.value, { type: 'text', text: '慢' });
  });

  test('取消後拋 CancelledError', () => {
    assert.equal(cancelErr && cancelErr.name, 'CancelledError');
  });

  test('超時拋 LlmError', () => {
    assert.equal(timeoutErr && timeoutErr.name, 'LlmError');
  });

  test('超時資訊提示可調設定', () => {
    assert.ok(timeoutErr && timeoutErr.message.includes('requestTimeoutMs'), timeoutErr && timeoutErr.message);
  });

  test('預先取消的 signal 立即拋 CancelledError', () => {
    assert.equal(preCancelledErr && preCancelledErr.name, 'CancelledError');
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 流式輸出期間不超時', () => {
  let text;

  before(async () => {
    server.mode = 'slow-stream';
    // 6 片 × 150ms ≈ 900ms，大於 400ms 空閒超時；一直有資料就不該中止。
    text = await collectText(openai.stream([], opts({ timeoutMs: 400 })));
  });

  test('總時長超過 timeoutMs 仍收齊全文', () => {
    assert.equal(text, '012345');
  });
});

// ---------------------------------------------------------------------------

describe('Anthropic provider', () => {
  let aText;
  let aReq;
  let aErr;

  before(async () => {
    server.mode = 'anthropic-ok';
    aText = await collectText(anthropic.stream(
      [
        { role: 'system', content: '系統提示A' },
        { role: 'system', content: '系統提示B' },
        { role: 'user', content: '第一段' },
        { role: 'user', content: '第二段' },
        { role: 'assistant', content: '上一版' },
      ],
      opts()
    ));
    aReq = server.lastRequest;

    server.mode = 'anthropic-error';
    aErr = await catchError(() =>
      collectText(anthropic.stream([{ role: 'user', content: 'x' }], opts()))
    );
  });

  test('拼接 text_delta', () => {
    assert.equal(aText, '三更，林昭醒了。');
  });

  test('請求路徑為 /v1/messages', () => {
    assert.equal(aReq.url, '/v1/messages');
  });

  test('帶 x-api-key 頭', () => {
    assert.equal(aReq.headers['x-api-key'], 'sk-ant-test');
  });

  test('帶 anthropic-version 頭', () => {
    assert.equal(aReq.headers['anthropic-version'], '2023-06-01');
  });

  test('system 提到頂層欄位', () => {
    assert.equal(aReq.body.system, '系統提示A\n\n系統提示B');
  });

  test('messages 中不含 system', () => {
    assert.ok(aReq.body.messages.every((m) => m.role !== 'system'));
  });

  test('相鄰同角色訊息被合併', () => {
    assert.equal(aReq.body.messages[0].content, '第一段\n\n第二段', JSON.stringify(aReq.body.messages));
  });

  test('首條為 user', () => {
    assert.equal(aReq.body.messages[0].role, 'user');
  });

  test('assistant 訊息保留', () => {
    assert.equal(aReq.body.messages[1].role, 'assistant');
  });

  test('Anthropic 錯誤事件被拋出', () => {
    assert.ok(aErr && aErr.name === 'LlmError');
  });

  test('錯誤資訊含上游原文', () => {
    assert.ok(aErr && aErr.message.includes('overloaded_error'), aErr && aErr.message);
  });
});

// ---------------------------------------------------------------------------

describe('collectText onDelta 回呼', () => {
  const deltas = [];
  const fulls = [];
  let result;

  before(async () => {
    server.mode = 'openai-ok';
    result = await collectText(openai.stream([], opts()), {
      onDelta: (d, f) => {
        deltas.push(d);
        fulls.push(f);
      },
    });
  });

  test('onDelta 收到每個分片', () => {
    assert.equal(deltas.length, 4, JSON.stringify(deltas));
  });

  test('onDelta 的 full 是累積值', () => {
    assert.equal(fulls[fulls.length - 1], result);
  });

  test('full 逐步增長', () => {
    assert.ok(fulls.every((f, i) => i === 0 || f.length > fulls[i - 1].length));
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI provider · 請求體', () => {
  before(async () => {
    server.mode = 'openai-ok';
    await collectText(openai.stream([], opts()));
  });

  test('stream 恆開', () => {
    assert.equal(server.lastRequest.body.stream, true);
  });

  // 歷史由本地會話檔案負責，不讓上游再存一份。
  test('store 恆關', () => {
    assert.equal(server.lastRequest.body.store, false);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · OpenAI Responses', () => {
  let low;
  let max;
  let off;

  before(async () => {
    server.mode = 'openai-ok';
    await collectText(openai.stream([], opts({ thinking: 'low' })));
    low = server.lastRequest.body;

    await collectText(openai.stream([], opts({ thinking: 'max' })));
    max = server.lastRequest.body;

    await collectText(openai.stream([], opts({ thinking: 'off' })));
    off = server.lastRequest.body;
  });

  test('檔位落成 reasoning.effort', () => {
    assert.deepEqual(low.reasoning, { effort: 'low', summary: 'auto' });
  });

  // 介面上只有一個「極限思考」，兩家的列舉名不同：這邊是 xhigh。
  test('極限檔在 OpenAI 這側是 xhigh', () => {
    assert.equal(max.reasoning.effort, 'xhigh');
  });

  // 沒有 summary 就沒有思考增量，介面上那段「正在思考」會是空白。
  test('要思考摘要（summary: auto）', () => {
    assert.equal(max.reasoning.summary, 'auto');
  });

  // 推理模型一律拒收 temperature：帶上去就是 400。
  test('思考開著時不帶 temperature', () => {
    assert.equal('temperature' in low, false);
  });

  test('關著時不帶 reasoning', () => {
    assert.equal('reasoning' in off, false);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · 上游不認那一檔時降級再發', () => {
  let text;
  let bodies;

  before(async () => {
    server.mode = 'openai-effort-400';
    server.requests.length = 0;
    // 模型名與別的用例不同：降級結論按「介面地址 + 模型」記在記憶體裡，
    // 共用一個模型名會讓用例之間互相汙染。
    const provider = new OpenAiProvider(base, 'picky-model', 'sk-test');
    text = await collectText(provider.stream([], opts({ thinking: 'max' })));
    bodies = server.requests.map((r) => r.body);
  });

  test('兩次請求：第一次 xhigh 被拒，第二次降到 high', () => {
    assert.equal(bodies.length, 2, JSON.stringify(bodies.map((b) => b.reasoning)));
    assert.equal(bodies[0].reasoning.effort, 'xhigh');
    assert.equal(bodies[1].reasoning.effort, 'high');
  });

  test('作者拿到的是正常結果，不是一句報錯', () => {
    assert.equal(text, '降檔後成了');
  });

  test('降級結論記住了：同一個模型的下一次請求直接發 high', async () => {
    server.mode = 'openai-ok';
    const provider = new OpenAiProvider(base, 'picky-model', 'sk-test');
    await collectText(provider.stream([], opts({ thinking: 'max' })));
    assert.equal(server.lastRequest.body.reasoning.effort, 'high');
  });
});

// ---------------------------------------------------------------------------

describe('思考深度 · Anthropic', () => {
  let result;
  let body;
  let off;

  before(async () => {
    server.mode = 'anthropic-thinking';
    result = await collect(
      anthropic.stream([{ role: 'user', content: '想一想' }], opts({ thinking: 'max' }))
    );
    body = server.lastRequest.body;

    server.mode = 'anthropic-ok';
    await collectText(anthropic.stream([{ role: 'user', content: 'x' }], opts()));
    off = server.lastRequest.body;
  });

  test('預設走自適應寫法', () => {
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  });

  // 介面上那個「極限思考」在這一側的名字是 max（OpenAI 那側是 xhigh）。
  test('檔位落成 output_config.effort，極限檔是 max', () => {
    assert.deepEqual(body.output_config, { effort: 'max' });
  });

  test('思考開著時不帶 temperature', () => {
    assert.equal('temperature' in body, false);
  });

  test('關著時不帶思考欄位，temperature 照常', () => {
    assert.equal('thinking' in off, false);
    assert.equal('output_config' in off, false);
    assert.equal(off.temperature, 0.8);
  });

  test('thinking_delta 走 reasoning，不混進正文', () => {
    assert.equal(result.reasoning, '先想一下');
    assert.equal(result.text, '答案');
  });

});

// ---------------------------------------------------------------------------

describe('思考深度 · 老模型不認自適應時換寫法', () => {
  let text;
  let bodies;

  before(async () => {
    server.mode = 'anthropic-adaptive-400';
    server.requests.length = 0;
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    text = await collectText(
      provider.stream(
        [{ role: 'user', content: 'x' }],
        // 輸出上限要給足：預算必須小於它，1000 的上限連 1024 的下限都裝不下。
        opts({ thinking: 'medium', maxOutputTokens: 16000 })
      )
    );
    bodies = server.requests.map((r) => r.body);
  });

  test('第一次自適應被拒，第二次改用手動思考預算', () => {
    assert.equal(bodies.length, 2, JSON.stringify(bodies.map((b) => b.thinking)));
    assert.equal(bodies[0].thinking.type, 'adaptive');
    assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 10240 });
  });

  // 預算必須小於 max_tokens（思考 token 算在輸出上限裡），所以留 1024 給正文。
  test('預算按輸出上限收緊', async () => {
    server.mode = 'anthropic-ok';
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    await collectText(
      provider.stream(
        [{ role: 'user', content: 'x' }],
        opts({ thinking: 'max', maxOutputTokens: 4000 })
      )
    );
    assert.equal(server.lastRequest.body.thinking.budget_tokens, 4000 - 1024);
  });

  // 上限太小連 1024 的硬下限都留不出來時不帶思考欄位，而不是發一個必然 400 的請求。
  test('輸出上限裝不下思考時乾脆不帶思考欄位', async () => {
    server.mode = 'anthropic-ok';
    const provider = new AnthropicProvider(`http://127.0.0.1:${port}`, 'claude-old', 'sk-ant-test');
    await collectText(
      provider.stream([{ role: 'user', content: 'x' }], opts({ thinking: 'max', maxOutputTokens: 1500 }))
    );
    assert.equal('thinking' in server.lastRequest.body, false);
  });

  test('作者拿到的是正常結果，不是一句報錯', () => {
    assert.equal(text, '換寫法後成了');
  });
});
