/**
 * 編輯區「時間線總覽」標籤（`media/src/editor/timelineOverview.ts`，2026-10-24，設計稿 docs/design/plans/2026-10-24-timeline-page.md）。
 * 資料由後端推來（`timelineOverview`），這裡按訊息造；後端怎麼算在 tests/unit/views/timeline.test.js 與
 * tests/integration/views/timelineOverview.test.js。工程頁「時間線」組的入口在 tests/dom/view/threadsRow.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 能力探測 | 獨立版有人回答 `nf-timeline-query`；外掛的 webview（只有 view.js）沒有 |
 * | 標籤 | 一個不對應檔案的特殊標籤「時間線總覽」；要資料、先說在讀；和「敘事線總覽」各開各的 |
 * | 豎軸 | 月份分隔（帶季節）、一個日子一行（大字日子、小字第幾天）、空了 2 天以上插「N 天后」（照上一行最晚的結尾算） |
 * | 卡片 | 狀態點、章號章名、時段與比上一章、依據；事件收著最多 3 條（線名小標籤帶色塊）；沒事件給梗概；對賬紅字；回憶虛線 |
 * | 展開 | 單擊展開詳情與全部事件（帶原文），再點收起；選中 |
 * | 右鍵 | 卡片：改時間、重推、開啟正文 / 細綱 / 時間線檔案；標題欄：改曆法與起點、補推、重推、開啟檔案、重新整理（設定都在右鍵） |
 * | 對賬 | 一條一行；帶章號的點了展開那一章 |
 * | 篩選 | 只看有問題的、只看某條線；「N 天后」照留下的重算；定位過來的章被篩掉時放開篩選 |
 * | 定位 | `nf-timeline-command` 帶章號：展開、選中 |
 * | 資料 | 別人的 requestId 不認；顯示著收到 `state` 停一下再要；還不是工程、還沒有一章各說一句 |
 * | 工程頁入口 | 「時間線」組標題旁「總覽」、點一章、點帶章號的 ⚠ 開啟時間線總覽（展開那一章），不開正文、不開敘事線總覽；敘事線組的「總覽」不再因為有時間線才給 |
 */
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, viewState, sampleTree } = require('../../helpers/dom');

const TL = '.novelwarden/threads/时间线.md';

const ev = (thread, color, type, what, evidence, foreshadowing) => ({
  thread,
  color,
  type,
  ...(foreshadowing ? { foreshadowing } : {}),
  what,
  ...(evidence ? { evidence } : {}),
});

function card(no, extra = {}) {
  return {
    no,
    title: `章${no}`,
    state: 'evidence',
    when: '',
    note: '',
    events: [],
    issues: [],
    detail: [`第 ${no} 章 · 詳情`],
    problem: false,
    chapterPath: `chapters/00${no}.txt`,
    plotPath: `.novelwarden/summaries/00${no}.md`,
    machine: true,
    ...extra,
  };
}

/**
 * 四個日子：第 1 天（第 1、2 章）、第 6 天（第 3 章跨到第 8 天、第 4 章回憶）、第 9 天（第 5 章推不出）、第 40 天（第 6 章，下一個月）。
 * 第 3 章對賬報了；第 7–8 章同步過還沒推。
 */
function overview(extra = {}) {
  return {
    initialized: true,
    relPath: TL,
    exists: true,
    meta: '簡單歷 · 起點 大衍三年三月初七 · 推到第 6 章 · 故事第 40 天',
    tip: '簡單歷 · 起點 大衍三年三月初七（第 1 章那一天）\n右鍵改曆法與起點。',
    calendar: { name: '简单历', start: '大衍三年三月初七' },
    issues: [
      { text: '第 3 章：前面推下來是三月初八，正文寫三月十二（差 4 天），已按正文對齊', chapter: 3 },
      { text: '第 7–8 章還沒推：同步過，點標題旁的「補推時間」補上' },
    ],
    threads: [
      { name: '青崖舊案', color: 0 },
      { name: '黑市', color: 1 },
      { name: '林昭與沈青', color: 2 },
      { name: '未歸屬的伏筆', color: -1 },
    ],
    days: [
      {
        day: 1,
        label: '三月初七',
        sub: '第 1 天',
        full: '大衍三年三月初七',
        month: '大衍三年三月',
        season: '春',
        cards: [
          card(1, {
            when: '傍晚 → 深夜',
            note: '依據「連日大雨的第三天傍晚」',
            end: 1,
            events: [
              ev('青崖舊案', 0, '推进', '回到青崖', '雨下了三天'),
              ev('林昭與沈青', 2, '关系', '初遇', '劍停在喉前三寸'),
              ev('林昭與沈青', 2, '埋', '玉佩露面', '他摸了摸玉佩', '玉佩的來歷'),
              ev('未歸屬的伏筆', -1, '埋', '斷劍出土', '半截斷劍', '斷劍'),
            ],
          }),
          card(2, { state: 'guess', when: '深夜', delta: '同一天', note: '推測：緊接著', end: 1, synopsis: '客棧裡來了個女人。' }),
        ],
      },
      {
        day: 6,
        label: '三月十二',
        sub: '第 6 天',
        full: '大衍三年三月十二',
        month: '大衍三年三月',
        season: '春',
        cards: [
          card(3, { state: 'dated', when: '清晨 → 三月十四 夜裡 · 3 天', delta: '+5 天', note: '正文寫明三月十二', end: 8, issues: ['前面推下來是三月初八，正文寫三月十二（差 4 天），已按正文對齊'], problem: true }),
          card(4, { state: 'flashback', when: '回憶（約二十年前）', flashback: true }),
        ],
      },
      {
        day: 9,
        label: '三月十五',
        sub: '第 9 天',
        full: '大衍三年三月十五',
        month: '大衍三年三月',
        season: '春',
        cards: [card(5, { state: 'unknown', note: '推不出：沒交代', delta: '同一天', end: 9, problem: true })],
      },
      {
        day: 40,
        label: '四月十六',
        sub: '第 40 天',
        full: '大衍三年四月十六',
        month: '大衍三年四月',
        season: '夏',
        cards: [card(6, { state: 'anchor', note: '你定的', delta: '+31 天', end: 40, machine: false, events: [ev('黑市', 1, '推进', '進黑市')] })],
      },
    ],
    missing: { count: 2, text: '第 7–8 章還沒推出來' },
    machine: 4,
    last: 8,
    ...extra,
  };
}

function harness(opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['scrollIntoView', 'clipboard', ...(opts.shims ?? [])] });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  ui.post({ type: 'project', tree: opts.tree ?? sampleTree() });
  const { doc, window } = ui;
  const h = {
    ui,
    doc,
    window,
    toasts,
    specialTab: () => doc.querySelector('#edTabs .ed-tab-special[data-special="timeline-overview"]'),
    tlp: () => doc.querySelector('.wb-editor .ed-stage .tlp'),
    shown: () => !!h.tlp() && !h.tlp().classList.contains('hidden'),
    note: () => {
      const n = doc.querySelector('.tlp .tlp-note');
      return n && !n.classList.contains('hidden') ? n.textContent : '';
    },
    card: (no) => doc.querySelector(`.tlp-card[data-no="${no}"]`),
    cards: () => [...doc.querySelectorAll('.tlp-card')].map((c) => Number(c.dataset.no)),
    /** 豎軸上一行一項：月份、「N 天后」、日子（日子寫大字與卡片章號）。 */
    axis: () =>
      [...doc.querySelectorAll('.tlp-axis > *')].map((n) =>
        n.classList.contains('tlp-day')
          ? `${n.querySelector('.tlp-date').textContent}[${[...n.querySelectorAll('.tlp-card')].map((c) => c.dataset.no).join(',')}]`
          : n.textContent
      ),
    open(chapter) {
      window.dispatchEvent(new window.CustomEvent('nf-timeline-command', { detail: { name: 'open', ...(chapter !== undefined ? { chapter } : {}) } }));
    },
    respond(o = overview()) {
      const req = ui.last('requestTimelineOverview');
      assert.ok(req, '沒發 requestTimelineOverview');
      ui.post({ type: 'timelineOverview', requestId: req.requestId, overview: o });
    },
    count: (type) => ui.sent.filter((m) => m.type === type).length,
    sentAfter: (n) => JSON.parse(JSON.stringify(ui.sent.slice(n))),
  };
  return h;
}

describe('時間線總覽 · 能力探測與標籤', { skip: JSDOM_SKIP }, () => {
  test('獨立版有人回答 nf-timeline-query；外掛的 webview（只有 view.js）沒有', () => {
    const ask = (win) => {
      const detail = { available: false };
      win.dispatchEvent(new win.CustomEvent('nf-timeline-query', { detail }));
      return detail.available;
    };
    assert.equal(ask(harness().window), true);
    assert.equal(ask(mount().window), false);
  });

  test('開啟：主區一個不對應檔案的「時間線總覽」標籤；要資料、先說在讀；回來了畫出來', () => {
    const h = harness();
    h.open();
    assert.equal(h.specialTab()?.querySelector('.ed-tab-name').textContent, '時間線總覽');
    assert.ok(h.shown());
    assert.match(h.ui.last('requestTimelineOverview').requestId, /^timeline-/);
    assert.match(h.note(), /正在讀取時間線/);
    h.respond();
    assert.equal(h.note(), '');
    assert.equal(h.doc.querySelector('.tlp-meta').textContent, '簡單歷 · 起點 大衍三年三月初七 · 推到第 6 章 · 故事第 40 天');
    assert.match(h.doc.querySelector('.tlp-meta').title, /右鍵改曆法與起點/);
  });

  test('和「敘事線總覽」各開各的：兩個特殊標籤', () => {
    const h = harness();
    h.open();
    h.respond();
    h.ui.clickEl(h.doc.querySelector('#projectBody .threads-overview-btn'));
    assert.deepEqual(
      [...h.doc.querySelectorAll('#edTabs .ed-tab-special')].map((t) => t.dataset.special),
      ['timeline-overview', 'threads-overview']
    );
    assert.equal(h.shown(), false, '切到敘事線總覽，時間線總覽藏起來');
    h.ui.clickEl(h.specialTab());
    assert.ok(h.shown());
  });
});

describe('時間線總覽 · 豎軸與卡片', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  test('月份分隔帶季節；一個日子一行；空了 2 天以上插「N 天后」（照上一行最晚的結尾：第 3 章到第 8 天，第 9 天不插）', () => {
    assert.deepEqual(h.axis(), [
      '大衍三年三月 · 春',
      '三月初七[1,2]',
      '5 天后',
      '三月十二[3,4]',
      '三月十五[5]',
      '31 天后',
      '大衍三年四月 · 夏',
      '四月十六[6]',
    ]);
    const day = h.doc.querySelector('.tlp-day');
    assert.equal(day.querySelector('.tlp-sub').textContent, '第 1 天');
    assert.equal(day.querySelector('.tlp-when').title, '大衍三年三月初七');
  });

  test('卡片：狀態點、章號章名、時段與比上一章、依據；事件收著最多 3 條，線名小標籤帶色塊；還有幾條', () => {
    const c1 = h.card(1);
    assert.equal(c1.querySelector('.tlp-dot').textContent, '●');
    assert.equal(c1.querySelector('.tlp-card-title').textContent, '第 1 章 章1');
    assert.equal(c1.querySelector('.tlp-card-time').textContent, '傍晚 → 深夜');
    assert.equal(c1.querySelector('.tlp-card-note').textContent, '依據「連日大雨的第三天傍晚」');
    const events = [...c1.querySelectorAll('.tlp-event')];
    assert.deepEqual(
      events.map((e) => [e.querySelector('.tlp-chip').className, e.querySelector('.tlp-chip-name').textContent, e.querySelector('.tlp-event-what').textContent]),
      [
        ['tlp-chip tlp-c0', '青崖舊案', '回到青崖'],
        ['tlp-chip tlp-c2', '林昭與沈青', '關係：初遇'],
        ['tlp-chip tlp-c2', '林昭與沈青', '埋〈玉佩的來歷〉：玉佩露面'],
      ]
    );
    assert.equal(c1.querySelector('.tlp-more').textContent, '還有 1 條，點開看');
    assert.equal(c1.querySelector('.tlp-quote'), null, '收著時不帶原文');
    assert.equal(c1.querySelector('.tlp-detail'), null);
    // 第 2 章：推測、同一天；沒事件給梗概。
    const c2 = h.card(2);
    assert.equal(c2.querySelector('.tlp-dot').textContent, '○');
    assert.equal(c2.querySelector('.tlp-card-time').textContent, '深夜 · 同一天');
    assert.equal(c2.querySelector('.tlp-synopsis').textContent, '客棧裡來了個女人。');
  });

  test('對賬報了：紅邊與紅字；回憶：虛線框；推不出：狀態點 ?', () => {
    const c3 = h.card(3);
    assert.ok(c3.classList.contains('has-issue'));
    assert.equal(c3.querySelector('.tlp-card-issue').textContent, '⚠ 前面推下來是三月初八，正文寫三月十二（差 4 天），已按正文對齊');
    assert.ok(h.card(4).classList.contains('tlp-flashback'));
    assert.equal(h.card(4).querySelector('.tlp-dot').textContent, '↺');
    assert.equal(h.card(5).querySelector('.tlp-dot').textContent, '?');
  });

  test('單擊卡片：展開詳情與全部事件（帶原文），選中；再點收起', () => {
    h.ui.clickEl(h.card(1).querySelector('.tlp-card-title'));
    const c1 = h.card(1);
    assert.ok(c1.classList.contains('is-open') && c1.classList.contains('is-selected'));
    assert.equal(c1.querySelectorAll('.tlp-event').length, 4);
    assert.equal(c1.querySelector('.tlp-more'), null);
    assert.deepEqual([...c1.querySelectorAll('.tlp-quote')].map((e) => e.textContent), ['「雨下了三天」', '「劍停在喉前三寸」', '「他摸了摸玉佩」', '「半截斷劍」']);
    assert.equal(c1.querySelector('.tlp-detail').textContent, '第 1 章 · 詳情');
    // 點另一張：它選中，第 1 張還展開著、不再選中。
    h.ui.clickEl(h.card(2));
    assert.ok(h.card(2).classList.contains('is-selected'));
    assert.ok(!h.card(1).classList.contains('is-selected') && h.card(1).classList.contains('is-open'));
    h.ui.clickEl(h.card(1));
    assert.ok(!h.card(1).classList.contains('is-open'));
  });

  test('右鍵卡片：改時間、重推這一章、從這一章起重推、開啟正文 / 細綱 / 時間線檔案；發的是工程頁同一個動作', () => {
    const items = h.ui.itemsOf(h.ui.rightClick(h.card(3)));
    assert.deepEqual(items, ['改時間…', '重推這一章', '從這一章起重推（到第 8 章）', '開啟這一章', '開啟細綱', '開啟時間線檔案']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '改時間…');
    h.ui.pick(h.ui.rightClick(h.card(3)), '從這一章起重推（到第 8 章）');
    h.ui.pick(h.ui.rightClick(h.card(3)), '開啟這一章');
    h.ui.pick(h.ui.rightClick(h.card(3)), '開啟細綱');
    assert.deepEqual(h.sentAfter(n), [
      { type: 'projectAction', action: 'editTimeline', name: '3' },
      { type: 'projectAction', action: 'refreshTimeline', range: { from: 3, to: 8 } },
      { type: 'openChapter', plotRelPath: 'chapters/003.txt' },
      { type: 'openEditor', path: '.novelwarden/summaries/003.md', pane: 'main' },
    ]);
    // 你定的那一行（不是機器寫的）不給「重推這一章」。
    const mine = h.ui.itemsOf(h.ui.rightClick(h.card(6)));
    assert.ok(!mine.includes('重推這一章'), JSON.stringify(mine));
    h.ui.closeMenu();
  });

  test('右鍵標題欄：改曆法與起點、補推、重推、開啟時間線檔案、重新整理（設定都在這裡，標題欄上沒有按鈕）', () => {
    const items = h.ui.itemsOf(h.ui.rightClick(h.doc.querySelector('.tlp-head')));
    assert.deepEqual(items, ['改曆法與起點…', '從正文補推故事時間', '重推機器寫的 4 行…', '開啟時間線檔案', '重新整理']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '改曆法與起點…');
    h.ui.pick(h.ui.rightClick(h.doc.querySelector('.tlp-scroll')), '從正文補推故事時間');
    assert.deepEqual(h.sentAfter(n), [
      { type: 'projectAction', action: 'setTimelineStart' },
      { type: 'projectAction', action: 'backfillTimeline' },
    ]);
    assert.deepEqual([...h.doc.querySelectorAll('.tlp-head button')].map((b) => b.textContent), ['重新整理']);
  });

  test('沒填起點有建議：那條 ⚠ 右鍵有「改曆法與起點」「填為起點」', () => {
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(
      overview({
        calendar: { name: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章寫了「三月初七」' } },
        issues: [{ text: '沒填起點：第 2 章寫了「三月初七」，第 1 章是三月初五（右鍵填為起點）', start: true }],
      })
    );
    const issue = h.doc.querySelector('.tlp-issue');
    const items = h.ui.itemsOf(h.ui.rightClick(issue));
    assert.deepEqual(items.slice(0, 2), ['改曆法與起點…', '填為起點「三月初五」（第 2 章寫了「三月初七」）']);
    const n = h.ui.sent.length;
    h.ui.pick(h.doc.querySelector('.ctx-menu'), '填為起點「三月初五」（第 2 章寫了「三月初七」）');
    assert.deepEqual(h.sentAfter(n), [{ type: 'projectAction', action: 'setTimelineStart', name: '三月初五' }]);
  });

  test('對賬一條一行；帶章號的點了展開、選中那一章，不帶的點了不動', () => {
    const rows = [...h.doc.querySelectorAll('.tlp-issue')];
    assert.deepEqual(rows.map((r) => r.textContent), [
      '⚠ 第 3 章：前面推下來是三月初八，正文寫三月十二（差 4 天），已按正文對齊',
      '⚠ 第 7–8 章還沒推：同步過，點標題旁的「補推時間」補上',
    ]);
    h.ui.clickEl(rows[0]);
    assert.ok(h.card(3).classList.contains('is-open') && h.card(3).classList.contains('is-selected'));
    assert.ok(!rows[1].classList.contains('is-link'));
  });
});

describe('時間線總覽 · 篩選與定位', { skip: JSDOM_SKIP }, () => {
  let h;
  beforeEach(() => {
    h = harness();
    h.open();
    h.respond();
  });

  const setProblems = (on) => {
    const box = h.doc.querySelector('.tlp-filter input');
    box.checked = on;
    box.dispatchEvent(new h.window.Event('change'));
  };
  const setThread = (name) => {
    const select = h.doc.querySelector('.tlp-thread');
    select.value = name;
    select.dispatchEvent(new h.window.Event('change'));
  };

  test('「線」下拉：全部線 + 有事件的線', () => {
    assert.deepEqual([...h.doc.querySelectorAll('.tlp-thread option')].map((o) => o.textContent), ['全部線', '青崖舊案', '黑市', '林昭與沈青', '未歸屬的伏筆']);
  });

  test('只看有問題的：只留對賬報了與推不出的章；「N 天后」照留下的重算', () => {
    setProblems(true);
    assert.deepEqual(h.cards(), [3, 5]);
    assert.deepEqual(h.axis(), ['大衍三年三月 · 春', '三月十二[3]', '三月十五[5]']);
    setProblems(false);
    assert.deepEqual(h.cards(), [1, 2, 3, 4, 5, 6]);
  });

  test('只看某條線：只留在那條線上有事的章；什麼都不剩說一句', () => {
    setThread('黑市');
    assert.deepEqual(h.cards(), [6]);
    assert.deepEqual(h.axis(), ['大衍三年四月 · 夏', '四月十六[6]']);
    setProblems(true);
    assert.deepEqual(h.cards(), []);
    assert.equal(h.note(), '沒有符合篩選的章。');
  });

  test('從工程頁定位過來（帶章號）：展開、選中；被篩選藏起來的放開篩選', () => {
    setThread('黑市');
    h.open(2);
    assert.deepEqual(h.cards(), [1, 2, 3, 4, 5, 6]);
    assert.equal(h.doc.querySelector('.tlp-thread').value, '');
    assert.ok(h.card(2).classList.contains('is-open') && h.card(2).classList.contains('is-selected'));
  });
});

describe('時間線總覽 · 資料', { skip: JSDOM_SKIP }, () => {
  test('別人的 requestId 不認', () => {
    const h = harness();
    h.open();
    h.ui.post({ type: 'timelineOverview', requestId: 'timeline-not-mine', overview: overview() });
    assert.match(h.note(), /正在讀取/);
  });

  test('顯示著收到 state：停一下再要一次（連著兩條只要一次）', () => {
    const h = harness({ shims: ['fakeTimers'] });
    h.open();
    h.respond();
    const n = h.count('requestTimelineOverview');
    h.ui.post({ type: 'state', state: viewState() });
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.count('requestTimelineOverview'), n);
    h.window.__clock.tick(700);
    assert.equal(h.count('requestTimelineOverview'), n + 1);
  });

  test('還不是小說工程、還沒有一章（有要補推的說怎麼補）各說一句', () => {
    const h = harness();
    h.open();
    h.respond({ ...overview(), initialized: false });
    assert.match(h.note(), /還不是小說工程/);
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(overview({ days: [], issues: [] }));
    assert.match(h.note(), /^時間線裡還沒有一章。第 7–8 章還沒推出來：右鍵這裡「從正文補推故事時間」/);
    h.ui.clickEl(h.doc.querySelector('.tlp-refresh'));
    h.respond(overview({ days: [], issues: [], missing: undefined, exists: false }));
    assert.equal(h.note(), '時間線裡還沒有一章。同步一章就會推它的故事時間。');
  });

  test('換工程：標籤關掉', () => {
    const h = harness();
    h.open();
    h.respond();
    h.window.dispatchEvent(new h.window.Event('nf-workspace-reset'));
    assert.equal(h.specialTab(), null);
  });
});

describe('時間線總覽 · 工程頁入口', { skip: JSDOM_SKIP }, () => {
  const chapter = (no) => ({ no, title: `章${no}`, chapterPath: `chapters/00${no}.txt`, state: 'evidence', when: '三月初七', note: '', tip: '', value: '+0 天', machine: true });
  const withTimeline = (threads = {}) => {
    const tree = sampleTree();
    return {
      ...tree,
      threads: {
        ...tree.threads,
        ...threads,
        timeline: {
          relPath: TL,
          exists: true,
          label: '推到第 3 章 · 故事第 2 天',
          calendar: { text: '簡單歷 · 起點 三月初七（第 1 章那一天）', tip: '右鍵改曆法與起點。', calendarName: '简单历', start: '三月初七' },
          issues: [{ text: '第 3 章：往回跳了', chapter: 3 }],
          segments: [{ key: 'timeline:三月', label: '三月', detail: '', chapters: [chapter(1), chapter(2), chapter(3)] }],
          machine: 3,
          last: 3,
        },
      },
    };
  };
  const tlGroup = (h) => h.doc.querySelector('#projectBody [data-group="timeline"]');
  const chapterLabel = (h, no) => tlGroup(h).querySelector(`.row-time-chapter[data-chapter="${no}"] .row-label`);

  test('「時間線」組標題旁「總覽」開啟時間線總覽（不是敘事線總覽）；組標題右鍵有「開啟時間線總覽」', () => {
    const h = harness({ tree: withTimeline() });
    const btn = tlGroup(h).querySelector('.timeline-overview-btn');
    assert.equal(btn?.textContent, '總覽');
    h.ui.clickEl(btn);
    assert.ok(h.specialTab() && h.shown());
    assert.equal(h.doc.querySelector('#edTabs .ed-tab-special[data-special="threads-overview"]'), null);
    const items = h.ui.itemsOf(h.ui.rightClick(tlGroup(h).querySelector('.group-head')));
    assert.ok(items.includes('開啟時間線總覽'), JSON.stringify(items));
    h.ui.closeMenu();
  });

  test('點一章：開啟時間線總覽、展開選中那一章；不發 openFile（不開正文）', () => {
    const h = harness({ tree: withTimeline() });
    const n = h.ui.sent.length;
    h.ui.clickEl(chapterLabel(h, 2));
    assert.ok(!h.sentAfter(n).some((m) => m.type === 'openFile' || m.type === 'openEditor'), JSON.stringify(h.sentAfter(n)));
    assert.ok(h.shown());
    h.respond();
    assert.ok(h.card(2).classList.contains('is-open') && h.card(2).classList.contains('is-selected'));
  });

  test('點帶章號的 ⚠：開啟時間線總覽、展開那一章', () => {
    const h = harness({ tree: withTimeline() });
    h.ui.clickEl(tlGroup(h).querySelector('.timeline-issue'));
    h.respond();
    assert.ok(h.card(3).classList.contains('is-open'));
  });

  test('敘事線組的「總覽」只看有沒有線與未歸屬的伏筆，不再因為有時間線才給', () => {
    const h = harness({ tree: withTimeline({ lines: [], unfiled: undefined }) });
    const threadsGroup = h.doc.querySelector('#projectBody [data-group="threads"]');
    assert.equal(threadsGroup.querySelector('.threads-overview-btn'), null);
    assert.ok(tlGroup(h).querySelector('.timeline-overview-btn'));
  });
});
