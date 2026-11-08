/**
 * 調模型之前那一問裡的兩個下拉框：作者為**這一次**挑模型與上下文詳細度，不寫回設定
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * 宿主怎麼問見 `Host.confirmCall`，core 只經 `features/askCall.ts` 問；挑完的活跑在
 * `runtime/callScope.ts` 的 `withCallChoice` 裡，`readConfig()` 在那裡面讀到的就是這一份。
 *
 * 純資料 + 純函式，只 import 同樣零 import 的 `contextDetail.ts`：經 `media/src/protocol.ts` 打進瀏覽器產物，
 * 下拉框上的字與日誌、VS Code 模態框裡的那一行是同一份。
 */
import { CONTEXT_DETAIL_LABEL, ContextDetail, isContextDetail } from './contextDetail';

/** 作者為這一次挑的。缺席的那一項沿用外面那一次，再缺席沿用設定。 */
export interface CallChoice {
  /** 只用這一個模型（不換人）。缺席 = 按分檔。 */
  model?: string;
  contextDetail?: ContextDetail;
}

/** 確認框上的兩個下拉框：選項與開啟時選著哪個。 */
export interface CallPrompt {
  /** 可選的模型，與對話頁下拉框同一份（按服務商分組）。「按分檔」不在這裡，由介面放在第一項。 */
  models: { ref: string; label: string; group: string }[];
  /** 開啟時選著的模型；`''` = 按分檔。 */
  model: string;
  /** 按分檔時這幾項活各交給誰（`describeTaskModels`），一行一項。選了具體模型就不必看。 */
  tiers: string[];
  /** 不管這一次挑哪個模型都照檔走的活（眼下只有轉寫），一行一項，一直顯示。 */
  fixed?: string[];
  /** 開啟時的級別。缺席 = 這一次的上下文不看詳細度，不顯示那個下拉框。 */
  contextDetail?: ContextDetail;
}

/** 確認框的回答：點的哪顆按鈕，加上作者的選擇。 */
export interface CallAnswer {
  action: string;
  choice: CallChoice;
}

/** 模型下拉框的第一項：不指定模型，各項活按任務檔位走。 */
export const TIERED_LABEL = '按分檔';

/** 「只用 openrouter/x · 上下文詳細度「精簡」」：日誌與 VS Code 模態框裡那一行。 */
export function describeCallChoice(choice: CallChoice): string {
  const model = choice.model ? `只用 ${choice.model}（失敗不換人）` : TIERED_LABEL;
  return choice.contextDetail ? `${model} · 上下文詳細度「${CONTEXT_DETAIL_LABEL[choice.contextDetail]}」` : model;
}

/**
 * 前端交上來的選擇（工程頁表單的 `projectAction.call`、網頁彈窗的 `promptResult.choice`）的容錯讀取：
 * 不是物件 = 沒有（表單沒問過）；認不出的那一項丟掉，沿用設定。
 */
export function normalizeCallChoice(raw: unknown): CallChoice | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { model, contextDetail } = raw as Record<string, unknown>;
  return {
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(isContextDetail(contextDetail) ? { contextDetail } : {}),
  };
}
