/**
 * 獨立版 Web 服務的端到端：程序內起服務 → HTTP 拿頁面/資源 → WS 握手拿 init →
 * 目錄列舉、狀態機選章、內建編輯器與章節草稿的讀寫往返。
 * 遷自 scripts/smoke-server.js（57 個 check 呼叫點 → 62 條用例，靜態資源那條
 * 在 6 個產物上迴圈）。
 *
 * **只在 Bun 下跑**：`bun test tests/e2e/`。ESM、直接 import TypeScript、
 * `import.meta.dir`、全域 WebSocket/fetch、`Bun.serve` —— 一樣都不遷就 Node。
 * `bun test` 實現了 node:test 的介面，所以寫法與其餘測試一致。
 * 跑之前需要 `node scripts/embed-media.js`（生成 src/shells/standalone/mediaAssets.ts
 * 與 dist/media/，都已 gitignore），否則 html.ts 的 import 直接炸。
 *
 * 不另起子程序：避免 Windows 上子程序殺不乾淨留下佔用埠的孤兒。
 *
 * ## 遷移修掉的一個 harness 缺陷（不是斷言缺陷）
 *
 * 原指令碼是 `try { …57 條斷言… } finally { process.exit(failures === 0 ? 0 : 1) }`。
 * `waitFor` 的 5 秒超時是 reject：異常沿頂層 await 拋出，但 `finally` 先執行，
 * 而此時 `failures` 仍是 0 —— **於是超時、崩潰、連不上一律以退出碼 0 收場**。
 * 這條綠燈長期是部分失效的。斷言本身沒問題，逐條原樣遷過來了；
 * 換到 node:test 之後，被拒絕的非同步用例就是一條失敗，這個坑由結構本身堵上。
 *
 * ## 已知限制：兩個服務關不掉
 *
 * `startServer()` 只返回埠號（src/shells/standalone/server.ts:30,146），拿不到
 * `Bun.serve` 控制代碼，所以 after() 只能關 WebSocket，HTTP 服務會掛到程序退出為止。
 * 原指令碼靠 process.exit 收尾。真要修得改 startServer 的返回值，超出本次範圍。
 *
 * ## 順序是硬約束
 *
 * `startServer` 裡調的 `initHost()` 是模組級單例：3998 的服務一起，全域 host
 * 就被換掉。所以 3999 的用例必須**全部跑完**，才能進臨時工程那兩節；
 * 空視窗（3997）必須再排在臨時工程 after 之後。
 * describe 按原始碼順序執行，setup 放各自的 before()，這條約束自然成立。
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer } from '../../../src/shells/standalone/server';
import { connect } from '../../helpers/ws.js';

const PORT = 3999;
// 寫入類用例不能碰 sample-novel（tests/contract/sampleNovel.test.js 對它有 hash
// 斷言），另開臨時工程。
const EDIT_PORT = 3998;
/** 空視窗必須排在 3999/3998 之後：initHost 是程序單例。 */
const EMPTY_PORT = 3997;
/** 多視窗排在最後，理由同上。 */
const MULTI_PORT = 3996;
/** 令牌鑑權再排在多視窗之後，理由同上。 */
const AUTH_PORT = 3995;
const root = path.join(import.meta.dir, '..', '..', '..', 'sample-novel');
const base = `http://127.0.0.1:${PORT}`;

const nameOf = (list) => list.map((e) => e.name);

let conn;
const e2eWindowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-win-'));

before(async () => {
  await startServer({ root, port: PORT, windowDir: e2eWindowDir });
  conn = connect(PORT);
  await conn.ready;
});

// ---------------------------------------------------------------------------

describe('靜態資源', () => {
  const assets = ['view.js', 'bridge.js', 'editor.js', 'explorer.js', 'view.css', 'standalone.css'];
  let html;
  const status = {};

  before(async () => {
    html = await (await fetch(`${base}/`)).text();
    for (const asset of assets) {
      status[asset] = (await fetch(`${base}/media/${asset}`)).status;
    }
  });

  test('首頁含 view.js', () => {
    assert.ok(html.includes('view.js'));
  });

  test('首頁含 editor.js', () => {
    assert.ok(html.includes('editor.js'));
  });

  test('首頁含 explorer.js', () => {
    assert.ok(html.includes('explorer.js'));
  });

  test('首頁含 standalone.css', () => {
    assert.ok(html.includes('standalone.css'));
  });

  test('首頁含編輯器容器', () => {
    assert.ok(html.includes('id="wbEditor"'));
  });

  test('首頁含資源管理器容器', () => {
    assert.ok(html.includes('id="filesBody"'));
  });

  test('首頁標題是產品名', () => {
    assert.ok(html.includes('<title>Novelwarden</title>'), html.slice(0, 800));
  });

  // 「關於」裡的版本號是編譯時寫進資源表的那一份，不是執行時去找 package.json
  // （單檔案可執行旁邊沒有它，從前裝出來一律是 0.0.0）。
  test('「關於」的版本號是 package.json 的', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'));
    assert.ok(html.includes(`data-version="${version}"`), html.slice(0, 800));
  });

  for (const asset of assets) {
    test(`${asset} 可取`, () => {
      assert.equal(status[asset], 200);
    });
  }
});

// ---------------------------------------------------------------------------

describe('WebSocket 與 Origin 校驗', () => {
  let first;
  let index;
  let bad;
  let good;

  before(async () => {
    first = await conn.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');
    index = await conn.waitFor((m) => m.type === 'chapterIndex', 'chapterIndex');
    // 瀏覽器發得出跨源 WS 請求，所以 Origin 必須在服務端擋。
    bad = await fetch(`${base}/ws`, {
      headers: { origin: 'http://evil.example.com', upgrade: 'websocket', connection: 'Upgrade' },
    });
    good = await fetch(`${base}/ws`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  });

  test('首條訊息是 init/state', () => {
    assert.ok(first.type === 'init' || first.type === 'state', first.type);
  });

  // 內建編輯器的回車、標題欄「段落格式」的勾在哪個頁籤都要用，所以分段格式隨 state 推（工程樹只在工程頁籤推）。
  test('state 帶分段格式，config.md 沒寫時是 blank', () => {
    assert.equal(first.state.paragraphStyle, 'blank');
  });

  // 內建編輯器的章節條與上一章 / 下一章：連上就有，不等作者切到工程頁（工程樹只在那一頁推）。
  test('連上就推章節索引：一章一行、按章號升序，正文與細綱的路徑都在', () => {
    // 示例工程第 5–10 章是隻有梗概的空殼（大綱排到了第 10 章，大綱是各章細綱梗概的彙總）。
    assert.deepEqual(index.chapters.map((c) => c.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const [ch1, , , ch4] = index.chapters;
    assert.deepEqual([ch1.chapterPath, ch1.plotPath, ch1.plotExists], ['chapters/001-楔子.md', '.novelwarden/summaries/001-楔子.md', true]);
    // 第 4 章只排了細綱：沒有正文，主路徑是細綱。
    assert.deepEqual([ch4.chapterPath, ch4.relPath], ['', '.novelwarden/summaries/004-空匣.md']);
  });

  test('跨源 Origin 被拒 403', () => {
    assert.equal(bad.status, 403);
  });

  test('同源 Origin 不被 403', () => {
    assert.notEqual(good.status, 403);
  });
});

// ---------------------------------------------------------------------------

describe('MCP：外部 agent 的入口', () => {
  const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  const mcpPost = (body, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  let init;
  let sid;
  let tools;
  let read;
  let evil;

  before(async () => {
    const res = await mcpPost(rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e' } }));
    sid = res.headers.get('mcp-session-id');
    init = await res.json();
    tools = await (await mcpPost(rpc(2, 'tools/list'), { 'mcp-session-id': sid })).json();
    // tools/call 回 SSE：取其中的回覆，跳過進度通知。
    const sse = await (
      await mcpPost(rpc(3, 'tools/call', { name: 'list', arguments: { path: '.novelwarden' } }), { 'mcp-session-id': sid })
    ).text();
    read = sse
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)))
      .find((m) => m.method === undefined);
    evil = await mcpPost(rpc(4, 'ping'), { origin: 'http://evil.example.com' });
  });

  test('initialize 回會話 id 與版本', () => {
    assert.ok(sid);
    assert.equal(init.result.protocolVersion, '2025-06-18');
  });

  test('列得出十三個工具', () => {
    assert.equal(tools.result.tools.length, 13);
  });

  test('只讀呼叫落到當前開啟的工程上，附帶狀態簡報', () => {
    assert.equal(read.result.isError, false, read.result.content[0].text);
    assert.ok(read.result.content[0].text.includes('# 當前工程'), read.result.content[0].text);
  });

  test('跨源請求 403', () => {
    assert.equal(evil.status, 403);
  });
});

// ---------------------------------------------------------------------------

describe('內建編輯器：只讀用例', () => {
  let opened;
  let escaped;
  let json;
  let preview;

  before(async () => {
    // 取正文：示例工程寫到第 3 章，正文在 `chapters/` 裡。
    conn.send({ type: 'openEditor', path: 'chapters/001-楔子.md' });
    opened = await conn.waitFor((m) => m.type === 'editorOpen', 'editorOpen');

    // 單擊開啟（臨時標籤）與「原位換掉」的標記：後端不看，原樣帶回。
    conn.send({ type: 'openEditor', path: '.novelwarden/summaries/001-楔子.md', pane: 'draft', preview: true, replace: 'x.md' });
    preview = await conn.waitFor((m) => m.type === 'editorOpen', 'preview editorOpen');

    conn.send({ type: 'openEditor', path: '../../../package.json' });
    escaped = await conn.waitFor((m) => m.type === 'editorError', '越界 editorError');

    conn.send({ type: 'openEditor', path: '.novelwarden/project.json' });
    json = await conn.waitFor((m) => m.type === 'editorOpen', 'json editorOpen');
  });

  test('開啟正文返回內容', () => {
    assert.ok(opened.file.text.length > 0);
  });

  test('帶 hash 基線', () => {
    assert.ok(typeof opened.file.hash === 'string' && opened.file.hash.length > 0);
  });

  test('path 用正斜槓', () => {
    assert.ok(!opened.file.path.includes('\\'), opened.file.path);
  });

  test('越界路徑被拒', () => {
    assert.ok(escaped.message.includes('超出工程目錄'), escaped.message);
  });

  test('工程內 json 可開啟', () => {
    assert.equal(json.file.name, 'project.json');
  });

  test('帶稱呼：正文不帶短標記、麵包屑寫第幾章', () => {
    assert.deepEqual(opened.file.label, {
      tag: '',
      title: '001-楔子',
      crumbs: [{ label: '正文', dir: 'chapters' }, { label: '第 1 章 楔子' }],
    });
  });

  test('開啟請求上的 preview / replace 原樣帶回，細綱帶「細綱」', () => {
    assert.deepEqual([preview.pane, preview.preview, preview.replace], ['draft', true, 'x.md']);
    assert.equal(preview.file.label.tag, '細綱');
  });

  test('認不出的檔案：稱呼是原檔名，副檔名留著', () => {
    assert.equal(json.file.label.title, 'project.json');
  });
});

// ---------------------------------------------------------------------------

describe('資源管理器：目錄列舉', () => {
  let rootEntries;
  let multi;
  let chapters;
  let outside;
  let gone;

  before(async () => {
    conn.send({ type: 'listDir', dirs: [''] });
    const rootList = await conn.waitFor((m) => m.type === 'dirListings', 'dirListings');
    rootEntries = rootList.listings.find((l) => l.relPath === '').entries;

    // 一次多個目錄：前端展開好幾層時不該來回好幾趟。
    conn.send({ type: 'listDir', dirs: ['', 'chapters', '.novelwarden'] });
    multi = await conn.waitFor((m) => m.type === 'dirListings' && m.listings.length === 3, '多目錄 dirListings');
    chapters = multi.listings.find((l) => l.relPath === 'chapters');

    // 越界不能靠前端自覺：路徑是前端傳上來的。
    conn.send({ type: 'listDir', dirs: ['../..'] });
    outside = await conn.waitFor(
      (m) => m.type === 'dirListings' && m.listings[0].relPath === '../..',
      '越界 dirListings'
    );

    // 不存在的目錄降級成 error，不讓常駐側欄跟著炸。
    conn.send({ type: 'listDir', dirs: ['沒有這個目錄'] });
    gone = await conn.waitFor(
      (m) => m.type === 'dirListings' && m.listings[0].relPath === '沒有這個目錄',
      '缺目錄 dirListings'
    );
  });

  // 這一條是「檔案」頁存在的理由：工程頁永遠看不見 .novelwarden。
  test('列出點開頭的目錄', () => {
    assert.ok(nameOf(rootEntries).includes('.novelwarden'), nameOf(rootEntries).join(','));
  });

  test('列出章節目錄', () => {
    assert.ok(nameOf(rootEntries).includes('chapters'), nameOf(rootEntries).join(','));
  });

  test('目錄排在檔案之前', () => {
    assert.ok(
      rootEntries.findIndex((e) => e.kind === 'file') > rootEntries.findLastIndex((e) => e.kind === 'dir'),
      nameOf(rootEntries).join(',')
    );
  });

  test('目錄不標 editable', () => {
    assert.ok(rootEntries.every((e) => e.kind !== 'dir' || e.editable === false));
  });

  test('.md 標為可編輯', () => {
    assert.ok(rootEntries.filter((e) => e.name.endsWith('.md')).every((e) => e.editable === true));
  });

  test('一次返回三個目錄', () => {
    assert.equal(multi.listings.length, 3);
  });

  test('章節目錄列得出檔案', () => {
    assert.ok(chapters.entries.some((e) => e.name.endsWith('.md')), nameOf(chapters.entries).join(','));
  });

  test('子項 relPath 帶父目錄', () => {
    assert.ok(
      chapters.entries.every((e) => e.relPath.startsWith('chapters/')),
      nameOf(chapters.entries).join(',')
    );
  });

  test('越界目錄被拒', () => {
    assert.ok(!!outside.listings[0].error, JSON.stringify(outside.listings[0]));
  });

  test('越界不返回任何條目', () => {
    assert.equal(outside.listings[0].entries.length, 0);
  });

  test('不存在的目錄給出人話原因', () => {
    assert.ok(gone.listings[0].error.includes('目錄不存在'), gone.listings[0].error);
  });
});

// ---------------------------------------------------------------------------

// 這條跑的是**真控制器 + 真傳輸**：前端只知道「我點了第 3 章」，落在哪一層
// 由後端算。判定本身另有一組更細的用例（tests/integration/features/selectPlot.test.js
// 覆蓋三種路徑形狀），這裡守的是它經 WS 走一遭之後還對。
describe('確認框：一個 action 一顆按鈕，調模型之前那一問帶兩個下拉框', () => {
  let scope;
  let call;

  // 按目錄整理設定：先問整理範圍（兩顆按鈕），再問調模型（`confirmCall`）。sample-novel 的兩條設定都在根目錄（未分類）。
  // 點第二顆按鈕：從前網頁彈窗只認第一顆，這一步就走不下去。最後取消，不調模型、不寫盤。
  before(async () => {
    conn.drain();
    conn.send({ type: 'projectAction', action: 'organizeLore' });
    scope = await conn.waitFor((m) => m.type === 'prompt' && m.kind === 'confirm', '整理範圍');
    conn.send({ type: 'promptResult', requestId: scope.requestId, value: scope.actions[1] });
    call = await conn.waitFor((m) => m.type === 'prompt' && m.kind === 'confirm' && m.call, '調模型之前那一問');
    conn.send({ type: 'promptResult', requestId: call.requestId });
    // 工程頁動作收尾時推一輪狀態（流水線在最後）：等它推完，免得落進下一節的 waitFor。
    await conn.waitFor((m) => m.type === 'pipeline', '整理取消之後的狀態');
  });

  test('普通確認框帶上全部按鈕', () => {
    assert.deepEqual(scope.actions, ['只整理未分類的 2 條', '全部 2 條都看一遍']);
    assert.equal(scope.call, undefined);
  });

  test('點第二顆按鈕也走得下去：接著問調模型', () => {
    assert.ok(call.message.startsWith('整理 2 條設定'), call.message);
    assert.deepEqual(call.actions, ['開始']);
  });

  test('調模型那一問：預設按分檔，列出分檔那一行；整理不看詳細度，沒有那個下拉框', () => {
    assert.equal(call.call.model, '');
    assert.ok(Array.isArray(call.call.models));
    assert.equal(call.call.tiers.length, 1);
    assert.ok(call.call.tiers[0].startsWith('設定 · 建條目與整合'), call.call.tiers[0]);
    assert.equal(call.call.contextDetail, undefined);
  });
});

describe('選中一章 → 狀態機決定落在哪一層', () => {
  let session;
  let pipe;
  let outlinePipe;
  let toasted;

  before(async () => {
    // 連上時後端推過一輪全量狀態，裡面就有一條 session。不清掉的話
    // 下面的 waitFor 會立刻拿到那條舊的，而不是這次切目標的結果。
    conn.drain();
    conn.send({ type: 'selectPlot', plotRelPath: '.novelwarden/summaries/003-夜访.md' });
    session = await conn.waitFor((m) => m.type === 'session', 'session');
    pipe = await conn.waitFor((m) => m.type === 'pipeline', 'pipeline');

    // 全書大綱層沒有「這一段的三層」，但一樣要有工作區卡與下一步。
    conn.send({ type: 'setTarget', target: { kind: 'outline' } });
    await conn.waitFor((m) => m.type === 'session', 'session（大綱）');
    outlinePipe = await conn.waitFor((m) => m.type === 'pipeline', 'pipeline（大綱）');

    // 段剛被改名/刪掉時不能讓整條推送失敗。
    conn.send({ type: 'selectPlot', plotRelPath: '.novelwarden/summaries/不存在.md' });
    toasted = await conn.waitFor((m) => m.type === 'toast', 'toast');
  });

  // sample-novel 的三章都寫完、也定稿過了 → 狀態機說「已完成」，這一章沒有
  // 下一步，於是落在**正文層**：那是這一章的終點，也是最可能回頭改的一層
  // （見 selectPlot 尾部那行）。
  //
  // 這條從前斷言的是 `plot`，而那是個 bug 的回聲：`selectPlot` 把一份 `Plot`
  // 直接餵給了收 `{no, plot, chapter}` 的 `buildPlotPipeline`——`Plot` 恰好也有
  // `no`，另外兩個欄位又是可選的，於是**型別檢查過得去**，而 plot/chapter 全是
  // undefined。每一章都按空事實推導，狀態機於是永遠答「待寫細綱」。四層流水線
  // 在這個入口上等於不存在，而這正是 selectPlot 存在的理由。
  test('落到狀態機算出的那一層', () => {
    assert.equal(session.session.stage, 'manuscript');
  });

  // 切層一律把能力重置成 discuss：**預設動作不該是花錢產出一份要不要都不
  // 知道的產物**（DEFAULT_CAPABILITY）。要跑哪一步由下面那個 next 推薦，
  // 作者點主按鈕才執行。
  test('切層不預置花錢的能力', () => {
    assert.equal(session.session.capability, 'discuss', session.session.capability);
  });

  test('目標指向那一段', () => {
    assert.equal(session.session.target.plotRelPath, '.novelwarden/summaries/003-夜访.md');
  });

  test('推來流水線', () => {
    assert.equal(pipe.pipeline?.no, 3);
  });

  test('推來工作區卡', () => {
    assert.ok(!!pipe.workbench, JSON.stringify(pipe.workbench));
  });

  test('工作區卡攤開這一層的產物', () => {
    assert.ok(pipe.workbench.sections.length > 0 || !!pipe.workbench.empty,
      JSON.stringify(pipe.workbench));
  });

  // **這一章做完了就轉去問全書**：從前做完就沉默，作者得自己去找下一章。
  // sample-novel 寫到第 3 章，第 4 章《空匣》的細綱已經排好（計劃，還沒有正文），
  // 於是全書的下一步落到第 4 章的單章狀態機上：主按鈕是「寫第 4 章」，落點是那份細綱。
  test('已完成的章，下一步轉到全書的下一步', () => {
    assert.equal(pipe.next?.label, '寫第 4 章', JSON.stringify(pipe.next));
  });

  test('全書的下一步落在第 4 章的細綱上', () => {
    assert.equal(pipe.next?.target?.plotRelPath, '.novelwarden/summaries/004-空匣.md', JSON.stringify(pipe.next));
  });

  // 寫正文那一步按的是單章，不是一段區間。
  test('寫正文這一步不帶區間', () => {
    assert.equal(pipe.next?.range, undefined, JSON.stringify(pipe.next));
  });

  test('已完成的章徽章是已完成', () => {
    assert.equal(pipe.pipeline?.stage, 'done', JSON.stringify(pipe.pipeline?.stage));
  });

  test('大綱層不帶單章流水線', () => {
    assert.equal(outlinePipe.pipeline, undefined);
  });

  test('大綱層仍有工作區卡', () => {
    assert.equal(outlinePipe.workbench?.stage, 'outline');
  });

  test('選不存在的段給提示而非崩', () => {
    assert.equal(toasted.level, 'error', JSON.stringify(toasted));
  });
});

// ---------------------------------------------------------------------------

// 從這裡起換到臨時工程（3998）：寫入類用例一個位元組都不能落到 sample-novel 上。
// startServer 裡的 initHost 是單例，所以 3999 的用例必須已經全部跑完。
describe('臨時工程（寫入類用例）', () => {
  const rel = 'chapters/001-測試.md';
  let work;
  let edit;
  let f1;

  before(async () => {
    conn.ws.close();

    work = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-server-'));
    fs.mkdirSync(path.join(work, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(work, rel), '# 測試\n\n初始內容。\n', 'utf8');
    await startServer({ root: work, port: EDIT_PORT, windowDir: e2eWindowDir });

    edit = connect(EDIT_PORT);
    await edit.ready;
    await edit.waitFor((m) => m.type === 'init' || m.type === 'state', 'init');

    edit.send({ type: 'openEditor', path: rel });
    f1 = await edit.waitFor((m) => m.type === 'editorOpen', 'editorOpen');
  });

  after(() => {
    edit?.ws.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  describe('內建編輯器：讀寫往返', () => {
    let saved;
    let conflict;
    let diskAfterSave;
    let diskAfterConflict;
    let diskAfterForce;
    let badSave;
    let escapeCreated;
    let badExt;
    let bare;

    before(async () => {
      edit.send({ type: 'saveFile', path: rel, text: '# 測試\n\n改過的內容。\n', baseHash: f1.file.hash });
      saved = await edit.waitFor((m) => m.type === 'editorSaved', 'editorSaved');
      diskAfterSave = fs.readFileSync(path.join(work, rel), 'utf8');

      // 用過期的 baseHash 再存一次，模擬「檔案已被別處改過」。
      edit.send({ type: 'saveFile', path: rel, text: '# 測試\n\n第三版。\n', baseHash: f1.file.hash });
      conflict = await edit.waitFor((m) => m.type === 'editorConflict', 'editorConflict');
      diskAfterConflict = fs.readFileSync(path.join(work, rel), 'utf8');

      // 使用者明確選擇強制覆蓋：不帶 baseHash。
      edit.send({ type: 'saveFile', path: rel, text: '# 測試\n\n第三版。\n' });
      await edit.waitFor((m) => m.type === 'editorSaved', '強制儲存 editorSaved');
      diskAfterForce = fs.readFileSync(path.join(work, rel), 'utf8');

      edit.send({ type: 'saveFile', path: '../escape.md', text: 'x' });
      badSave = await edit.waitFor((m) => m.type === 'editorError', '越界儲存 editorError');
      escapeCreated = fs.existsSync(path.join(path.dirname(work), 'escape.md'));

      edit.send({ type: 'openEditor', path: 'chapters/nope.png' });
      badExt = await edit.waitFor((m) => m.type === 'editorError', '副檔名 editorError');

      // 章節可以沒有副檔名——白名單擋不住它，章節判定規則得放它過去。
      fs.writeFileSync(path.join(work, 'chapters/002-無副檔名'), '沒有副檔名的一章。\n', 'utf8');
      edit.send({ type: 'openEditor', path: 'chapters/002-無副檔名' });
      bare = await edit.waitFor((m) => m.type === 'editorOpen', '無副檔名 editorOpen');
    });

    test('儲存落盤', () => {
      assert.ok(diskAfterSave.includes('改過的內容'));
    });

    test('回傳新 hash', () => {
      assert.notEqual(saved.file.hash, f1.file.hash);
    });

    test('過期基線觸發衝突', () => {
      assert.equal(conflict.path, rel);
    });

    test('衝突時不覆蓋磁碟', () => {
      assert.ok(diskAfterConflict.includes('改過的內容'));
    });

    test('衝突帶回磁碟版本', () => {
      assert.ok(conflict.diskText.includes('改過的內容'));
    });

    test('強制儲存生效', () => {
      assert.ok(diskAfterForce.includes('第三版'));
    });

    test('越界儲存被拒', () => {
      assert.ok(badSave.message.includes('超出工程目錄'), badSave.message);
    });

    test('越界檔案未建立', () => {
      assert.ok(!escapeCreated);
    });

    test('非文字副檔名被拒', () => {
      assert.ok(badExt.message.includes('不是可編輯的文字檔案'), badExt.message);
    });

    test('無副檔名的章節可開啟', () => {
      assert.ok(bare.file.text.includes('沒有副檔名的一章'), bare.file.text);
    });

    test('無副檔名章節也帶 draftPath', () => {
      assert.equal(bare.file.draftPath, 'drafts/002-無副檔名');
    });
  });

  describe('章節草稿', () => {
    let draft;
    let draftOnDisk;
    let draft2;
    let missing;
    let phantomDraft;

    before(async () => {
      edit.send({ type: 'openDraft', path: rel });
      draft = await edit.waitFor(
        (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/'),
        'draft editorOpen'
      );
      draftOnDisk = fs.existsSync(path.join(work, 'drafts/001-測試.md'));

      // 作者在草稿裡寫了東西，再點一次不能被抹掉。
      fs.writeFileSync(path.join(work, 'drafts/001-測試.md'), '# 測試 · 草稿\n\n手寫的內容。\n', 'utf8');
      edit.send({ type: 'openDraft', path: rel });
      draft2 = await edit.waitFor(
        (m) => m.type === 'editorOpen' && m.file.path.startsWith('drafts/') && m.file.text.includes('手寫'),
        '第二次 draft editorOpen'
      );

      edit.send({ type: 'openDraft', path: 'chapters/不存在.md' });
      missing = await edit.waitFor((m) => m.type === 'toast' && m.level === 'error', '缺章 toast');
      phantomDraft = fs.existsSync(path.join(work, 'drafts/不存在.md'));
    });

    test('正文帶 draftPath', () => {
      assert.equal(f1.file.draftPath, 'drafts/001-測試.md');
    });

    test('草稿開在第二塊編輯區', () => {
      assert.equal(draft.pane, 'draft');
    });

    test('草稿路徑映象章節', () => {
      assert.equal(draft.file.path, 'drafts/001-測試.md');
    });

    test('草稿已落盤', () => {
      assert.ok(draftOnDisk);
    });

    test('markdown 草稿帶模板頭', () => {
      assert.ok(draft.file.text.startsWith('# 測試 · 草稿'), draft.file.text);
    });

    test('草稿自己不再有 draftPath', () => {
      assert.equal(draft.file.draftPath, undefined);
    });

    test('第二次開啟不覆蓋草稿', () => {
      assert.ok(draft2.file.text.includes('手寫的內容'), draft2.file.text);
    });

    test('對不存在的章節報錯而非建檔案', () => {
      assert.ok(missing.message.includes('找不到這一章'), missing.message);
    });

    test('沒有憑空造出草稿', () => {
      assert.ok(!phantomDraft);
    });
  });

  // 不丟稿：核對磁碟（checkEditorFiles → editorDiskChanged / editorDiskGone），以及帶了基線、檔案卻不在時不重建。
  describe('內建編輯器：核對磁碟與「磁碟上沒了」', () => {
    const gone = 'chapters/007-被刪了.md';
    let changed;
    let staleHash;
    let echoedChange;
    let goneReply;
    let saveGone;
    let createdByGoneSave;
    let recreated;
    let recreatedOnDisk;
    let selfCheckChanged;

    before(async () => {
      // 外部改了這一章（外部編輯器 / agent 的 edit）：拿編輯器手裡的舊 hash 來核對。
      fs.writeFileSync(path.join(work, rel), '# 測試\n\n外部改過的。\n', 'utf8');
      edit.drain();
      staleHash = f1.file.hash;
      edit.send({ type: 'checkEditorFiles', files: [{ path: rel, hash: staleHash }] });
      changed = await edit.waitFor((m) => m.type === 'editorDiskChanged' && m.file.path === rel, 'editorDiskChanged');

      // 拿新 hash 再核對一次，捎帶一份不存在的當哨兵：後端先推「變了」再推「沒了」，等到哨兵時沒有「變了」就是沒有。
      edit.drain();
      edit.send({
        type: 'checkEditorFiles',
        files: [{ path: rel, hash: changed.file.hash }, { path: gone, hash: 'h-gone' }],
      });
      goneReply = await edit.waitFor((m) => m.type === 'editorDiskGone' && m.path === gone, 'editorDiskGone');
      echoedChange = edit.has((m) => m.type === 'editorDiskChanged' && m.file.path === rel);

      // 帶著基線儲存一份已經不在的檔案：不重建。
      edit.drain();
      edit.send({ type: 'saveFile', path: gone, text: '編輯器裡的內容', baseHash: 'h-gone' });
      saveGone = await edit.waitFor((m) => m.type === 'editorDiskGone' && m.path === gone, '儲存時 editorDiskGone');
      createdByGoneSave = fs.existsSync(path.join(work, gone));

      // 作者答應了：帶 recreate 再來。
      edit.send({ type: 'saveFile', path: gone, text: '編輯器裡的內容', baseHash: 'h-gone', recreate: true });
      recreated = await edit.waitFor((m) => m.type === 'editorSaved' && m.file.path === gone, '重建 editorSaved');
      recreatedOnDisk = fs.readFileSync(path.join(work, gone), 'utf8');

      // 編輯器自己存了之後：等 state 到了再拿回執裡的 hash 核對，不報「變了」。
      edit.drain();
      edit.send({ type: 'saveFile', path: rel, text: '# 測試\n\n編輯器存的。\n', baseHash: changed.file.hash });
      const saved = await edit.waitFor((m) => m.type === 'editorSaved' && m.file.path === rel, '自己儲存 editorSaved');
      await edit.waitFor((m) => m.type === 'state', '儲存之後的 state');
      edit.send({
        type: 'checkEditorFiles',
        files: [{ path: rel, hash: saved.file.hash }, { path: 'chapters/008-哨兵.md', hash: 'h' }],
      });
      await edit.waitFor((m) => m.type === 'editorDiskGone' && m.path === 'chapters/008-哨兵.md', '哨兵 editorDiskGone');
      selfCheckChanged = edit.has((m) => m.type === 'editorDiskChanged' && m.file.path === rel);
    });

    test('hash 對不上：推磁碟上的新版', () => {
      assert.ok(changed.file.text.includes('外部改過的'), changed.file.text);
      assert.notEqual(changed.file.hash, staleHash);
    });

    test('新版帶 draftPath 與 kind', () => {
      assert.equal(changed.file.kind, 'chapter');
      assert.equal(changed.file.draftPath, 'drafts/001-測試.md');
    });

    test('hash 對得上：不推', () => {
      assert.equal(echoedChange, false);
    });

    test('讀不到：推磁碟上沒了', () => {
      assert.equal(goneReply.path, gone);
    });

    test('帶了基線、檔案卻不在：儲存回「沒了」', () => {
      assert.equal(saveGone.type, 'editorDiskGone');
    });

    test('沒有靜默在原路徑重建', () => {
      assert.equal(createdByGoneSave, false);
    });

    test('答應重建之後才寫下去', () => {
      assert.equal(recreated.file.text, '編輯器裡的內容');
      assert.equal(recreatedOnDisk, '編輯器裡的內容');
    });

    test('自己儲存之後核對不誤報', () => {
      assert.equal(selfCheckChanged, false);
    });
  });

  // 全書查詢替換的主路徑：查詢 → 預覽 → 替換（經閘道器、帶預覽時的 hash、先存一版歷史）→ 歷史裡找得回替換前那一版。
  // 放在這一節最後：要建 .novelwarden/（小說工程才存歷史版本），別影響前面那幾節。
  describe('全書查詢替換：查詢 → 預覽 → 替換 → 歷史裡找得回', () => {
    const target = 'chapters/003-全書.md';
    const original = '# 全書\n\n林晚推開門。林晚沒有說話。\n';
    let found;
    let preview;
    let done;
    let stateAfter;
    let disk;
    let versions;
    let old;

    before(async () => {
      fs.mkdirSync(path.join(work, '.novelwarden'), { recursive: true });
      // 經編輯器存下這一章（閘道器新建、pushState 讓章節列表的快取失效），與作者在編輯器裡新建一章同一條路。
      edit.drain();
      edit.send({ type: 'saveFile', path: target, text: original });
      await edit.waitFor((m) => m.type === 'editorSaved' && m.file.path === target, '新建 editorSaved');
      await edit.waitFor((m) => m.type === 'state', '新建之後的 state');

      edit.send({ type: 'bookFind', requestId: 'e2e-bf-1', query: { query: '林晚', scopes: ['chapter'] } });
      found = await edit.waitFor((m) => m.type === 'bookFindResult' && m.requestId === 'e2e-bf-1', '查詢 bookFindResult');

      edit.send({ type: 'bookFind', requestId: 'e2e-bf-2', query: { query: '林晚', scopes: ['chapter'], replacement: '林婉' } });
      preview = await edit.waitFor((m) => m.type === 'bookFindResult' && m.requestId === 'e2e-bf-2', '預覽 bookFindResult');

      const file = preview.result.files.find((f) => f.path === target);
      edit.drain();
      edit.send({
        type: 'bookReplace',
        requestId: 'e2e-br-1',
        request: {
          query: '林晚',
          replacement: '林婉',
          scopes: ['chapter'],
          dirty: [],
          // 只勾第一處。
          files: [{ path: file.path, hash: file.hash, hits: [{ start: file.hits[0].start, end: file.hits[0].end }] }],
        },
      });
      done = await edit.waitFor((m) => m.type === 'bookReplaceDone' && m.requestId === 'e2e-br-1', 'bookReplaceDone');
      stateAfter = await edit.waitFor((m) => m.type === 'state', '替換之後的 state');
      disk = fs.readFileSync(path.join(work, target), 'utf8');

      edit.send({ type: 'listVersions', path: target });
      versions = await edit.waitFor((m) => m.type === 'versions' && m.path === target, 'versions');
      edit.send({ type: 'readVersion', path: target, id: versions.entries[0]?.id ?? '', requestId: 'e2e-rv-1' });
      old = await edit.waitFor((m) => m.type === 'versionText' && m.requestId === 'e2e-rv-1', 'versionText');
    });

    test('查詢：按檔案列出、帶稱呼與每一處的上下文', () => {
      const file = found.result.files.find((f) => f.path === target);
      assert.ok(file, JSON.stringify(found.result.files.map((f) => f.path)));
      assert.equal(file.label, '第 3 章 全書');
      assert.equal(file.count, 2);
      assert.deepEqual([file.hits[0].line, file.hits[0].text, file.hits[0].after], [3, '林晚', '推開門。林晚沒有說話。']);
    });

    test('預覽：每一處帶換成什麼', () => {
      const file = preview.result.files.find((f) => f.path === target);
      assert.deepEqual(file.hits.map((h) => h.replacement), ['林婉', '林婉']);
    });

    test('替換：只換勾著的那一處，彙總說清幾個檔案幾處', () => {
      assert.equal(done.summary.files, 1);
      assert.equal(done.summary.hits, 1);
      assert.equal(disk, '# 全書\n\n林婉推開門。林晚沒有說話。\n');
    });

    test('替換之後推 state（編輯器據此核對已開的標籤）', () => {
      assert.equal(stateAfter.type, 'state');
    });

    test('歷史裡找得回替換前那一版', () => {
      assert.ok(versions.entries.length > 0, JSON.stringify(versions));
      assert.equal(old.text, original);
    });
  });
});

// ---------------------------------------------------------------------------

// 空視窗必須放在 3999/3998 都跑完之後：startServer 的 initHost 是單例。
// 不傳 root，並用獨立的 windowDir，避免撿到前面兩節寫進 window.json 的 lastOpen。
describe('空視窗', () => {
  let empty;
  let firstWorkspaces;
  let sawInitBeforeOpen;
  let hostListing;
  let opened;
  let openedInit;
  let addToast;
  let afterAdd;
  let closed;
  let extraDir;

  before(async () => {
    const emptyWin = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-empty-'));
    extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-extra-'));
    await startServer({ port: EMPTY_PORT, windowDir: emptyWin });
    empty = connect(EMPTY_PORT);
    await empty.ready;

    firstWorkspaces = await empty.waitFor((m) => m.type === 'workspaces', 'empty workspaces');
    await empty.waitFor((m) => m.type === 'settings', 'empty settings');
    sawInitBeforeOpen = empty.has((m) => m.type === 'init');

    empty.send({ type: 'listHostDir', path: os.homedir() });
    hostListing = await empty.waitFor((m) => m.type === 'hostDir', 'hostDir');

    empty.drain();
    empty.send({ type: 'openFolder', path: root });
    opened = await empty.waitFor((m) => m.type === 'workspaces' && m.currentId, 'opened workspaces');
    openedInit = await empty.waitFor((m) => m.type === 'init' || m.type === 'state', 'init after open');

    empty.drain();
    empty.send({ type: 'openFolder', path: extraDir, mode: 'add' });
    addToast = await empty.waitFor((m) => m.type === 'toast' && m.level === 'error', 'add toast');
    empty.send({ type: 'ready' });
    afterAdd = await empty.waitFor((m) => m.type === 'workspaces', 'workspaces after add');

    empty.drain();
    empty.send({ type: 'closeFolder' });
    closed = await empty.waitFor(
      (m) => m.type === 'workspaces' && m.currentId === null,
      'closed workspaces'
    );
  });

  after(() => {
    empty?.ws.close();
    if (extraDir) {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test('ready 後 currentId 為空', () => {
    assert.equal(firstWorkspaces.currentId, null);
    assert.deepEqual(firstWorkspaces.items, []);
    assert.ok(Array.isArray(firstWorkspaces.recents));
  });

  test('繫結前沒有假 init', () => {
    assert.equal(sawInitBeforeOpen, false);
  });

  test('listHostDir 回一層目錄、條目沒有正文', () => {
    assert.ok(Array.isArray(hostListing.entries));
    assert.ok(hostListing.entries.every((e) => !('text' in e) && !('content' in e)));
  });

  test('openFolder 後 currentId 非空且有 init', () => {
    assert.ok(opened.currentId);
    assert.equal(opened.items.length, 1);
    assert.ok(openedInit.type === 'init' || openedInit.type === 'state', openedInit.type);
  });

  test('mode add 不換成第二份工作區', () => {
    assert.ok(addToast.message.includes('一個工程'), addToast.message);
    assert.equal(afterAdd.items.length, 1);
    assert.equal(afterAdd.currentId, opened.currentId);
  });

  test('closeFolder 後 currentId 為空', () => {
    assert.equal(closed.currentId, null);
    assert.equal(closed.items.length, 0);
  });
});

// ---------------------------------------------------------------------------

// 排在最後：startServer 的 initHost 是單例。
describe('多視窗：每個視窗各開一個工程', () => {
  const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  let other;
  let winA;
  let winB;
  let wsA;
  let wsB;
  let redirect;
  let mcpOther;
  let mcpMissing;
  let toastOnlyB;

  before(async () => {
    const multiWin = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-multi-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-other-'));
    await startServer({ root, port: MULTI_PORT, windowDir: multiWin });

    redirect = await fetch(`http://127.0.0.1:${MULTI_PORT}/`, { redirect: 'manual' });

    winA = connect(MULTI_PORT);
    await winA.ready;
    wsA = await winA.waitFor((m) => m.type === 'workspaces' && m.currentId, 'A workspaces');
    winB = connect(MULTI_PORT, other);
    await winB.ready;
    wsB = await winB.waitFor((m) => m.type === 'workspaces' && m.currentId, 'B workspaces');

    // B 裡出的錯只回 B
    winA.drain();
    winB.send({ type: 'createFile', relPath: '' });
    await winB.waitFor((m) => m.type === 'toast' && m.level === 'error', 'B toast');
    toastOnlyB = !winA.has((m) => m.type === 'toast');

    const mcpAt = async (query) => {
      const res = await fetch(`http://127.0.0.1:${MULTI_PORT}/mcp${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rpc(1, 'tools/call', { name: 'list', arguments: {} })),
      });
      return (await res.json()).result;
    };
    mcpOther = await mcpAt(`?project=${encodeURIComponent(other)}`);
    mcpMissing = await mcpAt(`?project=${encodeURIComponent(path.join(other, 'nope'))}`);
  });

  after(() => {
    winA?.ws.close();
    winB?.ws.close();
  });

  test('不帶工程的首頁跳到最近操作的那個工程', () => {
    assert.equal(redirect.status, 302);
    // 只寫路徑：反代後面 req.url 是 http，寫全了會把 https 的頁面跳回 http（Android 殼當外鏈開瀏覽器）
    const location = redirect.headers.get('location');
    assert.match(location, /^\/\?/);
    assert.ok(new URL(location, 'http://x').searchParams.get('project'));
  });

  test('兩個視窗各是各的工程', () => {
    assert.ok(wsA.currentId);
    assert.ok(wsB.currentId);
    assert.notEqual(wsA.currentId, wsB.currentId);
    assert.equal(wsB.items[0].name, path.basename(other));
  });

  test('一個視窗的提示不出現在另一個視窗', () => {
    assert.ok(toastOnlyB);
  });

  test('MCP 帶 ?project= 落到那個工程', () => {
    assert.equal(mcpOther.isError, false, mcpOther.content[0].text);
  });

  test('MCP 指向沒開著的工程：說出是哪個', () => {
    assert.equal(mcpMissing.isError, true);
    assert.ok(mcpMissing.content[0].text.includes('沒有開啟這個小說工程'), mcpMissing.content[0].text);
  });
});

// ---------------------------------------------------------------------------

// 排在最後：startServer 的 initHost 是單例。仍綁 127.0.0.1——配了令牌就鑑權，與綁在哪無關。
describe('令牌鑑權', () => {
  const TOKEN = 'e2e-token-0123456789abcdef';
  const authBase = `http://127.0.0.1:${AUTH_PORT}`;
  const login = (token, next = '/') =>
    fetch(`${authBase}/login`, {
      method: 'POST',
      body: new URLSearchParams({ token, next }),
      redirect: 'manual',
    });
  const listTools = (headers = {}) =>
    fetch(`${authBase}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  let cookie;
  let win;

  before(async () => {
    const authWin = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-e2e-auth-'));
    await startServer({ root, port: AUTH_PORT, windowDir: authWin, token: TOKEN });
    const ok = await login(TOKEN, '/?from=login');
    cookie = ok.headers.get('set-cookie')?.split(';')[0];
  });

  after(() => {
    win?.ws.close();
  });

  test('沒登入：首頁回 401 登入頁，交完跳回原地址', async () => {
    const res = await fetch(`${authBase}/?project=x`, { redirect: 'manual' });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.ok(html.includes('action="/login"'));
    assert.ok(html.includes('value="/?project=x"'));
  });

  test('靜態資源與 favicon 不設防', async () => {
    assert.equal((await fetch(`${authBase}/media/view.js`)).status, 200);
    assert.equal((await fetch(`${authBase}/favicon.ico`)).status, 200);
  });

  test('令牌錯了：401，不種 cookie', async () => {
    const res = await login('wrong-token');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.ok((await res.text()).includes('令牌不對'));
  });

  test('令牌對了：303 跳回 next，cookie 是 HttpOnly + SameSite=Lax', async () => {
    const res = await login(TOKEN, '/?from=login');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/?from=login');
    const set = res.headers.get('set-cookie');
    assert.ok(set.includes('HttpOnly') && set.includes('SameSite=Lax'), set);
    assert.ok(!set.includes(TOKEN), 'cookie 裡不該有令牌原文');
  });

  test('next 指向外站時跳回首頁', async () => {
    const res = await login(TOKEN, '//evil.com/');
    assert.equal(res.headers.get('location'), '/');
  });

  test('帶 cookie：首頁照常（跳到最近的工程）', async () => {
    const res = await fetch(`${authBase}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    const page = await fetch(new URL(res.headers.get('location'), authBase), { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('/media/view.js'));
  });

  test('WS 不帶 cookie：握手前就回 401', async () => {
    assert.equal((await fetch(`${authBase}/ws`)).status, 401);
  });

  test('WS 帶 cookie：連得上、收得到 init', async () => {
    win = connect(AUTH_PORT, undefined, { cookie });
    await win.ready;
    await win.waitFor((m) => m.type === 'init', 'init');
  });

  test('MCP 不帶令牌 401，帶 Bearer 列得出工具', async () => {
    const denied = await listTools();
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get('www-authenticate')?.startsWith('Bearer'));
    const ok = await listTools({ authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).result.tools.length > 0);
  });
});
