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
  fetchRepo,
  listBranches,
  openTerminal,
  openerArgv,
  parsePorcelainV2Detailed,
  parsePorcelainV2Z,
  repoChangeList,
  repoDiff,
  repoHistory,
  repoRemote,
  repoRootAt,
  repoSnapshot,
  repoStatus,
  stagePaths,
  switchBranch,
  terminalCandidates,
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
  assert.deepEqual(await repoRemote(repo, { fresh: true }), { name: null, url: null });

  sh(repo, 'remote', 'add', 'upstream', 'https://example.com/upstream.git');
  assert.deepEqual(await repoRemote(repo, { fresh: true }), { name: 'upstream', url: 'https://example.com/upstream.git' });

  sh(repo, 'remote', 'add', 'origin', 'https://example.com/demo.git');
  assert.deepEqual(await repoRemote(repo, { fresh: true }), { name: 'origin', url: 'https://example.com/demo.git' });

  // Cached for a minute so the panel's entry payload does not respawn git for
  // an unchanged URL; the cached call still answers with the value read above.
  assert.deepEqual(await repoRemote(repo), { name: 'origin', url: 'https://example.com/demo.git' });
});

test('fetchRepo updates remote-tracking refs and reports unreachable remotes', async (t) => {
  const repo = await makeRepo(t);
  const bare = await mkdtemp(join(tmpdir(), 'wg-bare-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  sh(bare, 'init', '--bare', '-q');
  sh(repo, 'remote', 'add', 'origin', bare);
  sh(repo, 'push', '-q', '-u', 'origin', 'HEAD');

  const fetched = await fetchRepo(repo);
  assert.equal(fetched.ok, true, fetched.error);

  sh(repo, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/unreachable.git');
  const failed = await fetchRepo(repo, { timeout: 5000 });
  assert.equal(failed.ok, false);
});

test('openerArgv picks a visible Windows opener for files and folders', () => {
  assert.deepEqual(
    openerArgv('win32', 'C:\\tmp\\a.txt', 'reveal'),
    { command: 'explorer.exe', args: ['/select,C:\\tmp\\a.txt'] },
  );
  assert.deepEqual(
    openerArgv('win32', 'C:\\tmp\\a.txt', 'file'),
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'C:\\tmp\\a.txt'] },
  );
  assert.deepEqual(openerArgv('darwin', '/tmp/a', 'reveal'), { command: 'open', args: ['-R', '/tmp/a'] });
  assert.deepEqual(openerArgv('linux', '/tmp/a', 'file'), { command: 'xdg-open', args: ['/tmp/a'] });
});

test('terminalCandidates open a shell at the repository directory', async () => {
  const windows = terminalCandidates('win32', 'C:\\tmp\\repo');
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { command: 'wt.exe', args: ['-d', 'C:\\tmp\\repo'], cwd: 'C:\\tmp\\repo' });
  assert.equal(windows[1].command, 'powershell.exe');
  assert.equal(windows[1].cwd, 'C:\\tmp\\repo');
  assert.equal(windows[1].windowsHide, true);
  assert.deepEqual(windows[1].env, { WG_REPO: 'C:\\tmp\\repo' });
  assert.ok(windows[1].args.some((arg) => arg.includes('Start-Process')));
  assert.ok(windows[1].args.join(' ').includes('$env:WG_REPO'));

  assert.deepEqual(
    terminalCandidates('darwin', '/tmp/repo'),
    [{ command: 'open', args: ['-a', 'Terminal', '/tmp/repo'], cwd: '/tmp/repo' }],
  );
  assert.deepEqual(
    terminalCandidates('linux', '/tmp/repo'),
    [{ command: 'x-terminal-emulator', args: ['--working-directory', '/tmp/repo'], cwd: '/tmp/repo' }],
  );

  const missing = await openTerminal('C:\\definitely\\missing\\repo-path');
  assert.equal(missing.ok, false);
});

test('parsePorcelainV2Z reads the branch header and the file records from one -z output', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(repo, 'add', 'a.txt');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(join(repo, 'new.txt'), 'n\n', 'utf8');

  const raw = execFileSync('git', ['-C', repo, 'status', '--porcelain=v2', '--branch', '-z'], { encoding: 'utf8' });
  const { summary, entries } = parsePorcelainV2Z(raw);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  assert.equal(typeof summary.branch, 'string');
  assert.equal(summary.staged, 1);
  assert.equal(summary.modified, 1);
  assert.equal(summary.untracked, 1);
  assert.equal(byPath.get('a.txt').index, 'M');
  assert.equal(byPath.get('a.txt').worktree, 'M');
  assert.equal(byPath.get('new.txt').untracked, true);
});

test('repoSnapshot equals repoStatus + repoChangeList + repoRemote + repoRootAt', async (t) => {
  const repo = await makeRepo(t);
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  sh(repo, 'add', 'a.txt');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(join(repo, 'new.txt'), 'n\n', 'utf8');
  sh(repo, 'remote', 'add', 'origin', 'https://example.com/demo.git');

  const snapshot = await repoSnapshot(repo, { root: repo });
  const status = await repoStatus(repo, { root: repo });
  const changes = await repoChangeList(repo);
  const rootAt = await repoRootAt(repo);
  const remote = await repoRemote(repo);

  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.repo, status.repo);
  assert.equal(snapshot.path, status.path);
  assert.equal(snapshot.repoRoot, rootAt);
  assert.equal(snapshot.branch, status.branch);
  assert.equal(snapshot.ahead, status.ahead);
  assert.equal(snapshot.behind, status.behind);
  assert.equal(snapshot.staged, status.staged);
  assert.equal(snapshot.modified, status.modified);
  assert.equal(snapshot.untracked, status.untracked);
  assert.equal(snapshot.conflicted, status.conflicted);
  assert.equal(snapshot.sequencer, null);
  assert.equal(snapshot.dirty, status.dirty);
  assert.deepEqual(snapshot.conflictPaths, status.conflictPaths);
  // `%cr` is a relative time ("2 seconds ago"), so compare the identity of the
  // commit, not the string that changes as the test runs.
  assert.equal(snapshot.lastCommit?.hash, status.lastCommit?.hash);
  assert.equal(snapshot.lastCommit?.subject, status.lastCommit?.subject);
  assert.deepEqual(snapshot.remote, remote);
  assert.deepEqual(snapshot.groups.staged.map((file) => file.path), changes.staged.map((file) => file.path));
  assert.deepEqual(
    snapshot.groups.changes.map((file) => file.path).sort(),
    changes.changes.map((file) => file.path).sort(),
  );
  assert.deepEqual(snapshot.groups.conflicts, changes.conflicts);
  assert.deepEqual(snapshot.totals, {
    staged: changes.staged.length,
    changes: changes.changes.length,
    conflicts: changes.conflicts.length,
  });
});

test('repoSnapshot reports a stopped merge and its conflicted files', async (t) => {
  const repo = await makeRepo(t);
  const branch = sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  sh(repo, 'switch', '-q', '-c', 'feature');
  await writeFile(join(repo, 'a.txt'), 'feature\n', 'utf8');
  sh(repo, 'commit', '-q', '-am', 'feat: feature');
  sh(repo, 'switch', '-q', branch);
  await writeFile(join(repo, 'a.txt'), 'main\n', 'utf8');
  sh(repo, 'commit', '-q', '-am', 'feat: main');
  try {
    execFileSync('git', ['-C', repo, 'merge', 'feature'], { stdio: 'pipe' });
  } catch {
    // the conflict is the point
  }

  const snapshot = await repoSnapshot(repo, { root: repo });
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.sequencer, 'merge');
  assert.equal(snapshot.conflicted, 1);
  assert.deepEqual(snapshot.conflictPaths, ['a.txt']);
  assert.equal(snapshot.groups.conflicts.length, 1);
  assert.equal(snapshot.groups.conflicts[0].status, 'U');
  assert.equal(snapshot.dirty, true);
  assert.equal(snapshot.totals.conflicts, 1);
});
