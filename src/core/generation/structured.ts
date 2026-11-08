import { traditionalLabel } from '../model/labels';
/**
 * 生成鏈：一件產物要分幾次呼叫才拼得出來時，把那幾次串起來。
 *
 * 三條鏈移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator），設定清單照角色圖譜的路子補了一條：
 *
 * | 產物 | 鏈 | 上游出處 |
 * |---|---|---|
 * | 小說配置 | 寫 → 轉寫；截斷就整份重來 1 次；「全域要求」不合格只重寫這一節 1 次；轉寫不成按小節讀 | `GenerateConfigCommand`（AC:980-1163） |
 * | 角色圖譜 | 身份清單（寫 → 轉寫）→ 按凍結清單每批 3 人補詳情（寫 → 轉寫）；截斷拆半 | `GenerateCharactersCommand`（AC:1254-1647） |
 * | 設定清單 | 分類目錄樹 + 清單 → 按凍結清單每批 6 條補正文，都是寫 → 轉寫；截斷拆半；呼叫次數封頂 | 本專案（設定名錄） |
 * | 展開一條設定 / 落定設定 | 寫 → 轉寫（重轉一次）；截斷、轉寫不成都不給寫入 | 本專案（完善設定） |
 * | 細綱批次 | 寫（自然語言）→ 轉寫成 JSON；截斷或轉寫不出來：多章對半拆、單章緊湊重建；全程重轉一次；漏章 fail-closed | `structured-batch-executor.ts` |
 * | 單章細綱 | 寫（自然語言）→ 轉寫成 JSON；重轉一次；還不行按小節讀原文 | 本專案（細綱試點） |
 *
 * ## 單步與批次共用
 *
 * 對話頁（generation/generate.ts）第一次呼叫是流式的，後面幾次照樣流進同一個氣泡；
 * 工程頁的批次（features/pipelineBatch.ts）走分檔池。兩邊只在 {@link ChainIO} 上不同，
 * 鏈本身一份——批次寫出來的細綱與對話頁的是同一個質量、同一套降級。
 *
 * ## 不靜默（第 2 條）
 *
 * 每一次降級都記進 `notes`：落盤卡片上列出來、日誌裡留一份。**鏈不寫磁碟**——
 * 交出去的是規範化結果（將要落盤的樣子），落不落盤仍由作者在卡片上決定（第 19 條），
 * 批次那條路由呼叫方決定（只補空白）。
 *
 * ## 比上游寬鬆的地方
 *
 * 配置與角色圖譜是一次一份、攤在卡片上的產物：缺欄位、人數不對、某人詳情沒出來都照收
 * 並說明，只有「一點能用的都沒有」才報錯。細綱批次保持上游的嚴格——那條路上沒有人
 * 逐份過目，漏一章就會讓流水線從此撒謊。
 */
import type { ChatMessage, StopSignal } from '../llm/provider';
import { CancelledError } from '../llm/provider';
import { describeError } from '../runtime/logger';
import type { BuildRequest, DraftPlotLine } from '../context/types';
import {
  RESTART_AFTER_INVALID,
  RESTART_AFTER_TRUNCATION,
  blueprintTranscribeMessages,
  configJsonContract,
  guidanceRetryMessages,
  loreDetailJsonContract,
  loreListJsonContract,
  rosterDetailJsonContract,
  rosterManifestJsonContract,
} from '../context/prompts';
import { loreExpandJsonContract } from '../context/loreExpandPrompt';
import { loreSettleJsonContract } from '../context/loreSettlePrompt';
import { LORE_LIST_CALLS_MAX, LORE_LIST_DETAIL_BATCH, PLOT_BATCH, ROSTER_DETAIL_BATCH, SettingDoc, isLoreSettle } from '../model/pipeline';
import { BookConfig } from '../model/settingFile';
import { hasContent } from '../model/markdown';
import { outlineRangeHeadings, parseOutline } from '../model/outlineFile';
import { BlueprintItem, blueprintToPlot, checkCoverage, decodeBlueprints, renderBlueprints } from '../features/blueprint';
import { parsePlotStrict } from '../features/artifact';
import {
  CharacterDetail,
  DetailsDecode,
  IdentitySlot,
  ManifestDecode,
  assembleRoster,
  decodeDetails,
  decodeManifest,
  renderRoster,
} from '../features/roster';
import {
  LoreDetail,
  LoreDetailsDecode,
  LoreListKnown,
  LoreListSlot,
  LoreManifestDecode,
  assembleLoreList,
  decodeLoreDetails,
  decodeLoreManifest,
  renderLoreList,
} from '../features/loreList';
import {
  ConfigDecode,
  decodeNovelConfig,
  guidanceProblem,
  isGuidanceValid,
  mergeWithAuthor,
  renderConfigDraft,
} from '../features/novelConfig';
import { LoreExpandDecode, LoreExpandKnown, decodeLoreExpansion, renderLoreExpansion } from '../features/loreExpand';
import { LoreSettleDecode, LoreSettleKnown, decodeLoreSettle, renderLoreSettle, renderNothingSettled } from '../features/loreSettle';
import { jsonValueOf, unfaithfulStrings, withoutNone } from '../features/structuredJson';
import { cnNumber } from '../model/timelineFile';
import { TRANSCRIBE_TEMPERATURE } from '../model/transcribe';
import { TranscribeCall, TranscribeResult, TranscribeSpec, transcribeJson } from '../features/transcribe';

/** 一次呼叫的結果。`stop` 缺席 = 閘道器沒報收尾原因（有的相容實現壓根不發）。 */
export interface CallOutcome {
  text: string;
  stop?: StopSignal;
}

/** 鏈要的三樣東西：調一次模型、按改過的請求重新裝配、第一次呼叫發出去的那幾條訊息。 */
export interface ChainIO {
  /** 調一次模型。`label` 寫進氣泡與日誌，說清這一次在補什麼。 */
  call(messages: ChatMessage[], label: string, opts?: CallOptions): Promise<CallOutcome>;
  /**
   * 轉寫一次（2026-10-25 細綱試點）：把寫好的原文照抄成 JSON 的那個模型——「轉寫」那一檔（model/tiers.ts），不跟
   * 對話頁選的、也不跟確認框上為這一次挑的模型。不流進氣泡，只加一行「——label——」：JSON 在鏈結束時整份換上去。
   * 沒實現的（測試裡的假 IO）退回 `call`。
   */
  transcribe?(messages: ChatMessage[], label: string): Promise<CallOutcome>;
  /** 按改過的請求重新裝配：同一個裝配器、同一份預算，只換這幾個欄位。 */
  build(patch: Partial<BuildRequest>): Promise<ChatMessage[]>;
  /** 第一次呼叫的訊息。欄位級重寫要借它的系統提示。 */
  messages: ChatMessage[];
  /**
   * 把氣泡退回到這一份（正文續寫丟棄一輪時）。流進氣泡的那一輪已經收不回來了，
   * 不退回去的話作者看著的是一段不會被寫入的文字。沒有氣泡的那條路（批次）不實現。
   */
  reset?(text: string): void;
}

/** 一次呼叫的附帶要求。只有正文續寫用得上。 */
export interface CallOptions {
  /**
   * 這一次的輸出與氣泡裡前面那段之間放什麼。預設是一行「——label——」：結構化產物的
   * 幾次呼叫各是各的。正文續寫放一個空行——讀起來得是同一章。
   */
  separator?: string;
  /** 流式期間報進度：第幾輪、這一次開始之前已經寫到多少字。 */
  progress?: { round: number; base: number };
  /**
   * 不流進氣泡：只在氣泡里加一行「——label——」，輸出不顯示（刪修飾交回的是帶編號的段落，
   * 流出來作者會以為正文寫壞了）。呼叫方用完要 `reset` 把氣泡退回去。
   */
  quiet?: boolean;
  /** 這一次的溫度，缺席用設定裡的。 */
  temperature?: number;
}

export interface ChainResult {
  /** 規範化結果：交給氣泡、也是採納時重新解析的那一份。 */
  raw: string;
  /** 這一路上的降級與說明（第 2 條）。 */
  notes: string[];
  /** 一共調了幾次模型（含第一次）。 */
  calls: number;
}

/** 鏈走不下去了。`notes` 與 `calls` 照樣帶著——卡片沒了，日誌裡得說清花了幾次、卡在哪。 */
export class ChainError extends Error {
  constructor(message: string, readonly notes: string[], readonly calls: number) {
    super(message);
    this.name = 'ChainError';
  }
}

/** 一條鏈上的賬：說明與呼叫次數。 */
export class Tally {
  notes: string[] = [];
  calls: number;
  constructor(first: boolean) {
    this.calls = first ? 1 : 0;
  }
  note(...lines: string[]): void {
    this.notes.push(...lines.filter(Boolean));
  }
  fail(message: string): never {
    throw new ChainError(message, this.notes, this.calls);
  }
  async call(io: ChainIO, messages: ChatMessage[], label: string, opts?: CallOptions): Promise<CallOutcome> {
    this.calls++;
    return io.call(messages, label, opts);
  }
  /** 轉寫一次（{@link ChainIO.transcribe}）。也算一次呼叫（第 4 條）。 */
  async transcribe(io: ChainIO, messages: ChatMessage[], label: string): Promise<CallOutcome> {
    this.calls++;
    return chainTranscriber(io)(messages, label);
  }
  /**
   * 照 features/transcribe.ts 的 `transcribeJson` 走一遍（鏈上的轉寫都走它，除了細綱批次自己那一套）：呼叫記在這本賬上，
   * 不合格、重轉的說明也記上。
   */
  async transcribeJson<T>(io: ChainIO, source: string, spec: TranscribeSpec<T>): Promise<TranscribeResult<T>> {
    const r = await transcribeJson(source, spec, chainTranscriber(io));
    this.calls += r.calls;
    this.note(...r.notes);
    return r;
  }
}

/** 鏈上的轉寫呼叫：`io.transcribe`，沒實現的（測試裡的假 IO）退回 `io.call`，不流進氣泡、溫度 0。 */
export function chainTranscriber(io: ChainIO): TranscribeCall {
  return (messages, label) =>
    io.transcribe ? io.transcribe(messages, label) : io.call(messages, label, { quiet: true, temperature: TRANSCRIBE_TEMPERATURE });
}

export { TRANSCRIBE_TEMPERATURE };

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

// ---------------------------------------------------------------- 轉寫（架構那幾件、展開、落定設定）

/** 一步的解碼結果（成功那一支）。 */
type Decoded<D> = Extract<D, { ok: true }>;

/**
 * 把這一步原來的解碼包成轉寫要的樣子（features/transcribe.ts 的 `TranscribeSpec.decode`）：成功交回整份解碼結果（帶
 * warnings、missing），失敗交回那一句人話。
 */
function decoder<D extends { ok: boolean }>(
  decode: (json: string) => D,
  reason: (d: Exclude<D, { ok: true }>) => string
): (json: string) => { ok: true; value: Decoded<D> } | { ok: false; message: string } {
  return (json) => {
    const d = decode(json);
    return d.ok ? { ok: true, value: d as Decoded<D> } : { ok: false, message: reason(d as Exclude<D, { ok: true }>) };
  };
}

/** 設定的正文三節：展開、落定、設定清單的詳情都認它。 */
const LORE_BODY_LOOK = /概要|(?:规|規)(?:则|則)(?:与|與)(?:边|邊)界|(?:现|現)(?:状|狀)/;

/**
 * 小說配置（2026-10-25 起改成轉寫）：故事結構、敘事視角是中文詞對到英文列舉，規模是數字，不比原文。原文連「核心梗概」
 * 「金手指」這類小標題都沒有就不轉（多半是一段閒話）。
 */
function configSpec(): TranscribeSpec<Decoded<ConfigDecode>> {
  return {
    label: '小說配置',
    contract: configJsonContract(),
    decode: decoder(decodeNovelConfig, (d) => d.reason),
    mapped: ['plotStructure', 'narrativePOV', 'totalChapters', 'wordsPerChapter'],
    looksLike: (source) => /核心梗概|金手指|主角(?:档|檔)案|全局要求/.test(source),
  };
}

/** 定位的中文詞 → 身份清單的英文值（`decodeManifest` 只認英文值，認不出按配角算——主角被降成配角比多一次轉寫糟）。 */
const ROLE_CODE: Record<string, string> = { 主角: 'protagonist', 反派: 'antagonist', 配角: 'supporting', 次要: 'minor' };

/** 轉寫模型偶爾把定位照抄成中文：對回英文值再交給解碼。其餘一個字不動。 */
function withRoleCodes(json: string): string {
  const value = jsonValueOf(json) as { slots?: unknown } | undefined;
  if (!value || typeof value !== 'object' || !Array.isArray(value.slots)) {
    return json;
  }
  const slots = value.slots.map((row: unknown) => {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    const code = typeof o?.role === 'string' ? ROLE_CODE[o.role.trim()] : undefined;
    return code ? { ...o, role: code } : row;
  });
  return JSON.stringify({ ...value, slots });
}

/** 身份清單：編號（slotId）就是名字，關係指向對方的名字（context/prompts.ts 的 `rosterManifestJsonContract`），按對應關係填。 */
function manifestSpec(): TranscribeSpec<Decoded<ManifestDecode>> {
  return {
    label: '身份清單',
    contract: rosterManifestJsonContract(),
    decode: decoder((json: string) => decodeManifest(withRoleCodes(json)), (d) => d.message),
    mapped: ['slotId', 'targetSlotId', 'role', 'gender'],
    looksLike: (source) => /定位|(?:叙|敘)事(?:职|職)(?:责|責)/.test(source),
  };
}

/** 凍結的身份清單給補詳情那一步看的樣子：一人一行（名字、定位、性別、敘事職責），關係縮排在下面。 */
function frozenRoster(slots: readonly IdentitySlot[]): string {
  return slots
    .flatMap((s) => [
      `- ${s.name}（${[s.role, s.gender].filter(Boolean).join('，')}）${s.duty ? `：${s.duty}` : ''}`,
      ...s.relations.map((r) => `  - 與${r.target}：${r.relation}`),
    ])
    .join('\n');
}

/** 凍結的設定清單給補正文那一步看的樣子：先一行分類，再一條一行（名字、分類、一句話）。 */
function frozenLoreList(categories: readonly string[], slots: readonly LoreListSlot[]): string {
  return [
    ...(categories.length > 0 ? [`分類：${categories.join('、')}`] : []),
    ...slots.map((s) => `- ${s.title}（${s.category || '未分类'}）${s.brief ? `：${s.brief}` : ''}`),
  ].join('\n');
}

// ---------------------------------------------------------------- 小說配置

export interface ConfigChainContext {
  /** 磁碟上那份 `config.md`。 */
  existing: BookConfig;
  /** 作者這一次給的那句話；給了就寫進「一句話」一節。 */
  idea?: string;
  /** 一句話彈窗帶過來的規模；給了就以它為準，並開「保留原文，追加生成」。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
}

/** 上游合同欄位 → 卡片上的說法。 */
const CONFIG_FIELD_LABEL: Record<string, string> = {
  genre: '类型',
  targetAudience: '受众',
  subGenre: '細分型別',
  coreOutline: '核心梗概',
  sellingPoints: '核心卖点',
  worldSetting: '世界观要点',
  goldenFinger: '金手指',
  protagonistProfile: '主角档案',
  globalGuidance: '全局要求',
  writingStyle: '文风',
};

/**
 * 小說配置：寫（按小標題，2026-10-25 起）→ 截斷整份重來 1 次 → 轉寫成 JSON（重轉一次）→ 「全域要求」不合格只重寫這一節
 * 1 次 → 與磁碟那份合併 → `config.md` 全文（外加一節文風）。
 *
 * 轉寫不成（轉寫呼叫失敗、兩次都不合格、原文連小標題都沒有）不報錯，原樣交回去：解析那一層按小節讀（「核心梗概」
 * 「金手指」……那八節與 `config.md` 同名），卡片上照樣看得見——這件產物作者當場過目，寬鬆比作廢划算（同從前模型沒按
 * JSON 答時）。模型自己給了 JSON 就不轉。
 */
export async function completeConfig(first: CallOutcome, io: ChainIO, ctx: ConfigChainContext): Promise<ChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('小說配置被輸出上限截斷，截斷的那一半不可信，已丟棄並整份重來一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '配置被截斷，整份重來');
    if (out.stop === 'maxTokens') {
      t.fail('小說配置重來一次仍被輸出上限截斷。調大設定頁的「最大輸出 token」，或降低思考深度再試。');
    }
  }

  const tr = await t.transcribeJson(io, out.text, configSpec());
  if (!tr.ok) {
    t.note(`小說配置沒能整理成 JSON（${tr.message}），按小節讀了原文：型別、受眾、故事結構、敘事視角與文風讀不出來，寫入後可以手補`);
    return { raw: out.text, notes: t.notes, calls: t.calls };
  }
  const decoded = tr.value;
  const value = decoded.value;
  if (decoded.missing.length > 0) {
    t.note(`模型漏了：${decoded.missing.map((k) => CONFIG_FIELD_LABEL[k] ?? k).join('、')}`);
  }
  t.note(...decoded.warnings);

  const guidance = value.sections.全局要求;
  const problem = guidance ? guidanceProblem(guidance) : undefined;
  if (guidance && problem) {
    t.note(`${problem}，只重寫這一節一次`);
    const others = JSON.stringify(
      {
        genre: value.genre,
        subGenre: value.subGenre,
        targetAudience: value.audience,
        coreOutline: value.sections.核心梗概,
        worldSetting: value.sections.世界观要点,
        goldenFinger: value.sections.金手指,
        protagonistProfile: value.sections.主角档案,
      },
      null,
      2
    );
    const fix = await t.call(io, guidanceRetryMessages(io.messages[0]?.content ?? '', others), '全域要求不合格，只重寫這一節');
    const text = fix.text.trim();
    if (fix.stop !== 'maxTokens' && isGuidanceValid(text)) {
      value.sections.全局要求 = text;
    } else {
      t.note(`重寫後的全域要求仍不合格（${fix.stop === 'maxTokens' ? '被截斷' : guidanceProblem(text)}），保留原來那一版，寫入後可以手改`);
    }
  }

  const authorWrote = Object.values(ctx.existing.sections).some((v) => hasContent(v));
  const merged = mergeWithAuthor(ctx.existing, value, {
    idea: ctx.idea,
    setup: ctx.setup,
    preserve: !!ctx.setup && authorWrote,
  });
  if (ctx.setup && authorWrote) {
    t.note('小說配置裡已經有作者寫的內容：保留原文，生成的追加在後');
  }
  return { raw: renderConfigDraft(merged, value.writingStyle), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 角色圖譜

/**
 * 角色圖譜：身份清單（截斷重來 1 次）→ 按凍結清單每批 3 人補詳情 → 拼卡。2026-10-25 起每一次都是按小標題寫、
 * 轉寫模型照抄成 JSON（features/transcribe.ts）。
 *
 * 清單不合格（轉寫不成也算）就停：後面每一批都以它為準，一張壞清單補出來的詳情只會錯得更整齊。
 * 詳情那一步反過來寬鬆——某人的詳情實在出不來，照樣按清單建卡並說明：截斷或轉寫不合格對半拆，單人還不行、
 * 或轉寫呼叫本身失敗，只按清單建卡。詳情的轉寫**全程只重轉一次**（同從前的語法修復只修一次）。
 */
export async function completeRoster(first: CallOutcome, io: ChainIO): Promise<ChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('身份清單被輸出上限截斷，已丟棄並重來一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '身份清單被截斷，重來');
    if (out.stop === 'maxTokens') {
      t.fail('角色身份清單重來一次仍被輸出上限截斷。調大設定頁的「最大輸出 token」，或降低思考深度再試。');
    }
  }
  const manifest = await t.transcribeJson(io, out.text, manifestSpec());
  if (!manifest.ok) {
    t.fail(`角色身份清單不合格：${manifest.message}。這一次沒有產出可寫入的角色圖譜。`);
  }
  t.note(...manifest.value.warnings);
  const slots = manifest.value.slots;
  const frozen = frozenRoster(slots);

  const details: CharacterDetail[] = [];
  let retranscribed = false;
  const runBatch = async (batch: IdentitySlot[]): Promise<void> => {
    const names = batch.map((s) => s.name).join('、');
    const done = details.map((d) => slots.find((s) => s.slotId === d.slotId)?.name ?? '').filter(Boolean).join('、');
    const messages = await io.build({
      step: { kind: 'rosterDetails', manifest: frozen, names: batch.map((s) => s.name), done },
    });
    const res = await t.call(io, messages, `角色詳情（${names}）`);
    const split = async (why: string) => {
      t.note(`${names}的詳情${why}，拆成兩半重試`);
      const mid = Math.floor(batch.length / 2);
      await runBatch(batch.slice(0, mid));
      await runBatch(batch.slice(mid));
    };
    if (res.stop === 'maxTokens') {
      if (batch.length > 1) {
        return split('被輸出上限截斷');
      }
      t.note(`「${names}」的詳情被輸出上限截斷，只按身份清單建卡`);
      return;
    }
    const tr = await t.transcribeJson(io, res.text, {
      label: `${names}的詳情`,
      contract: rosterDetailJsonContract(),
      decode: decoder((json: string): DetailsDecode => decodeDetails(json, batch), (d) => d.message),
      mapped: ['slotId', 'role'],
      looksLike: (source) => /身份|外貌|性格|(?:当|當)前(?:状|狀)(?:态|態)/.test(source),
      retries: retranscribed ? 0 : 1,
    });
    retranscribed ||= tr.calls > 1;
    if (!tr.ok) {
      // 轉寫呼叫本身失敗（轉寫那一檔沒人可用）：拆半再寫也一樣轉不了。
      if (batch.length > 1 && !tr.failed) {
        return split(`解不出來（${tr.message}）`);
      }
      t.note(`「${names}」的詳情解不出來（${tr.message}），只按身份清單建卡`);
      return;
    }
    t.note(...tr.value.warnings);
    details.push(...tr.value.items);
  };

  for (let i = 0; i < slots.length; i += ROSTER_DETAIL_BATCH) {
    await runBatch(slots.slice(i, i + ROSTER_DETAIL_BATCH));
  }
  const { entries, warnings } = assembleRoster(slots, details);
  t.note(...warnings);
  return { raw: renderRoster(entries), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 設定清單

/**
 * 設定清單（設定名錄）：清單（截斷或整理不出來重來 1 次）→ 按凍結清單每批 6 條補正文 → 拼條目。2026-10-25 起每一次
 * 都是按小標題寫、轉寫模型照抄成 JSON。路子同 {@link completeRoster}：
 *
 * - 清單不合格就停：分類與名字只在清單裡定一次，後面每一批都以它為準。轉寫呼叫本身失敗不重寫（寫得沒毛病）。
 * - 詳情截斷或轉寫不合格對半拆；單條還是不行、或轉寫呼叫失敗，就只按清單建（一句話），並說明。詳情的轉寫全程只重轉
 *   一次（同從前的語法修復只修一次）。
 * - **呼叫次數封頂 {@link LORE_LIST_CALLS_MAX}**（主按鈕報的上限，第 4 條），轉寫的呼叫也算：一批寫一次、轉寫一次，
 *   剩的餘量不夠這兩次就不再寫，剩下的條目只按清單建；餘量不夠就不重轉。三十條逐批拆到底是幾十次呼叫，報給作者的數
 *   不能是擺設。
 */
export async function completeLoreList(first: CallOutcome, io: ChainIO, known: LoreListKnown): Promise<ChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  let retried = false;
  if (out.stop === 'maxTokens') {
    t.note('設定清單被輸出上限截斷，已丟棄並重來一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '設定清單被截斷，重來');
    retried = true;
  }
  const spec: TranscribeSpec<Decoded<LoreManifestDecode>> = {
    label: '設定清單',
    contract: loreListJsonContract(),
    decode: decoder((json: string) => decodeLoreManifest(json, known), (d) => d.message),
    looksLike: (source) => /分(?:类|類)|清(?:单|單)/.test(source),
  };
  const truncated = (o: CallOutcome) =>
    o.stop === 'maxTokens'
      ? t.fail('設定清單重來一次仍被輸出上限截斷。調大設定頁的「最大輸出 token」，或降低思考深度再試。')
      : undefined;
  truncated(out);
  let manifest = await t.transcribeJson(io, out.text, spec);
  if (!manifest.ok && !manifest.failed && !retried) {
    t.note(`設定清單不合格（${manifest.message}），重來一次`);
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_INVALID }), '設定清單不合格，重來');
    truncated(out);
    manifest = await t.transcribeJson(io, out.text, spec);
  }
  if (!manifest.ok) {
    t.fail(`設定清單不合格：${manifest.message}。這一次沒有產出可寫入的設定清單。`);
  }
  t.note(...manifest.value.warnings);
  const { categories, slots } = manifest.value;
  const frozen = frozenLoreList(categories, slots);

  const details: LoreDetail[] = [];
  let retranscribed = false;
  const runBatch = async (batch: LoreListSlot[]): Promise<void> => {
    const names = batch.map((s) => s.title).join('、');
    // 寫一次、轉寫一次：餘量不夠這兩次就不寫了（寫了轉不了也是白寫）。
    if (t.calls + 2 > LORE_LIST_CALLS_MAX) {
      t.note(`已經調了 ${t.calls} 次模型（上限 ${LORE_LIST_CALLS_MAX}），「${names}」只按清單建條目`);
      return;
    }
    const done = details.length
      ? details.map((d) => `- ${d.title}：${slots.find((s) => s.title === d.title)?.brief ?? ''}`).join('\n')
      : '';
    const messages = await io.build({
      step: { kind: 'loreListDetails', manifest: frozen, titles: batch.map((s) => s.title), done },
    });
    const res = await t.call(io, messages, `設定詳情（${names}）`);
    const split = async (why: string) => {
      t.note(`${names}的正文${why}，拆成兩半重試`);
      const mid = Math.floor(batch.length / 2);
      await runBatch(batch.slice(0, mid));
      await runBatch(batch.slice(mid));
    };
    if (res.stop === 'maxTokens') {
      if (batch.length > 1) {
        return split('被輸出上限截斷');
      }
      t.note(`「${names}」的正文被輸出上限截斷，只按清單建條目`);
      return;
    }
    const tr = await t.transcribeJson(io, res.text, {
      label: `${names}的正文`,
      contract: loreDetailJsonContract(),
      decode: decoder((json: string): LoreDetailsDecode => decodeLoreDetails(json, batch), (d) => d.message),
      looksLike: (source) => LORE_BODY_LOOK.test(source),
      // 重轉那一次也要在上限以內（這一次寫完之後還剩幾次）。
      retries: !retranscribed && t.calls + 2 <= LORE_LIST_CALLS_MAX ? 1 : 0,
    });
    retranscribed ||= tr.calls > 1;
    if (!tr.ok) {
      if (batch.length > 1 && !tr.failed) {
        return split(`解不出來（${tr.message}）`);
      }
      t.note(`「${names}」的正文解不出來（${tr.message}），只按清單建條目`);
      return;
    }
    t.note(...tr.value.warnings);
    details.push(...tr.value.items);
  };

  for (let i = 0; i < slots.length; i += LORE_LIST_DETAIL_BATCH) {
    await runBatch(slots.slice(i, i + LORE_LIST_DETAIL_BATCH));
  }
  const { entries, warnings } = assembleLoreList(slots, details);
  t.note(...warnings);
  return { raw: renderLoreList(categories, entries), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 展開一條設定

/**
 * 展開一條設定（完善設定，2026-10-19）：寫 1 次（2026-10-25 起按小標題寫），轉寫模型照抄成 JSON 1 次，不合格重轉
 * 1 次——上限 3 次，與報給作者的 `LORE_EXPAND_CALLS` 同一個數（第 4 條）。模型自己給了 JSON 就不轉。
 *
 * **截斷與轉寫不成都不給寫入**：截斷的那一半不可信，沒整理開的原文蓋掉條目比沒寫更糟（同定稿）——鏈停下，
 * 已經收到的輸出留在氣泡裡，沒有落盤卡片。解出來的照程式的規矩過一遍（features/loreExpand.ts：截長、關鍵詞與
 * 子條目對照磁碟上的條目與角色卡），交給氣泡的是規範化結果，丟掉了什麼寫進說明（第 2 條）。
 *
 * `opts.retranscribe: false`：轉寫不合格不重轉（批次展開第二次重來時，上限只剩那麼多——features/lore.ts 的
 * `expandLoreEntries`，`LORE_EXPAND_BATCH_CALLS`）。
 */
export async function completeLoreExpand(
  first: CallOutcome,
  io: ChainIO,
  known: LoreExpandKnown,
  opts: { retranscribe?: boolean } = {}
): Promise<ChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.fail('展開被輸出上限截斷，截斷的那一半不可信，這一次沒有產出可寫入的設定。調大設定頁的「最大輸出 token」，或降低思考深度再試。');
  }
  const tr = await t.transcribeJson(io, first.text, {
    label: '設定展開',
    contract: loreExpandJsonContract(),
    decode: decoder((json: string): LoreExpandDecode => decodeLoreExpansion(json, known), (d) => d.message),
    looksLike: (source) => LORE_BODY_LOOK.test(source),
    retries: opts.retranscribe === false ? 0 : 1,
  });
  if (!tr.ok) {
    t.fail(`展開解析不出來（${tr.message}），這一次沒有產出可寫入的設定。`);
  }
  t.note(...tr.value.warnings);
  return { raw: renderLoreExpansion(tr.value.value), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 落定設定

/**
 * 落定設定（完善設定二期）：寫 1 次（2026-10-25 起按小標題寫），轉寫 1 次、不合格重轉 1 次——上限 3 次，與報給作者的
 * `LORE_SETTLE_CALLS` 同一個數（第 4 條）。截斷與轉寫不成都不給寫入（同展開）。解出來的照程式的規矩過一遍
 * （features/loreSettle.ts：截長、人名、重名、按磁碟認出改的是哪一條已有條目），交給氣泡的是規範化結果，丟掉了什麼
 * 寫進說明（第 2 條）。
 *
 * 討論裡一條都沒定下來（`entries` 是空的）不算失敗：氣泡裡換成一段人話，說清沒寫什麼、列出還沒定的——沒有落盤卡片，
 * 作者接著聊。
 */
export async function completeLoreSettle(first: CallOutcome, io: ChainIO, known: LoreSettleKnown): Promise<ChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.fail('落定設定被輸出上限截斷，截斷的那一半不可信，這一次沒有產出可寫入的設定。調大設定頁的「最大輸出 token」，或降低思考深度再試。');
  }
  const tr = await t.transcribeJson(io, first.text, {
    label: '落定設定',
    contract: loreSettleJsonContract(),
    decode: decoder((json: string): LoreSettleDecode => decodeLoreSettle(json, known), (d) => d.message),
    looksLike: (source) => LORE_BODY_LOOK.test(source) || /(?:还|還)(?:没|沒)定的(?:问|問)(?:题|題)/.test(source),
  });
  if (!tr.ok) {
    t.fail(`落定設定解析不出來（${tr.message}），這一次沒有產出可寫入的設定。`);
  }
  const { value, warnings } = tr.value;
  t.note(...warnings);
  if (value.entries.length === 0) {
    return { raw: renderNothingSettled(value.questions), notes: t.notes, calls: t.calls };
  }
  return { raw: renderLoreSettle(value), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 細綱批次

export interface BlueprintChainResult extends ChainResult {
  items: BlueprintItem[];
}

/** 剛排好的一章在前序細綱一覽裡的樣子：關鍵事件、看點都照落盤後那兩節的樣子（一條一行）。 */
function draftLine(b: BlueprintItem): DraftPlotLine {
  const { sections } = blueprintToPlot(b);
  return { no: b.no, title: b.title, keyEvents: sections.关键事件, highlights: sections.看点 };
}

/**
 * 細綱批次：`chapters` 按 {@link PLOT_BATCH} 一批，每批走上游 SBE 的降級鏈，中間多一步轉寫（2026-10-25 細綱試點）。
 *
 * `first` 是對話頁已經流式跑完的第一批（它的範圍必須正好是 `chapters` 的前 5 章）；
 * 批次那條路不給，第一批也由鏈自己調。
 *
 * - 寫細綱的模型按小標題寫自然語言（context/prompts.ts 的 `blueprintFormat`），轉寫模型照抄成 JSON
 *   （{@link transcribeBlueprints}）。模型自己給了合格的 JSON 就不轉。
 * - 截斷：多章對半拆；單章緊湊重建（每章至多一次）。
 * - 轉寫不合格：全程只重轉一次；還不合格，多章對半拆、單章緊湊重建（同截斷）。
 * - 重複章、越界章：報錯。
 * - **漏章**：原文裡壓根沒寫這一章（連「第 N 章」都沒有）——模型偷懶，報錯、整批不寫，對偷懶的輸出不無限重試
 *   （上游同一條規矩）；原文寫了、轉寫漏了，算轉寫不合格。
 */
export async function completeBlueprints(
  first: CallOutcome | undefined,
  io: ChainIO,
  chapters: readonly number[]
): Promise<BlueprintChainResult> {
  // 顯式標註型別：`t.fail()` 返回 never，TS 只對顯式標註的變數做控制流收窄。
  const t: Tally = new Tally(!!first);
  const validated: BlueprintItem[] = [];
  const compacted = new Set<number>();
  const retry = { used: false };

  const exec = async (items: number[], compact?: { diagnostic?: string }, preset?: CallOutcome): Promise<void> => {
    const from = items[0];
    const to = items[items.length - 1];
    const where = span(from, to);
    const single = items.length === 1;
    let out: CallOutcome;
    if (preset) {
      out = preset;
    } else {
      const messages = await io.build({
        range: { from, to },
        targetNo: from,
        step: compact ? { kind: 'blueprintCompact', diagnostic: compact.diagnostic } : undefined,
        draftPlots: validated.map(draftLine),
      });
      out = await t.call(io, messages, compact ? `${where}單章重建` : `${where}的細綱`);
    }

    const canCompact = single && !compacted.has(from);
    const rebuild = async (why: string, diagnostic?: string) => {
      compacted.add(from);
      t.note(`${where}${why}，按緊湊合同單章重建一次`);
      await exec(items, { diagnostic: diagnostic ?? why });
    };
    const split = async (why: string) => {
      t.note(`${where}${why}，拆成兩半重試`);
      const mid = Math.floor(items.length / 2);
      await exec(items.slice(0, mid));
      await exec(items.slice(mid));
    };

    if (out.stop === 'maxTokens') {
      if (!single) {
        return split('被輸出上限截斷');
      }
      if (canCompact) {
        return rebuild('被輸出上限截斷');
      }
      t.fail(`${where}的細綱單章重建仍被輸出上限截斷。調大設定頁的「最大輸出 token」，或降低思考深度再試。`);
    }

    const v = await transcribeBlueprints(t, io, out.text, items, retry);
    if (!v.ok) {
      if (v.kind === 'absent') {
        t.fail(`模型漏寫了第 ${v.chapters.join('、')} 章。漏章時不猜也不補，這一批沒有寫入任何細綱。`);
      }
      if (v.kind === 'duplicate') {
        t.fail(`輸出裡第 ${v.chapters.join('、')} 章出現了不止一次，說不清哪一份算數。這一批沒有寫入任何細綱。`);
      }
      if (v.kind === 'unexpected') {
        t.fail(`輸出裡多出了這一批以外的第 ${v.chapters.join('、')} 章。這一批沒有寫入任何細綱。`);
      }
      if (!single) {
        return split(`解不出來（${v.message}）`);
      }
      if (canCompact) {
        return rebuild(`解不出來（${v.message}）`, v.diagnostic);
      }
      t.fail(`${where}的細綱不合格：${v.message}。這一批沒有寫入任何細綱。`);
    }
    t.note(...v.warnings);
    validated.push(...items.map((no) => v.items.find((b) => b.no === no)!));
  };

  for (let i = 0; i < chapters.length; i += PLOT_BATCH) {
    const batch = chapters.slice(i, i + PLOT_BATCH);
    await exec([...batch], undefined, i === 0 ? first : undefined);
  }
  return { raw: renderBlueprints(validated), notes: t.notes, calls: t.calls, items: validated };
}

// ---------------------------------------------------------------- 細綱的轉寫

/**
 * 轉寫時不比原文的鍵：按對應關係填的（章號、推進/埋、主角/反派、男/女、新不新、第幾章前收），以及分類——
 * 原文沒寫分類時轉寫模型照名字補一個，是歸類不是改寫。其餘每一段文字都得出自原文。
 */
const TRANSCRIBE_MAPPED: ReadonlySet<string> = new Set(['chapterNumber', 'type', 'role', 'gender', 'isNew', 'resolve', 'category']);

/** 合同欄位 → 原文裡的小標題。緊湊重建時告訴寫細綱的模型缺的是哪一節（它寫的是小標題，不認 JSON 路徑）。 */
const FIELD_SECTION: Record<string, string> = {
  title: '标题',
  synopsis: '梗概',
  characters: '出场人物',
  keyEvents: '关键事件',
};

type BlueprintVerdict =
  | { ok: true; items: BlueprintItem[]; warnings: string[] }
  | {
      ok: false;
      /** absent：原文就沒寫這幾章；duplicate / unexpected：同號不止一份、多出了這一批以外的；其餘是轉寫不合格。 */
      kind: 'absent' | 'duplicate' | 'unexpected' | 'invalid';
      message: string;
      chapters: number[];
      /** 緊湊重建時給寫細綱的模型的那一句。 */
      diagnostic?: string;
    };

/** 原文裡有沒有提到第 N 章（「第 3 章」「第三章」都算）。 */
function mentionsChapter(source: string, no: number): boolean {
  return new RegExp(`第\\s*(?:${no}|${cnNumber(no)})\\s*章`).test(source);
}

/** 原文裡有沒有細綱的樣子：小標題（梗概、關鍵事件），或者是一段壞了語法的 JSON（轉寫順帶把它理順）。 */
function looksLikePlot(source: string): boolean {
  return /梗概|(?:关|關)(?:键|鍵)事件|synopsis|keyEvents/.test(source);
}

const NOT_A_PLOT = '沒有按格式寫（認不出「梗概」「關鍵事件」這些小標題）';

/**
 * 一份 JSON（轉寫的輸出，或模型自己給的）按這一批的合同判：解得開、章對得上、每段文字出自原文。模型自己給的 JSON
 * （`text` 就是原文）不比原文——拿自己比自己。
 */
function judgeBlueprints(text: string, source: string, items: readonly number[]): BlueprintVerdict {
  const value = jsonValueOf(text);
  const decoded = decodeBlueprints(value === undefined ? text : JSON.stringify(withoutNone(value)));
  if (!decoded.ok) {
    const d = decoded.diagnostic;
    const section = FIELD_SECTION[d.path.split('.').pop() ?? ''];
    return {
      ok: false,
      kind: 'invalid',
      message: d.message,
      chapters: [],
      ...(section ? { diagnostic: `「${traditionalLabel(section)}」那一節缺了或是空的` } : {}),
    };
  }
  const cov = checkCoverage(decoded.items, items);
  if (cov.duplicate.length > 0) {
    return { ok: false, kind: 'duplicate', message: `第 ${cov.duplicate.join('、')} 章出現了不止一次`, chapters: cov.duplicate };
  }
  if (cov.unexpected.length > 0) {
    return { ok: false, kind: 'unexpected', message: `多出了第 ${cov.unexpected.join('、')} 章`, chapters: cov.unexpected };
  }
  if (cov.missing.length > 0) {
    // 單章時原文不寫章號也是這一章（轉寫合同裡給了章號），漏了只能是轉寫的事。
    const absent = items.length > 1 ? cov.missing.filter((no) => !mentionsChapter(source, no)) : [];
    return absent.length > 0
      ? { ok: false, kind: 'absent', message: `原文沒寫第 ${absent.join('、')} 章`, chapters: absent }
      : { ok: false, kind: 'invalid', message: `缺第 ${cov.missing.join('、')} 章`, chapters: cov.missing };
  }
  const off = text === source ? [] : unfaithfulStrings(source, value, TRANSCRIBE_MAPPED);
  if (off.length > 0) {
    return { ok: false, kind: 'invalid', message: `這幾處不是原文裡的字：${off.map((s) => `「${s}」`).join('、')}`, chapters: [] };
  }
  return { ok: true, items: decoded.items, warnings: decoded.warnings };
}

/**
 * 一批細綱的原文 → 解出來的這幾章（2026-10-25 細綱試點）。
 *
 * - 原文字身就是合格的 JSON（模型沒照格式寫、老會話）：不轉，直接按合同判。
 * - 原文連細綱的樣子都沒有（{@link looksLikePlot}）：不轉，按解不出來交回去——轉寫搬不出原文沒有的東西。
 * - 否則交給轉寫模型（{@link ChainIO.transcribe}）。轉寫不合格——截斷、解不開、漏了原文寫了的章、改了原文的字——
 *   重轉一次，說清上次哪裡不對；**全程只重轉一次**（`retry`，同從前的語法修復）。原文就沒寫的章（偷懶）不重轉。
 */
async function transcribeBlueprints(
  t: Tally,
  io: ChainIO,
  source: string,
  items: readonly number[],
  retry: { used: boolean }
): Promise<BlueprintVerdict> {
  if (jsonValueOf(source) !== undefined) {
    return judgeBlueprints(source, source, items);
  }
  // 連「梗概」「關鍵事件」都沒有的（「我不太確定這幾章寫什麼」）不是細綱，轉寫也搬不出東西，不花這一次。
  if (!looksLikePlot(source)) {
    return { ok: false, kind: 'invalid', message: NOT_A_PLOT, chapters: [], diagnostic: NOT_A_PLOT };
  }
  const range = { from: items[0], to: items[items.length - 1] };
  const where = span(range.from, range.to);
  let feedback: string | undefined;
  for (;;) {
    const out = await tryTranscribe(t, io, blueprintTranscribeMessages(source, range, feedback), `${where}轉寫成 JSON`);
    if ('failed' in out) {
      // ChainError：寫好的原文留在氣泡裡（generation/generate.ts），作者拿得走。
      t.fail(`${where}的轉寫呼叫失敗（${out.failed}）。這一批沒有寫入任何細綱。`);
    }
    const v: BlueprintVerdict =
      out.stop === 'maxTokens'
        ? { ok: false, kind: 'invalid', message: '轉寫被輸出上限截斷', chapters: [] }
        : judgeBlueprints(out.text, source, items);
    if (v.ok || v.kind === 'absent' || retry.used) {
      return v;
    }
    retry.used = true;
    feedback = v.message;
    t.note(`${where}轉寫不合格（${v.message}），重轉一次`);
  }
}

/**
 * 單章細綱（寫第 N 章細綱、落定細綱）：寫細綱的模型按小標題寫了一章（第一次呼叫，對話頁已經流式跑完），轉寫模型照抄成
 * JSON（2026-10-25 細綱試點）。氣泡最後換成規範化 JSON（`{"blueprints":[…]}`，`features/artifact.ts` 的 `parsePlotStrict` 認它）。
 *
 * 比批次寬鬆，同從前的單章：這件產物作者當場過目。截斷只說一句、照樣轉；轉寫不合格重轉一次，還不合格就把原文交回去，
 * 解析那一層按小節讀（梗概、關鍵事件……那七節讀得出來，敘事線的計劃、新角色與「設定」一節讀不出來），說明裡寫清。
 * 模型自己給了 JSON 就不轉，原樣交回去（同從前）。
 */
export async function completePlot(first: CallOutcome, io: ChainIO, no: number | undefined): Promise<ChainResult> {
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.note('輸出被輸出上限截斷，後半段可能缺失。調大設定頁的「最大輸出 token」再生成一次更穩。');
  }
  const source = first.text.trim();
  if (jsonValueOf(source) !== undefined) {
    return { raw: source, notes: t.notes, calls: t.calls };
  }
  if (!looksLikePlot(source)) {
    t.note(`${NOT_A_PLOT}，沒有轉寫`);
    return { raw: source, notes: t.notes, calls: t.calls };
  }
  const range = no !== undefined ? { from: no, to: no } : undefined;
  let feedback: string | undefined;
  for (let round = 0; round < 2; round++) {
    const out = await tryTranscribe(t, io, blueprintTranscribeMessages(source, range, feedback), '轉寫成 JSON');
    if ('failed' in out) {
      t.note(`轉寫呼叫失敗（${out.failed}）`);
      break;
    }
    const problem = plotTranscriptProblem(out, source);
    if (!problem) {
      return { raw: JSON.stringify(withoutNone(jsonValueOf(out.text)), null, 2), notes: t.notes, calls: t.calls };
    }
    feedback = problem;
    t.note(round === 0 ? `轉寫不合格（${problem}），重轉一次` : `重轉仍不合格（${problem}）`);
  }
  t.note('轉寫沒成，按小節讀了原文：敘事線的計劃、新角色與「設定」一節沒帶上，要它們就重新生成一次');
  return { raw: source, notes: t.notes, calls: t.calls };
}

/**
 * 轉寫一次。呼叫本身失敗（池裡同檔換完了人、閘道器報錯）不往外拋，交回原因——寫好的原文不能跟著丟：批次報 `ChainError`、
 * 原文留在氣泡裡，單章按小節讀。作者點了停止照舊往外拋。
 */
async function tryTranscribe(t: Tally, io: ChainIO, messages: ChatMessage[], label: string): Promise<CallOutcome | { failed: string }> {
  try {
    return await t.transcribe(io, messages, label);
  } catch (err) {
    if (err instanceof CancelledError) {
      throw err;
    }
    return { failed: describeError(err) };
  }
}

/** 單章的轉寫哪裡不合格；合格返回 undefined。只查解不解得開、有沒有內容、文字是不是出自原文——形狀寬鬆，同單章的解析。 */
function plotTranscriptProblem(out: CallOutcome, source: string): string | undefined {
  if (out.stop === 'maxTokens') {
    return '轉寫被輸出上限截斷';
  }
  const value = jsonValueOf(out.text);
  if (value === undefined) {
    return '轉寫出來的不是一個完整的 JSON 物件';
  }
  const off = unfaithfulStrings(source, value, TRANSCRIBE_MAPPED);
  if (off.length > 0) {
    return `這幾處不是原文裡的字：${off.map((s) => `「${s}」`).join('、')}`;
  }
  return parsePlotStrict(JSON.stringify(withoutNone(value))) ? undefined : '轉寫出來是空的';
}

// ---------------------------------------------------------------- 單次產物的說明

/**
 * 不走鏈的產物（前提、世界觀、大綱）也要把看得見的問題說出來：
 * 輸出被截斷、續寫的那一段大綱沒覆蓋到本批的最後一章。
 */
export function singleShotNotes(
  stage: string,
  raw: string,
  stop: StopSignal | undefined,
  range?: { from: number; to: number }
): string[] {
  const notes: string[] = [];
  if (stop === 'maxTokens') {
    notes.push('輸出被輸出上限截斷，後半段可能缺失。調大設定頁的「最大輸出 token」再生成一次更穩。');
  }
  if (stage === 'outline' && range) {
    const nos = new Set(parseOutline(raw).map((e) => e.no));
    const merged = outlineRangeHeadings(raw);
    if (merged > 0) {
      notes.push(`有 ${merged} 個「## 第a–b章」這樣的區間標題：大綱一章一條，區間標題不認，那幾節寫入後不算進任何一章`);
    }
    if (nos.size === 0) {
      notes.push('產出裡認不出「## 第N章：標題」這樣的章標題，寫入後算不出大綱覆蓋到第幾章');
    } else {
      const covered = Math.max(...nos);
      if (covered < range.to) {
        notes.push(`產出只寫到第 ${covered} 章（這一批要寫到第 ${range.to} 章），寫入後主按鈕會接著推續寫`);
      }
      const missing: number[] = [];
      for (let no = range.from; no <= Math.min(covered, range.to); no++) {
        if (!nos.has(no)) {
          missing.push(no);
        }
      }
      if (missing.length > 0) {
        notes.push(`缺第 ${missing.join('、')} 章：這幾章拆細綱時沒有大綱可依，可以重新生成，或手動補上`);
      }
    }
  }
  return notes;
}

/**
 * 這次生成要不要接鏈、接哪一條。正文那一條在 generation/continuation.ts，審稿與修稿（五期）
 * 在 generation/review.ts、generation/revision.ts。
 *
 * **審稿必須在正文之前認出來**：它也在正文層，按「正文層不是討論就走續寫鏈」的舊判據，一份審稿
 * JSON 會被當成一章正文去續寫、去查重演。
 */
export type ChainKind =
  | 'config'
  | 'roster'
  | 'loreList'
  | 'loreExpand'
  | 'loreSettle'
  | 'blueprints'
  | 'plot'
  | 'manuscript'
  | 'review'
  | 'revision';

/** 架構那幾件裡要接鏈的：配置、角色圖譜、設定清單。前提、世界觀一次就完。 */
const SETTING_CHAIN: Partial<Record<SettingDoc, ChainKind>> = { config: 'config', characters: 'roster', lore: 'loreList' };

export function chainOf(request: Pick<BuildRequest, 'action' | 'target' | 'range' | 'writeMode'>): ChainKind | undefined {
  const { stage, capability } = request.action;
  if (capability === 'discuss') {
    return undefined;
  }
  if (capability === 'review') {
    return 'review';
  }
  if (stage === 'manuscript') {
    return request.writeMode === 'revise' ? 'revision' : 'manuscript';
  }
  // 落定設定（完善設定二期）：目標是設定目錄，但不是設定清單那條鏈——按能力認，排在那張表之前。
  if (isLoreSettle(request.action)) {
    return 'loreSettle';
  }
  if (stage === 'setting' && request.target.kind === 'setting') {
    return SETTING_CHAIN[request.target.doc];
  }
  // 單條設定（展開）：不落到架構五件那張表上——`doc === 'lore'` 是整批清單那條鏈。
  if (stage === 'setting' && request.target.kind === 'lore') {
    return 'loreExpand';
  }
  if (stage === 'plot' && capability === 'generate' && request.range) {
    return 'blueprints';
  }
  // 單章細綱（寫第 N 章細綱、落定細綱）：寫完轉寫一次（2026-10-25 細綱試點）。
  if (stage === 'plot' && (capability === 'generate' || capability === 'settle')) {
    return 'plot';
  }
  return undefined;
}

/** 一段區間裡的章號（閉區間）。 */
export function chaptersOf(range: { from: number; to: number }): number[] {
  const out: number[] = [];
  for (let no = range.from; no <= range.to; no++) {
    out.push(no);
  }
  return out;
}
