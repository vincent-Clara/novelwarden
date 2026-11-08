/**
 * 「複製完整上下文」的後端一半：發給模型的那份訊息留在回覆那一輪上、隨會話落盤，
 * 前端點了再經 `copyContext` 要。
 *
 * | 斷言 | 為什麼 |
 * |---|---|
 * | 會話檔案裡那份與模型實際收到的一字不差 | 拿去核對「當時發了什麼」，差一個字就不可信 |
 * | `turnDone` 只帶 `fullContext` 標記，不帶訊息 | 一輪幾萬字，不隨每次推會話來回搬 |
 * | 回覆帶回同一個 `requestId` | 回覆是廣播，兩個檢視都收得到，前端靠它認是不是自己點的 |
 * | 拼出來的文字裡每條訊息原樣都在，開頭就是系統提示 | 複製出去的就是那份，粘進網頁版 AI 就能接著做 |
 * | 老回覆、找不到的輪次回一句為什麼 | 不回空串冒充複製成功 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let controller;
let fake;
let posted = [];

async function discuss(text, reply) {
  fake.push(reply);
  await controller.handle({
    type: 'send',
    payload: {
      text,
      stage: 'outline',
      capability: 'discuss',
      target: { kind: 'outline' },
      targetNo: 0,
      attachments: [],
      excludedIds: [],
    },
  });
}

async function copy(turnId, requestId) {
  posted = [];
  await controller.handle({ type: 'copyContext', turnId, requestId });
  return posted.filter((m) => m.type === 'contextText');
}

const sessionFile = () =>
  JSON.parse(fs.readFileSync(path.join(t.project.sessionsDir, `${controller.current.id}.json`), 'utf8'));
const assistants = (turns) => turns.filter((x) => x.role === 'assistant');

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = makeSettings({ contextWindow: 100000 });
  const h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry);

  t = await makeTempProject(bundle.project, { prefix: 'copy-context', title: '青雲劍錄' });
  controller = new bundle.controller.ChatController(t.project);
  controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });

  await discuss('主角的金手指要不要換？', '可以換成一把會說話的劍。');
  posted = [];
  await discuss('那第一卷怎麼收？', '收在劍認主那一刻。');
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('發出去的那份留在回覆那一輪上', () => {
  test('會話檔案裡兩輪迴復各留一份，與模型實際收到的一字不差', () => {
    const turns = assistants(sessionFile().turns);
    assert.equal(turns.length, 2);
    assert.equal(fake.calls.length, 2);
    for (let i = 0; i < 2; i++) {
      const sent = fake.calls[i].map(({ role, content }) => ({ role, content }));
      assert.deepEqual(turns[i].contextMessages, sent);
    }
  });

  test('第二輪那份帶著第一輪的討論（歷史就是這樣發出去的）', () => {
    const second = assistants(sessionFile().turns)[1].contextMessages;
    assert.ok(second.some((m) => m.role === 'assistant' && m.content.includes('會說話的劍')));
  });

  test('turnDone 只帶 fullContext 標記，訊息不跟著推', () => {
    const done = posted.filter((m) => m.type === 'turnDone' && m.turn.role === 'assistant').at(-1).turn;
    assert.equal(done.fullContext, true);
    assert.equal(done.contextMessages, undefined);
    const system = fake.calls[1].find((m) => m.role === 'system').content;
    assert.ok(posted.every((m) => !JSON.stringify(m).includes(system)), '系統提示全文不該出現在推給前端的任何一條訊息裡');
  });
});

describe('copyContext', () => {
  test('回同一個 requestId，文字裡每條訊息原樣都在', async () => {
    const id = assistants(controller.current.turns)[1].id;
    const replies = await copy(id, 'r1');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].requestId, 'r1');
    assert.equal(replies[0].error, undefined);
    for (const m of fake.calls[1]) {
      assert.ok(replies[0].text.includes(m.content), `少了一條 ${m.role}`);
    }
    // 粘進網頁版 AI 用：開頭就是系統提示，不加說明；帶了歷史，使用者 / 模型那幾條標【我】/【你】。
    const system = fake.calls[1].find((m) => m.role === 'system').content;
    assert.ok(replies[0].text.startsWith(system));
    assert.match(replies[0].text, /\n---\n\n【你】\n可以換成一把會說話的劍。\n/);
  });

  test('功能加上之前的回覆：說沒留下', async () => {
    const turn = assistants(controller.current.turns)[0];
    const kept = turn.contextMessages;
    delete turn.contextMessages;
    try {
      const [reply] = await copy(turn.id, 'r2');
      assert.equal(reply.text, undefined);
      assert.match(reply.error, /沒有留下完整上下文/);
    } finally {
      turn.contextMessages = kept;
    }
  });

  test('找不到這一輪：說找不到', async () => {
    const [reply] = await copy('並不存在', 'r3');
    assert.equal(reply.requestId, 'r3');
    assert.match(reply.error, /找不到這一輪/);
  });
});
