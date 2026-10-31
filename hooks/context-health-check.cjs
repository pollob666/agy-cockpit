'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const CHECKPOINT_TOKEN = Buffer.from('"type":"CHECKPOINT"', 'utf-8');
const USER_INPUT_TOKEN = Buffer.from('"type":"USER_INPUT"', 'utf-8');
const PLANNER_TOKEN = Buffer.from('"type":"PLANNER_RESPONSE"', 'utf-8');
const HANDOFF_MARKER = Buffer.from('[Context Health Smart Handoff]', 'utf-8');
const CREATED_AT_SINGLE_RE = /"created_at"\s*:\s*"([^"]+)"/;
const GIT_COMMIT_OUT_RE = /\[[\w./-]+(?:\s+\([^)]+\))?\s+([0-9a-f]{7,12})\]/g;
const REFLOG_ACTION_RE = /^(?:commit(?:\s*\([^)]+\))?:|merge\b|pull\b|cherry-pick\b|rebase(?:\s*\((?!start\b|finish\b|abort\b)[^)]+\))?:)/i;
const APP_CANDIDATES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];

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

function resolveFallbackTranscriptPath(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return '';
  const id = conversationId.trim();
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) {
    const envCandidate = path.join(envDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      if (fs.statSync(envCandidate, { throwIfNoEntry: false })?.isFile()) {
        return envCandidate;
      }
    } catch {}
  }
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const app of APP_CANDIDATES) {
    const candidate = path.join(
      geminiRoot,
      app,
      'brain',
      id,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    try {
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

function extractTimestampAround(data, tokenIdx) {
  const lineStart = data.lastIndexOf(0x0a, tokenIdx) + 1;
  const nextNl = data.indexOf(0x0a, tokenIdx);
  const lineEnd = nextNl === -1 ? data.length : nextNl;
  const headerSlice = data.subarray(lineStart, Math.min(lineEnd, lineStart + 1024)).toString('utf-8');
  const m = CREATED_AT_SINGLE_RE.exec(headerSlice);
  if (!m) return 0;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? ms : 0;
}

function scanTranscriptFast(transcriptPath, preStat) {
  let fd;
  try {
    const stat = preStat || fs.statSync(transcriptPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size === 0) {
      return { compactCount: 0, promptCount: 0, lastActiveMs: 0, mentionedCommits: new Set() };
    }

    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.allocUnsafe(stat.size);
    const bytesRead = fs.readSync(fd, buf, 0, stat.size, 0);
    const data = buf.subarray(0, bytesRead);

    let compactCount = 0;
    let searchIdx = 0;
    while (true) {
      const found = data.indexOf(CHECKPOINT_TOKEN, searchIdx);
      if (found === -1) break;
      compactCount += 1;
      searchIdx = found + CHECKPOINT_TOKEN.length;
    }

    let promptCount = 0;
    searchIdx = 0;
    while (true) {
      const found = data.indexOf(USER_INPUT_TOKEN, searchIdx);
      if (found === -1) break;
      const lineStart = data.lastIndexOf(0x0a, found) + 1;
      const nextNl = data.indexOf(0x0a, found);
      const lineEnd = nextNl === -1 ? bytesRead : nextNl;
      const lineSlice = data.subarray(lineStart, lineEnd);
      if (lineSlice.indexOf(HANDOFF_MARKER) === -1) {
        promptCount += 1;
      }
      searchIdx = lineEnd + 1;
    }

    let lastActiveMs = 0;
    let searchEnd = bytesRead;
    while (searchEnd > 0) {
      const plannerIdx = data.lastIndexOf(PLANNER_TOKEN, searchEnd - 1);
      if (plannerIdx === -1) break;
      const ms = extractTimestampAround(data, plannerIdx);
      if (ms > 0) {
        lastActiveMs = ms;
        break;
      }
      searchEnd = data.lastIndexOf(0x0a, plannerIdx);
    }

    const scanWindow = Math.min(bytesRead, 2 * 1024 * 1024);
    const scanText = data.subarray(bytesRead - scanWindow).toString('utf-8');
    const mentionedCommits = new Set();
    let match;
    GIT_COMMIT_OUT_RE.lastIndex = 0;
    while ((match = GIT_COMMIT_OUT_RE.exec(scanText)) !== null) {
      mentionedCommits.add(match[1].slice(0, 7).toLowerCase());
    }

    return { compactCount, promptCount, lastActiveMs, mentionedCommits };
  } catch {
    return { compactCount: 0, promptCount: 0, lastActiveMs: 0, mentionedCommits: new Set() };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function findGitRoot(startDir) {
  let curr = normalizeWorkspacePath(startDir);
  if (!curr) return '';
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(curr, '.git'))) {
        return curr;
      }
    } catch {}
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return '';
}

function countCommitsBehindFast(workspaceDir, lastActiveMs, mentionedCommits) {
  if (!workspaceDir || !lastActiveMs) return 0;
  const gitRoot = findGitRoot(workspaceDir);
  if (!gitRoot) return 0;

  const reflogPath = path.join(gitRoot, '.git', 'logs', 'HEAD');
  let fd;
  try {
    const stat = fs.statSync(reflogPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size === 0) return 0;

    const readSize = Math.min(stat.size, 32 * 1024);
    const startPos = Math.max(0, stat.size - readSize);
    fd = fs.openSync(reflogPath, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, startPos);
    const lines = buf.subarray(0, bytesRead).toString('utf-8').trim().split('\n');

    const graceCutoffMs = lastActiveMs + 45000;
    const seen = new Set();
    let behind = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
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

      const tsMs = parseInt(metaMatch[3], 10) * 1000;
      if (tsMs <= graceCutoffMs) break;

      if (mentionedCommits.has(hash.slice(0, 7))) continue;
      behind += 1;
    }
    return behind;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function tierLabel(compactCount, promptCount = 0) {
  const compactedPrompts = compactCount > 0 ? Math.max(0, promptCount - 10) : 0;
  if (compactCount <= 2 && compactedPrompts === 0) return 'Fresh';
  if (compactCount <= 5) return 'Warm';
  if (compactCount <= 9) return 'Heavy';
  return 'Polluted';
}

function evaluateHookPayload(payload = {}) {
  const convId = payload.conversationId || payload.conversation_id || '';
  const rawTranscriptPath = normalizeWorkspacePath(payload.transcriptPath || payload.transcript_path || '');
  let preStat = null;
  if (rawTranscriptPath) {
    try {
      const st = fs.statSync(rawTranscriptPath, { throwIfNoEntry: false });
      if (st && st.isFile()) preStat = st;
    } catch {}
  }
  const transcriptPath = preStat ? rawTranscriptPath : resolveFallbackTranscriptPath(convId);

  if (!transcriptPath) {
    return {};
  }

  const { compactCount, promptCount, lastActiveMs, mentionedCommits } = scanTranscriptFast(transcriptPath, preStat);
  const workspacePaths = Array.isArray(payload.workspacePaths)
    ? payload.workspacePaths
    : (Array.isArray(payload.workspaceUris) ? payload.workspaceUris : []);
  const primaryWorkspace = workspacePaths.length > 0
    ? normalizeWorkspacePath(workspacePaths[0])
    : normalizeWorkspacePath(payload.workspaceRoot || payload.workspace_root || '');
  const commitsBehind = countCommitsBehindFast(primaryWorkspace, lastActiveMs, mentionedCommits);

  if (compactCount < 10 && commitsBehind === 0) {
    return {};
  }

  const parts = [`${compactCount} compact${compactCount === 1 ? '' : 's'} (${tierLabel(compactCount, promptCount)})`];
  if (commitsBehind > 0) {
    parts.push(`${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind HEAD`);
  } else {
    parts.push('HEAD in sync');
  }

  const badgeLine = `⚠️ [Context Health: ${parts.join(' · ')}]`;
  const instruction =
    `${badgeLine} ` +
    `Include the exact one-line warning \`${badgeLine}\` at the very top of your response so the user sees the current context status.`;

  return {
    injectSteps: [
      {
        ephemeralMessage: instruction
      }
    ]
  };
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw) payload = JSON.parse(raw);
    } catch {}
    const out = evaluateHookPayload(payload);
    process.stdout.write(JSON.stringify(out) + '\n');
  });
}

module.exports = {
  evaluateHookPayload,
  scanTranscriptFast,
  countCommitsBehindFast,
  normalizeWorkspacePath,
  tierLabel
};
