/**
 * 工具條那一行的幾條約束（外部 agent 經 MCP 調工具時，對話頁上只看得見這些）：
 *
 * 1. **認得出是誰做的**——MCP 留下的那一輪頭上寫「外部 Agent」並掛一個 `MCP` 標籤，
 *    不冒充模型的回覆。
 * 2. **停止按鈕全程可用**——忙的時候就是它頂在傳送位上。
 * 3. **失敗的步驟標紅並保留**——不因為後面成功了就把失敗那步藏掉。
 * 4. **詳情查得到**——那一行仍只畫摘要，引數與返回收在摺疊裡，點開才有。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

const rows = (ui, id) => [...ui.bubble(id).querySelectorAll('.tool-row')];

describe('MCP 留下的那一輪（重開面板時回放）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const head = (id) => ui.bubble(id).querySelector('.msg-head');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('a1', 'assistant', '', {
            mcp: true,
            segments: [
              toolSeg({ callId: 'c1', name: 'read', title: 'read .novelwarden/summaries/012.md', ok: true, summary: '20 行', elapsedMs: 30 }),
              toolSeg({ callId: 'c2', name: 'write', title: 'write .novelwarden/summaries/012.md', ok: false, summary: '作者跳過了這一步', elapsedMs: 0 }),
            ],
          }),
          turn('a2', 'assistant', '普通回答'),
          turn('a3', 'assistant', '我先看看。', {
            builtinAgent: true,
            segments: [
              toolSeg({ callId: 'c3', name: 'read', title: 'read .novelwarden/outline.md', ok: true, summary: '40 行', elapsedMs: 20 }),
              textSeg('我先看看。'),
            ],
          }),
        ],
      }),
    });
  });

  test('頭上寫的是「外部 Agent」', () => {
    assert.equal(head('a1').querySelector('.msg-role').textContent, '外部 Agent');
  });

  test('掛著一個 MCP 標籤', () => {
    const tag = head('a1').querySelector('.msg-tag');
    assert.ok(tag, head('a1').innerHTML);
    assert.equal(tag.textContent, 'MCP');
  });

  // 不因為後面成功了就把失敗那步藏掉。
  test('失敗的那一步保留並標紅', () => {
    assert.equal(rows(ui, 'a1').length, 2);
    const failed = ui.bubble('a1').querySelector('.tool-row[data-call="c2"]');
    assert.ok(failed.classList.contains('tool-failed'), failed.className);
    assert.ok(failed.textContent.includes('跳過'), failed.textContent);
  });

  test('普通回覆還是「模型」，沒有 MCP 標籤', () => {
    assert.equal(head('a2').querySelector('.msg-role').textContent, '模型');
    assert.equal(head('a2').querySelector('.msg-tag'), null);
  });

  // 刪掉的內建 agent 留下的舊輪次：不冒充模型，也不冒充 MCP。
  test('內建 agent 的舊輪次寫「內建 Agent」並掛「已移除」', () => {
    assert.equal(head('a3').querySelector('.msg-role').textContent, '內建 Agent');
    assert.equal(head('a3').querySelector('.msg-tag').textContent, '已移除');
    assert.equal(rows(ui, 'a3').length, 1);
  });
});

describe('停止按鈕全程可用', { skip: JSDOM_SKIP }, () => {
  let ui;
  const stop = () => ui.doc.getElementById('stopBtn');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
  });

  test('頁面上有這顆按鈕', () => {
    assert.ok(stop(), '缺少 #stopBtn');
  });

  test('忙起來之後點得到', () => {
    ui.post({ type: 'busy', value: true });
    assert.equal(stop().hidden, false, stop().outerHTML);
  });

  test('點它發的是 stop', () => {
    ui.clickEl(stop());
    assert.ok(ui.sent.some((m) => m.type === 'stop'), JSON.stringify(ui.sent.map((m) => m.type)));
  });
});

describe('工具呼叫詳情（點開那一條）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rowOf = (id, call) => ui.bubble(id).querySelector(`.tool-row[data-call="${call}"]`);

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('a1', 'assistant', '第 9 章裡沒提過北境。', {
            segments: [
              toolSeg({
                callId: 'c1',
                name: 'read',
                title: 'read',
                ok: true,
                summary: '19 行',
                elapsedMs: 1,
                argsText: '{\n  "path": "chapters/009-北風.md"\n}',
                resultText: '第九章 北風\n他從沒去過那邊。',
              }),
              // 老會話裡存的那些：只有摘要，沒有明細。
              toolSeg({ callId: 'c2', name: 'list', title: 'list', ok: true, summary: '2 項', elapsedMs: 4 }),
              textSeg('第 9 章裡沒提過北境。'),
            ],
          }),
        ],
      }),
    });
  });

  test('那一行上仍然只有摘要（正文不攤在氣泡裡）', () => {
    const line = rowOf('a1', 'c1').querySelector('.tool-line');
    assert.ok(line.textContent.includes('19 行'), line.textContent);
    assert.ok(!line.textContent.includes('北風'), line.textContent);
  });

  test('預設是收起的', () => {
    assert.equal(rowOf('a1', 'c1').open, false);
  });

  test('點開看得到引數與返回', () => {
    const row = rowOf('a1', 'c1');
    row.open = true;
    const parts = [...row.querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].includes('chapters/009-北風.md'), parts[0]);
    assert.ok(parts[1].includes('他從沒去過那邊'), parts[1]);
  });

  // 點開之後空空如也比不給展開更讓人火大。
  test('沒有明細的老記錄不長出摺疊三角', () => {
    const row = rowOf('a1', 'c2');
    assert.equal(row.tagName, 'DIV');
    assert.equal(row.querySelector('.tool-detail'), null);
    assert.ok(row.textContent.includes('2 項'), row.textContent);
  });
});

describe('詳情在實時那條路上（進行中 → 有結果）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const row = () => ui.bubble('a1').querySelector('.tool-row[data-call="c1"]');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({
      type: 'toolCall',
      turnId: 'a1',
      callId: 'c1',
      name: 'read',
      title: 'read',
      argsText: '{ "path": "chapters/009-北風.md" }',
    });
  });

  // 「它現在卡在哪一步」最先要看的就是這一步動的是哪個路徑。
  test('還沒有結果時引數就查得到', () => {
    row().open = true;
    const parts = [...row().querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].includes('009-北風'), parts[0]);
  });

  test('結果到了：展開狀態跟著過去，返回文字補上', () => {
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c1',
      name: 'read',
      ok: true,
      summary: '19 行',
      elapsedMs: 1,
      argsText: '{ "path": "chapters/009-北風.md" }',
      resultText: '第九章 北風',
    });
    assert.equal(row().open, true, row().outerHTML);
    const parts = [...row().querySelectorAll('.tool-detail-text')].map((n) => n.textContent);
    assert.equal(parts.length, 2);
    assert.ok(parts[1].includes('第九章 北風'), parts[1]);
    assert.ok(row().querySelector('.tool-elapsed').textContent.includes('1ms'));
  });
});
