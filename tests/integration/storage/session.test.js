/**
 * 會話儲存 SessionStore 的讀寫、容錯與列表。
 * 遷自 scripts/smoke-session.js（全部 70 條）。
 *
 * 兩點與別的整合用例不同：
 *
 * 1. **不 initialize 工程**。原指令碼只 `NovelProject.open(WORK)`，
 *    `新建不落盤` 那條斷言的正是 `.novelwarden/sessions` 壓根不存在，
 *    所以這裡用 makeTempDir 而不是 makeTempProject。
 * 2. **vscode 樁必須在 loadModule 之前裝**。bundle 是 `external: ['vscode']`，
 *    模組體在 _compile 時就會 require('vscode')。原指令碼裝完從不還原，
 *    這裡掛 restore() 到 after()。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadModule } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { cleanup } = require('../../helpers/teardown');

describe('session.ts · SessionStore', () => {
  let projectMod;
  let sessionMod;
  let stub;
  let WORK;
  let sessionsDir;
  let store;
  /** 第一個會話，跨小節複用。 */
  let s;
  /** 更早的那個會話，列表與刪除都要用。 */
  let older;

  before(() => {
    // project.ts 的 readConfig 仍讀 vscode 配置，給個最小樁（原指令碼 L27-42）。
    stub = installVscodeStub({ level: 'config' });
    projectMod = loadModule('src/core/model/project.ts');
    sessionMod = loadModule('src/core/model/session.ts');

    ({ dir: WORK } = makeTempDir('session'));
    sessionsDir = path.join(WORK, '.novelwarden', 'sessions');
    const project = projectMod.NovelProject.open(WORK);
    store = new sessionMod.SessionStore(project);
  });

  after(() => {
    cleanup(WORK);
    stub.restore();
  });

  describe('目錄與路徑', () => {
    let project;

    before(() => {
      project = projectMod.NovelProject.open(WORK);
    });

    test('sessionsDir 指向 .novelwarden/sessions', () => {
      assert.equal(project.sessionsDir, sessionsDir, project.sessionsDir);
    });

    test('空目錄時列表為空陣列', async () => {
      assert.equal((await store.list()).length, 0);
    });
  });

  describe('新建與寫入', () => {
    let turnsAtCreate;
    let notPersisted;
    let blank;
    let raw;

    before(async () => {
      s = store.create({
        target: { kind: 'manuscript', plotRelPath: '.novelwarden/summaries/004-夜訪.md' },
        targetNo: 4,
      });
      // 「新會話無輪次」「新建不落盤」都必須在 push / write 之前取值。
      turnsAtCreate = s.turns.length;
      notPersisted = !fs.existsSync(sessionsDir) || fs.readdirSync(sessionsDir).length === 0;

      // 不給 seed 時落到全書大綱：它是唯一一個不依賴任何章節就一定存在的產物。
      blank = store.create();

      s.title = '青崖鎮的夜';
      s.turns.push({
        id: 't1', role: 'user', content: '林昭夜訪沈氏。', at: '2026-08-01T10:00:00.000Z',
        attachments: [{ id: 'a1', kind: 'selection', label: '003.md:5-9', relPath: 'chapters/003.md',
          range: { start: 5, end: 9 }, text: '選中的原文' }],
        excludedIds: ['style'],
      });
      s.turns.push({
        id: 't2', role: 'assistant', content: '三更，林昭醒了。', at: '2026-08-01T10:01:00.000Z',
        context: { usedTokens: 1200, budget: 60000, clamped: false,
          items: [{ id: 'style', label: '文風指南', kind: 'style', priority: 1, tokens: 0, status: 'excluded' }] },
        acceptedTo: 'chapters/004-夜訪.md',
      });
      // 外部 agent 經 MCP 留下的那一輪：段（文字與工具條交替），generate 那一段還帶著產出的正文。
      s.turns.push({
        id: 't3', role: 'assistant', content: '我先看看。\n\n寫好了。', at: '2026-08-01T10:02:00.000Z',
        segments: [
          { kind: 'tool', call: { callId: 'c1', name: 'read', title: 'read', ok: true, summary: '19 行', elapsedMs: 2 } },
          { kind: 'text', text: '我先看看。' },
          { kind: 'tool', call: { callId: 'c2', name: 'generate', title: 'generate 正文·生成',
            ok: true, summary: '正文 · 620 字', elapsedMs: 12400, output: '三更，林昭醒了。' } },
          { kind: 'text', text: '寫好了。' },
        ],
        mcp: true,
      });
      await store.write(s);
      raw = fs.readFileSync(path.join(sessionsDir, `${s.id}.json`), 'utf8');
    });

    test('新會話有 id', () => {
      assert.ok(/^\d{8}-\d{6}-[0-9a-f]{6}$/.test(s.id), s.id);
    });

    test('新會話記住寫入目標', () => {
      assert.equal(s.targetNo, 4);
    });

    test('新會話繼承創作目標', () => {
      assert.equal(s.target.plotRelPath, '.novelwarden/summaries/004-夜訪.md');
    });

    test('階段跟著目標走', () => {
      assert.equal(s.stage, 'manuscript', s.stage);
    });

    // 預設能力永遠是討論——預設就花錢產出一份要不要都不知道的產物是不對的。
    test('預設能力是討論', () => {
      assert.equal(s.capability, 'discuss', s.capability);
    });

    test('新會話無輪次', () => {
      assert.equal(turnsAtCreate, 0);
    });

    test('新建不落盤', () => {
      assert.ok(notPersisted);
    });

    test('無 seed 時落到全書大綱', () => {
      assert.equal(blank.target.kind, 'outline');
      assert.equal(blank.stage, 'outline');
    });

    test('寫入後檔案存在', () => {
      assert.ok(fs.existsSync(path.join(sessionsDir, `${s.id}.json`)));
    });

    test('檔案是合法 JSON 且帶換行結尾', () => {
      JSON.parse(raw);
      assert.ok(raw.endsWith('\n'));
    });
  });

  describe('讀回（round-trip）', () => {
    let back;
    let ghost;

    before(async () => {
      back = await store.read(s.id);
      ghost = await store.read('nope');
    });

    test('讀回 id 一致', () => {
      assert.equal(back.id, s.id);
    });

    test('讀回標題一致', () => {
      assert.equal(back.title, '青崖鎮的夜');
    });

    test('讀回 targetNo', () => {
      assert.equal(back.targetNo, 4);
    });

    test('讀回創作目標', () => {
      assert.equal(back.target.plotRelPath, '.novelwarden/summaries/004-夜訪.md');
    });

    test('讀回階段與能力', () => {
      assert.equal(back.stage, 'manuscript');
      assert.equal(back.capability, 'discuss');
    });

    test('讀回三輪', () => {
      assert.equal(back.turns.length, 3);
    });

    test('讀回使用者訊息原文', () => {
      assert.equal(back.turns[0].content, '林昭夜訪沈氏。');
    });

    test('讀回附件快照', () => {
      assert.equal(back.turns[0].attachments[0].text, '選中的原文');
    });

    test('讀回附件行範圍', () => {
      assert.equal(back.turns[0].attachments[0].range.end, 9);
    });

    test('讀回排除名單', () => {
      assert.equal(back.turns[0].excludedIds[0], 'style');
    });

    test('讀回上下文明細', () => {
      assert.equal(back.turns[1].context.usedTokens, 1200);
    });

    test('讀回採納路徑', () => {
      assert.equal(back.turns[1].acceptedTo, 'chapters/004-夜訪.md');
    });

    // 順序是這一輪唯一存不回來的東西：不落盤的話，重開面板畫出來的就是另一副樣子。
    test('讀回 MCP 那一輪的段（順序原樣）', () => {
      assert.deepEqual(
        back.turns[2].segments.map((seg) => (seg.kind === 'text' ? `文字:${seg.text}` : `工具:${seg.call.callId}`)),
        ['工具:c1', '文字:我先看看。', '工具:c2', '文字:寫好了。']
      );
    });

    // 從前這幾千字根本沒進會話：重新整理一下，作者剛生成的東西就沒了。
    test('讀回 generate 產出的正文', () => {
      assert.equal(back.turns[2].segments[2].call.output, '三更，林昭醒了。');
    });

    // 重開面板時靠它把這一輪認成「外部 Agent」那一條，而不是普通的回覆。
    test('讀回「這是 MCP 呼叫留下的一輪」', () => {
      assert.equal(back.turns[2].mcp, true);
    });

    test('普通回覆不帶 mcp 標記', () => {
      assert.equal(back.turns[1].mcp, undefined);
    });

    test('不存在的 id 返回 undefined', () => {
      assert.equal(ghost, undefined);
    });
  });

  describe('列表與排序', () => {
    let list;

    before(async () => {
      older = store.create();
      older.title = '更早的對話';
      older.createdAt = '2026-07-01T10:00:00.000Z';
      older.updatedAt = '2026-07-01T10:00:00.000Z';
      older.turns.push({ id: 'x1', role: 'user', content: '早先問的問題', at: older.updatedAt });
      await store.write(older);

      list = await store.list();
    });

    test('列出兩個會話', () => {
      assert.equal(list.length, 2, `got ${list.length}`);
    });

    test('按更新時間倒序', () => {
      assert.equal(list[0].id, s.id, `first=${list[0].title}`);
    });

    test('列表帶輪次數', () => {
      assert.equal(list[0].turnCount, 3);
    });

    test('列表 preview 取最後一條使用者訊息', () => {
      assert.equal(list[0].preview, '林昭夜訪沈氏。', list[0].preview);
    });

    test('列表不含 turns 全文', () => {
      assert.equal(list[0].turns, undefined);
    });
  });

  describe('容錯', () => {
    let brokenRead;
    let listAfterBroken;
    let partial;
    let listAfterNotJson;
    let legacy;
    let weird;
    let badcap;
    let badThinking;
    let goodThinking;

    before(async () => {
      fs.writeFileSync(path.join(sessionsDir, 'broken.json'), '{ 這不是 JSON');
      brokenRead = await store.read('broken');
      listAfterBroken = await store.list();

      fs.writeFileSync(path.join(sessionsDir, 'partial.json'), JSON.stringify({
        title: '', turns: [{ role: 'user', content: '有效' }, { role: '天知道', content: '無效' }, 'garbage'],
      }));
      partial = await store.read('partial');

      fs.writeFileSync(path.join(sessionsDir, 'notjson.txt'), 'ignore me');
      listAfterNotJson = await store.list();

      // 舊會話（0.2.x 只有 targetNo，沒有 target/stage/capability）。
      // 這條路每個升級上來的使用者都會走一遍，讀不出來等於整個歷史憑空消失。
      fs.writeFileSync(path.join(sessionsDir, 'legacy.json'), JSON.stringify({
        title: '舊對話', createdAt: '2026-01-01T00:00:00.000Z', targetNo: 7,
        turns: [{ role: 'user', content: '續寫第七章' }],
      }));
      legacy = await store.read('legacy');

      // 手改壞的 target/能力：認不出的一律回落，絕不拋。
      fs.writeFileSync(path.join(sessionsDir, 'weird.json'), JSON.stringify({
        target: { kind: '天知道', plotRelPath: 'x' }, stage: 'nope', capability: 'nope', turns: [],
      }));
      weird = await store.read('weird');

      // 該階段不支援的能力也要回落——正文階段沒有 split。
      fs.writeFileSync(path.join(sessionsDir, 'badcap.json'), JSON.stringify({
        target: { kind: 'manuscript', plotRelPath: '.novelwarden/summaries/001-x.md' },
        stage: 'manuscript', capability: 'split', turns: [],
      }));
      badcap = await store.read('badcap');

      // 思考深度：認不出的檔位當沒設過（= 不思考），一個手改壞的欄位
      // 不該讓整個會話讀不出來。
      fs.writeFileSync(path.join(sessionsDir, 'thinking.json'), JSON.stringify({
        target: { kind: 'outline' }, stage: 'outline', capability: 'discuss',
        thinking: '想很久', turns: [],
      }));
      badThinking = await store.read('thinking');

      fs.writeFileSync(path.join(sessionsDir, 'thinking2.json'), JSON.stringify({
        target: { kind: 'outline' }, stage: 'outline', capability: 'discuss',
        thinking: 'high', turns: [],
      }));
      goodThinking = await store.read('thinking2');
    });

    test('損壞檔案讀出 undefined', () => {
      assert.equal(brokenRead, undefined);
    });

    test('損壞檔案不影響列表', () => {
      assert.equal(listAfterBroken.length, 2, '壞檔案應被跳過');
    });

    test('認不出的思考深度當沒設過', () => {
      assert.equal(badThinking.thinking, undefined);
    });

    test('合法的思考深度原樣讀回', () => {
      assert.equal(goodThinking.thinking, 'high');
    });

    test('缺欄位時補預設標題', () => {
      assert.equal(partial.title, '未命名對話', partial.title);
    });

    test('缺時間戳時補當前時間', () => {
      assert.equal(typeof partial.createdAt, 'string');
      assert.ok(partial.createdAt.length > 10);
    });

    test('過濾掉非法輪次', () => {
      assert.equal(partial.turns.length, 1, `got ${partial.turns.length}`);
    });

    test('保留合法輪次', () => {
      assert.equal(partial.turns[0].content, '有效');
    });

    test('非 .json 檔案被忽略', () => {
      assert.ok(listAfterNotJson.every((x) => x.id !== 'notjson'));
    });

    test('舊會話讀得出來', () => {
      assert.ok(legacy);
      assert.equal(legacy.title, '舊對話');
    });

    // 序號 → 路徑要讀盤，而 normalize 是純的；這一步由 controller 補。
    test('舊會話回落到大綱', () => {
      assert.equal(legacy.target.kind, 'outline', JSON.stringify(legacy.target));
    });

    test('舊會話保留 targetNo 供 controller 還原', () => {
      assert.equal(legacy.targetNo, 7);
    });

    test('舊會話有合法的階段與能力', () => {
      assert.equal(legacy.stage, 'outline');
      assert.equal(legacy.capability, 'discuss');
    });

    test('認不出的 target 回落到大綱', () => {
      assert.equal(weird.target.kind, 'outline');
    });

    test('認不出的階段回落', () => {
      assert.equal(weird.stage, 'outline');
    });

    test('認不出的能力回落到預設', () => {
      assert.equal(weird.capability, 'discuss');
    });

    test('階段不支援的能力回落', () => {
      assert.equal(badcap.capability, 'discuss', badcap.capability);
    });

    test('但目標本身保留', () => {
      assert.equal(badcap.target.plotRelPath, '.novelwarden/summaries/001-x.md');
    });
  });

  describe('重新命名與刪除', () => {
    let renamed;
    let persisted;
    let blankRename;
    let ghostRename;
    let deletedRead;
    let trashed;
    let ghostDelete;

    before(async () => {
      renamed = await store.rename(s.id, '  改個名字  ');
      persisted = await store.read(s.id);
      blankRename = await store.rename(s.id, '   ');
      ghostRename = await store.rename('nope', 'x');

      await store.delete(older.id);
      deletedRead = await store.read(older.id);
      // 落點與工程頁的刪除同一套（`trashPathFor`）：回收站裡保留原相對路徑 `.novelwarden/sessions/<id>.json`。
      trashed = fs.existsSync(path.join(WORK, '.novelwarden', '.trash', '.novelwarden', 'sessions', `${older.id}.json`));
      ghostDelete = await store.delete('nope');
    });

    test('重新命名生效', () => {
      assert.equal(renamed.title, '改個名字', renamed.title);
    });

    test('重新命名已落盤', () => {
      assert.equal(persisted.title, '改個名字');
    });

    test('空標題不覆蓋原名', () => {
      assert.equal(blankRename.title, '改個名字');
    });

    test('重新命名不存在的會話返回 undefined', () => {
      assert.equal(ghostRename, undefined);
    });

    test('刪除後讀不到', () => {
      assert.equal(deletedRead, undefined);
    });

    test('刪除移入 .novelwarden/.trash，保留原相對路徑（.trash/.novelwarden/sessions/<id>.json）', () => {
      assert.ok(trashed);
    });

    test('刪除不存在的會話不報錯', () => {
      assert.equal(ghostDelete, undefined);
    });
  });

  // 第 6 條：會話刪除與工程頁的刪除同一套落點——同名加序號，不蓋掉上一次刪的。
  describe('同一個 id 刪兩次：兩份都留在回收站', () => {
    const trashOf = (name) => path.join(WORK, '.novelwarden', '.trash', '.novelwarden', 'sessions', name);
    let id;
    let first;
    let second;
    let flatLeft;

    before(async () => {
      const a = store.create();
      id = a.id;
      a.title = '第一次的會話';
      await store.write(a);
      await store.delete(id);

      // 同一個 id 再落盤一次（手抄回來的、或者撞了 id）：再刪也不該蓋掉回收站裡那一份。
      const b = { ...store.create(), id, title: '第二次的會話' };
      await store.write(b);
      await store.delete(id);

      first = fs.existsSync(trashOf(`${id}.json`)) ? JSON.parse(fs.readFileSync(trashOf(`${id}.json`), 'utf8')) : undefined;
      second = fs.existsSync(trashOf(`${id}-2.json`)) ? JSON.parse(fs.readFileSync(trashOf(`${id}-2.json`), 'utf8')) : undefined;
      flatLeft = fs.existsSync(path.join(WORK, '.novelwarden', '.trash', `${id}.json`));
    });

    test('第一次刪的那一份原樣在 <id>.json', () => {
      assert.equal(first?.title, '第一次的會話');
    });

    test('第二次刪的加序號落在 <id>-2.json', () => {
      assert.equal(second?.title, '第二次的會話');
    });

    test('不再平鋪在 .trash/ 根下', () => {
      assert.equal(flatLeft, false);
    });

    test('會話目錄裡已經沒有它', async () => {
      assert.equal(await store.read(id), undefined);
    });
  });

  describe('標題推導', () => {
    test('取首句', () => {
      assert.equal(sessionMod.deriveTitle('林昭進城，被守衛攔下。然後呢'), '林昭進城');
    });

    test('剝列表符號', () => {
      assert.equal(sessionMod.deriveTitle('1. 沈氏出場'), '沈氏出場');
    });

    test('跳過空行', () => {
      assert.equal(sessionMod.deriveTitle('\n\n  \n真正的內容'), '真正的內容');
    });

    test('空文字兜底', () => {
      assert.equal(sessionMod.deriveTitle('   '), '新對話');
    });

    test('長句截斷到 24 字', () => {
      assert.equal(
        sessionMod.deriveTitle('這是一個非常非常非常非常非常非常非常非常長的沒有標點的句子').length,
        24
      );
    });
  });

  // 命令類的輪次（生成細綱、拆成場景）content 本來就是空的：該說的都在大綱和
  // 細綱裡，作者一個字都不必打。空串會讓歷史列表出現一排「新對話」。
  describe('輪次預覽', () => {
    const t = (content, command) => ({ id: 'p1', role: 'user', content, at: sessionMod.nowIso(), command });

    test('有話就用那句話', () => {
      assert.equal(sessionMod.turnPreview(t('林昭夜訪沈氏。')), '林昭夜訪沈氏。');
    });

    test('空輸入的命令輪次用命令名', () => {
      assert.equal(sessionMod.turnPreview(t('', '生成細綱')), '/生成細綱');
    });

    test('兩樣都有時話優先', () => {
      assert.equal(sessionMod.turnPreview(t('慢一點', '生成細綱')), '慢一點');
    });

    test('兩樣都沒有時給空串', () => {
      assert.equal(sessionMod.turnPreview(t('   ')), '');
    });

    // 於是標題推導也跟著能說出這一輪幹了什麼，不再落到「新對話」。
    test('命令輪次的標題不再是「新對話」', () => {
      assert.equal(sessionMod.deriveTitle(sessionMod.turnPreview(t('', '拆成場景'))), '/拆成場景');
    });
  });

  describe('id 唯一性', () => {
    test('200 次生成無碰撞', () => {
      const ids = new Set();
      for (let i = 0; i < 200; i++) ids.add(sessionMod.makeSessionId());
      assert.equal(ids.size, 200, `got ${ids.size}`);
    });

    test('turnId 200 次無碰撞', () => {
      const turnIds = new Set();
      for (let i = 0; i < 200; i++) turnIds.add(sessionMod.makeTurnId());
      assert.equal(turnIds.size, 200, `got ${turnIds.size}`);
    });
  });
});
