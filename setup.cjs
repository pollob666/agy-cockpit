#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = __dirname;
const GEMINI_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR
  ? path.resolve(process.env.ANTIGRAVITY_CONFIG_DIR)
  : path.join(os.homedir(), '.gemini', 'config');

const PLUGIN_SRC_FILE = path.join(REPO_ROOT, 'plugin.json');
const SIDECAR_SRC_DIR = path.join(REPO_ROOT, 'sidecars', 'context-health');

const LEGACY_SIDECAR_DIR = path.join(GEMINI_CONFIG_DIR, 'sidecars', 'context-health');
const PLUGIN_DEST_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins', 'context-health');
const SIDECAR_DEST_DIR = path.join(PLUGIN_DEST_DIR, 'sidecars', 'context-health');
const LEGACY_HOOK_DEST_FILE = path.join(SIDECAR_DEST_DIR, 'context-health-check.cjs');
const HOOKS_JSON_FILE = path.join(GEMINI_CONFIG_DIR, 'hooks.json');

function resolveNodeExecutable() {
  const execPath = process.execPath;
  if (execPath && /^node(\.exe)?$/i.test(path.basename(execPath)) && fs.existsSync(execPath)) {
    return execPath.replace(/\\/g, '/');
  }
  const existingManifest = path.join(SIDECAR_DEST_DIR, 'sidecar.json');
  if (fs.existsSync(existingManifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(existingManifest, 'utf-8'));
      if (parsed && typeof parsed.command === 'string' && parsed.command.trim()) {
        return parsed.command.trim().replace(/\\/g, '/');
      }
    } catch {}
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

function restartRunningSidecarServer() {
  const killedPids = new Set();
  const appDirs = [];
  const envAppData = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envAppData) appDirs.push(path.resolve(envAppData));
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const app of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    appDirs.push(path.join(geminiRoot, app));
  }

  const candidates = [];
  const envExecData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envExecData) {
    candidates.push(path.join(path.resolve(envExecData), 'server_info.json'));
  }
  for (const appDir of appDirs) {
    candidates.push(
      path.join(appDir, 'sidecar_data', 'context-health', 'context-health', 'data', 'server_info.json'),
      path.join(appDir, 'sidecar_data', 'context-health', 'data', 'server_info.json'),
      path.join(appDir, 'sidecar_data', 'context-health', 'server.json')
    );
  }

  for (const srvFile of candidates) {
    if (fs.existsSync(srvFile)) {
      try {
        const info = JSON.parse(fs.readFileSync(srvFile, 'utf-8'));
        const pid = Number(info && info.pid);
        if (pid > 0 && pid !== process.pid && !killedPids.has(pid)) {
          process.kill(pid, 'SIGTERM');
          killedPids.add(pid);
        }
      } catch {}
    }
  }

  if (process.platform === 'win32' && killedPids.size === 0) {
    try {
      const psScript =
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'context-health.*[\\\\/]server\\.cjs(\\s|$|\")' } | " +
        "Select-Object -ExpandProperty ProcessId";
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', psScript],
        { encoding: 'utf-8', timeout: 5000 }
      );
      for (const line of String(out || '').split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 0 && pid !== process.pid && !killedPids.has(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            killedPids.add(pid);
          } catch {}
        }
      }
    } catch {}
  }
}

function removeLegacyHookRegistration() {
  if (fs.existsSync(LEGACY_HOOK_DEST_FILE)) {
    try {
      fs.rmSync(LEGACY_HOOK_DEST_FILE, { force: true });
    } catch {}
  }
  if (fs.existsSync(HOOKS_JSON_FILE)) {
    const hooksConfig = readExistingHooksJson();
    if ('context-health' in hooksConfig) {
      delete hooksConfig['context-health'];
      fs.writeFileSync(HOOKS_JSON_FILE, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf-8');
    }
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

  removeLegacyHookRegistration();
  restartRunningSidecarServer();

  console.log('[context-health] Installed successfully:');
  console.log('  Platform      :', `${process.platform} (${process.arch})`);
  console.log('  Node binary   :', nodeBin);
  console.log('  Plugin dir    :', PLUGIN_DEST_DIR);
  console.log('  Sidecar dir   :', SIDECAR_DEST_DIR);
  console.log('  Sidecar pill  : [Context Health](sidecar://context-health/context-health/ui.html)');
}

function uninstallAll() {
  restartRunningSidecarServer();
  removeLegacyHookRegistration();
  if (fs.existsSync(LEGACY_SIDECAR_DIR)) {
    fs.rmSync(LEGACY_SIDECAR_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(PLUGIN_DEST_DIR)) {
    fs.rmSync(PLUGIN_DEST_DIR, { recursive: true, force: true });
  }
  console.log('[context-health] Uninstalled from', GEMINI_CONFIG_DIR);
}

function checkStatus() {
  const pluginOk = fs.existsSync(path.join(PLUGIN_DEST_DIR, 'plugin.json'));
  const sidecarOk =
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'sidecar.json')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'server.cjs')) &&
    fs.existsSync(path.join(SIDECAR_DEST_DIR, 'ui.html'));

  console.log(JSON.stringify({
    platform: process.platform,
    configDir: GEMINI_CONFIG_DIR,
    pluginInstalled: pluginOk,
    sidecarInstalled: sidecarOk
  }, null, 2));

  if (!pluginOk || !sidecarOk) {
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
