/**
 * 五期驗收：審一章 → 丟掉偽造的引文 → 按勾選修稿（截斷續寫一輪、合併檢視交回的那一份落盤）→
 * 修稿太短報錯 → 下一章的細綱排了死人，主按鈕先亮預檢卡。
 *
 * 工程：第 1–2 章寫好且定稿（細綱的 sourceHash 對得上正文），第 3 章排好細綱（計劃，「出場人物」
 * 排著角色卡上已經死了的沈秋）。一章只有一份細綱 `summaries/NNN-標題.md`。假模型按系統提示
 * 認是哪一步：審稿 / 修稿 / 寫正文。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 報告只剩引文站得住的問題，notes 寫著丟了哪條 | 引文找不到的丟棄（總計劃 §5 五期驗收第一條） |
 * | 目標 3 項：只有關鍵事件，看點不凍結；「未完成」沒給引文的降待核實 | 章末鉤子並進看點後不再單列成目標；「沒寫到」只能判待核實 |
 * | 審稿 1 次呼叫、沒有落盤卡片、會話檔案裡存著報告 | D22 |
 * | 修稿發出去的那一次：整章原文 + 只有勾選的兩條 | 作者沒勾的不該出現在模型眼前 |
 * | 截斷一次再續完：呼叫 2 次；覆蓋審閱拿到修訂稿；落盤的是合併結果 | W11 |
 * | 修訂稿不到原稿六成：報錯，磁碟不變 | 修稿後長度低於閾值時報錯（總計劃 §5 五期驗收第二條） |
 * | 修過稿，主按鈕先推重新定稿第 2 章 | 細綱（連續性事實、出場人物）要跟著修訂稿走 |
 * | 主按鈕寫第 3 章：先亮預檢卡，「先不寫」零呼叫，再按一次「僅本次忽略」照寫 | 一致性預檢零呼叫、可以僅本次忽略 |
 * | 重寫第 3 章選「記為刻意安排」：理由記進細綱、不動內容指紋；再寫不再亮卡 | 五期補遺 §2：永久放行按章記 |
 * | 編輯報告：模型條目改了標已改、加的接著編號、找不到的引文清空；按作者加的修稿 | 五期補遺 §3 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let fake;
let project;
let controller;
let ws;
let posted = [];
let gateAnswer = () => 'proceed';
const queues = { review: [], revise: [], write: [] };

const P2 = '.novelwarden/summaries/002-客棧.md';
const CH2_REL = 'chapters/002-客棧.md';

const CH2 = [
  '雨下了一整夜。林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  filler(900, 7),
  '“你明天就走？”她問。林昭點了點頭，說：“天一亮就走。”',
].join('\n\n');

const REVIEW = JSON.stringify({
  summary: '一處硬傷，一處角色狀態不一致',
  items: [
    { category: '劇情合理性', severity: 'error', quote: '她把那塊殘令收進了袖中', description: '第 1 章林昭已經把殘令交給了李叔' },
    { category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '他左臂有傷，動作寫得如常' },
    { category: '角色狀態', severity: 'warning', quote: '林昭拔劍指著沈氏的喉嚨', description: '正文里根本沒有這一句' },
  ],
  goalReviews: [
    { id: 'g1', status: 'completed', description: '回到了客棧', evidence: [{ quote: '林昭推開客棧的門' }] },
    { id: 'g2', status: 'unmet', description: '細綱要他當晚離開，正文裡他說天亮再走', evidence: [{ quote: '天一亮就走' }] },
    { id: 'g3', status: 'unmet', description: '正文裡沒寫到沈氏收下殘令', evidence: [] },
  ],
});

function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  if (sys.includes('嚴謹的小說審稿編輯')) return 'review';
  if (sys.includes('只依據人工確認的審稿意見')) return 'revise';
  return 'write';
}

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        // 答案可以帶理由（預檢卡的「記為刻意安排」）：`{ verdict, remember }`。
        const a = gateAnswer(m);
        const { verdict, remember } = typeof a === 'string' ? { verdict: a } : a;
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict, ...(remember ? { remember } : {}) });
      }
    },
    reveal() {},
  });
}

const gates = () => posted.filter((m) => m.type === 'gate');
const lastAssistant = () =>
  [...posted.filter((m) => m.type === 'turnDone').map((m) => m.turn)].reverse().find((x) => x.role === 'assistant');
const promptsOf = (kind) => fake.calls.filter((c) => kindOf(c) === kind).map((c) => c[c.length - 1].content);
const readCh2 = async () => project.readChapterText(await project.getChapter(2));

async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按鈕。 */
async function press(step) {
  posted = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', stage: step.stage, capability: step.capability, target: step.target, targetNo: step.no ?? 1, writeMode: step.writeMode, attachments: [], excludedIds: [] },
  });
}

/**
 * 三章的細綱。出場人物是預檢讀的（計劃出場），關鍵事件是審稿凍結的目標；鉤子並進了看點，不凍結。
 */
const PLANS = {
  1: { title: '雨夜', cast: ['林昭'], events: '林昭回鎮，把殘令交給李叔', highlight: '- 李叔認出了殘令' },
  2: { title: '客棧', cast: ['林昭', '沈氏'], events: '林昭回到客棧；林昭當晚離開青崖鎮；沈氏收下殘令', highlight: '- 門外有人敲了三下' },
  3: { title: '渡口', cast: ['林昭', '沈秋'], events: '林昭在渡口等沈秋', highlight: '- 船上沒有人' },
};

/**
 * 寫第 no 章的細綱（同一章只有這一份）。給了 `sourceHash` 就是定稿過的：等於正文的 contentHash
 * 才對得上，帶著實際出場與連續性事實；不給就是寫正文之前的計劃。不記 writtenFrom（作者手寫落盤的正文）。
 */
async function writeOutline(no, finalized) {
  const p = PLANS[no];
  await ws.writePlot({
    no,
    title: p.title,
    targetWords: 1000,
    upstreamHash: '',
    done: false,
    sections: {
      ...bundle.plotFile.emptyPlotSections(),
      梗概: `第 ${no} 章的事。`,
      出场人物: p.cast.join('、'),
      关键事件: p.events,
      看点: p.highlight,
      连续性事实: finalized?.facts ?? '',
    },
    ...(finalized ? { sourceHash: finalized.sourceHash, cast: p.cast.map((name) => ({ name, aliases: [] })) } : {}),
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages) => queues[kindOf(messages)].shift() ?? '（指令碼裡沒有這一步）',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'phase5', title: '青崖記' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 1000\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  // 架構三件借示例工程的：全書狀態機要它們齊了，才會走到「寫第 N 章」。情節大綱是各章細綱梗概的彙總，下面寫細綱就有了。
  const sample = (rel) => fs.readFileSync(path.join(__dirname, '../../../sample-novel/.novelwarden', rel), 'utf8');
  t.write('.novelwarden/premise.md', sample('premise.md'));
  t.write('.novelwarden/world.md', sample('world.md'));
  ws = new bundle.ws.Workspace(project);
  for (const no of [1, 2, 3]) {
    await writeOutline(no);
  }
  await ws.createChapter(1, '雨夜', filler(1000, 1));
  await ws.createChapter(2, '客棧', CH2);
  await project.syncManifest();
  // 兩章都定稿過：細綱的 sourceHash 對得上正文。
  const ch1 = await project.getChapter(1);
  const ch2 = await project.getChapter(2);
  await writeOutline(1, { sourceHash: ch1.contentHash, facts: '- 林昭把殘令交給了李叔' });
  await writeOutline(2, { sourceHash: ch2.contentHash });
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\nstateThrough: 2\n---\n\n# 林昭\n\n## 當前狀態\n\n左臂受傷，住在客棧\n');
  t.write('.novelwarden/characters/沈秋.md', '---\nname: 沈秋\nstateThrough: 2\n---\n\n# 沈秋\n\n## 當前狀態\n\n已死亡（第 2 章夜裡死在渡口）\n');
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('五期驗收', () => {
  let reviewTurn;

  describe('審第 2 章', () => {
    before(async () => {
      queues.review.push({ text: REVIEW, stop: 'end' });
      fake.calls.length = 0;
      posted = [];
      await controller.handle({
        type: 'send',
        payload: { text: '', stage: 'manuscript', capability: 'review', target: { kind: 'manuscript', plotRelPath: P2 }, targetNo: 2, attachments: [], excludedIds: [] },
      });
      reviewTurn = lastAssistant();
    });

    test('一次呼叫，沒有落盤卡片', () => {
      assert.equal(fake.calls.length, 1);
      assert.equal(gates().length, 0);
    });

    test('偽造引文的那一條被丟掉；notes 寫著丟了哪條', () => {
      const report = reviewTurn.review.report;
      assert.deepEqual(report.issues.map((i) => i.description), ['第 1 章林昭已經把殘令交給了李叔', '他左臂有傷，動作寫得如常']);
      assert.equal(report.dropped.length, 1);
      assert.match(reviewTurn.review.notes.join('\n'), /「正文里根本沒有這一句」引文在正文裡找不到/);
    });

    test('目標 3 項：只有 3 條關鍵事件（看點不凍結）；「未完成」沒給引文的降待核實', () => {
      const goals = reviewTurn.review.report.goals;
      assert.deepEqual(goals.map((g) => [g.text, g.status]), [
        ['林昭回到客棧', 'completed'],
        ['林昭當晚離開青崖鎮', 'unmet'],
        ['沈氏收下殘令', 'unknown'],
      ]);
    });

    test('審稿的裝配裡有前一章定稿留下的事實', () => {
      assert.match(promptsOf('review')[0], /# 前幾章的連續性事實（已定稿[^\n]*\n\n【第 1 章《雨夜》】\n- 林昭把殘令交給了李叔/);
    });

    test('會話檔案裡存著報告', () => {
      const file = path.join(project.sessionsDir, `${controller.current.id}.json`);
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(json.turns.find((x) => x.id === reviewTurn.id).review.report.chapterNo, 2);
    });
  });

  describe('勾 1 條問題 + 1 項未完成，按勾選修稿', () => {
    let before2;
    before(async () => {
      before2 = await readCh2();
      const revised = before2
        .replace('她把那塊殘令收進了袖中。', '她看了一眼他空著的手，什麼也沒問。')
        .replace('“天一亮就走。”', '“今晚就走。”');
      const cut = Math.floor(revised.length * 0.6);
      queues.revise.push({ text: revised.slice(0, cut), stop: 'maxTokens' }, { text: revised.slice(cut), stop: 'end' });
      h.reviewed.length = 0;
      h.setReviewVerdict(({ proposed }) => ({ merged: `${proposed.trim()}\n\n作者在合併檢視裡補的一句。\n` }));
      fake.calls.length = 0;
      await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'g2'] });
    });

    test('發出去的那一次：整章原文 + 只有勾選的兩條', () => {
      const [first] = promptsOf('revise');
      assert.ok(first.includes(before2.trim()), '整章原文');
      assert.match(first, /1\. \[劇情合理性 \/ 嚴重\] 第 1 章林昭已經把殘令交給了李叔/);
      assert.match(first, /2\. \[本章目標 \/ 未完成\] 關鍵事件：林昭當晚離開青崖鎮/);
      assert.doesNotMatch(first, /他左臂有傷/);
      // 沒勾的那一專案標（待核實）不進清單。
      assert.doesNotMatch(first, /\[本章目標 \/ [^\]]*\] 關鍵事件：沈氏收下殘令/);
    });

    test('截斷一次再續完：呼叫 2 次', () => {
      assert.equal(fake.calls.length, 2);
      assert.match(promptsOf('revise')[1], /上一輪修稿輸出因長度限制而中斷/);
    });

    test('覆蓋審閱拿到的是修訂稿，請求了合併；落盤的是合併結果', async () => {
      assert.equal(h.reviewed.length, 1);
      assert.equal(h.reviewed[0].merge, true);
      assert.match(h.reviewed[0].proposed, /她看了一眼他空著的手/);
      const now = await readCh2();
      assert.match(now, /今晚就走/);
      assert.match(now, /作者在合併檢視裡補的一句。/);
      assert.doesNotMatch(now, /殘令收進了袖中/);
    });

    test('修稿不記 writtenFrom（細綱改過的 ⟳ 不因為修了一次稿就消掉）', async () => {
      // 第 2 章是作者手寫落盤的（從沒記過 writtenFrom），修稿之後也不該冒出來一個。
      assert.ok(!(await project.getPlot(2)).writtenFrom);
    });
  });

  describe('修訂稿不到原稿六成', () => {
    test('報錯，磁碟不變', async () => {
      const before3 = await readCh2();
      const fresh = await (async () => {
        queues.review.push({ text: JSON.stringify({ summary: 'x', items: [{ category: '角色狀態', severity: 'warning', quote: '林昭點了點頭', description: '動作如常' }], goalReviews: [] }), stop: 'end' });
        posted = [];
        await controller.handle({
          type: 'send',
          payload: { text: '', stage: 'manuscript', capability: 'review', target: { kind: 'manuscript', plotRelPath: P2 }, targetNo: 2, attachments: [], excludedIds: [] },
        });
        return lastAssistant();
      })();
      queues.revise.push({ text: '林昭託著左臂，點了點頭。', stop: 'end' });
      h.reviewed.length = 0;
      posted = [];
      await controller.handle({ type: 'reviseChapter', turnId: fresh.id, picks: ['i1'] });
      assert.match(lastAssistant().error, /修訂稿明顯短於原稿/);
      assert.equal(h.reviewed.length, 0);
      assert.equal(await readCh2(), before3);
    });
  });

  describe('主按鈕寫第 3 章：細綱排著已經死了的沈秋', () => {
    // 修過稿，第 2 章細綱的 sourceHash 就對不上正文了：主按鈕先推重新定稿（連續性事實與角色狀態
    // 要跟著修訂稿走）。定稿記的就是修訂稿的 contentHash。
    test('修稿之後下一步是重新定稿第 2 章；定稿之後才是寫第 3 章', async () => {
      assert.equal((await nextStep()).label, '同步第 2 章');
      const ch2 = await project.getChapter(2);
      await writeOutline(2, { sourceHash: ch2.contentHash });
      project.invalidate();
      assert.equal((await nextStep()).label, '寫第 3 章');
    });

    test('先亮預檢卡；「先不寫」一次模型都不調', async () => {
      fake.calls.length = 0;
      gateAnswer = (m) => (m.name === 'preflight' ? 'skip' : 'proceed');
      await press(await nextStep());
      assert.equal(fake.calls.length, 0);
      const [g] = gates();
      assert.equal(g.name, 'preflight');
      assert.match(g.danger, /沈秋的當前狀態（截至第 2 章）寫著「已死亡」，本章細綱仍安排這個人出場/);
      assert.match(lastAssistant().content, /這一次先不寫——沒有呼叫模型/);
      assert.ok(!t.has('chapters/003-渡口.txt'));
    });

    test('再按一次、選「僅本次忽略」：照寫', async () => {
      fake.calls.length = 0;
      gateAnswer = () => 'proceed';
      queues.write.push({ text: filler(900, 30), stop: 'end' });
      await press(await nextStep());
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(gates().map((g) => g.name), ['preflight', 'artifact']);
      assert.ok(t.has('chapters/003-渡口.txt'));
    });
  });

  // 五期補遺 §2：預檢的永久放行。
  describe('重寫第 3 章：記為刻意安排', () => {
    const P3 = '.novelwarden/summaries/003-渡口.md';
    const rewrite3 = async () => {
      posted = [];
      await controller.handle({
        type: 'send',
        payload: { text: '', stage: 'manuscript', capability: 'generate', target: { kind: 'manuscript', plotRelPath: P3 }, targetNo: 3, writeMode: 'rewrite', attachments: [], excludedIds: [] },
      });
    };

    test('預檢卡帶理由輸入框；填了理由點「記為刻意安排」：照寫，理由記進第 3 章細綱', async () => {
      gateAnswer = (m) => (m.name === 'preflight' ? { verdict: 'proceed', remember: '託夢裡的一場' } : 'proceed');
      queues.write.push({ text: filler(950, 31), stop: 'end' });
      const hashBefore = bundle.plotFile.plotContentHash(await project.getPlot(3));
      await rewrite3();
      const [g] = gates();
      assert.equal(g.name, 'preflight');
      assert.equal(g.remember.label, '記為刻意安排，照寫');
      project.invalidate();
      const plot = await project.getPlot(3);
      assert.deepEqual(JSON.parse(JSON.stringify(plot.preflightOk)), [{ name: '沈秋', reason: '託夢裡的一場' }]);
      assert.match(t.read(P3), /preflightOk: \[沈秋：託夢裡的一場\]/);
      // frontmatter 不進內容指紋：記下放行不會讓正文變成「細綱改過」。
      assert.equal(bundle.plotFile.plotContentHash(plot), hashBefore);
    });

    test('落盤卡片的說明裡寫著記下了', () => {
      const card = gates().find((g) => g.name === 'artifact');
      assert.match(card.detail, /沈秋在第 3 章出場已記為刻意安排（託夢裡的一場）/);
    });

    test('再重寫一次：不亮預檢卡，說明裡提一句「按你記下的安排放行」', async () => {
      gateAnswer = () => 'proceed';
      queues.write.push({ text: filler(950, 32), stop: 'end' });
      await rewrite3();
      assert.deepEqual(gates().map((g) => g.name), ['artifact']);
      assert.match(gates()[0].detail, /沈秋按你記下的安排放行（託夢裡的一場）/);
    });
  });

  // 五期補遺 §3：報告卡的編輯模式，經 controller 走一遍。
  describe('編輯第一份報告：改一條、加兩條，再按作者加的那條修稿', () => {
    let edited;
    before(async () => {
      posted = [];
      h.toasts.length = 0;
      await controller.handle({
        type: 'editReview',
        turnId: reviewTurn.id,
        issues: [
          { id: 'i2', category: '角色狀態', severity: 'error', description: '左臂有傷，不該點頭如常', quote: '林昭點了點頭' },
          { category: '', severity: 'warning', description: '沈氏的反應太平淡', quote: '沈氏在櫃檯後看著他' },
          { category: '節奏', severity: 'error', description: '結尾太急', quote: '正文裡沒有這一句' },
        ],
      });
      edited = lastAssistant();
    });

    test('推回的報告：i1 原樣、i2 已改、新加 a1 a2；找不到的引文清空', () => {
      const issues = edited.review.report.issues;
      assert.deepEqual(issues.map((i) => i.id), ['i1', 'i2', 'a1', 'a2']);
      assert.equal(issues[1].edited, true);
      assert.equal(issues[2].origin, 'author');
      assert.equal(issues[2].quote, '沈氏在櫃檯後看著他');
      assert.equal(issues[3].quote, '');
      assert.ok(edited.review.picks.includes('a1') && edited.review.picks.includes('a2'));
    });

    test('提示裡說了引文找不到；氣泡正文換成新的文字版；會話檔案裡存著', () => {
      const toasts = posted.filter((m) => m.type === 'toast').map((m) => m.message);
      assert.ok(toasts.some((x) => /「結尾太急」的引文在正文裡找不到，按沒有引文處理/.test(x)), JSON.stringify(toasts));
      const json = JSON.parse(fs.readFileSync(path.join(project.sessionsDir, `${controller.current.id}.json`), 'utf8'));
      const saved = json.turns.find((x) => x.id === reviewTurn.id);
      assert.equal(saved.review.report.issues.length, 4);
      assert.match(saved.content, /結尾太急（作者補充）/);
    });

    test('按作者加的那條修稿：清單裡有它、沒有「相關原文」', async () => {
      queues.revise.push({ text: '太短了。', stop: 'end' });
      fake.calls.length = 0;
      posted = [];
      await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['a2'] });
      const [prompt] = promptsOf('revise');
      assert.match(prompt, /1\. \[節奏 \/ 嚴重 · 作者補充\] 結尾太急/);
      assert.doesNotMatch(prompt, /結尾太急\n   相關原文/);
    });
  });
});
