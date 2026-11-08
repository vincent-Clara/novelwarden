/**
 * 臨時工程夾具。
 *
 * 寫入類用例一律在臨時目錄裡跑——`sample-novel/` 有 hash 斷言
 * （tests/contract/sampleNovel.test.js），任何寫入都會把它弄紅。需要拿真實夾具
 * 內容做寫入實驗的，用 `copyFixture()` 複製一份出來。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, loadModule } = require('./load');

const SAMPLE = path.join(ROOT, 'sample-novel');

/**
 * 開一個空的臨時目錄，並返回一組繫結了該目錄的路徑助手。
 * @param {string} prefix 形如 `fileops`，最終目錄名是 `novelwarden-fileops-XXXX`
 */
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `novelwarden-${prefix}-`));
  return { dir, ...pathHelpers(dir) };
}

function pathHelpers(dir) {
  const rel = (...p) => path.join(dir, ...p);
  return {
    rel,
    write(relPath, text) {
      fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
      fs.writeFileSync(rel(relPath), text, 'utf8');
    },
    read: (relPath) => fs.readFileSync(rel(relPath), 'utf8'),
    has: (relPath) => fs.existsSync(rel(relPath)),
    remove: (relPath) => fs.rmSync(rel(relPath), { recursive: true, force: true }),
  };
}

/**
 * 建一個初始化過的空工程：與作者點「初始化」走同一條路（`Workspace.initializeProject`：固定目錄 → 經閘道器寫空模板 →
 * manifest），而不是隻建骨架。
 *
 * 閘道器單獨 bundle 一份（`loadModule`），工程例項仍由呼叫方的 `projectMod` 造——用例後面拿 `t.project` 去調的全是自己
 * bundle 裡的模組。閘道器只認例項上的路徑與方法，不做 instanceof，兩份 bundle 之間沒有共享狀態要對齊（模板只走
 * `mode: 'create'`，用不到宿主）。
 *
 * `keepExamples` 是從前 `initialize()` 還撒示例角色與示例設定時留下的開關：現在已經不撒了，刪的是兩個本來就不在的檔案。
 *
 * @param {object} projectMod 載入的 `src/core/model/project.ts`
 * @param {object} [opts]
 * @param {string} [opts.prefix] 臨時目錄字首
 * @param {string} [opts.title]
 * @param {boolean} [opts.keepExamples] 不刪示例檔案
 */
async function makeTempProject(projectMod, opts = {}) {
  const { prefix = 'project', title = '測試工程', keepExamples = false } = opts;
  const t = makeTempDir(prefix);
  const project = projectMod.NovelProject.open(t.dir);
  const { Workspace } = loadModule('src/core/workspace/index.ts');
  await new Workspace(project).initializeProject({ title, author: '測試' });
  if (!keepExamples) {
    fs.rmSync(t.rel('.novelwarden/characters/example-protagonist.md'), { force: true });
    fs.rmSync(t.rel('.novelwarden/lore/example-setting.md'), { force: true });
  }
  return { ...t, project };
}

/**
 * 把 `sample-novel/` 整個複製到臨時目錄，用於**需要寫盤**的夾具用例。
 * 只讀斷言直接讀 SAMPLE 即可，不必複製。
 */
function copyFixture(prefix = 'fixture') {
  const t = makeTempDir(prefix);
  fs.cpSync(SAMPLE, t.dir, { recursive: true });
  return t;
}

module.exports = { SAMPLE, makeTempDir, makeTempProject, copyFixture, pathHelpers };
