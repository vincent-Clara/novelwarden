# Agent 架構改造 · 索引

> **狀態：五期已全部合入，這一組是當時的記錄，不再更新。**
> 當下的真相以模組 README 與 [AGENTS.md](../../AGENTS.md) 為準——下面的文件裡
> 有幾處已經對不上了：產品承諾當時是 23 條（現在 26 條），工具當時住在
> `core/agent/tools/`、契約在 `core/agent/registry.ts`（**現已獨立成
> [`core/tools/`](../../src/core/tools/README.md)**：工具不認識 agent 的預算與閘門，
> 迴圈不認識工具，理由見那份 README 開頭）。
>
> 留著它是為了**當初為什麼這麼切**那部分；照著裡面的路徑建檔案會建錯地方。
>
> 之後的**生成鏈路重構**（復刻 AI-Novel-Writer 的創作鏈路 + WebUI 重做：架構四件 → 情節大綱 → 一章一綱 → 自動續寫 → 定稿 → 審稿修稿）另有一組：設計依據 [specs/2026-09-29-blueprint-pipeline-design.md](specs/2026-09-29-blueprint-pipeline-design.md)，總計劃 [plans/2026-09-30-blueprint-pipeline-roadmap.md](plans/2026-09-30-blueprint-pipeline-roadmap.md)，逐期實施計劃是同目錄下的 `*-blueprint-pipeline-phase*.md`。那一組之後卷、劇情段、中轉站都刪了，下面文件裡凡是提到它們的地方都只是歷史。

## 是什麼

把對話頁的 AI 從「執行一條命令」（chatbot + workflow）改成「拿著工具達成一個目標」（agent），同時保住 [AGENTS.md](../../AGENTS.md) 的 23 條產品承諾。

agent **只做上層排程**；真正要生成文字時，它通過工具呼叫走既有的分階段裝配 + 提示詞那條路。

## 讀什麼

| 文件 | 什麼時候讀 |
|---|---|
| [設計：agent 架構改造](specs/2026-08-15-agent-architecture-design.md) | **一定先讀。** 四層架構、7 個工具、為什麼這麼切 |
| [零期：事件流 provider](plans/2026-08-15-agent-phase0-provider-events.md) | 動手做零期時 |
| [一期：workspace 讀寫閘道器](plans/2026-08-15-agent-phase1-workspace.md) | 動手做一期時 |
| [二期：generation 無狀態化](plans/2026-08-15-agent-phase2-generation.md) | 動手做二期時 |
| [三期：agent 迴圈 + 只讀四件套](plans/2026-08-15-agent-phase3-loop.md) | 動手做三期時 |
| [四期：寫工具 + 策略](plans/2026-08-15-agent-phase4-write.md) | 動手做四期時 |

每份計劃末尾都有一段**「給接手 agent 的提示詞」**，可以直接複製給新會話。

## 分期與依賴

```
零期  L0 事件流 provider          ← 必須最先做，其餘都依賴它
 ↓
一期  L1 workspace 讀寫閘道器        ← 最大的一期，是「能安全給 agent 寫許可權」的前提
 ↓
二期  L2 generation 無狀態化       ← 依賴一期（落盤要先搬進 workspace）
 ↓
三期  L3 agent 迴圈 + 只讀工具      ← 第一個有新功能的一期
 ↓
四期  寫工具 + 策略 + UI           ← 依賴前四期的全部保護
```

**零到二期一個新功能都沒有，全是重構**，驗收標準都是 `npm test` 全綠。它們把「能不能安全地給 agent 一個 `write`」這個問題徹底解決掉——三期的 agent 迴圈因此只有 300 行左右，四期加寫許可權不需要新的保護程式碼。

## 四條貫穿全程的紅線

1. **agent 不決定「下一步」。** 那是 `model/pipeline.ts` 的 `deriveNextStep`，零模型呼叫、精確、免費。每回合把它的結論注入 agent，agent 拿著去執行。兩處各判各的，介面上就會出現「徽章說待拆場景，agent 讓你寫正文」（第 20 條）。
2. **agent 上下文薄，生成上下文厚。** agent 只看狀態、路徑、字數、hash、工具結果摘要；`generate` 工具內部照舊跑 `buildContext` + `recipeFor` 裝十萬字。生成產物**絕不回灌** agent 迴圈。
3. **不動 `context/recipes.ts` / `prompts.ts` / `layers/` / `features/artifact.ts`。** 分階段裝配是這個專案既有質量的來源，agent 化不碰它。
4. **寫盤只有一條路**（`workspace.write`），覆蓋已有內容一律審閱，任何策略模式下都不放開。

## 不做

- 不做一鍵成書、不做多 agent、不做工具呼叫的文字協議兜底
- 不給 `bash`、不給工程根外的路徑、不給刪除/改名/移動工具
- 不做向後相容（專案處於初期開發階段，見 `.claude/CLAUDE.md`）
