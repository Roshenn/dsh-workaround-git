/**
 * File-level primitives used by the panel: grouping staged vs worktree changes,
 * per-file staging, ignore rules, discard, diff, history and branches.
 *
 * Each test builds a throwaway repository so the assertions exercise real git
 * output (porcelain v2 -z, pathspec stdin) rather than fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addIgnoreRule,
  discardPaths,
  listBranches,
  parsePorcelainV2Detailed,
  repoChangeList,
  repoDiff,
  repoHistory,
  repoRemote,
  stagePaths,
  switchBranch,
  unstagePaths,
} from '../lib/git.mjs';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

async function makeRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'wg-panel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
  sh(root, 'add', 'a.txt');
  sh(root, 'commit', '-q', '-m', 'chore: initial');
  return root;
}

test('porcelain v2 -z parses index and worktree sides separately', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(repo, 'add', 'a.txt');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(join(repo, 'new.txt'), 'n\n', 'utf8');

  const entries = parsePorcelainV2Detailed(sh(repo, 'status', '--porcelain=v2', '-z'));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  assert.equal(byPath.get('a.txt').index, 'M', 'staged side');
  assert.equal(byPath.get('a.txt').worktree, 'M', 'worktree side');
  assert.equal(byPath.get('new.txt').untracked, true);
  assert.equal(byPath.get('new.txt').path, 'new.txt');
});

test('repoChangeList splits staged, changes and untracked', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(repo, 'add', 'a.txt');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(join(repo, 'new.txt'), 'n\n', 'utf8');

  const changes = await repoChangeList(repo);
  assert.equal(changes.ok, true);
  assert.ok(changes.staged.some((file) => file.path === 'a.txt'));
  assert.ok(changes.changes.some((file) => file.path === 'a.txt'));
  assert.ok(changes.changes.some((file) => file.path === 'new.txt' && file.untracked));
  assert.deepEqual(changes.conflicts, []);
});

test('stagePaths and unstagePaths move one file between the two sections', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8');

  await stagePaths(repo, ['b.txt']);
  let changes = await repoChangeList(repo);
  assert.ok(changes.staged.some((file) => file.path === 'b.txt'));
  assert.ok(!changes.changes.some((file) => file.path === 'b.txt'));

  await unstagePaths(repo, ['b.txt']);
  changes = await repoChangeList(repo);
  assert.ok(!changes.staged.some((file) => file.path === 'b.txt'));
  assert.ok(changes.changes.some((file) => file.path === 'b.txt'));
});

test('addIgnoreRule appends once and covers file, extension and directory modes', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'tmp.log'), 'x\n', 'utf8');

  const first = await addIgnoreRule(repo, 'tmp.log', 'file');
  const second = await addIgnoreRule(repo, 'tmp.log', 'file');
  assert.equal(first.ok, true);
  assert.equal(first.added, true);
  assert.equal(second.added, false, 'duplicate rule must not be appended twice');

  await addIgnoreRule(repo, 'tmp.log', 'ext');
  await addIgnoreRule(repo, 'tmp.log', 'dir');
  const content = await readFile(join(repo, '.gitignore'), 'utf8');
  const lines = content.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['/tmp.log', '*.log', '/tmp.log/']);
});

test('discardPaths restores tracked files, deletes untracked files and refuses escapes', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\nchanged\n', 'utf8');
  await writeFile(join(repo, 'junk.txt'), 'junk\n', 'utf8');

  const result = await discardPaths(repo, ['a.txt', 'junk.txt']);
  assert.equal(result.ok, true, JSON.stringify(result.results));
  const restored = (await readFile(join(repo, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(restored, 'one\n');
  assert.equal(existsSync(join(repo, 'junk.txt')), false);

  const refused = await discardPaths(repo, ['../outside.txt']);
  assert.equal(refused.ok, false);
  assert.equal(refused.results[0].action, 'refused');
});

test('repoDiff returns a patch for tracked files and a synthetic new-file patch', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  const tracked = await repoDiff(repo, 'a.txt');
  assert.equal(tracked.ok, true);
  assert.match(tracked.text, /\+two/);

  await writeFile(join(repo, 'fresh.txt'), 'hello\n', 'utf8');
  const untracked = await repoDiff(repo, 'fresh.txt');
  assert.equal(untracked.untracked, true);
  assert.match(untracked.text, /new file/);
  assert.match(untracked.text, /\+hello/);
});

test('repoHistory lists commits that touched the file', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(repo, 'add', 'a.txt');
  sh(repo, 'commit', '-q', '-m', 'feat: touch a.txt');

  const history = await repoHistory(repo, 'a.txt');
  assert.equal(history.ok, true);
  assert.equal(history.commits.length, 2);
  assert.equal(history.commits[0].subject, 'feat: touch a.txt');
});

test('listBranches and switchBranch work and reject unknown branches', async (t) => {
  const repo = await makeRepo(t);
  sh(repo, 'branch', 'feature');

  const listed = await listBranches(repo);
  assert.equal(listed.ok, true);
  const feature = listed.branches.find((branch) => branch.name === 'feature');
  assert.ok(feature, 'feature branch listed');
  assert.ok(listed.branches.some((branch) => branch.current));

  const switched = await switchBranch(repo, 'feature');
  assert.equal(switched.ok, true, switched.error);
  const after = await listBranches(repo);
  assert.equal(after.branches.find((branch) => branch.current)?.name, 'feature');

  const missing = await switchBranch(repo, 'nope');
  assert.equal(missing.ok, false);
});

test('repoRemote returns the origin URL and falls back to the first remote', async (t) => {
  const repo = await makeRepo(t);
  assert.deepEqual(await repoRemote(repo), { name: null, url: null });

  sh(repo, 'remote', 'add', 'upstream', 'https://example.com/upstream.git');
  assert.deepEqual(await repoRemote(repo), { name: 'upstream', url: 'https://example.com/upstream.git' });

  sh(repo, 'remote', 'add', 'origin', 'https://example.com/demo.git');
  assert.deepEqual(await repoRemote(repo), { name: 'origin', url: 'https://example.com/demo.git' });
});
