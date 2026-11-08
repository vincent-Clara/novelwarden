const esbuild = require('esbuild');
const { buildMedia } = require('./scripts/build-media');
const { embedSkills } = require('./scripts/embed-skills');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // 前端資源（media/src → dist/media/）與擴充套件主體一起構建：
  // F5 除錯前只跑 `npm run compile`，漏了這一步 webview 會 404。
  await buildMedia({ watch });
  // 內建寫作技能是倉庫裡的目錄，bundle 之前先內嵌成 core 能 import 的生成檔案（見那個指令碼）。
  embedSkills();

  const ctx = await esbuild.context({
    entryPoints: ['src/shells/vscode/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
