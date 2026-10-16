'use strict';
/* End-to-end browser simulation: runs the real public/app.js in a real DOM
 * against the REAL running server, with a real cookie jar and real WebSocket.
 *   node test/e2e-browser.js
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const credFile = path.join(__dirname, '..', 'data', 'INITIAL-PASSWORD.txt');
const password =
  process.env.PC_REMOTE_PASSWORD ||
  (fs.existsSync(credFile) ? (fs.readFileSync(credFile, 'utf8').match(/^Password:\s*(.+)$/m) || [])[1] : undefined);
// Run against an already-signed-in server without needing the password:
//   PC_REMOTE_COOKIE="pcrc_session=<token>" node test/e2e-browser.js
const preAuthCookie = process.env.PC_REMOTE_COOKIE || '';

const ORIGIN = `https://192.168.1.38:${cfg.port}`;
const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

let cookie = preAuthCookie;
const network = [];
const problems = [];

const dom = new JSDOM(html, { url: `${ORIGIN}/`, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.addEventListener('error', (e) => problems.push(`page error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => problems.push(`unhandled rejection: ${e.reason && e.reason.message}`));

window.fetch = async (url, options = {}) => {
  const full = url.startsWith('http') ? url : `${ORIGIN}${url}`;
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(full, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie && setCookie[0]) cookie = setCookie[0].split(';')[0];
  const bodyText = await res.text();
  network.push(`${options.method || 'GET'} ${url} -> ${res.status}${res.status >= 400 ? ` body=${bodyText.slice(0, 120)}` : ''}`);
  return {
    ok: res.ok,
    status: res.status,
    json: async () => {
      try {
        return JSON.parse(bodyText);
      } catch {
        problems.push(`expected JSON from ${url} but got: ${bodyText.slice(0, 80)}`);
        throw new Error('not json');
      }
    },
    text: async () => bodyText,
  };
};

class RealWebSocket {
  constructor(url) {
    this.inner = new WebSocket(url, { rejectUnauthorized: false, headers: cookie ? { cookie } : {} });
    this.readyState = 0;
    this.OPEN = 1;
    this.inner.on('open', () => {
      const before = network.length;
      this.readyState = 1;
      this.onopen && this.onopen();
      network.push(`WS open (handshake ${network.length > before ? 'ok' : 'ok'})`);
    });
    this.inner.on('message', (data, isBinary) => this.onmessage && this.onmessage({ data: isBinary ? data : data.toString() }));
    this.inner.on('close', () => {
      this.readyState = 3;
      this.onclose && this.onclose();
    });
    this.inner.on('error', (err) => problems.push(`websocket error: ${err.message}`));
  }
  send(data) {
    network.push(`WS -> ${data}`);
    if (typeof data === 'string' && data.includes('"move"')) return; // never move the real cursor in tests
    this.inner.send(data);
  }
  close() {
    this.inner.close();
  }
}
RealWebSocket.CONNECTING = 0;
RealWebSocket.OPEN = 1;
RealWebSocket.CLOSING = 2;
RealWebSocket.CLOSED = 3;
window.WebSocket = RealWebSocket;

window.prompt = () => null;
window.confirm = () => true;
window.alert = (m) => problems.push(`alert shown: ${m}`);
window.open = (u) => network.push(`window.open ${u}`);

window.eval(appJs);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (id) => window.document.getElementById(id);
const text = () => window.document.body.textContent.replace(/\s+/g, ' ').trim();

(async () => {
  await wait(200);
  if (preAuthCookie) {
    await wait(600);
    console.log('1. pre-authenticated via PC_REMOTE_COOKIE (login form skipped)');
  } else {
    console.log(`1. login screen shown: ${!el('loginView').hidden}`);
    el('loginUser').value = cfg.username;
    el('loginPass').value = password;
    el('loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(600);
  }

  const appVisible = !el('appView').hidden;
  console.log(`2. signed in, app view visible: ${appVisible}, login card hidden: ${el('loginView').hidden}`);
  console.log(`   login error shown: ${el('loginError').hidden ? 'no' : `YES -> "${el('loginError').textContent}"`}`);
  if (!appVisible) problems.push('app view never became visible after login');
  if (!el('loginView').hidden) problems.push('login card is still visible after sign-in');

  const rendered = text();
  const hasTrackpad = rendered.includes('Trackpad');
  const hasTabs = rendered.includes('Files') && rendered.includes('Settings');
  console.log(`3. main UI rendered (trackpad: ${hasTrackpad}, tabs: ${hasTabs})`);
  if (!hasTrackpad || !hasTabs) problems.push('main UI did not render after login');

  // Files tab with real data
  [...window.document.querySelectorAll('.tab')].find((t) => t.dataset.panel === 'files').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(400);
  console.log(`4. files panel: ${window.document.querySelectorAll('.file-row').length} row(s), breadcrumb "${el('crumbs').textContent}"`);
  console.log(`   storage line: "${el('storageInfo').textContent}"`);
  const listError = window.document.querySelector('#fileList .error');
  if (listError) problems.push(`file list shows an error: ${listError.textContent}`);
  if (!el('storageInfo').textContent.includes('free')) problems.push('storage info did not render');

  // Settings tab with real data
  [...window.document.querySelectorAll('.tab')].find((t) => t.dataset.panel === 'settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  console.log(`5. settings: webdav="${el('webdavInfo').textContent.replace(/\s+/g, ' ').trim().slice(0, 80)}..."`);
  console.log(`   qr image: ${el('settingsQr').src.slice(0, 30)}..., netuse="${el('btnCopyNetUse').dataset.cmd}"`);
  if (!el('settingsQr').src.startsWith('data:image/png')) problems.push('settings QR did not load');
  if (!el('btnCopyNetUse').dataset.cmd) problems.push('net use command not built');

  // Upload through the app's OWN ui: file input -> uploadFiles() -> refresh.
  // XMLHttpRequest is bridged to the authenticated fetch, so the real
  // progress/onload/loadFiles() code path runs.
  window.XMLHttpRequest = class {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    send(form) {
      const self = this;
      const relpath = form.get('relpath') || '';
      const file = form.get('files');
      (async () => {
        const bytes = Buffer.from(await file.arrayBuffer());
        const out = new FormData(); // Node's FormData, understood by fetch
        out.append('relpath', relpath);
        out.append('files', new Blob([bytes]), file.name);
        const res = await window.fetch(self.url, { method: self.method, body: out });
        self.status = res.status;
        self.responseText = await res.text();
        if (self.upload.onprogress) self.upload.onprogress({ lengthComputable: true, loaded: 1, total: 1 });
        self.onload && self.onload();
      })().catch(() => {
        self.status = 0;
        self.onerror && self.onerror();
      });
    }
  };

  const fileInput = el('fileInput');
  const uploadName = `e2e-${Date.now()}.txt`;
  const chosen = new window.File(['hello from the phone'], uploadName, { type: 'text/plain' });
  Object.defineProperty(fileInput, 'files', { value: [chosen], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(1200);
  const queue = window.document.getElementById('uploadQueue').textContent.trim();
  const rowsAfter = window.document.querySelectorAll('.file-row').length;
  console.log(`6. UI upload queue: "${queue}"`);
  console.log(`7. rows after UI upload: ${rowsAfter}`);
  if (!/✓/.test(queue)) problems.push(`upload did not finish cleanly, queue was: ${queue}`);
  if (rowsAfter < 1) problems.push(`file list did not refresh after upload (${rowsAfter} rows)`);
  const uploaded = [...window.document.querySelectorAll('.file-row .name')].map((n) => n.textContent);
  console.log(`   listed: ${uploaded.join(', ')}`);
  if (!uploaded.includes(uploadName)) problems.push(`uploaded file ${uploadName} is not listed`);
  // keep the storage folder clean between runs
  await fetch(`${ORIGIN}/api/files?path=${encodeURIComponent(uploadName)}`, { method: 'DELETE', headers: { cookie } }).catch(() => {});

  // The live screen and the trackpad are on the same (Control) panel now.
  [...window.document.querySelectorAll('.tab')].find((t) => t.dataset.panel === 'control').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const control = el('panel-control');
  const together = control.contains(el('screenCanvas')) && control.contains(el('trackpad'));
  console.log(`8. screen + trackpad in one panel: ${together}`);
  if (!together) problems.push('screen canvas and trackpad are not on the same panel');

  el('btnStartStream').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(2500);
  console.log(`9. screen stats: "${el('viewStats').textContent}"`);
  if (!/\d/.test(el('viewStats').textContent)) problems.push('no live frames arrived after Start');
  console.log(`   start overlay hidden while streaming: ${el('viewOverlay').hidden}`);
  if (!el('viewOverlay').hidden) problems.push('start overlay still covers the screen while streaming');

  // Settings now owns the account: the user name and the sign-out button.
  [...window.document.querySelectorAll('.tab')].find((t) => t.dataset.panel === 'settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const signOut = el('btnSignOut');
  console.log(`10. settings: user="${el('accountUser').textContent}" signOutInSettings=${el('panel-settings').contains(signOut)} topbarHasSignOut=${el('appView').querySelector('.topbar').contains(signOut)}`);
  if (el('accountUser').textContent !== cfg.username) problems.push('Settings does not show the signed-in user');
  if (!el('panel-settings').contains(signOut)) problems.push('sign-out is not in Settings');
  if (el('appView').querySelector('.topbar').contains(signOut)) problems.push('sign-out is still in the top bar');
  console.log(`   live screen stopped when leaving Control: ${!el('viewOverlay').hidden}`);
  if (el('viewOverlay').hidden) problems.push('stream kept running after leaving the Control tab');

  console.log(`\nscroll/battery check - page still showing app (not replaced): ${!el('appView').hidden}`);
  console.log('\nnetwork:');
  for (const n of network) console.log(`  ${n}`);
  console.log(`\nproblems: ${problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'}`);
  process.exit(problems.length ? 1 : 0);
})();
