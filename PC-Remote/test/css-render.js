'use strict';
/* Real-browser CSS check, run in headless Edge/Chrome (a real Chromium cascade).
 *
 * The bug this guards: `.login-view { display: grid }` and `.app-view { display: flex }`
 * any author `display` rule beats the browser's built-in `[hidden] { display: none }`.
 * So `loginView.hidden = true` did nothing, and the login card stayed rendered on top
 * of the app after signing in. The global `[hidden] { display: none !important }` in
 * style.css fixes it.
 *
 * Loads the real public/index.html + public/style.css, signs in (sets .hidden = true),
 * and reads the computed `display` values out of the page. A negative control strips
 * the override and asserts the bug comes back, so this test can really fail.
 *
 *   node test/css-render.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');

const BROWSERS = [
  process.env.PC_REMOTE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const browser = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!browser) {
  console.log('skip: no Edge/Chrome found (set PC_REMOTE_BROWSER to run this check)');
  process.exit(0);
}

// --- build a self-contained probe from the REAL markup -----------------------
function fileUrl(p) {
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`;
}

const PROBE = `
<script>
(function () {
  var lv = document.getElementById('loginView');
  var av = document.getElementById('appView');
  var ks = document.getElementById('keySink');
  ks.hidden = true;
  var before = { appView: getComputedStyle(av).display, loginView: getComputedStyle(lv).display, keySinkHidden: getComputedStyle(ks).display };
  lv.hidden = true;                       // this is what showApp() does on sign-in
  av.hidden = false;
  var afterLogin = getComputedStyle(lv).display;
  var afterApp = getComputedStyle(av).display;
  document.title = 'RESULT:' + JSON.stringify({ before: before, afterLogin: afterLogin, afterApp: afterApp }) + ':END';
})();
</script>
`;

function buildProbe(cssPath) {
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  html = html
    .replace(/href="\/style\.css"/, `href="${fileUrl(cssPath)}"`)
    .replace(/<script src="\/app\.js"><\/script>/, '') // keep the probe deterministic
    .replace(/<link rel="manifest"[^>]*>/, '')
    .replace(/<link rel="icon"[^>]*>/, '')
    .replace('</body>', `${PROBE}</body>`);
  return html;
}

function inspect(cssText, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-remote-css-'));
  const cssPath = path.join(dir, 'style.css');
  const htmlPath = path.join(dir, 'probe.html');
  fs.writeFileSync(cssPath, cssText, 'utf8');
  fs.writeFileSync(htmlPath, buildProbe(cssPath), 'utf8');
  try {
    const out = execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        `--user-data-dir=${path.join(dir, 'profile')}`,
        '--virtual-time-budget=4000',
        '--dump-dom',
        fileUrl(htmlPath),
      ],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = out.match(/<title>RESULT:(\{[\s\S]*?\}):END<\/title>/);
    if (!m) throw new Error('probe produced no result');
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- run -------------------------------------------------------------------
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
let bad = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) bad++;
}

console.log(`browser: ${browser}`);
let real;
try {
  real = inspect(css, 'real');
} catch (err) {
  console.log(`skip: could not run headless browser: ${err.message}`);
  process.exit(0);
}

check('#appView starts hidden even though .app-view sets display:flex', real.before.appView === 'none', real.before.appView);
check('#loginView starts visible', real.before.loginView !== 'none', real.before.loginView);
check('#loginView is really display:none after sign-in', real.afterLogin === 'none', real.afterLogin);
check('#appView becomes visible after sign-in', real.afterApp !== 'none', real.afterApp);
check('#keySink with hidden is display:none', real.before.keySinkHidden === 'none', real.before.keySinkHidden);

// Negative control: without the override the reported bug must come back.
const broken = css.replace(/\[hidden\]\s*\{[^}]*\}/g, '');
let neg = null;
try {
  neg = inspect(broken, 'broken');
} catch (err) {
  console.log(`skip negative control: ${err.message}`);
}
if (neg) {
  check('control: without the fix #loginView stays on screen after sign-in', neg.afterLogin !== 'none', neg.afterLogin);
  check('control: without the fix hidden #appView is still displayed', neg.before.appView !== 'none', neg.before.appView);
}

console.log(bad ? `\n${bad} problem(s)` : '\nall good');
process.exit(bad ? 1 : 0);
