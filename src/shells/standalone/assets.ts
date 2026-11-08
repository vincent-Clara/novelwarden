import { MEDIA_ASSETS } from './mediaAssets';

/** 版本號與資源表同在一個生成檔案裡，編譯時寫死（見 scripts/embed-media.js）。 */
export { PRODUCT_VERSION } from './mediaAssets';

/**
 * `/media/*` 路由的位元組來源：全部取自內嵌資源表，不讀磁碟——`bun build --compile`
 * 出來的單檔案可執行沒有外部資源可讀。
 *
 * 與 [page.ts](page.ts) 分開是有意的：頁面拼裝不該因為要渲染一段 HTML 就依賴
 * 這個幾十 MB 的生成檔案（`mediaAssets.ts` 由 scripts/embed-media.js 生成）。
 */
export function assetBytes(name: string): { mime: string; bytes: Uint8Array } | undefined {
  const asset = MEDIA_ASSETS[name];
  if (!asset) {
    return undefined;
  }
  return { mime: asset.mime, bytes: Uint8Array.from(Buffer.from(asset.base64, 'base64')) };
}
