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

/** 注册自己的 OAuth2 客户端
 *  ⚠️ client_type 很关键：登录页会据此决定「统一身份认证」按钮的行为
 *     - "windows"（桌面客户端）→ 按钮改为向父窗口 postMessage，在浏览器里会"点不动"
 *     - "web"（浏览器）→ 按钮直接跳转到 CAS ✅  CLI 走浏览器流程，必须用 web
 */
async function registerClient(cfg, opts = {}) {
  const redirectUri = opts.redirectUri || cfg.redirectUri || 'http://127.0.0.1:8899/callback';
  const clientType = opts.clientType || 'web';
  const body = {
    grant_types: ['authorization_code', 'refresh_token', 'implicit'],
    response_types: ['token id_token', 'code', 'token'],
    scope: cfg.scope || 'offline openid all',
    redirect_uris: [redirectUri],
    post_logout_redirect_uris: [redirectUri.replace(/\/callback$/, '/logout')],
    client_name: opts.clientName || 'asy-cli',
    metadata: {
      device: {
        name: clientType === 'web' ? 'WebBrowser' : 'RichClient',
        client_type: clientType,
        description: 'asy-cli university cloud client',
      },
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

// ---------------------------------------------------------------------------
// 统一身份认证（CAS）自动登录
//
// 适用于「认证完全交给 CAS」的学校（如山东大学）：AnyShare 侧没有本地密码，
// 必须走 CAS。流程（复现浏览器端的真实行为）：
//
//   1. 建立 OAuth 会话（GET /oauth2/auth → login_challenge + Cookie）
//   2. GET CAS 登录页 → lt / execution + CAS Cookie
//      ⚠️ /cas/device 的 CSRF 校验依赖 CAS 会话 Cookie
//   3. 凭据只藏在 rsa 字段：rsa = strEnc(用户名 + 密码 + lt, '1','2','3')
//      ul / pl 分别是用户名 / 密码的【长度】（服务端解密后据此切分）
//   4. POST /cas/device  { m:'1', d, i, u:<加密>, p:<加密> } 查询设备状态
//      → { info: 'bind', m: '139*****3662' } 表示新设备需要短信验证
//   5. 若需短信：POST /cas/device { m:'3', u:<明文>, c:<短信码>, s:1 }
//      s=1 表示「信任此设备」（否则每次都要短信）
//   6. 提交登录表单 → 302 带 ticket=ST-xxx
//   7. 带 ticket 回 /oauth2/signin（用 OAuth 会话 Cookie）→ 回调拿 code → 换 token
// ---------------------------------------------------------------------------

/** 从学校的 CAS 服务器动态加载它的 strEnc（DES）实现——避免内置第三方代码 */
async function loadStrEnc(casBase) {
  if (loadStrEnc._cache) return loadStrEnc._cache;
  const res = await fetch(`${casBase}/cas/comm/js/des.js`);
  if (!res.ok) throw new Error(`加载 CAS 加密脚本失败: HTTP ${res.status}`);
  const code = await res.text();
  const vm = require('vm');
  const sandbox = { window: {}, document: {}, navigator: {} };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;globalThis.__strEnc = strEnc;', sandbox);
  if (typeof sandbox.__strEnc !== 'function') throw new Error('CAS des.js 中未找到 strEnc');
  loadStrEnc._cache = sandbox.__strEnc;
  return sandbox.__strEnc;
}

/** 解析 CAS 页面中的隐藏字段 */
function parseCasHidden(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = (/name="([^"]+)"/i.exec(m[0]) || [])[1];
    const value = (/value="([^"]*)"/i.exec(m[0]) || [])[1] || '';
    if (name) out[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return out;
}

/** 构造与浏览器一致的设备指纹字段（三次 /cas/device 调用共用同一套值）
 *  浏览器用 Fingerprint2 算出 murmur / murmur_s / details_s：
 *    m:'1' 发送 { d: murmur, d_s: murmur_s, d_md5: strEnc(...), d_browser_md5: strEnc(...),
 *                 i: strEnc(details_s), u: strEnc(user), p: strEnc(pwd) }
 *    m:'3' 发送 { d: murmur_s, i: details_s(明文), u: 明文, c: 短信码, s: 信任设备 }
 *  注意 i 在 m:1 里是【加密】的、在 m:3 里是【明文】，d 两次用的也不是同一个值。
 */
function makeDeviceIdentity(seed) {
  const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
  const detailsS = 'asy-cli device (Node.js)';
  return {
    murmur: md5(seed + '|murmur'),          // 32 位 hex，对应 Fingerprint2.x64hash128
    murmurS: md5(seed + '|murmur_s'),
    detailsS,                                // 设备详情（m:'3' 用明文，m:'1' 用其加密值）
    murmurMd5: md5(md5(seed + '|murmur_s')),
    browserS: md5('asy-cli-browser'),
  };
}

/** 统一身份认证（CAS）自动登录 */
async function loginWithCas(cfg, opts = {}) {
  const account = opts.account;
  const password = opts.password;
  if (!account || !password) throw new Error('需要 account 和 password');

  const { casBase = 'https://pass.sdu.edu.cn' } = opts;
  const base = root(cfg);
  const service = `${base}/oauth2/signin`;
  const strEnc = opts.strEnc || (await loadStrEnc(casBase));

  const anj = makeCookieJar();   // anyshare 域
  const casj = makeCookieJar();  // CAS 域

  // 1) 建立 OAuth 会话
  //    ⚠️⚠️ 必须【手动逐跳】跟随重定向：Node 的 fetch 没有 Cookie 罐，
  //    用 { redirect:'follow' } 会丢掉中间跳的 Set-Cookie —— 而 Hydra 的
  //    `ory_hydra_login_csrf_<random>` Cookie 正是在第一个 302 里下发的。
  //    丢了它，最后一步 /oauth2/auth 会报：
  //      "request_forbidden: No CSRF value available in the session cookie"
  const { url: authUrl } = buildAuthorizeUrl(cfg, { state: crypto.randomBytes(8).toString('hex') });
  let loginChallenge = null;
  {
    let cur = authUrl;
    for (let hop = 0; hop < 6 && cur; hop++) {
      const r = await fetch(cur, { redirect: 'manual', headers: { 'Cookie': anj.header() } });
      anj.absorb(r);
      const loc = r.headers.get('location');
      if (opts.debug) console.error(`[debug] auth hop ${hop + 1}: HTTP ${r.status} → ${(loc || '(页面)').slice(0, 100)}`);
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      const m = /[?&]login_challenge=([^&\s]+)/.exec(cur);
      if (m) loginChallenge = m[1];
    }
  }
  // 浏览器在点击「统一身份认证登录」时还会写入这两个 Cookie，
  // CAS 回跳 /oauth2/signin?ticket=... 后服务端靠它们恢复 OAuth 会话。
  if (loginChallenge) {
    anj.set('login_challenge', loginChallenge);
    anj.set('is_previous_login_3rd_party', 'true');
  }

  // 2) CAS 登录页
  const casLoginUrl = `${casBase}/cas/login?service=${encodeURIComponent(service)}`;
  const casRes = await fetch(casLoginUrl, { headers: { 'Cookie': casj.header() } });
  casj.absorb(casRes);
  const casHtml = await casRes.text();
  const hf = parseCasHidden(casHtml);
  const lt = hf.lt;
  if (!lt) throw new Error('未能从 CAS 页取得 lt（登录票据）');

  // 3) 加密凭据
  const rsa = strEnc(account + password + lt, '1', '2', '3');
  const CAS_UA = opts.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const casHeaders = () => ({
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Cookie': casj.header(),
    'Referer': casLoginUrl,
    'Origin': casBase,
    'User-Agent': CAS_UA,
    'X-Requested-With': 'XMLHttpRequest',
  });

  // 设备指纹（与浏览器三处调用保持一致，见 makeDeviceIdentity 注释）
  const ident = opts.device || makeDeviceIdentity(account + '|asy-cli');

  const postDevice = async (fields) => {
    const body = new URLSearchParams(fields);
    const r = await fetch(`${casBase}/cas/device`, { method: 'POST', headers: casHeaders(), body: body.toString() });
    casj.absorb(r);
    const t = await r.text();
    let j;
    try { j = JSON.parse(t); } catch { j = { raw: t }; }
    return { status: r.status, data: j };
  };

  // 4) 查询设备状态（m:'1'）—— 字段必须与浏览器完全一致
  const probe = await postDevice({
    d: ident.murmur,
    d_s: ident.murmurS,
    d_md5: strEnc(ident.murmurMd5, '1', '2', '3'),
    d_browser_md5: strEnc(ident.browserS, '1', '2', '3'),
    i: strEnc(ident.detailsS, '1', '2', '3'),
    m: '1',
    u: strEnc(account, '1', '2', '3'),
    p: strEnc(password, '1', '2', '3'),
  });
  if (opts.debug) console.error('[debug] device m=1 →', JSON.stringify(probe));

  const info = String((probe.data && probe.data.info) || '');
  // 注意：'bind' = 需要短信验证；'binded' = 该设备已被信任（无需短信）——不要用子串匹配！
  const needSms = info === 'bind' || info === 'needBind';
  const maskedPhone = (probe.data && probe.data.m) || '';
  if (opts.debug) console.error(`[debug] 设备状态: ${info} → ${needSms ? '需要短信验证' : '已信任，直接登录'}`);

  // 5) 需要短信验证 → 提示用户输入（可用 smsCodeProvider 自定义）
  if (needSms) {
    if (typeof opts.smsCodeProvider !== 'function') {
      throw new Error(`该设备需要短信验证（手机 ${maskedPhone}），但未提供 smsCodeProvider 回调`);
    }
    // 触发发送短信验证码（对应页面上的「发送验证码」按钮 /cas/device m:'2'）
    const sent = await postDevice({ m: '2' });
    if (opts.debug) console.error('[debug] device m=2 →', JSON.stringify(sent));
    const sentInfo = String((sent.data && sent.data.info) || '');
    if (sentInfo === 'max') {
      console.error('  ⚠️ 发送过于频繁（服务端限流），请稍后再试；若手机上刚收到验证码可直接输入');
    } else if (sent.status >= 400) {
      console.error(`  ⚠️ 发送短信验证码失败: ${JSON.stringify(sent.data).slice(0, 120)}`);
    }
    let verified = false;
    let lastInfo = '';
    for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
      const code = String(await opts.smsCodeProvider({ phone: maskedPhone, account, attempt }) || '').trim();
      if (!code) throw new Error('未输入短信验证码，已取消');
      const verify = await postDevice({
        d: ident.murmurS,
        i: ident.detailsS,
        m: '3',
        u: account,
        c: code,
        s: opts.trustDevice === false ? '0' : '1',   // ✅ 默认勾选「信任此设备」
      });
      if (opts.debug) console.error('[debug] device m=3 →', JSON.stringify(verify));
      const okInfo = String((verify.data && verify.data.info) || '');
      lastInfo = okInfo;
      if (/codeErr|timeout|fail|error|invalid|max/i.test(okInfo) || verify.status >= 400) {
        if (attempt < 3) {
          console.error(`  ⚠️ 短信验证码不正确或已超时（第 ${attempt} 次，服务端: ${okInfo}），请重新输入`);
          continue;
        }
        throw new Error(`短信验证失败: ${JSON.stringify(verify.data).slice(0, 200)}`);
      }
      if (okInfo === 'most') console.error('提示：授信设备已达上限，服务端已自动解除最早一台。');
      verified = true;
    }
    if (!verified) throw new Error(`短信验证未通过（${lastInfo}）`);
  }

  // 6) 提交登录表单（凭据只在 rsa 里）
  const form = new URLSearchParams({
    rsa,
    ul: String(account.length),
    pl: String(password.length),
    lt,
    execution: hf.execution || 'e1s1',
    _eventId: 'submit',
  });
  const submitRes = await fetch(casLoginUrl, {
    method: 'POST',
    headers: Object.assign(casHeaders(), { 'X-Requested-With': undefined }),
    body: form.toString(),
    redirect: 'manual',
  });
  casj.absorb(submitRes);
  let location = submitRes.headers.get('location') || '';
  let ticket = null;
  let mt = /[?&]ticket=([^&\s]+)/.exec(location);
  if (mt) ticket = decodeURIComponent(mt[1]);

  if (!ticket) {
    const t = await submitRes.text().catch(() => '');
    const msg = (/id="errormsg"[^>]*>([^<]*)</i.exec(t) || [])[1]
      || t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`CAS 登录未被接受: HTTP ${submitRes.status} ${msg.trim().slice(0, 160)}`);
  }

  // 7) 带 ticket 回 /oauth2/signin，完成 OAuth
  const cbHost = (() => { try { const u = new URL(redirectUri); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; } catch { return '127.0.0.1:8899'; } })();
  let current = `${service}?ticket=${encodeURIComponent(ticket)}`;
  let code = null;
  let lastLocation = '';
  for (let hop = 0; hop < 8 && current; hop++) {
    const m = /[?&]code=([^&\s]+)/.exec(current);
    if (m) { code = decodeURIComponent(m[1]); break; }
    // ⚠️ 如果重定向目标就是我们自己的回调地址（本地无服务器监听），
    //    绝不能去 fetch 它，否则 ECONNREFUSED；只从中解析 code 即可。
    let isCallback = false;
    try {
      const u = new URL(current);
      isCallback = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}` === cbHost;
    } catch { /* ignore */ }
    if (isCallback) {
      lastLocation = current;
      if (opts.debug) console.error('[debug] 服务端已重定向到本地回调:', current.slice(0, 160));
      break;
    }
    const r = await fetch(current, { redirect: 'manual', headers: { 'Cookie': anj.header() } });
    anj.absorb(r);
    const loc = r.headers.get('location');
    if (opts.debug) console.error(`[debug] hop ${hop + 1}: HTTP ${r.status} → ${(loc || '').slice(0, 120) || '(无 Location)'}`);
    if (!loc) break;
    current = new URL(loc, current).toString();
  }
  if (!code) {
    throw new Error(`CAS 登录已通过，但未取得授权码${lastLocation ? '（回调: ' + lastLocation.slice(0, 120) + '）' : ''}（OAuth 会话可能已失效，请重试）`);
  }

  const data = await postToken(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
  applyToken(cfg, data);
  return data;
}
// ---------------------------------------------------------------------------
// 无浏览器登录（headless）：学号 + 密码 全自动登录（适用于 AnyShare 本地密码可用的实例）
//
// 流程（与官方桌面客户端一致）:
//   1. GET /oauth2/auth...            → 登录页 HTML，从中提取 challenge / csrftoken
//   2. RSA(PKCS#1 v1.5) 加密密码       → base64
//   3. POST /oauth2/signin (JSON)     → 返回 { redirect: "<url>" }
//   4. 跟随 redirect 直到 Location 含 code=  → 提取授权码（不需要真正监听端口）
//   5. POST /oauth2/token (Basic)     → 换取 token
//
// 相比浏览器登录的优势：服务机/无图形环境下可无人值守自动化。
// 注意：本方式需要处理用户密码（仅在内存中使用，不落盘）。
// ---------------------------------------------------------------------------

/**
 * AnyShare 登录页使用的 RSA 公钥。
 *
 * 注意：部署里有两把钥匙（都内嵌在前端 bundle 中）
 *   - 2048 位：用于 /oauth2/signin 提交登录密码  ← 本 CLI 使用这把
 *   - 1024 位：仅用于 /eacp/v1/auth1/sendauthvcode（短信验证码）
 * 用错钥匙时服务端会报 `RSA_private_decrypt error`。
 *
 * 若某个部署的钥匙不同，可用 `asy config set publicKey "<PEM>"` 覆盖，
 * 或用 `asy login --password --discover-key` 自动从登录页提取。
 */
const ANYSHARE_RSA_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4E+eiWRwffhRIPQYvlXU',
  'jf0b3HqCmosiCxbFCYI/gdfDBhrTUzbt3fL3o/gRQQBEPf69vhJMFH2ZMtaJM6oh',
  'E3yQef331liPVM0YvqMOgvoID+zDa1NIZFObSsjOKhvZtv9esO0REeiVEPKNc+Dp',
  '6il3x7TV9VKGEv0+iriNjqv7TGAexo2jVtLm50iVKTju2qmCDG83SnVHzsiNj70M',
  'iviqiLpgz72IxjF+xN4bRw8I5dD0GwwO8kDoJUGWgTds+VckCwdtZA65oui9Osk5',
  't1a4pg6Xu9+HFcEuqwJTDxATvGAz1/YW0oUisjM0ObKTRDVSfnTYeaBsN6L+M+8g',
  'CwIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

/** 1024 位钥匙（仅短信验证码接口使用，保留备查） */
const ANYSHARE_RSA_PUBLIC_KEY_1024 = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7JL0DcaMUHumSdhxXTxqiABBC',
  'DERhRJIsAPB++zx1INgSEKPGbexDt1ojcNAc0fI+G/yTuQcgH1EW8posgUni0mcT',
  'E6CnjkVbv8ILgCuhy+4eu+2lApDwQPD9Tr6J8k21Ruu2sWV5Z1VRuQFqGm/c5vaT',
  'OQE5VFOIXPVTaa25mQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

/** 从登录页及其 JS 中自动发现用于 signin 的 RSA 公钥（模数最大的那把） */
async function discoverPublicKey(cfg) {
  const { url } = buildAuthorizeUrl(cfg, { state: crypto.randomBytes(8).toString('hex') });
  const pageRes = await fetch(url, { redirect: 'follow' });
  const html = await pageRes.text();
  const pageUrl = pageRes.url || url;

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const keys = [];
  for (const src of scripts) {
    if (!/\.js(\?|$)/.test(src)) continue;
    let text;
    try {
      const r = await fetch(new URL(src, pageUrl).toString());
      if (!r.ok) continue;
      text = await r.text();
    } catch { continue; }
    for (const m of text.matchAll(/publicKeyFromPem\(\s*"([\s\S]*?)"\s*\)/g)) {
      const pem = m[1].replace(/\\n/g, '\n').trim();
      if (pem.includes('BEGIN PUBLIC KEY') && pem.includes('END PUBLIC KEY')) keys.push(pem);
    }
  }
  if (!keys.length) throw new Error('未能从登录页 JS 中发现 RSA 公钥');
  // 模数最大者（2048 位）即 signin 所用
  const best = keys.sort((a, b) => b.length - a.length)[0];
  let bits = 0;
  try {
    const crypto = require('crypto');
    bits = crypto.createPublicKey(best).asymmetricKeyDetails.modulusLength || 0;
  } catch { /* 取不到就算了 */ }
  return { pem: best, bits, found: keys.length };
}

/** RSA(PKCS#1 v1.5) 加密并 base64（等价于前端 forge 的 encrypt + btoa） */
function rsaEncryptPassword(password, publicKeyPem) {
  const crypto = require('crypto');
  const pem = publicKeyPem || ANYSHARE_RSA_PUBLIC_KEY;
  const enc = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(password), 'utf8'),
  );
  return enc.toString('base64');
}

/** 从登录页 HTML 里提取 challenge 与 csrftoken */
function extractChallengeAndCsrf(html) {
  const challenge = /"challenge":"(.*?)"/.exec(html);
  const csrf = /"csrftoken":"(.*?)"/.exec(html);
  if (!challenge || !csrf) {
    throw new Error('无法从登录页提取 challenge / csrftoken（登录页结构可能已变化）');
  }
  return { challenge: challenge[1], csrf: csrf[1] };
}

/** 简易 Cookie 罐（登录流程需要保持会话：csrf 校验依赖 Cookie） */
function makeCookieJar() {
  const jar = new Map();
  return {
    set(name, value) { jar.set(String(name), String(value)); return this; },
    absorb(res) {
      let list = [];
      try {
        if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
        else {
          const single = res.headers.get('set-cookie');
          if (single) list = [single];
        }
      } catch { /* ignore */ }
      for (const c of list) {
        const pair = String(c).split(';')[0];
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      return this;
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get size() { return jar.size; },
  };
}

/** 生成一个稳定的设备标识（MAC 形式），可用 cfg.udid 覆盖 */
function defaultUdid() {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(require('os').hostname() || 'asy-cli').digest('hex');
  return `00-${h.slice(0, 2)}-${h.slice(2, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)}-${h.slice(8, 10)}`.toUpperCase();
}

/** 登录配置（判断是否需要图形验证码） */
async function fetchLoginConfigs(cfg) {
  const res = await fetch(`${root(cfg)}/api/eacp/v1/auth1/login-configs`, {
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** 拉取图形验证码 → { uuid, imageBase64 } */
async function fetchCaptcha(cfg, uuid = '') {
  const res = await fetch(`${root(cfg)}/api/eacp/v1/auth1/getvcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ uuid }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || !data.vcode) {
    throw new Error(`获取验证码失败: HTTP ${res.status} ${data.cause || data.message || text.slice(0, 200)}`);
  }
  return { uuid: data.uuid || '', imageBase64: data.vcode };
}

/** 判断是否需要图形验证码 */
function captchaRequired(configs) {
  const v = configs && configs.vcode_login_config;
  return !!(v && v.isenable && (v.passwderrcnt === 0 || v.passwderrcnt === undefined));
}

/** 学号+密码 全自动登录（无需浏览器；支持图形验证码人工输入） */
async function loginWithPassword(cfg, opts = {}) {
  const account = opts.account;
  const password = opts.password;
  if (!account || !password) throw new Error('需要 account（学号/工号）和 password');

  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error('请先执行 asy register 注册 CLI 专用客户端');
  }

  const udid = opts.udid || cfg.udid || defaultUdid();
  const redirectUri = cfg.redirectUri;
  const state = crypto.randomBytes(8).toString('hex');

  // 1) 取登录页，解析 challenge / csrftoken
  const authUrl = `${root(cfg)}/oauth2/auth?` + new URLSearchParams({
    audience: '',
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scope || 'offline openid all',
    redirect_uri: redirectUri,
    state,
    lang: 'zh-cn',
    udids: udid,
  }).toString();

  const pageRes = await fetch(authUrl, { redirect: 'follow' });
  const jar = makeCookieJar().absorb(pageRes);
  const html = await pageRes.text();
  if (pageRes.status >= 400) {
    throw new Error(`获取登录页失败: HTTP ${pageRes.status}`);
  }
  const { challenge, csrf } = extractChallengeAndCsrf(html);

  // 2) 加密密码
  const encrypted = rsaEncryptPassword(password, cfg.publicKey);

  // 3) 是否需要图形验证码
  let vcode = { id: '', content: '' };
  let needCaptcha = false;
  try {
    const configs = await fetchLoginConfigs(cfg);
    needCaptcha = captchaRequired(configs);
  } catch (e) {
    if (opts.debug) console.error('[debug] 获取登录配置失败:', e.message);
  }
  if (!needCaptcha && opts.forceCaptcha) needCaptcha = true;

  const maxAttempts = needCaptcha ? 3 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (needCaptcha) {
      if (opts.captchaOverride && attempt === 1) {
        // 允许外部直接指定（uuid + 已识别的验证码），便于脚本化/自动化
        vcode = { id: opts.captchaOverride.uuid, content: String(opts.captchaOverride.code).trim() };
      } else {
        const cap = await fetchCaptcha(cfg);
        if (typeof opts.captchaProvider !== 'function') {
          throw new Error('该实例需要图形验证码，但未提供 captchaProvider 回调（请用 CLI 交互式登录）');
        }
        const input = await opts.captchaProvider({ uuid: cap.uuid, imageBase64: cap.imageBase64, attempt });
        if (!input) throw new Error('未输入验证码，已取消');
        vcode = { id: cap.uuid, content: String(input).trim() };
      }
    }

    const signinBody = {
      _csrf: csrf,
      challenge,
      account,
      password: encrypted,
      vcode,
      dualfactorauthinfo: { validcode: { vcode: '' }, OTP: { OTP: '' } },
      remember: false,
      device: {
        name: 'RichClient',
        description: 'RichClient for windows',
        client_type: 'windows',
        udids: [udid],
      },
    };

    const signinRes = await fetch(`${root(cfg)}/oauth2/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': jar.header(),
      },
      body: JSON.stringify(signinBody),
    });
    jar.absorb(signinRes);
    const signinText = await signinRes.text();
    let signinData;
    try { signinData = JSON.parse(signinText); } catch { signinData = { raw: signinText }; }

    const redirectUrl = signinData && (signinData.redirect || signinData.redirect_url);

    if (signinRes.ok && redirectUrl) {
      // 4) 跟随重定向直到拿到 code
      let code = null;
      let current = redirectUrl;
      for (let hop = 0; hop < 10 && current; hop++) {
        const m = /[?&]code=([^&\s]+)/.exec(current);
        if (m) { code = decodeURIComponent(m[1]); break; }
        const res = await fetch(current, { redirect: 'manual', headers: { 'Cookie': jar.header() } });
        jar.absorb(res);
        const loc = res.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).toString();
      }
      if (!code) throw new Error('未能从重定向链中提取授权码');

      // 5) 换 token
      const data = await postToken(cfg, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      applyToken(cfg, data);
      return data;
    }

    // 失败：判断是否验证码问题，可重试
    const detail = (signinData && (signinData.message || signinData.error_description || signinData.cause)) || signinText.slice(0, 200);
    lastError = new Error(`登录失败: HTTP ${signinRes.status} ${detail}`);

    const captchaProblem = /验证码|captcha|vcode/i.test(String(detail));
    if (captchaProblem && attempt < maxAttempts) {
      needCaptcha = true;
      if (opts.onRetry) opts.onRetry({ attempt, message: String(detail) });
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error('登录失败');
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
  loginWithPassword,
  loginWithCas,
  loadStrEnc,
  makeDeviceIdentity,
  fetchLoginConfigs,
  fetchCaptcha,
  captchaRequired,
  rsaEncryptPassword,
  extractChallengeAndCsrf,
  discoverPublicKey,
  ANYSHARE_RSA_PUBLIC_KEY,
  ANYSHARE_RSA_PUBLIC_KEY_1024,
};