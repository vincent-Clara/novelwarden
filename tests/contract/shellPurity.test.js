/**
 * 殼的契約（[src/shells/README.md](../../src/shells/README.md)）裡那幾條，逐條釘住。
 * 與 corePurity.test.js 並列：都是架構不變式，靠斷言而不是靠人記得。
 *
 * 為什麼值得寫成測試：這三條都是**能悄悄長回來**的。
 * - 共享骨架裡一旦有人 `import * as fs`，它就不再是「任何殼都能用」的東西了，
 *   而當下不會有任何報錯。
 * - 桌面殼複用獨立版靠的是「當子程序起起來」，一旦哪天有人圖省事直接 import
 *   獨立版的模組，Rust 那邊的程序邊界就成了假的。
 * - `host.name === 'x'` 這種按身份分支的寫法刪過一次了（那次它已經把外掛設定頁
 *   的儲存說明說錯了很久），沒有斷言的話下一個人還會再寫一遍。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const SHELLS = path.join(ROOT, 'src', 'shells');

/** 遞迴列出某目錄下所有 .ts 檔案（相對倉庫根的路徑）。 */
function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(p));
    } else if (/\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/**
 * 只掃程式碼，不掃註釋。
 *
 * 這幾條約束在註釋裡是要被**引用**的——host.ts 上就寫著「禁止 host.name === …」
 * 並舉了反例，掃註釋會把說明文字本身判成違規，逼著人不敢把理由寫清楚。
 */
function code(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** 生成檔案不算原始碼：mediaAssets.ts 是 base64 資源表。 */
const GENERATED = /mediaAssets\.ts$/;

function sourcesOf(...segments) {
  return listTsFiles(path.join(SHELLS, ...segments)).filter((p) => !GENERATED.test(p));
}

describe('shells/shared 零宿主依賴', () => {
  const files = sourcesOf('shared');

  test('至少掃到了檔案（防止路徑寫錯導致空跑通過）', () => {
    assert.ok(files.length > 0, SHELLS);
  });

  test('不 import 任何宿主/執行時模組', () => {
    const bad = [];
    for (const p of files) {
      const text = code(p);
      // vscode、node: 內建、bun: 內建——三者都會把這份骨架釘死在某一個宿主上。
      const m = /from\s+['"](vscode|node:[^'"]+|bun:[^'"]+)['"]/.exec(text);
      if (m) {
        bad.push(`${rel(p)} → ${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], '共享骨架裡出現了宿主依賴');
  });

  test('不反向依賴任何一個具體的殼', () => {
    const bad = files.filter((p) => /from\s+['"]\.\.\/(vscode|standalone|desktop|android)\//.test(code(p)));
    assert.deepEqual(bad.map(rel), [], '共享骨架反過來依賴了某個殼');
  });
});

describe('殼與殼之間不互相 import', () => {
  const shells = ['vscode', 'standalone'];

  test('列得出兩個 TS 殼的原始碼', () => {
    for (const shell of shells) {
      assert.ok(sourcesOf(shell).length > 0, shell);
    }
  });

  for (const shell of shells) {
    const others = shells.filter((s) => s !== shell);
    test(`${shell} 不 import ${others.join(' / ')}`, () => {
      const bad = [];
      for (const p of sourcesOf(shell)) {
        const text = code(p);
        for (const other of others) {
          if (new RegExp(`from\\s+['"]\\.\\./${other}/`).test(text)) {
            bad.push(`${rel(p)} → ${other}`);
          }
        }
      }
      assert.deepEqual(bad, [], '殼之間出現了直接依賴');
    });
  }

  test('桌面殼裡沒有 TS——它複用獨立版靠的是把它當 sidecar 起，不是 import', () => {
    assert.deepEqual(sourcesOf('desktop').map(rel), []);
  });

  test('Android 殼裡也沒有 TS——內建服務端是獨立版打成的 node 單檔案，當子程式起', () => {
    assert.deepEqual(sourcesOf('android').map(rel), []);
  });
});

describe('沒有「我是哪個殼」的分支', () => {
  /** core 與兩個 TS 殼的全部原始碼。 */
  const files = [...listTsFiles(path.join(ROOT, 'src', 'core')), ...sourcesOf()];

  test('全倉庫沒有 host.name === / name === 這類身份判斷', () => {
    const bad = [];
    for (const p of files) {
      const text = code(p);
      // 只認對 Host 那個 name 的比較：`host.name ===`、`getHost().name ===`、
      // `this.host.name !==` 都算。別的 `.name`（角色名、模型名）不受影響。
      const m = /\bhost\(\)?\.name\s*[!=]==/i.exec(text) ?? /\bhost\.name\s*[!=]==/i.exec(text);
      if (m) {
        bad.push(`${rel(p)} → ${m[0]}`);
      }
    }
    assert.deepEqual(bad, [], 'Host.name 只能用於日誌與診斷，能力差異請走可選方法或渲染期選項');
  });

  test('ViewState 裡沒有按殼命名的開關', () => {
    const protocolDir = path.join(ROOT, 'src', 'core', 'protocol');
    const protocol = listTsFiles(protocolDir).map(code).join('\n');
    for (const word of ['standalone?:', 'vscode?:', 'desktop?:']) {
      assert.ok(!protocol.includes(word), `protocol/ 裡出現了 ${word}`);
    }
  });
});
