/**
 * 進度顯示：工程頁的定稿進度橫幅（寫了正文的章有幾章定稿過、細綱與正文對得上），以及長任務進度條。
 *
 * 遷自 scripts/smoke-view.js 的這兩節（當時叫「摘要進度」；單章摘要並進細綱之後，
 * 「總結過」就是「定稿過」）：
 *   == 摘要進度顯示 ==（1437） == 長任務進度條 ==（1475）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree, viewState } = require('../../helpers/dom');

describe('定稿進度顯示', { skip: JSDOM_SKIP }, () => {
  let ui;
  const banner = () => ui.doc.querySelector('#projectBody .banner-summary');
  const groupMeta = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((h) => h.textContent.includes(name))
      ?.querySelector('.meta')?.textContent ?? '';

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('有沒定稿的章時出現進度橫幅', () => {
    assert.ok(banner());
  });

  // 「定稿之後正文又改過」也算：那一章的細綱已經跟不上正文了。
  test('橫幅說明有幾章沒定稿', () => {
    assert.ok(banner().textContent.includes('1 章寫了正文還沒同步（或同步之後正文又改過）'), banner().textContent);
  });

  test('橫幅給出已完成／總數', () => {
    assert.ok(banner().textContent.includes('已同步 2 / 3 章'), banner().textContent);
  });

  test('橫幅給出百分比', () => {
    assert.ok(banner().textContent.includes('67%'), banner().textContent);
  });

  test('橫幅有進度條', () => {
    assert.ok(banner().querySelector('.sum-fill'));
  });

  test('進度條按比例填充', () => {
    assert.equal(banner().querySelector('.sum-fill').style.width, '67%',
      banner().querySelector('.sum-fill').style.width);
  });

  test('沒有任務時仍能點「立即同步」', () => {
    assert.ok([...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));
  });

  test('分組副標題帶進度', () => {
    assert.ok(groupMeta('文風與摘要').includes('已同步 2/3 章 · 1 章待同步'), groupMeta('文風與摘要'));
  });

  // 同步跑起來後，重複點只會撞上「已有任務」，所以按鈕撤掉。
  test('同步進行中不再顯示「立即同步」', () => {
    ui.post({
      type: 'tasks',
      tasks: [{ id: 't1', title: '同步章節細綱', message: '第 3 章', current: 0, total: 1, elapsedMs: 0 }],
    });
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(![...banner().querySelectorAll('button')].some((b) => b.textContent === '立即同步'));
  });

  // 全部同步完就不該再有橫幅。
  test('全部同步後橫幅消失', () => {
    ui.post({ type: 'tasks', tasks: [] });
    ui.post({ type: 'project', tree: { ...sampleTree(), staleCount: 0, summarizedCount: 3 } });
    assert.ok(!banner());
  });

  test('分組副標題改為已全部定稿', () => {
    assert.ok(groupMeta('文風與摘要').includes('3 章已全部同步'), groupMeta('文風與摘要'));
  });
});

/**
 * 沒定稿的提示只長在工程頁。
 *
 * 對話頁從前也掛著一份純文字橫幅（`#staleBanner`），說的是同一句話，卻常年
 * 佔著訊息流本就不寬裕的寬度；要處理這件事也只能去工程頁。切走時由活動欄
 * 「工程」上的小圓點留記號。
 */
describe('沒定稿的提示只在工程頁', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount({ body: 'standalone' });
    ui.post({ type: 'state', state: viewState({ staleCount: 3 }) });
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('對話頁裡沒有橫幅', () => {
    assert.equal(ui.doc.querySelector('#pane-chat .banner'), null);
  });

  test('工程頁裡有橫幅', () => {
    assert.ok(ui.doc.querySelector('#pane-project .banner-summary'));
  });

  test('活動欄「工程」上的小圓點亮著', () => {
    assert.ok(!ui.doc.getElementById('projectStaleDot').classList.contains('hidden'));
  });

  test('全部同步後小圓點滅掉', () => {
    ui.post({ type: 'state', state: viewState({ staleCount: 0 }) });
    assert.ok(ui.doc.getElementById('projectStaleDot').classList.contains('hidden'));
  });
});

describe('長任務進度條', { skip: JSDOM_SKIP }, () => {
  let ui;
  const taskList = () => ui.doc.getElementById('taskList');
  const rows = () => [...taskList().querySelectorAll('.task')];
  const textOf = (i) => rows()[i].textContent;

  before(() => {
    ui = mount();
  });

  test('沒有任務時整塊隱藏', () => {
    assert.ok(taskList().classList.contains('hidden'));
  });

  test('有任務時露出來', () => {
    ui.post({
      type: 'tasks',
      tasks: [{ id: 't1', title: '同步章節細綱', message: '第 12 章《夜訪》', current: 11, total: 76, elapsedMs: 65000 }],
    });
    assert.ok(!taskList().classList.contains('hidden'));
  });

  test('渲染出一行', () => {
    assert.equal(rows().length, 1, `${rows().length}`);
  });

  test('顯示標題', () => {
    assert.ok(textOf(0).includes('同步章節細綱'), textOf(0));
  });

  test('顯示當前在做什麼', () => {
    assert.ok(textOf(0).includes('第 12 章《夜訪》'), textOf(0));
  });

  test('顯示 n/N 與百分比', () => {
    assert.ok(textOf(0).includes('11/76') && textOf(0).includes('14%'), textOf(0));
  });

  test('顯示已用時（分:秒）', () => {
    assert.ok(textOf(0).includes('1:05'), textOf(0));
  });

  test('進度條按比例填充', () => {
    assert.equal(rows()[0].querySelector('.task-fill').style.width, '14%',
      rows()[0].querySelector('.task-fill').style.width);
  });

  // 點「停止」要把任務 id 發回後端。
  test('點停止發出 cancelTask', () => {
    ui.sent.length = 0;
    ui.clickEl([...rows()[0].querySelectorAll('button')].find((b) => b.textContent === '停止'));
    assert.ok(ui.sent.some((m) => m.type === 'cancelTask' && m.id === 't1'), JSON.stringify(ui.sent));
  });

  // 不知道總量時走不定量條，不顯示假的百分比。
  test('無 total 時用不定量條', () => {
    ui.post({ type: 'tasks', tasks: [{ id: 't2', title: '提取文風指南', message: '分析中', elapsedMs: 3000 }] });
    assert.ok(rows()[0].querySelector('.task-bar').classList.contains('indeterminate'));
  });

  test('無 total 時不顯示百分比', () => {
    assert.ok(!textOf(0).includes('%'), textOf(0));
  });

  // 多個任務並存。
  test('兩個任務都渲染', () => {
    ui.post({
      type: 'tasks',
      tasks: [
        { id: 't3', title: '甲', message: '一', current: 1, total: 2, elapsedMs: 0 },
        { id: 't4', title: '乙', message: '二', current: 0, total: 5, elapsedMs: 0 },
      ],
    });
    assert.equal(rows().length, 2, `${rows().length}`);
  });

  test('任務結束後整塊收起', () => {
    ui.post({ type: 'tasks', tasks: [] });
    assert.ok(taskList().classList.contains('hidden'));
  });

  test('任務結束後行清空', () => {
    assert.equal(rows().length, 0, `${rows().length}`);
  });
});

/**
 * 頁頭任務條（四期，W8、D24）：所有頁籤都看得見；批次寫章能「寫完這一章就停」；
 * 做完了給一條帶「開啟第 N 章」的提示。
 */
describe('頁頭任務條 · 所有頁籤都看得見', { skip: JSDOM_SKIP }, () => {
  let ui;
  const taskList = () => ui.doc.getElementById('taskList');
  const buttons = () => [...taskList().querySelectorAll('button')];

  before(() => {
    ui = mount();
    ui.post({
      type: 'tasks',
      tasks: [{ id: 'b1', title: '批次寫章', message: '第 2 章《令牌》 · 續寫第 1 輪 · 已寫 1860 / 3000 字', current: 1, total: 3, elapsedMs: 5000, pausable: true, stopping: false }],
    });
  });

  // 從前長在工程頁裡，從對話頁點的定稿、批次跑起來之後在對話頁上什麼都看不見。
  test('不在工程頁裡：對話頁開著也看得見', () => {
    assert.equal(taskList().closest('#pane-project'), null);
    assert.ok(ui.doc.getElementById('pane-chat').classList.contains('active'));
    assert.ok(!taskList().classList.contains('hidden'));
  });

  test('寫著當前章、當前步驟、第幾章 / 共幾章', () => {
    assert.ok(taskList().textContent.includes('續寫第 1 輪 · 已寫 1860 / 3000 字'), taskList().textContent);
    assert.ok(taskList().textContent.includes('1/3'), taskList().textContent);
  });

  test('能停在章與章之間的任務多一顆「寫完這一章就停」，點了發 stopAfterItem', () => {
    const pause = buttons().find((b) => b.textContent === '寫完這一章就停');
    assert.ok(pause, taskList().innerHTML);
    ui.sent.length = 0;
    ui.clickEl(pause);
    assert.ok(ui.sent.some((m) => m.type === 'stopAfterItem' && m.id === 'b1'), JSON.stringify(ui.sent));
  });

  test('點過之後換成一句說明，不能再點', () => {
    ui.post({ type: 'tasks', tasks: [{ id: 'b1', title: '批次寫章', message: '…', current: 1, total: 3, elapsedMs: 6000, pausable: true, stopping: true }] });
    assert.ok(!buttons().some((b) => b.textContent === '寫完這一章就停'));
    assert.ok(taskList().querySelector('.task-stopping'));
    assert.ok(buttons().some((b) => b.textContent === '停止'));
  });

  test('不能停在中間的任務沒有這一顆', () => {
    ui.post({ type: 'tasks', tasks: [{ id: 's1', title: '同步第 3 章', message: '《夜訪》 · 細綱', current: 0, total: 3, elapsedMs: 0 }] });
    assert.ok(!buttons().some((b) => b.textContent === '寫完這一章就停'));
  });

  test('做完了：提示帶「開啟第 3 章」，點了開啟那一章', () => {
    ui.post({
      type: 'taskDone',
      title: '批次寫章',
      message: '第 1–3 章已寫好（呼叫 3 次）。',
      level: 'info',
      open: { plotRelPath: '.novelwarden/summaries/003-夜訪.md', label: '開啟第 3 章' },
    });
    const toast = ui.doc.getElementById('toast');
    assert.ok(!toast.classList.contains('hidden'));
    assert.ok(toast.textContent.includes('第 1–3 章已寫好'), toast.textContent);
    const btn = toast.querySelector('.toast-action');
    assert.equal(btn?.textContent, '開啟第 3 章');
    ui.sent.length = 0;
    ui.clickEl(btn);
    assert.ok(ui.sent.some((m) => m.type === 'openChapter' && m.plotRelPath === '.novelwarden/summaries/003-夜訪.md'), JSON.stringify(ui.sent));
    assert.ok(toast.classList.contains('hidden'));
  });

  test('沒帶按鈕的只是一句話', () => {
    ui.post({ type: 'taskDone', title: '同步第 3 章', message: '第 3 章已同步。', level: 'info' });
    assert.equal(ui.doc.getElementById('toast').querySelector('.toast-action'), null);
  });

  // 五期補遺 §4：批次寫完即審稿的完成提示，按鈕開啟那個「批次審稿」會話。
  test('完成提示帶「開啟審稿報告」：點了開那個會話', () => {
    ui.post({
      type: 'taskDone',
      title: '批次寫章',
      message: '第 1–3 章已寫好。審稿：第 1 章 1 嚴重 · 0 建議。',
      level: 'info',
      open: { sessionId: 's-review', label: '開啟審稿報告' },
    });
    const btn = ui.doc.getElementById('toast').querySelector('.toast-action');
    assert.equal(btn?.textContent, '開啟審稿報告');
    ui.sent.length = 0;
    ui.clickEl(btn);
    assert.ok(ui.sent.some((m) => m.type === 'openSession' && m.id === 's-review'), JSON.stringify(ui.sent));
  });

  // 收尾：任務條還開著時每秒走一次計時，不收掉的話這個測試檔案跑完程序也不退。
  test('任務都結束了，任務條收起', () => {
    ui.post({ type: 'tasks', tasks: [] });
    assert.ok(taskList().classList.contains('hidden'));
  });
});
