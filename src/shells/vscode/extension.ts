import * as vscode from 'vscode';
import * as path from 'node:path';
import { initProjectFlow, newPlotFlow } from '../../core/actions';
import { characterChoices, plotChoices } from '../../core/choices';
import { ChatController } from '../../core/controller';
import { promoteModel, setLegacyConfigReader } from '../../core/config';
import { extractCharacters, newCharacter, newLore } from '../../core/features/characters';
import { updateCharacterCard } from '../../core/features/characterCard';
import { buildLoreEntries, integrateLore, organizeLore } from '../../core/features/lore';
import { recordLore } from '../../core/features/loreRecord';
import { newFolder, sectionRoots } from '../../core/files/fileOps';
import { extractStyle } from '../../core/features/style';
import { rebuildGlobalSummary, syncSummaries } from '../../core/features/summarize';
import { finalizeChapterTask } from '../../core/features/finalize';
import { getHost, initHost } from '../../core/host';
import { addLogSink, describeError, formatLogEntry, recentLogs, scoped } from '../../core/runtime/logger';
import { clearApiKey, initSecrets, pickModelRef, promptForApiKey, registerProviderFactory } from '../../core/llm/registry';
import { NovelProject } from '../../core/model/project';
import { providerLabel } from '../../core/model/providers';
import { parsePlotFileName } from '../../core/model/plotFile';
import { Chapter } from '../../core/model/types';
import { ChatPanel } from './chatPanel';
import { ChatViewProvider } from './chatViewProvider';
import { quickContinue } from './quickContinue';
import { legacySettingsReader, migrateVscodeSettings } from './migrate';
import { FileConfigStore, FileSecretStore } from '../../core/stores';
import { VsCodeHost } from './vscodeHost';
import { VsCodeLmProvider } from './vscodeLmProvider';
import { OUTLINE_SCHEME, OutlineFileSystem } from './outlineFs';

const log = scoped('外掛');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 輸出面板要最先建：啟用途中（遷移、offerMigration）就已經在打日誌了，
  // 晚註冊的話那幾條只進緩衝、不進面板。緩衝裡的先補一遍即可。
  registerOutputChannel(context);

  // 老使用者的 settings.json / SecretStorage 一次性搬到 ~/.novelwarden/，之後雙殼共用檔案後端。
  await migrateVscodeSettings(context.secrets);
  initHost(new VsCodeHost(new FileConfigStore()));
  setLegacyConfigReader(legacySettingsReader);
  initSecrets(new FileSecretStore());
  registerProviderFactory((active) => new VsCodeLmProvider(active.model.name, providerLabel(active.profile)));

  const project = currentProject();
  log.info(
    `外掛已啟用${project ? '' : '（無工作區）'}`,
    project ? `工程根 ${project.root}` : '開啟一個資料夾後功能才可用'
  );
  if (project) {
    await offerMigration(project);
  }
  const chat = project ? new ChatController(project) : undefined;

  if (chat) {
    const viewProvider = new ChatViewProvider(context.extensionUri, chat);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
        // 側邊欄被摺疊時保留 webview 狀態，否則草稿和流式內容會丟。
        webviewOptions: { retainContextWhenHidden: true },
      }),
      { dispose: () => chat.dispose() }
    );
  } else {
    // 沒有工作區就沒有 controller，但檢視仍在活動欄裡掛著。
    // 不註冊 provider 的話它會一直空轉，使用者看不出是缺了什麼。
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, {
        resolveWebviewView(view) {
          view.webview.html = NO_WORKSPACE_HTML;
        },
      })
    );
  }

  if (project) {
    await setInitializedContext(project);
    registerWatcher(context, project, chat);
    registerOutlineFs(context, project);
  }

  const refresh = async () => {
    project?.invalidate();
    await chat?.pushState();
    if (project) {
      await setInitializedContext(project);
    }
  };

  const register = (command: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: any[]) => {
        try {
          await handler(...args);
        } catch (err) {
          if ((err as Error)?.name === 'CancelledError') {
            return;
          }
          // 命令是最外層：到這裡還沒被接住的異常，除了彈窗還要留在日誌裡。
          // 彈窗走 Host.toast 而不是直接調 window.showErrorMessage——殼自己的
          // 提示也該經那一個出口，否則「提示長什麼樣」會有兩份實現。
          log.error(`命令 ${command} 執行失敗：${describeError(err)}`, err);
          getHost().toast(describeError(err), 'error');
        }
      })
    );
  };

  // ---------------------------------------------------------------- 工程

  register('novel.initProject', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    await initProjectFlow(target, workspaceName());
    await refresh();
  });

  register('novel.refresh', refresh);

  register('novel.openFile', async (relPath: string) => {
    const target = currentProject();
    if (!target || !relPath) {
      return;
    }
    const uri = vscode.Uri.file(target.pathOf(relPath));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  });

  register('novel.newPlot', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    // 有面板就走面板那條路：建完會落到這一章的當前步驟（多半是「寫第 N 章細綱」）。
    // 沒有面板（無工作區時 controller 不存在）只建檔案。
    if (chat) {
      await chat.newPlotFromCommand();
    } else {
      await newPlotFlow(target);
    }
    await refresh();
  });

  register('novel.newCharacter', async () => {
    const target = await requireProject();
    if (target) {
      await newCharacter(target);
      await refresh();
    }
  });

  register('novel.newLore', async () => {
    const target = await requireProject();
    if (target) {
      await newLore(target);
      await refresh();
    }
  });

  register('novel.newFolder', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    // 命令面板沒有落點，先問建到哪個區——與工程頁工具欄上的按鈕同一條路徑。
    const section = await getHost().pick(
      sectionRoots(target).map((s) => ({ label: s.label, detail: `${s.root}/`, value: s.section })),
      '在哪個區新建資料夾？'
    );
    if (section) {
      await newFolder(target, section);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 模型

  register('novel.setApiKey', (providerId?: string) => promptForApiKey(providerId));
  register('novel.clearApiKey', (providerId?: string) => clearApiKey(providerId));

  register('novel.selectModel', async () => {
    const ref = await pickModelRef();
    if (!ref) {
      return;
    }
    await promoteModel(ref);
    await chat?.pushState();
    getHost().toast(`已切換到 ${ref}`);
  });

  // ---------------------------------------------------------------- 續寫

  register('novel.continue', async () => {
    const target = await requireProject();
    if (target) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  });

  register('novel.openChatInEditor', async () => {
    const target = await requireProject();
    if (target && chat) {
      ChatPanel.show(context.extensionUri, chat);
    }
  });

  register('novel.newSession', async () => {
    const target = await requireProject();
    if (target && chat) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await chat.newSessionFromCommand();
    }
  });

  register('novel.openSettings', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('settings');
  });

  register('novel.openProject', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('project');
  });

  register('novel.openLogs', async () => {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await chat?.showTab('logs');
  });

  register('novel.showOutputChannel', () => {
    // 面板裡的日誌與網頁裡的是同一份，只是這條走 VS Code 原生輸出面板，
    // 可以跟其他擴充套件的日誌並排看，也能整段複製。
    outputChannel?.show(true);
  });

  register('novel.addSelectionToChat', async () => {
    const target = await requireProject();
    if (!target || !chat) {
      return;
    }
    if (!(await chat.addSelectionFromCommand())) {
      getHost().toast('請先在編輯器裡選中一段文字。', 'error');
    }
  });

  register('novel.quickContinue', async () => {
    const target = await requireProject();
    if (target) {
      await quickContinue(target);
      await refresh();
    }
  });

  // ---------------------------------------------------------------- 總結

  register('novel.summarizePlot', async (arg?: number | { plotNo?: number }) => {
    const target = await requireProject();
    if (!target) {
      return;
    }

    const no = typeof arg === 'number' ? arg : arg?.plotNo;
    const chapter = no !== undefined ? await target.getChapter(no) : await pickChapter(target);
    if (!chapter) {
      return;
    }

    // 定稿 = 照正文更新細綱（帶連續性事實）+ 出場角色的當前狀態 + 敘事線，與工程頁、主按鈕同一份。
    await finalizeChapterTask(target, chapter);
    await refresh();
  });

  register('novel.syncSummaries', async () => {
    const target = await requireProject();
    if (target) {
      await syncSummaries(target);
      await refresh();
    }
  });

  register('novel.rebuildGlobalSummary', async () => {
    const target = await requireProject();
    if (target) {
      await rebuildGlobalSummary(target);
      await refresh();
    }
  });

  register('novel.extractCharacters', async () => {
    const target = await requireProject();
    if (target) {
      await extractCharacters(target);
      await refresh();
    }
  });

  // 設定名錄：補記 / 建條目 / 整合 / 按目錄整理。工程頁設定組的右鍵走的是同一批 core 流程。
  const loreCommands: [string, (project: NovelProject) => Promise<void>][] = [
    ['novel.recordLore', (p) => recordLore(p)],
    ['novel.buildLore', (p) => buildLoreEntries(p)],
    ['novel.integrateLore', (p) => integrateLore(p)],
    ['novel.organizeLore', (p) => organizeLore(p)],
  ];
  for (const [id, run] of loreCommands) {
    register(id, async () => {
      const target = await requireProject();
      if (target) {
        await run(target);
        await refresh();
      }
    });
  }

  /**
   * 更新單個角色的檔案。命令面板入口——工程頁的角色行右鍵走的是同一條
   * core 流程（controller 的 characterAction），兩處行為不會分叉。
   *
   * 出場章節由定稿過的細綱自動關聯，所以這裡只需要問「更新誰」。清單（含「＋N 章待讀」）
   * 由 core/choices.ts 算，這裡只負責把它交給宿主的選擇器。
   */
  register('novel.updateCharacterCard', async () => {
    const target = await requireProject();
    if (!target) {
      return;
    }
    const choices = await characterChoices(target);
    if (choices.length === 0) {
      getHost().toast('還沒有角色卡。可先執行「Novel: 提取/更新角色卡」。');
      return;
    }
    const relPath = await getHost().pick(choices, '更新哪個角色的檔案？');
    if (relPath) {
      await updateCharacterCard(target, relPath);
      await refresh();
    }
  });

  register('novel.extractStyle', async () => {
    const target = await requireProject();
    if (target) {
      await extractStyle(target);
      await refresh();
    }
  });
}

export function deactivate(): void {
  ChatPanel.disposeInstance();
}

// ---------------------------------------------------------------- 日誌

/** 「Novelwarden」輸出面板。整個外掛生命週期內只有一個。 */
let outputChannel: vscode.OutputChannel | undefined;

/**
 * 把 core 的日誌接到 VS Code 的輸出面板上。
 *
 * 緩衝裡已有的先補一遍：這個函式在 activate 最開頭呼叫，但遷移、
 * 配置讀取等模組在 import 期就可能打過日誌了。
 */
function registerOutputChannel(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Novelwarden');
  outputChannel = channel;
  for (const entry of recentLogs()) {
    channel.appendLine(formatLogEntry(entry));
  }
  context.subscriptions.push(
    channel,
    addLogSink((entry) => channel.appendLine(formatLogEntry(entry)))
  );
}

// ---------------------------------------------------------------- 輔助

/** 以當前工作區第一個資料夾為根開啟工程例項；沒有工作區則 undefined。 */
function currentProject(): NovelProject | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? NovelProject.open(folder.uri.fsPath) : undefined;
}

/** 需要工作區的命令用這個：缺工作區時提示一次。 */
async function requireProject(): Promise<NovelProject | undefined> {
  const project = currentProject();
  if (!project) {
    getHost().toast('請先開啟一個工作區資料夾。', 'error');
  }
  return project;
}

/** 無工作區時的佔位頁。不載入指令碼，CSP 收到最緊。 */
const NO_WORKSPACE_HTML = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
       color: var(--vscode-descriptionForeground); padding: 16px; line-height: 1.7; }
</style></head>
<body><p>請先開啟一個資料夾作為工作區，Novelwarden 的所有資料都存在工作區裡。</p></body></html>`;

/**
 * 0.1.x 把後設資料放在 `.novel/`，0.2.x 起放在 `.novelforge/`。檢測到任一舊目錄就問一次
 * 是否改名到 `.novelwarden/`，不靜默動使用者的檔案——那目錄可能已經進了 Git。
 */
async function offerMigration(project: NovelProject): Promise<void> {
  if (!(await project.needsMigration())) {
    return;
  }
  log.warn('檢測到舊版資料目錄（.novelforge/ 或 .novel/）', `工程根 ${project.root}`);
  const pick = await getHost().confirm(
    '檢測到舊版資料目錄（.novelforge/ 或 .novel/），新版已改名為 .novelwarden/。要現在重新命名嗎？',
    ['重新命名', '暫不']
  );
  if (pick !== '重新命名') {
    log.info('使用者選擇暫不遷移目錄');
    return;
  }
  try {
    await project.migrateLegacyDir();
    log.info('舊資料目錄已重新命名為 .novelwarden/');
    getHost().toast('已重新命名為 .novelwarden/。若用 Git 管理，記得提交這次改名。');
  } catch (err) {
    log.error(`目錄重新命名失敗：${describeError(err)}`, err);
    getHost().toast(`重新命名失敗（${describeError(err)}）。可手動把舊目錄改名為 .novelwarden。`, 'error');
  }
}

/**
 * 監聽章節與後設資料變化，重新整理面板。
 * 儲存正文會改變 contentHash，從而讓對應章節的定稿對不上（要重新定稿）。
 */
function registerWatcher(
  context: vscode.ExtensionContext,
  project: NovelProject,
  chat: ChatController | undefined
): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    // 連續儲存時合併重新整理，避免頻繁重算全部章節 hash。
    timer = setTimeout(() => {
      project.invalidate();
      void chat?.pushState();
    }, 250);
  };

  context.subscriptions.push(getHost().watch(project, schedule));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('novel')) {
        schedule();
      }
    })
  );
}

/**
 * 情節大綱沒有檔案（各章細綱梗概的彙總）：掛一個只有它的虛擬檔案系統（outlineFs.ts），`openFile` 開它時走這裡。
 * 細綱變了就通知編輯器彙總變了。
 */
function registerOutlineFs(context: vscode.ExtensionContext, project: NovelProject): void {
  const fs = new OutlineFileSystem(project.root);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.plotsDir, '**/*.md'));
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fs.touch(), 250);
  };
  watcher.onDidChange(touch);
  watcher.onDidCreate(touch);
  watcher.onDidDelete(touch);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(OUTLINE_SCHEME, fs, { isCaseSensitive: true }), watcher);
}

async function setInitializedContext(project: NovelProject): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'novelForge.initialized',
    await project.isInitialized()
  );
}

/**
 * 挑一章。清單構造在 core（`plotChoices`）；這裡只多做一件宿主專屬的事：
 * 當前編輯器正好開著某一章（正文或它的細綱）時不問，直接用它。
 */
async function pickChapter(project: NovelProject): Promise<Chapter | undefined> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    getHost().toast('還沒有寫過正文。寫完一章再同步。');
    return undefined;
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const rel = project.relPath(active.fsPath);
    // 正開著正文就用它；開著細綱時找回它映象的那一章（細綱與正文相對路徑相同），對不上再按章號認。
    const direct = chapters.find((c) => c.relPath === rel || project.plotPathForChapter(c.relPath) === rel);
    if (direct) {
      return direct;
    }
    const no = parsePlotFileName(path.basename(rel))?.no;
    const byNo = no === undefined ? undefined : chapters.find((c) => c.order === no);
    if (byNo) {
      return byNo;
    }
  }

  const no = await getHost().pick(await plotChoices(project), '選擇要總結的章節');
  return no === undefined ? undefined : chapters.find((c) => c.order === no);
}

function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '我的小說';
}
