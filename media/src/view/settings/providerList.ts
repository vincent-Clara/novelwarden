/**
 * 設定頁的服務商列表：一堆概要卡片，詳細配置在彈窗裡改。
 * 「預設模型」列表跟著它走（模型可能被刪掉），所以在同一處重新整理。
 */
import { el as mk } from '../../dom';
import type { SerializedProvider } from '../../protocol';
import { smallBtn } from '../buttons';
import { el } from '../refs';
import { toast } from '../toast';
import { draft, touch } from './draft';
import { renderModelList } from './modelList';
import { KIND_LABEL } from './presets';

/** 由 index.ts 注入：卡片上的「配置」要開彈窗，而彈窗又要能重新整理卡片。 */
let openModal: (id: string) => void = () => {};

export function bindOpenModal(fn: (id: string) => void): void {
  openModal = fn;
}

/** 卡片上最多平鋪幾個模型徽標，多的折成「… 共 N 個」。 */
const MAX_CHIPS = 5;
/** 刪除的確認態維持多久。 */
const CONFIRM_MS = 3000;

export function renderProviders(): void {
  el.providerList.innerHTML = '';
  const modelCount = draft.providers.reduce((n, p) => n + p.models.length, 0);
  el.providerCount.textContent = `${draft.providers.length} 個服務商 · ${modelCount} 個模型`;

  if (draft.providers.length === 0) {
    el.providerList.appendChild(
      mk('div', 'hint', '還沒有服務商。點下面的預設快速新增一個，或手動新增。')
    );
  }
  for (const p of draft.providers) {
    el.providerList.appendChild(buildProviderCard(p));
  }
  renderModelList();
}

function buildProviderCard(p: SerializedProvider): HTMLElement {
  const card = mk('div', 'provider-card');

  const head = mk('div', 'provider-head');
  const title = mk('span', 'provider-title', p.label || p.id);
  title.title = `模型引用字首 ${p.id}/`;
  head.appendChild(title);
  head.appendChild(mk('span', 'meta', KIND_LABEL[p.kind] || p.kind));
  head.appendChild(smallBtn('配置', () => openModal(p.id)));
  head.appendChild(buildDeleteBtn(p));
  card.appendChild(head);

  const url = mk(
    'div',
    'provider-url',
    p.kind === 'vscode-lm' ? '內建 · 無需介面地址' : p.baseUrl || '未設定介面地址'
  );
  url.title = p.baseUrl || '';
  card.appendChild(url);

  card.appendChild(buildModelChips(p));
  return card;
}

function buildModelChips(p: SerializedProvider): HTMLElement {
  const models = mk('div', 'provider-models');
  if (p.models.length === 0) {
    models.appendChild(mk('span', 'meta', '還沒有模型'));
  }
  for (const m of p.models.slice(0, MAX_CHIPS)) {
    const chip = mk('span', 'model-chip', m.name || '…');
    chip.title = `${p.id}/${m.name}`;
    models.appendChild(chip);
  }
  if (p.models.length > MAX_CHIPS) {
    models.appendChild(mk('span', 'meta', `… 共 ${p.models.length} 個`));
  }
  return models;
}

/** 刪除按鈕：第一次點選進入確認態，三秒內再點才真刪。 */
function buildDeleteBtn(p: SerializedProvider): HTMLElement {
  const b = mk('button', 'link', '刪除');
  let timer: ReturnType<typeof setTimeout> | null = null;

  b.addEventListener('click', () => {
    if (timer) {
      clearTimeout(timer);
      draft.providers = draft.providers.filter((x) => x !== p);
      touch();
      renderProviders();
      toast(`已刪除服務商「${p.label || p.id}」，記得儲存。`);
      return;
    }
    b.textContent = '確認刪除？';
    b.classList.add('danger');
    timer = setTimeout(() => {
      timer = null;
      b.textContent = '刪除';
      b.classList.remove('danger');
    }, CONFIRM_MS);
  });
  return b;
}
