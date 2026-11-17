/**
 * Managed-workspace store.
 *
 * The panel persists which workspaces the user brought under management in one
 * JSON file under the dsh home, plus the repository cards the user hid from the
 * panel. It stores ids and canonical paths only: the workspace list itself is
 * always re-read from dsh, so a renamed or moved workspace is detected instead
 * of silently pointing at a stale directory.
 *
 * Schema v2 adds `hiddenRepos`: card identities (repository *scope* paths) the
 * user removed from the panel. Hiding is a display preference — it never
 * touches a repository — and stays reversible from the workspace picker. A v1
 * file reads as `hiddenRepos: []`; an older build reading v2 simply ignores the
 * field, so a downgrade only brings the hidden cards back.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = 2;
const FILE_NAME = 'managed.json';

/** The dsh home directory: the profile dir on desktop, `~/.dsh` otherwise. */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim().replace(/[\\/]+$/, '');
  return join(homedir(), '.dsh');
}

export function storeDir() {
  return join(dshHome(), 'workaround-git');
}

export function storePath() {
  return join(storeDir(), FILE_NAME);
}

/**
 * Identity key for a workspace path: resolved, and case-folded on Windows where
 * `I:\dev\work\support` and `i:\dev\work\support` are the same directory.
 */
export function pathKey(path) {
  const resolved = resolve(String(path ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (path === '') return null;
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    path,
    title: typeof entry.title === 'string' ? entry.title : '',
    addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null,
  };
}

function normalizeHiddenRepos(list) {
  const seen = new Set();
  const hidden = [];
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string') continue;
    const path = value.trim();
    if (path === '') continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    hidden.push(path);
  }
  return hidden;
}

/** Read the managed list. A missing or corrupt file reads as empty, never throws. */
export async function readManaged() {
  try {
    const raw = JSON.parse(await readFile(storePath(), 'utf8'));
    const list = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
    return {
      version: SCHEMA_VERSION,
      workspaces: list.map(normalizeEntry).filter(Boolean),
      hiddenRepos: normalizeHiddenRepos(raw?.hiddenRepos),
    };
  } catch {
    return { version: SCHEMA_VERSION, workspaces: [], hiddenRepos: [] };
  }
}

/**
 * Replace the managed list atomically.
 * @param {Array<{id?: string, path: string, title?: string, addedAt?: string}>} workspaces
 * @param {{hiddenRepos?: string[]}} [options]
 */
export async function writeManaged(workspaces, { hiddenRepos = [] } = {}) {
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const entries = (Array.isArray(workspaces) ? workspaces : [])
    .map((entry) => normalizeEntry({ ...entry, addedAt: entry?.addedAt ?? new Date().toISOString() }))
    .filter(Boolean);
  const body = {
    version: SCHEMA_VERSION,
    workspaces: entries,
    hiddenRepos: normalizeHiddenRepos(hiddenRepos),
  };
  const tmp = join(dir, `.managed.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(body, null, 1)}\n`, 'utf8');
  await rename(tmp, storePath());
  return body;
}

export const PERF_FILE = 'perf-report.json';

/** Which build produced a saved report; read once, `null` when it cannot be read. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();


/**
 * Save one panel measurement next to `managed.json`.
 *
 * The panel's 性能 button posts its span table here when a run ends, so the
 * numbers outlive the page and reach whoever is reading them (see
 * `docs/perf-baseline.md`). Diagnostics only: nothing reads this file at
 * runtime, and it never touches a repository.
 */
export async function writePerfReport(report) {
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, PERF_FILE);
  const body = {
    ...(report && typeof report === 'object' && !Array.isArray(report) ? report : {}),
    pluginVersion: PLUGIN_VERSION,
    savedAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(body, null, 1)}\n`;
  const tmp = join(dir, `.perf.${process.pid}.tmp`);
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
  return { path: file, bytes: Buffer.byteLength(text), savedAt: body.savedAt };
}

/**
 * Merge one workspace-picker submission into the managed list.
 *
 * Entries that are already managed are kept as they are: their identity and
 * `addedAt` must survive a save, and a workspace dsh no longer lists may only
 * be removed by omitting it — re-validating it would drop it silently. Entries
 * that are new still have to exist on this machine and contain a git repository.
 *
 * @param {{managed?: Array<{id?: string, path: string}>, discovered?: Array<{id?: string, path: string, exists?: boolean, git?: string}>, requested?: Array<{id?: string, path?: string}>, now?: string}} input
 * @returns {{workspaces: Array<object>, rejected: Array<{id: string|null, path: string|null, reason: string}>}}
 */
export function mergeManagedSelection({ managed = [], discovered = [], requested = [], now = new Date().toISOString() } = {}) {
  const priorByPath = new Map();
  const priorById = new Map();
  for (const entry of Array.isArray(managed) ? managed : []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.trim() === '') continue;
    priorByPath.set(pathKey(entry.path), entry);
    if (typeof entry.id === 'string' && entry.id !== '') priorById.set(entry.id, entry);
  }
  const foundByPath = new Map();
  const foundById = new Map();
  for (const workspace of Array.isArray(discovered) ? discovered : []) {
    if (!workspace || typeof workspace.path !== 'string' || workspace.path.trim() === '') continue;
    foundByPath.set(pathKey(workspace.path), workspace);
    if (typeof workspace.id === 'string' && workspace.id !== '') foundById.set(workspace.id, workspace);
  }

  const workspaces = [];
  const rejected = [];
  const seen = new Set();
  for (const entry of Array.isArray(requested) ? requested : []) {
    const path = typeof entry?.path === 'string' ? entry.path.trim() : '';
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (path === '') {
      rejected.push({ id: id || null, path: null, reason: 'workspace path is required' });
      continue;
    }
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = priorByPath.get(key) ?? (id !== '' ? priorById.get(id) : undefined);
    if (prior) {
      const found = foundByPath.get(key);
      workspaces.push(found && typeof found.title === 'string' && found.title !== ''
        ? { ...prior, title: found.title }
        : prior);
      continue;
    }
    const found = foundByPath.get(key) ?? (id !== '' ? foundById.get(id) : undefined);
    if (!found || found.exists !== true) {
      rejected.push({ id: id || null, path, reason: 'workspace not found on this machine' });
      continue;
    }
    if (found.git === 'none') {
      rejected.push({ id: typeof found.id === 'string' ? found.id : null, path: found.path, reason: 'workspace contains no git repository' });
      continue;
    }
    workspaces.push({
      id: typeof found.id === 'string' ? found.id : '',
      path: found.path,
      title: typeof found.title === 'string' ? found.title : '',
      addedAt: now,
    });
  }
  return { workspaces, rejected };
}
