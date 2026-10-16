'use strict';
/* End-to-end smoke test for PC Remote. Run while the server is up:
 *   node test/smoke.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const cfgLib = require('../lib/config');
const { ensureHelper } = require('../lib/native-helper');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const PORT = process.env.PORT || cfg.port || 8443;
const BASE = `https://127.0.0.1:${PORT}`;
const WEBDAV = `${cfg.webdavTls === false ? 'http' : 'https'}://127.0.0.1:${process.env.WEBDAV_PORT || cfg.webdavPort || 8243}`;

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

function credentials() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
  const pwFile = path.join(__dirname, '..', 'data', 'INITIAL-PASSWORD.txt');
  let password = process.env.PC_REMOTE_PASSWORD;
  if (!password && fs.existsSync(pwFile)) {
    const m = fs.readFileSync(pwFile, 'utf8').match(/^Password:\s*(.+)$/m);
    if (m) password = m[1].trim();
  }
  return { username: cfg.username, password };
}

let cookie = process.env.PC_REMOTE_COOKIE || '';

async function main() {
  const { username, password } = credentials();
  // Either sign in with the password, or run against an already-signed-in server
  // using a cookie (PC_REMOTE_COOKIE="pcrc_session=...") when the password is not
  // available because the user changed it and deleted INITIAL-PASSWORD.txt.
  if (!password && !cookie) {
    console.error('No password available. Set PC_REMOTE_PASSWORD or PC_REMOTE_COOKIE, or keep data/INITIAL-PASSWORD.txt.');
    process.exit(1);
  }
  console.log(`Testing against ${BASE} as "${username}"${password ? '' : ' (cookie only)'}`);

  console.log('\nHTTP + auth');
  let res = await fetch(`${BASE}/api/session`);
  check('session endpoint answers', res.ok);
  let body = await res.json();
  if (!cookie) check('not signed in initially', body.signedIn === false);

  res = await fetch(`${BASE}/api/urls`);
  body = await res.json();
  check('public urls endpoint returns a QR', typeof body.qr === 'string' && body.qr.startsWith('data:image'));

  res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'definitely-wrong' }),
  });
  check('wrong password rejected', res.status === 401);

  if (password) {
    res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    check('login accepted', res.ok);
    cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])[0].split(';')[0];
    check('session cookie is HttpOnly + Secure + SameSite', /HttpOnly/i.test(res.headers.get('set-cookie')) && /Secure/i.test(res.headers.get('set-cookie')) && /SameSite=Strict/i.test(res.headers.get('set-cookie')));
  } else {
    console.log('  skip login + cookie flags (no password; using PC_REMOTE_COOKIE)');
  }

  res = await fetch(`${BASE}/api/files/list`, { headers: { cookie } });
  body = await res.json();
  check('file listing while signed in', res.ok && Array.isArray(body.items));

  res = await fetch(`${BASE}/api/files/list`);
  check('file listing without cookie is blocked', res.status === 401);

  res = await fetch(`${BASE}/api/files/list?path=../../windows`, { headers: { cookie } });
  check('path traversal blocked', res.status === 400 || res.status === 404);

  console.log('\nRemote access (Tailscale)');
  res = await fetch(`${BASE}/api/remote`, { headers: { cookie } });
  body = await res.json();
  check(
    'remote status endpoint answers',
    res.ok && typeof body.installed === 'boolean' && typeof body.running === 'boolean' && 'url' in body,
    `installed=${body.installed} url=${body.url || 'none'}`
  );
  res = await fetch(`${BASE}/api/remote`);
  check('remote status requires sign-in', res.status === 401);

  console.log('\nFile upload / download / delete');
  const name = `smoke-${Date.now()}.txt`;
  const payload = Buffer.from('hello from the smoke test', 'utf8');
  const form = new FormData();
  form.append('relpath', 'smoke');
  form.append('files', new Blob([payload]), name);
  res = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { cookie }, body: form });
  body = await res.json();
  check('upload succeeded', res.ok && body.saved && body.saved.length === 1, body.error || '');

  res = await fetch(`${BASE}/api/files/download?path=${encodeURIComponent(`smoke/${name}`)}`, { headers: { cookie } });
  const downloaded = Buffer.from(await res.arrayBuffer());
  check('download matches upload', res.ok && downloaded.equals(payload));

  res = await fetch(`${BASE}/api/files/mkdir`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'smoke', name: 'sub' }),
  });
  check('mkdir works', res.ok);

  res = await fetch(`${BASE}/api/files?path=${encodeURIComponent('smoke')}`, { method: 'DELETE', headers: { cookie } });
  check('delete works', res.ok);

  res = await fetch(`${BASE}/api/files?path=`, { method: 'DELETE', headers: { cookie } });
  check('refuses to delete storage root', res.status === 400);

  console.log('\nWebSocket control channel');
  await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { headers: { cookie }, rejectUnauthorized: false });
    let binary = 0;
    let gotDims = false;
    const timer = setTimeout(() => {
      check('screen frames received', binary > 0, `${binary} frames`);
      check('screen dimensions reported', gotDims);
      ws.close();
      resolve();
    }, 6000);
    ws.on('open', () => {
      check('authenticated websocket opens', true);
      ws.send(JSON.stringify({ type: 'stream', on: true }));
      // Harmless round-trip through the input injector (moves right, then back).
      ws.send(JSON.stringify({ type: 'mouse', action: 'move', dx: 25, dy: 0 }));
      ws.send(JSON.stringify({ type: 'mouse', action: 'move', dx: -25, dy: 0 }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) binary += 1;
      else {
        try {
          if (JSON.parse(data.toString()).type === 'screen') gotDims = true;
        } catch { /* ignore */ }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      check('websocket error', false, err.message);
      resolve();
    });
  });

  await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      check('unauthenticated websocket rejected', false);
      ws.close();
      resolve();
    });
    ws.on('error', () => {
      check('unauthenticated websocket rejected', true);
      resolve();
    });
    setTimeout(resolve, 3000);
  });

  console.log('\nWebDAV (network drive)');
  res = await fetch(`${WEBDAV}/phone/`, { method: 'OPTIONS' });
  check('WebDAV requires auth', res.status === 401 && /Basic/.test(res.headers.get('www-authenticate') || ''));

  if (!password) {
    console.log('  skip WebDAV content checks (need the password; set PC_REMOTE_PASSWORD)');
  } else {
    const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    res = await fetch(`${WEBDAV}/phone/`, { method: 'OPTIONS', headers: { authorization: basic } });
    check('OPTIONS advertises DAV class 2', res.ok && /2/.test(res.headers.get('dav') || ''));

    res = await fetch(`${WEBDAV}/phone/`, { method: 'PROPFIND', headers: { authorization: basic, Depth: '1' } });
    const xml = await res.text();
    check('PROPFIND returns multistatus XML', res.status === 207 && xml.includes('<d:multistatus'));

    const davName = `dav-${Date.now()}.txt`;
    res = await fetch(`${WEBDAV}/phone/${davName}`, { method: 'PUT', headers: { authorization: basic }, body: 'via webdav' });
    check('WebDAV PUT writes a file', res.ok && fs.existsSync(path.join(cfgLib.PHONE_DIR, davName)), `status ${res.status}`);

    res = await fetch(`${WEBDAV}/phone/${davName}`, { headers: { authorization: basic } });
    check('WebDAV GET reads it back', (await res.text()) === 'via webdav');

    res = await fetch(`${WEBDAV}/phone/${davName}`, {
      method: 'MOVE',
      headers: { authorization: basic, Destination: `${WEBDAV}/phone/moved-${davName}` },
    });
    check('WebDAV MOVE renames', res.ok);

    res = await fetch(`${WEBDAV}/phone/moved-${davName}`, { method: 'DELETE', headers: { authorization: basic } });
    check('WebDAV DELETE removes', res.ok || res.status === 204);
  }

  console.log('\nInput injector (native helper)');
  await new Promise((resolve) => {
    let exe;
    try {
      exe = ensureHelper((m) => console.log(`       ${m}`));
    } catch (err) {
      check('native helper builds', false, err.message);
      return resolve();
    }
    check('native helper builds', fs.existsSync(exe));
    const proc = spawn(exe, ['input'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdin.write('ping\n');
    setTimeout(() => {
      check('input helper stays alive and quiet', proc.exitCode === null && !stderr.trim(), stderr.trim().slice(0, 200));
      proc.kill();
      resolve();
    }, 2000);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
