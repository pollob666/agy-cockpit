'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8091;
const SIDECAR_NAME = 'context-health';
const APP_CANDIDATES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDER_UUID_RE = /\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![/a-z0-9_-])/i;
const CHILD_CONV_RE = /\bconversation(?:Id|_id)?["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const GIT_COMMIT_OUT_RE = /\[[\w./-]+(?:\s+\([^)]+\))?\s+([0-9a-f]{7,12})\]/g;

const FALLBACK_PRELOAD_JS = `(function() {
  const params = new URLSearchParams(window.location.search);
  const boot = window.__SIDECAR_BOOT__ || {};
  const token = params.get('token') || boot.token || '';
  const conversationId = params.get('conversationId') || boot.conversationId || '';
  let currentWorkspaceUris = [];
  let hasInitialWorkspace = false;
  const workspaceListeners = new Set();
  let resolveInitialWorkspace;
  const initialWorkspacePromise = new Promise((r) => { resolveInitialWorkspace = r; });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'theme-change') {
      const vars = (event.data.payload && event.data.payload.cssVariables) || {};
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    } else if (event.data && event.data.type === 'workspace-change') {
      const payload = event.data.payload || {};
      currentWorkspaceUris = Array.isArray(payload.workspaceUris) ? [...payload.workspaceUris] : [];
      hasInitialWorkspace = true;
      resolveInitialWorkspace();
      for (const fn of workspaceListeners) {
        try { fn([...currentWorkspaceUris]); } catch (e) {}
      }
    }
  });

  function secureFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(url, { ...options, headers });
  }

  async function getWorkspaceUris() {
    if (window.parent === window) return [];
    await Promise.race([initialWorkspacePromise, new Promise((r) => setTimeout(r, 400))]);
    return [...currentWorkspaceUris];
  }

  window.sidecar = {
    conversationId,
    fetch: secureFetch,
    getWorkspaceUris,
    onWorkspaceChange(listener) {
      if (typeof listener !== 'function') return () => {};
      workspaceListeners.add(listener);
      if (hasInitialWorkspace) {
        queueMicrotask(() => { if (workspaceListeners.has(listener)) listener([...currentWorkspaceUris]); });
      }
      return () => { workspaceListeners.delete(listener); };
    },
    agent: {
      async sendMessage(message, convId) {
        const res = await secureFetch('/_sidecar/send-message', {
          method: 'POST',
          body: JSON.stringify({ conversationId: convId || conversationId, message })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) {
          throw new Error((data && data.error) || 'Failed to send message to agent');
        }
        return data;
      },
      async startConversation(message, opts = {}) {
        const payload = { message };
        if (opts && typeof opts === 'object') {
          if (opts.model) payload.model = opts.model;
          if (opts.modelId) payload.modelId = opts.modelId;
          if (opts.conversationId) payload.conversationId = opts.conversationId;
          if (opts.projectId) payload.projectId = opts.projectId;
          if (opts.workspacePath) payload.workspacePath = opts.workspacePath;
          if (opts.general) payload.general = true;
        }
        const res = await secureFetch('/_sidecar/new-conversation', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) {
          throw new Error((data && data.error) || 'Failed to start conversation');
        }
        return data;
      }
    },
    ui: {
      toggleConversation(convId) {
        window.parent.postMessage({ type: 'toggle-conversation', payload: { conversationId: convId } }, '*');
      }
    }
  };
})();`;

function isDirectory(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function resolveAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir && isDirectory(envDir)) return envDir;
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const appName of APP_CANDIDATES) {
    const candidate = path.join(geminiRoot, appName);
    if (isDirectory(path.join(candidate, 'brain'))) return candidate;
  }
  for (const appName of APP_CANDIDATES) {
    const candidate = path.join(geminiRoot, appName);
    if (isDirectory(candidate)) return candidate;
  }
  return path.join(geminiRoot, 'antigravity');
}

function resolveProjectsDir() {
  const envDir = process.env.ANTIGRAVITY_PROJECTS_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.gemini', 'config', 'projects');
}

function extractProjectResourcePaths(rawProject) {
  const out = [];
  const seen = new Set();
  const addUri = (uri) => {
    if (!uri || typeof uri !== 'string') return;
    const norm = normalizeWorkspacePath(uri);
    if (!norm) return;
    const key = workspaceComparisonKey(norm);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ path: norm, key, label: getWorkspaceLabel(norm) });
  };

  const resources = rawProject?.projectResources?.resources;
  if (Array.isArray(resources)) {
    for (const r of resources) {
      if (!r || typeof r !== 'object') continue;
      addUri(r.folderUri || r.gitFolder?.folderUri || r.google3Folder?.folderUri);
    }
  }
  const envs = rawProject?.environments?.environments;
  if (Array.isArray(envs)) {
    for (const env of envs) {
      const envRes = env?.resources?.resources;
      if (Array.isArray(envRes)) {
        for (const r of envRes) {
          if (!r || typeof r !== 'object') continue;
          addUri(r.folderUri || r.gitFolder?.folderUri || r.google3Folder?.folderUri);
        }
      }
    }
  }
  return out;
}

function resolveDataDir(appDataDir) {
  const envExecDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envExecDir) {
    try {
      fs.mkdirSync(envExecDir, { recursive: true });
      return envExecDir;
    } catch {}
  }
  const primary = path.join(appDataDir, 'sidecar_data', SIDECAR_NAME, 'data');
  try {
    fs.mkdirSync(primary, { recursive: true });
    return primary;
  } catch {
    const fallback = path.join(os.tmpdir(), 'gemini', 'antigravity', 'sidecar_data', SIDECAR_NAME, 'data');
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }
}

function writeJsonAtomic(filePath, data, mode, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;
  const raw = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  try {
    fs.writeFileSync(tmpPath, raw, { encoding: 'utf-8', mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

function normalizeWorkspacePath(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let p = rawInput.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ''));
      if (process.platform !== 'win32' && !p.startsWith('/')) p = '/' + p;
    }
  }
  p = p.replace(/^["']+|["']+$/g, '').trim();
  p = p.replace(/\\\\/g, '/').replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) {
    p = p.replace(/\/+$/, '');
  }
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  return p;
}

function workspaceComparisonKey(normPath) {
  if (!normPath) return '';
  return process.platform === 'win32' ? normPath.toLowerCase() : normPath;
}

function getWorkspaceLabel(normPath) {
  if (!normPath) return 'Unscoped / General';
  const parts = normPath.split('/').filter(Boolean);
  if (parts.length === 0) return normPath;
  return parts[parts.length - 1];
}

const gitRootLookupCache = new Map();
const knownProjectRootPaths = new Map();

function findGitOrWorkspaceRoot(rawCandidatePath) {
  const norm = normalizeWorkspacePath(rawCandidatePath);
  if (!norm) return '';
  const lower = norm.toLowerCase();
  if (
    lower.includes('/.gemini/') ||
    lower.includes('/node_modules/')
  ) {
    return '';
  }
  let curr = norm;
  const visited = [];
  let foundRoot = '';

  for (let depth = 0; depth < 14; depth++) {
    if (!curr || curr === '/' || /^[a-z]:$/i.test(curr)) break;
    if (gitRootLookupCache.has(curr)) {
      foundRoot = gitRootLookupCache.get(curr);
      break;
    }
    visited.push(curr);
    const gitMarker = path.join(curr, '.git');
    try {
      if (fs.existsSync(gitMarker)) {
        foundRoot = curr;
        break;
      }
    } catch {}
    const currKey = workspaceComparisonKey(curr);
    if (knownProjectRootPaths.has(currKey)) {
      foundRoot = knownProjectRootPaths.get(currKey) || curr;
      break;
    }
    const parent = path.posix.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  for (const v of visited) {
    gitRootLookupCache.set(v, foundRoot);
  }
  return foundRoot;
}

function resolveCanonicalWorkspace(rawCandidatePath) {
  const norm = normalizeWorkspacePath(rawCandidatePath);
  if (!norm) return '';
  return findGitOrWorkspaceRoot(norm) || norm;
}

function cleanUserPrompt(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent;
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
      .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '');
  }
  return text.replace(/\r\n/g, '\n').trim();
}

function cleanModelPreview(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent
    .replace(/<HANDOFF_PROMPT>[\s\S]*?<\/HANDOFF_PROMPT>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<\/?[A-Za-z_][A-Za-z0-9_-]*>/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-*>]\s+/gm, '')
    .replace(/[*_`~]+/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
}

function classifyPollution(compactCount, compactedPrompts = 0) {
  if (compactCount <= 2 && compactedPrompts === 0) {
    return { id: 'fresh', label: 'Fresh', color: '#10b981' };
  }
  if (compactCount <= 5) {
    return { id: 'warm', label: 'Warm', color: '#eab308' };
  }
  if (compactCount <= 9) {
    return { id: 'heavy', label: 'Heavy', color: '#f97316' };
  }
  return { id: 'polluted', label: 'Polluted', color: '#ef4444' };
}

function computeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function extractCheckpointOverview(content) {
  if (!content || typeof content !== 'string') return '';
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(content);
  const body = summaryMatch ? summaryMatch[1] : content;
  const overviewMatch = /#+\s*(?:\d+\.\s*)?Task Overview\s*\n+([\s\S]*?)(?=\n---|\n#+\s|\n<\/summary>|$)/i.exec(body);
  const rawSection = overviewMatch
    ? overviewMatch[1]
    : (summaryMatch
      ? summaryMatch[1]
      : body.replace(/^# Resuming from a compaction\s*\n+(?:You are continuing work[^\n]*\n+)?/i, ''));
  return rawSection
    .replace(/<truncated\s+\d+\s+bytes>/gi, '[...]')
    .replace(/<\/?[A-Za-z_][A-Za-z0-9_-]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, 4000);
}

function extractPathsFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const results = [];
  const pathKeys = [
    'Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath',
    'SearchPath', 'SearchDirectory', 'Cwd', 'path', 'cwd'
  ];
  for (const tc of toolCalls) {
    const args = tc && typeof tc.args === 'object' && tc.args ? tc.args : null;
    if (!args) continue;
    for (const key of pathKeys) {
      if (typeof args[key] === 'string' && args[key].length > 2) {
        results.push(args[key]);
      }
    }
    if (typeof args.CommandLine === 'string') {
      const manifestMatch = /--manifest-path\s+["']?([^"'\s]+)["']?/i.exec(args.CommandLine);
      if (manifestMatch) results.push(manifestMatch[1]);
    }
  }
  return results;
}

function createEmptyEntry(convId) {
  const entry = {
    id: convId,
    mtimeMs: 0,
    size: 0,
    parsedBytes: 0,
    lastActiveIso: '',
    lastActiveMs: 0,
    lastUserInputMs: 0,
    lastViewMs: 0,
    lastSeenMs: 0,
    archived: false,
    markedAsUnread: false,
    isSubagent: false,
    parentConvId: '',
    spawnedSubagentIds: [],
    compactCount: 0,
    lastCompactMs: 0,
    promptsSinceLastCompact: 0,
    promptCount: 0,
    currentTokens: 0,
    lastPlannerTokens: 0,
    baseContextTokens: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    compactTriggerTokens: [],
    workspacePath: '',
    workspaceCounts: {},
    title: '',
    firstPrompt: '',
    lastPrompt: '',
    lastModelResponse: '',
    lastModelResponseMs: 0,
    lastStepType: '',
    lastStepStatus: '',
    lastStepHasToolCalls: false,
    lastStepWaitKind: '',
    lastStepWaitDelayMs: 0,
    lastStepMs: 0,
    latestHandoffPrompt: '',
    latestHandoffMs: 0,
    handoffPendingMs: 0,
    handoffTargetStepIndex: -1,
    awaitingHandoffResponse: false,
    needsFullHandoffRead: false,
    checkpointTargetStepIndex: -1,
    needsFullCheckpointRead: false,
    checkpointOverview: '',
    modelEnum: '',
    modelLabel: '',
    modelResolvedMtimeMs: 0,
    prompts: [],
    mentionedCommits: []
  };
  Object.defineProperty(entry, 'searchCorpusLower', {
    value: '',
    writable: true,
    enumerable: false,
    configurable: true
  });
  return entry;
}

function isTruthyArg(val) {
  if (val === true || val === 1) return true;
  if (typeof val === 'string') {
    const clean = val.replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
    return clean === 'true' || clean === '1';
  }
  return false;
}

function classifyToolCallsWait(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { kind: '', delayMs: 0 };
  }
  let bestKind = '';
  let bestDelayMs = Infinity;

  const pick = (kind, delayMs) => {
    if (
      !bestKind ||
      delayMs < bestDelayMs ||
      (delayMs === bestDelayMs && kind === 'permission')
    ) {
      bestKind = kind;
      bestDelayMs = delayMs;
    }
  };

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const name = typeof tc.name === 'string' ? tc.name.trim() : '';
    const args = tc.args && typeof tc.args === 'object' ? tc.args : {};

    if (name === 'ask_question' || name === 'ask_user' || name === 'ask_followup_question') {
      pick('question', 0);
      continue;
    }
    if (name === 'ask_custom_permission' || name.includes('permission')) {
      pick('permission', 0);
      continue;
    }
    if (name === 'run_command') {
      if (isTruthyArg(args.BypassSandbox)) {
        pick('permission', 2500);
      } else {
        const rawWait = parseInt(String(args.WaitMsBeforeAsync ?? '').replace(/^["'\s]+|["'\s]+$/g, ''), 10);
        const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(Math.max(rawWait, 500), 15000) : 5000;
        pick('permission', waitMs + 2500);
      }
      continue;
    }
    if (
      name === 'read_file' ||
      name === 'write_file' ||
      name === 'edit_file' ||
      name === 'view_file' ||
      name === 'list_dir' ||
      name === 'delete_file'
    ) {
      pick('permission', 2500);
    }
  }

  return bestKind ? { kind: bestKind, delayMs: bestDelayMs } : { kind: '', delayMs: 0 };
}

function getEntryWaitState(entry, nowMs = Date.now()) {
  if (!entry || entry.isSubagent) return '';
  if (entry.lastStepType !== 'PLANNER_RESPONSE' || !entry.lastStepHasToolCalls) return '';
  const kind = entry.lastStepWaitKind || '';
  if (kind !== 'permission' && kind !== 'question') return '';
  const lastAct = Math.max(entry.mtimeMs || 0, entry.lastStepMs || 0, entry.lastActiveMs || 0);
  if (!lastAct) return '';
  const elapsed = nowMs - lastAct;
  if (elapsed > 12 * 60 * 60 * 1000) return '';
  const delayMs = typeof entry.lastStepWaitDelayMs === 'number' ? entry.lastStepWaitDelayMs : 0;
  if (elapsed < delayMs) return '';
  return kind;
}

function isEntryThinking(entry, nowMs = Date.now()) {
  if (!entry || entry.isSubagent) return false;
  if (getEntryWaitState(entry, nowMs)) return false;
  const lastAct = Math.max(entry.mtimeMs || 0, entry.lastStepMs || 0, entry.lastActiveMs || 0);
  if (!lastAct || nowMs - lastAct > 180000) return false;
  if (entry.awaitingHandoffResponse) return true;
  if (entry.lastStepStatus === 'RUNNING') return true;
  if (
    entry.lastStepType === 'USER_INPUT' ||
    entry.lastStepType === 'GENERIC' ||
    entry.lastStepType === 'SYSTEM_MESSAGE'
  ) {
    return true;
  }
  if (entry.lastStepType === 'PLANNER_RESPONSE' && entry.lastStepHasToolCalls) return true;
  return false;
}

function extractMentionedCommits(entry, text) {
  let commitMatch;
  GIT_COMMIT_OUT_RE.lastIndex = 0;
  while ((commitMatch = GIT_COMMIT_OUT_RE.exec(text)) !== null) {
    const sha7 = commitMatch[1].slice(0, 7).toLowerCase();
    if (!entry.mentionedCommits.includes(sha7)) {
      entry.mentionedCommits.push(sha7);
    }
  }
}

function processTranscriptLine(entry, line, isFirstLine) {
  if (!line || line.length < 2) return false;

  const hasUser = line.includes('"type":"USER_INPUT"');
  const hasPlanner = line.includes('"type":"PLANNER_RESPONSE"');
  const hasCheckpoint = line.includes('"type":"CHECKPOINT"');
  const hasSystem = line.includes('"type":"SYSTEM_MESSAGE"');
  const hasGeneric =
    !hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && line.includes('"type":"GENERIC"');
  const hasError =
    !hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && !hasGeneric && line.includes('"type":"ERROR_MESSAGE"');
  const hasSubagentCreation = hasGeneric && line.includes('Created the following subagent');

  if (hasGeneric && !hasSubagentCreation) {
    entry.lastStepType = 'GENERIC';
    entry.lastStepStatus = line.includes('"status":"RUNNING"')
      ? 'RUNNING'
      : (line.includes('"status":"ERROR"') ? 'ERROR' : 'DONE');
    entry.lastStepHasToolCalls = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    const tsMatch = /"created_at"\s*:\s*"([^"]+)"/.exec(line);
    if (tsMatch) {
      const tsMs = Date.parse(tsMatch[1]);
      if (tsMs > 0) {
        entry.lastStepMs = Math.max(entry.lastStepMs || 0, tsMs);
        if (tsMs >= (entry.lastActiveMs || 0)) {
          entry.lastActiveIso = tsMatch[1];
          entry.lastActiveMs = tsMs;
        }
      }
    }
    if (line.includes('[')) {
      extractMentionedCommits(entry, line);
    }
    return false;
  }

  if (hasError) {
    entry.lastStepType = 'ERROR_MESSAGE';
    entry.lastStepStatus = 'ERROR';
    entry.lastStepHasToolCalls = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    return false;
  }

  if (!hasUser && !hasPlanner && !hasCheckpoint && !hasSystem && !hasGeneric && !isFirstLine) {
    return false;
  }

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }

  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
  const createdMs = createdAt ? Date.parse(createdAt) : 0;

  const type = obj.type || '';
  const content = typeof obj.content === 'string' ? obj.content : '';

  if (
    !entry.isSubagent &&
    entry.promptCount === 0 &&
    (type === 'SYSTEM_MESSAGE' || (isFirstLine && content.startsWith('The following is a <SYSTEM_MESSAGE>')))
  ) {
    const senderMatch = SENDER_UUID_RE.exec(content);
    if (senderMatch) {
      entry.isSubagent = true;
      entry.parentConvId = senderMatch[1].toLowerCase();
    }
  }

  if (type === 'USER_INPUT') {
    const clean = cleanUserPrompt(content);
    if (clean) {
      if (clean.startsWith('[Context Health Smart Handoff]')) {
        entry.awaitingHandoffResponse = true;
        return false;
      }
      if (createdAt && createdMs >= entry.lastActiveMs) {
        entry.lastActiveIso = createdAt;
        entry.lastActiveMs = createdMs;
      }
      if (!entry.isSubagent && obj.source !== 'SYSTEM' && createdMs >= (entry.lastUserInputMs || 0)) {
        entry.lastUserInputMs = createdMs;
      }
      entry.lastStepType = 'USER_INPUT';
      entry.lastStepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
      entry.lastStepHasToolCalls = false;
      entry.lastStepWaitKind = '';
      entry.lastStepWaitDelayMs = 0;
      if (createdMs > 0) {
        entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
      }
      entry.awaitingHandoffResponse = false;
      entry.needsFullHandoffRead = false;
      entry.handoffTargetStepIndex = -1;
      entry.promptCount += 1;
      entry.promptsSinceLastCompact += 1;
      if (!entry.firstPrompt) entry.firstPrompt = clean.slice(0, 500);
      entry.lastPrompt = clean.slice(0, 500);
      entry.prompts.push({
        index: entry.promptCount,
        createdAt,
        text: clean.slice(0, 4000)
      });
      if (entry.prompts.length > 60) {
        entry.prompts.splice(0, entry.prompts.length - 60);
      }
      return true;
    }
    return false;
  }

  if (type === 'PLANNER_RESPONSE') {
    if (createdAt && createdMs >= entry.lastActiveMs) {
      entry.lastActiveIso = createdAt;
      entry.lastActiveMs = createdMs;
    }
    const hasTools = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
    const stepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
    const wasAwaitingHandoff = Boolean(entry.awaitingHandoffResponse);
    const waitSpec = hasTools ? classifyToolCallsWait(obj.tool_calls) : { kind: '', delayMs: 0 };
    entry.lastStepType = 'PLANNER_RESPONSE';
    entry.lastStepStatus = stepStatus;
    entry.lastStepHasToolCalls = hasTools;
    entry.lastStepWaitKind = waitSpec.kind;
    entry.lastStepWaitDelayMs = waitSpec.delayMs;
    if (createdMs > 0) {
      entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
    }

    const inTok = typeof obj.input_tokens === 'number' && obj.input_tokens > 0 ? obj.input_tokens : 0;
    const cacheTok = typeof obj.cache_read_tokens === 'number' && obj.cache_read_tokens > 0 ? obj.cache_read_tokens : 0;
    const outTok = typeof obj.output_tokens === 'number' && obj.output_tokens > 0 ? obj.output_tokens : 0;
    const totalTok = inTok + cacheTok;
    if (totalTok > 0) {
      if (!entry.baseContextTokens) {
        const firstPromptTok = entry.firstPrompt ? Math.round(entry.firstPrompt.length / 4) : 0;
        entry.baseContextTokens = Math.max(4000, totalTok - firstPromptTok);
      }
      entry.lastPlannerTokens = totalTok;
      entry.currentTokens = totalTok;
    }
    const stepTotalTok = totalTok + outTok;
    if (stepTotalTok > 0) {
      entry.totalInputTokens = (entry.totalInputTokens || 0) + inTok;
      entry.totalCacheReadTokens = (entry.totalCacheReadTokens || 0) + cacheTok;
      entry.totalOutputTokens = (entry.totalOutputTokens || 0) + outTok;
      entry.totalTokens = entry.totalInputTokens + entry.totalCacheReadTokens + entry.totalOutputTokens;
    }
    let isHandoffStep = false;
    if (content && content.trim()) {
      const trimmedContent = content.trim();
      const isTruncatedContent =
        Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('content');
      const handoffMatch = /<HANDOFF_PROMPT>\s*([\s\S]*?)\s*<\/HANDOFF_PROMPT>/i.exec(trimmedContent);
      if (handoffMatch && handoffMatch[1].trim() && !isTruncatedContent) {
        isHandoffStep = true;
        entry.latestHandoffPrompt = handoffMatch[1].trim();
        entry.latestHandoffMs = Math.max(createdMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
        entry.awaitingHandoffResponse = false;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
      } else if (
        isTruncatedContent &&
        (/<HANDOFF_PROMPT>/i.test(trimmedContent) ||
          (entry.awaitingHandoffResponse && (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)))
      ) {
        isHandoffStep = true;
        entry.needsFullHandoffRead = true;
        entry.handoffTargetStepIndex = typeof obj.step_index === 'number' ? obj.step_index : -1;
        entry.handoffPendingMs = Math.max(createdMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
        entry.awaitingHandoffResponse = false;
      } else if (
        entry.awaitingHandoffResponse &&
        (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)
      ) {
        isHandoffStep = true;
        entry.latestHandoffPrompt = trimmedContent;
        entry.latestHandoffMs = Math.max(createdMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
        entry.awaitingHandoffResponse = false;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
      } else if (!wasAwaitingHandoff) {
        const preview = cleanModelPreview(trimmedContent);
        if (preview) {
          entry.lastModelResponse = preview;
        }
      }
    }

    if (
      !isHandoffStep &&
      !wasAwaitingHandoff &&
      !hasTools &&
      stepStatus !== 'RUNNING' &&
      (entry.promptCount > 0 || entry.lastModelResponse)
    ) {
      const respTs = createdMs || entry.lastActiveMs || 0;
      if (respTs > 0) {
        entry.lastModelResponseMs = Math.max(entry.lastModelResponseMs || 0, respTs);
      }
    }

    if (Array.isArray(obj.tool_calls)) {
      if (!entry.workspaceCounts || typeof entry.workspaceCounts !== 'object') {
        entry.workspaceCounts = {};
      }
      const rawPaths = extractPathsFromToolCalls(obj.tool_calls);
      for (const rp of rawPaths) {
        const root = findGitOrWorkspaceRoot(rp);
        if (root) {
          const nextCount = (entry.workspaceCounts[root] || 0) + 1;
          entry.workspaceCounts[root] = nextCount;
          const curBest = entry.workspacePath ? (entry.workspaceCounts[entry.workspacePath] || 0) : 0;
          if (!entry.workspacePath || nextCount >= curBest) {
            entry.workspacePath = root;
          }
          break;
        }
      }
    }
    return false;
  }

  if (type === 'CHECKPOINT') {
    entry.compactCount += 1;
    if (createdAt) {
      entry.lastCompactMs = createdMs || entry.lastActiveMs;
    }
    if (createdAt && createdMs >= entry.lastActiveMs) {
      entry.lastActiveIso = createdAt;
      entry.lastActiveMs = createdMs;
    }
    entry.promptsSinceLastCompact = 0;
    if (entry.lastPlannerTokens > 0) {
      entry.compactTriggerTokens.push(entry.lastPlannerTokens);
      if (entry.compactTriggerTokens.length > 25) {
        entry.compactTriggerTokens.shift();
      }
    }
    const truncMatch = /<truncated\s+(\d+)\s+bytes>/i.exec(content);
    const extraBytes = truncMatch ? (parseInt(truncMatch[1], 10) || 0) : 0;
    const summaryTokens = Math.max(500, Math.round((content.length + extraBytes) / 4));
    const baseTok = entry.baseContextTokens > 0 ? entry.baseContextTokens : 21000;
    const estimatedPostCompact = baseTok + summaryTokens;
    entry.currentTokens = entry.lastPlannerTokens > 0
      ? Math.min(entry.lastPlannerTokens, estimatedPostCompact)
      : estimatedPostCompact;
    const isTruncatedContent =
      (Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('content')) ||
      content.includes('\n<truncated ');
    if (isTruncatedContent) {
      entry.needsFullCheckpointRead = true;
      entry.checkpointTargetStepIndex = typeof obj.step_index === 'number' ? obj.step_index : -1;
    } else {
      entry.needsFullCheckpointRead = false;
      entry.checkpointTargetStepIndex = -1;
    }
    const overview = extractCheckpointOverview(content);
    if (overview) {
      entry.checkpointOverview = overview;
      return true;
    }
    return false;
  }

  if (type === 'GENERIC' || type === 'SYSTEM_MESSAGE') {
    entry.lastStepType = type === 'GENERIC' ? 'GENERIC' : 'SYSTEM_MESSAGE';
    entry.lastStepStatus = typeof obj.status === 'string' ? obj.status : 'DONE';
    entry.lastStepHasToolCalls = false;
    entry.lastStepWaitKind = '';
    entry.lastStepWaitDelayMs = 0;
    if (createdMs > 0) {
      entry.lastStepMs = Math.max(entry.lastStepMs || 0, createdMs);
    }
    if (type === 'GENERIC' && hasSubagentCreation) {
      const m = CHILD_CONV_RE.exec(content);
      if (m && UUID_RE.test(m[1])) {
        const childId = m[1].toLowerCase();
        if (childId !== entry.id && !entry.spawnedSubagentIds.includes(childId)) {
          entry.spawnedSubagentIds.push(childId);
        }
      }
    } else if (type === 'SYSTEM_MESSAGE' && !entry.isSubagent) {
      const m = SENDER_UUID_RE.exec(content);
      if (m && UUID_RE.test(m[1])) {
        const childId = m[1].toLowerCase();
        if (childId !== entry.id && !entry.spawnedSubagentIds.includes(childId)) {
          entry.spawnedSubagentIds.push(childId);
        }
      }
    }
    if (content.includes('[')) {
      extractMentionedCommits(entry, content);
    }
  }
  return false;
}

function decodePbtxtString(escaped) {
  if (!escaped) return '';
  const bytes = [];
  let i = 0;
  while (i < escaped.length) {
    if (escaped[i] === '\\' && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next >= '0' && next <= '7') {
        let oct = next;
        let step = 2;
        if (i + 2 < escaped.length && escaped[i + 2] >= '0' && escaped[i + 2] <= '7') {
          oct += escaped[i + 2];
          step += 1;
          if (i + 3 < escaped.length && escaped[i + 3] >= '0' && escaped[i + 3] <= '7') {
            oct += escaped[i + 3];
            step += 1;
          }
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += step;
        continue;
      }
      if (next === 'n') bytes.push(10);
      else if (next === 'r') bytes.push(13);
      else if (next === 't') bytes.push(9);
      else if (next === '"' || next === '\'' || next === '\\') bytes.push(next.charCodeAt(0));
      else bytes.push(...Buffer.from(next, 'utf-8'));
      i += 2;
      continue;
    }
    const codePoint = escaped.codePointAt(i);
    const charStr = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(charStr, 'utf-8'));
    i += charStr.length;
  }
  return Buffer.from(bytes).toString('utf-8').trim();
}

function extractTitleFromPbtxt(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const match = /\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!match) return '';
  return decodePbtxtString(match[1]);
}

function extractAnnotationFromPbtxt(raw) {
  if (!raw || typeof raw !== 'string') {
    return { title: '', lastViewMs: 0, archived: false, markedAsUnread: false };
  }
  const title = extractTitleFromPbtxt(raw);
  const viewMatch = /\blast_user_view_time\s*:?\s*\{\s*seconds\s*:\s*(\d+)(?:\s+nanos\s*:\s*(\d+))?\s*\}/.exec(raw);
  let lastViewMs = 0;
  if (viewMatch) {
    const sec = parseInt(viewMatch[1], 10) || 0;
    const nanos = viewMatch[2] ? (parseInt(viewMatch[2], 10) || 0) : 0;
    if (sec > 0) {
      lastViewMs = sec * 1000 + Math.floor(nanos / 1e6);
    }
  }
  const archived = /\barchived\s*:\s*true\b/i.test(raw);
  const markedAsUnread = /\bmarked_as_unread\s*:\s*true\b/i.test(raw);
  return { title, lastViewMs, archived, markedAsUnread };
}

function rebuildSearchCorpus(entry) {
  const parts = [];
  if (entry.title) parts.push(entry.title);
  if (entry.firstPrompt) parts.push(entry.firstPrompt);
  if (entry.lastPrompt) parts.push(entry.lastPrompt);
  if (entry.checkpointOverview) parts.push(entry.checkpointOverview);
  for (const p of entry.prompts) {
    parts.push(p.text);
  }
  Object.defineProperty(entry, 'searchCorpusLower', {
    value: parts.join('\n').toLowerCase(),
    writable: true,
    enumerable: false,
    configurable: true
  });
}

const REFLOG_ACTION_RE = /^(?:commit(?:\s*\([^)]+\))?:|merge\b|pull\b|cherry-pick\b|rebase(?:\s*\((?!start\b|finish\b|abort\b)[^)]+\))?:)/i;
const CHECKPOINT_TOKEN = Buffer.from('"type":"CHECKPOINT"');

function resolveFullCheckpointOverview(entry, transcriptPath) {
  if (!entry.needsFullCheckpointRead) return false;
  entry.needsFullCheckpointRead = false;
  const targetStep = typeof entry.checkpointTargetStepIndex === 'number' ? entry.checkpointTargetStepIndex : -1;
  entry.checkpointTargetStepIndex = -1;

  const fullPath = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  if (!isFile(fullPath)) return false;

  let fullFd;
  try {
    const fStat = fs.statSync(fullPath);
    if (fStat.size <= 0) return false;
    fullFd = fs.openSync(fullPath, 'r');

    const windowSize = 2 * 1024 * 1024;
    const overlap = 256 * 1024;
    let endPos = fStat.size;

    while (endPos > 0) {
      const startPos = Math.max(0, endPos - windowSize);
      const readLen = endPos - startPos;
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fullFd, buf, 0, readLen, startPos);
      const slice = buf.subarray(0, bytesRead);

      let searchFrom = slice.length;
      while (searchFrom > 0) {
        const idx = slice.lastIndexOf(CHECKPOINT_TOKEN, searchFrom - 1);
        if (idx < 0) break;
        const lineStartNl = slice.lastIndexOf(0x0a, idx);
        if (lineStartNl < 0 && startPos > 0) {
          break;
        }
        const lineStart = lineStartNl < 0 ? 0 : lineStartNl + 1;
        const lineEndNl = slice.indexOf(0x0a, idx);
        const lineEnd = lineEndNl < 0 ? slice.length : lineEndNl;
        const lineStr = slice.subarray(lineStart, lineEnd).toString('utf-8').trim();
        searchFrom = lineStart;

        if (!lineStr) continue;
        try {
          const fObj = JSON.parse(lineStr);
          if (fObj.type !== 'CHECKPOINT') continue;
          if (targetStep >= 0 && typeof fObj.step_index === 'number' && fObj.step_index !== targetStep) {
            continue;
          }
          const overview = extractCheckpointOverview(fObj.content);
          if (overview) {
            entry.checkpointOverview = overview;
            return true;
          }
          return false;
        } catch {}
      }

      if (startPos === 0) break;
      endPos = Math.min(endPos - 1, startPos + overlap);
    }
  } catch {} finally {
    if (fullFd !== undefined) {
      try { fs.closeSync(fullFd); } catch {}
    }
  }
  return false;
}

function resolveFullHandoffPrompt(entry, transcriptPath) {
  if (!entry.needsFullHandoffRead) return false;
  const fullPath = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  if (!isFile(fullPath)) {
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
    return false;
  }

  let fullFd;
  let found = false;
  try {
    const fStat = fs.statSync(fullPath);
    const rSize = Math.min(fStat.size, 256 * 1024);
    fullFd = fs.openSync(fullPath, 'r');
    const fBuf = Buffer.allocUnsafe(rSize);
    const fRead = fs.readSync(fullFd, fBuf, 0, rSize, Math.max(0, fStat.size - rSize));
    const fLines = fBuf.subarray(0, fRead).toString('utf-8').split('\n');
    const targetStep = typeof entry.handoffTargetStepIndex === 'number' ? entry.handoffTargetStepIndex : -1;

    for (let i = fLines.length - 1; i >= 0; i--) {
      const fl = fLines[i].trim();
      if (!fl || !fl.includes('"type":"PLANNER_RESPONSE"')) continue;
      try {
        const fObj = JSON.parse(fl);
        if (fObj.type !== 'PLANNER_RESPONSE') continue;
        if (targetStep >= 0 && typeof fObj.step_index === 'number' && fObj.step_index !== targetStep) {
          continue;
        }
        if (typeof fObj.content === 'string' && fObj.content.trim()) {
          const m = /<HANDOFF_PROMPT>\s*([\s\S]*?)\s*<\/HANDOFF_PROMPT>/i.exec(fObj.content);
          if (m && m[1].trim()) {
            entry.latestHandoffPrompt = m[1].trim();
            found = true;
          } else if (!Array.isArray(fObj.tool_calls) || fObj.tool_calls.length === 0) {
            entry.latestHandoffPrompt = fObj.content.trim();
            found = true;
          }
        }
        if (found || targetStep >= 0) break;
      } catch {}
    }
  } catch {} finally {
    if (fullFd !== undefined) {
      try { fs.closeSync(fullFd); } catch {}
    }
  }

  if (found) {
    entry.latestHandoffMs = Math.max(entry.handoffPendingMs || Date.now(), (entry.latestHandoffMs || 0) + 1);
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
    return true;
  }

  if (Date.now() - (entry.handoffPendingMs || 0) > 15000) {
    entry.needsFullHandoffRead = false;
    entry.handoffTargetStepIndex = -1;
  }
  return false;
}

function updateTranscriptEntry(convId, transcriptPath, existingEntry, preStat) {
  let stat = preStat;
  if (!stat) {
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return null;
    }
  }

  if (
    existingEntry &&
    existingEntry.size === stat.size &&
    existingEntry.mtimeMs === stat.mtimeMs &&
    existingEntry.parsedBytes === stat.size
  ) {
    if (existingEntry.needsFullHandoffRead) {
      const resolved = resolveFullHandoffPrompt(existingEntry, transcriptPath);
      return { entry: existingEntry, changed: resolved };
    }
    return { entry: existingEntry, changed: false };
  }

  const canIncremental =
    existingEntry &&
    existingEntry.parsedBytes > 0 &&
    stat.size > existingEntry.parsedBytes &&
    stat.size - existingEntry.parsedBytes < 16 * 1024 * 1024;

  const entry = canIncremental ? existingEntry : createEmptyEntry(convId);
  if (!canIncremental && existingEntry) {
    entry.modelEnum = existingEntry.modelEnum || '';
    entry.modelLabel = existingEntry.modelLabel || '';
    entry.modelResolvedMtimeMs = existingEntry.modelResolvedMtimeMs || 0;
    entry.workspacePath = existingEntry.workspacePath || '';
    entry.lastViewMs = existingEntry.lastViewMs || 0;
    entry.lastUserInputMs = existingEntry.lastUserInputMs || 0;
    entry.lastSeenMs = existingEntry.lastSeenMs || 0;
  }
  const startOffset = canIncremental ? entry.parsedBytes : 0;
  const bytesToRead = stat.size - startOffset;

  if (bytesToRead <= 0) {
    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;
    return { entry, changed: false };
  }

  let fd;
  let buf;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    buf = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, startOffset);
    buf = buf.subarray(0, bytesRead);
  } catch {
    return existingEntry ? { entry: existingEntry, changed: false } : null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lastNewlineIdx = buf.lastIndexOf(0x0a);
  if (lastNewlineIdx < 0) {
    const trimmedBuf = buf.toString('utf-8').trim();
    if (!trimmedBuf) {
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
      return { entry, changed: false };
    }
    try {
      JSON.parse(trimmedBuf);
    } catch {
      return existingEntry ? { entry: existingEntry, changed: false } : null;
    }
  }

  const completeBuf = lastNewlineIdx >= 0 ? buf.subarray(0, lastNewlineIdx + 1) : buf;
  const text = completeBuf.toString('utf-8');
  const lines = text.split('\n');

  let isFirstLine = startOffset === 0;
  let corpusDirty = startOffset === 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (processTranscriptLine(entry, line, isFirstLine)) {
      corpusDirty = true;
    }
    isFirstLine = false;
  }

  if (entry.needsFullCheckpointRead) {
    if (resolveFullCheckpointOverview(entry, transcriptPath)) {
      corpusDirty = true;
    }
  }

  if (entry.needsFullHandoffRead) {
    resolveFullHandoffPrompt(entry, transcriptPath);
  }

  entry.parsedBytes = lastNewlineIdx >= 0 ? startOffset + lastNewlineIdx + 1 : stat.size;
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  if (
    entry.lastStepType === 'USER_INPUT' &&
    entry.lastUserInputMs > 0 &&
    stat.mtimeMs > entry.lastUserInputMs &&
    stat.mtimeMs - entry.lastUserInputMs < 1000
  ) {
    entry.lastUserInputMs = Math.floor(stat.mtimeMs);
  }
  if (
    entry.lastStepType === 'PLANNER_RESPONSE' &&
    entry.lastModelResponse &&
    stat.mtimeMs > (entry.lastModelResponseMs || 0)
  ) {
    entry.lastModelResponseMs = Math.floor(stat.mtimeMs);
  }
  if (!entry.lastActiveMs) {
    entry.lastActiveMs = stat.mtimeMs;
    entry.lastActiveIso = new Date(stat.mtimeMs).toISOString();
  }
  if (corpusDirty || !entry.searchCorpusLower) {
    rebuildSearchCorpus(entry);
  }
  return { entry, changed: true };
}

function parseGitReflogTail(repoPath, maxEntries = 200) {
  const logFile = path.join(repoPath, '.git', 'logs', 'HEAD');
  if (!isFile(logFile)) return [];

  let fd;
  try {
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 64 * 1024);
    const startPos = Math.max(0, stat.size - readSize);
    fd = fs.openSync(logFile, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, startPos);
    const raw = buf.subarray(0, bytesRead).toString('utf-8');
    const lines = raw.trim().split('\n');
    const commits = [];
    const seen = new Set();

    for (let i = lines.length - 1; i >= 0 && commits.length < maxEntries; i--) {
      const line = lines[i];
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const meta = line.slice(0, tabIdx).trim();
      const action = line.slice(tabIdx + 1).trim();
      if (!REFLOG_ACTION_RE.test(action)) {
        continue;
      }
      const metaMatch = /^([0-9a-f]{40})\s+([0-9a-f]{40})\s+.*\s+(\d{9,12})\s+([+-]\d{4})$/i.exec(meta);
      if (!metaMatch) continue;
      const hash = metaMatch[2].toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const tsSec = parseInt(metaMatch[3], 10);
      const tsMs = tsSec * 1000;
      const subject = action.replace(/^commit(?:\s*\([^)]+\))?:\s*/i, '').trim();
      commits.push({
        hash,
        short: hash.slice(0, 7),
        iso: new Date(tsMs).toISOString(),
        tsMs,
        subject
      });
    }
    return commits;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

class GitRepoCache {
  constructor() {
    this.repos = new Map();
    this.revision = 1;
  }

  getHeadMtime(repoPath) {
    let m1 = 0;
    let m2 = 0;
    try {
      m1 = fs.statSync(path.join(repoPath, '.git', 'HEAD'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    } catch {}
    try {
      m2 = fs.statSync(path.join(repoPath, '.git', 'logs', 'HEAD'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    } catch {}
    return `${m1}:${m2}`;
  }

  invalidateMtimeChecks() {
    for (const record of this.repos.values()) {
      record.checkedAtMs = 0;
    }
  }

  checkKnownRepos(force = false) {
    for (const repoPath of this.repos.keys()) {
      this.getRepoRecord(repoPath, force);
    }
  }

  getRepoRecord(repoPath, force = false) {
    if (!repoPath) return null;
    const now = Date.now();
    const existing = this.repos.get(repoPath);
    if (!force && existing && now - existing.checkedAtMs < 1500) {
      return existing;
    }

    const signature = this.getHeadMtime(repoPath);
    if (signature === '0:0') {
      const hasGit = existing && existing.signature === '0:0'
        ? existing.hasGit
        : isDirectory(path.join(repoPath, '.git'));
      if (!existing || existing.signature !== '0:0' || existing.hasGit !== hasGit) {
        this.revision += 1;
      }
      const emptyRecord = {
        signature: '0:0',
        hasGit,
        commits: [],
        refreshing: false,
        checkedAtMs: now
      };
      this.repos.set(repoPath, emptyRecord);
      return emptyRecord;
    }

    if (existing && existing.signature === signature) {
      existing.checkedAtMs = now;
      if (force && !existing.refreshing) {
        this.refreshViaGitAsync(repoPath, signature);
      }
      return existing;
    }

    const reflogCommits = parseGitReflogTail(repoPath, 200);
    const record = {
      signature,
      hasGit: true,
      commits: reflogCommits.length > 0 || !existing ? reflogCommits : existing.commits,
      refreshing: existing ? existing.refreshing : false,
      checkedAtMs: now
    };
    this.repos.set(repoPath, record);
    this.revision += 1;

    this.refreshViaGitAsync(repoPath, signature);
    return record;
  }

  getRepoCommits(repoPath, force = false) {
    const rec = this.getRepoRecord(repoPath, force);
    return rec ? rec.commits : [];
  }

  refreshViaGitAsync(repoPath, signature) {
    const record = this.repos.get(repoPath);
    if (!record || record.refreshing) return;
    record.refreshing = true;
    const nativeRepo = process.platform === 'win32' ? repoPath.replace(/\//g, '\\') : repoPath;

    execFile(
      'git',
      ['-C', nativeRepo, '--no-pager', 'log', '-n', '200', '--format=%H%x1f%h%x1f%cI%x1f%ct%x1f%s', 'HEAD'],
      { encoding: 'utf-8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        record.refreshing = false;
        if (err || !stdout) return;
        const commits = [];
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          const parts = line.split('\x1f');
          if (parts.length < 5) continue;
          const [hash, short, iso, ctStr, subject] = parts;
          const tsMs = parseInt(ctStr, 10) * 1000;
          if (!Number.isFinite(tsMs)) continue;
          commits.push({
            hash: hash.trim().toLowerCase(),
            short: short.trim().toLowerCase(),
            iso: iso.trim(),
            tsMs,
            subject: subject.trim()
          });
        }
        if (commits.length > 0) {
          this.repos.set(repoPath, {
            signature,
            hasGit: true,
            commits,
            refreshing: false,
            checkedAtMs: Date.now()
          });
          this.revision += 1;
        }
      }
    );
  }

  computeDriftForConversation(entry) {
    if (!entry.workspacePath || !entry.lastActiveMs) {
      return {
        hasGit: false,
        commitsBehind: 0,
        missedCommits: []
      };
    }
    const record = this.getRepoRecord(entry.workspacePath);
    if (!record || record.commits.length === 0) {
      return {
        hasGit: Boolean(record && record.hasGit),
        commitsBehind: 0,
        missedCommits: []
      };
    }

    const commits = record.commits;
    const graceCutoffMs = entry.lastActiveMs + 1000;
    if (commits[0].tsMs <= graceCutoffMs) {
      return {
        hasGit: true,
        commitsBehind: 0,
        missedCommits: []
      };
    }

    const mentioned = new Set(entry.mentionedCommits || []);
    const missed = [];

    for (const c of commits) {
      if (c.tsMs <= graceCutoffMs) break;
      if (mentioned.has(c.hash.slice(0, 7))) {
        continue;
      }
      missed.push(c);
    }

    return {
      hasGit: true,
      commitsBehind: missed.length,
      missedCommits: missed.slice(0, 8)
    };
  }
}

const LSRPC_CONTRACT_SPECS = [
  {
    method: 'GetCascadeModelConfigData',
    critical: true,
    caller: 'server.cjs:getModelsCatalog, parseCascadeModelConfigs',
    purpose: 'Fetch available model catalog and default model'
  },
  {
    method: 'GetCascadeTrajectoryGeneratorMetadata',
    critical: true,
    caller: 'server.cjs:resolveConversationModelAsync',
    purpose: 'Resolve active model used by a conversation'
  },
  {
    method: 'LoadTrajectory',
    critical: false,
    caller: 'server.cjs:resolveConversationModelAsync',
    purpose: 'Warm trajectory in Language Server before reading generator metadata'
  },
  {
    method: 'StartCascade',
    critical: false,
    caller: 'server.cjs:handleRequest (POST /_sidecar/new-conversation)',
    purpose: 'Create new conversation via Language Server RPC (falls back to agentapi CLI)'
  },
  {
    method: 'SendUserCascadeMessage',
    critical: false,
    caller: 'server.cjs:handleRequest (POST /_sidecar/new-conversation)',
    purpose: 'Send initial user prompt to new cascade (falls back to agentapi CLI)'
  },
  {
    method: 'UpdateConversationAnnotations',
    critical: false,
    caller: 'server.cjs:setConversationArchived',
    purpose: 'Archive/unarchive conversation via RPC (falls back to .pbtxt file edit)'
  },
  {
    method: 'DeleteCascadeTrajectory',
    critical: false,
    caller: 'server.cjs:deleteConversation',
    purpose: 'Delete trajectory via RPC (falls back to on-disk brain/conversations/annotations removal)'
  }
];

const binarySymbolCache = new Map();

function resolveLanguageServerBinary(appDataDir) {
  const geminiRoot = path.join(os.homedir(), '.gemini');
  const candidateDirs = [
    appDataDir || resolveAppDataDir(),
    ...APP_CANDIDATES.map((app) => path.join(geminiRoot, app))
  ].filter(Boolean);

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const langServer = path.join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (isFile(langServer)) return langServer;
    for (const d of candidateDirs) {
      const bat = path.join(d, 'bin', 'agentapi.bat');
      if (isFile(bat)) {
        try {
          const batContent = fs.readFileSync(bat, 'utf-8');
          const exeMatch = /"([^"]+\.exe)"/i.exec(batContent);
          if (exeMatch && isFile(exeMatch[1])) return exeMatch[1];
        } catch {}
      }
    }
    return '';
  }

  for (const d of candidateDirs) {
    const nixBin = path.join(d, 'bin', 'agentapi');
    if (isFile(nixBin)) {
      try {
        const scriptContent = fs.readFileSync(nixBin, 'utf-8');
        const binMatch = /"([^"\n]+language_server[^"\n]*)"/.exec(scriptContent);
        if (binMatch && isFile(binMatch[1])) return binMatch[1];
      } catch {}
    }
  }

  const linuxCandidates = [
    '/opt/Antigravity/resources/bin/language_server_linux_x64',
    '/opt/Antigravity/resources/bin/language_server',
    '/opt/antigravity/resources/bin/language_server_linux_x64',
    '/opt/antigravity/resources/bin/language_server',
    '/usr/share/antigravity/resources/bin/language_server',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
  ];
  for (const binPath of linuxCandidates) {
    if (isFile(binPath)) return binPath;
  }
  return '';
}

function scanBinarySymbols(binaryPath, symbols) {
  const result = {
    found: new Set(),
    missing: [],
    mtimeMs: 0,
    size: 0,
    error: ''
  };
  if (!binaryPath || !isFile(binaryPath)) {
    result.missing = [...symbols];
    result.error = 'Binary file not found';
    return result;
  }
  let stat;
  try {
    stat = fs.statSync(binaryPath);
  } catch (err) {
    result.missing = [...symbols];
    result.error = err.message;
    return result;
  }
  result.mtimeMs = Math.floor(stat.mtimeMs || 0);
  result.size = stat.size || 0;

  const cacheKey = `${binaryPath}|${result.mtimeMs}|${result.size}|${symbols.join(',')}`;
  if (binarySymbolCache.has(cacheKey)) {
    const cachedFound = binarySymbolCache.get(cacheKey);
    result.found = new Set(cachedFound);
    result.missing = symbols.filter((s) => !result.found.has(s));
    return result;
  }

  const pending = new Map();
  for (const sym of symbols) {
    if (sym) pending.set(sym, Buffer.from(sym, 'utf-8'));
  }

  let fd;
  try {
    fd = fs.openSync(binaryPath, 'r');
    const chunkSize = 4 * 1024 * 1024;
    const overlap = 256;
    const buf = Buffer.allocUnsafe(chunkSize + overlap);
    let pos = 0;
    let carryLen = 0;

    while (pos < stat.size && pending.size > 0) {
      const toRead = Math.min(chunkSize, stat.size - pos);
      const bytesRead = fs.readSync(fd, buf, carryLen, toRead, pos);
      if (bytesRead <= 0) break;
      const windowSlice = buf.subarray(0, carryLen + bytesRead);
      for (const [sym, needle] of pending.entries()) {
        if (windowSlice.includes(needle)) {
          result.found.add(sym);
          pending.delete(sym);
        }
      }
      pos += bytesRead;
      if (pos < stat.size && pending.size > 0) {
        carryLen = Math.min(overlap, windowSlice.length);
        windowSlice.subarray(windowSlice.length - carryLen).copy(buf, 0);
      }
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  result.missing = symbols.filter((s) => !result.found.has(s));
  if (!result.error) {
    if (binarySymbolCache.size > 8) binarySymbolCache.clear();
    binarySymbolCache.set(cacheKey, [...result.found]);
  }
  return result;
}

function resolveAgentApiCommand(appDataDir) {
  const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (envExe && isFile(envExe)) {
    const isDirect = path.basename(envExe).toLowerCase().startsWith('agentapi');
    return { file: envExe, prefix: isDirect ? [] : ['agentapi'], shell: false };
  }

  const geminiRoot = path.join(os.homedir(), '.gemini');
  const candidateDirs = [
    appDataDir || resolveAppDataDir(),
    ...APP_CANDIDATES.map((app) => path.join(geminiRoot, app))
  ].filter(Boolean);

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const langServer = path.join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (isFile(langServer)) {
      return { file: langServer, prefix: ['agentapi'], shell: false };
    }
    for (const d of candidateDirs) {
      const bat = path.join(d, 'bin', 'agentapi.bat');
      if (isFile(bat)) {
        try {
          const batContent = fs.readFileSync(bat, 'utf-8');
          const exeMatch = /"([^"]+\.exe)"/i.exec(batContent);
          if (exeMatch && isFile(exeMatch[1])) {
            return { file: exeMatch[1], prefix: ['agentapi'], shell: false };
          }
        } catch {}
        return { file: bat, prefix: [], shell: true };
      }
    }
    return { file: 'agentapi', prefix: [], shell: true };
  }

  for (const d of candidateDirs) {
    const nixBin = path.join(d, 'bin', 'agentapi');
    if (isFile(nixBin)) {
      try {
        const scriptContent = fs.readFileSync(nixBin, 'utf-8');
        const binMatch = /"([^"\n]+language_server[^"\n]*)"/.exec(scriptContent);
        if (binMatch && isFile(binMatch[1])) {
          return { file: binMatch[1], prefix: ['agentapi'], shell: false };
        }
      } catch {}
      return { file: nixBin, prefix: [], shell: false };
    }
  }

  const linuxCandidates = [
    '/opt/Antigravity/resources/bin/language_server_linux_x64',
    '/opt/Antigravity/resources/bin/language_server',
    '/opt/antigravity/resources/bin/language_server_linux_x64',
    '/opt/antigravity/resources/bin/language_server',
    '/usr/share/antigravity/resources/bin/language_server',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
  ];
  for (const binPath of linuxCandidates) {
    if (isFile(binPath)) {
      return { file: binPath, prefix: ['agentapi'], shell: false };
    }
  }

  return { file: 'agentapi', prefix: [], shell: false };
}

function execAgentApi(args, projectId, appDataDir, workspacePath = '', timeoutMs = 12000, clearProjectEnv = false) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (clearProjectEnv) {
      delete env.ANTIGRAVITY_PROJECT_ID;
    } else if (projectId) {
      env.ANTIGRAVITY_PROJECT_ID = projectId;
    }
    const cwd = workspacePath && isDirectory(workspacePath) ? workspacePath : os.homedir();
    const { file, prefix, shell } = resolveAgentApiCommand(appDataDir);
    execFile(
      file,
      [...prefix, ...args],
      { encoding: 'utf-8', env, cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell },
      (err, stdout, stderr) => {
        if (err) {
          const errMsg = stderr ? `${err.message}: ${stderr}` : err.message;
          resolve({ error: errMsg, stderr: stderr ? String(stderr) : undefined });
          return;
        }
        const trimmed = stdout ? String(stdout).trim() : '';
        if (!trimmed) {
          resolve({ success: true });
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          resolve(parsed);
        } catch {
          resolve({ success: true, raw: trimmed });
        }
      }
    );
  });
}

function callLanguageServerRpc(method, payload = {}, timeoutMs = 4000) {
  const rawAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!rawAddr || !csrf) {
    return Promise.resolve({ error: 'Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN' });
  }
  const baseUrl = /^https?:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`;
  let urlObj;
  try {
    urlObj = new URL(`/exa.language_server_pb.LanguageServerService/${method}`, baseUrl);
  } catch (err) {
    return Promise.resolve({ error: err.message });
  }
  const bodyBuf = Buffer.from(JSON.stringify(payload || {}), 'utf-8');
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: urlObj.hostname === 'localhost' ? '127.0.0.1' : urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': bodyBuf.length
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8').trim();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ error: `HTTP ${res.statusCode}: ${raw.slice(0, 300)}`, statusCode: res.statusCode });
            return;
          }
          if (!raw) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ error: 'Invalid JSON response from Language Server' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: `Language Server RPC ${method} timed out` });
    });
    req.on('error', (err) => {
      resolve({ error: err.message });
    });
    req.write(bodyBuf);
    req.end();
  });
}

function parseModelFamilyAndTier(label) {
  const clean = (typeof label === 'string' ? label : '').trim();
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(clean);
  if (m && m[1].trim()) {
    return { family: m[1].trim(), tier: m[2].trim() };
  }
  return { family: clean, tier: '' };
}

function getTierSortWeight(tier) {
  const t = (tier || '').trim().toLowerCase();
  if (!t) return 0;
  if (t === 'max' || t === 'extra high' || t === 'ultra' || t === 'elite' || t === 'pro') return 10;
  if (t === 'high') return 20;
  if (t === 'thinking') return 25;
  if (t === 'medium') return 30;
  if (t === 'low thinking') return 40;
  if (t === 'low') return 50;
  if (t === 'extra low' || t === 'minimal' || t === 'lite') return 60;
  return 35;
}

function parseCascadeModelConfigs(data) {
  if (!data || typeof data !== 'object' || data.error) {
    return { models: [], defaultModelEnum: '' };
  }
  const defaultModelEnum =
    (data.defaultOverrideModelConfig &&
      data.defaultOverrideModelConfig.modelOrAlias &&
      (data.defaultOverrideModelConfig.modelOrAlias.model ||
        data.defaultOverrideModelConfig.modelOrAlias.alias)) ||
    '';

  const recommendedLabelOrder = new Map();
  const recommendedFamilyOrder = new Map();
  const sorts = Array.isArray(data.clientModelSorts) ? data.clientModelSorts : [];
  for (const s of sorts) {
    const groups = Array.isArray(s && s.groups) ? s.groups : [];
    for (const g of groups) {
      const labels = Array.isArray(g && g.modelLabels) ? g.modelLabels : [];
      for (const lbl of labels) {
        if (typeof lbl === 'string' && lbl.trim()) {
          const cleanLbl = lbl.trim();
          if (!recommendedLabelOrder.has(cleanLbl)) {
            recommendedLabelOrder.set(cleanLbl, recommendedLabelOrder.size);
          }
          const { family } = parseModelFamilyAndTier(cleanLbl);
          if (family && !recommendedFamilyOrder.has(family)) {
            recommendedFamilyOrder.set(family, recommendedFamilyOrder.size);
          }
        }
      }
    }
  }

  const rawConfigs = Array.isArray(data.clientModelConfigs) ? data.clientModelConfigs : [];
  const seenEnums = new Set();
  const models = [];

  for (const cfg of rawConfigs) {
    if (!cfg || cfg.disabled) continue;
    const label = typeof cfg.label === 'string' ? cfg.label.trim() : '';
    const modelEnum =
      (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) || '';
    if (!label || !modelEnum || modelEnum === 'MODEL_UNSPECIFIED') continue;
    if (seenEnums.has(modelEnum)) continue;
    seenEnums.add(modelEnum);

    const { family, tier } = parseModelFamilyAndTier(label);
    const recommended =
      recommendedFamilyOrder.has(family) ||
      recommendedLabelOrder.has(label) ||
      Boolean(cfg.isRecommended);

    models.push({
      label,
      modelEnum,
      modelId: typeof cfg.modelId === 'string' ? cfg.modelId.trim() : '',
      family,
      tier,
      recommended,
      tagTitle: typeof cfg.tagTitle === 'string' ? cfg.tagTitle.trim() : ''
    });
  }

  models.sort((a, b) => {
    const aFamRec = recommendedFamilyOrder.has(a.family) ? recommendedFamilyOrder.get(a.family) : 9999;
    const bFamRec = recommendedFamilyOrder.has(b.family) ? recommendedFamilyOrder.get(b.family) : 9999;
    if (aFamRec !== bFamRec) return aFamRec - bFamRec;

    if (a.family !== b.family) {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.family.localeCompare(b.family, undefined, { numeric: true, sensitivity: 'base' });
    }

    const aLblRec = recommendedLabelOrder.has(a.label) ? recommendedLabelOrder.get(a.label) : 9999;
    const bLblRec = recommendedLabelOrder.has(b.label) ? recommendedLabelOrder.get(b.label) : 9999;
    if (aLblRec !== bLblRec && aLblRec !== 9999 && bLblRec !== 9999) {
      return aLblRec - bLblRec;
    }

    const aWeight = getTierSortWeight(a.tier);
    const bWeight = getTierSortWeight(b.tier);
    if (aWeight !== bWeight) {
      if (aWeight === 35 && aLblRec !== 9999) return -1;
      if (bWeight === 35 && bLblRec !== 9999) return 1;
      return aWeight - bWeight;
    }
    if (aLblRec !== bLblRec) return aLblRec - bLblRec;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  });

  return { models, defaultModelEnum };
}

function rewriteUiHtmlLinks(html, token, conversationId) {
  const bootScript = `<script>window.__SIDECAR_BOOT__=${JSON.stringify({
    token: token || '',
    conversationId: conversationId || ''
  })};</script>`;
  let out = html.includes('</head>')
    ? html.replace('</head>', `${bootScript}</head>`)
    : bootScript + html;

  if (!token && !conversationId) return out;
  const queryParts = [];
  if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
  if (conversationId) queryParts.push(`conversationId=${encodeURIComponent(conversationId)}`);
  const qs = queryParts.join('&');

  return out.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, urlPath) => {
    if (urlPath.startsWith('//')) return match;
    const [base, ...hashParts] = urlPath.split('#');
    const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${attr}=${quote}${base}${sep}${qs}${hash}${quote}`;
  });
}

function buildAgentHandoffRequest(entry, focusTopic) {
  const focusDirective = focusTopic
    ? `User focus / instructions / reply for the new conversation:\n"${focusTopic}"\nNote: The user may have written this as a direct reply, approval, or refinement to your very last message in this chat (instead of replying here) so that the next step runs in a fresh conversation. Scope the handoff prompt STRICTLY to executing or continuing what the user requested above, combined with the directly relevant technical context from our latest discussion.`
    : `Scope the handoff prompt strictly to the active, unfinished task or immediate next step from the latest turns of our conversation.`;

  return (
    `[Context Health Smart Handoff]\n` +
    `Create a self-contained, high-signal handoff prompt so we can continue seamlessly in a fresh conversation.\n\n` +
    `${focusDirective}\n\n` +
    `STRICT RULES:\n` +
    `1. Do NOT call any tools (no read_file, no run_command, no search). You already have all required context in memory. Respond immediately.\n` +
    `2. Write the entire handoff prompt in the SAME language the user has been using in this conversation (unless the user explicitly requested a different language above).\n` +
    `3. Wrap the final handoff prompt strictly inside <HANDOFF_PROMPT> and </HANDOFF_PROMPT> tags. As soon as you finish your response, the Context Health sidecar will automatically extract the content inside those tags and load it into the review editor.\n` +
    `4. Ignore any earlier <HANDOFF_PROMPT> blocks that may exist higher up in this conversation's history. Do NOT copy or carry over old sections from them; write a fresh, tightly scoped prompt for the current target task.\n` +
    `5. Maximize signal-to-noise ratio. Do NOT write a session changelog or historical summary of unrelated tasks that were already completed earlier in this conversation (the files on disk already reflect completed changes). Mention prior work ONLY if it is partially finished, uncommitted in a way that affects the next step, or has a direct technical dependency or side-effect on the immediate task.\n` +
    `6. Inside <HANDOFF_PROMPT>...</HANDOFF_PROMPT> include ONLY:\n` +
    `   - On the very first line, a clear instruction (in the target language) stating that all necessary context is provided below and the new agent must NOT search or read transcript.jsonl files from previous conversations.\n` +
    `   - The Workspace (${entry.workspacePath || 'current workspace'}) and ONLY the specific files (with exact function/symbol names and approximate line ranges when known) that the new agent will actually need to read or modify for this task.\n` +
    `   - The exact technical context, agreed design decisions, constraints, edge cases, and concrete action items required to execute the immediate task right away.\n` +
    `   - Do NOT include the old conversationId UUID.`
  );
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

class ContextHealthServer {
  constructor(options = {}) {
    this.appDataDir = options.appDataDir || resolveAppDataDir();
    this.brainDir = options.brainDir || path.join(this.appDataDir, 'brain');
    this.dataDir = options.dataDir || resolveDataDir(this.appDataDir);
    this.projectsDir = options.projectsDir || resolveProjectsDir();
    this.uiHtmlPath = options.uiHtmlPath || path.join(__dirname, 'ui.html');

    const envPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '', 10);
    this.port = options.port !== undefined
      ? options.port
      : (Number.isFinite(envPort) ? envPort : DEFAULT_PORT);

    this.token =
      options.token ??
      process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ??
      process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ??
      process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ??
      '';

    this.convCache = new Map();
    this.deletedConvIds = new Set();
    this.metadataWorkspaceCache = new Map();
    this.annotationTitleCache = new Map();
    this.annotationsDir = path.join(this.appDataDir, 'annotations');
    this.projectsRegistry = new Map();
    this.projectFileMtimes = new Map();
    this.lastProjectsScanMs = 0;
    this.lastProjectsDirMtimeMs = 0;
    this.projectsRev = 1;
    this.gitCache = new GitRepoCache();
    this.stateVersion = 1;
    this.transcriptRev = 1;
    this.lastStateSignature = '';
    this.lastRefreshDurationMs = 0;
    this.lastFullScanMs = 0;
    this.lastBrainDirMtimeMs = 0;
    this.cachedIndexSummary = null;
    this.cachedCardsState = null;
    this.cachedUiMtimeMs = 0;
    this.lastUiStatCheckMs = 0;
    this.saveCacheTimer = null;
    this.indexCacheDirty = false;
    this.server = null;

    this.cachedModelsCatalog = { models: [], defaultModelEnum: '', fetchedAtMs: 0 };
    this.modelsFetchPromise = null;
    this.modelResolveInFlight = new Set();
    this.modelResolveCooldown = new Map();
    this.modelsCatalogRev = 1;
    this.initialBootScanDone = false;

    this.diagnosticsState = null;
    this.diagnosticsPromise = null;
    this.diagnosticsRev = 1;
    this.lastBinaryStatCheckMs = 0;
    this.lastKnownBinarySig = '';

    this.indexCachePath = path.join(this.dataDir, 'index_cache.json');
    this.metadataCachePath = path.join(this.dataDir, 'metadata_cache.json');
    this.diagnosticsCachePath = path.join(this.dataDir, 'diagnostics_cache.json');
    this.serverInfoPath = path.join(this.dataDir, 'server_info.json');

    try {
      this.bootScriptMtimeMs = fs.statSync(__filename).mtimeMs;
    } catch {
      this.bootScriptMtimeMs = 0;
    }

    this.loadPersistentCaches();
  }

  loadPersistentCaches() {
    if (isFile(this.diagnosticsCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.diagnosticsCachePath, 'utf-8'));
        if (raw && typeof raw.binarySig === 'string') {
          this.lastKnownBinarySig = raw.binarySig;
        }
      } catch {}
    }
    if (isFile(this.metadataCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metadataCachePath, 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            if (v === '__general__') {
              this.metadataWorkspaceCache.set(k, '__general__');
            } else if (typeof v === 'string' && v) {
              this.metadataWorkspaceCache.set(k, resolveCanonicalWorkspace(v));
            } else if (v && typeof v === 'object' && typeof v.workspacePath === 'string' && v.workspacePath) {
              this.metadataWorkspaceCache.set(k, resolveCanonicalWorkspace(v.workspacePath));
            }
          }
        }
      } catch {}
    }

    if (isFile(this.indexCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexCachePath, 'utf-8'));
        if (raw && raw.version === 14 && Array.isArray(raw.entries)) {
          for (const item of raw.entries) {
            if (item && typeof item.id === 'string') {
              item.lastUserInputMs = item.lastUserInputMs || 0;
              item.lastSeenMs = item.lastSeenMs || 0;
              item.markedAsUnread = Boolean(item.markedAsUnread);
              item.lastModelResponse = item.lastModelResponse || '';
              item.lastModelResponseMs = item.lastModelResponseMs || 0;
              item.lastStepType = item.lastStepType || '';
              item.lastStepStatus = item.lastStepStatus || '';
              item.lastStepHasToolCalls = Boolean(item.lastStepHasToolCalls);
              item.lastStepWaitKind = item.lastStepWaitKind || '';
              item.lastStepWaitDelayMs = item.lastStepWaitDelayMs || 0;
              item.lastStepMs = item.lastStepMs || 0;
              item.modelEnum = item.modelEnum || '';
              item.modelLabel = item.modelLabel || '';
              item.modelResolvedMtimeMs = item.modelResolvedMtimeMs || 0;
              rebuildSearchCorpus(item);
              this.convCache.set(item.id, item);
            }
          }
          if (this.convCache.size > 0) {
            this.initialBootScanDone = true;
          }
        }
      } catch {}
    }
  }

  saveIndexCache() {
    if (this.saveCacheTimer) {
      clearTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    this.indexCacheDirty = false;
    try {
      const entries = [...this.convCache.values()];
      writeJsonAtomic(this.indexCachePath, { version: 14, savedAt: Date.now(), entries });
    } catch {}
  }

  scheduleSaveIndexCache() {
    this.indexCacheDirty = true;
    if (this.saveCacheTimer) return;
    this.saveCacheTimer = setTimeout(() => {
      this.saveCacheTimer = null;
      if (this.indexCacheDirty) {
        this.saveIndexCache();
      }
    }, 8000);
    if (typeof this.saveCacheTimer.unref === 'function') {
      this.saveCacheTimer.unref();
    }
  }

  saveMetadataCache() {
    try {
      const obj = Object.fromEntries(this.metadataWorkspaceCache.entries());
      writeJsonAtomic(this.metadataCachePath, obj);
    } catch {}
  }

  loadPreloadJs() {
    const sdkPreload = path.join(this.appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
    if (isFile(sdkPreload)) {
      try {
        return fs.readFileSync(sdkPreload, 'utf-8');
      } catch {}
    }
    return FALLBACK_PRELOAD_JS;
  }

  resolveConversationAnnotation(convId, forceStat = false) {
    const now = Date.now();
    const cached = this.annotationTitleCache.get(convId);
    if (!forceStat && cached && now - cached.checkedAtMs < 1000) {
      return cached;
    }

    const pbtxtPath = path.join(this.annotationsDir, `${convId}.pbtxt`);
    let stat;
    try {
      stat = fs.statSync(pbtxtPath, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      const emptyItem = {
        mtimeMs: 0,
        title: '',
        lastViewMs: 0,
        archived: false,
        markedAsUnread: false,
        checkedAtMs: now
      };
      this.annotationTitleCache.set(convId, emptyItem);
      return emptyItem;
    }
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      typeof cached.lastViewMs === 'number' &&
      typeof cached.archived === 'boolean' &&
      typeof cached.markedAsUnread === 'boolean'
    ) {
      cached.checkedAtMs = now;
      return cached;
    }
    try {
      const raw = fs.readFileSync(pbtxtPath, 'utf-8');
      const { title, lastViewMs, archived, markedAsUnread } = extractAnnotationFromPbtxt(raw);
      const item = {
        mtimeMs: stat.mtimeMs,
        title,
        lastViewMs,
        archived,
        markedAsUnread: Boolean(markedAsUnread),
        checkedAtMs: now
      };
      this.annotationTitleCache.set(convId, item);
      return item;
    } catch {
      return (
        cached || {
          mtimeMs: 0,
          title: '',
          lastViewMs: 0,
          archived: false,
          markedAsUnread: false,
          checkedAtMs: now
        }
      );
    }
  }

  applyEntryMetadata(entry, convId, activeConvId = '', activeWorkspaceNorm = '', forceAnnot = false) {
    let changed = false;
    if (!entry.isSubagent) {
      const annot = this.resolveConversationAnnotation(convId, forceAnnot);
      if (annot.title && entry.title !== annot.title) {
        entry.title = annot.title;
        rebuildSearchCorpus(entry);
        changed = true;
      }
      if (annot.lastViewMs && annot.lastViewMs > (entry.lastViewMs || 0)) {
        entry.lastViewMs = annot.lastViewMs;
        changed = true;
      }
      const nextArchived = Boolean(annot.archived);
      if (Boolean(entry.archived) !== nextArchived) {
        entry.archived = nextArchived;
        changed = true;
      }
      const nextUnreadFlag = Boolean(
        annot.markedAsUnread && (annot.mtimeMs || 0) > (entry.lastSeenMs || 0)
      );
      if (Boolean(entry.markedAsUnread) !== nextUnreadFlag) {
        entry.markedAsUnread = nextUnreadFlag;
        changed = true;
      }
    }
    const cachedWs = this.metadataWorkspaceCache.get(convId);
    const isExplicitGeneral = cachedWs === '__general__';
    if (!entry.workspacePath && typeof cachedWs === 'string' && cachedWs && !isExplicitGeneral) {
      entry.workspacePath = cachedWs;
      changed = true;
    }
    if (
      !isExplicitGeneral &&
      convId === activeConvId &&
      activeWorkspaceNorm &&
      !entry.workspacePath &&
      entry.promptCount <= 1 &&
      entry.lastActiveMs > 0 &&
      Date.now() - entry.lastActiveMs < 10 * 60 * 1000
    ) {
      entry.workspacePath = activeWorkspaceNorm;
      this.metadataWorkspaceCache.set(convId, activeWorkspaceNorm);
      this.saveMetadataCache();
      changed = true;
    }
    return changed;
  }

  markConversationSeen(convId, bumpViewTime = false) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) return false;
    const entry = this.convCache.get(cleanId);
    if (!entry) return false;
    let changed = false;
    if (bumpViewTime) {
      const nowMs = Date.now();
      if (nowMs > (entry.lastViewMs || 0)) {
        entry.lastViewMs = nowMs;
        changed = true;
      }
    }
    const annot = this.annotationTitleCache.get(cleanId);
    const targetMs = Math.max(
      entry.lastSeenMs || 0,
      entry.lastViewMs || 0,
      entry.lastUserInputMs || 0,
      entry.lastModelResponseMs || 0,
      annot && annot.mtimeMs ? Math.ceil(annot.mtimeMs) : 0
    );
    if (targetMs > (entry.lastSeenMs || 0)) {
      entry.lastSeenMs = targetMs;
      changed = true;
    }
    if (entry.markedAsUnread) {
      entry.markedAsUnread = false;
      changed = true;
    }
    if (changed) {
      this.transcriptRev += 1;
      this.cachedCardsState = null;
      this.scheduleSaveIndexCache();
    }
    return changed;
  }

  async setConversationArchived(convId, archived) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const nextArchived = Boolean(archived);
    const pbtxtPath = path.join(this.annotationsDir, `${cleanId}.pbtxt`);
    let existingRaw = '';
    try {
      if (isFile(pbtxtPath)) {
        existingRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
    } catch {}
    const parsedAnnot = existingRaw ? extractAnnotationFromPbtxt(existingRaw) : { title: '', lastViewMs: 0 };
    const entry = this.convCache.get(cleanId);
    const effectiveTitle = parsedAnnot.title || (entry && entry.title) || '';
    const lastViewIso = parsedAnnot.lastViewMs > 0
      ? new Date(parsedAnnot.lastViewMs).toISOString()
      : new Date().toISOString();

    try {
      if (nextArchived) {
        await callLanguageServerRpc(
          'UpdateConversationAnnotations',
          {
            cascadeId: cleanId,
            annotations: {
              archived: true,
              archivalStatusTimestamp: new Date().toISOString()
            },
            mergeAnnotations: true
          },
          4000
        );
      } else {
        await callLanguageServerRpc(
          'UpdateConversationAnnotations',
          {
            cascadeId: cleanId,
            annotations: {
              ...(effectiveTitle ? { title: effectiveTitle } : {}),
              lastUserViewTime: lastViewIso,
              archived: false
            },
            mergeAnnotations: false
          },
          4000
        );
      }
    } catch {}

    try {
      let postRpcRaw = existingRaw;
      if (isFile(pbtxtPath)) {
        postRpcRaw = fs.readFileSync(pbtxtPath, 'utf-8');
      }
      const postRpcAnnot = postRpcRaw ? extractAnnotationFromPbtxt(postRpcRaw) : null;
      if (!postRpcAnnot || Boolean(postRpcAnnot.archived) !== nextArchived) {
        fs.mkdirSync(this.annotationsDir, { recursive: true });
        let updatedRaw = (postRpcRaw || '').replace(/^\s*archived\s*:\s*(?:true|false)\s*$/gim, '').trim();
        if (nextArchived) {
          updatedRaw = (updatedRaw ? updatedRaw + '\n' : '') + 'archived: true\n';
        } else if (updatedRaw) {
          updatedRaw = updatedRaw + '\n';
        }
        if (updatedRaw || isFile(pbtxtPath)) {
          fs.writeFileSync(pbtxtPath, updatedRaw, 'utf-8');
        }
      }
    } catch {}

    this.annotationTitleCache.delete(cleanId);
    if (entry) {
      entry.archived = nextArchived;
    }
    this.transcriptRev += 1;
    this.cachedIndexSummary = null;
    this.cachedCardsState = null;
    this.scheduleSaveIndexCache();
    return {
      status: 200,
      body: {
        ok: true,
        conversationId: cleanId,
        archived: nextArchived
      }
    };
  }

  async deleteConversation(convId) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    let rpcResult = null;
    try {
      rpcResult = await callLanguageServerRpc(
        'DeleteCascadeTrajectory',
        { cascadeId: cleanId },
        6000
      );
    } catch (err) {
      rpcResult = { error: err instanceof Error ? err.message : String(err) };
    }

    const targets = [
      path.join(this.brainDir, cleanId),
      path.join(this.appDataDir, 'conversations', `${cleanId}.pb`),
      path.join(this.annotationsDir, `${cleanId}.pbtxt`)
    ];
    for (const target of targets) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }

    this.convCache.delete(cleanId);
    this.deletedConvIds.add(cleanId);
    if (this.metadataWorkspaceCache.delete(cleanId)) {
      this.saveMetadataCache();
    }
    this.annotationTitleCache.delete(cleanId);
    if (this.metadataWorkspaceCache.delete(cleanId)) {
      this.saveMetadataCache();
    }
    this.lastFullScanMs = 0;
    this.lastBrainDirMtimeMs = 0;
    this.transcriptRev += 1;
    this.cachedIndexSummary = null;
    this.cachedCardsState = null;
    this.scheduleSaveIndexCache();

    return {
      status: 200,
      body: {
        ok: true,
        conversationId: cleanId,
        rpcOk: Boolean(!rpcResult || !rpcResult.error)
      }
    };
  }

  refreshProjectsRegistry(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProjectsScanMs < 1500) {
      return;
    }
    this.lastProjectsScanMs = now;

    let dirStat = null;
    try {
      dirStat = fs.statSync(this.projectsDir, { throwIfNoEntry: false });
    } catch {}

    if (!dirStat || !dirStat.isDirectory()) {
      if (this.projectsRegistry.size > 0) {
        this.projectsRegistry.clear();
        this.projectFileMtimes.clear();
        knownProjectRootPaths.clear();
        gitRootLookupCache.clear();
        this.projectsRev += 1;
        this.cachedCardsState = null;
      }
      return;
    }

    let dirents = [];
    try {
      dirents = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return;
    }

    let changed = false;
    const seenIds = new Set();

    for (const d of dirents) {
      if (!d.isFile() || !d.name.toLowerCase().endsWith('.json')) continue;
      const projId = d.name.slice(0, -5).toLowerCase();
      if (!UUID_RE.test(projId)) continue;
      seenIds.add(projId);

      const filePath = path.join(this.projectsDir, d.name);
      let fStat = null;
      try {
        fStat = fs.statSync(filePath, { throwIfNoEntry: false });
      } catch {}
      if (!fStat || !fStat.isFile()) continue;

      const prevMtime = this.projectFileMtimes.get(projId);
      if (!force && prevMtime === fStat.mtimeMs && this.projectsRegistry.has(projId)) {
        continue;
      }

      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || typeof raw !== 'object') continue;
        const resources = extractProjectResourcePaths(raw);
        const primary = resources[0] || { path: '', key: '', label: '' };
        const name = (typeof raw.name === 'string' && raw.name.trim()) || primary.label || projId;
        this.projectsRegistry.set(projId, {
          id: projId,
          name,
          archived: Boolean(raw.archived),
          isWorkspaceOnly: Boolean(raw.isWorkspaceOnly),
          resources,
          primaryPath: primary.path,
          primaryKey: primary.key || projId
        });
        this.projectFileMtimes.set(projId, fStat.mtimeMs);
        changed = true;
      } catch {}
    }

    for (const oldId of this.projectsRegistry.keys()) {
      if (!seenIds.has(oldId)) {
        this.projectsRegistry.delete(oldId);
        this.projectFileMtimes.delete(oldId);
        changed = true;
      }
    }

    if (changed) {
      knownProjectRootPaths.clear();
      for (const proj of this.projectsRegistry.values()) {
        for (const r of proj.resources || []) {
          if (r && r.key && r.path) {
            knownProjectRootPaths.set(r.key, r.path);
          }
        }
      }
      gitRootLookupCache.clear();
      this.projectsRev += 1;
      this.cachedCardsState = null;
    }
  }

  matchProjectForWorkspace(workspacePath) {
    if (!workspacePath || this.projectsRegistry.size === 0) return null;
    const wsKey = workspaceComparisonKey(normalizeWorkspacePath(workspacePath));
    if (!wsKey) return null;

    let bestProj = null;
    let bestKeyLen = -1;
    let bestResIdx = 9999;
    let bestNameMatch = 0;

    for (const proj of this.projectsRegistry.values()) {
      if (!Array.isArray(proj.resources)) continue;
      const projNameLower = (proj.name || '').toLowerCase();
      for (let i = 0; i < proj.resources.length; i++) {
        const res = proj.resources[i];
        if (!res || !res.key) continue;
        if (wsKey === res.key || wsKey.startsWith(res.key + '/')) {
          const keyLen = res.key.length;
          const nameMatch = (res.label || '').toLowerCase() === projNameLower ? 1 : 0;
          const isBetter =
            keyLen > bestKeyLen ||
            (keyLen === bestKeyLen && i < bestResIdx) ||
            (keyLen === bestKeyLen && i === bestResIdx && nameMatch > bestNameMatch);
          if (isBetter) {
            bestProj = proj;
            bestKeyLen = keyLen;
            bestResIdx = i;
            bestNameMatch = nameMatch;
          }
        }
      }
    }
    return bestProj;
  }

  setProjectArchived(projectId, archived) {
    const cleanId = (projectId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      return { status: 400, body: { error: 'Invalid project id' } };
    }
    const filePath = path.join(this.projectsDir, `${cleanId}.json`);
    if (!isFile(filePath)) {
      return { status: 404, body: { error: 'Project file not found' } };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!raw || typeof raw !== 'object') {
        return { status: 500, body: { error: 'Malformed project file' } };
      }
      const nextArchived = Boolean(archived);
      if (nextArchived) {
        raw.archived = true;
      } else {
        delete raw.archived;
      }
      writeJsonAtomic(filePath, raw, undefined, true);
      this.refreshProjectsRegistry(true);
      this.cachedCardsState = null;
      return {
        status: 200,
        body: {
          ok: true,
          projectId: cleanId,
          archived: nextArchived,
          name: raw.name || ''
        }
      };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) }
      };
    }
  }

  refreshSingleEntry(convId) {
    if (!UUID_RE.test(convId)) return null;
    const transcriptPath = path.join(this.brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try {
      stat = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      return this.convCache.get(convId) || null;
    }
    const existing = this.convCache.get(convId);
    const res = updateTranscriptEntry(convId, transcriptPath, existing, stat);
    if (!res) return existing || null;
    const metaChanged = this.applyEntryMetadata(res.entry, convId, '', '', true);
    if (res.changed || metaChanged) {
      this.convCache.set(convId, res.entry);
      this.transcriptRev += 1;
      this.cachedIndexSummary = null;
      this.cachedCardsState = null;
      this.scheduleSaveIndexCache();
    }
    return res.entry;
  }

  refreshEntryById(convId, activeConvId, activeWorkspaceNorm, forceAnnot) {
    const transcriptPath = path.join(this.brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try {
      stat = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) return false;

    const existing = this.convCache.get(convId);
    const res = updateTranscriptEntry(convId, transcriptPath, existing, stat);
    if (!res) return false;

    const entry = res.entry;
    const metaChanged = this.applyEntryMetadata(entry, convId, activeConvId, activeWorkspaceNorm, forceAnnot);
    this.convCache.set(convId, entry);
    return res.changed || metaChanged;
  }

  refreshIndex(options = {}) {
    const startNs = process.hrtime.bigint();
    const force = Boolean(options.force);
    const activeConvId = (options.activeConvId || '').trim().toLowerCase();
    const activeWorkspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];
    const activeWorkspaceNorm = activeWorkspaceUris.length > 0
      ? resolveCanonicalWorkspace(activeWorkspaceUris[0])
      : '';

    let anyTranscriptChanged = false;
    const now = Date.now();

    let brainStat = null;
    try {
      brainStat = fs.statSync(this.brainDir, { throwIfNoEntry: false });
    } catch {}

    if (brainStat && brainStat.isDirectory()) {
      const brainMtimeMs = brainStat.mtimeMs || 0;
      const doFullScan =
        force ||
        this.convCache.size === 0 ||
        now - this.lastFullScanMs >= 15000 ||
        (brainMtimeMs > 0 && brainMtimeMs !== this.lastBrainDirMtimeMs);

      if (doFullScan) {
        this.lastFullScanMs = now;
        this.lastBrainDirMtimeMs = brainMtimeMs;

        let dirents = [];
        try {
          dirents = fs.readdirSync(this.brainDir, { withFileTypes: true });
        } catch {}

        const activeWsKey = workspaceComparisonKey(activeWorkspaceNorm);
        const seenIds = new Set();
        const isFirstBootScan = !this.initialBootScanDone;
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const convId = d.name.toLowerCase();
          if (!UUID_RE.test(convId)) continue;
          seenIds.add(convId);
          const existing = this.convCache.get(convId);
          const inActiveWs =
            !activeWsKey ||
            !existing ||
            !existing.workspacePath ||
            workspaceComparisonKey(existing.workspacePath) === activeWsKey;
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, force || convId === activeConvId || inActiveWs)) {
            anyTranscriptChanged = true;
          }
          if (isFirstBootScan) {
            const loaded = this.convCache.get(convId);
            if (loaded && !loaded.lastSeenMs) {
              loaded.lastSeenMs = Math.max(
                loaded.lastViewMs || 0,
                loaded.lastUserInputMs || 0,
                loaded.lastModelResponseMs || 0
              );
            }
          }
        }
        this.initialBootScanDone = true;

        for (const cachedId of this.convCache.keys()) {
          if (!seenIds.has(cachedId)) {
            this.convCache.delete(cachedId);
            anyTranscriptChanged = true;
          }
        }
      } else {
        const hotIds = new Set();
        if (activeConvId && UUID_RE.test(activeConvId)) {
          hotIds.add(activeConvId);
        }
        const candidates = this.cachedIndexSummary
          ? this.cachedIndexSummary.sortedEntries
          : [...this.convCache.values()];
        let mainChecked = 0;
        for (const entry of candidates) {
          const isHot =
            mainChecked < 8 ||
            now - (entry.lastActiveMs || 0) < 15 * 60 * 1000 ||
            isEntryThinking(entry, now) ||
            Boolean(getEntryWaitState(entry, now)) ||
            entry.awaitingHandoffResponse ||
            entry.needsFullHandoffRead;
          if (isHot) {
            hotIds.add(entry.id);
            if (!entry.isSubagent) mainChecked += 1;
            for (const subId of entry.spawnedSubagentIds || []) {
              hotIds.add(subId);
            }
          }
        }

        for (const convId of hotIds) {
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, false)) {
            anyTranscriptChanged = true;
          }
        }

        for (const [convId, entry] of this.convCache.entries()) {
          if (entry.isSubagent || hotIds.has(convId)) continue;
          if (this.applyEntryMetadata(entry, convId, activeConvId, activeWorkspaceNorm, false)) {
            anyTranscriptChanged = true;
          }
        }
      }
    }

    if (!anyTranscriptChanged && this.cachedIndexSummary) {
      const endNs = process.hrtime.bigint();
      this.lastRefreshDurationMs = Number(endNs - startNs) / 1e6;
      return this.cachedIndexSummary;
    }

    const parentLookup = new Map();
    for (const entry of this.convCache.values()) {
      for (const childId of entry.spawnedSubagentIds || []) {
        parentLookup.set(childId, entry.id);
      }
    }

    const subagentTokens = new Map();
    for (const entry of this.convCache.values()) {
      if (parentLookup.has(entry.id)) {
        entry.isSubagent = true;
        entry.parentConvId = parentLookup.get(entry.id);
      }
      if (entry.isSubagent && entry.parentConvId) {
        const parentEntry = this.convCache.get(entry.parentConvId);
        if (parentEntry && !parentEntry.spawnedSubagentIds.includes(entry.id)) {
          parentEntry.spawnedSubagentIds.push(entry.id);
        }
        if (entry.totalTokens > 0) {
          subagentTokens.set(entry.parentConvId, (subagentTokens.get(entry.parentConvId) || 0) + entry.totalTokens);
        }
      }
    }

    const allRecentCompactTokens = [];
    const sortedEntries = [...this.convCache.values()].sort(
      (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0)
    );
    for (const entry of sortedEntries) {
      if (Array.isArray(entry.compactTriggerTokens) && entry.compactTriggerTokens.length > 0) {
        allRecentCompactTokens.push(...entry.compactTriggerTokens.slice(-5));
        if (allRecentCompactTokens.length >= 25) break;
      }
    }
    const globalObservedCeiling = computeMedian(allRecentCompactTokens);

    if (anyTranscriptChanged) {
      this.transcriptRev += 1;
      this.cachedCardsState = null;
      this.scheduleSaveIndexCache();
    }

    const summary = {
      sortedEntries,
      subagentTokens,
      globalObservedCeiling
    };
    this.cachedIndexSummary = summary;

    const endNs = process.hrtime.bigint();
    this.lastRefreshDurationMs = Number(endNs - startNs) / 1e6;

    return summary;
  }

  lookupModelLabel(modelEnum) {
    if (!modelEnum) return '';
    const found = this.cachedModelsCatalog.models.find((m) => m.modelEnum === modelEnum);
    return found ? found.label : '';
  }

  lookupModelByAny(val) {
    const clean = (typeof val === 'string' ? val : '').trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();
    return (
      this.cachedModelsCatalog.models.find(
        (m) =>
          m.modelEnum === clean ||
          m.modelId === clean ||
          m.label === clean ||
          (m.modelId && m.modelId.toLowerCase() === lower) ||
          m.label.toLowerCase() === lower
      ) || null
    );
  }

  getModelsCatalog(force = false) {
    const now = Date.now();
    if (
      !force &&
      this.cachedModelsCatalog.models.length > 0 &&
      now - this.cachedModelsCatalog.fetchedAtMs < 60000
    ) {
      return Promise.resolve(this.cachedModelsCatalog);
    }
    if (this.modelsFetchPromise) {
      return this.modelsFetchPromise;
    }
    if (!force && now - this.cachedModelsCatalog.fetchedAtMs < 5000) {
      return Promise.resolve(this.cachedModelsCatalog);
    }
    this.modelsFetchPromise = (async () => {
      try {
        const res = await callLanguageServerRpc('GetCascadeModelConfigData', {});
        const parsed = parseCascadeModelConfigs(res);
        if (parsed.models.length > 0) {
          const prevSig = JSON.stringify([
            this.cachedModelsCatalog.defaultModelEnum,
            this.cachedModelsCatalog.models.map((m) => m.modelEnum)
          ]);
          const nextSig = JSON.stringify([
            parsed.defaultModelEnum,
            parsed.models.map((m) => m.modelEnum)
          ]);
          this.cachedModelsCatalog = {
            models: parsed.models,
            defaultModelEnum: parsed.defaultModelEnum,
            fetchedAtMs: Date.now()
          };
          if (prevSig !== nextSig) {
            this.modelsCatalogRev += 1;
            this.cachedCardsState = null;
          }
        } else {
          this.cachedModelsCatalog.fetchedAtMs = Date.now();
        }
      } catch {} finally {
        this.modelsFetchPromise = null;
      }
      return this.cachedModelsCatalog;
    })();
    return this.modelsFetchPromise;
  }

  async resolveConversationModelAsync(convId, force = false) {
    const cleanId = (convId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) return '';
    const entry = this.convCache.get(cleanId) || this.refreshSingleEntry(cleanId);
    if (!force && entry && entry.modelEnum && entry.modelResolvedMtimeMs === entry.mtimeMs) {
      return entry.modelEnum;
    }
    if (this.modelResolveInFlight.has(cleanId)) {
      return (entry && entry.modelEnum) || '';
    }
    const lastTry = this.modelResolveCooldown.get(cleanId) || 0;
    if (!force && Date.now() - lastTry < 4000) {
      return (entry && entry.modelEnum) || '';
    }
    this.modelResolveInFlight.add(cleanId);
    this.modelResolveCooldown.set(cleanId, Date.now());
    try {
      let res = await callLanguageServerRpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: cleanId,
        generatorMetadataOffset: 0,
        includeMessages: false
      });
      let list = Array.isArray(res && res.generatorMetadata)
        ? res.generatorMetadata
        : (Array.isArray(res && res.data && res.data.generatorMetadata) ? res.data.generatorMetadata : []);
      if (list.length === 0) {
        await callLanguageServerRpc('LoadTrajectory', { cascadeId: cleanId }, 3000);
        res = await callLanguageServerRpc('GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: cleanId,
          generatorMetadataOffset: 0,
          includeMessages: false
        });
        list = Array.isArray(res && res.generatorMetadata)
          ? res.generatorMetadata
          : (Array.isArray(res && res.data && res.data.generatorMetadata) ? res.data.generatorMetadata : []);
      }
      let foundEnum = '';
      let foundLabel = '';
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (!item) continue;
        const mEnum =
          (item.plannerConfig &&
            item.plannerConfig.requestedModel &&
            (item.plannerConfig.requestedModel.model || item.plannerConfig.requestedModel.alias)) ||
          (item.plannerConfig && item.plannerConfig.planModel) ||
          (item.chatModel && item.chatModel.model) ||
          '';
        const mLabel =
          (item.chatModel && item.chatModel.modelDisplayName) ||
          (item.plannerConfig && item.plannerConfig.modelName) ||
          '';
        if ((mEnum && mEnum !== 'MODEL_UNSPECIFIED') || mLabel) {
          foundEnum = mEnum && mEnum !== 'MODEL_UNSPECIFIED' ? mEnum : '';
          foundLabel = mLabel;
          break;
        }
      }
      if (foundLabel || foundEnum) {
        const catalogHit =
          (foundEnum && this.lookupModelByAny(foundEnum)) ||
          (foundLabel && this.lookupModelByAny(foundLabel)) ||
          null;
        if (catalogHit) {
          foundEnum = catalogHit.modelEnum;
          foundLabel = catalogHit.label;
        }
      }
      const targetEntry = this.convCache.get(cleanId) || entry;
      if (targetEntry && (!res || !res.error)) {
        targetEntry.modelResolvedMtimeMs = targetEntry.mtimeMs || Date.now();
        if (foundEnum) {
          const resolvedLabel = foundLabel || this.lookupModelLabel(foundEnum) || '';
          if (
            targetEntry.modelEnum !== foundEnum ||
            (resolvedLabel && targetEntry.modelLabel !== resolvedLabel)
          ) {
            targetEntry.modelEnum = foundEnum;
            if (resolvedLabel) targetEntry.modelLabel = resolvedLabel;
            this.transcriptRev += 1;
            this.cachedCardsState = null;
            this.scheduleSaveIndexCache();
          }
        }
      }
      return foundEnum || (targetEntry && targetEntry.modelEnum) || '';
    } catch {
      return (entry && entry.modelEnum) || '';
    } finally {
      this.modelResolveInFlight.delete(cleanId);
    }
  }

  triggerBackgroundModelResolution(hostConvId, visibleEntries) {
    void this.getModelsCatalog(false);
    const candidateIds = [];
    if (hostConvId && UUID_RE.test(hostConvId)) {
      candidateIds.push(hostConvId);
    }
    if (Array.isArray(visibleEntries)) {
      for (const e of visibleEntries) {
        if (!e || e.isSubagent) continue;
        if (!candidateIds.includes(e.id)) {
          candidateIds.push(e.id);
        }
        if (candidateIds.length >= 4) break;
      }
    }
    for (const cid of candidateIds) {
      const entry = this.convCache.get(cid);
      if (!entry) continue;
      if (entry.mtimeMs > 0 && entry.modelResolvedMtimeMs !== entry.mtimeMs) {
        void this.resolveConversationModelAsync(cid, false);
      }
    }
  }

  checkAgyBinaryChanged(force = false) {
    const now = Date.now();
    if (!force && now - this.lastBinaryStatCheckMs < 45000) {
      return;
    }
    this.lastBinaryStatCheckMs = now;
    const binPath = resolveLanguageServerBinary(this.appDataDir);
    if (!binPath) return;
    try {
      const stat = fs.statSync(binPath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) return;
      const sig = `${binPath}|${Math.floor(stat.mtimeMs)}|${stat.size}`;
      if (!this.diagnosticsState) {
        void this.runDiagnostics({ refresh: false });
      } else if (this.lastKnownBinarySig && sig !== this.lastKnownBinarySig) {
        void this.runDiagnostics({ refresh: true, agyUpdated: true });
      }
    } catch {}
  }

  getDiagnosticsStatusPayload(query = {}) {
    const sim = typeof query.simulateDiag === 'string' ? query.simulateDiag.trim().toLowerCase() : '';
    if (sim === 'fail' || sim === 'warn') {
      const isFail = sim === 'fail';
      const simIssue = {
        id: 'language_server_binary',
        title: 'Language Server Binary & RPC Symbols',
        status: isFail ? 'fail' : 'warn',
        codeSymbol: 'server.cjs:callLanguageServerRpc',
        detail: isFail
          ? 'Simulated failure: RPC GetCascadeModelConfigData not found in language_server binary.'
          : 'Simulated warning: RPC DeleteCascadeTrajectory not found in language_server binary (using disk fallback).',
        fixHint: 'Update RPC method name in sidecars/context-health/server.cjs (callLanguageServerRpc callers).'
      };
      return {
        status: isFail ? 'fail' : 'warn',
        issueCount: 1,
        failCount: isFail ? 1 : 0,
        warnCount: isFail ? 0 : 1,
        signature: `sim:${sim}`,
        checkedAtMs: Date.now(),
        agyUpdated: true,
        issues: [simIssue]
      };
    }

    const st = this.diagnosticsState;
    if (!st) {
      return {
        status: 'ok',
        issueCount: 0,
        failCount: 0,
        warnCount: 0,
        signature: 'ok',
        checkedAtMs: 0,
        agyUpdated: false,
        issues: []
      };
    }
    const issues = Array.isArray(st.contracts)
      ? st.contracts.filter((c) => c.status !== 'pass')
      : [];
    return {
      status: st.status || 'ok',
      issueCount: issues.length,
      failCount: st.failCount || 0,
      warnCount: st.warnCount || 0,
      signature: st.signature || 'ok',
      checkedAtMs: st.checkedAtMs || 0,
      agyUpdated: Boolean(st.agyUpdated),
      issues
    };
  }

  async runDiagnostics(options = {}) {
    const refresh = Boolean(options.refresh);
    const offlineMode = Boolean(options.offlineMode);
    const simulate = typeof options.simulate === 'string' ? options.simulate.trim().toLowerCase() : '';

    if (
      !refresh &&
      !simulate &&
      this.diagnosticsState &&
      Date.now() - (this.diagnosticsState.checkedAtMs || 0) < 30000
    ) {
      return this.diagnosticsState;
    }
    if (this.diagnosticsPromise && !simulate) {
      return this.diagnosticsPromise;
    }

    const runPromise = (async () => {
      const startNs = process.hrtime.bigint();
      const contracts = [];
      const addContract = (id, title, status, codeSymbol, detail, fixHint = '') => {
        contracts.push({ id, title, status, codeSymbol, detail, fixHint });
      };

      const appDirExists = isDirectory(this.appDataDir);
      const brainDirExists = isDirectory(this.brainDir);
      const projectsDirExists = isDirectory(this.projectsDir);
      if (!appDirExists) {
        addContract(
          'app_data_dirs',
          'On-Disk App Data & Directories',
          'fail',
          'server.cjs:resolveAppDataDir',
          `App data directory not found at ${this.appDataDir}`,
          'Check APP_CANDIDATES or ANTIGRAVITY_APP_DATA_DIR resolution in server.cjs:resolveAppDataDir().'
        );
      } else {
        addContract(
          'app_data_dirs',
          'On-Disk App Data & Directories',
          'pass',
          'server.cjs:resolveAppDataDir, resolveProjectsDir',
          `appDataDir=${this.appDataDir} (brain=${brainDirExists ? 'ok' : 'empty'}, projects=${projectsDirExists ? 'ok' : 'empty'})`
        );
      }

      let convDirsChecked = 0;
      let transcriptsFound = 0;
      let userStepsCount = 0;
      let plannerStepsCount = 0;
      let plannerWithTokensCount = 0;
      let truncatedWithoutFullCount = 0;

      if (brainDirExists) {
        try {
          const dirents = fs.readdirSync(this.brainDir, { withFileTypes: true });
          const uuidDirs = [];
          for (const d of dirents) {
            if (!d.isDirectory() || !UUID_RE.test(d.name)) continue;
            const sysGenDir = path.join(this.brainDir, d.name, '.system_generated');
            const trPath = path.join(sysGenDir, 'logs', 'transcript.jsonl');
            let mtimeMs = 0;
            try {
              const st = fs.statSync(trPath, { throwIfNoEntry: false }) || fs.statSync(sysGenDir, { throwIfNoEntry: false });
              mtimeMs = st ? st.mtimeMs : 0;
            } catch {}
            if (mtimeMs > 0) {
              uuidDirs.push({ id: d.name, trPath, mtimeMs });
            }
          }
          uuidDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
          for (const item of uuidDirs.slice(0, 12)) {
            convDirsChecked += 1;
            if (!isFile(item.trPath)) continue;
            transcriptsFound += 1;
            const raw = fs.readFileSync(item.trPath, 'utf-8');
            const lines = raw.split(/\r?\n/).filter(Boolean).slice(-80);
            for (const line of lines) {
              let obj;
              try {
                obj = JSON.parse(line);
              } catch {
                continue;
              }
              if (obj.type === 'USER_INPUT') userStepsCount += 1;
              if (obj.type === 'PLANNER_RESPONSE') {
                plannerStepsCount += 1;
                if (
                  typeof obj.input_tokens === 'number' ||
                  typeof obj.cache_read_tokens === 'number' ||
                  typeof obj.output_tokens === 'number'
                ) {
                  plannerWithTokensCount += 1;
                }
              }
              if (Array.isArray(obj.truncated_fields) && obj.truncated_fields.length > 0) {
                const fullPath = path.join(path.dirname(item.trPath), 'transcript_full.jsonl');
                if (!isFile(fullPath)) {
                  truncatedWithoutFullCount += 1;
                }
              }
            }
          }
        } catch {}
      }

      if (convDirsChecked >= 3 && transcriptsFound === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'fail',
          'server.cjs:processTranscriptLine, updateTranscriptEntry',
          `Found ${convDirsChecked} conversation directories with .system_generated, but 0 logs/transcript.jsonl files.`,
          'Antigravity may have moved or renamed .system_generated/logs/transcript.jsonl. Update transcript path resolution in server.cjs.'
        );
      } else if (transcriptsFound > 0 && userStepsCount === 0 && plannerStepsCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'fail',
          'server.cjs:processTranscriptLine',
          `Sampled ${transcriptsFound} transcript.jsonl files, but found 0 USER_INPUT or PLANNER_RESPONSE steps.`,
          'Step type enum names in transcript.jsonl may have changed. Check processTranscriptLine() in server.cjs.'
        );
      } else if (plannerStepsCount >= 3 && plannerWithTokensCount === 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:processTranscriptLine',
          `Found ${plannerStepsCount} PLANNER_RESPONSE steps across ${transcriptsFound} transcripts, but none had input_tokens/cache_read_tokens/output_tokens.`,
          'Token usage field names in transcript.jsonl may have changed. Update token extraction in server.cjs:processTranscriptLine().'
        );
      } else if (truncatedWithoutFullCount > 0) {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'warn',
          'server.cjs:resolveFullCheckpointOverview',
          `Found ${truncatedWithoutFullCount} steps with truncated_fields where transcript_full.jsonl was missing.`,
          'Check whether transcript_full.jsonl was renamed in .system_generated/logs/.'
        );
      } else {
        addContract(
          'transcript_schema',
          'Conversation Transcript JSONL Schema',
          'pass',
          'server.cjs:processTranscriptLine, updateTranscriptEntry',
          `Verified ${transcriptsFound} recent transcript(s) (${userStepsCount} USER_INPUT, ${plannerWithTokensCount}/${plannerStepsCount} PLANNER_RESPONSE with token fields).`
        );
      }

      let pbtxtChecked = 0;
      let pbtxtParsedFields = 0;
      if (isDirectory(this.annotationsDir)) {
        try {
          const files = fs.readdirSync(this.annotationsDir).filter((f) => f.endsWith('.pbtxt')).slice(0, 15);
          for (const f of files) {
            const fp = path.join(this.annotationsDir, f);
            const st = fs.statSync(fp, { throwIfNoEntry: false });
            if (!st || st.size < 8) continue;
            pbtxtChecked += 1;
            const raw = fs.readFileSync(fp, 'utf-8');
            const parsed = extractAnnotationFromPbtxt(raw);
            if (parsed.lastViewMs > 0 || parsed.title || parsed.archived || parsed.markedAsUnread) {
              pbtxtParsedFields += 1;
            }
          }
        } catch {}
      }
      if (pbtxtChecked >= 3 && pbtxtParsedFields === 0) {
        addContract(
          'annotations_pbtxt',
          'Conversation Annotations (.pbtxt) Schema',
          'warn',
          'server.cjs:extractAnnotationFromPbtxt, resolveConversationAnnotation',
          `Checked ${pbtxtChecked} non-empty .pbtxt files in annotations/, but 0 matched title/last_user_view_time/archived.`,
          'Inspect ~/.gemini/antigravity/annotations/*.pbtxt and update regexes in server.cjs:extractAnnotationFromPbtxt().'
        );
      } else {
        addContract(
          'annotations_pbtxt',
          'Conversation Annotations (.pbtxt) Schema',
          'pass',
          'server.cjs:extractAnnotationFromPbtxt, resolveConversationAnnotation',
          pbtxtChecked > 0
            ? `Parsed ${pbtxtParsedFields}/${pbtxtChecked} sampled annotation .pbtxt file(s).`
            : 'No annotation .pbtxt files present yet.'
        );
      }

      let projFilesChecked = 0;
      let projWithRawResources = 0;
      let projWithExtractedPaths = 0;
      if (projectsDirExists) {
        try {
          const files = fs.readdirSync(this.projectsDir).filter((f) => f.toLowerCase().endsWith('.json')).slice(0, 20);
          for (const f of files) {
            const projId = f.slice(0, -5);
            if (!UUID_RE.test(projId)) continue;
            const fp = path.join(this.projectsDir, f);
            const rawObj = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            projFilesChecked += 1;
            const hasRawRes =
              (Array.isArray(rawObj?.projectResources?.resources) && rawObj.projectResources.resources.length > 0) ||
              (Array.isArray(rawObj?.environments?.environments) && rawObj.environments.environments.length > 0);
            if (hasRawRes) {
              projWithRawResources += 1;
              const extracted = extractProjectResourcePaths(rawObj);
              if (extracted.length > 0) {
                projWithExtractedPaths += 1;
              }
            }
          }
        } catch {}
      }
      if (projWithRawResources > 0 && projWithExtractedPaths === 0) {
        addContract(
          'projects_registry',
          'Projects Registry JSON Schema',
          'warn',
          'server.cjs:extractProjectResourcePaths, refreshProjectsRegistry',
          `Found ${projWithRawResources} project JSON file(s) with resources, but extractProjectResourcePaths() extracted 0 folder URIs.`,
          'Inspect ~/.gemini/config/projects/*.json and update folderUri extraction in server.cjs:extractProjectResourcePaths().'
        );
      } else {
        addContract(
          'projects_registry',
          'Projects Registry JSON Schema',
          'pass',
          'server.cjs:extractProjectResourcePaths, refreshProjectsRegistry',
          `Verified ${projFilesChecked} project JSON file(s) (${projWithExtractedPaths}/${projWithRawResources} resource path sets extracted).`
        );
      }

      const lsBinPath = resolveLanguageServerBinary(this.appDataDir);
      const rpcMethodNames = LSRPC_CONTRACT_SPECS.map((s) => s.method);
      const allSymbolsToScan = [
        'LanguageServerService',
        ...rpcMethodNames,
        'send-message',
        'new-conversation'
      ];
      const binScan = scanBinarySymbols(lsBinPath, allSymbolsToScan);
      const nextBinarySig = lsBinPath && binScan.mtimeMs > 0
        ? `${lsBinPath}|${binScan.mtimeMs}|${binScan.size}`
        : '';
      const agyUpdated = Boolean(
        options.agyUpdated ||
        (this.lastKnownBinarySig && nextBinarySig && this.lastKnownBinarySig !== nextBinarySig)
      );
      if (nextBinarySig && nextBinarySig !== this.lastKnownBinarySig) {
        this.lastKnownBinarySig = nextBinarySig;
        try {
          writeJsonAtomic(this.diagnosticsCachePath, {
            binarySig: nextBinarySig,
            updatedAtMs: Date.now()
          });
        } catch {}
      }

      if (!lsBinPath || binScan.error) {
        addContract(
          'language_server_binary',
          'Language Server Binary & RPC Symbols',
          'warn',
          'server.cjs:resolveLanguageServerBinary, callLanguageServerRpc',
          `Could not locate or scan language_server binary (${binScan.error || 'not found'}).`,
          'Update binary candidate paths in server.cjs:resolveLanguageServerBinary().'
        );
      } else {
        const missingCritical = LSRPC_CONTRACT_SPECS
          .filter((s) => s.critical && !binScan.found.has(s.method));
        const missingOptional = LSRPC_CONTRACT_SPECS
          .filter((s) => !s.critical && !binScan.found.has(s.method));
        const hasService = binScan.found.has('LanguageServerService');

        if (!hasService || missingCritical.length > 0) {
          const missingNames = [
            ...(!hasService ? ['LanguageServerService'] : []),
            ...missingCritical.map((m) => `${m.method} (${m.caller})`),
            ...missingOptional.map((m) => `${m.method} (${m.caller})`)
          ];
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'fail',
            'server.cjs:callLanguageServerRpc',
            `Missing critical RPC symbol(s) in language_server binary: ${missingNames.join('; ')}`,
            'Antigravity renamed or removed LanguageServerService RPC method(s). Run /agy-api-audit and update callLanguageServerRpc callers in server.cjs.'
          );
        } else if (missingOptional.length > 0) {
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'warn',
            'server.cjs:callLanguageServerRpc',
            `Missing optional RPC symbol(s) in language_server binary (fallbacks active): ${missingOptional.map((m) => `${m.method} [${m.caller}]`).join('; ')}`,
            'Update renamed RPC method(s) in server.cjs so primary RPC path works without relying on CLI/disk fallback.'
          );
        } else {
          addContract(
            'language_server_binary',
            'Language Server Binary & RPC Symbols',
            'pass',
            'server.cjs:callLanguageServerRpc',
            `All ${rpcMethodNames.length} RPC methods + LanguageServerService verified in ${path.basename(lsBinPath)}.`
          );
        }
      }

      const hasLsEnv = Boolean(
        (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() &&
        (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim()
      );
      if (!hasLsEnv) {
        if (offlineMode) {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'pass',
            'server.cjs:callLanguageServerRpc, parseCascadeModelConfigs',
            'Offline CLI mode (sidecar process not attached to live Language Server env; binary symbols verified).'
          );
        } else {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'warn',
            'server.cjs:callLanguageServerRpc',
            'Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN in running sidecar environment.',
            'Check if Antigravity renamed sidecar Language Server environment variables.'
          );
        }
      } else {
        const modelRpcRes = await callLanguageServerRpc('GetCascadeModelConfigData', {}, 4000);
        if (modelRpcRes && modelRpcRes.error) {
          addContract(
            'language_server_live_rpc',
            'Live Language Server RPC Probe',
            'fail',
            'server.cjs:getModelsCatalog, callLanguageServerRpc',
            `Live GetCascadeModelConfigData RPC failed: ${modelRpcRes.error}`,
            'Inspect LanguageServerService/GetCascadeModelConfigData request/response contract in server.cjs:getModelsCatalog().'
          );
        } else {
          const parsedCatalog = parseCascadeModelConfigs(modelRpcRes);
          if (parsedCatalog.models.length === 0) {
            addContract(
              'language_server_live_rpc',
              'Live Language Server RPC Probe',
              'warn',
              'server.cjs:parseCascadeModelConfigs',
              'GetCascadeModelConfigData returned HTTP 200, but parseCascadeModelConfigs() extracted 0 models.',
              'The clientModelConfigs / modelOrAlias response schema in GetCascadeModelConfigData changed. Update server.cjs:parseCascadeModelConfigs().'
            );
          } else {
            let metaDetail = `GetCascadeModelConfigData returned ${parsedCatalog.models.length} models (default=${parsedCatalog.defaultModelEnum || 'auto'})`;
            const sampleEntry = [...this.convCache.values()].find((e) => !e.isSubagent && UUID_RE.test(e.id));
            if (sampleEntry) {
              const metaRes = await callLanguageServerRpc(
                'GetCascadeTrajectoryGeneratorMetadata',
                { cascadeId: sampleEntry.id, generatorMetadataOffset: 0, includeMessages: false },
                3500
              );
              if (metaRes && metaRes.error && Number(metaRes.statusCode) === 404) {
                addContract(
                  'language_server_live_rpc',
                  'Live Language Server RPC Probe',
                  'warn',
                  'server.cjs:resolveConversationModelAsync',
                  `GetCascadeTrajectoryGeneratorMetadata returned HTTP 404 (${metaRes.error}).`,
                  'Update trajectory model metadata RPC in server.cjs:resolveConversationModelAsync().'
                );
              } else {
                metaDetail += '; GetCascadeTrajectoryGeneratorMetadata HTTP 200.';
                addContract(
                  'language_server_live_rpc',
                  'Live Language Server RPC Probe',
                  'pass',
                  'server.cjs:getModelsCatalog, resolveConversationModelAsync',
                  metaDetail
                );
              }
            } else {
              addContract(
                'language_server_live_rpc',
                'Live Language Server RPC Probe',
                'pass',
                'server.cjs:getModelsCatalog, parseCascadeModelConfigs',
                metaDetail
              );
            }
          }
        }
      }

      const agentApiCmd = resolveAgentApiCommand(this.appDataDir);
      const agentApiFileExists = Boolean(agentApiCmd && agentApiCmd.file && isFile(agentApiCmd.file));
      const hasSendMsgSym = !lsBinPath || binScan.error || binScan.found.has('send-message');
      const hasNewConvSym = !lsBinPath || binScan.error || binScan.found.has('new-conversation');
      if (!agentApiFileExists) {
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'fail',
          'server.cjs:resolveAgentApiCommand, execAgentApi',
          `AgentAPI executable not found on disk (resolved: ${agentApiCmd ? agentApiCmd.file : 'none'}).`,
          'Update binary resolution in server.cjs:resolveAgentApiCommand().'
        );
      } else if (!hasSendMsgSym || !hasNewConvSym) {
        const missingCmds = [
          ...(!hasSendMsgSym ? ['send-message'] : []),
          ...(!hasNewConvSym ? ['new-conversation'] : [])
        ];
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'fail',
          'server.cjs:execAgentApi',
          `AgentAPI binary (${path.basename(agentApiCmd.file)}) is missing subcommand symbol(s): ${missingCmds.join(', ')}`,
          'Check new CLI subcommands in language_server agentapi and update server.cjs:execAgentApi() callers.'
        );
      } else {
        addContract(
          'agentapi_cli',
          'AgentAPI CLI Binary & Subcommands',
          'pass',
          'server.cjs:resolveAgentApiCommand, execAgentApi',
          `Resolved ${agentApiCmd.file} with send-message and new-conversation subcommands.`
        );
      }

      const preloadContent = this.loadPreloadJs();
      const requiredBridgeTokens = [
        'window.sidecar',
        'sendMessage',
        'startConversation',
        'toggleConversation',
        'getWorkspaceUris',
        'onWorkspaceChange'
      ];
      const missingBridge = requiredBridgeTokens.filter((t) => !preloadContent.includes(t));
      const sdkPreloadPath = path.join(this.appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
      const usingSdkPreload = isFile(sdkPreloadPath);
      const warmRefreshMs = Number((this.lastRefreshDurationMs || 0).toFixed(2));
      if (missingBridge.length > 0) {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'fail',
          'server.cjs:loadPreloadJs, FALLBACK_PRELOAD_JS',
          `/preload.js is missing required window.sidecar method(s): ${missingBridge.join(', ')}`,
          'Update FALLBACK_PRELOAD_JS or loadPreloadJs() in server.cjs.'
        );
      } else if (warmRefreshMs > 25 && this.initialBootScanDone) {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'warn',
          'server.cjs:refreshIndex, handleStatusRequest',
          `Bridge OK (${usingSdkPreload ? 'sdk preload.js' : 'FALLBACK_PRELOAD_JS'}), but last /api/status refresh took ${warmRefreshMs} ms (target < 5 ms warm).`,
          'Check incremental parsing and mtimeMs caches in server.cjs:refreshIndex().'
        );
      } else {
        addContract(
          'sidecar_bridge_and_perf',
          'Sidecar Preload Bridge & Performance Budget',
          'pass',
          'server.cjs:loadPreloadJs, handleStatusRequest',
          `Bridge OK (${usingSdkPreload ? 'sdk preload.js' : 'FALLBACK_PRELOAD_JS'}), warm /api/status refresh=${warmRefreshMs} ms.`
        );
      }

      if (simulate === 'fail' || simulate === 'warn') {
        contracts.push({
          id: 'simulated_contract',
          title: 'Simulated AGY Breaking Change',
          status: simulate === 'fail' ? 'fail' : 'warn',
          codeSymbol: 'server.cjs:callLanguageServerRpc',
          detail: simulate === 'fail'
            ? 'Simulated FAIL: LanguageServerService RPC signature changed after AGY update.'
            : 'Simulated WARN: Optional RPC method changed; fallback active.',
          fixHint: 'Run node setup.cjs --doctor and update the affected contract in server.cjs.'
        });
      }

      const failCount = contracts.filter((c) => c.status === 'fail').length;
      const warnCount = contracts.filter((c) => c.status === 'warn').length;
      const issueCount = failCount + warnCount;
      const overallStatus = failCount > 0 ? 'fail' : (warnCount > 0 ? 'warn' : 'ok');
      const issuesSig = issueCount === 0
        ? 'ok'
        : contracts
            .filter((c) => c.status !== 'pass')
            .map((c) => `${c.id}:${c.status}:${c.detail}`)
            .join('|');
      const durationMs = Number((Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(2));
      const nowMs = Date.now();

      const report = {
        status: overallStatus,
        checkedAtMs: nowMs,
        checkedAtIso: new Date(nowMs).toISOString(),
        durationMs,
        agyUpdated,
        agyBinary: {
          path: lsBinPath || '',
          mtimeMs: binScan.mtimeMs || 0,
          size: binScan.size || 0
        },
        issueCount,
        failCount,
        warnCount,
        signature: issuesSig,
        contracts
      };

      if (!simulate) {
        const prevSig = this.diagnosticsState ? this.diagnosticsState.signature : '';
        this.diagnosticsState = report;
        if (prevSig !== issuesSig) {
          this.diagnosticsRev += 1;
          this.cachedCardsState = null;
        }
      }
      return report;
    })();

    if (!simulate) {
      this.diagnosticsPromise = runPromise;
      try {
        return await runPromise;
      } finally {
        this.diagnosticsPromise = null;
      }
    }
    return runPromise;
  }

  buildConversationCard(entry, globalObservedCeiling, subagentTokens) {
    const verbatimPrompts = entry.compactCount > 0
      ? Math.min(10, entry.promptCount)
      : entry.promptCount;
    const compactedPrompts = entry.compactCount > 0
      ? Math.max(0, entry.promptCount - 10)
      : 0;
    const pollution = classifyPollution(entry.compactCount, compactedPrompts);
    const localCeiling = computeMedian((entry.compactTriggerTokens || []).slice(-10));
    const observedCeiling = localCeiling || globalObservedCeiling || 0;
    const currentTokens = entry.currentTokens || 0;
    const ceilingExceeded = observedCeiling > 0 && currentTokens > observedCeiling;
    const contextRatio = observedCeiling > 0 && !ceilingExceeded
      ? Math.min(1, currentTokens / observedCeiling)
      : null;

    const drift = this.gitCache.computeDriftForConversation(entry);
    const matchedProj = this.matchProjectForWorkspace(entry.workspacePath || '');
    const effectiveWsPath = matchedProj
      ? (matchedProj.primaryPath || entry.workspacePath || '')
      : (entry.workspacePath || '');
    const effectiveWsKey = matchedProj
      ? (matchedProj.primaryKey || workspaceComparisonKey(effectiveWsPath))
      : workspaceComparisonKey(effectiveWsPath);
    const effectiveWsName = matchedProj
      ? matchedProj.name
      : getWorkspaceLabel(effectiveWsPath);

    const waitState = getEntryWaitState(entry);
    const isThinking = !waitState && isEntryThinking(entry);
    const seenBaselineMs = Math.max(
      entry.lastSeenMs || 0,
      entry.lastViewMs || 0,
      entry.lastUserInputMs || 0
    );
    const unread = Boolean(
      !isThinking &&
      !waitState &&
      (((entry.lastModelResponseMs || 0) > 0 && (entry.lastModelResponseMs || 0) > seenBaselineMs) ||
        entry.markedAsUnread)
    );

    return {
      id: entry.id,
      isSubagent: !!entry.isSubagent,
      subagentTokens: subagentTokens ? (subagentTokens.get(entry.id) || 0) : 0,
      projectId: matchedProj ? matchedProj.id : '',
      workspacePath: effectiveWsPath,
      workspaceKey: effectiveWsKey,
      workspaceName: effectiveWsName,
      lastActiveIso: entry.lastActiveIso || '',
      lastActiveMs: entry.lastActiveMs || 0,
      lastUserInputMs: entry.lastUserInputMs || 0,
      lastViewMs: entry.lastViewMs || 0,
      lastSeenMs: entry.lastSeenMs || 0,
      latestHandoffMs: entry.latestHandoffMs || 0,
      latestHandoffPrompt: entry.latestHandoffPrompt || '',
      compactCount: entry.compactCount || 0,
      lastCompactMs: entry.lastCompactMs || 0,
      promptsSinceLastCompact: entry.promptsSinceLastCompact || 0,
      pollution,
      promptCount: entry.promptCount || 0,
      verbatimPrompts,
      compactedPrompts,
      currentTokens,
      totalInputTokens: entry.totalInputTokens || 0,
      totalCacheReadTokens: entry.totalCacheReadTokens || 0,
      totalOutputTokens: entry.totalOutputTokens || 0,
      totalTokens: entry.totalTokens || 0,
      observedCeiling,
      ceilingExceeded,
      contextRatio,
      title: entry.title || '',
      firstPrompt: entry.firstPrompt || '',
      lastPrompt: entry.lastPrompt || '',
      lastModelResponse: entry.lastModelResponse || '',
      lastModelResponseMs: entry.lastModelResponseMs || 0,
      isThinking,
      waitState,
      unread,
      modelEnum: entry.modelEnum || '',
      modelLabel: entry.modelLabel || this.lookupModelLabel(entry.modelEnum) || '',
      git: {
        hasGit: drift.hasGit,
        commitsBehind: drift.commitsBehind
      }
    };
  }

  handleStatusRequest(query) {
    let workspaceUris = [];
    if (query.workspaceUris) {
      try {
        workspaceUris = JSON.parse(query.workspaceUris);
      } catch {
        workspaceUris = [query.workspaceUris];
      }
    }

    const isForce = query.force === '1';
    if (isForce) {
      this.gitCache.invalidateMtimeChecks();
    }

    const hostConvId = (
      query.activeConvId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ''
    ).trim().toLowerCase();

    this.refreshProjectsRegistry(isForce);
    const hasProjectsRegistry = this.projectsRegistry.size > 0;

    const { sortedEntries, subagentTokens, globalObservedCeiling } = this.refreshIndex({
      activeConvId: hostConvId,
      workspaceUris,
      force: isForce
    });

    const viewedConvId = (query.viewedConvId || '').trim().toLowerCase();
    if (UUID_RE.test(viewedConvId)) {
      const viewedEntry = this.convCache.get(viewedConvId);
      if (viewedEntry && !isEntryThinking(viewedEntry) && !getEntryWaitState(viewedEntry)) {
        this.markConversationSeen(viewedConvId);
      }
    }

    const detectedActiveWorkspaceNorm = workspaceUris.length > 0
      ? resolveCanonicalWorkspace(workspaceUris[0])
      : (sortedEntries.find((e) => e.id === hostConvId)?.workspacePath || '');

    const matchedActiveProj = this.matchProjectForWorkspace(detectedActiveWorkspaceNorm);
    const activeWorkspaceKey = matchedActiveProj
      ? (matchedActiveProj.archived ? '' : (matchedActiveProj.primaryKey || matchedActiveProj.id))
      : (hasProjectsRegistry && detectedActiveWorkspaceNorm ? '' : workspaceComparisonKey(detectedActiveWorkspaceNorm));

    this.gitCache.checkKnownRepos(isForce);
    this.checkAgyBinaryChanged(isForce);

    const checkNowMs = Date.now();
    if (this.cachedCardsState && Array.isArray(this.cachedCardsState.cards)) {
      for (let i = 0; i < this.cachedCardsState.cards.length; i++) {
        const c = this.cachedCardsState.cards[i];
        const e = this.cachedCardsState.visibleEntries[i];
        if (
          c &&
          e &&
          (Boolean(c.isThinking) !== isEntryThinking(e, checkNowMs) ||
            (c.waitState || '') !== getEntryWaitState(e, checkNowMs))
        ) {
          this.cachedCardsState = null;
          break;
        }
      }
    }

    let visibleEntries;
    let cards;
    let workspaces;
    let archivedProjects;
    let archivedConversations;
    if (
      !isForce &&
      this.cachedCardsState &&
      this.cachedCardsState.transcriptRev === this.transcriptRev &&
      this.cachedCardsState.projectsRev === this.projectsRev &&
      this.cachedCardsState.gitRev === this.gitCache.revision &&
      this.cachedCardsState.modelsCatalogRev === this.modelsCatalogRev &&
      this.cachedCardsState.diagnosticsRev === this.diagnosticsRev &&
      this.cachedCardsState.activeWorkspaceKey === activeWorkspaceKey
    ) {
      visibleEntries = this.cachedCardsState.visibleEntries;
      cards = this.cachedCardsState.cards;
      workspaces = this.cachedCardsState.workspaces;
      archivedProjects = this.cachedCardsState.archivedProjects;
      archivedConversations = this.cachedCardsState.archivedConversations || [];
    } else {
      const archivedConvCounts = new Map();
      const hiddenMainItems = [];
      archivedConversations = [];
      visibleEntries = sortedEntries.filter((e) => {
        if (e.isSubagent) return false;
        if (e.archived) {
          const matchedProj = this.matchProjectForWorkspace(e.workspacePath || '');
          const effectiveWsPath = matchedProj
            ? (matchedProj.primaryPath || e.workspacePath || '')
            : (e.workspacePath || '');
          const effectiveWsName = matchedProj
            ? matchedProj.name
            : getWorkspaceLabel(effectiveWsPath);
          archivedConversations.push({
            id: e.id,
            title: e.title || '',
            firstPrompt: e.firstPrompt || '',
            lastPrompt: e.lastPrompt || '',
            workspaceName: effectiveWsName,
            lastActiveMs: e.lastActiveMs || 0
          });
          hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
          return false;
        }
        if (hasProjectsRegistry && e.workspacePath) {
          const proj = this.matchProjectForWorkspace(e.workspacePath);
          if (!proj) {
            hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
            return false;
          }
          if (proj.archived) {
            archivedConvCounts.set(proj.id, (archivedConvCounts.get(proj.id) || 0) + 1);
            hiddenMainItems.push([e.id, e.lastActiveMs, e.latestHandoffMs, e.currentTokens, e.totalTokens, e.promptCount, e.compactCount]);
            return false;
          }
        }
        return true;
      });

      cards = visibleEntries.map((entry) =>
        this.buildConversationCard(entry, globalObservedCeiling, subagentTokens)
      );

      const workspaceMap = new Map();
      for (const c of cards) {
        if (c.isSubagent) continue;
        const key = c.workspaceKey || '__unscoped__';
        const activityMs = Math.max(c.lastActiveMs || 0, c.lastViewMs || 0);
        const existing = workspaceMap.get(key);
        if (existing) {
          existing.count += 1;
          if (activityMs > existing.lastActiveMs) {
            existing.lastActiveMs = activityMs;
          }
          if (!existing.projectId && c.projectId) {
            existing.projectId = c.projectId;
          }
        } else {
          workspaceMap.set(key, {
            key,
            projectId: c.projectId || '',
            path: c.workspacePath || '',
            name: c.workspaceName,
            count: 1,
            lastActiveMs: activityMs
          });
        }
      }
      if (matchedActiveProj && !matchedActiveProj.archived) {
        const activeKey = matchedActiveProj.primaryKey || matchedActiveProj.id;
        if (activeKey && !workspaceMap.has(activeKey)) {
          workspaceMap.set(activeKey, {
            key: activeKey,
            projectId: matchedActiveProj.id,
            path: matchedActiveProj.primaryPath || detectedActiveWorkspaceNorm || '',
            name: matchedActiveProj.name,
            count: 0,
            lastActiveMs: Date.now()
          });
        }
      }
      workspaces = [...workspaceMap.values()].sort((a, b) => {
        if (a.key === '__unscoped__') return 1;
        if (b.key === '__unscoped__') return -1;
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
      });

      archivedProjects = [];
      for (const proj of this.projectsRegistry.values()) {
        if (proj.archived) {
          archivedProjects.push({
            id: proj.id,
            name: proj.name,
            path: proj.primaryPath || '',
            key: proj.primaryKey || proj.id,
            count: archivedConvCounts.get(proj.id) || 0
          });
        }
      }
      archivedProjects.sort((a, b) => a.name.localeCompare(b.name));

      const signature = JSON.stringify({
        globalObservedCeiling,
        projectsRev: this.projectsRev,
        modelsCatalogRev: this.modelsCatalogRev,
        diagnosticsRev: this.diagnosticsRev,
        activeWorkspaceKey,
        archivedIds: archivedProjects.map((p) => [p.id, p.count]),
        archivedConvIds: archivedConversations.map((c) => [c.id, c.title, c.lastActiveMs]),
        hiddenMainItems,
        items: cards.map((c) => [
          c.id,
          c.title,
          c.lastActiveMs,
          c.lastUserInputMs,
          c.lastViewMs,
          c.lastSeenMs,
          c.latestHandoffMs,
          c.compactCount,
          c.pollution.id,
          c.promptCount,
          c.currentTokens,
          c.totalTokens,
          c.subagentTokens,
          c.workspaceKey,
          c.projectId,
          c.modelEnum,
          c.modelLabel,
          c.lastPrompt,
          c.lastModelResponse,
          c.lastModelResponseMs,
          c.isThinking,
          c.waitState,
          c.unread,
          c.git.commitsBehind
        ])
      });

      if (signature !== this.lastStateSignature) {
        this.lastStateSignature = signature;
        this.stateVersion += 1;
      }

      this.cachedCardsState = {
        transcriptRev: this.transcriptRev,
        projectsRev: this.projectsRev,
        gitRev: this.gitCache.revision,
        modelsCatalogRev: this.modelsCatalogRev,
        diagnosticsRev: this.diagnosticsRev,
        activeWorkspaceKey,
        visibleEntries,
        cards,
        workspaces,
        archivedProjects,
        archivedConversations
      };
    }

    this.triggerBackgroundModelResolution(hostConvId, visibleEntries);

    const now = Date.now();
    if (isForce || now - this.lastUiStatCheckMs >= 2000) {
      this.lastUiStatCheckMs = now;
      try {
        this.cachedUiMtimeMs = Math.floor(fs.statSync(this.uiHtmlPath, { throwIfNoEntry: false })?.mtimeMs || 0);
      } catch {}
    }
    const uiMtimeMs = this.cachedUiMtimeMs;

    const clientVersion = parseInt(query.sinceVersion || '0', 10);
    if (clientVersion > 0 && clientVersion === this.stateVersion && !isForce && !query.simulateDiag) {
      return {
        unchanged: true,
        version: this.stateVersion,
        uiMtimeMs,
        refreshMs: Number(this.lastRefreshDurationMs.toFixed(2))
      };
    }

    if (
      UUID_RE.test(hostConvId) &&
      !this.deletedConvIds.has(hostConvId) &&
      !cards.some((c) => c.id === hostConvId)
    ) {
      const hostEntry = sortedEntries.find((e) => e.id === hostConvId);
      if (hostEntry && !hostEntry.archived && !hostEntry.isSubagent) {
        cards = [this.buildConversationCard(hostEntry, globalObservedCeiling, subagentTokens), ...cards];
      } else if (!hostEntry) {
        const cachedWs = this.metadataWorkspaceCache.get(hostConvId) || '';
        const candidateWs = cachedWs === '__general__'
          ? ''
          : (detectedActiveWorkspaceNorm || cachedWs || '');
        const placeholderEntry = createEmptyEntry(hostConvId);
        placeholderEntry.workspacePath = candidateWs;
        cards = [this.buildConversationCard(placeholderEntry, globalObservedCeiling, subagentTokens), ...cards];
      }
    }

    let searchMatches = null;
    const rawSearch = (query.q || '').trim().toLowerCase();
    if (rawSearch) {
      searchMatches = {};
      for (const entry of visibleEntries) {
        if (!entry.searchCorpusLower || !entry.searchCorpusLower.includes(rawSearch)) continue;
        const matchingPrompts = [];
        for (const p of entry.prompts) {
          if (p.text.toLowerCase().includes(rawSearch)) {
            matchingPrompts.push({
              index: p.index,
              createdAt: p.createdAt,
              text: p.text.slice(0, 400)
            });
            if (matchingPrompts.length >= 3) break;
          }
        }
        searchMatches[entry.id] = {
          matchingPrompts
        };
      }
    }

    return {
      unchanged: false,
      version: this.stateVersion,
      uiMtimeMs,
      refreshMs: Number(this.lastRefreshDurationMs.toFixed(2)),
      hostConversationId: hostConvId || null,
      activeWorkspaceKey: activeWorkspaceKey || '',
      availableModels: this.cachedModelsCatalog.models,
      defaultModelEnum: this.cachedModelsCatalog.defaultModelEnum || '',
      diagnostics: this.getDiagnosticsStatusPayload(query),
      workspaces,
      archivedProjects,
      archivedConversations,
      conversations: cards,
      searchMatches
    };
  }

  handleConversationDetails(query) {
    const convId = (query.id || '').trim().toLowerCase();
    if (!UUID_RE.test(convId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const entry = this.refreshSingleEntry(convId);
    if (!entry) {
      return { status: 404, body: { error: 'Conversation not found' } };
    }
    const drift = this.gitCache.computeDriftForConversation(entry);
    return {
      status: 200,
      body: {
        id: entry.id,
        checkpointOverview: entry.checkpointOverview,
        prompts: [...entry.prompts].reverse(),
        missedCommits: drift.missedCommits,
        commitsBehind: drift.commitsBehind
      }
    };
  }

  handleHandoffSummary(query) {
    const convId = (query.id || '').trim().toLowerCase();
    const focusTopic = (query.focus || '').trim();
    if (!UUID_RE.test(convId)) {
      return { status: 400, body: { error: 'Invalid conversation id' } };
    }
    const entry = this.refreshSingleEntry(convId);
    if (!entry) {
      return { status: 404, body: { error: 'Conversation not found' } };
    }

    void this.resolveConversationModelAsync(convId, false);
    const promptForAgentHandoff = buildAgentHandoffRequest(entry, focusTopic);
    return {
      status: 200,
      body: {
        id: entry.id,
        compactCount: entry.compactCount,
        modelEnum: entry.modelEnum || '',
        modelLabel: entry.modelLabel || this.lookupModelLabel(entry.modelEnum),
        latestHandoffMs: entry.latestHandoffMs || 0,
        latestHandoffPrompt: entry.latestHandoffPrompt || '',
        promptForAgentHandoff
      }
    };
  }

  validateToken(req, urlObj) {
    if (urlObj.pathname === '/preload.js') return true;
    if (!this.token) return true;
    const headerTok = req.headers['x-sidecar-token'];
    const queryTok = urlObj.searchParams.get('token');
    return headerTok === this.token || queryTok === this.token;
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > 10 * 1024 * 1024) {
          reject(new Error('Payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  async handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://${BIND_HOST}:${this.port || DEFAULT_PORT}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/ui.html')) {
      try {
        const rawHtml = fs.readFileSync(this.uiHtmlPath, 'utf-8');
        const reqToken =
          urlObj.searchParams.get('token')?.trim() ||
          (typeof req.headers['x-sidecar-token'] === 'string' ? req.headers['x-sidecar-token'].trim() : '') ||
          this.token;
        const reqConvId =
          urlObj.searchParams.get('conversationId')?.trim() ||
          process.env.ANTIGRAVITY_CONVERSATION_ID ||
          '';
        const body = rewriteUiHtmlLinks(rawHtml, reqToken, reqConvId);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to load ui.html: ${err.message}`);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(this.loadPreloadJs());
      return;
    }

    if (req.method !== 'GET' && !this.validateToken(req, urlObj)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const query = Object.fromEntries(urlObj.searchParams.entries());

    if (req.method === 'GET' && pathname === '/api/status') {
      const payload = this.handleStatusRequest(query);
      sendJson(res, 200, payload);
      if (this.bootScriptMtimeMs > 0) {
        try {
          const curMtime = fs.statSync(__filename, { throwIfNoEntry: false })?.mtimeMs || 0;
          if (curMtime > 0 && curMtime !== this.bootScriptMtimeMs) {
            this.bootScriptMtimeMs = 0;
            setImmediate(() => {
              this.stop().finally(() => process.exit(0));
            });
          }
        } catch {}
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      const report = await this.runDiagnostics({
        refresh: query.refresh === '1',
        simulate: query.simulate || ''
      });
      sendJson(res, 200, report);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversation-details') {
      const { status, body } = this.handleConversationDetails(query);
      sendJson(res, status, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/handoff-summary') {
      const { status, body } = this.handleHandoffSummary(query);
      sendJson(res, status, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      const catalog = await this.getModelsCatalog(query.refresh === '1');
      const qConvId = typeof query.convId === 'string' ? query.convId.trim().toLowerCase() : '';
      let convModelEnum = '';
      let convModelLabel = '';
      if (UUID_RE.test(qConvId)) {
        const resolvedEnum = await this.resolveConversationModelAsync(qConvId, false);
        const entry = this.convCache.get(qConvId);
        convModelEnum = resolvedEnum || (entry && entry.modelEnum) || '';
        convModelLabel = (entry && entry.modelLabel) || this.lookupModelLabel(convModelEnum);
      }
      sendJson(res, 200, {
        models: catalog.models || [],
        defaultModelEnum: catalog.defaultModelEnum || '',
        convId: qConvId || '',
        convModelEnum,
        convModelLabel
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/project-archive') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = this.setProjectArchived(body.projectId, body.archived);
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-seen') {
      const body = await this.readJsonBody(req);
      const convId = typeof body.conversationId === 'string' ? body.conversationId.trim().toLowerCase() : '';
      if (!UUID_RE.test(convId)) {
        sendJson(res, 400, { error: 'Invalid conversationId' });
        return;
      }
      const changed = this.markConversationSeen(convId, true);
      sendJson(res, 200, { ok: true, conversationId: convId, changed });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-archive') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = await this.setConversationArchived(
        body.conversationId,
        body.archived
      );
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/conversation-delete') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = await this.deleteConversation(body.conversationId);
      sendJson(res, status, outBody);
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/send-message') {
      const body = await this.readJsonBody(req);
      const convId = (body.conversationId || '').trim();
      const message = typeof body.message === 'string' ? body.message : '';
      if (!UUID_RE.test(convId) || !message) {
        sendJson(res, 400, { error: 'Invalid conversationId or empty message' });
        return;
      }
      this.refreshProjectsRegistry(false);
      const entry = this.convCache.get(convId.toLowerCase()) || this.refreshSingleEntry(convId.toLowerCase());
      const wsPath = (typeof body.workspacePath === 'string' && body.workspacePath.trim()) || (entry && entry.workspacePath) || '';
      const matchedProj = wsPath ? this.matchProjectForWorkspace(wsPath) : null;
      const effectiveProjectId =
        (typeof body.projectId === 'string' && body.projectId.trim()) ||
        (matchedProj ? matchedProj.id : '');
      const nativeWsPath = wsPath && process.platform === 'win32' ? wsPath.replace(/\//g, '\\') : wsPath;
      const out = await execAgentApi(['send-message', convId, message], effectiveProjectId, this.appDataDir, nativeWsPath);
      if (out && out.error) {
        sendJson(res, 502, out);
        return;
      }
      sendJson(res, 200, out);
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/new-conversation') {
      const body = await this.readJsonBody(req);
      const message = typeof body.message === 'string' ? body.message : '';
      if (!message) {
        sendJson(res, 400, { error: 'Empty message' });
        return;
      }
      this.refreshProjectsRegistry(false);
      const catalog = await this.getModelsCatalog(false);
      const isGeneral = Boolean(body.general);
      const srcConvId = typeof body.conversationId === 'string' ? body.conversationId.trim().toLowerCase() : '';
      const srcEntry = UUID_RE.test(srcConvId)
        ? (this.convCache.get(srcConvId) || this.refreshSingleEntry(srcConvId))
        : null;
      const rawWsPath = isGeneral
        ? ''
        : ((typeof body.workspacePath === 'string' && body.workspacePath.trim()) ||
           (srcEntry && srcEntry.workspacePath) ||
           '');
      const normWsPath = rawWsPath ? resolveCanonicalWorkspace(rawWsPath) : '';
      const matchedProj = normWsPath ? this.matchProjectForWorkspace(normWsPath) : null;
      const effectiveProjectId = isGeneral
        ? ''
        : ((typeof body.projectId === 'string' && body.projectId.trim()) ||
           (matchedProj ? matchedProj.id : ''));
      const effectiveWsPath = isGeneral
        ? ''
        : (normWsPath || (matchedProj && matchedProj.primaryPath) || '');
      const nativeWsPath =
        effectiveWsPath && process.platform === 'win32'
          ? effectiveWsPath.replace(/\//g, '\\')
          : effectiveWsPath;

      const requestedModelRaw =
        (typeof body.model === 'string' && body.model.trim()) ||
        (typeof body.modelId === 'string' && body.modelId.trim()) ||
        '';
      let matchedModel = requestedModelRaw ? this.lookupModelByAny(requestedModelRaw) : null;
      let selectedModelEnum = matchedModel ? matchedModel.modelEnum : '';
      if (!selectedModelEnum && requestedModelRaw.startsWith('MODEL_')) {
        selectedModelEnum = requestedModelRaw;
      }
      if (!selectedModelEnum && srcEntry && srcEntry.modelEnum) {
        selectedModelEnum = srcEntry.modelEnum;
      }
      if (!selectedModelEnum && UUID_RE.test(srcConvId)) {
        selectedModelEnum = await this.resolveConversationModelAsync(srcConvId, false);
      }
      if (!selectedModelEnum && catalog) {
        selectedModelEnum =
          catalog.defaultModelEnum ||
          (Array.isArray(catalog.models) && catalog.models[0] ? catalog.models[0].modelEnum : '') ||
          '';
      }
      if (!matchedModel && selectedModelEnum) {
        matchedModel = this.lookupModelByAny(selectedModelEnum);
      }
      const selectedModelId = (matchedModel && matchedModel.modelId) || requestedModelRaw || '';
      const selectedModelLabel =
        (matchedModel && matchedModel.label) || this.lookupModelLabel(selectedModelEnum);

      const seedNewConversation = (rawNewId) => {
        const cleanNewId = (typeof rawNewId === 'string' ? rawNewId : '').trim().toLowerCase();
        if (!cleanNewId || !UUID_RE.test(cleanNewId)) return;
        this.deletedConvIds.delete(cleanNewId);
        const nowMs = Date.now();
        if (isGeneral) {
          this.metadataWorkspaceCache.set(cleanNewId, '__general__');
          this.saveMetadataCache();
        } else if (effectiveWsPath) {
          this.metadataWorkspaceCache.set(cleanNewId, effectiveWsPath);
          this.saveMetadataCache();
        }
        const preEntry = this.convCache.get(cleanNewId) || createEmptyEntry(cleanNewId);
        if (effectiveWsPath && !preEntry.workspacePath) {
          preEntry.workspacePath = effectiveWsPath;
        }
        if (selectedModelEnum) {
          preEntry.modelEnum = selectedModelEnum;
          preEntry.modelLabel = selectedModelLabel;
          preEntry.modelResolvedMtimeMs = nowMs;
        }
        preEntry.lastActiveIso = new Date(nowMs).toISOString();
        preEntry.lastActiveMs = Math.max(preEntry.lastActiveMs || 0, nowMs);
        preEntry.lastUserInputMs = Math.max(preEntry.lastUserInputMs || 0, nowMs);
        preEntry.lastViewMs = Math.max(preEntry.lastViewMs || 0, nowMs);
        preEntry.lastSeenMs = Math.max(preEntry.lastSeenMs || 0, nowMs);
        if (!preEntry.firstPrompt) {
          preEntry.firstPrompt = message.slice(0, 500);
          preEntry.lastPrompt = preEntry.firstPrompt;
          preEntry.promptCount = Math.max(preEntry.promptCount || 0, 1);
          rebuildSearchCorpus(preEntry);
        }
        this.convCache.set(cleanNewId, preEntry);
        this.transcriptRev += 1;
        this.cachedIndexSummary = null;
        this.cachedCardsState = null;
        this.scheduleSaveIndexCache();
      };

      const baseStartPayload = {
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        ...(selectedModelEnum ? { requestedModel: { model: selectedModelEnum } } : {})
      };
      const startPayload = { ...baseStartPayload };
      if (effectiveProjectId) {
        startPayload.projectEnvConfig = {
          projectId: effectiveProjectId,
          defaultProjectEnvironment: {}
        };
      } else if (nativeWsPath) {
        try {
          startPayload.workspaceUris = [pathToFileURL(nativeWsPath).href];
        } catch {}
      }

      let startRpc = await callLanguageServerRpc('StartCascade', startPayload, 8000);
      if (startRpc.error && effectiveProjectId && nativeWsPath) {
        const retryPayload = { ...baseStartPayload };
        try {
          retryPayload.workspaceUris = [pathToFileURL(nativeWsPath).href];
        } catch {}
        startRpc = await callLanguageServerRpc('StartCascade', retryPayload, 8000);
      }

      const rawCascadeId =
        (startRpc && typeof startRpc.cascadeId === 'string' && startRpc.cascadeId) ||
        (startRpc && startRpc.data && typeof startRpc.data.cascadeId === 'string' && startRpc.data.cascadeId) ||
        '';
      const cascadeId = rawCascadeId.trim().toLowerCase();
      if (cascadeId && UUID_RE.test(cascadeId)) {
        const sendPayload = {
          cascadeId,
          items: [{ text: message }],
          metadata: {},
          clientType: 'CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE'
        };
        if (selectedModelEnum) {
          sendPayload.cascadeConfig = {
            plannerConfig: {
              planModel: selectedModelEnum,
              requestedModel: { model: selectedModelEnum }
            }
          };
        }
        const sendRpc = await callLanguageServerRpc('SendUserCascadeMessage', sendPayload, 12000);
        if (sendRpc.error) {
          sendJson(res, 502, { error: sendRpc.error, cascadeId });
          return;
        }
        seedNewConversation(cascadeId);
        this.lastFullScanMs = 0;
        this.lastBrainDirMtimeMs = 0;
        sendJson(res, 200, {
          response: {
            conversationId: cascadeId,
            cascadeId,
            modelEnum: selectedModelEnum,
            modelLabel: selectedModelLabel
          }
        });
        return;
      }

      const args = ['new-conversation'];
      if (selectedModelId) {
        args.push('--model', selectedModelId);
      }
      args.push(message);
      const out = await execAgentApi(args, effectiveProjectId, this.appDataDir, nativeWsPath, 12000, isGeneral);
      if (out && out.error) {
        sendJson(res, 502, out);
        return;
      }
      const cliResp = (out && typeof out.response === 'object' && out.response) ? out.response : out;
      const cliConvId = (cliResp && (cliResp.conversationId || cliResp.cascadeId)) || '';
      seedNewConversation(cliConvId);
      this.lastFullScanMs = 0;
      this.lastBrainDirMtimeMs = 0;
      sendJson(res, 200, out);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  }

  start() {
    if (this.server) return Promise.resolve(this.server);
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        });
      });

      srv.on('error', reject);
      srv.listen(this.port, BIND_HOST, () => {
        this.server = srv;
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        try {
          writeJsonAtomic(
            this.serverInfoPath,
            {
              host: BIND_HOST,
              port: this.port,
              token: this.token || null,
              pid: process.pid
            },
            0o600
          );
        } catch {}
        const diagTimer = setTimeout(() => {
          void this.runDiagnostics({ refresh: false });
        }, 600);
        if (typeof diagTimer.unref === 'function') {
          diagTimer.unref();
        }
        resolve(srv);
      });
    });
  }

  async stop() {
    if (this.saveCacheTimer || this.indexCacheDirty) {
      this.saveIndexCache();
    }
    try {
      fs.rmSync(this.serverInfoPath, { force: true });
    } catch {}
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

if (require.main === module) {
  const instance = new ContextHealthServer();
  instance.start().catch((err) => {
    console.error('[context-health] Fatal startup error:', err);
    process.exit(1);
  });

  const shutdown = () => {
    instance.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  ContextHealthServer,
  LSRPC_CONTRACT_SPECS,
  resolveLanguageServerBinary,
  scanBinarySymbols,
  updateTranscriptEntry,
  classifyToolCallsWait,
  getEntryWaitState,
  isEntryThinking,
  classifyPollution,
  computeMedian,
  normalizeWorkspacePath,
  resolveCanonicalWorkspace,
  parseGitReflogTail
};
