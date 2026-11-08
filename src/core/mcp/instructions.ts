/**
 * MCP 那一頭的說明：`initialize` 回給客戶端的 `instructions`。宿主把它放進外部 agent 的
 * 上下文，**只說怎麼用這幾個工具**——領域知識（細綱寫到什麼程度、看點怎麼留）在
 * `context/prompts.ts`，由 `generate` 內部那次呼叫自己帶著，這裡不寫第二份。
 */
export const MCP_INSTRUCTIONS = [
  'Novelwarden 是作者本人的小說創作工具。這幾個工具讀寫的是他此刻在 Novelwarden 裡開啟的那個小說工程。',
  '',
  '- 工程就是一堆 Markdown：.novelwarden/ 下是架構（config.md / premise.md / world.md）、情節大綱（outline.md——磁碟上沒有這份檔案，它是各章細綱「梗概」的彙總，讀寫照樣認這個路徑，寫回時按章號拆進各章細綱）、' +
    '細綱（summaries/ 下，一章一份，與正文同樣的相對路徑，如 summaries/上部/003-夜访.md；同步會照正文改它）；正文在 chapters/（可以分子目錄）。先 list / read / search 看清楚再動手。',
  '- 要產出內容用 generate：它在 Novelwarden 內部按分階段裝配好的上下文調創作模型。正文直接流給作者看，**不會回到你這裡**；' +
    '作者在 Novelwarden 介面上點頭才落盤，結論寫在返回裡。不要自己拼一份內容用 write 代替 generate——創作質量來自那一層的裝配。',
  '- 連續多章（補架構、排細綱、寫正文）用 pipeline 的批次動作，不要迴圈調 generate；同步與全文大綱在 summary，角色卡在 characters，' +
    '設定條目（記設定、建條目、整合）在 lore，文風 / 敘事線在 extract，匯入原稿與拆書在 book，寫作技能在 skills。這些是 Novelwarden 工程頁上那些按鈕，確認框照彈。',
  '- 工具結果末尾有時附一段「# 當前工程」：那是 Novelwarden 狀態機算出的下一步，與介面上的主按鈕是同一句話。' +
    '照它走，不要另做判斷；它變了才會再出現。',
  '- 覆蓋已有內容、改動寫作技能這類動作會在 Novelwarden 介面上請作者確認，等他回答之前工具呼叫不會返回。' +
    '作者拒絕了就別重試同一個動作，問問他想怎麼改。',
  '- 沒有刪除、改名、移動，也不做審稿與修稿——那些由作者自己在 Novelwarden 裡做。',
].join('\n');
