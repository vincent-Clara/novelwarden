/**
 * 一份檔案是哪一類（後端 `kindOfPath` 給的種類）怎麼叫：存檔點彈窗（`view/checkpoints.ts`）與「版本」側欄的全書改動
 * （`versions.ts`）共用這一張表——同一份檔案不許在兩處叫兩個名字。路徑就在旁邊，這裡只要一眼分得出是正文還是設定；
 * 架構三件（小說配置、故事前提、世界觀）合稱「架構」，同「轉到…」面板上的標記。純資料、零 DOM，view.js 也打包它。
 */
import type { ArtifactKind } from '../protocol';

export const KIND_LABEL: Record<ArtifactKind, string> = {
  chapter: '章節',
  plot: '細綱',
  character: '角色卡',
  lore: '設定',
  draft: '草稿',
  setting: '架構',
  outline: '大綱',
  style: '文風',
  threads: '敘事線',
  globalSummary: '全文大綱',
  skill: '技能',
  sensitive: '敏感詞表',
  other: '其他',
};

/** 全書改動裡各組的先後：正文那一串在前，設定類在後。 */
export const KIND_ORDER: readonly ArtifactKind[] = [
  'chapter',
  'plot',
  'draft',
  'character',
  'lore',
  'setting',
  'outline',
  'style',
  'threads',
  'globalSummary',
  'skill',
  'sensitive',
  'other',
];
