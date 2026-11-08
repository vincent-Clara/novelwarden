/**
 * 內建編輯器自己管的撤銷 / 重做（每個開啟的檔案一份）。
 *
 * 一塊編輯區的所有標籤共用一個 textarea，切標籤時整份換 value，瀏覽器原生的撤銷記錄隨之作廢；
 * 所以編輯器自己記差異（`media/src/editor/history.ts`）。jsdom 裡沒有原生撤銷，也沒有
 * `execCommand`——這裡測的全是編輯器自己的那一份。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 切到別的標籤再切回來 | Ctrl+Z 仍退得回去（各管各的歷史） |
 * | 連續打字 | 併成一步；回車單獨一步，回車之後另起一步 |
 * | Ctrl+Y / Ctrl+Shift+Z | 重做 |
 * | 撤銷回原樣 | 髒標記、標籤圓點、儲存按鈕跟著變 |
 * | 輸入法組字 | 組字中途不記，上屏那一整段一步 |
 * | `beforeinput` 的 historyUndo | 攔下來走編輯器的 |
 * | 「還原」「用磁碟版本覆蓋」 | 也記一步，撤銷回去又是髒的 |
 * | 右鍵「貼上」 | 經唯一的程式改寫入口，一步可撤銷 |
 * | 搬到另一塊編輯區 | 撤銷歷史跟著搬 |
 * | 標題欄「編輯 → 撤銷」 | 焦點在編輯區時走編輯器，在別的輸入框時照舊交給瀏覽器 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

/** 在 jsdom 裡模擬真實輸入：改 value、挪游標、發一條帶 inputType 的 input。 */
function typer(ui, area) {
  const fire = (inputType, extra) =>
    area().dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType, ...extra }));
  return {
    /** 在游標 / 選區處打出 text（一下一個事件）。 */
    type(text) {
      for (const ch of text) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s) + ch + a.value.slice(a.selectionEnd);
        a.setSelectionRange(s + ch.length, s + ch.length);
        fire(ch === '\n' ? 'insertLineBreak' : 'insertText', { data: ch });
      }
    },
    backspace(times = 1) {
      for (let i = 0; i < times; i++) {
        const a = area();
        const s = a.selectionStart;
        a.value = a.value.slice(0, s - 1) + a.value.slice(s);
        a.setSelectionRange(s - 1, s - 1);
        fire('deleteContentBackward');
      }
    },
    caret(at) {
      area().setSelectionRange(at, at);
    },
  };
}

function keys(ui, area) {
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  return {
    press,
    undo: () => press({ key: 'z', ctrlKey: true }),
    redoY: () => press({ key: 'y', ctrlKey: true }),
    redoShiftZ: () => press({ key: 'Z', ctrlKey: true, shiftKey: true }),
  };
}

describe('撤銷 / 重做：每個檔案一份', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const tab = (name) =>
    [...ui.doc.querySelectorAll('#edTabs .ed-tab')].find((t) => t.querySelector('.ed-tab-name').textContent === name);
  let t;
  let k;

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
    ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    t = typer(ui, area);
    k = keys(ui, area);
  });

  test('切到別的標籤再切回來，Ctrl+Z 仍能撤銷之前的修改', () => {
    ui.clickEl(tab('001-雨夜.md'));
    t.caret(3);
    t.type('林昭來了');
    assert.equal(area().value, '雨夜。林昭來了');

    ui.clickEl(tab('林昭.md'));
    assert.equal(area().value, '# 林昭');
    t.caret(4);
    t.type('，主角');
    ui.clickEl(tab('001-雨夜.md'));
    assert.equal(area().value, '雨夜。林昭來了');

    const ev = k.undo();
    assert.equal(ev.defaultPrevented, true, 'Ctrl+Z 要攔下來，不交給瀏覽器');
    assert.equal(area().value, '雨夜。');
    assert.equal(area().selectionStart, 3, '游標回到打字之前的位置');

    // 另一份的歷史沒被碰。
    ui.clickEl(tab('林昭.md'));
    k.undo();
    assert.equal(area().value, '# 林昭');
  });

  test('撤銷回原樣：髒標記、標籤圓點、儲存按鈕跟著變', () => {
    ui.clickEl(tab('001-雨夜.md'));
    assert.equal(area().value, '雨夜。');
    assert.equal(tab('001-雨夜.md').classList.contains('dirty'), false);
    assert.equal(ui.doc.getElementById('edSaveBtn').disabled, true);
    assert.equal(ui.doc.getElementById('edStatusSave').textContent, '已儲存');
  });

  test('Ctrl+Y 重做', () => {
    k.redoY();
    assert.equal(area().value, '雨夜。林昭來了');
    assert.equal(area().selectionStart, 7, '游標落在重做之後的位置');
    assert.equal(tab('001-雨夜.md').classList.contains('dirty'), true);
    assert.match(ui.doc.getElementById('edStatusSave').textContent, /未儲存/);
  });

  test('Ctrl+Shift+Z 也是重做', () => {
    k.undo();
    assert.equal(area().value, '雨夜。');
    k.redoShiftZ();
    assert.equal(area().value, '雨夜。林昭來了');
  });

  test('連續打字併成一步，回車單獨一步、回車之後另起一步', () => {
    t.caret(area().value.length);
    t.type('。\n第二段');
    assert.equal(area().value, '雨夜。林昭來了。\n第二段');
    k.undo();
    assert.equal(area().value, '雨夜。林昭來了。\n', '先退回車之後打的字');
    k.undo();
    assert.equal(area().value, '雨夜。林昭來了。', '再退回車');
    k.undo();
    assert.equal(area().value, '雨夜。林昭來了', '回車之前那幾下是一步');
  });

  test('連續退格併成一步', () => {
    t.caret(area().value.length);
    t.backspace(2);
    assert.equal(area().value, '雨夜。林昭');
    k.undo();
    assert.equal(area().value, '雨夜。林昭來了');
  });

  test('beforeinput 的 historyUndo / historyRedo 也走編輯器的記錄', () => {
    t.type('！');
    const ev = new ui.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' });
    area().dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(area().value, '雨夜。林昭來了');
    area().dispatchEvent(
      new ui.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyRedo' })
    );
    assert.equal(area().value, '雨夜。林昭來了！');
  });

  test('關掉標籤，歷史隨之丟棄：再開啟從頭記', async () => {
    ui.clickEl(tab('林昭.md'));
    t.caret(4);
    t.type('甲');
    ui.clickEl(tab('林昭.md').querySelector('.ed-tab-close'));
    await ui.answer('不儲存');
    ui.post({ type: 'editorOpen', file: file('.novelwarden/characters/林昭.md', '# 林昭', { kind: 'character' }) });
    assert.equal(area().value, '# 林昭');
    k.undo();
    assert.equal(area().value, '# 林昭', '新開啟的檔案沒有可撤銷的');
  });
});

describe('撤銷 / 重做：輸入法組字', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
  });

  test('組字中途不記，上屏的那一整段算一步', () => {
    const a = area();
    a.setSelectionRange(3, 3);
    a.dispatchEvent(new ui.window.CompositionEvent('compositionstart', { bubbles: true }));
    const words = () => ui.doc.getElementById('edStatusWords').textContent;
    for (const step of ['l', 'li', 'lin', '林', '林昭']) {
      a.value = `雨夜。${step}`;
      a.setSelectionRange(3 + step.length, 3 + step.length);
      a.dispatchEvent(
        new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true })
      );
      if (step === '林') {
        // 組字中途字數照樣跟著重新整理（只是不記撤銷）。
        assert.match(words(), /全文 3 字/);
      }
    }
    a.dispatchEvent(new ui.window.CompositionEvent('compositionend', { bubbles: true, data: '林昭' }));
    assert.equal(a.value, '雨夜。林昭');
    assert.match(words(), /全文 4 字/);

    a.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(a.value, '雨夜。', '一下就退掉整段，不會退出半截拼音');
  });

  test('組字中途按 Ctrl+Z 放行給輸入法，不動編輯器的歷史', () => {
    const a = area();
    a.value = '雨夜。林昭';
    a.dispatchEvent(new ui.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const ev = new ui.window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true,
    });
    a.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(a.value, '雨夜。林昭');
  });
});

describe('撤銷 / 重做：整份換內容也記一步', { skip: JSDOM_SKIP }, () => {
  let ui;
  const area = () => ui.doc.getElementById('edArea');
  const tabEl = () => ui.doc.querySelector('#edTabs .ed-tab');
  const undo = () =>
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  let t;

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '原文', { kind: 'chapter' }) });
    t = typer(ui, area);
  });

  test('「還原」之後可以撤銷回剛才沒儲存的那份，那時它又是髒的', async () => {
    area().setSelectionRange(2, 2);
    t.type('，改了一半');
    ui.clickEl(ui.doc.getElementById('edRevertBtn'));
    await ui.answer('放棄修改');
    assert.ok(ui.last('reloadFile'), '沒發出 reloadFile');
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '原文', { kind: 'chapter' }) });
    assert.equal(area().value, '原文');
    assert.equal(tabEl().classList.contains('dirty'), false);

    undo();
    assert.equal(area().value, '原文，改了一半');
    assert.equal(tabEl().classList.contains('dirty'), true);
  });

  test('「用磁碟版本覆蓋編輯器」之後也可以撤銷', () => {
    // 儲存撞上衝突：磁碟上是別人寫的新版。
    area().dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(ui.last('saveFile')?.text, '原文，改了一半');
    ui.post({ type: 'editorConflict', path: 'chapters/001-雨夜.md', diskText: '磁碟新版', diskHash: 'h-disk' });
    ui.clickEl(ui.doc.getElementById('edConflictTake'));
    assert.equal(area().value, '磁碟新版');
    undo();
    assert.equal(area().value, '原文，改了一半');
  });

  test('右鍵「貼上」經程式改寫入口，一步可撤銷', async () => {
    ui.window.navigator.clipboard.readText = () => Promise.resolve('貼進來\r\n兩行');
    area().setSelectionRange(2, 2);
    const menu = ui.rightClick(area());
    ui.pick(menu, '貼上');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(area().value, '原文貼進來\n兩行，改了一半', '\\r\\n 歸一成 \\n');
    assert.equal(area().selectionStart, 8, '游標落在貼進來的文字末尾');
    undo();
    assert.equal(area().value, '原文，改了一半');
  });
});

describe('撤銷 / 重做：搬到另一塊編輯區歷史跟著走', { skip: JSDOM_SKIP }, () => {
  let ui;
  const areaOf = (i) => ui.panes()[i].querySelector('textarea');

  before(() => {
    ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
    ui.post({ type: 'editorOpen', file: file('.novelwarden/summaries/001-雨夜.md', '# 梗概', { kind: 'plot' }) });
  });

  test('主區打的字，搬到草稿區之後 Ctrl+Z 照樣退得回去', () => {
    const t = typer(ui, () => areaOf(0));
    areaOf(0).setSelectionRange(4, 4);
    t.type('：林昭');
    ui.post({ type: 'editorOpen', pane: 'draft', file: file('.novelwarden/summaries/001-雨夜.md', '# 梗概', { kind: 'plot' }) });
    const a = areaOf(1);
    assert.equal(a.value, '# 梗概：林昭', '未儲存的內容跟著搬');
    a.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(a.value, '# 梗概');
  });
});

describe('標題欄「編輯 → 撤銷 / 重做」', { skip: JSDOM_SKIP }, () => {
  let ui;
  let execCalls;
  const area = () => ui.doc.getElementById('edArea');
  const menuItem = (label) => {
    ui.clickEl(ui.doc.querySelector('[data-menu="edit"]'));
    return [...ui.doc.querySelectorAll('.wb-menu-drop .wb-menu-item')].find(
      (b) => b.querySelector('.wb-menu-label').textContent === label
    );
  };

  before(() => {
    ui = mount({
      body: 'standalone',
      scripts: ['view.js', 'editor.js'],
      shims: ['clipboard', 'scrollIntoView', 'pointerCapture', 'confirm'],
    });
    execCalls = [];
    // jsdom 沒有 execCommand：記下呼叫，好看出選單把活交給了誰。
    ui.doc.execCommand = (name) => {
      execCalls.push(name);
      return true;
    };
    ui.post({ type: 'editorOpen', file: file('chapters/001-雨夜.md', '雨夜。', { kind: 'chapter' }) });
  });

  test('焦點在編輯區：「撤銷」「重做」走編輯器自己的歷史', () => {
    const t = typer(ui, area);
    area().focus();
    area().setSelectionRange(3, 3);
    t.type('林昭');
    ui.clickEl(menuItem('撤銷'));
    assert.equal(area().value, '雨夜。');
    ui.clickEl(menuItem('重做'));
    assert.equal(area().value, '雨夜。林昭');
    assert.deepEqual(execCalls, [], '沒交給瀏覽器原生的 execCommand');
  });

  test('按下選單按鈕不奪走焦點', () => {
    area().focus();
    const btn = ui.doc.querySelector('[data-menu="edit"]');
    const ev = new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    ui.closeMenu();
  });

  test('焦點在別的輸入框：照舊交給瀏覽器', () => {
    const input = ui.doc.getElementById('input');
    input.focus();
    ui.clickEl(menuItem('撤銷'));
    assert.deepEqual(execCalls, ['undo']);
    assert.equal(area().value, '雨夜。林昭', '編輯區沒被動');
  });
});
