/**
 * 審稿在編輯器那一側的兩件事（五期，獨立版）：章節條上的「審稿」、點引文之後選中那一句。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 有正文的章 | 「審稿」亮，提示裡寫呼叫次數；點了發 `chapterAction` |
 * | 沒有正文的章 | 「審稿」不亮 |
 * | `editorReveal` | 選區落在那一句上（標點、空白不同也認），切到那份檔案 |
 * | 找不到那一句 | 不動選區，提示一句 |
 * | 滾到哪裡 | 按高亮映象層量出來的位置滾，那一句停在視口偏上三分之一（不再按字元位置佔全文的比例估） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, MIRROR_LAYOUT, file, sampleTree, sampleChapterIndex } = require('../../helpers/dom');

const BODY = '# 入鎮\n\n雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。\n\n沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。\n';

describe('章節條「審稿」', { skip: JSDOM_SKIP }, () => {
  let ui;
  const btn = () => ui.doc.getElementById('edChapterBar').querySelector('button[data-action="review"]');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'chapterIndex', chapters: sampleChapterIndex() });
  });

  test('有正文的章：亮，提示裡寫呼叫次數，點了發 chapterAction', () => {
    ui.post({ type: 'editorOpen', file: file('chapters/002-入鎮.md', BODY) });
    assert.equal(btn().disabled, false);
    // 2026-10-25 起審稿多一次轉寫：審 1 次、轉寫 1 次，最多 7 次。
    assert.match(btn().title, /只出報告，不改檔案。預計 2 次呼叫，最多 7 次/);
    ui.clickEl(btn());
    const sent = ui.last('chapterAction');
    assert.equal(sent.action, 'review');
  });

  test('沒有正文的章：不亮', () => {
    const tree = sampleTree();
    const plot = tree.plots.find((p) => p.plotExists && !p.chapterPath);
    ui.post({ type: 'editorOpen', file: file(plot.plotPath, '# 細綱') });
    assert.equal(btn().disabled, true);
  });
});

describe('點引文：編輯區選中那一句', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/002-入鎮.md', BODY) });
    ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭') });
  });

  test('切回那一章，選區落在那一句上（標點不同也認）', () => {
    ui.post({ type: 'editorReveal', path: 'chapters/002-入鎮.md', quote: '她把那塊殘令，收進了袖中' });
    const a = area();
    assert.equal(a.value, BODY);
    assert.equal(a.value.slice(a.selectionStart, a.selectionEnd), '她把那塊殘令收進了袖中');
    const active = ui.doc.querySelector('.ed-tab.active .ed-tab-name');
    assert.equal(active.textContent, '002-入鎮.md');
  });

  test('找不到那一句：不動選區，提示一句', () => {
    const a = area();
    const before = [a.selectionStart, a.selectionEnd];
    ui.post({ type: 'editorReveal', path: 'chapters/002-入鎮.md', quote: '根本沒有這一句話' });
    assert.deepEqual([a.selectionStart, a.selectionEnd], before);
    assert.match(ui.doc.getElementById('toast').textContent, /找不到了/);
  });
});

describe('點引文：按映象層量出來的位置滾', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  // 第一行很長、後面都很短：按字元位置佔全文的比例估，會把第 30 行估到很靠前的地方。
  const LINES = [`${'序'.repeat(4000)}。`, ...Array.from({ length: 39 }, (_, i) => `第${i + 2}行的字。`)];
  const TEXT = LINES.join('\n');

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['pointerCapture', 'confirm', 'mirrorLayout'],
    });
    ui.post({ type: 'editorOpen', file: file('chapters/002-入鎮.md', TEXT) });
  });

  test('那一句停在視口偏上三分之一處', () => {
    ui.post({ type: 'editorReveal', path: 'chapters/002-入鎮.md', quote: '第30行的字' });
    const { line, pad, viewport } = MIRROR_LAYOUT;
    const top = pad + 29 * line;
    assert.equal(area().scrollTop, top - viewport / 3);
  });

  test('量的是那一句的第一個字，量完標記就撤掉', () => {
    assert.equal(ui.window.__measured.at(-1), '第');
    const probe = ui.doc.querySelector('#wbEditor .ed-mirror-probe .ed-mirror-content');
    assert.equal(probe.childNodes.length, 0);
  });
});
