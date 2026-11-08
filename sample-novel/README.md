# sample-novel — 示例小說工程

一個真實格式的示例工程，有兩個用途：

1. **開發除錯**：按 `F5` 啟動 Extension Development Host 時自動開啟這裡，直接可以試拆細綱 / 寫正文 / 定稿 / 角色卡。它是一份「架構齊全、大綱排到第 10 章（第 5–10 章是隻有梗概的細綱）、寫到第 3 章、第 4 章細綱已經排好」的書，所以主按鈕會是「寫第 4 章」（落點 `.novelwarden/summaries/004-空匣.md`）。
2. **測試夾具**：`tests/contract/sampleNovel.test.js` 與 `tests/integration/context/builder.test.js` 在它上面跑**只讀**斷言（含細綱的三個指紋：`upstreamHash`、`writtenFrom` 與對著章節正文的 `sourceHash`）——**不要隨手改 `chapters/` 裡的正文**，否則 hash 斷言會掛；要改就把 `.novelwarden/project.json` 裡的 `contentHash` 與對應細綱的 `sourceHash` 一起更新。改了細綱，要把它 frontmatter 的 `upstreamHash`（梗概的指紋——梗概就是情節大綱裡這一章那一條）與 `writtenFrom`（細綱七節的指紋）重算。需要寫盤的用例一律經 `tests/helpers/tmpProject.js` 的 `copyFixture()` 複製一份出去跑，不碰這裡。

## 目錄

```
chapters/                    正文，NNN-标题.md。**唯一真相**：定稿照它更新細綱，
                             上下文裡的正文也從這裡取
├── 001-楔子.md
├── 002-客栈里的女人.md
└── 003-夜访.md
.novelwarden/
├── project.json             章節索引（version: 1）+ 全文大綱彙總到第幾章
├── config.md                小說配置：型別 / 結構 / 視角 / 總章數 / 每章字數 + 七節
├── premise.md               故事前提（一句話前提 / 核心衝突鏈 / 金手指定位 / 懸念骨架）
├── world.md                 世界觀（規則與漏洞 / 階層與資源 / 深層危機）
├── style.md                 文風指南（寫正文時必注入）
├── characters/              角色卡（frontmatter + 固定小節）——也就是角色圖譜
├── lore/                    世界觀設定條目（含 keywords，命中即注入）
└── summaries/               細綱，一章一份，與 chapters/ 裡的正文相對路徑相同（副檔名 .md），細綱號 = 章號；外加全文大綱 global.md（原全書摘要，只有「主線進展」一節）
    ├── 001-楔子.md              001–003 定稿過（sourceHash 對得上正文）
    ├── 002-客栈里的女人.md
    ├── 003-夜访.md
    ├── 004-空匣.md              計劃：排好了，還沒有正文
    ├── 005-药渣.md … 010-七个人.md  只有梗概：情節大綱排到了，細綱還沒拆
    └── global.md
```

鏈路是一條軸：

```
config / premise / characters / world → 情節大綱（沒有檔案：各章細綱「梗概」的彙總）→ summaries/…/NNN.md（細綱）→ chapters/…/NNN.md（與細綱相對路徑相同）→ 定稿反向更新同一份細綱
```

格式細節（細綱的八個小節——示例裡的「連續性事實」是佔位、角色卡固定小節、frontmatter 欄位）見根目錄 [README.md](../README.md) 與 [../src/core/model/README.md](../src/core/model/README.md)。

> 本目錄被根目錄 tsconfig 的 `exclude` 排除，不參與編譯。
