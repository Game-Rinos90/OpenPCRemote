'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Tailscale helpers.
 *
 * PC Remote already listens on 0.0.0.0, so the moment Tailscale is running on
 * this PC the app is reachable from every device on your tailnet - phone
 * included - from any network, with no port forwarding. This module only
 * discovers the tailnet identity so the app can advertise and verify it.
 */

// Tailscale hands out addresses from 100.64.0.0/10 (CGNAT range).
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const CACHE_MS = 8000;

function isCgnatIPv4(value) {
  return typeof value === 'string' && CGNAT_V4.test(value);
}

/** "pc.example.ts.net." -> "pc.example.ts.net"; anything unusable -> null. */
function cleanDnsName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\.+$/, '');
  if (!name || !name.includes('.') || /\s/.test(name)) return null;
  return name;
}

/** Pulls the fields we care about out of `tailscale status --json`. */
function parseStatus(json) {
  const result = { state: null, online: false, ip: null, ipv6: null, dnsName: null, tailnet: null };
  if (!json || typeof json !== 'object') return result;

  if (typeof json.BackendState === 'string') result.state = json.BackendState;
  const self = json.Self && typeof json.Self === 'object' ? json.Self : {};
  result.online = self.Online === true;

  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((v) => typeof v === 'string')
    : [];
  result.ip = ips.find(isCgnatIPv4) || ips.find((ip) => ip.includes('.')) || null;
  result.ipv6 = ips.find((ip) => ip.includes(':')) || null;
  result.dnsName = cleanDnsName(self.DNSName);
  if (json.CurrentTailnet && typeof json.CurrentTailnet.Name === 'string') {
    result.tailnet = json.CurrentTailnet.Name || null;
  }
  return result;
}

function fileExists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Locates tailscale.exe in the usual install dirs, then on PATH. */
function findCli() {
  const dirs = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'Tailscale', 'tailscale.exe');
    if (fileExists(candidate)) return candidate;
  }
  const exts = (process.env.PATHEXT || '.EXE').split(path.delimiter).filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const base = path.join(dir, 'tailscale');
    for (const ext of exts) {
      if (fileExists(base + ext)) return base + ext;
    }
  }
  return null;
}

/** Fallback: a tailnet address may exist even when the CLI is not on our PATH. */
function ipFromInterfaces() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && isCgnatIPv4(addr.address)) return addr.address;
    }
  }
  return null;
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function runCli(cli, args, timeout) {
  return execFileSync(cli, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function detect() {
  const cli = findCli();
  let parsed = null;
  let error = null;

  if (cli) {
    try {
      parsed = parseStatus(JSON.parse(runCli(cli, ['status', '--json'], 4000)));
    } catch (err) {
      error = firstLine(err.stderr || err.stdout || err.message);
    }
  }

  const ip = (parsed && parsed.ip) || ipFromInterfaces();
  const dnsName = (parsed && parsed.dnsName) || null;
  const state = (parsed && parsed.state) || (ip ? 'Running' : null);
  const running = state === 'Running' && !!ip;
  const host = dnsName || ip || null;

  return {
    installed: !!cli,
    running,
    state,
    online: !!(parsed && parsed.online),
    ip: ip || null,
    ipv6: (parsed && parsed.ipv6) || null,
    dnsName,
    tailnet: (parsed && parsed.tailnet) || null,
    host,
    error,
  };
}

let cache = { at: 0, value: null };

/** Cached (8s) Tailscale status. Never throws. Pass { force } to refresh. */
function getStatus(port, options = {}) {
  if (options.force || !cache.value || Date.now() - cache.at >= CACHE_MS) {
    cache = { at: Date.now(), value: detect() };
  }
  const value = cache.value;
  return { ...value, url: value.host ? `https://${value.host}:${port}` : null };
}

/**
 * Asks Tailscale for a publicly trusted certificate for this machine's tailnet
 * name (requires HTTPS + MagicDNS enabled for the tailnet in the admin console).
 */
function fetchCertificate(name, certFile, keyFile) {
  const cli = findCli();
  if (!cli) throw new Error('The Tailscale command-line tool was not found.');
  runCli(cli, ['cert', `--cert-file=${certFile}`, `--key-file=${keyFile}`, name], 45000);
  if (!fileExists(certFile) || !fileExists(keyFile)) {
    throw new Error('Tailscale did not write a certificate.');
  }
  return true;
}

module.exports = {
  isCgnatIPv4,
  cleanDnsName,
  parseStatus,
  findCli,
  ipFromInterfaces,
  getStatus,
  fetchCertificate,
};
