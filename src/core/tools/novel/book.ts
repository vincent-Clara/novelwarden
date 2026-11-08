/**
 * `book` —— 拆書：匯入原稿、從已寫正文補齊、從參考書學寫法。
 *
 * 都是工程頁那幾顆按鈕背後的同一個函式。`import` 會新建章節檔案——建的是作者自己那本 txt 裡的章，
 * 切分結果先在確認框裡給作者看，同名一律不覆蓋。要 `path` 的兩個只認工程裡的 txt
 * （`features/bookText.ts` 的那張清單），不認章節檔案、隱藏目錄與工程外的路徑。
 */
import { str } from '../schema';
import { countedBy, defineActionTool } from './actions';
import { importManuscript } from '../../features/importManuscript';
import { deriveFromText } from '../../features/derive';
import { learnFromReference } from '../../features/reference';

const TXT = ['path'];

export const bookTool = defineActionTool({
  name: 'book',
  summary:
    '拆書：作者有寫好的稿子要接上來，或想學別人的書怎麼寫。txt 要先放在工程裡。' +
    '典型順序：import 匯入原稿 → derive 從已寫正文補齊細綱、角色卡、架構與大綱。',

  params: {
    path: str('工程裡那本 txt 的相對路徑。'),
  },

  actions: {
    import: {
      label: '匯入原稿：把一本 txt 按章標題切成章節，接在已有章節之後（切分結果先給作者看；匯入本身不調模型，匯入完作者可以選擇接著補齊）',
      costly: true,
      uses: TXT,
      requires: TXT,
      async run(ctx, args) {
        const r = await importManuscript(ctx.project, { path: String(args.path).trim() });
        if (r.imported === 0) {
          return {
            text: '這一次沒有匯入：要麼作者取消了，要麼認不出章節標題（每章開頭要有單獨一行「第一章 xxx」）。不要重試同一個動作——先問作者。',
            calls: 0,
          };
        }
        return {
          text:
            `已匯入 ${r.imported} 章。` +
            (r.calls > 0 ? `作者接著從已寫正文補齊了，呼叫模型 ${r.calls} 次，結果見工程頁。` : '作者沒有接著補齊；需要時用 derive。'),
          calls: r.calls,
        };
      },
    },
    derive: {
      label: '從已寫正文補齊：照第 1 章起連續寫成的正文，補上缺的細綱（梗概就是情節大綱那一條）、角色卡、架構幾件、設定條目與全文大綱（只補空白，已有的不動；動手前報呼叫次數）',
      costly: true,
      async run(ctx) {
        return countedBy(await deriveFromText(ctx.project), '從已寫正文補齊', '那幾樣都已經有了，或者還沒有正文');
      },
    },
    learn: {
      label: '從一本參考書學寫法：文風寫進 style.md，結構與節奏寫成一份「規劃」階段的寫作技能（只學怎麼寫，不復述原書的情節與人名，原文不進工程）',
      costly: true,
      uses: TXT,
      requires: TXT,
      async run(ctx, args) {
        const r = await learnFromReference(ctx.project, { path: String(args.path).trim() });
        const made = [
          r.style ? `文風寫進了 ${r.style}` : '',
          r.skill ? `寫法寫成了技能 ${r.skill.id}${r.skill.bound ? '，已綁到規劃階段' : '，沒有綁'}` : '',
        ]
          .filter(Boolean)
          .join('；');
        return made
          ? { text: `${made}。`, calls: r.calls }
          : { text: '這一次什麼都沒寫：要麼作者取消了，要麼沒學成（見工程頁提示）。不要重試同一個動作——先問作者。', calls: r.calls };
      },
    },
  },
});
