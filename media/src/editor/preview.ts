/**
 * 夠用的 Markdown 塊級渲染：標題、引用、列表、程式碼塊、分隔線、frontmatter，
 * 行內支援 `**粗**` `*斜*` `` `碼` `` `[文字](連結)`。怎麼切塊在零 DOM 的 `previewCore.ts`（`previewBlocks`）。
 *
 * 全部走 createElement + textContent，**不拼 HTML 字串**——正文裡出現
 * `<script>` 也只是普通文字。這不是要做一個完整的 Markdown 實現，只是讓
 * 作者能預覽自己寫的東西；缺的語法原樣顯示即可，不該為此引一個解析庫。
 *
 * **每一塊記著它是原始檔的哪幾行**：`data-line`（第一行，從 0 數）與 `data-line-end`（最後一行的下一行），
 * 掛在 frontmatter、標題、段落、程式碼塊、分隔線、引用與每一個列表項上（不掛在 `<ul>` / `<ol>` 上，各塊互不重疊）。
 * 切預覽 / 切回編輯時按它兩邊滾到同一處（`previewSync.ts`）。
 */
import { el } from '../dom';
import { previewBlocks } from './previewCore';

/** 工程內的相對連結點開時的回呼（在哪一塊預覽裡點的，就開在哪一塊）。 */
export type OpenLink = (path: string) => void;

/** 給一塊記上它是第幾行到第幾行。 */
function mark<T extends HTMLElement>(node: T, span: { start: number; end: number }): T {
  node.dataset.line = String(span.start);
  node.dataset.lineEnd = String(span.end);
  return node;
}

export function renderPreview(
  target: HTMLElement,
  text: string,
  fromPath: string,
  openLink: OpenLink
): void {
  target.innerHTML = '';
  for (const block of previewBlocks(text)) {
    switch (block.kind) {
      case 'frontmatter':
        // frontmatter 是後設資料，單獨框起來，不混進正文。
        target.appendChild(mark(el('div', 'ed-frontmatter', block.text), block));
        break;
      case 'heading': {
        const h = document.createElement(`h${block.level}`);
        appendInline(h, block.text, fromPath, openLink);
        target.appendChild(mark(h, block));
        break;
      }
      case 'paragraph': {
        const p = el('p');
        appendInline(p, block.text, fromPath, openLink);
        target.appendChild(mark(p, block));
        break;
      }
      case 'code':
        target.appendChild(mark(el('pre', undefined, block.text), block));
        break;
      case 'hr':
        target.appendChild(mark(el('hr'), block));
        break;
      case 'quote': {
        const quote = el('blockquote');
        appendInline(quote, block.text, fromPath, openLink);
        target.appendChild(mark(quote, block));
        break;
      }
      case 'list': {
        const list = el(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const li = el('li');
          appendInline(li, item.text, fromPath, openLink);
          list.appendChild(mark(li, item));
        }
        target.appendChild(list);
        break;
      }
    }
  }
}

/** 行內：`**粗**`、`*斜*`、`` `碼` ``、`[文字](連結)`。其餘原樣。 */
function appendInline(
  parent: HTMLElement,
  text: string,
  fromPath: string,
  openLink: OpenLink
): void {
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const token = m[0];
    if (token.startsWith('**')) {
      parent.appendChild(el('strong', undefined, token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      parent.appendChild(el('code', undefined, token.slice(1, -1)));
    } else if (token.startsWith('[')) {
      parent.appendChild(linkNode(token, fromPath, openLink));
    } else {
      parent.appendChild(el('em', undefined, token.slice(1, -1)));
    }
    last = m.index + token.length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

/**
 * `[文字](連結)`。外鏈開瀏覽器，工程內的相對連結點開就是另一個標籤頁——
 * 角色卡裡互相引用得很密，跳瀏覽器毫無用處。
 */
function linkNode(token: string, fromPath: string, openLink: OpenLink): HTMLElement {
  const split = token.indexOf('](');
  const label = token.slice(1, split);
  const href = token.slice(split + 2, -1);

  if (/^https?:\/\//i.test(href)) {
    const a = el('a', undefined, label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    return a;
  }
  const btn = el('button', 'link', label);
  btn.addEventListener('click', () => openLink(resolveRelative(fromPath, href)));
  return btn;
}

/** `.novelwarden/characters/a.md` + `../lore/b.md` → `.novelwarden/lore/b.md` */
export function resolveRelative(fromPath: string, href: string): string {
  const target = decodeURI(href.split('#')[0]);
  if (!fromPath || target.startsWith('/')) {
    return target.replace(/^\//, '');
  }
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
