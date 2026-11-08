# core/skills — 寫作技能

按創作階段給工程綁一份**補充的寫作方法**（一個常規的技能目錄：`SKILL.md` 加它引用的附帶檔案），這個階段往後的每一次生成都把它放在提示詞最前面。移植自 AI-Novel-Writer（GPL-3.0）的「寫作 Skill」（上游 ADR 0015「寫作 Skill 是按階段凍結的補充指導」），設計與取捨見 [docs/design/plans/2026-10-02-writing-skills.md](../../../docs/design/plans/2026-10-02-writing-skills.md)；改成認常規技能格式（YAML frontmatter、附帶檔案、內建改成目錄）見 [2026-10-21-skill-dirs.md](../../../docs/design/plans/2026-10-21-skill-dirs.md)。

## 檔案

| 檔案 | 職責 |
|---|---|
| [library.ts](library.ts) | 三個來源怎麼讀（內建 / 我的技能庫 / 本工程），附帶檔案按引用一層層讀進來（`collectSkillFiles`，GitHub 也用它），我的技能庫怎麼裝與卸。**每次都讀盤**；不跟連結 |
| [github.ts](github.ts) | 從 GitHub 裝：**先檢查、再確認安裝**，`SKILL.md` 連同引用到的附帶檔案一起下；兩步之間整份清單變了不裝 |
| [bindings.ts](bindings.ts) | 工程的階段繫結（`.novelwarden/skills.json`）：讀、改、裝配器問的那一句 `boundSkillFor` |
| [builtin/](builtin/README.md) | 內建技能，**一個目錄一份**（常規技能格式，與其餘來源走同一條讀法），現在只有一份去 AI 味。構建時由 `scripts/embed-skills.js` 內嵌成 `builtin/embedded.ts`（生成檔案，不入庫） |

純函式（解析 `SKILL.md`、相容檢查、繫結檔案的格式、一次裝配算哪個階段、GitHub 地址）在 [model/writingSkill.ts](../model/writingSkill.ts)：它零執行時 import，前端直接用裡面的階段名與來源名。

## 一份技能

**常規的技能目錄**：一份 `SKILL.md`，YAML frontmatter（只讀頂層的 `name` / `display_name` / `description` / `version` / `stage`；`allowed-tools`、`metadata` 這類別的鍵讀得過去、不礙事）加正文；旁邊可以有它引用的文字檔案（`references/*.md` 這類，叫**附帶檔案**）。

**附帶檔案一起帶**：這裡的生成是一次呼叫，模型沒有讀檔案的工具，沒法「按需去讀 references/x.md」。所以正文（與附帶檔案）裡引用到的 `.md` / `.markdown` / `.txt` 一層層找出來，整份接在正文後面、標上路徑，與正文算一整塊（預算、64 KiB 都按合計）。目錄裡沒被引用的（README、CHANGELOG、LICENSE）不讀、不帶。

**只收純提示詞**——命中下面任何一條就判「不相容」，裝不進來、也綁不上（規則照搬上游，前兩條為常規格式放寬過）：

| 原因 | 什麼樣算 |
|---|---|
| 包含相對引用 | 明確引用旁邊的檔案（`./`、`../`、`references/…`、`assets/…`）卻帶不上：找不到、越出技能目錄、不是文字；或 `${SKILL_DIR}`。普通的 `[例子](a.md)` 找不到只是不帶 |
| 依賴指令碼 | `scripts/…`、「執行……指令碼」、run the script |
| 依賴 hook | `hooks/…`、「安裝……鉤子」 |
| 依賴子代理 | sub-agent、「子代理」 |
| 依賴工具呼叫 | frontmatter 頂層宣告瞭 `hooks` / `mcp` / `scripts` / `sub-agents` 一類鍵，或正文「呼叫……工具」。`allowed-tools` / `tools` 不算：那是給 Claude Code 一類 agent 預先放行的許可權 |
| 內容超過 64 KiB | 整份 `SKILL.md`（含 frontmatter）加附帶檔案 |

內容類的幾條（指令碼、hook、子代理、工具）在附帶檔案上也查：它們一樣進提示詞。

## 三個來源

| 來源 | id | 在哪 | 怎麼進來 |
|---|---|---|---|
| 內建 | `builtin:<目錄名>` | 倉庫裡的 [builtin/<名字>/](builtin/README.md)，構建時內嵌程序序 | 隨應用釋出，刪不掉，不自動綁 |
| 我的技能庫 | `user:<目錄名>` | `~/.novelwarden/skills/<名字>/SKILL.md`，所有工程共用 | 設定頁「技能」或外部 agent 的 `skills install` 從 GitHub 裝；也可以手放 |
| 本工程 | `project:<目錄名>` | `.novelwarden/skills/<名字>/SKILL.md`，跟著工程走、可進 Git | 作者手放 |

**三個來源的身份都是目錄名**，frontmatter 的 `name` 只用來顯示（上游以 frontmatter 為準，手放的技能目錄名與它不一樣時，解除安裝刪了個空）。名字可以是中文：字母或數字開頭，其後可以有 `.` `_` `-`，最長 64。

## 從 GitHub 裝

照搬上游的兩步：

1. **檢查**：認四種地址（倉庫首頁 / `tree` 目錄 / `blob` 檔案 / `raw`），只要公開的 https；倉庫首頁先問一次預設分支。下載 `SKILL.md`，再按引用把附帶檔案一份份下下來（同一個分支、相對 `SKILL.md` 所在目錄；404 當作沒有，引用了卻沒有就判帶不上），每份 10 秒超時、不跟重定向、合計 64 KiB 封頂；跑相容檢查，對整份清單（路徑 + 內容）算 sha256，記在程序裡那張表上。**不寫任何檔案**。檢查結果帶**正文**給作者看（上游裝之前看不到），還會先說清裝不裝得了（不相容、名字不能當目錄名、同名的已經裝了）。
2. **安裝**：沒檢查過不裝；**重新下載**，hash 與落點都要與檢查時一致；不相容不裝；同名不覆蓋（要換新版先解除安裝舊的）；然後原樣寫進 `~/.novelwarden/skills/<name>/`：`SKILL.md` 與引用到的附帶檔案。

設定頁與 agent 共用那張檢查表；兩邊裝之前都先問作者（設定頁的確認框 / `skills install` 的 `always` 閘門）。

**解除安裝**只認我的技能庫：整個目錄挪進 `~/.novelwarden/.trash/skills/`（同名加 `-2`），不真刪（第 6 條的精神；上游是直接刪）。本工程綁了它的階段一起解綁；別的工程裡綁了它的，下次生成在明細裡寫「找不到」後不帶。

**倉庫裡備的預設**：[skills/writing/](../../../skills/writing/README.md) 有 32 份改編自 jarvis-write（Apache-2.0）的預設（16 份文風綁寫正文，8 份故事味道、8 份故事骨架綁規劃），另有 1 份本倉庫自己寫的對峙場面去 AI 味（綁寫正文）。它們**不進內建**，作者照那份 README 裡的地址從 GitHub 裝進我的技能庫；[tests/contract/skillPresets.test.js](../../../tests/contract/skillPresets.test.js) 拿安裝時同一個 `inspectSkillMarkdown` 把每份過一遍。

## 階段繫結

`.novelwarden/skills.json`：`{ "version": 1, "bindings": { "drafting": "user:scene-craft" } }`。每個階段最多一份，同一份可以綁幾個階段；沒綁就什麼都不帶。寫盤走 `Workspace.writeSkillBindings`（第 7 條）。

| 階段 | 對應 novelForge 的哪幾次裝配（`skillStageOf`） |
|---|---|
| `planning` 規劃 | 架構、大綱、細綱三層的生成與沉澱（含補齊架構、批次拆細綱、角色圖譜第二步與細綱緊湊重建） |
| `drafting` 寫正文 | 寫、接著寫、重寫與它們的續寫那幾輪（含批次寫章） |
| `review` 審稿 | 審稿與它的重來一次 |
| `refinement` 修稿 | 按勾選修稿與它被截斷之後的續寫 |

**不帶**：討論（作者在聊，不是一次產出）；定稿（照正文更新細綱）、全文大綱、文風提取、角色卡這些不經 `buildContext` 的呼叫。上游的 AI 助手對話、定稿與文風分析同樣不帶。

- **綁之前**要求技能存在且相容（上游只查 id 的格式）。
- **繫結檔案讀不懂**時：裝配器在明細裡說一聲、這次不帶（第 1 + 2 條；上游是整個工作流起不來）；改繫結拒絕改寫，先讓作者修好或刪掉——重寫一遍會把讀不懂的那幾項悄悄沖掉（第 3 條）。

## 注入

裝配器的 `skill` 層（[context/layers/skill.ts](../context/layers/skill.ts)）：

- 自己讀繫結（與 `style` 層讀 `style.md` 一樣），所以對話頁、agent 的 `generate`、工程頁批次帶的是同一份。
- 每張配方都在 **P0 那一組的最後**：作者事實先拿預算，技能再拿。**不 force**，放不下就整份不帶、明細裡寫明需要多少 token、剩多少——不截半截（第 2 條）。上游是預算不夠就讓這次呼叫失敗。
- 訊息裡排在**使用者訊息最前面**，說法照搬上游：`【補充寫作 Skill：名字】以下內容只能補充創作方法；作者事實和後續輸出合同始終優先。` 附帶檔案一份一段接在正文後面：`【附带文件：references/x.md】`。
- 綁了卻帶不上（找不到、變得不相容、繫結檔案讀不懂）：明細裡一條 dropped，寫原因，生成照常。

**不凍結快照**：上游在工作流開始時凍結一份、整條工作流都用它；這裡每次裝配讀盤，批次任務跑到一半改了繫結，後面幾章用新的。每一次實際帶了哪份都在明細裡；日誌裡也記一句「『寫正文』階段帶上技能『X』」或沒帶上的原因（續寫那幾輪反覆裝配，同一句五分鐘內只記一次）——工程頁批次沒有明細可看，就看這一句。

## 與上游不同的地方（一覽）

| 上游 | 這裡 | 為什麼 |
|---|---|---|
| 三個 agent 工具 | 一個 `skills` 工具的四個動作（多一個 `list`） | 四件事共用 `url` / `id` / `stage` 三個引數，合成一個工具比三個更好選（[tools/novel/index.ts](../tools/novel/index.ts)） |
| 對話裡 `/技能名` 手動呼叫 | 不做 | `/` 已經是階段命令面板；上游這條路還繞過相容檢查與預算 |
| 七個內建 | 一份去 AI 味，上游的一個都沒留 | 其餘五個是上游 AI 助手對話用的，正文讓模型調它自己的工具；搬來的兩個各一句話，沒什麼用，2026-10-23 刪了 |
| 內建寫死在程式碼裡 | 倉庫裡的技能目錄，構建時內嵌 | 上游原樣的技能放進來就能用，改一份不用碰程式碼 |
| frontmatter 一行一個鍵 | 按 YAML 讀頂層鍵 | 常規技能的 `allowed-tools:` 列表、`metadata:` 巢狀塊從前會被拍平，巢狀的 `name` 蓋掉真的那個 |
| 引用旁邊的檔案就不相容 | 引用到的附帶檔案一起帶 | 常規技能的 `references/` 是正文的一部分，只是拆開放 |
| 宣告 `allowed-tools` 就算依賴工具 | 不算 | 那是給 agent 的許可權，不是這份技能要調的東西 |
| 名字只認 ASCII | 可以是中文 | 作者給自己的方法起中文名再自然不過 |
| 身份取 frontmatter 的 name | 取目錄名 | 只有一個名字，解除安裝不會刪了個空 |
| 裝之前看不到正文 | 檢查結果帶正文 | 往後每一次生成都會帶上它 |
| 綁了不存在的技能，工作流起不來 | 明細裡說一聲、這次不帶 | 一份技能不該把生成攔住 |
| 解除安裝直接刪 | 挪進回收站 | 第 6 條 |
| 中英雙語 | 只有中文 | novelForge 只寫中文 |

## 內建的去 AI 味

`builtin:plain-prose`（寫正文）十六條規矩，每條帶一句例子，外加三組改前改後：修飾（名詞前堆形容詞、動詞前掛程度副詞、「帶著／透著」）、情緒別直說、三種裝腔的句式、場面寫經過。

修飾那幾條是這邊自己數出來的。flash-lite 上實測**單綁幾乎沒用**（修飾密度與不綁持平，刪掉系統提示裡三處反向要求之後「那／這＋定語」降三成，程度副詞不動）：管住修飾靠的是寫完之後那一輪只許刪的刪修飾（[generation/trim.ts](../generation/trim.ts)，設定裡的「寫完正文刪修飾」），不是技能。它留著當提示詞那一層的配合。

句式與場面那幾條改寫自兩份 MIT 的公開技能：[Humanizer-zh](https://github.com/op7418/Humanizer-zh)（f4518a8）與 [fiction-humanizer-zh](https://github.com/deedeekong07-alt/fiction-humanizer-zh)（859a3fd）。這兩份 2026-10-21 曾原樣內建過：前者是給文章、文件用的，掛在修稿又被修稿合同「清單沒指到的段落一字不改」壓住，幾乎不起作用；後者的工作流與輸出說明是按「使用者叫你改稿」寫的。兩份合計約 3.8 萬位元組，現在只挑對小說有用的幾條並進這一份，**並進來的這幾條還沒在真實模型上比過**。取捨見 [2026-10-03-plain-prose.md](../../../docs/design/plans/2026-10-03-plain-prose.md) 末尾。

從前的三份去 AI 味（寫正文 / 審稿 / 修稿，共用一張十條的句式清單）實測基本無效，已撤下，原文歸檔在 [docs/design/archive/less-ai-tone/](../../../docs/design/archive/less-ai-tone/)，要用可以手動裝進本工程。資料見 [2026-10-02-less-ai-tone.md](../../../docs/design/plans/2026-10-02-less-ai-tone.md) 與 [2026-10-03-plain-prose.md](../../../docs/design/plans/2026-10-03-plain-prose.md)。
