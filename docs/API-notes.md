# AnyShare API 逆向笔记 & 其他高校适配指南

本文记录 **AnyShare（爱数文档云）** 的 HTTP API 结构，以及如何把它适配到**其他高校的 AnyShare 实例**。
所有结论均在 **山东大学 `icloud.sdu.edu.cn`（AnyShare 7.0.6）** 上实测验证。

> ⚠️ 本文是逆向分析的产物，非官方文档。接口可能随部署版本变化，请以实测为准。

---

## 一、整体架构

AnyShare 7 的部署形态（各高校基本一致）：

```
┌────────────┐   443/HTTPS   ┌──────────────────────────────────────────┐
│  Web 前端   │ ────────────▶ │  nginx 网关                              │
│ (React SPA)│               │   ├─ /anyshare/*    前端 SPA（含兜底）    │
└────────────┘               │   ├─ /api/*         业务 API（EFS/EACP…） │
┌────────────┐               │   ├─ /oauth2/*      OAuth2 服务(ORY Hydra)│
│ 桌面客户端  │ ────────────▶ │   └─ /bucket0x/*    对象存储(Ceph RGW/S3) │
│ (Electron) │               └──────────────────────────────────────────
└────────────┘
```

**要点**：
- 前端是 React SPA，路径前缀通常是 `/anyshare/`，**但 API 在根路径 `/api/`**
  （`/anyshare/api/...` 会被 SPA 兜底返回 HTML，是常见陷阱）
- OAuth2 由 **ORY Hydra** 提供（`login_challenge` 参数是其标志）
- 文件正文不经过业务 API，而是由 API 下发**带签名的对象存储直链**（S3 兼容）

## 二、认证

### 2.1 客户端注册（关键！）

AnyShare **桌面客户端/网页端都是动态注册自己的 OAuth2 客户端**的（所以代码里没有硬编码 secret）。
我们也可以注册一个属于自己的客户端：

```http
POST {baseUrl}/oauth2/clients
Content-Type: application/json

{
  "grant_types": ["authorization_code", "refresh_token", "implicit"],
  "response_types": ["token id_token", "code", "token"],
  "scope": "offline openid all",
  "redirect_uris": ["http://127.0.0.1:8899/callback"],     ← 填自己的回调！
  "post_logout_redirect_uris": ["http://127.0.0.1:8899/logout"],
  "client_name": "asy-cli",
  "metadata": {
    "device": {
      "name": "RichClient",
      "client_type": "windows",       ← 枚举：unknown/ios/android/windows_phone/windows/mac_os/web/mobile_web/console_web/deploy_web/linux
      "description": "asy-cli"
    }
  },
  "login_form": { "remember_password_visible": true }
}
```

成功返回 `201`：

```json
{ "client_id": "b538b5ac-...", "client_secret": "_bsG69hl..." }
```

> 💡 把 `redirect_uris` 填成 `http://127.0.0.1:<端口>/callback`，
> 就能在 CLI 里起一个本地 HTTP 服务器**自动接收授权码**，无需手动复制回调 URL。

### 2.2 授权（浏览器 + 统一身份认证）

```http
GET {baseUrl}/oauth2/auth
      ?client_id=<刚注册的>
      &response_type=code
      &scope=offline+openid+all
      &redirect_uri=http://127.0.0.1:8899/callback
      &state=<至少8个字符，否则报 invalid_state>
      &lang=zh-cn
```

跳转链：`/oauth2/auth` → `302 /oauth2/signin?login_challenge=...` → **统一身份认证(CAS)** → 回调带 `?code=`

### 2.3 换取 token（必须 client_secret_basic）

```http
POST {baseUrl}/oauth2/token
Authorization: Basic base64(client_id:client_secret)      ← 只能用 Basic！
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<授权码>&redirect_uri=<注册时的>
```

返回 `{ access_token, refresh_token, id_token, expires_in, token_type, scope }`

刷新：

```http
POST {baseUrl}/oauth2/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<...>
```

**踩坑记录**：
- 在 body 里传 `client_secret`（`client_secret_post`）会报
  `invalid_client ... supports client_secret_basic, but method client_secret_post was requested`
- `redirect_uri` 必须与注册时**逐字符一致**
- `/oauth2/auth` 只接受 **GET**（HEAD 会 405）
- `state` 少于 8 字符会被拒（`invalid_state`）

### 2.4 调用 API

```http
Authorization: Bearer <access_token>
X-Requested-With: XMLHttpRequest
```

未认证时返回：

```json
{"cause":"access token校验失败...","code":401001001,"message":"Access Token无效或已过期。"}
```

`401001001` = token 过期 → 用 refresh_token 换新的。

## 三、文件 API（`/api/efast/v1/...`）—— 已全部实测

| 用途 | 方法 & 路径 | 请求体 |
|---|---|---|
| 用户信息 | `GET /api/eacp/v1/user/get` | — |
| **个人文档根** | `GET /api/efast/v1/classified-entry-doc-libs` | — （取 `type=user_doc_lib`） |
| 共享文档库 | `GET /api/efast/v1/entry-doc-lib` | — |
| 列目录 | `GET /api/efast/v1/folders/{docid}/sub_objects?limit=N&sort=name&direction=asc` | — （**limit 必填**） |
| 新建目录 | `POST /api/efast/v1/dir/create` | `{docid:父, name, ondup:1}` |
| 删除文件 | `POST /api/efast/v1/file/delete` | `{docid}` |
| 删除目录 | `POST /api/efast/v1/dir/delete` | `{docid, check_upload_process:false}` |
| 重命名 | `POST /api/efast/v1/file/rename` | `{docid, name, ondup}`（**目录也走 file/rename**） |
| 移动 | `POST /api/efast/v1/file/move` | `{docid, destparent, ondup}` |
| 复制 | `POST /api/efast/v1/file/copy` | `{docid, destparent, ondup}` |
| 下载 | `POST /api/efast/v1/file/osdownload` | `{docid, authtype:"1", savename, usehttps:true, rev?}` |
| 上传-开始 | `POST /api/efast/v1/file/osbeginupload` | `{client_mtime, docid:目标目录, length, name, ondup, reqmethod:"POST"}` |
| 上传-结束 | `POST /api/efast/v1/file/osendupload` | `{docid, rev, csflevel}` |
| 分片上传 | `osinitmultiupload` / `osuploadpart` / `oscompleteupload` | 大文件用（本 CLI 暂未实现） |

**踩坑记录**：
- 用户会话下 **不要用 `/efast/v1/entry-item`** —— 那是外链分享场景的接口，
  会返回 `403 不支持的用户类型（错误提供者：EFSHttpServer，错误值：1809）`
- 删除/重命名/移动/复制都只接受**单个 `docid` 字符串**（不是数组）
- `copy` / `move` **不能指定新名字**（只有 `docid` + `destparent` + `ondup`）：
  同目录操作要用 `ondup=2`（自动改名），再单独调 `rename` 改成想要的名字
- 目录与文件在 `sub_objects` 里通过 `size === -1`（目录）区分；`id` 是完整 GNS 路径
  （形如 `gns://<doclib>/<folder>/<file>`）

## 四、文件传输（对象存储直链 + 签名头）

### 下载

`osdownload` 返回：

```json
{
  "authrequest": [
    "GET",
    "https://<host>:443/bucket02/<...>/<rev>",
    "Authorization: AWS as01:<签名>",          ← 必须原样携带！
    "x-amz-date: Wed, 16 Sep 2026 12:22:20 GMT" ← 必须原样携带！
  ]
}
```

- 不带签名头 → `403 RequestTimeTooSkewed`（`client date time:0`）
- 用自己的时间头 → `403 AccessDenied can not found "authorization" or "Signature"`
- ✅ 正确做法：把 `authrequest[2:]` 里的条目解析成请求头，**原样发送**

### 上传

`osbeginupload` 同样返回 `authrequest`，格式为 `[method, url, ...entries]`，其中 entry 可能是
`"Header: value"` 或 `"field=value"`：

- `method = PUT` → 直接把文件流 PUT 上去，带解析出的头
- `method = POST` → `multipart/form-data`，**文件字段名固定为 `file`**，其余条目作为表单字段

上传完成后必须调 `osendupload`（带 `docid`/`rev`/`csflevel`）收尾，否则文件不落库。

## 五、如何适配你的学校（欢迎 PR！）

AnyShare 是通用产品，**大概率你学校的网盘也是同一套架构**。适配步骤：

### 第 1 步：确认底座

```bash
# 打开你的网盘网页，看 HTML 里有没有这些特征：
#   id="__anyshare" / webpackJsonp@anyshare/web   → 是 AnyShare
curl -s https://<你的网盘域名>/anyshare/ | grep -o '__anyshare'
```

### 第 2 步：找到 API 根与前端前缀

```bash
# 前端前缀（通常是 /anyshare/ 或空）
curl -sI https://<域名>/ | grep -i location

# API 根：这个应该返回 401（存在但需认证），返回 404/503 说明路径不对
curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/api/efast/v1/classified-entry-doc-libs

# 有些部署把 API 放在 /anyshare/api/ 或其他前缀下，逐个试
```

### 第 3 步：注册你的 OAuth2 客户端

```bash
# 注意：路径是根路径 /oauth2/clients（不带 /api）
curl -s -X POST https://<域名>/oauth2/clients \
  -H 'Content-Type: application/json' \
  -d @register-client.json      # 见仓库内 templates/register-client.json
```

- 返回 201 + `client_id`/`client_secret` → 完美，直接用本 CLI
- 返回 404/403 → 该部署**未开放客户端注册**，退路见第 5 步

### 第 4 步：跑通并回填配置

```bash
asy register --port 8899     # 或手动改 config.json 的 baseUrl
asy login
asy ls
```

### 第 5 步：如果注册接口被关闭

可选方案（欢迎实现后 PR）：

1. **复用官方客户端的已注册凭据**：桌面客户端首次连接服务器时会注册并保存
   `client_id`/`client_secret` 到本地配置
   （Windows：`%APPDATA%\<品牌名>\config.json` 的 `lastConnectedDomain` 字段）。
   缺点：其 `redirect_uris` 是 `anyshare://...` 私有协议，授权码回调不好接。
2. **从浏览器 Cookie 导入 refresh_token**：网页端把 token 放在 Cookie 里
   （`client.oauth2_refresh_token`、`Authorization=Bearer ...`）。
   `asy login --cookie "<从 DevTools 复制的 document.cookie>"` 即可。
   但用官方 client 的 refresh_token 去刷新同样需要它的 secret。
3. **模拟 CAS 登录**（全自动但易碎）：直接 POST 统一身份认证表单，跟随重定向拿 Cookie。

### 各高校可能有差异的地方

| 可能不同 | 说明 | 本 CLI 的应对 |
|---|---|---|
| `baseUrl` | 各校域名/端口不同 | `asy config set baseUrl <...>` 或 `ASY_BASE_URL` |
| 前端前缀 | 可能不是 `/anyshare` | 仅影响浏览器登录地址，API 路径一般不变 |
| API 根 | 极少数部署改过 | `asy debug` 逐条试 |
| 登录方式 | 多数走 CAS，少数可能本地账号 | 浏览器流程均适用 |
| 对象存储 | Ceph RGW / 其他 S3 兼容 | 已按 `authrequest` 通用解析，一般不敏感 |
| 客户端注册 | 可能被管理员关闭 | 见第 5 步 |

## 六、调试工具

本 CLI 内置原始请求调试：

```bash
asy debug /efast/v1/classified-entry-doc-libs
asy debug /efast/v1/file/osdownload --method POST --json '{"docid":"...","authtype":"1","savename":"a.txt","usehttps":true}'
asy --debug ls          # 所有命令都支持 --debug
```

## 七、免责声明

本文与仓库代码仅用于**个人学习与合法的个人数据管理**。请遵守所在学校的
服务条款与网络安全规定，不要用于高频轮询、批量抓取或任何滥用行为。