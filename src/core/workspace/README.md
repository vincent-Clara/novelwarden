# workspace — 工程的唯一讀寫閘道器

`list` / `read` / `write` / `edit` / `move` / `copy` / `mkdir` / `remove` / `search` 九個方法（外加一批收領域物件的寫入器，
見末尾「領域寫入器」；存檔點的退回另有一個位元組原樣的 `restoreBytes`，也在那張表裡），是整個工程**唯一**允許寫盤的地方。閘道器之外還剩的寫盤都是按設計不走這裡的（見「歷史版本」一節
末尾那張清單），`tests/contract/gatewayWrites.test.js` 逐個檔案數著，多出一處就紅。

## 為什麼要有這一層

寫盤從前散在六處，每處各帶一部分保護，誰也不認識誰：

| 位置 | 管什麼 | 帶哪些保護 |
|---|---|---|
| `model/project.ts` | 所有產物的讀寫 | 路徑推導、frontmatter 渲染、伴生搬遷 |
| `features/creation.ts` 的 `acceptArtifact` | 五條落盤路徑 | `confirmOverwrite`、記 `upstreamHash` |
| `files/fileOps.ts` | 三區類檔案操作 | 區界限、同名不覆蓋、`.trash` |
| `files/fileEditing.ts` | 內建編輯器讀寫 | 工程根包含、副檔名白名單、大小上限、樂觀鎖 |
| `files/projectFiles.ts` | 檔案頁的移動/複製/改名 | 工程根包含、`isProtectedPath`、同名不覆蓋 |
| 拆章（已刪） | 拆分 | 章號接在最後一章之後、把落點記回段的 frontmatter |

既有落盤路徑揹著一批不變數，繞過任何一條都會**安靜地**損壞工程：

- 細綱映象正文在章節根下的相對路徑：正文改名/移動時細綱要跟著搬；還沒有正文時檔名由「章號 + 標題」決定，改標題要清掉舊檔名
- 寫細綱要記 `upstreamHash`（大綱裡這一章那一條的指紋），寫正文要在細綱上記
  `writtenFrom`（正文據以寫成的細綱指紋），定稿要在同一份細綱上記 `sourceHash`（正文的指紋）
  並重新整理 `writtenFrom`，漏了新鮮度鏈就斷
- 刪除一律進 `.trash/`；同名目標一律報錯退出——**會話刪除的落點也是同一套**（`trashPathFor`：保留原相對路徑，會話落在
  `.trash/.novelwarden/sessions/<id>.json`，同名加序號），不真刪不是檔案獨有的行為（AGENTS 第 6 條）。會話不走閘道器的寫入
  （它是內部檔案，閘道器本來就拒寫 `sessions/`），只共用落點規則：`trashPathFor` 實現在 `model/project.ts`，這裡重新匯出
  （`model/` 不能反過來依賴閘道器）。定稿改寫細綱之前，舊版也照這一套複製一份進去
- 覆蓋一份已有的創作產物之前，舊內容先存一版歷史（`history.ts`，見下面「歷史版本」）

所以 **`write` 不是「往這個路徑寫位元組」**，而是「按這個路徑**應有的種類**寫一份
合法產物」——種類判定、渲染、記賬、伴生搬遷、覆蓋審閱全在這一層做一次。

## 新程式碼不許繞過 guard 直接 `fs.writeFile`

八條守衛只在這條路上做。繞過去等於給自己開一個後門，**而後門在介面上看不出來**。

功能層自己已經問過作者的覆蓋（更新角色卡、提取角色合併已有卡的審閱採納，批次更新時的「全部直接採納」，章節改名時
同步正文的 `# 標題` 行，全書替換——預覽就是那一問）也走 `write`，傳 `mode: 'overwrite', review: false`：閘道器不再問第二次，
但守衛照過、覆蓋之前舊內容照樣存一版歷史。新建（如手動新建設定條目）傳 `mode: 'create'`，同名報錯退出。

**全書替換**（`features/bookReplace.ts`）是這條路上一次寫得最多的呼叫方，每一份都照這幾條寫：編輯器裡有未儲存修改的跳過；
`write` 之前先 `snapshotNow`（**跳過節流**強制存一版——跨檔案沒有一步撤銷，退路就是每份的替換前那一版；存不下就不換這一份），
再 `write`（`overwrite`、`review: false`、帶預覽時讀到的 `baseHash`：預覽之後被改過就拒，不拿舊的蓋新的）；章節傳 `deferAfter`，
manifest 最後同步一次。指紋鏈的收尾走 `restampPlotChain`（見下面「領域寫入器」與 `features/README.md`）。

**先寫後搬的呼叫方先問 `checkMove`**：章節改名要先改正文的 `# 標題` 行、再 `move`（`files/fileOps.ts`）。新名字被佔用時
`move` 被拒，標題卻已經改了——正文被悄悄改掉（第 3 條）。所以寫標題之前先 `checkMove(from, to, { plot: true })`：與 `move`
同一套守衛（來源在、不是固定目錄 / 內部檔案 / 回收站；落點在工程內、沒有同名），外加細綱那一側——正文映象的細綱在、新映象
的位置上已經有東西（`move` 本身遇到這種情況照樣搬正文、細綱留在原處說一句；先改了標題的這條路把它當成搬不成）。只讀，
搬不成拋 `WsError`，什麼都不動。預檢過了 `move` 仍可能失敗（中間別處剛建了同名檔案）：呼叫方把正文改回原樣（經 `write`，
`review: false`，帶寫下去那一份的 hash 當樂觀鎖——這期間又被改過就不蓋），改不回去就在 toast 與日誌裡照實說。

## 八條守衛（`guard.ts`）

| # | 守衛 | 觸發時 |
|---|---|---|
| 1 | 路徑規範化（絕對路徑 / `..` 逃逸 / 空串） | `WsError('outOfRoot')` |
| 2 | 工程根包含檢查（解析成絕對路徑再比一次） | `WsError('outOfRoot')` |
| 3 | 固定目錄保護（改名/刪除） | `WsError('protected')` |
| 4 | `.trash/` 內容不可改（**讀得到**，作者要能找回東西）；歷史版本 `.novelwarden/history/` **寫不進去**（同樣讀得到）——往裡寫、搬進去、複製進去、在裡面建目錄都拒 | `WsError('inTrash')` / `WsError('inHistory')` |
| 5 | 大小上限 2MB（讀、寫各一次） | `WsError('tooLarge')` |
| 6 | 同名不覆蓋（`mode: 'create'`） | `WsError('exists')` |
| 7 | 覆蓋前審閱（`reviewReplace` 或確認框）。請求合併（`opts.merge`），獨立版的合併檢視交回作者挑過、改過的那一份時寫它（五期 W11） | 使用者拒絕 → `{ skipped: true }` |
| 8 | 內容 hash 樂觀鎖（給了基線、檔案卻不在：不算衝突，當新建寫——內建編輯器那條路比這嚴一檔，停下來問作者，見 `files/fileEditing.ts` 的 `FileGoneError`） | `WsConflictError(diskText, diskHash)` |

**區界限不在這裡**：`fileOps` 的三區約束（章節挪不進角色目錄）是**工程頁的
產品承諾**，比這裡的工程根約束更嚴。那一層留在 `fileOps` 裡，先判區再調閘道器。

**寫不進去的三處**（`guardWrite`、`guardCreate` 共用一道）：Novelwarden 自己的內部檔案（會話 `sessions/`、工程庫、存檔點 `checkpoints/`，`protected`）、
回收站（`inTrash`）、歷史版本（`inHistory`）。`write`、`move` 的落點、`copy` 的落點、`mkdir` 都過它。歷史版本那一條是後補的：
從前守衛只攔前兩處，作者的操作能往「歷史」面板裡塞一份從沒存過的「舊版」。回收站與歷史版本都**讀得到**（會話與存檔點讀當不存在）。

## 複製與建目錄（`copy` / `mkdir`）

從前「檔案」頁貼上的複製直接 `fs.cp`、新建資料夾直接 `fs.mkdir`，都不過守衛：能把檔案複製進回收站、會話目錄、歷史版本，
也能把會話檔案、工程庫複製出來。現在兩條都在閘道器裡。

**`mkdir(rel)`**：可以一次建幾層。落點過 `guardCreate`——工程內、不在寫不進去的三處、**落點上有什麼都算同名**（目錄或檔案，
報 `exists`，什麼都不動）。只建目錄，沒有種類、沒有記賬。工程頁 / 檔案頁的「新建資料夾」走它（區界限仍由 `fileOps` 先判）。
設定區的分類目錄另有 `ensureLoreFolders`（鎖在 `lore/` 裡，設定清單落盤時建）；「按目錄整理」不先建目錄——`move` 落盤前自己補齊
父目錄，新目錄只在真有條目搬進去時出現，搬不成不留空目錄。

**`copy(from, to)`**——檔案頁的「複製 → 貼上」：

| | 規則 |
|---|---|
| 來源（`guardCopySource`） | 工程內、存在、不是符號連結、不是固定目錄（整個 `chapters/`、`.novelwarden/` 不收，與檔案頁從前一樣）、不是內部檔案（會話、工程庫複製不出來）。**⚑ 回收站與歷史版本裡的東西複製得出來**：複製只讀來源，讀得到就複製得出來，原件一個位元組不動——這是在工程裡找回一份的入口（搬出來仍然不行，那是改回收站，`guardMutate`） |
| 落點（`guardCreate`） | 寫不進去的三處一律拒；**同名不覆蓋、不加序號**（第 3 條，與檔案頁從前的貼上一樣：粘回原目錄報「已經在這個目錄裡」，目標已有報「同名」）；目錄不能複製進它自己裡面（`intoSelf`）；父目錄不在就補齊（與 `move` 一樣） |
| 目錄 | 先把整棵樹列出來、**逐個檔案**過一遍落點守衛，全過了才動手——攔下一份就整個不復制，不留半棵樹。目錄裡的符號連結不跟進去，跳過並在 `side` 裡說出來 |
| 位元組 | 原樣複製（`COPYFILE_EXCL`，競態裡也不蓋掉別處剛建的檔案）：GBK 的章節、圖片都不轉碼。沒有大小上限——與 `move` 一樣，複製不把內容讀進編輯器或模型 |
| 章節 | 複製進 `chapters/` 的最後統一同步一次 manifest，像新建一樣 |
| **⚑ 伴生** | **沒有**：複製一章不帶草稿、也不帶細綱（「移動」帶）。副本是一章新的——第 8 條細綱按路徑認，作者在外面複製出來的正文也是一章新的、舊細綱不冒認；草稿是作者對原章的筆記，細綱是原章的計劃與檔案，跟著複製會變成兩份各自漂移的東西，帶著定稿指紋的那份還會讓出場統計、設定名錄多數一章 |
| **細綱副本**（`handlers/plot.ts` 的 `afterCopy`，第 18 條） | 去掉定稿那一側的賬：`writtenFrom` / `sourceHash` / `cast`——副本沒寫過、沒定稿過，帶著它們映象位置上要是有正文，會被說成「定稿之後正文改過」或「細綱在正文之後改過」。`upstreamHash` **原樣不重算**：內容一字沒變、章號沒變，它據以生成的仍是大綱裡同一節——原件掛 ⟳ 的副本照樣掛，不被複制順手刷成新鮮（所以複製不走 `after`，`after` 會按大綱此刻的指紋重記）；**章號變了**（閘道器直接複製成另一個檔名）就去掉。作者定的（標題、目標字數、`status: done`、預檢放行）與九節原樣；沒有 frontmatter 的手寫細綱一個位元組不碰 |
| 歷史版本 | 不存（沒覆蓋任何東西）；原件的快照也不抄過去 |

## 種類表（`kind.ts`）

`kindOfPath(project, relPath)` —— **純函式、零 I/O、絕不拋**（它會被前端傳上來的
路徑呼叫）。認不出、越界一律 `{ kind: 'other' }`，越界時連 `rel` 都不給。

| 種類 | 判定 | 解析 / 渲染 | 上游指紋 | 伴生 |
|---|---|---|---|---|
| `setting` | `config.md` / `premise.md` / `world.md`（帶 `doc`） | `settingFile.ts`；配置的 frontmatter 產物沒給就沿用磁碟那份 | — | — |
| `outline` | 固定路徑 `.novelwarden/outline.md`——**磁碟上沒有這份檔案**，見下面「情節大綱」 | 讀：各章細綱梗概的彙總；寫：按章號拆回各章細綱（`writeOutline`，不經 handler） | — | — |
| `style` / `globalSummary` | 固定路徑 | 純文字 | — | — |
| `threads` | `threads/` 這一層的 `.md`（敘事線重做：一條線一個檔案，「未归属的伏笔.md」也是；子目錄裡的、別的副檔名、目錄本身、七期的 `threads.md` 判 `other`）；`threads/` 是受保護的固定目錄 | 純文字（格式與外科式寫入在 `model/threadFile.ts`） | —（鏈外） | — |
| `skill` | `.novelwarden/skills.json` 與 `.novelwarden/skills/**` | 純文字（`plain`，不加 frontmatter） | — | — |
| `sensitive` | `.novelwarden/sensitive.txt`（自定義敏感詞表，內建編輯器的寫作體檢用） | 純文字（`plain`） | —（鏈外：沒有創作階段、不進裝配器，改了它不讓任何一章掛 ⟳） | — |
| `plot` | `summaries/` 下（各級子目錄都算，映象正文的路徑）+ 數字字首 + markdown | `plotFile.ts`（七節加「設定」一節） | 寫入記這一份梗概的指紋（`plotSynopsisHash`；梗概就是情節大綱裡這一章那一條）；定稿記的 `sourceHash` / `cast` 由 `finalizePlot` 寫，重寫細綱時原樣沿用 | — |
| `chapter` | 章節根下 + 數字字首 + 副檔名不在黑名單 | `chapterFile.ts` | —（正文依據的細綱指紋記在細綱的 `writtenFrom` 上） | 改名/移動帶草稿與細綱（整個卷目錄也帶，連同它們的歷史版本）；寫後 `syncManifest` |
| `character` / `lore` | 各自區 + `.md`（設定條目另給 `stage: 'setting'` 與單條設定目標 `{ kind: 'lore', relPath }`，完善設定：MCP 的 `generate` 給條目路徑就是展開它；設定目錄、角色目錄本身仍是 `other`，設定清單、角色圖譜只在 `generate` 裡認） | frontmatter | — | — |
| `draft` | `drafts/` 下 | 純文字 | — | **永不自動進上下文** |
| `other` | 其餘工程內文字（含老工程的 `plots/` 與歷史版本 `.novelwarden/history/`——後者讀得到、寫不進，守衛 4） | 純文字 | — | — |

三條判定上的取捨：

1. **`chapter` 不看是不是 `.md`**（AGENTS 第 9 條：章節不認副檔名）。
   `001-楔子.txt`、`001-楔子`（無副檔名）、`004.json` 都算章節；
   角色 / 設定 / 細綱**不**跟著放寬，它們是外掛自己的資料格式。
2. **章節路徑不帶創作目標**：正文就是章節，第 N 章的細綱是正文路徑在 `summaries/` 下的映象
   （`NovelProject.plotPathForChapter`），配對要讀盤，不在這裡做；還沒有正文的章，正文落點由細綱
   反推（`views/pipeline.ts` 的 `chapterTargetOf`）。
   `pathOfTarget` 對正文 target 直接拋，提示呼叫方改用它。
3. **`summaries/global.md` 排在細綱之前判**：它是全文大綱（`globalSummary`），不是一份細綱。
4. **老工程留下的 `scenes/`、`volumes/`、`manuscripts/`、`plots/` 都判成 `other`**：那幾層已經刪掉
   （見 `model/pipeline.ts` 的檔案頭），細綱從 `plots/` 搬進了 `summaries/`、與單章摘要併成一份
   （見 `model/plotFile.ts` 的檔案頭）。那些檔案
   是作者的東西，磁碟上一個位元組都不動，但程式碼裡徹底不認——`guard.ts` 的
   `isProtectedPath` 仍然把那幾個目錄列為受保護目錄，免得哪條檔案操作把它們整棵刪掉。
5. **敏感詞表單列一種 `sensitive`，不落 `other`**：它與 `other` 一樣在指紋鏈之外、裝配器不讀，但它是作者手維護的詞表，改壞了要找得回來——`other` 不存歷史版本，`sensitive` 存。新建經「編輯敏感詞表…」（`controller/check.ts`：`write` 的 `mode: 'create'`，同名報錯、不覆蓋；作者點的那一下就是那一問，檔案本來不在，沒有可審閱的），儲存走內建編輯器那條路（樂觀鎖，`review: false`），都不彈覆蓋審閱。
6. **`.novelwarden/history/` 下的東西都判成 `other`**：那是一份份舊稿（歷史版本），裝配器只按種類與固定目錄讀，
   碰不到它（與第 10 條「草稿不進上下文」同一個道理）；它們自己也就不會再被存歷史版本。

## 歷史版本（`history.ts`）

閘道器**覆蓋一份已存在的創作產物之前**，把磁碟上的舊內容存成一個快照。「不靜默覆蓋」（第 3 條）管的是落盤之前
那一問；問過了、寫下去了，作者回頭想要剛才那一版，從前只有定稿寫回細綱會在回收站裡留一份舊的。

**佈局**——每份檔案一個目錄，每個快照一個以時間命名的檔案：

```
.novelwarden/history/
├── .gitignore                                第一次建這個目錄時放進來，內容 `*`
├── chapters/第一卷/003-深处.txt/              目錄名 = 原檔案的相對路徑（連副檔名，`003.md` 與 `003.txt` 不撞車）
│   ├── 2026-10-18_14-32-05+0800.txt          被覆蓋那一刻的本地時間 + 時區
│   └── 2026-10-18_14-32-05+0800-2.txt        同一秒裡的第二個
└── .novelwarden/summaries/第一卷/003-深处.md/  `.novelwarden/` 裡的檔案同樣原樣映象
```

- 快照**位元組原樣複製**（不轉碼，GBK 的舊稿存下來還是 GBK），副檔名一律 `.txt`：外掛殼的監聽吃 `.novelwarden/**/*.md`，
  不是 `.md` 就不會每存一版多跑一輪全量重掃；內建編輯器與「檔案」頁照樣打得開。
- 時間從檔名讀（`parseSnapshotFileName`），不看 mtime——拷來拷去 mtime 會變；帶時區，換了時區也排得對。

**存不存**（`decideSnapshot`，純函式）：

| 情形 | 存不存 |
|---|---|
| `kindOfPath` 是 `other`（工程根的隨手記、`README`、老工程的 `plots/`……）、還不是小說工程（沒有 `.novelwarden/`） | 不存——不替作者憑空建出一個工程目錄（敏感詞表是 `sensitive`，存） |
| 新內容與舊內容一樣（什麼都沒覆蓋）、舊內容與最新一個快照一樣 | 不存 |
| 最新快照不到 10 分鐘，且「舊內容 ↔ 最新快照」「舊內容 ↔ 新內容」兩處改動都在 300 字以內（公共前字尾粗算，`changedChars`） | 不存——自動儲存每兩秒存一次時攢不出幾百個快照 |
| 其餘（第一次、隔了 10 分鐘以上、整章重寫 / 修稿 / 一鍵排版 / 定稿這類大改） | 存 |
| 「現在存一版」（`snapshotNow`，編輯器面板上的按鈕） | 跳過節流；與最新快照一字不差時仍不重複存 |

**保留**：每份檔案最多留最近 50 個（`HISTORY_KEEP`），多的刪掉最舊的。**這些是閘道器自己存的副本，不是作者的檔案**，
刪它們不違背第 6 條「不真刪」——第 6 條護的是作者的東西，這裡刪的是閘道器為了「找得回來」額外抄的那幾份，作者自己的
檔案一個位元組都沒動。

**`.gitignore`**：只在建出 `.novelwarden/history/` 的那一次放（內容 `*`，Git 預設不收快照）。作者刪掉它就是想讓 Git
收這些快照，之後不再補回來。

**哪些寫入存**：`write`（`overwrite` 與 `append`；編輯器儲存、生成落盤、`edit`、`setParagraphStyle`，以及功能層審閱過的
覆蓋——更新角色卡、提取角色合併已有卡、章節改名時同步正文的 `# 標題` 行——都走它）、`writePlot`
（換掉的是這一章原來那份，改標題時它在舊路徑上）、`retitlePlot`（章節改名時只改細綱的標題兩行）、`finalizePlot`、`writeCharacter` / `writeLore` / `writeStyleGuide` /
`writeGlobalSummary` / `updateThreads` / `writeSkillBindings`（經私有的 `overwrite`）。**只改 frontmatter 一個鍵的記賬**
（`recordWrittenFrom` / `recordPreflightOk` / `restampPlotChain`）不存——它們不吞任何內容。全書替換在 `write` 之前另外
`snapshotNow` 一次（跳過節流），之後 `write` 自己那一次與它一字不差、不重複存。覆蓋創作產物的寫入都經閘道器（角色卡的清理別名、
合併重複卡也是：`write` 傳 `review: false`，動手前的確認框就是那一問；被合併的卡經 `remove` 進回收站）。只新建、不覆蓋的
（`copy`、`mkdir`、`createChapter`、新工程的空模板 `initializeProject`）沒有舊內容可存。

**閘道器之外剩下的寫盤**都不是作者的創作產物、按設計不走這裡（`tests/contract/gatewayWrites.test.js` 逐個檔案數著）：會話檔案
（`model/session.ts`，內部檔案，閘道器拒寫 `sessions/`；刪會話只共用 `trashPathFor` 落點）、新工程的固定目錄與 manifest
（`model/project.ts` 的 `scaffold` / `createManifest`）、舊目錄 `.novel/`、`.novelforge/` → `.novelwarden/` 的遷移（僅在作者確認後改名，不刪舊目錄）、工程庫（SQLite，第 17 條）、
工程外的配置（`stores.ts`，`~/.novelwarden/`）與我的技能庫（`skills/library.ts`）。它們都不存歷史版本。

**快照跟著改名、搬家走**（`moveHistory`）：快照按路徑存，所以閘道器 `move` 成功之後，把搬的那一份（或整個目錄）在
`.novelwarden/history/` 下的快照目錄也挪到新路徑下——在新路徑上開啟「歷史」面板，看得到改名之前存的版本（章節改名時同步
標題行存下的那一版也在裡面）。

- **覆蓋面**：單個檔案；整個目錄（分卷目錄改名，下面每份檔案的快照整棵跟著走）；伴生搬家——章節改名、移動時草稿與細綱
  跟著搬，它們不經 `move`（`handlers/chapter.ts` 的 `carryMirror` 直接 rename），快照在那裡各自跟上；沒搬動的伴生（目標已有、
  移出了 `chapters/`）快照也留在原處。`writePlot` 改標題（還沒有正文）、改章號換了檔名，細綱的快照同樣跟過去。
- **新路徑下已經有快照目錄**（以前那裡有過同名檔案）：兩邊合併，檔名撞了按存快照時的去重規矩加序號（同一刻，序號往上
  加；複製用 `COPYFILE_EXCL`，絕不蓋掉已有的那一個），合併完按保留上限（50 個）修剪。
- **搬快照失敗不擋搬家**：新位置被一個檔案佔了、磁碟滿、許可權……都只記一條 warn（「沒能把 … 的歷史版本搬到 …，搬家照常」），
  `moveHistory` 不拋，搬家本身不失敗也不回滾（與「存快照失敗不擋儲存」同一個口徑）；沒搬過去的快照留在舊路徑下，一個不丟。
- **刪除不搬**：`remove` / `deletePlot` 進回收站時快照留在原路徑。作者從 `.trash/` 把檔案搬回原處，歷史也就回來了。
- 搬進、搬出 `.novelwarden/history/` 本身的東西不搬快照（那裡的東西本來就不存歷史）。

**定稿寫回兩份都留**：`.trash/` 那一份照舊（永不裁剪，定稿完成提示裡說的就是它），歷史版本裡也存一版——編輯器的
「歷史」面板裡找得到、對比得了；七節整體換掉，節流攔不住它。

**絕不擋住儲存**：存快照的任何一步失敗都只記一條 warn（「沒能給 … 存歷史版本，照常寫盤」），`snapshotBeforeWrite`
不拋，呼叫方照常寫盤（第 1 條）。

**不進上下文、不觸發重掃、刪不掉、寫不進**：`kindOfPath` 判 `other`；全文檢索跳過它（`isInHistory`，與 `.trash/` 同一個理由：
搜出來的不是現在的書）；`watchPolicy.shouldIgnoreChange` 擋掉它的變動；`isProtectedPath` 把 `.novelwarden/history`
列為固定目錄（類檔案操作搬不走、刪不掉整個目錄；工程頁的三個區本來就夠不著它）；守衛 4 拒絕作者的操作往裡寫、搬、複製、
建目錄（`inHistory`——快照只由這一層自己存）。「檔案」頁照常看得見、點得開，單份快照也**複製得出來**。

讀的一半（列出快照、讀全文、現在存一版）由 `controller/versions.ts` 接給內建編輯器的「版本」側欄與對比標籤（時間線上
混著這份檔案在各存檔點裡的樣子，`checkpointVersionsOf`）；用回一處、恢復整份都只換編輯區裡的內容，從不直接寫盤。
**放回編輯區之前**（前端用回、恢復之前發的 `saveVersion { quiet }`、衝突時的對比合併）
磁碟上那一份先 `snapshotNow` 一次：放回的內容一存檔就蓋掉它，而按節流它可能因為「改動小」不存——作者是在版本之間跳，
跳走之前那一版得留住。

## 存檔點（`checkpoints.ts`）

歷史版本管**一份檔案**被覆蓋之前的那一版；存檔點管**整本書一起**：作者在工程頁「存檔點…」裡手動存一個（帶一句備註），
批次動作之前機器自動存一個（`features/checkpoint.ts` 的 `checkpointBefore`）。之後看每個存檔點跟現在比改了哪幾份，
整本或單份退回去。設計見 [docs/design/plans/2026-10-20-checkpoints.md](../../../docs/design/plans/2026-10-20-checkpoints.md)。
**不用 git**：作者自己可能在用 git，app 自動提交會刷作者的提交歷史、整本 checkout 會蓋掉沒提交的改動；Novelwarden 不碰 `.git`。

**佈局**——按內容定址，同樣的內容只存一份：

```
.novelwarden/checkpoints/
├── .gitignore                               第一次建這個目錄時放進來，內容 `*`（同歷史版本）
├── objects/3f/a9c1…                         檔案內容：sha256 前兩位當目錄、餘下 62 位當檔名；位元組原樣，不轉碼、不壓縮
└── points/2026-10-20_22-30-05+0800.json     一個存檔點一份清單：time / note / auto / files（路徑 → sha、位元組、字數）/ skipped
```

- **存哪些**（`trackedFiles`）：`kindOfPath` 不是 `other` 的，與歷史版本同一個口徑；只掃章節根、草稿根與 `.novelwarden/`，
  隱藏目錄（含回收站）、會話、歷史版本、存檔點自己都不進。超過 2 MB 的單份不存，記進 `skipped`（第 2 條），跟現在比時
  也不算「之後新建」。
- **先寫物件、最後寫清單**，兩樣都先寫臨時檔案再改名：清單是提交點，寫到一半失敗只剩沒人引用的物件，清理時帶走。
- **自動的與最近一個一模一樣就不另存**（沿用最近那一個）；手動的照存（只多一份清單）。
- **保留**：手動的永遠留；自動的留最近 30 個（`CHECKPOINT_AUTO_KEEP`），裁掉清單之後清理沒人引用的物件（`collectGarbage`）——
  只刪寫下超過一小時的（另一個程序可能正在存、物件寫了清單還沒寫），有一份清單讀不懂就整個不清。給自動的寫備註就是留住它
  （`noteCheckpoint`：變成手動）。刪掉存檔點的是閘道器自己的副本，不違背第 6 條（同歷史版本的裁剪）。
- **排隊**：同一個工程的存、寫備註、清理在程序裡排隊（`withCheckpointLock`，按工程根一把鎖）。
- **內部檔案**：整個目錄算 `isInternalPath`——讀當不存在、寫搬刪都拒、`list` 與全文檢索看不見，`watchPolicy` 擋掉它的變動，
  `isProtectedPath` 也列著它。「檔案」頁那一層不藏東西，目錄照樣列得出來，點開讀不到（與會話一樣）。存檔點只經面板看。

**跟現在比**（`diffCheckpoint`）：逐份比 sha，分改過的、之後刪掉的、之後新建的，每份帶當時與現在的字數和此刻的樂觀鎖 hash
（`hashNow`，按 utf8 讀出來算 `hash`，與 `guardWrite` 讀盤的口徑一致），退回時原樣帶回來。

**退回**寫盤走閘道器的 `restoreBytes`（見「領域寫入器」）：位元組原樣、守衛照過、覆蓋之前存一版歷史（跳過節流）、**不跑 handler**——
細綱 frontmatter 裡的指紋一起回到當時，不按大綱此刻重記（第 18 條）。編排（先存「退回之前」、編輯器未儲存的跳過、樂觀鎖、
勾了才搬進回收站、同步 manifest）在 `features/checkpoint.ts`。

## 記賬下沉（閘道器收攏那一期唯一有意的行為變化）

`upstreamHash` 從前**只在採納路徑上記**（`features/creation.ts` 的
`acceptPlot` / `acceptManuscript`）。作者在
內建編輯器裡改一份細綱，指紋鏈就斷了——那一章從此再也不掛 ⟳。

下沉到寫入路徑本身之後，**任何一次 `workspace.write` 到 plot 路徑都記**。細綱的
上游是**它自己的梗概**（`plotSynopsisHash`；梗概就是情節大綱裡這一章那一條，梗概空著就不記、不標髒）：寫一份細綱
等於把其餘幾節與梗概對齊了。在彙總的大綱裡改一章那一條走的是 `writeOutline`（外科式只換「梗概」一節，不經 handler），
指紋不動，排過細綱的那一章才掛 ⟳；續寫第 21–40 章不讓前 20 章掛 ⟳。正文那一環（`writtenFrom`）由正文落盤那一步記（`recordWrittenFrom`），
作者在編輯器裡手改正文不動它——chapter handler 寫後只同步 manifest，所以任何一次 `write` 到章節路徑（編輯器儲存、
章節改名時同步 `# 標題` 行）都不會把一章掛著的 ⟳ 刷掉。三條配套約束一條沒變：

- **手寫的產物永不標髒**：`upstreamHash` / `writtenFrom` 為空 = 不是這條鏈生出來的，不給它補一個
- **`plotContentHash` 只雜湊七個小節**（定義在 `model/plotFile.ts`），不含 frontmatter——
  `upstreamHash` / `writtenFrom` / `sourceHash` 自己就在 frontmatter 裡，算進去會讓「排一次細綱」
  「定稿一次」立刻使這一章的正文過期
- **不雜湊狀態位**——作者把某一章標成 `done`（`status: done` 在 frontmatter 裡），
  那一次寫入不該讓剛寫好的正文立刻顯示「上游已變更」

## 定稿寫回（`finalizePlot`）

定稿照正文反向更新細綱，落盤不走 `write`，而是 `Workspace.finalizePlot(chapter, sections, cast)`
（渲染在 `handlers/plot.ts` 的 `renderFinalizedPlot`）。反向更新的依據是正文；梗概照正文改了，記過的上游指紋刷成新梗概的
（沒記過的照舊不記，第 18a 條）——不然一定稿就掛 ⟳。

- **舊版先複製一份進 `.trash/`**（`trashPathFor`：保留原相對路徑，同名加序號）。定稿按鈕本身就是
  作者的確認，所以不彈覆蓋審閱；但改的是一份作者可能逐字推敲過的計劃，舊的那一版要找得回來。歷史版本裡也照常
  存一版（見「歷史版本」），編輯器的「歷史」面板裡對比得了。
- **七節整體換掉**，「設定」一節換成這一次定稿記下的（校驗過的）；frontmatter 裡 `no` / `title` / `targetWords` / `status` /
  `preflightOk` / `factCheckOk` 原樣留著，`upstreamHash` 見上。
- **寫 `sourceHash`（正文的 `contentHash`）與 `cast`，並把 `writtenFrom` 刷成更新後的內容指紋**：
  不刷的話定稿剛改完細綱，正文立刻掛 ⟳；刷了之後，作者定稿後再改細綱，正文才掛 ⟳。指紋按
  「渲染 → 解析回來」的樣子算，與流水線判髒同一個口徑。
- 寫回的永遠是**正文映象的那一份**（`plotOfChapter`）；還沒有細綱的章（拆書匯入、作者手寫的正文）就在映象位置新建一份（`plotPathForChapter`），不在根下另起一份。

反過來，重寫一份定稿過的細綱（`write` 到 plot 路徑）時 `sourceHash` 與 `cast` 沿用磁碟那份：
定稿過的章不被拉回「待寫」，只讓正文掛 ⟳（第 18 條）。

## 情節大綱（`writeOutline`）

情節大綱**沒有檔案**，是各章細綱「梗概」的彙總（[設計稿](../../../docs/design/plans/2026-10-22-outline-from-plots.md)）。
`.novelwarden/outline.md` 這個路徑仍是它的身份：`read` / `edit` / `write` 認出它（`isOutline`）就不碰磁碟——

- **讀**：`NovelProject.readOutlineDoc`——標題行、一段說明、一章一條（每個章號認下的那一份細綱裡梗概非空的）。hash 按這一份算，
  內建編輯器的樂觀鎖、磁碟核對（`checkEditorFiles`）照常用；編輯器存檔不因「磁碟上沒有這份檔案」報 `FileGoneError`。
- **寫**：守衛、樂觀鎖、覆蓋審閱都在整份彙總上做（產物先規範成一章一條再審閱）；一條章標題都認不出卻要換掉有條目的大綱，拒
  （照拆會把空殼全刪掉）。然後按章號拆回各章細綱（`model/outlineFile.ts` 的 `planOutlineSplit`）：改梗概只換「梗概」一節
  （`patchPlotSynopsis`，先存一版歷史，上游指紋不動）；改標題走 `writePlot`（還沒有正文時檔名跟著改）；新的一章建只有梗概的空殼；
  刪掉的空殼進回收站（`deletePlot`）；排了細綱或寫了正文的不刪、說一聲。一章寫不成不擋別的章，返回的說明裡列出來。
- **沒有歷史版本、不進存檔點**：它沒有位元組；拆回去時改了的每份細綱各自存歷史，存檔點裡有細綱就退得回。全文檢索跳過磁碟上殘留的
  老 `outline.md`（不是現在的書），全書查詢替換不列它（搜細綱就搜到了）。
- 老工程磁碟上若還有一份 `outline.md`：讀寫都繞開它，一個位元組不動、不遷移。

## 全文檢索（`search.ts`）

**零模型呼叫的樸素掃描**。作者問「主角前面說過他沒去過北境嗎」，從前只能靠手動
`@` 引用幾章原文；把它做成 AI 功能等於每問一句燒一次錢，而且會給出看起來很像但
沒有依據的答案——與「新鮮度只靠 hash 傳播，不調模型」是同一條取捨。

四條實現約束：

1. **跳過 `.trash/`、歷史版本與二進位制**——回收站裡躺著剛刪掉的東西，搜出來等於沒刪；`.novelwarden/history/`
   是一份份被覆蓋掉的舊稿，同理。
2. **單檔案讀入有上限**（複用 `MAX_EDITABLE_BYTES`），超了跳過並計入 `dropped`。
3. **`dropped > 0` 必須在返回值裡說出來**（第 2 條）——agent 的工具會把它轉述給
   模型，模型不知道自己只看了一半會拿半份證據下結論。
4. **預設按章號排序**，不按檔案系統順序：作者問「他前面說過嗎」，時間線順序才有意義。

壞正則**不拋**，降級成字面量並在 `note` 裡說明。預設就是字面量——作者搜的是人名
地名，不是正則。

## 目錄

```
workspace/
├── index.ts        Workspace 門面：list / read / write / edit / move（另有隻讀預檢 checkMove）/ copy / mkdir / remove / search，外加領域寫入器與新工程的 initializeProject
├── kind.ts         ★ 路徑 → 種類（純函式，零 I/O，絕不拋）
├── guard.ts        ★ 統一入口守衛（八條；寫、建、複製的落點共用「寫不進去的三處」，複製的來源另有 guardCopySource）
├── history.ts      歷史版本：覆蓋之前存舊內容（佈局、節流、保留；絕不擋住儲存）；搬家時快照跟著走（moveHistory，絕不擋住搬家）
├── checkpoints.ts  存檔點：整本書存一版（按內容定址去重）、列、跟現在比（讀過的清單與算過的指紋按檔案狀態記著）、一份檔案在各存檔點裡的樣子、保留與清理；寫盤是這一層自己的（內部檔案）
├── search.ts       全文檢索（樸素掃描，零模型呼叫）
└── handlers/
    ├── index.ts    種類 → handler 登錄檔（認不出落 plain，絕不拋）
    ├── types.ts    Handler 的五件事：render / resolve / after / companions / afterCopy（另有 onRemove）
    ├── setting.ts  架構三件（小節換新、配置 frontmatter 合併）
    ├── plot.ts     渲染 + 記 upstreamHash；定稿寫回的渲染（renderFinalizedPlot）；副本去掉定稿那一側的指紋（afterCopy）
    ├── chapter.ts  草稿與細綱跟隨（carryDraft / carryPlot，連同它們的快照）+ manifest 同步（刪章節不刪草稿、不刪細綱）
    ├── doc.ts      style / globalSummary / threads / character / lore（情節大綱不經 handler，見「情節大綱」）
    └── plain.ts    other / draft（純文字，無記賬）
```

## 領域寫入器

上面九個方法收的是**路徑**。另有一批收**領域物件**：

| 方法 | 落點由什麼決定 |
|---|---|
| `writePlot` / `deletePlot` | 有正文：正文的映象（檔名跟著正文，改標題只改 frontmatter 裡的標題）；沒有正文：已有那份所在的子目錄，或呼叫方給的落點 `at` 的子目錄，都沒有就跟上一章同一個子目錄，檔名按章號 + 標題（改章號要傳原路徑）。刪除進 `.trash/` 的落點與 `remove` 同一套（`trashPathFor`），不會蓋掉定稿時複製進去的舊版；刪掉之後各條線與「未歸屬的伏筆」裡那一章的計劃事件一起刪（`dropPlannedThreadEvents`，第 28 條「計劃事件隨細綱走」，復跑之後加的；同一章還有另一份細綱時不刪），改之前存一版歷史 |
| `recordWrittenFrom` | 細綱路徑（只改 frontmatter 的 `writtenFrom`，正文一個位元組不動） |
| `recordPreflightOk` | 細綱路徑（只改 frontmatter 的 `preflightOk`：一致性預檢的永久放行，一行「名字：理由」，同名換新理由；沒有 frontmatter 的手寫細綱不補，五期補遺 §2） |
| `retitlePlot(rel, from, to)` | 細綱路徑（章節改名之後、跟著搬過去的細綱把標題改成新名：只改 frontmatter 的 `title` 與 `# 第N章 標題` 那一行，別的一個位元組不動，改之前存一版歷史；細綱的標題不是正文的舊名（作者另起過）就不動，回 `kept`；沒有 frontmatter 的手寫細綱不補，只換標題行。標題不進內容指紋，不掛 ⟳。`files/fileOps.ts` 的章節改名與 `actions.ts` 的新建章節用） |
| `restampPlotChain(rel, patch)` | 細綱路徑（只改 frontmatter 裡給出的指紋鍵：`upstreamHash` / `writtenFrom` / `sourceHash`，值為空就刪掉這個鍵；別的鍵與正文一個位元組不動，不存歷史版本，沒有 frontmatter 的手寫細綱不補）。只給全書替換的指紋鏈收尾用（第 18 條，`features/bookReplace.ts`）：同一次裡細綱與正文都改了、原本對得上的，`writtenFrom` / `sourceHash` 刷成替換後的；細綱的 `upstreamHash` 退回替換前的判斷——`write` 寫細綱時總是記下大綱此刻的指紋（「誰寫都記」），這一次替換不該順手把本來掛著的 ⟳ 擦掉、也不該把沒記過的手寫細綱拉進鏈 |
| `patchPlotLore` | 細綱路徑（只換「設定」一節，沒有就加在末尾，另外七節與 frontmatter 一個字不動；單獨記設定、補記用。「設定」一節不進內容指紋，正文不會因此掛 ⟳） |
| `restoreBytes(rel, bytes, { baseHash?, absent? })` | 呼叫方給的路徑（存檔點的退回，`features/checkpoint.ts`）。**位元組原樣**寫回，不跑 handler（不渲染、不記賬：細綱的指紋一起回到當時，第 18 條；章節的 manifest 由呼叫方最後同步一次）；不彈覆蓋審閱（面板上點兩下就是那一問）。守衛照過：越界、寫不進去的三處、大小上限、樂觀鎖（`absent`：當時磁碟上沒有，這期間又建出來報 `exists`）；覆蓋之前存一版歷史（跳過節流）；父目錄不在就補齊 |
| `createChapter` / `ensureDraft` | 章號 + 標題 / 章節路徑的映象。新建正文一律出 `.txt`（2026-10-24，不寫標題行） |
| `writeExport(rel, text)` | 呼叫方給的路徑（匯出全文，`features/exportBook.ts`：`导出/<书名>.txt`）。照章節現拼的副本，不是作者的產物：**不過 2MB 上限**（一本書動輒幾 MB）、不審閱、不存歷史、不跑 handler，已有就整份覆蓋；越界與寫不進去的三處照常攔 |
| `createChapterAt(rel, content, plotRelPath)` | 呼叫方給的路徑（照細綱寫正文時由 `views/pipeline.ts` 的 `chapterTargetOf` 算：細綱所在的子目錄）。細綱路徑與新正文的映象對不上（純序號的 `030.md`、正文按標題落成 `030-雪夜.txt`）就把細綱改名過去；映象位置已有檔案時不動、記 warn |
| `createChapters(items)` | 同 `createChapter`，一次好幾章（匯入原稿）：每章照樣過 `write`（同名報錯退出、大小上限），只是 chapter handler 的 manifest 同步**延到最後做一次**（`WriteOptions.deferAfter`，只對章節生效）——逐章重掃全部章節是 O(n²) 次讀盤，三百章十幾秒。撞了同名就拋，前面寫好的留著、manifest 照樣同步 |
| `finalizePlot` | 章節：正文映象的那一份細綱，沒有就在映象位置新建（見上一節「定稿寫回」） |
| `writeCharacter` / `writeLore` | slug（可帶子目錄） |
| `writeStyleGuide` / `writeGlobalSummary` | 固定路徑 |
| `markThreadsJudged(no)` | 第 `no` 章的敘事線判過了（敘事線重做四期）：推 `project.json` 裡的水位 `threadsThrough`（正好是水位 + 1 就推、順著後面已經判過的接著推，更靠後的記進 `threadsJudged`；水位以內的不寫盤）。同全文大綱的水位：manifest 是鏈外的索引，沒有上游指紋；不放 SQLite（第 17 條） |
| `writeSkillBindings(text)` | 固定路徑（`skills.json`）。設定頁「技能」與 `skills bind` 動手前都已經問過作者，這裡不再彈覆蓋審閱——每換一次下拉框彈一個 JSON 的 diff 只是噪聲 |
| `createThread(thread)` | 新建一條敘事線 `threads/<线名>.md`（排線、定稿認出新線）：**同名跳過**——檔案已經在了就一個位元組不動、返回 undefined（第 19、28 條：機器只追加）。鏈外檔案，沒有上游指紋 |
| `updateThread(rel, edit)` | 改寫一份敘事線檔案（一條線，或「未歸屬的伏筆」，還沒有這份檔案當空串）：讀**此刻**的原文交給 `edit`、寫回它給的新原文（覆蓋前存一版歷史）：排線、定稿要調幾十秒模型（拆細綱寫計劃事件也走它，敘事線二期），寫之前重讀、只在上面外科式地改，作者這期間的改動才不會被一份舊全文沖掉；種類不是 `threads` 的拒寫 |
| `setParagraphStyle(style)` | 固定路徑（`config.md`）。內建編輯器「編輯 → 段落格式」：**只改 frontmatter 的 `paragraphStyle` 這一行**（`setConfigParagraphStyle`），別的位元組一個不動；沒有 `config.md` 就新建一份只有這一段 frontmatter 的（沒有小節，「小說配置」仍算沒填，主按鈕不變）。經 `write` 落盤、不彈覆蓋審閱（改的只是作者在選單裡點的那一個鍵），帶讀到時的 hash 當樂觀鎖；已經是這個值時不寫 |
| `initializeProject(meta)` | 新工程（`actions.ts` 的 `initProjectFlow`：外掛命令、網頁按鈕、CLI 共用）：固定目錄（`model` 的 `scaffold`）→ 幾份空模板（架構三件、文風、全文大綱；情節大綱沒有檔案；落點與內容由 `model` 的 `newProjectTemplates` 給，純資料）→ manifest（`model` 的 `createManifest`，最後寫：模板寫到一半失敗時工程不算建好，再點一次就補齊）。**模板經 `write` 寫，`mode: 'create'`，落點上已經有東西（檔案或目錄）就一個位元組不動**——與從前 `model/project.ts` 裡的 `writeIfAbsent` 同一個口徑，那一處繞過了閘道器，而 `model/` 不能反過來依賴閘道器，所以拆成「資料層給腳手架與模板內容、閘道器寫模板」。經閘道器不多出動作：create 不彈審閱、不存歷史；這幾種（setting / style / globalSummary）的 handler 不記賬，不寫細綱，已有細綱不會被補上 `upstreamHash`、沒有東西因此掛 ⟳；沒有伴生也就不記日誌。返回新建了哪幾份 |

呼叫方手裡只有物件，讓它自己去拼路徑等於把命名規則複製一份出去。

它們仍然經同一套 handler 記賬與伴生，只是路徑由這一層算出來。
