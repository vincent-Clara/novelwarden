/**
 * 外觀與專注的取值校驗（`media/src/editor/lookCore.ts`，純函式）：字號 / 行距 / 版心的上下限與取整、
 * 字型認不出回落宋體、整份偏好讀回來壞值逐項回落、專注三個開關只認明明白白的 true、寫到 `<html>` 上的變數。
 * 面板、選單、快捷鍵那一整條在 tests/dom/standalone/look.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  DEFAULT_LOOK,
  FONT_CHOICES,
  FONT_SIZE,
  LINE_HEIGHT,
  LOOK_VARS,
  MEASURE,
  clampFontSize,
  clampLineHeight,
  clampMeasure,
  fontStack,
  lookVars,
  measureLabel,
  normalizeFocus,
  normalizeFont,
  normalizeLook,
  sameLook,
  stepFontSize,
} = loadModule('media/src/editor/lookCore.ts');

describe('lookCore：預設值', () => {
  test('預設與改造前寫死的一樣：宋體、15px、1.95 倍、鋪滿', () => {
    assert.deepEqual({ ...DEFAULT_LOOK }, { fontFamily: 'song', fontSize: 15, lineHeight: 1.95, measure: 0 });
  });

  test('預設值被凍結，改不動', () => {
    assert.equal(Object.isFrozen(DEFAULT_LOOK), true);
  });

  test('字型表：宋體、黑體、楷體、仿宋、跟隨系統，宋體排第一', () => {
    assert.deepEqual(
      FONT_CHOICES.map((f) => f.id),
      ['song', 'hei', 'kai', 'fangsong', 'system']
    );
  });

  test('每個字型都落到一個通用族上（作者機器上沒有那幾個名字時不至於變成瀏覽器預設的 Times）', () => {
    for (const f of FONT_CHOICES) {
      assert.match(f.stack, /(serif|sans-serif|system-ui)$/, f.id);
    }
  });

  test('版心的幾檔裡第一檔是「鋪滿」（0）', () => {
    assert.equal(MEASURE.presets[0], 0);
  });
});

describe('lookCore：字號', () => {
  test('範圍之內原樣', () => {
    assert.equal(clampFontSize(18), 18);
  });

  test('越界夾進上下限', () => {
    assert.deepEqual([clampFontSize(4), clampFontSize(200)], [FONT_SIZE.min, FONT_SIZE.max]);
  });

  test('取整到 1px', () => {
    assert.equal(clampFontSize(16.4), 16);
  });

  test('不是數字（字串、NaN、Infinity、null）回落預設', () => {
    for (const bad of ['18', NaN, Infinity, null, undefined, {}]) {
      assert.equal(clampFontSize(bad), 15, String(bad));
    }
  });

  test('放大一檔、縮小一檔', () => {
    assert.deepEqual([stepFontSize(15, 1), stepFontSize(15, -1)], [16, 14]);
  });

  test('到頭了原樣返回', () => {
    assert.deepEqual([stepFontSize(FONT_SIZE.max, 1), stepFontSize(FONT_SIZE.min, -1)], [FONT_SIZE.max, FONT_SIZE.min]);
  });
});

describe('lookCore：行距', () => {
  test('範圍之內取整到 0.05', () => {
    assert.equal(clampLineHeight(1.83), 1.85);
  });

  test('不留浮點尾巴', () => {
    assert.equal(clampLineHeight(0.1 + 0.2 + 1.5), 1.8);
  });

  test('越界夾進上下限', () => {
    assert.deepEqual([clampLineHeight(1), clampLineHeight(9)], [LINE_HEIGHT.min, LINE_HEIGHT.max]);
  });

  test('壞值回落預設', () => {
    assert.equal(clampLineHeight('2'), 1.95);
  });
});

describe('lookCore：版心寬度', () => {
  test('0 是鋪滿', () => {
    assert.equal(clampMeasure(0), 0);
  });

  test('負數也當鋪滿', () => {
    assert.equal(clampMeasure(-5), 0);
  });

  test('太窄夾到最少 20 字、太寬夾到最多 80 字', () => {
    assert.deepEqual([clampMeasure(3), clampMeasure(500)], [MEASURE.min, MEASURE.max]);
  });

  test('取整', () => {
    assert.equal(clampMeasure(42.6), 43);
  });

  test('壞值回落鋪滿', () => {
    assert.equal(clampMeasure('40'), 0);
  });

  test('說法：鋪滿 / 一行最多 N 字', () => {
    assert.deepEqual([measureLabel(0), measureLabel(40)], ['鋪滿', '一行最多 40 字']);
  });
});

describe('lookCore：字型', () => {
  test('認得出的原樣', () => {
    assert.equal(normalizeFont('kai'), 'kai');
  });

  test('認不出（拼錯、中文名、數字）回落宋體', () => {
    for (const bad of ['Kai', '楷體', 3, null]) {
      assert.equal(normalizeFont(bad), 'song', String(bad));
    }
  });

  test('認不出的 id 取字型串時也落到宋體那一串', () => {
    assert.equal(fontStack('nope'), FONT_CHOICES[0].stack);
  });
});

describe('lookCore：整份偏好讀回來', () => {
  test('什麼都沒記（null、不是物件）：全是預設', () => {
    for (const raw of [null, undefined, 'x', 3, []]) {
      assert.deepEqual(normalizeLook(raw), { ...DEFAULT_LOOK }, String(raw));
    }
  });

  test('只讀外觀那四項，同一處記著的別的開關不管', () => {
    const raw = { autoPair: false, autoSave: true, fontFamily: 'hei', fontSize: 20, lineHeight: 2.2, measure: 40 };
    assert.deepEqual(normalizeLook(raw), { fontFamily: 'hei', fontSize: 20, lineHeight: 2.2, measure: 40 });
  });

  test('壞值逐項回落：一項壞了不連累別的', () => {
    const raw = { fontFamily: 'comic', fontSize: 20, lineHeight: 'tall', measure: 40 };
    assert.deepEqual(normalizeLook(raw), { fontFamily: 'song', fontSize: 20, lineHeight: 1.95, measure: 40 });
  });

  test('越界的夾進上下限', () => {
    assert.deepEqual(normalizeLook({ fontSize: 99, lineHeight: 0.5, measure: 5 }), {
      fontFamily: 'song',
      fontSize: FONT_SIZE.max,
      lineHeight: LINE_HEIGHT.min,
      measure: MEASURE.min,
    });
  });

  test('sameLook 逐項比', () => {
    assert.equal(sameLook({ ...DEFAULT_LOOK }, normalizeLook({})), true);
    assert.equal(sameLook({ ...DEFAULT_LOOK }, { ...DEFAULT_LOOK, measure: 40 }), false);
  });
});

describe('lookCore：寫到 <html> 上的那組變數', () => {
  test('變數名：字型、字號、行距、版心', () => {
    assert.deepEqual(Object.values(LOOK_VARS), [
      '--nf-ed-font-family',
      '--nf-ed-font-size',
      '--nf-ed-line-height',
      '--nf-ed-measure',
    ]);
  });

  test('字號帶 px、行距是倍數、版心按 em（全形字寬 = 字號）', () => {
    const vars = lookVars({ fontFamily: 'hei', fontSize: 18, lineHeight: 2.1, measure: 40 });
    assert.deepEqual(
      [vars['--nf-ed-font-size'], vars['--nf-ed-line-height'], vars['--nf-ed-measure']],
      ['18px', '2.1', '40em']
    );
  });

  test('字型寫的是那一串字型族名', () => {
    assert.equal(lookVars({ ...DEFAULT_LOOK, fontFamily: 'kai' })['--nf-ed-font-family'], fontStack('kai'));
  });

  test('鋪滿寫成整個編輯區寬（100cqi），居中那一算式落回最小內邊距', () => {
    assert.equal(lookVars({ ...DEFAULT_LOOK })['--nf-ed-measure'], '100cqi');
  });
});

describe('lookCore：專注那三個開關', () => {
  test('預設都關', () => {
    assert.deepEqual(normalizeFocus(null), { focusMode: false, typewriter: false, paragraphFocus: false });
  });

  test('只認明明白白的 true（"true"、1 都不算）', () => {
    assert.deepEqual(normalizeFocus({ focusMode: 'true', typewriter: 1, paragraphFocus: true }), {
      focusMode: false,
      typewriter: false,
      paragraphFocus: true,
    });
  });

  test('全屏不在偏好裡（記了也恢復不了）', () => {
    assert.equal('fullscreen' in normalizeFocus({ fullscreen: true }), false);
  });
});
