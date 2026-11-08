/**
 * 把前端資源 base64 內嵌進生成檔案，
 * 使 bun build --compile 出的單檔案可執行檔案不依賴外部資源。
 *
 * 資源分兩處：`.js` / `.css` 是 `media/src/` 的構建產物（在 `dist/media/`，
 * 不入庫），`icon.svg` 是倉庫裡的靜態檔案（在 `media/`）。所以這裡先跑一次
 * 構建再讀盤——克隆下來直接 `npm run standalone` 的人不該撞上「找不到
 * view.js」，也不該內嵌到一份過期的產物。
 *
 * 順帶寫進去的還有**版本號**（`PRODUCT_VERSION`，取自倉庫根 `package.json`）：單檔案
 * 可執行旁邊沒有 `package.json`，執行時去讀只能讀到 0.0.0。每一條出單檔案的路
 * （獨立版、桌面 sidecar、release）都先跑這個指令碼，所以版本號跟著資源一起程序序。
 *
 * 同一個理由，這裡也先跑一次 embed-skills.js，把內建寫作技能的目錄內嵌進 core。
 *
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');
const { buildMedia, MEDIA_OUT_DIR } = require('./build-media');
const { embedSkills } = require('./embed-skills');

const ROOT = path.join(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'src', 'shells', 'standalone', 'mediaAssets.ts');

/** 構建產物（在 dist/media/）。加新產物時這裡與 build-media 的 entryPoints 同改。 */
const built = ['view.css', 'standalone.css', 'view.js', 'bridge.js', 'editor.js', 'explorer.js'];
/** 倉庫裡的靜態資源（在 media/）。 */
const staticFiles = ['icon.svg'];

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function main() {
  embedSkills();
  await buildMedia({ quiet: true });

  const assets = [
    ...built.map((name) => [name, path.join(MEDIA_OUT_DIR, name)]),
    ...staticFiles.map((name) => [name, path.join(STATIC_DIR, name)]),
  ];

  const lines = [
    '// 由 scripts/embed-media.js 生成，勿手改。',
    'export const MEDIA_ASSETS: Record<string, { mime: string; base64: string }> = {',
  ];
  for (const [name, file] of assets) {
    const buf = fs.readFileSync(file);
    lines.push(`  '${name}': { mime: '${MIME[path.extname(name)]}', base64: '${buf.toString('base64')}' },`);
  }
  lines.push('};');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  lines.push('', '/** 倉庫根 `package.json` 的版本號，「幫助 → 關於」顯示它。 */');
  lines.push(`export const PRODUCT_VERSION = ${JSON.stringify(version)};`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${assets.length} 個資源，版本 ${version}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
