/**
 * 獨立版入口：`bun run src/shells/standalone/main.ts [dir]` 或
 * `bun build --compile` 出的單檔案可執行檔案。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirBaseName, initProjectFlow } from '../../core/actions';
import { initHost } from '../../core/host';
import { NovelProject } from '../../core/model/project';
import { FileConfigStore } from '../../core/stores';
import { tokenFromEnv, exposureError } from './auth';
import { parseArgs } from './cli';
import { startServer } from './server';
import { openWithSystem } from './systemOpen';
import { TerminalHost } from './terminalHost';

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.init) {
    // CLI 互動式 init：終端問答後寫盤，不開服務。
    // 流程本身**複用 core 的 initProjectFlow**——外掛命令、網頁按鈕走的是同一條，
    // 這裡只是換了個把問答接到終端上的 Host。
    const host = new TerminalHost(new FileConfigStore());
    initHost(host);
    const root = opts.root ?? path.resolve('.');
    const project = NovelProject.open(root);
    try {
      if (await initProjectFlow(project, dirBaseName(project))) {
        console.log(`已初始化：${path.join(root, '.novelwarden')}`);
      }
    } finally {
      host.close();
    }
    process.exit(0);
  }

  if (opts.root && !hasProject(opts.root)) {
    console.log(`提示：目錄還不是小說工程：${opts.root}`);
    console.log('可先跑 novelwarden init，或在網頁上點「初始化工程」。');
  }

  // 綁非迴環地址卻沒配令牌：寧可起不來，也不要讓別的機器免密連進來。
  const token = tokenFromEnv();
  const exposure = exposureError(opts.host, token);
  if (exposure) {
    console.error(exposure);
    process.exit(1);
  }

  // 埠被佔時順延，最多試 20 次。
  let port = opts.port;
  for (let i = 0; ; i++) {
    try {
      port = await startServer({ root: opts.root, port, host: opts.host, token, verbose: opts.verbose });
      break;
    } catch (err) {
      if (i >= 20) {
        throw err;
      }
      port++;
    }
  }

  if (opts.open) {
    openWithSystem(`http://127.0.0.1:${port}/`);
  }
}

void main();

/** 三個後設資料目錄都算小說工程：新名 `.novelwarden/`，舊名 `.novelforge/` 與 `.novel/` 繼續能開啟。 */
function hasProject(root: string): boolean {
  return ['.novelwarden', '.novelforge', '.novel'].some((dir) =>
    fs.existsSync(path.join(root, dir, 'project.json'))
  );
}
