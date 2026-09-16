// AnyShare CLI - OAuth2 认证（Hydra + 统一身份认证 CAS）
//
// 完整流程（已实测可用）:
//   1. 注册自己的 OAuth2 客户端:  POST /oauth2/clients  → client_id + client_secret
//      （redirect_uris 填我们自己的 http://127.0.0.1:<port>/callback）
//   2. 浏览器打开 /oauth2/auth?...&redirect_uri=http://127.0.0.1:<port>/callback 登录
//      （走山大统一身份认证 CAS）
//   3. 登录后浏览器跳到我们的本地服务器 → 自动捕获 ?code=xxx
//   4. POST /oauth2/token  用 client_secret_basic（Basic 认证）+ 授权码换 token
//   5. 之后用 refresh_token 长期自动刷新
const crypto = require('crypto');
const http = require('http');
const { exec } = require('child_process');
const config = require('./config');

function root(cfg) { return cfg.baseUrl.replace(/\/+$/, ''); }
function tokenUrl(cfg) { return root(cfg) + '/oauth2/token'; }

/** client_secret_basic 认证头（服务端要求此方式） */
function basicAuthHeader(cfg) {
  if (!cfg.clientId || !cfg.clientSecret) return null;
  const raw = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

/** 注册自己的 OAuth2 客户端 */
async function registerClient(cfg, opts = {}) {
  const redirectUri = opts.redirectUri || cfg.redirectUri || 'http://127.0.0.1:8899/callback';
  const body = {
    grant_types: ['authorization_code', 'refresh_token', 'implicit'],
    response_types: ['token id_token', 'code', 'token'],
    scope: cfg.scope || 'offline openid all',
    redirect_uris: [redirectUri],
    post_logout_redirect_uris: [redirectUri.replace(/\/callback$/, '/logout')],
    client_name: opts.clientName || 'asy-cli',
    metadata: {
      device: { name: 'RichClient', client_type: 'windows', description: 'asy-cli backup tool' },
    },
    login_form: { remember_password_visible: true },
  };
  const res = await fetch(root(cfg) + '/oauth2/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || !data.client_id) {
    throw new Error(`注册客户端失败: HTTP ${res.status} ${data.error_description || data.error_hint || text.slice(0, 300)}`);
  }
  cfg.clientId = data.client_id;
  cfg.clientSecret = data.client_secret;
  cfg.redirectUri = redirectUri;
  config.save(cfg);
  return data;
}

/** 授权 URL */
function buildAuthorizeUrl(cfg, opts = {}) {
  const redirectUri = opts.redirectUri || cfg.redirectUri;
  const state = opts.state || crypto.randomBytes(8).toString('hex');
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scope || 'offline openid all',
    redirect_uri: redirectUri,
    state,
    lang: 'zh-cn',
  });
  return { url: `${root(cfg)}/oauth2/auth?${q.toString()}`, state, redirectUri };
}

/** 解析 document.cookie 导出 */
function parseCookieString(str) {
  const out = {};
  const text = String(str).replace(/[\r\n]+/g, ' ');
  for (const part of text.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx < 0) {
      if (/^ey[A-Za-z0-9_-]+\./.test(part.trim())) out.refreshToken = out.refreshToken || part.trim();
      continue;
    }
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep */ }
    if (/refresh_token/i.test(name)) out.refreshToken = value;
    else if (/^authorization$/i.test(name)) out.accessToken = value.replace(/^Bearer\s+/i, '');
    else if (/access_token/i.test(name)) out.accessToken = value;
    else if (/subscriber/i.test(name)) out.subscriberId = value;
  }
  return out;
}

/** token 请求（Basic 认证） */
async function postToken(cfg, params) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  const basic = basicAuthHeader(cfg);
  if (basic) headers['Authorization'] = basic;
  const res = await fetch(tokenUrl(cfg), {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.error_description || data.error_hint || data.error || text.slice(0, 300);
    const err = new Error(`token 请求失败: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 用授权码换 token */
async function exchangeCode(cfg, code) {
  const clean = String(code).trim();
  let codeValue = clean;
  const m = clean.match(/[?&]code=([^&\s]+)/);
  if (m) codeValue = decodeURIComponent(m[1]);
  const data = await postToken(cfg, {
    grant_type: 'authorization_code',
    code: codeValue,
    redirect_uri: cfg.redirectUri,
  });
  applyToken(cfg, data);
  return data;
}

/** refresh_token 刷新 */
async function refresh(cfg) {
  if (!cfg.refreshToken) throw new Error('没有 refresh_token，请先执行 asy login');
  const data = await postToken(cfg, {
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
  });
  applyToken(cfg, data);
  return data;
}

function applyToken(cfg, data) {
  if (data.access_token) cfg.accessToken = data.access_token;
  if (data.refresh_token) cfg.refreshToken = data.refresh_token;
  const ttl = Number(data.expires_in || 3600);
  cfg.expiresAt = Date.now() + ttl * 1000;
  // JWT 里的 exp 更准
  try {
    const payload = JSON.parse(Buffer.from(String(data.access_token).split('.')[1], 'base64').toString('utf8'));
    if (payload.exp) cfg.expiresAt = payload.exp * 1000;
  } catch { /* 非 JWT 就用 expires_in */ }
  config.save(cfg);
}

async function ensureFresh(cfg, opts = {}) {
  if (cfg.accessToken && cfg.expiresAt - 60000 > Date.now() && !opts.force) return cfg.accessToken;
  if (!cfg.refreshToken) throw new Error('未登录或 token 已失效。请执行: asy login');
  await refresh(cfg);
  return cfg.accessToken;
}

/** 跨平台打开浏览器（失败不致命，会打印 URL 让用户手动打开） */
function openBrowser(url) {
  // 通过 SSH 等无图形环境运行时，直接让用户手动打开
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  const { exec } = require('child_process');
  const ignore = () => {};
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`, ignore);
      return true;
    }
    if (process.platform === 'darwin') {
      exec(`open "${url}"`, ignore);
      return true;
    }
    // Linux / 其他类 Unix：优先 xdg-open，WSL 下退回 wslview
    exec(`xdg-open "${url}" || wslview "${url}"`, ignore);
    return true;
  } catch {
    return false;
  }
}

/** 本地回调服务器登录（推荐，全自动捕获授权码） */
async function loginWithLocalServer(cfg, opts = {}) {
  const redirectUri = cfg.redirectUri || 'http://127.0.0.1:8899/callback';
  const port = Number(new URL(redirectUri).port || 8899);
  const { url, state } = buildAuthorizeUrl(cfg, { redirectUri });

  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!u.pathname.startsWith('/callback')) {
      res.writeHead(404); res.end('not found'); return;
    }
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (code) {
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>✅ 授权成功</h2><p>可以关闭此页面，回到终端继续。</p></body></html>');
      resolveCode(code);
    } else {
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>❌ 授权失败</h2><pre>' + (err || 'unknown') + '</pre></body></html>');
      rejectCode(new Error('授权失败: ' + (err || 'unknown')));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  console.log(`\n请在浏览器中打开以下地址完成登录：\n\n${url}\n`);
  const opened = openBrowser(url);
  if (!opened) console.log('（未能自动打开浏览器，请手动复制上面的地址）');

  const code = await Promise.race([
    codePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('等待登录超时（5 分钟）')), 300000)),
  ]);
  server.close();
  console.log('已捕获授权码，正在换取 token ...');
  const data = await exchangeCode(cfg, code);
  return data;
}

module.exports = {
  registerClient,
  buildAuthorizeUrl,
  parseCookieString,
  exchangeCode,
  refresh,
  applyToken,
  ensureFresh,
  postToken,
  loginWithLocalServer,
  basicAuthHeader,
};