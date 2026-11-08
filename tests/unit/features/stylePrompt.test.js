const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mod = () => loadModule('src/core/features/stylePrompt.ts');

describe('stylePrompt.ts · 截斷檢查', () => {
  test('寫法技能寫到一半：報出缺的小節', () => {
    const { missingSections, REFERENCE_SKILL_SYSTEM } = mod();
    const half = '## 章節結構\n\n- 一章兩到三個場景。\n- **結尾停靠**：\n  1. 視覺峰值\n  2. 規則';
    assert.deepEqual(missingSections(REFERENCE_SKILL_SYSTEM, half), [
      '場景推進',
      '鉤子與懸念',
      '節奏與爽點',
      '資訊投放',
      '開篇寫法',
      '規劃時怎麼用',
    ]);
  });

  test('七節齊全的文風指南放行，標題前後的空白不算數', () => {
    const { assertComplete, missingSections, STYLE_SYSTEM } = mod();
    const heads = ['敘事視角', '句式節奏', '遣詞特徵', '對白風格', '描寫偏好', '修辭習慣', '禁用清單'];
    const full = heads.map((h) => `## ${h} \n內容`).join('\n\n');
    assert.deepEqual(missingSections(STYLE_SYSTEM, full), []);
    assert.doesNotThrow(() => assertComplete(STYLE_SYSTEM, full, 'end', 8000));
    assert.doesNotThrow(() => assertComplete(STYLE_SYSTEM, full, undefined, 8000));
  });

  test('上游報撞上限：小節齊全也不放行', () => {
    const { assertComplete, STYLE_SYSTEM } = mod();
    const heads = ['敘事視角', '句式節奏', '遣詞特徵', '對白風格', '描寫偏好', '修辭習慣', '禁用清單'];
    const full = heads.map((h) => `## ${h}\n內容`).join('\n\n');
    assert.throws(() => assertComplete(STYLE_SYSTEM, full, 'maxTokens', 8000), /輸出上限（8000 token）/);
  });

  test('閘道器不報收尾原因：靠缺小節攔下', () => {
    const { assertComplete, STYLE_SYSTEM } = mod();
    assert.throws(() => assertComplete(STYLE_SYSTEM, '## 敘事視角\n第三人稱', undefined, 8000), /缺了「句式節奏」/);
  });
});

describe('stylePrompt.ts · 不完整就重問', () => {
  const full = (system) =>
    system
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((h) => `${h}\n內容`)
      .join('\n\n');

  test('閘道器半路斷流：重問一次就拿到完整的', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    const replies = [{ text: '## 敘事視角\n第三人稱' }, { text: '```markdown\n' + full(STYLE_SYSTEM) + '\n```', stopReason: 'end' }];
    const retries = [];
    const text = await collectComplete(STYLE_SYSTEM, async () => replies.shift(), {
      maxOut: 8000,
      onRetry: (attempt, reason) => retries.push([attempt, reason]),
    });
    assert.equal(text, full(STYLE_SYSTEM));
    assert.equal(retries.length, 1);
    assert.match(retries[0][1], /缺了「句式節奏」/);
  });

  test('撞了輸出上限：不重問，直接報錯', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    let calls = 0;
    await assert.rejects(
      collectComplete(STYLE_SYSTEM, async () => (calls++, { text: '## 敘事視角', stopReason: 'maxTokens' }), { maxOut: 8000 }),
      /輸出上限/
    );
    assert.equal(calls, 1);
  });

  test('一直不完整：重問用完後報錯，說明問了幾次', async () => {
    const { collectComplete, INCOMPLETE_RETRIES, REFERENCE_SKILL_SYSTEM } = mod();
    let calls = 0;
    await assert.rejects(
      collectComplete(REFERENCE_SKILL_SYSTEM, async () => (calls++, { text: '' }), { maxOut: 8000 }),
      new RegExp(`回答是空的.*連問 ${INCOMPLETE_RETRIES + 1} 次`)
    );
    assert.equal(calls, INCOMPLETE_RETRIES + 1);
  });

  test('已取消：不核小節，原樣返回', async () => {
    const { collectComplete, STYLE_SYSTEM } = mod();
    const ctl = new AbortController();
    ctl.abort();
    const text = await collectComplete(STYLE_SYSTEM, async () => ({ text: '## 敘事視角' }), { maxOut: 8000, signal: ctl.signal });
    assert.equal(text, '## 敘事視角');
  });
});
