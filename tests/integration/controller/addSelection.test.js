/**
 * 「加入選區」的後端一半：獨立版內建編輯器裡的選區由前端帶上來（`addSelection.selection`），
 * 沒帶才交給宿主（外掛讀 VS Code 編輯器的選區，獨立版彈貼上框）。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 帶了選區就直接做成附件，不問宿主 | 宿主取不到網頁裡的選區，問了只會彈貼上框 |
 * | id、名字與外掛那一份一個樣（`sel:路徑:起-止`、`檔名:起-止`） | 同一處選區重複新增時靠 id 去重 |
 * | 存的是快照 | 選的時候是那個樣子，之後檔案改了不該讓歷史對話跟著變 |
 * | 路徑越界只留文字 | 不留一個點不開的路徑 |
 * | 沒帶選區才問宿主；宿主也沒有就提示 | 原來那條路照舊 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let h;
let controller;
let posted = [];
let hostAsked = 0;
let hostGives;

/** 發一條 addSelection，返回這一下之後推給前端的附件列表（沒推就是 undefined）。 */
async function add(selection) {
  posted = [];
  await controller.handle(selection ? { type: 'addSelection', selection } : { type: 'addSelection' });
  return posted.filter((m) => m.type === 'attachments').at(-1)?.items;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  h = makeFakeHost({ name: 'standalone', settings: () => settings });
  h.host.selectionAttachment = async () => {
    hostAsked++;
    return hostGives;
  };
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'add-selection', title: '青雲劍錄' });
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('前端帶上來的選區', () => {
  let items;
  before(async () => {
    items = await add({ relPath: 'chapters/001-雨夜.md', text: '  雨下了一夜。\n林昭推門進來。\n', start: 2, end: 3 });
  });

  test('直接做成附件，不問宿主', () => {
    assert.equal(hostAsked, 0);
    assert.equal(items?.length, 1, JSON.stringify(posted));
  });

  test('id 與名字和外掛那一份一個樣', () => {
    assert.equal(items[0].id, 'sel:chapters/001-雨夜.md:2-3');
    assert.equal(items[0].label, '001-雨夜.md:2-3');
    assert.equal(items[0].kind, 'selection');
  });

  test('存的是去掉首尾空白的快照，帶路徑與行號', () => {
    assert.equal(items[0].text, '雨下了一夜。\n林昭推門進來。');
    assert.equal(items[0].relPath, 'chapters/001-雨夜.md');
    assert.deepEqual(items[0].range, { start: 2, end: 3 });
  });

  test('同一處再加一次不重複，說一句已經引用過', async () => {
    const again = await add({ relPath: 'chapters/001-雨夜.md', text: '雨下了一夜。\n林昭推門進來。', start: 2, end: 3 });
    assert.equal(again, undefined, JSON.stringify(posted));
    assert.ok(posted.some((m) => m.type === 'toast' && m.message.includes('已經引用過')), JSON.stringify(posted));
  });

  test('路徑越界只留文字', async () => {
    const out = await add({ relPath: '../別處/機密.md', text: '不該留路徑', start: 1, end: 1 });
    const last = out.at(-1);
    assert.equal(last.text, '不該留路徑');
    assert.equal(last.relPath, undefined, JSON.stringify(last));
    assert.equal(last.label, '選區');
  });
});

describe('沒帶選區：交給宿主', () => {
  test('宿主給了就用宿主的', async () => {
    hostAsked = 0;
    hostGives = { id: 'paste-1', kind: 'selection', label: '貼上的選區', text: '粘進來的一段' };
    const out = await add();
    assert.equal(hostAsked, 1);
    assert.equal(out.at(-1).id, 'paste-1');
  });

  test('文字全是空白也當沒帶', async () => {
    hostAsked = 0;
    await add({ relPath: 'chapters/001-雨夜.md', text: '   \n ', start: 1, end: 2 });
    assert.equal(hostAsked, 1);
  });

  test('宿主也沒有就提示一句，不加附件', async () => {
    hostGives = undefined;
    const out = await add();
    assert.equal(out, undefined, JSON.stringify(posted));
    const toast = posted.find((m) => m.type === 'toast');
    assert.ok(toast?.message.includes('沒有可加入的文字'), JSON.stringify(posted));
    assert.equal(toast.level, 'error');
  });
});
