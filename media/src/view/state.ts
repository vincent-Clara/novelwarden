/**
 * `ViewState` 的渲染：輸入框旁的模型下拉、寫入目標下拉、活動欄上的待辦圓點，
 * 以及生成中的按鈕狀態。
 *
 * 後端全量推 state，這裡整塊重畫——資料量只有幾十行，增量更新換來的那點
 * 開銷不值得多維護一份狀態。
 */
import { maybeById, setHidden } from '../dom';
import { THINKING_DEPTHS, THINKING_HINT, ThinkingDepth, plotOfTarget } from '../protocol';

/** 下拉框只在這裡用英文短標籤，日誌那邊的中文說法（THINKING_LABEL）不受影響。 */
const THINKING_LABEL_DISPLAY: Record<ThinkingDepth, string> = {
  off: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};
import type { ViewState } from '../protocol';
import { setCommandsDisabled } from './commands';
import { syncReviewCards } from './review';
import { fmt } from './format';
import { el } from './refs';
import { store, hasWorkspace } from './store';

export function renderState(state: ViewState): void {
  store.state = state;
  // 這裡從前有一段「如果是獨立版就把 VS Code 專屬入口 hidden 掉、把儲存說明
  // 改一改」。現在那兩處差異由殼在渲染頁面時決定要不要產出（見
  // src/shells/shared/panes.ts 的 nativeSettings），前端不再認得環境。
  renderModelSelect(state);
  renderThinkingSelect();

  el.input.disabled = !hasWorkspace();
  if (!hasWorkspace()) {
    el.sendBtn.disabled = true;
  }

  // 開啟了資料夾但還不是小說工程：訊息區換成「下一步：初始化」那一塊（W12）。沒開啟資料夾時
  // 不顯示——那時獨立版有空視窗的遮罩，外掛沒有這個狀態。
  el.messages.classList.toggle('uninit', hasWorkspace() && !state.initialized);
  if (!state.initialized) {
    // 從前這裡寫「先執行「Novel: 初始化小說工程」」——那是 VS Code 的命令名，獨立版裡找不到。
    el.providerMeta.textContent = '當前工作區還不是小說工程。';
    el.sendBtn.disabled = true;
    return;
  }

  el.sendBtn.disabled = store.busy || !hasWorkspace();
  el.providerMeta.textContent = state.modelIssue
    ? state.modelIssue
    : `${state.modelLabel} · 視窗 ${fmt(state.contextWindow)} / 輸出 ${fmt(state.maxOutputTokens)}`;
  el.providerMeta.classList.toggle('warn', !!state.modelIssue);

  renderTargetSelect(state);

  // 沒定稿的提示只在工程頁出現（那份橫幅由 project/groups.ts 畫，還帶進度條）。
  // 對話頁不再掛一份純文字版——同一句話說兩遍，佔的卻是訊息流的地方。
  // 獨立版的活動欄上給「工程」掛一個小圓點，切走了也看得見待辦。
  const dot = maybeById('projectStaleDot');
  if (dot) {
    setHidden(dot, state.staleCount === 0);
  }
}

/**
 * 當前創作目標是哪一章。
 *
 * 它不只是「採納寫到哪」了——裝配的每一層都跟著它走，所以選項裡帶上
 * `relPath`（目標一律按路徑標識，章號會撞）。第一項「全書（架構 · 大綱）」沒有
 * relPath：選它就是回到全書那一層，主按鈕是全書的下一步。它與下面那一串章之間隔一條
 * 選不中的分隔線——不隔開的話它看著就像列表裡的又一章（2026-10-24，作者找不到回全書的路）。
 * 停在一章上時，流水線條上的「大綱」那一格也回到這一層。
 *
 * 列的是**每個章號一行**，最近的在上面。說法由後端給（`p.label`）。
 */
function renderTargetSelect(state: ViewState): void {
  el.targetSelect.innerHTML = '';

  const bookOpt = document.createElement('option');
  bookOpt.value = '0';
  bookOpt.textContent = '全書（架構 · 大綱）';
  el.targetSelect.appendChild(bookOpt);

  if (state.plots.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.value = '';
    sep.textContent = '──────────';
    el.targetSelect.appendChild(sep);
  }

  for (const p of [...state.plots].reverse()) {
    const opt = document.createElement('option');
    opt.value = String(p.no);
    opt.textContent = p.label;
    opt.dataset.rel = p.relPath;
    el.targetSelect.appendChild(opt);
  }

  // 以會話裡的目標為準（後端是唯一真相）。目標是架構或大綱、或它指向的那一章
  // 不在列表裡（剛被刪/改名、還沒有細綱也沒有正文）時停在「全書」那一項。
  const relPath = plotOfTarget(store.session.target);
  const matched = relPath
    ? [...el.targetSelect.options].find((o) => o.dataset.rel === relPath)
    : undefined;
  el.targetSelect.value = matched?.value ?? '0';
}

/** 輸入框旁的模型下拉框，按服務商分組。 */
function renderModelSelect(state: ViewState): void {
  el.modelSelect.innerHTML = '';
  const models = state.models || [];

  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未配置模型';
    el.modelSelect.appendChild(opt);
    el.modelSelect.disabled = true;
    return;
  }
  el.modelSelect.disabled = false;

  let group: string | null = null;
  let optgroup: HTMLOptGroupElement | null = null;
  for (const m of models) {
    if (m.group !== group) {
      group = m.group;
      optgroup = document.createElement('optgroup');
      optgroup.label = group;
      el.modelSelect.appendChild(optgroup);
    }
    const opt = document.createElement('option');
    opt.value = m.ref;
    // 顯示完整引用，因為它才是使用者在別處（配置檔案、文件）看到的東西。
    opt.textContent = m.ref;
    opt.title = `${m.group} · ${m.label}`;
    optgroup?.appendChild(opt);
  }

  // 當前引用可能指向一個已被刪掉的模型，這時補一條佔位項，
  // 否則下拉框會靜默跳到第一個模型，使用者以為自己在用另一個。
  if (state.model && !models.some((m) => m.ref === state.model)) {
    const opt = document.createElement('option');
    opt.value = state.model;
    opt.textContent = `${state.model}（未配置）`;
    el.modelSelect.appendChild(opt);
  }
  el.modelSelect.value = state.model || models[0].ref;
}

/**
 * 輸入框旁的思考深度下拉框。
 *
 * 選項是**固定五檔**（後端那張表，前端直接打包同一份），所以只在首次渲染
 * 時建；當前值跟著會話走，由 `syncThinkingSelect` 在每次收到 session 時回填。
 */
function renderThinkingSelect(): void {
  if (el.thinkSelect.options.length === 0) {
    for (const depth of THINKING_DEPTHS) {
      const opt = document.createElement('option');
      opt.value = depth;
      opt.textContent = THINKING_LABEL_DISPLAY[depth];
      opt.title = THINKING_HINT[depth];
      el.thinkSelect.appendChild(opt);
    }
  }
  syncThinkingSelect();
}

/** 把會話裡那一檔回顯到下拉框上。後端是唯一真相，這裡只是畫它。 */
export function syncThinkingSelect(): void {
  el.thinkSelect.value = store.session.thinking;
}

export function setBusy(value: boolean): void {
  store.busy = value;
  setHidden(el.sendBtn, value);
  setHidden(el.stopBtn, !value);
  const locked = !hasWorkspace();
  el.sendBtn.disabled = value || locked;
  el.atBtn.disabled = value || locked;
  el.selBtn.disabled = value || locked;
  el.newSessionBtn.disabled = value || locked;
  // 生成期間不給改名：改名會動這一章的路徑，而正在跑的那一輪攥著舊路徑，
  // 採納時會寫到一個已經不存在的地方去。
  el.renamePlotBtn.disabled = value || locked;
  // 主按鈕與命令面板在生成期間都禁用：兩者都會發起新的一輪。面板要是正開著
  // 也一併收掉——一個點不動的候選列表掛在輸入框上方只會擋住訊息流。
  el.nextStepBtn.disabled = value || locked;
  setCommandsDisabled(value || locked);
  // 審稿報告卡上的「按勾選的 n 條修稿」也會發起新的一輪。
  syncReviewCards();
}
