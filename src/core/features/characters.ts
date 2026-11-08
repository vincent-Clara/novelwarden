/**
 * 從選定的幾段正文批次提取 / 更新角色卡（預設勾最近幾章，隨上下文詳細度）。
 *
 * - 模型給的名字是劇作稱謂的（「反派（別名：韓厲）」）換成真名、稱謂挪進 tags，沒有真名的不建卡。
 * - 同一批先 `mergeWithinBatch` 再和已有的卡比：同名的併成一條；別名是同批另一條正式名的只去掉那個別名、
 *   兩人都留（同章共現即兩人，第 14 條）。
 * - 按人物、按小標題寫 1 次，轉寫那一檔照抄成陣列 1 次（`TRANSCRIBED_CALLS`，解碼是 `parseCharacterResponse`）；
 *   轉寫沒成同解析不出來。
 *
 * 系統提示詞在 charactersPrompt.ts。
 */
import { getHost, plainVerdict } from '../host';
import { collectText } from '../llm/collect';
import { StreamOptions } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { contextLimitsOf, takeLast } from '../model/contextDetail';
import { resolveSectionDir } from '../files/fileOps';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { readText, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, emptyCharacterSections, renderCharacterCard } from '../model/project';
import { CHARACTER_SECTION_KEYS, Chapter, CharacterCard, CharacterSections } from '../model/types';
import { LORE_PLACEHOLDER_PREFIX } from '../model/loreFile';
import { normalizeName, resolveRoleLabelName, sanitizeAliases } from '../model/naming';
import { keepGender, normalizeGender } from '../model/gender';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { stampState } from '../model/characterState';
import { CHARACTER_JSON_CONTRACT, CHARACTER_SYSTEM } from './charactersPrompt';
import { extractJsonArray, stringArray, stripCodeFence, unique } from './parse';
import { pickPlotsByInput } from './pickPlots';
import { withCallChoice } from '../runtime/callScope';
import { askCall } from './askCall';
import { TRANSCRIBED_CALLS, describeCalls } from '../model/pipeline';
import { poolTranscriber } from './poolIO';
import { TranscribeSpec, transcribeJson } from './transcribe';

const log = scoped('角色卡');

/**
 * 從選定的章節提取/更新角色卡。
 *
 * 讀的是 `chapters/` 裡的正文——人物怎麼說話、什麼脾氣只有正文裡看得出，
 * 細綱裡沒有。所以還沒寫正文（0 字）的章不在候選裡。
 *
 * 關鍵約束：**絕不靜默覆蓋作者手寫的角色卡**。已存在的角色一律經
 * 宿主審閱（外掛開 diff 編輯器，獨立版彈確認框）；新角色則直接建立。
 */
export async function extractCharacters(project: NovelProject): Promise<void> {
  const written = (await project.listChapters()).filter((c) => c.wordCount > 0);
  if (written.length === 0) {
    log.warn('還沒有寫過正文，無法提取角色');
    getHost().toast('還沒有寫過正文。');
    return;
  }

  // 預設勾最近幾章（上下文詳細度，預設三章）；選得越多越準，但消耗的 token 也越多。
  const config = readConfig();
  const picked = await pickPlotsByInput(
    written.map((c) => ({ no: c.order, title: c.title, chapter: c })),
    '從哪幾章提取角色資訊？',
    '輸入章號，逗號分隔，如 1,2,3',
    takeLast(written, contextLimitsOf(config).characterChapters).map((c) => c.order)
  );
  if (!picked || picked.length === 0) {
    log.info('使用者取消了章節選擇');
    return;
  }
  const answer = await askCall({
    message: `提取角色卡：讀第 ${picked.map((p) => p.no).join('、')} 章正文，新角色直接建卡，已有角色的更新逐個對比後再寫。${describeCalls(TRANSCRIBED_CALLS)}。`,
    actions: ['開始提取'],
    tasks: ['extractCharacters', 'transcribe'],
    // 讀哪幾章上一步已經選定了，詳細度管不著這一次。
    contextDetail: false,
  });
  if (answer?.action !== '開始提取') {
    log.info('使用者取消了提取角色');
    return;
  }
  return withCallChoice(answer.choice, () => runExtract(project, picked));
}

/** 問完之後：一次呼叫讀選定的幾章，建新卡、對比已有的。 */
async function runExtract(project: NovelProject, picked: { no: number; title: string; chapter: Chapter }[]): Promise<void> {
  // 確認框之後重新讀：作者挑的模型與詳細度在這之後才有（features/askCall.ts）。
  const config = readConfig();
  // 一批章節一次呼叫，談不上併發；走池是為了拿到「首選失敗就換模型」。
  const pool = await createModelPool({ task: 'extractCharacters', concurrent: false });
  if (!pool) {
    log.error('沒有可用的模型，提取中止');
    return;
  }
  const existing = await project.listCharacters();
  log.info(
    `準備從 ${picked.length} 章提取角色`,
    `章節 ${picked.map((p) => p.no).join('、')}｜已有角色卡 ${existing.length} 張｜模型 ${pool.label}`
  );

  await runTask(
    '提取角色資訊',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      // 三步：讀正文 → 調模型 → 合併。給 total 才畫得出進度條。
      report({ message: '讀取正文', current: 0, total: 3 });
      const selected = [...picked].sort((a, b) => a.no - b.no);
      // 預算跟著實際幹活的模型走，不是對話頁選的那個。
      const budget = pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000;
      const corpus = await buildCorpus(project, selected, budget);
      log.debug('正文已讀取', `${corpus.length} 字（約 ${estimateTokens(corpus)} token）`);

      const knownList =
        existing.length > 0
          ? existing.map((c) => `- ${c.name}${c.aliases.length ? `（別名：${c.aliases.join('、')}）` : ''}`).join('\n')
          : '（暫無已有角色卡）';

      report({ message: '呼叫模型分析人物', current: 1, total: 3 });
      const options: StreamOptions = {
        maxOutputTokens: pool.primaryBudget.maxOutputTokens,
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };
      const modelStart = Date.now();
      const raw = await pool.run('提取角色', (llm) =>
        collectText(
          llm.stream(
            [
              { role: 'system', content: CHARACTER_SYSTEM },
              {
                role: 'user',
                content: `已有角色卡（同一人請沿用既有名字，不要另起新名）：\n${knownList}\n\n以下是正文：\n\n${corpus}`,
              },
            ],
            options
          )
        )
      );
      log.info('模型已返回', `${raw.length} 字，用時 ${elapsed(modelStart)}`);

      if (signal.aborted) {
        log.warn('提取被取消');
        return;
      }

      // 2026-10-25 起改成轉寫：按人物、按小標題寫的檔案交給轉寫那一檔照抄成 JSON（原文字身就是 JSON 的不轉）。
      // 轉寫沒成同從前解析不出來：一張卡都不動，說一聲。
      const r = await transcribeJson(raw, CHARACTERS_SPEC, poolTranscriber(signal, pool));
      if (r.notes.length > 0) {
        log.info(`提取角色：轉寫 ${r.calls} 次`, r.notes.join('\n'));
      }
      if (!r.ok) {
        log.warn(`沒有解析出角色資訊（${r.message}）`, `模型返回開頭：${raw.slice(0, 300)}`);
        getHost().toast('沒有從這些章節中解析出角色資訊。');
        return;
      }
      const parsed = r.value;

      report({ message: `解析出 ${parsed.length} 個角色，正在合併`, current: 2, total: 3 });
      log.info(`解析出 ${parsed.length} 個角色`, parsed.map((p) => p.name).join('、'));
      await mergeCharacters(project, parsed, existing, {
        firstNo: selected[0].no,
        lastNo: selected[selected.length - 1].no,
        nos: selected.map((p) => p.no),
      });
      report({ message: '完成', current: 3, total: 3 });
      log.info('提取結束', `總耗時 ${elapsed(startedAt)}`);
    },
    { scope: '角色卡' }
  );
}

interface ParsedCharacter {
  name: string;
  aliases: string[];
  tags: string[];
  gender?: string;
  sections: CharacterSections;
}

async function mergeCharacters(
  project: NovelProject,
  parsed: ParsedCharacter[],
  existing: CharacterCard[],
  range: { firstNo: number; lastNo: number; nos: number[] }
): Promise<void> {
  const batch = mergeWithinBatch(parsed);
  const byName = new Map<string, CharacterCard>();
  // 正式名先佔位，別名後補：一張卡上寫錯的別名（模型給方源掛過 `方正`）
  // 搶不走另一張卡的正式名。泛稱別名（`姐姐`/`她`）一律不進表——它們誰都能用。
  for (const card of existing) {
    byName.set(card.name, card);
  }
  for (const card of existing) {
    for (const alias of sanitizeAliases(card.aliases, card.name)) {
      if (!byName.has(alias)) {
        byName.set(alias, card);
      }
    }
  }

  const created: string[] = [];
  const pendingDiff: ParsedCharacter[] = [];

  for (const item of batch) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (match) {
      pendingDiff.push(item);
      continue;
    }
    // 新角色：直接建立，沒有可覆蓋的人工內容。
    const slug = await uniqueSlug(project.charactersDir, slugify(item.name));
    // 「當前狀態」是從這幾章裡提取的：蓋章歸機器（D15），寫到這一批的最後一章。
    const relPath = await new Workspace(project).writeCharacter(
      stampState(
        {
          slug,
          name: item.name,
          aliases: item.aliases,
          tags: item.tags,
          gender: item.gender,
          firstAppear: range.firstNo,
          lastSeen: range.lastNo,
          // 這一批章節就是目前已知的出場記錄。出場索引（定稿過的細綱）之後會給出更完整的清單，
          // 這裡先落一份，免得新卡在角色頁上顯示「未在定稿中出現」。
          appearsIn: range.nos,
          updatedThrough: range.lastNo,
          sections: item.sections,
        },
        range.lastNo
      )
    );
    log.info(`新建角色卡「${item.name}」`, relPath);
    created.push(item.name);
  }

  if (created.length > 0) {
    getHost().toast(`新建角色卡 ${created.join('、')}。`);
  }

  if (pendingDiff.length === 0) {
    return;
  }

  const names = pendingDiff.map((p) => p.name).join('、');
  log.info(`${pendingDiff.length} 張已有角色卡有更新建議`, names);
  const choice = await getHost().confirm(
    `已有角色卡的更新：${names}。要逐個對比確認嗎？`,
    ['逐個對比', '跳過更新'],
    { modal: true }
  );
  if (choice !== '逐個對比') {
    log.info('使用者跳過了已有角色卡的更新');
    return;
  }

  for (const item of pendingDiff) {
    const match = byName.get(item.name) ?? item.aliases.map((a) => byName.get(a)).find(Boolean);
    if (!match) {
      continue;
    }
    await reviewCharacterUpdate(project, match, item, range);
  }
}

/**
 * 讓作者對比「現有角色卡」與「模型建議」，確認後才寫入。
 * 外掛宿主開 diff 編輯器；獨立版彈確認框（Host.reviewReplace）。
 */
async function reviewCharacterUpdate(
  project: NovelProject,
  existing: CharacterCard,
  proposed: ParsedCharacter,
  range: { lastNo: number; nos: number[] }
): Promise<void> {
  // 合併策略：模型有內容的小節覆蓋，模型留空的保留原文；別名/標籤取並集；性別卡上寫了的不動。
  const merged: CharacterSections = { ...existing.sections };
  for (const key of CHARACTER_SECTION_KEYS) {
    const next = proposed.sections[key]?.trim();
    if (next && next !== '無' && next !== '（待補充）') {
      merged[key] = next;
    }
  }

  const appearsIn = [...new Set([...existing.appearsIn, ...range.nos])].sort((a, b) => a - b);
  const baseCard = {
    ...existing,
    slug: existing.slug,
    name: existing.name,
    aliases: unique(sanitizeAliases([...existing.aliases, ...proposed.aliases], existing.name)),
    tags: unique([...existing.tags, ...proposed.tags]),
    gender: keepGender(existing.gender, proposed.gender),
    firstAppear: existing.firstAppear ?? appearsIn[0],
    lastSeen: Math.max(existing.lastSeen ?? 0, range.lastNo) || range.lastNo,
    appearsIn,
    // 這次讀到了哪一章，下次「更新角色卡」的增量從這裡接著走。
    updatedThrough: Math.max(existing.updatedThrough ?? 0, range.lastNo),
    sections: merged,
  };
  // 模型給了新的「當前狀態」才蓋章（D15）；沒給就沿用舊卡那一節，連同舊卡的章。
  const nextState = proposed.sections.当前状态?.trim();
  const mergedCard = nextState && nextState !== '無' && nextState !== '（待補充）' ? stampState(baseCard, range.lastNo) : baseCard;

  const proposedText = renderCharacterCard(mergedCard);
  const currentAbs = project.pathOf(existing.relPath);
  const currentText = await readText(currentAbs);

  let verdict: 'apply' | 'discard' | undefined;
  const host = getHost();
  if (host.reviewReplace) {
    verdict = plainVerdict(await host.reviewReplace(existing.name, currentText, proposedText, existing.relPath));
  } else {
    // 宿主未實現審閱能力時退化為純確認（不展示差異）。
    const pick = await getHost().confirm(
      `已生成對「${existing.name}」的更新（合併模型建議與現有內容）。直接採納？`,
      ['採納', '跳過'],
      { modal: true }
    );
    verdict = pick === '採納' ? 'apply' : pick === '跳過' ? 'discard' : undefined;
  }

  if (verdict === 'apply') {
    // 作者在上面那張審閱裡點了採納：經閘道器寫回（守衛照過、舊內容先進歷史版本），`review: false`——不問第二次。
    await new Workspace(project).write(existing.relPath, { text: proposedText }, { mode: 'overwrite', review: false });
    log.info(`已更新角色卡「${existing.name}」`, `${existing.relPath}｜${currentText.length} 字 → ${proposedText.length} 字`);
    getHost().toast(`已更新「${existing.name}」。`);
  } else {
    log.info(`跳過角色卡「${existing.name}」`, verdict === 'discard' ? '使用者放棄' : '使用者取消');
  }
}

/**
 * 手動新建一張空角色卡。
 * `dir` 是落點目錄（工作區相對路徑，如 `.novelwarden/characters/主角`）；
 * 預設或越界時落在 characters/ 根下。
 */
export async function newCharacter(project: NovelProject, dir?: string): Promise<void> {
  const target = resolveSectionDir(project, 'characters', dir);
  const root = project.relPath(project.charactersDir);
  const name = await getHost().input({
    title: '新建角色卡',
    prompt: target === root ? '角色姓名' : `角色姓名（建到 ${target}/）`,
    validate: (v) => (v.trim() ? undefined : '不能為空'),
  });
  if (!name) {
    return;
  }
  // slug 帶上子目錄字首，writeCharacter 會連中間目錄一起建出來。
  const prefix = target === root ? '' : `${target.slice(root.length + 1)}/`;
  const slug = await uniqueSlug(project.charactersDir, `${prefix}${slugify(name)}`);
  const relPath = await new Workspace(project).writeCharacter({
    slug,
    name: name.trim(),
    aliases: [],
    tags: [],
    sections: emptyCharacterSections(),
  });
  await getHost().openFile(relPath);
}

/**
 * 手動新建一條設定。`dir` 同 newCharacter（目錄就是分類，還不存在就一併建出來）。
 * `name` 給了就不再問標題——工程頁「出現過 · 未建條目」那一行右鍵新建時帶著名字。
 */
export async function newLore(project: NovelProject, dir?: string, name?: string): Promise<void> {
  const target = resolveSectionDir(project, 'lore', dir);
  const root = project.relPath(project.loreDir);
  const title =
    name?.trim() ||
    (await getHost().input({
      title: '新建設定條目',
      prompt: target === root ? '設定標題（如「玄門七宗」）' : `設定標題（建到 ${target}/）`,
      validate: (v) => (v.trim() ? undefined : '不能為空'),
    }));
  if (!title) {
    return;
  }
  const prefix = target === root ? '' : `${target.slice(root.length + 1)}/`;
  const slug = await uniqueSlug(project.loreDir, `${prefix}${slugify(title)}`);
  const rel = `${root}/${slug}.md`;
  // 經閘道器新建（`create`：同名報錯退出、不覆蓋——上面挑過不撞名的 slug，撞上只可能是這一瞬間別處剛建了同名的）。
  await new Workspace(project).write(
    rel,
    {
      text:
        `---\ntitle: ${title.trim()}\nkeywords: [${title.trim()}]\n---\n\n# ${title.trim()}\n\n` +
        `${LORE_PLACEHOLDER_PREFIX}：它是什麼、有什麼規則與邊界、現在是什麼狀態。frontmatter 裡可以加一行 brief 寫一句話簡介，` +
        '名錄裡那一行顯示它；keywords 寫它的別稱，正文或細綱裡提到時會自動帶進上下文。）\n',
    },
    { mode: 'create' }
  );
  await getHost().openFile(rel);
}

// ---------------------------------------------------------------- 解析

/**
 * 提取角色轉寫那一步（2026-10-25 起改成轉寫）：合同是 {@link CHARACTER_JSON_CONTRACT}，解碼就是下面的
 * {@link parseCharacterResponse}（劇作稱謂換真名那些後處理都在裡面）。一個人都整理不出來算不合格；性別按對應關係填，
 * 不比原文；原文連「身份」「性格」這幾節都沒有的不轉。
 */
const CHARACTERS_SPEC: TranscribeSpec<ParsedCharacter[]> = {
  label: '提取角色',
  contract: CHARACTER_JSON_CONTRACT,
  decode: (json) => {
    const list = parseCharacterResponse(json);
    return list.length > 0 ? { ok: true, value: list } : { ok: false, message: '一個人物都整理不出來：要一個陣列，每項帶 name' };
  },
  mapped: ['性别', 'gender'],
  looksLike: (source) => /身份|性格|(?:语|語)言(?:习|習)(?:惯|慣)|(?:当|當)前(?:状|狀)(?:态|態)/.test(source),
};

/**
 * 解析模型返回（轉寫出來的、或模型直接給的 JSON 陣列）；解析失敗時返回空陣列由呼叫方提示，
 * 不做「猜測式」兜底——角色卡寫錯比沒寫更麻煩。
 */
export function parseCharacterResponse(raw: string): ParsedCharacter[] {
  const text = stripCodeFence(raw);
  const jsonText = extractJsonArray(text);
  if (!jsonText) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }

  const out: ParsedCharacter[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      continue;
    }
    const sections = emptyCharacterSections();
    for (const key of CHARACTER_SECTION_KEYS) {
      const value = obj[key];
      if (typeof value === 'string') {
        sections[key] = value.trim();
      } else if (Array.isArray(value)) {
        sections[key] = value.filter((v) => typeof v === 'string').map((v) => `- ${v}`).join('\n');
      }
    }
    // 「反派（別名：韓厲）」：稱謂不是名字，換成別名裡的真名、稱謂挪進 tags；別名裡沒有真名的不建卡。
    const resolved = resolveRoleLabelName(name, sanitizeAliases(unique(stringArray(obj.aliases)), name));
    if (!resolved) {
      log.warn(`「${name}」是劇作稱謂，別名裡也沒有真名，不建卡`);
      continue;
    }
    if (resolved.label) {
      log.info(`「${resolved.label}」是劇作稱謂，改用別名裡的「${resolved.name}」`);
    }
    out.push({
      name: resolved.name,
      aliases: resolved.aliases,
      tags: unique([...stringArray(obj.tags), ...(resolved.label ? [resolved.label] : [])]),
      gender: normalizeGender(obj.性别 ?? obj.gender),
      sections,
    });
  }
  return out;
}

/**
 * 同一次返回裡的條目先互相對一遍，再去和已有的卡比。
 *
 * - **同名的併成一條**：別名、標籤取並集，小節以先出現的為準、空的用後一條補，性別同理。
 *   「反派（別名：韓厲）」換名之後就是第二個「韓厲」，不併會建出 `韩厉.md` 與 `韩厉-2.md`。
 * - **別名是同一批另一條的正式名，刪掉這個別名，不併**：模型把兩個人列成兩條，就是認為
 *   他們是兩個人（與「同章共現即兩人」同一個道理，AGENTS 第 14 條）；那個別名才是錯的——
 *   實戰裡方源的卡掛過孿生弟弟「方正」，按別名並會把方正整個人吞掉。
 */
export function mergeWithinBatch(parsed: readonly ParsedCharacter[]): ParsedCharacter[] {
  const out: ParsedCharacter[] = [];
  for (const item of parsed) {
    const same = out.find((p) => normalizeName(p.name) === normalizeName(item.name));
    if (!same) {
      out.push({ ...item, aliases: [...item.aliases], tags: [...item.tags], sections: { ...item.sections } });
      continue;
    }
    same.aliases = sanitizeAliases(unique([...same.aliases, ...item.aliases]), same.name);
    same.tags = unique([...same.tags, ...item.tags]);
    same.gender = keepGender(same.gender, item.gender);
    for (const key of CHARACTER_SECTION_KEYS) {
      if (!same.sections[key]?.trim() && item.sections[key]?.trim()) {
        same.sections[key] = item.sections[key];
      }
    }
    log.info(`同一批裡「${item.name}」出現了兩次，已併成一條`);
  }
  const names = new Set(out.map((p) => normalizeName(p.name)));
  for (const item of out) {
    const borrowed = item.aliases.filter((a) => names.has(normalizeName(a)) && normalizeName(a) !== normalizeName(item.name));
    if (borrowed.length > 0) {
      item.aliases = item.aliases.filter((a) => !borrowed.includes(a));
      log.warn(`「${item.name}」的別名 ${borrowed.join('、')} 是同一批另一個人的名字，已去掉`);
    }
  }
  return out;
}

async function buildCorpus(
  project: NovelProject,
  items: { no: number; title: string; chapter: Chapter }[],
  budget: number
): Promise<string> {
  const parts: string[] = [];
  for (const item of items) {
    const text = await project.readChapterText(item.chapter);
    parts.push(`【第${item.no}章 ${item.title}】\n${text}`);
  }
  const joined = parts.join('\n\n');
  const clipped = takeHead(joined, Math.max(2000, budget));
  if (clipped.length < joined.length) {
    // 「不靜默截斷」：選了五章卻只讀進去兩章半，作者必須知道。
    log.warn(
      '選中章節的正文超出輸入預算，已截斷',
      `${joined.length} 字 → ${clipped.length} 字。少選幾章可讓提取更完整。`
    );
  }
  return clipped;
}
