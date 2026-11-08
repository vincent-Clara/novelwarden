# standalone — 獨立 Web 服務殼（Bun；沒有 Bun 時跑在 node 上）

不裝 VS Code 也能用的第二個宿主：本機起一個 Web 服務，瀏覽器裡操作。與外掛殼共用 `core/` 與
[shared/panes.ts](../shared/panes.ts)，自己只實現 `Host` 窄介面與一層 HTTP/WebSocket 傳輸
（殼的契約見 [../README.md](../README.md)）。

## 檔案

| 檔案 | 職責 |
|---|---|
| [main.ts](main.ts) | 入口。`init` 裝上 `TerminalHost` 後走 **core 的** `initProjectFlow`；否則先讀 `NOVELWARDEN_TOKEN`（舊名 `NOVELFORGE_TOKEN` 相容）過一遍 `exposureError`（綁非迴環地址沒令牌就拒絕啟動），再起服務（埠被佔順延，最多 20 次）並按需開瀏覽器。 |
| [cli.ts](cli.ts) | 引數解析：`novelwarden`（空視窗）/ `novelwarden [dir]` / `novelwarden init [dir]`，外加 `--port` / `--host` / `--no-open` / `--verbose`。不帶位置引數時不再把當前目錄當成工程。令牌不走引數（會出現在 `ps` 裡）。 |
| [auth.ts](auth.ts) | 訪問控制（純函式）：什麼時候必須配令牌（`exposureError`）、Bearer / cookie 認不認、Origin 白名單、登入頁與 `/login`。 |
| [server.ts](server.ts) | 路由與收發（經 `serve.ts` 監聽）：`/` 出頁面、`/media/*` 出內嵌資源、`/favicon.ico`、`/ws` WebSocket、`/mcp`（外部 agent 的 MCP 入口，見 [core/mcp](../../core/mcp/README.md)）。每條 WebSocket 是一個視窗，握手地址上的 `?project=` 說它開哪個工程；不帶工程的 `/` 302 到最近操作的那個工程。訊息全交給 `WorkspaceHub.receive`。啟動時把 core 的日誌接到終端（預設 info 及以上，`--verbose` 放開 debug）。 |
| [workspaceHub.ts](workspaceHub.ts) | 工作區登記處：同時開幾個工程，每個視窗各綁一個（或空著），同一個工程的幾個視窗共用一份 `ChatController`；吃掉開啟/關閉資料夾與設定類訊息；沒有視窗的工程空閒一分鐘後關（最近操作的那個留著給 MCP）。歡迎頁的「新建一本書」「匯入寫好的書」也在這裡：`createProject` 經 `core/actions.ts` 的 `createBookAt` 建資料夾並初始化、回 `projectCreated`（真實路徑，開啟由前端照常發 `openFolder`），`inspectBook` 回那本 txt 切得出幾章；`workspaces` 另帶「放在」的預設值 `newProjectParent`（最近那本書所在的目錄，沒有就是家目錄）。 |
| [scopedHost.ts](scopedHost.ts) | 註冊給 core 的全域 Host：按 `AsyncLocalStorage` 裡的視窗上下文把 `getHost()` 轉給那個視窗自己的 `FileHost`，彈窗、toast、開啟編輯器只落到對應的網頁上。 |
| [windowState.ts](windowState.ts) | `~/.novelwarden/window.json`：上次開啟的目錄與最近開啟列表。 |
| [hostFs.ts](hostFs.ts) | 本機一層目錄列舉與選擇器「新建資料夾」。不進 core，agent 拿不到。 |
| [fileHost.ts](fileHost.ts) | `Host` 的實現：彈窗經 `PromptHub` 變成網頁 modal（確認框一個 action 一顆按鈕，回的是按鈕上的字；`confirmCall` 同一個確認框帶 `call`，回答另帶 `choice`——作者為這一次挑的模型與詳細度）；`fs.watch` 監聽工程（失敗退化為輪詢，帶 250ms 去抖）；`openFile` 走內建編輯器；`openBeside` 開在第二塊編輯區。`progress` 只提供 signal——進度由 `core/runtime/progress.ts` 結構化推給網頁。`bind` / `unbind` 隨 Hub 熱換工程根。 |
| [promptHub.ts](promptHub.ts) | 未決網頁彈窗的登記與回執匹配。WS 全部斷開時一律按取消處理。 |
| [terminalHost.ts](terminalHost.ts) | `Host` 的終端實現，只給 `novelwarden init` 用：問答走 readline，`openFile` 報一句路徑。有了它，CLI 只是「第三個宿主」，「初始化工程」這條流程仍然只有一份實現。 |
| [page.ts](page.ts) | **佈局**：標題欄（檔案 / 編輯 / 檢視 / 幫助）+ 活動欄 + 側欄 + 內建編輯器；無工程時編輯器區是歡迎頁（開始三條路——新建一本書、匯入寫好的書、開啟資料夾——、最近、怎麼上手，「幫助 → 歡迎頁面」隨時再開啟）。六個 pane 的 DOM 全部取自 [../shared/panes.ts](../shared/panes.ts)（含只有這裡裝配的「檔案」頁），這裡沒有第二份。 |
| [serve.ts](serve.ts) | 起 HTTP + WebSocket 服務、與執行時無關的那一面：形狀照 `Bun.serve` 擺（`fetch(req, ctl)` + `websocket` 三個回呼），有 `Bun` 這個全域就原樣交給 `Bun.serve`，沒有就交給 `nodeServe.ts`。 |
| [nodeServe.ts](nodeServe.ts) | node 上的監聽：`node:http` + `ws`（開發依賴，打包進單檔案）。眼下只有 Android 殼走這裡（手機上只有 Termux 編的 node）。 |
| [assets.ts](assets.ts) | `/media/*` 的位元組來源（內嵌資源表）。與 `page.ts` 分開：拼一段 HTML 不該牽進那個幾十 MB 的生成檔案。 |
| [systemOpen.ts](systemOpen.ts) | 交給系統預設程式開啟（`explorer` / `open` / `xdg-open`）。開瀏覽器與編輯器的「外部開啟」共用這一份。 |
| `mediaAssets.ts` | **生成檔案**（已 gitignore）。由 [../../scripts/embed-media.js](../../../scripts/embed-media.js) 把前端資源 base64 內嵌（`.js` / `.css` 取自構建產物 `dist/media/`，`icon.svg` 取自 `media/`），使單檔案可執行不依賴外部資源。`npm run typecheck` / `test:e2e` / `dist` 前會自動生成。 |

## 關鍵設計

- **單使用者、預設只綁本機，工程可空**：預設 `127.0.0.1`、無鑑權。工作區由 [workspaceHub.ts](workspaceHub.ts) 持有，一個程序同時開幾個工程，每個瀏覽器視窗一個；網址上的 `?project=` 跟著視窗的工程走，重新整理、重連都回到它。設定「新視窗中開啟專案」（預設開）決定在已有工程的視窗裡開啟別的工程時開新視窗還是換掉當前的。前端的 localStorage（標籤頁、展開的目錄、輸入框草稿）按工程分開存。沒有工程時不造假例項，創作類訊息 toast「請先開啟資料夾」。設定仍可用（配置在 `~/.novelwarden`，舊機器的 `~/.novelforge` 繼續 fallback）。
- **Origin 校驗**：WebSocket 不受同源策略約束，惡意網頁能向本機埠發訊息。`server.ts` 因此校驗 `Origin` 只認本機同埠；沒有 `Origin` 頭的（命令列工具、冒煙測試）放過。`/mcp` 用同一條規則。規則本身在 [auth.ts](auth.ts) 的 `isAllowedOrigin`。
- **部署到伺服器：`--host` + 令牌，fail-closed**：Docker 映象（倉庫根 `Dockerfile`）綁 `0.0.0.0`，「只有本機連得進來」這道牆就沒了，所以綁非迴環地址必須配 `NOVELWARDEN_TOKEN`（舊名 `NOVELFORGE_TOKEN` 相容，至少 16 位），沒配 `main.ts` 直接拒絕啟動。配了令牌就全站鑑權（與綁在哪無關）：網頁在登入頁交一次令牌換 cookie（值由令牌派生，`HttpOnly; SameSite=Lax`，經 HTTPS 反代時加 `Secure`），MCP 帶 `Authorization: Bearer`；`/media/*`、`/favicon.ico`、`/login` 不設防。這時 Origin 還認同源（與 `Host` / `X-Forwarded-Host` 一致）——**只在配了令牌時認**：沒令牌時認同源會放過 DNS rebinding（`evil.com:3680` 解析到本機時 Origin 與 Host 恰好一致）。令牌不進日誌，帶令牌的請求頭寫法也不打（`logger.ts` 的脫敏見到 `Bearer` 就整段抹掉）。
- **兩個執行時，路由只寫一份**：平時跑在 Bun 裡；Android 殼裡沒有 Bun，由 [../../../scripts/build-android-server.js](../../../scripts/build-android-server.js) 用 esbuild 把 `main.ts` 打成 node 單檔案，監聽換成 `nodeServe.ts`。差別只收在 `serve.ts` 那一層：node 那邊要自己對齊 Bun 的幾樣行為——流式響應邊到邊寫（MCP 的 SSE）、客戶端斷開時 abort `req.signal`（MCP 靠它取消呼叫）、升級被拒把 401 / 403 寫回裸 socket、處理器拋了只打日誌不讓程序退出。SQLite 本來就有 `node:sqlite` 兜底（`core/runtime/db.ts`）。
- **`/mcp` 關掉空閒超時**：一次工具呼叫可能跑幾分鐘（寫一章），期間連線上一個位元組都沒有，而 Bun 預設 10 秒空閒就斷。`server.timeout(req, 0)` 只對這一個請求生效。MCP 呼叫落在地址 `?project=` 指定的那個工程上，不帶就落到最近操作的那個視窗的工程；啟動日誌裡那行 `claude mcp add …` 就是接入命令。
- **openFile 的語義差異**：外掛裡是「開啟 VS Code 的編輯器 tab」，這裡是「在網頁內建編輯器裡開啟」。刻意讓 `openFile` 本身改道，這樣 controller 裡「產物落盤後開啟」「點章節」「點上下文條目」三處呼叫點一次全對。非文字檔案回落到系統預設程式。
- **兩塊編輯區**：`openInEditor(rel, pane)` 的 `pane` 決定 `editorOpen` 落到哪一塊，`openBeside` 就是 `pane: 'draft'`。`editorOpen` 廣播時順手帶上 `draftPath`（由 `draftPathOf` 從章節路徑推導），前端據此顯示工具欄上的「草稿」按鈕——前端不該自己復刻「什麼算章節」。`editorSaved` 也必須帶它，否則按鈕會在首次儲存後消失。同一個理由，兩條訊息都帶 `kind`（`kindOfPath` 算的這份檔案是什麼）：前端拿它分「正文」（`chapter` / `draft`）與其餘檔案，Tab 縮排用全形還是半形就看它；沒開啟工程時省略，前端當非正文。還帶 `label`（`core/views/editorLabel.ts`：標籤上的型別短標記與去掉副檔名的名字、工具欄麵包屑「細綱 › 第一卷 › 第 3 章 夜訪」）——三處推檔案的地方都經 `viewOf()` 拼，漏一處前端就在儲存一次之後退回原始路徑。開啟請求上的 `preview` / `replace`（臨時標籤、上一章 / 下一章的原位換掉）後端不看，`openInEditor` / `openFile` / `openBeside` 的 `intent` 原樣帶回 `editorOpen`。
- **檔案讀寫全部經 [../core/files/fileEditing.ts](../../core/files/fileEditing.ts)**：路徑包含校驗、可編輯判定（副檔名白名單 ∪ 章節檔名規則）、大小上限、儲存的 hash 樂觀鎖都在那裡。本層只負責把異常翻譯成 `editorError` / `editorConflict` / `editorDiskGone` 廣播出去，不要繞過它直接 `fs.writeFile`。
- **核對磁碟（不丟稿）**：前端每收到一條 `state`（去抖）、視窗拿回焦點時發 `checkEditorFiles { files: [{ path, hash }] }`，`checkEditorFiles()` 只讀那幾份，hash 對不上的推 `editorDiskChanged`（帶新版，形狀與 `editorOpen` 的檔案一樣：帶 `draftPath` / `kind`），讀不到的推 `editorDiskGone`，對得上的不推。**不復用 `editorOpen`**——那條會把標籤切成當前的、搶焦點。回話照常廣播給開著這個工程的所有視窗，各視窗按自己開著的標籤認。空視窗發來的靜靜吃掉（`workspaceHub.ts`），不彈「請先開啟資料夾」。
- **帶了基線、檔案卻不在：編輯器這條路不重建**。閘道器對這種情況當新建處理（`workspace/guard.ts` 守衛 8 的口徑），`writeFileFromEditor` 收緊一檔：拋 `FileGoneError`，這裡推 `editorDiskGone`、一個位元組不寫；作者在網頁上答應「在原路徑重建」之後，`saveFile` 帶 `recreate: true` 再來（照樣帶著基線，期間原路徑又有了別的內容照樣撞衝突）。不帶基線的強制儲存不受影響。
- **多一個「檔案」頁**：側欄比外掛形態多一個資源管理器（[../core/files/fileTree.ts](../../core/files/fileTree.ts) 出資料，`media/src/explorer/` 渲染），列的是磁碟上的真實目錄結構，**含 `.novelwarden/` 等點開頭的資料夾**——外掛形態裡這件事由 VS Code 自己的資源管理器承擔，獨立版沒有它，作者就沒有任何入口去手改會話/`project.json`。它只讀不寫：新建/改名/刪除仍然只在「工程」頁走 `core/files/fileOps.ts`。
- **watcher 只擋二進位制，而且規則不在這裡**：過濾走 [../../core/watchPolicy.ts](../../core/watchPolicy.ts) 的 `shouldIgnoreChange`（黑名單——章節可以是 `.txt`/無副檔名，目錄事件也沒有副檔名，白名單式過濾會讓這些改動看不見）。外掛殼用同一份策略的 glob 形態。因為放行面寬，`onChange` 帶 250ms 去抖：它會觸發 `pushState`，那是一次全量重掃。
- **進度不再是 toast**：`FileHost.progress` 過去每收到一次 `report` 就彈一條 toast，跑一次「同步章節細綱」、同步 76 章等於刷 76 條提示、把別的訊息全蓋掉。現在同一份進度由 `core/runtime/progress.ts` 結構化推成 `tasks` 訊息，側欄頂上的任務條畫進度條（n/N、計時、可停止，所有頁籤都看得見），`FileHost.progress` 只負責給出 signal 與報告失敗。
- **終端 sink 只掛一次**：埠被佔時 `main.ts` 會重試著調 `startServer`，每次都 `addLogSink` 會讓同一條日誌列印好幾遍。
- **前端資源三處同改**：新增前端**產物**（先寫好 `media/src/` 下的原始碼入口）後，要同時加進 `build-media.js` 的 `JS_ENTRIES` / `CSS_ENTRIES`、`embed-media.js` 的 `built` 陣列和 `page.ts` 的引用，否則編譯版會 404；外掛也要載入時再改 `vscode/webviewHtml.ts`。（只改已有產物的原始碼不需要動那兩個指令碼。）`/media/*` 是路由名，不是磁碟路徑——位元組全部來自內嵌的 `MEDIA_ASSETS`。
- **管道輸入也要能跑 init**：`TerminalHost` 全程共用一個 readline，並把沒人接的行排隊。每問一句就新建再關掉一個（原來那份實現）會讓 `printf '書名\n作者\n' | novelwarden init` 在第二問就撞上 EOF；而管道是一次全來的，兩問之間夾著落盤 await，不排隊那幾行就白丟了。EOF 一律按「取消」處理，免得在校驗失敗裡死迴圈。

## 與外掛殼的能力差異

`Host` 上的可選方法就是差異點：`browseFile`（這裡提示輸入相對路徑）、`pickHostFile`（拆書選 txt：推 `prompt kind: 'file'`，網頁裡複用「開啟資料夾」那個本機目錄選擇器的選檔案模式，只列目錄與允許的副檔名，回絕對路徑；外掛是 `showOpenDialog`）、`reviewReplace`（五期起推 `prompt kind: 'merge'`，網頁上開段級 diff / 合併檢視：閘道器請求合併時作者可以逐段挑、手改，交回 `{ merged }`；其餘呼叫方只讀，只有採納 / 放棄；外掛照舊 `vscode.diff`）、`revealText`（點審稿報告上的引文：先 `editorOpen` 那一章，再推 `editorReveal` 讓內建編輯器選中那一句；外掛是 `showTextDocument` + `revealRange`）、`openNativeSettings`（**這裡不實現**，於是 `page.ts` 渲染時就不產出那顆按鈕——不是渲染出來再隱藏）、`openInEditor` / `saveFromEditor` / `checkEditorFiles` / `openExternal`（只有這裡實現）、`openBeside`（這裡開第二塊編輯區，外掛是 `ViewColumn.Beside`）。`supportsVscodeLm` 為 `false`，Copilot 模型在設定頁與下拉框裡都被過濾掉。

## 驗證

[`tests/e2e/standalone/server.test.js`](../../../tests/e2e/standalone/server.test.js)（`npm run test:e2e`，需 Bun）：靜態資源、WS 首條訊息、Origin 校驗，內建編輯器的讀寫往返——儲存落盤、過期基線觸發衝突且不覆蓋、強制儲存、越界路徑與非文字副檔名被拒、無副檔名章節可開啟，以及草稿的按需建立與並列開啟；資源管理器的目錄列舉——點開頭的目錄列得出來、目錄排在檔案前、`editable` 標註、一次多目錄、越界與不存在的目錄降級成 `error`；空視窗（不傳工程目錄）ready 後 `currentId` 為空、`openFolder` 熱換、`mode: 'add'` 仍只有一個工作區、`closeFolder` 回到空視窗。

node 那一半：[`tests/integration/shells/nodeServer.test.js`](../../../tests/integration/shells/nodeServer.test.js)——`nodeServe` 對齊 Bun 的那幾樣逐條釘住；再照 Android 構建同一條路打成單檔案、子程序裡用 node 起，走一遍登入、頁面、WebSocket（含跨源拒絕）與 MCP。e2e 只在 Bun 下跑，覆蓋不到這一半。

令牌鑑權：純函式在 [`tests/unit/shells/auth.test.js`](../../../tests/unit/shells/auth.test.js)（什麼時候拒絕啟動、Bearer / cookie、Origin 的同源與 DNS rebinding、`next` 防外跳）；整條往返在 e2e 的「令牌鑑權」一節（未登入回 401 登入頁、錯令牌不種 cookie、帶 cookie 的 WS 收得到 init、MCP 要 Bearer）。映象本身由 CI 的 `docker.yml` 起容器冒煙。

資源管理器的前端行為在 [`tests/dom/standalone/explorer.test.js`](../../../tests/dom/standalone/explorer.test.js) 裡（jsdom 跑構建產物 `dist/media/explorer.js`，原始碼在 `media/src/explorer/`）：懶展開、摺疊連帶子目錄、載入中佔位、可編輯與否走不同訊息、編輯器高亮聯動、截斷提示、右鍵選單複用 view 的引擎。
