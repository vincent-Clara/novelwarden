import {
  chatPane,
  escapeHtml,
  filesPane,
  historyPane,
  logsPane,
  mergeModal,
  projectPane,
  providerModal,
  settingsPane,
  tabbar,
  taskBar,
  toastSlot,
  versionsPane,
} from '../shared/panes';

/**
 * 獨立版的頁面。
 *
 * pane 的 DOM 全部來自 [../shared/panes.ts](../shared/panes.ts)，與外掛殼同一份；
 * 這裡只剩**佈局**——一套 VS Code 式工作臺：標題欄（檔案 / 編輯 / 檢視 / 幫助）+ 活動欄 + 側欄 + 內建編輯器。
 * 無工程時 body 帶 `no-workspace`，編輯器區是 Get Started；工程名不寫進首屏 HTML，
 * 由前端跟 `workspaces` 更新。
 * 佈局本來就該按宿主分叉，內容不該。
 *
 * 這個模組刻意不牽進內嵌資源表（那在 [assets.ts](assets.ts)）：頁面拼裝是純字串
 * 活兒，不該因為要渲染一段 HTML 就依賴一個幾十 MB 的生成檔案。
 */

const LOGO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19v18H6.5A2.5 2.5 0 0 0 4 22z"/>' +
  '<path d="M8 6.5h7M8 10h7M8 13.5h4"/></svg>';

/**
 * @param version 「幫助 → 關於」裡顯示的版本號。由呼叫方傳：它在編譯時寫進內嵌資源表
 *   （`assets.ts` 的 `PRODUCT_VERSION`），這個模組不牽那張表。從前這裡執行時去讀
 *   `package.json`，`bun build --compile` 出來的單檔案旁邊沒有這個檔案，裝出來的版本永遠是 0.0.0。
 */
export function standalonePage(root?: string, version = '0.0.0'): string {
  // 有內建編輯器、但宿主取不到原生編輯器選區（「加入選區」由前端問內建編輯器要，沒選中才彈貼上框），
  // 也沒有原生設定介面可跳；一個程序能同時開幾個工程、每個視窗一個——這幾個能力位就是這個殼與外掛殼的全部介面差異。
  const caps = { builtinEditor: true, selectionFromEditor: false, nativeSettings: false, multiWindow: true };
  const bodyClass = root ? 'workbench' : 'workbench no-workspace';
  return `<!DOCTYPE html>
<html lang="zh-TW" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
<meta name="theme-color" content="#181818">
<link href="/media/view.css" rel="stylesheet">
<link href="/media/standalone.css" rel="stylesheet">
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<title>Novelwarden</title>
</head>
<body class="${bodyClass}">

<!-- ------------------------------------------------------------ 標題欄 -->
<header class="wb-title" id="wbTitle" data-version="${escapeHtml(version)}">
  <span class="wb-logo">${LOGO_SVG}</span>
  <nav class="wb-menubar" id="wbMenubar">
    <button type="button" class="wb-menu-btn" data-menu="file">檔案</button>
    <button type="button" class="wb-menu-btn" data-menu="edit">編輯</button>
    <button type="button" class="wb-menu-btn" data-menu="view">檢視</button>
    <button type="button" class="wb-menu-btn" data-menu="help">幫助</button>
  </nav>
  <span class="wb-title-text" id="wbTitleText">Novelwarden</span>
  <span class="spacer"></span>
  <button class="icon-btn" id="wbThemeBtn" title="切換主題">☀</button>
  <!-- 窄屏上選單欄收進這一顆（view/menubar.ts）；寬屏不顯示。 -->
  <button type="button" class="icon-btn" id="wbMoreBtn" title="選單" aria-label="選單">⋯</button>
</header>

<div class="wb-main">

  <!-- ---------------------------------------------------------- 活動欄 -->
  <!-- 窄屏上它是底欄（narrow.css）：「正文」「更多」只在那兒出現，檔案 / 歷史 / 日誌 / 設定收進「更多」（view/mobileNav.ts）。 -->
${tabbar([
  { tab: 'chat', label: '對話', icon: '✎' },
  { tab: 'project', label: '工程', icon: '❐', dotId: 'projectStaleDot' },
  { tab: 'editor', label: '正文', icon: '¶', nav: true },
  { tab: 'files', label: '檔案', icon: '🗀' },
  { tab: 'versions', label: '版本', icon: '±' },
  { tab: 'history', label: '歷史', icon: '◷' },
  { tab: 'logs', label: '日誌', icon: '☰', dotId: 'logsErrorDot', dotClass: 'err' },
  { tab: 'settings', label: '設定', icon: '⚙' },
  { tab: 'more', label: '更多', icon: '⋯', nav: true },
])}

  <!-- ---------------------------------------------------------- 側欄 -->
  <div class="wb-side" id="wbSide">

${taskBar()}

${chatPane(caps)}

${projectPane()}

<!-- 檔案頁：外掛形態由 VS Code 自己的資源管理器承擔，那邊不裝配這一塊。 -->
${filesPane()}

<!-- 版本頁：編輯區當前那份檔案的時間線（editor.js 畫）。外掛形態用 VS Code 自己的時間線，不裝配。 -->
${versionsPane()}

${historyPane()}

${logsPane()}

${settingsPane(caps)}
  </div>

  <div class="wb-resizer" id="wbResizer" title="拖動調整寬度，雙擊復位"></div>

  <!-- ---------------------------------------------------------- 編輯器 -->
  <!-- 兩塊編輯區並列：主區放正文，草稿區按需出現。草稿區的 DOM 由
       editor.js 克隆主區結構生成，這裡只留容器與那條分隔條。 -->
  <div class="wb-editors" id="wbEditors">
  <section class="wb-editor" id="wbEditor">
    <div class="ed-tabs" id="edTabs"></div>

    <div class="ed-toolbar hidden" id="edToolbar">
      <span class="ed-path" id="edPath"></span>
      <button class="chip-btn" id="edPreviewBtn" title="預覽 Markdown">預覽</button>
      <button class="chip-btn hidden" id="edPlotBtn" title="開啟這一章的細綱（並排；還沒有就按模板建一份）">細綱</button>
      <button class="chip-btn hidden" id="edDraftBtn" title="開啟這一章的草稿（並排）">草稿</button>
      <button class="chip-btn" id="edRevertBtn" title="放棄修改，重新從磁碟讀取">還原</button>
      <button class="chip-btn ed-external-btn" id="edExternalBtn" title="用系統預設程式開啟">外部開啟</button>
      <button class="primary" id="edSaveBtn" title="儲存（Ctrl+S）">儲存</button>
    </div>

    <div class="ed-conflict hidden" id="edConflict">
      <span class="ed-conflict-text" id="edConflictText"></span>
      <button class="chip-btn" id="edConflictTake">用磁碟版本覆蓋編輯器</button>
      <button class="chip-btn" id="edConflictForce">用編輯器內容強制儲存</button>
    </div>

    <!-- 查詢替換條不寫在這裡：兩塊編輯區的那一條都由 editor.js 的 find.ts 現造（DOM 只生成一份）。 -->
    <div class="ed-stage">
      <!-- 歡迎頁（2026-10-24 新手上手）：開始的三條路、最近開啟、一段怎麼上手。不是強制的引導，看一眼就能開寫；
           「幫助 → 歡迎頁面」隨時再開啟。「新建一本書」「匯入寫好的書」各是一張表單，見 media/src/view/welcome.ts。 -->
      <div class="nf-welcome" id="nfWelcome">
        <div class="nf-welcome-col">
          <h2>開始</h2>
          <button type="button" class="nf-welcome-link" data-welcome="newProject">新建一本書…</button>
          <button type="button" class="nf-welcome-link" data-welcome="importBook">匯入寫好的書（txt）…</button>
          <button type="button" class="nf-welcome-link" data-welcome="openFolder">開啟資料夾…</button>
        </div>
        <div class="nf-welcome-col">
          <h2>最近</h2>
          <ul class="nf-recent" id="nfRecentList"></ul>
        </div>
        <div class="nf-welcome-col nf-welcome-copy">
          <h2>怎麼上手</h2>
          <p>寫長篇小說的編輯器，邊寫邊把整本書整理清楚。</p>
          <ol class="nf-welcome-steps">
            <li><strong>寫新書</strong>：「新建一本書」起個書名，再在「工程 → 章節」裡新建第 1 章，右邊就能寫。</li>
            <li><strong>已經寫好的書</strong>：「匯入寫好的書」挑一本 txt，按「第一章 雪夜」這樣單獨一行的章標題切成一章一份。</li>
            <li><strong>讓它幫你整理</strong>：到「設定」配一個模型。匯入的書點對話頁的主按鈕「從已寫正文補齊」；之後每寫完一章點一下「同步」，細綱、角色卡、設定、劇情線就跟到這一章。</li>
            <li>光寫字不需要模型。書就是資料夾裡的普通檔案，可以拿 Git 備份；已經在用的書用「開啟資料夾」。</li>
          </ol>
          <dl>
            <dt><kbd>Ctrl</kbd>+<kbd>O</kbd></dt><dd>開啟資料夾</dd>
            <dt><kbd>Ctrl</kbd>+<kbd>P</kbd></dt><dd>轉到一章或一個檔案</dd>
            <dt><kbd>Ctrl</kbd>+<kbd>/</kbd></dt><dd>快捷鍵一覽</dd>
          </dl>
        </div>
      </div>
      <div class="ed-welcome" id="edWelcome">
        <span class="ed-welcome-logo">${LOGO_SVG}</span>
        <h2>還沒有開啟檔案</h2>
        <p>在「工程」頁點章節、角色卡或設定條目即可在這裡編輯；模型採納寫入後也會自動開啟。</p>
        <dl>
          <dt><kbd>Ctrl</kbd>+<kbd>S</kbd></dt><dd>儲存當前檔案</dd>
          <dt><kbd>Enter</kbd></dt><dd>在對話頁傳送訊息</dd>
          <dt><kbd>@</kbd></dt><dd>引用章節 / 角色 / 設定</dd>
        </dl>
      </div>
      <textarea class="ed-area hidden" id="edArea" spellcheck="false" wrap="soft"></textarea>
      <div class="ed-preview hidden" id="edPreview"></div>
    </div>

    <div class="ed-status">
      <span id="edStatusFile"></span>
      <span id="edStatusWords"></span>
      <span class="spacer"></span>
      <span id="edStatusPos"></span>
      <span class="ed-save-state" id="edStatusSave"></span>
    </div>
  </section>

  <div class="wb-resizer wb-draft-resizer hidden" id="wbDraftResizer" title="拖動調整草稿欄寬度，雙擊復位"></div>
  </div>
</div>

${providerModal()}
${mergeModal()}

${toastSlot()}
<script src="/media/bridge.js"></script>
<script src="/media/view.js"></script>
<script src="/media/editor.js"></script>
<script src="/media/explorer.js"></script>
</body>
</html>`;
}
