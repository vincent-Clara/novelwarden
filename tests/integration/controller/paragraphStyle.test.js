/**
 * 切換分段格式（`setParagraphStyle`，內建編輯器「編輯 → 段落格式」）的後端一半。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 只改 `config.md` frontmatter 的這一個鍵，別的位元組一個不動 | 作者手排的配置不該因為點了一下選單就被整份重渲染（第 3 條） |
 * | 正文一個位元組不動 | 切格式只是換個設定；要把已寫的正文排成新格式，是作者自己點「一鍵排版」 |
 * | 寫完 `pushState`：`state` 與工程樹都帶新值 | 編輯器的回車、選單上的勾跟著它走（前端無狀態） |
 * | 沒有 `config.md` 時新建一份最小的，「小說配置」仍算沒填、主按鈕與架構那一行的 ●/○ 都不變 | 第 20 條：只推一個下一步，不能因為多了一個檔案就跳過「生成小說配置」 |
 * | 之後重寫配置（生成鏈落盤）把它帶過去 | 絕不靜默丟掉作者的設定 |
 * | 認不出的值、還不是小說工程：不寫 | 第 1 條；寫一份 config.md 也不會讓它變成工程 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

const CONFIG = '.novelwarden/config.md';
const CHAPTER = 'chapters/001-雨夜.md';
const CHAPTER_TEXT = '# 雨夜\n\n他推開門。\n她笑了。\n';

let bundle;
let fakeHost;
let t;
let controller;
let posted = [];

const lastOf = (type) => [...posted].reverse().find((m) => m.type === type);

async function setStyle(style) {
  posted = [];
  await controller.handle({ type: 'setParagraphStyle', style });
}

/** 工程頁的架構那一行（小說配置）與全書下一步，外加對話頁主按鈕在全書那一檔給的。 */
async function bookView() {
  t.project.invalidate();
  const tree = await bundle.projectView.buildProjectTree(t.project);
  const chat = await bundle.chat.bookNextStep({ project: t.project });
  return {
    configFilled: tree.architecture.find((r) => r.key === 'config').filled,
    next: tree.next?.label,
    chat: chat?.label,
    paragraphStyle: tree.paragraphStyle,
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    chat: './src/core/controller/chat.ts',
    controller: './src/core/controller/index.ts',
    workspace: './src/core/workspace/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  fakeHost = makeFakeHost({ name: 'standalone', settings: () => settings });
  bundle.host.initHost(fakeHost.host);
  t = await makeTempProject(bundle.project, { prefix: 'paragraph-style', title: '青雲劍錄' });
  t.write(CHAPTER, CHAPTER_TEXT);
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('setParagraphStyle：只改 config.md 的這一個鍵', () => {
  let before;

  test('新工程的配置模板：只多出 paragraphStyle 這一行，別的位元組一個不動', async () => {
    before = t.read(CONFIG);
    await setStyle('indent');
    const after = t.read(CONFIG);
    assert.equal(after.replace(/^paragraphStyle: indent\r?\n/m, ''), before);
    assert.match(after, /^---\r?\n[\s\S]*^paragraphStyle: indent\r?\n---/m, 'frontmatter 裡多了這一行');
  });

  test('正文一個位元組不動', () => {
    assert.equal(t.read(CHAPTER), CHAPTER_TEXT);
  });

  test('寫完推 state，帶著新值', () => {
    assert.equal(lastOf('state')?.state.paragraphStyle, 'indent');
  });

  test('工程樹也帶著新值', async () => {
    posted = [];
    await controller.handle({ type: 'switchTab', tab: 'project' });
    assert.equal(lastOf('project')?.tree.paragraphStyle, 'indent');
  });

  test('再切一次：只換值', async () => {
    await setStyle('both');
    assert.equal(t.read(CONFIG), before.replace(/^(---\r?\n[\s\S]*?)(---)/m, '$1paragraphStyle: both\n$2'));
    assert.equal(lastOf('project')?.tree.paragraphStyle, 'both', '在工程頁簽上時工程樹跟著推');
  });

  test('已經是這個值：不寫', async () => {
    const stat = fs.statSync(t.rel(CONFIG)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await setStyle('both');
    assert.equal(fs.statSync(t.rel(CONFIG)).mtimeMs, stat);
  });

  test('認不出的值：忽略，不寫', async () => {
    const text = t.read(CONFIG);
    await setStyle('tab');
    assert.equal(t.read(CONFIG), text);
  });

  test('之後重寫配置（生成鏈的落盤）把它帶過去', async () => {
    const ws = new bundle.workspace.Workspace(t.project);
    await ws.write(
      CONFIG,
      { artifact: { kind: 'settingDoc', doc: 'config', sections: { 核心梗概: '少年入宗。' }, config: { totalChapters: 40 } } },
      { mode: 'overwrite', review: false }
    );
    const text = t.read(CONFIG);
    assert.match(text, /^paragraphStyle: both$/m);
    assert.match(text, /少年入宗。/);
  });
});

describe('setParagraphStyle：沒有 config.md 時', () => {
  let beforeView;

  before(async () => {
    t.remove(CONFIG);
    beforeView = await bookView();
    await setStyle('indent');
  });

  test('新建一份最小的：只有這一段 frontmatter', () => {
    assert.equal(t.read(CONFIG), '---\nparagraphStyle: indent\n---\n');
  });

  test('「小說配置」仍算沒填（工程頁架構那一行的 ●/○ 不變）', async () => {
    const view = await bookView();
    assert.equal(beforeView.configFilled, false);
    assert.equal(view.configFilled, false);
  });

  test('主按鈕不變：工程頁與對話頁都還是同一步', async () => {
    const view = await bookView();
    assert.equal(view.next, beforeView.next);
    assert.equal(view.chat, beforeView.chat);
    assert.ok(view.next, '全書那一檔有下一步');
    assert.notEqual(view.next, '生成故事前提', '沒有把配置當成填過而跳到下一件');
  });

  test('工程樹帶著新值', async () => {
    assert.equal((await bookView()).paragraphStyle, 'indent');
  });
});

describe('setParagraphStyle：還不是小說工程', () => {
  let dir;
  let bare;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-paragraph-bare-'));
    const project = bundle.project.NovelProject.open(dir);
    bare = new bundle.controller.ChatController(project);
    bare.attach({ kind: 'sidebar', post() {}, reveal() {} });
    fakeHost.toasts.length = 0;
    await bare.handle({ type: 'setParagraphStyle', style: 'indent' });
  });

  after(() => {
    bare?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('不寫任何檔案，說一句為什麼', () => {
    assert.equal(fs.existsSync(path.join(dir, '.novelwarden')), false);
    assert.ok(fakeHost.toasts.some((m) => /還不是小說工程/.test(m)), fakeHost.toasts.join('\n'));
  });
});
