# core/model — 資料層

小說工程的資料模型與全部檔案讀寫。所有上層功能（上下文裝配、生成、定稿）都通過這一層訪問資料，不直接碰磁碟。

核心約定：**資料是工作區裡的普通 Markdown / JSON**，作者隨時可以在編輯器裡手改。因此本層的一切解析都以「容錯優先」——手改檔案不該讓外掛崩掉。

## 檔案

| 檔案 | 職責 |
|---|---|
| [types.ts](types.ts) | 全部資料結構（`Chapter` / `SummaryCast` / `CharacterCard` / `LoreEntry` / `ProjectManifest` / `NovelConfig`）與角色卡的固定小節定義。 |
| [chapterFile.ts](chapterFile.ts) | ★ 「什麼檔案算章節」的唯一定義（第 9 條）。純函式，掃描器、編輯器、獨立版檔案監聽共用。 |
| [naming.ts](naming.ts) | ★ 稱呼學（純函式）：判泛稱、過濾別名；只過濾 aliases、不過濾 name，劇作稱謂（`主角`、`反派`）例外。 |
| [identity.ts](identity.ts) | ★ 同一人聚類（純函式）：同章共現作硬約束的貪心聚類，不用並查集。 |
| [gender.ts](gender.ts) | 角色卡 `gender` 的歸一（`normalizeGender`）與合併口徑（`keepGender`：卡上寫了的不動）。 |
| [pipeline.ts](pipeline.ts) | ★ **創作流水線的領域模型**：`Stage × Capability × Target`、全書與單章兩級狀態機（`deriveBookNextStep` / `deriveNextStep` / `deriveStage`）與各動作的呼叫次數。純函式。 |
| [settingFile.ts](settingFile.ts) | ★ 架構層三份文件（`config.md`、`premise.md`、`world.md`）的格式與讀寫。 |
| [plotFile.ts](plotFile.ts) | ★ 一章細綱的格式：映象正文路徑、七節加「設定」一節、梗概的指紋；寫之前是計劃，定稿後是實際。 |
| [loreFile.ts](loreFile.ts) | ★ 設定的格式與認法：細綱「設定」一節一行一條、條目的一句話與「暗設」、分類就是目錄。 |
| [outlineFile.ts](outlineFile.ts) | ★ 情節大綱**一章一條**的認法、按遠近帶，以及從各章細綱梗概彙總、存時拆回的規矩。 |
| [structureGuide.ts](structureGuide.ts) | 故事結構指導：六種結構按累計百分比切成章號區間。純函式。 |
| [labels.ts](labels.ts) | 固定介面／小節標籤的繁體顯示與繁簡別名；保留既有儲存鍵，不轉換作者自行輸入的內容。 |
| [markdown.ts](markdown.ts) | 輕量 Markdown 工具：frontmatter 與「## 小節」的解析 / 序列化、取值兜底；解析失敗忽略該行、不拋。 |
| [fs.ts](fs.ts) | 磁碟與字串小工具：文字讀寫、穩定雜湊、字數統計、檔名清理、slug 生成與掃描目錄忽略規則。 |
| [castParse.ts](castParse.ts) | 出場人物欄位的序列化與解析（`pushCast`：稱謂換真名、光稱謂丟掉）。 |
| [continuity.ts](continuity.ts) | ★ 細綱的「連續性事實」：渲染與讀回、定稿時找證據（`attachEvidence`）、寫正文時按證據定位（`locateEvidence`）。 |
| [writingSkill.ts](writingSkill.ts) | 寫作技能的純函式：讀 `SKILL.md`、不相容規則、技能 id、階段繫結檔案的格式。 |
| [importText.ts](importText.ts) | 拆書的純函式：解碼、認章標題、切章、抽樣與篇幅統計。 |
| [threadFile.ts](threadFile.ts) | ★ 敘事線的格式：一條線一個檔案、狀態從事件現算、外科式寫入、各階段挑哪幾條、判到哪的水位。 |
| [timelineFile.ts](timelineFile.ts) | ★ 故事時間 `threads/时间线.md`：一章一行的認法、曆法與日期推算、對賬；機器寫的行能換，作者的不動。 |
| [characterState.ts](characterState.ts) | ★ 角色卡「當前狀態」歸誰：空著或 `stateHash` 對得上歸機器，其餘歸作者；`patchCardState` 只換那一節。 |
| [review.ts](review.ts) | ★ 審稿報告：目標凍結、引文歸一與定位（`normalizeQuote` / `locateQuote`）、報告的解析。 |
| [plotCheck.ts](plotCheck.ts) | 寫前衝突檢查的選事實、提示詞與校驗：只認硬矛盾，每一處都要帶兩句能在原文裡找到的引文。 |
| [preflight.ts](preflight.ts) | ★ 一致性預檢：細綱排出場的人在卡上或連續性事實裡已經死了 → 一條風險。 |
| [manuscriptCheck.ts](manuscriptCheck.ts) | 寫完一章之後的確定性檢查（禁用詞、停在半句、比喻詞計數）與續寫回退點。 |
| [sensitiveWords.ts](sensitiveWords.ts) | 自定義敏感詞表 `.novelwarden/sensitive.txt` 的解析（寫作體檢用），壞行跳過並記原因。 |
| [trimProse.ts](trimProse.ts) | 刪修飾的純函式：切段編號、讀回 `[n] 正文`、只許刪的逐段驗收（`trimProblem`：新增漢字按字 LCS 算、對白一字不差、刪完至少留四成、段尾標點不變）、拼回正文並按八成保底退回刪得最多的段（`applyTrim`）。純函式、零 import。 |
| [paragraphFormat.ts](paragraphFormat.ts) | ★ **正文的分段格式與一鍵排版**（`paragraphStyle` 三個值，`formatProse` / `layoutProse`）。 |
| [textFind.ts](textFind.ts) | 查詢替換的匹配口徑（編正則、找全部匹配、`$1` 展開、只換選中的幾處），編輯器查詢條與全書查詢替換共用。 |
| [bookDir.ts](bookDir.ts) | 新建一本書時的資料夾名（`bookDirName`）。純函式，前端也打包它。 |
| [bookFindScope.ts](bookFindScope.ts) | 全書查詢替換的範圍表與上限（`BOOK_FIND_LIMIT`）。純資料，前端也打包它。 |
| [bookFind.ts](bookFind.ts) | 全書查詢替換在一份檔案上的口徑：哪些字不搜不換（`protectionOf`：frontmatter 的機器賬、解析器認的小節標題）。 |
| [paragraphDiff.ts](paragraphDiff.ts) | 段級 diff（五期 W11）：按空行切段、段序列 LCS、相鄰改動併成一處，`joinMerge` 組合合併結果。獨立版的合併檢視直接打包它。純函式、零 import。 |
| [project.ts](project.ts) | ★ `NovelProject`：只讀的資料訪問層（寫盤在 `core/workspace/`）：腳手架、章節索引、架構讀取、細綱按路徑配對、定稿查詢、回收站落點。 |
| [providers.ts](providers.ts) | ★ 多服務商 / 多模型的資料模型；引用只在第一個斜槓處切分（第 5 條）。 |
| [tiers.ts](tiers.ts) | ★ **模型分檔**：三檔與各項後臺任務的歸屬（含 `review`、`transcribe`）。純資料 + 純函式。 |
| [transcribe.ts](transcribe.ts) | 轉寫與具體哪一步無關的那一半：兩條訊息（`transcribeMessages`）與溫度 0；整條走法在 features/transcribe.ts。 |
| [callChoice.ts](callChoice.ts) | 調模型之前那一問的兩個下拉框：`CallChoice` / `CallPrompt` / `CallAnswer`。 |
| [thinking.ts](thinking.ts) | ★ **思考深度**的檔位表與兩家的欄位對映；「不思考」不帶任何思考引數。 |
| [contextDetail.ts](contextDetail.ts) | ★ **上下文詳細度**四級與每一級的全部上限；`contextLimitsOf(config)` 是唯一的取法。 |
| [session.ts](session.ts) | 對話會話儲存 `.novelwarden/sessions/<id>.json`：創作目標、@ 引用、上下文明細快照的序列化與舊會話歸一。 |

## 關鍵設計

- **每次讀盤，不快取正文**：`read*` 方法每次呼叫都重新讀檔案（作者可能剛手改完），只有章節列表做一層快取，由 FileSystemWatcher 主動失效。
- **目錄是任意深度的**：`chapters/`、`characters/`、`lore/` 都遞迴掃描，作者可以按卷、按陣營分子目錄整理（`summaries/` 也遞迴掃：細綱跟著正文的子目錄走）。隱藏目錄（含 `.trash/`）與 `node_modules` 一律跳過，深度上限 8 層。
- **章節認任意副檔名，角色/設定只認 `.md`**：章節的判定在 `chapterFile.ts`——數字字首 + 非二進位制副檔名，所以 `001-楔子.txt`、`001-楔子`（無副檔名）、`004.json` 都是章節，`001-封面.png` 不是，`047 细纲.txt`、`048 作话.txt` 這種整個標題就是筆記詞的也不是。角色卡與設定條目是外掛自己的資料格式（frontmatter + 固定小節），不跟著放寬；`listFilesDeep` 收 accept 回呼，兩類各傳各的。
- **順序只看序號，一條軸**：章節順序由檔名數字字首決定，與所在層級無關；`卷一/003-x.md` 與 `003-x.md` 都是「第 3 章」。細綱號就是章號，但配對按路徑：有正文的章只認正文映象的那份細綱（`NovelProject.plotFor`），還沒有正文的章按號認計劃。序號撞車時兩條都留在樹上，讓作者看見衝突，流水線認路徑排序第一份正文。
- **只有 markdown 家族解析 H1**：`.md`/`.markdown` 的章節標題取自正文首行的 `# 標題`（`readChapterText` 會剝掉），其餘格式一律取檔名、正文一個位元組不動。`extractH1` 與 `stripH1` **都只看首行、互為逆運算**——早先 `extractH1` 帶 `m` 標誌掃全文，會把 `.txt` 正文中段的一行 `# xxx` 認成標題卻不剝掉它。改這兩個函式時務必保持互逆。（副作用：角色卡/設定條目裡 `# 名字` 不在首行時，標題現在回落 `frontmatter.name` → 檔名。）
- **草稿與細綱都按章節路徑映象**：`chapters/第一卷/012-夜入.txt` → `drafts/第一卷/012-夜入.txt`（檔名原樣）、`.novelwarden/summaries/第一卷/012-夜入.md`（副檔名換成 `.md`），不落索引——沒有索引就沒有會漂移的第二份真相。章節（檔案或整個卷目錄）經閘道器改名/移動時草稿與細綱跟著搬（`workspace/handlers/chapter.ts` 的 `carryDraft` / `carryPlot`；移出 `chapters/` 就留在原處），單章改名時細綱裡的標題也跟著改成新名（`Workspace.retitlePlot`，只改標題兩行；作者在細綱上另起過的不動），刪章節兩樣都不刪（第 10 條；細綱退回這一章的計劃）；在外面直接給正文改名，舊細綱不被新路徑冒認（那是一章新的）。細綱改名改的是標題：沒有正文時檔名跟著標題，有正文時檔名跟著正文不動；正文從不跟著細綱改名（作者的檔案）。照細綱新寫正文時正文落在細綱所在的子目錄，純序號的細綱（`030.md`）配上有標題的正文會跟著改名（`Workspace.createChapterAt`）。目標已存在時**不動**（不靜默覆蓋）。
- **`deletePlot` 不碰 `chapters/`**：刪細綱只是放棄這一章的規劃稿（定稿過的連同檔案一起進回收站），正文是作者的東西，不該被順手帶走。
- **新建只出序號名**：`writePlot` / `createChapter` 的 `title` 允許為空，那時落成 `007.md` 且不寫 H1——手工新建一章時還沒有標題可言，憑空塞一個「第7章」進檔名只是個假標題，而它會進上下文。為此有個 `safeStem`：**空標題給空串，不給 `sanitizeFileName` 的兜底名「未命名」**，否則會得到 `007-未命名.md`。標題回落鏈（`extractH1` → 檔名詞幹 → `第 N 章`）本來就認這種名；介面上的說法統一走 `pipeline.ts` 的 `chapterLabel`，未命名時只報序號。寫 H1 時用的是**清洗後的詞幹**而不是原樣 `title`，兩者一致，改名時 `renamedBody` 才認得出「這個 H1 是跟著檔名走的」。
- **正文依據的細綱指紋記在細綱上**：章節可以是 `.txt` / 無副檔名 / `.json`，是作者的東西、沒有 frontmatter，所以「這份正文依據的是哪一版細綱」記在細綱自己的 frontmatter（`writtenFrom`），由正文落盤那一步寫（`workspace.recordWrittenFrom`），定稿時刷成反向更新之後的指紋——之後再改細綱，正文才掛 ⟳。定稿時正文的 `contentHash` 記在同一份 frontmatter 的 `sourceHash` 上。從沒記過（作者手寫的正文）就永不標髒。老工程 `manuscripts/` 裡的中轉站正文、`plots/` 裡的老細綱一個位元組都不動，程式碼不再讀。
- **草稿是純推匯出來的**：`draftRelPathFor` 把章節在**章節根之下**的那段相對路徑映象到 `draftsDir` 下，檔名含副檔名原樣沿用。`ensureDraft` 按需建立、已存在原樣返回（不靜默覆蓋）；`listDraftPaths` 一次遍歷給出全部已存在的草稿，供工程頁與 `@` 引用共用（每章一次 stat 會把工程頁重新整理的 syscall 翻一倍）。`draftsDir` 是 `chaptersDir` 的兄弟目錄、不從它派生，因此改 `chaptersDir` 不影響草稿落點；`chapterSkipDirs()` 兜住 `chaptersDir` 被配成 `.` 的極端情況。
- **出場人物只認定稿過的細綱**：有 `sourceHash` 的細綱，它的 `cast` 是**實際出場**，也是唯一的真相（AGENTS.md 第 14 條）。沒定稿的細綱裡「出場人物」一節是**計劃**出場：只給裝配器挑角色卡（`context/layers/render.ts` 的 `selectCharacters`）、算「後幾章才出場的人」與一致性預檢用，不進 `castIndex`——混進去會汙染出場章統計與角色卡語料（D13）。
- **角色/設定的 slug 是路徑**：根目錄下的檔案 slug 就是檔名（與改造前一致），子目錄裡的形如 `主角/林昭`——上下文明細裡的 `character:<slug>` 因此仍然唯一。
- **定稿對不對得上按章算**：`chapters/` 裡的成品寫盤後重算 `contentHash`，與正文映象那份細綱 frontmatter 裡的 `sourceHash` 比對（`finalizedPlotOf`），不一致就回到待定稿。**空章不算沒定稿**——沒有正文就無從定稿，混進來會讓同步細綱的確認框報一個虛高的呼叫次數。不自動重新定稿，只提示。manifest 只是章節索引，不記任何定稿的賬。
- **出場人物有兩種形態，一份資訊**：定稿過的細綱 frontmatter 的 `cast: [林昭, 年輕守衛(那個年輕人)]` 給程式用（角色頁聚合、角色卡關聯），`## 出場人物` 小節給人看。定稿時從結構化 cast 渲染出小節，保證兩者一致；**讀的時候以 frontmatter 為準，欄位缺席才從小節文字反解**（見 [castParse.ts](castParse.ts) 的 `castFromText`）——老工程的摘要與作者手寫的細綱沒有這個欄位，不該因此在角色頁上憑空少一批人。用括號而不是巢狀 YAML 是因為本層的 frontmatter 解析器刻意只支援字串與字串陣列，為一個欄位引入真正的 yaml 依賴不值得，而括號形式作者也能直接手改。
  `castFromText` 的兩條判據（名字 ≤ 8 字、不含「的了是在不沒」這類虛詞）是為了擋住模型把這一節寫成句子的情況——按標點切開會得到一串句子碎片，全都會跑進角色頁的「未建卡」組裡。寧可漏掉一兩個長稱呼，也不能讓那一組塞滿垃圾；漏掉的重新定稿就有了（定稿走結構化 cast，根本不經過這個函式）。計劃名單（`plannedNames`）不套這兩條：那是作者與排細綱的模型寫的名單，「沈從文」不該因為帶個「從」就漏掉。
- **角色卡的 `stateThrough` / `stateHash` 是「當前狀態」的歸屬賬**（四期，D15）：前者是這一節寫到第幾章（0 = 開篇，角色圖譜建卡時寫的），後者是機器最後一次寫它時的指紋。`renderCharacterCard` 原樣帶著它們走——清理別名、合併重複卡這些維護動作不重新蓋章，作者改過的那一節不會因為換了個別名就變成「機器寫的」。
- **角色卡的 `appearsIn` / `updatedThrough` 是快取**：前者是該角色出場的章號，後者是上次「更新角色卡」讀到了第幾章（增量更新的依據）。真相永遠是各章定稿過的細綱，落在卡裡只為兩件事——不讀全部細綱就能在角色頁顯示「出場 12 章」，以及日後按人物檢索章節。
- **會話用 JSON 而不是 Markdown**：會話是機器記錄（含 token 明細、附件快照），不期待人工編寫，但仍是純文字、可 Git。
- **選區引用存快照**：`Attachment.text` 對 selection 存當時的快照，歷史對話不因原文修改而變；整檔案引用每次讀盤取最新。

## 依賴關係

本層只依賴 Node API 與 core 內更底層模組；`context/`、`features/`、`llm/` 依賴本層，反向不允許。
