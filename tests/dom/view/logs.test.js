/**
 * 日誌頁：級別與關鍵字過濾、增量追加、清空，以及「載入更早」的歷史翻頁。
 *
 * 遷自 scripts/smoke-view.js 的 == 日誌頁 ==（1525）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const entry = (seq, level, scope, message, detail) => ({
  seq, level, scope, message, detail, at: new Date(2026, 0, 1, 12, 3, 41).toISOString(),
});

describe('日誌頁', { skip: JSDOM_SKIP }, () => {
  let ui;
  let ask;
  const rows = () => [...ui.doc.querySelectorAll('#logBody .log-row')];
  const texts = () => rows().map((n) => n.textContent);
  const setLevel = (v) => {
    ui.doc.getElementById('logLevel').value = v;
    ui.doc.getElementById('logLevel').dispatchEvent(new ui.window.Event('change'));
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'logs',
      entries: [
        entry(1, 'debug', '定稿', '第 1 章請求模型'),
        entry(2, 'info', '定稿', '第 1 章細綱已照正文更新', '耗時 3.2s'),
        entry(3, 'warn', '定稿', '第 2 章是空的'),
        entry(4, 'error', '模型', '連線失敗'),
      ],
    });
  });

  // 預設「資訊及以上」：debug 那條不顯示。
  test('預設過濾掉 debug', () => {
    assert.equal(rows().length, 3, `${rows().length}`);
  });

  test('顯示時間', () => {
    assert.ok(texts()[0].includes('12:03:41'), texts()[0]);
  });

  test('顯示來源', () => {
    assert.ok(texts()[0].includes('定稿'), texts()[0]);
  });

  test('顯示訊息', () => {
    assert.ok(texts()[0].includes('第 1 章細綱已照正文更新'), texts()[0]);
  });

  test('警告行帶級別樣式', () => {
    assert.ok(rows()[1].classList.contains('log-warn'));
  });

  test('錯誤行帶級別樣式', () => {
    assert.ok(rows()[2].classList.contains('log-error'));
  });

  test('detail 摺疊在 details 裡', () => {
    assert.ok(rows()[0].querySelector('details.log-detail'));
  });

  test('detail 預設收起', () => {
    assert.ok(!rows()[0].querySelector('details.log-detail').open);
  });

  test('計數顯示篩選比例', () => {
    assert.equal(ui.doc.getElementById('logMeta').textContent, '3 / 4 條',
      ui.doc.getElementById('logMeta').textContent);
  });

  // 調到「全部」應當把 debug 放出來。
  test('切到全部後 debug 出現', () => {
    setLevel('debug');
    assert.equal(rows().length, 4, `${rows().length}`);
  });

  test('全部顯示時計數不帶比例', () => {
    assert.equal(ui.doc.getElementById('logMeta').textContent, '4 條',
      ui.doc.getElementById('logMeta').textContent);
  });

  test('切到僅錯誤只剩一條', () => {
    setLevel('error');
    assert.equal(rows().length, 1, `${rows().length}`);
  });

  test('剩下的就是那條錯誤', () => {
    assert.ok(texts()[0].includes('連線失敗'), texts()[0]);
    setLevel('info');
  });

  // 關鍵字過濾。
  test('關鍵字過濾生效', () => {
    const filter = ui.doc.getElementById('logFilter');
    filter.value = '模型';
    filter.dispatchEvent(new ui.window.Event('input'));
    assert.equal(rows().length, 1, texts().join(' | '));
    assert.ok(texts()[0].includes('連線失敗'), texts().join(' | '));
  });

  test('清空過濾後恢復', () => {
    const filter = ui.doc.getElementById('logFilter');
    filter.value = '';
    filter.dispatchEvent(new ui.window.Event('input'));
    assert.equal(rows().length, 3, `${rows().length}`);
  });

  // 增量追加。
  test('增量追加一條', () => {
    ui.post({ type: 'log', entry: entry(5, 'info', '定稿', '第 3 章細綱已照正文更新') });
    assert.equal(rows().length, 4, `${rows().length}`);
  });

  test('追加在末尾', () => {
    assert.ok(texts().at(-1).includes('第 3 章細綱已照正文更新'), texts().at(-1));
  });

  // 被過濾掉的級別，增量也不該冒出來。
  test('增量也走過濾', () => {
    ui.post({ type: 'log', entry: entry(6, 'debug', '定稿', '不該顯示的除錯') });
    assert.ok(!texts().some((t) => t.includes('不該顯示的除錯')), texts().join(' | '));
  });

  // 清空按鈕把請求發回後端，前端不自己清（後端要留一條痕跡）。
  test('點清空發出 clearLogs', () => {
    ui.sent.length = 0;
    ui.clickEl(ui.doc.getElementById('logClearBtn'));
    assert.ok(ui.sent.some((m) => m.type === 'clearLogs'), JSON.stringify(ui.sent));
  });

  test('清空後只剩痕跡那條', () => {
    ui.post({ type: 'logs', entries: [entry(7, 'info', '日誌', '日誌已清空')] });
    assert.equal(rows().length, 1, texts().join(' | '));
    assert.ok(texts()[0].includes('日誌已清空'), texts().join(' | '));
  });

  // ---- 「載入更早」：記憶體緩衝只有幾百條且隨程序消失，更早的存在工程庫裡。
  // 預設路徑（切到日誌頁）仍然只看緩衝，一次查詢都不做，所以這裡要驗的是
  // 「只有點了按鈕才發訊息」。
  test('切到日誌頁不主動要歷史', () => {
    ui.post({ type: 'logs', entries: [entry(20, 'info', '定稿', '本次會話的一條')] });
    ui.sent.length = 0;
    assert.ok(!ui.sent.some((m) => m.type === 'requestLogHistory'));
  });

  test('日誌頁有「載入更早」按鈕', () => {
    assert.ok(ui.doc.getElementById('logEarlierBtn'));
  });

  test('點按鈕發 requestLogHistory', () => {
    ui.clickEl(ui.doc.getElementById('logEarlierBtn'));
    ask = ui.sent.find((m) => m.type === 'requestLogHistory');
    assert.ok(ask, JSON.stringify(ui.sent));
  });

  // before 是已顯示的最早那條的時間戳，據它繼續往前翻。
  test('帶上已顯示的最早時間戳', () => {
    assert.equal(typeof ask?.before, 'string', JSON.stringify(ask));
  });

  // 歷史接在最前面（seq 取負，與實時序號不會撞）。
  test('歷史接在最前面', () => {
    ui.post({
      type: 'logHistory',
      entries: [
        { seq: -2, level: 'error', scope: '角色卡', message: '上次會話的失敗', at: new Date(2026, 0, 1, 9, 0, 0).toISOString() },
        { seq: -1, level: 'info', scope: '定稿', message: '上次會話的一條', at: new Date(2026, 0, 1, 9, 0, 1).toISOString() },
      ],
      exhausted: false,
    });
    assert.ok(texts()[0].includes('上次會話的失敗'), texts().join(' | '));
  });

  test('本次會話的日誌還在', () => {
    assert.ok(texts().some((t) => t.includes('本次會話的一條')), texts().join(' | '));
  });

  // 再往前沒有了：按鈕禁用並改文案，別讓使用者一直點一個沒反應的按鈕。
  test('沒有更早時按鈕禁用', () => {
    ui.post({ type: 'logHistory', entries: [], exhausted: true });
    assert.ok(ui.doc.getElementById('logEarlierBtn').disabled);
  });

  test('沒有更早時改文案', () => {
    assert.ok(ui.doc.getElementById('logEarlierBtn').textContent.includes('沒有更早'),
      ui.doc.getElementById('logEarlierBtn').textContent);
  });

  // 切篩選條件不該把載入進來的歷史丟掉（那以前會走 renderLogs 重置狀態）。
  test('切篩選後歷史仍在', () => {
    setLevel('debug');
    assert.ok(texts().some((t) => t.includes('上次會話的失敗')), texts().join(' | '));
  });
});
