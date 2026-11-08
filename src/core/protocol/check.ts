/**
 * 內建編輯器「寫作體檢」要的那份詞表（`checkTerms` 訊息）。**後端算好推給編輯器**，編輯器按正文實時匹配——
 * 詞從哪來、怎麼認只在後端定一次，前端不讀 `style.md` / `config.md`，也不解析敏感詞表。
 *
 * - 隨 `init` 推一次；之後每次 `pushState`（檔案監聽、儲存、工程頁動作）都現算一份，**內容變了才推**（與
 *   `chapterIndex` 同一個做法）——`style.md`、`config.md`、`sensitive.txt` 改了（新建、改、刪）就會重推。
 * - 只給有內建編輯器的宿主推（`Host.openInEditor` 這個能力；外掛那邊開啟的是 VS Code 自己的編輯器，用不上）。
 * - 比喻詞與拉丁縮寫不在這裡：它們不隨書變（`model/manuscriptCheck.ts` 的 `SIMILE_WORDS` / `SIMILE_LIMIT` /
 *   `latinAcronymRanges`），編輯器直接打包那一份。
 *
 * 構建見 `views/checkTerms.ts`。
 */

/** 敏感詞表裡的一個詞。 */
export interface CheckSensitiveTerm {
  term: string;
  /** 建議的替換詞（`詞 => 替換詞`）。沒寫就是隻標出來。 */
  replacement?: string;
}

export interface CheckTermsView {
  /**
   * 這本書寫正文時不該用的詞：`style.md` 的「禁用詞表」、小說配置「全域要求」裡禁止的詞、古代題材的現代說法。
   * **與寫正文時寫完數一遍的是同一份**（`views/checkTerms.ts` 的 `readBannedTerms`，`generate.ts` 也調它）。
   */
  banned: string[];
  /** 自定義敏感詞表（`.novelwarden/sensitive.txt`）。檔案不在時是空的。 */
  sensitive: CheckSensitiveTerm[];
  /** 敏感詞表在工程裡的相對路徑（「編輯敏感詞表…」開啟的就是它）。 */
  sensitivePath: string;
  /** 敏感詞表這份檔案在不在。 */
  sensitiveExists: boolean;
  /** 敏感詞表裡沒看懂、跳過的行（1 起）與原因。 */
  sensitiveBad: { line: number; reason: string }[];
}
