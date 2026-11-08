/**
 * 內建編輯器的磁碟核對與「磁碟上沒了」（後端一半）：`files/fileEditing.ts` 的 `checkEditorFiles` /
 * `writeFileFromEditor`，以及獨立版 `FileHost` 推出去的 `editorDiskChanged` / `editorDiskGone`。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | hash 對不上的回新版、讀不到的報沒了、對得上的不回 | 前端據此就地換掉沒改過的標籤、給改過的掛衝突條 |
 * | 越界、不可編輯、壞條目跳過、不拋 | 一條壞訊息不該讓整批作廢，也不該讀到工程外面去 |
 * | 只讀，一個位元組都不寫 | 每條 `state` 之後都會核對一次 |
 * | 帶了基線、檔案卻不在：不在原路徑重建，報沒了 | 閘道器對這種情況是當新建處理的；作者在外面改的名會白改 |
 * | 答應重建才寫；期間原路徑又有了別的內容照樣撞衝突 | 重建也帶著樂觀鎖 |
 * | 編輯器自己存下去的那份再核對不報「變了」 | 自己儲存之後不誤報 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');

const bundle = loadBundle({
  fileHost: './src/shells/standalone/fileHost.ts',
  fileEditing: './src/core/files/fileEditing.ts',
  fsModel: './src/core/model/fs.ts',
  stores: './src/core/stores.ts',
});
const { FileHost } = bundle.fileHost;
const { checkEditorFiles, writeFileFromEditor, FileGoneError, FileConflictError } = bundle.fileEditing;
const { hash } = bundle.fsModel;

let dir;
const abs = (rel) => path.join(dir, rel);
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
};
const hostWith = (sent) => new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m), dir);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-editor-disk-'));
  put('chapters/001-雨夜.md', '# 雨夜\n\n林昭推開客棧的門。\n');
  put('.novelwarden/summaries/001-雨夜.md', '# 雨夜\n\n## 梗概\n林昭進客棧。\n');
  put('notes.txt', '隨手記\n');
  put('pic.png', 'not really a png');
  fs.mkdirSync(abs('chapters/002-目錄'), { recursive: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkEditorFiles：按 hash 核對開著的幾份', () => {
  const ch = 'chapters/001-雨夜.md';

  test('對得上：什麼都不報', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: hash(fs.readFileSync(abs(ch), 'utf8')) }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('對不上：報磁碟上的新版，path 原樣用前端給的', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: 'h-old' }]);
    assert.equal(r.changed.length, 1);
    assert.equal(r.changed[0].path, ch);
    assert.equal(r.changed[0].name, '001-雨夜.md');
    assert.equal(r.changed[0].text, fs.readFileSync(abs(ch), 'utf8'));
    assert.equal(r.changed[0].hash, hash(r.changed[0].text));
  });

  test('前端給空 hash（它以為沒了）而檔案在：照樣報新版', async () => {
    const r = await checkEditorFiles(dir, [{ path: ch, hash: '' }]);
    assert.equal(r.changed.length, 1);
  });

  test('讀不到（被刪、被改名）：報沒了', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'chapters/009-刪了的.md', hash: 'h' }]);
    assert.deepEqual(r.gone, ['chapters/009-刪了的.md']);
  });

  test('那個路徑現在是個目錄：也算沒了', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'chapters/002-目錄', hash: 'h' }]);
    assert.deepEqual(r.gone, ['chapters/002-目錄']);
  });

  test('越界路徑跳過、不拋', async () => {
    const r = await checkEditorFiles(dir, [{ path: '../escape.md', hash: 'h' }, { path: '/etc/passwd.md', hash: 'h' }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('不可編輯的副檔名跳過', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'pic.png', hash: 'h' }]);
    assert.deepEqual(r, { changed: [], gone: [] });
  });

  test('壞條目跳過，其餘照常', async () => {
    const r = await checkEditorFiles(dir, [null, { path: 3, hash: 'h' }, { path: 'notes.txt' }, { path: 'notes.txt', hash: 'h' }]);
    assert.deepEqual(r.changed.map((f) => f.path), ['notes.txt']);
  });

  test('同一路徑給兩次只報一次', async () => {
    const r = await checkEditorFiles(dir, [{ path: 'notes.txt', hash: 'h' }, { path: 'notes.txt', hash: 'h2' }]);
    assert.equal(r.changed.length, 1);
  });

  test('只讀：核對完磁碟上一個位元組都沒動', async () => {
    const before = fs.statSync(abs(ch)).mtimeMs;
    const content = fs.readFileSync(abs(ch), 'utf8');
    await checkEditorFiles(dir, [{ path: ch, hash: 'h-old' }, { path: 'chapters/009-刪了的.md', hash: 'h' }]);
    assert.equal(fs.statSync(abs(ch)).mtimeMs, before);
    assert.equal(fs.readFileSync(abs(ch), 'utf8'), content);
    assert.equal(fs.existsSync(abs('chapters/009-刪了的.md')), false);
  });
});

describe('writeFileFromEditor：帶了基線、檔案卻不在', () => {
  const rel = 'chapters/003-改了名的.md';

  test('不在原路徑重建，拋「沒了」', async () => {
    await assert.rejects(writeFileFromEditor(dir, rel, '編輯器裡的內容', 'h-base'), (err) => err instanceof FileGoneError);
    assert.equal(fs.existsSync(abs(rel)), false);
  });

  test('答應重建（recreate）才寫', async () => {
    const r = await writeFileFromEditor(dir, rel, '編輯器裡的內容', 'h-base', { recreate: true });
    assert.equal(fs.readFileSync(abs(rel), 'utf8'), '編輯器裡的內容');
    assert.equal(r.hash, hash('編輯器裡的內容'));
  });

  test('答應重建時原路徑已經又有了別的內容：照樣撞衝突、不覆蓋', async () => {
    const other = 'chapters/004-又有了.md';
    put(other, '別處放回來的');
    await assert.rejects(
      writeFileFromEditor(dir, other, '編輯器裡的內容', 'h-base', { recreate: true }),
      (err) => err instanceof FileConflictError && err.diskText === '別處放回來的'
    );
    assert.equal(fs.readFileSync(abs(other), 'utf8'), '別處放回來的');
  });

  test('不帶基線（作者點了強制儲存）照舊直接寫', async () => {
    const forced = 'chapters/005-強制.md';
    await writeFileFromEditor(dir, forced, '強制寫的');
    assert.equal(fs.readFileSync(abs(forced), 'utf8'), '強制寫的');
  });
});

describe('FileHost：推給前端的訊息', () => {
  test('磁碟上變了：editorDiskChanged 帶 draftPath 與 kind（與 editorOpen 同一個形狀）', async () => {
    const sent = [];
    await hostWith(sent).checkEditorFiles([{ path: 'chapters/001-雨夜.md', hash: 'h-old' }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'editorDiskChanged');
    assert.equal(sent[0].file.kind, 'chapter');
    assert.equal(sent[0].file.draftPath, 'drafts/001-雨夜.md');
  });

  test('讀不到：editorDiskGone', async () => {
    const sent = [];
    await hostWith(sent).checkEditorFiles([{ path: 'chapters/009-刪了的.md', hash: 'h' }]);
    assert.deepEqual(sent, [{ type: 'editorDiskGone', path: 'chapters/009-刪了的.md' }]);
  });

  test('都對得上：一條都不推', async () => {
    const sent = [];
    const text = fs.readFileSync(abs('notes.txt'), 'utf8');
    await hostWith(sent).checkEditorFiles([{ path: 'notes.txt', hash: hash(text) }]);
    assert.deepEqual(sent, []);
  });

  test('儲存時檔案已經不在：推 editorDiskGone，什麼都不寫', async () => {
    const sent = [];
    await hostWith(sent).saveFromEditor('chapters/006-沒了.md', '內容', 'h-base');
    assert.deepEqual(sent, [{ type: 'editorDiskGone', path: 'chapters/006-沒了.md' }]);
    assert.equal(fs.existsSync(abs('chapters/006-沒了.md')), false);
  });

  test('帶 recreate 再來：寫下去，回 editorSaved', async () => {
    const sent = [];
    await hostWith(sent).saveFromEditor('chapters/006-沒了.md', '內容', 'h-base', { recreate: true });
    assert.equal(sent[0]?.type, 'editorSaved');
    assert.equal(fs.readFileSync(abs('chapters/006-沒了.md'), 'utf8'), '內容');
  });

  test('自己存下去的那份再核對：不報「變了」', async () => {
    const sent = [];
    const host = hostWith(sent);
    const rel = 'chapters/001-雨夜.md';
    const base = hash(fs.readFileSync(abs(rel), 'utf8'));
    await host.saveFromEditor(rel, '# 雨夜\n\n改過了。\n', base);
    const saved = sent.find((m) => m.type === 'editorSaved');
    assert.ok(saved, JSON.stringify(sent));
    sent.length = 0;
    await host.checkEditorFiles([{ path: rel, hash: saved.file.hash }]);
    assert.deepEqual(sent, []);
  });

  test('沒開啟工程時什麼都不推', async () => {
    const sent = [];
    await new FileHost(new bundle.stores.FileConfigStore(), (m) => sent.push(m)).checkEditorFiles([{ path: 'a.md', hash: 'h' }]);
    assert.deepEqual(sent, []);
  });
});
