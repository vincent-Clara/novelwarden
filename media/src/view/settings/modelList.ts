/**
 * 有序模型清單的編輯器。四處複用同一份渲染：
 * 「預設模型」一份，加上快速 / 均衡 / 精標三檔各一份。
 *
 * 清單是**排好序**的——第一個是首選，工程頁任務序列時用它、失敗隨機換後面的
 * 重試，併發時在清單裡輪轉。所以順序本身是配置的一部分，必須能調。
 */
import { el as mk, maybeById } from '../../dom';
import { MODEL_TIERS, TIER_HINT, TIER_LABEL } from '../../protocol';
import type { ModelTier } from '../../protocol';
import { smallBtn } from '../buttons';
import { toast } from '../toast';
import { allRefs, draft, touch } from './draft';

/** 一份清單要能讀、能寫、能說出自己空著時該顯示什麼。 */
interface ListSpec {
  containerId: string;
  get(): string[];
  set(next: string[]): void;
  /** 清單為空時的說明。檔位的空態是「沿用預設模型」，不是「還沒配」。 */
  emptyHint: string;
  /** 加進這份清單時的 toast。 */
  onAdd(ref: string, size: number): string;
}

const DEFAULT_LIST: ListSpec = {
  containerId: 'defaultModelList',
  get: () => draft.models,
  set: (next) => {
    draft.models = next;
  },
  emptyHint: '還沒有選預設模型。',
  onAdd: (ref, size) => (size === 1 ? `已設為首選模型：${ref}` : `已新增 ${ref}，記得儲存。`),
};

const TIER_LISTS: ListSpec[] = MODEL_TIERS.map((tier) => ({
  containerId: `tierModelList-${tier}`,
  get: () => draft.tierModels[tier],
  set: (next) => {
    draft.tierModels[tier] = next;
  },
  // 空檔位不是「壞了」，而是一個明確的語義：這一檔的任務沿用預設模型。
  // 說清楚才不會讓人以為歸在這檔的任務跑不起來。
  emptyHint: `留空＝歸在${TIER_LABEL[tier]}的任務沿用上面的「預設模型」。`,
  onAdd: (ref) => `已加入${TIER_LABEL[tier]}：${ref}，記得儲存。`,
}));

const ALL_LISTS: ListSpec[] = [DEFAULT_LIST, ...TIER_LISTS];

/** 檔位說明，渲染在每檔標題下面。 */
export function tierHint(tier: ModelTier): string {
  return TIER_HINT[tier];
}

/**
 * 服務商列表變了要跟著重新整理（模型可能被刪掉），由 renderProviders 統一呼叫。
 * 四份清單一起重畫——刪掉一個服務商可能同時影響預設模型與某幾檔。
 */
export function renderModelList(): void {
  for (const spec of ALL_LISTS) {
    renderOne(spec);
  }
}

function renderOne(spec: ListSpec): void {
  const box = maybeById<HTMLElement>(spec.containerId);
  if (!box) {
    // 外掛形態與獨立版共用這份程式碼，容器不在就跳過。
    return;
  }
  box.innerHTML = '';
  const available = allRefs();
  const list = spec.get();

  if (list.length === 0) {
    box.appendChild(
      mk('div', 'hint', available.length === 0 ? '還沒有可選的模型，先在上面新增服務商。' : spec.emptyHint)
    );
  }

  for (const [i, ref] of list.entries()) {
    box.appendChild(buildRow(spec, ref, i, available));
  }

  box.appendChild(buildAdder(spec, available));
}

function buildRow(spec: ListSpec, ref: string, index: number, available: string[]): HTMLElement {
  const row = mk('div', 'model-entry');
  row.appendChild(mk('span', 'model-order', `${index + 1}`));

  const name = mk('span', 'model-entry-ref', ref);
  name.title = ref;
  row.appendChild(name);

  if (index === 0) {
    row.appendChild(mk('span', 'model-tag', '首選'));
  }
  // 引用指向已刪掉的模型時留著並標出來，不靜默丟棄——
  // 使用者得知道自己配的那個模型沒了，而不是發現列表莫名其妙短了一截。
  if (!available.includes(ref)) {
    const bad = mk('span', 'model-tag danger', '未配置');
    bad.title = '這個引用在上面的服務商列表裡找不到，儲存時會被移除。';
    row.appendChild(bad);
  }

  const ops = mk('div', 'model-ops');
  ops.appendChild(moveBtn(spec, '↑', index, -1));
  ops.appendChild(moveBtn(spec, '↓', index, 1));
  ops.appendChild(
    smallBtn('移除', () => {
      spec.set(spec.get().filter((_, i) => i !== index));
      touch();
      renderModelList();
    })
  );
  row.appendChild(ops);
  return row;
}

function moveBtn(spec: ListSpec, text: string, index: number, delta: number): HTMLButtonElement {
  const b = smallBtn(text, () => {
    const list = spec.get();
    const to = index + delta;
    if (to < 0 || to >= list.length) {
      return;
    }
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    spec.set(next);
    touch();
    renderModelList();
  });
  b.disabled = delta < 0 ? index === 0 : index === spec.get().length - 1;
  b.title = delta < 0 ? '上移' : '下移';
  return b;
}

/** 「新增模型」下拉：只列尚未入列的引用。 */
function buildAdder(spec: ListSpec, available: string[]): HTMLElement {
  const wrap = mk('div', 'model-add');
  const list = spec.get();
  const rest = available.filter((r) => !list.includes(r));

  const sel = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = rest.length === 0 ? '（沒有可新增的模型）' : '＋ 新增模型…';
  sel.appendChild(placeholder);

  for (const ref of rest) {
    const opt = document.createElement('option');
    // 顯示完整引用——與對話頁下拉框口徑一致，它才是配置裡存的東西。
    opt.value = opt.textContent = ref;
    sel.appendChild(opt);
  }
  sel.disabled = rest.length === 0;
  sel.addEventListener('change', () => {
    const ref = sel.value;
    sel.value = '';
    if (!ref) {
      return;
    }
    const next = [...spec.get(), ref];
    spec.set(next);
    touch();
    renderModelList();
    toast(spec.onAdd(ref, next.length));
  });

  wrap.appendChild(sel);
  return wrap;
}
