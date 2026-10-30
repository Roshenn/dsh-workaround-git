/**
 * Batch git primitives.
 *
 * Every function here takes absolute repo paths and never throws on per-repo
 * failure: one broken repo must not abort the whole batch. Callers get a
 * structured result per repo so the tool layer can report partial success.
 */
import { execFile, spawn } from 'node:child_process';
import { readdir, stat, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, resolve, relative, dirname, extname, delimiter } from 'node:path';

const GIT_TIMEOUT_MS = 120_000;

/** Directories that never contain a workspace project worth syncing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.svn-cache',
  'dist', 'build', 'out', 'output', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  '.pnpm-store', '.yarn', '.gradle', '.idea', '.vscode', 'coverage',
  '.backups', '.plugin-backups', 'logs',
]);

/** Run git with an explicit repo directory; resolves instead of rejecting. */
export function git(repoPath, args, { timeout = GIT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      {
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout ?? '').trimEnd(),
          stderr: String(stderr ?? '').trimEnd(),
          message: error?.message ?? '',
        });
      },
    );
  });
}

/** Bounded-concurrency map, order-preserving. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** True when the path looks like a git repo (directory with .git, or a worktree .git file). */
export async function isRepo(dir) {
  const dotGit = join(dir, '.git');
  try {
    const info = await stat(dotGit);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/**
 * Walk `root` and collect every git repo found, depth first, bounded.
 * The root itself is included when it is a repo.
 * `maxRepos` is a hard stop so a wrong root (a home directory, an app install
 * dir) cannot turn one tool call into an unbounded scan.
 */
export async function discoverRepos(root, { maxDepth = 3, skipDirs = [], maxRepos = 200 } = {}) {
  const start = resolve(root);
  if (!existsSync(start)) return [];
  const skip = new Set([...SKIP_DIRS, ...skipDirs.map((d) => d.toLowerCase())]);
  const found = [];

  async function walk(dir, depth) {
    if (depth > maxDepth || found.length >= maxRepos) return;
    if (await isRepo(dir)) {
      found.push(dir);
      // Nested repos inside a repo are separate projects (e.g. worktrees), keep walking.
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxRepos) return;
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git') continue;
      if (skip.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.')) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(start, 0);
  return found.sort((a, b) => a.localeCompare(b));
}

/** Short label for a repo: its path relative to the batch root, slash-separated. */
export function repoLabel(repoPath, root) {
  const normalizedRoot = root ? root.replace(/[\\/]+$/, '') : '';
  const inside = normalizedRoot !== ''
    && (repoPath === normalizedRoot
      || repoPath.startsWith(`${normalizedRoot}\\`)
      || repoPath.startsWith(`${normalizedRoot}/`));
  const rel = inside ? repoPath.slice(normalizedRoot.length).replace(/^[\\/]/, '') : '';
  return (rel || basename(repoPath)).split(/[\\/]/).join('/');
}

/** Parse `git status --porcelain=v2 --branch`. */
export function parsePorcelainV2(text) {
  const out = {
    branch: null, upstream: null, ahead: null, behind: null,
    staged: 0, modified: 0, untracked: 0, conflicted: 0,
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) out.branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ')) {
      const xy = line.split(' ')[1] ?? '..';
      if (xy[0] !== '.') out.staged += 1;
      if (xy[1] !== '.') out.modified += 1;
    } else if (line.startsWith('2 ')) {
      const xy = line.split(' ')[1] ?? '..';
      if (xy[0] !== '.') out.staged += 1;
      if (xy[1] !== '.') out.modified += 1;
    } else if (line.startsWith('u ')) out.conflicted += 1;
    else if (line.startsWith('? ')) out.untracked += 1;
  }
  if (out.branch === '(detached)') out.branch = null;
  return out;
}

/** Full status for one repo. Always resolves. */
export async function repoStatus(repoPath, { root } = {}) {
  const label = repoLabel(repoPath, root);
  const statusResult = await git(repoPath, ['status', '--porcelain=v2', '--branch']);
  if (!statusResult.ok) {
    return { repo: label, path: repoPath, ok: false, error: statusResult.stderr || statusResult.message };
  }
  const parsed = parsePorcelainV2(statusResult.stdout);
  const last = await git(repoPath, ['log', '-1', '--pretty=%h%x09%s%x09%cr']);
  const [hash, subject, when] = last.ok ? last.stdout.split('\t') : [null, null, null];

  const dirty = parsed.staged + parsed.modified + parsed.untracked + parsed.conflicted > 0;
  return {
    repo: label,
    path: repoPath,
    ok: true,
    branch: parsed.branch ?? '(detached)',
    upstream: parsed.upstream ?? null,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged: parsed.staged,
    modified: parsed.modified,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    dirty,
    lastCommit: hash ? { hash, subject, when } : null,
  };
}

/** Status for every repo, in parallel. */
export async function statusAll(root, { maxDepth, skipDirs, concurrency = 4 } = {}) {
  const repos = await discoverRepos(root, { maxDepth, skipDirs });
  const rows = await mapLimit(repos, concurrency, (p) => repoStatus(p, { root }));
  return { root, repos, rows };
}

/**
 * Changes per repo, shaped for commit-message writing:
 * what files moved, how much, and the recent commit subjects as style hints.
 */
export async function repoChanges(repoPath, { root } = {}) {
  const label = repoLabel(repoPath, root);
  const statusResult = await git(repoPath, ['status', '--porcelain=v2', '--branch']);
  if (!statusResult.ok) {
    return { repo: label, path: repoPath, ok: false, error: statusResult.stderr || statusResult.message };
  }
  const parsed = parsePorcelainV2(statusResult.stdout);
  const [numstat, nameStatus, diffStat, recent] = await Promise.all([
    git(repoPath, ['diff', '--numstat', 'HEAD']),
    git(repoPath, ['diff', '--name-status', 'HEAD']),
    git(repoPath, ['diff', '--shortstat', 'HEAD']),
    git(repoPath, ['log', '-5', '--pretty=%s']),
  ]);
  const untrackedResult = await git(repoPath, ['ls-files', '--others', '--exclude-standard']);
  const untracked = untrackedResult.ok ? untrackedResult.stdout.split('\n').filter(Boolean) : [];

  const files = [];
  if (nameStatus.ok) {
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [state, ...rest] = line.split('\t');
      files.push({ status: state, path: rest.join('\t') });
    }
  }
  for (const p of untracked) files.push({ status: 'A', path: p, untracked: true });

  const added = [];
  const removed = [];
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n')) {
      const [a, d, p] = line.split('\t');
      if (!p) continue;
      added.push(a === '-' ? 0 : Number(a) || 0);
      removed.push(d === '-' ? 0 : Number(d) || 0);
    }
  }

  return {
    repo: label,
    path: repoPath,
    ok: true,
    branch: parsed.branch ?? '(detached)',
    files: files.slice(0, 200),
    fileCount: files.length,
    added: added.reduce((n, v) => n + v, 0),
    removed: removed.reduce((n, v) => n + v, 0),
    shortstat: diffStat.ok ? diffStat.stdout : '',
    recentCommits: recent.ok ? recent.stdout.split('\n').filter(Boolean) : [],
    hasChanges: files.length > 0,
  };
}

/** Changes for every repo. */
export async function changesAll(root, { maxDepth, skipDirs, concurrency = 4 } = {}) {
  const repos = await discoverRepos(root, { maxDepth, skipDirs });
  const rows = await mapLimit(repos, concurrency, (p) => repoChanges(p, { root }));
  return { root, repos, rows };
}

/**
 * fetch + integrate for one repo.
 * mode: 'ff-only' (default) | 'rebase' | 'merge'
 * dirty trees are refused: a half-resolved conflict across ten repos is worse
 * than a skipped repo the user can handle by hand.
 */
export async function syncRepo(repoPath, { root, mode = 'ff-only', dryRun = false } = {}) {
  const label = repoLabel(repoPath, root);
  const before = await repoStatus(repoPath, { root });
  if (!before.ok) return { repo: label, path: repoPath, ok: false, action: 'skipped', error: before.error };
  if (before.dirty) {
    return {
      repo: label, path: repoPath, ok: false, action: 'skipped',
      branch: before.branch, ahead: before.ahead, behind: before.behind,
      error: `working tree is dirty (${before.staged} staged, ${before.modified} modified, ${before.untracked} untracked)`,
    };
  }
  // Fetch first, even for a dry run: a preview that cannot see new upstream
  // commits is a preview of nothing. Fetch only moves refs, never the work tree.
  const fetched = await git(repoPath, ['fetch', '--prune', '--quiet']);
  if (!fetched.ok) {
    return { repo: label, path: repoPath, ok: false, action: 'fetch-failed', error: fetched.stderr || fetched.message };
  }
  const current = await repoStatus(repoPath, { root });
  if (!current.ok) {
    return { repo: label, path: repoPath, ok: false, action: 'status-failed', error: current.error };
  }
  if (dryRun) {
    if (!current.upstream) {
      return {
        repo: label, path: repoPath, ok: true, action: 'no-upstream', dryRun: true,
        branch: current.branch, note: 'branch has no upstream; a real run would fetch only',
      };
    }
    const behind = current.behind ?? 0;
    return {
      repo: label, path: repoPath, ok: true, action: behind > 0 ? 'would-sync' : 'up-to-date', dryRun: true,
      branch: current.branch, behind: current.behind, ahead: current.ahead,
      note: behind > 0 ? '' : 'already up to date',
    };
  }
  if (!current.upstream) {
    return {
      repo: label, path: repoPath, ok: true, action: 'no-upstream',
      note: 'branch has no upstream; fetch only', branch: current.branch,
    };
  }
  if (!current.behind) {
    return {
      repo: label, path: repoPath, ok: true, action: 'up-to-date',
      branch: current.branch, ahead: current.ahead, behind: current.behind,
    };
  }
  const pullArgs = mode === 'rebase'
    ? ['pull', '--rebase', '--quiet']
    : mode === 'merge'
      ? ['pull', '--no-rebase', '--quiet']
      : ['pull', '--ff-only', '--quiet'];
  const pulled = await git(repoPath, pullArgs, { timeout: 180_000 });
  if (!pulled.ok) {
    return { repo: label, path: repoPath, ok: false, action: 'pull-failed', error: pulled.stderr || pulled.message };
  }
  const afterPull = await repoStatus(repoPath, { root });
  const action = mode === 'rebase' ? 'rebased' : mode === 'merge' ? 'merged' : 'fast-forwarded';
  return {
    repo: label, path: repoPath, ok: true, action,
    branch: afterPull.branch, ahead: afterPull.ahead, behind: afterPull.behind,
    stdout: pulled.stdout, stderr: pulled.stderr,
  };
}

/** Sync every repo. */
export async function syncAll(root, { maxDepth, skipDirs, mode, dryRun, concurrency = 4 } = {}) {
  const repos = await discoverRepos(root, { maxDepth, skipDirs });
  const rows = await mapLimit(repos, concurrency, (p) => syncRepo(p, { root, mode, dryRun }));
  return { root, repos, rows };
}

/** Commit one repo with its own message. */
export async function commitRepo(repoPath, message, { root, addAll = true, dryRun = false, allowEmpty = false } = {}) {
  const label = repoLabel(repoPath, root);
  if (typeof message !== 'string' || !message.trim()) {
    const reason = typeof message === 'string' ? 'empty commit message' : 'commit message must be a string';
    return { repo: label, path: repoPath, ok: false, action: 'commit-failed', error: reason };
  }
  const status = await repoStatus(repoPath, { root });
  if (!status.ok) return { repo: label, path: repoPath, ok: false, action: 'commit-failed', error: status.error };
  if (!status.dirty && !allowEmpty) {
    return { repo: label, path: repoPath, ok: true, action: 'nothing-to-commit', branch: status.branch };
  }
  if (dryRun) {
    return {
      repo: label, path: repoPath, ok: true, action: 'would-commit', dryRun: true,
      message: String(message).trim(), files: status.staged + status.modified + status.untracked,
    };
  }
  if (addAll) {
    const added = await git(repoPath, ['add', '--all']);
    if (!added.ok) return { repo: label, path: repoPath, ok: false, action: 'add-failed', error: added.stderr || added.message };
  }
  const args = ['commit', '-m', String(message).trim()];
  if (allowEmpty) args.push('--allow-empty');
  const committed = await git(repoPath, args);
  if (!committed.ok) {
    return { repo: label, path: repoPath, ok: false, action: 'commit-failed', error: committed.stderr || committed.message };
  }
  const head = await git(repoPath, ['rev-parse', '--short', 'HEAD']);
  return {
    repo: label, path: repoPath, ok: true, action: 'committed',
    message: String(message).trim(), commit: head.ok ? head.stdout : null, stdout: committed.stdout,
  };
}

/** Commit many repos, each with its own message (a map keyed by repo label or path). */
export async function commitAll(root, messageMap, { maxDepth, skipDirs, addAll = true, dryRun = false, concurrency = 4 } = {}) {
  const repos = await discoverRepos(root, { maxDepth, skipDirs });
  const byKey = new Map();
  for (const [key, value] of Object.entries(messageMap ?? {})) {
    byKey.set(normalizeKey(key), value);
  }
  const unknown = [];
  const planned = repos.map((p) => {
    const label = repoLabel(p, root);
    // Exact label or absolute path only. Matching on the bare directory name
    // would silently commit every repo with that name when labels are nested
    // (`apps/api` and `libs/api` share `api`).
    const message = byKey.get(normalizeKey(label)) ?? byKey.get(normalizeKey(p));
    if (message === undefined) return { repo: label, path: p, skip: true, message: null };
    return { repo: label, path: p, skip: false, message };
  });
  for (const key of byKey.keys()) {
    if (!planned.some((p) => normalizeKey(p.repo) === key || normalizeKey(p.path) === key)) {
      unknown.push(key);
    }
  }
  const rows = await mapLimit(
    planned.filter((p) => !p.skip),
    concurrency,
    (p) => commitRepo(p.path, p.message, { root, addAll, dryRun }),
  );
  return {
    root,
    repos,
    rows,
    skipped: planned.filter((p) => p.skip).map((p) => p.repo),
    unknownKeys: unknown,
  };
}

/** Push one repo's current branch. */
export async function pushRepo(repoPath, { root, setUpstream = true, dryRun = false } = {}) {
  const label = repoLabel(repoPath, root);
  const status = await repoStatus(repoPath, { root });
  if (!status.ok) return { repo: label, path: repoPath, ok: false, action: 'push-failed', error: status.error };
  if (dryRun) {
    if (!status.upstream) {
      return {
        repo: label, path: repoPath, ok: true, action: 'no-upstream', dryRun: true,
        branch: status.branch, ahead: status.ahead, upstream: null,
        note: 'a real run would push -u origin HEAD',
      };
    }
    const ahead = status.ahead ?? 0;
    return {
      repo: label, path: repoPath, ok: true, action: ahead > 0 ? 'would-push' : 'up-to-date', dryRun: true,
      branch: status.branch, ahead: status.ahead, upstream: status.upstream,
    };
  }
  const args = status.upstream || !setUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
  const pushed = await git(repoPath, args, { timeout: 180_000 });
  if (!pushed.ok) {
    return { repo: label, path: repoPath, ok: false, action: 'push-failed', branch: status.branch, error: pushed.stderr || pushed.message };
  }
  return {
    repo: label, path: repoPath, ok: true, action: 'pushed',
    branch: status.branch, stdout: [pushed.stdout, pushed.stderr].filter(Boolean).join('\n'),
  };
}

/** Push every repo. */
export async function pushAll(root, { maxDepth, skipDirs, setUpstream, dryRun, concurrency = 4 } = {}) {
  const repos = await discoverRepos(root, { maxDepth, skipDirs });
  const rows = await mapLimit(repos, concurrency, (p) => pushRepo(p, { root, setUpstream, dryRun }));
  return { root, repos, rows };
}

function normalizeKey(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// ── File-level operations for the panel ─────────────────────────────────────
// The batch tools above work per repo; the panel works per file, so these
// primitives take repository-relative paths and always answer with a result
// object instead of rejecting.

/** Run git and feed `input` to stdin (batch pathspecs, avoiding Windows' 32K limit). */
export function gitWithInput(repoPath, args, input, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: -1, stdout, stderr, message: 'git timed out' });
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr, message: error.message }));
    child.on('close', (code, signal) => finish({
      ok: code === 0,
      code: code ?? -1,
      stdout: String(stdout).trimEnd(),
      stderr: String(stderr).trimEnd(),
      message: code === 0 ? '' : (String(stderr).trim() || `git exited with ${code}${signal ? ` (${signal})` : ''}`),
    }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '', 'utf8');
  });
}

/** Normalize a repo-relative path to forward slashes. */
function posixPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

/** Resolve a user-supplied path against the repo; null when it escapes. */
function insideRepo(repoPath, target) {
  const absolute = resolve(repoPath, target);
  const rel = relative(repoPath, absolute);
  if (rel === '' || rel.startsWith('..')) return null;
  return { absolute, relative: posixPath(rel) };
}

/**
 * Parse `git status --porcelain=v2 -z` into one entry per file.
 * Records: `1 XY … path`, `2 XY … path\0origPath`, `u XY … path`, `? path`.
 */
export function parsePorcelainV2Detailed(text) {
  const tokens = String(text ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;
    const kind = token[0];
    if (kind === '1') {
      const fields = token.split(' ');
      const xy = fields[1] ?? '..';
      entries.push({
        path: fields.slice(8).join(' '), index: xy[0], worktree: xy[1], untracked: false, conflicted: false,
      });
    } else if (kind === '2') {
      const fields = token.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const origPath = tokens[i + 1] ?? '';
      i += 1;
      entries.push({
        path, origPath, index: xy[0], worktree: xy[1], untracked: false, conflicted: false,
      });
    } else if (kind === 'u') {
      const fields = token.split(' ');
      entries.push({
        path: fields.slice(10).join(' '), index: 'U', worktree: 'U', untracked: false, conflicted: true,
      });
    } else if (kind === '?') {
      entries.push({
        path: token.slice(2), index: '.', worktree: '?', untracked: true, conflicted: false,
      });
    }
  }
  return entries;
}

/** Number of `added`/`removed` lines per file, keyed by repo-relative path. */
async function numstatMap(repoPath) {
  const map = new Map();
  const result = await git(repoPath, ['diff', '--numstat', 'HEAD']);
  if (!result.ok) return map;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? null : Number(parts[0]);
    const removed = parts[1] === '-' ? null : Number(parts[1]);
    map.set(posixPath(parts.slice(2).join('\t')), { added, removed });
  }
  return map;
}

/**
 * Grouped file-level changes: staged (index side), changes (worktree side or
 * untracked) and conflicts. Used by the panel only.
 */
export async function repoChangeList(repoPath) {
  const status = await git(repoPath, ['status', '--porcelain=v2', '-z']);
  if (!status.ok) {
    return { ok: false, error: status.stderr || status.message, staged: [], changes: [], conflicts: [] };
  }
  const entries = parsePorcelainV2Detailed(status.stdout);
  const counts = await numstatMap(repoPath);
  const staged = [];
  const changes = [];
  const conflicts = [];
  for (const entry of entries) {
    const stat = counts.get(posixPath(entry.path)) ?? { added: 0, removed: 0 };
    const statusLetter = entry.conflicted
      ? 'U'
      : entry.untracked
        ? 'A'
        : entry.index !== '.' && entry.index !== '?'
          ? entry.index
          : entry.worktree;
    const row = {
      path: entry.path,
      origPath: entry.origPath ?? null,
      status: statusLetter,
      index: entry.index,
      worktree: entry.worktree,
      untracked: entry.untracked,
      conflicted: entry.conflicted,
      added: stat.added,
      removed: stat.removed,
    };
    if (entry.conflicted) {
      conflicts.push(row);
      continue;
    }
    if (entry.index !== '.') staged.push({ ...row });
    if (entry.untracked || entry.worktree !== '.') changes.push({ ...row });
  }
  return { ok: true, staged, changes, conflicts };
}

/** Stage all files in a repo, or just the listed paths (stdin pathspec). */
export async function stagePaths(repoPath, paths = []) {
  const list = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && item !== '');
  if (list.length === 0) {
    const result = await git(repoPath, ['add', '--all']);
    return result.ok
      ? { ok: true, action: 'staged-all' }
      : { ok: false, error: result.stderr || result.message };
  }
  const result = await gitWithInput(
    repoPath,
    ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
    `${list.join('\0')}\0`,
  );
  return result.ok
    ? { ok: true, action: 'staged', paths: list }
    : { ok: false, error: result.stderr || result.message };
}

/** Unstage all files, or just the listed paths (index only, never the worktree). */
export async function unstagePaths(repoPath, paths = []) {
  const list = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && item !== '');
  const result = list.length === 0
    ? await git(repoPath, ['restore', '--staged', '--', '.'])
    : await gitWithInput(
      repoPath,
      ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'],
      `${list.join('\0')}\0`,
    );
  return result.ok
    ? { ok: true, action: list.length === 0 ? 'unstaged-all' : 'unstaged', paths: list }
    : { ok: false, error: result.stderr || result.message };
}

/**
 * Discard worktree changes for the listed paths.
 * Tracked files are restored from the index (`git restore --worktree`, never
 * `checkout --`); untracked files are deleted only after re-checking that git
 * still reports them as untracked. The panel asks for confirmation first.
 */
export async function discardPaths(repoPath, paths = []) {
  const list = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && item !== '');
  const results = [];
  for (const requested of list) {
    const target = insideRepo(repoPath, requested);
    if (target === null) {
      results.push({ path: requested, ok: false, action: 'refused', error: 'path outside repository' });
      continue;
    }
    const tracked = await git(repoPath, ['ls-files', '--error-unmatch', '--', target.relative]);
    if (tracked.ok) {
      const restored = await git(repoPath, ['restore', '--worktree', '--', target.relative]);
      results.push({
        path: target.relative,
        action: restored.ok ? 'restored' : 'restore-failed',
        ok: restored.ok,
        ...restored.ok ? {} : { error: restored.stderr || restored.message },
      });
      continue;
    }
    const status = await git(repoPath, ['status', '--porcelain', '--', target.relative]);
    const untrackedNow = status.ok && status.stdout.split('\n').some((line) => line.startsWith('??'));
    if (!untrackedNow) {
      results.push({ path: target.relative, ok: false, action: 'refused', error: 'not an untracked file' });
      continue;
    }
    try {
      await rm(target.absolute, { recursive: true, force: true });
      results.push({ path: target.relative, ok: true, action: 'deleted' });
    } catch (error) {
      results.push({ path: target.relative, ok: false, action: 'delete-failed', error: error.message });
    }
  }
  return { ok: results.every((row) => row.ok), results };
}

function escapeGitignore(value) {
  return String(value)
    .replace(/([\\*?[\]])/g, '\\$1')
    .replace(/^(#|!)/, '\\$1');
}

/** Append an ignore rule to the repository's `.gitignore` (deduplicated). */
export async function addIgnoreRule(repoPath, targetPath, mode = 'file') {
  const target = insideRepo(repoPath, targetPath);
  if (target === null) return { ok: false, error: 'path outside repository' };
  let pattern;
  if (mode === 'ext') {
    const extension = extname(target.relative).replace(/^\./, '');
    if (extension === '') return { ok: false, error: 'file has no extension' };
    pattern = `*.${extension}`;
  } else if (mode === 'dir') {
    pattern = `/${escapeGitignore(target.relative)}/`;
  } else {
    pattern = `/${escapeGitignore(target.relative)}`;
  }
  const ignorePath = join(repoPath, '.gitignore');
  let content = '';
  try {
    content = await readFile(ignorePath, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.split(/\r?\n/);
  if (lines.some((line) => line.trim() === pattern)) {
    return { ok: true, pattern, added: false };
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  try {
    await writeFile(ignorePath, `${content}${separator}${pattern}\n`, 'utf8');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, pattern, added: true };
}

/** Unified diff for one file; untracked files get a synthetic "new file" patch. */
export async function repoDiff(repoPath, targetPath, { staged = false, maxBytes = 512 * 1024 } = {}) {
  const target = insideRepo(repoPath, targetPath);
  if (target === null) return { ok: false, error: 'path outside repository' };
  const status = await git(repoPath, ['status', '--porcelain', '--', target.relative]);
  const untracked = status.ok && status.stdout.split('\n').some((line) => line.startsWith('??'));
  if (untracked) {
    let content;
    try {
      content = await readFile(target.absolute, 'utf8');
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const truncated = Buffer.byteLength(content, 'utf8') > maxBytes;
    const text = truncated ? content.slice(0, maxBytes) : content;
    const body = text.split('\n').map((line, index, all) => (index === all.length - 1 && line === '' ? '' : `+${line}`)).join('\n');
    return {
      ok: true,
      path: target.relative,
      untracked: true,
      truncated,
      text: `diff --git a/${target.relative} b/${target.relative}\nnew file\n--- /dev/null\n+++ b/${target.relative}\n${body}`,
    };
  }
  const result = await git(repoPath, staged ? ['diff', '--staged', '--', target.relative] : ['diff', '--', target.relative]);
  if (!result.ok) return { ok: false, error: result.stderr || result.message };
  const truncated = result.stdout.length > maxBytes;
  return {
    ok: true,
    path: target.relative,
    untracked: false,
    truncated,
    text: truncated ? result.stdout.slice(0, maxBytes) : result.stdout,
  };
}

/** Commit history for one file. */
export async function repoHistory(repoPath, targetPath, { limit = 20 } = {}) {
  const target = insideRepo(repoPath, targetPath);
  if (target === null) return { ok: false, error: 'path outside repository' };
  const result = await git(repoPath, [
    'log', '--follow', `-n${limit}`, '--pretty=%H%x09%h%x09%an%x09%ar%x09%s', '--', target.relative,
  ]);
  if (!result.ok) return { ok: false, error: result.stderr || result.message };
  const commits = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, short, author, when, ...rest] = line.split('\t');
    return { hash, short, author, when, subject: rest.join('\t') };
  });
  return { ok: true, path: target.relative, commits };
}

/** Stash the listed paths (or everything) with a recognisable message. */
export async function stashPaths(repoPath, paths = []) {
  const list = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && item !== '');
  const args = ['stash', 'push', '-m', `workaround-git ${new Date().toISOString()}`];
  const status = await git(repoPath, ['status', '--porcelain', ...(list.length > 0 ? ['--', ...list] : [])]);
  if (!status.ok) return { ok: false, error: status.stderr || status.message };
  const hasUntracked = status.stdout.split('\n').some((line) => line.startsWith('??'));
  if (hasUntracked) args.push('-u');
  if (list.length > 0) args.push('--', ...list);
  const result = await git(repoPath, args);
  return result.ok
    ? { ok: true, action: 'stashed', paths: list, note: 'restore with git stash pop' }
    : { ok: false, error: result.stderr || result.message };
}

/** Local branches of a repo, with the current one flagged. */
export async function listBranches(repoPath) {
  const result = await git(repoPath, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)', 'refs/heads']);
  if (!result.ok) return { ok: false, error: result.stderr || result.message };
  const branches = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, head] = line.split('\t');
    return { name, upstream: upstream || null, current: head === '*' };
  });
  return { ok: true, branches };
}

/** Switch to an existing local branch. */
export async function switchBranch(repoPath, branch) {
  const name = typeof branch === 'string' ? branch.trim() : '';
  if (name === '') return { ok: false, error: 'branch name is required' };
  const listed = await listBranches(repoPath);
  if (!listed.ok) return { ok: false, error: listed.error };
  if (!listed.branches.some((row) => row.name === name)) return { ok: false, error: `branch not found: ${name}` };
  const result = await git(repoPath, ['switch', name]);
  return result.ok
    ? { ok: true, action: 'switched', branch: name }
    : { ok: false, error: result.stderr || result.message };
}

/**
 * Command line used to open a path, per platform.
 *
 * Windows: `explorer.exe /select,<path>` reveals; `rundll32
 * url.dll,FileProtocolHandler` opens a file — the same opener the reference git
 * panel uses, because `cmd /c start` flashes a console window.
 */
export function openerArgv(platform, target, mode = 'file') {
  if (platform === 'win32') {
    return mode === 'reveal'
      ? { command: 'explorer.exe', args: [`/select,${target}`] }
      : { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: mode === 'reveal' ? ['-R', target] : [target] };
  }
  return { command: 'xdg-open', args: mode === 'reveal' ? [dirname(target)] : [target] };
}

/** Open a path with the OS default handler, or reveal it in the file manager. */
export function openWithSystem(target, mode = 'file') {
  return new Promise((resolvePromise) => {
    if (typeof target !== 'string' || !existsSync(target)) {
      resolvePromise({ ok: false, error: 'path does not exist' });
      return;
    }
    const { command, args } = openerArgv(process.platform, target, mode);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    try {
      // `windowsHide: true` also hides the Explorer window launched from this
      // process (verified on Windows 11), which made "reveal" open a window the
      // user never saw. Keep the opener spawn visible.
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', (error) => finish({ ok: false, error: error.message }));
      child.once('spawn', () => finish({ ok: true, action: mode, opened: target }));
      child.unref();
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }
    const timer = setTimeout(() => finish({ ok: true, action: mode, opened: target }), 1500);
    timer.unref?.();
  });
}

/** Look an executable up on PATH without spawning a process. */
function findOnPath(name, { pathValue = process.env.PATH ?? '', extraDirs = [] } = {}) {
  const candidates = [...extraDirs, ...pathValue.split(delimiter)].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, name))) return join(dir, name);
    } catch {
      // ignore malformed PATH entries
    }
  }
  return null;
}

/**
 * Command that opens an interactive terminal at `repoPath`.
 *
 * The directory is passed as the child's working directory (or as a
 * single argv element), never interpolated into a shell string, so a crafted
 * path cannot become a command.
 */
export function terminalArgv(platform, repoPath, { hasWindowsTerminal = false } = {}) {
  if (platform === 'win32') {
    return hasWindowsTerminal
      ? { command: 'wt.exe', args: ['-d', repoPath], cwd: repoPath }
      : { command: 'powershell.exe', args: ['-NoExit'], cwd: repoPath };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Terminal', repoPath], cwd: repoPath };
  }
  return { command: 'x-terminal-emulator', args: ['--working-directory', repoPath], cwd: repoPath };
}

/** Launch a terminal window at `repoPath`. Resolves as soon as it spawned. */
export function openTerminal(repoPath) {
  return new Promise((resolvePromise) => {
    if (typeof repoPath !== 'string' || !existsSync(repoPath)) {
      resolvePromise({ ok: false, error: 'path does not exist' });
      return;
    }
    const platform = process.platform;
    const hasWindowsTerminal = platform === 'win32'
      && findOnPath('wt.exe', {
        extraDirs: process.env.LOCALAPPDATA
          ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')]
          : [],
      }) !== null;
    const { command, args, cwd } = terminalArgv(platform, repoPath, { hasWindowsTerminal });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const launch = (cmd, argv) => {
      // Visible on purpose: the terminal is the whole point of the action.
      const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', cwd });
      child.once('error', (error) => finish({ ok: false, error: error.message }));
      child.once('spawn', () => finish({ ok: true, action: 'terminal', opened: repoPath, command: cmd }));
      child.unref();
    };
    try {
      launch(command, args);
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
    const timer = setTimeout(() => finish({ ok: true, action: 'terminal', opened: repoPath, command }), 1500);
    timer.unref?.();
  });
}

/** The `origin` remote URL, falling back to the first configured remote. */
export async function repoRemote(repoPath) {
  const origin = await git(repoPath, ['remote', 'get-url', 'origin']);
  if (origin.ok && origin.stdout.trim() !== '') return { name: 'origin', url: origin.stdout.trim() };
  const listed = await git(repoPath, ['remote']);
  if (!listed.ok) return { name: null, url: null };
  const name = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (name === undefined) return { name: null, url: null };
  const url = await git(repoPath, ['remote', 'get-url', name]);
  return url.ok && url.stdout.trim() !== ''
    ? { name, url: url.stdout.trim() }
    : { name, url: null };
}

/** Fetch one repo's remotes (never integrates anything into the worktree). */
export async function fetchRepo(repoPath, { timeout = 60_000 } = {}) {
  const result = await git(repoPath, ['fetch', '--quiet'], { timeout });
  return result.ok
    ? { ok: true, action: 'fetched' }
    : { ok: false, error: result.stderr || result.message };
}

/** Fetch several repos with bounded concurrency; a failure is a row, not a batch abort. */
export async function fetchRepos(repoPaths, { concurrency = 4, timeout = 60_000 } = {}) {
  const rows = await mapLimit(repoPaths, concurrency, async (repoPath) => {
    const result = await fetchRepo(repoPath, { timeout });
    return { repo: repoPath, ...result };
  });
  return { rows };
}
