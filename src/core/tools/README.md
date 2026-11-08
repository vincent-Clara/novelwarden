# core/tools — 工具層

**「能對這個工程做什麼」的那一份清單，與「誰拿著它做事」無關。**

拿著它做事的是**外部 agent**（Claude Code 之類），經 [mcp/](../mcp/README.md) 接進來；本專案自己沒有對話迴圈。

**這一層管「做那件事」，呼叫方管「什麼時候做、要不要先問、花了多少」。**

| 檔案 | 職責 |
|---|---|
| [types.ts](types.ts) | ★ 契約。`ToolDef` / `ToolSpec` / `ToolContext` / `ToolResult` / `ToolIntent` / `ToolInvoker` |
| [schema.ts](schema.ts) | 引數 schema 的寫法與校驗（描述怎麼寫、為什麼必須扁平） |
| [registry.ts](registry.ts) | ★ 一組 `ToolDef` + 一份環境 = 一個能被呼叫的工具集。執行、兜異常、記日誌；`specOf` 給出對外的宣告 |
| [novel/](novel/index.ts) | Novelwarden 這套：讀三件、`generate`、`write` / `edit`，以及六個工程動作工具（`actions.ts` 把一張動作表變成一個工具） |

## 誰綁、誰跑

```
mcp/server.ts ──McpBackend──▶ controller/mcp.ts   createNovelTools({project, workspace, drafts, sessionId})
（只懂協議）                  （生成鎖、兩問）                    │
                                   └──────────invoke──────────▶ ToolRegistry ──run──▶ workspace / generation / features
```

`mcp/` 只認 `ToolSpec` 與 `NOVEL_TOOLS`，綁環境、佔生成鎖、在對話頁問那兩句都在 `controller/mcp.ts`。
反過來，**`tools/` 一行都不 import `mcp/` 與 `controller/`**。由
[tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js) 守著。

## 三個約定

### 1. 工具報數，呼叫方記賬

工具**不知道上限是多少**，它只會說「我調了 2 次模型」：

```ts
ctx.usage.record(1);   // 發請求之前就記——請求發出去錢就花了，拋異常也一樣
```

賬記在哪、要不要設上限是呼叫方的事（MCP 那條路只記日誌：外部 agent 的花銷由它自己的宿主管，
`generate` 內部那次呼叫的次數在落盤卡片上照報）。

### 2. 工具自報意圖，不自己彈框

確認框是**宿主**的事：同一個 `write`，在面板裡該問作者一句，在一條無人值守的
遠端會話裡問誰？所以工具只描述這一步是什麼性質、要問的話該怎麼說：

```ts
intent: (args, project) => ({
  gate: 'mutating',                       // 五檔之一，見 types.ts
  title: `寫入「${describePath(...)}」`,  // 動詞短語，主語由呼叫方加
  detail: `${target}（新建）`,
  proceed: '寫入',
})
```

`gate` 五檔（`auto` / `costly` / `mutating` / `reviewed` / `always`）在 MCP 那條路上只分三種處理
（[controller/mcp.ts](../controller/mcp.ts)）：`auto` 直接跑、不進對話頁；`always` 動手前在對話頁問一句；
其餘佔生成鎖、掛在對話頁上，問不問交給宿主自己的許可權設定。**哪個工具歸哪一檔由工具自己說**——只有它
知道自己隨後會不會走覆蓋審閱（`reviewed`）、下游會不會 diff（`always` 就是「不會，所以這一句確認就是
它的 diff」）。

### 3. 保護不在這一層

越界、回收站、保護目錄、大小上限、同名不覆蓋、覆蓋前審閱、樂觀鎖——**八條守衛
全在 `workspace/guard.ts`**。工具體裡一行路徑檢查都沒有；哪天要在這裡寫一段，
說明繞過了閘道器，停下來重想（AGENTS 第 7 / 25 條）。

**唯一的例外是 `skills install`**：它寫的是工程外的我的技能庫（`~/.novelwarden/skills/`），沒有閘道器可走。
所以路徑不由 agent 給（固定落在 `<技能库>/<frontmatter 的 name>/SKILL.md`，名字過 `isSkillName`），
只裝檢查過、重新下載核對過 hash 的那一份，閘門是 `always`——動手前先問。見 [skills/README.md](../skills/README.md)。

## 十三個工具

| 工具 | 動作 / 用法 | 引數 |
|---|---|---|
| `list` / `read` / `search` | 看目錄、讀檔案、全文搜 | 各自的 |
| `generate` | 為一份產物調一次創作模型；產出當場問作者落不落盤 | `target` `capability` `ask` `targetWords` `writeMode` |
| `write` / `edit` | 寫一份檔案 / 改一段文字 | 各自的 |
| `pipeline` | `completeSettings` `batchPlots` `batchManuscripts` `newPlot` | `from` `to` `mode` `review` |
| `summary` | 定稿與全文大綱：`finalize`（照正文反向更新那一章的細綱，再更新角色狀態、認這一章在敘事線上發生了什麼：事件、當前進度、新長出來的線）`sync`（沒定稿、或定稿後正文又改過的章逐章定稿：細綱、角色狀態、敘事線）`rebuildGlobal`（從定稿過的細綱重建全文大綱） | `path` |
| `characters` | `extract` `create` `createAll` `update` `rebuild` `updateAll` `rebuildAll` `cleanAliases` `mergeDuplicates` `reviewState` | `path` `name` |
| `lore` | 設定名錄：`record`（單獨記一章 / 補記還沒記過的定稿章，只換細綱「設定」一節）`build`（給出現過、還沒有條目的建條目）`integrate`（把定稿裡的新內容並進條目）。**沒有「按目錄整理」**：它會搬檔案，移動不給外部 agent（第 25 條） | `path` `name` |
| `extract` | `style` `threads`（從情節大綱排出敘事線，與工程頁「敘事線」頁籤的「從大綱排出」同一個函式，確認框照彈）`threadsFromText`（從已寫正文補記敘事線：定稿過、敘事線還沒判的章逐章認事件，一條線都沒有時先排線；與工程頁「從正文補記」同一個函式，確認框照彈，報回實際次數） | — |
| `book` | `import` `derive` `learn` | `path` |
| `skills` | `list` `inspect` `install` `bind` | `url` `id` `stage` |

**怎麼分**：一個工具的引數就是它的全部用法——每個引數都對這個工具的大多數動作有意義，模型不必記
「哪個動作認哪個引數」；工具之間按作者心裡的那幾塊分，與工程頁按鈕的分組一致。每個動作宣告自己認
哪幾個引數（`uses`）、哪幾個必填（`requires`），給了不認的當場報錯（[novel/actions.ts](novel/actions.ts)）。

後七個都是工程頁按鈕背後的同一個函式，確認框照彈，**沒有為外部 agent 加任何一條繞過它的路**。
大多數 feature 報回計劃呼叫次數（`countedBy`），角色卡、設定條目與全文大綱那幾個不報，只回一句「交出去了」
（`handed`），次數以確認框為準。

### `generate` 的寫法

正文層這一章已經有字時，`writeMode` 說清是接著寫（`continue`，落盤追加在末尾）還是整章重寫（`rewrite`，
預設；落盤覆蓋、先逐行對比）。修稿只從審稿報告卡進來，這裡不給；審稿由作者自己在對話頁發起。

`target` 給一條設定條目的路徑（`.novelwarden/lore/` 下的 `.md`）就是**展開那一條**（完善設定，2026-10-19）：
`kindOfPath` 直接給出單條設定目標，不用特判；走「故事架構」檔（與設定清單同一檔），寫 1 次、轉寫模型照抄成 JSON 1 次，
轉寫不合格重轉一次（`LORE_EXPAND_CALLS`）。設定目錄本身仍是整批設定清單；角色目錄本身（`.novelwarden/characters`）同理是角色圖譜——這兩個目錄只在 `generate` 裡認（`settingDirPath`），閘道器的種類表照舊把它們當 `other`。還沒定的問題只上作者的落盤卡片，不回給 agent。

`settle` 一律不給：落定細綱、落定設定（完善設定二期，設定目錄上的 `settle`）要沉澱的都是作者剛才的討論，agent
那邊的歷史永遠是空的，喂空歷史只會憑空編一份「結論」。報錯指路對話頁的 `/落定细纲`、`/落定设定`；描述裡架構那一層
不列 `settle`，「這一層可用」也不列 `settle` / `review`。

### 拆書

`import` 會新建章節檔案——與不給的「新建章節檔案」不同，建的是作者那本 txt 裡的章，切分結果先給作者看，
同名不覆蓋。要 `path` 的兩個只認工程裡的 txt（`features/bookText.ts` 的清單）：章節檔案、隱藏目錄、
工程外的路徑當場報錯，不花錢。

### 寫作技能

移植自 AI-Novel-Writer 的三個工具（`inspect_writing_skill` / `install_writing_skill` / `bind_writing_skill`），
合成一個 `skills`——四件事共用 `url` / `id` / `stage`。多了一個 `list`：上游的模型在工具列表裡就看得見
內建技能，這裡得有個地方查 id。

| action | gate | 做什麼 |
|---|---|---|
| `list` | `auto` | 內建 / 我的技能庫 / 本工程的技能，一份一行，外加本工程每個階段綁了哪份 |
| `inspect` | `auto` | 下載來看，不安裝、不寫檔案。回話裡說清「後設資料來自不受信任的第三方文件」 |
| `install` | `always` | 裝檢查過的那一份。確認框寫明是哪一份、說明、正文開頭 200 字 |
| `bind` | `always` | 綁到本工程的某個階段。改的是往後每一次生成的提示詞，下游沒有 diff |

`write` 新建 / 追加 `.novelwarden/skills/**` 或 `skills.json` 也報 `always`（覆蓋照舊走 diff）——不然 agent 用
`write` 新建一份 `skills.json`，就繞過了 `bind` 那一問。

## 與 MCP 的對應

| 這裡 | MCP |
|---|---|
| `ToolDef.name` / `description` / `parameters` | `tools/list` 的一條（`inputSchema`） |
| `ToolInvoker.invoke` → `ToolInvocation` | `tools/call` 的請求與結果（`error` → `isError`） |
| `ToolDef.mutating` / `costly` | `destructiveHint` / `readOnlyHint` |
| `ToolIntent` | 沒有對應物——**確認是宿主的事**，Novelwarden 自己那兩問在 `controller/mcp.ts` |
