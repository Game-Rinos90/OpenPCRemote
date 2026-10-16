'use strict';
/* Runs public/app.js inside a real DOM (jsdom) against stubbed HTTP/WebSocket
 * responses, then reports what the page actually renders. Catches frontend
 * wiring bugs that a syntax check cannot. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

const errors = [];
const calls = [];

function json(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  };
}

const routes = {
  '/api/session': () => json({ signedIn: false, username: null }),
  '/api/urls': () => json({ urls: [{ iface: 'Wi-Fi', url: 'https://192.168.1.38:8443' }], qr: 'data:image/png;base64,AAAA' }),
  '/api/login': () => json({ ok: true, username: 'bikar' }),
  '/api/logout': () => json({ ok: true }),
  '/api/password': () => json({ ok: true }),
  '/api/capture-settings': () => json({ ok: true }),
  '/api/files/reveal': () => json({ ok: true }),
  '/api/files/mkdir': () => json({ ok: true }),
  '/api/info': () =>
    json({
      username: 'bikar',
      hostname: 'PC-ryzen',
      port: 8443,
      webdavPort: 8243,
      webdavTls: true,
      urls: [{ iface: 'Wi-Fi', url: 'https://192.168.1.38:8443' }],
      webdavUrls: [{ iface: 'Wi-Fi', url: 'https://192.168.1.38:8243' }],
      qr: 'data:image/png;base64,AAAA',
      storageRoot: 'C:\\Users\\bikar\\pc-remote\\data\\phone-storage',
      capture: { fps: 8, quality: 55, maxWidth: 1280 },
    }),
  '/api/files/list': () =>
    json({
      path: '',
      items: [
        { name: 'DCIM', path: 'DCIM', isDir: true, size: 0, mtime: Date.now() },
        { name: 'photo.jpg', path: 'photo.jpg', isDir: false, size: 2048, mtime: Date.now() },
      ],
      usage: { total: 999126065152, free: 679845195776 },
    }),
  '/api/remote': () =>
    json({
      installed: true,
      running: true,
      state: 'Running',
      online: true,
      ip: '100.101.102.103',
      ipv6: null,
      dnsName: 'pc-ryzen.tailnet.ts.net',
      tailnet: 'example.com',
      host: 'pc-ryzen.tailnet.ts.net',
      url: 'https://pc-ryzen.tailnet.ts.net:8443',
      trustedCert: false,
      qr: 'data:image/png;base64,BBBB',
    }),
  '/api/remote/cert': () => json({ ok: true, restartRequired: true, dnsName: 'pc-ryzen.tailnet.ts.net' }),
};

const dom = new JSDOM(html, { url: 'https://192.168.1.38:8443/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason && e.reason.message}`));

let socket = null;
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.OPEN = 1;
    socket = this;
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  send(data) {
    calls.push(`ws.send ${data}`);
  }
  close() {
    this.readyState = 3;
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
window.WebSocket = FakeWebSocket;

window.fetch = async (url, options = {}) => {
  const key = url.split('?')[0];
  calls.push(`${options.method || 'GET'} ${url}`);
  const route = routes[key];
  if (!route) {
    errors.push(`frontend called an unmapped endpoint: ${url}`);
    return json({ error: 'Not found' }, 404);
  }
  return route(options);
};
window.prompt = () => null;
window.confirm = () => true;
window.alert = (m) => calls.push(`alert: ${m}`);
window.open = (u) => calls.push(`window.open ${u}`);
// jsdom already provides window.location from the URL we constructed it with.

// Corrupt a stored preference on purpose: a NaN pointer speed must not turn
// every move into `null` (the "the pad does nothing" bug).
window.localStorage.setItem('speed', 'not-a-number');

window.eval(appJs);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.body.textContent.replace(/\s+/g, ' ').trim();

(async () => {
  await wait(60);
  const loginVisible = !window.document.getElementById('loginView').hidden;
  console.log(`login screen visible at start: ${loginVisible}`);
  console.log(`urls fetched for login page: ${calls.some((c) => c.includes('/api/urls'))}`);

  // sign in
  window.document.getElementById('loginUser').value = 'bikar';
  window.document.getElementById('loginPass').value = 'secret';
  window.document.getElementById('loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);

  const appVisible = !window.document.getElementById('appView').hidden;
  console.log(`\nafter login - app view visible: ${appVisible}`);
  console.log(`login view hidden: ${window.document.getElementById('loginView').hidden}`);
  console.log(`websocket opened: ${!!socket} -> ${socket && socket.url}`);
  console.log(`active panel: ${[...window.document.querySelectorAll('.panel')].filter((p) => p.classList.contains('active')).map((p) => p.id).join(',')}`);
  console.log(`file rows rendered: ${window.document.querySelectorAll('.file-row').length}`);
  console.log(`body text: ${JSON.stringify(text())}`);

  // walk every tab like a user would
  console.log('\nswitching tabs:');
  for (const tab of window.document.querySelectorAll('.tab')) {
    tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const active = [...window.document.querySelectorAll('.panel')].filter((p) => p.classList.contains('active')).map((p) => p.id);
    const before = errors.length;
    console.log(`  ${tab.dataset.panel.padEnd(9)} -> active: ${active.join(',') || 'NONE'}${errors.length > before ? `  ERRORS: ${errors.slice(before).join('; ')}` : ''}`);
  }

  // exercise buttons that build DOM or hit endpoints
  console.log('\nexercising buttons:');
  const clicks = ['btnNewFolder', 'btnReveal', 'btnApplyCapture', 'btnKeyboard', 'btnLeft', 'btnViewControl', 'btnStartStream', 'btnStopStream', 'btnCopyNetUse', 'btnRemoteCopy', 'btnRemoteCert'];
  for (const id of clicks) {
    const el = window.document.getElementById(id);
    const before = errors.length;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(25);
    console.log(`  ${id.padEnd(16)} ${errors.length > before ? `ERRORS: ${errors.slice(before).join('; ')}` : 'ok'}`);
  }

  console.log('\npassword + settings forms:');
  window.document.getElementById('pwCurrent').value = 'x';
  window.document.getElementById('pwNext').value = 'yyyyyyyy';
  window.document.getElementById('passwordForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(40);
  console.log(`  password form message: ${JSON.stringify(window.document.getElementById('pwMsg').textContent)}`);

  // pointer-driven controls (the pad and the side click buttons)
  console.log('\ntrackpad + click buttons (pointer events):');
  const pev = (type, x, y, id = 1) => {
    const Ctor = window.PointerEvent || window.MouseEvent;
    return new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id });
  };
  const count = (needle) => calls.filter((c) => c.includes(needle)).length;

  const pad = window.document.getElementById('trackpad');
  const movesBefore = count('"action":"move"');
  pad.dispatchEvent(pev('pointerdown', 100, 100));
  pad.dispatchEvent(pev('pointermove', 140, 130));
  await wait(80);
  const padMoved = count('"action":"move"') > movesBefore;
  console.log(`  pad drag -> mouse move: ${padMoved ? 'ok' : 'FAILED'}`);
  if (!padMoved) errors.push('dragging the pad did not send a mouse move');
  const moves = calls.filter((c) => c.includes('"action":"move"')).map((c) => JSON.parse(c.slice(8)));
  const finite = moves.length > 0 && moves.every((m) => Number.isFinite(m.dx) && Number.isFinite(m.dy));
  console.log(`  pointer deltas are real numbers (corrupt speed ignored): ${finite ? 'ok' : 'FAILED'} -> ${JSON.stringify(moves[moves.length - 1])}`);
  if (!finite) errors.push('a corrupt speed preference produced a non-numeric pointer move');
  pad.dispatchEvent(pev('pointerup', 140, 130));

  const left = window.document.getElementById('btnLeft');
  const downBefore = count('"action":"down"');
  left.dispatchEvent(pev('pointerdown', 0, 0));
  const heldDown = left.classList.contains('held');
  left.dispatchEvent(pev('pointerup', 0, 0));
  await wait(20);
  const leftWorked = count('"action":"down"') > downBefore && !left.classList.contains('held');
  console.log(`  Left button -> press/release: ${leftWorked ? 'ok' : 'FAILED'} (held class while down: ${heldDown})`);
  if (!leftWorked) errors.push('the Left button did not send mouse down/up');

  const zoomLabel = window.document.getElementById('zoomLabel');
  const zoomBefore = zoomLabel.textContent;
  window.document.getElementById('btnZoomIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  const zoomed = zoomLabel.textContent !== zoomBefore && zoomLabel.textContent !== '100%';
  console.log(`  zoom in: ${zoomBefore} -> ${zoomLabel.textContent} ${zoomed ? 'ok' : 'FAILED'}`);
  if (!zoomed) errors.push('the zoom-in button did not change the zoom level');
  window.document.getElementById('btnZoomFit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const testBefore = count('"type":"input-test"');
  window.document.getElementById('btnTestInput').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  console.log(`  Test input button sends request: ${count('"type":"input-test"') > testBefore ? 'ok' : 'FAILED'}`);

  // remote access (Tailscale) card
  console.log('\nremote access (Tailscale) card:');
  const remoteText = window.document.getElementById('remoteStatus').textContent.replace(/\s+/g, ' ');
  const remoteUrlShown = remoteText.includes('https://pc-ryzen.tailnet.ts.net:8443');
  const remoteQrShown = !window.document.getElementById('remoteQr').hidden;
  const remoteCopy = window.document.getElementById('btnRemoteCopy');
  const remoteCert = window.document.getElementById('btnRemoteCert');
  console.log(`  shows the tailnet URL: ${remoteUrlShown ? 'ok' : 'FAILED'} -> ${JSON.stringify(remoteText.slice(0, 80))}`);
  if (!remoteUrlShown) errors.push('the Tailscale card did not show the tailnet URL');
  console.log(`  QR shown: ${remoteQrShown ? 'ok' : 'FAILED'}, copy button: ${!remoteCopy.hidden ? 'ok' : 'FAILED'}, cert button: ${!remoteCert.hidden ? 'ok' : 'FAILED'}`);
  if (!remoteQrShown || remoteCopy.hidden) errors.push('the Tailscale card did not enable the QR/copy controls');

  const recheckBefore = count('/api/remote?recheck=1');
  window.document.getElementById('btnRemoteRecheck').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(40);
  const rechecked = count('/api/remote?recheck=1') > recheckBefore;
  console.log(`  Recheck asks the server to re-detect: ${rechecked ? 'ok' : 'FAILED'}`);
  if (!rechecked) errors.push('the Recheck button did not request a fresh Tailscale status');

  // a helper warning should surface as a banner
  socket.onmessage({ data: JSON.stringify({ type: 'notice', kind: 'input-blocked', message: 'the PC ignored it' }) });
  await wait(20);
  const warningShown = !window.document.getElementById('inputWarning').hidden;
  console.log(`  input-blocked notice -> banner: ${warningShown ? 'ok' : 'FAILED'}`);
  if (!warningShown) errors.push('an input-blocked notice did not show the warning banner');

  console.log(`\npage errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  console.log('\nendpoint calls:');
  for (const c of [...new Set(calls.filter((c) => !c.startsWith('ws.send')))]) console.log(`  ${c}`);

  process.exit(errors.length ? 1 : 0);
})();
