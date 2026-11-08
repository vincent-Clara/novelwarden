/**
 * 作者在工程頁改故事時間（2026-10-24 重做，設計見 docs/design/plans/2026-10-24-story-timeline-rework.md「五」；推翻了上一稿「只改檔案」）：
 * 「時間線」組裡右鍵一章「改時間…」、點第一行改曆法與起點、右鍵「填為起點」。**不調模型**。
 *
 * - 都只改那一行、那兩個鍵（`model/timelineFile.ts` 的 `setTimelineValue` / `setTimelineHead`），經閘道器寫（`updateThread`：寫之前那一刻
 *   重讀、覆蓋前存歷史版本）。檔案照樣能手改。
 * - 改時間寫下的是作者定的：去掉行尾的〔依據〕〔推測〕〔推不出〕，機器再也不動這一行（第 28 條）；清空 = 刪掉這一行，留給機器重推。
 * - 輸入框就是那一問（第 3 條）：作者自己寫的值，不另彈對比。
 */
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import {
  TIMELINE_CALENDARS,
  TimelineCalendar,
  checkTimeInput,
  computeTimeline,
  emptyTimeline,
  parseDate,
  renderTimeValue,
  setTimelineHead,
  setTimelineValue,
  suggestStart,
} from '../model/timelineFile';
import { describeError, scoped } from '../runtime/logger';
import { Workspace } from '../workspace';

const log = scoped('故事時間');

/** 右鍵一章「改時間…」：問一句，照作者寫的改那一行。`no` 是章號。 */
export async function editTimelineEntry(project: NovelProject, no: number): Promise<void> {
  const host = getHost();
  const rel = project.relPath(project.timelinePath);
  const tl = (await project.readThreads()).timeline ?? emptyTimeline(rel);
  const e = tl.entries.find((x) => x.chapter === no);
  const current = e ? `${renderTimeValue(e.value)}${e.part ? `，${e.part}` : ''}` : '';
  const answer = await host.input({
    title: `第 ${no} 章的時間`,
    prompt:
      '這一章開頭是哪天、比上一章晚多久：「八月十五」「第 20 天」「+3 天」「同日」「次日」「回憶」，可以帶時段（「八月十五，傍晚」）。' +
      '改過的就是你定的，機器不再動，後面的章跟著順延；清空就是刪掉這一行，留給機器重推。',
    value: current,
    placeHolder: '八月十五，傍晚',
    validate: (v) => checkTimeInput(v, tl),
  });
  if (answer === undefined || answer.trim() === current) {
    return;
  }
  const done: { action: 'added' | 'replaced' | 'removed' | 'kept' } = { action: 'kept' };
  try {
    await new Workspace(project).updateThread(rel, (raw) => {
      const r = setTimelineValue(raw, no, answer);
      done.action = r?.action ?? 'kept';
      return r && r.action !== 'kept' ? r.text : undefined;
    });
  } catch (err) {
    log.warn(`第 ${no} 章的時間沒改成：${describeError(err)}`, err);
    host.toast(`第 ${no} 章的時間沒改成：${describeError(err)}`, 'error');
    return;
  }
  if (done.action === 'removed') {
    log.info(`第 ${no} 章的時間刪掉了`, '留給機器重推');
    host.toast(`第 ${no} 章那一行刪掉了：按緊接上一章算，同步或重推時機器再推。`);
  } else if (done.action !== 'kept') {
    log.info(`第 ${no} 章的時間改成「${answer.trim()}」`);
    host.toast(`第 ${no} 章的時間改成「${answer.trim()}」：這一行是你定的，機器不再動，後面的章跟著順延。`);
  }
}

/**
 * 時間線組第一行：改曆法與起點（先挑曆法、再問起點）；右鍵「填為起點」帶 `suggested`，直接填、不問。
 */
export async function setTimelineStart(project: NovelProject, suggested?: string): Promise<void> {
  const host = getHost();
  const rel = project.relPath(project.timelinePath);
  const tl = (await project.readThreads()).timeline ?? emptyTimeline(rel);
  let calendar: TimelineCalendar | undefined;
  let start: string | undefined = suggested?.trim();
  if (start === undefined) {
    calendar = await host.pick<TimelineCalendar>(
      TIMELINE_CALENDARS.map((c) => ({
        label: c,
        description: c === tl.calendar ? '現在用的' : '',
        detail: c === '简单历' ? '每月 30 天、一年 12 個月；節日按農曆口徑（中秋是八月十五）' : '真實的月份長短與閏年；只認元旦、國慶這類公曆節日',
        value: c,
      })),
      '故事用哪一種曆法？'
    );
    if (!calendar) {
      return;
    }
    const hint = suggestStart(tl, computeTimeline(tl));
    start = await host.input({
      title: '第 1 章開頭是哪一天',
      prompt: `寫第 1 章那一天：「大衍三年三月初七」「三月初七」「2026-03-07」；不填只顯示第幾天。${hint ? `（第 ${hint.chapter} 章寫了「${hint.mark}」，倒推第 1 章是${hint.text}）` : ''}`,
      value: tl.startText || hint?.text || '',
      placeHolder: '三月初七',
      validate: (v) => (!v.trim() || parseDate(v) ? undefined : `認不出「${v.trim()}」：寫「三月初七」「大衍三年三月初七」「2026-03-07」這樣的`),
    });
    if (start === undefined) {
      return;
    }
  }
  try {
    await new Workspace(project).updateThread(rel, (raw) => setTimelineHead(raw, { ...(calendar ? { calendar } : {}), start }));
  } catch (err) {
    log.warn(`時間線的起點沒改成：${describeError(err)}`, err);
    host.toast(`起點沒改成：${describeError(err)}`, 'error');
    return;
  }
  log.info('時間線的歷法與起點改了', `${calendar ?? tl.calendar}｜${start || '（沒填）'}`);
  host.toast(start ? `起點改成「${start}」${calendar ? `（${calendar}）` : ''}：日期在時間線組與總覽裡看。` : `起點清空了${calendar ? `（${calendar}）` : ''}：只顯示第幾天。`);
}
