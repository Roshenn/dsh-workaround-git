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
import { readManaged, writeManaged } from './store.mjs';
import { listWorkspaces } from './workspaces.mjs';
import { managedWorkspacesState } from './state.mjs';
import { suggestMessage } from './suggest.mjs';
import { commitRepo, git, isRepo, pushRepo, syncRepo } from './git.mjs';

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
    const result = await git(repoPath, ['add', '--all']);
    if (!result.ok) throw new ApiError(500, 'stage-failed', result.stderr || result.message);
    const staged = await git(repoPath, ['diff', '--cached', '--name-status']);
    json(res, 200, {
      ok: true,
      data: {
        repo: repoPath,
        files: staged.ok ? staged.stdout.split('\n').filter(Boolean) : [],
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
