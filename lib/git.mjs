/**
 * Batch git primitives.
 *
 * Every function here takes absolute repo paths and never throws on per-repo
 * failure: one broken repo must not abort the whole batch. Callers get a
 * structured result per repo so the tool layer can report partial success.
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

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
