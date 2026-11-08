/**
 * 獨立版的覆蓋審閱（五期 W11 的後端一半）：推一條 `prompt kind: 'merge'`，等網頁的合併檢視回話。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 推出去的帶兩個版本與能不能合併 | 合併檢視照它畫 |
 * | 請求了合併才認 `merged` | 沒請求的呼叫方（角色卡那幾處）收不下一份作者拼出來的文字 |
 * | 認不出、沒回答 → 取消 | 寧可這一次不寫 |
 * | 定位引文：找得到才推 `editorReveal` | 找不到時只開啟檔案，由 controller 提示 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');

const bundle = loadBundle({
  fileHost: './src/shells/standalone/fileHost.ts',
  stores: './src/core/stores.ts',
});
const { FileHost, parseMergeReply } = bundle.fileHost;

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-merge-'));
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chapters', '001-雨夜.md'), '# 雨夜\n\n林昭推開客棧的門。\n');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function hostWith(sent) {
  return new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);
}

describe('parseMergeReply', () => {
  test('請求了合併：交回挑過的那一份', () => {
    assert.deepEqual(parseMergeReply('{"verdict":"apply","merged":"甲"}', true), { merged: '甲' });
  });
  test('沒請求合併：merged 不認，只算採納', () => {
    assert.equal(parseMergeReply('{"verdict":"apply","merged":"甲"}', false), 'apply');
  });
  test('放棄、取消、認不出', () => {
    assert.equal(parseMergeReply('{"verdict":"discard"}', true), 'discard');
    assert.equal(parseMergeReply(undefined, true), undefined);
    assert.equal(parseMergeReply('yes', true), undefined);
    assert.equal(parseMergeReply('{"verdict":"maybe"}', true), undefined);
  });
});

describe('FileHost.reviewReplace', () => {
  test('推一條 merge 詢問，帶兩個版本；回話之後交回合併結果', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.reviewReplace('第 1 章的正文', '舊', '新', 'chapters/001-雨夜.md', { merge: true });
    const msg = sent.find((m) => m.type === 'prompt');
    assert.equal(msg.kind, 'merge');
    assert.equal(msg.current, '舊');
    assert.equal(msg.proposed, '新');
    assert.equal(msg.mergeable, true);
    assert.match(msg.title, /第 1 章的正文/);
    host.prompts.resolve(msg.requestId, { value: JSON.stringify({ verdict: 'apply', merged: '合' }) });
    assert.deepEqual(await pending, { merged: '合' });
  });

  test('沒請求合併：只讀', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.reviewReplace('角色卡', '舊', '新');
    const msg = sent.find((m) => m.type === 'prompt');
    assert.equal(msg.mergeable, false);
    host.prompts.resolve(msg.requestId, { value: JSON.stringify({ verdict: 'apply' }) });
    assert.equal(await pending, 'apply');
  });
});

describe('FileHost.mergeTexts', () => {
  test('不給稱呼：與從前一樣（可合併、沒有 sides / applyLabel）', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.mergeTexts('刪修飾：刪之前 ↔ 刪之後', '前', '後');
    const msg = sent.find((m) => m.type === 'prompt');
    assert.equal(msg.kind, 'merge');
    assert.equal(msg.mergeable, true);
    assert.equal(msg.sides, undefined);
    assert.equal(msg.applyLabel, undefined);
    host.prompts.resolve(msg.requestId, { value: JSON.stringify({ verdict: 'apply' }) });
    assert.equal(await pending, 'apply');
  });

  test('給了稱呼：兩欄、採納按鈕與標題下那一行原樣帶給合併檢視', async () => {
    const sent = [];
    const host = hostWith(sent);
    const pending = host.mergeTexts('對比合併', '磁碟', '編輯器', {
      sides: { before: '磁碟上的', after: '編輯器裡的' },
      applyLabel: '放回編輯器',
      message: 'chapters/001-雨夜.md',
    });
    const msg = sent.find((m) => m.type === 'prompt');
    assert.deepEqual(msg.sides, { current: '磁碟上的', proposed: '編輯器裡的' });
    assert.equal(msg.applyLabel, '放回編輯器');
    assert.equal(msg.message, 'chapters/001-雨夜.md');
    assert.equal(msg.current, '磁碟');
    assert.equal(msg.proposed, '編輯器');
    host.prompts.resolve(msg.requestId, { value: JSON.stringify({ verdict: 'apply', merged: '合' }) });
    assert.deepEqual(await pending, { merged: '合' });
  });
});

describe('FileHost.revealText', () => {
  test('找得到：先開啟，再推 editorReveal', async () => {
    const sent = [];
    const ok = await hostWith(sent).revealText('chapters/001-雨夜.md', '林昭推開客棧');
    assert.equal(ok, true);
    assert.deepEqual(sent.map((m) => m.type), ['editorOpen', 'editorReveal']);
    assert.equal(sent[1].quote, '林昭推開客棧');
  });

  test('找不到：只開啟，返回 false', async () => {
    const sent = [];
    const ok = await hostWith(sent).revealText('chapters/001-雨夜.md', '根本沒有這一句');
    assert.equal(ok, false);
    assert.deepEqual(sent.map((m) => m.type), ['editorOpen']);
  });
});
