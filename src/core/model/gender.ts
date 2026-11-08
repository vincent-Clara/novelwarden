/**
 * 角色卡的「性別」（frontmatter 的 `gender`）。
 *
 * 名字看不出性別時，寫正文的模型只能猜，「陸清河」一猜就是男的；新角色也容易一路預設成男的。
 * 所以角色圖譜、細綱帶出的新角色、從正文建卡 / 更新角色卡幾條路都讓模型寫上它，裝配時跟著
 * 名字一起進上下文。**純函式、絕不拋**（第 1 條）。
 */

/**
 * 規範寫法：`male`、`女性` 這類同義寫法收成「男」「女」，「未知」「不詳」與空當沒寫。
 * 認不出的（「無性別」「雌雄同體」）照原樣留著，截到 8 個字——那是有意寫的。
 */
export function normalizeGender(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const s = value.trim();
  if (/^(男|男性|male|m|man)$/i.test(s)) {
    return '男';
  }
  if (/^(女|女性|female|f|woman)$/i.test(s)) {
    return '女';
  }
  if (!s || /^(未知|不(?:详|詳)|不明|(?:无|無)|待定|（待(?:补|補)充）|unknown|n\/a)$/i.test(s)) {
    return undefined;
  }
  return Array.from(s).slice(0, 8).join('');
}

/** 卡上已經寫了的不動（作者寫的、先前機器寫的都算），沒寫才用新給的。 */
export function keepGender(current: string | undefined, proposed: unknown): string | undefined {
  return current || normalizeGender(proposed);
}
