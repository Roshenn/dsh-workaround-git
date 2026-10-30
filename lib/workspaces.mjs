/**
 * Workspace discovery for the panel.
 *
 * Source of truth is dsh's own workspace registry (`ctx.workspaceRegistry`);
 * older builds that expose no service fall back to the registry's storage file.
 * Each workspace is then classified into one of three git states:
 *
 *   git       the workspace path itself is a repository
 *   contains  the path is not a repo, but repositories live below it
 *   none      no repository at or under the path
 *
 * The classification is cached briefly because probing every workspace walks
 * directories, and the panel asks for the list on every open.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRepos, isRepo, repoLabel } from './git.mjs';
import { dshHome } from './store.mjs';

const PROBE_DEPTH = 2;
const PROBE_MAX_REPOS = 50;
const CACHE_TTL_MS = 60_000;

let cache = { at: 0, value: null };

/** Workspaces as dsh knows them, before any git probing. */
export async function rawWorkspaces(ctx) {
  const fromRegistry = await viaRegistry(ctx);
  if (fromRegistry !== undefined) return fromRegistry;
  return viaStorageFile();
}

async function viaRegistry(ctx) {
  let registry;
  try {
    registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
  } catch {
    return undefined;
  }
  if (!registry || typeof registry.list !== 'function') return undefined;
  try {
    const items = await registry.list();
    if (!Array.isArray(items)) return undefined;
    return items
      .map((item) => ({
        id: typeof item?.id === 'string' ? item.id : '',
        title: typeof item?.title === 'string' ? item.title : '',
        path: typeof item?.path === 'string' ? item.path : '',
      }))
      .filter((item) => item.path !== '');
  } catch {
    return undefined;
  }
}

async function viaStorageFile() {
  const file = join(dshHome(), 'storages', 'workspace.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const table = raw?.tables?.workspaces;
    if (!table || typeof table !== 'object') return [];
    return Object.entries(table)
      .map(([id, rec]) => ({
        id,
        title: typeof rec?.title === 'string' ? rec.title : '',
        path: typeof rec?.path === 'string' ? rec.path : '',
      }))
      .filter((item) => item.path !== '');
  } catch {
    return [];
  }
}

/** Classify one workspace and list its repositories. */
export async function describeWorkspace(workspace) {
  const path = workspace.path;
  if (!existsSync(path)) {
    return { ...workspace, exists: false, git: 'none', repoCount: 0, repos: [] };
  }
  const self = await isRepo(path);
  let repoPaths;
  try {
    repoPaths = await discoverRepos(path, { maxDepth: PROBE_DEPTH, maxRepos: PROBE_MAX_REPOS });
  } catch {
    repoPaths = [];
  }
  const repos = repoPaths.map((repoPath) => ({ label: repoLabel(repoPath, path), path: repoPath }));
  const git = self ? 'git' : repos.length > 0 ? 'contains' : 'none';
  return {
    ...workspace,
    exists: true,
    git,
    repoCount: repos.length,
    repos,
  };
}

/** All workspaces, probed. Cached for a minute; pass `refresh` to bypass. */
export async function listWorkspaces(ctx, { refresh = false } = {}) {
  if (!refresh && cache.value !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const raw = await rawWorkspaces(ctx);
  const value = await Promise.all(raw.map((workspace) => describeWorkspace(workspace)));
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateWorkspaces() {
  cache = { at: 0, value: null };
}
