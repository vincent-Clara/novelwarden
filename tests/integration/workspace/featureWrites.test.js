/**
 * 功能層裡從前繞過閘道器、直接 `writeText` 的幾處，改走 `workspace.write` 之後（AGENTS 第 7 條）：
 *
 * - **覆蓋之前舊內容進歷史版本**（`.novelwarden/history/`）：作者手寫的角色卡、改名前的正文被換掉之後找得回來（第 3 條）；
 * - **審閱只問一次**：功能自己彈過審閱（或作者在確認框裡選了「全部直接採納」），寫盤時傳 `review: false`，閘道器不再問第二次；
 * - **新建設定條目同名不覆蓋**：已有的條目原樣留著，新的加序號；
 * - **章節改名時同步 `# 標題` 行不碰細綱的 `writtenFrom`**：掛著 ⟳ 的章改名之後照樣掛著、沒掛的照樣不掛（第 18 條）；
 * - **改名搬不成時正文不能被悄悄改掉**（第 3 條）：新名字被佔用就在寫標題之前停下；寫完標題之後搬家才失敗（競態）就改回原樣，
 *   改不回去照實說。
 *
 * 每張卡只在一節裡被第一次覆蓋：歷史版本的節流（10 分鐘內的小改併成一版）只在「第一次」上沒有歧義。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
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

const settings = makeSettings();

/** 閘道器自己那張覆蓋確認的問法（`guard.ts` 的 `reviewOverwrite`）：功能層問過之後不該再出現。 */
const GATE_ASK = '已經有內容了，用新版本覆蓋？';

function cardJson(overrides) {
  return JSON.stringify({
    aliases: [],
    tags: [],
    身份: '模型寫的身份',
    外貌: '',
    性格: '模型寫的性格',
    语言习惯: '',
    人物关系: '',
    当前状态: '',
    暗设: '',
    ...overrides,
  });
}

const authorCard = (name) =>
  `---\nname: ${name}\naliases: []\ntags: []\n---\n\n# ${name}\n\n## 身份\n\n作者親手寫的${name}的身份，一個字都不能丟。\n`;

/** 一章正文 + 一份定稿過的細綱：出場統計只認定稿過的（第 14 條）。 */
function makeChapter(no, title, cast) {
  const stem = `${String(no).padStart(3, '0')}-${title}`;
  t.write(`chapters/${stem}.md`, `# ${title}\n\n${'雨下了三天，石板路泡得發白。'.repeat(20)}\n`);
  t.write(
    `.novelwarden/summaries/${stem}.md`,
    `---\nno: ${no}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n# 第${no}章 ${title}\n\n` +
      `## 梗概\n\n略。\n\n## 出場人物\n\n${cast.join('、')}\n\n## 關鍵事件\n\n甲乙丙。\n`
  );
}

/** 這份檔案的快照檔名，新的在前。 */
function snaps(rel) {
  const dir = t.rel('.novelwarden/history', rel);
  return fs.existsSync(dir) ? bundle.history.sortSnapshotNames(fs.readdirSync(dir)) : [];
}

const snapTexts = (rel) => snaps(rel).map((name) => fs.readFileSync(t.rel('.novelwarden/history', rel, name), 'utf8'));

/** 正文掛不掛 ⟳：與工程頁同一個判據（`views/pipeline.ts`：細綱的 `writtenFrom` 記過、而且對不上內容指紋）。 */
async function staleOf(no) {
  project.invalidate();
  const plot = await project.getPlot(no);
  return (await bundle.pipe.buildPlotPipeline(project, { no, plot })).chapter.upstreamStale;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    history: './src/core/workspace/history.ts',
    characterCard: './src/core/features/characterCard.ts',
    characters: './src/core/features/characters.ts',
    fileOps: './src/core/files/fileOps.ts',
    pipe: './src/core/views/pipeline.ts',
    registry: './src/core/llm/registry.ts',
    logger: './src/core/runtime/logger.ts',
    // 更新角色卡會記 / 清失敗標記，落進工程庫；收尾要先關庫。
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { repeatLast: true, fallback: cardJson() });

  t = await makeTempProject(bundle.project, { prefix: 'featwrites', title: '功能層寫盤' });
  project = t.project;
  makeChapter(1, '楔子', ['林昭', '沈氏', '老周']);
  makeChapter(2, '入鎮', ['林昭', '老周']);
  makeChapter(3, '夜談', ['沈氏', '韓七']);
  for (const name of ['林昭', '沈氏', '老周', '阿蘅']) {
    t.write(`.novelwarden/characters/${name}.md`, authorCard(name));
  }
  // 副檔名大寫的卡：角色區認它（`.md` 不分大小寫），寫回去得還是這一份。
  t.write('.novelwarden/characters/韓七.MD', authorCard('韓七'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('更新角色卡：作者在 diff 審閱裡點了採納', () => {
  const CARD = '.novelwarden/characters/林昭.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    h.expect('開始');
    fake.reset([cardJson({ 身份: '林昭：模型寫的身份' })]);
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('寫進了模型給的新版', () => {
    assert.match(written, /林昭：模型寫的身份/);
  });

  test('作者手寫的舊版在歷史版本裡留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('審閱只彈一次，是功能自己那張（不請求合併）；閘道器沒有再問', () => {
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].merge, false);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('完成提示照舊', () => {
    assert.ok(toasts.some((x) => x.includes('「林昭」已更新，覆蓋至第 2 章')), toasts.join(' | '));
  });
});

describe('更新角色卡：審閱裡放棄', () => {
  const CARD = '.novelwarden/characters/林昭.md';
  let before_;
  let after_;
  let snapCount;

  before(async () => {
    before_ = t.read(CARD);
    h.setReviewVerdict('discard');
    try {
      h.expect('開始');
      fake.reset([cardJson({ 身份: '不該寫進去' })]);
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      h.setReviewVerdict('apply');
    }
    after_ = t.read(CARD);
    snapCount = snaps(CARD).length;
  });

  test('卡一個字不動', () => {
    assert.equal(after_, before_);
  });

  test('沒寫就不多存一版歷史', () => {
    assert.equal(snapCount, 1);
  });
});

describe('更新角色卡：宿主沒有 diff 審閱，退回確認框', () => {
  const CARD = '.novelwarden/characters/老周.md';
  let original;
  let written;
  let confirms;

  before(async () => {
    original = t.read(CARD);
    const saved = h.host.reviewReplace;
    h.host.reviewReplace = undefined;
    try {
      // 只排兩個答案：閘道器要是再問一次覆蓋，就沒有答案可取，等於作者取消——卡不會被寫。
      h.expect('開始', '採納');
      fake.reset([cardJson({ 身份: '老周：模型寫的身份' })]);
      await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    } finally {
      h.host.reviewReplace = saved;
    }
    written = t.read(CARD);
    confirms = h.confirms.map((c) => c.message);
  });

  test('只問了一次「採納？」，閘道器沒有再彈覆蓋確認', () => {
    assert.equal(confirms.filter((m) => m.includes('的新版角色卡。採納？')).length, 1, confirms.join(' | '));
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('寫進了新版，舊版進了歷史', () => {
    assert.match(written, /老周：模型寫的身份/);
    assert.deepEqual(snapTexts(CARD), [original]);
  });
});

describe('更新角色卡：副檔名大寫的卡寫回原檔案', () => {
  const CARD = '.novelwarden/characters/韓七.MD';
  let original;
  let written;
  let siblings;

  before(async () => {
    original = t.read(CARD);
    h.expect('開始');
    fake.reset([cardJson({ 身份: '韓七：模型寫的身份' })]);
    await bundle.characterCard.updateCharacterCard(project, CARD, 'full');
    written = t.read(CARD);
    siblings = fs.readdirSync(t.rel('.novelwarden/characters')).filter((n) => n.startsWith('韓七'));
  });

  test('寫的是作者那一份，旁邊沒有另起一張 `韓七.md`', () => {
    assert.match(written, /韓七：模型寫的身份/);
    assert.deepEqual(siblings, ['韓七.MD']);
  });

  test('舊版照樣進了歷史', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });
});

describe('提取角色：已有的卡逐個對比後採納', () => {
  const CARD = '.novelwarden/characters/阿蘅.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    // 第一個答案給「從哪幾章提取」的輸入框，第二個給確認框（報次數、挑模型），第三個給「要逐個對比確認嗎」。
    h.expect('1', '開始提取', '逐個對比');
    fake.reset([JSON.stringify([{ name: '阿蘅', 性格: '阿蘅：模型說的性格' }])]);
    await bundle.characters.extractCharacters(project);
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('寫進了合併後的新版：模型給了的節換新，沒給的節留著作者寫的', () => {
    assert.match(written, /阿蘅：模型說的性格/);
    assert.match(written, /作者親手寫的阿蘅的身份/);
  });

  test('作者手寫的舊版在歷史版本裡留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('審閱只彈一次，是功能自己那張；閘道器沒有再問', () => {
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].merge, false);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('提示照舊', () => {
    assert.ok(toasts.includes('info: 已更新「阿蘅」。'), toasts.join(' | '));
  });
});

describe('批次更新角色卡：作者在確認框裡選了「全部直接採納」', () => {
  const CARD = '.novelwarden/characters/沈氏.md';
  let original;
  let written;
  let reviewed;
  let confirms;
  let toasts;

  before(async () => {
    original = t.read(CARD);
    h.expect('全部直接採納並開始');
    fake.reset([cardJson({ 身份: '批次重建的身份' })]);
    await bundle.characterCard.updateAllCharacterCards(project, 'full');
    written = t.read(CARD);
    reviewed = [...h.reviewed];
    confirms = h.confirms.map((c) => c.message);
    toasts = [...h.toasts];
  });

  test('一張審閱都不彈（作者已經在確認框裡選過），閘道器也不問', () => {
    assert.equal(reviewed.length, 0);
    assert.ok(!confirms.some((m) => m.includes(GATE_ASK)), confirms.join(' | '));
  });

  test('寫進了新版', () => {
    assert.match(written, /批次重建的身份/);
  });

  test('作者手寫的舊版在歷史版本裡留了一份', () => {
    assert.deepEqual(snapTexts(CARD), [original]);
  });

  test('完成提示照舊報數', () => {
    assert.ok(toasts.some((x) => x.includes('角色卡從頭重建完成：已更新 4 張')), toasts.join(' | '));
  });
});

describe('新建設定條目', () => {
  const MINE = '.novelwarden/lore/勢力/玄門.md';
  const AUTHOR = '---\ntitle: 玄門\nkeywords: [玄門]\n---\n\n# 玄門\n\n作者寫好的玄門。\n';
  let mineAfter;
  let created;
  let opened;
  let named;
  let namedInputs;

  before(async () => {
    t.write(MINE, AUTHOR);
    project.invalidate();
    h.expect('玄門');
    await bundle.characters.newLore(project, '.novelwarden/lore/勢力');
    mineAfter = t.read(MINE);
    created = t.has('.novelwarden/lore/勢力/玄門-2.md') ? t.read('.novelwarden/lore/勢力/玄門-2.md') : undefined;
    opened = [...h.opened];

    // 工程頁「出現過 · 未建條目」那一行右鍵新建：帶著名字，不再問。
    h.expect();
    await bundle.characters.newLore(project, undefined, '青崖鎮');
    named = t.has('.novelwarden/lore/青崖鎮.md') ? t.read('.novelwarden/lore/青崖鎮.md') : undefined;
    namedInputs = h.inputs.length;
  });

  test('同名的已有條目一個字不動，新的那份加序號落在旁邊', () => {
    assert.equal(mineAfter, AUTHOR);
    assert.ok(created !== undefined);
  });

  test('新條目的內容與從前一樣：標題、關鍵詞、一段寫什麼的說明', () => {
    assert.ok(created.startsWith('---\ntitle: 玄門\nkeywords: [玄門]\n---\n\n# 玄門\n\n（在這裡寫這條設定'), created);
  });

  test('建完開啟它', () => {
    assert.deepEqual(opened, ['.novelwarden/lore/勢力/玄門-2.md']);
  });

  test('沒有覆蓋任何東西，也就不存歷史版本', () => {
    assert.equal(snaps(MINE).length, 0);
    assert.equal(snaps('.novelwarden/lore/勢力/玄門-2.md').length, 0);
  });

  test('帶著名字新建：不問標題，落在設定根下', () => {
    assert.equal(namedInputs, 0);
    assert.ok(named && named.startsWith('---\ntitle: 青崖鎮\n'), named);
  });
});

describe('章節改名：同步正文的 # 標題 行', () => {
  const OLD = 'chapters/010-舊名.md';
  const NEW = 'chapters/010-新名.md';
  const BODY = `# 舊名\n\n${'山雨欲來風滿樓。'.repeat(10)}\n`;
  const STALE_MARK = 'deadbeefdeadbeef';
  let staleBefore;
  let renamed;
  let newText;
  let oldGone;
  let history;
  let historyLeftBehind;
  let reviewedCount;
  let confirmCount;
  let toasts;
  let plotMoved;
  let writtenFromAfter;
  let staleAfter;
  let freshBefore;
  let freshWrittenFrom;
  let freshWrittenFromAfter;
  let freshAfter;

  before(async () => {
    const { renderPlotFile, emptyPlotSections, plotContentHash } = bundle.plotFile;
    t.write(OLD, BODY);
    // 細綱在正文之後改過：`writtenFrom` 對不上現在的內容指紋 → 正文掛 ⟳。
    t.write(
      '.novelwarden/summaries/010-舊名.md',
      renderPlotFile({
        no: 10,
        title: '舊名',
        upstreamHash: '',
        writtenFrom: STALE_MARK,
        done: false,
        sections: { ...emptyPlotSections(), 梗概: '改過的計劃', 关键事件: '甲' },
      })
    );
    // 對照：一章沒掛 ⟳ 的（`writtenFrom` 正對得上）。
    const freshSections = { ...emptyPlotSections(), 梗概: '沒改過的計劃', 关键事件: '乙' };
    freshWrittenFrom = plotContentHash({ sections: freshSections });
    t.write('chapters/011-次章.md', '# 次章\n\n正文。\n');
    t.write(
      '.novelwarden/summaries/011-次章.md',
      renderPlotFile({ no: 11, title: '次章', upstreamHash: '', writtenFrom: freshWrittenFrom, done: false, sections: freshSections })
    );
    staleBefore = await staleOf(10);
    freshBefore = await staleOf(11);

    h.expect('新名');
    renamed = await bundle.fileOps.renameEntry(project, OLD);
    reviewedCount = h.reviewed.length;
    confirmCount = h.confirms.length;
    toasts = [...h.toasts];
    newText = t.has(NEW) ? t.read(NEW) : undefined;
    oldGone = !t.has(OLD);
    history = snapTexts(NEW);
    historyLeftBehind = snaps(OLD).length;
    project.invalidate();
    const plot = await project.readPlot('.novelwarden/summaries/010-新名.md');
    plotMoved = !!plot && !t.has('.novelwarden/summaries/010-舊名.md');
    writtenFromAfter = plot && plot.writtenFrom;
    staleAfter = await staleOf(10);

    h.expect('再改');
    await bundle.fileOps.renameEntry(project, 'chapters/011-次章.md');
    project.invalidate();
    freshWrittenFromAfter = (await project.readPlot('.novelwarden/summaries/011-再改.md'))?.writtenFrom;
    freshAfter = await staleOf(11);
  });

  test('改名成功：檔名與正文的 # 標題 一起換成新名字', () => {
    assert.equal(renamed, NEW);
    assert.ok(oldGone);
    assert.equal(newText, BODY.replace('# 舊名', '# 新名'));
  });

  test('改名之前的正文在歷史版本裡留了一份，快照跟著搬到新路徑下（在新路徑上開啟「歷史」面板看得到）', () => {
    assert.deepEqual(history, [BODY]);
    assert.equal(historyLeftBehind, 0);
  });

  test('不彈審閱也不彈確認：新名字是作者剛在輸入框裡起的', () => {
    assert.equal(reviewedCount, 0);
    assert.equal(confirmCount, 0);
  });

  test('提示照舊', () => {
    assert.ok(toasts.includes(`info: 已重新命名為 ${NEW}`), toasts.join(' | '));
  });

  test('第 18 條：掛著 ⟳ 的章改名之後照樣掛著——writtenFrom 原樣跟著細綱搬過去，沒被刷成當前細綱的指紋', () => {
    assert.equal(staleBefore, true);
    assert.ok(plotMoved);
    assert.equal(writtenFromAfter, STALE_MARK);
    assert.equal(staleAfter, true);
  });

  test('沒掛 ⟳ 的章改名之後也不掛', () => {
    assert.equal(freshBefore, false);
    assert.equal(freshWrittenFromAfter, freshWrittenFrom);
    assert.equal(freshAfter, false);
  });
});

describe('章節改名：正文超過閘道器的大小上限', () => {
  const HUGE = 'chapters/012-巨章.md';
  // 「字」在 UTF-8 裡三個位元組：七十萬字過了 2 MB。
  const BODY = `# 巨章\n\n${'字'.repeat(700_000)}\n`;
  let result;
  let toasts;
  let kept;
  let movedTo;

  before(async () => {
    t.write(HUGE, BODY);
    project.invalidate();
    h.expect('改不動');
    result = await bundle.fileOps.renameEntry(project, HUGE);
    toasts = [...h.toasts];
    kept = t.has(HUGE) && t.read(HUGE) === BODY;
    movedTo = t.has('chapters/012-改不動.md');
  });

  test('閘道器拒寫標題行，整個改名不做（不留下標題改了、檔名沒改的半截）', () => {
    assert.equal(result, undefined);
    assert.ok(kept);
    assert.equal(movedTo, false);
  });

  test('說出來為什麼', () => {
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('大小上限')), toasts.join(' | '));
  });
});

// ---------------------------------------------------------------- 改名搬不成時正文不能被悄悄改掉（第 3 條）
//
// 同步標題行要先寫正文、再搬家。從前新名字被佔用時 `move` 被拒，正文第一行卻已經換成了新名字。

/** 一份沒有指紋的細綱（作者手寫的那種），斷言「一字不動」用。 */
const plainPlot = (no, title) => `---\nno: ${no}\ntitle: ${title}\n---\n\n# 第${no}章 ${title}\n\n## 梗概\n\n${title}的計劃。\n`;

/**
 * 給 `fs.promises.writeFile` 打樁跑一段：`onWrite(abs, data, original)` 先看一眼每一次寫盤，返回 `true` 表示它自己處理完了
 * （不再調原來的）。閘道器的寫盤經 `model/fs.ts` 的 `writeText` 走到這裡；測試裡同步的 `fs.writeFileSync` 不經過它。
 */
async function withWriteStub(onWrite, fn) {
  const original = fsp.writeFile;
  fsp.writeFile = async (...args) => {
    const handled = await onWrite(path.resolve(String(args[0])), args[1], (...a) => original.apply(fsp, a.length ? a : args));
    return handled === true ? undefined : original.apply(fsp, args);
  };
  try {
    return await fn();
  } finally {
    fsp.writeFile = original;
  }
}

describe('章節改名：新名字已經被另一章佔了', () => {
  const CH = 'chapters/013-甲.md';
  const BODY = `# 甲\n\n${'夜深了，燈還亮著。'.repeat(10)}\n`;
  const PLOT_REL = '.novelwarden/summaries/013-甲.md';
  const OTHER = 'chapters/013-丙.md';
  const OTHER_BODY = '# 丙\n\n另一章，不能被蓋掉。\n';
  let result;
  let toasts;

  before(async () => {
    t.write(CH, BODY);
    t.write(PLOT_REL, plainPlot(13, '甲'));
    t.write(OTHER, OTHER_BODY);
    project.invalidate();
    h.expect('丙');
    result = await bundle.fileOps.renameEntry(project, CH);
    toasts = [...h.toasts];
  });

  test('沒有改名', () => {
    assert.equal(result, undefined);
  });

  test('正文一字不動（# 標題行沒被改成新名字）', () => {
    assert.equal(t.read(CH), BODY);
  });

  test('細綱一字不動、留在原處', () => {
    assert.equal(t.read(PLOT_REL), plainPlot(13, '甲'));
    assert.equal(t.has('.novelwarden/summaries/013-丙.md'), false);
  });

  test('佔著新名字的那一章一字不動', () => {
    assert.equal(t.read(OTHER), OTHER_BODY);
  });

  test('什麼都沒覆蓋，也就不存歷史版本', () => {
    assert.equal(snaps(CH).length, 0);
  });

  test('照舊說「已存在同名項」', () => {
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('已存在同名項') && x.includes(OTHER)), toasts.join(' | '));
  });
});

describe('章節改名：寫完標題之後新名字才被佔（競態），標題改回原樣', () => {
  const CH = 'chapters/014-丁.md';
  const NEXT = 'chapters/014-戊.md';
  const BODY = `# 丁\n\n${'風從窗縫裡鑽進來。'.repeat(10)}\n`;
  const PLOT_REL = '.novelwarden/summaries/014-丁.md';
  const RACER = '# 戊\n\n別處剛建的一章。\n';
  let result;
  let toasts;
  let titleWritten;

  before(async () => {
    t.write(CH, BODY);
    t.write(PLOT_REL, plainPlot(14, '丁'));
    project.invalidate();
    h.expect('戊');
    titleWritten = false;
    result = await withWriteStub(
      async (abs, data, original) => {
        if (abs === path.resolve(t.rel(CH)) && String(data).startsWith('# 戊')) {
          await original();
          titleWritten = true;
          // 標題剛寫下去，別處就在新名字上建了一章：搬家必然被拒。
          fs.writeFileSync(t.rel(NEXT), RACER, 'utf8');
          return true;
        }
        return false;
      },
      () => bundle.fileOps.renameEntry(project, CH)
    );
    toasts = [...h.toasts];
  });

  test('樁確實打在「寫完標題、搬家之前」', () => {
    assert.equal(titleWritten, true);
  });

  test('沒有改名', () => {
    assert.equal(result, undefined);
  });

  test('正文改回原樣，一字不差', () => {
    assert.equal(t.read(CH), BODY);
  });

  test('細綱一字不動', () => {
    assert.equal(t.read(PLOT_REL), plainPlot(14, '丁'));
  });

  test('別處建的那一章一字不動', () => {
    assert.equal(t.read(NEXT), RACER);
  });

  test('說出來為什麼（已存在同名項），不說「沒能恢復」', () => {
    assert.ok(toasts.some((x) => x.startsWith('error:') && x.includes('已存在同名項') && x.includes(NEXT)), toasts.join(' | '));
    assert.ok(!toasts.some((x) => x.includes('沒能改回')), toasts.join(' | '));
  });
});

describe('章節改名：搬家沒成、標題也沒能改回去，照實說', () => {
  const CH = 'chapters/015-己.md';
  const NEXT = 'chapters/015-庚.md';
  const BODY = `# 己\n\n${'雪落了一夜。'.repeat(10)}\n`;
  let result;
  let toasts;
  let logs;

  before(async () => {
    t.write(CH, BODY);
    project.invalidate();
    h.expect('庚');
    bundle.logger.clearLogs();
    result = await withWriteStub(
      async (abs, data, original) => {
        if (abs !== path.resolve(t.rel(CH))) {
          return false;
        }
        if (String(data).startsWith('# 庚')) {
          await original();
          fs.writeFileSync(t.rel(NEXT), '# 庚\n\n別處剛建的。\n', 'utf8');
          return true;
        }
        // 改回原樣的那一次寫盤：磁碟拒了。
        throw Object.assign(new Error(`EACCES: permission denied, open '${abs}'`), { code: 'EACCES' });
      },
      () => bundle.fileOps.renameEntry(project, CH)
    );
    toasts = [...h.toasts];
    logs = bundle.logger.recentLogs().filter((e) => e.level === 'error' || e.level === 'warn');
  });

  test('沒有改名', () => {
    assert.equal(result, undefined);
  });

  test('正文現在第一行是新名字（沒能改回去）', () => {
    assert.ok(t.read(CH).startsWith('# 庚\n'), t.read(CH).slice(0, 20));
  });

  test('toast 照實說：搬家為什麼沒成、標題沒能改回、該怎麼手動改回', () => {
    const msg = toasts.find((x) => x.startsWith('error:') && x.includes('沒能改回'));
    assert.ok(msg, toasts.join(' | '));
    assert.ok(msg.includes('已存在同名項') && msg.includes(CH) && msg.includes('# 己') && msg.includes('EACCES'), msg);
  });

  test('日誌裡也留了一條', () => {
    const entry = logs.find((e) => e.message.includes('沒能改回'));
    assert.ok(entry, JSON.stringify(logs.map((e) => e.message)));
    assert.ok(`${entry.message}｜${entry.detail ?? ''}`.includes('EACCES'), JSON.stringify(entry));
  });
});

describe('章節改名：搬家沒成，而正文這期間又被改過——不拿舊的蓋掉', () => {
  const CH = 'chapters/016-辛.md';
  const NEXT = 'chapters/016-壬.md';
  const BODY = `# 辛\n\n${'馬蹄聲遠了。'.repeat(10)}\n`;
  const AUTHOR = '# 壬\n\n作者在這幾毫秒裡又寫了一句，一個字都不能丟。\n';
  let result;
  let toasts;

  before(async () => {
    t.write(CH, BODY);
    project.invalidate();
    h.expect('壬');
    result = await withWriteStub(
      async (abs, data, original) => {
        if (abs === path.resolve(t.rel(CH)) && String(data).startsWith('# 壬') && String(data) !== AUTHOR) {
          await original();
          fs.writeFileSync(t.rel(NEXT), '# 壬\n\n別處剛建的。\n', 'utf8');
          fs.writeFileSync(t.rel(CH), AUTHOR, 'utf8');
          return true;
        }
        return false;
      },
      () => bundle.fileOps.renameEntry(project, CH)
    );
    toasts = [...h.toasts];
  });

  test('沒有改名', () => {
    assert.equal(result, undefined);
  });

  test('作者這期間寫的留著，沒被改名之前那一版蓋掉', () => {
    assert.equal(t.read(CH), AUTHOR);
  });

  test('照實說沒能改回、為什麼', () => {
    const msg = toasts.find((x) => x.startsWith('error:') && x.includes('沒能改回'));
    assert.ok(msg && msg.includes('又被改過'), toasts.join(' | '));
  });
});
