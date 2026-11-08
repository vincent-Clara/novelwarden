/**
 * `write` —— agent 的落盤口。**一次 `ws.write`，沒有別的。**
 *
 * ## 這裡為什麼沒有任何保護程式碼
 *
 * 越界、回收站、大小上限、同名不覆蓋、覆蓋前審閱、樂觀鎖——八條守衛全在
 * `workspace/guard.ts` 裡做過一次，渲染、`upstreamHash` 記賬、
 * 伴生搬遷在 handler 裡做過一次。這一層要做的只有三件**屬於 agent 的**事：
 *
 * 1. **把 draftId 換成 artifact**（等價於作者在那張落盤卡片上點了「寫入」）；
 * 2. **把守衛的結論翻譯成模型能照著改的話**（越界了、已存在了、作者沒採納）；
 * 3. **記賬失敗**（第 16 條）。
 *
 * 如果哪天要在這裡寫一段路徑檢查，說明繞過了 workspace——停下來重想。
 *
 * ## 五條硬約束
 *
 * 1. **`review` 永遠 `true`，且不作為工具引數暴露。** 模型不該有能力關掉審閱
 *    （第 3 / 19 條：不靜默覆蓋）。這是產品承諾不是偏好設定。
 * 2. **`draftId` 找不到時 `error`，不靜默降級成寫空檔案。**
 * 3. **draft 沒有 `artifact`（討論這類 text 產出）時 `error`**——
 *    一段批評意見不該被寫成一份細綱。
 * 4. **作者在審閱裡拒絕 → 明說「作者沒有採納」**，讓它別原地重試（重試同一個
 *    動作是最常見的燒錢方式）。
 * 5. **寫失敗 `recordFailure` 掛在對應細綱上，成功 `clearFailures`**（第 16 條）。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { describeForReview, describePath, text } from './naming';
import { WsError, kindOfPath } from '../../workspace';
import type { PathKind, WriteInput } from '../../workspace';
import type { Artifact } from '../../features/artifact';
import { clearFailures, recordFailure } from '../../runtime/errorLog';
import { countWords } from '../../model/fs';
import { describeError } from '../../runtime/logger';

/** 寫入模式。與 `WriteOptions.mode` 同一套值，不另造名字。 */
const MODES = ['create', 'overwrite', 'append'] as const;
type WriteMode = (typeof MODES)[number];

/** 失敗記錄的 op。清記錄時按它篩，兩處必須一致。 */
export const WRITE_OP = 'mcpWrite';

export const writeTool: ToolDef = {
  name: 'write',
  mutating: true,

  /**
   * **覆蓋那一檔是 `reviewed`，不是 `mutating`**：`ws.write` 會帶著 diff 去請
   * 作者過目，在它之前再彈一個「確定嗎」是純噪聲——diff 本身就同時回答了
   * 「要不要動」與「改了什麼」，而後者是前者的依據。
   *
   * 這條不受策略影響（第 25(a) 條），所以它寫在**工具**這一側：只有工具知道
   * 自己隨後會不會走審閱那條路。
   */
  intent(args, project): ToolIntent {
    const mode = text(args.mode) || 'create';
    const target = text(args.path);
    if (mode === 'overwrite') {
      return { gate: 'reviewed', title: `覆蓋「${describePath(target, project)}」` };
    }
    // 寫作技能與它的階段繫結（`.novelwarden/skills/**`、`skills.json`）：改的是往後每一次生成的
    // 提示詞，下游沒有 diff。新建與追加也照 `skills bind` 那樣先問——不然 agent 用 write
    // 新建一份 skills.json，就繞過了 bindSkill 那一問。覆蓋仍走上面的 diff。
    const skill = project !== undefined && kindOfPath(project, target).kind === 'skill';
    return {
      gate: skill ? 'always' : 'mutating',
      title: `寫入「${describePath(target, project)}」`,
      detail: `${target}（${mode === 'append' ? '追加到末尾' : '新建'}）`,
    };
  },

  description:
    '把內容寫進工程裡的一份檔案。path 是工程內相對路徑、用正斜槓。' +
    '內容有兩種給法，二選一：draftId 用 generate 產出的那份草稿（會按該路徑應有的格式渲染、' +
    '並記上游指紋，等價於作者在落盤卡片上點了「寫入」），content 直接給文字。' +
    'mode=create 新建（目標已存在會報錯，這是預設），mode=overwrite 整份替換，mode=append 追加到末尾。' +
    '**覆蓋已有內容一定會先請作者過目**，他可以不同意；追加與新建不打擾他。' +
    '刪除、改名、移動沒有對應的工具——那些由作者自己做。',

  parameters: objectSchema(
    {
      path: str('要寫的檔案，工程內相對路徑。'),
      draftId: str('要落盤的那份草稿的 id（generate 的返回值裡有）。與 content 二選一。'),
      content: str('直接寫進去的文字。與 draftId 二選一。'),
      mode: str(
        '寫入方式：create 新建（預設，已存在會報錯）、overwrite 整份替換、append 追加到末尾。',
        [...MODES]
      ),
    },
    ['path']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rel) {
      return { text: '', error: 'path 是必填的：給一個工程內相對路徑。' };
    }

    const rawMode = typeof args.mode === 'string' ? args.mode.trim() : '';
    if (rawMode && !(MODES as readonly string[]).includes(rawMode)) {
      return { text: '', error: `mode 只能是 ${MODES.join(' / ')}，收到的是「${rawMode}」。` };
    }
    const mode = (rawMode || 'create') as WriteMode;

    const draftId = typeof args.draftId === 'string' ? args.draftId.trim() : '';
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (draftId && content !== undefined) {
      return {
        text: '',
        error: 'draftId 與 content 只能給一個：給了 draftId 就寫那份草稿，給了 content 就寫這段文字。',
      };
    }
    if (!draftId && content === undefined) {
      return {
        text: '',
        error:
          '沒有要寫的內容：給 draftId（落盤 generate 產出的草稿）或者給 content（直接寫文字）。',
      };
    }

    // ---- draftId → artifact。找不到、或者是討論類產出，一律不寫。
    let words: number;
    let input: WriteInput;
    if (draftId) {
      const draft = ctx.drafts.get(draftId);
      if (!draft) {
        return {
          text: '',
          error:
            `沒有 draftId 為 ${draftId} 的草稿。它可能來自更早的輪次、已經被擠掉了。` +
            '重新 generate 一份再寫，或者直接用 content 給文字。',
        };
      }
      const artifact = artifactOf(draft);
      if (!artifact) {
        return {
          text: '',
          error:
            `${draftId} 那次是討論類產出，沒有可落盤的結構化產物，不能寫成一份產物。` +
            '結論說給作者聽就行；要落盤得先用 capability=generate 生成一份真正的產物。',
        };
      }
      input = { artifact };
      words = draft.words;
    } else {
      input = { text: content! };
      words = countWords(content!);
    }

    const path = kindOfPath(ctx.project, rel);
    const what = describeForReview(path, rel);

    try {
      const r = await ctx.workspace.write(rel, input, {
        // ★ 恆為 true。不接受引數，模型沒有關掉它的口子。
        review: true,
        mode,
        what,
      });

      if (r.skipped) {
        // 不是失敗，是作者的決定。**說清楚**，否則它會原地重試同一個動作。
        return {
          text:
            `作者看過之後沒有採納這次寫入（${what}，${r.rel}），磁碟上那份一字未改。` +
            '不要重試同一個動作——換個做法，或者問問他想怎麼改。',
          display: { title: `write ${r.rel}`, detail: '作者未採納' },
        };
      }

      await clearFailure(ctx, path);
      const side = r.side && r.side.length > 0 ? `\n連帶：${r.side.join('；')}` : '';
      return {
        text: `已寫入 ${r.rel}（${words} 字，${MODE_LABEL[mode]}）${side}`,
        display: { title: `write ${r.rel}`, detail: `${MODE_LABEL[mode]} · ${words} 字` },
      };
    } catch (err) {
      const message = describe(err, rel, mode);
      await noteFailure(ctx, path, `寫入 ${rel} 失敗：${message}`);
      return { text: '', error: message };
    }
  },
};

const MODE_LABEL: Record<WriteMode, string> = {
  create: '新建',
  overwrite: '覆蓋',
  append: '追加',
};

/** draft 上那份結構化產物。討論（唯一的 text 類能力）沒有。 */
function artifactOf(draft: { artifact?: unknown }): Artifact | undefined {
  return draft.artifact as Artifact | undefined;
}

/**
 * 異常 → 一句模型能照著改的話。
 *
 * `WsError` 的 message 本來就是人話，原樣轉述再補一句「那接下來該怎麼辦」——
 * 「已存在」這一條尤其要指路，否則它會換十個檔名繼續試。
 */
function describe(err: unknown, rel: string, mode: WriteMode): string {
  if (err instanceof WsError) {
    switch (err.code) {
      case 'exists':
        return (
          `${err.message}。要替換它就用 mode=overwrite（作者會先看到改動再決定）；` +
          '要接在後面寫用 mode=append。'
        );
      case 'outOfRoot':
        return `${err.message}。只能寫工程目錄之內的相對路徑，不要用絕對路徑或 ../。`;
      case 'protected':
      case 'inTrash':
        return err.message;
      case 'tooLarge':
        return `${err.message} 分幾次寫，或者只改需要改的那一段（用 edit）。`;
      default:
        return err.message;
    }
  }
  return `寫 ${rel} 失敗（${MODE_LABEL[mode]}）：${describeError(err)}`;
}

/**
 * 失敗掛在**細綱**上（工程頁那一行）——與 `generation/generate.ts` 同一套
 * 歸屬規則。不屬於任何一章的產物（大綱、角色卡）只進日誌。
 */
async function noteFailure(ctx: ToolContext, path: PathKind, message: string): Promise<void> {
  const plotRelPath = path.plotRelPath;
  if (!plotRelPath) {
    return;
  }
  await recordFailure(ctx.project, {
    scope: 'MCP',
    targetKind: 'plot',
    targetKey: plotRelPath,
    severity: 'error',
    op: WRITE_OP,
    message,
    detail: '這一次寫入沒有落盤，磁碟上那份未改動。',
  });
}

async function clearFailure(ctx: ToolContext, path: PathKind): Promise<void> {
  if (path.plotRelPath) {
    await clearFailures(ctx.project, 'plot', path.plotRelPath, WRITE_OP);
  }
}
