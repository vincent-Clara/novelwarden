/**
 * 寫作技能（Skill）的純函式部分：`SKILL.md` 怎麼讀、什麼樣的算相容、繫結檔案長什麼樣、
 * 一次裝配算哪個階段。**零 I/O、零執行時 import**（前端要直接用這裡的常量，見 protocol/index.ts）。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0）：解析與相容檢查逐條照搬 `src/shared/writing-skills.ts`
 * （`inspectWritingSkillMarkdown` / `parseGitHubWritingSkillUrl`），繫結檔案的形狀照搬
 * `src/services/agent/writing-skill-bindings.ts`，注入時那句話照搬 `base-command.ts:48-81`。
 * 上游的設計說明是它的 ADR 0015「寫作 Skill 是按階段凍結的補充指導」。
 *
 * ## 一份技能是什麼
 *
 * **常規的技能目錄**：一份 `SKILL.md`（YAML frontmatter + 正文），旁邊可以帶它引用的文字檔案
 * （`references/*.md` 這類，叫「附帶檔案」）。frontmatter 只讀頂層的 `name` / `display_name` /
 * `description` / `version` / `stage`，別的鍵（`allowed-tools`、`metadata`……）讀得過去、不礙事。
 *
 * **只收純提示詞**：要跑指令碼、裝 hook、派子代理、調工具的一律判「不相容」——裝不進來，也綁不上。
 * 它們在這裡沒有可執行的地方，裝進來只會讓模型以為自己能做一件做不了的事。附帶檔案不一樣：
 * 這裡的生成是一次呼叫、模型沒有讀檔案的工具，所以引用到的整份接在正文後面一起帶；引用了卻
 * 帶不上的（找不到、在技能目錄外、不是文字）才判「包含相對引用」。
 *
 * ## 與上游不同的幾處
 *
 * - **名字可以是中文**。上游只認 `[A-Za-z0-9._-]`，這裡放寬到任意字母數字（`\p{L}\p{N}`）：
 *   作者給自己寫的方法起「去AI味」這種名字再自然不過。
 * - **使用者與工程技能的身份是目錄名**（上游取 frontmatter 的 `name`、目錄名只是回落）。
 *   一份手放進來的技能 frontmatter 寫的名字與目錄不一樣時，上游按 frontmatter 認、按它去刪，
 *   結果刪了個空；這裡只有一個名字，`display_name` 與 `name` 只用來顯示。
 * - **沒有中英雙語**：Novelwarden 只寫中文，`language` 欄位不讀。
 * - **認常規技能格式**（2026-10-21）：上游一行一個鍵地讀 frontmatter、引用旁邊的檔案就判不相容、
 *   宣告瞭 `allowed-tools` 就判依賴工具。這裡 frontmatter 按 YAML 讀頂層鍵，附帶檔案一起帶，
 *   `allowed-tools` 不算——上游原樣的技能目錄放進來就能用。見
 *   docs/design/plans/2026-10-21-skill-dirs.md。
 */
import type { CreationAction, WriteMode } from './pipeline';

// ---------------------------------------------------------------- 階段與來源

/**
 * 四個階段，照搬上游。一個工程每個階段最多綁一份。
 *
 * 與 Novelwarden 的創作階段對得上（{@link skillStageOf}）：規劃 = 架構 / 大綱 / 細綱三層的
 * 生成與沉澱，寫正文 = 寫、接著寫、重寫與它們的續寫，審稿與修稿各是正文層的一張配方。
 */
export const SKILL_STAGES = ['planning', 'drafting', 'review', 'refinement'] as const;
export type SkillStage = (typeof SKILL_STAGES)[number];

export const SKILL_STAGE_LABEL: Record<SkillStage, string> = {
  planning: '規劃（架構 / 大綱 / 細綱）',
  drafting: '寫正文',
  review: '審稿',
  refinement: '修稿',
};

export function isSkillStage(value: unknown): value is SkillStage {
  return typeof value === 'string' && (SKILL_STAGES as readonly string[]).includes(value);
}

/** 內建的隨應用釋出；我的技能庫在 `~/.novelwarden/skills/`；本工程的在 `.novelwarden/skills/`。 */
export type SkillSource = 'builtin' | 'user' | 'project';

export const SKILL_SOURCES: readonly SkillSource[] = ['builtin', 'user', 'project'];

export const SKILL_SOURCE_LABEL: Record<SkillSource, string> = {
  builtin: '內建',
  user: '我的技能庫',
  project: '本工程',
};

// ---------------------------------------------------------------- 相容檢查

export type SkillIncompat =
  | 'relative-reference'
  | 'script-dependency'
  | 'hook-dependency'
  | 'subagent-dependency'
  | 'tool-dependency'
  | 'content-too-large';

/** 說法照搬上游設定頁的 `REASON_COPY`。 */
export const SKILL_INCOMPAT_LABEL: Record<SkillIncompat, string> = {
  'relative-reference': '包含相對引用',
  'script-dependency': '依賴指令碼',
  'hook-dependency': '依賴 hook',
  'subagent-dependency': '依賴子代理',
  'tool-dependency': '依賴工具呼叫',
  'content-too-large': '內容超過 64 KiB',
};

/**
 * 一份技能注入的上限：`SKILL.md` 整份（含 frontmatter）加上它帶的附帶檔案，合起來，與上游
 * 的 64 KiB 同一個數。下載時也按它拒。
 */
export const MAX_SKILL_BYTES = 64 * 1024;

/** 一份技能最多帶幾份附帶檔案。 */
export const MAX_SKILL_ATTACHMENTS = 32;

/**
 * 附帶檔案：技能目錄裡被 `SKILL.md`（或被別的附帶檔案）引用到的文字檔案，比如常規技能的
 * `references/*.md`。這裡的生成是一次呼叫、模型沒有讀檔案的工具，沒法「按需去讀」，所以
 * 引用到的整份接在正文後面一起帶；沒被引用的（README、CHANGELOG、LICENSE）不帶。
 */
export interface SkillAttachment {
  /** 技能目錄裡的相對路徑，`/` 分隔。 */
  path: string;
  text: string;
}

export interface SkillInspection {
  /** frontmatter 的 `name`；沒寫時是呼叫方給的回落名（目錄名），再沒有就是 `unnamed-writing-skill`。 */
  name: string;
  displayName?: string;
  description: string;
  version?: string;
  /** frontmatter 裡寫明的階段。 */
  stage?: SkillStage;
  /** 寫明瞭就是它，沒寫按名字、描述與正文開頭猜一個（只是建議，任何階段都能綁）。 */
  suggestedStage: SkillStage;
  compatible: boolean;
  reasons: SkillIncompat[];
  /** 正文（frontmatter 之後，去掉首尾空白）。 */
  body: string;
  /** 引用到、一起帶的附帶檔案，按引用的先後。 */
  attachments: SkillAttachment[];
  /** 明確引用了、卻帶不上的檔案（找不到、在技能目錄外、不是文字），就是「包含相對引用」的那幾處。 */
  unresolved: string[];
  /** 注入的位元組數：正文加附帶檔案（UTF-8）。上限按整份 `SKILL.md` 加附帶檔案算，見 {@link MAX_SKILL_BYTES}。 */
  bytes: number;
}

/** 介面與提示詞裡叫它什麼：`display_name` → `name`。 */
export function skillLabel(s: Pick<SkillInspection, 'name' | 'displayName'>): string {
  return s.displayName?.trim() || s.name;
}

// ---------------------------------------------------------------- frontmatter（YAML 的一個子集）

/**
 * 常規技能的 frontmatter 是 YAML：列表（`allowed-tools:\n  - Read`）、巢狀塊（`metadata:` 下面
 * 縮排的幾行）、多行的 `description: |`。專案不引入 yaml 依賴，這裡只讀**頂層的鍵**：
 *
 * - 頂層 `鍵: 值`，值可以加單引號 / 雙引號（雙引號認常見轉義），行尾 ` # 註釋` 去掉；
 *   不加引號的值可以折到下面縮排的幾行（YAML 的多行純量）。
 * - `|` / `>` 塊標量（帶 `-` / `+`），縮排的那幾行是它的內容。
 * - 值為空的鍵下面縮排的幾行（列表、巢狀對映）**整塊歸它，不展開**——從前一行一個鍵的讀法會把
 *   `metadata:` 下面的 `name:` / `version:` 拍平到頂層、蓋掉真的那個。
 * - 列表（`[a, b]` 或 `- a`）只記有這個鍵，值不讀：這裡用不到。
 *
 * 鍵一律轉小寫。BOM、CRLF、`---` 後面的空白都認。**絕不拋**：讀不懂的行跳過。
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; keys: string[]; content: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = text.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
  if (!match) {
    return { fields: {}, keys: [], content: text.trim() };
  }
  const fields: Record<string, string> = {};
  const lines = (match[1] ?? '').split('\n');
  const indented = (line: string): boolean => /^[ \t]/.test(line) || line.trim() === '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    const kv = line.match(/^([^\s#:'"\-[{][^:]*?)[ \t]*:[ \t]*(.*?)[ \t]*$/);
    if (!kv) {
      // 空行、註釋、頂層的 `- 列表項`、上一個鍵的縮排內容（列表、巢狀對映）：都不是一個新的頂層鍵。
      continue;
    }
    const key = kv[1].trim().toLowerCase();
    const value = kv[2];
    // 這個鍵下面縮排的那幾行（空行夾在中間也算）。末尾的空行不算它的。
    let end = i;
    while (end < lines.length && indented(lines[end])) {
      end++;
    }
    while (end > i && lines[end - 1].trim() === '') {
      end--;
    }
    const block = lines.slice(i, end);
    i = end;

    const blockScalar = value.match(/^([|>])([+-]?)\d?([+-]?)(?:[ \t]+#.*)?$/);
    if (blockScalar) {
      fields[key] = blockScalarValue(block, blockScalar[1] === '>', blockScalar[2] || blockScalar[3]);
    } else if (value === '') {
      fields[key] = '';
    } else if (value.startsWith('"') || value.startsWith("'")) {
      fields[key] = quotedValue([value, ...block.map((l) => l.trim())].join(' '));
    } else {
      fields[key] = [value, ...block.map((l) => l.trim())]
        .filter((l) => l !== '')
        .join(' ')
        .replace(/[ \t]+#.*$/, '');
    }
  }
  return { fields, keys: Object.keys(fields), content: text.slice(match[0].length).trim() };
}

function blockScalarValue(block: string[], folded: boolean, chomp: string): string {
  const indent = Math.min(
    ...block.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
    Number.MAX_SAFE_INTEGER
  );
  const lines = block.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
  let out = folded
    ? lines.reduce((acc, l, k) => (k === 0 ? l : l === '' || lines[k - 1] === '' ? `${acc}\n${l}` : `${acc} ${l}`), '')
    : lines.join('\n');
  out = chomp === '+' ? `${out}\n` : chomp === '-' ? out.replace(/\n+$/, '') : `${out.replace(/\n+$/, '')}\n`;
  return out.trim();
}

/** 引號裡的值：雙引號認 `\"` `\\` `\n` `\t` `\uXXXX`，單引號認 `''`。引號外的 ` # 註釋` 去掉。 */
function quotedValue(value: string): string {
  const quote = value[0];
  let out = '';
  for (let k = 1; k < value.length; k++) {
    const ch = value[k];
    if (quote === "'" && ch === "'") {
      if (value[k + 1] === "'") {
        out += "'";
        k++;
        continue;
      }
      return out;
    }
    if (quote === '"' && ch === '"') {
      return out;
    }
    if (quote === '"' && ch === '\\' && k + 1 < value.length) {
      const next = value[++k];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(k + 1, k + 5))) {
        out += String.fromCharCode(parseInt(value.slice(k + 1, k + 5), 16));
        k += 4;
      } else {
        out += ({ n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[next] ?? next;
      }
      continue;
    }
    out += ch;
  }
  // 沒有收尾的引號：照原樣（去掉開頭那個）。
  return out;
}

function normalizedStage(value: string | undefined): SkillStage | undefined {
  return SKILL_STAGES.find((stage) => stage === value?.trim().toLowerCase());
}

function suggestStage(fields: Record<string, string>, content: string): SkillStage {
  const explicit = normalizedStage(fields.stage);
  if (explicit) {
    return explicit;
  }
  const searchable = `${fields.name ?? ''} ${fields.description ?? ''} ${content.slice(0, 1000)}`.toLowerCase();
  if (/review|critique|(?:审|審)稿|(?:审|審)(?:阅|閱)|(?:检|檢)查/.test(searchable)) return 'review';
  if (/refin|polish|prose|(?:润|潤)色|修稿|改(?:写|寫)/.test(searchable)) return 'refinement';
  if (/plan|outline|architect|(?:规|規)(?:划|劃)|大(?:纲|綱)|(?:设|設)定/.test(searchable)) return 'planning';
  return 'drafting';
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ---------------------------------------------------------------- 附帶檔案

/** 能當附帶檔案帶的：文字。圖片這類帶不進提示詞。 */
const TEXT_FILE = /\.(?:md|markdown|txt)$/i;

export interface SkillReference {
  /** 規範成技能根下的相對路徑（`/` 分隔）；越出技能目錄的是 undefined。 */
  path?: string;
  /** 原文裡寫的那個目標。 */
  target: string;
  /**
   * 明確指向旁邊檔案的寫法（`./`、`../`、`references/`、`assets/`）：帶不上就不相容。
   * 普通的 `[示例](a.md)` 找不到只是不帶，與從前一樣。
   */
  strong: boolean;
  /** 是文字、能帶進提示詞。 */
  text: boolean;
}

function joinSkillPath(fromPath: string, target: string): string | undefined {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

/**
 * 一份 Markdown 裡引用了技能目錄裡的哪些檔案：Markdown 連結的目標（不含網址、錨點、絕對路徑），
 * 加上正文裡裸寫的 `references/…`、`assets/…`。`fromPath` 是這份檔案自己的相對路徑，引用按它
 * 所在的目錄解析。去重，按出現的先後。
 */
export function skillReferences(markdown: string, fromPath = 'SKILL.md'): SkillReference[] {
  const found: SkillReference[] = [];
  const seen = new Set<string>();
  const add = (rawTarget: string, bare: boolean): void => {
    let target = rawTarget.trim().replace(/^<|>$/g, '').replace(/[#?].*$/, '');
    try {
      target = decodeURI(target);
    } catch {
      // 解不開就按原樣。
    }
    target = target.replace(/\\/g, '/');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || seen.has(target)) {
      return;
    }
    seen.add(target);
    const strong = bare || /^\.\.?\//.test(target) || /^(?:references?|assets?)\//i.test(target);
    found.push({ path: joinSkillPath(fromPath, target), target, strong, text: TEXT_FILE.test(target) });
  };
  // 兩種寫法各找一遍，再按在原文裡出現的先後排：說「帶不上哪幾個」時順著原文說。
  const hits: { at: number; target: string; bare: boolean }[] = [];
  for (const m of markdown.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g)) {
    hits.push({ at: m.index, target: m[1], bare: false });
  }
  for (const m of markdown.matchAll(
    /(?:^|[\s`'"(（「《：:、，])((?:\.\.?\/)*(?:references?|assets?)\/[^\s`'"()（）「」《》[\]，。、；：！？]+)/gim
  )) {
    hits.push({ at: m.index, target: m[1].replace(/[.,;:!?]+$/, ''), bare: true });
  }
  hits.sort((x, y) => x.at - y.at);
  for (const hit of hits) {
    add(hit.target, hit.bare);
  }
  return found;
}

/**
 * 從 `SKILL.md` 正文出發、按引用一層層找附帶檔案（附帶檔案裡再引用的也算）。只在給的 `files` 裡找：
 * 讀盤與下載由呼叫方按 {@link skillReferences} 先做，這裡零 I/O。
 */
function resolveAttachments(
  body: string,
  files: Readonly<Record<string, string>>
): { attachments: SkillAttachment[]; unresolved: string[]; tooMany: boolean } {
  const attachments: SkillAttachment[] = [];
  const unresolved: string[] = [];
  const taken = new Set<string>(['SKILL.md']);
  const queue: SkillReference[] = skillReferences(body);
  let tooMany = false;
  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (ref.path && taken.has(ref.path)) {
      continue;
    }
    const text = ref.path && ref.text ? files[ref.path] : undefined;
    if (text === undefined) {
      if (ref.strong && !unresolved.includes(ref.path ?? ref.target)) {
        unresolved.push(ref.path ?? ref.target);
      }
      continue;
    }
    if (attachments.length >= MAX_SKILL_ATTACHMENTS) {
      tooMany = true;
      break;
    }
    taken.add(ref.path!);
    attachments.push({ path: ref.path!, text });
    queue.push(...skillReferences(text, ref.path));
  }
  return { attachments, unresolved, tooMany };
}

// ---------------------------------------------------------------- 相容檢查

/**
 * 讀一份技能。**絕不拋**：讀不懂的 frontmatter 當成沒有，正文就是整份檔案。
 *
 * 相容規則照搬上游（`writing-skills.ts:110-125`），命中任何一條就不相容，有兩處放寬（常規技能
 * 格式）：
 * - 引用旁邊的檔案：帶得上（`files` 裡有、是文字、在技能目錄裡）就當附帶檔案一起帶，帶不上的
 *   才算「包含相對引用」。
 * - frontmatter 裡的 `allowed-tools` / `tools` 不算依賴工具呼叫：那是給 Claude Code 一類 agent
 *   預先放行的許可權，不是這份技能要調的東西；`metadata` 這類塊也不看。宣告瞭 `hooks` / `mcp` /
 *   `scripts` / `sub-agents` 的照舊不相容，正文與附帶檔案裡要調工具、跑指令碼、派子代理的也照舊。
 *
 * @param fallbackName 使用者與工程技能傳目錄名：frontmatter 沒寫 `name` 時用它。
 * @param files 技能目錄裡讀到的檔案（相對路徑 → 文字），附帶檔案從這裡取。不給就是隻有一份 `SKILL.md`。
 */
export function inspectSkillMarkdown(
  raw: string,
  fallbackName?: string,
  files: Readonly<Record<string, string>> = {}
): SkillInspection {
  const text = typeof raw === 'string' ? raw : '';
  const { fields, keys, content } = parseFrontmatter(text);
  const name = fields.name?.trim() || fallbackName?.trim() || 'unnamed-writing-skill';
  const reasons = new Set<SkillIncompat>();
  const { attachments, unresolved, tooMany } = resolveAttachments(content, files);
  // 內容類的規則在正文與每一份附帶檔案上各查一遍：它們一樣會進提示詞。
  const texts = [content, ...attachments.map((a) => a.text)];
  const anyText = (pattern: RegExp): boolean => texts.some((t) => pattern.test(t));
  const bytes = utf8Bytes(content) + attachments.reduce((sum, a) => sum + utf8Bytes(a.text), 0);

  if (tooMany || utf8Bytes(text) + attachments.reduce((sum, a) => sum + utf8Bytes(a.text), 0) > MAX_SKILL_BYTES) {
    reasons.add('content-too-large');
  }
  if (unresolved.length > 0 || anyText(/\$\{skill_dir\}/i)) {
    reasons.add('relative-reference');
  }
  if (
    anyText(/(?:^|[\s`'"(])scripts?[/\\][^\s`'")]+/im) ||
    anyText(/\b(?:run|execute)\s+(?:the\s+)?script\b/i) ||
    anyText(/(?:运行|運行|執行).{0,12}(?:脚本|腳本|指令碼)/)
  ) {
    reasons.add('script-dependency');
  }
  if (
    anyText(/(?:^|[\s`'"(])hooks?[/\\][^\s`'")]+/im) ||
    anyText(/\b(?:install|run|execute)\s+(?:the\s+)?hook\b/i) ||
    anyText(/安(?:装|裝).{0,12}(?:钩|鉤)子/)
  ) {
    reasons.add('hook-dependency');
  }
  if (anyText(/\bsub-?agents?\b|\bdelegate\b.{0,30}\bagents?\b|子代理|子智能(?:体|體)/i)) {
    reasons.add('subagent-dependency');
  }
  if (
    keys.some((k) => /\bmcp\b|\bhooks?\b|\bscripts?\b|\bsub-?agents?\b/.test(k)) ||
    anyText(/\b(?:use|call|invoke)\s+(?:the\s+)?[a-z0-9_-]+\s+tools?\b/i) ||
    anyText(/(?:使用|(?:调用|調用|呼叫)).{0,24}工具/)
  ) {
    reasons.add('tool-dependency');
  }

  return {
    name,
    displayName: fields.display_name || fields['display-name'] || undefined,
    description: fields.description || `寫作技能：${name}`,
    version: fields.version || undefined,
    stage: normalizedStage(fields.stage),
    suggestedStage: suggestStage(fields, content),
    compatible: reasons.size === 0,
    reasons: [...reasons],
    body: content,
    attachments,
    unresolved,
    bytes,
  };
}

/** 不相容的原因，一句話。給了帶不上的那幾個檔案就跟在「包含相對引用」後面。 */
export function describeIncompat(reasons: readonly SkillIncompat[], unresolved: readonly string[] = []): string {
  return reasons
    .map((r) =>
      r === 'relative-reference' && unresolved.length > 0
        ? `${SKILL_INCOMPAT_LABEL[r]}（帶不上：${unresolved.join('、')}）`
        : (SKILL_INCOMPAT_LABEL[r] ?? r)
    )
    .join('、');
}

// ---------------------------------------------------------------- 身份

/**
 * 技能名：也是它在磁碟上的目錄名。字母或數字開頭，其後可以有 `.` `_` `-`，最長 64。
 * 中文算字母（與上游不同，見檔案頭）。沒有斜槓、沒有 `..`，拼成路徑不會越界。
 */
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export function isSkillName(name: unknown): name is string {
  return typeof name === 'string' && SKILL_NAME.test(name);
}

/** 穩定 id：`來源:名字`。同名的技能可以在幾個來源裡各有一份，靠字首分開。 */
export function skillId(source: SkillSource, name: string): string {
  return `${source}:${name}`;
}

export function parseSkillId(id: unknown): { source: SkillSource; name: string } | undefined {
  if (typeof id !== 'string') {
    return undefined;
  }
  const at = id.indexOf(':');
  const source = id.slice(0, at) as SkillSource;
  const name = id.slice(at + 1);
  if (at <= 0 || !SKILL_SOURCES.includes(source) || !isSkillName(name)) {
    return undefined;
  }
  return { source, name };
}

// ---------------------------------------------------------------- 繫結檔案

/** 每個階段綁了哪一份（技能 id）。沒綁的階段不出現。 */
export type SkillBindings = Partial<Record<SkillStage, string>>;

/**
 * `.novelwarden/skills.json` 的內容。形狀照搬上游的 `.vela/writing-skills.json`：
 * `{ "version": 1, "bindings": { "drafting": "builtin:plain-prose" } }`。
 *
 * **容錯**（第 1 條）：讀不懂的整份當成沒綁、認不出的那一項跳過，但都寫進 `problems`——
 * 裝配器拿它在明細裡說一聲（第 2 條），不讓作者以為技能帶上了。上游是讀不懂就整個工作流
 * 起不來。
 */
export interface SkillBindingProblem {
  /** 出在哪個階段的那一項上。整份讀不懂時沒有。 */
  stage?: string;
  text: string;
}

export function parseSkillBindings(raw: string): { bindings: SkillBindings; problems: SkillBindingProblem[] } {
  if (!raw.trim()) {
    return { bindings: {}, problems: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { bindings: {}, problems: [{ text: '不是合法的 JSON' }] };
  }
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1) {
    return { bindings: {}, problems: [{ text: '認不出的版本（應為 "version": 1）' }] };
  }
  const source = (data as { bindings?: unknown }).bindings;
  if (source === undefined) {
    return { bindings: {}, problems: [] };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { bindings: {}, problems: [{ text: '"bindings" 應該是一個物件' }] };
  }
  const bindings: SkillBindings = {};
  const problems: SkillBindingProblem[] = [];
  for (const [stage, id] of Object.entries(source as Record<string, unknown>)) {
    if (!isSkillStage(stage)) {
      problems.push({ stage, text: `認不出的階段「${stage}」` });
    } else if (!parseSkillId(id)) {
      problems.push({ stage, text: `「${SKILL_STAGE_LABEL[stage]}」綁的不是合法的技能 id` });
    } else {
      bindings[stage] = id as string;
    }
  }
  return { bindings, problems };
}

/** 落盤的那份文字。階段按固定順序排，改一項不會讓整份檔案的 diff 亂跳。 */
export function renderSkillBindings(bindings: SkillBindings): string {
  const ordered: SkillBindings = {};
  for (const stage of SKILL_STAGES) {
    if (bindings[stage]) {
      ordered[stage] = bindings[stage];
    }
  }
  return `${JSON.stringify({ version: 1, bindings: ordered }, null, 2)}\n`;
}

// ---------------------------------------------------------------- 一次裝配算哪個階段

/**
 * 這一次裝配該帶哪個階段的技能。`undefined` = 不帶。
 *
 * 討論（`discuss`）不帶：那是作者在聊，不是一次產出——上游的 AI 助手對話同樣不帶階段技能。
 * 定稿、摘要、文風提取、角色卡這些不經 `buildContext`，本來就帶不到（上游的定稿與文風分析
 * 也不帶）。
 */
export function skillStageOf(action: CreationAction, writeMode?: WriteMode): SkillStage | undefined {
  const { stage, capability } = action;
  if (capability === 'discuss') {
    return undefined;
  }
  if (stage === 'manuscript') {
    if (capability === 'review') {
      return 'review';
    }
    return writeMode === 'revise' ? 'refinement' : 'drafting';
  }
  return capability === 'generate' || capability === 'settle' ? 'planning' : undefined;
}

/**
 * 注入提示詞的那一塊。說法照搬上游（`base-command.ts:63`），去掉了「專案寫作語言」——
 * 這裡沒有那個概念。**放在使用者訊息的最前面**，與上游一樣：它是補充，作者事實與末尾的
 * 輸出合同都排在它後面、說了算。
 */
export function renderSkillBlock(label: string, body: string, attachments: readonly SkillAttachment[] = []): string {
  const parts = [`【補充寫作 Skill：${label}】\n以下內容只能補充創作方法；作者事實和後續輸出合同始終優先。\n${body.trim()}`];
  // 附帶檔案接在後面，標出路徑：正文裡「按需讀取 references/x.md」說的就是這一份。
  for (const a of attachments) {
    parts.push(`【附帶檔案：${a.path}】\n${a.text.replace(/\r\n?/g, '\n').trim()}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- GitHub 地址

export interface GitHubSkillLocation {
  owner: string;
  repo: string;
  /** 沒給就是預設分支（下載前要問一次 GitHub）。 */
  ref?: string;
  /** 倉庫裡那份 `SKILL.md` 的路徑。 */
  path: string;
  sourceUrl: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function safePart(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`GitHub 地址裡的${label}不合法`);
  }
  if (!SAFE_SEGMENT.test(decoded) || decoded === '.' || decoded === '..') {
    throw new Error(`GitHub 地址裡的${label}不合法`);
  }
  return decoded;
}

function safePath(parts: string[]): string {
  const decoded = parts.map((part, index) => safePart(part, `第 ${index + 1} 段路徑`)).join('/');
  if (!decoded || !decoded.toLowerCase().endsWith('skill.md')) {
    throw new Error('GitHub 地址要指到一份 SKILL.md');
  }
  return decoded;
}

/**
 * 認四種地址（照搬上游）：倉庫首頁（取預設分支根下的 `SKILL.md`）、`/tree/<分支>/<目錄>`、
 * `/blob/<分支>/<…SKILL.md>`、`raw.githubusercontent.com/<owner>/<repo>/<分支>/<…>`。
 * 只要公開的 https，不許帶使用者名稱、密碼、埠。**錯了就拋**，拋的那句就是給作者看的。
 */
export function parseGitHubSkillUrl(value: string): GitHubSkillLocation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('不是一個合法的地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('只支援公開的 https GitHub 地址');
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) {
      throw new Error('raw.githubusercontent.com 的地址不完整');
    }
    return {
      owner: safePart(parts[0], '使用者名稱'),
      repo: safePart(parts[1].replace(/\.git$/i, ''), '倉庫名'),
      ref: safePart(parts[2], '分支'),
      path: safePath(parts.slice(3)),
      sourceUrl: url.toString(),
    };
  }
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new Error('只支援 github.com 與 raw.githubusercontent.com');
  }

  const owner = safePart(parts[0], '使用者名稱');
  const repo = safePart(parts[1].replace(/\.git$/i, ''), '倉庫名');
  if (parts.length === 2) {
    return { owner, repo, path: 'SKILL.md', sourceUrl: url.toString() };
  }
  const kind = parts[2];
  if ((kind !== 'tree' && kind !== 'blob') || parts.length < 4) {
    throw new Error('請給倉庫、目錄（/tree/…）、檔案（/blob/…）或 raw 的 SKILL.md 地址');
  }
  const ref = safePart(parts[3], '分支');
  const targetParts = parts.slice(4);
  if (kind === 'tree') {
    targetParts.push('SKILL.md');
  }
  return { owner, repo, ref, path: safePath(targetParts), sourceUrl: url.toString() };
}

/** 真正去下載的那個地址。 */
export function githubRawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const segments = [owner, repo, ref, ...filePath.split('/')].map(encodeURIComponent);
  return `https://raw.githubusercontent.com/${segments.join('/')}`;
}

/** 分支名是否可以照抄進下載地址（GitHub 返回的預設分支也要過一遍）。 */
export function isSafeRef(ref: unknown): ref is string {
  return typeof ref === 'string' && SAFE_SEGMENT.test(ref) && ref !== '.' && ref !== '..';
}

/** 倉庫裡的一個檔案路徑能不能照抄進下載地址：每一段都與分支名同一條規矩。附帶檔案下載前過一遍。 */
export function isSafeGitHubPath(filePath: string): boolean {
  return filePath.split('/').every((seg) => isSafeRef(seg));
}
