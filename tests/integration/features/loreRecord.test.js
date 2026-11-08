/**
 * 記設定（設定名錄，2026-10-18）：定稿時順手記進細綱的「設定」一節，另外允許單獨記一章、補記老章節。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 定稿那一次的提示裡有本書的分類表與這一章提到的已有設定 | 分類每本書自己定；同一個東西照抄已有名字 |
 * | 定稿不多調：設定並進第一步 | 作者定案 1：並進定稿，+0 次 |
 * | 寫進「設定」一節前校驗：名字不在正文裡的丟、人名丟、已有條目換成標題與目錄、說明沒依據的清空 | 「設定」一節是名錄的唯一來源，模型編的名字會變成憑空的「未建條目」 |
 * | 「設定」一節不進內容指紋：定稿、補記之後正文都不掛 ⟳ | 補記老章節不能把它們全掛上 ⟳ |
 * | 單獨記一章：先報 1 次、只換「設定」一節，另外七節一字不動 | 作者定案 1：允許單獨呼叫；第 4 條 |
 * | 補記只挑定稿過、正文沒再改過、還沒記過的章，序列 | 第 4 條：沒定稿的不偷偷補 |
 * | 沒定稿的章不讓單獨記 | 「設定」一節是計劃，記了也會被定稿沖掉 |
 * | 解析不出來：「設定」一節不動，掛黃 ❗ | 第 16 條 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const TEXT = [
  '雨下了一整夜。林昭進了青崖鎮，鎮口的守衛查驗過所。',
  '停舟客棧是鎮上唯一的客棧，二層木樓，地板踩上去會響。',
  '沈氏在櫃檯後看著他，沒說話。她把那塊殘令收進了袖中。',
].join('\n\n');

const CH = (no) => `chapters/00${no}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/00${no}-第${no}章.md`;

/** 定稿那一次的回答（JSON）。 */
const SUMMARY = {
  梗概: '林昭進了青崖鎮，住進停舟客棧。',
  出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
  时间地点: '青崖鎮，夜。',
  关键事件: ['進鎮', '住店'],
  状态变更: '',
  连续性事实: ['沈氏把殘令收進袖中'],
  设定: [
    { name: '青崖', category: '地點', fact: '' },
    { name: '停舟客棧', category: '地域/青崖', fact: '鎮上唯一的客棧，二層木樓' },
    { name: '過所', category: '制度', fact: '出入城鎮要交十兩銀子' },
    { name: '黑市', category: '地點', fact: '' },
    { name: '林昭', category: '人物', fact: '' },
  ],
};

let recordReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('建立可檢索的章節檔案')) {
    return JSON.stringify(SUMMARY);
  }
  if (system.includes('負責記下這一章正文裡出現了哪些設定')) {
    return recordReply();
  }
  // 故事時間（同步時單獨一次，2026-10-24 重做）：都緊接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（認不出這一步）';
}

async function chapterNo(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    finalize: './src/core/features/finalize.ts',
    loreRecord: './src/core/features/loreRecord.ts',
    plotFile: './src/core/model/plotFile.ts',
    pipeline: './src/core/views/pipeline.ts',
    db: './src/core/runtime/db.ts',
    errorLog: './src/core/runtime/errorLog.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: makeSettings({ contextWindow: 16000, maxOutputTokens: 1000 }) });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'loreRecord', title: '記設定測試' });
  project = t.project;
  for (const no of [1, 2, 3]) {
    t.write(CH(no), `# 第${no}章\n\n${TEXT}\n`);
  }
  t.write('.novelwarden/lore/地域/青崖镇.md', '---\ntitle: 青崖鎮\nkeywords: [青崖]\n---\n\n# 青崖鎮\n\n偏僻小鎮。\n');
  t.write('.novelwarden/lore/信物/崖字令牌.md', '---\ntitle: 崖字令牌\nkeywords: [令牌]\n---\n\n# 崖字令牌\n\n木牌。\n');
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('定稿時順手記', () => {
  let outcome;
  let plot;
  let user;

  before(async () => {
    fake.reset();
    outcome = await bundle.finalize.finalizeChapter(project, await chapterNo(2));
    user = fake.calls[0][1].content;
    project.invalidate();
    plot = await project.getPlot(2);
  });

  // 記設定不另調：沒有角色卡時只有更新細綱那 1 次，加敘事線認事件那 1 次（敘事線重做：每次定稿都認）、故事時間那 1 次。
  test('不多調：記設定並在更新細綱那一次裡，沒有角色卡時一共 3 次（細綱 + 認敘事線 + 故事時間）', () => {
    assert.equal(fake.callCount(), 3);
    assert.equal(outcome.calls, 3);
  });

  test('提示裡有本書的分類表，與這一章正文裡提到的已有設定', () => {
    assert.ok(user.includes('本書的設定分類：地域、信物。'), user.slice(0, 600));
    assert.ok(user.includes('已有設定（本章正文裡提到的；同一個東西請照抄這裡的名字）：青崖鎮〔地域〕（也叫 青崖）。'), user.slice(0, 600));
    assert.ok(!user.includes('崖字令牌'), '正文裡沒提到的不列');
  });

  test('「設定」一節：名字不在正文裡的、人名丟掉；已有條目換成標題與實際目錄；沒依據的說明清空', () => {
    assert.deepEqual(plot.lore, [
      { name: '青崖鎮', category: '地域', note: '' },
      { name: '停舟客棧', category: '地域/青崖', note: '鎮上唯一的客棧，二層木樓' },
      { name: '過所', category: '制度', note: '' },
    ]);
  });

  test('「設定」一節不進內容指紋：定稿剛寫完，正文不掛 ⟳', async () => {
    const row = (await bundle.pipeline.buildPipelineIndex(project)).rows.find((r) => r.no === 2);
    assert.equal(row.chapter.upstreamStale, false);
    assert.equal(row.summary.stale, false);
  });
});

describe('單獨記一章', () => {
  let before2;
  before(async () => {
    before2 = t.read(PLOT(2));
    recordReply = () =>
      JSON.stringify({ 设定: [{ name: '崖字令牌', category: '信物', fact: '' }, { name: '殘令', category: '信物', fact: '' }] });
    fake.reset();
    h.expect('開始記');
    await bundle.loreRecord.recordLore(project, CH(2));
  });

  // 2026-10-25 起改成轉寫：寫 1 次、轉寫 1 次；假模型直接給 JSON，不轉寫，實際 1 次。
  test('先報次數：寫 1 次、轉寫 1 次，只換「設定」一節', () => {
    const c = h.confirms[0];
    assert.match(c.message, /讀第 2 章正文，預計 2 次呼叫，最多 3 次（寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次）。只換掉這一章細綱的「設定」一節/);
    assert.equal(fake.callCount(), 1);
  });

  test('只換「設定」一節，另外七節與 frontmatter 一字不動', () => {
    const after2 = t.read(PLOT(2));
    const cut = (s) => s.slice(0, s.indexOf('## 設定'));
    assert.equal(cut(after2), cut(before2));
    // 令牌不在正文裡（只有「殘令」），丟掉。
    assert.match(after2, /## 設定\n\n- 殘令〔信物〕\n?$/);
  });

  test('沒定稿的章不讓單獨記', async () => {
    h.toasts.length = 0;
    fake.reset();
    await bundle.loreRecord.recordLore(project, CH(3));
    assert.equal(fake.callCount(), 0);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /第 3 章還沒同步/);
  });
});

describe('補記', () => {
  before(async () => {
    // 第 1 章：功能上線之前定稿的（沒有「設定」一節）；第 3 章：定稿過但正文後來又改了。
    const ch1 = await chapterNo(1);
    t.write(
      PLOT(1),
      `---\nno: 1\ntitle: 第1章\nsourceHash: ${ch1.contentHash}\n---\n\n# 第1章 第1章\n\n## 關鍵事件\n\n- 進鎮\n`
    );
    t.write(PLOT(3), '---\nno: 3\ntitle: 第3章\nsourceHash: 0000\n---\n\n# 第3章 第3章\n\n## 關鍵事件\n\n- 進鎮\n');
    project.invalidate();
  });

  test('只挑定稿過、正文沒再改過、還沒記過的章；改過的說出來', async () => {
    recordReply = () => JSON.stringify({ 设定: [{ name: '停舟客棧', category: '地域', fact: '' }] });
    fake.reset();
    h.expect('開始記');
    await bundle.loreRecord.recordLore(project);
    const c = h.confirms[h.confirms.length - 1];
    assert.match(c.message, /讀1 章正文，預計 2 次呼叫，最多 3 次/);
    assert.match(c.detail, /另有 1 章同步之後正文又改過，這次不記/);
    assert.equal(fake.callCount(), 1);
    project.invalidate();
    assert.deepEqual((await project.getPlot(1)).lore, [{ name: '停舟客棧', category: '地域', note: '' }]);
    assert.equal((await project.getPlot(3)).lore, undefined);
  });

  test('解析不出來：「設定」一節不動，掛黃 ❗', async () => {
    t.write(PLOT(1), t.read(PLOT(1)).replace(/\n## 設定[\s\S]*$/, '\n'));
    project.invalidate();
    recordReply = () => '不是 JSON';
    fake.reset();
    h.expect('開始記');
    await bundle.loreRecord.recordLore(project);
    project.invalidate();
    assert.equal((await project.getPlot(1)).lore, undefined);
    const failures = (await bundle.errorLog.listActiveFailures(project))[CH(1)] ?? [];
    assert.ok(failures.some((f) => f.op === 'loreRecord' && f.severity === 'warn'), JSON.stringify(failures));
  });
});
