/**
 * 產物落盤走的是**當場問的那張卡片**：從生成到落盤的一整趟。
 *
 * 這一組從前叫「採納」：氣泡末尾一顆「採納寫入」按鈕，可以拖到第二天再點。
 * 現在它和 agent 動手前那一問長一個樣——`generate` 一產出就問，答了才落盤
 * （AGENTS 第 19 條：產物落盤前必須過一遍人。**當場過**，不是留一顆按鈕）。
 *
 * 三條老約束原樣還在，只是觸發它們的那一下從「點按鈕」變成了「點卡片」：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 生成一輪 | 卡片當場就來，說得出寫到哪、是什麼形狀；**還沒答時磁碟沒動靜** |
 * | 答之前切了一章 | 落點從 draft 取，**不看當下選中的那一章**（從前會寫錯地方） |
 * | 先改再點寫入 | 落盤的是氣泡裡當下那份（經 `editTurn`），不是模型原樣那份 |
 * | 答「不採納」 | 一個字都不寫，氣泡上留一行「未採納」 |
 * | 討論型回覆 | 沒有產物，也就沒有卡片 |
 * | 重新整理網頁 | 沒答的那張卡隨全量狀態重推，答了照樣落盤 |
 * | 面板銷燬 | 卡片作廢，產物記成「未採納」——不留一個永遠懸著的等待 |
 * | 寫正文 | 答了才落到**同號的章節**上（沒有就新建、有了就追加），並在細綱上記 `writtenFrom` |
 * | 拆細綱落在佔位路徑 | 細綱按產物的標題落盤之後，流水線條仍認得這一章 |
 *
 * 細綱與單章摘要併成了一份：`summaries/NNN-標題.md`，七節（梗概 / 出場人物 / 時間地點 /
 * 關鍵事件 / 看點 / 狀態變更 / 連續性事實）；「排過沒有」仍只看關鍵事件。
 * 正文不再先落中轉站。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

// 模型答的是七節裡的三節：沒寫到的小節（出場人物、狀態變更……）留空，形狀描述照實說「3/7 節」。
const PLOT_JSON = JSON.stringify({
  梗概: '林昭夜裡摸進青雲宗',
  关键事件: '踩點、失手、翻牆；收在藏書閣門口。三拍推進。',
  看点: '第三塊令牌',
});

const P1 = '.novelwarden/summaries/001-夜入青雲.md';
const P2 = '.novelwarden/summaries/002-藏書閣.md';

/** 一份只有梗概、還沒排過（關鍵事件空著）的細綱：落盤前後的「排過沒有」由它對照。 */
function blankPlot(no, title) {
  return {
    no, title, upstreamHash: '', done: false,
    sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: `第 ${no} 章要達成的事` },
  };
}

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted;

let settings = {};
let replyFn = () => PLOT_JSON;

/**
 * 落盤卡片來了怎麼答。
 *
 * 返回 verdict（`proceed` / `skip` / `stop`），或 undefined 表示**不答**
 * ——那時 `send()` 會一直等著，用例得自己去把它收掉（換會話 / 銷燬面板）。
 * 答之前想幹點別的（切章、改氣泡裡的文字）就在這個函式里幹：真實的次序
 * 也是這樣——那些動作都發生在作者點下按鈕之前。
 */
let onGate = async () => 'proceed';
/** 收到過的卡片，按順序。 */
let gates = [];

function attach() {
  posted = [];
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        // 不在 post 裡同步重入 controller：真實的回答也是下一個事件迴圈裡
        // 從前端發回來的。
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
}

/** 發一輪「寫細綱」（extra 可以改成別的階段），回收這一輪推給前端的訊息（含落盤那一問的往返）。 */
async function send(target, extra = {}) {
  posted.length = 0;
  gates = [];
  await controller.handle({
    type: 'send',
    payload: {
      text: '排一下',
      stage: 'plot',
      capability: 'generate',
      target,
      targetNo: 0,
      attachments: [],
      excludedIds: [],
      ...extra,
    },
  });
  const turns = posted.filter((m) => m.type === 'turnDone').map((m) => m.turn);
  return {
    turns,
    assistant: [...turns].reverse().find((x) => x.role === 'assistant'),
    gate: gates[0],
    toasts: posted.filter((m) => m.type === 'toast'),
  };
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
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  // 覆蓋審閱一律放行：這一組測的是「寫到哪」，不是「問不問」。
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply: (messages, i) => replyFn(messages, i),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'accept', title: '青雲劍錄' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青雲'], [2, '藏書閣']]) {
    await ws.writePlot(blankPlot(no, title));
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('生成一輪 → 當場問一句', () => {
  let r;
  let diskWhenAsked;

  before(async () => {
    replyFn = () => PLOT_JSON;
    onGate = async () => {
      // ★ 答之前磁碟上不該有任何動靜：寫在「同意」之後，不在生成之後。
      diskWhenAsked = await project.readPlot(P1);
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('產出了回覆', () => {
    assert.ok(r.assistant, JSON.stringify(r.turns.map((x) => x.role)));
  });

  test('問了這一句', () => {
    assert.ok(r.gate, JSON.stringify(posted.map((m) => m.type)));
  });

  test('卡片掛在這一輪的氣泡上', () => {
    assert.equal(r.gate.turnId, r.assistant.id);
  });

  test('說得出寫到哪、是什麼形狀', () => {
    assert.ok(r.gate.title.includes('夜入青雲'), r.gate.title);
    assert.ok(r.gate.detail.includes('3/7 節'), r.gate.detail);
  });

  // 叫停整輪不在這張卡上（那是輸入框旁邊那顆「停止」）；拒絕那顆寫的是
  // 「不採納」——這一問不是「跳過一步」，是「這份產物我不要」。
  test('兩顆按鈕：確認 / 不採納', () => {
    assert.equal(r.gate.proceed, '確認');
    assert.equal(r.gate.skip, '不採納');
    assert.equal(r.gate.stop, undefined, r.gate.stop);
  });

  test('還沒答時磁碟上沒動靜', () => {
    assert.ok(!bundle.plotFile.isPlotFilled(diskWhenAsked.sections), JSON.stringify(diskWhenAsked.sections));
  });

  test('答了才寫進去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('氣泡上記下寫到哪了', () => {
    assert.equal(r.assistant.acceptedTo, P1, JSON.stringify(r.assistant));
  });

  // 展示快照仍在：翻回來看得出這一輪產出過什麼。
  test('展示快照還在', () => {
    assert.equal(r.assistant.artifact.summary, '細綱 · 3/7 節', JSON.stringify(r.assistant.artifact));
  });
});

describe('落點從 draft 裡取，不看當下選中的那一章', () => {
  let r;

  before(async () => {
    t.remove(P2);
    await new bundle.ws.Workspace(project).writePlot(blankPlot(2, '藏書閣'));
    project.invalidate();
    replyFn = () => PLOT_JSON;
    h.answers.push('覆蓋');
    onGate = async () => {
      // 生成完、還沒點寫入之前**切到另一章**——這正是從前會寫錯地方的那一下。
      await controller.handle({ type: 'setTarget', target: { kind: 'plot', plotRelPath: P2 } });
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('寫成功了', () => {
    assert.ok(!r.toasts.some((x) => x.level === 'error'), JSON.stringify(r.toasts));
  });

  test('寫進了生成時那一章', () => {
    assert.ok(t.read(P1).includes('三拍推進'));
  });

  // 關鍵：切過去的那一章一個字都不該被寫。
  test('沒有寫到當下選中的那一章', async () => {
    const other = await project.readPlot(P2);
    assert.ok(!bundle.plotFile.isPlotFilled(other.sections), JSON.stringify(other.sections));
  });
});

describe('落盤的是氣泡裡當下那份', () => {
  let r;

  before(async () => {
    replyFn = () => PLOT_JSON;
    h.answers.push('覆蓋');
    onGate = async (msg) => {
      // 作者在氣泡裡改了兩個字再點寫入：真實次序也是這樣——contenteditable
      // 失焦時先發 `editTurn`，然後那一下點選才發出去。
      await controller.handle({
        type: 'editTurn',
        turnId: msg.turnId,
        text: JSON.stringify({
          梗概: '林昭夜裡摸進青雲宗',
          关键事件: '踩點、失手、翻牆；收在藏書閣門口。我自己改成了兩拍。',
          看点: '第三塊令牌',
        }),
      });
      return 'proceed';
    };
    r = await send({ kind: 'plot', plotRelPath: P2 });
  });

  test('寫成功了', () => {
    assert.ok(!r.toasts.some((x) => x.level === 'error'), JSON.stringify(r.toasts));
  });

  // 用 draft.raw 的話，作者改的那兩個字就沒了——而他改完才點的寫入。
  test('落盤的是改過的那一版', () => {
    assert.ok(t.read(P2).includes('我自己改成了兩拍'));
  });

  test('模型原樣輸出的那一版沒寫進去', () => {
    assert.ok(!t.read(P2).includes('三拍推進'));
  });
});

describe('答「不採納」', () => {
  let r;

  before(async () => {
    t.remove(P1);
    await new bundle.ws.Workspace(project).writePlot(blankPlot(1, '夜入青雲'));
    project.invalidate();
    replyFn = () => PLOT_JSON;
    onGate = async () => 'skip';
    r = await send({ kind: 'plot', plotRelPath: P1 });
  });

  test('一個字都沒寫', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  // 翻回來要看得出「這一輪產出過一份細綱，我沒要」。
  test('氣泡上留了一行「未採納」', () => {
    assert.equal(r.assistant.artifact.declined, true, JSON.stringify(r.assistant.artifact));
    assert.equal(r.assistant.acceptedTo, undefined, r.assistant.acceptedTo);
  });
});

describe('討論型回覆沒有產物，也就沒有卡片', () => {
  let r;

  before(async () => {
    replyFn = () => '我覺得這一章的衝突可以提前。';
    onGate = async () => 'proceed';
    r = await send({ kind: 'plot', plotRelPath: P1 }, { capability: 'discuss' });
  });

  test('沒問', () => {
    assert.equal(r.gate, undefined, JSON.stringify(r.gate));
  });

  test('也沒有展示快照', () => {
    assert.equal(r.assistant.artifact, undefined, JSON.stringify(r.assistant.artifact));
  });
});

/**
 * 前端無狀態：網頁重新整理 / webview 重建之後，還沒答的那張卡要跟著回來——
 * 不重推的話，作者眼前什麼都沒有，而後端還在等他回答。
 */
describe('重新整理網頁：沒答的卡片跟著回來', () => {
  let pending;
  let requestId;
  let resent;

  before(async () => {
    t.remove(P2);
    await new bundle.ws.Workspace(project).writePlot(blankPlot(2, '藏書閣'));
    project.invalidate();
    replyFn = () => PLOT_JSON;
    onGate = async (msg) => {
      requestId = msg.requestId;
      return undefined; // 先不答：模擬作者還沒點，網頁就重新整理了
    };
    pending = send({ kind: 'plot', plotRelPath: P2 });
    // 等這一問發出來。
    while (!requestId) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // 「重新整理網頁」= 前端重連後發一條 ready，後端重放全量狀態。
    posted.length = 0;
    onGate = async () => 'proceed';
    await controller.handle({ type: 'ready' });
    resent = posted.filter((m) => m.type === 'gate');
    await pending;
  });

  test('那張卡被重推了一遍', () => {
    assert.equal(resent.length, 1, JSON.stringify(posted.map((m) => m.type)));
    assert.equal(resent[0].requestId, requestId);
  });

  test('重推的那張答了照樣落盤', () => {
    assert.ok(t.read(P2).includes('三拍推進'));
  });
});

/**
 * 面板銷燬（關掉整個視窗）時那張卡沒人答得了：**按「沒採納」結算**，
 * 不留一個永遠懸著的等待。產物不落盤，作者重新生成一次即可。
 */
describe('面板銷燬：卡片作廢，產物不落盤', () => {
  let r;

  before(async () => {
    t.remove(P1);
    await new bundle.ws.Workspace(project).writePlot(blankPlot(1, '夜入青雲'));
    project.invalidate();
    replyFn = () => PLOT_JSON;
    let asked = false;
    onGate = async () => {
      asked = true;
      return undefined;
    };
    const pending = send({ kind: 'plot', plotRelPath: P1 });
    while (!asked) {
      await new Promise((x) => setTimeout(x, 5));
    }
    controller.dispose();
    r = await pending;

    // 後面的用例還要用 controller：換一個新的接著跑。
    controller = new bundle.controller.ChatController(project);
    attach();
  });

  test('沒寫進去', async () => {
    const plot = await project.readPlot(P1);
    assert.ok(!bundle.plotFile.isPlotFilled(plot.sections), JSON.stringify(plot.sections));
  });

  test('記成「未採納」', () => {
    assert.equal(r.assistant.artifact.declined, true, JSON.stringify(r.assistant.artifact));
  });
});

/**
 * 寫正文：答了才落到**同號的章節**上。沒有中轉站了——從前這一步寫進
 * `manuscripts/`，要等作者拆章才進 `chapters/`。
 */
describe('寫正文 → 當場問一句 → 落到同號章節', () => {
  const CHAPTER = 'chapters/001-夜入青雲.txt';
  let r;
  let chapterWhenAsked;
  let again;
  let reviewedAgain;
  let afterAppend;
  let rewrite;
  let reviewedRewrite;

  before(async () => {
    replyFn = () => '雨下了三天，青雲宗的石階泡得發白。';
    onGate = async () => {
      chapterWhenAsked = t.has(CHAPTER);
      return 'proceed';
    };
    r = await send({ kind: 'manuscript', plotRelPath: P1 }, { stage: 'manuscript' });

    // 接著寫（主按鈕「接著寫」帶的寫法）：追加在末尾，不覆蓋，所以也不彈覆蓋審閱。
    replyFn = () => '他數到第三盞燈才動。';
    onGate = async () => 'proceed';
    h.expect();
    again = await send({ kind: 'manuscript', plotRelPath: P1 }, { stage: 'manuscript', writeMode: 'continue' });
    reviewedAgain = h.reviewed.length;
    afterAppend = t.read(CHAPTER);

    // 不帶寫法再寫一次：這一章已經有正文了，是整章重寫——卡片說覆蓋、寫入前審閱。
    replyFn = () => '門開了，有人請他進去。';
    h.expect();
    rewrite = await send({ kind: 'manuscript', plotRelPath: P1 }, { stage: 'manuscript' });
    reviewedRewrite = h.reviewed.length;
  });

  test('問了這一句', () => {
    assert.ok(r.gate, JSON.stringify(posted.map((m) => m.type)));
  });

  // 新寫與接著寫都不吞掉已有的東西——卡片上不嚇唬人說「覆蓋」；接著寫說清是「追加」。
  test('新寫說寫入、接著寫說追加，都不說覆蓋', () => {
    assert.ok(r.gate.title.includes('寫入到'), r.gate.title);
    assert.ok(again.gate.title.includes('追加到'), again.gate.title);
  });

  test('重寫：卡片說覆蓋，並說寫入前會先對比', () => {
    assert.ok(rewrite.gate.title.includes('覆蓋到'), rewrite.gate.title);
    assert.match(rewrite.gate.detail, /先對比/);
  });

  // 正文是 .txt（2026-10-24）：沒有標題行，重寫也不憑空加。
  test('重寫：寫入前審閱一次，整章換成新寫的', () => {
    assert.equal(reviewedRewrite, 1);
    const text = t.read(CHAPTER);
    assert.ok(text.startsWith('門開了') && !text.includes('第三盞燈'), text);
  });

  test('卡片說得出是多少字的正文', () => {
    assert.ok(r.gate.detail.startsWith('正文 · '), r.gate.detail);
  });

  test('還沒答時章節不存在', () => {
    assert.equal(chapterWhenAsked, false);
  });

  test('答了才新建同號的章節', () => {
    assert.ok(afterAppend.includes('石階泡得發白'), afterAppend);
  });

  test('氣泡上記下寫到哪個章節了', () => {
    assert.equal(r.assistant.acceptedTo, CHAPTER, JSON.stringify(r.assistant));
  });

  test('細綱上記下 writtenFrom', async () => {
    const plot = await project.readPlot(P1);
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  test('接著寫追加在同一章末尾', () => {
    assert.ok(afterAppend.includes('石階泡得發白') && afterAppend.includes('第三盞燈'), afterAppend);
    assert.equal(again.assistant.acceptedTo, CHAPTER);
  });

  test('追加不彈覆蓋審閱', () => {
    assert.equal(reviewedAgain, 0);
  });
});

/**
 * 拆細綱給下一章找的落點是純序號的佔位路徑（主按鈕的 target 就是
 * `plotPathOfNo(N)`）。細綱按產物帶的標題落盤，檔名於是與佔位路徑不同。
 */
describe('拆細綱落在佔位路徑上', () => {
  const PLACEHOLDER = '.novelwarden/summaries/003.md';
  const REAL = '.novelwarden/summaries/003-雪夜.md';
  let r;
  let pipe;

  before(async () => {
    replyFn = () => JSON.stringify({ title: '雪夜', ...JSON.parse(PLOT_JSON) });
    onGate = async () => 'proceed';
    r = await send({ kind: 'plot', plotRelPath: PLACEHOLDER });
    pipe = posted.filter((m) => m.type === 'pipeline').pop();
  });

  test('細綱按產物的標題落盤', () => {
    assert.ok(t.has(REAL), REAL);
    assert.equal(r.assistant.acceptedTo, REAL, JSON.stringify(r.assistant));
  });

  // 採納後會話 target 改到真實路徑（`retargetPlot`），流水線也按章號認得這份細綱：
  // 流水線條不再說「這一章還沒有細綱」，主按鈕轉到寫正文。否則再點一次，新產物會
  // 落回佔位路徑（見 creation.test.js 同名用例）。
  test('寫完之後流水線條認得這一章，主按鈕轉到寫正文', () => {
    assert.equal(pipe?.pipeline?.plot.exists, true, JSON.stringify(pipe?.pipeline?.plot));
    assert.equal(pipe?.next?.stage, 'manuscript', JSON.stringify(pipe?.next));
  });

  test('會話 target 跟到了真實路徑', () => {
    const session = posted.filter((m) => m.type === 'session').pop()?.session;
    assert.equal(session?.target?.plotRelPath, REAL, JSON.stringify(session?.target));
  });
});

describe('併發控制搬到 controller 之後', () => {
  let concurrent;
  let callsTotal;

  before(async () => {
    replyFn = () => PLOT_JSON;
    onGate = async () => 'skip';
    fake.reset();
    // 不 await 第一條：`send` 第一行就佔住生成位（早於它自己的
    // `await persist`），所以此刻第二條一定撞得上。
    //
    // 從前佔位在 runTurn 裡，而 send 要先 `await persist(c)` 才走到那兒——
    // 第一條在落盤處讓出事件迴圈時 currentAbort 還沒設，第二條照樣過檢，
    // 兩條一起燒 token。本機磁碟快，第一條常常一路同步跑完，所以那個競態
    // 只在 CI 上現形。
    const first = send({ kind: 'plot', plotRelPath: P1 });
    concurrent = await send({ kind: 'plot', plotRelPath: P1 });
    await first;
    callsTotal = fake.calls.length;
  });

  // 這句話與它的行為是搬家前後必須一字不差的那一條。
  test('第二條被拒，說「已有一個生成任務在進行中」', () => {
    assert.ok(
      concurrent.toasts.some((m) => m.level === 'error' && m.message.includes('已有一個生成任務在進行中')),
      JSON.stringify(concurrent.toasts)
    );
  });

  // 兩條請求只該燒一次 token。
  test('被拒的那條沒有調模型', () => {
    assert.equal(callsTotal, 1, `調了 ${callsTotal} 次`);
  });

  test('第一條跑完之後又能發了', async () => {
    const again = await send({ kind: 'plot', plotRelPath: P1 });
    assert.ok(again.assistant?.artifact, JSON.stringify(again.toasts));
  });

  // 上面那兩條依賴「第二次 send 恰好撞在第一次讓出事件迴圈的視窗裡」，
  // 磁碟一快就可能整條同步跑完、根本沒撞上，於是競態迴歸了也照樣綠。
  // 這一條不靠時序：直接查佔位發生在 send 的第一個 await **之前**。
  test('佔位早於 send 裡任何一次 await（競態視窗為零）', () => {
    const src = fs.readFileSync('src/core/controller/chat.ts', 'utf8');
    const from = src.indexOf('export async function send');
    const to = src.indexOf('/** 重來一輪', from);
    assert.ok(from >= 0 && to > from, '找不到 send 的函式體');
    // 註釋裡也有「await」二字，按行剔掉註釋再找。
    const code = src
      .slice(from, to)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const lease = code.indexOf('c.beginGeneration()');
    const firstAwait = code.indexOf('await ');
    assert.ok(lease >= 0, 'send 裡沒有佔位');
    assert.ok(
      lease < firstAwait,
      `佔位在第一個 await 之後（佔位 ${lease} / await ${firstAwait}）：` +
        '兩條併發請求會雙雙過檢、各燒一份 token'
    );
  });
});
