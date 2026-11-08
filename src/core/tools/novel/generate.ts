/**
 * `generate` —— 「agent 只做上層排程，實際生成通過工具呼叫」的落點。
 *
 * ## 五件必須做對的事
 *
 * 1. **產物絕不回灌 agent 上下文**。返回文字裡只有形狀與 draftId，**沒有
 *    正文**。一份三千字的正文塞回迴圈，agent 每走一步就重燒一遍——十步之後
 *    這一份正文被算了十次錢。要看內容讓它顯式 `read`。
 * 2. **`history` 傳空陣列**。agent 的工具呼叫不是作者的討論，混進裝配器會被
 *    當成創作要求裝進 prompt（「使用者剛才說：list .novelwarden/summaries」）。唯一
 *    該帶歷史的能力是 `settle`（落定細綱、落定設定）——它要沉澱的就是一段討論，所以**不支援它**。
 * 3. **哪一層用哪個模型**，AGENTS 第 12 條的延伸：
 *
 *    | 層 | 用哪個模型 | 為什麼 |
 *    |---|---|---|
 *    | `manuscript` | **對話頁選定的那個**，不走池 | 中途換人會讓文風斷掉 |
 *    | `outline` | 同上 | 一次定調，而且沒有對應檔位 |
 *    | `setting` | `setting` 檔（故事架構） | 與工程頁「補齊架構」同一個模型 |
 *    | `plot` | `plotOutline` 檔 | 與工程頁「批次拆細綱」同一個模型 |
 *
 *    走池時**必須把池的 `primaryBudget` 一起傳下去**（第 13 條）：
 *    `config.contextWindow` 跟著對話頁那個模型走，拿 200k 的視窗給快速檔的
 *    32k 模型裝配上下文會穩定超窗。
 * 4. **流式內容照舊推給前端**：作者看得見 agent 在寫什麼，而不是盯著一個
 *    「正在生成」轉十幾秒（第 11 條：不悶著幹活）。
 * 5. **發請求之前先 `usage.record(1)`**（第 4 條：不偷偷燒 token）。記在前面是
 *    因為**請求發出去錢就花了**——中途拋異常、被取消，那一次照樣收費。等函式
 *    返回再記，異常那條路上的錢就丟賬了。**這裡只報數，不判斷觸沒觸頂**：
 *    上限是呼叫方的事，工具連「上限是多少」都不知道。
 *
 * ## 層與目標從路徑反推
 *
 * `kindOfPath` 一次給出 `stage` 與 `target`，不必讓模型填 `{kind, chapterNo}`
 * 那種巢狀結構——路徑是產物在這個工程裡的身份，作者在檔案管理器裡看到的
 * 就是它。**章節路徑是例外**：正文層的 target 以細綱路徑為身份，章節路徑要換成
 * 這一章的細綱（正文在 `summaries/` 下的映象），那一步要讀盤，在這裡做。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { int, objectSchema, str } from '../schema';
import { clip, describeForReview, describePath, text } from './naming';
import { generate } from '../../generation/generate';
import { createModelPool } from '../../llm/pool';
import type { LlmProvider } from '../../llm/provider';
import { scoped } from '../../runtime/logger';
import type { LlmTask } from '../../model/tiers';
import { kindOfPath, normalizeRel, pathOfTarget } from '../../workspace';
import type { PathKind } from '../../workspace';
import type { NovelProject } from '../../model/project';
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  Capability,
  CreationStage,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  isCapability,
  isValidAction,
} from '../../model/pipeline';

const log = scoped('MCP');

/**
 * 哪一層走哪一檔。**列在這裡的才走池**——不在表裡的（正文、大綱）嚴格用
 * 對話頁選定的那個模型，不走池、不 fallback（第 12 條）。
 *
 * 沒有審稿檔：這個工具不做審稿（`capability === 'review'` 當場報錯，理由寫在那裡）。
 * `review` 檔只給批次寫章的「寫完即審稿」用。
 */
/** 正文層可選的兩種寫法。修稿只從審稿報告卡進來，這裡不給。 */
const WRITE_MODES = ['continue', 'rewrite'] as const;

const TIER_TASK: Partial<Record<CreationStage, LlmTask>> = {
  setting: 'setting',
  plot: 'plotOutline',
};

export const generateTool: ToolDef = {
  name: 'generate',
  costly: true,

  /**
   * 花錢但不寫盤 → `costly`。呼叫方據此決定問不問（謹慎模式問，平時不問）。
   *
   * 卡片上必須寫清**會花錢**與**產出還會再問一次**：「Agent 想呼叫 generate，
   * 允許嗎」作者答不上來，他不知道會寫到哪、花多少。**這一問是「要不要花錢
   * 生成」，落盤是另一問**——產出之後當場還有一張卡（第 19 條）。
   */
  intent(args, project): ToolIntent {
    const target = text(args.target);
    const dir = project ? settingDirPath(project, target) : undefined;
    return {
      gate: 'costly',
      title: `為「${dir ? describeForReview(dir, target) : describePath(target, project)}」調一次創作模型`,
      detail: [
        target,
        text(args.writeMode) === 'continue' ? '接著已有的正文往下寫' : text(args.writeMode) === 'rewrite' ? '整章重寫' : '',
        text(args.ask) && `要求：${clip(text(args.ask))}`,
        '這一步會花錢。產出之後還會再問你一次要不要落盤。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },

  description:
    '呼叫創作模型，為某一份產物生成內容。target 是那份產物的工程內相對路徑，' +
    '層由路徑決定：.novelwarden/config.md、premise.md、world.md 是架構層，角色圖譜給角色目錄 .novelwarden/characters 本身（一次排出一批角色卡），' +
    '設定清單給設定目錄 .novelwarden/lore 本身（一次排一批設定條目），' +
    '展開一條設定給那一條條目的路徑（.novelwarden/lore/ 下的 .md，如 .novelwarden/lore/宗门/天机阁.md：照已排的細綱把它往前想細，可能建議拆出幾條空條目），' +
    '.novelwarden/outline.md 是大綱層（各章細綱「梗概」的彙總，採納時按章號寫回各章細綱），.novelwarden/summaries/ 下的細綱是細綱層（一章一份，與正文同樣的相對路徑、副檔名 .md，' +
    '如 .novelwarden/summaries/上部/003-夜访.md），' +
    '正文層給那一章的章節路徑（chapters/ 下，可以在子目錄裡；還沒寫過的章寫成 chapters/<章號>.md 即可，' +
    '按章號認到這一章的細綱）。**細綱路徑永遠是細綱層**，要寫正文不要給細綱路徑。' +
    '這一章已經有正文時用 writeMode 說清是接著寫（continue）還是整章重寫（rewrite，預設）。' +
    '各層可用的 capability 不同：' +
    // 架構那一層的 settle（落定設定）只給對話頁：它要沉澱作者剛才的討論，這裡沒有那段討論（見 run 裡的拒絕）。
    Object.entries(STAGE_CAPABILITIES)
      .map(([stage, caps]) => `${stage}=${caps.filter((c) => c !== 'review' && !(stage === 'setting' && c === 'settle')).join('/')}`)
      .join('；') +
    '（審稿只能由作者在對話頁發起，這個工具不做）。' +
    '**返回的只有形狀與 draftId，沒有正文**——正文會直接流給作者看；' +
    '你要看內容就等它落盤之後再 read。' +
    '產出之後會當場請作者點頭，同意才落盤，結果寫在返回裡；不必也不要再用 write 寫同一份。' +
    '這個工具會真的調模型花錢，每次呼叫都會記賬，不要重複生成同一份東西。',

  parameters: objectSchema(
    {
      target: str('要生成的那份產物的工程內相對路徑。'),
      capability: str(`要它幹什麼。${describeCapabilities()}`, CAPABILITIES),
      ask: str('補充要求，可留空。留空時按上一層的產物照常生成。'),
      targetWords: int('目標字數，只對正文層有意義。留空取細綱的目標字數，再沒有取小說配置的每章字數；不到八成會自動續寫。'),
      writeMode: str(
        '正文層這一章已經有字時怎麼寫，其餘層不認：continue=接著已有的正文往下寫，落盤時追加到末尾；' +
          'rewrite=整章重寫，落盤時覆蓋（作者會先逐行對比）。預設 rewrite。這一章還沒有正文時兩者一樣，就是從頭寫。',
        [...WRITE_MODES]
      ),
    },
    ['target', 'capability']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.target === 'string' ? args.target.trim() : '';
    const capability = args.capability;

    if (!isCapability(capability)) {
      return { text: '', error: `capability 只能是：${CAPABILITIES.join(' / ')}。` };
    }
    // `settle` 沉澱的是**一段已經發生過的討論**，而 agent 手裡沒有那段討論
    // （history 恆為空，見檔案頭第 2 條）。餵它一個空歷史，它會憑空編一份
    // 「剛才討論出的結論」——那比不支援更糟。落定細綱、落定設定（完善設定二期）都一樣。
    if (capability === 'settle') {
      return {
        text: '',
        error:
          'settle 要沉澱的是作者與模型剛剛討論出的結論，而你手上沒有那段討論。' +
          '請讓作者在對話頁手動落定（/落定細綱、/落定設定）；要按你自己的思路排細綱、展開一條設定用 capability=generate。',
      };
    }

    // `review` 只出報告，要作者在報告卡上勾選之後才修稿——agent 拿到一份「2 嚴重 · 1 建議」
    // 做不了什麼，也不該替作者決定哪幾條算數；作者要審稿，對話頁 `/審稿` 或章節條上一顆按鈕
    // 就到。五期把開不開放留給六期，六期定了不開放。
    if (capability === 'review') {
      return {
        text: '',
        error: '審稿要作者在對話頁的正文層發起（/審稿，或章節條上的「審稿」），報告由作者勾選之後再修稿。這個工具不做審稿。',
      };
    }

    const path = await resolveTargetPath(ctx.project, rel);
    if (!path.stage || !path.target) {
      return {
        text: '',
        error:
          `認不出「${rel}」是哪一層的產物。` +
          '架構給 .novelwarden/config.md / premise.md / world.md（角色圖譜給 .novelwarden/characters，設定清單給 .novelwarden/lore，展開一條設定給 .novelwarden/lore/ 下那一條的 .md），大綱給 .novelwarden/outline.md，' +
          '細綱給 .novelwarden/summaries/ 下那一章的細綱（與正文同樣的相對路徑），正文給那一章的章節路徑（chapters/ 下）。' +
          '可以先用 list 看看那個目錄下實際有什麼。',
      };
    }

    const writeMode = typeof args.writeMode === 'string' ? args.writeMode.trim() : '';
    if (writeMode && !(WRITE_MODES as readonly string[]).includes(writeMode)) {
      return { text: '', error: `writeMode 只能是 ${WRITE_MODES.join(' / ')}，收到的是「${writeMode}」。` };
    }
    if (writeMode && path.stage !== 'manuscript') {
      return { text: '', error: 'writeMode 只對正文層有意義（target 給章節路徑）。其餘層不要給它。' };
    }

    const action = { stage: path.stage, capability: capability as Capability };
    if (!isValidAction(action)) {
      return {
        text: '',
        error:
          `${STAGE_LABEL[path.stage]}層不支援 ${capability}。` +
          `這一層可用：${STAGE_CAPABILITIES[path.stage].filter((c) => c !== 'settle' && c !== 'review').join(' / ')}。`,
      };
    }

    // 記在發請求之前：請求發出去錢就花了，拋異常也一樣。
    ctx.usage.record(1);
    let failure: string | undefined;
    const picked = await pickModel(path.stage);

    const { draft } = await generate(
      ctx.project,
      {
        action,
        target: path.target,
        targetNo: path.no,
        ask: typeof args.ask === 'string' ? args.ask : '',
        targetWords: toPositiveInt(args.targetWords),
        ...(writeMode ? { writeMode: writeMode as 'continue' | 'rewrite' } : {}),
        // 空陣列，見檔案頭第 2 條。**不要改成 ctx 裡的什麼歷史。**
        history: [],
      },
      {
        // 正文流給前端氣泡，不進 agent 上下文。
        onDelta: (delta) => ctx.onDelta?.(delta),
        onDone: () => undefined,
        onError: (message) => {
          failure = message;
        },
        onCancelled: () => {
          failure = '生成被取消。';
        },
      },
      // provider 留空 = 用對話頁選定的那個模型（第 12 條）。
      //
      // **不帶 thinking**（第 26 條）：作者選的那一檔是給「他自己在跟模型討論
      // 這件事」的，而這裡是外部 agent 順手產出一份產物——它可能連著調好幾次，
      // 每次都按極限檔想一遍，等於把那個下拉框變成一個倍率不明的開關。
      { signal: ctx.signal, ...picked }
    );

    if (!draft) {
      return { text: '', error: failure ?? '這次生成沒有產出內容。' };
    }
    ctx.drafts.put(draft, ctx.sessionId);

    const what = `${STAGE_LABEL[path.stage]}·${CAPABILITY_LABEL[action.capability]}`;
    const shape = draft.summary ?? `${draft.words} 字`;
    // 只說發生了什麼。「已用 3/10 次生成」那半句是呼叫方的賬，它才知道上限。
    ctx.report(`已生成 ${what}：${shape}`);

    return {
      draftIds: [draft.id],
      // 只有形狀與 id。**這裡出現正文就是 bug。**
      text:
        `已生成：${what} · ${shape}，${draft.words} 字\n` +
        `draftId: ${draft.id}\n` +
        `落點：${rel}\n` +
        `內容已經流給作者看了。要不要落盤正在問他，結論就在下面。` +
        `你不需要複述它的內容。`,
      display: { title: `generate ${what}`, detail: `${shape} · ${draft.words} 字` },
    };
  },
};

/**
 * 這一層該用哪個模型。
 *
 * 返回空物件 = 用對話頁選定的那個（`generate` 的預設）。這也是池建不出來時的
 * 退路：報一條 warn 然後照常跑，好過讓 agent 在這裡硬失敗——作者已經在對話頁
 * 選了一個能用的模型。
 *
 * **只取 `pool.primary`，不用 `pool.run` 的失敗換人**：`generate` 是流式的，
 * 換一個模型重跑會把半份產物再衝一遍進作者的氣泡。序列恆用該檔首選本來就是
 * 池的行為，這裡少的只有 fallback 那一半，而且**絕不跨檔**。
 */
async function pickModel(
  stage: CreationStage
): Promise<{ provider?: LlmProvider; budget?: { contextWindow: number; maxOutputTokens: number } }> {
  const task = TIER_TASK[stage];
  if (!task) {
    return {};
  }
  const pool = await createModelPool({ task });
  if (!pool) {
    log.warn(`${STAGE_LABEL[stage]}層沒有可用的分檔模型，改用對話頁選定的那個`);
    return {};
  }
  // 視窗必須跟著幹活那個模型走（第 13 條）。
  return { provider: pool.primary, budget: pool.primaryBudget };
}

function describeCapabilities(): string {
  // 審稿（五期）這個工具不做：不寫進說明，免得模型照著說明去試。
  return CAPABILITIES.filter((c) => c !== 'review').map((c) => `${c}=${CAPABILITY_LABEL[c]}`).join('，');
}

function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/**
 * 路徑 → 層與目標。章節路徑認成正文層（target 以這一章細綱的路徑為身份——正文映象到
 * `summaries/` 下的那一份，還沒有時就是它應該在的位置）；角色目錄、設定目錄本身認成架構 · 角色圖譜 / 設定清單；
 * 其餘交給 `kindOfPath`（一條設定條目它直接給出單條設定這個目標——展開，走 `setting` 檔，不用特判）。
 */
async function resolveTargetPath(project: NovelProject, rel: string): Promise<PathKind> {
  const dir = settingDirPath(project, rel);
  if (dir) {
    return dir;
  }
  const path = kindOfPath(project, rel);
  if (path.kind !== 'chapter' || path.no === undefined) {
    return path;
  }
  const exists = (await project.listChapters()).some((c) => c.relPath === path.rel);
  // 還不存在的章節路徑（`chapters/021.md`）不拿來映象：這一章的細綱可能早已排在子目錄裡。
  const plotRelPath = exists ? project.plotPathForChapter(path.rel!) : await project.plotPathOfNo(path.no);
  return {
    ...path,
    stage: 'manuscript',
    target: { kind: 'manuscript', plotRelPath },
    plotRelPath,
  };
}

/**
 * 架構裡沒有自己檔案的兩件：角色目錄本身（`.novelwarden/characters`）= 角色圖譜，設定目錄本身（`.novelwarden/lore`）=
 * 設定清單（`pathOfTarget` 的落點就是它們，工程頁「故事架構」那兩行的路徑也是）。**只在這個工具裡認**：閘道器的種類表
 * （`kindOfPath`）不把一個目錄當成可寫的產物——寫入、改名、刪除都不該落在它上面。
 */
function settingDirPath(project: NovelProject, rel: string): PathKind | undefined {
  const normalized = normalizeRel(rel);
  const doc = (['characters', 'lore'] as const).find((d) => normalized && normalized === pathOfTarget(project, { kind: 'setting', doc: d }));
  if (!normalized || !doc) {
    return undefined;
  }
  return { kind: 'setting', rel: normalized, doc, stage: 'setting', target: { kind: 'setting', doc } };
}
