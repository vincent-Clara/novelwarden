/**
 * 統一入口守衛的八條。**一條都不能少**——少一條就是給 agent 開了一個後門。
 *
 * | # | 守衛 | 從前在哪 |
 * |---|---|---|
 * | 1 | 路徑規範化（絕對路徑 / `..` / 空串） | fileOps.normalizeRel |
 * | 2 | 工程根包含檢查 | fileEditing.resolveInRoot |
 * | 3 | 固定目錄保護 | fileOps.isProtectedPath |
 * | 4 | `.trash/` 內容不可操作 | projectFiles |
 * | 5 | 讀取大小上限 2MB | fileEditing.MAX_EDITABLE_BYTES |
 * | 6 | 同名不覆蓋（mode: 'create'） | fileOps / projectFiles 各一份 |
 * | 7 | 覆蓋前審閱 | creation.confirmOverwrite |
 * | 8 | 內容 hash 樂觀鎖 | fileEditing.saveFromEditor |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let G;

/** 跑一段一定會拋 WsError 的程式碼，把錯誤交回來斷言 code。 */
async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（沒拋）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fs: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsguard' });
  project = t.project;
  G = bundle.guard;

  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
  t.write('.novelwarden/.trash/chapters/009-刪過的.md', '刪過的東西');
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('守衛 1 · 路徑規範化', () => {
  const bad = ['../etc/passwd', '/abs/path', 'C:\\Windows', '', '  ', '..'];

  for (const input of bad) {
    test(`讀 ${JSON.stringify(input)} 報越界`, async () => {
      assert.equal(await codeOf(() => G.guardRead(project, input)), 'outOfRoot');
    });

    test(`寫 ${JSON.stringify(input)} 報越界`, async () => {
      assert.equal(
        await codeOf(() => G.guardWrite(project, input, { mode: 'overwrite' })),
        'outOfRoot'
      );
    });
  }

  test('越界的錯是 WsError', async () => {
    try {
      await G.guardRead(project, '../x');
      assert.fail('該拋');
    } catch (err) {
      assert.equal(err instanceof G.WsError, true, err?.constructor?.name);
    }
  });
});

describe('守衛 2 · 工程根包含檢查', () => {
  // normalizeRel 已經攔掉了 `..`，但 `a/../../b` 這種歸一化之後仍會逃出去的
  // 要靠第二道：解析出絕對路徑再比一次。
  test('歸一化之後仍逃出工程根的路徑被拒', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'a/../../b')), 'outOfRoot');
  });

  test('工程根自己不是可讀物件', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, '.')), 'outOfRoot');
  });

  test('正常路徑解析成絕對路徑', async () => {
    const abs = await G.guardRead(project, 'chapters/001-楔子.md');
    assert.equal(abs, t.rel('chapters/001-楔子.md'));
  });
});

describe('守衛 3 · 固定目錄保護', () => {
  const fixed = [
    'chapters',
    'drafts',
    '.novelwarden',
    // 場景、卷、中轉站三層刪掉了，細綱也從 plots/ 搬進了 summaries/；程式碼不再讀那幾個目錄，
    // 但老工程磁碟上的它們是作者的檔案（D11），不能被整棵搬走或刪掉。
    '.novelwarden/plots',
    '.novelwarden/scenes',
    '.novelwarden/volumes',
    '.novelwarden/manuscripts',
    '.novelwarden/summaries',
    '.novelwarden/characters',
    '.novelwarden/lore',
    '.novelwarden/sessions',
    '.novelwarden/.trash',
  ];

  for (const rel of fixed) {
    test(`${rel} 不能改名/刪除`, async () => {
      assert.equal(await codeOf(() => G.guardMutate(project, rel)), 'protected');
    });
  }

  // 固定目錄只保護它自己，裡面的東西照常能操作。
  test('固定目錄裡的檔案能操作', async () => {
    const abs = await G.guardMutate(project, 'chapters/001-楔子.md');
    assert.equal(abs, t.rel('chapters/001-楔子.md'));
  });
});

describe('守衛 4 · 回收站裡的內容不可操作', () => {
  test('.trash 裡的檔案改不動', async () => {
    assert.equal(
      await codeOf(() => G.guardMutate(project, '.novelwarden/.trash/chapters/009-刪過的.md')),
      'inTrash'
    );
  });

  test('.trash 裡的檔案寫不進去', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, '.novelwarden/.trash/新的.md', { mode: 'overwrite' })
      ),
      'inTrash'
    );
  });

  // 但**讀**得到：作者要能翻回收站找回東西。
  test('.trash 裡的檔案讀得到', async () => {
    const abs = await G.guardRead(project, '.novelwarden/.trash/chapters/009-刪過的.md');
    assert.ok(abs.includes('.trash'));
  });
});

// 歷史版本（`.novelwarden/history/`）是閘道器自己存的副本：從前守衛只攔 `.trash/` 與 `sessions/`，往這裡寫、搬、複製都放行，
// 作者的操作能往「歷史」面板裡塞一份假快照。現在與回收站同一個口徑：讀得到，寫不進去。
describe('守衛 4 · 歷史版本寫不進去（讀得到）', () => {
  const SNAP = '.novelwarden/history/chapters/001-楔子.md/2026-10-18_14-32-05+0800.txt';

  before(() => {
    t.write(SNAP, '舊稿');
  });

  test('往歷史版本裡新建檔案被拒', async () => {
    assert.equal(
      await codeOf(() => G.guardWrite(project, '.novelwarden/history/chapters/001-楔子.md/偽造.txt', { mode: 'create' })),
      'inHistory'
    );
  });

  test('覆蓋一份快照被拒', async () => {
    assert.equal(await codeOf(() => G.guardWrite(project, SNAP, { mode: 'overwrite' })), 'inHistory');
  });

  test('歷史版本目錄本身也寫不進去', async () => {
    assert.equal(await codeOf(() => G.guardWrite(project, '.novelwarden/history', { mode: 'create' })), 'inHistory');
  });

  test('快照讀得到', async () => {
    const abs = await G.guardRead(project, SNAP);
    assert.equal(abs, t.rel(SNAP));
  });

  test('名字只是像的目錄不算（`.novelwarden/history2/`）', async () => {
    const r = await G.guardWrite(project, '.novelwarden/history2/隨手記.md', { mode: 'create' });
    assert.equal(r.existed, false);
  });
});

describe('守衛 5 · 大小上限', () => {
  before(() => {
    t.write('chapters/002-巨物.md', 'x'.repeat(G.MAX_EDITABLE_BYTES + 10));
  });

  test('讀超限檔案報 tooLarge', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'chapters/002-巨物.md')), 'tooLarge');
  });

  test('寫超限內容報 tooLarge', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, 'chapters/003-新的.md', {
          mode: 'overwrite',
          text: 'y'.repeat(G.MAX_EDITABLE_BYTES + 10),
        })
      ),
      'tooLarge'
    );
  });

  test('上限就是 2MB', () => {
    assert.equal(G.MAX_EDITABLE_BYTES, 2 * 1024 * 1024);
  });
});

describe('守衛 6 · 同名不覆蓋', () => {
  test('mode: create 撞上已有檔案報 exists', async () => {
    assert.equal(
      await codeOf(() => G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'create' })),
      'exists'
    );
  });

  test('mode: create 寫新檔案放行', async () => {
    const r = await G.guardWrite(project, 'chapters/010-新的.md', { mode: 'create' });
    assert.equal(r.existed, false);
  });

  test('mode: overwrite 撞上已有檔案放行，但說出來它存在', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.equal(r.existed, true);
  });

  test('目標已存在時把當前內容一併交回（供審閱比對）', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.ok(r.current?.includes('雨下了三天'), r.current);
  });

  test('目標是目錄時報 notFile', async () => {
    assert.equal(
      await codeOf(() => G.guardWrite(project, 'chapters', { mode: 'overwrite' })),
      'notFile'
    );
  });

  test('讀不存在的檔案報 notFound', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'chapters/查無此章.md')), 'notFound');
  });
});

describe('守衛 7 · 覆蓋前審閱', () => {
  // 逐字搬自 features/creation.ts 的 confirmOverwrite——那段文案是產品承諾的一部分。
  test('宿主有 reviewReplace 時開 diff', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    bundle.host.initHost(withReview.host);
    withReview.expect();
    const { ok } = await G.reviewOverwrite('第 12 章的細綱', '.novelwarden/summaries/012.md', '舊', '新');
    assert.equal(ok, true);
    assert.equal(withReview.reviewed.length, 1, JSON.stringify(withReview.reviewed));
    // 閘道器的覆蓋審閱請求合併：獨立版的合併檢視可以交回作者挑過的那一份（五期 W11）。
    assert.equal(withReview.reviewed[0].merge, true);
    bundle.host.initHost(h.host);
  });

  // diff 左側要定位現有檔案：從前只給稱呼，外掛殼按名字去找角色卡，
  // 覆蓋大綱、細綱時左側一片空白。
  test('把落點路徑交給 reviewReplace', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    bundle.host.initHost(withReview.host);
    await G.reviewOverwrite('第 12 章的細綱', '.novelwarden/summaries/012.md', '舊', '新');
    assert.equal(withReview.reviewed[0]?.relPath, '.novelwarden/summaries/012.md', JSON.stringify(withReview.reviewed));
    bundle.host.initHost(h.host);
  });

  test('reviewReplace 說 discard 就不寫', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    withReview.setReviewVerdict('discard');
    bundle.host.initHost(withReview.host);
    const { ok } = await G.reviewOverwrite('第 12 章的細綱', '.novelwarden/summaries/012.md', '舊', '新');
    assert.equal(ok, false);
    bundle.host.initHost(h.host);
  });

  test('合併檢視交回的那一份：可以寫，寫的是它', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    withReview.setReviewVerdict(() => ({ merged: '挑過的' }));
    bundle.host.initHost(withReview.host);
    try {
      assert.deepEqual(await G.reviewOverwrite('第 1 章的正文', 'chapters/001.md', '舊', '新'), { ok: true, text: '挑過的' });
    } finally {
      bundle.host.initHost(h.host);
    }
  });

  test('沒有 reviewReplace 的宿主退化成確認框', async () => {
    h.expect('覆蓋');
    const { ok } = await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', '舊的一段', '新的一段');
    assert.equal(ok, true);
    assert.equal(h.confirms.length, 1);
  });

  test('確認框的文案一字不改', async () => {
    h.expect('覆蓋');
    await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', '舊的一段', '新的一段');
    assert.equal(h.confirms[0].message, '「全書大綱」已經有內容了，用新版本覆蓋？');
  });

  test('確認框的 detail 給字數對比與路徑', async () => {
    h.expect('覆蓋');
    await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', '舊的一段', '新的一段甲');
    assert.equal(h.confirms[0].detail, '現有 4 字，新版 5 字。\n.novelwarden/outline.md');
  });

  test('使用者選「保留原樣」就不寫', async () => {
    h.expect('保留原樣');
    assert.equal((await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', '舊', '新')).ok, false);
  });

  test('使用者直接取消也不寫', async () => {
    h.expect();
    assert.equal((await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', '舊', '新')).ok, false);
  });

  // 一字未變還彈個框，只會讓人以為自己點錯了。
  test('內容一模一樣時不彈框，直接算通過', async () => {
    h.expect();
    assert.equal((await G.reviewOverwrite('全書大綱', '.novelwarden/outline.md', ' 甲 ', '甲')).ok, true);
    assert.equal(h.confirms.length, 0);
  });
});

describe('守衛 8 · 內容 hash 樂觀鎖', () => {
  test('baseHash 與磁碟一致時放行', async () => {
    const disk = t.read('chapters/001-楔子.md');
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', {
      mode: 'overwrite',
      baseHash: bundle.fs.hash(disk),
    });
    assert.equal(r.existed, true);
  });

  test('baseHash 對不上拋 conflict', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite', baseHash: '過期的hash' })
      ),
      'conflict'
    );
  });

  test('衝突時把磁碟版本一併交回', async () => {
    try {
      await G.guardWrite(project, 'chapters/001-楔子.md', {
        mode: 'overwrite',
        baseHash: '過期的hash',
      });
      assert.fail('該拋');
    } catch (err) {
      assert.ok(err.diskText?.includes('雨下了三天'), err.diskText);
      assert.equal(err.diskHash, bundle.fs.hash(t.read('chapters/001-楔子.md')));
    }
  });

  test('衝突錯是 WsConflictError，也是 WsError', async () => {
    try {
      await G.guardWrite(project, 'chapters/001-楔子.md', {
        mode: 'overwrite',
        baseHash: '過期的hash',
      });
      assert.fail('該拋');
    } catch (err) {
      assert.equal(err instanceof G.WsConflictError, true);
      assert.equal(err instanceof G.WsError, true);
    }
  });

  // 檔案被刪了：當作新建處理，不攔（逐字沿用 fileEditing 的行為）。
  test('檔案不存在時 baseHash 不攔', async () => {
    const r = await G.guardWrite(project, 'chapters/011-剛刪的.md', {
      mode: 'overwrite',
      baseHash: '任意',
    });
    assert.equal(r.existed, false);
  });

  test('不傳 baseHash 就沒有樂觀鎖', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.equal(r.existed, true);
  });
});

describe('guardMutate · 存在性', () => {
  test('改不存在的東西報 notFound', async () => {
    assert.equal(await codeOf(() => G.guardMutate(project, 'chapters/查無此章.md')), 'notFound');
  });

  test('目錄能改名（不是 notFile）', async () => {
    t.write('chapters/第一卷/005-甲.md', 'x');
    const abs = await G.guardMutate(project, 'chapters/第一卷');
    assert.equal(abs, t.rel('chapters/第一卷'));
  });
});
