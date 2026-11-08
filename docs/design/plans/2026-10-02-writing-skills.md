# 寫作技能（階段 Skill）

> 2026-10-02。七期之後單獨做的一期，**在 main 上直接開發**。移植自 AI-Novel-Writer（GPL-3.0，`~/workspace/AI-Novel-Writer`，master `a2948c1`）的「寫作 Skill」：上游 ADR 0015「寫作 Skill 是按階段凍結的補充指導」，程式碼在 `src/shared/writing-skills.ts`、`src/services/agent/skill-registry.ts`、`src/services/agent/writing-skill-bindings.ts`、`src/services/agent/tools/{inspect,install,bind}-writing-skill.tool.ts`、`electron/controllers/app-data-controller.ts:58-400`、`src/services/workflows/commands/base-command.ts:48-95`、`src/components/settings/SkillSettings.tsx`。
>
> 總計劃 §1 #27 原先把「階段 Skill」列為不做；作者 2026-10-02 要求移植，那一行已改。

**Goal:** 作者能給本工程的每個階段（規劃 / 寫正文 / 審稿 / 修稿）綁一份寫作技能——一份自包含、純提示詞的 `SKILL.md`——這個階段往後的每一次生成都把它放在提示詞最前面，對話頁、agent、工程頁批次帶的是同一份。技能從三個來源來：內建、我的技能庫（`~/.novelforge/skills/`，從 GitHub 先檢查再安裝）、本工程（`.novelforge/skills/`，手放）。

## 作者拍板的三件（2026-10-02）

| # | 問題 | 定案 |
|---|---|---|
| A | 總計劃 #27 寫著「階段 Skill 不做」 | 推翻，這一期做 |
| B | 上游的三個 agent 工具 | **並進 `run` 的動作**，工具數不變（七個是硬約束） |
| C | 對話裡 `/技能名` 手動呼叫 | **不做**：`/` 已經是階段命令面板；上游這條路還繞過相容檢查與預算 |

## 落在哪

| 模組 | 做了什麼 |
|---|---|
| `model/writingSkill.ts` | 純函式：`SKILL.md` 解析（上游那份手寫的 frontmatter）、六條不相容規則（逐條照搬）、建議階段、名字與 id、繫結檔案格式、`skillStageOf`、注入那一塊的說法、GitHub 地址。零執行時 import，前端直接用 |
| `skills/` | 三個來源的讀、我的技能庫的裝與卸、GitHub 先檢查再安裝（重新下載核對 sha256）、階段繫結。見 [skills/README.md](../../../src/core/skills/README.md) |
| `context/layers/skill.ts` + `recipes.ts` | `skill` 層：八張配方都在 P0 那一組的最後帶一層；訊息裡排在使用者訊息最前面 |
| `workspace/` | 新種類 `skill`（`.novelforge/skills.json` 與 `.novelforge/skills/**`，plain handler）；`.novelforge/skills` 進受保護目錄；`writeSkillBindings` |
| `tools/novel/run.ts` | 四個動作：`listSkills` / `inspectSkill`（`auto`）、`installSkill` / `bindSkill`（`always`）；新引數 `url`、`stage`；解除安裝進 `REFUSED` |
| `controller/skills.ts` + 協議 | `requestSkills` / `inspectSkill` / `installSkill` / `uninstallSkill` / `bindSkill` 進；`skills` / `skillInspection` 出。獨立版空視窗由 WorkspaceHub 直接調（技能庫能看能裝能卸，繫結要工程） |
| 設定頁「技能」 | 第三個子頁：本工程的階段繫結（四個下拉框）、從 GitHub 安裝（檢查 → 看正文 → 確認安裝）、技能庫。改了當場生效，「儲存設定」在這一頁藏起來 |

## 自定的取捨（⚑，收尾時報給作者）

1. ⚑ **階段怎麼對上**：規劃 = 架構 / 大綱 / 細綱三層的生成與落定（含補齊設定、批次拆細綱、角色圖譜第二步、細綱緊湊重建）；寫正文 = 寫、接著寫、重寫與續寫那幾輪（含批次寫章）；審稿 = 審稿與重來一次；修稿 = 按勾選修稿與修稿續寫。**討論不帶**（上游的 AI 助手對話也不帶）；定稿、摘要、文風提取不經裝配器，本來就帶不到（上游同樣不帶）。
2. ⚑ **預算**：不 force，排在 P0 那一組最後（作者事實先拿預算）；放不下整份不帶、明細寫明需要多少（上游是讓這次呼叫失敗）。
3. ⚑ **綁了卻帶不上**（找不到、變得不相容、繫結檔案讀不懂）：明細裡 dropped 寫原因，生成照常（上游是整個工作流起不來）。
4. ⚑ **不凍結快照**：每次裝配讀盤，批次跑到一半改了繫結後面就用新的（上游在工作流開始時凍結）。日誌裡記一句用了哪份，同一句五分鐘內只記一次。
5. ⚑ **名字可以是中文**；使用者與工程技能的**身份是目錄名**（上游取 frontmatter 的 name，手放的技能解除安裝會刪個空）。
6. ⚑ **解除安裝挪進回收站**（`~/.novelforge/.trash/skills/`，上游直接刪），本工程綁了它的階段一起解綁。
7. ⚑ **檢查結果帶正文**給作者看（上游裝之前看不到）；agent 安裝的確認框寫明說明與正文開頭 200 字（上游只顯示地址）。
8. ⚑ **`run` 多一個 `listSkills`**；`bindSkill` 的技能 id 複用 `name` 引數，新增 `url`、`stage` 兩個引數。
9. ⚑ **內建只搬兩個**（長篇連續性與場景推進、自然語言潤色，中文正文照抄）：其餘五個是上游 AI 助手對話用的，正文讓模型調它自己的工具。之後另加了三份去 AI 味（寫正文 / 審稿 / 修稿），見 [2026-10-02-less-ai-tone.md](2026-10-02-less-ai-tone.md)；實測無效已歸檔，換成一份修正文風加寫完之後的刪修飾，見 [2026-10-03-plain-prose.md](2026-10-03-plain-prose.md)。2026-10-23 這兩份刪了（各一句話，沒什麼用），內建只剩一份去 AI 味，見同一份設計稿末尾。
10. ⚑ **繫結檔案是 JSON**（`.novelforge/skills.json`，形狀照搬上游）；寫它不走覆蓋審閱——兩條入口動手前都已經問過作者。

## 不做

- 中英雙語、提示詞三級覆蓋（總計劃 #27 仍然不做）。
- 從本地檔案 / zip / 任意網址安裝（上游也只認 GitHub）。
- 技能的更新：同名的不覆蓋，要換新版先解除安裝舊的（與上游一樣）。
- 對話裡 `/技能名` 手動呼叫（C）。

## 驗收

- `npm run typecheck` 零錯誤；`npm run test:node` 與 `npm run test:e2e` 全綠。
- 新增測試：`tests/unit/model/writingSkill.test.js`、`tests/integration/skills/library.test.js`、`tests/integration/context/skills.test.js`、`tests/integration/tools/runSkills.test.js`、`tests/dom/view/skillsSettings.test.js`；`kind.test.js`、`runTool.test.js`、`settings.test.js` 隨改動更新。
- **沒有調真實模型、沒有連真實 GitHub**：GitHub 請求在測試裡由假的 `fetch` 應答。
