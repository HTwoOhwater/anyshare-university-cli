# AnyShare 高校网盘 CLI 客户端

[![CI](https://github.com/HTwoOhwater/anyshare-university-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/HTwoOhwater/anyshare-university-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> 不依赖官方客户端，**直接用 HTTP API** 操作高校 AnyShare 网盘（爱数文档云）的命令行工具。
> 支持列目录、上传、下载、复制、移动、删除、递归同步 —— **纯 Node.js，零第三方依赖**。

**当前适配：山东大学** `icloud.sdu.edu.cn` ✅（全功能实测通过）

---

## 📢 招募高校开发者

本项目的 API 逆向、认证流程、传输适配**都只针对山东大学实例验证过**。
AnyShare 是通用产品，**多数高校的网盘大概率是同一套架构**，理论上改个 `baseUrl` 就能用，
但我没有其他学校的账号，无法验证。

**热烈欢迎各高校的同学加入开发 / 反馈适配结果：**

- 🎓 你学校也是 AnyShare（网页 HTML 里能看到 `__anyshare`）？跑一遍下面的「快速开始」，
  把结果发到 [Issues](https://github.com/HTwoOhwater/anyshare-university-cli/issues)，
  或直接 PR 更新适配列表
- 🔧 适配过程中可能需要微调 `baseUrl` / API 前缀 / 客户端注册可用性
  → 详见 **[docs/API-notes.md](docs/API-notes.md)** 的「如何适配你的学校」一节
-  已适配高校列表（欢迎补充）：

| 学校 | 实例地址 | 状态 | 贡献者 |
|---|---|---|---|
| 山东大学 | `icloud.sdu.edu.cn` | ✅ 全功能通过 | 项目作者 |
| *你的学校* | — | 期待你的 PR | — |

## ✨ 特性

- **无需官方客户端**：不需要安装 AnyShare 桌面版
  （顺带解决了官方客户端 `winhook64.dll` 全局注入导致 Obsidian 等软件崩溃的问题）
- **两种登录方式**：
  - 浏览器登录（推荐）：动态注册 OAuth2 客户端 + 本地回调服务器自动捕获授权码
  - **无浏览器登录**：学号 + 密码全自动（RSA 加密），适合**服务器/无图形环境无人值守**
- **跨平台**：Windows / Linux / macOS 都能跑（纯 HTTP + Node.js）
- **token 自动续期**：access_token 过期自动用 refresh_token 刷新
- **流式传输**：上传下载不占内存，大文件也稳
- **完全可控**：没有"自动下载把删除拉回来"这类隐藏策略，行为由你决定
- **可脚本化**：递归上传/下载，适合做定时冷备份
- **零依赖**：只用 Node 内置模块，`npm install` 不需要拉任何第三方包
- **有测试与 CI**：20 项单元/冒烟测试，GitHub Actions 三平台三版本矩阵

## 📦 安装

需要 **Node.js 18+**（用到内置 fetch）。

**方式 1：npm 全局安装（推荐）**

```bash
npm install -g anyshare-university-cli
asy --help
```

**方式 2：克隆仓库直接用**

```bash
git clone https://github.com/HTwoOhwater/anyshare-university-cli.git
cd anyshare-university-cli
node asy.js --help
# Linux/macOS 也可以：chmod +x asy && ./asy --help
```

**方式 3：Windows 便捷启动**

```bat
asy.bat --help
```

##  快速开始

```bash
# ① 登录（首次会自动注册 CLI 专用 OAuth2 客户端）

# 方式 A：浏览器登录（推荐，最省心；会打开浏览器完成统一身份认证）
asy login

# 方式 B：无浏览器登录（服务器/无图形环境，全命令行）
asy login --password            # 交互式输入学号 + 密码（密码不回显）

# ② 看看你的网盘
asy ls
asy ls /WebDAV/SyncDisk

# ③ 常用操作
asy put  D:\paper.pdf /文献/            # 上传
asy get  /文献/paper.pdf D:\paper.pdf   # 下载
asy mkdir /备份/2026
asy cp   /文献/a.pdf /文献/b.pdf
asy mv   /文献/b.pdf /文献/c.pdf
asy rm   /文献/old.pdf

# ④ 递归同步（备份场景）
asy push D:\MyFolder /WebDAV/Backup/MyFolder
asy pull /WebDAV/Backup/MyFolder D:\Restore
```

### 无人值守示例（cron / 计划任务）

```bash
# 一次性登录后 token 会自动续期，后续脚本无需再登录
asy login --password
# 每天凌晨 3 点打包上传
0 3 * * * cd /srv/backup && tar czf data-$(date +\%F).tgz data/ && asy put data-$(date +\%F).tgz /WebDAV/Backup/
```

## 📖 命令一览

| 命令 | 说明 |
|---|---|
| `register` | 注册 CLI 专用 OAuth2 客户端（`login` 会自动执行） |
| `login` | 浏览器登录（本地回调自动捕获授权码）★推荐 |
| `login --password` | **无浏览器登录**：学号+密码（RSA 加密），适合服务机 |
| `login --password --discover-key` | 自动从登录页发现该校 RSA 公钥（新学校适配用） |
| `login --account <学号> --password <密码>` | 脚本化登录（注意密码会进命令行历史） |
| `login --cookie "<c>"` | 从浏览器 Cookie 导入（备用方式） |
| `login --refresh-token <t>` | 直接用 refresh_token 登录 |
| `login --code "<url\|code>"` | 用授权码换取 token |
| `logout` / `whoami` | 登出 / 查看账号信息 |
| `roots` | 显示文档库结构（个人文档 / 共享文档） |
| `ls [路径]` | 列目录（默认个人文档根） |
| `mkdir` / `rm` / `mv` / `cp` | 目录与文件操作 |
| `put <本地> <远程>` | 上传文件（远程以 `/` 结尾视为目录） |
| `get <远程> [本地]` | 下载文件 |
| `push <本地目录> <远程目录>` | 递归上传 |
| `pull <远程目录> <本地目录>` | 递归下载 |
| `debug <api路径>` | 原始 API 调用（适配新学校时很有用） |
| `config show` / `config set k v` | 查看 / 修改配置 |

**全局选项**：`--debug`（打印原始请求响应）、`--force`（强制刷新 token）、`--ondup N`（重名策略）

## ⚙️ 配置

配置保存在 `~/.anyshare-cli/config.json`（权限 600），可用环境变量 `ASY_CONFIG_DIR` 改变位置：

```json
{
  "baseUrl": "https://icloud.sdu.edu.cn",
  "clientId": "<注册得到>",
  "clientSecret": "<注册得到>",
  "redirectUri": "http://127.0.0.1:8899/callback",
  "rootDocid": "gns://...",
  "rootName": "某某(学号)",
  "refreshToken": "...",
  "accessToken": "..."
}
```

换学校 / 换实例：

```bash
asy config set baseUrl https://your-university.edu.cn
asy register        # 在该实例上注册新客户端
asy login
```

## 🔍 工作原理（简述）

```
① POST /oauth2/clients                    注册自己的 OAuth2 客户端（含本地回调地址）
② 获取授权码（两种方式任选其一）
   A. 浏览器登录：/oauth2/auth → 统一身份认证 → 授权码回调到 127.0.0.1:8899/callback
      （CLI 起本地服务器自动接收，不需要手动复制）
   B. 无浏览器登录：GET /oauth2/auth 取登录页 → 提取 challenge / csrftoken
      → 用 2048 位 RSA 公钥加密密码 → POST /oauth2/signin（需带会话 Cookie）
      → 跟随 redirect 直到 Location 里出现 code=（无需真的监听端口）
③ POST /oauth2/token (client_secret_basic) 换取 access_token + refresh_token
④ Authorization: Bearer <token>           调用 /api/efast/v1/... 操作文件
⑤ 文件正文走对象存储直链（带 S3 签名头）     上传/下载
```

> ⚠️ **踩坑提醒**：登录页里嵌了**两把** RSA 公钥——**2048 位那把**用于 `/oauth2/signin`，
> 1024 位那把只用于短信验证码接口。用错会得到 `RSA_private_decrypt error`。

详细的接口清单、请求体格式、以及**踩过的坑**（外链接口与用户会话接口的区别、
`limit` 必填、`ondup` 语义、下载签名头、`client_secret_basic` 限制等）
都在 **[docs/API-notes.md](docs/API-notes.md)**。

## 🗺️ Roadmap

- [ ] 更多高校实例适配（**期待你的 PR！**）
- [ ] 大文件分片上传（`osinitmultiupload` / `osuploadpart` / `oscompleteupload`）
- [ ] `sync` 双向同步（哈希比对 + 冲突处理）
- [ ] `backup` 打包压缩 + 保留 N 份 + 定时任务
- [ ] 作为 WebDAV 网关的后端（替代官方客户端）

## 🔗 同类项目

高校 AnyShare 生态里已经有不少同学在做类似的事，推荐关注 / 互相借鉴：

| 项目 | 学校 | 语言 | 特点 |
|---|---|---|---|
| **[Fucov/Pansh](https://github.com/Fucov/Pansh)** | 北航（bhpan） | Python | 交互式 shell、多 profile、凭据加密、断点续传、完整 CI/发布流程，已上 PyPI |
| **[LYOfficial/AnyshareCLI](https://github.com/LYOfficial/AnyshareCLI)** | 北科大（ustb） | Python | 外链分享场景的 CLI，上传/下载实现简洁清晰 |
| **本项目** | 山东大学 | Node.js | 动态注册 OAuth2 客户端（不硬编码凭据）、本地回调登录、递归同步、零依赖 |

各家实现思路不同，**欢迎一起交流接口细节**——AnyShare 的 API 结构是通用的，
把「学校差异」抽出来之后，各校同学只需要补一份实例配置。

## 👨‍💻 开发

```bash
git clone https://github.com/HTwoOhwater/anyshare-university-cli.git
cd anyshare-university-cli

npm run check     # 语法检查（全部 .js）
npm test          # 单元测试 + CLI 冒烟测试（20 项，离线运行，不需要凭据）

node asy.js help  # 直接运行
```

测试使用 Node 内置的 `node:test`，**不需要安装任何依赖**。CI 在
Ubuntu / Windows / macOS + Node 18/20/22 六种组合上运行（见 `.github/workflows/ci.yml`）。

贡献方向见 [Roadmap](#️-roadmap) 与 [docs/API-notes.md](docs/API-notes.md) 的「如何适配你的学校」。

## 🙏 致谢

- [Fucov/Pansh](https://github.com/Fucov/Pansh) —— 同类项目（北航），其「学号+密码 无浏览器登录」思路
  启发了本项目的 headless 登录模式
- [LYOfficial/AnyshareCLI](https://github.com/LYOfficial/AnyshareCLI) —— 外链分享场景的 Python 实现，
  本项目在其基础上扩展出「登录用户完整访问」的路径，并验证了上传/下载的完整链路
- ORY Hydra、爱数 AnyShare（仅作为被逆向分析的对象，无任何官方关联）

## ️ 免责声明

- 本项目**非官方工具**，与爱数（AIShu）及任何高校均无关联
- 仅供**个人学习与合法的个人数据管理**使用；请遵守所在学校的服务条款与网络安全规定
- 请勿用于高频轮询、批量抓取、规避配额等滥用行为
- 使用本工具产生的任何后果由使用者自行承担
- 登录凭据保存在本地 `~/.anyshare-cli/config.json`，**请勿泄露或提交到仓库**

## 📄 License

[MIT](LICENSE)