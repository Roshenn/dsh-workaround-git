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
import { discoverRepos, mapLimit, repoSnapshot } from './git.mjs';

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
 * Drop the cards the user hid from the panel.
 *
 * A card is identified by its *scope* path (`repo.path`): hiding a module
 * scope leaves the whole-repository card of the same repo alone, and hiding a
 * repository root hides it even when another managed workspace reaches the
 * same repository. Paths that no longer exist still compare through `resolve`,
 * so a hidden card whose folder disappeared stays hidden instead of throwing.
 */
export function filterHiddenRepos(rows, hiddenRepos = []) {
  const hidden = new Set();
  for (const path of Array.isArray(hiddenRepos) ? hiddenRepos : []) {
    if (typeof path !== 'string' || path.trim() === '') continue;
    hidden.add(canonical(path.trim()));
  }
  if (hidden.size === 0) return rows;
  return rows.filter((row) => !(typeof row?.path === 'string' && row.path !== '' && hidden.has(canonical(row.path))));
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

/**
 * One card's payload from one repository snapshot.
 *
 * The only place this shape is built: `workspaceState` uses it for every card
 * on the panel's entry read, and `POST /api/repo-state` uses it to refresh a
 * single card after an action — the two paths cannot drift apart.
 */
export function repoRowFromSnapshot(snapshot, repoPath) {
  const groups = snapshot.groups ?? { staged: [], changes: [], conflicts: [] };
  const staged = groups.staged ?? [];
  const worktree = groups.changes ?? [];
  const conflicts = groups.conflicts ?? [];
  return {
    repo: snapshot.repo,
    path: snapshot.path,
    repoRoot: snapshot.repoRoot ?? resolve(repoPath),
    ok: snapshot.ok,
    error: snapshot.ok ? null : snapshot.error,
    branch: snapshot.branch ?? null,
    ahead: snapshot.ahead ?? null,
    behind: snapshot.behind ?? null,
    staged: snapshot.staged ?? 0,
    modified: snapshot.modified ?? 0,
    untracked: snapshot.untracked ?? 0,
    conflicted: snapshot.conflicted ?? 0,
    conflictPaths: snapshot.conflictPaths ?? [],
    /** 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null — an in-progress operation. */
    sequencer: snapshot.sequencer ?? null,
    dirty: snapshot.dirty ?? false,
    lastCommit: snapshot.lastCommit ?? null,
    remote: snapshot.remote ?? { name: null, url: null },
    groups: {
      staged,
      changes: worktree,
      conflicts,
    },
    totals: {
      staged: staged.length,
      changes: worktree.length,
      conflicts: conflicts.length,
    },
  };
}

export async function workspaceState(workspace, { maxDepth = DEFAULT_DEPTH, concurrency = 8 } = {}) {
  const root = workspace.path;
  const repos = await discoverRepos(root, { maxDepth });
  const rows = await mapLimit(repos, concurrency, async (repoPath) => {
    // One snapshot per card: its five git calls run concurrently inside, so the
    // panel no longer pays three sequential waves per repository on entry.
    return repoRowFromSnapshot(await repoSnapshot(repoPath, { root }), repoPath);
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
  const { hiddenRepos = [], ...probeOptions } = options;
  const rows = await Promise.all(
    workspaces.map((workspace) => workspaceState(workspace, probeOptions).catch((error) => ({
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
  return rows.map((state) => ({
    ...state,
    repos: filterHiddenRepos((state.repos ?? []).filter((repo) => keep.has(repo)), hiddenRepos),
  }));
}
