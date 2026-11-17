/**
 * Managed store v2 and card-level hiding.
 *
 * The store persists workspace identity and `hiddenRepos`; the merge keeps a
 * saved entry that dsh no longer lists (so the picker can still remove it) while
 * still validating entries the user adds. `filterHiddenRepos` is the read-side
 * half: hidden cards are dropped from `/api/state` by their scope path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeManagedSelection, readManaged, storePath, writeManaged } from '../lib/store.mjs';
import { filterHiddenRepos } from '../lib/state.mjs';

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'wg-managed-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('a v1 managed file reads as hiddenRepos: []', async (t) => {
  const home = await tempHome(t);
  await mkdir(join(home, 'workaround-git'), { recursive: true });
  await writeFile(storePath(), JSON.stringify({
    version: 1,
    workspaces: [{ id: 'old', path: 'C:\\old', title: 'old', addedAt: '2026-01-01T00:00:00.000Z' }],
  }), 'utf8');
  const managed = await readManaged();
  assert.deepEqual(managed.hiddenRepos, []);
  assert.equal(managed.workspaces.length, 1);
  assert.equal(managed.workspaces[0].id, 'old');
});

test('writeManaged round-trips addedAt and hiddenRepos', async (t) => {
  await tempHome(t);
  await writeManaged([
    { id: 'a', path: 'C:\\work\\a', title: 'a', addedAt: '2026-01-02T03:04:05.000Z' },
  ], { hiddenRepos: ['C:\\work\\a\\repo', 'C:\\work\\a\\repo', '  '] });
  const raw = JSON.parse(await readFile(storePath(), 'utf8'));
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.hiddenRepos, ['C:\\work\\a\\repo']);
  const managed = await readManaged();
  assert.equal(managed.workspaces[0].addedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(managed.hiddenRepos, ['C:\\work\\a\\repo']);
});

test('mergeManagedSelection keeps prior entries and validates only new ones', () => {
  const managed = [
    { id: 'keep', path: 'C:\\ws\\keep', title: 'keep', addedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const discovered = [
    { id: 'keep', path: 'C:\\ws\\keep', title: 'keep renamed', exists: true, git: 'contains' },
    { id: 'new', path: 'C:\\ws\\new', title: 'new', exists: true, git: 'git' },
    { id: 'empty', path: 'C:\\ws\\empty', title: 'empty', exists: true, git: 'none' },
    { id: 'gone', path: 'C:\\ws\\gone', title: 'gone', exists: false, git: 'none' },
  ];
  const merged = mergeManagedSelection({
    managed,
    discovered,
    requested: [
      { id: 'keep', path: 'C:\\ws\\keep' },
      { id: 'new', path: 'C:\\ws\\new' },
      { id: 'empty', path: 'C:\\ws\\empty' },
      { id: 'gone', path: 'C:\\ws\\gone' },
      { id: null, path: 'C:\\ws\\missing' },
    ],
    now: '2026-02-02T00:00:00.000Z',
  });
  assert.deepEqual(merged.workspaces.map((entry) => entry.id), ['keep', 'new']);
  assert.equal(merged.workspaces[0].addedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(merged.workspaces[0].title, 'keep renamed');
  assert.equal(merged.workspaces[1].addedAt, '2026-02-02T00:00:00.000Z');
  assert.deepEqual(merged.rejected.map((entry) => entry.id), ['empty', 'gone', null]);
  assert.deepEqual(merged.rejected.map((entry) => entry.reason), [
    'workspace contains no git repository',
    'workspace not found on this machine',
    'workspace not found on this machine',
  ]);
});

test('a managed workspace dsh no longer lists survives until it is omitted', () => {
  const managed = [{ id: 'ghost', path: 'C:\\ws\\ghost', title: 'ghost', addedAt: '2026-01-01T00:00:00.000Z' }];
  const kept = mergeManagedSelection({
    managed,
    discovered: [],
    requested: [{ id: 'ghost', path: 'C:\\ws\\ghost' }],
  });
  assert.equal(kept.workspaces.length, 1);
  assert.equal(kept.workspaces[0].id, 'ghost');
  assert.equal(kept.rejected.length, 0);
  const dropped = mergeManagedSelection({ managed, discovered: [], requested: [] });
  assert.deepEqual(dropped.workspaces, []);
});

test('an empty selection is valid and blank paths are rejected', () => {
  const merged = mergeManagedSelection({ requested: [{ path: '' }, { path: '  ' }] });
  assert.deepEqual(merged.workspaces, []);
  assert.equal(merged.rejected.length, 2);
  const cleared = mergeManagedSelection({ managed: [{ id: 'x', path: 'C:\\x', title: 'x' }], requested: [] });
  assert.deepEqual(cleared.workspaces, []);
});

test('filterHiddenRepos drops only the hidden scope path', () => {
  const rows = [
    { path: 'C:\\repo\\whole' },
    { path: 'C:\\repo\\module' },
    { path: 'C:\\other' },
  ];
  assert.deepEqual(
    filterHiddenRepos(rows, ['C:\\repo\\module']).map((row) => row.path),
    ['C:\\repo\\whole', 'C:\\other'],
  );
  assert.equal(filterHiddenRepos(rows, []).length, 3);
  assert.equal(filterHiddenRepos(rows, ['C:\\repo']).length, 3);
});
