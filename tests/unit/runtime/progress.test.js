/**
 * 長任務登記處：進度快照、n/N、只改一個欄位、取消、拋異常、併發。
 * 遷自 scripts/smoke-logging.js 的 `== 長任務 ==`、`== 長任務：只改一個欄位 ==`、
 * `== 長任務：取消 ==`、`== 長任務：拋異常 ==`、`== 長任務：併發 ==` 五節。
 *
 * host 用 makeFakeHost()：它預設的 progress 實現把每次進度記成 `${title}｜${m}`，
 * 與遷移前那份手寫假宿主逐字一致，所以 h.progressCalls 可直接頂替原來的 hostProgressCalls。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let logger;
let progress;
let hostProgressCalls;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    logger: './src/core/runtime/logger.ts',
    progress: './src/core/runtime/progress.ts',
  });
  logger = bundle.logger;
  progress = bundle.progress;
  const h = makeFakeHost();
  hostProgressCalls = h.progressCalls;
  bundle.host.initHost(h.host);
});

describe('長任務', () => {
  let startedEmpty;
  let changes;
  let snapshotDuring;
  let result;

  before(async () => {
    hostProgressCalls.length = 0;
    startedEmpty = progress.activeTasks().length;

    changes = [];
    const sub = progress.onTasksChanged(() => changes.push(progress.activeTasks().length));

    snapshotDuring = null;
    result = await progress.runTask('同步章節摘要', async ({ report }) => {
      report({ message: '第 1 章', current: 0, total: 3 });
      snapshotDuring = progress.activeTasks()[0];
      report({ message: '第 2 章', current: 1 });
      return '完成';
    });

    sub.dispose();
  });

  test('起始時沒有任務', () => {
    assert.equal(startedEmpty, 0);
  });

  test('返回值透傳', () => {
    assert.equal(result, '完成', result);
  });

  test('任務中能看到快照', () => {
    assert.ok(!!snapshotDuring);
  });

  test('快照帶標題', () => {
    assert.equal(snapshotDuring.title, '同步章節摘要', snapshotDuring.title);
  });

  test('快照帶文案', () => {
    assert.equal(snapshotDuring.message, '第 1 章', snapshotDuring.message);
  });

  test('快照帶總數', () => {
    assert.equal(snapshotDuring.total, 3, `${snapshotDuring.total}`);
  });

  test('快照帶耗時', () => {
    assert.equal(typeof snapshotDuring.elapsedMs, 'number');
  });

  test('結束後任務表清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('訂閱收到過變化', () => {
    assert.ok(changes.length > 0, `${changes.length}`);
  });

  test('宿主進度帶 n/N', () => {
    assert.ok(
      hostProgressCalls.some((c) => c.includes('（1/3）')),
      hostProgressCalls.join(' / ')
    );
  });

  test('宿主進度帶字首', () => {
    assert.ok(
      hostProgressCalls.every((c) => c.startsWith('Novelwarden：')),
      hostProgressCalls[0]
    );
  });
});

describe('長任務：只改一個欄位', () => {
  let snap;

  before(async () => {
    snap = null;
    await progress.runTask('測試任務', async ({ report }) => {
      report({ message: '甲', current: 2, total: 9 });
      report('乙'); // 純字串：只改文案
      snap = progress.activeTasks()[0];
    });
  });

  test('字串 report 只改文案', () => {
    assert.equal(snap.message, '乙', snap.message);
  });

  test('current 沿用上次', () => {
    assert.equal(snap.current, 2, `${snap.current}`);
  });

  test('total 沿用上次', () => {
    assert.equal(snap.total, 9, `${snap.total}`);
  });
});

describe('長任務：取消', () => {
  let cancelled;
  let sawAbort;
  let idDuring;

  before(async () => {
    sawAbort = false;
    idDuring = '';
    await progress.runTask('可取消任務', async ({ signal, report }) => {
      report({ message: '跑著', current: 0, total: 2 });
      idDuring = progress.activeTasks()[0].id;
      // 遷移前這條斷言寫在任務體內部；這裡把結論帶出來，斷言留在下面的用例裡。
      cancelled = progress.cancelTask(idDuring);
      sawAbort = signal.aborted;
    });
  });

  test('cancelTask 認得在跑的任務', () => {
    assert.ok(cancelled);
  });

  test('任務體看得到 aborted', () => {
    assert.ok(sawAbort);
  });

  test('取消後任務表也清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('對已結束的 id 返回 false', () => {
    assert.equal(progress.cancelTask(idDuring), false);
  });

  test('對未知 id 返回 false', () => {
    assert.equal(progress.cancelTask('task-不存在'), false);
  });
});

describe('長任務：拋異常', () => {
  let caught;
  let errors;

  before(async () => {
    caught = '';
    try {
      await progress.runTask('會失敗的任務', async () => {
        throw new Error('故意失敗');
      });
    } catch (err) {
      caught = err.message;
    }

    logger.clearLogs();
    try {
      await progress.runTask('再失敗一次', async () => {
        throw new Error('又失敗了');
      });
    } catch {
      /* 預期內 */
    }
    errors = logger.recentLogs().filter((e) => e.level === 'error');
  });

  test('異常繼續往上拋', () => {
    assert.equal(caught, '故意失敗', caught);
  });

  test('失敗後任務表清空', () => {
    assert.equal(progress.activeTasks().length, 0);
  });

  test('失敗進日誌', () => {
    assert.ok(
      errors.some((e) => e.message.includes('又失敗了')),
      JSON.stringify(errors)
    );
  });
});

describe('長任務：併發', () => {
  let both;

  before(async () => {
    both = 0;
    await Promise.all([
      progress.runTask('任務甲', async () => {
        await new Promise((r) => setTimeout(r, 20));
        both = Math.max(both, progress.activeTasks().length);
      }),
      progress.runTask('任務乙', async () => {
        await new Promise((r) => setTimeout(r, 20));
        both = Math.max(both, progress.activeTasks().length);
      }),
    ]);
  });

  test('兩個任務能同時在表裡', () => {
    assert.equal(both, 2, `${both}`);
  });

  test('都結束後表空了', () => {
    assert.equal(progress.activeTasks().length, 0);
  });
});
