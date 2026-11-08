/**
 * 對話氣泡：流式輸出、中斷與報錯、⋯ 選單、空輸入、產物採納、思考過程。
 *
 * 遷自 scripts/smoke-view.js 的這幾節：
 *   == 流式輸出 ==（261）           == 中斷與報錯 ==（300）
 *   == 氣泡右上角的 ... 選單 ==（321） == 生成中的限制 ==（368）
 *   == 空輸入 ==（686）             == 產物採納卡片 ==（828）
 *   == 思考過程（推理模型）==（891）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, viewState } = require('../../helpers/dom');

describe('流式輸出', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    // 控制器的真實順序：busy=true，然後插一條空回覆掛流式內容。
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('先出現一個空的回覆氣泡', () => {
    assert.ok(ui.bodyOf('a1'), '沒有 a1 氣泡');
    assert.equal(ui.bodyOf('a1').textContent, '');
  });

  test('第一個 delta 立刻顯示', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。', JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('後續 delta 逐段累加', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第二段。' });
    ui.post({ type: 'delta', turnId: 'a1', text: '第三段。' });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。第二段。第三段。',
      JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('流式時帶 streaming 標記（顯示游標）', () => {
    assert.ok(ui.bubble('a1').classList.contains('streaming'));
  });

  // 生成中不能改：contentEditable 會被後續 delta 沖掉游標，
  // 改到一半的內容也會被 turnDone 的整體重建覆蓋。
  test('生成中不可編輯', () => {
    assert.notEqual(ui.bodyOf('a1').getAttribute('contenteditable'), 'true',
      String(ui.bodyOf('a1').getAttribute('contenteditable')));
  });

  test('結束後內容完整', () => {
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '第一段。第二段。第三段。') });
    ui.post({ type: 'busy', value: false });
    assert.equal(ui.bodyOf('a1').textContent, '第一段。第二段。第三段。');
  });

  test('結束後不再顯示流式游標', () => {
    assert.ok(!ui.bubble('a1').classList.contains('streaming'));
  });

  test('結束後可以就地編輯', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  // 上一輪的 streaming 狀態不能粘在下一輪上。
  test('新一輪迴復預設可編輯', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '另一條') });
    assert.equal(ui.bodyOf('a2').getAttribute('contenteditable'), 'true');
  });
});

describe('中斷與報錯', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'delta', turnId: 'a1', text: '寫到一半' });
    // 使用者點「停止」：控制器帶 interrupted 收尾，busy 落回 false。
    ui.post({ type: 'busy', value: false });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '寫到一半', { interrupted: true }) });
  });

  test('中斷後保留已生成的內容', () => {
    assert.equal(ui.bodyOf('a1').textContent, '寫到一半');
  });

  test('中斷後可編輯', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  test('中斷後不再顯示流式游標', () => {
    assert.ok(!ui.bubble('a1').classList.contains('streaming'));
  });

  test('報錯氣泡顯示錯誤文案', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '', { error: '連線失敗' }) });
    assert.equal(ui.bodyOf('a2').textContent, '連線失敗');
  });

  test('報錯氣泡不可編輯', () => {
    assert.notEqual(ui.bodyOf('a2').getAttribute('contenteditable'), 'true');
  });
});

describe('氣泡右上角的 ... 選單', { skip: JSDOM_SKIP }, () => {
  let ui;
  const menuBtn = (id) => ui.bubble(id).querySelector('.msg-menu-btn');
  const linkTexts = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions button')].map((b) => b.textContent);

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    // 帶產物：沒有 artifact 的回覆**行內根本不該有採納按鈕**
    // （落點由後端算，前端猜不出這段話該寫到哪一層）。
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '正文', {
        draftId: 'd1',
        artifact: { where: '第 12 章《夜入青雲》 · 正文', summary: '正文 · 1200 字', overwrites: false },
      }),
    });
  });

  test('使用者氣泡有 ... 按鈕', () => {
    assert.ok(menuBtn('u1'));
  });

  test('回覆氣泡有 ... 按鈕', () => {
    assert.ok(menuBtn('a1'));
  });

  test('... 按鈕在氣泡頭部（右上角）', () => {
    assert.notEqual(menuBtn('a1').closest('.msg-head'), null);
  });

  // 冗餘的行內按鈕應該沒了。
  test('行內不再有「刪除」', () => {
    assert.ok(!linkTexts('a1').includes('刪除'), JSON.stringify(linkTexts('a1')));
  });

  test('行內不再有「重新生成」', () => {
    assert.ok(!linkTexts('u1').includes('重新生成'), JSON.stringify(linkTexts('u1')));
  });

  // 「複製」是常用動作，仍留在行內。寫檔案的按鈕一個都沒有——那一問在
  // 產出的當下就問過了（氣泡裡的許可權卡片）。
  test('「複製」仍在行內', () => {
    assert.ok(linkTexts('a1').includes('複製'), JSON.stringify(linkTexts('a1')));
  });

  test('選單預設不顯示', () => {
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });

  test('點選後彈出選單', () => {
    ui.clickEl(menuBtn('u1'));
    assert.ok(ui.doc.querySelector('.msg-menu'));
  });

  test('使用者訊息選單含「重新生成」與「刪除」', () => {
    const menu = ui.doc.querySelector('.msg-menu');
    const items = [...menu.querySelectorAll('button')].map((b) => b.textContent);
    assert.ok(items.includes('重新生成') && items.includes('刪除'), JSON.stringify(items));
  });

  // 原樣保留：這一條靠 `button:last-child` 取「刪除」項，而不是按文案找。
  // 它證明的是「選單最後一項發出 deleteTurn」，**不是**「點『刪除』發出
  // deleteTurn」——選單末尾一加項就會點到別的按鈕上去，屆時這條要麼錯誤地
  // 通過、要麼以一個看不懂的理由失敗。
  test('點刪除發出 deleteTurn', () => {
    const menu = ui.doc.querySelector('.msg-menu');
    ui.clickEl(menu.querySelector('button:last-child'));
    const del = ui.sent.filter((m) => m.type === 'deleteTurn');
    assert.equal(del.length, 1, JSON.stringify(del));
    assert.equal(del[0].turnId, 'u1', JSON.stringify(del));
  });

  test('操作後選單關閉', () => {
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });

  // 回覆氣泡的選單裡不該有「重新生成」（重來是從使用者那條分叉的）。
  test('回覆訊息選單隻有「刪除」', () => {
    ui.clickEl(menuBtn('a1'));
    const items2 = [...ui.doc.querySelectorAll('.msg-menu button')].map((b) => b.textContent);
    assert.deepEqual(items2, ['刪除'], JSON.stringify(items2));
  });

  // 點別處要能關掉。
  test('點空白處關閉選單', () => {
    ui.closeMenu();
    assert.ok(!ui.doc.querySelector('.msg-menu'));
  });
});

describe('生成中的限制', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'delta', turnId: 'a1', text: '生成中' });
  });

  // 原樣保留原實現的空轉風險：`regen` 找不到時整個點選被跳過，前後 retry 計數
  // 自然相等，用例照綠。所以這一條證明的是「生成中不會多出一個 retry」，
  // **不能**區分「按鈕存在但正確地不響應」與「按鈕/選單壓根沒出現」。
  test('生成中點「重新生成」不會發起新請求', () => {
    ui.clickEl(ui.bubble('u1').querySelector('.msg-menu-btn'));
    const before = ui.sent.filter((m) => m.type === 'retry').length;
    const regen = [...ui.doc.querySelectorAll('.msg-menu button')]
      .find((b) => b.textContent === '重新生成');
    if (regen) ui.clickEl(regen);
    assert.equal(ui.sent.filter((m) => m.type === 'retry').length, before);
  });
});

describe('空輸入', { skip: JSDOM_SKIP }, () => {
  let ui;
  const sends = () => ui.sent.filter((m) => m.type === 'send').length;
  /** 從 `/` 面板挑一個命令，挑完輸入框是空的。 */
  const pickCommand = (label) => {
    const input = ui.doc.getElementById('input');
    input.value = '/';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.clickEl([...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes(label)));
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-夜入青雲.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
  });

  // 直接傳送是在當前階段討論，討論的全部輸入就是作者那句話——沒有話就沒得聊。
  test('直接傳送仍然要求先輸入', () => {
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 0);
  });

  test('有話就發 send，能力是討論', () => {
    ui.doc.getElementById('input').value = '這一章節奏是不是太慢';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 1, String(sends()));
    assert.equal(ui.last('send').payload.capability, 'discuss', JSON.stringify(ui.last('send').payload));
    ui.post({ type: 'busy', value: false });
  });

  // 而 `/寫細綱` 不需要作者再說什麼——這一章該發生什麼，大綱裡覆蓋它的那一節都寫著。
  test('生成類命令允許空輸入', () => {
    pickCommand('寫細綱');
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(sends(), 2, String(sends()));
    assert.equal(ui.last('send').payload.capability, 'generate', JSON.stringify(ui.last('send').payload));
  });
});

describe('產物那一行', { skip: JSDOM_SKIP }, () => {
  let ui;
  /**
   * 氣泡上**任何能寫檔案的按鈕**。一個都不該有——寫不寫在產出的當下就問過了
   * （氣泡裡那張許可權卡片，見 `view/gate.test.js`）。從前這裡是「採納寫入 /
   * 覆蓋並寫入」：一顆可以永遠不點的按鈕，於是「產物落盤前必須過一遍人」
   * 成了一件可以無限拖延的事。
   */
  const writeBtn = (id) =>
    [...ui.bubble(id).querySelectorAll('.msg-actions button')].find((n) => /採納|寫入|覆蓋/.test(n.textContent));
  const where = (id) => ui.bubble(id).querySelector('.artifact-where');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-夜入青雲.md' },
        stage: 'plot',
        capability: 'generate',
      }),
    });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '我建議把衝突提前。') });
    ui.post({
      type: 'turnDone',
      turn: turn('a2', 'assistant', '{"目標":"進宗門"}', {
        artifact: { where: '第 12 章《夜入青雲》 · 細綱', summary: '細綱 · 3/3 節', overwrites: false },
      }),
    });
  });

  test('無產物時只有「複製」', () => {
    assert.ok(!writeBtn('a1'),
      [...ui.bubble('a1').querySelectorAll('.msg-actions button')].map((b) => b.textContent).join('|'));
    assert.ok([...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .some((b) => b.textContent === '複製'));
  });

  // 產出過什麼仍然看得見：翻回來要認得出「這一輪產出過一份第 12 章的細綱」。
  test('產出過的說清落點與形狀', () => {
    assert.ok(where('a2') && where('a2').textContent.includes('第 12 章'), where('a2')?.textContent);
    assert.ok(where('a2').textContent.includes('3/3 節'), where('a2').textContent);
  });

  // ★ 這條就是這次改動本身。
  test('有產物也沒有任何寫入按鈕', () => {
    assert.ok(!writeBtn('a2'),
      [...ui.bubble('a2').querySelectorAll('.msg-actions button')].map((b) => b.textContent).join('|'));
  });

  test('作者當時沒同意的標一句「未採納」', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a3', 'assistant', '{"目標":"換一版"}', {
        artifact: { where: '第 12 章《夜入青雲》 · 細綱', summary: '細綱 · 3/3 節', overwrites: true, declined: true },
      }),
    });
    assert.ok(where('a3').textContent.includes('未採納'), where('a3').textContent);
    assert.ok(!writeBtn('a3'), '未採納的那一輪更不該有寫入按鈕');
  });

  test('寫進去了的說落點、給「開啟」', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a4', 'assistant', 'x', {
        artifact: { where: 'y', summary: 'z', overwrites: false },
        acceptedTo: '.novelwarden/summaries/012-夜入青雲.md',
      }),
    });
    assert.ok(ui.bubble('a4').querySelector('.accepted'));
    assert.ok([...ui.bubble('a4').querySelectorAll('.msg-actions button')].some((b) => b.textContent === '開啟'));
  });
});

describe('思考過程（推理模型）', { skip: JSDOM_SKIP }, () => {
  let ui;
  let acceptSent;
  const det = () => ui.bubble('a1').querySelector('details.reasoning');

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  });

  test('還沒思考時不顯示摺疊塊', () => {
    assert.ok(!det());
  });

  // 推理模型常常先想幾十秒才吐正文——這段時間介面必須有東西。
  test('收到思考後出現摺疊塊', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '先確定場景：' });
    assert.ok(det());
  });

  test('預設是摺疊的', () => {
    assert.equal(det().open, false);
  });

  test('思考內容已寫入', () => {
    assert.equal(det().querySelector('.reasoning-body').textContent, '先確定場景：');
  });

  test('摺疊標題顯示字數', () => {
    assert.match(det().querySelector('summary').textContent, /思考過程/);
  });

  test('思考不進正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '', JSON.stringify(ui.bodyOf('a1').textContent));
  });

  test('思考期間也顯示流式游標', () => {
    assert.ok(ui.bubble('a1').classList.contains('streaming'));
  });

  test('思考增量累加', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '夜裡的舊書店。' });
    assert.equal(det().querySelector('.reasoning-body').textContent, '先確定場景：夜裡的舊書店。');
  });

  // 使用者展開後，後續增量不能把它重新收起來。
  test('展開狀態不被後續增量重置', () => {
    det().open = true;
    ui.post({ type: 'reasoning', turnId: 'a1', text: '再補細節。' });
    assert.equal(det().open, true);
  });

  // 正文開始後，思考塊仍在，正文只含正文。
  test('正文開始後思考塊仍保留', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '燈昏。' });
    assert.ok(det());
  });

  test('正文只含正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '燈昏。');
  });

  test('收尾後思考塊還在（從 turn.reasoning 重建）', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a1', 'assistant', '燈昏。', {
        reasoning: '先確定場景：夜裡的舊書店。再補細節。',
        draftId: 'd1',
        artifact: { where: '第 12 章《夜入青雲》 · 正文', summary: '正文 · 1200 字', overwrites: false },
      }),
    });
    ui.post({ type: 'busy', value: false });
    assert.ok(det());
  });

  test('收尾後預設仍是摺疊的', () => {
    assert.equal(det().open, false);
  });

  test('收尾後正文可編輯', () => {
    assert.equal(ui.bodyOf('a1').getAttribute('contenteditable'), 'true');
  });

  // 最關鍵的一條：思考內容不是正文——落盤的、複製的都只該是正文。
  // 落盤那一份由後端從 draft 取（前端連文字都不發了），這裡守住它的孿生兄弟：
  // 氣泡正文裡沒有思考內容。
  test('氣泡正文不含思考內容', () => {
    assert.ok(!ui.bodyOf('a1').textContent.includes('先確定場景'), ui.bodyOf('a1').textContent);
  });

  test('氣泡正文就是正文', () => {
    assert.equal(ui.bodyOf('a1').textContent, '燈昏。');
  });

  // 複製同理。
  test('複製按鈕存在（不含思考）', () => {
    const copy = [...ui.bubble('a1').querySelectorAll('.msg-actions button')]
      .find((b) => b.textContent === '複製');
    assert.ok(copy);
  });

  // 沒有思考的普通模型不該多出一個空摺疊塊。
  test('無思考的回覆不出現摺疊塊', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通輸出') });
    assert.ok(!ui.bubble('a2').querySelector('details.reasoning'));
  });
});

describe('命令類訊息的氣泡', { skip: JSDOM_SKIP }, () => {
  let ui;
  const cmdTag = (id) => ui.bubble(id).querySelector('.msg-command');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/012-夜入青雲.md' },
        stage: 'plot',
        capability: 'generate',
      }),
    });
  });

  // 「寫細綱」不需要作者說什麼（該說的都在大綱裡），於是 content 是空的。
  // 但氣泡不能就這麼空著——翻回去看時認不出剛才點的是哪一下。
  test('空輸入的命令輪次顯示命令名', () => {
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '', { command: '寫細綱' }) });
    assert.ok(cmdTag('u1'), '沒有命令標籤');
    assert.equal(cmdTag('u1').textContent, '/寫細綱', cmdTag('u1')?.textContent);
  });

  test('氣泡不再是一片空白', () => {
    assert.ok(ui.bodyOf('u1').textContent.trim().length > 0, JSON.stringify(ui.bodyOf('u1').textContent));
  });

  // 有補充要求時兩樣都在：命令一枚標籤，正文跟在後面。
  test('帶補充要求時命令與正文都顯示', () => {
    ui.post({ type: 'turnDone', turn: turn('u2', 'user', '這一章要慢一點', { command: '寫細綱' }) });
    assert.equal(cmdTag('u2').textContent, '/寫細綱');
    assert.equal(ui.bubble('u2').querySelector('.msg-text').textContent, '這一章要慢一點');
  });

  // 討論是預設動作，後端不給 command——每條訊息都掛一枚「/討論」是純噪聲。
  test('討論輪次不掛命令標籤', () => {
    ui.post({ type: 'turnDone', turn: turn('u3', 'user', '這裡衝突太弱') });
    assert.ok(!cmdTag('u3'));
    assert.equal(ui.bodyOf('u3').textContent, '這裡衝突太弱');
  });

  // 舊會話裡的空輪次（那時命令沒被記下來）：留一句說明，別留一片空白。
  test('既無話也無命令時給一句說明', () => {
    ui.post({ type: 'turnDone', turn: turn('u4', 'user', '') });
    assert.ok(ui.bubble('u4').querySelector('.msg-text-empty'), ui.bodyOf('u4')?.textContent);
  });

  // 模型回覆那一支必須保持成純文字節點：流式增量走 textContent += delta，
  // 裡面有子元素的話第一片增量就會把它們沖掉。
  test('模型回覆裡不插結構', () => {
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(ui.bodyOf('a1').children.length, 0, ui.bodyOf('a1').innerHTML);
    assert.equal(ui.bodyOf('a1').textContent, '第一段。');
    ui.post({ type: 'busy', value: false });
  });
});

/**
 * 流式輸出時訊息流會變高。只在原本貼著底時才跟著滾——翻上去看前面的
 * 氣泡不該被每來一段的 delta 拽回底部。
 *
 * jsdom 沒有佈局，scrollHeight / clientHeight 恆為 0，要自己裝一套尺寸。
 */
describe('流式輸出時滾動跟隨', { skip: JSDOM_SKIP }, () => {
  let ui;
  let box;
  const HEIGHT = 5000;
  const VIEW = 400;
  const BOTTOM = HEIGHT - VIEW;

  function layout(top) {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => VIEW });
    box.scrollTop = top;
  }

  function scrollTo(top) {
    box.scrollTop = top;
    box.dispatchEvent(new ui.window.Event('scroll'));
  }

  before(() => {
    ui = mount();
    box = ui.doc.getElementById('messages');
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '寫一段') });
    ui.post({ type: 'busy', value: true });
    ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
    layout(BOTTOM);
  });

  test('貼著底時 delta 跟著滾到底', () => {
    ui.post({ type: 'delta', turnId: 'a1', text: '第一段。' });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('翻上去之後 delta 不再拽回來', () => {
    scrollTo(200);
    ui.post({ type: 'delta', turnId: 'a1', text: '第二段。' });
    assert.equal(box.scrollTop, 200);
  });

  test('思考增量也不拽回來', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '我在想。' });
    assert.equal(box.scrollTop, 200);
  });

  test('再貼回底之後繼續跟隨', () => {
    scrollTo(BOTTOM);
    ui.post({ type: 'delta', turnId: 'a1', text: '第三段。' });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('切會話即使翻上去也滾到底', () => {
    scrollTo(200);
    ui.post({
      type: 'session',
      session: emptySession({ turns: [turn('u2', 'user', '另一段')] }),
    });
    assert.equal(box.scrollTop, HEIGHT);
  });

  test('傳送即使翻上去也滾到底', () => {
    ui.post({ type: 'busy', value: false });
    scrollTo(200);
    ui.doc.getElementById('input').value = '再說一句';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    assert.equal(box.scrollTop, HEIGHT);
  });
});

// ---------------------------------------------------------------------------

describe('思考深度下拉框', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    // 檔位選項在 renderState 裡建（跟模型下拉同一處），所以要先來一條 state。
    ui.post({ type: 'init', state: viewState() });
    ui.post({ type: 'session', session: emptySession() });
  });

  test('五個檔位都在，預設停在「不思考」', () => {
    const select = ui.doc.getElementById('thinkSelect');
    assert.deepEqual(
      [...select.options].map((o) => o.value),
      ['off', 'low', 'medium', 'high', 'max']
    );
    assert.equal(select.value, 'off');
  });

  // 它是會話的屬性，所以前端只發意圖，值等後端那條 session 訊息回填。
  test('換一檔發 setThinking，不自己改狀態', () => {
    const select = ui.doc.getElementById('thinkSelect');
    select.value = 'high';
    select.dispatchEvent(new ui.window.Event('change'));
    assert.equal(ui.last('setThinking').depth, 'high');
  });

  test('收到會話就回顯它那一檔（換會話不會串味）', () => {
    ui.post({ type: 'session', session: emptySession({ id: 's2', thinking: 'max' }) });
    assert.equal(ui.doc.getElementById('thinkSelect').value, 'max');
    ui.post({ type: 'session', session: emptySession({ id: 's3', thinking: 'off' }) });
    assert.equal(ui.doc.getElementById('thinkSelect').value, 'off');
  });
});
