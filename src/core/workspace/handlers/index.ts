/**
 * 種類 → handler 登錄檔。
 *
 * 認不出的種類落到 `plain`（純文字進出、無記賬）——**絕不拋**：閘道器不該
 * 因為一個沒登記的種類就拒絕寫一個普通文字檔案。
 */
import { ArtifactKind } from '../kind';
import { Handler } from './types';
import { docHandler } from './doc';
import { plainHandler } from './plain';
import { settingHandler } from './setting';
import { plotHandler } from './plot';
import { chapterHandler } from './chapter';

// 情節大綱（`outline`）不在表裡：它沒有檔案，讀寫由閘道器自己接住（`Workspace.writeOutline`）。
const REGISTRY: Partial<Record<ArtifactKind, Handler>> = {
  setting: settingHandler,
  style: docHandler,
  globalSummary: docHandler,
  threads: docHandler,
  skill: plainHandler,
  sensitive: plainHandler,
  character: docHandler,
  lore: docHandler,
  plot: plotHandler,
  chapter: chapterHandler,
  other: plainHandler,
  draft: plainHandler,
};

export function handlerFor(kind: ArtifactKind): Handler {
  return REGISTRY[kind] ?? plainHandler;
}

export type { Handler, HandlerCtx, HandlerWriteResult } from './types';
