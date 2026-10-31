'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const CHECKPOINT_TOKEN = Buffer.from('"type":"CHECKPOINT"', 'utf-8');
const CREATED_AT_RE = /"created_at"\s*:\s*"([^"]+)"/g;
const GIT_COMMIT_OUT_RE = /\[[\w./-]+ ([0-9a-f]{7,12})\]/g;
const APP_CANDIDATES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];

function normalizePath(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let p = rawInput.trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ''));
      if (process.platform !== 'win32' && !p.startsWith('/')) p = '/' + p;
    }
  }
  return p.replace(/^["']+|["']+$/g, '').trim();
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

function scanTranscriptFast(transcriptPath) {
  let fd;
  try {
    const stat = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size === 0) {
      return { compactCount: 0, lastActiveMs: 0, mentionedCommits: new Set() };
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

    const tailSize = Math.min(bytesRead, 64 * 1024);
    const tailText = data.subarray(bytesRead - tailSize).toString('utf-8');

    let lastActiveMs = 0;
    let match;
    CREATED_AT_RE.lastIndex = 0;
    while ((match = CREATED_AT_RE.exec(tailText)) !== null) {
      const ms = Date.parse(match[1]);
      if (Number.isFinite(ms) && ms > lastActiveMs) {
        lastActiveMs = ms;
      }
    }
    if (!lastActiveMs) {
      lastActiveMs = stat.mtimeMs;
    }

    const mentionedCommits = new Set();
    GIT_COMMIT_OUT_RE.lastIndex = 0;
    while ((match = GIT_COMMIT_OUT_RE.exec(tailText)) !== null) {
      mentionedCommits.add(match[1].slice(0, 7).toLowerCase());
    }

    return { compactCount, lastActiveMs, mentionedCommits };
  } catch {
    return { compactCount: 0, lastActiveMs: 0, mentionedCommits: new Set() };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function findGitRoot(startDir) {
  let curr = normalizePath(startDir);
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
      if (!/^(?:commit(?:\s*\([^)]+\))?:|merge\b|pull\b|cherry-pick\b|rebase\b)/i.test(action)) {
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

function tierLabel(compactCount) {
  if (compactCount <= 2) return 'Fresh';
  if (compactCount <= 5) return 'Warm';
  if (compactCount <= 9) return 'Heavy';
  return 'Polluted';
}

function evaluateHookPayload(payload = {}) {
  const convId = payload.conversationId || '';
  const rawTranscriptPath = normalizePath(payload.transcriptPath || '');
  const transcriptPath =
    (rawTranscriptPath && fs.existsSync(rawTranscriptPath) ? rawTranscriptPath : '') ||
    resolveFallbackTranscriptPath(convId);

  if (!transcriptPath) {
    return {};
  }

  const { compactCount, lastActiveMs, mentionedCommits } = scanTranscriptFast(transcriptPath);
  const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const primaryWorkspace = workspacePaths.length > 0 ? normalizePath(workspacePaths[0]) : '';
  const commitsBehind = countCommitsBehindFast(primaryWorkspace, lastActiveMs, mentionedCommits);

  if (compactCount < 10 && commitsBehind === 0) {
    return {};
  }

  const parts = [`${compactCount} compacts (${tierLabel(compactCount)})`];
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
  tierLabel
};
