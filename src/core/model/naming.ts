/**
 * 稱呼學：判斷一個詞是不是「某個人的專屬稱呼」。
 *
 * 這個模組存在的理由是一次實戰事故：模型在摘要與角色卡裡把正文中每一個指代
 * 都收進了 aliases——`她`、`姐姐`、`少女`、`這位小姐`、`滿身血跡的少女`。
 * 這些詞有兩重危害：
 *
 * 1. **角色卡膨脹**。別名是並集累加的，一百章下來一張卡能掛三十多個稱呼，
 *    而角色卡每次續寫都要注入上下文。
 * 2. **把兩個人認成一個**。別名是「誰是誰」的判據（[cast.ts](../views/cast.ts) 與
 *    [identity.ts](identity.ts) 都吃它）。`姐姐` 同時是三個女角色的稱呼，
 *    照單全收就會把她們串成一個人。
 *
 * 判據分四類，命中任意一條即判定為**非專屬**：代詞泛指、指示代詞開頭、
 * 含虛詞的描述短語、可被泛稱詞表完全拆解的詞。
 *
 * **只用來過濾 aliases，絕不過濾 name。** 這條邊界很重要：`店小二`、`家老`、
 * `房東` 這類以泛稱當正式名的角色確實存在（`local/` 裡就有三張這樣的卡），
 * 把 name 也過一遍會讓他們憑空消失。
 *
 * 唯一的例外是**劇作稱謂**（`主角`、`反派`、`男主`……，{@link resolveRoleLabelName}）：
 * 那是作者與讀者看故事時的說法，故事裡沒有人這麼叫他。正文裡混進作者的筆記
 * （「反派在此處需要透露……」）時，模型會把稱謂填進 name、把真名塞進別名，
 * 建出 `反派.md` 與真名那張卡兩張搶同一個稱呼的卡。
 */

/** 代詞與泛指——任何情況下都不是稱呼。 */
const PRONOUNS = new Set(
  '他 她 它 他們 她們 它們 自己 本人 某人 此人 那人 眾人 大家 對方 雙方 兩人 二人 三人 一行人 所有人'.split(' ')
);

/**
 * 劇作稱謂：作者視角的角色分類，既不是名字也不是別名（可以進 tags）。
 *
 * 只收「故事裡不會有人這麼叫」的詞。`老闆`、`頭領`、`掌櫃` 這類故事裡真有人喊的不收；
 * `BOSS` 在遊戲文裡是故事內的叫法，也不收。
 */
const ROLE_LABELS = new Set(
  [
    '主角 主人公 主角團 男主 女主 男主角 女主角 男一 女一 男二 女二 男一號 女一號 男二號 女二號',
    '配角 男配 女配 反派 大反派 男反派 女反派 路人 路人甲 路人乙 龍套 炮灰',
  ]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * 泛稱詞表：可以指任何符合條件的人。
 *
 * 收詞標準是「換一個人也照樣能這麼叫」——`少女` 誰都能當，`方老魔女` 不能。
 * 分四組只為可讀，判定時合成一張表。
 */
const GENERIC_WORDS = new Set(
  [
    // 性別 / 年齡
    '少女 少年 姑娘 女子 男子 婦人 女人 男人 老者 老人 老頭 老太 老太婆 老漢 老爺子 青年 中年 中年人 孩子 小孩 女孩 男孩 娃兒 嬰兒 童子 幼童',
    // 親屬
    '爹 娘 父親 母親 爺爺 奶奶 外公 外婆 叔叔 嬸嬸 伯父 伯母 舅父 舅舅 舅母 姑姑 姨母 姐姐 妹妹 哥哥 弟弟 兄弟 姐妹 兒子 女兒 侄子 侄女 侄兒 孫子 孫女 孫兒 表哥 表姐 表弟 表妹 妻子 丈夫 夫君 娘子 相公 大哥 大姐 大嫂 小弟 小妹 妹子 孿生 雙生',
    // 禮貌 / 身份泛稱
    '小姐 公子 少爺 大小姐 姑奶奶 夫人 先生 大人 閣下 兄臺 前輩 晚輩 後輩 師兄 師姐 師弟 師妹 師父 學長 學姐 學弟 學妹 同學 同門 主子 老爺 奴婢 老奴 屬下 手下 心腹 下人 僕人 家奴 豪奴',
    // 貶稱 / 泛泛的指稱
    '丫頭 崽子 狼崽子 小子 小鬼 傢伙 東西 混蛋 新人 菜鳥 廢物 蠢貨 之人 之士 人物',
  ]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * 可剝離的修飾字首。`小丫頭` / `臭丫頭` / `老丫頭` 都還是 `丫頭`。
 * 長的排前面，剝離時取最長匹配。
 */
const MODIFIERS = ['貼身', '年輕', '年老', '中年', '青年', '孿生', '親', '小', '老', '臭', '大', '新', '好', '傻', '死', '眾'];

/**
 * 強泛稱字尾：以它結尾的基本不可能是某個人的專屬稱呼。
 *
 * 與 GENERIC_WORDS 分開是因為它們前面能掛任意修飾語（`小狼崽子`、`心腹之士`），
 * 窮舉不完。刻意收得很窄——`公子`、`少爺` 之類**不**放進來：
 * `賈公子`、`赤城少爺` 帶著專名，是能指到具體一個人的。
 */
const GENERIC_SUFFIXES = ['崽子', '丫頭', '之人', '之士', '傢伙', '東西'];

/** 人名/稱呼裡不會出現的虛詞。與 model/project.ts 的 SENTENCE_MARKERS 同源。 */
const SENTENCE_MARKERS = /[的了是在不没和与也都而被把从向对为及则却就还很沒與從對為則卻還]/;

/** 稱呼的長度上限。與 model/project.ts 的 isPlausibleName 保持一致。 */
const MAX_LENGTH = 8;

/**
 * 這個詞是不是**泛稱**（換個人也能這麼叫）？
 *
 * 判 true 的東西不該進 aliases，也不該拿去做「是不是同一個人」的判據。
 */
export function isGenericAppellation(word: string): boolean {
  const w = word.trim();
  if (!w || w.length > MAX_LENGTH) {
    return true;
  }
  if (PRONOUNS.has(w)) {
    return true;
  }
  // 「這位小姐」「此女」「本屆狀元」「該女子」——指示代詞開頭的是**指認**不是稱呼。
  if (/^[这那此该本其這該]/.test(w)) {
    return true;
  }
  // 「滿身血跡的少女」「好運的小丫頭」——帶虛詞的是描述短語。
  if (SENTENCE_MARKERS.test(w)) {
    return true;
  }
  if (GENERIC_SUFFIXES.some((s) => w.endsWith(s))) {
    return true;
  }
  // 「少女新人」「中年男人」「小丫頭」——能被泛稱詞與修飾語完全拆掉的，整體也是泛稱。
  return isFullyGeneric(w);
}

/**
 * 拆解：反覆剝修飾字首、吃泛稱詞，能把整個詞吃光就是泛稱。
 *
 * **必須回溯，貪心會漏。** `小妹妹` 從長到短匹配會先吃掉 `小妹`，剩一個 `妹`
 * 吃不動就判成非泛稱；而先剝修飾語 `小` 再吃 `妹妹` 才對。反過來 `小姐` 又
 * 必須先當整詞吃掉——剝了 `小` 就只剩一個 `姐`。兩條切法都要試。
 */
function isFullyGeneric(word: string): boolean {
  const failed = new Set<string>();

  const consume = (rest: string, ate: boolean): boolean => {
    if (rest.length === 0) {
      // 全靠修飾語吃光（如單獨一個 `小`）不算泛稱，至少要命中一個泛稱詞。
      return ate;
    }
    if (failed.has(rest)) {
      return false;
    }
    // 泛稱詞最長 4 字（`中年人`/`老太婆`/`大小姐`），從長到短試。劇作稱謂也當泛稱吃（`小反派`）。
    for (let len = Math.min(4, rest.length); len >= 1; len--) {
      const head = rest.slice(0, len);
      if ((GENERIC_WORDS.has(head) || ROLE_LABELS.has(head)) && consume(rest.slice(len), true)) {
        return true;
      }
    }
    for (const modifier of MODIFIERS) {
      if (rest.startsWith(modifier) && rest.length > modifier.length && consume(rest.slice(modifier.length), ate)) {
        return true;
      }
    }
    failed.add(rest);
    return false;
  };

  return consume(word, false);
}

/**
 * 過濾一組別名：去掉泛稱、與本名相同的、空白與重複。順序保持穩定。
 *
 * @param selfName 這張卡/這條 cast 的正式名。它自己不該再出現在別名裡。
 */
export function sanitizeAliases(aliases: readonly string[], selfName?: string): string[] {
  const self = selfName?.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias || alias === self || seen.has(alias) || isGenericAppellation(alias)) {
      continue;
    }
    seen.add(alias);
    out.push(alias);
  }
  return out;
}

/** 一個被丟棄的別名及原因。 */
export interface DroppedAlias {
  alias: string;
  reason: string;
}

/** 這個詞是不是劇作稱謂（`主角`、`反派`……）？只認整詞。 */
export function isRoleLabel(word: string): boolean {
  return ROLE_LABELS.has(word.trim());
}

/**
 * 正式名是劇作稱謂時換成真名：別名裡第一個專屬稱呼升成正式名，其餘留作別名。
 *
 * `{ name: '反派', aliases: ['韓厲', '頭領'] }` → `{ name: '韓厲', aliases: ['頭領'], label: '反派' }`。
 * 別名裡沒有能當名字的，返回 undefined——這一條不是一個能建卡的人。正式名不是稱謂時
 * 原樣返回（別名照傳進來的，不在這裡過濾）。`label` 只在換過名時給出，呼叫方可以放進 tags。
 */
export function resolveRoleLabelName(
  name: string,
  aliases: readonly string[]
): { name: string; aliases: string[]; label?: string } | undefined {
  const label = name.trim();
  if (!isRoleLabel(label)) {
    return { name: label, aliases: [...aliases] };
  }
  const [real, ...rest] = sanitizeAliases(aliases, label);
  return real ? { name: real, aliases: rest, label } : undefined;
}

/**
 * 被丟掉的別名與原因，供日誌說明。
 *
 * 「不靜默截斷」在本模組的落法：刪別名是對作者可見內容的刪減，
 * 哪怕刪得對，也得說得出刪了什麼、為什麼。
 */
export function explainDroppedAliases(aliases: readonly string[], selfName?: string): DroppedAlias[] {
  const self = selfName?.trim();
  const out: DroppedAlias[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias) {
      continue;
    }
    if (alias === self) {
      out.push({ alias, reason: '與正式名相同' });
      continue;
    }
    if (seen.has(alias)) {
      out.push({ alias, reason: '重複' });
      continue;
    }
    seen.add(alias);
    if (!isGenericAppellation(alias)) {
      continue;
    }
    out.push({ alias, reason: reasonFor(alias) });
  }
  return out;
}

function reasonFor(alias: string): string {
  if (alias.length > MAX_LENGTH) {
    return '過長，不像稱呼';
  }
  if (PRONOUNS.has(alias)) {
    return '代詞';
  }
  if (/^[这那此该本其這該]/.test(alias)) {
    return '指示代詞開頭';
  }
  if (SENTENCE_MARKERS.test(alias)) {
    return '描述短語，不是稱呼';
  }
  if (isRoleLabel(alias)) {
    return '劇作稱謂，故事裡沒人這麼叫';
  }
  return '泛稱，換個人也能這麼叫';
}

/**
 * 名字規範化：去掉空白與引號後比較大小寫無關。
 *
 * 比的是人名，所以比 markdown.ts 的 `normalizeKey` 保守——把中點也抹掉會讓
 * `甘德·奧塔` 與 `甘德奧塔` 混為一談，這在譯名裡恰恰是有意義的區別；只抹空白與引號。
 */
export function normalizeName(name: string): string {
  return name.replace(/[\s"'「」『』]/g, '').toLowerCase();
}
