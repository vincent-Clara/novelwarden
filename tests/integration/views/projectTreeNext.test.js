/**
 * 工程頁快照裡的「全書下一步」（W12）與對話頁主按鈕在全書那一檔給的，是同一步、同一句話。
 *
 * 兩處從前各算各的會怎樣：工程頁的空狀態寫「下一步：生成故事前提」，對話頁的主按鈕卻是
 * 「生成情節大綱」——作者不知道該信哪個，而那種分叉沒有任何別的測試攔得住（第 20 條）。
 * 所以這裡沿著一本書從空工程走到「在寫」，每一檔都拿 `buildProjectTree` 的 `next` 與
 * `bookNextStep` 逐字比。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let t;
let project;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    chat: './src/core/controller/chat.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'treenext', title: '青雲劍錄' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

/** 兩處各算一遍。`bookNextStep` 只用得到 `c.project`。 */
async function both() {
  project.invalidate();
  const tree = await bundle.projectView.buildProjectTree(project);
  const chat = await bundle.chat.bookNextStep({ project });
  return { tree, chat };
}

describe('工程頁的全書下一步與對話頁主按鈕逐字一致', () => {
  test('空工程：生成小說配置，帶一句話彈窗的預設值', async () => {
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成小說配置', JSON.stringify(tree.next));
    assert.equal(tree.next.form, 'idea');
    assert.ok(tree.next.formDefaults, JSON.stringify(tree.next));
    assert.deepEqual(tree.next, chat);
  });

  test('配置寫好了：生成故事前提', async () => {
    t.write('.novelwarden/config.md', '---\ntotalChapters: 40\n---\n\n# 小說配置\n\n## 核心梗概\n\n少年入宗。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成故事前提', JSON.stringify(tree.next));
    assert.deepEqual(tree.next.target, { kind: 'setting', doc: 'premise' });
    assert.deepEqual(tree.next, chat);
  });

  // 設定名錄：世界觀之後是設定清單。一條條目都沒有時，工程頁「設定」組的空狀態說的也是這一步。
  test('前四件齊了：生成設定清單，帶呼叫次數', async () => {
    t.write('.novelwarden/premise.md', '# 故事前提\n\n## 核心衝突鏈\n\n宗門要他死。\n');
    t.write('.novelwarden/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n少年。\n');
    t.write('.novelwarden/world.md', '# 世界觀\n\n## 規則與漏洞\n\n靈根定命。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成設定清單', JSON.stringify(tree.next));
    assert.deepEqual(tree.next.target, { kind: 'setting', doc: 'lore' });
    // 2026-10-25 起清單與詳情每寫一次都轉寫一次：寫 3–6 次、轉寫 3–6 次，封頂 24（轉寫也算）。
    assert.deepEqual([tree.next.calls.low, tree.next.calls.high, tree.next.calls.max], [6, 12, 24]);
    assert.deepEqual(tree.next, chat);
    const row = tree.architecture.find((r) => r.key === 'lore');
    assert.deepEqual(row, { key: 'lore', label: '設定清單', relPath: '.novelwarden/lore', filled: false, detail: '待生成' });
  });

  test('架構五件齊了：生成情節大綱（第 1–20 章）', async () => {
    t.write('.novelwarden/lore/宗門/青雲宗.md', '---\ntitle: 青雲宗\nkeywords: [青雲宗]\nbrief: 正道大宗\n---\n\n# 青雲宗\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成情節大綱（第 1–20 章）', JSON.stringify(tree.next));
    assert.deepEqual(tree.next, chat);
    const row = tree.architecture.find((r) => r.key === 'lore');
    assert.equal(row.filled, true);
    assert.equal(row.detail, '1 條');
  });

  test('有大綱、沒細綱：拆細綱（第 1–5 章），落在第 1 章細綱應該在的位置', async () => {
    writeOutline(t, outlineOf(20, { text: { 1: '林昭入宗。' } }));
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '拆細綱（第 1–5 章）', JSON.stringify(tree.next));
    assert.equal(tree.next.no, 1);
    assert.deepEqual(tree.next, chat);
  });

  // 在寫那一檔：下一步是單章狀態機的事（「寫第 1 章」），工程頁那一行自己帶「去寫這一章」。
  test('下一章有細綱了：工程頁不再給全書下一步', async () => {
    t.write('.novelwarden/summaries/001-夜入青雲.md', '---\nno: 1\ntitle: 夜入青雲\n---\n\n## 梗概\n\n入宗。\n\n## 關鍵事件\n\n翻牆。\n\n## 看點\n\n牆內有人。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next, undefined, JSON.stringify(tree.next));
    assert.equal(tree.bookStage, 'writing');
    // 對話頁那邊照舊轉去問單章狀態機。
    assert.ok(chat && chat.no === 1, JSON.stringify(chat));
  });
});
