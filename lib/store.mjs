/**
 * Managed-workspace store.
 *
 * The panel persists which workspaces the user brought under management in one
 * JSON file under the dsh home. It stores ids and canonical paths only: the
 * workspace list itself is always re-read from dsh, so a renamed or moved
 * workspace is detected instead of silently pointing at a stale directory.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = 1;
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

/** Read the managed list. A missing or corrupt file reads as empty, never throws. */
export async function readManaged() {
  try {
    const raw = JSON.parse(await readFile(storePath(), 'utf8'));
    const list = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
    return {
      version: SCHEMA_VERSION,
      workspaces: list.map(normalizeEntry).filter(Boolean),
    };
  } catch {
    return { version: SCHEMA_VERSION, workspaces: [] };
  }
}

/**
 * Replace the managed list atomically.
 * @param {Array<{id?: string, path: string, title?: string}>} workspaces
 */
export async function writeManaged(workspaces) {
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const entries = (Array.isArray(workspaces) ? workspaces : [])
    .map((entry) => normalizeEntry({ ...entry, addedAt: entry?.addedAt ?? new Date().toISOString() }))
    .filter(Boolean);
  const body = { version: SCHEMA_VERSION, workspaces: entries };
  const tmp = join(dir, `.managed.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(body, null, 1)}\n`, 'utf8');
  await rename(tmp, storePath());
  return body;
}
