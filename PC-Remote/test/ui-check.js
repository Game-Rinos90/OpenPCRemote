'use strict';
// Static consistency check: every DOM id / selector used by public/app.js
// must exist in public/index.html.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));

console.log(`ids in index.html: ${ids.size}, distinct ids used in app.js: ${used.size}`);
console.log(missing.length ? `MISSING IDS: ${missing.join(', ')}` : 'ok: every referenced id exists');

const selectors = [...new Set([...js.matchAll(/querySelector(?:All)?\('([^']+)'\)/g)].map((m) => m[1]))];
console.log('selectors used:', selectors.join(' | '));
for (const sel of selectors) {
  const probe = sel.replace(/\[.*?\]/g, '').replace(/^\./, '');
  // Selectors may target markup that app.js itself renders at runtime.
  const rendered = new RegExp(`class="[^"]*\\b${probe.split(/[ >]/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const present = html.includes(probe) || rendered.test(js);
  console.log(`${present ? 'ok  ' : 'MISS'} ${sel}${present && !html.includes(probe) ? ' (rendered by app.js)' : ''}`);
}

/* --- regression guard: the `hidden` attribute must really hide things ---
 * `.login-view { display: grid }` used to beat the browser's default
 * `[hidden] { display: none }`, so the login section stayed on top of the app
 * after signing in. Any class that sets a display and is also used on an
 * element carrying `hidden` needs the global [hidden] override in style.css. */
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const hiddenTags = [...html.matchAll(/<[^>]*\shidden[^>]*>/g)].map((m) => m[0]);
const hiddenClasses = new Set();
for (const tag of hiddenTags) {
  const cls = tag.match(/class="([^"]*)"/);
  if (cls) cls[1].split(/\s+/).filter(Boolean).forEach((c) => hiddenClasses.add(c));
}
const offenders = [...hiddenClasses].filter((c) =>
  new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*display\\s*:`, 's').test(css)
);
const override = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/i.test(css);
console.log(
  offenders.length
    ? `${override ? 'ok  ' : 'FAIL'} [hidden] override vs display-setting classes (${offenders.join(', ')}) -> ${override ? 'guarded' : 'NOT guarded'}`
    : 'ok   no class both sets display and uses the hidden attribute'
);
