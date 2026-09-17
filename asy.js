#!/usr/bin/env node
// AnyShare CLI (asy) —— 山大云盘 / AnyShare 命令行客户端
// 用法: node asy.js <command> [args]     或    asy <command> [args]
'use strict';

// Node 版本检查（需要 18+，依赖内置 fetch）
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`[错误] 需要 Node.js 18 或更高版本，当前为 ${process.version}`);
  console.error('请从 https://nodejs.org/ 升级后重试。');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const config = require('./lib/config');
const auth = require('./lib/auth');
const { AnyShareApi } = require('./lib/api');
const transfer = require('./lib/transfer');

const HELP = `
asy —— AnyShare / 山大云盘命令行客户端

认证
  asy register                   注册 CLI 专用 OAuth2 客户端（首次必做，自动）
  asy login                      浏览器登录（本地回调自动捕获授权码）★推荐
  asy login --cas              统一身份认证(CAS)自动登录：认证交给 CAS 的学校用这个
                                  （新设备需短信验证，登录时自动勾选「信任此设备」）
  asy login --password           学号+密码 全自动登录（适用于有本地密码的实例，可能需要图形验证码）
  asy login --account <学号> --password <密码>
                                 脚本化登录（注意：密码会进入命令行历史）
  asy login --cookie "<cookie>"  从浏览器 document.cookie 导入（备用）
  asy login --refresh-token <t>  直接给 refresh_token
  asy login --code "<url|code>"  用授权码换取 token
  asy logout                     清除本地凭据
  asy whoami                     显示当前账号信息

浏览
  asy roots                      显示账号根目录结构（首次配置用）
  asy ls [远程路径]               列目录（默认根目录）
  asy debug <api路径> [--json ..] 原始 API 调用（调试用）

操作
  asy mkdir <远程路径>            创建目录（自动补全中间层）
  asy rm <远程路径>               删除文件/目录
  asy mv <源> <目标>              移动/重命名
  asy cp <源> <目标>              复制

传输
  asy put <本地文件> <远程路径>     上传单个文件（远程以 / 结尾视为目录）
  asy get <远程路径> [本地路径]     下载单个文件
  asy push <本地目录> <远程目录>    递归上传目录
  asy pull <远程目录> <本地目录>    递归下载目录

配置
  asy config show                显示配置（token 打码）
  asy config set <键> <值>        修改配置（baseUrl/rootDocid/redirectUri/...）

选项
  --debug                        打印原始请求与响应
  --force                        强制刷新 token
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function fmtSize(n) {
  if (!n && n !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + units[i];
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

/** 隐藏输入的密码提示（不回显），跨平台 */
async function promptPassword(question) {
  if (!process.stdin.isTTY) {
    // 非交互环境（管道/重定向）直接读一行
    return await prompt(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function makeApi(cfg, opts) { return new AnyShareApi(cfg, opts); }

// ---------------------------------------------------------------- register
async function cmdRegister(args) {
  const cfg = config.load();
  if (args.flags.port) cfg.redirectUri = `http://127.0.0.1:${args.flags.port}/callback`;
  console.log('正在向服务器注册 CLI 专用 OAuth2 客户端 ...');
  const data = await auth.registerClient(cfg, {
    clientName: args.flags.name || 'asy-cli',
    redirectUri: cfg.redirectUri,
  });
  console.log('✅ 注册成功');
  console.log('  client_id     : ' + data.client_id);
  console.log('  client_secret : ' + (data.client_secret ? '（已保存到本地）' : '(未返回)'));
  console.log('  redirect_uri  : ' + cfg.redirectUri);
  console.log('\n接下来执行: asy login');
}

// ---------------------------------------------------------------- login
async function cmdLogin(args) {
  const cfg = config.load();
  const f = args.flags;

  // ── 登录态短路：已经登录成功就直接退出，不再走一遍登录流程 ──
  //   （显式提供了凭据/授权码、或加了 --force 时才强制重新登录）
  const explicitCreds = f.cookie || f['refresh-token'] || f.code ||
    typeof f.account === 'string' || typeof f.password === 'string';
  if (!explicitCreds && !args.flags.force && (cfg.refreshToken || cfg.accessToken)) {
    process.stdout.write('检测到已有登录凭据，正在校验 ... ');
    try {
      await auth.ensureFresh(cfg, { force: false });
      const { AnyShareApi } = require('./lib/api');
      const api = new AnyShareApi(cfg, { silent: true });
      const info = await api.userInfo();
      console.log('✅');
      console.log(`已经登录，无需重新登录：${info.name || cfg.rootName || ''}`);
      const left = cfg.expiresAt ? Math.round((cfg.expiresAt - Date.now()) / 60000) : null;
      if (left !== null) console.log(`当前 access_token 约 ${left} 分钟后过期，CLI 会自动续期（无需重新登录）`);
      console.log('如需强制重新登录，请加 --force');
      return;
    } catch (e) {
      console.log('凭据已失效，需要重新登录');
      if (args.flags.debug) console.error('  (' + e.message + ')');
    }
  }

  const needClient = !f.cookie && !f['refresh-token'] && !f.code;

  if (needClient && (!cfg.clientId || !cfg.clientSecret)) {
    console.log('未检测到 CLI 专用客户端，正在自动注册 ...');
    await auth.registerClient(cfg);
    console.log('✅ 已注册 client_id=' + cfg.clientId);
    console.log('   redirect_uri=' + cfg.redirectUri);
  }

  if (f.cookie) {
    const parsed = auth.parseCookieString(f.cookie);
    if (!parsed.refreshToken && !parsed.accessToken) throw new Error('没能从 cookie 里解析出 token');
    if (parsed.refreshToken) cfg.refreshToken = parsed.refreshToken;
    if (parsed.accessToken) { cfg.accessToken = parsed.accessToken; cfg.expiresAt = Date.now() + 600000; }
    if (parsed.subscriberId) cfg.subscriberId = parsed.subscriberId;
    config.save(cfg);
    console.log('✅ 凭据已保存（来源: 浏览器 cookie）');
    return verifyLogin(cfg, args);
  }

  if (f['refresh-token']) {
    cfg.refreshToken = String(f['refresh-token']).trim();
    config.save(cfg);
    console.log('✅ refresh_token 已保存');
    return verifyLogin(cfg, args);
  }

  if (f.code) {
    console.log('正在用授权码换取 token ...');
    await auth.exchangeCode(cfg, f.code);
    console.log('✅ 授权码换取成功');
    return verifyLogin(cfg, args);
  }

  // 统一身份认证（CAS）自动登录：适用于认证完全交给 CAS 的学校（如山大）
  if (f.cas) {
    let account = typeof f.account === 'string' ? f.account : '';
    let password = typeof f.password === 'string' ? f.password : '';
    if (!account) account = await prompt('学号/工号: ');
    if (!password) password = await promptPassword('密码（输入时不回显）: ');
    if (!account || !password) throw new Error('账号与密码不能为空');
    console.log('正在登录（统一身份认证 / CAS 自动登录）...');
    const smsCodeProvider = async ({ phone }) => {
      console.log(`\n⚠️ 这是一台新设备，需要短信验证：`);
      console.log(`   验证码短信已发送至: ${phone || '(绑定手机)'}`);
      console.log('   （登录成功后该设备会被「信任」，以后同一设备无需再验证）');
      return await prompt('请输入短信验证码: ');
    };
    await auth.loginWithCas(cfg, {
      account,
      password,
      smsCodeProvider,
      trustDevice: true,
      debug: args.flags.debug,
      casBase: typeof args.flags['cas-url'] === 'string' ? args.flags['cas-url'] : undefined,
    });
    console.log('✅ 登录成功，token 已保存');
    password = '';
    return verifyLogin(cfg, args);
  }

  // 无浏览器登录：学号 + 密码（服务机/无图形环境适用）
  if (f.password !== undefined || f.account) {
    let account = typeof f.account === 'string' ? f.account : '';
    let password = typeof f.password === 'string' ? f.password : '';
    if (!account) account = await prompt('学号/工号: ');
    if (!password) password = await promptPassword('密码（输入时不回显）: ');
    if (!account || !password) throw new Error('账号与密码不能为空');
    if (args.flags['discover-key']) {
      console.log('正在从登录页自动发现 RSA 公钥 ...');
      const found = await auth.discoverPublicKey(cfg);
      cfg.publicKey = found.pem;
      config.save(cfg);
      console.log(`✅ 已发现 ${found.bits} 位公钥（共 ${found.found} 把，取模数最大者）并保存到配置`);
    }
    console.log('正在登录（无浏览器模式）...');
    const captchaProvider = async ({ imageBase64, attempt }) => {
      const os = require('os');
      const imgPath = path.join(os.tmpdir(), `asy-captcha-${Date.now()}.jpg`);
      fs.writeFileSync(imgPath, Buffer.from(imageBase64, 'base64'));
      console.log(`\n该实例要求图形验证码${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}：`);
      console.log(`  验证码图片: ${imgPath}`);
      const { exec } = require('child_process');
      try {
        if (process.platform === 'win32') exec(`start "" "${imgPath}"`, () => {});
        else if (process.platform === 'darwin') exec(`open "${imgPath}"`, () => {});
        else exec(`xdg-open "${imgPath}"`, () => {});
        console.log('  （已尝试自动打开图片）');
      } catch { /* 打不开就让用户手动打开 */ }
      const code = await prompt('请输入图中的验证码: ');
      return String(code || '').trim();
    };
    await auth.loginWithPassword(cfg, {
      account,
      password,
      udid: args.flags.udid,
      captchaProvider,
      onRetry: ({ attempt, message }) => console.log(`  ⚠️ 第 ${attempt} 次失败（${String(message).slice(0, 60)}），重新获取验证码...`),
    });
    console.log('✅ 登录成功，token 已保存');
    password = '';
    return verifyLogin(cfg, args);
  }

  // 默认：本地回调服务器 + 浏览器登录
  await auth.loginWithLocalServer(cfg);
  console.log('✅ 登录成功，token 已保存');
  return verifyLogin(cfg, args);
}

async function verifyLogin(cfg, args) {
  const api = makeApi(cfg, args.flags);
  try {
    const info = await api.userInfo();
    console.log('账号信息:');
    console.log(JSON.stringify(info, null, 2).slice(0, 800));
  } catch (e) {
    console.log('⚠️ 用户信息接口失败（token 已保存）: ' + e.message);
  }
  try {
    const root = await api.resolveRootDocid();
    console.log(`根目录: ${cfg.rootName || '(未命名)'}  docid=${root}`);
  } catch (e) {
    console.log('⚠️ 根目录解析失败，请运行 asy roots 查看结构: ' + e.message);
  }
}

function cmdLogout() {
  const cfg = config.load();
  cfg.accessToken = ''; cfg.refreshToken = ''; cfg.expiresAt = 0;
  config.save(cfg);
  console.log('已清除本地凭据（client 注册信息保留）');
}

// ---------------------------------------------------------------- 浏览
async function cmdRoots(args) {
  const cfg = config.load();
  const api = makeApi(cfg, { debug: !!args.flags.debug });
  const data = await api.roots();
  console.log(JSON.stringify(data, null, 2).slice(0, 4000));
  const list = Array.isArray(data) ? data : (data && data.items) || [];
  if (list.length) {
    console.log('\n可用的根目录:');
    list.forEach((it, i) => console.log(`  [${i}] ${it.name}  docid=${it.docid || it.id}`));
    console.log('\n提示: asy config set rootDocid <docid>  可固定使用某个根目录');
  }
}

async function cmdLs(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const remote = args._[1] || '';
  const target = await api.resolvePath(remote);
  if (target.type === 'file') {
    console.log(`${target.name}  (文件, ${fmtSize(target.raw && target.raw.size)})`);
    return;
  }
  const { dirs, files } = await api.listFolder(target.docid);
  console.log(`目录: ${remote || cfg.rootName || '/'}  (${dirs.length} 子目录, ${files.length} 文件)`);
  for (const d of dirs) console.log(`  [D] ${d.name}/`);
  for (const f of files) console.log(`  [F] ${f.name}  ${fmtSize(f.size)}`);
}

async function cmdDebug(args) {
  const cfg = config.load();
  const api = makeApi(cfg, { debug: true });
  const apiPath = args._[1];
  if (!apiPath) throw new Error("用法: asy debug /efast/v1/entry-item [--json '{\"a\":1}'] [--method POST]");
  const method = (args.flags.method || 'GET').toUpperCase();
  let json;
  if (args.flags.json) json = JSON.parse(args.flags.json);
  const data = await api.call(method, apiPath, { json });
  console.log(JSON.stringify(data, null, 2).slice(0, 5000));
}

// ---------------------------------------------------------------- 操作
async function cmdMkdir(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const p = args._[1];
  if (!p) throw new Error('用法: asy mkdir <远程路径>');
  const r = await api.ensureDir(p);
  console.log(`✅ 目录就绪: ${p}  docid=${r.docid}`);
}

async function cmdRm(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const p = args._[1];
  if (!p) throw new Error('用法: asy rm <远程路径>');
  const t = await api.resolvePath(p);
  await api.remove([{ docid: t.docid, type: t.type }]);
  console.log(`✅ 已删除: ${p}`);
}

async function cmdMv(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const src = args._[1], dst = args._[2];
  if (!src || !dst) throw new Error('用法: asy mv <源> <目标>');
  const s = await api.resolvePath(src);
  const d = await api.resolvePath(dst).catch(() => null);

  // 解析目标父目录与新名字
  let destParent, newName = null;
  if (d && d.type === 'dir') { destParent = d.docid; }
  else if (d && d.parent) { destParent = d.parent; newName = path.posix.basename(dst); }
  else {
    const parentPath = path.posix.dirname(dst);
    const parent = await api.ensureDir(parentPath === '.' ? '' : parentPath);
    destParent = parent.docid;
    newName = path.posix.basename(dst);
  }

  if (destParent === s.parent) {
    // 同一目录内：直接重命名（move 接口不支持指定新名字）
    if (newName) await api.rename(s.docid, newName);
  } else {
    await api.move(s.docid, destParent, 1);
    if (newName) await api.rename(s.docid, newName);
  }
  console.log(`✅ 已移动: ${src} → ${dst}`);
}

async function cmdCp(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const src = args._[1], dst = args._[2];
  if (!src || !dst) throw new Error('用法: asy cp <源> <目标>');
  const s = await api.resolvePath(src);
  const d = await api.resolvePath(dst).catch(() => null);

  let destParent, newName = null;
  if (d && d.type === 'dir') { destParent = d.docid; }
  else if (d && d.parent) { destParent = d.parent; newName = path.posix.basename(dst); }
  else {
    const parentPath = path.posix.dirname(dst);
    const parent = await api.ensureDir(parentPath === '.' ? '' : parentPath);
    destParent = parent.docid;
    newName = path.posix.basename(dst);
  }

  // 同目录复制需 ondup=2（自动改名），随后再重命名成目标名
  const sameDir = destParent === s.parent;
  const resp = await api.copy(s.docid, destParent, sameDir ? 2 : 1);
  const created = resp && (resp.docid || resp.id || (Array.isArray(resp) && resp[0] && (resp[0].docid || resp[0].id)));
  if (newName && created) {
    try { await api.rename(created, newName); }
    catch (e) { console.log('⚠️ 复制成功但重命名失败（副本可能是自动生成的名字）: ' + e.message); }
  }
  console.log(`✅ 已复制: ${src} → ${dst}`);
}

// ---------------------------------------------------------------- 传输
async function cmdPut(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const local = args._[1];
  const remote = args._[2] || (local && path.basename(local)) || '';
  if (!local) throw new Error('用法: asy put <本地文件> <远程路径>');
  if (!fs.existsSync(local)) throw new Error('本地文件不存在: ' + local);

  let folderDocid, remoteName;
  if (remote === '' || /\/$/.test(remote)) {
    const dir = await api.ensureDir(remote);
    folderDocid = dir.docid;
    remoteName = path.basename(local);
  } else {
    const dirPath = path.posix.dirname(remote);
    const dir = await api.ensureDir(dirPath === '.' ? '' : dirPath);
    folderDocid = dir.docid;
    remoteName = path.posix.basename(remote);
  }
  const r = await transfer.uploadFile(api, local, folderDocid, remoteName, { ondup: Number(args.flags.ondup || 1) });
  console.log(`✅ 已上传: ${local} → ${remote}  (${fmtSize(r.size)})`);
}

async function cmdGet(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const remote = args._[1];
  if (!remote) throw new Error('用法: asy get <远程路径> [本地路径]');
  const t = await api.resolvePath(remote);
  if (t.type !== 'file') throw new Error('目标不是文件: ' + remote);
  let out = args._[2] || t.name;
  if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, t.name);
  const r = await transfer.downloadFile(api, t.docid, t.name, out, t.raw && t.raw.rev);
  console.log(`✅ 已下载: ${remote} → ${out}  (${fmtSize(r.size)})`);
}

async function cmdPush(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const localDir = args._[1], remoteDir = args._[2];
  if (!localDir || !fs.existsSync(localDir)) throw new Error('本地目录不存在: ' + localDir);
  const root = await api.ensureDir(remoteDir || '');
  let count = 0, bytes = 0;

  async function walk(local, remoteDocid, rel) {
    for (const ent of fs.readdirSync(local, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const lp = path.join(local, ent.name);
      if (ent.isDirectory()) {
        const { dirs } = await api.listFolder(remoteDocid);
        const hit = dirs.find((d) => d.name === ent.name);
        const sub = hit ? (hit.docid || hit.id) : await api.mkdir(remoteDocid, ent.name);
        await walk(lp, sub, rel + ent.name + '/');
      } else if (ent.isFile()) {
        const size = fs.statSync(lp).size;
        await transfer.uploadFile(api, lp, remoteDocid, ent.name, { ondup: 1 });
        count++; bytes += size;
        console.log(`  ↑ ${rel}${ent.name}  (${fmtSize(size)})`);
      }
    }
  }
  await walk(localDir, root.docid, '');
  console.log(`✅ 递归上传完成: ${count} 个文件, ${fmtSize(bytes)}`);
}

async function cmdPull(args) {
  const cfg = config.load();
  const api = makeApi(cfg, args.flags);
  const remoteDir = args._[1], localDir = args._[2];
  if (!remoteDir) throw new Error('用法: asy pull <远程目录> <本地目录>');
  const outRoot = localDir || '.';
  const target = await api.resolvePath(remoteDir);
  let count = 0, bytes = 0;

  async function walk(docid, localPath) {
    if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });
    const { dirs, files } = await api.listFolder(docid);
    for (const f of files) {
      if (String(f.name).startsWith('.')) continue;
      const out = path.join(localPath, f.name);
      const r = await transfer.downloadFile(api, f.docid || f.id, f.name, out, f.rev);
      count++; bytes += r.size || 0;
      console.log(`  ↓ ${out}  (${fmtSize(r.size)})`);
    }
    for (const d of dirs) await walk(d.docid || d.id, path.join(localPath, d.name));
  }
  await walk(target.docid, outRoot);
  console.log(`✅ 递归下载完成: ${count} 个文件, ${fmtSize(bytes)}`);
}

// ---------------------------------------------------------------- config
function cmdConfig(args) {
  const cfg = config.load();
  const sub = args._[1];
  const mask = (s) => (s ? String(s).slice(0, 8) + '...(' + String(s).length + ')' : '');
  if (sub === 'show' || !sub) {
    const view = { ...cfg };
    view.accessToken = mask(cfg.accessToken);
    view.refreshToken = mask(cfg.refreshToken);
    view.clientSecret = mask(cfg.clientSecret);
    console.log('配置文件: ' + config.CONFIG_FILE);
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (sub === 'set') {
    const key = args._[2], value = args._[3];
    if (!key) throw new Error('用法: asy config set <键> <值>');
    if (!(key in config.DEFAULTS)) throw new Error('未知配置键: ' + key + '\n可用: ' + Object.keys(config.DEFAULTS).join(', '));
    cfg[key] = key === 'expiresAt' ? Number(value) : value;
    config.save(cfg);
    console.log(`✅ ${key} = ${/Token|Secret/.test(key) ? mask(value) : value}`);
    return;
  }
  throw new Error('用法: asy config [show|set <键> <值>]');
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.flags.help) { console.log(HELP); return; }

  const table = {
    register: cmdRegister,
    login: cmdLogin,
    logout: () => cmdLogout(),
    whoami: async (a) => {
      const cfg = config.load();
      const api = makeApi(cfg, { debug: !!a.flags.debug });
      console.log(JSON.stringify(await api.userInfo(), null, 2));
    },
    roots: cmdRoots,
    ls: cmdLs,
    debug: cmdDebug,
    mkdir: cmdMkdir,
    rm: cmdRm,
    mv: cmdMv,
    cp: cmdCp,
    put: cmdPut,
    get: cmdGet,
    push: cmdPush,
    pull: cmdPull,
    config: (a) => cmdConfig(a),
  };

  const fn = table[cmd];
  if (!fn) { console.error(`未知命令: ${cmd}\n`); console.log(HELP); process.exitCode = 2; return; }
  await fn(args);
}

main().catch((e) => {
  console.error('\n❌ ' + (e && e.message ? e.message : e));
  if (process.env.ASY_TRACE) console.error(e.stack);
  process.exitCode = 1;
});