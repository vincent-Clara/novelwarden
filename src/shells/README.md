# shells — 四個宿主殼

同一份 [core/](../core/README.md) 裝在四個殼裡：VS Code 外掛、獨立 Web 服務、桌面 app、Android app。
並排放在這裡，不再一個在 `src/` 下、一個在倉庫根上。

| 殼 | 是什麼 | README |
|---|---|---|
| [vscode/](vscode/README.md) | VS Code 外掛：命令、兩個 webview 宿主、vscode-lm | [vscode/README.md](vscode/README.md) |
| [standalone/](standalone/README.md) | 獨立 Web 服務（Bun；沒有 Bun 時跑在 node 上）：HTTP/WS + 瀏覽器介面；工程可空、執行時熱換 | [standalone/README.md](standalone/README.md) |
| [desktop/](desktop/README.md) | 桌面 app（Tauri / Rust）：把獨立版當 sidecar 裝進一個視窗 | [desktop/README.md](desktop/README.md) |
| [android/](android/README.md) | Android app（Java / WebView）：本機模式把獨立版打成 node 單檔案當子程序起，遠端模式連已部署的服務 | [android/README.md](android/README.md) |
| [shared/](shared/panes.ts) | 兩個以上殼共用的頁面骨架（**所有 pane 的 DOM 唯一來源**） | 見下 |

## 殼的契約

殼只做三件事：

1. **實現 `Host`** —— 把 [core/host.ts](../core/host.ts) 的窄介面接到平臺能力上（彈窗、進度、檔案監聽、開啟檔案）。
2. **傳輸與生命週期** —— 程序入口、訊息通道、視窗/檢視掛載、退出收屍。
3. **平臺專屬入口** —— 命令、選單、CLI 引數、原生對話方塊。

殼**不做**這三件：

- **業務邏輯。** 一個動作要問什麼、算什麼、寫什麼，都在 core 裡；殼只負責把它接到一個按鈕或一條命令上。
  同一個流程絕不允許在兩個殼裡各寫一遍——`initProjectFlow`（[core/actions.ts](../core/actions.ts)）
  同時服務外掛命令、網頁按鈕與 CLI `init`，就是這一條的樣板。
- **頁面內容。** DOM 與文案屬於前端，不屬於宿主。被兩個以上殼用到的結構必須放
  [shared/panes.ts](shared/panes.ts)；只有一個殼用到的可以留在那個殼裡，但**仍然不許出現第二份**。
  殼負責的只是佈局外殼（外掛是 tabbar 直排，獨立版是標題欄＋活動欄＋側欄＋編輯器）與 head/CSP/資源 URL。
- **「我是哪個殼」的分支。** 差異一律表達成「宿主有沒有這個能力」：`Host` 上的可選方法
  （`openInEditor` / `reviewReplace` / `openNativeSettings` …），或渲染期的選項
  （`settingsPane({ nativeSettings })`）。`Host.name` 只用於日誌與診斷。
  為什麼這條最要緊：按身份分支會腐爛。曾經 core 裡有一句 `host.name === 'standalone'` 決定設定頁
  那行儲存說明該怎麼寫，後來兩個殼都換成了 `FileConfigStore`，而外掛形態那半邊分支沒人想起來改，
  於是外掛的設定頁在很長一段時間裡都在說一句已經不成立的話（「設定寫入工作區 settings.json」）。
  能力式表達沒有這個失效模式：沒有那個能力，那段介面根本不會被渲染出來。

`media/` 裡的前端也遵守同一條：區分形態用能力探測（`#wbEditor` 存不存在、`maybeById` 取不到就跳過），
不判斷環境字串。

## 為什麼共享的頁面骨架在這裡，而不在 media/

`media/` 是**瀏覽器**產物（esbuild `platform: browser`，自己一份 tsconfig 帶 DOM lib）。
頁面骨架是宿主在 Node / Bun 裡拼出來的字串，跑在服務端那一側，所以它歸殼這一層。
頁頭的任務條（`taskBar()`，四期 W8）也在這裡：兩個殼各自把它放在頁籤之上的那一處——外掛在標籤欄下面、獨立版在側欄頂上——位置不同是佈局外殼的事，DOM 仍只有這一份。

`shared/panes.ts` 因此是零 import 的純字串函式：不碰 `vscode`、不碰 `node:`、不碰 `bun:`
——這條由 [tests/contract/shellPurity.test.js](../../tests/contract/shellPurity.test.js) 守著。

## 依賴方向

```
core/  ←  shells/shared/  ←  shells/vscode/
                          ←  shells/standalone/  ←  shells/desktop/（當 sidecar 起它，不 import）
                                                 ←  shells/android/（打成 node 單檔案當子程序起，不 import）
```

反向依賴不允許（core 不認識任何殼），**殼與殼之間也不許互相 import**——桌面殼與 Android 殼複用獨立版靠的是
「把它當子程序起起來」，不是程式碼耦合。同樣由 `shellPurity.test.js` 守著。
