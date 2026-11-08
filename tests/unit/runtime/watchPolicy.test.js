/**
 * 「哪些改動值得重新整理介面」這份策略。它從兩個殼裡收回 core 的那一刻起就該有測試：
 * 從前外掛殼的 7 條 glob 與獨立版的黑名單過濾各寫一份，改了一處忘了另一處，
 * 表現是「某個殼裡改了檔案介面不動」——這種事沒人會立刻聯想到監聽規則。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { watchGlobs, shouldIgnoreChange } = loadModule('src/core/watchPolicy.ts');

const CONFIG = { chaptersDir: 'chapters', draftsDir: 'drafts' };

describe('watchGlobs（吃 glob 的宿主）', () => {
  test('章節根有一條全量 glob——空目錄的增刪與非 .md 章節都靠它', () => {
    assert.ok(watchGlobs(CONFIG).includes('chapters/**'));
  });

  test('草稿目錄在監聽範圍內（手建的草稿要讓「有草稿」標記翻過來）', () => {
    assert.ok(watchGlobs(CONFIG).includes('drafts/**'));
  });

  test('跟著配置裡的目錄名走，不寫死 chapters/drafts', () => {
    const globs = watchGlobs({ chaptersDir: '正文', draftsDir: '草稿' });
    assert.ok(globs.includes('正文/**'));
    assert.ok(globs.includes('草稿/**'));
    assert.ok(!globs.some((g) => g.startsWith('chapters/')));
  });

  test('後設資料：project.json 與角色/設定兩區', () => {
    const globs = watchGlobs(CONFIG);
    assert.ok(globs.includes('.novelwarden/project.json'));
    assert.ok(globs.includes('.novelwarden/characters/**'));
    assert.ok(globs.includes('.novelwarden/lore/**'));
  });
});

describe('shouldIgnoreChange（吃事件流的宿主）', () => {
  test('放行 .md 章節', () => {
    assert.equal(shouldIgnoreChange('chapters/001-楔子.md'), false);
  });

  test('放行非 .md 的章節：.txt / 無副檔名', () => {
    assert.equal(shouldIgnoreChange('chapters/001-楔子.txt'), false);
    assert.equal(shouldIgnoreChange('chapters/001-楔子'), false);
  });

  test('放行目錄事件（沒有副檔名）', () => {
    assert.equal(shouldIgnoreChange('chapters/第一卷'), false);
  });

  test('擋掉二進位制：圖片、壓縮包、辦公檔案', () => {
    assert.equal(shouldIgnoreChange('chapters/封面.png'), true);
    assert.equal(shouldIgnoreChange('素材.zip'), true);
    assert.equal(shouldIgnoreChange('參考.docx'), true);
  });

  test('擋掉回收站——刪除是「搬進 .trash/」，不擋會多觸發一輪全量重掃', () => {
    assert.equal(shouldIgnoreChange('.novelwarden/.trash/chapters/003.md'), true);
  });

  test('擋掉歷史版本——閘道器每覆蓋一份產物就先存一版，不擋會每存一個快照多一輪全量重掃', () => {
    assert.equal(shouldIgnoreChange('.novelwarden/history/chapters/003.md/2026-10-18_14-32-05+0800.txt'), true);
    assert.equal(shouldIgnoreChange('.novelwarden/history'), true);
    assert.equal(shouldIgnoreChange('/home/me/書/.novelwarden/history/.gitignore'), true);
    assert.equal(shouldIgnoreChange('.novelwarden\\history\\chapters\\003.md'), true);
  });

  test('只擋 .novelwarden/history，不擋名字裡恰好帶 history 的章節與目錄', () => {
    assert.equal(shouldIgnoreChange('chapters/history/001-往事.md'), false);
    assert.equal(shouldIgnoreChange('.novelwarden/historyx.md'), false);
  });

  test('外掛殼的 glob 本來就掃不到快照（快照一律 .txt，.novelwarden 下只認 .md）', () => {
    const globs = watchGlobs(CONFIG);
    assert.ok(globs.includes('.novelwarden/**/*.md'));
    assert.ok(!globs.some((g) => g.startsWith('.novelwarden/history') || g === '.novelwarden/**'));
  });

  test('擋掉 node_modules', () => {
    assert.equal(shouldIgnoreChange('node_modules/foo/index.js'), true);
  });

  test('空檔名不擋（fs.watch 偶爾給不出 filename，寧可多刷一次）', () => {
    assert.equal(shouldIgnoreChange(''), false);
  });

  test('大小寫不敏感（Windows 上 .PNG 也該擋）', () => {
    assert.equal(shouldIgnoreChange('chapters/封面.PNG'), true);
  });
});
