/**
 * 工程頁的裝配：把樹、分組、橫幅拼成五個頁籤（概覽 / 章節 / 角色 / 設定 / 敘事線，見 tabs.ts）。
 *
 * 摺疊等 UI 狀態完全留在前端（treeState.ts），切一下摺疊走 `rerenderProject`
 * 拿最近那份快照重畫，不必往後端要一次資料。「設定」組的篩選也一樣（loreFilter.ts）。
 */
import { setHidden } from '../../dom';
import { describeCalls, loreExpandCalls } from '../../protocol';
import type { ProjectTree } from '../../protocol';
import { formatWords } from '../format';
import { el } from '../refs';
import { SECTIONS, characterAction, projectAction } from './actions';
import {
  buildGroup,
  buildInitPrompt,
  buildMetaRows,
  buildSummaryBanner,
  countLabel,
  summaryGroupLabel,
} from './groups';
import {
  bindRerender,
  buildArchitectureRows,
  buildCastRow,
  buildConflictRow,
  buildLoreThinRows,
  buildLoreUnfiledRows,
  buildPlotRows,
  buildVolumeRows,
  continueOutlineItem,
  emptyRow,
  renderNodes,
} from './rows';
import { openIdeaForm, openPlotBatchForm, openWriteBatchForm } from '../forms';
import { openCheckpoints } from '../checkpoints';
import { chaptersEmptyRow, charactersEmptyRow, loreEmptyRow, nextStepRow } from './nextSteps';
import { hideDetailTip, installDetailTip } from './detailTip';
import { hideFailureTip, installFailureTip } from './errorTip';
import {
  buildLoreFilter,
  captureLoreFilterFocus,
  filterUnfiled,
  loreFilterComposing,
  loreMatcher,
  restoreLoreFilterFocus,
} from './loreFilter';
import { hideSummaryTip, installSummaryTip } from './summaryTip';
import { buildPanel, installProjectTabs } from './tabs';
import { buildThreadRows, buildTimelineRows, threadsGroupLabel, threadsHead, threadsMenuItems, timelineGroupLabel, timelineGroupTip, timelineHead, timelineMenuItems } from './threads';
import { lastTree, loreView, setLastTree } from './treeState';

export function renderProject(tree: ProjectTree): void {
  setLastTree(tree);
  // 篩選框裡正在用輸入法組字：這時重畫會換掉輸入框、打了一半的字就沒了。樹先記下，
  // 組字結束時（loreFilter.ts 的 compositionend）按最新的這一份重畫。
  if (loreFilterComposing()) {
    return;
  }
  // 整頁重建會換掉篩選框：焦點在裡面（正打著字、旁邊又推來一棵樹）就把焦點與游標放回去。
  const focus = captureLoreFilterFocus();
  buildProjectPage(tree);
  restoreLoreFilterFocus(focus);
}

function buildProjectPage(tree: ProjectTree): void {
  el.projectBody.innerHTML = '';
  // 全部行都被換掉了，開著的浮窗指向的是已丟棄的節點。
  hideSummaryTip();
  hideDetailTip();
  hideFailureTip();
  // 還不是小說工程時，頁籤切過去都是空的。
  setHidden(el.projectTabs, !tree.initialized);

  if (!tree.initialized) {
    el.projectBody.appendChild(buildInitPrompt());
    return;
  }

  const overview = buildPanel('overview');
  const chapters = buildPanel('chapters');
  const characters = buildPanel('characters');
  const lore = buildPanel('lore');
  const threads = buildPanel('threads');
  el.projectBody.append(overview, chapters, characters, lore, threads);

  if (tree.staleCount > 0) {
    overview.appendChild(buildSummaryBanner(tree));
  }

  // 故事架構：後面一切的上游，排在最前面。
  const filled = tree.architecture.filter((a) => a.filled).length;
  overview.appendChild(
    buildGroup('architecture', '故事架構', `${filled}/${tree.architecture.length}`, {
      extraItems: () => [
        { label: tree.book.writtenThrough ? '照已寫正文生成小說配置…' : '從一句話生成小說配置…', run: () => openIdeaForm(tree.book) },
        // 只補空白：已經有的那幾件不動、不問（第 19 條的批次那一面）。
        { label: '補齊架構（只補空白）', run: () => projectAction('completeSettings') },
        // 已經有正文（匯入的原稿、老工程）：照正文整理，不從一句話重新編。兩次確認，次數在框裡。
        { label: '從已寫正文補齊（細綱、角色卡、架構、大綱）…', run: () => projectAction('deriveFromText') },
        { sep: true },
      ],
      build: () => buildArchitectureRows(tree.architecture, tree),
    })
  );

  overview.appendChild(
    buildGroup('meta', '文風與摘要', summaryGroupLabel(tree), {
      build: () => buildMetaRows(tree),
    })
  );

  // 一個章號一行（細綱號 = 章號）。細綱與正文是同一行的兩面。分了卷的書按卷分段，卷裡照舊按章號。
  chapters.appendChild(
    buildGroup('plots', '章節', `${tree.chapterCount} 章 · ${formatWords(tree.totalWords)}`, {
      panel: chapters,
      extraItems: () => [
        { label: '新建細綱（接在最後一章之後）', run: () => projectAction('newPlot') },
        { label: '新建章節檔案（直接粘正文用）', run: () => projectAction('newChapter') },
        // 卷 = 章節根下的一級目錄（2026-10-23）。建好就在下面多一段空卷，接下來新建的章預設落進最新的一卷。
        { label: '新建卷…', run: () => projectAction('newFolder', undefined, tree.chaptersRoot) },
        // 整本 txt 放進工程之後切成章（零呼叫；後端彈框挑檔案、報切分結果）。
        { label: '匯入原稿（選一本 txt）…', run: () => projectAction('importManuscript') },
        // 零呼叫：全部章節拼成一份 txt，寫到工程根下的「匯出/<書名>.txt」，已有就覆蓋（2026-10-24）。
        { label: '匯出全文（txt）', run: () => projectAction('exportBook') },
        { sep: true },
        // 續寫大綱排在拆細綱前面：大綱排到哪，細綱才拆得到哪。它是對話頁的一輪、一次一段（2026-10-24）。
        continueOutlineItem(tree),
        // 兩個批次動作都「只補不改」：已經有產物的章一律跳過。都先開彈窗選區間。
        { label: '批次拆細綱…', run: () => openPlotBatchForm(tree) },
        { label: '批次寫章…', run: () => openWriteBatchForm(tree) },
        { sep: true },
      ],
      build: () => {
        const rows = tree.volumes.length > 0 ? buildVolumeRows(tree) : buildPlotRows(tree.plots, tree.nextChapterNo);
        // 空分組與「下一章還沒有細綱那一行」（拆細綱那一檔）都寫出全書的下一步（W12）。
        // 有下一章那一行時它自己帶「去寫這一章」，不再多說一句。
        // 空分組先擺「新建第 1 章」「匯入原稿…」兩顆（新手上手，2026-10-24）：編輯器為主，自己寫或導進來是最常見的開頭。
        if (tree.plots.length === 0) {
          return [...rows, chaptersEmptyRow(tree), ...(tree.next ? [nextStepRow(tree.next, tree)] : [])];
        }
        const hasNextRow = tree.plots.some((p) => p.no === tree.nextChapterNo);
        return !hasNextRow && tree.next ? [...rows, nextStepRow(tree.next, tree)] : rows;
      },
    })
  );

  characters.appendChild(
    buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
      section: SECTIONS.characters,
      root: tree.charactersRoot,
      panel: characters,
      extraItems: () => [
        { label: '更新所有角色卡', run: () => characterAction('updateAllCards') },
        { label: '從頭重建所有角色卡', run: () => characterAction('rebuildAllCards') },
        // 挑幾章正文一次提一批（新角色直接建，已有的走對比）。不依賴定稿，上面兩條依賴。
        { label: '提取/更新角色卡（挑幾章正文）…', run: () => projectAction('extractCharacters') },
        { sep: true },
        { label: '清理別名（刪掉「她」「姐姐」這類泛稱）', run: () => characterAction('cleanAliases') },
        { label: '查詢並合併重複角色卡', run: () => characterAction('mergeDuplicates') },
        { sep: true },
      ],
      build: () => [
        // 衝突排在最前面：它說明這棵樹上的出場統計有一處是錯的。
        ...tree.castConflicts.map(buildConflictRow),
        ...(tree.characters.length === 0
          ? [charactersEmptyRow(tree)]
          : renderNodes(tree.characters, 0, SECTIONS.characters, tree)),
      ],
    })
  );

  // 定稿過的細綱裡出現、但還沒建卡的人物。單獨一組而不是混進角色樹——
  // 那棵是檔案樹（能改名/移動/刪除），這些人還沒有檔案。
  if (tree.cast.length > 0) {
    characters.appendChild(
      buildGroup('cast', '出場人物 · 未建卡', `${tree.cast.length} 人`, {
        extraItems: () => [
          { label: `給全部 ${tree.cast.length} 人建卡`, run: () => characterAction('createAllCards') },
          { sep: true },
        ],
        build: () => tree.cast.map(buildCastRow),
      })
    );
  }

  // 設定名錄（「設定」一節攢出來的）：已建條目是按目錄（= 分類）分組的樹，每行帶出現章與待整合；
  // 標題旁一個篩選框，幾百條時不用一層層翻目錄。
  const unfiledAll = tree.loreUnfiled;
  const thinAll = tree.loreThin;
  const match = loreMatcher(tree);
  // 沒東西可篩就不擺框；正篩著的時候哪怕條目都沒了也留著，不然篩選串看不見、也清不掉。
  const showFilter = tree.lore.length > 0 || unfiledAll.length > 0 || thinAll.length > 0 || loreView.filter !== '';
  lore.appendChild(
    buildGroup('lore', '設定', countLabel(tree.lore, '條'), {
      section: SECTIONS.lore,
      root: tree.loreRoot,
      panel: lore,
      // 設定名錄的三件維護（第三期）。次數都在後端的確認框裡報，這裡只說有幾件待辦。
      extraItems: () => {
        const unrecorded = tree.loreUnrecorded;
        const pending = Object.values(tree.loreByEntry).filter((s) => s.pending > 0).length;
        const items = [
          ...(unrecorded > 0
            ? [{ label: `補記設定（${unrecorded} 章同步過、還沒記）`, run: () => projectAction('recordLore') }]
            : []),
          ...(pending > 0
            ? [{ label: `整合設定（${pending} 條有新內容）`, run: () => projectAction('integrateLore') }]
            : []),
          ...(tree.lore.length > 0 ? [{ label: '按目錄整理…', run: () => projectAction('organizeLore') }] : []),
        ];
        return items.length > 0 ? [...items, { sep: true as const }] : [];
      },
      head: showFilter ? buildLoreFilter(rerenderProject) : undefined,
      build: () => {
        if (tree.lore.length === 0) {
          return [loreEmptyRow(tree)];
        }
        const rows = renderNodes(tree.lore, 0, SECTIONS.lore, tree, match);
        if (rows.length === 0 && match) {
          const none = emptyRow('沒有匹配的設定');
          none.classList.add('row-no-match');
          return [none];
        }
        return rows;
      },
    })
  );

  // 待完善（完善設定，2026-10-19）：還沒寫的幾章細綱「設定」一節點名、卻還沒有條目或條目還只有一句話的設定。
  // 往前看的一組，排在往回記的「出現過 · 未建條目」前面；一個都沒有就整組不畫，篩選時同未建條目。
  // 標題右鍵「全部展開」（三期）：次數與後端確認框同一個數，只算批次會寫的（作者寫過的跳過，`authored`）。
  const thin = filterUnfiled(thinAll);
  if (thin.length > 0) {
    const expandable = thinAll.filter((t) => !t.authored).length;
    lore.appendChild(
      buildGroup('loreThin', '待完善', `${thinAll.length} 個`, {
        extraItems: () =>
          expandable > 0
            ? [
                {
                  label: `全部展開（${expandable} 條，${describeCalls(loreExpandCalls(expandable)).replace(/（.*）$/, '')}）`,
                  run: () => projectAction('expandLoreAll'),
                },
                { sep: true },
              ]
            : [],
        build: () => buildLoreThinRows(thin),
      })
    );
  }

  // 定稿過的細綱「設定」一節裡出現、但還沒有條目的名字。與「出場人物 · 未建卡」同一個道理單獨一組：
  // 設定那棵是檔案樹（能改名/移動/刪除），這些還沒有檔案。篩選時一個都沒匹配上就整組不畫。
  const unfiled = filterUnfiled(unfiledAll);
  if (unfiled.length > 0) {
    const frequent = unfiledAll.filter((u) => u.chapters.length >= 1).length;
    lore.appendChild(
      buildGroup('loreUnfiled', '出現過 · 未建條目', `${unfiledAll.length} 個`, {
        extraItems: () =>
          frequent > 0
            ? [{ label: `給全部 ${frequent} 個建條目`, run: () => projectAction('buildLore') }, { sep: true }]
            : [],
        build: () => buildLoreUnfiledRows(unfiled, tree.loreRoot),
      })
    );
  }

  // 時間線（故事時間，2026-10-24 重做）：敘事線頁籤裡單獨一組，排在敘事線組前面。時間線檔案不在、也沒有要補推的章時不畫。
  // 曆法與起點在標題的懸停裡（同日時間線總覽：原來是組裡第一行、點了就改，作者嫌反人類），改走右鍵。
  if (tree.threads.timeline) {
    threads.appendChild(
      buildGroup('timeline', '時間線', timelineGroupLabel(tree), {
        extraItems: () => timelineMenuItems(tree),
        head: timelineHead(tree),
        tip: timelineGroupTip(tree),
        build: () => buildTimelineRows(tree, rerenderProject),
      })
    );
  }

  // 敘事線（敘事線重做第 8 個提交）：一條線一行，作者一眼看出各條線走到哪。標題旁「從大綱排出 / 補充」（排線失敗的
  // 紅 ❗ 也在那裡），頁裡空白處右鍵同一項。
  threads.appendChild(
    buildGroup('threads', '敘事線', threadsGroupLabel(tree), {
      panel: threads,
      extraItems: () => threadsMenuItems(tree),
      head: threadsHead(tree),
      build: () => buildThreadRows(tree),
    })
  );
}

/** 摺疊狀態變了：拿最近一次收到的樹重畫，不往後端要資料。 */
function rerenderProject(): void {
  if (lastTree) {
    renderProject(lastTree);
  }
}

export function installProject(): void {
  bindRerender(rerenderProject);
  installSummaryTip();
  installDetailTip();
  installFailureTip();
  installProjectTabs();

  // 頁籤條上除了頁籤只剩「重新整理」與存檔點（⚑）。
  el.projectTabs.querySelector('[data-action="refresh"]')?.addEventListener('click', () => projectAction('refresh'));
  // 存檔點（2026-10-20）：不要樹，列表向後端現要。
  el.projectTabs.querySelector('[data-form="checkpoints"]')?.addEventListener('click', () => openCheckpoints());
}

export { applySummary, invalidateSummaries } from './summaryTip';
