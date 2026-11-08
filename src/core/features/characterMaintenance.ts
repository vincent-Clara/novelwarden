import { buildCastIndex, readCastPlots } from '../views/cast';
import { buildIdentityGroups } from '../model/identity';
import { getHost } from '../host';
import { elapsed, scoped } from '../runtime/logger';
import { rewriteFrontmatter } from '../model/markdown';
import { readText } from '../model/fs';
import { NovelProject } from '../model/project';
import { CharacterCard } from '../model/types';
import { DroppedAlias, explainDroppedAliases, isRoleLabel, normalizeName, sanitizeAliases } from '../model/naming';
import { runTask } from '../runtime/progress';
import { Workspace } from '../workspace';

const log = scoped('角色卡');

/**
 * 角色卡的兩條維護動作：清理別名、合併重複卡。
 *
 * 它們**不調模型**，純本地整理，為的是收拾一類已經落盤的歷史髒資料：
 *
 * - 別名並集只進不出，模型吐出的 `她`/`姐姐`/`少女` 一旦進了卡就再也出不去；
 *   更糟的是有時會混進**別人的名字**，而角色卡的名字與別名會隨摘要提示詞發給
 *   模型，等於反覆教它認錯人。
 * - 摘要裡同一個人兩種寫法（`方源` / `古月方源`）曾讓「全部建卡」建出兩張卡。
 *   根因已在 [../identity.ts](../identity.ts) 修掉，但已經建出來的卡還在。
 *
 * 兩條動作都只改 frontmatter（經 `rewriteFrontmatter`），**作者手寫的正文一個
 * 位元組都不動**；被合併掉的卡按「不真刪」搬進 `.novelwarden/.trash/`。寫回與搬走都經閘道器（`write`
 * 傳 `review: false`——動手前的確認框就是那一問；`remove`），守衛照過，改寫之前的舊卡存一版歷史（AGENTS 第 7 條）。
 */

// ---------------------------------------------------------------- 清理別名

interface AliasCleanup {
  card: CharacterCard;
  keep: string[];
  dropped: DroppedAlias[];
}

/**
 * 掃全部角色卡，刪掉不是「專屬稱呼」的別名。
 *
 * 判據有兩條：[../naming.ts](../naming.ts) 的泛稱過濾，外加「這個別名是另一張卡
 * 的正式名」——後者是最有害的一種，它會讓兩個角色的出場章互相串。
 */
export async function cleanCharacterAliases(project: NovelProject): Promise<void> {
  const cards = await project.listCharacters();
  if (cards.length === 0) {
    getHost().toast('還沒有角色卡。');
    return;
  }

  const nameOwner = new Map<string, CharacterCard>();
  for (const card of cards) {
    const key = normalizeName(card.name);
    if (key && !nameOwner.has(key)) {
      nameOwner.set(key, card);
    }
  }

  const plans: AliasCleanup[] = [];
  for (const card of cards) {
    const dropped = [...explainDroppedAliases(card.aliases, card.name)];
    const keep: string[] = [];
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      const owner = nameOwner.get(normalizeName(alias));
      if (owner && owner.slug !== card.slug) {
        dropped.push({ alias, reason: `是「${owner.name}」這張卡的正式名` });
        continue;
      }
      keep.push(alias);
    }
    if (dropped.length > 0) {
      plans.push({ card, keep, dropped });
    }
  }

  if (plans.length === 0) {
    log.info('角色卡別名檢查通過', `${cards.length} 張卡，沒有需要清理的稱呼`);
    getHost().toast(`${cards.length} 張角色卡的別名都是專屬稱呼，無需清理。`);
    return;
  }

  const total = plans.reduce((sum, p) => sum + p.dropped.length, 0);
  const samples = plans
    .slice(0, 6)
    .map((p) => `「${p.card.name}」刪 ${p.dropped.map((d) => d.alias).join('、')}`);
  const pick = await getHost().confirm(
    `${plans.length} 張角色卡裡有 ${total} 個不該當別名的稱呼，現在清理？`,
    ['清理'],
    {
      modal: true,
      detail: [
        '代詞（她）、親屬稱謂（姐姐）、泛稱（少女／丫頭）、描述短語（滿身血跡的少女），'
          + '以及被誤填成別名的**其他角色的名字**——它們會讓程式把兩個人認成一個。',
        samples.join('\n') + (plans.length > samples.length ? `\n……另有 ${plans.length - samples.length} 張` : ''),
        '不調模型。只改 frontmatter 的 aliases 欄位，正文一個字都不動。',
      ].join('\n\n'),
    }
  );
  if (pick !== '清理') {
    log.info('使用者取消了別名清理');
    return;
  }

  await runTask(
    '清理角色卡別名',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      const ws = new Workspace(project);
      let done = 0;
      let failed = 0;
      for (const plan of plans) {
        if (signal.aborted) {
          log.warn(`清理被取消，已處理 ${done}/${plans.length} 張`);
          break;
        }
        report({ message: `「${plan.card.name}」`, current: done, total: plans.length });
        const abs = project.pathOf(plan.card.relPath);
        const rewritten = rewriteFrontmatter(await readText(abs), { aliases: plan.keep });
        if (!rewritten) {
          failed++;
          log.warn(`「${plan.card.name}」沒有 frontmatter，跳過`, plan.card.relPath);
          continue;
        }
        // 經閘道器寫（第 7 條）：守衛照過，覆蓋之前舊卡存一版歷史（刪掉的稱呼找得回來）；不彈審閱——上面的確認框就是那一問。
        await ws.write(plan.card.relPath, { text: rewritten }, { mode: 'overwrite', review: false });
        done++;
        log.info(
          `「${plan.card.name}」刪掉 ${plan.dropped.length} 個稱呼`,
          plan.dropped.map((d) => `${d.alias}（${d.reason}）`).join('、')
        );
      }
      project.invalidate();
      report({ message: '完成', current: plans.length, total: plans.length });
      log.info('別名清理結束', `${done} 張已改${failed > 0 ? `，${failed} 張跳過` : ''}｜用時 ${elapsed(startedAt)}`);
      getHost().toast(`已清理 ${done} 張角色卡的別名。`);
    },
    { scope: '角色卡' }
  );
}

// ---------------------------------------------------------------- 合併重複卡

/** 一組疑似同一個人的角色卡。 */
export interface DuplicateGroup {
  cards: CharacterCard[];
  /** 證據說明，直接進確認框。 */
  evidence: string;
  /** 證據強度：`summary` 有據可查（摘要聚類、正式名撞車、稱謂卡掛著真名），`naming` 只是名字長得像。 */
  strength: 'summary' | 'naming';
}

/**
 * 找出疑似重複的角色卡。匯出供冒煙測試直接驗證判據。
 *
 * 三類候選，強度不同：
 *
 * - **摘要證據**：幾章摘要互相宣告這幾個稱呼是同一個人，且從沒在同一章裡
 *   各自出場。這是 [../identity.ts](../identity.ts) 的聚類結論，可靠。
 * - **稱謂卡**：卡名是劇作稱謂（`反派`，[../model/naming.ts](../model/naming.ts)），別名裡
 *   掛著另一張卡的正式名——提取角色時模型把稱謂當了名字、把真名塞進別名，同一個人建了兩張。
 *   這是按別名認卡的唯一一處：稱謂本身不是任何人的名字，不會把兩個真人認成一個。
 * - **名字包含**：一張卡的名字是另一張的字尾（`古月赤城` ⊃ `赤城`）。
 *   只能算提示——`學堂家老 / 刑堂家老` 也滿足，那是兩個人。所以凡是被
 *   同章共現否掉的一律不列，剩下的也標明「只是名字像」。
 */
export async function findDuplicateCards(project: NovelProject): Promise<DuplicateGroup[]> {
  const cards = await project.listCharacters();
  const chapters = await readCastPlots(project);
  const identity = buildIdentityGroups(chapters);

  /**
   * 稱呼 → 角色卡，**只認正式名**。
   *
   * 刻意不看 aliases：卡上的別名恰恰是這條流程要收拾的髒資料，拿它來認卡會
   * 反噬——實戰裡方源的卡掛著 `方正`、方正的卡掛著 `方源`，按別名認卡會把
   * 這對孿生姐弟報成「同一個人的兩張卡」，正是最不能犯的錯。
   * 真是同一個人的重複卡，它的正式名必然在摘要裡出現過（卡就是照那個名字
   * 建出來的），所以只認正式名並不損失召回。
   */
  const cardByName = new Map<string, CharacterCard>();
  for (const card of cards) {
    const key = normalizeName(card.name);
    if (key && !cardByName.has(key)) {
      cardByName.set(key, card);
    }
  }

  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const groups: DuplicateGroup[] = [];
  const paired = new Set<string>();

  // ---- 1. 摘要聚類：一個組裡落進了多張卡 ----
  for (const group of identity.groups) {
    const owners: CharacterCard[] = [];
    for (const name of group.names) {
      const card = cardByName.get(normalizeName(name));
      if (card && !owners.includes(card)) {
        owners.push(card);
      }
    }
    if (owners.length > 1) {
      owners.forEach((a) => owners.forEach((b) => paired.add(pairKey(a.slug, b.slug))));
      groups.push({
        cards: owners,
        strength: 'summary',
        evidence: `摘要裡 ${group.names.slice(0, 5).join('、')} 指的是同一個人（共 ${group.chapters.length} 章），卻分成了 ${owners.length} 張卡。`,
      });
    }
  }

  // ---- 2. 稱謂卡掛著真名 ----
  for (const card of cards.filter((c) => isRoleLabel(c.name))) {
    const owners: CharacterCard[] = [];
    for (const alias of card.aliases) {
      const owner = cardByName.get(normalizeName(alias));
      if (owner && owner.slug !== card.slug && !owners.includes(owner) && !paired.has(pairKey(owner.slug, card.slug))) {
        owners.push(owner);
      }
    }
    // 別名裡掛了兩個真人的名字就說不清是誰，交給作者自己看，不列。
    if (owners.length !== 1) {
      continue;
    }
    paired.add(pairKey(owners[0].slug, card.slug));
    groups.push({
      cards: [owners[0], card],
      strength: 'summary',
      evidence: `「${card.name}」是劇作稱謂、不是名字，它的別名「${owners[0].name}」是另一張卡的正式名，多半是同一個人。`,
    });
  }

  // ---- 3. 名字包含（弱提示） ----
  for (const a of cards) {
    for (const b of cards) {
      if (a.slug === b.slug || a.name.length <= b.name.length || !a.name.endsWith(b.name)) {
        continue;
      }
      if (paired.has(pairKey(a.slug, b.slug)) || identity.areDifferent(a.name, b.name)) {
        continue;
      }
      paired.add(pairKey(a.slug, b.slug));
      groups.push({
        cards: [a, b],
        strength: 'naming',
        evidence: `「${a.name}」的名字以「${b.name}」結尾，可能是同一個人的兩種寫法——但摘要裡沒有證據，請自行判斷。`,
      });
    }
  }

  // 已有卡的正式名撞車也算重複（摘要裡可能一次都沒出現過）。
  const index = await buildCastIndex(project);
  for (const conflict of index.conflicts.filter((c) => c.kind === 'name')) {
    const owners = conflict.slugs.map((s) => bySlug.get(s)).filter((c): c is CharacterCard => !!c);
    if (owners.length > 1 && !paired.has(pairKey(owners[0].slug, owners[1].slug))) {
      paired.add(pairKey(owners[0].slug, owners[1].slug));
      groups.push({
        cards: owners,
        strength: 'summary',
        evidence: `這幾張卡都宣告自己叫「${conflict.name}」。`,
      });
    }
  }

  // 證據強的排前面，戲份重的再靠前。
  return groups.sort(
    (x, y) =>
      (x.strength === y.strength ? 0 : x.strength === 'summary' ? -1 : 1) ||
      countAppearances(y) - countAppearances(x)
  );
}

function countAppearances(group: DuplicateGroup): number {
  return group.cards.reduce((sum, c) => sum + c.appearsIn.length, 0);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

/**
 * 查詢並合併重複角色卡——工程頁「角色」分組的右鍵動作。
 *
 * 逐組問作者保留哪一張，**絕不自動決定**：證據再強也只是啟發式，
 * 把兩個角色錯併成一個遠比多一張卡難收拾。
 */
export async function mergeDuplicateCharacterCards(project: NovelProject): Promise<void> {
  const groups = await findDuplicateCards(project);
  // 名字是稱謂、又對不上任何一張真名卡的：沒法替作者並，只能請作者改名或刪掉。
  const grouped = new Set(groups.flatMap((g) => g.cards.map((c) => c.slug)));
  const labelOnly = (await project.listCharacters()).filter((c) => isRoleLabel(c.name) && !grouped.has(c.slug));
  const labelHint =
    labelOnly.length > 0
      ? `${labelOnly.map((c) => `「${c.name}」`).join('')}的名字是劇作稱謂、找不到真名那張卡，請改成真名或刪掉：` +
        labelOnly.map((c) => c.relPath).join('、')
      : '';
  if (labelOnly.length > 0) {
    log.warn('有角色卡的名字是劇作稱謂', labelHint);
  }
  if (groups.length === 0) {
    log.info('沒有發現重複角色卡');
    getHost().toast(labelHint ? `沒有發現重複的角色卡。${labelHint}` : '沒有發現重複的角色卡。');
    return;
  }

  const strong = groups.filter((g) => g.strength === 'summary').length;
  const pick = await getHost().confirm(
    `發現 ${groups.length} 組疑似重複的角色卡，逐組處理？`,
    ['逐組處理'],
    {
      modal: true,
      detail: [
        groups
          .slice(0, 8)
          .map((g) => `${g.strength === 'summary' ? '●' : '○'} ${g.cards.map((c) => `「${c.name}」`).join(' / ')}`)
          .join('\n') + (groups.length > 8 ? `\n……另有 ${groups.length - 8} 組` : ''),
        `● ${strong} 組有摘要證據，○ ${groups.length - strong} 組只是名字像，需要你自己判斷。`,
        '不調模型。每組都會先問保留哪一張；被合併的卡搬進 .novelwarden/.trash/，可手動找回。'
          + '注意：**被合併卡的正文小節不會自動融合**，合併後建議對保留的卡跑一次「從頭重建角色卡」。',
        labelHint,
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  );
  if (pick !== '逐組處理') {
    log.info('使用者取消了重複卡合併');
    return;
  }

  let merged = 0;
  let skipped = 0;
  /** 已經被並掉的卡。同一張卡可能出現在兩組候選裡，第二次輪到它時檔案已經不在了。 */
  const gone = new Set<string>();

  for (const group of groups) {
    const alive = group.cards.filter((c) => !gone.has(c.slug));
    if (alive.length < 2) {
      log.info('跳過一組重複卡', `${group.cards.map((c) => c.name).join(' / ')}｜其中的卡已在上一組裡被合併`);
      continue;
    }
    // 戲份重的排前面：多半就是該保留的那張。名字是稱謂的（`反派`）永遠排最後——該留的是真名那張。
    const sorted = [...alive].sort(
      (a, b) => Number(isRoleLabel(a.name)) - Number(isRoleLabel(b.name)) || b.appearsIn.length - a.appearsIn.length
    );
    // 按鈕太多的模態框沒法看。只讓前幾張當候選，其餘照樣會被並進去（詳情裡列全）。
    const choices = sorted.slice(0, 4);
    const labels = choices.map((c) => `保留「${c.name}」`);
    const choice = await getHost().confirm(`合併 ${sorted.map((c) => `「${c.name}」`).join(' / ')}？`, labels, {
      modal: true,
      detail: [
        group.evidence,
        sorted
          .map(
            (c) =>
              `「${c.name}」：${c.relPath}｜出場 ${c.appearsIn.length} 章｜已讀到第 ${c.updatedThrough ?? 0} 章｜` +
              `別名 ${c.aliases.length > 0 ? c.aliases.join('、') : '無'}`
          )
          .join('\n'),
        sorted.length > choices.length
          ? `本組有 ${sorted.length} 張卡，按鈕只列出出場最多的 ${choices.length} 張；選中哪一張，其餘 ${sorted.length - 1} 張都會並進去。`
          : '',
        '選中的那張保留並吸收其餘卡的別名/標籤/出場章；其餘卡搬進回收站。取消則跳過這一組。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const keeper = choices[labels.indexOf(choice ?? '')];
    if (!keeper) {
      skipped++;
      log.info('跳過一組重複卡', sorted.map((c) => c.name).join(' / '));
      continue;
    }
    const losers = sorted.filter((c) => c.slug !== keeper.slug);
    if (await mergeInto(project, keeper, losers)) {
      losers.forEach((l) => gone.add(l.slug));
      merged++;
    }
  }

  project.invalidate();
  const summary = `合併 ${merged} 組${skipped > 0 ? `，跳過 ${skipped} 組` : ''}`;
  log.info('重複角色卡處理結束', summary);
  getHost().toast(`${summary}。`);
}

/** 把 losers 並進 keeper：後設資料取並集，loser 的檔案搬進回收站。返回是否成功。 */
async function mergeInto(project: NovelProject, keeper: CharacterCard, losers: CharacterCard[]): Promise<boolean> {
  const aliases = sanitizeAliases(
    [...keeper.aliases, ...losers.flatMap((l) => [l.name, ...l.aliases])],
    keeper.name
  );
  const tags = [...new Set([...keeper.tags, ...losers.flatMap((l) => l.tags)])];
  const appearsIn = [...new Set([...keeper.appearsIn, ...losers.flatMap((l) => l.appearsIn)])].sort(
    (a, b) => a - b
  );

  /**
   * 「已讀到」是一條水位線，越過去的章永遠不會被重讀。keeper 從沒讀過
   * loser 那些章，所以水位線必須退回**第一章沒讀過的之前**，否則合進來的
   * 出場章會被增量更新整批跳過，而介面上看不出任何異常。
   */
  const unread = appearsIn.filter((o) => !keeper.appearsIn.includes(o));
  const updatedThrough = Math.min(keeper.updatedThrough ?? 0, unread.length > 0 ? Math.min(...unread) - 1 : Number.POSITIVE_INFINITY);

  const abs = project.pathOf(keeper.relPath);
  const rewritten = rewriteFrontmatter(await readText(abs), {
    aliases,
    tags,
    // frontmatter 裡陣列統一按字串寫；渲染出來是 `appearsIn: [2, 3, 5]`，與既有格式一致。
    appearsIn: appearsIn.map(String),
    firstAppear: appearsIn[0] ?? keeper.firstAppear,
    lastSeen: appearsIn[appearsIn.length - 1] ?? keeper.lastSeen,
    updatedThrough,
  });
  if (!rewritten) {
    log.error(`「${keeper.name}」沒有 frontmatter，合併中止`, keeper.relPath);
    getHost().toast(`「${keeper.name}」的角色卡缺少 frontmatter，無法合併。`, 'error');
    return false;
  }
  // 經閘道器寫（第 7 條）：守衛照過，覆蓋之前舊卡存一版歷史；不彈審閱——逐組的「保留「…」」就是那一問。
  const ws = new Workspace(project);
  await ws.write(keeper.relPath, { text: rewritten }, { mode: 'overwrite', review: false });

  for (const loser of losers) {
    // 經閘道器刪：搬進 `.trash/` 並保留原相對路徑（第 6 條，落點與工程頁的刪除同一套 `trashPathFor`）。
    await ws.remove(loser.relPath);
    log.info(`「${loser.name}」已併入「${keeper.name}」`, `原卡移到回收站：${loser.relPath}`);
  }

  log.info(
    `「${keeper.name}」合併完成`,
    `別名 ${aliases.length} 個｜出場 ${appearsIn.length} 章｜「已讀到」退回第 ${updatedThrough} 章` +
      `${unread.length > 0 ? `（新併入 ${unread.length} 章未讀，建議跑一次更新）` : ''}`
  );
  return true;
}
