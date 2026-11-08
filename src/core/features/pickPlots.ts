import { getHost } from '../host';

/** 能被挑選的東西：有個號、有個名字。細綱與釋出章節都滿足。 */
export interface Numbered {
  no: number;
  title: string;
}

/**
 * Host.pick 只支援單選。需要多章的場景（提取角色、提取文風）改為
 * 讓使用者輸入章號列表，如 `1,2,3`（中英文逗號、空格皆可）。
 */
export async function pickPlotsByInput<T extends Numbered>(
  items: T[],
  title: string,
  placeHolder: string,
  defaults: number[]
): Promise<T[] | undefined> {
  const catalog = items.map((p) => `${p.no}(${p.title})`).join('、');
  const value = await getHost().input({
    title,
    prompt: `可選章節：${catalog}`,
    value: defaults.join(','),
    placeHolder,
    validate: (v) => {
      const nos = parseNos(v);
      if (nos.length === 0) {
        return '請至少輸入一個章號（逗號分隔）';
      }
      const unknown = nos.filter((n) => !items.some((p) => p.no === n));
      return unknown.length > 0 ? `第 ${unknown.join('、')} 章不存在` : undefined;
    },
  });
  if (!value) {
    return undefined;
  }
  const nos = parseNos(value);
  return items.filter((p) => nos.includes(p.no));
}

function parseNos(text: string): number[] {
  const seen = new Set<number>();
  for (const part of text.split(/[,，\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return [...seen];
}
