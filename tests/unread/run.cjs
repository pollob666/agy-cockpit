#!/usr/bin/env node
'use strict';

// Regression harness for the unread (blue dot) / active-chat claim logic in ui.html.
// Runs the REAL ui.html inside headless Chrome/Chromium/Edge: harness.html plays the Antigravity host
// with one Cockpit iframe per opened chat sharing localStorage, and a fake /api/status. Each scenario
// replays a user flow on virtual time (about 1 to 2 s of wall time) and asserts the visible result.
//
//   node tests/unread/run.cjs                     all scenarios against sidecars/agy-cockpit/ui.html
//   node tests/unread/run.cjs --scenario stay     one or more scenarios (comma separated)
//   node tests/unread/run.cjs --ui old.html       another ui.html, e.g. to reproduce a regression
//   node tests/unread/run.cjs --verbose           print snapshots and event logs for every scenario
//   node tests/unread/run.cjs --browser <path>    explicit browser binary (or env AGY_TEST_BROWSER)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const opts = { ui: path.join(REPO, 'sidecars', 'agy-cockpit', 'ui.html'), scenarios: [], verbose: false, browser: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ui') opts.ui = path.resolve(argv[++i] || '');
    else if (a === '--scenario' || a === '--scenarios') opts.scenarios.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--browser') opts.browser = argv[++i] || '';
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function isExecutableFile(p) {
  try {
    return Boolean(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const n of names) {
    for (const d of dirs) {
      for (const ext of exts) {
        const p = path.join(d, n + ext);
        if (isExecutableFile(p)) return p;
      }
    }
  }
  return '';
}

function findBrowser(explicit) {
  const fromEnv = explicit || process.env.AGY_TEST_BROWSER || process.env.CHROME_PATH || '';
  if (fromEnv) return isExecutableFile(fromEnv) ? fromEnv : '';
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  }
  for (const c of candidates) if (isExecutableFile(c)) return c;
  return findOnPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge']);
}

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// --- assertions -----------------------------------------------------------------------------------

function visible(snap) {
  if (!snap) return null;
  const entry = Object.entries(snap.frames || {}).find(([, f]) => f.visible);
  return entry ? Object.assign({ chat: entry[0] }, entry[1]) : null;
}
function tab(snap, ws) {
  const v = visible(snap);
  return (v && v.tabs && v.tabs[ws]) || { active: false, dots: false, blue: false };
}
function anyBlue(snap) {
  const v = visible(snap);
  return Boolean(v && Object.values(v.tabs || {}).some((t) => t.blue));
}

const blueDotAfterLeaving = (claimedChat) => (s) => [
  ['working: antigravity tab shows thinking dots', tab(s.working, 'antigravity').dots],
  ['working: no blue dot before the reply finished', !tab(s.working, 'antigravity').blue],
  ['final: A is unread on the server', s.final && s.final.serverAUnread === true],
  ['final: antigravity tab shows the blue dot', tab(s.final, 'antigravity').blue],
  [`final: active-chat claim is ${claimedChat}`, s.final && s.final.claimed === claimedChat]
];
const noDotWhileWatching = (s) => [
  ['working: antigravity tab shows thinking dots', tab(s.working, 'antigravity').dots],
  ['final: A was marked seen (user is looking at it)', s.final && s.final.serverAUnread === false],
  ['final: no blue dot anywhere', !anyBlue(s.final)],
  ['final: active-chat claim is A', s.final && s.final.claimed === 'A']
];

const SCENARIOS = {
  cockpit_switch: {
    about: 'In A, click another project tab and a chat B in the Cockpit while A works. No pointer over the new Cockpit afterwards (this was the live failure: the hidden iframe of A stole the claim back).',
    checks: blueDotAfterLeaving('B')
  },
  cockpit_switch_interact: {
    about: 'Same as cockpit_switch, but the user interacts with B, so Antigravity stamps B again.',
    checks: blueDotAfterLeaving('B')
  },
  cockpit_return: {
    about: 'cockpit_switch, then click the antigravity tab and the card of A inside the Cockpit of B: the dot shows on the card and clears for good.',
    checks: (s) => [
      ...blueDotAfterLeaving('B')(s),
      ['returning: card A in the list is unread', Boolean(visible(s.returning) && (visible(s.returning).rows || []).includes('A*'))],
      ['returned: A is read on the server', s.returned && s.returned.serverAUnread === false],
      ['returned: A is the visible chat and holds the claim', visible(s.returned) && visible(s.returned).chat === 'A' && s.returned.claimed === 'A'],
      ['returned: no blue dot anywhere', !anyBlue(s.returned)]
    ]
  },
  stay: {
    about: 'The user stays in A until it finishes: no dot, A marked seen.',
    checks: noDotWhileWatching
  },
  native_leave: {
    about: 'While A works the user switches to B from the native Antigravity sidebar (no Cockpit click).',
    checks: blueDotAfterLeaving('B')
  },
  native_enter: {
    about: 'The user is in B, switches to A from the native sidebar and watches A finish: no dot.',
    checks: noDotWhileWatching
  },
  manual_unread: {
    about: 'In A, open the gear menu of A2 in Other Chats and click Mark as unread, then Mark as read.',
    checks: (s) => [
      ['marked: chat on screen stays A (did not switch to A2)', visible(s.marked) && visible(s.marked).chat === 'A'],
      ['marked: card A2 in Other Chats has the blue unread dot', Boolean(visible(s.marked) && (visible(s.marked).rows || []).includes('A2*'))],
      ['marked: antigravity tab shows the blue dot', tab(s.marked, 'antigravity').blue],
      ['cleared: card A2 is read again after Mark as read', Boolean(visible(s.cleared) && (visible(s.cleared).rows || []).includes('A2'))],
      ['cleared: no blue dot anywhere', !anyBlue(s.cleared)]
    ]
  }
};

// --- runner ---------------------------------------------------------------------------------------

function buildWorkDir(uiPath) {
  const ui = fs.readFileSync(uiPath, 'utf-8');
  const headIdx = ui.indexOf('<head>');
  if (headIdx < 0) throw new Error(`No <head> in ${uiPath}`);
  const shim = fs.readFileSync(path.join(HERE, 'shim.js'), 'utf-8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cockpit-unread-'));
  const child = ui.slice(0, headIdx + 6) + '\n<script>\n' + shim + '\n</script>\n' + ui.slice(headIdx + 6);
  fs.writeFileSync(path.join(dir, 'child.html'), child);
  return dir;
}

function runScenario(browser, dir, scenario) {
  const template = fs.readFileSync(path.join(HERE, 'harness.html'), 'utf-8');
  const parentFile = path.join(dir, `parent_${scenario}.html`);
  fs.writeFileSync(parentFile, template.replace('__SCENARIO__', scenario).replace('__CHILD__', 'child.html'));
  const profile = path.join(dir, `profile_${scenario}`);
  // --no-sandbox: Chrome's own sandbox cannot start inside CI containers or agent sandboxes; the page
  // is a local copy of our own ui.html with a mocked bridge and no network access.
  const res = spawnSync(browser, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--window-size=1200,900',
    '--virtual-time-budget=40000',
    '--dump-dom',
    pathToFileURL(parentFile).href
  ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const m = /<pre id="harness-result">([\s\S]*?)<\/pre>/.exec(res.stdout || '');
  if (!m) {
    return { error: `no result in DOM (exit ${res.status}${res.error ? ', ' + res.error.message : ''})` };
  }
  return JSON.parse(decodeHtml(m[1]));
}

function formatSnapshot(snap) {
  const lines = [`    [${snap.label}] t=${snap.t} chat on screen=${snap.ideOpen} claim=${snap.claimed} serverA=${snap.serverAUnread ? 'UNREAD' : 'read'}`];
  for (const [chat, f] of Object.entries(snap.frames || {})) {
    const tabs = Object.entries(f.tabs || {})
      .filter(([k]) => k !== '__all__')
      .map(([k, t]) => k + (t.active ? '*' : '') + (t.dots ? '[dots]' : '') + (t.blue ? '[BLUE]' : ''))
      .join(' ');
    lines.push(`      iframe ${chat} ${f.visible ? '(on screen) ' : '(off screen)'} pinned=${f.pinned} tabs: ${tabs} rows: ${(f.rows || []).join(',')}`);
  }
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(3, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    console.log('Scenarios: ' + Object.keys(SCENARIOS).join(', '));
    return;
  }
  const browser = findBrowser(opts.browser);
  if (!browser) {
    console.error('No Chrome, Chromium or Edge found. Set AGY_TEST_BROWSER or pass --browser <path>.');
    process.exit(2);
  }
  const names = opts.scenarios.length ? opts.scenarios : Object.keys(SCENARIOS);
  for (const n of names) {
    if (!SCENARIOS[n]) {
      console.error(`Unknown scenario "${n}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(2);
    }
  }

  const dir = buildWorkDir(opts.ui);
  console.log(`ui.html : ${opts.ui}`);
  console.log(`browser : ${browser}`);
  let failed = 0;
  try {
    for (const n of names) {
      const result = runScenario(browser, dir, n);
      const byLabel = {};
      for (const s of result.snapshots || []) byLabel[s.label] = s;
      const checks = result.error ? [[result.error, false]] : SCENARIOS[n].checks(byLabel);
      const ok = checks.every(([, pass]) => Boolean(pass));
      if (!ok) failed += 1;
      console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${n}`);
      console.log(`      ${SCENARIOS[n].about}`);
      for (const [label, pass] of checks) {
        if (!pass || opts.verbose) console.log(`      ${pass ? 'ok  ' : 'FAIL'} ${label}`);
      }
      if (!ok || opts.verbose) {
        for (const s of result.snapshots || []) console.log(formatSnapshot(s));
        console.log('    events:');
        for (const l of result.log || []) console.log('      ' + l.join(' | '));
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${names.length - failed}/${names.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

main();
