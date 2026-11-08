/**
 * 工程頁「敘事線」頁籤（敘事線重做第 8 個提交）：一條線一行，最後一行是「未歸屬的伏筆」。一行的說法由後端給
 * （`views/threads.ts`，後端那一半在 tests/unit/views/threads.test.js），這裡釘前端怎麼擺、怎麼點。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 第五個頁籤，排在「設定」後面；「文風與摘要」裡那一行計數沒了 | 章節、角色、設定各佔一頁，敘事線同一個思路 |
 * | 一條線一行，照後端排好的順序；名字 · 種類 · 狀態 · 最近第 N 章 · 幾條伏筆沒收，⚠ 另起一格 | 一眼看出各條線走到哪、哪條要管 |
 * | 最後一行是「未歸屬的伏筆 · N 條」；沒有就不畫 | 掛不上線的伏筆有個地方看 |
 * | 點一行開啟那條線的檔案，右鍵「開啟」，沒有刪除 / 改名 | 一條線就是一份 Markdown，作者直接改 |
 * | 右鍵「標為收束…」「標為放棄…」發 closeThread / abandonThread（帶線的檔案）：進行中兩樣都有，計劃中只有放棄，收束了的都沒有 | 同步漏報了收束的線由作者補一筆（2026-10-24）；後端先問 |
 * | 當前進度作者改過的黃 ❗ 掛在那一行；排線失敗的紅 ❗ 掛在標題旁 | 失敗留在出錯的東西身上（第 16 條） |
 * | 標題旁「從大綱排出 / 從大綱補充」發 generateThreads、不折疊這一組；沒有情節大綱不給 | 按鈕不直接花錢，後端先彈確認框 |
 * | 一條線都沒有時說清先做什麼 | 空頁籤不該只剩一個標題 |
 * | 敘事線落後於定稿（四期）：最上面一句「⚠ 第 a–b 章還沒判」；標題旁與右鍵「從正文補記」發 backfillThreads，補記在跑時不給 | 拆進來的書、補記停在半路的書一眼看出差多少、從哪補 |
 * | 時間線單獨一組排在敘事線前面：對賬、按月分段（最後一段展開）、一章一行；右鍵改時間與重推；標題旁補推、重推 | 2026-10-24 重做：作者要它獨立成組，能改能重推 |
 * | 時間線組沒有「曆法與起點」那一行：在組標題的懸停裡，改走右鍵（起點建議那條 ⚠ 右鍵「填為起點」）；外掛形態點一章、點 ⚠ 開啟時間線檔案，不開正文 | 同日時間線總覽：作者嫌點了就彈設定、點章開正文反人類（獨立版開啟時間線總覽，見 tests/dom/standalone/timelineOverview.test.js） |
 * | 「故事架構」組仍是 x/6 | 敘事線是可選的，不擋路 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('工程頁 · 敘事線頁籤', { skip: JSDOM_SKIP }, () => {
  let ui;
  const panel = () => ui.doc.querySelector('#projectBody [data-project-panel="threads"]');
  const group = () => panel().querySelector('.group');
  const rows = () => [...panel().querySelectorAll('.row')];
  const rowOf = (name) => rows().find((n) => n.querySelector('.row-label')?.textContent === name);
  const labels = () => rows().map((n) => n.querySelector('.row-label').textContent);
  const headBtn = () => group().querySelector('.group-head .threads-head button');
  const warningsOf = (row) => [...row.querySelectorAll('.thread-warn')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('第五個頁籤「敘事線」，排在「設定」後面；頁裡只有「敘事線」一組', () => {
    const tabs = [...ui.doc.querySelectorAll('#projectTabs [data-project-tab]')].map((b) => b.textContent);
    assert.deepEqual(tabs, ['概覽', '章節', '角色', '設定', '敘事線']);
    assert.deepEqual([...panel().querySelectorAll('.group-name')].map((n) => n.textContent), ['敘事線']);
  });

  test('「文風與摘要」裡不再有敘事線那一行', () => {
    const overview = ui.doc.querySelector('#projectBody [data-project-panel="overview"]');
    const meta = [...overview.querySelectorAll('.group')].find((g) => g.querySelector('.group-name')?.textContent === '文風與摘要');
    assert.ok(![...meta.querySelectorAll('.row-label')].some((n) => n.textContent === '敘事線'));
  });

  test('一條線一行，照後端排好的順序；最後一行是「未歸屬的伏筆」', () => {
    assert.deepEqual(labels(), ['青崖舊案', '林昭與沈氏', '李叔的舊賬', '守衛的選擇', '未歸屬的伏筆']);
  });

  test('一行：種類 · 狀態 · 最近第 N 章 · 幾條伏筆沒收', () => {
    const row = rowOf('青崖舊案');
    assert.equal(row.querySelector('.row-detail').textContent, '主線 · 進行中 · 最近第 3 章 · 1 條伏筆沒收');
    assert.deepEqual(warningsOf(row), []);
    assert.equal(row.querySelector('.dot').textContent, '●');
  });

  test('有問題的另起幾格 ⚠', () => {
    assert.deepEqual(warningsOf(rowOf('林昭與沈氏')), ['⚠ 1 條伏筆逾期', '⚠ 過了計劃收束的第 2 章']);
  });

  test('還沒推進過的寫計劃區間、空心點；收束了的打勾、壓暗', () => {
    assert.equal(rowOf('李叔的舊賬').querySelector('.row-detail').textContent, '支線 · 計劃中 · 計劃第 6–12 章');
    assert.equal(rowOf('李叔的舊賬').querySelector('.dot').textContent, '○');
    assert.equal(rowOf('守衛的選擇').querySelector('.dot').textContent, '✓');
    assert.ok(rowOf('守衛的選擇').classList.contains('row-thread-closed'));
    assert.ok(!rowOf('青崖舊案').classList.contains('row-thread-closed'));
  });

  test('「未歸屬的伏筆 · 2 條」', () => {
    assert.equal(rowOf('未歸屬的伏筆').querySelector('.row-detail').textContent, '2 條');
  });

  test('懸停名字看意圖與當前進度', () => {
    const title = rowOf('青崖舊案').querySelector('.row-label').title;
    assert.ok(title.includes('意圖：查清七年前那場火') && title.includes('.novelwarden/threads/青崖舊案.md'), title);
  });

  test('點一行開啟那條線的檔案', () => {
    ui.sent.length = 0;
    ui.clickEl(rowOf('林昭與沈氏').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelwarden/threads/林昭與沈氏.md', JSON.stringify(ui.sent));
    ui.clickEl(rowOf('未歸屬的伏筆').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelwarden/threads/未归属的伏笔.md', JSON.stringify(ui.sent));
  });

  test('右鍵「開啟」，沒有刪除 / 改名 / 移動', () => {
    const items = ui.itemsOf(ui.rightClick(rowOf('青崖舊案')));
    assert.ok(items.includes('開啟'), JSON.stringify(items));
    assert.ok(!items.some((x) => /刪除|重新命名|移動/.test(x)), JSON.stringify(items));
    ui.closeMenu();
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('青崖舊案')), '開啟');
    assert.equal(ui.last('openFile')?.path, '.novelwarden/threads/青崖舊案.md', JSON.stringify(ui.sent));
  });

  test('右鍵「標為收束…」「標為放棄…」：進行中兩樣都有，計劃中只有放棄，收束了的都沒有', () => {
    const itemsOf = (name) => {
      const items = ui.itemsOf(ui.rightClick(rowOf(name)));
      ui.closeMenu();
      return items.filter((x) => x.startsWith('標為'));
    };
    assert.deepEqual(itemsOf('青崖舊案'), ['標為收束…', '標為放棄…']);
    assert.deepEqual(itemsOf('李叔的舊賬'), ['標為放棄…']);
    assert.deepEqual(itemsOf('守衛的選擇'), []);
    assert.deepEqual(itemsOf('未歸屬的伏筆'), []);
    ui.sent.length = 0;
    ui.pick(ui.rightClick(rowOf('青崖舊案')), '標為收束…');
    assert.deepEqual(
      { action: ui.last('projectAction')?.action, relPath: ui.last('projectAction')?.relPath },
      { action: 'closeThread', relPath: '.novelwarden/threads/青崖舊案.md' }
    );
    ui.pick(ui.rightClick(rowOf('李叔的舊賬')), '標為放棄…');
    assert.equal(ui.last('projectAction')?.action, 'abandonThread');
  });

  test('組標題：幾條 · 幾條進行中', () => {
    assert.equal(group().querySelector('.group-head .meta').textContent, '4 條 · 2 條進行中');
  });

  test('標題旁「從大綱補充」發 generateThreads，不折疊這一組', () => {
    assert.equal(headBtn()?.textContent, '從大綱補充');
    ui.sent.length = 0;
    ui.clickEl(headBtn());
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    assert.equal(labels().length, 5, '點按鈕把組折起來了');
  });

  test('標題與頁裡空白處右鍵「從大綱補充敘事線」', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(group().querySelector('.group-head')), '從大綱補充敘事線');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
    ui.sent.length = 0;
    ui.pick(ui.rightClick(panel()), '從大綱補充敘事線');
    assert.equal(ui.last('projectAction')?.action, 'generateThreads', JSON.stringify(ui.sent));
  });

  test('當前進度作者改過的黃 ❗ 掛在那一行；排線失敗的紅 ❗ 掛在標題旁', () => {
    const tree = sampleTree();
    tree.failures = {
      '.novelwarden/threads/林昭與沈氏.md': [
        { at: '2026-10-20T00:00:00Z', severity: 'warn', op: 'threadProgress', message: '第 3 章給出了新的「當前進度」，這一節你改過，沒有覆蓋' },
      ],
      '.novelwarden/threads': [{ at: '2026-10-20T00:00:00Z', severity: 'error', op: 'threads', message: '排敘事線失敗：超時' }],
    };
    ui.post({ type: 'project', tree });
    assert.ok(rowOf('林昭與沈氏').querySelector('.row-failure.is-warn'));
    assert.equal(rowOf('青崖舊案').querySelector('.row-failure'), null);
    const mark = group().querySelector('.group-head .threads-head .row-failure.is-error');
    assert.ok(mark, group().querySelector('.group-head').outerHTML);
    assert.equal(mark.dataset.failureKey, '.novelwarden/threads');
  });

  test('一條線都沒有：「從大綱排出」，空行說清點哪裡；沒有「未歸屬的伏筆」就不畫', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), threads: { lines: [], current: 0 } } });
    assert.equal(headBtn()?.textContent, '從大綱排出');
    assert.equal(group().querySelector('.group-head .meta').textContent, '還沒有');
    assert.deepEqual(labels(), []);
    assert.match(panel().querySelector('.row-empty').textContent, /點標題旁的「從大綱排出」/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(items.includes('從大綱排出敘事線'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('還沒有情節大綱：不給按鈕，空行說清先排大綱；右鍵也沒有排線', () => {
    const tree = sampleTree();
    ui.post({
      type: 'project',
      tree: {
        ...tree,
        architecture: tree.architecture.map((a) => (a.key === 'outline' ? { ...a, filled: false } : a)),
        threads: { lines: [], current: 0 },
      },
    });
    assert.equal(headBtn(), null);
    assert.match(panel().querySelector('.row-empty').textContent, /先排出情節大綱/);
    const items = ui.itemsOf(ui.rightClick(panel()));
    assert.ok(!items.some((x) => x.includes('敘事線')), JSON.stringify(items));
    ui.closeMenu();
  });

  // 四期：定稿了、敘事線還沒判的章。
  describe('敘事線落後於定稿', () => {
    const lagged = () => {
      const tree = sampleTree();
      return { ...tree, threads: { ...tree.threads, current: 60, through: 30, lag: { count: 30, text: '第 31–60 章還沒判' } } };
    };
    const backfillBtn = () => group().querySelector('.group-head .threads-head .threads-backfill-btn');

    test('頁裡最上面一句「⚠ 第 31–60 章還沒判」，說清狀態按判到的那一章算；線照樣一條一行', () => {
      ui.post({ type: 'project', tree: lagged() });
      const lag = panel().querySelector('.threads-lag');
      assert.ok(lag, panel().innerHTML.slice(0, 500));
      assert.match(lag.textContent, /^⚠ 第 31–60 章還沒判：這幾章同步了，敘事線還沒記上。線斷了幾章、伏筆逾期都按判到的第 30 章算/);
      assert.ok(lag.textContent.includes('「從正文補記」'), lag.textContent);
      assert.equal(panel().querySelector('.group-body').firstElementChild, lag);
      assert.equal(labels().length, 5);
    });

    test('標題旁「從正文補記」發 backfillThreads，排在「從大綱補充」前面、不折疊這一組；右鍵標題與空白處也有', () => {
      ui.post({ type: 'project', tree: lagged() });
      assert.equal(backfillBtn()?.textContent, '從正文補記');
      assert.equal(headBtn(), backfillBtn());
      ui.sent.length = 0;
      ui.clickEl(backfillBtn());
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
      assert.equal(labels().length, 5, '點按鈕把組折起來了');
      ui.sent.length = 0;
      ui.pick(ui.rightClick(group().querySelector('.group-head')), '從已寫正文補記敘事線');
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
      ui.sent.length = 0;
      ui.pick(ui.rightClick(panel()), '從已寫正文補記敘事線');
      assert.equal(ui.last('projectAction')?.action, 'backfillThreads', JSON.stringify(ui.sent));
    });

    test('補記在跑：不給按鈕（點第二次只會撞上已有任務）', () => {
      ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '從已寫正文補記敘事線', message: '第 31 章', current: 0, total: 30, elapsedMs: 0 }] });
      ui.post({ type: 'project', tree: lagged() });
      assert.equal(backfillBtn(), null);
      ui.post({ type: 'tasks', tasks: [] });
    });

    test('不落後：沒有那一句，也沒有「從正文補記」', () => {
      ui.post({ type: 'project', tree: sampleTree() });
      assert.equal(panel().querySelector('.threads-lag'), null);
      assert.equal(backfillBtn(), null);
      const items = ui.itemsOf(ui.rightClick(panel()));
      assert.ok(!items.includes('從已寫正文補記敘事線'), JSON.stringify(items));
      ui.closeMenu();
    });
  });

  // 故事時間（2026-10-24；同日重做成敘事線頁籤裡單獨一組，設計稿 2026-10-24-story-timeline-rework.md「五」；同日時間線總覽，
  // docs/design/plans/2026-10-24-timeline-page.md「二」）。這裡是外掛形態（只有 view.js，沒有時間線總覽）。
  describe('時間線一組', () => {
    const TL = '.novelwarden/threads/时间线.md';
    const chapter = (no, patch = {}) => ({
      no,
      title: `第${no}章`,
      chapterPath: `chapters/0${no}.md`,
      state: 'evidence',
      when: `三月十${no} 清晨`,
      delta: '+1 天',
      note: '依據「次日」',
      tip: `第 ${no} 章 · 三月十${no} 清晨`,
      value: '+1 天',
      machine: true,
      ...patch,
    });
    const withTimeline = (patch = {}) => {
      const tree = sampleTree();
      return {
        ...tree,
        threads: {
          ...tree.threads,
          timeline: {
            relPath: TL,
            exists: true,
            label: '推到第 5 章 · 故事第 12 天（三月十八 夜裡）',
            calendar: { text: '簡單歷 · 起點 三月初七（第 1 章那一天）', tip: '右鍵改曆法與起點。', calendarName: '简单历', start: '三月初七' },
            issues: [{ text: '第 4 章：前面推下來是三月十一，正文寫三月十四（差 3 天），已按正文對齊', chapter: 4 }],
            segments: [
              { key: 'timeline:二月', label: '二月', detail: '第 1–2 章 · 2 天', chapters: [chapter(1), chapter(2)] },
              { key: 'timeline:三月', label: '三月', detail: '第 3–5 章 · 4 天', chapters: [chapter(3), chapter(4, { state: 'dated', note: '正文寫明三月十四', issue: true }), chapter(5, { state: 'unknown', machine: true })] },
            ],
            missing: { count: 2, text: '第 6–7 章還沒推出來' },
            machine: 4,
            last: 7,
            ...patch,
          },
        },
      };
    };
    const groups = () => [...panel().querySelectorAll('.group')];
    const tlGroup = () => groups().find((g) => g.querySelector('.group-name')?.textContent === '時間線');
    const tlRows = () => [...tlGroup().querySelectorAll('.row, .timeline-issue')];
    const chapterRow = (no) => tlGroup().querySelector(`.row-time-chapter[data-chapter="${no}"]`);
    const headBtn = (cls) => tlGroup().querySelector(`.group-head .threads-head .${cls}`);

    test('單獨一組，排在敘事線組前面；敘事線組裡沒有時間線那一行；組標題後面是推到哪、故事第幾天', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.deepEqual(groups().map((g) => g.querySelector('.group-name').textContent), ['時間線', '敘事線']);
      assert.ok(!labels().includes('時間線'));
      assert.match(tlGroup().querySelector('.group-head').textContent, /推到第 5 章 · 故事第 12 天（三月十八 夜裡）/);
    });

    test('沒有「曆法與起點」那一行：在組標題的懸停裡；組標題右鍵「改曆法與起點…」；起點建議那條 ⚠ 右鍵「填為起點」帶上那一天', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(tlGroup().querySelector('.row-timeline-calendar'), null);
      assert.ok(!tlRows().some((r) => r.textContent.includes('第 1 章那一天')));
      assert.equal(tlGroup().querySelector('.group-toggle').title, '簡單歷 · 起點 三月初七（第 1 章那一天）\n右鍵改曆法與起點。');
      ui.sent.length = 0;
      ui.pick(ui.rightClick(tlGroup().querySelector('.group-head')), '改曆法與起點…');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['setTimelineStart', undefined]);
      const tree = withTimeline({
        calendar: { text: '簡單歷 · 沒填起點，只顯示第幾天', tip: '', calendarName: '简单历', start: '', suggestion: { start: '三月初五', note: '第 2 章寫了「三月初七」' } },
        issues: [{ text: '沒填起點：第 2 章寫了「三月初七」，第 1 章是三月初五（右鍵填為起點）', start: true }],
      });
      ui.post({ type: 'project', tree });
      ui.sent.length = 0;
      const issue = tlGroup().querySelector('.timeline-issue');
      ui.pick(ui.rightClick(issue), '填為起點「三月初五」（第 2 章寫了「三月初七」）');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['setTimelineStart', '三月初五']);
      // 組標題右鍵也有。
      const items = ui.itemsOf(ui.rightClick(tlGroup().querySelector('.group-head')));
      assert.ok(items.includes('填為起點「三月初五」（第 2 章寫了「三月初七」）'), JSON.stringify(items));
      ui.closeMenu();
    });

    test('對賬一條一行（⚠），點了開啟時間線檔案（外掛形態沒有時間線總覽）；章行上對賬報了的另掛一格 ⚠', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const issue = tlGroup().querySelector('.timeline-issue');
      assert.equal(issue.textContent, '⚠ 第 4 章：前面推下來是三月十一，正文寫三月十四（差 3 天），已按正文對齊');
      ui.sent.length = 0;
      ui.clickEl(issue);
      assert.equal(ui.last('openFile')?.path, TL);
      assert.deepEqual(warningsOf(chapterRow(4)), ['⚠ 對不上']);
    });

    test('按段畫：最後一段預設展開、其餘收起；點段頭折起、展開', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const heads = () => [...tlGroup().querySelectorAll('.row-timeline-segment')];
      assert.deepEqual(heads().map((h) => h.textContent), ['▸二月第 1–2 章 · 2 天', '▾三月第 3–5 章 · 4 天']);
      assert.equal(chapterRow(1), null);
      assert.ok(chapterRow(3));
      ui.clickEl(heads()[0]);
      assert.ok(chapterRow(1));
      ui.clickEl(heads()[1]);
      assert.equal(chapterRow(3), null);
      // 重推樹不把作者的摺疊換掉。
      ui.post({ type: 'project', tree: withTimeline() });
      assert.ok(chapterRow(1));
      assert.equal(chapterRow(3), null);
      ui.clickEl(heads()[0]);
      ui.clickEl(heads()[1]);
    });

    test('一章一行：狀態點、章號章名、那一天 · 比上一章 · 依據；點了開啟時間線檔案，不開正文（開啟正文在右鍵）', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      const row = chapterRow(4);
      assert.equal(row.querySelector('.dot').textContent, '◆');
      assert.equal(chapterRow(5).querySelector('.dot').textContent, '?');
      assert.equal(row.querySelector('.row-label').textContent, '第 4 章 第4章');
      assert.equal(row.querySelector('.row-detail').textContent, '三月十4 清晨 · +1 天 · 正文寫明三月十四');
      ui.sent.length = 0;
      ui.clickEl(row.querySelector('.row-label'));
      assert.equal(ui.last('openFile')?.path, TL);
      ui.pick(ui.rightClick(row), '開啟這一章');
      assert.equal(ui.last('openFile')?.path, 'chapters/04.md');
    });

    test('右鍵一章：改時間（帶章號）、重推這一章、從這一章起重推（到最後一章）', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      ui.sent.length = 0;
      ui.pick(ui.rightClick(chapterRow(4)), '改時間…');
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.name], ['editTimeline', '4']);
      ui.pick(ui.rightClick(chapterRow(4)), '重推這一章');
      assert.deepEqual({ ...ui.last('projectAction')?.range }, { from: 4, to: 4 });
      ui.pick(ui.rightClick(chapterRow(4)), '從這一章起重推（到第 7 章）');
      assert.deepEqual([ui.last('projectAction')?.action, { ...ui.last('projectAction')?.range }], ['refreshTimeline', { from: 4, to: 7 }]);
      // 你定的那一行：不給「重推這一章」（機器不動它）。
      ui.post({ type: 'project', tree: withTimeline({ segments: [{ key: 'timeline:三月', label: '三月', detail: '', chapters: [chapter(3, { state: 'anchor', machine: false })] }] }) });
      const items = ui.itemsOf(ui.rightClick(chapterRow(3)));
      assert.ok(items.includes('改時間…') && !items.includes('重推這一章'), JSON.stringify(items));
      ui.closeMenu();
    });

    test('標題旁「補推時間」「重推」：發 backfillTimeline / refreshTimeline（全部）、不折疊這一組；有一樣在跑時兩樣都不給', () => {
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(headBtn('threads-time-btn')?.textContent, '補推時間');
      assert.equal(headBtn('threads-refresh-btn')?.textContent, '重推');
      ui.sent.length = 0;
      ui.clickEl(headBtn('threads-time-btn'));
      assert.equal(ui.last('projectAction')?.action, 'backfillTimeline', JSON.stringify(ui.sent));
      ui.clickEl(headBtn('threads-refresh-btn'));
      assert.deepEqual([ui.last('projectAction')?.action, ui.last('projectAction')?.range], ['refreshTimeline', undefined]);
      assert.ok(chapterRow(3), '點按鈕把組折起來了');
      ui.post({ type: 'tasks', tasks: [{ id: 't1', title: '重推故事時間', message: '第 1–5 章', current: 0, total: 2, elapsedMs: 0 }] });
      ui.post({ type: 'project', tree: withTimeline() });
      assert.equal(headBtn('threads-time-btn'), null);
      assert.equal(headBtn('threads-refresh-btn'), null);
      ui.post({ type: 'tasks', tasks: [] });
    });

    test('沒有要補推、沒有機器寫的行：兩顆都不給；補推失敗的紅 ❗ 掛在組標題旁', () => {
      const tree = withTimeline({ missing: undefined, machine: 0 });
      tree.failures = { [TL]: [{ at: '2026-10-24T00:00:00Z', severity: 'error', op: 'timelineBackfill', message: '補推停在第 6 章' }] };
      ui.post({ type: 'project', tree });
      assert.equal(headBtn('threads-time-btn'), null);
      assert.equal(headBtn('threads-refresh-btn'), null);
      assert.ok(tlGroup().querySelector('.group-head .row-failure.is-error'));
    });

    test('沒有時間線：整組不畫', () => {
      ui.post({ type: 'project', tree: sampleTree() });
      assert.equal(tlGroup(), undefined);
    });
  });

  test('「故事架構」組標題仍是 x/6', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    const head = [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === '故事架構');
    assert.match(head.querySelector('.group-head').textContent, /5\/6/);
  });
});
