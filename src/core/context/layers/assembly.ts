import { NovelProject } from '../../model/project';
import type { ContextDetail, ContextLimits } from '../../model/contextDetail';
import { BookConfig } from '../../model/settingFile';
import { NovelConfig } from '../../model/types';
import { BuildRequest, ContextItem, LayerSpec } from '../types';
import type { Focus } from './focus';

/** 各層共享的可變狀態。預算是一條流水線上的餘額，層按配方順序扣。 */
export interface Assembly {
  readonly project: NovelProject;
  readonly request: BuildRequest;
  readonly config: NovelConfig;
  /** 這一次按哪一級裝（上下文詳細度）。說明文字裡點名用。 */
  readonly detail: ContextDetail;
  /** 這一級的各項上限（`contextLimitsOf(config)`，已疊上測試的單項覆蓋）。層只從這裡取。 */
  readonly limits: ContextLimits;
  readonly focus: Focus;
  /** 磁碟上那份 `config.md`：規模、型別、結構。提示詞與結構指導都要它，只讀一次。 */
  readonly book: BookConfig;
  readonly budget: number;
  /** 剩餘預算。**層可以直接改它**——降級路徑需要自己算完再扣。 */
  remaining: number;
  readonly items: ContextItem[];
  readonly excluded: ReadonlySet<string>;
  /** 常規注入：算 token、判餘額、登記。放不下就記為 dropped。 */
  admit(item: Omit<ContextItem, 'tokens' | 'status'>, opts?: { force?: boolean }): ContextItem;
  /** 已自行算好 token 的條目（降級路徑）：登記並扣餘額。 */
  accept(item: Omit<ContextItem, 'tokens'>, tokens: number): void;
  /** 裝不下 / 被排除：登記原因，不扣餘額。**絕不靜默丟棄。** */
  reject(item: Omit<ContextItem, 'tokens' | 'status'>, status: 'dropped' | 'excluded', note: string): void;
  /**
   * 跨層協調的便籤，只有三處用得上：上一章結尾與近章全文互斥、早前細綱跳過已經帶了全文的章、
   * 定稿原文片段與近章全文互斥（整章進來了，它的片段就多餘了）。
   */
  scratch: { prevTail?: ContextItem; evidence: Map<number, ContextItem> };
}

export type LayerFn = (a: Assembly, spec: LayerSpec) => Promise<void>;
