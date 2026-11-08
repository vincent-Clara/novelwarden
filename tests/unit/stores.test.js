/**
 * 配置與金鑰放在哪：新裝 `~/.novelwarden`；`NOVELWARDEN_HOME` 能把它挪走。
 *
 * 相容：舊裝的 `~/.novelforge/` 與 `NOVELFORGE_HOME` 繼續 fallback——升級之後不能
 * 讓作者忽然讀不到自己的配置。測試一律把 HOME 指到臨時目錄，不碰真實主目錄。
 */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../helpers/load');

const { homeDir, FileConfigStore } = loadModule('src/core/stores.ts');

const ENV_KEYS = ['HOME', 'USERPROFILE', 'NOVELWARDEN_HOME', 'NOVELFORGE_HOME'];
let home;
let saved;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-home-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NOVELWARDEN_HOME;
  delete process.env.NOVELFORGE_HOME;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('homeDir', () => {
  test('新裝預設是家目錄下的 .novelwarden', () => {
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });

  test('NOVELWARDEN_HOME 給了就用它，配置檔案跟著走', () => {
    const dir = path.join(os.tmpdir(), 'nf-home-override');
    process.env.NOVELWARDEN_HOME = dir;
    assert.equal(homeDir(), dir);
    assert.equal(new FileConfigStore().filePath, path.join(dir, 'config.json'));
  });

  test('空白的 NOVELWARDEN_HOME 當沒給', () => {
    process.env.NOVELWARDEN_HOME = '  ';
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });

  test('舊變數 NOVELFORGE_HOME 仍能挪走配置（升級不斷檔）', () => {
    const dir = path.join(os.tmpdir(), 'nf-home-legacy-override');
    process.env.NOVELFORGE_HOME = dir;
    assert.equal(homeDir(), dir);
    assert.equal(new FileConfigStore().filePath, path.join(dir, 'config.json'));
  });

  test('兩個變數都給時 NOVELWARDEN_HOME 優先', () => {
    process.env.NOVELWARDEN_HOME = path.join(os.tmpdir(), 'nf-home-new');
    process.env.NOVELFORGE_HOME = path.join(os.tmpdir(), 'nf-home-old');
    assert.equal(homeDir(), path.join(os.tmpdir(), 'nf-home-new'));
  });

  test('舊目錄 ~/.novelforge 還在、新目錄沒建時繼續用它', () => {
    fs.mkdirSync(path.join(home, '.novelforge'));
    assert.equal(homeDir(), path.join(home, '.novelforge'));
  });

  test('新舊目錄都在時用新的 ~/.novelwarden', () => {
    fs.mkdirSync(path.join(home, '.novelforge'));
    fs.mkdirSync(path.join(home, '.novelwarden'));
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });
});
