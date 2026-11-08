/**
 * 併發工具：runPool 的併發上限、結果對齊、失敗與取消，serialize 的排隊語義。
 * 遷自 scripts/smoke-pool.js 的 `== runPool：併發上限與順序 ==`、
 * `== runPool：失敗與取消 ==`、`== serialize：審閱排隊 ==` 三節。
 *
 * concurrency.ts 只 import 了 CancelledError，不碰 host / config，所以單獨 bundle 即可。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');
const { sleep } = require('../../helpers/fakeProvider');

describe('runPool：併發上限與順序', () => {
  let runPool;

  before(() => {
    ({ runPool } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('併發上限', () => {
    let peak = 0;
    let results;

    before(async () => {
      let inFlight = 0;
      const items = Array.from({ length: 12 }, (_, i) => i);
      results = await runPool(items, 4, async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5 + ((item * 7) % 11)); // 參差的耗時，製造亂序完成
        inFlight--;
        return item * 2;
      });
    });

    test('併發峰值不超過 limit', () => {
      assert.ok(peak <= 4, `峰值 ${peak}`);
    });

    // 依賴真實定時器交錯，是這一組裡唯一天生有抖動的斷言。
    test('確實併發了（不是退化成序列）', () => {
      assert.ok(peak > 1, `峰值 ${peak}`);
    });

    test('每一項都有結果', () => {
      assert.equal(results.length, 12);
    });

    test('結果按 index 對齊（完成順序不影響）', () => {
      assert.ok(results.every((r, i) => r.status === 'fulfilled' && r.value === i * 2));
    });
  });

  describe('limit=1', () => {
    let order;

    before(async () => {
      order = [];
      await runPool([1, 2, 3, 4], 1, async (item) => {
        order.push(`start${item}`);
        await sleep(2);
        order.push(`end${item}`);
      });
    });

    test('limit=1 嚴格序列（與改造前逐字一致）', () => {
      assert.equal(order.join(','), 'start1,end1,start2,end2,start3,end3,start4,end4', order.join(','));
    });
  });
});

describe('runPool：失敗與取消', () => {
  let runPool;

  before(() => {
    ({ runPool } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('單項失敗', () => {
    let ran;
    let results;

    before(async () => {
      ran = [];
      results = await runPool([1, 2, 3], 2, async (item) => {
        ran.push(item);
        if (item === 2) {
          throw new Error('第二項炸了');
        }
        return item;
      });
    });

    test('單項失敗不影響其餘', () => {
      assert.equal(ran.length, 3, ran.join(','));
    });

    test('失敗項標為 rejected', () => {
      assert.equal(results[1].status, 'rejected');
    });

    test('失敗項帶得出原因', () => {
      assert.ok(String(results[1].reason.message).includes('第二項炸了'));
    });

    test('其餘項照常有值', () => {
      assert.equal(results[0].value, 1);
      assert.equal(results[2].value, 3);
    });
  });

  describe('中途取消', () => {
    let ran;
    let results;

    before(async () => {
      const abort = new AbortController();
      ran = [];
      results = await runPool(
        [1, 2, 3, 4, 5, 6],
        1,
        async (item) => {
          ran.push(item);
          if (item === 2) {
            abort.abort();
          }
          return item;
        },
        { signal: abort.signal }
      );
    });

    test('取消後不再啟動新任務', () => {
      assert.equal(ran.length, 2, `跑了 ${ran.join('、')}`);
    });

    test('未啟動的項留在結果裡（佔位為 CancelledError）', () => {
      assert.equal(results.length, 6);
    });

    test('佔位是取消而不是成功', () => {
      assert.equal(results[5].status, 'rejected');
      assert.equal(results[5].reason.name, 'CancelledError');
    });
  });

  describe('onSettled', () => {
    let done = 0;
    let seen;

    before(async () => {
      seen = [];
      await runPool([1, 2, 3, 4], 3, async (i) => sleep(3 + i), {
        onSettled: (_r, item, _i, finished) => {
          done = finished;
          seen.push(`${item}:${finished}`);
        },
      });
    });

    test('onSettled 的計數單調遞增到總數', () => {
      assert.equal(done, 4, seen.join(' '));
    });

    test('onSettled 的計數沒有重複（進度條不會倒退）', () => {
      assert.equal(new Set(seen.map((s) => s.split(':')[1])).size, 4, seen.join(' '));
    });
  });
});

describe('serialize：審閱排隊', () => {
  let serialize;

  before(() => {
    ({ serialize } = loadModule('src/core/runtime/concurrency.ts'));
  });

  describe('排隊執行', () => {
    let peak = 0;
    let order;

    before(async () => {
      let inFlight = 0;
      order = [];
      await Promise.all(
        [1, 2, 3].map((i) =>
          serialize(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            order.push(i);
            await sleep(5);
            inFlight--;
          })
        )
      );
    });

    test('同一時刻只有一個在跑', () => {
      assert.equal(peak, 1, `峰值 ${peak}`);
    });

    test('按入隊順序執行', () => {
      assert.equal(order.join(','), '1,2,3', order.join(','));
    });
  });

  describe('一個拋錯不卡死後面的', () => {
    let after;

    before(async () => {
      // 一次審閱拋錯不能卡死後面排隊的（使用者放棄某張卡後其餘還得能彈）。
      after = [];
      const boom = serialize(async () => {
        throw new Error('審閱炸了');
      }).catch((e) => after.push(`caught:${e.message}`));
      const next = serialize(async () => {
        after.push('next-ran');
      });
      await Promise.all([boom, next]);
    });

    test('前一個拋錯不影響後面排隊的', () => {
      assert.ok(after.includes('next-ran'), after.join(','));
    });

    test('異常照舊拋給它自己的呼叫方', () => {
      assert.ok(after.some((s) => s.startsWith('caught:')));
    });
  });
});
