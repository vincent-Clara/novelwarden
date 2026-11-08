/**
 * AGENTS 第 7 條的普查固化下來：**工程裡的寫盤只經 `core/workspace/` 這一個閘道器**。
 *
 * 掃 `src/core/` 下除 `workspace/` 之外的每一份 `.ts`，找直接動磁碟的呼叫（`fs.writeFile` / `mkdir` / `rename` /
 * `copyFile` / `cp` / `rm` / `unlink`……，以及 `model/fs.ts` 的 `writeText`）。剩下的每一處都是**按設計不走閘道器**的，
 * 在下面這張表裡逐個檔案寫明數量與理由；多出一處就紅——要麼改走閘道器，要麼把理由補進這張表（並同步
 * `src/core/workspace/README.md`「哪些寫入存」那一段）。
 *
 * 2026-10 那次普查之後收掉的：檔案頁貼上的複製（`fs.cp` → `Workspace.copy`）、新建資料夾（`fs.mkdir` →
 * `Workspace.mkdir`）、設定名錄按目錄整理先建目錄（刪掉，`ws.move` 自己補父目錄）、新工程的空模板（`writeIfAbsent`
 * → `Workspace.initializeProject`），以及角色卡的清理別名 / 合併重複卡（`features/characterMaintenance.ts`：
 * `writeText` → `write`、`fs.rename` 進回收站 → `remove`）。最後這一處上一次普查沒掃到：那份原始檔裡有 NUL 字元
 * （拼鍵用的分隔符），`grep -r` 把它當二進位制跳過了——所以這裡用 Node 讀全文，不靠 grep。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const CORE = path.join(ROOT, 'src', 'core');

/** 按設計不走閘道器的寫盤：檔案 → [處數, 理由]。 */
const ALLOWED = {
  'src/core/model/fs.ts': [2, '`writeText` 的實現本身（補父目錄 + 寫）'],
  'src/core/model/project.ts': [3, '後設資料與腳手架：舊目錄（`.novel/`、`.novelforge/`）→ `.novelwarden/` 遷移、新工程建固定目錄、寫 manifest（`project.json`）'],
  'src/core/model/session.ts': [3, '會話檔案（內部檔案，閘道器拒寫 `sessions/`）：落盤、刪會話搬進回收站（共用 `trashPathFor` 落點）'],
  'src/core/stores.ts': [5, '工程外：`~/.novelwarden/` 的設定與 API Key'],
  'src/core/skills/library.ts': [6, '工程外：我的技能庫 `~/.novelwarden/skills/`（裝：連同附帶檔案的子目錄；解除安裝進它自己的回收站）'],
};

/**
 * 直接動磁碟的呼叫。`writeText` 的定義（`function writeText(`）不算；`ws.mkdir(` / `ws.copy(` 這種閘道器方法前面
 * 不是 `fs` / `fsp`，也不算。SQLite（`runtime/db.ts`，第 17 條：只放可丟棄的痕跡）經驅動寫庫檔案，不在這張表裡。
 */
const CALL =
  /(?<![\w$])(?:fs\.promises|fs|fsp|fsSync)\.(?:writeFile|appendFile|mkdir|rename|copyFile|cp|rm|rmdir|unlink|truncate|symlink|link|createWriteStream)(?:Sync)?\s*\(|(?<![\w$.])(?<!function\s)(?:writeText|writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync|cpSync|rmSync|rmdirSync|unlinkSync)\s*\(/g;

function listTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 去掉註釋：塊註釋整段、行尾 `//`。字串裡的 `//`（網址）不影響計數——那幾行本來就沒有寫盤呼叫。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('第 7 條：閘道器之外沒有新的直接寫盤', () => {
  const files = listTsFiles(CORE).filter((p) => !p.startsWith(path.join(CORE, 'workspace') + path.sep));
  const found = {};
  for (const p of files) {
    const hits = stripComments(fs.readFileSync(p, 'utf8')).match(CALL);
    if (hits) {
      found[path.relative(ROOT, p).replace(/\\/g, '/')] = hits.length;
    }
  }

  test('掃到了檔案（防止路徑寫錯空跑通過）', () => {
    assert.ok(files.length > 50, String(files.length));
  });

  test('只有表裡那幾處，數量對得上', () => {
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, [n]]) => [f, n]));
    assert.deepEqual(found, expected);
  });
});
