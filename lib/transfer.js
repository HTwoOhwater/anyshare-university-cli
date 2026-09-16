// AnyShare CLI - 流式上传 / 下载
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/** 解析服务端返回的 authrequest 条目：支持 "Header: value" 和 "field=value" 两种 */
function parseAuthEntries(entries, method) {
  const headers = {};
  const form = {};
  const isPost = String(method || '').toUpperCase() === 'POST';
  for (const entry of entries || []) {
    if (typeof entry !== 'string' || !entry) continue;
    let sep = null;
    const colon = entry.indexOf(':');
    const eq = entry.indexOf('=');
    if (entry.includes(': ')) sep = ': ';
    else if (eq !== -1 && (colon === -1 || eq < colon)) sep = '=';
    else if (colon !== -1) sep = ':';
    if (!sep) continue;
    const idx = entry.indexOf(sep);
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + sep.length).trim();
    if (!key) continue;
    if (sep === ':' || sep === ': ') {
      headers[key] = value;
      if (isPost && form[key] === undefined) form[key] = value;
    } else {
      form[key] = value;
    }
  }
  return { headers, form };
}

function makeProgress(label, total) {
  const tty = process.stderr.isTTY;
  let done = 0, last = 0;
  const start = Date.now();
  return {
    add(n) {
      done += n;
      if (!tty || !total) return;
      const now = Date.now();
      if (now - last < 200 && done < total) return;
      last = now;
      const secs = Math.max((now - start) / 1000, 0.001);
      const pct = ((done / total) * 100).toFixed(1);
      const speed = done / secs / 1024 / 1024;
      process.stderr.write(`\r${label}: ${pct}% (${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB) ${speed.toFixed(2)} MB/s   `);
    },
    finish() { if (tty && total) process.stderr.write('\n'); },
    abort() { if (tty && total) process.stderr.write('\n'); },
  };
}

/** 底层 HTTP 请求（支持流式 body） */
function rawRequest({ method, url, headers, bodyStream, contentLength, onData }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
      timeout: 0,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (onData) onData(c.length, c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bodyStream) {
      if (contentLength) req.setHeader('Content-Length', String(contentLength));
      bodyStream.on('error', reject);
      bodyStream.pipe(req);
    } else {
      req.end();
    }
  });
}

/** 上传：osbeginupload → (PUT | multipart POST) → osendupload */
async function uploadFile(api, localPath, folderDocid, remoteName, opts = {}) {
  if (!fs.existsSync(localPath)) throw new Error('本地文件不存在: ' + localPath);
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error('不是文件: ' + localPath);
  const fileName = remoteName || path.basename(localPath);

  const begin = await api.osbeginupload(folderDocid, localPath, fileName, opts.ondup ?? 1);
  const method = String(begin.method || 'POST').toUpperCase();
  const url = begin.url;
  const { headers: hdrFromAuth, form } = parseAuthEntries(begin.entries, method);

  const progress = makeProgress('上传', stat.size);
  let res;
  try {
    if (method === 'PUT') {
      const headers = Object.keys(hdrFromAuth).length ? { ...hdrFromAuth } : { ...form };
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/octet-stream';
      const stream = fs.createReadStream(localPath);
      stream.on('data', (c) => progress.add(c.length));
      res = await rawRequest({ method: 'PUT', url, headers, bodyStream: stream, contentLength: stat.size });
    } else if (method === 'POST') {
      const boundary = '----asycli' + Date.now().toString(16);
      const fieldName = 'file'; // 实测字段名
      const contentType = hdrFromAuth['Content-Type'] || form['Content-Type'] || 'application/octet-stream';
      const parts = [];
      for (const [k, v] of Object.entries(form)) {
        if (/content-type/i.test(k)) continue;
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${String(k).replace(/"/g, '\\"')}"\r\n\r\n${v}\r\n`));
      }
      const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName.replace(/"/g, '\\"')}"\r\nContent-Type: ${contentType}\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const prefix = Buffer.concat(parts.concat([fileHeader]));
      const total = prefix.length + stat.size + tail.length;
      const stream = require('stream');
      const fileStream = fs.createReadStream(localPath);
      fileStream.on('data', (c) => progress.add(c.length));
      async function* gen() {
        yield prefix;
        for await (const chunk of fileStream) yield chunk;
        yield tail;
      }
      const bodyStream = stream.Readable.from(gen());
      res = await rawRequest({
        method: 'POST', url, bodyStream, contentLength: total,
        headers: { ...hdrFromAuth, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      });
    } else {
      throw new Error('不支持的上传方式: ' + method);
    }
    progress.finish();
  } catch (e) {
    progress.abort();
    throw e;
  }

  if (res.status >= 400) {
    throw new Error(`上传失败: HTTP ${res.status} ${res.body.toString().slice(0, 300)}`);
  }
  await api.osendupload(begin.data.docid, begin.data.rev, begin.data.csflevel || 0);
  return { name: fileName, size: stat.size };
}

/** 下载：osdownload → 真实 URL（需带 S3 签名头）→ 写入文件 */
async function downloadFile(api, docid, savename, outPath, rev) {
  const { method, url, entries } = await api.osdownload(docid, savename, rev);
  const dir = path.dirname(outPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 服务端下发的签名头（Authorization / x-amz-date 等）必须原样携带
  const { headers: authHeaders } = parseAuthEntries(entries, method);
  const reqHeaders = Object.assign({ 'User-Agent': 'asy-cli/0.1' }, authHeaders);

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: method || 'GET',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: reqHeaders,
    }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`下载失败: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 300)}`)));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      const progress = makeProgress('下载', total);
      const ws = fs.createWriteStream(outPath);
      res.on('data', (c) => progress.add(c.length));
      res.pipe(ws);
      ws.on('finish', () => { progress.finish(); resolve({ size: total, path: outPath }); });
      ws.on('error', (e) => { progress.abort(); reject(e); });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { uploadFile, downloadFile, parseAuthEntries };