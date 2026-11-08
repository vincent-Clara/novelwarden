import { traditionalLabel } from '../model/labels';
/**
 * `ChatController`：全部面板邏輯，按訊息域拆在同目錄模組裡。收 `InMessage` → 排程 generation/、會話儲存、
 * 創作目標切換、設定讀寫 → 廣播 `OutMessage`；經 `ViewHost` 與檢視宿主解耦，多個宿主可以同時掛。
 *
 * - **併發控制在這一層**（`beginGeneration` / `stopGeneration`，`busy` 就是 `currentAbort !== undefined`）：生成那一層
 *   無狀態，單步與 MCP 呼叫共用同一把鎖。
 * - **動手前那一句問也在這一層**（gate.ts：產物落盤、外部 agent 的 `always` 動作、寫章前的一致性預檢）：畫成對話裡
 *   的一張卡片，沒答的記在 controller 上，重連時隨全量狀態重推。
 * - 跨層命令（chat.ts）：設定右鍵「展開…」、`/落定設定`、`/續寫大綱` 臨時把目標換過去，跑完經 `awayOf` /
 *   `returnTo` 回到原來的目標、階段與能力（期間作者自己另選了目標就不動）。
 * - 其餘按域分檔案：寫作體檢 check.ts、全書查詢替換 bookFind.ts（按請求叫停，同一時刻只有一次替換）、
 *   存檔點 checkpoints.ts、設定 settings.ts、技能 skills.ts……
 */
import { listAttachmentChoices, selectionAttachmentOf } from '../files/attachments';
import { readConfig, settingsContextDetail } from '../config';
import { closeDatabase, installLogPersistence, readLogHistory } from '../runtime/db';
import { DraftStore } from '../generation/drafts';
import { CancelledError } from '../llm/provider';
import { getHost } from '../host';
import { addLogSink, clearLogs, describeError, recentLogs, scoped } from '../runtime/logger';
import { activeTasks, cancelTask, onTaskFinished, onTasksChanged, requestStop, visibleTo } from '../runtime/progress';
import { clearApiKey, promptForApiKey } from '../llm/registry';
import { NovelProject } from '../model/project';
import { Workspace } from '../workspace';
import {
  describeModelIssue,
  listModelChoices,
} from '../model/providers';
import {
  Attachment,
  ChatSession,
  SessionStore,
  renderContextText,
} from '../model/session';
import {
  chapterLabel,
  plotOfTarget,
  normalizeTarget,
} from '../model/pipeline';
import {
  ChapterIndexEntry,
  InMessage,
  OutMessage,
  Tab,
  ViewState,
} from '../protocol';
import { buildPlotSummaryView, buildProjectTree } from '../views/projectView';
import { buildPipelineIndex } from '../views/pipeline';
import { buildQuickOpenIndex } from '../views/quickOpen';
import { buildNameIndex, nameIndexSig } from '../views/nameIndex';
import { buildThreadsOverview, buildTimelineOverview } from '../views/threads';
import { chapterIndexOf } from '../views/chapterIndex';
import { DEFAULT_PARAGRAPH_STYLE } from '../model/paragraphFormat';
import {
  chapterAction,
  editReview,
  expandLore,
  pushPipeline,
  retry,
  reviseChapter,
  rewriteArchitecture,
  selectPlot,
  send,
  setTarget,
} from './chat';
import type { PendingGate } from './gate';
import { cancelGates, resendGates, resolveGate } from './gate';
import { fileAction, openChapter, openDraft, openPlot, pushDirListings, revealQuote } from './files';
import { characterAction, projectAction, setParagraphStyle } from './project';
import {
  deleteSession,
  newSession,
  openSession,
  renameSession,
  setThinking,
} from './session';
import { persist } from './persist';
import { bindSkillFrom, inspectSkillFrom, installSkillFrom, pushSkillsTo, uninstallSkillFrom } from './skills';
import {
  describeProvider,
  serializeAttachment,
  serializeSession,
} from './serialize';
import { pushSettings, saveSettings, selectModel, testConnection } from './settings';
import { listVersions, mergeWithDisk, readVersion, saveVersion } from './versions';
import {
  pushCheckpointDiff,
  pushCheckpoints,
  restoreCheckpointFor,
  saveCheckpoint,
  setCheckpointNote,
} from './checkpoints';
import { editSensitiveWords, pushCheckTerms } from './check';
import type { BookConfig } from '../model/settingFile';
import { bookFind, bookReplace, cancelBookFind } from './bookFind';

export { describeProvider } from './serialize';
export { createMcpBackend } from './mcp';

/** Webview 宿主需要提供的能力。側邊欄與編輯器面板各實現一份。 */
export interface ViewHost {
  readonly kind: 'sidebar' | 'editor';
  post(message: OutMessage): void;
  reveal(): void;
}

const log = scoped('面板');

/** 「載入更早」一次翻多少條日誌。與前端的行數上限同量級。 */
const LOG_HISTORY_PAGE = 200;

/**
 * 對話面板的全部邏輯。
 *
 * 有意與宿主解耦：同一個 controller 既可以掛在側邊欄的 WebviewView 上，
 * 也可以掛在編輯器裡的 WebviewPanel 上，兩邊看到的是同一個會話。
 *
 * 同包欄位（無 private）只給 `controller/` 下的模組用，殼不要讀。
 */
export class ChatController {
  /** @internal controller/ 同包用；殼不要讀。 */
  readonly project: NovelProject;
  /**
   * 工程的唯一讀寫閘道器。agent 的只讀工具吃它。
   *
   * 一個 controller 一份而不是每次現造：`Workspace` 本身無狀態（它只是
   * `NovelProject` 的門面），但造一份要傳 project，散在各處等於把這層依賴
   * 又複製了幾遍。
   * @internal controller/ 同包用；殼不要讀。
   */
  readonly workspace: Workspace;
  /** @internal controller/ 同包用；殼不要讀。 */
  readonly store: SessionStore;
  /**
   * 尚未採納的產物。**併發控制與它無關**——那是 `currentAbort` 的活。
   * @internal controller/ 同包用；殼不要讀。
   */
  readonly drafts = new DraftStore();
  /** @internal controller/ 同包用；殼不要讀。 */
  current: ChatSession;
  /** @internal controller/ 同包用；殼不要讀。 */
  tab: Tab = 'chat';
  /**
   * 正在跑的那次生成。
   *
   * **併發控制是排程的責任**，不是生成的責任：`generation/` 整層無狀態，對話頁的
   * 單步創作與 MCP 呼叫（`controller/mcp.ts`）共用這一個位。
   *
   * 忙碌標記與取消是同一個狀態：分成兩個遲早會對不上，而對不上的表現是「停止按鈕
   * 點了沒反應」。
   */
  private currentAbort?: AbortController;
  /** 尚未落盤的附件（使用者已經 @ 了，但還沒傳送）。@internal 同包用。 */
  pending: Attachment[] = [];
  /** @internal controller/ 同包用；殼不要讀。 */
  readonly hosts = new Set<ViewHost>();
  /**
   * 等著作者點頭的許可權詢問（agent 那條路的閘門，見 [gate.ts](gate.ts)）。
   *
   * 記在後端而不是前端，是因為**前端無狀態**：網頁重新整理、webview 重建之後，
   * 這幾張卡片要靠 `resendFullState` 原樣再推一遍——不然迴圈就停在一個誰也
   * 看不見的等待上，介面只剩一個轉不完的忙碌標記。
   * @internal controller/ 同包用；殼不要讀。
   */
  readonly gates = new Map<string, PendingGate>();
  /** 日誌與任務的訂閱，dispose 時要解掉——否則重開面板會留下往死通道推的 sink。 */
  private readonly subscriptions: { dispose(): void }[] = [];
  /**
   * 資源管理器裡當前展開著的目錄（工程內相對路徑，空串是工程根）。
   *
   * 記在後端是為了讓**工程變動時能主動重推**：作者在編輯器裡新建一章、
   * 或在外面動了盤上的檔案，watcher 觸發 pushState，這份集合讓資源管理器
   * 跟著重新整理，不必等使用者手動點一下摺疊再展開。
   * 前端每次發 `listDir` 都帶全量，這裡整體替換。
   * @internal controller/ 同包用；殼不要讀。
   */
  watchedDirs: string[] = [];
  /**
   * 開啟一章時旁邊並排開哪一份（2026-10-23 作者定）：上一次並排開的是草稿（工具欄「草稿」、章節右鍵「開啟草稿」）
   * 就開這一章的草稿，否則開細綱；工具欄「細綱」點過就換回細綱。只記在這個視窗的記憶體裡，重啟回到細綱。
   * @internal controller/ 同包用；殼不要讀。
   */
  companion: 'plot' | 'draft' = 'plot';
  /** dispose 過了。非同步掛載的訂閱據此就地退訂，不往死通道上掛。 */
  private disposed = false;
  /**
   * 上一次推出去的章節索引（JSON）。`pushState` 每次都算一份（與目標下拉同一趟流水線索引，不多讀盤），
   * 內容沒變就不推——作者每存一次盤就跑一次 `pushState`，絕大多數時候章節的順序、狀態、字數都沒動。
   */
  private chapterIndexSig: string | undefined;

  constructor(project: NovelProject) {
    this.project = project;
    this.workspace = new Workspace(project);
    this.store = new SessionStore(project);
    this.current = this.store.create();

    // 日誌實時推給前端：日誌頁在跑長任務時要跟著滾，不能只在切頁時拉一次。
    this.subscriptions.push(addLogSink((entry) => this.post({ type: 'log', entry })));
    // 任務表變化 → 推快照。工程頁的進度條與工具欄的忙碌標記都吃這一條。
    this.subscriptions.push(onTasksChanged(() => this.post({ type: 'tasks', tasks: activeTasks(project.root) })));
    // 任務說完了那一句（D24）：在所有頁籤都看得見的提示條上說，帶「開啟第 N 章」。
    this.subscriptions.push(
      onTaskFinished((t) => {
        if (visibleTo(t.owner, project.root)) {
          this.post({ type: 'taskDone', title: t.title, message: t.message, level: t.level ?? 'info', open: t.open });
        }
      })
    );
    // 日誌再落一份進工程庫，重啟之後仍查得到「昨晚那 76 章卡在哪」。
    // 開庫是非同步的，而 controller 可能在開完之前就被 dispose 掉（使用者剛開啟
    // 側邊欄又立刻關掉視窗）——那時必須就地退訂，否則這個 sink 會永遠掛著
    // 往一個已經關掉的庫裡寫。
    void installLogPersistence(project).then((sub) => {
      if (this.disposed) {
        sub.dispose();
      } else {
        this.subscriptions.push(sub);
      }
    });
  }

  attach(host: ViewHost): void {
    this.hosts.add(host);
  }

  detach(host: ViewHost): void {
    this.hosts.delete(host);
  }

  // ---------------------------------------------------------------- 併發控制

  /**
   * 正在生成。前端的忙碌標記與「已有一個生成任務在進行中」都看這一個。
   * @internal controller/ 同包用；殼不要讀。
   */
  get busy(): boolean {
    return this.currentAbort !== undefined;
  }

  /**
   * 佔住生成位。已經有一個在跑就返回 undefined——呼叫方據此拒掉本次請求。
   *
   * 返回的 `release` 必須在 finally 裡調：漏了的話這個 controller 從此
   * 再也發不出第二條訊息，而介面上只是一句莫名其妙的「已有一個生成任務
   * 在進行中」。
   * @internal controller/ 同包用；殼不要讀。
   */
  beginGeneration(): { signal: AbortSignal; abort: () => void; release: () => void } | undefined {
    if (this.currentAbort) {
      return undefined;
    }
    const abort = new AbortController();
    this.currentAbort = abort;
    return {
      signal: abort.signal,
      // 讓佔位方自己也能中斷（agent 那條路要把 runTask 進度條上的「停止」
      // 轉接進來）。只 abort 自己那一份，不碰別人的。
      abort: () => abort.abort(new CancelledError()),
      release: () => {
        // 只清自己那一份：release 晚到時（上一次生成的收尾）不該把
        // 剛開始的下一次取消掉。
        if (this.currentAbort === abort) {
          this.currentAbort = undefined;
        }
      },
    };
  }

  /** 使用者點了停止。沒有在跑的就什麼也不做。 */
  stopGeneration(): void {
    if (this.currentAbort) {
      log.info('使用者點了停止');
    }
    this.currentAbort?.abort(new CancelledError());
  }

  dispose(): void {
    this.disposed = true;
    this.currentAbort?.abort(new CancelledError());
    // 還在等回答的許可權卡片：面板都沒了，沒人答得了它。
    cancelGates(this);
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
    // 關庫要在退訂之後：日誌 sink 的 dispose 會把攢著的最後一批 flush 掉，
    // 反過來的話那幾條就丟了——而崩潰前的最後幾條恰恰最想看。
    closeDatabase(this.project);
  }

  /** 廣播給所有已掛載的宿主，兩個檢視始終一致。@internal 同包用。 */
  post(message: OutMessage): void {
    for (const host of this.hosts) {
      host.post(message);
    }
  }

  /** @internal controller/ 同包用；殼不要讀。 */
  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'toast', message, level });
  }

  // ---------------------------------------------------------------- 訊息入口

  async handle(msg: InMessage): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (err) {
      // 兜底解鎖：`runTurn` 自己有 finally，走到這裡說明是它之外的地方炸了。
      // 不解的話這個面板從此發不出第二條訊息，介面上只剩一句莫名其妙的
      // 「已有一個生成任務在進行中」。
      this.currentAbort = undefined;
      this.post({ type: 'busy', value: false });
      // 未被下層接住的異常一律進日誌：toast 五秒就沒了，日誌頁留得住。
      log.error(`處理訊息 ${traditionalLabel(msg.type)} 時出錯：${describeError(err)}`, err);
      this.toast(describeError(err), 'error');
    }
  }

  /**
   * 重放當前頁籤的全部資料。新前端連線掛上來時呼叫——
   * webview 被銷燬重建或網頁重新整理/重連後，靠這一套訊息即可恢復。
   */
  async resendFullState(): Promise<void> {
    const snap = await this.snapshot();
    this.post({ type: 'init', state: snap.state });
    // 新連上的前端手上什麼都沒有：章節索引與體檢詞表不論變沒變都推一份。
    this.pushChapterIndex(snap.chapters, true);
    await pushCheckTerms(this, { force: true, book: snap.book });
    this.post({ type: 'tab', tab: this.tab });
    this.post({ type: 'session', session: serializeSession(this.current) });
    this.post({ type: 'attachments', items: this.pending.map(serializeAttachment) });
    this.post({ type: 'busy', value: this.busy });
    // 重新整理頁面時長任務多半還在跑，進度條必須立刻接上，別讓人以為任務沒了。
    this.post({ type: 'tasks', tasks: activeTasks(this.project.root) });
    // 還沒答的許可權卡片也要跟著回來：它掛在會話的氣泡上（上面那條 session 已經
    // 把氣泡帶回來了），迴圈這會兒正卡在那裡等回答。
    resendGates(this);
    await this.pushTabData();
  }

  async dispatch(msg: InMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.resendFullState();
        return;

      case 'switchTab':
        this.tab = msg.tab;
        await this.pushTabData();
        return;

      case 'send':
        await send(this, msg.payload);
        return;

      case 'retry':
        await retry(this, msg.turnId, msg.payload);
        return;

      case 'stop':
        this.stopGeneration();
        return;

      case 'setTarget':
        await setTarget(this, normalizeTarget(msg.target));
        return;

      case 'selectPlot':
        await selectPlot(this, msg.plotRelPath);
        return;

      case 'requestPipeline':
        // 指名要某一章的，就先切過去（那正是「點開另一章」的意思）；
        // 不指名的是純重新整理，照當前目標推一份。
        if (msg.plotRelPath && msg.plotRelPath !== plotOfTarget(this.current.target)) {
          await selectPlot(this, msg.plotRelPath);
        } else {
          await pushPipeline(this);
        }
        return;

      case 'editTurn': {
        const turn = this.current.turns.find((t) => t.id === msg.turnId);
        if (turn) {
          turn.content = msg.text;
          await persist(this);
        }
        return;
      }

      case 'deleteTurn': {
        const idx = this.current.turns.findIndex((t) => t.id === msg.turnId);
        if (idx === -1) {
          return;
        }
        // 刪使用者訊息時連同它的回覆一起刪——留著一條無源的回覆沒有意義。
        const drop = this.current.turns[idx].role === 'user' &&
          this.current.turns[idx + 1]?.role === 'assistant' ? 2 : 1;
        this.current.turns.splice(idx, drop);
        await persist(this);
        this.post({ type: 'session', session: serializeSession(this.current) });
        return;
      }

      case 'copyContext': {
        const turn = this.current.turns.find((t) => t.id === msg.turnId);
        const text = turn ? renderContextText(turn) : undefined;
        this.post({
          type: 'contextText',
          requestId: msg.requestId,
          ...(text !== undefined
            ? { text }
            : {
                error: turn
                  ? '這一輪沒有留下完整上下文（這個功能加上之前的回覆只存了清單）。'
                  : '找不到這一輪，可能已經被刪掉了。',
              }),
        });
        return;
      }

      case 'openSession':
        await openSession(this, msg.id);
        return;

      case 'newSession':
        await newSession(this);
        return;

      case 'deleteSession':
        await deleteSession(this, msg.id);
        return;

      case 'renameSession':
        await renameSession(this, msg.id);
        return;

      case 'pickAttachment': {
        const choices = await listAttachmentChoices(this.project);
        const picked = await getHost().pick(choices, '引用到上下文');
        if (picked) {
          this.addAttachment(picked);
        }
        return;
      }

      case 'addSelection': {
        // 內建編輯器裡的選區由前端帶上來（宿主取不到網頁裡的選區）；沒帶才交給宿主。
        const sel = msg.selection;
        const att = sel?.text.trim()
          ? selectionAttachmentOf(sel.relPath, sel.text.trim(), { start: sel.start, end: sel.end })
          : await getHost().selectionAttachment(this.project);
        if (!att) {
          this.toast('沒有可加入的文字。', 'error');
          return;
        }
        this.addAttachment(att);
        return;
      }

      case 'openFile':
        await getHost().openFile(msg.path);
        return;

      case 'openEditor':
      case 'reloadFile': {
        // 有內建編輯器的宿主（獨立版）走內建編輯器；外掛殼沒有，
        // 回落到 openFile —— 那邊開啟的本來就是 VS Code 真正的編輯器。
        const host = getHost();
        if (host.openInEditor) {
          // reloadFile 不帶 pane：過載哪一塊由前端按 path 自己認。臨時標籤 / 原位換掉的標記原樣帶回。
          await host.openInEditor(
            msg.path,
            msg.type === 'openEditor' ? msg.pane : undefined,
            msg.type === 'openEditor' ? { preview: msg.preview, replace: msg.replace } : undefined
          );
        } else {
          await host.openFile(msg.path);
        }
        return;
      }

      case 'openDraft':
        await openDraft(this, msg.path);
        return;

      case 'openPlot':
        await openPlot(this, msg.path);
        return;

      case 'openChapter':
        await openChapter(this, msg.plotRelPath, { preview: msg.preview === true }, msg.beside !== false);
        return;

      case 'reviseChapter':
        await reviseChapter(this, msg.turnId, msg.picks);
        return;

      case 'editReview':
        await editReview(this, msg.turnId, Array.isArray(msg.issues) ? msg.issues : []);
        return;

      case 'revealQuote':
        await revealQuote(this, msg.relPath, msg.quote);
        return;

      case 'chapterAction':
        await chapterAction(this, msg.plotRelPath, msg.action);
        return;

      case 'rewriteArchitecture':
        await rewriteArchitecture(this, normalizeTarget(msg.target));
        return;

      case 'expandLore':
        await expandLore(this, msg);
        return;

      case 'saveFile': {
        const host = getHost();
        if (!host.saveFromEditor) {
          this.toast('當前環境沒有內建編輯器。', 'error');
          return;
        }
        await host.saveFromEditor(msg.path, msg.text, msg.baseHash, { recreate: msg.recreate === true });
        // 儲存的可能是章節正文，字數/定稿狀態都會變。
        await this.pushState();
        return;
      }

      case 'checkEditorFiles': {
        // 內建編輯器核對磁碟（定稿寫回細綱、外部 agent 的 edit、外部編輯器改了檔案之後）。
        // 沒有內建編輯器的宿主（外掛）不會發這條；發了也只是什麼都不做。
        const host = getHost();
        if (host.checkEditorFiles) {
          await host.checkEditorFiles(Array.isArray(msg.files) ? msg.files : []);
        }
        return;
      }

      case 'openExternal':
        await (getHost().openExternal ?? getHost().openFile)(msg.path);
        return;

      // 衝突時的對比合併與歷史版本（controller/versions.ts）。都不寫盤，結果經 editorReplace 換進編輯區。
      case 'mergeWithDisk':
        await mergeWithDisk(this, msg.path, msg.text, msg.requestId);
        return;
      case 'listVersions':
        await listVersions(this, msg.path);
        return;
      case 'readVersion':
        await readVersion(this, msg.path, msg.id, msg.requestId);
        return;
      case 'saveVersion':
        await saveVersion(this, msg.path, msg.quiet === true);
        return;

      // 存檔點（controller/checkpoints.ts）：整本書存一版、跟現在比、退回。
      case 'listCheckpoints':
        await pushCheckpoints(this);
        return;
      case 'createCheckpoint':
        await saveCheckpoint(this, msg.note);
        return;
      case 'noteCheckpoint':
        await setCheckpointNote(this, msg.id, msg.note);
        return;
      case 'checkpointDiff':
        await pushCheckpointDiff(this, msg.id);
        return;
      case 'restoreCheckpoint':
        await restoreCheckpointFor(this, msg.request);
        return;

      // 全書查詢替換（controller/bookFind.ts）：查詢與預覽只讀；替換經閘道器逐份寫，完了 pushState。
      case 'bookFind':
        await bookFind(this, msg.requestId, msg.query);
        return;
      case 'cancelBookFind':
        cancelBookFind(msg.requestId);
        return;
      case 'bookReplace':
        await bookReplace(this, msg.requestId, msg.request);
        return;

      case 'listDir':
        await pushDirListings(this, msg.dirs, msg.ephemeral);
        return;

      case 'requestSummary':
        // 只回給發問的那個前端就夠了，但 post 是廣播——多開一個面板時
        // 另一邊收到一份用不上的細綱浮窗，代價只是一次無害的快取寫入。
        this.post({ type: 'summary', summary: await buildPlotSummaryView(this.project, msg.plotRelPath) });
        return;

      case 'requestQuickOpen':
        // 「轉到…」（Ctrl+P）面板開啟時要一份索引。回覆是廣播，前端認 requestId。
        this.post({ type: 'quickOpenIndex', requestId: msg.requestId, index: await buildQuickOpenIndex(this.project) });
        return;

      case 'editSensitiveWords':
        // 內建編輯器的寫作體檢（controller/check.ts）：沒有就新建模板，然後開啟。
        await editSensitiveWords(this);
        return;

      case 'requestThreadsOverview':
        // 編輯區「敘事線總覽」標籤（敘事線重做三期）要矩陣：純讀盤、不調模型。回覆是廣播，前端認 requestId。
        this.post({ type: 'threadsOverview', requestId: msg.requestId, overview: await buildThreadsOverview(this.project) });
        return;

      case 'requestTimelineOverview':
        // 編輯區「時間線總覽」標籤（2026-10-24）要資料：純讀盤、不調模型。回覆是廣播，前端認 requestId。
        this.post({ type: 'timelineOverview', requestId: msg.requestId, overview: await buildTimelineOverview(this.project) });
        return;

      case 'requestNameIndex': {
        // 編輯器「名詞補全」要名詞表。前端手上那份（`have`）還是最新的就只回指紋，不再發一遍表。
        const index = await buildNameIndex(this.project);
        const sig = nameIndexSig(index);
        this.post({ type: 'nameIndex', requestId: msg.requestId, sig, ...(msg.have === sig ? {} : { index }) });
        return;
      }

      case 'projectAction':
        await projectAction(this, msg.action, msg.relPath, msg.dir, {
          range: msg.range,
          call: msg.call,
          mode: msg.mode,
          review: msg.review,
          name: msg.name,
          expandLore: msg.expandLore,
          open: msg.open,
          hostPath: msg.hostPath,
        });
        return;

      case 'fileAction':
        await fileAction(this, msg);
        return;

      case 'characterAction':
        await characterAction(this, msg.action, msg.name, msg.relPath);
        return;

      case 'selectModel':
        await selectModel(this, msg.ref);
        return;

      case 'setThinking':
        await setThinking(this, msg.depth);
        return;

      case 'saveSettings':
        await saveSettings(this, msg.settings);
        return;

      case 'setApiKey':
        await promptForApiKey(msg.providerId);
        await pushSettings(this);
        await this.pushState();
        return;

      case 'clearApiKey':
        await clearApiKey(msg.providerId);
        await pushSettings(this);
        return;

      case 'testConnection':
        await testConnection(this, msg.ref, msg.provider);
        return;

      case 'requestSkills':
        await pushSkillsTo(this, this);
        return;

      case 'inspectSkill':
        await inspectSkillFrom(this, msg.url);
        return;

      case 'installSkill':
        await installSkillFrom(this, this, msg.url);
        return;

      case 'uninstallSkill':
        await uninstallSkillFrom(this, this, msg.id);
        return;

      case 'bindSkill':
        await bindSkillFrom(this, this, msg.stage, msg.id);
        return;

      case 'setParagraphStyle':
        await setParagraphStyle(this, msg.style);
        return;

      case 'openNativeSettings':
        await getHost().openNativeSettings?.();
        return;

      case 'cancelTask':
        if (!cancelTask(msg.id)) {
          // 任務剛好在這一刻結束：推一份新快照讓前端把進度條收掉。
          this.post({ type: 'tasks', tasks: activeTasks(this.project.root) });
        }
        return;

      case 'stopAfterItem':
        if (!requestStop(msg.id)) {
          this.post({ type: 'tasks', tasks: activeTasks(this.project.root) });
        }
        return;

      case 'requestLogs':
        this.post({ type: 'logs', entries: recentLogs() });
        return;

      case 'requestLogHistory': {
        // 只有這一條會查庫。預設進日誌頁仍然只看記憶體緩衝，一次查詢都不做。
        const entries = await readLogHistory(this.project, LOG_HISTORY_PAGE, msg.before);
        // 取回來的比頁大小少，說明再往前沒有了——前端據此收掉按鈕。
        this.post({ type: 'logHistory', entries, exhausted: entries.length < LOG_HISTORY_PAGE });
        return;
      }

      case 'clearLogs':
        clearLogs();
        this.post({ type: 'logs', entries: recentLogs() });
        return;

      case 'promptResult':
        // 由獨立版殼在進入 controller 前截獲（解彈窗）；外掛永遠不會收到。
        return;

      case 'gateResult':
        // 作者在氣泡裡那張許可權卡片上點了一顆按鈕。認不出的 requestId 靜默丟棄。
        resolveGate(this, msg.requestId, msg.verdict, typeof msg.remember === 'string' ? msg.remember : undefined);
        return;

      // 工作區生命週期與本機目錄：獨立版由 WorkspaceHub 在進 controller
      // 之前攔下。外掛不會發這些訊息。空分支避免 InMessage 聯合漏網。
      case 'listHostDir':
      case 'createHostDir':
      case 'createProject':
      case 'inspectBook':
      case 'openFolder':
      case 'closeFolder':
      case 'activateWorkspace':
      case 'windowFocus':
      case 'openLogDir':
      case 'createFile':
      case 'openReadme':
        return;
    }
  }

  // ---------------------------------------------------------------- 狀態

  /** @internal controller/ 同包用；殼不要讀。 */
  async buildState(): Promise<ViewState> {
    return (await this.snapshot()).state;
  }

  /**
   * `ViewState` 與內建編輯器的章節索引：兩樣出自同一趟流水線索引（`buildPipelineIndex`，目標下拉框本來
   * 就要它），章節索引只是從同一份 rows 裡多投影幾個欄位。還不是小說工程時章節索引是空的。`book` 是那一趟讀到的
   * 小說配置，體檢詞表（`controller/check.ts`）拿它，不再讀一遍 `config.md`。
   */
  private async snapshot(): Promise<{ state: ViewState; chapters: ChapterIndexEntry[]; book?: BookConfig }> {
    const initialized = await this.project.isInitialized();
    const config = readConfig();
    const host = getHost();
    const models = listModelChoices(config.providers, host.supportsVscodeLm).map((c) => ({
      ref: c.ref,
      label: c.label,
      group: c.group,
    }));
    // 當前模型若是 vscode-lm 而宿主不支援（獨立版），下拉里已過濾，需明確提示切換。
    const lmOnlyIssue =
      config.active?.profile.kind === 'vscode-lm' && !host.supportsVscodeLm
        ? '當前模型僅在 VS Code 內可用（Copilot），請在設定頁切換到自建 API 的模型。'
        : undefined;

    if (!initialized) {
      return {
        state: {
          initialized: false,
          plots: [],
          nextNo: 1,
          staleCount: 0,
          model: config.model,
          modelLabel: '',
          models,
          contextDetail: settingsContextDetail(),
          contextWindow: 0,
          maxOutputTokens: 0,
          paragraphStyle: DEFAULT_PARAGRAPH_STYLE,
        },
        chapters: [],
      };
    }
    // 目標下拉框：**一個章號一行**（細綱號 = 章號），順序即時間線。
    // `relPath` 是那一章細綱的路徑——還沒有細綱時是它應該在的位置，選中它就是
    // 「去給這一章補規劃」，`readPlot` 讀不到會如實退化成空殼。
    const { rows: pipelineRows, config: book } = await buildPipelineIndex(this.project);
    const rows: ViewState['plots'] = pipelineRows.map((p) => ({
      no: p.no,
      label: chapterLabel(p.no, p.title),
      title: p.title,
      wordCount: p.chapter.words,
      relPath: p.plot.relPath,
    }));
    return {
      state: {
        initialized: true,
        plots: rows,
        nextNo: await this.project.nextPlotNo(),
        staleCount: (await this.project.staleChapters()).length,
        model: config.model,
        modelLabel: describeProvider(config),
        // 只在解析失敗時給出說明——正常情況下不要在輸入框下方堆紅字。
        modelIssue:
          lmOnlyIssue ?? (config.active ? undefined : describeModelIssue(config.providers, config.model)),
        models,
        contextDetail: settingsContextDetail(),
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        // 流水線索引那一趟已經讀過 config.md，不另讀。
        paragraphStyle: book.paragraphStyle ?? DEFAULT_PARAGRAPH_STYLE,
      },
      chapters: chapterIndexOf(pipelineRows),
      book,
    };
  }

  /**
   * 推章節索引（`chapterIndex`）。內容與上一次推的一樣就不推；`force` 給新連上的前端。
   *
   * 為什麼單獨一條、不塞進 `ViewState`：`state` 每次 `pushState` 都整份推，而章節索引絕大多數時候沒變；
   * 為什麼不復用工程樹：那棵樹要額外讀角色卡、設定、草稿、敘事線、出場索引，只在「工程」頁籤開著時才推。
   */
  private pushChapterIndex(chapters: ChapterIndexEntry[], force = false): void {
    const sig = JSON.stringify(chapters);
    if (!force && sig === this.chapterIndexSig) {
      return;
    }
    this.chapterIndexSig = sig;
    this.post({ type: 'chapterIndex', chapters });
  }

  /**
   * 工程內容變化時重新整理（由 FileSystemWatcher、儲存、工程頁動作觸發）。
   *
   * 流水線條跟著一起推：寫完正文、定稿完、在編輯器裡手改了細綱，主按鈕都得跟著
   * 變。從前這裡只推 state，做完一步主按鈕還掛著上一步，再點只會報錯。
   * 它失敗不該拖垮 state 那一份，所以單獨兜住。
   */
  async pushState(): Promise<void> {
    this.project.invalidate();
    if (this.hosts.size > 0) {
      // 一份快照發給所有宿主（從前每個宿主各建一遍，結果一樣）；章節索引與體檢詞表跟著它，變了才推。
      const snap = await this.snapshot();
      for (const host of this.hosts) {
        host.post({ type: 'state', state: snap.state });
      }
      this.pushChapterIndex(snap.chapters);
      await pushCheckTerms(this, { book: snap.book });
    }
    if (await this.project.isInitialized()) {
      try {
        await pushPipeline(this);
      } catch (err) {
        log.warn(`重新整理流水線失敗：${describeError(err)}`, err);
      }
    }
    await this.pushTabData();
  }

  /**
   * 補齊當前頁籤需要的資料。
   * 只推可見頁籤的——工程頁要遍歷全部章節算定稿狀態，
   * 每儲存一次正文都跑一遍沒必要。
   * @internal controller/ 同包用；殼不要讀。
   */
  async pushTabData(): Promise<void> {
    if (this.tab === 'project') {
      await this.pushProject();
    } else if (this.tab === 'files') {
      // 資源管理器只重推前端說過它關心的那些目錄；一個都沒登記（剛切過來、
      // 前端還沒發 listDir）時什麼也不做，等那條訊息到了自然會推。
      await pushDirListings(this, this.watchedDirs);
    } else if (this.tab === 'history') {
      await this.pushSessions();
    } else if (this.tab === 'settings') {
      await pushSettings(this);
      // 「技能」那一頁每次都重掃：作者可能剛往 .novelwarden/skills/ 裡放了一份。
      await pushSkillsTo(this, this);
    } else if (this.tab === 'logs') {
      // 切到日誌頁時補一份全量；此後靠 sink 增量追加。
      this.post({ type: 'logs', entries: recentLogs() });
    }
  }

  /** @internal controller/ 同包用；殼不要讀。 */
  async pushProject(): Promise<void> {
    this.post({ type: 'project', tree: await buildProjectTree(this.project) });
  }

  /** @internal controller/ 同包用；殼不要讀。 */
  async pushSessions(): Promise<void> {
    const list = await this.store.list();
    this.post({
      type: 'sessions',
      list: list.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        turnCount: s.turnCount,
        preview: s.preview,
        active: s.id === this.current.id,
      })),
    });
  }

  // ---------------------------------------------------------------- 附件

  /** @internal controller/ 同包用；殼不要讀。 */
  addAttachment(att: Attachment): void {
    if (this.pending.some((a) => a.id === att.id)) {
      this.toast('已經引用過這一項了。');
      return;
    }
    this.pending.push(att);
    this.post({ type: 'attachments', items: this.pending.map(serializeAttachment) });
  }

  /** 供命令直接呼叫：把當前選區加入待傳送上下文。 */
  async addSelectionFromCommand(): Promise<boolean> {
    const att = await getHost().selectionAttachment(this.project);
    if (!att) {
      return false;
    }
    this.addAttachment(att);
    for (const host of this.hosts) {
      host.reveal();
    }
    return true;
  }

  /** 供命令直接呼叫：切到某個頁籤。 */
  async showTab(tab: Tab): Promise<void> {
    this.tab = tab;
    this.post({ type: 'tab', tab });
    await this.pushTabData();
    for (const host of this.hosts) {
      host.reveal();
    }
  }

  /** 供命令直接呼叫：新建會話。 */
  async newSessionFromCommand(): Promise<void> {
    await newSession(this);
    for (const host of this.hosts) {
      host.reveal();
    }
  }

  /**
   * 供命令直接呼叫：新建一章並進入它當前該做的那一步。
   *
   * 複用工程頁那條 `projectAction` 分支而不是直接調 `newPlotFlow`：
   * 「建完落到劇情層」是這個動作的一部分，命令面板與頁面按鈕不該分叉。
   */
  async newPlotFromCommand(): Promise<void> {
    await projectAction(this, 'newPlot');
    for (const host of this.hosts) {
      host.reveal();
    }
  }
}
