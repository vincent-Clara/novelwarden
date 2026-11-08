# 預設寫作技能

這裡備了 33 份寫作技能：32 份改編自 [jarvis-write](https://github.com/ynnyh/jarvis-write) 的三類預設：文風膠囊（寫正文）、味道錨（規劃）、故事骨架（規劃）；另有 1 份是本倉庫自己寫的[對峙場面去 AI 味](#去-ai-味寫正文)（寫正文）。它們**不隨應用釋出**，要用哪份就從 GitHub 裝進「我的技能庫」，再綁到對應的階段。

## 怎麼用

1. 設定頁「技能」→ GitHub 地址，貼下面表裡的地址，點「檢查」，看過正文再點「確認安裝」。也可以對外部 agent 說「裝一下這個地址，綁到寫正文上」。
2. 裝上**不會自動繫結**，在同一頁把它綁到表頭寫的階段：文風綁「寫正文」，味道和骨架綁「規劃」。
3. 一個階段只能綁一份：味道和骨架都在「規劃」，只能二選一；文風和別的寫正文技能（比如內建的「去 AI 味」）也只能二選一。兩份都想要，可以把正文合成一份，放進本工程的 `.novelwarden/skills/<名字>/SKILL.md`。

每份都是「一段寫法 + 一段示範」：文風給筆法和一段仿寫，味道給題材質感、味道座標、一段示範場景與「跑偏 → 對味」對照，骨架給故事引擎、節奏、必備橋段與開場示範。**示範都是 jarvis-write 自撰的原創短段，不是任何原作節選**；名家筆法只是風格參考。

**沒在真實模型上比過有沒有用。** 這一類純提示詞的技能效果因模型而異（內建「去 AI 味」裡修飾那幾條單綁就幾乎沒用，見 [src/core/skills/README.md](../../src/core/skills/README.md)），先拿一兩章試。

## 文風（寫正文）

| 技能 | 名字 | 一句話 |
|---|---|---|
| [爽文快節奏（男頻）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-shuangwen) | `style-shuangwen` | 節奏第一：短句、碎段，能推進就推進，不鋪陳。 |
| [仙俠古風（疏朗寫意）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-xianxia) | `style-xianxia` | 半文白為底，句讀短，四字片語與對偶自然穿插。 |
| [懸疑冷硬（資訊控制）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-xuanyi) | `style-xuanyi` | 敘述冷，只寫看得見、聽得見的。 |
| [言情細膩（感官優先）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-yanqing) | `style-yanqing` | 感官優先：溫度、氣息、觸感、視線落點，都先於情緒名詞。 |
| [歷史權謀（話裡有話）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-quanmou) | `style-quanmou` | 對話交鋒為主體，話裡有話，字面與真意分離。 |
| [硬科幻（冷敘述·概念密度）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-kehuan) | `style-kehuan` | 技術細節具體且自洽，術語剋制、不炫。 |
| [輕小說吐槽（內心彈幕）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-qingxiaoshuo) | `style-qingxiaoshuo` | 第一人稱口語，內心彈幕與正文自然交錯。 |
| [恐怖驚悚（慢壓·錯位）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-kongbu) | `style-kongbu` | 慢壓：先鋪日常，再滲入一點錯位。 |
| [魯迅·冷峻反諷](https://github.com/noir017/novelForge/tree/main/skills/writing/style-luxun) | `style-luxun` | 白描為主，句子短而頓挫，剋制、冷峻，底下壓著反諷與悲憫。 |
| [餘華·平靜敘苦](https://github.com/noir017/novelForge/tree/main/skills/writing/style-yuhua) | `style-yuhua` | 用平靜甚至近乎溫和的語氣敘述殘酷與苦難，情感剋制到近乎冷。 |
| [汪曾祺·淡而有味](https://github.com/noir017/novelForge/tree/main/skills/writing/style-wangzengqi) | `style-wangzengqi` | 散文化，淡而有味，生活氣息濃。 |
| [金庸·武俠白話](https://github.com/noir017/novelForge/tree/main/skills/writing/style-jinyong) | `style-jinyong` | 古典白話，武俠節奏明快利落。 |
| [王小波·冷靜荒誕](https://github.com/noir017/novelForge/tree/main/skills/writing/style-wangxiaobo) | `style-wangxiaobo` | 黑色幽默與冷靜的荒誕並存。 |
| [海明威·冰山極簡（譯筆）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-hemingway) | `style-hemingway` | 冰山理論：只寫水面上的動作與對話，情緒壓在水下不說破。 |
| [冷硬剋制（硬漢派）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-cooldry) | `style-cooldry` | 剋制、冷、不抒情。 |
| [素淡白描（平實）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-plain) | `style-plain` | 平實、乾淨、不炫技的白描。 |

## 味道（規劃）

| 技能 | 名字 | 一句話 |
|---|---|---|
| [現實青春·疼痛細膩](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-youth-realism) | `taste-youth-realism` | 像《最好的我們》《你好，舊時光》一類的現實校園成長。 |
| [甜寵戀愛·輕鬆上頭](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-sweet-dopamine) | `taste-sweet-dopamine` | 像輕鬆向甜寵、下飯戀愛一類。 |
| [虐戀深情·意難平](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-tragic-deep) | `taste-tragic-deep` | 像高虐、BE 美學、意難平一類。 |
| [玄幻熱血·爽感升級](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-xuanhuan-blood) | `taste-xuanhuan-blood` | 像境界流、升級打臉爽文一類。 |
| [懸疑冷硬·抽絲剝繭](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-suspense-cold) | `taste-suspense-cold` | 像社會派/硬核推理、冷硬懸疑一類。 |
| [歷史厚重·家國沉浮](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-history-heavy) | `taste-history-heavy` | 像正劇向歷史、家國群像一類。 |
| [治癒日常·細水溫情](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-healing-warm) | `taste-healing-warm` | 像生活流、治癒系、煙火氣一類。 |
| [硬核科幻·點子驅動](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-scifi-idea) | `taste-scifi-idea` | 像點子流、思辨科幻一類。 |

## 骨架（規劃）

| 技能 | 名字 | 一句話 |
|---|---|---|
| [身份錯位·打臉流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-face-slap) | `pattern-face-slap` | 戰神歸來、贅婿翻身、隱藏大佬被小看一類的當眾打臉。 |
| [重生復仇·先知改命流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-rebirth-revenge) | `pattern-rebirth-revenge` | 重生回到悲劇之前、帶著記憶逆天改命一類的復仇爽文。 |
| [前世今生·千年羈絆流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-past-life) | `pattern-past-life` | 隔世重逢、三生羈絆、今生前緣解不開一類的宿命愛情。 |
| [閃婚契約·先婚後愛流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-flash-marriage) | `pattern-flash-marriage` | 契約婚姻、閃婚老公、隱婚甜寵一類的先婚後愛。 |
| [階層碰撞·追夢異國流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-class-gap-romance) | `pattern-class-gap-romance` | 普通青年闖進頂級圈層（異國練習生/豪門/頂級職場）的階層落差戀愛。 |
| [廢柴逆襲·草根翻身流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-underdog) | `pattern-underdog` | 人人踩一腳的底層少年一路翻盤一類的草根逆襲。 |
| [馬甲大佬·多重身份流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-secret-identity) | `pattern-secret-identity` | 馬甲遍地的掃地僧、全網追的大神就在身邊一類的多重身份。 |
| [甜寵撒糖·糖點密集流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-sweet-daily) | `pattern-sweet-daily` | 雙向暗戀、歡喜冤家、日常發糖一類的密集甜寵。 |

<a id="去-ai-味写正文"></a>
## 去 AI 味（寫正文）

| 技能 | 名字 | 一句話 |
|---|---|---|
| [高潮對峙與邏輯去AI味（寫正文/修稿）](https://github.com/noir017/novelForge/tree/main/skills/writing/tension-logic-humanizer) | `tension-logic-humanizer` | 對峙交鋒、絕境反轉一類的高張力場面：偽裝者不露強硬動作，刪掉金手指引數、報賬式求饒與流水賬轉場。 |

這一份不是改編的：照作者自己一段稿子的改前改後寫成，隨本倉庫的許可（AGPL-3.0），所以 frontmatter 裡沒有 `license` 與 `origin` 兩行。它也是寫正文的技能，和文風、內建的「去 AI 味」只能三選一。

## 來源與改動

改編自 jarvis-write（Copyright 2026 ynnyh，Apache License 2.0，許可原文見 [LICENSE-jarvis-write](LICENSE-jarvis-write)）的 `backend/app/prompts/style_capsules.py`（`CAPSULES`）、`dna_capsules.py`（`DNA_CAPSULES` 與 `GENRE_PAIRWISE`）、`story_patterns.py`（`STORY_PATTERNS`），取自 1660ca3。每份 frontmatter 的 `license` 與 `origin` 兩行寫著它出自哪一條。相對原文改了這些：

- **寫成 SKILL.md**：原來是程式碼裡的欄位，生成時由對方的引擎拼進提示詞；這裡把欄位寫成正文的幾節，引導語照原來的意思改寫。
- **標點改成全形**：原文的中文裡用的是半形逗號、問號、冒號與括號，示範段會被模型照著學，所以挨著中文的一律換成全形。
- **改正寫反的引號**：故事骨架裡有幾處把一對引號寫反了（`」被小看→…→打臉「`，甜寵那條開頭寫成了 `』`），按配對順序改正。
- **「跑偏 → 對味」對照只給現實青春帶全**：原來按題材模式取「現實向」那一組，可那一組的改法全是校園場景（教輔、賀卡、同桌），套到懸疑、歷史上會把規劃往校園帶；所以只有現實青春帶這一組，八份都帶兩條通用的對照。
- **去掉「最高優先順序」**：原來故事骨架的塊頭寫著結構錨最高優先順序，這裡的技能只補充寫法，作者事實與輸出格式說了算（注入時的塊頭就是這麼說的）。
- **「像哪些作品」只寫在 description 裡**：設定頁看得到，正文裡沒有。原專案也不把書名餵給模型，因為模型對一本書的記憶靠不住。

轉換指令碼沒有放進倉庫：它只是一次性的，用 `ast` 讀對方的原始碼、不執行。以後要改哪一份，直接改這裡的 `SKILL.md`。
