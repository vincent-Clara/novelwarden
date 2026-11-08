/**
 * 閘道器的建目錄（`Workspace.mkdir`），以及從前繞過閘道器直接 `fs.mkdir` 的那一處：工程頁 / 檔案頁的「新建資料夾」
 * （`files/fileOps.ts` 的 `newFolder`）。設定名錄「按目錄整理」那一處不再先建目錄（`ws.move` 落盤前自己補齊父目錄），
 * 測在 tests/integration/features/lore.test.js。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 建得出來，可以一次建幾層 | 設定分類 `宗門/正道` 這樣的多層目錄 |
 * | 已有同名（目錄或檔案）報 exists，什麼都不動 | 第 3 條 |
 * | 回收站、會話目錄、歷史版本裡建不了；出不了工程根 | 與寫檔案同一套守衛（第 7 條） |
 * | 「新建資料夾」經閘道器建，文案不變 | 第 7 條：寫盤只有一條路 |
 * | 檔案也寫不進、搬不進歷史版本 | 歷史版本是閘道器自己存的副本，作者的操作塞不進假快照 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（沒拋）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    fileOps: './src/core/files/fileOps.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsmkdir', title: '建目錄測試' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
  t.write('chapters/001-楔子.md', '# 楔子\n');
  t.write('.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt', '舊稿\n');
  t.write('notes/備忘.txt', '隨手記。\n');
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('Workspace.mkdir', () => {
  test('建一個目錄，返回它的相對路徑', async () => {
    const r = await ws.mkdir('chapters/第五卷');
    assert.equal(r.rel, 'chapters/第五卷');
    assert.ok(fs.statSync(t.rel('chapters/第五卷')).isDirectory());
  });

  test('一次建幾層', async () => {
    await ws.mkdir('.novelwarden/lore/宗門/正道');
    assert.ok(fs.statSync(t.rel('.novelwarden/lore/宗門/正道')).isDirectory());
  });

  test('已有同名目錄：exists', async () => {
    assert.equal(await codeOf(() => ws.mkdir('chapters/第五卷')), 'exists');
  });

  test('已有同名檔案：exists，檔案一字不動', async () => {
    assert.equal(await codeOf(() => ws.mkdir('chapters/001-楔子.md')), 'exists');
    assert.equal(t.read('chapters/001-楔子.md'), '# 楔子\n');
  });

  const refused = [
    ['回收站裡', '.novelwarden/.trash/新目錄', 'inTrash'],
    ['回收站本身', '.novelwarden/.trash', 'inTrash'],
    ['會話目錄裡', '.novelwarden/sessions/新目錄', 'protected'],
    ['歷史版本裡', '.novelwarden/history/新目錄', 'inHistory'],
    ['某份檔案的快照目錄裡', '.novelwarden/history/chapters/001-楔子.md/新目錄', 'inHistory'],
    ['工程根之外', '../外面', 'outOfRoot'],
    ['絕對路徑', '/tmp/外面', 'outOfRoot'],
  ];
  for (const [name, rel, code] of refused) {
    test(`${name}建不了（${code}），什麼都沒建`, async () => {
      assert.equal(await codeOf(() => ws.mkdir(rel)), code);
      if (code !== 'outOfRoot' && rel !== '.novelwarden/.trash') {
        assert.equal(t.has(rel), false, rel);
      }
    });
  }
});

describe('新建資料夾經閘道器建', () => {
  let calls;
  let created;
  let dup;
  let dupToasts;
  let orig;

  before(async () => {
    calls = [];
    const proto = bundle.ws.Workspace.prototype;
    orig = proto.mkdir;
    proto.mkdir = async function (rel) {
      calls.push(rel);
      return orig.call(this, rel);
    };
    try {
      h.expect('第六卷');
      created = await bundle.fileOps.newFolder(project, 'chapters');
      h.expect('第六卷');
      dup = await bundle.fileOps.newFolder(project, 'chapters');
      dupToasts = [...h.toasts];
    } finally {
      proto.mkdir = orig;
    }
  });

  test('建出來了', () => {
    assert.equal(created, 'chapters/第六卷');
    assert.ok(fs.statSync(t.rel('chapters/第六卷')).isDirectory());
  });

  test('走的是 Workspace.mkdir', () => {
    assert.deepEqual(calls, ['chapters/第六卷', 'chapters/第六卷']);
  });

  test('同名照舊拒絕，文案照舊「已存在：…」', () => {
    assert.equal(dup, undefined);
    assert.ok(dupToasts.includes('error: 已存在：chapters/第六卷'), dupToasts.join(' | '));
  });
});

describe('檔案寫不進、搬不進歷史版本（讀得到）', () => {
  const SNAP = '.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt';

  test('write 新建被拒', async () => {
    assert.equal(await codeOf(() => ws.write('.novelwarden/history/偽造.txt', { text: '假快照' }, { mode: 'create' })), 'inHistory');
    assert.equal(t.has('.novelwarden/history/偽造.txt'), false);
  });

  test('write 覆蓋一份快照被拒，快照一字不動', async () => {
    assert.equal(await codeOf(() => ws.write(SNAP, { text: '改過的' }, { mode: 'overwrite', review: false })), 'inHistory');
    assert.equal(t.read(SNAP), '舊稿\n');
  });

  test('move 進歷史版本被拒，原檔案留在原處', async () => {
    assert.equal(await codeOf(() => ws.move('notes/備忘.txt', '.novelwarden/history/chapters/備忘.txt')), 'inHistory');
    assert.ok(t.has('notes/備忘.txt'));
  });

  test('快照照樣讀得到', async () => {
    const file = await ws.read(SNAP);
    assert.equal(file.text, '舊稿\n');
  });
});
