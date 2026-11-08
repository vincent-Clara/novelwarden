/**
 * 分段重寫情節大綱（features/outlineRewrite.ts）：工程頁「情節大綱」右鍵「重寫…」。
 *
 * 情節大綱是各章細綱「梗概」的彙總（docs/design/plans/2026-10-22-outline-from-plots.md）：**只重寫還沒寫正文的章**，
 * 寫過的那幾條由定稿照正文寫，不動；寫入時按章號拆回各章細綱。
 *
 * | 用例組 | 釘的是什麼 |
 * |---|---|
 * | 分段 | 只切沒寫的那一截，按 20 章一段；空大綱不分段；排到的章都寫過了，段是空的 |
 * | 全套 | 照架構規劃；要求每段都帶；後一段看得見前一段的新版；一次審閱、整份寫入（拆回各章細綱），寫過的章不動 |
 * | 中途失敗 | 已重寫的幾段照樣審閱寫入，沒輪到的保留舊版，報錯 |
 * | 不寫入 | 審閱時放棄：細綱一個字不動 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let replyFn;
const projects = [];

const pad3 = (n) => String(n).padStart(3, '0');

/** 舊大綱：第 1–45 章，一章一條。 */
function oldOutline() {
  return `# 情節大綱\n\n${entries(1, 45, '舊版')}\n`;
}

/** 第 from–to 章，一章一條：`## 第N章：tag` + `tag第 N 章。` */
function entries(from, to, tag) {
  const out = [];
  for (let no = from; no <= to; no++) {
    out.push(`## 第${no}章：${tag}\n${tag}第 ${no} 章。`);
  }
  return out.join('\n\n');
}

/** 這一次呼叫要寫哪一段。 */
function rangeOf(messages) {
  const user = messages[messages.length - 1].content;
  const planned = /本次必須寫第 (\d+)(?:–(\d+))? 章的情節大綱/.exec(user);
  return planned ? { from: Number(planned[1]), to: Number(planned[2] ?? planned[1]) } : undefined;
}

function defaultReply(messages) {
  const r = rangeOf(messages);
  return r ? entries(r.from, r.to, '新規劃') : '';
}

/** 彙總出來的情節大綱（沒有標題行與說明）。 */
async function outlineOf(t) {
  t.project.invalidate();
  return t.project.readOutline();
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    rewrite: './src/core/features/outlineRewrite.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => replyFn(messages) });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

/** 寫了 7 章、大綱排到第 45 章的工程。 */
async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '重寫大綱測試' });
  projects.push(t);
  for (let no = 1; no <= 7; no++) {
    t.write(`chapters/${pad3(no)}-第${no}章.md`, `# 第${no}章\n\n林昭第${no}次見到沈青。\n`);
  }
  writeOutline(t, oldOutline());
  t.project.invalidate();
  fake.reset();
  replyFn = defaultReply;
  h.setReviewVerdict('apply');
  return t;
}

describe('分段', () => {
  test('只切沒寫的那一截，按 20 章一段', () => {
    const plan = bundle.rewrite.planOutlineRewrite(114, 100);
    assert.deepEqual(plan.batches.map((b) => [b.from, b.to]), [[101, 114]]);
    assert.deepEqual(bundle.rewrite.planOutlineRewrite(30, 0).batches.map((b) => [b.from, b.to]), [
      [1, 20],
      [21, 30],
    ]);
  });

  test('排到的章都寫過了：段是空的', () => {
    const over = bundle.rewrite.planOutlineRewrite(30, 50);
    assert.equal(over.through, 30);
    assert.deepEqual(over.batches, []);
  });

  test('還沒有大綱（沒有一章有梗概）不分段', async () => {
    const t = await makeTempProject(bundle.project, { prefix: 'outline-rewrite-empty', title: '空' });
    projects.push(t);
    assert.equal(await bundle.rewrite.outlineRewritePlan(t.project), undefined);
  });
});

describe('全套', () => {
  let t;
  let plan;
  let calls;
  let before7;
  before(async () => {
    t = await fresh('outline-rewrite-all');
    before7 = t.read('.novelwarden/summaries/007-第7章.md');
    plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.expect();
    calls = await bundle.rewrite.rewriteOutline(t.project, plan, '節奏再快一點');
  });

  test('第 1–7 章寫過了不重寫，第 8–45 章分兩段重新規劃，說明裡寫明次數', () => {
    assert.deepEqual(plan.batches.map((b) => [b.from, b.to]), [
      [8, 27],
      [28, 45],
    ]);
    const text = bundle.rewrite.describeOutlineRewrite(plan);
    assert.match(text, /按 20 章一段重寫第 8–45 章，呼叫 2 次模型/);
    assert.match(text, /第 1–7 章已經寫了正文，那幾條是同步時照正文寫的，不動/);
    assert.equal(calls, 2);
    assert.deepEqual(fake.calls.map((m) => rangeOf(m)), plan.batches);
  });

  test('作者的要求每一段都帶', () => {
    for (const m of fake.calls) {
      assert.ok(m.some((x) => x.content.includes('節奏再快一點')));
    }
  });

  test('後一段看得見前一段剛寫好的新版，沒輪到的還是舊版', () => {
    const second = fake.calls[1].map((x) => x.content).join('\n');
    assert.match(second, /【重寫中】第 8–27 章是這次剛重寫好的新版/);
    assert.match(second, /新規劃第 26 章。/);
    assert.doesNotMatch(second, /舊版第 26 章。/);
    const first = fake.calls[0].map((x) => x.content).join('\n');
    // 這一段（第 8–27 章）之後還沒輪到的舊版只帶第一行。
    assert.match(first, /後面已經排好的（只列第一行）：\n- 第28章 舊版：舊版第 28 章。/);
  });

  test('一次審閱、整份寫入：拆回各章細綱，寫過的章一個字不動', async () => {
    assert.equal(h.reviewed.length, 1);
    const outline = await outlineOf(t);
    assert.match(outline, /## 第1章：舊版\n舊版第 1 章。/);
    assert.match(outline, /## 第8章：新規劃\n新規劃第 8 章。/);
    assert.match(outline, /## 第45章：新規劃/);
    assert.doesNotMatch(outline, /舊版第 8 章/);
    assert.equal(t.read('.novelwarden/summaries/007-第7章.md'), before7);
    assert.ok(!h.erred(), h.toasts.join('\n'));
  });
});

describe('中途失敗', () => {
  test('已重寫的幾段照樣審閱寫入，沒輪到的保留舊版，報錯', async () => {
    const t = await fresh('outline-rewrite-halt');
    const plan = await bundle.rewrite.outlineRewritePlan(t.project);
    replyFn = (m) => (rangeOf(m)?.from === 28 ? '' : defaultReply(m));
    h.expect();
    await bundle.rewrite.rewriteOutline(t.project, plan, '');
    assert.equal(h.reviewed.length, 1);
    const outline = await outlineOf(t);
    assert.match(outline, /## 第8章：新規劃/);
    assert.match(outline, /## 第31章：舊版/);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('已重寫第 8–27 章的大綱，後面的保留舊版')), h.toasts.join('\n'));
  });
});

describe('不寫入', () => {
  test('審閱時放棄：細綱一個字不動', async () => {
    const t = await fresh('outline-rewrite-discard');
    const before = await outlineOf(t);
    const plan = await bundle.rewrite.outlineRewritePlan(t.project);
    h.setReviewVerdict('discard');
    h.expect();
    await bundle.rewrite.rewriteOutline(t.project, plan, '');
    assert.equal(await outlineOf(t), before);
  });
});

// 工程頁「情節大綱」右鍵「重寫…」：問完要求先彈確認框報段數、挑這一次的模型（2026-10-23 作者要的），取消就不調。
describe('從工程頁右鍵進來', () => {
  async function rewriteFromProjectPage(t, ...answers) {
    const controller = new bundle.controller.ChatController(t.project);
    controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
    h.expect(...answers);
    await controller.handle({ type: 'rewriteArchitecture', target: { kind: 'outline' } });
    controller.dispose();
  }

  test('問完要求、在確認框上取消：不調模型，大綱不動', async () => {
    const t = await fresh('outline-rewrite-confirm-cancel');
    const before = await outlineOf(t);
    await rewriteFromProjectPage(t, '節奏再快一點', undefined);
    const [c] = h.confirms;
    assert.deepEqual(c.actions, ['開始重寫']);
    assert.ok(c.message.includes('預計 2 次呼叫'), c.message);
    assert.match(c.detail, /按 20 章一段重寫第 8–45 章/);
    assert.equal(c.call.model, '', '預設按分檔（與不問時一樣走情節大綱那一檔）');
    assert.ok(c.call.contextDetail, JSON.stringify(c.call));
    assert.equal(fake.callCount(), 0);
    assert.equal(await outlineOf(t), before);
  });

  test('點「開始重寫」：照分段重寫', async () => {
    const t = await fresh('outline-rewrite-confirm-go');
    await rewriteFromProjectPage(t, '', '開始重寫');
    assert.equal(fake.callCount(), 2);
    assert.match(await outlineOf(t), /## 第8章：新規劃/);
  });
});
