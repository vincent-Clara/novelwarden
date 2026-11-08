/**
 * 標籤上的名字（`media/src/editor/tabLabels.ts`，純函式）：短標記 + 名字，仍然同名的加最短的區分目錄。
 * 編輯器裡的整條鏈路（兩塊編輯區放在一起比、關掉一個之後收起）在 tests/dom/standalone/tabs.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { tabNames, distinguish } = loadModule('media/src/editor/tabLabels.ts');

const f = (path, tag, title) => ({
  path,
  name: path.split('/').pop(),
  ...(title !== undefined ? { label: { tag, title, crumbs: [] } } : {}),
});

describe('tabNames', () => {
  test('後端給了稱呼：用它的短標記與名字', () => {
    const names = tabNames([f('.novelwarden/summaries/003-夜訪.md', '細綱', '003-夜訪')]);
    assert.deepEqual(names.get('.novelwarden/summaries/003-夜訪.md'), { tag: '細綱', title: '003-夜訪', desc: '' });
  });

  test('沒給稱呼：名字是檔名、不帶短標記', () => {
    assert.deepEqual(tabNames([f('notes.txt')]).get('notes.txt'), { tag: '', title: 'notes.txt', desc: '' });
  });

  test('名字一樣、短標記不一樣：不算同名', () => {
    const names = tabNames([f('chapters/003-夜訪.md', '', '003-夜訪'), f('drafts/003-夜訪.md', '草稿', '003-夜訪')]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['', '']);
  });

  test('同一種、不同目錄：各寫緊挨著它的那一級目錄', () => {
    const names = tabNames([f('chapters/第一卷/003-夜訪.md', '', '003-夜訪'), f('chapters/第二卷/003-夜訪.md', '', '003-夜訪')]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['第一卷', '第二卷']);
  });

  test('三份撞名只撞了一部分：只有撞上的那幾份加', () => {
    const names = tabNames([
      f('chapters/第一卷/003-夜訪.md', '', '003-夜訪'),
      f('chapters/第二卷/003-夜訪.md', '', '003-夜訪'),
      f('chapters/004-北行.md', '', '004-北行'),
    ]);
    assert.deepEqual([...names.values()].map((n) => n.desc), ['第一卷', '第二卷', '']);
  });
});

describe('distinguish', () => {
  test('緊挨著的那一級一樣：往上加一級', () => {
    assert.equal(distinguish('甲/卷一/003.md', ['乙/卷一/003.md']), '甲/卷一');
  });

  test('一個在工程根、一個在子目錄：根下那個寫「工程根」', () => {
    assert.equal(distinguish('003.md', ['chapters/003.md']), '工程根');
    assert.equal(distinguish('chapters/003.md', ['003.md']), 'chapters');
  });

  test('目錄完全一樣（副檔名不同）：退到檔名本身', () => {
    assert.equal(distinguish('chapters/003-夜訪.md', ['chapters/003-夜訪.txt']), '003-夜訪.md');
  });
});
