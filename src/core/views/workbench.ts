/**
 * 工作區卡的內容：**當前這一層的產物本身**。
 *
 * 與 [pipeline.ts](pipeline.ts) 同級同類——那邊聚合「這一章走到哪一步了」，
 * 這邊取出「我現在正在改的那份東西寫了什麼」。取數在這裡，判斷在純函式層。
 *
 * ## 為什麼需要它
 *
 * 作者看不見自己正在改的細綱寫了什麼——那些都在磁碟上，要看只能去開檔案。
 * 於是流水線在介面上只剩下幾個百分比，像個進度報表，而不是一個工作臺。
 *
 * ## 正文層給的是細綱，不是正文
 *
 * 寫正文時最常回頭看的是「這一章要落實哪幾件事、看點落在哪」——所以正文層的
 * 卡片攤的是本章細綱的各節，外加字數與目標。正文字身上萬字，塞進浮窗讀不下去，
 * 真要讀，「開啟」按鈕就在旁邊。大綱同理只給預覽——它可能有幾千字。
 */
import { scoped } from '../runtime/logger';
import { basename } from 'node:path';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, isPlotUpstreamStale, parsePlotFileName, plotContentHash } from '../model/plotFile';
import { SETTING_SECTION_KEYS } from '../model/settingFile';
import { hasContent, pickSections } from '../model/markdown';
import { LORE_BODY_KEYS, LORE_HIDDEN_KEY, loreThin, splitLoreHidden } from '../model/loreFile';
import {
  CreationTarget,
  SETTING_DOC_LABEL,
  STAGE_LABEL,
  describeTarget,
  describeThinLore,
  describeThreadReminders,
  plotLabel,
  stageOfTarget,
  unrecordedBefore,
} from '../model/pipeline';
import { chapterOfPlotNo } from './pipeline';
import { thinLoreFor } from './lore';
import { threadReminders } from './threads';
import { loreEntryAt } from './loreMaterial';
import { WorkbenchSection, WorkbenchView } from '../protocol';

const log = scoped('工作區');

/** 大綱預覽最多攤這麼多字。再多就該去開檔案了。 */
const OUTLINE_PREVIEW = 400;

/**
 * 當前目標那一層的產物。
 *
 * **絕不拋**：作者可能剛把某一章改名或刪掉，而介面上的 target 還指著它。
 * 那種時候給一張「找不到」的卡，比讓整條推送失敗強。
 */
export async function buildWorkbench(
  project: NovelProject,
  target: CreationTarget
): Promise<WorkbenchView> {
  try {
    return await build(project, target);
  } catch (err) {
    log.warn('工作區卡取數失敗', String(err));
    const stage = stageOfTarget(target);
    return { stage, title: STAGE_LABEL[stage], layer: STAGE_LABEL[stage], relPath: '', sections: [] };
  }
}

async function build(project: NovelProject, target: CreationTarget): Promise<WorkbenchView> {
  if (target.kind === 'setting') {
    const label = SETTING_DOC_LABEL[target.doc];
    if (target.doc === 'characters') {
      const cards = await project.listCharacters();
      return {
        stage: 'setting',
        title: `架構 · ${label}`,
        layer: label,
        relPath: project.relPath(project.charactersDir),
        sections: cards.length > 0 ? [{ key: '角色', text: cards.map((c) => c.name).join('、') }] : [],
        empty: cards.length > 0 ? undefined : '還沒有角色卡。按前提排出主角、盟友與對手。',
      };
    }
    // 設定清單同理：沒有自己的檔案，卡上按分類（目錄）列出已有的條目名。
    if (target.doc === 'lore') {
      const entries = await project.listLore();
      const byCategory = new Map<string, string[]>();
      for (const e of entries) {
        const list = byCategory.get(e.category) ?? byCategory.set(e.category, []).get(e.category)!;
        list.push(e.title);
      }
      return {
        stage: 'setting',
        title: `架構 · ${label}`,
        layer: label,
        relPath: project.relPath(project.loreDir),
        sections: [...byCategory].map(([category, titles]) => ({ key: category || '未分类', text: titles.join('、') })),
        empty: entries.length > 0 ? undefined : '還沒有設定條目。把世界觀裡點到的地點、勢力、能力體系、關鍵物品排成一份清單。',
      };
    }
    const doc = await project.readSettingDoc(target.doc);
    const sections = sectionsOf(doc.sections, SETTING_SECTION_KEYS[target.doc]);
    return {
      stage: 'setting',
      title: `架構 · ${label}`,
      layer: label,
      relPath: doc.relPath,
      sections,
      empty: sections.length > 0 ? undefined : `還沒有${label}。`,
    };
  }

  if (target.kind === 'outline') {
    const text = await project.readOutline();
    return {
      stage: 'outline',
      title: '情節大綱',
      layer: '情節大綱',
      relPath: project.relPath(project.outlinePath),
      sections: text.trim() ? [{ key: '大綱', text: clip(text, OUTLINE_PREVIEW) }] : [],
      empty: text.trim() ? undefined : '這部書還沒有情節大綱。一章一條把全書的走向排出來。',
    };
  }

  // 單條設定（展開，完善設定 2026-10-19）：卡上攤這一條的一句話與各節（暗設也攤——作者自己看，不進寫正文的上下文）。
  if (target.kind === 'lore') {
    const { entry, exists } = await loreEntryAt(project, target.relPath);
    const { visible, hidden } = splitLoreHidden(entry.body);
    const picked = pickSections(visible, LORE_BODY_KEYS);
    // 還只有一句話的（空的、佔位、三節全是「（未交代）」）正文不攤：攤出來全是空話。
    const thin = exists ? loreThin(entry) : 'empty';
    const body = thin
      ? []
      : LORE_BODY_KEYS.some((k) => hasContent(picked[k]))
        ? sectionsOf(picked, LORE_BODY_KEYS)
        : [{ key: '正文', text: visible }];
    const sections: WorkbenchSection[] = [
      ...(entry.brief.trim() ? [{ key: '一句话', text: entry.brief.trim() }] : []),
      ...body,
      ...(hidden ? [{ key: LORE_HIDDEN_KEY, text: hidden }] : []),
    ];
    return {
      stage: 'setting',
      title: describeTarget(target, { title: entry.title }),
      layer: '設定條目',
      relPath: exists ? entry.relPath : '',
      sections,
      empty: !exists
        ? '還沒有這條設定（檔案不在了，可能剛被改名或刪除）。'
        : sections.length === 0
          ? '這條設定還只有一句話。打 /展開 按已排的細綱把它往前想細。'
          : undefined,
    };
  }

  const no = parsePlotFileName(basename(target.plotRelPath))?.no ?? 0;
  const plot = await project.resolvePlot(target.plotRelPath);
  const chapter = no > 0 ? chapterOfPlotNo(await project.listChapters(), no) : undefined;
  const head = plotLabel(no, plot?.title || chapter?.title);

  if (target.kind === 'plot') {
    if (!plot) {
      return {
        stage: 'plot',
        title: `細綱 · ${head}`,
        layer: STAGE_LABEL.plot,
        relPath: chapter?.relPath ?? '',
        sections: [],
        empty: chapter ? '這一章已經有正文了，但還沒有細綱。' : '這一章還沒排細綱。',
      };
    }
    const sections = sectionsOf(plot.sections, PLOT_SECTION_KEYS);
    return {
      stage: 'plot',
      title: `細綱 · ${head}`,
      layer: STAGE_LABEL.plot,
      relPath: plot.relPath,
      sections,
      // 上游變更在這裡是一句人話，不只是流水線條上那個 ⟳。作者正在看這一章，
      // 此刻正是告訴他「它依據的大綱已經改了」最有用的時機。
      warning: isPlotUpstreamStale(plot)
        ? '梗概（情節大綱裡這一章那一條）在細綱排好之後改過，下面幾節可能已經對不上。'
        : undefined,
      // 「檔案在但一節都沒填」與「檔案不在」對作者是同一件事：這一層還沒做。
      empty: sections.length > 0 ? undefined : '這一章還沒排細綱。',
    };
  }

  // 正文層：攤細綱各節 + 篇幅。見檔案頭。
  const book = await project.readBookConfig();
  const words = chapter?.wordCount ?? 0;
  const goal = plot?.targetWords ?? book.wordsPerChapter;
  // 與 pipeline.ts 同一條判據：記錄過、且現在對不上，才算髒。沒記錄過
  // （正文是作者自己寫的）不標髒——憑空的過期標記比不標更糟。
  const stale = !!chapter && !!plot?.writtenFrom && plotContentHash(plot) !== plot.writtenFrom;
  // 寫前提醒（完善設定三期）：還沒寫的這一章細綱點名、卻還只有一句話的設定。零呼叫、不攔、不進主按鈕（第 20 條）；
  // 口徑就是「待完善」（沒定稿、也還沒寫正文的細綱），所以已經寫了字的章不提。「設定」一節空著就不讀設定區。
  const thin =
    plot && !plot.sourceHash && words === 0 && (plot.lore?.length ?? 0) > 0 ? await thinLoreFor(project, [plot.no]) : [];
  // 敘事線提醒（二期）：伏筆逾期、線斷了——同一個口徑，還沒寫的章才提（寫前檢查）。零呼叫、不攔。
  const threads = no > 0 && words === 0 ? await threadReminders(project, [no]) : undefined;
  const notice = [
    thin.length > 0 ? describeThinLore('本章', thin.map((t) => t.name)) : '',
    threads ? describeThreadReminders('本章', threads.reminders, unrecordedBefore(threads.through, no)) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    stage: 'manuscript',
    title: `正文 · ${head}`,
    layer: STAGE_LABEL.manuscript,
    relPath: chapter?.relPath ?? '',
    sections: [
      {
        key: '篇幅',
        text: words === 0 ? '還沒有正文' : goal ? `${words} / 約 ${goal} 字` : `${words} 字`,
      },
      ...(goal ? [] : [{ key: '目標篇幅', text: '細綱與配置裡都沒寫，所以有正文就算寫夠' }]),
      ...(plot ? sectionsOf(plot.sections, PLOT_SECTION_KEYS) : []),
    ],
    warning: stale ? '這一章的細綱在正文寫完（或同步）之後改過，現有正文可能已經與它對不上。' : undefined,
    ...(notice ? { notice } : {}),
    empty: plot ? undefined : '這一章沒有細綱，寫正文時模型只能照著前文往下編。',
  };
}

/** 非空小節 → 卡片條目。空小節與佔位文字都不顯示：卡片是給人看的，不是表單。 */
function sectionsOf(
  sections: Record<string, string>,
  keys: readonly string[]
): WorkbenchSection[] {
  const out: WorkbenchSection[] = [];
  for (const key of keys) {
    const text = (sections[key] ?? '').trim();
    if (text && text !== '（待補充）' && text !== '(待补充)') {
      out.push({ key, text });
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
