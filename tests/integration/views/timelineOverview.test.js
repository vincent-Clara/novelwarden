/**
 * 編輯區「時間線總覽」的資料（`views/threads.ts` 的 `buildTimelineOverview`，2026-10-24），真臨時工程：讀時間線與敘事線、章節與細綱
 * 兩份列表，交給純函式 `buildTimelineMatrix`（那一半的細節在 tests/unit/views/timeline.test.js）。
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | 卡片 | 章名（細綱優先）、正文 / 細綱路徑（細綱按路徑配對）、細綱的梗概與時間地點、這一章在敘事線上的實際事件 |
 * | 補推 | 「同步過」與工程頁同一個口徑（細綱有 `sourceHash`、正文還在）：寫了沒同步的章不算還沒推 |
 * | 還不是小說工程 | `initialized: false`，其餘都是空的 |
 * | 不寫盤 | 讀完之後工程目錄一個位元組沒變 |
 * | controller | `requestTimelineOverview` 回 `timelineOverview`，帶同一個 `requestId` |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title, { hash = '', synopsis = '梗概', timePlace = '' } = {}) =>
  `---\nno: ${no}\ntitle: ${title}\n${hash ? `sourceHash: ${hash}\n` : ''}---\n\n# ${title}\n\n## 梗概\n${synopsis}\n\n## 時間地點\n${timePlace}\n\n## 關鍵事件\n事件\n`;

/** 工程目錄下全部檔案的「路徑 → 內容」（看讀完之後有沒有寫盤）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (!/\.(db|sqlite)(-\w+)?$/.test(ent.name)) {
        out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    threads: './src/core/views/threads.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'timeline-overview', title: '青雲劍錄' });
  project = t.project;

  // 第 1、2 章同步過（第 2 章在第一卷裡，細綱的標題優先）；第 3 章同步過、時間線裡還沒有；第 4 章寫了沒同步。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelwarden/summaries/001-楔子.md', plot(1, '楔子', { hash: 'abc', synopsis: '林昭在雨夜進了青崖鎮。', timePlace: '傍晚，青崖鎮' }));
  t.write('chapters/第一卷/002-入鎮.md', '# 入鎮\n\n次日他走進鎮子。');
  t.write('.novelwarden/summaries/第一卷/002-入鎮.md', plot(2, '入鎮（改）', { hash: 'def' }));
  t.write('chapters/第一卷/003-夜访.md', '# 夜訪\n\n夜裡有人敲門。');
  t.write('.novelwarden/summaries/第一卷/003-夜访.md', plot(3, '夜訪', { hash: 'ghi' }));
  t.write('chapters/第一卷/004-北行.txt', '他往北走。');

  t.write('.novelwarden/threads/青崖舊案.md', '---\nkind: 主線\n---\n\n# 青崖舊案\n\n## 進展\n- 第 2 章 · 推進：找到令牌 〔證據：「令牌」〕\n- 第 3 章 · 計劃 · 推進：夜探\n');
  t.write(
    '.novelwarden/threads/时间线.md',
    ['---', 'calendar: 簡單歷', 'start: 大衍三年三月初七', '---', '', '# 時間線', '', '- 第 1 章：+0 天，傍晚〔依據：「雨下了三天」〕', '- 第 2 章：+1 天〔依據：「次日」〕', ''].join('\n')
  );
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/threads › buildTimelineOverview', () => {
  test('卡片：章名、正文與細綱路徑、梗概（沒有事件時）與時間地點、實際事件；軸按日子', async () => {
    const o = await bundle.threads.buildTimelineOverview(project);
    assert.equal(o.initialized, true);
    assert.equal(o.exists, true);
    assert.equal(o.relPath, '.novelwarden/threads/时间线.md');
    assert.deepEqual(o.days.map((d) => [d.day, d.label, d.month, d.cards.map((c) => c.no)]), [
      [1, '三月初七', '大衍三年三月', [1]],
      [2, '三月初八', '大衍三年三月', [2]],
    ]);
    const [c1, c2] = o.days.map((d) => d.cards[0]);
    assert.deepEqual([c1.title, c1.chapterPath, c1.plotPath, c1.synopsis], ['楔子', 'chapters/001-楔子.md', '.novelwarden/summaries/001-楔子.md', '林昭在雨夜進了青崖鎮。']);
    assert.ok(c1.detail.includes('細綱寫的時間地點：傍晚，青崖鎮'), c1.detail.join('\n'));
    assert.equal(c2.title, '入鎮（改）');
    assert.equal(c2.plotPath, '.novelwarden/summaries/第一卷/002-入鎮.md');
    assert.deepEqual(c2.events, [{ thread: '青崖舊案', color: 0, type: '推进', what: '找到令牌', evidence: '令牌' }]);
    assert.equal(c2.synopsis, undefined);
    assert.deepEqual(o.threads, [{ name: '青崖舊案', color: 0 }]);
  });

  test('補推：同步過的才算（第 3 章），寫了沒同步的（第 4 章）不算', async () => {
    const o = await bundle.threads.buildTimelineOverview(project);
    assert.deepEqual(o.missing, { count: 1, text: '第 3 章還沒推出來' });
    assert.equal(o.meta, '簡單歷 · 起點 大衍三年三月初七 · 推到第 2 章 · 故事第 2 天（大衍三年三月初八）');
  });

  test('不寫盤：讀完之後工程目錄一個位元組沒變', async () => {
    const before = snapshot(t.dir);
    await bundle.threads.buildTimelineOverview(project);
    assert.deepEqual(snapshot(t.dir), before);
  });

  test('還不是小說工程：initialized 為 false，其餘都是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-timeline-overview-bare-'));
    try {
      const o = await bundle.threads.buildTimelineOverview(bundle.project.NovelProject.open(dir));
      assert.deepEqual([o.initialized, o.exists, o.days, o.issues, o.threads], [false, false, [], [], []]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestTimelineOverview', () => {
  test('回 timelineOverview，帶同一個 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestTimelineOverview', requestId: 'tlo-1' });
      const reply = posted.find((m) => m.type === 'timelineOverview');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'tlo-1');
      assert.equal(reply.overview.initialized, true);
      assert.equal(reply.overview.days.length, 2);
    } finally {
      controller.dispose();
    }
  });
});
