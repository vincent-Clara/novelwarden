/**
 * 把 media/src/ 下的前端原始碼打包成 dist/media/ 的四個 .js 與兩個 .css。
 *
 * **產物落在 dist/，不入庫**——和 `dist/extension.js` 同一個去處，倉庫裡只留
 * `media/src/` 的原始碼與 `media/icon.svg`。`media/` 根目錄下不再有任何 `.js`
 * / `.css`，看見了就是上一版殘留，刪掉即可。
 *
 * 產物是 IIFE 格式的 classic script，不是 ES module：webview 的 CSP 用 nonce
 * 放行指令碼，而 nonce 不傳遞給 `import` 進來的模組——原生模組要麼得開
 * `strict-dynamic`，要麼就打包，這裡選打包。順帶 jsdom 的 `window.eval`
 * 也只吃得下 classic script，tests/dom/ 不必改載入方式。
 *
 * 用法：node scripts/build-media.js [--watch]
 */
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'media', 'src');
const OUT = path.join(ROOT, 'dist', 'media');

/** 產物名 → 入口。鍵就是最終的檔名（不含副檔名）。 */
const JS_ENTRIES = {
  view: path.join(SRC, 'view', 'index.ts'),
  editor: path.join(SRC, 'editor', 'index.ts'),
  explorer: path.join(SRC, 'explorer', 'index.ts'),
  bridge: path.join(SRC, 'bridge', 'index.ts'),
};

const CSS_ENTRIES = {
  view: path.join(SRC, 'css', 'view.css'),
  standalone: path.join(SRC, 'css', 'standalone.css'),
};

const NOTICE = '由 media/src/ 構建生成（node scripts/build-media.js），勿手改。';

/** 把 esbuild 的錯誤打成人讀得懂的一行。watch 模式下每次重建都會走一遍。 */
const reporter = {
  name: 'media-reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [media] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const COMMON = {
  bundle: true,
  format: 'iife',
  outdir: OUT,
  // webview 是 Electron 的 Chromium，獨立版是現代瀏覽器，兩邊都吃得下 ES2022。
  platform: 'browser',
  target: ['es2022'],
  // 不壓縮：這幾個檔案要麼被 base64 內嵌進單檔案可執行檔案，要麼由 webview
  // 直接載入，體積從來不是瓶頸；出問題時能在 devtools 裡讀到人話更要緊。
  minify: false,
  logLevel: 'silent',
  plugins: [reporter],
};

/**
 * @param {{ watch?: boolean, quiet?: boolean }} [opts]
 */
async function buildMedia(opts = {}) {
  const { watch = false, quiet = false } = opts;

  const contexts = await Promise.all([
    esbuild.context({
      ...COMMON,
      entryPoints: JS_ENTRIES,
      banner: { js: `// ${NOTICE}` },
      // 只在 watch 時給一份內聯 sourcemap，devtools 裡能直接落到 media/src 的
      // 原檔案；一次性構建不帶，免得把原始碼整個塞進 base64 內嵌資源表。
      sourcemap: watch ? 'inline' : false,
    }),
    esbuild.context({
      ...COMMON,
      entryPoints: CSS_ENTRIES,
      banner: { css: `/* ${NOTICE} */` },
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }
  try {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
  if (!quiet) {
    const n = Object.keys(JS_ENTRIES).length + Object.keys(CSS_ENTRIES).length;
    console.log(`✓ 構建 dist/media/（${n} 個產物）`);
  }
}

/** 產物目錄的絕對路徑。下游（embed-media、tests/helpers/dom.js）從這裡取，別各自拼。 */
const MEDIA_OUT_DIR = OUT;

module.exports = { buildMedia, MEDIA_OUT_DIR };

if (require.main === module) {
  buildMedia({ watch: process.argv.includes('--watch') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
