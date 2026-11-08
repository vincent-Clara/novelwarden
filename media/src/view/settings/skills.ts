/**
 * 設定頁「技能」那一頁：本工程的階段繫結、從 GitHub 檢查與安裝、技能庫。
 *
 * 與其餘兩頁不同，這一頁**改了當場生效**，不進 `draft`、不等「儲存設定」：繫結寫的是工程裡的
 * `.novelwarden/skills.json`，裝卸寫的是我的技能庫，都與 `config.json` 無關。每一次改動後端都會
 * 重推一份 `skills`，這裡只負責照著畫。
 *
 * 檢查結果是這一頁唯一的前端狀態：它是「作者正在看的那一份」，後端不記得給誰看過。
 */
import { clear, el, maybeById } from '../../dom';
import { SKILL_SOURCE_LABEL, SKILL_STAGES, SKILL_STAGE_LABEL } from '../../protocol';
import type { SkillInspectionView, SkillRow, SkillsView, SkillStage } from '../../protocol';
import { vscode } from '../store';

export function renderSkills(next: SkillsView, installed?: string): void {
  if (installed) {
    // 剛裝好：檢查卡完成了它的事，收起來，地址框清空，免得作者以為還要再點一次。
    const url = maybeById<HTMLInputElement>('skillUrl');
    if (url) {
      url.value = '';
    }
    const box = maybeById('skillInspection');
    if (box) {
      clear(box);
    }
  }
  renderBindings(next);
  renderLibrary(next);
}

/** 檢查的結果（或錯誤）。 */
export function renderSkillInspection(url: string, inspection?: SkillInspectionView, error?: string): void {
  setInspecting(false);
  const box = maybeById('skillInspection');
  if (!box) {
    return;
  }
  clear(box);
  if (!inspection) {
    box.appendChild(el('div', 'skill-error', `檢查失敗：${error ?? '原因不明'}`));
    return;
  }
  const card = el('div', 'skill-card skill-inspection');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', inspection.label));
  head.appendChild(
    el('span', `skill-tag ${inspection.blockers.length > 0 ? 'bad' : 'ok'}`, inspection.blockers.length > 0 ? '裝不了' : '可以裝')
  );
  card.appendChild(head);
  card.appendChild(el('div', 'skill-desc', inspection.description));
  card.appendChild(
    el(
      'div',
      'skill-meta',
      [
        `name=${inspection.name}`,
        inspection.version ? `版本 ${inspection.version}` : '',
        `建議階段：${SKILL_STAGE_LABEL[inspection.suggestedStage]}`,
        `${inspection.bytes} 位元組`,
        inspection.attachments.length > 0 ? `附帶 ${inspection.attachments.length} 份檔案` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );
  for (const blocker of inspection.blockers) {
    card.appendChild(el('div', 'skill-error', blocker));
  }
  // 正文給作者看：裝進來的就是這些字，往後每一次生成都會帶上它。
  const body = el('details', 'skill-body');
  body.appendChild(el('summary', undefined, '正文（裝進來的就是這些字）'));
  body.appendChild(el('pre', undefined, inspection.body));
  card.appendChild(body);
  // 附帶檔案同樣整份帶進每一次生成，一份一個摺疊塊。
  for (const file of inspection.attachments) {
    const more = el('details', 'skill-body');
    more.appendChild(el('summary', undefined, `附帶檔案：${file.path}`));
    more.appendChild(el('pre', undefined, file.text));
    card.appendChild(more);
  }
  card.appendChild(el('div', 'hint', `下載地址：${inspection.resolvedUrl}。這些內容來自第三方，裝之前看一眼。`));

  const actions = el('div', 'actions');
  const install = el('button', 'primary', '確認安裝');
  install.id = 'installSkillBtn';
  install.disabled = inspection.blockers.length > 0;
  install.addEventListener('click', () => vscode.postMessage({ type: 'installSkill', url }));
  actions.appendChild(install);
  card.appendChild(actions);
  box.appendChild(card);
}

export function installSkillsPanel(): void {
  const button = maybeById<HTMLButtonElement>('inspectSkillBtn');
  const input = maybeById<HTMLInputElement>('skillUrl');
  if (!button || !input) {
    return;
  }
  const inspect = (): void => {
    const url = input.value.trim();
    if (!url) {
      input.focus();
      return;
    }
    setInspecting(true);
    const box = maybeById('skillInspection');
    if (box) {
      clear(box);
    }
    vscode.postMessage({ type: 'inspectSkill', url });
  };
  button.addEventListener('click', inspect);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      inspect();
    }
  });
}

/** 切到這一頁時重掃一遍：作者可能剛手放了一份進來。 */
export function requestSkills(): void {
  vscode.postMessage({ type: 'requestSkills' });
}

function setInspecting(busy: boolean): void {
  const button = maybeById<HTMLButtonElement>('inspectSkillBtn');
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? '檢查中…' : '檢查';
  }
}

// ---------------------------------------------------------------- 階段繫結

function renderBindings(v: SkillsView): void {
  const box = maybeById('skillBindings');
  const hint = maybeById('skillBindingHint');
  if (!box) {
    return;
  }
  clear(box);
  const bindings = v.bindings;
  if (hint) {
    hint.textContent = !bindings
      ? '先開啟一個工程：繫結跟著工程走（記在工程裡的 skills.json）。'
      : v.problems.length > 0
        ? `工程的 skills.json 有讀不懂的地方：${v.problems.join('；')}。先手動修好或刪掉它，才能在這裡改繫結。`
        : '每個階段最多綁一份；同一份可以綁在幾個階段上。只列出相容的技能；內建技能只在它所屬的階段列出。';
  }
  const usable = v.rows.filter((r) => r.compatible);
  for (const stage of SKILL_STAGES) {
    box.appendChild(bindingField(stage, usable, v.rows, bindings));
  }
}

function bindingField(
  stage: SkillStage,
  usable: SkillRow[],
  all: SkillRow[],
  bindings: SkillsView['bindings']
): HTMLElement {
  const field = el('label', 'field');
  field.appendChild(el('span', undefined, SKILL_STAGE_LABEL[stage]));
  const select = document.createElement('select');
  select.dataset.skillStage = stage;
  const none = el('option', undefined, '不帶');
  none.value = '';
  select.appendChild(none);
  const current = bindings?.[stage] ?? '';
  // 內建的階段是它 frontmatter 裡寫明的（隨應用釋出、作者改不了），別的階段不列；已經綁上的照列。
  // 我的技能庫與本工程的「建議階段」可能是猜的，全列，只是本階段建議的排前面。
  const listed = usable.filter((r) => r.source !== 'builtin' || r.suggestedStage === stage || r.id === current);
  const suggested = listed.filter((r) => r.suggestedStage === stage);
  const others = listed.filter((r) => r.suggestedStage !== stage);
  if (others.length === 0 || suggested.length === 0) {
    appendOptions(select, listed);
  } else {
    appendOptions(select.appendChild(optgroup('本階段建議')), suggested);
    appendOptions(select.appendChild(optgroup('其他技能')), others);
  }
  if (current && !usable.some((r) => r.id === current)) {
    // 綁著的那份找不到了或者變得不相容：照實顯示，別讓下拉框裝作「不帶」——生成時明細裡也是這麼說的。
    const found = all.find((r) => r.id === current);
    const lost = el('option', undefined, found ? `${found.label}（現在不相容，不會帶）` : `${current}（找不到了，不會帶）`);
    lost.value = current;
    select.appendChild(lost);
  }
  select.value = current;
  select.disabled = !bindings || all.length === 0;
  select.addEventListener('change', () => {
    vscode.postMessage({ type: 'bindSkill', stage, id: select.value || null });
  });
  field.appendChild(select);
  return field;
}

function optgroup(label: string): HTMLOptGroupElement {
  const group = document.createElement('optgroup');
  group.label = label;
  return group;
}

function appendOptions(parent: HTMLElement, rows: SkillRow[]): void {
  for (const row of rows) {
    const opt = el('option', undefined, `${row.label}（${SKILL_SOURCE_LABEL[row.source]}）`);
    opt.value = row.id;
    opt.title = row.description;
    parent.appendChild(opt);
  }
}

// ---------------------------------------------------------------- 技能庫

function renderLibrary(v: SkillsView): void {
  const box = maybeById('skillList');
  if (!box) {
    return;
  }
  clear(box);
  const count = maybeById('skillCount');
  if (count) {
    count.textContent = `${v.rows.length} 份`;
  }
  const hint = maybeById('skillLibraryHint');
  if (hint) {
    hint.textContent =
      `我的技能庫在 ${v.userDir}，所有工程共用；本工程的技能放在工程後設資料目錄下的 skills/<名字>/SKILL.md，跟著工程走。` +
      '手放進去的，切回這一頁就會出現。';
  }
  if (v.rows.length === 0) {
    box.appendChild(el('div', 'hint', '一份技能都沒有。'));
    return;
  }
  for (const row of v.rows) {
    box.appendChild(libraryRow(row));
  }
}

function libraryRow(row: SkillRow): HTMLElement {
  const card = el('div', 'skill-card');
  card.dataset.skillId = row.id;
  const head = el('div', 'skill-head');
  const name = el('span', 'skill-name', row.label);
  name.title = row.id;
  head.appendChild(name);
  head.appendChild(el('span', 'skill-tag', SKILL_SOURCE_LABEL[row.source]));
  head.appendChild(el('span', `skill-tag ${row.compatible ? 'ok' : 'bad'}`, row.compatible ? '相容' : '不相容'));
  card.appendChild(head);
  if (row.description) {
    card.appendChild(el('div', 'skill-desc', row.description));
  }
  card.appendChild(
    el(
      'div',
      'skill-meta',
      [
        row.version ? `版本 ${row.version}` : '',
        `建議階段：${SKILL_STAGE_LABEL[row.suggestedStage]}`,
        `${row.bytes} 位元組`,
        row.files.length > 0 ? `附帶 ${row.files.length} 份檔案` : '',
        row.boundTo.length > 0 ? `本工程綁在：${row.boundTo.map((s) => SKILL_STAGE_LABEL[s]).join('、')}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );
  for (const reason of row.reasons) {
    card.appendChild(el('div', 'skill-error', reason));
  }
  const actions = el('div', 'skill-actions');
  if (row.relPath) {
    const open = el('button', 'link', '開啟');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: row.relPath! }));
    actions.appendChild(open);
  }
  if (row.source === 'user' || row.source === 'project') {
    const remove = el('button', 'link danger', row.source === 'user' ? '解除安裝' : '刪除');
    remove.addEventListener('click', () => vscode.postMessage({ type: 'uninstallSkill', id: row.id }));
    actions.appendChild(remove);
  }
  if (actions.childElementCount > 0) {
    card.appendChild(actions);
  }
  return card;
}
