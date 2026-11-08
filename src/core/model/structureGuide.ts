/**
 * 故事結構指導：按總章數把六種結構切成章號區間，寫情節大綱時注入。
 *
 * **純函式、零 I/O**。思路與三幕、起承轉合、多線、自由四種的寫法來自 AI-Novel-Writer
 * （GPL-3.0，源自 AI_NovelGenerator）的 `getPlotStructureGuide`
 * （`src/services/workflows/architecture-workflow.ts:226-284`）。
 *
 * ## 為什麼每一段都要有章號
 *
 * 大綱要寫「結構拐點」，而拐點落在第幾章決定了節奏：一百章的書把中點放在第 30 章，
 * 後七十章就只剩收尾。不給章號，模型會按它熟悉的篇幅（多半是一部電影）去排，
 * 寫出來的大綱與總章數對不上。
 *
 * **上游的缺口**：英雄之旅與節拍表只有一行「全書共 N 章...」的佔位，沒有任何區間
 * （`architecture-workflow.ts:238-241`）。這裡六種都用同一個分配函式按累計百分比切，
 * 十二階段與十五拍的百分比取常見的寫法（Vogler、Blake Snyder），不是精確科學，
 * 只是讓每一段落在一個說得過去的位置上。
 *
 * ## 大綱是分批寫的
 *
 * 超過 20 章的書先只寫第 1–20 章（D20）。結構指導仍然給**全書**的切分——模型要知道
 * 這 20 章在整本書裡是第一幕的開頭還是全部——再用 {@link structureStagesIn} 點明
 * 本批落在哪幾段。
 */
import { NARRATIVE_POV_LABEL, NarrativePov, PLOT_STRUCTURE_LABEL, PlotStructure } from './settingFile';

/** 結構裡的一段（一幕 / 一個階段 / 一拍），帶章號區間（閉區間）。 */
export interface StructureStage {
  name: string;
  /** 這一段要完成什麼。 */
  hint: string;
  from: number;
  to: number;
}

interface StageSpec {
  name: string;
  hint: string;
  /** 這一段結束時，全書寫到了百分之幾（累計，0..1；最後一段必須是 1）。 */
  end: number;
}

const SPECS: Record<PlotStructure, StageSpec[]> = {
  three_act: [
    { name: '第一幕 · 建置', hint: '立起主角、世界與開局困境，拋出打破平衡的事件', end: 0.2 },
    { name: '第二幕 · 對抗與發展', hint: '目標確立、阻力層層升級，中段有一次改變局勢的轉折', end: 0.75 },
    { name: '第三幕 · 高潮與結局', hint: '最大危機爆發，主角付出代價做出選擇，收束主線', end: 1 },
  ],
  heros_journey: [
    { name: '平凡世界', hint: '主角的日常、缺憾與處境', end: 0.05 },
    { name: '冒險召喚', hint: '打破日常的事件，指出一條非走不可的路', end: 0.1 },
    { name: '拒絕召喚', hint: '恐懼、牽掛或代價讓主角遲疑', end: 0.13 },
    { name: '遇見導師', hint: '獲得指點、工具或信念', end: 0.18 },
    { name: '跨越第一道門檻', hint: '主動踏進陌生的世界，退路斷了', end: 0.25 },
    { name: '考驗、盟友與敵人', hint: '在新世界裡立足，結識同伴與對手，學會規則', end: 0.4 },
    { name: '接近最深的洞穴', hint: '逼近核心危險，計劃與準備', end: 0.5 },
    { name: '磨難', hint: '最大的考驗，幾乎失去一切', end: 0.6 },
    { name: '獎賞', hint: '熬過磨難，得到想要的東西或真相', end: 0.7 },
    { name: '歸途', hint: '帶著所得往回走，追兵與後果隨之而來', end: 0.8 },
    { name: '復活', hint: '最終決戰，主角完成蛻變', end: 0.92 },
    { name: '攜寶歸來', hint: '回到起點，世界因他而變', end: 1 },
  ],
  save_the_cat: [
    { name: '開場畫面', hint: '一個定調的畫面，顯出主角的「之前」', end: 0.01 },
    { name: '主題呈現', hint: '有人點出主角要學會的那件事', end: 0.05 },
    { name: '鋪墊', hint: '主角的世界、缺陷與身邊人', end: 0.1 },
    { name: '催化劑', hint: '改變命運的事件發生', end: 0.12 },
    { name: '猶豫', hint: '要不要走出去', end: 0.2 },
    { name: '進入第二幕', hint: '主角主動選擇踏進新局面', end: 0.22 },
    { name: 'B 故事', hint: '引出承載主題的副線與人物', end: 0.25 },
    { name: '遊戲時間', hint: '兌現賣點：新世界裡的爽點與樂趣', end: 0.5 },
    { name: '中點', hint: '虛假的勝利或失敗，賭注抬高', end: 0.52 },
    { name: '壞人逼近', hint: '外部壓力與內部裂痕同時收緊', end: 0.72 },
    { name: '一無所有', hint: '跌到谷底，失去最重要的東西', end: 0.75 },
    { name: '靈魂黑夜', hint: '消化失敗，想明白真正要的是什麼', end: 0.8 },
    { name: '進入第三幕', hint: '找到解法，帶著新認識出發', end: 0.82 },
    { name: '終局', hint: '執行計劃、最終對決，主副線合一', end: 0.98 },
    { name: '終場畫面', hint: '與開場畫面對照，顯出主角的「之後」', end: 1 },
  ],
  kishotenketsu: [
    { name: '起', hint: '介紹世界、角色和日常，建立讀者認同', end: 0.25 },
    { name: '承', hint: '延續與深化，展現角色關係和衝突苗頭', end: 0.5 },
    { name: '轉', hint: '核心轉折，出人意料的變化打破既有格局', end: 0.75 },
    { name: '合', hint: '收束所有線索，揭示主題，給出結局', end: 1 },
  ],
  multi_thread: [
    { name: '各線鋪開', hint: '2–4 條獨立又交織的故事線各自立起主角或視角', end: 0.25 },
    { name: '第一次交匯之後', hint: '在本段開頭安排各線的第一次碰撞，之後交替推進，別讓哪條線長期消失', end: 0.5 },
    { name: '第二次交匯之後', hint: '再一次交匯，衝突升級，各線的代價開始相互傳導', end: 0.75 },
    { name: '合流與終局', hint: '所有線索開始匯聚，走向統一高潮', end: 1 },
  ],
  freeform: [
    { name: '開篇建置', hint: '清晰地立起人物、世界與核心問題', end: 0.12 },
    { name: '中段', hint: '按內容自由編排，每 10–20 章一個小高潮或懸念釋放點，適時安排轉折，避免節奏單一', end: 0.88 },
    { name: '收尾', hint: '回收伏筆，給出結局', end: 1 },
  ],
};

/** 每種結構開頭那一句「怎麼用它」。 */
const LEAD: Record<PlotStructure, string> = {
  three_act: '嚴格按以下結構組織大綱',
  heros_journey: '嚴格按以下階段組織大綱',
  save_the_cat: '嚴格按以下節拍組織大綱',
  kishotenketsu: '嚴格按以下四段組織大綱',
  multi_thread: '按多條故事線並行推進的方式組織大綱',
  freeform: '不限定特定敘事框架，根據故事內容自然編排；插敘、倒敘、片段式敘事只在服務於故事時使用',
};

/**
 * 按累計百分比把 1..total 切成連續的幾段。
 *
 * - 章數夠分時每段至少一章：第 i 段的終點取 `round(total × p_i)`，但不早於上一段終點 + 1，
 *   也不晚到讓後面幾段一章都分不到。
 * - 章數比段數還少（二十章寫十五拍）時允許相鄰幾段共用一章——不然只能丟掉幾拍，
 *   而那幾拍恰恰是結構本身。
 *
 * 兩種情形都保證連續、首章是 1、末章是 total。
 */
export function allocateStages(total: number, ends: readonly number[]): Array<{ from: number; to: number }> {
  const n = ends.length;
  const t = Math.max(1, Math.floor(total));
  const out: Array<{ from: number; to: number }> = [];
  if (n === 0) {
    return out;
  }
  if (t >= n) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const target = i === n - 1 ? t : Math.round(t * ends[i]);
      const to = Math.max(prev + 1, Math.min(target, t - (n - 1 - i)));
      out.push({ from: prev + 1, to });
      prev = to;
    }
    return out;
  }
  let prevTo = 0;
  for (let i = 0; i < n; i++) {
    const target = i === n - 1 ? t : Math.max(1, Math.round(t * ends[i]));
    const to = Math.max(prevTo, Math.min(target, t));
    const from = to > prevTo ? prevTo + 1 : Math.max(1, to);
    out.push({ from, to: Math.max(from, to) });
    prevTo = Math.max(prevTo, to);
  }
  return out;
}

/** 某種結構在這本書裡的切分。結構缺席時按三幕算（上游 `default` 分支同樣如此）。 */
export function structureStages(structure: PlotStructure | undefined, totalChapters: number): StructureStage[] {
  const specs = SPECS[structure ?? 'three_act'] ?? SPECS.three_act;
  const ranges = allocateStages(totalChapters, specs.map((s) => s.end));
  return specs.map((s, i) => ({ name: s.name, hint: s.hint, ...ranges[i] }));
}

/** 與 [from, to] 相交的那幾段——告訴模型本批落在結構的哪裡。 */
export function structureStagesIn(stages: readonly StructureStage[], range: { from: number; to: number }): StructureStage[] {
  return stages.filter((s) => s.from <= range.to && s.to >= range.from);
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

/**
 * 注入大綱層的那段指導文字。
 *
 * `range` 給了就在末尾點明「本次只寫哪幾章、它們落在哪幾段」；這一句比整張表更要緊：
 * 分批寫大綱時，模型最常見的錯是把第 1–20 章寫成全書的縮略版。
 */
export function structureGuideText(
  structure: PlotStructure | undefined,
  totalChapters: number,
  range?: { from: number; to: number }
): string {
  const key = structure ?? 'three_act';
  const stages = structureStages(key, totalChapters);
  const lines = [
    `【${PLOT_STRUCTURE_LABEL[key]}】（${LEAD[key]}）`,
    `全書共 ${totalChapters} 章，建議章節分配：`,
    ...stages.map((s) => `- ${s.name}（${span(s.from, s.to)}）：${s.hint}`),
  ];
  if (range) {
    const inside = structureStagesIn(stages, range);
    if (inside.length > 0) {
      lines.push(
        '',
        `本次只寫${span(range.from, range.to)}，它們落在：${inside.map((s) => `${s.name}（${span(s.from, s.to)}）`).join('、')}。` +
          '按這幾段該完成的事展開，不要把後面的結構節點提前寫掉。'
      );
    }
  }
  return lines.join('\n');
}

/** 敘事視角的中文說法；缺席時 undefined，呼叫方決定寫不寫。 */
export function povLabel(pov: NarrativePov | undefined): string | undefined {
  return pov ? NARRATIVE_POV_LABEL[pov] : undefined;
}
