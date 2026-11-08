/**
 * 頁面骨架：**所有 pane 的 DOM 只在這裡定義一次**。
 *
 * 從前外掛殼的 webviewHtml.ts 與獨立版的 html.ts 各存了一份，約 200 行逐字
 * 重複，AGENTS.md 裡還專門立過一條「加按鈕要同時改兩處」的規矩——那是給重複
 * 打的補丁。現在兩個殼都從這裡取，各自只保留佈局外殼與 head/CSP/資源 URL。
 *
 * 三條約束（見 ../README.md 的殼契約）：
 * - **零 import**：不碰 `vscode`、不碰 `node:`、不碰 `bun:`。任何殼都要能用它，
 *   包括將來跑在別的執行時裡的殼。由 tests/contract/shellPurity.test.js 守著。
 * - **差異用選項表達，不判斷「我是哪個殼」**：宿主有沒有某個能力，就傳不傳那個選項。
 * - **只有一個殼用到的 pane 也放這裡**（`filesPane`），這樣第四個殼想裝配它時
 *   不必去另一個殼裡抄。
 *
 * 縮排在這裡是統一的一套，與兩個殼原來各自的縮排無關——jsdom 只認結構與 id。
 */

export interface PaneOptions {
  /**
   * 宿主自帶內建編輯器（獨立版的工作臺右半邊）。
   * 影響的只是空狀態裡多給一句「右側是內建編輯器」的指路。
   */
  builtinEditor?: boolean;
  /**
   * 宿主能取到**原生編輯器的選區**（外掛殼）。取不到的宿主（獨立版）由前端問內建編輯器要選區，
   * 沒選中時彈貼上框，title 因此多說一句。
   */
  selectionFromEditor?: boolean;
  /**
   * 宿主有原生設定介面可跳（只有 VS Code 有）。
   * 沒有這個能力時按鈕**根本不渲染**——不是渲染出來再讓前端 hidden 掉。
   */
  nativeSettings?: boolean;
  /**
   * 宿主能同時開幾個工程、每個視窗一個（獨立版）。設定頁因此多一頁「通用」，
   * 放「新視窗中開啟專案」。外掛一個視窗就是一個 VS Code 工作區，沒有這一項。
   */
  multiWindow?: boolean;
}

/** 活動欄/標籤欄的一項。 */
export interface TabItem {
  /** `data-tab` 的值，前端按它切頁。 */
  tab: string;
  label: string;
  /** 活動欄形態的圖示字元；外掛的橫向標籤欄不帶圖示。 */
  icon?: string;
  /** 右上角小圓點的 id（如 `projectStaleDot`）。 */
  dotId?: string;
  /** 圓點的額外 class（如 `err`）。 */
  dotClass?: string;
  /**
   * 不是一頁，是窄屏底欄上的一顆導航鍵（獨立版的「正文」「更多」）：寫成 `data-nav` 而不是 `data-tab`，
   * 頁籤切換不認它，由 `media/src/view/mobileNav.ts` 接手。
   */
  nav?: boolean;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 標籤欄 / 活動欄。第一項預設選中。
 *
 * 兩個殼的觀感差別（橫向文字標籤 vs 縱向圖示）全在 CSS 裡，這裡只管
 * `data-tab` 與圓點——前端認的就是這些。
 */
export function tabbar(items: TabItem[]): string {
  const buttons = items
    .map((item, i) => {
      const icon = item.icon ? `<span class="tab-icon">${item.icon}</span>` : '';
      const label = item.icon ? `<span>${item.label}</span>` : item.label;
      const dot = item.dotId
        ? `<span class="tab-dot${item.dotClass ? ` ${item.dotClass}` : ''} hidden" id="${item.dotId}"></span>`
        : '';
      const key = item.nav ? 'data-nav' : 'data-tab';
      return `  <button class="tab${i === 0 && !item.nav ? ' active' : ''}" ${key}="${item.tab}">${icon}${label}${dot}</button>`;
    })
    .join('\n');
  return `<nav class="tabbar" id="tabbar">\n${buttons}\n</nav>`;
}

/** 對話頁：流水線條 + 訊息流 + 下一步 + 輸入區。 */
export function chatPane(opts: PaneOptions = {}): string {
  const editorHint = opts.builtinEditor
    ? '\n      <p>在「工程」頁點任意檔案即可在內建編輯器裡開啟編輯<span class="kbd-hint">，<kbd>Ctrl</kbd>+<kbd>S</kbd> 儲存</span>。</p>'
    : '';
  const selTitle = opts.selectionFromEditor
    ? '把編輯器中選中的文字加入上下文'
    : '把編輯器中選中的文字加入上下文（沒有選中時貼上一段原文）';
  return `<section class="pane active" id="pane-chat">
  <!-- 沒同步的橫幅只長在工程頁（那邊還帶進度條與分母）。對話頁從前也掛著
       一份純文字版，說的是同一句話，卻常年佔著本就不寬裕的訊息流；這裡要提示
       的那件事本身也只能在工程頁上處理。活動欄「工程」上的小圓點負責在別的
       頁面上留個記號。 -->

  <!-- 流水線條：這一章走到哪一步了。點大綱 / 細綱 / 正文那一格切到那一層（大綱那一格回到全書那一層）。
       目標是架構或大綱時只剩麵包屑，下面那一行隱藏。 -->
  <div class="pipeline" id="pipeline">
    <div class="pipeline-top" id="pipelineTop">
      <div class="pipeline-crumb" id="pipelineCrumb"></div>
      <!-- 給當前這一章的細綱起名 / 改名。手工新建的細綱是純序號名（標題要等
           細綱排完才定得下來），所以命名得有個常駐入口。
           目標是架構或大綱時前端把它藏起來。 -->
      <button class="pipeline-new hidden" id="renamePlotBtn" title="重新命名當前章節" aria-label="重新命名當前章節">✎</button>
      <button class="pipeline-new" id="newSessionBtn" title="開始新對話" aria-label="開始新對話">＋</button>
    </div>
    <!-- 大綱 / 細綱 / 正文三格（可點）與同步狀態（只讀）。內容由 view/pipeline.ts 畫。 -->
    <div class="pipeline-stages" id="pipelineStages"></div>
    <!-- 「當前產物」的入口：一行標題。懸停浮出這一層的產物，點選釘住。
         從前它是訊息流頂部一張 sticky 卡片——關不掉、藏不起來，還長期佔著
         半屏對話。現在與工程頁那三隻浮窗同一套路子。 -->
    <button class="wb-entry hidden" id="workbench"></button>
  </div>

  <div class="messages" id="messages">
    <div class="empty" id="emptyHint">
      <p><strong>跟著輸入框上方的主按鈕走：它永遠是這本書現在該做的那一步</strong></p>
      <p>從一句話開始：先生成小說配置、故事前提、角色圖譜、世界觀與設定清單，再排情節大綱、拆細綱，最後一章一章寫正文。想接著寫某一章，在「工程」頁右鍵（手機上長按）「進入這一章」，或用下面的下拉框選它；下拉框最上面的「全書」回到架構與大綱那一層。</p>
      <p>用 <kbd>@</kbd> 引用正文、角色卡或任意檔案；在輸入框裡打 <kbd>/</kbd> 可以挑其它命令，「/續寫大綱」在哪一層都能用。</p>${editorHint}
    </div>
    <!-- 開啟的資料夾還不是小說工程：訊息區只放這一塊（W12）。由 #messages 上的 uninit 類切換。 -->
    <div class="empty" id="initHint">
      <p><strong>下一步：把這個資料夾初始化成小說工程</strong></p>
      <p>會建立 chapters/ 與 .novelwarden/ 目錄及模板檔案。</p>
      <p><button class="primary" id="initProjectBtn">初始化小說工程</button></p>
    </div>
  </div>

  <!-- 下一步：狀態機算出來的那一個動作。點了就跑，不必先輸入什麼。 -->
  <div class="nextstep hidden" id="nextStep">
    <div class="nextstep-text">
      <span class="nextstep-label" id="nextStepHint"></span>
    </div>
    <button class="primary nextstep-go" id="nextStepBtn"></button>
  </div>

  <!-- 輸入區。「/」命令面板由前端掛進 #composerInput（它是 position: relative），
       從輸入框上沿浮出來——命令本身留在輸入框裡當普通文字，與 Cursor 一致。 -->
  <div class="composer" id="composer">
    <!-- 動手之前那一句問。**固定在輸入框上方**，不跟著訊息流滾：迴圈正卡在這裡
         等回答，一張會滾出視野的卡片等於沒人看見（Cursor 那一套）。答完卡片就
         走，只在訊息流裡留一行「已跳過/已允許」當記錄。 -->
    <div class="gate-dock hidden" id="gateDock"></div>
    <div class="chips" id="chips"></div>
    <div class="composer-input" id="composerInput">
      <!-- 已挑好、待執行的命令。它長在輸入框**裡面**，傳送時用它，不用狀態機那一個。 -->
      <div class="pending-cmd hidden" id="pendingCmd"></div>
      <textarea id="input" rows="3" placeholder="補充要求（可留空）…（Enter 傳送，Shift+Enter 換行）"></textarea>
    </div>
    <!-- 這一行常年擠著九個控制元件，側欄一窄就折成兩三行。@ 與 / 在輸入框裡直接打效果一樣，
         這兩顆因此只留那一個鍵（文字在 title 與 aria-label 裡），省出寬度給三個下拉框。 -->
    <div class="composer-bar">
      <button class="composer-tool key-only" id="atBtn" title="引用檔案或正文（在輸入框裡打 @ 也一樣）" aria-label="引用檔案或正文"><span class="tool-key">@</span></button>
      <button class="composer-tool" id="selBtn" title="${selTitle}">加入選區</button>
      <button class="composer-tool key-only" id="cmdBtn" title="其它命令（在輸入框裡直接打 / 也一樣）" aria-label="其它命令"><span class="tool-key">/</span></button>
      <select id="modelSelect" title="使用哪個模型"></select>
      <!-- 思考深度：跟著**會話**走，不是設定項（見 core/model/session.ts）。 -->
      <select id="thinkSelect" title="讓模型想多深"></select>
      <select id="targetSelect" title="當前創作目標"></select>
      <span class="spacer"></span>
      <button class="primary" id="sendBtn">傳送</button>
      <button class="danger hidden" id="stopBtn">停止</button>
    </div>
    <div class="composer-meta" id="providerMeta"></div>
  </div>
</section>`;
}

/**
 * 頁頭的長任務條（W8、D24）：正在跑的長任務（批次寫章、定稿、同步細綱……）。**所有頁籤都看得見**
 * ——從前它長在工程頁裡，從對話頁點的定稿、批次跑起來之後切回對話頁就什麼都看不見了。
 * 沒有任務時整塊隱藏。兩個殼各自把它放在頁籤之上的那一處（外掛在標籤欄下面，獨立版在側欄頂上）。
 */
export function taskBar(): string {
  return '<div class="tasks hidden" id="taskList"></div>';
}

/** 工程頁：頁籤條 + 各頁的分組。 */
export function projectPane(): string {
  return `<section class="pane" id="pane-project">
  <div class="project-tabs" id="projectTabs" role="tablist" aria-label="工程分類">
    <!-- 五個頁籤：章節、角色、設定、敘事線各佔一頁，其餘（故事架構、文風與摘要）留在「概覽」。各頁的內容由
         view/project/index.ts 裝進 #projectBody 裡對應的 .project-panel。從前這一行是五顆按鈕（補齊架構、
         拆細綱、批次寫章、＋ 角色卡、＋ 設定），每一顆在對應分組的右鍵裡都有，拿掉了。
         右邊重新整理的左邊是存檔點（⚑，2026-10-20）：整本書存一版、看改了什麼、整本或單份退回，不調模型；
         彈窗在 media/src/view/checkpoints.ts。只放一個圖示，與重新整理並排（獨立版的「檔案」選單裡另有一項「存檔點…」）。 -->
    <button class="project-tab active" id="projectTab-overview" data-project-tab="overview" role="tab" aria-selected="true">概覽</button>
    <button class="project-tab" id="projectTab-chapters" data-project-tab="chapters" role="tab" aria-selected="false" tabindex="-1">章節</button>
    <button class="project-tab" id="projectTab-characters" data-project-tab="characters" role="tab" aria-selected="false" tabindex="-1">角色</button>
    <button class="project-tab" id="projectTab-lore" data-project-tab="lore" role="tab" aria-selected="false" tabindex="-1">設定</button>
    <button class="project-tab" id="projectTab-threads" data-project-tab="threads" role="tab" aria-selected="false" tabindex="-1">敘事線</button>
    <span class="spacer"></span>
    <button class="icon-btn" data-form="checkpoints" aria-label="存檔點" title="存檔點：整本書存一版、看之後改了哪幾份，整本或單份退回去（不調模型）。批次寫章、全書替換這類批次動作之前會自動存一個">⚑</button>
    <button class="icon-btn" data-action="refresh" title="重新整理">⟳</button>
  </div>
  <div class="project-body" id="projectBody"></div>
</section>`;
}

/**
 * 檔案頁：磁碟上真實的目錄結構，含 `.novelwarden/` 等點開頭的資料夾。
 *
 * 目前只有獨立版裝配它——外掛形態由 VS Code 自己的資源管理器承擔這件事。
 * 放在這裡而不是放進獨立版殼，是為了第四個殼想要它時直接裝配，不必去抄。
 */
export function filesPane(): string {
  return `<section class="pane" id="pane-files">
  <div class="fx-toolbar">
    <span class="fx-title">資源管理器</span>
    <span class="spacer"></span>
    <button class="icon-btn" id="filesReveal" title="定位編輯器裡當前的檔案">◎</button>
    <button class="icon-btn" id="filesCollapse" title="全部摺疊">⌃</button>
    <button class="icon-btn" id="filesRefresh" title="重新整理">⟳</button>
  </div>
  <div class="fx-body" id="filesBody"></div>
  <div class="hint fx-foot">這裡是工程目錄的原樣結構，含 <code>.novelwarden/</code> 等點開頭的資料夾。文字檔案在內建編輯器裡開啟，其餘交系統程式。</div>
</section>`;
}

/**
 * 版本頁（只有獨立版裝配：內容由 editor.js 的 `editor/versions.ts` 畫）：上面全書改動（跟一個存檔點比改過的檔案），下面編輯區
 * 當前那份檔案的時間線（還沒儲存的改動、快照、存檔點裡的樣子），點一行在編輯區開對比標籤。
 */
export function versionsPane(): string {
  return `<section class="pane" id="pane-versions">
  <div class="vs-toolbar">
    <span class="vs-title">版本</span>
    <span class="spacer"></span>
    <button class="icon-btn" id="versionsSave" title="現在存一版：把磁碟上現在這一份存下來（編輯器裡沒儲存的修改不在裡面）">＋</button>
    <button class="icon-btn" id="versionsRefresh" title="重新整理">⟳</button>
  </div>
  <div class="vs-body" id="versionsBody"></div>
  <div class="hint vs-foot" id="versionsFoot"></div>
</section>`;
}

/** 歷史頁：會話列表。 */
export function historyPane(): string {
  return `<section class="pane" id="pane-history">
  <div class="pane-head">
    <span>對話歷史</span>
    <span class="meta" id="historyMeta"></span>
  </div>
  <div class="hint">會話儲存在 <code>.novelwarden/sessions/</code>，可隨工程一起提交。</div>
  <ul class="sessions" id="sessionList"></ul>
</section>`;
}

/** 日誌頁：過濾工具欄 + 日誌體。 */
export function logsPane(): string {
  return `<section class="pane" id="pane-logs">
  <div class="log-toolbar">
    <select id="logLevel" title="只顯示這一級別以上的日誌">
      <option value="debug">全部（含除錯）</option>
      <option value="info" selected>資訊及以上</option>
      <option value="warn">警告及以上</option>
      <option value="error">僅錯誤</option>
    </select>
    <input type="search" id="logFilter" placeholder="過濾關鍵字…">
    <label class="log-follow"><input type="checkbox" id="logFollow" checked>自動滾動</label>
    <span class="spacer"></span>
    <span class="meta" id="logMeta"></span>
    <button class="chip-btn" id="logEarlierBtn" title="從工程資料庫裡讀更早的日誌（重啟前的也在）">載入更早</button>
    <button class="chip-btn" id="logCopyBtn" title="複製當前篩選出的日誌">複製</button>
    <button class="chip-btn" id="logClearBtn" title="清空日誌緩衝">清空</button>
  </div>
  <div class="log-body" id="logBody"></div>
</section>`;
}

/**
 * 設定頁：服務商與模型、預設模型、高階設定（分檔 / 任務檔位 / 請求排程）、上下文管理。
 *
 * 儲存說明對兩個殼是同一句話——外掛殼在遷移之後也用 `FileConfigStore`
 * （`~/.novelwarden/config.json`）。這裡**不再按殼分叉**：從前那句「設定寫入工作區
 * settings.json」只在獨立版才被前端改掉，於是外掛形態長期顯示著一句不成立的話。
 */
export function settingsPane(opts: PaneOptions = {}): string {
  const nativeBtn = opts.nativeSettings
    ? '\n    <button class="link" id="nativeSettingsBtn">在 VS Code 設定中開啟</button>'
    : '';
  const generalTab = opts.multiWindow
    ? '\n    <button class="settings-subtab" id="settingsTabGeneral" data-settings-tab="general" role="tab" aria-selected="false" aria-controls="settingsPanelGeneral">通用</button>'
    : '';
  const generalPanel = opts.multiWindow
    ? `

  <div class="settings-panel" id="settingsPanelGeneral" data-settings-panel="general" role="tabpanel" aria-labelledby="settingsTabGeneral">
    <div class="pane-head"><span>視窗</span></div>
    <div class="hint">
      每個瀏覽器視窗各開一個工程，互不干擾。開著這一項時，在已經開著工程的視窗裡再開啟別的工程（開啟資料夾、新建工程、最近開啟），
      會開一個新視窗，當前視窗不動；關掉則換掉當前視窗裡的工程。空視窗裡開啟總是用當前視窗。
      外部 Agent 經 MCP 呼叫時，地址帶 <code>?project=&lt;工程目錄&gt;</code> 就落到那個工程，不帶就落到最近操作的那個視窗。
    </div>
    <div class="grid">
      <label class="field"><span>新視窗中開啟專案</span><input type="checkbox" id="setOpenInNewWindow"></label>
    </div>
  </div>`
    : '';
  return `<section class="pane" id="pane-settings">
  <div class="settings-subtabs" role="tablist" aria-label="設定分類">
    <button class="settings-subtab active" id="settingsTabModels" data-settings-tab="models" role="tab" aria-selected="true" aria-controls="settingsPanelModels">模型配置</button>
    <button class="settings-subtab" id="settingsTabContext" data-settings-tab="context" role="tab" aria-selected="false" aria-controls="settingsPanelContext">上下文管理</button>${generalTab}
    <button class="settings-subtab" id="settingsTabSkills" data-settings-tab="skills" role="tab" aria-selected="false" aria-controls="settingsPanelSkills">技能</button>
  </div>

  <div class="settings-panel active" id="settingsPanelModels" data-settings-panel="models" role="tabpanel" aria-labelledby="settingsTabModels">
    <div class="pane-head">
      <span>服務商與模型</span>
      <span class="meta" id="providerCount"></span>
    </div>
    <div class="hint">
      模型用「字首/模型名」引用，字首是服務商 id。同一個模型走不同渠道就是兩條：
      <code>glm/glm-4-plus</code> 與 <code>openrouter/z-ai/glm-4.6</code>。
      模型名本身可以帶斜槓，只在第一個斜槓處切分。視窗與輸出上限在每個模型裡單獨配置。
    </div>

    <div id="providerList"></div>

    <div class="actions">
      <button class="secondary" id="addProviderBtn">＋ 新增服務商</button>
    </div>

    <div class="pane-head"><span>預設模型</span></div>
    <div class="hint">
      工程頁的同步、提取角色卡、生成設定、提取文風等操作用這份列表：<b>序列時用第一個</b>，失敗會自動換用後面的重試；
      <b>併發時在列表裡輪轉</b>做負載均衡。對話頁隨時可在輸入框旁的下拉框裡切換——切換等於把那個模型提到列表首位。
    </div>
    <div id="defaultModelList"></div>

    <button type="button" class="settings-advanced-toggle" id="settingsAdvancedToggle" aria-expanded="false" aria-controls="settingsAdvanced">
      <span class="caret">▸</span>
      <span class="settings-advanced-title">高階設定</span>
      <span class="meta">模型分檔 · 任務檔位 · 請求與排程</span>
    </button>
    <div id="settingsAdvanced" hidden>
      <div class="pane-head"><span>模型分檔</span></div>
      <div class="hint">
        簡單大量的活交給便宜模型，困難的活交給聰明模型。<b>每檔留空就沿用上面的「預設模型」</b>——
        三檔都不配，行為和不分檔時完全一樣。每檔也是一份有序清單：序列用第一個，失敗自動換用<b>同檔</b>其餘模型，
        併發時在檔內輪轉。<b>換人只在檔內發生</b>，快速檔失敗不會偷偷升級到精標檔去燒貴 token。
        對話頁續寫不受分檔影響，始終用你在輸入框旁選的那個模型。
      </div>
      <div class="tier-grid">
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">快速檔</span><span class="tier-hint">便宜、快，用於量大而單次簡單的活</span></div>
          <div id="tierModelList-fast"></div>
        </div>
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">均衡檔</span><span class="tier-hint">折中，用於量不小但質量也要緊的活</span></div>
          <div id="tierModelList-balanced"></div>
        </div>
        <div class="tier-block">
          <div class="tier-head"><span class="tier-name">精標檔</span><span class="tier-hint">最聰明的模型，用於一次定調、錯了代價大的活</span></div>
          <div id="tierModelList-quality"></div>
        </div>
      </div>

      <div class="pane-head"><span>任務檔位</span></div>
      <div class="hint">每項工程頁任務歸在哪一檔。標「預設」的是內建推薦值，按呼叫次數與單次難度定的。</div>
      <div id="taskTierTable"></div>

      <div class="pane-head"><span>請求與排程</span></div>
      <div class="hint">併發與重試只作用於工程頁批次任務；對話頁續寫始終單請求、嚴格使用當前選中的模型。超時按「多久沒收到資料」計，流式輸出期間不會觸發。</div>
      <div class="grid">
        <label class="field"><span>溫度</span><input type="number" id="setTemperature" min="0" max="2" step="0.1"></label>
        <label class="field"><span>請求超時（毫秒）</span><input type="number" id="setRequestTimeoutMs" min="10000" step="10000"></label>
        <label class="field"><span>併發請求數</span><input type="number" id="setConcurrency" min="1" max="16"></label>
        <label class="field"><span>換模型重試次數</span><input type="number" id="setFallbackAttempts" min="0" max="5"></label>
      </div>
    </div>
  </div>

  <div class="settings-panel" id="settingsPanelContext" data-settings-panel="context" role="tabpanel" aria-labelledby="settingsTabContext">
    <div class="pane-head"><span>上下文詳細度</span></div>
    <div class="hint">每一次呼叫帶多少前文與設定：寫架構、大綱、細綱、正文、審稿、修稿，以及提取文風與角色、排敘事線、同步判線、寫前衝突檢查都按它。級別越高帶得越多、越貴；任何一級都不改呼叫次數。預算不足時仍會按明細中說明的順序降級或省略。</div>
    <div class="grid">
      <label class="field"><span>上下文詳細度</span><select id="setContextDetail"></select></label>
    </div>
    <div class="hint" id="contextDetailHint"></div>

    <div class="pane-head"><span>刪修飾</span></div>
    <div class="hint">寫完一章正文之後，讓同一個模型再過一遍，只刪名詞前堆的形容詞、動詞前的程度副詞這類多餘修飾，不加字、不動對白；刪壞的段落自動退回原文。每章多調 1 次模型。對話頁寫入前可以逐段把刪改退回原文。</div>
    <div class="grid">
      <label class="field"><span>寫完正文刪修飾</span><input type="checkbox" id="setTrimModifiers"></label>
    </div>

    <div class="pane-head"><span>全文大綱</span></div>
    <div class="hint">重建全文大綱時，同步過的各章細綱先按此數量分批匯總，再合併成全文大綱。</div>
    <div class="grid">
      <label class="field"><span>每批章數</span><input type="number" id="setSummaryBatchSize" min="3"></label>
    </div>
  </div>${generalPanel}

  <div class="settings-panel" id="settingsPanelSkills" data-settings-panel="skills" role="tabpanel" aria-labelledby="settingsTabSkills">
    <div class="hint">
      寫作技能是一份<b>補充的寫作方法</b>（一個目錄裡一份 <code>SKILL.md</code>，可以帶它引用的 <code>references/</code> 這類檔案）。給本工程的某個階段綁上一份，
      這個階段往後的每一次生成都會把它放在提示詞最前面——對話頁、外部 Agent 經 MCP 生成、工程頁批次都一樣。
      它只能補充寫法：<b>作者事實和輸出格式始終優先</b>。討論與同步不帶。這一頁的改動當場生效，不用點「儲存設定」。
    </div>

    <div class="pane-head"><span>本工程的階段繫結</span></div>
    <div class="hint" id="skillBindingHint"></div>
    <div class="grid" id="skillBindings"></div>

    <div class="pane-head"><span>從 GitHub 安裝</span></div>
    <div class="hint">
      只收純提示詞的技能：要跑指令碼、裝 hook、派子代理、調工具的，都裝不了。<code>SKILL.md</code> 引用的文字檔案（<code>references/*.md</code> 這類）會一起下載、生成時接在正文後面一起帶；引用了卻下不到的也裝不了。
      先檢查（只下載來看，不寫任何檔案），看過正文再確認安裝；安裝時會重新下載，與檢查時那一份核對一致才裝。
    </div>
    <div class="skill-install">
      <input type="url" id="skillUrl" placeholder="https://github.com/owner/repo/tree/main/skills/xxx" aria-label="技能的 GitHub 地址">
      <button class="secondary" id="inspectSkillBtn">檢查</button>
    </div>
    <div id="skillInspection"></div>

    <div class="pane-head"><span>技能庫</span><span class="meta" id="skillCount"></span></div>
    <div class="hint" id="skillLibraryHint"></div>
    <div id="skillList"></div>
  </div>

  <div class="actions" id="settingsSaveRow">
    <button class="primary" id="saveSettingsBtn">儲存設定</button>${nativeBtn}
  </div>
  <div class="hint" id="settingsStorageHint">設定寫入 <code>~/.novelwarden/config.json</code>；API Key 存在 <code>~/.novelwarden/secrets.json</code>，不進配置檔案。</div>
</section>`;
}

/** 服務商配置的模態框（設定頁用）。 */
export function providerModal(): string {
  return `<div class="modal-overlay hidden" id="providerModal">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="providerModalTitle">配置</span>
      <button class="icon-btn" id="providerModalClose" title="關閉">×</button>
    </div>
    <div class="modal-body" id="providerModalBody"></div>
  </div>
</div>`;
}

/**
 * 覆蓋審閱的段級 diff / 合併檢視（五期 W11，只有獨立版放它：外掛用 VS Code 自己的 diff 編輯器）。
 * 內容由 media/src/view/merge.ts 按 `prompt kind: 'merge'` 填。
 */
export function mergeModal(): string {
  return `<div class="modal-overlay merge-overlay hidden" id="mergeModal">
  <div class="modal merge-modal" role="dialog" aria-labelledby="mergeTitle">
    <div class="modal-head">
      <span class="modal-title" id="mergeTitle">對比</span>
      <span class="merge-progress" id="mergeProgress"></span>
      <button class="secondary small" id="mergeAllOld">全部保留原文</button>
      <button class="secondary small" id="mergeAllNew">全部採用新版</button>
    </div>
    <div class="hint merge-path" id="mergePath"></div>
    <div class="modal-body merge-body" id="mergeBody"></div>
    <div class="actions merge-foot">
      <span class="hint merge-foot-hint" id="mergeHint"></span>
      <button class="secondary" id="mergeDiscard">放棄</button>
      <button class="primary" id="mergeApply">寫入合併結果</button>
    </div>
  </div>
</div>`;
}

/** toast 的落點。前端往裡填內容。 */
export function toastSlot(): string {
  return '<div class="toast hidden" id="toast"></div>';
}
