'use strict';
/* Big-upload test: mimics a phone pushing a large video file. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const pw = (fs.readFileSync(path.join(__dirname, '..', 'data', 'INITIAL-PASSWORD.txt'), 'utf8').match(/^Password:\s*(.+)$/m) || [])[1];
const BASE = `https://127.0.0.1:${process.env.PORT || cfg.port}`;

(async () => {
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: process.env.PC_REMOTE_PASSWORD || pw }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const size = 60 * 1024 * 1024;
  const name = `large-${Date.now()}.bin`;
  const payload = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) payload[i] = i % 251;

  const form = new FormData();
  form.append('relpath', 'big');
  form.append('files', new Blob([payload]), name);

  const started = Date.now();
  const res = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { cookie }, body: form });
  const body = await res.json();
  const secs = (Date.now() - started) / 1000;
  console.log(`upload status ${res.status}, ${(size / 1024 / 1024).toFixed(0)} MB in ${secs.toFixed(1)}s (${(size / 1024 / 1024 / secs).toFixed(1)} MB/s)`);
  console.log('saved:', JSON.stringify(body.saved || body));

  const dl = await fetch(`${BASE}/api/files/download?path=${encodeURIComponent(`big/${name}`)}`, { headers: { cookie } });
  const back = Buffer.from(await dl.arrayBuffer());
  const sameSize = back.length === size;
  const sameBytes = sameSize && back[0] === payload[0] && back[size - 4096] === payload[size - 4096];
  console.log(`download: ${back.length} bytes, size ok: ${sameSize}, content ok: ${sameBytes}`);

  await fetch(`${BASE}/api/files?path=${encodeURIComponent('big')}`, { method: 'DELETE', headers: { cookie } });
  console.log(sameSize && sameBytes ? 'PASS' : 'FAIL');
  process.exit(sameSize && sameBytes ? 0 : 1);
})();
