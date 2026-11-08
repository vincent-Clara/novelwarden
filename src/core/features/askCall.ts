/**
 * 調模型之前的那一問（第 4 條的確認框）：按鈕之外，讓作者為**這一次**挑模型與上下文詳細度
 * （docs/design/plans/2026-10-20-call-choice.md）。
 *
 * 每個調模型之前的確認框都經這裡問，於是兩個下拉框的選項、預設與「按分檔時每項活交給誰」只拼一處。
 * 問完的活由呼叫方跑在 `withCallChoice(answer.choice, …)` 裡（runtime/callScope.ts）——**確認框之前讀的
 * `config` 不能帶進去**，作者的選擇在那之後才有。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { CallAnswer, CallChoice, describeCallChoice } from '../model/callChoice';
import { listModelChoices } from '../model/providers';
import { describeTaskModels, LlmTask } from '../model/tiers';
import { scoped } from '../runtime/logger';

const log = scoped('確認框');

export interface CallAsk {
  message: string;
  actions: string[];
  /** 補充說明：調幾次、跳過哪些、會改什麼。這活交給哪個模型不必寫——下拉框下面列著。 */
  detail?: string;
  /** 這一次會用到的任務：「按分檔」下面逐項列它們各交給誰。 */
  tasks: LlmTask[];
  /** 這一次的上下文看不看詳細度。不看就不給作者那個下拉框——調了也白調。 */
  contextDetail: boolean;
  /**
   * 開啟時的預設。缺席取當前這一次（巢狀的那一問跟著外面那一次），再缺席取設定。
   * 工程頁表單已經問過、後端還要再問一次時（批次寫章補建角色卡）傳表單上的選擇。
   */
  preset?: CallChoice;
}

export async function askCall(ask: CallAsk): Promise<CallAnswer | undefined> {
  const host = getHost();
  const config = readConfig();
  // 「按分檔」那幾行說的是不釘模型時誰幹活：外面那一次釘了模型也照分檔說。
  const tiered = { ...config, pinnedModel: undefined };
  // 轉寫不跟這一次挑的模型走（model/tiers.ts），單列一行、一直顯示。
  const tasks = [...new Set(ask.tasks)];
  const fixed = tasks.filter((task) => task === 'transcribe').map((task) => `${describeTaskModels(tiered, task)}（不跟這一次挑的模型）`);
  const answer = await host.confirmCall(ask.message, ask.actions, {
    detail: ask.detail,
    call: {
      models: listModelChoices(config.providers, host.supportsVscodeLm).map(({ ref, label, group }) => ({ ref, label, group })),
      model: ask.preset ? (ask.preset.model ?? '') : (config.pinnedModel ?? ''),
      tiers: tasks.filter((task) => task !== 'transcribe').map((task) => describeTaskModels(tiered, task)),
      ...(fixed.length > 0 ? { fixed } : {}),
      ...(ask.contextDetail ? { contextDetail: ask.preset?.contextDetail ?? config.contextDetail } : {}),
    },
  });
  if (answer) {
    log.info(`${answer.action}：${describeCallChoice(answer.choice)}`);
  }
  return answer;
}
