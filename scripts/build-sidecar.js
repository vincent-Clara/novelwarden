/**
 * 把獨立版編譯成**帶 target triple 字尾**的單檔案可執行，放進 `src-tauri/binaries/`，
 * 供桌面殼（Tauri）當 sidecar 打包。
 *
 * 與 `npm run dist` 是同一件事、同一份產物，只有落點和檔名不同：Tauri 的
 * `externalBin` 約定「同名 + `-<target triple>` 字尾」，找不到就直接構建失敗。
 *
 * 交叉編譯由 Bun 自己完成（`--target=bun-windows-x64` 等），所以在 WSL2 裡也能
 * 出 Windows 的 sidecar。但**Tauri 的 Rust 殼不能這樣交叉編譯**——Windows 安裝包
 * 仍要在 Windows 上（或 CI 的 windows runner 上）構建，見 .github/workflows/app.yml。
 *
 * 用法：
 *   node scripts/build-sidecar.js            # 當前平臺
 *   node scripts/build-sidecar.js linux
 *   node scripts/build-sidecar.js windows
 *   node scripts/build-sidecar.js all
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join('src', 'shells', 'standalone', 'main.ts');
const OUT_DIR = path.join(ROOT, 'src', 'shells', 'desktop', 'binaries');

/** sidecar 的基名。必須與 tauri.conf.json 的 `externalBin` 末段一致。 */
const BASE = 'novelwarden';

/**
 * 目標平臺表。加一個平臺就在這裡加一行，同時記得在 CI 的 matrix 里加一臺 runner
 * ——sidecar 能交叉編譯，Rust 殼不能。
 */
const TARGETS = {
  linux: {
    bunTarget: 'bun-linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    ext: '',
    nativeOnlyArgs: [],
  },
  windows: {
    bunTarget: 'bun-windows-x64',
    triple: 'x86_64-pc-windows-msvc',
    ext: '.exe',
    // sidecar 是後臺程序，不該閃出命令列視窗。這兩個開關 Bun 只在**Windows 上
    // 編譯時**接受（在 Linux 上交叉編譯會直接報錯），所以只有原生構建才加。
    // 少了它也無妨：Tauri spawn sidecar 時本來就帶 CREATE_NO_WINDOW，這只是
    // 第二道保險（順帶讓手動雙擊時不至於莫名彈窗）。CI 的 windows runner 是
    // 原生構建，所以正式產物裡這兩個開關是生效的。
    nativeOnlyArgs: ['--windows-hide-console', '--windows-title=Novelwarden 服務'],
  },
};

function hostKey() {
  if (process.platform === 'win32') {
    return 'windows';
  }
  if (process.platform === 'linux') {
    return 'linux';
  }
  throw new Error(`當前平臺還沒有 sidecar 目標：${process.platform}（在 TARGETS 里加一行）`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 退出碼 ${r.status}`);
  }
}

function buildOne(key) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`未知目標 "${key}"，可選：${Object.keys(TARGETS).join(' / ')} / all`);
  }
  const outfile = path.join(OUT_DIR, `${BASE}-${target.triple}${target.ext}`);
  const native = key === hostKey();
  if (!native && target.nativeOnlyArgs.length > 0) {
    console.log(`  （交叉編譯，跳過 ${target.nativeOnlyArgs.join(' ')}——Bun 只在原生構建時接受）`);
  }
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    ...(native ? target.nativeOnlyArgs : []),
    `--outfile=${outfile}`,
    ENTRY,
  ]);
  const mb = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${path.relative(ROOT, outfile)}（${mb} MB）`);
}

function main() {
  const arg = process.argv[2] ?? 'host';
  const keys = arg === 'all' ? Object.keys(TARGETS) : [arg === 'host' ? hostKey() : arg];

  // 前端資源要先內嵌進 mediaAssets.ts，否則編出來的可執行檔案找不到 view.js。
  // 與 `npm run dist` 同一條前置，不能省。
  run(process.execPath, [path.join('scripts', 'embed-media.js')]);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const key of keys) {
    buildOne(key);
  }
}

try {
  main();
} catch (err) {
  console.error(`✘ ${err.message}`);
  process.exit(1);
}
