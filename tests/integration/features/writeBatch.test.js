/**
 * 批次寫章（四期，D10）：嚴格序列地一章一章寫，續寫鏈與對話頁同一份。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 確認框報區間、模式與上限，彈窗確認過的不再問 | 第 4 條；W9 不疊彈窗 |
 * | 已有正文的跳過，第一章沒細綱的在它前面收住 | 第 19 條批次那一面；後一章要接著前一章寫 |
 * | 寫完即定稿：寫一章、定稿一章（拿細綱與正文對照，把細綱改成正文寫成的樣子），再寫下一章 | D17：自動定稿只在這裡 |
 * | 一章寫不出來就停，後面的不寫 | 失敗即停：後面的章接不上 |
 * | 重演、沒寫夠：寫進去然後停，掛黃 ❗ | 錢已經花了（D6），但不能踩著有問題的結尾往下寫 |
 * | 後面幾章才登場的人提前寫進來：同上 | 五期補遺 §1.2：下一章要從他第一次露面寫起 |
 * | 寫完這一章就停 / 停止 | 只在章與章之間停；停止時正在寫的那一章不落盤 |
 * | 一章之內續寫那幾輪不換模型 | 一章寫到一半換人，文風斷在段落中間 |
 * | 完成提示帶「開啟第 N 章」 | D24 |
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
let settings;
/** 這一次該答什麼。按用例換。 */
let replyFn;
const finished = [];

const pad3 = (n) => String(n).padStart(3, '0');
const TITLES = ['停舟', '令牌', '夜訪', '井', '名冊'];
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.txt`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;

/**
 * 按執行卡裡重列的必需事件認是第幾章在寫（續寫那幾輪另有契約）。每章的關鍵事件都以
 * 「第 N 章」開頭（{@link planSections} 與拆細綱的假應答），執行卡只剩這一項能認章。
 */
function chapterOf(messages) {
  const user = messages[messages.length - 1].content;
  if (user.includes('請無縫續寫當前章節正文')) {
    return { continuation: true };
  }
  const m = /- 必需事件：第 (\d+) 章/.exec(user);
  return m ? { no: Number(m[1]) } : {};
}

/**
 * 寫正文之前排好的一份細綱（計劃）：梗概、計劃出場、關鍵事件、看點（章末鉤子並進了看點）；
 * 連續性事實是空的——定稿時才從正文裡摘。
 */
function planSections(no, { cast = '林昭', events = `第 ${no} 章林昭查到一點東西。` } = {}) {
  return {
    ...bundle.plotFile.emptyPlotSections(),
    梗概: `第 ${no} 章的目的`,
    出场人物: cast,
    关键事件: events,
    看点: `第 ${no} 章結尾：又一個人不見了。`,
  };
}

/** 磁碟上第 N 章的細綱。有 `sourceHash` = 定稿過（細綱照正文反向更新過）。 */
function plotOf(t, no) {
  return bundle.plotFile.parsePlotFile(t.read(PLOT(no)), PLOT(no));
}

/** 定稿那一次（照正文更新細綱）。有細綱時系統提示是 REFINE_SYSTEM，它以 SUMMARY_SYSTEM 開頭，同一句都認得出。 */
function isSummary(messages) {
  return (messages[0]?.content ?? '').includes('建立可檢索的章節檔案');
}
function isState(messages) {
  return (messages[0]?.content ?? '').includes('依據本章正文更新角色的「當前狀態」');
}
function isReview(messages) {
  return (messages[0]?.content ?? '').includes('嚴謹的小說審稿編輯');
}
/** 定稿第三步認敘事線（敘事線重做：每次定稿都跑，線是空的也跑）。 */
function isFind(messages) {
  return (messages[0]?.content ?? '').includes('你是小說定稿事實審查員');
}
const NOTHING_FOUND = JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
/** 定稿最後一步認故事時間（2026-10-24 重做：單獨一次）。 */
function isTime(messages) {
  return (messages[0]?.content ?? '').includes(TIME_MARK);
}

/** 預設的應答：正文一次寫夠，定稿（照正文更新細綱）與狀態各給一份，敘事線什麼都認不出。 */
function defaultReply(messages) {
  if (isFind(messages)) {
    return NOTHING_FOUND;
  }
  if (isTime(messages)) {
    return timeReply(messages);
  }
  if (isSummary(messages)) {
    const no = Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
    return JSON.stringify({
      梗概: `第 ${no} 章的事。`,
      出场人物: [{ name: '林昭', aliases: [] }],
      关键事件: [],
      连续性事实: [],
    });
  }
  if (isState(messages)) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '往北去了' }] });
  }
  const { no, continuation } = chapterOf(messages);
  if (continuation) {
    return { text: filler(400, 900), stop: 'end' };
  }
  return { text: filler(700, no * 100), stop: 'end' };
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    batch: './src/core/features/pipelineBatch.ts',
    summarize: './src/core/features/summarize.ts',
    plotFile: './src/core/model/plotFile.ts',
    progress: './src/core/runtime/progress.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    behavior: { 'p/broken': 'fail' },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  bundle.progress.onTaskFinished((t) => finished.push(t));
});

/** 一個排好前 5 章細綱的新工程。`written` 裡的章先寫好正文，`blank` 裡的章只有骨架。 */
async function fresh(prefix, { written = [], blank = [] } = {}) {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }, { name: 'broken', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 4,
  };
  const t = await makeTempProject(bundle.project, { prefix, title: '批次寫章' });
  t.write('.novelwarden/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 600\n---\n\n# 小說配置\n\n## 核心梗概\n\n回鎮查案。\n');
  const ws = new bundle.ws.Workspace(t.project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: blank.includes(no) ? bundle.plotFile.emptyPlotSections() : planSections(no),
    });
  }
  for (const no of written) {
    t.write(CH(no), `# ${TITLES[no - 1]}\n\n作者自己寫的第 ${no} 章。\n`);
  }
  t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤兒\n\n## 當前狀態\n\n（待補充）\n');
  t.project.invalidate();
  fake.reset();
  h.toasts.length = 0;
  h.confirms.length = 0;
  h.answers.length = 0;
  finished.length = 0;
  replyFn = defaultReply;
  return t;
}

async function failuresOf(t, key) {
  return (await bundle.errorLog.listActiveFailures(t.project))[key] ?? [];
}

describe('只寫正文：下一可寫章起 3 章', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-draft');
    h.expect('開始寫章');
    calls = await bundle.batch.writeManuscripts(t.project);
  });
  after(() => cleanup(t.dir, bundle.db));

  // 寫前比對 2026-10-25 起多一次轉寫：比對 1 次、轉寫 1 次、重轉 1 次。
  test('確認框報區間、模式與上限（一章最多 9 次，寫前比對最多 3 次）', () => {
    const c = h.confirms[0];
    assert.equal(c.message, '第 1–3 章：要寫 3 章正文（只寫正文），預計 3–12 次呼叫，最多 36 次。現在寫？');
    assert.match(c.detail, /一章一章序列寫/);
  });

  // 寫前比對要轉寫：沒有要拆的細綱、沒開審稿也單列轉寫交給誰（不跟這一次挑的模型）。
  test('確認框單列轉寫交給誰', () => {
    const c = h.confirms[0];
    assert.ok(c.call.fixed?.some((x) => x.startsWith('轉寫') && x.includes('不跟這一次挑的模型')), JSON.stringify(c.call));
  });

  test('寫了 3 章，一章一次，不看併發設定', () => {
    assert.equal(calls, 3);
    assert.deepEqual(fake.calls.map((m) => chapterOf(m).no), [1, 2, 3]);
    // 正文是 .txt（2026-10-24）：純文字，不寫標題行。
    for (const no of [1, 2, 3]) {
      assert.ok(t.has(CH(no)) && !t.read(CH(no)).startsWith('#'), CH(no));
    }
    assert.ok(!t.has(CH(4)));
  });

  // 後一章接著前一章寫：第 2 章裝配的時候，第 1 章已經落盤了。
  test('後一章的裝配裡有前一章的結尾', () => {
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(user.includes('上一章結尾原文') || user.includes('前文正文'), user.slice(0, 300));
    assert.ok(user.includes(filler(700, 100).slice(-40)));
  });

  test('細綱上記了 writtenFrom', () => {
    assert.ok(plotOf(t, 1).writtenFrom);
  });

  // 細綱與定稿是同一份檔案：沒定稿 = 檔案還在、只是沒有 sourceHash。
  test('只寫正文不定稿：細綱上沒有 sourceHash', () => {
    assert.equal(plotOf(t, 1).sourceHash, '');
  });

  test('完成提示帶「開啟第 3 章」', () => {
    const f = finished.find((x) => x.title === '批次寫章');
    assert.equal(f.message, '第 1–3 章已寫好（呼叫 3 次）。');
    assert.deepEqual(f.open, { plotRelPath: PLOT(3), label: '開啟第 3 章' });
  });
});

describe('寫完即定稿；已有正文的跳過；彈窗確認過的不再問', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('wb-finalize', { written: [2] });
    calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('不彈確認框', () => {
    assert.equal(h.confirms.length, 0);
  });

  test('寫一章、定稿一章（更新細綱 + 角色狀態 + 認敘事線 + 故事時間），再寫下一章；第 2 章跳過', () => {
    const order = fake.calls.map((m) => (isSummary(m) ? 'summary' : isState(m) ? 'state' : isFind(m) ? 'threads' : isTime(m) ? 'time' : `write:${chapterOf(m).no}`));
    assert.deepEqual(order, ['write:1', 'summary', 'state', 'threads', 'time', 'write:3', 'summary', 'state', 'threads', 'time']);
    assert.equal(calls, 10);
  });

  test('作者寫的第 2 章一個字沒動', () => {
    assert.equal(t.read(CH(2)), '# 令牌\n\n作者自己寫的第 2 章。\n');
  });

  // 手上有細綱（寫之前排的計劃）：定稿是拿它和正文對照著改，不是照正文從頭整理。
  test('定稿帶上當前細綱：系統提示是 REFINE_SYSTEM', () => {
    assert.ok(fake.calls.filter(isSummary).every((m) => m[0].content.includes('關於「當前細綱」')));
  });

  // 定稿是把細綱照正文反向更新：sourceHash 記的是正文那時的指紋。
  test('兩章都定了稿：細綱的 sourceHash 對得上正文', async () => {
    t.project.invalidate();
    for (const no of [1, 3]) {
      assert.equal(plotOf(t, no).sourceHash, (await t.project.getChapter(no)).contentHash, `第 ${no} 章`);
    }
  });

  test('角色狀態更新到第 3 章', () => {
    assert.match(t.read('.novelwarden/characters/林昭.md'), /stateThrough: 3/);
  });

  test('完成提示說定稿了幾章', () => {
    assert.match(finished.find((x) => x.title === '批次寫章').message, /同步 2 章/);
  });
});

describe('第一章沒細綱的在它前面收住', () => {
  let t;
  before(async () => {
    // 第 3–5 章是空骨架、連梗概都沒有：情節大綱（各章細綱梗概的彙總）只覆蓋到第 2 章。
    t = await fresh('wb-noplot', { blank: [3, 4, 5] });
    h.expect('開始寫章');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 5 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('沒有情節大綱：寫到第 2 章為止，確認框裡說了為什麼', () => {
    assert.match(h.confirms[0].message, /^第 1–2 章：要寫 2 章正文/);
    assert.match(h.confirms[0].detail, /第 3 章還沒有細綱、情節大綱也沒覆蓋到它，寫到它前面為止/);
    assert.ok(t.has(CH(2)) && !t.has(CH(3)) && !t.has(CH(4)));
  });
});

describe('一章寫不出來就停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-fail');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        throw new Error('假裝服務商 500');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章寫好了，第 2、3 章沒寫', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)) && !t.has(CH(3)));
  });

  test('紅 ❗ 掛在第 2 章的細綱上', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'error');
    assert.match(f.message, /假裝服務商 500/);
  });

  test('提示說清停在哪、後面還有幾章', () => {
    const f = finished.find((x) => x.title === '批次寫章');
    assert.equal(f.level, 'error');
    assert.match(f.message, /第 1 章已寫好。第 2 章沒寫成（假裝服務商 500），批次停在這裡。後面的第 3 章沒寫。/);
  });
});

describe('重演：寫進去，然後停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-replay');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const ch1 = t.read(CH(1)).trim();
        return { text: `${ch1.slice(-200)}\n\n${filler(700, 555)}`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章寫進去了、沒定稿；第 3 章沒寫', () => {
    assert.ok(t.has(CH(2)));
    assert.equal(plotOf(t, 2).sourceHash, '');
    assert.ok(!t.has(CH(3)));
  });

  test('黃 ❗ 掛在第 2 章上，寫明原因', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /開頭與上一章結尾大段重合/);
  });

  test('提示的按鈕開啟的是停下的那一章', () => {
    const f = finished.find((x) => x.title === '批次寫章');
    assert.match(f.message, /第 2 章寫進去了，但開頭與上一章結尾大段重合/);
    assert.deepEqual(f.open, { plotRelPath: PLOT(2), label: '開啟第 2 章' });
  });
});

describe('後面幾章才登場的人提前寫了進來：寫進去，然後停（五期補遺 §1.2）', () => {
  let t;
  before(async () => {
    t = await fresh('wb-early');
    // 第 3 章才排沈秋；第 2 章的結尾把他寫了出來。
    const ws = new bundle.ws.Workspace(t.project);
    await ws.writePlot({
      no: 3,
      title: TITLES[2],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: planSections(3, { cast: '林昭、沈秋', events: '第 3 章林昭遇見沈秋。' }),
    });
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        return { text: `${filler(700, 556)}\n\n巷口站著一個人，是沈秋。`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 2 章寫進去了、沒定稿；第 3 章沒寫', () => {
    assert.ok(t.has(CH(2)));
    assert.equal(plotOf(t, 2).sourceHash, '');
    assert.ok(!t.has(CH(3)));
  });

  test('黃 ❗ 掛在第 2 章上，寫明是誰', async () => {
    const [f] = await failuresOf(t, PLOT(2));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /第 3 章才登場的沈秋提前寫進了這一章/);
  });

  test('寫第 2 章時執行卡後面就點了名', () => {
    const asked = fake.calls.map((c) => c[c.length - 1].content).find((u) => /- 必需事件：第 2 章/.test(u));
    assert.match(asked, /本章不出場：沈秋（第 3 章才登場）/);
  });
});

describe('續寫到最後仍不到八成：寫進去，然後停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-short');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      return { text: filler(100, chapterOf(messages).continuation ? 7 : 8), stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章寫了（續寫過一輪），第 2 章沒寫', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.equal(fake.callCount(), 2);
  });

  test('黃 ❗：不到目標的八成', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /不到目標的八成/);
  });
});

describe('結尾停在半句上、續寫也沒接完：寫進去，然後停', () => {
  let t;
  before(async () => {
    t = await fresh('wb-half');
    replyFn = (messages) => {
      if (isSummary(messages) || isState(messages)) {
        return defaultReply(messages);
      }
      // 第一次字數夠了、停在半句上；續寫那兩輪都只多幾個字。
      return chapterOf(messages).continuation ? { text: '的骨頭', stop: 'end' } : { text: `${filler(700, 9).slice(0, -1)}，全身`, stop: 'end' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('第 1 章寫了、沒定稿，第 2 章沒寫', () => {
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.equal(plotOf(t, 1).sourceHash, '');
  });

  test('黃 ❗：結尾停在半句上', async () => {
    const [f] = await failuresOf(t, PLOT(1));
    assert.equal(f.severity, 'warn');
    assert.match(f.message, /結尾停在半句上/);
  });
});

// ---------------------------------------------------------------- 邊寫邊拆細綱、寫前衝突檢查（百章實驗覆盤）

const OUTLINE = outlineOf(10, { text: { 1: '林昭回鎮查案。' } });

/** 按契約裡寫的區間應答一批細綱（新合同：七節裡除連續性事實之外的欄位）。 */
function blueprintsFor(messages) {
  const user = messages[messages.length - 1].content;
  const m = /寫第 (\d+)(?:–(\d+))? 章的細綱：/.exec(user);
  const from = Number(m?.[1] ?? 1);
  const to = Number(m?.[2] ?? from);
  const blueprints = [];
  for (let no = from; no <= to; no++) {
    blueprints.push({
      chapterNumber: no,
      title: TITLES[no - 1] ?? `第${no}章`,
      synopsis: `第 ${no} 章的目的`,
      characters: ['林昭'],
      timePlace: '',
      keyEvents: [`第 ${no} 章林昭又查到一點東西。`],
      highlights: [`第 ${no} 章結尾：又一個人不見了。`],
      foreshadowing: [],
      stateChange: '',
    });
  }
  return JSON.stringify({ blueprints });
}
const isBlueprint = (messages) => /寫第 \d+(?:–\d+)? 章的細綱：/.test(messages[messages.length - 1].content);
const isPlotCheck = (messages) => (messages[0]?.content ?? '').includes('你是長篇小說的連續性編輯');
const isEvents = isFind;
const isThreads = (messages) => (messages[0]?.content ?? '').includes('只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線');

/** 每章正文帶一句可查證的事實；定稿把它記成細綱裡的連續性事實。 */
function factfulReply(conflicts = () => []) {
  return (messages) => {
    if (isBlueprint(messages)) {
      return blueprintsFor(messages);
    }
    if (isPlotCheck(messages)) {
      return JSON.stringify({ conflicts: conflicts(messages) });
    }
    if (isEvents(messages)) {
      return NOTHING_FOUND;
    }
    if (isTime(messages)) {
      return timeReply(messages);
    }
    if (isSummary(messages)) {
      const no = Number(/【第(\d+)章/.exec(messages[messages.length - 1].content)?.[1] ?? 0);
      return JSON.stringify({ 梗概: '事。', 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [], 连续性事实: [`林昭在第${no}章丟了第${no}塊玉佩`] });
    }
    const { no, continuation } = chapterOf(messages);
    if (!isState(messages) && !continuation && no) {
      return { text: `林昭在第${no}章丟了第${no}塊玉佩。\n\n${filler(700, no * 100)}`, stop: 'end' };
    }
    return defaultReply(messages);
  };
}

describe('邊寫邊拆細綱：大綱覆蓋之內沒細綱的章，寫到時先拆這一批', () => {
  let t;
  let order;
  let blueprintPrompt;
  before(async () => {
    t = await fresh('wb-rolling', { blank: [3, 4, 5] });
    writeOutline(t, OUTLINE);
    t.project.invalidate();
    replyFn = factfulReply();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 4 }, mode: 'finalize', call: {} });
    order = fake.calls.map((m) =>
      isBlueprint(m) ? 'plots' : isThreads(m) ? 'threads' : isEvents(m) ? 'events' : isTime(m) ? 'time' : isPlotCheck(m) ? 'check' : isSummary(m) ? 'summary' : isState(m) ? 'state' : `write:${chapterOf(m).no}`
    );
    blueprintPrompt = fake.calls.find(isBlueprint)?.at(-1).content ?? '';
  });
  after(() => cleanup(t.dir, bundle.db));

  // 敘事線重做：拆完不再排線（計劃隨細綱寫進線裡）；定稿每次都認一遍敘事線（線是空的也認）、推一次故事時間。
  test('寫完第 2 章、定稿之後才拆第 3–4 章（只拆這次要寫的），拆完不排敘事線；第 1 章前面沒定稿的章，不比對', () => {
    assert.deepEqual(order, [
      'write:1', 'summary', 'state', 'events', 'time',
      'check', 'write:2', 'summary', 'state', 'events', 'time',
      'plots', 'check', 'write:3', 'summary', 'state', 'events', 'time',
      'check', 'write:4', 'summary', 'state', 'events', 'time',
    ]);
    // 一條線都沒排：敘事線目錄裡只有同步時推出來的時間線。
    assert.ok(!t.has('.novelwarden/threads/未归属的伏笔.md'));
    assert.ok(t.has('.novelwarden/threads/时间线.md'));
  });

  test('拆細綱的時候看得見前面定稿的連續性事實', () => {
    assert.ok(blueprintPrompt.includes('林昭在第2章丟了第2塊玉佩'), blueprintPrompt.slice(0, 1500));
    assert.ok(blueprintPrompt.includes('既成歷史'));
  });

  test('第 3、4 章的正文寫了；區間外的第 5 章沒寫', () => {
    assert.ok(t.has(CH(3)) && t.has(CH(4)) && !t.has(CH(5)));
  });

  // 第 4 章寫完即定稿，細綱已經照正文反向更新過了；拆出來的那一版要在寫它的那次呼叫裡找。
  test('第 4 章照剛拆出來的細綱寫：執行卡重列的是拆出來的關鍵事件', () => {
    const users = fake.calls.map((c) => c[c.length - 1].content);
    assert.ok(users.some((u) => u.includes('- 必需事件：第 4 章林昭又查到一點東西。')));
  });

  test('區間外的第 5 章細綱不動：仍是空的', () => {
    assert.equal(plotOf(t, 5).sections.关键事件, '');
  });
});

// 百章實驗裡全文大綱從沒生成過：它只有「重建」一個入口。批次定稿每落後 10 章增量更新一次。
describe('全文大綱增量更新', () => {
  let t;
  const users = [];
  const runner = {
    primaryBudget: { contextWindow: 100000, maxOutputTokens: 2000 },
    run: (_what, fn) =>
      fn({
        stream: async function* (messages) {
          users.push(messages[messages.length - 1].content);
          yield { type: 'text', text: `## 主線進展\n\n第 ${users.length} 版：林昭一路丟玉佩。` };
        },
      }),
  };
  before(async () => {
    t = await fresh('wb-global');
    replyFn = factfulReply();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  // 全文大綱的輸入是定稿過的細綱（單章摘要那一份已經並進細綱了）。
  test('還沒有全文大綱：從第 1 章起彙總定稿過的細綱，through 記到最後一章', async () => {
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 2 });
    assert.match(users[0], /第 1–2 章定稿過的逐章細綱/);
    assert.match(t.read('.novelwarden/summaries/global.md'), /through: 2[\s\S]*第 1 版：林昭一路丟玉佩/);
  });

  test('之後只併入新定稿的章，舊的全文大綱一起帶上；沒有新章就零呼叫', async () => {
    t.project.invalidate();
    await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 }, mode: 'finalize', call: {} });
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 3 });
    assert.match(users[1], /截至第 2 章/);
    assert.match(users[1], /第 1 版：林昭一路丟玉佩/);
    assert.match(users[1], /【第3章/);
    assert.doesNotMatch(users[1], /【第2章/);
    const again = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.equal(again.calls, 0);
  });

  // 全文大綱（原全書摘要）只剩「主線進展」：老檔案裡另外三節當認不出的小節，留在檔案裡、不交給模型，下一版只寫主線。
  test('老格式（全書摘要四節）：另外三節不讀、不交給模型，檔案裡還在', async () => {
    const old = t.read('.novelwarden/summaries/global.md').replace(
      /\n*$/,
      '\n\n## 已收伏筆\n\n- 玉佩之謎（第 1 章）\n\n## 未收伏筆\n\n- 斷劍之謎\n\n## 人物關係變動\n\n- 林昭與沈青結盟\n'
    );
    t.write('.novelwarden/summaries/global.md', old);
    t.project.invalidate();
    const read = await t.project.readGlobalSummary();
    assert.match(read, /## 主線進展[\s\S]*第 2 版：林昭一路丟玉佩/);
    assert.doesNotMatch(read, /已收伏筆|斷劍之謎|人物關係變動|林昭與沈青結盟/);
    assert.match(t.read('.novelwarden/summaries/global.md'), /## 未收伏筆\n\n- 斷劍之謎/);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 4, to: 4 }, mode: 'finalize', call: {} });
    const r = await bundle.summarize.updateGlobalSummary(t.project, runner);
    assert.deepEqual(r, { calls: 1, through: 4 });
    assert.match(users[2], /第 2 版：林昭一路丟玉佩/);
    assert.doesNotMatch(users[2], /斷劍之謎|林昭與沈青結盟/);
  });

  test('模板與寫回的檔案：H1 是「全文大綱」，只有「主線進展」一節', () => {
    const text = t.read('.novelwarden/summaries/global.md');
    assert.match(text, /\n# 全文大綱\n\n## 主線進展\n/);
    assert.doesNotMatch(text, /未收伏筆|人物關係變動/);
  });
});

describe('寫前衝突檢查：細綱與前面定稿的事實對不上，停在那一章前面', () => {
  test('對得上原文的衝突：停下、掛黃 ❗，說清是哪兩句', async () => {
    const t = await fresh('wb-plotcheck');
    replyFn = factfulReply(() => [
      { plot: '第 2 章林昭查到一點東西', fact: '林昭在第1章丟了第1塊玉佩', chapter: 1, why: '玉佩已經丟了' },
      { plot: '細綱裡沒有這句', fact: '林昭在第1章丟了第1塊玉佩', chapter: 1, why: '編的' },
    ]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const f = finished.find((x) => x.title === '批次寫章');
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(f.message, /第 2 章的細綱與前面同步下來的事實有 1 處對不上/, f.message);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(
      fails.some((x) => x.op === 'plotCheck' && /細綱「第 2 章林昭查到一點東西」與第 1 章同步下來的事實「林昭在第1章丟了第1塊玉佩」矛盾：玉佩已經丟了/.test(x.message)),
      JSON.stringify(fails)
    );
    assert.match(fails[0].detail, /factCheckOk: true/);
    cleanup(t.dir, bundle.db);
  });

  test('細綱上記了 factCheckOk：不比對，照寫', async () => {
    const t = await fresh('wb-plotcheck-ok');
    t.write(PLOT(2), t.read(PLOT(2)).replace('targetWords: 600', 'targetWords: 600\nfactCheckOk: true'));
    t.project.invalidate();
    replyFn = factfulReply(() => [{ plot: '第 2 章林昭查到一點東西', fact: '林昭在第1章丟了第1塊玉佩', chapter: 1, why: '玉佩已經丟了' }]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(t.has(CH(2)));
    assert.ok(!fake.calls.some(isPlotCheck));
    cleanup(t.dir, bundle.db);
  });
});

// 2026-10-25 起改成轉寫：比對的模型按格式寫（兩句原句用「」括起來），轉寫模型照抄成 JSON；只寫「無矛盾」的不轉。
const isTranscribe = (messages) => (messages[0]?.content ?? '').includes('格式轉寫員');

describe('寫前衝突檢查 · 按格式寫，轉寫模型照抄成 JSON', () => {
  const PROSE = ['### 矛盾 1', '細綱：「第 2 章林昭查到一點東西」', '事實：「林昭在第1章丟了第1塊玉佩」（第 1 章）', '為什麼：玉佩已經丟了'].join('\n');
  const conflict = (plot) => JSON.stringify({ conflicts: [{ plot, fact: '林昭在第1章丟了第1塊玉佩', chapter: 1, why: '玉佩已經丟了' }] });
  const COPIED = conflict('第 2 章林昭查到一點東西');

  /** 比對的那一次答 `check`，轉寫那幾次按順序答 `copies`（答完了再來就是測試寫錯了）。 */
  function proseReply(check, copies = []) {
    const base = factfulReply();
    const queue = [...copies];
    return (messages) => {
      if (isTranscribe(messages)) return queue.shift() ?? '（轉寫不該再被呼叫）';
      if (isPlotCheck(messages)) return check;
      return base(messages);
    };
  }

  test('有矛盾：比對寫一段、轉寫照抄一次（只帶合同與原文）；停在第 2 章前面，掛黃 ❗', async () => {
    const t = await fresh('wb-check-prose');
    replyFn = proseReply(PROSE, [COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const check = fake.calls.find(isPlotCheck);
    assert.match(check[0].content, /不寫 JSON/);
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 1);
    const user = copies[0].at(-1).content;
    assert.ok(user.includes('【寫前衝突檢查 JSON 合同】') && user.includes(`【原文】\n${PROSE}`), user);
    assert.ok(!user.includes('# 前面各章定稿的連續性事實'), user);
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(
      fails.some((x) => x.op === 'plotCheck' && /細綱「第 2 章林昭查到一點東西」與第 1 章同步下來的事實「林昭在第1章丟了第1塊玉佩」矛盾：玉佩已經丟了/.test(x.message)),
      JSON.stringify(fails)
    );
    cleanup(t.dir, bundle.db);
  });

  test('只寫了「無矛盾」：不轉寫，照寫', async () => {
    const t = await fresh('wb-check-none');
    replyFn = proseReply('無矛盾');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(t.has(CH(2)));
    assert.ok(fake.calls.some(isPlotCheck));
    assert.ok(!fake.calls.some(isTranscribe));
    cleanup(t.dir, bundle.db);
  });

  test('轉寫改了原句：重轉一次，說清哪一處不是原文裡的字', async () => {
    const t = await fresh('wb-check-reword');
    replyFn = proseReply(PROSE, [conflict('第 2 章林昭又查到了東西'), COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 2);
    assert.ok(copies[1].at(-1).content.includes('【上次轉寫不合格】這幾處不是原文裡的字：「第 2 章林昭又查到了東西」'), copies[1].at(-1).content.slice(0, 800));
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    cleanup(t.dir, bundle.db);
  });

  // 原來解析失敗的走法：這一步沒做成，記一句、照寫（檢查是額外的一道）。
  test('轉寫呼叫失敗：這一步沒做成，照寫', async () => {
    const t = await fresh('wb-check-transcribe-fail');
    settings.tierModels = { quality: ['p/broken'] };
    settings.taskTiers = { transcribe: 'quality' };
    replyFn = proseReply(PROSE, [COPIED, COPIED]);
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    assert.ok(fake.calls.some((c) => isTranscribe(c) && c.ref === 'p/broken'));
    assert.ok(t.has(CH(2)));
    assert.ok(!(await failuresOf(t, PLOT(2))).some((x) => x.op === 'plotCheck'));
    cleanup(t.dir, bundle.db);
  });
});

describe('寫完這一章就停；停止', () => {
  test('點了「寫完這一章就停」：這一章寫完、落盤，然後收', async () => {
    const t = await fresh('wb-pause');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 1) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批次寫章');
        assert.equal(task.pausable, true);
        assert.ok(bundle.progress.requestStop(task.id));
        assert.equal(bundle.progress.activeTasks().find((x) => x.id === task.id).stopping, true);
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(finished.find((x) => x.title === '批次寫章').message, /寫完第 1 章停下了。後面的第 2–3 章沒寫。/);
    cleanup(t.dir, bundle.db);
  });

  test('點了「停止」：正在寫的那一章不落盤', async () => {
    const t = await fresh('wb-cancel');
    replyFn = (messages) => {
      if (chapterOf(messages).no === 2) {
        const task = bundle.progress.activeTasks().find((x) => x.title === '批次寫章');
        bundle.progress.cancelTask(task.id);
        throw new bundle.provider.CancelledError();
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.deepEqual(await failuresOf(t, PLOT(2)), []);
    cleanup(t.dir, bundle.db);
  });
});

describe('一章之內續寫那幾輪不換模型', () => {
  let t;
  let answered = 0;
  before(async () => {
    t = await fresh('wb-pin');
    // 首選壞了：第一次呼叫換到同檔的第二個；之後續寫那幾輪直接用它，不再先去碰壞的那個。
    settings.models = ['p/broken', 'p/m'];
    settings.fallbackAttempts = 1;
    // 壞的那個在應答之前就拋了：走到這裡的每一次都是好的那個在答。
    replyFn = (messages) => {
      answered++;
      const { continuation } = chapterOf(messages);
      return continuation ? { text: filler(400, 3), stop: 'end' } : { text: filler(200, 4), stop: 'maxTokens' };
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 1 }, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('壞的那個只碰了一次：續寫那幾輪直接用第一次成功的那個', () => {
    assert.ok(answered >= 2, `答了 ${answered} 次`);
    assert.equal(fake.callCount(), answered + 1);
    assert.ok(t.has(CH(1)));
  });
});

describe('沒有可寫的', () => {
  test('都寫過了：不問、不調', async () => {
    const t = await fresh('wb-none', { written: [1, 2, 3] });
    assert.equal(await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 } }), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('都已經寫過正文了')), h.toasts.join('|'));
    cleanup(t.dir, bundle.db);
  });
});

// ---------------------------------------------------------------- 一致性預檢（五期）

/** 第 2 章的細綱改成排著沈秋（計劃出場寫在「出場人物」一節）；沈秋的卡上「當前狀態」寫著 `state`。 */
function scheduleShenQiu(t, state, through = 0) {
  t.write(
    PLOT(2),
    [
      '---', 'no: 2', `title: ${TITLES[1]}`, 'targetWords: 600', '---', '',
      `# 第2章 ${TITLES[1]}`, '', '## 梗概', '', '第 2 章的目的', '', '## 出場人物', '', '林昭、沈秋', '',
      '## 關鍵事件', '', '第 2 章林昭查到一點東西。', '', '## 看點', '', '第 2 章結尾：又一個人不見了。', '',
    ].join('\n')
  );
  t.write('.novelwarden/characters/沈秋.md', `---\nname: 沈秋\nstateThrough: ${through}\n---\n\n# 沈秋\n\n## 當前狀態\n\n${state}\n`);
  t.project.invalidate();
}

describe('一致性預檢：開跑之前查一遍，有問題先問', () => {
  test('作者說「僅本次忽略」：照寫，跑的中途不再為它停', async () => {
    const t = await fresh('wb-preflight-ignore');
    scheduleShenQiu(t, '已死亡');
    h.expect('僅本次忽略，照寫');
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0].message, /^一致性預檢：第 1–3 章裡有 1 處要留意（這一步沒有呼叫模型）/);
    assert.match(h.confirms[0].detail, /第 2 章：沈秋的當前狀態（開篇狀態）寫著「已死亡」/);
    assert.equal(calls, 3);
    assert.ok(t.has(CH(3)));
    cleanup(t.dir, bundle.db);
  });

  test('作者沒答應：一次模型都不調', async () => {
    const t = await fresh('wb-preflight-cancel');
    scheduleShenQiu(t, '已死亡');
    h.expect(undefined);
    const calls = await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, call: {} });
    assert.equal(calls, 0);
    assert.equal(fake.calls.length, 0);
    cleanup(t.dir, bundle.db);
  });

  // 前面剛定稿的一章把某人寫死了，後面一章還排著他：批次沒有人看著，停在那一章前面。
  test('中途新冒出來的：停在那一章前面，掛黃 ❗', async () => {
    const t = await fresh('wb-preflight-midway');
    scheduleShenQiu(t, '（待補充）');
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '第 1 章的事。', 出场人物: [{ name: '林昭', aliases: [] }, { name: '沈秋', aliases: [] }], 关键事件: [], 连续性事实: [] });
      }
      if (isState(messages)) {
        return JSON.stringify({ updates: [{ name: '沈秋', 当前状态: '已死亡，屍體留在渡口' }] });
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    assert.equal(h.confirms.length, 0, '開跑時還沒有問題');
    assert.ok(t.has(CH(1)));
    assert.ok(!t.has(CH(2)), '第 2 章沒寫');
    const f = finished.find((x) => x.title === '批次寫章');
    assert.match(f.message, /第 2 章的一致性預檢發現 1 處問題（沈秋已經死了，細綱仍排著），批次停在這裡/);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(fails.some((x) => x.severity === 'warn' && /一致性預檢/.test(x.message)), JSON.stringify(fails));
    cleanup(t.dir, bundle.db);
  });

  // 百章實驗：錢執事第 10 章定稿時已記下「屍骨無存」，第 26 章細綱照排——他沒有卡，預檢沒攔。
  test('沒有卡的人：靠前面定稿的連續性事實認出來，停在那一章前面', async () => {
    const t = await fresh('wb-preflight-fact');
    scheduleShenQiu(t, '');
    t.remove('.novelwarden/characters/沈秋.md');
    // 第 1 章也排著沈秋：他死在這一章（不算提前登場）。
    t.write(PLOT(1), t.read(PLOT(1)).replace('## 出場人物\n\n林昭\n', '## 出場人物\n\n林昭、沈秋\n'));
    t.project.invalidate();
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '第 1 章的事。', 出场人物: [{ name: '林昭', aliases: [] }], 关键事件: [], 连续性事实: ['沈秋被刺死在渡口，屍骨無存'] });
      }
      const { no, continuation } = chapterOf(messages);
      if (!isState(messages) && !continuation && no === 1) {
        return { text: `沈秋被刺死在渡口，屍骨無存。\n\n${filler(700, 100)}`, stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', call: {} });
    const f = finished.find((x) => x.title === '批次寫章');
    assert.ok(t.has(CH(1)) && !t.has(CH(2)));
    assert.match(f.message, /第 2 章的一致性預檢發現 1 處問題（沈秋已經死了/);
    const fails = await failuresOf(t, PLOT(2));
    assert.ok(fails.some((x) => /沈秋在第 1 章同步下來的事實裡寫著「沈秋被刺死在渡口」/.test(x.message)), JSON.stringify(fails));
    cleanup(t.dir, bundle.db);
  });
});

describe('開寫之前補建角色卡：定稿過的細綱裡出場兩章以上、還沒有卡的人', () => {
  let t;
  before(async () => {
    t = await fresh('wb-cast-cards');
    replyFn = (messages) => {
      if (isSummary(messages)) {
        return JSON.stringify({ 梗概: '事。', 出场人物: [{ name: '林昭', aliases: [] }, { name: '老周', aliases: [] }], 关键事件: [], 连续性事实: [] });
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 2 }, mode: 'finalize', call: {} });
    fake.reset();
    h.confirms.length = 0;
    h.expect('開始寫章');
    await bundle.batch.writeManuscripts(t.project, { range: { from: 3, to: 3 } });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('確認框裡說了給誰建卡、幾次呼叫，並算進總數', () => {
    const c = h.confirms[0];
    // 建卡一批寫 1 次、轉寫 1 次（2026-10-25 起改成轉寫），轉寫不合格重轉 1 次。
    assert.match(c.message, /預計 3–6 次呼叫，最多 15 次/);
    assert.match(c.detail, /開寫之前先給老周建角色卡（同步過的章裡已經出場 2 章以上、還沒有卡；預計 2 次呼叫，最多 3 次，算在上面的數裡/);
  });

  test('先建卡再寫：老周有了卡，第 3 章寫了', () => {
    assert.ok(t.has('.novelwarden/characters/老周.md'));
    assert.ok(t.has(CH(3)));
  });
});

// 五期補遺 §4：寫完即審稿。寫 → 審 → 定稿；報告進一個新會話；審出問題、審稿失敗都不停。
describe('寫完即審稿', () => {
  let t;
  const order = [];
  before(async () => {
    t = await fresh('wb-review');
    replyFn = (messages) => {
      if (isReview(messages)) {
        const user = messages[messages.length - 1].content;
        // 審稿凍結的目標只剩關鍵事件：「第 N 章林昭查到一點東西」。
        const no = Number(/第 (\d+) 章林昭查到/.exec(user)?.[1] ?? 0);
        order.push(`審${no}`);
        if (no === 2) {
          return { text: '這不是 JSON', stop: 'end' };
        }
        const quote = /# 待審正文\n\n([\s\S]{20})/.exec(user)?.[1] ?? '';
        return {
          text: JSON.stringify({
            summary: `第 ${no} 章還行`,
            items: [{ category: '劇情合理性', severity: 'error', quote, description: '這一句有問題' }],
            goalReviews: [],
          }),
          stop: 'end',
        };
      }
      if (isSummary(messages)) {
        order.push('定稿');
      } else if (!isState(messages) && !isFind(messages) && !isTime(messages)) {
        order.push('寫');
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 3 }, mode: 'finalize', review: true, call: {} });
  });
  after(() => cleanup(t.dir, bundle.db));

  test('三章都寫了；每章是寫 → 審 → 定稿', () => {
    assert.ok([1, 2, 3].every((no) => t.has(CH(no))));
    assert.deepEqual(order.filter((x) => x !== '審2'), ['寫', '審1', '定稿', '寫', '定稿', '寫', '審3', '定稿']);
  });

  test('第 2 章審稿兩次都不合格：不停，後面照寫', () => {
    assert.deepEqual(order.filter((x) => x === '審2'), ['審2', '審2']);
    assert.ok(t.has(CH(3)));
  });

  test('報告進了一個新會話：標題、一章一輪、報告卡與報錯', () => {
    const dir = t.project.sessionsDir;
    const files = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const s = JSON.parse(require('fs').readFileSync(require('path').join(dir, files[0]), 'utf8'));
    assert.equal(s.title, '批次審稿 · 第 1–3 章');
    assert.deepEqual(s.turns.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(s.turns[0].command, '審稿');
    assert.equal(s.turns[1].review.report.chapterNo, 1);
    assert.equal(s.turns[1].review.report.issues.length, 1);
    assert.match(s.turns[3].error, /^審稿失敗：/);
    assert.equal(s.turns[5].review.report.chapterNo, 3);
    assert.equal(s.target.kind, 'manuscript');
  });

  test('完成提示：每章審出什麼，按鈕開啟那個會話', () => {
    const f = finished.find((x) => x.title === '批次寫章');
    assert.match(f.message, /審稿：第 1 章 1 嚴重 · 0 建議；第 2 章審稿失敗；第 3 章 1 嚴重 · 0 建議。報告在會話「批次審稿 · 第 1–3 章」裡/);
    assert.equal(f.open.label, '開啟審稿報告');
    assert.ok(f.open.sessionId);
  });

  test('沒確認過的走確認框：說清寫完即審稿與審稿用哪一檔', async () => {
    const t2 = await fresh('wb-review-ask');
    h.answers.push(undefined);
    await bundle.batch.writeManuscripts(t2.project, { range: { from: 1, to: 2 }, review: true });
    const c = h.confirms.at(-1);
    assert.match(c.message, /只寫正文、寫完即審稿/);
    assert.match(c.detail, /每寫完一章先審一遍/);
    assert.match(c.detail, /批次審稿/);
    cleanup(t2.dir, bundle.db);
  });
});

// 2026-10-25 起改成轉寫：審稿按小標題寫（引文用「」括出來），轉寫模型照抄成 JSON，之後照舊拿正文核引文。
describe('寫完即審稿 · 按格式寫，轉寫模型照抄成 JSON', () => {
  let t;
  let quote = '';
  let session;
  const prose = () =>
    ['### 總評', '第 1 章還行', '### 問題', `- 劇情合理性（嚴重）：這一句有問題。原文：「${quote}」`, '### 目標核對', `- g1（已完成）：查到了。證據：「${quote}」`].join('\n');
  before(async () => {
    t = await fresh('wb-review-prose');
    replyFn = (messages) => {
      if (isTranscribe(messages)) {
        return JSON.stringify({
          summary: '第 1 章還行',
          items: [{ category: '劇情合理性', severity: 'error', quote, description: '這一句有問題。' }],
          goalReviews: [{ id: 'g1', status: 'completed', description: '查到了。', evidence: [quote] }],
        });
      }
      if (isReview(messages)) {
        quote = /# 待審正文\n\n([\s\S]{20})/.exec(messages[messages.length - 1].content)?.[1] ?? '';
        return { text: prose(), stop: 'end' };
      }
      return defaultReply(messages);
    };
    await bundle.batch.writeManuscripts(t.project, { range: { from: 1, to: 1 }, review: true, call: {} });
    const dir = t.project.sessionsDir;
    const [file] = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json'));
    session = JSON.parse(require('fs').readFileSync(require('path').join(dir, file), 'utf8'));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('審的那一次不要 JSON；轉寫那一次只帶合同與審稿原文', () => {
    const review = fake.calls.find(isReview);
    assert.match(review.at(-1).content, /不寫 JSON/);
    const copies = fake.calls.filter(isTranscribe);
    assert.equal(copies.length, 1);
    const user = copies[0].at(-1).content;
    assert.ok(user.includes('【審稿報告 JSON 合同】') && user.includes(`【原文】\n${prose()}`), user.slice(0, 1500));
    assert.ok(!user.includes('# 待審正文'), user.slice(0, 1500));
  });

  test('報告卡進了「批次審稿」會話：引文核過正文，目標照轉寫的結論；呼叫 2 次', () => {
    const turn = session.turns[1];
    assert.equal(turn.review.report.summary, '第 1 章還行');
    assert.deepEqual(turn.review.report.issues.map((i) => [i.severity, i.quote]), [['error', quote]]);
    assert.deepEqual(turn.review.report.goals.map((g) => g.status), ['completed']);
    assert.equal(turn.review.calls, 2);
    assert.match(turn.content, /^# 第 1 章《停舟》審稿/);
  });
});
