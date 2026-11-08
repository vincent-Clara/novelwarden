/**
 * 章節條（W6 章節工作臺）：編輯區里正開著某一章的正文或細綱時，主區頂上一條——
 * 「‹ 上一章 · 第 3 章《夜訪》 · 待寫正文 · 1860 / 3000 字 · 下一章 ›」，外加對這一章能做的幾件事。
 *
 * ## 為什麼在編輯器裡
 *
 * 並排看著細綱改正文時，下一步（寫這一章、接著寫、定稿）從前得切回對話頁去按主按鈕。
 * 按鈕放在正在看的東西旁邊，才叫工作臺。點下去走的仍是主按鈕那一條路（後端
 * `chapterAction`）：生成照樣在對話頁流式輸出、照樣當場問寫不寫（第 19 條）。
 *
 * ## 資料從哪來
 *
 * 章節索引（`chapterIndex.ts`，後端 `chapterIndex` 訊息）：每一章的狀態、字數、目標字數、兩份檔案的路徑，
 * **哪個頁籤都推**、內容變了才推。從前只吃工程樹（`project` 訊息），而那棵樹只在「工程」頁籤開著時才推——
 * 作者待在對話頁時條上的數是舊的。當下是哪一章，看編輯器廣播的「正在編輯哪個檔案」（`nf-editor-active`）。
 *
 * ## 按鈕
 *
 * 四顆按這一章的狀態亮滅：「寫這一章」只在細綱排好、還沒有正文時亮；「接著寫」「重寫」
 * 要這一章已經有正文；「定稿」也要有正文。提示裡寫呼叫次數，與主按鈕同一個數（D16）。
 * 另一份沒開著時給「並排看細綱 / 並排看正文」。「審稿」（五期）要有正文：只出報告、不寫檔案，
 * 報告出在對話頁，勾選之後按勾選的條目修稿。「‹ 上一章」「下一章 ›」見 `chapterNav.ts`，到頭了禁用。
 */
import { el } from '../dom';
import { FINALIZE_CALLS, PLOT_STAGE_LABEL, REVIEW_CALLS, WRITE_CALLS, describeCalls } from '../protocol';
import type { CallEstimate, ChapterAction, ChapterIndexEntry, InMessage } from '../protocol';
import { SIDE_LABEL, onChapterIndex, pathOn } from './chapterIndex';
import { goChapter, neighborsOf } from './chapterNav';
import { menuButton, menuFromButtons } from './narrowTools';
import { isNarrow, revealSide } from './shell';
import { shortcutLabel } from './shortcuts';
import { paneOwning } from './store';

/** 掛到主區上方（標籤欄與工具欄之間）。 */
export function installChapterBar(stage: HTMLElement, post: (msg: InMessage) => void): void {
  const bar = el('div', 'ed-chapter-bar hidden');
  bar.id = 'edChapterBar';
  stage.insertBefore(bar, stage.querySelector('.ed-toolbar'));
  // 條上說的是「當前那份檔案」那一章，而它可能開在右側那一塊：在條上按下去不該把「當前這一塊」搶到左側來
  // （主區根節點上的 pointerdown / focusin 會認領）——不然按鈕剛按下條就換成了左側那一章，點選落空。
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('focusin', (e) => e.stopPropagation());

  let active: string | null = null;

  onChapterIndex(render);
  window.addEventListener('nf-editor-active', (e) => {
    active = e.detail.path;
    render();
  });

  function render(): void {
    const around = neighborsOf(active);
    bar.replaceChildren();
    bar.classList.toggle('hidden', !around);
    if (!around) {
      return;
    }
    const row = around.entry;
    bar.appendChild(navButton(-1, around.prev, around.side));

    const written = !!row.chapterPath && row.wordCount > 0;
    const words = written
      ? row.targetWords
        ? `${row.wordCount} / ${row.targetWords} 字`
        : `${row.wordCount} 字`
      : '還沒有正文';
    const info = el('span', 'ed-chapter-info', `${row.label} · ${PLOT_STAGE_LABEL[row.stage]} · ${words}`);
    bar.appendChild(info);
    bar.appendChild(navButton(1, around.next, around.side));

    const actions = el('span', 'ed-chapter-actions');
    // 窄屏上底下這一排收起，條上一顆「操作 ▾」照著它們列選單（narrowTools.ts）：懸停提示手機上看不到，呼叫次數寫進選單項。
    bar.appendChild(menuButton(el('button', 'chip-btn ed-chapter-menu', '操作 ▾'), () => menuFromButtons(actions.querySelectorAll('button'))));
    const plotReady = row.plotExists && row.stage !== 'plot';
    actions.appendChild(
      button('寫這一章', 'write', plotReady && !written, plotReady ? describeCalls(WRITE_CALLS) : '先把這一章的細綱排好', plotReady ? briefCalls(WRITE_CALLS) : '先排好細綱')
    );
    actions.appendChild(button('接著寫', 'continue', written, `從末尾往下寫，新寫的追加在後面。${describeCalls(WRITE_CALLS)}`, briefCalls(WRITE_CALLS)));
    actions.appendChild(
      button('重寫', 'rewrite', written && row.plotExists, `照細綱整章重寫，寫入前會讓你先對比。${describeCalls(WRITE_CALLS)}`, briefCalls(WRITE_CALLS))
    );
    actions.appendChild(
      button('審稿', 'review', written, `逐條引原文挑出這一章的問題，逐項核對細綱的關鍵事件；只出報告，不改檔案。${describeCalls(REVIEW_CALLS)}`, briefCalls(REVIEW_CALLS))
    );
    actions.appendChild(
      button('同步', 'finalize', written, `照正文更新細綱（帶連續性事實），再更新出場角色的當前狀態、認這一章在敘事線上發生了什麼（帶原文證據記下事件、更新各條線的當前進度，正文裡新長出來的線也認出來）、推這一章的故事時間。${describeCalls(FINALIZE_CALLS)}`, briefCalls(FINALIZE_CALLS))
    );

    // 另一份沒開著：給一顆把它並排開啟的按鈕。窄屏上沒有第二塊，開在同一塊裡成了另一個標籤（editor/index.ts），不說「並排」。
    const onChapter = around.side === 'chapter';
    const other = onChapter ? (row.plotExists ? row.plotPath : '') : row.chapterPath;
    if (other && !paneOwning(other)) {
      const pair = el('button', 'chip-btn ed-chapter-pair', `${isNarrow() ? '' : '並排'}看${onChapter ? '細綱' : '正文'}`);
      pair.addEventListener('click', () =>
        post({ type: 'openEditor', path: other, pane: onChapter ? 'draft' : 'main' })
      );
      actions.appendChild(pair);
    }
    bar.appendChild(actions);

    function button(text: string, action: ChapterAction, enabled: boolean, hint: string, note: string): HTMLButtonElement {
      const b = el('button', 'chip-btn', text);
      b.dataset.action = action;
      b.dataset.menuLabel = `${text}（${note}）`;
      b.disabled = !enabled;
      b.title = hint;
      b.addEventListener('click', () => {
        post({ type: 'chapterAction', plotRelPath: row.relPath, action });
        // 生成在對話頁流式輸出、在那兒問寫不寫（後端同時切到對話頁）：窄屏上編輯區蓋著它，收下去。
        if (isNarrow()) {
          revealSide();
        }
      });
      return b;
    }
  }
}

/** 選單項上寫的呼叫次數：只寫「預計幾次」，最多幾次與為什麼留給確認框（選單一行裝不下）。 */
function briefCalls(c: CallEstimate): string {
  return describeCalls({ ...c, max: c.high, why: undefined });
}

/** 「‹ 上一章」「下一章 ›」。到頭了禁用；相鄰那一章還沒有這一面時照樣能點（點了說一句），提示裡先寫明。 */
function navButton(step: -1 | 1, to: ChapterIndexEntry | undefined, side: 'chapter' | 'plot'): HTMLButtonElement {
  const b = el('button', 'chip-btn ed-chapter-nav');
  // 窄屏上只露箭頭（「上一章」「下一章」那幾個字收起，narrow.css）。
  const word = el('span', 'ed-chapter-nav-word', step < 0 ? ' 上一章' : '下一章 ');
  b.append(...(step < 0 ? ['‹', word] : [word, '›']));
  b.dataset.nav = step < 0 ? 'prev' : 'next';
  const key = shortcutLabel(step < 0 ? 'prevChapter' : 'nextChapter');
  b.disabled = !to;
  b.title = !to
    ? step < 0
      ? '已經是第一章了'
      : '已經是最後一章了'
    : pathOn(to, side)
      ? `${to.label}的${SIDE_LABEL[side]}（${key}）`
      : `${to.label}還沒有${SIDE_LABEL[side]}（${key}）`;
  b.addEventListener('click', () => goChapter(step));
  return b;
}
