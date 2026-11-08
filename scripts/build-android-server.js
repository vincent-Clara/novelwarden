/**
 * 把獨立版打成**node 跑的單檔案**（`server.cjs`），給 Android 殼當內建服務端。
 *
 * 別的出單檔案的路都是 `bun build --compile`（獨立版、桌面 sidecar、Docker），Android 上沒有 Bun：
 * 殼裡帶的是 Termux 編的 node，所以這裡用 esbuild 按 node 平臺打包，`ws` 一起打進去
 * （它的兩個可選加速模組 bufferutil / utf-8-validate 是原生模組，不帶，`ws` 自己會退回純 JS）。
 * 服務端在 node 上怎麼監聽見 src/shells/standalone/serve.ts。
 *
 * 用法：node scripts/build-android-server.js <輸出檔案>
 *   先跑 embed-media（前端資源與版本號程序序），再打包。
 *
 * tests/integration/shells/nodeServer.test.js 也調 `bundleServer`，但傳 `stubMedia`：
 * 測試並行跑，重新構建 dist/media 會和讀它的 dom 測試撞車，而那組用例不看前端資源。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { embedSkills } = require('./embed-skills');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'shells', 'standalone', 'main.ts');

/**
 * @param {{ outfile: string, stubMedia?: boolean }} opts
 */
async function bundleServer({ outfile, stubMedia = false }) {
  embedSkills({ quiet: true });
  const plugins = stubMedia
    ? [
        {
          name: 'stub-media',
          setup(build) {
            build.onResolve({ filter: /\/mediaAssets$/ }, () => ({ path: 'mediaAssets', namespace: 'stub-media' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-media' }, () => ({
              contents: "export const MEDIA_ASSETS = {};\nexport const PRODUCT_VERSION = '0.0.0';\n",
              loader: 'ts',
            }));
          },
        },
      ]
    : [];
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Termux 的 nodejs-lts 眼下是 24；CI 與測試跑在 22 上，取低的那個。
    target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
    plugins,
  });
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node scripts/build-android-server.js <輸出檔案>');
    process.exit(1);
  }
  const embed = spawnSync(process.execPath, [path.join(__dirname, 'embed-media.js')], { stdio: 'inherit' });
  if (embed.status !== 0) {
    process.exit(embed.status ?? 1);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  bundleServer({ outfile: path.resolve(out) })
    .then(() => {
      const size = fs.statSync(out).size / 1e6;
      console.log(`✓ 生成 ${path.relative(ROOT, path.resolve(out))}（${size.toFixed(1)} MB）`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { bundleServer };
