/**
 * 設定頁「技能」：階段繫結、從 GitHub 檢查與安裝、技能庫。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 切到這一頁就重掃一次；「儲存設定」藏起來 | 這一頁改了當場生效 |
 * | 四個階段各一個下拉框，只列相容的 | 不相容的綁不上 |
 * | 內建的只在所屬階段列（已綁的照列）；其餘按建議階段分兩組 | 三份「去 AI 味」別擠在同一個下拉框裡 |
 * | 綁著卻找不到的照實顯示 | 別讓下拉框裝作「不帶」 |
 * | 沒開啟工程時下拉框不能動，說清為什麼 | 繫結跟著工程走 |
 * | 檢查結果帶正文；裝不了時「確認安裝」按不下去 | 裝之前看得到寫了什麼 |
 * | 裝好之後檢查卡收起 | 免得以為還要再點一次 |
 * | 我的技能庫的能解除安裝，本工程的能開啟、能刪除 | 內建刪不掉 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

/** jsdom 那一側造的物件原型不同，deepEqual 前先轉成本側的普通物件。 */
const plain = (m) => (m === undefined ? m : JSON.parse(JSON.stringify(m)));

const row = (over) =>
  Object.assign(
    {
      id: 'builtin:a',
      source: 'builtin',
      name: 'a',
      label: '甲',
      description: '說明',
      suggestedStage: 'planning',
      compatible: true,
      reasons: [],
      bytes: 120,
      files: [],
      boundTo: [],
    },
    over
  );

const VIEW = {
  rows: [
    row({}),
    row({ id: 'user:b', source: 'user', name: 'b', label: '乙', boundTo: ['drafting'] }),
    row({ id: 'project:c', source: 'project', name: 'c', label: '丙', compatible: false, reasons: ['依賴指令碼'], relPath: '.novelwarden/skills/c/SKILL.md' }),
    row({ id: 'builtin:d', name: 'd', label: '丁', suggestedStage: 'drafting' }),
  ],
  bindings: { drafting: 'user:b', review: 'user:gone', refinement: 'builtin:a' },
  problems: [],
  userDir: '/home/x/.novelwarden/skills',
};

describe('設定頁：技能', { skip: JSDOM_SKIP }, () => {
  let ui;
  const $ = (sel) => ui.doc.querySelector(sel);
  const select = (stage) => $(`select[data-skill-stage="${stage}"]`);
  const lastSent = (type) => plain([...ui.sent].reverse().find((m) => m.type === type));

  before(() => {
    ui = mount();
    ui.post({ type: 'skills', view: VIEW });
  });

  test('切到「技能」：發一次重掃，「儲存設定」藏起來', () => {
    $('#settingsTabSkills').click();
    assert.ok(lastSent('requestSkills'));
    assert.ok(!$('#settingsPanelSkills').hidden && $('#settingsSaveRow').hidden);
  });

  test('切回別的頁，「儲存設定」回來', () => {
    $('#settingsTabContext').click();
    assert.ok(!$('#settingsSaveRow').hidden);
    $('#settingsTabSkills').click();
  });

  test('四個階段各一個下拉框', () => {
    assert.deepEqual(
      [...ui.doc.querySelectorAll('#skillBindings select')].map((s) => s.dataset.skillStage),
      ['planning', 'drafting', 'review', 'refinement']
    );
  });

  test('下拉框只列相容的，回顯當前繫結', () => {
    const s = select('planning');
    assert.deepEqual([...s.options].map((o) => o.value), ['', 'builtin:a', 'user:b']);
    assert.equal(select('drafting').value, 'user:b');
  });

  test('內建的只在所屬階段列；本階段建議的與其他的分兩組', () => {
    const s = select('drafting');
    assert.deepEqual(
      [...s.querySelectorAll('optgroup')].map((g) => [g.label, [...g.children].map((o) => o.value)]),
      [
        ['本階段建議', ['builtin:d']],
        ['其他技能', ['user:b']],
      ]
    );
  });

  test('內建的綁在別的階段上照列', () => {
    const s = select('refinement');
    assert.deepEqual([...s.options].map((o) => o.value), ['', 'builtin:a', 'user:b']);
    assert.equal(s.value, 'builtin:a');
  });

  test('綁著卻找不到的照實顯示', () => {
    const s = select('review');
    assert.equal(s.value, 'user:gone');
    assert.equal(s.selectedOptions[0].textContent, 'user:gone（找不到了，不會帶）');
  });

  test('改下拉框當場發繫結；選「不帶」發 null', () => {
    const s = select('planning');
    s.value = 'builtin:a';
    s.dispatchEvent(new ui.window.Event('change'));
    assert.deepEqual(lastSent('bindSkill'), { type: 'bindSkill', stage: 'planning', id: 'builtin:a' });
    s.value = '';
    s.dispatchEvent(new ui.window.Event('change'));
    assert.equal(lastSent('bindSkill').id, null);
  });

  test('技能庫一份一行，不相容的寫原因', () => {
    const cards = [...ui.doc.querySelectorAll('#skillList .skill-card')];
    assert.equal(cards.length, 4);
    assert.ok(cards[2].textContent.includes('依賴指令碼'), cards[2].textContent);
    assert.equal($('#skillCount').textContent, '4 份');
  });

  test('寫明本工程綁在哪個階段', () => {
    assert.ok($('[data-skill-id="user:b"]').textContent.includes('本工程綁在：寫正文'));
  });

  test('我的技能庫的能解除安裝，本工程的能刪除，內建的沒有按鈕', () => {
    const buttons = (id) => [...$(`[data-skill-id="${id}"]`).querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual([buttons('builtin:a'), buttons('user:b'), buttons('project:c')], [[], ['解除安裝'], ['開啟', '刪除']]);
  });

  test('點解除安裝、刪除發 uninstallSkill，點開啟發 openFile', () => {
    $('[data-skill-id="user:b"] button').click();
    assert.deepEqual(lastSent('uninstallSkill'), { type: 'uninstallSkill', id: 'user:b' });
    $('[data-skill-id="project:c"] button').click();
    assert.deepEqual(lastSent('openFile'), { type: 'openFile', path: '.novelwarden/skills/c/SKILL.md' });
    $('[data-skill-id="project:c"] button.danger').click();
    assert.deepEqual(lastSent('uninstallSkill'), { type: 'uninstallSkill', id: 'project:c' });
  });

  test('技能庫在哪寫在提示裡', () => {
    assert.ok($('#skillLibraryHint').textContent.includes('/home/x/.novelwarden/skills'));
  });
});

describe('設定頁：技能 · 檢查與安裝', { skip: JSDOM_SKIP }, () => {
  let ui;
  const $ = (sel) => ui.doc.querySelector(sel);
  const URL = 'https://github.com/o/r';
  const inspection = (over) =>
    Object.assign(
      {
        url: URL,
        resolvedUrl: 'https://raw.githubusercontent.com/o/r/main/SKILL.md',
        name: 'scene',
        label: '場面寫法',
        description: '寫場面',
        suggestedStage: 'drafting',
        bytes: 30,
        body: '每一場都要有一個選擇。',
        attachments: [],
        blockers: [],
      },
      over
    );

  before(() => {
    ui = mount();
    ui.post({ type: 'skills', view: { ...VIEW, bindings: undefined } });
  });

  test('沒開啟工程：下拉框不能動，說清為什麼', () => {
    assert.ok([...ui.doc.querySelectorAll('#skillBindings select')].every((s) => s.disabled));
    assert.ok($('#skillBindingHint').textContent.includes('先開啟一個工程'));
  });

  test('點檢查：發 inspectSkill，按鈕變成「檢查中…」', () => {
    $('#skillUrl').value = URL;
    $('#inspectSkillBtn').click();
    assert.deepEqual(plain([...ui.sent].reverse().find((m) => m.type === 'inspectSkill')), { type: 'inspectSkill', url: URL });
    assert.ok($('#inspectSkillBtn').disabled && $('#inspectSkillBtn').textContent === '檢查中…');
  });

  test('檢查結果帶正文，按鈕復原', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection() });
    assert.equal($('#skillInspection pre').textContent, '每一場都要有一個選擇。');
    assert.ok(!$('#inspectSkillBtn').disabled);
  });

  test('附帶檔案：數出幾份，每份一個摺疊塊帶全文', () => {
    ui.post({
      type: 'skillInspection',
      url: URL,
      inspection: inspection({ attachments: [{ path: 'references/a.md', text: '附帶的' }] }),
    });
    assert.ok($('#skillInspection .skill-meta').textContent.includes('附帶 1 份檔案'));
    const extra = [...ui.doc.querySelectorAll('#skillInspection details')].at(-1);
    assert.deepEqual([extra.querySelector('summary').textContent, extra.querySelector('pre').textContent], ['附帶檔案：references/a.md', '附帶的']);
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection() });
  });

  test('可以裝：點「確認安裝」發 installSkill', () => {
    $('#installSkillBtn').click();
    assert.deepEqual(plain([...ui.sent].reverse().find((m) => m.type === 'installSkill')), { type: 'installSkill', url: URL });
  });

  test('裝不了：寫原因，「確認安裝」按不下去', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection({ blockers: ['不是自包含的提示詞（依賴指令碼）'] }) });
    assert.ok($('#installSkillBtn').disabled);
    assert.ok($('#skillInspection').textContent.includes('依賴指令碼'));
  });

  test('檢查失敗：說出原因', () => {
    ui.post({ type: 'skillInspection', url: URL, error: '查不到這個 GitHub 倉庫（HTTP 404）' });
    assert.equal($('#skillInspection').textContent, '檢查失敗：查不到這個 GitHub 倉庫（HTTP 404）');
  });

  test('裝好之後：檢查卡收起，地址框清空', () => {
    ui.post({ type: 'skillInspection', url: URL, inspection: inspection() });
    ui.post({ type: 'skills', view: VIEW, installed: 'user:scene' });
    assert.deepEqual([$('#skillInspection').childElementCount, $('#skillUrl').value], [0, '']);
  });
});
