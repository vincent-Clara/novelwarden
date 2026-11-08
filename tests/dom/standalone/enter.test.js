/**
 * 內建編輯器的回車（`media/src/editor/enter.ts`）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 三種分段格式 | 正文回車插的段分隔跟著工程的 `paragraphStyle` 走（`state` 與工程樹都認） |
 * | 有選區 / 游標後有空白 | 先替換選區；新段開頭不留空格 |
 * | 只有空白的行 | 只換行、不加縮排，並清掉那一行的空白 |
 * | 段首回車 | 整段往下推一行、格式原樣 |
 * | 標題行後面回車 | 與段落一樣插段分隔（⚑） |
 * | Shift+Enter | 只插 `\n` |
 * | 撤銷 | 每次回車一步 |
 * | 輸入法組字 | 組字中的回車放行 |
 * | Markdown 列表 | 接著寫（`-` / `*` 照抄、`1.` 遞增），空的列表項上回車結束列表；其餘沿用縮排 |
 * | json / yml | 只沿用縮排 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file, viewState, sampleTree } = require('../../helpers/dom');

const W = '　　';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['editor.js'], shims: ['pointerCapture', 'confirm'] });
  const area = () => ui.doc.getElementById('edArea');
  const press = (init) => {
    const ev = new ui.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    area().dispatchEvent(ev);
    return ev;
  };
  return {
    ui,
    area,
    open(path, text, kind) {
      ui.post({ type: 'editorOpen', file: file(path, text, kind ? { kind } : undefined) });
    },
    style(paragraphStyle) {
      ui.post({ type: 'state', state: viewState({ paragraphStyle }) });
    },
    select(start, end = start) {
      area().setSelectionRange(start, end);
    },
    press,
    enter: (extra) => press({ key: 'Enter', ...extra }),
    undo: () => press({ key: 'z', ctrlKey: true }),
    caret: () => area().selectionStart,
  };
}

describe('回車：正文按分段格式另起一段', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('沒收到格式之前按空行分段：插 \\n\\n', () => {
    h.open('chapters/001-雨夜.md', '他推開門。', 'chapter');
    h.select(5);
    const ev = h.enter();
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '他推開門。\n\n');
    assert.equal(h.caret(), 7);
  });

  test('一次回車一步撤銷', () => {
    h.undo();
    assert.equal(h.area().value, '他推開門。');
  });

  test('段首縮排：插 \\n + 兩個全形空格', () => {
    h.style('indent');
    h.open('chapters/002-入鎮.md', `${W}他推開門。`, 'chapter');
    h.select(7);
    h.enter();
    assert.equal(h.area().value, `${W}他推開門。\n${W}`);
    assert.equal(h.caret(), h.area().value.length);
  });

  test('縮排加空行：插 \\n\\n + 兩個全形空格（工程樹帶來的格式也認）', () => {
    h.ui.post({ type: 'project', tree: { ...sampleTree(), paragraphStyle: 'both' } });
    h.open('chapters/003-夜訪.md', '他推開門。', 'chapter');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, `他推開門。\n\n${W}`);
  });

  test('草稿也是正文', () => {
    h.style('indent');
    h.open('drafts/001-雨夜.md', '草稿一句。', 'draft');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, `草稿一句。\n${W}`);
  });

  test('段落中間回車：斷成兩段，游標後面緊跟的空白刪掉', () => {
    h.open('chapters/004-北行.md', `${W}他推開門。 　她笑了。`, 'chapter');
    h.select(7);
    h.enter();
    assert.equal(h.area().value, `${W}他推開門。\n${W}她笑了。`);
    assert.equal(h.caret(), 10, '游標停在新段的字前面');
  });

  test('有選區：先替換選區再另起一段', () => {
    h.open('chapters/005-赤星.md', '他推開門，看見她笑了。', 'chapter');
    h.select(4, 7);
    h.enter();
    assert.equal(h.area().value, `他推開門\n${W}她笑了。`);
  });

  test('只有縮排的行：只換行、不加縮排，並清掉這一行的空白', () => {
    h.open('chapters/006-空行.md', `${W}他推開門。\n${W}`, 'chapter');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, `${W}他推開門。\n\n`);
    h.enter();
    assert.equal(h.area().value, `${W}他推開門。\n\n\n`, '連按回車不堆出一串縮排行');
  });

  test('段首回車：整段往下推一行，格式原樣，游標仍停在字前面', () => {
    h.open('chapters/007-段首.md', `${W}他推開門。`, 'chapter');
    h.select(0);
    h.enter();
    assert.equal(h.area().value, `\n${W}他推開門。`);
    assert.equal(h.caret(), 3);
  });

  test('標題行後面回車：與段落一樣插段分隔，下一行是正文的一段（⚑）', () => {
    h.open('chapters/008-標題.md', '# 第八章 雨夜', 'chapter');
    h.select(8);
    h.enter();
    assert.equal(h.area().value, `# 第八章 雨夜\n${W}`);
  });

  test('Shift+Enter 只插 \\n', () => {
    h.open('chapters/009-詩.md', '床前明月光', 'chapter');
    h.select(5);
    const ev = h.enter({ shiftKey: true });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.area().value, '床前明月光\n');
  });

  test('輸入法組字中的回車放行給輸入法', () => {
    h.open('chapters/010-組字.md', '他', 'chapter');
    h.select(1);
    const ev = h.enter({ isComposing: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(h.area().value, '他');
  });
});

describe('回車：非正文', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.style('indent');
  });

  test('Markdown 列表接著寫：- 照抄', () => {
    h.open('.novelwarden/characters/林昭.md', '- 身份：漁家子', 'character');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '- 身份：漁家子\n- ');
    assert.equal(h.caret(), h.area().value.length);
  });

  test('有序列表遞增，縮排照抄', () => {
    h.open('.novelwarden/outline.md', '  1. 入宗', 'outline');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '  1. 入宗\n  2. ');
  });

  test('* 列表也接著寫', () => {
    h.open('.novelwarden/lore/宗門.md', '* 外門', 'lore');
    h.select(4);
    h.enter();
    assert.equal(h.area().value, '* 外門\n* ');
  });

  test('空的列表項上回車：去掉標記、結束列表', () => {
    h.open('.novelwarden/characters/蘇晚.md', '- 身份\n- ', 'character');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '- 身份\n');
    assert.equal(h.caret(), h.area().value.length);
  });

  test('Markdown 裡不是列表的行：沿用行首空白，不按正文縮排', () => {
    h.open('.novelwarden/world.md', '  縮排的說明', 'setting');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, '  縮排的說明\n  ');
  });

  test('分隔線不是列表', () => {
    h.open('.novelwarden/premise.md', '* * *', 'setting');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, '* * *\n');
  });

  test('yml：只沿用縮排', () => {
    h.open('config.yml', 'a:\n  b: 1');
    h.select(h.area().value.length);
    h.enter();
    assert.equal(h.area().value, 'a:\n  b: 1\n  ');
  });

  test('json 裡的列表樣子不接著寫', () => {
    h.open('data.json', '  - x');
    h.select(5);
    h.enter();
    assert.equal(h.area().value, '  - x\n  ');
  });

  test('非正文的 Shift+Enter 交給瀏覽器', () => {
    h.open('notes.md', '隨手記');
    h.select(3);
    const ev = h.enter({ shiftKey: true });
    assert.equal(ev.defaultPrevented, false);
  });

  test('非正文的回車也是一步撤銷', () => {
    h.open('.novelwarden/characters/陳伯.md', '- 身份：漁家子', 'character');
    h.select(h.area().value.length);
    h.enter();
    h.undo();
    assert.equal(h.area().value, '- 身份：漁家子');
  });
});
