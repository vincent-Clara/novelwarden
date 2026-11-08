/**
 * 歷史版本的純函式（`src/core/workspace/history.ts`）：快照目錄怎麼映象原檔案的路徑、快照檔名怎麼起與讀回來、
 * 存不存（節流）、留幾個（裁剪）。落盤的那一半在 tests/integration/workspace/history.test.js。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let h;
let project;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    history: './src/core/workspace/history.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  h = bundle.history;
  // 只算路徑，不碰盤。
  project = bundle.project.NovelProject.open(path.join(os.tmpdir(), 'novelwarden-history-unit'));
});

const MIN = 60_000;

describe('快照目錄映象原檔案的相對路徑', () => {
  test('章節：.novelwarden/history/<原路徑>/，副檔名留在目錄名裡', () => {
    assert.equal(h.historyDirOf(project, 'chapters/第一卷/003-深處.txt'), '.novelwarden/history/chapters/第一卷/003-深處.txt');
  });

  test('同名不同副檔名各是各的目錄，不撞車', () => {
    assert.notEqual(h.historyDirOf(project, 'chapters/003.md'), h.historyDirOf(project, 'chapters/003.txt'));
    assert.notEqual(h.historyDirOf(project, 'chapters/003'), h.historyDirOf(project, 'chapters/003.md'));
  });

  test('.novelwarden/ 裡的檔案同樣原樣映象（細綱、角色卡）', () => {
    assert.equal(
      h.historyDirOf(project, '.novelwarden/summaries/第一卷/003-深處.md'),
      '.novelwarden/history/.novelwarden/summaries/第一卷/003-深處.md'
    );
    assert.equal(h.historyDirOf(project, '.novelwarden/characters/林昭.md'), '.novelwarden/history/.novelwarden/characters/林昭.md');
  });

  test('反斜槓歸一、越界給 undefined', () => {
    assert.equal(h.historyDirOf(project, 'chapters\\001.md'), '.novelwarden/history/chapters/001.md');
    assert.equal(h.historyDirOf(project, '../外面.md'), undefined);
    assert.equal(h.historyDirOf(project, '/etc/passwd'), undefined);
  });
});

describe('快照檔名', () => {
  test('本地時間 + 時區，副檔名一律 .txt', () => {
    const name = h.snapshotFileName(new Date(2026, 9, 18, 14, 32, 5));
    assert.match(name, /^2026-10-18_14-32-05[+-]\d{4}\.txt$/);
  });

  test('讀回來的時刻與起名時的一致（精確到秒）', () => {
    const at = new Date(2026, 9, 18, 14, 32, 5, 678);
    const back = h.parseSnapshotFileName(h.snapshotFileName(at));
    assert.equal(back.time, Math.floor(at.getTime() / 1000) * 1000);
    assert.equal(back.dup, 1);
  });

  test('同一秒的第二個帶序號，讀回來序號對', () => {
    const name = h.snapshotFileName(new Date(2026, 9, 18, 14, 32, 5), 2);
    assert.match(name, /-2\.txt$/);
    assert.equal(h.parseSnapshotFileName(name).dup, 2);
  });

  test('時區寫在名字裡：換了時區讀回來還是同一刻', () => {
    assert.equal(
      h.parseSnapshotFileName('2026-10-18_14-32-05+0800.txt').time,
      h.parseSnapshotFileName('2026-10-18_06-32-05+0000.txt').time
    );
    assert.equal(h.parseSnapshotFileName('2026-10-18_14-32-05+0800.txt').time, Date.UTC(2026, 9, 18, 6, 32, 5));
  });

  test('不是快照的名字認不出（作者放進來的別的檔案）', () => {
    for (const name of ['.gitignore', '筆記.txt', '2026-10-18.txt', '2026-10-18_14-32-05+0800.md', '2026-10-18_14-32-05.txt']) {
      assert.equal(h.parseSnapshotFileName(name), undefined, name);
    }
  });

  test('排序：新的在前、同一秒序號大的在前，別的名字丟掉', () => {
    const sorted = h.sortSnapshotNames([
      '2026-10-18_14-32-05+0800.txt',
      '筆記.txt',
      '2026-10-18_14-40-00+0800.txt',
      '2026-10-18_14-32-05+0800-2.txt',
      '2026-10-17_23-59-59+0800.txt',
    ]);
    assert.deepEqual(sorted, [
      '2026-10-18_14-40-00+0800.txt',
      '2026-10-18_14-32-05+0800-2.txt',
      '2026-10-18_14-32-05+0800.txt',
      '2026-10-17_23-59-59+0800.txt',
    ]);
  });

  test('排序按時刻不按字面：+0000 的 07:00 比 +0800 的 14:32 晚', () => {
    assert.deepEqual(h.sortSnapshotNames(['2026-10-18_14-32-05+0800.txt', '2026-10-18_07-00-00+0000.txt']), [
      '2026-10-18_07-00-00+0000.txt',
      '2026-10-18_14-32-05+0800.txt',
    ]);
  });
});

describe('改動大小（公共前字尾粗算）', () => {
  test('一樣是 0', () => {
    assert.equal(h.changedChars('雨下了三天。', '雨下了三天。'), 0);
  });

  test('中間改一處：只算改掉的那段較長的一邊', () => {
    assert.equal(h.changedChars('他走進了院子。', '他慢慢走進了院子。'), 2);
    assert.equal(h.changedChars('他慢慢走進了院子。', '他走進了院子。'), 2);
    assert.equal(h.changedChars('甲乙丙丁', '甲XYZ丁'), 3);
  });

  test('末尾追加：算追加的長度', () => {
    assert.equal(h.changedChars('第一段。', '第一段。\n\n第二段很長。'), 8);
  });

  test('首尾各改一處：中間全算進去（寧可多存）', () => {
    const body = '中'.repeat(1000);
    assert.equal(h.changedChars(`A${body}B`, `C${body}D`), 1002);
  });
});

describe('存不存（節流）', () => {
  const now = Date.UTC(2026, 9, 18, 6, 32, 0);
  const big = '正'.repeat(2000);

  test('還沒有快照：存', () => {
    assert.deepEqual(h.decideSnapshot({ old: '舊', next: '新', now }), { save: true, reason: 'first' });
  });

  test('新內容與舊內容一樣（什麼都沒覆蓋）：不存', () => {
    assert.deepEqual(h.decideSnapshot({ old: '一樣', next: '一樣', now }), { save: false, reason: 'unchanged' });
  });

  test('只差換行風格也算一樣（CRLF 歸一）', () => {
    assert.equal(h.decideSnapshot({ old: 'a\r\nb', next: 'a\nb', now }).save, false);
  });

  test('舊內容與最新快照一字不差：不存（哪怕新內容是大改）', () => {
    const d = h.decideSnapshot({ old: big, next: '全換了', latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: false, reason: 'same' });
  });

  test('最新快照不到 10 分鐘、兩處改動都很小：不存（自動儲存攢不出幾百個快照）', () => {
    const d = h.decideSnapshot({ old: `${big}一句`, next: `${big}一句兩句`, latest: { text: big, time: now - 3 * MIN }, now });
    assert.deepEqual(d, { save: false, reason: 'small' });
  });

  test('最新快照超過 10 分鐘：小改也存', () => {
    const d = h.decideSnapshot({ old: `${big}一句`, next: `${big}一句兩句`, latest: { text: big, time: now - 11 * MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'quiet' });
  });

  test('正好 10 分鐘算超過', () => {
    assert.equal(h.decideSnapshot({ old: `${big}一`, next: `${big}一二`, latest: { text: big, time: now - 10 * MIN }, now }).save, true);
  });

  test('不到 10 分鐘，但自上一版以來攢的改動超過 300 字：存', () => {
    const drifted = `${big}${'新'.repeat(301)}`;
    const d = h.decideSnapshot({ old: drifted, next: `${drifted}再一句`, latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'bigChange' });
  });

  test('不到 10 分鐘、舊內容與上一版只差幾個字，但這一次是大改（整章重寫 / 修稿 / 一鍵排版）：總是存', () => {
    const old = `${big}剛打的幾個字`;
    const rewritten = '重'.repeat(2000);
    const d = h.decideSnapshot({ old, next: rewritten, latest: { text: big, time: now - MIN }, now });
    assert.deepEqual(d, { save: true, reason: 'bigChange' });
  });

  test('正好 300 字算小改', () => {
    const d = h.decideSnapshot({ old: `${big}${'新'.repeat(300)}`, next: `${big}${'新'.repeat(300)}。`, latest: { text: big, time: now - MIN }, now });
    assert.equal(d.save, false);
  });

  test('「現在存一版」（force）跳過節流', () => {
    const d = h.decideSnapshot({ old: `${big}一`, latest: { text: big, time: now - MIN }, now, force: true });
    assert.deepEqual(d, { save: true, reason: 'force' });
  });

  test('「現在存一版」與最新快照一字不差時也不重複存', () => {
    const d = h.decideSnapshot({ old: big, latest: { text: big, time: now - MIN }, now, force: true });
    assert.deepEqual(d, { save: false, reason: 'same' });
  });

  test('幾個閾值就是檔案頭寫的那幾個數', () => {
    assert.equal(h.HISTORY_KEEP, 50);
    assert.equal(h.HISTORY_QUIET_MS, 10 * MIN);
    assert.equal(h.HISTORY_SMALL_CHANGE, 300);
    assert.equal(h.HISTORY_GITIGNORE, '*\n');
  });
});

describe('保留裁剪', () => {
  const names = (n) =>
    Array.from({ length: n }, (_, i) => h.snapshotFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * MIN)));

  test('不超過 50 個：一個都不刪', () => {
    assert.deepEqual(h.snapshotsToPrune(names(50)), []);
  });

  test('超過 50 個：刪掉最舊的那幾個', () => {
    const all = names(53);
    assert.deepEqual(new Set(h.snapshotsToPrune(all)), new Set(all.slice(0, 3)));
  });

  test('亂序給進來也按時刻認最舊的；不是快照的名字不在刪除之列', () => {
    const all = names(52);
    const shuffled = [...all].reverse().concat(['.gitignore', '筆記.txt']);
    const pruned = h.snapshotsToPrune(shuffled);
    assert.deepEqual(new Set(pruned), new Set(all.slice(0, 2)));
    assert.ok(!pruned.includes('筆記.txt'));
  });

  test('保留數可以調（測試與以後的設定用）', () => {
    const all = names(5);
    assert.deepEqual(new Set(h.snapshotsToPrune(all, 2)), new Set(all.slice(0, 3)));
  });
});
