/**
 * 工程資料庫與失敗記錄。遷自 scripts/smoke-errorlog.js（全部 46 條）。
 *
 * 這套機制的存在理由是「日誌與 toast 都要求使用者恰好在看」，所以它自己必須滿足三條：
 * 寫記錄絕不帶崩正事、成功必須清標記、純讀取不建庫。外加驅動適配層：語句用完即
 * finalize，否則 Windows 上庫檔案刪不掉。
 *
 * 收尾必須 `cleanup(WORK, db)`——先 resetDatabases() 關連線再 rmSync，
 * 否則 SQLite 控制代碼開著會漏臨時目錄。
 *
 * 時序敏感：斷言裡凡是讀「此刻磁碟上有沒有庫檔案」的，都在操作後**當場**取布林值存起來，
 * 斷言只讀變數。整段跑完再回頭 existsSync 會全看到最終狀態，早先那幾條就廢了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost, sleep } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

describe('errorLog · db', () => {
  let db;
  let errorLog;
  let logger;
  let projectMod;
  let projectView;
  let wsMod;
  let WORK;

  /** 與原指令碼的 newProject 一致：WORK 下開子工程，不刪示例檔案（本檔案無計數斷言）。 */
  async function newProject(name) {
    const root = path.join(WORK, name);
    fs.mkdirSync(root, { recursive: true });
    const project = projectMod.NovelProject.open(root);
    await new wsMod.Workspace(project).initializeProject({ title: name, author: '測試' });
    return project;
  }

  before(() => {
    const bundle = loadBundle({
      host: './src/core/host.ts',
      logger: './src/core/runtime/logger.ts',
      project: './src/core/model/project.ts',
      db: './src/core/runtime/db.ts',
      errorLog: './src/core/runtime/errorLog.ts',
      projectView: './src/core/views/projectView.ts',
      ws: './src/core/workspace/index.ts',
    });
    ({ logger, project: projectMod, db, errorLog, projectView, ws: wsMod } = bundle);
    // 原指令碼的 host 字面量裡沒有 reviewReplace，顯式抹掉，與原 host 形狀一致。
    bundle.host.initHost(makeFakeHost({ overrides: { reviewReplace: undefined } }).host);
    ({ dir: WORK } = makeTempDir('errorlog'));
  });

  after(() => cleanup(WORK, db));

  describe('驅動適配層', () => {
    let project;
    let dbFile;
    let handle;
    let rows;
    let nullRow;
    let cached;

    before(async () => {
      project = await newProject('driver');
      dbFile = path.join(project.root, '.novelwarden', 'novelwarden.db');
      handle = await db.openDatabase(project);

      // 建表是冪等的：每次開庫都會跑一遍 CREATE TABLE IF NOT EXISTS。
      handle.run(
        'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
        new Date().toISOString(),
        '角色卡',
        'character',
        'a.md',
        'error',
        'updateCard',
        '往返測試'
      );
      rows = handle.all('SELECT target_key, message FROM errors');

      // NULL 要能存也能讀回來（detail 常常是空的）。
      handle.run(
        'INSERT INTO errors (at, scope, target_kind, target_key, severity, op, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        new Date().toISOString(),
        '定稿',
        'chapter',
        'b.md',
        'error',
        'summarize',
        '無詳情',
        null
      );
      nullRow = handle.all("SELECT detail FROM errors WHERE target_key = 'b.md'")[0];

      // 同一個工程只開一個連線，不是每次查詢都開一次。
      cached = await db.openDatabase(project);
    });

    test('開得出庫', () => {
      assert.ok(handle);
    });

    test('庫檔案落在 .novelwarden/ 下', () => {
      assert.ok(fs.existsSync(dbFile), dbFile);
    });

    test('寫進去再讀得回來', () => {
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].message, '往返測試', JSON.stringify(rows));
    });

    test('detail 可以為 NULL', () => {
      assert.ok(nullRow, JSON.stringify(nullRow));
      assert.equal(nullRow.detail, null, JSON.stringify(nullRow));
    });

    test('連線按工程根快取', () => {
      assert.equal(cached, handle);
    });

    // ★ Windows 上不 finalize 語句就刪不掉庫檔案。這條掛了的話，
    //   所有用臨時工程的測試都會在收尾時 EBUSY。
    test('關庫之後刪得掉工程目錄（語句已 finalize）', () => {
      db.closeDatabase(project);
      let removed = true;
      try {
        fs.rmSync(project.root, { recursive: true, force: true });
      } catch {
        removed = false;
      }
      assert.ok(removed);
    });
  });

  describe('純讀取不建庫', () => {
    let project;
    let empty;
    let existsAfterQuery;
    let existsAfterClear;
    let history;
    let existsAfterHistory;
    let existsAfterRecord;

    before(async () => {
      project = await newProject('readonly');
      const dbFile = path.join(project.root, '.novelwarden', 'novelwarden.db');

      // 一個從沒出過錯的工程，光是重新整理工程頁不該生出 db 檔案。
      empty = await errorLog.listActiveFailures(project);
      existsAfterQuery = fs.existsSync(dbFile);

      await errorLog.clearFailures(project, 'character', 'nobody.md');
      existsAfterClear = fs.existsSync(dbFile);

      history = await db.readLogHistory(project, 10);
      existsAfterHistory = fs.existsSync(dbFile);

      // 寫入方才有理由建庫。
      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: 'x.md',
        severity: 'error',
        op: 'updateCard',
        message: '第一條記錄',
      });
      existsAfterRecord = fs.existsSync(dbFile);
    });

    after(() => db.closeDatabase(project));

    test('沒有庫時查詢返回空', () => {
      assert.equal(Object.keys(empty).length, 0, JSON.stringify(empty));
    });

    test('查詢不會建出庫檔案', () => {
      assert.ok(!existsAfterQuery);
    });

    test('清記錄也不會建出庫檔案', () => {
      assert.ok(!existsAfterClear);
    });

    test('讀日誌歷史不會建出庫檔案', () => {
      assert.equal(history.length, 0);
    });

    test('讀歷史後仍無庫檔案', () => {
      assert.ok(!existsAfterHistory);
    });

    test('記一條失敗會建出庫檔案', () => {
      assert.ok(existsAfterRecord);
    });
  });

  describe('失敗記錄的生命週期', () => {
    const CARD = '.novelwarden/characters/林昭.md';
    let project;
    let first;
    let afterRetries;
    let afterSecondOp;
    let afterClearOp;
    let afterClearAll;
    let afterSix;

    before(async () => {
      project = await newProject('lifecycle');

      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: CARD,
        severity: 'error',
        op: 'updateCard',
        message: '3 批全部解析失敗，角色卡未改動',
        detail: '範圍 第 1-5 章',
      });
      first = await errorLog.listActiveFailures(project);

      // 同一目標 + 同一動作只留最新一條：連著重試三次失敗，使用者要看的是
      // 「現在還錯著」，不是三條一模一樣的記錄。
      for (let i = 0; i < 3; i++) {
        await errorLog.recordFailure(project, {
          scope: '角色卡',
          targetKind: 'character',
          targetKey: CARD,
          severity: 'error',
          op: 'updateCard',
          message: `重試第 ${i + 1} 次仍失敗`,
        });
      }
      afterRetries = await errorLog.listActiveFailures(project);

      // 不同動作各留各的：同一章可能既定稿失敗、又角色卡失敗。
      await errorLog.recordFailure(project, {
        scope: '定稿',
        targetKind: 'chapter',
        targetKey: CARD,
        severity: 'warn',
        op: 'summarize',
        message: '定稿也失敗了',
      });
      afterSecondOp = await errorLog.listActiveFailures(project);

      // 清某個動作不該順手把別的動作的記錄抹掉。
      await errorLog.clearFailures(project, 'character', CARD, 'updateCard');
      afterClearOp = await errorLog.listActiveFailures(project);

      // 不給 op 就清該目標全部。
      await errorLog.clearFailures(project, 'chapter', CARD);
      afterClearAll = await errorLog.listActiveFailures(project);

      // 一個目標最多顯示 3 條（浮窗裡攤開更多沒人看）。
      for (let i = 0; i < 6; i++) {
        await errorLog.recordFailure(project, {
          scope: '设定',
          targetKind: 'lore',
          targetKey: 'lore.md',
          severity: 'error',
          op: `op-${i}`,
          message: `第 ${i} 條`,
        });
      }
      afterSix = await errorLog.listActiveFailures(project);
    });

    after(() => db.closeDatabase(project));

    test('按 relPath 索引', () => {
      assert.ok(first[CARD], JSON.stringify(first));
    });

    test('帶回 severity', () => {
      assert.equal(first[CARD][0].severity, 'error');
    });

    test('帶回 message', () => {
      assert.ok(first[CARD][0].message.includes('未改動'));
    });

    test('帶回 detail', () => {
      assert.equal(first[CARD][0].detail, '範圍 第 1-5 章');
    });

    test('帶回時間戳', () => {
      assert.equal(typeof first[CARD][0].at, 'string');
      assert.ok(first[CARD][0].at.length > 0);
    });

    test('同一動作只留最新一條', () => {
      assert.equal(afterRetries[CARD].length, 1, String(afterRetries[CARD].length));
    });

    test('留下的是最新那條', () => {
      assert.ok(afterRetries[CARD][0].message.includes('重試第 3 次'), afterRetries[CARD][0].message);
    });

    test('不同動作各留一條', () => {
      assert.equal(afterSecondOp[CARD].length, 2, String(afterSecondOp[CARD].length));
    });

    test('清掉了指定動作', () => {
      assert.equal(afterClearOp[CARD].length, 1, JSON.stringify(afterClearOp[CARD]));
    });

    test('別的動作的記錄還在', () => {
      assert.equal(afterClearOp[CARD][0].message, '定稿也失敗了', afterClearOp[CARD][0].message);
    });

    test('不給 op 則全清', () => {
      assert.ok(!afterClearAll[CARD], JSON.stringify(afterClearAll));
    });

    test('一個目標最多 3 條', () => {
      assert.equal(afterSix['lore.md'].length, 3, String(afterSix['lore.md'].length));
    });

    test('留下的是最近的 3 條', () => {
      assert.equal(afterSix['lore.md'][0].message, '第 5 條', afterSix['lore.md'][0].message);
    });
  });

  describe('工程頁快照帶上失敗記錄', () => {
    let project;
    let before1;
    let after1;

    before(async () => {
      project = await newProject('tree');
      fs.writeFileSync(
        path.join(project.root, '.novelwarden', 'characters', '林昭.md'),
        '---\nname: 林昭\n---\n\n# 林昭\n',
        'utf8'
      );
      project.invalidate();

      before1 = await projectView.buildProjectTree(project);

      await errorLog.recordFailure(project, {
        scope: '角色卡',
        targetKind: 'character',
        targetKey: '.novelwarden/characters/林昭.md',
        severity: 'error',
        op: 'updateCard',
        message: '解析失敗，角色卡未改動',
      });
      after1 = await projectView.buildProjectTree(project);
    });

    after(() => db.closeDatabase(project));

    test('沒有失敗時 failures 是空物件', () => {
      assert.equal(Object.keys(before1.failures).length, 0, JSON.stringify(before1.failures));
    });

    test('失敗記錄進了工程頁快照', () => {
      assert.ok(after1.failures['.novelwarden/characters/林昭.md'], JSON.stringify(after1.failures));
    });
  });

  describe('日誌持久化', () => {
    let project;
    let history;
    let batched;
    let tail;
    let earlier;
    let countBeforeDispose;
    let countAfterDispose;

    before(async () => {
      project = await newProject('logs');
      const log = logger.scoped('測試');
      // 掛 sink **之前**先打一條：core 的模組在 import 期就在打日誌了
      // （配置讀取、遷移檢測），那段是排查啟動問題要看的第一段，不能丟。
      log.info('掛載之前打的一條');

      const sub = await db.installLogPersistence(project);

      log.info('第一條', '帶 detail');
      log.error('第二條');
      // 攢批寫入：立刻查是查不到的，等一拍或手動 flush。
      db.flushPendingLogs();
      history = await db.readLogHistory(project, 50);

      // 攢批：多條只寫一次事務，但一條都不能少。
      for (let i = 0; i < 20; i++) {
        log.debug(`批次 ${i}`);
      }
      await sleep(300);
      batched = await db.readLogHistory(project, 100);

      // limit 生效，且取的是最近的那些。
      tail = await db.readLogHistory(project, 5);
      // 翻頁：只取更早的。
      earlier = await db.readLogHistory(project, 5, tail[0].at);

      // ★ 日誌寫庫失敗絕不能再打日誌——那會遞迴刷屏。這裡退訂後再打日誌，
      //   驗證 sink 已經摘乾淨（不再往庫裡寫）。
      sub.dispose();
      countBeforeDispose = (await db.readLogHistory(project, 500)).length;
      log.info('退訂之後的日誌');
      db.flushPendingLogs();
      countAfterDispose = (await db.readLogHistory(project, 500)).length;
    });

    after(() => db.closeDatabase(project));

    test('日誌落進了庫', () => {
      assert.ok(history.length >= 2, String(history.length));
    });

    test('掛載之前的日誌被補寫進來', () => {
      assert.ok(
        history.some((e) => e.message === '掛載之前打的一條'),
        JSON.stringify(history.map((e) => e.message))
      );
    });

    test('按時間正序返回', () => {
      assert.ok(history[0].at <= history[history.length - 1].at);
    });

    test('detail 一併落盤', () => {
      const first = history.find((e) => e.message === '第一條');
      assert.ok(first, '沒找到「第一條」');
      assert.equal(first.detail, '帶 detail', first.detail);
    });

    test('level 原樣保留', () => {
      assert.ok(history.some((e) => e.level === 'error'));
    });

    test('補寫不產生重複條目', () => {
      const dup = history.filter((e) => e.message === '掛載之前打的一條').length;
      assert.equal(dup, 1, String(dup));
    });

    // 歷史條目的 seq 取負：前端按 seq 去重，而庫裡的 seq 是各次程序的
    // 程序內序號，昨天的第 7 條會和今天的第 7 條撞車。
    test('歷史條目的 seq 不與實時序號衝突', () => {
      assert.ok(history.every((e) => e.seq < 0), JSON.stringify(history.map((e) => e.seq)));
    });

    test('攢批寫入不丟條', () => {
      assert.equal(batched.filter((e) => e.message.startsWith('批次')).length, 20);
    });

    test('limit 生效', () => {
      assert.equal(tail.length, 5, String(tail.length));
    });

    test('取的是最近的', () => {
      assert.equal(tail[tail.length - 1].message, '批次 19', tail[tail.length - 1].message);
    });

    test('翻頁只取更早的', () => {
      assert.ok(
        earlier.every((e) => e.at < tail[0].at),
        JSON.stringify(earlier.map((e) => e.at))
      );
    });

    test('退訂後不再寫庫', () => {
      assert.equal(countAfterDispose, countBeforeDispose, `${countBeforeDispose} → ${countAfterDispose}`);
    });
  });

  describe('庫不可用時靜默降級', () => {
    let threw = false;
    let thrown;
    let active;
    let history;
    let tree;
    let warned;

    before(async () => {
      const project = await newProject('broken');
      // 用一個**目錄**佔住庫檔案的位置：SQLite 打不開它，於是走降級路徑。
      const dbFile = path.join(project.root, '.novelwarden', 'novelwarden.db');
      fs.mkdirSync(dbFile, { recursive: true });

      try {
        await errorLog.recordFailure(project, {
          scope: '角色卡',
          targetKind: 'character',
          targetKey: 'x.md',
          severity: 'error',
          op: 'updateCard',
          message: '庫壞了也不能拋',
        });
        await errorLog.clearFailures(project, 'character', 'x.md');
        active = await errorLog.listActiveFailures(project);
        history = await db.readLogHistory(project, 10);
        // 工程頁仍然渲染得出來——這是最要緊的一條：庫壞了不能讓工程頁打不開。
        tree = await projectView.buildProjectTree(project);
      } catch (err) {
        threw = true;
        thrown = err;
      }

      // 開庫失敗只報一次，不該每次呼叫都重試並刷日誌。
      warned = logger
        .recentLogs()
        .filter((e) => e.scope === '資料庫' && e.message.includes('打不開工程資料庫'));
    });

    // ↓ 下面四條沿用原指令碼的語義：它們原本埋在 try 裡，任一 API 拋異常就整段不執行。
    //   這裡保留「不執行」而不是改成失敗——改斷言不是本次遷移該做的決定。
    //   區別只在可見性：拋了的話它們顯示為 skipped，不再偽裝成 pass。
    //   也就是說，這四條只在「一個 API 都沒拋」的前提下才有結論；前提破了它們什麼都不證明，
    //   真正會變紅的是下面那條「庫不可用時一個 API 都不拋」。
    test('庫不可用時查詢返回空', (t) => {
      if (threw) return t.skip(`前置 API 拋了：${thrown && thrown.message}`);
      assert.equal(Object.keys(active).length, 0, JSON.stringify(active));
    });

    test('庫不可用時讀歷史返回空', (t) => {
      if (threw) return t.skip(`前置 API 拋了：${thrown && thrown.message}`);
      assert.equal(history.length, 0);
    });

    test('庫不可用時工程頁照常構建', (t) => {
      if (threw) return t.skip(`前置 API 拋了：${thrown && thrown.message}`);
      assert.equal(tree.initialized, true);
    });

    test('庫不可用時 failures 為空物件', (t) => {
      if (threw) return t.skip(`前置 API 拋了：${thrown && thrown.message}`);
      assert.equal(Object.keys(tree.failures).length, 0);
    });

    test('庫不可用時一個 API 都不拋', () => {
      assert.ok(!threw, thrown && thrown.message);
    });

    test('開庫失敗只 warn 一次', () => {
      assert.equal(warned.length, 1, String(warned.length));
    });

    test('開庫失敗只是 warn 不是 error', () => {
      assert.ok(warned.every((e) => e.level === 'warn'));
    });
  });

  // 改名前的庫是**可丟棄的痕跡**：新庫用新名字，舊檔案原樣留著，絕不順手刪。
  describe('舊庫檔名', () => {
    let project;
    let legacyFile;
    let freshExists;
    let legacyAfter;

    before(async () => {
      project = await newProject('legacy-db');
      legacyFile = path.join(project.root, '.novelwarden', 'novelforge.db');
      fs.writeFileSync(legacyFile, 'SQLite format 3\0舊痕跡');
      await db.openDatabase(project);
      freshExists = fs.existsSync(path.join(project.root, '.novelwarden', 'novelwarden.db'));
      legacyAfter = fs.readFileSync(legacyFile, 'utf8');
      db.closeDatabase(project);
    });

    test('新庫落在 novelwarden.db', () => {
      assert.equal(freshExists, true);
    });

    test('舊的 novelforge.db 一字不動', () => {
      assert.equal(legacyAfter, 'SQLite format 3\0舊痕跡');
    });
  });
});
