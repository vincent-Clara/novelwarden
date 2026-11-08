/**
 * 訊息氣泡。一條 turn 對應一個 `.msg`：頭部（角色/時刻/字數/⋯ 選單）、附件、
 * 思考過程、**段區**、花銷、上下文明細、行內動作各是一塊。
 *
 * ## 段區：說的話與做的事交替
 *
 * 有段的那一輪畫的是 `turn.segments`——**順序就是它發生的順序**。外部 agent 經 MCP
 * 留下的只有工具條與 generate 卡（它說的話不在這裡）；文欄位只出現在已經移除的內建
 * agent 留下的舊輪次裡：
 *
 * ```
 * 🔧 list 2 項            ┐ 相鄰的工具段並進同一串
 * 🔧 read 19 行           ┘
 * ┌ 我先看看工程現在的結構。      ← 一段文字
 * ✨ 生成 · 情節大綱 · 6104 字   ← generate 單獨一張卡，正文限高滾動
 * ┌ 大綱已經生成並落盤到…        ← 又一段文字
 * ```
 *
 * 沒有段的輪次（單步創作、純聊天）只有一塊正文。
 *
 * **生成中不可編輯**是這裡最要緊的一條：contentEditable 的游標會被後續
 * delta 追加沖掉，使用者改到一半的內容也會被 turnDone 的整體重建覆蓋。
 * 判據是 `store.streamingId`，由 index.ts 在 turnDone 那一刻定下來。
 * **有段的那一輪一律不可編輯**：`editTurn` 的語義是「整輪內容換成這一段文字」，
 * 多塊之間沒法對映；agent 的產物改不改走落盤卡片那條路。
 *
 * **流式時只在貼著底才跟滾**：每來一段 delta 都會 `scrollToBottom()`，
 * 翻上去看前面的氣泡時不該被拽回來（與日誌頁同一條理由）。
 */
import { closestFrom, el as mk, spacer } from '../dom';
import type {
  OutMessage,
  SerializedDigest,
  SerializedToolCall,
  SerializedTurn,
} from '../protocol';
import { linkBtn } from './buttons';
import { countWords, fmt, timeLabel } from './format';
import { toggleButtonMenu } from './menu';
import { onSessionChanged } from './pipeline';
import { el } from './refs';
import { renderState, syncThinkingSelect } from './state';
import { openPath, store, vscode } from './store';
import { toast } from './toast';
import type { SendPayload } from '../protocol';
import { CONTEXT_DETAIL_LABEL, describeWriteLength, isContextDetail } from '../protocol';
import { buildReviewCard } from './review';

/** 由 composer.ts 注入：「重新生成」要帶上輸入框裡當下的那套引數。 */
let currentPayload: () => SendPayload = () => {
  throw new Error('messages.bindPayload 還沒呼叫');
};

export function bindPayload(fn: () => SendPayload): void {
  currentPayload = fn;
}

export function renderSession(session: typeof store.session): void {
  store.session = session;
  store.excluded = new Set();
  el.messages.innerHTML = '';

  if (session.turns.length === 0) {
    el.messages.appendChild(el.emptyHint);
    el.emptyHint.classList.remove('hidden');
  }
  // 「還不是小說工程」那一塊常駐在訊息區裡，顯不顯示由 #messages 的 uninit 類決定（state.ts）。
  el.messages.appendChild(el.initHint);
  for (const turn of session.turns) {
    el.messages.appendChild(buildTurn(turn));
  }

  syncThinkingSelect();
  // 目標下拉框與流水線條都跟著會話走——會話裡的 target 是唯一真相。
  if (store.state) {
    renderState(store.state);
  }
  onSessionChanged();
  // 切會話 / 重放整份：人是要看最新的，強制貼底。
  scrollToBottom(true);
}

export function upsertTurn(turn: SerializedTurn): void {
  el.emptyHint.classList.add('hidden');
  const existing = el.messages.querySelector(`[data-turn="${turn.id}"]`);
  const node = buildTurn(turn);
  if (existing) {
    existing.replaceWith(node);
  } else {
    el.messages.appendChild(node);
  }
  const idx = store.session.turns.findIndex((t) => t.id === turn.id);
  if (idx === -1) {
    store.session.turns.push(turn);
  } else {
    store.session.turns[idx] = turn;
  }
  scrollToBottom();
}

export function bubbleOf(turnId: string): HTMLElement | null {
  return el.messages.querySelector(`[data-turn="${turnId}"]`);
}

/**
 * 氣泡裡**最後**那一串工具條：沒有就在段區末尾現建一個。
 *
 * 「最後」是段區的要點：一輪裡工具串會被文欄位打斷好幾次，新的一次呼叫要接在
 * **當下**那一串上，接到第一串上就等於把順序又抹平了。
 *
 * 工具條與**許可權請求答完那一行**（`.gate-note`，見 gate.ts）都往這裡追加——
 * 它們是同一件事的兩半（先問，再做），排在一起讀起來才是「問了、答了、然後
 * 做了什麼」。問本身不在這裡：那張卡片固定在輸入框上方，不跟著訊息流滾。
 * 就地追加而不是重建氣泡：重建會把正在流的內容沖掉（文字塊是純文字節點，
 * delta 靠 `textContent +=` 追加）。
 */
export function toolStripOf(turnId: string): HTMLElement | null {
  const node = bubbleOf(turnId);
  if (!node) {
    return null;
  }
  // **只有還排在末尾的那一串接得上**：中間說過一句話之後，那一串已經翻篇了，
  // 再往它上面追加等於把這次呼叫挪到那句話前面去。
  const last = lastSegment(node);
  if (last?.classList.contains('tools')) {
    return last as HTMLElement;
  }
  const strip = buildToolStrip();
  node.insertBefore(strip, segmentAnchor(node));
  return strip;
}

/** 段區裡當下的最後一段（工具串 / 文字塊 / generate 卡都算）。 */
export function lastSegment(node: ParentNode): HTMLElement | undefined {
  const segments = node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"], .tools, .gen');
  return segments[segments.length - 1];
}

/**
 * 撤掉那塊**一個字都沒寫過**的正文佔位。
 *
 * 它是一輪剛開始時留的位（見 `buildTurn`）。第一段結果是工具呼叫時，留著它就是
 * 在工具條上方擺一個空盒子，還會讓隨後的文字接不上——段區裡空的文字塊沒有任何
 * 意義（後端那邊 `textOf` 也把空段濾掉了）。
 */
export function dropEmptyText(node: ParentNode): void {
  for (const block of node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]')) {
    if ((block.textContent ?? '') === '') {
      block.remove();
    }
  }
}

/**
 * 段區的末尾：新的一段插在**這個節點前面**。
 *
 * 氣泡的孩子是「頭 / 附件 / 思考 / 段區… / 花銷 / 上下文 / 行內動作」，後三樣
 * 是這一輪的收尾，任何一段新內容都該排在它們之前。三樣都可能不在（跑到一半），
 * 所以按這個順序找第一個在的；全都不在就返回 null（= 追加到末尾）。
 */
export function segmentAnchor(node: ParentNode): Element | null {
  return node.querySelector('.ctx') ?? node.querySelector('.msg-actions');
}

/** 離底多近算「貼著底」。與日誌頁同一檔。 */
const AT_BOTTOM_SLACK = 40;

/**
 * 使用者貼著底時跟著新內容滾；翻上去看前面的氣泡時不該被拽回來。
 *
 * 用滾動事件記賬，而不是在 `scrollToBottom` 裡當場量距離：delta 是先
 * 追加正文再滾，量的時候內容已經變高，貼著底的人會被算成「離底好遠」
 * 從而掉隊。
 */
let follow = true;

function isAtBottom(): boolean {
  const box = el.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_SLACK;
}

/**
 * 滾到訊息流底部。
 *
 * 流式輸出每來一段都會調這裡；**只在原本就貼著底時才跟著滾**——
 * 使用者翻上去看前面的氣泡時不該被拽回來（日誌頁同一條理由）。
 * `force` 給切會話、主動傳送：那是人自己起的頭，應當看到最新。
 */
export function scrollToBottom(force = false): void {
  if (!force && !follow) {
    return;
  }
  el.messages.scrollTop = el.messages.scrollHeight;
  follow = true;
}

export function installMessages(): void {
  el.messages.addEventListener('scroll', () => {
    follow = isAtBottom();
  });
  // 與工程頁那顆「初始化小說工程」同一個動作：初始化流程（問作品名等）在後端。
  el.initHint.addEventListener('click', (e) => {
    if (closestFrom(e.target, '#initProjectBtn')) {
      vscode.postMessage({ type: 'projectAction', action: 'initProject' });
    }
  });
}

function buildTurn(turn: SerializedTurn): HTMLElement {
  const wrap = mk('div', `msg ${turn.role}`);
  wrap.dataset.turn = turn.id;
  if (turn.error) {
    wrap.classList.add('msg-error');
  }

  wrap.appendChild(buildHead(turn));

  if (turn.attachments && turn.attachments.length > 0) {
    wrap.appendChild(buildAttachments(turn.attachments));
  }
  // 思考過程放在正文上方，預設摺疊——它不是正文，但正文遲遲不來時
  // 它是唯一的進度反饋。使用者展開後的狀態由 details 自己維持。
  if (turn.reasoning) {
    wrap.appendChild(buildReasoningDetails(turn.reasoning));
  }
  // 段區：它說的話與它做的事按發生順序交替。沒有段的輪次就是一塊正文。
  // 審稿那一輪（五期 W10）畫報告卡，不畫那段可就地編輯的正文：報告不落盤，改它的文字沒有意義；
  // 正文裡那一份給人讀的文字仍在 `turn.content` 上，「複製」取它。
  if (turn.role === 'assistant' && turn.review && !turn.error) {
    wrap.appendChild(buildReviewCard(turn));
  } else if (turn.role === 'assistant' && turn.segments && turn.segments.length > 0) {
    for (const node of buildSegments(turn)) {
      wrap.appendChild(node);
    }
  } else if (turn.role === 'user' || turn.content || turn.error || store.streamingId === turn.id) {
    // 空的 assistant 正文**只在這一輪正流著的時候**畫：推理模型常常先想幾十秒
    // 才吐第一個字，那段時間介面上得有個東西說「內容長在這兒」。已經結束、又
    // 什麼都沒說的輪次不畫那個空盒子；第一段是工具呼叫時，它會被
    // `appendToolCall` 就地撤掉（一個字都沒寫過的塊留著只是擋路）。
    wrap.appendChild(buildBody(turn));
  }

  if (turn.context) {
    wrap.appendChild(buildContextDetails(turn.context, turn.fullContext ? turn.id : undefined));
  }
  wrap.appendChild(buildActions(turn));
  return wrap;
}

function buildHead(turn: SerializedTurn): HTMLElement {
  const head = mk('div', 'msg-head');
  const role = turn.role === 'user' ? '我' : turn.mcp ? '外部 Agent' : turn.builtinAgent ? '內建 Agent' : '模型';
  head.appendChild(mk('span', 'msg-role', role));
  if (turn.mcp) {
    // 經 MCP 接進來的呼叫（Claude Code 之類）：它說的話不在這裡，這裡只有它做的事。
    const tag = mk('span', 'msg-tag', 'MCP');
    tag.title = '外部 agent 經 MCP 呼叫 Novelwarden 的工具留下的記錄';
    head.appendChild(tag);
  } else if (turn.builtinAgent) {
    const tag = mk('span', 'msg-tag', '已移除');
    tag.title = '已經移除的內建 agent 跑的一輪，只留著回看；討論時不隨歷史帶';
    head.appendChild(tag);
  }
  head.appendChild(mk('span', undefined, timeLabel(turn.at)));

  if (turn.role === 'assistant' && turn.content) {
    head.appendChild(mk('span', undefined, `· ${countWords(turn.content)} 字`));
  }
  if (turn.interrupted) {
    head.appendChild(mk('span', undefined, '· 已中斷'));
  }
  // 低頻且有破壞性的操作（重新生成/刪除）收進右上角的 ⋯，
  // 不和行尾的「開啟」「複製」擠在一起。
  head.appendChild(spacer());
  head.appendChild(buildMenuBtn(turn));
  return head;
}

/**
 * 氣泡正文（**沒有段的那一輪**：單步創作、純聊天）。
 *
 * assistant 那一支**刻意保持成一個純文字節點**：流式增量走的是
 * `body.textContent += delta`（index.ts），裡面有子元素的話第一片增量就會
 * 把它們沖掉；就地編輯的 blur 判據也是拿 `body.textContent` 比 `turn.content`。
 * 要加結構的是 user 那一支。
 *
 * 有段的那一輪畫的是 `buildTextBlock`（只讀）：`editTurn` 換的是**整輪內容**，
 * 而那時正文分成好幾塊，改哪一塊都對映不回去。
 */
function buildBody(turn: SerializedTurn): HTMLElement {
  const body = mk('div', 'msg-body');
  body.dataset.seg = 'text';

  if (turn.role === 'user') {
    delete body.dataset.seg;
    return fillUserBody(body, turn);
  }

  body.textContent = turn.error ? turn.error : turn.content;

  // 結束後（turnDone 會重建這個節點）才放開就地編輯：結果可以改完再採納。
  const streaming = store.streamingId === turn.id;
  if (!turn.error && !streaming) {
    body.setAttribute('contenteditable', 'true');
    body.spellcheck = false;
    body.addEventListener('blur', () => {
      if (body.textContent !== turn.content) {
        turn.content = body.textContent ?? '';
        vscode.postMessage({ type: 'editTurn', turnId: turn.id, text: turn.content });
      }
    });
  }
  return body;
}

/**
 * 使用者氣泡：命令標籤 +（可選的）補充要求。
 *
 * 命令類的輪次 content 本來就是空的——「寫細綱」不需要作者說什麼，該說的
 * 都在大綱和前後幾章的細綱裡（命令一律不要求輸入，見 `commandsFor`）。但**空氣泡不能就這麼空著**：
 * 翻回去看時認不出剛才點的是哪一下。所以把命令本身畫成一枚 `/寫細綱` 標籤。
 */
function fillUserBody(body: HTMLElement, turn: SerializedTurn): HTMLElement {
  if (turn.command) {
    body.classList.add('has-command');
    body.appendChild(mk('span', 'msg-command', `/${turn.command}`));
  }
  const text = turn.error || turn.content;
  if (text) {
    body.appendChild(mk('span', 'msg-text', text));
  } else if (turn.revise?.items.length) {
    // 按審稿修稿：勾了哪幾條（五期）。命令標籤下面一條一行——翻回來看得出這一次修的是什麼。
    const list = mk('ul', 'msg-revise-items');
    for (const item of turn.revise.items) {
      list.appendChild(mk('li', undefined, item));
    }
    body.appendChild(list);
  } else if (!turn.command) {
    // 既沒有話也沒有命令：只可能是舊會話裡的空輪次（那時命令沒被記下來）。
    // 留一句說明，總比一片看不出所以然的空白好。
    body.appendChild(mk('span', 'msg-text msg-text-empty', '（沒有補充要求）'));
  }
  return body;
}

function buildAttachments(attachments: NonNullable<SerializedTurn['attachments']>): HTMLElement {
  const box = mk('div', 'msg-attachments');
  for (const att of attachments) {
    const chip = mk('span', 'chip');
    chip.appendChild(mk('span', 'chip-label', att.label));
    if (att.relPath) {
      chip.style.cursor = 'pointer';
      chip.title = att.relPath;
      chip.addEventListener('click', () => openPath(att.relPath!));
    }
    box.appendChild(chip);
  }
  return box;
}

/**
 * 氣泡末尾那一行：這一輪產出的東西**落到哪兒了**，加一顆「複製」。
 *
 * **這裡沒有任何能寫檔案的按鈕。** 寫不寫在產出的當下就問過了——那是輸入框
 * 上方那張許可權卡片（`view/gate.ts`），和 agent 動手前那一問長一個樣。從前
 * 這裡是「採納寫入 / 覆蓋並寫入」：一顆**可以永遠不點的按鈕**，於是「產物
 * 落盤前必須過一遍人」在介面上成了一件可以無限拖延的事，作者手裡攢著三份
 * 沒落地的產物，誰也說不清哪份寫過。
 *
 * 留下的是記錄：寫了的說寫到哪（可點開），沒寫的標一句「未採納」。
 */
function buildActions(turn: SerializedTurn): HTMLElement {
  const bar = mk('div', 'msg-actions');
  if (turn.role !== 'assistant' || !turn.content || turn.error) {
    return bar;
  }

  /**
   * 複製取的是**氣泡裡當下的文字**（可能被就地改過），不是 turn.content。
   *
   * 段區裡可能有好幾塊文字（說一句、做一件事、再說一句），全都要——只取第一塊
   * 的話，複製出來的是半截結論。工具條與 generate 卡不進剪貼簿：那是過程與產物，
   * 產物有自己的落點。
   */
  const currentText = () => {
    const blocks = [...(bubbleOf(turn.id)?.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]') ?? [])];
    const text = blocks
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) => t.length > 0)
      .join('\n\n');
    return text || turn.content;
  };

  if (turn.acceptedTo) {
    bar.appendChild(mk('span', 'accepted', `✓ 已寫入 ${turn.acceptedTo}`));
    bar.appendChild(linkBtn('開啟', () => openPath(turn.acceptedTo!)));
  } else if (turn.artifact) {
    // 產出過一份結構化產物，但沒落盤：說清是什麼、本來要寫到哪。
    const a = turn.artifact;
    const line = `${a.where} · ${a.summary}${a.declined ? ' · 未採納' : ''}`;
    bar.appendChild(mk('span', 'artifact-where', line));
  }
  // 正文寫了多長、有沒有重演（W7）：寫沒寫進去都留著，翻回來看得出這一章當時夠不夠。
  const a = turn.artifact;
  if (a?.length) {
    bar.appendChild(mk('span', `artifact-length${a.length.reached ? '' : ' short'}`, describeWriteLength(a.length, a.append)));
  }
  if (a?.replay) {
    const flag = mk('span', 'artifact-replay', '開頭與上一章結尾重合');
    flag.title = a.replay;
    bar.appendChild(flag);
  }

  bar.appendChild(
    linkBtn('複製', () => {
      void navigator.clipboard.writeText(currentText());
      toast('已複製到剪貼簿。');
    })
  );
  return bar;
}

// ---------------------------------------------------- 氣泡右上角的 ⋯ 選單

function buildMenuBtn(turn: SerializedTurn): HTMLElement {
  const btn = mk('button', 'msg-menu-btn', '⋯');
  btn.title = '更多操作';
  btn.setAttribute('aria-label', '更多操作');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleButtonMenu(btn, menuItemsFor(turn));
  });
  return btn;
}

/** 這條訊息在 ⋯ 選單裡能做什麼。 */
function menuItemsFor(turn: SerializedTurn) {
  const items = [];
  // 「重新生成」只對使用者訊息有意義：重來是從那一條分叉，
  // 丟掉它之後的所有輪次再跑一遍。
  if (turn.role === 'user') {
    items.push({
      label: '重新生成',
      run: () => {
        if (store.busy) {
          toast('正在生成，請先停止。', true);
          return;
        }
        vscode.postMessage({ type: 'retry', turnId: turn.id, payload: currentPayload() });
      },
    });
  }
  items.push({
    label: '刪除',
    danger: true,
    run: () => vscode.postMessage({ type: 'deleteTurn', turnId: turn.id }),
  });
  return items;
}

// ---------------------------------------------------------------- 摺疊塊

/**
 * 思考過程的摺疊塊。
 *
 * 推理模型（gemma/gemini thinking、DeepSeek reasoner 等）可能先想幾十秒
 * 才開始吐正文。這段內容不是正文——採納寫入時不會帶上它——但把它顯示
 * 出來，使用者才知道模型在動，而不是介面卡住了。
 */
export function buildReasoningDetails(text: string): HTMLDetailsElement {
  const det = mk('details', 'reasoning');
  det.appendChild(mk('summary', undefined, `思考過程 · ${countWords(text)} 字`));
  det.appendChild(mk('div', 'reasoning-body', text));
  return det;
}

/**
 * 把一輪的段畫成一串節點。
 *
 * **相鄰的工具段並進同一個 `.tools` 組**：連著五次 `list` / `read` 仍然讀成
 * 一串流水賬，散成五塊反而比從前更亂。文欄位與 generate 卡打斷它——那正是
 * 「讀了三份 → 說一句 → 生成 → 再說一句」看得出來的地方。
 */
function buildSegments(turn: SerializedTurn): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  /** 當前那一串工具條。遇到別的段就作廢，下一次工具呼叫重開一串。 */
  let strip: HTMLElement | undefined;

  for (const seg of turn.segments ?? []) {
    if (seg.kind === 'text') {
      strip = undefined;
      nodes.push(buildTextBlock(seg.text));
      continue;
    }
    if (isGenerate(seg.call)) {
      strip = undefined;
      nodes.push(buildGenCard(seg.call));
      continue;
    }
    if (!strip) {
      strip = buildToolStrip();
      nodes.push(strip);
    }
    strip.appendChild(buildToolRow(seg.call));
  }
  return nodes;
}

/**
 * 一段文字。**有段的那一輪一律只讀**（見檔案頭）。
 *
 * `data-seg` 標出「這是段區裡的一塊文字」：流式追加要找的是**最後**那一塊，
 * 而氣泡裡別的地方（使用者那一支、錯誤文字）也叫 `.msg-body`。
 */
export function buildTextBlock(text: string): HTMLElement {
  const body = mk('div', 'msg-body', text);
  body.dataset.seg = 'text';
  return body;
}

/** 這一次呼叫是不是「花錢產出了一份東西」。產出的正文畫成一張卡，不是一行。 */
function isGenerate(call: SerializedToolCall): boolean {
  return call.name === 'generate' || call.output !== undefined;
}

/**
 * `generate` 那一次的卡片。
 *
 * ```
 * ┌ ✨ generate                              23.6s ▾ ┐
 * │ ✓ 情節大綱 · 6104 字 · 已寫入 .novelwarden/outline.md│
 * ├──────────────────────────────────────────────────┤
 * │ ### 全書結構一覽                                  │
 * │ **第一卷 活著**：半世界陷入病災…                   │ ← 限高，卡內滾動
 * │ ▸ 引數與返回                                      │
 * └──────────────────────────────────────────────────┘
 * ```
 *
 * **它不是一行流水賬**：`read` 回來的東西是它查資料的過程，而這幾千字是**產物
 * 本身**——作者接下來要判斷「這份要不要落盤」，讀的就是它。所以預設展開（點頭
 * 部可收起），限高滾動：鋪開會把整輪對話頂出螢幕，藏起來又等於讓他隔著一行摘要
 * 去決定要不要寫進書裡。
 *
 * 落盤的結論由後端拼在 `summary` 後面（「已生成 4/4 節 · 已寫入 X」），畫成**單獨
 * 一行**而不是擠進頭裡：那一行在側欄的寬度下會被截成
 * `gener… 情節大綱 · 6104 字 · 已寫入 .novelforg…`，而「寫到哪兒了」恰恰是作者
 * 最要看清的一句。這兩行都長在 `<summary>` 裡，所以**收起來之後它們還在**——
 * 摺疊只藏產物正文。
 */
export function buildGenCard(call: SerializedToolCall & { open?: boolean }): HTMLElement {
  const card = mk('details', `gen${call.ok ? '' : ' gen-failed'}`);
  card.dataset.call = call.callId;
  (card as HTMLDetailsElement).open = call.open !== false;

  const head = mk('summary', 'gen-head');
  const line = mk('div', 'gen-line');
  line.appendChild(mk('span', 'gen-icon', '✨'));
  line.appendChild(mk('span', 'gen-title', call.title));
  line.appendChild(spacer());
  line.appendChild(mk('span', 'gen-elapsed', formatElapsed(call.elapsedMs)));
  head.appendChild(line);
  head.appendChild(buildGenState(call));
  card.appendChild(head);

  card.appendChild(mk('pre', 'gen-body', call.output ?? ''));

  // 引數與返回收在再一層摺疊裡。**花錢那一下更要查得出它動的是哪一章**：卡上
  // 那兩行說的是「產出了什麼」，而「它是按哪個落點、哪句要求生成的」只在引數裡。
  const detail = buildToolDetail(call);
  if (detail) {
    const det = mk('details', 'gen-args');
    det.appendChild(mk('summary', undefined, '引數與返回'));
    det.appendChild(detail);
    card.appendChild(det);
  }
  return card;
}

/** 卡上那一行結論。還沒跑完時說「生成中…」，不擺一句空話。 */
function buildGenState(call: SerializedToolCall): HTMLElement {
  const pending = call.elapsedMs < 0;
  const row = mk('div', `gen-state${call.ok || pending ? '' : ' gen-state-failed'}`);
  row.appendChild(mk('span', 'gen-state-icon', pending ? '…' : call.ok ? '✓' : '⊘'));
  row.appendChild(mk('span', 'gen-state-text', pending ? '生成中…' : call.summary));
  return row;
}

/**
 * agent 工具呼叫的那一串摺疊條。
 *
 * ```
 * 🔧 search「北境」        2 處命中   0.3s
 * 🔧 read chapters/009…   142 行     0.1s
 * ✨ generate 劇情         620 字     12.4s
 * ```
 *
 * **那一行上只畫摘要**：`read` 一章正文是幾千字，攤在氣泡裡會把作者真正要看的
 * 那段回答擠到螢幕外。引數與返回文字收在摺疊裡——想核對「它讀的是哪一章、
 * 看到的是什麼」點開就有，不想看時它一行都不佔（後端已經截過，見
 * `controller/mcp.ts`）。
 */
export function buildToolStrip(): HTMLElement {
  return mk('div', 'tools');
}

export function buildToolRow(call: {
  callId: string;
  name: string;
  title: string;
  ok: boolean;
  summary: string;
  elapsedMs: number;
  argsText?: string;
  resultText?: string;
  open?: boolean;
}): HTMLElement {
  const line = mk('summary', 'tool-line');
  // 花錢的那個用另一個圖示：作者一眼要能看出這一串裡哪幾下是收費的。
  line.appendChild(mk('span', 'tool-icon', call.name === 'generate' ? '✨' : '🔧'));
  line.appendChild(mk('span', 'tool-title', call.title));
  line.appendChild(mk('span', 'tool-summary', call.summary));
  line.appendChild(mk('span', 'tool-elapsed', formatElapsed(call.elapsedMs)));

  const detail = buildToolDetail(call);

  // 沒有明細可看（老會話裡存的那些）就還是一行普通的條：給一個點開之後
  // 空空如也的三角，比不給更讓人火大。
  if (!detail) {
    const flat = mk('div', `tool-row tool-flat${call.ok ? '' : ' tool-failed'}`);
    flat.dataset.call = call.callId;
    for (const child of [...line.childNodes]) {
      flat.appendChild(child);
    }
    return flat;
  }

  const row = mk('details', `tool-row${call.ok ? '' : ' tool-failed'}`);
  row.dataset.call = call.callId;
  row.open = call.open === true;
  row.appendChild(line);
  row.appendChild(detail);
  return row;
}

/**
 * 那一步的明細：**它填的引數**與**回給模型的那段文字**（兩者都由後端截過）。
 *
 * 要核對「它讀的是哪一章、看到的是什麼」時，這裡是唯一的去處。兩樣都沒有就回
 * undefined——呼叫方據此不給摺疊三角（點開之後空空如也比不給更讓人火大）。
 */
function buildToolDetail(call: SerializedToolCall): HTMLElement | undefined {
  const parts: [string, string][] = [];
  if (call.argsText) {
    parts.push(['引數', call.argsText]);
  }
  if (call.resultText) {
    parts.push(['返回', call.resultText]);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const body = mk('div', 'tool-detail');
  for (const [label, text] of parts) {
    body.appendChild(mk('div', 'tool-detail-label', label));
    body.appendChild(mk('pre', 'tool-detail-text', text));
  }
  return body;
}

/**
 * 一次工具呼叫剛開始，還沒有結果。收到 `toolResult` 時就地補上。
 *
 * 引數這時就有了，所以這一條已經能展開——它正在讀哪個路徑，是「它卡在
 * 哪一步」最先要看的東西。
 */
export function buildPendingToolRow(
  callId: string,
  title: string,
  detail?: string,
  argsText?: string
): HTMLElement {
  return buildToolRow({
    callId,
    name: title.split(' ')[0],
    title,
    ok: true,
    summary: detail ?? '進行中…',
    elapsedMs: -1,
    argsText,
  });
}

function formatElapsed(ms: number): string {
  if (ms < 0) {
    return '';
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 上下文明細：裝配器放進去了什麼、各佔多少 token、降級或丟棄的原因。
 *
 * `copyTurnId` 給了（這一輪的完整訊息留在會話檔案裡）就在摘要行末尾放一顆「複製完整上下文」：
 * 放在摘要行而不是展開之後，是為了**一下就夠**，不必先點開清單。點它不展開摺疊塊。
 */
export function buildContextDetails(digest: SerializedDigest, copyTurnId?: string): HTMLDetailsElement {
  const det = mk('details', 'ctx');

  const kept = digest.items.filter((i) => i.status === 'included' || i.status === 'degraded').length;
  // 按哪一級裝的：這個開關出現之前存下的會話沒有，就不說。
  const detail = isContextDetail(digest.detail) ? ` · 詳細度：${CONTEXT_DETAIL_LABEL[digest.detail]}` : '';
  const sum = mk(
    'summary',
    undefined,
    `上下文 ${fmt(digest.usedTokens)} / ${fmt(digest.budget)} token${
      digest.clamped ? '（已按模型配額壓縮）' : ''
    } · ${kept} 項${detail}`
  );
  if (digest.usedTokens > digest.budget) {
    sum.classList.add('over-budget');
  }
  if (copyTurnId) {
    const copy = linkBtn('複製完整上下文', () => requestContextCopy(copyTurnId));
    copy.classList.add('ctx-copy');
    copy.title = '複製這一輪發給模型的全部訊息（系統提示、歷史與這一輪的話），原樣';
    // 按規範點 <summary> 裡的按鈕不開合折疊塊，但有的引擎照樣開合——取消預設動作，只複製。
    copy.addEventListener('click', (e) => e.preventDefault());
    sum.appendChild(copy);
  }
  det.appendChild(sum);

  const ul = mk('ul');
  for (const item of digest.items) {
    const li = mk('li', item.status);
    li.appendChild(mk('span', 'badge', `P${item.priority}`));
    li.appendChild(mk('span', 'label', item.label));
    if (item.source) {
      li.appendChild(linkBtn('開啟', () => openPath(item.source!)));
    }
    li.appendChild(mk('span', 'tokens', item.tokens > 0 ? fmt(item.tokens) : '—'));
    if (item.note) {
      li.appendChild(mk('span', 'note', item.note));
    }
    ul.appendChild(li);
  }
  det.appendChild(ul);
  return det;
}

// ---------------------------------------------------- 複製完整上下文

/**
 * 還沒回的那一次「複製完整上下文」。回覆是廣播（側欄與編輯器標籤頁掛同一個 controller），
 * 只認自己發的這一個；連點兩下只認最後一下。
 */
let pendingCopy: string | undefined;
let copySeq = 0;

function requestContextCopy(turnId: string): void {
  copySeq += 1;
  pendingCopy = `ctx-${Date.now().toString(36)}-${copySeq}`;
  vscode.postMessage({ type: 'copyContext', turnId, requestId: pendingCopy });
}

/**
 * 後端拼好的完整上下文回來了：寫進剪貼簿。
 *
 * 正文不在前端（一輪幾萬字，不隨會話推），所以中間隔著一趟來回。寫剪貼簿要「剛點過」：
 * Chromium 系與 Firefox 裡這一趟還算數，WebKit（Linux 桌面殼、Safari）可能不認——寫不進去時
 * 提示條上給一顆「再點一下複製」，那一下是新的點選，文字已經在手上了。
 */
export function onContextText(msg: Extract<OutMessage, { type: 'contextText' }>): void {
  if (msg.requestId !== pendingCopy) {
    return;
  }
  pendingCopy = undefined;
  const text = msg.text;
  if (text === undefined) {
    toast(msg.error ?? '沒拿到這一輪的完整上下文。', true);
    return;
  }
  if (!navigator.clipboard?.writeText) {
    toast('當前環境不支援剪貼簿。', true);
    return;
  }
  const done = () => toast(`已複製完整上下文（${fmt(countWords(text))} 字）。`);
  navigator.clipboard.writeText(text).then(done, () =>
    toast('瀏覽器沒讓寫剪貼簿。', true, {
      label: '再點一下複製',
      run: () => void navigator.clipboard.writeText(text).then(done, () => toast('複製失敗。', true)),
    })
  );
}
