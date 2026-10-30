/**
 * Repository ownership across managed workspaces.
 *
 * A repo can be reachable twice: once as a managed workspace root and once
 * nested inside another managed workspace (the `~/.dsh` layout: the home dir is
 * itself a repo that holds the project repos). Each physical repo must render
 * exactly once, owned by its own root when it has one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedWorkspacesState, ownedRepos, repoOwner } from '../lib/state.mjs';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

async function makeRepo(root, name) {
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, name), 'one\n', 'utf8');
  sh(root, 'add', name);
  sh(root, 'commit', '-q', '-m', 'chore: initial');
  return root;
}

test('repoOwner prefers the repo that is its own workspace root', () => {
  const root = join(tmpdir(), 'wg-owner');
  const proj = join(root, 'proj');
  const sub = join(proj, 'sub');
  const repo = join(sub, 'repo');
  const workspaces = [{ path: root }, { path: proj }, { path: sub }];

  assert.equal(repoOwner(proj, workspaces), workspaces[1], 'own root wins over the parent');
  assert.equal(repoOwner(repo, workspaces), workspaces[2], 'closest ancestor wins');
  assert.equal(repoOwner(join(tmpdir(), 'elsewhere', 'repo'), workspaces), undefined);
});

test('ownedRepos drops rows another managed workspace owns', () => {
  const root = join(tmpdir(), 'wg-owner');
  const proj = join(root, 'proj');
  const workspaces = [{ path: root }, { path: proj }];
  const repos = [{ path: root }, { path: proj }];

  assert.deepEqual(ownedRepos(workspaces[0], repos, workspaces), [{ path: root }]);
  assert.deepEqual(ownedRepos(workspaces[1], repos, workspaces), [{ path: proj }]);
});

test('managedWorkspacesState reports one row per physical repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wg-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeRepo(root, 'root.txt');
  const nested = join(root, 'nested');
  await mkdir(nested, { recursive: true });
  await makeRepo(nested, 'nested.txt');

  // Parent workspace is itself a repo; the nested repo is also managed on its own.
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
