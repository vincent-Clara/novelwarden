# AGENTS.md

Novelwarden 首先是一個**寫長篇小說的編輯器**（編輯器的功能優先做），其次**照正文自動整理這本書**（細綱、角色卡、設定、敘事線由機器維護，作者改過的機器不覆蓋），最後才是往下寫（一句念頭 → 架構 → 情節大綱 → 細綱 → 正文）。四種殼（獨立 Web 服務 / 桌面 / Android / VS Code 外掛）共用一套核心。資料是工作區 `.novelwarden/` 下的普通 Markdown，app 不讀寫 `.git`。舊工程的 `.novelforge/`、`.novel/` 繼續可開啟，遷移只在作者確認後 rename。產品文件見 [README.md](README.md)。

**一條軸：細綱號 = 章號。** `config.md` → `premise.md` / `characters/` / `world.md` / `lore/` → 情節大綱（**不是檔案**，是各章細綱梗概的彙總）→ `summaries/…/NNN-标题.md`（細綱，**映象正文的相對路徑**）→ `chapters/…/NNN-标题.txt`（正文，唯一真相）→ 定稿（介面上叫「同步」，照正文反向更新細綱、設定、角色狀態、敘事線 `threads/`、故事時間）。`scenes/`、`volumes/`、`manuscripts/`、`plots/` 已刪，程式碼不認、磁碟上不動。詳見 [src/core/model/README.md](src/core/model/README.md)。

## 代理工作約定

- **文件只寫斷言**：本檔案的約束一條一句；模組 README 的檔案表一個檔案一句話；機制、例外與理由寫進程式碼註釋。

## 常用命令

shell 為 PowerShell（不支援 `&&`，用 `;` 分隔），均在倉庫根目錄執行：

```powershell
npm run compile          # 打包 dist/extension.js 與 dist/media/（F5 除錯前必須有）
npm run typecheck        # 含 media/，必須零錯誤
npm test                 # typecheck + 全部測試，不需要 API Key
npm run test:unit        # 也有 test:integration / test:dom / test:e2e（需 Bun）
```

改了 `src/core/**` 必須跑 `npm test`；改了任何 TS 都要過 `npm run typecheck`。單跑一條：`node --test --test-name-pattern="关键字" "tests/unit/**/*.test.js"`（**glob 要帶引號**）。F5 配置見 [.vscode/README.md](.vscode/README.md)。

## 模組地圖

每個模組目錄下都有 `README.md`（★ 是改動前最該查的）：

| 模組 | 職責 |
|---|---|
| `src/` | 兩層架構總覽與一條創作請求的完整鏈路 |
| `src/core/` | 核心層入口：協議 `protocol/`、檔案能力 `files/`、`controller/` |
| `src/core/model/` | 資料層：領域查詢（不寫盤）、各類檔案的格式與認法、流水線狀態機與呼叫次數 |
| `src/core/workspace/` | ★ 工程的唯一讀寫閘道器：守衛、指紋記賬、歷史版本、存檔點 |
| `src/core/context/` | ★ 分階段裝配（配方 × 層）+ 提示詞 + token 計數 |
| `src/core/generation/` | ★ 一次單步：裝配 → 調模型 → `Draft`；轉寫、續寫、審稿、修稿、落盤分派 |
| `src/core/features/` | 功能編排：批次流水線、定稿、敘事線與故事時間、角色卡、設定名錄、拆書、存檔點…… |
| `src/core/tools/` · `mcp/` | ★ 工具層（`novel/` 十三個工具）與把它端給外部 agent 的 MCP 層，互不 import |
| `src/core/views/` | 只讀聚合與介面快照（`model/pipeline.ts` 是純領域狀態機，不搬進來） |
| `src/core/runtime/` | 日誌、SQLite 痕跡庫、失敗記錄、長任務、併發、`callScope.ts` |
| `src/core/llm/` · `skills/` | 模型服務商；寫作技能 |
| `src/shells/` | ★ 四個殼 + `shared/panes.ts`（所有 pane 的 DOM 唯一來源）；殼的契約在這份 README |
| `media/` | 前端（原生 TS/CSS），原始碼 `media/src/`，產物 `dist/media/` |
| `tests/` · `scripts/` | 測試（按型別分目錄）；構建與診斷指令碼 |
| `sample-novel/` | 測試夾具，勿隨手改正文（hash 斷言會掛） |

設計稿在 `docs/design/`，涉及分層或鏈路行為時按需查。

## 架構要點

- **兩層、單向依賴**：`core/` → `shells/`，`core/` 零 vscode 依賴，殼間不互相 import（`tests/contract/` 守著）。
- **殼只做三件事**：實現 `Host`、傳輸與生命週期、平臺專屬入口；差異表達成「宿主有沒有這個能力」。
- **訊息協議是前後端唯一契約**：`src/core/protocol/` 的 `InMessage` / `OutMessage`。
- **前端無狀態**：靠 `ViewState` 全量推送重建；加新前端產物改 `build-media.js`、`embed-media.js`、`page.ts` 三處。

## 必須遵守的行為約束

產品承諾，改動時不可破壞。**編號是固定錨點**（程式碼註釋以「第 N 條」引用），只精簡文字、不重排不合併。機制、例外與理由見連結的模組 README。

1. **容錯優先**：作者會手改任何 Markdown，解析失敗退化為忽略，絕不拋崩。[model](src/core/model/README.md)
2. **不靜默截斷**：裝配器丟掉的條目都要留在明細裡並附原因。[context](src/core/context/README.md)
3. **不靜默覆蓋**：可能吞掉已有內容的動作，落盤前先給作者判斷的機會。[workspace](src/core/workspace/README.md)
4. **不偷偷燒 token**：不自動補、不自動定稿；調模型前一律寫明預計呼叫次數，確認框經 `features/askCall.ts`。[features](src/core/features/README.md)
5. **模型引用只在第一個斜槓處切分**。[model](src/core/model/README.md)
6. **不真刪**：刪除一律搬進 `.novelwarden/.trash/`。[workspace](src/core/workspace/README.md)
7. **檔案訪問不越界**：所有寫盤經 `core/workspace/` 這一個閘道器。[workspace](src/core/workspace/README.md)
8. **細綱號 = 章號，細綱映象正文的相對路徑**：不許平鋪、不許只按章號配對。[model](src/core/model/README.md)
9. **章節不認副檔名**：規則只在 `model/chapterFile.ts` 定義一次。[model](src/core/model/README.md)
10. **草稿不進上下文**：`drafts/` 只有作者顯式 `@` 才進 prompt。[core](src/core/README.md)
11. **不悶著幹活**：要調模型或跑幾十秒的走 `runTask`，日誌不出現 API Key 與全文。[runtime](src/core/runtime/README.md)
12. **模型引用只在工程頁任務裡 fallback，且換人只在檔內**；轉寫固定走「轉寫」那一檔。[llm](src/core/llm/README.md)
13. **切批與截斷用幹活那個模型的視窗**。[llm](src/core/llm/README.md)
14. **定稿過的細綱是出場人物的唯一真相**：角色卡上的出場記錄只是快取，經 `buildCastIndex()` 重算。[model](src/core/model/README.md)
15. **角色卡不能無限膨脹**：每一節都有字數上限。[features](src/core/features/README.md)
16. **失敗要留在出錯的東西身上**：經 `runtime/errorLog.ts` 掛在目標上，成功路徑必須 `clearFailures`。[core](src/core/README.md)
17. **SQLite 只放可丟棄的痕跡**：庫打不開就靜默降級。[runtime](src/core/runtime/README.md)
18. **上下游新鮮度只靠 hash 傳播，不調模型**：(a) 手寫的產物永不標髒；(b) 內容指紋只雜湊小節、不含 frontmatter；流水線狀態從磁碟推導、絕不落盤。[workspace](src/core/workspace/README.md)
19. **產物落盤前必須過一遍人，而且是當場過**：批次路徑反過來，一律跳過已有產物。[generation](src/core/generation/README.md)
20. **介面永遠只推薦一個下一步，且由狀態機算出來**：外部 agent 經 `views/stateBrief.ts` 拿同一份結論。[model](src/core/model/README.md)
21. **細綱是這一章的計劃，不是正文**：寫夠沒有看 `targetWords`。[model](src/core/model/README.md)
22. **細綱有兩個入口，討論那條不許被截斷**。[context](src/core/context/README.md)
23. **定稿是這條鏈上唯一的人工閘口**。**叫法**：給作者與外部 agent 看的字（介面、README、MCP 說明、autopilot 技能）一律叫「同步」，程式碼識別符號、設計稿與提示詞裡仍叫定稿。[features](src/core/features/README.md)
24. **外部 agent 是排程者，不是第二個作者**：本專案不自帶迴圈，`generate` 的產物不回灌。[mcp](src/core/mcp/README.md)
25. **外部 agent 不越過既有的閘門**：不給刪除 / 改名 / 移動 / `bash` / 工程根之外的路徑。[mcp](src/core/mcp/README.md)
26. **思考深度是會話的屬性，只作用於作者選定的那個模型**。[llm](src/core/llm/README.md)
27. **設定條目不能無限膨脹，機器只並不刪作者的字**。[features](src/core/features/README.md)
28. **敘事線是劇情線，作者寫的字機器不動**：狀態從事件現算、不落盤，機器只追加。[model](src/core/model/README.md)

## 提交與發版

提交字首 `feat/refactor/chore/docs`，正文可用中文，不提交 `dist/`。版本號**只記在根 `package.json`**（`tests/contract/version.test.js` 守著）。發版：`npm version patch|minor|major`（工作區要乾淨，先跑測試；不用帶字母的預釋出號）→ `git push --follow-tags`，tag 觸發 `release.yml` 出 Release 草稿，作者看過再公開。
