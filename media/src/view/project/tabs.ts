/**
 * 工程頁的五個頁籤：概覽 / 章節 / 角色 / 設定 / 敘事線。
 *
 * 從前一頁從上到下攤著故事架構、章節、角色、設定……幾百行，找一個區要翻很久。章節、角色、設定
 * 各佔一頁，其餘（故事架構、文風與摘要、定稿進度橫幅）留在「概覽」。敘事線（敘事線重做第 8 個提交）同一個思路
 * 單佔一頁、排在設定後面：一條線一行，從前「文風與摘要」組裡那一行計數刪了。
 *
 * 五頁的內容每次都全畫（`index.ts` 把各組裝進各自的 `.project-panel`），切頁籤只換哪一塊露出來——
 * 不重畫、不往後端要資料；分組的右鍵選單、三隻浮窗掛在 `#projectBody` 上的事件委託都照舊。
 * 當前頁籤與摺疊開合同一個待遇：只在前端，重推樹不換頁。
 *
 * 五頁共用 `#projectBody` 這一個滾動容器（它不隨重畫換掉，重推樹時滾動位置才留得住），
 * 所以各頁滾到哪由這裡記：切走時記下，切回來放回去。
 */
import { el as mk } from '../../dom';
import { el } from '../refs';

export type ProjectTab = 'overview' | 'chapters' | 'characters' | 'lore' | 'threads';

const TABS: readonly ProjectTab[] = ['overview', 'chapters', 'characters', 'lore', 'threads'];

let current: ProjectTab = 'overview';
const scrollOf: Partial<Record<ProjectTab, number>> = {};

/** 一頁的容器。按當前頁籤決定露不露，整頁重畫之後不用再同步一遍。 */
export function buildPanel(tab: ProjectTab): HTMLElement {
  const panel = mk('div', 'project-panel');
  panel.dataset.projectPanel = tab;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `projectTab-${tab}`);
  panel.hidden = tab !== current;
  return panel;
}

/** 切到某一頁：記下這一頁滾到哪，放回那一頁上次的位置。 */
export function showProjectTab(tab: ProjectTab, focus = false): void {
  if (tab !== current) {
    scrollOf[current] = el.projectBody.scrollTop;
    current = tab;
  }
  for (const btn of el.projectTabs.querySelectorAll<HTMLButtonElement>('[data-project-tab]')) {
    const active = btn.dataset.projectTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    if (active && focus) {
      btn.focus();
    }
  }
  for (const panel of el.projectBody.querySelectorAll<HTMLElement>('[data-project-panel]')) {
    panel.hidden = panel.dataset.projectPanel !== tab;
  }
  el.projectBody.scrollTop = scrollOf[tab] ?? 0;
}

/** 點頁籤切頁；左右方向鍵、Home / End 在頁籤之間走（同設定頁的分類頁籤）。 */
export function installProjectTabs(): void {
  for (const btn of el.projectTabs.querySelectorAll<HTMLButtonElement>('[data-project-tab]')) {
    const tab = btn.dataset.projectTab as ProjectTab;
    btn.addEventListener('click', () => showProjectTab(tab));
    btn.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(tab);
      let next = i;
      if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
      if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = TABS.length - 1;
      if (next !== i) {
        e.preventDefault();
        showProjectTab(TABS[next], true);
      }
    });
  }
}
