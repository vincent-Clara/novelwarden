# 寫作技能認常規技能格式（內建改成目錄）

> 2026-10-21。在 main 上直接開發，接在 271b190（兩份外來去 AI 味做成 TS 內建）之後。起因：作者看到內建技能是寫死在 TS 裡的字串，說「這不行，改造一下 skill 功能，內建 skill 要能支援常規的 skill 格式」。之前那次為了過相容檢查，Humanizer-zh 刪了 `allowed-tools`，fiction-humanizer-zh 把 `references/` 並進了正文，兩份都動了上游。

**Goal:** 常規的技能目錄（一份 `SKILL.md`，YAML frontmatter，旁邊是 `references/*.md` 這類附帶檔案）**原樣放進來就能用**。內建技能的唯一真相就是倉庫裡的那些目錄。三個來源（內建 / 我的技能庫 / 本工程）和從 GitHub 裝，走的是同一套讀法。

## 硬約束

- **三個殼的產物都是單檔案**：VS Code 是 esbuild 的 bundle，獨立版、桌面 sidecar、Docker 是 `bun build --compile`。執行時旁邊沒有倉庫，內建的目錄只能構建時內嵌。先例是 `embed-media.js`，它也說明了在執行時讀 `__dirname` 這條路走不通：c25df21 修「關於」顯示 0.0.0，就是因為這個。
- **零執行時依賴**：不引入 yaml 庫。
- **生成是一次呼叫**：模型沒有讀檔案的工具，常規技能裡「按需讀取 references/x.md」做不到，附帶檔案只能事先接進提示詞。

## 定案（⚑ = 我按推薦項定的。AskUserQuestion 在 IM 裡沒彈出來，作者批方案時沒改）

| # | 問題 | 定案 |
|---|---|---|
| ⚑1 | 範圍 | 三個來源同一套讀法；從 GitHub 裝時，引用到的附帶檔案逐個下載 |
| ⚑2 | 附帶檔案怎麼帶 | 只帶被引用到的文字檔案（`.md` / `.markdown` / `.txt`），引用可以傳遞。每份標上路徑，接在正文後面。預算和 64 KiB 都按合計算，放不下就整份不帶。明確引用了卻帶不上的（找不到、越出技能目錄、不是文字）判「包含相對引用」。沒被引用的（README、CHANGELOG、LICENSE）不帶 |
| ⚑3 | frontmatter 裡給 agent 看的宣告 | `allowed-tools` / `tools` 不算依賴工具，`metadata` 這類巢狀塊不看；`hooks` / `mcp` / `scripts` / `sub-agents` 照舊算 |
| ⚑4 | 上游原文動不動 | 正文、附帶檔案、`LICENSE` 一字不改，只在 frontmatter 里加 `display_name` 與 `stage` 兩行（前面加一行註釋說明） |
| 5 | 內建的身份與順序 | 取目錄名，與另外兩個來源一樣；按目錄名的碼點排 |

## 落在哪

| 位置 | 做了什麼 |
|---|---|
| `src/core/skills/builtin/<名字>/` | 五份內建，一個目錄一份。原來那三份的 `SKILL.md` 與原來的 raw 逐字相同；兩份外來的取自上游 f4518a8（Humanizer-zh）與 859a3fd（fiction-humanizer-zh）。出處移到 `builtin/README.md` |
| `scripts/embed-skills.js` | 把每個目錄的全部檔案寫進 `builtin/embedded.ts`（不入庫）。換行收成 `\n`，只收 UTF-8 文字；內容沒變不寫，要寫就先寫臨時檔案再 rename |
| 調它的三處 | `embed-media.js` 開頭（typecheck、e2e、獨立版、單檔案、sidecar、Docker、release）、`esbuild.js`（VS Code）、`tests/helpers/load.js`（node 測試，單跑一條也算） |
| `model/writingSkill.ts` | frontmatter 換成 YAML 子集，只讀頂層鍵：引號、塊標量、多行純量、列表與巢狀塊整塊歸上一個鍵（不再拍平）、註釋、BOM、CRLF。新增 `skillReferences`；`inspectSkillMarkdown(raw, 名字, files)` 在給的檔案裡按引用找附帶檔案；`SkillInspection` 多了 `attachments` 和 `unresolved`；`renderSkillBlock` 把附帶檔案接在後面 |
| `skills/library.ts` | `collectSkillFiles` 從 `SKILL.md` 出發按引用一層層讀，磁碟讀與 GitHub 下載共用一份。讀磁碟時路徑上每一段都不跟連結。`installUserSkill(名字, 檔案表)` 會寫出整棵目錄 |
| `skills/github.ts` | 附帶檔案和 `SKILL.md` 用同一個分支，路徑相對 `SKILL.md` 所在目錄，一份份下載；404 當作沒有，別的失敗直接拋。sha256 對整份清單（路徑加內容）算 |
| 介面、agent | `SkillRow.files`、`SkillInspectionView.attachments`；設定頁顯示「附帶 N 份檔案」，檢查卡上一份一個摺疊塊；`skills` 工具的 inspect、install、list 說法跟著改 |

## 為什麼只帶被引用的

常規技能目錄裡常有 README、CHANGELOG、LICENSE、tests/（Humanizer-zh 倉庫根就是這樣）。全帶的話，這些東西會進每一次生成的提示詞。正文自己寫明瞭要讀哪幾份，就照它的寫，所以 fiction-humanizer-zh 帶上的正好是那四份 `references/`。

普通連結（比如 `[例子](a.md)`）找不到只是不帶，跟以前一樣；只有明確指向旁邊檔案的寫法帶不上才判不相容。這是為了不把從前相容的技能判成不相容。

## 沒做的

- 不按「任務需要」挑附帶檔案：一次呼叫裡沒法判斷，要帶就全帶。
- 不支援圖片之類的非文字附帶檔案。
- 不做技能更新：要換新版還是先解除安裝。
- 外掛 `npm run watch` 期間改了內建目錄，不會觸發重新內嵌。重啟 watch 就行。

## 驗收

- `npm test`：typecheck、node 測試，以及 e2e（`PATH="$HOME/.bun/bin:$PATH"`）。
- 刪掉 `embedded.ts` 之後，`npm run compile`、單跑一條測試、`npm run typecheck` 都會自己生成；`dist/extension.js` 裡有內建技能的正文。
- `npm run dist` 出的單檔案在空目錄裡起服務，經 MCP `skills list` 列出五份內建，都可綁。
- 真實 GitHub 上兩個地址「先檢查」都判可以裝，fiction 那份列出四份附帶檔案。
