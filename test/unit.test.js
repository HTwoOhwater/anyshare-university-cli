// 单元测试：纯函数（无需网络/凭据）
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const auth = require('../lib/auth');
const { AnyShareApi } = require('../lib/api');
const { parseAuthEntries } = require('../lib/transfer');

function validConfig() {
  return {
    baseUrl: 'https://example.edu.cn',
    accessToken: 'test-token',
    expiresAt: Date.now() + 120000,
  };
}

test('parseCookieString: 解析 refresh_token / Authorization / subscriber-id', () => {
  const cookies = 'Authorization=Bearer abc.def.ghi; client.oauth2_refresh_token=eyJhbGciOi.refresh-part; x-subscriber-id=uuid-1234';
  const r = auth.parseCookieString(cookies);
  assert.strictEqual(r.accessToken, 'abc.def.ghi');
  assert.strictEqual(r.refreshToken, 'eyJhbGciOi.refresh-part');
  assert.strictEqual(r.subscriberId, 'uuid-1234');
});

test('parseCookieString: URL 编码的 cookie 值会被解码', () => {
  const r = auth.parseCookieString('client.oauth2_refresh_token=a%2Bb%3Dc');
  assert.strictEqual(r.refreshToken, 'a+b=c');
});

test('parseCookieString: 空输入不抛错', () => {
  const r = auth.parseCookieString('');
  assert.deepStrictEqual(Object.keys(r).length, 0);
});

test('内置公钥为 2048 位（signin 用的是这把，用错会报 RSA_private_decrypt error）', () => {
  const key = crypto.createPublicKey(auth.ANYSHARE_RSA_PUBLIC_KEY);
  assert.strictEqual(key.asymmetricKeyType, 'rsa');
  assert.strictEqual(key.asymmetricKeyDetails.modulusLength, 2048);
});

test('备用 1024 位公钥可解析（短信验证码接口用）', () => {
  const key = crypto.createPublicKey(auth.ANYSHARE_RSA_PUBLIC_KEY_1024);
  assert.strictEqual(key.asymmetricKeyDetails.modulusLength, 1024);
});

test('rsaEncryptPassword: PKCS#1 v1.5 加密后 base64，2048 位密钥产出 256 字节', () => {
  const enc = auth.rsaEncryptPassword('hello-world');
  assert.strictEqual(Buffer.from(enc, 'base64').length, 256);
  // 相同输入两次结果不同（PKCS#1 v1.5 随机填充）
  assert.notStrictEqual(enc, auth.rsaEncryptPassword('hello-world'));
});

test('rsaEncryptPassword: 可显式传入自定义公钥', () => {
  const enc = auth.rsaEncryptPassword('x', auth.ANYSHARE_RSA_PUBLIC_KEY_1024);
  assert.strictEqual(Buffer.from(enc, 'base64').length, 128); // 1024 位 → 128 字节
});

test('extractChallengeAndCsrf: 从登录页文本提取 challenge / csrftoken', () => {
  const html = 'window.__DATA__={"challenge":"deadbeefcafe","csrftoken":"tok-123456"};';
  const r = auth.extractChallengeAndCsrf(html);
  assert.strictEqual(r.challenge, 'deadbeefcafe');
  assert.strictEqual(r.csrf, 'tok-123456');
});

test('extractChallengeAndCsrf: 缺少字段时明确报错', () => {
  assert.throws(() => auth.extractChallengeAndCsrf('<html>no data</html>'), /challenge/);
});

test('parseAuthEntries: 解析 S3 签名头（下载必需）', () => {
  const entries = [
    'Authorization: AWS as01:5E7MztgIngc9vObz3Oiiivmcekk=',
    'x-amz-date: Wed, 16 Sep 2026 12:22:20 GMT',
  ];
  const { headers } = parseAuthEntries(entries, 'GET');
  assert.strictEqual(headers['Authorization'], 'AWS as01:5E7MztgIngc9vObz3Oiiivmcekk=');
  assert.strictEqual(headers['x-amz-date'], 'Wed, 16 Sep 2026 12:22:20 GMT');
});

test('parseAuthEntries: POST 时 field=value 归入表单字段', () => {
  const { headers, form } = parseAuthEntries(['Content-Type: application/octet-stream', 'file=abc'], 'POST');
  assert.strictEqual(headers['Content-Type'], 'application/octet-stream');
  assert.strictEqual(form['file'], 'abc');
});

test('config: 默认值齐全且 baseUrl 指向山大实例', () => {
  const { DEFAULTS } = require('../lib/config');
  for (const k of ['baseUrl', 'clientId', 'clientSecret', 'redirectUri', 'scope']) {
    assert.ok(k in DEFAULTS, `缺少配置项 ${k}`);
  }
  assert.match(DEFAULTS.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
});

test('config: ASY_CONFIG_DIR 可覆盖配置目录', () => {
  const path = require('node:path');
  const os = require('node:os');
  const dir = path.join(os.tmpdir(), 'asy-cfg-probe');
  process.env.ASY_CONFIG_DIR = dir;
  delete require.cache[require.resolve('../lib/config')];
  const cfg = require('../lib/config');
  assert.strictEqual(cfg.CONFIG_DIR, path.resolve(dir));
  delete process.env.ASY_CONFIG_DIR;
  delete require.cache[require.resolve('../lib/config')];
});

test('buildAuthorizeUrl: 使用配置的 client_id / redirect_uri，state ≥ 8 字符', () => {
  const cfg = { baseUrl: 'https://example.edu.cn', clientId: 'cid-123', redirectUri: 'http://127.0.0.1:8899/callback', scope: 'offline openid all' };
  const { url, state } = auth.buildAuthorizeUrl(cfg);
  const u = new URL(url);
  assert.strictEqual(u.pathname, '/oauth2/auth');
  assert.strictEqual(u.searchParams.get('client_id'), 'cid-123');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8899/callback');
  assert.ok(state.length >= 8, 'state 必须 ≥ 8 字符，否则服务端返回 invalid_state');
});

test('AnyShareApi: 挂起请求在截止时间后中止并返回可识别的 504', async () => {
  let aborted = false;
  const fakeFetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const api = new AnyShareApi(validConfig(), { timeoutMs: 20, fetch: fakeFetch });

  await assert.rejects(
    api.call('GET', '/slow'),
    (error) => error.status === 504 && error.data.code === 'ASY_REQUEST_TIMEOUT'
  );
  assert.strictEqual(aborted, true);
});

test('AnyShareApi: 网络错误转换为可识别的 503 且不泄露 token', async () => {
  const api = new AnyShareApi(validConfig(), {
    fetch: async () => { throw new TypeError('fetch failed'); },
  });

  await assert.rejects(api.call('GET', '/broken'), (error) => {
    assert.strictEqual(error.status, 503);
    assert.strictEqual(error.data.code, 'ASY_NETWORK_ERROR');
    assert.doesNotMatch(error.message, /test-token/);
    return true;
  });
});
