/**
 * README「內建編輯器 → 快捷鍵一覽」那張表與程式碼裡的快捷鍵表（`media/src/editor/shortcuts.ts`）逐條對得上：
 * 改了 shortcuts.ts（加鍵、改說法、改生效範圍）就得照著改 README，反過來也一樣。表本身的口徑在 shortcuts.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModule } = require('../../helpers/load');

const { SHORTCUTS, formatKey, groupShortcuts, scopeText } = loadModule('media/src/editor/shortcuts.ts');

/**
 * README「內建編輯器」一節裡的快捷鍵表（`#### 快捷鍵一覽` 底下第一張表）：一行一條，五格——分組（只在每組第一行寫）、按鍵、
 * 做什麼、在哪兒管用、說明。按鍵照 README 的寫法（`Ctrl` + `Shift` + `F`，幾種按法「 / 」隔開），做什麼與程式碼表的 `label`
 * 一字不差，在哪兒管用就是 `scopeText`，說明是 `note`。行的順序也與程式碼表一樣（分組按 `SHORTCUT_GROUPS`）。
 */
function readmeRows() {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('\n#### 快捷鍵一覽\n');
  assert.ok(at >= 0, 'README 裡找不到「#### 快捷鍵一覽」');
  const lines = text.slice(at).split('\n');
  const start = lines.findIndex((l) => l.startsWith('| 分組 |'));
  assert.ok(start >= 0, '「快捷鍵一覽」底下找不到表頭「| 分組 | …」');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) {
      break;
    }
    rows.push(line);
  }
  return rows;
}

const readmeKey = (spec) =>
  formatKey(spec, false)
    .split('+')
    .map((part) => `\`${part}\``)
    .join(' + ');

const readmeRow = (s, first) =>
  `| ${first ? s.group : ''} | ${s.keys.map(readmeKey).join(' / ')} | ${s.label} | ${scopeText(s)} | ${s.note ?? ''} |`;

describe('README 的快捷鍵表與程式碼表一致', () => {
  test('一條一行、順序一樣、五格逐字對得上（改了 shortcuts.ts 就照著改 README）', () => {
    const want = groupShortcuts(SHORTCUTS).flatMap((g) => g.items.map((s, i) => readmeRow(s, i === 0)));
    assert.deepEqual(readmeRows(), want);
  });
});
