/**
 * 帶工具呼叫的一輪裡**說的話與做的事按發生順序交替**，`generate` 的產出自成一張卡。
 * 外部 agent 經 MCP 留下的那一輪、帶工具呼叫的回放都走這一套渲染。
 *
 * 改之前是兩塊死板的東西：所有工具擠成一串畫在正文上方，每一回合說的話全
 * 灌進同一個 `.msg-body`，而 `generate` 內部那次呼叫流出來的幾千字也順著同一條
 * `delta` 拌進去——重新整理之後那一半還整份消失（它沒進會話）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 說 → 查 → 說 | 三段各自成塊，順序就是發生的順序 |
 * | 連著幾次呼叫 | 並進同一串（流水賬不該散成五塊） |
 * | `toolDelta` | 進 generate 那張卡，**不進**模型說的話裡 |
 * | `toolResult` | 換掉卡的頭與結論，卡裡那份正文不能丟 |
 * | 回放 | `turn.segments` 原樣畫回來，產出的正文也在 |
 * | 就地編輯 | 有段的那一輪只讀；一塊正文的那一輪照舊可改 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

/** 段區裡那一串東西，按氣泡裡的先後順序。 */
const shape = (ui, id) =>
  [...ui.bubble(id).children]
    .map((node) => {
      if (node.classList.contains('tools')) {
        return `工具×${node.querySelectorAll('.tool-row').length}`;
      }
      if (node.classList.contains('gen')) {
        return `卡:${node.dataset.call}`;
      }
      return node.dataset.seg === 'text' ? `文字:${node.textContent}` : null;
    })
    .filter(Boolean);

const card = (ui, id, call) => ui.bubble(id).querySelector(`.gen[data-call="${call}"]`);

function running() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '幫我完善大綱') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  return ui;
}

const call = (id, name, title) => ({ type: 'toolCall', turnId: 'a1', callId: id, name, title });
const done = (id, name, summary, elapsedMs = 10) => ({
  type: 'toolResult',
  turnId: 'a1',
  callId: id,
  name,
  ok: true,
  summary,
  elapsedMs,
});

describe('交替（實時）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    // 它真實的一輪：先連著讀幾份，說一句，生成，再說一句。
    ui.post(call('c1', 'list', 'list .novelwarden'));
    ui.post(done('c1', 'list', '2 項'));
    ui.post(call('c2', 'read', 'read outline.md'));
    ui.post(done('c2', 'read', '19 行'));
    ui.post({ type: 'delta', turnId: 'a1', text: '我先看看工程現在的結構。' });
    ui.post(call('c3', 'generate', 'generate 大綱·生成'));
    ui.post({ type: 'toolDelta', turnId: 'a1', callId: 'c3', text: '### 全書結構一覽\n' });
    ui.post({ type: 'toolDelta', turnId: 'a1', callId: 'c3', text: '**第一卷 活著**：半世界陷入病災。' });
    ui.post(done('c3', 'generate', '全書大綱 · 6104 字', 23600));
    ui.post({ type: 'delta', turnId: 'a1', text: '大綱已經生成。' });
  });

  test('順序就是發生的順序', () => {
    assert.deepEqual(shape(ui, 'a1'), [
      '工具×2',
      '文字:我先看看工程現在的結構。',
      '卡:c3',
      '文字:大綱已經生成。',
    ]);
  });

  // 連著五次 list/read 仍然是一串流水賬，散成五塊反而比從前更亂。
  test('相鄰的呼叫並進同一串', () => {
    assert.equal(ui.bubble('a1').querySelectorAll('.tools').length, 1);
  });

  // ★ 這一條就是這次改動本身：產物不許再混進模型說的話裡。
  test('產出的正文只在卡裡，不在任何一塊正文裡', () => {
    const texts = [...ui.bubble('a1').querySelectorAll('.msg-body')].map((b) => b.textContent);
    assert.deepEqual(texts, ['我先看看工程現在的結構。', '大綱已經生成。']);
    assert.ok(card(ui, 'a1', 'c3').querySelector('.gen-body').textContent.includes('全書結構一覽'));
  });

  test('卡預設展開，正文限在卡裡滾（不把對話頂開）', () => {
    assert.equal(card(ui, 'a1', 'c3').open, true);
  });

  // toolResult 里根本沒有那份正文——它是順著 toolDelta 一段段攢在卡裡的。
  test('結果到了：頭與結論換掉，卡裡那份正文還在', () => {
    const c = card(ui, 'a1', 'c3');
    assert.equal(c.querySelector('.gen-elapsed').textContent, '23.6s');
    assert.equal(c.querySelector('.gen-state-text').textContent, '全書大綱 · 6104 字');
    assert.ok(c.querySelector('.gen-body').textContent.includes('半世界陷入病災'));
  });

  // 落盤答完之後後端會把結論拼在 summary 後面重推一次，那時同樣不能抹掉正文。
  test('落盤的結論補上來，正文照舊不丟', () => {
    ui.post(done('c3', 'generate', '全書大綱 · 6104 字 · 已寫入 .novelwarden/outline.md', 23600));
    const c = card(ui, 'a1', 'c3');
    assert.ok(c.querySelector('.gen-state-text').textContent.includes('已寫入'));
    assert.ok(c.querySelector('.gen-body').textContent.includes('全書結構一覽'));
  });

  test('生成中那張卡說「生成中…」，不擺一句空話', () => {
    const fresh = running();
    fresh.post(call('c9', 'generate', 'generate 正文·生成'));
    assert.equal(card(fresh, 'a1', 'c9').querySelector('.gen-state-text').textContent, '生成中…');
    assert.equal(card(fresh, 'a1', 'c9').querySelector('.gen-elapsed').textContent, '');
  });

  // 一輪剛開始時留的那塊空正文（給「它在想」留的位）不能擋在工具條前面。
  test('第一段是工具呼叫時，那塊空正文佔位撤掉了', () => {
    const fresh = running();
    assert.ok(fresh.bodyOf('a1'), '一輪剛開始該有個佔位');
    fresh.post(call('c1', 'read', 'read x'));
    assert.equal(fresh.bubble('a1').querySelector('.msg-body'), null);
    assert.deepEqual(shape(fresh, 'a1'), ['工具×1']);
  });

  // 卡上那兩行說的是「產出了什麼」；「按哪個落點、哪句要求生成的」只在引數裡，
  // 而花錢那一下最該查得出這件事。
  test('引數收在再一層摺疊裡', () => {
    const fresh = running();
    fresh.post({
      type: 'toolCall',
      turnId: 'a1',
      callId: 'c9',
      name: 'generate',
      title: 'generate 正文·生成',
      argsText: '{ "target": ".novelwarden/summaries/012.md" }',
    });
    const det = card(fresh, 'a1', 'c9').querySelector('details.gen-args');
    assert.ok(det, card(fresh, 'a1', 'c9').innerHTML);
    assert.equal(det.open, false);
    assert.ok(det.querySelector('.tool-detail-text').textContent.includes('012.md'));
  });

  test('認不出的 callId 的 toolDelta 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({ type: 'toolDelta', turnId: 'a1', callId: '並不存在', text: 'x' })
    );
  });
});

describe('交替（重開面板時回放）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '幫我完善大綱'),
          turn('a1', 'assistant', '我先看看。\n\n大綱已經生成。', {
            segments: [
              toolSeg({ callId: 'c1', name: 'list', title: 'list', ok: true, summary: '2 項', elapsedMs: 2 }),
              toolSeg({ callId: 'c2', name: 'read', title: 'read', ok: true, summary: '19 行', elapsedMs: 2 }),
              textSeg('我先看看。'),
              toolSeg({
                callId: 'c3',
                name: 'generate',
                title: 'generate 大綱·生成',
                ok: true,
                summary: '全書大綱 · 6104 字 · 已寫入 .novelwarden/outline.md',
                elapsedMs: 23600,
                output: '### 全書結構一覽\n**第一卷 活著**',
              }),
              textSeg('大綱已經生成。'),
            ],
          }),
        ],
      }),
    });
  });

  test('畫回來的還是那個順序', () => {
    assert.deepEqual(shape(ui, 'a1'), ['工具×2', '文字:我先看看。', '卡:c3', '文字:大綱已經生成。']);
  });

  // 從前它整份消失（那幾千字沒進會話）：重新整理一下，作者剛生成的東西就沒了。
  test('產出的正文留住了', () => {
    assert.ok(card(ui, 'a1', 'c3').querySelector('.gen-body').textContent.includes('第一卷 活著'));
  });

  // editTurn 換的是**整輪內容**，而這一輪的正文分成好幾塊，改哪一塊都對映不回去。
  test('有段的那一輪不可就地編輯', () => {
    for (const block of ui.bubble('a1').querySelectorAll('.msg-body')) {
      assert.equal(block.getAttribute('contenteditable'), null, block.textContent);
    }
  });

  test('一塊正文的那一輪照舊可改（單步創作那條路沒動）', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通回答') });
    assert.equal(ui.bubble('a2').querySelector('.msg-body').getAttribute('contenteditable'), 'true');
  });
});
