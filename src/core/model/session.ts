import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, readText, writeText } from './fs';
import { NovelProject, trashPathFor } from './project';
import {
  Capability,
  CreationAction,
  CreationStage,
  CreationTarget,
  DEFAULT_CAPABILITY,
  WriteMode,
  capabilitiesOn,
  isCapability,
  isCreationStage,
  isWriteMode,
  normalizeAction,
  normalizeTarget,
  stageOfTarget,
} from './pipeline';
import { ThinkingDepth, isThinkingDepth } from './thinking';
import { ReviewReport, normalizeReport } from './review';

/**
 * 會話儲存：`.novelwarden/sessions/<id>.json`。
 *
 * 這裡用 JSON 而不是 Markdown——會話是機器記錄（含 token 明細、附件快照），
 * 不像角色卡那樣期待人工編寫。但仍然是純文字、可 Git、可手動刪除。
 */

export type AttachmentKind = 'selection' | 'file' | 'chapter' | 'character' | 'lore' | 'summary';

/** 使用者主動掛到某一輪對話上的上下文引用（Cursor 式）。 */
export interface Attachment {
  /** 穩定 id，用於裝配器的排除名單與前端去重。 */
  id: string;
  kind: AttachmentKind;
  /** 展示名，如 `003-夜访.md:12-40`。 */
  label: string;
  /** 工作區相對路徑。selection 也帶，方便點開原文。 */
  relPath?: string;
  /** selection 的行範圍，1-based 閉區間。 */
  range?: { start: number; end: number };
  /**
   * 選區快照。選區必須存快照——使用者選的時候是那個樣子，
   * 之後檔案改了不該讓歷史對話跟著變。整檔案引用則不存，每次讀盤取最新。
   */
  text?: string;
}

/** 一輪對話中，裝配器實際帶上了什麼——存下來供回看。 */
export interface ContextDigest {
  usedTokens: number;
  budget: number;
  clamped: boolean;
  /** 按哪一級上下文詳細度裝的（1–4）。這個開關出現之前存下的會話沒有。 */
  detail?: number;
  items: DigestItem[];
}

export interface DigestItem {
  id: string;
  label: string;
  kind: string;
  priority: number;
  tokens: number;
  status: string;
  note?: string;
  source?: string;
}

/** 發給模型的一條訊息。與 `llm/provider.ts` 的 `ChatMessage` 同形，資料層不 import llm。 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO 時間戳。 */
  at: string;
  /**
   * 僅 user 輪：這一輪下的是哪個命令，如 `落定細綱`。**只在不是「討論」時記**——
   * 討論是預設動作，每條訊息都掛一枚「/討論」的標籤是純噪聲。
   *
   * 存的是標籤而不是能力名：`labelOf` 是按階段具體化過的（同一個 `generate` 在細綱層
   * 叫「寫細綱」、在正文層叫「寫正文」），而歷史裡那一輪當時在哪個階段，事後未必還推得出來。
   *
   * 為什麼不乾脆寫進 `content`：那句話會被當成作者的要求裝進 prompt。
   * 「寫細綱」這類命令本來就不需要作者說什麼，憑空塞一句「請寫細綱」
   * 進上下文，與舊介面逼他手打一句是同一個毛病。介面要顯示的東西和要發給
   * 模型的東西是兩件事。
   */
  command?: string;
  /** 僅 user 輪：本輪引用的附件。 */
  attachments?: Attachment[];
  /** 僅 user 輪：本輪被手動取消勾選的上下文條目 id。 */
  excludedIds?: string[];
  /**
   * 僅 user 輪：主按鈕帶過來的章號區間（「拆細綱（第 6–10 章）」「續寫情節大綱（第 21–40 章）」）。
   * 記下來是為了「重來一輪」原樣重跑——那條路上前端給的是輸入框當下的引數，不是這一輪的。
   */
  range?: { from: number; to: number };
  /** 僅 user 輪：一句話彈窗帶過來的規模。同上，重來時要用。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
  /** 僅 user 輪：寫正文的寫法（「接著寫」「重寫」「按審稿修稿」）。同上，重來時要用。 */
  writeMode?: 'continue' | 'rewrite' | 'revise';
  /**
   * 僅 user 輪：按審稿修稿（五期）。報告在哪一輪、勾了哪幾條；`items` 是氣泡上那幾行的文字
   * （`describePicks`）。重來一輪時按 `reviewTurnId` + `picks` 重新拼清單——正文這期間可能又改過。
   */
  revise?: { reviewTurnId: string; picks: string[]; items: string[] };
  /**
   * 僅 user 輪：這一輪是 `/落定設定`（完善設定二期）。它在任何一層都能下，這一輪臨時把目標換成設定目錄、
   * 落完回到原來的目標——於是事後會話停在哪一層都推不出它來。記下來是為了「重來一輪」照樣換過去再換回來。
   */
  settleLore?: boolean;
  /**
   * 僅 user 輪：這一輪是續寫情節大綱（`/續寫大綱` 或主按鈕的「生成 / 續寫情節大綱」，2026-10-24）。`/續寫大綱` 在任何
   * 一層都能下，同 {@link settleLore}：臨時換到情節大綱、跑完回到原來的目標，「重來一輪」照樣換過去再換回來。
   */
  continueOutline?: boolean;
  /** 僅 assistant 輪：本次裝配明細。 */
  context?: ContextDigest;
  /**
   * 僅 assistant 輪：這一次發給模型的完整訊息（裝配器的 `messages`，原樣）。裝配清單摘要行上
   * 「複製完整上下文」取它（{@link renderContextText}）。
   *
   * **只隨會話落盤，不隨 `serializeTurn` 推給前端**：一輪幾萬到十幾萬字，每次推會話都帶上
   * 等於把整份 prompt 來回搬；前端只拿一個 `fullContext` 標記，點了再要。只記第一次呼叫的
   * 那一份——續寫、修復那幾輪另行裝配，裝配清單說的也是第一次。
   */
  contextMessages?: ContextMessage[];
  /** 僅 assistant 輪：已採納寫入的目標路徑。 */
  acceptedTo?: string;
  /** 僅 assistant 輪：生成被使用者中斷。 */
  interrupted?: boolean;
  /** 僅 assistant 輪：本輪報錯資訊（保留在歷史裡，便於複查）。 */
  error?: string;
  /**
   * 僅 assistant 輪：推理模型的思考過程。
   * 不是正文——採納寫入章節時只取 content。
   */
  reasoning?: string;
  /**
   * 僅 assistant 輪：這一輪產出的是可落盤的產物時，它的落點與形狀。
   *
   * **只是回放用的記錄**：寫不寫盤在產出的當下就問過了（`controller/gate.ts`
   * 那張卡片），氣泡上不再有任何能觸發寫入的按鈕。寫了的記在 `acceptedTo`
   * 上，作者當時沒同意的這裡標 `declined`——兩樣都留著，翻回來才看得出
   * 「這一輪產出過一份 4 場的場景清單，我沒要」。
   */
  artifact?: {
    where: string;
    summary: string;
    overwrites: boolean;
    declined?: boolean;
    /** 寫入時會新建的角色卡（D19）。 */
    creates?: string[];
    /** 生成這一路上的降級與說明（第 2 條）。 */
    notes?: string[];
    /** 這一輪一共調了幾次模型。 */
    calls?: number;
    /** 正文寫了多長（與 `SessionDraft.length` 同形）。 */
    length?: { words: number; target?: number; added: number; rounds: number; reached: boolean };
    /** 正文開頭與上一章結尾重合的那一段原文。 */
    replay?: string;
    /** 正文是追加在這一章末尾（「接著寫」）。 */
    append?: boolean;
  };
  /**
   * 僅 assistant 輪：審稿報告（五期，D22）。**不落盤**：它隨會話儲存，報告卡照它畫，
   * 作者勾選之後按它修稿。`notes` 是審稿鏈一路上的說明（截斷重來、丟掉了幾條……）。
   */
  review?: { report: ReviewReport; notes?: string[]; calls?: number };
  /**
   * 僅 assistant 輪：這一輪**按發生順序**排下來的段——它說的話與它做的事交替。
   *
   * 只有 MCP 那條路寫它，而且一定同時標 `mcp`。單步創作（寫細綱、寫正文）沒有
   * 工具，一塊正文就是全部——那條路不產生段，氣泡照舊畫成一塊可就地編輯的正文。
   * 有段卻沒標 `mcp` 的，是已經移除的內建 agent 留下的（{@link isBuiltinAgentTurn}）。
   */
  segments?: TurnSegment[];
  /**
   * 僅 assistant 輪：這是外部 agent 經 MCP 調工具留下的氣泡（`controller/mcp.ts`）。
   * 連著幾次呼叫接在同一個氣泡裡；作者說了話就另起一個。
   */
  mcp?: boolean;
}

/**
 * assistant 一輪裡的一段。**陣列順序就是它發生的順序。**
 *
 * 兩種段就夠了：模型自己說的話，與它做的一件事。`generate` 也是「一件事」，
 * 只是那一段的 `call.output` 裡還帶著它產出的正文（介面上畫成一張單獨的卡片）。
 */
export type TurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: TurnToolCall };

/** 一次工具呼叫在會話裡留下的痕跡。只夠畫一行（generate 多一份產出正文）。 */
export interface TurnToolCall {
  callId: string;
  name: string;
  /** 介面上那一行的標題，如 `search「北境」`。 */
  title: string;
  ok: boolean;
  /** 展示摘要，如「2 處命中」。那一行上只畫這個。 */
  summary: string;
  elapsedMs: number;
  /**
   * 模型這一次填的引數（JSON 文字，已截斷）。摺疊條展開後看得到。
   *
   * 存它是為了「查得出它讀的是哪一章」——一行摘要說不清這個，而作者要核對
   * 結論的依據時，第一件想知道的事就是它當時看的是什麼。
   */
  argsText?: string;
  /**
   * 回給模型的那段文字（已截斷）。同樣只在展開後畫。
   *
   * **截斷是必須的**：這份東西隨會話落盤，一輪幾十次呼叫的完整返回值會把
   * 會話檔案撐成幾兆。截斷點在 `controller/mcp.ts`，那裡也是唯一知道
   * 「介面要畫多長」的地方。
   */
  resultText?: string;
  /**
   * 僅 `generate`：它這一次**流出來的正文**（已截斷）。
   *
   * 與 `resultText` 不是一回事：那是回給模型的一句「已生成 4/4 節」，這是作者
   * 要讀的那幾千字。它走的是另一條通道（`ToolRun.onDelta` → 協議 `toolDelta`），
   * 存下來，重新整理之後氣泡裡那張卡片才畫得回來。
   *
   * 截斷點在 `controller/mcp.ts`（那裡也是唯一知道介面要畫多長的地方），
   * 截了會自報（第 2 條）。
   */
  output?: string;
}

/**
 * 一份隨會話落盤的草稿。
 *
 * 與 `generation/drafts.ts` 的 `Draft` 同形，只是 `artifact` 在這一層是
 * **不透明的**：資料層不認識 `Artifact`（那是 `features/artifact.ts` 的型別，
 * 依賴方向不允許反過來），而這份快照只用於畫卡片——採納時會拿氣泡裡當下的
 * 文字重新解析。
 */
export interface SessionDraft {
  id: string;
  action: CreationAction;
  target: CreationTarget;
  /** 模型原樣輸出（正文層已過 `cleanOutput`）。 */
  raw: string;
  /** 解析出的結構化產物。討論（唯一的 text 類能力）沒有。 */
  artifact?: unknown;
  /** 一句話形狀描述，如「細綱 · 3/3 節」。 */
  summary?: string;
  words: number;
  /** 推理模型的思考過程。不是正文，採納時不取。 */
  reasoning?: string;
  createdAt: string;
  /** 細綱批次 / 續寫大綱的章號區間。採納時按它解碼與合併。 */
  range?: { from: number; to: number };
  notes?: string[];
  calls?: number;
  /** 正文的寫法。採納時按它落盤（「接著寫」追加，其餘覆蓋審閱）。 */
  writeMode?: WriteMode;
  /** 正文寫了多長（卡片上的「2980 / 3000 字 · 已達標」）。 */
  length?: { words: number; target?: number; added: number; rounds: number; reached: boolean };
  /** 與上一章結尾重合的那一段原文。 */
  replay?: string;
  /** 刪修飾之前那一版。 */
  untrimmed?: string;
  /** 審稿報告（審稿那一輪沒有 `artifact`，只有它）。 */
  review?: ReviewReport;
}

export interface ChatSession {
  /** 等於檔名（不含副檔名）。 */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 當前在改哪個產物。會話跟著目標走——切到另一章的細綱通常意味著
   * 換個話題，但**不強制新建會話**：作者可能正想拿這一章跟上一章比。
   */
  target: CreationTarget;
  /** 當前階段與能力。切階段時能力回落到該階段的預設值（一律 discuss）。 */
  stage: CreationStage;
  capability: Capability;
  /** 本會話預設寫入的章號。目標章尚未落盤時用它定位「前文」邊界。 */
  targetNo?: number;
  /**
   * 這個會話讓模型想多深。
   *
   * **跟著會話走而不是全域設定**：想多深是「這件事有多難」的函式，不是偏好。
   * 排一份情節大綱值得讓它想透，改一個錯別字不值得——而這兩件事往往就是相鄰
   * 的兩個會話。缺席 = 不思考（`DEFAULT_THINKING_DEPTH`），也就是這個欄位
   * 出現之前的行為，老會話讀進來一個字都不用改。
   */
  thinking?: ThinkingDepth;
  turns: ChatTurn[];
  /**
   * 本會話裡尚未採納的草稿。
   *
   * 跟著會話落盤的理由與 `ChatTurn.artifact` 是同一條：**重新整理網頁後採納
   * 按鈕還在**，不然剛生成的四個場景就只剩一段誰也用不上的 JSON。
   * 不進 SQLite（第 17 條：庫只放可丟棄的痕跡）。
   */
  drafts: SessionDraft[];
}

/** 列表檢視用的輕量摘要，不含 turns 全文。 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  /** 最後一條使用者訊息的開頭，用作副標題。 */
  preview: string;
}

export class SessionStore {
  constructor(private readonly project: NovelProject) {}

  private filePath(id: string): string {
    return path.join(this.project.sessionsDir, `${id}.json`);
  }

  /** 按更新時間倒序列出所有會話。損壞的檔案跳過，不讓一個壞檔案廢掉整個歷史。 */
  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.project.sessionsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map((e) => e.name);
    } catch {
      return [];
    }

    const out: SessionSummary[] = [];
    for (const name of names) {
      const session = await this.read(name.replace(/\.json$/i, ''));
      if (session) {
        out.push(summarize(session));
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async read(id: string): Promise<ChatSession | undefined> {
    const file = this.filePath(id);
    if (!(await exists(file))) {
      return undefined;
    }
    try {
      return normalize(id, JSON.parse(await readText(file)));
    } catch {
      // 手改壞了或寫到一半斷電——當作不存在，別拋給使用者。
      return undefined;
    }
  }

  async write(session: ChatSession): Promise<void> {
    await writeText(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  /**
   * 刪除：搬進 `.novelwarden/.trash/`，不真刪（AGENTS 第 6 條）。**落點與工程頁的刪除同一套**（`trashPathFor`）：
   * 保留原相對路徑（`.trash/.novelwarden/sessions/<id>.json`），同名加序號，不蓋掉上一次刪的那一份。
   *
   * 會話不走閘道器（它是 Novelwarden 自己的內部檔案，閘道器拒寫 `sessions/`），只共用落點規則。
   */
  async delete(id: string): Promise<void> {
    const file = this.filePath(id);
    if (!(await exists(file))) {
      return;
    }
    const dest = await trashPathFor(this.project, this.project.relPath(file));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(file, dest);
  }

  async rename(id: string, title: string): Promise<ChatSession | undefined> {
    const session = await this.read(id);
    if (!session) {
      return undefined;
    }
    session.title = title.trim() || session.title;
    session.updatedAt = nowIso();
    await this.write(session);
    return session;
  }

  /**
   * 新建一個空會話（尚未落盤——沒有內容的會話不該在歷史裡佔位）。
   *
   * `seed` 讓新會話繼承上一個的落點：作者點「新對話」多半是想換個話題
   * 接著在**同一個地方**寫，把他彈回情節大綱純屬添亂。
   */
  create(seed?: {
    target?: CreationTarget;
    stage?: CreationStage;
    targetNo?: number;
    thinking?: ThinkingDepth;
  }): ChatSession {
    const at = nowIso();
    const target = seed?.target ?? { kind: 'outline' };
    const stage = seed?.stage ?? stageOfTarget(target);
    return {
      id: makeSessionId(),
      title: '新對話',
      createdAt: at,
      updatedAt: at,
      target,
      stage,
      capability: DEFAULT_CAPABILITY[stage],
      targetNo: seed?.targetNo,
      // 思考深度跟著繼承：點「新對話」多半是換個話題接著做同樣難的事，
      // 把它彈回「不思考」等於每次都要重新選一遍。
      thinking: seed?.thinking,
      turns: [],
      drafts: [],
    };
  }
}

// ---------------------------------------------------------------- 工具

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `20260802-143012-4f2a1b`：可讀、可排序、夠唯一。
 *
 * 時間戳只精確到秒，所以隨機位之外還帶一個程序內計數器：
 * 同一秒裡連開幾個會話（連點＋）必須保證不撞——id 就是檔名，
 * 撞了會直接覆蓋掉另一個會話。計數器保證同程序內不撞，
 * 隨機位負責把不同視窗/程序分開。
 */
let sessionCounter = 0;
export function makeSessionId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  sessionCounter = (sessionCounter + 1) % 0x100;
  return `${stamp}-${rand}${sessionCounter.toString(16).padStart(2, '0')}`;
}

/**
 * 輪次 id。
 *
 * 用遞增計數器而非純隨機：turnId 是 DOM 查詢和歷史對映的鍵，
 * 同一毫秒內連續建兩條（插入使用者訊息後緊接著插空回覆）必須保證不撞。
 */
let turnCounter = 0;
export function makeTurnId(): string {
  turnCounter += 1;
  return `t${Date.now().toString(36)}-${turnCounter.toString(36)}`;
}

/** 從首條使用者訊息生成會話標題。 */
export function deriveTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
    .find((s) => s.length > 0);
  if (!line) {
    return '新對話';
  }
  const clipped = line.split(/[。！？；,，.!?;]/)[0].trim();
  return (clipped || line).slice(0, 24);
}

/**
 * 一輪對話拿什麼當「它說了什麼」——歷史列表的預覽與會話標題都用這一份。
 *
 * 命令類的輪次（寫細綱、寫正文）content 本來就是空的：該說的都在細綱和
 * 大綱裡了，作者一個字都不必打。空串會讓歷史列表出現一排「新對話」，也讓
 * 訊息流裡出現一個空白氣泡——兩處都得能說出這一輪到底幹了什麼。
 */
export function turnPreview(turn: ChatTurn): string {
  const text = turn.content.trim();
  if (text) {
    return text;
  }
  return turn.command ? `/${turn.command}` : '';
}

/**
 * 這一輪是不是已經移除的內建 agent 跑出來的。
 *
 * 認法只有一條：**有段、沒標 `mcp`**——現在寫段的只有 MCP 那條路，它一定標 `mcp`。
 * 這些輪次只留著回看：介面上標明是誰，討論時不隨歷史帶（它說的是排程過程，
 * 不是與作者的討論，混進去會讓模型以為自己剛才在讀檔案、調工具）。
 */
export function isBuiltinAgentTurn(turn: ChatTurn): boolean {
  return turn.role === 'assistant' && !turn.mcp && (turn.segments?.length ?? 0) > 0;
}

/**
 * 這一輪留下的完整訊息。**手改壞了（不是陣列、某一條缺 role 或 content）就當沒有**，
 * 不拼半份出來：複製出去的東西，作者會當成「當時發給模型的就是這些」。
 */
export function contextMessagesOf(turn: ChatTurn): ContextMessage[] | undefined {
  const raw: unknown = turn.contextMessages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const ok = raw.every((m) => {
    const o = (m ?? {}) as Partial<ContextMessage>;
    return (o.role === 'system' || o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string';
  });
  return ok ? (raw as ContextMessage[]) : undefined;
}

/**
 * 「複製完整上下文」複製出去的那份文字：**粘進網頁版 AI 的對話方塊就能接著做這一輪的活**，
 * 所以只有訊息本身，不加任何說明（估算 token、詳細度、調了幾次模型都不寫）。
 *
 * 按傳送順序排，訊息之間用裝配器隔小節的那條 `---`。系統提示在最前、不標；只有一條使用者訊息時
 * 也不標；帶了歷史時每條使用者 / 模型訊息前面一行「【我】」/「【你】」——與提示詞裡的人稱一致
 * （系統提示管模型叫「你」，「# 我的要求」的「我」是作者），不標的話網頁 AI 分不清哪段是它
 * 自己上一輪說的。**訊息正文原樣，一個字都不改。** 沒留下完整訊息時返回 undefined。
 */
export function renderContextText(turn: ChatTurn): string | undefined {
  const messages = contextMessagesOf(turn);
  if (!messages) {
    return undefined;
  }
  const dialog = messages.filter((m) => m.role !== 'system').length > 1;
  return messages
    .map((m) => (dialog && m.role !== 'system' ? `${m.role === 'user' ? '【我】' : '【你】'}\n${m.content}` : m.content))
    .join('\n\n---\n\n');
}

function summarize(session: ChatSession): SessionSummary {
  const lastUser = [...session.turns].reverse().find((t) => t.role === 'user');
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    preview: (lastUser ? turnPreview(lastUser) : '').replace(/\s+/g, ' ').slice(0, 60),
  };
}

/**
 * 容錯讀取：欄位缺失或型別不對時補預設值，絕不拋。
 *
 * 認不出的 target 一律回落到情節大綱——它是唯一一個不依賴任何細綱就一定
 * 存在的產物。換軸之前的會話記的是章節路徑，那些路徑現在指不到任何東西，
 * 歸一化時會落回大綱；作者重新選一章就好，比把它指到一個錯的章上強。
 */
function normalize(id: string, raw: unknown): ChatSession {
  const o = (raw ?? {}) as Partial<ChatSession>;
  const at = typeof o.createdAt === 'string' ? o.createdAt : nowIso();
  const target = normalizeTarget(o.target);
  // 階段認不出、或該階段（在這個目標上）不支援記下來的那個能力時，都回落到該階段的預設值。
  const stage: CreationStage = isCreationStage(o.stage) ? o.stage : stageOfTarget(target);
  const capability: Capability =
    isCapability(o.capability) && capabilitiesOn(stage, target).includes(o.capability)
      ? o.capability
      : DEFAULT_CAPABILITY[stage];
  const drafts = normalizeDrafts(o.drafts);
  return {
    id,
    title: typeof o.title === 'string' && o.title.trim() ? o.title : '未命名對話',
    createdAt: at,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : at,
    target,
    stage,
    capability,
    targetNo: typeof o.targetNo === 'number' ? o.targetNo : undefined,
    // 老會話裡還有一個會話級的 `targetWords`（一期刪掉的那個輸入框）：不讀，下次儲存時自然消失。
    // 目標字數只認細綱的 `targetWords`，缺席取小說配置的每章字數。
    // 認不出的檔位當沒設過（= 不思考），不拋：手改壞一個欄位不該讓整個會話讀不出來。
    thinking: isThinkingDepth(o.thinking) ? o.thinking : undefined,
    turns: Array.isArray(o.turns) ? o.turns.filter(isTurn) : [],
    drafts,
  };
}

/**
 * 會話檔案的 `drafts` 欄位 → 一批草稿。不是陣列就當空。
 *
 * **只要 `id` 在就不整體作廢**：壞掉的欄位按預設值補，氣泡上那一輪至少還
 * 認得出產出過什麼。`target` 走 `normalizeTarget`（認不出回落情節大綱），
 * `action` 走 `normalizeAction`，兩者都不拋。展開一條設定的草稿（`{ kind: 'lore', relPath }`）原樣認回來——
 * 採納時它還是那一條設定，不會被當成整批設定清單（`{ kind: 'setting', doc: 'lore' }`）。
 *
 * `artifact` 原樣收下不重新校驗：它只是生成那一刻的展示快照，採納時會拿
 * 氣泡裡當下的文字重新解析（使用者可能改過）。
 */
function normalizeDrafts(raw: unknown): SessionDraft[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionDraft[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const o = entry as Partial<SessionDraft>;
    if (typeof o.id !== 'string' || !o.id.trim()) {
      continue;
    }
    out.push({
      id: o.id,
      action: normalizeAction(o.action),
      target: normalizeTarget(o.target),
      raw: typeof o.raw === 'string' ? o.raw : '',
      artifact: o.artifact,
      summary: typeof o.summary === 'string' ? o.summary : undefined,
      words: typeof o.words === 'number' && Number.isFinite(o.words) ? o.words : 0,
      reasoning: typeof o.reasoning === 'string' ? o.reasoning : undefined,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
      range: normalizeRange(o.range),
      notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : undefined,
      calls: typeof o.calls === 'number' && Number.isFinite(o.calls) ? o.calls : undefined,
      writeMode: isWriteMode(o.writeMode) ? o.writeMode : undefined,
      length: normalizeLength(o.length),
      replay: typeof o.replay === 'string' && o.replay ? o.replay : undefined,
      untrimmed: typeof o.untrimmed === 'string' && o.untrimmed ? o.untrimmed : undefined,
      review: o.review ? normalizeReport(o.review) : undefined,
    });
  }
  return out;
}

/** 正文長度記錄的容錯讀取：總字數認不出就整條不要（卡片上寧可不寫，也不寫個錯的）。 */
function normalizeLength(raw: unknown): SessionDraft['length'] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const words = num(o.words);
  if (words === undefined) {
    return undefined;
  }
  return {
    words,
    target: num(o.target) || undefined,
    added: num(o.added) ?? words,
    rounds: num(o.rounds) ?? 0,
    reached: typeof o.reached === 'boolean' ? o.reached : true,
  };
}

/** 章號區間的容錯讀取：兩端都是正整數才認，寫反了對調。 */
export function normalizeRange(raw: unknown): { from: number; to: number } | undefined {
  const o = (raw ?? {}) as { from?: unknown; to?: unknown };
  const a = typeof o.from === 'number' ? Math.floor(o.from) : NaN;
  const b = typeof o.to === 'number' ? Math.floor(o.to) : NaN;
  if (!(a > 0) || !(b > 0)) {
    return undefined;
  }
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

function isTurn(t: unknown): t is ChatTurn {
  const o = t as Partial<ChatTurn>;
  return !!o && (o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string';
}
