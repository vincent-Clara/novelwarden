/**
 * 每個工具自報的**意圖**：這一步是什麼性質、問的時候怎麼說。
 *
 * 從前這些話寫在內建 agent 的 `policy.ts` 裡（一個按工具名分支的 switch）。
 * 現在按 `gate` 檔位決定問不問的是 MCP 執行端（`controller/mcp.ts`），
 * 而**說辭與它描述的那件事在同一個檔案裡**——改了 `write` 的行為，眼皮底下
 * 就是它要對作者說的話。
 *
 * 兩條不可配置的歸檔是產品承諾（AGENTS 第 25(a) 條），釘在這裡：
 *
 * 1. **`write` 覆蓋 = `reviewed`**——下游 `ws.write` 帶 diff 請人過目，
 *    不該在它之前再問一句「確定嗎」。
 * 2. **`edit` = `always`**——`ws.edit` 不走 diff，那一句確認就是它的 diff，
 *    任何呼叫方都不能免。
 *
 * 這裡不給 project（純單測），名字退回路徑本身。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const tools = loadModule('src/core/tools/novel/index.ts');

const byName = (name) => tools.NOVEL_TOOLS.find((t) => t.name === name);
const intentOf = (name, args) => byName(name).intent(args);

const PLOT = '.novelwarden/summaries/012-入宗.md';

describe('讀三件套：不問', () => {
  for (const name of ['list', 'read', 'search']) {
    test(`${name} 沒有 intent，也不標 mutating / costly`, () => {
      const tool = byName(name);
      // 登錄檔據此兜一個 auto——讀工具不花錢不改東西，問一句只是讓人麻木。
      assert.equal(tool.intent, undefined);
      assert.equal(!!tool.mutating, false);
      assert.equal(!!tool.costly, false);
    });
  }
});

describe('generate：花錢但不寫盤', () => {
  const g = () => intentOf('generate', { target: PLOT, ask: '接住第 9 章那處伏筆' });

  test('歸 costly', () => {
    assert.equal(g().gate, 'costly');
  });

  test('標了 costly，沒標 mutating（它一個字都不落盤）', () => {
    assert.equal(byName('generate').costly, true);
    assert.equal(!!byName('generate').mutating, false);
  });

  // 「Agent 想呼叫 generate，允許嗎」作者答不上來——他不知道會寫到哪、花多少。
  test('說清了會花錢', () => {
    assert.ok(g().detail.includes('花錢'), g().detail);
  });

  // 這一問是「要不要花錢生成」，落盤是另一問——產出之後當場還有一張卡。
  test('說清了產出之後還會再問一次落盤', () => {
    assert.ok(g().detail.includes('落盤'), g().detail);
  });

  test('說清了動的是哪一份', () => {
    assert.ok(g().title.includes(PLOT), g().title);
  });

  test('title 是動詞短語，主語留給呼叫方加', () => {
    assert.ok(!g().title.startsWith('Agent'), g().title);
  });

  // 按鈕上一律是「確認」（`controller/gate.ts` 的 `PROCEED_ACTION`）：動詞已經在
  // title 上了，工具不必再各報一個。
  test('不再自報按鈕上的字', () => {
    assert.equal(g().proceed, undefined);
  });
});

describe('write 新建 / 追加：常規的動手前問一句', () => {
  test('新建歸 mutating', () => {
    assert.equal(intentOf('write', { path: PLOT }).gate, 'mutating');
  });

  test('追加與新建同一檔', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'append' }).gate, 'mutating');
  });

  test('框上寫清了寫到哪、是新建還是追加', () => {
    const i = intentOf('write', { path: PLOT });
    assert.ok(i.title.includes('寫入'), i.title);
    assert.ok(i.detail.includes(PLOT), i.detail);
    assert.ok(i.detail.includes('新建'), i.detail);
    assert.ok(intentOf('write', { path: PLOT, mode: 'append' }).detail.includes('追加'), 'append');
  });

  test('不再自報按鈕上的字', () => {
    assert.equal(intentOf('write', { path: PLOT }).proceed, undefined);
  });
});

// ★ 產品承諾，不是偏好設定。
describe('write 覆蓋：交給下游的覆蓋審閱', () => {
  test('歸 reviewed（三種模式都不預先確認）', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'overwrite' }).gate, 'reviewed');
  });
});

// ★ 同上：edit 改的也是已有內容，而 ws.edit 不走 diff。
describe('edit：任何模式都要問', () => {
  const args = { path: PLOT, old: '林昭', new: '林昀' };

  test('歸 always', () => {
    assert.equal(intentOf('edit', args).gate, 'always');
  });

  // 不寫出 old → new，作者只能憑工具名點確定，那不叫過目。
  test('框裡寫出了原文與改成什麼', () => {
    const i = intentOf('edit', args);
    assert.ok(i.detail.includes('林昭'), i.detail);
    assert.ok(i.detail.includes('林昀'), i.detail);
  });

  test('刪掉一段時說「刪掉」而不是留空', () => {
    assert.ok(intentOf('edit', { ...args, new: '' }).detail.includes('刪掉'));
  });

  test('all=true 時說清全文都改', () => {
    assert.ok(intentOf('edit', { ...args, all: true }).detail.includes('所有出現的地方'));
  });

  test('不再自報按鈕上的字', () => {
    assert.equal(intentOf('edit', args).proceed, undefined);
  });
});

describe('帶 action 的工程動作：預設歸 mutating', () => {
  const i = () => intentOf('pipeline', { action: 'batchPlots' });

  test('歸 mutating', () => {
    assert.equal(i().gate, 'mutating');
  });

  // 標題就是動作的說法，作者在框裡讀到的是「批次拆細綱」而不是一個英文動作名。
  test('標題是那個動作的說法', () => {
    assert.ok(i().title.startsWith('批次拆細綱'), i().title);
  });

  // 這裡不問（`mutating` 檔），但 pipelineBatch 自己那個「預計呼叫 N 次」照彈。
  test('調模型的動作提醒了隨後還會告訴他調幾次', () => {
    assert.ok(i().detail.includes('預計呼叫幾次'), i().detail);
  });

  test('不調模型的動作不提呼叫次數', () => {
    assert.equal(intentOf('pipeline', { action: 'newPlot' }).detail.includes('預計呼叫幾次'), false);
  });

  test('作用物件（path / name）寫進框裡', () => {
    assert.ok(intentOf('summary', { action: 'finalize', path: PLOT }).detail.includes(PLOT));
    assert.ok(intentOf('characters', { action: 'create', name: '林昭' }).detail.includes('林昭'));
  });

  // 認不出的動作執行時會被拒，但問的那一步不能因此放行。
  test('認不出的動作也歸 mutating，標題寫著工具與動作名', () => {
    const x = intentOf('summary', { action: 'delete' });
    assert.equal(x.gate, 'mutating');
    assert.equal(x.title, '執行 summary delete');
  });

  test('技能的查與檢查不問，裝與綁每次都問', () => {
    assert.deepEqual(
      [
        intentOf('skills', { action: 'list' }).gate,
        intentOf('skills', { action: 'inspect', url: 'https://github.com/o/r' }).gate,
        intentOf('skills', { action: 'install', url: 'https://github.com/o/r' }).gate,
        intentOf('skills', { action: 'bind', id: 'builtin:x', stage: 'review' }).gate,
      ],
      ['auto', 'auto', 'always', 'always']
    );
  });
});

describe('長引數不整段攤進框裡', () => {
  test('超長的 old 會截斷', () => {
    const long = '青'.repeat(200);
    const detail = intentOf('edit', { path: PLOT, old: long, new: 'x' }).detail;
    assert.ok(detail.includes('…'), detail.slice(0, 80));
    assert.ok(detail.length < 200, String(detail.length));
  });
});
