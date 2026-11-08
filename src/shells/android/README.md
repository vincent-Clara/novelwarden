# android — Android 殼

手機上的 Novelwarden。和桌面殼一樣是**一層純殼**：頁面就是獨立版的那一個（`src/shells/standalone/page.ts` 吐出來的，
窄屏佈局），殼只決定開啟哪個地址，沒有一行 TS。

兩種模式，預設本機，要連遠端在返回鍵彈的選單裡點「服務端設定…」換（返回鍵先交給頁面收選單、彈窗、正文，見下）：

- **本機**（內建服務）：app 裡帶著獨立版打成的 node 單檔案和 Termux 編的 node，起在 `127.0.0.1` 上，帶每臺裝置隨機生成的令牌，
  殼替作者走 `/login` 登入（`WebView.postUrl`），再開啟首頁。
- **遠端**：不起內建服務，開啟設定裡填的伺服器地址（Docker 版，或 `--host` 綁出去的獨立版）。填了令牌就替作者登入；空著就在網頁上登入，
  輸對一次殼就記下（交表單時令牌進 sessionStorage，下一頁不是登入頁才取出來存），之後同樣替作者登入，不靠只管 30 天的 cookie。

## 目錄

| 路徑 | 內容 |
|---|---|
| `app/src/main/java/…/MainActivity.java` | WebView、兩種模式的啟動、原生的服務端設定對話方塊、書放在哪（儲存許可權）、返回鍵選單、連不上時的提示頁 |
| `app/src/main/java/…/LocalServer.java` | 起停內建服務：從 assets 拷出 `server.cjs`、挑埠、配環境變數、等 `/login` 回 200、輸出進 logcat 與 `files/server.log` |
| `app/src/main/java/…/ServerService.java` | 前臺服務，只為掛一條常駐通知（理由見下） |
| `scripts/build.sh` | 打包：`scripts/build-android-server.js` 出 `assets/server.cjs` → 沒有 node 就跑 `fetch-node.sh` → `gradlew assemble` |
| `scripts/fetch-node.sh` | 從 Termux 倉庫取 `nodejs-lts` 與依賴庫（校驗 sha256），改名成 `lib*.so` 放進 `jniLibs/arm64-v8a`。取自望舒（wangshu-reader）的同名指令碼，多一道檢查：node 要的庫既不在取下來的包裡、也不是系統庫就直接失敗 |

`app/src/main/assets/` 與 `app/src/main/jniLibs/` 是構建時生成的，不入庫。

## 構建

需要 Node 22+、JDK 17+、Android SDK（platform 34），以及 `curl` `dpkg-deb` `readelf` `python3`。在倉庫根目錄：

```bash
npm install
src/shells/android/scripts/build.sh            # debug 包：app/build/outputs/apk/debug/app-debug.apk
src/shells/android/scripts/build.sh release    # 設了 NOVELFORGE_KEYSTORE（路徑）/ NOVELFORGE_KEYSTORE_PASSWORD / NOVELFORGE_KEY_ALIAS（預設 novelforge，沿用舊名：簽名與 CI secret 不改）就用發版金鑰籤
```

日常在 CI 上編：Google 的 aapt2 只出 x86_64，arm64 的開發機要編得改用 Debian 13 的 `aapt` 包，並在 `~/.gradle/gradle.properties` 裡設 `android.aapt2FromMavenOverride`。

- `.github/workflows/android.yml`：手動點出包（artifact `android`），發版時 `release.yml` 調它，附件名 `Novelwarden-<版本>-android-arm64.apk`。
- 兩種都用發版金鑰簽名（倉庫 secrets `NOVELFORGE_KEYSTORE_BASE64` / `NOVELFORGE_KEYSTORE_PASSWORD`，別名 `novelforge`），
  手動點出來的包和 Release 裡的可以互相覆蓋安裝。CI 上的 debug 簽名每次構建都是新生成的一把，用它的話每試一次都得先解除安裝、
  app 私有目錄裡的配置與 API Key 跟著沒了，所以只在手動點又沒有金鑰時退回它；**發版時缺金鑰整個 Release 停下**。
- 金鑰本體（`release.jks` 與口令）在 uniagent 的 `~/.config/novelforge-android/`，隨 oracle 的 `~/apps` 每週進 unraid 備份；
  GitHub secrets 只寫不可讀，那裡是唯一能取回的副本。丟了就沒法給已裝的人發升級包。

版本號取自倉庫根 `package.json`（`0.2.8` → versionCode 208），`tests/contract/version.test.js` 守著。

## 執行時

內建服務這樣起（`LocalServer.start`）：

```
libnode.so --use-bundled-ca --disable-warning=ExperimentalWarning files/server/server.cjs --port <埠> --no-open
```

| 環境變數 | 值 | 為什麼 |
|---|---|---|
| `HOME` | 放書的目錄 | 「新建一本書」的預設位置、「開啟資料夾」的起點都是家目錄 |
| `NOVELWARDEN_HOME` | `files/novelforge`（app 私有；舊名 `NOVELFORGE_HOME` 仍認） | 配置與 API Key 不能跟著家目錄落到別的 app 也讀得到的公共目錄（`src/core/stores.ts`） |
| `NOVELWARDEN_TOKEN` | 每臺裝置隨機 48 位 hex，存在 SharedPreferences（舊名 `NOVELFORGE_TOKEN` 仍認） | 手機上任何 app 都能連回環地址，包括 `/mcp` |
| `LD_LIBRARY_PATH` | `nativeLibraryDir` | node 依賴的 `libssl_3.so` 等都在那裡 |
| `TMPDIR` / `TZ` | 快取目錄 / 系統時區 | node 在 Android 上取不到這兩樣 |

埠先試 36800（獨立版的預設），被佔就隨機。node 的輸出進 logcat（tag `NovelForgeServer`）與 `files/server.log`（只留本次）。

## 設計取捨

- **為什麼是 node 不是 Bun**：Bun 不出 Android 的構建，bionic 也跑不了 glibc 的二進位制。獨立版只有監聽那一層用到 Bun
  （`Bun.serve`），收在 `standalone/serve.ts` 裡，沒有 Bun 時走 `standalone/nodeServe.ts`（`node:http` + `ws`）；
  SQLite 本來就有 `node:sqlite` 兜底。Termux 的 nodejs-lts 是 24，自帶 `node:sqlite`。
- **為什麼頁面不打進 APK**：頁面本來就由服務端吐，兩種模式都只是開啟一個網址；打進 APK 反而要和遠端那臺的版本對齊。
  代價是服務端設定只能做成原生對話方塊（遠端那臺的頁面不認識這個殼），入口是返回鍵：先問頁面 `window.nfBack()`（`media/src/view/mobileNav.ts`）
  收掉最上面一層（選單、彈窗、蓋在側欄上的正文），頁面說沒什麼可收了、或者開著的是殼自己的提示頁，才彈「服務端設定… / 退出」。
- **書放在哪**：node 只認檔案路徑、不認 `content://`，所以放公共目錄要「所有檔案訪問」（Android 11+）或寫儲存許可權（10 及以下，
  靠 `requestLegacyExternalStorage`）。第一次用本機模式時問一次，不給就放 `Android/data/<包名>/files/books`（解除安裝時一起刪）。
  換了位置（之後才授權）服務會以新的家目錄重起，最近開啟的書記的是絕對路徑，照樣打得開。
- **前臺服務**：寫一章要幾分鐘，切到別的 app 時系統會把後臺 app 連同它起的子程序一起凍住（Android 11+ 的 cached apps freezer），
  模型的流斷在半路。有前臺服務的 app 不算後臺。只在本機模式起；從最近任務裡劃掉 app 時連同 node 一起收掉。
- **令牌只走登入頁**：殼不自己算 cookie（那是 `standalone/auth.ts` 的事），用 `postUrl` 交令牌，cookie 由服務端種。
- **系統欄跟頁面主題**：頁面換主題時把 `<meta name="theme-color">` 改成標題欄底色（`media/src/editor/shell.ts`），
  殼在頁面載入完時注入一段 MutationObserver 盯住它，經 `addJavascriptInterface` 的 `NovelForgeShell.setBarColor` 染狀態列與導航欄、
  按深淺換圖示顏色，並記下來供下次啟動先用。這個口子只能換顏色，所以不怕頁面裡的 iframe 調到；沒有這個 meta 的舊服務端照舊跟系統深淺色。

## 限制與待實機驗證

- 只支援 arm64 手機，Android 8 起。APK 估計 40 MB 上下（node 與 ICU 資料佔大頭，解壓後 90 MB）。
- 頁面按觸屏適配過（2026-10-24，Android 13 的 redroid 裡實機走過一遍，做法見 [media/README.md「觸屏與窄屏」](../../../media/README.md#觸屏與窄屏手機android-殼)）：
  長按出右鍵選單（WebView 長按會發 `contextmenu`，已實機確認）、選單整個落在螢幕裡、長按不選中介面上的字、軟鍵盤彈出時
  輸入框與游標那一行露得出來、名詞 / 細綱 / 失敗原因 / 敘事線總覽的浮窗手指點或長按看得到。仍然看不到的：幾處原生
  `title=` 提示（行上的小圓點、時間線卡片上的完整日期）。「在外部開啟」（`xdg-open`）在手機上什麼都不做，觸屏上不顯示這一項。
- 返回鍵先收頁面裡的層（2026-10-31）：只在無頭瀏覽器與 jsdom 裡驗過 `nfBack()`，殼這一側（`evaluateJavascript` 回呼）沒在真機上走過。
- redroid 裡沒有觸屏裝置，WebView 報的是 `(pointer: none)` 而不是 `(pointer: coarse)`；放大點選目標的樣式兩種都認，
  真手機上的 `coarse` 還沒實測。
- Android 12+ 有 phantom process killer：後臺子程序吃 CPU 多了會被殺。node 大部分時間在等模型的網路流，待實機確認。
