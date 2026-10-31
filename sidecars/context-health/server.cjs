'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { fileURLToPath } = require('node:url');

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
      async startConversation(message) {
        const res = await secureFetch('/_sidecar/new-conversation', {
          method: 'POST',
          body: JSON.stringify({ message })
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
    lastViewMs: 0,
    archived: false,
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
    latestHandoffPrompt: '',
    latestHandoffMs: 0,
    handoffPendingMs: 0,
    handoffTargetStepIndex: -1,
    awaitingHandoffResponse: false,
    needsFullHandoffRead: false,
    checkpointTargetStepIndex: -1,
    needsFullCheckpointRead: false,
    checkpointOverview: '',
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
  const hasSubagentCreation = hasGeneric && line.includes('Created the following subagent');

  if (hasGeneric && !hasSubagentCreation) {
    if (line.includes('[')) {
      extractMentionedCommits(entry, line);
    }
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
    if (createdAt && createdMs >= entry.lastActiveMs) {
      entry.lastActiveIso = createdAt;
      entry.lastActiveMs = createdMs;
    }
    const clean = cleanUserPrompt(content);
    if (clean) {
      if (clean.startsWith('[Context Health Smart Handoff]')) {
        entry.awaitingHandoffResponse = true;
        return false;
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
    if (content && content.trim()) {
      const trimmedContent = content.trim();
      const isTruncatedContent =
        Array.isArray(obj.truncated_fields) && obj.truncated_fields.includes('content');
      const handoffMatch = /<HANDOFF_PROMPT>\s*([\s\S]*?)\s*<\/HANDOFF_PROMPT>/i.exec(trimmedContent);
      if (handoffMatch && handoffMatch[1].trim() && !isTruncatedContent) {
        entry.latestHandoffPrompt = handoffMatch[1].trim();
        entry.latestHandoffMs = createdMs || Date.now();
        entry.awaitingHandoffResponse = false;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
      } else if (
        isTruncatedContent &&
        (/<HANDOFF_PROMPT>/i.test(trimmedContent) ||
          (entry.awaitingHandoffResponse && (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)))
      ) {
        entry.needsFullHandoffRead = true;
        entry.handoffTargetStepIndex = typeof obj.step_index === 'number' ? obj.step_index : -1;
        entry.handoffPendingMs = createdMs || Date.now();
        entry.awaitingHandoffResponse = false;
      } else if (
        entry.awaitingHandoffResponse &&
        (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)
      ) {
        entry.latestHandoffPrompt = trimmedContent;
        entry.latestHandoffMs = createdMs || Date.now();
        entry.awaitingHandoffResponse = false;
        entry.needsFullHandoffRead = false;
        entry.handoffTargetStepIndex = -1;
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
  if (!raw || typeof raw !== 'string') return { title: '', lastViewMs: 0, archived: false };
  const title = extractTitleFromPbtxt(raw);
  const viewMatch = /\blast_user_view_time\s*:\s*\{\s*seconds\s*:\s*(\d+)(?:\s+nanos\s*:\s*(\d+))?\s*\}/.exec(raw);
  let lastViewMs = 0;
  if (viewMatch) {
    const sec = parseInt(viewMatch[1], 10) || 0;
    const nanos = viewMatch[2] ? (parseInt(viewMatch[2], 10) || 0) : 0;
    if (sec > 0) {
      lastViewMs = sec * 1000 + Math.floor(nanos / 1e6);
    }
  }
  const archived = /\barchived\s*:\s*true\b/i.test(raw);
  return { title, lastViewMs, archived };
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
    entry.latestHandoffMs = entry.handoffPendingMs || Date.now();
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

function resolveAgentApiCommand(appDataDir) {
  const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (envExe && isFile(envExe)) {
    const isDirect = path.basename(envExe).toLowerCase().startsWith('agentapi');
    return { file: envExe, prefix: isDirect ? [] : ['agentapi'], shell: false };
  }

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const langServer = path.join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (isFile(langServer)) {
      return { file: langServer, prefix: ['agentapi'], shell: false };
    }
    const geminiRoot = path.join(os.homedir(), '.gemini');
    const candidateDirs = [
      appDataDir,
      ...APP_CANDIDATES.map((app) => path.join(geminiRoot, app))
    ].filter(Boolean);
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

  const nixBin = path.join(appDataDir || resolveAppDataDir(), 'bin', 'agentapi');
  if (isFile(nixBin)) {
    return { file: nixBin, prefix: [], shell: false };
  }
  return { file: 'agentapi', prefix: [], shell: false };
}

function execAgentApi(args, projectId, appDataDir, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
    const { file, prefix, shell } = resolveAgentApiCommand(appDataDir);
    execFile(
      file,
      [...prefix, ...args],
      { encoding: 'utf-8', env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell },
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
    ? `Ο χρήστης έδωσε την εξής οδηγία / εστίαση για το νέο conversation:\n"${focusTopic}"\nΠροσάρμοσε το handoff prompt ώστε να εστιάζει ΑΠΟΚΛΕΙΣΤΙΚΑ σε αυτό που ζήτησε ο χρήστης, συμπεριλαμβάνοντας όλο το σχετικό τεχνικό context, τις επιλογές και την τελευταία μας συζήτηση.`
    : `Συνόψισε την τρέχουσα εργασία, τι ολοκληρώθηκε, την τελευταία μας τεχνική ανάλυση/συζήτηση και το αμέσως επόμενο βήμα.`;

  return (
    `[Context Health Smart Handoff]\n` +
    `Φτιάξε τώρα ένα αυτοτελές (self-contained) handoff prompt για να συνεχίσουμε σε νέο conversation.\n\n` +
    `${focusDirective}\n\n` +
    `ΑΥΣΤΗΡΟΙ ΚΑΝΟΝΕΣ:\n` +
    `1. ΜΗΝ καλέσεις ΚΑΝΕΝΑ απολύτως tool (όχι read_file, όχι run_command, όχι search). Έχεις ήδη όλο το context στη μνήμη σου. Απάντησε ΑΜΕΣΩΣ.\n` +
    `2. Τύλιξε το τελικό handoff prompt ΑΚΡΙΒΩΣ μέσα σε tags <HANDOFF_PROMPT> και </HANDOFF_PROMPT>. Μόλις ολοκληρώσεις την απάντησή σου, το Context Health sidecar θα διαβάσει αυτόματα το περιεχόμενο μέσα στα tags και θα το φορτώσει στο πεδίο του plugin για review.\n` +
    `3. Μέσα στο <HANDOFF_PROMPT>...</HANDOFF_PROMPT> συμπεριέλαβε:\n` +
    `   - Στην πρώτη γραμμή την οδηγία: "Όλο το απαραίτητο context βρίσκεται παρακάτω. ΜΗΝ ψάξεις σε αρχεία transcript.jsonl προηγούμενων conversations."\n` +
    `   - Το Workspace (${entry.workspacePath || 'current workspace'}) και τα βασικά αρχεία που αφορά.\n` +
    `   - Συμπυκνωμένα τι έχει γίνει μέχρι τώρα και όλη την τελευταία μας τεχνική ανάλυση, τις επιλογές ή τα ανοιχτά ερωτήματα.\n` +
    `   - ΜΗΝ βάλεις το παλιό conversationId UUID.`
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

    this.indexCachePath = path.join(this.dataDir, 'index_cache.json');
    this.metadataCachePath = path.join(this.dataDir, 'metadata_cache.json');
    this.serverInfoPath = path.join(this.dataDir, 'server_info.json');

    try {
      this.bootScriptMtimeMs = fs.statSync(__filename).mtimeMs;
    } catch {
      this.bootScriptMtimeMs = 0;
    }

    this.loadPersistentCaches();
  }

  loadPersistentCaches() {
    if (isFile(this.metadataCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metadataCachePath, 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'string' && v) {
              this.metadataWorkspaceCache.set(k, resolveCanonicalWorkspace(v));
            }
          }
        }
      } catch {}
    }

    if (isFile(this.indexCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexCachePath, 'utf-8'));
        if (raw && raw.version === 11 && Array.isArray(raw.entries)) {
          for (const item of raw.entries) {
            if (item && typeof item.id === 'string') {
              rebuildSearchCorpus(item);
              this.convCache.set(item.id, item);
            }
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
      writeJsonAtomic(this.indexCachePath, { version: 11, savedAt: Date.now(), entries });
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
    if (!forceStat && cached && now - cached.checkedAtMs < 5000) {
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
      const emptyItem = { mtimeMs: 0, title: '', lastViewMs: 0, archived: false, checkedAtMs: now };
      this.annotationTitleCache.set(convId, emptyItem);
      return emptyItem;
    }
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      typeof cached.lastViewMs === 'number' &&
      typeof cached.archived === 'boolean'
    ) {
      cached.checkedAtMs = now;
      return cached;
    }
    try {
      const raw = fs.readFileSync(pbtxtPath, 'utf-8');
      const { title, lastViewMs, archived } = extractAnnotationFromPbtxt(raw);
      const item = { mtimeMs: stat.mtimeMs, title, lastViewMs, archived, checkedAtMs: now };
      this.annotationTitleCache.set(convId, item);
      return item;
    } catch {
      return cached || { mtimeMs: 0, title: '', lastViewMs: 0, archived: false, checkedAtMs: now };
    }
  }

  applyEntryMetadata(entry, convId, activeConvId = '', activeWorkspaceNorm = '', forceAnnot = false) {
    let changed = false;
    const annot = this.resolveConversationAnnotation(convId, forceAnnot);
    if (annot.title && entry.title !== annot.title) {
      entry.title = annot.title;
      rebuildSearchCorpus(entry);
      changed = true;
    }
    if (annot.lastViewMs && entry.lastViewMs !== annot.lastViewMs) {
      entry.lastViewMs = annot.lastViewMs;
      changed = true;
    }
    const nextArchived = Boolean(annot.archived);
    if (Boolean(entry.archived) !== nextArchived) {
      entry.archived = nextArchived;
      changed = true;
    }
    if (!entry.workspacePath && this.metadataWorkspaceCache.has(convId)) {
      entry.workspacePath = this.metadataWorkspaceCache.get(convId);
      changed = true;
    }
    if (
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

        const seenIds = new Set();
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const convId = d.name.toLowerCase();
          if (!UUID_RE.test(convId)) continue;
          seenIds.add(convId);
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, force || convId === activeConvId)) {
            anyTranscriptChanged = true;
          }
        }

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
          if (this.refreshEntryById(convId, activeConvId, activeWorkspaceNorm, convId === activeConvId)) {
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
      lastViewMs: entry.lastViewMs || 0,
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

    const detectedActiveWorkspaceNorm = workspaceUris.length > 0
      ? resolveCanonicalWorkspace(workspaceUris[0])
      : (sortedEntries.find((e) => e.id === hostConvId)?.workspacePath || '');

    const matchedActiveProj = this.matchProjectForWorkspace(detectedActiveWorkspaceNorm);
    const activeWorkspaceKey = matchedActiveProj
      ? (matchedActiveProj.archived ? '' : (matchedActiveProj.primaryKey || matchedActiveProj.id))
      : (hasProjectsRegistry && detectedActiveWorkspaceNorm ? '' : workspaceComparisonKey(detectedActiveWorkspaceNorm));

    const archivedConvCounts = new Map();
    const visibleEntries = sortedEntries.filter((e) => {
      if (e.isSubagent && e.id !== hostConvId) return false;
      if (e.archived && e.id !== hostConvId) return false;
      if (hasProjectsRegistry && e.workspacePath) {
        const proj = this.matchProjectForWorkspace(e.workspacePath);
        if (!proj) return false;
        if (proj.archived) {
          if (!e.isSubagent) {
            archivedConvCounts.set(proj.id, (archivedConvCounts.get(proj.id) || 0) + 1);
          }
          return false;
        }
      }
      return true;
    });

    this.gitCache.checkKnownRepos(isForce);

    let cards;
    let workspaces;
    let archivedProjects;
    if (
      !isForce &&
      this.cachedCardsState &&
      this.cachedCardsState.transcriptRev === this.transcriptRev &&
      this.cachedCardsState.projectsRev === this.projectsRev &&
      this.cachedCardsState.gitRev === this.gitCache.revision &&
      this.cachedCardsState.hostConvId === hostConvId &&
      this.cachedCardsState.activeWorkspaceKey === activeWorkspaceKey
    ) {
      cards = this.cachedCardsState.cards;
      workspaces = this.cachedCardsState.workspaces;
      archivedProjects = this.cachedCardsState.archivedProjects;
    } else {
      cards = visibleEntries.map((entry) =>
        this.buildConversationCard(entry, globalObservedCeiling, subagentTokens)
      );

      if (UUID_RE.test(hostConvId) && !cards.some((c) => c.id === hostConvId)) {
        const candidateWs =
          detectedActiveWorkspaceNorm || this.metadataWorkspaceCache.get(hostConvId) || '';
        const candidateProj = this.matchProjectForWorkspace(candidateWs);
        const isArchivedOrOrphan =
          hasProjectsRegistry && candidateWs && (!candidateProj || candidateProj.archived);
        if (!isArchivedOrOrphan) {
          const placeholderEntry = createEmptyEntry(hostConvId);
          placeholderEntry.workspacePath = candidateWs;
          cards.unshift(this.buildConversationCard(placeholderEntry, globalObservedCeiling, subagentTokens));
        }
      }

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
        hostConvId,
        activeWorkspaceKey,
        globalObservedCeiling,
        archivedIds: archivedProjects.map((p) => [p.id, p.count]),
        items: cards.map((c) => [
          c.id,
          c.title,
          c.lastActiveMs,
          c.lastViewMs,
          c.latestHandoffMs,
          c.compactCount,
          c.pollution.id,
          c.promptCount,
          c.currentTokens,
          c.totalTokens,
          c.subagentTokens,
          c.workspaceKey,
          c.projectId,
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
        hostConvId,
        activeWorkspaceKey,
        cards,
        workspaces,
        archivedProjects
      };
    }

    const now = Date.now();
    if (isForce || now - this.lastUiStatCheckMs >= 2000) {
      this.lastUiStatCheckMs = now;
      try {
        this.cachedUiMtimeMs = Math.floor(fs.statSync(this.uiHtmlPath, { throwIfNoEntry: false })?.mtimeMs || 0);
      } catch {}
    }
    const uiMtimeMs = this.cachedUiMtimeMs;

    const clientVersion = parseInt(query.sinceVersion || '0', 10);
    if (clientVersion > 0 && clientVersion === this.stateVersion && !isForce) {
      return {
        unchanged: true,
        version: this.stateVersion,
        uiMtimeMs,
        refreshMs: Number(this.lastRefreshDurationMs.toFixed(2))
      };
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
      workspaces,
      archivedProjects,
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

    const promptForAgentHandoff = buildAgentHandoffRequest(entry, focusTopic);
    return {
      status: 200,
      body: {
        id: entry.id,
        compactCount: entry.compactCount,
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

    if (req.method === 'POST' && pathname === '/api/project-archive') {
      const body = await this.readJsonBody(req);
      const { status, body: outBody } = this.setProjectArchived(body.projectId, body.archived);
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
      const out = await execAgentApi(['send-message', convId, message], body.projectId, this.appDataDir);
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
      const args = ['new-conversation'];
      if (body.model && typeof body.model === 'string') {
        args.push('--model', body.model);
      }
      args.push(message);
      const out = await execAgentApi(args, body.projectId, this.appDataDir);
      if (out && out.error) {
        sendJson(res, 502, out);
        return;
      }
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
  updateTranscriptEntry,
  classifyPollution,
  computeMedian,
  normalizeWorkspacePath,
  resolveCanonicalWorkspace,
  parseGitReflogTail
};
