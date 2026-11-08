/**
 * 審稿報告卡（五期 W10）：審稿那一輪畫這一張，不畫那段可就地編輯的正文。
 *
 * ```
 * ┌ 審稿 · 第 2 章《客棧》 ─────────── 1 嚴重 · 1 建議 · 目標 1/3 已完成 ┐
 * │ 整體順暢，一處硬傷                                                  │
 * │ 本章目標（覆蓋完整不代表全部完成）                                   │
 * │  ☐ 未完成｜關鍵事件：林昭當晚離開青崖鎮   判斷……   「天一亮就走」     │
 * │ 嚴重（1）                                                           │
 * │  ☑ [劇情合理性] 殘令前文已經交出去了        「她把那塊殘令收進了袖中」 │
 * │ ▸ 通過（1）  ▸ 丟掉的意見（1，引文站不住）  ▸ 說明（2）               │
 * │                                         [按勾選的 2 條修稿]         │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * - **點引文就在編輯器裡定位到那一句**（發 `revealQuote`）：作者要判斷的是「這一句是不是真有問題」，
 *   那一句前後是怎麼寫的就在正文裡。
 * - **預設勾選**來自後端（`review.picks`，model/review.ts 的 `defaultPicks`）：嚴重與建議全勾，
 *   未完成的目標也勾，待核實不勾——證據不足不代表有問題。通過與已完成沒有可勾的東西。
 * - 勾選狀態是**介面狀態**，留在前端（按 turnId 記著）：氣泡隨 `turnDone` 整體重建時不丟。
 * - 底部按鈕寫勾了幾條、會調幾次模型（第 4 條）；一條都沒勾、正在生成時禁用。
 *
 * ## 編輯模式（五期補遺 §3）
 *
 * 底部「編輯問題」把問題那幾組換成一張可改的表：分類、嚴重度、說明、引文；「新增問題」加一條作者
 * 自己寫的（引文可以空著）。作者加的可以刪，**模型給的不能刪**——不想修就別勾。目標核對來自細綱，
 * 不在表裡。「儲存」把整張表發給後端（`editReview`），後端校驗引文、接著編號，推回新的報告；編輯
 * 期間不能修稿。正在編輯的表按 turnId 記在前端，氣泡重建時照著它畫，不丟作者剛敲的字。
 */
import { el as mk, spacer } from '../dom';
import type { ReviewGoal, ReviewIssue, ReviewIssueEdit, SerializedTurn } from '../protocol';
import {
  AUTHOR_CATEGORY,
  GOAL_STATUS_LABEL,
  REVISE_CALLS,
  SEVERITY_LABEL,
  describeCalls,
  describeReport,
  pickableIds,
} from '../protocol';
import { store, vscode } from './store';

type ReviewView = NonNullable<SerializedTurn['review']>;

/** 每一輪的勾選狀態。沒記過的用後端給的預設。 */
const picked = new Map<string, Set<string>>();
/** 每一輪上一次見過哪些可勾的條目：編輯之後冒出來的新條目按後端的預設勾上。 */
const known = new Map<string, Set<string>>();
/** 正在編輯的那幾張：turnId → 編輯中的問題表。 */
const editing = new Map<string, EditRow[]>();

interface EditRow extends ReviewIssueEdit {
  origin?: 'author';
}

function picksOf(turnId: string, review: ReviewView): Set<string> {
  const allowed = new Set(pickableIds(review.report));
  let set = picked.get(turnId);
  if (!set) {
    set = new Set(review.picks.filter((id) => allowed.has(id)));
    picked.set(turnId, set);
  } else {
    const seen = known.get(turnId) ?? new Set<string>();
    for (const id of review.picks) {
      if (allowed.has(id) && !seen.has(id)) {
        set.add(id);
      }
    }
    for (const id of [...set]) {
      if (!allowed.has(id)) {
        set.delete(id);
      }
    }
  }
  known.set(turnId, allowed);
  return set;
}

export function buildReviewCard(turn: SerializedTurn): HTMLElement {
  const review = turn.review!;
  const report = review.report;
  const picks = picksOf(turn.id, review);
  const rows = editing.get(turn.id);
  const card = mk('div', `review-card${rows ? ' editing' : ''}`);
  card.dataset.review = turn.id;
  const redraw = () => card.replaceWith(buildReviewCard(turn));

  const head = mk('div', 'review-head');
  const where = `第 ${report.chapterNo} 章${report.chapterTitle ? `《${report.chapterTitle}》` : ''}`;
  head.appendChild(mk('span', 'review-title', `審稿 · ${where}`));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'review-counts', describeReport(report)));
  card.appendChild(head);

  if (report.summary) {
    card.appendChild(mk('div', 'review-summary', report.summary));
  }

  const submit = mk('button', 'primary review-submit');
  const refresh = () => {
    const n = picks.size;
    submit.textContent = n > 0 ? `按勾選的 ${n} 條修稿` : '勾選要修的條目';
    submit.disabled = n === 0 || store.busy || !!rows;
    submit.title = `${describeCalls(REVISE_CALLS)}。只把勾選的條目連同整章原文交給模型，要求最小改動；寫入前會讓你先對比。`;
  };
  const toggle = (id: string, on: boolean) => {
    if (on) {
      picks.add(id);
    } else {
      picks.delete(id);
    }
    refresh();
  };
  const quote = (text: string) => {
    const q = mk('button', 'review-quote', `「${text}」`);
    q.title = '在編輯器裡定位到這一句';
    q.addEventListener('click', () => vscode.postMessage({ type: 'revealQuote', relPath: report.chapterRelPath, quote: text }));
    return q;
  };

  // 目標核對排最前：它回答的是「細綱定下的事寫到了沒有」，比挑錯更先要知道。
  if (report.goals.length > 0 || report.coverage === 'none') {
    const section = mk('div', 'review-section review-goals');
    section.appendChild(mk('div', 'review-section-title', `本章目標${coverageNote(report.coverage)}`));
    for (const goal of report.goals) {
      section.appendChild(goalRow(goal, picks.has(goal.id), toggle, quote));
    }
    card.appendChild(section);
  }

  if (rows) {
    card.appendChild(editor(rows, redraw));
  } else {
    for (const sev of ['error', 'warning'] as const) {
      const list = report.issues.filter((i) => i.severity === sev);
      if (list.length === 0) {
        continue;
      }
      const section = mk('div', `review-section review-${sev}`);
      section.appendChild(mk('div', 'review-section-title', `${SEVERITY_LABEL[sev]}（${list.length}）`));
      for (const issue of list) {
        section.appendChild(issueRow(issue, picks.has(issue.id), toggle, quote));
      }
      card.appendChild(section);
    }
    if (report.issues.length === 0) {
      card.appendChild(mk('div', 'review-empty', '沒有找到有正文證據的問題。'));
    }
  }

  if (report.passes.length > 0) {
    card.appendChild(
      folded(`通過（${report.passes.length}）`, report.passes.map((p) => `[${p.category}] ${p.description}`))
    );
  }
  if (report.dropped.length > 0) {
    card.appendChild(
      folded(
        `丟掉的意見（${report.dropped.length}，引文站不住）`,
        report.dropped.map((d) => `[${d.category}] ${d.description}（${d.why}${d.quote ? `：「${d.quote}」` : ''}）`)
      )
    );
  }
  if (review.notes?.length) {
    card.appendChild(folded(`說明（${review.notes.length}）`, review.notes));
  }

  const foot = mk('div', 'review-foot');
  if (rows) {
    // 編輯模式：新增 / 取消 / 儲存。修稿那一顆收起來——表還沒存，按它修的是哪一版說不清。
    foot.appendChild(
      footBtn('新增問題', 'secondary review-edit-add', () => {
        rows.push({ category: AUTHOR_CATEGORY, severity: 'warning', description: '', quote: '', origin: 'author' });
        redraw();
      })
    );
    foot.appendChild(spacer());
    foot.appendChild(
      footBtn('取消', 'secondary review-edit-cancel', () => {
        editing.delete(turn.id);
        redraw();
      })
    );
    foot.appendChild(
      footBtn('儲存', 'primary review-edit-save', () => {
        const issues: ReviewIssueEdit[] = rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          category: r.category,
          severity: r.severity,
          description: r.description,
          quote: r.quote ?? '',
        }));
        editing.delete(turn.id);
        vscode.postMessage({ type: 'editReview', turnId: turn.id, issues });
        redraw();
      })
    );
    card.appendChild(foot);
    return card;
  }
  foot.appendChild(
    footBtn('編輯問題', 'secondary review-edit', () => {
      editing.set(
        turn.id,
        report.issues.map((i) => ({
          id: i.id,
          category: i.category,
          severity: i.severity,
          description: i.description,
          quote: i.quote,
          ...(i.origin ? { origin: i.origin } : {}),
        }))
      );
      redraw();
    })
  );
  foot.appendChild(mk('span', 'review-hint', `${describeCalls(REVISE_CALLS)}，寫入前會讓你先對比`));
  foot.appendChild(spacer());
  submit.addEventListener('click', () => {
    if (picks.size === 0 || store.busy) {
      return;
    }
    vscode.postMessage({ type: 'reviseChapter', turnId: turn.id, picks: [...picks] });
  });
  foot.appendChild(submit);
  card.appendChild(foot);
  refresh();
  return card;
}

function coverageNote(coverage: ReviewView['report']['coverage']): string {
  if (coverage === 'none') {
    return '（本章細綱沒有可核對的關鍵事件）';
  }
  return coverage === 'partial' ? '（核對不完整：有幾項按待核實處理）' : '（逐項核對過；完整不代表全部完成）';
}

type Toggle = (id: string, on: boolean) => void;
type QuoteBtn = (text: string) => HTMLElement;

function checkbox(id: string, checked: boolean, toggle: Toggle): HTMLInputElement {
  const box = mk('input', 'review-pick');
  box.type = 'checkbox';
  box.checked = checked;
  box.dataset.pick = id;
  box.addEventListener('change', () => toggle(id, box.checked));
  return box;
}

function issueRow(issue: ReviewIssue, checked: boolean, toggle: Toggle, quote: QuoteBtn): HTMLElement {
  const row = mk('div', 'review-item');
  row.dataset.item = issue.id;
  row.appendChild(checkbox(issue.id, checked, toggle));
  const body = mk('div', 'review-item-body');
  const line = mk('div', 'review-item-line');
  line.appendChild(mk('span', 'review-category', `[${issue.category}]`));
  line.appendChild(mk('span', 'review-desc', issue.description));
  if (issue.origin === 'author') {
    line.appendChild(mk('span', 'review-tag', '作者補充'));
  } else if (issue.edited) {
    line.appendChild(mk('span', 'review-tag', '已改'));
  }
  body.appendChild(line);
  // 作者加的可以沒有引文：沒有就不畫那一行（點下去也定位不到什麼）。
  if (issue.quote) {
    body.appendChild(quote(issue.quote));
  }
  row.appendChild(body);
  return row;
}

/**
 * 編輯模式下的問題表：一條一行，分類、嚴重度、說明、引文都能改；作者加的那幾條多一顆「刪除」。
 * 改動直接寫進 `rows`（那就是 `editing` 裡記著的那一份），重建時不丟。
 */
function editor(rows: EditRow[], redraw: () => void): HTMLElement {
  const box = mk('div', 'review-section review-editor');
  box.appendChild(
    mk('div', 'review-section-title', '編輯問題（模型給的不能刪，不想修就別勾；引文要逐字抄正文裡的一句，可以空著）')
  );
  rows.forEach((r, i) => {
    const row = mk('div', `review-edit-row${r.origin === 'author' ? ' author' : ''}`);
    row.dataset.edit = String(i);
    const top = mk('div', 'review-edit-top');
    const severity = mk('select', 'review-edit-severity');
    for (const sev of ['error', 'warning'] as const) {
      const opt = mk('option', undefined, SEVERITY_LABEL[sev]);
      opt.value = sev;
      opt.selected = r.severity === sev;
      severity.appendChild(opt);
    }
    severity.addEventListener('change', () => {
      r.severity = severity.value === 'error' ? 'error' : 'warning';
    });
    const category = mk('input', 'review-edit-category');
    category.type = 'text';
    category.value = r.category;
    category.placeholder = '分類';
    category.addEventListener('input', () => {
      r.category = category.value;
    });
    top.appendChild(severity);
    top.appendChild(category);
    if (r.origin === 'author') {
      top.appendChild(mk('span', 'review-tag', '作者補充'));
      top.appendChild(spacer());
      top.appendChild(
        footBtn('刪除', 'secondary review-edit-remove', () => {
          rows.splice(i, 1);
          redraw();
        })
      );
    }
    row.appendChild(top);
    const desc = mk('textarea', 'review-edit-desc');
    desc.rows = 2;
    desc.value = r.description;
    desc.placeholder = '具體是什麼問題、要怎麼改';
    desc.addEventListener('input', () => {
      r.description = desc.value;
    });
    row.appendChild(desc);
    const q = mk('input', 'review-edit-quote');
    q.type = 'text';
    q.value = r.quote ?? '';
    q.placeholder = '相關原文（可選）';
    q.addEventListener('input', () => {
      r.quote = q.value;
    });
    row.appendChild(q);
    box.appendChild(row);
  });
  if (rows.length === 0) {
    box.appendChild(mk('div', 'review-empty', '還沒有問題。點「新增問題」加一條。'));
  }
  return box;
}

function footBtn(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', className, text);
  b.addEventListener('click', onClick);
  return b;
}

function goalRow(goal: ReviewGoal, checked: boolean, toggle: Toggle, quote: QuoteBtn): HTMLElement {
  const row = mk('div', `review-item review-goal status-${goal.status}`);
  row.dataset.item = goal.id;
  if (goal.status === 'completed') {
    row.appendChild(mk('span', 'review-pick-placeholder', '✓'));
  } else {
    row.appendChild(checkbox(goal.id, checked, toggle));
  }
  const body = mk('div', 'review-item-body');
  const line = mk('div', 'review-item-line');
  line.appendChild(mk('span', `review-status status-${goal.status}`, GOAL_STATUS_LABEL[goal.status]));
  line.appendChild(mk('span', 'review-desc', `關鍵事件：${goal.text}`));
  body.appendChild(line);
  if (goal.judgment) {
    body.appendChild(mk('div', 'review-judgment', goal.judgment));
  }
  for (const q of goal.quotes) {
    body.appendChild(quote(q));
  }
  row.appendChild(body);
  return row;
}

function folded(title: string, lines: string[]): HTMLElement {
  const det = mk('details', 'review-folded');
  det.appendChild(mk('summary', undefined, title));
  const list = mk('ul');
  for (const text of lines) {
    list.appendChild(mk('li', undefined, text));
  }
  det.appendChild(list);
  return det;
}

/** 正在生成時底部按鈕要禁用：busy 變了就把畫著的幾張卡的按鈕刷一遍。 */
export function syncReviewCards(): void {
  document.querySelectorAll<HTMLElement>('.review-card').forEach((card) => {
    const btn = card.querySelector<HTMLButtonElement>('.review-submit');
    const turnId = card.dataset.review;
    if (btn && turnId) {
      btn.disabled = store.busy || editing.has(turnId) || (picked.get(turnId)?.size ?? 0) === 0;
    }
  });
}
