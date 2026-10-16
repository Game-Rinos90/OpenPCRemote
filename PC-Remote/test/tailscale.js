'use strict';
/* Unit tests for lib/tailscale.js - the pure parsing/classification helpers.
 * These do not require Tailscale to be installed. */

const assert = require('assert');
const ts = require('../lib/tailscale');

let passed = 0;
const cases = [];
function check(name, fn) {
  cases.push([name, fn]);
}

check('recognises tailnet (CGNAT) IPv4 addresses', () => {
  assert.strictEqual(ts.isCgnatIPv4('100.64.0.1'), true);
  assert.strictEqual(ts.isCgnatIPv4('100.127.255.254'), true);
  assert.strictEqual(ts.isCgnatIPv4('100.101.102.103'), true);
  assert.strictEqual(ts.isCgnatIPv4('100.63.0.1'), false); // just below the range
  assert.strictEqual(ts.isCgnatIPv4('100.128.0.1'), false); // just above the range
  assert.strictEqual(ts.isCgnatIPv4('192.168.1.38'), false);
  assert.strictEqual(ts.isCgnatIPv4(''), false);
  assert.strictEqual(ts.isCgnatIPv4(null), false);
});

check('cleans MagicDNS names and rejects unusable ones', () => {
  assert.strictEqual(ts.cleanDnsName('pc-ryzen.tailnet.ts.net.'), 'pc-ryzen.tailnet.ts.net');
  assert.strictEqual(ts.cleanDnsName('  pc.tail.ts.net  '), 'pc.tail.ts.net');
  assert.strictEqual(ts.cleanDnsName('pc-ryzen.'), null); // single label: no domain
  assert.strictEqual(ts.cleanDnsName(''), null);
  assert.strictEqual(ts.cleanDnsName('a b.ts.net'), null);
  assert.strictEqual(ts.cleanDnsName(undefined), null);
});

check('parses a connected `tailscale status --json`', () => {
  const parsed = ts.parseStatus({
    BackendState: 'Running',
    Self: { Online: true, DNSName: 'pc-ryzen.tailnet.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
    CurrentTailnet: { Name: 'example.com' },
  });
  assert.deepStrictEqual(parsed, {
    state: 'Running',
    online: true,
    ip: '100.101.102.103',
    ipv6: 'fd7a:115c:a1e0::1',
    dnsName: 'pc-ryzen.tailnet.ts.net',
    tailnet: 'example.com',
  });
});

check('prefers the CGNAT IPv4 when several are listed', () => {
  const parsed = ts.parseStatus({ Self: { TailscaleIPs: ['fe80::1', '10.0.0.9', '100.90.1.2'] } });
  assert.strictEqual(parsed.ip, '100.90.1.2');
});

check('handles a logged-out / daemon-stopped status', () => {
  const parsed = ts.parseStatus({ BackendState: 'NeedsLogin', Self: null });
  assert.strictEqual(parsed.state, 'NeedsLogin');
  assert.strictEqual(parsed.ip, null);
  assert.strictEqual(parsed.dnsName, null);
  assert.strictEqual(parsed.online, false);
});

check('is resilient to missing or malformed input', () => {
  assert.deepStrictEqual(ts.parseStatus(null), {
    state: null, online: false, ip: null, ipv6: null, dnsName: null, tailnet: null,
  });
  assert.deepStrictEqual(ts.parseStatus('nonsense'), ts.parseStatus(undefined));
  assert.strictEqual(ts.parseStatus({ Self: { TailscaleIPs: 'not-an-array' } }).ip, null);
});

check('getStatus always returns a shaped object with a url field', () => {
  const status = ts.getStatus(8443, { force: true });
  for (const key of ['installed', 'running', 'state', 'ip', 'dnsName', 'host', 'url']) {
    assert.ok(key in status, `missing key ${key}`);
  }
  assert.strictEqual(typeof status.installed, 'boolean');
  assert.strictEqual(typeof status.running, 'boolean');
  if (status.host) assert.strictEqual(status.url, `https://${status.host}:8443`);
  else assert.strictEqual(status.url, null);
});

check('getStatus never throws even without Tailscale', () => {
  assert.doesNotThrow(() => ts.getStatus(8443, { force: true }));
});

check('findCli locates tailscale.exe under Program Files', () => {
  const fsm = require('fs');
  const osm = require('os');
  const pathm = require('path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'pcrc-ts-'));
  fsm.mkdirSync(pathm.join(dir, 'Tailscale'));
  const exe = pathm.join(dir, 'Tailscale', 'tailscale.exe');
  fsm.writeFileSync(exe, '');

  const keys = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  process.env.ProgramFiles = dir;
  try {
    assert.strictEqual(ts.findCli(), exe);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${passed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
