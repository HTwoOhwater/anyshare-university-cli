// AnyShare CLI - API 客户端（/api/efast/v1/... 等）
const auth = require('./auth');
const config = require('./config');

const TOKEN_EXPIRE_CODE = 401001001; // RequestErrorCode.TokenExpire

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

class AnyShareApi {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.debug = !!opts.debug;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
    this.fetch = opts.fetch || globalThis.fetch;
    this.baseApi = cfg.baseUrl.replace(/\/+$/, '') + '/api';
  }

  async request(url, init, context = {}) {
    const timeoutMs = Number(context.timeoutMs) > 0 ? Number(context.timeoutMs) : this.timeoutMs;
    const controller = new AbortController();
    const externalSignal = context.signal;
    let timedOut = false;
    let timer = null;

    const abortFromCaller = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromCaller();
      else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      return await this.fetch(url, Object.assign({}, init, { signal: controller.signal }));
    } catch (e) {
      const method = context.method || init.method || 'GET';
      const apiPath = context.apiPath || new URL(url).pathname;
      if (timedOut) {
        throw new ApiError(`${method} ${apiPath} 请求超时（${timeoutMs} ms）`, 504, {
          code: 'ASY_REQUEST_TIMEOUT',
          timeoutMs,
        });
      }
      if (externalSignal && externalSignal.aborted) {
        throw new ApiError(`${method} ${apiPath} 请求已取消`, 499, {
          code: 'ASY_REQUEST_ABORTED',
        });
      }
      throw new ApiError(`${method} ${apiPath} 网络错误: ${e && e.message ? e.message : String(e)}`, 503, {
        code: 'ASY_NETWORK_ERROR',
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
    }
  }

  headers(token) {
    const h = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'asy-cli/0.1',
    };
    if (this.cfg.subscriberId) h['x-subscriber-id'] = this.cfg.subscriberId;
    return h;
  }

  /** 原始请求（自动刷新 token 并重试一次） */
  async call(method, apiPath, opts = {}) {
    const url = new URL(this.baseApi + apiPath);
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    let token = await auth.ensureFresh(this.cfg);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.request(url, {
        method,
        headers: Object.assign(this.headers(token), opts.headers || {}),
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      }, {
        method,
        apiPath,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (this.debug) {
        console.error(`[debug] ${method} ${url.pathname}${url.search} -> ${res.status}`);
        console.error('[debug] ' + (text || '').slice(0, 800));
      }
      // token 过期 → 刷新后重试
      if (data && data.code === TOKEN_EXPIRE_CODE && attempt === 0) {
        token = await auth.ensureFresh(this.cfg, { force: true });
        continue;
      }
      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || text.slice(0, 300);
        throw new ApiError(`${method} ${apiPath} 失败: HTTP ${res.status} ${msg}`, res.status, data);
      }
      if (data && data.code && data.code !== 0 && data.code !== 200) {
        // 有些实现成功也带 code，失败才抛
        if (data.message && !('docid' in data) && !('dirs' in data) && !Array.isArray(data)) {
          throw new ApiError(`${method} ${apiPath} 返回错误: ${data.code} ${data.message}`, res.status, data);
        }
      }
      return data;
    }
  }

  // ---------- 目录 / 信息 ----------
  async entryItem() {
    return this.call('GET', '/efast/v1/entry-item');
  }

  /** 分类的文档库列表（用户会话用这个，entry-item 只适用于外链） */
  async classifiedEntryDocLibs() {
    return this.call('GET', '/efast/v1/classified-entry-doc-libs');
  }

  /** 共享文档库列表 */
  async sharedDocLibs() {
    try {
      return await this.call('GET', '/efast/v1/entry-doc-lib');
    } catch (e) {
      if (this.debug) console.error('[debug] entry-doc-lib 失败: ' + e.message);
      return [];
    }
  }

  async listFolder(docid, opts = {}) {
    const dirs = [], files = [];
    let marker = '';
    do {
      const data = await this.call('GET', `/efast/v1/folders/${encodeURIComponent(docid)}/sub_objects`, {
        query: {
          limit: opts.limit || 200,
          sort: opts.sort || 'name',
          direction: opts.direction || 'asc',
          permission_attributes_required: 'false',
          marker: marker || undefined,
        },
      });
      dirs.push(...((data && data.dirs) || []));
      files.push(...((data && data.files) || []));
      marker = (data && (data.next_marker || data.nextMarker)) || '';
      if (opts.limit && dirs.length + files.length >= opts.limit) break;
    } while (marker);
    return { dirs, files };
  }

  async convertPath(fullPath) {
    try {
      return await this.call('POST', '/efast/v1/file/convertpath', { json: { path: fullPath } });
    } catch (e) {
      if (this.debug) console.error('[debug] convertpath 失败: ' + e.message);
      return null;
    }
  }

  async infoByPath(fullPath) {
    return this.call('POST', '/efast/v1/file/getinfobypath', { json: { path: fullPath } });
  }

  // ---------- 根目录 ----------
  /** 返回文档库原始结构（用于首次配置） */
  async roots() {
    return this.classifiedEntryDocLibs();
  }

  /** 找到"个人文档"根 docid（type=user_doc_lib） */
  async resolveRootDocid() {
    if (this.cfg.rootDocid) return this.cfg.rootDocid;
    const data = await this.classifiedEntryDocLibs();
    const groups = Array.isArray(data) ? data : (data && data.items) || [];
    if (!groups.length) throw new Error('classified-entry-doc-libs 未返回内容，请用 asy roots 查看');
    // 优先「我的文档库」分组
    const userGroup = groups.find((g) => g.id === 'user_doc_lib' || /我的文档库|个人文档/.test(String(g.name || '')));
    const pool = userGroup ? (userGroup.doc_libs || []) : groups.flatMap((g) => g.doc_libs || []);
    const lib = pool.find((l) => l.type === 'user_doc_lib') || pool[0];
    if (!lib) throw new Error('未找到个人文档库（type=user_doc_lib），请用 asy roots 查看结构');
    this.cfg.rootDocid = lib.id;
    this.cfg.rootName = lib.name || '';
    config.save(this.cfg);
    return this.cfg.rootDocid;
  }

  /** 远程路径 → docid（支持 '/xxx/yyy'，相对个人文档根） */
  async resolvePath(remotePath) {
    const rootDocid = await this.resolveRootDocid();
    const clean = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return { docid: rootDocid, name: this.cfg.rootName || '/', type: 'dir', parent: null };

    // 若路径首段就是根目录名，去掉
    let parts = clean.split('/').filter(Boolean);
    if (this.cfg.rootName && parts[0] === this.cfg.rootName) parts = parts.slice(1);
    if (!parts.length) return { docid: rootDocid, name: this.cfg.rootName || '/', type: 'dir', parent: null };

    let current = rootDocid;
    let parent = null;
    for (let i = 0; i < parts.length; i++) {
      const { dirs, files } = await this.listFolder(current);
      const isLast = i === parts.length - 1;
      const dirHit = dirs.find((d) => d.name === parts[i]);
      const fileHit = files.find((f) => f.name === parts[i]);
      if (dirHit) {
        parent = current;
        current = dirHit.docid || dirHit.id;
        if (isLast) return { docid: current, name: dirHit.name, type: 'dir', parent, raw: dirHit };
      } else if (fileHit && isLast) {
        return { docid: fileHit.docid || fileHit.id, name: fileHit.name, type: 'file', parent: current, raw: fileHit };
      } else {
        throw new Error(`远程路径不存在: ${parts.slice(0, i + 1).join('/')}（在第 ${i + 1} 层找不到 "${parts[i]}"）`);
      }
    }
    return { docid: current, name: parts[parts.length - 1], type: 'dir', parent, raw: null };
  }

  /** 确保目标目录存在（按需创建中间目录） */
  async ensureDir(remotePath) {
    const clean = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) {
      const docid = await this.resolveRootDocid();
      return { docid, name: this.cfg.rootName || '/' };
    }
    let parts = clean.split('/').filter(Boolean);
    if (this.cfg.rootName && parts[0] === this.cfg.rootName) parts = parts.slice(1);
    let current = await this.resolveRootDocid();
    for (const part of parts) {
      const { dirs } = await this.listFolder(current);
      const hit = dirs.find((d) => d.name === part);
      if (hit) current = hit.docid || hit.id;
      else current = await this.mkdir(current, part);
    }
    return { docid: current, name: parts[parts.length - 1] || '/' };
  }

  // ---------- 目录/文件操作（参数格式取自官方 Web 客户端） ----------
  async mkdir(parentDocid, name) {
    const data = await this.call('POST', '/efast/v1/dir/create', {
      json: { docid: parentDocid, name, ondup: 1 },
    });
    const docid = (data && (data.docid || (data[0] && data[0].docid))) || '';
    if (!docid) throw new ApiError('mkdir 未返回 docid: ' + JSON.stringify(data).slice(0, 200), 200, data);
    return docid;
  }

  /** 支持批量：items = [{docid, type}]；逐个删除（与官方客户端一致） */
  async remove(items) {
    for (const it of items) {
      const isDir = it.type !== 'file';
      const p = isDir ? '/efast/v1/dir/delete' : '/efast/v1/file/delete';
      const json = isDir ? { docid: it.docid, check_upload_process: false } : { docid: it.docid };
      await this.call('POST', p, { json });
    }
  }

  /** 重命名（目录和文件都走 /file/rename） */
  async rename(docid, newName, ondup = 1) {
    return this.call('POST', '/efast/v1/file/rename', { json: { docid, name: newName, ondup } });
  }

  /** 移动（目录和文件都走 /file/move） */
  async move(docid, destDocid, ondup = 1) {
    return this.call('POST', '/efast/v1/file/move', { json: { docid, destparent: destDocid, ondup } });
  }

  /** 复制（目录和文件都走 /file/copy） */
  async copy(docid, destDocid, ondup = 1) {
    return this.call('POST', '/efast/v1/file/copy', { json: { docid, destparent: destDocid, ondup } });
  }

  // ---------- 传输 ----------
  async osdownload(docid, savename, rev) {
    const payload = { docid, authtype: '1', savename, usehttps: true };
    if (rev) payload.rev = rev;
    const data = await this.call('POST', '/efast/v1/file/osdownload', { json: payload });
    const req = data && data.authrequest;
    if (!Array.isArray(req) || req.length < 2) {
      throw new ApiError('osdownload 返回的 authrequest 格式异常: ' + JSON.stringify(data).slice(0, 300), 200, data);
    }
    return { method: req[0] || 'GET', url: req[1], entries: req.slice(2), raw: data };
  }

  async osbeginupload(folderDocid, filePath, fileName, ondup = 1) {
    const fs = require('fs');
    const stat = fs.statSync(filePath);
    const payload = {
      client_mtime: Math.floor(stat.mtimeMs),
      docid: folderDocid,
      length: stat.size,
      name: fileName,
      ondup: Number(ondup),
      reqmethod: 'POST',
    };
    const data = await this.call('POST', '/efast/v1/file/osbeginupload', { json: payload });
    const req = data && data.authrequest;
    if (!Array.isArray(req) || req.length < 2) {
      throw new ApiError('osbeginupload 返回的 authrequest 格式异常: ' + JSON.stringify(data).slice(0, 300), 200, data);
    }
    return { data, method: req[0], url: req[1], entries: req.slice(2) };
  }

  async osendupload(docid, rev, csflevel = 0) {
    return this.call('POST', '/efast/v1/file/osendupload', { json: { docid, rev, csflevel: Number(csflevel) || 0 } });
  }

  async userInfo() {
    return this.call('GET', '/eacp/v1/user/get');
  }
}

module.exports = { AnyShareApi, ApiError, TOKEN_EXPIRE_CODE };
