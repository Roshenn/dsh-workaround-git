/**
 * Repository scoping across managed workspaces.
 *
 * A card is identified by (repository, scope). Two different scopes of the same
 * repository legitimately coexist — the whole repo and one module inside it —
 * while the same pair reached twice (a nested repository discovered under a
 * managed parent as well as managed on its own) must collapse to one card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedWorkspacesState, repoScopeKey } from '../lib/state.mjs';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

async function makeRepo(root, name) {
  await mkdir(root, { recursive: true });
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, name), 'one\n', 'utf8');
  sh(root, 'add', name);
  sh(root, 'commit', '-q', '-m', 'chore: initial');
  return root;
}

test('repoScopeKey distinguishes scopes and ignores path aliases', () => {
  const root = join(tmpdir(), 'wg-key');
  const modulePath = join(root, 'module');
  assert.equal(repoScopeKey(root, root), repoScopeKey(root, root));
  assert.notEqual(repoScopeKey(root, root), repoScopeKey(root, modulePath));
  assert.notEqual(repoScopeKey(root, modulePath), repoScopeKey(modulePath, modulePath));
});

test('managedWorkspacesState keeps parent and module scopes of one repo side by side', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wg-scope-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRepo(root, 'root.txt');
  const modulePath = join(root, 'module');
  await mkdir(modulePath, { recursive: true });

  const workspaces = [
    { id: 'root', title: 'root', path: root },
    { id: 'module', title: 'module', path: modulePath },
  ];
  const states = await managedWorkspacesState(workspaces);
  const rows = states.flatMap((state) => state.repos);

  assert.equal(rows.length, 2, 'whole repo and module are two different cards');
  assert.deepEqual(new Set(rows.map((row) => row.path)), new Set([root, modulePath]));
  assert.deepEqual(new Set(rows.map((row) => row.repoRoot)), new Set([realpathSync(root)]));
});

test('managedWorkspacesState reports one row per card when a nested repo is also managed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wg-nested-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRepo(root, 'root.txt');
  const nested = join(root, 'nested');
  await makeRepo(nested, 'nested.txt');

  // The parent workspace discovers the nested repo below it, and the nested
  // repo is also managed on its own: that pair must render once.
  const workspaces = [
    { id: 'parent', title: 'parent', path: root },
    { id: 'nested', title: 'nested', path: nested },
  ];
  const states = await managedWorkspacesState(workspaces);
  const paths = states.flatMap((state) => state.repos.map((repo) => repo.path));

  assert.equal(states[0].repos.length, 1, 'parent keeps only its own repo row');
  assert.equal(states[1].repos.length, 1, 'nested repo is rendered by its own workspace');
  assert.equal(new Set(paths).size, paths.length, 'no repository appears twice');
  assert.deepEqual(new Set(paths), new Set([root, nested]));
});
