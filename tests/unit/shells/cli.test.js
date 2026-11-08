/**
 * 獨立版 CLI：不帶目錄時 root 為空，不再把 cwd 當成工程。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

const { parseArgs } = loadModule('src/shells/standalone/cli.ts');

describe('parseArgs', () => {
  test('無引數時 root 為 undefined', () => {
    assert.equal(parseArgs([]).root, undefined);
  });

  test('無引數時仍有預設埠並開啟瀏覽器', () => {
    const opts = parseArgs([]);
    assert.equal(opts.port, 36800);
    assert.equal(opts.open, true);
    assert.equal(opts.init, false);
    assert.equal(opts.verbose, false);
  });

  test('位置引數解析成絕對路徑', () => {
    const opts = parseArgs(['sample-novel']);
    assert.equal(opts.root, path.resolve('sample-novel'));
  });

  test('init 無目錄時 root 是 cwd', () => {
    const opts = parseArgs(['init']);
    assert.equal(opts.init, true);
    assert.equal(opts.root, path.resolve('.'));
  });

  test('init 帶目錄', () => {
    const opts = parseArgs(['init', '/tmp/book']);
    assert.equal(opts.init, true);
    assert.equal(opts.root, path.resolve('/tmp/book'));
  });

  test('無 root 時仍認 --port / --no-open / --verbose', () => {
    const opts = parseArgs(['--port', '4000', '--no-open', '--verbose']);
    assert.equal(opts.root, undefined);
    assert.equal(opts.port, 4000);
    assert.equal(opts.open, false);
    assert.equal(opts.verbose, true);
  });

  test('預設只綁本機，--host 改監聽地址', () => {
    assert.equal(parseArgs([]).host, '127.0.0.1');
    const opts = parseArgs(['--host', '0.0.0.0', '/books']);
    assert.equal(opts.host, '0.0.0.0');
    assert.equal(opts.root, path.resolve('/books'));
  });

  test('--host 後面沒給值時退回本機', () => {
    assert.equal(parseArgs(['--host']).host, '127.0.0.1');
  });
});
