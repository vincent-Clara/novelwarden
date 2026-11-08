/**
 * 空視窗歡迎頁（開始 / 最近 / 怎麼上手）、視窗標題、無工程時側欄短空態。
 *
 * 「新建一本書」「匯入寫好的書」（2026-10-24）各是一張表單：書名、作者、放在哪一次填好，後端建資料夾並初始化
 * （`createProject` → `projectCreated`），前端再照常開啟它；匯入的那本 txt 先看切得出幾章（`inspectBook` →
 * `bookInspected`），說明擺在表單上，開啟之後帶著它的路徑接著匯入（`projectAction importManuscript hostPath`）。
 *
 * 沒有 `#nfWelcome` 就直接 return（外掛）。不判斷殼名。
 */
import { el as mk } from '../dom';
import { confirmProceedIfDirty, resetEditor, windowProject } from '../globals';
import { bookDirName } from '../protocol';
import type { BookInspection, WorkspaceItem, WorkspaceRecent } from '../protocol';
import { narrowScreen } from '../narrow';
import { pickHostPath } from './folderPicker';
import { openForm } from './form';
import { showProjectTab } from './project/tabs';
import { el } from './refs';
import { hasWorkspace, store, vscode } from './store';
import { showTab } from './tabs';
import { toast } from './toast';

const EMPTY_HINT = '開啟資料夾後即可使用';
const SIDE_PANES = ['pane-chat', 'pane-project', 'pane-files', 'pane-versions', 'pane-history'];

let fileName: string | null = null;
let about: HTMLElement | undefined;
/**
 * 剛建好、等著開啟的那本書：開啟之後切到「工程 → 章節」，帶著 txt 的接著匯入。`root` 是後端給的真實路徑，與
 * `workspaces` 的 `currentId` 同一個口徑——只在這個視窗真換成了它時才落地，換成了別的（沒開啟成、作者又開了別的）就作廢，
 * 絕不把 txt 導進另一本書。
 */
let pendingBook: { root: string; importFrom?: string } | undefined;
/** 「匯入寫好的書」挑好、正等後端看切得出幾章的那一本。別的回答不認。 */
let inspecting: string | undefined;

export function requestOpenFolder(): void {
  pickFolder('open', '開啟資料夾');
}

/** 「新建一本書…」：一張表單，書名、作者、放在哪。 */
export function requestNewProject(): void {
  openBookForm();
}

/** 「匯入寫好的書（txt）…」：先挑一本，後端看切得出幾章，再開同一張表單。 */
export function requestImportBook(): void {
  pickHostPath({
    kind: 'file',
    title: '匯入寫好的書：選一本 txt',
    extensions: ['txt'],
    onPick: (path) => {
      inspecting = path;
      vscode.postMessage({ type: 'inspectBook', path });
    },
  });
}

/** 後端看完了那本 txt：認不出章就說為什麼（改好 txt 再來），認得出就開表單。 */
export function applyBookInspected(msg: BookInspection): void {
  if (msg.path !== inspecting) {
    return;
  }
  inspecting = undefined;
  if (msg.chapters === 0) {
    toast(msg.error ?? '這本 txt 裡認不出章節。', true);
    return;
  }
  openBookForm(msg);
}

/** 建好了：照常開啟（這個視窗還是新視窗看設定），開啟之後切到章節頁、接著匯入。 */
export function applyProjectCreated(msg: { root: string; importFrom?: string }): void {
  openProject(msg.root, { fresh: true, importFrom: msg.importFrom });
}

/**
 * 新建一本書 / 匯入寫好的書的那張表單。`inspection` 給了就是匯入：說明裡寫認出幾章、丟掉了什麼（與「匯入原稿」
 * 確認框同一份），書名預設取檔名，提交帶上那本 txt。
 */
function openBookForm(inspection?: BookInspection): void {
  openForm({
    title: inspection ? '匯入寫好的書' : '新建一本書',
    lead: inspection
      ? `${inspection.headline}。這一步不呼叫模型。`
      : '起個書名就建好一本空書，接著在「工程 → 章節」裡新建第 1 章開寫。光寫字不需要配模型。',
    details: inspection?.detail,
    fields: [
      { kind: 'text', key: 'title', label: '書名', value: inspection?.title ?? '', placeholder: '如「青雲劍錄」', required: true },
      { kind: 'text', key: 'author', label: '作者（可以空著）' },
      {
        kind: 'text',
        key: 'parent',
        label: '放在',
        value: store.newProjectParent ?? '',
        required: true,
        browse: {
          label: '選…',
          run: (current, set) =>
            pickHostPath({ kind: 'dir', title: '放在哪個資料夾裡', start: current.trim() || undefined, onPick: set }),
        },
      },
    ],
    note: (v) => {
      const name = bookDirName(String(v.title));
      if (!name) {
        return { text: '書名裡的字都不能當資料夾名，換一個。', ok: false };
      }
      return { text: `會新建資料夾 ${joinPath(String(v.parent), name)}，書就放在裡面。` };
    },
    submitLabel: inspection ? '匯入' : '新建',
    onSubmit: (v) =>
      vscode.postMessage({
        type: 'createProject',
        parent: String(v.parent),
        title: String(v.title),
        author: String(v.author),
        ...(inspection ? { importFrom: inspection.path } : {}),
      }),
  });
}

/** 預覽用的拼路徑：目錄裡寫的是反斜槓（Windows）就用反斜槓。真建在哪以後端為準。 */
function joinPath(parent: string, name: string): string {
  const dir = parent.trim();
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function requestOpenFile(): void {
  if (!hasWorkspace()) {
    return;
  }
  pickFolder('file', '開啟檔案：工程內相對路徑');
}

function pickFolder(intent: 'open' | 'file', title: string): void {
  const ev = new CustomEvent('nf-pick-folder', { detail: { intent }, cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) {
    return;
  }
  const path = window.prompt(title, '');
  if (!path?.trim()) {
    return;
  }
  if (intent === 'file') {
    vscode.postMessage({ type: 'openEditor', path: path.trim() });
    return;
  }
  openProject(path.trim());
}

export function openRecent(root: string): void {
  openProject(root);
}

/** 新視窗網址上的這兩個引數：剛建好的書（開啟之後切到章節頁）、接著要匯入的那本 txt。 */
const BOOK_PARAM = 'book';
const IMPORT_PARAM = 'import';

/**
 * 開啟一個工程。這個視窗已經開著別的工程、且設定裡開著「新視窗中開啟專案」時開一個新視窗，
 * 這個視窗不動；否則換掉這個視窗裡的工程。`fresh`：剛建好的書，開啟後切到「工程 → 章節」；
 * `importFrom`：接著把這本 txt 導進來。
 */
export function openProject(root: string, opts: { fresh?: boolean; importFrom?: string } = {}): void {
  if (store.openInNewWindow && store.currentId && store.currentId !== root) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('project', root);
    if (opts.fresh) {
      url.searchParams.set(BOOK_PARAM, '1');
    }
    if (opts.importFrom) {
      url.searchParams.set(IMPORT_PARAM, opts.importFrom);
    }
    if (window.open(url.toString(), '_blank')) {
      return;
    }
    toast('瀏覽器攔下了新視窗，改在當前視窗開啟。');
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  if (opts.fresh) {
    pendingBook = { root, ...(opts.importFrom ? { importFrom: opts.importFrom } : {}) };
  }
  vscode.postMessage({ type: 'openFolder', path: root, mode: 'replace' });
}

/** 剛建好的書開啟了：側欄切到「工程 → 章節」（新書在那裡新建第 1 章，匯入的書在那裡看導進來的章），有 txt 就接著匯入。 */
function landInBook(book: { importFrom?: string }): void {
  showTab('project');
  vscode.postMessage({ type: 'switchTab', tab: 'project' });
  showProjectTab('chapters');
  if (book.importFrom) {
    vscode.postMessage({ type: 'projectAction', action: 'importManuscript', hostPath: book.importFrom });
  }
}

/**
 * 網址跟著這個視窗的工程走：重新整理、斷線重連都回到這個工程（WebSocket 握手帶著它），
 * 收藏下來的網址也直接開啟它。外掛的 webview 沒有可改的網址。
 */
function syncUrl(currentId: string | null): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return;
  }
  if (windowProject() === currentId) {
    return;
  }
  const url = new URL(location.href);
  if (currentId) {
    url.searchParams.set('project', currentId);
  } else {
    url.searchParams.delete('project');
  }
  history.replaceState(history.state, '', url.toString());
}

export function closeFolder(): void {
  if (!hasWorkspace()) {
    return;
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  vscode.postMessage({ type: 'closeFolder' });
}

export function showWelcome(): void {
  const node = document.getElementById('nfWelcome');
  if (!node) {
    return;
  }
  if (store.currentId === null) {
    revealNarrowEditor();
    return;
  }
  document.body.classList.add('show-welcome');
  revealNarrowEditor();
}

/**
 * 窄屏（`../narrow.ts`）上編輯區是收著的覆蓋層，歡迎頁在它裡面：
 * 要給人看就得翻上來，與編輯器開啟檔案時的 `revealEditor` 是同一個類。寬屏上編輯區常駐，什麼都不做。
 */
function revealNarrowEditor(): void {
  if (narrowScreen()) {
    document.body.classList.add('editor-open');
  }
}

export function hideWelcome(): void {
  document.body.classList.remove('show-welcome');
}

export function hideAbout(): void {
  about?.classList.remove('open');
}

export function showAbout(): void {
  if (!about) {
    return;
  }
  const version = document.getElementById('wbTitle')?.dataset.version || '0.0.0';
  const ver = about.querySelector('.nf-about-ver');
  const pathLine = about.querySelector('.nf-about-path');
  if (ver) {
    ver.textContent = `版本 ${version}`;
  }
  if (pathLine) {
    const root = store.currentId;
    pathLine.textContent = root ? `工程 ${root}` : '';
  }
  about.classList.add('open');
}

export function applyWorkspaces(msg: {
  currentId: string | null;
  items: WorkspaceItem[];
  recents: WorkspaceRecent[];
  openInNewWindow?: boolean;
  newProjectParent?: string;
}): void {
  const prev = store.currentId;
  store.currentId = msg.currentId;
  store.recents = msg.recents ?? [];
  if (typeof msg.openInNewWindow === 'boolean') {
    store.openInNewWindow = msg.openInNewWindow;
  }
  if (msg.newProjectParent) {
    store.newProjectParent = msg.newProjectParent;
  }
  // 先改網址再重置編輯器：標籤頁按網址上的工程分開記，重置之後要讀的是新工程那一份。
  syncUrl(msg.currentId);
  const empty = msg.currentId === null;
  const wasEmpty = document.body.classList.contains('no-workspace');
  document.body.classList.toggle('no-workspace', empty);
  if (empty) {
    document.body.classList.remove('show-welcome');
    fileName = null;
    // 窄屏上歡迎頁所在的編輯區是收著的覆蓋層：剛變成空視窗（含一開啟頁面就是空視窗）時把它翻上來
    // （標題欄 ▤ 照樣能收起，去設定頁配模型）。
    if (!wasEmpty || prev === undefined) {
      revealNarrowEditor();
    }
  } else if (wasEmpty && prev !== undefined) {
    // 從歡迎頁開啟了一本書：窄屏上把覆蓋著的編輯區收起來，露出側欄（開啟之後會切到「工程 → 章節」）。
    document.body.classList.remove('editor-open');
  }
  if (prev !== undefined && msg.currentId !== prev) {
    resetEditor();
  }
  // 等的是「這個視窗換了工程」那一條：空視窗那一條（新視窗剛裝好時自己推的）與還是原來那本的不算。
  if (pendingBook && msg.currentId && msg.currentId !== prev) {
    const book = pendingBook;
    pendingBook = undefined;
    if (msg.currentId === book.root) {
      landInBook(book);
    }
  }
  updateTitle(msg.items[0]);
  renderRecents();
  syncComposerLock();
}

export function installWelcome(): void {
  const root = document.getElementById('nfWelcome');
  if (!root) {
    return;
  }

  ensureSideEmptyHints();
  about = buildAbout();
  document.body.appendChild(about);

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-welcome]');
    if (!btn?.dataset.welcome) {
      return;
    }
    if (btn.dataset.welcome === 'openFolder') {
      requestOpenFolder();
    } else if (btn.dataset.welcome === 'newProject') {
      requestNewProject();
    } else if (btn.dataset.welcome === 'importBook') {
      requestImportBook();
    }
  });

  window.addEventListener('nf-editor-active', (e) => {
    fileName = fileNameOf(e.detail.path);
    if (e.detail.path) {
      hideWelcome();
    }
    updateTitle();
  });

  // 剛建好的書開在了新視窗裡：開啟之後由這個視窗切到章節頁、接著匯入。引數用過就摘掉，重新整理不再來一遍。
  const url = new URL(location.href);
  const project = url.searchParams.get('project');
  if (url.searchParams.has(BOOK_PARAM) && project) {
    const importFrom = url.searchParams.get(IMPORT_PARAM) || undefined;
    pendingBook = { root: project, ...(importFrom ? { importFrom } : {}) };
    url.searchParams.delete(BOOK_PARAM);
    url.searchParams.delete(IMPORT_PARAM);
    history.replaceState(history.state, '', url.toString());
  }

  // 沒指定工程的 MCP 呼叫落到最近操作的那個視窗上：拿到焦點就告訴後端一聲。
  window.addEventListener('focus', () => vscode.postMessage({ type: 'windowFocus' }));

  if (document.body.classList.contains('no-workspace')) {
    applyWorkspaces({ currentId: null, items: [], recents: [] });
  }
}

function syncComposerLock(): void {
  const on = hasWorkspace();
  el.input.disabled = !on;
  el.sendBtn.disabled = !on || store.busy;
  el.atBtn.disabled = !on || store.busy;
  el.selBtn.disabled = !on || store.busy;
  el.cmdBtn.disabled = !on || store.busy;
  el.modelSelect.disabled = !on;
  el.thinkSelect.disabled = !on;
  el.targetSelect.disabled = !on;
  el.newSessionBtn.disabled = !on || store.busy;
  el.renamePlotBtn.disabled = !on || store.busy;
  el.nextStepBtn.disabled = !on || store.busy;
}

/**
 * 標題欄寫兩份，CSS 按寬度挑一份露出來（`menubar.css` / `narrow.css`）：寬屏地方夠，寫工程的完整目錄
 * （`.wb-title-full`）；窄屏（手機豎屏只剩一百來畫素）寫書名——工程資料夾的名字（`.wb-title-short`），整條路徑在那兒
 * 只露得出 `/storage/emulated/0/Docu…` 這樣誰也認不出的開頭。瀏覽器標籤頁窄，只寫名字。完整目錄總在懸停提示上。
 */
function updateTitle(item?: WorkspaceItem): void {
  const current = item ?? (store.currentId ? { id: store.currentId, root: store.currentId, name: nameOf(store.currentId) } : undefined);
  const titleText = document.getElementById('wbTitleText');
  let title = 'Novelwarden';
  let barText = title;
  let shortText = title;
  if (current) {
    title = fileName ? `${fileName} - ${current.name} - Novelwarden` : `${current.name} - Novelwarden`;
    barText = fileName ? `${fileName} - ${current.root} - Novelwarden` : `${current.root} - Novelwarden`;
    shortText = current.name;
  }
  if (titleText) {
    titleText.replaceChildren(mk('span', 'wb-title-full', barText), mk('span', 'wb-title-short', shortText));
    titleText.title = current?.root ?? '';
  }
  document.title = title;
}

function renderRecents(): void {
  const list = document.getElementById('nfRecentList');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (store.recents.length === 0) {
    list.appendChild(mk('li', 'nf-recent-empty', '沒有最近開啟的工程'));
    return;
  }
  for (const rec of store.recents) {
    const li = mk('li');
    const btn = mk('button');
    btn.type = 'button';
    btn.appendChild(mk('span', undefined, rec.name));
    btn.appendChild(mk('span', 'nf-recent-path', rec.root));
    btn.addEventListener('click', () => openRecent(rec.root));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function ensureSideEmptyHints(): void {
  for (const id of SIDE_PANES) {
    const pane = document.getElementById(id);
    if (!pane || pane.querySelector('.ws-empty')) {
      continue;
    }
    // 遮罩上也給一顆「開啟資料夾…」（W12）：側欄的每一頁都看得見下一步，不必先找到歡迎頁。
    const box = mk('div', 'ws-empty');
    const inner = mk('div', 'ws-empty-inner');
    inner.appendChild(mk('p', undefined, EMPTY_HINT));
    const btn = mk('button', 'chip-btn', '開啟資料夾…');
    btn.dataset.welcome = 'openFolder';
    btn.addEventListener('click', () => requestOpenFolder());
    inner.appendChild(btn);
    box.appendChild(inner);
    pane.appendChild(box);
  }
}

function buildAbout(): HTMLElement {
  const wrap = mk('div', 'nf-about');
  const card = mk('div', 'nf-about-card');
  card.appendChild(mk('h2', undefined, 'Novelwarden'));
  card.appendChild(mk('p', 'nf-about-ver', '版本'));
  card.appendChild(mk('p', 'nf-about-path'));
  const close = mk('button', 'primary', '關閉');
  close.type = 'button';
  close.addEventListener('click', () => wrap.classList.remove('open'));
  card.appendChild(close);
  wrap.appendChild(card);
  return wrap;
}

function fileNameOf(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function nameOf(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || root;
}
