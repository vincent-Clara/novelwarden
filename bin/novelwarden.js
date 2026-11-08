#!/usr/bin/env node
// npm 包形態：優先用 bun 跑原始碼入口；沒有 bun 時提示用編譯好的可執行檔案。
const { spawnSync } = require('child_process');
const path = require('path');
const entry = path.join(__dirname, '..', 'src', 'shells', 'standalone', 'main.ts');
const bun = spawnSync('bun', ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (bun.status === null) {
  console.error('需要安裝 Bun（https://bun.sh），或直接使用編譯好的單檔案可執行檔案。');
  process.exit(1);
}
process.exit(bun.status ?? 0);
