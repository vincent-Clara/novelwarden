/**
 * 三個懸停浮窗：章節細綱、行內副標題（別名）、失敗標記。
 *
 * 章節浮窗原來彈的是單章摘要；摘要並進細綱之後彈的是這一章的細綱——沒定稿的是計劃，
 * 頭上標「計劃」；定稿過、正文後來又改過的標「已過期」（照著哪一種做判斷都比沒有更糟）。
 *
 * 遷自 scripts/smoke-view.js 的這三節（當時叫「章節摘要的懸停浮窗」）：
 *   == 章節摘要的懸停浮窗 ==（1893） == 行內副標題（別名）的懸停浮窗 ==（2170）
 *   == 失敗標記與懸停浮窗 ==（2259）
 *
 * 原指令碼里這三節**必須**待在檔案末尾：浮窗有半秒懸停延遲，只能等真定時器，
 * 於是整塊寫成 `summaryTipTests().then(detailTipTests).then(failureTipTests)`
 * 的 promise 鏈，`process.exit` 掛在鏈尾。那條鏈**沒有 .catch**——任何一步
 * reject 都變成 unhandled rejection 而不是一條失敗用例。改成普通 async test
 * 之後，順序約束與吞異常一併消失。
 *
 * 但等待本身是真的：settle/grace 量的是實現裡的防抖與收起寬限，不是抖動，
 * 所以時長原樣保留。這個檔案大約要跑十幾秒。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('章節細綱的懸停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tip = () => ui.doc.querySelector('.summary-tip');
  // 浮窗只掛在**章節行**上（`.row-plot[data-plot]`）。「故事架構」那幾行復用了
  // `.row-plot` 的樣式，但不帶 data-plot——按 .row-plot 取時要認準章節組。
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-plot[data-plot]')].find((n) => n.textContent.includes(text));
  const archRow = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-architecture')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等過懸停延遲（view.js 裡是 450ms）。 */
  const settle = () => wait(600);
  /** 等過收起的寬限期（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);
  /** 滑鼠進/出浮窗。這兩個事件不冒泡，得直接派到浮窗上。 */
  const enterTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  const leaveTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  /** 移開滑鼠並等過寬限期：懸停到分組標題欄（不是章節行）即可。 */
  const moveAway = async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
  };

  // jsdom 裡所有尺寸都是 0，定位邏輯會全程退化成「貼游標」，量不出東西來。
  // 給浮窗與章節行裝上可控的幾何，才驗得了「不許跑到視窗外面去」。
  const VIEWPORT = { w: 800, h: 600 };
  /** 浮窗的自然高度（不受行內 maxHeight 限制時的高度）。 */
  let tipNaturalHeight = 200;
  /** 目標行在視口裡的位置。 */
  let rowRect = { top: 100, bottom: 120, left: 20 };

  /** 浮窗當前佔據的矩形（按行內樣式算），用來斷言它有沒有跑出視窗。 */
  const tipBox = () => {
    const box = tip();
    const top = parseFloat(box.style.top);
    const left = parseFloat(box.style.left);
    return { top, left, bottom: top + box.offsetHeight, right: left + box.offsetWidth };
  };
  /** 浮窗完整落在視口內（留 8px 邊距，view.js 的 TIP_MARGIN）。 */
  const insideViewport = () => {
    const b = tipBox();
    return b.top >= 0 && b.left >= 0 && b.bottom <= VIEWPORT.h && b.right <= VIEWPORT.w;
  };

  const summaryOf = (extra) =>
    Object.assign(
      {
        no: 1, title: '楔子', label: '第 1 章《楔子》', exists: true, finalized: true, stale: false,
        relPath: '.novelwarden/summaries/001-楔子.md',
        sections: [
          { name: '梗概', text: '雨下了三天，林昭進入青崖鎮。' },
          { name: '關鍵事件', text: '- 以舊牌子代替過所\n- 李叔放行' },
        ],
      },
      extra
    );

  const showTip = async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({ type: 'summary', summary: summaryOf() });
  };

  before(() => {
    ui = mount();
    const isTip = (node) => node.classList && node.classList.contains('summary-tip');
    Object.defineProperty(ui.window, 'innerWidth', { get: () => VIEWPORT.w, configurable: true });
    Object.defineProperty(ui.window, 'innerHeight', { get: () => VIEWPORT.h, configurable: true });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return isTip(this) ? 340 : 0; },
    });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        if (!isTip(this)) return 0;
        // 行內 maxHeight 是 placeSummaryTip 壓上去的，這裡要如實反映它的效果，
        // 否則「壓過高度後再量」那一步測不出來。
        const cap = parseFloat(this.style.maxHeight);
        return Number.isFinite(cap) && cap > 0 ? Math.min(tipNaturalHeight, cap) : tipNaturalHeight;
      },
    });
    ui.window.Element.prototype.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('row-plot')) {
        return {
          top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left,
          right: rowRect.left + 200, width: 200, height: rowRect.bottom - rowRect.top,
        };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };

    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('預設不顯示浮窗', () => {
    assert.ok(!tip());
  });

  // 只有章節行有浮窗，角色行沒有。
  test('角色行不彈浮窗', async () => {
    hover([...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes('林昭')));
    await settle();
    assert.ok(!tip());
  });

  // 架構行與章節行共用 `.row-plot` 的樣式，但它們不是一章，沒有細綱可取。
  // 抓手是 data-plot 而不是類名——漏了這一點，懸停「故事前提」會去要一份不存在的細綱。
  test('故事架構的行不彈細綱浮窗', async () => {
    ui.sent.length = 0;
    hover(archRow('故事前提'));
    await settle();
    assert.ok(!tip());
    assert.ok(!ui.last('requestSummary'), JSON.stringify(ui.sent));
  });

  // ---- 懸停在章節行上
  test('懸停後不立刻彈出（有延遲，免得劃過時閃）', () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    assert.ok(!tip());
  });

  test('延遲未到時不發請求', () => {
    assert.ok(!ui.last('requestSummary'));
  });

  // 游標在行上微動（mouseover 從子元素冒泡上來）不該重置延遲，
  // 否則手一抖浮窗就永遠彈不出來。等一半再抖一下，總時長仍應觸發。
  test('行內微動不重置延遲，浮窗照常彈出', async () => {
    await wait(300);
    hover(rowWith('楔子').querySelector('.row-label'));
    await wait(300);
    assert.ok(tip());
  });

  test('資料沒到時先顯示讀取中', () => {
    assert.ok(tip().textContent.includes('讀取細綱'), tip().textContent);
  });

  test('向後端要這一章的細綱', () => {
    const req = ui.last('requestSummary');
    assert.ok(req, '沒發出 requestSummary');
    // 要的是**路徑**，不是序號：行的身份就是路徑，後端按章號認到同一章的細綱。
    // 這一章有正文，主路徑因此指正文。
    assert.equal(req.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(req));
  });

  test('浮窗掛在 body 上（工程頁有內部滾動，掛在行裡會被裁掉）', () => {
    assert.equal(tip().parentElement, ui.doc.body);
  });

  // ---- 細綱到了
  test('細綱到達後換掉內容', () => {
    ui.post({ type: 'summary', summary: summaryOf() });
    assert.ok(!tip().textContent.includes('讀取細綱'), tip().textContent);
  });

  // 說法由後端給（`PlotSummaryView.label`），前端不按 `no` 自己拼——文案只有一份。
  test('浮窗帶後端給的說法', () => {
    assert.ok(tip().textContent.includes('第 1 章《楔子》'), tip().textContent);
  });

  test('顯示小節名', () => {
    assert.ok(tip().textContent.includes('梗概') && tip().textContent.includes('關鍵事件'), tip().textContent);
  });

  test('顯示小節正文', () => {
    assert.ok(tip().textContent.includes('雨下了三天'), tip().textContent);
  });

  // 定稿過、正文沒再改：這就是那一章寫成的樣子，不必提醒。
  test('定稿過且對得上的細綱不打標', () => {
    assert.ok(!tip().querySelector('.summary-tip-stale'));
  });

  // ---- 滑鼠移到浮窗上：一直留著，能滾、能選中複製
  //
  // 從行挪到浮窗要跨過一道縫，那一兩幀滑鼠既不在行上也不在浮窗上。
  // 所以收起有寬限期，中途進了浮窗就撤銷。
  test('剛移開時浮窗還在（有寬限期，夠滑鼠挪過去）', () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    assert.ok(tip());
  });

  test('滑鼠停在浮窗上就一直顯示', async () => {
    enterTip();
    await grace();
    assert.ok(tip());
  });

  test('停久了也不會自己消失', async () => {
    await grace();
    assert.ok(tip());
  });

  // 浮窗自己內部的滾動不能把它收掉——細綱有七個小節，捲軸是給人用的。
  test('浮窗內部滾動不收起浮窗', () => {
    tip().dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(tip());
  });

  // 移出浮窗才收。
  test('剛離開浮窗時還在（同樣有寬限期）', () => {
    leaveTip();
    assert.ok(tip());
  });

  test('離開浮窗後收起', async () => {
    await grace();
    assert.ok(!tip());
  });

  // ---- 移開就收（沒進浮窗的情況）
  test('再次懸停彈出浮窗', async () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tip());
  });

  test('移到非章節行、且沒進浮窗時收起', async () => {
    await moveAway();
    assert.ok(!tip());
  });

  // 從章節行挪到「故事架構」那幾行：那幾行也帶 `.row-plot`（同一個版式），但沒有
  // data-plot。浮窗只認帶 data-plot 的行，否則會撤銷收起卻不另開一隻——上一章的
  // 浮窗就一直掛著，指著一行滑鼠早已不在的地方。
  test(
    '從章節行挪到架構行時浮窗收起',
    async () => {
      hover(rowWith('楔子'));
      await settle();
      hover(ui.doc.querySelector('#projectBody .group-head'));
      hover(archRow('故事前提'));
      await grace();
      assert.ok(!tip());
      await moveAway();
    }
  );

  // ---- 快取：同一章再懸停不再發請求
  test('命中快取時直接顯示，不再請求', async () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tip() && !ui.last('requestSummary'), JSON.stringify(ui.sent));
  });

  test('快取命中時不經過「讀取中」', () => {
    assert.ok(!tip().textContent.includes('讀取細綱'), tip().textContent);
  });

  // ---- 滾動 / Esc / 右鍵都要收（浮窗是 fixed 的，會和目標行脫節）
  test('滾動收起浮窗', () => {
    ui.doc.getElementById('projectBody').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(!tip());
  });

  test('按 Esc 收起浮窗', async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!tip());
  });

  test('右鍵彈選單時浮窗讓路', async () => {
    hover(rowWith('楔子'));
    await settle();
    rowWith('楔子').dispatchEvent(
      new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 })
    );
    assert.ok(!tip());
    ui.closeMenu();
  });

  // ---- 後端重推樹 = 磁碟變過，快取必須作廢
  test('重推樹後快取作廢、重新請求', async () => {
    ui.post({ type: 'project', tree: sampleTree() });
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(ui.last('requestSummary'), JSON.stringify(ui.sent));
  });

  // ---- 定稿之後正文又改過：細綱可能沒跟上，必須標出來（照著舊檔案做判斷比沒有更糟）
  test('定稿後正文又改過的細綱打標', () => {
    ui.post({ type: 'summary', summary: summaryOf({ stale: true }) });
    assert.ok(tip().querySelector('.summary-tip-stale'));
  });

  test('過期標寫著「已過期」', async () => {
    assert.equal(tip().querySelector('.summary-tip-stale').textContent, '已過期');
    await moveAway();
  });

  // ---- 還沒定稿的細綱是計劃：寫的是這一章打算怎麼走，不一定是正文寫成的樣子
  test('沒定稿的細綱打標', async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({ type: 'summary', summary: summaryOf({ finalized: false }) });
    assert.ok(tip().querySelector('.summary-tip-stale'));
  });

  test('沒定稿的標寫著「計劃」', () => {
    assert.equal(tip().querySelector('.summary-tip-stale').textContent, '計劃');
  });

  test('計劃照樣攤開小節', async () => {
    assert.ok(tip().textContent.includes('雨下了三天'), tip().textContent);
    await moveAway();
  });

  // ---- 還沒有細綱的章：說清楚，不給空浮窗。那句話由後端給（有正文的才指到「定稿」）。
  test('沒有細綱時給出說明而非空白', async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({
      type: 'summary',
      summary: {
        no: 1, title: '楔子', label: '第 1 章《楔子》', exists: false, finalized: false, stale: false,
        relPath: '', sections: [], emptyHint: '這一章還沒有細綱。右鍵「定稿」可以照正文整理一份。',
      },
    });
    assert.ok(tip().textContent.includes('這一章還沒有細綱。右鍵「定稿」可以照正文整理一份。'), tip().textContent);
  });

  test('沒有細綱時不打標（說「還沒有」就夠了）', async () => {
    assert.ok(!tip().querySelector('.summary-tip-stale'));
    await moveAway();
  });

  // ---- 細綱是模型寫的，一律走 textContent，絕不拼 HTML
  test('細綱正文不當 HTML 解析', async () => {
    ui.post({ type: 'project', tree: sampleTree() });
    hover(rowWith('楔子'));
    await settle();
    ui.post({
      type: 'summary',
      summary: summaryOf({ sections: [{ name: '梗概', text: '<img src=x onerror=alert(1)>' }] }),
    });
    assert.ok(!tip().querySelector('img'), tip().innerHTML);
  });

  test('細綱正文原樣顯示為文字', async () => {
    assert.ok(tip().textContent.includes('<img src=x onerror=alert(1)>'), tip().textContent);
    await moveAway();
  });

  // ---- 定位：浮窗任何時候都不許有一部分落到視窗外面
  //
  // 視口 800×600（上面用 defineProperty 釘住的）。浮窗寬 340，
  // 高度由 tipNaturalHeight 控制，行的位置由 rowRect 控制。

  // ① 常規位置：行在上半屏，浮窗放在行下方
  test('空間夠時放在行的下方', async () => {
    rowRect = { top: 100, bottom: 120, left: 20 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  });

  test('常規位置整個在視口內', async () => {
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });

  // ② 行貼近底部：下方放不下 → 翻到上方
  test('行貼底時翻到行的上方', async () => {
    rowRect = { top: 540, bottom: 560, left: 20 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().bottom <= rowRect.top, JSON.stringify(tipBox()));
  });

  test('翻轉後整個在視口內', async () => {
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });

  // ③ 行貼右邊緣：橫向往左收，不許右邊溢位
  test('貼右邊緣時向左收', async () => {
    rowRect = { top: 100, bottom: 120, left: 700 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().right <= VIEWPORT.w, JSON.stringify(tipBox()));
  });

  test('向左收後仍不越過左邊緣', async () => {
    assert.ok(tipBox().left >= 0, JSON.stringify(tipBox()));
    await moveAway();
  });

  // ④ 細綱很長、上下都放不下：壓高度進可用空間，靠滾動看剩下的。
  //    只翻轉不壓高度的話，長細綱在矮視窗裡會有一截永遠夠不到。
  test('超長細綱被壓進可用空間', async () => {
    rowRect = { top: 280, bottom: 300, left: 20 };
    tipNaturalHeight = 2000;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().bottom <= VIEWPORT.h, JSON.stringify(tipBox()));
  });

  test('超長細綱不越過頂邊', () => {
    assert.ok(tipBox().top >= 0, JSON.stringify(tipBox()));
  });

  test('壓高度靠的是 maxHeight（內容仍可滾動，不是被截掉）', async () => {
    assert.ok(parseFloat(tip().style.maxHeight) > 0, tip().style.maxHeight);
    await moveAway();
  });

  // ⑤ 內容後到達導致高度變化時，也要重新收進視口
  test('「讀取中」的小浮窗放在下方', async () => {
    rowRect = { top: 500, bottom: 520, left: 20 };
    tipNaturalHeight = 60;
    ui.post({ type: 'project', tree: sampleTree() });
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  });

  // 細綱到了，內容一下子撐高——不能就這麼支稜到視窗外面去。
  test('內容到達撐高後重新定位，仍在視口內', async () => {
    tipNaturalHeight = 400;
    ui.post({ type: 'summary', summary: summaryOf() });
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });
});

describe('行內副標題（別名）的懸停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  let tree;
  let detail;
  let box;
  let liDetail;
  const tip = () => ui.doc.querySelector('.detail-tip');
  const detailOf = (row) => row.querySelector('.row-detail');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等過懸停延遲（detailTip.ts 裡是 350ms）。 */
  const settle = () => wait(600);
  /** 等過收起的寬限（CLOSE_DELAY_MS 是 150ms）。 */
  const grace = () => wait(250);

  // 別名多到一行放不下的角色。detail 是「標籤 · 別名 …」的完整串，
  // 浮窗要原樣端出這一整段。
  const LONG_DETAIL = '反派 · 別名 四娘/老闆娘/四姐/沈掌櫃/黑心店主/前朝遺孀';

  before(() => {
    ui = mount();
    // jsdom 裡 scrollWidth/clientWidth 恆為 0，截斷與否只能靠覆寫 getter。
    // 帶 data-truncated 的副標題按「內容 300px、可見 50px」算，其餘不算截斷。
    Object.defineProperty(ui.window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.dataset && this.dataset.truncated ? 50 : 0; },
    });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() { return this.dataset && this.dataset.truncated ? 300 : 0; },
    });

    tree = sampleTree();
    tree.characters.push({
      kind: 'file', label: '沈四娘',
      relPath: '.novelwarden/characters/沈四娘.md', detail: LONG_DETAIL,
    });
    ui.post({ type: 'project', tree });
  });

  test('預設不顯示浮窗', () => {
    assert.ok(!tip());
  });

  // ---- 截斷的副標題：懸停後浮窗顯示完整別名
  test('懸停後不立刻彈出（有延遲，免得劃過時閃）', () => {
    detail = detailOf(rowWith('沈四娘'));
    detail.dataset.truncated = '1';
    hover(detail);
    assert.ok(!tip());
  });

  test('截斷的別名行懸停後彈出浮窗', async () => {
    await settle();
    box = tip();
    assert.ok(box);
  });

  // 下面三條在原指令碼里包在 `if (box) { ... }` 裡。node:test 的用例是在
  // describe 同步收集階段宣告的，那時 box 還不存在，執行時守衛**無法**用來
  // 決定要不要宣告用例——所以這裡改成無條件宣告。這是一處有意的偏離：
  // 原寫法在浮窗彈不出來時會讓這三條斷言憑空消失，而彙總照打「全部通過」；
  // 現在 box 為 null 就是 TypeError，用例失敗，正是我們想要的。
  test('浮窗掛在 body 上（工程頁有內部滾動，掛在行裡會被裁掉）', () => {
    assert.equal(box.parentElement, ui.doc.body);
  });

  test('浮窗顯示完整副標題（含全部別名）', () => {
    assert.equal(box.textContent, LONG_DETAIL, box.textContent);
  });

  test('浮窗帶獨立樣式類（只讀展示，不吃滑鼠）', () => {
    assert.ok(box.classList.contains('detail-tip'), box.className);
  });

  // 游標在副標題上微動（mouseover 冒泡）不該重置延遲導致彈不出來。
  test('微動後浮窗仍在', async () => {
    hover(detail);
    await grace();
    assert.equal(tip(), box);
  });

  // ---- 移開：寬限後收起
  test('移開後浮窗收起', async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
    assert.ok(!tip());
  });

  // ---- 全文可見（未截斷）的副標題：不彈浮窗
  test('未截斷的副標題不彈浮窗', async () => {
    liDetail = detailOf(rowWith('林昭'));
    delete liDetail.dataset.truncated;
    hover(liDetail);
    await settle();
    assert.ok(!tip());
  });

  // ---- 重渲染把行換掉後，開著的浮窗必須清掉
  test('截斷後又能彈出', async () => {
    liDetail.dataset.truncated = '1';
    hover(liDetail);
    await settle();
    assert.ok(tip());
  });

  test('重渲染後浮窗隨之收起', () => {
    ui.post({ type: 'project', tree });
    assert.ok(!tip());
  });
});

/**
 * 失敗標記（紅色感嘆號）與它的懸停浮窗。
 *
 * 這是「解析失敗只有日誌、使用者看不到」那個 bug 的介面出口：卡一字未改，
 * 而樹上那一行此前與更新成功的一模一樣。所以要驗的是**看得見**與**說得清**。
 */
describe('失敗標記與懸停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  let cardMark;
  let plotMark;
  let box;
  let multiBox;
  const tip = () => ui.doc.querySelector('.failure-tip');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const markIn = (text) => {
    const row = rowWith(text);
    return row ? row.querySelector('.row-failure') : null;
  };
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等過懸停延遲（HOVER_DELAY_MS 是 300ms）。 */
  const settle = () => wait(550);
  /** 等過收起的寬限（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);

  const CARD = '.novelwarden/characters/林昭.md';
  // 失敗掛在出錯那份檔案上（recordFailure 的 targetKey 就是它的路徑）。
  // 寫細綱 / 寫正文失敗掛在細綱上，定稿失敗掛在正文上——章節行兩側都查。
  const PLOT = '.novelwarden/summaries/001-楔子.md';
  const CHAPTER = 'chapters/002-入鎮.md';
  // 生成架構文件失敗掛在那份文件上。
  const PREMISE = '.novelwarden/premise.md';
  /** 章節組的行（排掉複用了 .row-plot 樣式的「故事架構」那幾行）。 */
  const plotRow = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture)')]
      .find((n) => n.textContent.includes(text));

  before(() => {
    ui = mount();
    // ---- 沒有失敗記錄時，樹上不該多出任何東西
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('沒有失敗記錄時不顯示感嘆號', () => {
    assert.ok(!markIn('林昭'));
  });

  test('沒有失敗記錄時沒有浮窗', () => {
    assert.ok(!tip());
  });

  // 舊後端推來的樹沒有 failures 欄位，前端不能因此崩。
  test('缺 failures 欄位時不崩', () => {
    const legacy = sampleTree();
    delete legacy.failures;
    let threw = false;
    try {
      ui.post({ type: 'project', tree: legacy });
    } catch {
      threw = true;
    }
    assert.ok(!threw && !!rowWith('林昭'));
  });

  // ---- 有失敗記錄：對應行掛上感嘆號
  test('出錯的角色行掛上感嘆號', () => {
    const tree = sampleTree();
    tree.failures = {
      [CARD]: [
        {
          at: '2026-08-10T11:31:40.000Z',
          severity: 'error',
          message: '1 批全部解析失敗，角色卡未改動',
          detail: '模型沒有按要求返回 JSON。換個模型或稍後重試。',
        },
      ],
      [PLOT]: [
        { at: '2026-08-10T11:20:00.000Z', severity: 'warn', message: '3 段解析失敗，「已讀到」只推進到第 2 段' },
      ],
      [CHAPTER]: [
        { at: '2026-08-10T11:25:00.000Z', severity: 'error', message: '定稿失敗：模型返回無法解析' },
      ],
      [PREMISE]: [
        { at: '2026-08-10T11:10:00.000Z', severity: 'error', message: '故事前提解析失敗，檔案未改動' },
      ],
    };
    ui.post({ type: 'project', tree });
    cardMark = markIn('林昭');
    assert.ok(cardMark);
  });

  test('沒出錯的角色行沒有感嘆號', () => {
    assert.ok(!markIn('李叔'));
  });

  // 下面兩條在原指令碼里包在 `if (cardMark) { ... }` 裡——同上，執行時守衛
  // 擋不住宣告期，改成無條件；cardMark 為 null 時該失敗就失敗。
  test('整體失敗標紅', () => {
    assert.ok(cardMark.classList.contains('is-error'), cardMark.className);
  });

  // 浮窗要等 300ms，原生 title 作兜底，滑鼠一停就有提示。
  test('感嘆號帶 title 兜底', () => {
    assert.ok(cardMark.title.includes('未改動'), cardMark.title);
  });

  // 第 1 章有正文也有細綱：失敗掛在細綱上，照樣要標在這一行。
  test('細綱失敗標在章節行上', () => {
    const row = plotRow('楔子');
    plotMark = row ? row.querySelector('.row-failure') : null;
    assert.ok(plotMark);
  });

  test('部分完成標黃而非標紅', () => {
    assert.ok(plotMark && plotMark.classList.contains('is-warn'), plotMark && plotMark.className);
  });

  // 第 2 章沒有細綱：失敗掛在正文上（定稿讀的是正文）。
  test('正文上的失敗也標在章節行上', () => {
    const mark = plotRow('入鎮')?.querySelector('.row-failure');
    assert.ok(mark && mark.classList.contains('is-error'), plotRow('入鎮')?.outerHTML);
  });

  // 失敗記錄按路徑掛：別的章不該跟著掛標記。
  test('別的章不掛感嘆號', () => {
    const row = plotRow('夜訪');
    assert.ok(row && !row.querySelector('.row-failure'), row && row.outerHTML);
  });

  // 生成架構文件失敗時，「故事架構」那一行同樣要看得見——那是後面一切的上游。
  test('出錯的架構行也掛上感嘆號', () => {
    const row = [...ui.doc.querySelectorAll('#projectBody .row-architecture')]
      .find((n) => n.textContent.includes('故事前提'));
    assert.ok(row && row.querySelector('.row-failure.is-error'), row && row.outerHTML);
  });

  test('沒出錯的架構行沒有感嘆號', () => {
    const row = [...ui.doc.querySelectorAll('#projectBody .row-architecture')]
      .find((n) => n.textContent.includes('小說配置'));
    assert.ok(row && !row.querySelector('.row-failure'), row && row.outerHTML);
  });

  // ---- 懸停：延遲後彈浮窗，說清「改沒改」與原因
  test('懸停後不立刻彈出（有延遲，免得劃過時閃）', () => {
    hover(cardMark);
    assert.ok(!tip());
  });

  test('懸停感嘆號後彈出浮窗', async () => {
    await settle();
    box = tip();
    assert.ok(box);
  });

  // 下面五條在原指令碼里包在 `if (box) { ... }` 裡——同上，改成無條件。
  test('浮窗掛在 body 上（工程頁有內部滾動，掛在行裡會被裁掉）', () => {
    assert.equal(box.parentElement, ui.doc.body);
  });

  test('浮窗給出失敗原因', () => {
    assert.ok(box.textContent.includes('1 批全部解析失敗'), box.textContent);
  });

  test('浮窗給出補充說明', () => {
    assert.ok(box.textContent.includes('換個模型'), box.textContent);
  });

  // 使用者最想知道的一件事：磁碟上的東西動沒動。
  test('浮窗點明「未改動」', () => {
    assert.ok(box.textContent.includes('未改動'), box.textContent);
  });

  test('浮窗告知標記會自動消失', () => {
    assert.ok(box.textContent.includes('自動消失'), box.textContent);
  });

  // ---- 可進入：詳情有好幾行、常含模型返回的片段，使用者要能選中複製
  test('滑鼠停在浮窗上時不收起', async () => {
    box.dispatchEvent(new ui.window.MouseEvent('mouseleave', { bubbles: false }));
    box.dispatchEvent(new ui.window.MouseEvent('mouseenter', { bubbles: false }));
    await grace();
    assert.equal(tip(), box);
  });

  // ---- 移開：寬限後收起
  test('移開後浮窗收起', async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
    assert.ok(!tip());
  });

  // ---- 同一目標掛多條：分條畫，不是擠成一段
  test('同一目標的多條各佔一塊', async () => {
    const multi = sampleTree();
    multi.failures = {
      [CARD]: [
        { at: '2026-08-10T11:31:40.000Z', severity: 'error', message: '角色卡失敗' },
        { at: '2026-08-10T10:00:00.000Z', severity: 'warn', message: '定稿也失敗了' },
      ],
    };
    ui.post({ type: 'project', tree: multi });
    hover(markIn('林昭'));
    await settle();
    multiBox = tip();
    assert.ok(multiBox, '沒彈出浮窗');
    assert.equal(multiBox.querySelectorAll('.failure-tip-item').length, 2,
      multiBox && String(multiBox.querySelectorAll('.failure-tip-item').length));
  });

  // 有一條是 error 就按紅色算——那比「部分完成」嚴重，不能被黃色蓋過去。
  test('混合嚴重度時按最嚴重的標色', () => {
    assert.ok(markIn('林昭').classList.contains('is-error'), markIn('林昭').className);
  });

  // ---- 重渲染把行換掉後，開著的浮窗必須清掉（指向的是已丟棄的節點）
  test('重渲染後浮窗隨之收起', () => {
    const multi = sampleTree();
    multi.failures = {
      [CARD]: [
        { at: '2026-08-10T11:31:40.000Z', severity: 'error', message: '角色卡失敗' },
        { at: '2026-08-10T10:00:00.000Z', severity: 'warn', message: '定稿也失敗了' },
      ],
    };
    ui.post({ type: 'project', tree: multi });
    assert.ok(!tip());
  });

  // ---- 修好之後：後端不再推這條記錄，感嘆號就該沒了
  test('後端不再推記錄時感嘆號消失', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(!markIn('林昭'));
  });
});
