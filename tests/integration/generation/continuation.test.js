/**
 * 正文的續寫鏈（generation/continuation.ts 的 `completeManuscript`，經 `generate` 跑）。
 *
 * 假模型按輪指令碼化應答（`{ text, stop }`），釘住三期計劃 §3 的每一個分支：
 *
 * | 情形 | 斷言 |
 * |---|---|
 * | 一次寫夠 | 1 次呼叫，不續寫，沒有說明 |
 * | 截斷後續寫 | 被截斷就續，哪怕字數夠了；氣泡裡輪與輪之間只空一行 |
 * | 不到八成續寫 | 正常收尾但不夠八成就續 |
 * | 低增長丟棄、恢復一次 | 被截斷又沒寫出東西：丟掉、氣泡退回、恢復那一輪開頭說清 |
 * | 恢復也失敗 | 停下，已寫的保留，照樣出 Draft |
 * | 思考耗盡 | 截斷且正文不到 100 字：報錯，不出 Draft |
 * | 最終未寫夠 | 模型收尾又只多了幾句：不再催，說「未寫夠」，照樣出 Draft |
 * | 續寫那一輪呼叫失敗 | 已寫的保留 |
 * | 重演 | 開頭搬了上一章結尾：Draft 帶 `replay`，說明裡寫明 |
 * | 接著寫 | 只含新增的那一段，字數連已有的算 |
 * | 重寫 | 上一版正文作底稿帶進 prompt |
 * | 收尾過早（五期補遺 §1.1） | 先切掉結尾約四分之一再寫；回退之後又收尾就停；回退那一輪沒寫成就把原結尾放回去 |
 * | 本章邊界（§1.2、§1.3） | 執行卡後面點名「本章不出場」的人與比喻詞上限；續寫那一輪說已經用了幾次 |
 * | 寫完查（§1.2、§1.3、§1.5） | 提前登場、比喻詞超標、英文縮寫都記進說明 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let gen;
let h;
let fake;
let t;
let project;
let settings = {};
let script = [];

const P2 = '.novelwarden/summaries/002-客棧.md';
const P3 = '.novelwarden/summaries/003-夜访.md';

/** 第 1 章的正文（寫第 2 章時，它的結尾是重演檢測的對照）。 */
const CH1_END = [
  '雪下到半夜才停。林昭把殘令揣進懷裡，沿著河堤往回走，腳下的冰殼一踩就碎，遠處的更鼓敲過了三下。',
  '客棧的燈還亮著，沈氏坐在櫃檯後面撥算盤，看見他進門，手指停在半空，半晌才說了一句：“李叔來過，問你去了哪裡，我說你出城收賬去了。”',
].join('\n\n');

function recorder() {
  const r = { deltas: [], done: undefined, error: undefined, progress: [], resets: [] };
  return {
    r,
    handlers: {
      onDelta: (d) => r.deltas.push(d),
      onReasoning: () => {},
      onDone: (full) => { r.done = full; },
      onError: (m) => { r.error = m; },
      onCancelled: () => {},
      onProgress: (p) => r.progress.push(p),
      onReset: (full) => r.resets.push(full),
    },
  };
}

async function write(plotRelPath, replies, extra = {}) {
  script = [...replies];
  fake.calls.length = 0;
  const rec = recorder();
  const out = await gen.generate(
    project,
    { action: { stage: 'manuscript', capability: 'generate' }, target: { kind: 'manuscript', plotRelPath }, ask: '', ...extra },
    rec.handlers,
    { signal: new AbortController().signal }
  );
  return { ...out, rec: rec.r, calls: fake.calls.length, users: fake.calls.map((c) => c[c.length - 1].content) };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    generate: './src/core/generation/generate.ts',
    plotFile: './src/core/model/plotFile.ts',
    tokenizer: './src/core/context/tokenizer.ts',
    logger: './src/core/runtime/logger.ts',
    db: './src/core/runtime/db.ts',
  });
  gen = bundle.generate;
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ settings: () => settings, overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => {
      const next = script.shift();
      if (typeof next === 'function') return next(messages, i);
      return next ?? '';
    },
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'continuation', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  // 第 3 章才排沈秋：寫第 2 章時他在「本章不出場」的名單上（五期補遺 §1.2）。沒定稿的細綱，
  // 計劃出場就寫在「出場人物」一節裡。
  const cast = { 1: '林昭', 2: '林昭', 3: '林昭、沈秋' };
  for (const [no, title] of [[1, '夜入青雲'], [2, '客棧'], [3, '夜訪']]) {
    await ws.writePlot({
      no,
      title,
      targetWords: 1000,
      upstreamHash: '',
      done: false,
      sections: {
        ...empty,
        梗概: `第 ${no} 章的梗概`,
        出场人物: cast[no],
        关键事件: `第 ${no} 章的關鍵事件`,
        看点: `- 第 ${no} 章的看點`,
      },
    });
  }
  await ws.createChapter(1, '夜入青雲', `${filler(900, 1)}\n\n${CH1_END}`);
  await ws.createChapter(3, '夜訪', filler(400, 3));
  await project.syncManifest();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('一次寫夠', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: filler(900, 10), stop: 'end' }]);
  });

  test('只調一次，不續寫', () => {
    assert.equal(r.calls, 1);
    assert.equal(r.draft.length.rounds, 0);
    assert.equal(r.draft.calls, 1);
  });

  test('夠了八成：已達標，除了對白偏少沒有別的說明', () => {
    assert.equal(r.draft.length.reached, true);
    assert.equal(r.draft.length.words, 900);
    assert.equal(r.draft.length.target, 1000);
    // 假模型的正文一句對白都沒有。
    assert.deepEqual(r.draft.notes, ['對白段只佔 0%（人類網文約三成），讀起來像旁白']);
  });

  test('寫法：這一章還沒有正文 → write', () => {
    assert.equal(r.draft.writeMode, 'write');
  });

  test('進度從第 0 輪報起，報到寫完的字數', () => {
    assert.equal(r.rec.progress[0].round, 0);
    assert.equal(r.rec.progress.at(-1).words, 900);
    assert.equal(r.rec.progress.at(-1).target, 1000);
  });
});

describe('截斷後續寫', () => {
  let r;
  before(async () => {
    // 字數已經夠了，但結尾停在半句上：照樣續。
    r = await write(P2, [{ text: filler(850, 11), stop: 'maxTokens' }, { text: filler(400, 12), stop: 'end' }]);
  });

  test('續了一輪，一共 2 次呼叫', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.rounds, 1);
    assert.equal(r.draft.calls, 2);
  });

  test('兩段拼成一章，中間空一行', () => {
    assert.equal(r.draft.raw, `${filler(850, 11)}\n\n${filler(400, 12)}`);
    assert.equal(r.draft.length.words, 1250);
  });

  test('氣泡裡輪與輪之間只空一行，不插「——第 k 步——」', () => {
    const streamed = r.rec.deltas.join('');
    assert.ok(!streamed.includes('——'), streamed.slice(0, 80));
    assert.ok(streamed.includes(`${filler(850, 11)}\n\n${filler(400, 12)}`));
  });

  test('續寫那一輪帶著已寫的末尾，說清還差多少', () => {
    assert.match(r.users[1], /請無縫續寫當前章節正文/);
    assert.match(r.users[1], /# 本章已寫正文/);
    assert.match(r.users[1], /大約再寫 150 字/);
  });

  test('已寫部分沒有對白：續寫那一輪點名多讓人物開口', () => {
    assert.match(r.users[1], /- 對白：已寫部分帶對白的段只佔 0%/);
  });

  test('說明裡寫了續寫了幾輪', () => {
    assert.ok(r.draft.notes.some((n) => /續寫第 1 輪：多了 400 字/.test(n)), JSON.stringify(r.draft.notes));
  });

  test('進度報了第 1 輪', () => {
    assert.ok(r.rec.progress.some((p) => p.round === 1));
  });
});

// 一章分幾次請求寫成：每次請求的用量各記各的再加總。從前合進同一份，只剩最後那一次，「輸入實測」報少了。
describe('續寫時用量按請求加總', () => {
  let r;
  before(async () => {
    bundle.tokenizer.resetUsageStats();
    r = await write(P2, [
      { text: filler(850, 21), stop: 'maxTokens', usage: { inputTokens: 3000, outputTokens: 1200 } },
      { text: filler(400, 22), stop: 'end', usage: { inputTokens: 3500, outputTokens: 600 } },
    ]);
  });

  test('輸出按兩次請求相加', () => {
    assert.equal(r.calls, 2);
    assert.equal(bundle.tokenizer.usageStats().outputTotal, 1800);
  });

  // 估算只算了第一次請求的上下文，偏差樣本只拿第一次比；續寫那次的輸入是另一份，不進樣本。
  test('估算偏差只拿第一次請求比', () => {
    const stats = bundle.tokenizer.usageStats();
    assert.equal(stats.samples, 1);
    assert.equal(stats.actualTotal, 3000);
    assert.equal(stats.estimatedTotal, r.built.usedTokens);
  });

  test('完成那一行報兩次請求的合計', () => {
    const line = bundle.logger.recentLogs().findLast((l) => l.message.endsWith('完成'));
    assert.ok(line, '沒有「完成」那一行');
    assert.ok(line.detail.includes('第一次請求輸入實測 3000 token'), line.detail);
    assert.ok(line.detail.includes('2 次請求合計輸入 6500、輸出 1800 token'), line.detail);
  });
});

describe('不到八成續寫', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: filler(500, 20), stop: 'end' }, { text: filler(450, 21), stop: 'end' }]);
  });

  test('正常收尾但只有一半：續一輪', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.length.words, 950);
    assert.equal(r.draft.length.reached, true);
  });
});

describe('續寫被截斷又沒寫出東西：丟棄，恢復一次', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 30), stop: 'end' },
      { text: filler(120, 31), stop: 'maxTokens' },
      { text: filler(400, 32), stop: 'end' },
    ]);
  });

  test('3 次呼叫：寫、丟掉的那一輪、恢復', () => {
    assert.equal(r.calls, 3);
    assert.equal(r.draft.length.rounds, 2);
  });

  test('丟掉的那一輪不在正文裡', () => {
    assert.ok(!r.draft.raw.includes(filler(120, 31)));
    assert.equal(r.draft.raw, `${filler(500, 30)}\n\n${filler(400, 32)}`);
  });

  test('氣泡退回到丟棄之前那一版', () => {
    assert.deepEqual(r.rec.resets, [filler(500, 30)]);
  });

  test('恢復那一輪開頭說清「上一輪已丟棄」', () => {
    assert.match(r.users[2], /已被全部丟棄/);
    assert.ok(!r.users[1].includes('已被全部丟棄'));
  });

  test('說明裡寫了丟棄與恢復', () => {
    assert.ok(r.draft.notes.some((n) => /已丟棄，再給一次恢復機會/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('恢復那一輪也沒寫出東西：停下，已寫的保留', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 40), stop: 'end' },
      { text: filler(80, 41), stop: 'maxTokens' },
      { text: filler(90, 42), stop: 'maxTokens' },
      { text: filler(900, 43), stop: 'end' },
    ]);
  });

  test('只給一次恢復機會：3 次呼叫就停', () => {
    assert.equal(r.calls, 3);
  });

  test('照樣出 Draft，正文是丟棄之前的那一版', () => {
    assert.ok(r.draft);
    assert.equal(r.draft.raw, filler(500, 40));
  });

  test('未寫夠、最後被截斷，都寫進說明', () => {
    assert.equal(r.draft.length.reached, false);
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /恢復）仍被截斷/);
    assert.match(notes, /未寫夠：這一章寫到 500 \/ 1000 字/);
  });
});

describe('思考把輸出預算吃光了', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ reasoning: '想了很久很久……', text: filler(30, 50), stop: 'maxTokens' }]);
  });

  test('報錯，說清是思考吃光的，提示怎麼調', () => {
    assert.match(r.rec.error, /思考/);
    assert.match(r.rec.error, /最大輸出 token|思考深度/);
  });

  test('不出 Draft，不再續寫', () => {
    assert.equal(r.draft, undefined);
    assert.equal(r.calls, 1);
  });
});

describe('最終未寫夠：模型收尾、又只多了幾句', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(400, 60), stop: 'end' },
      { text: filler(100, 61), stop: 'end' },
      { text: filler(900, 62), stop: 'end' },
    ]);
  });

  test('不再催：2 次呼叫', () => {
    assert.equal(r.calls, 2);
  });

  test('已寫的不丟，照樣出 Draft', () => {
    assert.equal(r.draft.raw, `${filler(400, 60)}\n\n${filler(100, 61)}`);
    assert.equal(r.draft.length.reached, false);
  });

  test('說明裡寫「未寫夠」與為什麼停', () => {
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /只多了 100 字，模型已經收尾/);
    assert.match(notes, /未寫夠/);
  });
});

describe('續寫那一輪呼叫失敗', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: filler(500, 70), stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假裝 502');
      },
    ]);
  });

  test('前面寫好的保留，照樣出 Draft', () => {
    assert.ok(r.draft, r.rec.error);
    assert.equal(r.draft.raw, filler(500, 70));
    assert.equal(r.rec.error, undefined);
  });

  test('說明裡寫了哪一輪、為什麼', () => {
    assert.ok(r.draft.notes.some((n) => /續寫第 1 輪呼叫失敗（.*502/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('重演上一章結尾', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: `${CH1_END}\n\n${filler(900, 80)}`, stop: 'end' }]);
  });

  test('Draft 帶上重合的那一段原文', () => {
    assert.ok(r.draft.replay, JSON.stringify(r.draft.notes));
    assert.ok(r.draft.replay.includes('沈氏坐在櫃檯後面'), r.draft.replay);
  });

  test('說明裡寫明', () => {
    assert.ok(r.draft.notes.some((n) => /與上一章結尾大段重合/.test(n)), JSON.stringify(r.draft.notes));
  });

  test('沒重演的不帶', async () => {
    const clean = await write(P2, [{ text: filler(900, 81), stop: 'end' }]);
    assert.equal(clean.draft.replay, undefined);
  });
});

describe('接著寫第 3 章', () => {
  let r;
  before(async () => {
    r = await write(P3, [{ text: filler(500, 90), stop: 'end' }], { writeMode: 'continue' });
  });

  test('Draft 只含新增的那一段', () => {
    assert.equal(r.draft.raw, filler(500, 90));
    assert.equal(r.draft.writeMode, 'continue');
  });

  test('字數連已有的一起算：400 + 500，已達標', () => {
    assert.equal(r.draft.length.words, 900);
    assert.equal(r.draft.length.added, 500);
    assert.equal(r.draft.length.reached, true);
  });

  test('第一次呼叫就帶著本章已寫的末尾', () => {
    assert.match(r.users[0], /# 本章已寫正文/);
    assert.match(r.users[0], /大約再寫 600 字/);
  });

  test('接著寫不查重演（這一章的開頭早就有了）', () => {
    assert.equal(r.draft.replay, undefined);
  });
});

describe('重寫第 3 章（不帶寫法，這一章已有正文）', () => {
  let r;
  before(async () => {
    r = await write(P3, [{ text: filler(950, 100), stop: 'end' }]);
  });

  test('寫法是 rewrite', () => {
    assert.equal(r.draft.writeMode, 'rewrite');
  });

  test('上一版正文作底稿帶進 prompt', () => {
    assert.match(r.users[0], /【上一版草稿】/);
    assert.ok(r.users[0].includes(filler(400, 3).slice(0, 50)));
  });

  test('整章重寫：字數不含上一版', () => {
    assert.equal(r.draft.length.words, 950);
  });
});

// ---------------------------------------------------------------- 五期補遺

/**
 * 第一次呼叫：四段一共 420 字，正常收尾、不到八成。最後一句是收尾那一下，只有 20 字，不夠全文的
 * 四分之一——按比例切要連它前面那 100 字一起拿掉（rewindPoint：切到約 25% 為止，最多 600 字，
 * 至少留一半）。從前細綱單列章末鉤子，續寫鏈按它認出收尾那一段、只切那一段；鉤子並進「看點」之後
 * （看點裡還有爽點，拿來找收尾會切錯地方）只按比例切。
 */
const LANDED = [filler(150, 200), filler(150, 201), filler(100, 202), '他回頭望去，巷口那盞燈不知什麼時候已經滅了。'];

describe('收尾過早：先切掉結尾約四分之一再寫', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: LANDED.join('\n\n'), stop: 'end' }, { text: filler(600, 203), stop: 'end' }]);
  });

  test('2 次呼叫', () => {
    assert.equal(r.calls, 2);
  });

  test('切完 300 字、再寫 600 字：寫夠了', () => {
    assert.equal(r.draft.length.reached, true);
  });

  test('結尾兩段拿掉了，新寫的接在切點後面', () => {
    assert.equal(r.draft.raw, [...LANDED.slice(0, 2), filler(600, 203)].join('\n\n'));
  });

  test('氣泡退回到切點', () => {
    assert.deepEqual(r.rec.resets, [LANDED.slice(0, 2).join('\n\n')]);
  });

  test('續寫那一輪說清收尾那一段已經拿掉了', () => {
    assert.match(r.users[1], /收尾那一段已經拿掉了/);
  });

  // 不再說「重新落到章末鉤子上」：細綱裡沒有單列的鉤子了，結尾落在哪由細綱整份約定。
  test('續寫那一輪要它寫足之後按細綱約定的結束狀態重新收尾', () => {
    assert.match(r.users[1], /最後按本章細綱約定的結束狀態重新收尾/);
  });

  test('還差多少按切完之後算：1000 − 300', () => {
    assert.match(r.users[1], /大約再寫 700 字/);
  });

  test('說明裡寫了寫到多少字收的尾、切了幾段幾個字', () => {
    assert.ok(
      r.draft.notes.includes('寫到 420 / 1000 字就收了尾：拿掉結尾 2 段（約 120 字），從它前面接著寫，寫足之後重新收尾'),
      JSON.stringify(r.draft.notes)
    );
  });
});

describe('回退之後又收尾、仍不夠八成：不再往收尾後面續', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      { text: filler(350, 210), stop: 'end' },
      { text: filler(500, 211), stop: 'end' },
    ]);
  });

  test('2 次呼叫就停', () => {
    assert.equal(r.calls, 2);
  });

  test('沒寫夠', () => {
    assert.equal(r.draft.length.reached, false);
  });

  // 切完 300 + 新寫 350 = 650，只比回退之前的 420 多了 230 字：再切再寫也是在原地打轉。
  test('說明裡寫為什麼停', () => {
    assert.ok(
      r.draft.notes.includes('回退重寫那一輪只比回退之前多了 230 字，模型又收了尾，沒有再往收尾後面續寫'),
      JSON.stringify(r.draft.notes)
    );
  });

  test('說明裡寫了未寫夠', () => {
    assert.ok(r.draft.notes.some((n) => /^未寫夠：這一章寫到 650 \/ 1000 字/.test(n)), JSON.stringify(r.draft.notes));
  });
});

// 真實模型試跑：一次只寫一千字上下，一章要回退兩三輪。每次只在上一輪新寫的那一段裡切。
describe('回退之後又收了尾、仍不夠：再回退一次，只切上一輪那一段', () => {
  // 第二輪新寫 467 字（到 767 字，比回退之前多了 347 字，夠得上再回退一次）：仍按比例切，
  // 結尾那一句太短，連前面 200 字一起拿掉。
  const AGAIN = [filler(250, 250), filler(200, 251), '他抬起頭，簷下的冰凌正一滴一滴往下落。'];
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      { text: AGAIN.join('\n\n'), stop: 'end' },
      { text: filler(500, 252), stop: 'end' },
    ]);
  });

  test('3 次呼叫', () => {
    assert.equal(r.calls, 3);
  });

  test('寫夠了', () => {
    assert.equal(r.draft.length.reached, true);
  });

  test('兩次收尾都拿掉了；第一次切完留下的一個字沒動', () => {
    assert.equal(r.draft.raw, [...LANDED.slice(0, 2), AGAIN[0], filler(500, 252)].join('\n\n'));
  });

  test('第二次回退那一輪也說清收尾那一段已經拿掉了', () => {
    assert.match(r.users[2], /收尾那一段已經拿掉了/);
  });

  test('說明裡兩次回退各記一條', () => {
    assert.equal(r.draft.notes.filter((n) => /就收了尾：拿掉結尾 2 段/.test(n)).length, 2, JSON.stringify(r.draft.notes));
  });
});

describe('回退那一輪呼叫失敗：原來的結尾放回去', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: LANDED.join('\n\n'), stop: 'end' },
      () => {
        throw new bundle.provider.LlmError('假裝 502');
      },
    ]);
  });

  test('正文還是第一次寫的那一版，結尾在', () => {
    assert.equal(r.draft.raw, LANDED.join('\n\n'));
  });

  test('說明裡寫了放回去，不說截斷', () => {
    const notes = r.draft.notes.join('\n');
    assert.match(notes, /原來的結尾放回去了/);
    assert.ok(!/截斷/.test(notes), notes);
  });
});

describe('一段寫成的正文沒法回退：照舊往後接', () => {
  test('與三期一樣續一輪', async () => {
    const r = await write(P2, [{ text: filler(500, 220), stop: 'end' }, { text: filler(450, 221), stop: 'end' }]);
    assert.equal(r.calls, 2);
    assert.equal(r.draft.raw, `${filler(500, 220)}\n\n${filler(450, 221)}`);
    assert.ok(!r.users[1].includes('收尾那一段已經拿掉了'));
  });
});

describe('本章邊界：點名不出場的人、比喻詞上限', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: `彷彿隔世。彷彿重生。${filler(500, 230)}`, stop: 'maxTokens' },
      { text: filler(500, 231), stop: 'end' },
    ]);
  });

  test('第一次呼叫：執行卡後面列出本章不出場的人與比喻詞上限', () => {
    assert.match(r.users[0], /【本章邊界】/);
    assert.match(r.users[0], /本章不出場：沈秋（第 3 章才登場）/);
    assert.match(r.users[0], /「彷彿」「猶如」「宛如」「如同」「好似」「恍如」「宛若」全章合計不超過 3 次/);
  });

  test('續寫那一輪：已經用了幾次、還能用幾次', () => {
    assert.match(r.users[1], /已寫部分用了 2 次「彷彿」「猶如」「宛如」「如同」「好似」「恍如」「宛若」，續寫部分最多再用 1 次/);
    assert.match(r.users[1], /本章不出場：沈秋/);
  });

  test('寫第 3 章時沈秋排在本章裡，不點名', async () => {
    const r3 = await write(P3, [{ text: filler(950, 232), stop: 'end' }]);
    assert.ok(!/本章不出場/.test(r3.users[0]));
  });
});

describe('寫完查：提前登場、比喻詞超標、英文縮寫', () => {
  let r;
  before(async () => {
    const text = [
      filler(400, 240),
      '他彷彿聽見了什麼，猶如驚弓之鳥，宛如困獸，彷彿又回到那一夜，PTSD 又犯了。',
      `${filler(400, 241)}。巷子盡頭站著一個人，是沈秋。`,
    ].join('\n\n');
    r = await write(P2, [{ text, stop: 'end' }]);
  });

  test('提前登場：誰、按細綱第幾章、哪一句', () => {
    assert.ok(
      r.draft.notes.some((n) => /沈秋按細綱第 3 章才登場，本章已經寫到了：「巷子盡頭站著一個人，是沈秋。」/.test(n)),
      JSON.stringify(r.draft.notes)
    );
  });

  test('比喻詞：全章幾次、逐個列', () => {
    assert.ok(
      r.draft.notes.some((n) => /全章合計 4 次（「彷彿」2 次、「猶如」1 次、「宛如」1 次），超過 3 次的上限/.test(n)),
      JSON.stringify(r.draft.notes)
    );
  });

  test('英文縮寫', () => {
    assert.ok(r.draft.notes.some((n) => /正文裡有英文縮寫：PTSD/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('本章細綱自己提到了後面才登場的人：不點名、寫完也不算越界', () => {
  let r;
  before(async () => {
    const ws = new bundle.ws.Workspace(project);
    const plot = await project.readPlot(P2);
    // 章末吊著讀者的那一下如今寫在「看點」裡：細綱哪一節提到了他都算本章自己的安排。
    await ws.writePlot({ ...plot, sections: { ...plot.sections, 看点: '- 有人提醒林昭：沈秋已經在找他了' } }, P2);
    r = await write(P2, [{ text: `${filler(900, 260)}。“沈秋已經在找你了。”有人低聲說。`, stop: 'end' }]);
    await ws.writePlot(plot, P2);
  });

  test('執行卡後面沒有「本章不出場：沈秋」', () => {
    assert.match(r.users[0], /【本章邊界】/);
    assert.doesNotMatch(r.users[0], /本章不出場/);
  });

  test('寫完不報提前登場', () => {
    assert.ok(!(r.draft.notes ?? []).some((n) => /才登場/.test(n)), JSON.stringify(r.draft.notes));
  });
});

/** 停在半句上的一段：去掉 filler 收尾的句號，再接半句。 */
const halfway = (n, seed) => `${filler(n, seed).slice(0, -1)}，他已經到了極限，全身`;

describe('正常收尾、字數也夠，結尾卻停在半句上：照截斷接著寫', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: halfway(900, 300), stop: 'end' }, { text: filler(400, 301), stop: 'end' }]);
  });

  test('續了一輪，不回退：前一段原樣保留，後半截直接接上、不空行', () => {
    assert.equal(r.calls, 2);
    assert.equal(r.draft.raw, `${halfway(900, 300)}${filler(400, 301)}`);
    assert.deepEqual(r.rec.resets, []);
  });

  test('說明裡寫清是哪一次、模型報的是什麼', () => {
    assert.ok(
      r.draft.notes.some((n) => /第一次呼叫的結尾停在半句上（模型報的是正常收尾），按截斷接著寫/.test(n)),
      JSON.stringify(r.draft.notes)
    );
    assert.ok(!r.draft.notes.some((n) => /^結尾停在半句上/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('閘道器不報收尾原因、結尾停在半句上：一樣接著寫', () => {
  let r;
  before(async () => {
    r = await write(P2, [{ text: halfway(900, 310) }, { text: filler(400, 311) }]);
  });

  test('續了一輪', () => {
    assert.equal(r.calls, 2);
    assert.ok(r.draft.notes.some((n) => /閘道器沒報收尾原因/.test(n)), JSON.stringify(r.draft.notes));
  });
});

describe('續寫也沒把半句接完：照樣出 Draft，說明裡寫明停在半句上', () => {
  let r;
  before(async () => {
    r = await write(P2, [
      { text: halfway(900, 320), stop: 'end' },
      { text: '的骨頭', stop: 'end' },
      { text: '都在響', stop: 'end' },
    ]);
  });

  test('續寫只多了幾個字、被當成截斷丟掉，恢復一次也沒寫出東西就停', () => {
    assert.equal(r.calls, 3);
    assert.equal(r.draft.raw, halfway(900, 320));
  });

  test('說明裡引了結尾，提示接著寫或手改', () => {
    assert.ok(r.draft.notes.some((n) => /^結尾停在半句上：「.*全身」/.test(n)), JSON.stringify(r.draft.notes));
  });
});

// 百章實驗：全域要求寫著「嚴禁使用現代科學或心理學詞彙」，正文照樣寫了「能量」33 次——沒人數。
describe('禁用詞：執行卡後面點名，續寫那一輪說清用了幾次，寫完記進說明', () => {
  let r;
  let saved;
  before(async () => {
    saved = t.read('.novelwarden/config.md');
    t.write('.novelwarden/config.md', '---\ngenre: 仙俠\n---\n\n# 小說配置\n\n## 全域要求\n\n嚴禁使用“系統”一類說法。\n');
    project.invalidate();
    r = await write(P2, [
      { text: `能量湧動，神經一跳。${filler(500, 400)}`, stop: 'end' },
      { text: `能量又散了。${filler(450, 401)}`, stop: 'end' },
    ]);
  });
  after(() => {
    t.write('.novelwarden/config.md', saved);
    project.invalidate();
  });

  test('第一次呼叫：本章邊界裡點名不許用的詞（文風指南的禁用詞表、全域要求裡禁止的、古代題材的現代說法）', () => {
    assert.match(r.users[0], /- 禁用詞：「不禁」.*「系統」「能量」「神經」/);
  });

  test('續寫那一輪：說清已寫部分用了哪幾個', () => {
    assert.match(r.users[1], /- 禁用詞：已寫部分用了「能量」1 次、「神經」1 次，續寫部分不許再用/);
  });

  test('寫完記進說明：全章合計', () => {
    assert.ok(r.draft.notes.some((n) => /正文用到了這本書不該用的詞：「能量」2 次、「神經」1 次/.test(n)), JSON.stringify(r.draft.notes));
  });
});
