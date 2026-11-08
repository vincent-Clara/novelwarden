/**
 * 工程頁樹上的各種行。
 *
 * **樹是扁平渲染的**：`renderNodes` 遞迴遍歷 `ProjectNode`，但產出的是扁平的
 * 行陣列，層級靠 `paddingLeft` 縮排表達而非巢狀 DOM——摺疊一個資料夾只需要
 * 重畫它所在的分組，不必搬 DOM 子樹。
 *
 * 樹上的行**不掛行內按鈕**，全部操作走右鍵選單（頁面才幹淨）。例外只有三處：
 * 下一個該寫的章行尾的「去寫這一章」、故事架構第一件沒填的那一行的「去生成」（全頁各一顆），
 * 以及「文風與摘要」那兩行懸停才亮的「重建」「從正文提取」之類——它們不是檔案管理區。
 */
import { el as mk } from '../../dom';
import type { MenuItem } from '../../globals';
import { FINALIZE_CALLS, LORE_ENTRY_CALLS, LORE_EXPAND_CALLS, OUTLINE_TARGET, PLOT_STAGE_LABEL, TRANSCRIBED_CALLS, describeCalls, labelOf, outlineNextRange } from '../../protocol';
import type {
  ArchitectureRow,
  CastConflictView,
  CastEntry,
  CreationTarget,
  FailureView,
  LoreThinEntry,
  LoreUnfiledEntry,
  ProjectPlotNode,
  ProjectDirNode,
  ProjectFile,
  ProjectNode,
  ProjectTree,
  VolumeView,
} from '../../protocol';
import { linkBtn } from '../buttons';
import { formatWords } from '../format';
import { openIdeaForm } from '../forms';
import { onContextMenu } from '../menu';
import { setPendingCommand } from '../composer';
import { showTab } from '../tabs';
import { openPath, store, vscode } from '../store';
import {
  baseMenuItems,
  characterAction,
  entryItems,
  expandLore,
  fileAction,
  newItemsIn,
  openDraft,
  projectAction,
} from './actions';
import type { Section } from './actions';
import { SECTIONS } from './actions';
import { showProjectTab } from './tabs';
import type { ProjectTab } from './tabs';
import { foldedVolumes, indentOf, lastTree, loreView, openFolders, openGroups } from './treeState';
import { openChapterMessage } from '../../narrow';

/**
 * 失敗標記。有未解決的失敗記錄時插在檔名之前，滑鼠移上去看原因
 * （浮窗在 [errorTip.ts](errorTip.ts)，事件委託抓 `.row-failure`）。
 *
 * 為什麼不做成行內的一段文字：失敗資訊有好幾行，攤在樹上會把行撐爆，
 * 而絕大多數時候樹上一個失敗都沒有。一個感嘆號 + 懸停展開是最省地方的形態。
 *
 * 只要有一條是 `error`（整體失敗、目標未改動）就按紅色算——那比「部分完成」
 * 嚴重，不能被同一目標上的一條黃色記錄蓋過去。
 */
export function failureMark(relPath: string): HTMLElement | null {
  const failures: FailureView[] | undefined = lastTree?.failures?.[relPath];
  if (!failures || failures.length === 0) {
    return null;
  }
  const hasError = failures.some((f) => f.severity === 'error');
  const mark = mk('span', `row-failure ${hasError ? 'is-error' : 'is-warn'}`, '❗');
  mark.dataset.failureKey = relPath;
  // 原生 title 作兜底：浮窗要等 300ms，而且它只在工程頁裡裝了事件委託。
  mark.title = failures[0].message;
  return mark;
}

/** 由 index.ts 注入：摺疊狀態變了要重畫一遍樹。 */
let rerender: () => void = () => {};

export function bindRerender(fn: () => void): void {
  rerender = fn;
}

/** 切到某個頂層分組所在的頁籤，展開它並滾到它。重畫會換掉全部節點，所以先重畫再找。 */
function revealGroup(group: { id: string; tab: ProjectTab }): void {
  openGroups[group.id] = true;
  rerender();
  showProjectTab(group.tab);
  document.querySelector<HTMLElement>(`#projectBody [data-group="${group.id}"]`)?.scrollIntoView?.({ block: 'start' });
}

/**
 * 遞迴渲染一層節點，返回扁平的行陣列。
 *
 * `section` 是角色區或設定區（工程頁只有這兩個區按目錄樹畫），決定檔案行怎麼畫與「在此新建」建什麼；
 * `tree` 用來按 relPath 查出場統計 / 出現章。
 *
 * `match` 給了就是在篩選（「設定」組標題旁的篩選框）：只畫匹配的檔案，沒有匹配的資料夾
 * 整個不畫，有匹配的資料夾一律展開——匹配的那一條藏在摺疊著的目錄裡，等於沒篩出來。
 * 展開集合 `openFolders` 不動，清掉篩選就回到原來的開合。
 */
export function renderNodes(
  nodes: ProjectNode[],
  depth: number,
  section: Section,
  tree?: ProjectTree,
  match?: (f: ProjectFile) => boolean
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      if (match) {
        const inner = renderNodes(node.children, depth + 1, section, tree, match);
        if (inner.length > 0) {
          rows.push(buildFolderRow(node, depth, section, true), ...inner);
        }
        continue;
      }
      rows.push(buildFolderRow(node, depth, section));
      if (openFolders.has(node.relPath)) {
        rows.push(
          ...(node.children.length === 0
            ? [emptyRow('（空資料夾）', depth + 1)]
            : renderNodes(node.children, depth + 1, section, tree))
        );
      }
    } else if (match && !match(node)) {
      continue;
    } else if (section === SECTIONS.characters) {
      rows.push(buildCharacterRow(node, depth, tree));
    } else {
      rows.push(buildLoreRow(node, depth, tree));
    }
  }
  return rows;
}

/**
 * 資料夾行。點行體展開/摺疊，其餘操作走右鍵。摺疊狀態不進後端。
 *
 * `forced`：篩選中被強制展開的資料夾（見 `renderNodes`）。這時點它、右鍵「摺疊」都沒有
 * 看得見的效果（篩選不清，它就一直開著），所以乾脆不掛——免得悄悄改掉清篩選之後的開合。
 */
function buildFolderRow(node: ProjectDirNode, depth: number, section: Section, forced = false): HTMLElement {
  const row = mk('div', `row row-dir${forced ? ' row-dir-forced' : ''}`);
  row.style.paddingLeft = `${indentOf(depth)}px`;
  const open = forced || openFolders.has(node.relPath);

  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);

  const label = mk('span', 'row-label row-dir-label', `${open ? '📂' : '📁'} ${node.label}`);
  label.title = forced ? `${node.relPath}\n篩選中：有匹配的資料夾一律展開` : node.relPath;
  row.appendChild(label);

  row.appendChild(mk('span', 'meta', node.fileCount > 0 ? `${node.fileCount} 項` : '空'));

  const toggle = () => {
    if (openFolders.has(node.relPath)) {
      openFolders.delete(node.relPath);
    } else {
      openFolders.add(node.relPath);
    }
    rerender();
  };
  if (!forced) {
    caret.addEventListener('click', toggle);
    label.addEventListener('click', toggle);
  }

  onContextMenu(row, () => {
    const head: MenuItem[] = forced ? [] : [{ label: open ? '摺疊' : '展開', run: toggle }, { sep: true }];
    return [
      ...head,
      // 「在此新建」的落點是這個資料夾自己，不是區根目錄。
      ...newItemsIn(section, node.relPath),
      { sep: true },
      ...entryItems(node.relPath),
    ];
  });
  return row;
}

/**
 * 點這一行（或右鍵第一項）開啟哪一份檔案：正文 → 細綱，取第一個存在的。
 * 兩份都還沒有時退回主路徑（細綱應該在的位置）——開啟它會得到一個「檔案不存在」，
 * 但這一行本來就只在其中一份存在時才出現（空章號不補行）。
 */
function openTargetOf(p: ProjectPlotNode): string {
  return p.chapterPath || (p.plotExists ? p.plotPath : '') || p.relPath;
}

/**
 * 章節組的一行：**一個章號**。細綱號 = 章號，所以一行同時報細綱與正文兩面：
 * 狀態徽章說這一章該做哪一步，字數寫著「寫了多少 / 目標多少」，⟳ 說上游變過。
 *
 * **下一個該寫的章**在行尾多一個「去寫這一章」——樹行一律不掛行內按鈕，這是唯一的
 * 例外（W2）：掃一眼就知道從哪接著寫，而且全書只有這一行有，不會變成一排按鈕。
 * 它只是「進入這一章」，真正花錢的那一下仍然是對話頁的主按鈕（第 20 條：只推一個）。
 */
function buildPlotRow(p: ProjectPlotNode, nextNo: number, depth = 0): HTMLElement {
  // row-plot + data-plot 是懸停浮窗的抓手：事件委託在 projectBody 上，
  // 行被重渲染丟棄也不會留下失效的監聽器。
  const row = mk('div', `row row-plot${p.no === nextNo ? ' row-next' : ''}`);
  row.dataset.plot = p.relPath;
  row.style.paddingLeft = `${indentOf(depth)}px`;

  // 圓點報定稿：細綱照正文更新過、而且對得上。還沒寫正文的章無從定稿——那不是「過期」，
  // 是還沒到那一步，給它一個空心點會讓整列看起來全是待辦。
  const written = !!p.chapterPath && p.wordCount > 0;
  const dot = mk('span', `dot${written && p.stale ? ' stale' : ''}`, written ? (p.stale ? '○' : '●') : '·');
  dot.title = !written ? '還沒寫正文' : p.stale ? '還沒同步（或同步之後正文又改過）' : '已同步（細綱與正文對得上）';
  row.appendChild(dot);

  // 生成失敗過：與「過期」是兩回事——過期只說明該重跑，這個說明跑過但沒成。
  // 兩側路徑都要查：定稿失敗掛在正文上，寫細綱/寫正文失敗掛在細綱上。
  const mark = (p.chapterPath ? failureMark(p.chapterPath) : undefined) ?? failureMark(p.plotPath);
  if (mark) {
    row.appendChild(mark);
  }

  const opens = openTargetOf(p);
  const label = mk('span', 'row-label', p.label);
  label.title = p.chapterPath
    ? `${p.chapterPath}\n點選開啟正文，細綱並排在旁邊（還沒有就按模板建一份；上一次並排開的是草稿就開草稿）；右鍵「進入這一章」去做下一步`
    : `${opens}\n點選在編輯器裡開啟；右鍵「進入這一章」去做下一步`;
  // 點名字 = **開啟這一章**（W6 章節工作臺）：正文在主區、細綱並排在旁邊。在工程頁上掃
  // 章節列表時，想看的多半就是這一章寫成了什麼樣、對不對得上細綱。並排是宿主的能力，
  // 由後端按能力決定開幾份、旁邊開細綱還是草稿（跟上一次走，細綱沒有就按模板建）；「進入這一章」在右鍵選單與行尾那顆按鈕裡。
  // 單擊開成臨時標籤（下一次單擊別的章換掉它），雙擊（第二下點選）開成正常標籤——轉正。
  label.addEventListener('click', (e) =>
    vscode.postMessage(openChapterMessage(p.relPath, e.detail < 2))
  );
  row.appendChild(label);

  // 狀態徽章：這一章現在該做哪一步。**已完成的不掛**——一列「已完成」只是噪聲。
  if (p.stage !== 'done') {
    const stage = mk('span', `row-stage stage-${p.stage}`, PLOT_STAGE_LABEL[p.stage]);
    stage.title = describeProgress(p);
    row.appendChild(stage);
  }

  // 上游變過（大綱那一節 / 細綱改了）。用 ⟳ 而不是感嘆號：這不是錯誤，
  // 是「回頭看一眼」——與失敗標記要分得開。
  if (p.upstreamStale) {
    const stale = mk('span', 'row-upstream', '⟳');
    stale.title = '上游產物改過，這一章可能需要回頭看';
    row.appendChild(stale);
  }

  // 「2980 / 3000」比單報字數多說一件事：寫夠沒有。字數後面跟「草稿」，不新增 DOM。
  const words =
    p.wordCount > 0
      ? p.targetWords
        ? `${p.wordCount} / ${p.targetWords}`
        : formatWords(p.wordCount)
      : '未寫';
  row.appendChild(mk('span', 'meta', words + (p.hasDraft ? ' · 草稿' : '')));

  if (p.no === nextNo) {
    const go = mk('button', 'chip-btn row-go', '去寫這一章');
    go.title = '進入這一章：對話頁的主按鈕就是它的下一步';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath });
    });
    row.appendChild(go);
  }

  onContextMenu(row, () => {
    // 開啟哪一份：與點名字同序（正文 → 細綱），點行做的那件事在選單裡排第一。
    const items: MenuItem[] = [];
    if (p.chapterPath) {
      items.push({ label: '開啟正文', run: () => openPath(p.chapterPath) });
    }
    if (p.plotExists) {
      items.push({ label: '開啟細綱', run: () => openPath(p.plotPath) });
    }
    items.push(
      { sep: true },
      // 這一行唯一「會切頁」的動作，單獨一段。
      { label: '進入這一章', run: () => vscode.postMessage({ type: 'selectPlot', plotRelPath: p.relPath }) },
      { sep: true },
      // 兩層入口。點哪一層就把創作頁切到那一層——狀態機給的是「該做的下一步」，
      // 而作者常常要回頭改上一層。
      { label: `細綱（${pct(p.progress.plot)}）`, run: () => setTarget({ kind: 'plot', plotRelPath: p.plotPath }) },
      {
        label: `正文（${pct(p.progress.manuscript)}）`,
        run: () => setTarget({ kind: 'manuscript', plotRelPath: p.plotPath }),
      },
      { sep: true }
    );

    // 重寫、定稿、草稿都只對有正文的章成立——讀的都是正文。
    if (written) {
      items.push({ label: '重寫正文', run: () => rewriteManuscript(p.plotPath) });
      // 定稿 = 照正文更新細綱（帶連續性事實）+ 出場角色的當前狀態（四期，D17）+ 這一章在敘事線上發生了什麼
      // （敘事線重做：認事件、當前進度、歸併）。呼叫次數與主按鈕同源。後端先彈確認框挑這一次的模型。
      items.push({
        label: p.stale ? `同步（細綱 + 角色狀態 + 敘事線 + 故事時間，${describeCalls(FINALIZE_CALLS).replace(/（.*）$/, '')}）` : '重新同步',
        run: () => projectAction('askFinalizeChapter', p.chapterPath),
      });
      // 單獨記設定（設定名錄，作者定案）：只對定稿過、正文沒再改過的章——沒定稿的「設定」一節是計劃，
      // 記了也會被定稿沖掉。定稿時本來就會順手記，這裡是重記一次、或補老章節。
      if (!p.stale) {
        items.push({
          label: `記設定（${describeCalls(TRANSCRIBED_CALLS).replace(/（.*）$/, '')}）`,
          run: () => projectAction('recordLore', p.chapterPath),
        });
      }
    }
    if (p.chapterPath) {
      // 草稿按需建立：沒有就建一個再開啟，文案據此區分。
      items.push({ label: p.hasDraft ? '開啟草稿' : '新建草稿', run: () => openDraft(p.chapterPath) });
      items.push({ sep: true });
    }

    // 改名/刪除落在**主路徑**上：有正文就是正文（草稿跟著走），
    // 只有細綱就是細綱。**沒有「移動到…」**：順序由章號決定。
    items.push(
      { label: '重新命名', run: () => fileAction('rename', p.relPath) },
      { label: '刪除（移到回收站）', danger: true, run: () => fileAction('delete', p.relPath) }
    );
    return items;
  });
  return row;
}

/** 章節組的全部行。扁平列表——順序即章號。 */
export function buildPlotRows(plots: ProjectPlotNode[], nextNo: number): HTMLElement[] {
  return plots.map((p) => buildPlotRow(p, nextNo));
}

/**
 * 分了卷的書（2026-10-23）：一卷一個可摺疊的標題行，下面是這一卷的章，卷裡照舊按章號。
 * 卷的先後、哪一卷是新章的落點都是後端排好的（`ProjectTree.volumes`）。
 */
export function buildVolumeRows(tree: ProjectTree): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const v of tree.volumes) {
    rows.push(buildVolumeRow(v, tree.chaptersRoot));
    if (foldedVolumes.has(v.relPath)) {
      continue;
    }
    const plots = tree.plots.filter((p) => p.volume === v.name);
    rows.push(
      ...(plots.length === 0
        ? [emptyRow(v.latest ? '（空卷：接下來新建的章落在這裡）' : '（空卷）', 1)]
        : plots.map((p) => buildPlotRow(p, tree.nextChapterNo, 1)))
    );
  }
  return rows;
}

/**
 * 卷的標題行：`📂 第二卷  第 31–45 章 · 4.2 萬字`。點行體摺疊 / 展開，其餘走右鍵。
 * 直接放在章節根下的那幾章叫「未分卷」：它不是目錄，右鍵沒有重新命名與刪除。
 */
function buildVolumeRow(v: VolumeView, chaptersRoot: string): HTMLElement {
  const row = mk('div', `row row-dir row-volume${v.latest ? ' is-latest' : ''}`);
  row.dataset.volume = v.relPath;
  row.style.paddingLeft = `${indentOf(0)}px`;
  const open = !foldedVolumes.has(v.relPath);

  const caret = mk('span', 'caret', open ? '▾' : '▸');
  row.appendChild(caret);

  const label = mk('span', 'row-label row-dir-label', `${open ? '📂' : '📁'} ${v.name || '未分卷'}`);
  label.title = v.name ? v.relPath : `${v.relPath}/\n直接放在章節根下、不在哪一卷裡的章`;
  row.appendChild(label);

  const span = v.from === undefined ? '空' : v.from === v.to ? `第 ${v.from} 章` : `第 ${v.from}–${v.to} 章`;
  const meta = mk('span', 'meta', `${span}${v.words > 0 ? ` · ${formatWords(v.words)}` : ''}${v.latest ? ' · 新章落這裡' : ''}`);
  if (v.latest) {
    meta.title = '新建細綱、新建章節檔案、拆細綱排出的新章預設落進這一卷';
  }
  row.appendChild(meta);

  const toggle = () => {
    if (foldedVolumes.has(v.relPath)) {
      foldedVolumes.delete(v.relPath);
    } else {
      foldedVolumes.add(v.relPath);
    }
    rerender();
  };
  caret.addEventListener('click', toggle);
  label.addEventListener('click', toggle);

  onContextMenu(row, () => [
    { label: open ? '摺疊' : '展開', run: toggle },
    { sep: true },
    {
      label: v.name ? '在此卷新建章節檔案' : '新建章節檔案（不放進卷裡）',
      run: () => projectAction('newChapter', undefined, v.relPath),
    },
    { label: '新建卷…', run: () => projectAction('newFolder', undefined, chaptersRoot) },
    // 卷就是一個目錄：改名時細綱、草稿跟著走（閘道器的 carryPlot / carryDraft）；刪除只把正文挪進回收站，
    // 細綱留著、退回那幾章的計劃（與刪一章同一個規矩）。沒有「移動到…」——卷不進卷。
    ...(v.name
      ? [
          { sep: true as const },
          { label: '重新命名', run: () => fileAction('rename', v.relPath) },
          { label: '刪除（移到回收站）', danger: true, run: () => fileAction('delete', v.relPath) },
        ]
      : []),
  ]);
  return row;
}

/**
 * 「故事架構」組的一行：小說配置 / 故事前提 / 角色圖譜 / 世界觀 / 設定清單 / 情節大綱。
 *
 * 點名字開啟那份檔案；角色圖譜、設定清單沒有自己的檔案：已有卡 / 條目時點它切到「角色」/「設定」
 * 頁籤，還沒有時進入那一層（對話頁的主按鈕是「生成角色圖譜 / 設定清單」）。已填的右鍵「討論」
 * 進入這一層，「重寫…」問一句要求後直接重新生成；沒填的右鍵「進入這一層」去生成。
 *
 * **第一件還沒填的**在行尾多一個「去生成」（與章節組的「去寫這一章」同一個道理：
 * 掃一眼就知道從哪接著做，全組只有這一行有）。小說配置那一行直接開啟一句話彈窗；
 * 其餘幾行進入那一層，真正花錢的那一下仍是對話頁的主按鈕（第 20 條：只推一個）。
 */
function buildArchitectureRow(a: ArchitectureRow, isNext: boolean, tree?: ProjectTree): HTMLElement {
  const row = mk('div', 'row row-plot row-architecture');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', `dot${a.filled ? '' : ' stale'}`, a.filled ? '●' : '○');
  dot.title = a.filled ? '已填寫' : '還沒填寫';
  row.appendChild(dot);

  const mark = failureMark(a.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const target: CreationTarget = a.key === 'outline' ? { kind: 'outline' } : { kind: 'setting', doc: a.key };
  // 沒有自己檔案的兩件：它就是下面那一組。
  const group = GROUP_OF[a.key];
  const label = mk('span', 'row-label', a.label);
  label.title = !group
    ? a.relPath
    : a.filled
      ? `切到「${group.label}」頁籤；右鍵「討論」或「重寫…」`
      : '進入這一層：對話頁的主按鈕就是生成它';
  label.addEventListener('click', (e) => {
    if (!group) {
      openPath(a.relPath, { preview: e.detail < 2 });
    } else if (a.filled) {
      revealGroup(group);
    } else {
      setTarget(target);
    }
  });
  row.appendChild(label);

  if (a.detail) {
    row.appendChild(mk('span', 'meta row-detail', a.detail));
  }

  const idea = () => openIdeaForm(tree?.book);
  const fromText = !!tree?.book.writtenThrough;
  if (isNext) {
    const go = mk('button', 'chip-btn row-go', '去生成');
    go.title =
      a.key === 'config'
        ? fromText
          ? '定好規模，照已寫正文生成小說配置'
          : '寫一句話與規模，生成小說配置'
        : '進入這一層：對話頁的主按鈕就是生成它';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.key === 'config') {
        idea();
      } else {
        setTarget(target);
      }
    });
    row.appendChild(go);
  }

  onContextMenu(row, () => [
    ...(group ? [] : [{ label: '開啟', run: () => openPath(a.relPath) }]),
    ...(a.key === 'config' ? [{ label: fromText ? '照已寫正文生成…' : '從一句話生成…', run: idea }] : []),
    // 已填的：討論只是進入這一層（不花錢），重寫直接發一輪生成（先問一句要求，覆蓋前照樣對比）。
    ...(a.filled
      ? [
          { label: '討論', run: () => setTarget(target) },
          { label: '重寫…', run: () => vscode.postMessage({ type: 'rewriteArchitecture', target }) },
        ]
      : [{ label: '進入這一層（去生成）', run: () => setTarget(target) }]),
    // 情節大綱往後排一段：已填的、沒填的都給（沒填就是從第 1 章排起）。
    ...(a.key === 'outline' && tree ? [continueOutlineItem(tree)] : []),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/**
 * 「續寫大綱（第 a–b 章）」：工程頁「情節大綱」那一行與「章節」組標題的右鍵裡各一份（2026-10-24）。對話頁輸入框上方
 * 掛一枚「/續寫大綱」，等作者寫下要求（可留空）再點傳送——與章節右鍵「重寫正文」同一個路子，不自己開寫，呼叫次數寫在
 * 命令的提示裡。它是跨層命令：會話停在哪一章都不動，跑完回到那裡。區間與後端真續的那一段同一個演算法（`outlineNextRange`）；
 * 已經排到全書最後一章時置灰。
 */
export function continueOutlineItem(tree: ProjectTree): MenuItem {
  const coverage = tree.book.outlineCoverage ?? 0;
  const total = tree.book.totalChapters;
  const { from, to } = outlineNextRange({ outlineFilled: coverage > 0, outlineCoverage: coverage, totalChapters: total });
  if (total && from > total) {
    return { label: `續寫大綱（已排到第 ${coverage} 章，全書共 ${total} 章）`, disabled: true };
  }
  return {
    label: `續寫大綱（${from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`}）`,
    run: () => {
      // 正在生成時不掛，免得那一輪完了一傳送就續了（同「重寫正文」）。
      if (store.busy) {
        return;
      }
      showTab('chat');
      vscode.postMessage({ type: 'switchTab', tab: 'chat' });
      setPendingCommand({ capability: 'generate', label: labelOf('outline', 'generate'), stage: 'outline', target: OUTLINE_TARGET });
    },
  };
}

/**
 * 「故事架構」組的全部行。順序即生成順序：每一件都吃前面幾件——所以「去生成」
 * 只掛在第一件沒填的那一行上。
 */
export function buildArchitectureRows(rows: ArchitectureRow[], tree?: ProjectTree): HTMLElement[] {
  const next = rows.findIndex((r) => !r.filled);
  return rows.map((r, i) => buildArchitectureRow(r, i === next, tree));
}

/**
 * 沒有自己檔案的架構件 → 它在工程頁上的那一組（分組 id 與 index.ts 的 `buildGroup` 一致）
 * 與那一組所在的頁籤。
 */
const GROUP_OF: Partial<Record<ArchitectureRow['key'], { id: string; label: string; tab: ProjectTab }>> = {
  characters: { id: 'characters', label: '角色', tab: 'characters' },
  lore: { id: 'lore', label: '設定', tab: 'lore' },
};

/** 三段完成度，滑鼠移上去看得見。 */
function describeProgress(p: ProjectPlotNode): string {
  return (
    `${PLOT_STAGE_LABEL[p.stage]}\n` +
    `細綱 ${pct(p.progress.plot)}｜正文 ${pct(p.progress.manuscript)}｜同步 ${pct(p.progress.summary)}`
  );
}

function pct(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function setTarget(target: CreationTarget): void {
  vscode.postMessage({ type: 'setTarget', target });
}

/**
 * 章節右鍵「重寫正文」：創作頁切到這一章的正文層，輸入框上方掛一枚「/重寫正文」，等作者寫下要求再點傳送——
 * 不自己開寫。正文已經有字，發出去的「寫正文」後端就按重寫走（`resolveWriteMode`），寫完先對比再寫入。
 */
function rewriteManuscript(plotRelPath: string): void {
  const target: CreationTarget = { kind: 'manuscript', plotRelPath };
  setTarget(target);
  // 正在生成時後端不切、說一句；這裡也不掛，免得那一輪完了一傳送就重寫了別的章。
  if (!store.busy) {
    setPendingCommand({ capability: 'generate', label: '重寫正文', stage: 'manuscript', target });
  }
}

/**
 * 角色/設定/後設資料行。
 *
 * `depth` 為 undefined 時不設縮排，也不掛類檔案操作的右鍵選單——
 * 「文風與摘要」那幾行是工程的固定檔案，不能重新命名/移動/刪除。
 */
export function buildFileRow(f: ProjectFile, icon: string, depth?: number): HTMLElement {
  const row = mk('div', 'row');
  if (depth !== undefined) {
    row.style.paddingLeft = `${indentOf(depth)}px`;
  }

  row.appendChild(mk('span', 'dot', icon));

  // 失敗標記排在名字之前：掃一列檔名時，異常的那幾行第一眼就跳出來。
  const mark = failureMark(f.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', f.label);
  label.title = f.relPath;
  // 單擊開成臨時標籤，雙擊轉正（見章節那一行）。
  label.addEventListener('click', (e) => openPath(f.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  if (f.detail) {
    row.appendChild(mk('span', 'meta row-detail', f.detail));
  }
  if (depth !== undefined) {
    onContextMenu(row, () => [
      { label: '開啟', run: () => openPath(f.relPath) },
      { sep: true },
      ...entryItems(f.relPath),
    ]);
  }
  return row;
}

/**
 * 角色行。比普通檔案行多兩樣東西：出場段落副標題，以及「更新角色卡」選單。
 *
 * 出場統計來自後端的 `castByCard`（按定稿過的細綱聚合），前端不自己算——
 * 「第 3、7、12 章」這句話在日誌裡也要出現，兩處文案必須一致。
 */
function buildCharacterRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.castByCard[f.relPath] ?? null;
  const detail = [f.detail, stats && stats.plots.length > 0 ? `出場 ${stats.plots.length} 章` : '']
    .filter(Boolean)
    .join(' · ');
  const row = buildFileRow({ ...f, detail }, SECTIONS.characters.icon, depth);

  // 上次更新之後又出場了若干章：給個小標記，作者一眼看出這張卡該刷了。
  if (stats && stats.pending > 0) {
    const flag = mk('span', 'meta cast-pending', `＋${stats.pending}`);
    flag.title = `上次更新覆蓋到第 ${stats.updatedThrough} 章，此後新增 ${stats.pending} 章出場`;
    row.appendChild(flag);
  }

  onContextMenu(row, () => {
    const items: MenuItem[] = [{ label: '開啟', run: () => openPath(f.relPath) }, { sep: true }];
    if (stats && stats.plots.length > 0) {
      items.push(
        {
          label: stats.pending > 0 ? `更新角色卡（新增 ${stats.pending} 章）` : '更新角色卡',
          run: () => characterAction('updateCard', f.label, f.relPath),
        },
        {
          label: `重新通讀全部 ${stats.plots.length} 章`,
          run: () => characterAction('rebuildCard', f.label, f.relPath),
        },
        { label: `出場：${stats.detail}`, disabled: true }
      );
    } else {
      items.push({ label: '未在同步過的章裡出現，無法自動更新', disabled: true });
    }
    // 定稿時這張卡的當前狀態你改過、沒被覆蓋（D15）：拿機器給的那一版對比，決定用不用。
    const guarded = lastTree?.failures?.[f.relPath]?.find((x) => x.op === 'cardState');
    if (guarded) {
      const no = /第 (\d+) 章/.exec(guarded.message)?.[1];
      items.push(
        { sep: true },
        { label: `對比第 ${no ?? '?'} 章給出的狀態…`, run: () => characterAction('reviewState', f.label, f.relPath) }
      );
    }
    items.push({ sep: true }, ...entryItems(f.relPath));
    return items;
  });
  return row;
}

/**
 * 設定行。比普通檔案行多兩樣東西：出現章（「第 3–57 章 · 12 章」）與「＋N」待整合標記。
 *
 * 出現章來自後端的 `loreByEntry`（`views/lore.ts` 從定稿過的細綱「設定」一節算的），前端不自己算——
 * 與角色行的 `castByCard` 同一個道理。副標題仍是那一句 brief（沒有就是關鍵詞，後端給好了）。
 *
 * 出現章**另起一格放在右邊、不截斷**，不像角色行那樣並進副標題：brief 常常二三十字，
 * 並進同一格的話出現章永遠被省略號吃掉，而幾百條裡掃一眼要看的恰恰是「哪條用得多、用到哪了」。
 * 被擠掉的是 brief，懸停浮窗（detailTip）照樣看得全。
 *
 * 右鍵選單在開啟與類檔案操作之間多兩項：「整合這一條」（有待整合的才有）與「展開…」（每一條都有，完善設定）。
 */
function buildLoreRow(f: ProjectFile, depth: number, tree?: ProjectTree): HTMLElement {
  const stats = tree?.loreByEntry[f.relPath] ?? null;
  const row = buildFileRow(f, SECTIONS.lore.icon, depth);
  row.classList.add('row-lore');

  if (stats?.detail) {
    row.appendChild(mk('span', 'meta lore-span', stats.detail));
  }

  // 水位之後又有幾章寫到了它：與角色卡的「＋N」同一個樣子——沒跟上正文不是錯誤，是件待辦。
  if (stats && stats.pending > 0) {
    const flag = mk('span', 'meta cast-pending lore-pending', `＋${stats.pending}`);
    flag.title =
      stats.updatedThrough > 0
        ? `第 ${stats.updatedThrough} 章之後又有 ${stats.pending} 章的新內容沒整合進這一條`
        : `有 ${stats.pending} 章的新內容還沒整合進這一條`;
    row.appendChild(flag);
  }
  onContextMenu(row, () => [
    { label: '開啟', run: () => openPath(f.relPath) },
    { sep: true },
    ...(stats && stats.pending > 0
      ? [
          {
            label: `整合這一條（新增 ${stats.pending} 章，${describeCalls(LORE_ENTRY_CALLS).replace(/（.*）$/, '')}）`,
            run: () => projectAction('integrateLore', f.relPath),
          },
        ]
      : []),
    expandItem({ relPath: f.relPath }),
    { sep: true },
    ...entryItems(f.relPath),
  ]);
  return row;
}

/**
 * 「展開…」那一項（完善設定，2026-10-19）：往前想細一條設定——後端先問一句要求，再在對話頁把目標換成這一條、
 * 發一輪生成，寫好的照常上卡片、作者點了才落盤。次數寫法同「建條目」「整合這一條」（第 4 條：動手前寫明）。
 */
function expandItem(target: Parameters<typeof expandLore>[0]): MenuItem {
  return { label: `展開…（${describeCalls(LORE_EXPAND_CALLS).replace(/（.*）$/, '')}）`, run: () => expandLore(target) };
}

/**
 * 「待完善」那一組的全部行（完善設定，2026-10-19）。後端按最早要用到的章排好；這一組只列接下來幾章要用的，
 * 不會像「出現過 · 未建條目」那樣拖一條長尾，不分頁。
 */
export function buildLoreThinRows(list: LoreThinEntry[]): HTMLElement[] {
  return list.map(buildLoreThinRow);
}

/**
 * 「待完善」的一行：`天機閣〔宗門〕· 第 12 章起要用 · 只有一句話`。
 *
 * 往前看的一組：還沒寫的幾章細綱「設定」一節點名、卻還沒有條目或條目還只有一句話的設定——與「出現過 · 未建條目」
 * （往回記）正好相反，所以排在它前面。有條目的點名字開啟那一條（同別的設定行）；還沒有條目的點名字不做事
 * （同未建條目：沒有檔案可開，也不該手一滑就多出一個）。右鍵「展開…」，沒有條目的後端先按分類建空條目再展開。
 */
function buildLoreThinRow(t: LoreThinEntry): HTMLElement {
  const missing = !t.relPath;
  // 還沒有條目的複用 row-cast 的壓暗：同樣是「還沒有檔案」的東西。
  const row = mk('div', `row row-lore-thin${missing ? ' row-cast' : ''}`);
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', missing ? '○' : SECTIONS.lore.icon);
  dot.title = missing ? '接下來要用，還沒有設定條目' : '接下來要用，條目還只有一句話';
  row.appendChild(dot);

  if (t.relPath) {
    const mark = failureMark(t.relPath);
    if (mark) {
      row.appendChild(mark);
    }
  }

  const label = mk('span', 'row-label', t.name);
  label.title = `第 ${t.chapters.join('、')} 章要用到\n右鍵「展開…」把它往前想細`;
  if (t.relPath) {
    const relPath = t.relPath;
    label.addEventListener('click', (e) => openPath(relPath, { preview: e.detail < 2 }));
  }
  row.appendChild(label);

  if (t.category) {
    row.appendChild(mk('span', 'meta lore-category', `〔${t.category}〕`));
  }
  row.appendChild(mk('span', 'meta row-detail', t.detail));

  onContextMenu(row, () => [
    ...(t.relPath ? [{ label: '開啟', run: () => openPath(t.relPath!) }, { sep: true as const }] : []),
    expandItem(t.relPath ? { relPath: t.relPath } : { name: t.name, category: t.category }),
    { label: `要用到：第 ${t.chapters.join('、')} 章`, disabled: true },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/**
 * 「出場人物 · 未建卡」的一行。
 *
 * 只有一個動作：建卡（先建一張空卡，再問要不要用它的出場段落跑一次提取），在右鍵裡。
 * 與「出現過 · 未建條目」一樣**點名字不做事**：從前點名字就建卡，掃列表時手一滑角色區就多出
 * 一張空卡，後面那一問取消了它也留著。
 */
export function buildCastRow(c: CastEntry): HTMLElement {
  const row = mk('div', 'row row-cast');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', '○');
  dot.title = '同步過的章裡出現過，還沒有角色卡';
  row.appendChild(dot);

  const label = mk('span', 'row-label', c.name);
  label.title = `${c.aliases.length > 0 ? `又稱 ${c.aliases.join('、')}\n` : ''}右鍵「建立角色卡」`;
  row.appendChild(label);
  row.appendChild(mk('span', 'meta row-detail', c.detail));

  onContextMenu(row, () => [
    { label: '建立角色卡（通讀出場段落）', run: () => characterAction('createCard', c.name) },
    { label: `出場：${c.detail}`, disabled: true },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 「出現過 · 未建條目」一次先畫這麼多行，再多的收在「顯示全部 N 個」後面。 */
const UNFILED_PAGE = 30;

/**
 * 「出現過 · 未建條目」那一組的全部行。
 *
 * 設定會比角色多一個數量級：後端按出現章數降序排好，前面那幾十個才是真該建條目的，
 * 長尾（只出現過一兩次的地名、物件）一口氣攤開會把下面「文風與摘要」頂出好幾屏。
 * 點過「顯示全部」記在 `loreView` 上，重推樹不縮回去。
 */
export function buildLoreUnfiledRows(list: LoreUnfiledEntry[], loreRoot: string): HTMLElement[] {
  const shown = loreView.showAllUnfiled ? list : list.slice(0, UNFILED_PAGE);
  const rows = shown.map((u) => buildLoreUnfiledRow(u, loreRoot));
  if (shown.length < list.length) {
    // 不是 `.row`：它不是名錄裡的一項，沒有右鍵選單，也不該被「這一組有幾行」數進去。
    const more = mk('div', 'hint row-empty row-more');
    more.appendChild(
      linkBtn(`顯示全部 ${list.length} 個`, () => {
        loreView.showAllUnfiled = true;
        rerender();
      })
    );
    rows.push(more);
  }
  return rows;
}

/**
 * 「出現過 · 未建條目」的一行：`名〔分類〕· 5 章 · 第 3 章起`。
 *
 * 兩個動作，都在右鍵裡：「建條目」調模型一次，拿定稿細綱裡提到它的那幾行寫成一條（不重讀正文）；
 * 「新建這條設定」帶著名字發 `newLore`，建一份空條目、不調模型。都落在建議的分類目錄裡
 * （各章「設定」一節寫的多數票；目錄還沒有時後端會建）。
 * 與「出場人物 · 未建卡」不同，**點名字不做事**：掃列表時手一滑就在設定區裡多出一個檔案，
 * 不值得放在最省事的位置。
 */
function buildLoreUnfiledRow(u: LoreUnfiledEntry, loreRoot: string): HTMLElement {
  // 複用 row-cast 的壓暗：同樣是「出現過、還沒有檔案」的東西。
  const row = mk('div', 'row row-cast row-lore-unfiled');
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', '○');
  dot.title = '同步過的章裡出現過，還沒有設定條目';
  row.appendChild(dot);

  const label = mk('span', 'row-label', u.name);
  label.title = `${u.chapters.length > 0 ? `出現在第 ${u.chapters.join('、')} 章\n` : ''}右鍵「建條目」或「新建這條設定」`;
  row.appendChild(label);

  if (u.category) {
    row.appendChild(mk('span', 'meta lore-category', `〔${u.category}〕`));
  }
  row.appendChild(mk('span', 'meta row-detail', u.detail));

  const sub = u.category.replace(/^\/+|\/+$/g, '');
  const dir = sub ? `${loreRoot}/${sub}` : loreRoot;
  onContextMenu(row, () => [
    {
      label: `建條目（${describeCalls(LORE_ENTRY_CALLS).replace(/（.*）$/, '')}）`,
      run: () => projectAction('buildLore', undefined, undefined, u.name),
    },
    { label: '新建這條設定（空的，不調模型）', run: () => projectAction('newLore', undefined, dir, u.name) },
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

export function emptyRow(text: string, depth?: number): HTMLElement {
  const row = mk('div', 'hint row-empty', text);
  if (depth !== undefined) {
    row.style.paddingLeft = `${indentOf(depth)}px`;
  }
  return row;
}

/**
 * 「多張卡搶同一個稱呼」的提示行，掛在角色分組頂部。
 *
 * 出場統計按稱呼歸屬，一個稱呼只能算給一張卡——有衝突就必然有一張的出場
 * 章節是錯的，而這件事從介面上完全看不出來（兩張卡各自都顯示得好好的）。
 * 所以必須顯式說出來，並指向能解決它的那兩個選單項。
 */
export function buildConflictRow(conflict: CastConflictView): HTMLElement {
  const cards = conflict.cards.map((c) => `「${c.name}」`);
  const text =
    conflict.kind === 'name'
      ? `⚠ ${cards.join('、')} 都叫「${conflict.name}」，出場統計只會算給其中一張。` +
        '多半是同一個人建了兩張卡——用本組右鍵的「查詢並合併重複角色卡」。'
      : `⚠ 「${conflict.name}」被 ${cards.join('、')} 同時當作自己的稱呼，出場統計只會算給 ${cards[0] ?? ''}。` +
        '若它們本來就是同一個人，用本組右鍵的「查詢並合併重複角色卡」；若是別名填錯了人，用「清理別名」。';
  return mk('div', 'row-conflict', text);
}
