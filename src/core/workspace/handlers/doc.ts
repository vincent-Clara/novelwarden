/**
 * `doc` handler：純文字 + frontmatter，**沒有上游指紋**。
 *
 * 接 `style` / `globalSummary` / `threads` / `character` / `lore` 五種。
 *
 * 它們的共同點是**在指紋鏈之外**：
 *
 * - `style.md` / 角色卡 / 設定條目根本不在生產鏈上——它們是橫切的記憶與
 *   約束，被裝配進 prompt，但不由某一層產物「生出來」。
 * - `summaries/global.md` 的上游是全部定稿過的細綱，那是一次顯式的重建動作
 *   （features/summarize.ts 的 `through` 水位線），不是 hash 傳播。
 * - 敘事線（`threads/<線名>.md`，一條線一個檔案）由排線與定稿寫（機器只追加、當前進度有指紋守著，
 *   見 model/threadFile.ts），是跨章的計劃與記錄，同樣不在鏈上。
 *
 * 它們都沒有對應的結構化產物，只走 `{text}` 那條路，所以這裡什麼都不用做。情節大綱從前也在這裡（把 `outlineDoc`
 * 渲染成 `outline.md`）；現在它沒有檔案，是各章細綱梗概的彙總，讀寫由閘道器自己接住（`Workspace.writeOutline`），
 * 不經任何 handler。
 */
import { Handler } from './types';

export const docHandler: Handler = {};
