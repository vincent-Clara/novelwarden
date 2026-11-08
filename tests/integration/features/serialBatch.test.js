/**
 * 四期驗收：從排好前 5 章細綱的工程起，工程頁「批次寫章」第 1–3 章、寫完即定稿。
 *
 *   寫第 1 章 → 定稿（照正文更新細綱 + 角色狀態）→ 寫第 2 章 → 定稿 → 寫第 3 章 → 定稿
 *
 * 經 controller 發出去（與工程頁彈窗提交的那一條訊息一樣），假模型按指令碼應答。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 三章正文都在，三份細綱都定了稿（sourceHash 對得上正文），連續性事實每條帶證據 | 第 23 條：細綱定稿過且對得上才算寫完；D18：證據確定性地找 |
 * | 第 2 章定稿後，角色卡的當前狀態換成第 2 章給出的那一版 | D15：機器的那一節由定稿維護 |
 * | **第 3 章寫正文那一次的裝配裡**：角色卡是第 2 章更新過的狀態，定稿原文片段裡有第 2 章證據所在的那一段 | 這一期存在的理由：後一章讀得到前一章定稿留下的東西 |
 * | 作者在第 1 章之後手改過沈氏的當前狀態：後兩章定稿都沒覆蓋，卡上掛黃 ❗ | 第 3 條：不靜默覆蓋 |
 * | 實際呼叫次數 ≤ 確認框報的上限，完成提示帶「開啟第 3 章」 | 第 4 條；D24 |
 *
 * 近章全文設成 0：否則第 2 章整章進了上下文，它的片段按去重規則就不單獨帶了——那條規則
 * 在 context/evidence.test.js 裡另有用例。這裡要看的是片段本身。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
const finished = [];

const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;
const LIN = '.novelwarden/characters/林昭.md';
const SHEN = '.novelwarden/characters/沈氏.md';
const AUTHOR_STATE = '作者寫的：沈氏其實早就認出了林昭，只是不說。';

/** 第 N 章的正文：一段帶證據的原句夾在兩段填充之間。 */
function chapterText(no) {
  return [
    filler(260, no * 10 + 1),
    `林昭在第${no}章受了第${no}處傷，血順著左臂往下淌。`,
    `沈氏在第${no}章把第${no}盞燈吹滅了。`,
    filler(260, no * 10 + 2),
  ].join('\n\n');
}

/** 第 3 章那一次寫正文呼叫發出去的 user 訊息，與那一刻角色卡的樣子。 */
let ch3Prompt = '';
let linWhenCh3 = '';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('你是長篇小說的連續性編輯')) {
    return JSON.stringify({ conflicts: [] });
  }
  // 敘事線認事件（每次定稿都跑）：這本書還沒有線，什麼都認不出。
  if (system.includes('你是小說定稿事實審查員')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (system.includes('建立可檢索的章節檔案')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({
      梗概: `第 ${no} 章：林昭又受了傷。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖鎮。',
      关键事件: [`第 ${no} 章的事`],
      状态变更: '',
      连续性事实: [`林昭在第${no}章左臂受傷流血`, `沈氏在第${no}章吹滅了第${no}盞燈`],
    });
  }
  if (system.includes('依據本章正文更新角色的「當前狀態」')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({
      updates: [
        { name: '林昭', 当前状态: `第 ${no} 章之後：左臂有 ${no} 處傷，還在青崖鎮。` },
        { name: '沈氏', 当前状态: `第 ${no} 章之後：守著客棧。` },
      ],
    });
  }
  // 寫正文那一次：執行卡重列的必需事件以「第 N 章」開頭，靠它認是哪一章。
  const card = /- 必需事件：第 (\d+) 章/.exec(user);
  if (card) {
    const no = Number(card[1]);
    if (no === 2) {
      // 第 1 章已經定稿：作者這時候手改了沈氏的當前狀態。
      const card = t.read(SHEN);
      t.write(SHEN, card.replace(/## 當前狀態\n\n[^\n]*/, `## 當前狀態\n\n${AUTHOR_STATE}`));
    }
    if (no === 3) {
      ch3Prompt = user;
      linWhenCh3 = t.read(LIN);
    }
    return { text: chapterText(no), stop: 'end' };
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    progress: './src/core/runtime/progress.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    stateModel: './src/core/model/characterState.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
    config: './src/core/config.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  // 近章全文 0 章、其餘照預設那一級：沒有哪一級是這個組合，只能單項覆蓋（作者那邊只有級別可選）。
  bundle.config.setContextLimitsOverride({ fullTextChapters: 0 });
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  bundle.progress.onTaskFinished((x) => finished.push(x));

  t = await makeTempProject(bundle.project, { prefix: 'phase4', title: '青崖記' });
  project = t.project;
  t.write('.novelwarden/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  // 架構四件與大綱都在（二期那一段的產物），主按鈕才會落到單章上。
  t.write('.novelwarden/premise.md', '# 故事前提\n\n## 一句話前提\n\n林昭回鎮，必須找出放火的人。\n\n## 核心衝突鏈\n\n回鎮 → 受傷 → 追查。\n');
  t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n名冊決定誰算鎮上的人。\n');
  writeOutline(t, outlineOf(20, { text: { 1: '林昭進鎮，一路受傷一路查。' } }));
  const ws = new bundle.ws.Workspace(project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: {
        ...bundle.plotFile.emptyPlotSections(),
        梗概: `第 ${no} 章的目的`,
        出场人物: '林昭、沈氏',
        关键事件: `第 ${no} 章林昭又往前查了一步。`,
        看点: `第 ${no} 章結尾：又一個人不見了。`,
      },
    });
  }
  // 兩張卡都是角色圖譜建的：開篇狀態、歸機器（與 acceptRoster 蓋的章一樣）。
  for (const [rel, name, state] of [[LIN, '林昭', '剛回到青崖鎮。'], [SHEN, '沈氏', '客棧老闆娘。']]) {
    await ws.writeCharacter(
      bundle.stateModel.stampState(
        {
          slug: name,
          name,
          aliases: [],
          tags: name === '林昭' ? ['主角'] : [],
          sections: { ...bundle.project.emptyCharacterSections(), 身份: `${name}的身份`, 当前状态: state },
        },
        0
      )
    );
    assert.ok(t.has(rel));
  }
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  // 與工程頁彈窗提交的那一條一樣：彈窗已經報過呼叫次數，帶 call（作者在彈窗上沒改模型與詳細度）。
  await controller.handle({
    type: 'projectAction',
    action: 'writeManuscripts',
    range: { from: 1, to: 3 },
    mode: 'finalize',
    call: {},
  });
});

after(() => {
  controller?.dispose();
  bundle?.config.setContextLimitsOverride(undefined);
  if (t) cleanup(t.dir, bundle?.db);
});

describe('四期驗收：批次寫章第 1–3 章、寫完即定稿', () => {
  test('三章正文都在，第 4 章沒寫', () => {
    for (const no of [1, 2, 3]) {
      assert.ok(t.has(CH(no)), CH(no));
    }
    assert.ok(!t.has(CH(4)));
  });

  // 定稿 = 同一份細綱照正文反向更新，sourceHash 記下正文那時的指紋。
  test('三份細綱都定了稿：sourceHash 對得上正文', async () => {
    project.invalidate();
    for (const no of [1, 2, 3]) {
      const chapter = await project.getChapter(no);
      assert.equal((await project.getPlot(no)).sourceHash, chapter.contentHash, `第 ${no} 章`);
    }
  });

  test('細綱裡的連續性事實每條都帶一句正文原句', async () => {
    for (const no of [1, 2, 3]) {
      const s = await project.getPlot(no);
      const facts = s.sections.连续性事实.split('\n').filter(Boolean);
      assert.equal(facts.length, 2, s.sections.连续性事实);
      for (const f of facts) {
        const quote = /〔證據：「(.+)」〕$/.exec(f)?.[1];
        assert.ok(quote && t.read(CH(no)).includes(quote), f);
      }
    }
  });

  test('第 2 章定稿後，林昭的當前狀態換成了第 2 章那一版', () => {
    assert.match(linWhenCh3, /## 當前狀態\n\n第 2 章之後：左臂有 2 處傷，還在青崖鎮。/);
    assert.match(linWhenCh3, /stateThrough: 2/);
  });

  test('第 3 章寫正文時：角色卡是第 2 章更新過的狀態', () => {
    assert.ok(ch3Prompt.includes('第 2 章之後：左臂有 2 處傷，還在青崖鎮。'), ch3Prompt.slice(0, 2000));
  });

  test('第 3 章寫正文時：定稿原文片段裡有第 2 章證據所在的那一段', () => {
    const at = ch3Prompt.indexOf('# 定稿原文片段');
    assert.ok(at > 0, '沒有原文片段那一節');
    const section = ch3Prompt.slice(at, ch3Prompt.indexOf('\n---\n', at));
    assert.ok(section.includes('林昭在第2章受了第2處傷，血順著左臂往下淌。'), section.slice(0, 800));
    assert.ok(section.includes('林昭在第1章受了第1處傷'), section.slice(0, 800));
  });

  test('作者手改過的沈氏：後兩章定稿都沒覆蓋，卡上掛黃 ❗', async () => {
    assert.ok(t.read(SHEN).includes(AUTHOR_STATE), t.read(SHEN));
    const [f] = (await bundle.errorLog.listActiveFailures(project))[SHEN] ?? [];
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'cardState');
    assert.match(f.message, /第 3 章同步時給出了新的「當前狀態」/);
  });

  test('林昭最後是第 3 章的狀態；工程頁的角色行寫著「狀態截至第 3 章」', async () => {
    assert.match(t.read(LIN), /第 3 章之後：左臂有 3 處傷/);
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    const lin = tree.characters.find((n) => n.relPath === LIN);
    assert.match(lin.detail, /狀態截至第 3 章/);
  });

  // 寫前衝突檢查：第 1 章前面沒有定稿過的章，不調；第 2、3 章各一次。
  test('一共 17 次：一章寫一次、更新細綱一次、角色狀態一次、認敘事線一次、故事時間一次，第 2、3 章寫前各比對一次；沒超過確認框的上限', () => {
    assert.equal(fake.callCount(), 17);
    const plan = bundle.pipelineModel.planWriteBatch({ from: 1, to: 3, mode: 'finalize', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5] });
    assert.ok(fake.callCount() <= plan.calls.max);
  });

  test('完成提示：寫好 3 章、定稿 3 章，帶「開啟第 3 章」', () => {
    const f = finished.find((x) => x.title === '批次寫章');
    assert.equal(f.message, '第 1–3 章已寫好，同步 3 章（呼叫 17 次）。');
    assert.deepEqual(f.open, { plotRelPath: PLOT(3), label: '開啟第 3 章' });
  });

  test('主按鈕轉去第 4 章', async () => {
    const out = [];
    controller.attach({ kind: 'sidebar', post: (m) => out.push(m), reveal() {} });
    await controller.handle({ type: 'requestPipeline' });
    const next = out.filter((m) => m.type === 'pipeline').pop()?.next;
    assert.equal(next?.label, '寫第 4 章', JSON.stringify(next));
  });
});

