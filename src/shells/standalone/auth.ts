/**
 * 獨立版的訪問控制：監聽地址要不要令牌、請求帶的憑據認不認、Origin 認不認、登入頁。
 *
 * 預設形態沒變：只綁 127.0.0.1、無鑑權，安全全靠「別的機器連不進來」。部署到伺服器
 * （Docker 映象就是這樣）得綁 0.0.0.0，這道牆就沒了，所以**綁非迴環地址必須配令牌**，
 * 沒配就拒絕啟動（`exposureError`）——寧可起不來，也不要裸奔。令牌只認環境變數
 * `NOVELWARDEN_TOKEN`（舊名 `NOVELFORGE_TOKEN` 繼續相容）：命令列引數會出現在 `ps` 裡。
 *
 * 配了令牌之後，不管綁在哪都要鑑權：
 * - 網頁：登入頁交一次令牌，換一個 cookie。cookie 裡是由令牌派生的值、不是令牌原文；
 *   換令牌重啟後舊 cookie 自然作廢。`SameSite=Lax`：跨站頁面發起的 WebSocket 握手與
 *   `fetch` 帶不上它，頂層導航（從書籤、別的頁面點進來）帶得上。
 * - MCP 客戶端：`Authorization: Bearer <令牌>`（`claude mcp add … --header`）。
 *
 * 純函式，只用標準 `Request` / `Response`，單測在 Node 下直接跑。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_ENV = 'NOVELWARDEN_TOKEN';
/** 改名前的變數名。老部署的 compose / 指令碼還在用它，繼續認。 */
export const LEGACY_TOKEN_ENV = 'NOVELFORGE_TOKEN';
/** 令牌下限。登入頁能被人反覆試，短令牌經不起猜。 */
export const MIN_TOKEN_LENGTH = 16;
export const LOGIN_PATH = '/login';

/** 從環境變數取令牌：新名優先，舊名兜底。空白當沒給。 */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[TOKEN_ENV]?.trim() || env[LEGACY_TOKEN_ENV]?.trim() || undefined;
}

const COOKIE_NAME = 'nf_session';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
/** 令牌錯了先等一會兒再回：拖慢逐個猜的速度，對正常輸錯的人只是一眨眼。 */
const LOGIN_FAIL_DELAY_MS = 1000;

/** 迴環地址：只有本機連得進來，這時才允許不設令牌。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 這樣起服務安不安全。返回要列印給作者的那句話；沒問題返回 undefined。
 * `token` 由呼叫方先把空串歸一成 undefined。
 */
export function exposureError(host: string, token: string | undefined): string | undefined {
  const hint = `可用 \`openssl rand -hex 24\` 生成一個，放進環境變數 ${TOKEN_ENV}。`;
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
    return `訪問令牌太短（${token.length} 位，至少 ${MIN_TOKEN_LENGTH} 位）。${hint}`;
  }
  if (token === undefined && !isLoopbackHost(host)) {
    return `監聽 ${host} 會讓別的機器連進來，必須先設訪問令牌。${hint}`;
  }
  return undefined;
}

/** 兩邊先摘要成等長再比，`timingSafeEqual` 才不會因長度不同直接拋、也不洩露長度。 */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** cookie 裡放的值。 */
export function sessionValue(token: string): string {
  return createHash('sha256').update(`novelwarden-session:${token}`).digest('hex');
}

function cookieOf(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** 請求帶的憑據認不認：Bearer 令牌或登入換來的 cookie，有一樣對就行。 */
export function isAuthorized(req: Request, token: string): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (bearer && sameSecret(bearer[1].trim(), token)) {
    return true;
  }
  const cookie = cookieOf(req, COOKIE_NAME);
  return cookie !== undefined && sameSecret(cookie, sessionValue(token));
}

/**
 * WS 與 MCP 的 Origin 白名單。
 *
 * 沒有 Origin 頭的一律放過——命令列工具（冒煙測試裡的 Bun WebSocket、wscat、MCP 客戶端）
 * 不發這個頭，瀏覽器一定發，所以缺失說明不是網頁發起的請求。
 *
 * 本機同埠始終認。**配了令牌時**再認同源（Origin 與 `Host` / `X-Forwarded-Host` 一致）：
 * 經伺服器地址或反代訪問時，Origin 本來就不是 127.0.0.1。沒配令牌時絕不能認這條——
 * DNS rebinding 的頁面開在 `evil.com:3680`，解析到 127.0.0.1 後 Origin 與 Host 恰好一致，
 * 那時擋住它的只有「只認本機」這一條；配了令牌則它拿不到綁在真實地址上的 cookie。
 */
export function isAllowedOrigin(origin: string | null, req: Request, port: number, withToken: boolean): boolean {
  if (!origin) {
    return true;
  }
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHost(u.hostname) && u.port === String(port)) {
    return true;
  }
  if (!withToken) {
    return false;
  }
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0];
  return [req.headers.get('host'), forwarded].some((h) => !!h && h.trim().toLowerCase() === u.host.toLowerCase());
}

/** 登入後跳回哪：只認站內路徑，`//evil.com` 與絕對地址一律回首頁，免得登入頁成了跳板。 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/';
  }
  return next;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 登入頁。自帶樣式：`/media/view.css` 依賴主頁面的主題變數，單獨拿來用不成樣子。 */
export function loginPage(next: string, failed: boolean): string {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novelwarden · 登入</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { display: grid; gap: 12px; width: min(320px, 90vw); }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; opacity: .75; font-size: 14px; }
  input, button { font: inherit; padding: 8px 10px; border-radius: 6px; }
  input { border: 1px solid #8886; background: transparent; color: inherit; }
  button { border: 0; background: #4daafc; color: #fff; cursor: pointer; }
  .error { color: #e5484d; opacity: 1; }
</style>
</head>
<body>
<form method="post" action="${LOGIN_PATH}">
  <h1>Novelwarden</h1>
  <p>這臺服務設了訪問令牌，輸入後進入。</p>
  ${failed ? '<p class="error">令牌不對。</p>' : ''}
  <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
  <input type="password" name="token" placeholder="訪問令牌" autocomplete="current-password" autofocus required>
  <button type="submit">進入</button>
</form>
</body>
</html>
`;
}

/** 未登入訪問頁面時回的那一頁：401，內容是登入頁，交完跳回原地址。 */
export function loginRequired(url: URL): Response {
  return new Response(loginPage(url.pathname + url.search, false), {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** `/login`：GET 出登入頁，POST 核對令牌、種 cookie、303 跳回。 */
export async function handleLogin(req: Request, token: string): Promise<Response> {
  const html = (body: string, status: number) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return html(loginPage(safeNext(url.searchParams.get('next')), false), 200);
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }
  let given = '';
  let next = '/';
  try {
    const form = await req.formData();
    given = String(form.get('token') ?? '');
    next = safeNext(String(form.get('next') ?? '/'));
  } catch {
    // 表單解析不了就當令牌是空的
  }
  if (!sameSecret(given, token)) {
    await new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS));
    return html(loginPage(next, true), 401);
  }
  // 經 HTTPS 反代訪問時加 Secure；直連 http 的區域網訪問加了反而存不下。
  const https =
    url.protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  const cookie = [
    `${COOKIE_NAME}=${sessionValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    ...(https ? ['Secure'] : []),
  ].join('; ');
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
}
