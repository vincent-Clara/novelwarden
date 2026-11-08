/**
 * 把 TypeScript 原始碼 bundle 成 CJS 後 require 出來——測試跑的是**原始碼**，不是構建產物。
 *
 * 兩個入口的區別是**模組級狀態**：
 * - `loadModule` 每次呼叫各自 bundle 一份，彼此不共享狀態。
 * - `loadBundle` 把多個模組塞進同一個 bundle，於是它們共享 `host.ts` / `registry.ts` /
 *   `logger.ts` 的模組級單例。**要用 Host 的模組必須走這條路**：分開 bundle 會讓每份產物
 *   各帶一份 `host.ts`，`initHost` 只作用於其中一份，其餘的仍然「宿主尚未初始化」。
 *
 * `external: ['vscode']` 是安全的，因為 tests/contract/corePurity.test.js 保證了
 * `src/core/` 永不 import vscode；真需要 vscode 的（builder / providers / session）
 * 另經 helpers/vscodeStub.js 打樁。
 */
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');
const { embedSkills } = require('../../scripts/embed-skills');

const ROOT = path.join(__dirname, '..', '..');

// 內建寫作技能是倉庫裡的目錄，core 從一個生成檔案裡 import 它們（見 scripts/embed-skills.js）。
// 單跑一條測試不經過 npm 的 pre 鉤子，所以在這裡生成；內容沒變就不寫。
embedSkills({ quiet: true });

/** bundle 一次要幾十毫秒，同一個程序內重複載入同一組入口時直接複用。 */
const cache = new Map();

function compile(key, buildOptions, sourcefile) {
  if (cache.has(key)) return cache.get(key);
  const result = esbuild.buildSync({
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
    ...buildOptions,
  });
  const m = new Module(sourcefile, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, sourcefile));
  cache.set(key, m.exports);
  return m.exports;
}

/**
 * 載入單個模組。
 * @param {string} relPath 相對倉庫根的路徑，如 `src/core/model/markdown.ts`
 */
function loadModule(relPath) {
  return compile(
    `module:${relPath}`,
    { entryPoints: [path.join(ROOT, relPath)] },
    relPath
  );
}

/**
 * 把多個模組打進同一個 bundle，返回 `{ 別名: 模組 }`。
 * @param {Record<string, string>} entries 形如 `{ host: './src/core/host.ts' }`
 */
function loadBundle(entries) {
  const names = Object.keys(entries).sort();
  const key = `bundle:${names.map((n) => `${n}=${entries[n]}`).join(',')}`;
  // Windows 上傳進來的路徑可能帶反斜槓，import 說明符裡必須是正斜槓。
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath.replace(/\\/g, '/')}';`)
    .join('\n');
  return compile(
    key,
    { stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' } },
    'bundle.ts'
  );
}

module.exports = { ROOT, loadModule, loadBundle };
