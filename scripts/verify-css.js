/*
 * 比對重構前後的 CSS 是否等價。用法：
 *   node scripts/verify-css.js <舊檔案> <新檔案>
 *
 * 拆分 CSS 時最怕兩件事：漏掉某條規則，以及把兩條會互相覆蓋的規則調換順序。
 * 這個指令碼各查一遍：
 *   ① 規則集合是否一條不多一條不少；
 *   ② 「同選擇器 + 同屬性」的相對順序有沒有被改變（那才影響層疊）。
 *
 * esbuild 會順手規範化引號、把非 ASCII 字元轉義，這些不影響渲染，
 * 比對前統一抹平。
 */
const fs = require('node:fs');

/** 抹平 esbuild 的規範化：引號、屬性選擇器裡的引號、`\258c` 這類轉義。 */
function norm(s) {
  return s
    .replace(/\\([0-9a-fA-F]{2,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 CSS 拆成 [選擇器, 宣告塊] 的序列。@media 之類的塊整體當一條。 */
function parse(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let buf = '';
  let sel = '';
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) {
        sel = buf.trim();
        buf = '';
      } else {
        buf += ch;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules.push([norm(sel), norm(buf)]);
        buf = '';
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
  }
  return rules;
}

const key = ([sel, block]) => `${sel}{${block}}`;
const propsOf = (block) =>
  block.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean);

const [oldFile, newFile] = process.argv.slice(2);
const before = parse(fs.readFileSync(oldFile, 'utf8'));
const after = parse(fs.readFileSync(newFile, 'utf8'));

let failed = false;
console.log(`${newFile}：舊 ${before.length} 條 / 新 ${after.length} 條`);

// ---- ① 規則集合
const countBefore = new Map();
const countAfter = new Map();
for (const r of before) countBefore.set(key(r), (countBefore.get(key(r)) || 0) + 1);
for (const r of after) countAfter.set(key(r), (countAfter.get(key(r)) || 0) + 1);

const lost = [...countBefore].filter(([k, n]) => countAfter.get(k) !== n);
const added = [...countAfter].filter(([k, n]) => countBefore.get(k) !== n);
if (lost.length || added.length) {
  failed = true;
  console.log('  ✗ 規則集合不一致');
  for (const [k] of lost.slice(0, 8)) console.log('    只在舊檔案：', k.slice(0, 140));
  for (const [k] of added.slice(0, 8)) console.log('    只在新檔案：', k.slice(0, 140));
} else {
  console.log('  ✓ 規則集合完全一致');
}

// ---- ② 層疊順序
const posAfter = new Map();
after.forEach((r, i) => posAfter.set(key(r), i));
let flipped = 0;
for (let i = 0; i < before.length; i++) {
  for (let j = i + 1; j < before.length; j++) {
    if (before[i][0] !== before[j][0]) {
      continue;
    }
    const shared = propsOf(before[i][1]).filter((p) => propsOf(before[j][1]).includes(p));
    if (shared.length === 0) {
      continue;
    }
    if (posAfter.get(key(before[i])) > posAfter.get(key(before[j]))) {
      flipped++;
      console.log(`  ✗ 順序翻轉且屬性衝突：${before[i][0]} — ${shared.join(', ')}`);
    }
  }
}
if (flipped === 0) {
  console.log('  ✓ 沒有「同選擇器 + 同屬性」的相對順序被改變');
} else {
  failed = true;
}

process.exit(failed ? 1 : 0);
