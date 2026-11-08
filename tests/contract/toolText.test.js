/**
 * 模型每一輪都讀的文字裡，不許再有舊鏈路的說法。
 *
 * 卷、劇情段、中轉站、拆章隨一期重構從程式碼裡刪掉了，但工具描述是字串——刪程式碼不會讓它
 * 編譯不過，也沒有哪條行為測試會因為一句過時的說明變紅。而模型是照著這些字去找路徑、
 * 填引數的：`list` 的說明裡寫著「卷綱在 .novelwarden/volumes/」，它就會去列一個不存在的
 * 目錄；`search` 的說明裡寫著 `kinds=volume`，它填進去會被靜默丟掉、變成不限種類的搜尋。
 *
 * 只查模型讀得到的那幾處：每個工具的 `description`、每個引數的說明與列舉值、MCP 回給
 * 外部 agent 的 `instructions`。程式碼註釋與 README 裡講「從前……、為什麼刪掉」的歷史說明是有意的，不在這裡。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../helpers/load');

/** 舊鏈路的說法。「卷」單列：它只在作為一個詞出現時算（「捲入」「試卷」不算）。 */
const STALE = ['中轉站', '劇情段', '拆分', '拆成章節', '拆章', '卷綱', 'volumes/', 'manuscripts/', 'beatsHash'];
const VOLUME = /(^|[^入試答畫書])卷(?![入])/;

let bundle;

before(() => {
  bundle = loadBundle({
    tools: './src/core/tools/novel/index.ts',
    instructions: './src/core/mcp/instructions.ts',
  });
});

/** 一個工具裡模型看得見的全部文字：描述、引數說明、列舉值。 */
function textsOf(tool) {
  const props = tool.parameters?.properties ?? {};
  return [
    [`${tool.name}.description`, tool.description],
    ...Object.entries(props).flatMap(([key, p]) => [
      [`${tool.name}.${key}`, p.description ?? ''],
      ...(p.enum ?? []).map((v) => [`${tool.name}.${key}.enum`, v]),
    ]),
  ];
}

function assertClean(where, text) {
  for (const word of STALE) {
    assert.ok(!text.includes(word), `${where} 裡還有「${word}」：${text}`);
  }
  assert.ok(!VOLUME.test(text), `${where} 裡還有「卷」：${text}`);
}

describe('工具說明不提舊鏈路', () => {
  test('十三個工具都查到了', () => {
    assert.equal(bundle.tools.NOVEL_TOOLS.length, 13);
  });

  test('描述、引數說明與列舉值', () => {
    for (const tool of bundle.tools.NOVEL_TOOLS) {
      for (const [where, text] of textsOf(tool)) {
        assertClean(where, text);
      }
    }
  });

  // 「拆分」仍在帶 action 工具的拒絕清單裡（拿著老提示詞來的模型要聽到「這是有意不給的」），
  // 但不許出現在任何一個工具的可用動作列舉裡——否則模型會照著列表去點它。
  test('哪個工具的可用動作裡都沒有 split', () => {
    const withAction = bundle.tools.NOVEL_TOOLS.filter((t) => t.parameters.properties.action);
    assert.ok(withAction.length >= 6, withAction.map((t) => t.name).join(','));
    for (const tool of withAction) {
      assert.ok(!tool.parameters.properties.action.enum.includes('split'), tool.name);
    }
  });
});

describe('MCP 說明不提舊鏈路', () => {
  test('MCP_INSTRUCTIONS', () => {
    const text = String(bundle.instructions.MCP_INSTRUCTIONS);
    assert.ok(text.length > 0);
    assertClean('MCP_INSTRUCTIONS', text);
  });
});
