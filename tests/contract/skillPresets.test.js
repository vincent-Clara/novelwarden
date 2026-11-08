/**
 * 倉庫裡的預設寫作技能（skills/writing/）：改編自 jarvis-write 的三類預設，加上本倉庫自己寫的幾份。
 *
 * 它們不隨應用釋出，作者從 GitHub 一份一份裝進「我的技能庫」——裝的時候過的就是
 * `inspectSkillMarkdown` 那幾道關，所以這裡拿同一個函式把每一份過一遍，免得哪天改了一份、
 * 作者裝的時候才發現裝不了。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 每個目錄一份 SKILL.md，相容、name 就是目錄名 | 安裝按 frontmatter 的 name 落目錄；名字對不上，README 裡的名字就對不上裝出來的那一份 |
 * | stage 寫明，且跟字首對得上 | 文風寫正文、味道與骨架規劃；自己寫的照 OWN；不寫就要靠關鍵詞猜 |
 * | 改編的許可兩行都在，許可原文在；自己寫的不掛 jarvis-write 的出處 | Apache-2.0 要求保留出處、寫明改過；不是改編的就別說是 |
 * | README 列全，沒有多列 | README 就是安裝入口，少一行等於沒有這份 |
 * | 正文挨著中文的標點是全形 | 示範段會被模型照著學；原文是半形，轉的時候改過，別再改回去 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../helpers/load');

const m = loadModule('src/core/model/writingSkill.ts');

const DIR = path.join(ROOT, 'skills', 'writing');
const STAGE_OF_PREFIX = { style: 'drafting', taste: 'planning', pattern: 'planning' };
/** 本倉庫自己寫的（不是改編的）：名字 → 綁哪個階段 */
const OWN = { 'tension-logic-humanizer': 'drafting' };

const names = fs
  .readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const adapted = names.filter((n) => !(n in OWN));
const raw = (name) => fs.readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8');

describe('預設寫作技能（skills/writing/）', () => {
  test('文風 16、味道 8、骨架 8，另有自己寫的', () => {
    const count = (prefix) => adapted.filter((n) => n.startsWith(`${prefix}-`)).length;
    assert.deepEqual([count('style'), count('taste'), count('pattern'), adapted.length], [16, 8, 8, 32]);
    assert.deepEqual(names.filter((n) => n in OWN), Object.keys(OWN).sort());
  });

  test('每一份都相容，name 就是目錄名，stage 跟字首對得上', () => {
    for (const name of names) {
      const i = m.inspectSkillMarkdown(raw(name), name);
      assert.ok(m.isSkillName(name), name);
      assert.equal(i.compatible, true, `${name}：${m.describeIncompat(i.reasons)}`);
      assert.equal(i.name, name);
      assert.equal(i.stage, OWN[name] ?? STAGE_OF_PREFIX[name.split('-')[0]], name);
      assert.ok(i.displayName && i.description && i.version, name);
    }
  });

  test('改編的每一份都寫著許可與出處，許可原文在；自己寫的不掛出處', () => {
    for (const name of adapted) {
      const text = raw(name);
      assert.match(text, /^license: Apache-2\.0$/m, name);
      assert.match(text, /^origin: 改編自 jarvis-write/m, name);
    }
    for (const name of Object.keys(OWN)) assert.doesNotMatch(raw(name), /jarvis-write/, name);
    assert.match(fs.readFileSync(path.join(DIR, 'LICENSE-jarvis-write'), 'utf8'), /Apache License\s+Version 2\.0/);
  });

  test('README 列全，沒有多列', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    const listed = [...readme.matchAll(/tree\/main\/skills\/writing\/([^)\s]+)\)/g)].map((x) => x[1]).sort();
    assert.deepEqual(listed, names);
  });

  test('正文裡挨著中文的標點是全形', () => {
    const halfWidth = /[一-鿿「」][,?!:;()]|[,?!:;()][一-鿿「」]/;
    for (const name of names) {
      const body = m.inspectSkillMarkdown(raw(name), name).body;
      const line = body.split('\n').find((l) => halfWidth.test(l));
      assert.equal(line, undefined, `${name}：${line}`);
    }
  });
});
