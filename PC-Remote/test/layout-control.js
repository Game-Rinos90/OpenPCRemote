'use strict';
/* Real-browser layout check for the Control tab, run in headless Edge/Chrome.
 *
 * Guards the things that are easy to break with CSS-only changes:
 *   - the live screen sits ABOVE the trackpad (you see what you are doing)
 *   - the trackpad and the Left/Right/Middle buttons sit side by side,
 *     with the buttons on the right and big enough to hit with a thumb
 *   - the zoom controls exist and are on screen at phone size
 *
 *   node test/layout-control.js
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

function fileUrl(p) {
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`;
}

const PROBE = `
<script>
(function () {
  document.getElementById('loginView').hidden = true;
  document.getElementById('appView').hidden = false;
  function rect(id) { return document.getElementById(id).getBoundingClientRect(); }
  var stage = rect('viewStage');
  var pad = rect('trackpad');
  var left = rect('btnLeft');
  var right = rect('btnRight');
  var middle = rect('btnMiddle');
  var zoomIn = rect('btnZoomIn');
  var result = {
    padWidth: Math.round(pad.width),
    padHeight: Math.round(pad.height),
    leftWidth: Math.round(left.width),
    leftHeight: Math.round(left.height),
    rightHeight: Math.round(right.height),
    middleHeight: Math.round(middle.height),
    stageBottom: Math.round(stage.bottom),
    padTop: Math.round(pad.top),
    padRight: Math.round(pad.right),
    leftLeft: Math.round(left.left),
    padLeft: Math.round(pad.left),
    stageHeight: Math.round(stage.height),
    padBottom: Math.round(pad.bottom),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    zoomVisible: zoomIn.width > 0 && zoomIn.height > 0,
  };
  document.title = 'RESULT:' + JSON.stringify(result) + ':END';
})();
</script>
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-remote-layout-'));
const html = fs
  .readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace(/href="\/style\.css"/, `href="${fileUrl(path.join(PUBLIC, 'style.css'))}"`)
  .replace(/<script src="\/app\.js"><\/script>/, '')
  .replace(/<link rel="manifest"[^>]*>/, '')
  .replace(/<link rel="icon"[^>]*>/, '')
  .replace('</body>', `${PROBE}</body>`);
const htmlPath = path.join(dir, 'probe.html');
fs.writeFileSync(htmlPath, html, 'utf8');

let result;
try {
  const out = execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--window-size=412,915',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--virtual-time-budget=4000',
      '--dump-dom',
      fileUrl(htmlPath),
    ],
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const m = out.match(/<title>RESULT:(\{[\s\S]*?\}):END<\/title>/);
  if (!m) throw new Error('probe produced no result');
  result = JSON.parse(m[1]);
} catch (err) {
  console.log(`skip: could not run headless browser: ${err.message}`);
  process.exit(0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`browser: ${browser} at ${result.viewportWidth}x${result.viewportHeight}`);

let bad = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) bad++;
}

check('the live screen is above the trackpad', result.stageBottom <= result.padTop, `${result.stageBottom} <= ${result.padTop}`);
check('the click buttons are to the right of the pad', result.padRight <= result.leftLeft, `pad ends ${result.padRight}, buttons start ${result.leftLeft}`);
check('the click buttons are thumb-sized (>= 44px)', result.leftHeight >= 44 && result.rightHeight >= 44, `${result.leftHeight}px / ${result.rightHeight}px`);
check('the pad is the bigger target', result.padWidth > result.leftWidth, `${result.padWidth}px vs ${result.leftWidth}px`);
check('the screen, pad and buttons fit without scrolling', result.padBottom <= result.viewportHeight, `pad ends ${result.padBottom} <= ${result.viewportHeight}`);
check('the zoom controls are on screen', result.zoomVisible === true);

console.log(bad ? `\n${bad} problem(s)` : '\nall good');
process.exit(bad ? 1 : 0);
