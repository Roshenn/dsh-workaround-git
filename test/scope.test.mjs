/**
 * Scoped git workspaces: a subdirectory of a repository is a valid workspace.
 *
 * Every git primitive runs with the scope directory as its working directory and
 * must report only that scope's files, in scope-relative paths — while a commit
 * from a module scope must never sweep the rest of the repository into it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitRepo,
  discoverRepos,
  repoChangeList,
  repoRootAt,
  repoStatus,
} from '../lib/git.mjs';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function makeRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'wg-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'root.txt'), 'root\n', 'utf8');
  sh(root, 'add', 'root.txt');
  sh(root, 'commit', '-q', '-m', 'chore: initial');
  const moduleDir = join(root, 'module');
  await mkdir(moduleDir, { recursive: true });
  await writeFile(join(moduleDir, 'a.txt'), 'one\n', 'utf8');
  sh(root, 'add', 'module/a.txt');
  sh(root, 'commit', '-q', '-m', 'feat: add module');
  return { root, moduleDir };
}

test('repoRootAt finds the containing work tree and ignores non-repositories', async (t) => {
  const { root, moduleDir } = await makeRepo(t);
  const canonicalRoot = realpathSync(root);
  assert.equal(await repoRootAt(moduleDir), canonicalRoot);
  assert.equal(await repoRootAt(root), canonicalRoot);
  assert.equal(await repoRootAt(join(tmpdir(), 'wg-not-a-repo')), null);
});

test('discoverRepos treats a subdirectory of a repository as a scoped workspace', async (t) => {
  const { root, moduleDir } = await makeRepo(t);
  assert.deepEqual(await discoverRepos(moduleDir), [moduleDir]);
  assert.deepEqual(await discoverRepos(root), [root]);

  const container = await mkdtemp(join(tmpdir(), 'wg-container-'));
  t.after(() => rm(container, { recursive: true, force: true }));
  sh(container, 'init', '-q');
  sh(container, 'config', 'user.email', 'test@example.com');
  sh(container, 'config', 'user.name', 'Test');
  assert.deepEqual(await discoverRepos(container), [container]);
});

test('status and change list stay inside the module scope with scope-relative paths', async (t) => {
  const { root, moduleDir } = await makeRepo(t);
  await writeFile(join(root, 'root.txt'), 'root changed\n', 'utf8');
  await writeFile(join(moduleDir, 'a.txt'), 'one\ntwo\n', 'utf8');
  await writeFile(join(moduleDir, 'new.txt'), 'new\n', 'utf8');

  const status = await repoStatus(moduleDir, { root: moduleDir });
  assert.equal(status.ok, true);
  assert.equal(status.modified, 1, 'only the module file counts');
  assert.equal(status.untracked, 1, 'only the module untracked file counts');

  const changes = await repoChangeList(moduleDir);
  assert.equal(changes.ok, true);
  const paths = [...changes.changes.map((file) => file.path), ...changes.staged.map((file) => file.path)];
  assert.deepEqual(new Set(paths), new Set(['a.txt', 'new.txt']), 'paths are relative to the module');
});

test('commitRepo refuses when something outside the module is staged', async (t) => {
  const { root, moduleDir } = await makeRepo(t);
  await writeFile(join(root, 'root.txt'), 'root changed\n', 'utf8');
  await writeFile(join(moduleDir, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(root, 'add', 'root.txt', 'module/a.txt');

  const result = await commitRepo(moduleDir, 'feat: module change', { root: moduleDir, addAll: false });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'scope-conflict');
  assert.match(result.error, /outside module: root\.txt/);
  assert.equal(sh(root, 'rev-list', '--count', 'HEAD'), '2', 'nothing was committed');
});

test('commitRepo commits only the module and leaves the rest unstaged', async (t) => {
  const { root, moduleDir } = await makeRepo(t);
  await writeFile(join(root, 'root.txt'), 'root changed\n', 'utf8');
  await writeFile(join(moduleDir, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(root, 'add', 'module/a.txt');

  const result = await commitRepo(moduleDir, 'feat: module change', { root: moduleDir, addAll: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.action, 'committed');

  const committed = sh(root, 'show', '--name-only', '--pretty=format:');
  assert.deepEqual(committed.split('\n').filter(Boolean), ['module/a.txt']);
  assert.match(sh(root, 'status', '--porcelain'), /M root\.txt/);
});
