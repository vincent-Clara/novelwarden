/**
 * 把內建寫作技能（`src/core/skills/builtin/<名字>/`，常規的技能目錄：`SKILL.md` 加它引用的
 * `references/…` 等檔案）內嵌成一個生成檔案 `src/core/skills/builtin/embedded.ts`。
 *
 * 為什麼要內嵌：三個殼的產物都是單檔案（VS Code 是 esbuild 的 bundle，獨立版 / 桌面 sidecar /
 * Docker 是 `bun build --compile`），執行時旁邊沒有倉庫，讀不到這些目錄。與 embed-media.js
 * 同一個道理。生成檔案不入庫：內建技能的唯一真相是那些目錄。
 *
 * 誰調它（每一條要用到 core 的路都先過一處）：
 * - `scripts/embed-media.js`：typecheck、e2e、獨立版、單檔案、sidecar、Dockerfile、release；
 * - `esbuild.js`：VS Code 外掛的 compile / watch / package；
 * - `tests/helpers/load.js`：node 測試（單跑一條也算）。
 *
 * node 測試是多程序併發跑的，幾個程序會同時調到這裡：內容沒變就不寫，要寫也先寫臨時檔案再
 * rename，讀的一方永遠讀到一份完整的。
 *
 * 換行一律收成 `\n`：倉庫沒有 .gitattributes，Windows 上檢出的是 CRLF。
 *
 * 用法：node scripts/embed-skills.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'src', 'core', 'skills', 'builtin');
const OUT = path.join(SKILLS_DIR, 'embedded.ts');

/** 與 `model/writingSkill.ts` 的技能名同一條規則：目錄名就是 `builtin:<名字>` 裡的名字。 */
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
/** 一份內建技能的目錄（全部檔案合計）最多多大。注入的上限另算（64 KiB，見 writingSkill.ts）。 */
const MAX_DIR_BYTES = 256 * 1024;

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(abs, relPath, out);
    } else if (entry.isFile()) {
      out.push([relPath, abs]);
    } else {
      throw new Error(`內建技能裡不收連結與特殊檔案：${path.relative(ROOT, abs)}`);
    }
  }
  return out;
}

function readText(abs) {
  const buf = fs.readFileSync(abs);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    throw new Error(`內建技能裡只收 UTF-8 文字：${path.relative(ROOT, abs)}`);
  }
}

function render() {
  const skills = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const lines = [
    '// 由 scripts/embed-skills.js 從 src/core/skills/builtin/<名字>/ 生成，勿手改。',
    '',
    '/** 內建技能：目錄名 → 技能目錄裡的全部檔案（相對路徑 → 文字）。 */',
    'export const BUILTIN_SKILL_DIRS: Readonly<Record<string, Readonly<Record<string, string>>>> = {',
  ];
  for (const name of skills) {
    if (!SKILL_NAME.test(name)) {
      throw new Error(`內建技能的目錄名不合法：${name}`);
    }
    const dir = path.join(SKILLS_DIR, name);
    const files = walk(dir, '', []).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!files.some(([rel]) => rel === 'SKILL.md')) {
      throw new Error(`內建技能 ${name} 裡沒有 SKILL.md`);
    }
    let bytes = 0;
    lines.push(`  ${JSON.stringify(name)}: {`);
    for (const [rel, abs] of files) {
      const text = readText(abs);
      bytes += Buffer.byteLength(text, 'utf8');
      lines.push(`    ${JSON.stringify(rel)}: ${JSON.stringify(text)},`);
    }
    if (bytes > MAX_DIR_BYTES) {
      throw new Error(`內建技能 ${name} 合計 ${bytes} 位元組，超過 ${MAX_DIR_BYTES}`);
    }
    lines.push('  },');
  }
  lines.push('};', '');
  return { text: lines.join('\n'), count: skills.length };
}

/** 生成（內容沒變就不寫）。返回生成檔案的路徑。 */
function embedSkills({ quiet = false } = {}) {
  const { text, count } = render();
  let current;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== text) {
    const tmp = `${OUT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, OUT);
    if (!quiet) {
      console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${count} 份內建技能）`);
    }
  }
  return OUT;
}

module.exports = { embedSkills, SKILLS_DIR };

if (require.main === module) {
  try {
    embedSkills();
  } catch (e) {
    console.error(e.message ?? e);
    process.exit(1);
  }
}
