/**
 * 臨時工程的收尾。
 *
 * **必須先關庫再刪目錄**：SQLite 連線開著時 Windows 上刪不掉
 * `.novelwarden/novelwarden.db`，臨時工程會全留在 temp 裡（EBUSY）。遷移前這條只有
 * 兩個指令碼做對，另有一個指令碼從不刪目錄——每跑一次洩漏一個臨時工程。
 */
const fs = require('fs');

/**
 * 關庫（如果這組測試碰過庫）再刪目錄。兩步都不拋：收尾失敗不該蓋掉真正的失敗原因。
 * @param {string} dir 臨時目錄
 * @param {{ resetDatabases?: () => void }} [db] 載入的 `src/core/runtime/db.ts`，沒碰過庫就不用傳
 */
function cleanup(dir, db) {
  if (db && typeof db.resetDatabases === 'function') {
    try {
      db.resetDatabases();
    } catch {
      /* 關不掉也要接著刪 */
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 刪不掉就算了，不要蓋掉真正的失敗 */
  }
}

module.exports = { cleanup };
