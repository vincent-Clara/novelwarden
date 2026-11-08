/**
 * 標籤右鍵選單裡關閉類之後的那幾項：
 *
 * - **固定**：只有臨時標籤有（把它轉正）。
 * - **移到另一側**：左 ↔ 右，連同未儲存內容、撤銷歷史、衝突條、「磁碟上沒了」一起搬過去——走現有的搬家機制
 *   （`Pane.closeSilently` 交出去、`upsertFile(…, carried)` 接上），只是不經後端重讀：`moveOut` 交出來的就是
 *   它此刻的基線。**一個路徑同一時刻只屬於一塊**照舊成立：先從這一塊拿走，再交給那一塊。
 * - **在檔案頁中定位**：`nf-reveal-in-files`（資源管理器展開到它、高亮那一行；view 切到「檔案」頁）。
 * - **複製相對路徑**。
 * - **重新開啟剛關閉的**：這一塊最近關掉的那一個（按塊記，`store.ts`）。沒有快捷鍵（⚑）：Chrome 不讓頁面
 *   攔 Ctrl+Shift+T，換一個組合鍵作者也記不住；「▾」列表底下也列著最近關掉的幾個。
 */
import { revealInFiles, toast } from '../globals';
import type { MenuItem } from '../globals';
import type { Pane } from './store';
import { lastClosed, otherPane, persist, reopenClosed, syncDraftVisibility } from './store';
import { PANE_LABEL } from './tabStrip';

export function extraTabItems(pane: Pane, path: string): MenuItem[] {
  const file = pane.files.get(path);
  if (!file) {
    return [];
  }
  const items: MenuItem[] = [{ sep: true }];
  if (file.preview) {
    items.push({ label: '固定', run: () => pane.pin(path) });
  }
  const side = PANE_LABEL[pane.id === 'main' ? 'draft' : 'main'];
  items.push(
    { label: `移到另一側（${side}）`, run: () => moveToOtherSide(pane, path) },
    { sep: true },
    { label: '在檔案頁中定位', run: () => revealInFiles(path) },
    { label: '複製相對路徑', run: () => copyRelPath(path) },
    { sep: true }
  );
  const closed = lastClosed(pane.id);
  items.push({
    label: closed ? `重新開啟剛關閉的（${closed.title}）` : '重新開啟剛關閉的',
    disabled: !closed,
    run: () => closed && reopenClosed(closed),
  });
  return items;
}

/** 把這一份搬到另一塊（第二塊還沒造出來就現造），在那邊成為當前的。 */
export function moveToOtherSide(from: Pane, path: string): void {
  const target = otherPane(from, true);
  if (!target) {
    return;
  }
  const out = from.moveOut(path);
  if (!out) {
    return;
  }
  target.upsertFile(out.view, out.carried);
  // activate：認下那一塊、游標與滾動放回原處、焦點進去。
  target.activate(path);
  syncDraftVisibility();
  persist();
}

function copyRelPath(path: string): void {
  if (!navigator.clipboard?.writeText) {
    toast('當前環境不支援剪貼簿。', true);
    return;
  }
  navigator.clipboard.writeText(path).then(
    () => toast(`已複製：${path}`),
    () => toast('複製失敗，請手動選中。', true)
  );
}
