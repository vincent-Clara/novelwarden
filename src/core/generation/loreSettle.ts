/**
 * 落定設定（完善設定二期）的落盤：把一段討論裡定下來的一批設定寫進 `lore/`。只在作者在落盤卡片上點了「寫入」之後
 * 發生（第 19 條）；分派在 generation/accept.ts（`loreEntries` 帶 `settle`）。
 *
 * 氣泡裡那一份帶著生成那一刻認出的路徑，這裡**按磁碟再認一遍**（features/loreSettle.ts 的 `findSettledEntry`，
 * 與生成鏈同一個函式）：作者這期間可能改了名、刪了條目、新建了同名的。卡片上「會新建 / 會更新」兩行也是這一遍
 * （{@link plannedLoreSettle}），說的和做的是同一件事。
 */
import { scoped } from '../runtime/logger';
import { hash, slugify, uniqueSlug } from '../model/fs';
import { NovelProject, renderLoreEntry } from '../model/project';
import { cleanLoreKeywords, createLoreLookup, normalizeLoreName } from '../model/loreFile';
import type { LoreEntry } from '../model/types';
import type { LoreDraft } from '../features/loreExpand';
import { findSettledEntry } from '../features/loreSettle';
import { unique } from '../features/parse';
import { buildLoreIndex } from '../views/lore';
import type { Workspace } from '../workspace';
import type { AcceptResult } from './accept';

const log = scoped('創作');

/** 一條要落定的設定按磁碟認下來：改哪一條已有的，或者新建；是人名的不建。 */
type Resolved = { draft: LoreDraft; existing?: LoreEntry; person?: boolean };

/** 按磁碟認一遍：人名的標出來；同一條已有條目被認了兩次的只留第一次；新建的同名（歸一後）只留第一條。 */
async function resolveAll(project: NovelProject, drafts: readonly LoreDraft[]): Promise<{ list: Resolved[]; entries: LoreEntry[]; people: string[] }> {
  const [entries, cards] = await Promise.all([project.listLore(), project.listCharacters()]);
  const lookup = createLoreLookup(entries);
  const people = cards.flatMap((c) => [c.name, ...c.aliases, c.slug]);
  const isPerson = new Set(people.map(normalizeLoreName).filter(Boolean));
  const used = new Set<string>();
  const fresh = new Set<string>();
  const list: Resolved[] = [];
  for (const draft of drafts) {
    const key = normalizeLoreName(draft.title);
    if (!key) {
      continue;
    }
    const existing = findSettledEntry(entries, draft, lookup);
    if (existing) {
      if (!used.has(existing.relPath)) {
        used.add(existing.relPath);
        list.push({ draft, existing });
      }
      continue;
    }
    if (isPerson.has(key)) {
      list.push({ draft, person: true });
      continue;
    }
    if (!fresh.has(key)) {
      fresh.add(key);
      list.push({ draft });
    }
  }
  return { list, entries, people };
}

/** 落盤卡片上那兩行：會新建哪幾條、會更新哪幾條（已有條目的標題）。與 {@link acceptSettledLore} 同一遍認法。 */
export async function plannedLoreSettle(
  project: NovelProject,
  drafts: readonly LoreDraft[]
): Promise<{ creates: string[]; updates: string[] }> {
  const { list } = await resolveAll(project, drafts);
  return {
    creates: list.filter((r) => !r.existing && !r.person).map((r) => r.draft.title),
    updates: list.filter((r) => r.existing).map((r) => r.existing!.title),
  };
}

/**
 * 落定設定：
 *
 * - **新的**直接建在 `lore/<分類>/`（目錄不存在就建）：新檔案不覆蓋任何東西，不走審閱。正文是機器寫的，記
 *   `bodyHash`；水位 `updatedThrough: 0`（同設定清單新建的）。
 * - **已有的**逐條落：關鍵詞只增不減（新給的過一遍人名、別的條目的標題、名錄裡另記著的名字）、一句話新的優先、
 *   正文換成合併後的完整版，記作機器寫的（`bodyHash`）。**水位不動**：這是在原有內容上並進討論結論，不是整條換新
 *   ——不能照設定清單撞名時那樣歸 0，不然已經整合進去的那些章又掛上 ＋N。**一律走覆蓋審閱**，一條一審（第 3 條），
 *   放棄了那一條就原樣留著；只有一句話的也先對比（作者 2026-10-19 定的，不照展開那樣直接寫）。
 * - 是角色卡上的人的不建（人不是設定）。
 *
 * 還沒定的問題（`questions`）不在這裡——它只上卡片，不寫進任何檔案。建了幾條、更新了幾條、保留了哪幾條，必須說出來。
 */
export async function acceptSettledLore(project: NovelProject, ws: Workspace, drafts: readonly LoreDraft[]): Promise<AcceptResult> {
  const { list, entries, people } = await resolveAll(project, drafts);
  const others = {
    titles: [...entries.map((e) => e.title), ...drafts.map((d) => d.title)],
    people,
    recorded: (await buildLoreIndex(project, { entries }, { pending: false })).unknown.map((u) => u.name),
  };
  const created: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  const skippedPeople: string[] = [];
  let first: string | undefined;

  for (const { draft, existing, person } of list) {
    const body = draft.body.trim();
    if (person) {
      skippedPeople.push(draft.title);
      continue;
    }
    if (existing) {
      const text = renderLoreEntry({
        slug: existing.slug,
        title: existing.title,
        keywords: unique([...existing.keywords, ...cleanLoreKeywords(existing.title, draft.keywords, others)]),
        brief: draft.brief || existing.brief,
        ...(body
          ? { body, updatedThrough: existing.updatedThrough, bodyHash: hash(body) }
          : { body: existing.body, updatedThrough: existing.updatedThrough, bodyHash: existing.bodyHash }),
      });
      const r = await ws.write(existing.relPath, { text }, { mode: 'overwrite', what: `設定「${existing.title}」`, review: true });
      (r.skipped ? kept : updated).push(existing.title);
      first ??= r.skipped ? undefined : existing.relPath;
      continue;
    }
    const slug = await uniqueSlug(project.loreDir, `${draft.category ? `${draft.category}/` : ''}${slugify(draft.title)}`);
    const rel = await ws.writeLore({
      slug,
      title: draft.title,
      keywords: [draft.title, ...cleanLoreKeywords(draft.title, draft.keywords, others)],
      brief: draft.brief,
      body,
      updatedThrough: 0,
      bodyHash: hash(body),
    });
    created.push(draft.title);
    first ??= rel;
  }
  project.invalidate();

  const parts = [
    created.length > 0 ? `新建 ${created.length} 條設定條目（${created.join('、')}）` : '',
    updated.length > 0 ? `更新 ${updated.join('、')}` : '',
    kept.length > 0 ? `保留原樣的 ${kept.join('、')}` : '',
    skippedPeople.length > 0 ? `${skippedPeople.join('、')}是角色卡上的人，沒建` : '',
  ].filter(Boolean);
  log.info('落定設定已落盤', parts.join('；') || '（沒有改動）');
  return created.length + updated.length === 0
    ? { skipped: true, message: `沒有改動設定條目${parts.length > 0 ? `（${parts.join('，')}）` : ''}。` }
    : { relPath: first ?? project.relPath(project.loreDir), message: `落定設定：${parts.join('，')}。` };
}
