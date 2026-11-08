/**
 * 角色卡「當前狀態」歸誰（D15）與只動那一節的寫法。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 空的、指紋對得上 → 機器的 | 批次序列寫十章，不能每章彈一次 diff |
 * | 改過、沒記過指紋的非空內容 → 作者的 | 第 3 條：不靜默覆蓋（上游同一口徑） |
 * | 只換那一節 | 整卡重渲染會抹掉作者自加的小節 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const state = loadModule('src/core/model/characterState.ts');
const md = loadModule('src/core/model/markdown.ts');

const card = (当前状态, stateHash) => ({ sections: { 当前状态 }, stateHash });

describe('characterState.ts · 歸屬', () => {
  test('空的一節歸機器', () => {
    assert.ok(state.stateOwnedByMachine(card('', undefined)));
    assert.ok(state.stateOwnedByMachine(card('  \n', 'whatever')));
  });

  test('機器蓋過章、沒人動過 → 機器的', () => {
    const stamped = state.stampState(card('在青崖鎮的客棧養傷'), 3);
    assert.equal(stamped.stateThrough, 3);
    assert.ok(state.stateOwnedByMachine(stamped));
  });

  test('首尾空白不算改過', () => {
    const stamped = state.stampState(card('在青崖鎮的客棧養傷'), 3);
    assert.ok(state.stateOwnedByMachine({ ...stamped, sections: { 当前状态: '\n在青崖鎮的客棧養傷  \n' } }));
  });

  test('作者改過一個字 → 作者的', () => {
    const stamped = state.stampState(card('在青崖鎮的客棧養傷'), 3);
    assert.ok(!state.stateOwnedByMachine({ ...stamped, sections: { 当前状态: '在青崖鎮的客棧養傷，傷口化膿' } }));
  });

  test('從沒記過指紋、卻有內容 → 作者的（手寫的卡、換軸之前的卡）', () => {
    assert.ok(!state.stateOwnedByMachine(card('在青崖鎮', undefined)));
  });

  test('「狀態截至第 K 章」的說法', () => {
    assert.equal(state.describeStateThrough(3), '狀態截至第 3 章');
    assert.equal(state.describeStateThrough(0), '開篇狀態');
    assert.equal(state.describeStateThrough(undefined), '');
  });
});

describe('markdown.ts · replaceSection', () => {
  const CARD = [
    '---',
    'name: 林昭',
    '---',
    '',
    '# 林昭',
    '',
    '## 身份',
    '',
    '孤兒',
    '',
    '## 當前狀態',
    '',
    '在客棧',
    '### 細節',
    '左臂有傷',
    '',
    '## 我的筆記',
    '',
    '作者自己加的一節',
    '',
  ].join('\n');

  test('只換那一節（連同它下面的三級標題），其餘原樣', () => {
    const out = md.replaceSection(CARD, '当前状态', '離開了青崖鎮，往北去');
    assert.match(out, /## 當前狀態\n\n離開了青崖鎮，往北去\n\n## 我的筆記/);
    assert.match(out, /## 身份\n\n孤兒/);
    assert.match(out, /作者自己加的一節/);
    assert.doesNotMatch(out, /左臂有傷/);
  });

  test('最後一節也換得了，結尾只留一個換行', () => {
    const text = '# 林昭\n\n## 當前狀態\n\n在客棧\n\n\n';
    assert.equal(md.replaceSection(text, '当前状态', '往北去'), '# 林昭\n\n## 當前狀態\n\n往北去\n');
  });

  test('沒有這一節就追加在末尾', () => {
    assert.equal(md.replaceSection('# 林昭\n\n## 身份\n\n孤兒\n', '当前状态', '往北去'), '# 林昭\n\n## 身份\n\n孤兒\n\n## 當前狀態\n\n往北去\n');
  });

  test('小節名按寬鬆規則認；CRLF 原樣保留', () => {
    const text = '# 林昭\r\n\r\n## 當前 狀態：\r\n\r\n在客棧\r\n';
    assert.equal(md.replaceSection(text, '当前状态', '往北去'), '# 林昭\r\n\r\n## 當前 狀態：\r\n\r\n往北去\r\n');
  });

  test('空值寫佔位文字，結構不塌', () => {
    assert.match(md.replaceSection(CARD, '当前状态', ''), /## 當前狀態\n\n（待補充）\n\n## 我的筆記/);
  });
});
