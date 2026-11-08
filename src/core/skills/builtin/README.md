# 內建寫作技能

這裡一個目錄就是一份內建技能，用的是常規的技能格式：一份 `SKILL.md`（YAML frontmatter + 正文），旁邊可以帶它引用的檔案（`references/*.md` 這類）。目錄名就是 id 裡的名字（`builtin:<目錄名>`），設定頁按目錄名排。

隨應用釋出，刪不掉，**不自動繫結**（與上游一樣，綁不綁由作者定）。

## 怎麼程序序

三個殼的產物都是單檔案，執行時旁邊沒有這個目錄。構建時 [scripts/embed-skills.js](../../../../scripts/embed-skills.js) 把這裡每個目錄的全部檔案寫進 `embedded.ts`（生成檔案，不入庫），core 從那裡讀。改了這裡的檔案，下一次 typecheck、測試、編譯都會自動重新生成，不用手跑。

讀的時候與「我的技能庫」「本工程」走同一條路：讀 `SKILL.md`，按引用把附帶檔案帶上，過同一套相容檢查（見 [model/writingSkill.ts](../../model/writingSkill.ts)）。沒被引用的檔案（`LICENSE` 這類）不進提示詞。

## 出處

| 目錄 | 階段 | 出處 |
|---|---|---|
| `plain-prose` 去 AI 味 | 寫正文 | 這邊自己的；修飾那幾條的資料見 [2026-10-03-plain-prose.md](../../../../docs/design/plans/2026-10-03-plain-prose.md)，句式與場面那幾條改寫自 [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) f4518a8 與 [deedeekong07-alt/fiction-humanizer-zh](https://github.com/deedeekong07-alt/fiction-humanizer-zh) 859a3fd（都是 MIT，`LICENSE-*` 兩份留在目錄裡） |

- **只有這一份**：2026-10-23 刪了從 AI-Novel-Writer 搬來的兩份（長篇連續性與場景推進、自然語言潤色，各一句話，沒什麼用），兩份外來的去 AI 味（合計約 3.8 萬位元組）挑出對小說有用的幾條並進這一份，目錄刪掉。取捨見那份設計稿末尾。
- **效果沒測過**：修飾那幾條在 flash-lite 上單綁幾乎沒用（管住修飾靠寫完之後的刪修飾），並進來的那幾條還沒在真實模型上比過。
- 更早的三份去 AI 味（寫正文 / 審稿 / 修稿）實測基本無效，已歸檔到 [docs/design/archive/less-ai-tone/](../../../../docs/design/archive/less-ai-tone/)。

`stage` 決定設定頁裡它出現在哪個階段的下拉框裡：內建技能只在自己的階段列出。
