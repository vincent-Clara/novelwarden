/**
 * 審稿與修稿的裝配（五期）：移植自 AI-Novel-Writer 的 `consistency_check` / `refine_from_review`。
 *
 * | 釘住什麼 | 為什麼 |
 * |---|---|
 * | 審稿帶這一章全文、細綱、凍結的目標清單（只有關鍵事件） | 審的就是它；目標從細綱的關鍵事件凍結，看點不是一件件到期的動作 |
 * | 後續章節標「非既定歷史」 | 審稿最常見的誤判是拿計劃當歷史 |
 * | 前幾章的連續性事實：定稿過的帶、定稿之後正文又改過的說清楚 | 上游審稿讀的就是已定稿歷史；對不上正文的不作數（第 2 條） |
 * | 審稿不帶歷史對話與文風 | 審稿判的是正文，文筆不在審查範圍裡 |
 * | 修稿帶整章原文與勾選清單，沒有寫正文那一套法則 | 那一套在教它「寫一章」，修稿要「只改這幾處」 |
 * | 修稿續寫帶原文與已修訂的末尾 | 模型得知道剩下那半章原來怎麼寫的 |
 * | 重寫時 `revision` 是整章（精修） | 從前只帶 3000 token 的尾巴，前半章憑空重寫 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

const REVIEW = { stage: 'manuscript', capability: 'review' };
const WRITE = { stage: 'manuscript', capability: 'generate' };
const P3 = '.novelwarden/summaries/003-夜访.md';

const config = {
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

let t;
let project;
let builderMod;
let review;
let vs;
let chapter3;

const lastUser = (b) => b.messages[b.messages.length - 1].content;
const system = (b) => b.messages[0].content;
const byKind = (b, kind) => b.items.filter((i) => i.kind === kind);

before(async () => {
  t = copyFixture('review-recipe');
  vs = installVscodeStub({ level: 'full', root: t.dir, config: {} });
  // 第 2 章的細綱定稿過、對得上正文，填上連續性事實；第 1 章的改成定稿之後正文又改過（sourceHash 對不上）。
  // 第 4 章示例工程裡本來就排了細綱（計劃）：審第 3 章時它是「後續章節計劃」。
  const s2 = path.join(t.dir, '.novelwarden/summaries/002-客栈里的女人.md');
  const facts = '- 沈氏住進走廊盡頭的房間 〔證據：「住進走廊盡頭的房間」〕\n- 林昭否認知道七年前的火';
  fs.writeFileSync(s2, fs.readFileSync(s2, 'utf8').replace(/(## 連續性事實\r?\n\r?\n)（待補充）/, `$1${facts}`));
  const s1 = path.join(t.dir, '.novelwarden/summaries/001-楔子.md');
  fs.writeFileSync(s1, fs.readFileSync(s1, 'utf8').replace(/sourceHash: \w+/, 'sourceHash: stale000'));

  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    review: './src/core/model/review.ts',
  });
  builderMod = bundle.builder;
  review = bundle.review;
  project = bundle.project.NovelProject.open(t.dir);
  chapter3 = await project.readChapterText(await project.getChapter(3));
});

after(() => {
  vs?.restore?.();
  cleanup(t.dir);
});

describe('審稿配方 · 第 3 章', () => {
  let b;
  let goals;
  before(async () => {
    const plot = await project.getPlot(3);
    goals = review.freezeGoals(plot.sections.关键事件);
    b = await builderMod.buildContext(
      project,
      {
        action: REVIEW,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '重點看年輕守衛的動機',
        reviewGoals: goals,
        history: [{ id: 'x', role: 'user', content: '之前聊過的話', at: '' }],
      },
      config
    );
  });

  test('系統提示是審稿編輯，帶審查原則與事實的優先順序', () => {
    assert.match(system(b), /嚴謹的小說審稿編輯/);
    assert.match(system(b), /舉證審查/);
    assert.match(system(b), /後續章節計劃：還沒有發生的事/);
    assert.doesNotMatch(system(b), /AI 味反制/);
  });

  test('待審正文是整章，P0 強制', () => {
    const [full] = byKind(b, 'chapterFull');
    assert.equal(full.status, 'included');
    assert.equal(full.priority, 0);
    assert.equal(full.text, chapter3.trim());
    assert.ok(lastUser(b).includes('# 待審正文'));
  });

  test('本章細綱與凍結清單都在', () => {
    assert.ok(byKind(b, 'plot').some((i) => i.source === P3));
    assert.match(lastUser(b), /【本章目標逐項核對｜凍結清單】/);
    // 2026-10-25 起審稿寫自然語言，清單也是一項一行「- g1：目標原文」。
    assert.ok(lastUser(b).includes(`凍結清單：\n${goals.map((g) => `- ${g.id}：${g.text}`).join('\n')}\n`), lastUser(b).slice(-2500));
  });

  // 章末鉤子並進了「看點」：爽點與章末懸念混在一起，不是一件件到期的動作，不凍結成目標。
  test('凍結清單隻有關鍵事件，一條一項；契約不再提章末鉤子', () => {
    assert.equal(goals.length, 5);
    assert.match(goals[0].text, /^年輕守衛夜裡潛入林昭房間/);
    assert.match(lastUser(b), /凍結清單來自本章細綱的關鍵事件；/);
    assert.doesNotMatch(lastUser(b), /章末鉤子/);
  });

  test('後續章節標「非既定歷史」', () => {
    assert.equal(byKind(b, 'boundary').length, 1);
    assert.match(lastUser(b), /# 後續章節計劃（非既定歷史/);
    assert.doesNotMatch(lastUser(b), /後續章節預告/);
  });

  test('前幾章的連續性事實：定稿過的帶，定稿之後正文又改過的說清楚為什麼不帶', () => {
    const facts = byKind(b, 'facts');
    const f2 = facts.find((i) => i.id === 'facts:2');
    assert.equal(f2.status, 'included');
    assert.match(f2.text, /- 沈氏住進走廊盡頭的房間/);
    assert.doesNotMatch(f2.text, /證據/);
    const f1 = facts.find((i) => i.id === 'facts:1');
    assert.equal(f1.status, 'dropped');
    assert.equal(f1.note, '同步之後正文又改過，事實不作數');
    assert.ok(lastUser(b).includes('# 前幾章的連續性事實（已定稿'));
  });

  test('出場角色卡、上一章結尾都帶；歷史對話與文風不帶', () => {
    assert.ok(byKind(b, 'character').some((i) => i.label.includes('年輕守衛')));
    assert.equal(byKind(b, 'prevTail').length, 1);
    assert.equal(byKind(b, 'history').length, 0);
    assert.equal(byKind(b, 'style').length, 0);
  });

  // 2026-10-25 起改成轉寫：審稿按小標題寫自然語言，JSON 由轉寫模型照抄。
  test('作者的話是「重點檢查的方面」；契約是按小標題寫、不寫 JSON，並說清引文找不到會丟', () => {
    assert.match(lastUser(b), /# 作者要求重點檢查的方面[^\n]*\n\n重點看年輕守衛的動機/);
    assert.match(lastUser(b), /引文在正文裡找不到的問題會被丟棄/);
    assert.match(lastUser(b), /按「### 總評」「### 問題」「### 目標核對」三個小標題寫審稿報告，不寫 JSON/);
    assert.match(lastUser(b), /嚴重程度只寫這三個詞之一：嚴重/);
    assert.doesNotMatch(lastUser(b), /JSON\.parse|"severity"|goalReviews/);
    assert.doesNotMatch(system(b), /severity|JSON/);
    assert.doesNotMatch(lastUser(b), /本章執行卡/);
  });

  test('重來一次：說明上一次為什麼被丟棄', async () => {
    const again = await builderMod.buildContext(
      project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', reviewGoals: goals, step: { kind: 'reviewRetry', why: 'invalid', reason: '缺少 items 陣列' } },
      config
    );
    assert.match(lastUser(again), /未通過格式校驗（缺少 items 陣列），已被丟棄/);
  });

  test('細綱沒有關鍵事件：「目標核對」只寫「無」', async () => {
    const empty = await builderMod.buildContext(
      project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', reviewGoals: [] },
      config
    );
    assert.match(lastUser(empty), /本章細綱沒有可核對的關鍵事件：「### 目標核對」下面只寫「無」/);
  });
});

describe('修稿配方 · 第 3 章', () => {
  const BRIEF = '【已確認納入本次修稿的審稿項】\n1. [角色狀態 / 嚴重] 年輕守衛的傷寫在了右臉\n   相關原文：……';
  let b;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '',
        writeMode: 'revise',
        revision: { previousDraft: chapter3, feedback: BRIEF },
      },
      config
    );
  });

  test('系統提示是修稿編輯，不帶寫正文那一套', () => {
    assert.match(system(b), /只依據人工確認的審稿意見進行必要修改/);
    assert.doesNotMatch(system(b), /硬性要求/);
    assert.doesNotMatch(system(b), /AI 味反制/);
  });

  test('整章原文與勾選清單，強制', () => {
    const [rev] = byKind(b, 'revision');
    assert.equal(rev.status, 'included');
    assert.ok(rev.text.includes(chapter3.trim()));
    assert.ok(rev.text.includes(BRIEF));
    assert.ok(lastUser(b).includes('# 待修稿原文與審稿意見'));
    assert.doesNotMatch(lastUser(b), /請基於上一版重寫/);
  });

  test('契約是修復原則，沒有執行卡、篇幅合同與連載法則', () => {
    assert.match(lastUser(b), /【修復原則】/);
    assert.match(lastUser(b), /清單沒有指到的段落原樣保留，一字不改/);
    assert.doesNotMatch(lastUser(b), /本章執行卡/);
    assert.doesNotMatch(lastUser(b), /篇幅合同/);
    assert.doesNotMatch(lastUser(b), /連載更新核心法則/);
  });

  test('文風、全域要求強制帶；本章細綱、角色卡、上一章結尾作參照；不帶近章全文與早前細綱', () => {
    assert.equal(byKind(b, 'style')[0]?.status, 'included');
    assert.equal(byKind(b, 'guidance')[0]?.status, 'included');
    assert.ok(byKind(b, 'plot').length > 0);
    assert.ok(byKind(b, 'character').length > 0);
    assert.equal(byKind(b, 'prevTail').length, 1);
    assert.equal(byKind(b, 'manuscriptFull').length, 0);
    assert.equal(byKind(b, 'plotSummary').length, 0);
  });

  test('續寫那幾輪：原文、清單與已修訂的末尾', async () => {
    const c = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '',
        writeMode: 'revise',
        revision: { previousDraft: chapter3, feedback: BRIEF },
        step: { kind: 'continuation', tail: '已經修到這裡了。', written: 300, recovery: false },
      },
      config
    );
    assert.ok(byKind(c, 'revision')[0].text.includes(BRIEF));
    assert.match(lastUser(c), /# 已修訂正文（末尾，從這裡接著輸出）\n\n已經修到這裡了。/);
    assert.match(lastUser(c), /上一輪修稿輸出因長度限制而中斷/);
    assert.equal(byKind(c, 'character').length, 0);
  });
});

describe('重寫（精修）· 第 3 章', () => {
  test('revision 帶整章上一版，本章細綱也在', async () => {
    const long = `${'很長的一段正文。'.repeat(1500)}\n\n結尾這一句。`;
    const b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '打鬥寫緊一點',
        writeMode: 'rewrite',
        revision: { previousDraft: long, feedback: '照細綱重寫' },
      },
      config
    );
    const [rev] = byKind(b, 'revision');
    assert.ok(rev.text.includes(long.trim()), '上一版整章都在');
    assert.ok(byKind(b, 'plot').some((i) => i.source === P3));
    assert.match(lastUser(b), /請基於上一版重寫/);
    assert.match(lastUser(b), /本章執行卡/);
  });
});
