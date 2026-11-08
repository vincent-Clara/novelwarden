/**
 * 故事結構指導：六種結構按總章數切成章號區間。
 *
 * 上游（AI-Novel-Writer）只給四種算了區間，英雄之旅與節拍表只有一行佔位。
 * 這裡釘的是：六種都有區間，而且在任何章數下都**連續、從第 1 章起、到最後一章止**
 * ——大綱按它排結構拐點，斷一截就有幾章落不進任何一段。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const guide = loadModule('src/core/model/structureGuide.ts');
const setting = loadModule('src/core/model/settingFile.ts');

function assertContiguous(stages, total, label) {
  assert.equal(stages[0].from, 1, `${label}：從第 1 章起`);
  assert.equal(stages[stages.length - 1].to, total, `${label}：到第 ${total} 章止`);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    assert.ok(s.from <= s.to, `${label}：第 ${i + 1} 段 ${s.from}–${s.to}`);
    if (i > 0) {
      const prev = stages[i - 1];
      // 章數夠分時首尾相接；不夠分時允許相鄰段共用一章，但不許跳過章。
      assert.ok(s.from === prev.to + 1 || (s.from === prev.to && s.to === prev.to), `${label}：第 ${i} / ${i + 1} 段銜接 ${prev.to} → ${s.from}`);
    }
  }
}

describe('structureGuide.ts · 六種結構的章號區間', () => {
  for (const structure of setting.PLOT_STRUCTURES) {
    for (const total of [3, 11, 20, 30, 100, 1000]) {
      test(`${structure} · ${total} 章：連續、覆蓋全書`, () => {
        assertContiguous(guide.structureStages(structure, total), total, `${structure}/${total}`);
      });
    }
  }

  test('章數夠分時每段至少一章，不共用', () => {
    const stages = guide.structureStages('save_the_cat', 30);
    assert.equal(stages.length, 15);
    for (let i = 1; i < stages.length; i++) {
      assert.equal(stages[i].from, stages[i - 1].to + 1);
    }
  });

  test('三幕 100 章：20 / 55 / 25（與上游的切法一致）', () => {
    const [a, b, c] = guide.structureStages('three_act', 100);
    assert.deepEqual([a.from, a.to, b.from, b.to, c.from, c.to], [1, 20, 21, 75, 76, 100]);
  });

  test('英雄之旅與節拍表都有逐段章號（修上游只有一行佔位的缺口）', () => {
    const hero = guide.structureGuideText('heros_journey', 100);
    assert.match(hero, /英雄之旅/);
    assert.match(hero, /平凡世界（第 1–5 章）/);
    assert.match(hero, /攜寶歸來（第 93–100 章）/);
    const cat = guide.structureGuideText('save_the_cat', 100);
    assert.match(cat, /中點（第 51–52 章）/);
    assert.equal(cat.split('\n').filter((l) => l.startsWith('- ')).length, 15);
  });

  test('結構缺席按三幕算', () => {
    assert.match(guide.structureGuideText(undefined, 40), /三幕結構/);
  });

  // 分批寫大綱時最常見的錯：把第 1–20 章寫成全書的縮略版。
  test('給了區間就點明本批落在哪幾段', () => {
    const text = guide.structureGuideText('three_act', 100, { from: 1, to: 20 });
    assert.match(text, /本次只寫第 1–20 章，它們落在：第一幕 · 建置（第 1–20 章）/);
    const later = guide.structureGuideText('three_act', 100, { from: 61, to: 80 });
    assert.match(later, /第二幕 · 對抗與發展（第 21–75 章）、第三幕 · 高潮與結局（第 76–100 章）/);
  });
});
