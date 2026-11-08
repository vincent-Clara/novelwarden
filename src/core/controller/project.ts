import type { ChatController } from './index';
import {
  dirBaseName,
  initProjectFlow,
  newChapterFlow,
  newPlotFlow,
} from '../actions';
import { newFolder, Section, sectionOf, sectionRoots } from '../files/fileOps';
import {
  createCardForCast,
  createCardsForAllCast,
  updateAllCharacterCards,
  updateCharacterCard,
} from '../features/characterCard';
import { cleanCharacterAliases, mergeDuplicateCharacterCards } from '../features/characterMaintenance';
import { extractCharacters, newCharacter, newLore } from '../features/characters';
import { buildLoreEntries, expandLoreEntries, integrateLore, organizeLore } from '../features/lore';
import { recordLore } from '../features/loreRecord';
import { completeSettings, generatePlots, writeManuscripts } from '../features/pipelineBatch';
import { extractStyle } from '../features/style';
import { importManuscript } from '../features/importManuscript';
import { exportBookText } from '../features/exportBook';
import { deriveFromText } from '../features/derive';
import { explainChapterGap } from '../features/chapterGap';
import { learnFromReference } from '../features/reference';
import { generateThreads, markThreadEnded } from '../features/threads';
import { backfillThreads } from '../features/threadsBackfill';
import { backfillTimeline, refreshTimeline } from '../features/timelineBackfill';
import { editTimelineEntry, setTimelineStart } from '../features/timelineEdit';
import { chapterForSummary, rebuildGlobalSummary, syncSummaries } from '../features/summarize';
import { askFinalizeChapterTask, finalizeChapterTask } from '../features/finalize';
import { reviewCharacterState } from '../features/characterState';
import { getHost } from '../host';
import { scoped } from '../runtime/logger';
import { CharacterAction, ProjectAction } from '../protocol';
import { normalizeRange } from '../model/session';
import { CallChoice, normalizeCallChoice } from '../model/callChoice';
import { isWriteBatchMode } from '../model/pipeline';
import { PARAGRAPH_STYLE_LABEL, isParagraphStyle } from '../model/paragraphFormat';
import { selectPlot } from './chat';
import { openChapter } from './files';

const log = scoped('面板');

/** 工程頁與角色卡動作。欄位只給 controller/ 同包用。 */

/**
 * 工程頁的按鈕直調 core 流程，webview 不直接碰檔案系統。
 * 外掛的命令面板也複用同一批 core 流程，行為不會分叉。
 *
 * `relPath` 是動作的作用物件（如要總結哪一章）；`dir` 是「在某個資料夾上點＋」
 * 時的落點目錄，從工具欄點則不帶，落在區根目錄。
 */
export async function projectAction(
  c: ChatController,
  action: ProjectAction,
  relPath?: string,
  dir?: string,
  batch: {
    range?: { from: number; to: number };
    call?: CallChoice;
    mode?: 'draft' | 'finalize';
    review?: boolean;
    name?: string;
    expandLore?: boolean;
    open?: boolean;
    hostPath?: string;
  } = {}
): Promise<void> {
  // refresh 每次切頁/刷盤都來一趟，記了只會淹掉別的；其餘動作都值得留痕。
  if (action !== 'refresh') {
    log.info(
      `工程頁動作：${action}`,
      [relPath ? `物件 ${relPath}` : '', dir ? `落點 ${dir}` : ''].filter(Boolean).join('｜') || undefined
    );
  }
  switch (action) {
    case 'initProject':
      await initProjectFlow(c.project, dirBaseName(c.project));
      break;
    case 'refresh':
      break; // pushState 本身就是重新整理
    case 'newPlot': {
      const rel = await newPlotFlow(c.project);
      if (rel) {
        // 建完**進入這一章**，落在哪一層由狀態機決定（空細綱 → 待寫細綱 →
        // 主按鈕「寫第 N 章細綱」）。走 selectPlot 而不是自己拼 target：
        // 只有後端知道那一章處於什麼狀態，這與點章名同一條路。
        await selectPlot(c, rel);
      }
      break;
    }
    case 'newChapter': {
      // 手工新建一個章節檔案。**不進創作頁**——建它多半是作者要往裡粘一段
      // 現成的正文。工程頁「章節」還空著時那顆「新建第 1 章」帶 `open`：建完就開啟，接著就能寫。
      const rel = await newChapterFlow(c.project, dir);
      if (rel && batch.open) {
        await openChapter(c, rel);
      }
      break;
    }
    case 'newCharacter':
      await newCharacter(c.project, dir);
      break;
    case 'newLore':
      await newLore(c.project, dir, batch.name);
      break;
    case 'newFolder': {
      // 落點目錄決定建到哪個區；沒給就問使用者。
      const section = dir ? sectionOf(c.project, dir)?.section : await pickSection(c);
      if (!section) {
        break;
      }
      await newFolder(c.project, section, dir);
      break;
    }
    case 'finalizeChapter':
    case 'askFinalizeChapter': {
      if (!relPath) {
        break;
      }
      // 傳進來的可能是細綱路徑（從流水線那一側點的），也可能是章節路徑
      // （從工程頁那一行點的）。定稿讀的是正文，所以統一解析成章節。
      // 定稿 = 照正文更新細綱（帶連續性事實）+ 出場角色的當前狀態 + 敘事線（features/finalize.ts）。
      const chapter = await chapterForSummary(c.project, relPath);
      if (!chapter) {
        log.warn(`找不到 ${relPath} 對應的章節，可能還沒寫正文或剛被改名`);
        getHost().toast('這一章還沒有正文，無法同步。', 'error');
        break;
      }
      // 工程頁章節右鍵先問這一次用哪個模型；其餘入口用對話頁選定的那個。
      if (action === 'askFinalizeChapter') {
        await askFinalizeChapterTask(c.project, chapter);
      } else {
        await finalizeChapterTask(c.project, chapter);
      }
      break;
    }
    case 'syncSummaries':
      await syncSummaries(c.project);
      break;
    case 'rebuildGlobalSummary':
      await rebuildGlobalSummary(c.project);
      break;
    case 'generatePlots':
      // 區間與「彈窗已經問過」（`call`：作者在彈窗上挑的模型與詳細度）來自工程頁的拆細綱彈窗（W5）；
      // 不帶就是下一批 5 章，先問。`expandLore`：彈窗上「拆完展開本批新設定」（完善設定三期），拆完後端再問一次次數。
      await generatePlots(c.project, {
        range: normalizeRange(batch.range),
        call: normalizeCallChoice(batch.call),
        expandLore: batch.expandLore === true,
      });
      break;
    case 'completeSettings':
      await completeSettings(c.project);
      break;
    case 'writeManuscripts':
      // 區間、模式與「彈窗已經問過」（`call`）來自批次寫章彈窗（W9）；不帶就是下一可寫章起 3 章、只寫正文，先問。
      await writeManuscripts(c.project, {
        range: normalizeRange(batch.range),
        mode: isWriteBatchMode(batch.mode) ? batch.mode : 'draft',
        review: batch.review === true,
        call: normalizeCallChoice(batch.call),
      });
      break;
    case 'extractCharacters':
      await extractCharacters(c.project);
      break;
    case 'recordLore':
      await recordLore(c.project, relPath);
      break;
    case 'buildLore':
      await buildLoreEntries(c.project, batch.name ? [batch.name] : undefined);
      break;
    case 'integrateLore':
      await integrateLore(c.project, relPath ? [relPath] : undefined);
      break;
    case 'expandLoreAll':
      await expandLoreEntries(c.project);
      break;
    case 'organizeLore':
      await organizeLore(c.project);
      break;
    case 'extractStyle':
      await extractStyle(c.project);
      break;
    case 'generateThreads':
      await generateThreads(c.project);
      break;
    case 'backfillThreads':
      await backfillThreads(c.project);
      break;
    case 'backfillTimeline':
      await backfillTimeline(c.project);
      break;
    case 'refreshTimeline':
      // 區間來自時間線組：右鍵一章「重推這一章」「從這一章起重推」；標題旁「重推」不帶（全部）。
      await refreshTimeline(c.project, normalizeRange(batch.range) ?? {});
      break;
    case 'editTimeline': {
      // 時間線組右鍵一章「改時間…」：章號放在 name 裡（還沒有正文的章也能改）。
      const no = Number(batch.name);
      if (Number.isInteger(no) && no > 0) {
        await editTimelineEntry(c.project, no);
      }
      break;
    }
    case 'setTimelineStart':
      // 時間線組第一行：點了改曆法與起點；右鍵「填為起點」帶倒推出來的那一天（name），直接填。
      await setTimelineStart(c.project, batch.name);
      break;
    case 'closeThread':
    case 'abandonThread':
      if (relPath) {
        await markThreadEnded(c.project, relPath, action === 'closeThread' ? '收束' : '放弃');
      }
      break;
    case 'importManuscript':
      // 歡迎頁「匯入寫好的書」建好工程之後帶著那本 txt 的絕對路徑來（表單上看過切分結果，不再問）；工程頁右鍵不帶。
      await importManuscript(c.project, batch.hostPath ? { hostPath: batch.hostPath } : {});
      break;
    case 'exportBook':
      await exportBookText(c.project);
      break;
    case 'deriveFromText':
      await deriveFromText(c.project);
      break;
    case 'chapterGap':
      await explainChapterGap(c.project);
      break;
    case 'learnFromReference':
      await learnFromReference(c.project);
      break;
  }

  // 這些流程大多會改動磁碟，且不一定觸發 watcher（比如剛初始化的空工程）。
  // pushState 會順帶重新整理當前頁籤。
  await c.pushState();
}

/**
 * 內建編輯器「編輯 → 段落格式」：切換正文的分段格式。只改 `config.md` frontmatter 的
 * `paragraphStyle` 這一個鍵，正文一個位元組不動（`Workspace.setParagraphStyle`）。
 * 還不是小說工程時不寫——寫一份 `config.md` 也不會讓它變成工程，只會多出一個沒人認的檔案。
 */
export async function setParagraphStyle(c: ChatController, style: unknown): Promise<void> {
  if (!isParagraphStyle(style)) {
    log.warn(`認不出的分段格式：${String(style)}，忽略`);
    return;
  }
  if (!(await c.project.isInitialized())) {
    getHost().toast('還不是小說工程，先初始化工程再設段落格式。', 'error');
    return;
  }
  const rel = await c.workspace.setParagraphStyle(style);
  if (rel) {
    log.info(`段落格式改為「${PARAGRAPH_STYLE_LABEL[style]}」`, rel);
  }
  // 前端的勾與編輯器的回車都跟著 state / project 走。
  await c.pushState();
}

/** 工具欄上的「＋ 資料夾」沒有落點，先問建到哪個區。 */
export async function pickSection(c: ChatController): Promise<Section | undefined> {
  return getHost().pick<Section>(
    sectionRoots(c.project).map((s) => ({ label: s.label, detail: `${s.root}/`, value: s.section })),
    '在哪個區新建資料夾？'
  );
}

/**
 * 角色卡動作。作用物件是**一個角色**（用名字標識），不是檔案或章節，
 * 因此與 fileAction / projectAction 分開走。
 */
export async function characterAction(
  c: ChatController,
  action: CharacterAction,
  name: string,
  relPath?: string
): Promise<void> {
  log.info(`角色動作：${action} ${name}`, relPath);
  switch (action) {
    case 'updateCard':
    case 'rebuildCard':
      if (!relPath) {
        log.warn(`${action} 缺少角色卡路徑，忽略`);
        break;
      }
      await updateCharacterCard(
        c.project,
        relPath,
        action === 'updateCard' ? 'incremental' : 'full'
      );
      break;
    case 'createCard':
      await createCardForCast(c.project, name);
      break;
    case 'createAllCards':
      await createCardsForAllCast(c.project);
      break;
    case 'updateAllCards':
      await updateAllCharacterCards(c.project, 'incremental');
      break;
    case 'rebuildAllCards':
      await updateAllCharacterCards(c.project, 'full');
      break;
    case 'cleanAliases':
      await cleanCharacterAliases(c.project);
      break;
    case 'mergeDuplicates':
      await mergeDuplicateCharacterCards(c.project);
      break;
    case 'reviewState':
      // 定稿時沒覆蓋的那一版（作者改過這張卡的當前狀態，D15）：對比後決定用不用。
      if (relPath) {
        await reviewCharacterState(c.project, relPath);
      }
      break;
  }
  await c.pushState();
}
