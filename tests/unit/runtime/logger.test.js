/**
 * 日誌系統：脫敏、環形緩衝、detail 截斷、sink 的分發與級別過濾、格式化。
 * 遷自 scripts/smoke-logging.js 的 `== 脫敏 ==`、`== 緩衝 ==`、`== detail 截斷 ==`、
 * `== sink ==`、`== 格式化 ==` 五節。
 *
 * 三條硬約束：日誌裡絕不出現 API Key；緩衝有上限；sink 拋異常不能帶崩呼叫方。
 *
 * 這幾節改的都是 logger 的模組級狀態（緩衝、sink 表、sink 級別），用例之間有先後依賴——
 * node:test 同檔案內預設序列執行，順序與遷移前一致。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let logger;

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    logger: './src/core/runtime/logger.ts',
  });
  logger = bundle.logger;
  bundle.host.initHost(makeFakeHost().host);
});

describe('脫敏', () => {
  const cases = [
    ['sk-proj-abcdefghijklmnop', 'OpenAI 風格'],
    ['sk-ant-api03-QQQQzzzz1111', 'Anthropic 風格'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'Bearer 頭'],
    ['api_key=9f8e7d6c5b4a3210', 'api_key=… 形式'],
    ['{"x-api-key": "topsecretvalue123"}', 'JSON 裡的 x-api-key'],
  ];
  for (const [raw, label] of cases) {
    test(`${label}被隱去`, () => {
      const out = logger.redact(raw);
      assert.ok(out.includes('已隱去'), out);
    });
  }

  // 抹的是金鑰不是正文：一句普通日誌不該被改寫。
  test('普通文字不受影響', () => {
    const plain = '第 12 章《夜訪》摘要已寫入';
    assert.equal(logger.redact(plain), plain, logger.redact(plain));
  });

  describe('emit 的兩條路徑都過 redact', () => {
    let entry;

    before(() => {
      logger.clearLogs();
      const log = logger.scoped('測試');
      log.error('連線失敗 sk-proj-abcdefghijklmnop', { key: 'sk-ant-api03-ZZZZwwww2222' });
      entry = logger.recentLogs().at(-1);
    });

    test('message 已脫敏', () => {
      assert.ok(!entry.message.includes('abcdefghijklmnop'), entry.message);
    });

    test('detail 已脫敏', () => {
      assert.ok(!entry.detail.includes('wwww2222'), entry.detail);
    });
  });
});

describe('緩衝', () => {
  let over;
  let kept;
  let sawDebugAfterRaise;
  let afterClear;

  before(() => {
    logger.clearLogs();
    const log = logger.scoped('壓測');
    over = logger.MAX_ENTRIES + 200;
    for (let i = 0; i < over; i++) {
      log.debug(`第 ${i} 條`);
    }
    kept = [...logger.recentLogs()];

    // 緩衝永遠收全量：sink 級別調高不該讓日誌頁看不到 debug。
    logger.setSinkLevel('error');
    logger.clearLogs();
    log.debug('除錯內容');
    sawDebugAfterRaise = logger.recentLogs().some((e) => e.level === 'debug');
    logger.setSinkLevel('debug');

    logger.clearLogs();
    afterClear = [...logger.recentLogs()];
  });

  test('緩衝不超過上限', () => {
    assert.equal(kept.length, logger.MAX_ENTRIES, `${kept.length}`);
  });

  test('丟的是最舊的', () => {
    assert.equal(kept[0].message, `第 ${over - logger.MAX_ENTRIES} 條`, kept[0].message);
  });

  test('最新一條還在', () => {
    assert.equal(kept.at(-1).message, `第 ${over - 1} 條`, kept.at(-1).message);
  });

  test('seq 單調遞增', () => {
    assert.ok(kept.every((e, i) => i === 0 || e.seq > kept[i - 1].seq));
  });

  test('調高 sink 級別後緩衝仍收 debug', () => {
    assert.ok(sawDebugAfterRaise);
  });

  test('清空後只留一條痕跡', () => {
    assert.equal(afterClear.length, 1, `${afterClear.length}`);
  });

  test('痕跡說明日誌被清過', () => {
    assert.ok(afterClear[0].message.includes('清空'));
  });
});

describe('detail 截斷', () => {
  let entry;

  before(() => {
    logger.clearLogs();
    logger.scoped('測試').info('長 detail', 'x'.repeat(50000));
    entry = logger.recentLogs().at(-1);
  });

  test('detail 被截斷', () => {
    assert.ok(entry.detail.length < 3000, `${entry.detail.length}`);
  });

  test('截斷處有說明', () => {
    assert.ok(entry.detail.includes('省略'), entry.detail.slice(-40));
  });
});

describe('sink', () => {
  let seen;
  let threw;
  let alive;
  let recursed;
  let filtered;

  before(() => {
    logger.clearLogs();
    logger.setSinkLevel('debug');
    seen = [];
    const sub = logger.addLogSink((e) => seen.push(e.message));
    const log = logger.scoped('測試');
    log.info('一');
    log.info('二');

    sub.dispose();
    log.info('三');

    // sink 拋異常只能被吞掉，絕不能帶崩呼叫方。
    alive = [];
    const bad = logger.addLogSink(() => {
      throw new Error('sink 壞了');
    });
    const good = logger.addLogSink((e) => alive.push(e.message));
    threw = false;
    try {
      log.info('四');
    } catch {
      threw = true;
    }
    bad.dispose();
    good.dispose();

    // sink 裡再打日誌不能無限遞迴。
    const reentrant = logger.addLogSink(() => logger.scoped('迴環').debug('sink 內部日誌'));
    recursed = false;
    try {
      log.info('五');
    } catch {
      recursed = true;
    }
    reentrant.dispose();

    // 級別過濾只作用於 sink。
    logger.setSinkLevel('warn');
    filtered = [];
    const sub2 = logger.addLogSink((e) => filtered.push(e.level));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    sub2.dispose();
    logger.setSinkLevel('debug');
  });

  test('sink 收到每一條', () => {
    assert.equal(seen.join(','), '一,二', seen.join(','));
  });

  test('dispose 後不再收', () => {
    assert.ok(!seen.includes('三'), seen.join(','));
  });

  test('壞 sink 不拋給呼叫方', () => {
    assert.ok(!threw);
  });

  test('壞 sink 不影響別的 sink', () => {
    assert.ok(alive.includes('四'), alive.join(','));
  });

  test('sink 內部再打日誌不炸棧', () => {
    assert.ok(!recursed);
  });

  test('sink 按級別過濾', () => {
    assert.equal(filtered.join(','), 'warn,error', filtered.join(','));
  });
});

describe('格式化', () => {
  test('毫秒', () => {
    assert.equal(logger.formatDuration(860), '860ms', logger.formatDuration(860));
  });

  test('秒', () => {
    assert.equal(logger.formatDuration(3200), '3.2s', logger.formatDuration(3200));
  });

  test('分秒', () => {
    assert.equal(logger.formatDuration(72000), '1 分 12 秒', logger.formatDuration(72000));
  });

  test('Error 取 message', () => {
    assert.equal(logger.describeError(new Error('炸了')), '炸了');
  });

  test('字串原樣', () => {
    assert.equal(logger.describeError('炸了'), '炸了');
  });

  test('物件轉 JSON', () => {
    assert.equal(logger.describeError({ a: 1 }), '{"a":1}', logger.describeError({ a: 1 }));
  });

  describe('formatLogEntry', () => {
    let line;

    before(() => {
      logger.clearLogs();
      logger.scoped('測試').warn('一句话', '兩行\n詳情');
      line = logger.formatLogEntry(logger.recentLogs().at(-1));
    });

    test('單行含級別與來源', () => {
      assert.ok(line.includes('WARN') && line.includes('測試'), line);
    });

    test('detail 縮排在下一行', () => {
      assert.ok(line.includes('\n    兩行'), JSON.stringify(line));
    });
  });
});
