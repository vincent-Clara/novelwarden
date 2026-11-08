/**
 * 指紋鏈的記賬**下沉到寫入路徑本身**：誰寫都記。
 *
 * 一章只有一份細綱（正文在 `summaries/` 下的映象，相對路徑相同），鏈上三環的上游指紋都記在它的 frontmatter 裡：
 *
 * ```
 * summaries/N.md 的梗概           ─▶ summaries/N.md 的 upstreamHash（寫細綱時記；梗概就是大綱裡這一章那一條）
 * summaries/N.md 的七個小節       ─▶ summaries/N.md 的 writtenFrom （寫正文時記，定稿時重新整理）
 * chapters/N 的正文               ─▶ summaries/N.md 的 sourceHash  （定稿反向更新時記）
 * ```
 *
 * 後兩環記在**細綱**上而不是章節上：章節是作者的檔案，可以是 `.txt`、沒有
 * frontmatter（第 9 條），這條鏈只能從細綱指過去。定稿從前另寫一份單章摘要，
 * 現在是把同一份細綱照正文反向更新，舊版先複製進回收站。
 *
 * 兩條不能碰的既有取捨（AGENTS 第 18 條）也在這裡守：
 * - `plotContentHash` 只雜湊七個小節，不含 frontmatter——記一筆 writtenFrom、
 *   標一次 done、改個標題、定稿記一筆 sourceHash 都不該讓正文標髒；
 * - 手寫的產物永不標髒。
 *
 * 另外守兩條取捨：
 * - **情節大綱是各章細綱梗概的彙總，細綱的上游是它自己的梗概**（docs/design/plans/2026-10-22-outline-from-plots.md）：
 *   在大綱裡改了哪一章那一條，只有那一章掛 ⟳；續寫第 41–60 章不讓前 40 章掛 ⟳；改標題不算改上游；
 * - **定稿時把 writtenFrom 刷成更新後的指紋**——定稿剛改完細綱正文不掛 ⟳，定稿之後作者
 *   再改細綱，正文才掛 ⟳（作者定案 7）。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle, loadModule } = require('../../helpers/load');
const { outlineOf } = require('../../helpers/outline');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let ws;

async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（沒拋）';
}

/** 從磁碟上那份檔案的 frontmatter 裡摳一個欄位。 */
function fm(relPath, key) {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(t.read(relPath));
  return m ? m[1].trim() : undefined;
}

/** frontmatter 之後的那一段（`---` 圍欄之外的全部位元組）。 */
function bodyOf(relPath) {
  return t.read(relPath).replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** 一份排過的細綱（「關鍵事件」非空，isPlotFilled 才認）。 */
const filled = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '林昭進入青雲宗。',
  出场人物: '林昭',
  关键事件: '他在山門外等到天黑，翻過側峰。',
  看点: '藏書閣裡有人在等他。',
  ...extra,
});

/** 一份最小的可寫細綱。 */
const writable = (no, title, extra = {}) => ({
  no, title, upstreamHash: '', done: false, sections: filled(), ...extra,
});

/** 定稿時模型答回來的七節（反向更新之後的樣子）。 */
const finalized = (extra = {}) => ({
  ...bundle.plotFile.emptyPlotSections(),
  梗概: '他去了，在山門外蹲了兩個時辰。',
  出场人物: '林昭',
  关键事件: '林昭在山門外等到天黑。',
  看点: '- 藏書閣的燈一直亮著。',
  连续性事实: '- 林昭在山門外蹲了兩個時辰 〔證據：「他蹲了兩個時辰」〕',
  ...extra,
});

const OUTLINE_REL = '.novelwarden/outline.md';

/** 改情節大綱：讀出彙總的整份、改、經閘道器存回去（按章號拆回各章細綱）。 */
async function editOutline(fn) {
  project.invalidate();
  const current = (await ws.read(OUTLINE_REL)).text;
  await ws.write(OUTLINE_REL, { text: fn(current) }, { mode: 'overwrite', review: false });
  project.invalidate();
}

/** 梗概的指紋——與閘道器記賬、流水線判髒用的是同一個函式。 */
const synopsisHash = (text) => bundle.plotFile.plotSynopsisHash(text);

/** 按號取這一章的流水線（細綱 + 同號章節）。 */
async function pipelineOf(no) {
  project.invalidate();
  const plot = await project.getPlot(no);
  return bundle.pipe.buildPlotPipeline(project, { no, plot });
}

/** 按號取章節（讀盤之前先失效快取）。 */
async function chapterOf(no) {
  project.invalidate();
  return (await project.listChapters()).find((c) => c.order === no);
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    fs: './src/core/model/fs.ts',
    project: './src/core/model/project.ts',
    plotFile: './src/core/model/plotFile.ts',
    outlineFile: './src/core/model/outlineFile.ts',
    pipe: './src/core/views/pipeline.ts',
    ws: './src/core/workspace/index.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wshash' });
  project = t.project;
  ws = new bundle.ws.Workspace(project);
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('細綱 · 寫入就記 upstreamHash（這一章梗概的指紋）', () => {
  const rel = '.novelwarden/summaries/012-入宗.md';

  before(async () => {
    await ws.writePlot(writable(12, '入宗', { upstreamHash: synopsisHash(filled().梗概) }));
  });

  test('落在 summaries/ 根下，名字帶三位序號', () => {
    assert.ok(t.has(rel), rel);
  });

  test('frontmatter 裡有 upstreamHash', () => {
    assert.equal(fm(rel, 'upstreamHash'), synopsisHash('林昭進入青雲宗。'));
  });

  // 記的是**梗概**：拿整份細綱的指紋的話，改一個關鍵事件也會讓它自己掛 ⟳。
  test('記的是梗概的指紋，不是整份細綱的', async () => {
    project.invalidate();
    assert.notEqual(fm(rel, 'upstreamHash'), bundle.plotFile.plotContentHash(await project.readPlot(rel)));
  });

  test('在情節大綱裡改了這一章那一條：梗概換了、指紋沒動，細綱掛 ⟳', async () => {
    await editOutline((doc) => doc.replace('林昭進入青雲宗。', '林昭進青雲宗（改過）。'));
    assert.ok(t.read(rel).includes('林昭進青雲宗（改過）。'), t.read(rel));
    assert.equal(fm(rel, 'upstreamHash'), synopsisHash('林昭進入青雲宗。'));
    assert.equal((await pipelineOf(12)).plot.upstreamStale, true);
  });

  // **這是記賬下沉修的那個缺陷**：改大綱之後作者在編輯器裡改細綱，從前 upstreamHash
  // 不會跟著更新，那一章從此永遠掛著一個洗不掉的 ⟳。
  test('之後直接 write 細綱文字，upstreamHash 跟著更新、不再掛 ⟳', async () => {
    const current = t.read(rel);
    await ws.write(rel, { text: current.replace('翻過側峰', '翻過後山') }, {
      mode: 'overwrite',
      review: false,
    });
    assert.equal(fm(rel, 'upstreamHash'), synopsisHash('林昭進青雲宗（改過）。'));
    assert.equal((await pipelineOf(12)).plot.upstreamStale, false);
  });

  test('正文內容照樣寫進去了', () => {
    assert.ok(t.read(rel).includes('翻過後山'), t.read(rel));
  });

  // 不經採納、不經 writePlot，純 edit 一處也記賬。
  test('edit 定點改梗概也記 upstreamHash', async () => {
    await ws.edit(rel, [{ old: '（改過）', new: '（再改）' }]);
    assert.equal(fm(rel, 'upstreamHash'), synopsisHash('林昭進青雲宗（再改）。'));
  });

  test('H1 寫成「第N章 標題」', () => {
    assert.ok(t.read(rel).includes('# 第12章 入宗'), t.read(rel).slice(0, 300));
  });

  test('七節都落盤，空的留佔位', () => {
    const text = t.read(rel);
    for (const key of bundle.plotFile.PLOT_SECTION_KEYS) {
      assert.ok(text.includes(`## ${loadModule('src/core/model/labels.ts').traditionalLabel(key)}`), `缺「${key}」：${text}`);
    }
  });
});

/**
 * 大綱是一段一段續寫的，改的也往往只是其中一條。**只有那幾章的細綱標髒**：
 * 從前按全書指紋算，改一句第二幕的走向就換來一屏 ⟳，作者很快學會無視它。
 */
describe('細綱 · 大綱改了哪一條，只標髒那一章', () => {
  let afterAppend;
  let afterSecond;
  let afterTitle;

  before(async () => {
    // 第 5、25 章排過細綱、記過梗概的指紋；第 50 章是手寫的（沒記指紋）。
    await ws.writePlot(writable(5, '入局', { upstreamHash: synopsisHash('入局。'), sections: filled({ 梗概: '入局。' }) }));
    await ws.writePlot(writable(25, '名冊', { upstreamHash: synopsisHash('名冊現世。'), sections: filled({ 梗概: '名冊現世。' }) }));
    await ws.writePlot(writable(50, '遠方', { sections: filled({ 梗概: '遠方的事。' }) }));
    const staleOf = async () =>
      Object.fromEntries(
        await Promise.all([5, 25, 50].map(async (no) => [no, (await pipelineOf(no)).plot.upstreamStale]))
      );

    // 續寫一段：第 41–60 章（第 50 章那一條也在裡面），與採納續寫的那一段同一個合併（按章號換掉這一段）。
    const append = outlineOf(60, { from: 41, heading: false, text: { 41: '火災真相。' } });
    await editOutline((doc) => bundle.outlineFile.mergeOutline(doc, append, { from: 41, to: 60 }));
    afterAppend = await staleOf();

    // 只改第 25 章那一條。
    await editOutline((doc) => doc.replace('名冊現世。', '名冊被燒了一半。'));
    afterSecond = await staleOf();

    // 再改第 5 章的標題：標題不在上游指紋裡。
    await editOutline((doc) => doc.replace('## 第5章：入局', '## 第5章：回鎮'));
    afterTitle = await staleOf();
  });

  test('前提：第 50 章是手寫的，沒記上游指紋', () => {
    assert.equal(fm('.novelwarden/summaries/050-遠方.md', 'upstreamHash'), undefined);
  });

  test('續寫新的一段，前面的細綱都不掛 ⟳', () => {
    assert.equal(afterAppend[5], false, JSON.stringify(afterAppend));
    assert.equal(afterAppend[25], false, JSON.stringify(afterAppend));
  });

  test('續寫的那一段沒有細綱的章建了只有梗概的空殼', async () => {
    project.invalidate();
    const plot = await project.getPlot(41);
    assert.equal(plot.sections.梗概, '火災真相。');
    assert.ok(bundle.plotFile.isPlotStub(plot));
  });

  // 第 50 章沒記過上游——和手寫的一樣，續寫換了它的梗概也不憑空標髒（第 18a 條）。
  test('手寫的那一章，續寫換了它的梗概也不標髒', () => {
    assert.equal(afterAppend[50], false, JSON.stringify(afterAppend));
    assert.ok(t.read('.novelwarden/summaries/050-遠方.md').includes('第50章的事。'));
  });

  test('只改第 25 章那一條：第 25 章標髒', () => {
    assert.equal(afterSecond[25], true, JSON.stringify(afterSecond));
  });

  test('只改第 25 章那一條：第 5 章不受牽連', () => {
    assert.equal(afterSecond[5], false, JSON.stringify(afterSecond));
  });

  test('改了第 5 章的標題：只是改名（還沒有正文，檔名跟著改），不標髒', () => {
    assert.equal(afterTitle[5], false, JSON.stringify(afterTitle));
    assert.ok(t.has('.novelwarden/summaries/005-回鎮.md'));
    assert.ok(!t.has('.novelwarden/summaries/005-入局.md'));
  });
});

describe('細綱 · 手寫的產物永不標髒（第 18a 條）', () => {
  const rel = '.novelwarden/summaries/021-手寫.md';

  before(async () => {
    // 作者在 vim 裡敲出來的細綱：沒有 frontmatter，也就沒有上游。
    t.write(rel, '## 梗概\n\n我自己寫的\n\n## 關鍵事件\n\n甲乙丙\n');
    project.invalidate();
    await ws.write(rel, { text: '## 梗概\n\n我自己寫的\n\n## 關鍵事件\n\n甲乙丙丁\n' }, {
      mode: 'overwrite',
      review: false,
    });
  });

  test('改了內容', () => {
    assert.ok(t.read(rel).includes('甲乙丙丁'), t.read(rel));
  });

  // 拿一個憑空的過期標記去催作者重做，他會學會無視所有標記。
  test('沒有 frontmatter 的細綱不會被憑空補上 upstreamHash', () => {
    assert.ok(!t.read(rel).includes('upstreamHash'), t.read(rel));
  });

  test('檢視層照樣不標髒', async () => {
    const plot = await project.readPlot(rel);
    const p = await bundle.pipe.buildPlotPipeline(project, { no: plot.no, plot });
    assert.equal(p.plot.upstreamStale, false);
  });

  // writePlot 是**領域寫入器**：呼叫方把整份 frontmatter 都說全了，
  // 包括「這一章沒有上游」。newPlotFlow 正是這樣建出手工新章的。
  test('writePlot 傳空 upstreamHash 時不被補上', async () => {
    const bare = await ws.writePlot(writable(22, '', { sections: bundle.plotFile.emptyPlotSections() }));
    assert.ok(!t.read(bare).includes('upstreamHash'), t.read(bare));
  });

  // 同一條理由的另一環：手寫的細綱不在這條鏈上，寫正文時也不給它補一個 writtenFrom。
  test('沒有 frontmatter 的細綱不記 writtenFrom', async () => {
    const before = t.read(rel);
    const ok = await ws.recordWrittenFrom(rel, 'SOME_HASH');
    assert.equal(ok, false);
    assert.equal(t.read(rel), before);
  });

  test('細綱不存在時 recordWrittenFrom 返回 false，不拋', async () => {
    assert.equal(await ws.recordWrittenFrom('.novelwarden/summaries/099-不存在.md', 'X'), false);
  });
});

describe('正文 · 落盤時在細綱上記 writtenFrom', () => {
  const plotRel = '.novelwarden/summaries/012-入宗.md';
  let chapterRel;
  let plotHash;
  let bodyBefore;
  let recorded;
  let fresh;

  before(async () => {
    // 正文落盤那一步的兩件事：寫同號章節，再在細綱上記 writtenFrom
    // （generation/accept.ts 與批次寫正文都是這兩步）。
    plotHash = bundle.plotFile.plotContentHash(await project.readPlot(plotRel));
    bodyBefore = bodyOf(plotRel);
    chapterRel = await ws.createChapter(12, '入宗', '他蹲了兩個時辰。');
    recorded = await ws.recordWrittenFrom(plotRel, plotHash);
    fresh = await pipelineOf(12);
  });

  test('正文落在同號的章節上', () => {
    assert.equal(chapterRel, 'chapters/012-入宗.txt', chapterRel);
  });

  test('記上了', () => {
    assert.equal(recorded, true);
  });

  test('writtenFrom 是細綱的內容指紋', () => {
    assert.equal(fm(plotRel, 'writtenFrom'), plotHash);
  });

  // 只改 `---` 之間那一段：作者可能在細綱里加過自定義小節，整份重渲染會把它們抹平。
  test('記賬只動 frontmatter，細綱正文一個位元組不動', () => {
    assert.equal(bodyOf(plotRel), bodyBefore);
  });

  // 章節是作者的檔案：這條鏈上的賬一筆都不往它身上記。
  test('章節檔案裡沒有任何指紋', () => {
    const text = t.read(chapterRel);
    assert.ok(!/writtenFrom|upstreamHash|sourceHash/.test(text), text);
  });

  test('剛寫完的正文不標髒', () => {
    assert.equal(fresh.chapter.upstreamStale, false, JSON.stringify(fresh.chapter));
  });

  test('同一個指紋再記一次是空操作', async () => {
    const before = t.read(plotRel);
    assert.equal(await ws.recordWrittenFrom(plotRel, plotHash), true);
    assert.equal(t.read(plotRel), before);
  });

  // **第 18b 條**：writtenFrom 自己就在 frontmatter 裡，算進內容指紋的話，
  // 記一筆賬就會讓剛寫好的正文立刻過期。
  test('記 writtenFrom 不改變細綱的內容指紋', async () => {
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), plotHash);
  });

  describe('改細綱 → 正文標髒', () => {
    let stale;
    let writtenFromAfterEdit;
    let reWritten;

    before(async () => {
      // 作者在編輯器裡改細綱：走 edit，handler 順手重記 upstreamHash。
      await ws.edit(plotRel, [{ old: '翻過後山', new: '從後山的水道遊進去' }]);
      writtenFromAfterEdit = fm(plotRel, 'writtenFrom');
      stale = await pipelineOf(12);

      // 照著新細綱再寫一遍正文，重新記賬。
      await ws.write(chapterRel, { text: '他從水道遊了進去。' }, { mode: 'append' });
      await ws.recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(await project.readPlot(plotRel)));
      reWritten = await pipelineOf(12);
    });

    // 編輯器那條路只記 upstreamHash，**不許**把正文那一側記的賬抹掉——
    // 抹掉了這一章就再也不會標髒（writtenFrom 為空 = 手寫的正文）。
    test('編輯器裡改細綱不會抹掉 writtenFrom', () => {
      assert.equal(writtenFromAfterEdit, plotHash);
    });

    test('改細綱後正文標髒', () => {
      assert.equal(stale.chapter.upstreamStale, true, JSON.stringify(stale.chapter));
    });

    test('標髒的那一章流水線退回待寫正文（重寫）', () => {
      assert.equal(stale.stage, 'manuscript', stale.stage);
    });

    test('照著新細綱重寫並記賬之後不再標髒', () => {
      assert.equal(reWritten.chapter.upstreamStale, false, JSON.stringify(reWritten.chapter));
    });
  });

  describe('改 frontmatter 不動內容指紋（第 18b 條）', () => {
    let hashBefore;

    before(async () => {
      hashBefore = bundle.plotFile.plotContentHash(await project.readPlot(plotRel));
    });

    // 出場人物現在是七節之一（計劃出場），改它就是改細綱；目標字數在 frontmatter 裡，改它不是。
    test('改目標字數，內容指紋不變', async () => {
      const p = await project.readPlot(plotRel);
      await ws.writePlot({ ...p, targetWords: 4000 });
      assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), hashBefore);
    });

    // writePlot 收整份領域物件：呼叫方把讀回來的那份原樣遞回來時，正文那一側記的賬
    // 跟著帶過去，不在「改個字數」的時候悄悄丟掉。
    test('整份重寫細綱時 writtenFrom 跟著帶過去', async () => {
      const p = await project.readPlot(plotRel);
      assert.equal(p.writtenFrom, bundle.plotFile.plotContentHash(p));
    });

    test('把細綱標 done 不改變它的內容指紋', async () => {
      const p = await project.readPlot(plotRel);
      await ws.writePlot({ ...p, done: true });
      assert.equal(fm(plotRel, 'status'), 'done');
      assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(plotRel)), hashBefore);
    });

    test('把細綱標 done 之後正文不標髒', async () => {
      const p = await pipelineOf(12);
      assert.equal(p.chapter.upstreamStale, false, JSON.stringify(p.chapter));
    });
  });
});

/**
 * 鏈的最後一環：定稿記的是**章節**的 contentHash——細綱反向更新成的是寫出來的那一章。
 * 定稿只改細綱，章節一個位元組不動，否則剛記下的 sourceHash 當場就對不上。
 */
describe('正文 → 定稿 · sourceHash 記的是章節的 contentHash', () => {
  const plotRel = '.novelwarden/summaries/012-入宗.md';
  let chapter;
  let chapterTextBefore;
  let chapterTextAfter;
  let result;
  let freshStale;
  let afterAppend;

  before(async () => {
    chapter = await chapterOf(12);
    chapterTextBefore = t.read(chapter.relPath);
    result = await ws.finalizePlot(chapter, finalized(), [{ name: '林昭', aliases: [] }]);
    chapterTextAfter = t.read(chapter.relPath);
    project.invalidate();
    freshStale = (await project.staleChapters()).some((c) => c.order === 12);

    await ws.write(chapter.relPath, { text: '天亮了。' }, { mode: 'append' });
    afterAppend = await pipelineOf(12);
  });

  // 同一章只有一份細綱：定稿改的就是它，不在 summaries/ 裡另起一份。
  test('寫回同號的那一份細綱', () => {
    assert.equal(result.rel, plotRel, JSON.stringify(result));
  });

  test('sourceHash 就是章節的 contentHash', () => {
    assert.equal(fm(plotRel, 'sourceHash'), chapter.contentHash);
  });

  test('cast 落進 frontmatter', () => {
    assert.equal(fm(plotRel, 'cast'), '[林昭]');
  });

  test('定稿不碰章節檔案', () => {
    assert.equal(chapterTextAfter, chapterTextBefore);
  });

  test('剛定稿的章不算過期', () => {
    assert.equal(freshStale, false);
  });

  test('章節追加了正文，定稿過期', () => {
    assert.equal(afterAppend.summary.stale, true, JSON.stringify(afterAppend.summary));
  });
});

/**
 * 定稿是**修改**，不是重寫：七節整體換成反向更新後的那一版，作者定的與計劃那一側的賬
 * （標題、目標字數、done、兩種放行）原樣留著，上游指紋刷成新梗概的。舊版先複製進回收站——定稿按鈕本身就是
 * 作者的確認，所以直接寫；但改掉的是一份作者可能逐字推敲過的計劃，要找得回來。
 */
describe('定稿 · 保留 frontmatter，舊版進回收站', () => {
  const plotRel = '.novelwarden/summaries/060-夜雨.md';
  const trashRel = '.novelwarden/.trash/.novelwarden/summaries/060-夜雨.md';
  const OLD_SECTIONS = () =>
    filled({
      梗概: '計劃：林昭冒雨去青崖鎮。',
      关键事件: '計劃：他在鎮口被攔下，亮出令牌。',
      连续性事实: '- 舊的事實 〔證據：「舊句子」〕',
    });
  const cast = [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈氏', aliases: [] }];
  let chapter;
  let before1;
  let first;
  let afterFirst;
  let second;
  let plot;

  before(async () => {
    t.write(
      plotRel,
      bundle.plotFile.renderPlotFile({
        no: 60,
        title: '夜雨',
        targetWords: 3000,
        upstreamHash: 'UPSTREAM60',
        done: true,
        preflightOk: [{ name: '沈秋', reason: '回憶裡的一場' }],
        factCheckOk: true,
        sections: OLD_SECTIONS(),
      })
    );
    // 正文的標題行寫的是另一個名字：定稿認的是正文映象的那一份細綱，標題也以細綱為準。
    t.write('chapters/060-夜雨.md', '# 雨夜\n\n他蹲了兩個時辰，雨一直沒停。\n');
    project.invalidate();
    chapter = await chapterOf(60);
    before1 = t.read(plotRel);
    first = await ws.finalizePlot(chapter, finalized(), cast);
    afterFirst = t.read(plotRel);
    project.invalidate();
    plot = await project.readPlot(plotRel);
    second = await ws.finalizePlot(chapter, finalized({ 梗概: '第二次定稿。' }), cast);
  });

  test('落點仍是原來那份細綱', () => {
    assert.equal(first.rel, plotRel, JSON.stringify(first));
  });

  test('返回舊版在回收站裡的位置（保留原相對路徑）', () => {
    assert.equal(first.trashed, trashRel, JSON.stringify(first));
  });

  // 是複製不是搬走：搬走的話定稿寫入失敗時這一章就沒有細綱了。
  test('回收站裡那份與定稿前一字不差', () => {
    assert.equal(t.read(trashRel), before1);
  });

  test('七節整體換成反向更新後的那一版', () => {
    assert.deepEqual({ ...plot.sections }, finalized());
  });

  test('舊計劃的措辭不留在細綱裡', () => {
    assert.ok(!afterFirst.includes('計劃：'), afterFirst);
  });

  test('標題沿用細綱的，不換成章節的', () => {
    assert.equal(plot.title, '夜雨');
  });

  test('目標字數留著', () => {
    assert.equal(plot.targetWords, 3000);
  });

  // 梗概照正文改了（它也是大綱裡這一章那一條），記過的上游指紋刷成新梗概的——一定稿就掛 ⟳ 是誤報。
  test('上游指紋刷成新梗概的指紋', () => {
    assert.equal(plot.upstreamHash, synopsisHash(finalized().梗概));
  });

  test('作者手標的 done 留著', () => {
    assert.equal(plot.done, true);
  });

  test('預檢的永久放行留著', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(plot.preflightOk)), [{ name: '沈秋', reason: '回憶裡的一場' }]);
  });

  test('寫前衝突檢查的放行留著', () => {
    assert.equal(plot.factCheckOk, true);
  });

  test('sourceHash 記的是正文的 contentHash', () => {
    assert.equal(plot.sourceHash, chapter.contentHash);
  });

  test('cast 寫成一項一人、別名跟在括號裡', () => {
    assert.equal(fm(plotRel, 'cast'), '[林昭(阿昭), 沈氏]');
  });

  // 不刷的話，定稿剛改完細綱，正文立刻掛 ⟳（「細綱在正文之後改過」）。
  test('writtenFrom 刷成更新後的內容指紋', () => {
    assert.equal(plot.writtenFrom, bundle.plotFile.plotContentHash(plot));
  });

  // 同名不覆蓋之前進回收站的那一份（第 6 條的落點規則）。
  test('再定稿一次，舊版加 -2 序號進回收站', () => {
    assert.equal(second.trashed, '.novelwarden/.trash/.novelwarden/summaries/060-夜雨-2.md', JSON.stringify(second));
  });

  test('-2 那份是第一次定稿後的內容', () => {
    assert.equal(t.read(second.trashed), afterFirst);
  });

  test('第一次進回收站的那份沒被蓋掉', () => {
    assert.equal(t.read(trashRel), before1);
  });
});

/**
 * 定稿時舊版進了 `.trash/<原相對路徑>`；之後作者刪掉這份細綱，刪除也落在同一個路徑上。
 * 回收站的規矩是同名加序號、不覆蓋之前進去的東西（AGENTS 第 6 條）——否則定稿前那一版計劃
 * 就被這次刪除悄悄蓋掉了，作者再也找不回來。
 */
describe('刪定稿過的細綱 · 不蓋掉定稿時進回收站的舊版', () => {
  const plotRel = '.novelwarden/summaries/060-夜雨.md';
  const trashRel = '.novelwarden/.trash/.novelwarden/summaries/060-夜雨.md';
  let planBefore;
  let current;
  let deleted;

  before(async () => {
    planBefore = t.read(trashRel);
    current = t.read(plotRel);
    deleted = await ws.deletePlot(plotRel);
  });

  test('刪掉了', () => {
    assert.equal(deleted, true);
    assert.ok(!t.has(plotRel));
  });

  test('定稿前那一版仍在回收站裡', () => {
    assert.equal(t.read(trashRel), planBefore);
  });

  test('刪掉的這一版另起序號進回收站', () => {
    assert.equal(t.read('.novelwarden/.trash/.novelwarden/summaries/060-夜雨-3.md'), current);
  });
});

/**
 * 還沒有細綱的章（拆書匯入、作者手寫的正文）定稿時新建一份：落點是正文的映象
 * （`chapters/061-殘燈.md` → `summaries/061-殘燈.md`，純序號名的正文就是純序號名的細綱）。
 */
describe('定稿 · 沒有細綱的章新建一份', () => {
  let titled;
  let bare;

  before(async () => {
    await ws.createChapter(61, '殘燈', '燈芯燒到了底。');
    titled = await ws.finalizePlot(await chapterOf(61), finalized(), [{ name: '林昭', aliases: [] }]);
    await ws.createChapter(62, '', '沒有名字的一章。');
    bare = await ws.finalizePlot(await chapterOf(62), finalized(), []);
  });

  test('落在正文的映象上', () => {
    assert.equal(titled.rel, '.novelwarden/summaries/061-殘燈.md', JSON.stringify(titled));
  });

  test('原來沒有細綱，不報回收站', () => {
    assert.equal(titled.trashed, undefined);
  });

  test('新建的那份定稿過（sourceHash 對得上正文）', async () => {
    const plot = await project.readPlot(titled.rel);
    assert.equal(plot.sourceHash, (await chapterOf(61)).contentHash);
  });

  test('新建的那份沒有上游指紋與目標字數', () => {
    assert.ok(!/upstreamHash|targetWords/.test(t.read(titled.rel)), t.read(titled.rel));
  });

  test('純序號名的正文，細綱也是純序號名', () => {
    assert.equal(bare.rel, '.novelwarden/summaries/062.md', JSON.stringify(bare));
  });
});

/**
 * 定稿之後又改了細綱：**正文掛 ⟳**，提醒正文可能沒跟上（作者定案 7）；這一章仍算寫完——
 * 定稿看的是正文有沒有改過，不是細綱。反過來定稿之後改了正文，就回到「待定稿」。
 */
describe('定稿之後 · 改細綱正文掛 ⟳，改正文回到待定稿', () => {
  const plotRel = '.novelwarden/summaries/070-遠行.md';
  let beforeFinalize;
  let done;
  let plotEdited;
  let refinalized;
  let proseEdited;

  before(async () => {
    await ws.writePlot(writable(70, '遠行', { targetWords: 8 }));
    await ws.createChapter(70, '遠行', '他背上藤箱出了門，一路往北走。');
    await ws.recordWrittenFrom(plotRel, bundle.plotFile.plotContentHash(await project.readPlot(plotRel)));
    beforeFinalize = await pipelineOf(70);

    await ws.finalizePlot(await chapterOf(70), finalized({ 关键事件: '他背上藤箱出了門。' }), [
      { name: '林昭', aliases: [] },
    ]);
    done = await pipelineOf(70);

    // 作者在編輯器裡改了定稿過的細綱的一節。
    await ws.edit(plotRel, [{ old: '他背上藤箱出了門。', new: '他背上藤箱，天沒亮就出了門。' }]);
    plotEdited = await pipelineOf(70);

    // 重新定稿一次（writtenFrom 重新整理），再去改正文。
    await ws.finalizePlot(await chapterOf(70), finalized({ 关键事件: '他背上藤箱出了門。' }), [
      { name: '林昭', aliases: [] },
    ]);
    refinalized = await pipelineOf(70);
    await ws.write('chapters/070-遠行.md', { text: '走到鎮口，天才亮。' }, { mode: 'append' });
    proseEdited = await pipelineOf(70);
  });

  test('前置：正文夠了還沒定稿，停在待定稿', () => {
    assert.equal(beforeFinalize.stage, 'finalize', beforeFinalize.stage);
  });

  test('定稿之後這一章寫完了', () => {
    assert.equal(done.stage, 'done', done.stage);
  });

  // writtenFrom 在定稿時刷成了更新後的指紋，剛改完的細綱不算「在正文之後改過」。
  test('剛定稿完正文不掛 ⟳', () => {
    assert.equal(done.chapter.upstreamStale, false, JSON.stringify(done.chapter));
  });

  test('定稿之後改細綱，正文掛 ⟳', () => {
    assert.equal(plotEdited.chapter.upstreamStale, true, JSON.stringify(plotEdited.chapter));
  });

  // 定稿過的章不被拉回待寫，只掛 ⟳（第 18 條）。
  test('定稿之後改細綱，這一章仍算寫完', () => {
    assert.equal(plotEdited.stage, 'done', plotEdited.stage);
  });

  test('重新定稿之後 ⟳ 消失', () => {
    assert.equal(refinalized.chapter.upstreamStale, false, JSON.stringify(refinalized.chapter));
  });

  test('定稿之後改正文，回到待定稿', () => {
    assert.equal(proseEdited.stage, 'finalize', proseEdited.stage);
  });

  test('定稿之後改正文，定稿標過期', () => {
    assert.equal(proseEdited.summary.stale, true, JSON.stringify(proseEdited.summary));
  });
});

/** （從 workspace/split.test.js 挪過來）正文新建章節那條路的兩條守衛。 */
describe('章節 · 同名一律報錯退出，manifest 跟著同步', () => {
  let created;

  before(async () => {
    created = await ws.createChapter(1, '楔子', '雨下了三天。');
  });

  test('落在 chapters/ 下，帶三位序號', () => {
    assert.equal(created, 'chapters/001-楔子.txt', created);
  });

  test('同名一律報錯退出，不覆蓋', async () => {
    assert.equal(await codeOf(() => ws.createChapter(1, '楔子', '不該寫進去')), 'exists');
    assert.ok(!t.read(created).includes('不該寫進去'), t.read(created));
  });

  test('manifest 跟著同步', async () => {
    const manifest = await project.readManifest();
    assert.ok(manifest.chapters.some((c) => c.file === created), JSON.stringify(manifest.chapters));
  });
});

/**
 * 一次新建好幾章（匯入原稿）：每章照樣過閘道器，manifest 最後同步一次——逐章同步是 O(n²) 次讀盤。
 * 撞了同名照樣報錯退出：前面寫好的留著，manifest 也照樣同步到它們。
 */
describe('章節 · 一次新建好幾章', () => {
  let made;
  let err;

  before(async () => {
    made = await ws.createChapters([
      { order: 41, title: '甲', content: '第四十一章。' },
      { order: 42, title: '', content: '第四十二章。' },
    ]);
    t.write('chapters/044-丁.txt', '作者先放的。\n');
    project.invalidate();
    try {
      await ws.createChapters([
        { order: 43, title: '丙', content: '第四十三章。' },
        { order: 44, title: '丁', content: '不該寫進去' },
        { order: 45, title: '戊', content: '不該寫到這裡' },
      ]);
    } catch (e) {
      err = e;
    }
  });

  test('一章一個檔案，規則與 createChapter 一樣', () => {
    assert.deepEqual(made, ['chapters/041-甲.txt', 'chapters/042.txt']);
    // 正文是 .txt（2026-10-24）：純文字不寫標題行。
    assert.equal(t.read('chapters/041-甲.txt'), '第四十一章。\n');
    assert.equal(t.read('chapters/042.txt'), '第四十二章。\n');
  });

  test('撞了同名報錯退出，不覆蓋、不往下寫', () => {
    assert.equal(err?.code, 'exists');
    assert.ok(!t.read('chapters/044-丁.txt').includes('不該寫進去'));
    assert.ok(!t.has('chapters/045-戊.txt'));
  });

  test('manifest 同步到寫好的每一章（包括報錯之前那一章）', async () => {
    const files = (await project.readManifest()).chapters.map((c) => c.file);
    for (const rel of ['chapters/041-甲.txt', 'chapters/042.txt', 'chapters/043-丙.txt']) {
      assert.ok(files.includes(rel), rel);
    }
  });
});

/**
 * 有正文時改細綱的標題：細綱映象正文的路徑，**檔名跟著正文不動**，正文也不跟著改名。
 * 定稿記的賬在細綱自己的 frontmatter 裡，原樣留著。
 */
describe('細綱改標題 · 有正文時檔名跟著正文不動，定稿的賬留著', () => {
  const rel = '.novelwarden/summaries/012-入宗.md';
  let hashBefore;
  let sourceHashBefore;
  let written;
  let renamed;

  before(async () => {
    project.invalidate();
    const plot = await project.readPlot(rel);
    hashBefore = bundle.plotFile.plotContentHash(plot);
    sourceHashBefore = plot.sourceHash;
    written = await ws.writePlot({ ...plot, title: '入宗風波' });
    renamed = await pipelineOf(12);
  });

  test('落點仍是正文的映象', () => {
    assert.equal(written, rel);
    assert.ok(t.has(rel));
  });

  test('標題換了', () => {
    assert.equal(fm(rel, 'title'), '入宗風波');
  });

  test('沒有多出一份按標題起名的細綱', () => {
    assert.ok(!t.has('.novelwarden/summaries/012-入宗風波.md'));
  });

  test('章節沒被改名', () => {
    assert.ok(t.has('chapters/012-入宗.txt'));
  });

  test('定稿記的 sourceHash 留著', () => {
    assert.equal(fm(rel, 'sourceHash'), sourceHashBefore);
  });

  // 改個名字不該讓這一章的正文憑空標髒：標題不在內容指紋裡。
  test('改名不動內容指紋，正文不標髒', async () => {
    assert.equal(bundle.plotFile.plotContentHash(await project.readPlot(rel)), hashBefore);
    assert.equal(renamed.chapter.upstreamStale, false, JSON.stringify(renamed.chapter));
  });

  test('細綱與正文按路徑認到一起', () => {
    assert.equal(renamed.chapter.relPath, 'chapters/012-入宗.txt', JSON.stringify(renamed.chapter));
  });
});

describe('刪細綱 · 不碰 chapters/', () => {
  const rel = '.novelwarden/summaries/012-入宗.md';
  let deleted;
  let missing;

  before(async () => {
    deleted = await ws.deletePlot(rel);
    missing = await ws.deletePlot(rel);
  });

  test('返回 true', () => {
    assert.equal(deleted, true);
  });

  test('細綱進了回收站', () => {
    assert.ok(t.has('.novelwarden/.trash/.novelwarden/summaries/012-入宗.md'));
  });

  // 那是已經寫出來的正文。刪掉細綱只是放棄這一章的規劃稿（定稿過的話連同檔案），
  // 不該順手把正文一起帶走。
  test('chapters/ 裡的正文沒被動', () => {
    assert.ok(t.has('chapters/012-入宗.txt'));
  });

  test('刪已經刪掉的返回 false，不拋', () => {
    assert.equal(missing, false);
  });
});

describe('細綱照樣過八條守衛', () => {
  const rel = '.novelwarden/summaries/030-佔位.md';

  before(async () => {
    await ws.writePlot(writable(30, '佔位'));
  });

  test('往越界路徑寫細綱被拒', async () => {
    assert.equal(await codeOf(() => ws.write('../summaries/001.md', { text: 'x' })), 'outOfRoot');
  });

  test('細綱的樂觀鎖照常生效', async () => {
    assert.equal(
      await codeOf(() => ws.write(rel, { text: 'x' }, { mode: 'overwrite', baseHash: '舊的' })),
      'conflict'
    );
  });

  test('細綱的覆蓋審閱照常生效', async () => {
    const before = t.read(rel);
    h.expect('保留原樣');
    const r = await ws.write(rel, { text: '不該寫進去' }, { mode: 'overwrite' });
    assert.equal(r.skipped, true);
    assert.equal(t.read(rel), before);
  });

  // 細綱映象正文的相對路徑：分卷的書，細綱就在 summaries/ 的卷目錄裡，照樣是這條鏈上的細綱、照樣記賬。
  test('summaries/ 子目錄裡的細綱照樣記賬', async () => {
    const nested = '.novelwarden/summaries/卷一/001-高燒.md';
    await ws.write(nested, { text: '---\nno: 1\n---\n\n## 梗概\n\n高燒那一夜。\n\n## 關鍵事件\n\n- 高燒\n' });
    assert.equal(fm(nested, 'upstreamHash'), synopsisHash('高燒那一夜。'));
  });

  // 老工程的 plots/ 同理：程式碼不再讀它，寫進去也只是普通文字。
  test('老工程 plots/ 裡的細綱不記賬', async () => {
    const legacy = '.novelwarden/plots/001-高燒.md';
    await ws.write(legacy, { text: '---\nno: 1\n---\n\n## 本章目的\n\n老三節\n\n## 關鍵事件\n\n甲\n' });
    assert.ok(!t.read(legacy).includes('upstreamHash'), t.read(legacy));
  });
});
