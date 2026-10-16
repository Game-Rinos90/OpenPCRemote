'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');

const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

const cfgLib = require('./lib/config');
const files = require('./lib/files');
const tsLib = require('./lib/tailscale');
const { InputController } = require('./lib/input');
const { ScreenStreamer } = require('./lib/screen');
const { createWebdavHandler } = require('./lib/webdav');
const { createSniffingServer } = require('./lib/net-helper');

const COOKIE = 'pcrc_session';
const { DATA_DIR, CERT_DIR, TMP_DIR, PHONE_DIR } = cfgLib;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/* ------------------------------------------------------------------ *
 * Password reset helper: node server.js --set-password "my new pass"  *
 * ------------------------------------------------------------------ */
async function maybeHandleCli() {
  const idx = process.argv.indexOf('--set-password');
  if (idx === -1) return false;
  const cfg = cfgLib.loadConfig().cfg;
  const password = process.argv[idx + 1];
  if (!password) {
    console.error('Usage: node server.js --set-password "new password"');
    process.exit(1);
  }
  cfgLib.setPassword(cfg, password);
  console.log(`Password updated for user "${cfg.username}".`);
  process.exit(0);
  return true;
}

/* ---------------------------------- *
 * TLS certificate (self-signed, LAN) *
 * ---------------------------------- */
function loadCertificate() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  // A certificate issued by Tailscale for this machine's tailnet name is
  // publicly trusted, so it wins when present (no browser warning remotely).
  const tsCert = path.join(CERT_DIR, 'tailscale.pem');
  const tsKey = path.join(CERT_DIR, 'tailscale-key.pem');
  if (fs.existsSync(tsCert) && fs.existsSync(tsKey)) {
    return { key: fs.readFileSync(tsKey), cert: fs.readFileSync(tsCert), trusted: true };
  }
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const hostnames = new Set(['localhost', os.hostname(), `${os.hostname().toLowerCase()}`, '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) if (addr.family === 'IPv4') hostnames.add(addr.address);
  }
  // Also cover the tailnet address so the self-signed certificate at least
  // matches the name a remote device uses (the CA is still self-signed).
  const ts = tsLib.getStatus();
  if (ts.ip) hostnames.add(ts.ip);
  if (ts.dnsName) hostnames.add(ts.dnsName);
  const net = require('net');
  const pems = selfsigned.generate([{ name: 'commonName', value: os.hostname() }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [...hostnames].map((value) =>
          net.isIP(value) ? { type: 7, ip: value } : { type: 2, value }
        ),
      },
    ],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

/* --------------------- *
 * Login rate limiting    *
 * --------------------- */
const attempts = new Map();
const MAX_ATTEMPTS = 6;
const LOCK_MS = 10 * 60 * 1000;

function checkRate(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { blocked: false };
  if (entry.until && entry.until > Date.now()) {
    return { blocked: true, retryAfter: Math.ceil((entry.until - Date.now()) / 1000) };
  }
  return { blocked: false };
}

function noteFailure(ip) {
  const entry = attempts.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCK_MS;
    entry.count = 0;
    log(`Too many failed logins from ${ip}, locked for ${LOCK_MS / 60000} minutes`);
  }
  attempts.set(ip, entry);
}

/* ---------- *
 * Main         *
 * ---------- */
async function main() {
  if (await maybeHandleCli()) return;

  const { cfg, created, initialPassword } = cfgLib.loadConfig();
  const app = express();
  const input = new InputController(log);
  const streamer = new ScreenStreamer(cfg.capture, log);

  // Build (or rebuild) the native helper before anything starts using it, so a
  // stale executable is never locked by a running process.
  try {
    require('./lib/native-helper').ensureHelper(log);
  } catch (err) {
    log(`WARNING: ${err.message}`);
    log('Remote control and screen view will not work until the helper builds.');
  }

  input.start();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function currentUser(req) {
    return cfgLib.verifyToken(cfg, parseCookies(req)[COOKIE]);
  }

  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    return next();
  }

  /* ---- auth routes ---- */

  app.post('/api/login', (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const rate = checkRate(ip);
    if (rate.blocked) {
      return res.status(429).json({ error: `Too many attempts. Try again in ${rate.retryAfter}s.` });
    }
    const { username, password } = req.body || {};
    if (!cfgLib.verifyPassword(cfg, String(username || ''), String(password || ''))) {
      noteFailure(ip);
      log(`Failed login for "${username}" from ${ip}`);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    attempts.delete(ip);
    const token = cfgLib.makeToken(cfg, cfg.username);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cfg.sessionHours * 3600}`
    );
    log(`Signed in from ${ip}`);
    return res.json({ ok: true, username: cfg.username });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    const user = currentUser(req);
    res.json({ signedIn: !!user, username: user ? cfg.username : null });
  });

  // Public, non-secret: the addresses this PC answers on + a QR code for them.
  // Shown on the login screen so a phone can reach the app in one scan.
  app.get('/api/urls', async (req, res) => {
    const urls = cfgLib.lanUrls(cfg.port);
    const target = urls[0] ? urls[0].url : `https://localhost:${cfg.port}`;
    const qr = await QRCode.toDataURL(target, { margin: 1, width: 320 });
    res.json({ urls, qr });
  });

  app.post('/api/password', requireAuth, (req, res) => {
    const { current, next } = req.body || {};
    if (!cfgLib.verifyPassword(cfg, cfg.username, String(current || ''))) {
      return res.status(403).json({ error: 'Current password is wrong' });
    }
    if (String(next || '').length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    cfgLib.setPassword(cfg, String(next));
    const passwordFile = path.join(DATA_DIR, 'INITIAL-PASSWORD.txt');
    if (fs.existsSync(passwordFile)) fs.unlinkSync(passwordFile);
    log('Password changed');
    return res.json({ ok: true });
  });

  app.get('/api/info', requireAuth, async (req, res) => {
    const https_urls = cfgLib.lanUrls(cfg.port);
    const webdav = cfgLib.lanUrls(cfg.webdavPort, cfg.webdavTls ? 'https' : 'http');
    const qr = await QRCode.toDataURL(https_urls[0] ? https_urls[0].url : `https://localhost:${cfg.port}`, {
      margin: 1,
      width: 320,
    });
    res.json({
      username: cfg.username,
      hostname: os.hostname(),
      port: cfg.port,
      webdavPort: cfg.webdavPort,
      webdavTls: cfg.webdavTls,
      urls: https_urls,
      webdavUrls: webdav,
      qr,
      storageRoot: PHONE_DIR,
      capture: cfg.capture,
    });
  });

  app.get('/api/remote', requireAuth, async (req, res) => {
    const ts = tsLib.getStatus(cfg.port, { force: req.query.recheck === '1' });
    const trustedCert = fs.existsSync(path.join(CERT_DIR, 'tailscale.pem'));
    const qr = ts.url ? await QRCode.toDataURL(ts.url, { margin: 1, width: 320 }) : null;
    res.json({ ...ts, trustedCert, qr });
  });

  // Fetch a publicly-trusted certificate for this machine's tailnet name.
  // Needs the HTTPS feature enabled for the tailnet in the Tailscale admin
  // console; takes effect after the next restart.
  app.post('/api/remote/cert', requireAuth, (req, res) => {
    const ts = tsLib.getStatus(cfg.port, { force: true });
    if (!ts.running || !ts.dnsName) {
      return res.status(400).json({
        error: 'Tailscale must be connected with MagicDNS enabled before a certificate can be issued.',
      });
    }
    const certFile = path.join(CERT_DIR, 'tailscale.pem');
    const keyFile = path.join(CERT_DIR, 'tailscale-key.pem');
    try {
      tsLib.fetchCertificate(ts.dnsName, certFile, keyFile);
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || '').trim().split(/\r?\n/)[0];
      return res.status(500).json({ error: detail || 'Tailscale could not issue a certificate.' });
    }
    log(`Installed a Tailscale certificate for ${ts.dnsName}`);
    return res.json({ ok: true, restartRequired: true, dnsName: ts.dnsName });
  });

  app.post('/api/capture-settings', requireAuth, (req, res) => {
    const { fps, quality, maxWidth } = req.body || {};
    const next = {
      fps: Math.min(30, Math.max(1, Number(fps) || cfg.capture.fps)),
      quality: Math.min(90, Math.max(20, Number(quality) || cfg.capture.quality)),
      maxWidth: Math.min(2560, Math.max(640, Number(maxWidth) || cfg.capture.maxWidth)),
    };
    cfg.capture = next;
    cfgLib.writeConfig(cfg);
    streamer.setCapture(next);
    streamer.stop(); // restarted with new settings on next viewer
    res.json({ ok: true, capture: next });
  });

  /* ---- file routes ---- */

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, TMP_DIR),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    }),
    limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  });

  app.get('/api/files/list', requireAuth, async (req, res) => {
    try {
      const data = await files.list(PHONE_DIR, req.query.path || '');
      data.usage = await files.diskUsage();
      res.json(data);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/files/upload', requireAuth, upload.array('files', 40), async (req, res) => {
    try {
      const relPath = req.body.relpath || '';
      const saved = [];
      for (const file of req.files || []) {
        saved.push(await files.moveUpload(PHONE_DIR, file.path, relPath, file.originalname));
      }
      res.json({ ok: true, saved });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/files/download', requireAuth, (req, res) => {
    let target;
    try {
      target = files.safeJoin(PHONE_DIR, req.query.path || '');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }
    return res.download(target, path.basename(target));
  });

  app.get('/api/files/raw', requireAuth, (req, res) => {
    let target;
    try {
      target = files.safeJoin(PHONE_DIR, req.query.path || '');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return res.status(404).end();
    res.sendFile(target);
  });

  app.delete('/api/files', requireAuth, async (req, res) => {
    try {
      res.json(await files.remove(PHONE_DIR, req.query.path || ''));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/files/mkdir', requireAuth, async (req, res) => {
    try {
      res.json(await files.mkdir(PHONE_DIR, req.body.path || '', req.body.name || 'New folder'));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/files/rename', requireAuth, async (req, res) => {
    try {
      res.json(await files.rename(PHONE_DIR, req.body.path || '', req.body.name || 'renamed'));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/files/reveal', requireAuth, (req, res) => {
    try {
      res.json(files.revealOnPc(req.body.path || ''));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /* ---- static app ---- */

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    return next();
  });

  /* ---- servers ---- */

  const tls = loadCertificate();

  const webdavHandler = createWebdavHandler({
    root: PHONE_DIR,
    verify: (u, p) => cfgLib.verifyPassword(cfg, u, p),
    log,
    appPort: cfg.port,
  });

  // Each port answers HTTPS *and* plain HTTP. A browser handed a bare
  // "host:port" assumes http:// first; without this the TLS port would just
  // drop the connection (Chrome: ERR_EMPTY_RESPONSE). Plain HTTP gets a 301.
  const appServer = createSniffingServer({
    tlsOptions: tls,
    httpsListener: app,
    redirectPort: cfg.port,
  });
  const server = appServer.server;
  const httpsServer = appServer.httpsServer;

  const webdavServer = cfg.webdavTls
    ? createSniffingServer({ tlsOptions: tls, httpsListener: webdavHandler, redirectPort: cfg.webdavPort })
    : (() => {
        const plain = http.createServer(webdavHandler);
        return { server: plain, close: () => { try { plain.close(); } catch { /* ignore */ } } };
      })();

  /* ---- websocket: remote control + screen frames ---- */

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  httpsServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    if (!cfgLib.verifyToken(cfg, parseCookies(req)[COOKIE])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  streamer.onFrame = (frame) => {
    for (const ws of clients) {
      if (ws.streaming && ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
    }
  };

  streamer.onDims = (dims) => {
    for (const ws of clients) {
      if (ws.streaming && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'screen', ...dims }));
    }
  };

  function sendJson(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  /** Tell every connected client when Windows refuses injected input, so the
   *  phone can explain it instead of looking broken. Rate limited. */
  let lastInputWarning = 0;
  input.onBlocked = (message) => {
    const now = Date.now();
    if (now - lastInputWarning < 30000) return;
    lastInputWarning = now;
    for (const ws of clients) sendJson(ws, { type: 'notice', kind: 'input-blocked', message });
  };

  /** "Test input" in Settings: probe the cursor, nudge it, probe again and
   *  report whether the pointer actually moved. */
  let inputTest = null;
  input.onPos = (x, y) => {
    if (!inputTest) return;
    inputTest.samples.push({ x, y });
    if (inputTest.samples.length === 1) {
      input.send({ type: 'move', dx: 60, dy: 0 });
      inputTest.afterTimer = setTimeout(() => input.send({ type: 'probe' }), 160);
      return;
    }
    clearTimeout(inputTest.afterTimer);
    clearTimeout(inputTest.timeout);
    const [from, to] = inputTest.samples;
    input.send({ type: 'move', dx: from.x - to.x, dy: from.y - to.y });
    const moved = Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 0;
    sendJson(inputTest.ws, { type: 'input-test', ok: moved, from, to });
    inputTest = null;
  };

  wss.on('connection', (ws, req) => {
    ws.streaming = false;
    clients.add(ws);
    log(`Control channel open (${req.socket.remoteAddress}) | viewers=${clients.size}`);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'mouse':
          if (msg.action === 'move') {
            const dx = Math.max(-3000, Math.min(3000, Math.round(msg.dx || 0)));
            const dy = Math.max(-3000, Math.min(3000, Math.round(msg.dy || 0)));
            if (dx || dy) input.send({ type: 'move', dx, dy });
          } else if (msg.action === 'click') {
            const button = msg.button || 'left';
            const count = Math.max(1, Math.min(3, msg.count || 1));
            for (let i = 0; i < count; i++) {
              input.send({ type: 'down', button });
              input.send({ type: 'up', button });
            }
          } else if (msg.action === 'down' || msg.action === 'up') {
            input.send({ type: msg.action, button: msg.button || 'left' });
          } else if (msg.action === 'scroll') {
            input.send({ type: 'scroll', delta: msg.delta || 0, deltaX: msg.deltaX || 0 });
          }
          break;
        case 'key':
          if (msg.action === 'text') {
            const text = String(msg.text || '').slice(0, 512);
            if (text) input.send({ type: 'text', text });
          } else if (['key', 'keydown', 'keyup'].includes(msg.action)) {
            const vk = Number(msg.vk);
            if (vk > 0 && vk < 256) input.send({ type: msg.action, vk });
          } else if (msg.action === 'combo') {
            const vks = (msg.vks || []).map(Number).filter((v) => v > 0 && v < 256).slice(0, 6);
            for (const vk of vks) input.send({ type: 'keydown', vk });
            for (const vk of [...vks].reverse()) input.send({ type: 'keyup', vk });
          }
          break;
        case 'input-test':
          if (inputTest) {
            clearTimeout(inputTest.timeout);
            clearTimeout(inputTest.afterTimer);
          }
          inputTest = { ws, samples: [] };
          inputTest.timeout = setTimeout(() => {
            if (inputTest && inputTest.ws === ws) {
              sendJson(ws, { type: 'input-test', ok: null, message: 'the PC helper did not reply' });
              inputTest = null;
            }
          }, 2500);
          input.send({ type: 'probe' });
          break;
        case 'stream':
          if (msg.on) {
            if (!ws.streaming) {
              ws.streaming = true;
              const last = streamer.addViewer();
              if (streamer.dims) ws.send(JSON.stringify({ type: 'screen', ...streamer.dims }));
              if (last) ws.send(last, { binary: true });
            }
          } else if (ws.streaming) {
            ws.streaming = false;
            streamer.removeViewer();
          }
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (ws.streaming) streamer.removeViewer();
      clients.delete(ws);
      log(`Control channel closed | viewers=${clients.size}`);
    });
    ws.on('error', () => {});
  });

  /* ---- start ---- */

  /** Starts listening, turning the common "port busy" case into a readable message. */
  function listen(server, port, what) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE') {
          const e = new Error(
            `Port ${port} is already in use, so ${what} could not start.\n` +
              '  PC Remote looks like it is already running in another window.\n' +
              `  Use that one (open https://${os.hostname()}:${cfg.port}), or close the\n` +
              '  other window first and start again.'
          );
          e.code = 'EADDRINUSE';
          return reject(e);
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  await listen(server, cfg.port, 'the web app');
  await listen(webdavServer.server, cfg.webdavPort, 'the WebDAV share');

  const urls = cfgLib.lanUrls(cfg.port);
  console.log('');
  console.log('================================================================');
  console.log('  PC Remote is running');
  console.log('================================================================');
  console.log(`  Phone / tablet address : ${urls[0] ? urls[0].url : `https://localhost:${cfg.port}`}`);
  for (const u of urls.slice(1)) console.log(`  Also on this network  : ${u.url}`);
  console.log(`  WebDAV (map as drive)  : ${cfg.webdavTls ? 'https' : 'http'}://${os.hostname()}:${cfg.webdavPort}/phone`);
  const tsStatus = tsLib.getStatus(cfg.port);
  if (tsStatus.url) {
    console.log(`  From anywhere (Tailscale): ${tsStatus.url}`);
  } else if (tsStatus.installed) {
    console.log('  Tailscale is installed but not connected - see the Settings tab.');
  }
  console.log(`  Phone storage folder   : ${PHONE_DIR}`);
  console.log('----------------------------------------------------------------');
  if (created && initialPassword) {
    console.log('  FIRST RUN - save these credentials now:');
    console.log(`    username: ${cfg.username}`);
    console.log(`    password: ${initialPassword}`);
    console.log(`  (also written to ${path.join(DATA_DIR, 'INITIAL-PASSWORD.txt')})`);
    console.log('  Change the password in the Settings tab, then delete that file.');
  } else {
    console.log(`  Username: ${cfg.username}`);
  }
  console.log('  Tip: the phone will warn about the self-signed certificate');
  console.log('       the first time - accept it once per browser.');
  console.log('================================================================');
  console.log('');
  if (urls[0]) {
    QRCode.toString(urls[0].url, { type: 'terminal', small: true }, (err, str) => {
      if (!err) console.log(`  Scan with your phone camera:\n${str}`);
    });
  }

  process.on('SIGINT', () => {
    log('Shutting down');
    input.stop();
    streamer.shutdown();
    appServer.close();
    webdavServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ' + String(err.message).split('\n').join('\n  '));
    console.error('');
    process.exit(1);
  }
  console.error('Fatal error:', err);
  process.exit(1);
});
