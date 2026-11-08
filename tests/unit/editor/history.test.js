/**
 * 內建編輯器的撤銷歷史（`media/src/editor/history.ts`）：純邏輯，不碰 DOM。
 * 編輯器裡的整條鏈路（按鍵、切標籤、組字、選單）在 tests/dom/standalone/undo.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 連續打字併成一步，超過 1 秒、不挨著、換型別、帶換行都另起 | 撤銷的粒度 |
 * | 退格往前吃、Delete 往後吃都並 | 刪除同理 |
 * | `join` 並進剛記下的那一步，撤銷 / 重做之後不再並 | 成對標點的後半個隨前半個一起退 |
 * | 新的改動清掉重做棧 | 常規語義 |
 * | 上限 | 丟最早的，不無限增長 |
 * | 與文字對不上就整份作廢 | 寧可退不回去，也不拿錯位的差異改亂正文 |
 * | `diffText` 拿游標認對有歧義的位置、不切開代理對 | 差異記得準 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { EditHistory, diffText, MERGE_WINDOW_MS } = loadModule('media/src/editor/history.ts');

const caret = (n) => ({ start: n, end: n });

/** 模擬在 text 上打一下：返回新文字，並把這一下記進 h。 */
function apply(h, text, change, opts) {
  const next = text.slice(0, change.at) + change.inserted + text.slice(change.at + change.removed.length);
  h.record(change, caret(change.at + change.removed.length), caret(change.at + change.inserted.length), opts);
  return next;
}

describe('EditHistory：合併', () => {
  test('連續打字併成一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '林' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '昭' }, { merge: true, now: 300 });
    assert.equal(h.size, 1);
    assert.deepEqual(h.undo(t), { text: '', selection: caret(0) });
  });

  test('間隔超過 1 秒另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '林' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '昭' }, { merge: true, now: MERGE_WINDOW_MS + 1 });
    assert.equal(h.size, 2);
    assert.equal(h.undo(t).text, '林');
  });

  test('視窗按上一下算，不按這一步的開頭算', () => {
    const h = new EditHistory();
    let t = '';
    for (let i = 0; i < 5; i++) {
      t = apply(h, t, { at: i, removed: '', inserted: '字' }, { merge: true, now: i * 900 });
    }
    assert.equal(h.size, 1);
  });

  test('位置不挨著另起一步', () => {
    const h = new EditHistory();
    let t = '甲乙';
    t = apply(h, t, { at: 2, removed: '', inserted: '丙' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 0, removed: '', inserted: '丁' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('帶換行的單獨一步，之後打的字也不並進來', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '\n' }, { merge: true, now: 10 });
    t = apply(h, t, { at: 2, removed: '', inserted: '乙' }, { merge: true, now: 20 });
    assert.equal(h.size, 3);
  });

  test('打字與刪除不併', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲乙' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '乙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('打字蓋掉選區之後接著打，併成一步', () => {
    const h = new EditHistory();
    let t = '舊詞';
    t = apply(h, t, { at: 0, removed: '舊詞', inserted: '新' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '的' }, { merge: true, now: 10 });
    assert.equal(t, '新的');
    assert.equal(h.size, 1);
    assert.equal(h.undo(t).text, '舊詞');
  });

  test('退格往前吃、Delete 往後吃都並', () => {
    const h = new EditHistory();
    let t = '甲乙丙丁';
    t = apply(h, t, { at: 3, removed: '丁', inserted: '' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 2, removed: '丙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(h.size, 1);
    assert.equal(h.undo(t).text, '甲乙丙丁');

    const h2 = new EditHistory();
    let u = '甲乙丙丁';
    u = apply(h2, u, { at: 1, removed: '乙', inserted: '' }, { merge: true, now: 0 });
    u = apply(h2, u, { at: 1, removed: '丙', inserted: '' }, { merge: true, now: 10 });
    assert.equal(u, '甲丁');
    assert.equal(h2.size, 1);
    assert.equal(h2.undo(u).text, '甲乙丙丁');
  });

  test('不帶 merge 的（貼上、程式改寫）前後都不併', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = apply(h, t, { at: 2, removed: '', inserted: '丙' }, { merge: true, now: 20 });
    assert.equal(h.size, 3);
  });

  test('seal 之後另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    h.seal();
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { merge: true, now: 10 });
    assert.equal(h.size, 2);
  });

  test('撤銷之後接著打字另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = h.undo(t).text;
    t = apply(h, t, { at: 1, removed: '', inserted: '丙' }, { merge: true, now: 20 });
    assert.equal(h.size, 2);
    assert.equal(h.undo(t).text, '甲');
  });
});

describe('EditHistory：join', () => {
  test('並進剛記下的那一步，撤銷時一起退、重做時一起回', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '（' }, { now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '）' }, { join: true, now: 10 });
    assert.equal(h.size, 1);
    const back = h.undo(t);
    assert.equal(back.text, '');
    assert.equal(h.redo(back.text).text, '（）');
  });

  test('撤銷過之後的 join 照常另起一步', () => {
    const h = new EditHistory();
    let t = '';
    t = apply(h, t, { at: 0, removed: '', inserted: '甲' }, { now: 0 });
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { now: 10 });
    t = h.undo(t).text;
    t = apply(h, t, { at: 1, removed: '', inserted: '丙' }, { join: true, now: 20 });
    assert.equal(h.size, 2);
  });
});

describe('EditHistory：棧', () => {
  test('新的改動清掉重做棧', () => {
    const h = new EditHistory();
    let t = apply(h, '', { at: 0, removed: '', inserted: '甲' });
    t = h.undo(t).text;
    assert.equal(h.canRedo, true);
    apply(h, t, { at: 0, removed: '', inserted: '乙' });
    assert.equal(h.canRedo, false);
  });

  test('上限：丟最早的', () => {
    const h = new EditHistory(3);
    let t = '';
    for (let i = 0; i < 5; i++) {
      t = apply(h, t, { at: i, removed: '', inserted: String(i) });
    }
    assert.equal(h.size, 3);
    for (let i = 0; i < 3; i++) {
      t = h.undo(t).text;
    }
    assert.equal(t, '01');
    assert.equal(h.undo(t), undefined);
  });

  test('與文字對不上：整份作廢，不改文字', () => {
    const h = new EditHistory();
    apply(h, '', { at: 0, removed: '', inserted: '甲' });
    assert.equal(h.undo('被別處改過'), undefined);
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
  });

  test('刪掉與插入相同：什麼都不記', () => {
    const h = new EditHistory();
    h.record({ at: 0, removed: '甲', inserted: '甲' }, caret(0), caret(0));
    assert.equal(h.size, 0);
  });

  test('每一步一個編號（碼字統計認撤銷的是哪一步）：並進去的不換號，撤銷後棧頂回到上一步、重做回來還是原來那個號', () => {
    const h = new EditHistory();
    assert.equal(h.topId, undefined);
    let t = apply(h, '', { at: 0, removed: '', inserted: '甲' }, { merge: true, now: 0 });
    const first = h.topId;
    t = apply(h, t, { at: 1, removed: '', inserted: '乙' }, { merge: true, now: 10 });
    assert.equal(h.topId, first, '並進同一步');
    t = apply(h, t, { at: 2, removed: '', inserted: '丙丁' });
    const second = h.topId;
    assert.notEqual(second, first);
    t = h.undo(t).text;
    assert.equal(h.topId, first);
    t = h.redo(t).text;
    assert.equal(h.topId, second);
  });
});

describe('diffText', () => {
  test('相同返回 undefined', () => {
    assert.equal(diffText('甲', '甲'), undefined);
  });

  test('公共前字尾之間那一段', () => {
    assert.deepEqual(diffText('雨夜。', '雨夜，林昭。'), { at: 2, removed: '', inserted: '，林昭' });
    assert.deepEqual(diffText('甲乙丙', '甲丙'), { at: 1, removed: '乙', inserted: '' });
  });

  test('拿游標認對有歧義的位置', () => {
    // 在第一個 a 後面又打了一個 a：單看前字尾會認成插在第二個 a 後面。
    assert.deepEqual(diffText('aab', 'aaab'), { at: 2, removed: '', inserted: 'a' });
    assert.deepEqual(diffText('aab', 'aaab', 2), { at: 1, removed: '', inserted: 'a' });
  });

  test('游標對不上時退回單看前字尾', () => {
    assert.deepEqual(diffText('甲乙', '甲丙乙', 0), { at: 1, removed: '', inserted: '丙' });
  });

  test('不把代理對切成兩半', () => {
    const d = diffText('a\u{1F600}', 'a\u{1F601}');
    assert.equal(d.removed, '\u{1F600}');
    assert.equal(d.inserted, '\u{1F601}');
  });
});
