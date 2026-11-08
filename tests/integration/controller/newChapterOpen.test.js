/**
 * 工程頁「章節」還空著時那顆「新建第 1 章」（新手上手，2026-10-24）：`projectAction newChapter` 帶 `open`，建完就開啟。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 帶 `open`：先問章名，建好正文與細綱，開啟那一章 | 新書的第一下就是開寫，不必再回工程頁點一下 |
 * | 不帶 `open`（右鍵「新建章節檔案」）：照舊只建不開 | 那條的口徑沒變 |
 * | 輸入框上取消：什麼都不建、不開啟 | 第 3 條 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let fakeHost;
const books = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
});

after(() => {
  for (const b of books) {
    b.controller.dispose();
    cleanup(b.t.dir, bundle?.db);
  }
});

async function freshBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '青雲劍錄' });
  const controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  books.push({ t, controller });
  return { t, controller };
}

describe('新建第 1 章：建完就開啟', () => {
  test('帶 open：問章名，建好正文與細綱，開啟那一章', async () => {
    const { t, controller } = await freshBook('new-chapter-open');
    fakeHost.expect('楔子');
    await controller.handle({ type: 'projectAction', action: 'newChapter', open: true });
    assert.equal(fakeHost.inputs.length, 1);
    assert.ok(fs.existsSync(t.rel('chapters/001-楔子.txt')));
    assert.ok(fs.existsSync(t.rel('.novelwarden/summaries/001-楔子.md')));
    assert.deepEqual(fakeHost.opened, ['chapters/001-楔子.txt']);
  });

  test('不帶 open（右鍵「新建章節檔案」）：照舊只建不開', async () => {
    const { t, controller } = await freshBook('new-chapter-closed');
    fakeHost.expect('楔子');
    await controller.handle({ type: 'projectAction', action: 'newChapter' });
    assert.ok(fs.existsSync(t.rel('chapters/001-楔子.txt')));
    assert.deepEqual(fakeHost.opened, []);
  });

  test('輸入框上取消：什麼都不建、不開啟', async () => {
    const { t, controller } = await freshBook('new-chapter-cancel');
    fakeHost.expect(undefined);
    await controller.handle({ type: 'projectAction', action: 'newChapter', open: true });
    assert.deepEqual(fs.readdirSync(t.rel('chapters')), []);
    assert.deepEqual(fakeHost.opened, []);
  });
});
