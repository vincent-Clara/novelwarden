/**
 * 創作頁：流水線條與下一步、當前產物浮窗、/ 命令面板、進入某一章、獨立版殼。
 *
 * 遷自 scripts/smoke-view.js 的這幾節：
 *   == 創作流水線條與下一步 ==（389） == 工作區卡 ==（544）
 *   == / 命令面板 ==（617）          == 選中章節進入當前階段 ==（720）
 *   == 獨立版殼上的創作頁 ==（770）
 *
 * 一章一綱之後（commit 4e0d289）：階段是「架構 / 大綱 / 細綱 / 正文」，流水線條上
 * 一章只剩「細綱 / 正文」兩格加一個定稿狀態；卷綱那一格、目標字數輸入框都沒了。2026-10-24 前面
 * 又掛了一格「大綱」（這一章排進大綱沒有，點了回到全書那一層）。
 * 主按鈕發的是**狀態機給的 target 與 range**——從前發的是會話當下的 target，
 * 按鈕上寫著一件事、落盤時寫到了另一處（§3.1-1）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  mount, JSDOM_SKIP,
  emptySession, pipelineView, workbenchView, viewState, sampleTree,
} = require('../../helpers/dom');

const PLOT_12 = '.novelwarden/summaries/012-夜入青雲.md';

describe('創作流水線條與下一步', { skip: JSDOM_SKIP }, () => {
  let ui;
  let sentStep;
  let act;
  const crumbBox = () => ui.doc.getElementById('pipelineCrumb');
  const crumbs = () => [...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].map((n) => n.textContent);
  const stagesBox = () => ui.doc.getElementById('pipelineStages');
  const stages = () => [...ui.doc.querySelectorAll('#pipelineStages .pstage')];
  const stage = (label) => stages().find((n) => n.querySelector('.pstage-label')?.textContent === label);
  const summaryState = () => ui.doc.querySelector('#pipelineStages .psummary');
  const lastSetTarget = () => [...ui.sent].reverse().find((m) => m.type === 'setTarget');
  const lastSend = () => [...ui.sent].reverse().find((m) => m.type === 'send');
  const goBtn = () => ui.doc.getElementById('nextStepBtn');
  const hint = () => ui.doc.getElementById('nextStepHint').textContent;
  const renameBtn = () => ui.doc.getElementById('renamePlotBtn');
  /** 點主按鈕，取它發出的那一條 send，然後把 busy 放回去（點了就會置 busy）。 */
  const runStep = () => {
    ui.doc.getElementById('input').value = '';
    ui.clickEl(goBtn());
    const msg = lastSend();
    ui.post({ type: 'busy', value: false });
    return msg;
  };
  const chapterSession = (extra) =>
    emptySession({
      target: { kind: 'manuscript', plotRelPath: PLOT_12 },
      stage: 'manuscript',
      capability: 'discuss',
      ...extra,
    });

  before(() => {
    ui = mount();
    // ---- 情節大綱那一層（emptySession 的預設）----
    ui.post({ type: 'session', session: emptySession() });
  });

  // 從前全書那一層沒有具體落點可報，整條收起。現在架構與大綱各有名字，
  // 麵包屑照樣報「在哪」——只是下面那兩格沒有意義了。
  test('大綱層顯示麵包屑「情節大綱」', () => {
    assert.ok(!crumbBox().classList.contains('hidden'));
    assert.deepEqual(crumbs(), ['情節大綱']);
  });

  test('大綱層收起細綱 / 正文兩格', () => {
    assert.ok(stagesBox().classList.contains('hidden'));
  });

  // 大綱那一層沒有章可改名，留一個點了會報錯的按鈕比沒有更糟。
  test('大綱層收起重新命名按鈕', () => {
    assert.ok(renameBtn().classList.contains('hidden'));
  });

  // 全書那一層同樣有下一步（生成 / 續寫大綱、拆細綱），而且帶章號區間。
  test('大綱層也給下一步', () => {
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'outline', title: '情節大綱', sections: [], empty: '這部書還沒有情節大綱。' }),
      next: {
        stage: 'outline',
        capability: 'generate',
        label: '生成情節大綱（第 1–20 章）',
        hint: '按故事結構把全書的走向排出來，按章號區間分節。',
        target: { kind: 'outline' },
        range: { from: 1, to: 20 },
      },
    });
    assert.equal(goBtn().textContent, '生成情節大綱（第 1–20 章）', goBtn().textContent);
  });

  test('下一步給出理由', () => {
    assert.ok(hint().includes('按故事結構'), hint());
  });

  // 區間本期只透傳、不影響生成（二期才按區間一次出多章），但必須原樣到後端。
  test('主按鈕透傳狀態機給的區間', () => {
    sentStep = runStep();
    assert.ok(sentStep, '沒發出 send');
    assert.equal(sentStep.payload.range?.from, 1, JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.range?.to, 20, JSON.stringify(sentStep.payload));
  });

  // 沒有 step.no 時 targetNo 取區間起點——那是這一步開工的那一章。
  test('沒有章號時 targetNo 取區間起點', () => {
    assert.equal(sentStep.payload.targetNo, 1, JSON.stringify(sentStep.payload));
  });

  // W1：目標字數只認細綱（或 config.md 的每章字數）。輸入框下面那個預設 2000 的
  // 數字框刪了，payload 裡也不該再捎一個——兩處都能寫，作者分不清哪個生效。
  test('主按鈕的 payload 不再帶 targetWords', () => {
    assert.ok(!('targetWords' in sentStep.payload), JSON.stringify(sentStep.payload));
  });

  // ---- ★ 本期修的那個 bug（§3.1-1）：主按鈕發的是 step.target，不是會話的 target
  //
  // 會話停在大綱，全書狀態機說下一步是「拆細綱（第 1–5 章）」、落點是第 1 章的細綱。
  // 從前 payload 只覆蓋了 stage 與 capability，target 仍是會話那份（大綱），
  // 於是產出的細綱被當成大綱寫回了 outline.md。
  test('主按鈕發的是狀態機給的 target，不是會話當前的', () => {
    ui.post({
      type: 'pipeline',
      workbench: workbenchView({ stage: 'outline', title: '情節大綱' }),
      next: {
        stage: 'plot',
        capability: 'generate',
        label: '拆細綱（第 1–5 章）',
        hint: '從情節大綱裡把接下來幾章拆成一章一份的細綱。',
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/001-楔子.md' },
        range: { from: 1, to: 5 },
      },
    });
    sentStep = runStep();
    assert.equal(sentStep.payload.target.kind, 'plot', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.target.plotRelPath, '.novelwarden/summaries/001-楔子.md', JSON.stringify(sentStep.payload));
  });

  test('階段與能力也跟著 step 走', () => {
    assert.equal(sentStep.payload.stage, 'plot', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.capability, 'generate', JSON.stringify(sentStep.payload));
  });

  test('拆細綱那一步的區間原樣透傳', () => {
    assert.equal(sentStep.payload.range?.from, 1, JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.range?.to, 5, JSON.stringify(sentStep.payload));
  });

  // ---- 架構那一層 ----
  // 階段叫「架構」，避免和設定條目（lore，介面上叫「設定」）撞名。
  test('架構層麵包屑寫「故事架構 · 故事前提」', () => {
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'setting', doc: 'premise' }, stage: 'setting', capability: 'discuss' }),
    });
    assert.ok(!crumbBox().classList.contains('hidden'));
    assert.deepEqual(crumbs(), ['故事架構 · 故事前提']);
  });

  test('架構層同樣收起兩格', () => {
    assert.ok(stagesBox().classList.contains('hidden'));
  });

  test('架構層收起重新命名按鈕', () => {
    assert.ok(renameBtn().classList.contains('hidden'));
  });

  // 沒有下一步、也不在某一章上：全書寫完了。不造一個假的下一步。
  test('全書層沒有下一步時收起主按鈕並說明', () => {
    ui.post({ type: 'pipeline', workbench: workbenchView({ stage: 'setting', title: '架構 · 故事前提' }) });
    assert.ok(goBtn().classList.contains('hidden'));
    assert.ok(hint().includes('全書都寫完了'), hint());
  });

  // ---- 切到某一章的正文 ----
  test('麵包屑只報這一章', () => {
    ui.post({ type: 'session', session: chapterSession() });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        chapter: {
          exists: true,
          relPath: 'chapters/012-夜入青雲.md',
          words: 1200,
          targetWords: 3000,
          upstreamStale: true,
        },
        stage: 'manuscript',
        progress: { plot: 1, manuscript: 0.5, summary: 0 },
      }),
      workbench: workbenchView({ stage: 'manuscript', title: '正文 · 第 12 章《夜入青雲》' }),
      next: {
        stage: 'manuscript',
        capability: 'generate',
        label: '重寫第 12 章',
        hint: '細綱改過，現有正文可能已經與它對不上。',
        target: { kind: 'manuscript', plotRelPath: PLOT_12 },
      },
    });
    assert.deepEqual(crumbs(), ['第 12 章《夜入青雲》']);
  });

  test('資訊條不是按鈕', () => {
    assert.ok([...ui.doc.querySelectorAll('#pipelineCrumb .crumb')].every((n) => n.tagName === 'SPAN'));
  });

  // 一章一綱之後這一章的上游鏈：它的細綱 → 它的正文，前面再掛一格「大綱」（2026-10-24：停在一章上
  // 找不到回全書的路）。定稿不是一個創作階段（它是寫完之後的一步工程動作），只給狀態不給按鈕。
  test('展開三格：大綱 / 細綱 / 正文', () => {
    assert.ok(!stagesBox().classList.contains('hidden'));
    assert.deepEqual(stages().map((n) => n.querySelector('.pstage-label').textContent), ['大綱', '細綱', '正文']);
  });

  // 大綱那一格報的是這一章在情節大綱裡有沒有那一條，不是這一章的一層：排進去了實心、不掛 ⚠、從不高亮。
  test('大綱那一格：這一章排進了大綱', () => {
    assert.ok(stage('大綱').querySelector('.pstage-mark.done'), stage('大綱').outerHTML);
    assert.ok(!stage('大綱').querySelector('.pstage-stale'), stage('大綱').outerHTML);
    assert.ok(!stage('大綱').classList.contains('active'));
    assert.match(stage('大綱').title, /情節大綱裡有這一章（大綱排到第 20 章）/);
    assert.match(stage('大綱').title, /\/續寫大綱/);
  });

  test('點大綱那一格回到全書那一層', () => {
    ui.clickEl(stage('大綱'));
    assert.equal(lastSetTarget()?.target.kind, 'outline', JSON.stringify(lastSetTarget()));
    assert.equal(lastSetTarget()?.target.plotRelPath, undefined);
  });

  // 章名後面不再掛狀態徽章：這一章走到哪，下一行的兩格加定稿狀態已經說了，同一件事不說兩遍。
  test('資訊條只有章名，沒有狀態徽章', () => {
    const crumb = ui.doc.getElementById('pipelineCrumb');
    assert.equal(crumb.querySelector('.cstage'), null, crumb.outerHTML);
    assert.ok(!crumb.textContent.includes('待寫正文'), crumb.textContent);
  });

  // 三態圓點：細綱完成、正文進行中——不是百分比條。
  test('細綱標成已完成', () => {
    assert.ok(stage('細綱').querySelector('.pstage-mark.done'), stage('細綱').outerHTML);
  });

  test('正文標成進行中', () => {
    assert.ok(stage('正文').querySelector('.pstage-mark.partial'), stage('正文').outerHTML);
  });

  test('不再畫百分比條', () => {
    assert.ok(!ui.doc.querySelector('.pstage-bar'));
  });

  // 會話停在哪一層，哪一格就亮著。
  test('當前所在那一層高亮', () => {
    assert.ok(stage('正文').classList.contains('active'));
    assert.ok(!stage('細綱').classList.contains('active'));
  });

  // ⟳ 是整條流水線最有價值的一格資訊：細綱在正文寫完之後改過。
  test('正文那一格標出上遊已變更', () => {
    assert.ok(stage('正文').querySelector('.pstage-stale'), stage('正文').outerHTML);
  });

  test('細綱那一格沒有變更標記', () => {
    assert.ok(!stage('細綱').querySelector('.pstage-stale'));
  });

  // 定稿：寫了正文、細綱還沒照正文更新過 → 待定稿，並標成待辦。
  test('寫了沒定稿報「待定稿」', () => {
    assert.equal(summaryState()?.textContent, '待同步');
    assert.ok(summaryState().classList.contains('stale'), summaryState().className);
  });

  // ---- 主按鈕：點了就跑，不必先輸入 ----
  test('主按鈕空輸入也能發', () => {
    const beforeSend = ui.sent.filter((m) => m.type === 'send').length;
    sentStep = runStep();
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, beforeSend + 1);
  });

  test('主按鈕帶上狀態機給的階段與能力', () => {
    assert.equal(sentStep.payload.stage, 'manuscript', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.capability, 'generate', JSON.stringify(sentStep.payload));
  });

  test('主按鈕帶上狀態機給的 target', () => {
    assert.equal(sentStep.payload.target.kind, 'manuscript', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.target.plotRelPath, PLOT_12, JSON.stringify(sentStep.payload));
  });

  // 單章那一步沒有區間，別把上一步的區間捎過去。
  test('沒有區間的那一步不帶 range', () => {
    assert.equal(sentStep.payload.range, undefined, JSON.stringify(sentStep.payload));
  });

  // 輸入框裡有字就當補充要求一起帶上。
  test('輸入框裡的字作為補充要求帶上', () => {
    ui.doc.getElementById('input').value = '多寫點雨裡的細節';
    ui.clickEl(goBtn());
    assert.equal(lastSend().payload.text, '多寫點雨裡的細節', JSON.stringify(lastSend().payload));
    assert.equal(ui.doc.getElementById('input').value, '', '發完沒清空輸入框');
    ui.post({ type: 'busy', value: false });
  });

  // ---- 生成中：主按鈕會發起新的一輪，必須點不動 ----
  test('生成中禁用主按鈕', () => {
    ui.post({ type: 'busy', value: true });
    assert.ok(goBtn().disabled);
  });

  test('生成中點主按鈕不傳送', () => {
    const before = ui.sent.filter((m) => m.type === 'send').length;
    ui.clickEl(goBtn());
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, before);
  });

  test('生成結束後主按鈕恢復', () => {
    ui.post({ type: 'busy', value: false });
    assert.ok(!goBtn().disabled);
  });

  // ---- 點選切目標（資訊條本身不可點，靠下面的兩格切）----
  test('點資訊條不發 setTarget', () => {
    const before = ui.sent.filter((m) => m.type === 'setTarget').length;
    ui.clickEl(ui.doc.querySelector('#pipelineCrumb .crumb'));
    assert.equal(ui.sent.filter((m) => m.type === 'setTarget').length, before);
  });

  // ---- 「開始新對話」按鈕：麵包屑右側那個 ＋ ----
  test('開始新對話按鈕在麵包屑右側', () => {
    const btn = ui.doc.getElementById('newSessionBtn');
    assert.ok(btn, '沒有 newSessionBtn');
    assert.equal(btn.parentElement?.id, 'pipelineTop');
    assert.ok(btn.textContent.includes('＋'), btn.textContent);
  });

  test('點開始新對話發出 newSession', () => {
    ui.clickEl(ui.doc.getElementById('newSessionBtn'));
    const msg = [...ui.sent].reverse().find((m) => m.type === 'newSession');
    assert.ok(msg, JSON.stringify(ui.sent));
  });

  test('生成中點開始新對話不發 newSession', () => {
    ui.post({ type: 'busy', value: true });
    const before = ui.sent.filter((m) => m.type === 'newSession').length;
    ui.clickEl(ui.doc.getElementById('newSessionBtn'));
    assert.equal(ui.sent.filter((m) => m.type === 'newSession').length, before);
    ui.post({ type: 'busy', value: false });
  });

  test('生成中禁用開始新對話按鈕', () => {
    ui.post({ type: 'busy', value: true });
    assert.ok(ui.doc.getElementById('newSessionBtn').disabled);
    ui.post({ type: 'busy', value: false });
    assert.ok(!ui.doc.getElementById('newSessionBtn').disabled);
  });

  // ---- 「重新命名當前這一章」按鈕：麵包屑右側那支筆 ----
  // 手工新建的細綱是純序號名（標題要等細綱排完才定得下來），所以得有個常駐入口。
  test('重新命名按鈕在麵包屑右側', () => {
    assert.ok(renameBtn(), '沒有 renamePlotBtn');
    assert.equal(renameBtn().parentElement?.id, 'pipelineTop');
  });

  test('目標是某一章時按鈕可見', () => {
    assert.ok(!renameBtn().classList.contains('hidden'));
  });

  test('tooltip 帶上章名', () => {
    assert.ok(renameBtn().title.includes('夜入青雲'), renameBtn().title);
  });

  // 複用工程頁右鍵那條 fileAction，不新增協議。改的是細綱（章號字首保留）。
  test('點重新命名發出 fileAction', () => {
    ui.clickEl(renameBtn());
    const msg = [...ui.sent].reverse().find((m) => m.type === 'fileAction');
    assert.ok(msg, JSON.stringify(ui.sent));
    assert.equal(msg.action, 'rename', JSON.stringify(msg));
    assert.equal(msg.relPath, PLOT_12, JSON.stringify(msg));
  });

  test('生成中禁用重新命名按鈕', () => {
    ui.post({ type: 'busy', value: true });
    assert.ok(renameBtn().disabled);
    ui.post({ type: 'busy', value: false });
    assert.ok(!renameBtn().disabled);
  });

  test('生成中點重新命名不發 fileAction', () => {
    ui.post({ type: 'busy', value: true });
    const before = ui.sent.filter((m) => m.type === 'fileAction').length;
    ui.clickEl(renameBtn());
    assert.equal(ui.sent.filter((m) => m.type === 'fileAction').length, before);
    ui.post({ type: 'busy', value: false });
  });

  test('點細綱那一格發出 setTarget', () => {
    ui.clickEl(stage('細綱'));
    assert.equal(lastSetTarget()?.target.kind, 'plot', JSON.stringify(lastSetTarget()));
  });

  test('切層保留當前這一章', () => {
    assert.equal(lastSetTarget()?.target.plotRelPath, PLOT_12);
  });

  test('點正文那一格切到正文層', () => {
    ui.clickEl(stage('正文'));
    assert.equal(lastSetTarget()?.target.kind, 'manuscript', JSON.stringify(lastSetTarget()));
    assert.equal(lastSetTarget()?.target.plotRelPath, PLOT_12);
  });

  // 細綱改過（大綱那一節在細綱之後動過）時，⟳ 掛在細綱那一格上。
  test('細綱的上游變過時細綱那一格掛 ⟳', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ plot: { relPath: PLOT_12, exists: true, filled: true, upstreamStale: true } }),
      workbench: workbenchView(),
    });
    assert.ok(stage('細綱').querySelector('.pstage-stale'), stage('細綱').outerHTML);
  });

  // 還沒有正文時別把一格空的說成「待定稿」。
  test('還沒寫正文報「未寫正文」', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
    assert.equal(summaryState()?.textContent, '未寫正文');
    assert.ok(!summaryState().classList.contains('stale'), summaryState().className);
  });

  // 圖上那一種：新建的第 83 章，大綱只排到第 82 章——大綱那一格空心掛 ⚠，懸停說排到第幾章。
  test('這一章還沒排進大綱：大綱那一格空心掛 ⚠', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView({ outline: { covered: false, coverage: 11 } }), workbench: workbenchView() });
    assert.ok(stage('大綱').querySelector('.pstage-mark.todo'), stage('大綱').outerHTML);
    assert.equal(stage('大綱').querySelector('.pstage-stale')?.textContent, '⚠', stage('大綱').outerHTML);
    assert.match(stage('大綱').title, /情節大綱裡還沒有這一章（大綱排到第 11 章）/);
  });

  test('一章大綱都沒有時說還沒有情節大綱', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView({ outline: { covered: false, coverage: 0 } }), workbench: workbenchView() });
    assert.match(stage('大綱').title, /情節大綱裡還沒有這一章（還沒有情節大綱）/);
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
  });

  // ---- 全做完的章不催 ----
  test('定稿過的章報「已定稿」', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        chapter: { exists: true, relPath: 'chapters/012-夜入青雲.md', words: 3000, targetWords: 3000, upstreamStale: false },
        summary: { exists: true, stale: false },
        stage: 'done',
        progress: { plot: 1, manuscript: 1, summary: 1 },
      }),
      workbench: workbenchView(),
      next: undefined,
    });
    assert.equal(summaryState()?.textContent, '已同步');
  });

  test('沒有下一步時收起主按鈕', () => {
    assert.ok(goBtn().classList.contains('hidden'));
  });

  test('沒有下一步時說明為什麼', () => {
    assert.ok(hint().includes('這一章都齊了'), hint());
  });

  // 單章做完之後主按鈕轉去問全書，落到下一個該寫的章——這時 step.target 與
  // 會話的 target 指的是兩章。發出去的必須是下一章。
  test('這一章做完後，主按鈕落到下一章', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'done', progress: { plot: 1, manuscript: 1, summary: 1 } }),
      workbench: workbenchView(),
      next: {
        stage: 'plot',
        capability: 'generate',
        label: '寫第 13 章細綱',
        hint: '先把這一章要發生什麼定下來。',
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/013.md' },
      },
    });
    sentStep = runStep();
    assert.equal(sentStep.payload.target.plotRelPath, '.novelwarden/summaries/013.md', JSON.stringify(sentStep.payload));
    assert.equal(sentStep.payload.target.kind, 'plot', JSON.stringify(sentStep.payload));
  });

  // ---- 定稿那一步是工程動作，不是一輪對話 ----
  let beforeAct;
  test('定稿走工程動作', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({
        chapter: { exists: true, relPath: 'chapters/012-夜入青雲.md', words: 2980, targetWords: 3000, upstreamStale: false },
        stage: 'finalize',
        progress: { plot: 1, manuscript: 1, summary: 0 },
      }),
      workbench: workbenchView(),
      next: {
        stage: 'manuscript',
        capability: 'generate',
        projectAction: 'finalizeChapter',
        label: '同步第 12 章',
        hint: '正文寫夠了。',
        target: { kind: 'manuscript', plotRelPath: PLOT_12 },
      },
    });
    beforeAct = ui.sent.filter((m) => m.type === 'send').length;
    ui.clickEl(goBtn());
    act = [...ui.sent].reverse().find((m) => m.type === 'projectAction');
    assert.equal(act?.action, 'finalizeChapter', JSON.stringify(act));
  });

  // 路徑必須來自 next.target 而不是會話裡的目標——後者可能還沒同步，
  // 而工程動作拿不到物件會靜默什麼都不做。後端按章號把細綱路徑認到同號正文上。
  test('工程動作帶上這一章的路徑', () => {
    assert.equal(act?.relPath, PLOT_12, JSON.stringify(act));
  });

  test('工程動作不佔對話', () => {
    assert.equal(ui.sent.filter((m) => m.type === 'send').length, beforeAct);
  });

  test('工程動作不把介面鎖進生成中', () => {
    assert.ok(!goBtn().disabled);
  });

  // ---- 目標換章時，上一章的進度不能留著顯示 ----
  // 拿上一章的狀態配這一章的名字，比什麼都不顯示更糟。
  test('換章後不再顯示上一章的章名', () => {
    ui.post({ type: 'pipeline', pipeline: pipelineView(), workbench: workbenchView() });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/013-另一章.md' },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
    assert.ok(!crumbs().some((c) => c.includes('夜入青雲')), crumbs().join('|'));
  });
});

/*
 * 「當前產物」：流水線條上的入口 + 懸停浮窗。
 *
 * 從前它是訊息流頂部一張 sticky 卡片，關不掉也藏不起來。現在與工程頁那三隻
 * 浮窗同一套路子，所以要驗的東西也換了：入口只佔一行、懸停/點選才浮出來、
 * 移開或 Esc 收得掉。
 */
describe('當前產物浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const entry = () => ui.doc.getElementById('workbench');
  const tip = () => ui.doc.querySelector('.workbench-tip');
  const rows = () => [...(tip()?.querySelectorAll('.wbt-row') ?? [])].map((n) => n.textContent);
  const hoverEntry = () => entry().dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  const leaveEntry = () => entry().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  const esc = () =>
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 等過懸停延遲（HOVER_DELAY_MS 是 300ms）。 */
  const settle = () => wait(450);
  /** 等過收起的寬限期（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);

  const postPlot = () =>
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({
        sections: [
          { key: '梗概', text: '林昭混進青雲宗，拿到入門的腰牌' },
          { key: '關鍵事件', text: '林昭把外衣搭在牆頭\n數到第三盞燈才翻過去' },
        ],
      }),
    });

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: PLOT_12 },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
    postPlot();
  });

  // ---- 入口：一行，長在流水線條上（不在訊息流裡，不佔版面）
  test('入口顯示出來', () => {
    assert.ok(!entry().classList.contains('hidden'));
  });

  test('入口長在流水線條裡，不在訊息流裡', () => {
    assert.equal(entry().parentElement?.id, 'pipeline', entry().parentElement?.id);
  });

  // 入口只寫這一層叫什麼：章名在上面的麵包屑上，入口再寫一遍就是同一句話說兩次。完整標題在浮窗頭上。
  test('入口上寫著在改哪一層，不重複章名', () => {
    const title = entry().querySelector('.wbt-entry-title');
    assert.equal(title?.textContent, '當前產物 · 細綱', title?.textContent);
  });

  test('入口不再掛 ▤（與標題欄「顯示 / 隱藏編輯器」撞圖示）', () => {
    assert.ok(!entry().textContent.includes('▤'), entry().textContent);
  });

  test('預設不顯示浮窗', () => {
    assert.ok(!tip());
  });

  // ---- 懸停：延遲後浮出來（免得劃過時閃）
  test('懸停後不立刻彈出', () => {
    hoverEntry();
    assert.ok(!tip());
  });

  test('懸停延遲到了浮出來', async () => {
    await settle();
    assert.ok(tip());
  });

  test('浮窗掛在 body 上（訊息流有內部滾動，掛在裡面會被裁掉）', () => {
    assert.equal(tip().parentElement, ui.doc.body);
  });

  test('浮窗標題說清在改哪一層', () => {
    assert.ok(tip().querySelector('.wbt-title').textContent.includes('細綱'),
      tip().querySelector('.wbt-title')?.textContent);
  });

  test('攤開產物的小節', () => {
    assert.equal(rows().length, 2, rows().join('|'));
  });

  test('關鍵事件逐行可見', () => {
    assert.ok(rows()[1].includes('搭在牆頭') && rows()[1].includes('第三盞燈'), rows()[1]);
  });

  // 寫正文時要對著細綱抄事件，滑鼠得進得來——所以收起有寬限期。
  test('移開後有寬限期，浮窗還在', () => {
    leaveEntry();
    assert.ok(tip());
  });

  test('寬限期過後收起', async () => {
    await grace();
    assert.ok(!tip());
  });

  // ---- 點一下釘住：照著細綱寫正文時滑鼠要回輸入框
  test('點選立刻浮出來，不等延遲', () => {
    ui.clickEl(entry());
    assert.ok(tip());
  });

  test('釘住後移開滑鼠也不收', async () => {
    leaveEntry();
    await grace();
    assert.ok(tip());
  });

  test('再點一次收起', () => {
    ui.clickEl(entry());
    assert.ok(!tip());
  });

  test('按 Esc 收起', () => {
    ui.clickEl(entry());
    esc();
    assert.ok(!tip());
  });

  // 「開啟」走的是既有的開檔案通道（外掛裡是 openFile）。
  test('點開啟發出開檔案訊息', () => {
    ui.clickEl(entry());
    ui.clickEl(tip().querySelector('.wbt-open'));
    const opened = [...ui.sent].reverse().find((m) => m.type === 'openFile' || m.type === 'openEditor');
    assert.equal(opened?.path, PLOT_12, JSON.stringify(opened));
  });

  // 上游變更在浮窗裡是一句人話，不只是流水線條上那個 ⟳。
  test('上游變更給一句人話', () => {
    ui.clickEl(entry());
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({ warning: '情節大綱裡覆蓋這一章的那一節在細綱之後改過，兩者可能已經對不上。' }),
    });
    assert.ok(tip()?.querySelector('.wbt-warning')?.textContent.includes('在細綱之後改過'),
      tip()?.querySelector('.wbt-warning')?.textContent);
  });

  // 開著的浮窗就地換內容，不重建——重建會讓它閃一下。
  test('重推產物時浮窗不關掉', () => {
    assert.ok(tip());
  });

  // 入口上也要看得見，否則使用者沒有理由把它開啟。
  test('上游變更在入口上掛標記', () => {
    assert.equal(entry().querySelector('.wbt-entry-mark')?.textContent, '⟳');
  });

  // 這一層還沒有產物時說清缺什麼，不要留一隻空浮窗。
  test('沒有產物時說明缺什麼', () => {
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView(),
      workbench: workbenchView({
        stage: 'manuscript',
        title: '正文 · 第 12 章《夜入青雲》',
        sections: [],
        empty: '這一章沒有細綱，寫正文時模型只能照著前文往下編。',
      }),
    });
    assert.equal(tip()?.querySelector('.wbt-empty')?.textContent, '這一章沒有細綱，寫正文時模型只能照著前文往下編。',
      tip()?.querySelector('.wbt-empty')?.textContent);
  });

  test('沒有產物時不畫小節', () => {
    assert.equal(rows().length, 0);
    esc();
  });
});

describe('/ 命令面板', { skip: JSDOM_SKIP }, () => {
  let ui;
  let input;
  /** 鍵盤事件。導航鍵（↑↓/Enter/Esc）走這條，可列印字元走 type()。 */
  const key = (k) =>
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  /**
   * 打字：改輸入框的值再發 input 事件。
   *
   * 面板是**輸入框內容的函式**（真實瀏覽器裡 keydown 之後瀏覽器自己落值、
   * 再發 input），所以測試也必須照這個順序模擬——從前面板自己攢過濾串，
   * 於是測試只發 keydown 就夠，那也正是輸入法打的中文一個都收不到的原因。
   */
  const type = (text) => {
    input.value += text;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const backspace = () => {
    input.value = input.value.slice(0, -1);
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const setValue = (text) => {
    input.value = text;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const panel = () => ui.doc.querySelector('.cmd-panel');
  const items = () => [...ui.doc.querySelectorAll('.cmd-item .cmd-label')].map((n) => n.textContent);

  before(() => {
    ui = mount();
    input = ui.doc.getElementById('input');
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: PLOT_12 },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
  });

  test('預設不顯示命令面板', () => {
    assert.ok(!panel());
  });

  // 打 / 喚出。
  test('打 / 喚出面板', () => {
    type('/');
    assert.ok(panel());
  });

  // Cursor 那一套：命令的字**留在輸入框裡**，面板只是浮在上方的候選列表。
  // 從前 `/` 被 keydown 攔下來不落進輸入框，過濾串自己攢在模組變數裡。
  test('斜槓留在輸入框裡', () => {
    assert.equal(input.value, '/');
  });

  // 面板浮在輸入框那一格上（bottom: 100%），不再掛在下一步條裡。
  test('面板掛在輸入框那一格上', () => {
    assert.ok(ui.doc.querySelector('#composerInput .cmd-panel'));
  });

  // 討論不進面板（打字就是在討論）。細綱層有 `/落定細綱` 與 `/寫細綱` 兩條——細綱是「先跟人聊、聊出結論
  // 再落檔案」的東西；末尾再掛兩條哪一層都有的：`/續寫大綱`（2026-10-24：停在一章上也能往後排大綱）與
  // `/落定設定`（完善設定二期：聊定了的設定當場落成條目）。
  test('細綱層四個命令：兩條自己的，加上哪一層都有的續寫大綱與落定設定', () => {
    assert.deepEqual(items(), ['/落定細綱', '/寫細綱', '/續寫大綱', '/落定設定']);
  });

  test('面板裡沒有討論', () => {
    assert.ok(!items().some((s) => s.includes('討論')), items().join('|'));
  });

  test('細綱層有「落定細綱」與「寫細綱」', () => {
    assert.ok(items().includes('/落定細綱') && items().includes('/寫細綱'), items().join('|'));
  });

  // 面板裡的名字帶斜槓：挑的和打的是同一樣東西。
  test('命令名帶斜槓', () => {
    assert.ok(items().every((s) => s.startsWith('/')), items().join('|'));
  });

  // 拆卷 / 拆段隨卷與劇情段一起刪了：忘記刪的話面板裡會多一條點了什麼都不發生的命令。
  test('細綱層沒有拆分命令', () => {
    assert.ok(!items().some((s) => s.includes('拆')), items().join('|'));
  });

  // 面板裡剩下的每一條都會寫檔案（討論不是命令），每條都標出來。
  test('每條命令都標記寫檔案', () => {
    const writes = [...ui.doc.querySelectorAll('.cmd-item')].filter((n) => n.classList.contains('cmd-writes'));
    assert.equal(writes.length, 4, String(writes.length));
  });

  test('每條命令都掛「寫檔案」標籤', () => {
    assert.equal(ui.doc.querySelectorAll('.cmd-item .cmd-tag').length, 4);
  });

  // 鍵入過濾：ascii 別名與中文標籤都認。`ld` 是「落定」，兩條落定都在；`ldsd` 只剩落定設定。
  test('按拼音首字母過濾', () => {
    type('ld');
    assert.deepEqual(items(), ['/落定細綱', '/落定設定']);
  });

  test('過濾串跟著輸入框走', () => {
    assert.equal(input.value, '/ld');
  });

  test('退格恢復全部', () => {
    backspace();
    backspace();
    assert.equal(items().length, 4, items().join('|'));
  });

  // 退到 `/` 之前就不是在下命令了，面板該收。
  test('刪掉斜槓收起面板', () => {
    backspace();
    assert.ok(!panel());
    assert.equal(input.value, '');
  });

  // 選中 → 變成待執行 chip，不立刻傳送。
  let beforePick;
  test('選中後收起面板', () => {
    type('/');
    beforePick = ui.sent.length;
    ui.clickEl([...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.textContent.includes('落定細綱')));
    assert.ok(!panel());
  });

  test('選中不立刻傳送', () => {
    assert.equal(ui.sent.length, beforePick);
  });

  test('選中變成待執行 chip', () => {
    const chip = ui.doc.querySelector('#pendingCmd .cmd-chip');
    assert.ok(chip, '沒有 chip');
    assert.ok(chip.textContent.includes('落定細綱'), chip?.textContent);
  });

  // chip 長在輸入框**裡面**：傳送時用的是它的能力，它就是輸入內容的一部分。
  test('chip 在輸入框那一格里', () => {
    assert.ok(ui.doc.querySelector('#composerInput #pendingCmd .cmd-chip'));
  });

  // 挑中之後那幾個字是用來挑命令的，不該跟著發給模型。
  test('挑中後清掉輸入框裡的命令文字', () => {
    assert.equal(input.value, '');
  });

  // chip 在時傳送用它，而不是會話當前的能力。
  test('傳送用挑中的命令', () => {
    input.value = '按剛才聊的來';
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    const sent = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sent.payload.capability, 'settle', JSON.stringify(sent.payload));
  });

  // 挑命令那條路的落點是會話當前那一章（作者就是在這一章上挑的命令）。
  test('挑命令傳送時 target 是會話那一章', () => {
    const sent = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sent.payload.target.plotRelPath, PLOT_12, JSON.stringify(sent.payload));
  });

  test('發完清掉 chip', () => {
    assert.ok(ui.doc.getElementById('pendingCmd').classList.contains('hidden'));
    ui.post({ type: 'busy', value: false });
  });

  // `/落定設定` 帶著自己的階段與目標：發出去的是架構那一層、設定目錄上的 settle，不是這一章的落定細綱；
  // 回到哪一章由後端管（會話那份目標沒動）。
  test('挑落定設定：發的是設定目錄上的 settle', () => {
    setValue('');
    type('/ldsd');
    assert.deepEqual(items(), ['/落定設定']);
    key('Enter');
    assert.ok(ui.doc.querySelector('#pendingCmd .cmd-chip').textContent.includes('落定設定'));
    ui.clickEl(ui.doc.getElementById('sendBtn'));
    const sent = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sent.payload.stage, 'setting', JSON.stringify(sent.payload));
    assert.equal(sent.payload.capability, 'settle');
    // 跨 realm（jsdom 那邊的物件），按 JSON 比。
    assert.equal(JSON.stringify(sent.payload.target), JSON.stringify({ kind: 'setting', doc: 'lore' }));
    ui.post({ type: 'busy', value: false });
  });

  // `/` 在中文正文裡是普通字元（日期、比值、網址），只有「整個輸入框就是一個
  // /詞」才算在下命令。
  test('正文裡的 / 不喚出面板', () => {
    setValue('子時 3/4 刻');
    assert.ok(!panel());
  });

  test('斜槓後帶空格不算命令', () => {
    setValue('/ 這是一句話');
    assert.ok(!panel());
  });

  // 「/ 命令」按鈕：與鍵盤走同一條路——輸入框為空時順手把 / 打進去。
  test('按鈕喚出面板', () => {
    setValue('');
    ui.clickEl(ui.doc.getElementById('cmdBtn'));
    assert.ok(panel());
    assert.equal(input.value, '/');
  });

  test('按鈕再點一次收起', () => {
    ui.clickEl(ui.doc.getElementById('cmdBtn'));
    assert.ok(!panel());
  });

  // Esc 收起，且不會因為輸入框裡那個 / 還在就立刻彈回來。
  test('Esc 收起面板', () => {
    setValue('');
    type('/');
    assert.ok(panel());
    key('Escape');
    assert.ok(!panel());
  });

  test('Esc 之後繼續打字不再彈回來', () => {
    type('c');
    assert.ok(!panel());
  });

  // 生成中面板該收起：一個點不動的候選列表掛在那兒只會擋住訊息流。
  test('生成中收起面板並禁用按鈕', () => {
    setValue('');
    type('/');
    assert.ok(panel());
    ui.post({ type: 'busy', value: true });
    assert.ok(!panel());
    assert.ok(ui.doc.getElementById('cmdBtn').disabled);
    ui.post({ type: 'busy', value: false });
  });

  // 命令表按會話那一層取（`commandsFor(session.stage)`），前端不自己維護一份。
  test('換到架構層後面板跟著換', () => {
    setValue('');
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'setting', doc: 'config' }, stage: 'setting', capability: 'discuss' }),
    });
    type('/');
    assert.deepEqual(items(), ['/生成這份架構檔案', '/續寫大綱', '/落定設定']);
    key('Escape');
    setValue('');
  });
});

describe('/ 命令面板 · 正文層', { skip: JSDOM_SKIP }, () => {
  let ui;
  const rowOf = (label) =>
    [...ui.doc.querySelectorAll('.cmd-item')].find((n) => n.querySelector('.cmd-label').textContent === label);

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'manuscript', plotRelPath: PLOT_12 },
        stage: 'manuscript',
        capability: 'discuss',
      }),
    });
    const input = ui.doc.getElementById('input');
    input.value = '/';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  });

  test('有「寫正文」與「審稿」', () => {
    assert.ok(rowOf('/寫正文') && rowOf('/審稿'));
  });

  test('寫正文掛「寫檔案」', () => {
    assert.equal(rowOf('/寫正文').querySelector('.cmd-tag').textContent, '寫檔案');
    assert.ok(rowOf('/寫正文').classList.contains('cmd-writes'));
  });

  // 審稿只出報告、不寫檔案（D22）：掛「寫檔案」會讓作者以為點了它正文就被改了。
  test('審稿掛「只出報告」，不算寫檔案的命令', () => {
    assert.equal(rowOf('/審稿').querySelector('.cmd-tag').textContent, '只出報告');
    assert.ok(!rowOf('/審稿').classList.contains('cmd-writes'));
  });
});

describe('選中一章進入當前階段', { skip: JSDOM_SKIP }, () => {
  let ui;
  let select;
  const options = () => [...select.options];

  before(() => {
    ui = mount();
    ui.post({ type: 'session', session: emptySession() });
    ui.post({
      type: 'state',
      state: viewState({
        // 後端按章號升序給；每個章號一行，說法由後端給。
        plots: [
          { no: 11, label: '第 11 章《青崖》', title: '青崖', wordCount: 3000, relPath: 'chapters/011-青崖.md' },
          { no: 12, label: '第 12 章《夜入青雲》', title: '夜入青雲', wordCount: 0, relPath: PLOT_12 },
        ],
        nextNo: 13,
      }),
    });
    select = ui.doc.getElementById('targetSelect');
  });

  // 第一項是回到全書那一層的入口：主按鈕就是全書的下一步。
  test('第一項是「全書（架構 · 大綱）」', () => {
    assert.equal(options()[0].textContent, '全書（架構 · 大綱）');
    assert.equal(options()[0].value, '0');
  });

  // 不隔開的話「全書」看著就像列表裡的又一章（2026-10-24）。分隔線選不中。
  test('「全書」與章之間隔一條選不中的分隔線', () => {
    assert.ok(options()[1].disabled);
    assert.equal(options()[1].dataset.rel, undefined);
  });

  test('每個章號一行，最近的在上面', () => {
    assert.deepEqual(options().slice(2).map((o) => o.textContent), ['第 12 章《夜入青雲》', '第 11 章《青崖》']);
  });

  test('會話停在大綱時下拉停在「全書」', () => {
    assert.equal(select.value, '0');
  });

  test('會話停在某一章時下拉停在那一章', () => {
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'plot', plotRelPath: PLOT_12 }, stage: 'plot', capability: 'discuss' }),
    });
    assert.equal(select.value, '12');
  });

  test('會話停在架構檔案時下拉回到「全書」', () => {
    ui.post({
      type: 'session',
      session: emptySession({ target: { kind: 'setting', doc: 'world' }, stage: 'setting', capability: 'discuss' }),
    });
    assert.equal(select.value, '0');
  });

  // 下拉框選一章 = 進入那一章當前該做的那一步，由後端的狀態機判定。
  // 舊版一律發 setTarget({kind:'manuscript'})，於是選中一個連細綱都沒排的
  // 章，介面直接把作者丟進正文層。
  test('選一章發 selectPlot', () => {
    select.value = '12';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const picked = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(picked?.plotRelPath, PLOT_12, JSON.stringify(picked));
  });

  test('不再直接發 setTarget 到正文', () => {
    assert.ok(![...ui.sent].some((m) => m.type === 'setTarget' && m.target.kind === 'manuscript'));
  });

  // 「全書」那一項沒有 relPath：回到大綱那一層，主按鈕會是全書的下一步。
  test('選「全書」回到大綱那一層', () => {
    select.value = '0';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const toOutline = [...ui.sent].reverse().find((m) => m.type === 'setTarget');
    assert.equal(toOutline?.target.kind, 'outline', JSON.stringify(toOutline));
  });

  // 工程頁點章名是**開啟這一章**（正文與細綱並排，W6），不切頁——「進入這一章」在右鍵
  // 選單與「去寫這一章」裡。在工程頁上掃章節列表時，要看的多半就是這一章寫成了什麼樣。
  test('工程頁點章名開啟這一章，不發 selectPlot', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    ui.sent.length = 0;
    // 排掉「故事架構」那一組的行：它們刻意複用同一套樣式類（`.row-plot`）。
    const row = ui.doc.querySelector('#projectBody .row-plot:not(.row-architecture) .row-label');
    ui.clickEl(row);
    assert.ok(![...ui.sent].some((m) => m.type === 'selectPlot'), JSON.stringify(ui.sent));
    const open = [...ui.sent].reverse().find((m) => m.type === 'openChapter');
    assert.equal(open?.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(open));
  });

  test('工程頁右鍵「進入這一章」帶主路徑', () => {
    ui.sent.length = 0;
    const rows = [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture)')];
    ui.pick(ui.rightClick(rows.find((n) => n.textContent.includes('北行'))), '進入這一章');
    const fromTree = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(fromTree?.plotRelPath, '.novelwarden/summaries/004-北行.md', JSON.stringify(fromTree));
  });

  // 「去寫這一章」與右鍵「進入這一章」是同一件事，發的是同一條訊息。
  test('「去寫這一章」與「進入這一章」發的是同一條', () => {
    const viaMenu = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    ui.sent.length = 0;
    ui.clickEl(ui.doc.querySelector('#projectBody .row-plot:not(.row-architecture) .row-go'));
    const viaButton = [...ui.sent].reverse().find((m) => m.type === 'selectPlot');
    assert.equal(viaButton?.plotRelPath, viaMenu?.plotRelPath, JSON.stringify(ui.sent));
  });
});

/*
 * 創作頁的三塊新東西在**獨立版**的 DOM 上也要能跑。
 *
 * 上面所有用例走的都是 webviewHtml.ts 的 body；獨立版是另一份模板
 * （工作臺結構、活動欄、內建編輯器），兩份各寫一遍 id 就有漏掉一個的機會，
 * 而那種漏法只有真的把獨立版開起來才看得見。
 */
describe('獨立版殼上的創作頁', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    // 原指令碼在 772 行就地又抄了一份 mount()，只把 body 換成獨立版模板。
    ui = mount({ body: 'standalone' });
    ui.post({
      type: 'session',
      session: emptySession({
        target: { kind: 'plot', plotRelPath: PLOT_12 },
        stage: 'plot',
        capability: 'discuss',
      }),
    });
    ui.post({
      type: 'pipeline',
      pipeline: pipelineView({ stage: 'plot', plot: { relPath: PLOT_12, exists: true, filled: false, upstreamStale: false } }),
      workbench: workbenchView(),
      next: {
        stage: 'plot',
        capability: 'generate',
        label: '寫第 12 章細綱',
        hint: '先把這一章要發生什麼定下來：梗概、出場人物、關鍵事件、看點。',
        target: { kind: 'plot', plotRelPath: PLOT_12 },
      },
    });
  });

  test('獨立版渲染當前產物入口', () => {
    const entry = ui.doc.getElementById('workbench');
    assert.ok(!entry.classList.contains('hidden'));
    assert.ok(entry.querySelector('.wbt-entry-title')?.textContent.includes('細綱'),
      entry.querySelector('.wbt-entry-title')?.textContent);
  });

  test('獨立版能浮出產物浮窗', () => {
    ui.clickEl(ui.doc.getElementById('workbench'));
    assert.equal(ui.doc.querySelectorAll('.workbench-tip .wbt-row').length, 1);
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  test('獨立版渲染三格', () => {
    const labels = [...ui.doc.querySelectorAll('#pipelineStages .pstage-label')].map((n) => n.textContent);
    assert.deepEqual(labels, ['大綱', '細綱', '正文']);
  });

  test('獨立版渲染主按鈕', () => {
    assert.equal(ui.doc.getElementById('nextStepBtn').textContent, '寫第 12 章細綱',
      ui.doc.getElementById('nextStepBtn').textContent);
  });

  test('獨立版能喚出命令面板', () => {
    const input = ui.doc.getElementById('input');
    input.value = '/';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.ok(ui.doc.querySelector('#composerInput .cmd-panel'));
  });

  test('獨立版主按鈕可發', () => {
    ui.doc.getElementById('input').value = '';
    ui.clickEl(ui.doc.getElementById('nextStepBtn'));
    const sentStep = [...ui.sent].reverse().find((m) => m.type === 'send');
    assert.equal(sentStep?.payload.capability, 'generate', JSON.stringify(sentStep));
    assert.equal(sentStep?.payload.target.plotRelPath, PLOT_12, JSON.stringify(sentStep));
  });
});
