import { createInterface, Interface } from 'node:readline/promises';
import { ConfigStore } from '../../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../../core/host';
import { CallAnswer } from '../../core/model/callChoice';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';

/**
 * 終端形態的 Host：`novelwarden init` 用它。
 *
 * 為什麼要有這個東西——從前 `main.ts` 的 init 分支自己 readline 問作品名與作者，
 * 那是「初始化工程」這條流程的**第二份實現**（第一份是 core/actions.ts 的
 * `initProjectFlow`，外掛命令與網頁按鈕都走它）。兩份實現意味著以後改了一處忘了
 * 另一處：CLI 裝出來的工程與網頁裝出來的會慢慢不一樣。
 *
 * 有了這個殼，CLI 就只是「第三個宿主」，流程仍然只有一條。副作用是 CLI init
 * 之後也會接著問「要現在新建第 1 章嗎？」——與另外兩處一致，那正是重點。
 *
 * 只實現 `init` 這條路真正會用到的東西：input / confirm / pick 走終端問答，
 * toast 列印，openFile 只報一句路徑（終端裡沒有編輯器可開）。`Host` 上的可選方法
 * 一概不實現——core 會自己回落。
 */
export class TerminalHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;

  /**
   * 整個程序共用一個 readline。
   *
   * **不能每問一句就新建一個再關掉**：關掉之後管道輸入（`printf … | novelwarden init`）
   * 裡剩下的行就讀不到了，第二問直接拿到 EOF，看起來像是程式自己跑完了。
   * 互動式終端下這個毛病看不出來，正是這種問題最難查的地方。
   */
  private rl: Interface | undefined;
  /** stdin 關了（EOF / Ctrl+D）。此後一切問答都按「取消」處理。 */
  private closed = false;
  /**
   * 已經讀到、但還沒有人問的行。
   *
   * 管道輸入是**一次全來**的，而兩問之間還夾著落盤等 await；不排隊的話那幾行
   * 會在沒人接的時候被丟掉，於是「初始化完要不要建第 1 章」這種後面的問題
   * 永遠讀到 EOF。互動式輸入下佇列一直是空的，沒有副作用。
   */
  private buffered: string[] = [];
  /** 正在等一行的那個問題。 */
  private waiting: ((line: string | undefined) => void) | undefined;

  constructor(public readonly config: ConfigStore) {}

  /** 用完請調一次，否則程序會被 readline 的控制代碼拖著不退。 */
  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    // 終端問答裡 title 與 prompt 都是給人看的，拼一行足夠：
    //   初始化小說工程（1/2） · 作品名 [我的小說]：
    const parts = [opts.title, opts.prompt].filter(Boolean).join(' · ');
    const label = `${parts}${opts.value ? ` [${opts.value}]` : ''}：`;
    for (;;) {
      const answer = await this.ask(label);
      if (answer === undefined) {
        return undefined; // EOF：當作取消，別在校驗失敗裡死迴圈
      }
      // 直接回車 = 採用預設值，與圖形介面裡預填好文字框的行為一致。
      const value = answer === '' && opts.value !== undefined ? opts.value : answer;
      const err = opts.validate?.(value);
      if (!err) {
        return value;
      }
      console.log(`  ${err}`);
    }
  }

  /** 一個動作問 y/N；幾個動作時編號選一個，回車取消。 */
  async confirm(message: string, actions: string[]): Promise<string | undefined> {
    if (actions.length > 1) {
      return this.pick(
        actions.map((a) => ({ label: a, value: a })),
        message
      );
    }
    const yes = actions[0] ?? '確定';
    const answer = (await this.ask(`${message}（${yes}? y/N）：`))?.toLowerCase();
    return answer === 'y' || answer === 'yes' ? yes : undefined;
  }

  /** 命令列不問模型與詳細度：這一次照設定來。 */
  async confirmCall(message: string, actions: string[]): Promise<CallAnswer | undefined> {
    const action = await this.confirm(message, actions);
    return action === undefined ? undefined : { action, choice: {} };
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    if (choices.length === 0) {
      return undefined;
    }
    console.log(title);
    choices.forEach((c, i) => {
      const desc = c.description ? `（${c.description}）` : '';
      console.log(`  ${i + 1}. ${c.label}${desc}`);
    });
    const answer = await this.ask(`選一項（1-${choices.length}，回車取消）：`);
    const index = Number(answer) - 1;
    return Number.isInteger(index) && index >= 0 && index < choices.length
      ? choices[index].value
      : undefined;
  }

  /** 終端裡沒有進度條可畫：直接跑，把每條進度打出來。 */
  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    console.log(title);
    return fn(new AbortController().signal, (message) => console.log(`  ${message}`));
  }

  /** CLI 是一次性的，沒有介面要重新整理。 */
  watch(_project: NovelProject, _onChange: () => void): Disposable {
    return { dispose: () => undefined };
  }

  /** 終端裡開不了編輯器，報一句路徑就夠。 */
  async openFile(relPath: string): Promise<void> {
    console.log(`檔案：${relPath}`);
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    console[level === 'error' ? 'error' : 'log'](message);
  }

  /** 終端裡沒有選區可取，也沒有貼上框可彈。 */
  async selectionAttachment(_project: NovelProject): Promise<Attachment | undefined> {
    return undefined;
  }

  /** 問一句。返回 undefined 表示 stdin 已經關了（EOF），呼叫方按取消處理。 */
  private async ask(label: string): Promise<string | undefined> {
    if (this.closed && this.buffered.length === 0) {
      return undefined;
    }
    process.stdout.write(label);
    const line = this.buffered.length > 0 ? this.buffered.shift() : await this.nextLine();
    return line?.trim();
  }

  /**
   * 等下一行。
   *
   * 不用 `rl.question()`：它在 EOF 時永不 resolve（readline 直接 close），
   * 整個程序會靜悄悄地退出，看起來就像「問了一半自己跑完了」。自己聽 line/close
   * 兩個事件，順便把沒人接的行排進佇列。
   */
  private nextLine(): Promise<string | undefined> {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('line', (line) => {
        const waiter = this.waiting;
        this.waiting = undefined;
        if (waiter) {
          waiter(line);
        } else {
          this.buffered.push(line);
        }
      });
      this.rl.on('close', () => {
        this.closed = true;
        const waiter = this.waiting;
        this.waiting = undefined;
        waiter?.(undefined);
      });
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
