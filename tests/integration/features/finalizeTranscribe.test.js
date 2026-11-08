/**
 * 同步一章裡除敘事線以外的幾步改成轉寫（2026-10-25）：照正文更新細綱、角色當前狀態、故事時間，幹活的模型按格式寫自然語言，
 * 「轉寫」那一檔的模型照抄成原來那份 JSON（features/transcribe.ts）。敘事線那一步這裡直接給 JSON（不轉），它自己的斷言在別處。
 *
 * 作者定的：所有要模型直接輸出 JSON 的步驟都改成這種模式；轉寫用**固定的轉寫模型**（不跟對話頁選的、也不跟確認框上為這一次挑的）。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 同步一章 · 三步都照抄收下 | 寫的是對話頁那個模型、轉寫的是轉寫那一檔；轉寫只帶合同與原文；細綱（八節、出場人物別名、連續性事實證據、設定）、角色狀態、時間線都落盤；次數 = 寫 4 + 轉寫 3 |
 * | 轉寫改了字 | 不收，重轉一次，說清哪幾處不是原文裡的字；第二次照抄的落盤 |
 * | 補推時間 · 一批兩章 | 寫一次、轉一次；「看不出」轉成推不出（+?）；確認框報「預計 2 次，最多 3 次」、單列轉寫那一檔 |
 * | 轉寫模型呼叫失敗 | 原來的失敗走法：細綱按小節讀原文照樣落盤（出場人物從文字裡認）；角色狀態、故事時間掛黃 ❗，次數照算 |
 * | 角色狀態沒人變 | 「本章沒有人的狀態變了。」這種短短一句不轉，算沒人變 |
 * | 原文不像這一步的輸出 | 「好的……」這種不花轉寫那一次，照原來報讀不出來 |
 * | 提示詞 | 三步都不再要 JSON；內容要求一條不少（字數、條數、照抄名字、證據用「」引原文） |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
/** 按模型引用注入異常（fakeProvider 的 behavior）：建 provider 時現讀。 */
const behavior = {};

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const CARD = '.novelwarden/characters/林昭.md';
const TIMELINE = '.novelwarden/threads/时间线.md';

const TEXT = [
  '次日清晨，林昭推開客棧的門，簷下的燈籠被風吹得直晃。',
  '青鱗從暗處撲出來，他側身躲開，血順著左臂往下淌，他把袖子紮緊了。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
  '兩日後的夜裡，林昭離開了青崖鎮，往北去了。',
].join('\n\n');

const TRANSCRIBER = '格式轉寫員';
const SUMMARY_MARK = '建立可檢索的章節檔案';
const STATE_MARK = '依據本章正文更新角色的「當前狀態」';
const TIME_MARK = '你是小說的時間校對員';
const FIND_MARK = '你是小說定稿事實審查員';

// ---------------------------------------------------------------- 寫的那一次（按格式寫的自然語言）

const SUMMARY_PROSE = [
  '## 梗概',
  '林昭在客棧遇襲負傷，兩日後離開青崖鎮北上。',
  '',
  '## 出場人物',
  '- 林昭（昭公子）',
  '- 沈氏',
  '',
  '## 時間地點',
  '青崖鎮客棧，次日清晨到兩日後的夜裡。',
  '',
  '## 關鍵事件',
  '- 青鱗從暗處偷襲林昭。',
  '- 沈氏收起殘令。',
  '- 林昭離開青崖鎮往北去。',
  '',
  '## 看點',
  '- 章末林昭北上，吊著他要去哪裡。',
  '',
  '## 狀態變更',
  '林昭左臂受傷。',
  '',
  '## 連續性事實',
  '- 林昭左臂被青鱗劃傷',
  '- 沈氏把殘令收進袖中',
  '',
  '## 設定',
  '- 青崖鎮〔地點〕',
].join('\n');

const STATE_PROSE = '## 林昭\n左臂帶傷，離開青崖鎮往北去了。';

/** 一章的時間：`days` 是「看不出」時不寫依據、寫理由。 */
const timeProse = (no, days = '1') =>
  [
    `## 第${no}章`,
    `- 開頭晚幾天：${days}`,
    '- 開頭時段：清晨',
    days === '看不出' ? '- 開頭的依據：無' : '- 開頭的依據：「次日清晨，林昭推開客棧的門」',
    days === '看不出' ? '- 判斷理由：場面接不上' : '- 判斷理由：無',
    '- 章內往後跳：',
    '  - 2 天：「兩日後的夜裡」',
    '- 結尾時段：夜裡',
    '- 整章回憶：無',
    '- 寫明的日子：無',
    '- 季節：無',
  ].join('\n');

// ---------------------------------------------------------------- 轉寫那一次（照抄出來的 JSON）

const SUMMARY_COPY = {
  梗概: '林昭在客棧遇襲負傷，兩日後離開青崖鎮北上。',
  出场人物: [
    { name: '林昭', aliases: ['昭公子'] },
    { name: '沈氏', aliases: [] },
  ],
  时间地点: '青崖鎮客棧，次日清晨到兩日後的夜裡。',
  关键事件: ['青鱗從暗處偷襲林昭。', '沈氏收起殘令。', '林昭離開青崖鎮往北去。'],
  看点: ['章末林昭北上，吊著他要去哪裡。'],
  状态变更: '林昭左臂受傷。',
  连续性事实: ['林昭左臂被青鱗劃傷', '沈氏把殘令收進袖中'],
  设定: [{ name: '青崖鎮', category: '地點', fact: '' }],
};
const STATE_COPY = { updates: [{ name: '林昭', 当前状态: '左臂帶傷，離開青崖鎮往北去了。' }] };
const timeCopy = (no, days = 1) => ({
  chapter: no,
  days,
  part: '清晨',
  evidence: days === null ? '無' : '次日清晨，林昭推開客棧的門',
  reason: days === null ? '場面接不上' : '無',
  jumps: [{ days: 2, evidence: '兩日後的夜裡' }],
  endPart: '夜裡',
  flashback: '無',
  date: null,
  season: null,
});

/** 下一次細綱轉寫先答這幾條（改了字的那種），用完回到照抄。 */
let summaryCopies = [];
/** 寫細綱那一次答什麼（預設按格式寫）。 */
let summaryProse = SUMMARY_PROSE;
/** 寫角色狀態那一次答什麼。 */
let stateProse = STATE_PROSE;
/** 補推那一批裡，這些章「看不出」晚幾天。 */
let unknownDays = new Set();

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1]?.content ?? '';
  if (system.includes(TRANSCRIBER)) {
    if (user.includes('【章節檔案 JSON 合同】')) {
      return JSON.stringify(summaryCopies.shift() ?? SUMMARY_COPY);
    }
    if (user.includes('【角色狀態 JSON 合同】')) {
      return JSON.stringify(STATE_COPY);
    }
    if (user.includes('【故事時間 JSON 合同】')) {
      const nos = [...user.matchAll(/## 第(\d+)章/g)].map((m) => Number(m[1]));
      return JSON.stringify({ times: nos.map((no) => (unknownDays.has(no) ? timeCopy(no, null) : timeCopy(no))) });
    }
    return '（認不出這份合同）';
  }
  if (system.includes(SUMMARY_MARK)) {
    return summaryProse;
  }
  if (system.includes(STATE_MARK)) {
    return stateProse;
  }
  if (system.includes(FIND_MARK)) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (system.includes(TIME_MARK)) {
    const nos = [...user.matchAll(/【第(\d+)章 /g)].map((m) => Number(m[1]));
    return nos.map((no) => timeProse(no, unknownDays.has(no) ? '看不出' : '1')).join('\n\n');
  }
  return '（認不出這一步）';
}

const systemOf = (i) => fake.calls[i][0].content;
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
const refOf = (i) => fake.calls[i].ref;
/** 系統提示裡帶著 `mark` 的那幾次呼叫的下標。 */
const callsWith = (mark) => fake.calls.map((m, i) => (m[0].content.includes(mark) ? i : -1)).filter((i) => i >= 0);
/** 轉寫那幾次裡，合同是 `contract` 的那幾次的下標。 */
const transcribesOf = (contract) => callsWith(TRANSCRIBER).filter((i) => userOf(i).includes(contract));

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];
const timelineOf = () => bundle.timeline.parseTimelineFile(t.read(TIMELINE), TIMELINE);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    finalize: './src/core/features/finalize.ts',
    timeBackfill: './src/core/features/timelineBackfill.ts',
    timeline: './src/core/model/timelineFile.ts',
    stateModel: './src/core/model/characterState.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  // 對話頁選的是 big；轉寫那一檔（預設快速檔）配的是 small。
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'big', contextWindow: 100000 }, { name: 'small', contextWindow: 32000 }] }],
    models: ['p/big'],
    tierModels: { fast: ['p/small'] },
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    behavior,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'finalize-transcribe', title: '青崖記' });
  project = t.project;
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
  const hash = bundle.stateModel.stateHashOf('在客棧');
  t.write(CARD, `---\nname: 林昭\nstateThrough: 1\nstateHash: ${hash}\n---\n\n# 林昭\n\n## 身份\n\n少年劍客\n\n## 當前狀態\n\n在客棧\n`);
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

describe('同步一章 · 細綱、角色狀態、故事時間都按格式寫，轉寫模型照抄', () => {
  let outcome;
  before(async () => {
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('寫 4 次（細綱、角色狀態、敘事線、故事時間）、轉寫 3 次（敘事線直接給了 JSON，不轉）；賬對得上', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(outcome.calls, 7);
    assert.equal(callsWith(TRANSCRIBER).length, 3);
    for (const contract of ['【章節檔案 JSON 合同】', '【角色狀態 JSON 合同】', '【故事時間 JSON 合同】']) {
      assert.equal(transcribesOf(contract).length, 1, contract);
    }
  });

  test('寫的是對話頁那個模型，轉寫的是轉寫那一檔', () => {
    for (const i of callsWith(TRANSCRIBER)) {
      assert.equal(refOf(i), 'p/small');
    }
    for (const mark of [SUMMARY_MARK, STATE_MARK, TIME_MARK]) {
      assert.equal(refOf(callsWith(mark)[0]), 'p/big', mark);
    }
  });

  test('轉寫只帶合同與原文：原文進了轉寫的訊息，書的上下文、正文沒進', () => {
    const [s] = transcribesOf('【章節檔案 JSON 合同】');
    assert.ok(userOf(s).includes('【原文】') && userOf(s).includes('- 林昭（昭公子）'), userOf(s));
    assert.ok(!userOf(s).includes('血順著左臂往下淌'), userOf(s));
    const [st] = transcribesOf('【角色狀態 JSON 合同】');
    assert.ok(userOf(st).includes('## 林昭\n左臂帶傷'), userOf(st));
    const [tm] = transcribesOf('【故事時間 JSON 合同】');
    assert.ok(userOf(tm).includes('- 開頭的依據：「次日清晨，林昭推開客棧的門」'), userOf(tm));
  });

  test('寫的那幾次不要 JSON', () => {
    for (const mark of [SUMMARY_MARK, STATE_MARK, TIME_MARK]) {
      const i = callsWith(mark)[0];
      assert.ok(systemOf(i).includes('不寫 JSON'), systemOf(i).slice(0, 400));
    }
    assert.ok(userOf(callsWith(STATE_MARK)[0]).endsWith('請按要求寫。'));
    assert.ok(userOf(callsWith(TIME_MARK)[0]).includes('請給第 2 章各判一次時間，按要求的格式寫。'));
  });

  test('細綱落盤：八節照抄，出場人物帶別名，連續性事實掛上正文原句，設定一節在', async () => {
    const plot = t.read(PLOT(2));
    assert.ok(plot.includes('林昭在客棧遇襲負傷，兩日後離開青崖鎮北上。'), plot);
    assert.match(plot, /^cast: \[林昭\(昭公子\), 沈氏\]$/m);
    assert.ok(plot.includes('- 青鱗從暗處偷襲林昭。'), plot);
    assert.ok(plot.includes('林昭左臂被青鱗劃傷') && plot.includes('血順著左臂往下淌'), plot);
    assert.ok(/## 設定\s+- 青崖鎮〔地點〕/.test(plot), plot);
    // 原文寫「無」的那一節換成空的，不落一個「無」字進去（這裡沒有「無」：狀態變更有內容）。
    assert.ok(plot.includes('林昭左臂受傷。'), plot);
    project.invalidate();
    assert.ok((await project.getPlot(2)).sourceHash);
  });

  test('角色卡的當前狀態換成轉寫出來的那一段', () => {
    assert.match(t.read(CARD), /## 當前狀態\s+左臂帶傷，離開青崖鎮往北去了。/);
    assert.deepEqual(outcome.states.updated, ['林昭']);
  });

  test('時間線寫上這一章：晚 1 天，依據是正文原句，章內跳了 2 天，「無」的理由不留', () => {
    const e = timelineOf().entries.find((x) => x.chapter === 2);
    assert.ok(e, t.read(TIMELINE));
    assert.deepEqual(e.value, { kind: 'delta', days: 1 });
    assert.equal(e.span, 3);
    assert.equal(e.basis.kind, '依据');
    assert.ok(e.basis.text.includes('次日清晨'), JSON.stringify(e));
    assert.ok(!outcome.timeError && !outcome.stateError, JSON.stringify(outcome));
  });
});

describe('轉寫改了原文的字：不收，重轉一次', () => {
  let outcome;
  before(async () => {
    summaryCopies = [{ ...SUMMARY_COPY, 关键事件: ['林昭夜探客棧，被青鱗所傷。'] }];
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
  });

  test('重轉那一次說清哪幾處不是原文裡的字', () => {
    const [first, second] = transcribesOf('【章節檔案 JSON 合同】');
    assert.ok(second !== undefined, JSON.stringify(callsWith(TRANSCRIBER)));
    assert.ok(!userOf(first).includes('【上次轉寫不合格】'));
    assert.ok(userOf(second).includes('【上次轉寫不合格】這幾處不是原文裡的字：「林昭夜探客棧，被青鱗所傷。」'), userOf(second).slice(0, 800));
  });

  test('多調的那一次記進賬裡', () => {
    assert.equal(fake.callCount(), 8);
    assert.equal(outcome.calls, 8);
  });

  test('落盤的是第二次照抄的那一份', () => {
    const plot = t.read(PLOT(2));
    assert.ok(plot.includes('- 青鱗從暗處偷襲林昭。') && !plot.includes('林昭夜探客棧'), plot);
  });
});

describe('補推時間 · 一批兩章：寫一次、轉一次', () => {
  before(async () => {
    // 第 3、4 章同步過（細綱記著正文的指紋），時間線裡還沒有它們。
    for (const no of [3, 4]) {
      const hash = (await chapterNo(no)).contentHash;
      t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
    }
    unknownDays = new Set([3]);
    project.invalidate();
    fake.reset();
    h.expect('開始補推');
    await bundle.timeBackfill.backfillTimeline(project);
    unknownDays = new Set();
  });

  test('確認框報「預計 2 次，最多 3 次」，單列轉寫那一檔', () => {
    const c = h.confirms.at(-1);
    assert.ok(c.message.includes('第 3–4 章') && c.message.includes('預計 2 次呼叫，最多 3 次'), c.message);
    assert.ok(c.call.fixed?.some((f) => f.startsWith('轉寫') && f.endsWith('（不跟這一次挑的模型）')), JSON.stringify(c.call));
  });

  test('一批寫一次、轉一次；轉寫的原文是兩章各一節', () => {
    assert.equal(fake.callCount(), 2);
    assert.ok(systemOf(0).includes(TIME_MARK) && systemOf(1).includes(TRANSCRIBER));
    assert.ok(userOf(1).includes('## 第3章') && userOf(1).includes('## 第4章'), userOf(1));
  });

  test('「看不出」轉成推不出（+?），另一章晚 1 天', () => {
    const entries = timelineOf().entries;
    assert.equal(entries.find((e) => e.chapter === 3)?.value.kind, 'unknown', t.read(TIMELINE));
    assert.deepEqual(entries.find((e) => e.chapter === 4)?.value, { kind: 'delta', days: 1 });
  });
});

describe('轉寫模型呼叫失敗：照這幾步原來解析失敗的走法', () => {
  let outcome;
  before(async () => {
    behavior['p/small'] = 'fail';
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(5));
    delete behavior['p/small'];
  });

  test('細綱照樣落盤：按小節讀原文，出場人物與別名從文字裡認', async () => {
    const plot = t.read(PLOT(5));
    assert.ok(plot.includes('林昭在客棧遇襲負傷'), plot);
    assert.match(plot, /^cast: \[林昭\(昭公子\), 沈氏\]$/m);
    project.invalidate();
    assert.ok((await project.getPlot(5)).sourceHash);
  });

  test('角色狀態、故事時間沒成：黃 ❗ 掛在章節上，說清是轉寫沒成', async () => {
    assert.match(outcome.stateError ?? '', /轉寫沒成/);
    assert.match(outcome.timeError ?? '', /轉寫沒成/);
    const marks = await failuresOf(CH(5));
    assert.deepEqual(marks.map((m) => m.op).sort(), ['cardState', 'timeline']);
    assert.ok(marks.every((m) => m.severity === 'warn'), JSON.stringify(marks));
    assert.ok(!timelineOf().entries.some((e) => e.chapter === 5));
  });

  test('發出去的轉寫也算錢：寫 4 次 + 轉寫 3 次（都失敗了）', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(outcome.calls, 7);
  });
});

describe('角色狀態：沒人變就只寫一句，不花轉寫那一次', () => {
  let outcome;
  before(async () => {
    stateProse = '本章沒有人的狀態變了。';
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    stateProse = STATE_PROSE;
  });

  test('角色狀態那一步只調了寫的那一次，沒有報錯', () => {
    assert.equal(transcribesOf('【角色狀態 JSON 合同】').length, 0);
    assert.equal(outcome.states.calls, 1);
    assert.ok(!outcome.stateError, outcome.stateError);
    assert.deepEqual(outcome.states.updated, []);
  });
});

describe('原文連這一步的樣子都沒有：不花轉寫那一次', () => {
  let error;
  before(async () => {
    summaryProse = '好的，這一章主要寫了林昭在客棧遇襲然後離開，整體節奏緊湊。';
    fake.reset();
    try {
      await bundle.finalize.finalizeChapter(project, await chapterNo(1));
    } catch (err) {
      error = err;
    }
    summaryProse = SUMMARY_PROSE;
  });

  test('照原來報讀不出來、紅 ❗，只調了寫的那一次', async () => {
    assert.ok(error && /同步失敗/.test(error.message), String(error));
    assert.equal(fake.callCount(), 1);
    const marks = await failuresOf(CH(1));
    assert.ok(marks.some((m) => m.severity === 'error' && /無法解析/.test(m.message)), JSON.stringify(marks));
  });
});

describe('提示詞：不再要 JSON，內容要求一條不少', () => {
  const sp = loadModule('src/core/features/summarizePrompt.ts');
  const cp = loadModule('src/core/features/characterCardPrompt.ts');
  const tp = loadModule('src/core/features/timePrompt.ts');

  test('細綱：八個小標題，字數、條數、照抄名字、別名只收專屬稱呼都還在', () => {
    for (const head of ['## 梗概', '## 出場人物', '## 時間地點', '## 關鍵事件', '## 看點', '## 狀態變更', '## 連續性事實', '## 設定']) {
      assert.ok(sp.SUMMARY_SYSTEM.includes(head), head);
    }
    assert.ok(!/輸出一個 JSON|JSON 物件|aliases|"name"/.test(sp.SUMMARY_SYSTEM), sp.SUMMARY_SYSTEM);
    for (const rule of ['150 字以內', '40 字以內；最多 12 條', '已有角色卡」列表裡有就照抄', '括號裡只收專屬稱呼', '60 字以內', '1–3 條']) {
      assert.ok(sp.SUMMARY_SYSTEM.includes(rule), rule);
    }
    assert.ok(sp.SUMMARY_JSON_CONTRACT.includes('"出场人物":[{"name":"…","aliases":["…"]}]'));
  });

  test('角色狀態：一人一節，100 字以內、只寫變了的、名字與名單一致；沒人變只寫「無」', () => {
    assert.ok(!/JSON 物件|"updates"/.test(cp.STATE_SYSTEM), cp.STATE_SYSTEM);
    for (const rule of ['## 〈人物名〉', '100 字以內', '只寫本章裡狀態確實變了的人', '只寫一個字「無」', '與名單完全一致']) {
      assert.ok(cp.STATE_SYSTEM.includes(rule), rule);
    }
    assert.ok(cp.STATE_JSON_CONTRACT.includes('{"updates":[{"name":"…","当前状态":"…"}]}'));
  });

  test('故事時間：一章一節，依據用「」逐字引正文，不許自己算日期', () => {
    assert.ok(!/輸出一個 JSON|JSON 物件|evidence|"times"/.test(tp.TIME_SYSTEM), tp.TIME_SYSTEM);
    for (const rule of ['## 第12章', '用「」把這一章正文裡交代時間的那一小截原樣引出來，逐字複製，40 字以內', '不要自己算日期', '寫「看不出」', '「三年後」按一年 360 天寫 1080']) {
      assert.ok(tp.TIME_SYSTEM.includes(rule), rule);
    }
    assert.ok(tp.TIME_JSON_CONTRACT.includes('寫「看不出」或沒寫的給 null'));
  });
});
