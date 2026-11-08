/**
 * 許可權詢問的收發（`controller/gate.ts`）：**那一句問變成對話裡的一張卡片。**
 *
 * 兩種問法共用這一條路：外部 agent 經 MCP 調工具時動手前那一句（覆蓋、改技能），
 * 以及產物落盤前那一句。兩種都只有兩顆按鈕。
 *
 * 判定（問不問、問什麼）由呼叫方（`controller/mcp.ts`、單步創作那條路）決定；這裡守的
 * 是「問出去之後」那幾件一旦做錯就會讓工具呼叫永遠不返回的事：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 推一條 `gate` | 卡片的身份、按鈕上的字都從後端來 |
 * | 作者答了 | Promise 落地，並**廣播** `gateDone`（兩個檢視都要收卡） |
 * | 答第二次 | 不算數，也不會再廣播一條 |
 * | 認不出的 requestId | 靜默丟棄，不拋 |
 * | 重連 | 還沒答的原樣再推一遍——前端無狀態，不重推就沒人看得見它在等 |
 * | 取消 | 按「停止」結算，不留一個永遠懸著的 Promise |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { askGate, cancelGates, resolveGate, resendGates } = loadModule('src/core/controller/gate.ts');

/** controller 的替身：這一層只用到 `post` 與 `gates` 兩樣。 */
function fakeController() {
  return { posted: [], gates: new Map(), post(m) { this.posted.push(m); } };
}

const ASK = {
  turnId: 'a1',
  callId: 'c1',
  name: 'write',
  title: 'Agent 要寫入設定「北境雪原」',
  detail: '.novelwarden/lore/北境雪原.md · 新建',
  argsText: '{ "path": "…" }',
};

const gateMsg = (c) => c.posted.find((m) => m.type === 'gate');
const doneMsgs = (c) => c.posted.filter((m) => m.type === 'gateDone');

describe('問出去', () => {
  const c = fakeController();
  const pending = askGate(c, ASK, new AbortController().signal);

  test('推了一條 gate', () => {
    assert.ok(gateMsg(c), JSON.stringify(c.posted));
  });

  test('帶著這一輪的氣泡與這一次的呼叫', () => {
    assert.equal(gateMsg(c).turnId, 'a1');
    assert.equal(gateMsg(c).callId, 'c1');
  });

  // 兩顆字都與後端結算用的是同一份常量（`PROCEED_ACTION` / `SKIP_ACTION`）。前端各寫一遍的話，改了文案兩邊
  // 就對不上。
  test('兩顆按鈕上的字都從後端來', () => {
    assert.equal(gateMsg(c).proceed, '確認');
    assert.equal(gateMsg(c).skip, '跳過');
    assert.equal(gateMsg(c).stop, undefined);
  });

  test('等著回答（還沒落地）', async () => {
    const race = await Promise.race([pending, Promise.resolve('還在等')]);
    assert.equal(race, '還在等');
  });

  test('答了就落地', async () => {
    resolveGate(c, gateMsg(c).requestId, 'skip');
    assert.equal(await pending, 'skip');
  });

  // 兩個檢視掛同一個 controller：只在被點的那一邊收卡，另一邊會留一張
  // 點了沒反應的卡。
  test('廣播了一條「這張卡可以收了」', () => {
    assert.equal(doneMsgs(c).length, 1, JSON.stringify(doneMsgs(c)));
    assert.equal(doneMsgs(c)[0].verdict, 'skip');
  });

  test('答完就從表裡摘掉了', () => {
    assert.equal(c.gates.size, 0);
  });

  test('再答一次不算數，也不再廣播', () => {
    resolveGate(c, gateMsg(c).requestId, 'proceed');
    assert.equal(doneMsgs(c).length, 1);
  });
});

test('認不出的 requestId 靜默丟棄', () => {
  const c = fakeController();
  assert.doesNotThrow(() => resolveGate(c, '並不存在', 'proceed'));
  assert.equal(c.posted.length, 0);
});

test('同一時刻問兩次，兩張卡各有各的身份', async () => {
  const c = fakeController();
  const a = askGate(c, ASK, new AbortController().signal);
  const b = askGate(c, { ...ASK, callId: 'c2' }, new AbortController().signal);
  const ids = c.posted.filter((m) => m.type === 'gate').map((m) => m.requestId);
  assert.equal(new Set(ids).size, 2, ids.join(' '));
  resolveGate(c, ids[0], 'proceed');
  resolveGate(c, ids[1], 'skip');
  assert.deepEqual(await Promise.all([a, b]), ['proceed', 'skip']);
});

// 前端無狀態：網頁重新整理後卡片全沒了，不重推的話那次工具呼叫就停在一個誰也看不見的
// 等待上，介面只剩一個轉不完的忙碌標記。
describe('重連', () => {
  const c = fakeController();
  askGate(c, ASK, new AbortController().signal);
  const first = gateMsg(c);
  c.posted.length = 0;

  test('還沒答的原樣再推一遍', () => {
    resendGates(c);
    assert.equal(c.posted.length, 1);
    assert.equal(c.posted[0].requestId, first.requestId);
    assert.equal(c.posted[0].title, first.title);
  });

  test('答過的不再推', () => {
    resolveGate(c, first.requestId, 'proceed');
    c.posted.length = 0;
    resendGates(c);
    assert.equal(c.posted.length, 0);
  });
});

describe('取消', () => {
  test('作者點停止時按「停止」結算，不留懸著的 Promise', async () => {
    const c = fakeController();
    const abort = new AbortController();
    const pending = askGate(c, ASK, abort.signal);
    abort.abort();
    assert.equal(await pending, 'stop');
    // 說法是「取消」而不是作者答的那三個——他並沒有按下任何一顆。
    assert.equal(doneMsgs(c)[0].verdict, 'cancelled');
  });

  test('已經取消了的 signal 也不會掛住', async () => {
    const c = fakeController();
    const abort = new AbortController();
    abort.abort();
    assert.equal(await askGate(c, ASK, abort.signal), 'stop');
  });
});

// 落盤那一問的拒絕那顆寫「不採納」——那不是「跳過一步」，是「這份產物我不要」。
// 叫停整輪任何時候都不在這張卡上（那是輸入框旁邊那顆「停止」）。
test('呼叫方能改按鈕上的字，但改不出第三顆', () => {
  const c = fakeController();
  askGate(c, { ...ASK, skip: '不採納' });
  assert.equal(gateMsg(c).proceed, '確認');
  assert.equal(gateMsg(c).skip, '不採納');
  assert.equal(Object.keys(gateMsg(c)).includes('stop'), false, JSON.stringify(gateMsg(c)));
});

// 落盤那張卡沒有 signal（生成早結束了、鎖也放了）。作者不理它、直接開了
// 下一輪或換了會話時，它不該還留著——點下去寫的是一份他已經翻篇的產物。
describe('cancelGates', () => {
  test('把還沒答的全按「取消」收掉', async () => {
    const c = fakeController();
    const pending = askGate(c, ASK);
    cancelGates(c);
    assert.equal(await pending, 'stop');
    assert.equal(doneMsgs(c)[0].verdict, 'cancelled');
    assert.equal(c.gates.size, 0);
  });

  test('沒有等著的時候什麼也不做', () => {
    const c = fakeController();
    assert.doesNotThrow(() => cancelGates(c));
    assert.equal(c.posted.length, 0);
  });
});
