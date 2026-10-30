/**
 * HTTP surface for the panel.
 *
 * Mounted as one prefix route (`/workaround-git`) on the host web server; the
 * client half talks to it with same-origin fetch. Mutations are confined to
 * managed workspaces: a request names a workspace id and a repo path, and the
 * path is re-validated against that workspace root before git runs, so the
 * browser can never turn this into "run git anywhere on disk".
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readManaged, writeManaged } from './store.mjs';
import { listWorkspaces } from './workspaces.mjs';
import { managedWorkspacesState } from './state.mjs';
import { suggestMessage } from './suggest.mjs';
import {
  addIgnoreRule,
  commitRepo,
  discoverRepos,
  discardPaths,
  fetchRepos,
  isRepo,
  listBranches,
  openWithSystem,
  pushRepo,
  repoDiff,
  repoHistory,
  stagePaths,
  stashPaths,
  switchBranch,
  syncRepo,
  unstagePaths,
} from './git.mjs';

export const API_PREFIX = '/workaround-git';
const MAX_BODY_BYTES = 1024 * 1024;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'body-too-large', 'request body exceeds 1 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolvePromise({}); return; }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'bad-json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function findWorkspace(workspaceId) {
  const managed = await readManaged();
  const workspace = managed.workspaces.find((entry) => entry.id === workspaceId || entry.path === workspaceId);
  if (!workspace) throw new ApiError(409, 'workspace-not-managed', `workspace ${workspaceId} is not managed by this panel`);
  return workspace;
}

/**
 * Resolve a repo path inside a managed workspace. Accepts an absolute or
 * workspace-relative path; anything that escapes the workspace is refused.
 */
async function findRepo(workspace, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new ApiError(400, 'repo-missing', 'repo path is required');
  }
  const root = resolve(workspace.path);
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ApiError(403, 'repo-outside-workspace', 'repo must be inside the managed workspace');
  }
  if (!(await isRepo(candidate))) {
    throw new ApiError(404, 'not-a-repo', `${candidate} is not a git repository`);
  }
  return candidate;
}

/**
 * Resolve a file path inside a repo (and therefore inside the workspace).
 * Absolute or repo-relative input both work; anything that escapes is refused.
 */
async function findTarget(workspace, repoPath, requested, { mustExist = false } = {}) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new ApiError(400, 'path-missing', 'path is required');
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(repoPath, requested);
  const rel = relative(repoPath, candidate);
  const workspaceRel = relative(resolve(workspace.path), candidate);
  if (isAbsolute(rel) || rel.startsWith('..') || workspaceRel.startsWith('..') || isAbsolute(workspaceRel)) {
    throw new ApiError(403, 'path-outside-repo', 'path must be inside the repository');
  }
  if (rel === '') {
    // The repository root itself is only useful for "reveal in file manager".
    return { absolute: repoPath, relative: '.' };
  }
  if (mustExist && !existsSync(candidate)) {
    throw new ApiError(404, 'path-not-found', `${rel} does not exist`);
  }
  return { absolute: candidate, relative: rel.replace(/\\/g, '/') };
}

function workspacePayload(workspace, entry) {
  return {
    ...workspace,
    managed: entry !== undefined,
  };
}

async function handle(ctx, req, res, pathname, url) {
  const method = (req.method ?? 'GET').toUpperCase();

  if (pathname === '/api/health' && method === 'GET') {
    json(res, 200, { ok: true, data: { plugin: 'dsh-workaround-git', api: 1 } });
    return;
  }

  if (pathname === '/api/workspaces' && method === 'GET') {
    const refresh = url.searchParams.get('refresh') === '1';
    const [all, managed] = await Promise.all([listWorkspaces(ctx, { refresh }), readManaged()]);
    const managedByPath = new Map(managed.workspaces.map((entry) => [entry.path, entry]));
    json(res, 200, {
      ok: true,
      data: {
        workspaces: all.map((workspace) => workspacePayload(workspace, managedByPath.get(workspace.path))),
        managed: managed.workspaces,
      },
    });
    return;
  }

  if (pathname === '/api/managed' && method === 'GET') {
    json(res, 200, { ok: true, data: await readManaged() });
    return;
  }

  if (pathname === '/api/managed' && method === 'POST') {
    const body = await readBody(req);
    const requested = Array.isArray(body.workspaces) ? body.workspaces : [];
    const all = await listWorkspaces(ctx);
    const byPath = new Map(all.map((workspace) => [workspace.path, workspace]));
    const byId = new Map(all.map((workspace) => [workspace.id, workspace]).filter(([id]) => id !== ''));
    const picked = [];
    const rejected = [];
    for (const entry of requested) {
      const workspace = byPath.get(entry?.path) ?? byId.get(entry?.id);
      if (!workspace || workspace.exists !== true) {
        rejected.push({ id: entry?.id ?? null, path: entry?.path ?? null, reason: 'workspace not found on this machine' });
        continue;
      }
      if (workspace.git === 'none') {
        rejected.push({ id: workspace.id, path: workspace.path, reason: 'workspace contains no git repository' });
        continue;
      }
      picked.push({ id: workspace.id, path: workspace.path, title: workspace.title });
    }
    const saved = await writeManaged(picked);
    json(res, 200, { ok: true, data: { managed: saved, rejected } });
    return;
  }

  if (pathname === '/api/state' && method === 'GET') {
    const managed = await readManaged();
    const managedIds = await listWorkspaces(ctx, {});
    const byPath = new Map(managedIds.map((workspace) => [workspace.path, workspace]));
    const workspaces = managed.workspaces.map((entry) => {
      const known = byPath.get(entry.path);
      return { id: known?.id ?? entry.id, path: entry.path, title: known?.title || entry.title || '' };
    });
    const state = await managedWorkspacesState(workspaces);
    json(res, 200, { ok: true, data: { workspaces: state } });
    return;
  }

  if (pathname === '/api/stage' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const requested of paths) await findTarget(workspace, repoPath, requested);
    const result = await stagePaths(repoPath, paths);
    if (!result.ok) throw new ApiError(500, 'stage-failed', result.error ?? 'stage failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/unstage' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const requested of paths) await findTarget(workspace, repoPath, requested);
    const result = await unstagePaths(repoPath, paths);
    if (!result.ok) throw new ApiError(500, 'unstage-failed', result.error ?? 'unstage failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/discard' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const paths = Array.isArray(body.paths) ? body.paths.filter((item) => typeof item === 'string' && item !== '') : [];
    if (paths.length === 0) throw new ApiError(400, 'paths-missing', 'paths are required');
    for (const requested of paths) await findTarget(workspace, repoPath, requested);
    json(res, 200, { ok: true, data: await discardPaths(repoPath, paths) });
    return;
  }

  if (pathname === '/api/ignore' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const target = await findTarget(workspace, repoPath, body.path);
    const mode = body.mode === 'ext' || body.mode === 'dir' ? body.mode : 'file';
    const result = await addIgnoreRule(repoPath, target.relative, mode);
    if (!result.ok) throw new ApiError(500, 'ignore-failed', result.error ?? 'ignore failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/open' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const target = await findTarget(workspace, repoPath, body.path, { mustExist: true });
    const mode = body.mode === 'reveal' ? 'reveal' : 'file';
    const result = await openWithSystem(target.absolute, mode);
    if (!result.ok) throw new ApiError(500, 'open-failed', result.error ?? 'open failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/diff' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const target = await findTarget(workspace, repoPath, body.path);
    const result = await repoDiff(repoPath, target.relative, { staged: body.staged === true });
    if (!result.ok) throw new ApiError(500, 'diff-failed', result.error ?? 'diff failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/history' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const target = await findTarget(workspace, repoPath, body.path);
    const result = await repoHistory(repoPath, target.relative);
    if (!result.ok) throw new ApiError(500, 'history-failed', result.error ?? 'history failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/stash' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const paths = Array.isArray(body.paths) ? body.paths : [];
    for (const requested of paths) await findTarget(workspace, repoPath, requested);
    const result = await stashPaths(repoPath, paths);
    if (!result.ok) throw new ApiError(500, 'stash-failed', result.error ?? 'stash failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/branches' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const result = await listBranches(repoPath);
    if (!result.ok) throw new ApiError(500, 'branches-failed', result.error ?? 'branches failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/branch-switch' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const result = await switchBranch(repoPath, body.branch);
    if (!result.ok) throw new ApiError(500, 'switch-failed', result.error ?? 'switch failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/fetch' && method === 'POST') {
    const body = await readBody(req);
    let targets;
    if (typeof body.repo === 'string' && body.repo !== '') {
      const workspace = await findWorkspace(body.workspaceId);
      targets = [await findRepo(workspace, body.repo)];
    } else {
      const managed = await readManaged();
      targets = [];
      for (const entry of managed.workspaces) {
        targets.push(...await discoverRepos(entry.path, { maxDepth: 2 }));
      }
    }
    const { rows } = await fetchRepos(targets, { concurrency: 4 });
    json(res, 200, {
      ok: true,
      data: {
        results: rows,
        fetched: rows.filter((row) => row.ok).length,
        failed: rows.filter((row) => !row.ok).length,
      },
    });
    return;
  }

  if (pathname === '/api/suggest' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const result = await suggestMessage(ctx, repoPath, { root: workspace.path, signal: undefined });
    if (!result.ok) throw new ApiError(result.error.code === 'llm-unavailable' ? 503 : 502, result.error.code, result.error.message);
    json(res, 200, { ok: true, data: result });
    return;
  }

  if (pathname === '/api/commit' && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message === '') throw new ApiError(400, 'message-missing', 'commit message is required');
    const result = await commitRepo(repoPath, message, { root: workspace.path, addAll: false });
    if (!result.ok) throw new ApiError(500, result.action === 'commit-failed' ? 'commit-failed' : 'commit-error', result.error ?? 'commit failed');
    json(res, 200, { ok: true, data: result });
    return;
  }

  if ((pathname === '/api/sync' || pathname === '/api/push') && method === 'POST') {
    const body = await readBody(req);
    const workspace = await findWorkspace(body.workspaceId);
    const repoPath = await findRepo(workspace, body.repo);
    const result = pathname === '/api/sync'
      ? await syncRepo(repoPath, { root: workspace.path, dryRun: body.dryRun === true })
      : await pushRepo(repoPath, { root: workspace.path, dryRun: body.dryRun === true });
    if (result.ok === false && result.action !== 'skipped') {
      throw new ApiError(500, result.action ?? 'git-error', result.error ?? 'git operation failed');
    }
    json(res, 200, { ok: true, data: result });
    return;
  }

  throw new ApiError(404, 'not-found', `no route for ${method} ${pathname}`);
}

/** Build the request handler mounted at API_PREFIX. */
export function createApiHandler(ctx) {
  return async function handler(req, res) {
    let pathname = '/';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      if (pathname.startsWith(API_PREFIX)) pathname = pathname.slice(API_PREFIX.length) || '/';
    } catch {
      json(res, 400, { ok: false, error: { code: 'bad-url', message: 'malformed request URL' } });
      return;
    }
    try {
      await handle(ctx, req, res, pathname, url);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : 'internal-error';
      const message = error?.message ?? String(error);
      if (!(error instanceof ApiError)) ctx.logger?.warn?.(`[workaround-git] ${code}: ${message}`);
      json(res, status, { ok: false, error: { code, message } });
    }
  };
}
