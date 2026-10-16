'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Minimal but Windows-compatible WebDAV server (DAV class 2).
 * Windows Explorer's WebDAV redirector needs PROPFIND + LOCK/UNLOCK to allow
 * read *and* write, so both are implemented here.
 */
function createWebdavHandler({ root, verify, log, appPort = 8443 }) {
  const authCache = new Map(); // credentials hash -> expiry timestamp
  const AUTH_TTL = 60 * 1000;

  function authorized(req) {
    const header = req.headers.authorization || '';
    if (!header.toLowerCase().startsWith('basic ')) return false;
    const raw = header.slice(6).trim();
    const key = crypto.createHash('sha256').update(raw).digest('hex');
    const cached = authCache.get(key);
    if (cached && cached > Date.now()) return true;

    let decoded;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) return false;
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    const ok = verify(user, pass);
    if (ok) {
      authCache.set(key, Date.now() + AUTH_TTL);
      if (authCache.size > 200) authCache.clear();
    }
    return ok;
  }

  function deny(res) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="PC Remote", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Authentication required');
  }

  function resolve(pathname) {
    let rel = decodeURIComponent(pathname.split('?')[0]).replace(/\\/g, '/');
    rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    // The share is served under /phone so it shows a friendly name in Explorer.
    if (/^phone(\/|$)/i.test(rel)) rel = rel.replace(/^phone\/?/i, '');
    const target = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
    return target;
  }

  function hrefFor(req, absPath) {
    const rel = path.relative(root, absPath).split(path.sep).map(encodeURIComponent).join('/');
    const host = req.headers.host || 'localhost';
    const proto = req.socket.encrypted ? 'https' : 'http';
    const base = `/${'phone'}`;
    return rel ? `${proto}://${host}${base}/${rel}` : `${proto}://${host}${base}/`;
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function multistatus(req, absPath, depth) {
    const entries = [{ absPath, stat: fs.statSync(absPath) }];
    if (depth === '1' && entries[0].stat.isDirectory()) {
      for (const name of fs.readdirSync(absPath)) {
        const child = path.join(absPath, name);
        try {
          entries.push({ absPath: child, stat: fs.statSync(child) });
        } catch {
          /* skip */
        }
      }
    }
    const parts = entries.map(({ absPath: p, stat }) => {
      const isDir = stat.isDirectory();
      const href = escapeXml(hrefFor(req, p));
      const display = escapeXml(path.basename(p) || 'phone');
      return [
        '<d:response>',
        `<d:href>${href}</d:href>`,
        '<d:propstat><d:prop>',
        `<d:displayname>${display}</d:displayname>`,
        `<d:getlastmodified>${stat.mtime.toUTCString()}</d:getlastmodified>`,
        `<d:creationdate>${stat.ctime.toISOString()}</d:creationdate>`,
        isDir
          ? '<d:resourcetype><d:collection/></d:resourcetype>'
          : '<d:resourcetype/>',
        isDir ? '<d:getcontentlength>0</d:getcontentlength>' : `<d:getcontentlength>${stat.size}</d:getcontentlength>`,
        isDir ? '<d:getcontenttype/>' : '<d:getcontenttype>application/octet-stream</d:getcontenttype>',
        '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>',
        '<d:lockdiscovery/>',
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
        '</d:response>',
      ].join('');
    });
    return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function send(res, code, body, headers = {}) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body || '');
  }

  /** True when a human is probably looking at this in a web browser. */
  function browserFacing(req) {
    return String(req.headers.accept || '').includes('text/html');
  }

  function appUrl(req) {
    const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
    return `https://${host}:${appPort}`;
  }

  function htmlPage(res, code, title, message, req) {
    const app = appUrl(req);
    const appEsc = escapeXml(app);
    const share = escapeXml(app.replace(/:\d+$/, ':8243') + '/phone');
    const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
 body{margin:0;padding:2rem 1.25rem;background:#0f1115;color:#e6e9ef;
      font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 main{max-width:44rem;margin:0 auto}
 h1{font-size:1.5rem;margin:0 0 .5rem}
 p,li{color:#b7bfcc}
 code{background:#1a1e27;border:1px solid #262c39;border-radius:6px;padding:.12rem .35rem;color:#e6e9ef}
 a{color:#7db8ff}
 .warn{border-left:3px solid #e0a53a;background:#1a1712;padding:.75rem 1rem;border-radius:8px;margin:1.25rem 0}
</style></head><body><main>
<h1>${title}</h1>
<p>${message}</p>
<div class="warn">This is the <strong>WebDAV share</strong>, meant to be mapped as a
network drive in Windows Explorer — not opened in a web browser.</div>
<p>To map it:</p>
<ol>
 <li>Open <strong>File Explorer → This PC</strong>.</li>
 <li>Click <strong>Map network drive</strong>.</li>
 <li>Paste <code>${share}</code> as the folder.</li>
 <li>Tick <em>Connect using different credentials</em> and use the app's username/password.</li>
</ol>
<p>Looking for the app itself? Open <a href="${appEsc}">${appEsc}</a>.</p>
</main></body></html>`;
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  return async function webdavHandler(req, res) {
    const method = req.method.toUpperCase();
    const absPath = resolve(req.url);
    if (!absPath) return send(res, 403, 'Forbidden');
    if (!authorized(req)) return deny(res);

    try {
      switch (method) {
        case 'OPTIONS':
          return send(res, 200, '', {
            DAV: '1, 2',
            'MS-Author-Via': 'DAV',
            Allow: 'OPTIONS, GET, HEAD, POST, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, LOCK, UNLOCK, MOVE, COPY',
            'Accept-Ranges': 'bytes',
          });

        case 'PROPFIND': {
          if (!fs.existsSync(absPath)) return send(res, 404, 'Not found');
          const depth = (req.headers.depth || '1').toString();
          const xml = multistatus(req, absPath, depth === '0' ? '0' : '1');
          return send(res, 207, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) });
        }

        case 'PROPPATCH':
          return send(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>${escapeXml(hrefFor(req, absPath))}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, {
            'Content-Type': 'application/xml; charset=utf-8',
          });

        case 'LOCK': {
          const token = `opaquelocktoken:${crypto.randomUUID()}`;
          const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
          return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` });
        }

        case 'UNLOCK':
          return send(res, 204, '');

        case 'GET':
        case 'HEAD': {
          let stat;
          try {
            stat = await fsp.stat(absPath);
          } catch {
            if (method === 'GET' && browserFacing(req)) {
              const asked = escapeXml(decodeURIComponent(String(req.url || '').split('?')[0]));
              return htmlPage(res, 404, 'Not found', `There is nothing at <code>${asked}</code> in this share.`, req);
            }
            return send(res, 404, 'Not found');
          }
          if (stat.isDirectory()) {
            if (method === 'GET' && browserFacing(req) && path.resolve(absPath) === path.resolve(root)) {
              return htmlPage(res, 200, 'PC Remote storage', 'This folder is the phone-storage share.', req);
            }
            // Browsing a directory in a browser shows the XML listing.
            const xml = multistatus(req, absPath, '1');
            return send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8' });
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'Last-Modified': stat.mtime.toUTCString(),
            'Accept-Ranges': 'bytes',
          });
          if (method === 'HEAD') return res.end();
          fs.createReadStream(absPath).pipe(res);
          return undefined;
        }

        case 'PUT': {
          await fsp.mkdir(path.dirname(absPath), { recursive: true });
          const body = await readBody(req);
          await fsp.writeFile(absPath, body);
          return send(res, fs.existsSync(absPath) ? 204 : 201, '');
        }

        case 'DELETE': {
          if (!fs.existsSync(absPath)) return send(res, 404, 'Not found');
          if (path.resolve(absPath) === path.resolve(root)) return send(res, 403, 'Refusing to delete root');
          await fsp.rm(absPath, { recursive: true, force: true });
          return send(res, 204, '');
        }

        case 'MKCOL': {
          if (fs.existsSync(absPath)) return send(res, 405, 'Already exists');
          await fsp.mkdir(absPath, { recursive: true });
          return send(res, 201, '');
        }

        case 'MOVE':
        case 'COPY': {
          const dest = req.headers.destination;
          if (!dest) return send(res, 400, 'Missing Destination');
          const destPath = resolve(new URL(dest, 'http://x').pathname);
          if (!destPath) return send(res, 403, 'Forbidden destination');
          if (!fs.existsSync(absPath)) return send(res, 404, 'Not found');
          await fsp.mkdir(path.dirname(destPath), { recursive: true });
          if (method === 'MOVE') await fsp.rename(absPath, destPath);
          else await fsp.cp(absPath, destPath, { recursive: true, force: true });
          return send(res, 201, '');
        }

        case 'POST':
          return send(res, 405, 'Method not allowed');

        default:
          log(`[webdav] unsupported method ${method}`);
          return send(res, 501, 'Not implemented');
      }
    } catch (err) {
      log(`[webdav] ${method} ${req.url} failed: ${err.message}`);
      return send(res, 500, 'Server error');
    }
  };
}

module.exports = { createWebdavHandler };
