// AnyShare CLI - 配置与 token 存储
// 配置位置: ~/.anyshare-cli/config.json
const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置目录：默认 ~/.anyshare-cli，可用环境变量 ASY_CONFIG_DIR 覆盖（便于服务机/容器部署）
const CONFIG_DIR = process.env.ASY_CONFIG_DIR
  ? path.resolve(process.env.ASY_CONFIG_DIR)
  : path.join(os.homedir(), '.anyshare-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// 山东大学云盘实例参数（已实测确认）
const DEFAULTS = {
  baseUrl: 'https://icloud.sdu.edu.cn',
  // 下面两个由 `asy register` 动态注册得到（每个部署/每次注册都不同）
  clientId: '',
  clientSecret: '',
  redirectUri: 'http://127.0.0.1:8899/callback',
  scope: 'offline openid all',
  // 根目录（个人文档）docid —— 首次运行 `asy roots` 后可用 `asy config set rootDocid <id>` 固定
  rootDocid: '',
  rootName: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  subscriberId: '',
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, raw);
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

module.exports = { load, save, CONFIG_FILE, CONFIG_DIR, DEFAULTS };