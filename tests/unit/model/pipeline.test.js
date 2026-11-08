/**
 * 創作流水線純函式：Stage × Capability × Target、細綱的檔案格式、
 * 單章狀態推導、全書狀態推導。
 *
 * 這兩個模組是整條流水線的地基，且全部零 I/O——所以它們能被單獨 bundle 出來直接調，
 * 不需要建工程、不需要 host、不需要模型。
 *
 * 模組在檔案頂層同步載入（而不是在 before() 裡）：有幾處用例要按模組常量
 * （CREATION_STAGES / SETTING_DOCS）展開成一批 test，describe 體在收集階段就要讀到它們。
 *
 * 新鏈路（一章一綱）：架構 → 情節大綱 → 細綱（細綱號 = 章號）→ 正文 → 定稿。
 * 卷、劇情段位次、中轉站、拆章都刪了，老會話裡的那幾種 stage / target 要能容錯回落。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const pipeline = loadModule('src/core/model/pipeline.ts');
const plotFile = loadModule('src/core/model/plotFile.ts');

describe('pipeline.ts · Stage × Capability', () => {
  test('四個階段：架構 / 大綱 / 細綱 / 正文', () => {
    assert.deepEqual(pipeline.CREATION_STAGES, ['setting', 'outline', 'plot', 'manuscript']);
    assert.deepEqual(
      pipeline.CREATION_STAGES.map((s) => pipeline.STAGE_LABEL[s]),
      ['架構', '大綱', '細綱', '正文']
    );
  });

  // 「設定」在工程頁上是設定條目（lore）的名字，階段叫它會撞名。
  test('架構階段不叫「設定」', () => {
    assert.notEqual(pipeline.STAGE_LABEL.setting, '设定');
  });

  test('每個階段都有身份與問題', () => {
    for (const s of pipeline.CREATION_STAGES) {
      assert.ok(pipeline.STAGE_ROLE[s], s);
      assert.ok(pipeline.STAGE_QUESTION[s], s);
    }
  });

  test('能力是討論 / 生成 / 落定 / 審稿（split 刪了）', () => {
    assert.deepEqual(pipeline.CAPABILITIES, ['discuss', 'generate', 'settle', 'review']);
    assert.equal(pipeline.isCapability('split'), false);
  });

  // 五期：審稿是正文層的可選動作，其餘各層沒有「這一章寫得對不對」可查。
  test('只有正文層能審稿', () => {
    const withReview = pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('review'));
    assert.deepEqual(withReview, ['manuscript']);
    assert.equal(pipeline.isValidAction({ stage: 'plot', capability: 'review' }), false);
  });

  // 前端的按鈕組直接讀這張表，混進一個不存在的能力會渲染出一個點了什麼都不會發生的按鈕。
  for (const stage of pipeline.CREATION_STAGES) {
    test(`${stage} 的能力集合法，且都能討論、都能生成`, () => {
      const caps = pipeline.STAGE_CAPABILITIES[stage];
      assert.ok(caps.every((c) => pipeline.isCapability(c)), JSON.stringify(caps));
      assert.ok(caps.includes('discuss') && caps.includes('generate'), JSON.stringify(caps));
    });
  }

  // 第 22 條：細綱是「先聊、聊出結論再落檔案」的東西；完善設定二期起，架構那一層的設定目錄也能落定（落定設定）。
  test('能落定的是細綱與設定目錄，別的架構檔案不開', () => {
    const withSettle = pipeline.CREATION_STAGES.filter((s) => pipeline.STAGE_CAPABILITIES[s].includes('settle'));
    assert.deepEqual(withSettle, ['setting', 'plot']);
    const on = (target) => pipeline.capabilitiesOn('setting', target);
    assert.deepEqual(on({ kind: 'setting', doc: 'lore' }), ['discuss', 'generate', 'settle']);
    for (const doc of ['config', 'premise', 'characters', 'world']) {
      assert.deepEqual(on({ kind: 'setting', doc }), ['discuss', 'generate'], doc);
    }
    assert.deepEqual(on({ kind: 'lore', relPath: '.novelwarden/lore/a.md' }), ['discuss', 'generate']);
    assert.deepEqual(on(undefined), ['discuss', 'generate']);
    assert.deepEqual(pipeline.capabilitiesOn('plot', { kind: 'plot', plotRelPath: 'x' }), ['discuss', 'settle', 'generate']);
  });

  test('預設能力一律是討論（不偷偷燒 token）', () => {
    assert.ok(pipeline.CREATION_STAGES.every((s) => pipeline.DEFAULT_CAPABILITY[s] === 'discuss'));
  });

  test('isValidAction', () => {
    assert.equal(pipeline.isValidAction({ stage: 'plot', capability: 'settle' }), true);
    assert.equal(pipeline.isValidAction({ stage: 'setting', capability: 'generate' }), true);
    assert.equal(pipeline.isValidAction({ stage: 'outline', capability: 'settle' }), false);
    assert.equal(pipeline.isValidAction({ stage: 'volume', capability: 'generate' }), false);
    assert.equal(pipeline.isValidAction({ stage: 'outline', capability: 'split' }), false);
  });

  test('命令面板不列討論，每條都產出產物或報告', () => {
    for (const s of pipeline.CREATION_STAGES) {
      const cmds = pipeline.commandsFor(s);
      assert.ok(cmds.length > 0, s);
      assert.ok(cmds.every((c) => c.capability !== 'discuss'), s);
    }
    assert.deepEqual(pipeline.commandsFor('plot').map((c) => c.label), ['落定細綱', '寫細綱', '續寫大綱', '落定設定']);
    assert.deepEqual(pipeline.commandsFor('manuscript').map((c) => c.label), ['寫正文', '審稿', '續寫大綱', '落定設定']);
    assert.ok(pipeline.commandOf('manuscript', 'review').keys.includes('sg'));
  });

  // 2026-10-24：停在一章上找不到續寫大綱（回全書只有目標下拉框最上面那一項）。
  test('/續寫大綱 每一層都有：帶著情節大綱的階段與目標，排在落定設定前面', () => {
    for (const s of pipeline.CREATION_STAGES.filter((x) => x !== 'outline')) {
      const cmd = pipeline.commandsFor(s).at(-2);
      assert.equal(cmd.label, '續寫大綱', s);
      assert.equal(cmd.capability, 'generate');
      assert.equal(cmd.stage, 'outline');
      assert.deepEqual(cmd.target, { kind: 'outline' });
      assert.ok(cmd.keys.includes('xxdg'), cmd.keys.join(','));
      assert.ok(!cmd.keys.includes('sc'), '不搶這一層自己的「生成」的別名');
      assert.ok(cmd.hint.includes('往後排 20 章') && cmd.hint.includes('跑完回到這一層') && cmd.hint.includes('預計 1 次呼叫'), cmd.hint);
    }
  });

  test('大綱那一層：續寫大綱就是這一層自己的「生成」，不重複掛', () => {
    const cmds = pipeline.commandsFor('outline', { kind: 'outline' });
    assert.deepEqual(cmds.map((c) => c.label), ['續寫大綱', '落定設定']);
    assert.equal(cmds[0].stage, undefined);
    assert.ok(cmds[0].keys.includes('sc') && cmds[0].keys.includes('xxdg'), cmds[0].keys.join(','));
    assert.ok(!cmds[0].hint.includes('跑完回到這一層'), cmds[0].hint);
    assert.equal(pipeline.commandOf('outline', 'generate', { kind: 'outline' }).label, '續寫大綱');
    // 別的層掛過來的那一條不算那一層自己的：細綱層問 generate 得到的是寫細綱。
    assert.equal(pipeline.commandOf('plot', 'generate').label, '寫細綱');
  });

  test('isOutlineContinue：大綱那一層的生成', () => {
    assert.equal(pipeline.isOutlineContinue({ stage: 'outline', capability: 'generate' }), true);
    assert.equal(pipeline.isOutlineContinue({ stage: 'outline', capability: 'discuss' }), false);
    assert.equal(pipeline.isOutlineContinue({ stage: 'plot', capability: 'generate' }), false);
  });

  // 完善設定二期：聊細綱、聊正文時定下的設定當場就能落，不必先切到設定目錄。
  test('/落定設定 每一層都有：帶著自己的階段與目標，掛在末尾', () => {
    for (const s of pipeline.CREATION_STAGES) {
      const last = pipeline.commandsFor(s).at(-1);
      assert.equal(last.label, '落定設定', s);
      assert.equal(last.capability, 'settle');
      assert.equal(last.stage, 'setting');
      assert.deepEqual(last.target, { kind: 'setting', doc: 'lore' });
      assert.ok(last.keys.includes('ldsd') && last.keys.includes('ld'), last.keys.join(','));
      assert.ok(last.hint.includes('預計 2 次呼叫，最多 3 次'), last.hint);
    }
  });

  test('目標就是設定目錄時它是這一層自己的 settle，不重複掛', () => {
    const cmds = pipeline.commandsFor('setting', { kind: 'setting', doc: 'lore' });
    assert.deepEqual(cmds.map((c) => c.label), ['生成這份架構檔案', '續寫大綱', '落定設定']);
    assert.equal(cmds[2].stage, undefined);
    assert.equal(pipeline.commandOf('setting', 'settle', { kind: 'setting', doc: 'lore' }).label, '落定設定');
  });

  // 別的層掛過來的那一條只在 setting 認：細綱層問 settle 得到的是落定細綱，正文層問 settle 什麼都沒有。
  test('commandOf 只認這一層自己的', () => {
    assert.equal(pipeline.commandOf('plot', 'settle').label, '落定細綱');
    assert.equal(pipeline.commandOf('manuscript', 'settle'), undefined);
    assert.equal(pipeline.commandOf('setting', 'settle', { kind: 'setting', doc: 'config' }), undefined);
  });

  test('isLoreSettle：架構那一層的 settle', () => {
    assert.equal(pipeline.isLoreSettle({ stage: 'setting', capability: 'settle' }), true);
    assert.equal(pipeline.isLoreSettle({ stage: 'plot', capability: 'settle' }), false);
    assert.equal(pipeline.isLoreSettle({ stage: 'setting', capability: 'generate' }), false);
    assert.equal(pipeline.labelOf('setting', 'settle', { kind: 'setting', doc: 'lore' }), '落定設定');
  });

  // 審稿報告不是可以落盤的產物：按「不是討論就是產物」判斷的地方會把它寫進章節。
  test('輸出形態：討論是文字，審稿是報告，其餘是產物', () => {
    assert.equal(pipeline.outputKindOf({ stage: 'plot', capability: 'discuss' }), 'text');
    assert.equal(pipeline.outputKindOf({ stage: 'plot', capability: 'settle' }), 'artifact');
    assert.equal(pipeline.outputKindOf({ stage: 'setting', capability: 'generate' }), 'artifact');
    assert.equal(pipeline.outputKindOf({ stage: 'manuscript', capability: 'review' }), 'report');
  });

  test('審稿、寫前比對與修稿的呼叫次數（審稿與比對 2026-10-25 起多一次轉寫）', () => {
    assert.equal(
      pipeline.describeCalls(pipeline.REVIEW_CALLS),
      '預計 2 次呼叫，最多 7 次（審 1 次、轉寫模型照抄成 JSON 1 次；被截斷或不合格時重來，審最多再 2 次，轉寫不合格各重轉 1 次）'
    );
    assert.equal(
      pipeline.describeCalls(pipeline.PLOT_CHECK_CALLS),
      '預計 0–2 次呼叫，最多 3 次（前面有同步過的章時，寫之前比對一次細綱與既成事實、轉寫模型照抄成 JSON 1 次（沒有矛盾不轉）；轉寫不合格重轉 1 次）'
    );
    assert.equal(pipeline.describeCalls(pipeline.REVISE_CALLS), '預計 1 次呼叫，最多 4 次（被輸出上限截斷時接著寫，最多再續 3 輪）');
    assert.equal(pipeline.isWriteMode('revise'), true);
  });
});

describe('pipeline.ts · 動作歸一（容錯，老會話）', () => {
  test('認得出合法動作', () => {
    assert.deepEqual(pipeline.normalizeAction({ stage: 'setting', capability: 'generate' }), {
      stage: 'setting',
      capability: 'generate',
    });
  });

  test('老會話的 volume 階段落到大綱', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'volume', capability: 'generate' }).stage, 'outline');
  });

  test('老會話的 scene 階段落到細綱', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'scene', capability: 'generate' }).stage, 'plot');
  });

  // 開啟一個老會話不該替作者按下一個會花錢的按鈕。
  test('老會話的 split 回落到討論，不對映成生成', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'outline', capability: 'split' }).capability, 'discuss');
  });

  test('rewrite 落到 generate，挑刺 / 檢查 / 擴充套件落到討論', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'plot', capability: 'rewrite' }).capability, 'generate');
    for (const c of ['critique', 'check', 'expand']) {
      assert.equal(pipeline.normalizeAction({ stage: 'plot', capability: c }).capability, 'discuss', c);
    }
  });

  test('缺欄位回落到 正文 · 討論', () => {
    assert.deepEqual(pipeline.normalizeAction(undefined), { stage: 'manuscript', capability: 'discuss' });
  });

  test('階段不支援的能力被換掉', () => {
    assert.equal(pipeline.normalizeAction({ stage: 'outline', capability: 'settle' }).capability, 'discuss');
  });
});

describe('pipeline.ts · Target', () => {
  const P = { kind: 'plot', plotRelPath: '.novelwarden/plots/012-夜訪.md' };
  const M = { kind: 'manuscript', plotRelPath: '.novelwarden/plots/012-夜訪.md' };

  test('target 的階段就是它的 kind', () => {
    assert.equal(pipeline.stageOfTarget({ kind: 'setting', doc: 'world' }), 'setting');
    assert.equal(pipeline.stageOfTarget({ kind: 'outline' }), 'outline');
    assert.equal(pipeline.stageOfTarget(P), 'plot');
    assert.equal(pipeline.stageOfTarget(M), 'manuscript');
  });

  test('只有細綱與正文有歸屬的細綱路徑', () => {
    assert.equal(pipeline.plotOfTarget({ kind: 'outline' }), undefined);
    assert.equal(pipeline.plotOfTarget({ kind: 'setting', doc: 'config' }), undefined);
    assert.equal(pipeline.plotOfTarget(M), P.plotRelPath);
  });

  test('settingOfTarget', () => {
    assert.equal(pipeline.settingOfTarget({ kind: 'setting', doc: 'premise' }), 'premise');
    assert.equal(pipeline.settingOfTarget(P), undefined);
  });

  test('key 穩定且各不相同', () => {
    const keys = [
      { kind: 'setting', doc: 'config' },
      { kind: 'setting', doc: 'world' },
      { kind: 'outline' },
      P,
      M,
    ].map(pipeline.targetKey);
    assert.equal(new Set(keys).size, keys.length, keys.join('|'));
    assert.equal(pipeline.targetKey({ kind: 'setting', doc: 'world' }), 'setting:world');
  });

  test('描述', () => {
    assert.equal(pipeline.describeTarget({ kind: 'outline' }), '情節大綱');
    assert.equal(pipeline.describeTarget({ kind: 'setting', doc: 'characters' }), '故事架構 · 角色圖譜');
    assert.equal(pipeline.describeTarget({ kind: 'setting', doc: 'lore' }), '故事架構 · 設定清單');
    assert.equal(pipeline.describeTarget(P, { no: 12, title: '夜訪' }), '第 12 章《夜訪》 · 細綱');
    assert.equal(pipeline.describeTarget(M, { no: 12, title: '夜訪' }), '第 12 章《夜訪》 · 正文');
    assert.equal(pipeline.describeTarget(M), `${M.plotRelPath} · 正文`);
  });

  // 設定名錄（作者定案）：設定清單進架構主鏈，排在世界觀之後、情節大綱之前。
  test('五件架構檔案各有中文名，設定清單排在世界觀之後', () => {
    assert.deepEqual(pipeline.SETTING_DOCS, ['config', 'premise', 'characters', 'world', 'lore']);
    assert.ok(pipeline.SETTING_DOCS.every((d) => pipeline.SETTING_DOC_LABEL[d]));
    assert.equal(pipeline.SETTING_DOC_LABEL.lore, '設定清單');
    assert.equal(pipeline.isSettingDoc('lore'), true);
  });
});

describe('pipeline.ts · Target 歸一（容錯）', () => {
  test('認得出合法 target', () => {
    const t = { kind: 'setting', doc: 'premise' };
    assert.deepEqual(pipeline.normalizeTarget(t), t);
  });

  test('setting 帶認不出的 doc 落到小說配置', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'setting', doc: '亂寫' }), { kind: 'setting', doc: 'config' });
  });

  test('老會話的 volume target 落到大綱', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'volume', volumeRelPath: '.novelwarden/volumes/01.md' }), {
      kind: 'outline',
    });
  });

  test('老會話的 scene target 落到那一章的細綱，場號丟掉', () => {
    assert.deepEqual(
      pipeline.normalizeTarget({ kind: 'scene', plotRelPath: '.novelwarden/plots/003.md', sceneNo: 2 }),
      { kind: 'plot', plotRelPath: '.novelwarden/plots/003.md' }
    );
  });

  test('缺路徑的細綱 / 正文回落到大綱', () => {
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'plot' }), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'manuscript', plotRelPath: '  ' }), { kind: 'outline' });
  });

  test('undefined 與認不出的 kind 回落到大綱', () => {
    assert.deepEqual(pipeline.normalizeTarget(undefined), { kind: 'outline' });
    assert.deepEqual(pipeline.normalizeTarget({ kind: 'plan' }), { kind: 'outline' });
  });
});

describe('pipeline.ts · chapterLabel', () => {
  test('有標題時帶書名號', () => {
    assert.equal(pipeline.chapterLabel(12, '夜訪'), '第 12 章《夜訪》');
  });

  test('標題為空、缺席、恰好是回落值時只報序號', () => {
    assert.equal(pipeline.chapterLabel(7, ''), '第 7 章');
    assert.equal(pipeline.chapterLabel(7), '第 7 章');
    assert.equal(pipeline.chapterLabel(7, '第 7 章'), '第 7 章');
  });

  test('別的序號寫在標題裡仍算真標題', () => {
    assert.equal(pipeline.chapterLabel(7, '第 8 章'), '第 7 章《第 8 章》');
  });

  test('plotLabel 是它的別名', () => {
    assert.equal(pipeline.plotLabel(3, '夜訪'), pipeline.chapterLabel(3, '夜訪'));
  });
});

// ---------------------------------------------------------------- 細綱檔案

describe('plotFile.ts · 檔名規則', () => {
  test('解析章號與詞幹', () => {
    assert.deepEqual(plotFile.parsePlotFileName('012-夜訪.md'), { no: 12, stem: '夜訪' });
  });

  test('`007.md` 的詞幹為空', () => {
    assert.deepEqual(plotFile.parsePlotFileName('007.md'), { no: 7, stem: '' });
  });

  test('非 markdown、0 號、沒有數字字首都不認', () => {
    assert.equal(plotFile.parsePlotFileName('012-夜訪.txt'), undefined);
    assert.equal(plotFile.parsePlotFileName('000-序.md'), undefined);
    assert.equal(plotFile.parsePlotFileName('夜訪.md'), undefined);
  });

  test('拼檔名補三位，無標題就是純序號名', () => {
    assert.equal(plotFile.plotFileName(3, '夜訪'), '003-夜訪.md');
    assert.equal(plotFile.plotFileName(3, ''), '003.md');
  });

  test('檔名與解析互逆', () => {
    const name = plotFile.plotFileName(128, '入宗');
    assert.deepEqual(plotFile.parsePlotFileName(name), { no: 128, stem: '入宗' });
  });
});

describe('plotFile.ts · 解析與渲染（七節）', () => {
  const sections = {
    ...plotFile.emptyPlotSections(),
    梗概: '林昭雨夜翻牆進宗門，靠半枚令牌被破例留下。',
    出场人物: '林昭、沈青',
    时间地点: '第 11 章當夜，青雲宗外牆。',
    关键事件: '雨夜翻牆，被巡夜弟子撞見，亮出半枚令牌。',
    看点: '- 執事認出令牌，臉色變了。',
    状态变更: '林昭成了記名弟子。',
  };
  const plot = {
    no: 12,
    title: '夜入青雲',
    targetWords: 3000,
    upstreamHash: 'aaaa',
    writtenFrom: 'bbbb',
    done: false,
    sections,
  };
  const text = plotFile.renderPlotFile(plot);
  const back = plotFile.parsePlotFile(text, '.novelwarden/summaries/012-夜入青雲.md');

  test('往返：frontmatter', () => {
    assert.equal(back.no, 12);
    assert.equal(back.title, '夜入青雲');
    assert.equal(back.targetWords, 3000);
    assert.equal(back.upstreamHash, 'aaaa');
    assert.equal(back.writtenFrom, 'bbbb');
    assert.equal(back.sourceHash, '');
    assert.equal(back.done, false);
  });

  test('往返：七節', () => {
    assert.deepEqual(back.sections, sections);
  });

  // 敘事線二期：「新增伏筆」刪了（伏筆並進了敘事線），摘要那八節剩七節。
  test('就是摘要那八節去掉新增伏筆', () => {
    assert.deepEqual(
      [...plotFile.PLOT_SECTION_KEYS],
      ['梗概', '出场人物', '时间地点', '关键事件', '看点', '状态变更', '连续性事实']
    );
  });

  test('老細綱裡的「新增伏筆」當認不出的小節：不讀、不進指紋，檔案裡還在', () => {
    const old = text.replace('## 狀態變更', '## 新增伏筆\n\n- 半枚令牌的另一半在誰手裡。\n\n## 狀態變更');
    const parsed = plotFile.parsePlotFile(old, '.novelwarden/summaries/012-夜入青雲.md');
    assert.deepEqual(parsed.sections, sections);
    assert.equal(plotFile.plotContentHash(parsed), plotFile.plotContentHash(back));
    assert.ok(parsed.body.includes('半枚令牌的另一半'));
  });

  test('渲染帶「第N章 標題」一行', () => {
    assert.match(text, /^# 第12章 夜入青雲$/m);
  });

  test('沒定稿：計劃出場從「出場人物」一節讀，不寫 cast', () => {
    assert.deepEqual(back.characters, ['林昭', '沈青']);
    assert.ok(!/^cast:/m.test(text), text);
  });

  test('空的欄位不寫出來', () => {
    const bare = plotFile.renderPlotFile({ ...plot, targetWords: undefined, writtenFrom: '', upstreamHash: '' });
    assert.ok(!/^targetWords:/m.test(bare) && !/^writtenFrom:/m.test(bare) && !/^upstreamHash:/m.test(bare), bare);
  });

  test('空小節寫出佔位，讀回來是空串', () => {
    const empty = plotFile.renderPlotFile({ ...plot, sections: plotFile.emptyPlotSections() });
    assert.match(empty, /（待補充）/);
    assert.equal(plotFile.parsePlotFile(empty, 'x/001.md').sections.关键事件, '');
  });

  test('status: done 被讀出', () => {
    assert.equal(plotFile.parsePlotFile(plotFile.renderPlotFile({ ...plot, done: true }), 'x/012.md').done, true);
  });

  test('定稿過：sourceHash 與 cast 寫進 frontmatter，出場的人取 cast', () => {
    const cast = [{ name: '林昭', aliases: ['阿昭'] }, { name: '巡夜弟子', aliases: [] }];
    const finalized = plotFile.renderPlotFile({ ...plot, sourceHash: 'cccc', cast });
    assert.match(finalized, /^cast: \[林昭\(阿昭\), 巡夜弟子\]$/m);
    const p = plotFile.parsePlotFile(finalized, 'x/012.md');
    assert.equal(p.sourceHash, 'cccc');
    assert.deepEqual(p.cast, cast);
    assert.deepEqual(p.characters, ['林昭', '巡夜弟子']);
  });
});

describe('plotFile.ts · 計劃出場（「出場人物」一節）', () => {
  const names = (text) => plotFile.plannedNames(text);

  test('頓號、逗號、斜槓、分號都切', () => {
    assert.deepEqual(names('林昭、沈青，李叔/年輕守衛；掌櫃'), ['林昭', '沈青', '李叔', '年輕守衛', '掌櫃']);
  });

  test('一行一個、帶列表記號的也認', () => {
    assert.deepEqual(names('- 林昭\n* 沈青\n1. 李叔'), ['林昭', '沈青', '李叔']);
  });

  test('括號裡的別名不切開，只取名字', () => {
    assert.deepEqual(names('林昭(阿昭/昭兒)、沈青（青姐、阿青）'), ['林昭', '沈青']);
  });

  // castFromText 為了擋住句子碎片會丟掉帶「從」「和」的名字；計劃裡的名單是排細綱的人寫的，不該漏人。
  test('不按虛詞過濾：帶「從」「和」的名字照收', () => {
    assert.deepEqual(names('沈從文、和珅'), ['沈從文', '和珅']);
  });

  test('佔位與「無」不算人', () => {
    assert.deepEqual(names('（待補充）'), []);
    assert.deepEqual(names('無'), []);
  });
});

// 關鍵事件、看點落盤都是一條一行的列表（計劃與定稿同一個形狀）；一章一行的一覽要把它壓成一行。
describe('plotFile.ts · 一條一行的那幾節', () => {
  test('按行切成條，去掉列表記號，空行與佔位不算', () => {
    assert.deepEqual(plotFile.sectionItems('- 林昭踩點\n\n* 翻牆進了後院\n1. 落在藏書閣門口\n（待補充）'), ['林昭踩點', '翻牆進了後院', '落在藏書閣門口']);
    assert.deepEqual(plotFile.sectionItems(''), []);
  });

  // 一條裡本來就可以有分號；作者手寫成一整段的就是一項。
  test('只按換行切：一條裡的分號不切', () => {
    assert.deepEqual(plotFile.sectionItems('- 林昭翻牆；落在後院'), ['林昭翻牆；落在後院']);
    assert.deepEqual(plotFile.sectionItems('一整段寫成的關鍵事件。'), ['一整段寫成的關鍵事件。']);
  });

  test('壓成一行：條與條之間用「；」接，不留「- 」', () => {
    assert.equal(plotFile.sectionLine('- 林昭踩點\n- 翻牆進了後院'), '林昭踩點；翻牆進了後院');
    assert.equal(plotFile.sectionLine('一整段。'), '一整段。');
    assert.equal(plotFile.sectionLine('（待補充）'), '');
  });

  test('關鍵事件的上限：條數 8、合計 1200 字', () => {
    assert.equal(plotFile.BLUEPRINT_LIMITS.keyEventItems, 8);
    assert.equal(plotFile.BLUEPRINT_LIMITS.keyEvents, 1200);
  });
});

describe('plotFile.ts · 排過沒有 / 容錯', () => {
  test('只看「關鍵事件」', () => {
    const empty = plotFile.emptyPlotSections();
    assert.equal(plotFile.isPlotFilled(empty), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 梗概: '有梗概', 看点: '- 有看點' }), false);
    assert.equal(plotFile.isPlotFilled({ ...empty, 关键事件: '有事件' }), true);
  });

  test('佔位文字不算內容', () => {
    assert.equal(plotFile.isPlotFilled({ ...plotFile.emptyPlotSections(), 关键事件: '（待補充）' }), false);
  });

  test('認不出的小節讀進來全空、不拋', () => {
    const odd = '---\nno: 3\ntitle: 夜訪\n---\n\n## 目標\n\n甲\n\n## 劇情脈絡\n\n乙\n';
    const p = plotFile.parsePlotFile(odd, '.novelwarden/summaries/003-夜訪.md');
    assert.equal(p.no, 3);
    assert.equal(p.title, '夜訪');
    assert.equal(plotFile.isPlotFilled(p.sections), false);
  });

  test('無 frontmatter、畸形 frontmatter、大白話、空檔案都不拋', () => {
    for (const t of ['## 關鍵事件\n\n甲', '---\n: :\n---\n', '就一句大白話', '', '---\ncast: [(, )]\nsourceHash: x\n---\n']) {
      assert.doesNotThrow(() => plotFile.parsePlotFile(t, 'x/001.md'), t);
    }
  });

  test('檔名的章號壓過 frontmatter', () => {
    assert.equal(plotFile.parsePlotFile('---\nno: 99\n---\n', 'x/004-甲.md').no, 4);
  });

  test('無 frontmatter 標題時用檔名詞幹', () => {
    assert.equal(plotFile.parsePlotFile('', 'x/004-甲.md').title, '甲');
  });

  test('targetWords 寫成漢字或非正數時當沒寫', () => {
    assert.equal(plotFile.parsePlotFile('---\ntargetWords: 三千\n---\n', 'x/001.md').targetWords, undefined);
    assert.equal(plotFile.parsePlotFile('---\ntargetWords: 0\n---\n', 'x/001.md').targetWords, undefined);
  });
});

// 情節大綱是各章細綱梗概的彙總（docs/design/plans/2026-10-22-outline-from-plots.md）：上游指紋是梗概的指紋。
describe('plotFile.ts · 梗概是上游（空殼、梗概指紋、大綱改了細綱沒跟）', () => {
  const sections = (extra = {}) => ({ ...plotFile.emptyPlotSections(), 梗概: '林昭進鎮。', ...extra });

  test('梗概的指紋：換行風格與行尾空白不算改動，空著（或佔位文字）給空串', () => {
    assert.equal(plotFile.plotSynopsisHash('林昭進鎮。\n後果。'), plotFile.plotSynopsisHash('  林昭進鎮。  \r\n後果。\n'));
    assert.notEqual(plotFile.plotSynopsisHash('林昭進鎮。'), plotFile.plotSynopsisHash('林昭沒進鎮。'));
    assert.equal(plotFile.plotSynopsisHash(''), '');
    assert.equal(plotFile.plotSynopsisHash('（待補充）'), '');
  });

  test('空殼：只有梗概；別的節有字、記過設定、定稿過都不是', () => {
    assert.equal(plotFile.isPlotStub({ sections: sections(), sourceHash: '' }), true);
    assert.equal(plotFile.isPlotStub({ sections: sections({ 时间地点: '（待補充）' }), sourceHash: '' }), true);
    assert.equal(plotFile.isPlotStub({ sections: sections({ 看点: '- 有' }), sourceHash: '' }), false);
    assert.equal(plotFile.isPlotStub({ sections: sections(), sourceHash: 'x' }), false);
    assert.equal(plotFile.isPlotStub({ sections: sections(), sourceHash: '', lore: [{ name: '青河', category: '地點', fact: '' }] }), false);
  });

  test('判髒：記過、排過細綱（關鍵事件非空）、梗概變了才算；空殼與手寫的（沒記過）不標', () => {
    const filled = sections({ 关键事件: '- 進鎮' });
    const h = plotFile.plotSynopsisHash(filled.梗概);
    assert.equal(plotFile.isPlotUpstreamStale({ upstreamHash: h, sections: filled }), false);
    assert.equal(plotFile.isPlotUpstreamStale({ upstreamHash: h, sections: { ...filled, 梗概: '林昭沒進鎮。' } }), true);
    assert.equal(plotFile.isPlotUpstreamStale({ upstreamHash: h, sections: { ...sections(), 梗概: '林昭沒進鎮。' } }), false);
    assert.equal(plotFile.isPlotUpstreamStale({ upstreamHash: '', sections: { ...filled, 梗概: '改了。' } }), false);
    assert.equal(plotFile.isPlotUpstreamStale({ upstreamHash: h, sections: { ...filled, 梗概: '' } }), false);
    assert.equal(plotFile.isPlotUpstreamStale(undefined), false);
  });
});

// 老工程 summaries/ 根下的單章摘要本來就是這七節，帶著 sourceHash 與 cast：直接當成定稿過的細綱讀。
describe('plotFile.ts · 老工程的單章摘要當成定稿過的細綱', () => {
  const old = [
    '---',
    'chapter: 7',
    'title: 入宗',
    'sourceHash: f00d',
    'cast: [林昭(阿昭), 沈青]',
    'generatedBy: novelwarden',
    '---',
    '',
    '# 第7章 入宗 · 摘要',
    '',
    '## 梗概',
    '',
    '林昭進了宗門。',
    '',
    '## 出場人物',
    '',
    '林昭、沈青',
    '',
    '## 關鍵事件',
    '',
    '- 林昭拜師。',
    '',
  ].join('\n');
  const p = plotFile.parsePlotFile(old, '.novelwarden/summaries/007-入宗.md');

  test('章號取檔名字首，frontmatter 的 chapter 不認', () => {
    assert.equal(plotFile.parsePlotFile(old.replace('chapter: 7', 'chapter: 99'), 'x/007-入宗.md').no, 7);
    assert.equal(p.no, 7);
  });

  test('sourceHash 在：算定稿過', () => {
    assert.equal(p.sourceHash, 'f00d');
  });

  test('cast 照讀，出場的人取它', () => {
    assert.deepEqual(p.cast, [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈青', aliases: [] }]);
    assert.deepEqual(p.characters, ['林昭', '沈青']);
  });

  test('關鍵事件有內容：算排過', () => {
    assert.equal(plotFile.isPlotFilled(p.sections), true);
  });

  test('沒有 cast 欄位的（手寫的、更早的摘要）從「出場人物」反解', () => {
    const q = plotFile.parsePlotFile(old.replace('cast: [林昭(阿昭), 沈青]\n', ''), 'x/007-入宗.md');
    assert.deepEqual(q.cast.map((c) => c.name), ['林昭', '沈青']);
  });
});

describe('plotFile.ts · 內容指紋', () => {
  const base = plotFile.parsePlotFile(
    plotFile.renderPlotFile({
      no: 3,
      title: '夜訪',
      upstreamHash: 'u',
      done: false,
      sections: { ...plotFile.emptyPlotSections(), 关键事件: '甲', 看点: '- 乙' },
    }),
    'x/003-夜訪.md'
  );
  const h = plotFile.plotContentHash(base);

  test('七節裡任何一節變了指紋就變', () => {
    for (const key of plotFile.PLOT_SECTION_KEYS) {
      assert.notEqual(plotFile.plotContentHash({ sections: { ...base.sections, [key]: `${base.sections[key]}改` } }), h, key);
    }
  });

  // 記一條預檢放行、寫前衝突檢查放行、定稿記的 cast、改個標題，都不該讓正文變成「細綱改過」。
  test('preflightOk / factCheckOk / cast / 標題不進指紋', () => {
    const other = plotFile.parsePlotFile(
      plotFile.renderPlotFile({
        no: 3,
        title: '另一個標題',
        upstreamHash: 'u2',
        done: true,
        sourceHash: 's',
        cast: [{ name: '林昭', aliases: [] }],
        preflightOk: [{ name: '沈秋', reason: '回憶' }],
        factCheckOk: true,
        sections: base.sections,
      }),
      'x/003-夜訪.md'
    );
    assert.equal(plotFile.plotContentHash(other), h);
  });
});

// ---------------------------------------------------------------- 單章狀態機

describe('pipeline.ts · 單章狀態推導', () => {
  const facts = (over) => ({ ...pipeline.emptyFacts(), ...over });

  test('什麼都沒有 → 待寫細綱', () => {
    assert.equal(pipeline.deriveStage(facts({})), 'plot');
  });

  test('細綱排好、沒有正文 → 待寫正文', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true })), 'manuscript');
  });

  // 空檔案不算寫過：作者建了個空章節佔位，仍然是「寫這一章」。
  test('章節檔案在但是空的 → 按沒寫算', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 0 })), 'manuscript');
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 0 })), 'plot');
  });

  test('寫了但不到目標的八成 → 還在待寫正文（接著寫）', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 1000, targetWords: 3000 })),
      'manuscript'
    );
  });

  test('寫到八成 → 待定稿', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 2400, targetWords: 3000 })),
      'finalize'
    );
  });

  test('目標字數缺席時有字就算寫夠', () => {
    assert.equal(pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 10 })), 'finalize');
  });

  test('細綱在正文之後改過 → 回到寫正文（重寫）', () => {
    assert.equal(
      pipeline.deriveStage(facts({ plotFilled: true, chapterExists: true, words: 3000, upstreamStale: true })),
      'manuscript'
    );
  });

  test('摘要在且新鮮 → 已完成', () => {
    assert.equal(
      pipeline.deriveStage(
        facts({ plotFilled: true, chapterExists: true, words: 3000, summaryExists: true, summaryStale: false })
      ),
      'done'
    );
  });

  // 定稿過的章即使細綱後來改了也不拉回「待寫」——那是作者已經認可的文字。
  test('定稿過、細綱後來改了 → 仍是已完成', () => {
    assert.equal(
      pipeline.deriveStage(
        facts({ chapterExists: true, words: 3000, upstreamStale: true, summaryExists: true, summaryStale: false })
      ),
      'done'
    );
  });

  test('摘要過期（正文改過）→ 回到待定稿', () => {
    assert.equal(
      pipeline.deriveStage(facts({ chapterExists: true, words: 3000, summaryExists: true, summaryStale: true })),
      'finalize'
    );
  });

  test('作者宣佈過了 → 已完成', () => {
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 100, targetWords: 3000, markedDone: true })), 'done');
  });

  // 老工程：只有正文、沒有細綱。不倒回去要求補細綱。
  test('只有正文、沒有細綱 → 待定稿，不回到寫細綱', () => {
    assert.equal(pipeline.deriveStage(facts({ chapterExists: true, words: 3000 })), 'finalize');
  });
});

describe('pipeline.ts · 三段完成度', () => {
  test('每一段只報它自己', () => {
    const p = pipeline.deriveProgress({
      ...pipeline.emptyFacts(),
      chapterExists: true,
      words: 1200,
      targetWords: 3000,
    });
    assert.deepEqual(p, { plot: 0, manuscript: 0.5, summary: 0 });
  });

  test('寫夠之後正文滿格；摘要新鮮才算定稿', () => {
    const p = pipeline.deriveProgress({
      ...pipeline.emptyFacts(),
      plotFilled: true,
      chapterExists: true,
      words: 2400,
      targetWords: 3000,
      summaryExists: true,
      summaryStale: false,
    });
    assert.deepEqual(p, { plot: 1, manuscript: 1, summary: 1 });
  });

  test('manuscriptRatio：沒字是 0，沒有目標有字就是 1', () => {
    assert.equal(pipeline.manuscriptRatio({ words: 0, targetWords: 3000 }), 0);
    assert.equal(pipeline.manuscriptRatio({ words: 5 }), 1);
    assert.equal(pipeline.manuscriptRatio({ words: 1200, targetWords: 1000 }), 1);
  });
});

describe('pipeline.ts · 單章下一步', () => {
  const next = (stage, over = {}) =>
    pipeline.deriveNextStep(stage, { no: 12, words: 0, ratio: 0, upstreamStale: false, ...over });

  test('待寫細綱 → 寫第 N 章細綱', () => {
    const s = next('plot');
    assert.equal(s.stage, 'plot');
    assert.equal(s.capability, 'generate');
    assert.equal(s.label, '寫第 12 章細綱');
  });

  test('待寫正文 · 沒字 → 寫第 N 章', () => {
    assert.equal(next('manuscript').label, '寫第 12 章');
  });

  test('待寫正文 · 有字沒寫夠 → 接著寫，並說清寫了多少', () => {
    const s = next('manuscript', { words: 1200, ratio: 0.5 });
    assert.equal(s.label, '接著寫');
    assert.match(s.hint, /1200 字/);
    assert.match(s.hint, /50%/);
  });

  test('待寫正文 · 細綱改過 → 重寫第 N 章', () => {
    assert.equal(next('manuscript', { words: 3000, ratio: 1, upstreamStale: true }).label, '重寫第 12 章');
  });

  test('待定稿 → 工程動作 finalizeChapter，停在正文層', () => {
    const s = next('finalize');
    assert.equal(s.projectAction, 'finalizeChapter');
    assert.equal(s.stage, 'manuscript');
  });

  test('已完成 → 不給（呼叫方轉去問全書）', () => {
    assert.equal(next('done'), undefined);
  });

  test('單章下一步不自帶 target（落點就是那一章）', () => {
    assert.equal(next('plot').target, undefined);
  });
});

// ---------------------------------------------------------------- 全書狀態機

describe('pipeline.ts · 全書狀態推導', () => {
  const all = { config: true, premise: true, characters: true, world: true, lore: true };
  const book = (over = {}) => ({
    settings: all,
    outlineFilled: true,
    outlineCoverage: 20,
    totalChapters: 100,
    nextChapterNo: 1,
    nextPlotFilled: false,
    plotFilledNos: [],
    ...over,
  });

  test('架構缺哪件推哪件，按 配置 → 前提 → 角色 → 世界觀 → 設定清單 的順序', () => {
    const order = [];
    let settings = { config: false, premise: false, characters: false, world: false, lore: false };
    for (const doc of pipeline.SETTING_DOCS) {
      const f = book({ settings });
      assert.equal(pipeline.deriveBookStage(f), 'setting');
      const step = pipeline.deriveBookNextStep('setting', f);
      order.push(step.target.doc);
      settings = { ...settings, [doc]: true };
    }
    assert.deepEqual(order, ['config', 'premise', 'characters', 'world', 'lore']);
    // 五件齊了才輪到情節大綱。
    assert.equal(pipeline.deriveBookStage(book({ settings, outlineFilled: false, outlineCoverage: 0 })), 'outline');
  });

  test('世界觀之後、情節大綱之前是設定清單：按鈕、提示與 target', () => {
    const f = book({ settings: { ...all, lore: false }, outlineFilled: false, outlineCoverage: 0 });
    assert.equal(pipeline.deriveBookStage(f), 'setting');
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.label, '生成設定清單');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'lore' });
    assert.match(s.hint, /地點、勢力、能力體系、關鍵物品/);
    assert.equal(s.form, undefined);
  });

  // 作者定案：在寫的書不被新加的這一件推回架構。判據只在純函式層寫一次，讀盤在 settingFilled。
  test('設定清單「填過」：有條目，或者這本書已經有正文', () => {
    assert.equal(pipeline.isLoreListFilled(0, false), false);
    assert.equal(pipeline.isLoreListFilled(3, false), true);
    assert.equal(pipeline.isLoreListFilled(0, true), true);
  });

  test('已經寫了正文、一條設定都沒有的書：照常往下走，不被推回架構', () => {
    const lore = pipeline.isLoreListFilled(0, true);
    const f = book({ settings: { ...all, lore }, nextChapterNo: 31, outlineCoverage: 40, nextPlotFilled: true });
    assert.equal(pipeline.deriveBookStage(f), 'writing');
  });

  test('架構那一檔的按鈕與 target', () => {
    const f = book({ settings: { ...all, premise: false } });
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.label, '生成故事前提');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'premise' });
    assert.equal(s.stage, 'setting');
  });

  test('大綱沒寫 → 生成情節大綱（第 1–20 章）', () => {
    const f = book({ outlineFilled: false, outlineCoverage: 0 });
    assert.equal(pipeline.deriveBookStage(f), 'outline');
    const s = pipeline.deriveBookNextStep('outline', f);
    assert.deepEqual(s.range, { from: 1, to: 20 });
    assert.equal(s.label, '生成情節大綱（第 1–20 章）');
    assert.deepEqual(s.target, { kind: 'outline' });
  });

  test('總章數不足 20 時區間收在總章數', () => {
    const s = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0, totalChapters: 12 }));
    assert.deepEqual(s.range, { from: 1, to: 12 });
  });

  test('下一章超出大綱覆蓋 → 續寫情節大綱，從覆蓋的下一章起', () => {
    const f = book({ outlineCoverage: 20, nextChapterNo: 21 });
    assert.equal(pipeline.deriveBookStage(f), 'outline');
    const s = pipeline.deriveBookNextStep('outline', f);
    assert.deepEqual(s.range, { from: 21, to: 40 });
    assert.match(s.label, /^續寫情節大綱/);
  });

  // 散文式大綱（沒有區間標題）覆蓋視為 Infinity：說不上覆蓋到哪，就不攔。
  test('大綱覆蓋是 Infinity 時不推續寫', () => {
    assert.equal(pipeline.deriveBookStage(book({ outlineCoverage: Infinity, nextChapterNo: 300, totalChapters: undefined })), 'plots');
  });

  // 第 25–31 章沒有正文、後面還有 51 章：照「寫到第 24 章」續寫大綱，後面那些會被當成沒寫過。
  test('正文斷了一截 → 大綱那一檔推「把章號接上」，不推續寫', () => {
    const gap = { from: 25, to: 31, later: 51, last: 82 };
    const s = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 24, nextChapterNo: 25, gap }));
    assert.equal(s.projectAction, 'chapterGap');
    assert.equal(s.label, '第 25–31 章缺正文…');
    assert.match(s.hint, /51 章已寫（寫到第 82 章）/);
    assert.equal(s.calls, undefined);
    assert.deepEqual(s.target, { kind: 'outline' });
  });

  test('正文斷了一截 → 架構那一檔也不推補齊', () => {
    const gap = { from: 1, to: 3, later: 10, last: 13 };
    const s = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, world: false }, gap }));
    assert.equal(s.projectAction, 'chapterGap');
    assert.deepEqual(s.target, { kind: 'setting', doc: 'world' });
  });

  test('斷了一截但大綱已覆蓋缺口：拆細綱、寫正文照常（跳著寫是作者的自由）', () => {
    const f = book({ outlineCoverage: 40, nextChapterNo: 25, gap: { from: 25, to: 31, later: 9, last: 40 } });
    assert.equal(pipeline.deriveBookStage(f), 'plots');
    assert.equal(pipeline.deriveBookNextStep('plots', f).projectAction, undefined);
  });

  // 作者自己點的續寫（`/續寫大綱`、工程頁右鍵）：任何時候都能點，區間與主按鈕同一個演算法。
  test('outlineNextRange：從覆蓋的下一章起 20 章，收在總章數；還沒有大綱從第 1 章起', () => {
    assert.deepEqual(pipeline.outlineNextRange(book({ outlineCoverage: 82 })), { from: 83, to: 100 });
    assert.deepEqual(pipeline.outlineNextRange(book({ outlineCoverage: 40, totalChapters: undefined })), { from: 41, to: 60 });
    assert.deepEqual(pipeline.outlineNextRange(book({ outlineFilled: false, outlineCoverage: 0 })), { from: 1, to: 20 });
  });

  test('outlineContinuation：主按鈕還在推寫正文時也續得了', () => {
    const f = book({ outlineCoverage: 90, nextChapterNo: 83, nextPlotFilled: false, totalChapters: 200 });
    assert.equal(pipeline.deriveBookStage(f), 'plots');
    assert.deepEqual(pipeline.outlineContinuation(f), { range: { from: 91, to: 110 } });
  });

  test('outlineContinuation：排到最後一章了不續，說總章數', () => {
    const r = pipeline.outlineContinuation(book({ outlineCoverage: 100, nextChapterNo: 83 }));
    assert.match(r.blocked, /已經排到第 100 章，全書共 100 章/);
  });

  test('outlineContinuation：要續的那一段裡有已寫的正文不續，指去從已寫正文補齊', () => {
    const r = pipeline.outlineContinuation(book({ outlineCoverage: 20, nextChapterNo: 31 }));
    assert.match(r.blocked, /情節大綱只排到第 20 章，可第 21–30 章裡已經有正文/);
    assert.match(r.blocked, /從已寫正文補齊/);
    const none = pipeline.outlineContinuation(book({ outlineFilled: false, outlineCoverage: 0, nextChapterNo: 4 }));
    assert.match(none.blocked, /^還沒有情節大綱，可第 1–3 章裡已經有正文/);
    // 斷了一截：缺口後面寫到第 82 章，大綱卻只排到第 24 章。
    const gap = { from: 25, to: 31, later: 51, last: 82 };
    assert.match(pipeline.outlineContinuation(book({ outlineCoverage: 24, nextChapterNo: 25, gap })).blocked, /第 25–82 章裡已經有正文/);
  });

  test('下一章沒有細綱 → 拆細綱，一批 5 章', () => {
    const f = book({ nextChapterNo: 6 });
    assert.equal(pipeline.deriveBookStage(f), 'plots');
    const s = pipeline.deriveBookNextStep('plots', f);
    assert.deepEqual(s.range, { from: 6, to: 10 });
    assert.equal(s.label, '拆細綱（第 6–10 章）');
    assert.equal(s.stage, 'plot');
    // 細綱的路徑由呼叫方用檔名規則補，純函式給不出。
    assert.equal(s.target, undefined);
  });

  test('拆細綱的區間不越過大綱覆蓋與總章數', () => {
    assert.deepEqual(pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 18 })).range, { from: 18, to: 20 });
    assert.deepEqual(
      pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 99, outlineCoverage: 200, totalChapters: 100 })).range,
      { from: 99, to: 100 }
    );
  });

  test('只剩一章時按鈕說「第 N 章」而不是「第 N–N 章」', () => {
    const s = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 20 }));
    assert.equal(s.label, '拆細綱（第 20 章）');
  });

  // 主按鈕那一批永遠是空白：第 8 章已經排過，第 6 章起的這一批收在第 7 章。
  test('拆細綱的區間在第一份已有細綱之前收住', () => {
    const s = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 6, plotFilledNos: [1, 2, 3, 4, 5, 8, 9] }));
    assert.deepEqual(s.range, { from: 6, to: 7 });
    assert.equal(s.label, '拆細綱（第 6–7 章）');
  });

  test('每一檔都寫明要調幾次模型', () => {
    const none = { config: false, premise: false, characters: false, world: false, lore: false };
    const config = pipeline.deriveBookNextStep('setting', book({ settings: none }));
    assert.deepEqual(config.calls, pipeline.CONFIG_CALLS);
    // 2026-10-25 起寫完轉寫一次：寫 1 + 轉寫 1；截斷重寫、重轉、全域要求重寫各 1。
    assert.deepEqual([config.calls.low, config.calls.high, config.calls.max], [2, 2, 5]);
    assert.ok(config.calls.why.includes('轉寫'), config.calls.why);
    // 配置要先填一句話與規模，主按鈕開啟表單而不是直接傳送。
    assert.equal(config.form, 'idea');

    const roster = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, characters: false } }));
    // 清單 1 次 + 詳情每批 3 人，每次寫完轉寫 1 次；上限：清單寫 2 + 轉寫 2，詳情寫 13 次、各轉寫 1 次，再重轉 1 次。
    assert.deepEqual([roster.calls.low, roster.calls.high, roster.calls.max], [4, 8, 31]);
    assert.equal(roster.form, undefined);

    const premise = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, premise: false } }));
    assert.deepEqual(premise.calls, pipeline.ONE_CALL);

    // 設定清單：清單 1 次 + 詳情每批 6 條（12–30 條），每次寫完轉寫 1 次；上限封頂 24（寫與轉寫都算）。
    const lore = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, lore: false } }));
    assert.deepEqual([lore.calls.low, lore.calls.high, lore.calls.max], [6, 12, 24]);
    assert.deepEqual(pipeline.loreListCalls(), lore.calls);
    assert.equal(pipeline.LORE_LIST_CALLS_MAX, 24);
    assert.deepEqual(pipeline.settingCalls('lore'), lore.calls);
    assert.deepEqual(pipeline.settingCalls('characters'), pipeline.rosterCalls());

    const outline = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0 }));
    assert.deepEqual(outline.calls, pipeline.ONE_CALL);

    // 一批 5 章：通常 1 次，上限 3n（上游 blueprint-batch-policy 的式子）。
    const plots = pipeline.deriveBookNextStep('plots', book({ nextChapterNo: 1 }));
    // 細綱試點：寫 1 次、轉寫 1 次；上限 6n − 1。
    const { why, ...plotCalls } = plots.calls;
    assert.deepEqual(plotCalls, { low: 2, high: 2, max: 29 });
    assert.ok(why.includes('轉寫'), why);
  });

  test('下一章有細綱 → 在寫（交給單章狀態機）', () => {
    const f = book({ nextPlotFilled: true, nextChapterNo: 3 });
    assert.equal(pipeline.deriveBookStage(f), 'writing');
    assert.equal(pipeline.deriveBookNextStep('writing', f), undefined);
  });

  test('寫滿總章數 → 寫完了，不給按鈕', () => {
    const f = book({ nextChapterNo: 101, outlineCoverage: 100 });
    assert.equal(pipeline.deriveBookStage(f), 'complete');
    assert.equal(pipeline.deriveBookNextStep('complete', f), undefined);
  });

  test('沒寫總章數就沒有「寫完了」', () => {
    assert.notEqual(pipeline.deriveBookStage(book({ totalChapters: undefined, nextChapterNo: 500 })), 'complete');
  });

  // D11：老工程（有正文、沒有架構）被推回第一格——新鏈路寫正文要讀前提、角色與世界觀。
  // 拆書 A 之後這一格的動作換成「從已寫正文補齊」：照正文整理，不從一句話重新編。
  test('有正文但沒有架構的老工程 → 先補架構，動作是從已寫正文補齊', () => {
    const f = book({ settings: { config: false, premise: false, characters: true, world: false, lore: true }, nextChapterNo: 100 });
    assert.equal(pipeline.deriveBookStage(f), 'setting');
    const s = pipeline.deriveBookNextStep('setting', f);
    assert.equal(s.target.doc, 'config');
    assert.equal(s.projectAction, 'deriveFromText');
    assert.equal(s.label, '從已寫正文補齊…');
    assert.equal(s.form, undefined);
    // 次數要讀摘要才算得準：確認框裡報，主按鈕不帶。
    assert.equal(s.calls, undefined);
    assert.match(s.hint, /第 1–99 章/);
    assert.match(s.hint, /小說配置/);
  });

  test('還沒有正文時架構那一檔照舊（一句話表單）', () => {
    const s = pipeline.deriveBookNextStep('setting', book({ settings: { ...all, config: false }, nextChapterNo: 1 }));
    assert.equal(s.form, 'idea');
    assert.equal(s.projectAction, undefined);
  });

  test('大綱沒覆蓋到已寫的章 → 從已寫正文補齊，不往前規劃', () => {
    const none = pipeline.deriveBookNextStep('outline', book({ outlineFilled: false, outlineCoverage: 0, nextChapterNo: 31 }));
    assert.equal(none.projectAction, 'deriveFromText');
    assert.deepEqual(none.target, { kind: 'outline' });
    assert.match(none.hint, /還沒有細綱，情節大綱（各章細綱梗概的彙總）也就是空的/);

    const short = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 20, nextChapterNo: 31 }));
    assert.equal(short.projectAction, 'deriveFromText');
    assert.match(short.hint, /第 21–30 章還沒有細綱，情節大綱只覆蓋到第 20 章/);
  });

  test('大綱恰好覆蓋到已寫的最後一章 → 照常續寫大綱', () => {
    const s = pipeline.deriveBookNextStep('outline', book({ outlineCoverage: 30, nextChapterNo: 31 }));
    assert.equal(s.projectAction, undefined);
    assert.deepEqual(s.range, { from: 31, to: 50 });
  });
});

// ---------------------------------------------------------------- 細綱批次與呼叫次數

describe('pipeline.ts · 批次拆細綱的切分', () => {
  test('跳過已有細綱的章，剩下的按連續段切、每批不超過 5 章', () => {
    const plan = pipeline.planPlotBatches({ from: 1, to: 14, filledNos: [4, 5] });
    assert.deepEqual(plan.skipped, [4, 5]);
    assert.deepEqual(plan.chapters, [1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // 第 4、5 章把區間斷開：1–3 一批；6–14 再按 5 章切。
    assert.deepEqual(plan.batches, [[1, 2, 3], [6, 7, 8, 9, 10], [11, 12, 13, 14]]);
    // 三批各 2 次（寫 1 次、轉寫 1 次）；上限每批 6n − 1 加總。有敘事線時不排線。
    assert.deepEqual(plan.calls, { low: 6, high: 6, max: 69 });
  });

  // 敘事線重做（設計稿 ⚑8）：一條線都沒有時開拆之前先從情節大綱排一次；拆完不再排。2026-10-25 起排線也轉寫：排 1 次、轉寫 1 次，最多 3 次。
  test('一條敘事線都沒有：先排一次，加 THREAD_PLAN_CALLS（2 次，最多 3 次）；沒有要拆的就不排', () => {
    assert.deepEqual(pipeline.THREAD_PLAN_CALLS, { low: 2, high: 2, max: 3, why: '排 1 次、轉寫模型照抄成 JSON 1 次；轉寫不合格重轉 1 次' });
    const plan = pipeline.planPlotBatches({ from: 1, to: 14, filledNos: [4, 5], planThreads: true });
    assert.deepEqual(plan.calls, { low: 8, high: 8, max: 72 });
    const none = pipeline.planPlotBatches({ from: 7, to: 5, filledNos: [5, 6, 7], planThreads: true });
    assert.deepEqual(none.calls, { low: 0, high: 0, max: 0 });
  });

  // 2026-10-25 起敘事線判一章的幾次都轉寫：認事件 / 歸併 / 當前進度各寫 1 次、轉寫 1 次、不合格重轉 1 次。
  test('敘事線判一章 2–6 次、最多 9 次；補記 n 章是 n 倍，先排線再加排線那一份', () => {
    const { low, high, max, why } = pipeline.THREADS_JUDGE_CALLS;
    assert.deepEqual({ low, high, max }, { low: 2, high: 6, max: 9 });
    assert.ok(why.includes('每寫一次轉寫模型照抄成 JSON 1 次，轉寫不合格重轉 1 次'), why);
    assert.deepEqual(pipeline.threadsBackfillCalls(3, false), { low: 6, high: 18, max: 27 });
    assert.deepEqual(pipeline.threadsBackfillCalls(3, true), { low: 8, high: 20, max: 30 });
  });

  test('區間寫反了照樣認；全都排過時一批都沒有', () => {
    const plan = pipeline.planPlotBatches({ from: 7, to: 5, filledNos: [5, 6, 7] });
    assert.equal(plan.from, 5);
    assert.equal(plan.to, 7);
    assert.deepEqual(plan.batches, []);
    assert.deepEqual(plan.calls, { low: 0, high: 0, max: 0 });
  });

  test('呼叫次數的說法', () => {
    assert.equal(pipeline.describeCalls({ low: 1, high: 1, max: 1 }), '預計 1 次呼叫');
    assert.equal(pipeline.describeCalls({ low: 1, high: 1, max: 15 }), '預計 1 次呼叫，最多 15 次');
    assert.equal(pipeline.describeCalls({ low: 2, high: 4, max: 16 }), '預計 2–4 次呼叫，最多 16 次');
  });

  test('單章的下一步也寫呼叫次數', () => {
    assert.deepEqual(pipeline.deriveNextStep('plot', { no: 3, words: 0, ratio: 0, upstreamStale: false }).calls, pipeline.PLOT_CALLS);
    assert.deepEqual({ ...pipeline.PLOT_CALLS, why: '' }, { low: 2, high: 2, max: 3, why: '' });
  });

  // D17：定稿 = 摘要 + 出場角色的當前狀態；敘事線重做之後敘事線 1–3 次（認事件每次都跑，設計稿 ⚑6），故事時間 1 次，
  // 所以最少寫 3 次。2026-10-25 起每次寫完都轉寫一次、不合格各重轉一次。
  test('定稿第 N 章報「預計 6–12 次呼叫，最多 18 次」，並說清各做什麼、寫幾次轉寫幾次', () => {
    const step = pipeline.deriveNextStep('finalize', { no: 3, words: 900, ratio: 1, upstreamStale: false });
    assert.equal(step.label, '同步第 3 章');
    assert.equal(step.projectAction, 'finalizeChapter');
    assert.deepEqual(step.calls, pipeline.FINALIZE_CALLS);
    assert.equal(
      pipeline.describeCalls(step.calls),
      '預計 6–12 次呼叫，最多 18 次（照正文更新細綱 1 次；本章出場的人有角色卡時更新角色狀態 1 次；敘事線認事件 1 次，有線動過時更新當前進度 1 次，認出新線或新伏筆時歸併 1 次；故事時間 1 次——寫 3–6 次，每次寫完由轉寫模型照抄成 JSON 1 次（轉寫 3–6 次），轉寫不合格各重轉 1 次）'
    );
  });

  // D16：自動續寫算進呼叫次數，動手之前寫明上限。
  test('寫正文的三種下一步都報「1–2 次，最多 9 次」，並說清為什麼', () => {
    const f = { no: 3, words: 0, ratio: 0, upstreamStale: false };
    const steps = [
      pipeline.deriveNextStep('manuscript', f),
      pipeline.deriveNextStep('manuscript', { ...f, words: 900, ratio: 0.4 }),
      pipeline.deriveNextStep('manuscript', { ...f, words: 3000, ratio: 1, upstreamStale: true }),
    ];
    for (const s of steps) {
      assert.deepEqual(s.calls, pipeline.WRITE_CALLS);
    }
    assert.equal(pipeline.WRITE_CALLS.max, 2 + pipeline.MAX_CONTINUE_ROUNDS);
    assert.equal(pipeline.describeCalls(pipeline.WRITE_CALLS), '預計 1–2 次呼叫，最多 9 次（開著刪修飾時寫完再刪 1 次；沒寫夠時自動續寫，最多再續 7 輪）');
  });

  test('加總時不帶原因（幾件事的原因拼不成一句話）', () => {
    assert.equal(pipeline.addCalls(pipeline.WRITE_CALLS, pipeline.WRITE_CALLS).why, undefined);
  });
});

describe('pipeline.ts · 寫正文的寫法', () => {
  const f = { no: 12, words: 0, ratio: 0, upstreamStale: false };

  test('沒字 → 不帶寫法（由磁碟定：新建）', () => {
    assert.equal(pipeline.deriveNextStep('manuscript', f).writeMode, undefined);
  });

  test('接著寫 → continue（追加）', () => {
    assert.equal(pipeline.deriveNextStep('manuscript', { ...f, words: 800, ratio: 0.3 }).writeMode, 'continue');
  });

  test('重寫第 N 章 → rewrite（覆蓋前審閱）', () => {
    const s = pipeline.deriveNextStep('manuscript', { ...f, words: 3000, ratio: 1, upstreamStale: true });
    assert.equal(s.writeMode, 'rewrite');
    assert.match(s.hint, /對比/);
  });

  test('isWriteMode 只認三種', () => {
    assert.ok(['write', 'continue', 'rewrite'].every(pipeline.isWriteMode));
    assert.ok(![undefined, 'append', '', 3].some(pipeline.isWriteMode));
  });
});

// ---------------------------------------------------------------- 批次寫章（四期，W9）

describe('pipeline.ts · 批次寫章的切分', () => {
  const base = { mode: 'draft', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };

  // 寫前比對 2026-10-25 起多一次轉寫：比對 1 次、轉寫 1 次、重轉 1 次。
  test('只寫正文：一章 1–2 次、最多 9 次，加寫前比對 0–2 次、最多 3 次，按件加總', () => {
    const plan = pipeline.planWriteBatch({ ...base, from: 1, to: 3 });
    assert.deepEqual(plan.chapters, [1, 2, 3]);
    assert.deepEqual(plan.plotBatches, []);
    assert.deepEqual(plan.calls, { low: 3, high: 12, max: 36 });
  });

  test('寫完即定稿：每章再加定稿的 6–12 次（最多 18 次）', () => {
    const plan = pipeline.planWriteBatch({ ...base, mode: 'finalize', from: 1, to: 3 });
    assert.deepEqual(plan.calls, { low: 21, high: 48, max: 90 });
    assert.equal(plan.mode, 'finalize');
    assert.equal(plan.review, false);
  });

  // 五期補遺 §4：審稿與定稿各算各的。2026-10-25 起審稿多一次轉寫：一章 2 次、最多 7 次（審 3 次、轉寫 4 次）。
  test('寫完即審稿：每章再加審稿的 2 次（最多 7 次）；與定稿疊加', () => {
    const plan = pipeline.planWriteBatch({ ...base, review: true, from: 1, to: 3 });
    assert.equal(plan.review, true);
    assert.deepEqual(plan.calls, { low: 9, high: 18, max: 57 });
    const both = pipeline.planWriteBatch({ ...base, mode: 'finalize', review: true, from: 1, to: 3 });
    assert.deepEqual(both.calls, { low: 27, high: 54, max: 111 });
  });

  // 第 19 條批次那一面：已有產物的一律跳過，不問、不覆蓋。
  test('已有正文的章跳過，不斷開區間', () => {
    const plan = pipeline.planWriteBatch({ ...base, writtenNos: [2], from: 1, to: 4 });
    assert.deepEqual(plan.skipped, [2]);
    assert.deepEqual(plan.chapters, [1, 3, 4]);
    assert.equal(plan.stopAt, undefined);
  });

  // 後面的章要接著它的結尾寫：跳過一章沒細綱的去寫後面的，寫出來接不上。
  test('不給大綱覆蓋：遇到第一章沒有細綱的就在它前面收住', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 4, 5], from: 1, to: 5 });
    assert.deepEqual(plan.chapters, [1, 2]);
    assert.equal(plan.stopAt, 3);
  });

  // 百章實驗覆盤：細綱一次拆完、看不到正文。大綱覆蓋到的章寫到時再拆。
  test('邊寫邊拆：大綱覆蓋之內沒細綱的章照寫，連續的空白章每 5 章一批，拆細綱的呼叫算進去', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 9], from: 1, to: 10, outlineCoverage: 20 });
    assert.deepEqual(plan.chapters, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(plan.plotBatches, [[3, 4, 5, 6, 7], [8], [10]]);
    assert.equal(plan.stopAt, undefined);
    const writing = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 1, to: 10 }).calls;
    // 三批細綱各 2 次（寫 1 次、轉寫 1 次；上限 6n − 1）。邊寫邊拆不排敘事線（敘事線重做：計劃隨細綱寫進線裡，不再拆完排一次）。
    assert.deepEqual(plan.calls, { low: writing.low + 6, high: writing.high + 6, max: writing.max + 29 + 5 + 5 });
  });

  test('邊寫邊拆：超出大綱覆蓋的第一章在它前面收住', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1], from: 1, to: 6, outlineCoverage: 4 });
    assert.deepEqual(plan.chapters, [1, 2, 3, 4]);
    assert.deepEqual(plan.plotBatches, [[2, 3, 4]]);
    assert.equal(plan.stopAt, 5);
  });

  test('邊寫邊拆：已有正文的章把批斷開', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [], writtenNos: [3], from: 1, to: 5, outlineCoverage: 10 });
    assert.deepEqual(plan.plotBatches, [[1, 2], [4, 5]]);
  });

  test('寫完即定稿：全文大綱落後 10 章就在那一章定稿之後更新一次，各算 1 次；只寫正文不更新', () => {
    const filled = Array.from({ length: 30 }, (_, i) => i + 1);
    const plan = pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, writtenNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 11, to: 20, globalSummaryThrough: 3 });
    assert.deepEqual(plan.globalSummaryAt, [13]);
    const none = pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, from: 11, to: 20, globalSummaryThrough: 10 });
    assert.deepEqual(none.globalSummaryAt, [20]);
    assert.equal(none.calls.low - pipeline.planWriteBatch({ ...base, mode: 'finalize', plotFilledNos: filled, from: 11, to: 20, globalSummaryThrough: 11 }).calls.low, 1);
    assert.deepEqual(pipeline.planWriteBatch({ ...base, plotFilledNos: filled, from: 11, to: 20 }).globalSummaryAt, []);
  });

  test('一次最多 10 章；寫滿了就不再往後看細綱', () => {
    const plan = pipeline.planWriteBatch({ ...base, plotFilledNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 1, to: 20 });
    assert.equal(plan.chapters.length, pipeline.WRITE_BATCH_MAX);
    assert.equal(plan.stopAt, undefined, '第 11 章沒細綱，但本來就寫不到它');
  });

  test('區間寫反了照樣認；全寫過時一章都沒有、零呼叫', () => {
    const plan = pipeline.planWriteBatch({ ...base, writtenNos: [3, 4], from: 4, to: 3 });
    assert.equal(plan.from, 3);
    assert.deepEqual(plan.chapters, []);
    assert.deepEqual(plan.calls, { low: 0, high: 0, max: 0 });
  });

  test('isWriteBatchMode 只認兩種', () => {
    assert.ok(['draft', 'finalize'].every(pipeline.isWriteBatchMode));
    assert.ok(![undefined, 'review', ''].some(pipeline.isWriteBatchMode));
  });
});

// 敘事線二期（設計稿「四、寫前檢查」）：兩類提醒，零呼叫、不攔人。前端批次寫章彈窗與後端確認框同一個函式、同一句。
describe('pipeline.ts · 寫前檢查的敘事線提醒', () => {
  const watch = {
    lines: [
      { name: '青崖舊案', kind: '主线', lastActive: 1, stall: 5, planned: [] },
      { name: '林昭與沈青', kind: '感情线', lastActive: 2, stall: 15, planned: [7] },
      { name: '斷劍', kind: '支线', lastActive: 1, stall: 15, planned: [] },
      { name: '師父', kind: '人物线', lastActive: 1, stall: 15, planned: [9] },
    ],
    foreshadowing: [
      { name: '玉佩的來歷', resolve: 5, planned: [] },
      { name: '舊傷', resolve: 6, planned: [7] },
      { name: '名冊', resolve: 20, planned: [] },
    ],
  };

  test('一章：寫第 N 章時按第 N − 1 章算，過了回收章、斷了 K 章，本章計劃裡也沒有的才提', () => {
    assert.deepEqual(pipeline.threadRemindersFor(watch, [7]), [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 5, at: 7 },
      { kind: 'stalled', name: '青崖舊案', lineKind: '主线', gap: 5, at: 7 },
    ]);
    // 第 6 章：主線只斷了 4 章；舊傷第 6 章前收，寫第 6 章時還不算過。
    assert.deepEqual(pipeline.threadRemindersFor(watch, [6]).map((r) => r.name), ['玉佩的來歷']);
    // 第 8 章：舊傷第 7 章的計劃在這一章之外，照報。
    assert.deepEqual(pipeline.threadRemindersFor(watch, [8]).map((r) => r.name), ['玉佩的來歷', '舊傷', '青崖舊案']);
  });

  test('一批：區間裡哪一章安排過都算；at 是第一個對上的那一章；沒有 watch 或區間是空的不提', () => {
    assert.deepEqual(pipeline.threadRemindersFor(watch, [8, 6, 7]), [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 5, at: 6 },
      { kind: 'stalled', name: '青崖舊案', lineKind: '主线', gap: 5, at: 7 },
    ]);
    assert.deepEqual(pipeline.threadRemindersFor(undefined, [7]), []);
    assert.deepEqual(pipeline.threadRemindersFor(watch, []), []);
  });

  test('說法：本章與區間裡兩種；注一句沒定稿的那幾章；沒有提醒是空串', () => {
    const one = pipeline.threadRemindersFor(watch, [7]);
    assert.equal(
      pipeline.describeThreadReminders('本章', one),
      '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，還沒收，本章計劃裡也沒安排收；〈青崖舊案〉（主線）已經 5 章沒有進展，本章計劃裡也沒安排推進。只是提醒，照寫不攔。'
    );
    assert.equal(
      pipeline.describeThreadReminders('区间里', pipeline.threadRemindersFor(watch, [6, 7, 8]), pipeline.unrecordedBefore(4, 6)),
      '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，寫到第 6 章還沒收，區間裡也沒安排收；〈青崖舊案〉（主線）寫到第 7 章就斷了 5 章，區間裡也沒安排推進（第 5 章還沒同步或還沒補記，敘事線還沒記上，提醒可能不準）。只是提醒，不攔。'
    );
    assert.equal(pipeline.describeThreadReminders('本章', []), '');
    assert.deepEqual(pipeline.unrecordedBefore(3, 7), { from: 4, to: 6 });
    assert.equal(pipeline.unrecordedBefore(6, 7), undefined);
    assert.equal(pipeline.unrecordedBefore(0, 1), undefined);
  });

  // 復跑報告問題 9：「阿婆的真實身份」計劃第 5 章埋，到第 15 章還是「計劃」，兩類提醒都不管。第三類：計劃埋了卻一直沒埋。
  test('第三類：計劃第 a 章埋、寫第 N 章時 N > a 還沒埋、本章（區間裡）也沒安排埋；已經報了逾期的不再報這一類；老資料沒有這一項不崩', () => {
    const w = {
      ...watch,
      unplanted: [
        { name: '阿婆的真實身份', plant: 5, planned: [] },
        { name: '無面鬼火', plant: 9, planned: [] },
        { name: '祠堂的影子', plant: 6, planned: [8] },
        { name: '玉佩的來歷', plant: 3, planned: [] },
      ],
    };
    assert.deepEqual(pipeline.threadRemindersFor(w, [7]), [
      { kind: 'overdue', name: '玉佩的來歷', resolve: 5, at: 7 },
      { kind: 'unplanted', name: '阿婆的真實身份', plant: 5, at: 7 },
      { kind: 'unplanted', name: '祠堂的影子', plant: 6, at: 7 },
      { kind: 'stalled', name: '青崖舊案', lineKind: '主线', gap: 5, at: 7 },
    ]);
    // 寫第 5 章：阿婆計劃第 5 章埋，還不算過（玉佩第 3 章就該埋了、還沒逾期，報這一類）；第 8 章計劃埋「祠堂的影子」：本章安排了
    // 就不提；一批裡哪一章安排過都算。
    assert.deepEqual(pipeline.threadRemindersFor(w, [5]).filter((r) => r.kind === 'unplanted').map((r) => r.name), ['玉佩的來歷']);
    assert.deepEqual(pipeline.threadRemindersFor(w, [8]).filter((r) => r.kind === 'unplanted').map((r) => r.name), ['阿婆的真實身份']);
    assert.deepEqual(pipeline.threadRemindersFor(w, [7, 8]).filter((r) => r.kind === 'unplanted').map((r) => r.name), ['阿婆的真實身份']);
    assert.equal(
      pipeline.describeThreadReminders('本章', pipeline.threadRemindersFor(w, [8]).filter((r) => r.kind === 'unplanted')),
      '敘事線提醒：伏筆〈阿婆的真實身份〉計劃第 5 章埋，還沒埋，本章計劃裡也沒安排埋。只是提醒，照寫不攔。'
    );
    assert.equal(
      pipeline.describeThreadReminders('区间里', pipeline.threadRemindersFor(w, [10, 11])),
      '敘事線提醒：伏筆〈玉佩的來歷〉計劃第 5 章前收，寫到第 10 章還沒收，區間裡也沒安排收；伏筆〈舊傷〉計劃第 6 章前收，寫到第 10 章還沒收，區間裡也沒安排收；' +
        '伏筆〈阿婆的真實身份〉計劃第 5 章埋，寫到第 10 章還沒埋，區間裡也沒安排埋；伏筆〈無面鬼火〉計劃第 9 章埋，寫到第 10 章還沒埋，區間裡也沒安排埋；伏筆〈祠堂的影子〉計劃第 6 章埋，寫到第 10 章還沒埋，區間裡也沒安排埋；' +
        '〈青崖舊案〉（主線）寫到第 10 章就斷了 8 章，區間裡也沒安排推進。只是提醒，不攔。'
    );
    assert.deepEqual(pipeline.threadRemindersFor(watch, [7]).map((r) => r.kind), ['overdue', 'stalled'], '沒有 unplanted 也不崩');
  });
});
