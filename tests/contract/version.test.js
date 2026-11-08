/**
 * 版本號只記一處：倉庫根 `package.json`。
 *
 * 從前三處各記一份（`package.json` / `tauri.conf.json` / `Cargo.toml`），發版時 CI 再
 * 一處處改過去，漏一處安裝包上的版本號就是舊的。現在 `npm version` 只改 `package.json`，
 * 別的地方都從它來——這幾條釘的是「別處沒有偷偷長回第二份」：
 *
 * | 用例 | 釘的是什麼 |
 * |---|---|
 * | tauri.conf.json 指向 package.json | Tauri 照**它所在目錄**解析這個路徑（CLI 讀配置時先切進那個目錄）；路徑不存在時它會把這串字當版本號解析，直接報錯 |
 * | Cargo.toml 是 0.0.0 | 那裡的值不被任何地方讀，寫個像樣的數只會讓人以為它是版本號 |
 * | 版本號是 X.Y.Z | release.yml 只認這個形狀（Windows MSI 不認帶字母的預釋出號） |
 * | Android 的版本取自 package.json | app/build.gradle 照 `rootProject` 解析那個相對路徑；寫死 versionName 就又長出了第二份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const DESKTOP = path.join(ROOT, 'src', 'shells', 'desktop');
const ANDROID = path.join(ROOT, 'src', 'shells', 'android');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('版本號只記在 package.json', () => {
  test('tauri.conf.json 的 version 指向倉庫根 package.json', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'tauri.conf.json'), 'utf8'));
    assert.equal(path.resolve(DESKTOP, conf.version), path.join(ROOT, 'package.json'), conf.version);
  });

  test('Cargo.toml 的 version 是佔位的 0.0.0', () => {
    const cargo = fs.readFileSync(path.join(DESKTOP, 'Cargo.toml'), 'utf8');
    assert.match(cargo, /^version = "0\.0\.0"$/m);
  });

  test('Android 的 versionName / versionCode 取自倉庫根 package.json', () => {
    const gradle = fs.readFileSync(path.join(ANDROID, 'app', 'build.gradle'), 'utf8');
    const m = /rootProject\.file\('([^']+)'\)/.exec(gradle);
    assert.ok(m, 'build.gradle 裡沒有讀 package.json');
    // rootProject 是 settings.gradle 所在的目錄
    assert.equal(path.resolve(ANDROID, m[1]), path.join(ROOT, 'package.json'), m[1]);
    assert.match(gradle, /versionName appVersion/);
    assert.doesNotMatch(gradle, /versionName\s+['"]/);
  });

  test('package.json 的版本號是 X.Y.Z', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  });
});
