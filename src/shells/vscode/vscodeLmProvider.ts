import * as vscode from 'vscode';
import {
  ChatMessage,
  CancelledError,
  LlmError,
  LlmProvider,
  StreamEvent,
  StreamOptions,
  makeAbortSignal,
  normalizeError,
} from '../../core/llm/provider';

/**
 * 基於 VS Code Language Model API（複用 Copilot 訂閱）。
 *
 * 兩點與自建 API 不同：
 * 1. 沒有獨立的 system 角色，系統提示會併入首條 user 訊息；
 * 2. 有硬性的 maxInputTokens 配額，裝配器需要據此收緊預算。
 */
export class VsCodeLmProvider implements LlmProvider {
  readonly id = 'vscode-lm' as const;

  private model: vscode.LanguageModelChat | undefined;

  /**
   * @param family 模型 family，如 `gpt-4o`、`claude-3.5-sonnet`。
   * @param providerName 服務商顯示名，用於錯誤提示裡指名道姓。
   */
  constructor(
    private readonly family: string,
    private readonly providerName = 'VS Code LM'
  ) {}

  get label(): string {
    return `${this.model?.name ?? this.family}（${this.providerName}）`;
  }

  private async resolveModel(): Promise<vscode.LanguageModelChat> {
    if (this.model) {
      return this.model;
    }
    let models = await vscode.lm.selectChatModels({ family: this.family });
    if (models.length === 0) {
      // family 填錯或該模型不可用時，退而選任意可用模型，避免直接卡死。
      models = await vscode.lm.selectChatModels();
      if (models.length === 0) {
        throw new LlmError(
          '沒有可用的 VS Code 語言模型。請確認已安裝並登入 GitHub Copilot，或在設定頁改用自建 API 的服務商。'
        );
      }
      void vscode.window.showWarningMessage(
        `Novelwarden：找不到模型 family「${this.family}」，已改用「${models[0].family}」。`
      );
    }
    this.model = models[0];
    return this.model;
  }

  async maxInputTokens(): Promise<number | undefined> {
    try {
      return (await this.resolveModel()).maxInputTokens;
    } catch {
      return undefined;
    }
  }

  /**
   * `options.thinking` 在這裡**沒有落點**：VS Code 語言模型 API 不暴露思考深度
   * （請求體由 Copilot 那側拼），所以對話頁選的那一檔對這種服務商無效。不報錯
   * 也不警告——作者選一個 Copilot 模型時要的就是「用訂閱額度」，為一個這條路上
   * 壓根不存在的旋鈕彈提示只是噪聲。
   */
  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const model = await this.resolveModel();
    const { signal, dispose, poke } = makeAbortSignal(options);
    const source = new vscode.CancellationTokenSource();
    // core 側已統一為 AbortSignal，這裡橋接回語言模型 API 需要的 token。
    const onAbort = () => source.cancel();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await model.sendRequest(
        toLmMessages(messages),
        {
          justification: 'Novelwarden 需要呼叫語言模型續寫小說正文。',
        },
        source.token
      );
      poke();

      for await (const part of response.stream) {
        poke();
        if (part instanceof vscode.LanguageModelTextPart) {
          yield { type: 'text', text: part.value };
        }
      }
    } catch (err) {
      if (signal.aborted) {
        throw normalizeError(err, signal, this.label);
      }
      if (err instanceof vscode.CancellationError || source.token.isCancellationRequested) {
        throw new CancelledError();
      }
      if (err instanceof vscode.LanguageModelError) {
        throw new LlmError(translateLmError(err));
      }
      throw new LlmError(`VS Code 語言模型請求失敗：${err instanceof Error ? err.message : String(err)}`, err);
    } finally {
      dispose();
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    }
  }
}

/**
 * `ChatMessage[]` → VS Code 的訊息陣列。
 *
 * **系統提示並進首條 user** 是這個 provider 的特點而不是缺陷：LM API 根本
 * 沒有 system 角色，不並進去這段提示就丟了。
 */
function toLmMessages(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const out: vscode.LanguageModelChatMessage[] = [];

  let systemMerged = !systemText;
  for (const m of rest) {
    if (m.role === 'assistant') {
      out.push(vscode.LanguageModelChatMessage.Assistant(m.content));
      continue;
    }
    if (!systemMerged) {
      out.push(vscode.LanguageModelChatMessage.User(`${systemText}\n\n---\n\n${m.content}`));
      systemMerged = true;
    } else {
      out.push(vscode.LanguageModelChatMessage.User(m.content));
    }
  }
  if (!systemMerged) {
    out.push(vscode.LanguageModelChatMessage.User(systemText));
  }
  return out;
}

function translateLmError(err: vscode.LanguageModelError): string {
  switch (err.code) {
    case vscode.LanguageModelError.NoPermissions.name:
      return '未獲得使用該語言模型的授權，請在彈出的確認框中允許 Novelwarden 使用 Copilot 模型。';
    case vscode.LanguageModelError.Blocked.name:
      return '請求被模型的內容策略攔截。可嘗試調整綱要措辭，或在設定頁切換到自建 API 的模型。';
    case vscode.LanguageModelError.NotFound.name:
      return '找不到指定的語言模型，請在設定頁檢查該服務商下配置的模型 family。';
    default:
      return `VS Code 語言模型錯誤：${err.message}`;
  }
}
