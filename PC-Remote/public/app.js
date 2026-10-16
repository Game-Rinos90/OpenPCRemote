'use strict';

/* =============================== helpers =============================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** Escapes text for safe insertion into innerHTML. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
  } catch {
    throw new Error('Cannot reach the PC — is the app still running?');
  }
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired, sign in again');
  }
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

/** Reads a stored number, falling back to a sane default if it is missing or
 *  corrupt (a NaN speed would silently turn every pointer move into nothing). */
function storedNumber(key, fallback, min, max) {
  try {
    const n = parseFloat(localStorage.getItem(key));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  } catch {
    return fallback;
  }
}

const prefs = {
  speed: storedNumber('speed', 1.6, 0.2, 8),
  scroll: storedNumber('scroll', 1.2, 0.1, 8),
  natural: localStorage.getItem('natural') === '1',
};

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString();
}

/* =============================== auth =============================== */

let signedIn = false;

function showLogin() {
  signedIn = false;
  if (streaming) stopStream(); // don't leave the live view flagged as running across sign-out
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  ws?.close();
}

function showApp() {
  signedIn = true;
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  connect();
  loadInfo();
  loadRemote();
  loadFiles();
  if (streamWanted) startStream();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginError');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPass').value }),
    });
    $('#loginPass').value = '';
    showApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#btnSignOut').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

(async function init() {
  try {
    const s = await api('/api/session');
    if (s.signedIn) showApp();
    else await showLoginHints();
  } catch {
    await showLoginHints();
  }
})();

async function showLoginHints() {
  showLogin();
  try {
    const res = await fetch('/api/urls');
    if (!res.ok) return;
    const data = await res.json();
    if (data.qr) {
      $('#loginQr').src = data.qr;
      $('#loginQr').hidden = false;
    }
    $('#loginUrls').innerHTML = (data.urls || []).map((u) => `<code>${u.url}</code>`).join('');
    const copyBtn = $('#btnCopyLoginUrl');
    if (copyBtn && data.urls && data.urls[0]) copyBtn.dataset.url = data.urls[0].url;
  } catch {
    /* offline - nothing to show */
  }
}

/* =============================== websocket =============================== */

let ws = null;
let wsRetry = 0;

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsRetry = 0;
    $('#statusDot').classList.add('online');
    if (streaming) ws.send(JSON.stringify({ type: 'stream', on: true }));
  };
  ws.onclose = () => {
    $('#statusDot').classList.remove('online');
    if (!signedIn) return;
    const wait = Math.min(15000, 800 * 2 ** wsRetry++);
    setTimeout(connect, wait);
  };
  ws.onerror = () => {};
  ws.onmessage = onSocketMessage;
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function mouse(action, extra = {}) {
  send({ type: 'mouse', action, ...extra });
}

/* =============================== tabs =============================== */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const panel = tab.dataset.panel;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${panel}`));
    if (panel === 'control') {
      // Coming back to the controls: if the live screen was on, bring it back.
      if (streamWanted) startStream();
    } else if (streaming) {
      stopStream();
    }
  });
});

/* =============================== trackpad =============================== */

const pad = $('#trackpad');
const pointers = new Map();
let movePx = { x: 0, y: 0 };
let scrollPx = { y: 0, x: 0 };

function flushPointer() {
  // Guard against a non-finite accumulator (e.g. a corrupt speed setting):
  // NaN would serialize as null and the pointer would never move.
  if (!Number.isFinite(movePx.x) || !Number.isFinite(movePx.y)) movePx = { x: 0, y: 0 };
  if (!Number.isFinite(scrollPx.x) || !Number.isFinite(scrollPx.y)) scrollPx = { x: 0, y: 0 };
  if (movePx.x || movePx.y) {
    const dx = movePx.x;
    const dy = movePx.y;
    movePx = { x: 0, y: 0 };
    mouse('move', { dx: Math.round(dx), dy: Math.round(dy) });
  }
  if (scrollPx.y || scrollPx.x) {
    const delta = Math.round(scrollPx.y);
    const deltaX = Math.round(scrollPx.x);
    scrollPx = { y: 0, x: 0 };
    mouse('scroll', { delta, deltaX });
  }
}
setInterval(flushPointer, 30);

// The pad only moves the pointer (1 finger) and scrolls (2 fingers); clicking
// lives on the dedicated buttons beside it, so a tap can never be misread.
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // Register first, capture second: if capture throws the pad still works.
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    pad.setPointerCapture(e.pointerId);
  } catch {
    /* capture is an optimisation, not required */
  }
  pad.classList.add('active');
});

pad.addEventListener('pointermove', (e) => {
  const known = pointers.get(e.pointerId);
  if (!known) return;
  e.preventDefault();
  const dx = e.clientX - known.x;
  const dy = e.clientY - known.y;
  known.x = e.clientX;
  known.y = e.clientY;

  if (pointers.size === 1) {
    movePx.x += dx * prefs.speed;
    movePx.y += dy * prefs.speed;
  } else {
    const dir = prefs.natural ? 1 : -1;
    scrollPx.y += dy * prefs.scroll * 12 * -dir;
    scrollPx.x += dx * prefs.scroll * 12 * dir;
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) pad.classList.remove('active');
  flushPointer();
}

pad.addEventListener('pointerup', endPointer);
pad.addEventListener('pointercancel', endPointer);
pad.addEventListener('lostpointercapture', endPointer);
pad.addEventListener('contextmenu', (e) => e.preventDefault());

// Left / Right / Middle: hold to press, release to let go. A quick tap is a
// normal click, and holding one down while moving the pad drags.
const heldButtons = new Map(); // pointerId -> button name

function updateHeldClasses() {
  const held = new Set(heldButtons.values());
  $$('.click-btn').forEach((b) => b.classList.toggle('held', held.has(b.dataset.mouse)));
}

function pressButton(pointerId, button) {
  heldButtons.set(pointerId, button);
  updateHeldClasses();
  mouse('down', { button });
}

function releaseButton(pointerId) {
  const button = heldButtons.get(pointerId);
  if (!button) return;
  heldButtons.delete(pointerId);
  updateHeldClasses();
  mouse('up', { button });
}

$$('.click-btn').forEach((btn) => {
  const button = btn.dataset.mouse;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (heldButtons.get(e.pointerId) === button) return;
    if (heldButtons.has(e.pointerId)) releaseButton(e.pointerId);
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pressButton(e.pointerId, button);
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

// Safety net so a missed pointerup can never leave a PC mouse button stuck down.
window.addEventListener('pointerup', (e) => releaseButton(e.pointerId));
window.addEventListener('pointercancel', (e) => releaseButton(e.pointerId));
window.addEventListener('blur', () => {
  for (const id of [...heldButtons.keys()]) releaseButton(id);
});

/* =============================== keyboard =============================== */

const VK = {
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, Delete: 46, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
const MOD = { ctrl: 17, alt: 18, shift: 16, meta: 91 };

function keyToVk(e) {
  if (VK[e.key]) return VK[e.key];
  if (e.key && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return code;
  }
  return 0;
}

const activeMods = new Set();

$$('.chip.toggle[data-mod]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const vk = Number(chip.dataset.mod);
    if (activeMods.has(vk)) {
      activeMods.delete(vk);
      chip.classList.remove('on');
    } else {
      activeMods.add(vk);
      chip.classList.add('on');
    }
  });
});

function clearMods() {
  activeMods.clear();
  $$('.chip.toggle[data-mod]').forEach((c) => c.classList.remove('on'));
}

$$('.chip.mod[data-vk]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const vk = Number(chip.dataset.vk);
    if (activeMods.size) {
      send({ type: 'key', action: 'combo', vks: [...activeMods, vk] });
      clearMods();
    } else {
      send({ type: 'key', action: 'key', vk });
    }
  });
});

$$('.chip.combo[data-vks]').forEach((chip) => {
  chip.addEventListener('click', () => {
    send({ type: 'key', action: 'combo', vks: chip.dataset.vks.split(',').map(Number) });
  });
});

const keySink = $('#keySink');

$('#btnKeyboard').addEventListener('click', () => {
  keySink.focus();
  keySink.value = '';
});

keySink.addEventListener('input', () => {
  const text = keySink.value;
  keySink.value = '';
  if (text) send({ type: 'key', action: 'text', text });
});

keySink.addEventListener('keydown', (e) => {
  const mods = [];
  if (e.ctrlKey) mods.push(MOD.ctrl);
  if (e.altKey) mods.push(MOD.alt);
  if (e.shiftKey && e.key.length !== 1) mods.push(MOD.shift);
  if (e.metaKey) mods.push(MOD.meta);

  const vk = keyToVk(e);
  if (mods.length && vk) {
    e.preventDefault();
    send({ type: 'key', action: 'combo', vks: [...mods, vk] });
    return;
  }
  if (VK[e.key]) {
    e.preventDefault();
    send({ type: 'key', action: 'key', vk: VK[e.key] });
  }
}, true);

document.addEventListener('keydown', (e) => {
  // Keep hardware keys working when the sink is not focused (desktop browser).
  if (document.activeElement === keySink) return;
  if (!signedIn) return;
  if (!$('#panel-control').classList.contains('active')) return;
  const vk = keyToVk(e);
  if (!vk) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const mods = [];
  if (e.ctrlKey) mods.push(MOD.ctrl);
  if (e.altKey) mods.push(MOD.alt);
  if (e.metaKey) mods.push(MOD.meta);
  e.preventDefault();
  if (mods.length) send({ type: 'key', action: 'combo', vks: [...mods, vk] });
  else send({ type: 'key', action: 'key', vk });
});

/* =============================== live view =============================== */

const canvas = $('#screenCanvas');
const ctx = canvas.getContext('2d');
const stage = $('#viewStage');
let streaming = false;
let frames = 0;
let lastStats = Date.now();
let screenDims = null;
let viewControl = false;
let viewTapTime = 0;
// Remembered choice: if you turned the live screen on, it comes back when you
// return to the Control tab (or reopen the app) instead of needing a new tap.
let streamWanted = (() => {
  try { return localStorage.getItem('stream') === '1'; } catch { return false; }
})();

/* --------- zoom & pan ---------
 * The canvas is laid out at its fitted size and then transformed, so the
 * stage can clip it while we zoom in on a small phone screen. */
const zoom = { z: 1, tx: 0, ty: 0 };
const viewPointers = new Map();
let pinch = null;
let viewGesture = null;

function applyZoom() {
  canvas.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.z})`;
  const label = $('#zoomLabel');
  if (label) label.textContent = `${Math.round(zoom.z * 100)}%`;
}

function clampPan() {
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const dw = canvas.offsetWidth * zoom.z;
  const dh = canvas.offsetHeight * zoom.z;
  const ox = canvas.offsetLeft;
  const oy = canvas.offsetTop;
  // Image edges in stage coordinates are `ox + tx` .. `ox + tx + dw`.
  // When it is smaller than the stage it stays centred (tx = 0); otherwise it
  // must keep covering the stage, so it cannot drift past either edge.
  zoom.tx = dw <= sw ? 0 : Math.min(-ox, Math.max(sw - ox - dw, zoom.tx));
  zoom.ty = dh <= sh ? 0 : Math.min(-oy, Math.max(sh - oy - dh, zoom.ty));
}

/** Zoom to `target`, keeping the stage point (cx, cy) under the fingers. */
function zoomAt(target, cx, cy) {
  target = Math.max(1, Math.min(6, target));
  const ox = canvas.offsetLeft;
  const oy = canvas.offsetTop;
  const k = target / zoom.z;
  zoom.tx = cx - ox - (cx - ox - zoom.tx) * k;
  zoom.ty = cy - oy - (cy - oy - zoom.ty) * k;
  zoom.z = target;
  clampPan();
  applyZoom();
}

function resetZoom() {
  zoom.z = 1;
  zoom.tx = 0;
  zoom.ty = 0;
  clampPan();
  applyZoom();
}

function startStream() {
  const overlay = $('#viewOverlay');
  if (overlay) overlay.hidden = true;
  streaming = true;
  frames = 0;
  lastStats = Date.now();
  send({ type: 'stream', on: true });
}

function stopStream() {
  streaming = false;
  const overlay = $('#viewOverlay');
  if (overlay) overlay.hidden = false;
  send({ type: 'stream', on: false });
  $('#viewStats').textContent = '';
  resetZoom();
}

function setStreamWanted(on) {
  streamWanted = on;
  try { localStorage.setItem('stream', on ? '1' : '0'); } catch { /* private mode */ }
  if (on) startStream();
  else stopStream();
}

$('#btnStartStream').addEventListener('click', () => setStreamWanted(true));
$('#btnStopStream').addEventListener('click', () => setStreamWanted(false));

$('#btnFullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
});

// Fit-to-screen is the predictable state after a layout change.
document.addEventListener('fullscreenchange', () => resetZoom());
window.addEventListener('orientationchange', () => setTimeout(resetZoom, 250));

$('#btnViewControl').addEventListener('click', () => {
  viewControl = !viewControl;
  $('#btnViewControl').classList.toggle('on', viewControl);
  canvas.classList.toggle('controlling', viewControl);
});

$('#btnZoomIn').addEventListener('click', () => zoomAt(zoom.z * 1.4, stage.clientWidth / 2, stage.clientHeight / 2));
$('#btnZoomOut').addEventListener('click', () => zoomAt(zoom.z / 1.4, stage.clientWidth / 2, stage.clientHeight / 2));
$('#btnZoomFit').addEventListener('click', resetZoom);

function showInputWarning(message) {
  const box = $('#inputWarning');
  if (!box) return;
  box.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = 'Input is not reaching the PC. ';
  const span = document.createElement('span');
  span.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'chip small';
  btn.type = 'button';
  btn.textContent = 'Dismiss';
  btn.addEventListener('click', () => { box.hidden = true; });
  box.append(strong, span, document.createElement('br'), btn);
  box.hidden = false;
}

$('#btnTestInput').addEventListener('click', () => {
  const out = $('#testInputResult');
  if (out) out.textContent = 'Testing… (the pointer will twitch slightly)';
  send({ type: 'input-test' });
});

async function onSocketMessage(ev) {
  if (typeof ev.data === 'string') {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'screen') screenDims = msg;
      else if (msg.type === 'notice' && msg.kind === 'input-blocked') showInputWarning(msg.message);
      else if (msg.type === 'input-test') {
        const out = $('#testInputResult');
        if (!out) return;
        if (msg.ok === true) {
          out.textContent = `Working ✓ the pointer moved from ${msg.from.x},${msg.from.y} to ${msg.to.x},${msg.to.y}.`;
        } else if (msg.ok === false) {
          out.textContent = 'The PC ignored the movement. Unlock the PC, make sure no elevated window has focus, and try running PC Remote as administrator.';
        } else {
          out.textContent = `No answer from the PC helper: ${msg.message || 'unknown error'}.`;
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }
  if (!streaming) return;
  frames += 1;
  const now = Date.now();
  if (now - lastStats > 1000) {
    const fps = (frames * 1000) / (now - lastStats);
    $('#viewStats').textContent = `${fps.toFixed(1)} fps${screenDims ? ` · ${screenDims.width}×${screenDims.height}` : ''}`;
    frames = 0;
    lastStats = now;
  }
  const blob = new Blob([ev.data], { type: 'image/jpeg' });
  try {
    const bitmap = await createImageBitmap(blob);
    const resized = canvas.width !== bitmap.width || canvas.height !== bitmap.height;
    if (resized) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (resized) {
      clampPan();
      applyZoom();
    }
  } catch {
    /* skip bad frame */
  }
}

/* ---- gestures on the live image ----
 * Remote control ON : 1 finger drags the PC pointer (1:1 through the zoom),
 *                     quick tap clicks, double tap double-clicks.
 * Remote control OFF: 1 finger pans a zoomed image, double tap zooms in/out.
 * Always            : 2 fingers pinch-zoom (and pan). */
function stagePoint(pts) {
  const r = stage.getBoundingClientRect();
  const [a, b] = pts;
  return {
    d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mx: (a.x + b.x) / 2 - r.left,
    my: (a.y + b.y) / 2 - r.top,
  };
}

stage.addEventListener('pointerdown', (e) => {
  if (!streaming) return;
  if (e.target.closest('.view-overlay')) return; // let the Start button work
  e.preventDefault();
  viewPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    stage.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  const pts = [...viewPointers.values()];
  if (pts.length === 1) {
    pinch = null;
    viewGesture = { x: e.clientX, y: e.clientY, start: Date.now(), moved: false };
  } else if (pts.length === 2) {
    viewGesture = null;
    pinch = stagePoint(pts);
  }
});

stage.addEventListener('pointermove', (e) => {
  const known = viewPointers.get(e.pointerId);
  if (!known) return;
  e.preventDefault();
  known.x = e.clientX;
  known.y = e.clientY;
  const pts = [...viewPointers.values()];

  if (pts.length >= 2) {
    const now = stagePoint(pts);
    if (!pinch) pinch = now;
    const factor = now.d / pinch.d;
    pinch.d = now.d;
    if (Math.abs(factor - 1) > 0.001) zoomAt(zoom.z * factor, now.mx, now.my);
    zoom.tx += now.mx - pinch.mx;
    zoom.ty += now.my - pinch.my;
    pinch.mx = now.mx;
    pinch.my = now.my;
    clampPan();
    applyZoom();
    return;
  }

  if (!viewGesture) return;
  const dx = e.clientX - viewGesture.x;
  const dy = e.clientY - viewGesture.y;
  viewGesture.x = e.clientX;
  viewGesture.y = e.clientY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) viewGesture.moved = true;

  if (viewControl) {
    const scaleX = (screenDims?.width || canvas.width) / (canvas.offsetWidth * zoom.z || 1);
    const scaleY = (screenDims?.height || canvas.height) / (canvas.offsetHeight * zoom.z || 1);
    mouse('move', { dx: Math.round(dx * scaleX), dy: Math.round(dy * scaleY) });
  } else {
    zoom.tx += dx;
    zoom.ty += dy;
    clampPan();
    applyZoom();
  }
});

function endViewPointer(e) {
  if (!viewPointers.has(e.pointerId)) return;
  viewPointers.delete(e.pointerId);
  if (viewPointers.size < 2) pinch = null;
  if (viewPointers.size !== 0 || !viewGesture) return;

  const g = viewGesture;
  viewGesture = null;
  if (g.moved || Date.now() - g.start >= 300) return;

  const now = Date.now();
  if (viewControl) {
    mouse('click', { button: 'left', count: now - viewTapTime < 350 ? 2 : 1 });
    viewTapTime = now;
    return;
  }
  if (now - viewTapTime < 350) {
    const r = stage.getBoundingClientRect();
    if (zoom.z > 1.01) resetZoom();
    else zoomAt(2.5, g.x - r.left, g.y - r.top);
  }
  viewTapTime = now;
}

stage.addEventListener('pointerup', endViewPointer);
stage.addEventListener('pointercancel', endViewPointer);
stage.addEventListener('lostpointercapture', endViewPointer);
stage.addEventListener('contextmenu', (e) => {
  if (viewControl) e.preventDefault();
});

/* =============================== files =============================== */

let cwd = '';

$('#btnPickFiles').addEventListener('click', () => $('#fileInput').click());
$('#btnPickFolder').addEventListener('click', () => $('#folderInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => ({ file: f, rel: cwd }));
  e.target.value = '';
  uploadFiles(files);
});
$('#folderInput').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => {
    const rel = (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/');
    return { file: f, rel: [cwd, rel].filter(Boolean).join('/') };
  });
  e.target.value = '';
  uploadFiles(files);
});

$('#btnNewFolder').addEventListener('click', async () => {
  const name = prompt('Folder name');
  if (!name) return;
  await api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path: cwd, name }) });
  loadFiles();
});

$('#btnReveal').addEventListener('click', () => {
  api('/api/files/reveal', { method: 'POST', body: JSON.stringify({ path: cwd }) }).catch(() => {});
});

$('#btnUp').addEventListener('click', () => {
  const parts = cwd.split('/').filter(Boolean);
  parts.pop();
  cwd = parts.join('/');
  loadFiles();
});

const uploadQueue = $('#uploadQueue');

function queueRow(name) {
  const el = document.createElement('div');
  el.className = 'upload-item';
  el.innerHTML = `<span class="label"></span><div class="bar"><i></i></div>`;
  el.querySelector('.label').textContent = name;
  uploadQueue.appendChild(el);
  return el;
}

async function uploadFiles(list) {
  if (!list.length) return;
  let done = 0;
  const rows = list.map((item) => ({ item, el: queueRow(`${item.rel ? `${item.rel}/` : ''}${item.file.name}`) }));

  const worker = async (entry) => {
    const { item, el } = entry;
    const bar = el.querySelector('.bar > i');
    const label = el.querySelector('.label');
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('relpath', item.rel || '');
      form.append('files', item.file, item.file.name);
      xhr.open('POST', '/api/files/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`;
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          el.classList.add('done');
          bar.style.width = '100%';
          label.textContent += '  ✓';
        } else {
          el.classList.add('failed');
          let msg = `failed (${xhr.status})`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          label.textContent += `  ✗ ${msg}`;
        }
        resolve();
      };
      xhr.onerror = () => {
        el.classList.add('failed');
        label.textContent += '  ✗ network error';
        resolve();
      };
      xhr.send(form);
    });
    done += 1;
    if (done === list.length) {
      setTimeout(() => { uploadQueue.innerHTML = ''; }, 4000);
      loadFiles();
    }
  };

  const queue = [...rows];
  const parallel = 2;
  await Promise.all(
    Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      while (queue.length) {
        const next = queue.shift();
        await worker(next);
      }
    })
  );
}

async function loadFiles() {
  try {
    const data = await api(`/api/files/list?path=${encodeURIComponent(cwd)}`);
    renderFiles(data);
  } catch (err) {
    $('#fileList').innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function renderFiles(data) {
  cwd = data.path || '';
  $('#crumbs').textContent = cwd ? `/${cwd}` : '/ (phone storage)';

  const list = $('#fileList');
  list.innerHTML = '';
  if (!data.items.length) {
    list.innerHTML = '<p class="muted small">This folder is empty. Upload something from your phone.</p>';
  }

  for (const item of data.items) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const icon = item.isDir ? '📁' : iconFor(item.name);
    row.innerHTML = `
      <span>${icon}</span>
      <span class="name ${item.isDir ? 'dir' : ''}"></span>
      <span class="meta">${item.isDir ? '' : fmtSize(item.size)}</span>
      <span class="acts"></span>`;
    const nameEl = row.querySelector('.name');
    nameEl.textContent = item.name;
    nameEl.title = fmtDate(item.mtime);
    nameEl.addEventListener('click', () => {
      if (item.isDir) {
        cwd = item.path;
        loadFiles();
      } else {
        window.open(`/api/files/download?path=${encodeURIComponent(item.path)}`, '_blank');
      }
    });

    const acts = row.querySelector('.acts');
    if (!item.isDir) {
      acts.appendChild(actBtn('⬇', 'Download', () => {
        window.open(`/api/files/download?path=${encodeURIComponent(item.path)}`, '_blank');
      }));
    }
    acts.appendChild(actBtn('✎', 'Rename', async () => {
      const name = prompt('New name', item.name);
      if (!name || name === item.name) return;
      await api('/api/files/rename', { method: 'POST', body: JSON.stringify({ path: item.path, name }) });
      loadFiles();
    }));
    acts.appendChild(actBtn('🗑', 'Delete', async () => {
      if (!confirm(`Delete "${item.name}"${item.isDir ? ' and everything inside' : ''}?`)) return;
      await api(`/api/files?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
      loadFiles();
    }));
    list.appendChild(row);
  }

  if (data.usage) {
    $('#storageInfo').textContent = `PC disk: ${fmtSize(data.usage.total - data.usage.free)} used · ${fmtSize(data.usage.free)} free of ${fmtSize(data.usage.total)}`;
  }
}

function actBtn(label, title, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext)) return '🖼️';
  if (['mp4', 'mov', 'mkv', 'webm', '3gp'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['doc', 'docx', 'odt', 'txt', 'md'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['apk'].includes(ext)) return '🤖';
  return '📦';
}

/* =============================== settings =============================== */

let serverInfo = null;

async function loadInfo() {
  try {
    serverInfo = await api('/api/info');
    renderInfo();
  } catch {
    /* ignore */
  }
}

function renderInfo() {
  const info = serverInfo;
  if (!info) return;
  $('#settingsQr').src = info.qr;
  $('#accountUser').textContent = info.username;
  $('#storageRoot').textContent = info.storageRoot;
  $('#settingsUrls').innerHTML = info.urls.map((u) => `<code>${u.url}</code>`).join('') || '<code>https://localhost</code>';
  const webdavList = info.webdavUrls.length
    ? info.webdavUrls
    : [{ url: `${info.webdavTls ? 'https' : 'http'}://${info.hostname}:${info.webdavPort}` }];
  $('#webdavInfo').innerHTML = `
    <p>WebDAV address${webdavList.length > 1 ? 'es' : ''}:</p>
    ${webdavList.map((u) => `<code>${u.url}/phone</code>`).join('')}
    <p>Username: <code>${info.username}</code> · Password: the one you set in the app.</p>
    <p>In Explorer: <em>This PC → Map network drive →</em> paste the address, choose “Connect using different credentials”.</p>`;
  const wdBtn = $('#btnCopyWebdav');
  if (wdBtn && webdavList[0]) wdBtn.dataset.url = `${webdavList[0].url}/phone`;

  const host = info.urls[0] ? new URL(info.urls[0].url).hostname : info.hostname;
  const cmd = `net use Z: ${info.webdavTls ? 'https' : 'http'}://${host}:${info.webdavPort}/phone /user:${info.username} *`;
  $('#btnCopyNetUse').dataset.cmd = cmd;

  const cap = info.capture || {};
  $('#viewFps').value = cap.fps || 8;
  $('#viewQuality').value = cap.quality || 55;
}

/* ---- remote access (Tailscale) ---- */

let remoteInfo = null;

async function loadRemote(recheck = false) {
  try {
    remoteInfo = await api(`/api/remote${recheck ? '?recheck=1' : ''}`);
  } catch {
    remoteInfo = null;
  }
  renderRemote();
}

function renderRemote() {
  const box = $('#remoteStatus');
  if (!box) return;
  const msg = $('#remoteMsg');
  const copyBtn = $('#btnRemoteCopy');
  const certBtn = $('#btnRemoteCert');
  const qrImg = $('#remoteQr');
  const info = remoteInfo;

  msg.textContent = '';
  copyBtn.hidden = true;
  certBtn.hidden = true;
  qrImg.hidden = true;

  if (!info) {
    box.innerHTML = '<p class="muted">Could not read the remote-access status.</p>';
    return;
  }

  if (!info.installed) {
    box.innerHTML =
      '<p>Install <strong>Tailscale</strong> on this PC <em>and</em> on your phone, sign in to the ' +
      'same account, and this app becomes reachable from anywhere — no port forwarding, and nothing ' +
      'is exposed to the public internet.</p>' +
      '<p class="muted">1. Get it from ' +
      '<a href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a> ' +
      'on the phone and sign in. 2. Install it on this PC too and sign in. 3. Tap <strong>Recheck</strong>.</p>';
    return;
  }

  if (!info.running) {
    box.innerHTML =
      `<p>Tailscale is installed but not connected${info.state ? ` (<code>${esc(info.state)}</code>)` : ''}.</p>` +
      '<p class="muted">Open Tailscale on the PC and sign in, then tap <strong>Recheck</strong>.</p>';
    return;
  }

  const url = info.url || '';
  box.innerHTML =
    '<p>Reachable from anywhere on your tailnet:</p>' +
    (url ? `<p><code>${esc(url)}</code></p>` : '') +
    '<p class="muted">Works on mobile data, not just home Wi-Fi — keep Tailscale running on the PC and ' +
    'the phone, then open that address (or scan the QR).</p>' +
    (info.dnsName
      ? ''
      : '<p class="muted">MagicDNS is off, so this is the numeric address. Turn on MagicDNS and HTTPS in ' +
        'the Tailscale admin console to get a name and a trusted certificate.</p>');

  if (url) {
    copyBtn.dataset.url = url;
    copyBtn.hidden = false;
  }
  if (info.qr) {
    qrImg.src = info.qr;
    qrImg.hidden = false;
  }
  if (info.dnsName && !info.trustedCert) {
    certBtn.textContent = 'Get trusted certificate';
    certBtn.hidden = false;
  }
}

$('#btnRemoteRecheck').addEventListener('click', async (e) => {
  const btn = e.target;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  await loadRemote(true);
  btn.disabled = false;
  btn.textContent = label;
});

$('#btnRemoteCopy').addEventListener('click', (e) => {
  copyText(e.target.dataset.url || '', e.target, 'Copy address');
});

$('#btnRemoteCert').addEventListener('click', async (e) => {
  const btn = e.target;
  const label = btn.textContent;
  const msg = $('#remoteMsg');
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  msg.textContent = '';
  try {
    await api('/api/remote/cert', { method: 'POST' });
    msg.textContent = 'Trusted certificate installed. Restart PC Remote (close this window and run start.bat again) to use it.';
    await loadRemote(true);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

async function copyText(text, button, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    prompt('Copy this:', text);
  }
  if (button) {
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = label; }, 1500);
  }
}

$('#btnCopyNetUse').addEventListener('click', (e) => {
  copyText(e.target.dataset.cmd || '', e.target, 'Copy “net use” command');
});

$('#btnCopyWebdav').addEventListener('click', (e) => {
  copyText(e.target.dataset.url || '', e.target, 'Copy address');
});

$('#btnCopyLoginUrl').addEventListener('click', (e) => {
  copyText(e.target.dataset.url || location.origin, e.target, 'Copy this address');
});

$('#btnApplyCapture').addEventListener('click', async () => {
  try {
    const res = await api('/api/capture-settings', {
      method: 'POST',
      body: JSON.stringify({ fps: Number($('#viewFps').value), quality: Number($('#viewQuality').value) }),
    });
    serverInfo.capture = res.capture;
    if (streaming) {
      stopStream();
      setTimeout(startStream, 300);
    }
  } catch (err) {
    alert(err.message);
  }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pwMsg');
  msg.hidden = true;
  try {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#pwCurrent').value, next: $('#pwNext').value }),
    });
    $('#pwCurrent').value = '';
    $('#pwNext').value = '';
    msg.textContent = 'Password updated.';
    msg.style.color = 'var(--ok)';
    msg.hidden = false;
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = 'var(--danger)';
    msg.hidden = false;
  }
});

/* trackpad preferences */
const speedEl = $('#setSpeed');
const scrollEl = $('#setScroll');
const naturalEl = $('#setNatural');
speedEl.value = prefs.speed;
scrollEl.value = prefs.scroll;
naturalEl.checked = prefs.natural;
speedEl.addEventListener('input', () => {
  const v = parseFloat(speedEl.value);
  prefs.speed = Number.isFinite(v) ? v : 1.6;
  localStorage.setItem('speed', prefs.speed);
});
scrollEl.addEventListener('input', () => {
  const v = parseFloat(scrollEl.value);
  prefs.scroll = Number.isFinite(v) ? v : 1.2;
  localStorage.setItem('scroll', prefs.scroll);
});
naturalEl.addEventListener('change', () => {
  prefs.natural = naturalEl.checked;
  localStorage.setItem('natural', prefs.natural ? '1' : '0');
});

/* stop streaming when the page is hidden to save battery, resume on return */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (streaming) stopStream();
  } else if (streamWanted && $('#panel-control').classList.contains('active')) {
    startStream();
  }
});
window.addEventListener('beforeunload', () => {
  if (streaming) send({ type: 'stream', on: false });
});
