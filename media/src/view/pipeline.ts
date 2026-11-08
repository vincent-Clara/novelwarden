/**
 * 創作流水線條與「下一步」。
 *
 * 介面要回答三個問題，這裡管前兩個（第三個是工作區卡，見 workbench.ts）：
 *
 * - **我現在在哪一層？** —— 位置資訊條 + 大綱 / 細綱 / 正文三格與定稿狀態
 * - **我接下來該幹什麼？** —— 下一步條（一個主按鈕；其餘動作在輸入區的 `/` 命令裡）
 *
 * ## 為什麼是一個按鈕而不是七個
 *
 * 改造前這裡是 `STAGE_CAPABILITIES[stage]` 的平鋪：七個等重的按鈕，
 * 看不出該點哪個。可在任何一個具體時刻，作者真正要按的只有一個——
 * 那一個由狀態機算得出來（`deriveNextStep`，判據與 `deriveStage` 同源）。
 * 於是：狀態機那一個做主按鈕，其餘六個收進 `/` 命令面板。
 *
 * ## 為什麼主按鈕點了就跑
 *
 * 它是狀態機替你選的，沒有引數可填：這一章該發生什麼，大綱與前後章裡都寫著。
 * 舊介面逼作者先編一句「請生成」才肯傳送，而那句廢話還會被當成要求裝進
 * prompt。輸入框裡有字就當補充要求帶上，沒有就不帶。
 */
import { el as mk, clear, maybeById, setHidden } from '../dom';
import {
  SETTING_DOC_LABEL,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterLabel,
  plotOfTarget,
  describeCalls,
  describeTarget,
} from '../protocol';
import type {
  CreationStage,
  CreationTarget,
  NextStepView,
  PipelineProgress,
  PlotPipelineView,
} from '../protocol';
import { el } from './refs';
import { store, vscode } from './store';

// ---------------------------------------------------------------- 狀態

/** 當前這一章的流水線。切目標或產物落盤後由後端重推。 */
let current: PlotPipelineView | null = null;
/** 狀態機算出的下一步。全書那一層也有（生成架構 / 大綱 / 拆細綱）。 */
let next: NextStepView | null = null;

const crumb = () => maybeById('pipelineCrumb');
const stagesBox = () => maybeById('pipelineStages');

/** 由 composer 注入：主按鈕點下去要走傳送那條路（它管附件、草稿、busy）。 */
let runNextStep: (step: NextStepView) => void = () => {};

export function bindNextStepRunner(fn: (step: NextStepView) => void): void {
  runNextStep = fn;
}

/** 「開始新對話」：清空訊息流，從同一目標重新起一段對話。 */
export function installNewSession(): void {
  el.newSessionBtn.addEventListener('click', () => {
    if (store.busy) {
      return;
    }
    vscode.postMessage({ type: 'newSession' });
  });
}

/**
 * 「重新命名當前章節」。
 *
 * 複用工程頁右鍵那條 `fileAction: 'rename'`——後端的 `writePlot` 會保留
 * 章號字首。這裡只負責說清「改的是哪一章」，不新增協議。
 */
export function installRenamePlot(): void {
  el.renamePlotBtn.addEventListener('click', () => {
    const relPath = plotOfTarget(store.session.target);
    if (!relPath || store.busy) {
      return;
    }
    vscode.postMessage({ type: 'fileAction', action: 'rename', relPath });
  });
}

export function renderPipeline(pipeline: PlotPipelineView | undefined, step: NextStepView | undefined): void {
  current = pipeline ?? null;
  next = step ?? null;
  redraw();
}

/**
 * 會話變了（切目標、開歷史會話）時重畫。
 *
 * 目標換到另一章時手上這份 pipeline 就過期了——先丟掉再等後端推新的，
 * **不要留著顯示**：拿上一章的狀態配這一章的名字，比什麼都不顯示更糟。
 */
export function onSessionChanged(): void {
  if (current && current.plotRelPath !== plotOfTarget(store.session.target)) {
    current = null;
    next = null;
  }
  redraw();
}

function redraw(): void {
  renderCrumb();
  renderRenameBtn();
  renderStages();
  renderNextStep();
  updatePlaceholder();
}

/**
 * 「重新命名當前章節」按鈕的顯隱與 tooltip。
 *
 * 目標是架構或大綱時藏起來——那兩層沒有章可改名，留一個點了會報錯的按鈕
 * 比沒有更糟。tooltip 裡帶上章名，作者才看得出改的是哪一章。
 */
function renderRenameBtn(): void {
  const relPath = plotOfTarget(store.session.target);
  setHidden(el.renamePlotBtn, !relPath);
  if (!relPath) {
    return;
  }
  el.renamePlotBtn.title = current && current.no > 0 ? `重新命名${headLabel()}的細綱` : `重新命名 ${relPath}`;
}

/** 當前目標那一行的說法。與工程頁、與後端日誌同一份文案（`model/pipeline.ts`）。 */
function headLabel(): string {
  const target = store.session.target;
  if (target.kind === 'setting') {
    return `故事架構 · ${SETTING_DOC_LABEL[target.doc]}`;
  }
  if (target.kind === 'outline') {
    return '情節大綱';
  }
  // 單條設定（展開）：「設定 · 天機閣」，名字取檔名（與後端 `describeTarget` 同一份）。
  if (target.kind === 'lore') {
    return describeTarget(target);
  }
  return current ? chapterLabel(current.no, current.title) : '';
}

// ---------------------------------------------------------------- 位置資訊條（只讀）

/**
 * 頂部只報「在哪」，不負責導航。
 *
 * 切層靠下面的細綱 / 正文兩格；切章靠工程頁。這裡做成可點只會多一個幾乎沒人用的
 * 入口，還讓人以為點了會有什麼深層動作。
 */
function renderCrumb(): void {
  const box = crumb();
  if (!box) {
    return;
  }
  clear(box);
  const target = store.session.target;
  const relPath = plotOfTarget(target);

  // `no` 為 0 是後端給的「找不到」空殼（剛被改名或刪掉），
  // 那時報檔名比報「第 0 章」有用。
  const title = !relPath
    ? headLabel()
    : current && current.no > 0
      ? headLabel()
      : relPath.slice(relPath.lastIndexOf('/') + 1);
  setHidden(box, !title);
  if (!title) {
    return;
  }
  // 從前章名後面還掛一枚狀態徽章（「待寫正文」），與下一行的兩格加「未寫正文 / 待定稿 / 已定稿」
  // 說的是同一件事，擠在同一塊裡說兩遍。這一章走到哪，只在下一行報一次。
  box.appendChild(mk('span', 'crumb', title));
}

// ---------------------------------------------------------------- 三格狀態

/**
 * 大綱 / 細綱 / 正文三個可點的按鈕（點了就切到那一層），加一個「定稿」狀態點。
 *
 * 從前這裡是「卷綱 / 劇情 / 正文」三層——卷那一層刪掉了，一章一綱之後這一章的
 * 上游鏈只剩細綱、正文兩格。定稿不是一個創作階段（它是寫完之後的一步工程動作），
 * 所以只給狀態，不給按鈕。「大綱」那一格見 {@link outlineCell}。
 *
 * 完成度落成三態圓點（未開始 / 進行中 / 已完成），不用百分比條——這裡
 * 表達的是狀態機走到哪，不是「完成了百分之幾」。
 *
 * 「上游變過」的標記（⟳）是這套流水線最有價值的一格資訊：改了大綱之後，
 * 哪幾章的細綱需要回頭看，光靠人腦記不住。它由 hash 鏈算出來，零模型呼叫。
 */
function renderStages(): void {
  const box = stagesBox();
  if (!box) {
    return;
  }
  clear(box);

  const relPath = plotOfTarget(store.session.target);
  // 架構與大綱兩層沒有「這一章的三格」可言，整條收起來。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  box.appendChild(outlineCell());

  const progress: PipelineProgress = current?.progress ?? { plot: 0, manuscript: 0, summary: 0 };
  const cells: { stage: CreationStage; ratio: number; stale: boolean }[] = [
    { stage: 'plot', ratio: progress.plot, stale: !!current?.plot.upstreamStale },
    { stage: 'manuscript', ratio: progress.manuscript, stale: !!current?.chapter.upstreamStale },
  ];

  for (const cell of cells) {
    const status = stageStatus(cell.ratio);
    const btn = mk('button', 'pstage');
    btn.classList.toggle('active', store.session.stage === cell.stage);
    btn.classList.toggle('done', status === 'done');
    btn.classList.toggle('partial', status === 'partial');
    btn.title = `${STAGE_LABEL[cell.stage]}：${STAGE_STATUS_LABEL[status]} · ${STAGE_QUESTION[cell.stage]}`;

    const mark = mk('span', `pstage-mark ${status}`);
    mark.setAttribute('aria-hidden', 'true');
    btn.appendChild(mark);
    btn.appendChild(mk('span', 'pstage-label', STAGE_LABEL[cell.stage]));
    if (cell.stale) {
      const dot = mk('span', 'pstage-stale', '⟳');
      dot.title = '上游產物改過，這一層可能需要回頭看';
      btn.appendChild(dot);
    }
    const target: CreationTarget = { kind: cell.stage as 'plot' | 'manuscript', plotRelPath: relPath };
    btn.addEventListener('click', () => go(target));
    box.appendChild(btn);
  }

  // 定稿：只報狀態。沒有正文時說「未寫」，別把一格空的說成「待定稿」。
  if (current) {
    const text = !current.chapter.exists || current.chapter.words === 0
      ? '未寫正文'
      : current.summary.exists && !current.summary.stale
        ? '已同步'
        : '待同步';
    const s = mk('span', `psummary${text === '待同步' ? ' stale' : ''}`, text);
    box.appendChild(s);
  }
}

/**
 * 「大綱」那一格（2026-10-24）：這一章在情節大綱裡有沒有那一條（就是這一章細綱的梗概），點了回到全書那一層
 * （目標是情節大綱，主按鈕是全書的下一步）。從前停在一章上，回全書只有目標下拉框最上面那一項，找不到續寫大綱。
 *
 * 大綱是這一章的上游、不是這一章的一層，所以從不高亮。沒排進大綱掛 ⚠；流水線還沒推到（剛切過來）時
 * 只畫空心、不掛——沒資料不該說「沒排到」。
 */
function outlineCell(): HTMLElement {
  const outline = current?.outline;
  const covered = !!outline?.covered;
  const btn = mk('button', `pstage${covered ? ' done' : ''}`);
  const mark = mk('span', `pstage-mark ${covered ? 'done' : 'todo'}`);
  mark.setAttribute('aria-hidden', 'true');
  btn.appendChild(mark);
  btn.appendChild(mk('span', 'pstage-label', '大綱'));

  const reach = outline?.coverage ? `大綱排到第 ${outline.coverage} 章` : '還沒有情節大綱';
  const state = !outline ? '' : covered ? `情節大綱裡有這一章（${reach}）· ` : `情節大綱裡還沒有這一章（${reach}）· `;
  btn.title = `${state}點了回到全書那一層；往後排大綱在任何一層打 /續寫大綱`;
  if (outline && !covered) {
    const warn = mk('span', 'pstage-stale', '⚠');
    warn.title = `情節大綱裡還沒有這一章（${reach}）`;
    btn.appendChild(warn);
  }
  btn.addEventListener('click', () => go({ kind: 'outline' }));
  return btn;
}

/**
 * 把 0..1 的比例收成介面要的三態——不把連續比例畫成百分比。
 *
 * 類名刻意不用 `empty`：訊息流的 `.empty` 帶大 padding，撞上會把圓點撐成橢圓。
 */
function stageStatus(ratio: number): 'todo' | 'partial' | 'done' {
  if (ratio >= 1) {
    return 'done';
  }
  if (ratio > 0) {
    return 'partial';
  }
  return 'todo';
}

const STAGE_STATUS_LABEL = {
  todo: '未開始',
  partial: '進行中',
  done: '已完成',
} as const;

// ---------------------------------------------------------------- 下一步

/**
 * 下一步條：一句「為什麼是這一步」 + 一個主按鈕。
 *
 * 沒有下一步（這一章全做完了）時主按鈕收起——**不造一個假的下一步**。
 * 給一個「下一步」等於逼作者一直有事可做，而寫完就是寫完了。其餘命令在
 * 輸入框裡打 `/` 就有（或點工具行上的「/ 命令」）。
 */
function renderNextStep(): void {
  setHidden(el.nextStep, false);

  if (!next) {
    el.nextStepHint.textContent = current
      ? '這一章都齊了。要改哪一層就點上面對應的那一格。'
      : '全書都寫完了。要改哪一章就去工程頁點它，或在輸入框裡打 / 挑一個命令。';
    setHidden(el.nextStepBtn, true);
    return;
  }

  // 呼叫次數寫在動手之前（第 4 條、D16）：有自動修復的步驟連上限一起報。
  el.nextStepHint.textContent = next.calls ? `${next.hint}（${describeCalls(next.calls)}）` : next.hint;
  setHidden(el.nextStepBtn, false);
  el.nextStepBtn.textContent = next.form ? `${next.label}…` : next.label;
  el.nextStepBtn.title = next.form
    ? '先填一句話與規模，再生成'
    : next.projectAction
      ? '這一步是工程動作，不消耗對話上下文'
      : `${STAGE_LABEL[next.stage]} · 點了立即執行，輸入框裡有字就一起帶上`;
  el.nextStepBtn.disabled = store.busy;
  el.nextStepBtn.onclick = () => {
    if (!store.busy && next) {
      runNextStep(next);
    }
  };
}

/**
 * 輸入框的提示語跟著階段與能力走。
 *
 * 正文層寫正文時，要寫什麼已經在細綱裡了——輸入框裡是補充要求（「多寫點雨裡的
 * 細節」）。而多數命令的輸入是**可選**的，提示語要說出這一點。
 */
function updatePlaceholder(): void {
  const { stage, capability, target } = store.session;
  if (stage === 'manuscript' && capability === 'generate') {
    el.input.placeholder = '這一章的補充要求…（可留空，Enter 傳送）';
    return;
  }
  // 單條設定：打字是聊這一條，`/展開` 是生成——架構那一句「這是個什麼故事？」問的不是它。
  if (target.kind === 'lore') {
    el.input.placeholder = '聊聊這一條設定…（打 /展開 把它往前想細）';
    return;
  }
  el.input.placeholder = `${STAGE_LABEL[stage]}：${STAGE_QUESTION[stage]}（可留空，打 / 挑命令）`;
}

// ---------------------------------------------------------------- 工具

function go(target: CreationTarget): void {
  if (store.busy) {
    return;
  }
  vscode.postMessage({ type: 'setTarget', target });
}
