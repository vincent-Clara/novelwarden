/**
 * 架構不變式：`src/core/` 永不 import vscode——雙形態架構的硬約束。
 * 遷自 scripts/check-core-purity.js。
 *
 * 這條也是測試基建的地基：正因為 core 純淨，helpers/load.js 裡的
 * `external: ['vscode']` 才是安全的。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const CORE = path.join(ROOT, 'src', 'core');

/** 遞迴列出 src/core/ 下所有 .ts 檔案。 */
function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('src/core 零 vscode 依賴', () => {
  const files = listTsFiles(CORE);

  test('至少掃到了檔案（防止路徑寫錯導致空跑通過）', () => {
    assert.ok(files.length > 0, CORE);
  });

  test('沒有直接 import / require vscode', () => {
    const bad = files.filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return /from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(text);
    });
    assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), [], 'core 層發現 vscode 依賴');
  });

  test('沒有跨層引用 vscode 殼', () => {
    const bad = files.filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return /from\s+['"]\.{1,2}\/.*vscode/.test(text);
    });
    assert.deepEqual(bad.map((p) => path.relative(ROOT, p)), [], 'core 層跨層引用了 vscode 殼');
  });
});
