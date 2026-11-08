/**
 * 調模型之前那兩個下拉框（模型、上下文詳細度）的前端一半：工程頁批次表單（forms.ts）與獨立版確認框（prompt.ts）
 * 共用。作者在這裡挑的只管這一次，不改設定；後端怎麼用它見 core 的 `model/callChoice.ts`。
 */
import { CONTEXT_DETAILS, CONTEXT_DETAIL_HINT, CONTEXT_DETAIL_LABEL, TIERED_LABEL, isContextDetail } from '../protocol';
import type { CallChoice, CallPrompt, ContextDetail } from '../protocol';
import { el as mk, setHidden } from '../dom';
import { buildSelect } from './form';
import type { FormField, FormValues, SelectOption } from './form';

/** 模型下拉框：第一項「按分檔」（值是空串），其餘按服務商分組，同對話頁。 */
function modelOptions(models: CallPrompt['models']): SelectOption[] {
  return [{ value: '', label: TIERED_LABEL }, ...models.map((m) => ({ value: m.ref, label: m.ref, group: m.group }))];
}

/** 詳細度下拉框：「1 · 精簡」……，與設定頁同一套說法。 */
function detailOptions(): SelectOption[] {
  return CONTEXT_DETAILS.map((d) => ({ value: String(d), label: `${d} · ${CONTEXT_DETAIL_LABEL[d]}` }));
}

/** 工程頁批次表單上的兩個欄位。預設：按分檔、設定頁那一級。 */
export function callFields(models: CallPrompt['models'], contextDetail: ContextDetail): FormField[] {
  return [
    { kind: 'select', key: 'callModel', label: '模型', value: '', options: modelOptions(models) },
    { kind: 'select', key: 'callDetail', label: '上下文詳細度', value: String(contextDetail), options: detailOptions() },
  ];
}

/** 兩個欄位的值 → 作者為這一次挑的（`projectAction.call`、`promptResult.choice`）。 */
export function callChoiceOf(v: FormValues): CallChoice {
  const model = String(v.callModel ?? '');
  const detail = Number(v.callDetail);
  return { ...(model ? { model } : {}), ...(isContextDetail(detail) ? { contextDetail: detail } : {}) };
}

/**
 * 獨立版確認框裡的那一塊：兩個下拉框（這一次的上下文不看詳細度時只有模型那一個）。選著「按分檔」時下面列出各項活交給誰，
 * 詳細度下面一行說這一級帶多少。
 */
export function buildCallPicker(call: CallPrompt): { element: HTMLElement; choice: () => CallChoice } {
  const box = mk('div', 'call-picker');
  const grid = mk('div', 'grid');
  const model = buildSelect(modelOptions(call.models), call.model);
  grid.appendChild(field('模型', model));
  const detail = call.contextDetail ? buildSelect(detailOptions(), String(call.contextDetail)) : undefined;
  if (detail) {
    grid.appendChild(field('上下文詳細度', detail));
  }
  box.appendChild(grid);

  const tiers = mk('div', 'call-tiers');
  for (const line of call.tiers) {
    tiers.appendChild(mk('p', 'hint', line));
  }
  // 不跟這一次挑的模型走的活（轉寫）：選了具體模型也照樣顯示。
  const fixed = (call.fixed ?? []).map((line) => mk('p', 'hint', line));
  const hint = mk('p', 'hint call-detail-hint');
  box.append(tiers, ...fixed, ...(detail ? [hint] : []));

  const refresh = () => {
    setHidden(tiers, model.value !== '');
    if (detail) {
      hint.textContent = `上下文：${CONTEXT_DETAIL_HINT[Number(detail.value) as ContextDetail]}`;
    }
  };
  box.addEventListener('change', refresh);
  refresh();
  return { element: box, choice: () => callChoiceOf({ callModel: model.value, callDetail: detail?.value ?? '' }) };
}

/** 「標題在上、下拉框在下」的一格，與表單（form.ts）同一種樣子。 */
function field(text: string, input: HTMLElement): HTMLElement {
  const label = mk('label', 'field');
  label.append(mk('span', undefined, text), input);
  return label;
}
