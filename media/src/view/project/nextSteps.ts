/**
 * 空狀態（W12）：空分組寫出接下來做什麼，按鈕直接可點。
 *
 * 兩條口徑：
 *
 * 1. **「下一步：」只說全書的那一步**（第 20 條：只推一個下一步）。文字取後端給的
 *    `tree.next.label`——那是對話頁主按鈕在全書那一檔會給的同一句話，前端不自己判斷。
 *    別處的空狀態（角色、設定）只說「這裡該放什麼、從哪來」，不另起一個「下一步」。
 * 2. **按鈕不直接花錢**，與「去生成」「去寫這一章」同一個道理：小說配置開一句話彈窗、
 *    拆細綱開拆細綱彈窗（彈窗上寫著呼叫次數），其餘進入那一層（對話頁的主按鈕就是它）；
 *    提取角色卡、從正文生成設定走的是自帶確認框的工程動作。花錢的那一下總在作者看得見
 *    次數的地方。
 */
import { el as mk } from '../../dom';
import type { CreationTarget, NextStepView, ProjectTree } from '../../protocol';
import { openIdeaForm, openPlotBatchForm } from '../forms';
import { vscode } from '../store';
import { projectAction } from './actions';

interface HintButton {
  label: string;
  title: string;
  run(): void;
}

/** 一行說明 + 幾顆小按鈕。不是 `.row`：它不是樹上的一項，沒有右鍵選單。 */
function hintRow(text: string, buttons: HintButton[]): HTMLElement {
  const row = mk('div', 'hint row-empty row-hint-action');
  row.appendChild(mk('span', 'row-hint-text', text));
  for (const b of buttons) {
    const btn = mk('button', 'chip-btn row-go', b.label);
    btn.title = b.title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      b.run();
    });
    row.appendChild(btn);
  }
  return row;
}

function setTarget(target: CreationTarget): void {
  vscode.postMessage({ type: 'setTarget', target });
}

/** 全書的下一步那一顆按鈕做什麼。 */
function stepButton(step: NextStepView, tree: ProjectTree): HintButton {
  if (step.form === 'idea') {
    return { label: '去生成', title: '寫一句話與規模，生成小說配置', run: () => openIdeaForm(step.formDefaults ?? tree.book) };
  }
  if (step.projectAction === 'deriveFromText') {
    // 已經有正文：照正文整理。後端先彈框報呼叫次數，點這一下不花錢。
    return { label: '補齊…', title: '照已寫正文整理細綱、角色卡、架構與大綱；先報呼叫次數', run: () => projectAction('deriveFromText') };
  }
  if (step.projectAction === 'chapterGap') {
    // 章號斷了一截：說明框裡列著缺哪幾號、哪幾號重複，不花錢。
    return { label: '看看…', title: step.hint, run: () => projectAction('chapterGap') };
  }
  if (step.stage === 'plot') {
    // 彈窗預設就是「下一可寫章起 5 章」，與這一步同一個區間；呼叫次數寫在彈窗上。
    return { label: '拆細綱…', title: '選好區間，看清呼叫幾次再拆', run: () => openPlotBatchForm(tree) };
  }
  return { label: '去生成', title: '進入這一層：對話頁的主按鈕就是這一步', run: () => setTarget(step.target) };
}

/** 「下一步：生成故事前提」+ 一顆按鈕。 */
export function nextStepRow(step: NextStepView, tree: ProjectTree): HTMLElement {
  const row = hintRow(`下一步：${step.label}`, [stepButton(step, tree)]);
  row.classList.add('row-next-step');
  return row;
}

/**
 * 章節組為空（2026-10-24 新手上手）：自己寫的新建第 1 章（建完就開啟，接著就能寫），寫好的書匯入原稿。這兩顆不是
 * 「下一步」——全書的下一步（對話頁主按鈕那一句）照舊在下面另起一行（第 20 條）；這裡只是把右鍵選單裡那兩項擺到
 * 明處。都不調模型：新建先問章名，匯入先給作者看切出幾章。
 */
export function chaptersEmptyRow(tree: ProjectTree): HTMLElement {
  return hintRow('還沒有章節。自己寫就新建一章，建好就開啟；已經寫好的書匯入一本 txt，按章標題切成一章一份。', [
    {
      label: `新建第 ${tree.nextChapterNo || 1} 章`,
      title: '先問章節名稱（可以空著），建好就在右邊開啟，同時配一份空細綱。不調模型',
      run: () => vscode.postMessage({ type: 'projectAction', action: 'newChapter', open: true }),
    },
    {
      label: '匯入原稿…',
      title: '挑一本 txt，按「第一章 雪夜」這樣單獨一行的章標題切成一章一份；先告訴你切出幾章再匯入。不調模型',
      run: () => projectAction('importManuscript'),
    },
  ]);
}

/** 已經寫過正文沒有（老工程直接把章放進來的也算）。 */
function hasText(tree: ProjectTree): boolean {
  return tree.totalWords > 0;
}

/**
 * 角色組為空。
 *
 * - 全書的下一步正是角色圖譜：就說它，按鈕進入那一層。
 * - 已經有正文（老工程）：角色卡可以從正文裡提取（自帶確認框，寫著呼叫次數）。
 * - 否則：說清角色卡從哪來——輪到角色圖譜時「故事架構」那一組會給「去生成」。
 */
export function charactersEmptyRow(tree: ProjectTree): HTMLElement {
  const next = tree.next;
  if (next && next.target.kind === 'setting' && next.target.doc === 'characters') {
    return nextStepRow(next, tree);
  }
  if (hasText(tree)) {
    return hintRow('還沒有角色卡。已經寫過正文，可以從正文裡把出場的人提取成角色卡。', [
      { label: '提取角色卡…', title: '通讀選定的幾章，一次建一批角色卡；動手前會告訴你呼叫幾次', run: () => projectAction('extractCharacters') },
    ]);
  }
  return hintRow('還沒有角色卡。故事架構裡的「角色圖譜」會一次建好主角、盟友與對手；輪到它時，「概覽」頁的「故事架構」那一組會給「去生成」。', []);
}

/**
 * 設定組為空。全書的下一步正是設定清單時就說它（同角色組），按鈕進入那一層。否則不說「下一步」：
 * 設定條目是可選的，說清它放什麼、往後從哪兒長出來——
 * 每章定稿時記下這一章出現了哪些設定，出現過卻還沒建條目的列在下面「出現過 · 未建條目」那一組。
 * 手建一條不調模型；有定稿過、還沒記過設定的章（這個功能之前定稿的）時給「補記設定」（自帶確認框）。
 */
export function loreEmptyRow(tree: ProjectTree): HTMLElement {
  const next = tree.next;
  if (next && next.target.kind === 'setting' && next.target.doc === 'lore') {
    return nextStepRow(next, tree);
  }
  const buttons: HintButton[] = [
    { label: '＋ 設定', title: '新建一條設定（不調模型）', run: () => projectAction('newLore') },
  ];
  if (tree.loreUnrecorded > 0) {
    buttons.push({
      label: '補記設定…',
      title: `${tree.loreUnrecorded} 章同步過、還沒記過設定：讀這幾章正文，記下出現了哪些設定；動手前會告訴你呼叫幾次`,
      run: () => projectAction('recordLore'),
    });
  }
  return hintRow(
    '還沒有設定條目。地點、勢力、物品、概念這類要前後一致的東西各寫一條；每章同步時會記下這一章出現了哪些設定，出現過卻還沒建條目的會列在下面。',
    buttons
  );
}
