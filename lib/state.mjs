/**
 * Panel state: one managed workspace flattened into per-repo rows.
 *
 * Reads only. Every repo row carries everything the panel renders — branch,
 * ahead/behind, dirt counters, the file-level change groups (staged / changes /
 * conflicts) and the last commit — so the client never has to issue a second
 * request per repo.
 */
import { discoverRepos, mapLimit, repoChangeList, repoStatus } from './git.mjs';

const DEFAULT_DEPTH = 2;

export async function workspaceState(workspace, { maxDepth = DEFAULT_DEPTH, concurrency = 4 } = {}) {
  const root = workspace.path;
  const repos = await discoverRepos(root, { maxDepth });
  const rows = await mapLimit(repos, concurrency, async (repoPath) => {
    const status = await repoStatus(repoPath, { root });
    const changes = await repoChangeList(repoPath);
    const staged = changes.staged ?? [];
    const worktree = changes.changes ?? [];
    return {
      repo: status.repo,
      path: status.path,
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
  return rows;
}
