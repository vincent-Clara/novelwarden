/**
 * 模型輸出清洗與標題推斷（純函式部分）。
 * 遷自 scripts/smoke.js 的 `== creation.ts · cleanOutput ==` 一節。
 * 創作編排層的落盤行為在 tests/integration/features/creation.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('creation.ts · cleanOutput', () => {
  let cw;
  let cleanOutput;

  before(() => {
    cw = loadModule('src/core/features/creation.ts');
    ({ cleanOutput } = cw);
  });

  test('去掉程式碼塊包裹', () => {
    assert.equal(cleanOutput('```\n正文內容\n```'), '正文內容');
  });

  test('去掉「好的，以下是」開場白', () => {
    assert.equal(cleanOutput('好的，以下是續寫內容：\n\n正文內容'), '正文內容');
  });

  test('去掉「以下是」開場白', () => {
    assert.equal(cleanOutput('以下是第四章：\n\n正文內容'), '正文內容');
  });

  test('去掉 markdown 章節標題', () => {
    assert.equal(cleanOutput('## 第四章 燈下\n\n正文內容'), '正文內容');
  });

  test('去掉裸章節標題行', () => {
    assert.equal(cleanOutput('第四章 燈下\n\n正文內容'), '正文內容');
  });

  test('去掉結尾字數統計', () => {
    assert.equal(cleanOutput('正文內容\n\n（本章約 2000 字）'), '正文內容');
  });

  test('正常正文不被誤傷', () => {
    assert.equal(
      cleanOutput('雨下了三天，青崖鎮的石板路泡得發白。'),
      '雨下了三天，青崖鎮的石板路泡得發白。'
    );
  });

  test('正文中的「第三章」不被誤刪', () => {
    assert.ok(cleanOutput('他想起第三章那件事，於是停下。').includes('第三章'));
  });

  describe('suggestTitle', () => {
    test('suggestTitle 取綱要首句', () => {
      const title = cw.suggestTitle('1. 林昭帶年輕守衛去見他母親，第三塊令牌出現。\n2. 沈氏尾隨。', 4);
      assert.equal(title, '林昭帶年輕守衛去見他母親');
    });

    test('suggestTitle 空綱要有兜底', () => {
      assert.equal(cw.suggestTitle('', 4), '第4章');
    });
  });
});
