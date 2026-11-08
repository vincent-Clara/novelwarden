/**
 * 架構不變式：**工具層與 MCP 埠互不纏繞，MCP 埠不伸手進別的層。**
 *
 * 工具（`src/core/tools/`）是 Novelwarden 對外的那一份能力：全部工具的契約、登錄檔、實現。
 * MCP（`src/core/mcp/`）只是把這份契約端出去的一個傳輸——它認識工具的形狀（`ToolSpec`），
 * 真正執行交給殼注入的 `McpBackend`（由 `controller/mcp.ts` 拼出來）。從前工具體裡
 * `ctx.budget.calls += 1`、閘門反過來 import `tools/write`，誰都搬不動；這裡守的就是
 * 別再長回去。
 *
 * 三條：
 *
 * 1. `src/core/tools/` **一行都不 import `mcp/` 或 `controller/`**。反過來會成環，也會讓
 *    「另起一個呼叫方」變成一件要先讀懂 MCP 或 controller 的事。
 * 2. `src/core/mcp/` 只認 `../tools/`（契約、登錄檔、那一套工具）與 `../runtime/`（日誌）。
 *    controller、workspace、generation 這些由 backend 注入，不直接 import——否則埠就
 *    釘死在某一個宿主上了。
 * 3. 工具體不認識預算：**`budget` 這個詞在 `tools/novel/` 裡不該出現**
 *    （工具只 `usage.record(n)` 報數，上限是呼叫方的事）。
 *
 * 誰綁工具、誰接呼叫，見 `src/core/tools/README.md` 的那張分層圖。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const TOOLS = path.join(ROOT, 'src', 'core', 'tools');
const MCP = path.join(ROOT, 'src', 'core', 'mcp');

function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
/** 每一條 import 語句（含它是不是 `import type`）。 */
function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    out.push({ typeOnly: !!m[1], from: m[2] });
  }
  for (const m of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    out.push({ typeOnly: false, from: m[1] });
  }
  return out;
}

describe('tools 不認識呼叫方', () => {
  const files = listTsFiles(TOOLS);

  test('至少掃到了檔案（防止路徑寫錯導致空跑通過）', () => {
    assert.ok(files.length > 0, TOOLS);
  });

  test('沒有任何一處 import mcp/ 或 controller/', () => {
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (/(^|\/)(mcp|controller)(\/|$)/.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'tools 層反向依賴了呼叫方');
  });

  // 工具只會說「我調了 2 次模型」，連上限是多少都不知道。
  test('工具體不認識預算', () => {
    const bad = listTsFiles(path.join(TOOLS, 'novel')).filter((f) =>
      /ctx\.budget|ToolBudget|limits\.calls/.test(fs.readFileSync(f, 'utf8'))
    );
    assert.deepEqual(bad.map(rel), [], '工具體伸手拿了呼叫方的預算');
  });
});

describe('mcp 只認工具契約與執行時', () => {
  const files = listTsFiles(MCP);

  test('至少掃到了檔案', () => {
    assert.ok(files.length > 0, MCP);
  });

  // 同目錄（./）、node 內建（node:）、../tools/、../runtime/ 之外一律不許。
  test('import 只來自 ./、node:、../tools/、../runtime/', () => {
    const ok = /^(\.\/|node:|\.\.\/tools(\/|$)|\.\.\/runtime(\/|$))/;
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (!ok.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'mcp 層直接伸手進了別的層');
  });

  // 具體執行由殼注入的 backend 做；埠本身不認識哪一個宿主。
  test('不碰 controller / workspace / generation', () => {
    const bad = [];
    for (const f of files) {
      for (const i of imports(f)) {
        if (/(^|\/)(controller|workspace|generation)(\/|$)/.test(i.from)) bad.push(`${rel(f)} → ${i.from}`);
      }
    }
    assert.deepEqual(bad, [], 'mcp 層釘死在某個宿主上了');
  });
});
