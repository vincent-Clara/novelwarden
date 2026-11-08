/**
 * 排查「介面不是流式」的現場指令碼：直接打真實服務商，看它到底是
 * 逐塊吐還是一次性吐完。介面只能顯示伺服器給的東西——如果上游把
 * 整段憋到最後一次響應，前端再怎麼改也變不出流式。
 *
 * 用法：node scripts/diag-stream.js [模型引用]
 * 讀 ~/.novelwarden/config.json 裡已配的服務商與 Key（舊 ~/.novelforge/ 兜底）。
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return { window: {}, workspace: {}, commands: {}, Uri: {} };
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const { OpenAiProvider } = loadModule('src/core/llm/openaiProvider.ts');
const { AnthropicProvider } = loadModule('src/core/llm/anthropicProvider.ts');
const P = loadModule('src/core/model/providers.ts');

const NEW_HOME = path.join(os.homedir(), '.novelwarden');
const OLD_HOME = path.join(os.homedir(), '.novelforge');
const HOME = fs.existsSync(path.join(NEW_HOME, 'config.json')) ? NEW_HOME : OLD_HOME;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

(async () => {
  const cfg = readJson(path.join(HOME, 'config.json'));
  if (!cfg) {
    console.log(`讀不到 ${path.join(HOME, 'config.json')}。先在設定頁儲存一次配置。`);
    process.exit(1);
  }
  const providers = P.normalizeProviders(cfg.providers ?? []);
  const ref = process.argv[2] || cfg.model || P.firstModelRef(providers);
  const active = P.resolveModelRef(providers, ref);
  if (!active) {
    console.log(P.describeModelIssue(providers, ref));
    process.exit(1);
  }

  const secrets = readJson(path.join(HOME, 'secrets.json')) ?? {};
  const key = secrets[`novel-forge.apiKey.provider.${active.profile.id}`]
    ?? secrets[`novel-forge.apiKey.${active.profile.id}`];
  if (!key && active.profile.kind !== 'vscode-lm') {
    console.log(`沒找到「${active.profile.id}」的 API Key（${path.join(HOME, 'secrets.json')}）。`);
    process.exit(1);
  }

  const baseUrl = active.profile.baseUrl || P.defaultBaseUrl(active.profile.kind);
  const provider = active.profile.kind === 'anthropic'
    ? new AnthropicProvider(baseUrl, active.model.name, key)
    : new OpenAiProvider(baseUrl, active.model.name, key);

  // 上游會按提示詞快取：同一句話第二次問就是瞬間返回整段，
  // 那不是「不流式」，是根本沒跑模型。每次塞一個唯一串避開快取。
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt =
    `（忽略這行編號 ${nonce}）寫一段 300 字左右的中文場景描寫：` +
    '深夜的舊書店，店主在整理最後一排書架。只輸出正文。';

  console.log(`模型 ${ref}`);
  console.log(`地址 ${baseUrl}`);
  console.log(`防快取 nonce ${nonce}`);
  console.log('請求一段 300 字場景描寫…\n');

  const t0 = Date.now();
  const marks = [];
  let full = '';
  try {
    for await (const ev of provider.stream(
      [{ role: 'user', content: prompt }],
      // temperature 拉高一點，進一步降低命中語義快取的可能。
      { maxOutputTokens: 800, temperature: 0.9, timeoutMs: 180000 }
    )) {
      // 這個指令碼只看正文的到達節奏，思考與用量事件不計入分塊統計。
      if (ev.type !== 'text') continue;
      marks.push({ at: Date.now() - t0, len: ev.text.length });
      full += ev.text;
      // 實時列印，直觀看到是不是一段段來的
      process.stdout.write(ev.text);
    }
  } catch (err) {
    console.log(`\n\n請求失敗：${err && err.message ? err.message : err}`);
    process.exit(1);
  }

  console.log('\n');
  console.log('─'.repeat(60));
  if (marks.length === 0) {
    console.log('一個增量都沒收到——伺服器沒有返回內容。');
    process.exit(1);
  }
  const first = marks[0].at;
  const last = marks[marks.length - 1].at;
  console.log(`增量塊數   ${marks.length}`);
  console.log(`首塊到達   +${first}ms`);
  console.log(`末塊到達   +${last}ms`);
  console.log(`跨度       ${last - first}ms`);
  console.log(`總字數     ${full.length}`);
  console.log('─'.repeat(60));

  if (marks.length === 1) {
    console.log('結論：上游一次性返回了全部內容（只有 1 個增量塊）。');
    console.log('      注意先排除快取命中——本指令碼已加 nonce，但若上游做的是');
    console.log('      語義快取仍可能命中。可用 curl 看 x-omniroute-cache-hit。');
    console.log('      確認非快取後，多半是反代緩衝了 SSE，或該服務不支援 stream。');
    console.log('      若走 Nginx，檢查 proxy_buffering off; 與 X-Accel-Buffering: no。');
  } else if (last - first < 200) {
    console.log('結論：分塊了，但幾乎同時到達（跨度 < 200ms）。');
    console.log('      要麼是快取命中（整段已備好），要麼被反代整體緩衝後一次放行。');
  } else {
    console.log('結論：上游確實在逐塊流式返回，鏈路正常。');
    console.log('      若介面仍是「等全部生成完才顯示」，問題在前端渲染。');
  }
})();
