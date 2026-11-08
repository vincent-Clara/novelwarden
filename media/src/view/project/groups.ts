/**
 * 工程頁裡除了樹行以外的東西：可摺疊分組、定稿進度橫幅，
 * 以及「文風與摘要」那兩行固定檔案。
 */
import { el as mk, spacer } from '../../dom';
import type { MenuItem } from '../../globals';
import type { ProjectNode, ProjectTree } from '../../protocol';
import { linkBtn } from '../buttons';
import { onContextMenu } from '../menu';
import { openPath } from '../store';
import { hasTask } from '../tasks';
import { baseMenuItems, newItemsIn, projectAction } from './actions';
import type { Section } from './actions';
import { buildFileRow } from './rows';
import { openGroups } from './treeState';

interface GroupOptions {
  /** 給了 section + root 的分組，標題欄與空白處右鍵能「在此新建」。 */
  section?: Section;
  root?: string;
  /**
   * 排在新建項之前的額外選單項（如角色區的批次動作）。
   * 沒有 `section` 的分組只掛這些 + 通用項，所以自帶的分隔線要自己寫。
   */
  extraItems?: () => MenuItem[];
  /**
   * 標題欄上摺疊開關之外的一樣東西（「設定」組的篩選框、「敘事線」組的「從大綱排出」）。掛在開關**旁邊**而不是裡面：
   * 開關是一顆 `<button>`，放進去的話點輸入框、在裡面按空格回車都會把組折起來。
   */
  head?: HTMLElement;
  /**
   * 這一組是某個頁籤的主分組時傳那一頁的容器：頁裡分組下面的空白處右鍵也給這一組的選單
   * （「角色」頁空白處右鍵就能「在此新建角色卡」）。
   */
  panel?: HTMLElement;
  /** 標題欄的懸停（「時間線」組的歷法與起點：2026-10-24 從組裡第一行挪上來）。 */
  tip?: string;
  /** 惰性呼叫：摺疊時不生成行。 */
  build: () => HTMLElement[];
}

/**
 * 可摺疊分組。
 *
 * 三個可管理區（給了 `section` + `root`）在標題欄與分組空白處右鍵能
 * 「在此新建」，落點是該區根目錄；行上的右鍵各自登記，會先命中。
 */
export function buildGroup(
  id: string,
  label: string,
  description: string,
  opts: GroupOptions
): HTMLElement {
  const box = mk('div', 'group');
  box.dataset.group = id;

  const head = mk('div', 'group-head');
  // 摺疊開關吃掉整行的可點面積：標題欄上除了它只有 `opts.head`（篩選框），點別處都能摺疊。
  const toggle = mk('button', 'group-toggle');
  const caret = mk('span', 'caret', openGroups[id] ? '▾' : '▸');
  toggle.appendChild(caret);
  toggle.appendChild(mk('span', 'group-name', label));
  toggle.appendChild(mk('span', 'meta', description));
  if (opts.tip) {
    toggle.title = opts.tip;
  }
  head.appendChild(toggle);
  if (opts.head) {
    head.appendChild(opts.head);
  }
  box.appendChild(head);

  const body = mk('div', 'group-body');
  box.appendChild(body);

  // 登記在整個分組上：標題欄、分組內的空白、空提示行都能右鍵。
  const menu = opts.section
    ? () => [
        ...(opts.extraItems?.() ?? []),
        ...newItemsIn(opts.section!, opts.root),
        { sep: true as const },
        ...baseMenuItems(),
      ]
    : opts.extraItems
      ? // 沒有落點目錄的分組（「出場人物 · 未建卡」）：只掛批次動作與通用項。
        () => [...(opts.extraItems?.() ?? []), ...baseMenuItems()]
      : undefined;
  if (menu) {
    onContextMenu(box, menu);
    if (opts.panel) {
      onContextMenu(opts.panel, menu);
    }
  }

  const sync = () => {
    caret.textContent = openGroups[id] ? '▾' : '▸';
    body.innerHTML = '';
    if (!openGroups[id]) {
      return;
    }
    for (const row of opts.build()) {
      body.appendChild(row);
    }
  };
  toggle.addEventListener('click', () => {
    openGroups[id] = !openGroups[id];
    sync();
  });
  sync();
  return box;
}

/** 還不是小說工程時的引導。 */
export function buildInitPrompt(): HTMLElement {
  const box = mk('div', 'project-empty');
  box.appendChild(mk('p', undefined, '當前工作區還不是 Novelwarden 小說工程。'));

  const btn = mk('button', 'primary', '初始化小說工程');
  btn.addEventListener('click', () => projectAction('initProject'));
  box.appendChild(btn);

  box.appendChild(mk('p', 'hint', '會建立 chapters/ 與 .novelwarden/ 目錄及模板檔案。'));
  return box;
}

/**
 * 定稿進度橫幅，在「概覽」頁的最上面。
 *
 * 只說「76 章還沒定稿」的話，使用者不知道分母，也看不出同步跑到哪了。
 * 這裡給出「已定稿 N/M」與一條進度條，同步過程中每章重新整理一次
 * （後端 pushState 會重推整棵樹）。
 *
 * 分母是**已有正文的章**（`summarizedCount + staleCount`），不是全部章：
 * 只有細綱、還沒寫正文的章無從定稿，算進分母會讓進度條永遠到不了頭。
 */
export function buildSummaryBanner(tree: ProjectTree): HTMLElement {
  const banner = mk('div', 'banner banner-summary');

  const line = mk('div', 'banner-line');
  line.appendChild(
    mk('span', undefined, `${tree.staleCount} 章寫了正文還沒同步（或同步之後正文又改過），這些章的連續性事實與出場人物不會進入上下文。`)
  );
  line.appendChild(spacer());
  // 同步在跑時不再顯示「立即同步」——點第二次只會撞上「已有任務在進行」。
  // 任務名與 features/summarize.ts 的 runTask 名字必須一字不差，否則這裡
  // 永遠匹配不上，橫幅上會一直掛著一個點了就報錯的按鈕。
  if (!hasTask('同步章節細綱')) {
    line.appendChild(linkBtn('立即同步', () => projectAction('syncSummaries')));
  }
  banner.appendChild(line);

  const done = tree.summarizedCount;
  const total = done + tree.staleCount;
  if (total > 0) {
    const percent = Math.round((done / total) * 100);
    const bar = mk('div', 'sum-bar');
    const fill = mk('div', 'sum-fill');
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    banner.appendChild(bar);
    banner.appendChild(mk('div', 'meta sum-meta', `已同步 ${done} / ${total} 章（${percent}%）`));
  }
  return banner;
}

/** 分組副標題：待辦數與總量一起給，不必展開就知道定稿覆蓋到什麼程度。 */
export function summaryGroupLabel(tree: ProjectTree): string {
  const total = tree.summarizedCount + tree.staleCount;
  if (total === 0) {
    return tree.plotCount === 0 ? '還沒有章節' : '還沒有正文';
  }
  return tree.staleCount > 0
    ? `已同步 ${tree.summarizedCount}/${total} 章 · ${tree.staleCount} 章待同步`
    : `${total} 章已全部同步`;
}

/** 頂層分組的副標題：檔案總數（含子資料夾裡的）。 */
export function countLabel(nodes: ProjectNode[], unit: string): string {
  let files = 0;
  let folders = 0;
  const walk = (list: ProjectNode[]) => {
    for (const n of list) {
      if (n.kind === 'dir') {
        folders++;
        walk(n.children);
      } else {
        files++;
      }
    }
  };
  walk(nodes);
  return folders > 0 ? `${files} ${unit} · ${folders} 個資料夾` : `${files} ${unit}`;
}

/**
 * 「文風與摘要」那一組：全文大綱、文風指南兩行。情節大綱在「故事架構」那一組，敘事線在自己的頁籤。
 *
 * 這幾行是工程的固定檔案，不給類檔案操作（`buildFileRow` 不傳 depth 即可），
 * 但它們的「重建」「從正文提取」是常用動作，照舊留在行內（懸停才亮）。
 *
 * 從前這一組底下還有一行工具（同步過期細綱、提取/更新角色卡，右鍵再加批次拆細綱、批次寫章），
 * 是單章摘要時代留下的：細綱並進 summaries/ 之後只改了字沒挪地方，四件事在別處都有入口——
 * 同步在「概覽」頁頂的黃條上，提取角色卡在「角色」組右鍵，兩個批次在「章節」組右鍵。
 */
export function buildMetaRows(tree: ProjectTree): HTMLElement[] {
  const rows: HTMLElement[] = [];

  const global = buildFileRow(
    {
      label: '全文大綱',
      relPath: tree.globalSummaryPath,
      // `globalSummaryThrough` 記的是**章號**。
      detail:
        tree.globalSummaryThrough > 0
          ? `覆蓋至第 ${tree.globalSummaryThrough} 章${
              tree.globalSummaryThrough < tree.plotCount ? ' ⚠ 落後於正文' : ''
            }`
          : '未生成',
    },
    '📖'
  );
  global.appendChild(rowActions(linkBtn('重建', () => projectAction('rebuildGlobalSummary'))));
  onContextMenu(global, () => [
    { label: '開啟', run: () => openPath(tree.globalSummaryPath) },
    { label: '重建全文大綱', run: () => projectAction('rebuildGlobalSummary') },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(global);

  const style = buildFileRow({ label: '文風指南', relPath: tree.styleGuidePath, detail: '' }, '🎨');
  style.appendChild(
    rowActions(
      linkBtn('從正文提取', () => projectAction('extractStyle')),
      linkBtn('從參考書學', () => projectAction('learnFromReference'))
    )
  );
  onContextMenu(style, () => [
    { label: '開啟', run: () => openPath(tree.styleGuidePath) },
    { label: '從正文提取文風', run: () => projectAction('extractStyle') },
    // 別人的書放進工程：只學怎麼寫——文風寫這裡，結構與節奏寫成一份「規劃」階段的技能。
    { label: '從參考書學寫法（選一本 txt）…', run: () => projectAction('learnFromReference') },
    { sep: true },
    ...baseMenuItems(),
  ]);
  rows.push(style);

  // 情節大綱不在這一組：它是「故事架構」那一組的第六行（後面一切的上游）。敘事線也不在：它單佔一個頁籤
  // （敘事線重做第 8 個提交，`threads.ts`），從前這一組裡那一行計數刪了。

  return rows;
}

/** 行內操作的容器。平時藏起來，hover 才亮。 */
function rowActions(...buttons: HTMLElement[]): HTMLElement {
  const box = mk('span', 'row-actions');
  box.append(...buttons);
  return box;
}
