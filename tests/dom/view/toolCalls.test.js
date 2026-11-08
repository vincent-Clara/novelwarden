/**
 * 工具呼叫在氣泡里長什麼樣：工具呼叫的摺疊條（外部 agent 經 MCP 調工具時掛在那一輪上）
 * + 「直接傳送就是討論」。
 *
 * 兩條路都要驗：
 *
 * 1. **實時**——`toolCall` 先掛一條「進行中…」，`toolResult` 到了就地換成
 *    帶耗時的最終形態。**就地追加而不是重建氣泡**：重建會把正在流的正文沖掉。
 * 2. **回放**——重開面板時靠 `turn.segments` 把那一串重新畫出來。
 *
 * 還有一條最要緊的：**氣泡裡只畫摘要，不畫工具的完整返回值**。
 * 交替本身（說的話與做的事按發生順序排）另有一份：`toolSegments.test.js`。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

const rows = (ui, id) => [...ui.bubble(id).querySelectorAll('.tool-row')];
const textsOf = (row) => ({
  title: row.querySelector('.tool-title').textContent,
  summary: row.querySelector('.tool-summary').textContent,
  elapsed: row.querySelector('.tool-elapsed').textContent,
});

describe('工具呼叫流（實時）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '第 9 章裡他說過沒去過北境嗎？') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('toolCall 到了就掛一條', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c1', name: 'search', title: 'search「北境」' });
    assert.equal(rows(ui, 'a1').length, 1);
  });

  test('還沒有結果時標「進行中」', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).summary, '進行中…');
  });

  test('還沒有結果時不顯示耗時', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).elapsed, '');
  });

  test('toolResult 到了就地換成最終形態', () => {
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c1',
      name: 'search',
      ok: true,
      summary: '2 處命中',
      elapsedMs: 320,
    });
    assert.equal(rows(ui, 'a1').length, 1, '不該多出一行');
    assert.equal(textsOf(rows(ui, 'a1')[0]).summary, '2 處命中');
  });

  // 與日誌的 formatDuration 同一套口徑：一秒以內報毫秒，更看得出快慢。
  test('耗時按毫秒顯示', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).elapsed, '320ms');
  });

  test('標題留著（結果訊息裡沒有它）', () => {
    assert.equal(textsOf(rows(ui, 'a1')[0]).title, 'search「北境」');
  });

  test('第二個工具排在後面，順序就是執行順序', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c2', name: 'read', title: 'read chapters/009-北行.md' });
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c2',
      name: 'read',
      ok: true,
      summary: '4 行',
      elapsedMs: 40,
    });
    assert.deepEqual(rows(ui, 'a1').map((r) => textsOf(r).title), [
      'search「北境」',
      'read chapters/009-北行.md',
    ]);
  });

  test('毫秒級的耗時不顯示成 0.0s', () => {
    assert.equal(textsOf(rows(ui, 'a1')[1]).elapsed, '40ms');
  });

  // 就地追加而不是重建氣泡：重建會把正在流的內容沖掉（文字塊是純文字節點）。
  // **中間插了一次工具呼叫，後面那句話就是新的一塊**——那正是交替。
  test('工具呼叫打斷之後，兩句話各自成塊', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '他在第 9 章說過。' });
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c3', name: 'read', title: 'read x' });
    ui.post({ type: 'delta', turnId: 'a1', text: '依據在第 3 行。' });
    assert.deepEqual(
      [...ui.bubble('a1').querySelectorAll('.msg-body')].map((b) => b.textContent),
      ['他在第 9 章說過。', '依據在第 3 行。']
    );
  });

  test('順序就是發生的順序（先說、再查、再說）', () => {
    const kinds = [...ui.bubble('a1').children]
      .map((c) => c.className)
      .filter((cn) => cn === 'tools' || cn === 'msg-body');
    // 前面那幾次呼叫在第一串裡；delta 之後那次 read 另起一串。
    assert.deepEqual(kinds, ['tools', 'msg-body', 'tools', 'msg-body']);
  });

  test('失敗的工具帶標記', () => {
    ui.post({ type: 'toolCall', turnId: 'a1', callId: 'c9', name: 'read', title: 'read 不存在.md' });
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c9',
      name: 'read',
      ok: false,
      summary: '檔案不存在：不存在.md',
      elapsedMs: 5,
    });
    const row = ui.bubble('a1').querySelector('.tool-row[data-call="c9"]');
    assert.ok(row.classList.contains('tool-failed'), row.className);
  });

  test('認不出的 turnId 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({ type: 'toolCall', turnId: '並不存在', callId: 'x', name: 'read', title: 'read x' })
    );
  });

  test('沒有對應 toolCall 的 toolResult 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({
        type: 'toolResult',
        turnId: 'a1',
        callId: '沒掛過的',
        name: 'read',
        ok: true,
        summary: 'x',
        elapsedMs: 1,
      })
    );
  });
});

describe('工具呼叫流（重開面板時回放）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '排一下第 12 章'),
          turn('a1', 'assistant', '排好了，收在藏書閣門口。', {
            segments: [
              toolSeg({ callId: 'c1', name: 'read', title: 'read .novelwarden/summaries/012.md', ok: true, summary: '20 行', elapsedMs: 30 }),
              toolSeg({
                callId: 'c2',
                name: 'generate',
                title: 'generate 細綱·生成',
                ok: true,
                summary: '細綱 · 3/3 節 · 620 字',
                elapsedMs: 12400,
                output: '第一節 藏書閣門口\n他在門口站了很久。',
              }),
              textSeg('排好了，收在藏書閣門口。'),
            ],
          }),
        ],
      }),
    });
  });

  test('工具那一條畫回來了', () => {
    assert.equal(rows(ui, 'a1').length, 1);
    assert.deepEqual(textsOf(rows(ui, 'a1')[0]), {
      title: 'read .novelwarden/summaries/012.md',
      summary: '20 行',
      elapsed: '30ms',
    });
  });

  // 花錢那一下產出的是**產物本身**，不是它查資料的過程：畫成一張卡，
  // 連正文一起留住（從前那幾千字重新整理之後整份消失）。
  test('generate 畫成一張卡，不是一行流水賬', () => {
    const card = ui.bubble('a1').querySelector('.gen[data-call="c2"]');
    assert.ok(card, ui.bubble('a1').innerHTML);
    assert.equal(card.querySelector('.gen-title').textContent, 'generate 細綱·生成');
    assert.equal(card.querySelector('.gen-elapsed').textContent, '12.4s');
    assert.equal(card.querySelector('.gen-state-text').textContent, '細綱 · 3/3 節 · 620 字');
    assert.ok(card.querySelector('.gen-body').textContent.includes('藏書閣門口'));
  });

  test('卡預設是展開的（那份產物就是要讀的東西）', () => {
    assert.equal(ui.bubble('a1').querySelector('.gen[data-call="c2"]').open, true);
  });

  // 一章正文幾千字，攤在氣泡裡會把作者真正要看的那段回答擠到螢幕外。
  test('氣泡裡沒有工具的完整返回值', () => {
    assert.ok(!ui.bubble('a1').textContent.includes('.novelwarden/summaries/012.md\n'), ui.bubble('a1').textContent);
  });

  test('回答本身照常顯示', () => {
    assert.equal(ui.bodyOf('a1').textContent, '排好了，收在藏書閣門口。');
  });

  test('沒有段的普通輪次不長出空的工具條', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通回答') });
    assert.equal(ui.bubble('a2').querySelector('.tools'), null);
  });
});

describe('直接傳送就是討論', { skip: JSDOM_SKIP }, () => {
  let ui;
  const input = () => ui.doc.getElementById('input');
  const sendBtn = () => ui.doc.getElementById('sendBtn');
  const sends = () => ui.sent.filter((m) => m.type === 'send').length;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
  });

  test('頁面上沒有 Agent 開關', () => {
    assert.equal(ui.doc.getElementById('agentToggle'), null);
  });

  // 內建 agent 刪掉了：多步的活由外部 agent 經 MCP 來做，對話方塊裡不挑命令就是在當前階段討論。
  test('沒挑命令時發的是 send，能力是討論', () => {
    input().value = '第 9 章裡他說過沒去過北境嗎？';
    ui.clickEl(sendBtn());
    const p = ui.last('send').payload;
    assert.equal(p.text, '第 9 章裡他說過沒去過北境嗎？');
    assert.equal(p.capability, 'discuss', JSON.stringify(p));
  });

  test('不再有 sendAgent', () => {
    assert.ok(!ui.sent.some((m) => m.type === 'sendAgent'), JSON.stringify(ui.sent.map((m) => m.type)));
  });

  test('空輸入不傳送', () => {
    ui.post({ type: 'busy', value: false });
    const before = sends();
    input().value = '   ';
    ui.clickEl(sendBtn());
    assert.equal(sends(), before);
  });

  test('傳送後清空輸入框', () => {
    ui.post({ type: 'busy', value: false });
    input().value = '再問一句';
    ui.clickEl(sendBtn());
    assert.equal(input().value, '');
  });

  // 挑了 `/命令`（續寫大綱、寫細綱…）才回到確定性的單步。
  //
  // 挑的命令必須**屬於當前會話那一層**：面板讀的是 `commandsFor(session.stage)`，
  // 而這個會話停在大綱層（`emptySession` 的預設），那一層自己的只有「續寫大綱」一條
  // （拆卷隨卷那一層刪了）。挑一條別的層的命令，`find` 會返回 undefined，
  // 用例炸在 clickEl 上而不是在斷言上——所以先斷言它找得到。
  test('挑了命令時發的還是 send', () => {
    ui.post({ type: 'busy', value: false });
    input().value = '/';
    input().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    const pick = [...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes('續寫大綱'));
    assert.ok(pick, [...ui.doc.querySelectorAll('.cmd-item')].map((n) => n.textContent).join('|'));
    ui.clickEl(pick);
    input().value = '前二十章先把主角送進宗門';
    ui.clickEl(sendBtn());
    assert.equal(ui.last('send').payload.capability, 'generate', JSON.stringify(ui.last('send').payload));
  });
});
