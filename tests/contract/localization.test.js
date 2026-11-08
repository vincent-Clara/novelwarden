/** 繁體介面與舊工程格式相容性：不要藉由翻譯更動儲存鍵。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadModule, ROOT } = require('../helpers/load');
const path = require('node:path');

test('繁簡小節都回到既有欄位，寫出的標題為繁體', () => {
  const md = loadModule('src/core/model/markdown.ts');
  const keys = ['语言习惯', '当前状态'];
  const old = md.pickSections('## 语言习惯\n短句\n## 当前状态\n在門外', keys);
  const current = md.pickSections('## 語言習慣\n短句\n## 當前狀態\n在門外', keys);
  assert.deepEqual(current, old);
  assert.deepEqual(Object.keys(current), keys);
  assert.match(md.stringifySections(current, keys), /## 語言習慣/);
  for (const placeholder of ['（待补充）', '(待补充)', '（待補充）', '(待補充)']) {
    assert.equal(md.hasContent(placeholder), false);
  }
});

test('敘事線可讀繁簡別名，但事件資料仍用既有列舉', () => {
  const thread = loadModule('src/core/model/threadFile.ts');
  assert.equal(thread.threadKindOf('主線'), '主线');
  assert.equal(thread.threadKindOf('主线'), '主线');
  assert.equal(thread.eventTypeOf('推進'), '推进');
  assert.equal(thread.eventTypeOf('推进'), '推进');
  assert.equal(thread.parseEventLine('第 3 章 · 計劃 · 推進：去渡口').planned, true);
});

test('繁簡數字章號皆可查詢', () => {
  const quick = loadModule('media/src/editor/quickOpenCore.ts');
  for (const input of ['两百', '兩百', '貳百']) assert.equal(quick.parseChineseNumber(input), 200);
  for (const input of ['三万', '三萬']) assert.equal(quick.parseChineseNumber(input), 30000);
});

test('內建提示詞要求繁體，不再要求簡體', () => {
  for (const file of ['src/core/context/prompts.ts', 'src/core/features/charactersPrompt.ts', 'src/core/features/summarizePrompt.ts', 'src/core/features/stylePrompt.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /繁體中文/);
    assert.doesNotMatch(source, /[简簡][体體]中文/);
  }
});

test('線名裝飾的可選「名」不改變正則語意，作者文字不自動轉換', () => {
  const thread = loadModule('src/core/model/threadFile.ts');
  for (const name of ['【線】玉佩', '【線名】玉佩', '【线】玉佩', '【线名】玉佩', '線名：玉佩', '线名：玉佩']) {
    assert.equal(thread.bareThreadName(name), '玉佩');
  }
  assert.equal(thread.bareThreadName('【線】年轻守卫'), '年轻守卫');
  const { traditionalLabel } = loadModule('src/core/model/labels.ts');
  assert.equal(traditionalLabel('主线'), '主線');
  assert.equal(traditionalLabel('年轻守卫去客栈'), '年轻守卫去客栈');
});

test('曆法與日期接受繁簡寫法，仍回傳原有儲存值', () => {
  const timeline = loadModule('src/core/model/timelineFile.ts');
  for (const cal of ['公历', '公曆']) {
    assert.equal(timeline.parseTimelineFile(`---\ncalendar: ${cal}\n---\n# 時間線`, 'threads/时间线.md').calendar, '公历');
  }
  assert.equal(timeline.parseNumber('兩萬三千'), 23000);
});

test('固定檔名沿用舊工程，繁簡保留名都不允許另建敘事線', () => {
  const thread = loadModule('src/core/model/threadFile.ts');
  assert.equal(thread.UNFILED_FILENAME, '未归属的伏笔.md');
  assert.equal(thread.TIMELINE_FILENAME, '时间线.md');
  for (const name of ['未归属的伏笔', '未歸屬的伏筆', '时间线', '時間線']) {
    assert.equal(thread.isReservedThreadName(name), true);
  }
});
