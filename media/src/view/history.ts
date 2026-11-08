/** 歷史頁：會話列表。 */
import { el as mk, closestFrom } from '../dom';
import type { SessionListItem } from '../protocol';
import { linkBtn } from './buttons';
import { timeLabel } from './format';
import { el } from './refs';
import { vscode } from './store';
import { showTab } from './tabs';

export function renderSessions(list: SessionListItem[]): void {
  el.sessionList.innerHTML = '';
  el.historyMeta.textContent = `${list.length} 個會話`;

  if (list.length === 0) {
    // 空頁寫出去哪兒（W12）：會話是在對話頁裡說出第一句話時才存下來的。
    const li = mk('li', 'hint history-empty', '還沒有儲存的對話。在對話頁跟著主按鈕走，發出第一條訊息後會自動儲存在這裡。');
    const go = mk('button', 'chip-btn', '去對話頁');
    go.addEventListener('click', () => {
      showTab('chat');
      vscode.postMessage({ type: 'switchTab', tab: 'chat' });
    });
    li.appendChild(go);
    el.sessionList.appendChild(li);
    return;
  }
  for (const s of list) {
    el.sessionList.appendChild(buildSessionRow(s));
  }
}

function buildSessionRow(s: SessionListItem): HTMLElement {
  const li = mk('li', s.active ? 'active' : '');
  li.addEventListener('click', (e) => {
    // 「重新命名」「刪除」在這一行裡，點它們不該順帶切走會話。
    if (closestFrom(e.target, 'button')) {
      return;
    }
    vscode.postMessage({ type: 'openSession', id: s.id });
  });

  const head = mk('div', 's-head');
  head.appendChild(mk('span', 's-title', s.title));
  head.appendChild(mk('span', 'meta', `${s.turnCount} 條 · ${timeLabel(s.updatedAt)}`));

  const actions = mk('span', 's-actions');
  actions.appendChild(linkBtn('重新命名', () => vscode.postMessage({ type: 'renameSession', id: s.id })));
  actions.appendChild(linkBtn('刪除', () => vscode.postMessage({ type: 'deleteSession', id: s.id })));
  head.appendChild(actions);
  li.appendChild(head);

  if (s.preview) {
    li.appendChild(mk('div', 's-preview', s.preview));
  }
  return li;
}
