import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, PersistedSettings } from './config';

/**
 * 檔案後端的配置與金鑰儲存，雙殼共用（獨立版直接用；VS Code 殼在
 * 遷移完成後切過來）。落點統一在配置目錄（預設 ~/.novelwarden/）。
 */

/**
 * 配置目錄 —— 配置與金鑰的使用者主目錄儲存。
 *
 * 解析順序：`NOVELWARDEN_HOME` > `NOVELFORGE_HOME` > 已存在的 ~/.novelwarden >
 * 已存在的 ~/.novelforge > ~/.novelwarden。改名不能丟舊配置與金鑰：舊目錄還在、
 * 新目錄還沒建時繼續用舊的（作者確認遷移之前不碰它）。
 *
 * 環境變數可以把它挪到別處：Android 殼把家目錄設成放書的公共目錄
 * （新建一本書、開啟資料夾都從家目錄起），金鑰卻不能跟著落到別的 app 也讀得到的地方，就指回 app 私有目錄。
 */
export function homeDir(): string {
  const explicit = process.env.NOVELWARDEN_HOME?.trim() || process.env.NOVELFORGE_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  const fresh = path.join(os.homedir(), '.novelwarden');
  if (fsSync.existsSync(fresh)) {
    return fresh;
  }
  const legacy = path.join(os.homedir(), '.novelforge');
  if (fsSync.existsSync(legacy)) {
    return legacy;
  }
  return fresh;
}

export class FileConfigStore implements ConfigStore {
  readonly filePath = path.join(homeDir(), 'config.json');

  read(): PersistedSettings | undefined {
    // read() 是同步介面（readConfig 到處同步呼叫）；檔案極小，同步讀可接受。
    try {
      return JSON.parse(fsSync.readFileSync(this.filePath, 'utf8')) as PersistedSettings;
    } catch {
      return undefined;
    }
  }

  async write(settings: PersistedSettings): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * 配置目錄下的 secrets.json（舊裝可能是 ~/.novelforge/secrets.json）。JSON 無法寫檔案頭註釋，首次建立時
 * 同目錄放一個 README.txt 說明「不要提交 secrets.json」。
 * Windows 無 POSIX 許可權位，僅依賴使用者主目錄隔離。
 */
export class FileSecretStore implements SecretStore {
  private readonly filePath = path.join(homeDir(), 'secrets.json');

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const readme = path.join(homeDir(), 'README.txt');
    try {
      await fs.stat(readme);
    } catch {
      await fs.writeFile(readme, 'secrets.json 存放各服務商的 API Key，請勿提交到版本庫。\n', 'utf8');
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (!(key in data)) {
      return;
    }
    delete data[key];
    await this.save(data);
  }
}
