'use strict';
/* Transport + friendliness tests:
 *   - plain http:// on either port answers with a 301 to https://
 *     (this is what makes "192.168.1.38:8443" work instead of ERR_EMPTY_RESPONSE)
 *   - https still works on both ports
 *   - a browser that lands on the WebDAV share gets a help page, not a bare
 *     "Not found"
 *   - WebDAV clients (no text/html Accept) still get plain text / XML
 * Run while the server is up:  node test/transport.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const credFile = path.join(__dirname, '..', 'data', 'INITIAL-PASSWORD.txt');
const password =
  process.env.PC_REMOTE_PASSWORD ||
  (fs.existsSync(credFile) ? (fs.readFileSync(credFile, 'utf8').match(/^Password:\s*(.+)$/m) || [])[1] : undefined);

const HOST = '127.0.0.1';
// WebDAV uses Basic auth, so the content checks need the password. After the user
// changes the password (and deletes data/INITIAL-PASSWORD.txt, as the README says)
// we still run every anonymous check and plainly skip the authenticated ones.
const authed = Boolean(password);
const auth = authed ? 'Basic ' + Buffer.from(`${cfg.username}:${password}`).toString('base64') : '';

function request(mod, { port, path: urlPath, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const r = mod.request({ host: HOST, port, path: urlPath, method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

(async () => {
  const appPort = cfg.port;
  const davPort = cfg.webdavPort;

  // 1. plain http on the app port -> 301 to https
  const a1 = await request(http, { port: appPort, path: '/' });
  check('http:// on app port redirects to https', a1.status === 301 && /^https:\/\//.test(a1.headers.location || ''), `${a1.status} -> ${a1.headers.location}`);

  // 2. plain http on the webdav port -> 301 to https, path preserved
  const d1 = await request(http, { port: davPort, path: '/phone/somefile.txt' });
  check('http:// on webdav port redirects to https', d1.status === 301 && /^https:\/\//.test(d1.headers.location || '') && (d1.headers.location || '').endsWith('/phone/somefile.txt'), `${d1.status} -> ${d1.headers.location}`);

  // 3. https still serves the app
  const a2 = await request(https, { port: appPort, path: '/' });
  check('https:// serves the app', a2.status === 200 && a2.body.includes('id="loginView"'), `status ${a2.status}`);

  if (!authed) {
    // No password on hand: verify WebDAV is at least locked down.
    const d0 = await request(https, { port: davPort, path: '/phone/', headers: { accept: 'text/html' } });
    check('WebDAV root requires auth', d0.status === 401 && /Basic/.test(d0.headers['www-authenticate'] || ''), `status ${d0.status}`);
    console.log('skip: WebDAV page/content checks need the password (set PC_REMOTE_PASSWORD)');
  } else {
    // 4. browser hitting a missing WebDAV path gets an HTML help page
    const d2 = await request(https, { port: davPort, path: '/phone%20/user:bikar%20*', headers: { authorization: auth, accept: 'text/html,application/xhtml+xml' } });
    check('browser 404 on webdav is an HTML help page', d2.status === 404 && (d2.headers['content-type'] || '').includes('text/html') && /Map network drive/.test(d2.body), `status ${d2.status}, ${d2.headers['content-type']}`);

    // 5. browser landing on the share root gets the same help page
    const d3 = await request(https, { port: davPort, path: '/phone/', headers: { authorization: auth, accept: 'text/html' } });
    check('browser at webdav root gets a help page', d3.status === 200 && /WebDAV share/.test(d3.body), `status ${d3.status}`);

    // 6. WebDAV clients (Explorer) still get XML
    const d4 = await request(https, { port: davPort, path: '/phone/', method: 'PROPFIND', headers: { authorization: auth, depth: '1' } });
    check('PROPFIND still returns XML multistatus', d4.status === 207 && d4.body.includes('<d:multistatus'), `status ${d4.status}`);

    // 7. non-browser 404 keeps the plain text body
    const d5 = await request(https, { port: davPort, path: '/phone/missing.bin', headers: { authorization: auth, accept: '*/*' } });
    check('non-browser 404 stays plain text', d5.status === 404 && d5.body.trim() === 'Not found', `status ${d5.status} body="${d5.body.trim()}"`);
  }

  // 8. unknown api route is still a 404 (no SPA html for /api/)
  const a3 = await request(https, { port: appPort, path: '/api/nope' });
  check('unknown /api path 404s', a3.status === 404, `status ${a3.status}`);

  // 9. SPA fallback serves the app for arbitrary paths
  const a4 = await request(https, { port: appPort, path: '/phone' });
  check('SPA fallback serves the app', a4.status === 200 && a4.body.includes('id="loginView"'), `status ${a4.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('transport test crashed:', err.message);
  process.exit(1);
});
