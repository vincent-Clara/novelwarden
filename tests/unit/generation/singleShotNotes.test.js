/**
 * 不走鏈的產物（大綱等）寫完查一遍：截斷、沒寫到本批最後一章、缺了哪幾章、出現了不認的區間標題
 * （大綱一章一條，docs/design/plans/2026-10-21-outline-per-chapter.md）。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');
const { outlineOf } = require('../../helpers/outline');

const s = loadModule('src/core/generation/structured.ts');

describe('singleShotNotes · 大綱', () => {
  test('一章一條、寫滿本批：不說', () => {
    const notes = s.singleShotNotes('outline', outlineOf(10), 'end', { from: 1, to: 10 });
    assert.deepEqual(notes, []);
  });

  test('區間標題：說不認，點出有幾個', () => {
    const notes = s.singleShotNotes('outline', '## 第1–3章：甲\n一\n\n## 第4–20章：乙\n二\n', 'end', { from: 1, to: 20 });
    assert.ok(notes.some((n) => /有 2 個「## 第a–b章」這樣的區間標題/.test(n)), JSON.stringify(notes));
    assert.ok(notes.some((n) => /認不出「## 第N章：標題」這樣的章標題/.test(n)), JSON.stringify(notes));
  });

  test('只寫到第 N 章：說寫到哪、主按鈕會接著推續寫', () => {
    const notes = s.singleShotNotes('outline', outlineOf(15), 'end', { from: 1, to: 20 });
    assert.ok(notes.some((n) => /產出只寫到第 15 章（這一批要寫到第 20 章）/.test(n)), JSON.stringify(notes));
  });

  test('中間缺了幾章：點名缺第幾章', () => {
    const raw = outlineOf(10).replace('## 第4章\n第4章的事。\n\n', '').replace('## 第7章\n第7章的事。\n\n', '');
    const notes = s.singleShotNotes('outline', raw, 'end', { from: 1, to: 10 });
    assert.ok(notes.some((n) => /缺第 4、7 章/.test(n)), JSON.stringify(notes));
  });
});
