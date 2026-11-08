/**
 * jsdom 測試臺：把**構建產物**（`dist/media/*.js`）跑在真實 DOM 上。
 *
 * 遷自 `scripts/smoke-view.js` 的 19-235 行。只有 `tests/dom/` 下的用例用它。
 *
 * 跑的是產物而不是原始碼：產物是 IIFE 格式的 classic script，jsdom 的
 * `window.eval` 只吃得下這種。跑之前必須先 `node scripts/build-media.js`。
 *
 * 與原指令碼的兩處**有意不同**：
 * 1. 缺 jsdom 時不再 `process.exit(0)` 靜默全綠，而是匯出 `hasJsdom`，
 *    讓各檔案走 `describe(..., { skip: JSDOM_SKIP }, ...)`——跳過會出現在
 *    node:test 的 skipped 彙總裡，看得見。
 * 2. 產物不存在時給一句人話，而不是讓 ENOENT 的呼叫棧蓋住真正的原因。
 */
const fs = require('fs');
const path = require('path');
const { loadModule } = require('./load');

const ROOT = path.join(__dirname, '..', '..');
/** 前端構建產物目錄。與 scripts/build-media.js 的 outdir 同一處。 */
const MEDIA = path.join(ROOT, 'dist', 'media');

let JSDOM;
let hasJsdom = true;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  hasJsdom = false;
}

/** 傳給 `describe` 的 skip 選項：缺 jsdom 時是一句說明，否則 false。 */
const JSDOM_SKIP = hasJsdom ? false : '未安裝 jsdom（npm i -D jsdom）';

// ---------------------------------------------------------------- body 模板

/**
 * 從**渲染出來的**整頁 HTML 裡摳出 body。
 *
 * 從前這裡是拿正則去模板原始碼裡摳的，頁面骨架收進 `src/shells/shared/panes.ts`
 * 之後那條路就斷了：模板原始碼裡剩下的是 `${chatPane(...)}` 這樣的插值，
 * 抹掉插值等於抹掉整個頁面。現在改成**執行模板函式**，測試因此比從前更嚴——
 * 跑的是殼真正會發給瀏覽器的那份 HTML。
 *
 * 找不到 <body> 就當場拋——模板形狀變了必須早點發現，這正是它存在的意義。
 */
function extractBody(html, what) {
  // <body> 上帶著 data-vscode-context / class 屬性，不能按字面量找。
  const open = /<body[^>]*>/.exec(html);
  const end = html.indexOf('</body>');
  if (!open || end === -1) {
    throw new Error(`${what} 渲染出來的 HTML 裡找不到 <body>，測試需要同步更新`);
  }
  return (
    html
      .slice(open.index + open[0].length, end)
      // 去掉 <script src>，指令碼我們手動注入（跑的是 dist/media/ 的產物）。
      .replace(/<script[\s\S]*?<\/script>/g, '')
  );
}

/** 外掛 webview 的 body。 */
function bodyHtml() {
  const { renderHtml } = loadModule('src/shells/vscode/webviewHtml.ts');
  // asset / cspSource 由宿主注入（真實實現在 shells/vscode/webview.ts），
  // 這裡給個假的就夠——指令碼與樣式都不從這條路載入。
  const html = renderHtml({ asset: (name) => `/${name}`, cspSource: 'test:' });
  return extractBody(html, 'webviewHtml.renderHtml');
}

/** 獨立版的 body（含 #wbEditor 等工作臺結構）。 */
function standaloneBodyHtml() {
  const { standalonePage } = loadModule('src/shells/standalone/page.ts');
  return extractBody(standalonePage(), 'standalonePage');
}

// ---------------------------------------------------------------- 掛載

/**
 * `mirrorLayout` 這塊假排版的尺寸。jsdom 沒有排版，`offsetTop` / `clientHeight` 全是 0；
 * 內建編輯器靠高亮映象層量某個字的縱向位置來滾動（`editor/highlight.ts` 的 `scrollToOffset`），
 * 要測「按量出來的位置滾」就得給它一個可預期的數。
 */
const MIRROR_LAYOUT = { line: 30, pad: 18, viewport: 300 };
/** 預覽假排版（`previewLayout`）：一行多高。 */
const PREVIEW_LAYOUT = { line: 40 };

/** jsdom 缺的那些零碎，按名字取用。 */
const SHIMS = {
  clipboard(window) {
    window.navigator.clipboard = { writeText: () => Promise.resolve() };
  },
  scrollIntoView(window) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  },
  pointerCapture(window) {
    window.HTMLElement.prototype.setPointerCapture = () => {};
    window.HTMLElement.prototype.releasePointerCapture = () => {};
  },
  confirm(window) {
    window.confirm = () => true;
  },
  /**
   * 窄屏（≤900px）：jsdom 沒有 `matchMedia`，按寬度的那條媒體查詢說成立，別的（深淺色偏好之類）不成立；視口寬度也說成手機的
   * （`media/src/narrow.ts` 按 `innerWidth` 認）。指令碼裝載時就要問。
   */
  narrow(window) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 412 });
    window.matchMedia = (query) => ({
      matches: /max-width:\s*900px/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
  },
  /**
   * 手撥的時鐘：視窗裡的 `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` 換成假的，
   * `window.__clock.tick(ms)` 往前撥——撥到點的按時間先後跑，跑的時候新掛上的只要也在這段裡照樣跑。
   * 測停筆 2 秒、10 秒沒迴音、收到 `state` 之後的去抖這些，不必真等。`Date` 不動。
   */
  fakeTimers(window) {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    const add = (fn, ms, args, every) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every });
      return id;
    };
    window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, 0);
    window.setInterval = (fn, ms, ...args) => add(fn, ms, args, Math.max(1, Number(ms) || 0));
    window.clearTimeout = (id) => timers.delete(id);
    window.clearInterval = (id) => timers.delete(id);
    window.__clock = {
      tick(ms) {
        const end = now + ms;
        for (;;) {
          let nextId;
          let next;
          for (const [id, t] of timers) {
            if (t.at <= end && (!next || t.at < next.at)) {
              next = t;
              nextId = id;
            }
          }
          if (!next) {
            break;
          }
          now = next.at;
          if (next.every) {
            next.at += next.every;
          } else {
            timers.delete(nextId);
          }
          if (typeof next.fn === 'function') {
            next.fn(...next.args);
          }
        }
        now = end;
      },
    };
  },
  /** 假裝是 Mac（`navigator.platform` 是 `MacIntel`）：快捷鍵按 ⌘ / ⌥ 寫。 */
  mac(window) {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
  },
  /**
   * 預覽的假排版：`.ed-preview` 裡帶 `data-line` 的每一塊，頂 = 第幾行 × `PREVIEW_LAYOUT.line`（隨預覽的 `scrollTop`
   * 往上挪），高 = 佔幾行 × 同一個數；預覽自己的頂是 0。測「切預覽 / 切回編輯時兩邊滾到同一處」用，別處照舊是 0。
   */
  previewLayout(window) {
    const { line } = PREVIEW_LAYOUT;
    const original = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      const preview = this.closest?.('.ed-preview');
      if (preview && this !== preview && this.dataset?.line !== undefined) {
        const start = Number(this.dataset.line);
        const end = Number(this.dataset.lineEnd);
        const top = start * line - preview.scrollTop;
        return { top, bottom: top + (end - start) * line, left: 0, right: 0, width: 0, height: (end - start) * line, x: 0, y: top };
      }
      return original.call(this);
    };
  },
  /**
   * 假排版，只管量位置的那一份映象（`.ed-mirror-probe`）：裡面的標記 `offsetTop` = 上內邊距 +
   * 它前面的換行數 × 行高，`offsetHeight` = 行高；textarea 的 `clientHeight` 是固定的視口高。
   * 一行一個換行、不模擬折行——測的是「滾動按量出來的位置走」，不是排版本身。別處照舊是 0。
   * 量過哪些字記在 `window.__measured` 上（標記裡包的就是目標那個字）。
   */
  mirrorLayout(window) {
    const { line, pad, viewport } = MIRROR_LAYOUT;
    window.__measured = [];
    const inProbe = (node) => !!node.closest?.('.ed-mirror-probe');
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        if (!inProbe(this) || this.classList.contains('ed-mirror-content')) {
          return 0;
        }
        let before = '';
        for (const node of this.parentNode.childNodes) {
          if (node === this) break;
          before += node.textContent;
        }
        window.__measured.push(this.textContent);
        return pad + (before.split('\n').length - 1) * line;
      },
    });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return inProbe(this) ? line : 0;
      },
    });
    Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => viewport,
    });
  },
};

function readArtifact(name) {
  const file = path.join(MEDIA, name);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少構建產物 ${path.relative(ROOT, file)}，先跑 node scripts/build-media.js`);
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * 起一個裝好前端產物的環境，返回操作控制代碼。
 *
 * 合併了原指令碼的四個近乎重複的掛載函式（mount / mountEditor / mountExplorer
 * 與 772 行的行內變體）。它們的差別只有三處：body 模板、注入哪些 js、
 * 補哪些 jsdom 缺的 API；`acquireVsCodeApi` 樁與 post() 訊息泵四份完全一樣。
 *
 * @param {object} [opts]
 * @param {'webview'|'standalone'} [opts.body] 用哪份 body 模板
 * @param {string[]} [opts.scripts] 注入哪些產物（按順序 eval）
 * @param {Array<keyof SHIMS>} [opts.shims] 補哪些 jsdom 缺的 API
 * @param {boolean} [opts.empty] 獨立版空視窗（`no-workspace`）。預設按已開啟工程掛，
 *   這樣創作頁 / 編輯器 / 資源管理器用例不必每條都先推一條 `workspaces`。
 * @param {string} [opts.url] 頁面地址。預設是 `about:blank`——那是個不透明的源，`localStorage` 一碰就拋，
 *   前端各處「記不進去就算了」；要測確實記進了 localStorage（按工程分鍵的那幾樣）時給一個
 *   `http://localhost/?project=…`。
 * @param {Record<string, string>} [opts.storage] 跑指令碼之前寫進 localStorage 的幾項（測重新整理恢復用）。
 *   給了而沒給 `url` 時頁面掛在 `http://localhost/` 上。
 */
function mount({
  body = 'webview',
  scripts = ['view.js'],
  shims = ['clipboard', 'scrollIntoView'],
  empty = false,
  url,
  storage,
} = {}) {
  if (!hasJsdom) throw new Error('未安裝 jsdom');

  // 獨立版的 body 上帶 class="workbench"，editor.js / explorer.js 認這個。
  const html =
    body === 'standalone'
      ? `<!DOCTYPE html><html><body class="workbench${empty ? ' no-workspace' : ''}">${standaloneBodyHtml()}</body></html>`
      : `<!DOCTYPE html><html><body>${bodyHtml()}</body></html>`;

  const pageUrl = url ?? (storage ? 'http://localhost/' : undefined);
  const dom = new JSDOM(html, { runScripts: 'outside-only', ...(pageUrl ? { url: pageUrl } : {}) });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage ?? {})) {
    window.localStorage.setItem(key, value);
  }
  const sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(m),
    getState: () => undefined,
    setState: () => {},
  });

  for (const name of shims) SHIMS[name](window);
  for (const name of scripts) window.eval(readArtifact(name));

  const doc = window.document;
  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));

  // ---- 對話氣泡（view.js）
  const bubble = (id) => doc.querySelector(`[data-turn="${id}"]`);
  const bodyOf = (id) => {
    const node = bubble(id);
    return node ? node.querySelector('.msg-body') : null;
  };

  // ---- 內建編輯器（editor.js）：頁面上的兩塊編輯區
  const panes = () => [...doc.querySelectorAll('.wb-editor')];

  // ---- 資源管理器（explorer.js）
  const rows = () => [...doc.querySelectorAll('#filesBody .fx-row')];
  /** 每行的名字（跳過圖示與大小兩列，它們各有各的斷言）。 */
  const names = () =>
    rows().map((r) => {
      const name = r.querySelector('.fx-name');
      return (name ? name.textContent : r.textContent).trim();
    });
  const click = (row) => row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- 原指令碼裡每個小節各抄一遍的小工具
  const clickEl = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // cancelable: true——真實的右鍵事件是可取消的，選單引擎正是靠
  // preventDefault() 壓住原生選單，合成事件不帶這個就測不到那件事。
  const rightClick = (node, x = 40, y = 60) => {
    node.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    );
    return doc.querySelector('.ctx-menu');
  };
  /** 觸控板雙指點選在部分環境裡只發 auxclick（副鍵 = button 2）。 */
  const auxClick = (node, x = 40, y = 60) => {
    const ev = new window.MouseEvent('auxclick', {
      bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
    });
    node.dispatchEvent(ev);
    return ev;
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const pick = (menu, label) =>
    clickEl([...menu.querySelectorAll('button')].find((b) => b.textContent === label));
  const last = (type) => [...sent].reverse().find((m) => m.type === type);
  /** 收起當前開啟的選單（點一下 body），免得它掛在那兒影響後續斷言。 */
  const closeMenu = () => doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // ---- 內建編輯器的頁內對話方塊（editor/dialog.ts）
  /** 等頁面裡排著的 Promise 後續跑完（對話方塊答完之後的儲存、關標籤都在 then 裡）。 */
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  /** 開著的那個對話方塊，沒有就是 null。 */
  const dialog = () => doc.querySelector('.ed-dialog');
  /** 對話方塊上幾顆按鈕的字，從左到右。 */
  const dialogButtons = () => [...(dialog()?.querySelectorAll('.modal-foot button') ?? [])].map((b) => b.textContent);
  /** 在開著的對話方塊上點那顆按鈕（按字認），再等後續跑完。 */
  const answer = async (label) => {
    const btn = [...(dialog()?.querySelectorAll('.modal-foot button') ?? [])].find((b) => b.textContent === label);
    if (!btn) {
      throw new Error(`對話方塊上沒有「${label}」：${JSON.stringify(dialogButtons())}`);
    }
    clickEl(btn);
    await flush();
  };

  return {
    window, doc, sent, post,
    bubble, bodyOf,
    panes,
    rows, names, click,
    clickEl, rightClick, auxClick, itemsOf, pick, last, closeMenu,
    flush, dialog, dialogButtons, answer,
  };
}

// ---------------------------------------------------------------- fixture

const turn = (id, role, content, extra) =>
  Object.assign({ id, role, content, at: new Date(0).toISOString() }, extra);

/**
 * 一輪裡排下來的段（外部 agent 經 MCP 調工具、帶工具條的回放）。形狀與後端 `serializeTurn` 的一致——
 * **介面只認這一個欄位**。
 *
 * ```js
 * turn('a1', 'assistant', '排好了。', {
 *   segments: [toolSeg({ callId: 'c1', name: 'read', … }), textSeg('排好了。')],
 * })
 * ```
 */
const textSeg = (text) => ({ kind: 'text', text });
const toolSeg = (call) => ({ kind: 'tool', call });

/**
 * 一個空會話。形狀與後端 `serializeSession` 一致——前端把會話當唯一真相
 * （麵包屑、能力按鈕、目標下拉全讀它），缺欄位會當場炸，而那正是我們要的：
 * 協議對不上就該早點發現。
 */
const emptySession = (extra) =>
  Object.assign(
    {
      id: 's',
      title: '',
      target: { kind: 'outline' },
      stage: 'outline',
      capability: 'discuss',
      // 思考深度也在會話上（後端 serializeSession 恆給，預設 off）。
      thinking: 'off',
      turns: [],
    },
    extra
  );

/**
 * 一份單章流水線檢視，欄位與 `PlotPipelineView` 一致。
 *
 * 預設是「細綱排好了、正文還沒寫」的第 12 章：細綱號 = 章號，所以一章只有
 * 細綱與正文兩面（`plot` / `chapter`），沒有卷、也沒有中轉站那一份。
 * `chapter` 整塊換掉時記得帶全五個欄位——前端直接讀 `chapter.upstreamStale`。
 */
const pipelineView = (extra) =>
  Object.assign(
    {
      plotRelPath: '.novelwarden/summaries/012-夜入青雲.md',
      no: 12,
      title: '夜入青雲',
      // 情節大綱裡有沒有這一章（就是這一章細綱的梗概），大綱排到第幾章。流水線條上「大綱」那一格畫它。
      outline: { covered: true, coverage: 20 },
      plot: {
        relPath: '.novelwarden/summaries/012-夜入青雲.md',
        exists: true,
        filled: true,
        upstreamStale: false,
      },
      // 同號的正文。還沒寫時 relPath 是空串；目標字數取細綱的 targetWords。
      chapter: { exists: false, relPath: '', words: 0, targetWords: 3000, upstreamStale: false },
      // 定稿：`exists` = 細綱定稿過，`stale` = 沒定稿或定稿之後正文又改過。
      summary: { exists: false, stale: true },
      stage: 'manuscript',
      progress: { plot: 1, manuscript: 0, summary: 0 },
    },
    extra
  );

/**
 * 一份工作區卡檢視，欄位與 `WorkbenchView` 一致。預設是第 12 章細綱那一層。
 * `layer` 沒給就照後端的口徑從標題推：「架構 · 故事前提」→「故事前提」，「正文 · 第 12 章…」→「正文」。
 */
const workbenchView = (extra) => {
  const view = Object.assign(
    {
      stage: 'plot',
      title: '細綱 · 第 12 章《夜入青雲》',
      relPath: '.novelwarden/summaries/012-夜入青雲.md',
      sections: [{ key: '梗概', text: '林昭成功進入青雲宗' }],
    },
    extra
  );
  if (view.layer === undefined) {
    view.layer = view.title.startsWith('架構 · ') ? view.title.slice('架構 · '.length) : view.title.split(' · ')[0];
  }
  return view;
};

/** 一份 `ViewState`。只填必需欄位，其餘給能過渲染的最小值。 */
const viewState = (extra) =>
  Object.assign(
    {
      initialized: true,
      // 創作目標下拉的候選：**每個章號一行**，`{ no, label, title, wordCount, relPath }`，
      // 說法（label）由後端給。
      plots: [],
      nextNo: 1,
      staleCount: 0,
      model: 'glm/glm-4-plus',
      modelLabel: '智譜 GLM · glm-4-plus',
      models: [{ ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: '智譜 GLM' }],
      contextDetail: 3,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    extra
  );

/**
 * 造一棵工程頁快照：「故事架構」五行 + 一個章號一行的章節列表 + 角色樹 + 空資料夾。
 *
 * 形狀與後端 `buildProjectTree` 一致（`src/core/views/projectView.ts`）：細綱號 = 章號，
 * 所以細綱與正文是同一行的兩面——`relPath` 是主路徑（有正文就是正文，否則是細綱），
 * `plotPath` 是細綱**應在**的位置（`plotExists` 說它在不在），`chapterPath` 沒有正文時是空串。
 * 定稿改的就是 `plotPath` 那一份細綱本身，不另落一份檔案。
 *
 * 五種樣本各一行，覆蓋單章狀態機的四檔加「只有正文、沒有細綱的章」：
 *
 * | 章 | 細綱 | 正文 | 定稿 | stage |
 * |---|---|---|---|---|
 * | 1《楔子》 | 有 | 300 字，帶草稿 | 對得上 | done |
 * | 2《入鎮》 | **沒有**（作者手寫的正文） | 2980 / 3000 | 沒定稿 | finalize |
 * | 3《夜訪》 | 有 | 300 字 | 對得上 | done |
 * | 4《北行》 | 有，大綱那一節後來改過（⟳） | 沒寫 | — | manuscript |
 * | 5《赤星》 | 只有骨架 | 沒寫 | — | plot |
 *
 * `nextChapterNo` 是 4：從第 1 章起連續有正文的最大章號 + 1。**只有這一行**掛
 * 「去寫這一章」。故事架構五件填了四件（設定清單因為已經寫了正文算填過）、外加大綱，所以組標題是 5/6。
 */
function sampleTree() {
  return {
    initialized: true,
    plotCount: 5, chapterCount: 3, totalWords: 3580, staleCount: 1,
    summarizedCount: 2, bookStage: 'writing', nextChapterNo: 4,
    // 一句話、拆細綱兩個彈窗的預設值。第 1、3、4 章排過細綱，大綱覆蓋到第 20 章。
    book: {
      idea: '一個從火裡活下來的人回到起火的地方。', totalChapters: 30, wordsPerChapter: 400,
      configHasContent: true, outlineCoverage: 20, plotFilledNos: [1, 3, 4],
    },
    chaptersRoot: 'chapters', charactersRoot: '.novelwarden/characters', loreRoot: '.novelwarden/lore',
    globalSummaryThrough: 2, styleGuidePath: '.novelwarden/style.md',
    globalSummaryPath: '.novelwarden/summaries/global.md',
    // 敘事線（一條線一個檔案，`views/threads.ts` 現算好、排好序）：四條線——主線進行中、一條感情線斷了且有伏筆逾期、
    // 一條支線還只是計劃、一條人物線已收束；最後是「未歸屬的伏筆」。「現在」是定稿到的第 3 章。
    threadsPath: '.novelwarden/threads',
    threads: {
      current: 3,
      lines: [
        { name: '青崖舊案', relPath: '.novelwarden/threads/青崖舊案.md', kind: '主线', status: '进行中', lastActive: 3,
          detail: '主線 · 進行中 · 最近第 3 章 · 1 條伏筆沒收', warnings: [], tip: '意圖：查清七年前那場火\n\n當前進度（寫到第 3 章）：林昭回到青崖鎮' },
        { name: '林昭與沈氏', relPath: '.novelwarden/threads/林昭與沈氏.md', kind: '感情线', status: '进行中', lastActive: 1,
          detail: '感情線 · 進行中 · 最近第 1 章 · 2 條伏筆沒收', warnings: ['1 條伏筆逾期', '過了計劃收束的第 2 章'], tip: '' },
        { name: '李叔的舊賬', relPath: '.novelwarden/threads/李叔的舊賬.md', kind: '支线', status: '计划中',
          detail: '支線 · 計劃中 · 計劃第 6–12 章', warnings: [], tip: '' },
        { name: '守衛的選擇', relPath: '.novelwarden/threads/守衛的選擇.md', kind: '人物线', status: '已收束', lastActive: 2,
          detail: '人物線 · 已收束 · 最近第 2 章', warnings: [], tip: '' },
      ],
      unfiled: { relPath: '.novelwarden/threads/未归属的伏笔.md', total: 2, detail: '2 條', warnings: [] },
    },
    // 故事架構：五件文件 + 情節大綱，順序即生成順序。世界觀還沒寫。
    // 角色圖譜、設定清單沒有自己的檔案，relPath 給的是角色目錄、設定目錄。這棵樹已經寫了正文，
    // 設定清單算填過（一條條目都沒有也照實說 0 條）。
    architecture: [
      { key: 'config', label: '小說配置', relPath: '.novelwarden/config.md', filled: true, detail: '' },
      { key: 'premise', label: '故事前提', relPath: '.novelwarden/premise.md', filled: true, detail: '' },
      { key: 'characters', label: '角色圖譜', relPath: '.novelwarden/characters', filled: true, detail: '2 人' },
      { key: 'world', label: '世界觀', relPath: '.novelwarden/world.md', filled: false, detail: '待生成' },
      { key: 'lore', label: '設定清單', relPath: '.novelwarden/lore', filled: true, detail: '0 條' },
      { key: 'outline', label: '情節大綱', relPath: '.novelwarden/outline.md', filled: true, detail: '覆蓋到第 20 章' },
    ],
    // 章節列表是扁平的，一個章號一行，升序。這棵樹沒分卷（`volumes` 空、每行 `volume` 是空串），頁籤照舊平鋪；
    // 分卷的畫法見 tests/dom/view/volumes.test.js 的 `volumeTree()`。
    volumes: [],
    plots: [
      // 第 1 章：寫完且定稿過，細綱與正文對得上，還帶一份草稿。
      { no: 1, label: '第 1 章《楔子》', title: '楔子', volume: '',
        relPath: 'chapters/001-楔子.md',
        plotPath: '.novelwarden/summaries/001-楔子.md', plotExists: true,
        chapterPath: 'chapters/001-楔子.md',
        wordCount: 300, stale: false,
        stage: 'done', upstreamStale: false,
        draftPath: 'drafts/001-楔子.md', hasDraft: true,
        progress: { plot: 1, manuscript: 1, summary: 1 } },
      // 第 2 章：**作者手寫的章**——只有正文、沒有細綱（plotPath 是它應在的位置，定稿時照正文
      // 整理一份落在那裡）。寫夠了目標字數、還沒定稿 → 待定稿。
      { no: 2, label: '第 2 章《入鎮》', title: '入鎮', volume: '',
        relPath: 'chapters/002-入鎮.md',
        plotPath: '.novelwarden/summaries/002-入鎮.md', plotExists: false,
        chapterPath: 'chapters/002-入鎮.md',
        wordCount: 2980, targetWords: 3000, stale: true,
        stage: 'finalize', upstreamStale: false,
        draftPath: 'drafts/002-入鎮.md', hasDraft: false,
        progress: { plot: 0, manuscript: 1, summary: 0 } },
      // 第 3 章：寫完且定稿過。
      { no: 3, label: '第 3 章《夜訪》', title: '夜訪', volume: '',
        relPath: 'chapters/003-夜訪.md',
        plotPath: '.novelwarden/summaries/003-夜訪.md', plotExists: true,
        chapterPath: 'chapters/003-夜訪.md',
        wordCount: 300, stale: false,
        stage: 'done', upstreamStale: false,
        draftPath: '', hasDraft: false,
        progress: { plot: 1, manuscript: 1, summary: 1 } },
      // 第 4 章：細綱排好了、正文還沒寫（目標 3000 字）；情節大綱裡覆蓋它的那一節
      // 在細綱之後改過（⟳）。它就是 nextChapterNo——主路徑因此是細綱。
      { no: 4, label: '第 4 章《北行》', title: '北行', volume: '',
        relPath: '.novelwarden/summaries/004-北行.md',
        plotPath: '.novelwarden/summaries/004-北行.md', plotExists: true,
        chapterPath: '',
        wordCount: 0, targetWords: 3000, stale: false,
        stage: 'manuscript', upstreamStale: true,
        draftPath: '', hasDraft: false,
        progress: { plot: 1, manuscript: 0, summary: 0 } },
      // 第 5 章：細綱只有一個骨架（「關鍵事件」是空的）→ 待寫細綱。
      { no: 5, label: '第 5 章《赤星》', title: '赤星', volume: '',
        relPath: '.novelwarden/summaries/005-赤星.md',
        plotPath: '.novelwarden/summaries/005-赤星.md', plotExists: true,
        chapterPath: '',
        wordCount: 0, stale: false,
        stage: 'plot', upstreamStale: false,
        draftPath: '', hasDraft: false,
        progress: { plot: 0, manuscript: 0, summary: 0 } },
    ],
    characters: [
      { kind: 'dir', label: '配角', relPath: '.novelwarden/characters/配角', fileCount: 1, children: [
        { kind: 'file', label: '李叔', relPath: '.novelwarden/characters/配角/李叔.md', detail: '' },
      ] },
      { kind: 'file', label: '林昭', relPath: '.novelwarden/characters/林昭.md', detail: '主角' },
    ],
    lore: [],
    // 設定名錄（views/lore.ts）：這棵樹沒有設定條目，定稿裡也沒出現過——三樣都是空的。
    // 設定組的行、未建條目與篩選框見 tests/dom/view/loreCatalog.test.js 的 `loreTree()`。
    loreByEntry: {},
    loreUnfiled: [],
    loreThin: [],
    loreUnrecorded: 0,
    // 正常工程這裡是空物件——只有出錯的目標才有記錄。
    failures: {},
    castConflicts: [],
    // 林昭出場三章、上次只更新到第 1 章 → 待更新 2 章；李叔從沒在定稿過的細綱裡出現。
    castByCard: {
      '.novelwarden/characters/林昭.md': {
        plots: [1, 2, 3], detail: '第 1、2、3 章', updatedThrough: 1, pending: 2,
      },
      '.novelwarden/characters/配角/李叔.md': {
        plots: [], detail: '未在定稿中出現', updatedThrough: 0, pending: 0,
      },
    },
    cast: [
      { name: '客棧掌櫃', aliases: ['掌櫃'], plots: [2, 3], detail: '第 2、3 章' },
      { name: '老周', aliases: [], plots: [3], detail: '第 3 章' },
    ],
  };
}

/**
 * 內建編輯器的章節索引（`chapterIndex` 訊息的 `chapters`）：工程樹章節那一行裡章節條與上一章 / 下一章要的
 * 那幾個欄位，與後端 `views/chapterIndex.ts` 同形。預設取 {@link sampleTree} 的五章。
 */
const CHAPTER_INDEX_KEYS = ['no', 'label', 'title', 'relPath', 'plotPath', 'plotExists', 'chapterPath', 'wordCount', 'targetWords', 'stage'];
function sampleChapterIndex(plots = sampleTree().plots) {
  return plots.map((p) => Object.fromEntries(CHAPTER_INDEX_KEYS.filter((k) => k in p).map((k) => [k, p[k]])));
}

/** 一份編輯器檔案負載。 */
const file = (p, text, extra) =>
  Object.assign({ path: p, name: p.split('/').pop(), text, hash: `h-${p}`, bytes: text.length }, extra);

/** 造一份 DirListing。`spec` 形如 { 'a': 'dir', 'b.md': 'file' }。 */
const listing = (relPath, spec, extra) =>
  Object.assign(
    {
      relPath,
      truncated: 0,
      entries: Object.entries(spec).map(([name, kind]) => ({
        kind: kind === 'dir' ? 'dir' : 'file',
        name,
        relPath: relPath ? `${relPath}/${name}` : name,
        editable: kind === 'file',
        bytes: kind === 'dir' ? 0 : 100,
        modified: 0,
      })),
    },
    extra
  );

module.exports = {
  ROOT, MEDIA,
  hasJsdom, JSDOM_SKIP,
  extractBody, bodyHtml, standaloneBodyHtml,
  mount,
  MIRROR_LAYOUT, PREVIEW_LAYOUT,
  turn, textSeg, toolSeg, emptySession, pipelineView, workbenchView, viewState, sampleTree, sampleChapterIndex,
  file, listing,
};
