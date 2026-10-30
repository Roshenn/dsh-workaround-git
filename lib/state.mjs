/**
 * Panel state: one managed workspace flattened into per-repo rows.
 *
 * Reads only. Every repo row carries everything the panel renders — branch,
 * ahead/behind, dirt counters, the file-level change list and the recent commit
 * subjects — so the client never has to issue a second request per repo.
 */
import { statusAll, changesAll } from './git.mjs';

const DEFAULT_DEPTH = 2;

export async function workspaceState(workspace, { maxDepth = DEFAULT_DEPTH, concurrency = 4 } = {}) {
  const root = workspace.path;
  const [status, changes] = await Promise.all([
    statusAll(root, { maxDepth, concurrency }),
    changesAll(root, { maxDepth, concurrency }),
  ]);
  const byPath = new Map(changes.rows.map((row) => [row.path, row]));
  const repos = status.rows.map((row) => {
    const change = byPath.get(row.path);
    return {
      repo: row.repo,
      path: row.path,
      ok: row.ok,
      error: row.ok ? null : row.error,
      branch: row.branch,
      ahead: row.ahead,
      behind: row.behind,
      staged: row.staged,
      modified: row.modified,
      untracked: row.untracked,
      conflicted: row.conflicted,
      dirty: row.dirty,
      lastCommit: row.lastCommit,
      files: change?.files ?? [],
      added: change?.added ?? 0,
      removed: change?.removed ?? 0,
      recentCommits: change?.recentCommits ?? [],
    };
  });
  return {
    id: workspace.id,
    title: workspace.title,
    path: root,
    repos,
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
