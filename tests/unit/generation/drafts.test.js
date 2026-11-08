/**
 * Draft store：未採納的產物存哪裡。
 *
 * 存在理由與從前 `ChatTurn.artifact` 存進會話是同一條：**重新整理網頁後採納按鈕
 * 還在**，不然剛生成的四個場景就只剩一段誰也用不上的 JSON。
 *
 * 所以這組用例釘三件事：記憶體裡存得住、隨會話檔案往返一趟還認得出、
 * 會話檔案被手改壞時**不拋**（第 1 條：容錯優先）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let drafts;
let sessionMod;
let WORK;
let store;

/** 一份最小可用的 draft。 */
function makeDraft(over = {}) {
  return {
    id: 'd1',
    action: { stage: 'plot', capability: 'generate' },
    target: { kind: 'plot', plotRelPath: '.novelwarden/summaries/001-夜入青雲.md' },
    raw: '{"关键事件":"進宗門"}',
    artifact: { kind: 'plot', sections: { 梗概: '', 关键事件: '進宗門', 看点: '' } },
    summary: '細綱 · 1/8 節',
    words: 3,
    createdAt: '2026-08-15T10:00:00.000Z',
    ...over,
  };
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    session: './src/core/model/session.ts',
    drafts: './src/core/generation/drafts.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  drafts = bundle.drafts;
  sessionMod = bundle.session;
  ({ dir: WORK } = makeTempDir('drafts'));
  const project = bundle.project.NovelProject.open(WORK);
  store = new sessionMod.SessionStore(project);
});

after(() => {
  cleanup(WORK);
});

describe('DraftStore · 記憶體', () => {
  let s;

  before(() => {
    s = new drafts.DraftStore();
    s.put(makeDraft(), 'sess-a');
    s.put(makeDraft({ id: 'd2' }), 'sess-a');
    s.put(makeDraft({ id: 'd3' }), 'sess-b');
  });

  test('put 之後取得回來', () => {
    assert.equal(s.get('d1').raw, '{"关键事件":"進宗門"}');
  });

  test('取不認識的 id 給 undefined，不拋', () => {
    assert.equal(s.get('沒有這個'), undefined);
  });

  test('bySession 只給那個會話的', () => {
    assert.deepEqual(s.bySession('sess-a').map((d) => d.id), ['d1', 'd2']);
  });

  test('另一個會話互不幹擾', () => {
    assert.deepEqual(s.bySession('sess-b').map((d) => d.id), ['d3']);
  });

  // 會話切換/關閉時清掉那個會話的草稿：留著只會把記憶體撐成一本書。
  test('dropBySession 清掉那一個會話', () => {
    s.dropBySession('sess-a');
    assert.equal(s.get('d1'), undefined);
  });

  test('dropBySession 不動別的會話', () => {
    assert.equal(s.get('d3').id, 'd3');
  });

  test('drop 不存在的會話不拋', () => {
    s.dropBySession('從來沒有過');
    assert.equal(s.get('d3').id, 'd3');
  });
});

describe('DraftStore · 一個會話留多少份', () => {
  let s;
  let kept;

  before(() => {
    s = new drafts.DraftStore();
    for (let i = 1; i <= drafts.MAX_DRAFTS_PER_SESSION + 5; i++) {
      s.put(makeDraft({ id: `d${i}` }), 'sess');
    }
    kept = s.bySession('sess');
  });

  // draft.raw 與 ChatTurn.content 是同一段文字，全留著等於把會話檔案寫兩遍。
  test('超出上限就丟最老的', () => {
    assert.equal(kept.length, drafts.MAX_DRAFTS_PER_SESSION, String(kept.length));
  });

  test('留下的是最近的那些', () => {
    assert.equal(kept[kept.length - 1].id, `d${drafts.MAX_DRAFTS_PER_SESSION + 5}`);
  });

  test('被擠掉的取不到了', () => {
    assert.equal(s.get('d1'), undefined);
  });
});

describe('隨會話往返一趟', () => {
  let reloaded;
  let s;

  before(async () => {
    const session = store.create();
    session.turns.push({
      id: 't1',
      role: 'assistant',
      content: '{"关键事件":"進宗門"}',
      at: '2026-08-15T10:00:00.000Z',
      draftId: 'd1',
      artifact: { where: '第 1 章 · 細綱', summary: '細綱 · 1/8 節', overwrites: false },
    });
    session.drafts = [makeDraft()];
    await store.write(session);
    reloaded = await store.read(session.id);
    s = new drafts.DraftStore();
    s.load(session.id, reloaded.drafts);
  });

  test('草稿跟著會話落了盤', () => {
    assert.equal(reloaded.drafts.length, 1, JSON.stringify(reloaded.drafts));
  });

  test('落點跟著一起回來了', () => {
    assert.equal(reloaded.drafts[0].target.plotRelPath, '.novelwarden/summaries/001-夜入青雲.md');
  });

  test('動作跟著一起回來了', () => {
    assert.equal(reloaded.drafts[0].action.capability, 'generate');
  });

  test('原文跟著一起回來了', () => {
    assert.equal(reloaded.drafts[0].raw, '{"关键事件":"進宗門"}');
  });

  // 重新整理網頁後採納按鈕還在——這就是 draft 落盤的全部理由。
  test('氣泡上的 draftId 還認得出', () => {
    assert.equal(reloaded.turns[0].draftId, 'd1');
  });

  test('展示快照也還在', () => {
    assert.equal(reloaded.turns[0].artifact.summary, '細綱 · 1/8 節');
  });

  test('裝回記憶體後取得到', () => {
    assert.equal(s.get('d1').summary, '細綱 · 1/8 節');
  });
});

// 三期：正文的寫法決定採納時追加還是覆蓋。重新整理之後再寫入，不能從「接著寫」變成「覆蓋」。
describe('正文草稿的寫法與長度隨會話往返', () => {
  let reloaded;

  before(async () => {
    const session = store.create();
    session.drafts = [
      makeDraft({
        id: 'm1',
        action: { stage: 'manuscript', capability: 'generate' },
        target: { kind: 'manuscript', plotRelPath: '.novelwarden/summaries/003-夜訪.md' },
        raw: '他推開了門。',
        writeMode: 'continue',
        length: { words: 2980, target: 3000, added: 1200, rounds: 2, reached: true },
        replay: '沈氏坐在櫃檯後面',
      }),
      makeDraft({ id: 'm2', writeMode: 'append', length: { words: '很多' } }),
    ];
    await store.write(session);
    reloaded = await store.read(session.id);
  });

  test('寫法、長度、重演原句都回來了', () => {
    const d = reloaded.drafts.find((x) => x.id === 'm1');
    assert.equal(d.writeMode, 'continue');
    assert.deepEqual(d.length, { words: 2980, target: 3000, added: 1200, rounds: 2, reached: true });
    assert.equal(d.replay, '沈氏坐在櫃檯後面');
  });

  test('手改壞的寫法與長度當沒記（不拋）', () => {
    const d = reloaded.drafts.find((x) => x.id === 'm2');
    assert.equal(d.writeMode, undefined);
    assert.equal(d.length, undefined);
  });
});

describe('會話檔案被手改壞', () => {
  let session;
  let reloaded;

  before(async () => {
    session = store.create();
    session.turns.push({
      id: 't1', role: 'assistant', content: 'x', at: '2026-08-15T10:00:00.000Z',
      draftId: '這份草稿已經沒了',
      artifact: { where: '第 1 章 · 細綱', summary: '細綱 · 1/8 節', overwrites: false },
    });
    session.turns.push({
      id: 't2', role: 'assistant', content: 'y', at: '2026-08-15T10:01:00.000Z', draftId: 'd1',
    });
    session.drafts = [
      makeDraft(),
      // 認不出的幾種：不是物件、沒有 id、target 是垃圾。
      null,
      { raw: '沒有 id' },
      { id: 'd9', action: { stage: '瞎寫' }, target: '不是物件', raw: 123 },
    ];
    await store.write(session);
    reloaded = await store.read(session.id);
  });

  test('讀得出來，沒拋', () => {
    assert.ok(reloaded, '會話讀不出來了');
  });

  test('認得出的那份留下', () => {
    assert.ok(reloaded.drafts.some((d) => d.id === 'd1'), JSON.stringify(reloaded.drafts));
  });

  test('認不出的丟掉', () => {
    assert.equal(reloaded.drafts.length, 2, JSON.stringify(reloaded.drafts.map((d) => d.id)));
  });

  // 欄位壞掉的那份不整體作廢：id 在就還認得出是哪一輪產出的，
  // 其餘欄位按容錯預設值補——歸一化的 target 回落到全書大綱。
  test('壞欄位按預設值補上', () => {
    const d9 = reloaded.drafts.find((d) => d.id === 'd9');
    assert.equal(d9.target.kind, 'outline', JSON.stringify(d9.target));
    assert.equal(d9.raw, '', JSON.stringify(d9.raw));
  });

  // 氣泡上的展示快照留著——「這一輪產出過一份劇情」翻回來看得出來。
  // 草稿在不在已經與它無關了：寫不寫盤在產出的當下就問過了，氣泡上沒有
  // 任何能觸發寫入的按鈕，也就沒有「草稿過期了怎麼辦」這回事。
  test('展示快照留著', () => {
    assert.equal(reloaded.turns[0].artifact.summary, '細綱 · 1/8 節');
  });
});

describe('沒有 drafts 欄位的老會話', () => {
  let reloaded;

  before(async () => {
    const session = store.create();
    session.turns.push({ id: 't1', role: 'user', content: '你好', at: '2026-08-15T10:00:00.000Z' });
    await store.write(session);
    // 手工抹掉 drafts 鍵，模擬二期之前寫下的會話檔案。
    const file = path.join(WORK, '.novelwarden', 'sessions', `${session.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.drafts;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    reloaded = await store.read(session.id);
  });

  test('讀得出來', () => {
    assert.ok(reloaded);
  });

  test('drafts 退化成空陣列', () => {
    assert.deepEqual(reloaded.drafts, []);
  });
});
