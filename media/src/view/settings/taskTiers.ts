/**
 * 「哪個任務交給哪一檔」的對照表。
 *
 * 八行，每行一個下拉框。預設值來自後端的 `DEFAULT_TASK_TIERS`（同一份定義，
 * 經 protocol.ts 引入）——設定頁上寫著「定稿 → 快速檔」，跑起來就必須是
 * 快速檔，兩邊各寫一份遲早會漂。
 *
 * 只有與內建預設不同的項才會寫進配置：這樣日後調整預設值時，使用者沒動過的
 * 任務會跟著新預設走，而不是被一份「當年抄下來的預設值」釘死。
 */
import { el as mk, maybeById } from '../../dom';
import { DEFAULT_TASK_TIERS, LLM_TASKS, MODEL_TIERS, TASK_HINT, TASK_LABEL, TIER_LABEL } from '../../protocol';
import type { LlmTask, ModelTier } from '../../protocol';
import { draft, touch } from './draft';

export function renderTaskTiers(): void {
  const box = maybeById<HTMLElement>('taskTierTable');
  if (!box) {
    return;
  }
  box.innerHTML = '';
  for (const task of LLM_TASKS) {
    box.appendChild(buildRow(task));
  }
}

function buildRow(task: LlmTask): HTMLElement {
  const row = mk('div', 'task-tier-row');

  const label = mk('div', 'task-tier-label');
  label.appendChild(mk('span', 'task-tier-name', TASK_LABEL[task]));
  label.appendChild(mk('span', 'task-tier-hint', TASK_HINT[task]));
  row.appendChild(label);

  const current = draft.taskTiers[task] ?? DEFAULT_TASK_TIERS[task];
  const sel = document.createElement('select');
  sel.className = 'task-tier-select';
  for (const tier of MODEL_TIERS) {
    const opt = document.createElement('option');
    opt.value = tier;
    // 標出哪個是內建預設，使用者改亂了能找回來。
    opt.textContent = tier === DEFAULT_TASK_TIERS[task] ? `${TIER_LABEL[tier]}（預設）` : TIER_LABEL[tier];
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.addEventListener('change', () => {
    const picked = sel.value as ModelTier;
    if (picked === DEFAULT_TASK_TIERS[task]) {
      // 選回預設就把覆蓋刪掉，配置裡只留真正改過的項。
      delete draft.taskTiers[task];
    } else {
      draft.taskTiers[task] = picked;
    }
    touch();
  });
  row.appendChild(sel);
  return row;
}
