/**
 * 從已寫正文補記敘事線（`features/threadsBackfill.ts`，敘事線重做四期第 2 個提交）：要判哪幾章、確認框怎麼說、按章序列判、
 * 一章沒判成就停、再點一次從那一章接著判。真臨時工程 + 假模型；工程頁一路點下來的四期驗收另在 threadsBackfillFlow.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 要判的是水位之後、定稿到之前、定稿過且正文沒再改過的章；改過的、沒定稿的列進 skipped | 第 4 條：不偷偷補 |
 * | 一條線都沒有、有情節大綱：先排線，次數算進同一個確認框（每章 2–6 次 + 排線 2 次；2026-10-25 起含轉寫） | 設計稿「九」；第 4 條 |
 * | 確認框寫明章數與次數，走「定稿」檔（加上排線的「劇情細綱」檔）、看詳細度，轉寫單列一行 | 第 4 條；設計稿「呼叫次數」 |
 * | 按章號序列：後一章認事件時看得到前一章新認出的線 | 序列的理由 |
 * | 一章沒判成：停下，已判的留著，水位停在它前面，失敗掛在那一章上；後面的章一次都沒調 | 第 16 條；⚑ 一章沒判成就停 |
 * | 再點一次：從沒判成的那一章接著判，水位推到定稿到，那一章上的失敗清掉 | 補記從水位之後接著走 |
 * | 完成提示：判了幾章、記了多少事件、新認出幾條線幾條伏筆、哪幾章沒判成、判到第幾章 | 第 2 條 |
 */
const { describe, test, before, after } = require('node:test');
const fs = require('fs');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;

const THREADS = '.novelwarden/threads';
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;
const text = (no) => `# 第${no}章\n\n林昭在第${no}章走進青崖鎮。\n\n沈氏在第${no}章翻開名冊。\n`;

/** 第幾章認事件那一次答壞（解析不出）。 */
let broken = new Set();
/** 認事件那一次送來了哪幾章（按先後）、送來時提示裡有沒有「沈氏的來意」那條線。 */
const asked = [];

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只從作者給的小說配置、故事前提、角色圖譜與情節大綱裡排出這本書的敘事線')) {
    return JSON.stringify({ threads: [{ title: '青崖舊案', kind: '主线', from: 1, to: 30, intent: '查清七年前那場火。' }] });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('你是小說定稿事實審查員')) {
    asked.push({ no, knowsGrown: user.includes('沈氏的來意') });
    if (broken.has(no)) {
      return '這一章沒什麼好說的。';
    }
    return JSON.stringify({
      events: [{ line: '青崖舊案', type: '推进', what: `第 ${no} 章往前查`, evidence: `林昭在第${no}章走進青崖鎮。` }],
      newThreads:
        no === 1 ? [{ title: '沈氏的來意', kind: '人物线', intent: '沈氏為何盯上林昭。', evidence: '沈氏在第1章翻開名冊。' }] : [],
      newForeshadowing: [],
    });
  }
  if (system.includes('判斷它們是不是已有的某一條換了個說法')) {
    return JSON.stringify({ merges: [] });
  }
  if (system.includes('給每一條寫一兩句「當前進度」')) {
    const lines = [...user.matchAll(/^【線】(.+)$/gm)].map((m) => m[1]);
    return JSON.stringify({ progress: lines.map((line) => ({ line, text: `第 ${no} 章：${line}走到了這裡。` })) });
  }
  return '（認不出這一步）';
}

/** 第 1–n 章：正文 + 定稿過的細綱（sourceHash 對得上正文）。 */
async function writeFinalized(n) {
  for (let no = 1; no <= n; no++) {
    t.write(CH(no), text(no));
  }
  project.invalidate();
  const chapters = await project.listChapters();
  for (let no = 1; no <= n; no++) {
    const hash = chapters.find((c) => c.order === no).contentHash;
    t.write(PLOT(no), `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: ${hash}\n---\n\n# 第${no}章\n\n## 梗概\n第 ${no} 章。\n`);
  }
  project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    backfill: './src/core/features/threadsBackfill.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    threadFile: './src/core/model/threadFile.ts',
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
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  t = await makeTempProject(bundle.project, { prefix: 'threads-backfill', title: '青崖記' });
  project = t.project;
  await writeFinalized(6);
  // 情節大綱是各章細綱梗概的彙總：第 1–6 章換成大綱那一條，第 7–20 章建只有梗概的空殼。
  writeOutline(t, outlineOf(20, { text: { 1: '林昭進鎮，一路查名冊。' } }));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle?.db);
});

const failuresOf = async (rel) => (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];

describe('要判哪幾章（零呼叫）', () => {
  test('水位之後、定稿到之前：定稿過、正文沒改過的判；改過的、沒定稿的列出來；一條線都沒有、有大綱就先排線', async () => {
    // 第 2 章判過了（單章定稿時）；第 5 章定稿之後正文又改了；第 7 章寫了沒定稿（在定稿到之後，不歸補記管）。
    await project.writeManifest({ ...(await project.readManifest()), threadsJudged: [2] });
    t.write(CH(5), `${text(5)}\n又加了一段。\n`);
    t.write(CH(7), text(7));
    project.invalidate();
    const plan = await bundle.backfill.planThreadsBackfill(project);
    assert.deepEqual(plan.chapters.map((c) => c.order), [1, 3, 4, 6]);
    assert.deepEqual(plan.skipped, [{ no: 5, why: '同步之後正文又改過' }]);
    assert.equal(plan.planFirst, true);
    assert.equal(plan.current, 6);
    // 每章寫 1–3 次、各轉寫 1 次（重轉最多再 1 次）：2–6、最多 9；先排線：排 1 次、轉寫 1 次，最多 3 次。
    assert.deepEqual(plan.calls, { low: 8 + 2, high: 24 + 2, max: 36 + 3 });
    // 收回去：後面的用例從乾淨的第 1–6 章起。
    await project.writeManifest({ ...(await project.readManifest()), threadsJudged: undefined });
    t.write(CH(5), text(5));
    t.remove(CH(7));
    project.invalidate();
  });

  test('沒有情節大綱（沒有一章細綱寫了梗概）：不排線；中間沒定稿的章列出來', async () => {
    const dir = t.rel('.novelwarden/summaries');
    const saved = new Map();
    for (const name of fs.readdirSync(dir).filter((f) => /^\d/.test(f))) {
      const rel = `.novelwarden/summaries/${name}`;
      saved.set(rel, t.read(rel));
      t.write(rel, saved.get(rel).replace(/## 梗概\n[\s\S]*?(?=\n## |$)/, '## 梗概\n'));
    }
    t.write(PLOT(3), t.read(PLOT(3)).replace(/sourceHash: .*\n/, ''));
    project.invalidate();
    const plan = await bundle.backfill.planThreadsBackfill(project);
    assert.equal(plan.planFirst, false);
    assert.deepEqual(plan.skipped, [{ no: 3, why: '還沒同步' }]);
    assert.deepEqual(plan.calls, { low: 10, high: 30, max: 45 });
    for (const [rel, text] of saved) {
      t.write(rel, text);
    }
    await writeFinalized(6);
    writeOutline(t, outlineOf(6, { text: { 1: '林昭進鎮，一路查名冊。' } }));
    project.invalidate();
  });
});

describe('補記：按章序列，第 4 章沒判成就停', () => {
  let n;

  before(async () => {
    broken = new Set([4]);
    asked.length = 0;
    fake.calls.length = 0;
    h.expect('開始補記');
    n = await bundle.backfill.backfillThreads(project);
  });

  test('確認框寫明章數與次數，先排線算進去；走「定稿」檔與「劇情細綱」檔，看詳細度', () => {
    const c = h.confirms.at(-1);
    assert.match(c.message, /^從已寫正文補記敘事線：第 1–6 章同步過、敘事線還沒判/);
    assert.ok(c.message.includes('先從情節大綱排一次（排 1 次、轉寫 1 次）'), c.message);
    assert.ok(c.message.includes('（每章 2–6 次）') && c.message.includes('預計 14–38 次呼叫，最多 57 次'), c.message);
    assert.deepEqual(c.actions, ['開始補記']);
    assert.ok(c.detail.includes('共 6 章，按章號一章一章往後判'), c.detail);
    assert.equal(c.call.tiers.length, 2);
    // 轉寫不跟這一次挑的模型，單列一行（2026-10-25）。
    assert.equal(c.call.fixed?.length, 1, JSON.stringify(c.call));
    assert.ok('contextDetail' in c.call);
  });

  test('先排線，再按章號序列：第 2 章認事件時看得到第 1 章新認出的線；第 4 章沒判成就停，第 5、6 章沒調', () => {
    assert.deepEqual(asked.map((a) => a.no), [1, 2, 3, 4]);
    assert.equal(asked[0].knowsGrown, false);
    assert.equal(asked[1].knowsGrown, true);
    assert.ok(t.has(`${THREADS}/青崖舊案.md`));
    assert.ok(t.has(`${THREADS}/沈氏的來意.md`));
    // 排線 1 + 第 1 章（認事件、歸併、當前進度）3 + 第 2、3 章（認事件、當前進度）各 2 + 第 4 章認事件 1。
    assert.equal(fake.calls.length, 1 + 3 + 2 + 2 + 1);
    assert.equal(n, fake.calls.length);
  });

  test('已判的留著、水位停在第 4 章前面；失敗掛在第 4 章上（黃 ❗，op threads）', async () => {
    const main = bundle.threadFile.parseThreadFile(t.read(`${THREADS}/青崖舊案.md`), `${THREADS}/青崖舊案.md`);
    assert.deepEqual(main.events.filter((e) => !e.planned).map((e) => e.chapter), [1, 2, 3]);
    assert.deepEqual(await project.readThreadsMark(), { through: 3, judged: [] });
    const [f] = await failuresOf(CH(4));
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'threads');
    assert.match(f.message, /^從已寫正文補記敘事線沒成/);
  });

  test('完成提示：先排線、判了幾章、記了多少事件、新認出幾條線；第 4 章沒判成、後面 2 章沒判；判到第 3 章', () => {
    const toast = h.toasts.at(-1);
    assert.ok(toast.startsWith('error: '), toast);
    assert.ok(toast.includes('先從情節大綱排出 1 條敘事線'), toast);
    assert.ok(toast.includes('敘事線補記：判了 3 章（第 1–3 章），記下 4 個事件，新認出 1 條線'), toast);
    assert.ok(toast.includes('第 4 章沒判成（模型返回的敘事線事件解析不出來），停在那裡，後面 2 章沒判'), toast);
    assert.ok(toast.includes('敘事線判到第 3 章（同步到第 6 章）'), toast);
  });

  test('再點一次：線已經有了不再排，從第 4 章接著判，水位推到第 6 章，第 4 章上的失敗清掉', async () => {
    broken = new Set();
    asked.length = 0;
    h.expect('開始補記');
    await bundle.backfill.backfillThreads(project);
    const c = h.confirms.at(-1);
    assert.match(c.message, /^從已寫正文補記敘事線：第 4–6 章同步過/);
    assert.ok(!c.message.includes('先從情節大綱排一次'), c.message);
    assert.deepEqual(asked.map((a) => a.no), [4, 5, 6]);
    assert.deepEqual(await project.readThreadsMark(), { through: 6, judged: [] });
    assert.deepEqual(await failuresOf(CH(4)), []);
    assert.ok(h.toasts.at(-1).includes('敘事線判到第 6 章，跟上了同步'), h.toasts.at(-1));
  });

  test('跟上了再點：不彈框、零呼叫，說清已經判到哪', async () => {
    fake.calls.length = 0;
    h.expect();
    assert.equal(await bundle.backfill.backfillThreads(project), 0);
    assert.equal(h.confirms.length, 0);
    assert.equal(fake.calls.length, 0);
    assert.ok(h.toasts.at(-1).includes('敘事線已經判到第 6 章、跟上了同步'), h.toasts.at(-1));
  });
});
