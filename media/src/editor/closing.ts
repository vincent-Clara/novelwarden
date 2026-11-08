/**
 * 關標籤：有未儲存的修改時問「儲存 / 不儲存 / 取消」（頁內對話方塊，`dialog.ts`）。
 *
 * - 一份：「儲存」（主按鈕）/「不儲存」/「取消」。
 * - 幾份一起關（關閉其它 / 左側 / 右側）而其中好幾份沒儲存：**合成一個對話方塊問一次**，列出是哪幾份——
 *   「全部儲存」/「全部不儲存」/「取消」。沒改過的那幾份不問，跟著一起關。
 * - 「儲存」**等這一份的回執**（`editorSaved`）回來才關；撞上衝突、磁碟上沒了、出錯就**不關**，衝突條留著。
 *   等回執的這段時間裡又改了的也不關（關了那幾筆就沒了）。
 * - 磁碟上已經沒有了的那一份（`OpenFile.gone`）在對話方塊裡註明「儲存會在原路徑重建」：在這裡點了儲存就算答應過，
 *   不再另問。
 *
 * 只經 `Pane` 的公開方法碰編輯區（`files` / `discard`），儲存經 `saving.ts`。
 */
import { askDialog } from './dialog';
import type { OpenFile } from './paneElements';
import { requestSave } from './saving';
import type { Pane } from './store';

/** 同一塊編輯區同一時刻只問一次：連按兩下 Ctrl+W 不疊兩個對話方塊。 */
const asking = new WeakSet<Pane>();

const isDirty = (file: OpenFile): boolean => file.draft !== file.text;

/**
 * 關這幾份（`paths` 裡不在這塊的跳過）。全都關掉了回 true；作者點了取消、或有幾份沒存成留著，回 false。
 */
export async function requestClose(pane: Pane, paths: string[]): Promise<boolean> {
  if (asking.has(pane)) {
    return false;
  }
  const dirty = paths.filter((p) => {
    const file = pane.files.get(p);
    return !!file && isDirty(file);
  });
  if (dirty.length === 0) {
    pane.discard(paths);
    return true;
  }

  asking.add(pane);
  let choice: 'save' | 'discard' | 'cancel';
  try {
    choice = await askDialog(closeDialog(dirty.map((p) => pane.files.get(p)!)));
  } finally {
    asking.delete(pane);
  }
  if (choice === 'cancel') {
    return false;
  }
  if (choice === 'discard') {
    pane.discard(paths);
    return true;
  }

  // 對話方塊開著的時候情況可能變了（核對磁碟把一份換成了新版、另一塊把它搬走了）：按現在的樣子再看一遍。
  const toSave = paths.filter((p) => {
    const file = pane.files.get(p);
    return !!file && isDirty(file);
  });
  const outcomes = await Promise.all(
    toSave.map((p) => requestSave(pane, p, { recreate: !!pane.files.get(p)?.gone }))
  );
  const keep = new Set(
    toSave.filter((p, i) => {
      const file = pane.files.get(p);
      // 沒存成（衝突、磁碟上沒了、出錯、取消），或者等回執的工夫裡又改了：留著。
      return (outcomes[i] !== 'saved' && outcomes[i] !== 'skipped') || (!!file && isDirty(file));
    })
  );
  pane.discard(paths.filter((p) => !keep.has(p)));
  return keep.size === 0;
}

function closeDialog(files: OpenFile[]) {
  const goneNote = '磁碟上已經沒有這個檔案，儲存會在原路徑重新建一份';
  if (files.length === 1) {
    const [file] = files;
    return {
      title: '關閉之前要儲存嗎？',
      message: `「${file.name}」有未儲存的修改。`,
      detail: file.gone ? `${goneNote}。` : undefined,
      buttons: [
        { value: 'cancel' as const, label: '取消' },
        { value: 'discard' as const, label: '不儲存' },
        { value: 'save' as const, label: '儲存', primary: true },
      ],
      cancel: 'cancel' as const,
    };
  }
  return {
    title: '關閉之前要儲存嗎？',
    message: `這 ${files.length} 份有未儲存的修改：`,
    items: files.map((f) => ({ label: f.name, title: f.path, note: f.gone ? `（${goneNote}）` : undefined })),
    buttons: [
      { value: 'cancel' as const, label: '取消' },
      { value: 'discard' as const, label: '全部不儲存' },
      { value: 'save' as const, label: '全部儲存', primary: true },
    ],
    cancel: 'cancel' as const,
  };
}
