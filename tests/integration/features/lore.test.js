/**
 * 設定條目的三件維護（features/lore.ts，設定名錄第三期）：建條目、整合、按目錄整理。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 建條目只讀定稿細綱裡提到它的那幾行，不重讀正文；先報次數 | 從前每跑一次都從第 1 章掃起；第 4 條 |
 * | 「全部建條目」建出現過的全部；建在它的分類目錄裡，記水位與正文指紋 | 出現過就值得建一條 |
 * | 整合只並水位之後、第一處沒定稿的章之前的新事實 | 否則那一章日後定稿，它的事實永遠進不了條目 |
 * | 機器寫的可以直接採納；作者改過的一律先對比 | 第 3 條：不靜默覆蓋 |
 * | 原來有暗設、整合完沒了的，機器寫的也先對比 | 分不清是正文揭開了還是模型漏了（完善設定，第 27 條） |
 * | 關鍵詞只增不減，水位推到能推的地方 | 作者寫的關鍵詞不能被模型拿掉 |
 * | 建條目、整合新收的關鍵詞不收名錄裡另記著的名字 | 收了那個名字就再也建不出自己的條目（舊的整本重掃把幾十個法術並進了「魔法體系」） |
 * | 交回來的解析不了就這一條重來一次，還不行算失敗、名字留在未建條目裡；次數按上限報 | 舊的整本重掃解析不了的直接丟；第 4 條 |
 * | 整理：搬家清單先校驗（認不出的條目、沒建的目錄、太深的目錄不收），作者點頭才搬，內容一字不改 | 作者定案：只搬不改 |
 */
const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelwarden/summaries/${pad3(no)}-第${no}章.md`;

function plotText(no, hash, { lore = '', facts = '', events = '- 有事發生' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(hash ? [`sourceHash: ${hash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 關鍵事件',
    '',
    events,
    '',
    '## 連續性事實',
    '',
    facts || '（待補充）',
    '',
    '## 設定',
    '',
    lore || '（無）',
    '',
  ].join('\n');
}

/** 模型這一次該答什麼，按 system 認。 */
let entryReply;
let organizeReply;
function reply(messages) {
  const system = messages[0]?.content ?? '';
  if (system.includes('把定稿細綱裡關於一個設定的記錄整理成一條設定條目')) {
    return entryReply(messages);
  }
  if (system.includes('負責把設定條目歸進合適的目錄')) {
    return organizeReply(messages);
  }
  return '（認不出這一步）';
}

const ENTRY = (brief, body, keywords = []) => JSON.stringify({ brief, keywords, body });

async function finalizeAll(nos) {
  project.invalidate();
  const chapters = await project.listChapters();
  for (const [no, opts] of nos) {
    const ch = chapters.find((c) => c.order === no);
    t.write(PLOT(no), plotText(no, opts.stale ? 'stale' : ch.contentHash, opts));
  }
  project.invalidate();
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    lore: './src/core/features/lore.ts',
    loreIndex: './src/core/views/lore.ts',
    db: './src/core/runtime/db.ts',
    fs: './src/core/model/fs.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: makeSettings({ concurrency: 1 }) });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply });
  t = await makeTempProject(bundle.project, { prefix: 'loreMaintain', title: '設定維護' });
  project = t.project;
  for (let no = 1; no <= 5; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  // 第 1–3 章定稿；第 4 章定稿之後正文又改過（整合停在它前面）；第 5 章定稿。
  await finalizeAll([
    [1, { lore: '- 停舟客棧〔地域/青崖〕：鎮上唯一的客棧\n- 後山〔地域〕', events: '- 林昭住進停舟客棧。' }],
    [2, { lore: '- 停舟客棧〔地域〕\n- 青崖鎮〔地域〕：鎮口設卡', facts: '- 停舟客棧的二樓被燒了' }],
    [3, { lore: '- 青崖鎮：七年前大火' }],
    [4, { lore: '- 青崖鎮：城門重修', stale: true }],
    [5, { lore: '- 青崖鎮：新來了守軍\n- 城隍廟〔地域〕：鎮北的廟' }],
  ]);
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('建條目', () => {
  before(async () => {
    entryReply = (messages) => {
      const user = messages[1].content;
      return user.includes('設定：停舟客棧')
        ? ENTRY('鎮上唯一的客棧', '## 概要\n\n鎮上唯一的客棧。\n\n## 規則與邊界\n\n（未交代）\n\n## 現狀\n\n二樓被燒了。', ['停舟', '青崖鎮', '後山'])
        : ENTRY('鎮外的後山', '## 概要\n\n鎮外的後山。');
    };
    fake.reset();
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project);
  });

  // 出現過、還沒建條目的：停舟客棧（第 1、2 章）、青崖鎮（第 2–5 章）、後山（第 1 章）、城隍廟（第 5 章），全建。
  // 2026-10-25 起改成轉寫：每條寫 1 次、轉寫 1 次，轉寫不合格重轉 1 次，還整理不出來重寫一次——一條最多 6 次。
  // 假模型直接給 JSON，不轉寫，實際一條 1 次。
  test('先報次數：出現過的全部建，每條寫 1 次、轉寫 1 次，整理不出來的重寫一次', () => {
    const c = h.confirms[h.confirms.length - 1];
    assert.match(
      c.message,
      /^建 4 條設定：預計 8 次呼叫，最多 24 次（寫 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次，還整理不出來這一條重寫 1 次、再轉）。只讀同步過的細綱裡提到它們的那幾行，不重讀正文。/
    );
    assert.match(c.detail, /要建的：/);
    assert.equal(fake.callCount(), 4);
  });

  test('原料是定稿細綱裡的記錄：「設定」一節那一句、連續性事實、提到它的句子，帶章號', () => {
    const user = fake.calls.map((c) => c[1].content).find((u) => u.includes('設定：停舟客棧'));
    assert.ok(user.includes('設定：停舟客棧\n分類：地域/青崖'), user);
    assert.ok(user.includes('- 第 1 章：鎮上唯一的客棧'), user);
    assert.ok(user.includes('- 第 1 章：林昭住進停舟客棧。'), user);
    assert.ok(user.includes('- 第 2 章：停舟客棧的二樓被燒了'), user);
    assert.ok(!user.includes('第1章的正文'), '不讀正文');
  });

  test('建在它的分類目錄裡，帶一句話、關鍵詞、水位與正文指紋', async () => {
    project.invalidate();
    const inn = (await project.listLore()).find((e) => e.title === '停舟客棧');
    assert.equal(inn.relPath, '.novelwarden/lore/地域/青崖/停舟客棧.md');
    assert.equal(inn.brief, '鎮上唯一的客棧');
    // 模型把同一批建的「青崖鎮」也寫成了關鍵詞：別的條目的標題不收（會把那一條的命中搶過來）。
    // 「後山」也在同一批：名錄裡另記著的名字不收關鍵詞（recorded），否則它永遠建不出自己的條目。
    assert.deepEqual(inn.keywords, ['停舟客棧', '停舟']);
    // 第 4 章定稿之後正文又改過：水位停在第 3 章。
    assert.equal(inn.updatedThrough, 3);
    assert.ok(bundle.lore.loreOwnedByMachine(inn));
  });

  test('給了名字就只建那一條', async () => {
    // 批次建完後追加一章定稿細綱，讓名錄裡出現一個新的未建條目。
    project.invalidate();
    const ch6hash = (await project.listChapters()).find((c) => c.order === 5)?.contentHash ?? 'x';
    t.write(CH(6), `# 第6章\n\n第6章的正文。\n`);
    project.invalidate();
    const ch6 = (await project.listChapters()).find((c) => c.order === 6);
    t.write(PLOT(6), plotText(6, ch6.contentHash, { lore: '- 鐵匠鋪〔地域〕：鎮西的鋪子' }));
    project.invalidate();
    fake.reset();
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project, ['鐵匠鋪']);
    project.invalidate();
    assert.ok((await project.listLore()).some((e) => e.title === '鐵匠鋪'));
    assert.equal(fake.callCount(), 1);
  });
});

describe('整合', () => {
  before(async () => {
    t.write(
      '.novelwarden/lore/地域/青崖鎮.md',
      '---\ntitle: 青崖鎮\nkeywords: [青崖]\nupdatedThrough: 2\n---\n\n# 青崖鎮\n\n作者寫的：偏僻小鎮。\n'
    );
    project.invalidate();
  });

  test('作者改過的條目：只能逐條確認；新事實只到第一處沒定稿的章之前', async () => {
    entryReply = () =>
      ENTRY('偏僻小鎮', '## 概要\n\n偏僻小鎮。\n\n## 現狀\n\n七年前遭過大火。', ['青崖鎮', '鎮子', '城隍廟']);
    fake.reset();
    h.expect('逐條確認後開始');
    await bundle.lore.integrateLore(project, ['.novelwarden/lore/地域/青崖鎮.md']);
    const c = h.confirms[h.confirms.length - 1];
    assert.deepEqual(c.actions, ['逐條確認後開始']);
    assert.match(c.detail, /其中 1 條你改過/);
    assert.equal(h.reviewed.length, 1, '作者改過的先給對比');
    const user = fake.calls[0][1].content;
    assert.ok(user.includes('作者寫的：偏僻小鎮。'), user);
    assert.ok(user.includes('- 第 3 章：七年前大火'), user);
    assert.ok(!user.includes('城門重修') && !user.includes('新來了守軍'), '第 4 章沒同步，它和它之後的都不併');
  });

  test('採納後：關鍵詞只增不減，水位到第 3 章，正文換成機器寫的並蓋上指紋', async () => {
    project.invalidate();
    const town = (await project.listLore()).find((e) => e.title === '青崖鎮');
    // 作者寫的「青崖」原樣留著；模型給的「青崖鎮」就是標題（匹配時本來就認標題），不重複收；
    // 「城隍廟」是第 5 章單獨記下、還沒建條目的名字，不收。
    assert.deepEqual(town.keywords, ['青崖', '鎮子']);
    assert.equal(town.updatedThrough, 3);
    assert.ok(town.body.includes('七年前遭過大火'));
    assert.ok(bundle.lore.loreOwnedByMachine(town));
  });

  test('沒有新內容可並時說清楚停在哪一章', async () => {
    fake.reset();
    h.toasts.length = 0;
    await bundle.lore.integrateLore(project, ['.novelwarden/lore/地域/青崖鎮.md']);
    assert.equal(fake.callCount(), 0);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /第 4 章還沒同步/);
  });

  // 完善設定（2026-10-19）：分不清是正文全揭開了還是模型漏了，暗設不能悄悄沒了。
  describe('原來有暗設的機器寫條目', () => {
    const INN = '.novelwarden/lore/地域/青崖/停舟客棧.md';
    const BODY = '## 概要\n\n鎮上唯一的客棧。\n\n## 暗設\n\n掌櫃是前朝暗衛。';
    beforeEach(() => {
      t.write(
        INN,
        `---\ntitle: 停舟客棧\nkeywords: [停舟]\nupdatedThrough: 0\nbodyHash: ${bundle.fs.hash(BODY)}\n---\n\n# 停舟客棧\n\n${BODY}\n`
      );
      project.invalidate();
    });

    test('整合完暗設一句都沒了：選了直接採納也先給對比', async () => {
      entryReply = () => ENTRY('鎮上唯一的客棧', '## 概要\n\n鎮上唯一的客棧。\n\n## 現狀\n\n二樓被燒了。');
      fake.reset();
      h.expect('機器寫的直接採納並開始');
      await bundle.lore.integrateLore(project, [INN]);
      assert.equal(h.reviewed.length, 1, '暗設沒了，先對比');
    });

    test('暗設還在：照作者選的直接採納', async () => {
      entryReply = () =>
        ENTRY('鎮上唯一的客棧', '## 概要\n\n鎮上唯一的客棧。\n\n## 現狀\n\n二樓被燒了。\n\n## 暗設\n\n掌櫃是前朝暗衛。');
      fake.reset();
      h.expect('機器寫的直接採納並開始');
      await bundle.lore.integrateLore(project, [INN]);
      assert.equal(h.reviewed.length, 0);
      project.invalidate();
      const inn = (await project.listLore()).find((e) => e.relPath === INN);
      assert.ok(inn.body.includes('掌櫃是前朝暗衛'));
    });
  });
});

describe('按目錄整理', () => {
  test('校驗搬家清單：認不出的條目、沒建的目錄、太深的目錄不收，位置沒變的去掉', () => {
    const batch = [
      { slug: '過所', relPath: '.novelwarden/lore/過所.md', title: '過所', category: '' },
      { slug: '地域/後山', relPath: '.novelwarden/lore/地域/後山.md', title: '後山', category: '地域' },
    ];
    const plan = bundle.lore.checkOrganizePlan(
      JSON.stringify({
        folders: ['制度', 'a/b/c/d'],
        moves: [
          { from: '過所', to: '制度' },
          { from: '後山', to: '地域' },
          { from: '不存在的', to: '制度' },
          { from: '.novelwarden/lore/地域/後山.md', to: '地點' },
        ],
      }),
      batch,
      ['地域']
    );
    assert.deepEqual(plan.folders, ['制度']);
    assert.deepEqual(plan.moves, [{ from: '.novelwarden/lore/過所.md', category: '', to: '制度', title: '過所' }]);
    assert.equal(plan.dropped.length, 3, plan.dropped.join('\n'));
  });

  test('先報次數，出清單給作者看，點頭了才搬；只搬檔案，內容一字不改', async () => {
    t.write('.novelwarden/lore/過所.md', '---\ntitle: 過所\nkeywords: [過所]\n---\n\n# 過所\n\n出入憑證。\n');
    project.invalidate();
    const before = fs.readFileSync(t.rel('.novelwarden/lore/過所.md'), 'utf8');
    organizeReply = () => JSON.stringify({ folders: ['制度'], moves: [{ from: '過所', to: '制度' }] });
    fake.reset();
    h.expect('開始', '照這樣整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    const [go, plan] = h.confirms.slice(-2);
    assert.match(go.message, /整理 1 條設定：分 1 批，預計 2 次呼叫，最多 3 次（寫 1 次、轉寫模型照抄成 JSON 1 次/);
    assert.match(plan.message, /搬 1 條設定，新建 1 個目錄。只搬檔案，條目內容一個字不改。/);
    assert.match(plan.detail, /過所：未分類 → 制度/);
    assert.ok(!t.has('.novelwarden/lore/過所.md'));
    assert.equal(fs.readFileSync(t.rel('.novelwarden/lore/制度/過所.md'), 'utf8'), before);
  });

  test('作者沒點頭就一個都不搬', async () => {
    t.write('.novelwarden/lore/黑市.md', '---\ntitle: 黑市\nkeywords: []\n---\n\n# 黑市\n\n地下交易。\n');
    project.invalidate();
    organizeReply = () => JSON.stringify({ folders: [], moves: [{ from: '黑市', to: '地域' }] });
    fake.reset();
    h.expect('開始', undefined);
    await bundle.lore.organizeLore(project, 'unfiled');
    assert.ok(t.has('.novelwarden/lore/黑市.md'));
  });

  // 從前搬家之前先直接 `fs.mkdir` 建出清單上的新目錄（繞過閘道器，第 7 條）；`ws.move` 落盤前本來就會補齊父目錄，
  // 那一步唯一的效果是：搬不成的時候留下一個空目錄。現在新目錄只在真有條目搬進去時由閘道器建出來。
  test('搬不成就不留下空目錄：新目錄由搬家時經閘道器補齊，不先建', async () => {
    t.write('.novelwarden/lore/令牌.md', '---\ntitle: 令牌\nkeywords: []\n---\n\n# 令牌\n\n出入用。\n');
    project.invalidate();
    // 模型答完清單、作者點頭之前，這一條被作者在別處刪了：搬家必然失敗。
    organizeReply = () => {
      fs.rmSync(t.rel('.novelwarden/lore/令牌.md'));
      return JSON.stringify({ folders: ['信物'], moves: [{ from: '令牌', to: '信物' }] });
    };
    fake.reset();
    h.expect('開始', '照這樣整理');
    await bundle.lore.organizeLore(project, 'unfiled');
    const plan = h.confirms.at(-1);
    assert.match(plan.message, /新建 1 個目錄/);
    assert.equal(t.has('.novelwarden/lore/信物'), false);
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /1 條沒搬/);
  });
});

describe('模型返回解析不了', () => {
  before(async () => {
    t.write(CH(6), '# 第6章\n\n第6章的正文。\n');
    await finalizeAll([[6, { lore: '- 黑水渡〔地域〕：鎮外的渡口\n- 鬼市〔地域〕：夜裡才開' }]]);
  });

  // 沒照格式寫的（連「概要」都沒有）不花轉寫那一次，直接重寫。
  test('這一條重寫一次，第二次解得出來就照常建', async () => {
    let n = 0;
    entryReply = () => (++n === 1 ? '這不是 JSON' : ENTRY('鎮外的渡口', '## 概要\n\n鎮外的渡口。'));
    fake.reset();
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project, ['黑水渡']);
    assert.match(h.confirms[h.confirms.length - 1].message, /^建 1 條設定：預計 2 次呼叫，最多 6 次/);
    assert.equal(fake.callCount(), 2);
    project.invalidate();
    assert.ok((await project.listLore()).some((e) => e.title === '黑水渡'));
  });

  test('重來還不行才算失敗：不建，名字留在「出現過 · 未建條目」裡，下次還能建', async () => {
    entryReply = () => '還是不是 JSON';
    fake.reset();
    h.toasts.length = 0;
    h.expect('開始建');
    await bundle.lore.buildLoreEntries(project, ['鬼市']);
    assert.equal(fake.callCount(), 2, '寫兩輪，沒照格式寫的不轉寫');
    assert.match(h.toasts.map((x) => x.message ?? x).join('\n'), /新建 0 條設定，失敗 1 條/);
    project.invalidate();
    assert.ok(!(await project.listLore()).some((e) => e.title === '鬼市'));
    assert.ok((await bundle.loreIndex.buildLoreIndex(project)).unknown.some((u) => u.name === '鬼市'));
  });
});
