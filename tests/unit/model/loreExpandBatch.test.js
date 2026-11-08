/**
 * 完善設定三期的兩個純函式（model/pipeline.ts）：批次展開的呼叫次數與寫前提醒那一句。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 批次展開每條 2 次、最多 4 次（2026-10-25 起寫完轉寫），n 條乘 n；原因寫明「重轉一次、重寫一次，兩樣不疊加」 | 第 4 條：工程頁選單、確認框報的是同一個數 |
 * | 寫前提醒：本章 / 區間裡兩種說法，名字最多列 5 個、多了寫總數；區間裡那句寫明不攔 | 工作臺、批次寫章彈窗與確認框同一句（零呼叫、不攔） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');

describe('批次展開的呼叫次數', () => {
  test('每條 2 次（寫 1、轉寫 1）、最多 4 次', () => {
    const { low, high, max } = pipeline.LORE_EXPAND_BATCH_CALLS;
    assert.deepEqual([low, high, max], [2, 2, 4]);
  });

  test('n 條乘 n，原因照抄', () => {
    assert.equal(
      pipeline.describeCalls(pipeline.loreExpandCalls(3)),
      '預計 6 次呼叫，最多 12 次（寫 1 次、轉寫 1 次；轉寫不合格重轉 1 次，或者整理不出來時這一條重寫、再轉寫 1 次，兩樣不疊加）'
    );
  });
});

describe('寫前提醒那一句', () => {
  test('本章', () => {
    assert.equal(
      pipeline.describeThinLore('本章', ['天機閣', '九層樓']),
      '本章要用的 天機閣、九層樓 還只有一句話，寫之前可以先展開（在工程頁「待完善」裡右鍵「展開…」）。'
    );
  });

  test('區間裡：寫總數、寫明不攔', () => {
    assert.equal(
      pipeline.describeThinLore('区间里', ['天機閣']),
      '區間裡 1 條要用到的設定還只有一句話（天機閣），寫之前可以先在工程頁「待完善」裡展開；不展開也照寫。'
    );
  });

  test('名字最多列 5 個，多了寫總數', () => {
    const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
    assert.ok(pipeline.describeThinLore('区间里', names).includes('（甲、乙、丙、丁、戊 等 7 條）'));
    assert.ok(pipeline.describeThinLore('本章', names).startsWith('本章要用的 甲、乙、丙、丁、戊 等 7 條 還只有一句話'));
  });
});
