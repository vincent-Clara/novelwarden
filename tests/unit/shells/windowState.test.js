/**
 * ~/.novelwarden/window.json：測試一律寫進臨時目錄，不碰真實主目錄。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

const {
  readWindowState,
  writeWindowState,
  rememberOpen,
  rememberClosed,
} = loadModule('src/shells/standalone/windowState.ts');

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-window-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('windowState', () => {
  test('缺檔案時 lastOpen 為空、recents 為空', () => {
    assert.deepEqual(readWindowState(dir), { lastOpen: null, recents: [] });
  });

  test('壞 JSON 降級成空狀態', () => {
    fs.writeFileSync(path.join(dir, 'window.json'), '{not json', 'utf8');
    assert.deepEqual(readWindowState(dir), { lastOpen: null, recents: [] });
  });

  test('rememberOpen 記下 lastOpen 並插入 recents 頭部', () => {
    const root = path.resolve(dir, 'book-a');
    const state = rememberOpen(root, dir);
    assert.equal(state.lastOpen, root);
    assert.equal(state.recents.length, 1);
    assert.equal(state.recents[0].root, root);
    assert.equal(state.recents[0].name, 'book-a');
    assert.equal(typeof state.recents[0].openedAt, 'number');
  });

  test('同一路徑再次開啟只留一條，並更新到最前', () => {
    const a = path.resolve(dir, 'book-a');
    const b = path.resolve(dir, 'book-b');
    rememberOpen(a, dir);
    rememberOpen(b, dir);
    const state = rememberOpen(a, dir);
    assert.equal(state.recents.length, 2);
    assert.equal(state.recents[0].root, a);
    assert.equal(state.recents[1].root, b);
  });

  test('recents 上限 20', () => {
    for (let i = 0; i < 25; i++) {
      rememberOpen(path.resolve(dir, `n${i}`), dir);
    }
    const state = readWindowState(dir);
    assert.equal(state.recents.length, 20);
    assert.equal(state.recents[0].name, 'n24');
    assert.equal(state.recents[19].name, 'n5');
  });

  test('rememberClosed 清 lastOpen、保留 recents', () => {
    const root = path.resolve(dir, 'keep');
    rememberOpen(root, dir);
    const state = rememberClosed(dir);
    assert.equal(state.lastOpen, null);
    assert.equal(state.recents[0].root, root);
  });

  test('writeWindowState 落盤為 JSON', () => {
    writeWindowState({ lastOpen: null, recents: [] }, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'window.json'), 'utf8'));
    assert.equal(raw.lastOpen, null);
    assert.deepEqual(raw.recents, []);
  });
});
