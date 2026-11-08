/**
 * 設定頁：二級分類、上下文引數、模型分檔與任務檔位、「高階設定」摺疊。
 *
 * 遷自 scripts/smoke-view.js 的 == 設定頁：模型分檔 ==（1741）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const settings = (extra) =>
  Object.assign(
    {
      providers: [{ id: 'p', kind: 'openai', models: [{ name: 'cheap' }, { name: 'smart' }] }],
      models: ['p/smart'],
      tierModels: { fast: [], balanced: [], quality: [] },
      taskTiers: {},
      temperature: 0.8,
      contextDetail: 2,
      summaryBatchSize: 15,
      requestTimeoutMs: 300000,
      concurrency: 3,
      fallbackAttempts: 2,
    },
    extra
  );

describe('設定頁：模型分檔', { skip: JSDOM_SKIP }, () => {
  let ui;
  let sent;
  let modelTab;
  let contextTab;
  let modelPanel;
  let contextPanel;
  let advToggle;
  let advBox;
  const rows = (id) => [...ui.doc.querySelectorAll(`#${id} .model-entry`)];
  const refsOf = (id) => rows(id).map((n) => n.querySelector('.model-entry-ref').textContent);
  const taskRows = () => [...ui.doc.querySelectorAll('.task-tier-row')];
  const taskNames = () => taskRows().map((r) => r.querySelector('.task-tier-name').textContent);
  const nameOf = (i) => taskRows()[i].querySelector('.task-tier-name').textContent;
  const selOf = (i) => taskRows()[i].querySelector('select');
  const save = () => {
    ui.doc.getElementById('saveSettingsBtn').click();
    return [...ui.sent].reverse().find((m) => m.type === 'saveSettings');
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'settings',
      settings: settings({ tierModels: { fast: ['p/cheap'], balanced: [], quality: ['p/smart'] } }),
      keys: {},
    });
    modelTab = ui.doc.getElementById('settingsTabModels');
    contextTab = ui.doc.getElementById('settingsTabContext');
    modelPanel = ui.doc.getElementById('settingsPanelModels');
    contextPanel = ui.doc.getElementById('settingsPanelContext');
  });

  test('設定頁有三個二級分類（第三個是「技能」，見 skillsSettings.test.js）', () => {
    assert.ok(modelTab && contextTab && ui.doc.getElementById('settingsTabSkills'));
  });

  test('預設顯示模型配置', () => {
    assert.equal(modelTab.getAttribute('aria-selected'), 'true');
    assert.ok(!modelPanel.hidden);
  });

  test('預設隱藏上下文管理', () => {
    assert.equal(contextTab.getAttribute('aria-selected'), 'false');
    assert.ok(contextPanel.hidden);
  });

  test('點選後切到上下文管理', () => {
    contextTab.click();
    assert.equal(contextTab.getAttribute('aria-selected'), 'true');
    assert.ok(!contextPanel.hidden);
    assert.ok(modelPanel.hidden);
  });

  test('二級分類支援方向鍵切換', () => {
    contextTab.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(modelTab.getAttribute('aria-selected'), 'true');
    assert.ok(!modelPanel.hidden);
  });

  test('頁面不再提供全域預算輸入', () => {
    assert.ok(!ui.doc.getElementById('setContextWindow') && !ui.doc.getElementById('setMaxOutputTokens'));
  });

  test('上下文引數各自回顯：詳細度按推來的級別選中', () => {
    assert.equal(ui.doc.getElementById('setContextDetail').value, '2');
    assert.equal(ui.doc.getElementById('setSummaryBatchSize').value, '15');
  });

  test('詳細度下拉：四級，標籤來自 contextDetail.ts，第 3 級標預設', () => {
    const options = [...ui.doc.querySelectorAll('#setContextDetail option')].map((o) => o.textContent);
    assert.deepEqual(options, ['1 · 精簡', '2 · 標準', '3 · 詳細（預設）', '4 · 完整']);
  });

  test('「注入完整原文章數」「上一章結尾字數」兩個輸入框不在了：並進了詳細度', () => {
    assert.ok(!ui.doc.getElementById('setRecentChaptersFullText') && !ui.doc.getElementById('setPrevChapterTailChars'));
  });

  test('說明行寫出這一級帶多少；改級別跟著變', () => {
    const hint = () => ui.doc.getElementById('contextDetailHint').textContent;
    assert.match(hint(), /近章全文 1 章/, hint());
    const select = ui.doc.getElementById('setContextDetail');
    select.value = '1';
    select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    assert.match(hint(), /近章全文 不帶/, hint());
    assert.match(hint(), /原文片段 不帶/, hint());
  });

  test('上下文引數獨立提交：詳細度是數字，負載裡沒有舊的兩個鍵', () => {
    ui.doc.getElementById('setSummaryBatchSize').value = '12';
    sent = save();
    assert.equal(sent.settings.contextDetail, 1, JSON.stringify(sent.settings));
    assert.equal(sent.settings.summaryBatchSize, 12, JSON.stringify(sent.settings));
    assert.ok(
      !Object.hasOwn(sent.settings, 'recentChaptersFullText') && !Object.hasOwn(sent.settings, 'prevChapterTailChars'),
      JSON.stringify(sent.settings)
    );
  });

  test('儲存負載不含全域預算', () => {
    assert.ok(!Object.hasOwn(sent.settings, 'contextWindow') && !Object.hasOwn(sent.settings, 'maxOutputTokens'),
      JSON.stringify(sent.settings));
  });

  test('三檔各自渲染出自己的清單', () => {
    assert.equal(refsOf('tierModelList-fast').join(','), 'p/cheap', refsOf('tierModelList-fast').join(','));
  });

  test('精標檔也渲染得出', () => {
    assert.equal(refsOf('tierModelList-quality').join(','), 'p/smart', refsOf('tierModelList-quality').join(','));
  });

  test('預設模型清單照舊', () => {
    assert.equal(refsOf('defaultModelList').join(','), 'p/smart', refsOf('defaultModelList').join(','));
  });

  // 空檔位的說明必須說清「沿用預設模型」——否則使用者以為這檔的任務跑不了。
  test('空檔位說明是「沿用預設模型」', () => {
    const emptyHint = ui.doc.querySelector('#tierModelList-balanced .hint');
    assert.ok(emptyHint && emptyHint.textContent.includes('沿用'), emptyHint && emptyHint.textContent);
  });

  // 行數跟著 LLM_TASKS 走，不寫死——加一個任務就改一次測試沒有意義。
  // 要緊的是**每個任務都有一行**，漏掉的那個在設定頁上就永遠調不了檔。
  test('任務表每個任務一行', () => {
    assert.ok(taskRows().length >= 10, `${taskRows().length} 行`);
  });

  // 流水線在設定頁上是兩條：寫劇情 / 批次寫正文（拆場景那一檔隨場景層刪掉了）。
  test('流水線的三個任務在表裡', () => {
    assert.ok(['劇情細綱', '批次寫正文'].every((n) => taskNames().includes(n)),
      taskNames().join('|'));
  });

  // 單章摘要並進了細綱：定稿那一次呼叫就是照正文更新細綱，任務名照實說。
  test('第一行是定稿（照正文更新細綱）', () => {
    assert.equal(nameOf(0), '同步 · 照正文更新細綱', nameOf(0));
  });

  test('定稿預設落在快速檔', () => {
    assert.equal(selOf(0).value, 'fast', selOf(0).value);
  });

  test('內建預設在下拉里標出來', () => {
    assert.ok([...selOf(0).options].some((o) => o.value === 'fast' && o.textContent.includes('預設')),
      [...selOf(0).options].map((o) => o.textContent).join('|'));
  });

  // 改一行檔位 → 只有改過的項進負載。
  test('改過的任務寫進 taskTiers', () => {
    selOf(0).value = 'quality';
    selOf(0).dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    sent = save();
    assert.equal(sent.settings.taskTiers.plotSummary, 'quality', JSON.stringify(sent.settings.taskTiers));
  });

  test('沒改過的任務不寫進配置', () => {
    assert.equal(Object.keys(sent.settings.taskTiers).length, 1, JSON.stringify(sent.settings.taskTiers));
  });

  test('檔位清單原樣帶上', () => {
    assert.equal(sent.settings.tierModels.fast.join(','), 'p/cheap', JSON.stringify(sent.settings.tierModels));
  });

  // 選回預設 = 刪掉覆蓋，而不是把預設值釘死進配置。
  test('選回預設就刪掉覆蓋', () => {
    selOf(0).value = 'fast';
    selOf(0).dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    sent = save();
    assert.equal(Object.keys(sent.settings.taskTiers).length, 0, JSON.stringify(sent.settings.taskTiers));
  });

  // 檔位裡指向已刪模型的引用：儲存時摘掉，但**摘空了就讓它空著**
  //（空檔位是「沿用預設模型」，不該像預設模型那樣兜底塞一個進去）。
  test('已刪模型仍留在介面上並標出來', () => {
    ui.post({
      type: 'settings',
      ack: 'saved',
      settings: settings({ tierModels: { fast: ['p/gone'], balanced: [], quality: [] } }),
      keys: {},
    });
    assert.ok(ui.doc.querySelector('#tierModelList-fast .model-tag.danger'));
  });

  test('儲存時摘掉已刪模型', () => {
    sent = save();
    assert.equal(sent.settings.tierModels.fast.length, 0, JSON.stringify(sent.settings.tierModels));
  });

  test('摘空的檔位保持為空（不兜底塞模型）', () => {
    assert.equal(sent.settings.tierModels.fast.length, 0);
  });

  test('預設模型不受影響', () => {
    assert.equal(sent.settings.models.join(','), 'p/smart', sent.settings.models.join(','));
  });

  // 後端沒推 tierModels/taskTiers（舊版本）時前端不能崩。
  test('舊後端不推分檔欄位時不崩', () => {
    const old = settings();
    delete old.tierModels;
    delete old.taskTiers;
    ui.post({ type: 'settings', ack: 'saved', settings: old, keys: {} });
    assert.ok(taskRows().length >= 10, `${taskRows().length} 行`);
  });

  test('缺欄位時三檔都渲染成空', () => {
    assert.equal(refsOf('tierModelList-fast').length, 0);
  });

  // 「高階設定」摺疊開關：模型分檔及它後面的三塊預設收起。
  test('有高階設定開關', () => {
    advToggle = ui.doc.getElementById('settingsAdvancedToggle');
    advBox = ui.doc.getElementById('settingsAdvanced');
    assert.ok(advToggle && advBox);
  });

  test('開關在模型配置頁裡', () => {
    assert.ok(modelPanel && modelPanel.contains(advToggle));
  });

  test('高階設定預設摺疊', () => {
    assert.ok(advBox && advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'false');
  });

  test('摺疊時箭頭朝右', () => {
    assert.equal(advToggle.querySelector('.caret').textContent, '▸');
  });

  test('高階設定收起的是模型分檔及其後三塊', () => {
    const advancedHeads = [...advBox.querySelectorAll('.pane-head span')].map((s) => s.textContent);
    assert.equal(advancedHeads.join(','), '模型分檔,任務檔位,請求與排程', advancedHeads.join(','));
  });

  test('模型分檔塊在高階設定容器裡', () => {
    assert.ok(advBox.querySelector('.tier-grid'));
  });

  test('點選後展開', () => {
    advToggle.click();
    assert.ok(!advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'true');
  });

  test('展開後箭頭朝下', () => {
    assert.equal(advToggle.querySelector('.caret').textContent, '▾');
  });

  test('再點收起', () => {
    advToggle.click();
    assert.ok(advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'false');
  });

  // 摺疊不影響儲存：值仍在 DOM 裡、照常進負載。
  test('摺疊時儲存照常帶檔位', () => {
    ui.post({
      type: 'settings',
      ack: 'saved',
      settings: settings({ tierModels: { fast: ['p/cheap'], balanced: [], quality: ['p/smart'] } }),
      keys: {},
    });
    sent = save();
    assert.equal(sent.settings.tierModels.fast.join(','), 'p/cheap', JSON.stringify(sent.settings.tierModels));
  });
});
