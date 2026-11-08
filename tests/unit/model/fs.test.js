const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

describe('model/fs.ts · 磁碟與字串工具', () => {
  let utils;
  let tempDir;

  before(() => {
    utils = loadModule('src/core/model/fs.ts');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-fs-'));
  });

  after(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('hash 統一 CRLF 與 LF', () => {
    assert.equal(utils.hash('第一行\r\n第二行'), utils.hash('第一行\n第二行'));
  });

  test('countWords 對中文按字、英文按詞計數', () => {
    assert.equal(utils.countWords('林昭 meets Alice 2'), 5);
  });

  test('sanitizeFileName 剝除非法字元', () => {
    assert.equal(utils.sanitizeFileName(' 章:一/夜? '), '章一夜');
  });

  test('slugify 將 ASCII 轉成小寫', () => {
    assert.equal(utils.slugify('Hero Name'), 'hero-name');
  });

  test('isIgnoredDir 忽略 .trash 與 node_modules', () => {
    assert.equal(utils.isIgnoredDir('.trash'), true);
    assert.equal(utils.isIgnoredDir('node_modules'), true);
    assert.equal(utils.isIgnoredDir('卷一'), false);
  });

  test('uniqueSlug 在檔名衝突時追加 -2', async () => {
    fs.writeFileSync(path.join(tempDir, 'hero.md'), '');
    assert.equal(await utils.uniqueSlug(tempDir, 'hero'), 'hero-2');
  });

  // readTextIfExists 取代了「exists() 再 readText()」兩步走：省一次 stat，
  // 也堵掉「查到了、讀之前檔案被刪掉」的競態（作者隨時在手改檔案）。
  test('readTextIfExists 讀得到已有檔案', async () => {
    const p = path.join(tempDir, '有的.md');
    fs.writeFileSync(p, '內容', 'utf8');
    assert.equal(await utils.readTextIfExists(p), '內容');
  });

  test('readTextIfExists 對不存在的檔案給 undefined 而不拋', async () => {
    assert.equal(await utils.readTextIfExists(path.join(tempDir, '沒有的.md')), undefined);
  });

  test('readTextIfExists 把目錄當讀不到，不把異常漏給呼叫方', async () => {
    // 「不存在」與「這不是個檔案」對呼叫方是同一件事：這一章沒有細綱。
    const dir = path.join(tempDir, '一個目錄');
    fs.mkdirSync(dir, { recursive: true });
    await assert.doesNotReject(() => utils.readTextIfExists(dir));
  });
});
