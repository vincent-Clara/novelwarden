# core — 無 UI 依賴的核心邏輯

與宿主（VS Code 外掛 / 獨立 Web 服務 / 桌面殼）無關的核心邏輯。子目錄按職責分層：

| 目錄 | 職責 |
|---|---|
| [model/](model/README.md) | 資料層：資料結構、Markdown 解析、`NovelProject` 的領域查詢、服務商配置、會話儲存；寫盤全在 `workspace/`。 |
| [workspace/](workspace/README.md) | ★ **工程的唯一讀寫閘道器**（`list` / `read` / `write` / `edit` / `move` / `remove` / `search`）；新程式碼不許繞過 `guard.ts` 直接寫盤。 |
| [context/](context/README.md) | ★ 上下文裝配：token 粗估與分層預算裝配器 |
| [generation/](generation/README.md) | ★ 創作的一次單步：`generate.ts` 無狀態地裝配 → 調模型 → `Draft`，`accept.ts` 落盤分派，`drafts.ts` 讓沒落盤的產物活過重新整理。 |
| [tools/](tools/README.md) | ★ **工具層**：契約、schema 校驗、登錄檔與 `novel/` 的工具；沒有刪除 / 改名 / 移動。 |
| [mcp/](mcp/README.md) | ★ **把工具端給外部 agent**：MCP 協議與 Streamable HTTP，執行端在 `controller/mcp.ts`；本專案不自帶迴圈。 |
| [features/](features/README.md) | 功能編排：批次流水線、定稿、敘事線、預檢、全文大綱、角色卡、設定名錄、文風、拆書。 |
| [skills/](skills/README.md) | 寫作技能：三個來源、從 GitHub 先檢查再安裝、階段繫結（`.novelwarden/skills.json`）。 |
| [llm/](llm/README.md) | 模型接入：`LlmProvider` 介面、OpenAI / Anthropic 協議實現、provider 登錄檔 |
| [files/](files/) | ★ 工程檔案能力的互動流程（三區界限、輸入框、提示文案、目錄列舉與 `@` 候選），落盤一律轉調 `workspace/`。 |
| [views/](views/README.md) | ★ 只讀聚合與介面快照，只從磁碟取數、不寫盤；`model/pipeline.ts` 是純狀態機，不遷入 `views/`。 |
| [runtime/](runtime/README.md) | ★ 執行時設施：日誌、SQLite 痕跡庫、失敗記錄、長任務、有界併發；`logger.ts` 零依賴，依賴方向不可反轉。 |

依賴方向自上而下：`features/` / `generation/` → `context/` / `llm/` → `skills/` → `workspace/` → `model/`，反向不允許（`skills/` 只 `import type` 閘道器，寫繫結時由呼叫方把 `Workspace` 交進來）。`tools/` 坐在最上面（它調 `generation/`、`workspace/` 與 `features/`），**不認識 `controller/`**——反過來會成環。

`mcp/` 只認 `tools/` 的契約（`ToolSpec`、`NOVEL_TOOLS`），tools 一行都不 import `mcp/` 與 `controller/`。綁在一起的是 `controller/mcp.ts`——它給工具綁好當前工程，佔生成鎖、在對話頁掛 MCP 氣泡、問那兩句（`always` 動手前、產物落盤前）。這條邊由 [tests/contract/layerBoundary.test.js](../../tests/contract/layerBoundary.test.js) 守著。

本目錄根下只保留入口膠水與跨子目錄契約：

| 檔案 | 職責 |
|---|---|
| [protocol/](protocol/index.ts) | 前端 ↔ 後端的訊息協議（`InMessage` / `OutMessage` / `ViewState`），前後端的唯一契約。 |
| [controller/](controller/index.ts) | ★ `ChatController`：全部面板邏輯，按訊息域拆在同目錄模組裡；併發鎖與動手前那一問都在這一層。 |
| [host.ts](host.ts) | core 對宿主的唯一依賴面（窄介面）：彈窗/選擇/進度/檔案監聽/開啟檔案等，兩個殼各實現一份。 |
| [actions.ts](actions.ts) | 工程級互動流程（初始化、新建一章、粘進現成的一章、新建一本書），命令面板與網頁共用。 |
| [config.ts](config.ts) | `readConfig` / `readBudgetFallback` / `updateSettings`，資料來源由宿主注入的 `ConfigStore` 提供。 |
| [stores.ts](stores.ts) | 檔案後端的配置/金鑰儲存（`~/.novelwarden/`），雙殼共用。環境變數 `NOVELWARDEN_HOME` 能把它挪走：Android 殼的家目錄是放書的公共目錄，金鑰指回 app 私有目錄。 |

## 已知約定

- 本層**零 vscode 依賴**（雙形態改造的前提）：彈窗/進度/檔案監聽等宿主能力全部經窄介面 `host.ts`。新程式碼不要增加對 `vscode` 的依賴，也不要依賴具體的檢視/面板型別；完整改造背景見 `docs/design/plans` 的 standalone 改造計劃。
- **長任務一律走 `runTask`，不要直接調 `getHost().progress`**：直調只有宿主自己的 UI 看得見（VS Code 的通知條 / 獨立版什麼都沒有），網頁上那條進度條與計時不會動，日誌裡也不會留下開始/結束與耗時。`runTask` 把這三件事一次做完，`report({ message, current, total })` 給了 `total` 前端才畫得出進度條。併發跑時 `current` **只在一項真正結束時 +1**（`runPool` 的 `onSettled` 會把已完成數遞給你），按啟動數遞增會讓進度條衝到頭然後乾等。
- **日誌三條硬約束**（對應 `runtime/logger.ts` 的實現）：① 所有文字過 `redact`，API Key 絕不落進日誌——它會被使用者複製進 issue；② sink 拋異常只被吞掉，日誌壞了不能帶崩正事；③ 只記條數與字數，**絕不記 prompt / 正文全文**——一次正文生成的 prompt 有十萬字，進了緩衝會把此前所有日誌擠沒（見 `features/creation.ts` 的 `logAssembly`）。
- **降級與丟棄必須同時進日誌**：「不靜默截斷」這條產品承諾過去只落在介面的上下文明細裡，摺疊著不點開就看不見。現在裝配器的降級項、定稿與同步細綱跳過的章、超預算被截斷的正文都會打一條 `warn`。新加截斷邏輯時記得跟上。
- **失敗還要留在出錯的東西身上，不只是日誌**：日誌與 toast 都要求使用者「恰好在看」。角色卡/章/設定失敗時經 `runtime/errorLog.ts` 記一條（`severity: 'error'` = 目標一字未改，`'warn'` = 部分完成、下次重來），工程頁那一行就掛上感嘆號，一直掛到成功。**成功路徑必須 `clearFailures`**——修好了還掛著比一開始不報錯更糟，使用者會學會無視它。`targetKey` 一律用 relPath（名字會被作者改，路徑才是當下的身份，而且前端的樹本來就按 relPath 索引）。
- **庫不可用不是錯誤路徑**：`runtime/db.ts` / `runtime/errorLog.ts` 的每個 API 都自己吞異常並降級為「沒有庫」。純讀取的呼叫方（`listActiveFailures`、`clearFailures`、`readLogHistory`）必須帶 `{ create: false }`——否則光是開啟工程頁就會在作者的 `.novelwarden/` 裡憑空生出一個 db 檔案。寫日誌失敗**絕不能再打日誌**（會遞迴刷屏），只往 stderr 說一次然後徹底靜默。
- `readConfig` / `readBudgetFallback` 位於 `config.ts`，資料來源由宿主注入的 `ConfigStore` 提供。模型預算在模型條目上配置；`readBudgetFallback` 只為未填寫的模型與舊版全域值兜底，不是設定頁配置項。
- **一條軸：細綱號 = 章號**：章節順序永遠由檔名的數字字首決定，與它在第幾層子目錄無關；分卷目錄只是收納，不重置編號。細綱**映象正文在章節根下的相對路徑**，副檔名換成 `.md`（`chapters/第一卷/003-深处.txt` ↔ `.novelwarden/summaries/第一卷/003-深处.md`，與草稿同一套映象）：`summaries/` 遞迴掃描，各級子目錄裡數字開頭的 `.md` 都是細綱（`global.md` 是全文大綱，老工程的 `plots/` 判 `other`、不讀）。有正文的章**按路徑**認它的細綱（`NovelProject.plotFor` / `plotOfChapter`），還沒有正文的計劃按檔名的章號認，正文照它的路徑反推著落（`chapterPathForPlot`）。章節在工具裡改名/移動時細綱跟著搬（`workspace/handlers/chapter.ts` 的 `carryPlot`）；在外面改了正文的名，舊細綱不冒認。定稿照正文反向更新**同一份**細綱，不另存一份。上下文裝配的正文只取 `chapters/`，定稿過沒有、定稿之後正文改沒改（細綱的 `sourceHash` 對正文的 hash）一律按 `chapters/` 算。工程頁每層內**正序**展示（第 1 章在上，與檔名順序一致）。
- **細綱正文不進 `ProjectTree`**：那棵樹每次檔案變動都全量重推（`pushState` → `buildProjectTree`），一本兩百章的書每章帶上千字細綱，等於每儲存一次正文就推幾百 KB。懸停浮窗要的細綱走單獨的 `requestSummary` / `summary` 一問一答（`buildPlotSummaryView`），前端按行路徑快取、收到新樹即作廢。往樹上加欄位前先想想它會不會把這條推送撐爆。（`failures` 是有意的例外：一條几十字，**且只有出錯的目標才有**，正常工程是空物件。）
- **草稿不是可管理區**：`drafts/` 不在 `files/fileOps.ts` 的三個區裡（工程頁上也沒有它的節點），但它是**可開啟的**——`files/fileEditing.ts` 只看工程根包含 + 副檔名/章節規則 + 大小，草稿天然滿足。草稿路徑由 `NovelProject.draftRelPathFor` 從章節路徑推導，別在別處另拼一份。
- **草稿永不自動注入**：`context/builder.ts` 裡沒有任何一處讀 `drafts/`，草稿只能經 `resolveAttachment`（作者顯式 `@` 引用）進 prompt。加功能時別打破這條——它是「不偷偷燒 token」的一部分。
- **`openDraft` 會寫盤**：`controller/files.ts` 裡那句 `listChapters().find(...)` 是它沒變成「往 `drafts/<任意路径>` 寫檔案」的原語的唯一原因。別為了省一次掃描就信任前端傳來的路徑。
- **定稿過的細綱是出場人物的唯一真相**：角色卡 frontmatter 裡的 `appearsIn` / `updatedThrough` **只是快取**。想知道誰在哪出場，一律經 `views/cast.ts` 的 `buildCastIndex()` 從定稿過的細綱重算，別讀角色卡的欄位——重新定稿之後那裡就舊了。只認有 `sourceHash` 的細綱：沒定稿的那份「出場人物」是計劃出場，只給裝配器挑角色卡用，混進來會汙染統計。索引按 `name ∪ aliases` 匹配（細綱裡的名字是模型寫的，角色卡檔名是作者起的，兩者沒有硬關聯）。
- **別名只收專屬稱呼，正式名壓過別名**：aliases 是「誰是誰」的判據（`views/cast.ts` / `model/identity.ts` 都吃它），泛稱會把幾個角色串成一個，別人的名字會讓出場章整批記錯人。所以模型產出的別名一律經 `model/naming.ts` 過濾，索引兩趟建表（先佔正式名再登記別名）。搶名的情況記進 `CastIndex.conflicts`，由工程頁與日誌說出來——出場統計必然有一張卡是錯的，而這件事從介面上看不出來。
- **判定兩個稱呼是同一個人，只信同章共現**：`model/identity.ts` 裡同一章 cast 中各自出場的兩個稱呼是硬約束，永不合併；別的都只是證據。把兩個角色錯併成一個遠比多建一張卡難收拾——此後所有出場統計與角色卡語料都是錯的，而介面上一切正常。
- **`characterAction` 與 `fileAction` 不能合併**：前者的作用物件是**一個角色**（用名字標識），未建卡的人物根本沒有檔案，走 `fileAction` 那套區守衛無從談起。
- **資源管理器只列不改，寫走 projectFiles**：`files/fileTree.ts` 是純讀取，沒有新建/刪除/改名。「檔案」頁的寫入口只有 `files/projectFiles.ts`（重新命名/移動/複製，工程根範圍，固定目錄受保護，同名不覆蓋；移動與複製都經閘道器的 `move` / `copy`——複製不進回收站、會話目錄、歷史版本，會話與工程庫複製不出來，回收站與歷史版本裡的複製得出來）；刪除入口仍然只在工程頁（`files/fileOps.ts`，搬進 `.trash/`）。往檔案頁加新寫操作前，先想清楚它繞過了這裡的哪一條約束。
- **`watchedDirs` 是前端說了算的**：controller 記住前端最近一次 `listDir` 報上來的展開集合，`pushTabData` 時照著重推。它只是「該關注哪些目錄」的快取，不是許可權——每次列舉仍然過 `resolveInRoot`，越界照拒。
