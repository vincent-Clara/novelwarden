/**
 * Novelwarden 這套工具，按**它動的是什麼**分：
 *
 * | 工具 | 管什麼 |
 * |---|---|
 * | `list` / `read` / `search` | 查：看目錄、讀檔案、全文搜 |
 * | `generate` | 為某一份產物調一次創作模型（架構 / 大綱 / 細綱 / 正文） |
 * | `write` / `edit` | 落盤：寫一份檔案、改一段文字 |
 * | `pipeline` | 流水線批次：補齊架構、批次拆細綱、批次寫章、新建細綱骨架 |
 * | `summary` | 定稿與全文大綱 |
 * | `characters` | 角色卡 |
 * | `extract` | 提煉：文風、設定、敘事線 |
 * | `book` | 拆書：匯入原稿、從已寫正文補齊、從參考書學寫法 |
 * | `skills` | 寫作技能 |
 *
 * 前六個是**薄包裝**：`Workspace` 的讀寫閘道器、`generation.generate` 的一次單步。這一層真正的活是
 * 把返回值壓成模型讀得動的形狀——`generate` 產出的是三千字正文，模型該拿到的只有「已生成，
 * 620 字，draftId d-3f2a」。後六個是工程頁按鈕的口子（[actions.ts](actions.ts)），每個動作就是
 * 那顆按鈕背後的同一個函式，確認框照彈。
 *
 * ## 怎麼分才算合理
 *
 * 一個工具的引數就是它的全部用法：每個引數都對這個工具的大多數動作有意義，模型不必記「哪個動作
 * 認哪個引數」。工具之間按作者心裡的那幾塊分（流水線、定稿、角色、技能……），與工程頁上按鈕的
 * 分組一致。加動作先想它屬於哪一塊；只有哪一塊都不像、引數也合不進去時才新開一個工具。
 *
 * ## 明確不給的
 *
 * **刪除、改名、移動。** `workspace` 上有 `remove` / `move`，但不暴露：收益接近零（作者要刪東西
 * 會自己刪），而一次誤操作的收拾成本極高——章節改名會連帶搬走草稿，刪除即使進了 `.trash/`
 * 作者也未必知道它刪過什麼。同理沒有 `bash`、沒有工程根之外的路徑、沒有裸 `fs`、沒有初始化工程、
 * 沒有解除安裝技能（AGENTS 第 25 條）。**審稿與修稿也不給**：報告要作者勾選之後才修稿，他在對話頁自己做。
 */
import type { ToolDef, ToolEnv } from '../types';
import { ToolRegistry } from '../registry';
import { bookTool } from './book';
import { charactersTool } from './characters';
import { editTool } from './edit';
import { extractTool } from './extract';
import { generateTool } from './generate';
import { listTool } from './list';
import { loreTool } from './lore';
import { pipelineTool } from './pipeline';
import { readTool } from './read';
import { searchTool } from './search';
import { skillsTool } from './skills';
import { summaryTool } from './summary';
import { writeTool } from './write';

export {
  bookTool,
  charactersTool,
  editTool,
  extractTool,
  generateTool,
  listTool,
  loreTool,
  pipelineTool,
  readTool,
  searchTool,
  skillsTool,
  summaryTool,
  writeTool,
};

/**
 * 全部工具。**順序即模型看到的順序**：讀在前、生成居中、寫在後、工程動作最後，讓它先形成
 * 「先看一眼再動手」的路徑。
 */
export const NOVEL_TOOLS: ToolDef[] = [
  listTool,
  readTool,
  searchTool,
  generateTool,
  writeTool,
  editTool,
  pipelineTool,
  summaryTool,
  charactersTool,
  loreTool,
  extractTool,
  bookTool,
  skillsTool,
];

/** 綁一份環境，得到一個能被呼叫的工具集。呼叫方（MCP 的執行端）只要一份 `ToolEnv`。 */
export function createNovelTools(env: ToolEnv, defs: ToolDef[] = NOVEL_TOOLS): ToolRegistry {
  return new ToolRegistry(defs, env);
}
