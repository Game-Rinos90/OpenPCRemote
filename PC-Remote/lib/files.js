'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const PHONE_DIR = require('./config').PHONE_DIR;

/** Resolves a client-supplied relative path inside the phone storage root. */
function safeJoin(root, relPath) {
  const cleaned = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const target = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    const err = new Error('Path escapes the storage root');
    err.status = 400;
    throw err;
  }
  return target;
}

function toRel(root, absPath) {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join('/');
}

function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  if (!base || base === '.' || base === '..') return 'unnamed';
  return base;
}

/** Picks a non-colliding file name: photo.jpg -> photo (1).jpg */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

async function list(root, relPath) {
  const dir = safeJoin(root, relPath);
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) {
    const err = new Error('Not a directory');
    err.status = 400;
    throw err;
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      continue;
    }
    items.push({
      name: entry.name,
      path: toRel(root, full),
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
    });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { path: toRel(root, dir), items };
}

async function moveUpload(root, tmpPath, relPath, originalName) {
  const cleanRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const dir = cleanRel ? safeJoin(root, cleanRel) : root;
  await fsp.mkdir(dir, { recursive: true });
  const target = await uniquePath(dir, sanitizeName(originalName));
  try {
    await fsp.rename(tmpPath, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(tmpPath, target);
      await fsp.unlink(tmpPath).catch(() => {});
    } else {
      throw err;
    }
  }
  return { path: toRel(root, target), name: path.basename(target), size: (await fsp.stat(target)).size };
}

async function remove(root, relPath) {
  const target = safeJoin(root, relPath);
  if (path.resolve(target) === path.resolve(root)) {
    const err = new Error('Refusing to delete the storage root');
    err.status = 400;
    throw err;
  }
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

async function mkdir(root, relPath, name) {
  const parent = safeJoin(root, relPath);
  const dir = await uniquePath(parent, sanitizeName(name));
  await fsp.mkdir(dir, { recursive: true });
  return { path: toRel(root, dir) };
}

async function rename(root, relPath, newName) {
  const target = safeJoin(root, relPath);
  const parent = path.dirname(target);
  const dest = await uniquePath(parent, sanitizeName(newName));
  await fsp.rename(target, dest);
  return { path: toRel(root, dest) };
}

async function diskUsage() {
  try {
    const stat = await fsp.statfs(PHONE_DIR);
    return {
      total: stat.blocks * stat.bsize,
      free: stat.bsize * stat.bavail,
    };
  } catch {
    return null;
  }
}

/** Opens the folder in Explorer on the PC itself (handy for setup). */
function revealOnPc(relPath) {
  const target = safeJoin(PHONE_DIR, relPath);
  const stat = fs.existsSync(target) ? target : PHONE_DIR;
  spawn('explorer.exe', [stat.startsWith('-') ? PHONE_DIR : stat], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: toRel(PHONE_DIR, stat) };
}

module.exports = { PHONE_DIR, safeJoin, toRel, sanitizeName, list, moveUpload, remove, mkdir, rename, diskUsage, revealOnPc };
