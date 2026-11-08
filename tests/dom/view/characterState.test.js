/**
 * 角色行上的「當前狀態」（四期，D15）：寫到第幾章了，以及定稿時作者改過、沒被覆蓋的那一版的對比入口。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 說明裡寫「狀態截至第 K 章」 | 寫下一章前一眼看得出狀態跟沒跟上 |
 * | 掛著 `cardState` 的卡右鍵多一項「對比第 N 章給出的狀態…」，點了發 reviewState | D15：改過的不寫，但給入口 |
 * | 沒掛的卡沒有這一項 | 別給一個點了只會說「沒有待對比的」的選單 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LIN = '.novelwarden/characters/林昭.md';

describe('角色行 · 當前狀態', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rowOf = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.querySelector('.row-label')?.textContent === name);

  before(() => {
    ui = mount();
    const tree = sampleTree();
    tree.characters = [
      ...tree.characters.map((n) => (n.relPath === LIN ? { ...n, detail: '主角 · 狀態截至第 3 章' } : n)),
      { kind: 'file', label: '沈氏', relPath: '.novelwarden/characters/沈氏.md', detail: '' },
    ];
    tree.failures = {
      [LIN]: [
        {
          at: '2026-09-30T00:00:00Z',
          severity: 'warn',
          op: 'cardState',
          message: '第 3 章定稿給出了新的「當前狀態」，這一節你改過，沒有覆蓋',
          detail: '【第 3 章給出的當前狀態】\n往北去了',
        },
      ],
    };
    ui.post({ type: 'project', tree });
  });

  test('說明裡寫著狀態截至第幾章，掛著黃 ❗', () => {
    const row = rowOf('林昭');
    assert.ok(row, ui.doc.getElementById('projectBody').textContent.slice(0, 300));
    assert.ok(row.textContent.includes('狀態截至第 3 章'), row.textContent);
    assert.ok(row.querySelector('.row-failure.is-warn'));
  });

  test('右鍵多一項「對比第 3 章給出的狀態…」，點了發 reviewState', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('林昭')));
    assert.ok(items.includes('對比第 3 章給出的狀態…'), JSON.stringify(items));
    ui.closeMenu();
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('林昭')), '對比第 3 章給出的狀態…');
    const msg = ui.last('characterAction');
    assert.equal(msg?.action, 'reviewState', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, LIN);
  });

  test('沒掛的卡沒有這一項', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('沈氏')));
    assert.ok(!items.some((x) => x.startsWith('對比第')), JSON.stringify(items));
    ui.closeMenu();
  });
});
