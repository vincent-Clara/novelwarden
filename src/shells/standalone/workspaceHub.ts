import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatController, ViewHost, createMcpBackend } from '../../core/controller';
import { createBookAt } from '../../core/actions';
import { inspectBookFile } from '../../core/features/importManuscript';
import type { NovelProject } from '../../core/model/project';
import { Workspace } from '../../core/workspace';
import { readConfig } from '../../core/config';
import {
  pushSettingsTo,
  saveSettingsFrom,
  SettingsSink,
  testConnectionTo,
} from '../../core/controller/settings';
import {
  bindSkillFrom,
  inspectSkillFrom,
  installSkillFrom,
  pushSkillsTo,
  uninstallSkillFrom,
} from '../../core/controller/skills';
import { Disposable } from '../../core/host';
import { clearApiKey, promptForApiKey } from '../../core/llm/registry';
import type { McpBackend } from '../../core/mcp';
import { InMessage, OutMessage, WorkspaceItem, WorkspaceRecent } from '../../core/protocol';
import { clearLogs, describeError, recentLogs, scoped } from '../../core/runtime/logger';
import { activeTasks, cancelTask } from '../../core/runtime/progress';
import { homeDir } from '../../core/stores';
import { FileHost } from './fileHost';
import { createHostDir, listHostDir } from './hostFs';
import { runInScope, WindowScope } from './scopedHost';
import { openWithSystem } from './systemOpen';
import {
  readWindowState,
  rememberClosed,
  rememberOpen,
  writeWindowState,
} from './windowState';

const log = scoped('工作區');

/** 最後一個視窗離開之後，工程再留多久才關（重新整理頁面、斷線重連都在這段時間裡回來）。 */
const IDLE_MS = 60_000;

export interface WorkspaceHubOptions {
  /** 所有視窗共用的設定讀寫。 */
  config: FileHost['config'];
  /** window.json 所在目錄。測試注入，預設為 ~/.novelwarden。 */
  windowDir?: string;
  /** 沒有視窗的工程多久之後關。測試注入。 */
  idleMs?: number;
}

/** 一個網頁視窗（一條 WebSocket）。 */
export interface WindowConn {
  send(msg: OutMessage): void;
  /** 這個視窗開著的工程。空視窗沒有。 */
  runtime?: Runtime;
  /** 空視窗自己的宿主：彈窗、toast 只回這個視窗。 */
  readonly host: FileHost;
  readonly scope: WindowScope;
  /** 連線時繫結工程的那一步。之後的訊息要等它做完。 */
  ready: Promise<void>;
}

/** 一個開啟著的工程。幾個視窗開同一個工程時共用這一份。 */
export interface Runtime {
  id: string;
  root: string;
  name: string;
  project: NovelProject;
  controller: ChatController;
  watch: Disposable;
  host: FileHost;
  scope: WindowScope;
  clients: Set<WindowConn>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 獨立版程序裡的工作區登記處。
 *
 * 一個程序同時開著幾個工程，每個視窗（WebSocket 連線）各自綁一個，或者是空視窗。
 * `ChatController` 仍然一對一綁一份 `NovelProject`；同一個工程開在幾個視窗裡，它們共用一份。
 * 廣播只發給開著這個工程的那幾個視窗，設定與最近開啟的列表是全域的。
 *
 * core 裡的 `getHost()` 靠 {@link runInScope} 落到對應視窗：處理哪個視窗的訊息、跑哪個工程的
 * 監聽與 MCP 呼叫，就在哪個上下文裡跑。
 */
export class WorkspaceHub {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly conns = new Set<WindowConn>();
  /** 最近操作的那個工程：沒指定工程的 MCP 呼叫、不帶 `?project=` 的新視窗都落到它上面。 */
  private lastActive: Runtime | undefined;
  private readonly config: FileHost['config'];
  private readonly windowDir?: string;
  private readonly idleMs: number;

  constructor(opts: WorkspaceHubOptions) {
    this.config = opts.config;
    this.windowDir = opts.windowDir;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  // ---------------------------------------------------------------- 連線

  /**
   * 一個視窗連上來。`requested` 是它網址上的 `?project=`：給了就開那個工程（已經開著就共用），
   * 沒給就落到最近操作的那個工程上；都沒有是空視窗。
   */
  connect(send: (msg: OutMessage) => void, requested?: string): WindowConn {
    const host = new FileHost(this.config, send);
    const conn: WindowConn = { send, host, scope: { host }, ready: Promise.resolve() };
    this.conns.add(conn);
    conn.ready = (async () => {
      if (requested) {
        await this.openIn(conn, requested, { quiet: true });
      } else if (this.lastActive) {
        this.attach(conn, this.lastActive);
      }
      await this.pushReady(conn);
    })().catch((err) => log.error(`視窗連線失敗：${describeError(err)}`, err));
    return conn;
  }

  disconnect(conn: WindowConn): void {
    this.conns.delete(conn);
    conn.host.prompts.cancelAll();
    this.detach(conn);
  }

  /** 網頁發來的一條訊息。 */
  async receive(conn: WindowConn, msg: InMessage): Promise<void> {
    await conn.ready;
    if (msg.type === 'promptResult') {
      (conn.runtime?.host ?? conn.host).prompts.resolve(msg.requestId, { value: msg.value, choice: msg.choice });
      return;
    }
    this.touch(conn);
    const scope = conn.runtime?.scope ?? conn.scope;
    await runInScope(scope, async () => {
      try {
        if (await this.handle(conn, msg)) {
          return;
        }
        if (!conn.runtime) {
          conn.send({ type: 'toast', message: '請先開啟資料夾', level: 'error' });
          return;
        }
        await conn.runtime.controller.handle(msg);
      } catch (err) {
        log.error(`處理網頁訊息失敗：${describeError(err)}`, err);
        conn.send({ type: 'toast', message: describeError(err), level: 'error' });
      }
    });
  }

  // ---------------------------------------------------------------- 查詢

  /** 某個視窗眼裡的工作區：它自己開著的那一個，加上全域的最近開啟。 */
  snapshot(conn?: WindowConn): {
    currentId: string | null;
    items: WorkspaceItem[];
    recents: WorkspaceRecent[];
    openInNewWindow: boolean;
    newProjectParent: string;
  } {
    const recents = readWindowState(this.windowDir).recents.map((r) => ({
      root: r.root,
      name: r.name,
    }));
    const rt = conn ? conn.runtime : this.lastActive;
    return {
      currentId: rt?.id ?? null,
      items: rt ? [{ id: rt.id, root: rt.root, name: rt.name }] : [],
      recents,
      openInNewWindow: readConfig().openInNewWindow,
      newProjectParent: newProjectParent(recents),
    };
  }

  /** 不帶 `?project=` 的視窗會落到哪個工程上。 */
  defaultRoot(): string | undefined {
    return this.lastActive?.root;
  }

  /** 現在開著的所有工程根。 */
  openRoots(): string[] {
    return [...this.runtimes.keys()];
  }

  /**
   * MCP 的執行端。`project` 給了就找那個工程（必須開著），沒給用最近操作的那個視窗的工程。
   * 呼叫在那個工程的上下文裡跑：確認框、寫入審閱彈在開著它的視窗上。
   */
  mcpBackend(project?: string): McpBackend | undefined {
    const rt = project ? this.findRuntime(project) : this.lastActive;
    if (!rt) {
      return undefined;
    }
    const backend = createMcpBackend(rt.controller);
    return {
      call: (name, args, signal) => runInScope(rt.scope, () => backend.call(name, args, signal)),
      brief: () => runInScope(rt.scope, () => backend.brief()),
    };
  }

  /** 測試與 server 用：某個工程的 controller。不給就是最近操作的那個。 */
  controllerOf(root?: string): ChatController | undefined {
    return (root ? this.findRuntime(root) : this.lastActive)?.controller;
  }

  // ---------------------------------------------------------------- 啟動

  /**
   * 啟動時開啟：CLI 給了目錄就開啟它；否則看 window.json 的 lastOpen。
   * 路徑已經不在盤上則清掉該欄位。還沒有視窗連上來，它成為「最近操作」的那個。
   */
  async bootstrap(cliRoot?: string): Promise<void> {
    const target = cliRoot ?? readWindowState(this.windowDir).lastOpen;
    if (!target) {
      return;
    }
    if (!cliRoot) {
      try {
        if (!(await fsp.stat(target)).isDirectory()) {
          throw new Error('not a directory');
        }
      } catch {
        const win = readWindowState(this.windowDir);
        writeWindowState({ lastOpen: null, recents: win.recents }, this.windowDir);
        return;
      }
    }
    const resolved = await this.resolveDir(target, (m) => log.warn(m, target));
    if (!resolved) {
      return;
    }
    try {
      const rt = await this.ensureRuntime(resolved);
      this.lastActive = rt;
      rememberOpen(resolved, this.windowDir);
    } catch (err) {
      log.error(`開啟工程失敗：${describeError(err)}`, err);
    }
  }

  // ---------------------------------------------------------------- 訊息

  /**
   * 重連 / 前端 ready：有工程則 workspaces + 全量狀態；空視窗不發假 init。
   */
  async pushReady(conn: WindowConn): Promise<void> {
    conn.send({ type: 'workspaces', ...this.snapshot(conn) });
    if (conn.runtime) {
      await runInScope(conn.runtime.scope, () => conn.runtime!.controller.resendFullState());
      return;
    }
    await pushSettingsTo(this.sinkOf(conn));
    await pushSkillsTo(this.sinkOf(conn), {});
    conn.send({ type: 'logs', entries: recentLogs() });
    conn.send({ type: 'tasks', tasks: activeTasks(null) });
  }

  /**
   * 吃掉 Hub 自己的訊息。true = 已處理，不要再交給 controller。
   */
  async handle(conn: WindowConn, msg: InMessage): Promise<boolean> {
    const rt = conn.runtime;
    const sink = this.sinkOf(conn);
    switch (msg.type) {
      case 'listHostDir':
        conn.send({ type: 'hostDir', ...(await listHostDir(msg.path)) });
        return true;
      case 'createHostDir':
        conn.send({ type: 'hostDir', ...(await createHostDir(msg.parent, msg.name)) });
        return true;
      case 'createProject':
        await this.createProject(conn, msg);
        return true;
      case 'inspectBook':
        conn.send({ type: 'bookInspected', ...(await inspectBookFile(msg.path)) });
        return true;
      case 'openFolder':
        await this.openIn(conn, msg.path, { mode: msg.mode });
        return true;
      case 'closeFolder':
        this.closeIn(conn, msg.id);
        return true;
      case 'activateWorkspace':
        this.activate(conn, msg.id);
        return true;
      case 'windowFocus':
        // touch() 已經記下了。
        return true;
      case 'openLogDir':
        openWithSystem(homeDir());
        return true;
      case 'createFile':
        await this.createFile(conn, msg.relPath, msg.text);
        return true;
      case 'openReadme':
        await this.openReadme(conn);
        return true;
      case 'saveSettings':
        // 設定是全域的：所有視窗都收新設定，開著的工程都重新整理一遍（模型清單在工程狀態裡）。
        await saveSettingsFrom(msg.settings, this.globalSink(conn), () => this.refreshAll());
        this.pushSnapshots();
        return true;
      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await pushSettingsTo(this.globalSink(conn));
        await this.refreshAll();
        return true;
      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await pushSettingsTo(this.globalSink(conn));
        return true;
      case 'testConnection':
        await testConnectionTo(sink, msg.ref, msg.provider, rt ? () => rt.controller.pushState() : undefined);
        return true;
      case 'ready':
        await this.pushReady(conn);
        return true;
      case 'openNativeSettings':
        // 獨立版沒有原生設定頁：空視窗也要吃掉這條，避免落到「請先開啟資料夾」。
        return true;
      case 'checkEditorFiles':
      case 'listDir':
        // 編輯器在後臺核對磁碟、「檔案」頁一裝好就要根目錄：空視窗裡都沒有工程可讀，靜靜吃掉，別為它彈「請先開啟資料夾」
        // ——從前歡迎頁一開啟右下角就掛著這一句紅字，新人第一眼看到的是報錯（2026-10-24）。
        if (!rt) {
          return true;
        }
        break;
      default:
        break;
    }

    if (rt) {
      return false;
    }

    // 空視窗仍要能切設定/日誌、停任務。其餘創作類訊息由 receive 攔。
    switch (msg.type) {
      case 'switchTab':
        conn.send({ type: 'tab', tab: msg.tab });
        if (msg.tab === 'settings') {
          await pushSettingsTo(sink);
          await pushSkillsTo(sink, {});
        } else if (msg.tab === 'logs') {
          conn.send({ type: 'logs', entries: recentLogs() });
        }
        return true;
      case 'requestLogs':
        conn.send({ type: 'logs', entries: recentLogs() });
        return true;
      case 'requestLogHistory':
        conn.send({ type: 'logHistory', entries: [], exhausted: true });
        return true;
      case 'clearLogs':
        clearLogs();
        conn.send({ type: 'logs', entries: recentLogs() });
        return true;
      case 'cancelTask':
        if (!cancelTask(msg.id)) {
          conn.send({ type: 'tasks', tasks: activeTasks(null) });
        }
        return true;
      // 設定頁「技能」：技能庫與工程無關，空視窗也能看、能裝、能卸；繫結要工程（bindSkillFrom 會說）。
      case 'requestSkills':
        await pushSkillsTo(sink, {});
        return true;
      case 'inspectSkill':
        await inspectSkillFrom(sink, msg.url);
        return true;
      case 'installSkill':
        await installSkillFrom(sink, {}, msg.url);
        return true;
      case 'uninstallSkill':
        await uninstallSkillFrom(sink, {}, msg.id);
        return true;
      case 'bindSkill':
        await bindSkillFrom(sink, {}, msg.stage, msg.id);
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- 開啟 / 關閉

  /**
   * 這個視窗開啟一個工程（換掉它原來的那個）。別的視窗不受影響；原來那個工程沒有視窗了就按
   * 空閒回收。打不開時視窗保持原樣。`quiet`：連線時按網址開啟，不另外推一遍狀態（connect 會推）。
   */
  async openIn(
    conn: WindowConn,
    absPath: string,
    opts: { mode?: 'replace' | 'add'; quiet?: boolean } = {}
  ): Promise<void> {
    const resolved = await this.resolveDir(absPath, (m) => conn.host.toast(m, 'error'));
    if (!resolved) {
      return;
    }

    if (opts.mode === 'add' && conn.runtime && conn.runtime.id !== resolved) {
      conn.host.toast('一個視窗只能開一個工程', 'error');
      return;
    }

    if (conn.runtime?.id === resolved) {
      this.activate(conn, resolved);
      return;
    }

    let rt: Runtime;
    try {
      rt = await this.ensureRuntime(resolved);
    } catch (err) {
      conn.host.toast(describeError(err), 'error');
      log.error(`開啟工程失敗：${describeError(err)}`, err);
      return;
    }
    this.detach(conn);
    this.attach(conn, rt);
    this.lastActive = rt;
    rememberOpen(resolved, this.windowDir);
    if (!opts.quiet) {
      await this.pushReady(conn);
    }
    // 最近開啟的列表變了，別的視窗的歡迎頁也要跟著變。
    this.pushSnapshots(conn);
  }

  /** 這個視窗關掉它的工程。沒有別的視窗開著它就當場關（停生成、關庫）。 */
  closeIn(conn: WindowConn, id?: string): void {
    const rt = conn.runtime;
    if (!rt || (id && id !== rt.id)) {
      return;
    }
    this.detach(conn, { immediate: true });
    this.pushSnapshots();
    log.info('已關閉資料夾');
  }

  /** 測試用：關掉所有工程，所有視窗回到空視窗。 */
  async closeAll(): Promise<void> {
    for (const conn of this.conns) {
      conn.runtime = undefined;
    }
    for (const rt of [...this.runtimes.values()]) {
      this.teardown(rt);
    }
    rememberClosed(this.windowDir);
  }

  activate(conn: WindowConn, id: string): void {
    if (conn.runtime?.id === id) {
      conn.send({ type: 'workspaces', ...this.snapshot(conn) });
      return;
    }
    conn.host.toast('找不到這個工作區', 'error');
  }

  // ---------------------------------------------------------------- 內部

  private attach(conn: WindowConn, rt: Runtime): void {
    conn.runtime = rt;
    rt.clients.add(conn);
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
  }

  /**
   * 視窗離開它的工程。那個工程沒有視窗了：`immediate` 當場關；否則等一會兒（重新整理、重連會回來），
   * 到時還沒人、也沒在跑東西才關。最近操作的那個不關——沒指定工程的 MCP 呼叫還要落到它上面。
   */
  private detach(conn: WindowConn, opts: { immediate?: boolean } = {}): void {
    const rt = conn.runtime;
    if (!rt) {
      return;
    }
    conn.runtime = undefined;
    rt.clients.delete(conn);
    if (rt.clients.size > 0) {
      return;
    }
    // 沒人答得了的彈窗按取消處理（與從前「全部網頁斷開」同一條規矩）。
    rt.host.prompts.cancelAll();
    if (opts.immediate) {
      this.teardown(rt);
      if (this.lastActive) {
        rememberOpen(this.lastActive.root, this.windowDir);
      } else {
        rememberClosed(this.windowDir);
      }
      return;
    }
    this.scheduleIdle(rt);
  }

  private scheduleIdle(rt: Runtime): void {
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
    }
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = undefined;
      if (rt.clients.size > 0 || !this.runtimes.has(rt.id) || rt === this.lastActive) {
        return;
      }
      if (rt.controller.busy || activeTasks(rt.id).length > 0) {
        this.scheduleIdle(rt);
        return;
      }
      log.info(`工程已沒有視窗，關閉：${rt.root}`);
      this.teardown(rt);
    }, this.idleMs);
    // 不要因為這個計時器拖住程序退出。
    (rt.idleTimer as { unref?: () => void }).unref?.();
  }

  /** 記下這個視窗在操作。它開著的工程成為「最近操作」的那個。 */
  private touch(conn: WindowConn): void {
    const rt = conn.runtime;
    if (!rt || rt === this.lastActive) {
      return;
    }
    this.lastActive = rt;
    rememberOpen(rt.root, this.windowDir);
  }

  private async ensureRuntime(resolved: string): Promise<Runtime> {
    const existing = this.runtimes.get(resolved);
    if (existing) {
      return existing;
    }
    const clients = new Set<WindowConn>();
    const broadcast = (msg: OutMessage): void => {
      for (const c of clients) {
        c.send(msg);
      }
    };
    const host = new FileHost(this.config, broadcast);
    const scope: WindowScope = { host, owner: resolved };
    const viewHost: ViewHost = { kind: 'editor', post: broadcast, reveal: () => undefined };
    return runInScope(scope, () => {
      const project = host.bind(resolved);
      const controller = new ChatController(project);
      controller.attach(viewHost);
      let watch: Disposable | undefined;
      try {
        watch = host.watch(project, () =>
          runInScope(scope, () => {
            project.invalidate();
            void controller.pushState();
          })
        );
      } catch (err) {
        controller.dispose();
        host.unbind();
        throw err;
      }
      const rt: Runtime = {
        id: resolved,
        root: resolved,
        name: path.basename(resolved) || resolved,
        project,
        controller,
        watch,
        host,
        scope,
        clients,
      };
      this.runtimes.set(resolved, rt);
      log.info(`已開啟工程：${resolved}`);
      return rt;
    });
  }

  /**
   * 停生成 → 關庫 → 停 watcher → 卸 FileHost。
   * 先關庫再停 watcher：反過來 Windows 上 sqlite 檔案會 EBUSY。
   */
  private teardown(rt: Runtime): void {
    this.runtimes.delete(rt.id);
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
    for (const c of rt.clients) {
      c.runtime = undefined;
    }
    rt.clients.clear();
    if (this.lastActive === rt) {
      this.lastActive = [...this.runtimes.values()].pop();
    }
    try {
      rt.controller.stopGeneration();
      rt.controller.dispose();
    } finally {
      rt.watch.dispose();
      rt.host.prompts.cancelAll();
      rt.host.unbind();
    }
  }

  private findRuntime(root: string): Runtime | undefined {
    const direct = this.runtimes.get(root);
    if (direct) {
      return direct;
    }
    const want = [normalizePath(root)];
    try {
      want.push(normalizePath(fsSync.realpathSync.native(path.resolve(root))));
    } catch {
      // 不在盤上就只按字面比
    }
    for (const rt of this.runtimes.values()) {
      if (want.includes(normalizePath(rt.id))) {
        return rt;
      }
    }
    return undefined;
  }

  private async resolveDir(absPath: string, fail: (message: string) => void): Promise<string | undefined> {
    try {
      const target = path.resolve(absPath);
      const st = await fsp.stat(target);
      if (!st.isDirectory()) {
        fail('不是目錄');
        return undefined;
      }
      return await fsp.realpath(target);
    } catch {
      fail('目錄不存在');
      return undefined;
    }
  }

  /** 這個視窗自己的回執：設定頁、技能頁的推送與提示只回它。 */
  private sinkOf(conn: WindowConn): SettingsSink {
    return { post: (msg) => conn.send(msg), toast: (message, level) => conn.host.toast(message, level) };
  }

  /** 設定改了：新設定推給所有視窗，提示只給發起的那個。 */
  private globalSink(conn: WindowConn): SettingsSink {
    return {
      post: (msg) => {
        for (const c of this.conns) {
          c.send(msg);
        }
      },
      toast: (message, level) => conn.host.toast(message, level),
    };
  }

  private async refreshAll(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      await runInScope(rt.scope, () => rt.controller.pushState());
    }
  }

  /** 每個視窗各推一份它眼裡的 workspaces。`except` 那個剛推過。 */
  private pushSnapshots(except?: WindowConn): void {
    for (const c of this.conns) {
      if (c !== except) {
        c.send({ type: 'workspaces', ...this.snapshot(c) });
      }
    }
  }

  /** 經 workspace 閘道器新建檔案；已存在拒絕，不覆蓋。 */
  private async createFile(conn: WindowConn, relPath: string, text?: string): Promise<void> {
    const rt = conn.runtime;
    if (!rt) {
      conn.host.toast('請先開啟資料夾', 'error');
      return;
    }
    const rel = (relPath ?? '').trim();
    if (!rel) {
      rt.host.toast('路徑不能為空', 'error');
      return;
    }
    try {
      await new Workspace(rt.project).write(rel, { text: text ?? '' }, { mode: 'create', review: false });
      await rt.host.openInEditor(rel);
    } catch (err) {
      rt.host.toast(describeError(err), 'error');
    }
  }

  /**
   * 歡迎頁「新建一本書」「匯入寫好的書」：建資料夾、初始化（`createBookAt`），成了回 `projectCreated`，由前端照常開啟
   * ——開在這個視窗還是新視窗看「新視窗中開啟專案」，那是前端 `openProject` 的事。沒建成只說一句，什麼都不回。
   */
  private async createProject(conn: WindowConn, msg: Extract<InMessage, { type: 'createProject' }>): Promise<void> {
    let root: string;
    try {
      // 回真實路徑：與開啟之後 `workspaces` 的 `currentId` 同一個口徑，前端據此認出「換成的就是這一本」。
      root = await fsp.realpath(await createBookAt(expandHome(msg.parent), { title: msg.title, author: msg.author }));
    } catch (err) {
      log.warn('新建一本書沒建成', describeError(err));
      conn.send({ type: 'toast', message: describeError(err), level: 'error' });
      return;
    }
    conn.send({ type: 'projectCreated', root, ...(msg.importFrom ? { importFrom: msg.importFrom } : {}) });
  }

  /**
   * 有工程且根下有 README → 內建編輯器開啟。
   * 否則找產品倉庫根的 README 交給系統開啟。都沒有則 toast。
   */
  private async openReadme(conn: WindowConn): Promise<void> {
    const rt = conn.runtime;
    if (rt) {
      for (const name of README_NAMES) {
        const abs = path.join(rt.root, name);
        try {
          const st = await fsp.stat(abs);
          if (st.isFile()) {
            await rt.host.openInEditor(name);
            return;
          }
        } catch {
          // 下一候選
        }
      }
    }
    const product = findProductReadme();
    if (product) {
      openWithSystem(product);
      return;
    }
    conn.host.toast('找不到使用說明', 'error');
  }
}

/**
 * 「新建一本書」的「放在」預設值：最近開啟的那本書所在的目錄（書多半放在一處），那個目錄已經不在了、或者一本都沒開啟過，
 * 就是家目錄（Docker 裡是 `/data`，書也放在那下面）。
 */
function newProjectParent(recents: WorkspaceRecent[]): string {
  for (const r of recents) {
    const parent = path.dirname(r.root);
    try {
      if (fsSync.statSync(parent).isDirectory()) {
        return parent;
      }
    } catch {
      // 下一本
    }
  }
  return os.homedir();
}

/** 表單上手打的 `~/小說` 也認。 */
function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  return /^~[\\/]/.test(trimmed) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const README_NAMES = ['README.md', 'README.markdown'];

function findProductReadme(): string | undefined {
  const starts = [__dirname, process.cwd(), path.dirname(process.execPath)];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      try {
        if (fsSync.existsSync(path.join(dir, 'package.json'))) {
          for (const name of README_NAMES) {
            const readme = path.join(dir, name);
            if (fsSync.existsSync(readme)) {
              return readme;
            }
          }
        }
      } catch {
        // 下一層
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}
