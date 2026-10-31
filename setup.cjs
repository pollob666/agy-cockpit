#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = __dirname;
const GEMINI_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR
  ? path.resolve(process.env.ANTIGRAVITY_CONFIG_DIR)
  : path.join(os.homedir(), '.gemini', 'config');

const PLUGIN_SRC_FILE = path.join(REPO_ROOT, 'plugin.json');
const SIDECAR_SRC_DIR = path.join(REPO_ROOT, 'sidecars', 'context-health');
const HOOK_SRC_FILE = path.join(REPO_ROOT, 'hooks', 'context-health-check.cjs');

const LEGACY_SIDECAR_DIR = path.join(GEMINI_CONFIG_DIR, 'sidecars', 'context-health');
const PLUGIN_DEST_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins', 'context-health');
const SIDECAR_DEST_DIR = path.join(PLUGIN_DEST_DIR, 'sidecars', 'context-health');
const HOOK_DEST_FILE = path.join(SIDECAR_DEST_DIR, 'context-health-check.cjs');
const HOOKS_JSON_FILE = path.join(GEMINI_CONFIG_DIR, 'hooks.json');

function resolveNodeExecutable() {
  const execPath = process.execPath;
  if (execPath && fs.existsSync(execPath)) {
    return execPath.replace(/\\/g, '/');
  }
  return 'node';
}

function readExistingHooksJson() {
  if (!fs.existsSync(HOOKS_JSON_FILE)) return {};
  try {
    const raw = fs.readFileSync(HOOKS_JSON_FILE, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function installAll() {
  const nodeBin = resolveNodeExecutable();

  if (fs.existsSync(LEGACY_SIDECAR_DIR)) {
    fs.rmSync(LEGACY_SIDECAR_DIR, { recursive: true, force: true });
  }

  fs.mkdirSync(SIDECAR_DEST_DIR, { recursive: true });
  fs.copyFileSync(PLUGIN_SRC_FILE, path.join(PLUGIN_DEST_DIR, 'plugin.json'));

  const sidecarManifest = JSON.parse(
    fs.readFileSync(path.join(SIDECAR_SRC_DIR, 'sidecar.json'), 'utf-8')
  );
  sidecarManifest.command = nodeBin;
  fs.writeFileSync(
    path.join(SIDECAR_DEST_DIR, 'sidecar.json'),
    JSON.stringify(sidecarManifest, null, 2) + '\n',
    'utf-8'
  );

  for (const filename of ['server.cjs', 'ui.html']) {
    const src = path.join(SIDECAR_SRC_DIR, filename);
    const dest = path.join(SIDECAR_DEST_DIR, filename);
    fs.copyFileSync(src, dest);
  }

  fs.copyFileSync(HOOK_SRC_FILE, HOOK_DEST_FILE);

  const hooksConfig = readExistingHooksJson();
  const quotedNode = nodeBin.includes(' ') ? `"${nodeBin}"` : nodeBin;
  hooksConfig['context-health'] = {
    enabled: true,
    PreInvocation: [
      {
        type: 'command',
        command: `${quotedNode} ./plugins/context-health/sidecars/context-health/context-health-check.cjs`,
        timeout: 5
      }
    ]
  };

  fs.writeFileSync(HOOKS_JSON_FILE, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf-8');

  console.log('[context-health] Installed successfully:');
  console.log('  Platform      :', `${process.platform} (${process.arch})`);
  console.log('  Node binary   :', nodeBin);
  console.log('  Plugin dir    :', PLUGIN_DEST_DIR);
  console.log('  Sidecar dir   :', SIDECAR_DEST_DIR);
  console.log('  Hook script   :', HOOK_DEST_FILE);
  console.log('  Hooks config  :', HOOKS_JSON_FILE);
  console.log('  Sidecar pill  : [Context Health](sidecar://context-health/context-health/ui.html)');
}

function uninstallAll() {
  if (fs.existsSync(LEGACY_SIDECAR_DIR)) {
    fs.rmSync(LEGACY_SIDECAR_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(PLUGIN_DEST_DIR)) {
    fs.rmSync(PLUGIN_DEST_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(HOOKS_JSON_FILE)) {
    const hooksConfig = readExistingHooksJson();
    delete hooksConfig['context-health'];
    fs.writeFileSync(HOOKS_JSON_FILE, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf-8');
  }
  console.log('[context-health] Uninstalled from', GEMINI_CONFIG_DIR);
}

function checkStatus() {
  const pluginOk = fs.existsSync(path.join(PLUGIN_DEST_DIR, 'plugin.json'));
  const sidecarOk =
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'sidecar.json')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'server.cjs')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'ui.html'));
  const hookScriptOk = fs.existsSync(HOOK_DEST_FILE);
  const hooksConfig = readExistingHooksJson();
  const hookRegistered = Boolean(hooksConfig['context-health']);

  console.log(JSON.stringify({
    platform: process.platform,
    configDir: GEMINI_CONFIG_DIR,
    pluginInstalled: pluginOk,
    sidecarInstalled: sidecarOk,
    hookScriptInstalled: hookScriptOk,
    hookRegistered
  }, null, 2));

  if (!pluginOk || !sidecarOk || !hookScriptOk || !hookRegistered) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    uninstallAll();
  } else if (args.includes('--check')) {
    checkStatus();
  } else {
    installAll();
  }
}

module.exports = { installAll, uninstallAll, checkStatus };
