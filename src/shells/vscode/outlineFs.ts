/**
 * 情節大綱在 VS Code 裡怎麼開啟。磁碟上沒有 `outline.md`——情節大綱是各章細綱「梗概」的彙總
 * （docs/design/plans/2026-10-22-outline-from-plots.md），VS Code 的編輯器卻只認檔案。於是給它一個只有這一份檔案的
 * 虛擬檔案系統（`novelwarden:` scheme），讀寫都經 core 的閘道器：讀就是彙總，存就是按章號拆回各章細綱（守衛、記賬與
 * 獨立版的內建編輯器同一條路，`review: false`——作者手裡那份就是他要存的東西）。
 *
 * 細綱改了（`summaries/` 下的 .md 變了），彙總跟著變：`touch` 通知編輯器重讀（沒改過的標籤直接換新，改過的由 VS Code
 * 自己出「磁碟上的版本更新」那一問）。
 *
 * 這是平臺專屬入口（殼契約第三件）：業務規矩全在 core，這裡只把「一個不是檔案的文件」接到 VS Code 的檔案系統 API 上。
 */
import * as vscode from 'vscode';
import { NovelProject } from '../../core/model/project';
import { Workspace } from '../../core/workspace';

export const OUTLINE_SCHEME = 'novelwarden';

/** 情節大綱在虛擬檔案系統裡的地址：路徑與工程裡那個身份路徑一樣（`.novelwarden/outline.md`）。 */
export function outlineUri(root: string): vscode.Uri {
  const project = NovelProject.open(root);
  return vscode.Uri.from({ scheme: OUTLINE_SCHEME, path: `/${project.relPath(project.outlinePath)}` });
}

/** 這個工程內相對路徑是不是情節大綱（要開在虛擬檔案系統上）。 */
export function isOutlinePath(root: string, relPath: string): boolean {
  return new Workspace(NovelProject.open(root)).isOutline(relPath);
}

export class OutlineFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private mtime = Date.now();

  constructor(private readonly root: string) {}

  /** 細綱變了：彙總文件跟著變。 */
  touch(): void {
    this.mtime = Date.now();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: outlineUri(this.root) }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const text = await this.read(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtime, size: Buffer.byteLength(text, 'utf8') };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(await this.read(uri), 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const rel = this.relOf(uri);
    // 每次一個新的工程例項：細綱列表有快取，這裡不跟對話頁那一份共用，免得讀到舊的。
    await new Workspace(NovelProject.open(this.root)).write(rel, { text: Buffer.from(content).toString('utf8') }, { mode: 'overwrite', review: false });
    this.touch();
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions('情節大綱不是目錄');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('情節大綱不是目錄');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('情節大綱是各章細綱梗概的彙總，刪不掉；要刪某一章，在大綱裡刪掉那一條再儲存');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('情節大綱不能改名');
  }

  private async read(uri: vscode.Uri): Promise<string> {
    return (await new Workspace(NovelProject.open(this.root)).read(this.relOf(uri))).text;
  }

  /** 只認情節大綱那一個地址，別的一律當不存在。 */
  private relOf(uri: vscode.Uri): string {
    const rel = uri.path.replace(/^\/+/, '');
    if (!isOutlinePath(this.root, rel)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return rel;
  }
}
