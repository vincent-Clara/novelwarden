/**
 * 存檔點的純函式（`src/core/workspace/checkpoints.ts`）：名字怎麼起與讀回來、清單怎麼容錯地讀、兩份檔案表怎麼比、
 * 自動存檔點裁掉哪幾個。落盤的那一半在 tests/integration/workspace/checkpoints.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let c;

before(() => {
  c = loadBundle({ checkpoints: './src/core/workspace/checkpoints.ts' }).checkpoints;
});

const SHA = (ch) => ch.repeat(64);

describe('存檔點的名字', () => {
  test('與歷史版本快照同一個格式，去掉 .txt；同一秒第二個帶序號', () => {
    const at = new Date(2026, 9, 20, 22, 30, 5);
    const id = c.checkpointIdOf(at);
    assert.match(id, /^2026-10-20_22-30-05[+-]\d{4}$/);
    assert.equal(c.checkpointIdOf(at, 2), `${id}-2`);
  });

  test('讀回來是那一刻；帶斜槓、亂寫的不認', () => {
    const at = new Date(2026, 9, 20, 22, 30, 5);
    assert.equal(c.parseCheckpointId(c.checkpointIdOf(at)), at.getTime());
    assert.equal(c.parseCheckpointId(c.checkpointIdOf(at, 3)), at.getTime());
    assert.equal(c.parseCheckpointId('../2026-10-20_22-30-05+0800'), undefined);
    assert.equal(c.parseCheckpointId('2026-10-20_22-30-05+0800/x'), undefined);
    assert.equal(c.parseCheckpointId('隨便寫的'), undefined);
  });
});

describe('parseManifest：容錯（第 1 條）', () => {
  const good = {
    v: 1,
    time: 1000,
    note: '第一卷寫完',
    auto: false,
    files: { 'chapters/001-雨夜.md': { sha: SHA('a'), bytes: 10, words: 5 } },
    skipped: ['chapters/002-大.txt'],
  };

  test('好的清單原樣讀回', () => {
    assert.deepEqual(c.parseManifest(JSON.stringify(good)), good);
  });

  test('不是 JSON、不是物件、沒有 files：整份不認', () => {
    assert.equal(c.parseManifest('{'), undefined);
    assert.equal(c.parseManifest('[]'), undefined);
    assert.equal(c.parseManifest(JSON.stringify({ time: 1 })), undefined);
  });

  test('單份壞了只丟那一份：越界的路徑、不像 sha 的', () => {
    const m = c.parseManifest(
      JSON.stringify({
        ...good,
        files: {
          ...good.files,
          '../外面.md': { sha: SHA('b'), bytes: 1, words: 1 },
          '/etc/passwd': { sha: SHA('b'), bytes: 1, words: 1 },
          'chapters/../x.md': { sha: SHA('b'), bytes: 1, words: 1 },
          'chapters/002.md': { sha: 'xyz', bytes: 1, words: 1 },
          'chapters/003.md': 'oops',
        },
      })
    );
    assert.deepEqual(Object.keys(m.files), ['chapters/001-雨夜.md']);
  });

  test('time 缺了從名字補；名字也認不出就不認', () => {
    const { time, ...rest } = good;
    void time;
    const id = c.checkpointIdOf(new Date(2026, 0, 2, 3, 4, 5));
    assert.equal(c.parseManifest(JSON.stringify(rest), id).time, new Date(2026, 0, 2, 3, 4, 5).getTime());
    assert.equal(c.parseManifest(JSON.stringify(rest)), undefined);
  });

  test('note / auto / skipped 缺了或型別不對給預設值；字數缺了給 0', () => {
    const m = c.parseManifest(
      JSON.stringify({ time: 5, auto: 'yes', note: 3, skipped: [1, 'a'], files: { 'a.md': { sha: SHA('c') } } })
    );
    assert.equal(m.note, '');
    assert.equal(m.auto, false);
    assert.deepEqual(m.skipped, ['a']);
    assert.deepEqual(m.files['a.md'], { sha: SHA('c'), bytes: 0, words: 0 });
  });
});

describe('sameFiles', () => {
  test('路徑一樣、每份 sha 一樣才算一樣', () => {
    const a = { x: { sha: SHA('a') }, y: { sha: SHA('b') } };
    assert.equal(c.sameFiles(a, { y: { sha: SHA('b') }, x: { sha: SHA('a') } }), true);
    assert.equal(c.sameFiles(a, { x: { sha: SHA('a') } }), false);
    assert.equal(c.sameFiles(a, { x: { sha: SHA('a') }, y: { sha: SHA('c') } }), false);
    assert.equal(c.sameFiles(a, { x: { sha: SHA('a') }, z: { sha: SHA('b') } }), false);
    assert.equal(c.sameFiles({}, {}), true);
  });
});

describe('compareFiles：存檔點 ↔ 此刻', () => {
  const then = {
    'chapters/001.md': { sha: SHA('a'), bytes: 1, words: 100 },
    'chapters/002.md': { sha: SHA('b'), bytes: 1, words: 200 },
    'chapters/003.md': { sha: SHA('c'), bytes: 1, words: 300 },
  };
  const now = {
    'chapters/001.md': { sha: SHA('a'), words: 100, hash: 'h1' },
    'chapters/002.md': { sha: SHA('d'), words: 250, hash: 'h2' },
    'chapters/010.md': { sha: SHA('e'), words: 50, hash: 'h10' },
    'chapters/大.txt': { sha: SHA('f'), words: 1, hash: 'hbig' },
  };

  test('三類：改過的、之後刪掉的、之後新建的；一模一樣的只計數', () => {
    const r = c.compareFiles(then, now, ['chapters/大.txt']);
    assert.equal(r.unchanged, 1);
    assert.deepEqual(r.entries, [
      { path: 'chapters/002.md', status: 'changed', wordsThen: 200, wordsNow: 250, hashNow: 'h2' },
      { path: 'chapters/003.md', status: 'deleted', wordsThen: 300 },
      { path: 'chapters/010.md', status: 'added', wordsNow: 50, hashNow: 'h10' },
    ]);
  });

  test('當時太大沒存的那一份不算「之後新建」', () => {
    assert.ok(!c.compareFiles(then, now, ['chapters/大.txt']).entries.some((e) => e.path === 'chapters/大.txt'));
    assert.ok(c.compareFiles(then, now).entries.some((e) => e.path === 'chapters/大.txt' && e.status === 'added'));
  });

  test('按路徑排，數字按數值（2 在 10 前面）', () => {
    const r = c.compareFiles({}, { 'c/10.md': { sha: SHA('a'), words: 1, hash: 'a' }, 'c/2.md': { sha: SHA('b'), words: 1, hash: 'b' } });
    assert.deepEqual(r.entries.map((e) => e.path), ['c/2.md', 'c/10.md']);
  });
});

describe('checkpointsToPrune：手動的永遠留，自動的留最近 N 個', () => {
  test('新的在前；只裁自動的，裁最舊的那幾個', () => {
    const list = [
      { id: 'a6', auto: true },
      { id: 'm5', auto: false },
      { id: 'a4', auto: true },
      { id: 'a3', auto: true },
      { id: 'm2', auto: false },
      { id: 'a1', auto: true },
    ];
    assert.deepEqual(c.checkpointsToPrune(list, 2), ['a3', 'a1']);
    assert.deepEqual(c.checkpointsToPrune(list, 10), []);
  });

  test('預設留 30 個', () => {
    assert.equal(c.CHECKPOINT_AUTO_KEEP, 30);
    const list = Array.from({ length: 33 }, (_, i) => ({ id: `a${33 - i}`, auto: true }));
    assert.deepEqual(c.checkpointsToPrune(list), ['a3', 'a2', 'a1']);
  });
});
