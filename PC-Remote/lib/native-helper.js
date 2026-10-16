'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE = path.join(__dirname, 'native', 'RemoteHelper.cs');
const BIN_DIR = path.join(__dirname, '..', 'data', 'bin');
const EXE = path.join(BIN_DIR, 'RemoteHelper.exe');

function findCompiler() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function needsBuild() {
  if (!fs.existsSync(EXE)) return true;
  try {
    return fs.statSync(EXE).mtimeMs < fs.statSync(SOURCE).mtimeMs;
  } catch {
    return true;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killStrayHelpers() {
  try {
    execFileSync('taskkill', ['/IM', 'RemoteHelper.exe', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* none running */
  }
}

function compile(csc, out) {
  const args = [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    `/out:${out}`,
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    SOURCE,
  ];
  execFileSync(csc, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Compiles the native helper with the .NET Framework compiler that ships with
 * Windows. Cached in data/bin so it is built once (and after a source change).
 *
 * The build goes to a temp file and is then swapped in, so a helper that is
 * still running from a previous session (which holds a lock on the .exe) can
 * be replaced instead of failing the build.
 */
function ensureHelper(log = console.log) {
  if (!needsBuild()) return EXE;

  const csc = findCompiler();
  if (!csc) {
    throw new Error(
      'No C# compiler found (looked for csc.exe in %WINDIR%\\Microsoft.NET). Install .NET Framework 4.x and retry.'
    );
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log('Building native helper (first run, takes a few seconds)...');

  const tmp = `${EXE}.new`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  try {
    compile(csc, tmp);
  } catch (err) {
    const details = `${err.stdout || ''}${err.stderr || ''}`.trim();
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`Failed to build native helper:\n${details || err.message}`);
  }
  if (!fs.existsSync(tmp)) throw new Error('Native helper build produced no executable');

  try {
    fs.renameSync(tmp, EXE);
  } catch {
    // An older helper still holds the executable. It cannot be running this
    // build, so stop it and try again.
    log('Replacing a helper that is still running...');
    killStrayHelpers();
    const deadline = Date.now() + 4000;
    let replaced = false;
    while (Date.now() < deadline) {
      try {
        fs.renameSync(tmp, EXE);
        replaced = true;
        break;
      } catch {
        sleepSync(250);
      }
    }
    if (!replaced) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw new Error(`Could not replace ${EXE} - close PC Remote (and any RemoteHelper.exe) and retry.`);
    }
  }
  log(`Native helper ready: ${EXE}`);
  return EXE;
}

module.exports = { ensureHelper, EXE, SOURCE };
