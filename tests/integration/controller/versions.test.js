/**
 * 內建編輯器「不丟稿」的後端一半（`controller/versions.ts`）：衝突時的對比合併，與「版本」側欄的列、讀、現在存一版。
 * 合併檢視用假宿主的 `mergeTexts` 代替（記下兩邊與稱呼，按排好的回答交回）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 對比合併：左邊磁碟上此刻的、右邊編輯器裡的，稱呼說得清哪邊是哪邊 | 作者要看懂自己在挑什麼 |
 * | 採納之後回 `editorReplace`，帶磁碟那份的 `base`（hash 對得上）、同一個 `requestId` | 前端據此換內容、換樂觀鎖基線，之後照常儲存，不必強制儲存 |
 * | 放棄 / 關掉：什麼都不回；**任何一條路都不寫盤** | 第 3 條：放回編輯區之後存不存由作者 |
 * | 沒有 `mergeTexts` 的宿主：說一句，不拋 | 外掛殼不用內建編輯器，但要防住 |
 * | 歷史版本：列出來新的在前、讀得回全文 | 側欄的時間線與對比標籤左邊那一欄 |
 * | 存檔點裡的樣子混進同一條時間線：`cp:` 開頭、帶備註；內容一樣的連著幾個只留最早那一個；讀得回全文；改了備註重列跟上 | 一行說的是「到這個存檔點它變成了這樣」，三十個自動存檔點裡沒動過的不刷三十行 |
 * | 現在存一版：存的是磁碟上的那一份，與最新一版一樣時不重複存，之後重推列表 | 介面上說的「不是編輯器裡沒儲存的那份」要成立 |
 * | 對比合併放回之前、前端放回一版（一處）之前發的 `saveVersion quiet`：磁碟上那一份先強制存一版，**節流攔不住** | 放回去的內容一存檔（開著自動儲存時停筆兩秒）就蓋掉它；按節流它可能因為「改動小」不存 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CHAPTER = 'chapters/001-雨夜.md';
const DISK = '# 雨夜\n\n他推開門。\n\n雨下了三天。\n';
const EDITOR = '# 雨夜\n\n他慢慢推開門。\n\n雨下了三天。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];
/** 每一次 mergeTexts 的引數；`answers` 是接下來要交回的結論（沒排就當關掉了）。 */
const merges = [];
const answers = [];

const ofType = (type) => posted.filter((m) => m.type === type);
/** 這一輪推給前端的提示（controller.toast 走的是 `toast` 訊息）。 */
const toasts = () => ofType('toast').map((m) => `${m.level}: ${m.message}`).join('\n');

async function send(msg) {
  posted = [];
  await controller.handle(msg);
}

function snapNames(rel) {
  const dir = t.rel('.novelwarden/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fsx: './src/core/model/fs.ts',
    history: './src/core/workspace/history.ts',
    checkpoints: './src/core/workspace/checkpoints.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({
    name: 'standalone',
    settings: () => settings,
    overrides: {
      mergeTexts: async (title, before, after, opts) => {
        merges.push({ title, before, after, opts });
        const a = answers.shift();
        return typeof a === 'function' ? a({ before, after }) : a;
      },
    },
  });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'versions-ctl', title: '青雲劍錄' });
  t.write(CHAPTER, DISK);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('mergeWithDisk：衝突時對比合併', () => {
  let call;
  let reply;

  before(async () => {
    answers.push({ merged: '# 雨夜\n\n他慢慢推開門，雨還在下。\n\n雨下了三天。\n' });
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-1' });
    call = merges.at(-1);
    reply = ofType('editorReplace')[0];
  });

  test('左邊是磁碟上此刻的那份，右邊是編輯器裡的', () => {
    assert.equal(call.before, DISK);
    assert.equal(call.after, EDITOR);
  });

  test('兩欄的稱呼說清哪邊是哪邊，採納按鈕是「放回編輯器」', () => {
    assert.deepEqual(call.opts.sides, { before: '磁碟上的', after: '編輯器裡的' });
    assert.equal(call.opts.applyLabel, '放回編輯器');
    assert.ok(call.title.includes('磁碟上的') && call.title.includes('編輯器裡的'), call.title);
    assert.ok(call.opts.message.includes(CHAPTER), call.opts.message);
  });

  test('採納之後回 editorReplace：挑過的那份、同一個 requestId', () => {
    assert.equal(reply.requestId, 'r-merge-1');
    assert.equal(reply.path, CHAPTER);
    assert.equal(reply.text, '# 雨夜\n\n他慢慢推開門，雨還在下。\n\n雨下了三天。\n');
  });

  test('帶上磁碟那一份當新的樂觀鎖基線（hash 與磁碟對得上）', () => {
    assert.equal(reply.base.text, DISK);
    assert.equal(reply.base.hash, bundle.fsx.hash(DISK));
  });

  test('不寫盤', () => {
    assert.equal(t.read(CHAPTER), DISK);
  });

  test('放回之前把磁碟上那一份（別處改過的）先存進歷史：合併結果一存檔就蓋掉它', () => {
    const names = snapNames(CHAPTER);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(t.rel('.novelwarden/history', CHAPTER, names[0]), 'utf8'), DISK);
  });

  test('原樣採納（一處沒動）：放回的就是編輯器裡那份，照樣換基線', async () => {
    answers.push('apply');
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-2' });
    const r = ofType('editorReplace')[0];
    assert.equal(r.text, EDITOR);
    assert.equal(r.base.hash, bundle.fsx.hash(DISK));
  });

  test('放棄或關掉合併檢視：什麼都不回', async () => {
    answers.push('discard');
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-3' });
    assert.equal(ofType('editorReplace').length, 0);
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-merge-4' });
    assert.equal(ofType('editorReplace').length, 0);
    assert.equal(t.read(CHAPTER), DISK);
  });

  test('磁碟上已經沒有這份了：說一句，不開合併檢視', async () => {
    const n = merges.length;
    await send({ type: 'mergeWithDisk', path: 'chapters/099-不存在.md', text: EDITOR, requestId: 'r-merge-5' });
    assert.equal(merges.length, n);
    assert.match(toasts(), /磁碟上已經沒有/);
    assert.equal(ofType('editorReplace').length, 0);
  });
});

describe('宿主沒有 mergeTexts：說明，不拋', () => {
  let saved;

  before(() => {
    saved = fakeHost.host.mergeTexts;
    fakeHost.host.mergeTexts = undefined;
  });

  after(() => {
    fakeHost.host.mergeTexts = saved;
  });

  test('對比合併：給一句說明，指向另外兩顆按鈕', async () => {
    await send({ type: 'mergeWithDisk', path: CHAPTER, text: EDITOR, requestId: 'r-x' });
    assert.match(toasts(), /error: .*沒有對比合併檢視.*用磁碟版本覆蓋編輯器/);
    assert.equal(ofType('editorReplace').length, 0);
  });
});

describe('歷史版本：列、讀、現在存一版', () => {
  const REL = 'chapters/002-風起.md';
  const V1 = '# 風起\n\n第一版。\n';
  const V2 = '# 風起\n\n第二版，' + '改得很多。'.repeat(80) + '\n';
  const V3 = '# 風起\n\n第三版。\n';
  const V4 = '# 風起\n\n第四版，磁碟上又改過。\n';
  let list;

  before(async () => {
    t.write(REL, V1);
    await controller.workspace.write(REL, { text: V2 }, { mode: 'overwrite', review: false });
    await controller.workspace.write(REL, { text: V3 }, { mode: 'overwrite', review: false });
    await send({ type: 'listVersions', path: REL });
    list = ofType('versions')[0];
  });

  test('列出來新的在前：時間、字數、位元組數', () => {
    assert.equal(list.path, REL);
    assert.equal(list.unavailable, undefined);
    assert.equal(list.entries.length, 2);
    assert.ok(list.entries[0].time >= list.entries[1].time);
    assert.equal(list.entries[1].bytes, Buffer.byteLength(V1));
    assert.equal(list.entries[0].words, bundle.fsx.countWords(V2));
  });

  test('讀某一個快照的全文：回同一個 requestId', async () => {
    await send({ type: 'readVersion', path: REL, id: list.entries[1].id, requestId: 'r-read' });
    const r = ofType('versionText')[0];
    assert.equal(r.requestId, 'r-read');
    assert.equal(r.id, list.entries[1].id);
    assert.equal(r.text, V1);
  });

  test('讀不到的：帶 error，不拋', async () => {
    await send({ type: 'readVersion', path: REL, id: '../../config.md', requestId: 'r-bad' });
    const r = ofType('versionText')[0];
    assert.equal(r.text, undefined);
    assert.match(r.error, /找不到/);
  });

  test('現在存一版：存的是磁碟上的那一份（不是編輯器裡的），之後重推列表', async () => {
    t.write(REL, V4);
    await send({ type: 'saveVersion', path: REL });
    const names = snapNames(REL);
    assert.equal(names.length, 3);
    assert.equal(fs.readFileSync(t.rel('.novelwarden/history', REL, names[0]), 'utf8'), V4);
    assert.match(toasts(), /磁碟上現在這一份/);
    assert.equal(ofType('versions')[0].entries.length, 3);
  });

  test('與最新一版一字不差時不重複存', async () => {
    await send({ type: 'saveVersion', path: REL });
    assert.equal(snapNames(REL).length, 3);
    assert.match(toasts(), /一字不差/);
  });

  test('quiet（放回一版之前發的）：照樣存、一句話都不說、列表照樣重推', async () => {
    t.write(REL, V1);
    await send({ type: 'saveVersion', path: REL, quiet: true });
    assert.equal(snapNames(REL).length, 4);
    assert.equal(toasts(), '');
    assert.equal(ofType('versions')[0].entries.length, 4);
    await send({ type: 'saveVersion', path: REL, quiet: true });
    assert.equal(snapNames(REL).length, 4);
    assert.equal(toasts(), '', '一樣的不重複存，也不說');
  });

  test('不是創作產物：列表是空的、帶原因；現在存一版報錯不存', async () => {
    t.write('隨手記.md', '一');
    await send({ type: 'listVersions', path: '隨手記.md' });
    const r = ofType('versions')[0];
    assert.deepEqual(r.entries, []);
    assert.match(r.unavailable, /不是工程裡的創作產物/);
    await send({ type: 'saveVersion', path: '隨手記.md' });
    assert.match(toasts(), /error: .*不是工程裡的創作產物/);
    assert.equal(fs.existsSync(t.rel('.novelwarden/history/隨手記.md')), false);
  });

  test('還沒有快照的檔案：空列表，不帶原因', async () => {
    t.write('chapters/003-無痕.md', '還沒被覆蓋過。');
    await send({ type: 'listVersions', path: 'chapters/003-無痕.md' });
    const r = ofType('versions')[0];
    assert.deepEqual(r.entries, []);
    assert.equal(r.unavailable, undefined);
  });
});

describe('放回之前那一下：節流本來會丟掉的那一份也留住', () => {
  const REL = 'chapters/004-殘燈.md';
  const BIG = '燈芯燒到了底。'.repeat(200);
  before(async () => {
    t.write(REL, BIG);
    // 第一次覆蓋：存下 BIG。緊接著一處小改：不到 10 分鐘、改動很小，節流不存——磁碟上是「BIG 一二」、歷史裡只有 BIG。
    await controller.workspace.write(REL, { text: `${BIG}一` }, { mode: 'overwrite', review: false });
    await controller.workspace.write(REL, { text: `${BIG}一二` }, { mode: 'overwrite', review: false });
  });

  test('起點：歷史裡只有 BIG（「BIG 一」那次被節流了）', () => {
    assert.equal(snapNames(REL).length, 1);
  });

  test('前端把 BIG 那一版放回編輯區之前發 saveVersion quiet：磁碟上的「BIG 一二」先進了歷史', async () => {
    await send({ type: 'saveVersion', path: REL, quiet: true });
    const names = snapNames(REL);
    assert.equal(names.length, 2);
    assert.equal(fs.readFileSync(t.rel('.novelwarden/history', REL, names[0]), 'utf8'), `${BIG}一二`);
  });

  test('之後把放回的那份存檔（編輯器儲存）：「BIG 一二」仍在歷史裡，可以再恢復回來', async () => {
    await controller.workspace.write(REL, { text: BIG }, { mode: 'overwrite', review: false });
    assert.equal(t.read(REL), BIG);
    const texts = snapNames(REL).map((n) => fs.readFileSync(t.rel('.novelwarden/history', REL, n), 'utf8'));
    assert.ok(texts.includes(`${BIG}一二`));
  });
});

describe('存檔點裡的樣子混進同一條時間線', () => {
  const REL = 'chapters/005-渡口.md';
  const C1 = '# 渡口\n\n船還沒來。\n';
  const C2 = '# 渡口\n\n船來了，沒有人下來。\n';
  const C3 = '# 渡口\n\n船來了，下來一個戴斗笠的人。\n';
  const ids = {};
  let list;

  before(async () => {
    const base = Date.now() - 60_000;
    t.write(REL, C1);
    ids.one = (await bundle.checkpoints.createCheckpoint(t.project, { note: '一', auto: false, now: base })).id;
    // 這一份沒動，只是又存了一個（自動的也一樣）：時間線上不該多一行。
    ids.two = (await bundle.checkpoints.createCheckpoint(t.project, { note: '二', auto: false, now: base + 1000 })).id;
    t.write(REL, C2);
    ids.three = (await bundle.checkpoints.createCheckpoint(t.project, { note: '三', auto: false, now: base + 2000 })).id;
    // 經閘道器覆蓋：存下 C2 的快照（時間是此刻，排在存檔點前面）。
    await controller.workspace.write(REL, { text: C3 }, { mode: 'overwrite', review: false });
    await send({ type: 'listVersions', path: REL });
    list = ofType('versions')[0];
  });

  test('新的在前：快照、存檔點「三」、存檔點「一」；「二」與「一」一樣，不另列', () => {
    assert.deepEqual(
      list.entries.map((e) => (e.checkpoint ? `cp ${e.checkpoint.note}` : 'snapshot')),
      ['snapshot', 'cp 三', 'cp 一']
    );
  });

  test('存檔點那幾行：id 是 cp: 加存檔點的 id，帶備註與手動 / 自動、字數', () => {
    const three = list.entries[1];
    assert.equal(three.id, `cp:${ids.three}`);
    assert.deepEqual(three.checkpoint, { note: '三', auto: false });
    assert.equal(three.words, bundle.fsx.countWords(C2));
    assert.equal(three.bytes, Buffer.byteLength(C2));
  });

  test('讀得回存檔點裡那一份的全文', async () => {
    await send({ type: 'readVersion', path: REL, id: `cp:${ids.one}`, requestId: 'r-cp' });
    const r = ofType('versionText')[0];
    assert.equal(r.requestId, 'r-cp');
    assert.equal(r.text, C1);
  });

  test('存檔點裡沒有這一份、存檔點不在：帶 error，不拋', async () => {
    await send({ type: 'readVersion', path: 'chapters/099-沒有.md', id: `cp:${ids.one}`, requestId: 'r-cp2' });
    assert.match(ofType('versionText')[0].error, /裡沒有/);
    await send({ type: 'readVersion', path: REL, id: 'cp:2001-01-01_00-00-00+0800', requestId: 'r-cp3' });
    assert.match(ofType('versionText')[0].error, /找不到/);
  });

  test('改了備註：重列時跟上（讀過的清單按大小與修改時間認，不拿舊的）', async () => {
    await bundle.checkpoints.noteCheckpoint(t.project, ids.three, '三，改過備註');
    await send({ type: 'listVersions', path: REL });
    assert.equal(ofType('versions')[0].entries[1].checkpoint.note, '三，改過備註');
  });
});
