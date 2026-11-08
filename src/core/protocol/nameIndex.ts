/**
 * 內建編輯器「名詞補全」（獨立版，角色名 / 地名……）要的那份名詞表。
 *
 * 前端發 `requestNameIndex`（帶 `requestId`，以及手上那一份的 `sig`），後端回 `nameIndex`（同一個 `requestId`）——
 * **按需要，不常駐推送**：只有作者按了補全鍵、或開著「邊打邊彈」在打字時才要；手上那份沒變（`sig` 對得上）就只回
 * 一個 `sig`、不帶表，幾百張卡的書也只是幾十個位元組。
 *
 * 構建見 `views/nameIndex.ts`（讀了哪些盤寫在那裡），匹配與排序是前端的純函式（`media/src/editor/namesCore.ts`）。
 */

/** 這個名詞從哪來。 */
export type NameSource = 'character' | 'lore' | 'unfiled';

/** 一個名詞（一張角色卡、一條設定，或名錄裡出現過、還沒建條目的一個名字）。 */
export interface NameEntry {
  /** 正名：角色卡的名字、設定條目的標題、未建條目的名字。 */
  name: string;
  /**
   * 別的叫法：角色卡的別名（外加名字裡括號內外各一截，`林昭（阿昭）` 認 `林昭` 與 `阿昭`），設定條目的關鍵詞。
   * 不含正名本身，去重、去空白。未建條目沒有。
   */
  aliases: string[];
  source: NameSource;
  /**
   * 型別：設定是它的分類（所在目錄相對 `lore/` 的路徑，`地點`、`宗門/正道`；根目錄下是空串），未建條目是名錄給的建議
   * 分類（各章 `〔分類〕` 的多數票，沒寫過是空串）。角色卡是空串（前端寫「角色」）。
   */
  category: string;
  /**
   * 一句話：卡或條目裡現成的那一句。設定取 `loreBrief`（frontmatter 的 `brief`，沒寫就是正文第一句）；角色卡取
   * 「身份」那一節的第一句，沒寫就是標籤；未建條目取最近一章「設定」一節冒號後面那句。都沒有是空串。
   */
  brief: string;
  /** 卡或條目的路徑。未建條目沒有檔案，缺席。 */
  path?: string;
}

export interface NameIndex {
  /** 還不是小說工程（沒有 `.novelwarden/project.json`）時為 false，`names` 是空的。 */
  initialized: boolean;
  /** 角色卡在前（按名字），其次設定條目，最後是未建條目（按出現章數降序）。 */
  names: NameEntry[];
}
