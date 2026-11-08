/**
 * 工程頁「存檔點…」彈窗的後端一半（`controller/checkpoints.ts`）：五條訊息走一遍。儲存與退回的細節在
 * tests/integration/workspace/checkpoints.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 列表：還不是工程時說為什麼；存一個之後 toast 說存了幾份、列表重推，帶正文章數與字數 | 面板上看得出每個點有多大 |
 * | 跟現在比：三類 + `hashNow`；存檔點不在了回 `error` | 面板要據此畫、退回時原樣帶回來 |
 * | 退回：toast 彙總、`pushState`、重推列表（多了「退回之前」）與這個存檔點的比較（變成一模一樣） | 作者看得到退回了什麼、還能退回來 |
 * | 有任務在跑：拒絕，什麼都不動 | 一邊寫一邊退，誰也說不清 |
 * | 寫備註：自動的留住 | 不被自動裁掉 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CHAPTER = 'chapters/001-雨夜.md';
const ORIGINAL = '# 雨夜\n\n他推開門。\n\n雨下了三天。\n';
const CHANGED = '# 雨夜\n\n他慢慢推開門。\n\n雨下了三天。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];

const ofType = (type) => posted.filter((m) => m.type === type);
const toasts = () => ofType('toast').map((m) => `${m.level}: ${m.message}`).join('\n');

async function send(msg) {
  posted = [];
  await controller.handle(msg);
}

/** 面板上點「整本退回」會發的那一份請求（從最近一次 `checkpointDiff` 裡拼）。 */
function wholeRequest(diff) {
  const expect = {};
  for (const e of diff.entries) expect[e.path] = e.hashNow ?? null;
  return { id: diff.id, paths: diff.entries.filter((e) => e.status !== 'added').map((e) => e.path), trash: [], expect, dirty: [] };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    progress: './src/core/runtime/progress.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'checkpoints-ctl', title: '青雲劍錄' });
  t.write(CHAPTER, ORIGINAL);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('列表與存', () => {
  test('一個都沒有時列表是空的', async () => {
    await send({ type: 'listCheckpoints' });
    assert.deepEqual(ofType('checkpoints')[0], { type: 'checkpoints', entries: [] });
  });

  test('存一個：toast 說存了幾份，列表重推，帶正文章數與字數', async () => {
    await send({ type: 'createCheckpoint', note: '開頭' });
    assert.match(toasts(), /^info: 已存一個存檔點：\d+ 份檔案/);
    const [entry] = ofType('checkpoints')[0].entries;
    assert.equal(entry.note, '開頭');
    assert.equal(entry.auto, false);
    assert.equal(entry.chapters, 1);
    assert.ok(entry.chapterWords > 0);
    assert.ok(entry.files > 1);
    assert.deepEqual(entry.skipped, []);
  });

  test('還不是小說工程：列表帶上原因，存的時候說一句', async () => {
    const dir = makeTempDir('checkpoints-ctl-empty');
    const other = new bundle.controller.ChatController(bundle.project.NovelProject.open(dir.dir));
    const got = [];
    other.attach({ kind: 'sidebar', post: (m) => got.push(m), reveal() {} });
    try {
      await other.handle({ type: 'listCheckpoints' });
      await other.handle({ type: 'createCheckpoint', note: '' });
      const list = got.find((m) => m.type === 'checkpoints');
      assert.match(list.unavailable, /還不是小說工程/);
      assert.ok(got.some((m) => m.type === 'toast' && m.level === 'error' && /還不是小說工程/.test(m.message)));
      assert.equal(fs.existsSync(`${dir.dir}/.novelwarden`), false);
    } finally {
      other.dispose();
      cleanup(dir.dir);
    }
  });
});

describe('跟現在比與退回', () => {
  let id;
  let diff;

  before(async () => {
    await send({ type: 'listCheckpoints' });
    id = ofType('checkpoints')[0].entries[0].id;
    t.write(CHAPTER, CHANGED);
    await send({ type: 'checkpointDiff', id });
    diff = ofType('checkpointDiff')[0].diff;
  });

  test('跟現在比：改過的那一章，帶 hashNow', () => {
    assert.equal(diff.id, id);
    assert.deepEqual(
      diff.entries.map((e) => [e.path, e.status, e.kind]),
      [[CHAPTER, 'changed', 'chapter']]
    );
    assert.ok(diff.entries[0].hashNow);
    assert.ok(diff.unchanged > 0);
  });

  test('存檔點不在了：回 error', async () => {
    await send({ type: 'checkpointDiff', id: '2020-01-01_00-00-00+0800' });
    const reply = ofType('checkpointDiff')[0];
    assert.equal(reply.diff, undefined);
    assert.match(reply.error, /找不到這個存檔點/);
  });

  test('有任務在跑：拒絕，什麼都不動', async () => {
    let release;
    const running = bundle.progress.runTask('批次寫章', () => new Promise((r) => (release = r)));
    try {
      await send({ type: 'restoreCheckpoint', request: wholeRequest(diff) });
      assert.match(toasts(), /^error: 有任務在跑/);
      assert.equal(t.read(CHAPTER), CHANGED);
    } finally {
      release();
      await running;
    }
  });

  test('退回：toast 彙總，pushState，列表多了「退回之前」，這個存檔點跟現在一模一樣了', async () => {
    await send({ type: 'restoreCheckpoint', request: wholeRequest(diff) });
    assert.equal(t.read(CHAPTER), ORIGINAL);
    assert.match(toasts(), /^info: 已退回 1 份。退回之前的樣子存成了一個存檔點/);
    assert.ok(posted.some((m) => m.type === 'state'), '退回之後要 pushState');
    const list = ofType('checkpoints')[0].entries;
    assert.equal(list.length, 2);
    assert.equal(list[0].auto, true);
    assert.match(list[0].note, /^退回到.*「開頭」之前$/);
    const again = ofType('checkpointDiff')[0];
    assert.equal(again.id, id);
    assert.deepEqual(again.diff.entries, []);
  });

  test('寫備註：自動的「退回之前」就此留住', async () => {
    await send({ type: 'listCheckpoints' });
    const auto = ofType('checkpoints')[0].entries.find((e) => e.auto);
    await send({ type: 'noteCheckpoint', id: auto.id, note: '改壞之前' });
    const after = ofType('checkpoints')[0].entries.find((e) => e.id === auto.id);
    assert.equal(after.auto, false);
    assert.equal(after.note, '改壞之前');
    assert.match(toasts(), /會一直留著/);
  });
});
