/**
 * 許可權請求：**固定在輸入框上方那一格**，不是模態框，也不是訊息流裡的一張卡片。
 *
 * 最早它走 `host.confirm({ modal: true })`——VS Code 裡是視窗正中一個把介面鎖死
 * 的框。作者要判斷的恰恰是「這一步動的是哪個檔案」，而那串上下文就在被蓋住的
 * 氣泡裡。於是改成畫在對話裡的一張卡片。
 *
 * 這一版把它從訊息流裡挪出來：掛在氣泡上就會跟著內容滾——agent 隨後還在說話、
 * 還在調工具，幾行之後那張卡就滾出視野了，而迴圈正卡在它上面等回答。現在它貼
 * 在輸入框上沿（`#gateDock`），不滾；答完卡片就撤，訊息流裡留一行記錄。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | `gate` 到了 | 卡片進 `#gateDock`（輸入框上方），**不進氣泡**，遮罩層一動不動 |
 * | 兩顆按鈕 | 字全部來自後端，同意貼最右；**叫停整輪不在這張卡上** |
 * | 點一顆 | 發回 `gateResult`，卡片撤下，格子收起，訊息流裡補一行記錄 |
 * | 重連重推同一條 | 不畫出兩張 |
 * | 認不出的 turnId | 卡片照樣畫（丟掉等於留一個沒人看得見的死等） |
 * | `gateDone` | 另一個檢視上答的，這邊也收 |
 * | 帶 `remember` 的預檢卡 | 多一格理由與第三顆按鈕，填了才能點，理由隨 `gateResult` 帶回（五期補遺 §2） |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession } = require('../../helpers/dom');

const GATE = {
  type: 'gate',
  requestId: 'g1',
  turnId: 'a1',
  callId: 'c1',
  name: 'write',
  title: 'Agent 要寫入設定「北境雪原」',
  detail: '.novelwarden/lore/北境雪原.md · 新建 · 約 320 字',
  argsText: '{\n  "path": ".novelwarden/lore/北境雪原.md"\n}',
  proceed: '確認',
  skip: '跳過',
};

const dock = (ui) => ui.doc.getElementById('gateDock');
const card = (ui) => dock(ui).querySelector('.gate');
const buttons = (ui) => [...card(ui).querySelectorAll('button')];
const note = (ui) => ui.bubble('a1') && ui.bubble('a1').querySelector('.gate-note');

function running() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '把北境那條設定補上') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  ui.post({ type: 'delta', turnId: 'a1', text: '我來寫一條設定。' });
  return ui;
}

describe('許可權請求固定在輸入框上方', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
  });

  test('卡片進輸入框上方那一格，格子跟著露出來', () => {
    assert.ok(card(ui), dock(ui).innerHTML);
    assert.equal(dock(ui).classList.contains('hidden'), false);
  });

  // ★ 這一版的改動本身：它不該再掛在氣泡上跟著內容滾。
  test('不在訊息流裡', () => {
    assert.equal(ui.bubble('a1').querySelector('.gate'), null);
    assert.equal(card(ui).closest('.messages'), null);
  });

  // 位置就是它的全部意義：在輸入框**上面**，且與輸入框在同一塊（.composer）裡。
  test('就在輸入框上沿', () => {
    assert.ok(dock(ui).closest('.composer'), dock(ui).parentElement.className);
    const kids = [...dock(ui).parentElement.children];
    assert.ok(kids.indexOf(dock(ui)) < kids.findIndex((n) => n.id === 'composerInput'));
  });

  test('遮罩層一動不動', () => {
    assert.ok(ui.doc.getElementById('providerModal').classList.contains('hidden'));
  });

  test('說清了要做什麼、動的是哪個檔案', () => {
    assert.ok(card(ui).textContent.includes('要寫入設定'), card(ui).textContent);
    assert.ok(card(ui).textContent.includes('北境雪原.md'), card(ui).textContent);
  });

  test('引數收在摺疊裡，不攤開把輸入框頂下去', () => {
    const det = card(ui).querySelector('details.gate-args');
    assert.ok(det);
    assert.equal(det.open, false);
  });

  // 同意貼最右（離「傳送」最近的那一側就是「繼續」）。叫停整輪是輸入框旁邊
  // 那顆「停止」，不在這張卡上——擺進閘門只會被誤當成「跳過」，而兩者的後果
  // 差著一整輪。
  test('兩顆按鈕，字來自後端，同意在最右', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['跳過', '確認']);
  });

  test('正文沒被沖掉', () => {
    assert.equal(ui.bodyOf('a1').textContent, '我來寫一條設定。');
  });

  test('重連重推同一條不會畫出兩張', () => {
    ui.post(GATE);
    assert.equal(dock(ui).querySelectorAll('.gate').length, 1);
  });

  // 卡片不再掛在氣泡上，認不出的 turnId 也照樣有地方畫——丟掉那一張等於讓
  // 迴圈停在一個沒人看得見的等待上。
  test('認不出的 turnId 照樣畫得出來', () => {
    ui.post({ ...GATE, requestId: 'g9', turnId: '並不存在' });
    assert.equal(dock(ui).querySelectorAll('.gate').length, 2);
  });

  // 一格里疊著好幾張時，作者得知道自己在答哪一張。
  test('疊了兩張才編號', () => {
    assert.deepEqual(
      [...dock(ui).querySelectorAll('.gate-count')].map((n) => n.textContent),
      ['1 / 2', '2 / 2']
    );
  });
});

describe('點下去', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[1]);
  });

  test('把結論發回後端', () => {
    const sent = ui.last('gateResult');
    assert.equal(sent.requestId, 'g1');
    assert.equal(sent.verdict, 'proceed');
  });

  // 後端回話之前不撤的話，作者能把兩顆都點一遍，而只有第一下算數。
  test('卡片撤下，格子空了就收起來', () => {
    assert.equal(card(ui), null);
    assert.ok(dock(ui).classList.contains('hidden'));
  });

  // 緊跟著的那條工具條只會說「未執行」，「因為我按了跳過」得有地方講。
  test('訊息流裡留一行記錄，排在工具串裡', () => {
    assert.ok(note(ui), ui.bubble('a1').innerHTML);
    assert.ok(note(ui).textContent.includes('已允許'), note(ui).textContent);
    assert.ok(note(ui).textContent.includes('要寫入設定'), note(ui).textContent);
    assert.ok(note(ui).closest('.tools'), note(ui).parentElement.className);
  });

  // 後端隨後會廣播 gateDone（兩個檢視都要收卡）——這邊已經答過了，不能再補一行。
  test('後端廣播回來不再補第二行', () => {
    ui.post({ type: 'gateDone', requestId: 'g1', verdict: 'proceed' });
    assert.equal(ui.bubble('a1').querySelectorAll('.gate-note').length, 1);
  });
});

// 五期補遺 §2：一致性預檢卡多一格理由與第三顆按鈕「記為刻意安排，照寫」。
describe('記為刻意安排（帶理由的同意）', { skip: JSDOM_SKIP }, () => {
  const PREFLIGHT = {
    ...GATE,
    requestId: 'g5',
    callId: undefined,
    name: 'preflight',
    title: '寫第 8 章之前的一致性預檢：1 處要留意',
    proceed: '僅本次忽略，照寫',
    skip: '先不寫',
    danger: '沈秋的當前狀態（截至第 5 章）寫著「已死亡」，本章細綱仍安排這個人出場',
    remember: { label: '記為刻意安排，照寫', placeholder: '為什麼這是刻意的安排' },
  };
  let ui;
  let save;
  let input;

  before(() => {
    ui = running();
    ui.post(PREFLIGHT);
    input = card(ui).querySelector('.gate-remember-input');
    save = card(ui).querySelector('.gate-remember-btn');
  });

  test('有理由輸入框與第三顆按鈕，排在兩顆主按鈕上面', () => {
    assert.ok(input && save, card(ui).innerHTML);
    assert.equal(input.placeholder, '為什麼這是刻意的安排');
    assert.equal(save.textContent, '記為刻意安排，照寫');
    const row = card(ui).querySelector('.gate-remember');
    const actions = card(ui).querySelector('.gate-actions');
    assert.ok(row.compareDocumentPosition(actions) & 4, '理由那一行在按鈕行前面');
  });

  test('沒填理由點不了', () => {
    assert.equal(save.disabled, true);
  });

  test('填了理由點下去：發回 proceed 並帶上理由，卡片撤下', () => {
    input.value = '  託夢裡的一場 ';
    input.dispatchEvent(new ui.window.Event('input'));
    assert.equal(save.disabled, false);
    ui.clickEl(save);
    const sent = ui.last('gateResult');
    assert.equal(sent.verdict, 'proceed');
    assert.equal(sent.remember, '託夢裡的一場');
    assert.equal(card(ui), null);
  });

  test('別的卡片沒有這一格', () => {
    const other = running();
    other.post(GATE);
    assert.equal(other.doc.querySelector('.gate-remember'), null);
  });
});

describe('跳過', { skip: JSDOM_SKIP }, () => {
  test('發回 skip，並標成「拒絕了」那一檔', () => {
    const ui = running();
    ui.post(GATE);
    ui.clickEl(buttons(ui)[0]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
    assert.ok(note(ui).textContent.includes('已跳過'), note(ui).textContent);
    assert.ok(note(ui).classList.contains('declined'), note(ui).className);
  });
});

// 側邊欄與編輯器標籤頁掛的是同一個 controller：只在被點的那一邊收卡片的話，
// 另一邊會留一張點了沒反應的卡。
describe('另一個檢視上答了 / 這一輪被取消', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post(GATE);
    ui.post({ type: 'gateDone', requestId: 'g1', verdict: 'cancelled' });
  });

  test('這邊的卡片也收了', () => {
    assert.equal(card(ui), null);
    assert.ok(dock(ui).classList.contains('hidden'));
  });

  test('說的是「取消」，不是作者答的那兩個', () => {
    assert.ok(note(ui).textContent.includes('已取消'), note(ui).textContent);
  });

  test('沒往後端發東西——不是作者答的', () => {
    assert.equal(ui.last('gateResult'), undefined);
  });

  test('認不出的 requestId 不炸', () => {
    assert.doesNotThrow(() => ui.post({ type: 'gateDone', requestId: '並不存在', verdict: 'skip' }));
  });
});

// 產出之後那張落盤卡片：拒絕那顆寫的不是「跳過」而是「不採納」（這一問不是
// 「跳過一步」，是「這份產物我不要」），答完那一行也掛在正文**下面**——那份
// 產物就是作者做判斷的依據。
describe('產物落盤那一張', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    ui.post({
      ...GATE,
      callId: undefined,
      name: 'artifact',
      title: '把這份產物寫入到「第 12 章《夜入青雲》 · 劇情」',
      detail: '劇情 · 4/4 節',
      argsText: undefined,
      proceed: '確認',
      skip: '不採納',
    });
  });

  test('拒絕那顆寫「不採納」', () => {
    assert.deepEqual(buttons(ui).map((b) => b.textContent), ['不採納', '確認']);
  });

  test('點「不採納」照樣發回結論', () => {
    ui.clickEl(buttons(ui)[0]);
    assert.equal(ui.last('gateResult').verdict, 'skip');
  });

  // 排進工具串的話它會跑到正文上面去——那一行說的是「這份產物沒落地」。
  test('那一行記錄掛在正文下面，不在工具串裡', () => {
    assert.equal(note(ui).closest('.tools'), null, note(ui).parentElement.className);
    const kids = [...ui.bubble('a1').children];
    assert.ok(kids.indexOf(note(ui)) > kids.findIndex((n) => n.classList.contains('msg-body')));
  });
});
