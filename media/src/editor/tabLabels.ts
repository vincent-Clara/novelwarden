/**
 * 標籤上的名字（純函式，零 DOM）：型別短標記 + 名字，**仍然同名的再加最短的區分目錄**（像 VS Code 那樣）。
 *
 * 短標記與名字來自後端（`EditorFileView.label`，`views/editorLabel.ts`）——同一章的正文、細綱、草稿
 * 從前三個標籤都寫「003-夜访.md」，現在是「003-夜訪」「細綱 003-夜訪」「草稿 003-夜訪」。還撞名的是
 * 同一種、不同目錄的兩份（兩卷裡各有一個「003-夜訪」）：給每一份找它與其餘幾份**都不一樣**的最短
 * 目錄字尾（從緊挨著檔案的那一級往上加），寫在名字後面淡一點的那一格里。
 *
 * 兩塊編輯區裡開著的檔案放在一起比——「▾」列表裡兩塊的檔案排在一起，各寫各的就分不清了。
 */
import type { EditorFileLabel } from '../protocol';

export interface TabNameSource {
  path: string;
  /** 檔名（後端沒給稱呼時的退路）。 */
  name: string;
  label?: EditorFileLabel;
}

export interface TabName {
  /** 型別短標記，正文不帶（空串）。 */
  tag: string;
  title: string;
  /** 區分用的目錄，不撞名時是空串。 */
  desc: string;
}

/** 每份檔案在標籤上怎麼寫。 */
export function tabNames(files: readonly TabNameSource[]): Map<string, TabName> {
  const out = new Map<string, TabName>();
  const groups = new Map<string, TabNameSource[]>();
  for (const f of files) {
    const tag = f.label?.tag ?? '';
    const title = f.label?.title ?? f.name;
    out.set(f.path, { tag, title, desc: '' });
    const key = `${tag}\u0000${title}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const f of group) {
      out.get(f.path)!.desc = distinguish(f.path, group.filter((g) => g !== f).map((g) => g.path));
    }
  }
  return out;
}

/**
 * `path` 與 `others` 都不一樣的最短目錄字尾。目錄完全一樣（同一個目錄裡 `003-夜访.md` 與 `003-夜访.txt`）
 * 時退到檔名本身——那是唯一的區別。
 */
export function distinguish(path: string, others: readonly string[]): string {
  const dirs = dirsOf(path);
  const otherDirs = others.map(dirsOf);
  const most = Math.max(dirs.length, ...otherDirs.map((d) => d.length));
  for (let k = 1; k <= most; k++) {
    const mine = suffix(dirs, k);
    if (otherDirs.every((d) => suffix(d, k) !== mine)) {
      return dirs.length === 0 ? '工程根' : mine;
    }
  }
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirsOf(path: string): string[] {
  return path.split('/').slice(0, -1);
}

function suffix(dirs: readonly string[], k: number): string {
  return dirs.slice(Math.max(0, dirs.length - k)).join('/');
}
