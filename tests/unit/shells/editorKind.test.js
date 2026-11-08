/**
 * 獨立版內建編輯器的檔案負載帶 `kind`（`kindOfPath` 算的）：前端據此分「正文」（chapter / draft）
 * 與其餘檔案——Tab 縮排全形還是半形就看它，前端不自己拿路徑猜。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | `editorOpen` 帶 kind：章節、草稿、角色卡、工程外的隨手檔案各是各的 | 與閘道器同一張表 |
 * | `editorSaved` 也帶 kind | 前端的儲存分支會拿回執重新整理檔案，漏了等於儲存一次就忘了是正文 |
 * | 三條都帶 `label`（標籤上的短標記與名字、麵包屑） | 稱呼由後端算，前端不拿路徑猜；漏一條前端就退回原始路徑 |
 * | 開啟請求上的 `preview` / `replace` 原樣帶回 `editorOpen` | 臨時標籤與「原位換掉」由內建編輯器決定，後端不看 |
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
const { FileHost } = bundle.fileHost;

let dir;
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-editor-kind-'));
  put('chapters/001-雨夜.md', '# 雨夜\n\n林昭推開客棧的門。\n');
  put('drafts/001-雨夜.md', '草稿\n');
  put('.novelwarden/characters/林昭.md', '# 林昭\n');
  put('notes.txt', '隨手記\n');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function hostWith(sent) {
  return new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);
}

async function openKind(rel) {
  const sent = [];
  await hostWith(sent).openInEditor(rel);
  const msg = sent.find((m) => m.type === 'editorOpen');
  assert.ok(msg, JSON.stringify(sent));
  return msg.file.kind;
}

describe('內建編輯器的檔案負載帶 kind', () => {
  test('章節是 chapter', async () => {
    assert.equal(await openKind('chapters/001-雨夜.md'), 'chapter');
  });

  test('草稿是 draft', async () => {
    assert.equal(await openKind('drafts/001-雨夜.md'), 'draft');
  });

  test('角色卡是 character', async () => {
    assert.equal(await openKind('.novelwarden/characters/林昭.md'), 'character');
  });

  test('不在任何區裡的檔案是 other', async () => {
    assert.equal(await openKind('notes.txt'), 'other');
  });

  test('editorOpen 帶稱呼：正文不帶短標記、麵包屑寫第幾章', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('chapters/001-雨夜.md');
    const label = sent.find((m) => m.type === 'editorOpen').file.label;
    assert.deepEqual(label, {
      tag: '',
      title: '001-雨夜',
      crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 1 章 雨夜' }],
    });
  });

  test('草稿帶「草稿」，與同一章的正文分得清', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('drafts/001-雨夜.md');
    const label = sent.find((m) => m.type === 'editorOpen').file.label;
    assert.equal(label.tag, '草稿');
    assert.equal(label.title, '001-雨夜');
  });

  test('開啟請求上的 preview / replace 原樣帶回', async () => {
    const sent = [];
    await hostWith(sent).openInEditor('chapters/001-雨夜.md', 'draft', { preview: true, replace: 'chapters/000-舊.md' });
    const msg = sent.find((m) => m.type === 'editorOpen');
    assert.deepEqual(
      { pane: msg.pane, preview: msg.preview, replace: msg.replace },
      { pane: 'draft', preview: true, replace: 'chapters/000-舊.md' }
    );
  });

  test('沒帶標記的開啟：editorOpen 上也沒有（正常標籤）', async () => {
    const sent = [];
    await hostWith(sent).openFile('chapters/001-雨夜.md');
    const msg = sent.find((m) => m.type === 'editorOpen');
    assert.equal('preview' in msg, false);
    assert.equal('replace' in msg, false);
  });

  test('openFile / openBeside 把 preview 傳下去', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.openFile('chapters/001-雨夜.md', { preview: true });
    await host.openBeside('drafts/001-雨夜.md', { preview: true });
    const opens = sent.filter((m) => m.type === 'editorOpen');
    assert.deepEqual(opens.map((m) => [m.file.path, m.pane, m.preview]), [
      ['chapters/001-雨夜.md', undefined, true],
      ['drafts/001-雨夜.md', 'draft', true],
    ]);
  });

  test('儲存回執也帶 kind', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.saveFromEditor('chapters/001-雨夜.md', '# 雨夜\n\n改過了。\n');
    const msg = sent.find((m) => m.type === 'editorSaved');
    assert.ok(msg, JSON.stringify(sent));
    assert.equal(msg.file.kind, 'chapter');
  });

  test('儲存回執與磁碟核對的新版也帶稱呼', async () => {
    const sent = [];
    const host = hostWith(sent);
    await host.saveFromEditor('.novelwarden/characters/林昭.md', '# 林昭\n\n改過。\n');
    assert.equal(sent.find((m) => m.type === 'editorSaved').file.label.tag, '角色');
    await host.checkEditorFiles([{ path: '.novelwarden/characters/林昭.md', hash: 'stale' }]);
    const changed = sent.find((m) => m.type === 'editorDiskChanged');
    assert.ok(changed, JSON.stringify(sent.map((m) => m.type)));
    assert.equal(changed.file.label.title, '林昭');
  });
});
