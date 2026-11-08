/**
 * 角色的出場統計與更新選單：已建卡行的出場章數與增量更新、未出場角色的
 * 說明、未建卡出場人物的獨立分組。
 *
 * 夾具是 helpers/dom.js 的 `sampleTree()`（一章一綱之後的形狀：「故事架構」組 +
 * 一個章號一行）。出場統計按**章號**算，與架構組、章節組的行怎麼畫無關。
 *
 * 遷自 scripts/smoke-view.js 的 == 角色的出場統計與更新選單 ==（1216）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('角色的出場統計與更新選單', { skip: JSDOM_SKIP }, () => {
  let ui;
  let linRow;
  let linItems;
  let liRow;
  let liItems;
  let castGroup;
  let castRow;
  let castItems;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    linRow = rowWith('林昭');
  });

  // ---- 已建卡的角色行：出場章數進副標題，待更新章數單獨標記。
  test('角色行顯示出場章數', () => {
    assert.ok(linRow.textContent.includes('出場 3 章'), linRow.textContent);
  });

  test('角色行保留原有副標題（標籤）', () => {
    assert.ok(linRow.textContent.includes('主角'), linRow.textContent);
  });

  test('待更新章數有標記', () => {
    assert.ok(linRow.textContent.includes('＋2'), linRow.textContent);
  });

  test('標記帶解釋性 title', () => {
    assert.ok(linRow.querySelector('.cast-pending').title.includes('第 1 章'),
      linRow.querySelector('.cast-pending').title);
  });

  test('選單含帶章數的「更新角色卡」', () => {
    linItems = ui.itemsOf(ui.rightClick(linRow));
    assert.ok(linItems.includes('更新角色卡（新增 2 章）'), JSON.stringify(linItems));
  });

  test('選單含「重新通讀全部」', () => {
    assert.ok(linItems.includes('重新通讀全部 3 章'), JSON.stringify(linItems));
  });

  test('選單裡能看到出場章節', () => {
    assert.ok(linItems.includes('出場：第 1、2、3 章'), JSON.stringify(linItems));
  });

  test('角色行仍有類檔案操作', () => {
    assert.ok(['重新命名', '移動到…', '刪除（移到回收站）'].every((l) => linItems.includes(l)),
      JSON.stringify(linItems));
    ui.closeMenu();
  });

  // 增量走 updateCard，全量走 rebuildCard——兩個動作不能混。
  test('「更新角色卡」發 updateCard 並帶卡路徑', () => {
    ui.pick(ui.rightClick(rowWith('林昭')), '更新角色卡（新增 2 章）');
    const inc = ui.last('characterAction');
    assert.ok(inc, '沒發出 characterAction');
    assert.equal(inc.action, 'updateCard', JSON.stringify(inc));
    assert.equal(inc.name, '林昭', JSON.stringify(inc));
    assert.equal(inc.relPath, '.novelwarden/characters/林昭.md', JSON.stringify(inc));
  });

  test('「重新通讀」發 rebuildCard', () => {
    ui.pick(ui.rightClick(rowWith('林昭')), '重新通讀全部 3 章');
    const full = ui.last('characterAction');
    assert.ok(full, '沒發出 characterAction');
    assert.equal(full.action, 'rebuildCard', JSON.stringify(full));
  });

  // ---- 定稿過的細綱裡沒出現過的角色：不給更新入口，說明為什麼。
  test('未出場的角色行不顯示出場章數', () => {
    ui.clickEl(dirLabel('配角'));
    liRow = rowWith('李叔');
    assert.ok(!liRow.textContent.includes('出場'), liRow.textContent);
  });

  test('未出場的角色行沒有待更新標記', () => {
    assert.ok(!liRow.querySelector('.cast-pending'));
  });

  test('未出場的角色沒有「更新角色卡」', () => {
    liItems = ui.itemsOf(ui.rightClick(liRow));
    assert.ok(!liItems.some((l) => l.startsWith('更新角色卡')), JSON.stringify(liItems));
  });

  test('未出場的角色說明原因', () => {
    assert.ok(liItems.includes('未在同步過的章裡出現，無法自動更新'), JSON.stringify(liItems));
    ui.closeMenu();
  });

  // ---- 未建卡的出場人物：單獨一組，只有「建卡」一個動作。
  test('有「出場人物 · 未建卡」分組', () => {
    castGroup = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent.includes('未建卡'));
    assert.ok(castGroup);
  });

  test('分組副標題給出人數', () => {
    assert.ok(castGroup.textContent.includes('2 人'), castGroup.textContent);
  });

  test('未建卡的人也列出出場章節', () => {
    castRow = rowWith('客棧掌櫃');
    assert.ok(castRow.textContent.includes('第 2、3 章'), castRow.textContent);
  });

  test('未建卡的行有獨立樣式', () => {
    assert.ok(castRow.classList.contains('row-cast'));
  });

  test('別名進 title', () => {
    assert.ok(castRow.querySelector('.row-label').title.includes('掌櫃'));
  });

  test('未建卡的選單隻給建卡', () => {
    castItems = ui.itemsOf(ui.rightClick(castRow));
    assert.ok(castItems.includes('建立角色卡（通讀出場段落）'), JSON.stringify(castItems));
  });

  // 這些人還沒有檔案，類檔案操作無從談起。
  test('未建卡的選單沒有類檔案操作', () => {
    assert.ok(!castItems.includes('重新命名') && !castItems.includes('刪除（移到回收站）'),
      JSON.stringify(castItems));
  });

  test('建卡發 createCard 且不帶 relPath', () => {
    ui.pick(ui.rightClick(castRow), '建立角色卡（通讀出場段落）');
    const create = ui.last('characterAction');
    assert.ok(create, '沒發出 characterAction');
    assert.equal(create.action, 'createCard', JSON.stringify(create));
    assert.equal(create.name, '客棧掌櫃', JSON.stringify(create));
    assert.ok(!create.relPath, JSON.stringify(create));
  });

  // 點名字不建卡（與「出現過 · 未建條目」一樣）：掃列表時手一滑就在角色區多出一張空卡。
  test('點未建卡的名字什麼都不發', () => {
    const before = ui.sent.length;
    ui.clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '老周'));
    assert.equal(ui.sent.length, before, JSON.stringify(ui.sent.slice(before)));
  });

  test('名字的提示說去右鍵建卡', () => {
    assert.ok(castRow.querySelector('.row-label').title.includes('右鍵「建立角色卡」'), castRow.querySelector('.row-label').title);
  });

  test('「角色」組右鍵有「提取/更新角色卡」，發 extractCharacters', () => {
    const head = [...ui.doc.querySelectorAll('#projectBody .group-name')].find((n) => n.textContent === '角色');
    const items = ui.itemsOf(ui.rightClick(head));
    assert.ok(items.includes('提取/更新角色卡（挑幾章正文）…'), JSON.stringify(items));
    ui.pick(ui.rightClick(head), '提取/更新角色卡（挑幾章正文）…');
    assert.equal(ui.last('projectAction')?.action, 'extractCharacters', JSON.stringify(ui.last('projectAction')));
  });

  // 沒有未建卡的人時，整組不出現——不該留一個空分組佔地方。
  test('沒有未建卡的人則不顯示該分組', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), cast: [] } });
    assert.ok(![...ui.doc.querySelectorAll('#projectBody .group-name')]
      .some((n) => n.textContent.includes('未建卡')));
  });
});
