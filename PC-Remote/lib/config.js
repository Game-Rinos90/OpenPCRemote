'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'cert');
const PHONE_DIR = path.join(DATA_DIR, 'phone-storage');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

const DEFAULTS = {
  port: 8443,
  webdavPort: 8243,
  webdavTls: true,
  username: os.userInfo().username,
  passwordHash: '',
  tokenSecret: '',
  sessionHours: 24 * 14,
  capture: { fps: 8, maxWidth: 1280, quality: 55 },
};

function ensureDirs() {
  for (const dir of [DATA_DIR, CERT_DIR, PHONE_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readConfig() {
  ensureDirs();
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }
  return { ...DEFAULTS, ...cfg, capture: { ...DEFAULTS.capture, ...(cfg.capture || {}) } };
}

function writeConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function randomPassword(length = 14) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+';
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    out += alphabet[bytes[i % bytes.length] % alphabet.length];
  }
  return out;
}

/**
 * Loads config. On first run it creates a config with a random password and
 * writes that password to data/INITIAL-PASSWORD.txt so it is never lost.
 */
function loadConfig() {
  const cfg = readConfig();
  let created = false;
  let initialPassword = null;

  if (!cfg.tokenSecret) {
    cfg.tokenSecret = crypto.randomBytes(48).toString('hex');
  }
  if (!cfg.passwordHash) {
    initialPassword = randomPassword();
    cfg.passwordHash = bcrypt.hashSync(initialPassword, 10);
    created = true;
  }
  if (created || !fs.existsSync(CONFIG_FILE)) {
    writeConfig(cfg);
    const credFile = path.join(DATA_DIR, 'INITIAL-PASSWORD.txt');
    fs.writeFileSync(
      credFile,
      [
        'Initial login for PC Remote',
        '==========================',
        `URL:      https://<this-pc-ip>:${cfg.port}`,
        `Username: ${cfg.username}`,
        `Password: ${initialPassword}`,
        '',
        'Change the password from the app (Settings tab), then DELETE this file.',
        '',
      ].join('\r\n'),
      'utf8'
    );
  }
  return { cfg, created, initialPassword };
}

function setPassword(cfg, password) {
  cfg.passwordHash = bcrypt.hashSync(password, 10);
  writeConfig(cfg);
}

/** Issued after login; signed + expiry, no server-side session store needed. */
function makeToken(cfg, user) {
  const payload = {
    u: user,
    exp: Date.now() + cfg.sessionHours * 3600 * 1000,
    n: crypto.randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.tokenSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(cfg, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', cfg.tokenSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPassword(cfg, user, password) {
  if (typeof user !== 'string' || typeof password !== 'string') return false;
  const userOk =
    user.length === cfg.username.length &&
    crypto.timingSafeEqual(Buffer.from(user.toLowerCase()), Buffer.from(cfg.username.toLowerCase()));
  const passOk = bcrypt.compareSync(password, cfg.passwordHash);
  return userOk && passOk;
}

/** Ranking so the address we advertise is the one a phone can actually reach. */
function addressScore(iface, ip) {
  if (ip.startsWith('169.254.')) return 90; // link-local: usually unusable from a phone
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip === '127.0.0.1') return 80;
  if (/^(vEthernet|VirtualBox|VMware|Hyper-V|Loopback|Bluetooth)/i.test(iface)) return 70;
  return 5;
}

/** Every http(s) address this machine is reachable at on the local network. */
function lanUrls(port, protocol = 'https') {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        found.push({ iface: name, ip: addr.address, score: addressScore(name, addr.address) });
      }
    }
  }
  found.sort((a, b) => a.score - b.score || a.ip.localeCompare(b.ip));
  // Drop link-local adapters entirely when a normal LAN address exists.
  const usable = found.filter((a) => a.score < 90);
  const list = (usable.length ? usable : found).map((a) => ({ iface: a.iface, url: `${protocol}://${a.ip}:${port}` }));
  return list;
}

module.exports = {
  DEFAULTS,
  DATA_DIR,
  CERT_DIR,
  PHONE_DIR,
  TMP_DIR,
  CONFIG_FILE,
  loadConfig,
  writeConfig,
  setPassword,
  randomPassword,
  makeToken,
  verifyToken,
  verifyPassword,
  lanUrls,
};
