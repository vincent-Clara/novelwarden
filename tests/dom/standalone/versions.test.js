/**
 * 側欄「版本」頁（`media/src/editor/versions.ts`）、編輯區裡的對比標籤（`media/src/editor/versionDiff.ts`）與標題欄
 * 「檔案 → 歷史版本…」（`media/src/view/versionsMenu.ts`）。列表、全文都由後端推來（`versions` / `versionText`），這裡按訊息造。
 * 比的口徑（按行、逐字、用回一處換哪一截）在 tests/unit/editor/versionDiffCore.test.js。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 工具欄「歷史」與「檔案」選單 | 插在「儲存」前面；章節可用；不是創作產物 / 沒開啟工程 / 還不是小說工程時置灰並說為什麼；點了切到「版本」頁 |
 * | 活動欄 | 「版本」排在「檔案」後面；藏著時不拉列表，切過來拉一次 |
 * | 列表 | 新的在前「3 分鐘前 · 14:32」、字數、比現在多 / 少幾個字；存檔點 ◆ ◇ 帶備註；空的照實說；別的檔案的不畫；沒儲存時最上面多一行 |
 * | 跟著當前檔案走 | 換了檔案重拉；不存歷史版本的照實說；儲存回執到了重拉（一秒最多一次）；對比標籤顯示著時留在那份檔案上 |
 * | 點一行 | 發 `readVersion`，編輯區開「對比 · 名字」（只有一個，再點別的換掉內容）；全文到了畫兩欄：刪的 `<del>`、加的 `<ins>`，沒改的折起來；那一行標成選中 |
 * | 上一處 / 下一處 | 一開就停在第一處；到頭了按鈕置灰 |
 * | 用回這一處 | 編輯區那一處換回左邊那樣：一步撤銷、成為未儲存、**不寫盤**；先發不說話的 `saveVersion`；對比標籤留著、少一處 |
 * | 還沒儲存的改動 | 磁碟上的 ↔ 編輯器裡的；用回一處 = 換回磁碟上那樣 |
 * | 跟後一版比 | 兩邊都是存下的，只能看：沒有「用回這一處」「恢復整份」 |
 * | 恢復整份 | 編輯區換成那一版、不寫盤，停在那份檔案上；開著自動儲存時停筆 2 秒照常存，`saveVersion` 排在 `saveFile` 前面 |
 * | 重新整理 | 對比標籤不進重新整理恢復 |
 * | 全書改動 | 切過來拉存檔點列表；預設跟最近一個**手動**的比（發 `checkpointDiff`），下拉換過就一直是它；按種類分組、改 / 新 / 刪、字數差；
 *   沒有存檔點給一顆「現在存一個存檔點」；顯示著時後端推 `state` 停一下再比；標題點了收起 |
 * | 點全書改動的一份 | 沒開著的先 `openEditor`（臨時標籤），進了編輯區再開對比標籤、要存檔點裡那一份（`cp:`）；刪掉的右邊是空的、只能看；
 *   新建的左邊是空的 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState } = require('../../helpers/dom');

const PATH = 'chapters/001-雨夜.md';
const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');
const DISK = '他推開門。\n\n雨下了三天。\n\n燈還亮著。\n';
/** 2 小時前那一版：第二段不一樣，末尾多一段。比起來兩處改動。 */
const OLD = '他推開門。\n\n雨還沒有停。\n\n燈還亮著。\n\n遠處有人在喊。\n';
const tick = () => new Promise((r) => setImmediate(r));

/** 與側欄上同一種說法（只用在「幾分鐘前」這檔；跨了午夜就是「昨天」）。 */
function whenOf(time, now = Date.now()) {
  const d = new Date(time);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const minutes = Math.floor((now - time) / MIN);
  return sameDay
    ? `${minutes} 分鐘前 · ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `昨天 · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function harness(extraShims = [], opts = {}) {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard', ...extraShims], ...opts });
  const toasts = [];
  ui.window.__nfToast = (m) => toasts.push(m);
  ui.post({ type: 'state', state: viewState() });
  const doc = ui.doc;
  const area = () => doc.getElementById('edArea');
  const h = {
    ui,
    doc,
    toasts,
    area,
    btn: () => doc.querySelector('#edToolbar .ed-versions-btn'),
    side: () => doc.getElementById('pane-versions'),
    rows: () => [...doc.querySelectorAll('#versionsBody .vs-timeline .vs-row')],
    row: (id) => doc.querySelector(`#versionsBody .vs-row[data-id="${id}"]`),
    unsaved: () => doc.querySelector('#versionsBody .vs-unsaved'),
    /** 當前檔案那一塊的字。 */
    body: () => doc.querySelector('#versionsBody .vs-timeline').textContent,
    fileTitle: () => doc.querySelector('#versionsBody .vs-timeline .vs-section-title').textContent,
    book: () => doc.querySelector('#versionsBody .vs-book'),
    bookRows: () => [...doc.querySelectorAll('#versionsBody .vs-book .vs-row')],
    bookRow: (path) => doc.querySelector(`#versionsBody .vs-book .vs-row[data-path="${path}"]`),
    diff: () => doc.querySelector('.vd'),
    diffTab: () => doc.querySelector('.ed-tab-special[data-special="version-diff"]'),
    changes: () => [...doc.querySelectorAll('.vd .vd-change')],
    fileTab: (path = PATH) => [...doc.querySelectorAll('.ed-tab')].find((t) => t.dataset.path === path),
    open(path, text, extra = {}) {
      ui.post({ type: 'editorOpen', file: file(path, text, { kind: 'chapter', ...extra }) });
    },
    async showSide() {
      ui.clickEl(doc.querySelector('[data-tab="versions"]'));
      await tick();
    },
    async showChat() {
      ui.clickEl(doc.querySelector('[data-tab="chat"]'));
      await tick();
    },
    type(text) {
      area().value = text;
      area().dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    },
    key(key) {
      area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
    },
    /** 後端回 `readVersion`（最近那一次），等對比標籤收下（全文經 Promise 交過去，晚一拍）。 */
    async answerRead(text, id) {
      const req = [...ui.sent].reverse().find((m) => m.type === 'readVersion' && (!id || m.id === id));
      ui.post({ type: 'versionText', requestId: req.requestId, path: req.path, id: req.id, text });
      await tick();
    },
    /** 開啟「檔案」選單，按標籤找一項。 */
    fileItem(label) {
      ui.closeMenu();
      ui.clickEl(doc.querySelector('[data-menu="file"]'));
      return [...doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find((b) => b.querySelector('.wb-menu-label').textContent === label);
    },
    fileLabels() {
      ui.closeMenu();
      ui.clickEl(doc.querySelector('[data-menu="file"]'));
      const labels = [...doc.querySelectorAll('.wb-menu-drop .wb-menu-item .wb-menu-label')].map((n) => n.textContent);
      ui.closeMenu();
      return labels;
    },
  };
  return h;
}

describe('「歷史」按鈕與「檔案 → 歷史版本…」', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('沒開檔案：選單項置灰，提示說沒有開啟的檔案', () => {
    const item = h.fileItem('歷史版本…');
    assert.ok(item, '「檔案」選單裡沒有「歷史版本…」');
    assert.equal(item.disabled, true);
    assert.match(item.title, /沒有開啟的檔案/);
    h.ui.closeMenu();
  });

  test('「歷史版本…」緊跟在「另存為…」後面', () => {
    const labels = h.fileLabels();
    assert.equal(labels[labels.indexOf('另存為…') + 1], '歷史版本…');
  });

  test('章節：工具欄「歷史」插在「儲存」前面、可以點', () => {
    h.open(PATH, DISK);
    assert.ok(h.btn());
    assert.equal(h.btn().nextElementSibling.id, 'edSaveBtn');
    assert.equal(h.btn().disabled, false);
    assert.equal(h.fileItem('歷史版本…').disabled, false);
    h.ui.closeMenu();
  });

  test('不是創作產物（kind 是 other）：兩處都置灰，說為什麼', () => {
    h.open('筆記.md', '隨手記', { kind: 'other' });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /不是工程裡的創作產物/);
    const item = h.fileItem('歷史版本…');
    assert.equal(item.disabled, true);
    assert.match(item.title, /不是工程裡的創作產物/);
    h.ui.closeMenu();
  });

  test('沒開啟工程（後端沒給 kind）：置灰', () => {
    h.ui.post({ type: 'editorOpen', file: file('雜項.md', '一') });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /沒開啟工程/);
  });

  test('還不是小說工程：置灰；變成工程之後放開', () => {
    h.open(PATH, DISK);
    h.ui.post({ type: 'state', state: viewState({ initialized: false }) });
    assert.equal(h.btn().disabled, true);
    assert.match(h.btn().title, /還不是小說工程/);
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.btn().disabled, false);
  });

  test('點選單項：切到側欄「版本」頁、發 listVersions', async () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.fileItem('歷史版本…'));
    await tick();
    assert.ok(h.side().classList.contains('active'));
    assert.deepEqual({ ...h.ui.last('switchTab') }, { type: 'switchTab', tab: 'versions' });
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    assert.match(h.body(), /載入中/);
  });

  test('點工具欄「歷史」：同樣切過來', async () => {
    await h.showChat();
    assert.ok(!h.side().classList.contains('active'));
    h.ui.clickEl(h.btn());
    await tick();
    assert.ok(h.side().classList.contains('active'));
  });
});

describe('側欄「版本」頁', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 12, bytes: 40 },
    { id: 'cp:2026-10-20_22-30-05+0800', time: now - 20 * MIN, words: 9, bytes: 30, checkpoint: { note: '第一卷寫完', auto: false } },
    { id: 'cp:2026-10-20_21-00-00+0800', time: now - 25 * MIN, words: 9, bytes: 30, checkpoint: { note: '', auto: true } },
    { id: 'a.txt', time: now - 30 * MIN, words: 3, bytes: 12 },
  ];

  before(() => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
  });

  test('活動欄：「版本」排在「檔案」後面', () => {
    const tabs = [...h.doc.querySelectorAll('#tabbar .tab')].map((b) => b.dataset.tab);
    assert.equal(tabs[tabs.indexOf('files') + 1], 'versions');
  });

  test('藏著時不拉列表；切過來拉一次', async () => {
    assert.equal(h.ui.last('listVersions'), undefined);
    await h.showSide();
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    assert.equal(h.fileTitle(), PATH.split('/').pop());
  });

  test('沒有存下的版本：照實說，並說明什麼時候會存', () => {
    h.ui.post({ type: 'versions', path: PATH, entries: [] });
    assert.match(h.body(), /還沒有存下的版本/);
    assert.match(h.body(), /覆蓋儲存這份檔案時/);
  });

  test('別的檔案的列表不畫到這裡來', () => {
    h.ui.post({ type: 'versions', path: 'chapters/009-別處.md', entries });
    assert.equal(h.rows().length, 0);
  });

  test('列表：新的在前，「3 分鐘前 · 14:32」、字數、比現在多 / 少幾個字', () => {
    h.ui.post({ type: 'versions', path: PATH, entries });
    const rows = h.rows();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].querySelector('.vs-when').textContent, whenOf(entries[0].time, now));
    // 編輯區裡現在 13 個字（countWords 只數漢字，標點不算）。
    assert.equal(rows[0].querySelector('.vs-meta').textContent, '12 字 · 比現在少 1 字');
    assert.equal(rows[3].querySelector('.vs-meta').textContent, '3 字 · 比現在少 10 字');
  });

  test('存檔點那幾行：◆ 手動、◇ 自動，帶備註（自動的沒備註寫「自動存檔點」）', () => {
    const [, manual, auto] = h.rows();
    assert.ok(manual.classList.contains('vs-checkpoint'));
    assert.match(manual.querySelector('.vs-when').textContent, /^◆ /);
    assert.equal(manual.querySelector('.vs-note').textContent, '第一卷寫完');
    assert.match(auto.querySelector('.vs-when').textContent, /^◇ /);
    assert.equal(auto.querySelector('.vs-note').textContent, '自動存檔點');
  });

  test('打字：最上面多一行「還沒儲存的改動」，「比現在」跟著變', async () => {
    assert.equal(h.unsaved(), null);
    h.type(`${DISK}風停了。\n`);
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(h.unsaved());
    assert.match(h.unsaved().textContent, /還沒儲存的改動.*比磁碟上多 3 字/);
    assert.equal(h.row('b.txt').querySelector('.vs-meta').textContent, '12 字 · 比現在少 4 字');
  });

  test('儲存回執到了（hash 變了）：重拉一次列表；那一行沒了', () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}風停了。\n`, { kind: 'chapter', hash: 'h-saved' }) });
    assert.deepEqual({ ...h.ui.last('listVersions') }, { type: 'listVersions', path: PATH });
    h.ui.post({ type: 'versions', path: PATH, entries });
    assert.equal(h.unsaved(), null);
  });

  test('連著幾次儲存回執（自動儲存那樣）：一秒之內只重拉一次，最後那次挪到一秒之後', async () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}風停了。\n`, { kind: 'chapter', hash: 'h-saved-2' }) });
    h.ui.post({ type: 'editorSaved', file: file(PATH, `${DISK}風停了。\n`, { kind: 'chapter', hash: 'h-saved-3' }) });
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 0, '上一次剛拉過，先攢著');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(h.ui.sent.filter((m) => m.type === 'listVersions').length, 1);
  });

  test('「＋」現在存一版：發 saveVersion，提示裡說清存的是磁碟上的那一份', () => {
    const save = h.doc.getElementById('versionsSave');
    assert.match(save.title, /磁碟上現在這一份/);
    assert.match(save.title, /沒儲存的修改不在裡面/);
    h.ui.clickEl(save);
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH });
  });

  test('換到另一份檔案：重拉那一份的列表', () => {
    h.ui.sent.length = 0;
    h.open('chapters/002-風起.md', '風起了。');
    assert.equal(h.ui.last('listVersions').path, 'chapters/002-風起.md');
    assert.equal(h.rows().length, 0);
  });

  test('換到不存歷史版本的檔案：照實說，不發請求，「＋」點不了', () => {
    h.ui.sent.length = 0;
    h.open('筆記.md', '隨手記', { kind: 'other' });
    assert.equal(h.ui.last('listVersions'), undefined);
    assert.match(h.body(), /不是工程裡的創作產物/);
    assert.equal(h.doc.getElementById('versionsSave').disabled, true);
  });

  test('後端說不存（unavailable）：照實說', () => {
    h.open('chapters/003-夜雨.md', '夜雨。');
    h.ui.post({ type: 'versions', path: 'chapters/003-夜雨.md', entries: [], unavailable: '這個目錄還不是小說工程（沒有 .novelwarden/），不存歷史版本。' });
    assert.match(h.body(), /還不是小說工程/);
  });

  test('藏著時換了檔案：不拉；切回來再拉那一份', async () => {
    await h.showChat();
    h.ui.sent.length = 0;
    h.ui.clickEl(h.fileTab(PATH));
    assert.equal(h.ui.last('listVersions'), undefined);
    await h.showSide();
    assert.equal(h.ui.last('listVersions').path, PATH);
  });
});

describe('對比標籤：點一行就看', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 13, bytes: 40 },
    { id: 'a.txt', time: now - 120 * MIN, words: 17, bytes: 60 },
  ];

  before(async () => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries });
  });

  test('點一行：發 readVersion，編輯區開「對比 · 名字」，全文沒到之前說載入中', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.row('a.txt'));
    const req = h.ui.last('readVersion');
    assert.equal(req.path, PATH);
    assert.equal(req.id, 'a.txt');
    assert.ok(h.diffTab());
    assert.match(h.diffTab().textContent, /對比 · 001-雨夜\.md/);
    assert.ok(!h.diff().classList.contains('hidden'));
    assert.match(h.diff().querySelector('.vd-body').textContent, /載入中/);
  });

  test('那一行標成選中', () => {
    assert.ok(h.row('a.txt').classList.contains('selected'));
    assert.ok(!h.row('b.txt').classList.contains('selected'));
  });

  test('全文到了：兩欄的稱呼，「2 處改動」，刪的 <del>、加的 <ins>', async () => {
    await h.answerRead(OLD);
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[0], /2 小時前.*的快照/);
    assert.equal(cols[1], '現在');
    assert.match(h.diff().querySelector('.vd-meta').textContent, /^2 處改動/);
    const [first, second] = h.changes();
    assert.equal(first.querySelector('.vd-old').textContent, '雨還沒有停。');
    assert.equal(first.querySelector('.vd-new').textContent, '雨下了三天。');
    assert.ok(first.querySelector('.vd-old del'), '左邊刪掉的標出來');
    assert.ok(first.querySelector('.vd-new ins'), '右邊加上的標出來');
    assert.equal(second.querySelector('.vd-old').textContent, '遠處有人在喊。');
    assert.match(second.querySelector('.vd-new').textContent, /刪掉了/);
  });

  test('一開就停在第一處：「上一處」置灰', () => {
    assert.ok(h.changes()[0].classList.contains('current'));
    assert.equal(h.diff().querySelector('.vd-prev').disabled, true);
    assert.equal(h.diff().querySelector('.vd-next').disabled, false);
  });

  test('下一處：停到第二處，到頭了「下一處」置灰', () => {
    h.ui.clickEl(h.diff().querySelector('.vd-next'));
    assert.ok(h.changes()[1].classList.contains('current'));
    assert.equal(h.diff().querySelector('.vd-next').disabled, true);
    assert.equal(h.diff().querySelector('.vd-prev').disabled, false);
  });

  test('對比標籤顯示著（那一塊沒有當前檔案）：側欄留在這份檔案上', () => {
    assert.equal(h.fileTitle(), '001-雨夜.md');
    assert.equal(h.rows().length, 2);
  });

  test('用回這一處：編輯區那一處換回左邊那樣、成為未儲存、不寫盤；先發不說話的 saveVersion', () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.changes()[0].querySelector('.vd-revert'));
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH, quiet: true });
    assert.equal(h.ui.last('saveFile'), undefined, '不該寫盤');
    assert.ok(h.fileTab().classList.contains('dirty'));
  });

  test('對比標籤留著，少了一處', () => {
    assert.ok(!h.diff().classList.contains('hidden'));
    assert.equal(h.changes().length, 1);
    assert.equal(h.changes()[0].querySelector('.vd-old').textContent, '遠處有人在喊。');
  });

  test('右邊寫成「現在（編輯器裡，還沒儲存）」；側欄最上面多一行', () => {
    assert.equal(h.diff().querySelector('.vd-col-right').textContent, '現在（編輯器裡，還沒儲存）');
    assert.ok(h.unsaved());
  });

  test('回到那份檔案：內容換了，一步撤銷退回', () => {
    h.ui.clickEl(h.fileTab());
    assert.equal(h.area().value, '他推開門。\n\n雨還沒有停。\n\n燈還亮著。\n');
    h.key('z');
    assert.equal(h.area().value, DISK);
  });

  test('編輯器裡那份變了：切回對比標籤時重比', () => {
    h.type(`${DISK}風停了。\n`);
    h.ui.clickEl(h.diffTab());
    assert.equal(h.changes().length, 2);
    assert.equal(h.changes()[1].querySelector('.vd-new').textContent, '風停了。');
  });

  test('還沒儲存的改動：磁碟上的 ↔ 編輯器裡的；用回一處 = 換回磁碟上那樣', async () => {
    await new Promise((r) => setTimeout(r, 350));
    h.ui.clickEl(h.unsaved());
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.deepEqual(cols, ['磁碟上的（上次儲存的）', '現在（編輯器裡，還沒儲存）']);
    assert.equal(h.changes().length, 1);
    assert.equal(h.diff().querySelector('.vd-restore').classList.contains('hidden'), true, '磁碟那一份用「還原」，這裡不給恢復整份');
    h.ui.clickEl(h.changes()[0].querySelector('.vd-revert'));
    assert.match(h.diff().querySelector('.vd-body').textContent, /沒有還沒儲存的改動了/);
  });

  test('只有一個對比標籤：再點別的一行換掉裡面的內容', () => {
    h.ui.clickEl(h.row('b.txt'));
    assert.equal(h.doc.querySelectorAll('.ed-tab-special[data-special="version-diff"]').length, 1);
    assert.ok(h.row('b.txt').classList.contains('selected'));
  });

  test('只有空白不同：照實說', async () => {
    await h.answerRead('　　他推開門。\n\n\n　　雨下了三天。\n\n　　燈還亮著。\n', 'b.txt');
    assert.match(h.diff().querySelector('.vd-body').textContent, /只有空白不同/);
  });

  test('關掉對比標籤：側欄不再標選中', () => {
    h.ui.clickEl(h.diffTab().querySelector('.ed-tab-close'));
    assert.equal(h.diffTab(), null);
    assert.equal(h.doc.querySelectorAll('#versionsBody .vs-row.selected').length, 0);
  });
});

describe('右鍵：跟後一版比、恢復整份', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const entries = [
    { id: 'b.txt', time: now - 3 * MIN, words: 13, bytes: 40 },
    { id: 'a.txt', time: now - 120 * MIN, words: 17, bytes: 60 },
  ];

  before(async () => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries });
  });

  test('右鍵一行：跟現在比、跟後一版比、恢復整份到編輯區', () => {
    const menu = h.ui.rightClick(h.row('a.txt'));
    assert.deepEqual(h.ui.itemsOf(menu), ['跟現在比', '跟後一版比（那一次改了什麼）', '恢復整份到編輯區']);
    h.ui.closeMenu();
  });

  test('跟後一版比：兩邊都要全文；只能看，沒有「用回這一處」「恢復整份」', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '跟後一版比（那一次改了什麼）');
    const ids = h.ui.sent.filter((m) => m.type === 'readVersion').map((m) => m.id);
    assert.deepEqual(ids.sort(), ['a.txt', 'b.txt']);
    await h.answerRead(OLD, 'a.txt');
    await h.answerRead('他推開門。\n\n雨還沒有停。\n\n燈還亮著。\n', 'b.txt');
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[0], /2 小時前/);
    assert.match(cols[1], /3 分鐘前/);
    assert.equal(h.changes().length, 1);
    assert.equal(h.diff().querySelector('.vd-revert'), null);
    assert.ok(h.diff().querySelector('.vd-restore').classList.contains('hidden'));
  });

  test('恢復整份到編輯區：編輯區換成那一版、未儲存、不寫盤，停在那份檔案上', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢復整份到編輯區');
    await tick();
    // 全文記著（剛才讀過），不再要。
    assert.equal(h.ui.last('readVersion'), undefined);
    assert.equal(h.area().value, OLD);
    assert.ok(h.fileTab().classList.contains('dirty'));
    assert.ok(h.diff().classList.contains('hidden'), '停在那份檔案上');
    assert.equal(h.ui.last('saveFile'), undefined);
    assert.deepEqual({ ...h.ui.last('saveVersion') }, { type: 'saveVersion', path: PATH, quiet: true });
    assert.match(h.toasts.at(-1), /還沒儲存/);
  });

});

describe('對比標籤不進重新整理恢復', { skip: JSDOM_SKIP }, () => {
  test('存下來的快照裡沒有它；當前那份記的是它後面那份檔案，重新整理之後回到那份檔案', async () => {
    const h = harness([], { storage: {} });
    h.open(PATH, DISK);
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries: [{ id: 'a.txt', time: Date.now() - MIN, words: 2, bytes: 6 }] });
    h.ui.clickEl(h.row('a.txt'));
    assert.ok(h.diffTab());
    const saved = h.ui.window.localStorage.getItem('novelforge.editor.v1');
    assert.ok(saved && !saved.includes('version-diff'), saved);
    assert.equal(JSON.parse(saved).panes.main.active, PATH);
  });
});

describe('草稿區也有自己的「歷史」', { skip: JSDOM_SKIP }, () => {
  test('按鈕在那一塊的「儲存」前面；對比標籤開在那一塊裡', async () => {
    const h = harness();
    h.ui.post({ type: 'editorOpen', pane: 'draft', file: file('drafts/001-雨夜.md', '草稿。', { kind: 'draft' }) });
    const draft = h.ui.panes()[1];
    const btn = draft.querySelector('.ed-versions-btn');
    assert.ok(btn);
    assert.ok(btn.nextElementSibling.classList.contains('primary'));
    h.ui.clickEl(btn);
    await tick();
    assert.equal(h.ui.last('listVersions').path, 'drafts/001-雨夜.md');
    h.ui.post({ type: 'versions', path: 'drafts/001-雨夜.md', entries: [{ id: 'a.txt', time: Date.now() - MIN, words: 2, bytes: 6 }] });
    h.ui.clickEl(h.row('a.txt'));
    assert.ok(draft.querySelector('.ed-tab-special[data-special="version-diff"]'));
    assert.ok(draft.querySelector('.vd:not(.hidden)'));
  });
});

describe('開著自動儲存時恢復一版', { skip: JSDOM_SKIP }, () => {
  let h;

  before(async () => {
    h = harness(['fakeTimers']);
    h.open(PATH, '現在磁碟上的。', { hash: 'h-disk' });
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
    await h.showSide();
    h.ui.post({ type: 'versions', path: PATH, entries: [{ id: 'a.txt', time: Date.now() - 5 * MIN, words: 4, bytes: 12 }] });
  });

  test('底下說清：放回之後停筆 2 秒就寫回磁碟，被蓋掉的那一版先進這裡', () => {
    assert.match(h.doc.getElementById('versionsFoot').textContent, /自動儲存開著.*停筆 2 秒.*先存進這裡/);
  });

  test('恢復：先發不說話的 saveVersion，停筆 2 秒照常自動儲存，saveFile 排在它後面', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢復整份到編輯區');
    await h.answerRead('舊的那一版。');
    await tick();
    assert.equal(h.area().value, '舊的那一版。');
    assert.equal(h.ui.last('saveFile'), undefined, '當場不寫盤');
    h.ui.window.__clock.tick(2000);
    const types = h.ui.sent.map((m) => m.type);
    const snap = types.indexOf('saveVersion');
    const save = types.indexOf('saveFile');
    assert.ok(snap >= 0 && save > snap, types.join(' → '));
    assert.equal(h.ui.sent[save].text, '舊的那一版。');
    assert.equal(h.ui.sent[save].baseHash, 'h-disk');
  });

  test('編輯區裡已經是這一版：不發 saveVersion', async () => {
    h.ui.sent.length = 0;
    h.ui.pick(h.ui.rightClick(h.row('a.txt')), '恢復整份到編輯區');
    await tick();
    assert.equal(h.ui.last('saveVersion'), undefined);
    assert.match(h.toasts.at(-1), /已經是這一版/);
  });

  test('關掉自動儲存：那句說明跟著撤掉', () => {
    h.ui.window.dispatchEvent(new h.ui.window.CustomEvent('nf-editor-command', { detail: { name: 'toggleAutoSave' } }));
    assert.doesNotMatch(h.doc.getElementById('versionsFoot').textContent, /自動儲存開著/);
  });
});

describe('全書改動', { skip: JSDOM_SKIP }, () => {
  let h;
  const now = Date.now();
  const MANUAL = '2026-10-20_22-30-05+0800';
  const AUTO = '2026-10-21_09-00-00+0800';
  const cps = [
    { id: AUTO, time: now - 10 * MIN, note: '批次寫章之前（第 4–6 章）', auto: true, files: 20, chapters: 3, chapterWords: 9000, skipped: [] },
    { id: MANUAL, time: now - 60 * MIN, note: '第一卷寫完', auto: false, files: 18, chapters: 3, chapterWords: 8000, skipped: [] },
  ];
  const CH2 = 'chapters/002-客棧.md';
  const CH3 = 'chapters/003-夜訪.md';
  const CH4 = 'chapters/004-渡口.md';
  const LIN = '.novelwarden/characters/林昭.md';
  const diff = (id) => ({
    id,
    unchanged: 10,
    entries: [
      { path: CH2, kind: 'chapter', status: 'changed', wordsThen: 100, wordsNow: 120, hashNow: 'h2' },
      { path: CH3, kind: 'chapter', status: 'deleted', wordsThen: 300 },
      { path: CH4, kind: 'chapter', status: 'added', wordsNow: 10, hashNow: 'h4' },
      { path: LIN, kind: 'character', status: 'changed', wordsThen: 50, wordsNow: 40, hashNow: 'hl' },
    ],
  });

  before(async () => {
    h = harness();
    h.open(PATH, DISK, { hash: 'h-base' });
    await h.showSide();
  });

  test('切過來：拉存檔點列表；沒到之前說載入中', () => {
    assert.ok(h.ui.last('listCheckpoints'));
    assert.match(h.book().textContent, /全書改動.*載入中/);
  });

  test('預設跟最近一個手動存檔點比（自動的更新也不選它），發 checkpointDiff', () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'checkpoints', entries: cps });
    assert.deepEqual({ ...h.ui.last('checkpointDiff') }, { type: 'checkpointDiff', id: MANUAL });
    assert.equal(h.book().querySelector('.vs-base-select').value, MANUAL);
    assert.match(h.book().textContent, /比著呢/);
  });

  test('別的存檔點的比較不認（存檔點彈窗要的）', () => {
    h.ui.post({ type: 'checkpointDiff', id: AUTO, diff: diff(AUTO) });
    assert.equal(h.bookRows().length, 0);
  });

  test('比出來了：按種類分組，改 / 新 / 刪、字數差，標題上是份數', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL, diff: diff(MANUAL) });
    const groups = [...h.book().querySelectorAll('.vs-group')].map((g) => g.textContent);
    assert.deepEqual(groups, ['章節 3', '角色卡 1']);
    assert.equal(h.book().querySelector('.vs-count').textContent, '4');
    const text = (p) => h.bookRow(p).textContent;
    assert.equal(text(CH2), '改002-客棧多了 20 字');
    assert.equal(text(CH3), '刪003-夜訪之後刪掉了 · 原來 300 字');
    assert.equal(text(CH4), '新004-渡口之後新建的 · 10 字');
    assert.equal(text(LIN), '改林昭少了 10 字');
  });

  test('點一份沒開著的：先開成臨時標籤，進了編輯區再開對比標籤、要存檔點裡那一份', async () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.bookRow(CH2));
    assert.deepEqual({ ...h.ui.last('openEditor') }, { type: 'openEditor', path: CH2, preview: true });
    assert.equal(h.diffTab(), null, '檔案還沒到，先不開');
    h.ui.post({ type: 'editorOpen', file: file(CH2, '現在的第二章。\n', { kind: 'chapter' }), preview: true });
    await tick();
    assert.ok(h.diffTab());
    assert.equal(h.ui.last('readVersion').id, `cp:${MANUAL}`);
    await h.answerRead('當時的第二章。\n');
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[0], /存檔點「第一卷寫完」/);
    assert.equal(cols[1], '現在');
    assert.ok(h.changes()[0].querySelector('.vd-revert'), '可以用回');
    assert.ok(h.bookRow(CH2).classList.contains('selected'));
  });

  test('之後刪掉的：右邊是空的，只能看', async () => {
    h.ui.sent.length = 0;
    h.ui.clickEl(h.bookRow(CH3));
    assert.equal(h.ui.last('openEditor'), undefined, '刪掉的不去開');
    await h.answerRead('當時的第三章。\n');
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.match(cols[1], /現在已經沒有這一份了/);
    assert.equal(h.diff().querySelector('.vd-revert'), null);
    assert.ok(h.diff().querySelector('.vd-restore').classList.contains('hidden'));
  });

  test('之後新建的：左邊是空的，不要全文', async () => {
    h.ui.post({ type: 'editorOpen', file: file(CH4, '船來了。\n', { kind: 'chapter' }) });
    h.ui.sent.length = 0;
    h.ui.clickEl(h.bookRow(CH4));
    assert.equal(h.ui.last('readVersion'), undefined);
    const cols = [...h.diff().querySelectorAll('.vd-col')].map((c) => c.textContent);
    assert.equal(cols[0], '存檔點裡還沒有這一份');
    assert.equal(h.changes().length, 1);
  });

  test('下拉換一個：比它；之後列表重推也還是它', () => {
    const select = h.book().querySelector('.vs-base-select');
    select.value = AUTO;
    select.dispatchEvent(new h.ui.window.Event('change', { bubbles: true }));
    assert.deepEqual({ ...h.ui.last('checkpointDiff') }, { type: 'checkpointDiff', id: AUTO });
    h.ui.post({ type: 'checkpoints', entries: cps });
    assert.equal(h.ui.last('checkpointDiff').id, AUTO);
    assert.equal(h.book().querySelector('.vs-base-select').value, AUTO);
  });

  test('挑過的那個被裁掉了：回到預設（最近一個手動的）', () => {
    h.ui.post({ type: 'checkpoints', entries: [cps[1]] });
    assert.equal(h.ui.last('checkpointDiff').id, MANUAL);
  });

  test('顯示著時後端推 state（存檔之後）：停一下再拉一次', async () => {
    h.ui.sent.length = 0;
    h.ui.post({ type: 'state', state: viewState() });
    h.ui.post({ type: 'state', state: viewState() });
    assert.equal(h.ui.last('listCheckpoints'), undefined, '先攢著');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(h.ui.sent.filter((m) => m.type === 'listCheckpoints').length, 1);
  });

  test('標題點了收起，再點展開', () => {
    h.ui.post({ type: 'checkpointDiff', id: MANUAL, diff: diff(MANUAL) });
    h.ui.clickEl(h.book().querySelector('.vs-section-head'));
    assert.equal(h.bookRows().length, 0);
    assert.equal(h.book().querySelector('.vs-section-head').getAttribute('aria-expanded'), 'false');
    h.ui.clickEl(h.book().querySelector('.vs-section-head'));
    assert.equal(h.bookRows().length, 4);
  });

  test('沒有存檔點：說一句，給一顆「現在存一個存檔點」', () => {
    h.ui.post({ type: 'checkpoints', entries: [] });
    assert.match(h.book().textContent, /還沒有存檔點/);
    h.ui.clickEl(h.book().querySelector('.vs-book-save'));
    assert.deepEqual({ ...h.ui.last('createCheckpoint') }, { type: 'createCheckpoint', note: '' });
  });
});
