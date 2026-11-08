/**
 * 覆蓋審閱的段級 diff / 合併檢視（五期 W11，僅獨立版）。
 *
 * 後端（`FileHost.reviewReplace`）推一條 `prompt kind: 'merge'`：兩個版本、能不能合併。
 * 這裡按段對齊（model/paragraphDiff.ts 的 LCS），相同的段一行帶過，每一處改動畫成：
 *
 * ```
 * ┌ 原文 ──────────────┐ ┌ 新版 ──────────────┐
 * │ 她把那塊殘令收進袖中 │ │ 她看了一眼他空著的手 │
 * └────────────────────┘ └────────────────────┘
 * ┌ 結果（可以手改）──────────────────────────┐
 * │ 她看了一眼他空著的手                       │
 * └──────────────────────────────────────────┘
 * [保留原文] [採用新版]                   已採用新版
 * ```
 *
 * ## 手改過的那一格誰都不動
 *
 * AI-Novel-Writer 的 `ThreeWayMerge` 點「採用」就把那一格換成原稿或修稿的原樣文字，作者剛手改的
 * 內容一聲不響就沒了（`toggleHunk`，ThreeWayMerge.tsx:336-347）。這裡一格被手改過，它的兩顆按鈕
 * 與頂上的「全部採用新版 / 全部保留原文」都**不碰它**；要重來先點「撤銷手改」（第 3 條：不靜默覆蓋）。
 *
 * ## 預設是新版
 *
 * 作者是發起了一次生成（重寫、修稿）才走到這裡的，結果格一開始放的是新版——什麼都不動直接點
 * 「寫入」就等於從前的「覆蓋」。一處都沒動過（或者全部採用新版、沒有手改）時交回 `apply`，
 * 原樣用新版，不經段拼接：拼接會把段間空行規範成一個，作者沒挑什麼，就不該讓檔案裡的排版變樣。
 *
 * ## 只讀模式
 *
 * 沒請求合併的呼叫方（角色卡、設定條目那幾處）收不下一份作者拼出來的文字：只畫兩欄 diff，
 * 底部是「採納 / 放棄」。
 *
 * ## 兩欄叫什麼由後端說
 *
 * 預設是「原文 / 新版」（覆蓋審閱、刪修飾）。內建編輯器衝突時的「對比合併」是「磁碟上的 / 編輯器裡的」，
 * 歷史版本的「對比」是「快照 / 編輯器裡的」——訊息帶 `sides` 時兩欄、逐處與整體的按鈕、狀態都跟著換成
 * 「用……」的說法；`applyLabel` 換掉「寫入合併結果」（那兩處不寫盤，是「放回編輯器」）。
 */
import { el as mk, maybeById, setHidden } from '../dom';
import type { MergeSegment, OutMessage } from '../protocol';
import { changeCount, diffParagraphs, joinMerge, sideText } from '../protocol';
import { vscode } from './store';

type PromptMessage = Extract<OutMessage, { type: 'prompt' }>;
type Change = Extract<MergeSegment, { kind: 'change' }>;

/** 一處改動的狀態：挑了哪一邊（還沒挑是 undefined）、手改過沒有。 */
interface HunkState {
  choice?: 'new' | 'old';
  edited: boolean;
  area?: HTMLTextAreaElement;
  refresh?: () => void;
}

/** 相同的段連著超過這麼多段就折起來，只露頭尾。 */
const SAME_FOLD = 3;

/** 兩欄與那幾顆按鈕上的字。 */
interface MergeLabels {
  colOld: string;
  colNew: string;
  takeOld: string;
  takeNew: string;
  allOld: string;
  allNew: string;
  stateOld: string;
  stateNew: string;
  pending: string;
  hint: string;
}

/** 覆蓋審閱與刪修飾的說法（從前寫死的那一套，一字不改）。 */
const DEFAULT_LABELS: MergeLabels = {
  colOld: '原文',
  colNew: '新版',
  takeOld: '保留原文',
  takeNew: '採用新版',
  allOld: '全部保留原文',
  allNew: '全部採用新版',
  stateOld: '已保留原文',
  stateNew: '已採用新版',
  pending: '未處理（預設是新版）',
  hint: '結果格可以手改；手改過的那一格，「採用」與「全部採用」都不會動它。',
};

function labelsOf(msg: PromptMessage): MergeLabels {
  const sides = msg.sides;
  if (!sides) {
    return DEFAULT_LABELS;
  }
  const a = sides.current;
  const b = sides.proposed;
  return {
    colOld: a,
    colNew: b,
    takeOld: `用${a}`,
    takeNew: `用${b}`,
    allOld: `全部用${a}`,
    allNew: `全部用${b}`,
    stateOld: `已用${a}`,
    stateNew: `已用${b}`,
    pending: `未處理（預設是${b}）`,
    hint: '結果格可以手改；手改過的那一格，逐處與整體的按鈕都不會再動它。',
  };
}

export function renderMerge(msg: PromptMessage): void {
  // 這一塊只有獨立版的頁面上有（外掛用 VS Code 自己的 diff 編輯器）：能力探測，不判斷是哪個殼。
  const modal = maybeById('mergeModal');
  if (!modal) {
    // 沒有合併檢視的頁面收到了一條合併詢問：當取消，別讓後端死等。
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value: undefined });
    return;
  }
  const mergeable = !!msg.mergeable;
  const labels = labelsOf(msg);
  const segments = diffParagraphs(msg.current ?? '', msg.proposed ?? '');
  const total = changeCount(segments);
  const states = new Map<number, HunkState>();

  const title = maybeById('mergeTitle')!;
  const path = maybeById('mergePath')!;
  const body = maybeById('mergeBody')!;
  const progress = maybeById('mergeProgress')!;
  const hint = maybeById('mergeHint')!;
  const allNew = maybeById<HTMLButtonElement>('mergeAllNew')!;
  const allOld = maybeById<HTMLButtonElement>('mergeAllOld')!;
  const apply = maybeById<HTMLButtonElement>('mergeApply')!;
  const discard = maybeById<HTMLButtonElement>('mergeDiscard')!;

  title.textContent = msg.title;
  path.textContent = msg.message ?? '';
  body.replaceChildren();
  modal.classList.toggle('merge-readonly', !mergeable);
  setHidden(allNew, !mergeable || total === 0);
  setHidden(allOld, !mergeable || total === 0);
  allNew.textContent = labels.allNew;
  allOld.textContent = labels.allOld;
  apply.textContent = mergeable ? (msg.applyLabel ?? '寫入合併結果') : '採納';
  hint.textContent = mergeable ? labels.hint : '只能整份採納或放棄。';

  const syncProgress = () => {
    const done = [...states.values()].filter((s) => s.choice || s.edited).length;
    progress.textContent = total === 0 ? '兩個版本沒有不同的段' : mergeable ? `已處理 ${done} / ${total} 處` : `${total} 處改動`;
  };

  segments.forEach((seg, k) => {
    if (seg.kind === 'same') {
      body.appendChild(sameBlock(seg.paragraphs));
      return;
    }
    const state: HunkState = { edited: false };
    states.set(k, state);
    body.appendChild(hunkBlock(seg, k, state, mergeable, labels, syncProgress));
  });
  syncProgress();

  const setAll = (side: 'new' | 'old') => {
    for (const state of states.values()) {
      if (!state.edited) {
        state.choice = side;
        state.refresh?.();
      }
    }
    syncProgress();
  };
  allNew.onclick = () => setAll('new');
  allOld.onclick = () => setAll('old');

  const close = (value: string) => {
    setHidden(modal, true);
    body.replaceChildren();
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  };
  discard.onclick = () => close(JSON.stringify({ verdict: 'discard' }));
  apply.onclick = () => {
    if (!mergeable) {
      close(JSON.stringify({ verdict: 'apply' }));
      return;
    }
    const untouched = [...states.values()].every((s) => !s.edited && (s.choice === undefined || s.choice === 'new'));
    if (untouched) {
      close(JSON.stringify({ verdict: 'apply' }));
      return;
    }
    const results: Record<number, string> = {};
    segments.forEach((seg, k) => {
      const state = states.get(k);
      if (seg.kind === 'change' && state?.area) {
        results[k] = state.area.value;
      }
    });
    close(JSON.stringify({ verdict: 'apply', merged: joinMerge(segments, results) }));
  };

  setHidden(modal, false);
}

function sameBlock(paragraphs: string[]): HTMLElement {
  const block = mk('div', 'merge-same');
  if (paragraphs.length <= SAME_FOLD) {
    paragraphs.forEach((p) => block.appendChild(mk('p', undefined, p)));
    return block;
  }
  block.appendChild(mk('p', undefined, paragraphs[0]));
  const det = mk('details', 'merge-same-fold');
  det.appendChild(mk('summary', undefined, `相同的 ${paragraphs.length - 2} 段`));
  paragraphs.slice(1, -1).forEach((p) => det.appendChild(mk('p', undefined, p)));
  block.appendChild(det);
  block.appendChild(mk('p', undefined, paragraphs[paragraphs.length - 1]));
  return block;
}

function hunkBlock(
  seg: Change,
  k: number,
  state: HunkState,
  mergeable: boolean,
  labels: MergeLabels,
  onChange: () => void
): HTMLElement {
  const block = mk('div', 'merge-hunk');
  block.dataset.hunk = String(k);

  const sides = mk('div', 'merge-sides');
  sides.appendChild(side(labels.colOld, seg.old, 'merge-old'));
  sides.appendChild(side(labels.colNew, seg.new, 'merge-new'));
  block.appendChild(sides);
  if (!mergeable) {
    return block;
  }

  const area = mk('textarea', 'merge-result');
  area.value = sideText(seg, 'new');
  area.rows = Math.min(12, Math.max(2, area.value.split('\n').length + 1));
  area.setAttribute('aria-label', '合併結果（可以手改）');
  state.area = area;
  block.appendChild(area);

  const actions = mk('div', 'merge-actions');
  const takeNew = mk('button', 'secondary small merge-take-new', labels.takeNew);
  const takeOld = mk('button', 'secondary small merge-take-old', labels.takeOld);
  const undo = mk('button', 'link merge-undo', '撤銷手改');
  const label = mk('span', 'merge-state');
  actions.append(takeOld, takeNew, undo, label);
  block.appendChild(actions);

  const current = () => sideText(seg, state.choice ?? 'new');
  state.refresh = () => {
    if (!state.edited) {
      area.value = current();
    }
    takeNew.disabled = state.edited;
    takeOld.disabled = state.edited;
    const lock = state.edited ? '這一處你手改過，不會被「採用」沖掉；要重來先點「撤銷手改」' : '';
    takeNew.title = lock;
    takeOld.title = lock;
    setHidden(undo, !state.edited);
    block.classList.toggle('edited', state.edited);
    block.classList.toggle('took-old', !state.edited && state.choice === 'old');
    label.textContent = state.edited
      ? '已手改'
      : state.choice === 'old'
        ? labels.stateOld
        : state.choice === 'new'
          ? labels.stateNew
          : labels.pending;
  };
  takeNew.addEventListener('click', () => {
    if (!state.edited) {
      state.choice = 'new';
      state.refresh!();
      onChange();
    }
  });
  takeOld.addEventListener('click', () => {
    if (!state.edited) {
      state.choice = 'old';
      state.refresh!();
      onChange();
    }
  });
  undo.addEventListener('click', () => {
    state.edited = false;
    state.refresh!();
    onChange();
  });
  area.addEventListener('input', () => {
    const edited = area.value !== current();
    if (edited !== state.edited) {
      state.edited = edited;
      state.refresh!();
      onChange();
    }
  });
  state.refresh();
  return block;
}

function side(label: string, paragraphs: string[], className: string): HTMLElement {
  const col = mk('div', `merge-side ${className}`);
  col.appendChild(mk('div', 'merge-side-label', label));
  if (paragraphs.length === 0) {
    col.appendChild(mk('p', 'merge-none', '（無）'));
  }
  paragraphs.forEach((p) => col.appendChild(mk('p', undefined, p)));
  return col;
}
