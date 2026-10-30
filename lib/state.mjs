/**
 * Panel state: one managed workspace flattened into per-repo rows.
 *
 * Reads only. Every repo row carries everything the panel renders — branch,
 * ahead/behind, dirt counters, the file-level change groups (staged / changes /
 * conflicts) and the last commit — so the client never has to issue a second
 * request per repo.
 *
 * A row's `path` is the *scope* git runs in: the repository root for a normal
 * workspace, or the module directory when the workspace is a subdirectory of a
 * repository. `repoRoot` is the work-tree root behind that scope.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverRepos, mapLimit, repoChangeList, repoRemote, repoRootAt, repoStatus } from './git.mjs';

const DEFAULT_DEPTH = 2;

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Identity of one rendered card: a repository *and* the scope it is viewed
 * from. Coexistence is a feature (the whole repo plus one module inside it),
 * while the same pair reached twice — a nested repository discovered under a
 * managed parent — is the duplicate that must collapse.
 */
export function repoScopeKey(repoRoot, scopePath) {
  return `${canonical(repoRoot || scopePath)}\u0000${canonical(scopePath)}`;
}

/**
 * Keep one row per (repository, scope) pair. The workspace whose own path is
 * the scope claims the pair, so `~/.dsh` (a repo that holds managed repos)
 * cannot render the same nested repository a second time.
 */
function dedupeScopedRows(entries) {
  const ordered = [...entries].sort((a, b) => Number(b.ownScope) - Number(a.ownScope));
  const keep = new Set();
  const seen = new Set();
  for (const { repo } of ordered) {
    const key = repoScopeKey(repo.repoRoot, repo.path);
    if (seen.has(key)) continue;
    seen.add(key);
    keep.add(repo);
  }
  return keep;
}

export async function workspaceState(workspace, { maxDepth = DEFAULT_DEPTH, concurrency = 4 } = {}) {
  const root = workspace.path;
  const repos = await discoverRepos(root, { maxDepth });
  const rows = await mapLimit(repos, concurrency, async (repoPath) => {
    const [status, changes, remote, repoRoot] = await Promise.all([
      repoStatus(repoPath, { root }),
      repoChangeList(repoPath),
      repoRemote(repoPath),
      repoRootAt(repoPath),
    ]);
    const staged = changes.staged ?? [];
    const worktree = changes.changes ?? [];
    return {
      repo: status.repo,
      path: status.path,
      repoRoot: repoRoot ?? resolve(repoPath),
      ok: status.ok,
      error: status.ok ? null : status.error,
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      untracked: status.untracked,
      conflicted: status.conflicted,
      dirty: status.dirty,
      lastCommit: status.lastCommit,
      remote,
      groups: {
        staged,
        changes: worktree,
        conflicts: changes.conflicts ?? [],
      },
      totals: {
        staged: staged.length,
        changes: worktree.length,
        conflicts: (changes.conflicts ?? []).length,
      },
    };
  });
  return {
    id: workspace.id,
    title: workspace.title,
    path: root,
    repos: rows,
  };
}

/** State for every managed workspace, in parallel. */
export async function managedWorkspacesState(workspaces, options = {}) {
  const rows = await Promise.all(
    workspaces.map((workspace) => workspaceState(workspace, options).catch((error) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      repos: [],
      error: error?.message ?? String(error),
    }))),
  );
  const entries = [];
  for (const state of rows) {
    for (const repo of state.repos ?? []) {
      entries.push({ repo, ownScope: canonical(state.path) === canonical(repo.path) });
    }
  }
  const keep = dedupeScopedRows(entries);
  return rows.map((state) => ({ ...state, repos: (state.repos ?? []).filter((repo) => keep.has(repo)) }));
}
