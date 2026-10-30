/**
 * Panel state: one managed workspace flattened into per-repo rows.
 *
 * Reads only. Every repo row carries everything the panel renders — branch,
 * ahead/behind, dirt counters, the file-level change groups (staged / changes /
 * conflicts) and the last commit — so the client never has to issue a second
 * request per repo.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { discoverRepos, mapLimit, repoChangeList, repoRemote, repoStatus } from './git.mjs';

const DEFAULT_DEPTH = 2;

/** `true` when `candidate` lives strictly below `root`. */
function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Which managed workspace owns one repository.
 *
 * A repo that is itself a managed root owns itself (the normal
 * one-project-per-workspace layout); otherwise the closest ancestor workspace
 * owns it. Without this rule a repo nested inside a managed parent would be
 * reported once per workspace and the panel would render it twice.
 */
export function repoOwner(repoPath, workspaces) {
  const target = resolve(repoPath);
  let owner;
  for (const workspace of workspaces) {
    const root = resolve(workspace.path);
    if (root === target) return workspace;
    if (isInside(root, target) && (owner === undefined || root.length > resolve(owner.path).length)) {
      owner = workspace;
    }
  }
  return owner;
}

/** Keep only the rows this workspace owns, so one physical repo renders once. */
export function ownedRepos(workspace, repos, workspaces) {
  const ownRoot = resolve(workspace.path);
  return repos.filter((repo) => {
    const owner = repoOwner(repo.path, workspaces);
    return owner === undefined || resolve(owner.path) === ownRoot;
  });
}

export async function workspaceState(workspace, { maxDepth = DEFAULT_DEPTH, concurrency = 4 } = {}) {
  const root = workspace.path;
  const repos = await discoverRepos(root, { maxDepth });
  const rows = await mapLimit(repos, concurrency, async (repoPath) => {
    const [status, changes, remote] = await Promise.all([
      repoStatus(repoPath, { root }),
      repoChangeList(repoPath),
      repoRemote(repoPath),
    ]);
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
  // One row per physical repository: a repo nested inside another managed
  // workspace is rendered by the workspace that owns it (see `repoOwner`).
  return rows.map((state) => ({ ...state, repos: ownedRepos(state, state.repos ?? [], workspaces) }));
}
